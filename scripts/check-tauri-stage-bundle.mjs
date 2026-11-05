// T-31: stage-bundle must look for zumi-vault.exe in the cargo target dir, not always src-tauri/target.
// Box and scratch builds set CARGO_TARGET_DIR, so a hardcoded path passes locally and fails everywhere else.
//
//   node scripts/check-tauri-stage-bundle.mjs
//
// Pure path/source checks: no cargo build, no app launch, no files written.
import fs from 'node:fs';
import path from 'node:path';

import { cargoTargetDir, vaultExePath } from '../tauri/stage-bundle.mjs';

const srcTauri = path.resolve(import.meta.dirname, '..', 'tauri', 'src-tauri');
const cwd = path.resolve(import.meta.dirname, '..');

let pass = 0;
let fail = 0;
const ok = (cond, name, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); }
};
const eq = (got, want, name) => ok(got === want, name, `got ${got}, want ${want}`);

// env unset: the in-tree default.
{
  const env = {};
  eq(cargoTargetDir(env, cwd), path.join(srcTauri, 'target'), 'env unset: target dir is src-tauri/target');
  eq(vaultExePath(env, cwd), path.join(srcTauri, 'target', 'release', 'zumi-vault.exe'), 'env unset: vault path');
}

// env set to an absolute path: used as-is.
{
  const abs = path.resolve(cwd, '..', 'box-targets', 't31');
  const env = { CARGO_TARGET_DIR: abs };
  eq(cargoTargetDir(env, cwd), abs, 'env absolute: target dir is the override');
  eq(vaultExePath(env, cwd), path.join(abs, 'release', 'zumi-vault.exe'), 'env absolute: vault path');
}

// env set to a relative path: resolved from the cwd, as cargo does.
{
  const rel = path.join('..', 'scratch-target');
  const env = { CARGO_TARGET_DIR: rel };
  eq(cargoTargetDir(env, cwd), path.resolve(cwd, rel), 'env relative: target dir resolves from cwd');
  eq(vaultExePath(env, cwd), path.join(path.resolve(cwd, rel), 'release', 'zumi-vault.exe'), 'env relative: vault path');
}

// Assets Electron ships under build.files `assets/**` must be staged; scripts/** must not (Electron's files list has
// none either).
{
  const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
  const files = (pkg.build && pkg.build.files) || [];
  ok(files.includes('assets/**'), 'Electron packages assets/** (chair3d + rooms-video live there)', JSON.stringify(files));
  ok(!files.some((f) => /^!?scripts\//.test(f)), 'Electron packages no scripts/** (neither build ships dev scripts)', JSON.stringify(files));

  const stageSrc = fs.readFileSync(path.join(cwd, 'tauri', 'stage-bundle.mjs'), 'utf8');
  ok(/copyTracked\('assets\/chair3d'\)/.test(stageSrc), 'stage-bundle copies assets/chair3d from git (Electron parity)');
  ok(/copyTracked\('assets\/rooms-video'\)/.test(stageSrc), 'stage-bundle copies assets/rooms-video from git');
  ok(/copyTracked\('tauri\/sidecar'\)/.test(stageSrc) && /copyTracked\('src\/main'\)/.test(stageSrc), 'stage-bundle copies the sidecar and src/main');
  // Every tree the sidecar reads from its resource root and Electron ships (build.files / extraResources) is staged.
  const extra = (pkg.build && pkg.build.extraResources) || [];
  ok(files.includes('vendor/laneboard/**') && /copyTracked\('vendor\/laneboard'\)/.test(stageSrc), 'stage-bundle copies vendor/laneboard (the Board tab and the selftest board part need it)');
  ok(extra.some((e) => e.from === 'resources-pinned/room-v2') && /copyTracked\('resources-pinned\/room-v2'\)/.test(stageSrc), 'stage-bundle copies resources-pinned/room-v2 (the default room)');
  ok(!extra.some((e) => /room-v1/.test(e.from)) && !/room-v1|verifyStagedRoomV1/.test(stageSrc), 'stage-bundle stages no room v1 in any flavour (removed, owner 2026-10-26)');
  ok(/copyTracked\('assets\/models'\)/.test(stageSrc) && /copyTracked\('assets\/clips'\)/.test(stageSrc), 'stage-bundle copies assets/models and assets/clips (assets/** parity)');
  ok(!/copyTracked\('scripts'?\)|copyTracked\('scripts\/|fs\.cpSync/.test(stageSrc), 'stage-bundle never stages scripts/ (and never a working-tree copy)');
}

// Runtime spawns of scripts/ (invisible to the import walk): no src/main module builds a scripts/ path at runtime (the only
// one, wardrobe-gate.mjs, left with the wardrobe in 0.3.0-alpha.11; a packaged build ships no scripts/).
{
  const spawners = [];
  for (const f of fs.readdirSync(path.join(cwd, 'src', 'main')).filter((n) => /.(mjs|js)$/.test(n))) {
    if (/['"]scripts['"]/.test(fs.readFileSync(path.join(cwd, 'src', 'main', f), 'utf8'))) spawners.push(f);
  }
  ok(spawners.length === 0, 'no src/main module spawns a scripts/ path at runtime', spawners.join(', '));
}

// build.ps1 must copy the exe cargo actually built (CARGO_TARGET_DIR) and refuse a stale one (N3 proof b4b8a58).
{
  const ps = fs.readFileSync(path.join(cwd, 'tauri', 'build.ps1'), 'utf8');
  ok(/\$env:CARGO_TARGET_DIR/.test(ps) && /\$builtExe\s*=\s*Join-Path \$release \$mainExeName/.test(ps), 'build.ps1 resolves the exe from CARGO_TARGET_DIR');
  ok(/Copy-Item -Force \$builtExe \$unpacked/.test(ps) && !/Copy-Item[^\n]*Join-Path \$release '[^']*\.exe'/.test(ps), 'build.ps1 copies $builtExe, not a hard-coded target path');
  ok(/\$buildStart = Get-Date/.test(ps) && /\$builtExeTime -lt \$buildStart/.test(ps) && /throw "stale exe/.test(ps), 'build.ps1 fails loudly on an exe older than the build start');
}

// A user build must never need dev gate scripts: every relative import reachable from the sidecar entry (which
// includes the attach policy and the board host) must land in a tree stage-bundle copies, and none may point into scripts/.
{
  const stageSrc = fs.readFileSync(path.join(cwd, 'tauri', 'stage-bundle.mjs'), 'utf8');
  const staged = [...stageSrc.matchAll(/copyTracked\('([^']+)'\)/g)].map((m) => m[1]);
  const seen = new Set();
  const stack = [path.join(cwd, 'tauri', 'sidecar', 'main.mjs')];
  const offenders = [];
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const rel = path.relative(cwd, file).split(path.sep).join('/');
    if (!staged.some((d) => rel === d || rel.startsWith(`${d}/`))) offenders.push(`${rel} (not staged)`);
    if (/^scripts\//.test(rel)) offenders.push(`${rel} (dev script)`);
    if (!/\.(mjs|js)$/.test(file) || !fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/(?:from|import\()\s*['"](\.{1,2}\/[^'"]+)['"]/g)) stack.push(path.resolve(path.dirname(file), m[1]));
  }
  ok(seen.size > 10 && seen.has(path.join(cwd, 'src', 'main', 'webview-policy.mjs')), 'import walk reaches the attach policy (webview-policy.mjs)', `${seen.size} files`);
  ok(![...seen].some((f) => /wardrobe/i.test(path.basename(f))), 'no wardrobe module is reachable from the sidecar', [...seen].filter((f) => /wardrobe/i.test(f)).join(', '));
  ok(offenders.length === 0, 'every statically imported/required module reachable from the sidecar is staged; none is a scripts/ file (runtime spawns not covered)', offenders.join(', '));
}

if (fail) {
  console.log(`check-tauri-stage-bundle FAIL (${fail} failed, ${pass} passed)`);
  process.exit(1);
}
console.log(`check-tauri-stage-bundle OK (${pass} passed)`);
