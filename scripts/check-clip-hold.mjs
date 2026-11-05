// Regression check for the ClipLayer.sample() decay bug (fixed in src/renderer/reflex/clips.js): drives
// assets/clips/sit-idle.vrma through the REAL ClipLayer (action()/sample()/blend(), the exact production
// code path a built-in clip uses) inside a REAL ReflexEngine, for 300 frames, and asserts the 6 leg bones
// still match the clip's own authored quaternions at frames 1, 60 and 300 -- i.e. the pose HOLDS, it does
// not decay to identity after the first sampled frame the way it did before the fix.
//
// Root cause (see clips.js's comment on the old resetNormalizedPose() calls for the full writeup):
// THREE.AnimationMixer's PropertyMixer snapshots each bound property's "original" value once, at the
// clip action's first play(), not on every update(); an external vrm.humanoid.resetNormalizedPose() call
// positioned anywhere between two mixer.update() calls permanently corrupts that cached binding, so every
// update() after it silently re-applies identity -- no error, no warning. ClipLayer.sample() used to call
// resetNormalizedPose() twice per invocation (every frame), so only a clip's very first sampled frame was
// ever correct.
//
// Node can't fetch a local .vrma by URL (GLTFLoader.loadAsync() needs http(s), Node's fetch has no file://
// support -- confirmed directly), so this script does what every other check-*.mjs in this repo does for
// the model file: read the bytes with fs and parse them, then seed ClipLayer's OWN cache with the already
// -parsed {kind, data} the SAME way ClipLayer.load() would once its own fetch resolved. Everything AFTER
// that point -- action(), sample(), blend(), the mixer, the envelope/weight math -- is the real, unmodified
// production code; nothing about the bug or the fix is Node-vs-browser specific (reproduced identically in
// both; see scripts/sheet-sit-pose.mjs's render, which now drives the same real path over a real fetch).
//
//   npm run check:clip-hold -- [--model <file.vrm>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ownerPath } from './lib/owner-paths.mjs';

globalThis.self = globalThis;
globalThis.window = globalThis;
globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
globalThis.ProgressEvent = class ProgressEvent { constructor(type, init) { this.type = type; Object.assign(this, init); } };
let vclock = 1e6;
Object.defineProperty(globalThis.performance, 'now', { value: () => vclock, configurable: true, writable: true });

const THREE = await import('three');
const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
const { VRMLoaderPlugin } = await import('@pixiv/three-vrm');
const { prepareVrm } = await import('../src/renderer/model-facing.js');
const { VRMAnimationLoaderPlugin, createVRMAnimationClip } = await import('@pixiv/three-vrm-animation');
const { ReflexEngine, ClipLayer, Catalog } = await import('../src/renderer/reflex/index.js');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, def = null) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : def; };
const modelPath = path.resolve(arg('model', process.env.ZUMI_TEST_MODEL || ownerPath('testModel', 'local/test-model.vrm')));
const ANGLE_LIMIT_DEG = 2;

// ---------- model ----------
const buf = fs.readFileSync(modelPath);
const loader = new GLTFLoader();
loader.register((p) => new VRMLoaderPlugin(p));
const gltf = await loader.parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
const vrm = gltf.userData.vrm;
prepareVrm(gltf, vrm); // the app's load path: clean-up + the VRM 0.x flip + the base-orientation capture Rig's IK needs
vrm.scene.updateMatrixWorld(true);

// ---------- the clip, parsed once -- gives both the cache entry AND the "authored" quaternions to compare against ----------
const clipPath = path.join(ROOT, 'assets', 'clips', 'sit-idle.vrma');
const vrmaBuf = fs.readFileSync(clipPath);
const vrmaLoader = new GLTFLoader();
vrmaLoader.register((p) => new VRMAnimationLoaderPlugin(p));
const vrmaGltf = await vrmaLoader.parseAsync(vrmaBuf.buffer.slice(vrmaBuf.byteOffset, vrmaBuf.byteOffset + vrmaBuf.byteLength), '');
const vrmAnimation = vrmaGltf.userData.vrmAnimations[0];
const LEG_BONES = ['leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot'];
const authored = {};
{
  const refClip = createVRMAnimationClip(vrmAnimation, vrm);
  for (const bone of LEG_BONES) {
    const node = vrm.humanoid.getNormalizedBoneNode(bone);
    const track = refClip.tracks.find((t) => t.name === (node.name + '.quaternion'));
    authored[bone] = new THREE.Quaternion().fromArray(track.values, 0);
  }
}

// ---------- real ClipLayer, real ReflexEngine ----------
const clips = new ClipLayer();
clips.setAvailable([{ name: 'sit-idle', url: 'unused (see header comment)' }]);
clips.cache.set('sit-idle', Promise.resolve({ kind: 'vrma', data: vrmAnimation })); // stands in for the resolved fetch

const camera = new THREE.PerspectiveCamera(28, 1280 / 742, 0.05, 50);
const catalog = new Catalog(() => 0.5);
const engine = new ReflexEngine({ catalog, clips, random: () => 0.5 });
engine.bind(vrm, camera);
engine.autoIdle = false;

const FPS = 60, DT = 1 / FPS;
function step() { vclock += 1000 * DT; engine.update(DT); vrm.scene.updateMatrixWorld(true); }

const res = engine.player.play({ id: 'sit-idle-hold-test', sustain: true, clip: { name: 'sit-idle', weight: 1 } });
if (!res.ok) { console.error('FAIL: sit-idle clip failed to queue:', res.errors.join('; ')); process.exit(1); }

// one settle step + a microtask flush: action()'s first call is always a pending promise (its own .then()
// resolves async even off an already-resolved cache entry) -- exactly the same one-settle-step pattern
// scripts/sheet-sit-pose.mjs and check-motion-seated.mjs use before trusting any sampled frame.
step();
await new Promise((r) => setTimeout(r, 0));
// past the clip's own 250ms ramp-in envelope (15 frames @ 60Hz) before frame 1 of THIS test's window --
// this test is for HOLD stability (does it decay after the first sampled frame?), not envelope timing.
for (let i = 0; i < 20; i++) step();

const DEGF = 180 / Math.PI;
const angleDeg = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(a.dot(b)))) * DEGF;
const CHECK_AT = [1, 60, 300];
let bad = 0;
const results = {};
for (let f = 1; f <= 300; f++) {
  step();
  if (CHECK_AT.includes(f)) {
    const row = {};
    for (const bone of LEG_BONES) {
      const q = vrm.humanoid.getNormalizedBoneNode(bone).quaternion;
      const d = angleDeg(q, authored[bone]);
      row[bone] = +d.toFixed(2);
      if (d > ANGLE_LIMIT_DEG) bad++;
    }
    results[`frame${f}`] = row;
    const worst = Math.max(...Object.values(row));
    console.log(`${worst <= ANGLE_LIMIT_DEG ? 'PASS' : 'FAIL'} frame ${f}: ${JSON.stringify(row)} (worst ${worst.toFixed(2)} deg, limit ${ANGLE_LIMIT_DEG})`);
  }
}
console.log(`check:clip-hold ${bad ? `${bad} bone-check(s) over ${ANGLE_LIMIT_DEG} deg` : 'all within limit'} across frames ${CHECK_AT.join('/')}`);
process.exit(bad ? 1 : 0);
