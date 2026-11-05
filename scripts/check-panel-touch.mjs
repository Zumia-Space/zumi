// Panel-touch gate (T-31 C1 step 9): plain Node, no Electron, no window, no network. Proves the ONE designed contact
// with the float holo panel on a FAKE clock:
//   1. the plan        tap/swipe; 150-250 ms contact, 6-10 cm swipe, every enter/leave through a smooth in/out
//                      envelope; the contact point is ON the plane and inside the rect at every sample
//   2. the live plane  HoloScreen.touchFrame() reports the real mesh plane + the hand on its side; the work contact
//                      resolves into the rig from that plan point alone (no stored plane, review N2)
//   3. the real arm    REAL ReflexEngine + REAL Rig on the shipped VRM: fingertip-to-plane <= 1 cm at contact, the
//                      forearm never crosses the plane / the rect before contact, wrist speed < 1.5 m/s at the
//                      transitions, tap holds and swipe slides match the plan
//   3b. interruptions REVIEW B2/R1: an interruption at the enter, the contact or the swipe (the pointer hover, real
//                      speech, a REAL typing/poke/pat catalog gesture, a REAL HUD board reaction through the loop's
//                      taskEvent, the working signal going off) eases the contact out through TOUCH_OUT_MS instead of
//                      snapping the arm home: peak wrist speed < 1.5 m/s in every case
//   3c. the sweep       REVIEW R1-instrument: EVERY real catalog variant (52 -- the cursor reflex is suppressed while
//                      working) fired while she touches the panel, at the enter, the contact and the swipe: the
//                      panel-hand wrist stays < 1.5 m/s at every frame of the takeover, in all 156 cases
//   4. arm share       the shipped beat table over a simulated 5 min: the touch beat owns >= 30% of the working time
//   5. the clamp       no dead 'panel-touch' exception (the contact is injected after the clamp) and every sweep is
//                      still kept out (review N1/N2)
//   Usage: npm run check:panel-touch [-- --model <file.vrm>]   (exit 1 on any failure)
import * as THREE from 'three';
import { modelFromArgs, loadHarness, makeFreshEngine, reporter, clock } from './lib/reflex-harness.mjs';
import { HoloScreen, SCREEN_OFFSET } from '../src/renderer/room/holo-screen.js';
import { FLOAT } from '../src/renderer/room/float-mode.js';
import { createWorkLoop, BEATS, PANEL_TOUCH_BEAT } from '../src/renderer/talk/work-loop.js';
// alpha.10 (owner 31-10): the shipped table no longer carries the touch beat; this gate keeps proving the dormant
// mechanism on the C1 two-beat table, and section 4 proves the SHIPPED table never touches the panel.
const C1_BEATS = Object.freeze([BEATS[0], PANEL_TOUCH_BEAT]);
import {
  makeTouchPlan, touchAt, touchContact, planeDistance, onPanel,
  TOUCH_IN_MS, TOUCH_OUT_MS, CONTACT_MIN_MS, CONTACT_MAX_MS, SWIPE_MIN_M, SWIPE_MAX_M, PANEL_TOUCH_WEIGHT, BEAT_PAD_MS,
} from '../src/renderer/talk/panel-touch.js';
import { clampForHoloPanel } from '../src/renderer/reflex/engine.js';

const modelPath = modelFromArgs();
const { ok: rawOk, finish } = reporter();
// The shared reporter stringifies details; JSON keeps structured evidence readable.
const ok = (cond, name, detail) => rawOk(cond, name, detail && typeof detail === 'object' ? JSON.stringify(detail) : detail);

// Deterministic LCG, never Math.random (the repo's check convention).
function makeRandom(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 0x100000000);
}

// ---------- 1. the plan: envelopes, contact hold, swipe slide, on-plane points ----------
{
  // A notional panel: centre at the origin, +n toward her head/camera midpoint, hw/hh = the shipped float panel at
  // scale 1 (0.42 x 0.26 m), her body on the +r side (the shipped offset).
  const FRAME = Object.freeze({ c: [0, 0, 0], n: [0, 0, 1], r: [1, 0, 0], u: [0, 1, 0], hw: 0.21, hh: 0.13, toward: 1, hand: 'right' });
  const plans = [];
  for (let seed = 1; seed <= 200; seed++) plans.push(makeTouchPlan(makeRandom(seed)));
  const taps = plans.filter((p) => p.kind === 'tap');
  const swipes = plans.filter((p) => p.kind === 'swipe');
  ok(taps.length > 50 && swipes.length > 50, 'plan: both a tap and a swipe are produced (deterministic RNG sweep)', { taps: taps.length, swipes: swipes.length });
  ok(plans.every((p) => p.contactMs >= CONTACT_MIN_MS && p.contactMs <= CONTACT_MAX_MS), 'plan: the contact hold is 150-250 ms', [Math.min(...plans.map((p) => p.contactMs)), Math.max(...plans.map((p) => p.contactMs))]);
  ok(plans.every((p) => p.totalMs >= 1200 && p.totalMs <= 2000), 'plan: a tap or swipe beat is 1.2-2.0 s (the 1-2 s brief)', [Math.min(...plans.map((p) => p.totalMs)), Math.max(...plans.map((p) => p.totalMs))]);
  ok(taps.every((p) => p.lateralM === 0) && swipes.every((p) => p.lateralM >= SWIPE_MIN_M && p.lateralM <= SWIPE_MAX_M),
    'plan: only a swipe slides, 6-10 cm along the plane', { tap: [...new Set(taps.map((p) => p.lateralM))], swipe: [Math.min(...swipes.map((p) => p.lateralM)), Math.max(...swipes.map((p) => p.lateralM))] });
  ok(plans.every((p) => p.totalMs === p.inMs + p.contactMs + p.lateralMs + p.outMs && p.inMs === TOUCH_IN_MS && p.outMs === TOUCH_OUT_MS),
    'plan: the beat time is enter + hold + slide + leave (no hidden tail)', plans[0]);

  // The envelope at 1 ms: 0 at the start, smooth up to 1, flat through the hold (and the slide), back down to 0.
  const plan = swipes[0];
  let monoIn = true, monoOut = true, offHold = false;
  const holdEnd = plan.inMs + plan.contactMs + plan.lateralMs;
  let prev = touchAt(plan, 0).weight;
  for (let t = 1; t <= plan.totalMs; t++) {
    const w = touchAt(plan, t).weight;
    if (t <= plan.inMs && w < prev - 1e-12) monoIn = false;
    if (t >= holdEnd && w > prev + 1e-12) monoOut = false;
    if (t > plan.inMs && t < holdEnd && Math.abs(w - 1) > 1e-12) offHold = true;
    prev = w;
  }
  ok(touchAt(plan, 0).weight === 0 && touchAt(plan, plan.totalMs).weight === 0 && monoIn && monoOut && !offHold,
    'envelope: smooth in, flat at 1 through contact + slide, smooth out (no step into or out of the glass)', { inMs: plan.inMs, holdEnd, outMs: plan.outMs });
  ok(touchAt(plan, plan.inMs + 1).lateralM === 0 && Math.abs(touchAt(plan, holdEnd).lateralM - plan.lateralM) < 1e-9,
    'envelope: the slide runs after the contact hold, not through it', plan);

  // Every sample of the planned contact rides the plane, inside the rect; a swipe slides 6-10 cm along it.
  let onPlane = true, inRect = true;
  const slides = [];
  for (const p of plans) {
    const first = touchContact(FRAME, p, p.inMs);
    const last = touchContact(FRAME, p, p.inMs + p.contactMs + p.lateralMs - 1e-9);
    for (let t = 0; t <= p.totalMs; t += 4) {
      const c = touchContact(FRAME, p, t);
      if (Math.abs(planeDistance(FRAME, c.point)) > 1e-9) onPlane = false;
      if (!onPanel(FRAME, c.u, c.v, 0.9)) inRect = false;
    }
    slides.push({ kind: p.kind, m: Math.hypot(last.point[0] - first.point[0], last.point[1] - first.point[1], last.point[2] - first.point[2]) });
  }
  ok(onPlane, 'contact: the planned fingertip point is exactly ON the panel plane at every sample (distance 0)');
  ok(inRect, 'contact: every planned contact stays inside the glass (90% of the half extents)');
  ok(slides.filter((s) => s.kind === 'tap').every((s) => s.m < 0.01), 'contact: a tap holds one spot (< 1 cm of drift)', slides.find((s) => s.kind === 'tap'));
  ok(slides.filter((s) => s.kind === 'swipe').every((s) => s.m >= SWIPE_MIN_M - 1e-6 && s.m <= SWIPE_MAX_M + 1e-6), 'contact: a swipe slides 6-10 cm along the plane', slides.find((s) => s.kind === 'swipe'));
}

// ---------- 2. the live plane, threaded through the real engine ----------
const { vrm, camera } = await loadHarness(modelPath);
const { engine, catalog } = makeFreshEngine(vrm, camera, 11);
engine.setWorking(true);
engine.setHoloPanel(true); // the float panel is up while working (app.js applyWorkPanel), so every gesture is clamped
clock.t = 1_000_000;
engine.update(0.016);

// Place the panel exactly as HoloScreen.update() does in float mode: her hips + the shipped offset (scaled), facing
// the midpoint of her head and the camera. Prototype-only, like check-work-loop: no canvas/DOM is needed.
const hips = engine.rig.hipsNode.getWorldPosition(new THREE.Vector3());
const off = new THREE.Vector3(SCREEN_OFFSET[0], SCREEN_OFFSET[1], SCREEN_OFFSET[2]).multiplyScalar(FLOAT.scale).applyQuaternion(vrm.scene.quaternion);
const holo = Object.create(HoloScreen.prototype);
holo.on = true; holo.camera = camera; holo.engine = engine; holo._v = new THREE.Vector3();
holo.group = new THREE.Group();
holo.mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.42 * FLOAT.scale, 0.26 * FLOAT.scale), new THREE.MeshBasicMaterial());
holo.group.add(holo.mesh);
holo.group.position.copy(hips).add(off);
const headPos = vrm.humanoid.getNormalizedBoneNode('head').getWorldPosition(new THREE.Vector3());
holo.group.lookAt(headPos.add(camera.position).multiplyScalar(0.5));
holo.group.updateMatrixWorld(true);

const frame = holo.touchFrame();
{
  const unit = (v) => Math.abs(Math.hypot(...v) - 1) < 1e-6;
  const rect = holo.screenRect();
  ok(Boolean(frame) && unit(frame.n) && unit(frame.r) && unit(frame.u), 'plane: touchFrame() reports an orthonormal frame', frame);
  ok(frame.hw > 0.1 && frame.hh > 0.05 && frame.hand === 'right' && frame.toward === 1,
    'plane: half extents + the panel hand (the shipped float offset sits on her RIGHT, body on the +r side)', frame);
  ok(planeDistance(frame, [hips.x, hips.y, hips.z]) < 0, 'plane: her body is on the negative-normal side (the approach side)', planeDistance(frame, [hips.x, hips.y, hips.z]));
  ok(Boolean(rect) && rect.x1 < 0, 'plane: the panel is screen-left (camera-left) where the read beat scans it', rect);

  // Review N2: the live plane is the WORK LOOP's input -- the engine stores no copy of it. The contact resolves into
  // the rig from the world point the plan hands it every frame: wrist one hand-length back, point on the glass.
  const arm = engine.rig.arms.right;
  const plan = makeTouchPlan(makeRandom(5));
  const touch = touchContact(frame, plan, plan.inMs); // weight 1: the fingertip is on the plane
  const wrist = new THREE.Vector3(), pole = new THREE.Vector3();
  engine.rig.resolve('right', 'panel-touch', null, wrist, pole, 1, { x: touch.point[0], y: touch.point[1], z: touch.point[2] });
  const point = new THREE.Vector3(touch.point[0], touch.point[1], touch.point[2]);
  const back = Math.abs(wrist.distanceTo(point) - arm.handLen) < arm.handLen * 0.25;
  ok(Math.abs(planeDistance(frame, touch.point)) < 1e-6 && onPanel(frame, touch.u, touch.v, 0.9) && back,
    'plane: the work contact resolves from the plan point alone -- fingertip on the glass, wrist one hand-length back',
    { back, handLen: arm.handLen, d: planeDistance(frame, touch.point), dist: wrist.distanceTo(point), point: point.toArray(), wrist: wrist.toArray() });
  ok(typeof engine.setPanelFrame !== 'function' && typeof engine.rig.panelPoint !== 'function' && !('panelFrame' in engine.rig),
    'plane: the speculative named-panel path is gone (no setPanelFrame / panelPoint / rig.panelFrame; review N2)');
}

// ---------- 3. the real arm: contact distance, approach path, wrist speed ----------
{
  const side = frame.hand;
  const arm = engine.rig.arms[side];
  const tip = new THREE.Vector3(), wrist = new THREE.Vector3(), elbow = new THREE.Vector3();
  const director = { working: true };
  const loop = createWorkLoop({ engine, director, holo, beats: [PANEL_TOUCH_BEAT], now: () => clock.t, random: makeRandom(21) });
  const episodes = [];
  let ep = null, prevWrist = null, prevW = 0;
  let contactErrMax = 0, speedMax = 0, preTipMax = -Infinity, preWristMax = -Infinity, preElbowMax = -Infinity, preCross = 0, preFrames = 0;
  let reachHands = new Set(), reachPointOnPlane = true;
  for (let i = 0; i < 2600 && episodes.length < 4; i++) {
    clock.t += 16;
    loop.update(clock.t);
    engine.update(0.016);
    const w = engine.workReach ? engine.workReach.weight : 0;
    if (loop.state.beat !== 'panel-touch' || !engine.workReach) { prevW = 0; prevWrist = null; continue; }
    reachHands.add(engine.workReach.hand);
    if (Math.abs(planeDistance(frame, [engine.workReach.point.x, engine.workReach.point.y, engine.workReach.point.z])) > 1e-9) reachPointOnPlane = false;
    engine.rig.fingertip(arm, side, tip);
    arm.hand.getWorldPosition(wrist);
    arm.lower.getWorldPosition(elbow);
    const dTip = planeDistance(frame, [tip.x, tip.y, tip.z]);
    const dWrist = planeDistance(frame, [wrist.x, wrist.y, wrist.z]);
    const dElbow = planeDistance(frame, [elbow.x, elbow.y, elbow.z]);
    const speed = prevWrist && Math.abs(w - prevW) > 1e-9 ? wrist.distanceTo(prevWrist) / 0.016 : 0;
    speedMax = Math.max(speedMax, speed);
    if (w >= 1 - 1e-9) {
      contactErrMax = Math.max(contactErrMax, Math.abs(dTip));
      if (!ep) ep = { start: clock.t, first: tip.clone(), last: tip.clone(), frames: 0 };
      ep.last.copy(tip); ep.frames++;
    } else {
      if (ep) { episodes.push(ep); ep = null; }
      preFrames++;
      preTipMax = Math.max(preTipMax, dTip); preWristMax = Math.max(preWristMax, dWrist); preElbowMax = Math.max(preElbowMax, dElbow);
      for (const [p, d] of [[elbow, dElbow], [wrist, dWrist], [tip, dTip]]) {
        const u = (p.x - frame.c[0]) * frame.r[0] + (p.y - frame.c[1]) * frame.r[1] + (p.z - frame.c[2]) * frame.r[2];
        const v = (p.x - frame.c[0]) * frame.u[0] + (p.y - frame.c[1]) * frame.u[1] + (p.z - frame.c[2]) * frame.u[2];
        if (d > 0.01 && onPanel(frame, u / frame.hw, v / frame.hh, 1)) preCross++; // a forearm sample THROUGH the glass
      }
    }
    prevW = w; prevWrist = wrist.clone();
  }
  const holdMs = (e) => e.frames * 16;
  const slideM = (e) => e.first.distanceTo(e.last);
  ok(contactErrMax <= 0.01, 'arm: fingertip-to-plane <= 1 cm at every contact frame (IK target vs the live plane)', { contactErrMax, episodes: episodes.length });
  ok(preFrames > 100 && preTipMax <= 0.01, 'arm: before contact the fingertip stays on her side of the glass (<= 1 cm, never past it)', { preTipMax, preFrames });
  ok(preElbowMax <= 0.002 && preWristMax <= 0.002, 'arm: the forearm (elbow + wrist) never crosses the plane before contact', { preElbowMax, preWristMax });
  ok(preCross === 0, 'arm: no forearm sample is ever through the glass inside the panel rect before contact', preCross);
  ok(speedMax > 0 && speedMax < 1.5, 'arm: wrist speed < 1.5 m/s at every enter/leave transition', speedMax);
  ok(episodes.length >= 3, 'arm: the touch beat plays a full reach/contact/retract cycle (>= 3 beats)', episodes.length);
  const taps = episodes.filter((e) => slideM(e) < 0.02);
  const swipes = episodes.filter((e) => slideM(e) >= SWIPE_MIN_M && slideM(e) <= SWIPE_MAX_M);
  ok(taps.every((e) => holdMs(e) >= CONTACT_MIN_MS - 16 && holdMs(e) <= CONTACT_MAX_MS + 16), 'arm: a tap holds 150-250 ms', taps.map(holdMs));
  ok(swipes.every((e) => holdMs(e) >= CONTACT_MIN_MS + 300 - 16 && holdMs(e) <= CONTACT_MAX_MS + 300 + 16), 'arm: a swipe holds, then slides (hold + 300 ms)', swipes.map(holdMs));
  ok(taps.length > 0 && swipes.length > 0, 'arm: the simulated run produced both a tap and a swipe', { taps: taps.length, swipes: swipes.length });
  ok(reachHands.size === 1 && reachHands.has(frame.hand) && reachPointOnPlane, 'arm: every contact drives the panel hand and targets the live plane', [...reachHands]);
}

// ---------- 3b. review B2/R1: a real interruption during a touch EASES OUT (never snaps the arm home) ----------
// The real engine + rig, the shipped touch beat, one interruption case per (type x phase). Every interrupting
// GESTURE here is a REAL catalog variant played on the real player -- typing/peek-lean, poke/startle and
// pat/happy-wiggle each reach with the panel hand (review R1-instrument: no stubbed isBusy/states/react) -- and the
// task event plays the REAL HUD board variant through the loop's own react hook, exactly as app.js wires it. Speech,
// the pointer hover and the signal going off are the other real paths (no gesture is attached to them). The
// instrument is the same as §3's: the wrist is read off the real rig after engine.update(), and speed between two
// frames is distance / 16 ms. Before B2, release() nulled the reach on the interruption frame, so the rig solved
// straight to rest (13-19 m/s). With B2 the contact ramps out through TOUCH_OUT_MS (scaled by its on-screen weight),
// and with R1 a gesture that takes the same hand over is paced through that leave (§3c sweeps every variant).
const realBoardReact = (variant, look) => {
  // The same three lines app.js's workReact runs: a real board variant on the real player, its own length returned.
  catalog.forceNext('board', variant);
  const info = engine.trigger('board', { look });
  const inst = info && engine.player ? engine.player.find(info.id) : null;
  return inst ? engine.player.duration(inst) : 0;
};
// Back to a clean stage between cases: no live gesture, no contact, no work gaze/expression, no rig handover state.
const resetTouchCase = (t) => {
  engine.player.stopAll(true);
  engine.states.clear(); engine.speechMouth = null;
  engine.setWorkReach(null); engine.setWorkGaze(null); engine.setWorkExpression(null);
  engine.rig.handover.clear(); engine.rig.lastWrist.clear(); engine.rig.routes.clear();
  // Isolate the instrument from the idle-variety clock (same isolation check-work-loop's idle section uses).
  engine.lastInputAt = t; engine.nextBoredAt = t + 1_000_000; engine.nextVarietyAt = t + 1_000_000;
  engine.setWorking(true);
};
{
  const side = frame.hand;
  const arm = engine.rig.arms[side];
  const CASES = [];
  for (const type of ['hover', 'speech', 'typing', 'poke', 'pat', 'taskEvent', 'workingOff']) {
    for (const phase of ['enter', 'contact', 'swipe']) CASES.push({ type, phase });
  }
  let allEased = true, allStartedFromScreen = true, allCleared = true, allLeft = true, worst = 0;
  let allGesturesPlayed = true;
  for (let ci = 0; ci < CASES.length; ci++) {
    const { type, phase } = CASES[ci];
    clock.t = 30_000_000 + ci * 100_000;
    resetTouchCase(clock.t);
    let hovered = false, armed = false, beatStart = null, contact0 = null;
    const loop = createWorkLoop({
      engine, holo, beats: [PANEL_TOUCH_BEAT], hover: () => hovered,
      react: realBoardReact,
      now: () => clock.t, random: makeRandom(70 + ci),
    });
    const wrist = new THREE.Vector3();
    let lastWrist = null, lastW = 0, peak = 0, firedAt = null, beforeW = null, afterW = null, clearedAt = null;
    let leaveFrames = 0, sawLeaving = false, shot = false, fired = false, played = null;
    const maxFrames = phase === 'swipe' ? 900 : 240; // a swipe plan is not guaranteed on the first beat: wait for one
    for (let i = 0; i < maxFrames && clearedAt == null; i++) {
      clock.t += 16;
      // ---- before the frame: arm / deliver the interruption at the chosen moment of the touch beat ----
      if (!shot) {
        const st = loop.state;
        const touching = st.beat === 'panel-touch';
        if (touching && st.startedAt !== beatStart) { beatStart = st.startedAt; contact0 = null; armed = false; }
        const w = engine.workReach ? engine.workReach.weight : 0;
        const p = engine.workReach ? engine.workReach.point : null;
        const elapsed = touching ? (clock.t - 16 - st.startedAt) : 0; // the PREVIOUS frame's elapsed
        if (touching && type === 'hover') {
          // hover has its own 400 ms debounce, so it is armed early enough that the LOOK-UP lands in the phase:
          // enter = at the beat start, contact = 400 ms before the reach touches, swipe = when the contact is held.
          if (phase === 'enter' && !armed) { armed = shot = true; hovered = true; }
          else if (phase === 'contact' && !armed && elapsed >= TOUCH_IN_MS - 400) { armed = shot = true; hovered = true; }
          else if (phase === 'swipe' && !armed && w >= 1 - 1e-9) { armed = shot = true; hovered = true; }
        } else if (touching) {
          let fire = false;
          if (phase === 'enter') fire = w > 0.4 && w < 1 - 1e-9;
          else if (phase === 'contact') fire = w >= 1 - 1e-9;
          else if (phase === 'swipe' && w >= 1 - 1e-9) {
            if (!contact0) contact0 = { x: p.x, y: p.y, z: p.z };
            fire = Math.hypot(p.x - contact0.x, p.y - contact0.y, p.z - contact0.z) > 0.01;
          }
          if (fire) {
            shot = true;
            // Real catalog gestures on the real player: each takes the panel hand (typing and poke reach with both
            // hands, pat with the right), so the loop yields and the contact must hand the arm over through its leave.
            if (type === 'speech') engine.speechMouth = { aa: 0.4, ih: 0, ou: 0, ee: 0, oh: 0 };
            else if (type === 'typing') { catalog.forceNext('typing', 'peek-lean'); played = engine.trigger('typing', {}); }
            else if (type === 'poke') { catalog.forceNext('poke', 'startle'); played = engine.trigger('poke', {}); }
            else if (type === 'pat') { catalog.forceNext('pat', 'happy-wiggle'); played = engine.trigger('pat', {}); }
            else if (type === 'taskEvent') played = loop.taskEvent({ state: 'blocked' }) ? { id: 'task' } : null;
            else if (type === 'workingOff') engine.setWorking(false);
          }
        }
      }
      loop.update(clock.t);
      engine.update(0.016);
      arm.hand.getWorldPosition(wrist);
      const w = engine.workReach ? engine.workReach.weight : 0;
      if (loop.state.leaving) sawLeaving = true;
      // The interruption lands on the first frame the loop enters its leave (hover's debounce) -- or, if a regression
      // stopped the leave altogether, on the frame the reach first drops after the shot (which is what the old snap did).
      if (!fired && (loop.state.leaving || (shot && w < lastW - 1e-9))) {
        fired = true; firedAt = clock.t; beforeW = lastW;
      }
      if (fired && firedAt === clock.t) afterW = w; // the leave's first frame: must start from the on-screen weight
      if (fired && w > 1e-9) leaveFrames++;
      if (fired && lastWrist && Math.abs(w - lastW) > 1e-9) peak = Math.max(peak, wrist.distanceTo(lastWrist) / 0.016);
      if (fired && w <= 1e-9) clearedAt = clock.t;
      lastW = w; lastWrist = wrist.clone();
    }
    const clearedMs = firedAt != null && clearedAt != null ? clearedAt - firedAt : null;
    const eased = peak < 1.5;
    const fromScreen = beforeW != null && afterW != null && afterW >= beforeW - 1e-6 && beforeW > 0;
    const cleared = clearedMs != null && clearedMs <= TOUCH_OUT_MS * (beforeW == null ? 1 : beforeW) + 40;
    allEased = allEased && eased;
    allStartedFromScreen = allStartedFromScreen && fromScreen;
    allCleared = allCleared && cleared;
    allLeft = allLeft && leaveFrames >= 2 && sawLeaving;
    allGesturesPlayed = allGesturesPlayed && (type !== 'typing' && type !== 'poke' && type !== 'pat' && type !== 'taskEvent' || Boolean(played));
    worst = Math.max(worst, peak);
    ok(eased && fromScreen && cleared,
      `B2 ease-out: ${type} at ${phase} -- peak wrist ${peak.toFixed(2)} m/s (< 1.5), starts at the on-screen weight, clears in ${clearedMs} ms`,
      { peak: +peak.toFixed(3), beforeW: beforeW == null ? null : +beforeW.toFixed(3), afterW: afterW == null ? null : +afterW.toFixed(3), clearedMs, gesture: played ? (played.variant || played.id) : null });
  }
  ok(worst < 1.5, 'B2 ease-out: every interruption case stays under 1.5 m/s (worst above)', +worst.toFixed(3));
  ok(allStartedFromScreen, 'B2 ease-out: no case jumps the reach -- every leave starts from the weight that was on screen');
  ok(allCleared, 'B2 ease-out: every leave clears the contact within TOUCH_OUT_MS scaled by the on-screen weight');
  ok(allLeft, 'B2 ease-out: every case actually ran a multi-frame leave (not a single-frame clear)');
  ok(allGesturesPlayed, 'B2 ease-out: every interrupting gesture was a REAL catalog variant that actually played (review R1-instrument: no stubbed isBusy/states/react)');
  resetTouchCase(clock.t);
}

// ---------- 3c. review R1-instrument: the 52-variant real-gesture sweep ----------
// Every real catalog variant fired while she is TOUCHING the panel -- at the enter of the reach, at the contact and
// during the swipe -- on the real engine, rig and live plane, the same instrument as §3/§3b. The panel-hand wrist is
// read off the rig every frame of the 1 s after the gesture fires; the gate is < 1.5 m/s at EVERY frame (not only
// the frames with a live contact weight). That is the whole point of R1: a gesture that reaches with the panel hand
// must take the arm over from the glass through the contact's own leave, never from the rest pose.
// The cursor reflex is excluded by design: engine.trigger() refuses it while working (CONCEPTS §5), so it can never
// interrupt a touch; the 52 remaining variants are the real interruption surface.
{
  const side = frame.hand;
  const arm = engine.rig.arms[side];
  const wrist = new THREE.Vector3(), prev = new THREE.Vector3();
  const PHASES = ['enter', 'contact', 'swipe'];
  const variants = [];
  for (const [name, def] of catalog.triggers) {
    if (name === 'cursor') continue;
    for (const v of def.variants) variants.push({ trigger: name, id: v.id });
  }
  ok(variants.length === 52, 'sweep: 52 real interrupt variants in the catalog (every trigger except the cursor reflex)', variants.length);

  const rows = [];
  let worst = 0, unplayed = 0;
  for (let vi = 0; vi < variants.length; vi++) {
    const { trigger, id } = variants[vi];
    for (const phase of PHASES) {
      clock.t = 40_000_000 + (vi * PHASES.length + PHASES.indexOf(phase)) * 100_000;
      resetTouchCase(clock.t);
      const loop = createWorkLoop({ engine, holo, beats: [PANEL_TOUCH_BEAT], now: () => clock.t, random: makeRandom(21) });
      let fireAt = null, played = null, peak = 0, has = false, contact0 = null;
      for (let i = 0; i < 400; i++) {
        clock.t += 16;
        // The fire instant: the first frame of the chosen phase of the SHIPPED touch beat.
        if (fireAt == null && engine.workReach) {
          const cw = engine.workReach.weight, p = engine.workReach.point;
          let ready = false;
          if (phase === 'enter') ready = cw > 0.35 && cw < 1 - 1e-9;
          else if (phase === 'contact') ready = cw >= 1 - 1e-9;
          else if (cw >= 1 - 1e-9) {
            if (!contact0) contact0 = { x: p.x, y: p.y, z: p.z };
            ready = Math.hypot(p.x - contact0.x, p.y - contact0.y, p.z - contact0.z) > 0.01; // the swipe is under way
          }
          if (ready) fireAt = i;
        }
        if (i === fireAt) { catalog.forceNext(trigger, id); played = engine.trigger(trigger, {}); }
        loop.update(clock.t);
        engine.update(0.016);
        arm.hand.getWorldPosition(wrist);
        if (has && fireAt != null && i >= fireAt && i < fireAt + 60) peak = Math.max(peak, wrist.distanceTo(prev) / 0.016);
        prev.copy(wrist); has = true;
        if (fireAt != null && i > fireAt + 60) break;
      }
      if (!played) unplayed++;
      const row = { trigger, id, phase, peak };
      rows.push(row);
      worst = Math.max(worst, peak);
    }
  }
  const bad = rows.filter((r) => !(r.peak < 1.5)).sort((a, b) => b.peak - a.peak);
  ok(unplayed === 0, 'sweep: every variant actually played on the real player at enter, contact and swipe', unplayed);
  ok(bad.length === 0, 'sweep: all 52 variants x 3 phases keep the panel-hand wrist < 1.5 m/s (no snap out of the glass)',
    bad.slice(0, 12).map((r) => `${r.trigger}/${r.id}@${r.phase}: ${r.peak.toFixed(2)}`));
  ok(worst < 1.5, 'sweep: the worst takeover in all 156 cases is under the 1.5 m/s gate', +worst.toFixed(2));
  const top = rows.slice().sort((a, b) => b.peak - a.peak).slice(0, 5).map((r) => `${r.trigger}/${r.id}@${r.phase}: ${r.peak.toFixed(2)}`);
  ok(rows.length === 156, 'sweep: 156 cases ran (52 variants x enter/contact/swipe)', { cases: rows.length, worst: +worst.toFixed(2), top });
  resetTouchCase(clock.t);
}

// ---------- 4. arm share over a simulated 5 min (the C1 two-beat table; the shipped one never touches) ----------
{
  const RECT = { x0: -0.72, x1: -0.48, y0: 0.18, y1: 0.33 };
  const FRAME = { c: [0, 1.3, 0], n: [0, 0, 1], r: [1, 0, 0], u: [0, 1, 0], hw: 0.18, hh: 0.11, toward: 1, hand: 'right' };
  const shares = [];
  for (const seed of [1, 7, 11, 42]) {
    let t = 1_000_000;
    const stubEngine = {
      working: true, speechMouth: null, states: new Set(), isState() { return false; }, isBusy() { return 0; },
      setWorkGaze() {}, setWorkReach() {},
    };
    const stubHolo = { on: true, screenRect: () => ({ ...RECT }), screenNdc: () => ({ x: -0.6, y: 0.25 }), touchFrame: () => ({ ...FRAME }) };
    const loop = createWorkLoop({ engine: stubEngine, director: { working: true }, holo: stubHolo, now: () => t, random: makeRandom(seed), beats: C1_BEATS });
    let touch = 0, total = 0, touchBeats = 0, lastId = null, badDuration = 0;
    for (const end = t + 300_000; t < end; t += 16) {
      loop.update(t);
      if (loop.state.beat === 'panel-touch') {
        touch++;
        if (lastId !== 'panel-touch') {
          touchBeats++;
          const d = loop.state.durationMs;
          if (!(d >= 1200 && d <= 2000)) badDuration++;
        }
      }
      total++; lastId = loop.state.beat;
    }
    shares.push(touch / total);
    if (seed === 1) ok(touchBeats > 20 && badDuration === 0, 'share: every touch beat is 1.2-2.0 s (plan + pad, the 1-2 s brief)', { touchBeats, badDuration });
  }
  const mean = shares.reduce((a, b) => a + b, 0) / shares.length;
  ok(shares.every((s) => s >= 0.30), 'share: the touch beat owns >= 30% of the working time over a simulated 5 min', shares.map((s) => +(s * 100).toFixed(1)));
  ok(mean >= 0.32, 'share: with margin (the panel gets worked roughly a third of the time)', +(mean * 100).toFixed(1));
  ok(PANEL_TOUCH_WEIGHT >= 1 && BEAT_PAD_MS > 0, 'share: the beat is weighted against read-panel and leaves a pad before the next beat', { PANEL_TOUCH_WEIGHT, BEAT_PAD_MS });
  // alpha.10: the shipped table over the same 5 min -- zero touch time, zero armed contacts.
  let t = 1_000_000, touch = 0, armed = 0;
  const stubEngine = { working: true, speechMouth: null, states: new Set(), isState() { return false; }, isBusy() { return 0; }, setWorkGaze() {}, setWorkReach(r) { if (r) armed++; } };
  const stubHolo = { on: true, screenRect: () => ({ ...RECT }), screenNdc: () => ({ x: -0.6, y: 0.25 }), touchFrame: () => ({ ...FRAME }) };
  const loop = createWorkLoop({ engine: stubEngine, director: { working: true }, holo: stubHolo, now: () => t, random: makeRandom(1) });
  for (const end = t + 300_000; t < end; t += 16) { loop.update(t); if (loop.state.beat === 'panel-touch') touch++; }
  ok(!BEATS.some((b) => b.touch) && touch === 0 && armed === 0, 'share (alpha.10): the SHIPPED beat table never touches the panel over 5 min', { touch, armed, beats: BEATS.map((b) => b.id) });
}

// ---------- 5. the panel clamp: no dead panel-touch exception, every sweep still kept out ----------
{
  // Review N1/N2: the designed contact is injected AFTER this clamp (engine.applyPose), so no command can name
  // 'panel-touch' (schema.js REACH_TARGETS has no such target) and the clamp needs no branch for it. The real
  // panel-safe sweeps are still cut or mirrored away exactly as before.
  const sweep = { id: 'sweep', reach: [{ hand: 'right', target: 'point-sidebar', inMs: 300, holdMs: 300, outMs: 300 }] };
  const cut = clampForHoloPanel(sweep);
  ok(!cut.reach || !cut.reach.some((r) => r.target === 'point-sidebar'), 'clamp: every panel-side sweep is still kept out', cut.reach);
  const raised = { id: 'wave', reach: [{ hand: 'right', target: 'wave', inMs: 300, holdMs: 300, outMs: 300 }], mirror: 'random' };
  const lifted = clampForHoloPanel(raised);
  ok(Array.isArray(lifted.reach) && lifted.reach.length === 1 && lifted.reach[0].hand === 'left' && lifted.mirror === 'none',
    'clamp: a raised reach is still mirrored to the far hand and its random mirror pinned', { reach: lifted.reach, mirror: lifted.mirror });
}

finish();
