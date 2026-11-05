// Places Zumi + the camera inside a loaded room, from its anchors (T-31 R3, PLAN-room.md §3 anchor table + §4
// camera). Pure three.js math -- no DOM, no IPC -- so it is unit-testable in isolation from the rest of app.js.
import * as THREE from 'three';
import { stageQuaternion } from '../model-facing.js';

const DEG = Math.PI / 180;
const IDENTITY_POS = new THREE.Vector3(0, 0, 0);
const IDENTITY_QUAT = new THREE.Quaternion();

// zumi_stand missing -> "scene origin, facing +Z" (PLAN §3 table). Returns the transform to apply to vrm.scene,
// BEFORE engine.bind() runs (bind() reads world positions off the rig once, at bind time).
export function standTransform(anchor) {
  return anchor ? { position: anchor.position.clone(), quaternion: anchor.quaternion.clone() } : { position: IDENTITY_POS.clone(), quaternion: IDENTITY_QUAT.clone() };
}

export function placeZumi(vrmScene, anchor) {
  const t = standTransform(anchor);
  vrmScene.position.copy(t.position);
  // Compose the stand rotation WITH the model's own base orientation (VRM 0.x's 180-degree flip): assigning t's
  // quaternion outright turned a VRM 0.x avatar back around on every load path (T-31: imported model showed its back).
  vrmScene.quaternion.copy(stageQuaternion(vrmScene, t.quaternion));
}

// Waist-up framing geometry shared by the plain stage and the in-room camera: how far back the camera must sit
// (along whichever direction it is placed) to fit Zumi's measured bounds at this camera's fov, and the vertical
// centre to look at. Same formula app.js's original frameCamera used (big-headed models, headroom for raised arms).
export function framingGeometry(camera, rig, vrm) {
  const s = rig.shoulderWidth, head = rig.headPos, hips = rig.hipsPos;
  const box = new THREE.Box3().setFromObject(vrm.scene);
  const bottom = hips.y - 0.05 * s;
  const rawTop = Math.max(box.max.y, rig.shoulderY + 0.8 * rig.armLength, head.y + 0.6 * s);
  const top = rawTop + 0.04 * (rawTop - bottom);
  const cy = (top + bottom) / 2;
  const dist = ((top - bottom) / 2) / Math.tan((camera.fov / 2) * DEG) * 1.03;
  return { cy, dist, top, bottom, headZ: head.z };
}

// camera_default gives a VIEW DIRECTION (and height), not a literal distance: "distance still comes from her
// bounds, so framing never breaks" (PLAN-room.md §3) -- a badly-placed anchor can still never ruin the shot. Only
// the horizontal (XZ) direction from zumi_stand to camera_default is used; the vertical offset/height centring
// keeps coming from framingGeometry. The look-at centre is (standPos.x, cy, headZ) -- X from where she was placed
// (assumed centred on her own root, exactly like the original plain-stage camera's hardcoded X=0), Z from her
// measured head depth (rig.headPos.z already reflects wherever `standPos` placed vrm.scene, since bind() captures
// world positions AFTER placement) -- so this is never off by the room's own Z offset.
//
// With `standPos` = the world origin and `cameraAnchorPos` = null (no room, or an occluder fallback -- PLAN §3
// "Never a crash" / task R3 occluder check), this reduces to exactly the app's original plain-stage camera: directly
// in front, +Z. One function serves both cases, so there is nothing to keep in sync between them.
export function frameStageCamera(camera, rig, vrm, standPos, cameraAnchorPos) {
  const { cy, dist, top, bottom, headZ } = framingGeometry(camera, rig, vrm);
  let dirX = 0, dirZ = 1; // default: directly in front, +Z
  if (cameraAnchorPos) {
    const dx = cameraAnchorPos.x - standPos.x, dz = cameraAnchorPos.z - standPos.z;
    const len = Math.hypot(dx, dz);
    if (len > 1e-4) { dirX = dx / len; dirZ = dz / len; }
  }
  camera.position.set(standPos.x + dirX * dist, cy + 0.03 * (top - bottom), headZ + dirZ * dist);
  camera.lookAt(standPos.x, cy, headZ);
  camera.updateMatrixWorld();
  return { cy, dist, headZ };
}

// R4a idle glances (PLAN-R4-lean.md §R4a): the room's look_targets children, projected into stage NDC -- the
// SAME {x,y} space reflex/schema.js's lookAt targets already use (acc.gaze / LOOK_TARGETS, player.js:229-230),
// so the engine can treat a room anchor exactly like any other named gaze target. `camera` must already be in
// its FINAL position for this call/frame (i.e. after frameStageCamera, including any occluder-fallback
// re-frame) -- call once per placeAndFrame(), not every frame; the caller caches the result
// (engine.setLookTargets) since neither the anchors nor the camera move again until the next model/room switch.
// Returns [] for "no room" / "room has no look_targets node" -- the engine's own fallback for both is identical
// (glance around as before), so this function doesn't need to distinguish the two cases for its caller.
export function projectLookTargets(camera, lookTargetsAnchor) {
  if (!lookTargetsAnchor || !lookTargetsAnchor.children.length) return [];
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  return lookTargetsAnchor.children.map((c) => {
    const ndc = c.position.clone().project(camera);
    return { name: c.name, x: ndc.x, y: ndc.y, primary: Boolean(c.primary) }; // primary (coordinator round 4): threaded through so CameraDirector can find the default-gaze target among these
  });
}

// Occluder check (PLAN-room.md §3 "Never a crash" / task R3): nothing between the camera and Zumi's head/torso. A
// torso point is approximated as the midpoint between the neck and the hips (no public "chest" point on Rig).
// Returns true when something in `roomScene` sits strictly between the camera and either target.
export function isViewBlocked(camera, rig, roomScene) {
  const targets = [rig.headPos, rig.neckPos.clone().lerp(rig.hipsPos, 0.5)]; // head, and a torso point midway neck->hips
  const raycaster = new THREE.Raycaster();
  for (const target of targets) {
    const dir = target.clone().sub(camera.position);
    const dist = dir.length();
    if (dist < 1e-4) continue;
    dir.normalize();
    raycaster.set(camera.position, dir);
    raycaster.far = dist - 0.03; // a hit within 3cm of the target itself is Zumi/the target, not an occluder
    const hits = raycaster.intersectObject(roomScene, true);
    if (hits.length) return true;
  }
  return false;
}
