// T-31 P1a sidecar — adapters that let Electron-free `src/main` logic run under the sidecar.
//
// Two jobs:
//   1. Path adaptation: the sidecar's writable root is the PREVIEW data dir the Rust host passes on
//      the command line (Tauri `app_data_dir()` for identifier "space.zumia.preview"). It is never
//      Electron's userData, and there is no fallback path if the host does not supply one.
//   2. Module loading: re-export the pure, Electron-free main-process modules the sidecar uses, so
//      the sidecar never imports Electron (app path is the only thing that had to move).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import providers from '../../src/main/providers.js'; // pure CJS table (BYOK providers) — no Electron
// Step 3 (boot path): the Electron-free modules the boot reads reuse UNCHANGED.
import modelsCore from '../../src/main/models-core.js'; // listModels, extracted from main.js for both hosts
import cloudModule from '../../src/main/cloud.js'; // talk.status (the same createCloud main.js builds)
import ttsSelect from '../../src/main/tts-select.js'; // talk.getVoicePrefs: the provider/lang/voice-config fields (0.2.5 talk-mode)
import { createSceneRooms } from '../../src/main/scene-rooms.mjs';
import { createChairs } from '../../src/main/chair3d.mjs';
import { createDefaultRoomV2Cache, defaultRoomV2Usable, ensureDefaultRoomV2Copy } from '../../src/main/room-default-v2.mjs';
import { resolveRoomLaunch, roomPickPatch } from '../../src/main/room-default.mjs';
// Step 4 (import / save-view): the room checker, unchanged (the same functions main.js loads dynamically).
import { checkRoomFile, checkRoomJsonFile, roomContentId } from '../../src/main/room-check.mjs';
// The three modules the guest methods reuse UNCHANGED (all Electron-free, so the sidecar can import
// them directly): the board server and the attach policy.
import { openLocalBoard } from '../../src/main/laneboard-host.mjs';
import { decideWebviewAttach } from '../../src/main/webview-policy.mjs';
// P1c3: off-origin guest links. The policy and its refusal log, both reused UNCHANGED (Electron-free).
import { decideExternalUrl } from '../../src/main/board-open.mjs';
import { appendRefusal } from '../../src/main/refusal-log.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, '..', '..');

export {
  providers, openLocalBoard, decideWebviewAttach, decideExternalUrl, appendRefusal,
  createSceneRooms, createChairs, createDefaultRoomV2Cache, defaultRoomV2Usable, ensureDefaultRoomV2Copy, resolveRoomLaunch, roomPickPatch,
  checkRoomFile, checkRoomJsonFile, roomContentId,
};
export const { createModels, isVrmFile } = modelsCore;
export const { createCloud } = cloudModule;
export const { voiceProviderPrefs } = ttsSelect;

/**
 * The origin the Tauri main webview serves the app from (Electron's `app://zumi/`). Windows WebView2 with
 * `useHttpsScheme` unset is http://tauri.localhost; scripts/check-tauri-boot.mjs pins this to the Rust guard's host.
 */
export const APP_ORIGIN = 'http://tauri.localhost';
const ELECTRON_APP_PREFIX = 'app://zumi/';

/**
 * Re-home every `app://zumi/<path>` string in a reply onto the Tauri origin. The shared Electron-free modules keep
 * building Electron's URLs; this is the one place they become servable (tauri/prep-ui.mjs lays the files out at
 * the same <path>). Returns a new value; everything that is not such a string is copied as is.
 */
export function appUrls(value) {
  if (typeof value === 'string') return value.startsWith(ELECTRON_APP_PREFIX) ? `${APP_ORIGIN}/${value.slice(ELECTRON_APP_PREFIX.length)}` : value;
  if (Array.isArray(value)) return value.map(appUrls);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, appUrls(v)]));
  return value;
}

/** Bundled models: assets/models (models.json + the .vrm files), same folder Electron reads from app.asar. */
export function modelsDir() { return path.join(repoRoot, 'assets', 'models'); }
/** Bundled animation clips: assets/clips (.vrma / .fbx). */
export function clipsDir() { return path.join(repoRoot, 'assets', 'clips'); }
export function roomsVideoManifestPath() { return path.join(repoRoot, 'assets', 'rooms-video', 'rooms.json'); }
/**
 * Folder holding the room .mp4 files (scene-rooms.mjs verifies every file against rooms.json size + sha256).
 * ZUMI_ROOMS_VIDEO_DIR is the dev override; a packaged owner build has them at <resources>/<packagedDir> (the sidecar gets
 * `process.resourcesPath` from the host's --resources-dir); the public build stages none, so its list stays empty.
 * Electron's third source (manifest.localDir, a dev-PC path) is deliberately not used.
 */
export function roomsVideoDir(manifest, { env = process.env, resourcesPath = process.resourcesPath } = {}) {
  if (env.ZUMI_ROOMS_VIDEO_DIR) return path.resolve(env.ZUMI_ROOMS_VIDEO_DIR);
  const dir = manifest && manifest.packagedDir;
  if (!resourcesPath || typeof dir !== 'string' || !/^[\w-]+$/.test(dir)) return null;
  return path.join(resourcesPath, dir);
}
export function chairsManifestPath() { return path.join(repoRoot, 'assets', 'chair3d', 'chairs.json'); }

/**
 * The v2 default room source, mirroring main.js roomV2DefaultPath() for a PACKAGED build: env, then
 * settings.roomV2DefaultPath, then the pinned copy (resources-pinned/room-v2, the same bytes Electron's
 * extraResources ship). The dev-PC material-folder fallback is deliberately not used.
 */
export function roomV2DefaultPath(settings = {}) {
  if (process.env.ZUMI_ROOM_V2_DEFAULT_PATH) return path.resolve(process.env.ZUMI_ROOM_V2_DEFAULT_PATH);
  if (settings.roomV2DefaultPath) return path.resolve(settings.roomV2DefaultPath);
  return path.join(repoRoot, 'resources-pinned', 'room-v2', 'room.json');
}

/** The pinned Laneboard core bundled in this repo. */
export function laneboardDir() {
  return path.join(repoRoot, 'vendor', 'laneboard');
}

/** The first-run sample board Laneboard seeds an empty board with. */
export function boardSamplePath() {
  return path.join(repoRoot, 'src', 'main', 'sample-board.json');
}

/** The board's data root: <dataDir>/board-data ONLY — never Electron's userData, never Zumi-data. */
export function boardDataRoot(dataDir) {
  return path.join(dataDir, 'board-data');
}

/** The pinned Laneboard commit, for the response's `laneboard` field (main.js:579). */
export function laneboardVersion() {
  try { return fs.readFileSync(path.join(laneboardDir(), 'VERSION'), 'utf8').trim(); } catch { return null; }
}


/** The application version the preview reports. Source of truth: the repo's package.json. */
export function appVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** The one settings file the sidecar owns, inside the preview data dir. */
export function settingsPath(dataDir) {
  return path.join(dataDir, 'settings.json');
}

/** Read settings; unreadable/missing/invalid JSON is an empty object (same as main.js loadSettings). */
export function readSettings(dataDir) {
  try {
    const s = JSON.parse(fs.readFileSync(settingsPath(dataDir), 'utf8'));
    return s && typeof s === 'object' ? s : {};
  } catch {
    return {};
  }
}

/** Merge-patch write via a temp file + rename, mirroring src/main/main.js saveSettings(). */
export function saveSettings(dataDir, patch) {
  const next = { ...readSettings(dataDir), ...patch };
  fs.mkdirSync(dataDir, { recursive: true });
  const file = settingsPath(dataDir);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, file);
  return next;
}
