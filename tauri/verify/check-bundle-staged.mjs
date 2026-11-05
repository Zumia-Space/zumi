// T-31 parity 7-1: stage the bundle resources and check the staged dir in one command.
//
//   npm run check:tauri-bundle-staged
//
// No Tauri release build: stage-bundle.mjs copies zumi-vault.exe (from
// cargo target/release), the sidecar, src/main and the voice modules into tauri/src-tauri/bundle, then check-bundle.mjs
// asserts that staged tree, including that node.exe is ABSENT (option (c): Node is found/downloaded at runtime). The
// staged tree stays out of git // (.gitignore: tauri/src-tauri/bundle/*).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = path.resolve(import.meta.dirname, '..', '..');

// Step 7-8: the sidecar and src/main trees must come from `git ls-files`, never from a working-tree copy — otherwise an
// untracked local file (possibly carrying a secret) ships and the name-only secret check cannot see it.
const stageSrc = fs.readFileSync(path.join(repo, 'tauri', 'stage-bundle.mjs'), 'utf8');
const stageProblems = [];
if (!/function copyTracked\(/.test(stageSrc)) stageProblems.push('copyTracked() is missing');
if (!/'ls-files', '-z', '--', rel/.test(stageSrc)) stageProblems.push('git ls-files -z is not used');
if (!/copyTracked\('tauri\/sidecar'\)/.test(stageSrc) || !/copyTracked\('src\/main'\)/.test(stageSrc)) stageProblems.push('the two trees are not staged by copyTracked');
if (/copyTree\(|fs\.cpSync\(/.test(stageSrc)) stageProblems.push('a working-tree tree copy is still present');
if (stageProblems.length) {
  console.error(`check-bundle-staged: stage-bundle.mjs is not git-tracked-only: ${stageProblems.join('; ')}`);
  process.exit(1);
}
const stage = path.join(repo, 'tauri', 'src-tauri', 'bundle');
const env = { ...process.env };

const steps = [
  ['stage-bundle.mjs', []],
  ['verify/check-bundle.mjs', ['--dir', stage]],
];

for (const [script, args] of steps) {
  const run = spawnSync(process.execPath, [path.join(repo, 'tauri', script), ...args], { cwd: repo, env, stdio: 'inherit' });
  if (run.error) {
    console.error(`check-bundle-staged: could not run ${script}: ${run.error.message}`);
    process.exit(1);
  }
  if (run.status !== 0) process.exit(run.status ?? 1);
}
