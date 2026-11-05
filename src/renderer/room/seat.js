// Seated wiring (T-31 camera modes + coordinator round 2): room.json v2's zumi_seat is now PER VIEW (views are
// not geometrically consistent -- separate paintings, separate local origins), so Zumi is re-placed at the
// active view's own seat on every view switch (CameraDirector calls placeSeated below, synchronously, no I/O).
// The VERTICAL drop, though, is the same number regardless of which view is active (it only depends on this
// model's own standing-vs-seated leg geometry) -- measured ONCE per model/room bind (measureSeatDropM, async:
// it needs the sit-idle clip's own data) and cached by the caller, then applied synchronously on every switch.
//
// The drop is ANKLE-anchored, not hip-anchored (coordinator QC, 2026-10-03, scripts/check-seat-offset.mjs's own
// header, confirmed again in Vesta's own v2-B room.json seatedPose.rootDrop note): anchoring on (standing hip
// height, a nominal seat height) leaves the ankle/toe through the floor, because a pose's own hip-to-ankle
// offset does not exactly match any nominal seat height. Anchoring on (this pose's OWN seated ankle height,
// this model's OWN standing ankle-to-floor clearance) instead reproduces the standing foot/floor relationship
// exactly, because the pose's own foot keeps its standing world orientation by construction -- the SAME method
// scripts/check-seat-offset.mjs and scripts/check-motion-seated.mjs already test/use. room.json's zumi_seat.pos.y
// (the pelvis/hips height) is informational only here (what the plate's chair was painted against, per Vesta's
// own note) -- never fed into the drop math.
import * as THREE from 'three';
import { createVRMAnimationClip } from '@pixiv/three-vrm-animation';
import { computeRootDrop } from '../../../scripts/seat-offset.mjs';
import { stageQuaternion } from '../model-facing.js';

const DEG = Math.PI / 180;
const DEFAULT_SIT_CLIP_NAME = 'sit-idle'; // the default/fallback seated clip (talk/room; legs only, arms free for REACH.seatedRest's live IK) -- round 6: zumi_seat.pose now actually selects the clip (previously a documented-but-unused field; the work view uses 'sit-work' instead, see make-sit-work-pose.mjs)
const sitCommand = (clipName) => ({ id: `sit-base-${clipName}`, sustain: true, clip: { name: clipName, weight: 1 } });
const LEG_BONES = ['leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot'];

const seatedInstanceId = new WeakMap(); // engine -> the sustained clip's PLAYER instance id (GesturePlayer's own auto-incrementing seq, not sitCommand.id -- see player.js:120/142)
const seatSwitchToken = new WeakMap(); // engine -> monotonically increasing id of the latest enterSeated() call (last caller wins)
const seatedPoseName = new WeakMap(); // engine -> the clip name CURRENTLY sustained -- lets enterSeated() tell "already seated in this pose" (no-op) apart from "seated in a DIFFERENT pose" (switch)

/**
 * Measures the ankle-anchored root drop for the CURRENTLY bound model (engine.vrm), once. Poses LEG_BONES to the
 * sit-idle clip's own settled frame (its first keyframe -- the clip's one authored key, same frame
 * scripts/check-seat-offset.mjs's integration section reads), measures the left ankle's world Y, then restores
 * the bones it touched (a measurement probe, not the real applied pose -- ClipLayer renders the real, live,
 * ramped-in pose once the sustained command actually starts playing).
 * @returns the drop in metres, or null when the clip could not be loaded (missing file / fetch failed) -- the
 *   caller then skips seating rather than guess (PLAN §3 "never a crash, degrade visibly instead").
 */
export async function measureSeatDropM(engine, poseName = DEFAULT_SIT_CLIP_NAME) {
  const vrm = engine.vrm;
  if (!vrm) return null;
  const nb = (name) => vrm.humanoid.getNormalizedBoneNode(name);
  const restAnkleY = nb('leftFoot').getWorldPosition(new THREE.Vector3()).y; // standing rest pose, before any clip touches the legs
  const res = await engine.clips.load(poseName); // ClipLayer's own cache -- a real fetch only the first time per app run
  if (!res || !res.data) return null;
  const clip = createVRMAnimationClip(res.data, vrm);
  const touched = new Map();
  for (const name of LEG_BONES) {
    const node = nb(name);
    const track = node && clip.tracks.find((tr) => tr.name === node.name + '.quaternion');
    if (!track) continue;
    touched.set(node, node.quaternion.clone());
    node.quaternion.fromArray(track.values, 0);
  }
  vrm.scene.updateMatrixWorld(true);
  const seatedAnkleY = nb('leftFoot').getWorldPosition(new THREE.Vector3()).y;
  for (const [node, q] of touched) node.quaternion.copy(q); // restore: this was a probe, not the live pose
  vrm.scene.updateMatrixWorld(true);
  return computeRootDrop(seatedAnkleY, restAnkleY);
}

/**
 * Measures the hip-joint midpoint's LOCAL (x,z) offset from the vrmScene root, for the CURRENTLY bound model,
 * once -- the horizontal counterpart of measureSeatDropM's vertical drop. Reference implementation: Vesta's own
 * v2-B/tools/render/app.js poseSeated() step 5 ("put the hip joint midpoint over the seat axis (x/z)").
 *
 * room.json's zumi_seat.pos x/z is documented as "the hip-joint midpoint" (over/behind the chair column), NOT
 * the scene root -- a humanoid rig's root bone is not generally directly below its hip joints (most rigs have
 * some small built-in forward/back lean or offset), so placing the ROOT at seat.pos x/z (what placeSeated did
 * before this existed) leaves the hip joints -- and everything above them, the whole seated silhouette -- off
 * by that same built-in offset. Invisible at rotYDeg=0 when the offset happens to be small along the camera's
 * sightline (talk), glaring once the body is rotated ~90-120 degrees (work/room QC, 2026-10-05: she read as
 * perched above/in front of the chair instead of settled into it) -- the SAME fixed local offset, just rotated
 * into a direction the camera sees edge-on instead of head-on.
 *
 * The hip-joint (upper-leg) bones' OWN origin is unaffected by the sit-idle clip (the clip only sets their
 * ROTATION; a bone's origin is fixed by its parent chain, i.e. by the model's bind pose) -- so this can be
 * measured at any time after bind(), independent of the clip's load state (unlike measureSeatDropM, this does
 * not need to be async). Temporarily resets vrmScene to the origin/identity to measure in a clean local frame
 * (Vesta's own reset at the start of poseSeated()), then RESTORES the scene's previous placement: the caller's
 * next step (seatFit.measureModel, also in the model's own local frame) and any frame rendered between the two
 * must still see the model facing forward, including the VRM 0.x base flip this reset would otherwise drop.
 * @returns {x,z} in metres, or null when no humanoid is bound.
 */
export function measureHipOffsetXZ(engine) {
  const vrm = engine.vrm;
  if (!vrm) return null;
  const savedPos = vrm.scene.position.clone();
  const savedQuat = vrm.scene.quaternion.clone();
  try {
    vrm.scene.position.set(0, 0, 0);
    vrm.scene.quaternion.identity();
    vrm.scene.updateMatrixWorld(true);
    const nb = (name) => vrm.humanoid.getNormalizedBoneNode(name);
    const l = nb('leftUpperLeg'), r = nb('rightUpperLeg');
    if (!l || !r) return null;
    const lp = l.getWorldPosition(new THREE.Vector3()), rp = r.getWorldPosition(new THREE.Vector3());
    return { x: (lp.x + rp.x) / 2, z: (lp.z + rp.z) / 2 };
  } finally {
    vrm.scene.position.copy(savedPos);
    vrm.scene.quaternion.copy(savedQuat);
    vrm.scene.updateMatrixWorld(true);
  }
}

/**
 * Synchronous, per-view-switch placement: positions/rotates engine.vrm.scene so `seat`'s own hip-joint-midpoint
 * anchor (room.json's documented meaning of zumi_seat.pos x/z) lands exactly there once rotated, then applies
 * the cached vertical drop on top. No I/O, safe to call from CameraDirector's per-frame switch path.
 * @param seat { pos:[x,y,z], rotYDeg } -- the ACTIVE view's own zumi_seat (round 2: per view, not shared).
 *   pos[1] (the pelvis/hips height) is NOT used here -- see the module header: it is Vesta's own measurement of
 *   WHERE THE PELVIS BONE ENDS UP, a result of correct placement, not an input to it. Using it as the scene
 *   root's starting Y would double-count the seat height (root Y already measured relative to the FLOOR, which
 *   room.json's own coordinateSystem fixes at y=0 for every view).
 * @param dropM the cached result of measureSeatDropM() for this model -- 0 is a legitimate value (no drop needed).
 * @param hipOffset the cached result of measureHipOffsetXZ() for this model -- {x:0,z:0} (root == hip joint) is
 *   a legitimate value and reduces this to the old root-only placement.
 */
export function placeSeated(engine, seat, dropM, hipOffset) {
  const vrmScene = engine.vrm.scene;
  // Per-view fit tuning (work-view fit task, 2026-10-06 -- room-check.mjs's checkSeat has the full reasoning):
  // `scale` is uniform, applied around vrmScene's OWN local origin. Object3D.position is unaffected by its own
  // .scale, but dropM/hipOffset are NOT positions -- they are LOCAL offsets (ankle-to-origin, hip-to-origin)
  // measured once at the model's NATIVE size (measureSeatDropM/measureHipOffsetXZ both run before any seat is
  // ever applied, i.e. at the model's default scale=1). Under vrmScene.scale = S, every local offset from that
  // origin grows/shrinks by S too, so applying the UNSCALED dropM/hipOffset at a non-1 scale puts the ankle and
  // hip joint off by (S-1)*that offset -- measured here first as a dramatic "floating above the chair, legs
  // dangling" render at scale 1.2 before this line existed. Scaling both by `scale` keeps the exact same
  // ankle-on-floor / hip-on-seat anchoring this function already guaranteed at scale=1.
  const scale = seat.scale || 1;
  // Seat rotation COMPOSED with the model's own base orientation (VRM 0.x's 180-degree flip from prepareVrm):
  // copying the seat quaternion alone turned a VRM 0.x avatar back around in every seated view (T-31 owner bug).
  const q = stageQuaternion(vrmScene, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), seat.rotYDeg * DEG));
  const o = hipOffset || { x: 0, z: 0 };
  // The hip joint sits at vrmScene.position + q*(o.x,0,o.z)*scale once rotated (q includes the base flip, and
  // measureHipOffsetXZ measured o at identity, i.e. in the model's own local frame); solve for the root position
  // that puts the hip joint at (seat.pos[0], seat.pos[2]) instead of the root itself.
  const rotatedOffset = new THREE.Vector3(o.x * scale, 0, o.z * scale).applyQuaternion(q);
  vrmScene.position.set(seat.pos[0] - rotatedOffset.x, 0, seat.pos[2] - rotatedOffset.z); // Y starts at the view's own floor (0), per room.json's coordinateSystem -- NOT seat.pos[1]
  vrmScene.quaternion.copy(q);
  vrmScene.position.y -= (dropM || 0) * scale;
  vrmScene.scale.setScalar(scale);
  // `offset` is a plain post-placement nudge in this view's own world axes (not rotated by rotYDeg -- the same
  // frame seat.pos/camera.pos are authored in, and NOT scaled -- it is an explicit world-metre correction, not
  // a model-local measurement), for any residual position fit a scale change leaves behind (e.g. re-tucking the
  // hips into the cushion depth). Both scale and offset default to identity, so a room authored before this
  // existed places exactly as it did before.
  if (seat.offset) { vrmScene.position.x += seat.offset[0]; vrmScene.position.y += seat.offset[1]; vrmScene.position.z += seat.offset[2]; }
  // Known residual limitation, documented rather than solved here (out of this task's scope): Rig's own
  // shoulderWidth/armLength/hipHeight (rig.js constructor) are measured ONCE at engine.bind() time, before any
  // seat placement ever runs -- a non-1 scale here is invisible to them. Harmless for THIS app's one seated
  // pose (sit-idle is a baked clip of bone ROTATIONS only, scale-invariant in shape), but a live gesture that
  // reaches for a world point in shoulder-width units while seated+scaled would target slightly off.
  vrmScene.updateMatrixWorld(true);
  // rig.js's Rig.setRoot() (called every frame, engine.js:405, for the idle "lean toward camera" root channel)
  // pins the hips bone to a WORLD point, rig.hipsPos -- captured ONCE in the Rig constructor (engine.bind()
  // time), when vrm.scene was still at its pre-seat placement (origin/identity). Left unrefreshed, that stale
  // world point overrides the seat drop/rotation we just applied EVERY SINGLE FRAME: hips.setRoot([0,0,0])
  // reconstructs the bind-time world position exactly, regardless of where vrmScene now is -- her hips (and
  // everything hanging off them) never actually leaves standing height, so her feet dangle well above the
  // chair/floor instead of resting on it. Invisible head-on (talk, QC 2026-10-05 first pass) because the
  // floating legs read as "close enough" from straight ahead; glaring once the view is rotated ~90-120 degrees
  // (work/room) and the same floating, unweighted legs are seen edge-on. Refreshing rig.hipsPos here -- from
  // the PRESERVED, rotation/placement-invariant rig.hipsRestLocal plus the hips parent's freshly-updated world
  // matrix -- makes setRoot's "no root-channel offset" case reproduce THIS placement instead of the bind-time
  // one, every time she is (re)seated.
  const rig = engine.rig;
  if (rig && rig.hipsNode && rig.hipsRestLocal) rig.hipsPos = rig.hipsNode.parent.localToWorld(rig.hipsRestLocal.clone());
}

/** Turns on the seated state for this engine (arm-rest life-layer base + the sustained seated clip named by
 *  `poseName`) -- call once per model/room bind, and again on every view switch whose seat.pose differs from
 *  what is currently playing (round 6: per-view pose, e.g. talk/room's 'sit-idle' vs work's 'sit-work' --
 *  see make-sit-work-pose.mjs). Idempotent PER POSE NAME: a call with the SAME poseName that is already
 *  playing is a no-op (CameraDirector's per-view-switch placeSeated() never re-triggers the clip's envelope
 *  on a cut between two views that share a pose); a call with a DIFFERENT poseName releases the old sustained
 *  instance and plays the new one.
 *
 *  Async: awaits engine.clips.warm(poseName) so the clip's AnimationAction is actually BUILT and
 *  registered before this resolves, not just requested. Without this, the leg bend never applies in a
 *  headless frame-settle render of the FIRST view shown after a fresh bind: ClipLayer.action() builds its
 *  action lazily off a promise .then(), which cannot run until the caller's current synchronous call stack
 *  unwinds -- fine for the real app's requestAnimationFrame loop (plenty of real event-loop turns between
 *  frames), fatal for a tight `for (i<300) engine.update(dt)` loop with a frozen/manually-advanced clock,
 *  where the .then() never gets a turn until the whole loop (and that view's 300-frame settle) is already
 *  done. Found 2026-10-05 QC: scripts/render-camera-views.mjs's own real-talk.png showed dead-straight,
 *  standing legs (identity leftUpperLeg/leftLowerLeg quaternions) while work/room (rendered in later,
 *  separate Playwright round-trips that gave the microtask a chance to run) came out correctly bent. */
export async function enterSeated(engine, poseName = DEFAULT_SIT_CLIP_NAME) {
  if (!engine.rig) return false;
  engine.rig.seated = true;
  if (seatedInstanceId.has(engine) && seatedPoseName.get(engine) === poseName && engine.player.find(seatedInstanceId.get(engine))) return true; // already playing THIS pose
  // T-31 chair fix: build the new pose's action BEFORE releasing the old one. Releasing first
  // left frames with NO seated clip sampled while the new action was still loading -> engine.applyPose's
  // `!sampled && wasActive` branch reset the legs to the standing rest pose, i.e. straight legs through the
  // seat for ~1.5-2 s on the first switch to a view whose pose was never played (measured, work view).
  const token = (seatSwitchToken.get(engine) || 0) + 1;
  seatSwitchToken.set(engine, token);
  await engine.clips.warm(poseName);
  if (seatSwitchToken.get(engine) !== token || !engine.rig) return false; // a newer switch (or an unbind) took over while this one warmed
  const previous = seatedInstanceId.has(engine) ? seatedInstanceId.get(engine) : null;
  const res = engine.player.play(sitCommand(poseName), { side: 1 });
  if (!res.ok) { console.error(`seat.js: ${poseName} clip rejected`, res.errors); return false; }
  if (previous != null) engine.player.release(previous); // round 6: a per-view pose SWITCH (e.g. talk's sit-idle -> work's sit-work) releases the old sustained clip before playing the new one, instead of only ever playing once per bind
  seatedInstanceId.set(engine, res.id);
  seatedPoseName.set(engine, poseName);
  return true;
}

/** The seated clip currently held for this engine (null when not seated). The self-test uses it to pick a clip that is NOT the base pose. */
export function seatedPoseNameOf(engine) { return seatedPoseName.has(engine) ? seatedPoseName.get(engine) : null; }

/** Undo: call before placing Zumi in a room with no seat (or no room at all) / before re-binding the engine for a
 *  model switch, so a leftover seated base from the PREVIOUS room/model never survives. No-op if nothing is seated. */
export function clearSeatedPose(engine) {
  if (!engine) return;
  seatSwitchToken.set(engine, (seatSwitchToken.get(engine) || 0) + 1); // cancels any enterSeated() still warming its clip
  if (engine.rig) engine.rig.seated = false;
  const id = seatedInstanceId.get(engine);
  if (id != null) { engine.player.release(id); seatedInstanceId.delete(engine); }
  seatedPoseName.delete(engine);
}
