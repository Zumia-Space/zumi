// T-31 Tauri parity step 4 check: models / rooms / gestures write side + the file-dialog boundary (GATE-step4.md).
// Plain Node: no Electron, no Tauri, no window, no dialog, no network. Nothing is launched.
//
//   node scripts/check-tauri-step4.mjs
//
//   1. selectModel / importModelPath (conditions 2-3): what the host's pick may and may not import
//   2. public openModelFile / rooms.openFile ignore a renderer-supplied path and never change settings (condition 2)
//   3. importRoomPath: room-check + copy under <store>/<sha12>/ (condition 3), rooms.select
//   4. rooms.delete (condition 4): ../x, junctions, poisoned settings, default rooms; target files survive
//   5. rooms.v2.saveView (condition 5): dev gate, validation, writes only the served copy, rollback
//   6. playGesture <-> gesture:result round trip, timeout, model:changed producer
//   7. over the real stdio protocol: the gesture:play push + the host-only reply, and the openModelFile no-arg rule
//   8. static: no new crate beyond `windows`, no tauri-plugin-dialog, the Rust rpc intercepts the dialogs first
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import { createBootReads } from '../tauri/sidecar/boot-reads.mjs';
import { createLibrary } from '../tauri/sidecar/library.mjs';
import { createEmitter } from '../tauri/sidecar/protocol.mjs';
import { sidecarHandlerNames } from './check-tauri-coverage.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${detail ? '  ' + detail : ''}`); } };
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const TMP_ROOT = path.join(ROOT, '.tauri-check-tmp');
fs.mkdirSync(TMP_ROOT, { recursive: true });
const tmp = fs.mkdtempSync(path.join(TMP_ROOT, 'step4-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A minimal glTF binary the room checker accepts (JSON chunk only; it warns about missing anchors, which is fine).
function glb(extra = {}) {
  const json = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, scenes: [{ nodes: [] }], scene: 0, ...extra }));
  const padded = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const head = Buffer.alloc(20);
  head.writeUInt32LE(0x46546c67, 0); // glTF
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(20 + padded.length, 8);
  head.writeUInt32LE(padded.length, 12);
  head.writeUInt32LE(0x4e4f534a, 16); // JSON
  return Buffer.concat([head, padded]);
}

// The repo ships no bundled models (assets/models/models.json is empty), so the checks bring their own two.
const modelsDir = path.join(tmp, 'models');
fs.mkdirSync(modelsDir, { recursive: true });
fs.writeFileSync(path.join(modelsDir, 'a.vrm'), 'alpha');
fs.writeFileSync(path.join(modelsDir, 'b.vrm'), 'beta!');
fs.writeFileSync(path.join(modelsDir, 'models.json'), JSON.stringify({ models: [{ id: 'a', label: 'Alpha', file: 'a.vrm', default: true }, { id: 'b', label: 'Beta', file: 'b.vrm' }] }));

let seq = 0;
// A fresh sidecar-side world: settings.json store, boot reads, a capturing emitter, the library under test.
function world(initial = {}, libOptions = {}) {
  const dataDir = path.join(tmp, `w${++seq}`);
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify(initial));
  const settings = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
  const saveSettings = (patch) => { const next = { ...settings(), ...patch }; fs.writeFileSync(file, JSON.stringify(next)); return next; };
  const frames = [];
  const emit = createEmitter((f) => frames.push(f));
  const boot = createBootReads({ dataDir, settings, saveSettings, dirs: { models: modelsDir, ...(libOptions.bootDirs || {}) } });
  const lib = createLibrary({ settings, saveSettings, boot, emit, ...(libOptions.emit ? { emit: libOptions.emit } : {}), gestureTimeoutMs: libOptions.gestureTimeoutMs });
  return { dataDir, file, settings, frames, boot, lib, store: path.join(dataDir, 'rooms') };
}
const put = (dir, name, bytes) => { fs.mkdirSync(dir, { recursive: true }); const p = path.join(dir, name); fs.writeFileSync(p, bytes); return p; };
const exists = (p) => fs.existsSync(p);

// ---------------------------------------------------------------- 1. models
{
  const w = world({});
  const before = w.boot.listModels();
  const bundled = before.models.find((m) => m.source === 'bundled');
  ok(Boolean(bundled), 'fixture: a bundled model exists to select');
  const other = before.models.find((m) => m.source === 'bundled' && m.id !== before.selected) || bundled;
  const after = w.lib.selectModel(other.id);
  ok(w.settings().model === other.id && after.selected === other.id, 'selectModel: a known id is saved and returned as selected');
  w.lib.selectModel('does-not-exist');
  ok(w.settings().model === other.id, 'selectModel: an unknown id changes nothing');
  w.lib.selectModel('test');
  ok(w.settings().model === other.id, 'selectModel: "test" is never persisted');
  w.lib.selectModel({ id: 'x' });
  ok(w.settings().model === other.id, 'selectModel: a non-string id changes nothing');

  const dir = path.join(tmp, 'vrm');
  const good = put(dir, 'hero.vrm', Buffer.from('not really a model'));
  const list = w.lib.importModelPath(good);
  ok(w.settings().userModelPath === good && w.settings().model === 'user', 'importModelPath: a regular .vrm is referenced in place and selected');
  ok(list && list.selected === 'user' && list.models.some((m) => m.id === 'user' && m.path === good), 'importModelPath: the list now has the user model, selected');
  ok(fs.existsSync(good) && fs.readFileSync(good, 'utf8') === 'not really a model', 'importModelPath: the picked file is not copied or touched');

  const w2 = world({ model: 'keep' });
  const notVrm = put(dir, 'hero.txt', 'x');
  const dirNamedVrm = path.join(dir, 'folder.vrm');
  fs.mkdirSync(dirNamedVrm, { recursive: true });
  const bads = [
    ['a relative path', 'hero.vrm'],
    ['a wrong extension', notVrm],
    ['a directory named *.vrm', dirNamedVrm],
    ['a missing file', path.join(dir, 'missing.vrm')],
    ['a path with a NUL', `${good}\0.vrm`],
    ['a non-string', { path: good }],
    ['an empty string', ''],
    ['null', null],
    ['an over-long path', `C:/${'a'.repeat(40_000)}.vrm`],
  ];
  for (const [label, value] of bads) {
    const r = w2.lib.importModelPath(value);
    ok(r === null && w2.settings().model === 'keep' && w2.settings().userModelPath === undefined, `importModelPath refuses ${label}`);
  }
  // A symlink named *.vrm is not a regular file. Creating one needs a privilege on Windows; skip (not pass) without it.
  let linked = null;
  try { linked = path.join(dir, 'link.vrm'); fs.symlinkSync(good, linked, 'file'); } catch { linked = null; }
  if (linked) ok(w2.lib.importModelPath(linked) === null && w2.settings().userModelPath === undefined, 'importModelPath refuses a symlink named *.vrm');
  else console.log('SKIP importModelPath symlink case (no symlink privilege on this account)');
}

// ---------------------------------------------------------------- 3. rooms import + select
const goodGlb = glb();
{
  const w = world({});
  const src = path.join(tmp, 'rooms-src');
  const file = put(src, 'my-living-room.glb', goodGlb);
  put(src, 'my-living-room.json', JSON.stringify({ format: 'zumi-room', name: 'Living room', author: 'Kei' }));
  const list = await w.lib.importRoomPath(file);
  const id = list && list.rooms && (list.rooms.find((r) => r.source === 'user') || {}).id;
  ok(typeof id === 'string' && /^[0-9a-f]{12}$/.test(id), 'importRoomPath: a valid room is imported under a 12-hex content id', JSON.stringify(list).slice(0, 200));
  ok(list.selected === id && w.settings().room === id, 'importRoomPath: the new room is selected (main.js importRoomFile)');
  ok(exists(path.join(w.store, id, 'room.glb')) && exists(path.join(w.store, id, 'check.json')), 'importRoomPath: room.glb + check.json land in <store>/<id>/');
  ok(fs.readFileSync(path.join(w.store, id, 'room.glb')).equals(goodGlb), 'importRoomPath: the stored bytes are the picked bytes');
  const entry = list.rooms.find((r) => r.id === id);
  ok(entry && entry.label === 'Living room' && entry.author === 'Kei' && entry.hasManifest === true && entry.url === `http://tauri.localhost/rooms/${id}/room.glb`, 'importRoomPath: the sidecar manifest names the room; the url is on the Tauri origin', JSON.stringify(entry));
  await w.lib.importRoomPath(file);
  ok(w.settings().importedRooms.filter((r) => r.id === id).length === 1, 'importRoomPath: importing the same bytes twice keeps one entry');

  const w2 = world({});
  const junk = put(src, 'junk.glb', Buffer.from('this is not a glb at all'));
  const r1 = await w2.lib.importRoomPath(junk);
  ok(r1 && r1.error && r1.error.code === 'not_a_room_file', 'importRoomPath: a non-glb is refused as not_a_room_file', JSON.stringify(r1));
  ok(!exists(w2.store) || fs.readdirSync(w2.store).filter((n) => n !== 'default-v2').length === 0, 'importRoomPath: a refused file leaves nothing in the store');
  ok(w2.settings().importedRooms === undefined, 'importRoomPath: a refused file leaves settings alone');
  const big = path.join(src, 'big.glb');
  fs.writeFileSync(big, Buffer.concat([goodGlb, Buffer.alloc(25_000_001 - goodGlb.length)]));
  const r2 = await w2.lib.importRoomPath(big);
  ok(r2 && r2.error && r2.error.code === 'too_big' && r2.error.params.capMb === 25, 'importRoomPath: over 25 MB is refused as too_big (parity)', JSON.stringify(r2));
  fs.rmSync(big);
  for (const [label, value] of [['a relative path', 'room.glb'], ['a directory', src], ['a missing file', path.join(src, 'nope.glb')], ['a non-string', 42]]) {
    const r = await w2.lib.importRoomPath(value);
    ok(r && r.error && r.error.code === 'not_a_room_file', `importRoomPath refuses ${label}`);
  }

  // rooms.select
  const w3 = world({});
  const l3 = await w3.lib.importRoomPath(file);
  const rid = l3.selected;
  await w3.lib.selectRoom('none');
  ok(w3.settings().room === 'none', 'rooms.select: "none" is accepted');
  await w3.lib.selectRoom(rid);
  ok(w3.settings().room === rid, 'rooms.select: an imported id is accepted');
  await w3.lib.selectRoom('ffffffffffff');
  await w3.lib.selectRoom({ id: rid });
  await w3.lib.selectRoom('../x');
  ok(w3.settings().room === rid, 'rooms.select: an unknown, non-string or traversal id changes nothing');
}

// ---------------------------------------------------------------- 4. rooms.delete
{
  const src = path.join(tmp, 'rooms-src');
  const file = path.join(src, 'my-living-room.glb');

  // happy path: a selected imported room is removed and the selection falls back to none
  const w = world({});
  const l = await w.lib.importRoomPath(file);
  const id = l.selected;
  const after = await w.lib.deleteRoom(id);
  ok(!exists(path.join(w.store, id)) && !after.rooms.some((r) => r.id === id) && w.settings().room === 'none' && w.settings().importedRooms.length === 0, 'rooms.delete: removes the folder and the entry; the selection falls back to none');

  // not imported: a folder under the store that settings never listed survives
  const w2 = world({});
  const stray = put(path.join(w2.store, 'aaaaaaaaaaaa'), 'room.glb', 'x');
  await w2.lib.deleteRoom('aaaaaaaaaaaa');
  ok(exists(stray), 'rooms.delete: an id that is not in importedRooms removes nothing');

  // traversal / default names / odd types, with a victim next to the store
  const w3 = world({});
  const victim = put(path.join(w3.dataDir, 'victim'), 'keep.txt', 'precious');
  const defV2 = put(path.join(w3.store, 'default-v2', 'abc'), 'room.json', '{}');
  const l3 = await w3.lib.importRoomPath(file);
  const rid = l3.selected;
  for (const bad of ['../victim', '..\\victim', '../rooms', '..', '.', 'default', 'default-v2', 'DEFAULT-V2', rid.toUpperCase(), `${rid}/..`, '', null, undefined, 7, { id: rid }, [rid]]) {
    await w3.lib.deleteRoom(bad);
  }
  ok(exists(victim) && exists(defV2) && exists(path.join(w3.store, rid, 'room.glb')), 'rooms.delete: ../x, default, default-v2, upper-case, non-string ids delete nothing');
  ok(w3.settings().importedRooms.some((r) => r.id === rid), 'rooms.delete: a refused id leaves settings unchanged');

  // poisoned settings: an importedRooms entry whose id is a traversal string is never used as a path
  const w4 = world({});
  const victim4 = put(path.join(w4.dataDir, 'victim'), 'keep.txt', 'precious');
  w4.lib.selectModel('x'); // touch nothing; make the store exist
  fs.mkdirSync(w4.store, { recursive: true });
  fs.writeFileSync(w4.file, JSON.stringify({ importedRooms: [{ id: '../victim' }, { id: '..' }] }));
  await w4.lib.deleteRoom('../victim');
  await w4.lib.deleteRoom('..');
  ok(exists(victim4), 'rooms.delete: a poisoned importedRooms id never reaches the filesystem');

  // a junction at <store>/<id> pointing at a folder outside the store: the target's files survive
  const w5 = world({});
  const outside = path.join(tmp, 'outside5');
  const precious = put(outside, 'precious.txt', 'do not delete');
  const preciousSub = put(path.join(outside, 'sub'), 'deep.txt', 'do not delete either');
  const jid = '0123456789ab';
  fs.mkdirSync(w5.store, { recursive: true });
  let junctionOk = true;
  try { fs.symlinkSync(outside, path.join(w5.store, jid), 'junction'); } catch { junctionOk = false; }
  if (junctionOk) {
    fs.writeFileSync(w5.file, JSON.stringify({ importedRooms: [{ id: jid, fileBase: 'x.glb', manifest: null }], room: jid }));
    const r = await w5.lib.deleteRoom(jid);
    ok(exists(precious) && exists(preciousSub), 'rooms.delete: a junction at the id is NOT followed, the target files survive');
    ok(w5.settings().importedRooms.length === 1 && w5.settings().room === jid, 'rooms.delete: a refused junction leaves settings untouched');
    ok(r && Array.isArray(r.rooms), 'rooms.delete: a refusal still answers with the room list');

    // a junction nested INSIDE a real room folder: removing the folder must unlink it, not delete its target
    const w6 = world({});
    const l6 = await w6.lib.importRoomPath(file);
    const rid6 = l6.selected;
    const outside6 = path.join(tmp, 'outside6');
    const precious6 = put(outside6, 'precious.txt', 'do not delete');
    fs.symlinkSync(outside6, path.join(w6.store, rid6, 'link'), 'junction');
    await w6.lib.deleteRoom(rid6);
    ok(!exists(path.join(w6.store, rid6)) && exists(precious6), 'rooms.delete: a junction nested in the room folder is unlinked, its target files survive');
  } else console.log('SKIP rooms.delete junction cases (cannot create a junction here)');

  // a missing folder (removed by hand) still drops the entry
  const w7 = world({});
  const l7 = await w7.lib.importRoomPath(file);
  fs.rmSync(path.join(w7.store, l7.selected), { recursive: true, force: true });
  await w7.lib.deleteRoom(l7.selected);
  ok(w7.settings().importedRooms.length === 0, 'rooms.delete: a folder already gone still drops the entry');
}

// ---------------------------------------------------------------- 5. rooms.v2.saveView
{
  const pinned = path.join(ROOT, 'resources-pinned', 'room-v2');
  // The source room is a COPY in the temp tree, so "the source is untouched" is a real byte comparison.
  const srcDir = path.join(tmp, 'v2-source');
  fs.cpSync(pinned, srcDir, { recursive: true });
  const srcJson = path.join(srcDir, 'room.json');
  const srcBefore = fs.readFileSync(srcJson);
  const cam = { pos: [1, 2, 3], target: [0, 1, 0], fov: 33 };
  const w = world({ developerMode: true }, { bootDirs: { roomV2Json: srcJson } });
  await w.boot.listRooms(); // creates the served copy
  const served = w.boot.servedRoomV2Json();
  ok(Boolean(served) && served.startsWith(w.store) && served !== srcJson, 'saveView fixture: a served copy exists inside the data dir');
  const servedBefore = fs.readFileSync(served, 'utf8');
  const view = Object.keys(JSON.parse(servedBefore).views).find((v) => ['talk', 'work', 'room'].includes(v));

  const off = world({}, { bootDirs: { roomV2Json: srcJson } });
  ok(JSON.stringify(off.lib.saveRoomV2View('default-v2', 'talk', cam)) === JSON.stringify({ error: 'dev_tools_off' }), 'saveView: refused without developerMode');
  const e = (r) => r && r.error;
  ok(e(w.lib.saveRoomV2View('default', view, cam)) === 'unknown_room' && e(w.lib.saveRoomV2View('../x', view, cam)) === 'unknown_room', 'saveView: only the default-v2 room');
  ok(e(w.lib.saveRoomV2View('default-v2', 'constructor', cam)) === 'bad_view' && e(w.lib.saveRoomV2View('default-v2', '__proto__', cam)) === 'bad_view' && e(w.lib.saveRoomV2View('default-v2', 'sky', cam)) === 'bad_view', 'saveView: only talk / work / room');
  for (const [label, c] of [['null', null], ['short pos', { ...cam, pos: [1, 2] }], ['NaN target', { ...cam, target: [0, NaN, 0] }], ['string fov', { ...cam, fov: '33' }], ['Infinity fov', { ...cam, fov: Infinity }], ['missing target', { pos: cam.pos, fov: 33 }]]) {
    ok(e(w.lib.saveRoomV2View('default-v2', view, c)) === 'bad_camera', `saveView: bad camera (${label})`);
  }
  ok(fs.readFileSync(served, 'utf8') === servedBefore, 'saveView: every refusal left the served copy as it was');

  const r = w.lib.saveRoomV2View('default-v2', view, cam);
  const after = JSON.parse(fs.readFileSync(served, 'utf8'));
  ok(r && r.ok === true, 'saveView: a valid edit succeeds', JSON.stringify(r));
  ok(JSON.stringify(after.views[view].camera.pos) === '[1,2,3]' && after.views[view].camera.three.fov === 33, 'saveView: pos / target / three.fov land on the served copy');
  const beforeJson = JSON.parse(servedBefore);
  const keep = Object.keys(beforeJson.views[view].camera).filter((k) => !['pos', 'target', 'three'].includes(k));
  ok(keep.every((k) => JSON.stringify(after.views[view].camera[k]) === JSON.stringify(beforeJson.views[view].camera[k])), 'saveView: the registration tool\'s other camera fields are merged around, not overwritten');
  ok(fs.readFileSync(srcJson).equals(srcBefore) && fs.readFileSync(path.join(pinned, 'room.json')).equals(srcBefore), 'saveView: the source room.json (and the pinned copy) is byte-identical');
  const again = w.lib.saveRoomV2View('default-v2', view, cam);
  ok(again && again.ok === true && again.unchanged === true, 'saveView: the same camera again is unchanged');
  const mess = w.lib.saveRoomV2View('default-v2', view, { pos: [1, 2, 3], target: [0, 1, 0], fov: 1e9 });
  ok(e(mess) === 'save_made_it_invalid' ? JSON.stringify(JSON.parse(fs.readFileSync(served, 'utf8')).views[view].camera) === JSON.stringify(after.views[view].camera) : mess && mess.ok === true, 'saveView: a save the checker rejects is rolled back (or accepted by the checker as valid)', JSON.stringify(mess));
}

// ---------------------------------------------------------------- 6. gestures + model:changed
{
  const w = world({}, { gestureTimeoutMs: 40 });
  const p = w.lib.playGesture({ gesture: 'wave' });
  const push = w.frames.find((f) => f.method === 'event');
  ok(push && push.params.channel === 'gesture:play' && push.params.payload.command.gesture === 'wave' && Number.isInteger(push.params.payload.reqId), 'playGesture: pushes gesture:play { reqId, command }');
  ok(w.lib.gestureResult(push.params.payload.reqId + 99, { ok: true }) === false, 'gestureResult: an unknown reqId resolves nothing');
  ok(w.lib.gestureResult('1', { ok: true }) === false && w.lib.gestureResult(null, {}) === false && w.lib.gestureResult({}, {}) === false, 'gestureResult: a non-integer reqId resolves nothing');
  ok(w.lib.gestureResult(push.params.payload.reqId, { ok: true, warnings: [] }) === true, 'gestureResult: the matching reqId resolves');
  const verdict = await p;
  ok(verdict.ok === true && Array.isArray(verdict.warnings), 'playGesture: resolves with the renderer\'s verdict');
  ok(w.lib.gestureResult(push.params.payload.reqId, { ok: false }) === false, 'gestureResult: a reqId answers once');

  const t0 = Date.now();
  const timedOut = await w.lib.playGesture('x');
  ok(timedOut.ok === false && timedOut.errors[0] === 'renderer did not answer' && Date.now() - t0 >= 30, 'playGesture: no answer -> { ok:false, errors:["renderer did not answer"] } after the deadline');

  const refusing = world({}, { emit: () => false });
  const refused = await refusing.lib.playGesture({ big: true });
  ok(refused.ok === false && /could not be delivered/.test(refused.errors[0]), 'playGesture: an undeliverable push fails at once, not after the timeout');

  const huge = await world({}).lib.playGesture({ blob: 'x'.repeat(600_000) });
  ok(huge.ok === false && /could not be delivered/.test(huge.errors[0]), 'playGesture: a command over the event-size bound is refused by the emitter');

  w.frames.length = 0;
  ok(w.lib.modelChanged('wardrobe-apply') === true, 'modelChanged: reports the push was written');
  const mc = w.frames.find((f) => f.method === 'event');
  ok(mc && mc.params.channel === 'model:changed' && mc.params.payload.reason === 'wardrobe-apply', 'modelChanged: pushes model:changed { reason }');
  const none = world({});
  none.lib.selectModel('x');
  none.lib.importModelPath(path.join(tmp, 'vrm', 'hero.vrm'));
  ok(none.frames.length === 0, 'the renderer\'s own selectModel / openModelFile push no model:changed (it would switch twice)');
}

// ---------------------------------------------------------------- 7. over the real stdio protocol
function startSidecar(dataDir, env = {}) {
  const child = spawn(process.execPath, [path.join(ROOT, 'tauri', 'sidecar', 'main.mjs'), '--data-dir', dataDir, '--no-voice-prefetch'], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  const rl = readline.createInterface({ input: child.stdout });
  const waiting = new Map();
  const notes = [];
  let nextId = 1;
  rl.on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id != null && waiting.has(msg.id)) { const r = waiting.get(msg.id); waiting.delete(msg.id); clearTimeout(r.timer); r.resolve(msg); } else if (msg.method) notes.push(msg);
  });
  return {
    notes,
    request(method, params = [], ms = 8000) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`timeout waiting for ${method}`)); }, ms);
        waiting.set(id, { resolve, timer });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
    close() { try { child.stdin.end(); } catch { /* ignore */ } try { child.kill(); } catch { /* ignore */ } },
  };
}
{
  const dataDir = path.join(tmp, 'proc');
  fs.mkdirSync(dataDir, { recursive: true });
  const settingsFile = path.join(dataDir, 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({ model: 'keep', developerMode: false }));
  const planted = put(path.join(tmp, 'plant'), 'x.vrm', 'x');
  const plantedGlb = put(path.join(tmp, 'plant'), 'x.glb', goodGlb);
  const sc = startSidecar(dataDir);
  try {
    await sc.request('info'); // the sidecar pins the AI provider into settings.json at start (step 6); read after that settles
    const settledBefore = fs.readFileSync(settingsFile, 'utf8');
    const a = await sc.request('openModelFile', [planted]);
    const b = await sc.request('openModelFile', [planted, { path: planted }]);
    const c = await sc.request('rooms.openFile', [plantedGlb]);
    ok(a.result === null && b.result === null && c.result === null, 'rpc openModelFile / rooms.openFile with a path argument answer null (nothing imported)');
    ok(fs.readFileSync(settingsFile, 'utf8') === settledBefore, 'rpc openModelFile([path]) never changes settings (gate condition 2)');
    ok(!exists(path.join(dataDir, 'rooms')) || fs.readdirSync(path.join(dataDir, 'rooms')).length === 0, 'rpc rooms.openFile([path]) copies nothing into the store');

    const gesture = sc.request('playGesture', [{ gesture: 'nod' }], 8000);
    await sleep(250);
    const push = sc.notes.find((n) => n.method === 'event' && n.params.channel === 'gesture:play');
    ok(Boolean(push) && push.params.payload.command.gesture === 'nod', 'rpc playGesture pushes gesture:play to the host');
    const ack = await sc.request('__host.gestureResult', [push.params.payload.reqId, { ok: true, errors: [], warnings: [] }]);
    ok(ack.result === true, 'host-only __host.gestureResult accepts the reply');
    const got = await gesture;
    ok(got.result && got.result.ok === true, 'rpc playGesture resolves with the renderer\'s verdict over stdio');

    const sel = await sc.request('selectModel', ['nope']);
    ok(sel.result && Array.isArray(sel.result.models), 'rpc selectModel answers Electron\'s { models, selected, bundledCount }');
    const del = await sc.request('rooms.delete', ['../../etc']);
    ok(del.result && Array.isArray(del.result.rooms), 'rpc rooms.delete with a hostile id answers the room list and deletes nothing');
    const sv = await sc.request('rooms.v2.saveView', ['default-v2', 'talk', { pos: [0, 0, 0], target: [0, 0, 0], fov: 30 }]);
    ok(sv.result && sv.result.error === 'dev_tools_off', 'rpc rooms.v2.saveView is refused with developerMode off');
    const imp = await sc.request('__host.importModelPath', [planted]);
    ok(imp.result && imp.result.selected === 'user', 'host-only __host.importModelPath imports (this is the only way in, via the Rust dialog)');
  } finally { sc.close(); }

  const fx = startSidecar(path.join(tmp, 'fixture'), { ZUMI_EVENT_FIXTURE: '1' });
  try {
    // The probe fires 3 s after the sidecar starts (main.mjs startEventFixture). Poll with a deadline instead of a
    // fixed sleep: under load (parallel checks) node startup can eat the 600 ms margin and the old 3600 ms sleep
    // failed intermittently.
    const sawProbe = () => fx.notes.some((n) => n.method === 'event' && n.params.channel === 'model:changed' && n.params.payload.reason === 'probe');
    for (let i = 0; i < 100 && !sawProbe(); i++) await sleep(100);
    ok(sawProbe(), 'ZUMI_EVENT_FIXTURE=1 fires model:changed once through the real producer (spare-PC probe)');
  } finally { fx.close(); }
}

// ---------------------------------------------------------------- 8. static
{
  const names = new Set(sidecarHandlerNames(read('tauri', 'sidecar', 'main.mjs')));
  for (const n of ['selectModel', 'openModelFile', 'playGesture', 'rooms.select', 'rooms.openFile', 'rooms.delete', 'rooms.v2.saveView', 'scenes.select', 'chairs.select', '__host.importModelPath', '__host.importRoomPath', '__host.gestureResult']) ok(names.has(n), `sidecar handler table has ${n}`);
  const main = read('tauri', 'sidecar', 'main.mjs');
  ok(/^ {4}openModelFile: \(\) =>/m.test(main) && /^ {4}'rooms\.openFile': \(\) =>/m.test(main), 'the public openModelFile / rooms.openFile handlers take no parameters');
  ok(!/electron/i.test(read('tauri', 'sidecar', 'library.mjs').replace(/\/\/.*$/gm, '')), 'library.mjs imports no Electron');
  const inventory = JSON.parse(read('docs', 'migration', 'api-inventory.json'));
  ok(!JSON.stringify(inventory).includes('importModelPath') && !JSON.stringify(inventory).includes('gestureResult'), 'the host-only methods are not in the api inventory');

  const cargo = read('tauri', 'src-tauri', 'Cargo.toml').replace(/^\s*#.*$/gm, ''); // comments may name what is rejected
  const lock = read('tauri', 'src-tauri', 'Cargo.lock');
  ok(!/tauri-plugin-dialog|rfd\b/.test(cargo + lock), 'no dialog plugin crate (tauri-plugin-dialog / rfd) in Cargo.toml or Cargo.lock');
  const lockedWindows = /name = "windows"\r?\nversion = "(0\.62\.\d+)"/.exec(lock);
  const dep = /^windows = \{ version = "(0\.62)"/m.exec(cargo);
  ok(Boolean(dep) && Boolean(lockedWindows), 'Cargo.toml declares windows = "0.62" and Cargo.lock holds a 0.62.x windows crate', `${dep && dep[1]} / ${lockedWindows && lockedWindows[1]}`);
  const feats = (/^windows = \{[^}]*features = \[([^\]]*)\]/ms.exec(cargo) || ['', ''])[1].match(/"\w+"/g) || [];
  ok(feats.length === 4 && ['"Win32_Foundation"', '"Win32_System_Com"', '"Win32_UI_Shell"', '"Win32_UI_Shell_Common"'].every((f) => feats.includes(f)), 'windows features are exactly Foundation, System_Com, UI_Shell, UI_Shell_Common', feats.join(','));

  const dialogSrc = read('tauri', 'src-tauri', 'src', 'dialog_ops.rs');
  ok(/FOS_FILEMUSTEXIST/.test(dialogSrc) && /FOS_FORCEFILESYSTEM/.test(dialogSrc) && /FOS_NOCHANGEDIR/.test(dialogSrc), 'dialog_ops.rs sets FOS_FILEMUSTEXIST | FOS_FORCEFILESYSTEM | FOS_NOCHANGEDIR');
  ok(/COINIT_APARTMENTTHREADED/.test(dialogSrc) && /Show\(hwnd\)/.test(dialogSrc), 'dialog_ops.rs enters an STA and shows the dialog with the owner window');
  ok(/Open VRM file/.test(dialogSrc) && /Open room file/.test(dialogSrc) && /\*\.vrm/.test(dialogSrc) && /\*\.glb/.test(dialogSrc), 'dialog titles and filters are the Electron ones');
  const electronMain = read('src', 'main', 'main.js');
  ok(/title: 'Open VRM file'/.test(electronMain) && /title: 'Open room file'/.test(electronMain) && /extensions: \['vrm'\]/.test(electronMain) && /extensions: \['glb'\]/.test(electronMain), 'main.js still carries those titles and filters (so the copy above is a copy of something real)');

  const lib = read('tauri', 'src-tauri', 'src', 'lib.rs');
  const gateAt = lib.indexOf('ALLOWED_METHODS.contains(&method.as_str())');
  const dialogAt = lib.indexOf('dialog_ops::Kind::from_method(&method)');
  const forwardAt = lib.indexOf('client.call(&method, args, timeout)');
  ok(gateAt > 0 && dialogAt > gateAt && forwardAt > dialogAt, 'lib.rs: the rpc command intercepts the dialog methods after the allow-list and BEFORE the sidecar forward');
  ok(/spawn_blocking\(move \|\| \{\s*run_file_dialog/.test(lib), 'lib.rs: the dialog runs on a blocking worker, never the UI thread');
  const body = lib.slice(dialogAt, lib.indexOf('let args = args.unwrap_or_default();', dialogAt));
  ok(!/\bargs\b/.test(body), 'lib.rs: the dialog branch never reads the renderer\'s args');
  ok(/\.manage\(dialog_ops::SingleFlight::default\(\)\)/.test(lib), 'lib.rs: one managed single-flight gate for both dialogs');
  const caps = read('tauri', 'src-tauri', 'capabilities', 'default.json');
  ok(!/dialog/i.test(caps), 'the capability file grants no dialog permission');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
