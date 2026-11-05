// New HUD panel preferences (T-31 hud-panels, PLAN section 3): which design shows (T1 task card / T2 step list / T3 log
// and chart, or none) and where it sits (in place at the bottom of the left group, or a group below-left / below-right).
// Renderer-only by design -- main is frozen, so there is no IPC and no settings.json entry; localStorage remembers the
// pick, the same renderer-only store room/float-holo-prefs.js uses. Pure module: no DOM at call time, no import from
// main, so scripts/check-hud-panels.mjs runs it under plain Node.
//
// What each place means (PLAN section 3):
//   inplace     -- compact strip at the bottom of .hud-left, expanding to the full design only while Zumi works on the
//                  focused task (panel-logic.js isWorkingOn); anh's option (b).
//   below-left  -- the full panel, always open, in a new .hud-group under the 48% arm-safe line (yieldLoop fades it for
//                  a passing arm, exactly like the two existing groups).
//   below-right -- the same, on the other side.
// Default: T1 in place (Pi decision 2026-10-23, PLAN section 10). Nothing shows unless HUD style != Off, and HUD style
// defaults to Off, so the shipped default view does not change.
export const PANEL_DESIGNS = Object.freeze(['none', 't1', 't2', 't3']);
export const PANEL_PLACES = Object.freeze(['inplace', 'below-left', 'below-right']);
/** The places the settings select offers. The two below places stay in PANEL_PLACES (hud.js still paints them) but are
 *  not offered: at the small window they spilled under the 46% arm-safe line (Opus review 2026-10-24), so a saved below
 *  value is read back as in place. */
export const OFFERED_PLACES = Object.freeze(['inplace']);
export const DEFAULT_PANEL = Object.freeze({ design: 't1', place: 'inplace' });
export const PANEL_PREF_KEY = 'zumi.hud.panel';

const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/** Validates a stored/requested pair. An unknown or absent half falls back to that half's default, so a stale key or a
 *  hand-edited store can never hide the panel or place it somewhere it was never designed for. -> a fresh copy. */
export function resolvePanel(prefs) {
  const p = prefs && typeof prefs === 'object' && !Array.isArray(prefs) ? prefs : {};
  const design = own(p, 'design') && PANEL_DESIGNS.includes(p.design) ? p.design : DEFAULT_PANEL.design;
  const place = own(p, 'place') && OFFERED_PLACES.includes(p.place) ? p.place : DEFAULT_PANEL.place;
  return { design, place };
}

/** Reads the saved pair (defaults on empty, bad JSON, a missing/disabled storage or one that throws). */
export function readPanelPrefs(storage = (typeof localStorage !== 'undefined' ? localStorage : null)) {
  try {
    const raw = storage && storage.getItem(PANEL_PREF_KEY);
    return resolvePanel(raw ? JSON.parse(raw) : null);
  } catch { return resolvePanel(null); }
}

/** Persists ONLY the two ids and returns the resolved pair, so the caller applies exactly what the next launch reads.
 *  A disabled storage just does not remember. */
export function savePanelPrefs(prefs, storage = (typeof localStorage !== 'undefined' ? localStorage : null)) {
  const resolved = resolvePanel(prefs);
  try {
    if (storage) storage.setItem(PANEL_PREF_KEY, JSON.stringify({ design: resolved.design, place: resolved.place }));
  } catch { /* storage disabled: just do not remember */ }
  return resolved;
}
