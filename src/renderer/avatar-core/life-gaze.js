// avatar-core idle life + gaze: breathing, sway, irregular blinks, glances at the room's look targets, micro-saccades,
// and the head/eye follow of a pointer or a primary gaze point. Moved verbatim out of reflex/engine.js (T-31-ROOM-live-b
// P1) so the main webview and a second mount run the SAME code. It owns its state and writes into a ChannelAcc-shaped
// accumulator (bone(name,x,y,z), expression(name,v), gaze fields); it knows nothing of gestures, the player or the app --
// the caller says what is going on through `ctx` (busy / sleepy / typing / speaking / working, plus the camera).
import * as THREE from 'three';

const DEG = Math.PI / 180;
const GAZE_GAIN = 1.35; // how far "out of the screen" the cursor is treated (bigger = livelier head turns)
export const DEFAULT_FOLLOW = { head: 0.55, spine: 0.1, rate: 6, tilt: 0 };
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

export const FIELDS = ['life', 'pointer', 'eyeG', 'headG', 'gazeObj', 'follow', 'lookTargets', 'primaryGaze', 'viewPrimaryGaze', 'lifeEnabled'];

export class LifeGaze {
  constructor({ random = Math.random } = {}) {
    this.random = random;
    this.follow = { ...DEFAULT_FOLLOW };
    this.pointer = { x: 0, y: 0.05, at: 0 };
    this.eyeG = { x: 0, y: 0.05 };
    this.headG = { x: 0, y: 0.05 };
    this.gazeObj = new THREE.Object3D();
    this.lifeEnabled = true;
    this.lookTargets = []; // R4a: room look_targets projected to stage-NDC (setLookTargets) -- empty = no room, glance around as before
    this.primaryGaze = null; // {x,y} stage-NDC | null (coordinator round 4, 2026-10-05): the ACTIVE view's default-gaze point (setLookTargets / the work loop) -- gazeLayer's baseline when set, same role the pointer/camera plays for talk (which has none). null = the existing pointer-follow baseline, unchanged.
    this.viewPrimaryGaze = null; // the active view's own primary look_target (setLookTargets), kept so the work loop can hand it back when a working beat ends (C1 step 8)
    this.blinkHeld = false; // holdBlinks(): no blink starts and a running one ends (the eyes stay wide)
    this.life = { blinkNext: 0, blinkStart: -1, blinkDur: 160, glanceNext: 0, glanceUntil: 0, gx: 0, gy: 0, saccNext: 0, sx: 0, sy: 0, lookHistory: [], phase: [0, 1, 2, 3, 4, 5].map(() => random() * 100) };
  }

  // T-31-ROOM round 5 (CoS 6f1f77928f44): the caller holds the eyes wide (a surprised face's hold): while on, no blink starts and a running
  // blink ends; a blink that came due meanwhile fires right after the release.
  holdBlinks(on) { this.blinkHeld = Boolean(on); }

  setPointer(x, y) { this.pointer.x = clamp(x, -1.8, 1.8); this.pointer.y = clamp(y, -1.8, 1.8); this.pointer.at = performance.now(); }

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

  // Gaze-space (x, y) that points the eyes and head at a WORLD point, seen from `camera` (the inverse of the eye-target formula in
  // gazeLayer, GAIN included). The room's stage `gaze` anchors use it: set `primaryGaze` to this each frame while the camera moves.
  gazeNdcOfPoint(camera, point) {
    const ndc = point.clone().project(camera);
    return { x: ndc.x / GAZE_GAIN, y: ndc.y / GAZE_GAIN };
  }

  // The head-yaw angle (degrees) gazeLayer's own formula would turn toward for a gaze-space x (same tanX/GAIN
  // it uses) -- what "how far she turns to look at this" means, independent of the easing/follow-strength
  // applied on top each frame. Needs a bound camera (gazeLayer never runs without one either).
  headYawDeg(camera, x) {
    const tanX = Math.tan((camera.fov * DEG) / 2) * camera.aspect;
    return Math.atan(x * tanX * GAZE_GAIN) * (180 / Math.PI);
  }

  // Coordinator fix (03-10): every glance turns the head >= MIN_GLANCE_YAW_DEG, clamped UP (never down) when
  // the target itself would yaw less -- sign preserved, x===0 (should not occur past the centre-band filter)
  // defaults to +.
  enforceMinYaw(camera, x) {
    if (Math.abs(this.headYawDeg(camera, x)) >= MIN_GLANCE_YAW_DEG) return x;
    const tanX = Math.tan((camera.fov * DEG) / 2) * camera.aspect;
    const sign = x < 0 ? -1 : 1;
    return (sign * Math.tan(MIN_GLANCE_YAW_DEG * DEG)) / (tanX * GAZE_GAIN);
  }

  // ctx: { camera, busy 0..1 (a one-shot gesture is live), sleepy, typing, speaking, working, hold 0..1 (the caller fades it: the sway and the
  // breath go still, so a planned motion meets the torso it was planned on) }
  lifeLayer(acc, now, ctx) {
    if (!this.lifeEnabled) return;
    const L = this.life, r = this.random, t = now / 1000;
    const { busy, sleepy, hold = 0 } = ctx;
    const sway = (1 - 0.6 * busy) * (1 - hold);
    const bp = sleepy ? 6.0 : 4.2, ba = (sleepy ? 1.7 : 1) * (1 - hold);
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
    if (this.blinkHeld) L.blinkStart = -1;
    else if (now >= L.blinkNext) {
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
    const canGlance = now - this.pointer.at > 2500 && busy < 0.3 && !ctx.typing && !ctx.speaking && !ctx.working;
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
        L.glanceTo[0] = this.enforceMinYaw(ctx.camera, L.glanceTo[0]);
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

  // headNode: the model's head bone (its world position sets the eye-target distance).
  gazeLayer(acc, now, dt, camera, headNode) {
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

    const cam = camera;
    const tanY = Math.tan((cam.fov * DEG) / 2), tanX = tanY * cam.aspect;
    const yaw = Math.atan(this.headG.x * tanX * GAZE_GAIN), pitch = Math.atan(this.headG.y * tanY * GAZE_GAIN);
    const hf = f.head;
    acc.bone('neck', -pitch * 0.35 * hf, yaw * 0.35 * hf, 0);
    acc.bone('head', -pitch * 0.65 * hf, yaw * 0.65 * hf, -f.tilt * DEG * clamp(this.headG.x, -1, 1));
    acc.bone('spine', 0, yaw * f.spine, 0);

    // eye target: a point on the viewer's plane
    const headPos = headNode.getWorldPosition(new THREE.Vector3());
    const D = cam.position.distanceTo(headPos);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
    this.gazeObj.position.copy(cam.position)
      .addScaledVector(right, this.eyeG.x * D * tanX * GAZE_GAIN)
      .addScaledVector(up, this.eyeG.y * D * tanY * GAZE_GAIN);
    this.gazeObj.updateMatrixWorld();
  }
}
