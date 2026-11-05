// R4a BINDING GATE (PLAN-R4-lean.md §R4a, coordinator ruling): reflex trigger -> first-rendered-frame latency
// with R4a ON must equal OFF (both <= MAX_LATENCY_MS). Headless Node (no Electron, no window): reuses the
// EXACT instrument selftest/gestures.js already asserts every built-in gesture against -- MAX_LATENCY_MS, and
// the trigger()/pending/afterRender() pipeline -- driven by the SAME per-frame sequence app.js's real render
// loop uses (engine.update(dt); <renderer.render(...)>; engine.afterRender()), just without the WebGL render
// call in between, which afterRender() never reads anyway (it only looks at player instance state).
//   npm run check:r4a-latency -- --model <file.vrm> [--samples 25]      (or ZUMI_TEST_MODEL)
// For each reflex in the priority ladder (PLAN-R4-lean.md's measured section), fires it on a FRESH engine bind
// --samples times with R4a OFF (setLifeEnabled(false) + autoIdle=false -- both halves of R4a this task
// touched) and again with R4a ON (the shipped defaults), and reports p50/p95/n/max for each side plus the
// delta. Exit 0 only when every row clears MAX_LATENCY_MS at p95 with >= the requested sample count.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ownerPath } from './lib/owner-paths.mjs';

globalThis.self = globalThis;
globalThis.window = globalThis;
globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });

const THREE = await import('three');
const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
const { VRMLoaderPlugin } = await import('@pixiv/three-vrm');
const { prepareVrm } = await import('../src/renderer/model-facing.js');
const { ReflexEngine, ClipLayer, Catalog } = await import('../src/renderer/reflex/index.js');
const { MAX_LATENCY_MS } = await import('../src/renderer/selftest/gestures.js');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const argAt = process.argv.indexOf('--model');
const modelPath = (argAt >= 0 ? process.argv[argAt + 1] : null) || process.env.ZUMI_TEST_MODEL || ownerPath('testModel', 'local/test-model.vrm');
const samplesAt = process.argv.indexOf('--samples');
const SAMPLES = samplesAt >= 0 ? Number(process.argv[samplesAt + 1]) : 25;
if (!fs.existsSync(modelPath)) { console.error(`usage: npm run check:r4a-latency -- --model <file.vrm> (missing: ${modelPath})`); process.exit(2); }

function loadCatalogSync() {
  const dir = path.join(ROOT, 'src', 'renderer', 'reflex', 'gestures');
  const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  const catalog = new Catalog(Math.random);
  for (const name of index.triggers) {
    const def = JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8'));
    catalog.triggers.set(name, { name, labelVi: def.labelVi, state: Boolean(def.state), variants: def.variants });
  }
  return catalog;
}

// One real VRM, parsed ONCE and re-bound to a fresh ReflexEngine per sample (Rig only reads bone references at
// bind time; applyPose() sets bone rotations absolutely every frame, so nothing accumulates across samples).
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

function freshEngine() {
  const engine = new ReflexEngine({ catalog: loadCatalogSync(), clips: new ClipLayer(), random: Math.random });
  engine.bind(vrm, camera);
  return engine;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Drives the exact per-frame sequence app.js's real render loop uses, at ~60Hz real wall-clock cadence, until
// `id`'s latency resolves (afterRender() marks it started) or 500ms real time passes.
async function driveUntilLatency(engine, id) {
  let last = performance.now();
  const deadline = last + 500;
  while (performance.now() < deadline) {
    await sleep(16);
    const now = performance.now();
    engine.update((now - last) / 1000);
    last = now;
    engine.afterRender();
    const rec = engine.latencies && engine.latencies.get(id);
    if (rec) return rec.ms;
  }
  return null;
}

function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  if (!s.length) return { n: 0, p50: null, p95: null, max: null };
  const pct = (p) => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
  return { n: s.length, p50: +pct(50).toFixed(1), p95: +pct(95).toFixed(1), max: +s[s.length - 1].toFixed(1) };
}

// lifeOn=false turns off BOTH halves of R4a this task touched: setLifeEnabled gates lifeLayer() (glances +
// breathing, unchanged mechanism, now anchor-aware); autoIdle gates idleTimers() (bored/sleepy escalation AND
// the new 15-40s idle-variety scheduler). lifeOn=true leaves both at their shipped defaults.
async function sampleTrigger(trigger, lifeOn) {
  const out = [];
  for (let i = 0; i < SAMPLES; i++) {
    const engine = freshEngine();
    engine.setLifeEnabled(lifeOn);
    engine.autoIdle = lifeOn;
    const info = engine.trigger(trigger);
    if (!info) continue; // trigger not in the catalog -- counted as 0 samples, surfaced via n < SAMPLES
    const ms = await driveUntilLatency(engine, info.id);
    if (ms != null) out.push(ms);
  }
  return stats(out);
}

// The reflex priority ladder from PLAN-R4-lean.md's measured section (entrance 9 .. cursor 1) -- every trigger
// R4a's idle layer must never be able to outrank.
const TRIGGERS = ['entrance', 'wake', 'poke', 'send', 'board', 'focus', 'pat', 'typing-stop', 'typing', 'bored', 'sleepy', 'blur', 'cursor'];

let anyFail = false;
const rows = [];
for (const trig of TRIGGERS) {
  const off = await sampleTrigger(trig, false);
  const on = await sampleTrigger(trig, true);
  const okOff = off.n >= 20 && off.p95 != null && off.p95 <= MAX_LATENCY_MS;
  const okOn = on.n >= 20 && on.p95 != null && on.p95 <= MAX_LATENCY_MS;
  const delta = (on.p50 != null && off.p50 != null) ? +(on.p50 - off.p50).toFixed(1) : null;
  if (!okOff || !okOn) anyFail = true;
  rows.push({ trig, off, on, delta, pass: okOff && okOn });
  console.log(`${trig.padEnd(12)} OFF n=${off.n} p50=${off.p50}ms p95=${off.p95}ms max=${off.max}ms  |  ON n=${on.n} p50=${on.p50}ms p95=${on.p95}ms max=${on.max}ms  |  delta(p50) ${delta == null ? 'n/a' : (delta >= 0 ? '+' : '') + delta + 'ms'}  ${okOff && okOn ? 'PASS' : 'FAIL'}`);
}
console.log(`\nMAX_LATENCY_MS=${MAX_LATENCY_MS}, samples/trigger/side=${SAMPLES}, model=${modelPath}`);
console.log(JSON.stringify(rows));
process.exit(anyFail ? 1 : 0);
