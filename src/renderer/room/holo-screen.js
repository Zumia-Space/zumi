// Hologram screen (T-31 float-holo pilot): a translucent 3D panel that floats beside Zumi in the talk view, and
// whose accent colour LIGHTS her through one coloured PointLight (created once in app.js's stage setup -- adding
// a light later changes NUM_POINT_LIGHTS and recompiles every MToon program). MToon applies the point light
// through its toon N·L step, so her screen-facing side gets a cel-shaded coloured band; the rim picks up a little
// of the hue for free. See DESIGN.md §2.2/§2.3.
//
// r4: the light is now EDGE-ONLY for every accent. The point-light band washed the whole screen-facing side, and
// the MToon rim (which SHOULD be a thin silhouette) was authored with lift=1 on half the model's materials, so it
// smeared a full-body tint (r3: amber painted the jacket peach, +35.9% brightness). r4 forces the rim to a true
// fresnel edge (lift 0, sharp power) and normalises every accent's perceived brightness to EDGE_LUM. See the
// edge-light block below for the measurement and the pure functions the check asserts.
// r5: r4's forced power was 5 -- a sliver 1-2 px wide that measured only +1.7% body brightness on the box, i.e. the
// rim had gone invisible (cyan and amber stills looked identical). r5 keeps lift 0 (so the front still gets NO rim,
// the whole point of r4) but drops the power to 3 (a wider edge band, still sharp) and raises the rim strength
// (RIM_ONLY_TINT 0.4 -> 0.8, RIM_TINT 0.15 -> 0.3). The parameter-level check here proves the front stays clean;
// the PIXEL check (edge band ON-vs-OFF luminance gain >= 15%, front <= 14.4%) runs on the box in
// scripts/electron-float-holo.cjs -- this module can never prove a render.
//
// The panel is a CanvasTexture that shows ONE real thing: the live task from the board feed (T-31 alpha.3 R3).
// setFeed(updates) takes the same rows the HUD gets (src/main/hud-feed.mjs) and draws drawTask(): the task title,
// "STEP n/m . p% DONE" (doneCount/stepTotal, nothing invented), an English state word, the board's own current-step
// label and the last finished steps. With no row it reads NO LIVE TASK -- never a demo page. On each content change
// the light flickers (flickerEnvelope) and, while the panel is up, after 120 ms she glances at it -- the same
// `board` quick-glance call the HUD uses (hud.js onCardClick), never while she is speaking.
//
// Everything here is world-space and parented to the main stage scene: the panel follows her hips (so it hovers
// with her) and is turned square to the camera every frame (faceCamera; alpha.10 -- it used to face the midpoint of
// her head and the camera, which tilted the card and skewed its text).
//
// T-31 C1 step 11 (seated parity): the panel is no longer float-only. While the stage is SEATED and the working
// signal is on, the same panel comes up in its own placement -- smaller, beside her (alpha.10: no longer in front
// of her at hand height), inside the talk crop -- so the C1 beats (read, look-at-anh) also play seated. Since
// alpha.10 no beat touches the panel (work-loop.js BEATS): it is a screen beside her, not a thing she holds. `workPanelOn()` is the one rule app.js and the offline gate share; the seated placement is a separate
// offset + panel size, never a mutation of the float constants (see SEATED_SCREEN_OFFSET/SEATED_PANEL_SCALE).
import * as THREE from 'three';
import { bodyOrientation } from '../model-facing.js';

/** The panel's offset from her hips, in the BODY/stage frame (+Z her forward). NEVER rotate it by the raw scene
 *  quaternion: a VRM 0.x scene carries the 180-degree base flip, which mirrors the panel to her BACK (T-31 review
 *  round 2). Exported so check-vrm0-facing can assert the facing without a renderer. */
export function holoOffset(scene, scale) {
  return new THREE.Vector3(SCREEN_OFFSET[0], SCREEN_OFFSET[1], SCREEN_OFFSET[2]).multiplyScalar(scale).applyQuaternion(bodyOrientation(scene));
}
// T-31 C1 step 9: which hand is on the panel's side (pure plane/body math, no DOM) -- touchFrame() reports it.
import { panelHandSide } from '../talk/panel-touch.js';
import { HOLO_COLOURS } from './float-holo-prefs.js';

export const SCREEN_LIGHT_CD = 0.8; // PointLight intensity at full envelope (box-tuned; env ZUMI_PILOT_LIGHT_CD overrides)
export const SCREEN_LIGHT_DISTANCE = 0.85; // falloff cutoff in metres -- SHORT, so only her screen-facing side is lit.
// The screen sits ~0.58 m from her hips, so >0.85 m reaches almost nothing: her far side keeps its base colours
// instead of the whole-body wash a 1.6 m cutoff gave (33%->77% blown pixels measured on the spare PC). decay 2 =
// physical falloff. With the cutoff so close the near side is dim, so the intensity sits at the TOP of the
// measured band; if the box still finds the A/B band too faint it raises ZUMI_PILOT_LIGHT_CD (brief step 6).
export const RIM_TINT = 0.3; // how far the MToon parametric rim is pulled toward the accent while the screen is on (point mode: a garnish)
export const RIM_ONLY_TINT = 0.8; // rim-only mode: the rim IS the light (DESIGN.md §2.3 alternative), so it is pulled harder
// ---- r4 edge light: every accent is an EDGE light at ONE perceived intensity ------------------------------------
// The screen lights Zumi through the MToon parametric rim. MToon's shader computes
//   rim = parametricRimColorFactor * pow(saturate(1 - N·V + lift), power) * rimMix      (three-vrm-materials-mtoon)
// That fresnel factor is ~0 on a front-facing facet and 1 at the silhouette, so it is an EDGE light by
// construction -- but ONLY when `lift` is 0. Every character model in this pipeline authors HALF its materials
// with `lift = 1, power = 1` (measured with scripts/inspect: 27/54 MToon materials on zumi-v3.1.vrm). With
// lift = 1 the factor is (1 - N·V + 1)^1 = 1 even head-on, so the tint smears over the WHOLE surface -- that is
// the r3 "amber washes the jacket" bug: amber's raw channels are far brighter in R/G than cyan's, so the smeared
// tint read as a peach body wash (wide check: jacket +35.9% vs the 14.4% limit). r4:
//   1. forces `lift = 0` and a sharp `power` while the screen is on (restored on exit, exactly like the colour),
//      so a front-facing facet gets fresnel 0 = no tint; and
//   2. normalises each accent's PERCEIVED brightness to EDGE_LUM, so amber adds no more than cyan.
export const EDGE_FRESNEL_POWER = 3; // forced while the screen is on: sharper than r3's 1 (a full-body wash) but far wider than r4's 5 (an invisible sliver); lift 0 keeps the front clean regardless
export const EDGE_FRESNEL_LIFT = 0; // forced while the screen is on: a front-facing facet (N·V = 1) gets NO rim
export const EDGE_LUM = 0.6; // perceived-brightness target every page accent is normalised to (see perceivedLuma)
export const BASE_SURFACE_LUMA = 0.9; // a near-white lit facet (the white jacket) -- the un-lit reference the deltas are taken against
// r5: this is the rim's MODELLED edge gain (a shader-parameter bound, NOT a pixel measurement -- the real edge-pixel
// luminance gain is gated on the box by scripts/electron-float-holo.cjs). It was 0.08 (r4, trivially met); the brief
// wants the render's edge band at +15-25% luminance, so the parameter floor is raised to match its lower bound.
export const EDGE_DELTA_MIN = 0.15; // modelled rim-edge gain must clear this fraction of the un-lit facet
export const FRONT_DELTA_LIMIT = 0.144; // the wide-check limit: a front-facing facet may gain <= this over its un-lit colour
/** Panel centre offset from her hips, in her own (yawed) frame: [out to her right (-x), above the hips (+y),
 *  toward the camera (+z)], metres at scale 1 (update() multiplies it by P.scale). Exported so the offline checks
 *  (scripts/check-float-holo.mjs) place the panel exactly where update() does -- one source of truth. */
export const SCREEN_OFFSET = Object.freeze([-0.42, 0.45, 0.30]);
/** T-31 C1 step 11: the SEATED work panel's centre offset from her hips, in her own (yawed) frame -- absolute
 *  metres, not multiplied by P.scale (the seated placement is not the float one scaled: it is solved against the
 *  talk CHEST_UP crop, where it must sit fully inside the frame). T-31 alpha.10 (owner 31-10: "để dọc thẳng ... cho
 *  chữ đọc được ... holo tương tác với nhân vật cũng không đúng"): the card stands BESIDE her, out to her right
 *  (camera-left) and level with her chest, barely in front of her (z 0.15), so it no longer floats at her hand as
 *  if she held it. On the chest-up frame it projects left of her arm and below the HUD's left panel
 *  (NDC x -0.91..-0.48, y -0.49..-0.06 at 1600x1000). Solved by scripts/check-work-seated.mjs. */
export const SEATED_SCREEN_OFFSET = Object.freeze([-0.53, 0.35, 0.15]);
/** Seated panel uniform scale: SMALLER than the float panel (FLOAT.scale = 0.85), per the step brief. Its own
 *  constant, not a fraction of FLOAT.scale, so a float tuning change cannot silently resize the seated panel. 0.76
 *  (alpha.10, was 0.62): further back from the camera than before, so larger: ~360 px at a 1680 px stage keeps the full
 *  layout (title, step, state and the finished steps). */
export const SEATED_PANEL_SCALE = 0.76;

/** Turns the panel square to the camera: its plane parallel to the image plane and its up the camera's up, so it
 *  projects as an upright rectangle with no perspective skew -- read like the side panels (owner 31-10: the card
 *  turned toward her head was tilted and the text skewed). `group` is parented to the scene (identity), so its local
 *  quaternion is its world one. Pure; the checks place the panel through it too. */
export function faceCamera(group, camera) {
  camera.updateMatrixWorld();
  camera.getWorldQuaternion(group.quaternion);
  return group;
}

/** Panel size in metres for a placement ('float' | 'seated'). Float follows the caller's placement scale (0.42 x
 *  0.26 m at scale 1); seated has its own smaller size. Pure -- shared by the mesh resize and the offline gate. */
export function panelSize(mode, P) {
  const scale = mode === 'seated' ? SEATED_PANEL_SCALE : P.scale;
  return { w: 0.42 * scale, h: 0.26 * scale, scale };
}

/** The panel centre's offset from her hips for a placement. Float is SCREEN_OFFSET * P.scale (unchanged since the
 *  pilot); seated is its own absolute offset. Pure -- one source of truth for update() and the checks. */
export function panelOffset(mode, P) {
  return mode === 'seated' ? SEATED_SCREEN_OFFSET.slice() : [SCREEN_OFFSET[0] * P.scale, SCREEN_OFFSET[1] * P.scale, SCREEN_OFFSET[2] * P.scale];
}

/** The ONE rule for "is the work panel up" (T-31 C1 step 11): float always shows it; seated only while the working
 *  signal is on. Pure, so app.js's stage/working sinks and scripts/check-work-seated.mjs cannot disagree. Any
 *  unknown mode is treated as seated (the shipped default), never as float. */
export function workPanelOn(stageMode, working, publicBuild = false) {
  if (publicBuild) return false; // it shows the Board's live task; a public build has neither, and "NO LIVE TASK" explains nothing
  return stageMode === 'float' || Boolean(working);
}

/** sRGB hex -> { r, g, b } in 0..1 in GAMMA space (the values as authored, not linearised). */
export function hexToSrgb01(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
  const c = m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [0, 0, 0];
  return { r: c[0] / 255, g: c[1] / 255, b: c[2] / 255 };
}
/** Perceived brightness (Rec.601 luma Y' = 0.299R + 0.587G + 0.114B over the gamma 0..1 channels) -- the metric
 *  behind "equal perceived intensity". On it the warm amber page (#ffb347, Y' ~0.74) is ~13% brighter than cyan
 *  (#39d0ff, Y' ~0.66), so normalising to one target dims amber more than cyan, which is exactly the r3 fix. */
export function perceivedLuma({ r, g, b }) { return 0.299 * r + 0.587 * g + 0.114 * b; }
/** The accent scaled so its perceived brightness equals `target` (EDGE_LUM): amber adds no more than cyan.
 *  Returned in gamma space; the caller hands it to THREE.Color.setRGB(..., THREE.SRGBColorSpace). */
export function edgeLightColor(hex, target = EDGE_LUM) {
  const c = hexToSrgb01(hex);
  const y = perceivedLuma(c) || 1e-6;
  const k = target / y;
  return { r: c.r * k, g: c.g * k, b: c.b * k };
}
/** The MToon fresnel term: N·V low -> edge. `nDotV` is |N·V| clamped to 0..1. */
export function rimTerm(nDotV, power = EDGE_FRESNEL_POWER, lift = EDGE_FRESNEL_LIFT) {
  const x = Math.max(0, Math.min(1, 1 - Math.max(0, Math.min(1, nDotV)) + lift));
  return x ** power;
}
/** Fraction of its un-lit brightness a FRONT-facing facet (N·V >= 0.6) gains from the rim; r4 gate: <=
 *  FRONT_DELTA_LIMIT. With lift = 0 a head-on facet (N·V = 1) is exactly 0. */
export function frontSurfaceDelta(hex, tint = RIM_ONLY_TINT) {
  const c = edgeLightColor(hex);
  let worst = 0;
  for (const nv of [1.0, 0.85, 0.7, 0.6]) {
    const t = rimTerm(nv) * tint;
    worst = Math.max(worst, perceivedLuma({ r: c.r * t, g: c.g * t, b: c.b * t }) / BASE_SURFACE_LUMA);
  }
  return worst;
}
/** Fraction of its un-lit brightness the SILHOUETTE (N·V = 0) gains; r4 gate: >= EDGE_DELTA_MIN. Equal for every
 *  accent, because edgeLightColor normalises the brightness first. */
export function edgeSurfaceDelta(hex, tint = RIM_ONLY_TINT) {
  const c = edgeLightColor(hex);
  const t = rimTerm(0) * tint;
  return perceivedLuma({ r: c.r * t, g: c.g * t, b: c.b * t }) / BASE_SURFACE_LUMA;
}

/** Which accent a frame should use (T-31 float-holo QC switch): a pinned run (the box harness: cyan = page 0,
 *  amber = page 1) follows the PAGE so its colour stills stay exact; an unpinned run uses the Settings pick when
 *  set. Pure, so the harness invariant is unit-tested without a DOM. */
export function liveAccent(pageAccent, fixedAccent, pinned) {
  return pinned ? pageAccent : (fixedAccent || pageAccent);
}

/** { r, g, b } (gamma 0..1) -> a THREE.Color in the renderer's working (linear) space. */
const toColor = ({ r, g, b }) => new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);

// The panel mesh's four local corners, in unit half-extents (screenRect multiplies by the real half-width/height).
const CORNERS = Object.freeze([Object.freeze([-1, -1]), Object.freeze([1, -1]), Object.freeze([1, 1]), Object.freeze([-1, 1])]);

/** ZUMI_PILOT_LIGHT_MODE -> 'point' | 'rim' (default 'point'). Unknown/empty -> 'point', so the shipped pilot is
 *  the point light unless the box explicitly asks for the rim-only fallback. Pure (unit-tested). */
export function parseLightMode(v) {
  return v === 'rim' ? 'rim' : 'point';
}

const prefersReducedMotion = () => {
  try { return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
};

/** Light multiplier after a content change, as a function of ms since the change. Pure (unit-tested). Under
 *  prefers-reduced-motion (or when called with reduced=true) it is a flat 1 -- the caller still crossfades the
 *  colour, but nothing flickers. */
export function flickerEnvelope(ms, reduced = prefersReducedMotion()) {
  if (reduced) return 1;
  if (ms < 40) return 0.35;
  if (ms < 90) return 1.1;
  if (ms < 130) return 0.55;
  if (ms < 220) return 0.55 + (1.0 - 0.55) * (ms - 130) / 90; // ramp back up by 220 ms
  return 1;
}

// ---------- the live task page (T-31 alpha.3 R3) ----------
/** English words for the board's step states (the board's own labels are author-written text, often Vietnamese). An
 *  unknown/empty state has NO word -- the line is left out rather than guessed. */
export const STATE_WORDS = Object.freeze({ active: 'WORKING', waiting: 'WAITING FOR OWNER', blocked: 'BLOCKED', todo: 'QUEUED' });
const DONE_LINES = 3;
const FONT = '"Segoe UI", "Inter", system-ui, sans-serif'; // the app's body font (styles.css), as the side panels use; carries Vietnamese diacritics

// ---------- the side-panel type (T-31 alpha.12, owner 01-11) ----------
// Why the card read big: alpha.3-10 drew fixed canvas fonts (compact 36-46 px, full 20-34 px) into a 512 px canvas whatever the card's size on
// screen, so a font landed at F x (card width / 512): 25 px bold on a 280 px card, where the HUD beside it uses 14 px. Its 3 px border and 5 px
// brackets scaled the same way, and mipmapped minification softened the text. Since alpha.12 the canvas is laid out in the card's own on-screen
// CSS px (setScreenWidth), so a font size here IS the size on screen, and the sizes, weights and spacing are read from hud.css itself.
const HUD_ROLES = Object.freeze({ title: 'hp-title', state: 'hp-state', step: 'hp-cur', sub: 'hp-sub', head: 'hud-head' });
/** hud.css values, for a page without a DOM (the Node gates). check-holo-type pins them against hud.css. */
export const HUD_TYPE_DEFAULT = Object.freeze({
  title: { px: 14, weight: '600', ls: 0, lh: 17.5, family: FONT },
  state: { px: 9, weight: '400', ls: 1.08, lh: 12, family: FONT },
  step: { px: 11.5, weight: '600', ls: 0, lh: 14.72, family: FONT },
  sub: { px: 9.5, weight: '400', ls: 0, lh: 12.35, family: FONT },
  head: { px: 11, weight: '400', ls: 0.88, lh: 15, family: FONT },
});
/** The HUD task panel's type as the page computes it (a hidden probe with the panel's own classes), so the card cannot drift from hud.css. */
export function hudType(doc = globalThis.document) {
  const view = doc && doc.defaultView, body = doc && doc.body;
  if (!view || !body || typeof view.getComputedStyle !== 'function') return HUD_TYPE_DEFAULT;
  const box = doc.createElement('div');
  box.className = 'hud-task-panel'; box.style.display = 'none'; box.setAttribute('aria-hidden', 'true');
  body.appendChild(box);
  try {
    const out = {};
    for (const [role, cls] of Object.entries(HUD_ROLES)) {
      const el = doc.createElement('span'); el.className = cls; box.appendChild(el);
      const cs = view.getComputedStyle(el), px = parseFloat(cs.fontSize), lh = parseFloat(cs.lineHeight), ls = parseFloat(cs.letterSpacing);
      const d = HUD_TYPE_DEFAULT[role];
      out[role] = { px: px > 0 ? px : d.px, weight: cs.fontWeight || d.weight, ls: Number.isFinite(ls) ? ls : 0, lh: lh > 0 ? lh : (px > 0 ? px : d.px) * 1.3, family: cs.fontFamily || d.family };
    }
    return out;
  } finally { body.removeChild(box); }
}
/** Texture pixels per CSS px. 2 per device pixel: the card bobs by sub-pixels, and a 2:1 linear sample stays sharp where 1:1 would blur on every move. */
const texelScale = () => Math.min(4, Math.max(1, (globalThis.devicePixelRatio || 1)) * 2);
const PANEL_ASPECT = 0.26 / 0.42; // height / width of the panel quad (panelSize)
export const DEFAULT_CARD_CSS_W = 360; // until the first measured frame
const RESIZE_EPS = 0.04; // a redraw only when the card's on-screen width moved by 4 %: the hover bob never redraws

// ---------- the side-panel look (T-31 alpha.9) ----------
// anh (30-10): the card must look like the side panels (hud.css .hud-panel / .hud-item). Those panels build every colour from the shared theme tokens
// with color-mix; the same expressions are evaluated here (a probe element resolves them against the live theme, so blue / black / white all
// follow) and handed to the canvas as plain CSS colours. Expressions mirror hud.css: --holo-tint = --hud-tint else --focus.
const TINT = 'var(--holo-tint)';
export const PANEL_EXPRS = Object.freeze({
  holo: `color-mix(in srgb, ${TINT} 72%, var(--foreground))`,      // .hud --holo: heads, codes, brackets
  line: `color-mix(in srgb, ${TINT} 55%, transparent)`,            // .hud --holo-line: panel border
  bg: 'color-mix(in srgb, color-mix(in srgb, var(--holo-tint) 14%, var(--background)) 58%, transparent)', // .hud --holo-bg: panel surface
  scan: `color-mix(in srgb, ${TINT} 9%, transparent)`,            // .hud --holo-scan
  ai: 'color-mix(in srgb, var(--ai) 12%, transparent)',           // .hud-panel violet wash
  title: `color-mix(in srgb, var(--foreground) 88%, ${TINT})`,    // .hud-item colour (task title)
  soft: `color-mix(in srgb, var(--foreground) 62%, ${TINT})`,     // .hud-item .step colour (step label, finished steps)
  waiting: 'color-mix(in srgb, var(--question) 75%, var(--foreground))', // .state.s-waiting
  blocked: 'color-mix(in srgb, var(--danger) 75%, var(--foreground))',   // .state.s-blocked
  glow: `color-mix(in srgb, ${TINT} 30%, transparent)`,           // .hud --holo-glow: halo behind the card
});
/** The card's colours resolved against the live theme (the page's :root tokens). Without a DOM (the Node gates) every colour is `canvastext`. */
export function panelPalette(doc = globalThis.document) {
  const root = doc && doc.documentElement, view = doc && doc.defaultView;
  if (!root || !view || typeof view.getComputedStyle !== 'function' || typeof doc.createElement !== 'function') {
    return Object.fromEntries(Object.keys(PANEL_EXPRS).map((k) => [k, 'canvastext']));
  }
  const probe = doc.createElement('span');
  probe.style.setProperty('--holo-tint', 'var(--hud-tint, var(--focus))');
  root.appendChild(probe);
  try {
    const out = {};
    for (const [k, expr] of Object.entries(PANEL_EXPRS)) { probe.style.color = expr; out[k] = view.getComputedStyle(probe).color; }
    return out;
  } finally { root.removeChild(probe); }
}

/** The feed rows -> what the panel shows, or null when there is no task. Picks the first row whose stepState is
 *  'active', else the first row (the feed is sorted by activity, hud-feed.mjs). Pure -- unit-tested without a canvas. */
export function taskView(updates) {
  const rows = Array.isArray(updates) ? updates.filter((u) => u && typeof u === 'object' && u.title) : [];
  const row = rows.find((u) => u.stepState === 'active') || rows[0];
  if (!row) return null;
  const total = Number.isFinite(row.stepTotal) && row.stepTotal > 0 ? Math.floor(row.stepTotal) : 0;
  const done = Number.isFinite(row.doneCount) && row.doneCount > 0 ? Math.min(Math.floor(row.doneCount), total || Infinity) : 0;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const finished = (Array.isArray(row.log) ? row.log : []).filter((l) => l && l.to === 'done' && l.label).map((l) => String(l.label)); // log is oldest first
  return {
    title: String(row.title),
    progress: `STEP ${done}/${total} · ${pct}% DONE`,
    pct,
    state: Object.prototype.hasOwnProperty.call(STATE_WORDS, row.stepState) ? STATE_WORDS[row.stepState] : '',
    tone: row.stepState === 'waiting' || row.stepState === 'blocked' ? row.stepState : '', // the chip colour (side panels' .state.s-waiting / .s-blocked)
    step: String(row.step || ''),
    done: finished.slice(-DONE_LINES).map((label) => `DONE · ${label}`),
  };
}

/** The card's surface, drawn like .hud-panel in CSS px: radius 10, glass fill, 1-in-3 px scanlines, a violet wash, a 1 px tint border and two 12 px corner brackets. */
function drawFrame(g, pal, w, h, canvasH) {
  const r = 10;
  g.clearRect(0, 0, w, canvasH);
  g.beginPath(); g.roundRect(0.5, 0.5, w - 1, h - 1, r);
  g.fillStyle = pal.bg; g.fill();
  g.save(); g.clip();
  g.strokeStyle = pal.scan; g.lineWidth = 1;
  for (let y = 1.5; y < h; y += 3) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
  const wash = g.createLinearGradient(0, 0, w * 0.55, h);
  if (wash && wash.addColorStop) { wash.addColorStop(0, pal.ai); wash.addColorStop(1, 'transparent'); g.fillStyle = wash; g.fillRect(0, 0, w, h); }
  g.restore();
  g.strokeStyle = pal.line; g.lineWidth = 1; g.beginPath(); g.roundRect(0.5, 0.5, w - 1, h - 1, r); g.stroke();
  // brackets, top-left and bottom-right (.hud-panel::before / ::after)
  g.strokeStyle = pal.holo; g.lineWidth = 2; const k = 12;
  g.beginPath(); g.moveTo(1, k); g.lineTo(1, r); g.arcTo(1, 1, r, 1, r); g.lineTo(k, 1); g.stroke();
  g.beginPath(); g.moveTo(w - 1, h - k); g.lineTo(w - 1, h - r); g.arcTo(w - 1, h - 1, w - r, h - 1, r); g.lineTo(w - k, h - 1); g.stroke();
}
/** `text` broken into at most `maxLines` lines of width <= maxW at the current font; the last line carries the ellipsis if text is left over. */
function wrap(g, text, maxW, maxLines) {
  const words = text.split(/\s+/).filter(Boolean), lines = [];
  let cur = '';
  for (let i = 0; i < words.length; i++) {
    const next = cur ? `${cur} ${words[i]}` : words[i];
    if (g.measureText(next).width <= maxW || !cur) { cur = next; continue; }
    if (lines.length === maxLines - 1) { lines.push(fit(g, [cur, ...words.slice(i)].join(' '), maxW)); return lines; }
    lines.push(cur); cur = words[i];
  }
  if (cur) lines.push(g.measureText(cur).width <= maxW ? cur : fit(g, cur, maxW));
  return lines;
}
/** `text` cut with an ellipsis so it fits `maxW` px in the context's current font. */
function fit(g, text, maxW) {
  if (g.measureText(text).width <= maxW) return text;
  let n = text.length;
  while (n > 1 && g.measureText(text.slice(0, n) + '…').width > maxW) n--;
  return text.slice(0, n) + '…';
}
/** The task card, in the side panels' colours and type, laid out top-down in CSS px like the HUD task panel: title, progress line and thin bar
 *  (.hp-scan), the state word with its dot (.hp-state), the board's step label (.hp-cur), the last finished steps (.hp-sub). A row that does not fit the
 *  card's height is left out, lowest priority first, and the frame ends under the last row, so a short card stays compact. No view -> NO LIVE TASK.
 *  Returns { minPx, frameH, px } (px: the font each drawn role used, in on-screen CSS px). */
export function drawTask(g, pal, view, { cssW = DEFAULT_CARD_CSS_W, cssH = cssW * PANEL_ASPECT, type = HUD_TYPE_DEFAULT } = {}) {
  const padX = 11, padTop = 9, padBottom = 10, maxW = cssW - padX * 2, maxY = cssH - padBottom;
  const used = {};
  const setFont = (role) => {
    const t = type[role];
    g.font = `${t.weight} ${t.px}px ${t.family}`;
    if ('letterSpacing' in g) g.letterSpacing = `${t.ls}px`;
    return t;
  };
  g.textBaseline = 'top'; g.textAlign = 'left';
  if (!view) {
    const t = setFont('head'), frameH = Math.ceil(padTop + t.lh + padBottom);
    drawFrame(g, pal, cssW, frameH, cssH);
    setFont('head'); g.fillStyle = pal.soft; g.textAlign = 'center';
    g.fillText('NO LIVE TASK', cssW / 2, padTop);
    g.textAlign = 'left';
    return { minPx: t.px, frameH, px: { head: t.px } };
  }
  const tone = view.tone === 'waiting' ? pal.waiting : view.tone === 'blocked' ? pal.blocked : pal.holo;
  const rows = [];
  let y = padTop;
  const textRow = (role, color, lines, gapAfter) => {
    const t = setFont(role);
    for (const line of lines) {
      if (y + t.lh > maxY) return false;
      rows.push({ role, color, text: line, y }); used[role] = t.px; y += t.lh;
    }
    y += gapAfter;
    return true;
  };
  setFont('title');
  textRow('title', pal.title, wrap(g, view.title, maxW, cssH >= 130 ? 2 : 1), 3);
  setFont('state');
  if (textRow('state', pal.holo, [fit(g, view.progress, maxW)], 2) && y + 6 <= maxY) { rows.push({ bar: true, y }); y += 6 + 5; }
  if (view.state) { setFont('state'); if (y + type.state.lh <= maxY) { rows.push({ role: 'state', color: tone, text: view.state, y, dot: true }); used.state = type.state.px; y += type.state.lh + 2; } }
  setFont('step');
  if (view.step) textRow('step', pal.title, wrap(g, view.step, maxW, cssH >= 130 ? 2 : 1), 3);
  setFont('sub');
  for (const text of view.done) if (!textRow('sub', pal.soft, [fit(g, text, maxW)], 0)) break;
  const frameH = Math.min(cssH, Math.ceil(y + padBottom));
  drawFrame(g, pal, cssW, frameH, cssH);
  for (const r of rows) {
    if (r.bar) { // .hp-scan: 6 px, 1 px border, the done ratio filled
      g.strokeStyle = pal.line; g.lineWidth = 1; g.strokeRect(padX + 0.5, r.y + 0.5, maxW - 1, 5);
      if (view.pct > 0) { g.fillStyle = pal.holo; g.fillRect(padX + 1, r.y + 1, Math.max(1, Math.round((maxW - 2) * view.pct / 100)), 4); }
      continue;
    }
    setFont(r.role); g.fillStyle = r.color;
    if (r.dot) {
      g.beginPath(); g.arc(padX + 2.5, r.y + type.state.lh / 2, 2.5, 0, Math.PI * 2); g.fill();
      g.fillText(r.text, padX + 10, r.y + (type.state.lh - type.state.px) / 2);
    } else g.fillText(r.text, padX, r.y + (type[r.role].lh - type[r.role].px) / 2);
  }
  if ('letterSpacing' in g) g.letterSpacing = '0px';
  return { minPx: Math.min(...Object.values(used)), frameH, px: used };
}

/** Soft radial glow behind the panel: the side panels' --holo-glow, fading to nothing (the box-shadow of .hud-panel). */
function haloTexture(pal) {
  const c = document.createElement('canvas'); c.width = 128; c.height = 128;
  const g = c.getContext('2d');
  const r = g.createRadialGradient(64, 64, 4, 64, 64, 64);
  r.addColorStop(0, pal.glow); r.addColorStop(0.5, pal.glow); r.addColorStop(1, 'transparent');
  g.fillStyle = r; g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; return tex;
}

export class HoloScreen {
  /** @param parent the main stage THREE.Scene the panel lives in (world space)
   *  @param engine the bound ReflexEngine (hips + head bones, and the MToon materials for the rim garnish)
   *  @param camera the stage camera (for the facing midpoint + the glance NDC)
   *  @param light the shared PointLight created once in app.js
   *  @param P the FLOAT placement constants (offset + scale)
   *  @param glance (look) => void -- the board quick-glance call (app.js owns catalog/engine)
   *  @param isSpeaking () => boolean -- never glance while she talks
   *  @param stageWidth () => number -- the stage canvas width in CSS px; with it update() measures the card's on-screen width and draws at that size */
  constructor({ parent, engine, camera, light, P, glance, isSpeaking, stageWidth }) {
    this.parent = parent; this.engine = engine; this.camera = camera; this.light = light; this.P = P;
    this.glance = glance || (() => {}); this.isSpeaking = isSpeaking || (() => false); this.stageWidth = stageWidth || null;
    this.cssW = DEFAULT_CARD_CSS_W; this.minFontPx = 0; this.fontPx = {}; this.frameH = 0; // the card's on-screen width, and what the last draw used (CSS px)
    // The shared light is created once in app.js; this module owns its falloff (short, so the screen lights only
    // her near side) and its per-frame colour/intensity. See SCREEN_LIGHT_DISTANCE.
    this.light.distance = SCREEN_LIGHT_DISTANCE; this.light.decay = 2;
    this.cd = SCREEN_LIGHT_CD;
    // r6 runtime overrides (box sweep): a rim-strength MULTIPLIER on the tint constants and the fresnel power.
    // Shipped defaults are 1 / EDGE_FRESNEL_POWER; only the dev hook / URL query ever changes them.
    this.rimMul = 1;
    this.fresnelPower = EDGE_FRESNEL_POWER;
    this.on = false; // float mode off -> panel hidden, light 0
    this.pinned = false; // dev hook (pinPage): the panel keeps its page accent (never the Settings pick) -- clip runs compare one colour
    this.lightOn = true; // A/B toggle (dev hook) independent of `on`
    this.mode = 'point'; // 'point' (one coloured PointLight) | 'rim' (MToon rim tint only, no light). setMode().
    this.view = null; this._viewKey = ''; // the task being shown (taskView), null = NO LIVE TASK
    this.pageAccent = HOLO_COLOURS.cyan; this.accent = this.pageAccent; this.prevAccent = this.accent;
    // T-31 float-holo QC switch: a fixed accent (hex) chosen in Settings, or null for the page's own accent.
    this.fixedAccent = null;
    this.changeAt = -Infinity;
    this._v = new THREE.Vector3();

    // canvas + texture
    this.canvas = document.createElement('canvas'); this.canvas.width = 1; this.canvas.height = 1; // draw() sizes it to the card on screen
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas); this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.generateMipmaps = false; this.texture.minFilter = THREE.LinearFilter; this.texture.magFilter = THREE.LinearFilter; // no mip blur: the canvas is sized to the screen
    this.texture.premultiplyAlpha = true; // canvas pixels are premultiplied; unpremultiplied upload + NormalBlending greyed the text's antialiased edges
    // panel (0.42 x 0.26 m at scale 1); `placement` picks which offset/size update() uses (float by default).
    this.placement = 'float';
    const { w: pw, h: ph, scale: panelScale } = panelSize('float', P);
    this._panelScale = panelScale;
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(pw, ph), new THREE.MeshBasicMaterial({
      map: this.texture, transparent: true, opacity: 1, // a glass card like the side panels, not an additive glow
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, // premultiplied, as the page composites the HUD
      depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
    }));
    // halo (1.4x behind)
    this.halo = new THREE.Mesh(new THREE.PlaneGeometry(pw * 1.4, ph * 1.4), new THREE.MeshBasicMaterial({
      map: haloTexture(this.pal = panelPalette()), transparent: true, opacity: 0.5, blending: THREE.NormalBlending,
      depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
    }));
    this.halo.position.z = -0.001; // just behind the panel in the group's local frame
    this.group = new THREE.Group();
    this.group.name = 'holo-screen';
    this.group.add(this.mesh); this.group.add(this.halo);
    this.group.visible = false;
    parent.add(this.group);
    this.draw();
    // data-theme / class changes on <html> (theme.js) re-resolve the card's colours
    if (typeof MutationObserver === 'function' && typeof document.documentElement === 'object' && document.documentElement && document.documentElement.nodeType) {
      this._themeWatch = new MutationObserver(() => this.retheme());
      this._themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    }
    this._rimSaved = null; // [{ material, color, power, lift }] captured while the screen is on
    this._glanceT = 0;
  }

  /** Draws the current view (the live task, or NO LIVE TASK) into the canvas. */
  draw() {
    const g = this.ctx;
    this.pal = panelPalette(); // the live theme: a theme switch repaints (themeWatch)
    const S = texelScale(), cssW = this.cssW, cssH = cssW * PANEL_ASPECT;
    const tw = Math.max(1, Math.round(cssW * S)), th = Math.max(1, Math.round(cssH * S));
    if (this.canvas.width !== tw || this.canvas.height !== th) {
      this.canvas.width = tw; this.canvas.height = th;
      this.texture.dispose(); // a new size needs a new GPU texture
    }
    if (typeof g.setTransform === 'function') g.setTransform(tw / cssW, 0, 0, th / cssH, 0, 0);
    const r = drawTask(g, this.pal, this.view, { cssW, cssH, type: hudType() });
    this.minFontPx = r.minPx; this.fontPx = r.px; this.frameH = r.frameH;
    this.texture.needsUpdate = true;
  }

  /** The card's on-screen width in CSS px (update() measures it every frame; the gates pass a computed width). The canvas is laid out in these px, so
   *  a font size is the size on screen. Redraws only when the width moved by RESIZE_EPS (never for the hover bob). */
  setScreenWidth(cssW) {
    if (!Number.isFinite(cssW) || cssW <= 0) return;
    if (Math.abs(cssW - this.cssW) / this.cssW < RESIZE_EPS) return;
    this.cssW = cssW;
    this.draw();
  }

  /** The theme changed: repaint the card and its glow in the new colours. */
  retheme() {
    this.draw();
    if (this.halo) { this.halo.material.map.dispose(); this.halo.material.map = haloTexture(this.pal); this.halo.material.needsUpdate = true; }
  }

  /** Restarts the flicker/crossfade clock and repaints the canvas (a content or accent change). */
  _flick() {
    this.changeAt = performance.now();
    this.draw();
  }

  /** Paints a new accent (panel border + halo) and restarts the crossfade clock. */
  _paintAccent(hex) {
    this.prevAccent = this.accent;
    this.accent = hex;
    this._flick();
  }

  /** The board feed (the `hud:feed` rows, app.js onWorkFeed) -> the panel. Shows the first task whose step is active,
   *  else the first; an empty feed (HUD Off, board unreachable, nothing running) shows NO LIVE TASK. Repaints and
   *  flickers ONLY when what is shown changed, so the 20 s poll re-sending the same rows costs nothing. While the
   *  panel is up, 120 ms after a change to a task she glances at it (never while speaking, never at NO LIVE TASK). */
  setFeed(updates) {
    const view = taskView(updates);
    const key = view ? JSON.stringify(view) : '';
    if (key === this._viewKey) return;
    this._viewKey = key; this.view = view;
    this._flick();
    clearTimeout(this._glanceT);
    if (!view) return;
    this._glanceT = setTimeout(() => { if (this.on && !this.isSpeaking()) this.glance(this.screenNdc()); }, 120);
  }

  /** T-31 float-holo QC switch: fixes the panel/light/rim accent to one colour (a '#rrggbb' hex) instead of the
   *  live page's accent; null restores the page accents. Live: the next frame crossfades the light and rim. */
  setAccent(hex) {
    const next = /^#[0-9a-f]{6}$/i.test(String(hex || '')) ? String(hex) : null;
    if (next === this.fixedAccent) return;
    this.fixedAccent = next;
    if (!this.pinned) this._paintAccent(next || this.pageAccent);
  }

  /** Dev/test hook (the harness): the panel's own accent, the one a pinned run shows (cyan by default). */
  setPageAccent(hex) {
    if (!/^#[0-9a-f]{6}$/i.test(String(hex || '')) || hex === this.pageAccent) return;
    this.pageAccent = hex;
    this._paintAccent(liveAccent(this.pageAccent, this.fixedAccent, this.pinned));
  }

  /** T-31 C1 step 11: which placement update() uses -- 'float' (the shipped holo) or 'seated' (the smaller work
   *  panel inside the talk crop). Rebuilds the mesh/halo geometry only when the SIZE actually changes, so a caller
   *  may set the placement every time the working signal flips without paying for a new plane each frame. The pose
   *  itself is applied by update(); this only owns offset + size. */
  setPlacement(mode) {
    const next = mode === 'seated' ? 'seated' : 'float';
    if (next === this.placement) return;
    this.placement = next;
    const { w, h, scale } = panelSize(next, this.P);
    if (scale === this._panelScale) return;
    this._panelScale = scale;
    this.mesh.geometry.dispose();
    this.mesh.geometry = new THREE.PlaneGeometry(w, h);
    if (this.halo) { this.halo.geometry.dispose(); this.halo.geometry = new THREE.PlaneGeometry(w * 1.4, h * 1.4); }
  }

  /** Float mode on/off: shows/hides the panel, and zeroes the light when off. On turn-off the rim garnish is
   *  restored; on turn-on the originals are captured. */
  setOn(on) {
    this.on = Boolean(on);
    this.group.visible = this.on;
    if (this.on) { this.changeAt = -Infinity; this.captureRim(); }
    else { clearTimeout(this._glanceT); this.light.intensity = 0; this.restoreRim(); }
  }

  /** Dev/test hook: hold the panel's own accent (cyan or amber, setPageAccent) so a clip keeps one accent for its
   *  whole length. A pinned run owns the accent again: the harness's cyan/amber stills must read the PAGE colour,
   *  not the Settings pick, so a fixed accent is dropped from the panel while pinned (and restored on unpin). */
  pinPage(on) {
    const next = Boolean(on);
    if (next !== this.pinned && this.fixedAccent) this._paintAccent(next ? this.pageAccent : this.fixedAccent);
    this.pinned = next;
  }

  /** A/B dev toggle: the effect only (the panel stays). Point mode: the PointLight. Rim mode: the rim tint -- so
   *  the same harness A/B still works in either mode. */
  setLight(on) { this.lightOn = Boolean(on); }

  /** ZUMI_PILOT_LIGHT_MODE: 'point' | 'rim'. In rim mode the shared PointLight stays at 0 and the MToon
   *  parametric rim is tinted by the accent instead (DESIGN.md §2.3 alternative: no extra light, zero shader
   *  cost, outlines the whole silhouette). Switching restores the saved rim first so a stale tint never sticks. */
  setMode(mode) { const next = parseLightMode(mode); if (next === this.mode) return; this.restoreRim(); this.mode = next; if (this.on) this.captureRim(); }

  /** Overrides the light intensity constant (box tuning via ZUMI_PILOT_LIGHT_CD). */
  setIntensity(cd) { if (Number.isFinite(cd)) this.cd = cd; }

  /** r6 box sweep: runtime rim overrides. `rimMul` scales RIM_ONLY_TINT/RIM_TINT (the tint strength) and
   *  `fresnelPower` replaces EDGE_FRESNEL_POWER (the edge band's width). Out-of-range/NaN is ignored, so a bad
   *  sweep cell cannot silently disable the rim; the shipped constants are never written. */
  setRim({ rimMul, fresnelPower } = {}) {
    if (Number.isFinite(rimMul) && rimMul >= 0 && rimMul <= 10) this.rimMul = rimMul;
    if (Number.isFinite(fresnelPower) && fresnelPower >= 0.5 && fresnelPower <= 10) this.fresnelPower = fresnelPower;
  }

  /** The panel centre in stage NDC (what she glances at). */
  screenNdc() {
    const v = this.group.getWorldPosition(this._v).clone().project(this.camera);
    return { x: v.x, y: v.y };
  }

  /** The panel's projected NDC rectangle (axis-aligned bounds of the mesh's four corners) -- the box the work loop's
   *  reading scan stays inside (T-31 C1 step 8, CONCEPTS §4). Recomputed from the live world matrix, so every framing
   *  (float wide/close, window size) is handled by the projection itself; null when the geometry is unavailable. */
  screenRect() {
    const p = this.mesh && this.mesh.geometry && this.mesh.geometry.parameters;
    if (!p || !Number.isFinite(p.width) || !Number.isFinite(p.height)) return null;
    this.mesh.updateWorldMatrix(true, false);
    const hw = p.width / 2, hh = p.height / 2;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [sx, sy] of CORNERS) {
      const v = this._v.set(sx * hw, sy * hh, 0).applyMatrix4(this.mesh.matrixWorld).project(this.camera);
      // project() mirrors points behind the camera into a plausible-looking box, so reject any corner outside the
      // clip depth: no usable rect behind/at the camera or past the far plane.
      if (!(v.z > -1 && v.z < 1)) return null;
      x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x);
      y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y);
    }
    // Fully off-frame (e.g. a camera that no longer sees her corner of the room): there is nothing to read.
    if (!(x1 > -1 && x0 < 1 && y1 > -1 && y0 < 1)) return null;
    return { x0, x1, y0, y1 };
  }

  /** The live panel PLANE in world space (T-31 C1 step 9): { c, n, r, u, hw, hh, toward, hand }. The work loop's
   *  designed fingertip contact resolves against it. c/n/r/u are plain arrays (metres/unit), +n is the mesh's local
   *  +Z (the side facing the camera, faceCamera), hw/hh its half extents, `toward` +1 when her body is on the +r
   *  side (the near edge) and `hand` the hand on the panel's side. Null when the geometry is unavailable. */
  touchFrame() {
    const p = this.mesh && this.mesh.geometry && this.mesh.geometry.parameters;
    if (!p || !(p.width > 0) || !(p.height > 0)) return null;
    this.mesh.updateWorldMatrix(true, false);
    const m = this.mesh.matrixWorld;
    const c = new THREE.Vector3().setFromMatrixPosition(m);
    const r = new THREE.Vector3(1, 0, 0).transformDirection(m);
    const u = new THREE.Vector3(0, 1, 0).transformDirection(m);
    const n = new THREE.Vector3(0, 0, 1).transformDirection(m);
    const vrm = this.engine && this.engine.vrm;
    const rig = this.engine && this.engine.rig;
    const hips = rig && rig.hipsNode ? rig.hipsNode.getWorldPosition(new THREE.Vector3())
      : vrm ? new THREE.Vector3().setFromMatrixPosition(vrm.scene.matrixWorld) : null;
    let toward = 1, hand = 'right';
    if (hips) {
      toward = hips.clone().sub(c).dot(r) >= 0 ? 1 : -1;
      // her own right in world space (VRM 1.0: -X in the model's frame), so the side test survives her yaw
      const rightAxis = new THREE.Vector3(-1, 0, 0).applyQuaternion(vrm.scene.getWorldQuaternion(new THREE.Quaternion()));
      hand = panelHandSide([hips.x, hips.y, hips.z], [c.x, c.y, c.z], [rightAxis.x, rightAxis.y, rightAxis.z]);
    }
    return { c: [c.x, c.y, c.z], n: [n.x, n.y, n.z], r: [r.x, r.y, r.z], u: [u.x, u.y, u.z], hw: p.width / 2, hh: p.height / 2, toward, hand };
  }

  captureRim() {
    this.restoreRim(); // idempotent: a re-bind / re-enter must not capture an already-tinted rim as the "original"
    this._rimSaved = [];
    const vrm = this.engine.vrm;
    if (!vrm) return;
    vrm.scene.traverse((o) => {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) if (m && m.isMToonMaterial && m.parametricRimColorFactor) this._rimSaved.push({
        material: m,
        color: m.parametricRimColorFactor.clone(),
        // the authored edge shape too: r4 forces lift 0 + a sharp power while on, so it must restore these.
        power: m.parametricRimFresnelPowerFactor,
        lift: m.parametricRimLiftFactor,
      });
    });
  }

  restoreRim() {
    if (!this._rimSaved) return;
    for (const { material, color, power, lift } of this._rimSaved) {
      material.parametricRimColorFactor.copy(color);
      material.parametricRimFresnelPowerFactor = power;
      material.parametricRimLiftFactor = lift;
    }
    this._rimSaved = null;
  }

  /** Per-frame (call from the render loop, after the float hover has moved the root). `t` = seconds. */
  update(t) {
    if (!this.on) return;
    const vrm = this.engine.vrm;
    if (!vrm || !this.engine.rig || !this.engine.rig.hipsNode) return;
    const now = performance.now();

    // position: her hips + the placement's offset, in her (yawed) frame
    const hips = this.engine.rig.hipsNode.getWorldPosition(this._v).clone();
    const o = panelOffset(this.placement, this.P);
    // body/stage frame, never the raw scene quaternion (VRM 0.x base flip; T-31 vrm0-facing r3 + C1 review S1)
    const off = new THREE.Vector3(o[0], o[1], o[2]).applyQuaternion(bodyOrientation(vrm.scene));
    this.group.position.copy(hips).add(off);
    // flat and upright on screen (alpha.10): square to the camera, never turned toward her head
    faceCamera(this.group, this.camera);
    this.group.updateMatrixWorld(true);
    if (this.stageWidth) { const rect = this.screenRect(); if (rect) this.setScreenWidth((rect.x1 - rect.x0) / 2 * this.stageWidth()); }

    // light: at the panel centre, 0.05 m toward her
    const dirToHer = hips.clone().sub(this.group.position).normalize();
    this.light.position.copy(this.group.position).addScaledVector(dirToHer, 0.05);

    const ms = now - this.changeAt;
    const env = flickerEnvelope(ms);
    const k = Math.min(1, ms / 250); // colour crossfade over 250 ms
    // every page accent at the SAME perceived brightness (r4): amber adds no more than cyan (see edgeLightColor).
    const col = toColor(edgeLightColor(this.prevAccent)).lerp(toColor(edgeLightColor(this.accent)), k);
    if (this.mode === 'rim') {
      // Edge/rim mode: the point light stays off; the accent reaches her through the MToon fresnel rim (an edge).
      this.light.intensity = 0;
    } else {
      this.light.color.copy(col);
      this.light.intensity = (this.on && this.lightOn) ? this.cd * env : 0;
    }

    // panel: opacity follows the envelope, plus one 2-frame x-offset glitch right after the change
    this.mesh.material.opacity = env;
    this.mesh.position.x = (ms >= 0 && ms < 33) ? 0.012 : 0;

    // rim/edge light: point mode = a light garnish (RIM_TINT); rim mode = the light itself (RIM_ONLY_TINT). Either
    // way the A/B toggle turns it fully OFF. ON: force lift 0 + a sharp fresnel so it is EDGE-ONLY (a front-facing
    // facet gets no tint). OFF: restore the authored rim -- colour AND the authored lift/power -- so the harness's
    // "off" still is the model's own look, not our forced edge shape.
    if (this._rimSaved) {
      const factor = this.lightOn ? (this.mode === 'rim' ? RIM_ONLY_TINT : RIM_TINT) * this.rimMul : 0;
      const target = col.clone().multiplyScalar(factor);
      for (const s of this._rimSaved) {
        if (factor > 0) {
          s.material.parametricRimColorFactor.copy(s.color).lerp(target, k);
          s.material.parametricRimLiftFactor = EDGE_FRESNEL_LIFT;
          s.material.parametricRimFresnelPowerFactor = this.fresnelPower;
        } else {
          s.material.parametricRimColorFactor.copy(s.color);
          s.material.parametricRimLiftFactor = s.lift;
          s.material.parametricRimFresnelPowerFactor = s.power;
        }
      }
    }
  }

  state() {
    return { on: this.on, placement: this.placement, lightOn: this.lightOn, mode: this.mode, pageName: this.view ? 'task' : 'idle', cssW: this.cssW, minFontPx: this.minFontPx, fontPx: this.fontPx, frameH: this.frameH, accent: this.accent, pageAccent: this.pageAccent, fixedAccent: this.fixedAccent, cd: this.cd, distance: this.light.distance, intensity: this.light.intensity, visible: this.group.visible, rimMul: this.rimMul, fresnelPower: this.fresnelPower };
  }
}
