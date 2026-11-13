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

// ---------- roomBuiltIn: the Marketplace's "Built-in" answer for a room pack is the loaders' own "the build's copy wins" ----------
// (update smoke 0.3.4 -> 0.3.5, shot 05: the old install's resources-pinned/room-v2 and rooms-video/*.mp4 stay and are in use,
// yet every room read Install.)
{
  const manifest = JSON.parse(fs.readFileSync(path.join(repo, 'assets', 'rooms-video', 'rooms.json'), 'utf8'));
  const video = Buffer.from('built-in video bytes');
  const m = manifest.rooms.find((r) => r.id === 'cozy-study'); Object.assign(m, { bytes: video.length, sha256: sha(video) });
  const manifestDir = fresh('m'); fs.writeFileSync(path.join(manifestDir, 'rooms.json'), JSON.stringify(manifest));
  const envV = process.env.ZUMI_ROOMS_VIDEO_DIR, envR = process.env.ZUMI_ROOM_V2_DEFAULT_PATH;
  const boot = (d) => { const s = settingsAt(d); return createBootReads({ dataDir: d, settings: s.get, saveSettings: s.set, dirs: { scenesManifest: path.join(manifestDir, 'rooms.json') } }); };
  // upgraded 0.3.4 layout: the build's own copies are on disk, no pack
  const own = fresh('own'); fs.writeFileSync(path.join(own, m.file), video);
  process.env.ZUMI_ROOMS_VIDEO_DIR = own;
  process.env.ZUMI_ROOM_V2_DEFAULT_PATH = path.join(pinnedRoom, 'room.json');
  const up = boot(fresh('d'));
  ok(typeof up.roomBuiltIn === 'function' && up.roomBuiltIn('room.cozy-study') === true, 'upgraded install: a video room in the build folder is built-in');
  ok(typeof up.roomBuiltIn === 'function' && up.roomBuiltIn(NIGHT_CITY_PACK) === fs.existsSync(path.join(pinnedRoom, 'room.json')), 'upgraded install: Night City from resources-pinned is built-in');
  ok(typeof up.roomBuiltIn === 'function' && up.roomBuiltIn('room.beach-cabin') === false, 'a room whose video is not in the build folder is not built-in');
  ok(typeof up.roomBuiltIn === 'function' && up.roomBuiltIn('voice.kokoro-82m') === false && up.roomBuiltIn('room.nope') === false, 'not a room / unknown room: not built-in');
  fs.writeFileSync(path.join(own, m.file), Buffer.concat([video, Buffer.from('x')]));
  ok(typeof up.roomBuiltIn === 'function' && boot(fresh('d')).roomBuiltIn('room.cozy-study') === false, 'a build copy that fails the pin is not built-in');
  // fresh slim install: nothing in the build; a pack alone is installed, not built-in
  process.env.ZUMI_ROOMS_VIDEO_DIR = fresh('novideo');
  process.env.ZUMI_ROOM_V2_DEFAULT_PATH = path.join(fresh('nobuild'), 'room.json');
  const d = fresh('d'); const slim = boot(d);
  ok(typeof slim.roomBuiltIn === 'function' && !slim.roomBuiltIn('room.cozy-study') && !slim.roomBuiltIn(NIGHT_CITY_PACK), 'fresh slim install: nothing is built-in');
  const pd = path.join(d, 'packs', 'room.cozy-study'); fs.mkdirSync(pd, { recursive: true });
  fs.writeFileSync(path.join(pd, 'zumi-pack.json'), '{}'); fs.writeFileSync(path.join(pd, m.file), video); nightCityPack(d);
  const packed = boot(d);
  ok(typeof packed.roomBuiltIn === 'function' && !packed.roomBuiltIn('room.cozy-study') && !packed.roomBuiltIn(NIGHT_CITY_PACK), 'packs installed: they are packs, not built-in (Remove stays possible)');
  if (envV === undefined) delete process.env.ZUMI_ROOMS_VIDEO_DIR; else process.env.ZUMI_ROOMS_VIDEO_DIR = envV;
  if (envR === undefined) delete process.env.ZUMI_ROOM_V2_DEFAULT_PATH; else process.env.ZUMI_ROOM_V2_DEFAULT_PATH = envR;
}

// ---------- Night City is built-in only when the old copy is usable (Opus review 13-11: an existing room.json was enough) ----------
// Usable = the room check passes, the model and every plate it names are there, and where a PIN-MANIFEST.json sits beside it
// (owner builds; the official build drops it) every pinned file has its sha256. Unusable -> the pack is offered and served.
if (fs.existsSync(path.join(pinnedRoom, 'room.json'))) {
  const envR = process.env.ZUMI_ROOM_V2_DEFAULT_PATH;
  const oldCopy = ({ manifest = true, mutate = () => {} } = {}) => {
    const dir = fresh('old'); fs.cpSync(pinnedRoom, dir, { recursive: true });
    if (!manifest) fs.rmSync(path.join(dir, 'PIN-MANIFEST.json'));
    mutate(dir);
    return path.join(dir, 'room.json');
  };
  const j = JSON.parse(fs.readFileSync(path.join(pinnedRoom, 'room.json'), 'utf8'));
  const plate = Object.values(j.views)[0].plate;
  const cases = [
    ['good old copy with its pin', oldCopy(), true],
    ['good old copy, official layout (no PIN-MANIFEST)', oldCopy({ manifest: false }), true],
    ['garbage room.json', oldCopy({ manifest: false, mutate: (d) => fs.writeFileSync(path.join(d, 'room.json'), '{ not a room') }), false],
    ['a plate it names is missing', oldCopy({ manifest: false, mutate: (d) => fs.rmSync(path.join(d, plate)) }), false],
    ['a pinned plate with the wrong sha256 (same size)', oldCopy({ mutate: (d) => { const f = path.join(d, plate); const b = fs.readFileSync(f); b[b.length - 1] ^= 0xff; fs.writeFileSync(f, b); } }), false],
    // Opus R2: the official build has no PIN-MANIFEST, so the app carries the official hashes itself (keyed by room.json's sha)
    ['official layout, a plate truncated to half', oldCopy({ manifest: false, mutate: (d) => { const f = path.join(d, plate); fs.writeFileSync(f, fs.readFileSync(f).subarray(0, Math.floor(fs.statSync(f).size / 2))); } }), false],
    ['official layout, a plate all zeros (same size)', oldCopy({ manifest: false, mutate: (d) => { const f = path.join(d, plate); fs.writeFileSync(f, Buffer.alloc(fs.statSync(f).size)); } }), false],
    ['official layout, a garbage occluders.glb', oldCopy({ manifest: false, mutate: (d) => fs.writeFileSync(path.join(d, j.model), 'garbage') }), false],
    // An unknown room.json (an owner dev room) keeps the structural rule: its plates are not the official bytes and need not be
    ['unknown room.json (dev room), a plate truncated', oldCopy({ manifest: false, mutate: (d) => { fs.writeFileSync(path.join(d, 'room.json'), JSON.stringify({ ...j, name: 'Dev room' }, null, 1)); const f = path.join(d, plate); fs.writeFileSync(f, fs.readFileSync(f).subarray(0, Math.floor(fs.statSync(f).size / 2))); } }), true],
  ];
  for (const [what, json, want] of cases) {
    process.env.ZUMI_ROOM_V2_DEFAULT_PATH = json;
    const d = fresh('d'); const s = settingsAt(d);
    const b = createBootReads({ dataDir: d, settings: s.get, saveSettings: s.set });
    ok(b.roomBuiltIn(NIGHT_CITY_PACK) === want, `Night City old copy: ${what} -> ${want ? 'Built-in' : 'Install'}`);
    const listed = (await b.listRooms()).rooms.some((r) => r.id === 'default-v2');
    ok(listed === want, `  and the loader agrees: Night City ${want ? 'is' : 'is not'} served from it`, String(listed));
    if (!want) {
      // Install over the broken old copy: the pack lands, the loader serves it, and it reads Installed (not Built-in)
      nightCityPack(d);
      const b2 = createBootReads({ dataDir: d, settings: s.get, saveSettings: s.set });
      const l = await b2.listRooms();
      const served = b2.servedRoomV2Json();
      ok(l.rooms.some((r) => r.id === 'default-v2') && served && sha(fs.readFileSync(served)) === sha(fs.readFileSync(path.join(pinnedRoom, 'room.json'))) && !b2.roomBuiltIn(NIGHT_CITY_PACK), `  pack installed over it: the pack's Night City is served`);
    }
  }
  if (envR === undefined) delete process.env.ZUMI_ROOM_V2_DEFAULT_PATH; else process.env.ZUMI_ROOM_V2_DEFAULT_PATH = envR;
  // The table the app carries is the pin: same names and sha256 as resources-pinned/room-v2/PIN-MANIFEST.json (= the 0.3.4 install)
  const { OFFICIAL_ROOM_V2 } = await import('../src/main/room-default-v2.mjs');
  const pins = JSON.parse(fs.readFileSync(path.join(pinnedRoom, 'PIN-MANIFEST.json'), 'utf8')).files;
  const want = Object.fromEntries(Object.entries(pins).map(([k, v]) => [k, v.sha256]));
  const have = OFFICIAL_ROOM_V2 && OFFICIAL_ROOM_V2[want['room.json']];
  ok(have && JSON.stringify(Object.entries(have).sort()) === JSON.stringify(Object.entries(want).sort()), 'the in-app official hash table equals PIN-MANIFEST.json (keyed by the official room.json sha)');
}

console.log(`check:room-packs: ${pass} passed, ${fail} failed`);
fs.rmSync(root, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
