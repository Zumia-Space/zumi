// T-31 voice P1 acceptance measurement: EN first-audio latency, real main-process Kokoro TTS (onnxruntime-node,
// fp16, af_heart, device 'cpu') on THIS machine (owner's Xeon E5-2686 v4 class). Plain Node, no Electron window
// (binding rule: no Electron/Zumi app launch on the owner's main PC) -- same pattern as check-local-tts.mjs.
//
// Method: ensureReady() once (one-time model-load cost, same as a real app session loads the pipeline once at
// startup / first use, not per reply) using a cache dir pre-seeded with the already sha256-verified files from
// the Kokoro seed folder, owner-paths kokoroSeed (no network re-fetch; the download path itself is exercised separately
// in check-kokoro-download.mjs). Then for 20 realistic EN replies (mix of short and long), call speakStream and
// record wall-clock from call-start to the FIRST sentence's WAV arriving -- that is the "typed send -> first
// audible reply" latency surrogate (actual speaker-hardware playback start is sub-ms after that and not
// independently measurable from a headless Node process). p95 over the 20 samples is reported against the ≤3s gate.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { checkOutDir } from './lib/check-out-dir.mjs';
import { ownerPath } from './lib/owner-paths.mjs';

const require = createRequire(import.meta.url);
const { createKokoroTts } = require('../src/main/kokoro-tts.js');

const REPLIES = [
  "Got it.",
  "Done. The build is green.",
  "Sure, I can do that for you right now.",
  "Anh Kei, the deploy finished and staging looks fine.",
  "No open blockers right now. Everything on the board is on track.",
  "I found three tasks waiting on your review this afternoon.",
  "That file does not exist yet, so I created a draft for you to check.",
  "The test suite passed: forty two green, zero red, one skipped on purpose.",
  "I will queue that for the four o'clock check-in instead of interrupting you now.",
  "Here is a short summary of what changed since yesterday's report.",
  "The installer finished building and the size looks reasonable for a first pass.",
  "I noticed a possible issue with the login flow, so I flagged it rather than guessing.",
  "This should only take a minute. Let me pull the latest numbers for you.",
  "The owner approved the plan, so I am moving ahead with the next step now.",
  "There were two failing tests, both unrelated to the change we just made.",
  "I compared the two approaches and the simpler one covers everything we actually need.",
  "The database migration ran cleanly on staging with no locked rows reported.",
  "Let me know if you want the long version of this explanation or the short one.",
  "Three gestures played during the last test run, which matches what we expected to see.",
  "Everything is backed up, the branch is clean, and the next task is ready to start whenever you are.",
];

// `--out <dir>`: where kokoro-p1-acceptance.json goes. Default: a fresh per-run scratch dir (never a shared evidence
// folder -- BP-3); an explicit --out is used as given.
const arg = (name, def = null) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : def; };
const outDir = arg('out') || checkOutDir('check-kokoro-tts');

async function main() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zumi-kokoro-accept-'));
  // Pre-seed the cache with the files already downloaded + sha256-verified for this task (see P1-REPORT.md) so
  // this run measures inference latency, not network/download time.
  const seedSrc = ownerPath('kokoroSeed', 'local/kokoro');
  const dest = path.join(userDataDir, 'tts', 'kokoro', 'onnx-community', 'Kokoro-82M-v1.0-ONNX');
  fs.mkdirSync(path.join(dest, 'onnx'), { recursive: true });
  fs.copyFileSync(path.join(seedSrc, 'kokoro-v1.0-fp16.onnx'), path.join(dest, 'onnx', 'model_fp16.onnx'));
  for (const f of ['config.json', 'tokenizer.json', 'tokenizer_config.json']) fs.copyFileSync(path.join(seedSrc, f), path.join(dest, f));

  const tts = createKokoroTts({ userDataDir, log: () => {} });
  console.log(`available(): ${tts.available()}`);

  const warmT0 = Date.now();
  await tts.ensureReady(() => {});
  const warmMs = Date.now() - warmT0;
  console.log(`one-time model load: ${warmMs} ms (not counted against the per-reply p95 gate)`);

  const firstAudioMs = [];
  const sentenceCounts = [];
  for (let i = 0; i < REPLIES.length; i++) {
    const text = REPLIES[i];
    const turnId = crypto.randomBytes(16).toString('hex');
    const t0 = Date.now();
    let firstAt = null;
    let n = 0;
    await tts.speakStream(turnId, text, () => { if (firstAt === null) firstAt = Date.now(); n++; });
    const dt = firstAt - t0;
    firstAudioMs.push(dt);
    sentenceCounts.push(n);
    console.log(`[${i + 1}/20] first-audio=${dt}ms sentences=${n} chars=${text.length}`);
  }
  tts.dispose();

  const sorted = [...firstAudioMs].sort((a, b) => a - b);
  const p95 = sorted[Math.floor(0.95 * (sorted.length - 1))];
  const max = sorted[sorted.length - 1];
  const mean = firstAudioMs.reduce((a, b) => a + b, 0) / firstAudioMs.length;
  const pass = p95 <= 3000;

  const result = {
    method: 'real main-process Kokoro TTS (onnxruntime-node fp16, af_heart, device=cpu), plain Node harness, ' +
      'cache pre-seeded with already sha256-verified files (no network), one-time model load excluded from the ' +
      'per-reply timing, 20 realistic EN replies mixing short and long.',
    machine: os.cpus()[0] && os.cpus()[0].model,
    oneTimeModelLoadMs: warmMs,
    samples: firstAudioMs,
    sentenceCountsPerReply: sentenceCounts,
    p95Ms: p95,
    maxMs: max,
    meanMs: Math.round(mean),
    gateMs: 3000,
    pass,
  };
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'kokoro-p1-acceptance.json');
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2));
  console.log(`wrote ${outFile}`);
  console.log(`\np95 first-audio = ${p95} ms (gate ≤3000ms) -> ${pass ? 'PASS' : 'FAIL'}`);
  console.log(`mean=${Math.round(mean)}ms max=${max}ms`);
  fs.rmSync(userDataDir, { recursive: true, force: true });
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(2); });
