// "Back to default model" (T-31, owner 20-10: "anh chọn 2 model mới test thử em chỉnh lại model mặc định
// giúp anh được ko cho dễ qc"). MAIN owns the locked default (file location + full sha256, src/main/default-model.js):
// the renderer sends a no-argument `zumi.restoreDefaultModel()` and main re-hashes the file, refuses BEFORE any write
// when it is missing / unreadable / changed ({ error }), and otherwise stores { userModelPath, model: 'user' } only.
//
// This module holds the file NAME (for the message and to hide the item) and every renderer decision, with no DOM and
// no IPC, so scripts/check-default-model.mjs can exercise the real behaviour in plain Node (the repo's check:* convention).
export const DEFAULT_MODEL_FILE = 'zumi-default-0910.vrm';

// Windows paths reach the renderer with either separator and the case is not meaningful: compare the file name only.
const baseName = (p) => String(p || '').replace(/\\/g, '/').split('/').pop().toLowerCase();

/**
 * True when the model list main returned is ALREADY showing the default file, so the menu item hides: the 'user' slot
 * (id 'user', source 'user') whose file name is the default's. A built-in model or a test --model is NOT the default.
 * @param {{ models?: Array<{id:string, source?:string, path?:string}>, selected?: string|null }} list
 */
export function isDefaultModelActive(list) {
  if (!list || !Array.isArray(list.models)) return false;
  const m = list.models.find((x) => x && x.id === list.selected);
  return Boolean(m && m.id === 'user' && m.source === 'user' && baseName(m.path) === DEFAULT_MODEL_FILE);
}

/** Dropdown text for a model entry: the host's `labelKey` (translated) when it sent one, else its plain `label`. */
export function modelLabel(m, t) {
  return m && m.labelKey ? t(m.labelKey) : String((m && m.label) || '');
}

/** i18n key for a refusal from main, or null when the restore succeeded. */
export function defaultModelErrorKey(result) {
  if (!result || !result.error) return null;
  if (result.error === 'sha_mismatch') return 'app.defaultModelWrong';
  if (result.error === 'unreadable') return 'app.defaultModelUnreadable';
  return 'app.defaultModelMissing';
}

/**
 * One click: ask main (no arguments) to restore the locked default.
 * Refusals (missing / unreadable / changed bytes) come back as { error } from main and change nothing -- onList (the
 * model switch) never runs, onError carries the i18n key, and no other setting is touched.
 * @param {{ list: object, restoreDefault: () => Promise<any>,
 *           onList?: (list:any)=>void, onError?: (key:string)=>void }} io
 */
export async function restoreDefaultModel({ list, restoreDefault, onList, onError }) {
  if (isDefaultModelActive(list)) return { ok: false, reason: 'already_default' };
  const result = await restoreDefault();
  const key = defaultModelErrorKey(result);
  if (key) { if (onError) onError(key); return { ok: false, reason: key, result }; }
  if (!result || !Array.isArray(result.models)) return { ok: false, reason: 'cancelled', result };
  if (onList) onList(result);
  return { ok: true, list: result };
}
