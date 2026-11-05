// Per-frame hand/arm motion check for the startle reflexes, headless in Node (no Electron, no window). Plays every way
// a startle can play (poke startle on both sides at both jitter extremes, the wake startle after sleep, a startle cutting
// into other reactions and speech gestures) through the app's own ReflexEngine (life layer, gaze, player, rig IK, spring
// bones) on a virtual clock, and measures every frame:
//   HARD (fails the check): wrist behind the back of the torso; a hand point (wrist, palm, finger/thumb tips) inside the
//     torso core (rig rule R2's core); forearm twist flip; elbow pole flip; FACE-CLEARANCE (startle scenarios only): a
//     hand point above chin height AND inside the head's lateral face band (see faceBox below) — a startle's hands
//     must never cross the face, even mid-arc; HAND-SHAPE (startle scenarios only): the thumb tip rising above the
//     index MCP (reads as thumbs-up) or any finger's own curl over a ceiling (reads as a closed fist) — a startle's
//     open hand must read as open, not a fist or a thumbs-up
//   warn (judged on the contact sheet): an angular- or wrist-speed spike against the 6 frames around it; a hand point up
//     to 3 cm inside the skinned torso surface (nearest-vertex test, only near the surface)
// A defect already present before the reaction and running on unbroken belongs to the gesture before (warn). Reference
// rows (other reactions, the speech library) are measured for comparison and never fail — this is also how gestures
// that legitimately touch near the face (giggle -> mouth, think -> chin) stay clear of the startle-only face/hand-shape
// guards: their scenario names don't contain 'startle', so startleScenario is false and neither guard runs for them.
// Also runs rig rules R1-R5 on the startle commands.
//   npm run check:motion -- --model <file.vrm> [--fps 60] [--out <dir>] [--only <scenario,...>]
// Calibrated 01-10 on zumi-v3: before the 'chest' contact fix every poke startle put both wrists ~8 cm behind the back.
// Calibrated 02-10 on zumi-v3: before the sternum-height/pole fix (02b4a35), the open-handed poke startle put the
// middle fingertip ~5.8 cm ABOVE the chin, inside the face band, at 83-433 ms (the wrist itself stayed below the
// chin throughout — only the straight, uncurled fingers swung past it on a near-vertical forearm). The FACE-CLEARANCE
// guard below is calibrated against that: it fails on 02b4a35 and passes on the fix (contact lowered below the
// shoulder, pole no longer forces a near-vertical forearm, fingers get a slight natural curl).
// Calibrated 02-10 (second pass) on zumi-v3: the sternum fix (d47ccd6) still read as a closed-fist double thumbs-up at
// 83-350 ms — the 'open' shape's thumbIn is 0, so with the other four fingers given any curl (even a mild 55%
// open/30% relaxed blend) and the thumb left uncurled AND unrotated, the thumb (whose bind-pose direction points up
// and away from the fingers on this rig) reads as raised above the knuckles. Measured worst case on d47ccd6: thumb
// tip 5.8 cm above the index MCP. The HAND-SHAPE guard below is calibrated against that: it fails on d47ccd6 (5.8 cm,
// ceiling 3 cm) and passes on the fix (a new 'loose' shape: light finger curl, thumbIn 38 — worst case 1.8 cm).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
// no --model / ZUMI_TEST_MODEL: the shipped default avatar (resources-pinned/default-model/PIN-MANIFEST.json)
const defaultVrmPath = () => createRequire(import.meta.url)('./lib/default-vrm.cjs').resolveSource();

globalThis.self = globalThis;
globalThis.window = globalThis;
globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
let vclock = 1e6;
Object.defineProperty(globalThis.performance, 'now', { value: () => vclock, configurable: true, writable: true });

const THREE = await import('three');
const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
const { VRMLoaderPlugin } = await import('@pixiv/three-vrm');
const { prepareVrm } = await import('../src/renderer/model-facing.js');
const { ReflexEngine, ClipLayer, Catalog } = await import('../src/renderer/reflex/index.js');
const { SpeechLibrary } = await import('../src/renderer/talk/library.js');
const { measureCore, coreF, RigProbe } = await import('../src/renderer/talk/rigprobe.js');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, def = null) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : def; };
const modelPath = arg('model', process.env.ZUMI_TEST_MODEL || defaultVrmPath());
if (!fs.existsSync(modelPath)) { console.error(`model not found: ${modelPath} (usage: npm run check:motion -- --model <file.vrm>)`); process.exit(2); }
const FPS = Number(arg('fps', 60));
const outDir = arg('out');
const only = arg('only') ? new Set(arg('only').split(',')) : null;

// limits. Speeds are judged against the frames around them (a snap is an isolated spike; a fast but smooth move is
// not): the owner-approved waves and jumps already reach ~1900 deg/s and ~7 m/s at the wrist.
const LIMIT = {
  spikeRatio: 3,            // a segment's angular speed or the wrist speed > 3x the median of the 6 frames around it
  spikeFloorDegS: 300,      // ... and above this (deg/s); wrist: above 1 m/s
  twistDegPerFrame60: 25,   // forearm axial twist change per 60 Hz frame (wrist flip)
  poleFlipDeg: 60,          // elbow pole direction change per 60 Hz frame (elbow flip)
  handDepthM: 0.015,        // hand point deeper than this inside the torso surface
  behindM: 0.02,            // wrist behind the back of the torso (inside the body's width)
  faceMarginM: 0,           // extra clearance added to the face box on every side (0 = the measured face exactly)
  thumbRiseCm: 3,           // thumb tip above the index MCP (chest-local up) before a startle's open hand reads as a thumbs-up
  fingerCurlCeilingDeg: 60, // sum of a finger's 3 joint curls (deg) before a startle's open hand reads as a closed fist
  handShapeFloorDeg: 15,    // below this (max curl-sum across the 4 fingers, full 'loose' weight sums to ~19-32 per
                            // finger), the startle's own hand shape is still ramping in (inMs) or has faded out
                            // through outMs (or a sustained gesture it interrupted is resuming its own un-shaped
                            // reach) — HAND-SHAPE is not judged below the floor, same as FACE-CLEARANCE is not judged
                            // once a face-kind reach takes back over (see faceReachActive). Calibrated: interrupting
                            // an active gesture (giggle/happy-wiggle/speech) makes the curl ramp cross a low floor
                            // (e.g. 5) in the very first frame (t=17 ms) while the thumb's own rotation (thumbIn, a
                            // single larger value) is still catching up to the same weight fraction, a one-frame,
                            // imperceptible (<17 ms) blip — not the sustained 83-350 ms read the guard exists for.
};

// ---------- model ----------
const buf = fs.readFileSync(modelPath);
const loader = new GLTFLoader();
loader.register((p) => new VRMLoaderPlugin(p));
const gltf = await loader.parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
const vrm = gltf.userData.vrm;
prepareVrm(gltf, vrm); // the app's load path: clean-up + the VRM 0.x flip + the base-orientation capture Rig's IK needs
vrm.scene.updateMatrixWorld(true);

// ---------- catalog (same data the app loads) ----------
const gdir = path.join(ROOT, 'src', 'renderer', 'reflex', 'gestures');
const catalog = new Catalog(() => 0.5);
for (const name of JSON.parse(fs.readFileSync(path.join(gdir, 'index.json'), 'utf8')).triggers) {
  const def = JSON.parse(fs.readFileSync(path.join(gdir, `${name}.json`), 'utf8'));
  catalog.triggers.set(name, { name, labelVi: def.labelVi, state: Boolean(def.state), variants: def.variants });
}
const lib = await SpeechLibrary.load(async (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'reflex', 'speech', f), 'utf8')));

// ---------- engine, app framing ----------
let seed = 7;
const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const camera = new THREE.PerspectiveCamera(28, 1280 / 742, 0.05, 50);
const engine = new ReflexEngine({ catalog, clips: new ClipLayer(), random });
engine.bind(vrm, camera);
engine.autoIdle = false;
const rig = engine.rig;
const core = measureCore(rig);
// Face box for the FACE-CLEARANCE guard: head-local, so it turns and nods with the head. Bottom = the measured chin;
// top = the measured eye line + 3 cm (this model has no separate brow landmark; the brow ridge sits just above the
// eyes, so the eye line plus a small margin reads as 'to the brow' without adding a new measurement). Half-width =
// the measured face half-width at face height (ear parts included), i.e. literally 'head bone +/- the face width'.
// A hand point counts as a face-clearance violation only when it is BOTH above the chin AND inside this lateral
// band — a hand raised past chin height but well out to the side (a wave, an overhead reach) is not 'covering the
// face' and must not trip this guard.
const faceBox = rig.surf && { chinY: rig.surf.head.chin.y, browY: rig.surf.head.eye.y + 0.03, halfW: rig.surf.head.halfW + LIMIT.faceMarginM };
const FACE_REACH_TARGETS = new Set(['chin', 'mouth', 'face', 'eye']); // REACH presets of kind 'face' (rig.js) — a hand
// legitimately AT the face under one of these (poke/giggle -> mouth, typing/chin-think -> chin, wake/rub-eyes -> eye,
// ...). A sustained gesture like chin-think (priority 3, sustain: true) that a startle (priority 7) interrupts keeps
// its own 'chin' reach queued and resumes it once the startle's own reach weight fades back to 0 — intended
// continuity, not a startle overshoot — so the guard only looks at a hand's face-box status when NO face-kind reach
// is in rig.routes for that side this frame (mirrors how the engine's own guardHead reads 'contactW' in rig.js).
function faceHit(p) { // p: world point. Returns the head-local point if it violates the face box, else null.
  if (!faceBox) return null;
  const l = p.clone().applyMatrix4(rig.frame(rig.nodes.head).clone().invert());
  if (l.y > faceBox.chinY && l.y < faceBox.browY && Math.abs(l.x) < faceBox.halfW) return l;
  return null;
}
{
  const s = rig.shoulderWidth, head = rig.headPos, hips = rig.hipsPos;
  const box = new THREE.Box3().setFromObject(vrm.scene);
  const bottom = hips.y - 0.05 * s;
  const rawTop = Math.max(box.max.y, rig.shoulderY + 0.8 * rig.armLength, head.y + 0.6 * s);
  const top = rawTop + 0.04 * (rawTop - bottom), cy = (top + bottom) / 2;
  const dist = ((top - bottom) / 2) / Math.tan((camera.fov / 2) * (Math.PI / 180)) * 1.03;
  camera.position.set(0, cy + 0.03 * (top - bottom), head.z + dist);
  camera.lookAt(0, cy, head.z);
  camera.updateMatrixWorld();
}

// IK targets + poles as the solver received them (last call per arm per frame wins: guardHead re-solves)
const ikSeen = { left: null, right: null }, ikCalls = { left: 0, right: 0 };
const solveArm0 = rig.solveArm.bind(rig);
rig.solveArm = (arm, target, pole) => {
  const side = arm === rig.arms.left ? 'left' : 'right';
  ikSeen[side] = { target: target.clone(), pole: pole.clone() };
  ikCalls[side]++;
  return solveArm0(arm, target, pole);
};

// ---------- torso surface (skinned, per frame) ----------
const V = () => new THREE.Vector3();
const TORSO_BONES = ['spine', 'chest', 'upperChest', 'hips', 'neck'];
const torsoVerts = []; // { mesh, i, n0 (rest normal, mesh space) }
{
  const raws = new Set(TORSO_BONES.map((n) => vrm.humanoid.getRawBoneNode(n)).filter(Boolean));
  vrm.scene.traverse((o) => {
    if (!o.isSkinnedMesh || !o.geometry.attributes.skinIndex || !o.geometry.attributes.normal) return;
    const g = o.geometry, sI = g.attributes.skinIndex, sW = g.attributes.skinWeight, N = g.attributes.normal;
    const idx = o.skeleton.bones.map((b) => raws.has(b));
    for (let i = 0; i < g.attributes.position.count; i++) {
      let w = 0;
      for (let k = 0; k < 4; k++) if (idx[sI.getComponent(i, k)]) w += sW.getComponent(i, k);
      if (w >= 0.7) torsoVerts.push({ mesh: o, i, n0: V().fromBufferAttribute(N, i) });
    }
  });
}
const torsoPos = torsoVerts.map(() => V());
function skinTorso() {
  for (let j = 0; j < torsoVerts.length; j++) torsoVerts[j].mesh.getVertexPosition(torsoVerts[j].i, torsoPos[j]).applyMatrix4(torsoVerts[j].mesh.matrixWorld);
}
function torsoDepth(p) { // > 0: metres inside the torso surface (nearest skinned vertex, its skinned normal)
  let best = Infinity, bj = -1;
  for (let j = 0; j < torsoPos.length; j++) { const d = torsoPos[j].distanceToSquared(p); if (d < best) { best = d; bj = j; } }
  if (bj < 0 || best > 0.03 * 0.03) return { depth: -Infinity }; // only judged near the surface; deeper = the core test
  const tv = torsoVerts[bj], m = tv.mesh;
  const a = m.getVertexPosition(tv.i, V());
  // skinned normal: skin a point a little along the rest normal
  const geomPos = V().fromBufferAttribute(m.geometry.attributes.position, tv.i);
  const morphFree = geomPos.clone().addScaledVector(tv.n0, 0.01);
  const b = morphFree.clone().applyMatrix4(m.bindMatrix);
  const skinned = V();
  const sI = m.geometry.attributes.skinIndex, sW = m.geometry.attributes.skinWeight, mat = new THREE.Matrix4();
  for (let k = 0; k < 4; k++) {
    const w = sW.getComponent(tv.i, k);
    if (!w) continue;
    const bi = sI.getComponent(tv.i, k);
    mat.multiplyMatrices(m.skeleton.bones[bi].matrixWorld, m.skeleton.boneInverses[bi]);
    skinned.addScaledVector(b.clone().applyMatrix4(mat), w);
  }
  skinned.applyMatrix4(m.bindMatrixInverse);
  const n = skinned.sub(a).transformDirection(m.matrixWorld);
  const vw = torsoPos[bj];
  // inside only when the point lies along the inward normal (a point off to the side of the nearest vertex, e.g. past
  // the edge of the torso part of the mesh, is not judged)
  const d = V().subVectors(p, vw), along = -d.dot(n);
  return { depth: along > 0 && along >= 0.7 * d.length() ? along : -d.length(), vertex: bj };
}

// ---------- hand points ----------
const nb = (n) => vrm.humanoid.getNormalizedBoneNode(n);
function handPoints(side) {
  const pre = side;
  const pts = { wrist: nb(`${pre}Hand`).getWorldPosition(V()) };
  const mp = nb(`${pre}MiddleProximal`);
  if (mp) pts.palm = V().lerpVectors(pts.wrist, mp.getWorldPosition(V()), 0.6);
  for (const f of ['Index', 'Middle', 'Little', 'Thumb']) {
    const a = nb(`${pre}${f}${f === 'Thumb' ? 'Proximal' : 'Intermediate'}`), b = nb(`${pre}${f}Distal`);
    if (!a || !b) continue;
    const pa = a.getWorldPosition(V()), pb = b.getWorldPosition(V());
    pts[`${f.toLowerCase()}Tip`] = pb.clone().addScaledVector(V().subVectors(pb, pa), 0.9);
  }
  return pts;
}

// ---------- frame stepping ----------
const dt = 1 / FPS;
function step() { ikCalls.left = 0; ikCalls.right = 0; vclock += 1000 * dt; engine.update(dt); vrm.scene.updateMatrixWorld(true); }
function reset() {
  engine.player.stopAll(true);
  engine.states.clear();
  rig.routes.clear();
  engine.resetForTest();
  seed = 7;
  engine.life.phase = [0, 1, 2, 3, 4, 5].map(() => random() * 100);
  engine.life.blinkNext = vclock + 99999; // no blink noise in the measurement
  for (let i = 0; i < FPS; i++) step();
}
const variant = (trigger, id) => catalog.get(trigger).variants.find((v) => v.id === id).command;
// play(cmd, {side, jitter: 'min'|'max'|null})
function play(cmd, { side = 1, jitter = null } = {}) {
  const r0 = engine.player.random;
  if (jitter) engine.player.random = () => (jitter === 'max' ? 0.9999 : 0);
  const res = engine.player.play(cmd, { side });
  engine.player.random = r0;
  if (!res.ok) throw new Error(res.errors.join('; '));
  return res.id;
}

const DEGF = 180 / Math.PI;
const angle = (q1, q2) => 2 * Math.acos(Math.min(1, Math.abs(q1.dot(q2)))) * DEGF;
function axialTwist(qLocal) { // rotation about the bone's own X axis (normalized bones: X runs along the arm)
  const t = new THREE.Quaternion(qLocal.x, 0, 0, qLocal.w).normalize();
  return 2 * Math.atan2(t.x, t.w) * DEGF;
}

// scenario: { name, labelVi, setup(): returns markMs (t=0 of the reaction under test), frames after }
function run(sc) {
  reset();
  pendingAt = [];
  // FACE-CLEARANCE and HAND-SHAPE apply to the startle scenarios only: a startle's hands must never cross the face,
  // and must read as open (not a closed fist / thumbs-up). Approved gestures that legitimately touch near the face
  // (giggle -> mouth, think -> chin) are not named 'startle' and are not covered by either guard; a startle cutting
  // INTO one of those (e.g. 'poke-startle during typing/chin-think') IS named 'startle' and is covered, but only
  // from its own t>0 (the pre-roll chin-think touch is dropped below, same as every other check here), and any
  // carried-over frame right after is downgraded to warn by the existing carry-over rule a few lines down.
  const startleScenario = sc.name.includes('startle');
  const t0 = sc.setup();
  const events = pendingAt;
  const frames = [];
  const prev = { left: null, right: null };
  // setup() schedules the reaction under test a little ahead (its start = t0), so the recording begins before it
  const total = Math.ceil((t0 - vclock + 1800) / (1000 * dt));
  for (let f = 0; f < total; f++) {
    for (const ev of events) if (!ev.done && vclock + 1e-6 >= ev.ms) { ev.done = true; ev.fn(); }
    step();
    skinTorso();
    const tMs = Math.round(vclock - t0);
    const fr = { f, tMs, sides: {} };
    for (const side of ['left', 'right']) {
      const arm = rig.arms[side];
      const qU = arm.upper.getWorldQuaternion(new THREE.Quaternion()), qL = arm.lower.getWorldQuaternion(new THREE.Quaternion()), qH = arm.hand.getWorldQuaternion(new THREE.Quaternion());
      const sh = arm.upper.getWorldPosition(V()), el = arm.lower.getWorldPosition(V()), wr = arm.hand.getWorldPosition(V());
      const flex = Math.acos(Math.max(-1, Math.min(1, V().subVectors(el, sh).normalize().dot(V().subVectors(wr, el).normalize())))) * DEGF;
      const twL = axialTwist(arm.lower.quaternion), twU = axialTwist(arm.upper.quaternion);
      const pts = handPoints(side);
      let deepest = { depth: -Infinity };
      const chestInv = rig.frame(rig.chestNode).clone().invert();
      let inCore = null;
      let inFace = null; // FACE-CLEARANCE: startle scenarios only (see faceHit/faceBox above)
      const faceReachActive = [...rig.routes.keys()].some((k2) => k2.startsWith(`${side}|`) && FACE_REACH_TARGETS.has(k2.slice(side.length + 1)));
      for (const [k, p] of Object.entries(pts)) {
        const d = torsoDepth(p); if (d.depth > deepest.depth) deepest = { ...d, point: k };
        const cf = core ? coreF(core, p.clone().applyMatrix4(chestInv)) : Infinity;
        if (cf < 1 && (!inCore || cf < inCore.f)) inCore = { point: k, f: +cf.toFixed(3) };
        if (startleScenario && !faceReachActive) {
          const l = faceHit(p);
          if (l && (!inFace || l.y > inFace.y)) inFace = { point: k, y: l.y };
        }
      }
      // HAND-SHAPE (startle scenarios only): an open hand should not read as a closed-fist thumbs-up. Two independent
      // signals, read straight off the rig rather than re-derived geometrically: the thumb tip's height above the
      // index MCP (chest-local up — the thumb lying alongside the index sits at/below it; a raised thumb reads as
      // thumbs-up even when the other four fingers are barely curled, which is exactly the 'open' shape's bug: its
      // thumbIn is 0, so the thumb stays at its bind-pose direction instead of folding in alongside the fingers) and
      // each finger's own total curl in rig.fingers (the 3 joints' local Z rotation, exactly what applyHands sets —
      // no need to re-derive it from world positions), so a future shape blend that drifts toward a fist is caught
      // even if it never makes the thumb rise.
      // Only judged while the startle's own 'hands' request is actually asserting a shape (shapeAsserted: at least
      // one finger meaningfully curled) AND no face-kind reach is concurrently active for this side (faceReachActive,
      // same exclusion as FACE-CLEARANCE above). Both gates exist for the same reason: once the startle's own hand
      // weight fades through its outMs, curl eases back toward 0 and the model's BIND-POSE finger direction takes
      // over — on zumi-v3 that bind pose itself reads as a mild thumbs-up. That is not the startle's hand pose
      // (nothing is asserting a shape any more); it is either the model's neutral rest, or — when a sustained gesture
      // the startle interrupted (chin-think: 'chin', pat/happy-wiggle: 'chest', both without their own 'hands') is
      // resuming its own reach — that OTHER gesture's business, same as the chin-touch itself is not this guard's
      // business.
      let handShape = null;
      if (startleScenario && !faceReachActive) {
        const curls = {};
        for (const fn of ['index', 'middle', 'ring', 'little']) curls[fn] = rig.fingers[side][fn].reduce((a, n) => a + Math.abs(n.rotation.z * DEGF), 0);
        if (Math.max(...Object.values(curls)) >= LIMIT.handShapeFloorDeg) {
          const idxMcp = nb(`${side}IndexProximal`);
          const thumbRiseCm = idxMcp && pts.thumbTip ? (pts.thumbTip.clone().applyMatrix4(chestInv).y - idxMcp.getWorldPosition(V()).applyMatrix4(chestInv).y) * 100 : null;
          handShape = { thumbRiseCm, curls };
        }
      }
      const ik = ikSeen[side];
      // wrist behind the back: chest-local, inside the body's width, between the hips and the top of the chest box
      const bx = rig.surf && rig.surf.chestBox;
      let behind = -Infinity;
      if (bx) {
        const lw = wr.clone().applyMatrix4(rig.frame(rig.chestNode).clone().invert());
        const hipsY = rig.nodes.hips.getWorldPosition(V()).applyMatrix4(rig.frame(rig.chestNode).clone().invert()).y;
        if (Math.abs(lw.x) < bx.max.x && lw.y > hipsY - 0.1 && lw.y < bx.max.y) behind = bx.min.z - lw.z;
      }
      const s = { guard: ikCalls[side] - 1, inCore, inFace, handShape, behind, wr, el, flex, twL, twU, qU, qL, qH, deep: deepest, ikT: ik && ik.target, ikP: ik && ik.pole, route: [...rig.routes.entries()].filter(([k2]) => k2.startsWith(side)).map(([k2, v]) => `${k2.split('|')[1]}:${v.via ? 'via-side' : 'arc'}`).join(' ') };
      const p = prev[side];
      if (p) {
        s.angU = angle(p.qU, qU) * FPS; s.angL = angle(p.qL, qL) * FPS; s.angH = angle(p.qH, qH) * FPS; // deg/s
        const wrap = (d) => Math.abs(((d + 540) % 360) - 180); // twist is an angle: -179 -> 179 is 2 deg, not 358
        s.dTwL = wrap(twL - p.twL) * (60 / FPS); s.dTwU = wrap(twU - p.twU) * (60 / FPS);
        s.wrSpeed = wr.distanceTo(p.wr) * FPS;
        s.ikSpeed = ik && p.ikT ? ik.target.distanceTo(p.ikT) * FPS : 0;
        s.poleTurn = ik && p.ikP ? Math.acos(Math.max(-1, Math.min(1, ik.pole.clone().normalize().dot(p.ikP.clone().normalize())))) * DEGF * (60 / FPS) : 0;
      }
      prev[side] = s;
      fr.sides[side] = s;
    }
    frames.push(fr);
  }
  // findings
  const finds = [];
  for (const side of ['left', 'right']) {
    for (const [key, lab] of [['angU', 'upper arm'], ['angL', 'forearm'], ['angH', 'hand']]) {
      for (let i = 1; i < frames.length; i++) {
        const v = frames[i].sides[side][key];
        if (v == null) continue;
        const around = [];
        for (let j = Math.max(1, i - 3); j <= Math.min(frames.length - 1, i + 3); j++) if (j !== i && frames[j].sides[side][key] != null) around.push(frames[j].sides[side][key]);
        around.sort((a, b) => a - b);
        const med = around.length ? around[around.length >> 1] : 0;
        const pv = frames[i - 1].sides[side][key] || 0;
        if (pv < 0.1 * v) continue; // a move starting from rest (the attack starts at its top speed): reported as onset
        if (v > LIMIT.spikeFloorDegS && v > LIMIT.spikeRatio * Math.max(med, 1)) finds.push({ side, f: i, tMs: frames[i].tMs, sev: 'warn', what: `${lab} turns ${v.toFixed(0)} deg/s (median around ${med.toFixed(0)})` });
      }
    }
    for (let i = 1; i < frames.length; i++) {
      const s = frames[i].sides[side];
      if (s.dTwL > LIMIT.twistDegPerFrame60) finds.push({ side, f: i, tMs: frames[i].tMs, sev: 'hard', what: `forearm twist jumps ${s.dTwL.toFixed(1)} deg/frame60` });
      if (s.poleTurn > LIMIT.poleFlipDeg) finds.push({ side, f: i, tMs: frames[i].tMs, sev: 'hard', what: `elbow pole turns ${s.poleTurn.toFixed(0)} deg/frame60` });
      const around = [];
      for (let j = Math.max(1, i - 3); j <= Math.min(frames.length - 1, i + 3); j++) if (j !== i) around.push(frames[j].sides[side].wrSpeed || 0);
      around.sort((a, b) => a - b);
      const med = around[around.length >> 1] || 0;
      if (s.wrSpeed > 1 && (frames[i - 1].sides[side].wrSpeed || 0) >= 0.1 * s.wrSpeed && s.wrSpeed > LIMIT.spikeRatio * Math.max(med, 0.05)) finds.push({ side, f: i, tMs: frames[i].tMs, sev: 'warn', what: `wrist speed spikes to ${s.wrSpeed.toFixed(2)} m/s (median around ${med.toFixed(2)})` });
      if (s.inCore) finds.push({ side, f: i, tMs: frames[i].tMs, sev: 'hard', what: `${s.inCore.point} inside the torso core (f ${s.inCore.f})` });
      if (s.inFace) finds.push({ side, f: i, tMs: frames[i].tMs, sev: 'hard', what: `${s.inFace.point} inside the face box (${((s.inFace.y - faceBox.chinY) * 100).toFixed(1)} cm above the chin)` });
      if (s.handShape) {
        const { thumbRiseCm, curls } = s.handShape;
        if (thumbRiseCm != null && thumbRiseCm > LIMIT.thumbRiseCm) finds.push({ side, f: i, tMs: frames[i].tMs, sev: 'hard', what: `thumb tip ${thumbRiseCm.toFixed(1)} cm above the index MCP (ceiling ${LIMIT.thumbRiseCm}) — reads as thumbs-up` });
        for (const [fn, deg] of Object.entries(curls)) if (deg > LIMIT.fingerCurlCeilingDeg) finds.push({ side, f: i, tMs: frames[i].tMs, sev: 'hard', what: `${fn} finger curl ${deg.toFixed(0)} deg over the ${LIMIT.fingerCurlCeilingDeg} deg ceiling — reads as a closed fist` });
      }
      if (s.behind > LIMIT.behindM) finds.push({ side, f: i, tMs: frames[i].tMs, sev: 'hard', what: `wrist ${(s.behind * 100).toFixed(1)} cm behind the back of the torso` });
      if (s.deep.depth > LIMIT.handDepthM) finds.push({ side, f: i, tMs: frames[i].tMs, sev: 'warn', what: `${s.deep.point} ${(s.deep.depth * 100).toFixed(1)} cm inside the torso surface` });
    }
  }
  const peak = (side, key) => Math.max(0, ...frames.map((fr) => fr.sides[side][key] || 0));
  const summary = {};
  for (const side of ['left', 'right']) summary[side] = {
    maxAngU: +peak(side, 'angU').toFixed(0), maxAngL: +peak(side, 'angL').toFixed(0), maxAngH: +peak(side, 'angH').toFixed(0),
    maxTwistStep: +peak(side, 'dTwL').toFixed(1), maxPoleTurn: +peak(side, 'poleTurn').toFixed(0), maxWrist: +peak(side, 'wrSpeed').toFixed(2), maxIk: +peak(side, 'ikSpeed').toFixed(2),
    maxDepthCm: +(Math.max(...frames.map((fr) => fr.sides[side].deep.depth)) * 100).toFixed(1),
    maxFlex: +Math.max(...frames.map((fr) => fr.sides[side].flex)).toFixed(0),
    onsetWristMs: +Math.max(0, ...frames.map((fr, i) => (i && (frames[i - 1].sides[side].wrSpeed || 0) < 0.1 * (fr.sides[side].wrSpeed || 0) ? fr.sides[side].wrSpeed : 0))).toFixed(2),
    maxBehindCm: +(Math.max(...frames.map((fr) => fr.sides[side].behind)) * 100).toFixed(1),
    maxFaceCm: startleScenario ? +(Math.max(...frames.map((fr) => (fr.sides[side].inFace ? fr.sides[side].inFace.y - faceBox.chinY : -Infinity))) * 100).toFixed(1) : null,
    maxThumbRiseCm: startleScenario ? +Math.max(...frames.map((fr) => (fr.sides[side].handShape && fr.sides[side].handShape.thumbRiseCm != null ? fr.sides[side].handShape.thumbRiseCm : -Infinity))).toFixed(1) : null,
    maxFingerCurlDeg: startleScenario ? +Math.max(...frames.map((fr) => (fr.sides[side].handShape ? Math.max(...Object.values(fr.sides[side].handShape.curls)) : -Infinity))).toFixed(0) : null,
    routes: [...new Set(frames.map((fr) => fr.sides[side].route).filter(Boolean))].join(' | '),
  };
  return { frames, finds, summary };
}

// ---------- scenarios: every way the startle can play ----------
const startle = variant('poke', 'startle');
const SC = [];
for (const side of [1, -1]) for (const jitter of [null, 'min', 'max']) {
  SC.push({ name: `poke-startle side${side > 0 ? '+' : '-'}${jitter ? ` jitter-${jitter}` : ''}`, setup: () => { const t = vclock + 200; this_at(t, () => play(startle, { side, jitter })); return t; } });
}
SC.push({ name: 'wake-startle (after sleepy)', setup: () => {
  engine.trigger('sleepy'); // a sustained state, as after 2 idle minutes
  for (let i = 0; i < 3 * FPS; i++) step();
  const t = vclock + 200;
  this_at(t, () => { engine.exitState('sleepy'); play(variant('wake', 'startle-wake')); });
  return t;
} });
for (const [trigger, id] of [['poke', 'startle'], ['poke', 'giggle'], ['poke', 'pout']]) for (const gap of [150, 400, 800]) {
  SC.push({ name: `poke-startle ${gap} ms into ${trigger}/${id}`, setup: () => {
    play(variant(trigger, id), { side: 1 });
    const t = vclock + gap;
    this_at(t, () => play(startle, { side: 1 }));
    return t;
  } });
}
for (const [trigger, id] of [['typing', 'peek-lean'], ['typing', 'chin-think'], ['pat', 'happy-wiggle']]) {
  SC.push({ name: `poke-startle during ${trigger}/${id}`, setup: () => {
    play(variant(trigger, id), { side: 1 });
    for (let i = 0; i < FPS; i++) step();
    const t = vclock + 200;
    this_at(t, () => play(startle, { side: 1 }));
    return t;
  } });
}
for (const [intent, def] of lib.byIntent) {
  const v = def.variants[0];
  SC.push({ name: `poke-startle 500 ms into speech ${intent}/${v.id}`, setup: () => {
    play(v.command, { side: 1 });
    const t = vclock + 500;
    this_at(t, () => play(startle, { side: 1 }));
    return t;
  } });
}
// reference: the same measurement on reactions that do not startle (other built-ins, the speech library), so the limits
// are judged against motion the owner has already seen and accepted
for (const [trigger, id] of [['poke', 'giggle'], ['poke', 'pout'], ['focus', 'brighten'], ['pat', 'happy-wiggle'], ['typing', 'chin-think'], ['entrance', 'look-wave'], ['bored', 'stretch'], ['wake', 'rub-eyes']]) {
  SC.push({ name: `reference ${trigger}/${id}`, ref: true, setup: () => { const t = vclock + 200; this_at(t, () => play(variant(trigger, id), { side: 1 })); return t; } });
}
for (const [intent, def] of lib.byIntent) for (const v of def.variants) {
  SC.push({ name: `reference speech ${intent}/${v.id}`, ref: true, setup: () => { const t = vclock + 200; this_at(t, () => play(v.command, { side: 1 })); return t; } });
}
let pendingAt = [];
function this_at(ms, fn) { pendingAt.push({ ms, fn, done: false }); }

let bad = 0;
const all = [];
for (const sc of SC) {
  if (only && !only.has(sc.name)) continue;
  const res = run(sc);
  // only frames from the reaction under test on count (the pre-roll belongs to whatever was playing before);
  // reference rows are measured for comparison and never fail the check
  // a defect that was already there in the last pre-roll frame and runs on unbroken from t=0 belongs to the gesture
  // that was playing (e.g. its hand-on-hip pose), not to this reaction: kept as a warning
  const kind = (fd) => `${fd.side}|${fd.what.replace(/[\d.]+/g, '#')}`;
  const lastPre = Math.max(...res.frames.filter((fr) => fr.tMs <= 0).map((fr) => fr.f)); // the reaction is played at the start of the first frame with t > 0
  for (const k of new Set(res.finds.filter((fd) => fd.f === lastPre).map(kind))) {
    let f = lastPre + 1;
    for (;;) { const hit = res.finds.filter((fd) => fd.f === f && kind(fd) === k); if (!hit.length) break; for (const fd of hit) { fd.sev = 'warn'; fd.what += ' (carried over from the gesture before)'; } f++; }
  }
  res.finds = res.finds.filter((fd) => fd.tMs > 0);
  const hard = res.finds.filter((fd) => fd.sev === 'hard');
  const ok = hard.length === 0;
  if (!ok && !sc.ref) bad++;
  console.log(`${sc.ref ? (ok ? 'REF ok ' : 'REF bad') : ok ? 'PASS' : 'FAIL'}${res.finds.length > hard.length ? ' +warn' : ''} ${sc.name}: L ${JSON.stringify(res.summary.left)} R ${JSON.stringify(res.summary.right)}`);
  const shown = new Map();
  for (const fd of res.finds) { const k = `${fd.side}|${fd.what.replace(/[\d.]+/g, '#')}`; shown.set(k, [...(shown.get(k) || []), fd]); }
  for (const list of shown.values()) {
    const fd = list[0];
    console.log(`       ${fd.sev === 'hard' ? 'HARD' : 'warn'} ${fd.side}: ${fd.what} at t=${fd.tMs} ms (frame ${fd.f} @${FPS} Hz)${list.length > 1 ? ` + ${list.length - 1} more frame(s): ${list.slice(1, 8).map((x) => `${x.tMs}ms ${x.what.match(/[\d.]+/)[0]}`).join(', ')}` : ''}`);
  }
  all.push({ name: sc.name, summary: res.summary, finds: res.finds, frames: res.frames.map((fr) => ({ f: fr.f, tMs: fr.tMs, ...Object.fromEntries(Object.entries(fr.sides).map(([sd, s]) => [sd, { flex: +s.flex.toFixed(1), angU: s.angU && +s.angU.toFixed(0), angL: s.angL && +s.angL.toFixed(0), angH: s.angH && +s.angH.toFixed(0), dTwL: s.dTwL && +s.dTwL.toFixed(1), pole: s.poleTurn && +s.poleTurn.toFixed(0), wr: s.wrSpeed && +s.wrSpeed.toFixed(2), ik: s.ikSpeed && +s.ikSpeed.toFixed(2), depthCm: +(s.deep.depth * 100).toFixed(1), guard: s.guard, core: s.inCore && `${s.inCore.point} ${s.inCore.f}`, face: s.inFace && `${s.inFace.point} ${((s.inFace.y - faceBox.chinY) * 100).toFixed(1)}cm`, hand: s.handShape && { thumbRiseCm: s.handShape.thumbRiseCm != null ? +s.handShape.thumbRiseCm.toFixed(1) : null, curls: Object.fromEntries(Object.entries(s.handShape.curls).map(([fn, d]) => [fn, +d.toFixed(0)])) }, behindCm: Number.isFinite(s.behind) ? +(s.behind * 100).toFixed(1) : null, at: s.deep.point, route: s.route, wrist: s.wr.toArray().map((x) => +x.toFixed(3)) }])) })) });
}
// the speech-gesture rig rules (R1-R5; R6 is the 1.5-3.5 s length of a speech gesture and does not apply to a reflex)
const rigRules = {};
{
  const probe = await RigProbe.create({ loader, bytes: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), stageCamera: camera, catalog: null, prepare: prepareVrm });
  for (const [trigger, id] of [['poke', 'startle'], ['wake', 'startle-wake']]) for (const flip of [false, true]) {
    const r = probe.check(variant(trigger, id), { flip });
    const fails = r.fails.filter((x) => x !== 'R6');
    const rr = r.rules;
    rigRules[`${trigger}/${id}${flip ? ' mirrored' : ''}`] = { ok: fails.length === 0, fails, R1minF: rr.R1.minF, R2hits: rr.R2.hits, R2deepest: rr.R2.deepest, R3: { flex: rr.R3.maxFlexDeg, twist: rr.R3.maxTwistDeg }, R4: rr.R4.maxDriftM, R5: rr.R5.delta, durationMs: r.durationMs };
    console.log(`rig rules ${trigger}/${id}${flip ? ' mirrored' : ''}: ${fails.length ? `fails ${fails}` : 'R1-R5 ok'} · R1 ${rr.R1.minF} · R2 ${rr.R2.hits.length} hit(s) ${JSON.stringify(rr.R2.hits.slice(0, 2))} · flex ${rr.R3.maxFlexDeg} · twist ${rr.R3.maxTwistDeg} · feet ${rr.R4.maxDriftM} · back ${rr.R5.delta} · ${r.durationMs} ms (R6 n/a)`);
    if (fails.length) bad++;
  }
}
if (outDir) { fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(path.join(outDir, 'motion.json'), JSON.stringify({ model: path.basename(modelPath), fps: FPS, limits: LIMIT, rigRules, scenarios: all }, null, 1)); }
console.log(`check:motion ${bad ? `${bad} scenario(s) over a limit` : 'all within limits'} · ${torsoVerts.length} torso vertices · ${FPS} Hz`);
process.exit(bad ? 1 : 0);
