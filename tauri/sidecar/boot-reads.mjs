// T-31 Tauri parity step 3 — the renderer's boot path, answered for real.
//
// Every method here is something src/renderer/app.js (or a module it inits) awaits or fires while booting
// (docs/migration/BOOT-TRACE-static.md lists them in order, with the Electron handler each one mirrors). Each is a
// reply from the SAME Electron-free module main.js uses, or a line-for-line copy of a one-line settings read, and
// returns Electron's shape. What it cannot do for real (keys, voice engines, HUD, board PIN) is
// NOT here: those names stay `not_implemented` until their own increment.
//
// URLs: the shared modules build Electron's `app://zumi/<path>` URLs; appUrls() re-homes them onto the Tauri origin
// (tauri/prep-ui.mjs lays the files out at the same <path>).
import fs from 'node:fs';
import path from 'node:path';

import {
  appUrls,
  chairsManifestPath,
  clipsDir,
  createChairs,
  createCloud,
  createDefaultRoomV2Cache,
  createModels,
  createSceneRooms,
  ensureDefaultRoomV2Copy,
  modelsDir,
  resolveRoomLaunch,
  roomsVideoManifestPath,
  roomsVideoDir,
  roomV2DefaultPath,
} from './adapters.mjs';
import { voicePrefsOf } from '../../src/main/talk-voice-core.mjs';
import { defaultSampleDetector } from './default-model-boot.mjs';
import { NIGHT_CITY_PACK, installedPackDir } from './room-packs.mjs';

// Imported rooms are keyed by roomContentId(): the first 12 hex chars of a sha256 (room-check.mjs).
export const ROOM_ID = /^[0-9a-f]{12}$/;

// Parity step 4b: MAX_ASSET_REL bounds the relative path the host may ask about. The exact room file names are in
// resolveAsset's regex: `room.glb` is the copy the importer wrote, `check.json` its checker report, and `room.json`
// the sidecar-manifest spelling a room folder may carry (a user room's manifest otherwise lives in settings).
const MAX_ASSET_REL = 256;
const isRegularFile = (p) => { try { return fs.lstatSync(p).isFile(); } catch { return false; } };

// main.js:354 roomEntry for a user room (the glb is always stored as <id>/room.glb; fileBase is the picked file's name).
function roomEntry(id, manifest, extra) {
  const base = extra.fileBase ? String(extra.fileBase).replace(/\.glb$/i, '') : 'room';
  return {
    id, source: 'user',
    label: (manifest && manifest.name) || base,
    author: (manifest && manifest.author) || null,
    license: (manifest && manifest.license) || null,
    attribution: (manifest && manifest.attribution) || null,
    hasManifest: Boolean(manifest),
    url: `app://zumi/rooms/${id}/room.glb`,
    ...extra,
  };
}

// `dirs` overrides the bundled-asset locations (tests point them at fixtures); the defaults are the repo's own.
// `testModelPath`: Electron's `--model` / ZUMI_TEST_MODEL slot (main.js:148), never persisted. Null unless the host was
// started with --model / ZUMI_TEST_MODEL (sidecar main.mjs parseTestModel).
// `isDefaultSample`: test seam for the VRoid-sample detector (VRoid terms 13(3)); production always uses the pinned one.
export function createBootReads({ dataDir, settings, saveSettings, log = () => {}, dirs = {}, testModelPath = null, ownerFlag = () => false, isDefaultSample = defaultSampleDetector.isDefaultSample }) {
  const where = {
    models: dirs.models || modelsDir(),
    clips: dirs.clips || clipsDir(),
    scenesManifest: dirs.scenesManifest || roomsVideoManifestPath(),
    chairsManifest: dirs.chairsManifest || chairsManifestPath(),
    roomV2Json: dirs.roomV2Json || null, // null = roomV2DefaultPath(settings)
  };
  const settingsStore = { get: settings, set: saveSettings };

  // --- models / clips (main.js listModels via models-core.js, :493 listClips) ---
  const models = createModels({ modelsDir: where.models, loadSettings: settings, getTestModelPath: () => testModelPath, isDefaultSample });
  const listModels = () => appUrls(models.listModels());

  function listClips() {
    const seen = new Map();
    let files = [];
    try { files = fs.readdirSync(where.clips); } catch { files = []; }
    for (const f of files) {
      const m = /^([\w.-]{1,64})\.(vrma|fbx)$/i.exec(f);
      if (m && !seen.has(m[1])) seen.set(m[1], { name: m[1], url: `app://zumi/clips/${encodeURIComponent(f)}` });
    }
    return appUrls([...seen.values()]);
  }

  // --- rooms (main.js:373 listRooms) ---
  // Room v1 "Zumi's Office" (the old v1 'default' room) is REMOVED: the owner rejected it as below standard (2026-10-26)
  // and asked that it never be picked up by mistake again. It is not listed, not served and not copied, whatever
  // ZUMI_ROOM_DEFAULT_PATH / settings.roomDefaultPath say; a saved room:'default' is not listed, so resolveRoomLaunch
  // lands it on default-v2 (Night City). User-imported rooms (step 4, library.mjs importRoomPath) are copied under
  // <data dir>/rooms/<sha12>/ and listed from settings.importedRooms exactly as main.js does. The v2 default room is
  // validated and copied by sha under the preview data dir (room-default-v2.mjs unchanged), and `room` resolves through
  // room-default.mjs resolveRoomLaunch (fresh profile -> default-v2).
  const roomV2Cache = createDefaultRoomV2Cache();
  const roomsStore = () => path.join(dataDir, 'rooms');
  const roomV2Dir = (sha) => path.join(roomsStore(), 'default-v2', sha);
  // T-31-ROOM-slim: the official installer no longer carries the painted default room; it is the Marketplace pack
  // room.night-city. The build's pinned copy still wins where it exists (owner builds, and an older install the updater
  // overwrote in place, which keeps its resources-pinned folder), so an update re-downloads nothing.
  const roomV2Source = () => {
    const pinned = where.roomV2Json || roomV2DefaultPath(settings());
    if (where.roomV2Json || fs.existsSync(pinned)) return pinned;
    const pack = installedPackDir(dataDir, NIGHT_CITY_PACK);
    return pack && fs.existsSync(path.join(pack, 'room.json')) ? path.join(pack, 'room.json') : pinned;
  };
  // The validated copy of the v2 default room that is actually served (and the only file saveView may write).
  function servedRoomV2Json() {
    const defV2 = ensureDefaultRoomV2Copy(roomV2Cache, roomV2Source(), roomV2Dir, settingsStore);
    return defV2.sha ? path.join(roomV2Dir(defV2.sha), 'room.json') : null;
  }
  async function listRooms() {
    const rooms = []; // main.js order: imported rooms, then the v2 default (room v1 removed)
    for (const r of Array.isArray(settings().importedRooms) ? settings().importedRooms : []) {
      if (!r || !ROOM_ID.test(r.id)) continue; // the id becomes a path segment: only a content id is ever used as one
      if (!fs.existsSync(path.join(roomsStore(), r.id, 'room.glb'))) continue; // removed by hand outside the app
      let check = null;
      try { check = JSON.parse(fs.readFileSync(path.join(roomsStore(), r.id, 'check.json'), 'utf8')); } catch { /* best-effort only */ }
      rooms.push(roomEntry(r.id, r.manifest, { warnings: (check && check.warnings) || [], stats: (check && check.stats) || null, fileBase: r.fileBase }));
    }
    const defV2 = ensureDefaultRoomV2Copy(roomV2Cache, roomV2Source(), roomV2Dir, settingsStore);
    // Listed only while its validated copy is on disk: a removed pack (copy deleted) must not leave a room that 404s.
    if (defV2.sha && fs.existsSync(path.join(roomV2Dir(defV2.sha), 'room.json'))) {
      let name = 'Camera-modes stand-in';
      try { name = JSON.parse(fs.readFileSync(path.join(roomV2Dir(defV2.sha), 'room.json'), 'utf8')).name || name; } catch { /* keep the fallback label */ }
      rooms.push({ id: 'default-v2', source: 'default-v2', schemaVersion: 2, label: name, hasManifest: true, url: 'app://zumi/rooms/default-v2/room.json', warnings: defV2.cacheHit ? [] : [], stats: null });
    }
    // first-run auto-select + one-time 0.2.7 'none' migration; patch carries the roomChoiceV2 marker (main.js listRooms)
    const { selected, patch } = resolveRoomLaunch(settings(), rooms);
    if (patch) saveSettings(patch);
    return appUrls({ rooms, selected }); // Electron's shape (main.js listRooms; defaultRoomIssue went with room v1)
  }

  // --- video rooms / 3D chairs (main.js:771, :775; the modules are unchanged) ---
  // Video rooms need the videos folder: ZUMI_ROOMS_VIDEO_DIR (dev override), else <resources>/rooms-video in a packaged owner
  // build (roomsVideoDir). The public build stages none, so no folder -> no video rooms listed, exactly Electron's release answer.
  // The folder is resolved once, by the same call scene-rooms verifies against; resolveAsset serves from that same folder.
  let sceneVideoDir = null;
  const sceneRooms = createSceneRooms({
    manifestPath: where.scenesManifest,
    resolveVideoDir: (manifest) => (sceneVideoDir = roomsVideoDir(manifest)),
    packVideoDir: (id) => installedPackDir(dataDir, `room.${id}`),
    settings: settingsStore,
    log: (m) => log(`[scenes] ${m}`),
  });
  const chairs3d = createChairs({ manifestPath: where.chairsManifest, settings: settingsStore, log: (m) => log(`[chair3d] ${m}`) });

  // --- talk.status (main.js:933) ---
  // Electron: a stored chat key (chatBrain.hasKey()) wins, else cloud.status(). The preview has no key store until
  // steps 5/6, so no key can exist and the cloud answer is the whole answer: createCloud with no talk server, the
  // release build's config (package.json has no zumiCloud.base). Step 6 puts the chat-brain branch in front.
  const cloud = createCloud({ mode: 'auto', base: null, log: (m) => log(`[talk] ${m}`) });

  // --- voice prefs reads (main.js:1220-1229) ---
  // Step 8b: the same core function Electron uses (talk-voice-core.mjs voicePrefsOf), with the preview's owner flag
  // (owner-voice.json in the data dir only) supplied by main.mjs.
  const voicePrefs = () => voicePrefsOf(settings(), ownerFlag() === true);

  // --- look tuning (main.js:859-870): <data dir>/look-tuning.json, never the shipped room files ---
  const lookTuningPath = () => path.join(dataDir, 'look-tuning.json');

  // --- gesture cache (main.js:1510-1535): <data dir>/gesture-cache/cache.json ---
  const gcacheFile = () => path.join(dataDir, 'gesture-cache', 'cache.json');

  // --- asset route answers (parity step 4b) ---
  // `__host.resolveAsset(rel)` -> { path, root } | null. ONLY the exact relative paths the main webview may fetch,
  // resolved from the settings THIS sidecar owns (models-core externalPaths, settings.importedRooms,
  // sceneRooms.resolvePath). The Rust host re-checks every answer (asset_route.rs) and streams the file itself; this
  // function never serves bytes and is host-only (not in the inventory, so the renderer's rpc cannot reach it).
  // `root` is the directory the answer must be a direct child of: null for the external slot, which Rust checks
  // against settings.userModelPath instead.
  function resolveAsset(rel) {
    if (typeof rel !== 'string' || rel.length === 0 || rel.length > MAX_ASSET_REL) return null;
    if (rel === 'external/user.vrm') {
      const p = models.externalPaths().user; // absolute, existing, regular .vrm from settings.userModelPath
      return p && isRegularFile(p) ? { path: p, root: null } : null;
    }
    const room = /^rooms\/([0-9a-f]{12})\/(room\.glb|check\.json|room\.json)$/.exec(rel);
    if (room) {
      const id = room[1];
      const imported = Array.isArray(settings().importedRooms) ? settings().importedRooms : [];
      // Settings is the source of truth: a file planted in the store for an id settings does not list is not served.
      if (!imported.some((r) => r && r.id === id)) return null;
      const store = roomsStore();
      const dir = path.join(store, id);
      let st;
      try { st = fs.lstatSync(dir); } catch { return null; }
      if (st.isSymbolicLink() || !st.isDirectory()) return null;
      const file = path.join(dir, room[2]);
      if (!isRegularFile(file)) return null;
      // The file must sit directly in the room's own folder: a link inside it cannot redirect the answer.
      try {
        if (path.dirname(fs.realpathSync.native(file)) !== fs.realpathSync.native(dir)) return null;
      } catch { return null; }
      return { path: file, root: store };
    }
    if (rel.startsWith('scenes/')) {
      const rest = rel.slice('scenes/'.length);
      // The same roots boot's sceneRooms was built on: the resolved video folder (env override, else <resources>/rooms-video) for an .mp4, the manifest's own folder
      // for the chair plate. resolvePath already size+sha256 checks a listed video.
      const file = sceneRooms.resolvePath(rest);
      // A video from a room pack sits in that pack's own folder (Rust derives the same root from the route id).
      const packRoot = rest !== 'chair' && file ? installedPackDir(dataDir, `room.${rest.replace(/\.mp4$/, '')}`) : null;
      const root = rest === 'chair'
        ? path.dirname(where.scenesManifest)
        : (file && packRoot && path.dirname(file) === packRoot ? packRoot : sceneVideoDir);
      if (!file || !root || !isRegularFile(file) || path.dirname(file) !== root) return null;
      return { path: file, root };
    }
    return null;
  }

  return {
    resolveAsset,
    listModels,
    listClips,
    listRooms,
    roomsStore,
    servedRoomV2Json,
    listScenes: () => appUrls(sceneRooms.list()),
    selectScene: (id) => appUrls(sceneRooms.select(String(id))),
    listChairs: () => appUrls(chairs3d.list()),
    selectChair: (id) => appUrls(chairs3d.select(String(id))),
    talkStatus: () => cloud.status(),
    getVoiceEnabled: () => settings().voiceEnabled !== false, // default ON
    getThinkSound: () => settings().thinkSound === true,
    getSpeakTypedWhenMicOff: () => settings().speakTypedWhenMicOff !== false,
    getVoicePrefs: voicePrefs,
    getSendClientNames: () => settings().sendClientNamesToAi === true,
    setSendClientNames: (on) => {
      const v = on === true;
      saveSettings({ sendClientNamesToAi: v });
      return v;
    },
    getLookTuning: () => {
      try { return JSON.parse(fs.readFileSync(lookTuningPath(), 'utf8')); } catch { return null; }
    },
    // The sidecar is a packaged build (info.packaged true), so Electron's `app.isPackaged === false ||` branch is gone.
    setLookTuning: (overrides) => {
      if (settings().developerMode !== true) return { error: 'dev_tools_off' };
      if (!overrides || typeof overrides !== 'object') return { error: 'bad_overrides' };
      try {
        fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(lookTuningPath(), JSON.stringify(overrides, null, 2));
        return { ok: true };
      } catch (e) { return { error: String((e && e.message) || e) }; }
    },
    gcacheLoad: () => {
      try { return fs.readFileSync(gcacheFile(), 'utf8'); } catch { return null; }
    },
    gcacheSave: (text) => {
      if (typeof text !== 'string' || text.length > 2_500_000) return false;
      const file = gcacheFile();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(`${file}.tmp`, text);
      fs.renameSync(`${file}.tmp`, file);
      return true;
    },
  };
}
