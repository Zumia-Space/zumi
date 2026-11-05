// Rig rules (R1-R5: no face-crossing, no torso-core path, joint sanity, feet planted, returns to idle) AND the
// HAND-SHAPE hard guard, for every Jev body variant, headless in Node -- the exact wiring app.js uses in
// production (jevSelector.warm(rigVersion, rigCheck) with rigCheck = (cmd, opts) => this file's gate(cmd, opts)).
//
// HAND-SHAPE (coordinator QC round 2 on sheet-v3): rig.js's 'open' HAND_SHAPES preset (thumbIn 0) leaves the
// thumb at its bind-pose direction, which reads as a thumbs-up on this rig once any other finger gets curl --
// scripts/check-motion.mjs already hard-guards exactly this for the startle poke/wake scenarios (thumb-tip rise
// above the index MCP, finger curl ceiling); this file runs the SAME measurement (same math, same ceilings: 3cm
// thumb rise, 60deg finger curl, 15deg floor before a shape even counts as "asserted") for EVERY Jev pool entry
// -- base, derived, both hands -- not just startle, and folds it into the same rigCheck gate R1-R5 already uses,
// so a variant that reads as a thumbs-up (or, by the same floor/ceiling logic, a closed fist where none was
// meant) is excluded from the pool, not just reported.
//   npm run check:jev-rig -- --model <file.vrm>        (or ZUMI_TEST_MODEL; default: the shipped default avatar)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
// no --model / ZUMI_TEST_MODEL: the shipped default avatar (resources-pinned/default-model/PIN-MANIFEST.json)
const defaultVrmPath = () => createRequire(import.meta.url)('./lib/default-vrm.cjs').resolveSource();

globalThis.self = globalThis;
globalThis.window = globalThis;
globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });

const THREE = await import('three');
const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
const { VRMLoaderPlugin } = await import('@pixiv/three-vrm');
const { prepareVrm } = await import('../src/renderer/model-facing.js');
const { RigProbe } = await import('../src/renderer/talk/rigprobe.js');
const { JEV_LABELS, JEV_BODY } = await import('../src/renderer/talk/jevlabels.js');
const { JevSelector } = await import('../src/renderer/talk/jevSelector.js');
const { SpeechLibrary } = await import('../src/renderer/talk/library.js');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const argAt = process.argv.indexOf('--model');
const modelPath = argAt >= 0 ? process.argv[argAt + 1] : (process.env.ZUMI_TEST_MODEL || defaultVrmPath());
if (!fs.existsSync(modelPath)) { console.error(`model not found: ${modelPath} (usage: npm run check:jev-rig -- --model <file.vrm>)`); process.exit(2); }

const buf = fs.readFileSync(modelPath);
const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const loader = new GLTFLoader();
loader.register((p) => new VRMLoaderPlugin(p));
// The app's own load path (src/renderer/app.js), not an inline copy: prepareVrm() also captures the model's base
// orientation, which Rig's body-frame IK rest frames need -- an inline clean-up skips the capture, so a VRM 0.x
// model would silently exercise the pre-round-3 (rolled) math here.
const prepare = prepareVrm;
const camera = new THREE.PerspectiveCamera(28, 1280 / 742, 0.05, 50);
const probe = await RigProbe.create({ loader, bytes, stageCamera: camera, catalog: null, prepare });

// ---------- HAND-SHAPE hard guard: thumbs-up (check-motion.mjs's own thumb-rise calibration). NOT a blanket
// "no fist" rule -- think-chin's right hand is shape:'fist' on purpose (owner-approved reflex/speech/think.json
// think-hand-on-chin-s1, which check-motion.mjs itself exempts from its own fist-curl ceiling for the same
// reason: a hand genuinely supporting the chin is meant to be closed, that is the meaning, not an accident).
// The coordinator's ask is specifically "no thumbs-up or pointing unless the meaning is explicitly that" --
// pointing never occurs here (no Jev variant authors shape:'point', asserted structurally below), so this guard
// covers thumbs-up, the one failure mode actually observed (sheet-v2/v3: 'open'/'relaxed' read as thumbs-up).
const DEGF = 180 / Math.PI;
const V = () => new THREE.Vector3();
const FLOOR_DEG = 15; // below this (max curl across the 4 fingers), no shape is asserted yet -- not judged
const THUMB_RISE_CM = 3; // thumb tip above the index MCP before an open hand reads as a thumbs-up
const THUMB_OUT_CM = 3; // ... and this far out of the hand's own plane (local Z) before that rise is a thumbs-up
// rather than a correctly tucked thumb. The chest-up rise alone cannot tell a raised thumb from a TUCKED one on a
// vertical hand (a wave): with the fingers pointing up, a thumb folded across the palm sits "above the knuckle" in
// chest-up by construction, while the broken 'open' shape (thumbIn 0) sticks 6 cm out of the plane on this rig and
// is the one that reads as a thumbs-up. Measured in the HAND frame, so it is a pure property of the shape, not of
// the arm pose. (The Jev pass keeps its original chest-up-only rule; this condition is for the built-in pass.)

function nb(side, bone) { return probe.vrm.humanoid.getNormalizedBoneNode(`${side}${bone}`); }
// The tip is ONLY the real Distal bone, as before: some VRM 0.x bodies (CoolTiger.vrm) map the thumb as
// Metacarpal+Proximal and ship no Distal on any digit. Extrapolating the tip from Proximal->Metacarpal was
// measured on that body and gave 'open-flat' and 'thumbsUp' the SAME 8.6 cm rise, so it cannot discriminate;
// it is not used. Instead, pts.lacks names the bones that are absent, so handShapeViolations can report the
// sample as "unmeasurable" rather than silently passing it. Ring stays out: the guard needs the thumb tip and
// the index MCP only (unchanged from before).
function handPoints(side) {
  const wristNode = nb(side, 'Hand');
  if (!wristNode) return null;
  const pts = { wrist: wristNode.getWorldPosition(V()), lacks: [] };
  for (const f of ['Index', 'Middle', 'Little', 'Thumb']) {
    const aSeg = f === 'Thumb' ? 'Proximal' : 'Intermediate';
    const a = nb(side, `${f}${aSeg}`), b = nb(side, `${f}Distal`);
    if (!a || !b) { // no real distal tip: this digit is not measured at all
      if (!a) pts.lacks.push(`${f}${aSeg}`);
      if (!b) pts.lacks.push(`${f}Distal`);
      continue;
    }
    const pa = a.getWorldPosition(V()), pb = b.getWorldPosition(V());
    pts[`${f.toLowerCase()}Tip`] = pb.clone().addScaledVector(V().subVectors(pb, pa), 0.9);
  }
  return pts;
}
// cmd: already-gated command. side: 1 | -1 (mirror). opts: { floorDeg, faceReachExempt, outOfPlaneCm }.
//   -> [] | ["<why>", ...]. Entries prefixed 'unmeasurable: ' mean a shape WAS asserted but this side's thumb tip
//   (or the index MCP it is measured against) does not exist on this body: never a silent pass, and never a
//   violation either -- the caller decides whether that is WARN (built-ins) or excluded (Jev pool).
//   floorDeg: the Jev pass keeps 15 (a variant's own shape must be asserted before it is judged). The
//   built-in/speech pass uses 0, because there is no authored shape at all in most built-ins: the model's
//   own bind-pose hand (thumbIn 0), rotated by an arm reach, is exactly the reported thumbs-up -- waiting
//   for "a shape" would skip every frame of it.
//   faceReachExempt: don't judge a hand whose side currently has a face-kind reach live (chin/mouth/face/eye)
//   -- the same rule check-motion.mjs already ships: a hand genuinely placed on the face (giggle -> mouth,
//   yawn -> mouth, rub-eyes -> eye, chin-think -> chin) is that contact's business, and its orientation
//   through the touch and withdrawal is governed by the face contact, not by a thumbs-up intent.
const FACE_REACH_KINDS = new Set(['chin', 'mouth', 'face', 'eye']);
function handShapeViolations(cmd, side, { floorDeg = FLOOR_DEG, faceReachExempt = false, outOfPlaneCm = 0 } = {}) {
  const e = probe.engine, rig = probe.rig;
  e.player.stopAll(true);
  rig.routes.clear();
  probe.settle(25);
  const playCmd = side === -1 ? { ...cmd, mirror: 'random' } : cmd;
  const res = e.player.play(playCmd, { noJitter: true, side: side === -1 ? -1 : 1 });
  if (!res.ok) return [`does not play: ${res.errors.join('; ')}`];
  const inst = e.player.find(res.id);
  const durRaw = e.player.duration(inst);
  const durationMs = Number.isFinite(durRaw) ? durRaw : 2600; // sustained commands (holdMs -1) never end on their own
  const dt = 1 / 60;
  const frames = Math.ceil((durationMs + 300) / (dt * 1000));
  const worst = { left: -Infinity, right: -Infinity }; // worst qualifying chest-up rise per side
  const asserted = { left: 0, right: 0 }; // frames where a shape was asserted on that side
  const measured = { left: 0, right: 0 }; // ... of those, frames where a thumb tip + index MCP were actually measured
  const lacks = { left: new Set(), right: new Set() }; // bones that stopped a measurement, per side
  for (let f = 0; f < frames; f++) {
    probe.step(dt);
    const chestInv = new THREE.Matrix4().copy(rig.frame(rig.chestNode)).invert();
    for (const sd of ['left', 'right']) {
      if (!rig.fingers[sd]) continue;
      if (faceReachExempt && [...rig.routes.keys()].some((k) => k.startsWith(`${sd}|`) && FACE_REACH_KINDS.has(k.slice(sd.length + 1)))) continue;
      const curls = {};
      for (const fn of ['index', 'middle', 'ring', 'little']) curls[fn] = (rig.fingers[sd][fn] || []).reduce((a, n) => a + (n ? Math.abs(n.rotation.z * DEGF) : 0), 0);
      if (Math.max(...Object.values(curls)) < floorDeg) continue; // no shape asserted yet (ramp in/out, or none)
      asserted[sd]++;
      const pts = handPoints(sd), idxMcp = nb(sd, 'IndexProximal');
      if (!pts) { lacks[sd].add('Hand'); continue; }
      if (!pts.thumbTip) for (const l of pts.lacks) lacks[sd].add(l);
      if (!idxMcp) lacks[sd].add('IndexProximal');
      if (!pts.thumbTip || !idxMcp) continue;
      measured[sd]++;
      const riseCm = (pts.thumbTip.clone().applyMatrix4(chestInv).y - idxMcp.getWorldPosition(V()).applyMatrix4(chestInv).y) * 100;
      if (riseCm <= THUMB_RISE_CM || riseCm <= worst[sd]) continue;
      if (outOfPlaneCm > 0) { // orientation-independent: is the thumb actually sticking out of the hand's plane?
        const handNode = nb(sd, 'Hand');
        const hInv = new THREE.Matrix4().copy(handNode.matrixWorld).invert();
        const off = pts.thumbTip.clone().applyMatrix4(hInv).sub(idxMcp.getWorldPosition(V()).applyMatrix4(hInv));
        if (Math.abs(off.z) * 100 <= outOfPlaneCm) continue; // tucked alongside the fingers, not a thumbs-up
      }
      worst[sd] = riseCm;
    }
  }
  e.player.stopAll(true);
  rig.routes.clear();
  const out = ['left', 'right'].filter((sd) => worst[sd] > -Infinity).map((sd) => `${sd} thumb up to ${worst[sd].toFixed(1)}cm above the index MCP (thumbs-up)`);
  // A shape was asserted but nothing could be measured on that side: say so explicitly (with the missing bones)
  // instead of returning [] -- a body without Distal bones must never turn the guard into a silent pass.
  for (const sd of ['left', 'right']) {
    if (asserted[sd] > 0 && measured[sd] === 0) out.push(`unmeasurable: ${sd} hand lacks ${[...lacks[sd]].join(', ') || 'thumb tip'}`);
  }
  return out;
}

// FACE-CLEARANCE hard guard, ported for the built-in pass: the SAME "no face-crossing" ellipsoid test
// rigprobe.js's own probe.check() runs as rule R1 for every Jev pool entry and every speech variant (same
// rig.surf.head ellipsoid, same contact-aware radius/sample-chain: a genuine face touch -- giggle -> mouth,
// chin-think -> chin, rub-eyes -> eye -- is tested with the stricter (no +5cm margin) but SHORTER chain
// (elbow->wrist only, no fingertip extension), exactly like R1 does, so a real touch is not flagged as
// "crossing the face"). NOT reused by calling probe.check() directly: that function computes its own frame
// count from e.player.duration(inst) with no finite-duration fallback, which is Infinity for every built-in
// authored with "sustain": true (blur, pat, sleepy, typing's chin-think/peek-lean -- holdMs defaults to "hold
// until released", and nothing here ever releases one) -- an infinite loop, not a failure. This function is
// the same measurement with the SAME safe-duration pattern handShapeViolations above already uses.
function faceClearanceViolations(cmd, side) {
  const e = probe.engine, rig = probe.rig, S = rig.surf;
  if (!S) return [];
  e.player.stopAll(true);
  rig.routes.clear();
  probe.settle(25);
  const playCmd = side === -1 ? { ...cmd, mirror: 'random' } : cmd;
  const res = e.player.play(playCmd, { noJitter: true, side: side === -1 ? -1 : 1 });
  if (!res.ok) return [`does not play: ${res.errors.join('; ')}`];
  const inst = e.player.find(res.id);
  const durRaw = e.player.duration(inst);
  const durationMs = Number.isFinite(durRaw) ? durRaw : 2600; // sustained commands (holdMs -1) never end on their own
  const dt = 1 / 60;
  const frames = Math.ceil((durationMs + 300) / (dt * 1000));
  const headInv = new THREE.Matrix4();
  const worst = { left: Infinity, right: Infinity }; // worst (smallest = deepest inside) ellipsoid factor per side
  for (let f = 0; f < frames; f++) {
    const acc = probe.step(dt);
    headInv.copy(rig.frame(rig.nodes.head)).invert();
    for (const sd of ['left', 'right']) {
      const arm = rig.arms[sd];
      if (!arm) continue;
      const reqs = acc.reach.filter((q) => q.hand === sd && q.weight > 0.05);
      const contact = reqs.some((q) => typeof q.target === 'string' && FACE_REACH_KINDS.has(q.target) && q.weight > 0.5);
      const el = arm.lower.getWorldPosition(V()), wr = arm.hand.getWorldPosition(V());
      const { ellC: c, ellR: r0 } = S.head;
      const m = contact ? 0 : 0.05;
      const r = { x: r0.x + m, y: r0.y + m, z: r0.z + m };
      const tip = wr.clone().addScaledVector(V().subVectors(wr, el).normalize(), contact ? 0 : arm.handLen);
      const n = contact ? 5 : 8;
      for (let i = 0; i <= n; i++) {
        const p = i <= 5 ? V().lerpVectors(el, wr, i / 5) : V().lerpVectors(wr, tip, (i - 5) / 3);
        const l = p.applyMatrix4(headInv);
        const fv = Math.hypot((l.x - c.x) / r.x, (l.y - c.y) / r.y, (l.z - c.z) / r.z);
        if (fv < worst[sd]) worst[sd] = fv;
      }
    }
  }
  e.player.stopAll(true);
  rig.routes.clear();
  return ['left', 'right'].filter((sd) => worst[sd] < 0.97).map((sd) => `${sd} forearm/hand crosses the face (ellipsoid f ${worst[sd].toFixed(3)})`);
}

const fails = [];
const rigCheck = (cmd, opts) => {
  const r = probe.check(cmd, opts);
  const side = opts && opts.flip ? -1 : 1;
  const handViol = handShapeViolations(cmd, side).filter((s) => !s.startsWith('unmeasurable:')); // no Distal bones: not judged here
  const ok = r.ok && handViol.length === 0;
  if (!ok) fails.push({ cmd, opts, r, handViol });
  return { ok, fails: [...r.fails, ...(handViol.length ? ['HAND-SHAPE'] : [])], rules: r.rules };
};

const sel = new JevSelector({ log: (m) => console.log(`  ${m}`) });
console.log(`model ${path.basename(modelPath)} · torso core ${JSON.stringify(probe.core)} · head surfaces ${Boolean(probe.rig.surf)}`);
sel.warm('jev-rig-check', rigCheck); // throws if any label's pool goes empty -- see jevSelector.js buildBodyPool

let bad = 0;
// Structural half of "no thumbs-up or pointing unless the meaning is explicitly that": no Jev body variant may
// author shape:'point' or shape:'thumbsUp' at all (none of the 8 labels' meanings call for either). The thumbs-up
// FAILURE MODE actually observed (sheet-v2/v3) came from 'open'/'relaxed' reading as an accidental thumbs-up,
// which the geometric guard above catches; this catches the (so far hypothetical) case of authoring the literal
// shape outright.
for (const label of JEV_LABELS) {
  for (const base of JEV_BODY[label]) {
    for (const h of base.command.hands || []) {
      if (h.shape === 'point' || h.shape === 'thumbsUp') { bad++; console.log(`FAIL structural "${label}/${base.id}": hand shape '${h.shape}' is never meant by any of the 8 Jev labels`); }
    }
  }
}
const minFamilies = (label) => (label === 'neutral' ? 3 : 4);
for (const label of JEV_LABELS) {
  const pool = sel.bodyPool.get(label);
  const families = new Set(pool.map((v) => v.family));
  const ok = families.size >= minFamilies(label);
  if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'} "${label}": ${pool.length} eligible (${families.size} families: ${[...families].join(', ')}), need >= ${minFamilies(label)} families`);
}
for (const f of fails) {
  bad++;
  console.log(`FAIL rig ${JSON.stringify(f.cmd.id)} flip=${Boolean(f.opts && f.opts.flip)}: fails ${f.r.fails} · R1 ${f.r.rules.R1.minF} · R2 ${f.r.rules.R2.hits.length} hit(s) ${JSON.stringify(f.r.rules.R2.hits.slice(0, 2))} · flex ${f.r.rules.R3.maxFlexDeg} · twist ${f.r.rules.R3.maxTwistDeg}${f.handViol.length ? ` · HAND-SHAPE: ${f.handViol.join('; ')}` : ''}`);
}

// ---------- BUILT-IN REFLEX GESTURES + SPEECH LIBRARY: the SAME thumb-rise / pointing guard ----------
// Coordinator QC on the shipped app (window blur -> "Relaxed sigh" read as a thumbs-up): extend the guard
// beyond the Jev pool to every built-in variant in gestures/*.json (both sides) and every speech-library
// variant. Most built-ins author no hand shape at all -- the model's bind-pose 'open' (thumbIn 0) is rotated
// by the arm reach and the thumb sticks out of the hand's plane with zero finger curl -- so this pass judges
// with floor 0 (see handShapeViolations) and adds the hand-frame out-of-plane condition (THUMB_OUT_CM) that
// separates a raised thumb from a correctly tucked one on a vertical hand (a wave). Fix written into the app
// data: an explicit 'loose' (thumb tucked, exactly the Jev fix) wherever a posed hand had no shape at all or
// carried 'open'/'relaxed'; every reach and timing is untouched.
const GESTURE_DIR = path.join(ROOT, 'src', 'renderer', 'reflex', 'gestures');
const SPEECH_DIR = path.join(ROOT, 'src', 'renderer', 'reflex', 'speech');
const allCommands = [];
for (const trig of JSON.parse(fs.readFileSync(path.join(GESTURE_DIR, 'index.json'), 'utf8')).triggers) {
  const def = JSON.parse(fs.readFileSync(path.join(GESTURE_DIR, `${trig}.json`), 'utf8'));
  for (const v of def.variants) allCommands.push({ key: `gesture ${trig}/${v.id}`, cmd: v.command, mirrorBoth: true });
}
const speechLib = await SpeechLibrary.load(async (f) => JSON.parse(fs.readFileSync(path.join(SPEECH_DIR, f), 'utf8')));
for (const [intent, def] of speechLib.byIntent) for (const v of def.variants) allCommands.push({ key: `speech ${intent}/${v.id}`, cmd: v.command, mirrorBoth: false });

// "Exempt only a gesture whose MEANING is a thumbs-up or pointing": the authored point/thumbsUp shapes in the
// app's own data are speech point-screen (both variants point at the board) and the 0.2.7 board reaction
// gestures board/card-point-* (point at the card the board just flagged, hud-logic.js CARD_POINT maps) --
// deixis IS the meaning there ('point' on the pointing hand). No other built-in authors either shape.
const POINTING_MEANING = new Set([
  'speech point-screen/nod-and-point-to-the-right-s1', 'speech point-screen/nod-and-point-to-the-right-s2',
  ...['done', 'blocked', 'focused'].flatMap((s) => [`gesture board/card-point-${s}`, `gesture board/card-point-left-${s}`]),
]);

let builtinViolations = 0;
let builtinUnmeasurable = 0;
const unmeasurableBones = new Set(); // bones that made built-in samples unmeasurable, for the one WARN line
for (const { key, cmd } of allCommands) {
  for (const h of cmd.hands || []) {
    if ((h.shape === 'point' || h.shape === 'thumbsUp') && !POINTING_MEANING.has(key)) {
      builtinViolations++;
      console.log(`FAIL hand-shape "${key}": authors '${h.shape}', which is not this gesture's meaning`);
    }
  }
}
for (const { key, cmd, mirrorBoth } of allCommands) {
  for (const side of mirrorBoth ? [1, -1] : [1]) {
    const shown = `"${key}${side < 0 ? ' [mirror]' : ''}"`;
    const issues = handShapeViolations(cmd, side, { floorDeg: 0, faceReachExempt: true, outOfPlaneCm: THUMB_OUT_CM });
    const viol = issues.filter((s) => !s.startsWith('unmeasurable:'));
    if (viol.length) {
      builtinViolations++;
      console.log(`FAIL hand-shape ${shown}: ${viol.join('; ')}`);
    }
    // A shape was asserted but could not be measured on this body: WARN, never FAIL (this pass is a QA guard,
    // not a rig requirement), and never a pass either -- they are counted and reported on their own WARN line.
    for (const u of issues.filter((s) => s.startsWith('unmeasurable:'))) {
      builtinUnmeasurable++;
      const lacks = /hand lacks (.+)$/.exec(u);
      if (lacks) unmeasurableBones.add(lacks[1]);
    }
  }
}
if (builtinUnmeasurable) {
  console.log(`WARN hand-shape: ${builtinUnmeasurable} unmeasurable built-in hand sample(s) -- model lacks ${[...unmeasurableBones].join(', ') || 'the thumb tip'}; not judged, not counted as passes`);
}
const gestureCount = allCommands.filter((c) => c.mirrorBoth).length;
console.log(`check:jev-rig built-in hands: ${gestureCount} built-in variants (both sides) + ${allCommands.length - gestureCount} speech variants checked, ${builtinViolations} violation(s), ${builtinUnmeasurable} unmeasurable WARN(s) not counted as passes (face-contact reaches not judged; ${POINTING_MEANING.size} pointing-meaning exemption(s))`);
bad += builtinViolations;

// ---------- UNIT-STYLE SELF-ASSERTION of the hand-shape guard ----------
// Prove the guard DISCRIMINATES rather than merely happening to be green on the shipped data: on one synthetic
// wave reach, the new 'open-flat' hand (all four fingers extended, thumb adducted alongside the index) must PASS
// -- its thumb tip stays alongside the index (no rise and no out-of-plane stick-out) -- while a genuinely raised
// thumb ('thumbsUp') must still FAIL.
// If a future edit makes the guard blind to a raised thumb, the second assertion breaks here, not silently.
{
  const waveCmd = (shape) => ({
    id: `hand-shape-self-assert-${shape}`, priority: 6, interrupt: true,
    reach: [{ hand: 'right', target: 'wave', inMs: 300, holdMs: 1300, outMs: 500 }],
    hands: [{ hand: 'right', shape, weight: 1, inMs: 300, holdMs: 1300, outMs: 500 }],
  });
  const opts = { floorDeg: 0, faceReachExempt: true, outOfPlaneCm: THUMB_OUT_CM };
  const split = (entries) => ({
    viol: entries.filter((s) => !s.startsWith('unmeasurable:')),
    unm: entries.filter((s) => s.startsWith('unmeasurable:')),
  });
  const flat = split(handShapeViolations(waveCmd('open-flat'), 1, opts));
  const raised = split(handShapeViolations(waveCmd('thumbsUp'), 1, opts));
  const unm = [...flat.unm, ...raised.unm];
  // No measurable thumb on this body (no Distal bones): the assertion cannot prove discrimination, so say so
  // explicitly and skip -- neither a pass (that was the blind spot) nor a failure of the guard's math.
  if (unm.length) console.log(`SKIP hand-shape self-assertion: ${unm[0].replace(/^unmeasurable: /, '')}`);
  else {
    if (flat.viol.length === 0) console.log("PASS hand-shape self-assertion: 'open-flat' wave hand passes (thumb alongside the index, no thumbs-up)");
    else { bad++; console.log(`FAIL hand-shape self-assertion: 'open-flat' wave hand flagged: ${flat.viol.join('; ')}`); }
    if (raised.viol.length > 0) console.log(`PASS hand-shape self-assertion: a raised thumb ('thumbsUp') still fails (${raised.viol.join('; ')})`);
    else { bad++; console.log("FAIL hand-shape self-assertion: a raised thumb ('thumbsUp') was NOT flagged"); }
  }
}

// ---------- FACE-CLEARANCE: faceClearanceViolations (defined above) run over every built-in + speech command.
let faceViolations = 0;
for (const { key, cmd, mirrorBoth } of allCommands) {
  for (const side of mirrorBoth ? [1, -1] : [1]) {
    const viol = faceClearanceViolations(cmd, side);
    if (viol.length) {
      faceViolations++;
      console.log(`FAIL face-clearance "${key}${side < 0 ? ' [mirror]' : ''}": ${viol.join('; ')}`);
    }
  }
}
console.log(`check:jev-rig built-in face-clearance: ${gestureCount} built-in variants (both sides) + ${allCommands.length - gestureCount} speech variants checked, ${faceViolations} violation(s)`);
bad += faceViolations;

console.log(`check:jev-rig ${bad ? `${bad} FAILED` : 'all passed'} (${JEV_LABELS.reduce((n, l) => n + sel.bodyPool.get(l).length, 0)} pool entries rig+hand-shape-checked across ${JEV_LABELS.length} labels)${builtinUnmeasurable ? ` · ${builtinUnmeasurable} built-in hand sample(s) UNMEASURABLE (WARN, not counted as pass)` : ''}`);
process.exit(bad ? 1 : 0);
