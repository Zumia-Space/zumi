// T-31-ROOM-live-b P1 merge (item 6, CoS decision): the avatar core's code moved life/gaze/pose out of reflex/engine.js, so it must
// join the rig sources the rigVersion hash covers. Asserts (a) every src/renderer/avatar-core/*.js is in the hashed set, (b) the hash
// changes when one of those files changes (tested on a scratch copy; the tree is never touched), (c) the hash is stable otherwise.
//   node scripts/check-rig-sources.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rigSourceFiles, rigSrcHash } from './rig-version.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const core = fs.readdirSync(path.join(ROOT, 'src', 'renderer', 'avatar-core')).filter((f) => f.endsWith('.js')).sort();
assert.ok(core.length >= 3, 'the avatar core has its files');
const hashed = rigSourceFiles(ROOT).map((f) => f.split(path.sep).join('/'));
for (const f of core) assert.ok(hashed.includes(`avatar-core/${f}`), `rigVersion covers avatar-core/${f}`);
for (const f of ['reflex/schema.js', 'reflex/player.js', 'reflex/rig.js', 'reflex/engine.js']) assert.ok(hashed.includes(f), `rigVersion still covers ${f}`);

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-sources-'));
try {
  for (const f of hashed) { fs.mkdirSync(path.dirname(path.join(scratch, 'src', 'renderer', f)), { recursive: true }); fs.copyFileSync(path.join(ROOT, 'src', 'renderer', f), path.join(scratch, 'src', 'renderer', f)); }
  const before = rigSrcHash(scratch);
  assert.equal(before, rigSrcHash(ROOT), 'the scratch copy hashes like the tree');
  assert.equal(before, rigSrcHash(scratch), 'the hash is stable');
  for (const f of core) {
    const p = path.join(scratch, 'src', 'renderer', 'avatar-core', f);
    const original = fs.readFileSync(p);
    fs.appendFileSync(p, '\n// changed\n');
    assert.notEqual(rigSrcHash(scratch), before, `a change in avatar-core/${f} changes the rigVersion`);
    fs.writeFileSync(p, original);
  }
  assert.equal(rigSrcHash(scratch), before, 'restored files hash as before');
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }
console.log(`ALL OK check-rig-sources (${hashed.length} sources, ${core.length} from the avatar core)`);
