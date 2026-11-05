// R4a idle-life: headless Node check (no Electron, no window) for the idle-glance + idle-variety layer added
// to reflex/engine.js's lifeLayer()/idleTimers() (PLAN-R4-lean.md §R4a). Loads a real VRM headlessly (same
// stub trick as check-rig.mjs) and binds a real ReflexEngine + a real gesture Catalog read straight off disk
// (not fetch()), so 'bored'/'poke' below are the real catalog triggers, not fakes -- and replaces the engine's
// GesturePlayer with one on a fake clock, so 15-40 s schedules are proven in milliseconds, not real minutes.
//   npm run check:idle-life -- --model <file.vrm>      (or ZUMI_TEST_MODEL)
// Sections: projectLookTargets() (pure, no VRM) -- idle-variety schedule bounds + resume -- yields (busy /
// typing / speech) -- glance anti-repeat (last-3 window) -- glance duration bounds -- no-room fallback.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ownerPath } from './lib/owner-paths.mjs';

// three's GLTFLoader decodes embedded textures with createImageBitmap; geometry and skeleton are all this needs.
globalThis.self = globalThis;
globalThis.window = globalThis;
globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });

const THREE = await import('three');
const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
const { VRMLoaderPlugin } = await import('@pixiv/three-vrm');
const { prepareVrm } = await import('../src/renderer/model-facing.js');
const { ReflexEngine, ClipLayer, Catalog } = await import('../src/renderer/reflex/index.js');
const { GesturePlayer, ChannelAcc } = await import('../src/renderer/reflex/player.js');
const { projectLookTargets } = await import('../src/renderer/room/room-stage.js');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const argAt = process.argv.indexOf('--model');
const modelPath = (argAt >= 0 ? process.argv[argAt + 1] : null) || process.env.ZUMI_TEST_MODEL || ownerPath('testModel', 'local/test-model.vrm');
if (!fs.existsSync(modelPath)) { console.error(`usage: npm run check:idle-life -- --model <file.vrm> (missing: ${modelPath})`); process.exit(2); }

let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); } };

// Deterministic LCG, never Math.random (check-variety.mjs's convention).
function makeRandom(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 0x100000000);
}

// Real gesture catalog, straight off disk -- the same JSON check-gestures.mjs validates, just read via fs
// instead of Catalog.load()'s fetch() (no window here).
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

// ---------- one real VRM, loaded headlessly (check-rig.mjs's pattern), shared read-only by every engine below ----------
const loader = new GLTFLoader();
loader.register((p) => new VRMLoaderPlugin(p));
const buf = fs.readFileSync(modelPath);
const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const gltf = await loader.parseAsync(bytes.slice(0), '');
const vrm = gltf.userData.vrm;
if (!vrm) { console.error('not a VRM:', modelPath); process.exit(2); }
prepareVrm(gltf, vrm); // the app's load path: clean-up + the VRM 0.x flip + the base-orientation capture Rig's IK needs
const camera = new THREE.PerspectiveCamera(28, 1280 / 742, 0.05, 50);
camera.position.set(0, 1.4, 3);
camera.lookAt(0, 1.3, 0);
camera.updateMatrixWorld();

// A fresh engine bound to the shared vrm, its player's clock replaced by `clock.t` -- every scheduling check
// below drives time itself (no real sleeps), and `engine.trigger()` instances land on the SAME clock, so
// "busy shortly after a reflex starts" is a controlled offset, not a race against the real wall clock.
function freshEngine(seed) {
  const random = makeRandom(seed);
  const engine = new ReflexEngine({ catalog: loadCatalogSync(random), clips: new ClipLayer(), random });
  engine.bind(vrm, camera);
  engine.autoIdle = true;
  const clock = { t: 0 };
  engine.player = new GesturePlayer({ random, clipAvailable: () => false, now: () => clock.t });
  engine.player.onFollow = (f) => { engine.follow = { ...f }; };
  return { engine, clock };
}

// ---------- projectLookTargets(): pure camera-projection math, no VRM needed ----------
{
  const cam = new THREE.PerspectiveCamera(28, 1280 / 742, 0.05, 50);
  cam.position.set(0, 1.4, 3);
  cam.lookAt(0, 1.3, 0);
  cam.updateMatrixWorld();
  const onAxis = { name: 'center', position: new THREE.Vector3(0, 1.3, 0) };
  const left = { name: 'left', position: new THREE.Vector3(-0.6, 1.3, 0) };
  const right = { name: 'right', position: new THREE.Vector3(0.6, 1.3, 0) };
  const proj = projectLookTargets(cam, { children: [onAxis, left, right] });
  ok(proj.length === 3, 'projectLookTargets: one entry per child', String(proj.length));
  ok(Math.abs(proj[0].x) < 0.05 && Math.abs(proj[0].y) < 0.05, 'projectLookTargets: a point on the look-at axis projects near (0,0)', JSON.stringify(proj[0]));
  ok(proj[1].x * proj[2].x < 0, 'projectLookTargets: opposite world-X offsets project to opposite-sign x', JSON.stringify([proj[1], proj[2]]));
  ok(projectLookTargets(cam, null).length === 0, 'projectLookTargets: null anchor -> []');
  ok(projectLookTargets(cam, { children: [] }).length === 0, 'projectLookTargets: anchor with no children -> []');
}

// ---------- idle-variety: schedule bounds (15-40s) + reschedule on its own cadence ----------
{
  const { engine, clock } = freshEngine(10);
  clock.t = 1_000_000;
  engine.lastInputAt = clock.t;
  engine.nextVarietyAt = clock.t + 25_000;
  const fires = [];
  engine.on('reaction', (info) => { if (info.trigger === 'bored') fires.push(clock.t); });

  clock.t = 1_000_000 + 24_000;
  engine.idleTimers(clock.t);
  ok(fires.length === 0, 'idle-variety: does not fire before its scheduled 15-40s window', String(fires.length));

  clock.t = 1_000_000 + 25_001;
  engine.idleTimers(clock.t);
  ok(fires.length === 1, 'idle-variety: fires once the scheduled time arrives while idle', String(fires.length));
  const gap = engine.nextVarietyAt - clock.t;
  ok(gap >= 15_000 && gap <= 40_000, 'idle-variety: reschedules its own next fire 15-40s out', String(gap));
}

// ---------- idle-variety: yields while a one-shot reflex is busy, resumes after ----------
{
  const { engine, clock } = freshEngine(11);
  clock.t = 2_000_000;
  engine.lastInputAt = clock.t;
  engine.nextVarietyAt = clock.t; // ready immediately -- isolates the busy gate as the only variable
  engine.trigger('poke'); // real one-shot: priority 7, interrupt:true -- "busy"
  clock.t += 200; // presence() ramps to ~1 over the envelope's first 150ms
  ok(engine.isBusy(clock.t) >= 0.3, 'setup: a just-triggered one-shot reads busy >= 0.3 shortly after it starts', String(engine.isBusy(clock.t)));
  let fires = 0;
  engine.on('reaction', (info) => { if (info.trigger === 'bored') fires++; });
  engine.idleTimers(clock.t);
  ok(fires === 0, 'idle-variety: yields (does not fire) while a one-shot reflex is busy', String(fires));
}

// ---------- idle-variety: yields while typing, resumes once typing stops ----------
{
  const { engine, clock } = freshEngine(12);
  clock.t = 3_000_000;
  engine.lastInputAt = clock.t;
  engine.nextVarietyAt = clock.t;
  engine.states.set('typing', 'fake-typing-id');
  let fires = 0;
  engine.on('reaction', (info) => { if (info.trigger === 'bored') fires++; });
  engine.idleTimers(clock.t);
  ok(fires === 0, 'idle-variety: yields while the owner is typing', String(fires));
  engine.states.delete('typing');
  engine.idleTimers(clock.t); // gate clears at the same instant -> resumes right away
  ok(fires === 1, 'idle-variety: resumes once typing stops', String(fires));
}

// ---------- idle-variety: yields while Zumi is speaking, resumes once speech stops ----------
{
  const { engine, clock } = freshEngine(13);
  clock.t = 4_000_000;
  engine.lastInputAt = clock.t;
  engine.nextVarietyAt = clock.t;
  engine.setSpeechMouth({ aa: 0.4, ih: 0, ou: 0, ee: 0, oh: 0 });
  let fires = 0;
  engine.on('reaction', (info) => { if (info.trigger === 'bored') fires++; });
  engine.idleTimers(clock.t);
  ok(fires === 0, 'idle-variety: yields while Zumi is speaking', String(fires));
  engine.setSpeechMouth(null);
  engine.idleTimers(clock.t);
  ok(fires === 1, 'idle-variety: resumes once speech stops', String(fires));
}

// ---------- glance: anti-repeat, never the same look_target within the last 3 picks ----------
{
  const { engine, clock } = freshEngine(20);
  clock.t = 5_000_000;
  engine.pointer.at = clock.t - 3_000; // pointer still > 2500ms
  // all |x| >= CENTRE_BAND_NDC (0.15) -- this block tests anti-repeat in isolation; the centre-band rule gets
  // its own dedicated block below.
  engine.setLookTargets([{ name: 'a', x: 0.3, y: 0 }, { name: 'b', x: -0.3, y: 0 }, { name: 'c', x: 0.5, y: 0.3 }, { name: 'd', x: -0.5, y: -0.3 }]);
  const picks = [];
  const acc = new ChannelAcc();
  for (let i = 0; i < 24; i++) {
    acc.reset();
    engine.lifeLayer(acc, clock.t);
    picks.push(engine.life.lookHistory[engine.life.lookHistory.length - 1]);
    clock.t = engine.life.glanceNext + 1; // jump straight past the gap -> forces a fresh pick next call
  }
  ok(picks.length === 24, 'glance: picks a target every cycle', String(picks.length));
  let repeatWithin3 = false;
  for (let i = 1; i < picks.length; i++) if (picks.slice(Math.max(0, i - 3), i).includes(picks[i])) repeatWithin3 = true;
  ok(!repeatWithin3, 'glance: anti-repeat -- never the same look_target within the last 3 picks', JSON.stringify(picks));
}

// ---------- glance: centre-band filter -- a target whose projection is near dead-centre is never eligible ----------
{
  const { engine } = freshEngine(25);
  const targets = [{ name: 'in-band', x: 0.1, y: 0 }, { name: 'in-band-neg', x: -0.14, y: 0 }, { name: 'edge', x: 0.15, y: 0 }, { name: 'out', x: 0.4, y: 0 }];
  engine.setLookTargets(targets);
  const names = engine.lookTargets.map((t) => t.name);
  ok(!names.includes('in-band') && !names.includes('in-band-neg'), 'glance: setLookTargets drops targets inside the centre band (|x| < 0.15)', JSON.stringify(names));
  ok(names.includes('edge') && names.includes('out'), 'glance: setLookTargets keeps targets at/outside the centre band', JSON.stringify(names));
}

// ---------- glance: minimum head yaw (>= 12deg), clamped UP only (never down), sign preserved ----------
{
  const { engine } = freshEngine(26);
  const under = engine.enforceMinYaw(0.2); // ~5deg at this camera's fov -- under the floor
  ok(Math.abs(engine.headYawDeg(under)) >= 12 - 1e-6, 'glance: a target under the yaw floor is pushed up to exactly the floor', `${under} -> ${engine.headYawDeg(under).toFixed(2)}deg`);
  ok(under > 0.2, 'glance: the clamp only ever pushes the magnitude UP', String(under));
  const negUnder = engine.enforceMinYaw(-0.2);
  ok(negUnder < 0 && Math.abs(negUnder - -under) < 1e-9, 'glance: sign is preserved when clamping', String(negUnder));
  const already = engine.enforceMinYaw(0.5); // already > 12deg at this camera's fov
  ok(already === 0.5, 'glance: a target that already clears the floor is left unchanged', String(already));

  // wired into the real glance pick, not just the helper in isolation
  const { engine: engine2, clock } = freshEngine(27);
  clock.t = 10_000_000;
  engine2.pointer.at = clock.t - 3_000;
  engine2.setLookTargets([{ name: 'near', x: 0.2, y: 0 }]); // passes the centre band, under the yaw floor
  engine2.lifeLayer(new ChannelAcc(), clock.t);
  ok(Math.abs(engine2.headYawDeg(engine2.life.glanceTo[0])) >= 12 - 1e-6, 'glance: the real pick path also enforces the yaw floor', `glanceTo=${JSON.stringify(engine2.life.glanceTo)}`);
}

// ---------- glance: duration is 0.6-1.5s ----------
{
  const { engine, clock } = freshEngine(21);
  clock.t = 6_000_000;
  engine.pointer.at = clock.t - 3_000;
  engine.setLookTargets([{ name: 'a', x: 0.3, y: 0 }]);
  engine.lifeLayer(new ChannelAcc(), clock.t);
  const dur = engine.life.glanceUntil - engine.life.glanceFrom;
  ok(dur >= 600 && dur <= 1500, 'glance: duration is 0.6-1.5s', String(dur));
}

// ---------- glance: no room/no look_targets -> falls back to the original random-offset look-around ----------
{
  const { engine, clock } = freshEngine(22);
  clock.t = 7_000_000;
  engine.pointer.at = clock.t - 3_000;
  engine.setLookTargets([]); // no room
  engine.lifeLayer(new ChannelAcc(), clock.t);
  const [gx, gy] = engine.life.glanceTo || [];
  const inRange = gx != null && Math.abs(gx) >= 0.5 && Math.abs(gx) <= 1.2 && gy >= -0.45 && gy <= 0.4;
  ok(inRange, 'glance: no look_targets -> falls back to the pre-R4a random-offset range', JSON.stringify(engine.life.glanceTo));
}

// ---------- glance: yields while typing, resumes once typing stops ----------
{
  const { engine, clock } = freshEngine(23);
  clock.t = 8_000_000;
  engine.pointer.at = clock.t - 3_000;
  engine.states.set('typing', 'x');
  engine.lifeLayer(new ChannelAcc(), clock.t);
  ok(engine.life.gx === 0 && engine.life.gy === 0 && engine.life.glanceUntil === 0, 'glance: yields (no new glance scheduled) while typing', `${engine.life.gx},${engine.life.gy}`);
  engine.states.delete('typing');
  engine.lifeLayer(new ChannelAcc(), clock.t);
  ok(engine.life.glanceTo != null && engine.life.glanceUntil > clock.t, 'glance: resumes once typing stops (schedules a new glance)', String(engine.life.glanceUntil));
}

// ---------- glance: yields while Zumi is speaking ----------
{
  const { engine, clock } = freshEngine(24);
  clock.t = 9_000_000;
  engine.pointer.at = clock.t - 3_000;
  engine.setSpeechMouth({ aa: 0.5, ih: 0, ou: 0, ee: 0, oh: 0 });
  engine.lifeLayer(new ChannelAcc(), clock.t);
  ok(engine.life.gx === 0 && engine.life.gy === 0 && engine.life.glanceUntil === 0, 'glance: yields (no new glance scheduled) while Zumi is speaking', `${engine.life.gx},${engine.life.gy}`);
}

console.log(`${pass + fail} checks, ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
