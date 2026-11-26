// Room live B (ADR D7): mutation proofs for the real-guest tests N1 N2 N3 N4 N7 (scripts/check-stage-guest.mjs).
//   node scripts/check-stage-guest-mutations.mjs --work <dir> --payload <dir of a built app payload> --vrm <default.vrm> [--out <log dir>] [--target <cargo target dir>] [--only ID,ID]
// For each mutation: apply the weakening to a TEMPORARY COPY of the tree, build the app exe from it, run the real-guest harness with that exe
// (the named tests must fail), restore the files (sha256 against the pristine copy), put the pristine exe back and run the harness again
// (the named tests must pass). The payload is copied into --work; the repo tree is never touched. HEAVY lock needed (cargo, WebView2, GPU).
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const work = opt('work'), payloadSrc = opt('payload'), vrm = opt('vrm');
if (!work || !payloadSrc || !vrm) { console.error('usage: check-stage-guest-mutations.mjs --work <dir> --payload <dir> --vrm <default.vrm> [--out <dir>] [--target <dir>] [--only ID,ID]'); process.exit(2); }
const out = opt('out') || path.join(work, 'logs');
const target = opt('target') || path.join(work, 'target');
const only = opt('only') ? new Set(opt('only').split(',')) : null;

const PH = 'tauri/src-tauri/src/pack_host.rs';
const GG = 'tauri/src-tauri/src/guest_guard.rs';
const GU = 'tauri/src-tauri/src/guest.rs';
const CAP = 'tauri/src-tauri/capabilities/default.json';
const MUTATIONS = [
  { id: 'G-N1-N7', rows: ['N1', 'N7'], tests: ['N1', 'N7'], edits: [
    { file: PH, find: "connect-src 'self' data: blob:;", replace: 'connect-src *;' },
    { file: GG, find: 'let source_kinds = install_request_filter(&core, &environment, blocks, None, "guest_guard")?;', replace: 'let _ = blocks;\n    let source_kinds = "all";' }] },
  { id: 'G-N2', rows: ['N2'], tests: ['N2'], edits: [{ file: PH, find: "connect-src 'self' data: blob:;", replace: 'connect-src *;' }] },
  { id: 'G-N3-img', rows: ['N3 image beacon'], tests: ['N3'], edits: [{ file: PH, find: "img-src 'self' data: blob:;", replace: 'img-src *;' }] },
  { id: 'G-N3-window', rows: ['N3 window.open'], tests: ['N3'], edits: [{ file: GU, find: 'NewWindowResponse::<tauri::Wry>::Deny', replace: 'NewWindowResponse::<tauri::Wry>::Allow' }] },
  { id: 'G-N3-nav', rows: ['N3 top navigation'], tests: ['N3'], edits: [{ file: GU, find: 'NavAction::Cancel => false,', replace: 'NavAction::Cancel => true,' }] },
  { id: 'G-N4', rows: ['N4'], tests: ['N4'], edits: [{ file: CAP, find: '"webviews": ["main"],', replace: '"webviews": ["main", "guest-pack-*"],' }] },
];

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const COPY = ['tauri', 'docs/decisions/room-live-b', 'assets/rooms-video', 'package.json', 'src/main/owner-values.json']; // build.rs reads the last two
const copyTree = (dest) => {
  fs.rmSync(dest, { recursive: true, force: true });
  for (const rel of COPY) fs.cpSync(path.join(repo, rel), path.join(dest, rel), { recursive: true, filter: (src) => !/[\\/](target|node_modules)([\\/]|$)/.test(src) });
};
function applyEdit(root, e) {
  const file = path.join(root, e.file);
  let text = fs.readFileSync(file, 'utf8');
  const crlf = text.includes('\r\n');
  const find = crlf ? e.find.replace(/\n/g, '\r\n') : e.find;
  const replace = crlf ? e.replace.replace(/\n/g, '\r\n') : e.replace;
  const n = text.split(find).length - 1;
  if (n !== 1) throw new Error(`${e.file}: anchor found ${n} times: ${e.find.slice(0, 80)}`);
  fs.writeFileSync(file, text.split(find).join(replace));
}
const build = (root) => spawnSync('cargo', ['build', '--bin', 'zumi-preview', '--features', 'tauri/custom-protocol'], { cwd: path.join(root, 'tauri', 'src-tauri'), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: { ...process.env, CARGO_TARGET_DIR: target } });
const exeOut = () => path.join(target, 'debug', 'zumi-preview.exe');

fs.mkdirSync(out, { recursive: true });
const pristine = path.join(work, 'pristine');
const mut = path.join(work, 'mut');
copyTree(pristine);
copyTree(mut);
for (const m of MUTATIONS) { // every anchor applies exactly once, before anything is built
  const probe = path.join(work, 'probe');
  fs.rmSync(probe, { recursive: true, force: true });
  for (const f of new Set(m.edits.map((e) => e.file))) { fs.mkdirSync(path.dirname(path.join(probe, f)), { recursive: true }); fs.copyFileSync(path.join(pristine, f), path.join(probe, f)); }
  for (const e of m.edits) applyEdit(probe, e);
}
console.log(`anchors ok for ${MUTATIONS.length} mutations`);

const payload = path.join(work, 'payload');
fs.rmSync(payload, { recursive: true, force: true });
fs.cpSync(payloadSrc, payload, { recursive: true });
const pristineExe = path.join(work, 'zumi-preview-pristine.exe');
const b0 = build(pristine);
fs.writeFileSync(path.join(out, 'build-pristine.log'), `${b0.stdout}\n${b0.stderr}`);
if (b0.status !== 0) { console.error('the pristine copy does not build'); process.exit(1); }
fs.copyFileSync(exeOut(), pristineExe);

function harness(tests, label) {
  const json = path.join(out, `${label}.json`);
  const r = spawnSync('node', [path.join(repo, 'scripts', 'check-stage-guest.mjs'), '--app', payload, '--work', path.join(work, 'run'), '--vrm', vrm, '--only', tests.join(','), '--out', json], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  fs.writeFileSync(path.join(out, `${label}.log`), `${r.stdout}\n${r.stderr}`);
  let results = {};
  try { results = JSON.parse(fs.readFileSync(json, 'utf8')).results; } catch { /* no result file: a harness failure */ }
  return { status: r.status, results };
}

fs.copyFileSync(pristineExe, path.join(payload, 'ZumiPreview.exe'));
const base = harness(['N1', 'N2', 'N3', 'N4', 'N7'], 'pristine-all');
console.log(`pristine, all five: ${base.status === 0 ? 'green' : 'RED'}`);
if (base.status !== 0) process.exit(1);

const results = [];
for (const m of MUTATIONS) {
  if (only && !only.has(m.id)) continue;
  const files = [...new Set(m.edits.map((e) => e.file))];
  for (const f of files) fs.copyFileSync(path.join(pristine, f), path.join(mut, f));
  for (const e of m.edits) applyEdit(mut, e);
  const b = build(mut);
  fs.writeFileSync(path.join(out, `${m.id}.build.log`), `${b.stdout}\n${b.stderr}`);
  let red = { status: -1, results: {} };
  if (b.status === 0) {
    fs.copyFileSync(exeOut(), path.join(payload, 'ZumiPreview.exe'));
    red = harness(m.tests, `${m.id}.red`);
  }
  for (const f of files) fs.copyFileSync(path.join(pristine, f), path.join(mut, f));
  const restored = files.every((f) => sha(fs.readFileSync(path.join(mut, f))) === sha(fs.readFileSync(path.join(pristine, f))));
  fs.copyFileSync(pristineExe, path.join(payload, 'ZumiPreview.exe'));
  const green = harness(m.tests, `${m.id}.green`);
  const mutationRed = b.status === 0 && red.status !== 0 && m.tests.every((t) => red.results[t] && red.results[t].pass === false && !red.results[t].harnessError);
  const row = { id: m.id, rows: m.rows, tests: m.tests, built: b.status === 0, mutationRed, restoredHashEqual: restored, restoredGreen: green.status === 0 };
  results.push(row);
  console.log(`${mutationRed && restored && green.status === 0 ? 'OK  ' : 'FAIL'} ${m.id} [${m.rows.join(', ')}] red=${mutationRed} restored=${restored} green=${green.status === 0}`);
}
fs.writeFileSync(path.join(out, 'guest-mutation-results.json'), JSON.stringify(results, null, 1));
const bad = results.filter((r) => !(r.mutationRed && r.restoredHashEqual && r.restoredGreen));
console.log(`${results.length - bad.length}/${results.length} guest mutations proven`);
process.exit(bad.length ? 1 : 0);
