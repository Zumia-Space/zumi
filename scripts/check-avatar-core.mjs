// T-31-ROOM-live-b P1 part 1: `zumi-avatar-core` -- the VRM load, expression + mouth drive and the idle life + gaze of the
// main-webview avatar, extracted from reflex/engine.js and app.js into src/renderer/avatar-core/ so the SAME code can be
// mounted a second time (the room pack's guest webview, P1 part 2). Headless Node (no Electron, no window), one real VRM
// loaded through the core's own load path. Checks:
//   A. the module is guest-mountable: its import closure holds only three / three-vrm and the reflex schema + player, and
//      nothing of the app (i18n, talk, IPC, Electron, Tauri);
//   B. the main-webview engine runs ON the core (no second copy of idle life or gaze) and keeps its public fields;
//   C. the core drives a bound VRM on its own: mouth, held emotion (incl. `relaxed`), irregular blinks, breathing, gaze
//      follow, idle glances to look targets that yield while she speaks;
//   D. two cores in one realm share no state (the "mounted twice" property);
//   E. app.js loads the avatar through the core (no private GLTFLoader copy left).
//   npm run check:avatar-core -- --model <file.vrm>      (or ZUMI_TEST_MODEL)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ownerPath } from './lib/owner-paths.mjs';

globalThis.self = globalThis;
globalThis.window = globalThis;
globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const argAt = process.argv.indexOf('--model');
const modelPath = (argAt >= 0 ? process.argv[argAt + 1] : null) || process.env.ZUMI_TEST_MODEL || ownerPath('testModel', 'local/test-model.vrm');
if (!fs.existsSync(modelPath)) { console.error(`usage: npm run check:avatar-core -- --model <file.vrm> (missing: ${modelPath})`); process.exit(2); }

let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); } };
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function makeRandom(seed) { // deterministic LCG, never Math.random (check-variety.mjs's convention)
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 0x100000000);
}

// ---------- A. guest-mountable: the import closure of the core ----------
const CORE_DIR = 'src/renderer/avatar-core';
const BARE_OK = new Set(['three', 'three/addons/loaders/GLTFLoader.js', '@pixiv/three-vrm']);
const importsOf = (src) => [...src.matchAll(/(?:^|\n)\s*(?:import|export)\b[^'"\n;]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g)].map((m) => m[1] || m[2]);
const closure = new Map(); // repo-relative file -> source
const bare = new Set();
{
  const queue = [`${CORE_DIR}/index.js`];
  while (queue.length) {
    const rel = queue.shift();
    if (closure.has(rel)) continue;
    if (!fs.existsSync(path.join(ROOT, rel))) { closure.set(rel, ''); continue; }
    const src = read(rel);
    closure.set(rel, src);
    for (const spec of importsOf(src)) {
      if (spec.startsWith('.')) queue.push(path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec)));
      else bare.add(spec);
    }
  }
}
{
  ok(['index.js', 'life-gaze.js', 'pose.js'].every((f) => fs.existsSync(path.join(ROOT, CORE_DIR, f))), 'core: avatar-core/index.js, life-gaze.js and pose.js exist');
  const files = [...closure.keys()];
  const allowedRel = (f) => f.startsWith(`${CORE_DIR}/`) || ['src/renderer/reflex/schema.js', 'src/renderer/reflex/player.js', 'src/renderer/model-facing.js'].includes(f);
  ok(files.length > 0 && files.every(allowedRel), 'core: the import closure holds only avatar-core, reflex/schema, reflex/player and model-facing', JSON.stringify(files));
  ok([...bare].every((b) => BARE_OK.has(b)), 'core: the only bare imports are three, its GLTFLoader and three-vrm', JSON.stringify([...bare]));
  const app = /window\.zumi|ipcRenderer|require\(['"]electron['"]\)|__TAURI|\bi18n\b|talk\/|ownertext/;
  const leaks = files.filter((f) => app.test(closure.get(f).replace(/\/\/[^\n]*/g, '')));
  ok(leaks.length === 0, 'core: no file of the closure touches the app (IPC, Electron, Tauri, i18n, talk)', JSON.stringify(leaks));
}

// The core itself (everything below needs it).
let core1 = null, createAvatarCore = null, LifeGaze = null;
try {
  ({ createAvatarCore } = await import('../src/renderer/avatar-core/index.js'));
  ({ LifeGaze } = await import('../src/renderer/avatar-core/life-gaze.js'));
} catch (e) { ok(false, 'core: avatar-core/index.js + life-gaze.js import', String(e && e.message)); }
if (!createAvatarCore || !LifeGaze) {
  console.log(`\nFAIL check-avatar-core -- ${pass}/${pass + fail} assertions passed (the core module is missing)`);
  process.exit(1);
}
const THREE = await import('three');
const bytes = (() => { const b = fs.readFileSync(modelPath); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); })();
const camera = new THREE.PerspectiveCamera(28, 1280 / 742, 0.05, 50);
camera.position.set(0, 1.4, 3);
camera.lookAt(0, 1.3, 0);
camera.updateMatrixWorld();

core1 = createAvatarCore({ random: makeRandom(7) });
const loaded = await core1.load(bytes.slice(0));
ok(loaded && loaded.vrm && loaded.vrm.humanoid, 'core: load(ArrayBuffer) returns a prepared VRM (three-vrm path)', String(loaded));
const vrm = loaded.vrm;
core1.bind(vrm, camera);
ok(core1.vrm === vrm && core1.camera === camera, 'core: bind() keeps the vrm and the camera');
ok(vrm.lookAt && vrm.lookAt.target === core1.gaze.gazeObj && vrm.lookAt.autoUpdate === true, 'core: bind() points the VRM eyes at the gaze target');
for (const preset of ['happy', 'relaxed', 'aa', 'oh', 'blink']) ok(Boolean(vrm.expressionManager && vrm.expressionManager.getExpression(preset)), `setup: the test model has the ${preset} expression`);

const ex = (name) => vrm.expressionManager.getValue(name) || 0;
const T0 = 1_000_000; // ms; `now` is injected, so minutes of life run in milliseconds
let clock = T0;
const run = (core, seconds, hz = 60, each = null) => { const n = Math.round(seconds * hz); for (let i = 0; i < n; i++) { clock += 1000 / hz; core.update(1 / hz, clock); if (each) each(clock); } };

// ---------- C. the core drives a bound VRM on its own ----------
{
  // mouth
  core1.setMouth({ aa: 0.8, ih: 0, ou: 0, ee: 0, oh: 0 });
  run(core1, 0.1);
  ok(Math.abs(ex('aa') - 0.8) < 1e-6, 'mouth: setMouth({aa:0.8}) lands on the VRM expression', String(ex('aa')));
  core1.setMouth({ aa: 0.9, oh: 0.9 });
  run(core1, 0.1);
  ok(ex('aa') + ex('oh') <= 1 + 1e-6 && ex('aa') > 0.4, 'mouth: vowels are normalised so the group never over-drives the face', `${ex('aa')} ${ex('oh')}`);
  core1.setMouth(null);
  run(core1, 0.1);
  ok(ex('aa') === 0 && ex('oh') === 0, 'mouth: setMouth(null) closes it');

  // held emotion
  core1.setEmotion('happy', 0.8);
  run(core1, 0.1);
  ok(Math.abs(ex('happy') - 0.8) < 1e-6, 'emotion: setEmotion("happy", 0.8) holds the expression', String(ex('happy')));
  core1.setEmotion('relaxed', 0.8);
  run(core1, 0.1);
  ok(Math.abs(ex('relaxed') - 0.8) < 1e-6 && ex('happy') === 0, 'emotion: the core takes VRM preset names (the tag->preset map, neutral->relaxed, stays in chat-brain, ADR C2); `relaxed` replaces the held one', `${ex('relaxed')} ${ex('happy')}`);
  core1.setEmotion(null);
  run(core1, 0.1);
  ok(ex('relaxed') === 0, 'emotion: setEmotion(null) releases it');

  // irregular blinks (plan metric 4: not a fixed period)
  const onsets = [];
  let was = false;
  run(core1, 120, 60, (t) => { const on = ex('blink') > 0.5; if (on && !was) onsets.push(t); was = on; });
  const gaps = onsets.slice(1).map((t, i) => Math.round(t - onsets[i]));
  const distinct = new Set(gaps.map((g) => Math.round(g / 100)));
  ok(onsets.length >= 15, `idle life: blinks happen on their own (${onsets.length} in 120 s)`);
  ok(distinct.size >= 8 && Math.max(...gaps) - Math.min(...gaps) >= 1500, 'idle life: blink intervals are irregular, not one fixed period', JSON.stringify({ distinct: distinct.size, min: Math.min(...gaps), max: Math.max(...gaps) }));

  // breathing
  const chest = vrm.humanoid.getNormalizedBoneNode('chest') || vrm.humanoid.getNormalizedBoneNode('spine');
  let lo = Infinity, hi = -Infinity;
  run(core1, 10, 60, () => { lo = Math.min(lo, chest.rotation.x); hi = Math.max(hi, chest.rotation.x); });
  ok(hi - lo >= 0.02, 'idle life: the chest breathes (rotation range over 10 s)', String(hi - lo));

  // gaze follows the pointer: head yaw flips sign with it, and the eye target moves to the same side
  const headNode = vrm.humanoid.getNormalizedBoneNode('head');
  const aim = (x) => { core1.gaze.setPointer(x, 0.05); run(core1, 3, 60, () => core1.gaze.setPointer(x, 0.05)); return { yaw: headNode.rotation.y, eyeX: core1.gaze.gazeObj.position.x }; };
  const right = aim(1.2), left = aim(-1.2);
  ok(right.yaw * left.yaw < 0 && Math.abs(right.yaw - left.yaw) > 0.1, 'gaze: the head yaw follows the pointer to either side', JSON.stringify({ right, left }));
  ok(right.eyeX * left.eyeX < 0, 'gaze: the eye target moves to the pointer side', JSON.stringify({ right, left }));

  // idle glances: toward the look targets once the pointer has been still, none while she speaks
  core1.gaze.setLookTargets([{ name: 'a', x: -0.6, y: 0.1 }, { name: 'b', x: 0.7, y: 0 }]);
  core1.gaze.pointer.at = clock - 3000;
  const picks = new Set();
  run(core1, 90, 60, () => { if (core1.gaze.life.glanceTo) picks.add(`${core1.gaze.life.glanceFrom}`); });
  ok(picks.size >= 4, `idle life: she glances at the look targets on her own (${picks.size} glances in 90 s)`);
  core1.setMouth({ aa: 0.5 });
  const before = core1.gaze.life.glanceFrom;
  run(core1, 40, 60, () => { core1.gaze.pointer.at = 0; });
  ok(core1.gaze.life.glanceFrom === before, 'idle life: no new glance starts while she speaks', `${before} -> ${core1.gaze.life.glanceFrom}`);
  core1.setMouth(null);
}

// ---------- D. two cores, no shared state ----------
{
  const coreB = createAvatarCore({ random: makeRandom(99) });
  const { vrm: vrmB } = await coreB.load(bytes.slice(0));
  coreB.bind(vrmB, camera);
  ok(core1.gaze !== coreB.gaze && core1.gaze.life !== coreB.gaze.life && core1.gaze.pointer !== coreB.gaze.pointer, 'twice: two cores own two separate life/gaze states');
  const blinkTimes = (core, v) => { const out = []; let was = false; run(core, 30, 60, (t) => { const on = (v.expressionManager.getValue('blink') || 0) > 0.5; if (on && !was) out.push(Math.round(t - clock + 30000)); was = on; }); return out; };
  coreB.setMouth({ aa: 0.7 });
  const a = (() => { const out = []; let was = false; const start = clock; const n = 1800; for (let i = 0; i < n; i++) { clock += 1000 / 60; core1.update(1 / 60, clock); coreB.update(1 / 60, clock); const on = ex('blink') > 0.5; if (on && !was) out.push(Math.round(clock - start)); was = on; } return out; })();
  ok(Math.abs((vrmB.expressionManager.getValue('aa') || 0) - 0.7) < 1e-6 && ex('aa') === 0, 'twice: a mouth set on one core never reaches the other', `${vrmB.expressionManager.getValue('aa')} ${ex('aa')}`);
  ok(a.length >= 3, 'twice: both run in one realm side by side (control: the first core still blinks)', JSON.stringify(a));
  void blinkTimes;
  const g1 = new LifeGaze({ random: makeRandom(1) }), g2 = new LifeGaze({ random: makeRandom(2) });
  ok(JSON.stringify(g1.life.phase) !== JSON.stringify(g2.life.phase), 'twice: each LifeGaze draws its own random phases from its own source');
}

// ---------- B. the main-webview engine runs ON the core ----------
{
  const { ReflexEngine, ClipLayer, Catalog } = await import('../src/renderer/reflex/index.js');
  const engine = new ReflexEngine({ catalog: new Catalog(makeRandom(3)), clips: new ClipLayer(), random: makeRandom(3) });
  ok(engine.core && engine.gaze instanceof LifeGaze && engine.gaze === engine.core.gaze, 'engine: ReflexEngine owns an avatar core and uses its LifeGaze');
  ok(engine.life === engine.gaze.life && engine.pointer === engine.gaze.pointer && engine.lookTargets === engine.gaze.lookTargets, 'engine: engine.life / pointer / lookTargets are the core\'s own objects');
  engine.follow = { head: 0.2, spine: 0, rate: 3, tilt: 1 };
  engine.primaryGaze = { x: 0.1, y: 0.2 };
  engine.eyeG = { x: 0.3, y: 0.4 };
  ok(engine.gaze.follow.head === 0.2 && engine.gaze.primaryGaze.x === 0.1 && engine.gaze.eyeG.y === 0.4, 'engine: assignments to follow / primaryGaze / eyeG write through to the core');
  const shared = createAvatarCore({ random: makeRandom(4) });
  const engine2 = new ReflexEngine({ catalog: new Catalog(makeRandom(4)), clips: new ClipLayer(), random: makeRandom(4), core: shared });
  ok(engine2.core === shared && engine2.gaze === shared.gaze, 'engine: a core can be injected (the engine is a client of the core, not its owner)');
  const src = read('src/renderer/reflex/engine.js');
  ok(/this\.gaze\.lifeLayer\(/.test(src) && /this\.gaze\.gazeLayer\(/.test(src) && !/L\.saccNext = now/.test(src) && !/const GLANCE_MIN_MS/.test(src) && !/Math\.sin\(\(2 \* Math\.P[I] \* t\)/.test(src), 'engine: engine.js delegates the life and gaze layers to the core and carries no second copy of them');
  ok(!/const em = this\.vrm\.expressionManager;\s*\n\s*if \(em\) for/.test(src), 'engine: engine.js carries no private expression writer (the core\'s applyExpressions is the one)');
  ok(fs.existsSync(path.join(ROOT, 'room/src/zumi.js')), 'pack untouched: room/src/zumi.js is still there (its removal is P1 part 2)');
}

// ---------- E. the app loads the avatar through the core ----------
{
  const app = read('src/renderer/app.js');
  ok(/createAvatarCore\(/.test(app) && /avatarCore\.load\(/.test(app), 'app: switchModel loads the VRM through the avatar core');
  ok(!/new GLTFLoader\(\)/.test(app) && !/VRMLoaderPlugin/.test(app), 'app: no private GLTFLoader / VRMLoaderPlugin copy is left in app.js');
  ok(/new ReflexEngine\(\{[^}]*core: avatarCore/.test(app), 'app: the engine is built on the same core the loader came from');
}

console.log(`\n${fail ? 'FAIL' : 'PASS'} check-avatar-core -- ${pass}/${pass + fail} assertions passed`);
process.exit(fail ? 1 : 0);
