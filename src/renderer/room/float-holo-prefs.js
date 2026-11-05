// T-31 float-holo QC switch (renderer-only): the owner judges the hologram look on the real app, so what the r6 box
// sweep could only do from the harness is now a Settings choice -- "Kiểu hologram" (the three TOP3 parameter sets)
// and "Màu viền" (the two colours the sweep measured). Pure module: no DOM at call time, no IPC, no import from
// main, so Electron main stays frozen. app.js wires the two selects and localStorage remembers the pick (the same
// renderer-only store the stage-mode pilot uses, see float-mode.js's STAGE_MODE_KEY).
//
// Values are copied from the r6 sweep's TOP3.md, which is the r6 sweep's own output:
//   T1 (rimMul 3, fresnel 2, centerBackM 0.10, soleY 0.24) -- the weakest passing rim, clearest floor gap
//   T2 (rimMul 6, fresnel 3, centerBackM 0.10, soleY 0.21) -- thinnest outline, more grounded hover
//   T3 (rimMul 4, fresnel 2, centerBackM 0.16, soleY 0.24) -- strongest passing rim, narrowest gap
// T1 + cyan is only the STARTING default; the owner picks the final look (the hint text says so).
export const HOLO_STYLES = Object.freeze({
  T1: Object.freeze({ rimMul: 3, fresnelPower: 2, centerBackM: 0.10, soleY: 0.24 }),
  T2: Object.freeze({ rimMul: 6, fresnelPower: 3, centerBackM: 0.10, soleY: 0.21 }),
  T3: Object.freeze({ rimMul: 4, fresnelPower: 2, centerBackM: 0.16, soleY: 0.24 }),
});
// The r6 sweep's two accents: cyan is also the panel's own default accent (holo-screen pageAccent). Kept as the same hex strings
// the sweep measured, so "what anh picked" is the colour that passed the gates.
export const HOLO_COLOURS = Object.freeze({ cyan: '#39d0ff', amber: '#ffb347' });
export const DEFAULT_HOLO = Object.freeze({ style: 'T1', colour: 'cyan' });
export const HOLO_PREF_KEY = 'zumi.pilot.floatHolo';

const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/** Validates a stored/requested pair against the two tables and returns everything the caller needs in one object:
 *  the picked ids, a COPY of the parameter set (so a caller can never mutate the shipped table) and the accent hex.
 *  Unknown/absent keys fall back to the default, so a stale or hand-edited store can never disable the look. */
export function resolveHolo(prefs) {
  const style = prefs && own(HOLO_STYLES, prefs.style) ? prefs.style : DEFAULT_HOLO.style;
  const colour = prefs && own(HOLO_COLOURS, prefs.colour) ? prefs.colour : DEFAULT_HOLO.colour;
  return { style, colour, params: { ...HOLO_STYLES[style] }, accent: HOLO_COLOURS[colour] };
}

/** Reads the saved pick (defaults on empty, bad JSON or disabled storage) -- same posture as readStageMode. */
export function readHoloPrefs(storage = (typeof localStorage !== 'undefined' ? localStorage : null)) {
  try {
    const raw = storage && storage.getItem(HOLO_PREF_KEY);
    return resolveHolo(raw ? JSON.parse(raw) : null);
  } catch { return resolveHolo(null); }
}

/** Persists ONLY the two ids (never the derived params), and returns the resolved pick so the caller applies exactly
 *  what the next launch will read. A disabled storage just does not remember. */
export function saveHoloPrefs(prefs, storage = (typeof localStorage !== 'undefined' ? localStorage : null)) {
  const resolved = resolveHolo(prefs);
  try { storage && storage.setItem(HOLO_PREF_KEY, JSON.stringify({ style: resolved.style, colour: resolved.colour })); } catch { /* storage disabled: just do not remember */ }
  return resolved;
}
