// Gesture targets face FORWARD on both VRM versions, headless in Node (no Electron, no window).
//   npm run check:gesture-forward [-- --model <a.vrm> --model <b.vrm> ...]   (or ZUMI_TEST_MODELS, ';'-separated)
// A VRM 0.x model carries a 180-degree base flip on its normalized bones (model-facing.js), so a target built from the
// raw bone axes lands BEHIND the body and on the wrong side (T-31 review round 2, 22-10: CoolTiger chest z -0.206 vs
// +0.186 on VRM 1.0). For every reach target in the catalog (schema.js REACH_TARGETS, plus the seated rest), on
// every model, for both hands, this resolves the real Rig.resolve() wrist target and checks, in the BODY frame
// (+X her left, +Y up, +Z her front -- model-facing.js bodyOrientation) relative to that hand's own shoulder:
//   F  front targets sit in front of the shoulder line (body z > 0). Targets that are not frontal by design
//      (hip, overhead, the sideways dir points) are exempt from F only.
//   S  side/parity: for every X/Z component that is clearly non-zero on the VRM 1.0 reference, no other model lands
//      clearly on the opposite side, and a left hand's target lies on the opposite lateral side from the right hand's.
//   H  hand direction: after the real solveArms() (standing rest and seated rest), the fingers (hand -> middle
//      proximal) point the same way as the forearm (elbow -> hand): dot > 0. A hand built without the base flip is
//      folded back ~150 degrees at the wrist on VRM 0.x (T-31 gate review F1, 22-10).
// Exit 0 only when every check passes. At least one VRM 0.x and one VRM 1.0 model are required, or the gate would
// silently test a single convention.
import fs from 'node:fs';
import path from 'node:path';
import { ownerPath } from './lib/owner-paths.mjs';

globalThis.self = globalThis;
globalThis.window = globalThis;
globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });

const THREE = await import('three');
const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
const { VRMLoaderPlugin } = await import('@pixiv/three-vrm');
const { prepareVrm, bodyOrientation } = await import('../src/renderer/model-facing.js');
const { Rig } = await import('../src/renderer/reflex/rig.js');
const { REACH_TARGETS } = await import('../src/renderer/reflex/schema.js');

const DEFAULT_MODELS = [ownerPath('testModel', 'local/test-model.vrm'), ownerPath('vrm0Model', 'local/vrm0-model.vrm')];
const fromArgs = process.argv.flatMap((a, i) => (a === '--model' && process.argv[i + 1] ? [process.argv[i + 1]] : []));
const fromEnv = process.env.ZUMI_TEST_MODELS ? process.env.ZUMI_TEST_MODELS.split(';').filter(Boolean) : [];
const modelPaths = fromArgs.length ? fromArgs : fromEnv.length ? fromEnv : DEFAULT_MODELS;

// Targets that are not frontal by design: hip (waist side, slightly behind), overhead (straight up), and the sideways
// screen-direction points. Their sign pattern is still held by S.
const NOT_FRONTAL = new Set(['hip', 'overhead', 'point-screen-right', 'point-screen-left', 'point-up']);
// Targets that name a screen/world side rather than the hand's own side: both hands reach the same way, so the
// left/right mirror check does not apply (S against the VRM 1.0 reference still does).
const SAME_SIDE = new Set(['point-screen-right', 'point-screen-left', 'point-sidebar']);
const TARGETS = [...REACH_TARGETS, 'seatedRest'];
const EPS_FRONT = 0.004; // m: 'in front' must clear numerical noise (overhead sits only ~2 cm ahead of the shoulder)
const SIGN_MIN = 0.06; // x arm length: a reference component smaller than this carries no side information
const WRONG_SIDE_MIN = 0.03; // x arm length: how far past the shoulder line a sign mismatch must be to count

async function load(file) {
  const buf = fs.readFileSync(file);
  const loader = new GLTFLoader();
  loader.register((p) => new VRMLoaderPlugin(p));
  const gltf = await loader.parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
  const vrm = gltf.userData.vrm;
  if (!vrm) throw new Error(`${file}: not a VRM`);
  prepareVrm(gltf, vrm);
  vrm.scene.updateMatrixWorld(true);
  return vrm;
}

// body-frame wrist offset from the hand's own shoulder, in metres, for every target and side
function offsets(vrm) {
  const rig = new Rig(vrm);
  const bInv = bodyOrientation(vrm.scene).invert();
  const out = {};
  for (const name of TARGETS) {
    for (const side of ['left', 'right']) {
      const arm = rig.arms[side];
      vrm.humanoid.resetNormalizedPose();
      vrm.scene.updateMatrixWorld(true);
      const pos = new THREE.Vector3(), pole = new THREE.Vector3();
      // 'seatedRest' is a REACH preset the seated fallback uses; every other name is a catalog target
      rig.resolve(side, name === 'seatedRest' ? 'seatedRest' : name, 0, pos, pole, 1, null);
      const d = pos.sub(arm.upper.getWorldPosition(new THREE.Vector3())).applyQuaternion(bInv);
      out[`${name}|${side}`] = { x: d.x, y: d.y, z: d.z, A: arm.A };
    }
  }
  return out;
}

// forearm . finger direction after the real solve, for the standing rest and the seated rest, both hands
function handFold(vrm) {
  const rig = new Rig(vrm);
  const out = {};
  for (const seated of [false, true]) {
    rig.seated = seated;
    vrm.humanoid.resetNormalizedPose();
    vrm.scene.updateMatrixWorld(true);
    rig.solveArms([]);
    vrm.scene.updateMatrixWorld(true);
    for (const side of ['left', 'right']) {
      const arm = rig.arms[side];
      const mp = rig.fingers[side].middle[0];
      const el = arm.lower.getWorldPosition(new THREE.Vector3()), ha = arm.hand.getWorldPosition(new THREE.Vector3());
      const fore = ha.clone().sub(el).normalize(), fing = mp.getWorldPosition(new THREE.Vector3()).sub(ha).normalize();
      out[`${seated ? 'seated' : 'rest'}|${side}`] = fore.dot(fing);
    }
  }
  return out;
}

const models = [];
for (const file of modelPaths) {
  if (!fs.existsSync(file)) { console.error(`check:gesture-forward: model not found: ${file}`); process.exit(2); }
  const vrm = await load(file);
  models.push({ name: path.basename(file), v0: vrm.meta && vrm.meta.metaVersion === '0', off: offsets(vrm), fold: handFold(vrm) });
}
const ref = models.find((m) => !m.v0);
if (!ref || !models.some((m) => m.v0)) {
  console.error('check:gesture-forward: need at least one VRM 0.x and one VRM 1.0 model (pass --model <file.vrm> for each)');
  process.exit(2);
}

let bad = 0, checks = 0;
const fail = (msg) => { bad++; console.log(`FAIL ${msg}`); };
const f3 = (v) => (v >= 0 ? '+' : '') + v.toFixed(3);
for (const m of models) {
  const before = bad;
  for (const name of TARGETS) {
    for (const side of ['left', 'right']) {
      const k = `${name}|${side}`, o = m.off[k], r = ref.off[k];
      const tag = `${m.name} (VRM ${m.v0 ? '0.x' : '1.0'}) ${name}/${side}`;
      checks++;
      if (!NOT_FRONTAL.has(name) && !(o.z > EPS_FRONT)) fail(`F ${tag}: target is not in front of the shoulder (body z ${f3(o.z)} m, wanted > 0)`);
      if (m === ref) continue;
      for (const c of ['x', 'z']) { // the base flip mirrors X and Z only; Y (up) depends on head/neck proportions
        if (Math.abs(r[c]) / r.A < SIGN_MIN) continue;
        checks++;
        // wrong side = opposite sign AND clearly off the shoulder line (a hand that merely lands on it, as a narrower
        // waist does for 'hip', is proportions, not a flip)
        if (Math.sign(o[c]) !== Math.sign(r[c]) && Math.abs(o[c]) / o.A >= WRONG_SIDE_MIN) fail(`S ${tag}: body ${c} ${f3(o[c])} m, but ${f3(r[c])} m on ${ref.name} (VRM 1.0)`);
      }
    }
    // the two hands of a crossing target (clasp, chest, ...) are mirrors: left offset x and right offset x differ in sign
    // wherever the target has a lateral component of its own
    const l = m.off[`${name}|left`], rt = m.off[`${name}|right`];
    if (Math.abs(l.x) / l.A > SIGN_MIN && Math.abs(rt.x) / rt.A > SIGN_MIN && !SAME_SIDE.has(name)) {
      checks++;
      if (Math.sign(l.x) === Math.sign(rt.x)) fail(`S ${m.name} ${name}: left and right hands both reach to the same lateral side (x ${f3(l.x)} / ${f3(rt.x)})`);
    }
  }
  for (const [k, dot] of Object.entries(m.fold)) {
    checks++;
    if (!(dot > 0)) fail(`H ${m.name} (VRM ${m.v0 ? '0.x' : '1.0'}) ${k.replace('|', '/')}: fingers fold back against the forearm (forearm . fingers ${f3(dot)}, wanted > 0)`);
  }
  console.log(`${bad === before ? 'PASS' : 'FAIL'} ${m.name} (VRM ${m.v0 ? '0.x' : '1.0'}): ${TARGETS.length} targets x 2 hands`);
}
console.log(`check:gesture-forward ${bad ? `${bad} FAILED` : 'all passed'} · ${checks} checks · ${models.length} model(s)`);
process.exit(bad ? 1 : 0);
