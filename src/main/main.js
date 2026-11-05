'use strict';
// Zumi desktop — Electron main process.
// Serves the renderer over a private `app://` scheme (fetch() cannot read file:// URLs), resolves the avatar model from
// one setting (models manifest / a user-picked .vrm / a test-only --model), runs the user's own task board (the Laneboard
// core, vendor/laneboard) on 127.0.0.1 (the Board tab shows its page in a <webview>), keeps every session loopback-only,
// and runs `--selftest`.
const { app, BrowserWindow, ipcMain, protocol, shell, Menu, screen, dialog, session, safeStorage, clipboard, nativeImage, ClipboardItem, powerMonitor } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { createCloud } = require('./cloud.js');
const { defaultModelDirs, registerRestoreDefault, adoptDefaultIfNoModelKey, createDefaultSampleDetector } = require('./default-model.js');
const { createReflexJev } = require('./reflex-jev.js');
const { loadLocalReflexClassifier } = require('./reflex-jev-local.js');
const { createChatBrain } = require('./chat-brain.js');
const { createBrainKey } = require('./brain-key.js');
const { resolveRoles, setRoleChoice, resetRoleChoice, setRoleOn, WIRED_ROLES, withoutClaude } = require('./role-models.js');
const { PROVIDERS, isProviderId, selectableProvider, resolveProviderId, switchRoleSlots, isMode, resolveMode, effectiveLegacyDefaults, migrateOpencodeRoleModels } = require('./providers.js');
const { createLocalTts } = require('./local-tts.js');
const { createKokoroTts } = require('./kokoro-tts.js');
const { createEnTtsRouter } = require('./tts-router.js');
const { createLedaTts } = require('./leda-tts.js');
const { createHttpTts, ZUMIA_OWNER_URL, migrateLegacyCustomKey } = require('./tts-http.js');
const { createGeminiTts } = require('./tts-gemini.js');
const { createElevenTts } = require('./tts-elevenlabs.js');
const { voiceConfig, readOwnerVoiceFlag } = require('./tts-select.js');
// T-31 parity step 8b (freeze exception): the voice routing core, moved out of this file UNCHANGED in behaviour.
// main.js keeps the ipcMain handles + the sender check; the routing/prefs/guides live in the shared module so the
// Tauri sidecar runs exactly the same code (src/main/talk-voice-core.mjs).
const { createTalkVoiceCore, VOICE_SPEED } = require('./talk-voice-core.mjs');
const { appendUsage, aggregateUsage, localDate } = require('./usage-ledger.js');
const { withEstimatedCost } = require('./usage-cost.js');
const roomPathsMod = require('./room-paths.js');
const { ownerValue } = require('./owner-values.js');

const APP_ROOT = path.join(__dirname, '..', '..'); // resolves inside app.asar when packaged
const RENDERER_DIR = path.join(APP_ROOT, 'build', 'renderer');
const MODELS_DIR = path.join(APP_ROOT, 'assets', 'models');
const CLIPS_DIR = path.join(APP_ROOT, 'assets', 'clips');
const LANEBOARD_DIR = path.join(APP_ROOT, 'vendor', 'laneboard'); // pinned commit in vendor/laneboard/VERSION
const BOARD_HOST = path.join(__dirname, 'laneboard-host.mjs');
// Zumi's default room is room standard v2 (PLAN-camera-modes.md), "Night City". It is staged next to app.asar
// (extraResources resources-pinned/room-v2; sha256-pinned, re-hashed by the afterPack gate) and a packaged build resolves
// it through process.resourcesPath -- it never live-reads the room repo on D:. Dev runs (app.isPackaged false) keep the
// dev path. Precedence: ZUMI_ROOM_V2_DEFAULT_PATH env > settings.roomV2DefaultPath > staged copy (packaged) or dev path.
// The decision lives in room-paths.js so scripts/check-no-dev-paths.mjs runs the same code. Room v1 ("Zumi's Office",
// id 'default') was removed by owner decision 2026-10-26 (default-room-q): never listed, served or staged; a saved
// 'default' resolves to default-v2 (room-default.mjs).
function roomV2DefaultPath() {
  return roomPathsMod.roomV2DefaultPath({ env: process.env.ZUMI_ROOM_V2_DEFAULT_PATH, settingsPath: loadSettings().roomV2DefaultPath, isPackaged: app.isPackaged, resourcesPath: process.resourcesPath });
}
// A picked room's bytes are COPIED here (unlike the VRM model, which stays where the user put it): a copy survives
// the user deleting their Downloads folder, and the stored check.json keys the result by content hash. Same
// candidate order as gestureCacheFile()/boardDataDirFor() below (install-parent Zumi-data when packaged, else
// userData) -- small per-room data, same precedent as settings.json/gesture-cache already living there.
function roomsStoreDir() {
  if (runDir) return path.join(runDir, 'rooms');
  const candidates = [];
  if (app.isPackaged) candidates.push(path.join(path.dirname(path.dirname(process.execPath)), 'Zumi-data', 'rooms'));
  candidates.push(path.join(app.getPath('userData'), 'rooms'));
  return candidates.find(isWritableDir) || candidates[candidates.length - 1];
}
const BOARD_SAMPLE = path.join(__dirname, 'sample-board.json');
const CLOUD_FIXTURES = path.join(__dirname, 'cloud-fixtures.json'); // self-test answers for the talk path (no network)
// Talk server of this build flavour (packaged package.json `zumiCloud.base`, set by the builder config; release: none).
const CLOUD_BASE = (() => { try { const p = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')); return (p.zumiCloud && p.zumiCloud.base) || null; } catch { return null; } })();
// Same pattern as CLOUD_BASE: a test/selftest build's packaged package.json carries `zumiTest: true` (set by
// scripts/builder-selftest.cjs's extraMetadata, never present in the release config) — see board-live.mjs's
// isTestBuild/resolveBoardUpstream, which gate ZUMI_BOARD_UPSTREAM (test-only live-board egress override, L1).
const ZUMI_TEST_FLAG = (() => { try { const p = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')); return Boolean(p.zumiTest); } catch { return false; } })();
// Same pattern again: the owner's own internal build carries `zumiBoardMirror` (scripts/builder-selftest.cjs's
// extraMetadata, e.g. "http://127.0.0.1:3100") — the public build has no such field. board-reader.mjs's own
// loopback-http(s) allowlist check is the actual safety gate; this is just where the configured value comes from.
const BOARD_MIRROR = (() => { try { const p = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')); return typeof p.zumiBoardMirror === 'string' ? p.zumiBoardMirror : null; } catch { return null; } })();
// Persisted browser session for the board page, like a browser tab on the web board: its own storage (UI language and
// the switcher's choice, theme, drafts, the owner token it was handed) survives a restart. Together with a stable port
// (settings.boardPort) the origin stays the same, so that storage is found again. Board DATA still lives server-side.
const BOARD_PARTITION = 'persist:zumi-board';
// Live board webview (T-31 L1): no `persist:` prefix on purpose — Electron keeps a session without that prefix
// in memory only, cleared on quit. PLAN-live-board.md §5: live mode must leave no board session token on disk; the
// bridge never hands the page a secret anyway (board-bridge.mjs adds auth upstream, ignoring whatever the page
// sent), so this partition only ever holds harmless UI state, and in-memory means not even that survives a restart.
const BOARD_LIVE_PARTITION = 'zumi-board-live';
// Jev egress (packaged package.json `zumiReflexJev.egress`, set by the SELFTEST builder config only — the release
// build's package.json has no such field) or the test-only ZUMI_TEST_JEV env flag for plain `npm run selftest`/dev
// runs. The release build's main allowlist never includes openrouter.ai; this is the ONLY switch that can change that.
const REFLEX_JEV_EGRESS = (() => {
  // Forces egress off for one launch regardless of build config — used to produce a real "Jev unreachable"
  // measurement (no OS/network change, so it never touches anything another lane on a shared machine might need).
  if (process.env.ZUMI_TEST_JEV_OFFLINE === '1') return false;
  if (process.env.ZUMI_TEST_JEV === '1') return true;
  try { const p = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')); return Boolean(p.zumiReflexJev && p.zumiReflexJev.egress); } catch { return false; }
})();
// Test-time hard cap on real Jev calls, enforced in reflex-jev.js itself (ZUMI_TEST_JEV_CALL_LEDGER=<file>
// ZUMI_TEST_JEV_CALL_CAP=<n>). Unset in every normal run — no file, no cap, same as before this existed.
const REFLEX_JEV_CALL_LEDGER = process.env.ZUMI_TEST_JEV_CALL_LEDGER || null;
const REFLEX_JEV_CALL_CAP = Number(process.env.ZUMI_TEST_JEV_CALL_CAP || 0) || null;
// Owner-admin (T-31 owner-admin + usage, Fable ruling 05-10): same pattern as ZUMI_TEST_FLAG above — the owner's
// own internal build carries `zumiOwnerAdmin: true` (scripts/builder-selftest.cjs's extraMetadata). The release
// package.json has no such field, so a release build's chat daily cap is unchanged. No backend call, no other tier.
const OWNER_ADMIN = (() => { try { const p = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')); return Boolean(p.zumiOwnerAdmin); } catch { return false; } })();
// Next-UI host calls (T-31 3a-3, GATE-SEC C4): on only when THIS build was built with the next-version UI. The flag is a build artefact
// (scripts/build-renderer.mjs writes build/renderer/next-ui.json from the same resolution as __ZUMI_NEXT_UI__); a runtime env var
// cannot turn it on, and any doubt (missing or unreadable file) is off.
const NEXT_UI = (() => { try { return JSON.parse(fs.readFileSync(path.join(RENDERER_DIR, 'next-ui.json'), 'utf8')).nextUi === true; } catch { return false; } })();
// Disabled views (Thu 16:00 talk-QC build, CoS option C): same pattern as OWNER_ADMIN above -- a build-only
// metadata flag (scripts/builder-selftest.cjs's extraMetadata.zumiDisabledViews), read once at startup, never
// written back. The renderer (app.js) is the one that actually turns a view off (CameraDirector, the Settings
// dropdown, Ctrl+1/2/3); this just hands it the list via app:info. Release package.json has no such field, so a
// release build's view set is unchanged.
const DISABLED_VIEWS = (() => { try { const p = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')); return Array.isArray(p.zumiDisabledViews) ? p.zumiDisabledViews.filter((v) => typeof v === 'string') : []; } catch { return []; } })();
const SELFTEST_TIMEOUT_MS = 8 * 60 * 1000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

const selftestDir = argValue(process.argv, '--selftest', 'selftest-out');
// Demo run (P9, test-only): `--demo-script <lines.json> --demo-out <dir>` types each line into the composer like a user,
// with the LIVE talk server, and records captions, PNGs and the turn log in <dir>. `--demo-fixture` swaps in the
// recorded answers for a dry rehearsal (no network). The device token lives in --demo-userdata (default:
// <dir>\..\.demo-userdata), so it is imported once and reused across demo runs.
const demoScript = selftestDir ? null : argValue(process.argv, '--demo-script', null);
const demoDir = demoScript ? argValue(process.argv, '--demo-out', 'demo-out') : null;
const demoFixture = Boolean(demoScript && process.argv.includes('--demo-fixture'));
const demoStay = Boolean(demoScript && process.argv.includes('--demo-stay')); // leave the app open for the viewer after the run
// Jev-only demo (T-31 reflex measurement): types each line and records {reaction, source, ms, confidence} per
// line, with NO cloud talk requirement (no staging token needed) — see src/renderer/demo.js runDemoReflexOnly.
const demoReflexOnly = Boolean(demoScript && process.argv.includes('--demo-reflex-only'));
const demoAudio = demoScript ? argValue(process.argv, '--demo-audio', null) : null; // offline voice files for the fixture
const DEMO_FIXTURES = path.join(__dirname, 'demo-fixtures.json'); // recorded answers keyed to the demo lines
const runDir = selftestDir || demoDir; // where turn logs and captures of a test/demo run go
const extraClipsDir = argValue(process.argv, '--clips-dir', null); // optional, read-only, for testing clips without bundling
// Test-only model file (never bundled, never persisted): `--model <file.vrm>` or ZUMI_TEST_MODEL.
const testModelPath = argValue(process.argv, '--model', null) || (process.env.ZUMI_TEST_MODEL ? path.resolve(process.env.ZUMI_TEST_MODEL) : null);
// Room QC shots (T-31 R3): own --user-data-dir, window moved off-screen instead of hidden (a hidden/minimized window can
// get throttled or return blank frames; a window that IS shown, just at an off-desktop position, still composites real
// frames), the renderer drives itself -- src/renderer/shots/room.js. Mutually exclusive with the other run modes.
const roomShotsDir = (selftestDir || demoScript) ? null : argValue(process.argv, '--room-shots', null);
// Board-tab stress run (J-05 coordinator QC 03-10, GUEST_VIEW_MANAGER_CALL investigation): a "packaged-like" run
// (no --selftest sandbox, no test model) that opens the Board tab 20x -- switch to Zumi, back to Board, a reload in
// between -- and counts how many times a guest-view executeJavaScript call on the board webview throws. Isolates
// whether the crash is reachable from ordinary tab-switching/reload, or only from the selftest's own injection timing.
const boardStressDir = (selftestDir || demoScript || roomShotsDir) ? null : argValue(process.argv, '--board-stress', null);
// Off-screen selftest runs (T-31 R3 QC): same technique as --room-shots above (a window that IS shown, just
// moved off the visible desktop, still composites real frames -- a hidden/minimized window can be throttled or
// return blank captures), opted into explicitly so a normal `--selftest` run (shown on-screen) is unaffected.
// Demo runs take the same flag (T-31 MORNING-1010 real-provider smoke on the owner's PC: the run must never pop a
// window over his desktop or take focus).
const offscreen = Boolean((selftestDir || demoDir) && process.argv.includes('--offscreen'));
// Settings QC shots (T-31 board-roles): same shape as --room-shots (own userData, off-screen window, the renderer
// drives itself -- src/renderer/shots/settings-roles.js). The "Models by role" card reads a FIXTURE provider in this
// mode (role-models-fixtures.json), so the shots never need a real key or the network.
// Every Settings fixture (fake provider, fake key check, voice-model state, sample usage) is behind this one value,
// and it is null in an installed build whatever the command line says (app.isPackaged): shots run from a source tree.
const settingsShotsDir = (app.isPackaged || selftestDir || demoScript || roomShotsDir || boardStressDir) ? null : argValue(process.argv, '--settings-shots', null);
// Settings probe (scripts/check-settings-normal-launch.mjs): a NORMAL launch -- no fixture of any kind -- except that
// the window sits off-screen, userData is the caller's scratch folder, and the renderer reports what Settings shows,
// then quits. Proves a user build shows real or empty values. Source tree only, like the shots.
const settingsProbeDir = (app.isPackaged || selftestDir || demoScript || roomShotsDir || boardStressDir || settingsShotsDir) ? null : argValue(process.argv, '--settings-probe', null);
let mainWindow = null;

function argValue(argv, flag, fallback) {
  const i = argv.indexOf(flag);
  if (i === -1) return null;
  const next = argv[i + 1];
  const v = next && !next.startsWith('--') ? next : fallback;
  return v ? path.resolve(process.cwd(), v) : null;
}

if (demoDir) app.setPath('userData', argValue(process.argv, '--demo-userdata', null) || path.join(path.dirname(demoDir), '.demo-userdata'));
if (selftestDir) {
  // Test runs keep Chromium profile data next to their output instead of %APPDATA%.
  app.setPath('userData', path.join(selftestDir, '.userdata'));
  // Keep rendering while the window is covered/unfocused so captures are real frames.
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
}
if (roomShotsDir) {
  app.setPath('userData', path.join(roomShotsDir, 'ud'));
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
}
if (boardStressDir) {
  app.setPath('userData', path.join(boardStressDir, 'ud'));
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
}
if (settingsProbeDir) {
  app.setPath('userData', path.join(settingsProbeDir, 'ud'));
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
}
if (settingsShotsDir) {
  app.setPath('userData', path.join(settingsShotsDir, 'ud'));
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.vrm': 'model/gltf-binary',
  '.glb': 'model/gltf-binary',
  '.mp4': 'video/mp4', // video rooms (scene-rooms.mjs)
};

// ---------- settings (userData/settings.json): { model: <id> | 'user' | null, userModelPath, boardPort } ----------
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function loadSettings() {
  try { const s = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); return s && typeof s === 'object' ? s : {}; } catch { return {}; }
}
function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  const tmp = settingsFile() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, settingsFile());
  return next;
}

// ---------- AI provider (T-31 BYOK, owner decision 16-10) ----------
// The active chat provider id. T-31 fix r item 1: it is resolved ONCE at startup (pinAiProvider) and PERSISTED to
// settings.json, so it can no longer be re-derived from which key file happens to exist. Afterwards only an explicit
// user choice (Settings picker, ai:set-provider) changes it: clearing a key, or pasting an sk-or- key, changes the KEY
// (and its own provider's file) but never flips the active provider. One key file per provider, so switching never
// deletes another key.
function hasOpenRouterKey() { try { return fs.existsSync(path.join(app.getPath('userData'), 'jev-key.bin')); } catch { return false; } }
function aiProviderId() {
  const stored = loadSettings().aiProvider;
  return selectableProvider(stored, OWNER_ADMIN) ? stored : resolveProviderId(isProviderId(stored) ? null : stored, hasOpenRouterKey());
}
// Called once in app.whenReady, after the Jev import flow has run: freeze the migration-free resolution into settings
// (an existing OpenRouter user keeps OpenRouter; a key-less new user gets DEFAULT_PROVIDER and chooses from there).
// T-31 fix round 2: the SAME one-time pin decides whether this is a legacy (pre-BYOK) user -- one who already had a
// Jev/OpenRouter key at that moment -- and records it as `aiDefaultsLegacy`. A legacy user keeps the exact pre-BYOK
// default models; everyone else gets the provider table's free per-role defaults. Written once with aiProvider and
// never re-derived, so the decision can never flip afterwards (idempotent).
function pinAiProvider() {
  const s = loadSettings();
  if (isProviderId(s.aiProvider) && typeof s.aiDefaultsLegacy === 'boolean') return;
  saveSettings({ aiProvider: resolveProviderId(s.aiProvider, hasOpenRouterKey()), aiDefaultsLegacy: typeof s.aiDefaultsLegacy === 'boolean' ? s.aiDefaultsLegacy : hasOpenRouterKey() });
}
// True only for a pinned legacy (pre-BYOK) user; false for a new user and before the pin has run.
function aiDefaultsLegacy() { return loadSettings().aiDefaultsLegacy === true; }
// CORRECTION 17-10: a profile saved while OpenCode was listed as free can still carry a *-free role id, which is now
// refused (403) outside the OpenCode app. Rewrite those ids to the paid one once at startup (idempotent, OpenCode slots
// only). Pure rewriting lives in providers.js (behaviour-tested by check-byok).
function migrateOpencodeModels() {
  const s = loadSettings();
  const patch = {};
  if (s.aiProvider === 'opencode') {
    const live = migrateOpencodeRoleModels(s.roleModels);
    if (live !== s.roleModels) patch.roleModels = live;
  }
  const by = s.roleModelsByProvider;
  if (by && typeof by === 'object' && by.opencode) {
    const slot = migrateOpencodeRoleModels(by.opencode);
    if (slot !== by.opencode) patch.roleModelsByProvider = { ...by, opencode: slot };
  }
  if (Object.keys(patch).length) saveSettings(patch);
}
const aiProvider = () => PROVIDERS[aiProviderId()];
// T-31 OpenCode BYOK (owner 16-10): the / "Tự nhập khoá" choice in Settings > AI & Usage. It only
// groups the provider picker (free models first, annotated) -- it never changes chat routing or the active provider.
// The stored choice wins; absent, a NEW user starts on "free" and a pinned legacy (pre-BYOK) user keeps "byok"
// (today's view). aiProvider / aiDefaultsLegacy are untouched, so an existing user's provider never moves.
function aiMode() {
  return resolveMode(loadSettings().aiMode, aiDefaultsLegacy());
}
// T-31 fix round item 3: the paid, pre-BYOK legacy defaults apply ONLY in "Tự nhập khoá" (byok) mode. In
// "Dùng miễn phí" the free table ids are sent even for a legacy user, so the picker label ("OpenRouter free") matches
// the model actually sent. Pure resolution lives in providers.js (behaviour-tested by check-byok).
function aiLegacyDefaults() { return effectiveLegacyDefaults(aiDefaultsLegacy(), aiMode()); }

// ---------- models: one setting, three sources ----------
// 1. assets/models/models.json  { "models": [{ id, label, file, default }] }  (bundled; drop a final model in, no code change)
// 2. "Mở file VRM…": a local .vrm the user picked (path kept in settings.userModelPath)
// 3. --model / ZUMI_TEST_MODEL: test-only, not persisted
// The list logic is Electron-free and shared with the Tauri sidecar (models-core.js, T-31 Tauri parity step 3).
const { createModels } = require('./models-core.js');
// The bundled VRoid sample, by bytes (size + pinned sha256), cached: the model list labels it "Zumi default".
const defaultSampleDetector = createDefaultSampleDetector({ fs, crypto });
const { isVrmFile, readManifest, externalPaths, listModels } = createModels({ modelsDir: MODELS_DIR, loadSettings, getTestModelPath: () => testModelPath, isDefaultSample: (f) => defaultSampleDetector.isDefaultSample(f) });

// ---------- rooms: one setting, like models (PLAN-room.md §3 "Storage" / "UI") ----------
// Sidecar manifest: Vesta's own default room ships it as <basename>.json beside <basename>.glb (room.glb/room.json),
// which is the convention actually used on disk; <basename>.room.json is also accepted (the plan prose's literal
// spelling) so a user room named that way still gets its manifest.
function roomManifestPath(glbPath) {
  const a = glbPath.replace(/\.glb$/i, '.json');
  const b = glbPath.replace(/\.glb$/i, '.room.json');
  if (fs.existsSync(a)) return a;
  if (fs.existsSync(b)) return b;
  return null;
}
function readRoomManifest(glbPath) {
  const p = roomManifestPath(glbPath);
  if (!p) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    return raw && raw.format === 'zumi-room' ? raw : null;
  } catch { return null; }
}
function roomEntry(id, source, glbPath, manifest, extra = {}) {
  // Fallback name (no manifest): a user room's bytes are always stored as "<id>/room.glb" (PLAN §3 "Storage"), so
  // glbPath's own basename is always literally "room" -- extra.fileBase (the file the owner actually picked, e.g.
  // "my-living-room.glb") is what a reasonable fallback name means. Only the default room (no fileBase, a fixed
  // real path) falls back to glbPath's basename, and it always ships a manifest in practice.
  const base = extra.fileBase ? extra.fileBase.replace(/\.glb$/i, '') : path.basename(glbPath, '.glb');
  return {
    id, source,
    label: (manifest && manifest.name) || base,
    author: (manifest && manifest.author) || null,
    license: (manifest && manifest.license) || null,
    attribution: (manifest && manifest.attribution) || null,
    hasManifest: Boolean(manifest),
    url: `app://zumi/rooms/${id}/room.glb`,
    ...extra,
  };
}
// room standard v2's own validated-copy store: <roomsStoreDir>/default-v2/<sha>/{room.json, occluders.glb, plates/...}.
function defaultRoomV2Dir(sha) { return path.join(roomsStoreDir(), 'default-v2', sha); }
async function listRooms() {
  const rooms = [];
  const imported = loadSettings().importedRooms || [];
  for (const r of imported) {
    const glb = path.join(roomsStoreDir(), r.id, 'room.glb');
    if (!fs.existsSync(glb)) continue; // the folder was removed by hand outside the app; skip it silently
    let check = null;
    try { check = JSON.parse(fs.readFileSync(path.join(roomsStoreDir(), r.id, 'check.json'), 'utf8')); } catch { /* best-effort only */ }
    rooms.push(roomEntry(r.id, 'user', glb, r.manifest, { warnings: (check && check.warnings) || [], stats: (check && check.stats) || null, fileBase: r.fileBase }));
  }
  // room standard v2 (T-31 camera modes, coordinator final ruling 03-10): the default room (Night City); resolveRoomLaunchFn
  // below does the first-run auto-select. Served from a validated COPY ("copied by sha into Zumi-data, room-check
  // validated"), via room-default-v2.mjs.
  if (ensureDefaultRoomV2CopyFn) {
    const defV2 = await getDefaultRoomV2();
    if (defV2.sha) {
      const dir = defaultRoomV2Dir(defV2.sha);
      let name = 'Camera-modes stand-in';
      try { name = JSON.parse(fs.readFileSync(path.join(dir, 'room.json'), 'utf8')).name || name; } catch { /* keep the fallback label */ }
      rooms.push({ id: 'default-v2', source: 'default-v2', schemaVersion: 2, label: name, hasManifest: true, url: 'app://zumi/rooms/default-v2/room.json', warnings: defV2.cacheHit ? [] : [], stats: null });
    }
  }
  // resolveRoomLaunch: first-run auto-select + the one-time 0.2.7 'none' migration; patch carries the roomChoiceV2 marker.
  const { selected, patch } = resolveRoomLaunchFn(loadSettings(), rooms);
  if (patch) saveSettings(patch);
  return { rooms, selected };
}
// Shared by the real "Open room file…" dialog and the test-only selftest fixture opener below -- one path runs the
// checker and (on success) copies the file, so a test exercises exactly the same code a real import does.
function importRoomFile(absPath) {
  let check;
  try { check = checkRoomFileFn(absPath); } catch { return { error: { code: 'not_a_room_file', params: {} } }; }
  if (!check.ok) return { error: check.refused };
  const buf = fs.readFileSync(absPath);
  const id = roomContentIdFn(buf);
  const destDir = path.join(roomsStoreDir(), id);
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(path.join(destDir, 'room.glb'), buf);
  const manifest = readRoomManifest(absPath);
  fs.writeFileSync(path.join(destDir, 'check.json'), JSON.stringify({ warnings: check.warnings, stats: check.stats, importedAt: new Date().toISOString() }, null, 2));
  const imported = (loadSettings().importedRooms || []).filter((r) => r.id !== id);
  imported.push({ id, fileBase: path.basename(absPath), manifest });
  saveSettings({ importedRooms: imported, ...roomPickPatchFn(id) });
  return { ok: true, warnings: check.warnings };
}
function deleteRoom(id) {
  const settings = loadSettings();
  const imported = settings.importedRooms || [];
  if (!imported.some((r) => r.id === id)) return false; // only ever a user room — the default room is not removable
  fs.rmSync(path.join(roomsStoreDir(), id), { recursive: true, force: true });
  saveSettings({ importedRooms: imported.filter((r) => r.id !== id), room: settings.room === id ? 'none' : settings.room });
  return true;
}

async function resolveAppPath(urlStr) {
  const u = new URL(urlStr);
  let rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
  if (!rel) rel = 'index.html';
  const ext = /^external\/(user|test)\.vrm$/.exec(rel);
  if (ext) return externalPaths()[ext[1]];
  // Rooms (T-31 R3): app://zumi/rooms/<id>/room.glb|check.json -> the imported room's own store folder. Exact paths
  // only, same traversal posture as models/clips below (no directory listing, no arbitrary join).
  const roomUser = /^rooms\/([0-9a-f]{12})\/(room\.glb|check\.json)$/.exec(rel);
  if (roomUser) {
    const full = path.join(roomsStoreDir(), roomUser[1], roomUser[2]);
    return fs.existsSync(full) ? full : null;
  }
  // room standard v2: served from the app's OWN validated copy (coordinator final ruling, see room-default-v2.mjs's
  // header), never the live source directly -- room.json itself,
  // its plate images (whatever relative path room.json's own `views.<v>.plate` gives), and `model`
  // (occluders.glb). Same traversal guard as models/clips above: normalise, then require the result to stay
  // inside the copy's own dir.
  if (rel.startsWith('rooms/default-v2/') && ensureDefaultRoomV2CopyFn) {
    const defV2 = await getDefaultRoomV2();
    if (!defV2.sha) return null;
    const root = defaultRoomV2Dir(defV2.sha);
    const full = path.normalize(path.join(root, rel.slice('rooms/default-v2/'.length)));
    if (!full.startsWith(root + path.sep) && full !== root) return null; // blocks ../ traversal
    return fs.existsSync(full) ? full : null;
  }
  // Video rooms (T-31 room picker): app://zumi/scenes/<id>.mp4 | app://zumi/scenes/chair -- exact names only, resolved by
  // scene-rooms.mjs against its own manifest (a video is served only when its size + sha256 match).
  if (rel.startsWith('scenes/')) return sceneRooms ? sceneRooms.resolvePath(rel.slice('scenes/'.length)) : null;
  // 3D chair (T-31 chair3d): app://zumi/chair3d/<id>.glb | plate-nochair.png -- exact names only, size + sha256 checked by chair3d.mjs.
  if (rel.startsWith('chair3d/')) return chairs3d ? chairs3d.resolvePath(rel.slice('chair3d/'.length)) : null;
  // One design-token sheet for the whole app: served straight from the pinned Laneboard (vendor/), no copy, so the
  // app shell and the embedded board always read the same palette. app://zumi/tokens.css -> vendor/laneboard/public.
  if (rel === 'tokens.css') return path.join(LANEBOARD_DIR, 'public', 'tokens.css');
  let roots = [RENDERER_DIR];
  if (rel.startsWith('models/')) { roots = [MODELS_DIR]; rel = rel.slice('models/'.length); }
  else if (rel.startsWith('clips/')) { roots = [CLIPS_DIR, extraClipsDir].filter(Boolean); rel = rel.slice('clips/'.length); }
  for (const root of roots) {
    const full = path.normalize(path.join(root, rel));
    if (!full.startsWith(root + path.sep)) return null; // blocks ../ traversal
    if (roots.length === 1 || fs.existsSync(full)) return full;
  }
  return null;
}

function listClips() {
  const seen = new Map();
  for (const dir of [CLIPS_DIR, extraClipsDir].filter(Boolean)) {
    let files = [];
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      const m = /^([\w.-]{1,64})\.(vrma|fbx)$/i.exec(f);
      if (m && !seen.has(m[1])) seen.set(m[1], { name: m[1], url: `app://zumi/clips/${encodeURIComponent(f)}` });
    }
  }
  return [...seen.values()];
}

// ---------- local task board (Laneboard core, started on first open) ----------
// Data dir: a sibling folder of the install dir ("<parent>\Zumi-data") when writable — the NSIS uninstaller and updater
// delete everything inside the install dir, so data must not live in it — else userData\board-data. Dev runs use
// userData; self-tests use <selftest dir>\board-data so every test starts from a first run (or from the v0.2 board a
// test put there). Laneboard keeps its files in <data dir>\laneboard; a v0.2 board in <data dir> is imported once.
function isWritableDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.write-test-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch { return false; }
}
function boardDataDirFor({ forSelftest }) {
  if (forSelftest && selftestDir) return path.join(selftestDir, 'board-data');
  if (demoDir) return path.join(demoDir, 'board-data'); // every demo run starts from the first-run sample board
  const candidates = [];
  if (app.isPackaged) candidates.push(path.join(path.dirname(path.dirname(process.execPath)), 'Zumi-data'));
  candidates.push(path.join(app.getPath('userData'), 'board-data'));
  return candidates.find(isWritableDir) || candidates[candidates.length - 1];
}

let board = null;
let boardStarting = null;
let boardOutcome = null; // self-test only: what the last open did (seeded | migrated | opened | refused)
let boardLegacyBefore = null; // self-test only: the v0.2 board files as they were before the first open
const boardRequests = []; // self-test only: { method, path, status }
async function startBoard() {
  if (board) return board;
  if (!boardStarting) {
    boardStarting = (async () => {
      const { openLocalBoard, readLegacyTasks } = await import(pathToFileURL(BOARD_HOST).href);
      const root = boardDataDirFor({ forSelftest: true });
      if (selftestDir) boardLegacyBefore = { tasks: readLegacyTasks(root), files: hashFiles(root) };
      const onRequest = selftestDir ? (req, res) => res.on('finish', () => boardRequests.push({ method: req.method, path: req.url.split('?')[0], status: res.statusCode })) : null;
      // no forced language: the page starts in its own default (English, as on the web) and keeps the switcher's choice.
      // A normal run reuses its port (stable origin); self-test / demo runs take any free port.
      const wantPort = runDir ? 0 : Number(loadSettings().boardPort) || 0;
      const b = await openLocalBoard({ laneboardDir: LANEBOARD_DIR, root, sampleFixture: BOARD_SAMPLE, port: wantPort, onRequest });
      if (!runDir && b.port && b.port !== wantPort) saveSettings({ boardPort: b.port });
      // A refused v0.2 import is not cached: nothing was written, so the next open tries again.
      boardOutcome = b.outcome;
      if (b.outcome !== 'refused') board = b;
      return b;
    })().finally(() => { boardStarting = null; });
  }
  return boardStarting;
}
function hashFiles(dir) {
  const out = {};
  try {
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f);
      if (fs.statSync(full).isFile()) out[f] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    }
  } catch { /* no dir yet */ }
  return out;
}
const laneboardVersion = () => { try { return fs.readFileSync(path.join(LANEBOARD_DIR, 'VERSION'), 'utf8').trim(); } catch { return null; } };

// ---------- network: every session is loopback-only ----------
// The app needs no network: the stage is app:// and the board is 127.0.0.1. Any http(s)/ws(s) request to another host
// is cancelled, whatever asks for it. Self-tests log every request to prove it.
const netLog = [];
function guardSession(ses, label) {
  ses.webRequest.onBeforeRequest((details, cb) => {
    let u = null;
    try { u = new URL(details.url); } catch { /* unparsable -> not a network URL */ }
    const isNet = Boolean(u && /^(https?|wss?|ftp):$/.test(u.protocol));
    const remote = isNet && !LOOPBACK_HOSTS.has(u.hostname);
    if (runDir && isNet) netLog.push({ session: label, method: details.method, url: details.url.slice(0, 200), remote });
    cb({ cancel: remote });
  });
}

// The narrowest supported window; app:info exposes it so the Settings shots can verify layout at this size.
const MIN_WINDOW = { width: 900, height: 600 };
function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    useContentSize: true,
    minWidth: MIN_WINDOW.width,
    minHeight: MIN_WINDOW.height,
    title: 'Zumi',
    backgroundColor: '#0e1016',
    // buildres/ is the installer's resource dir, not bundled into app.asar; there the exe icon is used instead.
    icon: fs.existsSync(path.join(APP_ROOT, 'buildres', 'icon.png')) ? path.join(APP_ROOT, 'buildres', 'icon.png') : undefined,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      additionalArguments: NEXT_UI ? ['--zumi-next-ui=1'] : [], // the preload shows the three Brain keys only then (the host handlers are the real gate)
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
      // Always false (T-31 room-v2-load-hang investigation): Zumi is a companion window meant to keep rendering/
      // reacting while the owner works in another app on top of or alongside it -- the previous conditional only
      // disabled this for test/capture runs (selftest/room shots/board stress) and left it THROTTLED in
      // every real build, so Chromium could pause rAF/timers the instant the window lost focus or got covered.
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required', // Zumi's voice starts after an IPC round trip, not inside the key event
    },
  });
  // Shots: shown (not hidden) but moved off the visible desktop, so Chromium still composites real frames —
  // a hidden/minimized window can return blank captures. Never visible to the owner.
  if (roomShotsDir || boardStressDir || settingsShotsDir || settingsProbeDir || offscreen) win.once('ready-to-show', () => { win.setPosition(-32000, -32000); win.showInactive(); });
  else win.once('ready-to-show', () => { if (demoStay) win.maximize(); win.show(); });
  win.on('focus', () => win.webContents.send('window:focus', true));
  win.on('blur', () => win.webContents.send('window:focus', false));
  // Video rooms (T-31 room picker): the renderer pauses the room video while the window cannot be seen (battery).
  // backgroundThrottling is off for this window (see webPreferences above), so the page's own visibilitychange is not
  // relied on alone -- these are the window's own states.
  win.on('minimize', () => { windowVisible = false; win.webContents.send('window:visible', false); });
  win.on('hide', () => { windowVisible = false; win.webContents.send('window:visible', false); });
  win.on('restore', () => { windowVisible = true; win.webContents.send('window:visible', true); });
  win.on('show', () => { windowVisible = true; win.webContents.send('window:visible', true); });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('app://')) e.preventDefault(); });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12' && !app.isPackaged) win.webContents.toggleDevTools();
  });
  win.loadURL('app://zumi/index.html');
  return win;
}

// ---------- webview hardening (local + live board) ----------
// decideWebviewAttachFn: webview-policy.mjs's pure decision function, loaded in app.whenReady (ESM, dynamic import —
// see the laneboard-host.mjs/board-live.mjs pattern below). Until it resolves, every attach is refused (fail-closed):
// a webview cannot be requested before the renderer loads, and the renderer never loads before whenReady runs.
let decideWebviewAttachFn = null;
let decideBoardOpenFn = null; // board-open.mjs, loaded with webview-policy.mjs; until then no open request is honoured
let decideExternalUrlFn = null; // board-open.mjs too; until then no page link opens in the OS browser
let appendRefusalFn = null; // refusal-log.mjs, loaded with board-open.mjs
// Every refusal below also lands in <userData>/logs/board-open-refusals.log (reason + origin only, capped at 256 KB with
// one old copy; review v6 C1: a Start-menu launch has no console, so console.warn alone was not a durable log).
const logRefusal = (d) => {
  if (!appendRefusalFn) return;
  try { appendRefusalFn(path.join(app.getPath('userData'), 'logs'), d); } catch (e) { console.warn(`[board-open] refusal log write failed: ${e && e.code || e}`); }
};
let boardGuest = null;
let liveBridgeOrigin = null; // set once board:live-open hands out a port; cleared when live mode is left
const inBoard = (url) => Boolean((board && url.startsWith(board.origin + '/')) || (liveBridgeOrigin && url.startsWith(liveBridgeOrigin + '/')));
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (event, webPreferences, params) => {
    const decision = decideWebviewAttachFn
      ? decideWebviewAttachFn({ src: params.src, partition: params.partition, boardOrigin: board && board.origin, liveBridgeOrigin, boardPartition: BOARD_PARTITION, boardLivePartition: BOARD_LIVE_PARTITION })
      : { allow: false };
    // A guest NEVER gets a preload (the board's own or any other), Node, or an unsandboxed renderer.
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    if (!decision.allow) { event.preventDefault(); return; }
  });
  contents.on('did-attach-webview', (_ev, guest) => { boardGuest = guest; });
  if (contents.getType() === 'webview') {
    // Owner build: the live board asks to open a file on anh's PC or a loopback preview through /__zumi-open on its
    // own bridge origin (src/main/board-open.mjs decides; Sol gate SOL-BRIEF-openpath.md). Only THE board guest, only
    // the live bridge origin, only from a page on that origin; anything refused is logged and never opened. true =
    // handled (the page stays put). The request arrives as a new window (a chip is <a target="_blank">), which reaches
    // setWindowOpenHandler only because the board <webview> carries `allowpopups` (renderer app.js); every new window
    // is still denied below.
    const boardOpen = (url) => {
      if (!decideBoardOpenFn || !boardGuest || contents.id !== boardGuest.id) return false;
      const d = decideBoardOpenFn(url, { bridgeOrigin: liveBridgeOrigin, ownerAdmin: OWNER_ADMIN, openerUrl: contents.getURL() });
      if (d.action === 'none') return false;
      if (d.action === 'openPath') shell.openPath(d.path).then((err) => { if (err) console.warn(`[board-open] openPath failed: ${err}`); });
      else if (d.action === 'openExternal') shell.openExternal(d.url);
      else { console.warn(`[board-open] refused ${d.reason}${d.path ? ' ' + d.path : ''}${d.origin ? ' ' + d.origin : ''}${d.ext ? ' ' + d.ext : ''}`); logRefusal(d); }
      return true;
    };
    // Any other link opens in the user's browser only when (1) it was asked by THE Board tab guest, on its own board /
    // bridge origin (CoS decision 20-10: top-level page and, when Electron names it, the asking frame; never another
    // guest, a navigated-away page or a foreign iframe) and (2) board-open.mjs decideExternalUrl
    // accepts it (http/https web page; no userinfo, IP literal, punycode or local host). Everything else is logged and not
    // opened. With allowpopups on, every http(s) link of the page reaches here, so this is the only gate. The guest itself
    // never leaves its origin: the new window is always denied and an outside navigation is always prevented.
    const fromBoardTab = (frame) => Boolean(boardGuest && contents.id === boardGuest.id && inBoard(contents.getURL()) && (!frame || inBoard(frame.url)));
    const openLink = (url, frame) => {
      const d = !fromBoardTab(frame) ? { action: 'refuse', reason: 'opener_not_board_tab' }
        : decideExternalUrlFn ? decideExternalUrlFn(url) : { action: 'refuse', reason: 'not_ready' };
      if (d.action === 'openExternal') shell.openExternal(d.url);
      else { console.warn(`[board-open] refused link ${d.reason}${d.origin ? ' ' + d.origin : ''}`); logRefusal(d); }
    };
    contents.setWindowOpenHandler(({ url, frame }) => {
      if (boardOpen(url)) return { action: 'deny' };
      if (!inBoard(url)) openLink(url, frame);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (e, url) => {
      if (boardOpen(url)) return e.preventDefault();
      if (!inBoard(url)) { e.preventDefault(); openLink(url, e.frame); }
    });
  }
});

// ---------- IPC ----------
ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  selftest: Boolean(selftestDir),
  demo: Boolean(demoDir),
  demoFixture,
  demoReflexOnly,
  boardPartition: BOARD_PARTITION,
  boardLivePartition: BOARD_LIVE_PARTITION,
  roomShots: Boolean(roomShotsDir),
  boardStress: Boolean(boardStressDir),
  settingsShots: Boolean(settingsShotsDir),
  settingsProbe: Boolean(settingsProbeDir),
  minWindow: MIN_WINDOW,
  packaged: app.isPackaged, // false = `electron .` dev run: the renderer shows the dev-only controls without a setting
  versions: { electron: process.versions.electron, chrome: process.versions.chrome },
  disabledViews: DISABLED_VIEWS,
  // Owner build (package.json zumiOwnerAdmin, scripts/builder-selftest.cjs): the Board tab never shows the bundled
  // local/sample board — app.js gates openBoard() on this flag and shows the sign-in card instead.
  ownerAdmin: OWNER_ADMIN,
}));
ipcMain.handle('models:list', () => listModels());
ipcMain.handle('models:select', (_e, id) => {
  const list = listModels();
  if (id !== 'test' && list.models.some((m) => m.id === id)) { saveSettings({ model: id }); sayEvent('look'); } // the test model is never persisted
  return listModels();
});
ipcMain.handle('models:open-file', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'Open VRM file',
    filters: [{ name: 'VRM model', extensions: ['vrm'] }],
    properties: ['openFile'],
  });
  if (r.canceled || !r.filePaths[0] || !isVrmFile(r.filePaths[0])) return null;
  saveSettings({ userModelPath: r.filePaths[0], model: 'user' });
  sayEvent('look');
  return listModels();
});
// T-31 0.2.8 "Back to default model": one no-argument channel, main owns the file + sha256 (default-model.js).
const defaultModelSearchDirs = () => defaultModelDirs({ env: process.env, modelsDir: MODELS_DIR, resourcesPath: process.resourcesPath });
registerRestoreDefault({ ipcMain, fs, crypto, saveSettings, listModels, sayEvent, dirs: defaultModelSearchDirs() });
ipcMain.handle('clips:list', () => listClips());
// Rooms (T-31 R3, PLAN-room.md §3 "UI"): one setting ('none' | 'default-v2' | <imported id>), like the model picker.
ipcMain.handle('rooms:list', () => listRooms());
ipcMain.handle('rooms:select', async (_e, id) => {
  const { rooms } = await listRooms();
  if (id === 'none' || rooms.some((r) => r.id === id)) saveSettings(roomPickPatchFn(id)); // explicit pick: roomChoiceV2:true
  return listRooms();
});
ipcMain.handle('rooms:open-file', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'Open room file',
    filters: [{ name: 'Zumi room', extensions: ['glb'] }],
    properties: ['openFile'],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const imported = importRoomFile(r.filePaths[0]);
  if (imported.error) return { error: imported.error };
  return listRooms();
});
ipcMain.handle('rooms:delete', (_e, id) => { deleteRoom(id); return listRooms(); });
// Video rooms (T-31 room picker, scene-rooms.mjs): 'current' (the painted room, default) or one of the manifest's rooms.
const NO_SCENES = { selected: 'current', geometry: null, rooms: [], error: 'not ready' };
ipcMain.handle('scenes:list', () => (sceneRooms ? sceneRooms.list() : NO_SCENES));
ipcMain.handle('scenes:select', (_e, id) => (sceneRooms ? sceneRooms.select(String(id)) : NO_SCENES));
// 3D chair (T-31 chair3d, chair3d.mjs): 'painted' (the old painted chair) or one of the manifest's chairs; default DEFAULT_CHAIR.
const NO_CHAIRS = { selected: 'painted', noChairPlateUrl: null, hideOccluders: [], chairs: [], error: 'not ready' };
ipcMain.handle('chairs:list', () => (chairs3d ? chairs3d.list() : NO_CHAIRS));
ipcMain.handle('chairs:select', (_e, id) => (chairs3d ? chairs3d.select(String(id)) : NO_CHAIRS));
// room standard v2 registration tool (T-31 camera modes, coordinator ruling 03-10): dev-only -- the renderer's own
// button is hidden without the Developer-tools setting, but the handler enforces it independently too (never
// trust a renderer-side gate alone for a disk write). Scoped to the one v2 room this task ships (id 'default-v2');
// a real Vesta room B gets its own save path once v2 rooms can be imported, same as v1's import flow today.
ipcMain.handle('rooms:v2:save-view', (e, id, view, camera) => {
  if (!fromAppPage(e)) return { error: 'forbidden' };
  if (!(app.isPackaged === false || loadSettings().developerMode === true)) return { error: 'dev_tools_off' };
  if (id !== 'default-v2') return { error: 'unknown_room' };
  if (!['talk', 'work', 'room'].includes(view)) return { error: 'bad_view' };
  const pos = camera && camera.pos, target = camera && camera.target, fov = camera && camera.fov;
  const isVec3 = (v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
  if (!isVec3(pos) || !isVec3(target) || typeof fov !== 'number' || !Number.isFinite(fov)) return { error: 'bad_camera' };
  if (!ensureDefaultRoomV2CopyFn) return { error: 'not_ready' };
  // Edits land on the SERVED COPY (defaultRoomV2Dir), never Vesta's own source at roomV2DefaultPath() -- same
  // "the app's own validated copy, never the live source directly" posture as v1's room pipeline.
  const defV2 = ensureDefaultRoomV2CopyFn(defaultRoomV2CacheObj, roomV2DefaultPath(), defaultRoomV2Dir, { get: loadSettings, set: saveSettings });
  if (!defV2.sha) return { error: 'missing_view' };
  const jsonPath = path.join(defaultRoomV2Dir(defV2.sha), 'room.json');
  let json;
  try { json = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); } catch { return { error: 'not_a_room_json' }; }
  if (!json.views || !json.views[view] || !json.views[view].camera || !json.views[view].camera.three) return { error: 'missing_view' };
  const before = JSON.stringify(json);
  // MERGE, never overwrite the whole camera object: pos/target/three.fov are the only fields the registration
  // tool's keyboard nudges touch -- fovDeg/focalPx/principalPointPx/yawDeg/aspect/viewOffset are Vesta's own
  // solve output and stay exactly as she wrote them.
  json.views[view].camera.pos = pos;
  json.views[view].camera.target = target;
  json.views[view].camera.three.fov = fov;
  if (JSON.stringify(json) === before) return { ok: true, unchanged: true };
  fs.writeFileSync(jsonPath, JSON.stringify(json, null, 2));
  if (checkRoomJsonFileFn) {
    const check = checkRoomJsonFileFn(jsonPath);
    if (!check.ok) { fs.writeFileSync(jsonPath, before); return { error: 'save_made_it_invalid', refused: check.refused }; } // rolled back
  }
  return { ok: true };
});
// UI language (T-31 ui-english): persisted per user in the same settings file, English by default. The renderer owns
// the words; main only stores the choice, so a restart reopens in the language the owner picked.
ipcMain.handle('ui:get-lang', (e, fallback) => {
  if (!fromAppPage(e)) return 'en';
  const ok = (l) => l === 'vi' || l === 'zh' || l === 'en';
  const l = loadSettings().uiLang;
  return ok(l) ? l : ok(fallback) ? fallback : 'en'; // first run: the OS-locale language the page passes (tauri main.mjs uiLangOf)
});
ipcMain.handle('ui:set-lang', (e, lang) => {
  if (!fromAppPage(e)) return 'en';
  const l = (lang === 'vi' || lang === 'zh') ? lang : 'en';
  saveSettings({ uiLang: l });
  return l;
});
// Developer mode (T-31 settings P1b): one persisted boolean (settings.json `developerMode`) that reveals the
// dev-only sidebar chrome (the three debug buttons + the version tag). Off by default, so a normal install never
// shows them; an unpackaged dev run shows them regardless (see app:info.packaged), so the owner does not have to
// flip a setting while developing. The key is `developerMode`, NOT the old `devTools`: that key is ignored entirely
// (no migration), so an install that had `devTools: true` still comes up with the chrome hidden after the update.
ipcMain.handle('ui:get-dev-tools', (e) => {
  if (!fromAppPage(e)) return false;
  return loadSettings().developerMode === true;
});
ipcMain.handle('ui:set-dev-tools', (e, on) => {
  if (!fromAppPage(e)) return false;
  const v = on === true;
  saveSettings({ developerMode: v });
  return v;
});
// "Send client names to the AI" (T-31 board-aware privacy, CoS decision 07-10): one persisted boolean, same
// pattern as developerMode above. OFF by default (settings.json has no `sendClientNamesToAi` key yet on a fresh
// install, and `!== true` below reads that as off) — board-reader.mjs's getRedact() reads this same key.
ipcMain.handle('ui:get-send-client-names', (e) => {
  if (!fromAppPage(e)) return false;
  return loadSettings().sendClientNamesToAi === true;
});
ipcMain.handle('ui:set-send-client-names', (e, on) => {
  if (!fromAppPage(e)) return false;
  const v = on === true;
  saveSettings({ sendClientNamesToAi: v });
  return v;
});
// Look-tuning panel (T-31 camera modes, owner priority shift 03-10): per-view camera/grading overrides, a user
// file in userData -- NEVER written into room.json / the shipped room files (a v2 room's own numbers are
// Vesta's; this is purely a local, personal QC override, same "the app's own file, not the source" posture as
// room-default-v2.mjs's copy). Dev-gated like every other control behind the Developer toggle.
function lookTuningPath() { return path.join(runDir || app.getPath('userData'), 'look-tuning.json'); }
ipcMain.handle('ui:get-look-tuning', (e) => {
  if (!fromAppPage(e)) return null;
  try { return JSON.parse(fs.readFileSync(lookTuningPath(), 'utf8')); } catch { return null; }
});
ipcMain.handle('ui:set-look-tuning', (e, overrides) => {
  if (!fromAppPage(e)) return { error: 'forbidden' };
  if (!(app.isPackaged === false || loadSettings().developerMode === true)) return { error: 'dev_tools_off' };
  if (!overrides || typeof overrides !== 'object') return { error: 'bad_overrides' };
  try { fs.writeFileSync(lookTuningPath(), JSON.stringify(overrides, null, 2)); return { ok: true }; }
  catch (e2) { return { error: String((e2 && e2.message) || e2) }; }
});
// Titles and step labels of the old v0.2 board, so a refusal can be told in the owner's words (task title, step number
// and label) instead of codes. Read-only; {} when the file is unreadable.
function legacyNames(root) {
  try {
    const out = {};
    for (const t of JSON.parse(fs.readFileSync(path.join(root, 'tasks.json'), 'utf8'))) {
      out[t.code] = { title: String(t.title || ''), steps: Object.fromEntries((t.steps || []).map((s, i) => [s.id, { n: i + 1, label: String(s.label || '') }])) };
    }
    return out;
  } catch { return {}; }
}
ipcMain.handle('board:open', async () => {
  try {
    const b = await startBoard();
    const core = { laneboard: laneboardVersion(), root: b.root, dataDir: b.dataDir };
    if (b.outcome === 'refused') return { ...core, refused: b.refused, legacyNames: legacyNames(b.root) };
    return { ...core, url: b.url, origin: b.origin, outcome: b.outcome, migration: b.migration && { imported: b.migration.imported, warnings: b.migration.warnings.length, report: b.migration.report } };
  } catch (e) {
    console.error('board server failed', e);
    return { error: String((e && e.message) || e) };
  }
});

// GestureCommand path for a future LLM: anything (renderer devtools via window.zumi.playGesture, or
// main-process code calling playGestureInRenderer) funnels into the renderer's single player and
// gets back the validator's verdict { ok, errors, warnings, ... }.
const pendingGestures = new Map();
let gestureSeq = 0;
function playGestureInRenderer(command) {
  if (!mainWindow) return Promise.resolve({ ok: false, errors: ['no window'] });
  const reqId = ++gestureSeq;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pendingGestures.delete(reqId); resolve({ ok: false, errors: ['renderer did not answer'] }); }, 5000);
    pendingGestures.set(reqId, (res) => { clearTimeout(timer); resolve(res); });
    mainWindow.webContents.send('gesture:play', { reqId, command });
  });
}
ipcMain.handle('gesture:play', (_e, command) => playGestureInRenderer(command));
ipcMain.on('gesture:result', (_e, reqId, result) => {
  const done = pendingGestures.get(reqId);
  if (done) { pendingGestures.delete(reqId); done(result); }
});

// ---------- talk (Zumi answers + speaks + gestures) ----------
// Narrow per-operation IPC (Sol P1.1 condition 4): only the app's own page may call, every payload is validated in
// cloud.js, and there is no generic "fetch through main". The device token never leaves cloud.js.
let cloud = null;
let chatBrain = null;
// T-31 BYOK: rebuild the chat brain against the newly chosen provider (set in app.whenReady). Switching provider
// re-reads its key + model on the next turn, no restart.
let rebuildChatBrain = null;
let localTts = null; // free Windows voices, used only when cloud is off (no-cloud builds)
let kokoroTts = null; // T-31 voice P1: EN TTS, local, streamed per sentence
let enTts = null; // T-31 QC-cuoi fix d: EN routing (Kokoro once ready, Windows voice until then), tts-router.js
let ledaTts = null; // T-31 voice P1: VI TTS, Google Chirp3-HD Leda, owner's own key
// T-31 talk-mode (PLAN sections 2, 10): the provider registry and the "how much Zumi talks" scheduler. speech is
// ESM (speech-scheduler.mjs), imported dynamically in app.whenReady; these are the handles its IPC + talk:tts use.
let zumiaOwnerTts = null; // the owner's Zumia cloud voice route (fixed URL, no key), present only with the flag
let geminiTts = null;     // BYO providers (inc 3): each owns its DPAPI key file and reads its non-secret config per call
let elevenTts = null;
let httpOpenaiTts = null;
let httpZumiaTts = null;
let scheduler = null;     // createSpeechScheduler() instance: talk prefs, the level matrix, the hold queue, the clocks
let talkTick = null;      // one 1 s interval driving scheduler.tick()
let talkPrefsFn = null;   // (settings, now) -> normalised talk prefs (set in whenReady with the scheduler module)
let setTalkPrefsFn = null; // (patch) -> normalised prefs, persisted to settings.json
let ownerVoiceFlag = false; // owner-voice.json present at startup (per-install switch, PLAN section 10.2)
let testBuildRun = false;   // the selftest/test build (ZUMI_TEST_* env hooks are honoured only then)
let windowVisible = true;   // main tracks minimize/hide/restore/show (PLAN F9); the scheduler reads it as a signal
let boardWaitingCount = 0;  // the board reader's last waiting count, for the scheduler's morning line
let sayReady = false;       // the renderer registered its speech:say listener (talk:sayReady); until then a line is handed back as busy
let startTalkClock = null;  // starts the 1 s tick and the new-version line, once the renderer listens (set in whenReady)
// turnId -> chat-brain live reply (createLiveReply) of a streamed turn, until talk:tts takes it (or the TTL drops it).
const liveReplies = new Map();
const LIVE_REPLY_TTL_MS = 60000;
const fromAppPage = (e) => Boolean(mainWindow && e.sender === mainWindow.webContents && e.senderFrame && String(e.senderFrame.url).startsWith('app://zumi/'));
const refused = { ok: false, error: { code: 'forbidden', message: 'not the app page', retryable: false } };
// T-31 parity step 8b (freeze exception): the ONE voice-routing core shared with the Tauri sidecar. Its dependencies
// are getters because main.js creates the voice engines in app.whenReady, after these handles are registered; every
// handle below delegates, so Electron's behaviour is the moved code, not a copy of it.
const talkVoice = createTalkVoiceCore({
  settings: loadSettings,
  saveSettings,
  ownerFlag: () => ownerVoiceFlag,
  talkPrefs: (s) => (talkPrefsFn ? talkPrefsFn(s) : {}),
  adapters: () => ({
    google: ledaTts, gemini: geminiTts, elevenlabs: elevenTts,
    'http-openai': httpOpenaiTts, 'http-zumia': httpZumiaTts,
    'zumia-owner': zumiaOwnerTts,
  }),
  enTts: () => enTts,
  kokoro: () => kokoroTts,
  cloud: () => cloud,
  isLiveSay: (sayId) => Boolean(scheduler && scheduler.isLive(sayId)),
  takeLiveReply: (turnId) => { const live = liveReplies.get(turnId); if (live) liveReplies.delete(turnId); return live || null; },
  saySilent: (sayId) => Boolean(sayId && testBuildRun && process.env.ZUMI_TEST_SAY_SILENT),
  openExternal: (url) => shell.openExternal(url),
  log: (line) => process.stdout.write(line),
});
// chatBrain (BYO OpenRouter, T-31 Fable ruling 02-10) takes over talk:status/talk:turn in place of cloud.js the
// moment its key is present — never both: a key means this build never contacts prod/staging at all for chat.
ipcMain.handle('talk:status', (e) => {
  if (!fromAppPage(e)) return { enabled: false, mode: 'off', reason: 'not ready' };
  if (chatBrain && chatBrain.hasKey()) return chatBrain.status();
  return cloud ? cloud.status() : { enabled: false, mode: 'off', reason: 'not ready' };
});
ipcMain.handle('talk:turn', async (e, p) => {
  if (!fromAppPage(e)) return refused;
  if (chatBrain && chatBrain.hasKey()) {
    // boardReader.getDigestText() never throws and never touches the network when the board isn't reachable
    // (board-reader.mjs's own status check short-circuits first) — safe to await on every turn.
    const boardDigest = boardReader ? await boardReader.getDigestText() : undefined;
    // T-31 voice round 6: streamed. The result comes back at the reply's first speakable clause; the rest of the
    // text goes to the renderer as talk:replyMore / talk:replyDone and to the voice via liveReplies (talk:tts below).
    const { head, live } = await chatBrain.turnStream({ ...p, boardDigest });
    // T-31 BYOK: a quota HTTP 429 reaches the renderer with the provider named. A free-tier provider (gemini/groq)
    // also gets `free: true`, so the line stays the accurate "free quota used up for today, {provider}" (app.quota);
    // a paid 429 has no free-tier signal and shows the busy line (byok-errors round 2).
    if (head && head.error && head.error.code === 'quota') head.error = { ...head.error, provider: aiProvider().label, free: aiProviderId() === 'gemini' || aiProviderId() === 'groq' };
    const turnId = p && typeof p.turnId === 'string' ? p.turnId : null;
    if (live && turnId) {
      liveReplies.set(turnId, live);
      setTimeout(() => liveReplies.delete(turnId), LIVE_REPLY_TTL_MS).unref();
      live.onText((text) => sendToRenderer('talk:replyMore', { turnId, text }));
      // Models by role (T-31 zumi-roles): a Look up reply carries its sources; the Check verdict comes later, only
      // when Check ran (talk:checkDone), and is shown as text, never spoken.
      live.final.then((fin) => {
        rememberCited(fin.sources);
        if (fin.ok && agentCore) agentCore.onChat(); // T-31 alpha.12: the rhythm's `chat` event (agent-core.mjs)
        sendToRenderer('talk:replyDone', { turnId, ok: fin.ok, reply: fin.reply, error: fin.error || null, sources: fin.sources || [] });
      });
      live.checked.then((c) => { if (c) sendToRenderer('talk:checkDone', { turnId, verdict: c.verdict, text: c.text }); });
    }
    return head;
  }
  return cloud ? cloud.turn(p) : refused;
});
// Sources row (Look up): a link opens in the OS browser only when a Look up reply of this session really cited that
// exact URL (chat-brain keeps http(s) only) -- the page cannot open arbitrary addresses through this channel.
const citedUrls = new Set();
function rememberCited(sources) {
  for (const s of Array.isArray(sources) ? sources : []) if (s && typeof s.url === 'string') citedUrls.add(s.url);
  while (citedUrls.size > 100) citedUrls.delete(citedUrls.values().next().value);
}
// Auto-update (src/main/updater.mjs, created in app.whenReady). The renderer reads the state, and answers the one
// offer: Restart now (install) or Later (not offered again this session; installs on the next quit).
let updater = null;
ipcMain.handle('update:status', (e) => (fromAppPage(e) && updater ? updater.status() : { phase: 'off' }));
ipcMain.handle('update:install', (e) => Boolean(fromAppPage(e) && updater && updater.install()));
ipcMain.handle('update:later', (e, version) => Boolean(fromAppPage(e) && updater && typeof version === 'string' && updater.later(version)));
ipcMain.handle('update:check', (e) => (fromAppPage(e) && updater ? updater.check() : { result: 'off' }));
// Review v7 nit: the same decision every other outside link takes (board-open.mjs decideExternalUrl, `cited` channel:
// exactly a cited URL, https on the default port, no userinfo/punycode/loopback), and a refusal lands in the same log.
ipcMain.handle('talk:openSource', (e, url) => {
  if (!fromAppPage(e) || typeof url !== 'string') return false;
  const d = decideExternalUrlFn ? decideExternalUrlFn(url, { cited: citedUrls }) : { action: 'refuse', reason: 'not_ready' };
  if (d.action !== 'openExternal') { console.warn(`[talk] refused source link ${d.reason}${d.origin ? ' ' + d.origin : ''}`); logRefusal(d); return false; }
  shell.openExternal(d.url);
  return true;
});
// Settings-panel line only (Sol P1.1 cond. 6: model output / provider name is plain data) — label and model name
// only, never the key, never anything key-shaped.
ipcMain.handle('talk:brainInfo', (e) => {
  if (!fromAppPage(e) || !chatBrain || !chatBrain.hasKey()) return null;
  const st = chatBrain.status();
  return { provider: st.provider, model: st.model };
});
ipcMain.handle('talk:gesture', (e, p) => (fromAppPage(e) && cloud ? cloud.gesture(p) : refused));

// ---------- Settings > AI brain > "Your own key" (T-31 settings-a2; KEY-HANDLING.md, Sol gate before merge) ----------
// brain-key.js owns the flow. The renderer sends the pasted key ONCE (save) and only ever gets back
// { provider, saved, last4, checked, encryption } + { ok, check, error } -- never the key. chat-brain reads the same encrypted
// file on every turn, so a saved key takes effect at once and a cleared one stops chat at once.
let brainKey = null; // set in app.whenReady (needs safeStorage + userData)
const BRAIN_KEY_OFF = { provider: 'OpenRouter', saved: false, last4: null, checked: null, encryption: false };
ipcMain.handle('brainKey:status', (e) => (fromAppPage(e) && brainKey ? brainKey.status() : BRAIN_KEY_OFF));
ipcMain.handle('brainKey:save', async (e, raw, confirm) => (fromAppPage(e) && brainKey ? brainKey.save(raw, { confirmUnreachable: confirm === true }) : { ok: false, error: 'forbidden', ...BRAIN_KEY_OFF }));
ipcMain.handle('brainKey:clear', (e) => (fromAppPage(e) && brainKey ? brainKey.clear() : { ok: false, error: 'forbidden', ...BRAIN_KEY_OFF }));
ipcMain.handle('brainKey:test', async (e) => (fromAppPage(e) && brainKey ? brainKey.test() : { ok: false, error: 'forbidden', ...BRAIN_KEY_OFF }));

// ---------- T-31 BYOK: provider picker + key test + key page (Settings > AI & Usage) ----------
// Kept OUT of the brainKey:* namespace on purpose, so the existing key flow (status/save/clear/test) is untouched.
ipcMain.handle('ai:provider', (e) => (fromAppPage(e) ? { id: aiProviderId(), label: aiProvider().label, mode: aiMode() } : null));
// The two-choice header (T-31 OpenCode BYOK): persist the user's pick. Renderer-side grouping only.
ipcMain.handle('ai:set-mode', (e, mode) => {
  if (!fromAppPage(e)) return { ok: false, error: 'forbidden' };
  if (!isMode(mode)) return { ok: false, error: 'bad_mode' };
  saveSettings({ aiMode: mode });
  // T-31 fix round item 3: the mode now decides the model sent (free -> the table's free ids for every provider, incl.
  // a legacy OpenRouter user), so rebuild the chat brain for the next turn. The roles card re-reads on the renderer's
  // zumi:brain-key-changed event.
  if (rebuildChatBrain) chatBrain = rebuildChatBrain();
  return { ok: true, mode };
});
ipcMain.handle('ai:set-provider', (e, id) => {
  if (!fromAppPage(e)) return { ok: false, error: 'forbidden' };
  if (!selectableProvider(id, OWNER_ADMIN)) return { ok: false, error: 'bad_provider' };
  const s = loadSettings();
  const from = aiProviderId();
  if (id === from) {
    saveSettings({ aiProvider: id });
  } else {
    // T-31 fix r item 5: role choices are PER PROVIDER. `roleModels` is the live slot of the active provider; snapshot
    // it and restore the target's, so switching back brings that provider's own choices back (a legacy flat
    // `roleModels` -- an existing user, no map yet -- is snapshotted under `openrouter`, which is the migration).
    const moved = switchRoleSlots(s.roleModelsByProvider, from, s.roleModels, id);
    saveSettings({ aiProvider: id, roleModels: moved.live, roleModelsByProvider: moved.byProvider });
  }
  if (rebuildChatBrain) chatBrain = rebuildChatBrain(); // new provider's key + model apply from the next turn, no restart
  return { ok: true, id, label: PROVIDERS[id].label };
});
// "Thử khoá": test a key the user typed BEFORE saving it. Never stored, never logged (brain-key.js).
ipcMain.handle('ai:test-key', (e, raw) => (fromAppPage(e) && brainKey ? brainKey.testKey(raw) : { ok: false, error: 'forbidden' }));
// Opens the active provider's key page in the OS browser. main owns the URL (the provider table); the page passes none.
ipcMain.handle('ai:open-key-page', (e) => {
  if (!fromAppPage(e)) return false;
  shell.openExternal(aiProvider().keyPageURL);
  return true;
});
// --settings-shots only: the fixture provider data (role-models-fixtures.json: model list + canned chat answers).
function shotsFixtures() {
  if (settingsShotsDir) {
    shotsRoleFixtures = shotsRoleFixtures || JSON.parse(fs.readFileSync(path.join(__dirname, 'role-models-fixtures.json'), 'utf8'));
    return shotsRoleFixtures;
  }
  return null;
}
// --settings-shots only: the fixture provider's model list in its current mode ('on' | 'one'), null when 'off'.
function shotsRoleModels() {
  const f = shotsFixtures();
  if (!f || shotsRoleProvider === 'off') return null;
  return shotsRoleProvider === 'one' ? f.models.filter((m) => m.id === f.defaultModel) : f.models;
}
// --settings-shots only: a fake provider CHAT endpoint (role-models-fixtures.json `chat`), so the chat-turn shots run
// Plan / Do / Check / Look up through the real chat-brain path with no real call. Answers by request shape: the Plan
// and Check prompts get the outline / verdict, a streamed call gets the reply as SSE (with url_citation annotations
// when it carries the web plugin).
function shotsChatFetch(url, opts) {
  const f = shotsFixtures();
  const body = JSON.parse(String((opts && opts.body) || '{}'));
  if (!f || new URL(url).pathname !== '/api/v1/chat/completions' || !Array.isArray(body.messages)) return Promise.reject(new Error('shots fixture: not a chat call'));
  const c = f.chat;
  const system = String(body.messages[0].content);
  const user = String(body.messages[body.messages.length - 1].content);
  const usage = { prompt_tokens: 180, completion_tokens: 45, total_tokens: 225 };
  const pick = (list) => list.find((r) => user.includes(r.when)).text;
  if (!body.stream) {
    const text = system.startsWith('Write at most 5') ? c.plan : system.startsWith('You review') ? (user.includes(c.checkFix.when) ? c.checkFix.text : 'OK') : pick(c.replies);
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ provider: 'Shots', choices: [{ message: { content: text } }], usage }) });
  }
  const text = body.plugins ? c.lookupReply : pick(c.replies);
  const annotations = body.plugins ? c.sources.map((s) => ({ type: 'url_citation', url_citation: { url: s.url, title: s.title } })) : undefined;
  const sse = (o) => `data: ${JSON.stringify(o)}\n\n`;
  return Promise.resolve({
    ok: true, status: 200,
    body: (async function* () {
      for (const piece of text.match(/[\s\S]{1,14}/g)) { await new Promise((r) => setTimeout(r, 25)); yield sse({ provider: 'Shots', choices: [{ delta: { content: piece } }] }); }
      yield sse({ provider: 'Shots', choices: [{ delta: { annotations }, finish_reason: 'stop' }], usage });
      yield 'data: [DONE]\n\n';
    })(),
  });
}
// --settings-shots only: a fake provider endpoint for the key check, so the shots exercise the real save path
// without a real key or the network. A key containing "shots-good" passes, "shots-offline" cannot reach the
// provider (network error), any other one is refused (401).
function shotsProviderFetch(url, opts) {
  const auth = String((opts && opts.headers && opts.headers.authorization) || '');
  if (auth.includes('shots-offline')) return Promise.reject(new Error('offline (shots fixture)'));
  const ok = new URL(url).pathname === '/api/v1/key' && auth.includes('shots-good');
  return Promise.resolve({ ok, status: ok ? 200 : 401, json: async () => (ok ? { data: { label: 'shots' } } : { error: { code: 401 } }) });
}

// ---------- Models by role (T-31 board-roles, owner 09-10): Settings card, BYOK ----------
// The provider is whatever the user configured: today the BYO chat brain (chat-brain.js) when its key exists. No
// configured provider -> { provider: null } and the card says so; nothing is invented. The --settings-shots run
// swaps in a fixture provider (never in a normal run). Payloads carry model ids + names only, never a key.
let shotsRoleProvider = 'on'; // --settings-shots only: 'on' | 'one' (a one-model provider) | 'off' (none configured)
// --settings-shots only: the "English voice model" row's state (talk:voiceState), set by shots:voice-state.
let shotsVoiceState = { state: 'downloading', phase: 'model', loaded: 64, total: 100, error: null };
let shotsRoleFixtures = null;
// Every list leaving roleProvider() has no Claude model (role-models.js isClaudeModel; product rule, both builds):
// roles:models (the picker) and rolesView (defaults) both read it through here.
const noClaude = (listModels) => async () => { const r = await listModels(); return r && r.ok ? { ...r, models: withoutClaude(r.models) } : r; };
function roleProvider() {
  if (settingsShotsDir) {
    // The fixture list appears only once a key is really saved (the shots save one through Settings > AI brain).
    const models = shotsRoleModels();
    if (!models || !chatBrain || !chatBrain.hasKey()) return null;
    const f = shotsFixtures();
    return { label: f.provider, defaultModel: f.defaultModel, listModels: noClaude(async () => ({ ok: true, models })) };
  }
  if (!chatBrain || !chatBrain.hasKey()) return null;
  // roleDefaults (T-31 fix r item 2): the active provider table's free per-role ids, so an unset role in the card shows
  // exactly the model chat-brain posts for that provider. `do` stays chatBrain.defaultModel (the user's set `chatModel`
  // when there is one, else the table's free Do id) -- the same rule as chat-brain's providerDefaultFor, so the card
  // and the send never disagree. T-31 fix round 2: a legacy (pre-BYOK) OpenRouter user keeps the pre-BYOK role
  // defaults, so the card withholds the free table ids exactly when chat-brain does (chatBrain.legacyOpenRouter) --
  // the card and the send stay in step for every user, legacy or new. The shots fixture below has none.
  const table = chatBrain.provider.models;
  return { label: chatBrain.status().provider, caps: { webSearch: Boolean(chatBrain.provider.webSearch), effort: Boolean(chatBrain.provider.sendsEffort) }, defaultModel: chatBrain.defaultModel, listModels: noClaude(() => chatBrain.listModels()), ...(chatBrain.legacyOpenRouter ? {} : { roleDefaults: { ...table, do: chatBrain.defaultModel } }) };
}
// The defaults depend on the provider's model list (Check/Plan default to a model different from Do's), so the view
// waits for it; chat-brain caches the list, and a failed fetch just means "list unknown" (no warning, no note).
async function rolesView() {
  const p = roleProvider();
  if (!p) return { provider: null };
  const list = await p.listModels();
  return { provider: { label: p.label, ...p.caps }, ...resolveRoles(loadSettings().roleModels, p.defaultModel, list && list.ok ? list.models : null, p.roleDefaults), wired: WIRED_ROLES };
}
ipcMain.handle('roles:get', (e) => (fromAppPage(e) ? rolesView() : { provider: null }));
ipcMain.handle('roles:set', async (e, role, choice) => {
  if (!fromAppPage(e)) return { ok: false, error: 'forbidden' };
  if (!roleProvider()) return { ok: false, error: 'no_provider' };
  // Only a role that drives a real step can be changed (today all four, chat-brain.js).
  if (!Object.prototype.hasOwnProperty.call(WIRED_ROLES, role)) return { ok: false, error: 'not_available' };
  const r = setRoleChoice(loadSettings().roleModels, role, choice);
  if (!r.ok) return r;
  saveSettings({ roleModels: r.next });
  return { ok: true, ...(await rolesView()) };
});
ipcMain.handle('roles:reset', async (e, role) => {
  if (!fromAppPage(e)) return { ok: false, error: 'forbidden' };
  const r = resetRoleChoice(loadSettings().roleModels, role);
  if (!r.ok) return r;
  saveSettings({ roleModels: r.next });
  return { ok: true, ...(await rolesView()) };
});
// The on/off switch of Plan / Check / Look up (CoS decision 10-10; Do has none). Off = that role never runs.
ipcMain.handle('roles:setOn', async (e, role, on) => {
  if (!fromAppPage(e)) return { ok: false, error: 'forbidden' };
  if (!roleProvider()) return { ok: false, error: 'no_provider' };
  if (typeof on !== 'boolean') return { ok: false, error: 'bad_choice' };
  const r = setRoleOn(loadSettings().roleModels, role, on);
  if (!r.ok) return r;
  saveSettings({ roleModels: r.next });
  return { ok: true, ...(await rolesView()) };
});
ipcMain.handle('roles:models', async (e) => {
  if (!fromAppPage(e)) return { ok: false, error: 'forbidden', models: [] };
  const p = roleProvider();
  return p ? p.listModels() : { ok: false, error: 'no_provider', models: [] };
});
// Speech: cloud (build-level switch) first; otherwise routed by language (T-31 voice P1) -- VI to Leda (key
// required) or EN to Kokoro, each falling back to the free Windows voice (SAPI) if its own path is unavailable
// or fails; otherwise refused. Same result shape either way ({ ok, mime, audios: Buffer[], voice }) so the
// renderer's SpeechOut is unchanged; Kokoro's SENTENCE 2+ chunks arrive afterwards over `talk:ttsMore` (below),
// not in this result, so this call resolves as soon as sentence 1 is ready rather than once the whole reply is.
ipcMain.handle('talk:getVoiceEnabled', (e) => (fromAppPage(e) ? loadSettings().voiceEnabled !== false : true)); // default ON
ipcMain.handle('talk:setVoiceEnabled', (e, on) => { if (fromAppPage(e)) saveSettings({ voiceEnabled: on === true }); return true; });
// Settings > Voice "Soft sound while thinking" (CoS decision 09-10): the think ack's chime, OFF unless the owner turns it on.
ipcMain.handle('talk:getThinkSound', (e) => (fromAppPage(e) ? loadSettings().thinkSound === true : false));
ipcMain.handle('talk:setThinkSound', (e, on) => { if (fromAppPage(e)) saveSettings({ thinkSound: on === true }); return true; });
// T-31 settings P1: "Đọc to câu trả lời khi tắt mic" (Workflow tab) -- whether Zumi speaks the reply to a TYPED
// message (mic off). Default ON (today's behaviour). Read per turn by talk/director.js's gate.
ipcMain.handle('talk:getSpeakTypedWhenMicOff', (e) => (fromAppPage(e) ? loadSettings().speakTypedWhenMicOff !== false : true));
ipcMain.handle('talk:setSpeakTypedWhenMicOff', (e, on) => { if (fromAppPage(e)) saveSettings({ speakTypedWhenMicOff: on === true }); return true; });
// Settings > Voice > Speed + Volume (T-31 settings-a2), the BYO provider prefs and the whole talk:tts route were
// extracted to src/main/talk-voice-core.mjs (step 8b freeze exception). These handles stay here: same channels, same
// sender check, same replies. voicePrefs/setVoicePrefs are the core's own functions, not re-implementations.
ipcMain.handle('talk:getVoicePrefs', (e) => (fromAppPage(e) ? talkVoice.voicePrefs() : { speed: VOICE_SPEED.def, volume: 1 }));
ipcMain.handle('talk:setVoicePrefs', (e, p) => (fromAppPage(e) && p && typeof p === 'object' ? talkVoice.setVoicePrefs(p) : talkVoice.voicePrefs()));
// T-31 talk-mode (PLAN sections 1, 2): "how much Zumi talks". The scheduler (speech-scheduler.mjs, loaded in
// app.whenReady) owns the prefs; these are thin, sender-validated IPC. The renderer never writes a file.
ipcMain.handle('talk:getTalkPrefs', (e) => (fromAppPage(e) && talkPrefsFn ? talkPrefsFn(loadSettings()) : null));
ipcMain.handle('talk:setTalkPrefs', (e, p) => {
  if (!fromAppPage(e) || !setTalkPrefsFn || !p || typeof p !== 'object') return null;
  const next = setTalkPrefsFn(p);
  // The board poll runs while a talk level is on (PLAN F6): a level switched on in Settings starts it now.
  if (hudHost) hudHost.start();
  return next;
});
// Stage mute (PLAN 5.2). The mute is a PREF (talkMute), so it survives a restart and "until 07:30" means what it says;
// the scheduler re-reads it on its next decision. untilMs: null = until unmuted, a number = epoch ms.
ipcMain.handle('talk:mute', (e, untilMs) => {
  if (!fromAppPage(e) || !setTalkPrefsFn || !scheduler) return null;
  const until = untilMs == null ? null : Number(untilMs);
  if (until !== null && !Number.isFinite(until)) return scheduler.status();
  setTalkPrefsFn({ talkMute: { until } });
  if (agentCore) agentCore.onMute(until);
  return scheduler.status();
});
ipcMain.handle('talk:unmute', (e) => {
  if (!fromAppPage(e) || !setTalkPrefsFn || !scheduler) return null;
  setTalkPrefsFn({ talkMute: null });
  return scheduler.status();
});
ipcMain.handle('talk:sayStatus', (e) => (fromAppPage(e) && scheduler ? scheduler.status() : null));
// T-31 alpha.12 (PLAN-ZUMI-WATCH v2 F): Brain > Soul, Settings > Rhythm and the watcher's on/off. agent-core.mjs owns every
// decision (the Tauri sidecar serves the same handlers); these are sender-validated pass-throughs, null until whenReady.
let agentCore = null;
const agentCall = (name) => (e, ...args) => (fromAppPage(e) && agentCore ? agentCore.handlers[name](...args) : null);
ipcMain.handle('soul:get', agentCall('soul.get'));
ipcMain.handle('soul:save', agentCall('soul.save'));
ipcMain.handle('soul:undo', agentCall('soul.undo'));
ipcMain.handle('rhythm:get', agentCall('rhythm.get'));
ipcMain.handle('rhythm:pause', agentCall('rhythm.pause'));
ipcMain.handle('rhythm:reset', agentCall('rhythm.reset'));
ipcMain.handle('watch:set-level', (e, lv) => {
  if (!fromAppPage(e) || !agentCore) return null;
  const v = agentCore.handlers['watch.setLevel'](lv);
  if (hudHost) hudHost.start();
  return v;
});
// The renderer's "I am listening for speech:say" signal (say.js initSay). Idempotent: a renderer reload calls it again.
// Lines the scheduler emits before it are handed back as 'busy' (see the emit wrapper in whenReady), so none is lost silently.
ipcMain.handle('talk:sayReady', (e) => { if (!fromAppPage(e)) return false; sayReady = true; if (startTalkClock) startTalkClock(); return true; });
// The renderer's result for a proactive line: { sayId, spoken, reason }. 'busy' re-holds a P1 line (PLAN section 2).
ipcMain.handle('talk:sayAck', (e, p) => (fromAppPage(e) && scheduler && p ? scheduler.ack(p.sayId, { spoken: p.spoken !== false, reason: p.reason || null }) : { action: 'unknown' }));
// A whitelisted owner-triggered line (poked / patted / a new look). Never arbitrary text.
ipcMain.handle('talk:sayEvent', (e, name) => (fromAppPage(e) && sayEvent(name) ? true : false));
function sayEvent(name) {
  if (!scheduler || !['poke', 'pat', 'look'].includes(name)) return false;
  scheduler.enqueue('event', { event: name });
  return true;
}
// The board adapter (PLAN section 2): a hud-host reaction -> one scheduler line. A plain activity ping with no step
// change maps to nothing -- the old "task X has a new update" line is gone for good.
let lineFromReactionFn = null; // speech-scheduler.mjs lineFromReaction, loaded in app.whenReady
function boardReactionToSay(r) {
  const line = scheduler && lineFromReactionFn ? lineFromReactionFn(r) : null;
  if (line) scheduler.enqueue(line.kind, line.payload);
}
// TTS result shape is unchanged ({ ok, mime, audios: Buffer[], voice } | { ok:false, error }); the ROUTE, the provider
// registry and the replyOutcome rules live in src/main/talk-voice-core.mjs (step 8b freeze exception). The core's
// behaviour is the code that used to sit inline here, moved without a change; this handle only adds the sender check.
ipcMain.handle('talk:tts', (e, p) => (fromAppPage(e) ? talkVoice.tts(p) : refused));
// Settings > Voice progress row (and the E2E harness's "wait until the local voice is ready" step): where the
// Kokoro prefetch is. { state: idle|downloading|loading|ready|error|off, phase, loaded, total, error }. No secrets.
ipcMain.handle('talk:voiceState', (e) => {
  if (!fromAppPage(e)) return null;
  if (settingsShotsDir) return shotsVoiceState; // fixture: the shots never download the voice model
  if (!kokoroTts || !kokoroTts.available()) return { state: 'off', phase: null, loaded: 0, total: 0, error: null };
  return kokoroTts.status();
});
// Barge-in (item 6): stop synthesizing further Kokoro chunks for an abandoned turn. Fire-and-forget, no
// retryable/ack semantics -- the renderer already silenced playback itself before this ever arrives.
ipcMain.handle('talk:ttsAbandon', (e, p) => {
  if (fromAppPage(e) && kokoroTts && p && p.turnId) kokoroTts.abandon(p.turnId);
  return true;
});
// Settings line only: which voice this build speaks EN replies with. `voice` is a plain OS/model voice name,
// never a secret. Shape unchanged from before P1 ({ mode, voice }); VI/Leda status has its own line (below).
ipcMain.handle('talk:voiceInfo', async (e) => {
  if (!fromAppPage(e)) return null;
  if (cloud && cloud.status().enabled) return { mode: 'cloud', voice: null };
  if (kokoroTts && kokoroTts.available()) return kokoroTts.info(); // { mode: 'kokoro', voice: 'af_heart' }
  return localTts ? localTts.info() : { mode: 'off', voice: null };
});
// ---------- voice providers (T-31 talk-mode, PLAN section 10.3): the BYO provider frame ----------
// talk:voiceProviders -> [{ id, langs, paid, needsKey, hasKey }] (no secrets). These generic calls replace the old
// single-Leda pair, so the card can grow providers without one IPC each. A key never crosses back (only hasKey).
// The list, the key setters and testVoice are the core's own functions (step 8b freeze exception); the handles here
// add only the sender check. setProviderKey still answers a boolean; no key material is ever returned.
ipcMain.handle('talk:voiceProviders', (e) => (fromAppPage(e) ? talkVoice.providerList() : []));
ipcMain.handle('talk:setProviderKey', (e, id, raw) => (fromAppPage(e) ? talkVoice.setProviderKey(id, raw) : false));
ipcMain.handle('talk:clearProviderKey', (e, id) => (fromAppPage(e) ? talkVoice.clearProviderKey(id) : true));
// "Test voice" per language row (PLAN section 10.3 item 6): one short line through the provider chosen for that
// language, returned as audio so the card can PLAY it (a typed error becomes a plain reason, never a key). A paid
// provider is called exactly once per click.
ipcMain.handle('talk:testVoice', (e, p) => (fromAppPage(e) ? talkVoice.testVoice(p) : { ok: false, reason: 'forbidden' }));
// Guide links on the Voice card (PLAN 10.3 item 5). The page names a guide, never a URL: the fixed table lives in
// talk-voice-core.mjs (VOICE_GUIDES) and this handler only opens it through Electron's shell. They do not go through
// board-open.mjs decideExternalUrl, which is the rule for untrusted Board tab content.
ipcMain.handle('talk:openGuide', (e, id) => (fromAppPage(e) ? talkVoice.openGuide(id) : false));
// Turn records (user line, reply, analysis, gesture source, timings) are written only for self-test / demo runs, inside
// their own output folder, as QC evidence. Normal runs keep no conversation log.
ipcMain.handle('talk:log', (e, rec) => {
  if (!fromAppPage(e) || !runDir) return false;
  const line = JSON.stringify(rec);
  if (line.length > 64 * 1024) return false;
  fs.appendFileSync(path.join(runDir, 'turns.ndjson'), line + '\n');
  return true;
});

// ---------- usage (T-31 owner-admin + usage, Fable ruling 05-10): read-only summary of the ledger onUsage() above
// writes into. No write path from the renderer -- the ledger itself is only ever appended from the call sites in
// chat-brain.js / reflex-jev.js. { today: 'YYYY-MM-DD', rows: [{date, model, calls, ok, in, out, total, estCostUsd,
// priced}] } for today + the last 30 days (oldest with no calls simply contribute no rows).
ipcMain.handle('usage:summary', (e) => {
  if (!fromAppPage(e)) return { today: null, rows: [] };
  try {
    const { today, rows } = aggregateUsage(app.getPath('userData'), { days: 30 });
    return { today, rows: withEstimatedCost(rows) };
  } catch {
    return { today: null, rows: [] };
  }
});

// ---------- live board: secrets + PIN unlock + mode switch (T-31 L1) ----------
// Narrow, sender-validated IPC only (fromAppPage, reused from the talk wiring above). No secret, no PIN and no
// PIN-derived key ever crosses into the renderer/preload: board-live.mjs's getToken/getBasicAuth close over
// liveBoard.secrets.getSecrets() inside this process only; the handlers below pass the owner's own PIN through, not
// anything derived from it. `liveBoard` is set once board-live.mjs (ESM) is imported in app.whenReady below.
let liveBoard = null;
let idleTimer = null;
// board-reader.mjs (T-31 board-aware, owner brief 07-10): read-only digest of the SAME live board, through the
// SAME bridge liveBoard already owns — set once board-reader.mjs (ESM) is imported in app.whenReady below,
// right next to board-live.mjs.
let boardReader = null;
let boardReads = null; // board-reads.mjs (T-31 3a-3): Brain's three read-only calls; only built in a next-UI build
const onlyStrings = (o, keys) => Boolean(o) && typeof o === 'object' && keys.every((k) => typeof o[k] === 'string');
// "Require PIN for Board" (Settings toggle, owner request 08-10): settings.json's `requireBoardPin` is only the
// PREFERENCE for a FRESH setup (nothing configured yet) -- board-signin.js's first-run form reads it to decide
// whether to show the PIN field at all. Once secrets exist, the envelope's own `type` (board-secrets.mjs) is the
// ground truth, so board:status below never lets the settings.json value override a configured controller.
ipcMain.handle('board:status', (e) => {
  if (!fromAppPage(e) || !liveBoard) return { mode: 'local', configured: false, locked: true, pinRequired: true };
  const s = liveBoard.status();
  return s.configured ? s : { ...s, pinRequired: loadSettings().requireBoardPin !== false };
});
// Brain's read-only calls (T-31 3a-3, GATE-SEC-3a-3): registered ONLY in a next-UI build, so an OFF build has no handler at all (invoke rejects).
// Main window only (the Board guest is refused); before boardReads exists a caller gets a reason, not a hang.
if (NEXT_UI) {
  const early = () => (boardReads ? 'forbidden' : 'unconfigured');
  ipcMain.handle('board:state', (e) => (fromAppPage(e) && boardReads ? boardReads.state() : { ok: false, reason: early() }));
  ipcMain.handle('board:media', (e, id, opts) => (fromAppPage(e) && boardReads ? boardReads.media(id, opts) : { ok: false, reason: early() }));
  ipcMain.handle('board:open-ref', (e, ref) => (fromAppPage(e) && boardReads ? boardReads.openRef(ref) : { opened: false, reason: early() }));
}
ipcMain.handle('board:setSecrets', (e, p) => {
  if (!fromAppPage(e) || !liveBoard) return { ok: false, error: 'not_ready' };
  // token is optional (coordinator decision, auth-approved): absent/empty is fine, but if present it must be a string.
  if (!onlyStrings(p, ['user', 'pass', 'pin']) || (p.token !== undefined && typeof p.token !== 'string')) return { ok: false, error: 'bad_request' };
  return liveBoard.secrets.configure({ ...p, token: p.token || '' });
});
// Fresh setup with the PIN requirement off (board-signin.js's first-run form, when board:status said
// pinRequired:false): same shape as board:setSecrets minus `pin` -- never a PIN-toggle for an ALREADY-configured
// install, that is board:disablePin/board:enablePin below, which re-seal the existing secrets instead.
ipcMain.handle('board:setSecretsOs', (e, p) => {
  if (!fromAppPage(e) || !liveBoard) return { ok: false, error: 'not_ready' };
  if (!onlyStrings(p, ['user', 'pass']) || (p.token !== undefined && typeof p.token !== 'string')) return { ok: false, error: 'bad_request' };
  const r = liveBoard.secrets.configureOs({ ...p, token: p.token || '' });
  if (r.ok) saveSettings({ requireBoardPin: false }); // keeps the preference in sync for a later wipe+reconfigure
  return r;
});
ipcMain.handle('board:unlock', (e, pin) => {
  if (!fromAppPage(e) || !liveBoard) return { ok: false, error: 'not_ready' };
  if (typeof pin !== 'string') return { ok: false, error: 'bad_request' };
  return liveBoard.secrets.unlock(pin);
});
ipcMain.handle('board:lock', (e) => {
  if (!fromAppPage(e) || !liveBoard) return false;
  liveBoard.secrets.lock('manual');
  return true;
});
// Settings > "Require PIN for Board" toggle, ALREADY-configured install: re-seal the existing secrets, never ask
// for the board username/password again. A wrong current PIN changes nothing on disk (board-secrets.mjs).
ipcMain.handle('board:disablePin', (e, pin) => {
  if (!fromAppPage(e) || !liveBoard) return { ok: false, error: 'not_ready' };
  if (typeof pin !== 'string') return { ok: false, error: 'bad_request' };
  const r = liveBoard.secrets.disablePin(pin);
  if (r.ok) saveSettings({ requireBoardPin: false });
  return r;
});
ipcMain.handle('board:enablePin', (e, newPin) => {
  if (!fromAppPage(e) || !liveBoard) return { ok: false, error: 'not_ready' };
  if (typeof newPin !== 'string') return { ok: false, error: 'bad_request' };
  const r = liveBoard.secrets.enablePin(newPin);
  if (r.ok) saveSettings({ requireBoardPin: true });
  return r;
});
// Flips the PREFERENCE only -- refused once secrets are configured (the toggle must go through disablePin/enablePin
// above instead, which actually re-seal the envelope; flipping the bare preference there would desync it from the
// envelope's real `type`).
ipcMain.handle('board:setPinRequired', (e, on) => {
  if (!fromAppPage(e) || !liveBoard) return { ok: false, error: 'not_ready' };
  if (liveBoard.secrets.status().configured) return { ok: false, error: 'use_toggle' };
  saveSettings({ requireBoardPin: on !== false });
  return { ok: true };
});
// Settings > "Sign out of Board" (ported from the Tauri sidecar, T-31 OSS parity row 10): removes the stored user/pass/token
// (board-secrets.mjs signOut: idempotent, PIN rule = disablePin's) and drops the live board back to local, closing its
// bridge, so the Board tab reloads signed out. The PIN preference is left as the owner set it.
ipcMain.handle('board:signOut', async (e, pin) => {
  if (!fromAppPage(e) || !liveBoard) return { ok: false, error: 'not_ready' };
  if (pin !== undefined && pin !== null && typeof pin !== 'string') return { ok: false, error: 'bad_request' };
  const r = liveBoard.secrets.signOut(pin == null ? undefined : pin);
  // 'io' = the memory copy is already gone but a file delete failed: still stop the live board, report the error.
  if (r.ok || r.error === 'io') { await liveBoard.setMode('local'); liveBridgeOrigin = null; }
  return r;
});
ipcMain.handle('board:setMode', async (e, mode) => {
  if (!fromAppPage(e) || !liveBoard) return { ok: false, error: 'not_ready' };
  const r = await liveBoard.setMode(mode);
  if (r.ok && mode === 'local') liveBridgeOrigin = null; // leaving live mode: inBoard() stops recognising it
  return r;
});
// What the renderer's <webview> should load for the live board tab: a loopback bridge origin, never the live host
// itself (mirrors board:open for the local board). {error} outside live mode or while locked/unconfigured.
ipcMain.handle('board:live-open', async (e) => {
  if (!fromAppPage(e) || !liveBoard) return { error: 'not_ready' };
  const port = await liveBoard.bridgePort();
  if (!port) return { error: 'not_live' };
  liveBridgeOrigin = `http://127.0.0.1:${port}`;
  // openUrl carries a single-use nonce (the bridge's caller-auth, board-bridge.mjs sessionUrl): the FIRST load of the
  // webview only; reloads use origin + '/' with the HttpOnly cookie it set. The URL is dead after that load.
  return { origin: liveBridgeOrigin, partition: BOARD_LIVE_PARTITION, openUrl: await liveBoard.bridgeSessionUrl() };
});

// Room checker (T-31 R1/R3): room-check.mjs/room-fixtures.mjs are ESM (same pattern as board-live.mjs/laneboard-host.mjs
// above) -- set once app.whenReady's dynamic imports resolve.
let checkRoomFileFn = null;
let roomContentIdFn = null;
let generateBadRoomFixturesFn = null;
let tooBigFixtureFn = null;
let checkRoomJsonFileFn = null; // room standard v2 (T-31 camera modes) -- same module, one more export
// Room setting resolution (room-default.mjs, pure/Electron-free, testable from scripts/check-room.mjs).
let resolveRoomLaunchFn = null;
let roomPickPatchFn = null;
// room standard v2's own copy-on-success (coordinator final ruling 03-10, room-default-v2.mjs): one cache instance
// for this app's lifetime.
let ensureDefaultRoomV2CopyFn = null;
let sceneRooms = null; // video rooms (T-31 room picker): scene-rooms.mjs instance, set once at startup
let chairs3d = null; // 3D chair (T-31 chair3d): chair3d.mjs instance, set once at startup
let defaultRoomV2CacheObj = null;
// Root cause of the T-31 room-v2-load-hang (confirmed on the spare-PC repro, 2026-10-07): ensureDefaultRoomV2CopyFn
// is a SYNCHRONOUS read+sha256+copy over the whole v2-B asset set (room.json + 3 plates + occluders.glb, ~10MB).
// It used to be called straight from listRooms() (awaited by the renderer's own bootstrap Promise.all, before the
// model dropdown/loading UI even paints) AND from resolveAppPath() for every single app:// request under
// rooms/default-v2/* -- room.json, each plate, occluders.glb, all requested together by loadRoomV2. Before the
// cache warms, each of those concurrent callers independently re-ran the FULL expensive check+copy (the cache
// entry isn't set until the first one finishes), serialized on the one Electron main-process JS thread -- so N
// concurrent first-paint requests paid the cost N times over. That is what hung first paint (reproduced: room=
// 'none' never hung across repeated launches on the same hardware; room=default-v2 did, intermittently, with no
// dependency on window focus/minimize state -- that part of the original hypothesis did not hold up). Fixed below:
// the checker+copy now runs exactly ONCE, off the hot path, right after it is wired up in app.whenReady(); every
// caller awaits this SAME promise (getDefaultRoomV2) instead of re-invoking the checker, so concurrent callers
// coalesce onto one run instead of each paying the full cost. Dev builds (or developerMode on) still re-check live --
// Vesta's rooms:v2:save-view round-trip needs that -- only the packaged owner build is pinned to the one warm-up.
let defaultRoomV2Ready = null; // Promise<{sha, refused, cacheHit, ms}>, set once below
// ---------- talk-camera HUD (T-31 hud-react): prefs, the renderer's "listening" signal, and consent answers ----------
// hudHost is created in app.whenReady (hud-host.mjs). The renderer never names a file or URL: it answers an offer id.
let hudHost = null;
let askAnswerer = null; // hud-answer.mjs factory (T-31 0.2.3 batch C): the owner answering a board ask from the HUD
ipcMain.handle('hud:get-prefs', (e) => (fromAppPage(e) && hudHost ? hudHost.prefs() : { style: 'off' }));
ipcMain.handle('hud:set-prefs', (e, p) => (fromAppPage(e) && hudHost ? hudHost.setPrefs(p) : { style: 'off' }));
ipcMain.handle('hud:ready', (e) => { if (fromAppPage(e) && hudHost) hudHost.start(); return true; });
ipcMain.handle('hud:answer', async (e, id, yes) => {
  if (!fromAppPage(e) || !hudHost) return { opened: false, reason: 'forbidden' };
  const r = await hudHost.answer(id, yes);
  if (r.decision && r.decision.action === 'refuse') { console.warn(`[hud] open refused ${r.decision.reason}`); logRefusal(r.decision); }
  return { opened: r.opened, reason: r.reason || null };
});
// Inline board-ask answers (T-31 0.2.3 batch C): the owner picks an option / approve-reject / types a reply on a HUD
// ask card. The renderer names only { id, rev, choice|verdict|text }; askAnswerer fixes op = 'ask.answer', gates
// OWNER_ADMIN + live+unlocked, and relays through the SAME live board (liveBoard.relay). After a write lands, force a
// fresh board read so the feed shows the ask answered (server truth), never a false success.
ipcMain.handle('hud:answer-ask', async (e, payload) => {
  if (!fromAppPage(e) || !askAnswerer) return { ok: false, reason: 'forbidden' };
  const r = await askAnswerer.answer(payload || {});
  if (r.ok && hudHost) { try { await hudHost.poll({ maxAgeMs: 0 }); } catch { /* the periodic poll will catch up */ } }
  return r;
});

function liveReloadRoomV2() { return app.isPackaged === false || loadSettings().developerMode === true; }
function getDefaultRoomV2() {
  if (liveReloadRoomV2()) return Promise.resolve(ensureDefaultRoomV2CopyFn(defaultRoomV2CacheObj, roomV2DefaultPath(), defaultRoomV2Dir, { get: loadSettings, set: saveSettings }));
  return defaultRoomV2Ready;
}
function sendToRenderer(channel, payload) { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload); }

// Jev fast-reflex: on every Enter, before the (slower) /turn answer. Narrow, sender-validated IPC — the renderer
// gets only {reaction, confidence, source, ms}, never probabilities or the key. 900ms over budget on the app's
// side is enforced inside reflex-jev.js itself; this handler adds nothing further, so there is one timeout to reason about.
let reflexJev = null;
ipcMain.handle('reflexjev:classify', async (e, text) => {
  if (!fromAppPage(e) || !reflexJev) return { reaction: 'neutral', confidence: 0, source: 'neutral', ms: 0 };
  if (typeof text !== 'string' || !text.trim()) return { reaction: 'neutral', confidence: 0, source: 'neutral', ms: 0 };
  return reflexJev.classify(text.trim().slice(0, 2000));
});

// Gesture cache file: <data root>\gesture-cache\cache.json, next to the board data (survives reinstalls); self-tests
// keep it in their output folder. Main only stores the text; the renderer validates every entry when it loads it.
function gestureCacheFile() {
  if (runDir) return path.join(runDir, 'gesture-cache', 'cache.json'); // self-test / demo runs start with their own empty cache
  const candidates = [];
  if (app.isPackaged) candidates.push(path.join(path.dirname(path.dirname(process.execPath)), 'Zumi-data', 'gesture-cache'));
  candidates.push(path.join(app.getPath('userData'), 'gesture-cache'));
  return path.join(candidates.find(isWritableDir) || candidates[candidates.length - 1], 'cache.json');
}
ipcMain.handle('gcache:load', (e) => {
  if (!fromAppPage(e)) return null;
  try { return fs.readFileSync(gestureCacheFile(), 'utf8'); } catch { return null; }
});
ipcMain.handle('gcache:save', (e, text) => {
  if (!fromAppPage(e) || typeof text !== 'string' || text.length > 2_500_000) return false;
  const file = gestureCacheFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, text);
  fs.renameSync(`${file}.tmp`, file);
  return true;
});

// ---------- self-test ----------
const baselines = new Map();

function frameStats(buf) {
  // BGRA; luminance mean/std over all pixels
  let sum = 0, sum2 = 0;
  const n = buf.length / 4;
  for (let i = 0; i < buf.length; i += 4) {
    const l = 0.114 * buf[i] + 0.587 * buf[i + 1] + 0.299 * buf[i + 2];
    sum += l; sum2 += l * l;
  }
  const mean = sum / n;
  return { lumMean: mean, lumStd: Math.sqrt(Math.max(0, sum2 / n - mean * mean)) };
}

function frameDiff(a, b) {
  if (a.length !== b.length) return { changedPx: -1, changedPct: 0, meanAbs: 0, error: 'size-mismatch' };
  let changed = 0, total = 0;
  for (let i = 0; i < a.length; i += 4) {
    const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
    total += d;
    if (d > 24) changed++;
  }
  const n = a.length / 4;
  return { changedPx: changed, changedPct: (100 * changed) / n, meanAbs: total / n };
}

function registerSelftestIpc() {
  fs.mkdirSync(selftestDir, { recursive: true });
  const t0 = Date.now();
  const log = (m) => process.stdout.write(`[selftest +${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}\n`);
  log(`out=${selftestDir}`);
  log(`test model=${testModelPath || '(none)'}`);

  ipcMain.on('selftest:log', (_e, m) => log(String(m)));

  // Room fixtures (T-31 R3 selftest, PLAN-room.md §6 R3: "each bad fixture is refused with its message"). Generated
  // ONCE per run from the known-good room .glb fixture (room-paths.js roomGlbFixturePath; env ZUMI_ROOM_GLB_FIXTURE;
  // never committed, never written outside this run's own output folder)
  // and opened through the SAME importRoomFile() the real "Open room file…" dialog uses, so the selftest exercises
  // production code, not a parallel test path. good.glb is expected to succeed; the rest are expected refusals.
  let roomFixturesDir = null;
  const EXPECTED_REFUSAL = { 'too-big.glb': 'too_big', 'external-image.glb': 'external_uri', 'draco.glb': 'unsupported_compression', 'big-texture.glb': 'texture_too_big', 'bad-magic.glb': 'not_a_room_file' };
  ipcMain.handle('selftest:room-fixtures', () => {
    if (!roomFixturesDir) {
      roomFixturesDir = path.join(selftestDir, 'room-fixtures');
      fs.mkdirSync(roomFixturesDir, { recursive: true });
      const goodPath = roomPathsMod.roomGlbFixturePath(process.env.ZUMI_ROOM_GLB_FIXTURE);
      const goodBuf = fs.readFileSync(goodPath);
      fs.writeFileSync(path.join(roomFixturesDir, 'good.glb'), goodBuf);
      const bad = generateBadRoomFixturesFn(goodBuf);
      for (const [name, buf] of Object.entries(bad)) fs.writeFileSync(path.join(roomFixturesDir, name), buf);
      log(`room fixtures generated at ${roomFixturesDir}`);
    }
    return { names: ['good.glb', ...Object.keys(EXPECTED_REFUSAL), 'missing-anchors.glb'], expectedRefusal: EXPECTED_REFUSAL };
  });
  ipcMain.handle('selftest:room-open', (_e, name) => {
    if (!roomFixturesDir || !/^[\w.-]+\.glb$/.test(String(name))) return { error: { code: 'not_a_room_file', params: {} } };
    const imported = importRoomFile(path.join(roomFixturesDir, name));
    return imported.error ? { error: imported.error } : listRooms();
  });

  ipcMain.handle('selftest:capture', async (_e, name, opts = {}) => {
    const wc = opts.target === 'board' ? boardGuest : mainWindow.webContents;
    if (!wc) return { name, error: 'no-target' };
    const rect = opts.rect && {
      x: Math.round(opts.rect.x), y: Math.round(opts.rect.y),
      width: Math.round(opts.rect.width), height: Math.round(opts.rect.height),
    };
    const img = await wc.capturePage(rect);
    const buf = img.toBitmap();
    const scale = screen.getDisplayMatching(mainWindow.getBounds()).scaleFactor || 1;
    const size = img.getSize(scale);
    const out = { name, width: size.width, height: size.height, pixels: buf.length / 4, ...frameStats(buf) };
    out.blank = out.lumStd < 4 || out.lumMean < 3;
    if (opts.diffWith) {
      const base = baselines.get(opts.diffWith);
      out.diff = base ? frameDiff(buf, base) : { error: 'no-baseline' };
    }
    if (opts.keepAs) baselines.set(opts.keepAs, buf);
    if (opts.save) {
      const full = rect ? await wc.capturePage() : img;
      const file = path.join(selftestDir, path.basename(String(opts.save)).replace(/[^\w.-]+/g, '-'));
      fs.writeFileSync(file, full.toPNG());
      out.png = path.basename(file);
    }
    return out;
  });

  // Puts a small generated image on the OS clipboard, so the board test can paste it into the composer with a real
  // paste (webview.paste()), like a Win+Shift+S screenshot. Self-test only.
  ipcMain.handle('selftest:clipboard-image', async () => {
    const w = 96, h = 64, px = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4; // BGRA: a two-colour card, so the pasted image is visibly not blank
      const left = x < w / 2;
      px[i] = left ? 220 : 60; px[i + 1] = left ? 120 : 200; px[i + 2] = left ? 40 : 90; px[i + 3] = 255;
    }
    // Electron 44 clipboard: the async W3C-style API (write([ClipboardItem])) — writeImage() is gone. Several forms are
    // tried and reported, so the run says exactly what this Electron build / Windows session accepts.
    const png = nativeImage.createFromBitmap(px, { width: w, height: h }).toPNG();
    const tries = [];
    const attempt = async (label, make) => {
      try { await clipboard.write([make()]); const has = await clipboard.has('image/png'); let types = []; try { types = (await clipboard.read()).map((i) => i.types); } catch (e) { types = [`read failed: ${e.message}`]; } tries.push({ label, has, types }); return has; } catch (e) { tries.push({ label, error: String(e && e.message || e).slice(0, 160) }); return false; }
    };
    let textOk = null;
    try { await clipboard.writeText('zumi-selftest'); textOk = (await clipboard.readText()) === 'zumi-selftest'; } catch (e) { textOk = `error: ${e.message}`; }
    const ok = await attempt('Blob', () => new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) }))
      || await attempt('Promise<Blob>', () => new ClipboardItem({ 'image/png': Promise.resolve(new Blob([png], { type: 'image/png' })) }))
      || (typeof clipboard.writeImage === 'function' && (clipboard.writeImage(nativeImage.createFromBuffer(png)), tries.push({ label: 'writeImage (legacy)', has: true }), true));
    return { width: w, height: h, bytes: png.length, pngBase64: png.toString('base64'), hasPng: Boolean(ok), textOk, tries };
  });

  ipcMain.handle('selftest:emit-board', () => {
    mainWindow.webContents.send('reflex:event', { type: 'board-message', source: 'selftest', at: Date.now() });
    return true;
  });

  ipcMain.handle('selftest:board-log', async () => {
    const { readLegacyTasks } = await import(pathToFileURL(BOARD_HOST).href);
    const root = boardDataDirFor({ forSelftest: true });
    return {
      laneboard: laneboardVersion(),
      port: board && board.port,
      origin: board && board.origin,
      outcome: boardOutcome,
      root,
      dataDir: path.join(root, 'laneboard'),
      laneboardDirExists: fs.existsSync(path.join(root, 'laneboard')),
      legacyBefore: boardLegacyBefore,
      legacyAfter: { tasks: readLegacyTasks(root), files: hashFiles(root) },
      migrationReport: fs.existsSync(path.join(root, 'laneboard', 'migration-report.json')),
      normalRunDataDir: boardDataDirFor({ forSelftest: false }),
      guestUrl: boardGuest && !boardGuest.isDestroyed() ? boardGuest.getURL() : null,
      requests: boardRequests.slice(),
      net: netLog.slice(),
    };
  });

  ipcMain.handle('selftest:finish', (_e, report) => {
    const ok = Boolean(report && report.ok);
    const file = path.join(selftestDir, 'selftest.json');
    fs.writeFileSync(file, JSON.stringify({ ...report, exe: process.execPath, packaged: app.isPackaged, testModel: testModelPath }, null, 2));
    log(`finished ok=${ok} -> ${file}`);
    setTimeout(() => app.exit(ok ? 0 : 1), 200);
    return true;
  });

  setTimeout(() => {
    fs.writeFileSync(path.join(selftestDir, 'selftest.json'), JSON.stringify({ ok: false, error: 'timeout' }, null, 2));
    log('TIMEOUT');
    app.exit(2);
  }, SELFTEST_TIMEOUT_MS).unref();
}

// ---------- demo run (P9) ----------
function registerDemoIpc() {
  fs.mkdirSync(demoDir, { recursive: true });
  const t0 = Date.now();
  const log = (m) => process.stdout.write(`[demo +${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}\n`);
  log(`script=${demoScript} out=${demoDir} cloud=${demoFixture ? 'fixture (dry rehearsal)' : 'live'} model=${testModelPath || '(none)'}`);
  ipcMain.handle('demo:info', (e) => {
    if (!fromAppPage(e)) return null;
    try { return { lines: JSON.parse(fs.readFileSync(demoScript, 'utf8')), fixture: demoFixture }; } catch (err) { return { error: String(err.message) }; }
  });
  ipcMain.on('demo:log', (e, m) => { if (fromAppPage(e)) log(String(m).slice(0, 2000)); });
  ipcMain.handle('demo:capture', async (e, name) => {
    if (!fromAppPage(e)) return null;
    const img = await mainWindow.webContents.capturePage();
    const file = path.join(demoDir, path.basename(String(name)).replace(/[^\w.-]+/g, '-'));
    fs.writeFileSync(file, img.toPNG());
    return path.basename(file);
  });
  ipcMain.handle('demo:finish', (e, report) => {
    if (!fromAppPage(e)) return false;
    fs.writeFileSync(path.join(demoDir, 'demo.json'), JSON.stringify({ ...report, exe: process.execPath, packaged: app.isPackaged, testModel: testModelPath, net: netLog.slice() }, null, 2));
    log(`finished ok=${Boolean(report && report.ok)}`);
    if (!demoStay) setTimeout(() => app.exit(report && report.ok ? 0 : 1), 300);
    return true;
  });
  if (!demoStay) setTimeout(() => { fs.writeFileSync(path.join(demoDir, 'demo.json'), JSON.stringify({ ok: false, error: 'timeout' }, null, 2)); log('TIMEOUT'); app.exit(2); }, 20 * 60 * 1000).unref();
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  guardSession(session.defaultSession, 'main');
  guardSession(session.fromPartition(BOARD_PARTITION), 'board');
  // Same loopback-only guard as the local board: the live webview only ever talks to the bridge's 127.0.0.1 origin.
  // The bridge's OWN upstream call to the live origin (LIVE_ORIGIN) runs in this Node process (board-bridge.mjs's fetch),
  // not through Chromium's network stack, so it is outside this guard by construction — board-live.mjs pins that
  // egress to exactly LIVE_ORIGIN instead.
  guardSession(session.fromPartition(BOARD_LIVE_PARTITION), 'board-live');
  // webview-policy.mjs is ESM; main.js is CJS (same reason board-live.mjs/laneboard-host.mjs are dynamically imported above).
  ({ decideWebviewAttach: decideWebviewAttachFn } = await import(pathToFileURL(path.join(__dirname, 'webview-policy.mjs')).href));
  ({ appendRefusal: appendRefusalFn } = await import(pathToFileURL(path.join(__dirname, 'refusal-log.mjs')).href));
  ({ decideBoardOpen: decideBoardOpenFn, decideExternalUrl: decideExternalUrlFn } = await import(pathToFileURL(path.join(__dirname, 'board-open.mjs')).href));
  ({ checkRoomFile: checkRoomFileFn, roomContentId: roomContentIdFn, checkRoomJsonFile: checkRoomJsonFileFn } = await import(pathToFileURL(path.join(__dirname, 'room-check.mjs')).href));
  {
    // Video rooms (T-31 room picker): ZUMI_ROOMS_VIDEO_DIR (tests) > the packaged build's own copy (owner build's
    // extraResources) > the manifest's localDir, else the owner's video folder (owner-only values file; a dev run on the
    // owner's PC). No folder -> no video rooms listed.
    const { createSceneRooms } = await import(pathToFileURL(path.join(__dirname, 'scene-rooms.mjs')).href);
    sceneRooms = createSceneRooms({
      manifestPath: path.join(APP_ROOT, 'assets', 'rooms-video', 'rooms.json'),
      resolveVideoDir: (m) => (process.env.ZUMI_ROOMS_VIDEO_DIR ? path.resolve(process.env.ZUMI_ROOMS_VIDEO_DIR) : app.isPackaged ? path.join(process.resourcesPath, m.packagedDir) : (m.localDir || ownerValue('roomsVideoDir', null))),
      settings: { get: loadSettings, set: saveSettings },
      log: (m) => process.stdout.write(`[scenes] ${m}
`),
    });
  }
  {
    const { createChairs } = await import(pathToFileURL(path.join(__dirname, 'chair3d.mjs')).href);
    chairs3d = createChairs({
      manifestPath: path.join(APP_ROOT, 'assets', 'chair3d', 'chairs.json'),
      settings: { get: loadSettings, set: saveSettings },
      log: (m) => process.stdout.write(`[chair3d] ${m}
`),
    });
  }
  {
    const { resolveRoomLaunch, roomPickPatch } = await import(pathToFileURL(path.join(__dirname, 'room-default.mjs')).href);
    resolveRoomLaunchFn = resolveRoomLaunch;
    roomPickPatchFn = roomPickPatch;
  }
  {
    const { ensureDefaultRoomV2Copy, createDefaultRoomV2Cache } = await import(pathToFileURL(path.join(__dirname, 'room-default-v2.mjs')).href);
    ensureDefaultRoomV2CopyFn = ensureDefaultRoomV2Copy;
    defaultRoomV2CacheObj = createDefaultRoomV2Cache();
    // Kicked off here, once, off the hot path -- see getDefaultRoomV2's header above for why. Deferred a tick
    // (Promise.resolve().then) so it never blocks whatever runs synchronously right after this block; listRooms()
    // and resolveAppPath() both await this same promise instead of re-running the checker themselves.
    defaultRoomV2Ready = Promise.resolve().then(() => ensureDefaultRoomV2CopyFn(defaultRoomV2CacheObj, roomV2DefaultPath(), defaultRoomV2Dir, { get: loadSettings, set: saveSettings }));
  }
  ({ generateBadRoomFixtures: generateBadRoomFixturesFn, tooBigFixture: tooBigFixtureFn } = await import(pathToFileURL(path.join(__dirname, 'room-fixtures.mjs')).href));
  if (roomShotsDir || boardStressDir || settingsShotsDir) registerShotsIpc();
  if (settingsProbeDir) registerProbeIpc();
  protocol.handle('app', async (req) => {
    const full = await resolveAppPath(req.url);
    if (!full) return new Response('forbidden', { status: 403 });
    try {
      const data = await fs.promises.readFile(full);
      return new Response(data, { headers: { 'content-type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream' } });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });
  if (selftestDir) registerSelftestIpc();
  if (demoDir) registerDemoIpc();
  cloud = createCloud({
    mode: selftestDir || demoFixture ? 'fixture' : 'auto',
    base: CLOUD_BASE,
    fixtureFile: demoFixture ? DEMO_FIXTURES : CLOUD_FIXTURES,
    audioDir: demoFixture ? demoAudio : null,
    safeStorage,
    tokenDir: app.getPath('userData'),
    log: (m) => process.stdout.write(`[talk] ${m}\n`),
  });
  { const st = cloud.status(); process.stdout.write(`[talk] mode=${st.mode}${st.reason ? ` (${st.reason})` : ''}\n`); }
  // board-live.mjs is ESM; main.js is CJS, so it is imported dynamically (same pattern as laneboard-host.mjs above).
  const { createLiveBoard, isTestBuild, resolveBoardUpstream } = await import(pathToFileURL(path.join(__dirname, 'board-live.mjs')).href);
  const boardLiveLog = (m) => process.stdout.write(`[board-live] ${m}\n`);
  // ownerOps: the owner build's Board tab may set the per-task lane models (Plan/Code/Review/Scout chips); the release
  // build's bridge keeps refusing routing.*/roles.* with 403 (board-bridge.mjs OWNER_OPS, T-31 role-ui-port).
  const liveBoardArgs = { safeStorage, secretsDir: app.getPath('userData'), publicDir: path.join(LANEBOARD_DIR, 'public'), log: boardLiveLog, ownerOps: OWNER_ADMIN };
  // ZUMI_BOARD_UPSTREAM (test/selftest builds only, the L1 UI contract): release never reads it
  // (resolveBoardUpstream's isTestBuild=false branch ignores envOverride outright). A test build's override still
  // has to pass createLiveBoard's own loopback-only check; a bad one is refused there, not silently swapped in.
  const testBuild = isTestBuild({ packaged: app.isPackaged, zumiTestFlag: ZUMI_TEST_FLAG });
  testBuildRun = testBuild; // talk-mode: the ZUMI_TEST_SAY_SILENT hook is honoured only in a test build
  const { upstream, allowTestUpstream } = resolveBoardUpstream({ isTestBuild: testBuild, envOverride: process.env.ZUMI_BOARD_UPSTREAM });
  try {
    liveBoard = createLiveBoard({ ...liveBoardArgs, upstream, allowTestUpstream });
  } catch (e) {
    boardLiveLog(`ZUMI_BOARD_UPSTREAM refused (${e.message}); falling back to the real live board`);
    liveBoard = createLiveBoard(liveBoardArgs); // no override => LIVE_UPSTREAM, always valid
  }
  // board-reader.mjs (ESM, same dynamic-import pattern as board-live.mjs above): read-only digest builder on top
  // of the SAME liveBoard instance/bridge, never a second connection; falls back to BOARD_MIRROR (owner build
  // only) when the bridge is unavailable (T-31 board-aware, coordinator follow-up 07-10).
  const { createBoardReader } = await import(pathToFileURL(path.join(__dirname, 'board-reader.mjs')).href);
  // board-redact.mjs (ESM, same pattern): the owner's name list, seeded once, never overwritten again.
  const { seedRedactNamesIfMissing, loadRedactNames } = await import(pathToFileURL(path.join(__dirname, 'board-redact.mjs')).href);
  const redactNamesFile = path.join(app.getPath('userData'), 'redact-names.json');
  seedRedactNamesIfMissing(redactNamesFile);
  // CoS privacy decision 07-10: by default (sendClientNamesToAi unset/false) every name on that list is masked
  // before the digest reaches chat-brain.js. Mask word follows the owner's own UI language (settings.json uiLang).
  const getRedact = () => ({
    sendClientNames: loadSettings().sendClientNamesToAi === true,
    names: loadRedactNames(redactNamesFile),
    mask: loadSettings().uiLang === 'vi' ? '[khách hàng]' : '[client]',
  });
  // ZUMI_TEST_BOARD_MIRROR (test/owner builds only, same gate as ZUMI_BOARD_UPSTREAM above): a scratch fixture board for
  // the HUD harness (scripts/electron-hud.cjs), so a test run never reads the owner's real mirror. board-reader.mjs still
  // refuses anything that is not loopback http(s).
  const boardMirror = testBuild && process.env.ZUMI_TEST_BOARD_MIRROR ? process.env.ZUMI_TEST_BOARD_MIRROR : BOARD_MIRROR;
  boardReader = createBoardReader({ liveBoard, mirrorOrigin: boardMirror, getRedact, log: (m) => process.stdout.write(`[board-reader] ${m}\n`) });
  if (NEXT_UI) {
    const { createBoardReads } = await import(pathToFileURL(path.join(__dirname, 'board-reads.mjs')).href);
    const { decideOpenRef: decideRef } = await import(pathToFileURL(path.join(__dirname, 'board-open.mjs')).href);
    boardReads = createBoardReads({
      boardReader, liveBoard,
      fetchImpl: (url, init) => fetch(url, init),                       // explicit (C10), never a default
      decide: (ref) => decideRef(ref, { ownerAdmin: OWNER_ADMIN }),
      open: async (d) => {                                              // throws a fixed word: the shell's message is dropped here, never logged
        if (d.action === 'openPath') { const err = await shell.openPath(d.path); if (err) throw new Error('open_failed'); }
        else if (d.action === 'openExternal') await shell.openExternal(d.url);
        else throw new Error('open_failed');
      },
      logRefusal,                                                        // reason + origin only
      log: (m) => process.stdout.write(`[board-reads] ${m}\n`),
    });
  }
  // ---------- talk-mode (T-31, PLAN sections 1, 2, 7): the scheduler that decides how much Zumi talks ----------
  // speech-scheduler.mjs is pure (clock and signals injected). Main supplies the real signals (system idle, window
  // visibility, the board's waiting count) and sends each line it emits to the renderer as 'speech:say'; the renderer
  // answers with talk:sayAck. The one-time hudVoiceMuted -> talkLevel migration runs here, before anything reads prefs.
  {
    const { createSpeechScheduler, talkPrefs, setTalkPrefs, migrateTalkLevel, lineFromReaction } = await import(pathToFileURL(path.join(__dirname, 'speech-scheduler.mjs')).href);
    lineFromReactionFn = lineFromReaction;
    ownerVoiceFlag = readOwnerVoiceFlag(app.getPath('userData'));
    const mig = migrateTalkLevel(loadSettings());
    if (mig) saveSettings(mig);
    // settings.json is read a few times per scheduler decision, so one read is shared for half a second; every write
    // through setTalkPrefsFn drops it, so a change in Settings is seen by the very next decision.
    let cache = { at: 0, v: {} };
    const settingsNow = () => { const n = Date.now(); if (n - cache.at > 500) cache = { at: n, v: loadSettings() }; return cache.v; };
    talkPrefsFn = (st, now) => talkPrefs(st, now);
    setTalkPrefsFn = (patch) => setTalkPrefs(patch, { settings: loadSettings(), save: (next) => { saveSettings(next); cache = { at: 0, v: {} }; } });
    const idleSec = () => (testBuild && process.env.ZUMI_TEST_HUD_IDLE_SEC ? Number(process.env.ZUMI_TEST_HUD_IDLE_SEC) : powerMonitor.getSystemIdleTime());
    // T-31 alpha.12: soul, rhythm core, said.jsonl and the read-only board watcher (agent-core.mjs, shared with the sidecar).
    // The watcher's inbox relay is the live board's RELAY channel, owner build only (like the HUD ask answerer).
    const { createAgentCore } = await import(pathToFileURL(path.join(__dirname, 'agent-core.mjs')).href);
    agentCore = createAgentCore({
      dataDir: app.getPath('userData'), settings: loadSettings, saveSettings, idleSeconds: idleSec,
      say: (kind, payload) => (scheduler ? scheduler.enqueue(kind, payload) : { action: 'drop', reason: 'not_ready' }),
      relay: OWNER_ADMIN ? (op, body) => liveBoard.relay(op, body) : null,
      ownerBuild: OWNER_ADMIN,
      log: (m) => process.stdout.write(`${m}
`),
    });
    if (!selftestDir && !demoDir) agentCore.start();
    scheduler = createSpeechScheduler({
      prefs: settingsNow,
      signals: () => ({ idleSec: idleSec(), windowVisible, waitingCount: boardWaitingCount, watchCount: agentCore.watchCount() }),
      checkinHours: agentCore.checkinHours, onSaid: agentCore.onSaid, address: agentCore.address,
      // A line with no listener yet is handed back as busy (a P1 ask is re-held, the rest dropped) instead of vanishing.
      emit: (line) => { if (sayReady) sendToRenderer('speech:say', line); else queueMicrotask(() => scheduler.ack(line.sayId, { spoken: false, reason: 'busy' })); },
      log: (m) => process.stdout.write(`[speech] ${m}\n`),
    });
    // Started by talk:sayReady, so no line is emitted before the renderer can show it. Self-tests and demos run on
    // recorded answers: no clock-driven lines (morning, check-in, idle) in them, and the renderer skips initSay there.
    startTalkClock = () => {
      if (talkTick || selftestDir || demoDir) return;
      talkTick = setInterval(() => { try { scheduler.tick(); } catch (e) { process.stdout.write(`[speech] tick failed: ${(e && e.message) || e}\n`); } }, 1000);
      // The "new version" line: only when a previous version was recorded (not on the very first run).
      const prior = talkPrefs(loadSettings()).talkLastVersion;
      if (prior !== app.getVersion()) {
        setTalkPrefsFn({ talkLastVersion: app.getVersion() });
        if (prior) scheduler.enqueue('event', { event: 'updated', version: app.getVersion() });
      }
    };
  }
  // Talk-camera HUD (T-31 hud-react, hud-host.mjs): off until the owner picks a style in Settings (settings.json hudStyle).
  // Reads the board through the reader above; opens an acceptance file only on the owner's OK, through board-open.mjs's
  // allowlist (decideOpenRef), refusals logged like the board's own. Polling starts when the renderer says it listens.
  {
    const { createHudHost } = await import(pathToFileURL(path.join(__dirname, 'hud-host.mjs')).href);
    const { decideOpenRef } = await import(pathToFileURL(path.join(__dirname, 'board-open.mjs')).href);
    const { createAskAnswerer } = await import(pathToFileURL(path.join(__dirname, 'hud-answer.mjs')).href);
    const hudPoll = testBuild && Number(process.env.ZUMI_TEST_HUD_POLL_MS) >= 1000 ? Number(process.env.ZUMI_TEST_HUD_POLL_MS) : undefined;
    hudHost = createHudHost({
      getState: (o) => boardReader.getState(o),
      // ZUMI_TEST_HUD_IDLE_SEC (test builds only): a fixed idle time for the harness, which never touches the keyboard
      idleSeconds: () => (testBuild && process.env.ZUMI_TEST_HUD_IDLE_SEC ? Number(process.env.ZUMI_TEST_HUD_IDLE_SEC) : powerMonitor.getSystemIdleTime()),
      settings: { get: loadSettings, set: saveSettings },
      send: (payload) => sendToRenderer('hud:feed', payload),
      // talk-mode: the poll also runs while a talk level is on (PLAN F6), and each board change is mapped into the scheduler.
      talkActive: () => Boolean(talkPrefsFn) && talkPrefsFn(loadSettings()).talkLevel !== 'off',
      onReaction: (r) => boardReactionToSay(r),
      onBoardStatus: (ok) => { if (scheduler) scheduler.enqueue('event', { event: ok ? 'boardBack' : 'boardLost' }); },
      onWaiting: (n) => { boardWaitingCount = n; },
      onState: (state) => (agentCore ? agentCore.onBoardState(state) : null), // T-31 alpha.12 watcher + rhythm owner signals
      watchFeed: () => (agentCore ? agentCore.watchFeed() : []),
      decide: (ref) => decideOpenRef(ref, { ownerAdmin: OWNER_ADMIN }),
      // Inline answers (T-31 0.2.3 batch C): controls only in the owner build, and only writable while the board is
      // live AND unlocked (a locked / unconfigured / mirror board shows the read-only "enter the PIN" state).
      getAnswerState: () => { const s = liveBoard.status(); return { owner: OWNER_ADMIN, live: s.mode === 'live' && s.configured && !s.locked }; },
      open: async (d) => {
        if (d.action === 'openPath') { const err = await shell.openPath(d.path); if (err) console.warn(`[hud] openPath failed: ${err}`); }
        else if (d.action === 'openExternal') await shell.openExternal(d.url);
      },
      log: (m) => process.stdout.write(`[hud] ${m}\n`),
      ...(hudPoll ? { pollMs: hudPoll, cooldownMs: hudPoll } : {}),
    });
    // The owner's own ask.answer write: the SAME live board bridge (no new connection, no new op), owner-build +
    // live + unlocked gated (hud-answer.mjs). The renderer never names the op, origin or a credential.
    askAnswerer = createAskAnswerer({
      relay: (op, body) => liveBoard.relay(op, body),
      ownerAdmin: OWNER_ADMIN,
      boardStatus: () => liveBoard.status(),
      log: (m) => process.stdout.write(`[hud] ${m}\n`),
    });
  }
  // Lock triggers (PLAN-live-board.md §4): OS screen lock/suspend, and 15 min of system-wide idle, polled from the
  // one source of truth (powerMonitor.getSystemIdleTime()) rather than tracked separately per IPC call.
  powerMonitor.on('lock-screen', () => liveBoard.secrets.lock('os-lock-screen'));
  powerMonitor.on('suspend', () => liveBoard.secrets.lock('os-suspend'));
  idleTimer = setInterval(() => liveBoard.secrets.checkIdle(powerMonitor.getSystemIdleTime() * 1000), 30_000);
  // Usage ledger (T-31 owner-admin + usage): one onUsage hook, shared by both brains, writing into
  // <userData>/usage/YYYY-MM-DD.jsonl. appendUsage() already swallows its own fs errors; `log` just surfaces them.
  const onUsage = (rec) => appendUsage(app.getPath('userData'), rec, (m) => process.stdout.write(`[usage] ${m}\n`));
  reflexJev = createReflexJev({
    egressAllowed: REFLEX_JEV_EGRESS,
    safeStorage,
    dir: app.getPath('userData'),
    loadLocal: loadLocalReflexClassifier,
    callLedgerFile: REFLEX_JEV_CALL_LEDGER,
    callLedgerCap: REFLEX_JEV_CALL_CAP,
    onUsage,
    log: (m) => process.stdout.write(`[reflex-jev] ${m}\n`),
  });
  process.stdout.write(`[reflex-jev] egress=${REFLEX_JEV_EGRESS}${reflexJev.keyFile ? ` key=${fs.existsSync(reflexJev.keyFile) ? 'present' : 'absent'}` : ''}\n`);
  reflexJev.warm();
  // T-31 fix r item 1: freeze the provider choice now that the Jev import flow has run (an existing OpenRouter user is
  // pinned to OpenRouter; a key-less new user to DEFAULT_PROVIDER). Every later read takes this persisted value.
  pinAiProvider();
  migrateOpencodeModels(); // CORRECTION 17-10: retire saved *-free OpenCode ids
  process.stdout.write(`[chat-brain] provider pinned=${aiProviderId()}\n`);
  // model: the owner's own OpenRouter model id (settings.json `chatModel`, BYOK; no picker UI yet), else chat-brain's
  // default. chat-brain never switches it; it only pins the provider and turns reasoning off per request.
  // getRoute: the Do role of Settings > Models by role (role-models.js), read on every turn. getRoles: Plan / Check /
  // Look up, resolved against the provider list chat-brain cached for Settings (the --settings-shots run: the fixture
  // list), so a default Check model differs from Do's at run time exactly as the card shows it.
  // T-31 BYOK: built from the PERSISTED provider (settings.json `aiProvider`, pinned once at startup -- fix r item 1).
  // rebuildChatBrain re-runs this when the provider changes in Settings, so the
  // switch takes effect from the next turn with no restart.
  const buildChatBrain = () => createChatBrain({
    safeStorage, dir: app.getPath('userData'), ownerAdmin: OWNER_ADMIN, appVersion: app.getVersion(),
    onKeyResult: (check, usedLast4) => { if (brainKey) brainKey.noteChatResult(check, usedLast4); },
    // T-31 fix round item 3: in "Dùng miễn phí" the free table ids are always sent (incl. a legacy OpenRouter user),
    // so the paid `chatModel` is withheld; it applies only in "Tự nhập khoá" (byok). The label then matches the model.
    model: aiMode() === 'free' ? undefined : loadSettings().chatModel, onUsage,
    provider: aiProvider(), // chat-brain falls back to OpenRouter when absent; main always passes the resolved one
    legacyDefaults: aiLegacyDefaults(), // T-31 fix round 2 + round 3: pre-BYOK defaults apply only in byok mode
    getRoute: (defaultModel) => resolveRoles(loadSettings().roleModels, defaultModel).roles.do,
    getRoles: (defaultModel, models) => resolveRoles(loadSettings().roleModels, defaultModel, settingsShotsDir ? shotsRoleModels() : models).roles,
    getSoul: () => (agentCore ? agentCore.getSoul() : null), // T-31 alpha.12: the user's soul, read every turn
    fetchImpl: settingsShotsDir ? shotsChatFetch : undefined, // fake provider chat endpoint in the shots run only
    log: (m) => process.stdout.write(`[chat-brain] ${m}\n`),
  });
  chatBrain = buildChatBrain();
  rebuildChatBrain = buildChatBrain;
  process.stdout.write(`[chat-brain] mode=${chatBrain.status().mode} provider=${aiProviderId()} model=${chatBrain.status().model || 'n/a'} ownerAdmin=${OWNER_ADMIN}\n`);
  brainKey = createBrainKey({
    safeStorage, dir: app.getPath('userData'),
    fetchImpl: settingsShotsDir ? shotsProviderFetch : undefined, // fake provider endpoint in the shots run only
    getProvider: aiProviderId, // read per call: a provider switch takes effect at once
    log: (m) => process.stdout.write(`[brain-key] ${m}\n`),
  });
  // Free Windows voice, used only when the cloud talk transport is off (the no-cloud / BYO-key builds). Voice
  // enumeration is deferred to first use; `platform` is logged now so a check can tell which path a build took.
  localTts = createLocalTts({ tmpDir: path.join(app.getPath('userData'), 'tts-tmp'), log: (m) => process.stdout.write(`[local-tts] ${m}\n`) });
  process.stdout.write(`[local-tts] platform=${process.platform}\n`);
  // EN: Kokoro-82M fp16 in a worker_thread (T-31 voice P1 item 1). The prefetch below runs in that worker, so it
  // never blocks the main thread or the window from opening. Pre-building the pipeline plus one tiny synthesis at
  // start is live-E2E fix 1 (a cold worker on turn 1 of a new session cost first-audio p95 3352ms).
  kokoroTts = createKokoroTts({ userDataDir: app.getPath('userData'), log: (m) => process.stdout.write(`[kokoro-tts] ${m}\n`) });
  kokoroTts.setSpeed(talkVoice.voicePrefs().speed); // Settings > Voice > Speed (settings.json voiceSpeed)
  const kokoroProgress = (prog) => sendToRenderer('talk:kokoroProgress', prog);
  enTts = createEnTtsRouter({ kokoro: kokoroTts, sapi: localTts, onProgress: kokoroProgress, log: (m) => process.stdout.write(`${m}\n`), onMore: (m) => sendToRenderer('talk:ttsMore', m) });
  // T-31 QC-cuoi fix d (09-10, coordinator-approved scope): prefetch at app start, in the background -- downloads the
  // sha-pinned model if it is not on disk yet (this replaces "download on the first EN reply"), then pre-builds the
  // pipeline + one tiny synthesis (this replaces the old warm-up, which only ran for an already-downloaded model). Replies that arrive
  // before it is ready use the Windows voice (tts-router.js). Skipped when the owner turned voice off.
  // The --settings-shots run never downloads it: its voice row reads a fixture state (shotsVoiceState).
  if (loadSettings().voiceEnabled !== false && !settingsShotsDir) kokoroTts.prefetch(kokoroProgress);
  // VI: Google Cloud Chirp3-HD "Leda", the user's own key (item 3). No key -> VI stays text-only, by design.
  // T-31 talk-mode (PLAN 10.1): the provider registry. Each adapter owns its own DPAPI key file and reads its
  // non-secret config (voice name, model, URL) from settings.json on every call, so a change in the card applies at once.
  const voiceDir = app.getPath('userData');
  const voiceCfg = () => voiceConfig(loadSettings());
  const voiceLog = (name) => (m) => process.stdout.write(`[${name}] ${m}\n`);
  ledaTts = createLedaTts({ safeStorage, dir: voiceDir, getConfig: voiceCfg, log: voiceLog('leda-tts') });
  geminiTts = createGeminiTts({ safeStorage, dir: voiceDir, getConfig: voiceCfg, log: voiceLog('gemini-tts') });
  elevenTts = createElevenTts({ safeStorage, dir: voiceDir, getConfig: voiceCfg, log: voiceLog('elevenlabs-tts') });
  migrateLegacyCustomKey({ dir: voiceDir, config: voiceCfg(), log: voiceLog('custom-tts') }); // before either adapter reads its key file
  httpOpenaiTts = createHttpTts({ id: 'http-openai', shape: 'openai', langs: ['en', 'vi'], keyOptional: true, getConfig: voiceCfg, safeStorage, dir: voiceDir, log: voiceLog('http-openai-tts') });
  httpZumiaTts = createHttpTts({ id: 'http-zumia', shape: 'zumia', langs: ['en', 'vi'], keyOptional: true, getConfig: voiceCfg, safeStorage, dir: voiceDir, log: voiceLog('http-zumia-tts') });
  // The owner's Zumia cloud voice: a fixed URL constant, an imported owner key, vi only, and ONLY while owner-voice.json exists.
  if (ownerVoiceFlag) zumiaOwnerTts = createHttpTts({ id: 'zumia-owner', url: ZUMIA_OWNER_URL, langs: ['vi'], shape: 'zumia', keyOptional: true, keyImportFile: 'zumia-owner-tts-key.import', safeStorage, dir: voiceDir, log: voiceLog('zumia-owner-tts') });
  // T-31 0.2.8: a fresh profile (no `model` key) starts on the bundled default, before the renderer first asks models:list.
  try {
    const adopted = await adoptDefaultIfNoModelKey({ fs, crypto, loadSettings, saveSettings, listModels, dirs: defaultModelSearchDirs(), hasTestModel: !!testModelPath });
    process.stdout.write(`[default-model] first-run adopt: ${typeof adopted === 'string' ? adopted : adopted.error}
`);
  } catch (e) { process.stdout.write(`[default-model] first-run adopt failed: ${e && e.message}
`); }
  mainWindow = createWindow();
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.webContents.on('render-process-gone', (_e, d) => {
    if (selftestDir) {
      fs.writeFileSync(path.join(selftestDir, 'selftest.json'), JSON.stringify({ ok: false, error: `renderer gone: ${d.reason}` }, null, 2));
      app.exit(3);
    }
  });
  // Auto-update (T-31 auto-update, src/main/updater.mjs): OFF unless this build's package.json names a feed
  // (zumiUpdateFeed); without one electron-updater is never even loaded. Never during self-tests or demos.
  const { createUpdater, resolveFeed, createFileLog } = await import(pathToFileURL(path.join(__dirname, 'updater.mjs')).href);
  const appPkg = (() => { try { return JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')); } catch { return {}; } })();
  const { feed, reason } = resolveFeed({ pkg: appPkg, env: process.env });
  const updateLog = createFileLog(path.join(app.getPath('userData'), 'logs'));
  if (reason === 'feed_invalid') updateLog('error', 'zumiUpdateFeed is not a valid https feed URL; updates stay off');
  // Box e2e build only (zumiUpdateE2E, scripts/box-e2e-update.mjs): ZUMI_UPDATE_E2E=restart|quit stands in for the
  // click; ZUMI_UPDATE_INTERVAL_MS (>= 5 s) replaces the 6 h interval so a withdrawal/retry shows within a run.
  const e2e = appPkg.zumiUpdateE2E === true ? process.env.ZUMI_UPDATE_E2E : null;
  const e2eInterval = appPkg.zumiUpdateE2E === true && Number(process.env.ZUMI_UPDATE_INTERVAL_MS) >= 5000 ? Number(process.env.ZUMI_UPDATE_INTERVAL_MS) : undefined;
  updater = createUpdater({
    feed: selftestDir || demoDir ? null : feed,
    currentVersion: app.getVersion(),
    loadAutoUpdater: () => require('electron-updater').autoUpdater,
    send: sendToRenderer,
    getLang: () => loadSettings().uiLang || 'en',
    log: updateLog,
    intervalMs: e2eInterval,
    onReady: e2e === 'restart' ? () => updater.install() : e2e === 'quit' ? () => app.quit() : null,
  });
  updater.start();
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => { if (talkTick) clearInterval(talkTick); if (hudHost) hudHost.stop(); if (updater) updater.stop(); if (board) board.close(); if (idleTimer) clearInterval(idleTimer); if (liveBoard) liveBoard.close(); });

// ---------- Settings probe (scripts/check-settings-normal-launch.mjs) ----------
// One channel: the renderer's report of what Settings shows on a normal launch, written next to the probe's userData.
function registerProbeIpc() {
  ipcMain.handle('probe:finish', (_e, report) => {
    fs.writeFileSync(path.join(settingsProbeDir, 'probe.json'), JSON.stringify({ ...report, settingsShots: Boolean(settingsShotsDir), packaged: app.isPackaged }, null, 2));
    setTimeout(() => app.exit(0), 200);
    return true;
  });
  setTimeout(() => { process.stdout.write('[probe] TIMEOUT\n'); app.exit(2); }, 90 * 1000).unref();
}

// ---------- QC screenshot / stress runs (room T-31 R3, board-stress J-05 03-10, settings shots) ----------
// Own narrow IPC, registered only when --room-shots, --board-stress or --settings-shots is set (never shipped-on by
// default): the renderer drives itself (src/renderer/shots/room.js, board-stress.js or settings-roles.js), same shape as
// registerSelftestIpc above. The flags are mutually exclusive, so exactly one directory is ever active per run.
function registerShotsIpc() {
  const shotsDir = roomShotsDir || boardStressDir || settingsShotsDir;
  fs.mkdirSync(shotsDir, { recursive: true });
  const log = (m) => process.stdout.write(`[shots] ${m}\n`);
  ipcMain.handle('shots:capture', async (_e, name) => {
    const img = await mainWindow.webContents.capturePage();
    const file = path.join(shotsDir, path.basename(String(name)).replace(/[^\w.-]+/g, '-'));
    fs.writeFileSync(file, img.toPNG());
    log(`captured ${path.basename(file)}`);
    return path.basename(file);
  });
  ipcMain.on('shots:log', (_e, m) => log(String(m)));
  // Room shots only (T-31 R3 QC, the "03-bad-room-message" shot): one bad fixture (too-big, derived from the real
  // room .glb fixture, same generator check:room and the selftest use), opened through the same importRoomFile() the
  // real "Open room file…" dialog calls, so the refusal message on screen is the production message, not a mock.
  if (roomShotsDir) {
    ipcMain.handle('shots:bad-room', () => {
      const goodBuf = fs.readFileSync(roomPathsMod.roomGlbFixturePath(process.env.ZUMI_ROOM_GLB_FIXTURE));
      const bad = generateBadRoomFixturesFn(goodBuf)['too-big.glb'];
      const tmp = path.join(shotsDir, '_bad-room-too-big.glb');
      fs.writeFileSync(tmp, bad);
      const imported = importRoomFile(tmp);
      fs.unlinkSync(tmp);
      return imported;
    });
  }
  // Settings shots only (T-31 board-roles): the fixture provider on/off, for the "no provider yet" state.
  if (settingsShotsDir) {
    ipcMain.handle('shots:roles-provider', (_e, mode) => { shotsRoleProvider = ['on', 'one', 'off'].includes(mode) ? mode : 'on'; return shotsRoleProvider; });
    // Window resize for the narrowest-window shot; a request below minWidth/minHeight is clamped to the minimum.
    ipcMain.handle('shots:resize', (_e, w, h) => { mainWindow.setContentSize(Math.round(w), Math.round(h)); return mainWindow.getContentSize(); });
    // Settings A2 shots: the English voice model row's state ('downloading' at 64% | 'ready' | 'error' | 'off').
    ipcMain.handle('shots:voice-state', (_e, state) => {
      shotsVoiceState = state === 'downloading' ? { state, phase: 'model', loaded: 64, total: 100, error: null }
        : { state: ['ready', 'error', 'off'].includes(state) ? state : 'off', phase: null, loaded: 0, total: 0, error: null };
      return shotsVoiceState.state;
    });
    // Settings A2 shots: five days of sample ledger lines (chat + reflex model) in this run's own userData, written
    // in the real ledger format so usage:summary aggregates them exactly like real calls. Sample numbers, no text.
    ipcMain.handle('shots:seed-usage', () => {
      const days = [[41, 152000, 9100, 44, 13640, 528], [63, 231400, 14800, 66, 20460, 792], [27, 98200, 6000, 30, 9300, 360], [55, 201000, 12300, 58, 17980, 696], [12, 40100, 2500, 15, 4650, 180]];
      const dir = path.join(app.getPath('userData'), 'usage');
      fs.mkdirSync(dir, { recursive: true });
      days.forEach(([calls, inTok, outTok, jCalls, jIn, jOut], back) => {
        const day = new Date(Date.now() - back * 86400000);
        const lines = [];
        const add = (model, kind, n, i, o) => { for (let k = 0; k < n; k++) { const a = Math.round(i / n), b = Math.round(o / n); lines.push(JSON.stringify({ ts: day.toISOString(), model, kind, in: a, out: b, total: a + b, ms: 900, ok: true })); } };
        add('deepseek/deepseek-v4-flash', 'chat', calls, inTok, outTok);
        add('typesafe/jev-1.13', 'jev', jCalls, jIn, jOut);
        fs.writeFileSync(path.join(dir, `${localDate(day)}.jsonl`), `${lines.join('\n')}\n`);
      });
      return days.length;
    });
  }
  ipcMain.handle('shots:finish', (_e, report) => {
    log(`finished ok=${Boolean(report && report.ok)}`);
    setTimeout(() => app.exit(report && report.ok ? 0 : 1), 200);
    return true;
  });
  setTimeout(() => { log('TIMEOUT'); app.exit(2); }, 8 * 60 * 1000).unref(); // full gate measured 123-160s; margin for a slower item/machine
}
