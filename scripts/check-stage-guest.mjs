// Room live B (ADR D7): the negative sandbox tests that need the REAL guest webview: N1 N2 N3 N4 N7.
//   node scripts/check-stage-guest.mjs --app <dir with ZumiPreview.exe + payload> --work <scratch dir> --vrm <zumi-default-0910.vrm> [--only N1,N2] [--out <json>]
// It starts the built app off-screen (WebView2 remote debugging on, the owner flavour of the payload), opens the bundled room pack
// in its real guest webview through the main webview's guest_open command, and runs the probes inside that guest over CDP. A
// loopback canary server (the only thing listening) must see ZERO connections for every probe. N7 serves a hostile .vrm
// (scripts/build-hostile-vrm.mjs) as the user's avatar. Needs the HEAVY lock (GPU, WebView2). Nothing here touches app data
// outside --work.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { connect, sleep, waitTarget } from './lib/cdp-lite.mjs';
import { buildHostileVrm } from './build-hostile-vrm.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const app = opt('app'), work = opt('work'), vrmIn = opt('vrm'), outFile = opt('out');
const only = opt('only') ? new Set(opt('only').split(',')) : new Set(['N1', 'N2', 'N3', 'N4', 'N7']);
if (!app || !work || !vrmIn) { console.error('usage: check-stage-guest.mjs --app <dir> --work <dir> --vrm <default.vrm> [--only N1,N2,...] [--out <json>]'); process.exit(2); }
const CANARY_PORT = Number(opt('canary-port') || 47321);
const ID = 'plugin.room-preview';
const GUEST_URL = `http://zumipack.localhost/${ID}/ui/index.html`;
const BROWSER_ARGS = '--remote-debugging-port=0 --disable-features=msWebOOUI,msPdfOOUI,CalculateNativeWinOcclusion --disable-renderer-backgrounding --disable-background-timer-throttling --autoplay-policy=no-user-gesture-required';

fs.rmSync(work, { recursive: true, force: true });
const data = path.join(work, 'data');
fs.mkdirSync(data, { recursive: true });
const hostile = path.join(work, 'hostile.vrm');
fs.writeFileSync(hostile, buildHostileVrm(fs.readFileSync(vrmIn), CANARY_PORT));
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ userModelPath: hostile }));

// The canary: every connection, request and upgrade is a hit. Nothing may reach it.
const hits = [];
const canary = http.createServer((req, res) => { hits.push(`request ${req.method} ${req.url}`); res.end('canary'); });
canary.on('upgrade', (req, socket) => { hits.push(`upgrade ${req.url}`); socket.destroy(); });
canary.on('connection', () => hits.push('connection'));
await new Promise((res, rej) => { canary.once('error', rej); canary.listen(CANARY_PORT, '127.0.0.1', res); });
const CANARY = `http://127.0.0.1:${CANARY_PORT}`;

const helper = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(repo, 'packs', 'room-preview', 'offscreen.ps1'), '-Exe', path.resolve(app, 'ZumiPreview.exe'), '-Seconds', '900', '-Log', path.join(work, 'offscreen.log')], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
await new Promise((res, rej) => { helper.stdout.on('data', (d) => { if (String(d).includes('ready')) res(); }); helper.on('exit', () => rej(new Error('offscreen helper exited'))); });
const child = spawn(path.join(app, 'ZumiPreview.exe'), ['--data-dir', data], { cwd: app, stdio: 'ignore', env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: BROWSER_ARGS } });
console.log('app pid', child.pid, 'helper pid', helper.pid);
const stop = async () => {
  try { execFileSync('taskkill', ['/PID', String(child.pid), '/T'], { stdio: 'ignore' }); } catch { /* gone */ }
  for (let i = 0; i < 30 && child.exitCode === null; i++) await sleep(500);
  if (child.exitCode === null) { try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ } }
  try { execFileSync('taskkill', ['/PID', String(helper.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
  canary.close();
};

function findLog() {
  const walk = (d, depth) => {
    if (depth > 5) return null;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isFile() && e.name === 'pack-host.log') return p;
      if (e.isDirectory() && !/^(Cache|Code Cache|GPUCache|EBWebView)$/.test(e.name)) { const r = walk(p, depth + 1); if (r) return r; }
    }
    return null;
  };
  const f = walk(data, 0);
  return f ? fs.readFileSync(f, 'utf8') : '';
}

const results = {};
const record = (id, pass, detail) => { results[id] = { pass, ...detail }; console.log(`${pass ? 'PASS' : 'FAIL'} ${id} ${JSON.stringify(detail).slice(0, 600)}`); };
let guest;
try {
  const main = await connect((await waitTarget(data, /^http:\/\/tauri\.localhost\//, 120000)).target.webSocketDebuggerUrl);
  await sleep(3000);
  // The sidecar normalises settings.json at start-up and refuses an unknown model (it put the default back), so the hostile model is
  // written AFTER start-up; the host reads settings.json on every avatar request (pack_host::current_avatar).
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ userModelPath: hostile }));
  // The shell's own command opens the pack guest (the room tab would do the same), then shows it so the room renders.
  const opened = await main.evaluate(`window.__TAURI_INTERNALS__.invoke('guest_open', { src: ${JSON.stringify(GUEST_URL)}, partition: 'pack:${ID}' })`);
  await main.evaluate(`window.__TAURI_INTERNALS__.invoke('guest_bounds', { id: ${opened.id}, bounds: { x: 0, y: 0, width: 1204, height: 754 }, visible: true }).then(() => true)`);
  console.log('guest', JSON.stringify(opened));
  guest = await connect((await waitTarget(data, /^http:\/\/zumipack\.localhost\/plugin\.room-preview\/ui\/index\.html/, 60000)).target.webSocketDebuggerUrl);
  const boot = await guest.evaluate('(async () => { try { for (let i = 0; i < 1800 && !window.__room; i++) await new Promise((r) => setTimeout(r, 100)); const r = await window.__room.ready; return { ok: true, gpu: r.gpu }; } catch (e) { return { ok: false, error: String(e && e.message || e) }; } })()', { timeoutMs: 300000 });
  console.log('room boot', JSON.stringify(boot));
  await sleep(3000);
  const hitsAfterBoot = hits.length;

  // ---- N7: the hostile model was the user's avatar for the whole boot; the guest kept running; the canary saw nothing ----
  const alive = await guest.evaluate('(async () => { const R = window.__room; R.resetStats(); await new Promise((r) => setTimeout(r, 3000)); const s = R.stats(); return { fps: s.fps, vrmLoaded: !!(R.zumi && R.zumi.vrm), href: location.href }; })()', { timeoutMs: 60000 });
  // The model the guest is served must really be the hostile one (a test that never loads it proves nothing).
  const served = await guest.evaluate(`fetch('/${ID}/__zumi/avatar.vrm').then((r) => r.arrayBuffer()).then((b) => b.byteLength)`);
  alive.servedBytes = served; alive.hostileBytes = fs.statSync(hostile).size;
  record('N7', served === alive.hostileBytes && hitsAfterBoot === 0 && alive.fps > 10 && alive.href.startsWith(GUEST_URL.slice(0, GUEST_URL.lastIndexOf('/'))), { canaryHits: hits.slice(0, 5), hitsAfterBoot, boot, alive });

  // ---- N1: fetch to an external https origin, a loopback port, another pack's path, the app hosts ----
  const n1 = await guest.evaluate(`(async () => { const o = {};
    const t = async (k, url, init) => { try { const r = await fetch(url, init); o[k] = { resolved: true, ok: r.ok, status: r.status }; } catch (e) { o[k] = { rejected: String((e && e.name) || e) }; } };
    await t('external_https', 'https://example.com/', { mode: 'no-cors' });
    await t('loopback_port', '${CANARY}/n1-fetch', { mode: 'no-cors' });
    await t('other_pack', '/plugin.other/zumi-pack.json');
    await t('app_host', 'http://tauri.localhost/index.html', { mode: 'no-cors' });
    await t('ipc_host', 'http://ipc.localhost/rpc', { mode: 'no-cors' });
    return o; })()`, { timeoutMs: 60000 });
  // Another pack's path is answered by the protocol handler itself: 404 (or the request filter's 403). Never a body.
  const blocked = (r) => r.rejected !== undefined || (r.resolved && !r.ok && (r.status === 403 || r.status === 404));
  await sleep(1500);
  record('N1', Object.values(n1).every(blocked) && !hits.some((h) => h.includes('n1-fetch')) && hits.length === 0, { n1, canaryHits: hits.slice(0, 5) });

  // ---- N2: WebSocket to an external host and to loopback ----
  const n2 = await guest.evaluate(`(async () => { const o = {};
    const ws = (k, url) => new Promise((res) => { let opened = false; const w = new WebSocket(url); w.onopen = () => { opened = true; o[k] = 'OPENED'; res(); }; w.onerror = () => { if (!opened) o[k] = 'error'; }; w.onclose = () => { if (!opened) o[k] = o[k] || 'closed'; res(); }; setTimeout(() => { o[k] = o[k] || 'timeout'; res(); }, 5000); });
    await ws('external', 'wss://example.com/');
    await ws('loopback', 'ws://127.0.0.1:${CANARY_PORT}/n2-ws');
    return o; })()`, { timeoutMs: 60000 });
  await sleep(1500);
  const log2 = findLog();
  record('N2', Object.values(n2).every((v) => v !== 'OPENED') && hits.length === 0 && /refused csp connect-src pack=plugin\.room-preview origin=ws:\/\/127\.0\.0\.1/.test(log2), { n2, canaryHits: hits.slice(0, 5), cspLine: /refused csp connect-src[^\n]*ws:[^\n]*/.exec(log2)?.[0] });

  // ---- N3: image beacon (refused by CSP itself), window.open, top navigation ----
  const n3a = await guest.evaluate(`new Promise((res) => { const i = new Image(); i.onload = () => res('LOADED'); i.onerror = () => res('error'); i.src = '${CANARY}/n3-beacon.png'; setTimeout(() => res('timeout'), 5000); })`, { timeoutMs: 30000 });
  await sleep(1500);
  const hitsAfterImage = hits.length;
  const n3b = await guest.evaluate(`(() => { try { const w = window.open('${CANARY}/n3-window'); return w ? 'OPENED' : 'null'; } catch (e) { return 'threw'; } })()`);
  await sleep(2500);
  const hitsAfterWindow = hits.length;
  const hrefBefore = await guest.evaluate('location.href');
  await guest.evaluate(`setTimeout(() => { location.href = '${CANARY}/n3-nav'; }, 10), true`);
  await sleep(3000);
  const hitsAfterNav = hits.length;
  let hrefAfter = null;
  try { hrefAfter = await guest.evaluate('location.href', { timeoutMs: 15000 }); } catch (e) { hrefAfter = `unreachable: ${String(e.message || e).slice(0, 80)}`; }
  const log3 = findLog();
  const cspImg = /refused csp img-src pack=plugin\.room-preview origin=http:\/\/127\.0\.0\.1/.test(log3);
  const newWin = log3.includes('refused new window off the pack');
  const navRefused = log3.includes('refused navigation off the pack');
  // HTTP requests are the criterion; bare TCP connections are reported on their own (see RESULT.md: a refused top-level
  // navigation still makes WebView2 open two speculative TCP connections to its target, measured on this build).
  const requests = hits.filter((h) => h !== 'connection');
  record('N3', n3a !== 'LOADED' && n3b !== 'OPENED' && requests.length === 0 && cspImg && newWin && navRefused && hrefAfter === hrefBefore, { n3a, n3b, hrefBefore, hrefAfter, cspImg, newWin, navRefused, hitsAfterImage, hitsAfterWindow, hitsAfterNav, requests: requests.slice(0, 5), preconnects: hits.length - requests.length });

  // ---- N4: no app command is reachable from the guest, and the refusal is the ACL's, with its text ----
  const n4 = await guest.evaluate(`(async () => { const o = {}; const I = window.__TAURI_INTERNALS__;
    if (!I) return { internals: 'absent' };
    const t = async (k, cmd, a) => { try { const r = await I.invoke(cmd, a); o[k] = { resolved: true }; } catch (e) { o[k] = { isError: e instanceof Error, type: typeof e, text: String((e && e.message) || e).slice(0, 200) }; } };
    await t('rpc', 'rpc', { method: 'ping', args: [] });
    await t('guest_open', 'guest_open', { src: 'http://zumipack.localhost/x', partition: 'pack:plugin.x' });
    await t('pack_list', 'pack_list', {});
    await t('event_listen', 'plugin:event|listen', { event: 'x', target: { kind: 'Any' }, handler: 1 });
    return o; })()`, { timeoutMs: 60000 });
  // Tauri rejects an invoke with a STRING (not an Error); its text names the webview label and the capability that does not allow it.
  const aclText = (r) => r && r.resolved === undefined && /not allowed on window "main", webview "guest-pack-\d+"/.test(r.text) && /allowed on: \[webviews: "main"/.test(r.text);
  const n4pass = n4.internals === 'absent' ? false : Object.values(n4).every(aclText);
  record('N4', n4pass, { n4, rejectionsAreErrors: Object.values(n4).every((r) => r && r.isError) });
} catch (e) {
  console.log(`harness error: ${String((e && e.stack) || e).slice(0, 800)}`);
  for (const id of only) if (!results[id]) record(id, false, { harnessError: String((e && e.message) || e).slice(0, 300) });
} finally {
  if (outFile) fs.writeFileSync(outFile, JSON.stringify({ when: new Date().toISOString(), results, canaryHits: hits }, null, 1));
  await stop();
}
const failed = [...only].filter((id) => !results[id] || !results[id].pass);
console.log(failed.length ? `FAILED: ${failed.join(', ')}` : 'ALL OK');
process.exit(failed.length ? 1 : 0);
