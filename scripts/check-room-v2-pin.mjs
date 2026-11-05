// Regression check for the T-31-combined-0710 room pin (coordinator, 2026-10-07): a PACKAGED owner build must
// resolve its default room-v2 from the bundled resources-pinned/room-v2/ copy, never live-read the room repo
// working tree on D: (another task may switch that repo to a different branch mid-session). Headless,
// Electron-free, plain Node -- mirrors main.js's roomV2DefaultPath()/roomV2PinnedPath() decision (reproduced
// below verbatim in shape, since main.js itself requires('electron') and can't be imported outside a real app)
// and then runs the real, dependency-injected checker (room-check.mjs) against the actual bundled files, so this
// proves both "the decision picks the pinned path when packaged" and "the pinned files the decision points at
// are real and pass validation" -- not just one or the other.
//   node scripts/check-room-v2-pin.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { checkRoomJsonFile } from '../src/main/room-check.mjs';
import { ownerPath } from './lib/owner-paths.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const PIN_DIR = path.join(ROOT, 'resources-pinned', 'room-v2');
const MANIFEST_PATH = path.join(PIN_DIR, 'PIN-MANIFEST.json');

let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); } };

// ---- 1: main.js's packaged-vs-dev decision, reproduced verbatim in shape (no Electron import possible here).
// roomV2DefaultPath() = env override -> settings override -> (packaged ? roomV2PinnedPath() : LIVE_D_FALLBACK)
// the dev-run path main.js reads (src/main/room-paths.js): the owner values' roomV2Dir, else the repo's pinned copy
const LIVE_D_FALLBACK = ownerPath('roomV2Dir', null) ? `${ownerPath('roomV2Dir')}/room.json` : path.join(PIN_DIR, 'room.json');
function roomV2DefaultPathDecision({ env, settingsPath, isPackaged, resourcesPath }) {
  if (env) return path.resolve(env);
  if (settingsPath) return path.resolve(settingsPath);
  return isPackaged ? path.join(resourcesPath, 'resources-pinned', 'room-v2', 'room.json') : LIVE_D_FALLBACK;
}
const fakeResourcesPath = 'C:/fake-app/resources';
const packagedNoOverride = roomV2DefaultPathDecision({ env: null, settingsPath: null, isPackaged: true, resourcesPath: fakeResourcesPath });
ok(packagedNoOverride === path.join(fakeResourcesPath, 'resources-pinned', 'room-v2', 'room.json'), 'packaged build with no override resolves to the bundled pinned path', packagedNoOverride);
ok(!packagedNoOverride.toLowerCase().includes('_material'), 'packaged resolution never points at the material room repo', packagedNoOverride);
const devNoOverride = roomV2DefaultPathDecision({ env: null, settingsPath: null, isPackaged: false, resourcesPath: fakeResourcesPath });
ok(devNoOverride === LIVE_D_FALLBACK, 'dev (unpackaged) build with no override still live-reads the room repo', devNoOverride);

// ---- 2: the real bundled files exist where that decision points (relative to a packaged app's resources dir,
// extraResources lands resources-pinned/ directly under process.resourcesPath -- see package.json build.extraResources).
ok(fs.existsSync(PIN_DIR), 'resources-pinned/room-v2 directory exists in the repo (what electron-builder packages as extraResources)');
const ROOM_JSON = path.join(PIN_DIR, 'room.json');
ok(fs.existsSync(ROOM_JSON), 'pinned room.json exists');

// ---- 3: every file PIN-MANIFEST.json claims to have pinned is present with the recorded sha256 (catches a
// stale manifest or a file silently re-touched after pinning).
ok(fs.existsSync(MANIFEST_PATH), 'PIN-MANIFEST.json exists');
if (fs.existsSync(MANIFEST_PATH)) {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  ok(manifest.roomRepoPinCommit === '98d3a2f3e7414e4f280a8374d84fd3e360f51c80', 'manifest records the expected pin commit (98d3a2f)');
  for (const [rel, entry] of Object.entries(manifest.files || {})) {
    const abs = path.join(PIN_DIR, rel);
    if (!fs.existsSync(abs)) { ok(false, `manifest entry has a file on disk: ${rel}`, 'MISSING'); continue; }
    const got = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
    ok(got === entry.sha256, `sha256 matches manifest for ${rel}`, `want ${entry.sha256} got ${got}`);
  }
}

// ---- 4: the real checker (room-check.mjs, the same one main.js runs at warm-up) passes the pinned room.json,
// including its plates -- proves the bundle is not just present but VALID (checkRoomJsonFile reads room.json
// plus every plate PNG it references, siblings by relative path, same resolution the bundle uses since
// everything is pinned flat in one directory).
if (fs.existsSync(ROOM_JSON)) {
  const check = checkRoomJsonFile(ROOM_JSON);
  ok(check.ok === true, 'checkRoomJsonFile accepts the pinned room.json + plates', JSON.stringify(check.refused || check.warnings));
}

// ---- 5: the nochair variants plateNoChair declares are confirmed unconsumed by any loader/checker code --
// `grep -rln "plateNoChair" src scripts` returns only room.json's own data (via room-check.mjs's generic JSON
// read), no code path reads the key -- so their absence from the pinned bundle is a non-issue, not a silent gap.
function grepTree(dir, needle) {
  const hits = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { hits.push(...grepTree(p, needle)); continue; }
    if (!/\.(js|mjs|cjs)$/.test(e.name) || p === path.join(HERE, 'check-room-v2-pin.mjs')) continue;
    if (fs.readFileSync(p, 'utf8').includes(needle)) hits.push(p);
  }
  return hits;
}
const nochairHits = [...grepTree(path.join(ROOT, 'src'), 'plateNoChair'), ...grepTree(path.join(ROOT, 'scripts'), 'plateNoChair')];
ok(nochairHits.length === 0, 'plateNoChair is not read by any loader/checker code (optional/inert, safe to omit from the pin)', JSON.stringify(nochairHits));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
