// Unit test for scripts/seat-offset.mjs's computeRootDrop -- pure function, no model/engine/renderer
// needed for the first section below. Calibrated against zumi-v3.1.vrm's measured standing hip height
// (see scripts/make-sit-pose.mjs console output: hips bone world Y at rest = 0.9213 m).
//
// Second section (coordinator QC, 2026-10-03): computeRootDrop(A, B) is a generic "drop the root so
// landmark A's current height becomes target height B" -- anchoring A/B on HIPS (seated hip height vs.
// nominal seat height) is right for "the pelvis should land on the seat", but was found to leave the
// ankle 2.3cm and the toe 8.6cm through the floor at the 0.45m stand-in seat height, because this pose's
// hip-to-ankle drop doesn't exactly match that nominal seat height. Anchoring A/B on the ANKLE instead --
// A = the ankle's own seated-pose height (pre-drop), B = this model's own standing ankle-to-floor
// clearance -- reproduces the standing foot/floor relationship exactly (the pose's foot keeps the same
// world orientation as standing by construction) and is what actually lands the soles on the floor. This
// section drives the real model + the real seated clip (same assets the renders use) and asserts it.
//   node scripts/check-seat-offset.mjs [--model <file.vrm>]
import { computeRootDrop } from './seat-offset.mjs';
import { ownerPath } from './lib/owner-paths.mjs';

let bad = 0;
function check(label, got, want, eps = 1e-6) {
  const ok = Math.abs(got - want) <= eps;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: got ${got}, want ${want}`);
  if (!ok) bad++;
}
function checkThrows(label, fn) {
  let threw = false;
  try { fn(); } catch { threw = true; }
  console.log(`${threw ? 'PASS' : 'FAIL'} ${label}: expected throw`);
  if (!threw) bad++;
}

const STANDING_HIP_HEIGHT_M = 0.9213; // measured on zumi-v3.1 (see make-sit-pose.mjs)

check('seat at the coordinator\'s stand-in height (0.45 m)', computeRootDrop(STANDING_HIP_HEIGHT_M, 0.45), 0.4713);
check('seat height 0 (floor) drops the root by the full standing hip height', computeRootDrop(STANDING_HIP_HEIGHT_M, 0), STANDING_HIP_HEIGHT_M);
check('seat exactly at standing hip height needs no drop', computeRootDrop(STANDING_HIP_HEIGHT_M, STANDING_HIP_HEIGHT_M), 0);
check('a seat TALLER than standing hip height lifts the root (negative drop)', computeRootDrop(STANDING_HIP_HEIGHT_M, 1.2), STANDING_HIP_HEIGHT_M - 1.2);
check('scales with a different model\'s hip height (e.g. a shorter model, 0.8 m)', computeRootDrop(0.8, 0.45), 0.35);

checkThrows('rejects a non-positive standing hip height', () => computeRootDrop(0, 0.45));
checkThrows('rejects a negative standing hip height', () => computeRootDrop(-0.9, 0.45));
checkThrows('rejects a negative seat height', () => computeRootDrop(STANDING_HIP_HEIGHT_M, -0.1));
checkThrows('rejects NaN', () => computeRootDrop(NaN, 0.45));

// ---------- integration: the real model + the real seated clip, soles must land within ±1cm of the floor ----------
{
  globalThis.self = globalThis;
  globalThis.window = globalThis;
  globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
  globalThis.ProgressEvent = class ProgressEvent { constructor(type, init) { this.type = type; Object.assign(this, init); } };
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const THREE = await import('three');
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const { VRMLoaderPlugin } = await import('@pixiv/three-vrm');
  const { prepareVrm } = await import('../src/renderer/model-facing.js');
  const { VRMAnimationLoaderPlugin, createVRMAnimationClip } = await import('@pixiv/three-vrm-animation');

  const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : def; };
  const modelPath = path.resolve(arg('model', process.env.ZUMI_TEST_MODEL || ownerPath('testModel', 'local/test-model.vrm')));

  const buf = fs.readFileSync(modelPath);
  const loader = new GLTFLoader(); loader.register((p) => new VRMLoaderPlugin(p));
  const gltf = await loader.parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
  const vrm = gltf.userData.vrm;
  prepareVrm(gltf, vrm); // the app's load path: clean-up + the VRM 0.x flip + the base-orientation capture Rig's IK needs
  vrm.scene.updateMatrixWorld(true);
  const V = () => new THREE.Vector3();
  const nb = (n) => vrm.humanoid.getNormalizedBoneNode(n);
  const pos = (n) => nb(n).getWorldPosition(V());

  const restAnkleY = pos('leftFoot').y, restToeY = pos('leftToes').y; // standing ankle/toe-to-floor clearance, before any seated pose is applied

  const vrmaBuf = fs.readFileSync(path.join(ROOT, 'assets', 'clips', 'sit-idle.vrma'));
  const vrmaLoader = new GLTFLoader(); vrmaLoader.register((p) => new VRMAnimationLoaderPlugin(p));
  const vrmaGltf = await vrmaLoader.parseAsync(vrmaBuf.buffer.slice(vrmaBuf.byteOffset, vrmaBuf.byteOffset + vrmaBuf.byteLength), '');
  const sitClip = createVRMAnimationClip(vrmaGltf.userData.vrmAnimations[0], vrm);
  for (const bone of ['leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot']) {
    const node = nb(bone);
    const track = sitClip.tracks.find((t) => t.name === (node.name + '.quaternion'));
    node.quaternion.fromArray(track.values, 0);
  }
  vrm.scene.updateMatrixWorld(true);

  const seatedAnkleY = pos('leftFoot').y, seatedToeY = pos('leftToes').y;
  const drop = computeRootDrop(seatedAnkleY, restAnkleY);
  const ankleAfter = seatedAnkleY - drop, toeAfter = seatedToeY - drop;
  const SOLE_TOL_M = 0.01;
  // "soles on the floor" means the ankle/toe bones return to the SAME height above the floor they have when
  // STANDING flat-footed (restAnkleY/restToeY, both ~0.05-0.11m, not 0 -- the bones sit inside the shoe, not
  // at the ground plane itself). That standing relationship IS "flat on the floor"; 0 would be wrong here.
  check(`ankle-anchored drop lands the ankle within ${SOLE_TOL_M * 100}cm of its standing (flat-footed) height (${modelPath.split(/[\\/]/).pop()})`, +ankleAfter.toFixed(4), +restAnkleY.toFixed(4), SOLE_TOL_M);
  check(`ankle-anchored drop lands the toe within ${SOLE_TOL_M * 100}cm of its standing (flat-footed) height (${modelPath.split(/[\\/]/).pop()})`, +toeAfter.toFixed(4), +restToeY.toFixed(4), SOLE_TOL_M);
}

console.log(bad ? `${bad} check(s) failed` : 'all checks passed');
process.exit(bad ? 1 : 0);
