// Holo panel legibility (T-31 alpha.3 R3 round 2): how big the panel's text is ON SCREEN, shared by check-float-holo.mjs (float, both framings)
// and check-work-seated.mjs (seated). Plain Node: the real HoloScreen runs against a recording 2D context, so every fillText is captured with
// the font it was drawn in; the panel's on-screen width (CSS px) comes from the caller's projection (the same maths update() uses).
//   on-screen font px = drawn font px x (panel on-screen width / the width the card was laid out at)   (alpha.12: laid out at the measured width, so ~1:1;
//   a build without state().cssW used a fixed 512 px canvas). The floor was 11 px (REVIEW-OPUS alpha3/r3); owner 01-11 asks for the HUD's own type, whose
//   smallest line is 9 px, so the floor is the HUD's. The exact match per role is scripts/check-holo-type.mjs.
import * as THREE from 'three';

export const MIN_ON_SCREEN_PX = 8.6; // 9 px less the 4 % a card may drift before its next redraw
/** The stage canvas (CSS px) of a window, measured off the real app shots: the window minus the 76 px rail, the 45 px toolbar and the ~68 px composer. */
export const STAGE_CANVAS = Object.freeze({ '1366x768': [1290, 655], '1920x1080': [1844, 967] });

/** A task row in the shape of a hud:feed row (src/main/hud-feed.mjs). Worst case for width: the longest state word, long title and labels. */
export const LEGIBLE_FIXTURE = Object.freeze({
  id: 'T-LEG', title: 'Render the float demo video for the owner review', status: 'working', step: 'Check the framing of the hero shot in the wide view',
  stepId: 's19', stepState: 'waiting', doneCount: 19, stepTotal: 37, steps: [],
  log: [{ label: 'Receive the report', from: 'active', to: 'done' }, { label: 'Find the memory', from: 'active', to: 'done' }, { label: 'Open the browser', from: 'active', to: 'done' }],
});

/** Runs `fn(HoloScreen-making function)` with a fake document whose canvases record their text. */
export function measureHolo(HoloScreen, FLOAT, cssW, row = LEGIBLE_FIXTURE) {
  const texts = [];
  const rec = new Proxy({}, {
    get(t, k) {
      if (k === 'measureText') return (s) => ({ width: String(s).length * (parseFloat(/(\d+(?:\.\d+)?)px/.exec(t.font || '')?.[1]) || 10) * 0.55 }); // monospace advance ~0.55 em
      if (k === 'createRadialGradient') return () => ({ addColorStop() {} });
      if (k === 'fillText') return (s, x, y) => { texts.push({ s: String(s), x, y, px: parseFloat(/(\d+(?:\.\d+)?)px/.exec(t.font || '')?.[1]) }); };
      if (k in t) return t[k];
      return () => {};
    },
    set(t, k, v) { t[k] = v; return true; },
  });
  const prevDoc = globalThis.document;
  globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => rec }) };
  try {
    const light = { distance: 0, decay: 0, intensity: 0, position: new THREE.Vector3(), color: new THREE.Color() };
    const holo = new HoloScreen({ parent: new THREE.Scene(), engine: {}, camera: new THREE.PerspectiveCamera(28, 16 / 9, 0.05, 50), light, P: FLOAT });
    if (typeof holo.setScreenWidth === 'function') holo.setScreenWidth(cssW);
    texts.length = 0;
    // a build without the live-task panel (no setFeed) has nothing legible to measure: report it as NaN so every >= 11 px assertion FAILS instead of crashing
    if (typeof holo.setFeed !== 'function') return { layout: undefined, cssW: Math.round(cssW), rows: 0, livePx: NaN, liveOnScreen: NaN, idlePx: NaN, idleOnScreen: NaN, live: [], idle: [] };
    holo.setFeed([row]);
    const live = texts.splice(0);
    holo.setFeed([]);
    const idle = texts.splice(0);
    const minOf = (arr) => (arr.length ? Math.min(...arr.map((t) => t.px)) : NaN);
    const scale = cssW / (holo.state().cssW || 512);
    return {
      cssW: Math.round(cssW), drawnCssW: holo.state().cssW || 512, rows: new Set(live.map((t) => t.y)).size,
      livePx: minOf(live), liveOnScreen: minOf(live) * scale, idlePx: minOf(idle), idleOnScreen: minOf(idle) * scale, live, idle,
    };
  } finally { globalThis.document = prevDoc; }
}
