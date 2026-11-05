// Authors assets/clips/sit-work.vrma: a ONE-KEYFRAME, ROTATION-ONLY seated pose for the LEGS (same targets
// as make-sit-pose.mjs's sit-idle) PLUS the ARMS (new, coordinator round 6: "forearms forward toward the
// keyboard, hands near the keyboard/desk edge, not hanging"), loadable by the app's own ClipLayer exactly
// like sit-idle. No Mixamo, no downloads -- quaternions computed from THIS model's own rest-pose bone
// geometry, same aimLocal technique as make-sit-pose.mjs (see that file's header for the full method).
//
// Why this is a SEPARATE clip from sit-idle, not an edit to it: seat.js's SIT_CLIP_NAME is about to be
// made to read room.json's zumi_seat.pose (already a per-view field, previously unused) instead of being
// hardcoded -- so talk/room keep the arms-neutral sit-idle (pose: "sit-idle", unchanged, hands fall to
// REACH.seatedRest's live "hands on thighs" IK, same as before this task), while work opts into this
// clip (pose: "sit-work") for its own seated base.
//
// KNOWN ARCHITECTURE TENSION (read before changing arm targets): make-sit-pose.mjs deliberately left arms
// OUT of sit-idle because ClipLayer.blend() (clips.js) slerps a sustained clip's own bones over the
// procedural pose EVERY FRAME, unconditionally, at the clip's weight -- legs are safe (no reflex/gesture
// ever targets them) but arms are NOT: rig.js's solveArms() + a live gesture's own reach both run through
// the SAME per-bone weight-accumulation this clip now also participates in (clips.js `sample()`: concurrent
// clips/requests touching the same bone are weight-normalized together), so a gesture that also moves an
// arm while sit-work is sustained will have its influence diluted, not a clean override. This is the
// explicit, acknowledged trade-off of this task's own brief ("used as the work view's seated base (upper-
// body reflexes still override)") -- "still override" holds only approximately (partial dilution, not a
// hard win) for bones this clip touches; check:motion-seated run against this clip is the empirical check,
// not a proof.
//
//   node scripts/make-sit-work-pose.mjs [--model <file.vrm>] [--out <file.vrma>]
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
const outFile = path.resolve(arg('out', path.join(ROOT, 'assets/clips/sit-work.vrma')));

// ---------- load the real model, measure rest-pose leg + arm geometry ----------
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
const restAnkleY = pos('leftFoot').y;
const restToeY = pos('leftToes').y;
console.log(`measured standing hip height: ${hipsY.toFixed(4)} m, ankle clearance: ${restAnkleY.toFixed(4)} m`);

const DEG = Math.PI / 180;
function aimLocal(restLocalDir, parentWorldQuatNow, desiredWorldDir) {
  const targetLocal = desiredWorldDir.clone().applyQuaternion(parentWorldQuatNow.clone().invert()).normalize();
  return new THREE.Quaternion().setFromUnitVectors(restLocalDir.clone().normalize(), targetLocal);
}

const sides = ['left', 'right'];
const quats = {};
const report = {};

// ---------- legs: identical targets to make-sit-pose.mjs's sit-idle (see that file for the full reasoning) ----------
for (const side of sides) {
  const upperLeg = `${side}UpperLeg`, lowerLeg = `${side}LowerLeg`, foot = `${side}Foot`;
  const kneeP = pos(lowerLeg), ankleP = pos(foot);
  const dThighRest = kneeP.clone().sub(pos(upperLeg)).normalize();
  const dShinRest = ankleP.clone().sub(kneeP).normalize();
  const droopDeg = 3;
  const desiredThigh = new THREE.Vector3(0, -Math.sin(droopDeg * DEG), Math.cos(droopDeg * DEG)).normalize();
  const qThigh = aimLocal(dThighRest, new THREE.Quaternion(), desiredThigh);
  quats[upperLeg] = qThigh;
  const qShin = aimLocal(dShinRest, qThigh, dShinRest);
  quats[lowerLeg] = qShin;
  quats[foot] = new THREE.Quaternion();
  nb(upperLeg).quaternion.copy(qThigh); nb(lowerLeg).quaternion.copy(qShin); nb(foot).quaternion.copy(quats[foot]);
  vrm.scene.updateMatrixWorld(true);
  const kneeNew = pos(lowerLeg), ankleNew = pos(foot);
  const thighDirNew = kneeNew.clone().sub(pos(upperLeg)).normalize();
  const shinDirNew = ankleNew.clone().sub(kneeNew).normalize();
  report[`${side}Leg`] = {
    hipFlexDeg: +(Math.acos(THREE.MathUtils.clamp(thighDirNew.dot(new THREE.Vector3(0, 1, 0)), -1, 1)) / DEG).toFixed(1),
    kneeFlexDeg: +(Math.acos(THREE.MathUtils.clamp(-thighDirNew.dot(shinDirNew), -1, 1)) / DEG).toFixed(1),
  };
}

// ---------- arms: NEW -- forward-and-down reach, hands toward desk height, forward of the body ----------
// Targets authored in the clip's own identity frame (no avatar placement/rotYDeg applied yet -- room.json's
// seat.rotYDeg later rotates the whole seated body, aiming these SAME local-forward-reaching arms at
// whatever the painted desk's actual world direction is for that view; this generator never needs to know
// camera/room geometry). "Forward" here is local +Z (this model's own bind-pose facing axis, see
// make-sit-pose.mjs's header -- same convention, already verified on this model).
//   upper arm (shoulder->elbow): forward and down and slightly outward (elbows relaxed, not pinned to the
//     torso) -- a typing posture's upper arm is closer to vertical than a desk reach, elbows roughly at the
//     torso's sides.
//   lower arm (elbow->wrist): continuing forward, levelling out toward horizontal -- brings the hand up to
//     roughly desk/keyboard height instead of continuing down toward the floor.
//   hand: identity local rotation (fingers/hand SHAPE is a separate system -- rig.js's default loose shape
//     layers on top of whatever this clip leaves the wrist bone at; no hand track needed for "neutral").
for (const side of sides) {
  const sign = side === 'left' ? 1 : -1; // outward = +X for left, -X for right (this model's own local axis convention, matches rig.js's `sign` usage for the same purpose)
  const upperArm = `${side}UpperArm`, lowerArm = `${side}LowerArm`, hand = `${side}Hand`;
  const elbowP = pos(lowerArm), wristP = pos(hand);
  const dUpperRest = elbowP.clone().sub(pos(upperArm)).normalize();
  const dLowerRest = wristP.clone().sub(elbowP).normalize();

  const desiredUpper = new THREE.Vector3(sign * 0.30, -0.60, 0.74).normalize(); // down ~53deg from horizontal, forward-leaning, elbows slightly out
  const qUpper = aimLocal(dUpperRest, new THREE.Quaternion(), desiredUpper);
  quats[upperArm] = qUpper;

  const desiredLower = new THREE.Vector3(sign * 0.10, 0.10, 0.99).normalize(); // levels out forward (less upward correction than the first attempt -- round 7 QC: hands rendered floating above the keyboard, not resting near it) -- brings the hand down to roughly elbow height, forward, for the keyboard
  const qLower = aimLocal(dLowerRest, qUpper, desiredLower);
  quats[lowerArm] = qLower;

  quats[hand] = new THREE.Quaternion();

  nb(upperArm).quaternion.copy(qUpper); nb(lowerArm).quaternion.copy(qLower); nb(hand).quaternion.copy(quats[hand]);
  vrm.scene.updateMatrixWorld(true);
  const elbowNew = pos(lowerArm), wristNew = pos(hand);
  report[`${side}Arm`] = {
    shoulderY: +pos(upperArm).y.toFixed(4), elbowY: +elbowNew.y.toFixed(4), wristY: +wristNew.y.toFixed(4),
    wristForwardOfShoulderZ: +(wristNew.z - pos(upperArm).z).toFixed(4),
    elbowFlexDeg: +(Math.acos(THREE.MathUtils.clamp(-elbowNew.clone().sub(pos(upperArm)).normalize().dot(wristNew.clone().sub(elbowNew).normalize()), -1, 1)) / DEG).toFixed(1),
  };
}
console.log('verification (legs: hipFlexDeg ~85-95, kneeFlexDeg ~90; arms: wristY near desk height, wristForwardOfShoulderZ > 0, elbowFlexDeg ~70-110):');
console.log(JSON.stringify(report, null, 1));

{
  const { computeRootDrop } = await import('./seat-offset.mjs');
  const dropAnkle = computeRootDrop(report.leftLeg ? pos('leftFoot').y : restAnkleY, restAnkleY);
  console.log(`(root-drop preview uses the SAME ankle-anchored method as sit-idle -- seat.js computes this live, not baked into the clip)`);
}

// ---------- build the glTF + VRMC_vrm_animation JSON (embedded buffer, 2 identical keyframes = static) ----------
const BONE_ORDER = [
  'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot',
  'leftUpperArm', 'leftLowerArm', 'leftHand', 'rightUpperArm', 'rightLowerArm', 'rightHand',
];
const NODE_INDEX = Object.fromEntries(['hips', ...BONE_ORDER].map((n, i) => [n, i]));
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
  asset: { version: '2.0', generator: 'make-sit-work-pose.mjs (T-31 work-view fit round 6, hand-authored, no Mixamo)' },
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
    node('hips', [0, 1, 0], [1, 4, 7, 10]),
    node('leftUpperLeg', [0.08, -0.08, 0], [2]),
    node('leftLowerLeg', [0, -0.35, 0], [3]),
    node('leftFoot', [0, -0.42, 0]),
    node('rightUpperLeg', [-0.08, -0.08, 0], [5]),
    node('rightLowerLeg', [0, -0.35, 0], [6]),
    node('rightFoot', [0, -0.42, 0]),
    node('leftUpperArm', [0.17, 0.5, 0], [8]),
    node('leftLowerArm', [0.27, 0, 0], [9]),
    node('leftHand', [0.25, 0, 0]),
    node('rightUpperArm', [-0.17, 0.5, 0], [11]),
    node('rightLowerArm', [-0.27, 0, 0], [12]),
    node('rightHand', [-0.25, 0, 0]),
  ],
  animations: [{ name: 'sit-work', channels, samplers }],
  accessors,
  bufferViews,
  buffers: [{ byteLength: bufferBytes.length, uri: `data:application/octet-stream;base64,${bufferBytes.toString('base64')}` }],
};

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(gltfJson));
console.log(`wrote ${outFile} (${fs.statSync(outFile).size} bytes)`);
