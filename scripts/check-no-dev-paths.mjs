// T-31 0.2.11: no packaged code path may resolve an asset outside <resources>/ or app.asar.
// Found while auditing 0.2.10: the default room v1 was read from the owner's material folder (dev box only). Headless, plain Node:
//   node scripts/check-no-dev-paths.mjs
// 1 the real path decision (src/main/room-paths.js, the module main.js uses) lands inside resourcesPath when packaged;
// 2 src/main holds no absolute drive-letter literal at all: the owner's paths live in the owner-only values file;
// 3 package.json stages room-v2 as extraResources (room v1 removed by owner decision 2026-10-26, see check:no-office);
// 4 the afterPack gate re-hashes every staged room asset (sha256) and fails the build on a missing/changed byte.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { ownerPath } from './lib/owner-paths.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); } };
const inside = (p, dir) => { const r = path.relative(path.resolve(dir), path.resolve(p)); return r !== '' && !r.startsWith('..') && !path.isAbsolute(r); };

// ---- 1: runtime decision
const RES = 'X:/fake-app/resources';
let rp = null;
try { rp = require('../src/main/room-paths.js'); } catch (e) { ok(false, 'src/main/room-paths.js loads', e.message); }
if (rp) {
  const base = { env: null, settingsPath: null, resourcesPath: RES };
  const v2 = rp.roomV2DefaultPath({ ...base, isPackaged: true });
  ok(inside(v2, RES), 'packaged default room v2 resolves inside resourcesPath', v2);
  // pinned against the owner values file (roomV2Dir); a tree without it reads the repo's pinned copy
  const devWant = ownerPath('roomV2Dir', null) ? `${ownerPath('roomV2Dir')}/room.json` : path.join(ROOT, 'resources-pinned', 'room-v2', 'room.json');
  ok(rp.roomV2DefaultPath({ ...base, isPackaged: false }) === devWant, 'dev run keeps the dev path for v2', devWant);
  ok(path.resolve(rp.roomV2DefaultPath({ ...base, isPackaged: true, env: 'X:/o/room.json' })) === path.resolve('X:/o/room.json'), 'env override still wins (packaged)');
  ok(path.resolve(rp.roomV2DefaultPath({ ...base, isPackaged: true, settingsPath: 'X:/s/room.json' })) === path.resolve('X:/s/room.json'), 'settings override still wins (packaged)');
}

// ---- 2: literal scan (non-comment lines, quoted drive paths) of src/main: none allowed (the reviewed owner paths of
// audit #4-#6 and the room dev paths moved to the owner-only values file, src/main/owner-values.json)
const ALLOW = [];
const SRC_MAIN = path.join(ROOT, 'src', 'main');
const hits = [];
for (const f of fs.readdirSync(SRC_MAIN).filter((n) => /\.(js|mjs|cjs)$/.test(n))) {
  fs.readFileSync(path.join(SRC_MAIN, f), 'utf8').split('\n').forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
    for (const m of line.matchAll(/(['"`])([A-Za-z]:[\\/][^'"`]*)\1/g)) hits.push({ f, n: i + 1, lit: m[2] });
  });
}
const unreviewed = hits.filter((h) => !ALLOW.some((a) => a.file === h.f && a.re.test(h.lit)));
ok(unreviewed.length === 0, `every absolute drive path literal in src/main is allow-listed (${hits.length} found)`, unreviewed.map((h) => `${h.f}:${h.n} ${h.lit}`).join('; '));
const roomLeak = hits.filter((h) => /_material[\\/]T-31[\\/]room/.test(h.lit) && h.f !== 'room-paths.js');
ok(roomLeak.length === 0, 'room dev paths live only in room-paths.js', roomLeak.map((h) => `${h.f}:${h.n}`).join('; '));

// ---- 3: staging config
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const staged = new Set((pkg.build.extraResources || []).map((e) => `${e.from}=>${e.to}`));
for (const d of ['room-v2']) ok(staged.has(`resources-pinned/${d}=>resources-pinned/${d}`), `package.json build.extraResources stages resources-pinned/${d}`);

// ---- 4: the afterPack gate verifies each staged room asset's sha256
const hook = fs.readFileSync(path.join(ROOT, 'scripts', 'after-pack-default-model.cjs'), 'utf8');
ok(/pinned-rooms\.cjs/.test(hook) && /verifyStagedRooms\s*\(/.test(hook), 'afterPack hook calls verifyStagedRooms from lib/pinned-rooms.cjs');
const owner = fs.readFileSync(path.join(ROOT, 'scripts', 'builder-selftest.cjs'), 'utf8');
ok(/after-pack-default-model\.cjs/.test(owner), 'owner build afterPack reuses the same hook');
let pr = null;
try { pr = require('./lib/pinned-rooms.cjs'); } catch (e) { ok(false, 'scripts/lib/pinned-rooms.cjs loads', e.message); }
if (pr) {
  const tmp = path.join(ROOT, '.no-dev-paths-check-tmp');
  fs.rmSync(tmp, { recursive: true, force: true });
  const mk = (name) => { const out = path.join(tmp, name); fs.cpSync(path.join(ROOT, 'resources-pinned'), path.join(out, 'resources', 'resources-pinned'), { recursive: true }); return out; };
  try {
    const good = mk('good');
    let res = null, err = null;
    try { res = pr.verifyStagedRooms(good); } catch (e) { err = e; }
    ok(!err && res && res.length >= 10, 'gate passes on a faithful copy and reports each verified file', err ? err.message : `${res && res.length} files`);
    ok(res && ['room-v2/room.json', 'room-v2/occluders.glb', 'room-v2/B-talk-plate.png'].every((k) => res.some((r) => r.split(path.sep).join('/').endsWith(k))), 'gate covers v2 room.json, occluders.glb and a v2 plate');
    const flip = mk('flip'); const g = path.join(flip, 'resources', 'resources-pinned', 'room-v2', 'occluders.glb');
    const b = fs.readFileSync(g); b[b.length - 1] ^= 1; fs.writeFileSync(g, b);
    let e1 = null; try { pr.verifyStagedRooms(flip); } catch (e) { e1 = e; }
    ok(e1 && /sha256/.test(e1.message), 'gate throws on a flipped byte in room-v2/occluders.glb', e1 && e1.message);
    const miss = mk('miss'); fs.rmSync(path.join(miss, 'resources', 'resources-pinned', 'room-v2', 'B-work-plate.png'));
    let e2 = null; try { pr.verifyStagedRooms(miss); } catch (e) { e2 = e; }
    ok(e2 && /missing/.test(e2.message), 'gate throws on a missing v2 plate', e2 && e2.message);
    const none = path.join(tmp, 'none'); fs.mkdirSync(path.join(none, 'resources'), { recursive: true });
    let e3 = null; try { pr.verifyStagedRooms(none); } catch (e) { e3 = e; }
    ok(Boolean(e3), 'gate throws when no room was staged at all');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
