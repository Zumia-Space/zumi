#!/usr/bin/env node
// Replaces vendor/laneboard with the Laneboard core at one commit, and records that commit in vendor/laneboard/VERSION.
//   npm run update:laneboard -- <sha|ref> [--repo <laneboard git repo>]
// Default repo: $LANEBOARD_REPO, else the owner's Laneboard checkout (owner-paths laneboardRepo). The ref is resolved to a full sha first; only the
// runtime files (what Laneboard's own package.json "files" ships, minus bin/ and fixtures/) are copied, via `git archive`,
// so the vendored tree is byte-for-byte that commit. Review `git diff vendor/laneboard` and commit it together with VERSION.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ownerPath } from './lib/owner-paths.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEST = path.join(ROOT, 'vendor', 'laneboard');
const PATHS = ['src', 'public', 'schema', 'scripts', 'package.json', 'LICENSE', 'NOTICE', 'README.md', 'AGENTS.md'];

const args = process.argv.slice(2);
const repoAt = args.indexOf('--repo');
const repo = path.resolve(repoAt >= 0 ? args[repoAt + 1] : process.env.LANEBOARD_REPO || ownerPath('laneboardRepo', 'local/laneboard'));
const ref = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--repo');
if (!ref) { console.error('usage: npm run update:laneboard -- <sha|ref> [--repo <laneboard repo>]'); process.exit(2); }

const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim();
const sha = git('rev-parse', '--verify', `${ref}^{commit}`);
const tmp = fs.mkdtempSync(path.join(ROOT, '.laneboard-update-')); // next to the repo (drive D), removed below
try {
  const tar = path.join(tmp, 'laneboard.tar');
  execFileSync('git', ['-C', repo, 'archive', '--format=tar', '-o', tar, sha, ...PATHS]);
  const out = path.join(tmp, 'tree');
  fs.mkdirSync(out);
  execFileSync('tar', ['-xf', '../laneboard.tar'], { cwd: out }); // relative: GNU tar reads "D:\…" as a remote host
  fs.rmSync(DEST, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(DEST), { recursive: true });
  fs.cpSync(out, DEST, { recursive: true });
  fs.writeFileSync(path.join(DEST, 'VERSION'), sha + '\n');
  // RELEASE is what Laneboard's own /healthz reports (the live release swap writes the same short sha), so the board in
  // the app answers {release} exactly like the live board and scripts/check-parity.mjs can compare the two.
  fs.writeFileSync(path.join(DEST, 'RELEASE'), sha.slice(0, 7) + '\n');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`vendor/laneboard = ${sha} (from ${repo})`);
// placeWkPop + .wk-pop.up (the worker popover opens upward when there is no room below): a Zumi patch on 760501b,
// upstream in Laneboard since 3a0fc78 (feat/j05-ask-media). A pin without it drops that fix.
if (!fs.readFileSync(path.join(DEST, 'public', 'app.js'), 'utf8').includes('placeWkPop')) console.warn('WARNING: this Laneboard has no placeWkPop (worker popover flip-up, Zumi patch on 760501b) -- the Board tab loses it; port it upstream or re-apply it.');
