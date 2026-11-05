'use strict';
// Pure pixel-metric helpers for the T-31 float-holo box gates. NO Electron, NO DOM: a bitmap is
// { buf, width, height } with BGRA rows, exactly what Electron's NativeImage.toBitmap() returns (the harness wraps
// a capture with bitmapOf()). Kept in scripts/lib so scripts/check-float-holo.mjs can unit-test the SAME functions
// the harness calls, with synthetic images and plain node.
//
// r6: the r5 harness defined RIM_BAND / TOE_FLOOR / patchLuma / meanLuma / offsetPts but never called them, so no
// GATE line ever printed (the r5 commit message claimed otherwise). The gate function now lives HERE and the
// harness must call it; check-float-holo.mjs asserts that wiring structurally (a helper that is defined but not
// called cannot pass), on top of the numeric unit tests below.
//
// Coordinates: every point is in PAGE-CSS pixels. In-page sample scripts return STAGE-CANVAS CSS pixels, so the
// harness offsets them by the canvas rect before calling these helpers (offsetPts). patchLuma scales by the
// bitmap's own device size / the CSS viewport size, so a devicePixelRatio of 2 is handled.

/** Rec.601 luminance (0..255) of one BGRA pixel. */
const pixelLuma = (b, g, r) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Mean luminance over a (2r+1)^2 patch centred on `pt` (page-CSS). Returns null when the centre is off-frame --
 *  a gate must FAIL on an off-frame sample, never silently average the pixels that happen to be inside. */
function patchLuma(bm, pt, cssW, cssH, r = 4) {
  if (!bm || !bm.buf || !pt || !(cssW > 0) || !(cssH > 0)) return null;
  const sx = bm.width / cssW, sy = bm.height / cssH;
  const cx = Math.round(pt.x * sx), cy = Math.round(pt.y * sy);
  if (cx < 0 || cy < 0 || cx >= bm.width || cy >= bm.height) return null;
  let sum = 0, n = 0;
  for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) {
    if (x < 0 || y < 0 || x >= bm.width || y >= bm.height) continue;
    const i = (y * bm.width + x) * 4;
    sum += pixelLuma(bm.buf[i], bm.buf[i + 1], bm.buf[i + 2]);
    n++;
  }
  return n ? sum / n : null;
}

/** Mean of patchLuma over every point. STRICT: one off-frame point makes the whole band unmeasurable (null). */
function meanLuma(bm, pts, cssW, cssH, r = 4) {
  if (!Array.isArray(pts) || !pts.length) return null;
  let s = 0;
  for (const p of pts) { const v = patchLuma(bm, p, cssW, cssH, r); if (v == null) return null; s += v; }
  return s / pts.length;
}

/** Translate canvas-relative points into page coordinates. */
const offsetPts = (pts, dx, dy) => (Array.isArray(pts) ? pts.map((p) => ({ x: p.x + dx, y: p.y + dy })) : []);

/** OFF-vs-ON luminance gain of one point band, as a percentage of the OFF mean. gainPct is null when either band
 *  cannot be measured (off-frame) or the OFF mean is 0 (a black reference would make the ratio meaningless). */
function bandGain(off, on, pts, cssW, cssH, r = 4) {
  const o = meanLuma(off, pts, cssW, cssH, r);
  const n = meanLuma(on, pts, cssW, cssH, r);
  return { off: o, on: n, gainPct: o != null && n != null && o > 0 ? (n - o) / o * 100 : null };
}

const RIM_EDGE_MIN_GAIN_PCT = 15; // the brief: the silhouette edge band must gain >= 15% luminance with the rim ON
const RIM_FRONT_MAX_GAIN_PCT = 14.4; // and a front-facing facet must gain <= this (r3's wash was +35.9%)
// The limits are INCLUSIVE (">= 15", "<= 14.4"). A ratio computed from floats lands at 14.999999999999986 for an
// exact 115/100, so every comparison carries this epsilon -- without it a pixel-exact +15.0% would FAIL on rounding.
const EPS = 1e-9;

/** The two rim gates from one OFF/ON capture pair plus the in-page RIM_BAND sample sets (page-CSS points).
 *  rimEdge: |N.V| low (the silhouette band, where the MToon fresnel rim lives) must get BRIGHTER.
 *  rimFront: |N.V| high (a front-facing facet) must stay put (no whole-body wash). */
function rimGates({ off, on, edgePts, frontPts, cssW, cssH, r = 4 }) {
  const edge = bandGain(off, on, edgePts, cssW, cssH, r);
  const front = bandGain(off, on, frontPts, cssW, cssH, r);
  return {
    rimEdge: { ...edge, limitPct: RIM_EDGE_MIN_GAIN_PCT, pass: edge.gainPct != null && edge.gainPct >= RIM_EDGE_MIN_GAIN_PCT - EPS },
    rimFront: { ...front, limitPct: RIM_FRONT_MAX_GAIN_PCT, pass: front.gainPct != null && front.gainPct <= RIM_FRONT_MAX_GAIN_PCT + EPS },
  };
}

// ---------- toe-gap gate: how far BELOW the soles the contact shadow sits ----------
// r6 finding: the old luma-strip gate (floor strip between the toe tips and the shadow core must be lighter than the
// core) passed all 90 sweep cells with deltas 25..70, including centerBackM 0.22 where the shadow sits on the toe
// tips, and scored that cell HIGHEST (70). It measured "is there a lighter floor pixel somewhere between two points",
// which is true whenever the shadow is a small dark ellipse, wherever it is. The eye reads something else: the
// vertical distance from the LOWEST SOLE pixel down to the shadow's darkest band. That is what this measures, from
// the full-body still alone (no skeleton, no extra captures), so the same function runs on the harness stills and on
// the saved raw PNGs.
//
// Units: every pixel distance is scaled to a reference 800 CSS-px-high viewport (k = bitmap px per reference px), so
// the limits hold at 1280x800, 1920x1080 and on a 2x display.
//
// Measure (all inside a window around the toe midpoint `toe`, whose x is the centre of her stance):
//   1. soleY: the last row of the pale boot. Rows in [toe.y-140, toe.y+20] are scanned from the top; a row counts as
//      boot when >= 2 pixels in toe.x +- 70 are pale (luma >= 195, B-R <= 50: the white boots and stockings); the run
//      may skip <= 3 rows (the blue outline row at a toe tip) and a stray floor speck below the run cannot extend
//      it. The ~10 px blue outline UNDER the last pale row is deliberately not part of the measure: its colour is
//      indistinguishable from the shadow by luma, so including it would make the gate depend on which of the two it
//      is. The limit below is calibrated on this definition.
//   2. shadow: per row, how much darker the floor is than the open floor on the same row (median of two reference
//      columns far to either side), averaged over core.x +- 16, box-smoothed over 5 rows. The row with the maximum is
//      the darkest band (shadowY). No band darker than TOE_GAP_MIN_DARKNESS luma -> unmeasurable -> FAIL.
//   gapPx = (shadowY - soleY) / k. Positive = the shadow band is below the soles. Negative = it is behind/over them.
// Calibration on the 90 saved r6 sweep stills (only soleY and centerBackM move this number; rimMul/fresnel do not):
//   centerBackM 0.22: -8 (soleY .21), +4 (.24)   centerBackM 0.16: +1 (.21), +13 (.24)   centerBackM 0.10: +10 (.21), +22 (.24)
// The three cells that read as hovering to the eye (TOP1 0.10/.24 = 22, TOP2 0.10/.21 = 10, TOP3 0.16/.24 = 13) all
// clear 7; every 0.22 cell and 0.16/.21 (the shadow touching the toe tips) are <= 4. 7 sits in the middle of that gap.
const TOE_GAP_REF_VIEW_H = 800;
const TOE_GAP_MIN_PX = 7; // reference px the darkest shadow band must sit below the lowest pale boot row
const TOE_GAP_MIN_DARKNESS = 15; // luma points the shadow band must be darker than the open floor to count as found
const TOE_PALE_LUMA = 195;
const TOE_PALE_MAX_BLUE_OVER_RED = 50;

/** @param viewH the CSS height of the viewport the pixel distances are scaled against (default cssH). A cropped
 *  fixture passes the ORIGINAL viewport height here so the reference-px limit still means the same thing. */
function toeGapGate({ bm, toe, core, cssW, cssH, viewH }) {
  const base = { gapPx: null, soleY: null, shadowY: null, shadowTopY: null, darkness: null, minGapPx: TOE_GAP_MIN_PX, pass: false };
  if (!bm || !bm.buf || !toe || !core || !(cssW > 0) || !(cssH > 0)) return { ...base, reason: 'no sample points' };
  const sx = bm.width / cssW, sy = bm.height / cssH;
  const k = sy * ((viewH || cssH) / TOE_GAP_REF_VIEW_H);
  const R = (v) => Math.round(v * k);
  const tx = Math.round(toe.x * sx), ty = Math.round(toe.y * sy), cx = Math.round(core.x * sx);
  const yTop = ty - R(140), yBot = ty + R(30);
  const x0 = tx - R(70), x1 = tx + R(70), refLo = tx - R(140), refHi = tx + R(140);
  if (yTop < 0 || yBot >= bm.height || refLo < 0 || refHi >= bm.width || cx - R(16) < 0 || cx + R(16) >= bm.width) return { ...base, reason: 'window off-frame' };
  const lumaAt = (x, y) => { const i = (y * bm.width + x) * 4; return pixelLuma(bm.buf[i], bm.buf[i + 1], bm.buf[i + 2]); };
  const isPale = (x, y) => { const i = (y * bm.width + x) * 4; return pixelLuma(bm.buf[i], bm.buf[i + 1], bm.buf[i + 2]) >= TOE_PALE_LUMA && bm.buf[i] - bm.buf[i + 2] <= TOE_PALE_MAX_BLUE_OVER_RED; };

  // 1. the last pale boot row
  let soleY = null, miss = 0;
  for (let y = yTop; y <= ty + R(20); y++) {
    let n = 0;
    for (let x = x0; x < x1 && n < 2; x++) if (isPale(x, y)) n++;
    if (n >= 2) { soleY = y; miss = 0; } else if (soleY != null && ++miss > 3) break;
  }
  if (soleY == null) return { ...base, reason: 'no boot found' };

  // 2. the darkest shadow band
  const lo = soleY - R(30), hi = yBot;
  const rows = hi - lo + 1;
  const dark = new Array(rows).fill(0);
  for (let y = lo; y <= hi; y++) {
    const ref = [];
    for (let x = refLo; x < tx - R(110); x++) ref.push(lumaAt(x, y));
    for (let x = tx + R(110) + 1; x <= refHi; x++) ref.push(lumaAt(x, y));
    ref.sort((a, b) => a - b);
    const floor = ref[ref.length >> 1];
    let sum = 0, n = 0;
    for (let x = cx - R(16); x <= cx + R(16); x++) { sum += Math.max(0, floor - lumaAt(x, y)); n++; }
    dark[y - lo] = sum / n;
  }
  const half = Math.max(1, Math.round(2 * k));
  const smooth = dark.map((_, i) => { let s = 0, n = 0; for (let j = Math.max(0, i - half); j <= Math.min(rows - 1, i + half); j++) { s += dark[j]; n++; } return s / n; });
  let pk = 0;
  for (let i = 1; i < rows; i++) if (smooth[i] > smooth[pk]) pk = i;
  const darkness = smooth[pk];
  if (darkness < TOE_GAP_MIN_DARKNESS) return { ...base, soleY, darkness, reason: 'no shadow band found' };
  // the band's centre = the middle of the contiguous rows within 3% of the peak (a flat-topped band has no single
  // max row; a soft one collapses to its peak)
  let bandTop = pk, bandBot = pk;
  while (bandTop > 0 && smooth[bandTop - 1] >= darkness * 0.97) bandTop--;
  while (bandBot < rows - 1 && smooth[bandBot + 1] >= darkness * 0.97) bandBot++;
  let top = bandTop;
  while (top > 0 && smooth[top - 1] >= darkness / 2) top--;
  const shadowY = lo + Math.round((bandTop + bandBot) / 2), shadowTopY = lo + top;
  const gapPx = (shadowY - soleY) / k;
  return { gapPx, gapTopPx: (shadowTopY - soleY) / k, soleY, shadowY, shadowTopY, darkness, minGapPx: TOE_GAP_MIN_PX, pass: gapPx >= TOE_GAP_MIN_PX - EPS };
}

// ---------- sweep grid (FH_SWEEP=1) ----------
// The r6 sweep grid: the four runtime overrides the box tunes. Defaults are the brief's own example grid; a JSON
// env var (FH_SWEEP_GRID='{...}' or FH_SWEEP_GRID=<file.json>) replaces it. Shipped defaults are never changed.
const GRID_KEYS = ['rimMul', 'fresnelPower', 'centerBackM', 'soleY'];
const DEFAULT_SWEEP_GRID = Object.freeze({
  rimMul: Object.freeze([1, 2, 3, 4, 6]),
  fresnelPower: Object.freeze([2, 3, 4]),
  centerBackM: Object.freeze([0.10, 0.16, 0.22]),
  soleY: Object.freeze([0.21, 0.24]),
});

/** Parse the sweep grid from an inline JSON string or a JSON file path (`readFile` is injected so this module stays
 *  pure and unit-testable). Empty/missing -> the default grid. Throws on malformed JSON or an empty/non-numeric
 *  axis, because a silently empty sweep would write a header-only CSV and look like it ran. */
function parseSweepGrid(raw, readFile = null) {
  if (raw == null || String(raw).trim() === '') return { rimMul: [...DEFAULT_SWEEP_GRID.rimMul], fresnelPower: [...DEFAULT_SWEEP_GRID.fresnelPower], centerBackM: [...DEFAULT_SWEEP_GRID.centerBackM], soleY: [...DEFAULT_SWEEP_GRID.soleY] };
  let text = String(raw).trim();
  if (!text.startsWith('{') && readFile) text = String(readFile(text));
  let obj;
  try { obj = JSON.parse(text); } catch (e) { throw new Error(`FH_SWEEP_GRID is not valid JSON: ${e.message}`); }
  const out = {};
  for (const k of GRID_KEYS) {
    const v = obj[k];
    if (!Array.isArray(v) || v.length === 0) throw new Error(`FH_SWEEP_GRID.${k} must be a non-empty array`);
    out[k] = v.map((n) => {
      const x = Number(n);
      if (!Number.isFinite(x)) throw new Error(`FH_SWEEP_GRID.${k} contains a non-numeric value: ${JSON.stringify(n)}`);
      return x;
    });
  }
  return out;
}

/** Cartesian product of the grid axes, in a fixed axis order (rimMul -> fresnelPower -> centerBackM -> soleY). */
function sweepCombos(grid) {
  const g = grid || DEFAULT_SWEEP_GRID;
  const out = [];
  for (const rimMul of g.rimMul) for (const fresnelPower of g.fresnelPower) for (const centerBackM of g.centerBackM) for (const soleY of g.soleY) {
    out.push({ rimMul, fresnelPower, centerBackM, soleY });
  }
  return out;
}

/** The gate function the harness calls: all three metrics from ONE set of captures. `off`/`on` are the full-window
 *  A/B pair (rim OFF vs ON), `full` is the ON full-body still the toe gap is read from, `edgePts`/`frontPts` are
 *  RIM_BAND's page-CSS sample points, `toe`/`core` are TOE_FLOOR's page-CSS points. Pure: it only reads bitmaps,
 *  so check-float-holo.mjs can drive it with synthetic images and prove the numbers are the helpers' output. */
function computeGates({ off, on, full, edgePts, frontPts, toe, core, cssW, cssH, r = 4, viewH }) {
  const rim = rimGates({ off, on, edgePts, frontPts, cssW, cssH, r });
  return { rimEdge: rim.rimEdge, rimFront: rim.rimFront, toeGap: toeGapGate({ bm: full || on, toe, core, cssW, cssH, viewH }) };
}

/** The three GATE lines, in the brief's exact format (the box greps these; keep them stable):
 *    GATE rim-edge <gain%> PASS|FAIL (>=15)
 *    GATE rim-front <gain%> PASS|FAIL (<=14.4)
 *    GATE toe-gap <px> PASS|FAIL (>=7)   (sole-to-shadow gap in reference px, see toeGapGate; replaces r6's blind toe-strip)
 *  An unmeasurable metric prints `n/a` and FAIL -- never a silent skip (the r5 bug). */
function formatGateLines(g) {
  const f = (v, d) => (v == null ? 'n/a' : v.toFixed(d));
  const tag = (ok) => (ok ? 'PASS' : 'FAIL');
  return [
    `GATE rim-edge ${f(g.rimEdge.gainPct, 1)} ${tag(g.rimEdge.pass)} (>=${RIM_EDGE_MIN_GAIN_PCT})`,
    `GATE rim-front ${f(g.rimFront.gainPct, 1)} ${tag(g.rimFront.pass)} (<=${RIM_FRONT_MAX_GAIN_PCT})`,
    `GATE toe-gap ${f(g.toeGap.gapPx, 1)} ${tag(g.toeGap.pass)} (>=${TOE_GAP_MIN_PX})`,
  ];
}

// ---------- FH_PARAMS: one picked combo for a normal stills/clip run ----------
// The sweep picks a combo; main.js loads a fixed URL, so a normal run could not use it. FH_PARAMS carries ONE combo
// as inline JSON. Keys are the renderer's runtime overrides (float-mode.js OVERRIDE_RANGES, same bounds); `rimStrength`
// is accepted as an alias of `rimMul` (same quantity: the rim tint multiplier). Unknown keys, non-numbers and
// out-of-range values THROW -- a typo must not silently run the shipped defaults and look like the picked combo.
const PARAM_RANGES = Object.freeze({ soleY: [0.05, 0.6], centerBackM: [0, 0.6], rimMul: [0, 10], fresnelPower: [0.5, 10] });
const PARAM_ALIASES = Object.freeze({ rimStrength: 'rimMul' });

/** @returns null when unset/empty (shipped defaults untouched), else a canonical { rimMul?, fresnelPower?, centerBackM?, soleY? }. */
function parseFhParams(raw) {
  if (raw == null || String(raw).trim() === '') return null;
  let obj;
  try { obj = JSON.parse(String(raw)); } catch (e) { throw new Error(`FH_PARAMS is not valid JSON: ${e.message}`); }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('FH_PARAMS must be a JSON object');
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = PARAM_ALIASES[k] || k;
    if (!Object.prototype.hasOwnProperty.call(PARAM_RANGES, key)) throw new Error(`FH_PARAMS has an unknown key: ${JSON.stringify(k)} (allowed: rimMul|rimStrength, fresnelPower, centerBackM, soleY)`);
    if (key in out) throw new Error(`FH_PARAMS sets ${key} twice (rimMul and its alias rimStrength)`);
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`FH_PARAMS.${k} must be a finite number, got ${JSON.stringify(v)}`);
    const [lo, hi] = PARAM_RANGES[key];
    if (v < lo || v > hi) throw new Error(`FH_PARAMS.${k}=${v} is outside ${lo}..${hi}`);
    out[key] = v;
  }
  if (Object.keys(out).length === 0) throw new Error('FH_PARAMS is an empty object; leave it unset to use the shipped defaults');
  return out;
}

// ---------- both colours: a cell/run passes only if cyan AND amber pass ----------
/** Like computeGates, but the rim pair is measured on BOTH accent pages. `cyan`/`amber` = { off, on } bitmaps (rim
 *  light OFF vs ON on that page); the toe gap is read ONCE from `full` (cyan page). The top-level rimEdge /
 *  rimFront / toeGap stay the CYAN lines the box greps (formatGateLines works on them); `amber` holds the
 *  second colour; `pass` is true only when all five metrics pass. */
function computeColourGates({ cyan, amber, full, edgePts, frontPts, toe, core, cssW, cssH, r = 4, viewH }) {
  const c = computeGates({ off: cyan.off, on: cyan.on, full, edgePts, frontPts, toe, core, cssW, cssH, r, viewH });
  const a = rimGates({ off: amber.off, on: amber.on, edgePts, frontPts, cssW, cssH, r });
  const pass = c.rimEdge.pass && c.rimFront.pass && a.rimEdge.pass && a.rimFront.pass && c.toeGap.pass;
  return { rimEdge: c.rimEdge, rimFront: c.rimFront, toeGap: c.toeGap, amber: { rimEdge: a.rimEdge, rimFront: a.rimFront }, pass };
}

/** The 5 GATE lines: the three existing (cyan) ones unchanged, then the amber pair. */
function formatColourGateLines(g) {
  const f = (v) => (v == null ? 'n/a' : v.toFixed(1));
  const tag = (ok) => (ok ? 'PASS' : 'FAIL');
  return [
    ...formatGateLines(g),
    `GATE rim-edge-amber ${f(g.amber.rimEdge.gainPct)} ${tag(g.amber.rimEdge.pass)} (>=${RIM_EDGE_MIN_GAIN_PCT})`,
    `GATE rim-front-amber ${f(g.amber.rimFront.gainPct)} ${tag(g.amber.rimFront.pass)} (<=${RIM_FRONT_MAX_GAIN_PCT})`,
  ];
}

const SWEEP_CSV_HEADER = 'rimMul,fresnelPower,centerBackM,soleY,rimEdgeCyanGainPct,rimFrontCyanGainPct,rimEdgeAmberGainPct,rimFrontAmberGainPct,toeGapPx,rimEdgeCyanPass,rimFrontCyanPass,rimEdgeAmberPass,rimFrontAmberPass,toeGapPass,cellPass';

/** One sweep row (cell + both-colour metrics + passes) from computeColourGates' output. */
function sweepRow(cell, tag, g) {
  return {
    ...cell, tag,
    rimEdgeCyanGainPct: g.rimEdge.gainPct, rimFrontCyanGainPct: g.rimFront.gainPct,
    rimEdgeAmberGainPct: g.amber.rimEdge.gainPct, rimFrontAmberGainPct: g.amber.rimFront.gainPct,
    toeGapPx: g.toeGap.gapPx,
    rimEdgeCyanPass: g.rimEdge.pass, rimFrontCyanPass: g.rimFront.pass,
    rimEdgeAmberPass: g.amber.rimEdge.pass, rimFrontAmberPass: g.amber.rimFront.pass,
    toeGapPass: g.toeGap.pass, cellPass: g.pass,
  };
}

/** A metric the instrument could not measure (off-frame sample) is null; the harness fails the sweep on any. */
const sweepRowBroken = (row) => [row.rimEdgeCyanGainPct, row.rimFrontCyanGainPct, row.rimEdgeAmberGainPct, row.rimFrontAmberGainPct, row.toeGapPx].some((v) => v == null);

function sweepCsvLine(row) {
  const f = (v) => (v == null ? '' : Number(v).toFixed(1));
  return [row.rimMul, row.fresnelPower, row.centerBackM, row.soleY,
    f(row.rimEdgeCyanGainPct), f(row.rimFrontCyanGainPct), f(row.rimEdgeAmberGainPct), f(row.rimFrontAmberGainPct), f(row.toeGapPx),
    row.rimEdgeCyanPass, row.rimFrontCyanPass, row.rimEdgeAmberPass, row.rimFrontAmberPass, row.toeGapPass, row.cellPass].join(',');
}

module.exports = {
  pixelLuma, patchLuma, meanLuma, offsetPts, bandGain, rimGates, computeGates, formatGateLines,
  toeGapGate, TOE_GAP_MIN_PX, TOE_GAP_MIN_DARKNESS, TOE_GAP_REF_VIEW_H,
  RIM_EDGE_MIN_GAIN_PCT, RIM_FRONT_MAX_GAIN_PCT,
  DEFAULT_SWEEP_GRID, parseSweepGrid, sweepCombos,
  parseFhParams, PARAM_RANGES, computeColourGates, formatColourGateLines, SWEEP_CSV_HEADER, sweepRow, sweepRowBroken, sweepCsvLine,
};
