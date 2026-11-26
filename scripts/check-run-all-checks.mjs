// The runner must never report green wrongly (gate RC1 MF-R1 / MF-R2).
//   node scripts/check-run-all-checks.mjs   (npm run check:run-all-checks)
// 1. classify(): exit 0 = pass, exit 3 + the marker line = NOT RUN, everything else = FAIL, whatever the output says.
// 2. The real runner, copied into a throw-away root with fixture checks: a fault whose PASS lines name the render box / a
//    bundle is FAIL (MF-R2), a check that cannot run is NOT RUN with exit 2 (MF-R1), a partial skip is `pass (1 skipped)`.
// 3. The real board-pin-toggle check with a missing vault exe is NOT RUN (the case the gate measured as green).
// 4. No check file may announce a skip (any case, any wording with skip) and then end with a clean exit (that is how MF-R1 happened); it must call notRun().
//    The scan itself is mutation-proved on the three shapes the live gate (R2) evaded it with.
// 5. A product fault found before a check reaches its precondition is a FAIL, not NOT RUN (live gate R1): the classifier and the real
//    check-settings-normal-launch run against a mutated main.js.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const outcome = require('./lib/check-outcome.cjs');
let pass = 0, fail = 0;
const ok = (c, n, d) => { if (c) pass++; else fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${!c && d !== undefined ? '  ' + JSON.stringify(d) : ''}`); };

// ---------- 1. the classifier ----------
const M = outcome.NOT_RUN_MARK;
const c = (out, code) => outcome.classify(out, code);
ok(c('PASS a\nPASS b', 0).status === 'pass', 'exit 0 is a pass');
ok(c('PASS a\nSKIP symlink case\n  SKIP junction case', 0).skipped === 2 && c('SKIP x', 0).status === 'pass', 'a partial skip is a pass that counts its skips');
ok(c(`${M} bundle - no bundle`, 3).status === 'not-run' && c(`${M} bundle - no bundle`, 3).kind === 'bundle', 'exit 3 + marker is NOT RUN');
ok(c('PASS refuses with ELECTRON_HOST_REQUIRED\nPASS Build it first is printed\nFAIL 3 asserts', 1).status === 'fail', 'MF-R2: a fault whose PASS lines mention the box or a bundle is a FAIL');
ok(c('runs only on the render box', 1).status === 'fail' && c('Build it first', 1).status === 'fail', 'the old substrings alone never make a NOT RUN');
ok(c('boom', 3).status === 'fail', 'exit 3 without the marker is a FAIL');
ok(c(`${M} box - x`, 0).status === 'fail' && c(`${M} box - x`, 1).status === 'fail', 'the marker with any other exit code is a FAIL');
ok(c(`PASS a
FAIL main: settingsShotsDir is null in a packaged build
${M} box - x`, 3).status === 'fail', 'R1: a FAIL line before the NOT RUN marker makes the check a FAIL (a missing precondition cannot hide a product fault)');
ok(c(`PASS a
PASS b
${M} box - x`, 3).status === 'not-run', 'R1 control: PASS lines before the marker are still NOT RUN');
ok(c('SKIP check-x - nothing to run', 0).status === 'pass' && c('SKIP check-x - nothing to run', 0).skipped === 1, 'classify alone cannot tell a whole-check SKIP: rule 4 below forbids it');

// ---------- 2. the real runner on fixture checks ----------
const TMP = path.join(ROOT, '.tauri-check-tmp', 'run-all-checks-selftest');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(path.join(TMP, 'scripts', 'lib'), { recursive: true });
for (const f of ['scripts/run-all-checks.mjs', 'scripts/lib/check-outcome.cjs', 'scripts/lib/owner-asset-checks.cjs']) fs.copyFileSync(path.join(ROOT, f), path.join(TMP, f));
const fx = {
  fault: `console.log('PASS the guard refuses with ELECTRON_HOST_REQUIRED, runs only on the render box');console.log('PASS Build it first');console.log('FAIL 3 asserts');process.exit(1);`,
  missing: `require('./lib/check-outcome.cjs').notRun('bundle', 'no bundle; Build it first');`,
  partial: `console.log('PASS a');console.log('SKIP the symlink case');`,
  green: `console.log('PASS a');`,
  bare3: `console.log('no marker');process.exit(3);`,
};
const scripts = {};
for (const [k, body] of Object.entries(fx)) { fs.writeFileSync(path.join(TMP, 'scripts', `fx-${k}.cjs`), body); scripts[`check:${k}`] = `node scripts/fx-${k}.cjs`; }
fs.writeFileSync(path.join(TMP, 'package.json'), JSON.stringify({ scripts }));
const run = (only, env = {}) => spawnSync(process.execPath, [path.join(TMP, 'scripts', 'run-all-checks.mjs'), '--only', only, '--out', path.join(TMP, 'out')], { cwd: TMP, encoding: 'utf8', env: { ...process.env, ...env } });
{
  const r = run('^check:fault$');
  ok(r.status === 1 && /FAIL check:fault/.test(r.stdout) && !/NOT RUN check/.test(r.stdout), 'runner: a product fault is FAIL with exit 1, not NOT RUN', { status: r.status, out: r.stdout });
  const m = run('^check:missing$');
  ok(m.status === 2 && /NOT RUN check:missing/.test(m.stdout) && /1 NOT RUN/.test(m.stdout) && /0 pass/.test(m.stdout), 'runner: a check that cannot run is NOT RUN, exit 2, not counted as pass', { status: m.status, out: m.stdout });
  const p = run('^check:partial$');
  ok(p.status === 0 && /ok\s+check:partial.*pass \(1 skipped\)/.test(p.stdout), 'runner: a partial skip is `pass (1 skipped)`', { status: p.status, out: p.stdout });
  const g = run('^check:green$');
  ok(g.status === 0 && /1 pass, 0 FAIL, 0 NOT RUN/.test(g.stdout), 'runner: a clean check is a pass, exit 0', { status: g.status, out: g.stdout });
  const b = run('^check:bare3$');
  ok(b.status === 1 && /FAIL check:bare3/.test(b.stdout), 'runner: exit 3 without the marker is FAIL', { status: b.status, out: b.stdout });
  const all = run('^check:(fault|missing|green)$');
  ok(all.status === 1, 'runner: one FAIL beside a NOT RUN is still exit 1', { status: all.status });
  // 6. OSS-02 step 0b: a check that reads owner assets (scripts/lib/owner-asset-checks.cjs) is NOT RUN in a public tree (no
  // src/main/owner-values.json) and runs as before in an owner tree. The fixture borrows a real table name and fails when it runs.
  fs.writeFileSync(path.join(TMP, 'scripts', 'fx-owner.cjs'), `console.log('FAIL the owner model is missing');process.exit(1);`);
  fs.writeFileSync(path.join(TMP, 'package.json'), JSON.stringify({ scripts: { ...scripts, 'check:no-office': 'node scripts/fx-owner.cjs' } }));
  const pub = run('^check:no-office$');
  ok(pub.status === 2 && /NOT RUN check:no-office \(0s\) \[precondition\]/.test(pub.stdout), 'runner: an owner-asset check in a public tree (no owner values file) is NOT RUN [precondition], exit 2', { status: pub.status, out: pub.stdout });
  fs.mkdirSync(path.join(TMP, 'src', 'main'), { recursive: true });
  fs.writeFileSync(path.join(TMP, 'src', 'main', 'owner-values.json'), '{}');
  const own = run('^check:no-office$');
  ok(own.status === 1 && /FAIL check:no-office/.test(own.stdout), 'runner: the same check in an owner tree runs, and its FAIL is a FAIL', { status: own.status, out: own.stdout });
}
{
  // every name in the owner-asset table is a real npm script (no stale entry silently keeps a check from ever failing)
  const assetLib = path.join(ROOT, 'scripts', 'lib', 'owner-asset-checks.cjs');
  const table = fs.existsSync(assetLib) ? require(assetLib).OWNER_ASSET_CHECKS : null;
  const pkgScripts = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts;
  const stale = table ? Object.keys(table).filter((n) => !(n in pkgScripts)) : ['(no table)'];
  ok(stale.length === 0, 'every owner-asset table entry names an npm script of this tree', stale);
}
fs.rmSync(TMP, { recursive: true, force: true });

// ---------- 3. the real check the gate measured as green with the precondition missing ----------
{
  const env = { ...process.env, ZUMI_VAULT_EXE: path.join(ROOT, '.tauri-check-tmp', 'no-such-vault.exe') };
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'check-board-pin-toggle-ipc.mjs')], { cwd: ROOT, encoding: 'utf8', env });
  ok(r.status === 3 && outcome.classify(r.stdout + r.stderr, r.status).status === 'not-run', 'check-board-pin-toggle-ipc with a missing zumi-vault.exe exits 3 = NOT RUN (was SKIP + exit 0)', { status: r.status, out: r.stdout });
  const rr = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'run-all-checks.mjs'), '--only', '^check:board-pin-toggle-ipc$', '--out', path.join(ROOT, '.tauri-check-tmp', 'run-all-checks-pin')], { cwd: ROOT, encoding: 'utf8', env });
  ok(rr.status === 2 && /NOT RUN check:board-pin-toggle-ipc/.test(rr.stdout) && /0 pass/.test(rr.stdout), 'the real runner reports it NOT RUN, exit 2, 0 pass', { status: rr.status, out: rr.stdout });
}

// ---------- 4. no check file may announce a skip and then exit clean ----------
{
  const scan = outcome.scanSkipThenCleanExit;
  // mutation proof: the shapes the live gate evaded the old scan with must now be found, and ordinary code must not
  ok(scan("console.log('SKIP no vault'); process.exit();").length === 1, 'scan finds SKIP then process.exit() with no argument');
  ok(scan("console.error('skipped: no browser here'); process.exit(0);").length === 1, 'scan finds a lowercase skipped: line then process.exit(0)');
  ok(scan(["console.log('SKIP no vault');", '// a', '// b', '// c', 'foo();', 'process.exit(0);'].join('\n')).length === 1, 'scan finds the exit 4 lines after the SKIP line');
  ok(scan("process.stdout.write('Skipping the live part'); process.exitCode = 0;").length === 1, 'scan finds process.stdout.write and process.exitCode = 0');
  ok(scan("console.log('PASS a'); process.exit(0);").length === 0 && scan(["console.log('SKIP the symlink case');", ...Array(20).fill('x();'), 'process.exit(0);'].join('\n')).length === 0, 'scan control: no skip text, or a partial skip far from any exit, is not flagged');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts;
  const files = new Set();
  for (const [k, v] of Object.entries(pkg)) if (k.startsWith('check:')) for (const m of String(v).matchAll(/(?:scripts|tauri\/verify)\/[\w./-]+\.(?:mjs|cjs|js)/g)) files.add(m[0]);
  for (const f of fs.readdirSync(path.join(ROOT, 'scripts'))) if (/^check-.*\.(mjs|cjs)$/.test(f)) files.add('scripts/' + f); // registered or not: the next person registers it
  const bad = [];
  for (const f of files) {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p) || f === 'scripts/check-run-all-checks.mjs') continue; // this file holds the scan's own fixture strings
    for (const line of scan(fs.readFileSync(p, 'utf8'))) bad.push(`${f}:${line}`);
  }
  ok(files.size > 200 && bad.length === 0, `no check file announces a skip and then exits clean (${files.size} files; use notRun() from scripts/lib/check-outcome.cjs)`, bad);
}

// ---------- 5. a product fault found before the precondition is a FAIL ----------
{
  const T5 = path.join(ROOT, '.tauri-check-tmp', 'run-all-checks-settings-mut');
  fs.rmSync(T5, { recursive: true, force: true });
  fs.mkdirSync(path.join(T5, 'scripts', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(T5, 'src', 'main'), { recursive: true });
  for (const f of ['scripts/check-settings-normal-launch.mjs', 'scripts/lib/check-outcome.cjs', 'scripts/lib/electron-guard.cjs']) fs.copyFileSync(path.join(ROOT, f), path.join(T5, f));
  const real = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.js'), 'utf8');
  const mutated = real.replace(/const settingsShotsDir = \(app\.isPackaged \|\|/, 'const settingsShotsDir = (false ||');
  ok(mutated !== real, 'the mutation applies (app.isPackaged -> false in settingsShotsDir)');
  fs.writeFileSync(path.join(T5, 'src', 'main', 'main.js'), mutated);
  const r = spawnSync(process.execPath, [path.join(T5, 'scripts', 'check-settings-normal-launch.mjs')], { cwd: T5, encoding: 'utf8', timeout: 60000 });
  ok(r.status === 1 && /FAIL main: settingsShotsDir is null/.test(r.stdout) && outcome.classify(r.stdout + r.stderr, r.status).status === 'fail', 'check-settings-normal-launch with a mutated main.js is FAIL, exit 1 (the gate saw NOT RUN)', { status: r.status, tail: r.stdout.slice(-300) });
  fs.rmSync(T5, { recursive: true, force: true });
}



console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
