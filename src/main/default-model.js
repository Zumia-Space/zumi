'use strict';
// "Back to default model" (T-31 0.2.8, owner 20-10). MAIN owns the default: its file name and full sha256 are constants
// here, the renderer only sends a no-argument request. The handler re-hashes the file on disk and writes ONLY
// { userModelPath, model: 'user' } -- a refusal ({ error }) touches no setting, and API keys / every other key stay as
// they were (saveSettings merges). The installer ships the file as <resources>/models (afterPack, scripts/lib/default-vrm.cjs); looked for in, in order:
// $ZUMI_DEFAULT_MODEL_DIR, <app>/assets/models, <resources>/models. No machine-specific path lives in the code.
const path = require('node:path');
const DEFAULT_MODEL_FILE = 'zumi-default-0910.vrm';
const DEFAULT_MODEL_SHA256 = 'd1183bcf27bac3a587de7e383bcd8f6f4e0068e0a7c56653fa3e731e1460c372'; // of the file bytes, locked 30-10 (alpha.4, owner approved the change): same bytes as the pixiv-credit file except VRM1 meta.commercialUsage personalNonProfit -> corporation (scripts/tools/set-vrm-author.mjs --commercial-usage)
const DEFAULT_MODEL_BYTES = 9141588; // same file; the cheap pre-check before hashing (PIN-MANIFEST.json agrees, check:default-sample)
// Every byte-identity of the VRoid sample that may sit on a user's disk: the shipped file plus the earlier builds
// (0.2.7 authors "Zumia", locked 09-10; 3K FOREST file before the pixiv meta credit, 24-10; the pixiv-credit file of 0.2.8-0.3.0-alpha.3), which an already-installed
// copy can still have as its user model. All are the sample; keep every old sha so those copies are still recognised.
const KNOWN_SAMPLES = [
  { sha256: DEFAULT_MODEL_SHA256, bytes: DEFAULT_MODEL_BYTES },
  { sha256: '310203381f11d5c045af5f3f37ae300d3c400916edf3484ba78c30c6a7eab0f1', bytes: 9141592 },
  { sha256: '7b28695a81cf53cd878ac25d19bd6c56e4310a50453968f4cdbd93234ec3d240', bytes: 9142044 },
  { sha256: 'd01f7273cd8480d28252bfac8f907d070bc10a8731e1b4def224c18387de4e8a', bytes: 9142032 },
];

// Is this file the bundled sample (current or 0.2.7 build)? Identity is the BYTES (size, then sha256 against KNOWN_SAMPLES),
// never the name or folder: renaming or moving the file does not turn the sample into a user model. Sync + cached by
// path/mtime/size so listModels() can call it freely; the 9 MB hash runs only for a file of exactly a known size, once per change.
// samples / expectedSha256+expectedBytes are test seams (they replace the list); main.js never passes them.
function createDefaultSampleDetector({ fs, crypto, samples: samplesOverride, expectedSha256, expectedBytes }) {
  const samples = samplesOverride
    || (expectedSha256 !== undefined || expectedBytes !== undefined ? [{ sha256: expectedSha256, bytes: expectedBytes }] : KNOWN_SAMPLES);
  const cache = new Map();
  function isDefaultSample(file) {
    if (!file) return false;
    let st;
    try { st = fs.statSync(file); } catch { return false; }
    if (!st.isFile()) return false;
    const candidates = samples.filter((x) => x.bytes === st.size);
    if (!candidates.length) return false;
    const key = `${st.mtimeMs}:${st.size}`;
    const hit = cache.get(file);
    if (hit && hit.key === key) return hit.value;
    let value = false;
    try { const h = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); value = candidates.some((x) => x.sha256 === h); } catch { /* unreadable: not provably the sample, and not usable as a model either */ }
    cache.set(file, { key, value });
    return value;
  }
  return { isDefaultSample };
}

function defaultModelDirs({ env = {}, modelsDir, resourcesPath }) {
  return [env.ZUMI_DEFAULT_MODEL_DIR, modelsDir, resourcesPath && path.join(resourcesPath, 'models')].filter(Boolean);
}

// Streamed, so a 9 MB .vrm never blocks the main process.
function sha256File(fs, crypto, file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('error', reject);
    s.on('data', (c) => h.update(c));
    s.on('end', () => resolve(h.digest('hex')));
  });
}

// The ONE resolution of the bundled default: first <dir>/zumi-default-0910.vrm found, re-hashed against the pin. Used by the
// "Back to default model" channel and by the first-run adoption below, so both accept exactly the same file.
// Returns { file } or { error: 'missing' | 'unreadable' | 'sha_mismatch' }.
async function resolveVerifiedDefault({ fs, crypto, dirs, wantSha = DEFAULT_MODEL_SHA256 }) {
  const file = dirs.map((d) => path.join(d, DEFAULT_MODEL_FILE)).find((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } });
  if (!file) return { error: 'missing' };
  let sha;
  try { sha = await sha256File(fs, crypto, file); } catch { return { error: 'unreadable' }; }
  if (sha !== wantSha) return { error: 'sha_mismatch' };
  return { file };
}

// deps: { ipcMain, fs, crypto, saveSettings, listModels, sayEvent, dirs: string[], expectedSha256? } -- expectedSha256 is a
// test seam only; main.js never passes it, so production always pins DEFAULT_MODEL_SHA256.
function registerRestoreDefault(deps) {
  const { ipcMain, fs, crypto, saveSettings, listModels, sayEvent, dirs } = deps;
  const wantSha = deps.expectedSha256 || DEFAULT_MODEL_SHA256;
  // NO handler arguments are read: the channel can only ever restore the one locked file.
  ipcMain.handle('models:restore-default', async () => {
    const r = await resolveVerifiedDefault({ fs, crypto, dirs, wantSha });
    if (r.error) return { error: r.error };
    saveSettings({ userModelPath: r.file, model: 'user' });
    sayEvent('look');
    return listModels();
  });
}

// First run (T-31 0.2.8): a profile whose settings.json has NO `model` key at all (never picked, never restored) starts on the
// bundled default instead of an empty stage. Same rule as rooms: only an absent key adopts. Any saved value -- a bundled id, 'user'
// (the user's own file OR an earlier default), even null, even when its file is gone -- is an explicit state and is never touched
// (a missing saved file keeps today's behaviour: no avatar until the user picks one). A test model (--model) skips it, and a
// bundled manifest default already gives an avatar, so neither is overridden. A missing/changed default file changes nothing.
// Returns 'adopted' | 'kept' | { error }.
async function adoptDefaultIfNoModelKey({ fs, crypto, loadSettings, saveSettings, listModels, dirs, hasTestModel = false, expectedSha256 }) {
  if (Object.prototype.hasOwnProperty.call(loadSettings(), 'model')) return 'kept';
  if (hasTestModel || listModels().selected) return 'kept';
  const r = await resolveVerifiedDefault({ fs, crypto, dirs, wantSha: expectedSha256 || DEFAULT_MODEL_SHA256 });
  if (r.error) return { error: r.error };
  saveSettings({ userModelPath: r.file, model: 'user' });
  return 'adopted';
}

module.exports = { DEFAULT_MODEL_FILE, DEFAULT_MODEL_SHA256, DEFAULT_MODEL_BYTES, KNOWN_SAMPLES, defaultModelDirs, registerRestoreDefault, adoptDefaultIfNoModelKey, createDefaultSampleDetector };
