// Default-room-v2 validation + copy-on-success (T-31 camera modes, coordinator final ruling 03-10: "make v2-B
// the bundled default room the same way the current default is handled -- copied by sha into Zumi-data,
// room-check validated"). Mirrors room-default.mjs's v1 pattern exactly (same reasoning: the install waits on
// this; a bad re-export at Vesta's own live path can't change what the owner sees until it passes the checker
// again) -- a SEPARATE module, not a shared abstraction with v1, because v1 copies exactly one file (room.glb)
// while v2 copies a JSON plus a variable set of assets it references (occluders.glb, N plate images), and
// forcing those two shapes through one function would cost more than the few lines of overlap save.
//
// Pure, dependency-injected, Electron-free (importable from plain Node, same as room-default.mjs).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { checkRoomJsonFile, roomContentId } from './room-check.mjs';

/** A fresh, empty cache -- one instance per app lifetime (main.js) or per test case. */
export function createDefaultRoomV2Cache() { return { entry: null }; }

/** Runs the v2 checker on `jsonPath`, skipping the (re)run when the file's size+mtime match the cached entry
 *  (same cache-key granularity as v1 -- a plate-only edit with room.json untouched is not detected; Vesta's own
 *  pipeline regenerates room.json alongside new plates, same precedent v1 already accepts for its one file). */
export function checkDefaultRoomV2Cached(cache, jsonPath) {
  let stat;
  try { stat = fs.statSync(jsonPath); }
  catch { return { ok: false, refused: { code: 'not_a_room_json', params: {} }, warnings: [], sha: null, cacheHit: false, ms: 0 }; }
  const e = cache.entry;
  if (e && e.path === jsonPath && e.size === stat.size && e.mtimeMs === stat.mtimeMs) return { ...e.result, cacheHit: true, ms: 0 };
  const t0 = Date.now();
  const check = checkRoomJsonFile(jsonPath);
  const sha = check.ok ? roomContentId(fs.readFileSync(jsonPath)) : null;
  const result = { ok: check.ok, refused: check.refused, warnings: check.warnings || [], sha };
  const ms = Date.now() - t0;
  cache.entry = { path: jsonPath, size: stat.size, mtimeMs: stat.mtimeMs, result };
  return { ...result, cacheHit: false, ms };
}

/** Finds an asset room.json references (occluders.glb, a plate) -- first beside room.json, then one directory
 *  up. Vesta's real, FINAL v2-B room ships room.json in out/ but its plates one level up (confirmed, pinned
 *  shas, coordinator 2026-10-03); this does not assume a future room uses the same layout, it just tries both,
 *  nearest first, and preserves whatever relative path (incl. a subfolder, e.g. "plates/talk.png") room.json
 *  itself gives when writing the copy -- so the copy's own room.json (served byte-for-byte, unmodified) still
 *  resolves correctly against it. */
function resolveAssetSource(jsonDir, relPath) {
  const near = path.join(jsonDir, relPath);
  if (fs.existsSync(near)) return near;
  const up = path.join(jsonDir, '..', relPath);
  if (fs.existsSync(up)) return up;
  return null;
}

const PIN_MANIFEST = 'PIN-MANIFEST.json';
const sha256Of = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
/**
 * The official Night City files, keyed by the official room.json's sha256: name -> sha256. The official build strips
 * PIN-MANIFEST.json (tauri/flavour-stage.mjs), so this table is its pin. Equal to resources-pinned/room-v2/PIN-MANIFEST.json
 * and to the 0.3.4 install (update-smoke-035 install-034.sha.txt); check:room-packs keeps it equal to the manifest.
 */
export const OFFICIAL_ROOM_V2 = Object.freeze({
  '5dfa1996c8e98ebe9d84f4a0b5d204f31302f77c00d276b9bbeb548daeaf8385': Object.freeze({
    'room.json': '5dfa1996c8e98ebe9d84f4a0b5d204f31302f77c00d276b9bbeb548daeaf8385',
    'occluders.glb': '271630a668863e2812dc4310e6c473257cd13981376b965ab74840e4622188ea',
    'occluders.stats.json': '1f8b39e279e58ef2e68df4afd1f0cc08baef1df7133b0f04fe804685accf1141',
    'occluders.validation.json': 'bcaac4d8c7255a4ca63d54314abf23304d82945bb2dc3b471fca02f08cddbcaf',
    'layout.json': 'ba4be75c45e7096d73fcffcd89ae807f84f4366a9010c9b9559f986df644705d',
    'pose-measure.json': '101d9a680095ea1e7f21b064b18bae1bde8ffe428d4faf1a9c2141a2745a5fd2',
    'seat-check.json': 'a27a352d29fb411b201afe9fe688a27f7a2f6810eca5b5ec43967011ac7e406f',
    'legacy/props-visible.glb': 'f2e663ae35163f1d5c03e066e7f3ccc065378d661c244ca0442d7eb1094a5315',
    'B-room-plate.png': 'c5878aa2ac04e71df3589671a9e3b3fe1b629783d490fae295a4e1d82fdf0256',
    'B-talk-plate.png': '1d48a5e0608e9b953a92a0aa9b7e47d5ec8bdc15ee8057449d8300b708b3953d',
    'B-work-plate.png': 'a696e603b97735e927659063b3e565ce84b2371c74368261587c6a23efec8bf6',
  }),
});
/** The model and every plate room.json names. */
function referencedAssets(json) {
  const assets = new Set();
  if (typeof json.model === 'string' && json.model) assets.add(json.model);
  for (const v of Object.values(json.views || {})) { if (v && typeof v.plate === 'string' && v.plate) assets.add(v.plate); }
  return assets;
}

/**
 * Is the room at `jsonPath` usable as the v2 default room? The room check passes, the model and every plate it names
 * resolve; when room.json is the official one (OFFICIAL_ROOM_V2) every file it names has its official sha256; and where a
 * PIN-MANIFEST.json sits beside it (owner builds; the official build drops it) every pinned file has its sha256. One answer for the loader (ensureDefaultRoomV2Copy copies only a usable room) and the Marketplace's "Built-in".
 * Cached per (path, size, mtime) of room.json, every asset and the manifest, so a repeat ask costs stats only.
 * @returns {{ ok: boolean, refused: object|null, check: object }}
 */
export function defaultRoomV2Usable(cache, jsonPath) {
  const check = checkDefaultRoomV2Cached(cache, jsonPath);
  if (!check.ok) return { ok: false, refused: check.refused, check };
  const jsonDir = path.dirname(jsonPath);
  let json;
  try { json = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); } catch { return { ok: false, refused: { code: 'not_a_room_json', params: {} }, check }; }
  // Every pin to hold: [file, rel, sha256]. The official room.json (by its sha) pins every file it names to the official bytes;
  // a PIN-MANIFEST.json beside it pins what it lists. An unknown room.json without a manifest (an owner dev room) is structural only.
  const official = OFFICIAL_ROOM_V2[sha256Of(jsonPath)] || null;
  const pins = [];
  const files = [];
  for (const rel of referencedAssets(json)) {
    const src = resolveAssetSource(jsonDir, rel);
    if (!src) return { ok: false, refused: { code: 'asset_missing', params: { file: rel } }, check };
    files.push(src);
    if (official) pins.push([src, rel, official[rel] || null]);
  }
  const manifestPath = path.join(jsonDir, PIN_MANIFEST);
  if (fs.existsSync(manifestPath)) {
    let listed;
    try { listed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).files || {}; } catch { return { ok: false, refused: { code: 'pin_unreadable', params: {} }, check }; }
    files.push(manifestPath);
    for (const [rel, pin] of Object.entries(listed)) { const f = path.join(jsonDir, rel); files.push(f); pins.push([f, rel, (pin && pin.sha256) || null]); }
  }
  const stamp = (f) => { try { const st = fs.statSync(f); return `${f}|${st.size}|${st.mtimeMs}`; } catch { return `${f}|-`; } };
  const key = [jsonPath, ...files].map(stamp).join('|');
  if (cache.usable && cache.usable.key === key) return { ...cache.usable.result, check };
  let result = { ok: true, refused: null };
  for (const [f, rel, want] of pins) {
    if (!want || !fs.existsSync(f) || sha256Of(f) !== want) { result = { ok: false, refused: { code: 'pin_mismatch', params: { file: rel } } }; break; }
  }
  cache.usable = { key, result };
  return { ...result, check };
}

/**
 * Ensures userData holds a validated copy of the CURRENT v2 default-room source, reusing the last good copy
 * when the source is unchanged (same sha) or has gone bad since. Same "keep serving the last good copy on
 * failure" posture as v1's ensureDefaultRoomCopy.
 * @param storeDir (sha) => absolute folder for that content hash, e.g. <userData>/rooms/default-v2/<sha>
 * @param settings { get(): {defaultRoomV2GoodSha, ...}, set(patch): void } -- same shape as main.js's load/saveSettings
 * @returns {{ sha: string|null, refused: object|null, cacheHit, ms }}
 */
export function ensureDefaultRoomV2Copy(cache, jsonPath, storeDir, settings) {
  const usable = defaultRoomV2Usable(cache, jsonPath);
  const check = usable.check;
  const goodSha = settings.get().defaultRoomV2GoodSha || null;
  if (usable.ok && check.sha && check.sha !== goodSha) {
    const jsonDir = path.dirname(jsonPath);
    const json = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const dest = storeDir(check.sha);
    fs.mkdirSync(dest, { recursive: true });
    fs.copyFileSync(jsonPath, path.join(dest, 'room.json')); // byte-for-byte, same as v1's room.glb copy -- never re-serialized
    for (const relPath of referencedAssets(json)) {
      const src = resolveAssetSource(jsonDir, relPath); // every one resolves: defaultRoomV2Usable checked it
      const destFile = path.join(dest, relPath);
      fs.mkdirSync(path.dirname(destFile), { recursive: true });
      fs.copyFileSync(src, destFile);
    }
    settings.set({ defaultRoomV2GoodSha: check.sha });
    return { sha: check.sha, refused: null, cacheHit: check.cacheHit, ms: check.ms };
  }
  return { sha: goodSha, refused: usable.ok ? null : usable.refused, cacheHit: check.cacheHit, ms: check.ms };
}
