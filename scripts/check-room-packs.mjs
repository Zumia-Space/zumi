// check:room-packs (T-31-ROOM-slim). Rooms that arrive as Marketplace packs light up through the same loaders the bundled rooms
// use: the painted default room (Night City, pack room.night-city) is copied by sha into <data>/rooms/default-v2 and listed;
// a video room's mp4 inside <data>/packs/room.<id> is listed and served under the same rooms.json pin; an older install that
// still holds its own copies keeps them (no download); a removed pack takes its room with it. No network.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBootReads } from '../tauri/sidecar/boot-reads.mjs';
import { NIGHT_CITY_PACK, installedPackDir } from '../tauri/sidecar/room-packs.mjs';
import { createSceneRooms } from '../src/main/scene-rooms.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, name, detail = '') => { if (c) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${detail ? `  ${detail}` : ''}`); } };
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zumi-room-packs-'));
let n = 0;
const fresh = (t) => { const d = path.join(root, `${t}${++n}`); fs.mkdirSync(d, { recursive: true }); return d; };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function settingsAt(dir) {
  const file = path.join(dir, 'settings.json');
  const get = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
  return { get, set: (p) => fs.writeFileSync(file, JSON.stringify({ ...get(), ...p })) };
}
const pinnedRoom = path.join(repo, 'resources-pinned', 'room-v2');
function nightCityPack(dataDir) {
  const dir = path.join(dataDir, 'packs', NIGHT_CITY_PACK);
  fs.mkdirSync(dir, { recursive: true });
  const j = JSON.parse(fs.readFileSync(path.join(pinnedRoom, 'room.json'), 'utf8'));
  for (const f of ['room.json', j.model, ...Object.values(j.views).map((v) => v.plate)]) fs.copyFileSync(path.join(pinnedRoom, f), path.join(dir, f));
  fs.writeFileSync(path.join(dir, 'zumi-pack.json'), '{}');
  return dir;
}

// ---------- installedPackDir ----------
{
  const d = fresh('d');
  ok(installedPackDir(d, NIGHT_CITY_PACK) === null, 'no pack: no folder');
  const dir = nightCityPack(d);
  ok(installedPackDir(d, NIGHT_CITY_PACK) === dir, 'an installed pack is its folder');
  fs.writeFileSync(path.join(d, 'packs', `${NIGHT_CITY_PACK}.remove-pending`), '');
  ok(installedPackDir(d, NIGHT_CITY_PACK) === null, 'a pack waiting for removal is not used');
  ok(installedPackDir(d, '../x') === null && installedPackDir(d, 'room.a/../../b') === null, 'an id with a path is refused');
}

// ---------- the painted default room from the pack (a fresh slim install, no pinned copy in the build) ----------
const env0 = process.env.ZUMI_ROOM_V2_DEFAULT_PATH;
if (fs.existsSync(path.join(pinnedRoom, 'room.json'))) {
  process.env.ZUMI_ROOM_V2_DEFAULT_PATH = path.join(fresh('nobuild'), 'room.json'); // what a slim build resolves to: absent
  {
    const d = fresh('d'); const s = settingsAt(d);
    const boot = () => createBootReads({ dataDir: d, settings: s.get, saveSettings: s.set });
    const before = await boot().listRooms();
    ok(!before.rooms.some((r) => r.id === 'default-v2'), 'slim build, no pack: Night City is not listed (no dead room)', JSON.stringify(before.rooms.map((r) => r.id)));
    nightCityPack(d);
    const after = await boot().listRooms();
    ok(after.rooms.some((r) => r.id === 'default-v2') && after.selected === 'default-v2', 'pack installed: Night City is listed and picked', JSON.stringify(after));
    const good = s.get().defaultRoomV2GoodSha;
    const copy = path.join(d, 'rooms', 'default-v2', good || 'x');
    const j = JSON.parse(fs.readFileSync(path.join(pinnedRoom, 'room.json'), 'utf8'));
    ok(/^[0-9a-f]{12}$/.test(good || '') && Object.values(j.views).every((v) => fs.existsSync(path.join(copy, v.plate))) && fs.existsSync(path.join(copy, j.model)), 'its validated copy holds room.json, every plate and the occluders (what the Rust route serves)');
    ok(sha(fs.readFileSync(path.join(copy, 'room.json'))) === sha(fs.readFileSync(path.join(pinnedRoom, 'room.json'))), 'the copy is byte-for-byte the pinned room');
    fs.rmSync(path.join(d, 'packs', NIGHT_CITY_PACK), { recursive: true });
    fs.rmSync(path.join(d, 'rooms', 'default-v2'), { recursive: true });
    const gone = await boot().listRooms();
    ok(!gone.rooms.some((r) => r.id === 'default-v2'), 'pack removed and its copy gone: Night City is no longer listed', JSON.stringify(gone.rooms.map((r) => r.id)));
  }
  // ---------- an older install updated in place (its pinned copy is still on disk) needs no pack and no download ----------
  {
    const d = fresh('d'); const s = settingsAt(d);
    process.env.ZUMI_ROOM_V2_DEFAULT_PATH = path.join(pinnedRoom, 'room.json'); // the old install's resources-pinned, left by the updater
    const r = await createBootReads({ dataDir: d, settings: s.get, saveSettings: s.set }).listRooms();
    ok(r.rooms.some((x) => x.id === 'default-v2') && !fs.existsSync(path.join(d, 'packs')), 'updated 0.3.4 install: Night City from its own files, no pack folder made');
    // The pinned file then disappears (the user later uninstalls and reinstalls the slim build): the data copy keeps serving.
    process.env.ZUMI_ROOM_V2_DEFAULT_PATH = path.join(fresh('nobuild'), 'room.json');
    const r2 = await createBootReads({ dataDir: d, settings: s.get, saveSettings: s.set }).listRooms();
    ok(r2.rooms.some((x) => x.id === 'default-v2'), 'source gone, validated copy kept: Night City is still listed (the last good copy rule)');
  }
} else console.log('INFO no resources-pinned/room-v2 here: the painted-room rows did not run');
if (env0 === undefined) delete process.env.ZUMI_ROOM_V2_DEFAULT_PATH; else process.env.ZUMI_ROOM_V2_DEFAULT_PATH = env0;

// ---------- a video room from its pack, under the rooms.json pin ----------
{
  const manifestDir = fresh('m');
  const video = Buffer.from('fake mp4 bytes for the pin');
  const manifest = JSON.parse(fs.readFileSync(path.join(repo, 'assets', 'rooms-video', 'rooms.json'), 'utf8'));
  const room = manifest.rooms.find((r) => r.id === 'beach-cabin');
  Object.assign(room, { bytes: video.length, sha256: sha(video) });
  fs.writeFileSync(path.join(manifestDir, 'rooms.json'), JSON.stringify(manifest));
  const d = fresh('d'); const s = settingsAt(d);
  const packDir = path.join(d, 'packs', 'room.beach-cabin');
  const scenes = (videoDir) => createSceneRooms({ manifestPath: path.join(manifestDir, 'rooms.json'), resolveVideoDir: () => videoDir, packVideoDir: (id) => installedPackDir(d, `room.${id}`), settings: s });
  ok(scenes(null).list().rooms.length === 0, 'no build folder, no pack: no video room');
  fs.mkdirSync(packDir, { recursive: true });
  fs.writeFileSync(path.join(packDir, 'zumi-pack.json'), '{}');
  fs.writeFileSync(path.join(packDir, room.file), video);
  const l = scenes(null).list();
  ok(l.rooms.map((r) => r.id).join() === 'beach-cabin' && l.selected === 'beach-cabin', 'the pack video is listed and is the start room (rooms.json default)', JSON.stringify(l));
  ok(scenes(null).resolvePath('beach-cabin.mp4') === path.join(packDir, room.file), 'and resolves to the file in the pack');
  fs.writeFileSync(path.join(packDir, room.file), Buffer.concat([video, Buffer.from('x')]));
  ok(scenes(null).list().rooms.length === 0, 'a pack video that is not the pinned one is not listed');
  fs.writeFileSync(path.join(packDir, room.file), video);
  const own = fresh('own'); fs.writeFileSync(path.join(own, room.file), video);
  ok(scenes(own).resolvePath('beach-cabin.mp4') === path.join(own, room.file), "the build's own copy wins over the pack (an older install keeps its files)");
}
// ---------- resolveAsset hands the Rust route the pack video with the pack as its root ----------
{
  const d = fresh('d'); const s = settingsAt(d);
  const manifest = JSON.parse(fs.readFileSync(path.join(repo, 'assets', 'rooms-video', 'rooms.json'), 'utf8'));
  const video = Buffer.from('another fake video');
  const m = manifest.rooms.find((r) => r.id === 'zen-garden'); Object.assign(m, { bytes: video.length, sha256: sha(video) });
  const manifestDir = fresh('m'); fs.writeFileSync(path.join(manifestDir, 'rooms.json'), JSON.stringify(manifest));
  const packDir = path.join(d, 'packs', 'room.zen-garden'); fs.mkdirSync(packDir, { recursive: true });
  fs.writeFileSync(path.join(packDir, 'zumi-pack.json'), '{}'); fs.writeFileSync(path.join(packDir, m.file), video);
  const env1 = process.env.ZUMI_ROOMS_VIDEO_DIR; process.env.ZUMI_ROOMS_VIDEO_DIR = fresh('novideo');
  const boot = createBootReads({ dataDir: d, settings: s.get, saveSettings: s.set, dirs: { scenesManifest: path.join(manifestDir, 'rooms.json') } });
  const a = boot.resolveAsset('scenes/zen-garden.mp4');
  ok(a && a.path === path.join(packDir, m.file) && a.root === packDir, 'resolveAsset: the pack video, rooted at the pack folder', JSON.stringify(a));
  ok(boot.resolveAsset('scenes/beach-cabin.mp4') === null, 'resolveAsset: a room with neither copy is not served');
  if (env1 === undefined) delete process.env.ZUMI_ROOMS_VIDEO_DIR; else process.env.ZUMI_ROOMS_VIDEO_DIR = env1;
}

console.log(`check:room-packs: ${pass} passed, ${fail} failed`);
fs.rmSync(root, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
