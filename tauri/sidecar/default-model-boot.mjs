// T-31 Tauri parity (25-10): first-run adoption of the bundled default model, same rule and same shared module as Electron 0.2.9
// (src/main/default-model.js adoptDefaultIfNoModelKey, main.js:2221). A profile whose settings.json has no `model` key starts on
// the verified default (<resources>/assets/models/zumi-default-0910.vrm, staged by tauri/stage-bundle.mjs); any saved value is kept.
// main.mjs starts this once and awaits it before answering the first request, so models:list never sees the empty first state.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { defaultModelDirs, adoptDefaultIfNoModelKey, registerRestoreDefault, createDefaultSampleDetector } = require('../../src/main/default-model.js');

/**
 * @returns {Promise<'adopted'|'kept'|{error:'missing'|'unreadable'|'sha_mismatch'}>} never rejects; the outcome is logged once.
 * expectedSha256 is a test seam (production always pins the sha in default-model.js).
 */
export async function adoptDefaultOnBoot({ settings, saveSettings, listModels, env = process.env, modelsDir, testModelPath = null, expectedSha256, log = () => {} }) {
  let out;
  try {
    out = await adoptDefaultIfNoModelKey({
      fs, crypto, loadSettings: settings, saveSettings, listModels,
      dirs: defaultModelDirs({ env, modelsDir }), hasTestModel: !!testModelPath, expectedSha256,
    });
  } catch (e) {
    out = { error: 'unreadable' };
    log(`[default-model] first-run adopt failed: ${e && e.message}`);
  }
  log(`[default-model] first-run adopt: ${typeof out === 'string' ? out : out.error}`);
  return out;
}

// The bundled VRoid sample is identified by BYTES (pinned size + sha256), never by name. One cached detector for the sidecar;
// models-core labels the 'user' slot "Zumi default" with it.
export const defaultSampleDetector = createDefaultSampleDetector({ fs, crypto });

/**
 * "Về model mặc định" (models:restore-default, Electron ab66e9b/05bf103): ONE no-argument handler. It restores only the locked
 * default file (found in `dirs`, re-hashed against the pinned sha256 BEFORE any write) and writes { userModelPath, model } only.
 * Reuses Electron's registerRestoreDefault unchanged through a one-channel ipcMain stand-in, so the two lines cannot drift.
 * @returns {() => Promise<object>} resolves with the full model list, or { error: 'missing'|'unreadable'|'sha_mismatch' }; never takes an argument.
 */
export function createRestoreDefault({ saveSettings, listModels, sayEvent = () => {}, env = process.env, modelsDir, expectedSha256 }) {
  let handler = null;
  registerRestoreDefault({
    ipcMain: { handle: (channel, fn) => { if (channel === 'models:restore-default') handler = fn; } },
    fs, crypto, saveSettings, listModels, sayEvent, dirs: defaultModelDirs({ env, modelsDir }), expectedSha256,
  });
  return () => handler();
}
