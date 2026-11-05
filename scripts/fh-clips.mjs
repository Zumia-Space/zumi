// T-31 float-holo: the 6 talk-framing comparison clips (3 candidate combos x cyan/amber) + one stitched 3x2 sheet.
// Runs ON THE RENDER BOX ONLY: it starts Electron (one window per clip) and ffmpeg (encode + stitch). `--dry-run`
// prints the plan and every command and starts nothing, so it is safe anywhere. Run steps: CLIPS-RUN.md in
// the owner's r6 sweep folder and scripts/box/fh-clips.ps1 (the box runner).
//   node scripts/fh-clips.mjs --out <dir> --model <file.vrm> [--electron <electron.exe>] [--ffmpeg <ffmpeg.exe>]
//     [--seconds 8] [--fps 30] [--size 1920x1080] [--only T1-cyan,T3-amber] [--force] [--keep-frames]
//     [--font C:/Windows/Fonts/consola.ttf] [--no-label] [--cell 960x540] [--dry-run]
// Per clip: <out>/<id>/ (frames, result.json, electron.log, label.txt) -> <out>/<id>.mp4 (H.264, label burned top-left).
// Then <out>/compare-3x2.mp4 (columns T1 T2 T3, rows cyan / amber) and <out>/clips.json (status, checks, arm stats).
// A clip whose harness checks FAIL (arms never reach the panel, mouth never moves, ...) is still encoded -- its frames
// are evidence -- but is marked CHECK-FAIL in clips.json and makes the run exit 1. Finished clips are skipped on a
// re-run (resume after a crash); --force redoes them.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { assertElectronHost } = require('./lib/electron-guard.cjs');
const CP = require('./lib/fh-clip-plan.cjs');

const argv = process.argv.slice(2);
const flag = (k) => argv.includes(k);
const opt = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const fwd = (p) => String(p).replace(/\\/g, '/');

const DRY = flag('--dry-run');
const OUT = opt('--out') && path.resolve(opt('--out'));
const MODEL = opt('--model');
const SECONDS = Number(opt('--seconds', 8));
const FPS = Number(opt('--fps', 30));
const SIZE = opt('--size', '1920x1080');
const CELL = /^(\d+)x(\d+)$/.exec(opt('--cell', '960x540'));
const FONT = opt('--font', 'C:/Windows/Fonts/consola.ttf');
const ONLY = opt('--only') ? opt('--only').split(',') : null;
const HARNESS = path.join(ROOT, 'scripts', 'electron-float-holo.cjs');
const ELECTRON = opt('--electron', path.join(ROOT, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron'));

function fail(msg) { console.error(`ERROR ${msg}`); process.exit(2); }
if (!OUT) fail('--out <dir> is required');
if (!MODEL) fail('--model <file.vrm> is required');
if (!(SECONDS >= 6 && SECONDS <= 12)) fail('--seconds must be 6..12 (the brief: a 6-8 s clip)');
if (!(FPS >= 12 && FPS <= 60)) fail('--fps must be 12..60');
if (!/^\d{3,5}x\d{3,5}$/.test(SIZE)) fail('--size must be <width>x<height>');
if (!CELL) fail('--cell must be <width>x<height>');

const matrix = CP.clipMatrix();
if (ONLY) { const bad = ONLY.filter((id) => !matrix.some((m) => m.id === id)); if (bad.length) fail(`--only: unknown clip id ${bad.join(',')} (known: ${matrix.map((m) => m.id).join(', ')})`); }
const selected = matrix.filter((m) => !ONLY || ONLY.includes(m.id));

function findFfmpeg() {
  const given = opt('--ffmpeg');
  if (given) return given;
  const w = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg'], { encoding: 'utf8' });
  return w.status === 0 ? w.stdout.split(/\r?\n/)[0].trim() : null;
}

const harnessArgs = (entry, dir) => [HARNESS, '--app', ROOT, '--out', dir, '--userdata', path.join(dir, 'ud'), '--model', MODEL,
  '--clip-seconds', String(SECONDS), '--fps', String(FPS), '--size', SIZE, '--framing', 'wide'];
const harnessEnv = (entry) => ({ FH_TALK_CLIP: '1', FH_COLOUR: entry.colour, FH_PARAMS: JSON.stringify(entry.params), ZUMI_ELECTRON_HOST: 'box' });
const mp4Of = (entry) => path.join(OUT, `${entry.id}.mp4`);

if (DRY) {
  console.log(`DRY RUN: nothing is started. ${selected.length} clip(s) x ${SECONDS}s at ${FPS} fps, window ${SIZE}, out ${OUT}`);
  for (const e of selected) {
    const dir = path.join(OUT, e.id);
    console.log(`\n[${e.id}] ${e.label}`);
    console.log(`  env  ${Object.entries(harnessEnv(e)).map(([k, v]) => `${k}=${v}`).join(' ')}`);
    console.log(`  run  ${ELECTRON} ${harnessArgs(e, dir).join(' ')}`);
    console.log(`  enc  ffmpeg ${CP.ffmpegClipArgs({ framesDir: fwd(path.join(dir, 'frames')), fps: FPS, out: fwd(mp4Of(e)), labelFile: fwd(path.join(dir, 'label.txt')), font: FONT }).join(' ')}`);
  }
  console.log(`\n[compare-3x2] ffmpeg ${CP.ffmpegGridArgs({ clips: matrix.map((m) => fwd(mp4Of(m))), out: fwd(path.join(OUT, 'compare-3x2.mp4')), cellW: Number(CELL[1]), cellH: Number(CELL[2]), fps: FPS }).join(' ')}`);
  process.exit(0);
}

assertElectronHost('fh-clips.mjs (Electron + ffmpeg, render box only)');
if (!fs.existsSync(ELECTRON)) fail(`Electron not found at ${ELECTRON} (--electron)`);
if (!fs.existsSync(MODEL)) fail(`model not found: ${MODEL}`);
const FFMPEG = findFfmpeg();
if (!FFMPEG) fail('ffmpeg not found on PATH (--ffmpeg <ffmpeg.exe>)');
fs.mkdirSync(OUT, { recursive: true });

const manifestFile = path.join(OUT, 'clips.json');
const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : { clips: {} };
const save = () => fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 1));
const ffmpeg = (args, logFile) => {
  const r = spawnSync(FFMPEG, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  fs.writeFileSync(logFile, `${FFMPEG} ${args.join(' ')}\n\n${r.stdout || ''}\n${r.stderr || ''}`);
  return r.status;
};

let bad = 0;
for (const e of selected) {
  const dir = path.join(OUT, e.id);
  const prev = manifest.clips[e.id];
  if (!flag('--force') && prev && prev.status !== 'FAILED' && fs.existsSync(mp4Of(e))) { console.log(`[${e.id}] already done (${prev.status}); --force to redo`); if (prev.status !== 'OK') bad++; continue; }
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'frames'), { recursive: true });
  console.log(`[${e.id}] recording ${e.label}`);
  const t0 = Date.now();
  const run = spawnSync(ELECTRON, harnessArgs(e, dir), { env: { ...process.env, ...harnessEnv(e) }, encoding: 'utf8', timeout: 30 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 });
  fs.writeFileSync(path.join(dir, 'electron.log'), `${run.stdout || ''}\n--- stderr ---\n${run.stderr || ''}`);
  const rec = { label: e.label, params: e.params, colour: e.colour, electronExit: run.status, seconds: SECONDS, fps: FPS, tookS: Math.round((Date.now() - t0) / 1000) };
  let result = null;
  try { result = JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8')); } catch { /* the harness died before writing it */ }
  const frames = fs.readdirSync(path.join(dir, 'frames')).filter((f) => /^f_\d{4}\.png$/.test(f)).length;
  rec.frames = frames;
  if (result) {
    rec.failedChecks = result.checks.filter((c) => !c.ok).map((c) => c.name);
    rec.size = result.clip && result.clip.size;
    rec.arms = result.clip && result.clip.arms;
    rec.errors = result.errors;
  }
  if (run.status === 2 || frames !== Math.round(SECONDS * FPS)) {
    rec.status = 'FAILED';
    rec.reason = run.status === 2 ? 'harness error (exit 2); see electron.log' : `expected ${Math.round(SECONDS * FPS)} frames, found ${frames}`;
  } else {
    fs.writeFileSync(path.join(dir, 'label.txt'), e.label);
    const enc = CP.ffmpegClipArgs({ framesDir: fwd(path.join(dir, 'frames')), fps: FPS, out: fwd(mp4Of(e)), labelFile: flag('--no-label') ? null : fwd(path.join(dir, 'label.txt')), font: FONT });
    const code = ffmpeg(enc, path.join(dir, 'ffmpeg.log'));
    rec.encodeExit = code;
    rec.mp4 = mp4Of(e);
    rec.status = code !== 0 ? 'FAILED' : run.status === 0 ? 'OK' : 'CHECK-FAIL';
    if (code !== 0) rec.reason = 'ffmpeg encode failed; see ffmpeg.log (a drawtext/font error: pass --font <ttf> or --no-label)';
    if (code === 0 && !flag('--keep-frames')) fs.rmSync(path.join(dir, 'frames'), { recursive: true, force: true });
  }
  fs.rmSync(path.join(dir, 'ud'), { recursive: true, force: true });
  manifest.clips[e.id] = rec;
  save();
  console.log(`[${e.id}] ${rec.status}${rec.reason ? ` - ${rec.reason}` : ''}${rec.failedChecks && rec.failedChecks.length ? ` - failed: ${rec.failedChecks.join(' | ')}` : ''}`);
  if (rec.status !== 'OK') bad++;
}

// the stitched sheet needs all six
if (matrix.every((m) => fs.existsSync(mp4Of(m)))) {
  const grid = path.join(OUT, 'compare-3x2.mp4');
  const code = ffmpeg(CP.ffmpegGridArgs({ clips: matrix.map((m) => fwd(mp4Of(m))), out: fwd(grid), cellW: Number(CELL[1]), cellH: Number(CELL[2]), fps: FPS }), path.join(OUT, 'compare.ffmpeg.log'));
  manifest.compare = { file: grid, encodeExit: code, layout: 'columns T1 T2 T3, rows cyan / amber', cell: `${CELL[1]}x${CELL[2]}` };
  console.log(`[compare-3x2] ${code === 0 ? 'OK' : `FAILED (see compare.ffmpeg.log)`}`);
  if (code !== 0) bad++;
} else {
  console.log('[compare-3x2] skipped: not all 6 clips exist yet');
}
save();
console.log(`\n${selected.length} clip(s) processed, ${bad} not OK. Manifest: ${manifestFile}`);
process.exit(bad ? 1 : 0);
