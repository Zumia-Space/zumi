// T-31 parity step 8b: the voice providers, hosted in the sidecar (part 1: routing + cloud; part 2: Kokoro + SAPI).
//
// This wraps src/main/talk-voice-core.mjs UNCHANGED -- the module the Electron main process now also runs (the step's
// freeze exception extracted the inline routing there). The host only supplies what Electron supplies around it:
//   - the BYO cloud adapters (leda-tts.js, tts-gemini.js, tts-elevenlabs.js, tts-http.js), built lazily through the
//     step-5 secret stores so their DPAPI key files live in the preview data dir;
//   - the owner voice flag: <preview data dir>/owner-voice.json (parity) OR the build flavour's ownerAdmin;
//   - the guarded TTS fetch (egress.mjs ttsFetch), never the global fetch directly;
//   - Kokoro-82M (kokoro-tts.js, worker-thread inference) + the free Windows voice (local-tts.js), routed by
//     tts-router.js and created with the preview data dir as Electron's userData;
//   - the chat host's liveReplies map, so a streamed reply's whole text is spoken exactly as in Electron.
//
// Load (T-31-TAURI R1): voice ON prefetches at start; prewarm() (typing) reloads after an idle unload; a reply waits for a
// running load (capped, VOICE_LOAD_WAIT_MS). VOICE_IDLE_UNLOAD_MS without speech frees it. Voice off never loads it.
//
// Audio: `talk.tts` replies carry Buffers (protocol.mjs encodes them as `$bin`); Kokoro's sentence 2+ arrive on
// `talk:ttsMore`, split into fit-sized parts by splitAudioPayload when one is over the 512 KB event cap, and the shim
// re-assembles them byte-equal before the renderer sees one Uint8Array per sentence.
//
// Security: no key ever crosses back -- talk.voiceProviders returns hasKey only and talk.setProviderKey a boolean.
// talk.openGuide is answered by the Rust host from the fixed VOICE_GUIDES table (__host.voiceGuideVerdict), so the
// handler here opens nothing.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

import { createTalkVoiceCore, VOICE_GUIDES } from '../../src/main/talk-voice-core.mjs';
import { PRESET_LIMIT_GUIDES } from './free-llm-presets.mjs';
import { talkPrefs } from '../../src/main/speech-scheduler.mjs';
import { splitAudioPayload } from './protocol.mjs';

const require = createRequire(import.meta.url);
// The sidecar runs the Kokoro worker with the huggingface-only egress rule enforced per hop (kokoro-worker.mjs).
const KOKORO_WORKER_FILE = fileURLToPath(new URL('../../src/main/kokoro-worker.mjs', import.meta.url));
const { readOwnerVoiceFlag, voiceConfig } = require('../../src/main/tts-select.js');
const { migrateLegacyCustomKey, ZUMIA_OWNER_URL } = require('../../src/main/tts-http.js');
const { createKokoroTts } = require('../../src/main/kokoro-tts.js');
const { createLocalTts } = require('../../src/main/local-tts.js');
const { createEnTtsRouter } = require('../../src/main/tts-router.js');

// The sidecar's stdout is its JSON-RPC wire, so a worker-thread log line must never land there: Electron's worker
// can write to process.stdout safely, this one cannot (probe P4: "unparseable line" was kokoro-worker's
// "[kokoro-worker] ..." banner, which serde_json reads as a broken array frame). stdout:true stops the automatic
// piping to process.stdout; we forward the same text to stderr instead.
// Idle unload: free Kokoro's model after this long without speech; the next speech reloads it.
export const VOICE_IDLE_UNLOAD_MS = 10 * 60 * 1000;
// A reply waits at most this long for Kokoro to load (spare box measured loads up to 31.6 s); past it the reply gets an
// explicit retryable 'kokoro_loading' error while the load continues. The host's talk.tts rpc timeout outlives it.
export const VOICE_LOAD_WAIT_MS = 60 * 1000;
// T-31 T1 (owner chose L1 as default, 31-10). ZUMI_KOKORO_LOAD selects when Kokoro loads:
//   unset | 'l1'     ~VOICE_L1_DELAY_MS after start (first frame is ~3 s, so this is ~5 s after the first frame)
//   'eager'          at start (previous behaviour, escape hatch)
//   'l2'             only on the first talk.tts request (typing/start/voice-on warms are no-ops); the existing idle unload frees it
// An env var, not a setting: it is a measurement switch, not a user-facing choice.
export const VOICE_L1_DELAY_MS = 8 * 1000;
export function kokoroLoadMode(env = process.env) {
  const v = String(env.ZUMI_KOKORO_LOAD || '').toLowerCase();
  return v === 'eager' || v === 'l2' ? v : 'l1';
}

function createKokoroWorker() {
  const worker = new Worker(KOKORO_WORKER_FILE, { workerData: { egress: 'hf-only' }, stdout: true });
  if (worker.stdout && typeof worker.stdout.on === 'function') worker.stdout.on('data', (d) => process.stderr.write(d));
  return worker;
}

const OFF_STATE = { state: 'off', phase: null, loaded: 0, total: 0, error: null };

/**
 * @param {{ dataDir: string, settings: () => object, saveSettings: (patch: object) => object,
 *           secretStores: () => Promise<object>, flavour?: { values: object },
 *           ttsFetchFor: (providerId: string) => (url: string, init?: object) => Promise<any>,
 *           isLiveSay?: (sayId: string) => boolean, takeLiveReply?: (turnId: string) => object|null,
 *           emit?: (channel: string, payload: unknown) => boolean,
 *           kokoroFactory?: (o: object) => object, localTtsFactory?: (o: object) => object,
 *           voiceStateOverride?: (() => object)|null, log?: (m: string) => void }} o
 */
export function createVoiceHost({
  dataDir, settings, saveSettings, secretStores, flavour, ttsFetchFor,
  isLiveSay = () => false, takeLiveReply = () => null, emit = () => false, prefetch = true,
  kokoroFactory = (o) => createKokoroTts({ ...o, workerFactory: createKokoroWorker, idleUnloadMs: VOICE_IDLE_UNLOAD_MS }), localTtsFactory = (o) => createLocalTts(o),
  voiceStateOverride = null, cloud = () => null,
  log = () => {},
}) {
  // Electron reads <userData>/owner-voice.json once at start; the preview also gets the build flavour's ownerAdmin
  // (step 6-pre). Pinned HERE, like Electron's startup read, so the flag and the zumia-owner adapter can never
  // disagree mid-run. No secret, no URL: only the presence of the two-key flag file matters.
  const ownerVoiceAtStart = readOwnerVoiceFlag(dataDir); // 0.2.9 parity (gap 2): the flavour ownerAdmin does NOT turn the owner voice on
  const ownerFlag = () => ownerVoiceAtStart;

  let adapters = null;
  let building = null;
  const cfg = () => voiceConfig(settings());
  const voiceLog = (name) => (m) => log(`[${name}] ${m}`);

  // Built on the first voice call that needs an adapter: the vault helper may not be ready at sidecar start, and a
  // build that never opens Settings > Voice never touches a key file. migrateLegacyCustomKey runs BEFORE either custom
  // adapter exists, exactly as main.js orders it.
  function build() {
    return (async () => {
      const stores = await secretStores();
      const a = {
        google: stores.ledaTts({ getConfig: cfg, fetchImpl: ttsFetchFor('google'), log: voiceLog('leda-tts') }),
        gemini: stores.geminiTts({ getConfig: cfg, fetchImpl: ttsFetchFor('gemini'), log: voiceLog('gemini-tts') }),
        elevenlabs: stores.elevenTts({ getConfig: cfg, fetchImpl: ttsFetchFor('elevenlabs'), log: voiceLog('elevenlabs-tts') }),
      };
      migrateLegacyCustomKey({ dir: dataDir, config: cfg(), log: voiceLog('custom-tts') }); // before either adapter reads its key file
      a['http-openai'] = stores.httpTts({ id: 'http-openai', shape: 'openai', langs: ['en', 'vi'], keyOptional: true, getConfig: cfg, fetchImpl: ttsFetchFor('http-openai'), log: voiceLog('http-openai-tts') });
      a['http-zumia'] = stores.httpTts({ id: 'http-zumia', shape: 'zumia', langs: ['en', 'vi'], keyOptional: true, getConfig: cfg, fetchImpl: ttsFetchFor('http-zumia'), log: voiceLog('http-zumia-tts') });
      if (ownerFlag()) a['zumia-owner'] = stores.httpTts({ id: 'zumia-owner', url: ZUMIA_OWNER_URL, langs: ['vi'], shape: 'zumia', keyOptional: true, keyImportFile: 'zumia-owner-tts-key.import', fetchImpl: ttsFetchFor('zumia-owner'), log: voiceLog('zumia-owner-tts') });
      return a;
    })();
  }
  function ensure() {
    if (adapters) return Promise.resolve(adapters);
    if (!building) {
      building = build()
        .then((a) => { adapters = a; return a; })
        .finally(() => { building = null; });
    }
    return building;
  }

  // Kokoro-82M (main.js:2030). The constructor spawns nothing: the worker starts with a pre-warm (typing / a chat turn) or the first reply, and
  // is unloaded after VOICE_IDLE_UNLOAD_MS without speech (R0a: Kokoro was ~385 MB of the sidecar's ~407 MB).
  const kokoro = kokoroFactory({ userDataDir: dataDir, log: voiceLog('kokoro-tts') });
  // The Windows voice is created on first use (electron enumerates at start; the difference is not observable to the
  // renderer, and it keeps a voice-less fixture from spawning PowerShell). The proxy keeps the router's sync reads.
  let local = null;
  const localOr = () => (local || (local = localTtsFactory({ tmpDir: path.join(dataDir, 'tts-tmp'), log: voiceLog('local-tts') })));
  const sapi = {
    available: () => localOr().available(),
    voices: () => localOr().voices(),
    ready: () => localOr().ready(),
    info: () => localOr().info(),
    speak: (p) => localOr().speak(p),
  };

  // talk:kokoroProgress -> the Settings > Voice row (main.js:2032). An event over the same emitter as every other push.
  const sendProgress = (p) => emit('talk:kokoroProgress', p);
  // talk:ttsMore -> Kokoro sentence 2+ (main.js:2033). One logical chunk per sentence; SPLIT into fit-sized parts when
  // the encoded payload would exceed the 512 KB event cap, never dropped (PLAN 8b tests). The shim re-assembles.
  let moreChunk = 0;
  const sendMore = ({ turnId, audio }) => {
    const chunk = ++moreChunk;
    for (const frame of splitAudioPayload({ turnId, chunk, audio })) emit('talk:ttsMore', frame);
  };
  // tts-router.js: Kokoro only, except WHILE it loads (sapiWhileLoading, OSS v1 row 15): a reply that arrives before
  // Kokoro is ready is spoken by the Windows voice (local-tts.js, one-shot PowerShell, nothing resident) so the first
  // reply is not silent; Kokoro keeps loading and takes over once ready. Voice OFF never reaches the router (talk.tts
  // answers text-only above). A failed load is an explicit error, never a different voice. Never paid.
  const enTts = createEnTtsRouter({ kokoro, sapi, onProgress: sendProgress, onMore: sendMore, log, kokoroOnly: true, loadWaitMs: VOICE_LOAD_WAIT_MS, sapiWhileLoading: true });

  const core = createTalkVoiceCore({
    settings, saveSettings, ownerFlag,
    talkPrefs: (s) => talkPrefs(s),
    adapters: () => adapters || {},
    enTts: () => enTts,
    kokoro: () => kokoro,
    cloud,
    isLiveSay,
    takeLiveReply,
    // The Electron E2E env hooks are test-harness-only and have no meaning in the preview: force them off so a stale
    // variable cannot force a literal TTS failure on a real cloud provider.
    forceTtsFail: () => null,
    realTts: () => false,
    log: (line) => log(line.endsWith('\n') ? line.slice(0, -1) : line),
  });
  // The card lists kokoro only when this build can really run it (kokoro-js resolves); never a voice it cannot speak.
  core.setIncludeKokoro(() => kokoro.available());
  kokoro.setSpeed(core.voicePrefs().speed); // Settings > Voice > Speed (main.js:2031)

  // T-31-TAURI R1: voice ON prefetches at start exactly as before (R1b: deferring gains no RAM). Voice OFF never loads,
  // on any path. prewarm() is also the typing pre-warm (useful after an idle unload). Never rejects; failure = explicit
  // error on the next reply (no other voice).
  // Voice output turned on/off in Settings: on loads at once, off frees a loaded model at once.
  const onVoiceEnabled = (on) => {
    lastWarmAt = 0;
    if (on === true) { prewarm('voice-on'); return; }
    if (typeof kokoro.unload === 'function') kokoro.unload();
  };
  const WARM_RETRY_MS = 5000; // a failed warm is not retried by a keystroke storm
  let lastWarmAt = 0;
  const loadMode = kokoroLoadMode();
  const prewarm = (reason = 'unknown') => {
    if (loadMode === 'l2') return false; // L2: only a reply (the router's own prefetch) loads Kokoro
    if (settings().voiceEnabled === false || !kokoro.available()) return false;
    const st = kokoro.status();
    if (kokoro.isReady() || st.state === 'loading' || st.state === 'downloading') return false; // one warm per idle period
    const t = Date.now();
    if (st.state === 'error' && t - lastWarmAt < WARM_RETRY_MS) return false; // no retry storm after a failed load
    lastWarmAt = t;
    log(`[voice-host] prewarm reason=${reason}`);
    kokoro.prefetch(sendProgress);
    return true;
  };
  if (prefetch) {
    if (loadMode === 'l1') setTimeout(() => prewarm('l1-idle'), VOICE_L1_DELAY_MS).unref();
    else prewarm('start');
  }

  // The Rust host intercepts talk.openGuide before the sidecar and asks this verdict; the page only ever names a
  // guide id, so an unknown id is a refusal (logged by __host.logRefusal in main.mjs).
  // FL-3: the free-LLM limits links reuse the same fixed-id mechanism, with their own table. Both are fixed HTTPS URLs
  // owned by the sidecar; the page still only names an id.
  const guideUrl = (id) => (Object.prototype.hasOwnProperty.call(VOICE_GUIDES, id) ? VOICE_GUIDES[id]
    : (Object.prototype.hasOwnProperty.call(PRESET_LIMIT_GUIDES, id) ? PRESET_LIMIT_GUIDES[id] : null));
  const guideVerdict = (id) => {
    const url = typeof id === 'string' ? guideUrl(id) : null;
    return url ? { action: 'openExternal', url } : { action: 'refuse', reason: 'unknown_guide' };
  };

  const handlers = {
    // main.js:1220-1255 (through the core). The one writer of voiceSpeed/voiceVolume/provider prefs.
    'talk.getVoicePrefs': () => core.voicePrefs(),
    'talk.setVoicePrefs': (p) => core.setVoicePrefs(p),
    // main.js:1384-1427 (through the core). hasKey only; a key never crosses back.
    'talk.voiceProviders': async () => { await ensure(); return core.providerList(); },
    'talk.setProviderKey': async (id, raw) => { await ensure(); return core.setProviderKey(id, raw); },
    'talk.clearProviderKey': async (id) => { await ensure(); return core.clearProviderKey(id); },
    // Google only for now: the one provider whose key the owner will paste. The key is not stored and does not cross back.
    'talk.checkProviderKey': async (id, raw) => { const a = await ensure(); return id === 'google' && a.google ? a.google.checkKey(raw) : 'unsupported'; },
    // Voice output OFF: Test voice never loads Kokoro (R1 S2); it answers the voice-off message.
    'talk.testVoice': async (p) => { if (settings().voiceEnabled === false) return { ok: false, reason: 'voice-off' }; await ensure(); return core.testVoice(p); },
    // main.js:1300-1358 (through the core). A kokoro choice streams through tts-router.js; the cloud providers await
    // the whole text and are called exactly once, never across. Audio Buffers cross as `$bin` (protocol.mjs).
    // Voice output OFF: scheduled lines (live sayId) stay text-only too, so nothing loads Kokoro (R1 S2).
    'talk.tts': async (p) => { if (settings().voiceEnabled === false) return { ok: true, mime: 'audio/wav', audios: [], voice: 'none', reason: 'voice-off' }; await ensure(); return core.tts(p); },
    // main.js:1301-1305. Barge-in: stop synthesizing further Kokoro sentences for an abandoned turn. The renderer
    // passes a turnId; a call with the Electron object shape ({ turnId }) is accepted too, like sayAck below.
    'talk.ttsAbandon': (arg) => {
      const turnId = typeof arg === 'string' ? arg : (arg && typeof arg === 'object' ? arg.turnId : null);
      if (typeof turnId === 'string' && turnId) kokoro.abandon(turnId);
      return true;
    },
    // main.js:1375-1380: Kokoro when this build can run it, else the Windows voice's own info.
    // T-31-TAURI R1: the renderer's first keystroke after idle. No args; idempotent (see prewarm); main webview only (Rust).
    // The renderer's first keystroke after idle (useful after an idle unload). Idempotent; voice off never loads.
    'talk.voiceWarm': () => prewarm('typing'),
    'talk.voiceInfo': async () => (kokoro.available() ? kokoro.info() : sapi.info()),
    // main.js:1361-1366: the prefetch's observable state, or Electron's "no Kokoro" shape when kokoro-js is absent.
    // Step 12-1: a --settings-shots run reads its fixture state instead (main.js:1297 shotsVoiceState).
    'talk.voiceState': () => (voiceStateOverride ? voiceStateOverride() : kokoro.available() ? kokoro.status() : { ...OFF_STATE }),
    // Rust intercepts it (app_open_target -> __host.voiceGuideVerdict); a call that got here opened nothing.
    'talk.openGuide': () => false,
  };

  // stdin closed (the host is quitting): terminate the Kokoro worker so no ONNX thread outlives the sidecar.
  const dispose = () => kokoro.dispose();

  // The Marketplace's view of Kokoro's parts. The runtime is in the installer or in <data>/packs; the model is in <data>/tts/kokoro.
  const kokoroCache = path.join(dataDir, 'tts', 'kokoro');
  const kokoroModel = {
    present: () => fs.existsSync(path.join(kokoroCache, 'onnx-community', 'Kokoro-82M-v1.0-ONNX', 'onnx', 'model_fp16.onnx')),
    download: (onProgress) => Promise.resolve(kokoro.prefetch((p) => { onProgress(p); sendProgress(p); })),
    stop: () => { if (typeof kokoro.unload === 'function') kokoro.unload(); },
    remove: () => fs.rmSync(kokoroCache, { recursive: true, force: true, maxRetries: 2 }),
  };
  const kokoroBundled = () => Boolean(process.resourcesPath) && fs.existsSync(path.join(process.resourcesPath, 'voice-modules'));
  return { handlers, guideVerdict, ownerFlag, ensure, dispose, kokoro, prewarm, onVoiceEnabled, kokoroModel, kokoroBundled };
}
