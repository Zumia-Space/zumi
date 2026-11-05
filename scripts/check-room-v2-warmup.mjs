// Regression check for the T-31 room-v2-load-hang fix (main.js: defaultRoomV2Ready/getDefaultRoomV2, 2026-10-07).
// Headless, Electron-free, plain Node -- room-default-v2.mjs is dependency-injected on purpose (its own header:
// "importable from plain Node") exactly so this can run without ever launching the app.
//
// Root cause this guards against: ensureDefaultRoomV2Copy is a SYNCHRONOUS read+sha256+copy over the whole v2-B
// asset set (room.json + plates + occluders.glb, ~10MB on the real room). main.js used to call it straight from
// listRooms() (awaited by the renderer's own bootstrap, before the model dropdown/loading UI even paints) AND
// from resolveAppPath() for every app:// request under rooms/default-v2/* -- room.json, each plate, occluders.glb,
// all requested together. Before the cache warmed, each concurrent caller independently redid the full expensive
// work (the cache entry isn't set until the first one finishes) -- confirmed on a spare-PC repro to hang first
// paint intermittently (room='none' never hung across repeated launches on the same hardware; room=default-v2
// did). The fix: run the checker+copy exactly ONCE, off the hot path, and have every caller await that SAME
// promise. This script proves the OLD pattern pays the cost N times (A), the FIX pattern pays it once and every
// later call is a cache hit (B), and concurrent callers against the shared warm-up promise coalesce onto one run
// instead of each starting their own (C) -- the exact shape of defaultRoomV2Ready/getDefaultRoomV2 in main.js.
//   node scripts/check-room-v2-warmup.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDefaultRoomV2Copy, createDefaultRoomV2Cache } from '../src/main/room-default-v2.mjs';
import { ownerPath } from './lib/owner-paths.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The real room B (same path main.js's ROOM_V2_DEFAULT_PATH_FALLBACK points at); falls back to the stand-in
// generator's output so this still runs on a machine that never pulled Vesta's real asset.
const CANDIDATES = [`${ownerPath('roomV2Dir', 'local/room-v2')}/room.json`, `${ownerPath('standinRoom', 'local/standin-room-v2')}/room.json`];
const ROOM_JSON = CANDIDATES.find((p) => fs.existsSync(p));

let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); } };

function makeSettings() {
  let store = {};
  return { get: () => store, set: (patch) => { store = { ...store, ...patch }; } };
}
function tmpStoreDir() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zumi-roomv2-warmup-'));
  return (sha) => path.join(base, sha);
}

if (!ROOM_JSON) {
  console.log(`SKIP A/B: no room.json found at any of ${CANDIDATES.join(' or ')} -- run scripts/gen-standin-room-v2.mjs first, or run this on a machine with Vesta's real room.`);
} else {
  // ---- A: the BUG pattern -- N callers, no shared warm-up (a fresh cache each time, same as calling
  // ensureDefaultRoomV2CopyFn directly on every request before any of them has set the cache). Every one must
  // redo the full check+copy: this is WHY N concurrent first-paint requests used to pay the ~10MB cost N times.
  const bugResults = [];
  for (let i = 0; i < 4; i++) {
    const cache = createDefaultRoomV2Cache();
    bugResults.push(ensureDefaultRoomV2Copy(cache, ROOM_JSON, tmpStoreDir(), makeSettings()));
  }
  ok(bugResults.every((r) => r.sha && !r.cacheHit), 'bug pattern: every uncached caller redoes the full check+copy', JSON.stringify(bugResults.map((r) => r.cacheHit)));

  // ---- B: the FIX pattern -- ONE shared cache warmed once; every later call on that SAME cache must be a hit.
  // This is the invariant getDefaultRoomV2 in main.js depends on: after the one startup warm-up, every
  // rooms:list()/app:// call is a cheap stat-and-compare, never a re-read/re-hash/re-copy.
  const settings = makeSettings();
  const store = tmpStoreDir();
  const cache = createDefaultRoomV2Cache();
  const first = ensureDefaultRoomV2Copy(cache, ROOM_JSON, store, settings);
  ok(Boolean(first.sha) && !first.cacheHit, 'fix pattern: first (warm-up) call does the real work', JSON.stringify(first));
  const repeats = [1, 2, 3, 4].map(() => ensureDefaultRoomV2Copy(cache, ROOM_JSON, store, settings));
  ok(repeats.every((r) => r.sha === first.sha && r.cacheHit), 'fix pattern: every call after warm-up is a cache hit', JSON.stringify(repeats.map((r) => r.cacheHit)));
}

// ---- C: promise coalescing -- the exact shape of `defaultRoomV2Ready = Promise.resolve().then(() =>
// ensureDefaultRoomV2CopyFn(...))` + `getDefaultRoomV2()` in main.js. N callers that all fire before the warm-up
// promise has settled must trigger the expensive function exactly ONCE. No real room asset needed -- this is
// pure promise-identity logic, so it always runs, even without ROOM_JSON.
{
  let calls = 0;
  const slowExpensiveChecker = () => new Promise((resolve) => {
    calls++;
    setTimeout(() => resolve({ sha: 'deadbeefcafe', refused: null, cacheHit: false, ms: 5 }), 30);
  });
  const defaultRoomV2Ready = Promise.resolve().then(() => slowExpensiveChecker());
  const getDefaultRoomV2 = () => defaultRoomV2Ready; // packaged-build branch of main.js's real function
  const concurrent = await Promise.all([getDefaultRoomV2(), getDefaultRoomV2(), getDefaultRoomV2(), getDefaultRoomV2()]);
  ok(calls === 1, 'fix pattern: 4 concurrent callers coalesce onto ONE run of the expensive checker', `calls=${calls}`);
  ok(concurrent.every((r) => r.sha === 'deadbeefcafe'), 'fix pattern: every concurrent caller resolves to the same result');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
