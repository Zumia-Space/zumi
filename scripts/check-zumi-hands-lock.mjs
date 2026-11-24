// T-31-MAUS rule 3.7 (no new crate): every registry package in tauri/zumi-hands/Cargo.lock must already be in
// tauri/src-tauri/Cargo.lock with the same version and checksum. Exit 0 = subset, 1 = a crate or version is new.
// Usage: node scripts/check-zumi-hands-lock.mjs [handsLock] [appLock]   (paths default to the two in-tree locks)
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const handsLock = process.argv[2] ?? join(root, 'tauri/zumi-hands/Cargo.lock');
const appLock = process.argv[3] ?? join(root, 'tauri/src-tauri/Cargo.lock');

function registryPackages(path) {
  const out = new Map();
  for (const block of readFileSync(path, 'utf8').split('[[package]]').slice(1)) {
    const field = (k) => block.match(new RegExp(`^${k} = "([^"]*)"`, 'm'))?.[1];
    if (!field('source')) continue; // the root package itself has no source
    out.set(`${field('name')}@${field('version')}`, field('checksum'));
  }
  return out;
}

const hands = registryPackages(handsLock);
const app = registryPackages(appLock);
const bad = [...hands].filter(([key, sum]) => app.get(key) !== sum).map(([key]) => key);
if (bad.length) {
  console.error(`NEW or changed crates (not in ${appLock}): ${bad.join(', ')}`);
  process.exit(1);
}
console.log(`ok: ${hands.size} registry packages in zumi-hands lock, all present in the app lock with equal checksums`);
