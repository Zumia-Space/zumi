// scripts/lib/electron-guard.cjs: Electron / Zumi.exe start only on the render box (ZUMI_ELECTRON_HOST=box). Plain Node;
// this check never starts Electron and never runs a guarded script (a broken guard must not be able to open a window
// here): the guard itself is exercised directly, the builder afterPack hook is called with no box env (it must skip
// loudly), and every Electron starter in scripts/ is checked statically to call the guard before it spawns.
//   node scripts/check-electron-guard.mjs   (npm run check:electron-guard)
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const guard = require('./lib/electron-guard.cjs');
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`); };
const throws = (fn) => { try { fn(); return null; } catch (e) { return e; } };

// ---------- 1. the guard ----------
check('the env var is ZUMI_ELECTRON_HOST and the box value is "box"', guard.ELECTRON_HOST_ENV === 'ZUMI_ELECTRON_HOST' && guard.ELECTRON_HOST_VALUE === 'box');
for (const [name, env] of [['no env var', {}], ['empty', { ZUMI_ELECTRON_HOST: '' }], ['"BOX" (case matters)', { ZUMI_ELECTRON_HOST: 'BOX' }], ['"1"', { ZUMI_ELECTRON_HOST: '1' }], ['"main"', { ZUMI_ELECTRON_HOST: 'main' }], ['" box"', { ZUMI_ELECTRON_HOST: ' box' }]]) {
  const e = throws(() => guard.assertElectronHost('the test step', env));
  check(`assertElectronHost throws with ${name}`, e && e.code === 'ELECTRON_HOST_REQUIRED' && /REFUSED: the test step starts Electron/.test(e.message) && /ZUMI_ELECTRON_HOST=box/.test(e.message), e && e.message);
  check(`onElectronHost is false with ${name}`, guard.onElectronHost(env) === false);
}
check('assertElectronHost passes with ZUMI_ELECTRON_HOST=box', throws(() => guard.assertElectronHost('x', { ZUMI_ELECTRON_HOST: 'box' })) === null && guard.onElectronHost({ ZUMI_ELECTRON_HOST: 'box' }) === true);
check('this process (anh\'s main PC / CI) is not the box, so the real default env refuses', process.env.ZUMI_ELECTRON_HOST === 'box' || throws(() => guard.assertElectronHost('default env')) !== null);
{
  const env = { ...process.env }; delete env.ZUMI_ELECTRON_HOST;
  const cli = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'lib', 'electron-guard.cjs'), 'npm run selftest'], { env, encoding: 'utf8' });
  check('CLI form (npm scripts): exit 1 + REFUSED message without the env var', cli.status === 1 && /REFUSED: npm run selftest/.test(cli.stderr), { status: cli.status, stderr: cli.stderr });
  const ok = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'lib', 'electron-guard.cjs'), 'x'], { env: { ...env, ZUMI_ELECTRON_HOST: 'box' }, encoding: 'utf8' });
  check('CLI form: exit 0 with ZUMI_ELECTRON_HOST=box', ok.status === 0);
  const startNo = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'lib', 'electron-guard.cjs'), 'npm start', '--allow-dev'], { env: (() => { const e = { ...env }; delete e.ZUMI_DEV_ELECTRON; return e; })(), encoding: 'utf8' });
  check('npm start form: exit 1 without the box var or the dev flag, and the message names ZUMI_DEV_ELECTRON=1', startNo.status === 1 && /REFUSED: npm start/.test(startNo.stderr) && /ZUMI_DEV_ELECTRON=1/.test(startNo.stderr), startNo.stderr);
  const startDev = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'lib', 'electron-guard.cjs'), 'npm start', '--allow-dev'], { env: { ...env, ZUMI_DEV_ELECTRON: '1' }, encoding: 'utf8' });
  check('npm start form: exit 0 with the explicit dev flag ZUMI_DEV_ELECTRON=1', startDev.status === 0);
}
check('the dev flag never opens a check or harness (no allowDev): ZUMI_DEV_ELECTRON=1 alone still throws', throws(() => guard.assertElectronHost('a check', { ZUMI_DEV_ELECTRON: '1' })) !== null);
check('the dev flag must be exactly "1"', throws(() => guard.assertElectronHost('npm start', { ZUMI_DEV_ELECTRON: 'yes' }, { allowDev: true })) !== null && throws(() => guard.assertElectronHost('npm start', { ZUMI_DEV_ELECTRON: '1' }, { allowDev: true })) === null);

// ---------- 2. the owner build's afterPack Electron gate: SKIPPED off the box, loudly, never a silent pass ----------
// The fake build stages the pinned rooms exactly as electron-builder's extraResources does (package.json
// build.extraResources: resources-pinned/room-v2 -> <appOutDir>/resources/resources-pinned/<dir>), because
// the afterPack hook re-hashes them (scripts/lib/pinned-rooms.cjs) and throws on a missing or changed file.
// Same list the gate pins, so a room added to or removed from the pins (room v1, 2026-10-26) never desyncs this fake.
const stagePinnedRooms = (appOutDir) => {
  for (const dir of require('./lib/pinned-rooms.cjs').PINNED_ROOM_DIRS) fs.cpSync(path.join(ROOT, 'resources-pinned', dir), path.join(appOutDir, 'resources', 'resources-pinned', dir), { recursive: true });
};
{
  const saved = process.env.ZUMI_ELECTRON_HOST;
  delete process.env.ZUMI_ELECTRON_HOST;
  const tmp = fs.mkdtempSync(path.join(ROOT, '.check-electron-guard-'));
  // The owner build's afterPack first stages the default avatar and re-hashes the pinned default rooms (sha256-pinned, so a
  // placeholder cannot pass). The FAKE app dir therefore gets a copy of the repo's committed resources-pinned (no new asset in git).
  const fakeApp = path.join(tmp, 'win-unpacked');
  const stageRooms = () => fs.cpSync(path.join(ROOT, 'resources-pinned'), path.join(fakeApp, 'resources', 'resources-pinned'), { recursive: true });
  const logs = [];
  const orig = console.log; console.log = (...a) => logs.push(a.join(' '));
  let err = null;
  try {
    const cfg = require('./builder-selftest.cjs');
    // a build with no pinned room staged must still FAIL loudly (the room gate is not weakened by the fixture)
    let missing = null;
    try { await cfg.afterPack({ appOutDir: fakeApp, outDir: tmp }); } catch (e) { missing = e; }
    check('afterPack with the pinned rooms missing from the build still FAILS (room gate intact)', missing !== null && /pinned room file missing/.test(missing.message), missing && missing.message);
    stageRooms();
    await cfg.afterPack({ appOutDir: fakeApp, outDir: tmp });
  } catch (e) { err = e; } finally { console.log = orig; if (saved !== undefined) process.env.ZUMI_ELECTRON_HOST = saved; }
  const gateLog = fs.existsSync(path.join(tmp, 'board-gate-checks.log')) ? fs.readFileSync(path.join(tmp, 'board-gate-checks.log'), 'utf8') : '';
  check('afterPack off the box: no error thrown (the build goes on) ...', err === null, err && err.message);
  check('... a loud "SKIPPED: not on box" console line', logs.some((l) => /SKIPPED: not on box/.test(l) && /NO Electron-gate evidence/.test(l)), logs);
  check('... and the same line in board-gate-checks.log (the build log shows the skip)', /SKIPPED: not on box/.test(gateLog) && !/-> exit 0/.test(gateLog), gateLog);
  check('... and nothing was spawned (no Electron output folder)', !fs.existsSync(path.join(tmp, 'board-open-electron')));
  fs.rmSync(tmp, { recursive: true, force: true });
}
// The gate still bites: the same fake build minus one pinned room file must fail afterPack (never weaken it to pass the check).
{
  const tmp = fs.mkdtempSync(path.join(ROOT, '.check-electron-guard-'));
  const appOutDir = path.join(tmp, 'win-unpacked');
  stagePinnedRooms(appOutDir);
  fs.rmSync(path.join(appOutDir, 'resources', 'resources-pinned', 'room-v2', 'occluders.glb'));
  const saved = process.env.ZUMI_ELECTRON_HOST;
  delete process.env.ZUMI_ELECTRON_HOST;
  const orig = console.log; console.log = () => {};
  let err = null;
  try { await require('./builder-selftest.cjs').afterPack({ appOutDir, outDir: tmp }); } catch (e) { err = e; } finally { console.log = orig; if (saved !== undefined) process.env.ZUMI_ELECTRON_HOST = saved; }
  check('a fake build with a pinned room file missing FAILS afterPack ("pinned room file missing"), so the gate still bites', err !== null && /pinned room file missing from the build/.test(err.message) && /room-v2/.test(err.message), err && err.message);
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---------- 3. every Electron / Zumi.exe starter in scripts/ calls the guard before it starts anything ----------
const src = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const before = (f, guardRe, spawnRe) => { const s = src(f); const g = s.search(guardRe), p = s.search(spawnRe); return g >= 0 && p >= 0 && g < p; };
const GUARDED = [
  ['scripts/check-settings-normal-launch.mjs', /assertElectronHost\('check-settings-normal-launch/, /spawnSync\(electron, /],
  ['scripts/check-board-open-electron.mjs', /assertElectronHost\('check-board-open-electron/, /spawn\(ELECTRON, /],
  ['scripts/box-e2e-update.mjs', /assertElectronHost\('box-e2e-update/, /state\.oldOut = build\(OLD\)/],
  ['scripts/electron-board-click.cjs', /exitUnlessElectronHost\('electron-board-click/, /require\('electron'\)/],
  ['scripts/electron-room-picker.cjs', /exitUnlessElectronHost\('electron-room-picker/, /require\('electron'\)/],
  ['scripts/electron-hud.cjs', /exitUnlessElectronHost\('electron-hud/, /require\('electron'\)/],
  ['scripts/electron-chair3d.cjs', /exitUnlessElectronHost\('electron-chair3d/, /require\('electron'\)/],
  ['scripts/electron-float-holo.cjs', /exitUnlessElectronHost\('electron-float-holo/, /require\('electron'\)/],
  ['scripts/fh-clips.mjs', /assertElectronHost\('fh-clips/, /spawnSync\(ELECTRON, /],
  ['scripts/make-icon.cjs', /exitUnlessElectronHost\('make-icon/, /require\('electron'\)/],
  ['scripts/builder-selftest.cjs', /if \(!onElectronHost\(\)\) \{/, /check-board-open-electron\.mjs'\), '--app'/],
];
for (const [f, g, p] of GUARDED) check(`${f}: guard before the Electron start`, before(f, g, p));
{
  const s = src('scripts/box-e2e-update.mjs');
  check('box-e2e-update: the guard comes before the first launch() and the installer run', s.search(/assertElectronHost\('box-e2e-update/) < s.search(/function launch\(env\)/) && !/args\.includes\('--box'\)/.test(s));
  const pkg = JSON.parse(src('package.json'));
  check('npm run selftest: the guard runs first (`guard && … electron .`)', /^node scripts\/lib\/electron-guard\.cjs .+ && .*electron \. --selftest/.test(pkg.scripts.selftest), pkg.scripts.selftest);
  // review 16bd64f: every npm script that runs `electron` starts with the guard (npm start takes the dev flag only)
  const electronScripts = Object.entries(pkg.scripts).filter(([, cmd]) => /(^|&&\s*|\s)electron(\s|$)/.test(cmd));
  check(`every npm script that runs electron starts with the guard (${electronScripts.map(([k]) => k).join(', ')})`, electronScripts.length >= 2 && electronScripts.every(([, cmd]) => cmd.startsWith('node scripts/lib/electron-guard.cjs ')), electronScripts);
  check('only npm start takes --allow-dev', electronScripts.filter(([, cmd]) => /--allow-dev/.test(cmd)).map(([k]) => k).join() === 'start', electronScripts);
}
// Sweep: any script that starts Electron, runs inside it, or launches an installed exe must load the guard, so a new
// one cannot slip in unguarded.
{
  const STARTS = /require\('electron'\)|node_modules', 'electron'|ELECTRON_EXE|_electron\b|electron\.launch\(|spawn\(exePath\(\)|electron-board-click\.cjs'\)|check-board-open-electron\.mjs'\)|--settings-probe'/;
  const files = fs.readdirSync(path.join(ROOT, 'scripts')).filter((f) => /\.(mjs|cjs|js)$/.test(f) && f !== 'check-electron-guard.mjs');
  // Node-only checks whose text merely matches STARTS. A guard that refuses here would make them unrunnable on anh's main
  // PC, and they start no window: api-contract loads the preloads under a STUBBED `electron` (the match is its comment),
  // tauri-selftest spawns the Node sidecar (`--settings-probe` is a sidecar arg). Each entry is proven below, not trusted.
  // A launch is any child-process call (spawn/exec/execFile/fork, sync or not): counted, never just searched for one.
  const LAUNCH = /\b(spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(/g;
  const launches = (s) => s.replace(/^\s*\/\/.*$/gm, '').match(LAUNCH) || [];
  const NODE_ONLY = {
    // no child_process at all, no launch call, and `electron` only ever reaches the code through the Module._load stub
    'check-api-contract.mjs': (s) => !/child_process/.test(s) && launches(s).length === 0 && /Module\._load = function \(request[^)]*\) \{\s*if \(request === 'electron'\)/.test(s),
    // exactly one launch call in the whole file, and it is the Node sidecar
    'check-tauri-selftest.mjs': (s) => launches(s).length === 1 && /spawn\(process\.execPath, \[SIDECAR/.test(s) && !/require\('electron'\)|ELECTRON_EXE/.test(s),
  };

  // Mutation self-test (gate B2-MERGE F): each proof must REJECT these in-memory launch mutations of the real source.
  const MUTATIONS = [
    ['check-api-contract.mjs', 'execFileSync(ELECTRON_EXE, ["."])', (s) => `${s}
execFileSync(ELECTRON_EXE, ['.']);
`],
    ['check-api-contract.mjs', 'spawn(exe, ["."])', (s) => `${s}
spawn(exe, ['.']);
`],
    ['check-tauri-selftest.mjs', 'spawn(zumiExe, [])', (s) => `${s}
spawn(zumiExe, []);
`],
  ];
  for (const [f, label, mutate] of MUTATIONS) check(`${f}: proof rejects a launch mutation (${label})`, NODE_ONLY[f](mutate(src(`scripts/${f}`))) === false);
  for (const [f, proof] of Object.entries(NODE_ONLY)) check(`${f}: exempt only because it starts nothing (stubbed electron / Node sidecar)`, proof(src(`scripts/${f}`)));
  const unguarded = files.filter((f) => STARTS.test(src(`scripts/${f}`)) && !/electron-guard\.cjs/.test(src(`scripts/${f}`)) && !(f in NODE_ONLY));
  check('sweep: every script in scripts/ that starts Electron or an installed Zumi loads electron-guard.cjs', unguarded.length === 0, unguarded);
  check('sweep found the known starters (the pattern is not blind)', files.filter((f) => STARTS.test(src(`scripts/${f}`))).length >= 7);
}

console.log(`\ncheck:electron-guard ${pass}/${pass + fail} passed`);
process.exitCode = fail ? 1 : 0;
