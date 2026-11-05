// T-31 free LLM S1: the talk-panel 18+ confirm wiring (TAURI ONLY; app.js passes null in Electron).
//
// The sidecar fails a Gemini turn closed with `age_confirm_required` until settings.json carries `age18Confirmed`.
// Director shows the one-line reason and asks the UI for the confirm; the UI offers the stored confirm plus a
// one-click "use another provider". That switch must not be hard-coded to Groq: it offers the next usable default
// preset in the approved order (Groq, then OpenRouter :free, then Cloudflare), skipping Gemini (the blocked one).
// "Usable" = the user has a saved key for it, or it is the free default provider. If none is usable, open the
// provider picker instead of silently switching to a provider whose key does not exist.
//
// Pure choice function + a thin wiring factory, both driven by scripts/free-llm-talk-check.mjs.

export const SWITCH_ORDER = Object.freeze(['groq', 'openrouter', 'cloudflare']);

/**
 * The next usable default preset after `currentId`, wrapping once around the order and never returning Gemini.
 * @param {{ currentId?: string|null, order?: string[], hasKey?: (id: string) => boolean, freeDefault?: string|null }} o
 * @returns {string|null} the provider id, or null when no candidate is usable (the caller opens the picker).
 */
export function chooseNextProvider({ currentId = null, order = SWITCH_ORDER, hasKey = () => false, freeDefault = null } = {}) {
  const candidates = (Array.isArray(order) ? order : SWITCH_ORDER).filter((id) => id !== 'gemini');
  if (!candidates.length) return null;
  const at = candidates.indexOf(currentId);
  for (let n = 1; n <= candidates.length; n++) {
    const id = candidates[((at + n) % candidates.length + candidates.length) % candidates.length];
    if (id === freeDefault || hasKey(id) === true) return id;
  }
  return null;
}

/**
 * @param {{ zumi: object, openPicker?: () => void, onSwitched?: () => void }} o
 * `zumi.ai.presetList()` answers the approved order (`free`) and the per-provider `keys` booleans; `openPicker`
 * reveals Settings > AI & Usage, where the provider picker and the key field live; `onSwitched` refreshes an open
 * settings card after a live provider switch (the card does not observe this panel's rpc).
 */
export function createAgeConfirm({ zumi, openPicker = () => {}, onSwitched = () => {} }) {
  const confirm = () => zumi.ai.setPresetSettings({ age18Confirmed: true });
  const switchProvider = async () => {
    let list = null;
    try { list = await zumi.ai.presetList(); } catch { list = null; }
    const listed = Boolean(list && Array.isArray(list.free) && list.free.length);
    const order = listed ? list.free.map((p) => p.id) : [...SWITCH_ORDER];
    const keys = (listed && list.keys) || {};
    // The product's default preset (Gemini) is usable without a key, but it is the blocked provider here; with no
    // answer from the sidecar nothing is known to be usable, so the picker opens instead of guessing Groq.
    const freeDefault = listed ? order[0] || null : null;
    let current = null;
    try { const p = await zumi.ai.provider(); current = p && p.id; } catch { current = null; }
    const target = chooseNextProvider({ currentId: current, order, hasKey: (id) => keys[id] === true, freeDefault });
    if (!target) { openPicker(); return { ok: false, reason: 'no_usable_provider' }; }
    try {
      const result = await zumi.ai.setProvider(target);
      if (result && result.ok) onSwitched();
      return result;
    } catch { return { ok: false, error: 'switch_failed' }; }
  };
  return { confirm, switchProvider };
}
