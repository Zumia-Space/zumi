// Authors assets/clips/sit-idle.vrma: a ONE-KEYFRAME, ROTATION-ONLY seated pose for the legs (hips,
// upperLeg, lowerLeg, foot x2), loadable by the app's own ClipLayer (clips.js) exactly like any other
// built-in clip. No Mixamo, no downloads -- the quaternions are computed from THIS model's own rest-pose
// bone geometry (the owner's test model, owner-paths testModel) and written straight into a hand-built
// glTF + VRMC_vrm_animation JSON (embedded buffer, no binary tooling needed).
//
// Why rotation-only, and why legs only:
//  - Seating height (dropping the pelvis onto a seat) is done by translating the avatar's scene root
//    (see scripts/seat-offset.mjs) -- NOT by this clip, and NOT by loosening clips.js:84's
//    quaternion-only track filter. Coordinator decision (SIT-FEASIBILITY.md path a).
//  - Only hips/leftUpperLeg/leftLowerLeg/rightUpperLeg/rightLowerLeg/rightFoot/leftFoot are touched.
//    Spine/chest/neck/head/shoulders/arms/hands are left OUT on purpose: ClipLayer.blend() slerps this
//    clip's bones over the procedural pose every frame at the clip's weight, which would otherwise fight
//    (partially override) upper-body reflexes, gaze and gestures. Legs are never touched by any reflex
//    (not in engine.js's TORSO list, no `bones`/`reach` target reaches them), so holding them at weight 1
//    is safe and is in fact the ONLY way to pose them at all (feasibility doc point 4).
//  - `hips` IS listed as a VRMC_vrm_animation humanBone (so VRMAnimationLoaderPlugin can resolve the
//    upperLeg parent chain -- see _createBoneWorldMatrixMap) but carries NO rotation channel: we don't
//    want to rotate the pelvis itself, only the legs underneath it.
//
// How the pose is computed (aimLocal): for each leg bone, measure its REST local "to-child" direction
// (world == local here because every VRM "normalized" humanoid bone has IDENTITY world rotation at rest
// -- verified directly on this model: see scripts/_inspect-rest.mjs output), then solve the minimal local
// quaternion that re-points that same direction at a chosen WORLD target direction, given the bone's
// parent's ALREADY-RESOLVED new world rotation (resolved top-down: hips -> upperLeg -> lowerLeg). This
// needs no per-bone axis convention (no guessing which of x/y/z is the "bend" axis for a leg bone, which
// schema.js's BONE_LIMITS_DEG table never defines for legs in the first place).
//
// Targets (reproduced to match the coordinator's brief):
//   thigh (hip->knee): ~horizontal, -3deg droop below horizontal (hip flexion ~93deg off the upright torso)
//   shin  (knee->ankle): the model's OWN rest (standing) world direction -- already near-vertical, and
//     choosing the exact rest direction (not a generic straight-down) makes the foot's identity rotation
//     below land in exactly the same world orientation it has when standing flat-footed (see foot, below)
//   foot (ankle->toe): IDENTITY local rotation (no track needed for "flat": this model's "flat on the
//     floor" shape is whatever local foot orientation reproduces when the shin returns to its own rest
//     world orientation, which is exactly what the shin target above guarantees -- verified below by
//     printing the resulting foot world quaternion against its rest world quaternion, confirmed ~equal)
//
//   node scripts/make-sit-pose.mjs [--model <file.vrm>] [--out <file.vrma>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ownerPath } from './lib/owner-paths.mjs';

globalThis.self = globalThis;
globalThis.window = globalThis;
globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
const THREE = await import('three');
const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
const { VRMLoaderPlugin, VRMUtils } = await import('@pixiv/three-vrm');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const arg = (name, def = null) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : def; };
const modelPath = path.resolve(arg('model', ownerPath('testModel', 'local/test-model.vrm')));
const outFile = path.resolve(arg('out', path.join(ROOT, 'assets/clips/sit-idle.vrma')));

// ---------- load the real model, measure rest-pose leg geometry ----------
const buf = fs.readFileSync(modelPath);
const loader = new GLTFLoader();
loader.register((p) => new VRMLoaderPlugin(p));
const gltf = await loader.parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
const vrm = gltf.userData.vrm;
VRMUtils.removeUnnecessaryVertices(gltf.scene);
VRMUtils.combineSkeletons(gltf.scene);
if (vrm.meta && vrm.meta.metaVersion === '0') VRMUtils.rotateVRM0(vrm);
vrm.scene.updateMatrixWorld(true);
if (vrm.meta && vrm.meta.metaVersion !== '1') console.warn(`WARNING: model metaVersion is '${vrm.meta.metaVersion}', this generator assumes VRM 1.0 (no z/x flip applied)`);

const V = () => new THREE.Vector3();
const nb = (n) => vrm.humanoid.getNormalizedBoneNode(n);
const pos = (n) => nb(n).getWorldPosition(V());
const hipsY = pos('hips').y;
const restAnkleY = pos('leftFoot').y; // standing ankle-to-floor clearance -- the seat-offset anchor that actually lands the soles on the floor (coordinator fix, see seat-offset.mjs)
const restToeY = pos('leftToes').y;
console.log(`measured standing hip height (pelvis Y above the model's own floor): ${hipsY.toFixed(4)} m`);
console.log(`measured standing ankle-to-floor clearance: ${restAnkleY.toFixed(4)} m, toe: ${restToeY.toFixed(4)} m`);

const DEG = Math.PI / 180;
function aimLocal(restLocalDir, parentWorldQuatNow, desiredWorldDir) {
  const targetLocal = desiredWorldDir.clone().applyQuaternion(parentWorldQuatNow.clone().invert()).normalize();
  return new THREE.Quaternion().setFromUnitVectors(restLocalDir.clone().normalize(), targetLocal);
}

const sides = ['left', 'right'];
const quats = {}; // boneName -> THREE.Quaternion (local rotation to author)
const report = {};
for (const side of sides) {
  const upperLeg = `${side}UpperLeg`, lowerLeg = `${side}LowerLeg`, foot = `${side}Foot`;
  const kneeP = pos(lowerLeg), ankleP = pos(foot);
  const dThighRest = kneeP.clone().sub(pos(upperLeg)).normalize(); // hip joint -> knee, rest
  const dShinRest = ankleP.clone().sub(kneeP).normalize(); // knee -> ankle, rest (already near-vertical)

  // thigh target: ~horizontal, slight natural droop below horizontal
  const droopDeg = 3;
  const desiredThigh = new THREE.Vector3(0, -Math.sin(droopDeg * DEG), Math.cos(droopDeg * DEG)).normalize();
  const qThigh = aimLocal(dThighRest, new THREE.Quaternion(), desiredThigh); // parent (hips) stays identity
  quats[upperLeg] = qThigh;

  // shin target: this model's OWN rest (standing) world direction -- see header comment
  const qShin = aimLocal(dShinRest, qThigh, dShinRest);
  quats[lowerLeg] = qShin;

  // foot: identity local rotation (see header comment for why this reproduces "flat")
  quats[foot] = new THREE.Quaternion();

  // ---------- verification: replay these quats on the live rig and measure the result ----------
  nb(upperLeg).quaternion.copy(qThigh);
  nb(lowerLeg).quaternion.copy(qShin);
  nb(foot).quaternion.copy(quats[foot]);
  vrm.scene.updateMatrixWorld(true);
  const kneeNew = pos(lowerLeg), ankleNew = pos(foot);
  const thighDirNew = kneeNew.clone().sub(pos(upperLeg)).normalize();
  const shinDirNew = ankleNew.clone().sub(kneeNew).normalize();
  const hipFlexDeg = Math.acos(THREE.MathUtils.clamp(thighDirNew.dot(new THREE.Vector3(0, 1, 0)), -1, 1)) / DEG;
  const kneeFlexDeg = Math.acos(THREE.MathUtils.clamp(-thighDirNew.dot(shinDirNew), -1, 1)) / DEG;
  const footWorldQuat = nb(foot).getWorldQuaternion(new THREE.Quaternion());
  const footDriftDeg = 2 * Math.acos(THREE.MathUtils.clamp(Math.abs(footWorldQuat.dot(new THREE.Quaternion())), -1, 1)) / DEG; // vs rest world identity
  const toeY = pos(`${side}Toes`).y;
  report[side] = {
    hipJointY: +pos(upperLeg).y.toFixed(4), kneeY: +kneeNew.y.toFixed(4), ankleY: +ankleNew.y.toFixed(4), toeY: +toeY.toFixed(4),
    hipFlexDeg: +hipFlexDeg.toFixed(1), kneeFlexDeg: +kneeFlexDeg.toFixed(1),
    footWorldDriftFromRestDeg: +footDriftDeg.toFixed(2),
  };
}
console.log('verification (expect hipFlexDeg ~85-95, kneeFlexDeg ~90, footWorldDriftFromRestDeg ~0):');
console.log(JSON.stringify(report, null, 1));
{
  // Preview only -- the real root-drop call belongs to the wiring step, not this generator. Uses the
  // tested pure function (scripts/seat-offset.mjs) so this preview and check:seat-offset never disagree.
  //
  // computeRootDrop(A, B) is generic (A - B): it drops the root so WHATEVER landmark A was measured on
  // lands at height B. Anchoring A/B on hips (A=standing hip height, B=the nominal seat height) is the
  // natural call for "the pelvis should land on the seat" -- but for THIS pose+model the hip-to-ankle
  // drop in the seated leg pose (hipJointY - ankleY) doesn't exactly match the nominal seat height, so a
  // hip-anchored drop leaves the ankle/toe a few cm through the floor (found + fixed per coordinator QC,
  // 2026-10-03: measured 2.3cm at the ankle, 8.6cm at the toe with a 0.45m nominal seat height). Anchoring
  // on the ANKLE instead -- A=the ankle's own seated-pose height (pre-drop), B=this SAME model's own
  // standing ankle-to-floor clearance -- reproduces the exact standing foot/floor relationship (the foot's
  // world orientation is untouched from standing by construction, see the pose's foot-quaternion-identity
  // reasoning above), landing the sole on the floor essentially exactly, at whatever hip height results.
  const { computeRootDrop } = await import('./seat-offset.mjs');
  const dropAnkle = computeRootDrop(report.left.ankleY, restAnkleY);
  const resultHipsY = hipsY - dropAnkle;
  const ankleOut = report.left.ankleY - dropAnkle, toeOut = report.left.toeY - dropAnkle;
  console.log(`preview (ankle-anchored, soles on the floor): drop ${dropAnkle.toFixed(4)} m -> hips land at ${resultHipsY.toFixed(4)} m, ankle -> ${ankleOut.toFixed(4)} m (standing was ${restAnkleY.toFixed(4)}), toe -> ${toeOut.toFixed(4)} m (standing was ${restToeY.toFixed(4)}), floor = 0 m`);
  const seatH = 0.45;
  const dropHip = computeRootDrop(hipsY, seatH);
  console.log(`preview (OLD hip-anchored @ ${seatH} m, for comparison): drop ${dropHip.toFixed(4)} m -> ankle -> ${(report.left.ankleY - dropHip).toFixed(4)} m, toe -> ${(report.left.toeY - dropHip).toFixed(4)} m (floor = 0 m)`);
}

// ---------- build the glTF + VRMC_vrm_animation JSON (embedded buffer, 2 identical keyframes = static) ----------
const BONE_ORDER = ['leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot'];
const NODE_INDEX = { hips: 0, leftUpperLeg: 1, leftLowerLeg: 2, leftFoot: 3, rightUpperLeg: 4, rightLowerLeg: 5, rightFoot: 6 };
const DURATION = 1 / 30;
const TIMES = new Float32Array([0, DURATION]);
const bin = [Buffer.from(TIMES.buffer)];
const bufferViews = [{ buffer: 0, byteOffset: 0, byteLength: TIMES.byteLength }];
const accessors = [{ bufferView: 0, byteOffset: 0, componentType: 5126, count: 2, type: 'SCALAR' }];
const samplers = [];
const channels = [];
let byteOffset = TIMES.byteLength;
for (const bone of BONE_ORDER) {
  const q = quats[bone];
  const values = new Float32Array([q.x, q.y, q.z, q.w, q.x, q.y, q.z, q.w]);
  bin.push(Buffer.from(values.buffer));
  bufferViews.push({ buffer: 0, byteOffset, byteLength: values.byteLength });
  const bvIndex = bufferViews.length - 1;
  accessors.push({ bufferView: bvIndex, byteOffset: 0, componentType: 5126, count: 2, type: 'VEC4' });
  const accIndex = accessors.length - 1;
  samplers.push({ input: 0, output: accIndex, interpolation: 'STEP' });
  channels.push({ sampler: samplers.length - 1, target: { node: NODE_INDEX[bone], path: 'rotation' } });
  byteOffset += values.byteLength;
}
const bufferBytes = Buffer.concat(bin);

const node = (name, translation, children) => { const n = { name, translation }; if (children) n.children = children; return n; };
const gltfJson = {
  asset: { version: '2.0', generator: 'make-sit-pose.mjs (T-31 sit-prep, hand-authored, no Mixamo)' },
  extensionsUsed: ['VRMC_vrm_animation'],
  extensions: {
    VRMC_vrm_animation: {
      specVersion: '1.0',
      humanoid: { humanBones: Object.fromEntries(Object.keys(NODE_INDEX).map((n) => [n, { node: NODE_INDEX[n] }])) },
    },
  },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [
    node('hips', [0, 1, 0], [1, 4]),
    node('leftUpperLeg', [0.08, -0.08, 0], [2]),
    node('leftLowerLeg', [0, -0.35, 0], [3]),
    node('leftFoot', [0, -0.42, 0]),
    node('rightUpperLeg', [-0.08, -0.08, 0], [5]),
    node('rightLowerLeg', [0, -0.35, 0], [6]),
    node('rightFoot', [0, -0.42, 0]),
  ],
  animations: [{ name: 'sit-idle', channels, samplers }],
  accessors,
  bufferViews,
  buffers: [{ byteLength: bufferBytes.length, uri: `data:application/octet-stream;base64,${bufferBytes.toString('base64')}` }],
};

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(gltfJson));
console.log(`wrote ${outFile} (${fs.statSync(outFile).size} bytes)`);
