// HUD clearance probe (T-31 hud-react, 06-10 intersection rule: no body part may pass behind or through a HUD panel).
// The check itself runs in dev/test runs only (scripts/electron-hud.cjs reads the result from the HUD's log): projects both arms -- upper arm,
// forearm, hand, finger tips, sampled along each segment -- into the stage's screen space with the live camera, and
// reports every sample that falls inside a visible HUD panel's box (inflated by the arm's on-screen half-thickness).
// A rotated style-B panel is tested by its axis-aligned bounding box, which only ever over-reports. armScreenPoints
// is also what hud.js uses, every frame, to make a panel group step aside before an arm reaches it.
import * as THREE from 'three';

const CHAINS = ['right', 'left'].map((s) => [`${s}UpperArm`, `${s}LowerArm`, `${s}Hand`, `${s}MiddleIntermediate`, `${s}MiddleDistal`]);
const STEPS = 6;
const v = new THREE.Vector3();
const w = new THREE.Vector3();

/** -> [{ bone, x, y }] in client px: every arm segment sampled STEPS times, plus a finger tip past the distal joint. */
export function armScreenPoints(engine, canvas) {
  const vrm = engine && engine.vrm;
  const cam = engine && engine.camera;
  if (!vrm || !cam) return [];
  vrm.scene.updateMatrixWorld(true);
  const r = canvas.getBoundingClientRect();
  const toScreen = (p) => { const q = p.clone().project(cam); return { x: r.left + ((q.x + 1) / 2) * r.width, y: r.top + ((1 - q.y) / 2) * r.height }; };
  const out = [];
  for (const chain of CHAINS) {
    const pos = chain.map((n) => { const b = vrm.humanoid.getRawBoneNode(n); return b ? b.getWorldPosition(new THREE.Vector3()) : null; });
    for (let i = 0; i < pos.length - 1; i++) {
      if (!pos[i] || !pos[i + 1]) continue;
      for (let k = 0; k <= STEPS; k++) { v.lerpVectors(pos[i], pos[i + 1], k / STEPS); out.push({ bone: chain[i], ...toScreen(v) }); }
    }
    const [, , , mid, dist] = pos;
    if (mid && dist) { w.subVectors(dist, mid).multiplyScalar(1.2).add(dist); out.push({ bone: chain[4] + '-tip', ...toScreen(w) }); }
  }
  return out;
}

/** Visible HUD panels -> [{ id, left, top, right, bottom }] in client px. A panel whose group has stepped aside
 *  (hud.js yield: opacity 0) is not on screen, so it is not counted. */
export function panelRects(root) {
  if (!root || root.hidden) return [];
  const shown = (el) => { const g = el.closest('.hud-group'); return !g || parseFloat(getComputedStyle(g).opacity) > 0.15; };
  return [...root.querySelectorAll('.hud-panel')].filter((el) => el.getClientRects().length && !el.closest('[hidden]') && shown(el)).map((el) => {
    const b = el.getBoundingClientRect();
    return { id: el.id || el.className.replace(/\s+/g, '.'), left: b.left, top: b.top, right: b.right, bottom: b.bottom };
  }).filter((b) => b.right > b.left && b.bottom > b.top);
}

/** Arm samples inside a panel box grown by `margin` px. -> [{ bone, x, y, panel }] */
export function armPanelHits(engine, canvas, root, margin = 10) {
  const panels = panelRects(root);
  if (!panels.length) return [];
  const hits = [];
  for (const p of armScreenPoints(engine, canvas)) {
    const in_ = panels.find((b) => p.x > b.left - margin && p.x < b.right + margin && p.y > b.top - margin && p.y < b.bottom + margin);
    if (in_) hits.push({ bone: p.bone, x: Math.round(p.x), y: Math.round(p.y), panel: in_.id });
  }
  return hits;
}
