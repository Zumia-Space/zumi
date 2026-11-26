// T-31 P3-A: what a non-public (owner / selftest) Tauri stage adds to the bundle resources.
//
// Parity with scripts/builder-selftest.cjs (the Electron OWNER build):
//  - the 7 looping room videos are packed from rooms.json `localDir` (or ZUMI_ROOMS_SRC_DIR) into <resources>/<packagedDir>
//    (= rooms-video); every file is checked against the manifest's size + sha256 first, so a build never ships a video the
//    app would then refuse to list (scene-rooms.mjs re-checks the same pins at run time);
//  - flavour.json carries the owner values. It sits at the resource root = beside the host exe, where lib.rs looks for it,
//    so the INSTALLER carries it (the public stage has no file, and no videos).
// The public flavour stages neither; verifyStagedFlavour fails a stage that holds either one by mistake.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

import { FLAVOUR_FILE, flavourFileText } from './sidecar/flavour.mjs';
import { ownerValue } from '../src/main/owner-values.js';

const { isZumiOnly, isOfficialDenied } = createRequire(import.meta.url)('../scripts/lib/zumi-only.cjs');

const repo = path.resolve(import.meta.dirname, '..');
export const ROOMS_MANIFEST = path.join(repo, 'assets', 'rooms-video', 'rooms.json');
const PLAIN_FILE = /^[\w.-]+\.mp4$/i;
const PLAIN_DIR = /^[\w-]+$/;

const sha256Of = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function readManifest(manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (typeof manifest.packagedDir !== 'string' || !PLAIN_DIR.test(manifest.packagedDir)) throw new Error('rooms manifest: packagedDir must be a plain folder name');
  if (!Array.isArray(manifest.rooms) || !manifest.rooms.length) throw new Error('rooms manifest: rooms must be a non-empty array');
  for (const r of manifest.rooms) if (!r || typeof r.file !== 'string' || !PLAIN_FILE.test(r.file)) throw new Error(`rooms manifest: file must be a plain *.mp4 name (${r && r.file})`);
  return manifest;
}

/** Why `file` is not the video `room` pins (size, then sha256), or null when it is. */
function pinProblem(file, room) {
  let st;
  try { st = fs.statSync(file); } catch { return `missing room video ${file}`; }
  if (!st.isFile()) return `missing room video ${file} (not a file)`;
  if (st.size !== room.bytes) return `room video ${file}: size ${st.size} != ${room.bytes} pinned in rooms.json`;
  if (sha256Of(file) !== room.sha256) return `room video ${file}: sha256 does not match rooms.json`;
  return null;
}

/**
 * Copy the manifest's videos into `<stageDir>/<packagedDir>`. The source folder is env ZUMI_ROOMS_SRC_DIR, else the
 * manifest's localDir. Throws (the build must fail) on a missing, resized or changed file. Returns `{ count, bytes, dest }`.
 */
export function stageRoomVideos(stageDir, { env = process.env, manifestPath = ROOMS_MANIFEST } = {}) {
  const manifest = readManifest(manifestPath);
  const srcDir = env.ZUMI_ROOMS_SRC_DIR ? path.resolve(env.ZUMI_ROOMS_SRC_DIR) : (manifest.localDir || ownerValue('roomsVideoDir', null));
  if (typeof srcDir !== 'string' || !srcDir) throw new Error('no room video source: set ZUMI_ROOMS_SRC_DIR, rooms.json localDir or the owner values roomsVideoDir');
  for (const r of manifest.rooms) {
    const problem = pinProblem(path.join(srcDir, r.file), r);
    if (problem) throw new Error(problem);
  }
  const dest = path.join(stageDir, manifest.packagedDir);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  let bytes = 0;
  for (const r of manifest.rooms) { fs.copyFileSync(path.join(srcDir, r.file), path.join(dest, r.file)); bytes += r.bytes; }
  return { count: manifest.rooms.length, bytes, dest };
}

/** Problems with the staged videos under `<dir>/<packagedDir>`: empty = exactly the manifest's files, all pinned. */
export function verifyStagedRoomVideos(dir, manifest) {
  const problems = [];
  const root = path.join(dir, manifest.packagedDir);
  for (const r of manifest.rooms) {
    const problem = pinProblem(path.join(root, r.file), r);
    if (problem) problems.push(problem);
  }
  const listed = new Set(manifest.rooms.map((r) => r.file));
  let present = [];
  try { present = fs.readdirSync(root); } catch { /* reported above as missing */ }
  for (const name of present) if (!listed.has(name)) problems.push(`unlisted file in ${manifest.packagedDir}: ${name}`);
  return problems;
}

/** Write (owner/selftest) or remove (public) `<stageDir>/flavour.json`. */
export function stageFlavourFile(stageDir, name) {
  const text = flavourFileText(name);
  const file = path.join(stageDir, FLAVOUR_FILE);
  if (text === null) fs.rmSync(file, { force: true });
  else fs.writeFileSync(file, text);
}

const walkRel = (dir, base = dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkRel(full, base, out); else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
};

/**
 * Owner / selftest installers carry the Room pack unpacked at `<stage>/packs-seed/plugin.room-preview`; the host loads it as its owner
 * dev folder (pack_host::bundled_pack_dir), so a clean install and an upgrade show the Phòng tab with no store and no hidden step
 * (alpha.3 shipped no pack). The source is the folder `packs/room-preview/build-pack.mjs` writes (ZUMI_ROOM_PACK_SEED). Public and
 * official builds never stage it. No source set = nothing staged (other owner builds stay as they were); a source that is wrong is
 * refused: another id, a file missing or not matching its listed sha256, an unlisted file.
 */
export function stageRoomPackSeed(stageDir, name, { srcDir = undefined, env = process.env } = {}) {
  if (name !== 'owner' && name !== 'selftest') return { count: 0 };
  const src = srcDir ?? env.ZUMI_ROOM_PACK_SEED;
  if (!src) return { count: 0 };
  const { count, version } = checkRoomPackFolder(src);
  const dest = path.join(stageDir, 'packs-seed', 'plugin.room-preview');
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
  return { count, version, dest };
}

/** Throws unless `dir` is a whole plugin.room-preview pack: manifest id, every listed file present and equal to its size/sha256, no unlisted file. */
function checkRoomPackFolder(dir) {
  const manifestFile = path.join(dir, 'zumi-pack.json');
  if (!fs.existsSync(manifestFile)) throw new Error(`room pack ${dir}: no zumi-pack.json`);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  if (manifest.id !== 'plugin.room-preview') throw new Error(`room pack ${dir}: id ${manifest.id}, expected plugin.room-preview`);
  const listed = new Set(['zumi-pack.json']);
  for (const f of manifest.files || []) {
    listed.add(f.path);
    const file = path.join(dir, ...f.path.split('/'));
    if (!fs.existsSync(file)) throw new Error(`room pack: ${f.path} is listed but missing`);
    const bytes = fs.readFileSync(file);
    if (bytes.length !== f.bytes || crypto.createHash('sha256').update(bytes).digest('hex') !== f.sha256) throw new Error(`room pack: ${f.path} does not match its listed size/sha256`);
  }
  for (const rel of walkRel(dir)) if (!listed.has(rel)) throw new Error(`room pack: unlisted file ${rel}`);
  return { count: listed.size, version: String(manifest.version || '') };
}

/**
 * The gate for owner/selftest bundles (stage, unpacked app and installer payload alike): the Room pack must be there and whole.
 * An owner installer without it is the alpha.3 bug (no Room tab on a clean install), so a missing pack FAILS the build, never a silent skip.
 */
export function verifyStagedRoomPack(dir) {
  const rel = 'packs-seed/plugin.room-preview';
  try { checkRoomPackFolder(path.join(dir, ...rel.split('/'))); } catch (e) { return [`${rel} missing or not whole in an owner bundle (the Room tab would not appear): ${e.message}`]; }
  return [];
}

/** Write <stageDir>/install-manifest.json: size and sha256 of every staged file. It is generated, not an asset, so the licence gate lists nothing here. */
export function stageInstallManifest(stageDir) {
  const name = 'install-manifest.json';
  const files = {};
  for (const rel of walkRel(stageDir)) {
    if (rel === name || path.basename(rel).startsWith('.')) continue;
    const bytes = fs.readFileSync(path.join(stageDir, rel));
    files[rel] = { bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  }
  fs.writeFileSync(path.join(stageDir, name), JSON.stringify({ files }));
}

/**
 * Problems with `dir` (a stage or an unpacked app) for flavour `name`. public: no flavour.json, no room videos and no
 * Zumi-only asset at all (scripts/lib/zumi-only.cjs: the avatar, the default room and its plates; open-core ADR 2026-10-28).
 * official: no flavour.json, no room videos (since the slim installer, owner 11-11 mkt-q1, they are Marketplace packs) and no
 * Zumi-only asset outside its allow-list. public and official: no packs-seed (the Room pack ships in owner builds only).
 * owner/selftest: flavour.json byte-equal to the pinned text, every pinned room video present, and the Room pack whole.
 */
export function verifyStagedFlavour(dir, name, { manifestPath = ROOMS_MANIFEST } = {}) {
  const manifest = readManifest(manifestPath);
  const problems = [];
  const file = path.join(dir, FLAVOUR_FILE);
  const videos = path.join(dir, manifest.packagedDir);
  const want = flavourFileText(name);
  if (want === null) {
    if (fs.existsSync(file)) problems.push(`${FLAVOUR_FILE} present in a public bundle`);
    // public and, since the slim installer (owner 11-11 mkt-q1), official: no room video; the 7 rooms are Marketplace packs.
    if (fs.existsSync(videos)) problems.push(`${manifest.packagedDir} present in a ${name} bundle`);
    if (fs.existsSync(path.join(dir, 'packs-seed'))) problems.push(`packs-seed present in a ${name} bundle (the Room pack ships in owner builds only)`);
    const denied = name === 'official' ? isOfficialDenied : isZumiOnly;
    for (const rel of walkRel(dir)) if (denied(rel)) problems.push(`Zumi-only asset in a ${name} bundle: ${rel}`);
    return problems;
  }
  let have = null;
  try { have = fs.readFileSync(file, 'utf8'); } catch { /* reported below */ }
  if (have === null) problems.push(`${FLAVOUR_FILE} missing from a ${name} bundle`);
  else if (have !== want) problems.push(`${FLAVOUR_FILE} differs from the pinned ${name} text`);
  if (!fs.existsSync(videos)) problems.push(`${manifest.packagedDir} missing from a ${name} bundle`);
  else problems.push(...verifyStagedRoomVideos(dir, manifest));
  problems.push(...verifyStagedRoomPack(dir));
  return problems;
}

/** The official payload carries no room manifest: the app never reads it, and its notes name a path on the owner's machine. The asset repo's copy is pinned, so it stays there. */
export function stripOfficialManifest(stageDir, name) {
  if (name === 'official') fs.rmSync(path.join(stageDir, 'resources-pinned', 'room-v2', 'PIN-MANIFEST.json'), { force: true });
}
