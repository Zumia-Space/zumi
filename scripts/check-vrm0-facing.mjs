// VRM 0.x facing gate (owner bug T-31: "Anh import thử model vào trong zumi model thì model đang bị quay ngược
// lại màn hình" -- an imported VRM 0.x avatar (CoolTiger: UniVRM 0.99, extension "VRM") stood with its BACK to
// the camera while the bundled VRM 1.0 model was fine).
//
// Root cause this gate locks down: prepareVrm() correctly calls VRMUtils.rotateVRM0(), which turns a VRM 0.x
// scene root 180 degrees so it faces +Z like a VRM 1.0 model -- and then stage placement (room-stage.js's
// placeZumi and seat.js's placeSeated) assigned the room/seat quaternion OUTRIGHT, discarding that base flip.
// Every load path overwrote it, so the avatar only ever faced forward on VRM 1.0 (base = identity).
//
// The fixtures are mock VRM objects (a scene root + a head/leg bones) pushed through the REAL production
// prepareVrm() (so VRMUtils' own 90-line flip runs for real), then through the REAL stage functions. "Forward"
// is the spec's own model-forward vector, (0,0,1) in the scene's native frame, carried into world space by the
// scene quaternion -- exactly what the loader/camera assume. Assertions:
//   1. every path (no room / v1 stand anchor / v2 seat per view) keeps a VRM 0.x model facing the SAME way as a
//      VRM 1.0 model placed at the same anchor/seat (the model-version-independent invariant);
//   2. the no-room and v1 stand paths plus the v2 talk view face the camera placed by the production framing;
//   3. repeated placement is idempotent (the base flip is captured once, never compounded);
//   4. the default (VRM 1.0) model's facing is unchanged from before the fix (regression);
//   5. measureHipOffsetXZ() restores the scene's placement, base flip included.
//
//   6. real models (--model1 / --model0, defaults mirror check:rig): the REAL Rig and SeatFit reach their IK
//      targets on both versions (a VRM 0.x hand used to miss by ~0.8 m because the rig solved in world-at-bind
//      while the rest frames carried the flip), seated feet point forward, and float/holo face the authored seat.
//   7. real models, ORIENTATION (round 3): positions alone were not enough -- every VRM 0.x IK-solved bone landed
//      on its target but came out rolled 180 degrees about its own axis (rest bend reference captured in the root
//      frame, whose +Z is her BACK under the flip). A forward arm curl and a knee bend must stay twist-free
//      (upper-arm/thigh roll vs rest < 30 deg, FOREARM roll < 60 deg), the seated thigh front/kneecap must face her
//      front on every view, and the seated arm/elbow front must land on the same side as VRM 1.0 plus the seated
//      forearm must keep its own rest roll (< 60 deg).
//      Every roll baseline is the REST pose in that view's own frame (resetNormalizedPose after placeSeated), never
//      the previous view's solved pose -- otherwise a rolled solve reads as 0 deg against itself.
//      VRM 1.0 is pinned as an EQUALITY: its arm and knee solves must reproduce the 0ee30ee (root-frame) solver's
//      world quaternions to 1e-6, not merely stay under a roll threshold. The same reference must be off by >30 deg
//      on VRM 0.x, proving the exercises measure the round-3 frame change.
//
// Usage: node scripts/check-vrm0-facing.mjs [--model1 <vrm1>] [--model0 <vrm0>]
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { prepareVrm, bodyOrientation } from '../src/renderer/model-facing.js';
import { placeZumi, frameStageCamera } from '../src/renderer/room/room-stage.js';
import { placeSeated, measureHipOffsetXZ } from '../src/renderer/room/seat.js';
import { SeatFit, solveTwoBone } from '../src/renderer/room/seat-fit.js';
import { placeFloat, FLOAT } from '../src/renderer/room/float-mode.js';
import { holoOffset } from '../src/renderer/room/holo-screen.js';
import { Rig } from '../src/renderer/reflex/rig.js';
import { ownerPath } from './lib/owner-paths.mjs';

const ROOM_JSON = path.join(import.meta.dirname, '..', 'resources-pinned', 'room-v2', 'room.json');
// Recorded from an 0ee30ee checkout of src/renderer/reflex/rig.js, running this gate's own two bind-placement
// exercises (forward arm curl, knee bend) at the no-anchor placement: the world quaternions of the solved left
// upper/lower arm and upper/lower leg. VRM 1.0 must reproduce them to 1e-6 -- the round-3 frame fix was required to
// be a numerical no-op on VRM 1.0, and this is that claim as an equality instead of a "roll under 30 deg" smell test.
// Both bundled Zumi models share the bind geometry (same numbers); a model with no recording SKIPs the pin, while the
// roll/front asserts still run on it.
const RECORDED_0EE30EE = {
  'zumi-default-0910.vrm': {
    armUpper: [4e-9, 0.048877351, 0, 0.998804788],
    armLower: [0.000003849, -0.705353514, -0.000003928, 0.708855712],
    legUpper: [-0.094297209, 2e-9, -1e-9, 0.995544091],
    legLower: [0.551366703, -1e-8, -7e-9, 0.834263003],
  },
  'zumi-v3.1.vrm': {
    armUpper: [4e-9, 0.048877351, 0, 0.998804788],
    armLower: [0.000003849, -0.705353514, -0.000003928, 0.708855712],
    legUpper: [-0.094297209, 2e-9, -1e-9, 0.995544091],
    legLower: [0.551366703, -1e-8, -7e-9, 0.834263003],
  },
};
const EPS = 1e-6;
let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${detail}`); }
};

// A mock VRM: the real prepareVrm() only needs { scene, meta } for the flip, and humanoid lookups for the seat
// measurement probe. Bones sit at plausible heights so world positions are meaningful.
function makeVrm(metaVersion) {
  const scene = new THREE.Group();
  scene.name = 'vrmScene';
  const bone = (name, y, z = 0) => { const b = new THREE.Bone(); b.name = name; b.position.set(0, y, z); scene.add(b); return b; };
  bone('head', 1.5, 0.05);
  bone('leftUpperLeg', 0.95, 0);
  const rightUpperLeg = bone('rightUpperLeg', 0.95, 0);
  rightUpperLeg.position.x = 0.1;
  const vrm = {
    meta: { metaVersion },
    scene,
    humanoid: { getNormalizedBoneNode: (n) => scene.getObjectByName(n) || null },
  };
  const gltf = { scene, userData: { vrm } };
  prepareVrm(gltf, vrm); // production prep: VRM 0.x gets the real VRMUtils.rotateVRM0() flip here
  return vrm;
}

const forward = (vrm) => new THREE.Vector3(0, 0, vrm.meta.metaVersion === '0' ? -1 : 1).applyQuaternion(vrm.scene.quaternion).setY(0).normalize();
// seat-fit.js's own frame (+Z forward, +X left) after the model's base flip is removed -- must match the room's
// authored stage/seat rotation for BOTH versions, or its seated leg/lean/hand solve is mirrored.
const bodyForward = (vrm) => new THREE.Vector3(0, 0, 1).applyQuaternion(bodyOrientation(vrm.scene)).setY(0).normalize();
const yQuat = (deg) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), deg * Math.PI / 180);
const near = (a, b, eps = 1e-4) => a.distanceTo(b) <= eps;
const nearQuat = (a, b, eps = 1e-4) => a.angleTo(b) <= eps;
const facingCamera = (vrm, seatPos, cameraPos) => {
  const toCam = new THREE.Vector3(cameraPos.x - seatPos.x, 0, cameraPos.z - seatPos.z).normalize();
  return forward(vrm).dot(toCam);
};

// ---------- 1. no-room path: placeZumi(scene, null), then the production camera framing ----------
for (const [version, label] of [['0', 'VRM 0.x'], ['1', 'VRM 1.0']]) {
  const vrm = makeVrm(version);
  placeZumi(vrm.scene, null);
  ok(near(forward(vrm), new THREE.Vector3(0, 0, 1)), `${label}: no-room placement faces +Z`, `forward=${forward(vrm).toArray()}`);
  ok(near(bodyForward(vrm), new THREE.Vector3(0, 0, 1)), `${label}: no-room body frame (seat-fit) is +Z too`, `bodyForward=${bodyForward(vrm).toArray()}`);

  const head = vrm.humanoid.getNormalizedBoneNode('head').getWorldPosition(new THREE.Vector3());
  const rig = { shoulderWidth: 0.42, armLength: 0.62, shoulderY: head.y - 0.2, headPos: head, hipsPos: new THREE.Vector3(0, 0.95, 0) };
  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
  frameStageCamera(camera, rig, vrm, new THREE.Vector3(0, 0, 0), null);
  const d = facingCamera(vrm, new THREE.Vector3(0, 0, 0), camera.position);
  ok(d > 0.99, `${label}: no-room camera sees the face (forward . toward-camera = ${d.toFixed(3)})`, `camera=${camera.position.toArray()}`);
}

// ---------- 2. v1 room path: a zumi_stand anchor with a non-zero facing, camera_default straight ahead ----------
for (const [version, label] of [['0', 'VRM 0.x'], ['1', 'VRM 1.0']]) {
  const vrm = makeVrm(version);
  const standQuat = yQuat(25);
  const standPos = new THREE.Vector3(0.4, 0, 0.3);
  const anchor = { position: standPos.clone(), quaternion: standQuat.clone() };
  placeZumi(vrm.scene, anchor);
  const expected = new THREE.Vector3(0, 0, 1).applyQuaternion(standQuat).setY(0).normalize();
  ok(near(forward(vrm), expected), `${label}: v1 stand anchor rotY=25 keeps the anchor's facing`, `forward=${forward(vrm).toArray()} expected=${expected.toArray()}`);
  ok(near(bodyForward(vrm), expected), `${label}: v1 body frame (seat-fit) keeps the anchor's facing`, `bodyForward=${bodyForward(vrm).toArray()}`);
  ok(near(vrm.scene.position, standPos), `${label}: v1 stand anchor still places the scene at the anchor`, `pos=${vrm.scene.position.toArray()}`);

  const head = vrm.humanoid.getNormalizedBoneNode('head').getWorldPosition(new THREE.Vector3());
  const rig = { shoulderWidth: 0.42, armLength: 0.62, shoulderY: head.y - 0.2, headPos: head, hipsPos: new THREE.Vector3(standPos.x, 0.95, standPos.z) };
  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
  const camAnchor = new THREE.Vector3(standPos.x + expected.x * 2, 1.3, standPos.z + expected.z * 2);
  frameStageCamera(camera, rig, vrm, standPos, camAnchor);
  const d = facingCamera(vrm, standPos, camera.position);
  ok(d > 0.99, `${label}: v1 camera_default sees the face (forward . toward-camera = ${d.toFixed(3)})`, `camera=${camera.position.toArray()}`);
}

// ---------- 3. v2 room path: the pinned default room's own per-view seats + cameras ----------
const roomJson = JSON.parse(fs.readFileSync(ROOM_JSON, 'utf8'));
const views = Object.keys(roomJson.views || {});
ok(views.length >= 3 && views.includes('talk'), 'the pinned room fixture has the talk/work/room views', JSON.stringify(views));

for (const viewName of views) {
  const view = roomJson.views[viewName];
  const seat = view && view.zumi_seat;
  if (!seat) continue;
  const engine = (version) => ({ vrm: makeVrm(version), rig: null });
  const v0 = engine('0'), v1 = engine('1');
  placeSeated(v0, seat, 0, { x: 0, z: 0 });
  placeSeated(v1, seat, 0, { x: 0, z: 0 });

  const authored = new THREE.Vector3(Math.sin(seat.rotYDeg * Math.PI / 180), 0, Math.cos(seat.rotYDeg * Math.PI / 180));
  ok(near(forward(v0.vrm), authored), `v2 ${viewName}: VRM 0.x faces the authored seat direction`, `forward=${forward(v0.vrm).toArray()} expected=${authored.toArray()}`);
  ok(near(forward(v1.vrm), authored), `v2 ${viewName}: VRM 1.0 faces the authored seat direction`, `forward=${forward(v1.vrm).toArray()} expected=${authored.toArray()}`);
  ok(near(forward(v0.vrm), forward(v1.vrm), EPS), `v2 ${viewName}: VRM 0.x and VRM 1.0 face the SAME way`, `v0=${forward(v0.vrm).toArray()} v1=${forward(v1.vrm).toArray()}`);
  ok(near(bodyForward(v0.vrm), authored), `v2 ${viewName}: VRM 0.x body frame (seat-fit) matches the authored direction`, `bodyForward=${bodyForward(v0.vrm).toArray()}`);
  ok(near(bodyForward(v0.vrm), bodyForward(v1.vrm), EPS), `v2 ${viewName}: VRM 0.x and VRM 1.0 seat-fit body frames match`, `v0=${bodyForward(v0.vrm).toArray()} v1=${bodyForward(v1.vrm).toArray()}`);

  // The talk view is the one the owner sees on import / launch: the authored camera must be in FRONT of her.
  // (work/room deliberately face the monitors/window, i.e. partly away -- their invariant is the authored rotY.)
  if (viewName === 'talk') {
    for (const [version, label] of [['0', 'VRM 0.x'], ['1', 'VRM 1.0']]) {
      const e = version === '0' ? v0 : v1;
      const d = facingCamera(e.vrm, new THREE.Vector3(seat.pos[0], 0, seat.pos[2]), new THREE.Vector3(...view.camera.pos));
      ok(d > 0.99, `v2 talk: ${label} faces the authored camera (forward . toward-camera = ${d.toFixed(3)})`, `camera=${JSON.stringify(view.camera.pos)}`);
    }
  }
}

// ---------- 3b. nonzero hip offset: root = seat.pos - q*(hipOffset)*scale still lands the hip on the seat axis
// seat.js solves the root from the cached model-local hip offset and the SAME quaternion it puts on the scene;
// this guards that numeric solve at a non-zero rotation/offset (the facing/composition assertions above are what
// distinguish a VRM 0.x base flip being dropped -- this solve is self-consistent either way).
for (const [version, label] of [['0', 'VRM 0.x'], ['1', 'VRM 1.0']]) {
  const vrm = makeVrm(version);
  const nb = (n) => vrm.humanoid.getNormalizedBoneNode(n);
  // set the hip-joint midpoint's model-local (x,z) to a deliberate nonzero offset
  const hipOffset = { x: 0.06, z: -0.04 };
  nb('leftUpperLeg').position.set(hipOffset.x - 0.1, 0.95, hipOffset.z);
  nb('rightUpperLeg').position.set(hipOffset.x + 0.1, 0.95, hipOffset.z);
  const seat = { pos: [0.3, 0.5, -0.2], rotYDeg: 37, pose: 'sit-idle' };
  placeSeated({ vrm, rig: null }, seat, 0, hipOffset);
  vrm.scene.updateMatrixWorld(true);
  const l = nb('leftUpperLeg').getWorldPosition(new THREE.Vector3());
  const r = nb('rightUpperLeg').getWorldPosition(new THREE.Vector3());
  const mid = l.add(r).multiplyScalar(0.5);
  ok(Math.abs(mid.x - seat.pos[0]) < 1e-6 && Math.abs(mid.z - seat.pos[2]) < 1e-6,
    `${label}: rotated hip offset lands the hip midpoint on the seat axis`,
    `mid=(${mid.x.toFixed(4)},${mid.z.toFixed(4)}) want=(${seat.pos[0]},${seat.pos[2]})`);
}

// ---------- 4. idempotence: repeated placement never compounds the base flip ----------
{
  const vrm = makeVrm('0');
  const anchor = { position: new THREE.Vector3(0, 0, 0), quaternion: new THREE.Quaternion() };
  placeZumi(vrm.scene, anchor);
  const once = forward(vrm).clone();
  placeZumi(vrm.scene, anchor);
  placeZumi(vrm.scene, anchor);
  ok(near(forward(vrm), once) && once.z > 0.99, 'VRM 0.x: placing three times is idempotent (base flip captured once)', `forward=${forward(vrm).toArray()}`);
  const seat = roomJson.views.talk.zumi_seat;
  const e = { vrm, rig: null };
  placeSeated(e, seat, 0, { x: 0, z: 0 });
  const seatedOnce = forward(vrm).clone();
  placeSeated(e, seat, 0, { x: 0, z: 0 });
  ok(near(forward(vrm), seatedOnce) && seatedOnce.z > 0.99, 'VRM 0.x: placing seated twice is idempotent', `forward=${forward(vrm).toArray()}`);
}

// ---------- 5. measureHipOffsetXZ restores the placement (base flip included) ----------
for (const [version, label, expectedY] of [['0', 'VRM 0.x', Math.PI], ['1', 'VRM 1.0', 0]]) {
  const vrm = makeVrm(version);
  placeZumi(vrm.scene, null);
  const before = vrm.scene.quaternion.clone();
  const engine = { vrm };
  const off = measureHipOffsetXZ(engine);
  ok(off && Number.isFinite(off.x) && Number.isFinite(off.z), `${label}: measureHipOffsetXZ returns a finite local hip offset`, JSON.stringify(off));
  ok(nearQuat(vrm.scene.quaternion, before, EPS), `${label}: measureHipOffsetXZ restores the scene's placement`, `quat=${vrm.scene.quaternion.toArray()}`);
  const yaw = new THREE.Euler().setFromQuaternion(vrm.scene.quaternion, 'YXZ').y;
  ok(Math.abs(Math.abs(yaw) - expectedY) < 1e-4, `${label}: restored yaw is the model's base orientation (${expectedY.toFixed(2)} rad)`, `yaw=${yaw.toFixed(4)}`);
}

// ---------- 6. regression: the bundled VRM 1.0 default model is unchanged (identity base, faces +Z) ----------
{
  const vrm = makeVrm('1');
  ok(vrm.scene.quaternion.angleTo(new THREE.Quaternion()) < EPS, 'VRM 1.0: prepareVrm leaves the scene orientation untouched (no flip)', `quat=${vrm.scene.quaternion.toArray()}`);
  placeZumi(vrm.scene, null);
  ok(near(forward(vrm), new THREE.Vector3(0, 0, 1)), 'VRM 1.0: default model still faces forward (+Z)', `forward=${forward(vrm).toArray()}`);
}

// ---------- 7. real models: the fixtures above have no bones, so they cannot see an IK miss ----------
// Runs the REAL Rig + SeatFit on the VRM 1.0 default model and the owner's VRM 0.x CoolTiger. Missing files are a
// SKIP (a bare checkout has no private model assets); the mock gate above still fails on its own.
const argOf = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : def; };
const MODEL1 = path.resolve(argOf('model1', process.env.ZUMI_TEST_MODEL || ownerPath('testModel', 'local/test-model.vrm')));
const MODEL0 = path.resolve(argOf('model0', ownerPath('vrm0Model', 'local/vrm0-model.vrm')));
const missingModels = [MODEL0, MODEL1].filter((f) => !fs.existsSync(f));
if (missingModels.length) {
  console.log(`SKIP real-model gate (not found: ${missingModels.join(', ')})`);
} else {
  globalThis.self = globalThis;
  globalThis.window = globalThis;
  globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
  globalThis.ProgressEvent = class ProgressEvent { constructor(type, init) { this.type = type; Object.assign(this, init); } };
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const { VRMLoaderPlugin } = await import('@pixiv/three-vrm');
  const V = () => new THREE.Vector3();
  const Q = () => new THREE.Quaternion();
  const TOL = 1e-3; // metres; the exercises below aim well inside the arm's reach, so a correct solve is ~0
  const loadVrm = async (file) => {
    const buf = fs.readFileSync(file);
    const loader = new GLTFLoader();
    loader.register((p) => new VRMLoaderPlugin(p));
    const gltf = await loader.parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
    const vrm = gltf.userData.vrm;
    prepareVrm(gltf, vrm); // same prep as the app: VRM 0.x gets the real 180-degree flip here
    vrm.scene.updateMatrixWorld(true);
    return vrm;
  };
  const modelForward = (vrm) => V().set(0, 0, vrm.meta.metaVersion === '0' ? -1 : 1).applyQuaternion(vrm.scene.getWorldQuaternion(Q())).setY(0).normalize();
  // Reachable synthetic target at 0.9 of the arm's own length, in the chest frame -- the same exercise the review
  // used to measure the 0.78-0.82 m miss. Returns the wrist error in metres.
  const reachMiss = (rig) => {
    const arm = rig.arms.left, s = rig.vrm.scene.scale.x;
    if (!arm) return Infinity;
    const S = arm.upper.getWorldPosition(V());
    const cx = V(), cy = V(), cz = V();
    rig.axesOf(rig.chestNode, cx, cy, cz);
    const target = S.clone().addScaledVector(V().addScaledVector(cz, 0.7).addScaledVector(cy, 0.2).addScaledVector(cx, arm.sign * 0.5).normalize(), 0.9 * (arm.L1 + arm.L2) * s);
    rig.solveArm(arm, target, V().addScaledVector(cx, arm.sign).addScaledVector(cy, -0.6).addScaledVector(cz, -0.2).normalize());
    arm.upper.updateMatrixWorld(true);
    return arm.hand.getWorldPosition(V()).distanceTo(target);
  };
  // The bone's anatomical front in its own LOCAL coordinates. Normalized bones keep identity local rotations, so a
  // bone's local frame is the mesh frame: VRM 1.0 is authored facing +Z, VRM 0.x facing -Z before prepareVrm's flip.
  const frontLocal = (vrm) => V().set(0, 0, vrm.meta.metaVersion === '0' ? -1 : 1);
  const bodyFwd = (vrm) => V().set(0, 0, 1).applyQuaternion(bodyOrientation(vrm.scene)).setY(0).normalize();
  // Roll about the bone's own axis introduced by a solve: take out the swing that carries the rest direction to the
  // solved direction, and what is left is the twist (0 deg for a twist-free solve, ~180 deg for the round-3 bug).
  const rollVsRest = (qBefore, dirBefore, qAfter, dirAfter) => {
    const swing = Q().setFromUnitVectors(dirBefore.clone().normalize(), dirAfter.clone().normalize());
    const twist = qAfter.clone().multiply(qBefore.clone().invert()).multiply(swing.invert());
    return 2 * Math.acos(Math.min(1, Math.abs(twist.w))) * 180 / Math.PI;
  };
  const ikMiss = {};
  const orient = {};      // version -> bind-placement orientation numbers
  const seatOrient = {};  // version -> view -> side -> seated orientation numbers
  for (const file of [MODEL1, MODEL0]) {
    const vrm = await loadVrm(file);
    const version = vrm.meta.metaVersion === '0' ? '0' : '1';
    const label = `${path.basename(file)} (VRM ${version})`;

    // (a) the rig on its own, at the no-anchor bind placement the v2 paths use
    placeZumi(vrm.scene, null);
    vrm.scene.updateMatrixWorld(true);
    const rig = new Rig(vrm);
    ikMiss[version] = reachMiss(rig);
    ok(ikMiss[version] <= TOL, `${label}: arm IK hits a reachable target (miss ${ikMiss[version].toFixed(4)} m)`, `miss=${ikMiss[version]}`);

    // (b) a v1 stand anchor rotated 25 degrees: the rig binds in that frame, the solve must not inherit it
    placeZumi(vrm.scene, { position: new THREE.Vector3(0, 0, 0), quaternion: yQuat(25) });
    vrm.scene.updateMatrixWorld(true);
    const anchoredMiss = reachMiss(new Rig(vrm));
    ok(anchoredMiss <= TOL, `${label}: arm IK hits a reachable target with a rotated stand anchor (miss ${anchoredMiss.toFixed(4)} m)`, `miss=${anchoredMiss}`);

    // (c) the seated post-pass on the pinned room's own talk/work/room seats
    placeZumi(vrm.scene, null);
    vrm.scene.updateMatrixWorld(true);
    const engine = { vrm, rig };
    const hipOffset = measureHipOffsetXZ(engine);
    const seatFit = new SeatFit({ engine });
    seatFit.setRoomJson(roomJson);
    seatFit.measureModel(vrm);
    rig.seated = true;
    seatOrient[version] = {};
    for (const viewName of views) {
      const view = roomJson.views[viewName], seat = view && view.zumi_seat;
      if (!seat) continue;
      placeSeated(engine, seat, 0, hipOffset);
      // Roll baseline = the REST pose in THIS view's frame. Without the reset the thighs/arms still carry the previous
      // view's solved pose, so a rolled solve measured against that "rest" reads as ~0 deg and the round-3 bug slips
      // through (round-3 re-review, gate blind spot 1). Reset AFTER placeSeated so the world frame is this view's.
      vrm.humanoid.resetNormalizedPose();
      vrm.scene.updateMatrixWorld(true);
      const bf = bodyFwd(vrm), fl = frontLocal(vrm);
      const pre = {};
      for (const side of ['left', 'right']) {
        const ub = vrm.humanoid.getNormalizedBoneNode(`${side}UpperLeg`), lb = vrm.humanoid.getNormalizedBoneNode(`${side}LowerLeg`);
        const au = vrm.humanoid.getNormalizedBoneNode(`${side}UpperArm`), al = vrm.humanoid.getNormalizedBoneNode(`${side}LowerArm`);
        const ah = vrm.humanoid.getNormalizedBoneNode(`${side}Hand`);
        if (!ub || !lb || !au || !al || !ah) continue;
        pre[side] = {
          tq: ub.getWorldQuaternion(Q()), td: lb.getWorldPosition(V()).sub(ub.getWorldPosition(V())).normalize(),
          aq: au.getWorldQuaternion(Q()), ad: al.getWorldPosition(V()).sub(au.getWorldPosition(V())).normalize(),
          lq: al.getWorldQuaternion(Q()), ld: ah.getWorldPosition(V()).sub(al.getWorldPosition(V())).normalize(),
        };
      }
      seatFit.update(1 / 60, vrm, viewName);
      vrm.scene.updateMatrixWorld(true);
      seatOrient[version][viewName] = {};
      for (const side of ['left', 'right']) {
        const p = pre[side];
        const ub = vrm.humanoid.getNormalizedBoneNode(`${side}UpperLeg`), lb = vrm.humanoid.getNormalizedBoneNode(`${side}LowerLeg`);
        const au = vrm.humanoid.getNormalizedBoneNode(`${side}UpperArm`), al = vrm.humanoid.getNormalizedBoneNode(`${side}LowerArm`), ah = vrm.humanoid.getNormalizedBoneNode(`${side}Hand`);
        if (!p || !ah) continue;
        const hip = ub.getWorldPosition(V()), knee = lb.getWorldPosition(V());
        const thighFront = fl.clone().applyQuaternion(ub.getWorldQuaternion(Q()));
        const thighRoll = rollVsRest(p.tq, p.td, ub.getWorldQuaternion(Q()), knee.clone().sub(hip).normalize());
        const kneecapAhead = thighFront.clone().multiplyScalar(0.04).dot(bf); // the kneecap surface sits ahead of the joint
        ok(thighFront.dot(bf) > 0.5, `${label} ${viewName}: ${side} seated thigh front faces her front (thigh-front . body-forward = ${thighFront.dot(bf).toFixed(3)})`, `thighFront=${thighFront.toArray()}`);
        ok(kneecapAhead > 0.02, `${label} ${viewName}: ${side} seated kneecap sits ahead of the knee (${kneecapAhead.toFixed(3)} m)`, `kneecapAhead=${kneecapAhead}`);
        ok(thighRoll < 30, `${label} ${viewName}: ${side} seated thigh keeps its rest roll (roll ${thighRoll.toFixed(1)} deg)`, `thighRoll=${thighRoll}`);
        // Only views where SeatFit actually drives the arms (typing/reach) have a seated arm pose to check; in the
        // others the arms keep whatever the previous section left, so comparing them across versions proves nothing.
        if (seatFit.last && seatFit.last.hands && seatFit.last.hands[side]) {
          const armFront = fl.clone().applyQuaternion(au.getWorldQuaternion(Q())).dot(bf);
          const fore = ah.getWorldPosition(V()).sub(al.getWorldPosition(V())).normalize();
          const upper = al.getWorldPosition(V()).sub(au.getWorldPosition(V())).normalize();
          const bend = fore.clone().addScaledVector(upper, -fore.dot(upper)).normalize().dot(bf);
          // The FOREARM's own twist about its axis, vs its OWN rest pose in this view (the position-only `bend` above
          // passed under the round-2 mutant: a 180-degree-rolled forearm still bends toward the same side). Baseline
          // is p.lq/p.ld (lower arm), not p.aq/p.ad (upper arm) -- it must be the same bone's rest orientation.
          const elbowRoll = rollVsRest(p.lq, p.ld, al.getWorldQuaternion(Q()), fore);
          ok(armFront > 0.2, `${label} ${viewName}: ${side} seated arm front points the same way as VRM 1.0 (arm-front . body-forward = ${armFront.toFixed(3)})`, `armFront=${armFront}`);
          ok(elbowRoll < 60, `${label} ${viewName}: ${side} seated forearm keeps its rest roll (elbow roll ${elbowRoll.toFixed(1)} deg)`, `elbowRoll=${elbowRoll}`);
          seatOrient[version][viewName][side] = { armFront, bend, elbowRoll };
        }
      }
      const authored = new THREE.Vector3(Math.sin(seat.rotYDeg * Math.PI / 180), 0, Math.cos(seat.rotYDeg * Math.PI / 180));
      for (const side of ['left', 'right']) {
        const f = vrm.humanoid.getNormalizedBoneNode(`${side}Foot`), t = vrm.humanoid.getNormalizedBoneNode(`${side}Toes`);
        if (!f || !t) continue;
        const dir = t.getWorldPosition(V()).sub(f.getWorldPosition(V())).setY(0).normalize();
        ok(dir.dot(authored) > 0.9, `${label} ${viewName}: ${side} seated foot points forward (toes . facing = ${dir.dot(authored).toFixed(3)})`, `footDir=${dir.toArray()}`);
      }
      // SeatFit's own two-bone solve (the review's seat-fit.js:451-455): reachable target, current (scaled) lengths
      const arm = rig.arms.left;
      if (arm) {
        const s = vrm.scene.scale.x, L1 = arm.L1 * s, L2 = arm.L2 * s;
        const target = arm.upper.getWorldPosition(V()).addScaledVector(V().set(0, -0.3, 1).normalize(), 0.85 * (L1 + L2));
        solveTwoBone(arm.upper, arm.lower, L1, L2, arm.restInvUpper, arm.restInvLower, target,
          V().set(1, -0.4, -0.2), rig.restBody, rig.restBodyInv, rig.restBase);
        arm.upper.updateMatrixWorld(true);
        const miss = arm.hand.getWorldPosition(V()).distanceTo(target);
        ok(miss <= TOL, `${label} ${viewName}: seated two-bone IK hits its target (miss ${miss.toFixed(4)} m)`, `miss=${miss}`);
      }
    }
    rig.seated = false;

    // (a2) ORIENTATION at the bind placement. Positions alone did not catch the round-3 bug: on VRM 0.x every solved
    // bone hit its target but came out rolled 180 degrees about its own axis, because the rest bend reference was
    // captured in the ROOT frame (whose +Z is her BACK under the flip). Two exercises whose twist-free answer is
    // known: an arm curl that holds the upper arm at its rest direction, and a knee bend that kicks the foot back.
    vrm.scene.scale.setScalar(1); // the seated views above left a 1.08-1.15 scale on the scene
    placeZumi(vrm.scene, null);
    vrm.scene.updateMatrixWorld(true);
    const rigO = new Rig(vrm);
    const bf0 = bodyFwd(vrm), fl = frontLocal(vrm);
    orient[version] = {};
    // The pre-fix (0ee30ee) solver, reconstructed exactly as the round-3 re-review's mutant: force the solve frame to
    // the ROOT frame (restBody = restRoot, base = identity) while the rest frames stay captured. VRM 1.0 has
    // body == root and base == identity, so this IS 0ee30ee's math: the current solve must reproduce its world
    // quaternions to 1e-6 (the "VRM 1.0 numerically unchanged" claim, as an equality instead of a roll threshold).
    // On VRM 0.x the same comparison must DIFFER -- that is the round-2 math the round-3 fix replaced.
    const legacyRig = () => {
      const r = new Rig(vrm);
      r.restBody = r.restRoot.clone();
      r.restBodyInv = r.restBody.clone().invert();
      r.restBase = new THREE.Quaternion();
      return r;
    };
    // q and -q are the same rotation: fold the sign before comparing components.
    const quatDiff = (a, b) => {
      const s = a.dot(b) < 0 ? -1 : 1;
      return Math.max(Math.abs(a.x - s * b.x), Math.abs(a.y - s * b.y), Math.abs(a.z - s * b.z), Math.abs(a.w - s * b.w));
    };
    const quatAngleDeg = (a, b) => a.angleTo(b) * 180 / Math.PI;
    const armO = rigO.arms.left;
    if (armO) {
      const S = armO.upper.getWorldPosition(V());
      const q0 = armO.upper.getWorldQuaternion(Q());
      const d0 = armO.lower.getWorldPosition(V()).sub(S).normalize();
      const q0l = armO.lower.getWorldQuaternion(Q());
      const d0l = armO.hand.getWorldPosition(V()).sub(armO.lower.getWorldPosition(V())).normalize();
      const target = armO.lower.getWorldPosition(V()).addScaledVector(bf0, 0.9 * armO.L2); // wrist in front of the elbow
      const u = target.clone().sub(S).normalize();
      const pole = d0.clone().addScaledVector(u, -u.dot(d0)).normalize(); // hold the upper arm at its rest direction
      const rigL = legacyRig(); // 0ee30ee reference first: constructing it leaves the pose at rest
      rigL.solveArm(rigL.arms.left, target, pole);
      const refUpper = rigL.arms.left.upper.getWorldQuaternion(Q());
      const refLower = rigL.arms.left.lower.getWorldQuaternion(Q());
      vrm.humanoid.resetNormalizedPose();
      vrm.scene.updateMatrixWorld(true);
      rigO.solveArm(armO, target, pole);
      armO.upper.updateMatrixWorld(true);
      const miss = armO.hand.getWorldPosition(V()).distanceTo(target);
      const d1 = armO.lower.getWorldPosition(V()).sub(armO.upper.getWorldPosition(V())).normalize();
      const armRoll = rollVsRest(q0, d0, armO.upper.getWorldQuaternion(Q()), d1);
      const armFront = fl.clone().applyQuaternion(armO.upper.getWorldQuaternion(Q())).dot(bf0);
      // Elbow (forearm) roll: the lower arm's twist about its own axis vs the same rest pose -- the round-2 bug also
      // rolled it ~139 degrees while the bend direction stayed plausible.
      const elbowRoll = rollVsRest(q0l, d0l, armO.lower.getWorldQuaternion(Q()), armO.hand.getWorldPosition(V()).sub(armO.lower.getWorldPosition(V())).normalize());
      const qAngle = Math.max(quatAngleDeg(armO.upper.getWorldQuaternion(Q()), refUpper), quatAngleDeg(armO.lower.getWorldQuaternion(Q()), refLower));
      ok(miss <= TOL && armRoll < 30, `${label}: forward arm curl leaves the upper arm untwisted (roll ${armRoll.toFixed(1)} deg, miss ${miss.toFixed(4)} m)`, `roll=${armRoll} miss=${miss}`);
      ok(elbowRoll < 60, `${label}: forward arm curl leaves the forearm untwisted (elbow roll ${elbowRoll.toFixed(1)} deg)`, `elbowRoll=${elbowRoll}`);
      ok(armFront > 0.5, `${label}: forward arm curl points the upper-arm front at her front (arm-front . body-forward = ${armFront.toFixed(3)})`, `armFront=${armFront}`);
      orient[version].armRoll = armRoll;
      orient[version].elbowRoll = elbowRoll;
      orient[version].armFront = armFront;
      orient[version].armUpper = armO.upper.getWorldQuaternion(Q());
      orient[version].armLower = armO.lower.getWorldQuaternion(Q());
      orient[version].armQAngle = qAngle;
    }
    const legO = rigO.legs.left;
    if (legO) {
      vrm.humanoid.resetNormalizedPose(); // the arm solve above must not leak into the leg rest baseline
      vrm.scene.updateMatrixWorld(true);
      const q0 = legO.upper.getWorldQuaternion(Q());
      const d0 = legO.lower.getWorldPosition(V()).sub(legO.upper.getWorldPosition(V())).normalize();
      const target = legO.footRest.clone().addScaledVector(bf0, -0.30).addScaledVector(V().set(0, 1, 0), 0.28); // heel back/up
      const rigL = legacyRig(); // pre-fix frame choice (resets the pose)
      rigL.solveArm(rigL.legs.left, target, bf0);
      const refUpper = rigL.legs.left.upper.getWorldQuaternion(Q());
      const refLower = rigL.legs.left.lower.getWorldQuaternion(Q());
      vrm.humanoid.resetNormalizedPose();
      vrm.scene.updateMatrixWorld(true);
      rigO.solveArm(legO, target, bf0);
      legO.upper.updateMatrixWorld(true);
      const miss = legO.foot.getWorldPosition(V()).distanceTo(target);
      const d1 = legO.lower.getWorldPosition(V()).sub(legO.upper.getWorldPosition(V())).normalize();
      const thighRoll = rollVsRest(q0, d0, legO.upper.getWorldQuaternion(Q()), d1);
      const kneecap = fl.clone().applyQuaternion(legO.upper.getWorldQuaternion(Q())).dot(bf0);
      const qAngle = Math.max(quatAngleDeg(legO.upper.getWorldQuaternion(Q()), refUpper), quatAngleDeg(legO.lower.getWorldQuaternion(Q()), refLower));
      ok(miss <= TOL && thighRoll < 30, `${label}: knee bend leaves the thigh untwisted (roll ${thighRoll.toFixed(1)} deg, miss ${miss.toFixed(4)} m)`, `roll=${thighRoll} miss=${miss}`);
      ok(kneecap > 0.5, `${label}: knee bend keeps the kneecap forward (thigh-front . body-forward = ${kneecap.toFixed(3)})`, `kneecap=${kneecap}`);
      orient[version].thighRoll = thighRoll;
      orient[version].kneecap = kneecap;
      orient[version].legUpper = legO.upper.getWorldQuaternion(Q());
      orient[version].legLower = legO.lower.getWorldQuaternion(Q());
      orient[version].legQAngle = qAngle;
    }
    // Revert detector for VRM 0.x: if the app's solve went back to the pre-fix root frame, the reference solve above
    // would BE the shipped solve (0 deg apart) and this fails. (On VRM 1.0 the two frames coincide by definition, so
    // the real pin there is the recorded 0ee30ee quaternions below.)
    const qAngle = Math.max(orient[version].armQAngle ?? 0, orient[version].legQAngle ?? 0);
    if (version === '0') ok(qAngle > 30, `${label}: the pre-fix root-frame solve differs from the shipped one (max ${qAngle.toFixed(1)} deg) -- the exercises measure the frame change`, `qAngle=${qAngle}`);
    // The VRM 1.0 equality pin: the recorded 0ee30ee world quaternions, per solved bone, tolerance 1e-6.
    const rec = RECORDED_0EE30EE[path.basename(file)];
    if (version === '1') {
      const got = orient[version];
      if (!rec) console.log(`SKIP ${label}: no recorded 0ee30ee quaternions for this model (roll/front asserts still ran)`);
      else if (!got.armUpper || !got.legUpper) console.log(`SKIP ${label}: left arm/leg chain missing, cannot compare the recorded quaternions`);
      else {
        const rc = (a) => new THREE.Quaternion().fromArray(a);
        const dq = Math.max(
          quatDiff(got.armUpper, rc(rec.armUpper)), quatDiff(got.armLower, rc(rec.armLower)),
          quatDiff(got.legUpper, rc(rec.legUpper)), quatDiff(got.legLower, rc(rec.legLower)));
        ok(dq <= 1e-6, `${label}: arm AND knee solves equal the recorded 0ee30ee quaternions (max |dq| = ${dq.toExponential(2)})`, `dq=${dq}`);
      }
    }

    // (d) float mode + the hologram panel beside her
    const talkSeat = roomJson.views.talk.zumi_seat;
    placeFloat(engine, talkSeat, FLOAT);
    vrm.scene.updateMatrixWorld(true);
    const authored = new THREE.Vector3(Math.sin(talkSeat.rotYDeg * Math.PI / 180), 0, Math.cos(talkSeat.rotYDeg * Math.PI / 180));
    const floatDot = modelForward(vrm).dot(authored);
    ok(floatDot > 0.99, `${label}: float mode faces the authored seat direction (forward . authored = ${floatDot.toFixed(3)})`, `forward=${modelForward(vrm).toArray()}`);
    const holoDot = holoOffset(vrm.scene, FLOAT.scale).dot(authored);
    ok(holoDot > 0.2, `${label}: hologram panel sits in FRONT of her (offset . authored = ${holoDot.toFixed(3)})`, `offset=${holoOffset(vrm.scene, FLOAT.scale).toArray()}`);
  }
  ok(ikMiss['0'] <= ikMiss['1'] + 1e-6,
    `VRM 0.x arm IK error (${ikMiss['0'].toFixed(4)} m) <= VRM 1.0 (${ikMiss['1'].toFixed(4)} m)`,
    `v0=${ikMiss['0']} v1=${ikMiss['1']}`);
  // Cross-version: the seated arm/elbow orientation on VRM 0.x must land on the SAME side as VRM 1.0 (the round-3
  // bug put it 180 degrees away: arm-front +0.41 on VRM 1.0 vs -0.32 on VRM 0.x).
  const sameWay = (a, b) => Math.sign(a) === Math.sign(b) && Math.abs(a - b) < 0.25;
  for (const viewName of views) for (const side of ['left', 'right']) {
    const a = seatOrient['1'] && seatOrient['1'][viewName] && seatOrient['1'][viewName][side];
    const b = seatOrient['0'] && seatOrient['0'][viewName] && seatOrient['0'][viewName][side];
    if (!a || !b) continue;
    ok(sameWay(a.armFront, b.armFront), `seated ${viewName} ${side}: arm front points the same way on VRM 0.x and 1.0 (${b.armFront.toFixed(2)} vs ${a.armFront.toFixed(2)})`, `v0=${b.armFront} v1=${a.armFront}`);
    ok(sameWay(a.bend, b.bend), `seated ${viewName} ${side}: elbow bend points the same way as VRM 1.0 (${b.bend.toFixed(2)} vs ${a.bend.toFixed(2)})`, `v0=${b.bend} v1=${a.bend}`);
  }
  // VRM 1.0 regression: its bind-placement solves must equal the recorded 0ee30ee quaternions, checked per bone above
  // at 1e-6. That per-model assert is the gate; this line only makes the absence of any VRM 1.0 pin visible.
  if (orient['1'] && !orient['1'].armUpper) ok(false, 'VRM 1.0: bind-placement quaternion pin did not run', JSON.stringify(orient['1']));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
