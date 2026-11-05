// Shared plain-Node harness for the T-31 0.2.7 "arms locked" checks (DIAG 20-10 §5 steps 1-2): one real VRM
// loaded headlessly (check-rig.mjs / check-idle-life.mjs's pattern), the real gesture Catalog read straight off
// disk, a real ReflexEngine, and a fake clock shared by performance.now() and the GesturePlayer -- so 15-40 s
// idle schedules and 5-minute sessions run in milliseconds. No Electron, no window, no network.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ownerPath } from './owner-paths.mjs';

// three's GLTFLoader decodes embedded textures with createImageBitmap; geometry and skeleton are all this needs.
globalThis.self = globalThis;
globalThis.window = globalThis;
globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });

const THREE = await import('three');
const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
const { VRMLoaderPlugin, VRMUtils } = await import('@pixiv/three-vrm');
const { ReflexEngine, ClipLayer, Catalog } = await import('../../src/renderer/reflex/index.js');
const { GesturePlayer } = await import('../../src/renderer/reflex/player.js');

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// One fake clock for everything that schedules (engine.lastInputAt / nextBoredAt / nextVarietyAt and the player).
export const clock = { t: 0 };

export function modelFromArgs() {
  const argAt = process.argv.indexOf('--model');
  return (argAt >= 0 ? process.argv[argAt + 1] : null) || process.env.ZUMI_TEST_MODEL || ownerPath('testModel', 'local/test-model.vrm');
}

// Deterministic LCG, never Math.random (check-variety.mjs's convention).
function makeRandom(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 0x100000000);
}

// Real gesture catalog, straight off disk -- the same JSON check-gestures.mjs validates, read via fs because
// Catalog.load() uses fetch() and there is no window here.
function loadCatalogSync(random) {
  const dir = path.join(ROOT, 'src', 'renderer', 'reflex', 'gestures');
  const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  const catalog = new Catalog(random);
  for (const name of index.triggers) {
    const def = JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8'));
    catalog.triggers.set(name, { name, labelVi: def.labelVi, state: Boolean(def.state), variants: def.variants });
  }
  return catalog;
}

/** Loads the VRM once and points performance.now() at the fake clock (after the load: the loader may use the
 *  real clock). Returns { THREE, vrm, camera } for makeFreshEngine(). */
export async function loadHarness(modelPath) {
  if (!fs.existsSync(modelPath)) throw new Error(`missing model: ${modelPath}`);
  const loader = new GLTFLoader();
  loader.register((p) => new VRMLoaderPlugin(p));
  const buf = fs.readFileSync(modelPath);
  const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const gltf = await loader.parseAsync(bytes.slice(0), '');
  const vrm = gltf.userData.vrm;
  if (!vrm) throw new Error(`not a VRM: ${modelPath}`);
  VRMUtils.removeUnnecessaryVertices(gltf.scene);
  VRMUtils.combineSkeletons(gltf.scene);
  if (vrm.meta && vrm.meta.metaVersion === '0') VRMUtils.rotateVRM0(vrm);
  const camera = new THREE.PerspectiveCamera(28, 1280 / 742, 0.05, 50);
  camera.position.set(0, 1.4, 3);
  camera.lookAt(0, 1.3, 0);
  camera.updateMatrixWorld();
  performance.now = () => clock.t;
  return { THREE, vrm, camera };
}

/** A fresh real engine bound to the shared VRM, its player on the fake clock. */
export function makeFreshEngine(vrm, camera, seed) {
  const random = makeRandom(seed);
  const catalog = loadCatalogSync(random);
  const engine = new ReflexEngine({ catalog, clips: new ClipLayer(), random });
  engine.bind(vrm, camera);
  engine.autoIdle = true;
  engine.player = new GesturePlayer({ random, clipAvailable: () => false, now: () => clock.t });
  engine.player.onFollow = (f) => { engine.follow = { ...f }; };
  return { engine, catalog };
}

/** Every reaction trigger name, in order. */
export function watchReactions(engine) {
  const events = [];
  engine.on('reaction', (info) => events.push(info.trigger));
  return { events, count: (name) => events.filter((e) => e === name).length };
}

export function reporter() {
  let pass = 0, fail = 0;
  return {
    ok(cond, name, detail = '') { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); } },
    finish() { console.log(`${pass + fail} checks, ${pass} pass, ${fail} fail`); process.exit(fail ? 1 : 0); },
  };
}
