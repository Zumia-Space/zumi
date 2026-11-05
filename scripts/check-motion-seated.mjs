// Seated-base motion guard: every upper-body reflex (every built-in gesture variant + every speech-library
// variant) replayed on top of the T-31 seated base (SIT-FEASIBILITY.md path a), looking specifically for
// hand/wrist contact with the now-much-closer thighs or the stand-in chair seat -- the coordinator's
// priority ask, since the owner's default view is now a seated "webcam" shot and every reflex must still
// read correctly while seated. This is lighter than check:motion's full skinned-mesh torso-depth probe (no
// per-vertex skinning pass here) but comprehensive in COVERAGE: every catalog trigger variant and every
// speech-library variant, not just the startle family check:motion focuses on.
//
// The seated base is applied through the REAL ClipLayer (action()/sample()/blend(), exactly how a built-in
// clip plays in the real app) -- a sustained GestureCommand carrying the clip, played through
// engine.player.play() like any other. (A previous version of this script worked around
// ClipLayer.sample()'s resetNormalizedPose()/THREE.AnimationMixer interaction bug -- fixed now in
// src/renderer/reflex/clips.js; see that file's comment for the root cause. scripts/check-clip-hold.mjs
// regression-tests the fix directly.) Node's fetch has no file:// support, so ClipLayer's own cache is
// seeded with the already-parsed clip data instead of a real network fetch (same reasoning as
// check-clip-hold.mjs) -- everything after that point is the unmodified production code path.
//
// Upper-body arm rest while seated: engine.rig.seated = true turns on the seated-base arm pose (hands on
// the thighs) and default loose hand shape (src/renderer/reflex/rig.js), at the LOWEST priority -- any
// active gesture reach/hand-shape request still fully overrides it. This sweep plays every gesture WITH
// that base active, so a reported conflict is a real "reflex vs. seated base" conflict, not an artifact of
// standing-pose arms.
//
//   npm run check:motion-seated -- --model <file.vrm> [--fps 60] [--out <dir>] [--only <scenario,...>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { checkOutDir } from './lib/check-out-dir.mjs';
// no --model / ZUMI_TEST_MODEL: the shipped default avatar (resources-pinned/default-model/PIN-MANIFEST.json)
const defaultVrmPath = () => createRequire(import.meta.url)('./lib/default-vrm.cjs').resolveSource();

globalThis.self = globalThis;
globalThis.window = globalThis;
globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
globalThis.ProgressEvent = class ProgressEvent { constructor(type, init) { this.type = type; Object.assign(this, init); } };
let vclock = 1e6;
Object.defineProperty(globalThis.performance, 'now', { value: () => vclock, configurable: true, writable: true });

const THREE = await import('three');
const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
const { VRMLoaderPlugin } = await import('@pixiv/three-vrm');
const { VRMAnimationLoaderPlugin } = await import('@pixiv/three-vrm-animation');
const { prepareVrm } = await import('../src/renderer/model-facing.js');
const { ReflexEngine, ClipLayer, Catalog } = await import('../src/renderer/reflex/index.js');
const { SpeechLibrary } = await import('../src/renderer/talk/library.js');
const { measureCore, coreF } = await import('../src/renderer/talk/rigprobe.js');
const { computeRootDrop } = await import('./seat-offset.mjs');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, def = null) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : def; };
const modelPath = arg('model', process.env.ZUMI_TEST_MODEL || defaultVrmPath());
if (!fs.existsSync(modelPath)) { console.error(`model not found: ${modelPath} (usage: npm run check:motion-seated -- --model <file.vrm>)`); process.exit(2); }
const FPS = Number(arg('fps', 60));
// default: a fresh per-run scratch dir (never a shared evidence folder -- BP-3); an explicit --out is used as given
const outDir = arg('out') || checkOutDir('check-motion-seated');
const only = arg('only') ? new Set(arg('only').split(',')) : null;

const LIMIT = {
  thighMarginM: 0.03, // a hand point closer than this to the thigh/shin centreline counts as a thigh hit
  thighRadiusM: 0.06, // approximate thigh/shin half-thickness used for the capsule test
};

// ---------- model ----------
const buf = fs.readFileSync(modelPath);
const loader = new GLTFLoader();
loader.register((p) => new VRMLoaderPlugin(p));
const gltf = await loader.parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
const vrm = gltf.userData.vrm;
prepareVrm(gltf, vrm); // the app's load path: clean-up + the VRM 0.x flip + the base-orientation capture Rig's IK needs
vrm.scene.updateMatrixWorld(true);

// ---------- catalog + speech library (same data the app loads) ----------
const gdir = path.join(ROOT, 'src', 'renderer', 'reflex', 'gestures');
const catalog = new Catalog(() => 0.5);
for (const name of JSON.parse(fs.readFileSync(path.join(gdir, 'index.json'), 'utf8')).triggers) {
  const def = JSON.parse(fs.readFileSync(path.join(gdir, `${name}.json`), 'utf8'));
  catalog.triggers.set(name, { name, labelVi: def.labelVi, state: Boolean(def.state), variants: def.variants });
}
const lib = await SpeechLibrary.load(async (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'reflex', 'speech', f), 'utf8')));

// ---------- engine ----------
let seed = 7;
const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const camera = new THREE.PerspectiveCamera(28, 1280 / 742, 0.05, 50);
const engine = new ReflexEngine({ catalog, clips: new ClipLayer(), random });
engine.bind(vrm, camera);
engine.autoIdle = false;
const rig = engine.rig;
const core = measureCore(rig);

const V = () => new THREE.Vector3();
const nb = (n) => vrm.humanoid.getNormalizedBoneNode(n);
const livePos = (n) => nb(n).getWorldPosition(V());

// ---------- frame stepping ----------
const dt = 1 / FPS;
function step() { vclock += 1000 * dt; engine.update(dt); vrm.scene.updateMatrixWorld(true); }
function reset() {
  engine.player.stopAll(true);
  engine.states.clear();
  rig.routes.clear();
  engine.resetForTest();
  seed = 7;
  engine.life.phase = [0, 1, 2, 3, 4, 5].map(() => random() * 100);
  engine.life.blinkNext = vclock + 99999;
  playSeatedBase(); // stopAll() above also stopped the sustained sit-idle base -- re-engage it every scenario
  for (let i = 0; i < FPS; i++) step(); // also ramps the clip's own 250ms envelope back to full
}
const play = (cmd, side = 1) => { const res = engine.player.play(cmd, { side }); if (!res.ok) throw new Error(res.errors.join('; ')); return res.id; };

// ---------- seated base: real ClipLayer (cache pre-seeded -- Node has no file:// fetch, see header) ----------
const restAnkleY = livePos('leftFoot').y; // standing ankle-to-floor clearance, measured BEFORE the clip ever plays

const vrmaBuf = fs.readFileSync(path.join(ROOT, 'assets', 'clips', 'sit-idle.vrma'));
const vrmaLoader = new GLTFLoader();
vrmaLoader.register((p) => new VRMAnimationLoaderPlugin(p));
const vrmaGltf = await vrmaLoader.parseAsync(vrmaBuf.buffer.slice(vrmaBuf.byteOffset, vrmaBuf.byteOffset + vrmaBuf.byteLength), '');
const vrmAnimation = vrmaGltf.userData.vrmAnimations[0];
engine.clips.setAvailable([{ name: 'sit-idle', url: 'unused (cache pre-seeded, see header comment)' }]);
engine.clips.cache.set('sit-idle', Promise.resolve({ kind: 'vrma', data: vrmAnimation }));
const SIT_CMD = { id: 'sit-idle-base', sustain: true, clip: { name: 'sit-idle', weight: 1 } };
rig.seated = true; // seated-base arm rest + default loose hand shape (src/renderer/reflex/rig.js) -- lowest priority

function playSeatedBase() {
  const res = engine.player.play(SIT_CMD, { side: 1 });
  if (!res.ok) throw new Error('sit-idle clip failed to queue: ' + res.errors.join('; '));
}
playSeatedBase();
step();
await new Promise((r) => setTimeout(r, 0)); // flush action()'s own .then() (cache entry is already resolved)
for (let i = 0; i < FPS; i++) step(); // settle: clip envelope ramp-in (250ms)

// seat height: drop the scene root so the ANKLE lands at its own standing (flat-footed) height -- anchoring
// on hips left the soles 2-9cm through the floor (coordinator QC, 2026-10-03); see scripts/seat-offset.mjs
// and scripts/check-seat-offset.mjs's integration assertion for the full reasoning.
const seatedAnkleY = livePos('leftFoot').y;
const drop = computeRootDrop(seatedAnkleY, restAnkleY);
vrm.scene.position.y -= drop;
vrm.scene.updateMatrixWorld(true);

// live (post-drop) measurements for the thigh capsule + chair box -- rig.hipsPos/headPos etc are measured
// ONCE at bind() and do not track this manual translation, so read world positions straight off the bones.
const hipsNow = livePos('hips');
const SEAT_HEIGHT_M = hipsNow.y; // wherever the pelvis actually lands once soles are on the floor (~0.587m on zumi-v3.1, not the old 0.45m nominal)
const kneeL = livePos('leftLowerLeg'), kneeR = livePos('rightLowerLeg');
const hipJointL = livePos('leftUpperLeg'), hipJointR = livePos('rightUpperLeg');
const THIGHS = [[hipJointL, kneeL, 'left'], [hipJointR, kneeR, 'right']];
const CHAIR = { // same stand-in slab as scripts/sheet-sit-pose.mjs
  minX: -0.21, maxX: 0.21,
  minY: SEAT_HEIGHT_M - 0.05, maxY: SEAT_HEIGHT_M,
  minZ: hipsNow.z - 0.05 - 0.21, maxZ: hipsNow.z - 0.05 + 0.21,
};
function pointSegDist(p, a, b) { // distance from p to segment ab
  const ab = b.clone().sub(a), t = THREE.MathUtils.clamp(p.clone().sub(a).dot(ab) / ab.lengthSq(), 0, 1);
  return p.distanceTo(a.clone().addScaledVector(ab, t));
}
function thighHit(p) {
  for (const [a, b, side] of THIGHS) {
    const d = pointSegDist(p, a, b);
    if (d < LIMIT.thighRadiusM) return { side, marginM: +(LIMIT.thighRadiusM - d).toFixed(3) };
  }
  return null;
}
function chairHit(p) {
  if (p.x > CHAIR.minX && p.x < CHAIR.maxX && p.y > CHAIR.minY && p.y < CHAIR.maxY && p.z > CHAIR.minZ && p.z < CHAIR.maxZ) return true;
  return false;
}

// ---------- behind-back guard (same formula as check-motion.mjs) ----------
function behindBack(side, wr) {
  const bx = rig.surf && rig.surf.chestBox;
  if (!bx) return -Infinity;
  const inv = rig.frame(rig.chestNode).clone().invert();
  const lw = wr.clone().applyMatrix4(inv);
  const hipsY = rig.nodes.hips.getWorldPosition(V()).applyMatrix4(inv).y;
  if (Math.abs(lw.x) < bx.max.x && lw.y > hipsY - 0.1 && lw.y < bx.max.y) return bx.min.z - lw.z;
  return -Infinity;
}

// ---------- hand points (same construction as check-motion.mjs) ----------
function handPoints(side) {
  const pts = { wrist: nb(`${side}Hand`).getWorldPosition(V()) };
  const mp = nb(`${side}MiddleProximal`);
  if (mp) pts.palm = V().lerpVectors(pts.wrist, mp.getWorldPosition(V()), 0.6);
  for (const f of ['Index', 'Middle', 'Little', 'Thumb']) {
    const a = nb(`${side}${f}${f === 'Thumb' ? 'Proximal' : 'Intermediate'}`), b = nb(`${side}${f}Distal`);
    if (!a || !b) continue;
    const pa = a.getWorldPosition(V()), pb = b.getWorldPosition(V());
    pts[`${f.toLowerCase()}Tip`] = pb.clone().addScaledVector(V().subVectors(pb, pa), 0.9);
  }
  return pts;
}

// ---------- one-line fix suggester ----------
function suggestFix(kind, point, side) {
  if (kind === 'thigh') return `raise the reach's up offset (or pull it outward) so ${point} clears the seated thigh line on ${side}`;
  if (kind === 'chair') return `pull the reach's fwd/out offset away from the lap so ${point} doesn't reach into the seat volume on ${side}`;
  if (kind === 'core') return `the torso-core hit is the same as standing -- unrelated to seating, check the reach pole/target directly`;
  if (kind === 'behind') return `the behind-back hit is the same as standing -- unrelated to seating, check the reach pole direction`;
  return 'investigate';
}

// ---------- scenarios: every built-in gesture variant + every speech-library variant ----------
const SC = [];
for (const trig of catalog.names()) {
  const t = catalog.get(trig);
  for (const v of t.variants) SC.push({ name: `${trig}/${v.id}`, setup: () => play(v.command, 1) });
}
for (const [intent, def] of lib.byIntent) {
  for (const v of def.variants) SC.push({ name: `speech ${intent}/${v.id}`, setup: () => play(v.command, 1) });
}

const WINDOW_MS = 1800;
let bad = 0;
const all = [];
for (const sc of SC) {
  if (only && !only.has(sc.name)) continue;
  reset();
  const t0 = vclock;
  sc.setup();
  const frames = Math.ceil(WINDOW_MS / (1000 * dt));
  const finds = [];
  for (let f = 0; f < frames; f++) {
    step();
    for (const side of ['left', 'right']) {
      const pts = handPoints(side);
      for (const [key, p] of Object.entries(pts)) {
        const cf = core ? coreF(core, p.clone().applyMatrix4(rig.frame(rig.chestNode).clone().invert())) : Infinity;
        if (cf < 1) finds.push({ tMs: Math.round(vclock - t0), side, kind: 'core', point: key, detail: `core f ${cf.toFixed(2)}` });
        const th = thighHit(p);
        if (th) finds.push({ tMs: Math.round(vclock - t0), side, kind: 'thigh', point: key, detail: `thigh ${th.side}, ${(th.marginM * 100).toFixed(1)} cm inside` });
        if (chairHit(p)) finds.push({ tMs: Math.round(vclock - t0), side, kind: 'chair', point: key, detail: 'inside the seat volume' });
      }
      const behind = behindBack(side, pts.wrist);
      if (behind > 0.02) finds.push({ tMs: Math.round(vclock - t0), side, kind: 'behind', point: 'wrist', detail: `${(behind * 100).toFixed(1)} cm behind the back` });
    }
  }
  // de-dup per (side, kind, point) -> one row with first-hit time + worst detail
  const grouped = new Map();
  for (const fd of finds) {
    const k = `${fd.side}|${fd.kind}|${fd.point}`;
    if (!grouped.has(k)) grouped.set(k, { ...fd, count: 1 }); else grouped.get(k).count++;
  }
  const rows = [...grouped.values()];
  const ok = rows.length === 0;
  if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${sc.name}`);
  for (const r of rows) {
    const fix = suggestFix(r.kind, r.point, r.side);
    console.log(`       ${r.kind.toUpperCase()} ${r.side} ${r.point} at t=${r.tMs}ms (${r.count} frame(s)) -- ${r.detail} -- likely fix: ${fix}`);
  }
  all.push({ name: sc.name, ok, findings: rows.map((r) => ({ ...r, fix: suggestFix(r.kind, r.point, r.side) })) });
}

if (outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'motion-seated.json'), JSON.stringify({ model: path.basename(modelPath), fps: FPS, seatHeightM: SEAT_HEIGHT_M, drop, limits: LIMIT, scenarios: all }, null, 1));
  console.log(`wrote ${path.join(outDir, 'motion-seated.json')}`);
}
console.log(`check:motion-seated ${bad ? `${bad}/${SC.length} scenario(s) conflict with the seated base` : 'all clear'} -- ${SC.length} scenario(s), ${FPS} Hz, seat ${SEAT_HEIGHT_M} m`);
process.exit(0); // reporting run (coordinator: "list them, don't fix them yet") -- never fails the build
