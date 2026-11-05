// T-31 Tauri: the 0.2.8 default-room rule (Pi's resolveRoomSelection, commit 2a4534d) through the SIDECAR path.
// Same case names as scripts/check-room.mjs section (6). Plain Node, no Electron, no window, no network.
//   node scripts/check-tauri-room-default.mjs   (exit 1 on any failure)
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createBootReads } from '../tauri/sidecar/boot-reads.mjs';
import { resolveRoomLaunch, roomPickPatch } from '../tauri/sidecar/adapters.mjs';
import { resolveRoomSelection, APPROVED_SHIPPED_ROOMS } from '../src/main/room-default.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); } };
const TMP = path.join(ROOT, '.tauri-check-tmp', 'room-default');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
let n = 0;
const IMPORTED = 'abcdef012345'; // a content-id-shaped imported room id (ROOM_ID = 12 hex)
const MISSING_V2 = path.join(TMP, 'no-such-room-v2.json');

// A profile dir with optional saved settings and optional imported room; returns the sidecar listRooms result + the settings left on disk.
async function run({ saved, marker, imported = false, v2 = true }) {
  const dir = path.join(TMP, `p${n++}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'settings.json');
  const init = { ...(saved === undefined ? {} : { room: saved }), ...(marker === undefined ? {} : { roomChoiceV2: marker }) };
  if (imported) {
    fs.mkdirSync(path.join(dir, 'rooms', IMPORTED), { recursive: true });
    fs.writeFileSync(path.join(dir, 'rooms', IMPORTED, 'room.glb'), 'x');
    init.importedRooms = [{ id: IMPORTED, manifest: null, fileBase: 'x' }];
  }
  fs.writeFileSync(file, JSON.stringify(init));
  const get = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  const set = (p) => { fs.writeFileSync(file, JSON.stringify({ ...get(), ...p })); };
  const boot = createBootReads({ dataDir: dir, settings: get, saveSettings: set, dirs: v2 ? {} : { roomV2Json: MISSING_V2 } });
  const res = await boot.listRooms();
  return { selected: res.selected, ids: res.rooms.map((r) => r.id), settings: get() };
}

ok(APPROVED_SHIPPED_ROOMS[0] === 'default-v2', 'approved shipped room is default-v2 (room-v2 B, first in the approved list)');
{
  const r = await run({ saved: undefined });
  ok(r.selected === 'default-v2' && r.settings.room === 'default-v2' && r.settings.roomChoiceV2 === true, 'fresh profile (no saved room key) + only shipped rooms -> the approved room is selected AND persisted', JSON.stringify(r));
}
{ // 0.2.11 rule (room-default.mjs, shared with Electron): v1 is bundled and listed, but a fresh profile still lands on default-v2.
  const d = resolveRoomSelection(undefined, [{ id: 'default' }, { id: 'default-v2' }]);
  ok(d.selected === 'default-v2' && d.persist === true, "fresh profile + v1 listed -> 'default-v2' selected and persisted, never v1", JSON.stringify(d));
  const only = resolveRoomSelection(undefined, [{ id: 'default' }]);
  ok(only.selected === 'none' && only.persist === false, "stale v1-only list -> 'none', v1 is never a fallback (room v1 removed)", JSON.stringify(only));
  const kept = resolveRoomSelection('default', [{ id: 'default' }, { id: 'default-v2' }]);
  ok(kept.selected === 'default-v2' && kept.persist === true, 'saved room v1 -> default-v2 and rewritten once, even if a stale list carries v1', JSON.stringify(kept));
}
{
  const r = await run({ saved: undefined, v2: false });
  ok(r.selected === 'none' && !('room' in r.settings), "fresh profile and nothing available -> 'none', nothing persisted", JSON.stringify(r));
}
{
  const r = await run({ saved: IMPORTED, imported: true });
  ok(r.selected === IMPORTED && r.settings.room === IMPORTED, 'existing saved room that is still listed is kept, no write', JSON.stringify(r));
}
{
  const r = await run({ saved: 'default-v2' });
  ok(r.selected === 'default-v2' && r.settings.room === 'default-v2', 'saved default-v2 is kept, no write', JSON.stringify(r));
}
{
  const r = await run({ saved: 'gone-id' });
  ok(r.selected === 'default-v2' && r.settings.room === 'gone-id', 'saved room id that no longer exists -> falls back to the approved shipped room (saved value untouched)', JSON.stringify(r));
}
{
  const r = await run({ saved: 'default' });
  ok(r.selected === 'default-v2' && r.settings.room === 'default-v2', "saved 'default' (v1, removed) -> the approved shipped room, and settings.room is rewritten to it", JSON.stringify(r));
}
{
  const r = await run({ saved: 'none', marker: true });
  ok(r.selected === 'none' && r.settings.room === 'none', "explicit saved 'none' (user picked No room) stays 'none', never overridden, with a shipped room available", JSON.stringify(r));
}
{
  const r = await run({ saved: 'gone-id', v2: false });
  ok(r.selected === 'none' && r.settings.room === 'gone-id', "saved id missing and no shipped room available -> 'none'", JSON.stringify(r));
}

// -- 0.2.7 -> 0.2.8 one-time room migration: the SAME 9 case names as scripts/check-room.mjs section (7), driven through the
//    sidecar's own resolveRoomLaunch / roomPickPatch (adapters.mjs re-exports) on a fake settings store.
{
  const fakeSettings = (init) => { let cur = { ...init }; return { get: () => ({ ...cur }), set: (p) => { cur = { ...cur, ...p }; } }; };
  const shipped = [{ id: 'default-v2' }];
  const launch = (st, rooms = shipped) => { const r = resolveRoomLaunch(st.get(), rooms); if (r.patch) st.set(r.patch); return r.selected; };
  const pick = (st, id) => st.set(roomPickPatch(id));

  const s27 = fakeSettings({ room: 'none' });
  ok(launch(s27) === 'default-v2', "0.2.7 profile (room:'none', no roomChoiceV2) -> default-v2 selected on first 0.2.8 launch");
  ok(s27.get().room === 'default-v2' && s27.get().roomChoiceV2 === false, "0.2.7 migration persists room:'default-v2' AND the explicit marker roomChoiceV2:false", JSON.stringify(s27.get()));
  const before = JSON.stringify(s27.get());
  ok(launch(s27) === 'default-v2' && JSON.stringify(s27.get()) === before, 'relaunch after the migration is stable: same room, no second change to settings', JSON.stringify(s27.get()));
  ok(resolveRoomLaunch(s27.get(), shipped).patch === null, 'relaunch after the migration produces no settings patch at all');
  const post = fakeSettings({ room: 'none', roomChoiceV2: true });
  const postBefore = JSON.stringify(post.get());
  ok(launch(post) === 'none' && JSON.stringify(post.get()) === postBefore, "explicit post-0.2.8 'none' (roomChoiceV2:true) is kept, nothing written", JSON.stringify(post.get()));
  const noneAfter = fakeSettings({ room: 'none' });
  launch(noneAfter); pick(noneAfter, 'none');
  ok(noneAfter.get().room === 'none' && noneAfter.get().roomChoiceV2 === true, "an explicit pick sets roomChoiceV2:true (here: No room after the migration)", JSON.stringify(noneAfter.get()));
  ok(launch(noneAfter) === 'none' && launch(noneAfter) === 'none' && noneAfter.get().room === 'none', "No room picked after the migration survives repeated relaunches");
  const fresh = fakeSettings({});
  ok(launch(fresh) === 'default-v2' && fresh.get().room === 'default-v2' && fresh.get().roomChoiceV2 === true, 'brand-new install: default-v2 selected, persisted, and marker roomChoiceV2:true so it never migrates', JSON.stringify(fresh.get()));
  const noRoomsAvail = fakeSettings({ room: 'none' });
  ok(launch(noRoomsAvail, []) === 'none' && noRoomsAvail.get().roomChoiceV2 === undefined, "0.2.7 'none' but no room is listed: nothing to migrate to, nothing written (retries next launch)", JSON.stringify(noRoomsAvail.get()));
  const imp = fakeSettings({ room: 'some-imported-id' });
  const impBefore = JSON.stringify(imp.get());
  ok(launch(imp, [{ id: 'default-v2' }, { id: 'some-imported-id' }]) === 'some-imported-id' && JSON.stringify(imp.get()) === impBefore, "a 0.2.7 profile with a real room selected is untouched by the migration");
}
// Same rule through the real createBootReads on a profile dir.
{
  const r = await run({ saved: 'none' });
  ok(r.selected === 'default-v2' && r.settings.room === 'default-v2' && r.settings.roomChoiceV2 === false, "boot reads: 0.2.7 profile (room 'none', no marker) -> default-v2 + roomChoiceV2:false", JSON.stringify(r));
  const r2 = await run({ saved: 'none', marker: true });
  ok(r2.selected === 'none' && r2.settings.room === 'none' && r2.settings.roomChoiceV2 === true, "boot reads: explicit 'none' with marker true is kept", JSON.stringify(r2));
}

// Real sidecar process boots (headless, scratch data dir). ZUMI_ROOM_DEFAULT_PATH points at a nonexistent v1 path (the
// packaged-install situation). Returns { out, saved } after a rooms.list; `extra` can run more calls on the same process.
async function sidecarBoot(name, initial, extra = async () => {}) {
  const dataDir = path.join(TMP, name);
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'settings.json');
  if (initial) fs.writeFileSync(file, JSON.stringify(initial));
  const child = spawn(process.execPath, [path.join(ROOT, 'tauri', 'sidecar', 'main.mjs'), '--data-dir', dataDir, '--no-voice-prefetch'], {
    cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ZUMI_ROOM_DEFAULT_PATH: path.join(TMP, 'no-such-v1', 'room.glb') },
  });
  const pending = new Map();
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let m; try { m = JSON.parse(line); } catch { return; }
    if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const call = (method, params = []) => new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e9);
    const t = setTimeout(() => reject(new Error(`timeout ${method}`)), 30000);
    pending.set(id, (m) => { clearTimeout(t); resolve(m); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  try {
    const res = await call('rooms.list');
    await extra(call);
    return { out: res.result || {}, err: res.error, saved: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } finally { try { child.stdin.end(); child.kill(); } catch { /* gone */ } }
}
const readSaved = (name) => JSON.parse(fs.readFileSync(path.join(TMP, name, 'settings.json'), 'utf8'));
try {
  const f = await sidecarBoot('sidecar-fresh', null);
  ok(f.out.selected === 'default-v2' && f.saved.room === 'default-v2' && f.saved.roomChoiceV2 === true, 'fresh-profile sidecar boot (ZUMI_ROOM_DEFAULT_PATH nonexistent): rooms.list selects default-v2 and persists it with roomChoiceV2:true', JSON.stringify({ out: f.out.selected, saved: f.saved, err: f.err }));
  const m = await sidecarBoot('sidecar-027', { room: 'none' });
  ok(m.out.selected === 'default-v2' && m.saved.room === 'default-v2' && m.saved.roomChoiceV2 === false, "0.2.7-profile sidecar boot (room 'none', no marker): migrates to default-v2 with roomChoiceV2:false", JSON.stringify({ out: m.out.selected, saved: m.saved, err: m.err }));
  const m2 = await sidecarBoot('sidecar-027', null);
  ok(m2.out.selected === 'default-v2' && m2.saved.room === 'default-v2' && m2.saved.roomChoiceV2 === false, 'relaunch of the migrated profile is stable (default-v2, roomChoiceV2:false)', JSON.stringify({ out: m2.out.selected, saved: m2.saved }));
  await sidecarBoot('sidecar-027', null, async (call) => { await call('rooms.select', ['none']); });
  ok(readSaved('sidecar-027').room === 'none' && readSaved('sidecar-027').roomChoiceV2 === true, "later explicit 'none' via rooms.select writes room 'none' + roomChoiceV2:true", JSON.stringify(readSaved('sidecar-027')));
  const m3 = await sidecarBoot('sidecar-027', null);
  ok(m3.out.selected === 'none' && m3.saved.room === 'none', "explicit 'none' is kept across a relaunch (never re-migrated)", JSON.stringify({ out: m3.out.selected, saved: m3.saved }));
} catch (e) { ok(false, 'sidecar boot cases', String(e)); }

// ---- room v1 "Zumi's Office" removed (owner rejected it as below standard, 2026-10-26): never listed, never served,
// a saved v1 choice lands on default-v2 (Night City). The v1 source is a generated minimal glb that room-check accepts,
// offered through every old v1 seam (env, settings.roomDefaultPath, dirs.roomDefault, roomDefaultFallback).
{
  const glb = () => { const json = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, scenes: [{ nodes: [] }], scene: 0 })); const padded = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]); const head = Buffer.alloc(20); head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(20 + padded.length, 8); head.writeUInt32LE(padded.length, 12); head.writeUInt32LE(0x4e4f534a, 16); return Buffer.concat([head, padded]); };
  const SRC = path.join(TMP, 'v1-source.glb'); fs.writeFileSync(SRC, glb());
  const savedEnv = process.env.ZUMI_ROOM_DEFAULT_PATH; process.env.ZUMI_ROOM_DEFAULT_PATH = SRC;
  try {
    for (const [name, initial] of [['fresh', {}], ['saved v1', { room: 'default', roomChoiceV2: true }], ['saved v1, pre-0.2.8 marker', { room: 'default' }]]) {
      const dir = path.join(TMP, `v1-gone-${name.replace(/\W+/g, '-')}`);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'settings.json');
      fs.writeFileSync(file, JSON.stringify({ ...initial, roomDefaultPath: SRC }));
      const get = () => JSON.parse(fs.readFileSync(file, 'utf8'));
      const set = (pt) => fs.writeFileSync(file, JSON.stringify({ ...get(), ...pt }));
      const boot = createBootReads({ dataDir: dir, settings: get, saveSettings: set, dirs: { roomDefault: SRC }, roomDefaultFallback: SRC });
      const res = await boot.listRooms();
      ok(!res.rooms.some((r) => r.id === 'default' || r.source === 'default'), `rooms.list has no v1 'default' room (${name})`, JSON.stringify(res.rooms.map((r) => r.id)));
      ok(res.selected === 'default-v2' && get().room === 'default-v2', `${name}: the selected room is default-v2 (Night City) and settings.room is rewritten to it`, JSON.stringify({ sel: res.selected, saved: get().room }));
      ok(boot.resolveAsset('rooms/default/room.glb') === null && boot.resolveAsset('rooms/default/room.json') === null, `${name}: rooms/default/* is never served`);
      ok(!fs.existsSync(path.join(dir, 'rooms', 'default')), `${name}: no v1 copy is made under the data dir`);
    }
  } finally { if (savedEnv === undefined) delete process.env.ZUMI_ROOM_DEFAULT_PATH; else process.env.ZUMI_ROOM_DEFAULT_PATH = savedEnv; }
  const mainSrc = fs.readFileSync(path.join(ROOT, 'tauri', 'sidecar', 'main.mjs'), 'utf8');
  const adaptersSrc = fs.readFileSync(path.join(ROOT, 'tauri', 'sidecar', 'adapters.mjs'), 'utf8');
  ok(!/roomV1DefaultPath|roomDefaultFallback/.test(mainSrc) && !/export function roomV1DefaultPath/.test(adaptersSrc), 'the sidecar wires no v1 room source (roomV1DefaultPath / roomDefaultFallback gone)');
  ok(!fs.existsSync(path.join(ROOT, 'resources-pinned', 'room-v1')), 'resources-pinned/room-v1 is deleted from the repo');
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
