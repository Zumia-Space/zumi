#!/usr/bin/env node
// The official installer's Zumi-only files come from a private asset repo; official-assets.json in this public tree pins each one by
// size and sha256. A source export or a fork has neither the repo nor the token, and builds the public flavour instead.
//   node scripts/fetch-official-assets.mjs --from <asset checkout>                check, copy into this tree and stage in the git index
//   node scripts/fetch-official-assets.mjs --from <asset folder> --write-pins     maintainers: rewrite official-assets.json
// Staged because tauri/stage-bundle.mjs ships only what git tracks. Nothing is committed. The .vrm and the room videos are not copied:
// the build reads them from ZUMI_DEFAULT_VRM_PATH and ZUMI_ROOMS_SRC_DIR, written to GITHUB_ENV in CI and printed otherwise.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PINS = path.join(ROOT, 'official-assets.json');
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === '.gitattributes') continue; // the asset repo holds `* -text`, so a Windows runner cannot rewrite a pinned file
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, base, out);
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

/** Every way the folder differs from the pins. Empty = exactly the pinned files, byte for byte. */
export function assetProblems(from, pins) {
  const problems = [];
  const present = new Set(walk(from));
  for (const [rel, pin] of Object.entries(pins)) {
    const file = path.join(from, rel);
    if (!present.has(rel)) problems.push(`missing: ${rel}`);
    else if (fs.statSync(file).size !== pin.bytes) problems.push(`size differs: ${rel}`);
    else if (sha256(file) !== pin.sha256) problems.push(`sha256 differs: ${rel}`);
    present.delete(rel);
  }
  for (const rel of present) problems.push(`not pinned: ${rel}`);
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const fromAt = args.indexOf('--from');
  const from = fromAt >= 0 ? path.resolve(args[fromAt + 1]) : null;
  if (!from || !fs.existsSync(from)) { console.error('usage: node scripts/fetch-official-assets.mjs --from <asset checkout> [--write-pins]'); process.exit(2); }
  if (args.includes('--write-pins')) {
    const pins = {};
    for (const rel of walk(from).sort()) pins[rel] = { bytes: fs.statSync(path.join(from, rel)).size, sha256: sha256(path.join(from, rel)) };
    fs.writeFileSync(PINS, `${JSON.stringify(pins, null, 2)}\n`);
    console.log(`pinned ${Object.keys(pins).length} files`);
    process.exit(0);
  }
  const pins = JSON.parse(fs.readFileSync(PINS, 'utf8'));
  const problems = assetProblems(from, pins);
  if (problems.length) { console.error(`fetch-official-assets: refused\n  ${problems.join('\n  ')}`); process.exit(1); }
  let model = null;
  let rooms = 0;
  for (const rel of Object.keys(pins)) {
    if (rel.endsWith('.vrm')) { model = path.join(from, rel); continue; }
    // The room videos stay in the checkout: tauri/stage-bundle.mjs copies them from ZUMI_ROOMS_SRC_DIR into the stage, re-checking
    // each one against rooms.json, so ~26 MB never enters the git index.
    if (/^rooms-video\/[^/]+\.mp4$/.test(rel)) { rooms++; continue; }
    fs.mkdirSync(path.dirname(path.join(ROOT, rel)), { recursive: true });
    fs.copyFileSync(path.join(from, rel), path.join(ROOT, rel));
    const added = spawnSync('git', ['-C', ROOT, 'add', '-f', '--', rel], { encoding: 'utf8' });
    if (added.status !== 0) { console.error(`git add failed for ${rel}: ${added.stderr}`); process.exit(1); }
  }
  if (!model) { console.error('fetch-official-assets: no .vrm in the pins'); process.exit(1); }
  if (!rooms) { console.error('fetch-official-assets: no room video in the pins'); process.exit(1); }
  const lines = [`ZUMI_DEFAULT_VRM_PATH=${model}`, `ZUMI_ROOMS_SRC_DIR=${path.join(from, 'rooms-video')}`];
  if (process.env.GITHUB_ENV) fs.appendFileSync(process.env.GITHUB_ENV, `${lines.join('\n')}\n`);
  console.log(`official assets in place: ${Object.keys(pins).length} files verified. ${lines.join(' ')}`);
}
