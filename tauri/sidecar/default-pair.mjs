// T-31-ROOM round 8 (owner 16-11: "2 model trong hình model cũ và model quần áo mới là 2 model mặc định của Zumi luôn nhé").
// Zumi's TWO default models, both offered in the model picker out of the box: the new outfit first (a fresh profile starts on
// it), the 0910 look second. The pinned files sit in <resources>/assets/models (scripts/lib/default-vrm.cjs stages both).
//
// They are NOT a new kind of model for the host: picking one puts its file into the existing 'user' slot
// ({ userModelPath, model: 'user' }), exactly as "Back to default model" always did. So the Rust asset route (external/user.vrm,
// re-checked against settings) and the room pack's avatar (pack_host::current_avatar reads userModelPath) follow the pick with no
// change, and Electron, which does not use this module, keeps its one default. This module only shapes the list and the pick.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DEFAULT_MODELS } = require('../../src/main/default-model.js');

// Owner words (CoS 16-11): "Zumi", and "Zumi cổ điển" (vi) / "Zumi classic" (en) by key, so each UI language says its own
// (src/renderer/i18n.js; the renderer's modelLabel prefers the key). The first also gets the picker's "(default)" suffix (isDefault).
const LABEL = { 'zumi-look4': 'Zumi', 'zumi-look3': 'Zumi classic' };
const LABEL_KEY = { 'zumi-look3': 'model.zumiClassic' };
const samePath = (a, b) => path.resolve(String(a)).toLowerCase() === path.resolve(String(b)).toLowerCase();

/** The pinned defaults present in `modelsDir`, in order. Present = a regular file of exactly the pinned size (the sha256 is checked on pick). */
export function presentDefaults(modelsDir, pins = DEFAULT_MODELS) {
  const out = [];
  for (const m of pins) {
    const file = path.join(modelsDir, m.file);
    let st = null;
    try { st = fs.lstatSync(file); } catch { /* absent */ }
    if (st && st.isFile() && st.size === m.bytes) out.push({ ...m, path: file });
  }
  return out;
}

/**
 * models:list with the defaults in front. `list` is models-core's answer ({ models, selected, bundledCount }).
 * The default whose file is in the 'user' slot right now carries that slot's url and stands in for the 'user' entry; the others
 * have no url until they are picked (the renderer loads a model only after models:select answered with the new list).
 */
export function withDefaultPair(list, { modelsDir, pins = DEFAULT_MODELS }) {
  const present = presentDefaults(modelsDir, pins);
  if (!present.length || !list || !Array.isArray(list.models)) return list;
  const user = list.models.find((m) => m && m.id === 'user');
  const active = user && user.path ? present.find((d) => samePath(d.path, user.path)) : null;
  const entries = present.map((d) => ({
    id: d.id, label: LABEL[d.id] || d.id, ...(LABEL_KEY[d.id] ? { labelKey: LABEL_KEY[d.id] } : {}), source: 'default', file: d.file, bytes: d.bytes, isDefault: d.id === pins[0].id,
    url: active === d ? user.url : null,
  }));
  return {
    ...list,
    models: [...entries, ...list.models.filter((m) => !(active && m.id === 'user'))],
    selected: active && list.selected === 'user' ? active.id : list.selected,
  };
}

/** Is `id` one of the defaults present in `modelsDir`? */
export const isDefaultId = (id, modelsDir, pins = DEFAULT_MODELS) => presentDefaults(modelsDir, pins).some((d) => d.id === id);

/**
 * models:select for a default: re-hash the file against its pin BEFORE any write, then { userModelPath, model: 'user' } only.
 * @returns {true | { error: 'missing' | 'unreadable' | 'sha_mismatch' }}
 */
export function pickDefault(id, { modelsDir, saveSettings, pins = DEFAULT_MODELS }) {
  const d = presentDefaults(modelsDir, pins).find((x) => x.id === id);
  if (!d) return { error: 'missing' };
  let sha;
  try { sha = crypto.createHash('sha256').update(fs.readFileSync(d.path)).digest('hex'); } catch { return { error: 'unreadable' }; }
  if (sha !== d.sha256) return { error: 'sha_mismatch' };
  saveSettings({ userModelPath: d.path, model: 'user' });
  return true;
}
