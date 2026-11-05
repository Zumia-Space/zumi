// CameraDirector (T-31 camera modes, PLAN-camera-modes.md + coordinator rounds 2-3): picks a view (talk/work/room)
// from state every frame, eases the camera over 300ms and cross-fades the plate canvas, and tells the reflex
// engine which look_targets are live for the active view. Lives OUTSIDE the player/rig, between engine.update(dt)
// and renderer.render(...) in app.js's own loop -- it never awaits I/O and never calls engine.trigger()/play(), so
// a view switch can never add latency to a reflex (the binding gate: forced switches every 2s, ON latency must
// equal OFF). Plates are textures the loader already preloaded (room-loader-v2.js); this module only draws them.
//
// Round 2: each view is its OWN local coordinate frame (separate paintings) -- camera.position/target/fov/aspect/
// viewOffset, the occluders group, the light rig, AND Zumi's own seat placement all swap together, synchronously,
// at the START of a switch (same moment, not spread across the 300ms ease -- only the camera's own position/
// target/fov interpolate on screen; everything else is a clean cut, like a camera operator reaching for a
// different, pre-aimed camera and the actor staying in her chair while the DIRECTOR calls which lens is live).
import * as THREE from 'three';
import { projectLookTargets } from './room-stage.js';
import { FLOAT } from './float-mode.js'; // the float rest height (soleY) the close crop follows (see FLOAT_CLOSE)

const EASE_MS = 300;
const ROOM_IDLE_MS = 60_000;
const VIEWS = ['talk', 'work', 'room'];
const easeOutCubic = (k) => 1 - Math.pow(1 - k, 3);
// "Chest-up (webcam)" framing (coordinator addendum, owner priority 03-10): a further crop/zoom on TOP of the
// base cover-crop below, centred toward the upper body instead of the frame centre.
// Owner QC round 2 (talk-cam-up, 2026-10-07 17:45): "the camera angle should go up a little" -- raised zoom
// 1.9 -> 2.2 to buy headroom. That fix was built on a BROKEN premise: biasUp shifts the window by a fraction of
// the window's OWN height (`biasUp * h`), which shrinks every time zoom narrows the window -- so a fixed biasUp
// silently loses reach as zoom grows, and at 0.78 it was already saturated (clamped against the plate's y=0
// edge) *before* that nudge. Raising zoom "worked" for headroom only as an accident of a smaller window making
// the same fixed hairline row land at a larger fraction of it -- it also shrank the window enough that almost
// nothing but her head fit inside it.
// Owner QC round 3 (talk-framing, 2026-10-07 later): "I only see the head... zoom out a bit" -- at zoom 2.2 the
// window was a ~45%-of-plate-width x ~43%-of-plate-height slice pinned to the plate's top edge (y=0, the same
// saturation above), so most of the frame was empty headroom above her and only her head+collar fit below it
// before the window's bottom edge cut her off. biasUp cannot fix this: it is a window-relative knob fighting a
// clamp, not a position. The actual mechanism fix (replacing biasUp for this preset): `anchor` centres the crop
// on a PLATE-space target point -- `plateYFrac` is WHERE her face sits in the plate (a fixed fraction of plate
// height, independent of zoom), `frameYFrac` is where we want that point to land in the OUTPUT frame. The
// window's y is solved directly from those two numbers (see coverCropRect), then clamped to the plate bounds --
// clamping is now a true edge case (the anchor is nowhere near plate row 0), not the normal operating point.
// `plateYFrac` (0.269) was MEASURED, not eyeballed: at any zoom/bias/aspect, projecting the VRM 'head' bone
// (jaw/neck-base pivot) through the live camera and inverting this frame's own crop window back into plate
// pixels gives the SAME row every time (33.98% of 1920x1200, confirmed across zoom 1/2.2 and all 3 aspects
// below) -- proof the row is an intrinsic property of her pose in the plate, not an artifact of the crop. Her
// hairline (room.json's own registration data, mannequinHeadTopRow 237/1200 = 19.75%) and that head-bone row
// bracket her face; their midpoint (26.9%) is the face-centre anchor used here. `frameYFrac` (0.375) is the
// owner's spec ("face centre at 35-40% from the top"), its midpoint. zoom (1.45) was re-solved (not reused from
// either prior value) against the owner's new brief ("waist up: both shoulders, the arms, the chair back +
// armrests") using the same measured-bone technique for her waist (spine/hips bones, ~64-67% of plate height)
// -- before/after renders + measurements.md (the talk-hotfix install notes) confirm shoulders, forearms
// and the chair back + armrests are all in frame at all 3 tested aspects, with the face centred 35-39% down.
// zoom 1.45 is also a DELIBERATE ceiling, not just the tightest crop that fit the brief: her hips bone lands at
// ~96-108% down the frame (at/past the bottom edge) at every tested aspect -- i.e. the hip joint itself is never
// actually shown. Tested wider (zoom 1.15, hips ~83% down, visible) and her legs read as straight/vertical from
// this front angle with a visible gap between her thighs and the cushion -- she looks like she's standing/
// perched in front of the chair, not sitting in it (the sit-idle clip's leg pose was never authored to look
// convincing from a front angle past the hip -- talk has no `seat_cushion_line`/`allowed_region` gate the way
// work does (check-work-fit.mjs) to catch this). Do not zoom out further than this without EITHER fixing that
// pose/authoring a talk seat-contact gate first, or re-confirming (by render) that the hip joint still stays
// off-frame at the new zoom.
const CHEST_UP = { zoom: 1.45, anchor: { plateYFrac: 0.269, frameYFrac: 0.375 }, biasRight: 0 };
// Work-view "tight over-the-shoulder" framing (coordinator round 7, NEW APPROACH B): camera stays where it is
// (re-solving an actual new camera position needs Vesta's own fSpy/camlib pipeline, out of scope here) --
// instead a further crop/zoom, same mechanism as CHEST_UP, narrows the window and biases it up AND right so
// the painted backrest fills the lower frame (hiding everything below her shoulder blades -- round 6's whole
// lower-body/occluder fight becomes moot, there is nothing left below the crop to occlude) while the desk/
// monitor/keyboard -- which sit to her right in this plate -- stay in frame instead of being cropped off by a
// centred zoom. Tuned by eye against the round-7 brief ("only head, shoulders, upper back and forearms show;
// monitor + hands-on-keyboard both visible"), not solved analytically (same posture as CHEST_UP).
const WORK_OVER_SHOULDER = { zoom: 1.35, biasUp: 0.30, biasRight: 0.22 };
// Float-view "wide" framing (T-31 float-holo pilot): in floating mode she hangs full-body mid-frame, so the talk
// crop sits wider than CHEST_UP. Same `anchor` mechanism as CHEST_UP (plate-space target, immune to the biasUp
// saturation bug) -- here the anchor is her float head row (plateYFrac 0.149). zoom 1.14 fits her whole body
// (head top and soles) inside the crop with the 5%/8% margins at 16:10, 16:9 AND the harness's own 1204x689
// stage, while the 7 video rooms still COVER it (zen-garden's rect is only 1080 px tall, so the 16:10 window may
// not exceed it: zoom >= 1.111). Selected by app.js's getFramingOverride wrapper (o.float).
// r5: raising the rest hover (soleY 0.115 -> 0.210, so the toe tip reads at the top of the brief's 8-12 cm band)
// lifted her whole body in the plate: her head row moves 0.149 -> 0.127 and the frame is re-solved (frameYFrac
// 0.15 -> 0.13) so the crown keeps its >= 5% top margin at the tightest aspect (worst crown 5.2%, head 11.1%,
// ankle 14.0%) while the 7 video rects still cover the crop (a higher window would expose the plate's uncovered
// top rows at 1600x1000). The zoom is unchanged, so the room coverage and "close panel larger than wide" hold.
const FLOAT_WIDE = { zoom: 1.14, anchor: { plateYFrac: 0.127, frameYFrac: 0.13 }, biasRight: 0 };
// Float-view "close" framing (T-31 float-holo cheap win 3): the harness's `--framing close` still/clip crop, made
// so the rim light actually reads. The wide crop fits her whole body, so at that size the cyan rim is a hairline
// on her white jacket; this is a head-to-knees crop (head ~16% below the top, knees ~2-9% above the bottom, her
// feet cropped below) that brings the holo panel ~2x larger and keeps it fully inside the frame (worst panel NDC
// 0.6) without touching her face box. Same `anchor` mechanism as FLOAT_WIDE; biasRight -0.06 nudges the window
// left so the camera-left panel stays in. Solved against the talk camera + the 7 video rooms by
// scripts/check-float-holo.mjs (which asserts the close crop is still covered at 16:10/16:9/1204x689).
//
// r4b: the crop FOLLOWS the float rest height. r3's anchor was solved at FLOAT.soleY = 0.18 m; r4 lowered the rest
// hover into the brief's readable band (0.115 m), which dropped her whole body ~6.5 cm in world space and pushed the
// knee bone out of the fixed window (check: worst knee -3.3% below the bottom). `frameYFrac` is now derived from
// FLOAT.soleY: the close window is a pure cover-crop of a fixed-size sensor, so per aspect the map is exactly linear
// (measured world->frame slopes 0.856 / 0.784 / 0.871 per metre at 1204x689 / 1600x1000 / 1920x1080). The constant
// takes the STEEPEST (1920x1080), so the tightest aspect still gets enough window travel; that the knee then stays
// in frame at ALL three aspects is asserted by scripts/check-float-holo.mjs (section 9), which is what stops a future
// soleY change from silently cropping her knees. r5 raised soleY to 0.210 m (toe-tip reading 0.12 m); the derived
// frameYFrac moved with it and the section-9 knee check still passes (worst 2.4% above the bottom).
const FLOAT_CLOSE_REF = { soleY: 0.18, frameYFrac: 0.20 }; // the r3 placement this anchor was first solved at
const CLOSE_FRAME_FRAC_PER_M = 0.871; // the steepest aspect's world->frame slope (1920x1080); see above
const FLOAT_CLOSE = {
  zoom: 1.7,
  anchor: { plateYFrac: 0.149, frameYFrac: FLOAT_CLOSE_REF.frameYFrac - (FLOAT_CLOSE_REF.soleY - FLOAT.soleY) * CLOSE_FRAME_FRAC_PER_M },
  biasRight: -0.06,
};

/** The "cover" crop of a `plateW` x `plateH` source image that fills a `canvasW` x `canvasH` destination with
 *  NO padding (the opposite of the old "contain" fit this replaces -- PLAN-room-look-fix.md QC: plates must
 *  never letterbox/pillarbox). Returns the source-pixel rectangle to sample; the destination is always the
 *  full canvas. `zoom`>1 narrows the window further (magnifies, see CHEST_UP); `biasRight` shifts the window
 *  right by that fraction of its own width (round 7: work's off-centre subject+desk composition needs this).
 *  Vertical placement is either of two mechanisms (never both):
 *   - `anchor` ({plateYFrac, frameYFrac}, CHEST_UP): centres the window on a PLATE-space target point (a FIXED
 *     row, independent of zoom) so that point lands at `frameYFrac` of the output frame -- solved directly, then
 *     clamped to the plate bounds. Immune to the saturation bug below by construction: the target never moves.
 *   - `biasUp` (WORK_OVER_SHOULDER, legacy): shifts the window up by that fraction of its OWN height (0 =
 *     centred, toward 1 = hugs the plate's top edge). Kept only for work's existing, still-correct framing --
 *     DO NOT reuse for a new preset: this is a window-relative shift, so a fixed biasUp silently loses reach as
 *     zoom narrows the window, and clamps (saturates) long before it looks like it should have room left (this
 *     is exactly what made CHEST_UP's old biasUp=0.78 impossible to push further -- see CHEST_UP's own comment).
 *  Both axes clamped to stay inside the source. */
function coverCropRect(plateW, plateH, canvasW, canvasH, zoom = 1, biasUp = 0, biasRight = 0, anchor = null) {
  const scale = Math.max(canvasW / plateW, canvasH / plateH);
  const w = (canvasW / scale) / zoom;
  const h = (canvasH / scale) / zoom;
  const x = Math.min(Math.max((plateW - w) / 2 + biasRight * w, 0), Math.max(0, plateW - w));
  const yWanted = anchor ? (anchor.plateYFrac * plateH - anchor.frameYFrac * h) : ((plateH - h) / 2 - biasUp * h);
  const y = Math.min(Math.max(yWanted, 0), Math.max(0, plateH - h));
  return { x, y, w, h };
}

export class CameraDirector {
  /** @param engine the bound ReflexEngine -- reused as the ONE idle clock (engine.lastInputAt, already bumped by
   *    every pointer move/typing/send in reflex/input.js) and the ONE "is she speaking" flag (engine.speechMouth).
   *  @param camera the stage's THREE.PerspectiveCamera (app.js's own, shared with the reflex engine's gaze).
   *  @param plateCtx a 2D canvas context the plate is drawn into every frame (null = no plate drawing, test-only).
   *  @param placeSeat (seat: {pos,rotYDeg,pose}) => void -- synchronous, positions/rotates the avatar's scene at
   *    the given view-local seat anchor (app.js owns the actual placeZumi() + cached ankle-drop call).
   *  @param defaultLights THREE lights the app's plain stage always has on (key/rim/ambient) -- hidden while the
   *    active view supplies its own `lights` (round 3), restored when it does not / when the room is unset.
   *  @param disabledViews string[] of view names this BUILD turns off (Thu 16:00 talk-QC build, option C: work
   *    off) -- main.js's app:info.disabledViews, forwarded by app.js. A disabled view is never auto-selected and
   *    never accepted as a manual pin; talk/room are unaffected either way. */
  constructor({ engine, camera, plateCtx, setLookTargets, placeSeat, defaultLights, getFramingOverride, disabledViews }) {
    this.engine = engine;
    this.camera = camera;
    this.plateCtx = plateCtx || null;
    this.setLookTargets = typeof setLookTargets === 'function' ? setLookTargets : () => {};
    this.placeSeat = typeof placeSeat === 'function' ? placeSeat : () => {};
    this.defaultLights = defaultLights || [];
    // app.js passes a Set (its own disabledViews), the checks pass arrays: take any iterable. An Array-only test here
    // turned app.js's Set into an EMPTY set, so no disabled view ever reached the director's auto rules.
    this.disabledViews = new Set(disabledViews && typeof disabledViews[Symbol.iterator] === 'function' && typeof disabledViews !== 'string' ? disabledViews : []);
    // Look-tuning panel (dev-only): (viewName) => {distanceM, heightM, fovDelta, chestUp} | null. Applied ON TOP
    // of the room's own authored camera every time a view's camera is computed -- never mutates the room data.
    this.getFramingOverride = typeof getFramingOverride === 'function' ? getFramingOverride : () => null;
    // Debug probe (scripts/probe-room-loop-electron.mjs): null = off, and null in every release. app.js sets it only when the page was
    // started with window.__zumiPlateProbe (injected over CDP by the probe harness, which no installed app has). Called once per drawPlate().
    this.plateProbe = null;
    this.defaultFov = camera.fov; // the plain stage's own fov (app.js PerspectiveCamera(28, ...)): what "No room" restores
    this.room = null; // loadRoomV2() result, or null (no room / a v1 room / plain stage -- this director is then idle)
    this.view = 'talk';
    this.switching = false;
    this.plateFade = 1;
    this.working = false; // work-signal stub (setWorking) -- no real source yet (PLAN: "stub API now")
    this.scene = null; // video room (scene-video.js SceneVideo) replacing the talk plate, or null = the painted plate
  }

  /** Video rooms (T-31 room picker): `scene` (a SceneVideo with a room loaded) replaces the TALK plate's pixels; null
   *  restores the painted plate. The videos exist for the talk camera only, so while one is on the director stays on
   *  talk (no work/room auto-switch, no manual pin to them) -- the other views' plates would not match it. */
  setScene(scene) {
    this.scene = scene || null;
    if (this.scene) { this.manualView = null; if (this.room) this.beginSwitchOrCut('talk'); }
  }

  /** @param room loadRoomV2() result, or null to disable (v1 room / no room / the plain stage). */
  setRoom(room) {
    this.room = room || null;
    this.switching = false;
    this.plateFade = 1;
    if (this.room) this.jumpToView('talk');
    else this.clearStage();
  }

  /** "No room": back to the plain stage. update() is a no-op once room is null, so nothing else would ever repaint or reset:
   *  the old room's last frame would stay on #stage-plate and its view's fov/aspect on the camera (a tab click's resize()
   *  racing the pick made this visible). aspect follows the live plate canvas, exactly as app.js resize() sets it. */
  clearStage() {
    this.camera.clearViewOffset();
    for (const l of this.defaultLights) l.visible = true;
    if (Number.isFinite(this.defaultFov)) this.camera.fov = this.defaultFov;
    if (this.plateCtx) {
      const { width, height } = this.plateCtx.canvas;
      if (width && height) this.camera.aspect = width / height;
      this.plateCtx.clearRect(0, 0, width, height);
    }
    this.camera.updateProjectionMatrix();
  }

  // ---------- inputs: synchronous, no I/O (safe to call from any event handler) ----------
  setWorking(on) { this.working = Boolean(on); } // stub: no real "is she working" signal exists yet

  /** Manual override (owner-facing "View: Talk/Work/Room" picker + Ctrl+1/2/3): pins the view so the automatic
   *  state->view rules below are skipped entirely, until setManualView(null) hands control back to them. The
   *  auto rules stay fully intact in code either way -- this is a precedence switch, not a removal. */
  setManualView(name) {
    this.manualView = (VIEWS.includes(name) && !this.disabledViews.has(name) && !(this.scene && name !== 'talk')) ? name : null;
    if (this.manualView && this.room) this.beginSwitchOrCut(this.manualView);
  }

  // Read-only on engine state (never mutates engine.lastInputAt -- that clock also drives the bored/sleepy
  // ladder in idleTimers(), and bumping it from here would change THAT behaviour as a side effect of a purely
  // camera-view decision). "Zumi speaking" is checked directly instead, so talk stays correct even on a very
  // long reply without reaching into the engine's own idle bookkeeping.
  desiredView() {
    if (!this.room) return 'talk';
    if (this.scene) return 'talk'; // a video room is talk-only (setScene)
    if (this.manualView) return this.manualView;
    // A disabled work view's own signal maps straight to talk (this build's option C), not through the idle/
    // speech rules below -- "working" has nothing useful to say about room once work itself is off.
    if (this.working) return this.disabledViews.has('work') ? 'talk' : 'work';
    if (this.engine.speechMouth) return 'talk';
    // A build that turns 'room' off (the phone: its portrait crop loses her) stays on talk when idle, as the constructor promises.
    if (performance.now() - this.engine.lastInputAt > ROOM_IDLE_MS && !this.disabledViews.has('room')) return 'room';
    return 'talk';
  }

  beginSwitchOrCut(view) { if (this.switching || this.view !== view) this.beginSwitch(view); }

  /** Per-frame: call once between engine.update(dt) and renderer.render(...). Never awaits I/O, never calls
   *  engine.trigger()/play() -- only reads engine.lastInputAt/speechMouth and writes this.camera/the avatar. */
  update() {
    if (!this.room) return;
    const wanted = this.desiredView();
    if (wanted !== this.view && !this.switching) this.beginSwitch(wanted);
    if (this.switching) this.stepSwitch();
    this.drawPlate();
  }

  // Everything that is a CUT, not an ease: occluders, lights, Zumi's own seat, camera.aspect. Called once at
  // the start of a switch (not spread across the 300ms) and by jumpToView's instant cut. The viewOffset itself
  // (the cover-crop, incl. chest-up zoom) is NOT set here -- it depends on the live canvas size, which can
  // change independently of a view switch (window resize), so it is recomputed every frame in syncFrame().
  applyViewSideEffects(name) {
    const v = this.room.views[name];
    for (const n of VIEWS) { const rv = this.room.views[n]; rv.occludersGroup.visible = (n === name); rv.lightsGroup.visible = (n === name) && rv.hasLights; }
    for (const l of this.defaultLights) l.visible = !v.hasLights; // a view's own lights REPLACE the default rig; no override -> keep the default
    if (v.seat) this.placeSeat(v.seat);
    this.camera.aspect = v.camera.aspect;
  }

  /** The room's authored camera for `name`, with the look-tuning panel's override (if any) applied on top:
   *  distanceM dollies along the camera->target axis (positive = pull back), heightM raises/lowers camera AND
   *  target together (keeps the look angle level), fovDelta adds to the base fov. Chest-up framing is NOT a
   *  dolly (moving the camera would desync its parallax against the fixed painted plate) -- it is a pure
   *  crop/zoom, applied identically to the plate and the camera's viewOffset in syncFrame(). Never mutates
   *  room data. */
  effectiveCamera(name) {
    const base = this.room.views[name].camera;
    const o = this.getFramingOverride(name);
    if (!o) return { position: base.position, target: base.target, fov: base.fov };
    const camDir = base.position.clone().sub(base.target); // points FROM target TO camera
    const len = Math.max(0.05, camDir.length() + (o.distanceM || 0));
    const position = base.target.clone().addScaledVector(camDir.normalize(), len);
    const heightM = o.heightM || 0;
    position.y += heightM;
    const target = base.target.clone(); target.y += heightM;
    const fov = base.fov + (o.fovDelta || 0);
    return { position, target, fov };
  }

  // ---------- transition ----------
  beginSwitch(view) {
    this.fromPos = this.camera.position.clone();
    this.fromTarget = (this.lastTarget || this.camera.position.clone()).clone();
    this.fromFov = this.camera.fov;
    this.fromName = this.view; // drawPlate()'s cross-fade needs the FROM view's own name too (its cover-crop/zoom can differ from the TO view's), not just its texture
    this.toName = view;
    this.switchStart = performance.now();
    this.switching = true;
    this.applyViewSideEffects(view); // the camera is already moving toward the new view for the whole 300ms, so the new view's cut-over state is correct for most of that time
  }

  stepSwitch() {
    const k = Math.min(1, (performance.now() - this.switchStart) / EASE_MS);
    const e = easeOutCubic(k);
    const toCam = this.effectiveCamera(this.toName);
    this.camera.position.lerpVectors(this.fromPos, toCam.position, e);
    const target = new THREE.Vector3().lerpVectors(this.fromTarget, toCam.target, e);
    this.camera.fov = this.fromFov + (toCam.fov - this.fromFov) * e;
    this.camera.lookAt(target);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
    this.lastTarget = target;
    this.plateFade = e;
    if (k >= 1) {
      this.switching = false;
      this.view = this.toName;
      this.setLookTargets(projectLookTargets(this.camera, { children: this.room.views[this.toName].lookTargets }));
    }
  }

  /** Instant cut to `view` -- no ease, no cross-fade (room load, or the registration tool jumping views). */
  jumpToView(view) {
    if (!this.room || !VIEWS.includes(view)) return;
    const v = this.room.views[view];
    this.applyViewSideEffects(view);
    const cam = this.effectiveCamera(view);
    this.camera.position.copy(cam.position);
    this.camera.fov = cam.fov;
    this.camera.lookAt(cam.target);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
    this.lastTarget = cam.target.clone();
    this.switching = false;
    this.view = view;
    this.plateFade = 1;
    this.setLookTargets(projectLookTargets(this.camera, { children: v.lookTargets }));
  }

  // ---------- per-frame: plate draw + the matching 3D-camera crop (PLAN-room-look-fix.md QC: the plate must
  // COVER the window at any aspect -- crop, never pad -- and the 3D camera's own crop must register with it
  // pixel-for-pixel). Both depend on the LIVE canvas size, which can change independently of a view switch
  // (window resize), so -- unlike camera.aspect/occluders/seat/lights above -- this runs every frame, not just
  // on a cut. `name`'s own room.json viewOffset describes a fixed rectangle of a shared virtual sensor
  // (fullWidth x fullHeight) that corresponds 1:1 (modulo the plate image's own pixel scale) to that view's
  // plate image; cropping BOTH the plate draw and that sensor rectangle by the SAME cover-fit window keeps
  // them in lockstep at any window size. ----------

  /** The cover-crop window (in the PLATE's own native pixel space) for `name` at `canvasW` x `canvasH`, plus
   *  the matching sensor-space rectangle for camera.setViewOffset -- or null when this view has no viewOffset
   *  (nothing to crop against) or its plate texture has not finished loading yet. */
  cropFor(name, canvasW, canvasH) {
    const v = this.room.views[name];
    const vo = v.camera.viewOffset;
    const img = v.plateTexture && v.plateTexture.image;
    if (!vo || !img || !img.width || !img.height) return null;
    const o = this.getFramingOverride(name);
    // round 7: a view's own crop preset (zoom/biasUp|anchor/biasRight) -- `chestUp` is talk's existing named
    // preset, kept as a boolean for backward compat; `overShoulder` is work's new one. Neither touches the
    // other view. CHEST_UP uses `anchor` (plate-space target), WORK_OVER_SHOULDER still uses `biasUp` (legacy,
    // window-relative) -- coverCropRect picks whichever the preset provides (see its own comment).
    const preset = o && o.chestUp ? CHEST_UP : o && o.overShoulder ? WORK_OVER_SHOULDER : o && o.floatClose ? FLOAT_CLOSE : o && o.float ? FLOAT_WIDE : null;
    const zoom = preset ? preset.zoom : 1;
    const biasUp = preset ? (preset.biasUp || 0) : 0;
    const biasRight = preset ? preset.biasRight : 0;
    const anchor = preset ? (preset.anchor || null) : null;
    const plate = coverCropRect(img.width, img.height, canvasW, canvasH, zoom, biasUp, biasRight, anchor);
    const s = vo.width / img.width; // sensor units per plate pixel -- 1 when the authored viewOffset's own width/height already equal the plate's native size (the normal case)
    return { plate, sensor: { fullWidth: vo.fullWidth, fullHeight: vo.fullHeight, x: vo.x + plate.x * s, y: vo.y + plate.y * s, width: plate.w * s, height: plate.h * s } };
  }

  /** Sets camera.viewOffset to the ACTIVE view's cover-crop (see cropFor) -- the counterpart of applyViewSideEffects
   *  (camera.aspect) that has to be re-applied every frame instead of once per cut. A no-op (clears any stale
   *  viewOffset) when the active view has no crop to apply yet. */
  applyFrameCrop(canvasW, canvasH) {
    const name = this.switching ? this.toName : this.view;
    const crop = this.cropFor(name, canvasW, canvasH);
    if (!crop) { this.camera.clearViewOffset(); return; }
    const s = crop.sensor;
    this.camera.setViewOffset(s.fullWidth, s.fullHeight, s.x, s.y, s.width, s.height);
    this.camera.updateProjectionMatrix();
  }

  drawPlate() {
    if (!this.plateCtx || !this.room) return;
    const canvas = this.plateCtx.canvas;
    const w = canvas.width, h = canvas.height;
    if (!w || !h) return;
    this.applyFrameCrop(w, h); // keep the 3D camera's crop registered with what gets drawn below, every frame
    // Video room with no current frame for a moment (loop restart seek): keep the canvas as it is -- the last video frame
    // (+ chair) stays up. Falling through would clear it and paint the painted B plate for those 1-3 frames.
    if (!this.switching && this.view === 'talk' && this.scene && this.scene.holding) { if (this.plateProbe) this.plateProbe({ kind: 'hold', reason: 'seek-gap', view: 'talk', switching: false, t: performance.now() }); return; }
    this.plateCtx.clearRect(0, 0, w, h);
    const draw = (name, alpha) => {
      if (alpha <= 0) return;
      const tex = this.room.views[name] && this.room.views[name].plateTexture;
      const crop = this.cropFor(name, w, h);
      if (!tex || !tex.image || !crop) return;
      this.plateCtx.globalAlpha = alpha;
      // video room: same crop window as the plate, so the camera/seat/occluders registration is untouched
      if (name === 'talk' && this.scene && this.scene.ready) { if (this.plateProbe) this.plateProbe({ kind: 'video', view: name, switching: this.switching, t: performance.now() }); this.scene.draw(this.plateCtx, crop.plate, w, h); return; }
      if (this.plateProbe) this.plateProbe({ kind: 'plate', reason: !this.scene ? 'no-scene' : name !== 'talk' ? 'other-view' : 'not-ready', view: name, switching: this.switching, t: performance.now() });
      const p = crop.plate;
      this.plateCtx.drawImage(tex.image, p.x, p.y, p.w, p.h, 0, 0, w, h); // 9-arg form: source crop -> full destination (cover, never letterboxed)
    };
    if (this.switching) {
      draw(this.fromName, 1 - this.plateFade);
      draw(this.toName, this.plateFade);
    } else {
      draw(this.view, 1);
    }
    this.plateCtx.globalAlpha = 1;
  }
}

/** r6 box sweep: re-derive the close crop's frameYFrac for a RUNTIME soleY override (the derivation above is the
 *  same one used at module load, so the crop keeps following her rest height). Never called on the shipped path --
 *  the default FLOAT.soleY already produced FLOAT_CLOSE's constant. */
export function setFloatCloseSoleY(soleY) {
  if (!Number.isFinite(soleY)) return;
  FLOAT_CLOSE.anchor.frameYFrac = FLOAT_CLOSE_REF.frameYFrac - (FLOAT_CLOSE_REF.soleY - soleY) * CLOSE_FRAME_FRAC_PER_M;
}

export { ROOM_IDLE_MS, EASE_MS, CHEST_UP, FLOAT_WIDE, FLOAT_CLOSE, coverCropRect };
