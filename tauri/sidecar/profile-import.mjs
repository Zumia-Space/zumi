// T-31 Tauri P3-C: one-time "Import from Zumi" (the source version is detected, see detectElectronVersion) -- non-secret settings only.
//
// Reads an Electron 0.2.9 profile READ-ONLY and merges a LEAF-LEVEL allow-list into the Tauri data dir. Every allowed key
// has an exact schema (enum strings, numbers in range, booleans, bounded strings, declared nested fields). A value is
// REBUILT from its schema, leaf by leaf: an object or array is never copied wholesale, and any extra, secret-named or
// token-like field is dropped and listed. Nothing secret travels: no BYOK key, board user/pass/token/PIN or cloud token is
// read, decrypted or copied (those files are only checked for PRESENCE, to tell the user what to re-enter).
//
// Where 0.2.9 keeps things (docs/migration/DATA-SCHEMA.md, src/main/main.js):
//   - settings.json and every key file: <userData> = %APPDATA%\Zumi (always; Zumi-data never holds settings.json);
//   - imported rooms: <Zumi-data>\rooms when the build is packaged, else <userData>\rooms;
//   - board data / gesture cache: <Zumi-data> ("<install parent>\Zumi-data", beside the install dir) or userData;
//   - panel layout / HUD panels / floating-window prefs: the renderer's localStorage inside Chromium's profile (leveldb,
//     origin app://zumi). NOT imported: another origin, another engine; they are listed as "set again".
//
// Per-item decisions: user model .vrm = referenced in place (never copied), and only when its path is a plain local
// absolute path on a fixed drive (no UNC, device, verbatim or ".." path: refused BEFORE any fs call, so no SMB connection
// is ever made); otherwise it is dropped and the checklist says "add the model again". Imported rooms = room.glb only
// (size-capped, copied into <dataDir>\rooms\<id>); check.json is not copied (unvetted compound content). Board data,
// gesture cache, Kokoro cache, usage ledger, logs, look-tuning, redact-names, owner-voice.json = not imported.
//
// Links: the profile root, Zumi-data and every traversed directory are lstat-ed; a symlink or junction anywhere, or a
// realpath that leaves the root, makes that source unreadable. Nothing is ever followed.
//
// Reuses the existing settings read/write (adapters.mjs); the four rpc methods are at the end of this file.
import nodeFs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';

import { readSettings, saveSettings } from './adapters.mjs';

const ROOM_ID = /^[0-9a-f]{12}$/; // same content id as boot-reads.mjs ROOM_ID (the id becomes a path segment)
const MARKER = 'profile-import.json';
const MAX_SETTINGS_BYTES = 1024 * 1024;
const MAX_ROOM_BYTES = 100 * 1024 * 1024;
const UNSET = Symbol('unset');

// ---------- secret detection ----------
const SECRET_SHAPES = [/\bsk-[A-Za-z0-9_-]{8,}/, /\bAIza[0-9A-Za-z_-]{10,}/, /\bgsk_[A-Za-z0-9]{8,}/, /\beyJ[A-Za-z0-9_-]{16,}/, /\bBearer\s+\S{8,}/i,
  /\b[A-Fa-f0-9]{32,}\b/, /\b(?:xai|ghp|github_pat|hf)_[A-Za-z0-9_-]{16,}/];
// Field NAMES that mean a credential, tested at every nesting level (belt and braces: the schema already drops them).
const TEXT_SECRET_WORD = /\b(password|passwd|pwd|pin|token|secret|api[ _-]?key|apikey|bearer|credentials?|cookie|session|private key)\b/i;
const SECRET_NAME = /(^|[^a-z])pin([^a-z]|$)|key|token|pass|secret|cred|auth|session|cookie|bearer/i;
/** A run of 16+ base64/hex-ish characters mixing letters and digits: a key or token, not a word or a model name. */
export function tokenLike(v) {
  if (typeof v !== 'string') return false;
  if (SECRET_SHAPES.some((re) => re.test(v))) return true;
  for (const run of v.match(/[A-Za-z0-9+/=]{16,}/g) || []) if (/\d/.test(run) && /[A-Za-z]/.test(run)) return true;
  return false;
}
/**
 * Opaque text: a UUID, a 9+ char letter+digit run, an 8+ char hex run with letters and digits, or two or more short
 * letter+digit words (hyphen-split tokens such as ghp-AbCd1234-EfGh5678). Ordinary ids and names (gemini-2.5-flash-lite,
 * qwen3-235b-a22b, en-US-Chirp3-HD-Leda, Cozy Room) have none of these.
 */
export function opaqueText(v) {
  if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(v)) return true;
  let mixedShort = 0;
  for (const seg of v.split(/[^A-Za-z0-9]+/).filter(Boolean)) {
    const digits = (seg.match(/\d/g) || []).length;
    const letters = (seg.match(/[A-Za-z]/g) || []).length;
    if (seg.length >= 9 && digits && letters) return true;
    if (seg.length >= 8 && /^[0-9a-fA-F]+$/.test(seg) && digits && letters) return true;
    if (seg.length >= 4 && digits >= 2 && letters >= 2) mixedShort += 1;
  }
  return mixedShort >= 2;
}
// A path segment that is a token (SECRETSENTINEL-9f3a..., a long id): 20+ chars of [A-Za-z0-9_-] with letters and digits.
const segmentTokenLike = (seg) => seg.length >= 20 && /^[A-Za-z0-9_-]+$/.test(seg) && /\d/.test(seg) && /[A-Za-z]/.test(seg);
/** A URL in a string with credentials, a query/fragment or a token-like path segment. */
function urlHazard(v) {
  for (const m of v.match(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi) || []) {
    let u; try { u = new URL(m); } catch { return true; }
    if (u.username || u.password || u.search || u.hash) return true;
    if (u.pathname.split('/').some(segmentTokenLike)) return true;
  }
  return false;
}

// ---------- the schema DSL ----------
const S = {
  bool: { t: 'bool' },
  enum: (...v) => ({ t: 'enum', v }),
  num: (min, max) => ({ t: 'num', min, max }),
  str: (re, max = 200, opaque = false, kind = null) => ({ t: 'str', re, max, opaque, kind }),
  url: { t: 'url' },
  obj: (fields, required = []) => ({ t: 'obj', fields, required }),
  map: (keyRe, val, max) => ({ t: 'map', keyRe, val, max }),
  arr: (item, max) => ({ t: 'arr', item, max }),
};
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// A field NAME is reported by path; only a name that itself looks like a secret value is masked.
const safeName = (k) => { const s = String(k).slice(0, 40); return tokenLike(s) ? '<redacted>' : s; };

// validateCustomUrl of src/main/tts-common.js (https, or loopback http; no userinfo/query/hash) + a token-in-path test.
function cleanUrl(raw) {
  if (raw === '') return '';
  if (typeof raw !== 'string' || raw.length > 300) return UNSET;
  let u; try { u = new URL(raw.trim()); } catch { return UNSET; }
  if (u.username || u.password || !u.hostname || u.search || u.hash) return UNSET;
  const loopback = u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost');
  if (u.protocol !== 'https:' && !loopback) return UNSET;
  if (u.pathname.split('/').some(segmentTokenLike) || tokenLike(u.pathname)) return UNSET;
  return u.href.replace(/\/+$/, '');
}

/** Rebuild `v` from `schema`, or UNSET. Every dropped node is recorded in ctx with a reason. */
function clean(schema, v, p, ctx) {
  const drop = (reason, at = p) => { ctx.push({ key: at, reason }); return UNSET; };
  switch (schema.t) {
    case 'bool': return typeof v === 'boolean' ? v : drop('bad_value');
    case 'enum': return schema.v.includes(v) ? v : drop('bad_value');
    case 'num': return typeof v === 'number' && Number.isFinite(v) && v >= schema.min && v <= schema.max ? v : drop('bad_value');
    case 'str': {
      if (typeof v !== 'string' || v.length > schema.max || !schema.re.test(v)) return drop('bad_value');
      if (SECRET_SHAPES.some((re) => re.test(v)) || (!schema.opaque && (tokenLike(v) || opaqueText(v))) || urlHazard(v)) return drop('looks_secret');
      if (schema.kind === 'model' && !/[a-z]{2,}/.test(v)) return drop('bad_value');
      if (schema.kind === 'text' && (/:\/\/|www\.|@/i.test(v) || TEXT_SECRET_WORD.test(v))) return drop('looks_secret');
      return v;
    }
    case 'url': { const r = cleanUrl(v); return r === UNSET ? drop(typeof v === 'string' && (tokenLike(v) || /[?#@]/.test(v)) ? 'looks_secret' : 'bad_value') : r; }
    case 'obj': {
      if (!isPlain(v)) return drop('bad_value');
      const out = {};
      // declared field names are trusted (e.g. manifest.author); every other name is dropped
      for (const k of Object.keys(v)) {
        if (!Object.hasOwn(schema.fields, k)) { drop('not_allowed_leaf', `${p}.${safeName(k)}`); continue; }
        const c = clean(schema.fields[k], v[k], `${p}.${k}`, ctx);
        if (c !== UNSET) out[k] = c;
      }
      if (schema.required.some((k) => !Object.hasOwn(out, k)) || !Object.keys(out).length) return drop('bad_value');
      return out;
    }
    case 'map': {
      if (!isPlain(v)) return drop('bad_value');
      const keys = Object.keys(v);
      if (keys.length > schema.max) return drop('bad_value');
      const out = {};
      for (const k of keys) {
        if (!schema.keyRe.test(k) || SECRET_NAME.test(k) || k === '__proto__') { drop('not_allowed_leaf', `${p}.${safeName(k)}`); continue; }
        const c = clean(schema.val, v[k], `${p}.${k}`, ctx);
        if (c !== UNSET) out[k] = c;
      }
      return Object.keys(out).length ? out : drop('bad_value');
    }
    case 'arr': {
      if (!Array.isArray(v) || v.length > schema.max) return drop('bad_value');
      const out = [];
      v.forEach((x, i) => { const c = clean(schema.item, x, `${p}[${i}]`, ctx); if (c !== UNSET) out.push(c); });
      return out.length ? out : drop('bad_value');
    }
    default: return drop('bad_value');
  }
}

/** The schema as plain JSON (pinned by a snapshot test: adding or loosening a key is a deliberate test edit). */
function describe(s) {
  switch (s.t) {
    case 'bool': return 'bool';
    case 'enum': return `enum:${s.v.join('|')}`;
    case 'num': return `num:${s.min}..${s.max}`;
    case 'str': return `str:${s.re.source}:max${s.max}${s.opaque ? ':opaque' : ''}${s.kind ? ':' + s.kind : ''}`;
    case 'url': return 'url:https-or-loopback,no-query,no-userinfo,no-token-path';
    case 'obj': return { fields: Object.fromEntries(Object.entries(s.fields).map(([k, x]) => [k, describe(x)])), required: s.required };
    case 'map': return { map: `${s.keyRe.source}:max${s.max}`, value: describe(s.val) };
    case 'arr': return { arr: `max${s.max}`, item: describe(s.item) };
    default: return 'unknown';
  }
}

// ---------- the allow-list (a key not named here is NEVER copied) ----------
// Stricter than providers.js MODEL_ID_ANY: lowercase only, at most 81 chars, a letter run, and (in clean) no opaque text.
const MODEL_ID = /^[a-z0-9][a-z0-9._:/-]{0,80}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{1,31}$/;
const NAME = /^[A-Za-z0-9._-]{1,64}$/;
const EFFORTS = ['off', 'low', 'medium', 'high'];
const choice = S.obj({ model: S.str(MODEL_ID, 81, false, 'model'), effort: S.enum(...EFFORTS) }, ['model', 'effort']);
const roleModels = S.obj({ plan: choice, do: choice, check: choice, lookup: choice, off: S.arr(S.enum('plan', 'check', 'lookup'), 3) });
const customName = S.str(/^[A-Za-z0-9._:+/-]{1,80}$/, 80);
const quiet = S.str(/^\d{2}:\d{2}$/, 5);
const text = S.str(/^[\p{L}\p{M}\p{N} .,'()&-]{1,80}$/u, 80, false, 'text');
const roomEntry = S.obj({
  id: S.str(ROOM_ID, 12, true), fileBase: S.str(/^[A-Za-z0-9._ ()-]{1,100}$/, 100),
  manifest: S.obj({ name: text, author: text, license: text, attribution: text }),
}, ['id']);

const ALLOW = {
  uiLang: S.enum('en', 'vi', 'zh'),
  developerMode: S.bool,
  sendClientNamesToAi: S.bool,
  aiMode: S.enum('free', 'byok'),
  aiProvider: S.str(SLUG, 32),
  aiDefaultsLegacy: S.bool,
  chatModel: S.str(MODEL_ID, 81, false, 'model'),
  roleModels,
  roleModelsByProvider: S.map(SLUG, roleModels, 16),
  voiceEnabled: S.bool,
  voiceSpeed: S.num(0.75, 1.5),
  voiceVolume: S.num(0, 1),
  thinkSound: S.bool,
  speakTypedWhenMicOff: S.bool,
  voiceProviderEn: S.enum('kokoro', 'google', 'gemini', 'elevenlabs', 'http-openai', 'http-zumia'),
  voiceProviderVi: S.enum('google', 'gemini', 'elevenlabs', 'http-openai', 'http-zumia', 'off'),
  voiceReplyLang: S.enum('auto', 'en', 'vi'),
  voiceGoogle: S.obj({ en: S.str(/^[A-Za-z0-9_-]{1,80}$/, 80), vi: S.str(/^[A-Za-z0-9_-]{1,80}$/, 80) }, ['en', 'vi']),
  voiceGemini: S.obj({ model: S.str(/^[A-Za-z0-9._-]{1,60}$/, 60), voice: S.str(/^[A-Za-z0-9_-]{1,40}$/, 40) }, ['model', 'voice']),
  voiceEleven: S.obj({ voiceId: S.str(/^[A-Za-z0-9]{8,24}$/, 24, true), model: S.str(/^[a-z0-9_]{1,40}$/, 40) }, ['voiceId', 'model']),
  voiceCustom: S.obj({ base: S.url, model: customName, voice: customName }, ['base', 'model', 'voice']),
  voiceCustomZumia: S.obj({ url: S.url }, ['url']),
  talkLevel: S.enum('off', 'quiet', 'normal', 'chatty'),
  talkVoiceLang: S.enum('en', 'vi'),
  talkQuietHours: S.obj({ on: S.bool, start: quiet, end: quiet }, ['on', 'start', 'end']),
  talkAsksBreakQuiet: S.bool,
  talkCheckins: S.bool,
  chair3d: S.str(NAME, 64),
  sceneRoom: S.str(NAME, 64),
  hudStyle: S.enum('off', 'a', 'b'),
};
// Keys with their own rule (model pair, rooms): still rebuilt leaf by leaf, never copied blindly.
const SPECIAL = { model: S.str(MODEL_ID, 81, false, 'model'), room: S.str(/^(?:none|default|default-v2|[0-9a-f]{12})$/, 16, true), roomChoiceV2: S.bool, importedRooms: S.arr(roomEntry, 64) };
export const ALLOW_KEYS = Object.freeze(Object.keys(ALLOW));
export const SPECIAL_KEYS = Object.freeze([...Object.keys(SPECIAL), 'userModelPath']);
/** Pinned by scripts/fixtures/profile-import-schema.snapshot.json. */
export function describeSchema() {
  return { ...Object.fromEntries(Object.entries(ALLOW).map(([k, s]) => [k, describe(s)])), ...Object.fromEntries(Object.entries(SPECIAL).map(([k, s]) => [k, describe(s)])), userModelPath: 'plain-local-absolute-path:drive-letter,fixed-drive,.vrm,no-unc,no-device,no-dotdot' };
}
// Known 0.2.9 keys that must not travel, each with the reason shown in the report.
export const KNOWN_SKIP = Object.freeze({
  soul: 'not_in_0.2.x_set_on_first_run', // alpha.12: the first-run cards decide it
  watchLevel: 'not_in_0.2.x_default_on', // alpha.12
  requireBoardPin: 'board_pin_is_a_secret_preference',
  boardPort: 'machine_state',
  roomDefaultPath: 'operator_path_override',
  roomV2DefaultPath: 'operator_path_override',
  wardrobeDir: 'operator_path_override',
  wardrobeGate: 'derived_state_recomputed',
  wardrobeUndo: 'transient_undo_state',
  defaultRoomGoodSha: 'derived_cache_marker',
  defaultRoomV2GoodSha: 'derived_cache_marker',
  hudVoiceMuted: 'legacy_replaced_by_talkLevel',
  talkMute: 'transient',
  talkLastVersion: 'transient',
});
// Tauri writes these itself on first boot, so a conflict on them is expected: the dry-run flags them so the UI can
// pre-select "use my old value".
const AUTO_DEFAULT = new Set(['model', 'userModelPath', 'room', 'roomChoiceV2', 'aiProvider', 'aiDefaultsLegacy']);

// Presence-only table (the files are NEVER opened): which key files exist tells the checklist what to name.
const SECRET_FILE_NAMES = Object.freeze({
  'jev-key.bin': 'OpenRouter', 'gemini-key.bin': 'Gemini', 'groq-key.bin': 'Groq', 'opencode-key.bin': 'OpenCode', 'opencode-go-key.bin': 'OpenCode Go',
  'leda-key.bin': 'Google voice', 'gemini-tts-key.bin': 'Gemini voice', 'elevenlabs-key.bin': 'ElevenLabs',
  'custom-openai-tts-key.bin': 'Custom voice', 'custom-zumia-tts-key.bin': 'Custom voice', 'cloud-token.bin': 'Zumia cloud',
});

// ---------- paths and links ----------
/**
 * A user model path is usable only as a plain local absolute path: drive letter + separator, no UNC (\\server, //server),
 * device (\\.\) or verbatim (\\?\) prefix, no stream/colon syntax, no wildcard, no ".." segment. Pure string test: it runs
 * BEFORE any fs call, so a refused path (e.g. \\attacker\share\x.vrm) is never statted and no SMB connection is made.
 */
export function plainLocalVrmPath(p) {
  if (typeof p !== 'string' || p.length > 260 || p.includes('\0')) return false;
  if (!/^[A-Za-z]:[\\/]/.test(p)) return false;
  if (/[<>"|?*]/.test(p) || p.slice(2).includes(':')) return false;
  if (p.split(/[\\/]+/).includes('..')) return false;
  return /\.vrm$/i.test(p);
}
/**
 * A..B are floppies. Otherwise the volume must report "Fixed Drive" (fsutil fsinfo drivetype, i.e. GetDriveType ==
 * DRIVE_FIXED) AND must not be a subst mapping (subst lists it). Neither call opens a path or touches the network; any
 * failure to ask fails closed. Removable, CD-ROM, remote and subst drives are all refused.
 */
export function isFixedLocalDrive(letter) {
  if (typeof letter !== 'string' || !/^[A-Za-z]$/.test(letter)) return false;
  const L = letter.toUpperCase();
  if (L === 'A' || L === 'B') return false;
  if (process.platform !== 'win32') return true;
  try {
    const t = spawnSync('fsutil', ['fsinfo', 'drivetype', `${L}:`], { windowsHide: true, timeout: 5000, encoding: 'utf8' });
    if (t.status !== 0 || !/Fixed Drive/i.test(String(t.stdout))) return false;
    const sub = spawnSync('subst', [], { windowsHide: true, timeout: 5000, encoding: 'utf8' });
    if (sub.status !== 0) return false;
    return !String(sub.stdout).split(/\r?\n/).some((line) => line.trim().toUpperCase().startsWith(`${L}:\\`));
  } catch { return false; }
}
const defaultIsFixedDrive = isFixedLocalDrive;

/**
 * The user's .vrm, vetted without ever opening it: plain local path string, fixed drive, then lstat every segment from the
 * drive root (a link anywhere, including the file itself, is refused: a directory link could point at a UNC share), then
 * the realpath must again be a plain local path on a fixed drive. -> 'ok' | 'not_local' | 'missing'
 */
function vetVrm(fs, pth, isFixedDrive) {
  if (!plainLocalVrmPath(pth) || SECRET_SHAPES.some((re) => re.test(pth)) || !isFixedDrive(pth[0])) return 'not_local';
  const segs = pth.slice(3).split(/[\\/]+/).filter(Boolean);
  let cur = pth.slice(0, 3);
  for (let i = 0; i < segs.length; i++) {
    cur = path.join(cur, segs[i]);
    const last = i === segs.length - 1;
    let st;
    try { st = fs.lstatSync(cur); } catch (e) { return e && e.code === 'ENOENT' ? 'missing' : 'not_local'; }
    if (st.isSymbolicLink()) return 'not_local';
    if (!(last ? st.isFile() : st.isDirectory())) return last ? 'missing' : 'not_local';
  }
  let real;
  try { real = fs.realpathSync(pth); } catch { return 'not_local'; }
  return plainLocalVrmPath(real) && isFixedDrive(real[0]) ? 'ok' : 'not_local';
}

// A root is a plain directory (lstat, never a link); `real` is its realpath, the fence every traversal stays inside.
function openRoot(fs, dir) {
  if (typeof dir !== 'string' || !dir) return null;
  try {
    const st = fs.lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) return null;
    return { dir, real: fs.realpathSync(dir) };
  } catch { return null; }
}
const within = (root, real) => { const r = path.relative(root.real, real); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
/** root/seg1/seg2...: every segment lstat-plain (no symlink or junction) with its realpath inside the root, else null. */
function safePath(fs, root, segs, kind) {
  if (!root) return null;
  let cur = root.dir;
  for (let i = 0; i < segs.length; i++) {
    cur = path.join(cur, segs[i]);
    const last = i === segs.length - 1;
    try {
      const st = fs.lstatSync(cur);
      if (st.isSymbolicLink()) return null;
      if (!(last && kind === 'file' ? st.isFile() : st.isDirectory())) return null;
      if (!within(root, fs.realpathSync(cur))) return null;
    } catch { return null; }
  }
  return cur;
}
function readJsonSafe(fs, root, segs) {
  const file = safePath(fs, root, segs, 'file');
  if (!file) return null;
  try {
    if (fs.lstatSync(file).size > MAX_SETTINGS_BYTES) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return null; }
}
function readJson(fs, file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function isFile(fs, f) { try { return fs.statSync(f).isFile(); } catch { return false; } }

// ---------- detection ----------
/**
 * @param {{ appData: string, installParents?: string[], shortcuts?: string[], fs?: object }} o  appData = %APPDATA%; installParents = the folders
 *   that contain a Zumi install dir (the owner build keeps "<parent>\Zumi-data" beside it); shortcuts = the Zumi.lnk files whose
 *   target names the CURRENT Electron install (detectProfileForHost: Start-menu Programs + Desktop).
 * A profile exists only when <appData>\Zumi is a plain directory (not a junction) whose settings.json is a plain file that
 * parses to an object. A lone Zumi-data folder is not enough, and a Zumi-data that is a junction is ignored.
 */
export function detectProfile({ appData, installParents = [], shortcuts = [], fs = nodeFs }) {
  const none = { found: false, userDataDir: null, zumiDataDir: null, sourceVersion: null };
  if (typeof appData !== 'string' || !appData) return none;
  const userDataDir = path.join(appData, 'Zumi');
  const root = openRoot(fs, userDataDir);
  const parsed = readJsonSafe(fs, root, ['settings.json']);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return none;
  const zumiDataDir = installParents.map((p) => path.join(p, 'Zumi-data')).find((d) => openRoot(fs, d)) || null;
  return { found: true, userDataDir, zumiDataDir, sourceVersion: detectElectronVersion(fs, installParents, shortcuts) };
}

// ---------- which Electron version is the source? (named in the import dialog; null = say "Zumi (desktop)") ----------
const APP_VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}(-[0-9A-Za-z.]{1,24})?$/;
const MAX_PKG_BYTES = 64 * 1024;
/** package.json text of an Electron install dir: resources/app/package.json, else read out of resources/app.asar (header only). */
function installPackageJson(fs, dir) {
  const unpacked = path.join(dir, 'resources', 'app', 'package.json');
  try {
    const st = fs.lstatSync(unpacked);
    if (st.isFile() && st.size <= MAX_PKG_BYTES) return JSON.parse(fs.readFileSync(unpacked, 'utf8'));
  } catch { /* try the asar */ }
  const asar = path.join(dir, 'resources', 'app.asar');
  let fd = null;
  try {
    const st = fs.lstatSync(asar);
    if (!st.isFile()) return null;
    fd = fs.openSync(asar, 'r');
    const head = Buffer.alloc(16);
    if (fs.readSync(fd, head, 0, 16, 0) !== 16 || head.readUInt32LE(0) !== 4) return null;
    const pickleSize = head.readUInt32LE(4), jsonLen = head.readUInt32LE(12);
    if (jsonLen < 2 || jsonLen > 16 * 1024 * 1024 || jsonLen + 8 > pickleSize + 8) return null;
    const jsonBuf = Buffer.alloc(jsonLen);
    if (fs.readSync(fd, jsonBuf, 0, jsonLen, 16) !== jsonLen) return null;
    const entry = JSON.parse(jsonBuf.toString('utf8')).files?.['package.json'];
    const size = entry && entry.size, offset = entry && Number(entry.offset);
    if (!Number.isInteger(size) || size < 2 || size > MAX_PKG_BYTES || !Number.isInteger(offset) || offset < 0) return null;
    const body = Buffer.alloc(size);
    if (fs.readSync(fd, body, 0, size, 8 + pickleSize + offset) !== size) return null;
    return JSON.parse(body.toString('utf8'));
  } catch { return null; } finally { if (fd !== null) try { fs.closeSync(fd); } catch { /* read-only handle */ } }
}
/** The validated version of the Electron install at `dir`, or null (package must be "zumi-desktop" with a plain x.y.z[-pre]). */
function installVersion(fs, dir) {
  const pkg = installPackageJson(fs, dir);
  return pkg && pkg.name === 'zumi-desktop' && typeof pkg.version === 'string' && APP_VERSION.test(pkg.version) ? pkg.version : null;
}

// ---------- Zumi.lnk: the shortcut target names the CURRENT install (anh's PC keeps ~12 side-by-side installs) ----------
const MAX_LNK_BYTES = 64 * 1024;
const LNK_CLSID = '0114020000000000c000000000000046';
/**
 * The local target path of a Windows shell link (MS-SHLLINK), parsed in-process: header + optional LinkTargetIDList, then
 * LinkInfo's LocalBasePath + CommonPathSuffix (the Unicode copies when the LinkInfo header carries them, else ASCII-only
 * ANSI: a non-ASCII ANSI byte is code-page dependent, so it is refused). Anything else (no LinkInfo, a network-only link,
 * out-of-bounds offsets) -> null.
 */
function parseShellLinkTarget(buf) {
  const u32 = (o) => (o + 4 <= buf.length ? buf.readUInt32LE(o) : null);
  if (buf.length < 0x4c || u32(0) !== 0x4c || buf.subarray(4, 20).toString('hex') !== LNK_CLSID) return null;
  const flags = u32(0x14);
  let off = 0x4c;
  if (flags & 0x01) { if (off + 2 > buf.length) return null; off += 2 + buf.readUInt16LE(off); } // HasLinkTargetIDList
  if (!(flags & 0x02)) return null; // HasLinkInfo
  const liSize = u32(off), liHead = u32(off + 4), liFlags = u32(off + 8);
  if (liSize === null || liHead === null || liFlags === null || off + liSize > buf.length || liHead < 0x1c || liHead > liSize) return null;
  if (!(liFlags & 0x01)) return null; // VolumeIDAndLocalBasePath
  const li = buf.subarray(off, off + liSize);
  const cstr = (o) => { if (!o || o >= li.length) return null; const end = li.indexOf(0, o); if (end < 0) return null; const b = li.subarray(o, end); return b.some((x) => x > 0x7f) ? null : b.toString('latin1'); };
  const wstr = (o) => { if (!o || o >= li.length) return null; for (let i = o; i + 1 < li.length; i += 2) if (li[i] === 0 && li[i + 1] === 0) return li.subarray(o, i).toString('utf16le'); return null; };
  let base, suffix;
  if (liHead >= 0x24) { base = wstr(li.readUInt32LE(28)); suffix = wstr(li.readUInt32LE(32)); }
  else { base = cstr(li.readUInt32LE(16)); suffix = cstr(li.readUInt32LE(24)); }
  if (typeof base !== 'string' || !base) return null;
  return base + (suffix || '');
}
/** 'absent' (no file) | 'unreadable' | { target } for one Zumi.lnk. The target must be a plain local absolute .exe path. */
function readShortcut(fs, file) {
  let st;
  try { st = fs.lstatSync(file); } catch (e) { return e && e.code === 'ENOENT' ? 'absent' : 'unreadable'; }
  if (!st.isFile() || st.size > MAX_LNK_BYTES) return 'unreadable';
  let target = null;
  try { target = parseShellLinkTarget(fs.readFileSync(file)); } catch { return 'unreadable'; }
  if (!target || !/^[A-Za-z]:\\[^<>"|?*\0]+\.exe$/i.test(target) || /(^|\\)\.\.(\\|$)/.test(target)) return 'unreadable';
  return { target };
}
/**
 * The Electron app's own version, for the import dialog. The CURRENT install is the one the Zumi shortcuts point at
 * (the 0.2.10 kit repointed both): every shortcut that exists must be readable and they must all name the same install
 * folder, whose resources/app.asar (or resources/app/package.json) gives the version. An unreadable shortcut, two that
 * disagree, or a target that is not a Zumi install -> null (the dialog shows the neutral "Zumi (desktop)"). Only with NO
 * shortcut at all does the older folder scan beside Zumi-data count, and then only when it finds exactly one install.
 * userData is NOT a source (settings.json talkLastVersion is only written when the talk clock starts, so it goes stale).
 */
export function detectElectronVersion(fs, installParents, shortcuts = []) {
  const reads = (shortcuts || []).map((f) => readShortcut(fs, f));
  if (reads.includes('unreadable')) return null;
  const targets = reads.filter((r) => typeof r === 'object').map((r) => path.dirname(path.normalize(r.target)));
  if (new Set(targets.map((d) => d.toLowerCase())).size > 1) return null;
  if (targets.length) return installVersion(fs, targets[0]);
  const candidates = [];
  for (const parent of installParents || []) {
    let names; try { names = fs.readdirSync(parent); } catch { continue; }
    for (const name of names.slice(0, 200)) {
      if (name === 'Zumi-data') continue;
      const dir = path.join(parent, name);
      try { if (!fs.lstatSync(dir).isDirectory()) continue; } catch { continue; }
      const v = installVersion(fs, dir);
      if (v) candidates.push(v);
    }
  }
  return candidates.length === 1 ? candidates[0] : null;
}

/**
 * The sidecar's detect. A self-test / demo / shots / probe launch NEVER looks at the real profile; an undefined or odd
 * flag fails closed (only a literal `false` allows the real look).
 */
export function detectProfileForHost({ selfTestActive, appData, userProfile, hostDir, fs = nodeFs }) {
  if (selfTestActive !== false) return { found: false, userDataDir: null, zumiDataDir: null, sourceVersion: null };
  const installParents = hostDir ? [path.dirname(hostDir), path.dirname(path.dirname(hostDir))] : [];
  // the two shortcuts the Zumi kits write: [Environment]::GetFolderPath('Programs') and ('Desktop'), each + Zumi.lnk
  const shortcuts = [
    ...(typeof appData === 'string' && appData ? [path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Zumi.lnk')] : []),
    ...(typeof userProfile === 'string' && userProfile ? [path.join(userProfile, 'Desktop', 'Zumi.lnk')] : []),
  ];
  return detectProfile({ appData, installParents, shortcuts, fs });
}

export function createProfileImport({ dataDir, fs = nodeFs, isFixedDrive = defaultIsFixedDrive }) {
  if (typeof dataDir !== 'string' || !dataDir) throw new Error('profile_import_needs_dataDir');
  const markerFile = path.join(dataDir, MARKER);
  const marker = () => readJson(fs, markerFile);
  const sourceSettings = (profile) => {
    const src = profile && profile.userDataDir ? readJsonSafe(fs, openRoot(fs, profile.userDataDir), ['settings.json']) : null;
    return src && typeof src === 'object' && !Array.isArray(src) ? src : null;
  };

  /** Dry run: reads the source and the Tauri settings, writes nothing. */
  function plan(profile) {
    const src = sourceSettings(profile);
    if (!src) return { ok: false, error: 'no_profile' };
    const root = openRoot(fs, profile.userDataDir);
    const zroot = openRoot(fs, profile.zumiDataDir);
    const cur = readSettings(dataDir);
    const out = { ok: true, copy: [], same: [], conflicts: [], skipped: [], unknown: [], rooms: [], needsReentry: [], notImported: [] };
    const candidates = []; // { key, value, pair?, same? } before the merge rule
    const skip = (key, reason) => out.skipped.push({ key, reason });
    const has = (k) => Object.hasOwn(src, k);
    const rebuild = (key, schema) => { const ctx = []; const v = clean(schema, src[key], key, ctx); out.skipped.push(...ctx); return v; };

    for (const key of Object.keys(src)) {
      if (key in KNOWN_SKIP) skip(key, KNOWN_SKIP[key]);
      else if (!(key in ALLOW) && !SPECIAL_KEYS.includes(key)) out.unknown.push(safeName(key));
    }
    for (const key of ALLOW_KEYS) {
      if (!has(key)) continue;
      const value = rebuild(key, ALLOW[key]);
      if (value !== UNSET) candidates.push({ key, value });
    }

    // rooms: only entries whose folder is a plain tree inside the profile; room.glb is the one file ever copied
    if (has('importedRooms')) {
      const entries = rebuild('importedRooms', SPECIAL.importedRooms);
      if (entries !== UNSET) {
        for (const e of entries) {
          let from = null;
          for (const base of [zroot, root]) {
            const dir = safePath(fs, base, ['rooms', e.id], 'dir');
            const glb = dir && safePath(fs, base, ['rooms', e.id, 'room.glb'], 'file');
            if (glb) { try { if (fs.lstatSync(glb).size <= MAX_ROOM_BYTES) { from = glb; break; } skip(`importedRooms.${e.id}`, 'room_too_large'); } catch { /* unreadable: skip */ } }
          }
          if (!from) continue;
          out.rooms.push({ id: e.id, fileBase: e.fileBase || 'room.glb', manifest: e.manifest || null, from, present: isFile(fs, path.join(dataDir, 'rooms', e.id, 'room.glb')) });
        }
      }
      if (out.rooms.length) {
        const existing = Array.isArray(cur.importedRooms) ? cur.importedRooms : [];
        const fresh = out.rooms.filter((r) => !existing.some((x) => x && x.id === r.id)).map((r) => ({ id: r.id, fileBase: r.fileBase, manifest: r.manifest }));
        candidates.push({ key: 'importedRooms', value: [...existing, ...fresh], same: fresh.length === 0 });
      } else skip('importedRooms', 'room_folder_missing');
    }
    if (has('room')) {
      const saved = rebuild('room', SPECIAL.room);
      // room v1 "Zumi's Office" was removed (owner rejected it, 2026-10-26): a saved v1 pick imports as the shipped default-v2 (Night City)
      const r = saved === 'default' ? 'default-v2' : saved;
      const available = r !== UNSET && (['none', 'default-v2'].includes(r) || out.rooms.some((x) => x.id === r) || (Array.isArray(cur.importedRooms) && cur.importedRooms.some((x) => x && x.id === r)));
      if (available) {
        candidates.push({ key: 'room', value: r });
        const c2 = has('roomChoiceV2') ? rebuild('roomChoiceV2', SPECIAL.roomChoiceV2) : UNSET;
        if (c2 !== UNSET) candidates.push({ key: 'roomChoiceV2', value: c2 });
      } else { skip('room', 'room_not_available'); if (has('roomChoiceV2')) skip('roomChoiceV2', 'follows_room'); }
    } else if (has('roomChoiceV2')) skip('roomChoiceV2', 'follows_room');

    // model: the .vrm stays where the user put it (referenced, not copied)
    if (has('model') || has('userModelPath')) {
      const m = has('model') ? rebuild('model', SPECIAL.model) : UNSET;
      if (m === 'user') {
        const pth = src.userModelPath;
        // string rule and fixed-drive test first: a refused path is never handed to the file system
        const vet = vetVrm(fs, pth, isFixedDrive);
        if (vet === 'not_local') { skip('model', 'model_path_not_local'); out.notImported.push('model_readd'); }
        else if (vet === 'missing') { skip('model', 'model_file_missing'); out.notImported.push('model_readd'); }
        else candidates.push({ key: 'model', value: 'user', pair: { userModelPath: pth } });
      } else if (m !== UNSET) {
        candidates.push({ key: 'model', value: m });
      }
      if (has('userModelPath') && m !== 'user') skip('userModelPath', 'follows_model');
    }

    // merge: never overwrite what Tauri already has. roleModels is the ACTIVE provider's slot: only meaningful under the
    // provider it was saved for.
    const srcProvider = candidates.find((c) => c.key === 'aiProvider');
    const providerNow = Object.hasOwn(cur, 'aiProvider') ? cur.aiProvider : (srcProvider || {}).value;
    for (const c of candidates) {
      if (c.key === 'roleModels' && srcProvider && providerNow !== srcProvider.value) { skip('roleModels', 'provider_differs'); continue; }
      const had = Object.hasOwn(cur, c.key);
      if (c.same) { out.same.push(c.key); continue; }
      if (!had) { out.copy.push({ key: c.key, value: c.value }); if (c.pair) for (const [k, v] of Object.entries(c.pair)) out.copy.push({ key: k, value: v }); continue; }
      const curValue = c.pair ? { model: cur.model, ...Object.fromEntries(Object.keys(c.pair).map((k) => [k, cur[k]])) } : cur[c.key];
      const newValue = c.pair ? { model: c.value, ...c.pair } : c.value;
      if (isDeepStrictEqual(curValue, newValue)) { out.same.push(c.key); continue; }
      out.conflicts.push({ key: c.key, current: cur[c.key], incoming: c.value, autoDefault: AUTO_DEFAULT.has(c.key), ...(c.pair ? { pair: c.pair } : {}) });
    }

    // what the user must still do by hand (presence checks only, nothing is opened, nothing is followed)
    const providers = [];
    for (const [file, label] of Object.entries(SECRET_FILE_NAMES)) {
      if (safePath(fs, root, [file], 'file') && !providers.includes(label)) providers.push(label);
    }
    out.providers = providers;
    out.needsReentry.push('api_keys', 'board_login');
    if (src.requireBoardPin === true) out.needsReentry.push('board_pin');
    out.notImported.unshift('ui_prefs');
    if (zroot && safePath(fs, zroot, ['laneboard'], 'dir')) out.notImported.push('board_data');
    if (safePath(fs, root, ['tts', 'kokoro'], 'dir')) out.notImported.push('voice_cache');
    return out;
  }

  /**
   * Apply: merges the plan into the Tauri settings. `overwrite` = conflict keys the user chose to replace.
   * Idempotent: a second call finds everything "same" and writes nothing but (at most) the marker.
   */
  function apply(profile, { overwrite = [], lang = null } = {}) {
    const p = plan(profile);
    if (!p.ok) return p;
    const patch = {};
    const copied = [];
    for (const c of p.copy) { patch[c.key] = c.value; copied.push(c.key); }
    const kept = [];
    for (const c of p.conflicts) {
      if (overwrite.includes(c.key)) {
        patch[c.key] = c.incoming; copied.push(c.key);
        if (c.pair) for (const [k, v] of Object.entries(c.pair)) { patch[k] = v; copied.push(k); }
      } else kept.push(c.key);
    }
    const roomsCopied = [];
    for (const r of p.rooms) {
      if (r.present) continue;
      const to = path.join(dataDir, 'rooms', r.id);
      fs.mkdirSync(to, { recursive: true });
      fs.writeFileSync(path.join(to, 'room.glb'), fs.readFileSync(r.from)); // r.from is the vetted room.glb itself; check.json is never copied
      roomsCopied.push(r.id);
    }
    if (Object.keys(patch).length) saveSettings(dataDir, patch);
    const first = marker();
    if (!first || first.state !== 'imported' || copied.length || roomsCopied.length) {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(markerFile, JSON.stringify({ v: 1, state: 'imported', at: (first && first.at) || new Date().toISOString(), copied: [...new Set([...(first && first.copied || []), ...copied])], rooms: [...new Set([...(first && first.rooms || []), ...roomsCopied])], needsReentry: p.needsReentry }, null, 2));
    }
    const ids = [...p.needsReentry, ...p.notImported];
    const useLang = lang || readSettings(dataDir).uiLang || 'en';
    return {
      ok: true, copied, kept, same: p.same, rooms: roomsCopied, skipped: p.skipped, unknown: p.unknown, needsReentry: p.needsReentry, notImported: p.notImported, providers: p.providers,
      checklist: checklist(useLang, ids, { providers: p.providers }),
    };
  }

  /** First-run offer: a profile exists and the user has neither imported nor dismissed. Settings can always call apply. */
  function status(profile) {
    const m = marker();
    const found = Boolean(sourceSettings(profile));
    const sourceVersion = found && profile && typeof profile.sourceVersion === 'string' && APP_VERSION.test(profile.sourceVersion) ? profile.sourceVersion : null;
    return { found, done: Boolean(m && m.state === 'imported'), dismissed: Boolean(m && m.state === 'dismissed'), offer: found && !m, sourceVersion };
  }

  function dismiss() {
    if (marker()) return;
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(markerFile, JSON.stringify({ v: 1, state: 'dismissed', at: new Date().toISOString() }, null, 2));
  }

  return { plan, apply, status, dismiss };
}

// ---------- the checklist (vi / en / zh) ----------
const TEXT = {
  en: {
    api_keys: ['Re-enter your API keys', 'API keys are never imported. Open Settings > AI & Usage and Settings > Voice and paste each key again.', 'Had a key before:'],
    board_login: ['Sign in to the Board again', 'The Board user, password, token and PIN are never imported. Open the Board tab and sign in.'],
    board_pin: ['Set your Board PIN again', 'You had a PIN on the Board. The PIN is never imported: set a new one when you sign in.'],
    ui_prefs: ['Check layout, HUD and floating-window preferences', 'Panel layout, HUD panels and floating-window choices live in the old app window storage and were not imported.'],
    board_data: ['Board tasks were not copied', 'Your local Board data stays in the old Zumi-data folder. It is not copied by this import.'],
    model_readd: ["Add your model again", "Your own avatar file could not be linked (it is missing, or not a plain local file on a fixed drive). Choose it again with Open VRM."],
    voice_cache: ['The local voice model downloads again', 'The Kokoro voice model cache was not copied; it downloads again the first time local voice is used.'],
  },
  vi: {
    api_keys: ['Nhập lại khoá API', 'Khoá API không bao giờ được nhập sang. Mở Cài đặt > AI & Mức dùng và Cài đặt > Giọng nói, rồi dán lại từng khoá.', 'Trước đây có khoá:'],
    board_login: ['Đăng nhập lại Bảng', 'Tên đăng nhập, mật khẩu, token và mã PIN của Bảng không được nhập sang. Mở tab Bảng và đăng nhập lại.'],
    board_pin: ['Đặt lại mã PIN của Bảng', 'Trước đây Bảng có mã PIN. Mã PIN không được nhập sang: hãy đặt mã mới khi đăng nhập.'],
    ui_prefs: ['Kiểm tra lại bố cục, HUD và cửa sổ nổi', 'Bố cục bảng điều khiển, HUD và lựa chọn cửa sổ nổi nằm trong bộ nhớ cửa sổ của app cũ nên chưa được nhập sang.'],
    board_data: ['Công việc trên Bảng chưa được sao chép', 'Dữ liệu Bảng nội bộ vẫn nằm ở thư mục Zumi-data cũ. Lần nhập này không sao chép nó.'],
    model_readd: ["Thêm lại model của anh", "Không liên kết lại được file avatar riêng (file đã mất, hoặc không phải file cục bộ trên ổ cố định). Hãy chọn lại bằng Mở VRM."],
    voice_cache: ['Mô hình giọng nói cục bộ sẽ tải lại', 'Bộ nhớ đệm mô hình giọng Kokoro chưa được sao chép; nó tải lại lần đầu dùng giọng cục bộ.'],
  },
  zh: {
    api_keys: ['重新输入 API 密钥', 'API 密钥不会被导入。请打开“设置 > AI 与用量”和“设置 > 语音”，重新粘贴每个密钥。', '之前有密钥：'],
    board_login: ['重新登录看板', '看板的用户名、密码、令牌和 PIN 不会被导入。请打开“看板”标签页并重新登录。'],
    board_pin: ['重新设置看板 PIN', '之前的看板设置了 PIN。PIN 不会被导入：登录时请设置新的 PIN。'],
    ui_prefs: ['检查布局、HUD 和悬浮窗偏好', '面板布局、HUD 面板和悬浮窗选择保存在旧应用窗口的存储中，未被导入。'],
    board_data: ['看板任务未被复制', '本地看板数据仍在旧的 Zumi-data 文件夹中，本次导入不会复制它。'],
    model_readd: ["重新添加你的模型", "无法关联你自己的头像文件（文件已丢失，或不是固定磁盘上的本地文件）。请用“打开 VRM”重新选择。"],
    voice_cache: ['本地语音模型将重新下载', 'Kokoro 语音模型缓存未被复制；首次使用本地语音时会重新下载。'],
  },
};

/**
 * @param {string} lang 'vi' | 'en' | 'zh' (anything else = en)
 * @param {string[]} ids item ids to show, in order (unknown ids are dropped)
 * @param {{ providers?: string[] }} [detail] provider labels that had a key file (labels only)
 */
export function checklist(lang, ids, { providers = [] } = {}) {
  const l = TEXT[lang] ? lang : 'en';
  const items = [];
  for (const id of ids || []) {
    const t = TEXT[l][id];
    if (!t) continue;
    const body = id === 'api_keys' && providers.length ? `${t[1]} ${t[2]} ${providers.join(', ')}.` : t[1];
    items.push({ id, title: t[0], body });
  }
  return { lang: l, items };
}

// ---------- the rpc surface (CoS-approved 14-day method list: settings.importDetect/Plan/Apply/Dismiss) ----------
const IMPORT_KEYS = new Set([...ALLOW_KEYS, ...SPECIAL_KEYS]);
const UI_LANGS = ['en', 'vi', 'zh'];
const NO_ARGS = { ok: false, error: 'no_arguments' };

/**
 * The four sidecar methods. The source profile is ALWAYS `detect()` (the sidecar passes the fixed %APPDATA%Zumi profile);
 * no method takes a path, and an argument on a no-argument method is refused. Replies carry keys, non-secret values and
 * room ids, never a source path.
 * @param {{ dataDir: string, detect: () => object, fs?: object }} o
 */
export function createImportRpc({ dataDir, detect, fs = nodeFs }) {
  const imp = createProfileImport({ dataDir, fs });
  return {
    'settings.importDetect': (...a) => (a.length ? NO_ARGS : { ...imp.status(detect()) }),
    'settings.importPlan': (...a) => {
      if (a.length) return NO_ARGS;
      const p = imp.plan(detect());
      if (!p.ok) return p;
      return { ...p, rooms: p.rooms.map((r) => r.id) };
    },
    'settings.importApply': (...a) => {
      if (a.length > 1) return { ok: false, error: 'bad_args' };
      const opts = a.length ? a[0] : {};
      if (opts === null || typeof opts !== 'object' || Array.isArray(opts)) return { ok: false, error: 'bad_args' };
      for (const k of Object.keys(opts)) if (k !== 'overwrite' && k !== 'lang') return { ok: false, error: 'bad_field', field: k };
      let overwrite = [];
      if (opts.overwrite !== undefined) {
        if (!Array.isArray(opts.overwrite) || opts.overwrite.length > 64) return { ok: false, error: 'bad_overwrite' };
        for (const k of opts.overwrite) {
          if (typeof k !== 'string' || !IMPORT_KEYS.has(k)) return { ok: false, error: 'bad_overwrite', field: typeof k === 'string' ? k.slice(0, 64) : null };
        }
        overwrite = opts.overwrite;
      }
      if (opts.lang !== undefined && !UI_LANGS.includes(opts.lang)) return { ok: false, error: 'bad_lang' };
      return imp.apply(detect(), { overwrite, lang: opts.lang || null });
    },
    'settings.importDismiss': (...a) => { if (a.length) return NO_ARGS; imp.dismiss(); return { ok: true }; },
  };
}
