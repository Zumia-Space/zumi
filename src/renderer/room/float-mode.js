// Floating mode (T-31 float-holo pilot): in the talk view Zumi hangs in mid-air with no chair, mid-frame in
// front of the room, with a slow hover. Renderer-only PILOT: the mode is OFF unless app.js reads
// localStorage['zumi.pilot.stageMode'] === 'float' (default 'seated'), so the shipped 0.2.3 seated path is
// untouched byte-for-byte. It adds no IPC and no settings.json key (precedent: settings-tabs.js's own UI
// preference).
//
// Two things make her actually float rather than stand on air:
//   - the legs play the sustained `float-idle` clip (a zero-g relaxed hang, see make-float-pose.mjs) instead of
//     the seated pose, and rig.seated=false so the seated-base arm pose / leg IK are off (seat-fit.js:250
//     returns early when !rig.seated);
//   - the 3D chair group and the talk occluders are hidden, so she reads clear in front of the room.
//
// Rig.setRoot (called every frame by engine.update) PINS the hips bone to the world point rig.hipsPos, so
// moving vrm.scene alone does NOT move her -- placeFloat refreshes rig.hipsPos after placing, exactly like
// placeSeated's tail, and update() rewrites it every frame after the hover moves the root.
import * as THREE from 'three';
import { createVRMAnimationClip } from '@pixiv/three-vrm-animation';
import { clearSeatedPose } from './seat.js';
import { stageQuaternion } from '../model-facing.js';

const DEG = Math.PI / 180;
// The float clip's own leg bones (make-float-pose.mjs). Same list seat.js uses for its probe.
const LEG_BONES = ['leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot'];

// Final placement (solved by scripts/check-float-holo.mjs against the talk camera + the 7 video rooms). z: back
// from the seat's own z so she clears the desk she now floats in front of; soleY: the world Y her ANKLE (foot bone)
// hangs at -- the harness foot gate reads that same bone; scale: uniform, kept >= 0.85 so the arm IK skew stays
// small. She reads full-body (head top and feet) inside the video-room crop at 16:10, 16:9 and the harness's own
// 1204x689 stage -- see the check.
//
// r5: r4 measured the 8-12 cm band at the ANKLE and set soleY = 0.115, which put the visible toe tip only ~2 cm off
// the floor (the float-idle foot hangs TOE_BELOW_ANKLE below the ankle bone, see FLOAT_TOE_BELOW_ANKLE_M). The toe
// tips then sat in the contact shadow and no floor gap read. The band is the VISIBLE (toe-tip) gap, so the ankle now
// sits at 0.210 m and the toe tip reads at the top of the band (0.12 m); the bob is unchanged (2.5 cm / 3.6 s), so
// the LOWEST bob toe tip is 0.12 - (HOVER_AMPLITUDE_M + HOVER_SWAY_M) = 0.09 m -- clearly clear of the floor
// (scripts/check-float-holo.mjs asserts the TOE-TIP clearance at the lowest bob, not the ankle).
export const FLOAT = { z: -1.0, soleY: 0.210, scale: 0.85 };

// The float-idle pose plantar-flexes the foot, so the toe tip hangs below the ankle bone: measured off the shipped
// clip (scripts/_probe reads assets/clips/float-idle.vrma) the LEFT toe sits 0.1059 m / the RIGHT 0.1127 m below its
// ankle at scale 1 -- the left is the lowest, so it is the one the placement + the harness gate track. The visible
// rest gap = FLOAT.soleY - FLOAT_TOE_BELOW_ANKLE_M * FLOAT.scale. Exported so scripts/check-float-holo.mjs can
// assert the toe-tip clearance without a render.
export const FLOAT_TOE_BELOW_ANKLE_M = 0.1059;

// Hover (float cheap-win): a slow vertical bob. The PRIMARY component is the bob the pilot brief asks for
// (+-2-3 cm, period 3-4 s); the small secondary ripple only keeps it from reading as a pure sine, and is sized so
// the summed peak stays within 3 cm. Exported so scripts/check-float-holo.mjs can assert the amplitude + period
// without a browser.
export const HOVER_AMPLITUDE_M = 0.025; // primary bob, +-2.5 cm
export const HOVER_PERIOD_S = 3.6; // primary bob period
export const HOVER_SWAY_M = 0.005; // secondary ripple amplitude (summed peak = 0.030 m = 3 cm)
export const HOVER_SWAY_PERIOD_S = 1.7;

// Renderer-only UI preference (no IPC, no settings.json key -- precedent: settings-tabs.js). Kept here so
// scripts/check-float-holo.mjs can test the default without a DOM.
export const STAGE_MODE_KEY = 'zumi.pilot.stageMode';

/** Reads the pilot's stage mode from `storage` (defaults to localStorage). 'seated' on empty OR on any throw
 *  (storage disabled), so 0.2.3 behaviour is the default. */
export function readStageMode(storage = (typeof localStorage !== 'undefined' ? localStorage : null)) {
  try { return storage && storage.getItem(STAGE_MODE_KEY) === 'float' ? 'float' : 'seated'; } catch { return 'seated'; }
}

/** Persists the mode; a disabled storage just does not remember (same posture as settings-tabs.js). */
export function saveStageMode(mode, storage = (typeof localStorage !== 'undefined' ? localStorage : null)) {
  try { storage && storage.setItem(STAGE_MODE_KEY, mode === 'float' ? 'float' : 'seated'); } catch { /* storage disabled: just do not remember */ }
}

// r6 parameter sweep: the box tunes four values by measurement instead of by eye. They are RUNTIME OVERRIDES
// (URL query `?fhSoleY=0.24&fhCenterBackM=0.16&fhRimMul=3&fhFresnelPower=2`, or the harness's dev hook) and NEVER
// change the shipped defaults above. Out-of-range/NaN values are dropped, so a typo leaves the shipped value.
const OVERRIDE_RANGES = { soleY: [0.05, 0.6], centerBackM: [0, 0.6], rimMul: [0, 10], fresnelPower: [0.5, 10] };
const OVERRIDE_KEYS = { fhSoleY: 'soleY', fhCenterBackM: 'centerBackM', fhRimMul: 'rimMul', fhFresnelPower: 'fresnelPower' };

/** Parses the runtime overrides out of a URL query string (`?fhSoleY=0.24`). Pure (unit-tested). Returns only the
 *  keys actually provided and in range -- an empty object means "use the shipped defaults". */
export function parseFloatOverrides(search) {
  const out = {};
  let q;
  try { q = new URLSearchParams(String(search || '')); } catch { return out; }
  for (const [param, key] of Object.entries(OVERRIDE_KEYS)) {
    const raw = q.get(param);
    if (raw == null || raw === '') continue;
    const v = Number(raw);
    const [lo, hi] = OVERRIDE_RANGES[key];
    if (Number.isFinite(v) && v >= lo && v <= hi) out[key] = v;
  }
  return out;
}

const floatInstanceId = new WeakMap(); // engine -> the sustained float clip's player instance id
const floatBaseY = new WeakMap(); // engine -> the root Y the hover oscillates around (set by placeFloat)
const floatBaseQuat = new WeakMap(); // engine -> the root's placed orientation (yaw/roll are added on top)
const floatToken = new WeakMap(); // engine -> monotonically increasing id of the latest enter()/exit() (last caller wins)
// engine -> { vrm, y }: the ANKLE's world Y under the float pose with the root at Y=0, scale 1 (measureFloatAnkleY).
// Placing against the LIVE ankle instead was wrong: right after enter() starts the clip the leg bones still hold the
// previous (seated) pose for a frame, so the ankle measured ~0.22 m too high and her feet landed below the frame
// once the float pose actually blended in (measured on the spare PC: foot bone NDC -1.01). This is the SAME
// deterministic keyframe probe seat.js's measureSeatDropM uses, so the placement no longer depends on timing. The
// `vrm` stamp makes a value measured for a PREVIOUS model (engine is reused across model binds) unusable for the new
// one -- placeFloat then falls back instead of anchoring on a stranger's legs.
const floatAnkleY = new WeakMap();

/** Refreshes rig.hipsPos from the CURRENT root placement -- the same one-liner placeSeated ends with (see its
 *  long comment for why setRoot needs it). Shared by placeFloat and update. */
function refreshHipsPos(engine) {
  const rig = engine.rig;
  if (rig && rig.hipsNode && rig.hipsRestLocal) rig.hipsPos = rig.hipsNode.parent.localToWorld(rig.hipsRestLocal.clone());
}

/** Measures the ankle's world Y under the float-idle pose, deterministically: for each leg bone it applies the
 *  clip's own keyframe (the same way seat.js's measureSeatDropM poses LEG_BONES), pins the root to identity and
 *  the hips to their rest local, reads the left ankle, then restores everything it touched. The keyframe is a
 *  static 1-key clip, so this equals the ankle height the live clip produces. Async only for clips.load (cached
 *  after warm); the pose/measure/restore block is synchronous, so no render frame can interleave it.
 *  @returns the ankle world Y (root at Y=0, scale 1), or null when the clip could not be loaded. */
async function measureFloatAnkleY(engine) {
  const vrm = engine.vrm, rig = engine.rig;
  if (!vrm || !rig || !rig.hipsNode || !rig.hipsRestLocal) return null;
  const res = await engine.clips.load('float-idle');
  if (!res || !res.data) return null;
  const clip = createVRMAnimationClip(res.data, vrm);
  const nb = (name) => vrm.humanoid.getNormalizedBoneNode(name);
  const scene = vrm.scene;
  const savedPos = scene.position.clone(), savedQuat = scene.quaternion.clone(), savedScale = scene.scale.clone();
  const savedHips = rig.hipsNode.position.clone();
  const touched = new Map();
  try {
    for (const name of LEG_BONES) {
      const node = nb(name);
      const track = node && clip.tracks.find((tr) => tr.name === node.name + '.quaternion');
      if (!track) continue;
      touched.set(node, node.quaternion.clone());
      node.quaternion.fromArray(track.values, 0);
    }
    scene.position.set(0, 0, 0); scene.quaternion.identity(); scene.scale.setScalar(1);
    rig.hipsNode.position.copy(rig.hipsRestLocal);
    scene.updateMatrixWorld(true);
    const foot = nb('leftFoot');
    return foot ? foot.getWorldPosition(new THREE.Vector3()).y : null;
  } finally {
    for (const [node, q] of touched) node.quaternion.copy(q); // restore: this was a probe, not the live pose
    rig.hipsNode.position.copy(savedHips);
    scene.position.copy(savedPos); scene.quaternion.copy(savedQuat); scene.scale.copy(savedScale);
    scene.updateMatrixWorld(true);
  }
}

/**
 * Positions engine.vrm.scene for the float pose: root at the seat's own x/z plus `P.z`, uniform `P.scale`,
 * `seat.rotYDeg`. The root Y is solved so the soles land at `P.soleY`: it anchors on the ankle offset measured
 * under the FLOAT pose (floatAnkleY, from measureFloatAnkleY), scaled by P.scale -- so the feet land where the
 * check predicts, instead of the ~0.22 m low the live-pose read produced. Falls back to the live read only if
 * the measurement has not run yet. Synchronous, no I/O (safe from CameraDirector's placeSeat callback).
 * @param seat { pos:[x,y,z], rotYDeg } -- the active talk view's own zumi_seat (seat.pos[1] unused, as in placeSeated)
 * @param P the FLOAT placement constants
 */
export function placeFloat(engine, seat, P) {
  const vrmScene = engine.vrm.scene;
  // Compose the float placement WITH the model's own base orientation, exactly like placeZumi/placeSeated: copying
  // the seat yaw alone turned a VRM 0.x model back around in float mode (T-31 review round 2, float-mode.js:162).
  const q = stageQuaternion(vrmScene, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (seat.rotYDeg || 0) * DEG));
  vrmScene.position.set(seat.pos[0], 0, seat.pos[2] + P.z);
  vrmScene.quaternion.copy(q);
  vrmScene.scale.setScalar(P.scale);
  vrmScene.updateMatrixWorld(true);
  const measured = floatAnkleY.get(engine);
  // measured is the float-pose ankle Y at ROOT Y=0, SCALE 1: at P.scale the whole scene scales, so the ankle
  // offset from the root grows by P.scale too (uniform scale). Only trust a value measured for THIS model; the
  // fallback reads the live bone at this scale (and is only reached before enter() has measured, e.g. a stray
  // placeSeat on the very first bind -- the caller re-places right after enter()).
  const fresh = measured && measured.vrm === engine.vrm ? measured.y : null;
  const ankleY = fresh != null ? fresh * P.scale : engine.vrm.humanoid.getNormalizedBoneNode('leftFoot').getWorldPosition(new THREE.Vector3()).y;
  vrmScene.position.y = P.soleY - ankleY;
  vrmScene.updateMatrixWorld(true);
  floatBaseY.set(engine, vrmScene.position.y);
  floatBaseQuat.set(engine, q.clone());
  refreshHipsPos(engine);
}

/** Turns float on for this engine: drop any seated pose, switch to the hanging `float-idle` legs clip (sustained,
 *  at weight 1 -- legs are never touched by a reflex, so this is safe, see make-float-pose.mjs). Async: awaits
 *  clips.warm so the action is built before the caller's frame loop needs it (same reasoning as enterSeated). */
export async function enter(engine) {
  if (!engine.rig) return false;
  clearSeatedPose(engine); // also sets rig.seated=false and releases any seated base
  // A newer enter()/exit() (e.g. the mode toggled off while this one warms its clip) must win -- otherwise the
  // resumed call would play the weight-1 float legs clip into seated mode, where nothing releases it.
  const token = (floatToken.get(engine) || 0) + 1;
  floatToken.set(engine, token);
  await engine.clips.warm('float-idle');
  if (floatToken.get(engine) !== token || !engine.rig) return false; // superseded, or unbound while warming
  // Measure the float pose's own ankle offset BEFORE the clip is live, so placeFloat (which the caller runs
  // right after this resolves, synchronously in the same microtask) anchors on the FLOAT pose, not the seated
  // one the legs still hold. See floatAnkleY.
  const ankleY = await measureFloatAnkleY(engine);
  if (floatToken.get(engine) !== token || !engine.rig) return false;
  if (ankleY != null) floatAnkleY.set(engine, { vrm: engine.vrm, y: ankleY }); else floatAnkleY.delete(engine);
  const res = engine.player.play({ id: 'float-base', sustain: true, clip: { name: 'float-idle', weight: 1 } }, { side: 1 });
  if (!res.ok) { console.error('float-mode.js: float-idle clip rejected', res.errors); return false; }
  const previous = floatInstanceId.get(engine);
  if (previous != null) engine.player.release(previous);
  floatInstanceId.set(engine, res.id);
  return true;
}

/** Turns float off: cancel any enter() still warming, and release the sustained clip. The caller restores the
 *  chair/occluders and re-seats her. */
export function exit(engine) {
  if (!engine) return;
  floatToken.set(engine, (floatToken.get(engine) || 0) + 1); // a newer call wins
  const id = floatInstanceId.get(engine);
  if (id != null) { engine.player.release(id); floatInstanceId.delete(engine); }
  floatBaseY.delete(engine);
  floatBaseQuat.delete(engine);
  floatAnkleY.delete(engine);
}

/** Per-frame hover (call BEFORE engine.update(dt), so the refreshed hipsPos is what Rig.setRoot pins this frame):
 *  a slow vertical drift plus a small yaw/roll sway, then a hipsPos refresh. The spring-bone hair follows the
 *  root motion for free. `t` is seconds. */
export function update(engine, t) {
  const vrmScene = engine.vrm && engine.vrm.scene;
  const baseY = floatBaseY.get(engine);
  const baseQuat = floatBaseQuat.get(engine);
  if (!vrmScene || baseY == null || !baseQuat) return;
  vrmScene.position.y = baseY + HOVER_AMPLITUDE_M * Math.sin(2 * Math.PI * t / HOVER_PERIOD_S) + HOVER_SWAY_M * Math.sin(2 * Math.PI * t / HOVER_SWAY_PERIOD_S);
  vrmScene.quaternion.copy(baseQuat);
  vrmScene.rotateY(2.5 * DEG * Math.sin(2 * Math.PI * t / 7));
  vrmScene.rotateZ(1 * DEG * Math.sin(2 * Math.PI * t / 5.3));
  vrmScene.updateMatrixWorld(true);
  refreshHipsPos(engine);
}
