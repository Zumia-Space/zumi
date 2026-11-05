// T-31 Tauri parity step 4b-2 check: the sidecar's asset resolver answers exactly what the settings own.
// Plain Node: no Electron, no Tauri, no window, no network. Nothing is launched.
//
//   node scripts/check-tauri-asset-route.mjs
//
// `__host.resolveAsset(rel)` is one line over createBootReads().resolveAsset (tauri/sidecar/main.mjs:507). Its answer is
// a suggestion only — the Rust host re-checks it (asset_route.rs) — but the sidecar is where the settings live
// (models-core externalPaths, settings.importedRooms, sceneRooms.resolvePath), so this drives it with fixtures:
//   - an imported room in the store, a user-picked .vrm, a video scene and the chair plate, all named by settings;
//   - every wrong shape asks the same question and must answer null: the planted room of an id settings does not
//     list, a .vrm settings does not select, a tampered video, an absolute path, a traversal string.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { createBootReads } from '../tauri/sidecar/boot-reads.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BS = String.fromCharCode(92);
let pass = 0;
let fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${detail ? '  ' + detail : ''}`); } };
const norm = (v) => JSON.stringify(v, (_k, x) => (typeof x === 'string' ? x.split(BS).join('/') : x));
const same = (a, b) => norm(a) === norm(b);

const TMP_ROOT = path.join(ROOT, '.tauri-check-tmp');
fs.mkdirSync(TMP_ROOT, { recursive: true });
const tmp = fs.mkdtempSync(path.join(TMP_ROOT, 'asset-route-'));

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const put = (file, bytes) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file; };

// ---- fixtures: one room store, one picked avatar, one video scene ----
const dataDir = path.join(tmp, 'data');
const settingsFile = path.join(dataDir, 'settings.json');
const readSettings = () => { try { return JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch { return {}; } };
const writeSettings = (value) => { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(settingsFile, JSON.stringify(value)); };

const modelsDir = path.join(tmp, 'models');
put(path.join(modelsDir, 'models.json'), JSON.stringify({ models: [] }));
const pickedVrm = put(path.join(tmp, 'picked', 'user.vrm'), Buffer.from('glTF-avatar'));
const otherVrm = put(path.join(tmp, 'picked', 'other.vrm'), Buffer.from('another'));
const notVrm = put(path.join(tmp, 'picked', 'model.glb'), Buffer.from('glb'));
const fakeVrmDir = path.join(tmp, 'picked', 'folder.vrm');
fs.mkdirSync(fakeVrmDir, { recursive: true });

const ROOM = '0123456789ab';
const PLANTED = 'ba9876543210';
const store = path.join(dataDir, 'rooms');
const roomDir = path.join(store, ROOM);
const roomGlb = put(path.join(roomDir, 'room.glb'), Buffer.from('glTF-room'));
const roomCheck = put(path.join(roomDir, 'check.json'), JSON.stringify({ warnings: [], stats: {} }));
const roomJson = put(path.join(roomDir, 'room.json'), JSON.stringify({ name: 'Loft' }));
const plantedGlb = put(path.join(store, PLANTED, 'room.glb'), Buffer.from('planted'));

const videosDir = path.join(tmp, 'videos');
const videoBytes = Buffer.from('mp4-scene-bytes');
const videoFile = put(path.join(videosDir, 'loft.mp4'), videoBytes);
const plateBytes = Buffer.from('png-plate');
const manifestDir = path.join(tmp, 'assets', 'rooms-video');
const plateFile = put(path.join(manifestDir, 'chair-plate.png'), plateBytes);
const manifestFile = path.join(manifestDir, 'rooms.json');
const manifest = {
  version: 1,
  view: 'talk',
  plateSize: [1280, 720],
  videoSize: [1920, 1080],
  identity: [0.5, 0.5],
  pivot: [0, 0],
  packagedDir: 'rooms-video',
  chair: { file: path.basename(plateFile), x: 0.5, y: 0.5, sha256: sha256(plateBytes) },
  rooms: [{
    id: 'loft', label: 'Loft', file: 'loft.mp4', bytes: videoBytes.length, sha256: sha256(videoBytes), seconds: 8,
    framing: { scale: 1, offsetX: 0, offsetY: 0 }, status: 'ok',
  }],
};
fs.writeFileSync(manifestFile, JSON.stringify(manifest));

const baseSettings = { userModelPath: pickedVrm, importedRooms: [{ id: ROOM, manifest: { name: 'Loft' } }] };
writeSettings(baseSettings);

const savedVideoEnv = process.env.ZUMI_ROOMS_VIDEO_DIR;
process.env.ZUMI_ROOMS_VIDEO_DIR = videosDir;
const boot = createBootReads({
  dataDir,
  settings: readSettings,
  saveSettings: (patch) => writeSettings({ ...readSettings(), ...patch }),
  dirs: { models: modelsDir, scenesManifest: manifestFile },
});
const resolve = (rel) => boot.resolveAsset(rel);
const answer = (file, root = null) => ({ path: file, root });

try {
  // ---------------------------------------------------------------- the four shapes settings name
  ok(same(resolve('external/user.vrm'), answer(pickedVrm)), 'external/user.vrm -> the selected .vrm in settings (root null)');
  ok(same(resolve(`rooms/${ROOM}/room.glb`), answer(roomGlb, store)), 'rooms/<id>/room.glb -> the store file, root = the store');
  ok(same(resolve(`rooms/${ROOM}/check.json`), answer(roomCheck, store)), 'rooms/<id>/check.json -> the checker report');
  ok(same(resolve(`rooms/${ROOM}/room.json`), answer(roomJson, store)), 'rooms/<id>/room.json -> the sidecar manifest spelling');
  ok(same(resolve('scenes/loft.mp4'), answer(videoFile, videosDir)), 'scenes/<id>.mp4 -> the verified video, root = the video folder');
  ok(same(resolve('scenes/chair'), answer(plateFile, manifestDir)), 'scenes/chair -> the plate the manifest names, root = the manifest folder');
  ok(Object.keys(resolve('external/user.vrm')).join() === 'path,root', 'the answer is { path, root } and never bytes (Rust streams the file)');

  // ---------------------------------------------------------------- settings are the source of truth
  writeSettings({ ...baseSettings, userModelPath: otherVrm });
  ok(same(resolve('external/user.vrm'), answer(otherVrm)), 'a new pick answers the new .vrm, never the old one');
  for (const [name, value] of [['a missing .vrm', path.join(tmp, 'picked', 'gone.vrm')], ['a non-.vrm file', notVrm], ['a folder named .vrm', fakeVrmDir], ['no path at all', undefined]]) {
    writeSettings({ ...baseSettings, userModelPath: value });
    ok(resolve('external/user.vrm') === null, `${name} in settings answers null`);
  }
  writeSettings(baseSettings);

  ok(resolve(`rooms/${PLANTED}/room.glb`) === null, 'the planted room file of an id settings does not list answers null', JSON.stringify(resolve(`rooms/${PLANTED}/room.glb`)));
  ok(fs.existsSync(plantedGlb) && fs.existsSync(roomDir), 'sanity: both folders exist on disk (settings is what refuses the planted one)');

  // A room removed by hand: the settings row stays, the answer is null until the file is back.
  fs.renameSync(roomGlb, `${roomGlb}.away`);
  ok(resolve(`rooms/${ROOM}/room.glb`) === null, 'a listed room whose glb was removed answers null');
  fs.renameSync(`${roomGlb}.away`, roomGlb);
  ok(same(resolve(`rooms/${ROOM}/room.glb`), answer(roomGlb, store)), '...and answers again once the file is back');

  // A video the manifest no longer matches (one appended byte) is refused, not streamed.
  fs.appendFileSync(videoFile, Buffer.from('!'));
  ok(resolve('scenes/loft.mp4') === null, 'a tampered video (size/sha256 differs) answers null');
  fs.writeFileSync(videoFile, videoBytes);
  ok(same(resolve('scenes/loft.mp4'), answer(videoFile, videosDir)), '...and answers again once it matches the manifest again');

  // Default path (no env): a packaged owner build serves <resources>/<packagedDir>/<id>.mp4 (the 0.3.0-preview.3 404).
  {
    const resRoot = path.join(tmp, 'resources');
    const packedVideo = put(path.join(resRoot, 'rooms-video', 'loft.mp4'), videoBytes);
    const savedRes = process.resourcesPath;
    delete process.env.ZUMI_ROOMS_VIDEO_DIR; process.resourcesPath = resRoot;
    try {
      const bootDefault = createBootReads({ dataDir, settings: readSettings, saveSettings: () => {}, dirs: { models: modelsDir, scenesManifest: manifestFile } });
      ok(same(bootDefault.resolveAsset('scenes/loft.mp4'), answer(packedVideo, path.dirname(packedVideo))), 'env unset: scenes/<id>.mp4 resolves from <resources>/rooms-video');
      ok(bootDefault.resolveAsset('scenes/ghost.mp4') === null, 'env unset: an unlisted room still answers null');
      delete process.resourcesPath;
      const bootNone = createBootReads({ dataDir, settings: readSettings, saveSettings: () => {}, dirs: { models: modelsDir, scenesManifest: manifestFile } });
      ok(bootNone.resolveAsset('scenes/loft.mp4') === null, 'env unset and no resources dir: scenes/<id>.mp4 answers null');
    } finally {
      if (savedRes === undefined) delete process.resourcesPath; else process.resourcesPath = savedRes;
      process.env.ZUMI_ROOMS_VIDEO_DIR = videosDir;
    }
  }

  // ---------------------------------------------------------------- every wrong shape answers null
  const wrong = [
    '', ' ', '/', '..', '../', '../../windows/win.ini', './external/user.vrm', 'external/../user.vrm',
    'external/%2e%2e/user.vrm', 'external/user.vrm%00', 'external/USER.VRM', 'external/user.vrm/',
    'external/test.vrm', 'external/other.vrm', 'C:/Windows/win.ini', '/etc/passwd', 'rooms', 'rooms/',
    `rooms/${ROOM}/room.exe`, `rooms/${ROOM}/room.glb.bak`, `rooms/${ROOM}/sub/room.glb`,
    `rooms/${ROOM.toUpperCase()}/room.glb`, `rooms/${PLANTED}/room.glb`, 'rooms/default-v2/room.json',
    'scenes/ghost.mp4', 'scenes/chair.png', 'scenes/../chair', 'scenes/%2e%2e%2fchair', 'scenes/a/b.mp4',
    'scenes/Bad.mp4', 'scenes/loft.mp4/',
  ];
  const answered = wrong.filter((rel) => resolve(rel) !== null);
  ok(answered.length === 0, `every wrong shape answers null (${wrong.length} cases)`, answered.join(', '));
  ok(resolve(null) === null && resolve(7) === null && resolve({}) === null && resolve(undefined) === null, 'a non-string relative path answers null');
  ok(resolve('external/user.vrm' + 'x'.repeat(300)) === null, 'an over-long relative path answers null');

  // ---------------------------------------------------------------- the channel stays host-only
  const mainSrc = fs.readFileSync(path.join(ROOT, 'tauri', 'sidecar', 'main.mjs'), 'utf8');
  const inventory = fs.readFileSync(path.join(ROOT, 'docs', 'migration', 'api-inventory.json'), 'utf8');
  ok(/'__host\.resolveAsset': \(rel\) => boot\.resolveAsset\(rel\)/.test(mainSrc), 'main.mjs wires __host.resolveAsset to boot.resolveAsset');
  ok(!inventory.includes('__host.resolveAsset'), 'the resolver is not in the api inventory (the rpc gate never forwards it)');
  const shim = fs.readdirSync(path.join(ROOT, 'tauri', 'shim')).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(ROOT, 'tauri', 'shim', f), 'utf8')).join('\n');
  ok(!shim.includes('resolveAsset'), 'the shim never mentions the resolver (the renderer cannot call it)');

  // ---------------------------------------------------------------- Rust re-check, at the source (mutant A1)
  // A symlink or junction at the served name is NOT a regular file: the check must use lstat (symlink_metadata), which
  // never follows the link. `metadata` would follow it and serve the target. The runtime symlink case needs a Windows
  // account allowed to create one (Developer Mode; ZUMI_REQUIRE_LINKS=1 makes cargo test fail instead of SKIP); this
  // static assertion holds the code shape on every machine.
  const assetRs = fs.readFileSync(path.join(ROOT, 'tauri', 'src-tauri', 'src', 'asset_route.rs'), 'utf8');
  const regular = assetRs.match(/fn is_regular_file\(path: &Path\) -> bool \{([^}]*)\}/);
  ok(Boolean(regular) && /symlink_metadata\(path\)/.test(regular[1]), 'is_regular_file uses symlink_metadata (lstat), never metadata', regular ? regular[1].trim() : 'missing');
  ok(Boolean(regular) && !/fs::metadata\(/.test(regular[1]), 'is_regular_file never follows the link');
} finally {
  if (savedVideoEnv === undefined) delete process.env.ZUMI_ROOMS_VIDEO_DIR; else process.env.ZUMI_ROOMS_VIDEO_DIR = savedVideoEnv;
  fs.rmSync(tmp, { recursive: true, force: true });
}


// ---- host side (asset_route.rs `serve`): requests outside the route's namespaces cost nothing ----
// T-31 perf diag: ~100 small page requests used to resolve app_data_dir + scene roots (is_dir) before being classed Untouched.
{
  const src = fs.readFileSync(path.join(ROOT, 'tauri', 'src-tauri', 'src', 'asset_route.rs'), 'utf8').replace(/(^|\s)\/\/.*$/gm, '$1');
  const serve = src.slice(src.indexOf('pub fn serve('));
  const body = serve.slice(0, serve.indexOf('\n}\n'));
  const untouched = body.indexOf('Routed::Untouched');
  ok(untouched > 0 && untouched < body.indexOf('route_data_dir(') && untouched < body.indexOf('scene_roots('),
    'serve() returns for an untouched path BEFORE resolving the data dir and scene roots');
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
