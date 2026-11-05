// Model-facing rules shared by every VRM load path. VRM 1.0 avatars face +Z by spec; VRM 0.x avatars face -Z and
// VRMUtils.rotateVRM0() (called from prepareVrm below) corrects that with a 180-degree Y turn on the scene root.
// That base orientation belongs to the MODEL. Stage placement (room stand anchor, per-view seat) is a separate,
// additional rotation on top of it -- it must COMPOSE with the base, never overwrite it, or a VRM 0.x avatar
// silently turns back around the moment any stage/seat transform lands (owner bug T-31: an imported VRM 0.x model
// showed its back while the VRM 1.0 default model was fine). One helper pair, used by room-stage.js and seat.js,
// keeps that rule in a single place.
import * as THREE from 'three';
import { VRMUtils } from '@pixiv/three-vrm';

const baseOrientation = new WeakMap(); // vrm.scene -> the model's own base quaternion (VRM 0.x flip or identity)

// Same clean-up for every VRM instance (the stage model and the talk path's hidden rig probe).
export function prepareVrm(gltf, vrm) {
  VRMUtils.removeUnnecessaryVertices(gltf.scene);
  VRMUtils.combineSkeletons(gltf.scene);
  if (vrm.meta && vrm.meta.metaVersion === '0') VRMUtils.rotateVRM0(vrm);
  // Capture the model's own base orientation AFTER the VRM 0.x flip, while the scene is still untouched by any
  // room/seat placement. Idempotent: a scene is captured once, so re-loads and re-placements cannot compound it.
  captureBaseOrientation(vrm.scene);
  vrm.scene.traverse((o) => { o.frustumCulled = false; });
}

/** Records `scene`'s current orientation as its own base orientation (first call wins). Returns it. */
export function captureBaseOrientation(scene) {
  const known = baseOrientation.get(scene);
  if (known) return known;
  const base = scene.quaternion.clone();
  baseOrientation.set(scene, base);
  return base;
}

/**
 * The final scene quaternion for a stage placement: the stage/seat rotation applied ON TOP of the model's own base
 * orientation (q_stage * q_base, so the base rotation happens first in the model's local frame). Captures the base
 * lazily when prepareVrm() was not the one that loaded this scene, so the invariant still holds for the QC render
 * scripts, which prepare VRMs with their own inline copy of prepareVrm().
 */
export function stageQuaternion(scene, stageQ) {
  return stageQ.clone().multiply(captureBaseOrientation(scene));
}

/**
 * The scene's WORLD orientation with the model's own base flip removed -- i.e. the stage/seat rotation the room
 * applied. Code that reasons in "body frame" (+Z forward, +X the avatar's left) must use this instead of the raw
 * world quaternion: after the VRM 0.x flip the raw one maps +Z to the avatar's BACK, which would mirror every
 * seated leg/lean/hand direction in seat-fit.js. Identity for a VRM 1.0 model (base = identity).
 *
 * Ordering: the base must already be captured (prepareVrm, or any earlier stage placement, which captures
 * lazily). Before that this is just the raw world orientation -- only reachable if a caller skips both.
 */
export function bodyOrientation(scene) {
  const base = baseOrientation.get(scene);
  const world = scene.getWorldQuaternion(new THREE.Quaternion());
  return base ? world.multiply(base.clone().invert()) : world;
}
