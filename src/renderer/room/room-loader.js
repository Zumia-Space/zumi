// Room loader (T-31 R3, PLAN-room.md §3 "room standard v1" anchors + §4 camera). Loads a room .glb that has already
// passed the main-process checker (room-check.mjs) and pulls out the anchors the stage cares about, as plain world
// transforms -- this module knows nothing about the checker's caps/refusal codes, only how to read the anchors out
// of a loaded three.js scene. A separate, plain GLTFLoader (no VRM plugin): a room is never a VRM, so it never needs
// VRMLoaderPlugin's humanoid/expression/springBone handling.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const ANCHOR_NAMES = ['zumi_stand', 'camera_default', 'desk_seat', 'desk_keyboard', 'screen_surface', 'prop_cup'];

const loader = new GLTFLoader();

function findByName(root, name) {
  let found = null;
  root.traverse((o) => { if (!found && o.name === name) found = o; });
  return found;
}

// World position/quaternion of a named anchor node, relative to the room's OWN root (the room is not yet attached
// to the main scene when this runs, so "world" here means "room-local" -- exactly the frame the caller needs to
// then re-root the whole room at the room's zumi_stand/world placement).
function anchorTransform(node) {
  if (!node) return null;
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  node.getWorldPosition(pos);
  node.getWorldQuaternion(quat);
  return { position: pos, quaternion: quat, node };
}

/** @returns {{ scene, anchors, lightCount }} -- anchors[name] is null when that node is absent (every anchor is optional). */
function extractAnchors(scene) {
  scene.updateMatrixWorld(true);
  const anchors = {};
  for (const name of ANCHOR_NAMES) anchors[name] = anchorTransform(findByName(scene, name));
  const lookNode = findByName(scene, 'look_targets');
  anchors.look_targets = lookNode
    ? { position: anchorTransform(lookNode).position, quaternion: anchorTransform(lookNode).quaternion, node: lookNode, children: lookNode.children.map((c) => ({ name: c.name, ...anchorTransform(c) })) }
    : null;
  let lightCount = 0;
  scene.traverse((o) => { if (o.isLight) lightCount++; });
  return { anchors, lightCount };
}

// Disposes every geometry/material/texture under `root` -- the plain-GLTF equivalent of VRMUtils.deepDispose (which
// only knows about VRM scenes). Safe to call on a partially-built scene (a failed/cancelled load).
export function disposeRoom(root) {
  if (!root) return;
  const seenMaterials = new Set();
  root.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) {
      if (seenMaterials.has(m)) continue;
      seenMaterials.add(m);
      for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap']) { if (m[key]) m[key].dispose(); }
      m.dispose();
    }
  });
}

/** @param {string} url -- an app://zumi/rooms/... URL. Rejects on a GLTFLoader-level failure (a room that passed
 *  the main-process checker but still fails to parse in the renderer -- rare; the caller falls back to the plain stage). */
export async function loadRoom(url, onProgress) {
  const gltf = await loader.loadAsync(url, onProgress);
  const { anchors, lightCount } = extractAnchors(gltf.scene);
  return { scene: gltf.scene, anchors, lightCount, dispose: () => disposeRoom(gltf.scene) };
}
