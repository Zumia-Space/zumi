// Authors assets/clips/float-idle.vrma: a ONE-KEYFRAME, ROTATION-ONLY floating pose for the legs (hips,
// upperLeg, lowerLeg, foot x2), loadable by the app's own ClipLayer (clips.js) exactly like any other
// built-in clip. Same hand-built glTF + VRMC_vrm_animation approach as make-sit-pose.mjs (embedded buffer,
// no Mixamo, no downloads) -- the quaternions are computed from THIS model's own rest-pose bone geometry
// (the owner's test model, owner-paths testModel) and written straight into the JSON.
//
// Why a separate float pose, and why these angles: the floating mode (float-mode.js) hangs her in mid-air
// with no chair. Reusing sit-idle there would read as "seated on nothing" -- a zero-g relaxed hang needs the
// legs to fall mostly DOWN with a loose, ASYMMETRIC bend (a symmetric pose reads as a deliberate stance, not
// a drift). So: thighs hang forward a little (14 deg left / 24 deg right off straight-down), knees bend
// loosely and unequally (30 / 46 deg), and the feet plantar-flex only SLIGHTLY (toes down, 14 deg) -- r3 used
// 25 deg, which read as "en pointe / standing on tiptoe on the floor"; a relaxed floating foot barely points.
// No hips rotation -- the pelvis stays upright.
//
// Why rotation-only, and why legs only (unchanged from make-sit-pose.mjs): vertical placement is done by
// translating the avatar's scene root (seat.js / float-mode.js), NOT by this clip, and NOT by loosening
// clips.js:84's quaternion-only track filter. Spine/chest/neck/head/shoulders/arms/hands are left OUT on
// purpose: ClipLayer.blend() slerps this clip's bones over the procedural pose every frame at the clip's
// weight, which would otherwise fight upper-body reflexes, gaze and gestures. Legs are never touched by any
// reflex, so holding them at weight 1 is safe and is the only way to pose them at all.
//
// How the pose is computed (aimLocal): for each leg bone, measure its REST local "to-child" direction, then
// solve the minimal local quaternion that re-points that same direction at a chosen WORLD target direction,
// given the bone's parent's ALREADY-RESOLVED new world rotation (resolved top-down: hips -> upperLeg ->
// lowerLeg). The foot is a plain local rotation about X (plantar-flexion), applied on top of the resolved
// shin -- see make-sit-pose.mjs's header for the full reasoning on the identity-at-rest convention.
//
//   node scripts/make-float-pose.mjs [--model <file.vrm>] [--out <file.vrma>]
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
const outFile = path.resolve(arg('out', path.join(ROOT, 'assets/clips/float-idle.vrma')));

// The float pose's own angles (degrees). Asymmetric on purpose -- see the header.
const FLOAT_ANGLES = { left: { thighDeg: 14, kneeDeg: 30 }, right: { thighDeg: 24, kneeDeg: 46 } };
const PLANTAR_DEG = 14; // toes relaxed, only slightly down from the shin (r4; r3's 25 deg read as en pointe)

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
const restAnkleY = pos('leftFoot').y;
const restToeY = pos('leftToes').y;
console.log(`measured standing ankle-to-floor clearance: ${restAnkleY.toFixed(4)} m, toe: ${restToeY.toFixed(4)} m`);

const DEG = Math.PI / 180;
function aimLocal(restLocalDir, parentWorldQuatNow, desiredWorldDir) {
  const targetLocal = desiredWorldDir.clone().applyQuaternion(parentWorldQuatNow.clone().invert()).normalize();
  return new THREE.Quaternion().setFromUnitVectors(restLocalDir.clone().normalize(), targetLocal);
}
// Sagittal-plane direction: forward (+Z), down (-Y). `tiltDeg` is the forward tilt off straight-down.
const sagittal = (tiltDeg) => new THREE.Vector3(0, -Math.cos(tiltDeg * DEG), Math.sin(tiltDeg * DEG)).normalize();

const sides = ['left', 'right'];
const quats = {}; // boneName -> THREE.Quaternion (local rotation to author)
const report = {};
for (const side of sides) {
  const { thighDeg, kneeDeg } = FLOAT_ANGLES[side];
  const upperLeg = `${side}UpperLeg`, lowerLeg = `${side}LowerLeg`, foot = `${side}Foot`;
  const kneeP = pos(lowerLeg), ankleP = pos(foot);
  const dThighRest = kneeP.clone().sub(pos(upperLeg)).normalize(); // hip joint -> knee, rest
  const dShinRest = ankleP.clone().sub(kneeP).normalize(); // knee -> ankle, rest

  // thigh: hangs forward `thighDeg` off straight-down (hip flexion stays small -- a drift, not a sit)
  const qThigh = aimLocal(dThighRest, new THREE.Quaternion(), sagittal(thighDeg)); // parent (hips) stays identity
  quats[upperLeg] = qThigh;

  // shin: the thigh line bent BACK by `kneeDeg` (knee flexion), so the shin's own forward tilt = thighDeg - kneeDeg
  const qShin = aimLocal(dShinRest, qThigh, sagittal(thighDeg - kneeDeg));
  quats[lowerLeg] = qShin;

  // foot: plantar-flexed about the (sagittal) local X -- toes point down; see header
  quats[foot] = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), PLANTAR_DEG * DEG);

  // ---------- verification: replay these quats on the live rig and measure the result ----------
  nb(upperLeg).quaternion.copy(qThigh);
  nb(lowerLeg).quaternion.copy(qShin);
  nb(foot).quaternion.copy(quats[foot]);
  vrm.scene.updateMatrixWorld(true);
  const kneeNew = pos(lowerLeg), ankleNew = pos(foot), toeNew = pos(`${side}Toes`);
  const thighDir = kneeNew.clone().sub(pos(upperLeg)).normalize();
  const shinDir = ankleNew.clone().sub(kneeNew).normalize();
  const footDir = toeNew.clone().sub(ankleNew).normalize();
  const hipFlexDeg = Math.acos(THREE.MathUtils.clamp(thighDir.dot(new THREE.Vector3(0, -1, 0)), -1, 1)) / DEG; // off straight-down
  const kneeBendDeg = Math.acos(THREE.MathUtils.clamp(thighDir.dot(shinDir), -1, 1)) / DEG; // thigh line vs shin line: 0 = straight
  report[side] = {
    hipFlexDeg: +hipFlexDeg.toFixed(1), kneeBendDeg: +kneeBendDeg.toFixed(1),
    ankleY: +ankleNew.y.toFixed(4), toeY: +toeNew.y.toFixed(4),
    footBelowAnkle: +(ankleNew.y - toeNew.y).toFixed(4), // > 0 means the toe points down (plantar-flexed)
  };
}
console.log('verification (expect hipFlexDeg ~14/24, kneeBendDeg ~30/46, footBelowAnkle > 0):');
console.log(JSON.stringify(report, null, 1));
{
  const { computeRootDrop } = await import('./seat-offset.mjs');
  const drop = computeRootDrop(report.left.ankleY, restAnkleY);
  console.log(`preview (ankle-anchored): drop ${drop.toFixed(4)} m -> left ankle -> ${(report.left.ankleY - drop).toFixed(4)} m, toe -> ${(report.left.toeY - drop).toFixed(4)} m (standing ankle was ${restAnkleY.toFixed(4)})`);
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
  asset: { version: '2.0', generator: 'make-float-pose.mjs (T-31 float-holo pilot, hand-authored, no Mixamo)' },
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
  animations: [{ name: 'float-idle', channels, samplers }],
  accessors,
  bufferViews,
  buffers: [{ byteLength: bufferBytes.length, uri: `data:application/octet-stream;base64,${bufferBytes.toString('base64')}` }],
};

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(gltfJson));
console.log(`wrote ${outFile} (${fs.statSync(outFile).size} bytes)`);
