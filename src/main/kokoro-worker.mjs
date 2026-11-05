// Runs inside a worker_thread (spawned by kokoro-tts.js) so model load + ONNX inference never block Electron's
// main-thread event loop (T-31 voice P1 item 2). ESM on purpose: kokoro-js/`@huggingface/transformers` are
// ESM-only (see their package.json `exports`); Node loads a worker's entry file as ESM when its extension is
// `.mjs`, same convention this repo already uses for other main-process modules (board-bridge.mjs etc.).
//
// Protocol (postMessage), all messages carry no secrets:
//   in:  { cmd: 'ensure', cacheDir }                     -> downloads/verifies once, builds the pipeline
//        { cmd: 'speak', turnId, text }                  -> streams back one 'sentence' message per sentence
//        { cmd: 'open', turnId } + { cmd: 'chunk', turnId, text }* + { cmd: 'end', turnId }
//                                                         -> round 6: a reply still streaming from the LLM, already cut
//                                                            into chunks by main (speech-chunker.js); each chunk is
//                                                            synthesized in arrival order, same 'sentence'/'done' output
//        { cmd: 'abandon', turnId }                      -> stop emitting further sentences for that turn (barge-in)
//   out: { type: 'progress', phase, loaded, total }
//        { type: 'ready' } | { type: 'ensureError', message, retryable }
//        { type: 'sentence', turnId, index, text, wav /* ArrayBuffer, transferred */ }
//        { type: 'done', turnId }
//        { type: 'speakError', turnId, message, retryable }
import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const VOICE = 'af_heart';
const DTYPE = 'fp16';

// sha256, independently computed by this task's worker from the files already verified in
// the owner's Kokoro sample folder (same values as that folder's sha256sums.txt). A mismatch after
// download is treated as a corrupt/tampered fetch, never used.
const PINNED_SHA256 = {
  'onnx/model_fp16.onnx': 'ba4527a874b42b21e35f468c10d326fdff3c7fc8cac1f85e9eb6c0dfc35c334a',
  'config.json': 'df34b4f930b23447cd4dc410fabfb42eb3f24e803e6c3f97d618fb359380a36f',
  'tokenizer.json': '77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34',
  'tokenizer_config.json': 'be1cb066d6ef6b074b3f15e6a6dd21ac88ff3cdaedf325f0aaed686c70f75d20',
};
// Bundled with kokoro-js itself (Node never fetches voices over the network -- see kokoro-js dist, the voice
// loader reads `../voices/<name>.bin` relative to its own install dir when `fs/promises` is available). Checked
// once per process as a startup integrity gate, not re-downloaded.
const PINNED_VOICE_SHA256 = 'd583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b';

function sha256File(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(p);
    s.on('data', (d) => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

// Egress policy (T-31 8b part 2). The sidecar passes workerData.egress = 'hf-only'; Electron passes nothing and keeps
// the unrestricted behaviour. 'hf-only' checks EVERY hop (the first request and each redirect target): https only,
// and the host must be huggingface.co or a subdomain of huggingface.co / hf.co. Measured 22-10: model_fp16.onnx 302s
// to https://us.aws.cdn.hf.co/xet-bridge-us/..., config.json 307s to https://huggingface.co/api/resolve-cache/...
// The sha256 pins above still decide whether the bytes are used.
const EGRESS_HF_ONLY = workerData && workerData.egress === 'hf-only';
const HF_HOST_RE = /^(?:huggingface\.co|(?:[a-z0-9-]+\.)+(?:huggingface|hf)\.co)$/;
function checkHop(url) {
  if (!EGRESS_HF_ONLY) return;
  let u;
  try { u = new URL(url); } catch (e) { throw Object.assign(new Error(`egress_refused: invalid url`), { code: 'egress_refused', url }); }
  if (u.protocol !== 'https:') throw Object.assign(new Error(`egress_refused: non-https hop ${u.protocol}//${u.host}`), { code: 'egress_refused', url });
  if (!HF_HOST_RE.test(u.hostname.toLowerCase())) throw Object.assign(new Error(`egress_refused: host ${u.hostname} is not on the allow-list`), { code: 'egress_refused', url });
}
// Test seam: a module exporting { get(url, opts, cb) } replaces https.get so the check can run with no network. The
// sidecar never sets it in production.
let testTransport = null;
async function transportFor(url) {
  if (workerData && workerData.egressTransportModule) {
    testTransport = testTransport || await import(workerData.egressTransportModule);
    return testTransport;
  }
  return url.startsWith('http://') ? http : https;
}

function download(url, destTmp, onProgress) {
  return new Promise((resolve, reject) => {
    try { checkHop(url); } catch (e) { return reject(e); }
    const file = fs.createWriteStream(destTmp);
    // Picked from the URL actually being requested (not hardcoded to https) so a resolved redirect is followed
    // on its own scheme -- matters once a relative Location is resolved via `new URL(location, url)` below,
    // which is scheme-agnostic by design, and lets check-kokoro-download-redirect.mjs exercise this against a
    // plain local http test server instead of needing a TLS cert.
    // `.then(onMod).catch(onErr)`, not `.then(onMod, onErr)`: mod.get() can throw SYNCHRONOUSLY for a URL the
    // chosen transport rejects (e.g. an ftp:// redirect in default mode -> ERR_INVALID_PROTOCOL). With the second
    // argument those throws escape the promise and the download never settles; a trailing catch turns every
    // failure, sync or async, into the same rejection.
    transportFor(url).then((mod) => {
    const req = mod.get(url, { headers: { 'user-agent': 'zumi-desktop/0.2.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close(); fs.unlink(destTmp, () => {});
        // ROOT CAUSE (T-31 voice P1 packaged-app bug): huggingface.co's /resolve/main/<file> redirects
        // differently per file. LFS-tracked files (onnx/model_fp16.onnx) 307 to an ABSOLUTE CDN URL; small
        // git-blob files (config.json, tokenizer*.json) 307 to a RELATIVE Location (e.g.
        // "/api/resolve-cache/..."). Passing that straight to https.get() throws `TypeError [ERR_INVALID_URL]:
        // Invalid URL` with zero context -- which is exactly the "EN speak failed ... Invalid URL" anh saw on
        // every turn (model finishes downloading+caching fine, then config.json's redirect crashes ensureFiles()
        // before it ever gets cached, so every later turn retries from scratch). `new URL(location, url)`
        // resolves a relative Location against the request it came from (and is a no-op if already absolute),
        // which is what every HTTP client is supposed to do with a redirect.
        let nextUrl;
        try { nextUrl = new URL(res.headers.location, url).toString(); }
        catch (e) { return reject(Object.assign(new Error(`invalid redirect Location "${res.headers.location}" from ${url}: ${(e && e.message) || e}`), { cause: e, url })); }
        return download(nextUrl, destTmp, onProgress).then(resolve, reject);
      }
      if (res.statusCode !== 200) { file.close(); fs.unlink(destTmp, () => {}); return reject(Object.assign(new Error(`http_${res.statusCode} url=${url}`), { url })); }
      const total = Number(res.headers['content-length']) || 0;
      let loaded = 0;
      res.on('data', (chunk) => { loaded += chunk.length; onProgress && onProgress({ loaded, total }); });
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
    });
    req.on('error', (e) => { file.close(); fs.unlink(destTmp, () => {}); reject(Object.assign(e, { url })); });
    }).catch((e) => { file.close(); fs.unlink(destTmp, () => {}); reject(e); });
  });
}

// Pre-seeds / verifies transformers.js's own on-disk FileCache (keyed by `<repoId>/<relPath>`, see
// @huggingface/transformers dist: FileCache.match/put join(cacheDir, requestURL)) so from_pretrained() below finds
// a hash-verified file already in place and skips the network entirely once this has run once.
async function ensureFiles(cacheDir, onProgress) {
  for (const [relPath, pinned] of Object.entries(PINNED_SHA256)) {
    const dest = path.join(cacheDir, MODEL_ID, relPath);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    if (fs.existsSync(dest)) {
      const got = await sha256File(dest);
      if (got === pinned) continue; // already cached + verified, no network
      await fsp.unlink(dest); // stale/corrupt: re-fetch
    }
    const tmp = `${dest}.part`;
    const url = `https://huggingface.co/${MODEL_ID}/resolve/main/${relPath}`;
    onProgress({ phase: relPath, loaded: 0, total: 0 });
    try {
      await download(url, tmp, ({ loaded, total }) => onProgress({ phase: relPath, loaded, total }));
      const got = await sha256File(tmp);
      if (got !== pinned) throw new Error(`sha256_mismatch:${relPath} url=${url}`);
      await fsp.rename(tmp, dest);
    } catch (e) {
      await fsp.unlink(tmp).catch(() => {}); // never leave a half-written/mismatched .part behind
      // Re-thrown with the file + URL attached: the ensureError IPC message below only carries `.message`
      // across the worker_thread boundary (structured-clone of the stack is dropped on purpose by this repo's
      // own `String(e.message)` call), so without this the main process only ever sees the bare low-level
      // message (e.g. "Invalid URL") with no way to tell which file or URL failed -- see handleEnsure()'s catch.
      throw new Error(`kokoro download failed for ${relPath} (${url}): ${(e && e.message) || e}`, { cause: e });
    }
  }
}

let tts = null; // KokoroTTS instance, built once
const abandoned = new Set();

async function handleEnsure(cacheDir, vmDir) {
  try {
    await ensureFiles(cacheDir, (p) => parentPort.postMessage({ type: 'progress', ...p }));
    // Packaged app: kokoro-js (+ its own nested @huggingface/transformers/phonemizer) lives under
    // resources/voice-modules/node_modules/, outside the normal require path (T-31 voice P1 item 9 -- see
    // kokoro-tts.js's voiceModulesDir() comment for why). Dev/unpackaged: plain bare-specifier resolution.
    // kokoro-js has no `./package.json` export subpath, so resolve its main entry (dist/kokoro.js) and mirror
    // its own internal `../voices/<name>.bin` relative lookup from there.
    const kokoroMainPath = vmDir
      ? path.join(vmDir, 'node_modules', 'kokoro-js', 'dist', 'kokoro.js')
      : fileURLToPath(import.meta.resolve('kokoro-js'));
    const voicePath = path.join(path.dirname(kokoroMainPath), '..', 'voices', `${VOICE}.bin`);
    const voiceHash = await sha256File(voicePath);
    if (voiceHash !== PINNED_VOICE_SHA256) throw new Error('sha256_mismatch:voice_pack');

    const { KokoroTTS } = await import(vmDir ? pathToFileURL(kokoroMainPath).href : 'kokoro-js');
    // ROOT CAUSE (T-31 voice P1, bug 2 of 2): kokoro-js's own `env` export is NOT the real
    // `@huggingface/transformers` env singleton -- its dist bundle re-exports a throwaway wrapper object that
    // only proxies `wasmPaths` (irrelevant here: device:'cpu' uses the native onnxruntime-node binding, never
    // onnxruntime-web/wasm). Setting `.cacheDir`/`.allowRemoteModels` on THAT object (as this code used to do)
    // is a silent no-op: `from_pretrained()` below still reads the real library's own `env.cacheDir`, whose
    // default is `<transformers-package-dir>/.cache/` -- writable (and already populated from a past real run)
    // in dev's own node_modules, but a fresh, install-directory-relative path in the packaged app that
    // ensureFiles() above never touched, so the model/config files it just downloaded were invisible to
    // from_pretrained() and it tried (and, once bug 1's redirect crash was fixed, failed) to reload them itself.
    // Fix: import `@huggingface/transformers` directly -- the exact same resolved module/singleton kokoro-js's
    // bundle imports internally (same vmDir copy in packaged, same node_modules copy in dev) -- and mutate its
    // real `env` before calling from_pretrained().
    const transformersMainPath = vmDir
      ? path.join(vmDir, 'node_modules', '@huggingface', 'transformers', 'dist', 'transformers.node.mjs')
      : null;
    const { env } = await import(vmDir ? pathToFileURL(transformersMainPath).href : '@huggingface/transformers');
    env.cacheDir = cacheDir;
    // hf-only mode: the verified download above is the ONLY way model bytes arrive, so transformers.js must not
    // fetch by itself (it would bypass the per-hop check). Electron's default keeps its unrestricted behaviour.
    env.allowRemoteModels = !EGRESS_HF_ONLY;
    tts = await KokoroTTS.from_pretrained(MODEL_ID, {
      dtype: DTYPE,
      device: 'cpu',
      progress_callback: (p) => parentPort.postMessage({ type: 'progress', phase: 'pipeline', loaded: p.loaded || 0, total: p.total || 0 }),
    });
    parentPort.postMessage({ type: 'ready' });
  } catch (e) {
    const message = String((e && e.message) || e);
    // Full stack (and the `cause` chain down to the original URL, see ensureFiles()/download() above) is logged
    // here, in the worker thread, because the ensureError IPC message to the main process only ever carries
    // `message` -- a stack never crosses that boundary. Without this log line the original failure (which file,
    // which URL, which redirect) was unrecoverable after the fact; this is the fix for that blind spot.
    process.stdout.write(`[kokoro-worker] ensureReady failed: ${message}\n${e && e.stack ? e.stack + '\n' : ''}${e && e.cause ? `cause: ${(e.cause && e.cause.stack) || e.cause}\n` : ''}`);
    parentPort.postMessage({ type: 'ensureError', message, retryable: true });
  }
}

// Sentence-chunked streaming (item 2): split on clause punctuation first (., !, ?, ;, :, ,), then word-wrap any
// clause still longer than CHUNK_MAX_CHARS. The word-wrap half is a deliberate latency trade-off, not a cosmetic
// choice: on this CPU a single un-split sentence of ~70-90 chars synthesizes in 2.5-4.8s, which alone blows the
// 3s p95 first-audio budget (measured, see P1-REPORT.md) -- a reply with no early punctuation would otherwise
// have no "sentence 1" to play early. Capping every spoken chunk's length bounds its synth time regardless of
// how the reply is punctuated, at the cost of an occasional mid-clause prosody seam.
const CHUNK_MAX_CHARS = 45;
// T-31 voice P1 live-E2E fix 1: the live spare-PC run measured p95 first-audio = 3352ms (vs. 1557ms in the
// isolated harness) -- first-audio latency is bounded by how long CHUNK 0 alone takes to synthesize, so it alone
// gets a tighter cap than the rest of the reply (~20-25 chars: a short lead-in clause, not a cosmetic choice --
// every other chunk keeps the 45-char cap so this doesn't add extra prosody seams across the whole reply).
const FIRST_CHUNK_MAX_CHARS = 24;
function chunkText(text) {
  const clauses = text.split(/(?<=[.!?;:,])\s+/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const clause of clauses) {
    let rest = clause;
    while (rest.length > CHUNK_MAX_CHARS) {
      let cut = rest.lastIndexOf(' ', CHUNK_MAX_CHARS);
      if (cut <= 0) cut = CHUNK_MAX_CHARS; // no space in range: one long token, hard-cut rather than stall
      out.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) out.push(rest);
  }
  const result = out.length ? out : [text];
  if (result[0].length > FIRST_CHUNK_MAX_CHARS) {
    let cut = result[0].lastIndexOf(' ', FIRST_CHUNK_MAX_CHARS);
    if (cut <= 0) cut = FIRST_CHUNK_MAX_CHARS;
    const head = result[0].slice(0, cut).trim();
    const tail = result[0].slice(cut).trim();
    if (head && tail) result.splice(0, 1, head, tail);
  }
  return result;
}

// T-31 voice P1 live-E2E fix 2: the live E2E's own analyser taps (tap-dump.json) showed RMS pinned at exactly 0
// for ~110-155ms at the start of every one of 20 varied Kokoro-rendered chunks before the audible waveform
// begins -- a real, consistent property of Kokoro's output, not a sampling artifact. SpeechOut schedules
// playback from sample 0, so that silent lead-in shows up as the "mouth/audio sync" onset lag (0/20 within
// 100ms). Trimming it here (amplitude threshold, on the raw Float32 samples, before toWav() encodes them) makes
// the scheduled start and the audible start the same sample for every chunk, not just a UI-side workaround.
// A single-sample amplitude check (the first literal reading of "amplitude threshold") turned out to fire on an
// early transient while the true onset was still ramping up for some utterances (measured: 9/10 within the
// <=100ms gate, one outlier at ~150ms -- see scripts/check-mouth-sync.mjs). speech.js's mouth() driver itself
// gates on a WINDOWED RMS (AnalyserNode's fftSize=1024), not a single sample, so trimming against the same kind
// of measure (short sliding RMS window) is what actually matches what the driver -- and the ear -- perceive as
// "sound has started," rather than reacting to one loud sample mid-ramp.
const SILENCE_RMS_THRESHOLD = 0.012; // close to speech.js mouth()'s own silence gate (level<0.04, level=rms*4.5 -> rms~0.0089)
const SILENCE_WINDOW_SAMPLES = 240; // ~10ms @24kHz -- long enough to average out one transient, short enough not to eat real onset
const SILENCE_STEP_SAMPLES = 60; // ~2.5ms scan resolution
const SILENCE_PREROLL_MS = 10; // keep a tiny pre-roll so the trimmed onset doesn't click
function trimLeadingSilence(rawAudio) {
  const samples = rawAudio.audio; // Float32Array, kokoro-js's RawAudio
  const n = samples ? samples.length : 0;
  if (!n) return;
  let onset = n;
  for (let start = 0; start + SILENCE_WINDOW_SAMPLES <= n; start += SILENCE_STEP_SAMPLES) {
    let sumSq = 0;
    for (let i = start; i < start + SILENCE_WINDOW_SAMPLES; i++) { const v = samples[i]; sumSq += v * v; }
    if (Math.sqrt(sumSq / SILENCE_WINDOW_SAMPLES) >= SILENCE_RMS_THRESHOLD) { onset = start; break; }
  }
  if (onset >= n) return; // measured as silent throughout (unexpected) -- leave it untouched
  const preroll = Math.round((SILENCE_PREROLL_MS / 1000) * rawAudio.sampling_rate);
  const start = Math.max(0, onset - preroll);
  if (start > 0) rawAudio.audio = samples.subarray(start);
}

// T-31 voice P1 live-E2E fix 1: per-stage timing (no secrets -- turnId prefix + ms only), logged to stdout so a
// live re-run on the spare PC can show exactly where "reply arrives -> first audible chunk" goes: time spent
// queued behind an earlier turn (recv -> synthStart), actual ONNX inference time (synthStart -> synthEnd).
// One queue per turn (round 6): 'speak' fills it with the whole text's chunks and closes it at once; a streamed reply
// ('open'/'chunk'/'end') fills it while the LLM is still writing. pump() synthesizes queued chunks in order and posts
// 'done' once the queue is closed and empty. queuedMs = chunk arrival -> synth start.
const streams = new Map(); // turnId -> { queue: [{ text, at }], ended, running, index, speed }
// speed: Settings > Voice > Speed (kokoro-tts.js sends it with 'speak' / 'open'); 1 when absent.
function openStream(turnId, speed) {
  if (!streams.has(turnId)) streams.set(turnId, { queue: [], ended: false, running: false, index: 0, speed: typeof speed === 'number' && speed > 0 ? speed : 1 });
  return streams.get(turnId);
}
async function pump(turnId) {
  const s = streams.get(turnId);
  if (!s || s.running) return;
  if (!tts) { streams.delete(turnId); parentPort.postMessage({ type: 'speakError', turnId, message: 'not_ready', retryable: true }); return; }
  s.running = true;
  try {
    while (s.queue.length && !abandoned.has(turnId)) {
      const { text: chunk, at } = s.queue.shift();
      const tSynthStart = Date.now();
      const audio = await tts.generate(chunk, { voice: VOICE, speed: s.speed });
      const tSynthEnd = Date.now();
      if (abandoned.has(turnId)) break;
      trimLeadingSilence(audio);
      const wav = audio.toWav(); // ArrayBuffer
      if (s.index === 0) {
        process.stdout.write(`[kokoro-worker] turn=${turnId.slice(0, 8)} chunk0 chars=${chunk.length} queuedMs=${tSynthStart - at} synthMs=${tSynthEnd - tSynthStart}\n`);
      }
      parentPort.postMessage({ type: 'sentence', turnId, index: s.index++, text: chunk, wav, synthEndedAt: tSynthEnd }, [wav]);
    }
  } catch (e) {
    streams.delete(turnId);
    parentPort.postMessage({ type: 'speakError', turnId, message: String((e && e.message) || e), retryable: true });
    return;
  }
  s.running = false;
  if (abandoned.has(turnId)) { abandoned.delete(turnId); streams.delete(turnId); return; }
  if (s.ended && !s.queue.length) { streams.delete(turnId); parentPort.postMessage({ type: 'done', turnId }); }
}
function handleSpeak(turnId, text, speed) {
  const s = openStream(turnId, speed);
  const at = Date.now();
  for (const chunk of chunkText(text)) s.queue.push({ text: chunk, at });
  s.ended = true;
  pump(turnId);
}
function handleAbandon(turnId) {
  abandoned.add(turnId);
  const s = streams.get(turnId);
  if (s && !s.running) { streams.delete(turnId); abandoned.delete(turnId); } // nothing in flight to stop
}

// `parentPort` is only non-null when this file is actually running as a worker_thread (how kokoro-tts.js always
// loads it). Guarded so scripts/check-kokoro-download-redirect.mjs can `import()` this module directly in the
// main thread to unit-test `download()`'s redirect handling (the regression test for the "Invalid URL" bug)
// without a real worker_thread, a real model download, or a real Electron process.
if (parentPort) {
  parentPort.on('message', (msg) => {
    if (msg.cmd === 'ensure') handleEnsure(msg.cacheDir, msg.vmDir);
    else if (msg.cmd === 'speak') handleSpeak(msg.turnId, msg.text, msg.speed);
    else if (msg.cmd === 'open') openStream(msg.turnId, msg.speed);
    else if (msg.cmd === 'chunk') { if (!abandoned.has(msg.turnId)) { openStream(msg.turnId).queue.push({ text: msg.text, at: Date.now() }); pump(msg.turnId); } }
    else if (msg.cmd === 'end') { const s = streams.get(msg.turnId); if (s) { s.ended = true; pump(msg.turnId); } }
    else if (msg.cmd === 'abandon') handleAbandon(msg.turnId);
  });
}

export { download };
