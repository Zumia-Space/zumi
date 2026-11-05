// T-31 voice round 6: the REAL Kokoro worker (kokoro-worker.mjs, onnxruntime-node, fp16) on the new streamed-reply
// protocol ('open' / 'chunk' / 'end' via kokoro-tts.js speakLive), next to the unchanged whole-text 'speak' path.
// Plain Node, no Electron window. Needs the sha-verified model files in the owner's Kokoro seed folder (owner-paths kokoroSeed)
// (skips with exit 0 and says so when they are absent, e.g. on CI). Set TEMP to a D: folder to keep it off C:.
//   - speakLive on a reply that grows over ~1.2 s and is held open until chunk 0 arrives (max 10 s): chunk 0 is delivered
//     while the reply is still open (protocol), every chunk comes back once, in order, and the call resolves after the last one;
//   - latency (host-gated): chunk 0 ready within FIRST_AUDIO_BUDGET_MS of the first clause being available, asserted only on
//     the idle render box; anywhere else it is printed as INFO latency=<ms> budget=<ms>. The check asserts its own
//     preconditions (lib/kokoro-live-precond.cjs): on the render box (ZUMI_ELECTRON_HOST=box + ZUMI_RENDER_BOX_HOSTS=<hostname,…>, which must agree
//     with os.hostname()) a run that would skip the budget (host env/identity mismatch, model seed missing, box busy) exits INVALID = 3 instead of passing silently;
//   - speakStream (whole text) still delivers every sentence and resolves (regression for the queue rewrite);
//   - abandon() while a streamed reply is still open stops it cleanly.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ownerPath } from './lib/owner-paths.mjs';

const require = createRequire(import.meta.url);
const precond = require('./lib/kokoro-live-precond.cjs');
const { createKokoroTts } = require('../src/main/kokoro-tts.js');
const SEED = ownerPath('kokoroSeed', 'local/kokoro');
const invalid = (reason) => { console.log(`INVALID check-kokoro-live: ${reason}`); process.exit(precond.EXIT_INVALID); };
// Sampled before the model loads, so the load measured is the box's own, not ours.
let pre;
try {
  pre = await precond.evaluatePreconditions({ hostname: os.hostname(), env: process.env, readMarker: () => precond.readMarkerFile(), sampleLoad: () => precond.sampleCpuLoad(), listProcesses: precond.listRunningProcesses });
} catch (e) { invalid(e.message); }
if (pre.mode === 'INVALID') invalid(pre.reason);
const assertLatency = pre.mode === 'ASSERT';
if (!fs.existsSync(path.join(SEED, 'kokoro-v1.0-fp16.onnx'))) {
  if (assertLatency) invalid('render box but the local model seed is missing; the latency budget would be skipped');
  console.log('SKIP check-kokoro-live: no local model seed'); process.exit(0);
}

// P1 requirement: "EN p95 first-audio <= 3 s" from Enter to audio start (P1-REPORT.md:74, ROUND6.md:23). NOTES.md:30: the
// text reply may arrive before the audio, so "audio before the reply ends" is NOT a requirement. Budget for the TTS leg:
// 3000 - LLM p95 1295 (ROUND6) - ~40 in-app overhead (TTS part p95 824 - synth p95 784) = 1665, rounded down to 1650 ms,
// measured from the first clause being available to chunk 0 ready. Model load is excluded, as in P1; no extra warm-up.
// Evidence: main PC under load max 1547 ms (release-0211/assembly/kokoro-flake/).
const FIRST_AUDIO_BUDGET_MS = 1650;
// fakeLive's gap before its first piece: the first clause ('Sure,') exists FIRST_CLAUSE_AT_MS after the fake reply starts
// (the reply is created just before t0), so chunk-0 latency = got[0].at - FIRST_CLAUSE_AT_MS.
const FIRST_CLAUSE_AT_MS = 170;
const HOLD_OPEN_MAX_MS = 10000;

let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zumi-kokoro-live-'));
const dest = path.join(userDataDir, 'tts', 'kokoro', 'onnx-community', 'Kokoro-82M-v1.0-ONNX');
fs.mkdirSync(path.join(dest, 'onnx'), { recursive: true });
fs.copyFileSync(path.join(SEED, 'kokoro-v1.0-fp16.onnx'), path.join(dest, 'onnx', 'model_fp16.onnx'));
for (const f of ['config.json', 'tokenizer.json', 'tokenizer_config.json']) fs.copyFileSync(path.join(SEED, f), path.join(dest, f));
const tts = createKokoroTts({ userDataDir, log: () => {} });

// A live reply shaped like chat-brain's createLiveReply().
// holdOpen: after the last piece the reply stays open until release() or HOLD_OPEN_MAX_MS, so "chunk 0 arrived while
// the reply was open" is a protocol fact rather than a race against a fixed script length.
function fakeLive(pieces, gapMs, { holdOpen = false } = {}) {
  let text = '';
  let closed = false;
  const subs = new Set();
  let resolveFinal, release;
  const final = new Promise((r) => { resolveFinal = r; });
  const gate = new Promise((r) => { release = r; });
  (async () => {
    for (const p of pieces) { await sleep(gapMs); text += p; for (const cb of subs) cb(text); }
    if (holdOpen) await Promise.race([gate, sleep(HOLD_OPEN_MAX_MS)]);
    closed = true; subs.clear(); resolveFinal({ ok: true, reply: text });
  })();
  return { text: () => text, onText: (cb) => { subs.add(cb); return () => subs.delete(cb); }, final, isClosed: () => closed, release };
}

try {
  await tts.ensureReady(() => {});
  ok(true, 'kokoro: pipeline ready');

  const pieces = ['Sure,', ' I can draft', ' that email for you', ' right now.', ' Do you want it', ' short and friendly,', ' or more formal?'];
  const live = fakeLive(pieces, FIRST_CLAUSE_AT_MS, { holdOpen: true });
  const got = [];
  let chunk0WhileOpen = null;
  const t0 = Date.now();
  await tts.speakLive('a'.repeat(32), live, (s) => {
    if (got.length === 0) { chunk0WhileOpen = !live.isClosed(); live.release(); }
    got.push({ ...s, at: Date.now() - t0 });
  });
  ok(got.length >= 3 && got[0].index === 0 && got[0].text === 'Sure,', 'speakLive: chunk 0 is the first clause', JSON.stringify(got.map((g) => g.text)));
  ok(chunk0WhileOpen === true, `speakLive: chunk 0 arrived while the reply was still open (held open max ${HOLD_OPEN_MAX_MS} ms)`);
  const latency = got[0].at - FIRST_CLAUSE_AT_MS;
  console.log(precond.formatRunLine({ hostname: os.hostname(), mode: pre.mode, load: pre.load, latency, budget: FIRST_AUDIO_BUDGET_MS, marker: pre.marker }));
  if (assertLatency) ok(latency <= FIRST_AUDIO_BUDGET_MS, `first-audio latency=${latency} budget=${FIRST_AUDIO_BUDGET_MS}`);
  else console.log(`INFO latency=${latency} budget=${FIRST_AUDIO_BUDGET_MS}`);
  ok(got.map((g) => g.index).join(',') === got.map((_, i) => i).join(',') && got.map((g) => g.text).join(' ') === pieces.join('').trim(), 'speakLive: every chunk once, in order, whole reply covered', JSON.stringify(got.map((g) => g.text)));
  ok(got.every((g) => Buffer.isBuffer(g.audio) && g.audio.length > 1000 && g.audio.slice(0, 4).toString() === 'RIFF'), 'speakLive: each chunk is a real WAV');

  const whole = [];
  await tts.speakStream('b'.repeat(32), 'Okay. The build is green, and the tests passed on the first try.', (s) => whole.push(s));
  ok(whole.length >= 2 && whole[0].index === 0, 'speakStream (whole text): still every sentence, then resolves', JSON.stringify(whole.map((g) => g.text)));

  const slow = fakeLive(['Let me think', ' about that one', ' for a moment,', ' it is tricky.'], 400);
  const abandoned = [];
  const p = tts.speakLive('c'.repeat(32), slow, (s) => abandoned.push(s));
  await sleep(500);
  tts.abandon('c'.repeat(32));
  await p;
  await slow.final;
  await sleep(1500);
  ok(abandoned.length <= 1, `abandon: a streamed reply stops once abandoned (${abandoned.length} chunk(s) after abandon window)`);
} finally {
  tts.dispose();
  fs.rmSync(userDataDir, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
