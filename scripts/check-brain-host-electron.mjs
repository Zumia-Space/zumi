// Brain's three read-only host calls in the REAL Electron app (T-31 slice 3a-3, GATE-SEC-3a-3 C4 / AC-B16, N2): scripts/electron-brain-host.cjs
// runs src/main/main.js of a SCRATCH copy of this tree built OFF and again built ON (never the tree's own build, never anh's profile).
//   OFF: window.zumi.board.state/media/openRef are undefined, raw ipcRenderer.invoke of the 3 channels rejects (no handler), the fixture
//        board sees no request, and ZUMI_NEXT_UI=1 in the app's environment changes nothing (the build artefact decides).
//   ON:  the same calls answer (positive control): the 11-key state, bad_id / unconfigured for media, not_on_board / opened / not_owner_build
//        for openRef, "forbidden" for any page that is not the main window, and Electron's own fetch sees a 302 as http_302 (N2).
// Fault proof (C13): each entry of FAULTS patches the scratch app's main.js / preload.js / board-reads.mjs with one defect, runs the same probe, and
// requires a non-zero exit AND a FAIL on the named assert. A fault anchor that is not found is an error (exit 2), never a pass.
// Starts electron.exe: render box only (scripts/lib/electron-guard.cjs), checked before anything is prepared or spawned; and never while another
// electron.exe is running.
//   node scripts/check-brain-host-electron.mjs [--no-faults] [--keep]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertElectronHost } from './lib/electron-guard.cjs';
import { ownerPath } from './lib/owner-paths.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const keep = args.includes('--keep');
assertElectronHost('check-brain-host-electron.mjs (electron scripts/electron-brain-host.cjs)');
const ELECTRON = process.env.ELECTRON_EXE || path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const BASE = `${ownerPath('scratchRoot', os.tmpdir())}/brain-host-electron-${process.pid}`; // never drive C on the owner's machines
const electronRunning = () => /electron\.exe/i.test(execFileSync('tasklist', ['/FI', 'IMAGENAME eq electron.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8' }));
if (electronRunning()) { console.error('REFUSED: an electron.exe is already running (another worker or the owner); not launching.'); process.exit(2); }
if (!fs.existsSync(ELECTRON)) { console.error(`ENV: ${ELECTRON} not found`); process.exit(2); }

const FAULTS = [
  { id: 'register-always', mode: 'off', expect: 'EP-1b', file: 'src/main/main.js', edits: [['if (NEXT_UI) {\n  const early', 'if (true) {\n  const early']] },
  { id: 'env-turns-it-on', mode: 'off', env: { ZUMI_NEXT_UI: '1' }, expect: 'EP-1', file: 'src/main/main.js', edits: [['const NEXT_UI = (() => {', "const NEXT_UI = process.env.ZUMI_NEXT_UI === '1' || (() => {"]] },
  { id: 'preload-keys-always', mode: 'off', expect: 'EP-1a', file: 'src/main/preload.js', edits: [['...(NEXT_UI ? {', '...(true ? {']] },
  { id: 'no-main-window-gate', mode: 'on', expect: 'EP-3a', file: 'src/main/main.js', edits: [["(e) => (fromAppPage(e) && boardReads ? boardReads.state()", '(e) => (boardReads ? boardReads.state()']] },
  { id: 'follow-redirects', mode: 'on', expect: 'EP-4', file: 'src/main/board-reads.mjs', edits: [["redirect: 'manual'", "redirect: 'follow'"]] },
];

const lines = [];
let bad = 0;
const say = (l) => { lines.push(l); console.log(l); };

function build(tag, nextUi) {
  const out = path.join(BASE, `build-${tag}`);
  fs.rmSync(out, { recursive: true, force: true });
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-renderer.mjs')], { cwd: ROOT, env: { ...process.env, ZUMI_NEXT_UI: nextUi ? '1' : '0', ZUMI_RENDERER_OUT: out }, stdio: 'pipe' });
  const flag = JSON.parse(fs.readFileSync(path.join(out, 'next-ui.json'), 'utf8')).nextUi;
  if (flag !== nextUi) throw new Error(`built ${tag}: next-ui.json says ${flag}`);
  return out;
}
/** A runnable copy of the app: package.json, src/main, assets, the vendored Laneboard, a renderer build, node_modules by junction. */
function makeApp(tag, rendererBuild, fault) {
  const dir = path.join(BASE, `app-${tag}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(dir, 'package.json'));
  fs.cpSync(path.join(ROOT, 'src', 'main'), path.join(dir, 'src', 'main'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'assets'), path.join(dir, 'assets'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'vendor', 'laneboard'), path.join(dir, 'vendor', 'laneboard'), { recursive: true });
  fs.cpSync(rendererBuild, path.join(dir, 'build', 'renderer'), { recursive: true });
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'junction');
  if (fault) {
    const file = path.join(dir, fault.file);
    let s = fs.readFileSync(file, 'utf8');
    for (const [from, to] of fault.edits) {
      const n = s.split(from).length - 1;
      if (n !== 1) { console.log(`ERROR fault ${fault.id}: anchor found ${n} times (need 1): ${from.slice(0, 70)}`); process.exit(2); }
      s = s.replace(from, () => to);
    }
    fs.writeFileSync(file, s);
  }
  return dir;
}
function probe(tag, appDir, mode, env = {}) {
  const out = path.join(BASE, `out-${tag}`), ud = path.join(BASE, `ud-${tag}`);
  if (electronRunning()) { console.error('REFUSED: an electron.exe appeared; stopping.'); process.exit(2); }
  const run = spawnSync(ELECTRON, [path.join(ROOT, 'scripts', 'electron-brain-host.cjs'), '--app', appDir, '--mode', mode, '--out', out, '--userdata', ud], { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 300000 });
  let result = null;
  try { result = JSON.parse(fs.readFileSync(path.join(out, 'result.json'), 'utf8')); } catch { /* no result: the run crashed */ }
  return { status: run.status, stdout: run.stdout || '', result };
}

try {
  fs.mkdirSync(BASE, { recursive: true });
  const builds = { off: build('off', false), on: build('on', true) };
  say(`built: OFF -> next-ui.json {"nextUi":false}, ON -> {"nextUi":true}`);

  // ---- real runs ----
  for (const [mode, env] of [['off', { ZUMI_NEXT_UI: '1' }], ['on', { ZUMI_NEXT_UI: '0' }]]) {
    const app = makeApp(mode, builds[mode]);
    const r = probe(mode, app, mode, env);
    for (const l of r.stdout.split('\n').filter((x) => /^(PASS|FAIL|ERROR) /.test(x))) say(`[${mode}] ${l}`);
    const fails = r.result ? r.result.checks.filter((c) => !c.ok).length : -1;
    const good = r.status === 0 && r.result && fails === 0 && r.result.checks.length >= (mode === 'off' ? 5 : 14);
    if (!good) bad++;
    say(`${good ? 'OK' : 'NOT OK'} ${mode.toUpperCase()} build: exit ${r.status}, ${r.result ? `${r.result.checks.length} checks, ${fails} failed` : 'no result.json'}, fixture board requests: ${r.result ? r.result.boardRequests.length : '?'}`);
  }

  // ---- fault proof ----
  if (!args.includes('--no-faults')) {
    let proved = 0;
    for (const f of FAULTS) {
      const app = makeApp(`fault-${f.id}`, builds[f.mode], f);
      const r = probe(`fault-${f.id}`, app, f.mode, f.env || {});
      const fails = r.result ? r.result.checks.filter((c) => !c.ok) : [];
      const hit = fails.some((c) => c.name.startsWith(f.expect));
      const good = r.status !== 0 && hit;
      if (good) proved++; else bad++;
      say(`${good ? 'PROVED' : 'NOT PROVED'} fault ${f.id} (${f.mode}): exit ${r.status}, expected ${f.expect}* ${hit ? 'among the failures' : 'MISSING'}`);
      for (const c of fails) say(`    > FAIL ${c.name.slice(0, 150)}`);
      fs.rmSync(app, { recursive: true, force: true });
    }
    say(`faults proved: ${proved}/${FAULTS.length}`);
  }
} finally {
  if (!keep) fs.rmSync(BASE, { recursive: true, force: true });
}
if (electronRunning()) { say('WARNING: an electron.exe is still running after the probe'); bad++; }
say(bad ? `\ncheck-brain-host-electron: FAILED (${bad})` : '\ncheck-brain-host-electron: all passed');
process.exit(bad ? 1 : 0);
