// render-fillers (T-31-YOKI step 4.1, plan B3): render filler CANDIDATES (hum, oh, mm, laugh) with the pinned local
// Kokoro af_heart voice, trim them tight, set their level about 4 dB under speech, QC them numerically and write
// WAVs + manifest.json. Local, free, no network: the model files are checked against the same sha256 pins as
// src/main/kokoro-worker.mjs and nothing is ever downloaded (remote models are switched off).
//
//   node scripts/render-fillers.mjs [--modules <voice-modules dir>] [--cache <kokoro cache dir>] [--out <dir>]
//
// --modules  a node_modules parent holding kokoro-js, @huggingface/transformers, phonemizer (the packaged layout)
// --cache    the Kokoro cache the app uses: <cache>/onnx-community/Kokoro-82M-v1.0-ONNX/{onnx/model_fp16.onnx,...}
// --out      default assets/voice-fillers/kokoro-af_heart/candidates
// No machine path is built in (public source): pass --modules/--cache, or set ZUMI_VOICE_MODULES_DIR / ZUMI_KOKORO_CACHE_DIR.
// Low CPU: onnxruntime capped at 2 intra-op threads, 1 inter-op, BelowNormal priority. Clips are listening candidates
// (step 4.2 owner audition), not shipped assets.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def; };
const modulesArg = arg('modules', process.env.ZUMI_VOICE_MODULES_DIR);
const cacheArg = arg('cache', process.env.ZUMI_KOKORO_CACHE_DIR);
if (!modulesArg || !cacheArg) {
  console.error('render-fillers: give --modules <voice-modules dir> and --cache <kokoro cache dir> (or ZUMI_VOICE_MODULES_DIR / ZUMI_KOKORO_CACHE_DIR)');
  process.exit(2);
}
const modulesDir = path.resolve(modulesArg);
const cacheDir = path.resolve(cacheArg);
const outDir = path.resolve(arg('out', path.join(ROOT, 'assets', 'voice-fillers', 'kokoro-af_heart', 'candidates')));

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const VOICE = 'af_heart';
// Same pins as src/main/kokoro-worker.mjs (copied: that file is a worker entry and cannot be imported).
const PINNED = {
  'onnx/model_fp16.onnx': 'ba4527a874b42b21e35f468c10d326fdff3c7fc8cac1f85e9eb6c0dfc35c334a',
  'config.json': 'df34b4f930b23447cd4dc410fabfb42eb3f24e803e6c3f97d618fb359380a36f',
  'tokenizer.json': '77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34',
  'tokenizer_config.json': 'be1cb066d6ef6b074b3f15e6a6dd21ac88ff3cdaedf325f0aaed686c70f75d20',
};
const PINNED_VOICE = 'd583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b';

const SR = 24000;
const TARGET_DB_UNDER_SPEECH = 4;
const MIN_MS = 300, MAX_MS = 600;
const PEAK_LIMIT_DBFS = -0.5;
const EDGE_SILENCE_MAX_MS = 40;
const QC_FRAME = Math.round(SR * 0.0025);       // 2.5 ms
const QC_FLOOR_DBFS = -45;                      // a frame under this counts as silence in the QC
// What to try per kind: [text, speed]. Several takes each; the best distinct ones that pass QC are kept (3 per kind).
const KINDS = {
  hum:   { mouthScale: 0.15, takes: [['Hmm.', 1.0], ['Hmm.', 1.3], ['Hmmm.', 1.4], ['Hm.', 1.0], ['Mhm.', 1.2], ['Mm-hmm.', 1.5], ['Hmm, hmm.', 1.6]] },
  oh:    { mouthScale: 1.0,  takes: [['Oh.', 1.0], ['Oh!', 1.0], ['Oh?', 1.1], ['Ohh.', 1.2], ['Oh.', 1.3], ['Oh!', 1.3], ['Ooh.', 1.3], ['Oh?', 1.3]] },
  mm:    { mouthScale: 0.15, takes: [['Mm.', 1.0], ['Mmm.', 1.2], ['Mm.', 1.3], ['Mm-mm.', 1.5], ['Mmm.', 1.5]] },
  laugh: { mouthScale: 1.0,  takes: [['Haha.', 1.0], ['Ha ha.', 1.3], ['Hehe.', 1.2], ['Heh heh.', 1.5], ['Ha ha ha.', 1.8], ['Haha!', 1.5]] },
};
const SPEECH_REF = ['Okay, let me think about that for a moment.', 'That sounds good, I will take a look at it now.', 'Sure, here is what I found for you.'];

// ---------- signal helpers (Float32Array, mono, 24 kHz) ----------
const db = (x) => 20 * Math.log10(Math.max(x, 1e-9));
const peakOf = (a) => { let p = 0; for (const v of a) { const x = Math.abs(v); if (x > p) p = x; } return p; };
const rmsOf = (a) => { if (!a.length) return 0; let s = 0; for (const v of a) s += v * v; return Math.sqrt(s / a.length); };
function frameRms(a, frame) { const out = []; for (let i = 0; i + frame <= a.length; i += frame) out.push(rmsOf(a.subarray(i, i + frame))); return out; }
/** Samples in frames whose RMS is within `rangeDb` of the loudest frame: the "active" part, used for level and trim. */
function activeSpan(a, rangeDb) {
  const fr = frameRms(a, QC_FRAME);
  const top = Math.max(...fr);
  const thr = top * 10 ** (-rangeDb / 20);
  const first = fr.findIndex((v) => v >= thr);
  let last = fr.length - 1; while (last > 0 && fr[last] < thr) last--;
  return first < 0 ? null : { start: first * QC_FRAME, end: (last + 1) * QC_FRAME, thr };
}
function activeRms(a, rangeDb = 30) { // RMS over active frames only (speech level excludes pauses)
  const fr = frameRms(a, QC_FRAME); const top = Math.max(...fr); const thr = top * 10 ** (-rangeDb / 20);
  const act = fr.filter((v) => v >= thr); return Math.sqrt(act.reduce((s, v) => s + v * v, 0) / act.length);
}
function trimTight(a) {
  const span = activeSpan(a, 35); if (!span) return null;
  const pre = Math.round(SR * 0.005), post = Math.round(SR * 0.012);
  const out = Float32Array.from(a.subarray(Math.max(0, span.start - pre), Math.min(a.length, span.end + post)));
  const fin = Math.min(out.length, Math.round(SR * 0.004)), fout = Math.min(out.length, Math.round(SR * 0.02));
  for (let i = 0; i < fin; i++) out[i] *= i / fin;
  for (let i = 0; i < fout; i++) out[out.length - 1 - i] *= i / fout;
  return out;
}
/** After the gain: cut frames under the QC floor from both ends (keep 5 ms), so the clip is tight by the same rule the QC measures. */
function trimToFloor(a) {
  const fr = frameRms(a, QC_FRAME); const floor = 10 ** (QC_FLOOR_DBFS / 20);
  const first = fr.findIndex((v) => v >= floor);
  let last = fr.length - 1; while (last >= 0 && fr[last] < floor) last--;
  if (first < 0) return a;
  const keep = Math.round(SR * 0.005);
  const out = Float32Array.from(a.subarray(Math.max(0, first * QC_FRAME - keep), Math.min(a.length, (last + 1) * QC_FRAME + keep)));
  const fout = Math.min(out.length, Math.round(SR * 0.012));
  for (let i = 0; i < fout; i++) out[out.length - 1 - i] *= i / fout;
  return out;
}
/** Leading / trailing silence in ms by the QC rule: frames under QC_FLOOR_DBFS. */
function edgeSilence(a) {
  const fr = frameRms(a, QC_FRAME); const floor = 10 ** (QC_FLOOR_DBFS / 20);
  const first = fr.findIndex((v) => v >= floor);
  let last = fr.length - 1; while (last >= 0 && fr[last] < floor) last--;
  if (first < 0) return { leadMs: Infinity, trailMs: Infinity };
  return { leadMs: +(first * QC_FRAME / SR * 1000).toFixed(1), trailMs: +((fr.length - 1 - last) * QC_FRAME / SR * 1000).toFixed(1) };
}
/**
 * Does it sound like a laugh? Numeric stand-in for a listen: at least 2 separate energy bursts (10 ms envelope with a
 * dip of 6 dB or more between them), burst spacing 70-250 ms, and a breathy, bright spectrum (centroid over 900 Hz).
 */
function laughTest(a) {
  const fr = frameRms(a, Math.round(SR * 0.01)).map((v) => db(v));
  const top = Math.max(...fr);
  const peaks = [];
  for (let i = 1; i < fr.length - 1; i++) if (fr[i] >= fr[i - 1] && fr[i] > fr[i + 1] && fr[i] > top - 18) peaks.push(i);
  const bursts = [];
  for (const p of peaks) {
    const prev = bursts[bursts.length - 1];
    if (!prev) { bursts.push(p); continue; }
    const dip = Math.min(...fr.slice(prev, p + 1));
    if (Math.min(fr[prev], fr[p]) - dip >= 6) bursts.push(p); else if (fr[p] > fr[prev]) bursts[bursts.length - 1] = p;
  }
  const gaps = bursts.slice(1).map((p, i) => (p - bursts[i]) * 10);
  // centroid over the active part via a plain DFT on 512-sample windows (cheap at this length)
  const N = 512; let num = 0, den = 0;
  for (let s = 0; s + N <= a.length; s += N) {
    for (let k = 1; k < N / 2; k += 2) {
      let re = 0, im = 0; for (let n = 0; n < N; n++) { const ang = 2 * Math.PI * k * n / N; re += a[s + n] * Math.cos(ang); im += -a[s + n] * Math.sin(ang); }
      const mag = Math.hypot(re, im); num += mag * (k * SR / N); den += mag;
    }
  }
  const centroid = den ? num / den : 0;
  const pass = bursts.length >= 2 && gaps.every((g) => g >= 70 && g <= 250) && centroid > 900;
  return { pass, bursts: bursts.length, gapsMs: gaps, centroidHz: Math.round(centroid) };
}
function wavBuffer(a) {
  const buf = Buffer.alloc(44 + a.length * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + a.length * 2, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(a.length * 2, 40);
  for (let i = 0; i < a.length; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, a[i])) * 32767), 44 + i * 2);
  return buf;
}
const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

// ---------- main ----------
try { os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* not allowed here: carry on, threads are capped anyway */ }

const modelRoot = path.join(cacheDir, MODEL_ID);
for (const [rel, want] of Object.entries(PINNED)) {
  const p = path.join(modelRoot, rel);
  if (!fs.existsSync(p)) { console.error(`render-fillers: missing ${p} (this script never downloads)`); process.exit(2); }
  if (sha256(p) !== want) { console.error(`render-fillers: sha256 mismatch for ${rel}`); process.exit(2); }
}
const voicePath = path.join(modulesDir, 'node_modules', 'kokoro-js', 'voices', `${VOICE}.bin`);
if (!fs.existsSync(voicePath) || sha256(voicePath) !== PINNED_VOICE) { console.error('render-fillers: voice pack missing or sha256 mismatch'); process.exit(2); }

const imp = (...parts) => import(pathToFileURL(path.join(modulesDir, 'node_modules', ...parts)).href);
const { KokoroTTS } = await imp('kokoro-js', 'dist', 'kokoro.js');
const { env, StyleTextToSpeech2Model, AutoTokenizer } = await imp('@huggingface', 'transformers', 'dist', 'transformers.node.mjs');
env.cacheDir = cacheDir;
env.allowRemoteModels = false;
const session_options = { intraOpNumThreads: 2, interOpNumThreads: 1 }; // thread cap 2 (brief); kokoro-js itself exposes no option
const model = await StyleTextToSpeech2Model.from_pretrained(MODEL_ID, { dtype: 'fp16', device: 'cpu', session_options });
const tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID);
const tts = new KokoroTTS(model, tokenizer);
const synth = async (text, speed) => Float32Array.from((await tts.generate(text, { voice: VOICE, speed })).audio);

// speech level: RMS of the active frames over the reference sentences (what a normal reply sounds like)
const refs = [];
for (const t of SPEECH_REF) refs.push(await synth(t, 1.0));
const speechRms = rmsOf(Float32Array.from(refs.flatMap((r) => { const s = activeSpan(r, 30); return [...r.subarray(s.start, s.end)]; })));
const speechDb = db(speechRms);
const targetDb = speechDb - TARGET_DB_UNDER_SPEECH;
console.log(`speech reference: active RMS ${speechDb.toFixed(1)} dBFS, filler target ${targetDb.toFixed(1)} dBFS RMS (${TARGET_DB_UNDER_SPEECH} dB under)`);

const rows = []; // every take with its QC outcome
for (const [kind, def] of Object.entries(KINDS)) {
  for (const [text, speed] of def.takes) {
    const raw = await synth(text, speed);
    const clip = trimTight(raw);
    const row = { kind, text, speed, ok: false, why: [] };
    rows.push(row);
    if (!clip) { row.why.push('silent'); continue; }
    // level: active-part RMS to the target; if that would clip, stop at the peak limit and say so
    const gain = 10 ** ((targetDb - db(activeRms(clip, 30))) / 20);
    let g = gain; const peakAtGain = peakOf(clip) * gain;
    if (db(peakAtGain) > PEAK_LIMIT_DBFS - 0.5) { g = 10 ** ((PEAK_LIMIT_DBFS - 0.5) / 20) / peakOf(clip); row.why.push('level-limited-by-peak'); }
    const out = trimToFloor(Float32Array.from(clip, (v) => v * g));
    const ms = out.length / SR * 1000;
    const edges = edgeSilence(out);
    Object.assign(row, { out, durationMs: Math.round(ms), peakDbfs: +db(peakOf(out)).toFixed(2), rmsDbfs: +db(activeRms(out, 30)).toFixed(2), wholeRmsDbfs: +db(rmsOf(out)).toFixed(2), ...edges });
    if (ms < MIN_MS || ms > MAX_MS) row.why.push(`duration ${Math.round(ms)} ms outside ${MIN_MS}-${MAX_MS}`);
    if (row.peakDbfs >= PEAK_LIMIT_DBFS) row.why.push('clipping');
    if (edges.leadMs > EDGE_SILENCE_MAX_MS || edges.trailMs > EDGE_SILENCE_MAX_MS) row.why.push('edge silence over 40 ms');
    if (kind === 'laugh') { row.laugh = laughTest(out); if (!row.laugh.pass) row.why.push('does not read as a laugh (bursts/spacing/brightness)'); }
    row.ok = row.why.filter((w) => w !== 'level-limited-by-peak').length === 0;
  }
}

// pick 3 per kind: passing takes, distinct (text, speed), in the order tried
const kept = [], dropped = [];
for (const kind of Object.keys(KINDS)) {
  const good = rows.filter((r) => r.kind === kind && r.ok);
  good.slice(0, 3).forEach((r, i) => { r.file = `${kind}-${i + 1}.wav`; kept.push(r); });
  if (good.length < 3) dropped.push({ kind, kept: Math.min(3, good.length), reason: good.length ? `only ${good.length} take(s) passed QC` : 'no take passed QC', tried: rows.filter((r) => r.kind === kind).map((r) => ({ text: r.text, speed: r.speed, why: r.why })) });
}

fs.mkdirSync(outDir, { recursive: true });
for (const r of kept) fs.writeFileSync(path.join(outDir, r.file), wavBuffer(r.out));
const manifest = {
  _note: 'Filler CANDIDATES for the owner audition (T-31-YOKI step 4.1). Rendered by scripts/render-fillers.mjs with the sha-pinned local Kokoro af_heart; level 4 dB under the reference speech RMS; not shipped until step 4.2 picks.',
  voice: VOICE, model: MODEL_ID, dtype: 'fp16', sampleRate: SR, channels: 1,
  pins: { ...PINNED, [`voices/${VOICE}.bin`]: PINNED_VOICE },
  speechReferenceRmsDbfs: +speechDb.toFixed(2), targetRmsDbfs: +targetDb.toFixed(2),
  clips: kept.map((r) => ({
    file: r.file, kind: r.kind, text: r.text, speed: r.speed, durationMs: r.durationMs, peakDbfs: r.peakDbfs, rmsDbfs: r.rmsDbfs,
    leadSilenceMs: r.leadMs, trailSilenceMs: r.trailMs, mouthScale: KINDS[r.kind].mouthScale, mouthScaleNote: 'guess by kind (plan B3); tune at the audition',
    ...(r.laugh ? { laughTest: r.laugh } : {}), ...(r.why.length ? { notes: r.why } : {}),
  })),
  dropped,
};
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

// QC table (every take tried, so a rejected one is visible)
console.log('\n| file | kind | text | speed | ms | peak dBFS | RMS dBFS | lead ms | trail ms | mouthScale | QC |\n|---|---|---|---|---|---|---|---|---|---|---|');
for (const r of rows) console.log(`| ${r.file || '(not kept)'} | ${r.kind} | ${r.text} | ${r.speed} | ${r.durationMs ?? '-'} | ${r.peakDbfs ?? '-'} | ${r.rmsDbfs ?? '-'} | ${r.leadMs ?? '-'} | ${r.trailMs ?? '-'} | ${KINDS[r.kind].mouthScale} | ${r.ok ? 'pass' : 'FAIL: ' + r.why.join('; ')}${r.ok && r.why.length ? ' (' + r.why.join('; ') + ')' : ''} |`);
for (const r of rows.filter((x) => x.laugh)) console.log(`laugh take "${r.text}" x${r.speed}: ${JSON.stringify(r.laugh)}`);
for (const d of dropped) console.log(`DROPPED/SHORT ${d.kind}: ${d.reason}`);
console.log(`\nkept ${kept.length} clips -> ${outDir}`);
const bad = kept.filter((r) => !r.ok);
process.exit(bad.length ? 1 : 0);
