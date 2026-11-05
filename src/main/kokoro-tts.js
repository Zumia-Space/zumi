'use strict';
// EN TTS: Kokoro-82M (fp16) via onnxruntime-node, device 'cpu'. All model loading + ONNX inference happens inside
// a worker_thread (kokoro-worker.mjs) so a slow sentence never stalls Electron's main-thread event loop (T-31
// voice P1 item 2). Sentences are streamed back one at a time as soon as each is synthesized, so the caller can
// start playback of sentence 1 while sentence 2 is still being generated.
//
// Result shape for a single sentence matches the existing TTS transports ({ mime, audios: Buffer[], voice }) so
// nothing downstream (renderer SpeechOut) needs an EN-specific code path beyond "it arrives in chunks."
//
// No Electron imports here on purpose (same pattern as local-tts.js) so a plain-Node harness can drive it.
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { createStreamChunker, createSpeechFeed, stripMarkup } = require('./speech-chunker.js');

const WORKER_FILE = path.join(__dirname, 'kokoro-worker.mjs');
const MAX_CHARS = 2000; // same convention as local-tts.js's TTS_CHARS

// kokoro-js/@huggingface/transformers/phonemizer are devDependencies, not production `dependencies` (T-31 voice
// P1 item 9): electron-builder's default packaging walks `dependencies` and would otherwise also pull in a LOT
// of install-time-only transitive baggage (tar/adm-zip/global-agent for onnxruntime-node's postinstall
// downloader; sharp/onnxruntime-web from @huggingface/transformers, both unused since this app forces
// device:'cpu' and never touches images) that isn't needed once the binaries are already on disk. Packaging
// instead copies exactly the files needed (package.json's `build.extraResources`, filtered) to
// resources/voice-modules/node_modules/ -- a normal node_modules layout, just outside app.asar (the native
// onnxruntime_binding.node could not run from inside an asar anyway). Dev/unpackaged runs (this worktree, the
// check-*.mjs harnesses) use plain node_modules resolution instead, since process.resourcesPath / that folder
// won't exist.
// Without it, the Marketplace's pack in the data dir (<userData>/packs/voice.kokoro-82m/voice-modules); a remove waiting on a locked DLL counts as gone.
const KOKORO_PACK_ID = 'voice.kokoro-82m';
function voiceModulesDir(userDataDir) {
  const fs = require('node:fs');
  const dir = typeof process !== 'undefined' && process.resourcesPath ? path.join(process.resourcesPath, 'voice-modules') : null;
  if (dir && fs.existsSync(dir)) return dir;
  if (!userDataDir) return null;
  const packs = path.join(userDataDir, 'packs');
  const pack = path.join(packs, KOKORO_PACK_ID, 'voice-modules');
  return fs.existsSync(pack) && !fs.existsSync(path.join(packs, `${KOKORO_PACK_ID}.remove-pending`)) ? pack : null;
}

// workerFactory: test seam only (scripts/check-voice-prefetch.mjs drives a fake worker); the app never passes it.
// idleUnloadMs (T-31-TAURI R1): free the model after this long without speech; the next speech reloads it. 0 = never
// (Electron's behaviour, unchanged). Unloading terminates the worker thread, which owns the ONNX session and every
// tensor, so nothing in this thread keeps the ~385 MB alive.
function createKokoroTts({ userDataDir, log = () => {}, workerFactory = () => new Worker(WORKER_FILE), idleUnloadMs = 0, reloadThrottleMs = 30000 }) {
  const cacheDir = path.join(userDataDir, 'tts', 'kokoro');
  const packaged = typeof process !== 'undefined' && Boolean(process.resourcesPath);
  let worker = null;
  let readyPromise = null;
  const pending = new Map(); // turnId -> { onSentence, resolve, reject }
  let onProgressCb = null;
  let idleTimer = null;
  let ensureReject = null; // settles the in-flight ensureReady when the worker is unloaded or crashes
  let crashed = false;     // a worker died on its own: reloads are throttled until one reaches ready
  let lastReloadAt = 0;
  const firstAudioPending = new Map(); // turnId -> request time, for the first-audio measurement line
  // Measurement hook (Pi2's box kit greps '[voice-measure]'): ISO timestamp + epoch ms on every line.
  const measure = (event, extra = '') => { const t = Date.now(); log(`[voice-measure] event=${event} ts=${new Date(t).toISOString()} epochMs=${t}${extra ? ' ' + extra : ''}`); };
  const touch = () => {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (!(idleUnloadMs > 0) || !worker) return;
    idleTimer = setTimeout(() => { idleTimer = null; if (pending.size > 0) touch(); else unload(); }, idleUnloadMs);
    if (idleTimer.unref) idleTimer.unref();
  };
  // T-31 QC-cuoi fix d (09-10): observable readiness, so talk:tts can route a reply to the Windows voice instead of
  // waiting on a download/pipeline build that is still running, and Settings > Voice can show where it is.
  // state: idle (nothing started) | downloading (a pinned file is being fetched) | loading (files verified, ONNX
  // pipeline building) | ready | error (last attempt failed; the next ensureReady() retries from scratch).
  const st = { state: 'idle', phase: null, loaded: 0, total: 0, error: null };
  // Settings > Voice > Speed (T-31 settings-a2): Kokoro's own speaking speed, sent with every turn so a change applies
  // from the next reply on. Clamped to the range Settings offers.
  let speed = 1;
  const setSpeed = (x) => { speed = typeof x === 'number' && Number.isFinite(x) ? Math.min(1.5, Math.max(0.75, x)) : 1; return speed; };

  function spawn() {
    if (worker) return worker;
    const w = worker = workerFactory();
    worker.on('message', (msg) => {
      if (msg.type === 'progress') {
        if (st.state !== 'ready') {
          const isFile = msg.phase && msg.phase !== 'pipeline';
          st.state = isFile ? 'downloading' : 'loading';
          st.phase = msg.phase || null; st.loaded = msg.loaded || 0; st.total = msg.total || 0;
        }
        onProgressCb && onProgressCb(msg);
        return;
      }
      if (msg.type === 'ready' || msg.type === 'ensureError') return; // handled by ensureReady's own listener below
      const turn = pending.get(msg.turnId);
      if (!turn) return;
      if (msg.type === 'sentence') {
        // T-31 voice P1 live-E2E fix 1: worker -> main hop latency for chunk 0 (per-stage timing, no secrets).
        if (msg.index === 0 && firstAudioPending.has(msg.turnId)) { measure('first-audio', `turn=${String(msg.turnId).slice(0, 8)} sinceRequestMs=${Date.now() - firstAudioPending.get(msg.turnId)}`); firstAudioPending.delete(msg.turnId); }
        if (msg.index === 0) log(`turn=${String(msg.turnId).slice(0, 8)} chunk0 workerToMainMs=${Date.now() - msg.synthEndedAt}`);
        turn.onSentence({ index: msg.index, text: msg.text, mime: 'audio/wav', audio: Buffer.from(msg.wav) });
        return;
      }
      if (msg.type === 'done') { pending.delete(msg.turnId); firstAudioPending.delete(msg.turnId); turn.resolve(); touch(); return; }
      if (msg.type === 'speakError') { pending.delete(msg.turnId); firstAudioPending.delete(msg.turnId); touch(); turn.reject(Object.assign(new Error(msg.message), { retryable: msg.retryable !== false })); }
    });
    // Crash recovery: drop EVERY cached promise/timer (a stale prefetchPromise made Kokoro dead until restart), settle
    // the in-flight load and the pending turns, and let the next speech/pre-warm reload (throttled, see ensureReady).
    const onCrash = (e) => {
      if (worker !== w) return; // an unload/dispose already detached this worker
      log(`kokoro worker crashed: ${e && e.message}`);
      worker = null; readyPromise = null; prefetchPromise = null; crashed = true;
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      st.state = 'error'; st.error = String((e && e.message) || e).slice(0, 200);
      if (ensureReject) { const r = ensureReject; ensureReject = null; r(Object.assign(new Error(st.error), { retryable: true })); }
      for (const t of pending.values()) t.reject(e);
      pending.clear(); firstAudioPending.clear();
    };
    worker.on('error', onCrash);
    worker.on('exit', (code) => onCrash(new Error(`worker exited (code ${code})`)));
    return worker;
  }

  // Lazy, memoized: first call downloads+verifies (if not already cached) and builds the pipeline; later calls
  // reuse the same resolved promise. onProgress receives { phase, loaded, total } for a UI progress indicator.
  function ensureReady(onProgress) {
    if (readyPromise) return readyPromise;
    if (onProgress) onProgressCb = onProgress;
    if (crashed) { // at most one reload attempt per window after a crash: no respawn loop on a broken install
      const t = Date.now();
      if (t - lastReloadAt < reloadThrottleMs) return Promise.reject(Object.assign(new Error('crash_throttled'), { retryable: true }));
      lastReloadAt = t;
    }
    const w = spawn();
    const tLoad = Date.now(); measure('load-start');
    st.state = 'loading'; st.error = null; // until the worker reports a file download (-> downloading) or ready
    readyPromise = new Promise((resolve, reject) => {
      ensureReject = reject;
      const onMsg = (msg) => {
        if (msg.type === 'ready') { w.off('message', onMsg); ensureReject = null; crashed = false; st.state = 'ready'; st.phase = null; measure('load-end', `loadMs=${Date.now() - tLoad}`); touch(); resolve(); }
        else if (msg.type === 'ensureError') { w.off('message', onMsg); ensureReject = null; readyPromise = null; st.state = 'error'; measure('load-failed', `loadMs=${Date.now() - tLoad}`); st.error = String(msg.message || '').slice(0, 200); reject(Object.assign(new Error(msg.message), { retryable: msg.retryable !== false })); }
      };
      w.on('message', onMsg);
      w.postMessage({ cmd: 'ensure', cacheDir, vmDir: voiceModulesDir(userDataDir) });
    });
    return readyPromise;
  }

  // text -> each sentence's WAV delivered to onSentence as soon as it is ready; resolves once the whole reply is
  // spoken (or rejects on a real synth error). turnId lets the caller abandon a stale turn (barge-in).
  function speakStream(turnId, text, onSentence) {
    text = stripMarkup(text); // T-31 0.2.3 B1: the voice never reads markdown/<think>/emoji
    if (typeof text !== 'string' || !text.trim()) return Promise.reject(Object.assign(new Error('empty_text'), { retryable: false }));
    if (text.length > MAX_CHARS) return Promise.reject(Object.assign(new Error('text_too_long'), { retryable: false }));
    const w = spawn();
    log(`turn=${String(turnId).slice(0, 8)} speakStream requested, chars=${text.length}`); // T-31 voice P1 live-E2E fix 1: per-stage timing
    touch();
    return new Promise((resolve, reject) => {
      pending.set(turnId, { onSentence, resolve, reject });
      if (turnId !== '__warmup__') firstAudioPending.set(turnId, Date.now());
      w.postMessage({ cmd: 'speak', turnId, text, speed });
    });
  }

  // Round 6: the same per-sentence delivery, but for a reply still streaming in from the LLM (chat-brain's live reply:
  // text(), onText(cb), final). Text is cut into chunks here as it grows (speech-chunker.js: first chunk <= 24 chars,
  // so chunk 0 can be synthesized while the model is still writing) and each chunk goes to the worker on its own
  // ('open' / 'chunk' / 'end'); the worker synthesizes them in order. Resolves when the last chunk is spoken.
  function speakLive(turnId, live, onSentence) {
    const w = spawn();
    const chunker = createStreamChunker();
    const speechFeed = createSpeechFeed(chunker);
    log(`turn=${String(turnId).slice(0, 8)} speakLive requested, chars so far=${live.text().length}`);
    touch();
    return new Promise((resolve, reject) => {
      pending.set(turnId, { onSentence, resolve, reject });
      firstAudioPending.set(turnId, Date.now());
      // The worker hears of this turn at its first chunk: a reply with nothing to say settles here, with no worker message.
      let opened = false;
      const send = (chunks) => { for (const c of chunks) if (c) { if (!opened) { opened = true; w.postMessage({ cmd: 'open', turnId, speed }); } w.postMessage({ cmd: 'chunk', turnId, text: c }); } };
      const feed = (full, final) => {
        if (!pending.has(turnId)) return; // abandoned (barge-in): stop feeding
        send(speechFeed(full, final));
      };
      const off = live.onText((full) => feed(full, false));
      feed(live.text(), false);
      live.final.then(() => {
        off();
        if (!pending.has(turnId)) return;
        feed(live.text(), true);
        send(chunker.end());
        if (opened) { w.postMessage({ cmd: 'end', turnId }); return; }
        pending.delete(turnId); firstAudioPending.delete(turnId); touch(); resolve();
      });
    });
  }

  // T-31 QC-cuoi fix d (09-10): background prefetch at app start -- downloads (sha-pinned, kokoro-worker.mjs's
  // ensureFiles) if the model is not on disk yet, builds the pipeline, then runs one tiny discarded synthesis so the
  // first real reply after "ready" pays no first-inference cost either. Idempotent: a second call while one is in
  // flight returns the same promise; after a failure the next call retries. Never rejects (logged instead): a
  // failed prefetch only means replies keep using the Windows voice until a later attempt succeeds.
  let prefetchPromise = null;
  function prefetch(onProgress) {
    if (!available()) return Promise.resolve(false);
    if (prefetchPromise) return prefetchPromise;
    const t0 = Date.now();
    log(`prefetch start (state=${st.state})`);
    prefetchPromise = ensureReady(onProgress)
      .then(() => speakStream('__warmup__', 'Hi there.', () => {}))
      .then(() => { log(`prefetch done in ${Date.now() - t0}ms (state=ready)`); return true; })
      .catch((e) => { prefetchPromise = null; log(`prefetch failed after ${Date.now() - t0}ms: ${String((e && e.message) || e).slice(0, 200)}`); return false; });
    return prefetchPromise;
  }
  const isReady = () => st.state === 'ready';
  const status = () => ({ ...st });

  function abandon(turnId) {
    const turn = pending.get(turnId);
    pending.delete(turnId);
    firstAudioPending.delete(turnId);
    if (turn) turn.resolve(); // a deliberate stop, not a failure -- the caller's promise settles immediately
    if (worker) worker.postMessage({ cmd: 'abandon', turnId });
  }

  // Packaged: kokoro-js lives under resources/voice-modules/node_modules/ (see voiceModulesDir() above), not on
  // the normal require path, so its presence there is the signal. Dev/unpackaged: plain node_modules resolution.
  function available() {
    const vmDir = voiceModulesDir(userDataDir);
    if (vmDir) return require('node:fs').existsSync(path.join(vmDir, 'node_modules', 'kokoro-js', 'dist', 'kokoro.js'));
    if (packaged) return false; // an installed app has no node_modules to fall back on
    try { require.resolve('kokoro-js'); return true; } catch { return false; }
  }

  // Free the model: terminate the worker (its heap, ONNX session and tensors go with the thread) and drop every
  // reference here, so the next ensureReady()/prefetch()/speak starts from a clean idle state. In-flight turns are
  // rejected as retryable (the Tauri router answers kokoro_unloaded; Electron's falls back to the Windows voice); the idle timer never fires with turns pending.
  function unload() {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (!worker) return;
    const w = worker;
    worker = null; readyPromise = null; prefetchPromise = null; onProgressCb = null;
    st.state = 'idle'; st.phase = null; st.loaded = 0; st.total = 0; st.error = null;
    for (const t of pending.values()) t.reject(Object.assign(new Error('unloaded'), { retryable: true }));
    pending.clear(); firstAudioPending.clear();
    if (ensureReject) { const r = ensureReject; ensureReject = null; r(Object.assign(new Error('voice_off'), { retryable: false })); }
    w.terminate();
    measure('unload');
  }
  function dispose() { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } if (worker) { worker.terminate(); worker = null; readyPromise = null; prefetchPromise = null; } }

  return { available, ensureReady, speakStream, speakLive, abandon, dispose, unload, prefetch, isReady, status, setSpeed, speed: () => speed, info: () => ({ mode: 'kokoro', voice: 'af_heart' }) };
}

module.exports = { createKokoroTts };
