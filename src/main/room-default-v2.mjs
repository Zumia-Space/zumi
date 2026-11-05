// Default-room-v2 validation + copy-on-success (T-31 camera modes, coordinator final ruling 03-10: "make v2-B
// the bundled default room the same way the current default is handled -- copied by sha into Zumi-data,
// room-check validated"). Mirrors room-default.mjs's v1 pattern exactly (same reasoning: the install waits on
// this; a bad re-export at Vesta's own live path can't change what the owner sees until it passes the checker
// again) -- a SEPARATE module, not a shared abstraction with v1, because v1 copies exactly one file (room.glb)
// while v2 copies a JSON plus a variable set of assets it references (occluders.glb, N plate images), and
// forcing those two shapes through one function would cost more than the few lines of overlap save.
//
// Pure, dependency-injected, Electron-free (importable from plain Node, same as room-default.mjs).
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

/**
 * Ensures userData holds a validated copy of the CURRENT v2 default-room source, reusing the last good copy
 * when the source is unchanged (same sha) or has gone bad since. Same "keep serving the last good copy on
 * failure" posture as v1's ensureDefaultRoomCopy.
 * @param storeDir (sha) => absolute folder for that content hash, e.g. <userData>/rooms/default-v2/<sha>
 * @param settings { get(): {defaultRoomV2GoodSha, ...}, set(patch): void } -- same shape as main.js's load/saveSettings
 * @returns {{ sha: string|null, refused: object|null, cacheHit, ms }}
 */
export function ensureDefaultRoomV2Copy(cache, jsonPath, storeDir, settings) {
  const check = checkDefaultRoomV2Cached(cache, jsonPath);
  const goodSha = settings.get().defaultRoomV2GoodSha || null;
  if (check.ok && check.sha && check.sha !== goodSha) {
    const jsonDir = path.dirname(jsonPath);
    const json = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const dest = storeDir(check.sha);
    fs.mkdirSync(dest, { recursive: true });
    fs.copyFileSync(jsonPath, path.join(dest, 'room.json')); // byte-for-byte, same as v1's room.glb copy -- never re-serialized
    const assets = new Set();
    if (typeof json.model === 'string' && json.model) assets.add(json.model);
    for (const v of Object.values(json.views || {})) { if (v && typeof v.plate === 'string' && v.plate) assets.add(v.plate); }
    for (const relPath of assets) {
      const src = resolveAssetSource(jsonDir, relPath);
      if (!src) { console.warn('[room-default-v2] referenced asset not found, skipped:', relPath); continue; }
      const destFile = path.join(dest, relPath);
      fs.mkdirSync(path.dirname(destFile), { recursive: true });
      fs.copyFileSync(src, destFile);
    }
    settings.set({ defaultRoomV2GoodSha: check.sha });
    return { sha: check.sha, refused: null, cacheHit: check.cacheHit, ms: check.ms };
  }
  return { sha: goodSha, refused: check.ok ? null : check.refused, cacheHit: check.cacheHit, ms: check.ms };
}
