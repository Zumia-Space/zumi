// avatar-core pose writers: the final step that turns a frame's accumulated channels into bone rotations and VRM
// expression weights. Shared by the main-webview ReflexEngine (its gestures write into the same accumulator) and by the
// core's own standalone update(). Pure functions of (nodes|vrm, accumulated values): no state, no app imports.
import { BONE_LIMITS_DEG } from '../reflex/schema.js';

const DEG = Math.PI / 180;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export const DRIVEN_EXPR = ['happy', 'angry', 'sad', 'relaxed', 'surprised', 'aa', 'ih', 'ou', 'ee', 'oh', 'blink', 'blinkLeft', 'blinkRight'];
export const EMOTIONS = ['happy', 'angry', 'sad', 'relaxed', 'surprised'];
export const MOUTH = ['aa', 'ih', 'ou', 'ee', 'oh'];
export const TORSO = ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head', 'leftShoulder', 'rightShoulder', 'leftHand', 'rightHand'];
const FK_ARM = ['leftUpperArm', 'leftLowerArm', 'rightUpperArm', 'rightLowerArm'];

/** Normalised-bone nodes the torso writer drives (missing ones are null). */
export function torsoNodes(vrm) {
  const nodes = {};
  for (const n of TORSO) nodes[n] = vrm.humanoid.getNormalizedBoneNode(n) || null;
  return nodes;
}

/**
 * Sums the accumulated bone offsets onto the torso/head/shoulder/hand bones (a missing chest falls back down the chain),
 * clamps each to its limit and sets the rotation. Arm bones are the caller's (IK / FK), so they are skipped here.
 * Returns the unclamped per-bone sums (the engine keeps them as lastFinal.final).
 */
export function applyTorso(nodes, bones) {
  const redirect = { upperChest: ['chest', 'spine'], chest: ['spine'], neck: ['head'] };
  const final = {};
  for (const name of TORSO) final[name] = [0, 0, 0];
  for (const [name, v] of Object.entries(bones)) {
    if (FK_ARM.includes(name)) continue;
    let target = name;
    if (!nodes[target]) target = (redirect[name] || []).find((n) => nodes[n]) || null;
    if (!target || !final[target]) continue;
    final[target][0] += v[0]; final[target][1] += v[1]; final[target][2] += v[2];
  }
  for (const name of TORSO) {
    const node = nodes[name];
    if (!node) continue;
    const lim = BONE_LIMITS_DEG[name];
    const v = final[name];
    node.rotation.set(clamp(v[0], -lim[0] * DEG, lim[0] * DEG), clamp(v[1], -lim[1] * DEG, lim[1] * DEG), clamp(v[2], -lim[2] * DEG, lim[2] * DEG));
  }
  return final;
}

/** Accumulated expression weights -> clamped 0..1, with the emotion group and the mouth group each kept at a total <= 1. */
export function mixExpressions(exprAcc) {
  const ex = {};
  for (const n of DRIVEN_EXPR) ex[n] = clamp(exprAcc[n] || 0, 0, 1);
  for (const group of [EMOTIONS, MOUTH]) {
    const s = group.reduce((a, n) => a + ex[n], 0);
    if (s > 1) for (const n of group) ex[n] /= s;
  }
  return ex;
}

/** Writes mixed weights to the VRM's expression manager (a model without one is left alone). */
export function applyExpressions(vrm, ex) {
  const em = vrm.expressionManager;
  if (em) for (const n of DRIVEN_EXPR) em.setValue(n, ex[n]);
}
