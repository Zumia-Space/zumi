// T-31 parity step 2 spare-PC probe: one `speech:say` fixture event reaches the RUNNING renderer.
// WRITTEN, NOT RUN on the main PC (the spare PC was offline when this was committed). Never launch it on
// the main PC: it needs a running preview exe, and every launch is a spare-PC job (ZUMI_ELECTRON_HOST=box).
//
// Start the preview the way run-guard-probe.ps1 does (same env), plus the fixture switch for the sidecar:
//   $env:ZUMI_ELECTRON_HOST = 'box'
//   $env:ZUMI_EVENT_FIXTURE = '1'
//   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9333'
//   <start ZumiPreview.exe>, wait for the window, then:
//   node tauri/verify/probe-events.mjs --cdp 9333 --out <dir>/events-probe.json
//
// The sidecar (ZUMI_EVENT_FIXTURE=1) emits a line on `speech:say` every second for 30 s. This driver
// subscribes through the shim (window.zumi.talk.onSay), waits for the first line, then checks:
//   * the callback got { sayId:'probe-N', kind:'probe', text:'event path probe', ... } (shape = preload.js:145);
//   * a second subscription also got it exactly once per emit (no double delivery);
//   * after unsubscribing the first, it stops receiving while the second continues;
//   * no guest webview was opened by the probe, and the page never saw a payload for an unknown channel.
// PASS requires every line above. Node >= 22 (global WebSocket and fetch), no dependencies.
import fs from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1]]] : a), []));
const port = Number(args.cdp || 9333);
const outFile = args.out || 'events-probe.json';

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === 'page' && /tauri\.localhost|index\.html/.test(t.url));
if (!page) { console.log('FAIL no main page target on the CDP port'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let nextId = 1;
const waiting = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); } };
const evaluate = (expression) => new Promise((res) => {
  const id = nextId++;
  waiting.set(id, res);
  ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
}).then((d) => (d.result && d.result.result ? d.result.result.value : undefined));

await evaluate(`(() => {
  window.__probe = { a: [], b: [] };
  window.__probe.offA = window.zumi.talk.onSay((l) => window.__probe.a.push(l));
  window.__probe.offB = window.zumi.talk.onSay((l) => window.__probe.b.push(l));
  return true;
})()`);
await new Promise((r) => setTimeout(r, 4500));
await evaluate('window.__probe.offA()');
const aAtUnsub = await evaluate('window.__probe.a.length');
await new Promise((r) => setTimeout(r, 3000));
const state = await evaluate('JSON.stringify({ a: window.__probe.a, b: window.__probe.b })');
const { a, b } = JSON.parse(state || '{"a":[],"b":[]}');

const shapeOk = a.length > 0 && a.every((l) => /^probe-\d+$/.test(l.sayId) && l.kind === 'probe' && l.text === 'event path probe');
const ids = (xs) => xs.map((l) => l.sayId);
const results = {
  shape: shapeOk,
  firstSubscriberGotLines: a.length >= 3,
  noDoubleDelivery: new Set(ids(b)).size === b.length && new Set(ids(a)).size === a.length,
  secondSubscriberMatchesFirstUntilUnsubscribe: JSON.stringify(ids(b).slice(0, aAtUnsub)) === JSON.stringify(ids(a).slice(0, aAtUnsub)),
  unsubscribeStopsFirst: a.length === aAtUnsub,
  secondContinues: b.length > aAtUnsub,
};
const pass = Object.values(results).every(Boolean);
fs.writeFileSync(outFile, JSON.stringify({ pass, results, counts: { a: a.length, b: b.length, aAtUnsub } }, null, 2));
for (const [k, v] of Object.entries(results)) console.log(`${v ? 'PASS' : 'FAIL'} ${k}`);
console.log(pass ? 'PASS events probe' : 'FAIL events probe');
ws.close();
process.exit(pass ? 0 : 1);
