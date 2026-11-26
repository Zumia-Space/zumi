'use strict';
// Build-time inclusion of the default avatar (T-31 0.2.8, owner 24-10 "ok nen kem model goc"). The .vrm is a restrictive
// asset (VRoid AvatarSample_K lineage) and this repo is AGPL/OSS, so the file is NEVER in git: electron-builder's
// afterPack hook copies it from ZUMI_DEFAULT_VRM_PATH (default: the owner values' defaultAvatarSource) into
// <resources>/models/ next to LICENSE-zumi-default.txt. Missing file / wrong size / wrong sha256 => throw => no installer.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DEFAULT_MODEL_FILE, DEFAULT_MODEL_SHA256, DEFAULT_MODELS } = require('../../src/main/default-model.js');
const { ownerValue } = require('../../src/main/owner-values.js');

const PIN_DIR = path.join(__dirname, '..', '..', 'resources-pinned', 'default-model');
const pin = () => JSON.parse(fs.readFileSync(path.join(PIN_DIR, 'PIN-MANIFEST.json'), 'utf8'));
const sha256Of = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function resolveSource(env = process.env) {
  const p = pin();
  const src = env[p.sourceEnvVar] || ownerValue('defaultAvatarSource', null);
  return src ? path.resolve(src) : null; // null: no source known on this machine (verifySource says how to set one)
}

// Round 8: the second default model (the new outfit), pinned in PIN-MANIFEST.json `pair`. The Tauri bundle ships both; Electron's
// afterPack keeps shipping the first pin only (it bundles no model list). [{ file, bytes, sha256, src }], the main pin first.
function pairPins(p = pin()) { return [p, ...(Array.isArray(p.pair) ? p.pair : [])]; }
function resolveSources(env = process.env) {
  return pairPins().map((x, i) => {
    const src = i === 0 ? resolveSource(env) : (env[x.sourceEnvVar] || ownerValue(x.ownerValue, null));
    return { file: x.file, bytes: x.bytes, sha256: x.sha256, src: src ? path.resolve(src) : null };
  });
}
function verifyPairSources(env = process.env) {
  const pins = pairPins();
  if (pins.length !== DEFAULT_MODELS.length || !DEFAULT_MODELS.every((m) => pins.some((x) => x.file === m.file && x.sha256 === m.sha256 && x.bytes === m.bytes))) {
    throw new Error('default avatar pair out of sync: PIN-MANIFEST.json (main pin + pair) != src/main/default-model.js DEFAULT_MODELS');
  }
  verifySource(env);
  for (const s of resolveSources(env).slice(1)) {
    const x = pins.find((q) => q.file === s.file);
    let st; try { st = s.src ? fs.statSync(s.src) : null; } catch { st = null; }
    if (!st || !st.isFile()) throw new Error(`default avatar missing: ${s.src || '(no source)'}. Set ${x.sourceEnvVar} to ${s.file} (the file is deliberately not in git).`);
    if (st.size !== s.bytes) throw new Error(`default avatar size mismatch: ${s.src} is ${st.size} bytes, pin says ${s.bytes}`);
    if (sha256Of(s.src) !== s.sha256) throw new Error(`default avatar sha256 mismatch: ${s.src}, pin says ${s.sha256}`);
  }
  return resolveSources(env);
}

// Returns the verified source path; throws a self-explanatory Error otherwise.
function verifySource(env = process.env) {
  const p = pin();
  const src = resolveSource(env);
  if (!src) throw new Error(`default avatar source unknown: set ${p.sourceEnvVar} to ${p.file} (the file is deliberately not in git).`);
  if (p.file !== DEFAULT_MODEL_FILE || p.sha256 !== DEFAULT_MODEL_SHA256) {
    throw new Error(`default avatar pin out of sync: PIN-MANIFEST (${p.file} ${p.sha256}) != src/main/default-model.js (${DEFAULT_MODEL_FILE} ${DEFAULT_MODEL_SHA256})`);
  }
  let st;
  try { st = fs.statSync(src); } catch { st = null; }
  if (!st || !st.isFile()) throw new Error(`default avatar missing: ${src}. Set ${p.sourceEnvVar} to ${p.file} (the file is deliberately not in git).`);
  if (st.size !== p.bytes) throw new Error(`default avatar size mismatch: ${src} is ${st.size} bytes, pin says ${p.bytes}`);
  const got = sha256Of(src);
  if (got !== p.sha256) throw new Error(`default avatar sha256 mismatch: ${src} is ${got}, pin says ${p.sha256}`);
  return src;
}

// What stageIntoResources() puts into <resources>/. The licence gate (scripts/check-third-party.mjs) reads this list, so a file
// added here is gated automatically.
const STAGED_DIR = 'models';
function stagedFiles() { const p = pin(); return [p.file, p.licenceNoticeFile].map((f) => `${STAGED_DIR}/${f}`); }

// electron-builder afterPack context: { appOutDir }. Copies the model + licence notice, then re-hashes the copy.
function stageIntoResources(appOutDir, env = process.env) {
  const p = pin();
  const src = verifySource(env);
  const dir = path.join(appOutDir, 'resources', STAGED_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const dst = path.join(dir, p.file);
  fs.copyFileSync(src, dst);
  fs.copyFileSync(path.join(PIN_DIR, p.licenceNoticeFile), path.join(dir, p.licenceNoticeFile));
  if (sha256Of(dst) !== p.sha256) throw new Error(`default avatar copy failed verification: ${dst}`);
  return dst;
}

// Tauri bundle (T-31 parity, 25-10): the sidecar resolves bundled models from <resource root>/assets/models (adapters.mjs modelsDir),
// so the same verified file + licence notice go there. Verified BEFORE any write: a refused source leaves the stage dir untouched.
function stageIntoTauriBundle(stageDir, env = process.env) {
  const p = pin();
  const sources = verifyPairSources(env); // both, before any write
  const dir = path.join(stageDir, 'assets', 'models');
  fs.mkdirSync(dir, { recursive: true });
  for (const x of sources) fs.copyFileSync(x.src, path.join(dir, x.file));
  fs.copyFileSync(path.join(PIN_DIR, p.licenceNoticeFile), path.join(dir, p.licenceNoticeFile));
  return path.join(dir, p.file);
}

// The bundle gate: what a staged or built Tauri dir must contain. Returns a list of problems (empty = ok).
// Credits = the licence notice next to the model (names 3K FOREST + pixiv); the model's own VRM meta is covered by the pinned sha256.
function verifyStagedDefaultModel(rootDir, p = pin()) {
  const dir = path.join(rootDir, 'assets', 'models');
  const problems = [];
  for (const x of pairPins(p)) {
    const model = path.join(dir, x.file);
    let st = null;
    try { st = fs.statSync(model); } catch { /* reported below */ }
    if (!st || !st.isFile()) problems.push(`default model missing: ${model}`);
    else if (st.size !== x.bytes) problems.push(`default model size ${st.size} != pinned ${x.bytes}: ${model}`);
    else if (sha256Of(model) !== x.sha256) problems.push(`default model sha256 differs from the pin: ${model}`);
  }
  const noticeFile = path.join(dir, p.licenceNoticeFile);
  let text = null;
  try { text = fs.readFileSync(noticeFile, 'utf8'); } catch { /* reported below */ }
  if (text === null) problems.push(`credits/licence notice missing: ${noticeFile}`);
  else if (!/3K FOREST/.test(text) || !/pixiv/i.test(text)) problems.push(`credits/licence notice must name 3K FOREST and pixiv: ${noticeFile}`);
  return problems;
}

module.exports = { resolveSource, resolveSources, verifySource, verifyPairSources, stageIntoResources, stagedFiles, stageIntoTauriBundle, verifyStagedDefaultModel };
