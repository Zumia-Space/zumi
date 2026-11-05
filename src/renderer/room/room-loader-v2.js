// Room loader v2 (T-31 camera modes, PLAN-camera-modes.md + coordinator rounds 2-3): loads a room.json v2
// descriptor -- already validated by the main process (src/main/room-check.mjs's checkRoomJsonV2, same "main
// process gates, renderer trusts and just reads" split v1's loadRoom()/room-check.mjs already use; this module
// imports NOTHING from src/main -- that file touches node:fs/node:crypto, which esbuild's browser-platform
// bundle cannot resolve). This is VESTA'S REAL v2-B SCHEMA: no .glb SCENE (the room itself is a painted PLATE
// image per view), but occluders come from one shared .glb of named, depth-only meshes (`model`), picked per
// view by node name. Each view carries its OWN zumi_seat and camera -- views are NOT geometrically consistent
// with each other (separate paintings, separate local origins) -- and may carry its own `lights` (round 3).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const VIEW_NAMES = ['talk', 'work', 'room'];

function isVec3(v) { return Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n)); }

function normaliseCamera(raw) {
  if (!raw || !isVec3(raw.pos) || !isVec3(raw.target)) return null;
  const three = raw.three;
  if (!three || typeof three.fov !== 'number' || typeof three.aspect !== 'number') return null;
  let viewOffset = null;
  if (three.viewOffset) {
    const vo = three.viewOffset;
    const fields = ['fullWidth', 'fullHeight', 'x', 'y', 'width', 'height'];
    if (fields.every((f) => typeof vo[f] === 'number' && Number.isFinite(vo[f]))) viewOffset = { ...vo };
  }
  return { pos: raw.pos, target: raw.target, fov: three.fov, aspect: three.aspect, viewOffset };
}

// scale/offset (work-view fit task, 2026-10-06): optional per-view size/position correction -- see
// src/main/room-check.mjs's checkSeat for the full reasoning. Both default to the identity here too (this
// loader is defensive on its own, same posture as every other normalise* function in this file -- it does not
// assume its input already went through room-check.mjs, see check-camera.mjs's own in-memory fixtures).
function normaliseSeat(raw) {
  if (!raw || !isVec3(raw.pos) || typeof raw.rotYDeg !== 'number') return null;
  const scale = typeof raw.scale === 'number' && Number.isFinite(raw.scale) && raw.scale > 0 ? raw.scale : 1;
  const offset = isVec3(raw.offset) ? raw.offset : [0, 0, 0];
  return { pos: raw.pos, rotYDeg: raw.rotYDeg, pose: typeof raw.pose === 'string' && raw.pose ? raw.pose : 'sit-idle', scale, offset };
}

// grade (coordinator round 2, 2026-10-05): optional per-view post-process override -- see room-check.mjs's
// checkGrade for the full reasoning. Malformed/missing -> null (the caller's own default takes over, same
// "degrade, never crash" posture as a malformed light).
function normaliseGrade(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.exposure !== 'number' || !Number.isFinite(raw.exposure)) return null;
  if (typeof raw.tint !== 'string' || !/^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(raw.tint)) return null;
  if (typeof raw.tintStrength !== 'number' || !Number.isFinite(raw.tintStrength)) return null;
  return { exposure: raw.exposure, tint: raw.tint, tintStrength: raw.tintStrength };
}

function normaliseView(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const camera = normaliseCamera(raw.camera);
  if (!camera) return null;
  const lookTargets = Array.isArray(raw.look_targets)
    ? raw.look_targets.filter((lt) => lt && typeof lt.name === 'string' && isVec3(lt.pos))
    : [];
  const occluderRefs = Array.isArray(raw.occluders) ? raw.occluders.filter((o) => o && typeof o.node === 'string' && o.node) : [];
  const lights = Array.isArray(raw.lights)
    ? raw.lights.filter((l) => l && ['directional', 'point', 'hemisphere'].includes(l.type) && typeof l.intensity === 'number')
    : [];
  return { camera, plate: typeof raw.plate === 'string' ? raw.plate : null, lookTargets, occluderRefs, lights, seat: normaliseSeat(raw.zumi_seat), grade: normaliseGrade(raw.grade) };
}

// ImageBitmapLoader (createImageBitmap() + fetch()), not TextureLoader (new Image()/document): the same
// headless-testable posture every other asset loader in this app's test scripts already relies on (e.g.
// scripts/check-r4a-latency.mjs stubs createImageBitmap for a DOM-less Node run; GLTFLoader's own texture path
// uses it the same way under the hood). A plate is NEVER sampled by WebGL (no mesh/material ever reads this
// Texture -- CameraDirector.drawPlate() only reads `.image` for a plain Canvas2D drawImage()), so this
// deliberately does NOT set the WebGL-texture `imageOrientation: 'flipY'` convention -- that flip is correct for
// a GPU-sampled texture (bottom-left origin) but upside-down for Canvas2D (top-left origin, matching the image
// file's own row order) -- the default imageOrientation ('none') is the right one here.
const bitmapLoader = new THREE.ImageBitmapLoader();
function loadTexture(url) {
  return new Promise((resolve, reject) => bitmapLoader.load(url, (bitmap) => resolve(new THREE.Texture(bitmap)), undefined, reject));
}

const gltfLoader = new GLTFLoader();
function loadGltf(url) { return gltfLoader.loadAsync(url); }

// Depth-only, drawn BEFORE the avatar ("renderOrder before the avatar"): a leg/body fragment behind this mesh
// fails the depth test against what this already wrote, so the painted furniture shows through instead of
// Zumi. Double-sided: the real occluders are thin planar polygons (a painted armrest's silhouette unprojected
// onto its own plane), not solid boxes -- a single-sided plane would stop occluding once the camera crosses it.
function occluderMaterial() { return new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true, side: THREE.DoubleSide }); }

// Vesta's real v2-B light shapes: 'directional' {color, toward}, 'point' {color, position, distance?, decay?},
// 'hemisphere' {skyColor, groundColor} (three.js's own HemisphereLight shape, used as-is, no `color` field).
function buildLight(spec) {
  if (spec.type === 'hemisphere') return new THREE.HemisphereLight(new THREE.Color(spec.skyColor), new THREE.Color(spec.groundColor), spec.intensity);
  const color = new THREE.Color(spec.color);
  if (spec.type === 'point') {
    const l = new THREE.PointLight(color, spec.intensity, spec.distance || 0, spec.decay != null ? spec.decay : 2);
    if (spec.position) l.position.set(...spec.position);
    return l;
  }
  // directional: `toward` is the direction the light TRAVELS (FROM the light TO the subject); three.js's
  // DirectionalLight points from `.position` AT `.target.position` instead, so the light sits one unit back
  // along -toward, aimed at the view's own local origin (where the subject sits, per the room's own convention
  // -- the target is added to the SAME group as the light below, not left to the default/unparented origin).
  const l = new THREE.DirectionalLight(color, spec.intensity);
  if (spec.toward) { const d = new THREE.Vector3(...spec.toward).normalize(); l.position.copy(d).multiplyScalar(-1); l.target.position.set(0, 0, 0); }
  return l;
}

/**
 * @param json the parsed room.json object (version 2) -- trusted, already checked by the main process.
 * @param resolveUrl (relativePath) => absolute URL this renderer can load (app:// in the real app, http in a
 *   test harness) -- used for both the plate images and `model` (occluders.glb).
 * @returns null when the JSON is too malformed to use at all (no usable talk view) -- the caller falls back to
 *   the plain stage, same posture as a v1 parse failure. Never throws.
 */
export async function loadRoomV2(json, resolveUrl) {
  if (!json || typeof json !== 'object' || json.version !== 2 || !json.views) return null;
  const talk = normaliseView(json.views.talk);
  if (!talk) return null; // PLAN-camera-modes.md: a missing talk view has nothing to fall back TO -- unusable room

  const normalised = { talk };
  for (const name of ['work', 'room']) normalised[name] = normaliseView(json.views[name]) || talk; // fallback to talk

  // occluders.glb: one shared file, named meshes per view ("occ_<view>_<part>" by convention, but this loader
  // only ever matches by the exact `node` name room.json itself gives -- no assumption about the naming scheme).
  let occluderMeshes = new Map(); // node name -> THREE.Mesh (removed from its original parent as each is claimed below)
  if (typeof json.model === 'string' && json.model) {
    try {
      const gltf = await loadGltf(resolveUrl(json.model));
      gltf.scene.traverse((o) => { if (o.isMesh) occluderMeshes.set(o.name, o); });
    } catch (e) { console.error('room v2: occluders model load failed', json.model, e); }
  }

  const views = {};
  const scene = new THREE.Group();
  scene.name = 'room-v2';
  for (const name of VIEW_NAMES) {
    const v = normalised[name];
    const group = new THREE.Group();
    group.name = `occluders-${name}`;
    for (const ref of v.occluderRefs) {
      const mesh = occluderMeshes.get(ref.node);
      if (!mesh) { console.warn('room v2: occluder node not found in model', ref.node); continue; }
      group.attach(mesh); // re-parents while preserving the mesh's own world transform (baked into the glb)
      mesh.material = occluderMaterial();
      mesh.renderOrder = -1;
    }
    group.visible = false; // CameraDirector shows only the active view's group
    scene.add(group);

    const lightsGroup = new THREE.Group();
    lightsGroup.name = `lights-${name}`;
    for (const spec of v.lights) { const light = buildLight(spec); lightsGroup.add(light); if (light.target) lightsGroup.add(light.target); }
    lightsGroup.visible = false;
    scene.add(lightsGroup);

    let plateTexture = null;
    if (v.plate) { try { plateTexture = await loadTexture(resolveUrl(v.plate)); } catch (e) { console.error('room v2: plate load failed', v.plate, e); } }
    views[name] = {
      camera: { position: new THREE.Vector3(...v.camera.pos), target: new THREE.Vector3(...v.camera.target), fov: v.camera.fov, aspect: v.camera.aspect, viewOffset: v.camera.viewOffset },
      lookTargets: v.lookTargets.map((lt) => ({ name: lt.name, position: new THREE.Vector3(...lt.pos), primary: Boolean(lt.primary) })), // primary (coordinator round 4): the default-gaze target, see room-check.mjs checkLookTargets
      occludersGroup: group,
      hasLights: v.lights.length > 0,
      lightsGroup,
      plateTexture,
      seat: v.seat, // { pos:[x,y,z], rotYDeg, pose } | null -- THIS view's own local seat anchor
      grade: v.grade, // { exposure, tint, tintStrength } | null -- THIS view's own authored default grade
    };
  }

  return {
    schemaVersion: 2,
    scene,
    views,
    dispose() {
      scene.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
      for (const v of Object.values(views)) { if (v.plateTexture) v.plateTexture.dispose(); }
    },
  };
}
