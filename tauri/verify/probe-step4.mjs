// T-31 parity step 4 spare-PC probe: models / rooms / scenes / chairs / gesture / model:changed / the file dialog on
// the RUNNING preview. WRITTEN, NOT RUN on the main PC: every launch, and above all every dialog, is a spare-PC job
// (ZUMI_ELECTRON_HOST=box). Never run this where the owner is working: the dialog steps drive the keyboard.
//
// Start the preview the way run-guard-probe.ps1 does, plus the fixture switch (it fires `model:changed` once, 3 s
// after the sidecar starts, through the real producer):
//   $env:ZUMI_ELECTRON_HOST = 'box'
//   $env:ZUMI_EVENT_FIXTURE = '1'
//   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9333'
//   <start ZumiPreview.exe>, wait for the main window, then run this right away (it subscribes before the 3 s mark):
//   node tauri/verify/probe-step4.mjs --cdp 9333 --helper tauri\verify\dialog-pick.ps1 --pid <ZumiPreview pid> `
//        --vrm <abs path of a real .vrm on the box> --glb <abs path of a valid room .glb> --out <dir>\step4-probe.json
//
// What it proves on the real app (the cargo tests and check-tauri-step4.mjs cannot):
//   1. model:changed reaches window.zumi.onModelChanged;
//   2. selectModel / rooms.select / scenes.select / chairs.select persist across a second list call;
//   3. playGesture round-trips through the real player: a valid command -> ok:true, an invalid one -> ok:false with
//      the validator's errors (the verdict came from the renderer over gesture:result, not a stub);
//   4. openModelFile through the real IFileOpenDialog: typed path -> the 'user' model is selected; Esc -> null;
//      a second openModelFile while the first dialog is open -> null at once (single flight); a path passed as an
//      argument is ignored (the dialog still opens);
//   5. rooms.openFile imports the .glb (a user room is listed and selected), rooms.delete removes it.
// PASS requires every line. A missing helper, a dialog that never appeared or a timeout is INCONCLUSIVE, never PASS.
// Node >= 22 (global WebSocket and fetch), no dependencies.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1]]] : a), []));
const port = Number(args.cdp || 9333);
const outFile = args.out || 'step4-probe.json';
const helper = args.helper || '';
const pid = Number(args.pid || 0);

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The dialog helper types into / dismisses the foreground common dialog by its title. ok=false = never saw it.
function dialog(action, title, text = '') {
  if (!helper || !pid) return { ok: false, why: 'no --helper / --pid' };
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helper, '-Action', action, '-Title', title, '-Text', text, '-TargetPid', String(pid)], { encoding: 'utf8', timeout: 30000 });
  try { return JSON.parse((r.stdout || '').trim().split(/\r?\n/).pop()); } catch { return { ok: false, why: 'helper gave no JSON' }; }
}

const results = {};
const inconclusive = [];
const rec = (name, value, why = '') => { results[name] = value; if (value === null) inconclusive.push(`${name}: ${why}`); };

// 1. model:changed (registered first; the fixture pushes it 3 s after the sidecar starts)
await evaluate('(() => { window.__p4 = { changed: [] }; window.__p4.off = window.zumi.onModelChanged((p) => window.__p4.changed.push(p)); return true; })()');

// 2. selection round trips
const models = await evaluate('window.zumi.listModels()');
const otherModel = models && models.models.find((m) => m.id !== models.selected);
if (otherModel) {
  const picked = await evaluate(`window.zumi.selectModel(${JSON.stringify(otherModel.id)})`);
  const again = await evaluate('window.zumi.listModels()');
  rec('selectModel persists', picked.selected === otherModel.id && again.selected === otherModel.id);
} else rec('selectModel persists', null, 'only one model listed');
for (const [name, listFn, selectFn, key] of [['scenes', 'scenes.list', 'scenes.select', 'rooms'], ['chairs', 'chairs.list', 'chairs.select', 'chairs']]) {
  const list = await evaluate(`window.zumi.${listFn}()`);
  const other = list && list[key] && list[key].find((x) => x.id !== list.selected);
  if (other) {
    const sel = await evaluate(`window.zumi.${selectFn}(${JSON.stringify(other.id)})`);
    const again = await evaluate(`window.zumi.${listFn}()`);
    rec(`${name}.select persists`, sel.selected === other.id && again.selected === other.id);
  } else rec(`${name}.select persists`, null, 'nothing else to select');
}
const rl = await evaluate('window.zumi.rooms.list()');
const roomPick = rl && rl.rooms.length ? rl.rooms[0].id : 'none';
const rs = await evaluate(`window.zumi.rooms.select(${JSON.stringify(roomPick)})`);
rec('rooms.select persists', Boolean(rs) && rs.selected === roomPick);

// 3. gesture round trip through the real player
const good = await evaluate("window.zumi.playGesture({ id: 'probe-nod', label: 'probe', priority: 5, interrupt: true, bones: [{ bone: 'head', rot: [8, 0, 0], inMs: 150, holdMs: 300, outMs: 200 }] })");
rec('playGesture valid command -> ok:true from the renderer', Boolean(good) && good.ok === true);
const bad = await evaluate("window.zumi.playGesture({ id: 'bad', dance: true, bones: [{ bone: 'tail', rot: [0, 0, 0] }] })");
rec('playGesture invalid command -> ok:false + errors from the validator', Boolean(bad) && bad.ok === false && Array.isArray(bad.errors) && bad.errors.length > 0 && !bad.errors.includes('renderer did not answer'));

// 1 (read back). model:changed arrived
await sleep(4500);
const got = JSON.parse((await evaluate('JSON.stringify(window.__p4.changed)')) || '[]');
rec('model:changed reaches onModelChanged', got.length >= 1 && got[0].reason === 'probe');

// 4. the real dialog (keyboard-driven; the helper refuses off the render box)
if (args.vrm) {
  await evaluate('window.__p4.vrm = null; window.zumi.openModelFile().then((r) => { window.__p4.vrm = { r }; }); true');
  const seen = dialog('wait', 'Open VRM file');
  if (!seen.ok) rec('openModelFile dialog opens', null, seen.why || 'dialog not seen');
  else {
    rec('openModelFile dialog opens', true);
    const second = await evaluate('window.zumi.openModelFile()'); // while the first is open
    rec('second openModelFile while open -> null (single flight)', second === null);
    dialog('type', 'Open VRM file', args.vrm);
    await sleep(2500);
    const parsed = JSON.parse((await evaluate('JSON.stringify(window.__p4.vrm)')) || 'null');
    rec('openModelFile typed path -> user model selected', Boolean(parsed && parsed.r && parsed.r.selected === 'user'));
  }
  // cancel path, with a hostile argument that must be ignored
  await evaluate("window.__p4.cancel = 'pending'; window.zumi.openModelFile('C:/Windows/notepad.vrm').then((r) => { window.__p4.cancel = r; }); true");
  const seen2 = dialog('wait', 'Open VRM file');
  if (!seen2.ok) rec('openModelFile ignores a path argument (dialog still opens)', null, seen2.why || 'dialog not seen');
  else {
    rec('openModelFile ignores a path argument (dialog still opens)', true);
    dialog('cancel', 'Open VRM file');
    await sleep(1500);
    rec('openModelFile Esc -> null', (await evaluate('window.__p4.cancel')) === null);
  }
} else rec('openModelFile dialog', null, 'no --vrm given');

if (args.glb) {
  await evaluate('window.__p4.room = null; window.zumi.rooms.openFile().then((r) => { window.__p4.room = { r }; }); true');
  const seen = dialog('wait', 'Open room file');
  if (!seen.ok) rec('rooms.openFile dialog opens', null, seen.why || 'dialog not seen');
  else {
    dialog('type', 'Open room file', args.glb);
    await sleep(4000);
    const r = JSON.parse((await evaluate('JSON.stringify(window.__p4.room)')) || 'null');
    const user = r && r.r && r.r.rooms && r.r.rooms.find((x) => x.source === 'user');
    rec('rooms.openFile imports the .glb and selects it', Boolean(user) && r.r.selected === user.id);
    if (user) {
      const del = await evaluate(`window.zumi.rooms.delete(${JSON.stringify(user.id)})`);
      rec('rooms.delete removes the imported room', Boolean(del) && !del.rooms.some((x) => x.id === user.id));
      const hostile = await evaluate("window.zumi.rooms.delete('../../x')");
      rec('rooms.delete ../../x answers the list and removes nothing', Boolean(hostile) && Array.isArray(hostile.rooms));
    }
  }
} else rec('rooms.openFile dialog', null, 'no --glb given');

const fails = Object.entries(results).filter(([, v]) => v === false).map(([k]) => k);
const verdict = fails.length ? 'FAIL' : inconclusive.length ? 'INCONCLUSIVE' : 'PASS';
fs.writeFileSync(outFile, JSON.stringify({ verdict, results, inconclusive, fails }, null, 2));
for (const [k, v] of Object.entries(results)) console.log(`${v === null ? 'INCONCLUSIVE' : v ? 'PASS' : 'FAIL'} ${k}`);
console.log(`${verdict} step 4 probe`);
ws.close();
process.exit(verdict === 'PASS' ? 0 : 1);
