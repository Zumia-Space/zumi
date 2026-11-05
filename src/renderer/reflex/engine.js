// ReflexEngine — continuous life (breathing, blinks, sway, glances, saccades) + gaze/head follow +
// trigger -> GestureCommand dispatch + final pose application (bones, IK arms, clips, expressions).
import * as THREE from 'three';
import { GesturePlayer, ChannelAcc } from './player.js';
import { BONE_LIMITS_DEG } from './schema.js';
import { Rig } from './rig.js';
import { ownerTextProblem } from '../talk/ownertext.js';
import { t } from '../i18n.js';

const DEG = Math.PI / 180;
const GAZE_GAIN = 1.35; // how far "out of the screen" the cursor is treated (bigger = livelier head turns)
const START_MAG = 0.01; // a reaction counts as started once its own output exceeds this (rad / weight units)
const TORSO = ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head', 'leftShoulder', 'rightShoulder', 'leftHand', 'rightHand'];
const FK_ARM = ['leftUpperArm', 'leftLowerArm', 'rightUpperArm', 'rightLowerArm'];
const DRIVEN_EXPR = ['happy', 'angry', 'sad', 'relaxed', 'surprised', 'aa', 'ih', 'ou', 'ee', 'oh', 'blink', 'blinkLeft', 'blinkRight'];
const EMOTIONS = ['happy', 'angry', 'sad', 'relaxed', 'surprised'];
const MOUTH = ['aa', 'ih', 'ou', 'ee', 'oh'];
const DEFAULT_FOLLOW = { head: 0.55, spine: 0.1, rate: 6, tilt: 0 };
const IDLE_BORED_MS = 60_000;
const IDLE_SLEEPY_MS = 180_000;
// R4a idle variety: a motion-variety layer, independent of the bored/sleepy EMOTIONAL escalation above --
// every 15-40 s of real idle, replay one of the existing idle-appropriate gestures so she is never a statue
// long before "bored" kicks in. Reuses the 'bored' catalog trigger and its own not-same-as-last anti-repeat
// (Catalog.pick), so no new gesture data and no new anti-repeat code are needed for this half of R4a.
const IDLE_VARIETY_MIN_MS = 15_000;
const IDLE_VARIETY_MAX_MS = 40_000;
// R4a idle glances: anchor-aware look_targets (coordinator: each glance 0.6-1.5 s, never the same target
// twice in a row within the last 3).
const GLANCE_MIN_MS = 600;
const GLANCE_MAX_MS = 1500;
const GLANCE_RING = 3;
// Coordinator fix (03-10): a look_target whose projection is this close to dead-centre reads as "no glance
// happened" on screen, so it is never eligible at all (filtered once in setLookTargets, not re-checked per
// pick). And every glance -- room-target or the no-room fallback -- must turn the head at least this many
// degrees, or it is visually indistinguishable from a twitch; a target that would yaw less gets its x pushed
// out to exactly this angle (sign preserved), never pulled in.
const CENTRE_BAND_NDC = 0.15;
const MIN_GLANCE_YAW_DEG = 12;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const rand = (r, a, b) => a + r() * (b - a);

// T-31 0.2.6 should-fix (float-holo): while the holo panel is up, no command may aim a hand into it. The panel sits
// beside her head at hips + SCREEN_OFFSET*scale (holo-screen.js), and the idle 'stretch' sends BOTH wrists to
// REACH.overhead (out 0.5 arm lengths, up 0.66); the talk camera projects that forearm through the panel's rect
// (scripts/check-float-holo.mjs §11 measures the real rig at ~0.04 NDC inside at the peak, and the T2 wrist itself
// reaches ~0.12 NDC inside during the raise; the box shots 026-float-T1-cyan / T3-amber show the same in the render).
//
// Moving the panel instead (the cheaper-looking option) does not survive measurement: rig route() raises a hand
// through a shoulder-height side waypoint, so the whole raise sweeps laterally across the panel for ANY side
// placement that still fits the float crop -- the offsets that clear the sweep (|x| >= ~0.95 panel offset) leave
// the frame/the light's 0.85 m falloff. So the panel wins:
//   - 'overhead' is DROPPED ON THE PANEL HAND only (0.2.7, DIAG 20-10 §5 row 4): the panel sits on her RIGHT, so the
//     stretch keeps its LEFT overhead reach -- the arm away from the panel still goes up, and the spine/chest/head
//     extension, closed-eye 'oh' and hand shapes stay. Before this the clamp dropped both arms, which is why float
//     idle had 4-5 arm-moving plays against 9-10 seated (DIAG §2) and the float stretch read as "arms locked".
//   - the raised side poses (wave/beside-head/wave-small) are MIRRORED onto the LEFT arm, which is away from the
//     panel: the greeting still reads. A command that already raises the left hand (bounce-wave) keeps that one and
//     its right-hand duplicate is dropped.
// A stage with NO panel (seated and not working; T-31 C1 step 11 brings the panel up while working seated) plays
// the untouched command.
// 'point-sidebar' is a sideways point on the same side as the panel: it also puts the wrist inside the rect (measured
// -0.095 NDC), and mirroring it would point at the wrong side of the screen, so it is dropped on the panel hand like
// the right 'overhead' -- the board turn keeps its head/neck/spine turn. (The hip poses pass just outside the rect,
// so they are left alone; measured for the 0.2.7 idle fidgets too.)
// Both lists are SIDE-AWARE the same way: only a reach on HOLO_PANEL_HAND is unsafe; the same target on the left
// hand is away from the panel (see HOLO_RAISED_REACH below).
export const HOLO_UNSAFE_REACH = Object.freeze(['overhead', 'point-sidebar']);
// Raised side poses (head/shoulder height) whose wrist lands inside the panel's projected rect when performed on HER
// RIGHT -- the panel side, SCREEN_OFFSET x = -0.42 in screen space (r2 QC: focus 'wave' put the right hand 0.126 NDC
// inside). While the panel is up these are mirrored to the left hand, never left on the panel side.
export const HOLO_RAISED_REACH = Object.freeze(['wave', 'beside-head', 'wave-small', 'point-up']);
// T-31 C1 step 9 note (review N1/N2): the work loop's designed contact never reaches this clamp. engine.applyPose
// injects it after the clamp, on the panel hand only, and 'panel-touch' is not a schema REACH_TARGET -- so no
// command can name it and the clamp needs no exception for it.
export const HOLO_PANEL_HAND = 'right';

const HOLO_TIMING = ['delayMs', 'inMs', 'holdMs', 'outMs'];
const sameTiming = (a, b) => HOLO_TIMING.every((k) => (a[k] ?? 0) === (b[k] ?? 0));

/** True when this command would aim a hand at the panel (a reach to drop, or a raised reach on the panel side), so
 *  clampForHoloPanel() has work to do and setHoloPanel() must cancel it if it is already in flight. Side-aware: a
 *  left-hand overhead/raised reach is away from the panel and needs no clamp. A `mirror:'random'` command still does:
 *  the player swaps hands on that flag, which could put a left-authored raised/unsafe reach onto the panel side -- the
 *  clamp pins the mirror instead (the check drives this case). */
export function needsHoloClamp(command, unsafe = HOLO_UNSAFE_REACH, raised = HOLO_RAISED_REACH) {
  const reach = command && command.reach;
  if (!Array.isArray(reach)) return false;
  const flip = command.mirror === 'random';
  return reach.some((r) => r && (unsafe.includes(r.target) || raised.includes(r.target)) && (r.hand === HOLO_PANEL_HAND || flip));
}

/** Copy of `command` with its panel-side reaches removed (unsafe targets) or mirrored to the left hand, so the
 *  player never even sees them. Only reaches on HOLO_PANEL_HAND are touched: the left-hand overhead of the stretch
 *  survives (0.2.7). Returns the SAME object when nothing changes -- the no-panel path is untouched. Pure; exported
 *  so scripts/check-float-holo.mjs can drive the real engine and assert the command it plays.
 *  A raised reach is always mirrored to the LEFT hand, so it can never sit on the panel side for any random mirror
 *  pick (a 'random' command is pinned to its authored side). The paired hand-shape and hand-bone entries follow the
 *  mirrored reach (matched by their identical timing) so the wave still shows an open palm, on the left wrist. */
export function clampForHoloPanel(command, unsafe = HOLO_UNSAFE_REACH, raised = HOLO_RAISED_REACH) {
  const reach = command && command.reach;
  if (!Array.isArray(reach) || !needsHoloClamp(command, unsafe, raised)) return command;
  const kept = [];
  const moved = []; // raised reaches rewritten right -> left
  const dropped = []; // right raised reaches dropped because the left hand already raises one
  let leftRaised = reach.some((r) => r && raised.includes(r.target) && r.hand === 'left');
  for (const r of reach) {
    if (r && unsafe.includes(r.target) && r.hand === HOLO_PANEL_HAND) continue; // panel-hand overhead/point-sidebar: dropped
    if (r && raised.includes(r.target) && r.hand === HOLO_PANEL_HAND) {
      if (leftRaised) { dropped.push(r); continue; }
      kept.push({ ...r, hand: 'left' });
      moved.push(r);
      leftRaised = true;
      continue;
    }
    kept.push(r);
  }
  const out = { ...command };
  if (kept.length) out.reach = kept; else delete out.reach;
  // Any command that raises a hand must not be mirrored randomly: the player swaps hands on 'random', which could put
  // the raised reach back on the panel side (also true for a left-authored raised reach). The same holds for a kept
  // left 'overhead' (0.2.7): a random mirror would swap it onto the panel hand.
  if (reach.some((r) => r && (raised.includes(r.target) || unsafe.includes(r.target))) && out.mirror === 'random') out.mirror = 'none';
  if (!moved.length && !dropped.length) return out; // drop-only: the original behaviour, unchanged
  if (Array.isArray(out.hands)) {
    out.hands = out.hands.flatMap((h) => {
      if (!h || h.hand !== HOLO_PANEL_HAND) return [h];
      if (moved.some((r) => sameTiming(r, h))) return [{ ...h, hand: 'left' }];
      return dropped.some((r) => sameTiming(r, h)) ? [] : [h];
    });
  }
  if (Array.isArray(out.bones)) {
    out.bones = out.bones.map((b) => (b && moved.some((r) => b.bone === `${r.hand}Hand`) ? { ...b, bone: 'leftHand' } : b));
  }
  return out;
}

// Chip text for an external command without owner words: its label only when it already reads as plain owner words
// (an id or code never reaches the owner).
function commandLabelVi(command) {
  const label = command && command.label;
  return label && !ownerTextProblem(label) ? t('reflex.chip', { label }) : t('reflex.composed');
}

export class ReflexEngine {
  constructor({ catalog, clips, random = Math.random }) {
    this.catalog = catalog;
    this.clips = clips;
    this.random = random;
    this.player = new GesturePlayer({ random, clipAvailable: (n) => clips.has(n) });
    this.player.onFollow = (f) => { this.follow = { ...f }; };
    this.acc = new ChannelAcc();
    this.listeners = new Map();
    this.follow = { ...DEFAULT_FOLLOW };
    this.pointer = { x: 0, y: 0.05, at: 0 };
    this.eyeG = { x: 0, y: 0.05 };
    this.headG = { x: 0, y: 0.05 };
    this.gazeObj = new THREE.Object3D();
    this.states = new Map(); // state trigger -> instance id
    this.pending = new Map(); // instance id -> latency record
    this.lifeEnabled = true;
    this.autoIdle = true;
    this.holoPanel = false; // T-31: the float-holo panel is on screen -> clampForHoloPanel() every command (app.js)
    this.working = false; // T-31 C1: the renderer's derived working signal (hud/work-signal.js -> app.js). A flag only:
    // the work loop (next slice) reads it; no life layer or reflex path depends on it, so it can never delay one.
    this.workReach = null; // T-31 C1 step 9: the work loop's designed panel contact (setWorkReach) -- injected into
    // acc.reach for ONE hand, and skipped when a real gesture already drives that hand.
    this.workExpression = null; // T-31 C1 step 10: the work loop's held expression (the look-at-anh smile,
    // setWorkExpression) -- added to acc.expr each frame, after the life layer and the player.
    this.lastInputAt = performance.now();
    this.nextBoredAt = 0;
    this.nextVarietyAt = this.lastInputAt + rand(random, IDLE_VARIETY_MIN_MS, IDLE_VARIETY_MAX_MS);
    this.lookTargets = []; // R4a: room look_targets projected to stage-NDC (engine.setLookTargets) -- empty = no room, glance around as before
    this.primaryGaze = null; // {x,y} stage-NDC | null (coordinator round 4, 2026-10-05): the ACTIVE view's default-gaze point (engine.setPrimaryGaze) -- gazeLayer's baseline when set, same role the pointer/camera plays for talk (which has none). null = the existing pointer-follow baseline, unchanged.
    this.viewPrimaryGaze = null; // the active view's own primary look_target (setLookTargets), kept so the work loop can hand it back when a working beat ends (C1 step 8)
    this.life = { blinkNext: 0, blinkStart: -1, blinkDur: 160, glanceNext: 0, glanceUntil: 0, gx: 0, gy: 0, saccNext: 0, sx: 0, sy: 0, lookHistory: [], phase: [0, 1, 2, 3, 4, 5].map(() => random() * 100) };
    this.lastFinal = null;
    this.vrm = null;
  }

  // ---------- events ----------
  on(name, cb) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(cb); return () => this.listeners.get(name).delete(cb); }
  emit(name, data) { for (const cb of this.listeners.get(name) || []) { try { cb(data); } catch (e) { console.error(e); } } }

  // ---------- binding ----------
  bind(vrm, camera) {
    this.vrm = vrm;
    this.camera = camera;
    this.rig = new Rig(vrm);
    this.clips.bind(vrm);
    if (vrm.lookAt) { vrm.lookAt.target = this.gazeObj; vrm.lookAt.autoUpdate = true; }
    this.player.stopAll(true);
    this.states.clear();
    this.follow = { ...DEFAULT_FOLLOW };
    this.workReach = null;
    this.workExpression = null;
  }
  unbind() { this.player.stopAll(true); this.states.clear(); this.clips.unbind(); this.vrm = null; this.rig = null; this.workReach = null; this.workExpression = null; }

  // ---------- inputs ----------
  setPointer(x, y) { this.pointer.x = clamp(x, -1.8, 1.8); this.pointer.y = clamp(y, -1.8, 1.8); this.pointer.at = performance.now(); }

  /** The work panel's on/off (app.js owns the stage mode + the working signal: float always, seated only while
   *  working -- C1 step 11). While it is shown every command is passed through clampForHoloPanel(), so no gesture
   *  reaches into the panel. Idempotent; false restores the untouched catalog. Turning the panel ON also cancels a
   *  reach already in flight (the dispatch gate only sees new commands): a no-panel -> panel switch must not let the
   *  current gesture finish through the panel. */
  setHoloPanel(on) {
    const turningOn = Boolean(on) && !this.holoPanel;
    this.holoPanel = Boolean(on);
    if (turningOn && this.player) this.player.cancelWhere(needsHoloClamp);
  }

  // Any owner keystroke / click. Wakes Zumi if asleep (returns true when it did) and restarts the idle-variety
  // schedule too: a fresh input episode is a fresh idle.
  noteInput() {
    const woke = this.noteActivity({ wake: true });
    this.nextVarietyAt = performance.now() + rand(this.random, IDLE_VARIETY_MIN_MS, IDLE_VARIETY_MAX_MS);
    return woke;
  }

  // Activity that is NOT a fresh owner input -- a pointer move or a board/HUD reaction. It counts for the
  // bored/sleepy escalation (lastInputAt / nextBoredAt) but deliberately LEAVES nextVarietyAt alone: pointer
  // movement used to push the 15-40 s variety timer out on every move, so anh at the PC never saw an idle arm
  // gesture (DIAG 20-10 §3.2, measured 0 variety plays in the 90 s mouse phase).
  // `wake` is opt-in: a board/HUD reaction already exits 'sleepy' and has its own gesture, so it must not also
  // fire the wake startle (the re-sleep loop fix, DIAG §5 step 1); a pointer move keeps waking her as before.
  noteActivity({ wake = false } = {}) {
    this.lastInputAt = performance.now();
    this.nextBoredAt = this.lastInputAt + IDLE_BORED_MS;
    if (wake && this.states.has('sleepy')) { this.exitState('sleepy'); this.trigger('wake'); return true; }
    return false;
  }

  // Mouth weights {aa, ih, ou, ee, oh} from the speech player for this frame, or null when silent.
  setSpeechMouth(weights) { this.speechMouth = weights || null; }

  // The board/chat "working" signal (T-31 C1 step 7, set by app.js from hud/work-signal.js). The work loop reads it;
  // it triggers nothing here, so it cannot add latency to a reflex -- except cursor suppression in trigger(), which
  // is a return, not work (CONCEPTS §5: while working the panel owns the gaze).
  // A false->true edge also wakes her (review S3): idleTimers() returns early while working, so nothing else would
  // ever exit 'sleepy' and she would reach for the panel asleep. noteActivity() without `wake` (no startle gesture)
  // keeps the ladder's clock honest for when the work ends; the exit only releases the sleepy instance -- still no
  // new trigger, so the reflex-latency rule is intact.
  setWorking(on) {
    const next = Boolean(on);
    const rising = next && !this.working;
    this.working = next;
    if (!rising) return;
    this.noteActivity();
    if (this.states.has('sleepy')) this.exitState('sleepy');
  }

  // The work loop's read-panel gaze (T-31 C1 step 8, CONCEPTS §4/§5). It writes the SAME primaryGaze slot gazeLayer
  // already uses as its baseline, so the pointer stops moving the gaze while a beat runs -- exactly the mouse rule,
  // with no second gaze path. null hands the active view's own target back (the work view's monitor, or the pointer
  // baseline when that view has none). Synchronous and allocation-light; never triggers or plays anything.
  setWorkGaze(point) {
    const valid = point && Number.isFinite(point.x) && Number.isFinite(point.y);
    this.primaryGaze = valid ? { x: point.x, y: point.y } : this.viewPrimaryGaze;
  }

  // The work loop's designed panel contact (T-31 C1 step 9). `point` is the world FINGERTIP point; the rig solves
  // the wrist so the hand tip lands there (rig.js 'panel-touch'). null / weight 0 clears it. A plain record, no
  // trigger, no player write: it is injected into the frame's reach accumulator only when no gesture owns that hand.
  setWorkReach(reach) {
    const p = reach && reach.point;
    const q = Array.isArray(p) ? { x: p[0], y: p[1], z: p[2] } : p; // the touch plan speaks world arrays
    const ok = reach && (reach.hand === 'left' || reach.hand === 'right') && q
      && Number.isFinite(q.x) && Number.isFinite(q.y) && Number.isFinite(q.z)
      && Number.isFinite(reach.weight) && reach.weight > 0;
    this.workReach = ok ? { hand: reach.hand, point: { x: q.x, y: q.y, z: q.z }, weight: clamp(reach.weight, 0, 1) } : null;
  }

  // The work loop's held expression (T-31 C1 step 10): the small smile of the look-at-anh beat. It is added to the
  // frame's expression accumulator AFTER the life layer and the player, so it never replaces a gesture's own face
  // (the loop clears it the moment a beat ends). One DRIVEN_EXPR name only -- a bad name cannot drive an arbitrary
  // morph. null clears it. A plain record: no trigger, no player write.
  setWorkExpression(expr) {
    const ok = expr && typeof expr.name === 'string' && DRIVEN_EXPR.includes(expr.name) && Number.isFinite(expr.weight) && expr.weight > 0;
    this.workExpression = ok ? { name: expr.name, weight: clamp(expr.weight, 0, 1) } : null;
  }

  setIdleFor(seconds) { this.lastInputAt = performance.now() - seconds * 1000; this.nextBoredAt = 0; this.nextVarietyAt = 0; }
  setLifeEnabled(on) { this.lifeEnabled = on; }

  // R4a: room look_targets, already projected to stage-NDC (room/room-stage.js projectLookTargets), cached by
  // the caller once per bind/room-switch -- called from app.js's placeAndFrame() after the camera is framed.
  // Drops any target inside the centre band (coordinator fix 03-10) -- filtered HERE, once, so picking never
  // has to re-check it; a room whose every target is near-centre degrades to the no-room fallback, same as a
  // room with no look_targets at all. Resets the glance anti-repeat history: a new room/model starts clean.
  setLookTargets(targets) {
    const list = targets || [];
    this.lookTargets = list.filter((p) => Math.abs(p.x) >= CENTRE_BAND_NDC);
    // primaryGaze (coordinator round 4, 2026-10-05: "work defaults to the monitor the same way talk defaults
    // to the camera") -- the one look_target room.json flags primary:true (room-stage.js's projectLookTargets
    // threads the flag through), if any, REPLACES the pointer-follow baseline in gazeLayer outright. Found
    // here (not a separate setter callers must also remember to call) so CameraDirector's existing single
    // setLookTargets(...) call on every view cut is still the only wiring needed. Bypasses the centre-band
    // filter above on purpose -- a monitor dead-centre in frame is still "the default gaze", not a target to
    // drop as "no visible glance".
    this.viewPrimaryGaze = list.find((p) => p.primary) || null;
    this.primaryGaze = this.viewPrimaryGaze;
    this.life.lookHistory = [];
  }

  // The head-yaw angle (degrees) gazeLayer's own formula would turn toward for a gaze-space x (same tanX/GAIN
  // it uses) -- what "how far she turns to look at this" means, independent of the easing/follow-strength
  // applied on top each frame. Needs a bound camera (gazeLayer never runs without one either).
  headYawDeg(x) {
    const cam = this.camera;
    const tanX = Math.tan((cam.fov * DEG) / 2) * cam.aspect;
    return Math.atan(x * tanX * GAZE_GAIN) * (180 / Math.PI);
  }

  // Coordinator fix (03-10): every glance turns the head >= MIN_GLANCE_YAW_DEG, clamped UP (never down) when
  // the target itself would yaw less -- sign preserved, x===0 (should not occur past the centre-band filter)
  // defaults to +.
  enforceMinYaw(x) {
    if (Math.abs(this.headYawDeg(x)) >= MIN_GLANCE_YAW_DEG) return x;
    const cam = this.camera;
    const tanX = Math.tan((cam.fov * DEG) / 2) * cam.aspect;
    const sign = x < 0 ? -1 : 1;
    return (sign * Math.tan(MIN_GLANCE_YAW_DEG * DEG)) / (tanX * GAZE_GAIN);
  }

  // ---------- dispatch ----------
  // The ONE gate every command crosses on its way to the player: while the float-holo panel is shown, the reaches
  // that would sweep a hand through it are stripped first (clampForHoloPanel above). Both dispatch paths below --
  // catalog triggers and the external/LLM playCommand -- call this, so no path can bypass the panel clamp.
  playGuarded(command, opts) {
    return this.player.play(this.holoPanel ? clampForHoloPanel(command) : command, opts);
  }

  // No model on stage (none bundled until one is chosen): every trigger is a no-op, so nothing queues up unplayed.
  // payload.look: an optional one-shot stage-NDC {x, y} for the command's 'dynamic' lookAt target (T-31 0.2.3 A1),
  // e.g. the exact HUD card that just changed.
  trigger(name, payload = {}) {
    if (!this.vrm) return null;
    // CONCEPTS §5 (T-31 C1 step 8): while she is working the panel owns the gaze, so a pointer episode must not fire
    // the cursor reflex. Suppressed at the ONE dispatch gate (input.js still calls trigger('cursor') unchanged).
    if (name === 'cursor' && this.working) return null;
    const def = this.catalog.get(name);
    if (!def) return null;
    const v = this.catalog.pick(name);
    const res = this.playGuarded(v.command, { side: payload.side, look: payload.look, meta: { trigger: name, variant: v.id } });
    if (!res.ok) { console.error('[reflex] built-in gesture rejected', name, v.id, res.errors); return null; }
    if (def.state) {
      const prev = this.states.get(name);
      if (prev) this.player.release(prev);
      this.states.set(name, res.id);
      this.emit('state', { name, on: true });
    }
    const info = { id: res.id, trigger: name, variant: v.id, labelVi: `${t(`gesture.${name}.trigger`)} → ${t(`gesture.${name}.${v.id}`)}`, t0: performance.now() };
    this.track(info);
    this.emit('reaction', info);
    return info;
  }

  enterState(name, payload) { return this.states.has(name) ? null : this.trigger(name, payload); }
  exitState(name) {
    const id = this.states.get(name);
    if (id == null) return false;
    this.player.release(id);
    this.states.delete(name);
    this.emit('state', { name, on: false });
    return true;
  }
  isState(name) { return this.states.has(name); }

  // External (LLM / IPC) path: same validator, same player.
  // opts: { side?: 1|-1 (mirror side for mirror:'random' commands), labelVi?: owner-facing words for the chip }
  playCommand(command, source = 'gesture', opts = {}) {
    if (!this.vrm) return { ok: false, errors: ['no model loaded'], warnings: [] };
    const res = this.playGuarded(command, { side: opts.side, meta: { trigger: source, variant: command && command.id } });
    if (!res.ok) return res;
    const info = { id: res.id, trigger: source, variant: (command && command.id) || 'gesture', labelVi: opts.labelVi || commandLabelVi(command), t0: performance.now() };
    this.track(info);
    this.emit('reaction', info);
    return { ...res, trackId: res.id };
  }

  track(info) {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    this.pending.set(info.id, { ...info, started: false, resolve, promise });
  }
  waitLatency(id, timeoutMs = 3000) {
    const p = this.pending.get(id);
    if (!p) return Promise.resolve((this.latencies && this.latencies.get(id)) || null);
    return Promise.race([p.promise, new Promise((r) => setTimeout(() => r(null), timeoutMs))]);
  }

  // ---------- test support ----------
  resetForTest() {
    this.player.stopAll(true);
    this.states.clear();
    this.pending.clear();
    this.follow = { ...DEFAULT_FOLLOW };
    this.pointer.x = 0; this.pointer.y = 0.05; this.pointer.at = performance.now();
    this.eyeG = { x: 0, y: 0.05 }; this.headG = { x: 0, y: 0.05 };
    this.lastInputAt = performance.now();
    this.nextVarietyAt = this.lastInputAt + rand(this.random, IDLE_VARIETY_MIN_MS, IDLE_VARIETY_MAX_MS);
    if (this.vrm && this.vrm.springBoneManager) this.vrm.springBoneManager.reset();
  }

  // ---------- per frame ----------
  update(dt) {
    if (!this.vrm) return;
    const now = performance.now();
    dt = Math.min(dt, 0.1);
    this.idleTimers(now);
    const acc = this.acc;
    acc.reset();
    this.lifeLayer(acc, now);
    this.player.evaluate(acc, now);
    // While Zumi speaks, the voice owns the mouth: mouth shapes authored inside gestures are dropped for those frames.
    if (this.speechMouth) for (const m of MOUTH) acc.expr[m] = this.speechMouth[m] || 0;
    // T-31 C1 step 10: the work loop's held expression (the look-at-anh smile), added on top of the life layer and the
    // player -- never in place of a gesture's face (the loop clears it whenever a reaction or a task event plays).
    if (this.workExpression) acc.expression(this.workExpression.name, this.workExpression.weight);
    for (const p of this.pending.values()) {
      if (p.started) continue;
      const inst = this.player.find(p.id);
      if (inst && inst.lastMag > START_MAG) p.started = true;
    }
    this.gazeLayer(acc, now, dt);
    this.applyPose(acc, dt);
  }

  afterRender() {
    const now = performance.now();
    if (!this.latencies) this.latencies = new Map();
    for (const [id, p] of this.pending) {
      if (p.started) {
        const ms = now - p.t0;
        const rec = { id, trigger: p.trigger, variant: p.variant, ms };
        this.latencies.set(id, rec);
        this.pending.delete(id);
        p.resolve(rec);
        this.emit('latency', rec);
      } else if (now - p.t0 > 3000) {
        this.pending.delete(id);
        p.resolve(null);
      }
    }
  }

  // Rough 0..1 "is any one-shot reflex/gesture live right now" (shared by lifeLayer's sway-ducking and R4a's
  // idle-variety/glance gates -- the same busy signal, one place).
  isBusy(now) {
    let busy = 0;
    for (const i of this.player.instances) if (!i.cmd.sustain && i.cmd.interrupt) busy = Math.max(busy, this.player.presence(i, now));
    return busy;
  }

  idleTimers(now) {
    if (!this.autoIdle) return;
    // C1 step 8: while she is working the work loop owns the stage -- the bored/sleepy ladder (and its idle-variety
    // beats) must not interrupt a beat. Keep the ladder's clock fresh, so normal idle resumes 60 s after work ends
    // (CONCEPTS §5: work ends after 10 min of no board activity, then "normal idle" -- not an instant sleep).
    if (this.working) { this.lastInputAt = now; this.nextBoredAt = now + IDLE_BORED_MS; return; }
    const idle = now - this.lastInputAt;
    if (this.states.has('sleepy')) return;
    if (idle > IDLE_SLEEPY_MS) {
      for (const s of [...this.states.keys()]) this.exitState(s);
      this.trigger('sleepy');
      return;
    }
    if (idle > IDLE_BORED_MS && now >= this.nextBoredAt) {
      this.trigger('bored');
      this.nextBoredAt = now + rand(this.random, 9000, 16000);
      return;
    }
    // R4a idle variety (PLAN-R4-lean.md §R4a): every 15-40 s of real idle, independent of the bored/sleepy
    // ladder above. Yields (does not fire) while a one-shot reflex is live, while typing, or while Zumi is
    // speaking; resumes on its own schedule once the gate clears. Never touches trigger()/play() itself, so
    // reflex dispatch latency is unaffected either way (the binding gate this task must prove).
    if (now >= this.nextVarietyAt && !this.states.has('typing') && !this.speechMouth && this.isBusy(now) < 0.3) {
      this.trigger('bored');
      this.nextVarietyAt = now + rand(this.random, IDLE_VARIETY_MIN_MS, IDLE_VARIETY_MAX_MS);
    }
  }

  lifeLayer(acc, now) {
    if (!this.lifeEnabled) return;
    const L = this.life, r = this.random, t = now / 1000;
    const busy = this.isBusy(now);
    const sway = 1 - 0.6 * busy;
    const sleepy = this.states.has('sleepy');
    const bp = sleepy ? 6.0 : 4.2, ba = sleepy ? 1.7 : 1;
    const br = Math.sin((2 * Math.PI * t) / bp);
    const ph = L.phase;
    const n = (i, f) => (Math.sin(t * f + ph[i]) + 0.6 * Math.sin(t * f * 2.13 + ph[i] * 1.7) + 0.3 * Math.sin(t * f * 3.71 + ph[i] * 2.3)) / 1.9;
    acc.bone('chest', 0.013 * ba * br, 0, 0);
    acc.bone('spine', 0.006 * ba * br, 0, 0);
    acc.bone('leftShoulder', 0, 0, 0.014 * ba * br);
    acc.bone('rightShoulder', 0, 0, -0.014 * ba * br);
    acc.bone('head', 0.02 * n(0, 0.31) * sway, 0.04 * n(1, 0.23) * sway, 0.03 * n(2, 0.19) * sway);
    acc.bone('neck', 0.008 * n(3, 0.27) * sway, 0.012 * n(4, 0.21) * sway, 0);
    acc.bone('spine', 0, 0.02 * n(5, 0.09) * sway, 0.012 * n(3, 0.13) * sway);

    // blinks: varied interval, some double blinks
    if (now >= L.blinkNext) {
      L.blinkStart = now;
      L.blinkDur = rand(r, 130, 210);
      const dbl = r() < 0.18;
      L.blinkNext = now + (dbl ? rand(r, 230, 320) : rand(r, 1600, 5600));
    }
    if (L.blinkStart >= 0) {
      const x = (now - L.blinkStart) / L.blinkDur;
      if (x >= 1) L.blinkStart = -1;
      else acc.expression('blink', x < 0.4 ? x / 0.4 : 1 - (x - 0.4) / 0.6);
    }

    // R4a idle glance: toward the room's look_targets when a room is loaded (anti-repeat -- never the same
    // target twice in a row, last-3 window), otherwise the plain random-offset look-around (no room = exactly
    // today's behaviour). Only starts a NEW glance while the pointer has been still, nothing is busy, the
    // owner isn't typing, and Zumi isn't speaking; yields immediately on any of those (gx/gy drop to 0, eased
    // back to the pointer/camera baseline by gazeLayer's own smoothing) and resumes once the gate clears.
    L.gx = 0; L.gy = 0;
    // C1 step 8: an idle glance would pull the gaze off the work panel mid-beat, so it yields while working -- the
    // work loop owns the gaze (its own look-at-anh beat arrives in C1 step 10). Micro-saccades stay: eyes still live.
    const canGlance = now - this.pointer.at > 2500 && busy < 0.3 && !this.states.has('typing') && !this.speechMouth && !this.working;
    if (canGlance) {
      if (now >= L.glanceNext && now >= L.glanceUntil) {
        if (this.lookTargets.length) {
          const hist = L.lookHistory;
          const pool = this.lookTargets.filter((p) => !hist.includes(p.name));
          const cand = pool.length ? pool : this.lookTargets;
          const pick = cand[Math.floor(r() * cand.length)];
          L.glanceTo = [pick.x, pick.y];
          hist.push(pick.name);
          if (hist.length > GLANCE_RING) hist.shift();
        } else {
          const sx = r() < 0.5 ? -1 : 1;
          L.glanceTo = [sx * rand(r, 0.5, 1.2), rand(r, -0.45, 0.4)];
        }
        L.glanceTo[0] = this.enforceMinYaw(L.glanceTo[0]);
        L.glanceFrom = now;
        L.glanceUntil = now + rand(r, GLANCE_MIN_MS, GLANCE_MAX_MS);
        L.glanceNext = L.glanceUntil + rand(r, 5000, 12000);
      }
      if (now < L.glanceUntil && L.glanceTo) {
        const k = Math.min(1, (now - L.glanceFrom) / 120, (L.glanceUntil - now) / 160);
        L.gx = L.glanceTo[0] * k; L.gy = L.glanceTo[1] * k;
      }
    }
    // micro-saccades
    if (now >= L.saccNext) { L.sx = rand(r, -0.05, 0.05); L.sy = rand(r, -0.035, 0.035); L.saccNext = now + rand(r, 350, 1400); }
  }

  gazeLayer(acc, now, dt) {
    const f = this.follow, L = this.life;
    const p = this.pointer;
    if (now - p.at > 6000) { const k = 1 - Math.exp(-0.6 * dt); p.x += (0 - p.x) * k; p.y += (0.05 - p.y) * k; }
    // primaryGaze (coordinator round 4): the active view's own default-gaze point REPLACES the pointer baseline
    // outright when set (work's monitor) -- the life layer's glance/saccade offsets below still apply on top,
    // same as they always did against the pointer baseline.
    const base = this.primaryGaze || p;
    let gx = base.x, gy = base.y;
    if (this.lifeEnabled) { gx += L.gx + L.sx; gy += L.gy + L.sy; }
    if (acc.gw > 0) {
      const ow = Math.min(1, acc.gw);
      const ox = (acc.gx + acc.gCursorW * p.x) / acc.gw, oy = (acc.gy + acc.gCursorW * p.y) / acc.gw;
      gx += (ox - gx) * ow; gy += (oy - gy) * ow;
    }
    const ke = 1 - Math.exp(-22 * dt), kh = 1 - Math.exp(-f.rate * dt);
    this.eyeG.x += (gx - this.eyeG.x) * ke; this.eyeG.y += (gy - this.eyeG.y) * ke;
    this.headG.x += (gx - this.headG.x) * kh; this.headG.y += (gy - this.headG.y) * kh;

    const cam = this.camera;
    const tanY = Math.tan((cam.fov * DEG) / 2), tanX = tanY * cam.aspect;
    const yaw = Math.atan(this.headG.x * tanX * GAZE_GAIN), pitch = Math.atan(this.headG.y * tanY * GAZE_GAIN);
    const hf = f.head;
    acc.bone('neck', -pitch * 0.35 * hf, yaw * 0.35 * hf, 0);
    acc.bone('head', -pitch * 0.65 * hf, yaw * 0.65 * hf, -f.tilt * DEG * clamp(this.headG.x, -1, 1));
    acc.bone('spine', 0, yaw * f.spine, 0);

    // eye target: a point on the viewer's plane
    const headPos = this.rig.nodes.head.getWorldPosition(new THREE.Vector3());
    const D = cam.position.distanceTo(headPos);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
    this.gazeObj.position.copy(cam.position)
      .addScaledVector(right, this.eyeG.x * D * tanX * GAZE_GAIN)
      .addScaledVector(up, this.eyeG.y * D * tanY * GAZE_GAIN);
    this.gazeObj.updateMatrixWorld();
  }

  applyPose(acc, dt) {
    const rig = this.rig, nodes = rig.nodes;
    const sampled = this.clips.sample(acc.clips);
    if (!sampled && this.clips.wasActive) this.vrm.humanoid.resetNormalizedPose();
    this.clips.wasActive = sampled;

    // torso / head / shoulders / hands (missing chest bones fall back down the chain)
    const redirect = { upperChest: ['chest', 'spine'], chest: ['spine'], neck: ['head'] };
    const final = {};
    for (const name of TORSO) final[name] = [0, 0, 0];
    for (const [name, v] of Object.entries(acc.bones)) {
      if (FK_ARM.includes(name)) continue;
      let target = name;
      if (!nodes[target]) target = (redirect[name] || []).find((n) => nodes[n]) || null;
      if (!target || !final[target]) continue;
      final[target][0] += v[0]; final[target][1] += v[1]; final[target][2] += v[2];
    }
    for (const name of TORSO) {
      const node = nodes[name];
      if (!node) continue;
      const lim = BONE_LIMITS_DEG[name];
      const v = final[name];
      node.rotation.set(clamp(v[0], -lim[0] * DEG, lim[0] * DEG), clamp(v[1], -lim[1] * DEG, lim[1] * DEG), clamp(v[2], -lim[2] * DEG, lim[2] * DEG));
    }
    rig.setRoot(acc.root);
    rig.root.updateMatrixWorld(true);
    rig.solveLegs(acc.rootActive);
    // T-31 C1 step 9 + review R1: the work loop's one designed contact joins this frame's reach requests -- after the
    // holo clamp (playGuarded), so it needs no clamp exception -- and it yields to a live gesture by WEIGHT, never by
    // dropping out: a command that reaches with the same hand gets the gesture's share and the contact keeps its own,
    // so rig.solveArms hands the arm over through both envelopes (a dropped contact snapped home from the glass).
    if (this.workReach) {
      acc.reach.push({ hand: this.workReach.hand, target: 'panel-touch', point: this.workReach.point, weight: this.workReach.weight, offset: null, mirror: 1 });
    }
    rig.solveArms(acc.reach, this.armSwing(acc, dt), dt);
    rig.applyHands(acc.hands);
    // explicit FK arm rotations from commands: on top of the IK result (IK rewrites these bones every frame)
    for (const name of FK_ARM) {
      const node = rig.vrm.humanoid.getNormalizedBoneNode(name);
      if (!node) continue;
      const v = acc.bones[name] || [0, 0, 0];
      const side = name.startsWith('left') ? 'left' : 'right';
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(v[0], v[1], v[2]));
      if (rig.arms[side]) { if (v[0] || v[1] || v[2]) node.quaternion.multiply(q); } else node.quaternion.copy(q);
    }
    if (sampled) this.clips.blend();

    // expressions: clamp, keep emotion / mouth groups from over-driving the face
    const ex = {};
    for (const n of DRIVEN_EXPR) ex[n] = clamp(acc.expr[n] || 0, 0, 1);
    for (const group of [EMOTIONS, MOUTH]) {
      const s = group.reduce((a, n) => a + ex[n], 0);
      if (s > 1) for (const n of group) ex[n] /= s;
    }
    const em = this.vrm.expressionManager;
    if (em) for (const n of DRIVEN_EXPR) em.setValue(n, ex[n]);
    this.lastFinal = { final, ex };
    this.vrm.update(dt);
  }

  // Secondary arm motion from vertical root motion (a jump): arms go back and down while crouching, up and forward
  // while rising, float a little while falling, then settle. Offsets in arm lengths; none without a root channel.
  armSwing(acc, dt) {
    const ry = acc.rootActive ? acc.root[1] : 0;
    const vy = this.prevRootY == null ? 0 : (ry - this.prevRootY) / Math.max(dt, 1e-3);
    this.prevRootY = ry;
    this.rootVy = (this.rootVy || 0) + (vy - (this.rootVy || 0)) * Math.min(1, dt * 18);
    if (!acc.rootActive && Math.abs(this.rootVy) < 0.01) return null;
    const crouch = clamp(-ry / 0.1, 0, 1), rise = clamp(this.rootVy / 0.9, 0, 1), fall = clamp(-this.rootVy / 0.9, 0, 1);
    return { up: 0.4 * rise + 0.12 * fall - 0.1 * crouch, fwd: 0.22 * rise - 0.32 * crouch };
  }

  // Compact numeric snapshot of the applied pose (for self-test "did anything visibly change").
  signature() {
    const out = [];
    if (!this.rig) return out;
    for (const name of [...TORSO, ...FK_ARM]) {
      const node = this.rig.nodes[name] || (this.rig.vrm.humanoid.getNormalizedBoneNode(name));
      if (node) out.push(node.quaternion.x, node.quaternion.y, node.quaternion.z, node.quaternion.w);
    }
    const quatLen = out.length; // leading 4-float quaternion blocks; the tail is scalars (see signatureDelta)
    if (this.lastFinal) for (const n of DRIVEN_EXPR) out.push(this.lastFinal.ex[n]);
    out.quatLen = quatLen;
    out.push(this.eyeG.x * 0.2, this.eyeG.y * 0.2);
    return out;
  }
  // Max-abs component difference, but q and -q are the same rotation: each quaternion block of b is sign-aligned to a
  // (dot < 0 -> negate) first, so a pure sign flip is 0 and real motion keeps the old component scale.
  static signatureDelta(a, b) {
    const n = Math.min(a.length, b.length), nq = Math.min(a.quatLen || 0, b.quatLen || 0, n);
    let m = 0;
    for (let i = 0; i < nq; i += 4) {
      const dot = a[i] * b[i] + a[i + 1] * b[i + 1] + a[i + 2] * b[i + 2] + a[i + 3] * b[i + 3];
      const s = dot < 0 ? -1 : 1;
      for (let k = 0; k < 4; k++) m = Math.max(m, Math.abs(a[i + k] - s * b[i + k]));
    }
    for (let i = nq; i < n; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
    return m;
  }

  hitRegions(rect) { return this.rig ? this.rig.hitRegions(this.camera, rect) : null; }
}
