// T-31 P1a sidecar — JSON-RPC 2.0 server over stdio.
//
// Started by the Tauri host (tauri/src-tauri/src/lib.rs) as a child process:
//   node tauri/sidecar/main.mjs --data-dir <preview app_data_dir> [--resources-dir <resource root>]
// In a bundled run the host spawns the pinned bundled Node and names the resource root (step 7-1).
// It reads NDJSON requests on stdin, writes NDJSON responses on stdout, and logs to stderr. Every
// method not in HANDLERS is rejected with `not_implemented:<name>` — never a faked success.
//
// Implemented end to end in P1a (the "few APIs working"): settings get/set for a few keys
// (uiLang, developerMode), the app version (info), and one pure read (roles.get). Everything else is
// intentionally unimplemented and says so.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';

import {
  createEmitter,
  ERR_INTERNAL,
  ERR_INVALID_REQUEST,
  ERR_METHOD_NOT_FOUND,
  error,
  MAX_REQUEST_FRAME_BYTES,
  notImplemented,
  ok,
  ready,
  serializeResponse,
} from './protocol.mjs';
import { createBootReads } from './boot-reads.mjs';
import { createHostSignals } from './host-signals.mjs';
import { createVaultSafeStorage } from './vault-adapter.mjs';
import { resolveFlavour } from './flavour.mjs';
import { createLibrary } from './library.mjs';
import { createAiSettings } from './ai-settings.mjs';
import { presetList } from './free-llm-presets.mjs';
import { createImportRpc, detectProfileForHost } from './profile-import.mjs';
import { createAiCore } from './ai-core.mjs';
import { createChatHost } from './chat-host.mjs';
import { createMemoryNotes } from './memory-notes.mjs';
import { createSpeechHost } from './speech-host.mjs';
import { createAgentCore } from '../../src/main/agent-core.mjs';
import { createVoiceHost } from './voice-host.mjs';
import { createBoardHost } from './board-host.mjs';
import { createHudHost, createHostOpen, hudPollMs } from './hud-host-tauri.mjs';
import { createBrainReads } from './board-reads-host.mjs';
import { createHostCalls } from './host-calls.mjs';
import { linkList, linkVerdict } from './links.mjs';
import { createSelfTestHost, parseSelfTestArgs } from './selftest-host.mjs';
import { createShotsFixtures } from './shots-fixtures.mjs';
import { adoptDefaultOnBoot, createRestoreDefault } from './default-model-boot.mjs';
import { providerFetch, guardedFetch, PROVIDER_ORIGINS, cloudFetch, mirrorFetch, jevFetch, ttsFetch, marketFetch, selfTestFetch, isSelfTestRun } from './egress.mjs';
import { createMarketHost } from './market-host.mjs';
import { STORE_KEYS, storeSource } from './market-keys.mjs';
import { readOwnerVoiceFlag, voiceProviderPrefs } from '../../src/main/tts-select.js';
import { phoneAiAndRedact } from './phone-extras.mjs';
import {
  appVersion,
  boardDataRoot,
  boardSamplePath,
  appendRefusal,
  decideExternalUrl,
  decideWebviewAttach,
  laneboardDir,
  laneboardVersion,
  modelsDir,
  openLocalBoard,
  providers,
  readSettings,
  repoRoot,
  saveSettings,
} from './adapters.mjs';

// Bound a single frame so a runaway line cannot exhaust memory. The caps are per direction (protocol.mjs).
const MAX_FRAME_BYTES = MAX_REQUEST_FRAME_BYTES;

function fail(message) {
  process.stderr.write(`[sidecar] fatal: ${message}\n`);
  process.exit(2);
}

// `line` is a frame object, or an already serialized frame string (serializeResponse stringifies once).
function writeLine(line) {
  try {
    process.stdout.write(`${typeof line === 'string' ? line : JSON.stringify(line)}\n`);
  } catch (e) {
    // EPIPE: the host is gone. Nothing useful to do; exit so we do not linger as an orphan.
    process.stderr.write(`[sidecar] stdout write failed: ${e}\n`);
    process.exit(0);
  }
}

// A frame the sidecar cannot parse, or that exceeds MAX_FRAME_BYTES, has no usable id, so it cannot be
// answered with a request-scoped JSON-RPC error. Emit a `fatal` notification instead: the host treats
// it as an unrecoverable protocol error, fails every pending call at once and stops the sidecar — so a
// corrupted stream fails fast instead of leaving calls to time out.
function fatalFrame(message) {
  process.stderr.write(`[sidecar] fatal frame: ${message}\n`);
  writeLine({ jsonrpc: '2.0', method: 'fatal', params: { message } });
}

// --data-dir is REQUIRED and must be absolute: the sidecar must never guess a writable path, because
// a guess could land on Electron's userData. The host always passes the preview data dir explicitly.
function parseDataDir(argv) {
  const i = argv.indexOf('--data-dir');
  const dir = i >= 0 ? argv[i + 1] : null;
  if (!dir) fail('missing --data-dir');
  if (!path.isAbsolute(dir)) fail(`--data-dir must be absolute: ${dir}`);
  return dir;
}

// Dev/test-only avatar source (parity step 3 box trace: no model ships, so nothing rendered). `--test-model <abs .vrm>` is
// Electron's `--model` (main.js:148): a listed, selected, never-persisted slot. It is read from the ARGV only, never from
// the environment: the Rust host adds the argument only when it was started with --model / ZUMI_TEST_MODEL (Electron's
// switch, honoured by every build). Anything not absolute or not a `.vrm` is ignored.
/**
 * Electron main.js:1845-1848: a --selftest run answers the talk path from src/main/cloud-fixtures.json and a
 * --demo-fixture rehearsal from demo-fixtures.json (no server, no device token); every other launch returns null and
 * keeps the real cloud transport. Argv-only, like every test mode. (--demo-audio is not forwarded by the host, so a
 * fixture rehearsal has no offline voice files here.)
 */
export function cloudFixtureFor(selfTest) {
  if (selfTest && selfTest.selftest) return path.join(repoRoot, 'src', 'main', 'cloud-fixtures.json');
  if (selfTest && selfTest.demo && selfTest.demo.fixture) return path.join(repoRoot, 'src', 'main', 'demo-fixtures.json');
  return null;
}

export function parseTestModel(argv) {
  const i = argv.indexOf('--test-model');
  const p = i >= 0 ? argv[i + 1] : null;
  return p && path.isAbsolute(p) && /\.vrm$/i.test(p) ? p : null;
}

// --app-version <semver>: the version the INSTALLER was built with, passed by the Rust host from its own package info
// (parity step 7-4). A packaged sidecar ships no package.json, so without this it would report 0.0.0 in the handshake and
// `info.version`. A dev launch passes it too (the host always knows); package.json stays the fallback when it is absent.
export function parseAppVersion(argv) {
  const i = argv.indexOf('--app-version');
  const v = i >= 0 ? argv[i + 1] : null;
  return typeof v === 'string' && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(v) ? v : null;
}

// --no-voice-prefetch: a fixture run (a check, a probe with no model on disk) passes this so it never starts the ~163 MB
// Kokoro download at start. A real preview launch does not pass it, so voice-on start-up prefetches (R1b: as before R1).
// --measure-stub-provider: the first-answer-time metric's offline chat provider (measure-stub.mjs). Argv only: no
// setting, no env var. The module is imported ONLY when this is true and is left out of the staged public bundle
// (tauri/stage-bundle.mjs STAGE_EXCLUDED), so a user build that is handed the flag refuses to start instead.
export function parseMeasureStubProvider(argv) {
  return argv.includes('--measure-stub-provider');
}

/**
 * The stub exists for one run kind: the demo run that times first answers. selftest (expects the cloud fixture), shots and
 * a normal launch refuse it, so a combined launch fails loudly instead of silently changing what another mode measures.
 * @returns {string|null} the refusal, or null when the stub may run
 */
export function measureStubModeError(selfTest) {
  return selfTest && selfTest.demo && !selfTest.selftest ? null : '--measure-stub-provider only runs with --demo-script/--demo-out';
}

export function parseVoicePrefetch(argv) {
  return !argv.includes('--no-voice-prefetch');
}

// --now-ms: the one injectable clock. The time-of-day paths this process owns (the talk scheduler's quiet hours,
// idle lines and daily rollover, the HUD's cooldowns) read `ctx.now`, which defaults to the real clock. A check
// passes --now-ms so local time is a fixed value instead of the machine's wall clock; a real launch (the Rust host
// passes only --data-dir) never does, so product behaviour is Date.now.
export function parseClockMs(argv) {
  const i = argv.indexOf('--now-ms');
  const ms = i >= 0 ? Number(argv[i + 1]) : NaN;
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

// --resources-dir <abs>: the app's resource root (Tauri's resource_dir(); on Windows the main exe's directory). The
// bundled voice modules live under <root>/voice-modules, the same layout Electron's extraResources produce, and
// src/main/kokoro-tts.js keys on process.resourcesPath -- a property plain Node does not define. Absent/invalid = a
// dev run, which uses normal node_modules resolution.
export function parseResourcesDir(argv) {
  const i = argv.indexOf('--resources-dir');
  const dir = i >= 0 ? argv[i + 1] : null;
  return dir && path.isAbsolute(dir) && fs.existsSync(dir) ? dir : null;
}

// Titles and step labels of the old v0.2 board, so a refusal is told in the owner's words instead of
// codes. Read-only; {} when the file is unreadable. Copied from src/main/main.js:886 legacyNames().
function legacyNames(root) {
  try {
    const out = {};
    for (const t of JSON.parse(fs.readFileSync(path.join(root, 'tasks.json'), 'utf8'))) {
      out[t.code] = { title: String(t.title || ''), steps: Object.fromEntries((t.steps || []).map((s, i) => [s.id, { n: i + 1, label: String(s.label || '') }])) };
    }
    return out;
  } catch { return {}; }
}

// Parity step 5: the secrets-vault helper. The Rust host passes `--vault-exe <abs zumi-vault.exe>` and `--host-dir <abs dir of
// the host exe>` only when the helper sits beside it; vault-adapter.mjs re-validates both (absolute, exact file name, same
// dir) and answers isEncryptionAvailable() === false otherwise. Absent arguments are the same "no vault" state, never a guess.
export function parseVaultArgs(argv) {
  const at = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
  return { vaultExe: at('--vault-exe'), hostDir: at('--host-dir'), flavourPath: at('--flavour') };
}

// Exact-origin match ONLY, mirroring src/main/webview-policy.mjs sameOrigin(): a prefix match would let
// `http://127.0.0.1:4212evil.example` pass for origin `http://127.0.0.1:4212`. `matchedOrigin` returns
// the origin the src belongs to (live > board, the policy's own precedence), or null.
function sameOrigin(src, origin) {
  return Boolean(origin) && (src === origin || src.startsWith(origin + '/'));
}
function matchedOrigin(src, boardOrigin, liveBridgeOrigin) {
  if (sameOrigin(src, liveBridgeOrigin)) return liveBridgeOrigin;
  if (sameOrigin(src, boardOrigin)) return boardOrigin;
  return null;
}

// The live bridge's own routes on a loopback host (board-bridge.mjs SESSION_PATH, board-open.mjs OPEN_PATHNAME).
function isBridgeRoute(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  return ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) && (u.pathname === '/__zumi-open' || u.pathname === '/__bridge-session');
}

/** The guard probe's stand-in origin (tauri/verify/run-guard-probe.ps1), or null. Render box only, loopback http only.
 *  Since alpha.11 there is no wardrobe guest to carry the probe page, so the runner names this origin instead. */
/** ui.getLang: the saved uiLang, else the renderer's OS-locale hint (i18n.js osUiLang; first run only), else English. Pure. */
export function uiLangOf(stored, fallback) {
  const ok = (l) => l === 'vi' || l === 'zh' || l === 'en';
  return ok(stored) ? stored : ok(fallback) ? fallback : 'en';
}

export function guardProbeOriginOf(env) {
  if (!env || env.ZUMI_ELECTRON_HOST !== 'box' || !env.ZUMI_GUARD_PROBE_ORIGIN) return null;
  let u;
  try { u = new URL(env.ZUMI_GUARD_PROBE_ORIGIN); } catch { return null; }
  return u.protocol === 'http:' && u.hostname === '127.0.0.1' && u.port ? u.origin : null;
}
const guardProbeOrigin = guardProbeOriginOf(process.env);

function buildHandlers(ctx) {
  const settings = () => readSettings(ctx.dataDir);
  // Refusals land in <preview data dir>/logs/board-open-refusals.log (reason + origin only, capped), the
  // same helper and file name Electron writes under its userData. A write failure never changes a verdict.
  const logRefusal = (d) => {
    try { appendRefusal(path.join(ctx.dataDir, 'logs'), d); } catch (e) { process.stderr.write(`[sidecar] refusal log write failed: ${(e && e.code) || 'error'}\n`); }
  };
  // The opened local board (cached like main.js startBoard) and its in-flight open. A refused v0.2
  // import is NOT cached, so the next call retries.
  let board = null;
  let boardStarting = null;
  let boardOutcome = null; // self-test only (main.js:538): what the last open did
  // Step 12-1: the test-only families. Modes come from the CLI only (ctx.selfTest); outside them every one of the 21
  // handlers answers `not_available`. Created here because its board snapshot must happen before the first open.
  const st = createSelfTestHost({
    modes: ctx.selfTest, dataDir: ctx.dataDir, settings, log: (m) => process.stderr.write(`${m}\n`),
    emit: ctx.emit, hostCall: ctx.hostCalls.call, shotsFixtures: ctx.shotsFixtures || null, testModel: ctx.testModelPath || null,
    getLibrary: () => lib, getBoard: () => board, getBoardOutcome: () => boardOutcome,
  });
  // The renderer's boot path (step 3): models, clips, rooms, scenes, chairs, talk status, prefs reads.
  const boot = createBootReads({
    dataDir: ctx.dataDir,
    settings,
    saveSettings: (patch) => saveSettings(ctx.dataDir, patch),
    log: (m) => process.stderr.write(`[sidecar] ${m}
`),
    testModelPath: ctx.testModelPath || null,
    ownerFlag: () => readOwnerVoiceFlag(ctx.dataDir), // 0.2.9 parity: only owner-voice.json, never the flavour
  });

  // Models / rooms / gestures, the write side (step 4). The emitter is the one push path to the renderer.
  const lib = createLibrary({
    settings,
    saveSettings: (patch) => saveSettings(ctx.dataDir, patch),
    boot,
    emit: ctx.emit,
    log: (m) => process.stderr.write(`[sidecar] ${m}
`),
    gestureTimeoutMs: ctx.gestureTimeoutMs,
  });
  // Step 6: the provider settings, pinned once HERE (before the chat brain reads them) and rebuilt on a mode/provider
  // change, exactly like main.js's pinAiProvider + rebuildChatBrain.
  let chatHost = null;
  const ai = createAiSettings({
    dataDir: ctx.dataDir, settings, saveSettings: (patch) => saveSettings(ctx.dataDir, patch),
    onChange: () => { if (chatHost) chatHost.rebuild(); },
    ownerBuild: ctx.flavour.values.ownerAdmin === true,
    // Step 12-runtime: the --settings-shots fixture is an OpenRouter provider (fake key shape/endpoint). CLI mode only.
    shotsProvider: ctx.measureStub ? ctx.measureStub.providerId : ctx.shotsFixtures ? 'openrouter' : null,
  });
  ai.pin();
  ai.migrateOpencodeModels();
  // Step 6 (network half): the one egress seam. The provider set is derived in egress.mjs; cloud/Jev/mirror exist only
  // when the resolved flavour sets them. The global fetch is handed to the guard HERE, nowhere else (GATE-4).
  const egressLog = (m) => process.stderr.write(`[sidecar] ${m}
`);
  const rawFetch = (url, init) => globalThis.fetch(url, init);
  // Any self-test mode: loopback only (refused + logged otherwise); a normal launch hands the global fetch through as before.
  const baseFetch = isSelfTestRun(ctx.selfTest) ? selfTestFetch(rawFetch, egressLog) : rawFetch;
  const reflexEgress = ctx.flavour.values.reflexEgress === true;
  const aiCore = createAiCore({
    ai, secretStores: ctx.secretStores, dataDir: ctx.dataDir, logRefusal,
    log: (m) => process.stderr.write(`[sidecar] ${m}
`),
    reflexEgress, jevFetch: jevFetch(baseFetch, reflexEgress, egressLog),
  });
  // Step 6-pre (F6): idle / window-visible / OS lock+suspend, PUSHED by the Rust host and cached for sync readers
  // (steps 8a, 9, 10a). Created before the board host so its lock triggers subscribe to the same cache.
  const signals = createHostSignals();
  // Step 10a: the live board (secrets, PIN unlock, status). Built before the chat host so the board digest in a talk
  // turn reads the SAME liveBoard instance the Board tab's rpcs use (Electron builds one too: main.js:1856+).
  const boardHost = createBoardHost({
    safeStorage: ctx.safeStorage, dataDir: ctx.dataDir, flavour: ctx.flavour,
    settings, saveSettings: (patch) => saveSettings(ctx.dataDir, patch),
    log: (m) => process.stderr.write(`[board-live] ${m}
`),
    signals,
    // Step 12-runtime finding 5: no idle re-lock in a self-test/shots run (a headless box is "idle" the whole time).
    idleLock: !ctx.selfTest || !(ctx.selfTest.selftest || ctx.selfTest.demo || ctx.selfTest.shots || ctx.selfTest.probe),
    // T-31-MOBILE M4/M5: what the phone shares with this PC besides the board login (host-only; read at pairing time,
    // after chatHost exists). Only the selected brain provider's key (F3); voice prefs are non-secret. The owner route's
    // key is not shared (tts-http.js zumia-owner).
    phoneExtras: () => {
      const s = settings();
      const owner = readOwnerVoiceFlag(ctx.dataDir) === true;
      const vp = voiceProviderPrefs(s, { ownerFlag: owner });
      const shared = chatHost ? phoneAiAndRedact(chatHost.phoneRedact(), () => chatHost.phoneAi()) : { ai: null, redact: [] };
      if (chatHost && !shared.ai) process.stderr.write('[board-live] phone pairing: no AI key shared (none saved, or the client-name list is unreadable or too long)\n');
      return {
        ...shared,
        voice: { owner, voiceProviderVi: vp.voiceProviderVi, voiceProviderEn: vp.voiceProviderEn, voiceReplyLang: vp.voiceReplyLang, talkVoiceLang: s.talkVoiceLang === 'vi' ? 'vi' : 'en' },
      };
    },
  });
  const mirrorEgress = mirrorFetch(baseFetch, ctx.flavour.values.boardMirror, egressLog);
  // board-reader.mjs asks exactly two URLs: the live bridge on its CURRENT loopback port, and the flavour's fixed
  // mirror origin. Electron's reader uses the global fetch for both; the step-6 guard is pinned to the mirror origin,
  // so it would refuse the dynamic bridge port (every live read "offline"). The bridge URL is therefore rebuilt here
  // from the same liveBoard the reader reads, and only an exact match takes the one base fetch; anything else keeps
  // the guard. This is the transport step 9's HUD getState (and chat's digest) rely on; no other URL can reach it.
  const boardReaderFetch = async (url, init) => {
    const port = await boardHost.liveBoard.bridgePort().catch(() => null);
    if (port && url === `http://127.0.0.1:${port}/api/v1/state`) return baseFetch(url, { ...(init || {}), headers: { ...((init && init.headers) || {}), ...(await boardHost.liveBoard.bridgeHeaders()) }, redirect: 'error' });
    return mirrorEgress(url, init);
  };
  // T-31 alpha.12 (PLAN-ZUMI-WATCH v2 F): soul, rhythm core, said.jsonl and the read-only board watcher, built once in
  // src/main/agent-core.mjs exactly as Electron builds them. `say` reaches the 8a scheduler created below (bound lazily);
  // the watcher's inbox relay is the live board's RELAY channel, owner flavour only (like the HUD ask answerer).
  let speech = null;
  const agent = createAgentCore({
    dataDir: ctx.dataDir, settings, saveSettings: (patch) => saveSettings(ctx.dataDir, patch),
    idleSeconds: () => signals.idleSeconds(), now: ctx.now,
    say: (kind, payload) => (speech ? speech.scheduler.enqueue(kind, payload) : { action: 'drop', reason: 'not_ready' }),
    relay: ctx.flavour.values.ownerAdmin === true ? (op, body) => boardHost.liveBoard.relay(op, body) : null,
    ownerBuild: ctx.flavour.values.ownerAdmin === true,
    log: (m) => process.stderr.write(`[sidecar] ${m}
`),
  });
  // launch-scope memory: the user's notes in <dataDir>/memory/memory.db (the crate's schema). memory.* rpcs below; recall in talk.turn.
  const memory = createMemoryNotes({ dataDir: ctx.dataDir, now: ctx.now, log: (m) => process.stderr.write(`[sidecar] ${m}\n`) });
  chatHost = createChatHost({
    getSoul: () => agent.getSoul(), onReplyOk: () => agent.onChat(), appVersion: ctx.version, memory,
    dataDir: ctx.dataDir, settings, saveSettings: (patch) => saveSettings(ctx.dataDir, patch), ai, secretStores: ctx.secretStores,
    safeStorage: ctx.safeStorage, flavour: ctx.flavour, emit: ctx.emit, aiCore, log: egressLog,
    liveBoard: boardHost.liveBoard,
    boardFetch: boardReaderFetch,
    // Step 12-1: the --settings-shots fixtures only (CLI mode); null on every normal launch.
    roleFixture: ctx.shotsFixtures ? ctx.shotsFixtures.roleFixture : null,
    chatFetch: ctx.shotsFixtures ? ctx.shotsFixtures.chatFetch : null,
    providerFetch: ctx.shotsFixtures ? ctx.shotsFixtures.providerFetch : null,
    cloudFixtureFile: cloudFixtureFor(ctx.selfTest),
    egress: {
      // The measure stub swaps only the transport BENEATH the same guard (its own origin added; redirects refused as ever).
      provider: ctx.measureStub
        ? guardedFetch(ctx.measureStub.fetch, [...PROVIDER_ORIGINS, ctx.measureStub.egressOrigin], egressLog)
        : providerFetch(baseFetch, egressLog),
      cloud: cloudFetch(baseFetch, ctx.flavour.values.cloudBase, egressLog),
      mirror: mirrorEgress,
    },
  });
  ctx.library = lib; // the probe fixture (startEventFixture) pushes model:changed through it

  // board:open's reply shape, mirroring src/main/main.js:895-905.
  const boardResponse = (b) => {
    const core = { laneboard: laneboardVersion(), root: b.root, dataDir: b.dataDir };
    if (b.outcome === 'refused') return { ...core, refused: b.refused, legacyNames: legacyNames(b.root) };
    return {
      ...core,
      url: b.url,
      origin: b.origin,
      outcome: b.outcome,
      migration: b.migration && { imported: b.migration.imported, warnings: b.migration.warnings.length, report: b.migration.report },
    };
  };

  // Step 8a: the talk-mode scheduler, wrapping src/main/speech-scheduler.mjs unchanged. Its signals() reads the cache
  // above; the "updated" line uses the app version the host reports (package.json, like Electron's app.getVersion()).
  speech = createSpeechHost({
    settings, saveSettings: (patch) => saveSettings(ctx.dataDir, patch), signals, agent,
    emit: ctx.emit, version: ctx.version, now: ctx.now,
    log: (m) => process.stderr.write(`[sidecar] ${m}
`),
  });
  // models:restore-default (Electron 05bf103): no arguments, main-webview-only through the rpc allow-list.
  const restoreDefault = createRestoreDefault({
    saveSettings: (patch) => saveSettings(ctx.dataDir, patch), listModels: () => boot.listModels(),
    sayEvent: (name) => speech.handlers['talk.sayEvent'](name), modelsDir: modelsDir(),
  });
  // Step 8b part 1: the BYO cloud voice providers through the shared routing core. The guarded TTS fetch is built on
  // the ONE base fetch handed to the egress seam above; no module here calls globalThis.fetch itself.
  const voice = createVoiceHost({
    dataDir: ctx.dataDir, settings, saveSettings: (patch) => saveSettings(ctx.dataDir, patch),
    secretStores: ctx.secretStores, flavour: ctx.flavour, ttsFetchFor: (id) => ttsFetch(baseFetch, id, egressLog),
    isLiveSay: (sayId) => Boolean(speech.scheduler && speech.scheduler.isLive(sayId)),
    takeLiveReply: (turnId) => chatHost.takeLiveReply(turnId),
    // Electron main.js:1845: a --selftest / --demo-fixture run answers TTS from the cloud fixture transport (a tone), never a server.
    cloud: () => (cloudFixtureFor(ctx.selfTest) ? chatHost.cloud : null),
    emit: ctx.emit,
    // A fixture run must never download the ~163 MB Kokoro model. Voice off in settings.json is honoured regardless.
    prefetch: ctx.voicePrefetch !== false && !(ctx.shotsFixtures),
    // Step 12-1: a shots run's voice row reads the shots:voice-state fixture (main.js:1297).
    voiceStateOverride: ctx.shotsFixtures ? () => ctx.shotsFixtures.voiceState() : null,
    log: (m) => process.stderr.write(`[sidecar] ${m}\n`),
  });
  // Owner 01-11: free voices are add-ons from the Marketplace, not part of the installer. Owner 11-11 (mkt-q1): the voice, the
  // default room and the video rooms all come from the signed store index (T-31-ROOM-slim), never from a list compiled in here.
  const market = createMarketHost({
    dataDir: ctx.dataDir, fetchImpl: marketFetch(baseFetch, egressLog), emit: ctx.emit,
    store: { source: storeSource(), publicKeys: STORE_KEYS },
    bundled: (id) => (id === 'voice.kokoro-82m' && voice.kokoroBundled()) || boot.roomBuiltIn(id),
    model: voice.kokoroModel,
    log: (m) => process.stderr.write(`[sidecar] ${m}\n`),
  });
  // Step 9-1: the talk-camera HUD. hud-host.mjs / hud-answer.mjs / board-open.mjs run UNCHANGED; this host supplies the
  // board reader chat already owns (one connection), the cached idle, the 8a scheduler seams and the `hud:feed` push.
  // Electron's test-only fast poll (ZUMI_TEST_HUD_POLL_MS) is honoured in a test flavour only, like ZUMI_BOARD_UPSTREAM.
  const ownerAdmin = ctx.flavour.values.ownerAdmin === true;
  const hud = createHudHost({
    getState: (o) => chatHost.boardReader.getState(o),
    idleSeconds: () => signals.idleSeconds(),
    settings,
    saveSettings: (patch) => saveSettings(ctx.dataDir, patch),
    emit: ctx.emit,
    ownerAdmin,
    open: ownerAdmin ? createHostOpen(ctx.hostCalls.call) : null,
    liveBoard: boardHost.liveBoard,
    talkActive: () => speech.talkActive(),
    onReaction: (r) => speech.boardReaction(r),
    onWaiting: (n) => speech.setWaitingCount(n),
    onBoardStatus: (ok) => speech.boardStatus(ok),
    onState: (state) => agent.onBoardState(state), watchFeed: () => agent.watchFeed(), // T-31 alpha.12 watcher
    logRefusal, now: ctx.now,
    pollMs: hudPollMs({ flavour: ctx.flavour }),
    log: (m) => process.stderr.write(`[sidecar] ${m}
`),
  });
  // T-31 3a-3 Brain's three read-only board calls: null unless next-ui.json (a build artefact) sits beside the host exe (board-reads-host.mjs).
  const boardReads = createBrainReads({
    hostDir: ctx.hostDir, ownerAdmin, boardReader: chatHost.boardReader, liveBoard: boardHost.liveBoard, baseFetch,
    openHost: createHostOpen(ctx.hostCalls.call), logRefusal,
    log: (m) => process.stderr.write(`[sidecar] ${m}\n`),
  });
  const handlers = {
    ...speech.handlers,
    ...signals.handlers,
    ...voice.handlers,
    // launch-scope memory (memory-notes.mjs): the user's notes. Recall is not an rpc: chat-host.mjs reads it per turn.
    'memory.status': () => memory.handlers['memory.status'](),
    'memory.setEnabled': (on) => memory.handlers['memory.setEnabled'](on),
    'memory.list': (q) => memory.handlers['memory.list'](q),
    'memory.add': (text) => memory.handlers['memory.add'](text),
    'memory.delete': (id) => memory.handlers['memory.delete'](id),
    'memory.deleteAll': () => memory.handlers['memory.deleteAll'](),
    'memory.exportFile': () => memory.handlers['memory.exportFile'](),
    // App version + preview flags. `packaged: true` so the renderer hides dev-only chrome, matching
    // an installed Electron build; nothing here is a measurement claim.
    info: () => ({
      version: ctx.version,
      // Step 12-1: the self-test flags come from THIS process's CLI modes only (md.selfTest); a normal launch has all
      // of them false, so the renderer never enters a driver by accident.
      ...st.info,
      boardPartition: 'preview-board',
      boardLivePartition: 'preview-board-live',
      minWindow: { width: 900, height: 600 }, // src/main/main.js MIN_WINDOW; the Tauri main window's minimum
      packaged: true,
      versions: { preview: ctx.version },
      disabledViews: [],
      // main.js:743: the resolved build flag the whole sidecar already uses (hud / chat / voice); never a constant.
      ownerAdmin,
      // What a stranger installed (public or official: same values). The renderer's one test for "hide the owner's surfaces".
      publicBuild: !ownerAdmin,
      // Parity 7-3: the Node executable running THIS sidecar. A packaged probe scrubs PATH (no system Node) and
      // asserts this path is the bundled runtime, so a silent PATH fallback can never pass. A path is not a secret.
      nodeExecPath: process.execPath,
    }),

    // Electron's feed-less answers (main.js `updater` is null). The public build's Rust host answers these names itself
    // (src-tauri/src/updater.rs); an owner or self-test launch never updates and lands here, so `update.onState` is not emitted.
    'update.status': () => ({ phase: 'off' }),
    'update.install': () => false,
    'update.later': () => false,
    'update.check': () => ({ result: 'off' }),

    // The original handlers live in src/main/main.js (ui:get-lang / ui:set-lang / ui:get-dev-tools /
    // ui:set-dev-tools); behaviour here matches them key-for-key.
    'ui.getLang': (fallback) => uiLangOf(settings().uiLang, fallback),
    'ui.setLang': (lang) => {
      const l = lang === 'vi' || lang === 'zh' ? lang : 'en';
      saveSettings(ctx.dataDir, { uiLang: l });
      return l;
    },
    // P3-C: one-time import of NON-secret settings from the Zumi 0.2.9 (Electron) profile. The source is FIXED here:
    // %APPDATA%\Zumi plus a Zumi-data folder beside a parent of this install; no method takes a path. A self-test/demo/shots
    // launch never looks at the real profile.
    ...createImportRpc({
      dataDir: ctx.dataDir,
      detect: () => detectProfileForHost({ selfTestActive: Object.values(st.info).some(Boolean), appData: process.env.APPDATA, userProfile: process.env.USERPROFILE, hostDir: ctx.hostDir }),
    }),
    'ui.getDevTools': () => settings().developerMode === true,
    'ui.setDevTools': (on) => {
      const v = on === true;
      saveSettings(ctx.dataDir, { developerMode: v });
      return v;
    },

    // ---- renderer boot path (step 3; src/main/main.js line cited per handler in boot-reads.mjs) ----
    listModels: () => boot.listModels(), // models:list, main.js:733
    restoreDefaultModel: () => restoreDefault(), // models:restore-default (no arguments), Electron 05bf103
    listClips: () => boot.listClips(), // clips:list, :749
    'rooms.list': () => boot.listRooms(), // rooms:list, :751
    'scenes.list': () => boot.listScenes(), // scenes:list, :771
    'scenes.select': (id) => boot.selectScene(id), // scenes:select, :772
    'chairs.list': () => boot.listChairs(), // chairs:list, :775
    'chairs.select': (id) => boot.selectChair(id), // chairs:select, :776
    // ---- models / rooms / gestures, write side (step 4; library.mjs) ----
    selectModel: (id) => lib.selectModel(id), // models:select, main.js:734
    // The file dialogs belong to the Rust host: it intercepts openModelFile / rooms.openFile BEFORE the sidecar, runs
    // the OS dialog and calls the host-only __host.importModelPath / __host.importRoomPath with the pick. These two
    // take NO arguments (a renderer-supplied path is ignored) and import nothing, so a call that somehow got here
    // answers like a cancelled dialog: null.
    openModelFile: () => null, // models:open-file, :740
    'rooms.select': (id) => lib.selectRoom(id), // rooms:select, :752
    'rooms.openFile': () => null, // rooms:open-file, :757
    'rooms.delete': (id) => lib.deleteRoom(id), // rooms:delete, :768
    'rooms.v2.saveView': (id, view, camera) => lib.saveRoomV2View(id, view, camera), // rooms:v2:save-view, :781
    playGesture: (command) => lib.playGesture(command), // gesture:play, :907 (round-trips via __host.gestureResult)
    'ai.provider': () => ai.providerInfo(), // ai:provider, :1015 (pinned at start, main())
    // ---- FL-3: the Tauri-only free-LLM preset UI (metadata only; never a key) ----
    'ai.presetList': () => ({ ...presetList(), settings: ai.presetSettings(), keys: chatHost ? chatHost.keyPresence() : {} }), // descriptors + the two non-secret settings + per-provider has-key booleans
    'ai.setPresetSettings': (patch) => ai.setPresetSettings(patch), // strict allow-list + Account ID validation, then saveSettings
    // ---- step 6 network half (chat-host.mjs) ----
    // The names are listed here, not spread, so the coverage meter sees them (sidecarHandlerNames parses this object).
    'talk.status': () => chatHost.handlers['talk.status'](), // talk:status, :960 (chat brain first)
    'talk.turn': (p) => chatHost.handlers['talk.turn'](p), // talk:turn, :965 (stream + replyMore/replyDone/checkDone)
    'talk.gesture': (p) => chatHost.handlers['talk.gesture'](p), // talk:gesture, :1027
    'talk.brainInfo': () => chatHost.handlers['talk.brainInfo'](), // talk:brain-info, :1000
    'brainKey.save': (raw, confirm) => chatHost.handlers['brainKey.save'](raw, confirm), // brainKey:save, :1036
    'brainKey.test': () => chatHost.handlers['brainKey.test'](), // brainKey:test, :1038
    'brainKey.cliLoginStatus': () => chatHost.handlers['brainKey.cliLoginStatus'](), // Tauri only
    'brainKey.cliLoginSet': (on) => chatHost.handlers['brainKey.cliLoginSet'](on), // Tauri only
    'ai.testKey': (raw) => chatHost.handlers['ai.testKey'](raw), // ai:test-key, :1072
    'roles.get': () => chatHost.handlers['roles.get'](), // roles:get, :1169 (F7: the real view once a key exists)
    'roles.set': (role, choice) => chatHost.handlers['roles.set'](role, choice), // roles:set, :1170
    'roles.reset': (role) => chatHost.handlers['roles.reset'](role), // roles:reset, :1180
    'roles.setOn': (role, on) => chatHost.handlers['roles.setOn'](role, on), // roles:setOn, :1191
    'roles.models': () => chatHost.handlers['roles.models'](), // roles:models, :1197
    'ai.setMode': (mode) => ai.setMode(mode), // ai:set-mode, :1020
    'ai.setProvider': (id) => ai.setProvider(id), // ai:set-provider, :1031
    // The shell open belongs to the Rust host: it intercepts these two names, asks the sidecar for the VERDICT
    // (`__host.aiKeyPageVerdict` / `__host.citedUrlVerdict`), re-validates and opens. A call that got here opened nothing.
    'ai.openKeyPage': () => false, // ai:open-key-page, :1056
    'talk.openSource': () => false, // talk:openSource, :986
    // R4: the app's fixed public links (links.mjs). The page learns only which ids are set (booleans); Rust intercepts
    // links.open and asks __host.linkVerdict, so a call that got here opened nothing.
    'links.list': () => linkList(),
    'links.open': () => false,
    'talk.log': (rec) => st.appendTurn(rec), // talk:log, :1444 (only a self-test/demo run dir writes turns.ndjson)
    // ---- step 8a talk-mode scheduler (speech-host.mjs) ----
    // Listed explicitly (not only through the spread above) so the coverage meter parses them.
    'talk.getTalkPrefs': () => speech.handlers['talk.getTalkPrefs'](), // talk:getTalkPrefs, :1258
    // main.js:1248-1253: a level switched on in Settings starts the HUD board poll now (`if (hudHost) hudHost.start()`).
    'talk.setTalkPrefs': (p) => { const next = speech.handlers['talk.setTalkPrefs'](p); if (next) hud.start(); return next; }, // talk:setTalkPrefs, :1259
    'talk.setVoiceEnabled': (on) => { const r = speech.handlers['talk.setVoiceEnabled'](on); voice.onVoiceEnabled(on); return r; }, // talk:setVoiceEnabled, :1208
    'talk.setThinkSound': (on) => speech.handlers['talk.setThinkSound'](on), // talk:setThinkSound, :1211
    'talk.setSpeakTypedWhenMicOff': (on) => speech.handlers['talk.setSpeakTypedWhenMicOff'](on), // talk:setSpeakTypedWhenMicOff, :1215
    'talk.sayReady': () => speech.handlers['talk.sayReady'](), // talk:sayReady, :1283
    'talk.sayAck': (sayId, spoken, reason) => speech.handlers['talk.sayAck'](sayId, spoken, reason), // talk:sayAck, :1285
    'talk.sayEvent': (name) => speech.handlers['talk.sayEvent'](name), // talk:sayEvent, :1287
    'talk.sayStatus': () => speech.handlers['talk.sayStatus'](), // talk:sayStatus, :1280
    'talk.mute': (untilMs) => speech.handlers['talk.mute'](untilMs), // talk:mute, :1268
    'talk.unmute': () => speech.handlers['talk.unmute'](), // talk:unmute, :1275
    // T-31 alpha.12 (agent-core.mjs): Brain > Soul, Settings > Rhythm, the watcher's on/off. Same handlers main.js serves.
    'soul.get': () => agent.handlers['soul.get'](), // soul:get
    'soul.save': (input) => agent.handlers['soul.save'](input), // soul:save
    'soul.undo': () => agent.handlers['soul.undo'](), // soul:undo
    'rhythm.get': () => agent.handlers['rhythm.get'](), // rhythm:get
    'rhythm.pause': (on) => agent.handlers['rhythm.pause'](on), // rhythm:pause
    'rhythm.reset': () => agent.handlers['rhythm.reset'](), // rhythm:reset
    'watch.setLevel': (lv) => { const v = agent.handlers['watch.setLevel'](lv); hud.start(); return v; }, // watch:set-level
    'brainKey.status': () => aiCore.brainKeyStatus(), // brainKey:status, :1003
    'brainKey.clear': () => aiCore.brainKeyClear(), // brainKey:clear, :1005
    'usage.summary': () => aiCore.usageSummary(), // usage:summary, :1456
    'reflexJev.classify': (text) => aiCore.reflexClassify(text), // reflexjev:classify, :1669
    'talk.getVoiceEnabled': () => boot.getVoiceEnabled(), // :1180
    'talk.getThinkSound': () => boot.getThinkSound(), // :1183
    'talk.getSpeakTypedWhenMicOff': () => boot.getSpeakTypedWhenMicOff(), // :1187
    // ---- step 8b part 1 voice providers (voice-host.mjs) ----
    // Listed explicitly (not only through the spread above) so the coverage meter parses them.
    // ---- Marketplace (market-host.mjs): Tauri only, Electron has no such method ----
    'market.list': () => market.handlers['market.list'](),
    'market.install': (id) => market.handlers['market.install'](id),
    'market.remove': (id) => market.handlers['market.remove'](id),
    'talk.getVoicePrefs': () => voice.handlers['talk.getVoicePrefs'](), // talk:getVoicePrefs, :1220 (behaviour change: owner flag + config)
    'talk.setVoicePrefs': (p) => voice.handlers['talk.setVoicePrefs'](p), // talk:setVoicePrefs, :1231
    'talk.voiceProviders': () => voice.handlers['talk.voiceProviders'](), // talk:voiceProviders, :1394
    'talk.setProviderKey': (id, raw) => voice.handlers['talk.setProviderKey'](id, raw), // talk:setProviderKey, :1395
    'talk.clearProviderKey': (id) => voice.handlers['talk.clearProviderKey'](id), // talk:clearProviderKey, :1400
    'talk.checkProviderKey': (id, raw) => voice.handlers['talk.checkProviderKey'](id, raw), // Tauri only: free key check before saving
    'talk.testVoice': (p) => voice.handlers['talk.testVoice'](p), // talk:testVoice, :1408
    'talk.tts': (p) => voice.handlers['talk.tts'](p), // talk:tts, :1317 (Kokoro / Windows / cloud, by the core's route)
    'talk.ttsAbandon': (p) => voice.handlers['talk.ttsAbandon'](p), // talk:ttsAbandon, :1301 (barge-in: stop later Kokoro chunks)
    'talk.voiceInfo': () => voice.handlers['talk.voiceInfo'](), // talk:voiceInfo, :1375
    'talk.voiceWarm': () => voice.handlers['talk.voiceWarm'](),
    'talk.voiceState': () => voice.handlers['talk.voiceState'](), // talk:voiceState, :1361
    'talk.openGuide': () => voice.handlers['talk.openGuide'](), // talk:openGuide, :1437 (Rust intercepts; opens from the fixed table)
    'ui.getSendClientNames': () => boot.getSendClientNames(), // :844
    'ui.setSendClientNames': (on) => boot.setSendClientNames(on), // :848
    'ui.getLookTuning': () => boot.getLookTuning(), // :859
    'ui.setLookTuning': (overrides) => boot.setLookTuning(overrides), // :863
    'gcache.load': () => boot.gcacheLoad(), // :1522
    'gcache.save': (text) => boot.gcacheSave(text), // :1526

    // ---- step 9-1 HUD (hud-host-tauri.mjs wraps hud-host.mjs / hud-answer.mjs unchanged) ----
    // Listed explicitly (not only through a spread) so the coverage meter parses them.
    'hud.getPrefs': () => hud.handlers['hud.getPrefs'](), // hud:get-prefs, :1436
    'hud.setPrefs': (p) => hud.handlers['hud.setPrefs'](p), // hud:set-prefs, :1437
    'hud.ready': () => hud.handlers['hud.ready'](), // hud:ready, :1438 (now starts the real poll)
    'hud.answer': (id, yes) => hud.handlers['hud.answer'](id, yes), // hud:answer, :1439 (offer id only)
    'hud.answerAsk': (p) => hud.handlers['hud.answerAsk'](p), // hud:answer-ask, :1449 (owner flavour only)

    // ---- 3a-3 Brain's read-only board calls (board-reads-host.mjs wraps src/main/board-reads.mjs unchanged). Listed at table level so the coverage
    // meter parses them; a bundle that is not a next-UI build has them removed right after the table (see the delete below): unknown methods.
    'board.state': () => boardReads.state(), // board:state
    'board.media': (id, opts) => boardReads.media(id, opts), // board:media
    'board.openRef': (ref) => boardReads.openRef(ref), // board:open-ref

    // ---- step 12-1: the test-only families (selftest-host.mjs) ----
    // Listed explicitly (not through a spread) so the coverage meter parses them. Each answers `not_available` unless
    // THIS sidecar was launched in the matching CLI mode; that mode is never reachable from settings or an rpc.
    'demo.info': () => st.handlers['demo.info'](), // demo:info, :1695
    'demo.log': (msg) => st.handlers['demo.log'](msg), // demo:log, :1699
    'demo.capture': (name) => st.handlers['demo.capture'](name), // demo:capture, :1700
    'demo.finish': (report) => st.handlers['demo.finish'](report), // demo:finish, :1707
    'selftest.capture': (name, opts) => st.handlers['selftest.capture'](name, opts), // selftest:capture, :1648
    'selftest.emitBoard': () => st.handlers['selftest.emitBoard'](), // selftest:emit-board, :1699 (producer: step 12-3)
    'selftest.boardLog': () => st.handlers['selftest.boardLog'](), // selftest:board-log, :1704
    'selftest.clipboardImage': () => st.handlers['selftest.clipboardImage'](), // selftest:clipboard-image, :1677
    'selftest.log': (msg) => st.handlers['selftest.log'](msg), // selftest:log, :1621
    'selftest.finish': (report) => st.handlers['selftest.finish'](report), // selftest:finish, :1725
    'selftest.roomFixtures': () => st.handlers['selftest.roomFixtures'](), // selftest:room-fixtures, :1629
    'selftest.roomOpen': (name) => st.handlers['selftest.roomOpen'](name), // selftest:room-open, :1642
    'shots.capture': (name) => st.handlers['shots.capture'](name), // shots:capture, :2108
    'shots.log': (msg) => st.handlers['shots.log'](msg), // shots:log, :2115
    'shots.finish': (report) => st.handlers['shots.finish'](report), // shots:finish, :2158
    'shots.badRoom': () => st.handlers['shots.badRoom'](), // shots:bad-room, :2120
    'shots.rolesProvider': (mode) => st.handlers['shots.rolesProvider'](mode), // shots:roles-provider, :2132
    'shots.resize': (w, h) => st.handlers['shots.resize'](w, h), // shots:resize, :2134
    'shots.voiceState': (state) => st.handlers['shots.voiceState'](state), // shots:voice-state, :2136
    'shots.seedUsage': () => st.handlers['shots.seedUsage'](), // shots:seed-usage, :2143
    'probe.finish': (report) => st.handlers['probe.finish'](report), // probe:finish, :2092

    // board:open + startBoard (main.js:895 / :548). Root is <dataDir>/board-data ONLY — never
    // Electron's userData (<root>/Zumi-data), never a Zumi-data folder. The port comes from the
    // preview settings.json (settings.boardPort) and is saved back when it had to move, exactly as
    // startBoard does for the Electron settings.json.
    openBoard: async () => {
      try {
        if (board) return boardResponse(board);
        if (!boardStarting) {
          boardStarting = (async () => {
            const root = boardDataRoot(ctx.dataDir);
            // A self-test/demo run takes any free port (main.js:551 runDir ? 0) and records the board's HTTP answers
            // for selftest.boardLog; a normal run keeps the stable origin from settings.
            const wantPort = st.runDir ? 0 : Number(settings().boardPort) || 0;
            const b = await openLocalBoard({ laneboardDir: laneboardDir(), root, sampleFixture: boardSamplePath(), port: wantPort, onRequest: st.onBoardRequest });
            if (!st.runDir && b.port && b.port !== wantPort) saveSettings(ctx.dataDir, { boardPort: b.port });
            boardOutcome = b.outcome;
            if (b.outcome !== 'refused') board = b; // a refused import wrote nothing; retry next open
            return b;
          })().finally(() => { boardStarting = null; });
        }
        return boardResponse(await boardStarting);
      } catch (e) {
        const message = String((e && e.message) || e);
        // The app log gets the error CODE only: the message can carry the user's home path (a missing import) or a snippet of the board file (a corrupt projection). The caller still gets the full message below.
        const code = e && typeof e.code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(e.code) ? e.code : 'error';
        process.stderr.write(`[sidecar] openBoard failed: ${code}\n`);
        return { error: message };
      }
    },

    // main.js:1320's not-ready shape, replaced in step 10a by the real computed answer (board-host.mjs).
    'board.status': () => boardHost.handlers['board.status'](),
    'board.setSecrets': (p) => boardHost.handlers['board.setSecrets'](p), // board:set-secrets, :1376
    'board.setSecretsOs': (p) => boardHost.handlers['board.setSecretsOs'](p), // board:set-secrets-os, :1385
    'board.unlock': (pin) => boardHost.handlers['board.unlock'](pin), // board:unlock, :1392
    'board.lock': () => boardHost.handlers['board.lock'](), // board:lock, :1397
    'board.signOut': (pin) => boardHost.handlers['board.signOut'](pin), // Tauri only: Settings > Sign out of Board
    'board.disablePin': (pin) => boardHost.handlers['board.disablePin'](pin), // board:disablePin, :1352
    'board.enablePin': (newPin) => boardHost.handlers['board.enablePin'](newPin), // board:enablePin, :1359
    'board.setPinRequired': (on) => boardHost.handlers['board.setPinRequired'](on), // board:setPinRequired, :1369
    'board.setMode': (mode) => boardHost.handlers['board.setMode'](mode), // board:setMode, :1375
    'board.liveOpen': () => boardHost.handlers['board.liveOpen'](), // board:live-open, :1436 (every flavour, like Electron)
    ...(boardHost.handlers['board.testBridgeAuth'] ? { 'board.testBridgeAuth': () => boardHost.handlers['board.testBridgeAuth']() } : {}), // test flavour only (board-host.mjs)
    // T-31-MOBILE M3 phone pairing, owner build only (board-host.mjs). `phone.status` is the renderer's read; the two
    // `__host.*` names are the Rust host's (lib.rs phone_pair), called after its native confirm. Not in the inventory.
    ...(boardHost.handlers['phone.status'] ? {
      'phone.status': () => boardHost.handlers['phone.status'](),
      '__host.phonePairBundle': () => boardHost.handlers['__host.phonePairBundle'](),
      '__host.phoneUnpair': () => boardHost.handlers['__host.phoneUnpair'](),
    } : {}),


    // Internal attach decision for the Rust guest host: runs webview-policy.mjs UNCHANGED with the
    // sidecar's own known origins. `__host.*` is deliberately NOT in the inventory, so the renderer's
    // rpc can never reach it (check:tauri-allowlist enforces that).
    '__host.guestDecide': (src, partition) => {
      // T-31 alpha.12: the spare-PC guard probe's stand-in page (tauri/verify), on the board partition, only when the
      // process runs on the render box (ZUMI_ELECTRON_HOST=box, the one rule of scripts/lib/electron-guard.cjs) and the
      // runner named a 127.0.0.1 http origin. Read once at start; null on every other machine and run.
      if (guardProbeOrigin && sameOrigin(src, guardProbeOrigin)) return { allow: partition === 'preview-board', origin: guardProbeOrigin };
      const boardOrigin = board && board.origin ? board.origin : null;
      const liveBridgeOrigin = boardHost.liveBridgeOrigin(); // null until the owner flavour's board.liveOpen hands one out
      const origin = matchedOrigin(src, boardOrigin, liveBridgeOrigin);
      const d = decideWebviewAttach({
        src, partition, boardOrigin, liveBridgeOrigin,
        boardPartition: 'preview-board', boardLivePartition: 'preview-board-live',
      });
      return { allow: d.allow, origin: d.allow ? origin : null };
    },
    // P1c3: an off-origin guest link (window.open or a refused top-level navigation). Runs board-open.mjs
    // decideExternalUrl UNCHANGED with ownerAdmin pinned to false (gate condition 4; the `cited` channel
    // is not ported). `{ action: 'none' }` for a URL on one of the app's own guest origins (Electron's
    // `!inBoard(url)` guard). A policy refusal is logged here (reason + origin only,
    // by the Electron refusal-log helper); the Rust host logs the refusals only it knows via
    // `__host.logRefusal`. Like guestDecide this is host-only: not in the inventory, so the renderer's
    // rpc can never reach it (check:tauri-allowlist).
    '__host.decideExternalUrl': (url) => {
      if (typeof url !== 'string') {
        const d = { action: 'refuse', reason: 'bad_url' };
        logRefusal(d);
        return d;
      }
      const boardOrigin = board && board.origin ? board.origin : null;
      if (sameOrigin(url, boardOrigin) || sameOrigin(url, boardHost.liveBridgeOrigin())) return { action: 'none' };
      // S1 (P3-B gate): the board bridge's own routes are never an OS-browser link, even when liveBridgeOrigin was already
      // dropped (a stale guest after setMode('local') / signOut). Same rule as the Rust host's board_open::is_bridge_link.
      if (isBridgeRoute(url)) { const r = { action: 'refuse', reason: 'bridge_route' }; logRefusal(r); return r; }
      const d = decideExternalUrl(url, { ownerAdmin: false });
      if (d.action !== 'openExternal') logRefusal(d);
      return d;
    },
    // P3-B: the board guest asked to open /__zumi-open?path=|url= on its own live bridge origin (a chip on the board). Runs
    // board-open.mjs decideBoardOpen UNCHANGED via boardHost.openVerdict: owner flavour only, roots/extensions/real-path/name-trick
    // rules, opener must be the bridge page. The Rust host asks ONLY for a request it intercepted from the board guest's own
    // new-window/navigation (never from the page's rpc: host-only, not in the inventory) and re-validates the answer itself
    // before any shell call. A refusal is logged (reason + origin only, like every other refusal).
    '__host.boardOpenVerdict': (url, openerUrl) => {
      const d = boardHost.openVerdict(url, openerUrl);
      if (d.action === 'refuse') logRefusal(d);
      return d;
    },
    // Step 4: the Rust file dialog's pick (dialog_ops.rs). Re-validated in library.mjs; NOT in the inventory, so the
    // renderer's rpc can never reach it. Both are Rust-only: a path only ever arrives from the OS dialog.
    '__host.importModelPath': (p) => lib.importModelPath(p),
    '__host.importRoomPath': (p) => lib.importRoomPath(p),
    // Step 4b: the main webview's asset route asks which file an exact app path maps to (boot-reads.mjs resolveAsset).
    // The Rust host re-checks the answer and streams the bytes itself. Host-only: not in the inventory, so the renderer
    // cannot name a path through it (check-tauri-allowlist asserts that).
    '__host.resolveAsset': (rel) => boot.resolveAsset(rel),
    // The renderer's `gesture:result` reply, mapped here by the Rust rpc command (lib.rs reply_target).
    '__host.gestureResult': (reqId, result) => lib.gestureResult(reqId, result),
    // Step 6: the verdicts for the two app-page opens Rust runs (guest.rs open_for_app_page). Host-only like the others.
    '__host.aiKeyPageVerdict': () => aiCore.keyPageVerdict(),
    '__host.citedUrlVerdict': (url) => aiCore.citedUrlVerdict(url),
    '__host.logRefusal': (reason, origin) => {
      logRefusal({ reason: typeof reason === 'string' ? reason : '', origin: typeof origin === 'string' ? origin : undefined });
      return true;
    },
    // Step 8b: the app-page openGuide verdict (lib.rs app_open_target). The page names a guide id; the URL comes from
    // the sidecar's fixed VOICE_GUIDES table. Host-only: not in the inventory, so the renderer's rpc cannot reach it.
    '__host.voiceGuideVerdict': (id) => {
      const d = voice.guideVerdict(id);
      if (d.action !== 'openExternal') logRefusal({ reason: d.reason || 'unknown_guide' });
      return d;
    },
    // R4: the app-page links.open verdict (lib.rs app_open_target). The page names a link id; the URL comes from the fixed LINKS
    // table (links.mjs). Host-only: not in the inventory.
    '__host.linkVerdict': (id) => {
      const d = linkVerdict(id);
      if (d.action !== 'openExternal') logRefusal({ reason: d.reason || 'unknown_link', origin: d.origin });
      return d;
    },
  };
  // C4 (GATE-SEC-3a-3): without next-ui.json beside the host exe the three Brain names do not exist, so they answer "method not found" like any unknown name.
  if (!boardReads) for (const name of ['board.state', 'board.media', 'board.openRef']) delete handlers[name];

  // Called when stdin closes (the host is quitting): stop the scheduler tick and the hosts so nothing lingers.
  if (!isSelfTestRun(ctx.selfTest)) agent.start(); // T-31 alpha.12: the once-a-minute idle sample into the rhythm's active buckets (unref'd timer)
  const dispose = () => { hud.dispose(); boardHost.dispose(); speech.dispose(); agent.dispose(); chatHost.dispose(); voice.dispose(); };

  return { handlers, dispose, signals, ai, chatHost, speech };
}

// One response per id. `await` the handler's result: several handlers are async (openBoard,
// board.liveOpen), and before this a returned Promise serialized as `{}` — a silent, wrong success.
// The try/catch covers an `await`ed rejection exactly like a synchronous throw, so the error mapping
// (ERR_INTERNAL + the throw's message) is identical for both. A notification (no `id`) still gets no
// response.
export async function dispatch(msg, handlers) {
  const id = msg && Object.prototype.hasOwnProperty.call(msg, 'id') ? msg.id : null;
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return error(id, ERR_INVALID_REQUEST, 'invalid_request');
  }
  const params = Array.isArray(msg.params) ? msg.params : [];
  // hasOwnProperty, NOT `handlers[method]`: a bare lookup would resolve inherited names
  // ('toString', 'constructor', …) to a function and answer them — a faked success. Every name the
  // inventory does not list must fall through to not_implemented.
  if (!Object.prototype.hasOwnProperty.call(handlers, msg.method)) {
    return id === null ? null : error(id, ERR_METHOD_NOT_FOUND, notImplemented(msg.method));
  }
  const handler = handlers[msg.method];
  try {
    const result = await handler(...params);
    return id === null ? null : ok(id, result === undefined ? null : result);
  } catch (e) {
    return id === null ? null : error(id, ERR_INTERNAL, String((e && e.message) || e));
  }
}

// Spare-PC probe only (tauri/verify/probe-events.mjs sets ZUMI_EVENT_FIXTURE=1): push one fixed line on
// `speech:say` every second for 30 s, so a CDP driver that subscribed through window.zumi.talk.onSay can see
// the whole path (sidecar -> host -> main webview -> shim) on the running app. It is not a producer for the
// coverage meter (the channel is a constant, not an emit('…') literal) and is off unless that variable is set.
const FIXTURE_CHANNEL = 'speech:say';
function startEventFixture(emit, library) {
  // model:changed has no shipped producer (the wardrobe, its only one, left in 0.3.0-alpha.11): the probe fires it once
  // through the real producer, so the renderer's onModelChanged path can be observed on the spare PC.
  setTimeout(() => library.modelChanged('probe'), 3000).unref();
  let n = 0;
  const timer = setInterval(() => {
    n += 1;
    emit(FIXTURE_CHANNEL, { sayId: `probe-${n}`, kind: 'probe', text: 'event path probe', show: false, voice: 'en', lang: 'en', mood: 'calm' });
    if (n >= 30) clearInterval(timer);
  }, 1000);
  timer.unref();
}

function main(measureStubModule = null) {
  const dataDir = parseDataDir(process.argv.slice(2));
  // Step 7-1: in a bundled run the host names the resource root, so the Electron-parity modules resolve the voice
  // modules from `<resources>/voice-modules`. Never override a value the runtime already provides.
  const resourcesDir = parseResourcesDir(process.argv.slice(2));
  if (resourcesDir && !process.resourcesPath) process.resourcesPath = resourcesDir;
  // ctx.emit(channel, payload) is the one push path to the renderer (protocol.mjs createEmitter); the host
  // validates the channel against the inventory and forwards to the main webview only.
  const emit = createEmitter(writeLine, (m) => process.stderr.write(`${m}\n`));
  // Step 9-2: the one sidecar -> host request channel (the HUD's consent open). Transport only; Rust decides.
  const hostCalls = createHostCalls(writeLine, { log: (m) => process.stderr.write(`${m}\n`) });
  const { vaultExe, hostDir, flavourPath } = parseVaultArgs(process.argv.slice(2));
  // Step 6-pre (F5): the build flavour, resolved once and logged once. Read only from `--flavour` (beside the host exe), never
  // from the data dir; any doubt = public (flavour.mjs). Consumers arrive with steps 6, 8b, 9 and 10a.
  const flavour = resolveFlavour({ flavourPath, hostDir, log: (m) => process.stderr.write(`[sidecar] ${m}
`) });
  // Electron's `safeStorage` stand-in (the self-check `available` verb runs here once; only fixed code words are logged).
  const safeStorage = createVaultSafeStorage({ vaultExe, hostDir, log: (code) => process.stderr.write(`[sidecar] ${code}\n`) });
  // The six key-store modules are built from this lazily by increments 6/8/10 (no rpc name is added by step 5).
  let stores = null;
  const secretStores = async () => {
    if (!stores) {
      const { createSecretStores } = await import('./secret-stores.mjs');
      stores = createSecretStores({ safeStorage, dataDir, log: (m) => process.stderr.write(`[sidecar] ${m}\n`) });
    }
    return stores;
  };
  const fixedNow = parseClockMs(process.argv.slice(2));
  // Step 12-1: the test-only modes, from the ARGV only. A normal launch gets all-null and every test-only handler
  // answers `not_available`; no setting or rpc can turn one on (Q5 / BRIEF-12 security core).
  const selfTest = parseSelfTestArgs(process.argv.slice(2));
  const modeName = selfTest.selftest ? 'selftest' : selfTest.demo ? 'demo' : selfTest.shots ? selfTest.shots.kind : selfTest.probe ? 'probe' : null;
  if (modeName) process.stderr.write(`[sidecar] self-test mode=${modeName} runDir=${selfTest.runDir || '(none)'}\n`);
  // The --settings-shots fixtures are built only in that mode; the normal path never reads the fixture file.
  if (measureStubModule) { const refusal = measureStubModeError(selfTest); if (refusal) fail(refusal); }
  const shotsFixtures = selfTest.shots ? createShotsFixtures({ repoRoot, log: (m) => process.stderr.write(`[shots] ${m}\n`) }) : null;
  const ctx = {
    dataDir, hostDir, version: parseAppVersion(process.argv.slice(2)) || appVersion(), settings: () => readSettings(dataDir), emit,
    now: fixedNow === null ? Date.now : () => fixedNow,
    testModelPath: parseTestModel(process.argv.slice(2)), voicePrefetch: parseVoicePrefetch(process.argv.slice(2)),
    safeStorage, secretStores, flavour, hostCalls, selfTest, shotsFixtures,
    measureStub: measureStubModule ? measureStubModule.installMeasureStub({ table: providers.PROVIDERS, dataDir, safeStorage }) : null,
  };
  const { handlers, dispose } = buildHandlers(ctx);
  // The provider is pinned and the *-free OpenCode ids retired inside buildHandlers, BEFORE the chat brain reads them
  // (main.js app.whenReady order: pin, then build the brain).

  // T-31 parity (Electron 0.2.8+): a fresh profile starts on the bundled default model. Started now, awaited before the first
  // request is dispatched, so the renderer's first models:list already sees it. Never rejects (outcome logged to stderr).
  const defaultModelReady = adoptDefaultOnBoot({
    settings: ctx.settings, saveSettings: (patch) => saveSettings(dataDir, patch), listModels: () => handlers.listModels(),
    modelsDir: modelsDir(), testModelPath: ctx.testModelPath, log: (m) => process.stderr.write(`${m}\n`),
  });

  const rl = readline.createInterface({ input: process.stdin });
  writeLine(ready(ctx.version)); // handshake first, before any request is answered
  if (process.env.ZUMI_EVENT_FIXTURE === '1') startEventFixture(emit, ctx.library);

  // Async handler: dispatch awaits the handler's result. Lines are handled concurrently, but each id
  // still gets exactly one response (dispatch owns that), so out-of-order replies are legal JSON-RPC.
  rl.on('line', async (line) => {
    const text = line.trim();
    if (!text) return;
    if (Buffer.byteLength(text) > MAX_FRAME_BYTES) {
      fatalFrame('frame_too_large');
      return;
    }
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      fatalFrame('parse_error');
      return;
    }
    // Step 9-2: a host response to one of our own requests (`id`, no `method`). Anything with a
    // `method` is still a host request and goes to dispatch.
    if (hostCalls.settle(msg)) return;
    await defaultModelReady;
    const out = await dispatch(msg, handlers);
    if (out) writeLine(serializeResponse(out));
  });

  // stdin closed = the host is quitting; dispose the hosts and exit so nothing lingers.
  const shutdown = () => {
    hostCalls.rejectAll('sidecar_shutdown');
    try { dispose(); } catch { /* best effort */ }
    process.exit(0);
  };
  rl.on('close', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// Run only when executed as the sidecar entry point (spawned by the Rust host), never when the module
// is imported — scripts/check-tauri-sidecar.mjs imports dispatch() to unit-test it without starting a
// second server on stdin.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let measureStubModule = null;
  if (parseMeasureStubProvider(process.argv.slice(2))) {
    try { measureStubModule = await import('./measure-stub.mjs'); } catch { fail('--measure-stub-provider is not available in this build'); }
  }
  main(measureStubModule);
}
