// The one runner for every `check:*` npm script (RC1 triage). It exists because a bare `npm run check:x` loop gave 32 red checks
// that were not product faults: some need a build first, some refuse to run off the render box, and some rebuild the shared
// build/renderer folder, so two of them run at once clobber each other (market-ui + market-e2e -> a 404 on index.html).
//   node scripts/run-all-checks.mjs [--only <regex>] [--conc N (default 1)] [--out <dir>] [--no-prereqs]
// 1. PREREQUISITES, once, in order, each fatal if it fails (a missing prerequisite is never a silent skip):
//      build/renderer (esbuild) -> tauri/ui (prep-ui) -> zumi-vault.exe debug + release (the vault/board/hud/bundle-staged checks)
// 2. CHECKS: one at a time by default. --conc N runs N at once (those that rebuild shared folders still run alone, at the end), but a loaded PC
//    makes sidecar-boot, latency and temp-file checks fail on timing (tauri-hud, tauri-room-default, kokoro-egress EPERM were red at 3 and green alone).
// 3. One contract, scripts/lib/check-outcome.cjs (gate RC1 MF-R1/MF-R2). The runner never reads PASS/FAIL words:
//      - exit 0 = pass; a line that starts with SKIP on a pass is a skipped case of a check that ran, shown as `pass (N skipped)`;
//      - exit 3 AND a line `ZUMI-CHECK-NOT-RUN: <kind> - <why>` = NOT RUN: the check's own precondition is absent (no zumi-vault.exe, not
//        the render box ZUMI_ELECTRON_HOST=box, no unpacked bundle or installer from tauri\build.ps1 -Flavour owner). Never a pass;
//      - every other exit = FAIL, whatever the output mentions (a product fault that prints "Build it first" is still a FAIL).
//    Exit 0 = every check ran and passed. Exit 1 = a check failed. Exit 2 = nothing failed but some checks were NOT RUN.
// Env: ZUMI_PLAYWRIGHT_DIR (+ ZUMI_CHROMIUM) for the browser checks, as each of them documents.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const { classify, NOT_RUN_MARK } = createRequire(import.meta.url)('./lib/check-outcome.cjs');
const { ownerAssetPrecondition } = createRequire(import.meta.url)('./lib/owner-asset-checks.cjs');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const only = arg('--only') ? new RegExp(arg('--only')) : null;
const conc = Math.max(1, Number(arg('--conc', 1)));
const out = path.resolve(arg('--out', path.join(ROOT, '.tauri-check-tmp', 'run-all-checks')));
const scripts = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts;

const PREREQS = [
  ['renderer build', process.execPath, ['scripts/build-renderer.mjs']],
  ['tauri/ui (prep-ui)', process.execPath, ['tauri/prep-ui.mjs']],
  ['zumi-vault.exe (debug)', 'cargo', ['build', '--manifest-path', 'tauri/src-tauri/Cargo.toml', '--bins']],
  ['zumi-vault.exe (release)', 'cargo', ['build', '--release', '--manifest-path', 'tauri/src-tauri/Cargo.toml', '--bin', 'zumi-vault']],
];

if (!args.includes('--no-prereqs') && !only) {
  for (const [label, cmd, a] of PREREQS) {
    const r = spawnSync(cmd, a, { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 1 << 28 });
    console.log(`prereq ${r.status === 0 ? 'ok  ' : 'FAIL'} ${label}`);
    if (r.status !== 0) { console.log(`${r.stdout || ''}${r.stderr || ''}`.split(/\r?\n/).slice(-15).join('\n')); process.exit(1); }
  }
}

const names = Object.keys(scripts).filter((k) => k.startsWith('check:') && (!only || only.test(k)));
// A check that builds into a shared folder (build/renderer, tauri/ui, the staged bundle) must not overlap another that does.
const rebuilds = (cmd) => [...String(cmd).matchAll(/(?:scripts|tauri\/verify|tauri)\/[\w.-]+\.mjs/g)]
  .some((m) => /build-renderer|prep-ui|stage-bundle/.test(fs.existsSync(path.join(ROOT, m[0])) ? fs.readFileSync(path.join(ROOT, m[0]), 'utf8') : ''));
const exclusive = names.filter((n) => rebuilds(scripts[n]));
const parallel = names.filter((n) => !exclusive.includes(n));
fs.mkdirSync(out, { recursive: true });

const results = {};
const runOne = (name) => new Promise((resolve) => {
  const t0 = Date.now();
  // An owner-asset check in a tree without the owner values file (the public source): NOT RUN, never started (owner-asset-checks.cjs).
  const missing = ownerAssetPrecondition(name, ROOT);
  if (missing) {
    fs.writeFileSync(path.join(out, `${name.replace(/:/g, '_')}.log`), `${NOT_RUN_MARK} precondition - ${missing}\n`);
    results[name] = { status: 'not-run', code: 3, seconds: 0, kind: 'precondition' };
    console.log(`NOT RUN ${name} (0s) [precondition]`);
    resolve();
    return;
  }
  const c = spawn(scripts[name], { cwd: ROOT, shell: true, env: process.env });
  let buf = '';
  c.stdout.on('data', (d) => { buf += d; });
  c.stderr.on('data', (d) => { buf += d; });
  const timer = setTimeout(() => { buf += '\n[run-all-checks: timeout after 900 s]'; spawn('taskkill', ['/PID', String(c.pid), '/T', '/F']); }, 900000);
  c.on('close', (code) => {
    clearTimeout(timer);
    fs.writeFileSync(path.join(out, `${name.replace(/:/g, '_')}.log`), buf);
    const o = classify(buf, code);
    const status = o.status === 'fail' ? 'FAIL' : o.status;
    results[name] = { status, code, seconds: Math.round((Date.now() - t0) / 1000), ...(o.kind ? { kind: o.kind } : {}), ...(o.skipped ? { skipped: o.skipped } : {}) };
    console.log(`${status === 'pass' ? 'ok  ' : status === 'FAIL' ? 'FAIL' : 'NOT RUN'} ${name} (${results[name].seconds}s)${status === 'not-run' ? ` [${o.kind}]` : ''}${o.skipped ? ` pass (${o.skipped} skipped)` : ''}${o.kind === 'marker-with-wrong-exit' ? ' [prints the NOT RUN marker but did not exit 3]' : ''}`);
    resolve();
  });
});
const pool = async (list, n) => { const q = [...list]; await Promise.all(Array.from({ length: n }, async () => { while (q.length) await runOne(q.shift()); })); };
await pool(parallel, conc);
await pool(exclusive, 1);

const by = (s) => Object.keys(results).filter((k) => results[k].status === s).sort();
const failed = by('FAIL'), notRun = by('not-run');
const partial = by('pass').filter((k) => results[k].skipped);
fs.writeFileSync(path.join(out, '_summary.json'), JSON.stringify(results, null, 1));
console.log(`\n${names.length} checks: ${by('pass').length} pass${partial.length ? ` (${partial.length} skipped part of their own work: ${partial.join(', ')})` : ''}, ${failed.length} FAIL, ${notRun.length} NOT RUN (logs: ${out})`);
if (failed.length) console.log(`FAIL: ${failed.join(', ')}`);
if (notRun.length) console.log(`NOT RUN: ${notRun.join(', ')}`);
process.exit(failed.length ? 1 : notRun.length ? 2 : 0);
