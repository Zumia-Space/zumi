// Real 3D chair (T-31 chair3d, concept round 13-10): the GLB chairs the owner can try in place of the talk view's painted
// chair. One manifest (assets/chair3d/chairs.json), one setting (settings.json `chair3d`). 'painted' (PAINTED) is the old
// painted chair, kept as an explicit choice. DEFAULT_CHAIR is what an install with no (or a stale) `chair3d` key gets;
// when that chair's GLB is not listed, the answer falls back to PAINTED.
// A chair is listed only when its GLB is on disk with the manifest's exact size and sha256. The renderer gets app:// URLs.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const PAINTED = 'painted';
// anh's pick pending (14-10): 'mesh-highback' (D) is a placeholder. After his pick this is the ONE line to change, to
// 'armchair-01' (A) | 'mesh-highback' (D) | 'gaming-chair' (E) | 'mesh-office' (F) | PAINTED.
export const DEFAULT_CHAIR = 'mesh-highback';
const ID = /^[a-z0-9][a-z0-9-]{0,40}$/;
const SHA = /^[0-9a-f]{64}$/;
const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
const isPairs = (v) => Array.isArray(v) && v.length > 0 && v.every((p) => Array.isArray(p) && p.length === 2 && p.every(isNum));

/** Schema check of chairs.json. @returns {{ok: boolean, errors: string[]}} -- every problem, not just the first. */
export function checkChairsManifest(m) {
  const errors = [];
  const bad = (msg) => errors.push(msg);
  if (!m || typeof m !== 'object') return { ok: false, errors: ['manifest is not an object'] };
  if (m.version !== 1) bad('version must be 1');
  if (m.view !== 'talk') bad("view must be 'talk'");
  const p = m.noChairPlate;
  if (!p || !/^[\w.-]+\.png$/i.test(p.file || '') || !SHA.test(p.sha256 || '')) bad('noChairPlate must be {file: *.png, sha256}');
  if (!Array.isArray(m.hideOccluders) || !m.hideOccluders.every((n) => typeof n === 'string' && n)) bad('hideOccluders must be a list of occluder names');
  if (!Array.isArray(m.chairs) || !m.chairs.length) { bad('chairs must be a non-empty array'); return { ok: false, errors }; }
  const seen = new Set();
  m.chairs.forEach((c, i) => {
    const at = `chairs[${i}]`;
    if (!c || typeof c !== 'object') { bad(`${at} is not an object`); return; }
    if (!ID.test(c.id || '') || c.id === PAINTED) bad(`${at}.id must be a lowercase slug other than '${PAINTED}'`);
    if (seen.has(c.id)) bad(`${at}.id '${c.id}' is a duplicate`);
    seen.add(c.id);
    if (typeof c.label !== 'string' || !c.label.trim() || c.label.length > 48) bad(`${at}.label must be a short name`);
    if (!/^[\w.-]+\.glb$/i.test(c.file || '')) bad(`${at}.file must be a plain *.glb name`);
    if (!Number.isInteger(c.bytes) || c.bytes <= 0) bad(`${at}.bytes must be a positive integer`);
    if (!SHA.test(c.sha256 || '')) bad(`${at}.sha256 must be 64 hex chars`);
    const s = c.seat;
    if (!s || !isPairs(s.profile) || !isPairs(s.backProfile) || !isNum(s.frontFwd) || !isNum(s.backTopY)) bad(`${at}.seat must carry profile, backProfile, frontFwd, backTopY`);
    if (!isNum(c.reclineDeg) || c.reclineDeg < 0 || c.reclineDeg > 20) bad(`${at}.reclineDeg must be 0..20`);
    if (!c.source || typeof c.source.license !== 'string' || typeof c.source.url !== 'string') bad(`${at}.source must name the url and licence`);
  });
  return { ok: errors.length === 0, errors };
}

/** The pick to use: PAINTED or a stored id that is still listed, else DEFAULT_CHAIR when listed, else PAINTED. Pure. */
export function resolveSelectedChair(stored, availableIds) {
  if (stored === PAINTED || (typeof stored === 'string' && availableIds.includes(stored))) return stored;
  return availableIds.includes(DEFAULT_CHAIR) ? DEFAULT_CHAIR : PAINTED;
}

/**
 * @param manifestPath assets/chair3d/chairs.json (inside app.asar when packaged)
 * @param settings { get, set } -- main.js's own settings.json store
 */
export function createChairs({ manifestPath, settings, log = () => {} }) {
  let manifest = null;
  let manifestError = null;
  try {
    const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const check = checkChairsManifest(m);
    if (check.ok) manifest = m; else manifestError = check.errors.join('; ');
  } catch (e) { manifestError = String((e && e.message) || e); }
  if (manifestError) log(`chairs manifest refused: ${manifestError}`);
  const dir = path.dirname(manifestPath);

  const verified = new Map();
  function fileOk(file, bytes, sha) {
    const full = path.join(dir, file);
    let st;
    try { st = fs.statSync(full); } catch { return null; }
    if (bytes != null && st.size !== bytes) return null;
    const key = `${full}|${st.size}|${st.mtimeMs}`;
    if (!verified.has(key)) verified.set(key, crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex') === sha);
    return verified.get(key) ? full : null;
  }
  const plateOk = () => manifest && fileOk(manifest.noChairPlate.file, null, manifest.noChairPlate.sha256);
  function available() { return manifest && plateOk() ? manifest.chairs.filter((c) => fileOk(c.file, c.bytes, c.sha256)) : []; }

  function list() {
    const chairs = available();
    return {
      selected: resolveSelectedChair(settings.get().chair3d, chairs.map((c) => c.id)),
      noChairPlateUrl: 'app://zumi/chair3d/plate-nochair.png',
      hideOccluders: manifest ? manifest.hideOccluders : [],
      chairs: chairs.map((c) => ({ id: c.id, label: c.label, url: `app://zumi/chair3d/${c.id}.glb`, seat: c.seat, reclineDeg: c.reclineDeg, look: c.look || {} })),
      error: manifestError,
    };
  }

  /** Persists `id` when it is 'painted' or a listed chair; anything else is ignored (the old pick stays). */
  function select(id) {
    if (id === PAINTED || available().some((c) => c.id === id)) settings.set({ chair3d: id });
    return list();
  }

  /** app://zumi/chair3d/<id>.glb | plate-nochair.png -> absolute path, or null (exact names only). */
  function resolvePath(rel) {
    if (!manifest) return null;
    if (rel === 'plate-nochair.png') return plateOk();
    const m = /^([a-z0-9-]+)\.glb$/.exec(rel);
    const c = m && manifest.chairs.find((x) => x.id === m[1]);
    return c ? fileOk(c.file, c.bytes, c.sha256) : null;
  }

  return { list, select, resolvePath };
}
