// T-31 parity step 6-pre (F5): the build-flavour file. Gate: GATE-6pre.md item 2 (Fable, GO-WITH-CONDITIONS).
//
// Electron reads five flags from the packaged package.json (scripts/builder-selftest.cjs extraMetadata). The preview has
// no package.json, so a build writes `flavour.json` BESIDE THE HOST EXE and Rust passes its path as `--flavour <abs>`.
// This file is the only switch for cloud, Jev egress, owner paths and the board mirror, so it is read fail-closed:
//  1. `public` writes NO file. Absence is the only public form (a file carrying only public values is ignored too).
//  2. FLAVOURS.owner / FLAVOURS.selftest are pinned byte-equal to builder-selftest.cjs by scripts/check-tauri-flavour.mjs.
//  3. The resolved flavour is logged once at start, and the reason whenever a file was ignored. Never silent.
//  4. Step 7 gate: the signed release bundle contains no flavour.json (docs/migration/PARITY-PLAN.md step 7).
//  5. cloudBase / boardMirror: https, or http on loopback, origin only. Any unknown key, wrong type or bad URL
//     ignores the WHOLE file (public flavour).
// The data dir is never consulted: the only path read is `--flavour`, and its parent must be `--host-dir`.
import fs from 'node:fs';
import path from 'node:path';

export const FLAVOUR_FILE = 'flavour.json';
export const FLAVOUR_VERSION = 1;
const MAX_FLAVOUR_BYTES = 4096;
const KEYS = ['v', 'cloudBase', 'test', 'reflexEgress', 'ownerAdmin', 'boardMirror'];

// Key order is the on-disk order (the pin test compares the serialized text).
const OWNER_VALUES = { cloudBase: 'https://dev.zumia.space', test: true, reflexEgress: true, ownerAdmin: true, boardMirror: 'http://127.0.0.1:3100' };
export const FLAVOURS = Object.freeze({
  public: Object.freeze({ cloudBase: null, test: false, reflexEgress: false, ownerAdmin: false, boardMirror: null }),
  // The official installer: the public code and values. Only its assets differ (scripts/lib/zumi-only.cjs).
  official: Object.freeze({ cloudBase: null, test: false, reflexEgress: false, ownerAdmin: false, boardMirror: null }),
  selftest: Object.freeze({ ...OWNER_VALUES }),
  owner: Object.freeze({ ...OWNER_VALUES }),
});

/** The text a build writes for `name`, or null for `public` and `official` (no file). Throws on an unknown name. */
export function flavourFileText(name) {
  if (!Object.prototype.hasOwnProperty.call(FLAVOURS, name)) throw new Error(`unknown flavour: ${name}`);
  return name === 'public' || name === 'official' ? null : `${JSON.stringify({ v: FLAVOUR_VERSION, ...FLAVOURS[name] }, null, 2)}\n`;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
// An origin only: https, or http on loopback; no userinfo, path, query or hash.
function goodBaseUrl(value) {
  if (typeof value !== 'string' || !value) return false;
  let u;
  try { u = new URL(value); } catch { return false; }
  if (u.username || u.password) return false;
  const secure = u.protocol === 'https:';
  if (!secure && !(u.protocol === 'http:' && LOOPBACK.has(u.hostname))) return false;
  return u.origin === value;
}

/** Strict schema check of a parsed file. `{ ok: true, values }` or `{ ok: false, code }` (code is a fixed word). */
export function validateFlavourDoc(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { ok: false, code: 'bad_schema' };
  const keys = Object.keys(doc);
  if (keys.some((k) => !KEYS.includes(k))) return { ok: false, code: 'unknown_key' };
  if (keys.length !== KEYS.length) return { ok: false, code: 'bad_schema' };
  if (doc.v !== FLAVOUR_VERSION) return { ok: false, code: 'bad_version' };
  for (const k of ['test', 'reflexEgress', 'ownerAdmin']) if (typeof doc[k] !== 'boolean') return { ok: false, code: 'bad_schema' };
  for (const k of ['cloudBase', 'boardMirror']) {
    if (doc[k] === null) continue;
    if (typeof doc[k] !== 'string') return { ok: false, code: 'bad_schema' };
    if (!goodBaseUrl(doc[k])) return { ok: false, code: 'bad_url' };
  }
  const values = { cloudBase: doc.cloudBase, test: doc.test, reflexEgress: doc.reflexEgress, ownerAdmin: doc.ownerAdmin, boardMirror: doc.boardMirror };
  if (JSON.stringify(values) === JSON.stringify(FLAVOURS.public)) return { ok: false, code: 'public_values_in_file' };
  return { ok: true, values };
}

// Windows paths are case-insensitive, so fold case there only.
const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

function labelOf(values) {
  // owner and selftest carry identical values (builder-selftest.cjs), so a match reports "owner".
  return JSON.stringify(values) === JSON.stringify(FLAVOURS.owner) ? 'owner' : 'custom';
}

/**
 * Resolve the flavour once at sidecar start. Never throws: any doubt returns the public flavour with a reason code.
 * Returns `{ name, values, reason }`; `reason` is null for a good file and `no_file` when no file was given.
 */
export function resolveFlavour({ flavourPath, hostDir, fsImpl = fs, log = () => {} } = {}) {
  const publicResult = (reason) => {
    log(reason === 'no_file' ? 'flavour: public (no flavour file)' : `flavour: public (file ignored: ${reason})`);
    return { name: 'public', values: FLAVOURS.public, reason };
  };
  if (flavourPath === undefined || flavourPath === null) return publicResult('no_file');
  if (typeof flavourPath !== 'string' || typeof hostDir !== 'string' || !flavourPath || !hostDir) return publicResult('bad_argument');
  if (!path.isAbsolute(flavourPath) || !path.isAbsolute(hostDir)) return publicResult('not_absolute');
  if (path.basename(flavourPath) !== FLAVOUR_FILE) return publicResult('bad_name');
  let text;
  try {
    const realHost = fsImpl.realpathSync(hostDir);
    const realFile = fsImpl.realpathSync(flavourPath);
    if (!samePath(realFile, path.join(realHost, FLAVOUR_FILE))) return publicResult('wrong_parent');
    const st = fsImpl.statSync(realFile);
    if (!st.isFile()) return publicResult('not_a_file');
    if (st.size > MAX_FLAVOUR_BYTES) return publicResult('too_large');
    text = fsImpl.readFileSync(realFile, 'utf8');
  } catch (e) {
    return publicResult(e && e.code === 'ENOENT' ? 'missing' : 'unreadable');
  }
  let doc;
  try { doc = JSON.parse(text); } catch { return publicResult('parse_error'); }
  const v = validateFlavourDoc(doc);
  if (!v.ok) return publicResult(v.code);
  const name = labelOf(v.values);
  const on = ['test', 'reflexEgress', 'ownerAdmin'].map((k) => `${k}=${v.values[k]}`).join(' ');
  log(`flavour: ${name} (${on} cloudBase=${v.values.cloudBase ? 'set' : 'none'} boardMirror=${v.values.boardMirror ? 'set' : 'none'})`);
  return { name, values: Object.freeze({ ...v.values }), reason: null };
}
