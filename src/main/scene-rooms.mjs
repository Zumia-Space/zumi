// Video rooms (T-31 room picker, 13-10): the looping room videos the owner can pick instead of the talk view's
// painted plate. One manifest (assets/rooms-video/rooms.json) holds every room's file, hash and framing; one setting
// (settings.json `sceneRoom`) holds the pick. 'current' -- the approved painted room, no video -- is the default and
// the answer for anything unknown, so nothing changes for a user until they pick a room.
// The main process owns the files: a room is listed only when its video is on disk with the manifest's exact size
// and sha256 (a release build ships no videos, so it lists none). The renderer only ever gets app:// URLs.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DEFAULT_SCENE = 'current';
const ID = /^[a-z0-9][a-z0-9-]{0,40}$/;
const FILE = /^[\w.-]+\.mp4$/i;
const SHA = /^[0-9a-f]{64}$/;
const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
const isPair = (v) => Array.isArray(v) && v.length === 2 && v.every(isNum);

/** Schema check of rooms.json. @returns {{ok: boolean, errors: string[]}} -- every problem, not just the first. */
export function checkScenesManifest(m) {
  const errors = [];
  const bad = (msg) => errors.push(msg);
  if (!m || typeof m !== 'object') return { ok: false, errors: ['manifest is not an object'] };
  if (m.version !== 1) bad('version must be 1');
  if (m.view !== 'talk') bad("view must be 'talk' (the only view the videos were made for)");
  for (const k of ['plateSize', 'videoSize', 'identity', 'pivot']) if (!isPair(m[k])) bad(`${k} must be [number, number]`);
  if (typeof m.packagedDir !== 'string' || !/^[\w-]+$/.test(m.packagedDir)) bad('packagedDir must be a plain folder name');
  if (m.localDir != null && typeof m.localDir !== 'string') bad('localDir must be a string');
  const c = m.chair;
  if (!c || typeof c.file !== 'string' || !/^[\w.-]+\.png$/i.test(c.file) || !isNum(c.x) || !isNum(c.y) || !SHA.test(c.sha256 || '')) bad('chair must be {file: *.png, x, y, sha256}');
  if (!Array.isArray(m.rooms) || !m.rooms.length) { bad('rooms must be a non-empty array'); return { ok: false, errors }; }
  if (m.default != null && !(typeof m.default === 'string' && m.rooms.some((r) => r && r.id === m.default))) bad('default must be the id of one of the rooms');
  const seen = new Set();
  m.rooms.forEach((r, i) => {
    const at = `rooms[${i}]`;
    if (!r || typeof r !== 'object') { bad(`${at} is not an object`); return; }
    if (!ID.test(r.id || '') || r.id === DEFAULT_SCENE) bad(`${at}.id must be a lowercase slug other than '${DEFAULT_SCENE}'`);
    if (seen.has(r.id)) bad(`${at}.id '${r.id}' is a duplicate`);
    seen.add(r.id);
    if (typeof r.label !== 'string' || !r.label.trim() || r.label.length > 40) bad(`${at}.label must be a short name`);
    if (!FILE.test(r.file || '')) bad(`${at}.file must be a plain *.mp4 name`);
    if (!Number.isInteger(r.bytes) || r.bytes <= 0) bad(`${at}.bytes must be a positive integer`);
    if (!SHA.test(r.sha256 || '')) bad(`${at}.sha256 must be 64 hex chars`);
    if (!isNum(r.seconds) || r.seconds <= 0) bad(`${at}.seconds must be > 0`);
    const f = r.framing;
    if (!f || !isNum(f.scale) || f.scale < 1 || f.scale > 2 || !isNum(f.offsetX) || !isNum(f.offsetY)) bad(`${at}.framing must be {scale 1..2, offsetX, offsetY}`);
    if (!['ok', 'needs-regeneration'].includes(r.status)) bad(`${at}.status must be 'ok' or 'needs-regeneration'`);
  });
  return { ok: errors.length === 0, errors };
}

/**
 * The pick to use. Pure (unit-tested). An explicit 'current' pick stays; a stored id that is still listed wins; else the manifest's
 * `default` room when it is listed (the start room of a fresh install); else 'current'.
 */
export function resolveSelectedScene(stored, availableIds, defaultId = null) {
  if (stored === DEFAULT_SCENE) return DEFAULT_SCENE;
  if (typeof stored === 'string' && availableIds.includes(stored)) return stored;
  return typeof defaultId === 'string' && availableIds.includes(defaultId) ? defaultId : DEFAULT_SCENE;
}

/**
 * @param manifestPath assets/rooms-video/rooms.json (inside app.asar when packaged)
 * @param resolveVideoDir (manifest) => the folder holding the .mp4 files (main.js decides: env, packaged resources, or
 *   manifest.localDir) -- null = no videos on this machine
 * @param settings { get: () => settings object, set: (patch) => void } -- main.js's own settings.json store
 * @param packVideoDir (id) => the folder of an installed room pack for that room (T-31-ROOM-slim: <data>/packs/room.<id>), or
 *   null. Asked only when the video is not in the build's own folder; the pin (size + sha256 from rooms.json) is the same.
 */
export function createSceneRooms({ manifestPath, resolveVideoDir, packVideoDir = () => null, settings, log = () => {} }) {
  let manifest = null;
  let manifestError = null;
  try {
    const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const check = checkScenesManifest(m);
    if (check.ok) manifest = m; else manifestError = check.errors.join('; ');
  } catch (e) { manifestError = String((e && e.message) || e); }
  if (manifestError) log(`rooms manifest refused: ${manifestError}`);
  const chairPath = manifest ? path.join(path.dirname(manifestPath), manifest.chair.file) : null;
  const videoDir = manifest ? resolveVideoDir(manifest) : null;

  // sha256 of a 2-7 MB file costs a few ms; cached per (path, size, mtime) so repeat lists are free.
  const verified = new Map();
  function pinned(full, r) {
    let st;
    try { st = fs.statSync(full); } catch { return null; }
    if (!st.isFile() || st.size !== r.bytes) return null;
    const key = `${full}|${st.size}|${st.mtimeMs}`;
    if (!verified.has(key)) verified.set(key, crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex') === r.sha256);
    return verified.get(key) ? full : null;
  }
  // The build's own folder first (an owner build, or an older install that still holds the videos), then the room's pack.
  function fileOk(r) {
    const own = videoDir ? pinned(path.join(videoDir, r.file), r) : null;
    if (own) return own;
    const pack = packVideoDir(r.id);
    return pack ? pinned(path.join(pack, r.file), r) : null;
  }

  function available() { return manifest ? manifest.rooms.filter((r) => fileOk(r)) : []; }

  function list() {
    const rooms = available();
    const selected = resolveSelectedScene(settings.get().sceneRoom, rooms.map((r) => r.id), manifest ? manifest.default : null);
    return {
      selected,
      geometry: manifest ? { plateSize: manifest.plateSize, videoSize: manifest.videoSize, identity: manifest.identity, pivot: manifest.pivot, chair: { url: 'app://zumi/scenes/chair', x: manifest.chair.x, y: manifest.chair.y } } : null,
      rooms: rooms.map((r) => ({ id: r.id, label: r.label, status: r.status, url: `app://zumi/scenes/${r.id}.mp4`, framing: r.framing })),
      error: manifestError,
    };
  }

  /** Persists `id` when it is 'current' or a listed room; anything else is ignored (the old pick stays). */
  function select(id) {
    if (id === DEFAULT_SCENE || available().some((r) => r.id === id)) settings.set({ sceneRoom: id });
    return list();
  }

  /** app://zumi/scenes/<id>.mp4 | app://zumi/scenes/chair -> absolute path, or null (exact names only). */
  function resolvePath(rel) {
    if (!manifest) return null;
    if (rel === 'chair') return chairPath;
    const m = /^([a-z0-9-]+)\.mp4$/.exec(rel);
    const r = m && manifest.rooms.find((x) => x.id === m[1]);
    return r ? fileOk(r) : null;
  }

  return { list, select, resolvePath };
}
