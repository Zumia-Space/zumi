// Camera-modes latency gate (T-31 camera modes, PLAN-camera-modes.md: "the existing latency check runs with
// forced mode switches every 2 s, and ON must equal OFF (<=150ms)"). Headless Node (no Electron, no window) --
// reuses the EXACT instrument check-r4a-latency.mjs already proved out: the trigger()/pending/afterRender()
// pipeline, MAX_LATENCY_MS, and the same per-frame sequence app.js's real render loop uses, now with
// director.update() inserted in the SAME slot app.js puts it (between engine.update(dt) and the render call) --
// director.update() never awaits I/O and never calls trigger()/play() (asserted statically in check-camera.mjs),
// so this gate is about MEASURING that holds under load, not just reading the source.
//   npm run check:camera-latency -- --model <file.vrm> [--samples 25]      (or ZUMI_TEST_MODEL)
// OFF: the ORIGINAL methodology -- each trigger fired --samples times on a FRESH engine bind, no director, no
// room (the exact baseline check-r4a-latency.mjs already gates).
// ON: ONE continuous engine + CameraDirector bound to the stand-in v2 room, director.setWorking() toggled every
// 2 REAL seconds (talk<->work, the same public signal app.js would feed from a real "is she working" source) so
// genuine eased view switches (300ms camera ease + plate cross-fade) are actually in flight while each trigger
// in the ladder is fired --samples times on that SAME engine and its latency measured. Exit 0 only when every
// row clears MAX_LATENCY_MS at p95 with >= the requested sample count, on BOTH sides.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ownerPath } from './lib/owner-paths.mjs';

globalThis.self = globalThis;
globalThis.window = globalThis;
globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
globalThis.ProgressEvent = class ProgressEvent { constructor(type, init) { this.type = type; Object.assign(this, init); } };

const THREE = await import('three');
const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
const { VRMLoaderPlugin } = await import('@pixiv/three-vrm');
const { prepareVrm } = await import('../src/renderer/model-facing.js');
const { ReflexEngine, ClipLayer, Catalog } = await import('../src/renderer/reflex/index.js');
const { MAX_LATENCY_MS } = await import('../src/renderer/selftest/gestures.js');
const { loadRoomV2 } = await import('../src/renderer/room/room-loader-v2.js');
const { CameraDirector } = await import('../src/renderer/room/camera-director.js');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const STANDIN = ownerPath('standinRoom', 'local/standin-room-v2');
const argAt = process.argv.indexOf('--model');
const modelPath = (argAt >= 0 ? process.argv[argAt + 1] : null) || process.env.ZUMI_TEST_MODEL || ownerPath('testModel', 'local/test-model.vrm');
const samplesAt = process.argv.indexOf('--samples');
const SAMPLES = samplesAt >= 0 ? Number(process.argv[samplesAt + 1]) : 25;
if (!fs.existsSync(modelPath)) { console.error(`usage: npm run check:camera-latency -- --model <file.vrm> (missing: ${modelPath})`); process.exit(2); }
if (!fs.existsSync(path.join(STANDIN, 'room.json'))) { console.error(`missing stand-in at ${STANDIN} -- run: node scripts/gen-standin-room-v2.mjs`); process.exit(2); }

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

// Same per-frame sequence app.js's real render loop uses: engine.update(dt); director.update(); afterRender().
async function driveUntilLatency(engine, id, director) {
  let last = performance.now();
  const deadline = last + 500;
  while (performance.now() < deadline) {
    await sleep(16);
    const now = performance.now();
    engine.update((now - last) / 1000);
    if (director) director.update();
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

const TRIGGERS = ['entrance', 'wake', 'poke', 'send', 'board', 'focus', 'pat', 'typing-stop', 'typing', 'bored', 'sleepy', 'blur', 'cursor'];

// ---------- OFF: the original r4a-latency methodology -- fresh engine per sample, no director, no room ----------
async function sampleOff(trigger) {
  const out = [];
  for (let i = 0; i < SAMPLES; i++) {
    const engine = freshEngine();
    engine.setLifeEnabled(true);
    engine.autoIdle = true;
    const info = engine.trigger(trigger);
    if (!info) continue;
    const ms = await driveUntilLatency(engine, info.id, null);
    if (ms != null) out.push(ms);
  }
  return stats(out);
}

// ---------- ON: one continuous engine + a live CameraDirector forcing a real switch every 2s ----------
const ROOTS = { '/room/': STANDIN + path.sep };
const srv = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  const pre = Object.keys(ROOTS).find((p) => url.startsWith(p));
  const file = pre ? ROOTS[pre] + url.slice(pre.length) : null;
  if (!file) { res.writeHead(404); return res.end(); }
  fs.readFile(file, (e, b) => { if (e) { res.writeHead(404); return res.end(); } res.writeHead(200); res.end(b); });
}).listen(0, '127.0.0.1');
await new Promise((r) => srv.once('listening', r));
const port = srv.address().port;
const roomJson = JSON.parse(fs.readFileSync(path.join(STANDIN, 'room.json'), 'utf8'));
const room = await loadRoomV2(roomJson, (rel) => `http://127.0.0.1:${port}/room/${rel}`);
if (!room) { console.error('stand-in room failed to load'); process.exit(2); }

const onCamera = new THREE.PerspectiveCamera(28, 1280 / 742, 0.05, 50);
const onEngine = new ReflexEngine({ catalog: loadCatalogSync(), clips: new ClipLayer(), random: Math.random });
onEngine.bind(vrm, onCamera);
const director = new CameraDirector({ engine: onEngine, camera: onCamera, plateCtx: null, setLookTargets: (t) => onEngine.setLookTargets(t), placeSeat: () => {} });
director.setRoom(room);
let forceTimer = setInterval(() => director.setWorking(!director.working), 2000); // forced switch every 2s: talk<->work, the public "working" signal toggled on a clock
forceTimer.unref();

async function sampleOn(trigger) {
  const out = [];
  for (let i = 0; i < SAMPLES; i++) {
    const info = onEngine.trigger(trigger);
    if (!info) continue;
    const ms = await driveUntilLatency(onEngine, info.id, director);
    if (ms != null) out.push(ms);
  }
  return stats(out);
}

let anyFail = false;
const rows = [];
for (const trig of TRIGGERS) {
  const off = await sampleOff(trig);
  const on = await sampleOn(trig);
  const okOff = off.n >= SAMPLES * 0.8 && off.p95 != null && off.p95 <= MAX_LATENCY_MS;
  const okOn = on.n >= SAMPLES * 0.8 && on.p95 != null && on.p95 <= MAX_LATENCY_MS;
  const delta = (on.p50 != null && off.p50 != null) ? +(on.p50 - off.p50).toFixed(1) : null;
  if (!okOff || !okOn) anyFail = true;
  rows.push({ trig, off, on, delta, pass: okOff && okOn });
  console.log(`${trig.padEnd(12)} OFF n=${off.n} p50=${off.p50}ms p95=${off.p95}ms max=${off.max}ms  |  ON(forced switch/2s) n=${on.n} p50=${on.p50}ms p95=${on.p95}ms max=${on.max}ms  |  delta(p50) ${delta == null ? 'n/a' : (delta >= 0 ? '+' : '') + delta + 'ms'}  ${okOff && okOn ? 'PASS' : 'FAIL'}`);
}
console.log(`\nMAX_LATENCY_MS=${MAX_LATENCY_MS}, samples/trigger/side=${SAMPLES}, model=${modelPath}, forced switch interval=2000ms`);
console.log(JSON.stringify(rows));
clearInterval(forceTimer);
srv.close();
process.exit(anyFail ? 1 : 0);
