// Rig helpers: body measurements, two-bone arm + leg IK on VRM normalized bones, named reach targets, finger poses,
// and screen-space hit regions. Everything is body-relative so gestures fit every bundled VRM.
import * as THREE from 'three';
import { bodyOrientation } from '../model-facing.js';

// T-31 C1 review R1: while the work loop's designed panel contact is on a hand, that wrist never covers more than
// this many metres per second between two frames -- the spec's "wrist < 1.5 m/s at every transition" with margin.
// It binds only when a real catalog gesture takes the same hand over mid-contact (a fast enter would otherwise sweep
// the arm off the glass); a contact on its own never gets near it. Inert whenever no contact is live.
const CONTACT_MAX_WRIST_SPEED = 1.2;

// Reach targets. Every preset resolves to a WRIST target + an elbow pole, in the character's own frame
// (chest axes; 'out' = away from the body on that hand's side, 'fwd' = toward the viewer).
//   shoulder: pos [out, up, fwd] from the upper-arm joint, in arm lengths (legacy presets).
//   face:     a contact point measured on THIS model's face (see measureSurfaces), in the head frame so it follows
//             a nod/turn; the knuckles land on it and the wrist sits one palm length back along handDir.
//   beside:   raised-hand pose built from the arm itself: upper arm `drop` deg below horizontal and `ahead` deg
//             forward, forearm up (tilted `tilt` deg forward, `splay` deg outward); pushed out until the wrist clears the measured
//             head width (ear parts included) by `clear` m. Chest axes, so it does not swing when the head turns.
//   chest:    palm on the measured chest surface on the hand's own side.
//   hip:      palm on the side of the measured waist (hips-weighted vertices), elbow out and back.
//   dir:      arm extended from the shoulder along [screen-right, up, toward viewer] (chest axes).
// Offsets/osc are [out, up, fwd] in arm lengths for every kind.
const REACH = {
  rest: { kind: 'shoulder', pos: [0.15, -0.88, 0.14], pole: [0.45, -0.1, -1] },
  // T-31 seated base: relaxed hands in the lap -- elbows bent ~120 deg, out and back, palms on the thighs (handDir lays
  // the hand along the thigh, see restHand()). Replaces the earlier mid-thigh target [-0.072, -0.83, 0.507] (owner QC
  // 09-10, talk view: "stiff straight arms" -- measured elbows 154 deg, and the fingers, continuing the forearm, 12 cm
  // into the thighs). Not higher/closer: from [-0.08, -0.725, 0.45] or [-0.12, -0.70, 0.36] (elbows 105 deg) the
  // think-hand-on-chin swing clips the torso core (check:motion-seated). Arm lengths at the bind scale; the IK scales the result
  // with the seat scale, so the hands land on the thighs in every view. Used only as the solveArms fallback
  // (Rig.seated), so any active reach request still fully overrides it -- see solveArms().
  seatedRest: { kind: 'shoulder', pos: [-0.08, -0.74, 0.45], pole: [1, 0.15, -0.55], handDir: [-0.15, -0.12, 1] },
  // 'beside' (not 'shoulder'): a shoulder-kind reach to a forward target leaves the forearm pointing forward, so
  // the open-flat hand is seen EDGE-ON and reads as a fist from the front (measured 2026-10-03: palm normal only
  // ~50% toward the viewer). The raised waves ('wave'/'beside-head') build the pose from the arm instead -- elbow
  // dropped below the shoulder, forearm up -- so the fingers point up and the palm faces the viewer. This is the
  // same construction, only with the elbow dropped further (55 deg) so the wrist lands at SHOULDER height rather
  // than beside the head: a small wave that still shows the viewer an open palm (palm normal ~97% +Z, fingers
  // ~95% up) instead of the edge of the hand.
  'wave-small': { kind: 'beside', drop: 55, ahead: 15, tilt: 6, splay: 18, clear: 0.05 },
  hip: { kind: 'hip', handDir: [-0.25, -0.45, 0.85], pole: [1, 0.15, -0.55] },
  clasp: { kind: 'shoulder', pos: [-0.24, -0.72, 0.3], pole: [0.4, -0.5, -0.8] },
  overhead: { kind: 'shoulder', pos: [0.5, 0.66, 0.05], pole: [1, 0, -0.3] },
  'point-sidebar': { kind: 'shoulder', pos: [0.8, 0.1, 0.52], pole: [0, -1, 0], leftPos: [-0.35, 0.1, 0.85] },
  'point-camera': { kind: 'shoulder', pos: [0.12, 0.05, 0.95], pole: [0.5, -1, 0] },
  'point-out': { kind: 'shoulder', pos: [0.93, 0.15, 0.3], pole: [0.1, -1, -0.3] },
  chin: { kind: 'face', at: 'chin', handDir: [-0.25, 1, 0.3], pole: [0.3, -1, 0.2] },
  mouth: { kind: 'face', at: 'mouth', handDir: [-0.25, 1, 0.3], pole: [0.3, -1, 0.15] },
  face: { kind: 'face', at: 'face', handDir: [-0.15, 1, 0.15], pole: [0.4, -1, 0.1] },
  eye: { kind: 'face', at: 'eye', handDir: [-0.1, 1, 0.2], pole: [0.45, -1, 0] },
  'beside-head': { kind: 'beside', drop: 32, ahead: 20, tilt: 8, splay: 20, clear: 0.05 },
  chest: { kind: 'chest', handDir: [-0.2, 0.7, -0.6], pole: [0.15, -1, -0.35] },
  'point-screen-right': { kind: 'dir', dir: [1, 0.12, 0.25], pole: [0, -1, -0.3] },
  'point-screen-left': { kind: 'dir', dir: [-1, 0.12, 0.25], pole: [0, -1, -0.3] },
  'point-viewer': { kind: 'dir', dir: [0, 0.08, 1], pole: [0.5, -1, 0] },
  'point-up': { kind: 'dir', dir: [0, 1, 0.2], pole: [1, 0, -0.3] },
  // T-31 C1 step 9: the work loop's designed panel contact. No fixed pose and no stored plane: engine.applyPose
  // injects this request AFTER the holo clamp with a per-frame world FINGERTIP point (engine.setWorkReach), and the
  // solver puts the WRIST one hand-length back along the approach so the tip lands on the glass. `pole` is only the
  // elbow hint. The name is absent from schema.js REACH_TARGETS, so no catalog/LLM command can request it
  // (review N1/N2); resolve()'s point-less fallback below is a plain low rest, never a panel guess.
  'panel-touch': { kind: 'point', pole: [0.2, -1, 0.25] },
};
REACH.wave = REACH['beside-head']; // the built-in entrance waves share the measured wave pose

// Surfaces measured from the skinned mesh at rest: vertices whose dominant joint (weight >= 0.6) is the head
// (resp. upper chest) give this model's real face/head/chest, so contacts land ON a big anime head instead of
// inside it. Returns head-local / chest-local points (m) and a head ellipsoid for the forearm guard.
function measureSurfaces(vrm, headN, chestN, hipsN, frame) {
  const raw = (n) => vrm.humanoid.getRawBoneNode(n);
  const headRaw = raw('head'), chestRaw = raw('upperChest') || raw('chest'), hipsRaw = raw('hips');
  vrm.scene.updateMatrixWorld(true);
  const headInv = frame(headN).invert(), chestInv = frame(chestN).invert(), hipsInv = frame(hipsN).invert();
  const H = [], C = [], P = [];
  vrm.scene.traverse((o) => {
    if (!o.isSkinnedMesh || !o.geometry.attributes.skinIndex) return;
    const hi = o.skeleton.bones.indexOf(headRaw), ci = chestRaw ? o.skeleton.bones.indexOf(chestRaw) : -1, pi = o.skeleton.bones.indexOf(hipsRaw);
    if (hi < 0 && ci < 0 && pi < 0) return;
    const g = o.geometry, sI = g.attributes.skinIndex, sW = g.attributes.skinWeight;
    for (let i = 0; i < g.attributes.position.count; i++) {
      let b = 0;
      for (let k = 1; k < 4; k++) if (sW.getComponent(i, k) > sW.getComponent(i, b)) b = k;
      if (sW.getComponent(i, b) < 0.6) continue;
      const j = sI.getComponent(i, b);
      if (j !== hi && j !== ci && j !== pi) continue;
      const pt = o.getVertexPosition(i, V()).applyMatrix4(o.matrixWorld);
      if (j === hi) H.push(pt.applyMatrix4(headInv)); else if (j === ci) C.push(pt.applyMatrix4(chestInv)); else P.push(pt.applyMatrix4(hipsInv));
    }
  });
  const pct = (a, q) => { if (!a.length) return 0; const so = [...a].sort((x, y) => x - y); return so[Math.min(so.length - 1, Math.floor(q * so.length))]; };
  const maxOf = (a, f, def) => (a.length ? Math.max(...a.map(f)) : def);
  if (H.length < 50) return null;
  const strip = H.filter((pt) => Math.abs(pt.x) < 0.02 && pt.z > 0);
  const eyeN = vrm.humanoid.getNormalizedBoneNode('leftEye');
  const eyeY = eyeN ? eyeN.getWorldPosition(V()).applyMatrix4(headInv).y : pct(H.map((pt) => pt.y), 0.45);
  const chinY = pct(strip.map((pt) => pt.y), 0.02);
  const frontAt = (y, dy = 0.012) => maxOf(strip.filter((pt) => Math.abs(pt.y - y) < dy), (pt) => pt.z, pct(strip.map((pt) => pt.z), 0.9));
  const halfAt = (y0, y1) => pct(H.filter((pt) => pt.y >= y0 && pt.y <= y1).map((pt) => Math.abs(pt.x)), 0.98);
  const mouthY = chinY + 0.3 * (eyeY - chinY);
  const faceY = (mouthY + eyeY) / 2;
  const lo = (k) => pct(H.map((pt) => pt[k]), 0.02), hi = (k) => pct(H.map((pt) => pt[k]), 0.98);
  const head = {
    chin: V().set(0.01, chinY - 0.012, frontAt(chinY + 0.01) - 0.008),
    mouth: V().set(0.01, mouthY, frontAt(mouthY) + 0.015),
    face: V().set(0, faceY, frontAt(faceY) + 0.045),
    eye: V().set(0.4 * halfAt(eyeY - 0.02, eyeY + 0.02), eyeY, frontAt(eyeY) + 0.02),
    halfW: halfAt(chinY, eyeY + 0.08), // widest part at face height, ear parts included
    ellC: V().set((lo('x') + hi('x')) / 2, (lo('y') + hi('y')) / 2, (lo('z') + hi('z')) / 2),
    ellR: V().set((hi('x') - lo('x')) / 2 + 0.012, (hi('y') - lo('y')) / 2 + 0.012, (hi('z') - lo('z')) / 2 + 0.012),
  };
  // a high collar (chest-weighted, it does not follow the head): front z and height band in chest space. Measured
  // before the chest contact because the contact sits just BELOW its bottom (the collar bottom is the collar bone line).
  const neckY = headN.getWorldPosition(V()).applyMatrix4(chestInv).y;
  const col = C.filter((pt) => Math.abs(pt.x) < 0.05 && pt.y > neckY - 0.12);
  const collar = col.length > 10 ? { z: maxOf(col, (pt) => pt.z, 0), y0: Math.min(...col.map((pt) => pt.y)), y1: Math.max(...col.map((pt) => pt.y)) } : null;
  // Palm-on-chest contact on the hand's own side: the FRONT of the UPPER chest, at MID-STERNUM, clearly below both
  // the collar bone line and the chin. Upper-chest weighted vertices also include the jacket's stand-up collar
  // behind the neck and the belly below it; taking a high percentile of ALL of them (d3d1f50) put the contact ~12 cm
  // below the shoulder on zumi-v3, so the startle hands read as 'clutching the stomach'. Anchoring it AT/above the
  // shoulder instead (02b4a35, a third of the way from the shoulder to the neck) put the wrist almost directly above
  // the shoulder: with the elbow pole already pulling the elbow down against the ribs, the shoulder-elbow-wrist
  // triangle nearly degenerates to a vertical line (shoulder/wrist ~0.12 m apart against a ~0.43 m arm), so the
  // forearm comes up nearly vertical and the straight 'open' fingers (no wrist-flex joint in this rig; a hand
  // rigidly extends its forearm's own direction) swing on past the wrist to ~6 cm ABOVE the chin — check:motion
  // never saw it (it only measures the wrist), but the rendered crop showed both hands covering the mouth/cheeks.
  // A fixed 9 cm BELOW the shoulder (true mid-sternum) reopens the shoulder-wrist triangle (~0.25 m apart), giving
  // the forearm a believable diagonal angle instead of a vertical one, so even straight fingers stay well under the
  // chin. Keep only FRONT (z > median) vertices on the hand's own side, so the contact is on the chest, never behind
  // the torso.
  let chest = null;
  const armN = vrm.humanoid.getNormalizedBoneNode('leftUpperArm') || vrm.humanoid.getNormalizedBoneNode('rightUpperArm');
  const shoulderY = armN ? armN.getWorldPosition(V()).applyMatrix4(chestInv).y : Infinity;
  const sternumY = shoulderY - 0.09; // ~9 cm below the shoulder: true mid-sternum, between d3d1f50's belly and 02b4a35's collar
  const zMid = pct(C.map((pt) => pt.z), 0.5);
  const own = C.filter((pt) => pt.z > zMid && pt.y > sternumY - 0.035 && pt.y < sternumY + 0.035 && pt.x > 0.02 && pt.x < 0.095);
  if (own.length > 6) {
    const y = pct(own.map((pt) => pt.y), 0.5);
    chest = V().set(0.05, y, maxOf(own.filter((pt) => Math.abs(pt.y - y) < 0.02), (pt) => pt.z, 0.1) + 0.012);
  }
  const box = (pts) => (pts.length > 20 ? { min: V().set(pct(pts.map((q) => q.x), 0.02), pct(pts.map((q) => q.y), 0.02), pct(pts.map((q) => q.z), 0.02)), max: V().set(pct(pts.map((q) => q.x), 0.98), pct(pts.map((q) => q.y), 0.98), pct(pts.map((q) => q.z), 0.98)) } : null);
  // hand-on-hip contact: side of the waist near the top of the hips-weighted band (hips space, left side +x)
  let hip = null;
  const side = P.filter((q) => q.x > 0);
  if (side.length > 20) {
    const y = pct(side.map((q) => q.y), 0.85), band = side.filter((q) => Math.abs(q.y - y) < 0.02);
    const zs = band.map((q) => q.z).sort((u, v) => u - v);
    hip = V().set(pct(band.map((q) => q.x), 0.98) + 0.012, y, zs.length ? zs[zs.length >> 1] : 0);
  }
  return { head, chest, collar, chestBox: box(C), hip };
}

// Finger curl in degrees toward the palm: [proximal, intermediate, distal] per finger; the thumb row is
// [metacarpal, proximal, distal] and also folds across the palm by `thumbIn` degrees.
const HAND_SHAPES = {
  open: { index: [0, 0, 0], middle: [0, 0, 0], ring: [0, 0, 0], little: [0, 0, 0], thumb: [0, 0, 0], thumbIn: 0 },
  // 'open' with thumbIn 0 leaves the thumb at its bind-pose direction, which points up and away from the fingers on
  // this rig — with the other four fingers given any curl at all (even 'relaxed's mild one) and the thumb left
  // uncurled AND unrotated, the thumb reads as raised above the knuckles: a thumbs-up, not a loosely open hand. This
  // shape keeps the fingers close to 'open' (barely curled) but folds the thumb in (thumbIn) to lie alongside the
  // index, not pointing past it.
  loose: { index: [6, 8, 5], middle: [8, 10, 6], ring: [10, 12, 7], little: [12, 12, 8], thumb: [5, 8, 5], thumbIn: 38 },
  // 'loose' with the four fingers fully extended: the natural open hand for a WAVE. Same thumb logic as 'loose'
  // (thumbIn 38 folds the thumb across the palm, the 5/8/5 thumb curl lays its proximal/distal alongside the
  // index) but every finger phalanx at zero curl, so an open wave does not read as a soft fist. The thumb-rise
  // guard measures the thumb tip against the index MCP, and neither of those depends on the other four fingers'
  // curl, so 'open-flat' passes exactly where 'loose' does. This rig's applyHands has no per-finger abduction
  // channel (only curl about Z + the thumb's thumbIn about Y), so no finger spread is applied.
  'open-flat': { index: [0, 0, 0], middle: [0, 0, 0], ring: [0, 0, 0], little: [0, 0, 0], thumb: [5, 8, 5], thumbIn: 38 },
  relaxed: { index: [12, 18, 10], middle: [18, 22, 12], ring: [22, 25, 14], little: [28, 28, 16], thumb: [6, 12, 12], thumbIn: 10 },
  fist: { index: [80, 95, 55], middle: [85, 95, 55], ring: [88, 95, 55], little: [90, 95, 55], thumb: [15, 35, 40], thumbIn: 35 },
  point: { index: [0, 0, 0], middle: [80, 95, 55], ring: [88, 95, 55], little: [90, 95, 55], thumb: [15, 35, 40], thumbIn: 35 },
  thumbsUp: { index: [80, 95, 55], middle: [85, 95, 55], ring: [88, 95, 55], little: [90, 95, 55], thumb: [0, 0, 0], thumbIn: -20 },
};
const FINGERS = { index: ['IndexProximal', 'IndexIntermediate', 'IndexDistal'], middle: ['MiddleProximal', 'MiddleIntermediate', 'MiddleDistal'], ring: ['RingProximal', 'RingIntermediate', 'RingDistal'], little: ['LittleProximal', 'LittleIntermediate', 'LittleDistal'], thumb: ['ThumbMetacarpal', 'ThumbProximal', 'ThumbDistal'] };

const DEG = Math.PI / 180;
const V = () => new THREE.Vector3();
const Q = () => new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _v1 = V(), _v2 = V(), _v3 = V(), _v4 = V();
const _q1 = Q(), _q2 = Q(), _q3 = Q();

function basisQuat(a, c, n, out) {
  _m.makeBasis(a, c, n);
  return out.setFromRotationMatrix(_m);
}

// The Rig's rest frames (arms[*].restInvUpper/Lower, legs[*] the same) are captured in the BODY frame -- the model's
// own frame with +Z her front and +X her left, for BOTH versions (model-facing.js bodyOrientation). three-vrm's
// normalized skeleton is plain Object3Ds with identity local rotations, so every normalized bone's rest ORIENTATION
// is the root's world orientation, and a VRM 0.x model carries a 180-degree base flip there (prepareVrm). Capturing
// the rest bend reference in the ROOT frame put that flip into every solve: positions still landed, but each solved
// bone came out rolled 180 degrees about its own axis, so VRM 0.x arms/legs pointed their BACKS at the bend/pole
// direction (knees and elbows reversed; T-31 review round 3). The body frame is version-independent, so the bend
// directions are anatomical on both versions.
//
// `rootedBasis` therefore expresses a world-space basis in the body frame, applies the rest-relative delta there, and
// right-appends the model's own base flip (`base` = body^-1 * root; identity for VRM 1.0) so the result is still a
// world orientation. Callers rotate it into the parent's local space. VRM 1.0 has body == root and base == identity,
// so it is bit-identical to the old math.
export function rootedBasis(a, c, n, restInv, bodyInv, base, out = Q()) {
  const ab = a.clone().applyQuaternion(bodyInv), cb = c.clone().applyQuaternion(bodyInv), nb = n.clone().applyQuaternion(bodyInv);
  return basisQuat(ab, cb, nb, out).multiply(restInv).multiply(base);
}

export class Rig {
  constructor(vrm) {
    this.vrm = vrm;
    const h = vrm.humanoid;
    const node = (n) => h.getNormalizedBoneNode(n) || null;
    this.nodes = {};
    for (const n of ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head', 'leftShoulder', 'rightShoulder',
      'leftUpperArm', 'leftLowerArm', 'leftHand', 'rightUpperArm', 'rightLowerArm', 'rightHand']) this.nodes[n] = node(n);
    this.root = h.normalizedHumanBonesRoot;
    this.chestNode = this.nodes.upperChest || this.nodes.chest || this.nodes.spine || this.nodes.hips;

    h.resetNormalizedPose();
    vrm.scene.updateMatrixWorld(true);
    const wp = (n) => (this.nodes[n] ? this.nodes[n].getWorldPosition(V()) : null);
    // Rest frames are captured in the BODY frame (see rootedBasis): the model's own frame at rest, +Z her front for
    // both VRM versions. The root frame carries a VRM 0.x model's 180-degree base flip (root +Z would be her BACK),
    // which rolled every solved bone 180 degrees about its own axis on VRM 0.x (T-31 review round 3). Stored, because
    // the solve must happen in EXACTLY this frame for the whole lifetime of the rig: the rest directions below are
    // the bones' local offsets expressed in body coordinates, and they are invariant under any later stage/seat
    // rotation (placeSeated/placeFloat run after bind).
    this.restRoot = this.root.getWorldQuaternion(Q());
    this.restBody = bodyOrientation(vrm.scene);
    const bodyInvAtRest = this.restBody.clone().invert();
    this.restBodyInv = bodyInvAtRest;
    // The model's own base orientation (VRM 0.x flip), expressed between the body and root frames: identity for
    // VRM 1.0. Appended to every solved frame so the result stays a world orientation (see rootedBasis).
    this.restBase = bodyInvAtRest.clone().multiply(this.restRoot);
    // Same flip, for the SEMANTIC node frames (see frame/axesOf): null for VRM 1.0 so that path stays untouched.
    this.restBaseInv = Math.abs(this.restBase.w) < 0.99999 ? this.restBase.clone().invert() : null;
    this.arms = {};
    for (const side of ['left', 'right']) {
      const up = wp(`${side}UpperArm`), lo = wp(`${side}LowerArm`), ha = wp(`${side}Hand`);
      if (!up || !lo || !ha) continue;
      const L1 = up.distanceTo(lo), L2 = lo.distanceTo(ha);
      const restFrame = (dir) => {
        const a = dir.clone().applyQuaternion(bodyInvAtRest).normalize();
        const c = new THREE.Vector3(0, 0, 1).addScaledVector(a, -a.z).normalize();
        const n = a.clone().cross(c);
        return basisQuat(a, c, n, Q()).invert();
      };
      this.arms[side] = {
        sign: side === 'left' ? 1 : -1, // 'out' axis = sign * chest X
        L1, L2, A: L1 + L2,
        restInvUpper: restFrame(lo.clone().sub(up)),
        restInvLower: restFrame(ha.clone().sub(lo)),
        upper: this.nodes[`${side}UpperArm`], lower: this.nodes[`${side}LowerArm`], hand: this.nodes[`${side}Hand`],
      };
    }
    // legs: two-bone IK chains that keep the feet on their rest spots while the root channel moves the hips
    this.legs = {};
    for (const side of ['left', 'right']) {
      const n = (b) => h.getNormalizedBoneNode(`${side}${b}`) || null;
      const upper = n('UpperLeg'), lower = n('LowerLeg'), foot = n('Foot');
      if (!upper || !lower || !foot) continue;
      const up = upper.getWorldPosition(V()), lo = lower.getWorldPosition(V()), ft = foot.getWorldPosition(V());
      // bend reference -Z (body frame: her back): with the knee pushed forward the shin deviates backward from the
      // thigh, so a forward-bent solve maps back to the untwisted rest (a +Z reference would twist the legs 180 degrees)
      const restFrame = (dir) => {
        const a = dir.clone().applyQuaternion(bodyInvAtRest).normalize();
        const c = new THREE.Vector3(0, 0, -1).addScaledVector(a, a.z).normalize();
        return basisQuat(a, c, a.clone().cross(c), Q()).invert();
      };
      this.legs[side] = {
        L1: up.distanceTo(lo), L2: lo.distanceTo(ft),
        restInvUpper: restFrame(lo.clone().sub(up)), restInvLower: restFrame(ft.clone().sub(lo)),
        upper, lower, foot, footRest: ft,
      };
    }
    this.legsDriven = false;
    this.hipsNode = this.nodes.hips;
    this.hipsRestLocal = this.hipsNode ? this.hipsNode.position.clone() : null;
    // fingers: [proximal, intermediate, distal] nodes per finger per side
    this.fingers = {};
    for (const side of ['left', 'right']) {
      this.fingers[side] = {};
      for (const [f, bones] of Object.entries(FINGERS)) this.fingers[side][f] = bones.map((b) => h.getNormalizedBoneNode(`${side}${b}`) || null);
    }
    this.handsDriven = { left: false, right: false };
    const lu = wp('leftUpperArm'), ru = wp('rightUpperArm');
    this.shoulderWidth = lu && ru ? lu.distanceTo(ru) : 0.3;
    this.shoulderY = lu && ru ? (lu.y + ru.y) / 2 : wp('head').y - 0.2;
    this.armLength = (this.arms.right || this.arms.left || { A: 0.5 }).A;
    this.headPos = wp('head');
    this.hipsPos = wp('hips');
    this.neckPos = wp('neck') || this.headPos.clone();
    const feet = Object.values(this.legs).map((l) => l.footRest.y);
    this.hipHeight = Math.max(0.2, this.hipsPos.y - (feet.length ? Math.min(...feet) : 0)); // unit of root pos
    for (const side of ['left', 'right']) {
      const arm = this.arms[side];
      if (!arm) continue;
      const hand = arm.hand.getWorldPosition(V());
      const mp = h.getNormalizedBoneNode(`${side}MiddleProximal`), md = h.getNormalizedBoneNode(`${side}MiddleDistal`);
      arm.palmLen = mp ? hand.distanceTo(mp.getWorldPosition(V())) : 0.18 * arm.A;
      arm.handLen = md ? hand.distanceTo(md.getWorldPosition(V())) + 0.025 : 0.36 * arm.A;
    }
    this.surf = this.nodes.head && this.nodes.hips ? measureSurfaces(vrm, this.nodes.head, this.chestNode, this.nodes.hips, (n) => this.frame(n)) : null;
    this.routes = new Map(); // transition-planner decisions per (side, target), kept while the request lives
    // T-31 C1 review R1: the panel contact -> gesture handover, per side. `w0` is the contact weight the leave began
    // at; the hand crosses over as the contact eases out (1 - w/w0). Present only while a gesture shares the hand.
    this.handover = new Map();
    // The wrist world point each arm was last solved to. The designed panel contact never moves the hand faster
    // than CONTACT_MAX_WRIST_SPEED, whatever the blend under it does (see solveArms): the spec's < 1.5 m/s rule with
    // a margin, measured between two frames.
    this.lastWrist = new Map();
    this.frameNo = 0;
    // T-31 seated base (coordinator brief, PREP ONLY -- nothing in the app sets this yet, no room/chair
    // wiring). When true: solveArms() falls back to REACH.seatedRest (hands on the thighs) instead of
    // REACH.rest whenever a side has no active reach request, and applyHands() defaults an idle hand to
    // a loose/soft shape instead of flat-open. Both are LOWEST priority: the instant any gesture reach or
    // hand-shape request exists for a side (any weight > 0), that request fully replaces this base -- see
    // the `total > 1e-4` branches in solveArms()/applyHands() below, unchanged by this flag.
    this.seated = false;
  }

  // Root channel: move the hips by `off` hip heights (screen-right, up, toward the viewer). Call before
  // the world matrices are updated for the frame.
  setRoot(off) {
    if (!this.hipsNode || !this.hipsRestLocal) return;
    const p = _v4.set(off[0], off[1], off[2]).multiplyScalar(this.hipHeight).add(this.hipsPos);
    this.hipsNode.position.copy(this.hipsNode.parent.worldToLocal(p));
  }

  // Leg IK (after world matrices are updated): feet stay on their rest spots and keep their rest
  // orientation; out of reach (hips raised) the legs straighten toward them, i.e. the feet lift.
  // Inactive -> legs go back to the rest pose once.
  solveLegs(active) {
    if (!active) {
      if (this.legsDriven) for (const l of Object.values(this.legs)) { l.upper.quaternion.identity(); l.lower.quaternion.identity(); l.foot.quaternion.identity(); }
      this.legsDriven = false;
      return;
    }
    this.legsDriven = true;
    const hx = V(), hy = V(), hz = V();
    this.axesOf(this.hipsNode, hx, hy, hz);
    const rootQ = this.root.getWorldQuaternion(Q());
    // airborne (hips above standing height): the feet rise half as much as the hips, so the knees tuck a little
    const lift = Math.max(0, this.hipsNode.getWorldPosition(V()).y - this.hipsPos.y) * 0.5;
    const target = V();
    for (const leg of Object.values(this.legs)) {
      this.solveArm(leg, target.copy(leg.footRest).setY(leg.footRest.y + lift), hz); // knees bend toward the hips' forward axis
      leg.upper.updateMatrixWorld(true);
      leg.foot.quaternion.copy(leg.lower.getWorldQuaternion(Q()).invert().multiply(rootQ));
    }
  }

  // Finger poses: weights per shape per side ({left: {point: 0.8}, right: {}}); the remainder is the rest
  // (flat) hand. Sides with no request go back to rest once -- or, seated, to a loose/soft default (hands
  // resting on the thighs read wrong perfectly flat-open) -- any real request still fully overrides this.
  applyHands(req) {
    for (const side of ['left', 'right']) {
      let shapes = req[side] || {};
      let total = 0;
      for (const k in shapes) total += shapes[k];
      if (total <= 1e-4 && this.seated) { shapes = { loose: 1 }; total = 1; }
      if (total <= 1e-4) {
        if (this.handsDriven[side]) for (const nodes of Object.values(this.fingers[side])) for (const n of nodes) if (n) n.quaternion.identity();
        this.handsDriven[side] = false;
        continue;
      }
      this.handsDriven[side] = true;
      const norm = total > 1 ? 1 / total : 1;
      const curl = {}; let thumbIn = 0;
      for (const f of Object.keys(FINGERS)) curl[f] = [0, 0, 0];
      for (const [shape, w] of Object.entries(shapes)) {
        const d = HAND_SHAPES[shape];
        if (!d || w <= 0) continue;
        for (const f of Object.keys(FINGERS)) for (let i = 0; i < 3; i++) curl[f][i] += d[f][i] * w * norm;
        thumbIn += d.thumbIn * w * norm;
      }
      // normalized hands: fingers run along +X (left) / -X (right) with the palm facing -Y, so curling
      // toward the palm is -Z on the left and +Z on the right; the thumb also folds across the palm (Y).
      const s = side === 'left' ? -1 : 1;
      for (const [f, nodes] of Object.entries(this.fingers[side])) {
        nodes.forEach((n, i) => {
          if (!n) return;
          if (f === 'thumb') n.rotation.set(0, i === 0 ? -s * thumbIn * DEG : 0, s * curl[f][i] * DEG);
          else n.rotation.set(0, 0, s * curl[f][i] * DEG);
        });
      }
    }
  }

  // --- frames ---
  // A bone's SEMANTIC world matrix: its world matrix with the model's base flip taken out of the rotation, so local
  // +Z is her front and +X her left on BOTH VRM versions. A VRM 0.x model's normalized bones carry a 180-degree flip
  // (see rootedBasis), so the raw node axes put every gesture target (chest, clasp, rest hand, guard) behind the
  // body and the surface measurements (face/chest/hip fronts) on its back (T-31 vrm0 gesture-forward). Same
  // convention as the IK solve: rest frames in the body frame, base flip re-appended on the way out. Identity
  // difference for VRM 1.0 (returns node.matrixWorld unchanged).
  frame(node, out = new THREE.Matrix4()) {
    out.copy(node.matrixWorld);
    if (this.restBaseInv) out.multiply(_m.makeRotationFromQuaternion(this.restBaseInv));
    return out;
  }

  axesOf(node, outX, outY, outZ) {
    node.getWorldQuaternion(_q3);
    if (this.restBaseInv) _q3.multiply(this.restBaseInv);
    outX.set(1, 0, 0).applyQuaternion(_q3);
    outY.set(0, 1, 0).applyQuaternion(_q3);
    outZ.set(0, 0, 1).applyQuaternion(_q3);
  }

  // Resolve a reach spec (preset name, {frame, pos} or {dir}) for one arm into a world WRIST target + world pole.
  // mirror < 0 flips screen-space directions (a mirrored gesture points the other way). `point` is the work loop's
  // world fingertip contact, used only by the 'point' kind; ignored by every other kind.
  resolve(side, target, offset, outPos, outPole, mirror = 1, point = null) {
    const arm = this.arms[side];
    const preset = typeof target === 'string' ? REACH[target] : null;
    const kind = preset ? preset.kind : target.dir ? 'dir' : target.frame;
    const cx = _v1, cy = _v2, cz = _v3;
    this.axesOf(this.chestNode, cx, cy, cz);
    const sg = arm.sign;
    const pole = (preset && preset.pole) || REACH.rest.pole;
    outPole.set(0, 0, 0).addScaledVector(cx, pole[0] * sg).addScaledVector(cy, pole[1]).addScaledVector(cz, pole[2]).normalize();
    const S = this.surf;
    if (kind === 'shoulder') {
      const pos = preset ? (side === 'left' && preset.leftPos ? preset.leftPos : preset.pos) : target.pos;
      arm.upper.getWorldPosition(outPos);
      outPos.addScaledVector(cx, pos[0] * sg * arm.A).addScaledVector(cy, pos[1] * arm.A).addScaledVector(cz, pos[2] * arm.A);
    } else if (kind === 'head' || (kind === 'face' && !S)) {
      // custom {frame:'head'} target (or no measurable head): head frame in shoulder widths
      const pos = preset ? [0.12, -0.62, 0.5] : target.pos, s = this.shoulderWidth;
      const hx = V(), hy = V(), hz = V();
      this.axesOf(this.nodes.head, hx, hy, hz);
      this.nodes.head.getWorldPosition(outPos);
      outPos.addScaledVector(hx, pos[0] * sg * s).addScaledVector(hy, pos[1] * s).addScaledVector(hz, pos[2] * s);
    } else if (kind === 'face') {
      const a = S.head[preset.at];
      outPos.set(a.x * sg, a.y, a.z).applyMatrix4(this.frame(this.nodes.head)); // contact point (follows the head)
      const col = S.collar;
      if (col) { // a nodding head would sink the contact into a high collar: keep it in front of the collar
        const inv = this.frame(this.chestNode).invert();
        const lc = outPos.clone().applyMatrix4(inv);
        if (lc.y > col.y0 - 0.02 && lc.y < col.y1 + 0.04 && lc.z < col.z + 0.02) outPos.copy(lc.setZ(col.z + 0.02).applyMatrix4(this.frame(this.chestNode)));
      }
      const d = preset.handDir, hd = V().addScaledVector(cx, d[0] * sg).addScaledVector(cy, d[1]).addScaledVector(cz, d[2]).normalize();
      outPos.addScaledVector(hd, -arm.palmLen);
    } else if (kind === 'beside') {
      const dr = preset.drop * DEG, ah = preset.ahead * DEG, tl = preset.tilt * DEG, sp = preset.splay * DEG;
      const sh = arm.upper.getWorldPosition(V());
      const elbow = sh.clone().addScaledVector(cx, sg * arm.L1 * Math.cos(dr) * Math.cos(ah)).addScaledVector(cy, -arm.L1 * Math.sin(dr)).addScaledVector(cz, arm.L1 * Math.cos(dr) * Math.sin(ah));
      outPos.copy(elbow).addScaledVector(cy, arm.L2 * Math.cos(tl) * Math.cos(sp)).addScaledVector(cz, arm.L2 * Math.sin(tl)).addScaledVector(cx, sg * arm.L2 * Math.sin(sp));
      if (S) {
        const lat = V().subVectors(outPos, this.nodes.head.getWorldPosition(V())).dot(cx) * sg, need = S.head.halfW + preset.clear;
        if (lat < need) { outPos.addScaledVector(cx, (need - lat) * sg); elbow.addScaledVector(cx, (need - lat) * sg); }
      }
      outPole.copy(elbow).sub(sh.add(outPos).multiplyScalar(0.5)).normalize(); // elbow goes where the pose put it
    } else if (kind === 'chest') {
      if (S && S.chest) {
        outPos.set(S.chest.x * sg, S.chest.y, S.chest.z).applyMatrix4(this.frame(this.chestNode));
        const d = preset.handDir, hd = V().addScaledVector(cx, d[0] * sg).addScaledVector(cy, d[1]).addScaledVector(cz, d[2]).normalize();
        outPos.addScaledVector(hd, -0.6 * arm.palmLen);
      } else {
        arm.upper.getWorldPosition(outPos);
        outPos.addScaledVector(cx, -0.16 * sg * arm.A).addScaledVector(cy, -0.34 * arm.A).addScaledVector(cz, 0.45 * arm.A);
      }
    } else if (kind === 'hip') {
      if (S && S.hip) {
        outPos.set(S.hip.x * sg, S.hip.y, S.hip.z).applyMatrix4(this.frame(this.nodes.hips));
        const d = preset.handDir, hd = V().addScaledVector(cx, d[0] * sg).addScaledVector(cy, d[1]).addScaledVector(cz, d[2]).normalize();
        outPos.addScaledVector(hd, -0.7 * arm.palmLen);
      } else {
        arm.upper.getWorldPosition(outPos);
        outPos.addScaledVector(cx, 0.26 * sg * arm.A).addScaledVector(cy, -0.64 * arm.A).addScaledVector(cz, -0.04 * arm.A);
      }
    } else if (kind === 'point') {
      // Designed fingertip contact (C1 step 9): the wrist goes one hand-length back along the shoulder->contact
      // approach; solveContact() then refines it from the REAL fingertip so the hand tip lands on the point.
      arm.upper.getWorldPosition(outPos);
      const S = outPos.clone();
      // NB: the approach direction is measured from the SHOULDER (S), not from outPos after it is overwritten.
      const C = point ? V().set(point.x, point.y, point.z) : null;
      if (C) outPos.copy(C).addScaledVector(V().subVectors(C, S).normalize(), -arm.handLen);
      else outPos.addScaledVector(cz, 0.45 * arm.A).addScaledVector(cy, -0.2 * arm.A); // point-less call: a low forward rest
    } else { // dir: [screen-right, up, toward viewer]; crossing the body adds forward so the arm clears the chest
      const d = preset ? preset.dir : target.dir;
      const x = d[0] * mirror, cross = Math.max(0, -x * sg);
      const u = V().addScaledVector(cx, x).addScaledVector(cy, d[1]).addScaledVector(cz, d[2] + 0.8 * cross).normalize();
      arm.upper.getWorldPosition(outPos).addScaledVector(u, 0.97 * arm.A);
    }
    if (offset) {
      // a raised hand beside the head swings mostly outward: the inward half of a wave swing is damped so it never
      // drifts to the ear (a symmetric swing read as 'hand to ear / phone')
      const out = kind === 'beside' && offset[0] < 0 ? offset[0] * 0.25 : offset[0];
      outPos.addScaledVector(cx, out * sg * arm.A).addScaledVector(cy, offset[1] * arm.A).addScaledVector(cz, offset[2] * arm.A);
    }
  }

  // The REAL fingertip (the middle-distal joint plus the same 0.025 m the bind-time handLen adds).
  fingertip(arm, side, out = V()) {
    arm.upper.updateMatrixWorld(true);
    const distal = this.fingers[side] && this.fingers[side].middle && this.fingers[side].middle[2];
    const hw = arm.hand.getWorldPosition(V());
    if (!distal) return out.copy(hw).addScaledVector(V().subVectors(hw, arm.lower.getWorldPosition(V())).normalize(), arm.handLen);
    const mw = distal.getWorldPosition(V());
    const dir = V().subVectors(mw, hw);
    return dir.lengthSq() < 1e-8 ? out.copy(mw) : out.copy(mw).addScaledVector(dir.normalize(), 0.025);
  }

  // Land the FINGERTIP on a world point (C1 step 9): the IK targets the wrist, and the hand continues along the
  // forearm, so iterate the wrist target by the measured tip error. Converges in a few frames of sub-mm steps; the
  // designed panel contact is the only caller, so a normal gesture never pays for it.
  // Damped (review R1): the tip moves ~1.5x the wrist step in a folded arm, so the plain 0.8 gain could overshoot
  // and run away when the BODY moved under a fixed contact point (a gesture fired mid-touch rotated the shoulder and
  // the solve ended 15 cm off, then jumped back). Steps are capped at 2 cm, a step that grows the error ends the
  // loop, and the best wrist target found is the one finally solved -- so a hard frame cannot snap the arm.
  solveFingertip(arm, side, tgt, pole, point) {
    const C = V().set(point.x, point.y, point.z), tip = V(), best = tgt.clone();
    let bestErr = Infinity;
    for (let i = 0; i < 12; i++) {
      this.solveArm(arm, tgt, pole); // solve FIRST: the entry pose may be the rest pose, not the last request's
      this.fingertip(arm, side, tip);
      const ex = C.x - tip.x, ey = C.y - tip.y, ez = C.z - tip.z;
      const e2 = ex * ex + ey * ey + ez * ez;
      if (e2 <= 4e-6) return; // <= 2 mm (the contact tolerance is 1 cm)
      if (e2 >= bestErr) break; // overshoot: this geometry turned the tip the wrong way -- keep the best target
      bestErr = e2; best.copy(tgt);
      const g = Math.min(0.8, 0.02 / Math.sqrt(e2)); // one step moves the wrist at most 2 cm
      tgt.x += ex * g; tgt.y += ey * g; tgt.z += ez * g;
    }
    tgt.copy(best);
    this.solveArm(arm, tgt, pole);
  }

  // The designed panel contact through its envelope: the FINGERTIP goes straight from its rest point to the contact
  // point as the request weight rises, and the wrist is solved to put it there. A tip-space blend (instead of the
  // wrist arc alone) is what keeps the hand on HER side of the glass for the whole approach -- the shoulder arc
  // otherwise lifts the hand over the panel and back down through it before the contact frame.
  solveContact(arm, side, base, basePole, tgt, pole, point, k) {
    const end = tgt.clone(), endPole = pole.clone();
    this.solveArm(arm, base, basePole);
    const tip0 = this.fingertip(arm, side, V());
    const want = V().lerpVectors(tip0, V().set(point.x, point.y, point.z), Math.min(1, Math.max(0, k)));
    tgt.copy(end); pole.copy(endPole);
    this.solveFingertip(arm, side, tgt, pole, want);
  }

  // Transition planner. Every request moves the wrist from the rest target toward its own target along an arc around
  // the shoulder (direction nlerp + reach-length lerp, so the hand never cuts straight through the body). If that arc
  // would pass the head/face zone or through the torso, the move is routed through a side waypoint: the arm first
  // swings OUT to the side (~80 deg abduction), then the elbow flexes into the target; going back it retraces the same
  // route, so a raised hand also comes down along the side. Several requests blend by their weight shares.
  // swing (optional, from the engine): {up, fwd} offset in arm lengths for secondary arm motion (jump).
  // dt (optional, s): needed only for the contact's wrist-speed rail below.
  solveArms(reqs, swing = null, dt = 0) {
    this.frameNo++;
    for (const side of ['left', 'right']) {
      const arm = this.arms[side];
      if (!arm) continue;
      const S = arm.upper.getWorldPosition(V());
      const base = V(), basePole = V();
      this.resolve(side, this.seated ? 'seatedRest' : 'rest', null, base, basePole);
      let total = 0, contactW = 0;
      for (const r of reqs) if (r.hand === side && r.weight > 0) total += r.weight;
      // The designed panel contact (a request that carries a world point) among this hand's requests, if any -- and
      // every OTHER request on that hand (a real catalog gesture that reached while she touches the glass).
      const mine = reqs.filter((r) => r.hand === side && r.weight > 0);
      const hit = mine.find((r) => r.point) || null;
      const shared = Boolean(hit) && mine.length > 1; // a gesture reaches with the contact's hand
      let otherW = 0;
      for (const r of mine) if (r !== hit) otherW += r.weight;
      // Review R1 handover: a gesture that reaches with the contact's hand must take the arm over FROM the wrist that
      // is on the glass, and the takeover is paced by the CONTACT's own leave envelope, not by the gesture's enter.
      // A fast enter (poke 'startle' pulls both hands back in 110 ms) would otherwise sweep the wrist 16 m/s off the
      // glass. So: solve the contact ALONE at its own weight (exactly the pose it has when nothing shares the hand),
      // take that wrist as the origin, and let the hand cross over only as far as the contact has already eased out
      // (1 - w/w0, w0 = the weight the leave started from). Every other request is routed from that same origin, so
      // at the interrupt frame the arm is still exactly on the glass and the last frame lands it on the gesture.
      let from = base, fromPole = basePole, handover = 0;
      if (shared) {
        const hs = this.handover.get(side);
        if (!hs) this.handover.set(side, { w0: hit.weight });
        const w0 = Math.max(1e-6, this.handover.get(side).w0);
        handover = Math.min(1, Math.max(0, 1 - hit.weight / w0));
        const p = V(), pp = V();
        this.resolve(side, hit.target, hit.offset, p, pp, hit.mirror || 1, hit.point);
        const [ht, hp] = this.route(side, arm, S, base, basePole, hit, p, pp, Math.min(1, hit.weight));
        this.solveContact(arm, side, base, basePole, ht, hp, hit.point, hit.weight);
        from = arm.hand.getWorldPosition(V());
        fromPole = hp;
      } else {
        this.handover.delete(side);
      }
      const tgt = base.clone(), pole = basePole.clone();
      if (total > 1e-4) {
        tgt.set(0, 0, 0); pole.set(0, 0, 0);
        const p = V(), pp = V();
        for (const r of mine) {
          if (r === hit && shared) continue; // the contact's own share is added below, from the solved wrist
          const k = Math.min(1, r.weight);
          // A gesture's share of the arm is its own weight, but while the contact hands over it may only take the
          // part of the hand the contact has already given up (share * handover), so the two envelopes line up.
          const share = shared ? (otherW > 1e-9 ? (r.weight / otherW) * handover : 0) : r.weight / total;
          this.resolve(side, r.target, r.offset, p, pp, r.mirror || 1, r.point);
          if (typeof r.target === 'string' && REACH[r.target] && REACH[r.target].kind === 'face') contactW += share;
          const [rp, rpole] = this.route(side, arm, S, from, fromPole, r, p, pp, k);
          tgt.addScaledVector(rp, share);
          pole.addScaledVector(rpole, share);
        }
        if (shared) { // the contact keeps whatever the handover has not given away yet
          tgt.addScaledVector(from, 1 - handover);
          pole.addScaledVector(fromPole, 1 - handover);
        }
      }
      for (const [key, v] of this.routes) if (v.seen < this.frameNo - 1) this.routes.delete(key);
      const cx = V(), cy = V(), cz = V();
      this.axesOf(this.chestNode, cx, cy, cz);
      if (swing) tgt.addScaledVector(cy, swing.up * arm.A).addScaledVector(cz, swing.fwd * arm.A);
      // elbow clamp: the elbow may point out, down, back, a little forward, never into the torso or far forward/up
      let po = pole.dot(cx) * arm.sign, pu = pole.dot(cy), pf = pole.dot(cz);
      po = Math.max(po, -0.2); pf = Math.min(pf, 0.6); pu = Math.min(pu, 0.5);
      pole.set(0, 0, 0).addScaledVector(cx, po * arm.sign).addScaledVector(cy, pu).addScaledVector(cz, pf).normalize();
      // The contact's wrist rail (see CONTACT_MAX_WRIST_SPEED): with a contact on this hand the solved wrist may
      // approach its target at no more than the rail's speed, so a gesture that shares the hand is taken over at a
      // pace the eye reads as a handover. No contact -> no rail -> a normal gesture keeps its own envelope.
      if (hit && dt > 0) {
        const prev = this.lastWrist.get(side);
        if (prev) {
          const d = tgt.distanceTo(prev), max = CONTACT_MAX_WRIST_SPEED * dt;
          if (d > max) tgt.sub(prev).multiplyScalar(max / d).add(prev);
        }
      }
      this.solveArm(arm, tgt, pole);
      // The designed panel contact rides its own tip-space envelope (see solveContact). When it is the only request
      // on its hand the weight IS the share, so that one pose is the whole arm; when a gesture shares the hand the
      // handover above already blended it in (from = its solved wrist).
      if (hit && from === base) this.solveContact(arm, side, base, basePole, tgt, pole, hit.point, hit.weight);
      if (this.surf) this.guardHead(arm, tgt, pole, contactW > 0.5 ? arm.palmLen : arm.handLen, contactW > 0.5 ? 0 : 0.06);
      if (this.seated) this.restHand(arm, 1 - Math.min(1, total));
      this.lastWrist.set(side, arm.hand.getWorldPosition(V()));
    }
  }

  // Seated rest (T-31): the palm lies on the thigh -- fingers along the hips' forward axis (REACH.seatedRest.handDir,
  // [out, up, fwd]), back of the hand up -- instead of continuing the forearm line down into the thigh. Weighted by
  // how much of this arm is at rest (1 - its gesture weight), from the untouched (identity) hand a gesture expects.
  restHand(arm, w) {
    const hx = V(), hy = V(), hz = V();
    this.axesOf(this.nodes.hips, hx, hy, hz);
    const d = REACH.seatedRest.handDir;
    const fd = V().addScaledVector(hx, d[0] * arm.sign).addScaledVector(hy, d[1]).addScaledVector(hz, d[2]).normalize();
    const x = arm.sign > 0 ? fd.clone() : fd.clone().negate(); // normalized hands: fingers +X (left) / -X (right), back of the hand +Y
    const y = hy.clone().addScaledVector(fd, -hy.dot(fd)).normalize();
    // basis is a BODY-frame orientation; right-append the model's base flip (identity for VRM 1.0) so it is a world
    // one again, exactly as rootedBasis does for the IK bones. Without it a VRM 0.x hand is folded ~153 deg at the wrist.
    const qW = basisQuat(x, y, V().crossVectors(x, y), Q()).multiply(this.restBase);
    const qL = arm.hand.parent.getWorldQuaternion(Q()).invert().multiply(qW);
    arm.hand.quaternion.identity().slerp(qL, w);
  }

  // wrist point on the arc S->a->b at t (direction nlerp + length lerp around the shoulder S)
  arcPoint(S, a, b, t, out = V()) {
    const da = V().subVectors(a, S), db = V().subVectors(b, S), la = da.length() || 1e-6, lb = db.length() || 1e-6;
    const d = da.divideScalar(la).multiplyScalar(1 - t).addScaledVector(db.divideScalar(lb), t);
    if (d.lengthSq() < 1e-6) return out.lerpVectors(a, b, t);
    return out.copy(S).addScaledVector(d.normalize(), la + (lb - la) * t);
  }

  // Does the move from a (rest side) to b need the side waypoint? Yes when the hand is raised above the shoulder to a
  // place that is not on the face/front (a wave, overhead, point-up), or when the plain arc would pass through the
  // head/face zone or the zone in front of the torso on its way somewhere else, or through the torso itself.
  crossesBody(S, a, b) {
    const sf = this.surf;
    if (!sf) return false;
    const hInv = this.frame(this.nodes.head).invert();
    const cInv = this.frame(this.chestNode).invert();
    const { ellC: c, ellR: r } = sf.head, bx = sf.chestBox;
    const inHead = (q) => { const h = q.clone().applyMatrix4(hInv); return Math.hypot((h.x - c.x) / (r.x + 0.09), (h.y - c.y) / (r.y + 0.09), (h.z - c.z) / (r.z + 0.09)) < 1; };
    const local = (q) => q.clone().applyMatrix4(cInv);
    const inFront = (q) => { if (!bx) return false; const l = local(q); return l.x > bx.min.x - 0.03 && l.x < bx.max.x + 0.03 && l.y > bx.min.y - 0.25 && l.y < bx.max.y + 0.1 && l.z > bx.max.z - 0.04 && l.z < bx.max.z + 0.28; };
    const inTorso = (q) => { if (!bx) return false; const l = local(q); return l.x > bx.min.x && l.x < bx.max.x && l.y > bx.min.y && l.y < bx.max.y && l.z > bx.min.z && l.z < bx.max.z - 0.01; };
    const endInside = inHead(b) || inFront(b);
    if (!endInside && b.y > S.y + 0.05 && a.y < S.y) return true; // raise above the shoulder: abduct first
    const q = V();
    for (const t of [0.2, 0.35, 0.5, 0.65, 0.8]) {
      this.arcPoint(S, a, b, t, q);
      if (q.distanceTo(b) < 0.1 || q.distanceTo(a) < 0.1) continue;
      if (inTorso(q) || (!endInside && (inHead(q) || inFront(q)))) return true;
    }
    return false;
  }

  // Routed point + pole for one request at progress k (0 = rest, 1 = target). The waypoint decision is made once per
  // request lifetime (so a moving body cannot flip it mid-move).
  route(side, arm, S, base, basePole, r, p, pp, k) {
    const key = `${side}|${typeof r.target === 'string' ? r.target : JSON.stringify(r.target)}`;
    let rt = this.routes.get(key);
    if (!rt) { rt = { via: this.crossesBody(S, base, p) }; this.routes.set(key, rt); }
    rt.seen = this.frameNo;
    if (!rt.via) return [this.arcPoint(S, base, p, k), V().lerpVectors(basePole, pp, k).normalize()];
    const cx = V(), cy = V(), cz = V();
    this.axesOf(this.chestNode, cx, cy, cz);
    const sg = arm.sign, KW = 0.45;
    const W = S.clone().addScaledVector(V().addScaledVector(cx, sg * 0.96).addScaledVector(cy, -0.25).addScaledVector(cz, 0.06).normalize(), 0.95 * arm.A);
    const Wp = V().addScaledVector(cx, 0.2 * sg).addScaledVector(cy, -1).addScaledVector(cz, -0.35).normalize();
    if (k < KW) { const t = k / KW; return [this.arcPoint(S, base, W, t), V().lerpVectors(basePole, Wp, t).normalize()]; }
    const t = (k - KW) / (1 - KW);
    return [this.arcPoint(S, W, p, t), V().lerpVectors(Wp, pp, t).normalize()];
  }

  // Forearm/hand vs the measured head ellipsoid (ear parts included): if any sample from the elbow to the hand
  // tip is inside, push the wrist target out of the head (horizontally, in head space) and re-solve.
  guardHead(arm, tgt, pole, tipLen, margin = 0) {
    const { ellC: c } = this.surf.head, r = this.surf.head.ellR.clone().addScalar(margin);
    const inv = this.frame(this.nodes.head).invert();
    const e = V(), w = V(), q = V(), worst = V();
    for (let it = 0; it < 3; it++) {
      arm.upper.updateMatrixWorld(true);
      arm.lower.getWorldPosition(e); arm.hand.getWorldPosition(w);
      const tip = w.clone().addScaledVector(q.subVectors(w, e).normalize(), tipLen);
      let minF = Infinity;
      for (let i = 0; i <= 8; i++) {
        const pt = i <= 5 ? q.lerpVectors(e, w, i / 5) : q.lerpVectors(w, tip, (i - 5) / 3);
        const l = pt.clone().applyMatrix4(inv);
        const f = Math.hypot((l.x - c.x) / r.x, (l.y - c.y) / r.y, (l.z - c.z) / r.z);
        if (f < minF) { minF = f; worst.copy(l); }
      }
      if (minF >= 1) return;
      const out = V().set(worst.x - c.x, 0, worst.z - c.z);
      if (out.lengthSq() < 1e-8) out.set(arm.sign, 0, 0.3);
      out.transformDirection(this.frame(this.nodes.head)).multiplyScalar((1 - minF) * Math.min(r.x, r.z) + 0.015);
      tgt.add(out);
      this.solveArm(arm, tgt, pole);
    }
  }

  solveArm(arm, target, pole) {
    const S = arm.upper.getWorldPosition(_v4);
    const d = _v1.subVectors(target, S);
    let dist = d.length();
    const { L1, L2 } = arm;
    dist = Math.min(Math.max(dist, Math.abs(L1 - L2) + 1e-4), (L1 + L2) * 0.999);
    const u = d.normalize();
    const cosA = (L1 * L1 + dist * dist - L2 * L2) / (2 * L1 * dist);
    const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
    // bend plane from the pole; when the pole runs almost along the arm, fade to a fixed down/back reference so the
    // upper-arm twist cannot flip from one frame to the next (the 'dark sleeve blob')
    const v = _v2.copy(pole).addScaledVector(u, -pole.dot(u));
    const vl = v.length();
    if (vl < 0.4) {
      const ref = V().set(0, -1, -0.6).normalize();
      if (Math.abs(ref.dot(u)) > 0.9) ref.set(0, 0, -1);
      ref.addScaledVector(u, -ref.dot(u)).normalize();
      v.normalize().multiplyScalar(vl / 0.4).addScaledVector(ref, 1 - vl / 0.4);
    }
    v.normalize();
    const elbow = _v3.copy(S).addScaledVector(u, L1 * cosA).addScaledVector(v, L1 * sinA);
    const wrist = V().copy(S).addScaledVector(u, dist);
    const a1 = V().subVectors(elbow, S).normalize();
    const a2 = V().subVectors(wrist, elbow).normalize();
    const c1 = V().copy(a2).addScaledVector(a1, -a2.dot(a1));
    if (c1.lengthSq() < 1e-8) c1.copy(v).negate().addScaledVector(a1, v.dot(a1));
    c1.normalize();
    const n1 = V().crossVectors(a1, c1);
    const c2 = V().crossVectors(n1, a2);
    // Solve in the BODY frame (see rootedBasis): the rest frames live there, so the bend reference is anatomical on
    // both versions. The solved delta right-appends the model's base flip (identity for VRM 1.0), then we rotate it
    // into the parent's local space by the bind-time body orientation -- which cancels the stage rotation for free.
    const bodyQ = this.restBody, bodyInv = this.restBodyInv, base = this.restBase;
    const qUpperB = rootedBasis(a1, c1, n1, arm.restInvUpper, bodyInv, base, _q3);
    const qLowerB = rootedBasis(a2, c2, n1, arm.restInvLower, bodyInv, base, Q());
    arm.upper.parent.getWorldQuaternion(_q2);
    arm.upper.quaternion.copy(_q2.invert().multiply(bodyQ).multiply(qUpperB));
    arm.lower.quaternion.copy(qUpperB.clone().invert().multiply(qLowerB));
  }

  // Screen-space regions (client px) for poke/pat hit tests.
  hitRegions(camera, rect) {
    const proj = (p) => {
      const v = p.clone().project(camera);
      return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height };
    };
    const s = this.shoulderWidth;
    const hx = V(), hy = V(), hz = V();
    this.axesOf(this.nodes.head, hx, hy, hz);
    const headC = this.nodes.head.getWorldPosition(V()).addScaledVector(hy, 0.5 * s);
    const c = proj(headC);
    const edge = proj(headC.clone().addScaledVector(hx, 0.62 * s));
    const r = Math.hypot(edge.x - c.x, edge.y - c.y);
    const pts = ['leftUpperArm', 'rightUpperArm', 'hips'].filter((n) => this.nodes[n]).map((n) => proj(this.nodes[n].getWorldPosition(V())));
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    const w = Math.max(...xs) - Math.min(...xs);
    return {
      head: { x: c.x, y: c.y, r },
      body: { x0: Math.min(...xs) - 0.15 * w, x1: Math.max(...xs) + 0.15 * w, y0: Math.min(...ys), y1: Math.max(...ys) + 0.5 * (Math.max(...ys) - Math.min(...ys)) },
    };
  }
}
