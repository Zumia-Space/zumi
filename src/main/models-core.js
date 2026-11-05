'use strict';
// Model list logic, Electron-free. Extracted from main.js (T-31 Tauri parity step 3) so the Electron main process
// and the Tauri sidecar answer `models:list` from ONE implementation. No new IPC name; behaviour is unchanged.
//
// Sources, in order: assets/models/models.json (bundled), a user-picked .vrm (settings.userModelPath), a test .vrm
// (--model / ZUMI_TEST_MODEL, never persisted). `urlPrefix` is the only per-host difference: Electron serves
// 'app://zumi/', the Tauri sidecar maps the same paths onto its own origin (tauri/sidecar/adapters.mjs appUrls).
const fs = require('node:fs');
const path = require('node:path');

const isVrmFile = (p) => typeof p === 'string' && /\.vrm$/i.test(p) && fs.existsSync(p) && fs.statSync(p).isFile();

/**
 * @param modelsDir     absolute folder holding models.json + the bundled .vrm files
 * @param loadSettings  () => settings object (the host's settings.json)
 * @param getTestModelPath  () => absolute path of the test model | null
 * @param isDefaultSample   (absolute path | null) => boolean: is this file the bundled VRoid sample (by bytes, default-model.js)?
 *                          Labels the 'user' slot "Zumi default" when it is the sample. Default: nothing is the sample.
 */
function createModels({ modelsDir, loadSettings, getTestModelPath = () => null, urlPrefix = 'app://zumi/', isDefaultSample = () => false }) {
  function readManifest() {
    let raw;
    try { raw = JSON.parse(fs.readFileSync(path.join(modelsDir, 'models.json'), 'utf8')); } catch { return []; }
    const list = raw && Array.isArray(raw.models) ? raw.models : [];
    const seen = new Set();
    const out = [];
    for (const m of list) {
      if (!m || typeof m.file !== 'string' || !/^[\w.-]+\.vrm$/i.test(m.file)) continue;
      const full = path.join(modelsDir, m.file);
      if (!fs.existsSync(full)) continue;
      const id = String(m.id || m.file.replace(/\.vrm$/i, ''));
      if (seen.has(id) || id === 'user' || id === 'test') continue;
      seen.add(id);
      out.push({ id, label: String(m.label || id), source: 'bundled', file: m.file, isDefault: m.default === true, bytes: fs.statSync(full).size, url: `${urlPrefix}models/${encodeURIComponent(m.file)}` });
    }
    return out;
  }

  // Slot -> absolute path of the only external .vrm files the host will serve.
  function externalPaths() {
    const s = loadSettings();
    const test = getTestModelPath();
    return { user: isVrmFile(s.userModelPath) ? s.userModelPath : null, test: isVrmFile(test) ? test : null };
  }

  function externalEntry(slot, file) {
    const st = fs.statSync(file);
    // owner words only; the file name travels in `file` (the picker shows it as a tooltip)
    const label = slot === 'user' ? 'Model from this PC' : 'Zumi (test build)';
    // the bundled default avatar (restored into the user slot) is named by key so each UI language says "Zumi default"
    const labelKey = slot === 'user' && isDefaultSample(file) ? 'model.zumiDefault' : undefined;
    return { id: slot, label, ...(labelKey ? { labelKey } : {}), source: slot, file: path.basename(file), path: file, bytes: st.size, url: `${urlPrefix}external/${slot}.vrm?v=${Math.floor(st.mtimeMs).toString(36)}-${st.size.toString(36)}` };
  }

  function listModels() {
    const bundled = readManifest();
    const ext = externalPaths();
    const models = [...bundled];
    if (ext.user) models.push(externalEntry('user', ext.user));
    if (ext.test) models.push(externalEntry('test', ext.test));
    const wanted = loadSettings().model;
    let selected = null;
    if (ext.test) selected = 'test';
    else if (wanted && models.some((m) => m.id === wanted)) selected = wanted;
    else { const d = bundled.find((m) => m.isDefault); selected = d ? d.id : null; }
    return { models, selected, bundledCount: bundled.length };
  }

  return { isVrmFile, readManifest, externalPaths, listModels };
}

module.exports = { createModels, isVrmFile };
