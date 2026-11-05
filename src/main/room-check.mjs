// Room checker (T-31 R1, PLAN-room.md §3 "room standard v1"): validates a room .glb BEFORE the renderer ever sees
// it. Pure glTF-JSON / binary-chunk parsing -- no three.js, no DOM -- so this is safe to import IN-PROCESS from the
// Electron main process (unlike scripts/check-rig.mjs and its siblings, it never stubs globalThis.window) and safe to run in plain Node
// for scripts/check-room.mjs. Fail-closed for safety and size (one refusal code, caller renders the message); every
// anchor is optional with a per-feature fallback, so a missing anchor is a WARNING, never a refusal.
import crypto from 'node:crypto';
import fs from 'node:fs';

// ---------- caps (PLAN-room.md §3 table) ----------
// Size caps are decimal MB (1,000,000 bytes), matching the ONE place bytes are ever turned into "MB" for a human
// (the mb/capMb params below, also /1e6) -- a prior version defined the cap in binary MiB (1024*1024 = 26.2 MB)
// while display used decimal MB, so a 25 MB cap showed as "up to 26 MB" (coordinator QC 03-10). One definition now.
export const MB = 1_000_000;
export const CAPS = {
  sizeRefuseBytes: 25 * MB,
  sizeWarnBytes: 10 * MB,
  trianglesRefuse: 100_000,
  trianglesWarn: 50_000,
  drawsRefuse: 200,
  drawsWarn: 80,
  texturesCountRefuse: 16,
  texturesCountWarn: 8,
  textureDimRefuse: 2048,
  textureDimWarn: 1024,
  textureMemRefuseMB: 96,
  textureMemWarnMB: 32,
  nodesRefuse: 2000,
};

// extensionsRequired allowlist (PLAN-room.md §3): Draco/meshopt/KTX2 need decoders this build does not ship, so any
// required extension outside this list is refused. extensionsUsed (not required) is not checked -- a room may
// mention an optional extension it does not actually need to be read correctly.
export const ALLOWED_EXTENSIONS = new Set([
  'KHR_materials_unlit',
  'KHR_texture_transform',
  'KHR_lights_punctual',
  'KHR_materials_emissive_strength',
  'KHR_mesh_quantization',
]);
const COMPRESSION_EXTENSIONS = new Set(['KHR_draco_mesh_compression', 'EXT_meshopt_compression', 'KHR_texture_basisu', 'EXT_texture_webp']);

const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a; // 'JSON'
const CHUNK_BIN = 0x004e4942; // 'BIN\0'

const COMPONENT_BYTES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TYPE_COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

const refuse = (code, params = {}) => ({ ok: false, refused: { code, params }, warnings: [], stats: null, anchors: null });

// ---------- GLB container ----------
// -> { json, bin: Buffer|null } or throws a short internal reason (never shown to the user -- the caller maps any
// throw to the generic 'not_a_room_file' refusal).
function parseGlb(buf) {
  if (buf.length < 20) throw new Error('header too short');
  if (buf.readUInt32LE(0) !== GLB_MAGIC) throw new Error('bad magic');
  const version = buf.readUInt32LE(4);
  if (version !== 2) throw new Error(`unsupported glTF-binary version ${version}`);
  const declaredLength = buf.readUInt32LE(8);
  if (declaredLength > buf.length) throw new Error('truncated (declared length exceeds file size)');
  const jsonChunkLength = buf.readUInt32LE(12);
  const jsonChunkType = buf.readUInt32LE(16);
  if (jsonChunkType !== CHUNK_JSON) throw new Error('first chunk is not JSON');
  if (20 + jsonChunkLength > buf.length) throw new Error('truncated JSON chunk');
  const json = JSON.parse(buf.subarray(20, 20 + jsonChunkLength).toString('utf8'));
  let bin = null;
  let off = 20 + jsonChunkLength;
  if (off + 8 <= buf.length) {
    const binLen = buf.readUInt32LE(off);
    const binType = buf.readUInt32LE(off + 4);
    if (binType === CHUNK_BIN) {
      if (off + 8 + binLen > buf.length) throw new Error('truncated BIN chunk');
      bin = buf.subarray(off + 8, off + 8 + binLen);
    }
  }
  return { json, bin };
}

// ---------- scene-graph traversal: triangles + draw calls (PLAN §3: "Draw calls" / "Triangles") ----------
// Counted per NODE reference (not per mesh definition), so a mesh instanced by two nodes costs two draws -- the same
// cost the renderer actually pays. Falls back to summing every defined mesh when there is no usable scene list
// (malformed-but-not-fatal files), so the cap is never silently skipped.
function sceneStats(json) {
  const nodes = json.nodes || [];
  const meshes = json.meshes || [];
  const accessors = json.accessors || [];
  let triangles = 0;
  let draws = 0;
  const visitMesh = (meshIdx) => {
    const mesh = meshes[meshIdx];
    if (!mesh || !Array.isArray(mesh.primitives)) return;
    for (const prim of mesh.primitives) {
      draws++;
      const mode = prim.mode == null ? 4 : prim.mode; // 4 = TRIANGLES (glTF default)
      if (mode !== 4 && mode !== 5 && mode !== 6) continue; // lines/points draw, but add no triangles
      if (prim.indices != null) {
        const acc = accessors[prim.indices];
        if (acc) triangles += mode === 4 ? Math.floor(acc.count / 3) : Math.max(0, acc.count - 2);
      } else {
        const posAcc = accessors[prim.attributes && prim.attributes.POSITION];
        if (posAcc) triangles += mode === 4 ? Math.floor(posAcc.count / 3) : Math.max(0, posAcc.count - 2);
      }
    }
  };
  const visited = new Set();
  const visitNode = (idx) => {
    if (visited.has(idx)) return; // guards a cyclic/duplicated scene graph from double-counting forever
    visited.add(idx);
    const n = nodes[idx];
    if (!n) return;
    if (n.mesh != null) visitMesh(n.mesh);
    for (const c of n.children || []) visitNode(c);
  };
  const scenes = json.scenes || [];
  const sceneIdx = json.scene != null ? json.scene : 0;
  const roots = scenes[sceneIdx] && Array.isArray(scenes[sceneIdx].nodes) ? scenes[sceneIdx].nodes : null;
  if (roots) for (const r of roots) visitNode(r);
  else for (let i = 0; i < meshes.length; i++) visitMesh(i); // no scene list: fall back to every defined mesh once
  return { triangles, draws };
}

// ---------- images: dimensions from PNG/JPEG headers, never a full decode (blocks small-file/huge-image bombs) ----------
function pngSize(buf) {
  if (buf.length < 24 || buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}
function jpegSize(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let off = 2;
  while (off + 4 <= buf.length) {
    if (buf[off] !== 0xff) { off++; continue; }
    const marker = buf[off + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { off += 2; continue; }
    const len = buf.readUInt16BE(off + 2);
    const isSOF = (marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSOF) {
      if (off + 9 > buf.length) return null;
      return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
    }
    off += 2 + len;
  }
  return null;
}
function imageSize(buf) { return pngSize(buf) || jpegSize(buf) || null; }

function imageStats(json, bin) {
  const views = json.bufferViews || [];
  let maxDim = 0;
  let decodedBytes = 0;
  const dims = [];
  for (const img of json.images || []) {
    if (img.bufferView == null || !bin) continue; // external/no-data images are caught by the external-URI check
    const bv = views[img.bufferView];
    if (!bv) continue;
    const start = bv.byteOffset || 0;
    const slice = bin.subarray(start, start + bv.byteLength);
    const size = imageSize(slice);
    if (!size) continue;
    dims.push(size);
    maxDim = Math.max(maxDim, size.width, size.height);
    decodedBytes += size.width * size.height * 4; // RGBA8, no mip chain -- a floor, not an exact VRAM figure
  }
  return { count: (json.images || []).length, textureCount: (json.textures || []).length, maxDim, decodedMB: decodedBytes / (1024 * 1024), dims };
}

// ---------- accessor <-> bufferView <-> buffer bounds (defense in depth: a malformed file never reaches the loader) ----------
function accessorsInBounds(json, bin) {
  const views = json.bufferViews || [];
  const bufByteLength = bin ? bin.length : (json.buffers && json.buffers[0] && json.buffers[0].byteLength) || 0;
  for (const bv of views) {
    if ((bv.byteOffset || 0) + bv.byteLength > bufByteLength) return false;
  }
  for (const acc of json.accessors || []) {
    if (acc.bufferView == null) continue; // sparse/zero-filled accessor: nothing to bound-check here
    const bv = views[acc.bufferView];
    if (!bv) return false;
    const compBytes = COMPONENT_BYTES[acc.componentType];
    const comps = TYPE_COMPONENTS[acc.type];
    if (!compBytes || !comps) return false;
    const elementBytes = acc.byteStride || compBytes * comps;
    const needed = (acc.byteOffset || 0) + elementBytes * Math.max(0, acc.count - 1) + compBytes * comps;
    if (needed > bv.byteLength) return false;
  }
  return true;
}

// ---------- anchors (PLAN-room.md §3 table): every one optional, a missing one is a warning, never a refusal ----------
const ANCHOR_NAMES = ['zumi_stand', 'camera_default', 'desk_seat', 'desk_keyboard', 'screen_surface', 'prop_cup', 'look_targets'];
function anchorStats(json) {
  const nodes = json.nodes || [];
  const byName = {};
  for (const name of ANCHOR_NAMES) byName[name] = nodes.some((n) => n && n.name === name);
  const lookNode = nodes.find((n) => n && n.name === 'look_targets');
  const lookTargetsChildren = lookNode && Array.isArray(lookNode.children) ? lookNode.children.length : 0;
  const lights = (json.extensions && json.extensions.KHR_lights_punctual && json.extensions.KHR_lights_punctual.lights || []).length;
  return { ...byName, lookTargetsChildren, lights };
}

/** @param {Buffer} buf -- the exact bytes of a room .glb. Returns a verdict, never throws. */
export function checkRoomGlb(buf) {
  const bytes = buf.length;
  if (bytes > CAPS.sizeRefuseBytes) return refuse('too_big', { mb: +(bytes / MB).toFixed(1), capMb: Math.round(CAPS.sizeRefuseBytes / MB) });

  let json, bin;
  try { ({ json, bin } = parseGlb(buf)); } catch { return refuse('not_a_room_file'); }
  if (!accessorsInBounds(json, bin)) return refuse('not_a_room_file');

  if ((json.nodes || []).length > CAPS.nodesRefuse) return refuse('too_many_nodes', { count: (json.nodes || []).length });
  if (json.skins && json.skins.length) return refuse('has_skin');

  for (const list of [json.buffers, json.images]) {
    for (const entry of list || []) {
      if (entry.uri && !/^data:/i.test(entry.uri)) return refuse('external_uri');
    }
  }
  // an embedded (bufferView-based) image/buffer with no BIN chunk at all is just as unreadable as an external file
  if (!bin && ((json.images || []).some((i) => i.bufferView != null) || (json.buffers || []).some((b) => !b.uri))) return refuse('not_a_room_file');

  for (const ext of json.extensionsRequired || []) {
    if (ALLOWED_EXTENSIONS.has(ext)) continue;
    return refuse(COMPRESSION_EXTENSIONS.has(ext) ? 'unsupported_compression' : 'unsupported_extension');
  }

  const { triangles, draws } = sceneStats(json);
  if (triangles > CAPS.trianglesRefuse) return refuse('too_many_triangles', { count: triangles, cap: CAPS.trianglesRefuse });
  if (draws > CAPS.drawsRefuse) return refuse('too_many_draws', { count: draws, cap: CAPS.drawsRefuse });

  const img = imageStats(json, bin);
  if (img.textureCount > CAPS.texturesCountRefuse) return refuse('too_many_textures', { count: img.textureCount, cap: CAPS.texturesCountRefuse });
  if (img.maxDim > CAPS.textureDimRefuse) return refuse('texture_too_big', { px: img.maxDim, cap: CAPS.textureDimRefuse });
  if (img.decodedMB > CAPS.textureMemRefuseMB) return refuse('too_much_texture_memory', { mb: +img.decodedMB.toFixed(1), cap: CAPS.textureMemRefuseMB });

  const warnings = [];
  const warn = (code, params = {}) => warnings.push({ code, params });
  if (bytes > CAPS.sizeWarnBytes) warn('approaching_size', { mb: +(bytes / MB).toFixed(1) });
  if (triangles > CAPS.trianglesWarn) warn('approaching_triangles', { count: triangles });
  if (draws > CAPS.drawsWarn) warn('approaching_draws', { count: draws });
  if (img.textureCount > CAPS.texturesCountWarn) warn('approaching_textures', { count: img.textureCount });
  if (img.maxDim > CAPS.textureDimWarn) warn('approaching_texture_dim', { px: img.maxDim });
  if (img.decodedMB > CAPS.textureMemWarnMB) warn('approaching_texture_memory', { mb: +img.decodedMB.toFixed(1) });

  const anchors = anchorStats(json);
  if (!anchors.zumi_stand) warn('missing_stand');
  if (!anchors.camera_default) warn('missing_camera');
  if (!anchors.desk_seat) warn('missing_desk');
  if (!anchors.desk_keyboard) warn('missing_keyboard');
  if (!anchors.screen_surface) warn('missing_screen');
  if (!anchors.prop_cup) warn('missing_cup');
  if (!anchors.look_targets || anchors.lookTargetsChildren === 0) warn('missing_glances');
  if (anchors.lights === 0) warn('missing_lights');

  const materials = (json.materials || []).length;
  const stats = { bytes, triangles, drawCalls: draws, materials, textureCount: img.textureCount, imageCount: img.count, maxTextureDim: img.maxDim, textureMemoryMB: +img.decodedMB.toFixed(2), nodeCount: (json.nodes || []).length };
  return { ok: true, refused: null, warnings, stats, anchors };
}

/** Convenience for real files: a cheap stat-based size refusal before the whole file is read into memory. */
export function checkRoomFile(absPath) {
  const st = fs.statSync(absPath);
  if (st.size > CAPS.sizeRefuseBytes) return refuse('too_big', { mb: +(st.size / MB).toFixed(1), capMb: Math.round(CAPS.sizeRefuseBytes / MB) });
  return checkRoomGlb(fs.readFileSync(absPath));
}

/** sha256 of the exact bytes, first 12 hex chars -- the import folder id (PLAN §3 "Storage"). */
export function roomContentId(buf) { return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12); }

// ============================================================================================
// room standard v2 (T-31 camera modes, PLAN-camera-modes.md + coordinator rounds 2-3, 2026-10-03): a JSON room,
// no .glb SCENE (the walls/furniture are a PAINTED PLATE image per view) but occluders DO come from one shared
// .glb of named, depth-only meshes (`model`, e.g. "occluders.glb"), picked per view by node name -- this is
// VESTA'S REAL v2-B SCHEMA (the v2-B room.json), frozen field names as of round 3; this
// checker validates it as-is. Each view carries its OWN zumi_seat and camera (views are NOT geometrically
// consistent with each other -- separate paintings, separate local origins) and may carry its own `lights`
// (round 3: replaces the default light rig while that view is active; absent = keep the app's default lights).
// Pure JSON-structure validation, same posture as checkRoomGlb above: fail-closed caps, every optional feature
// degrades to a warning, never a crash. v1 (.glb + named anchors) is untouched by any of this -- a v2 room is
// recognised by the caller (version === 2 in the parsed JSON), never by guessing from file content.
export const CAPS_V2 = {
  plateBytesRefuse: 12 * MB, // the real plates are ~250-300KB at 1920x1200; headroom for a higher-res repaint
  plateBytesWarn: 5 * MB,
  plateDimRefuse: 4096,
  plateDimWarn: 2048,
  occludersPerViewRefuse: 30, // the real room's max is 11 (room view); generous headroom, still bounded
  occludersPerViewWarn: 16,
  lookTargetsPerViewRefuse: 32,
  fovMin: 4,
  fovMax: 120,
  aspectMin: 0.3,
  aspectMax: 3.5,
  // coordinator round 3 originally said "<=4 lights" (written before any real lights data existed); Vesta's
  // final v2-B room.json ships 5 per view (work/room: 2 directional key/rim + 1 point lamp + 1 directional
  // screen-glow + 1 hemisphere ambient) -- raised to fit the real, final, shipped data, still bounded.
  lightsPerViewRefuse: 8,
  lightIntensityMax: 8, // generous vs. both the app's own default rig (key ~2.97, rim 1.1, ambient 0.55) and the real room's (0.11-1.53)
  gradeExposureMin: 0.3, // coordinator round 2 (2026-10-05): 0.3-2 brackets any sane dim/brighten; the real room's is 0.75-0.92
  gradeExposureMax: 2,
  // seat scale/offset (work-view fit task, 2026-10-06): a PER-VIEW correction for how big/where Zumi sits in that
  // view's own painted plate -- views are separate paintings at separate scales (round 2's own "not geometrically
  // consistent" note), so a per-view size/position tweak is legitimate authoring, not a hack. Bounded generously
  // (a real fix is expected to be within ~25% / a few cm, per the owner's own QC) so a typo can't make her huge or
  // teleport across the room.
  seatScaleMin: 0.6,
  seatScaleMax: 1.8,
  seatOffsetMaxM: 0.5,
  // allowed_region (work-view fit task): a hand-authored, QC-only polygon list in PLATE PIXEL coordinates --
  // scripts/check-work-fit.mjs's own "avatar pixels must stay inside this" gate. Never read by the renderer
  // (room-loader-v2.js does not load it; it has no rendering effect), so these caps are generous headroom, not a
  // real-time budget.
  allowedRegionPolygonsRefuse: 6,
  allowedRegionPointsRefuse: 80,
};
const VIEW_NAMES = ['talk', 'work', 'room'];
const LIGHT_TYPES = new Set(['directional', 'point', 'hemisphere']); // Vesta's real v2-B field names (round 3 final) -- 'ambient' was this task's own earlier guess, corrected against the shipped data
const refuseV2 = (code, params = {}) => ({ ok: false, refused: { code, params }, warnings: [], views: null, fallback: null });

function isVec3(v) { return Array.isArray(v) && v.length === 3 && v.every(Number.isFinite); }
function isFiniteNum(n) { return typeof n === 'number' && Number.isFinite(n); }
function isHexColor(s) { return typeof s === 'string' && /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(s); }

// zumi_seat (round 2: moved to PER VIEW -- views are not geometrically consistent, so the seat's x/z/facing are
// only meaningful in that view's own local frame). pos.y is the hips-bone height with soles flat on the floor
// (informational / what the plate was painted against) -- the real drop is always measured live, ankle-anchored
// (src/renderer/room/seat.js), never read out of this field; a room missing zumi_seat for a view just means
// Zumi stands at that view's origin instead of sitting.
//
// scale/offset (work-view fit task, 2026-10-06): optional, per-view, both default to the identity (1, [0,0,0])
// so an older room with neither behaves exactly as before. `scale` uniformly resizes Zumi for THIS view only
// (src/renderer/room/seat.js applies it around the already-placed floor anchor, so it never fights the ankle
// drop). `offset` is a plain [dx,dy,dz] nudge in this view's own world axes (the same frame `pos` is authored
// in, NOT rotated by rotYDeg), for residual position fit a `pos` edit alone would conflate with pos's own
// documented "hip-joint midpoint" meaning. Malformed -> warned and dropped (identity), never a refusal -- same
// posture as a malformed look_target.
function checkSeat(spec, warnings, warn) {
  if (!spec) return null;
  if (!isVec3(spec.pos) || !isFiniteNum(spec.rotYDeg)) { warn('bad_seat', {}); return null; }
  let scale = 1;
  if (spec.scale !== undefined) {
    if (isFiniteNum(spec.scale) && spec.scale >= CAPS_V2.seatScaleMin && spec.scale <= CAPS_V2.seatScaleMax) scale = spec.scale;
    else warn('bad_seat_scale', {});
  }
  let offset = [0, 0, 0];
  if (spec.offset !== undefined) {
    if (isVec3(spec.offset) && spec.offset.every((c) => Math.abs(c) <= CAPS_V2.seatOffsetMaxM)) offset = spec.offset;
    else warn('bad_seat_offset', {});
  }
  return { pos: spec.pos, rotYDeg: spec.rotYDeg, pose: typeof spec.pose === 'string' && spec.pose ? spec.pose : 'sit-idle', scale, offset };
}

// allowed_region (work-view fit task): a hand-authored list of polygons, in PLATE PIXEL coordinates, that is the
// UNION of where avatar pixels may legitimately appear in this view -- the painted chair/desk silhouette plus
// the zone above the chair back where the head/shoulders/hair may show. QC-only: the renderer never reads this
// (room-loader-v2.js does not load it); scripts/check-work-fit.mjs is the one consumer. Each polygon needs >=3
// finite [x,y] points; a malformed polygon is dropped with a warning, never a refusal (same posture as every
// other optional authoring field here).
function checkAllowedRegion(raw, warn) {
  if (!Array.isArray(raw) || !raw.length) return [];
  if (raw.length > CAPS_V2.allowedRegionPolygonsRefuse) { warn('too_many_allowed_region_polygons', { count: raw.length, cap: CAPS_V2.allowedRegionPolygonsRefuse }); return []; }
  const out = [];
  for (const poly of raw) {
    const valid = Array.isArray(poly) && poly.length >= 3 && poly.length <= CAPS_V2.allowedRegionPointsRefuse
      && poly.every((p) => Array.isArray(p) && p.length === 2 && isFiniteNum(p[0]) && isFiniteNum(p[1]));
    if (!valid) { warn('bad_allowed_region_polygon', {}); continue; }
    out.push(poly.map((p) => [p[0], p[1]]));
  }
  return out;
}

// seat_cushion_line (work-view fit task, coordinator round 5): a hand-authored 2-point line, in PLATE PIXEL
// coordinates, tracing the painted seat cushion's visible contact surface -- where a seated hip/thigh should
// rest. QC-only, same posture as allowed_region (never read by the renderer; scripts/check-work-fit.mjs is the
// one consumer, asserting the avatar's lowest seat-contact pixel lands within a few px of this line instead of
// floating above it). Exactly 2 finite [x,y] points; malformed -> dropped with a warning, never a refusal.
function checkSeatCushionLine(raw, warn) {
  if (raw == null) return null;
  const valid = Array.isArray(raw) && raw.length === 2 && raw.every((p) => Array.isArray(p) && p.length === 2 && isFiniteNum(p[0]) && isFiniteNum(p[1]));
  if (!valid) { warn('bad_seat_cushion_line', {}); return null; }
  return raw.map((p) => [p[0], p[1]]);
}

// `primary` (coordinator round 4, 2026-10-05): marks the ONE look_target that is this view's default gaze --
// where her head/eyes rest when nothing else is pulling them, the same role the camera/pointer plays for talk
// (ReflexEngine.primaryGaze) -- not just an occasional glance candidate. At most one per view; a second
// primary:true entry is downgraded to a plain glance target (a bad room should degrade, not pick arbitrarily).
function checkLookTargets(list, warn) {
  if (!Array.isArray(list) || !list.length) return [];
  if (list.length > CAPS_V2.lookTargetsPerViewRefuse) { warn('too_many_look_targets', { count: list.length, cap: CAPS_V2.lookTargetsPerViewRefuse }); return []; }
  const out = [];
  let sawPrimary = false;
  for (const lt of list) {
    if (!lt || typeof lt.name !== 'string' || !lt.name || !isVec3(lt.pos)) continue; // a malformed target is dropped, not a refusal (PLAN: every anchor optional)
    const primary = Boolean(lt.primary) && !sawPrimary;
    if (primary) sawPrimary = true;
    else if (lt.primary) warn('extra_primary_look_target', { name: lt.name });
    out.push({ name: lt.name, pos: lt.pos, primary });
  }
  return out;
}

// lights (coordinator round 3, ADDS to the frozen v2 schema; shapes matched against Vesta's real, final v2-B
// room.json, not guessed): a per-view light rig matched to that view's plate. 'directional' carries `toward` (a
// unit vector the light travels TOWARD, i.e. the direction FROM the light TO the subject) + `color`; 'point'
// carries `position` + `color` (+ optional `distance`/`decay` falloff); 'hemisphere' carries `skyColor` +
// `groundColor` instead of one `color` (three.js's own HemisphereLight shape, used as-is). Each entry is
// dropped (not a refusal) when malformed -- same posture as a malformed look_target/occluder -- since a bad
// light just means that view keeps the app's default lighting, never a crash or a refused room.
function checkLights(list, warn) {
  if (!Array.isArray(list) || !list.length) return [];
  if (list.length > CAPS_V2.lightsPerViewRefuse) { warn('too_many_lights', { count: list.length, cap: CAPS_V2.lightsPerViewRefuse }); return []; }
  const out = [];
  for (const l of list) {
    if (!l || !LIGHT_TYPES.has(l.type) || !isFiniteNum(l.intensity) || l.intensity < 0) { warn('bad_light', {}); continue; }
    if (l.intensity > CAPS_V2.lightIntensityMax) warn('bright_light_clamped', { intensity: l.intensity, cap: CAPS_V2.lightIntensityMax });
    const intensity = Math.min(l.intensity, CAPS_V2.lightIntensityMax);
    if (l.type === 'hemisphere') {
      if (!isHexColor(l.skyColor) || !isHexColor(l.groundColor)) { warn('bad_light', {}); continue; }
      out.push({ type: 'hemisphere', skyColor: l.skyColor, groundColor: l.groundColor, intensity });
      continue;
    }
    if (!isHexColor(l.color)) { warn('bad_light', {}); continue; }
    if (l.type === 'directional') {
      if (!isVec3(l.toward)) { warn('bad_light', {}); continue; }
      out.push({ type: 'directional', color: l.color, intensity, toward: l.toward });
      continue;
    }
    // point
    if (!isVec3(l.position)) { warn('bad_light', {}); continue; }
    out.push({ type: 'point', color: l.color, intensity, position: l.position, distance: isFiniteNum(l.distance) ? l.distance : 0, decay: isFiniteNum(l.decay) ? l.decay : 2 });
  }
  return out;
}

// grade (coordinator round 2, 2026-10-05): optional per-view post-process -- `exposure` dims/brightens ONLY the
// avatar layer, `tint`/`tintStrength` multiply-blend the WHOLE stage (avatar + plate) toward the plate's own
// colour -- so a flatly-lit white avatar reads under the same light as the painted scene (sofa throw, desk
// lamp) instead of floating above it, brighter/whiter than everything around her. Reuses the SAME three
// fields the look-tuning dev panel already exposes (exposure/tint/tintStrength); this just gives them an
// authored default instead of only a hand-tuned one. Malformed -> dropped with a warning (cosmetic, same
// posture as a malformed light), never a refusal.
function checkGrade(g, warn) {
  if (g == null) return null;
  if (typeof g !== 'object') { warn('bad_grade', {}); return null; }
  if (!isFiniteNum(g.exposure) || g.exposure < CAPS_V2.gradeExposureMin || g.exposure > CAPS_V2.gradeExposureMax) { warn('bad_grade', {}); return null; }
  if (!isHexColor(g.tint)) { warn('bad_grade', {}); return null; }
  if (!isFiniteNum(g.tintStrength) || g.tintStrength < 0 || g.tintStrength > 1) { warn('bad_grade', {}); return null; }
  return { exposure: g.exposure, tint: g.tint, tintStrength: g.tintStrength };
}

/** @param {Buffer|null} buf -- the plate's exact bytes, or null when not supplied (plate size/dims then go unchecked, flagged with a warning). */
function checkPlate(relPath, buf, warn) {
  if (typeof relPath !== 'string' || !relPath) return null;
  if (!buf) { warn('plate_unchecked', { path: relPath }); return { path: relPath }; }
  if (buf.length > CAPS_V2.plateBytesRefuse) return { refused: { code: 'plate_too_big', params: { path: relPath, mb: +(buf.length / MB).toFixed(1), capMb: Math.round(CAPS_V2.plateBytesRefuse / MB) } } };
  if (buf.length > CAPS_V2.plateBytesWarn) warn('approaching_plate_size', { path: relPath, mb: +(buf.length / MB).toFixed(1) });
  const size = imageSize(buf);
  if (size) {
    const maxDim = Math.max(size.width, size.height);
    if (maxDim > CAPS_V2.plateDimRefuse) return { refused: { code: 'plate_dimension_too_big', params: { path: relPath, px: maxDim, cap: CAPS_V2.plateDimRefuse } } };
    if (maxDim > CAPS_V2.plateDimWarn) warn('approaching_plate_dim', { path: relPath, px: maxDim });
  }
  return { path: relPath, bytes: buf.length, dims: size || null };
}

// camera.three.{fov,aspect,viewOffset} is the AUTHORITATIVE projection (an fSpy-style solve, coordinator ruling
// 03-10) -- camera.fovDeg/focalPx/principalPointPx/yawDeg are the solver's own working numbers, informational,
// never read by the loader. viewOffset is optional (an off-centre principal point / lens shift); when present
// every one of its 6 fields must be finite, or the whole camera is refused (a half-applied setViewOffset is
// worse than none).
function checkCamera(cam, name) {
  if (!cam || !isVec3(cam.pos) || !isVec3(cam.target)) return { refused: { code: 'bad_camera', params: { view: name } } };
  const three = cam.three;
  if (!three || !isFiniteNum(three.fov) || !isFiniteNum(three.aspect)) return { refused: { code: 'bad_camera', params: { view: name } } };
  if (three.fov < CAPS_V2.fovMin || three.fov > CAPS_V2.fovMax) return { refused: { code: 'bad_camera', params: { view: name } } };
  if (three.aspect < CAPS_V2.aspectMin || three.aspect > CAPS_V2.aspectMax) return { refused: { code: 'bad_camera', params: { view: name } } };
  let viewOffset = null;
  if (three.viewOffset) {
    const vo = three.viewOffset;
    const fields = ['fullWidth', 'fullHeight', 'x', 'y', 'width', 'height'];
    if (!fields.every((f) => isFiniteNum(vo[f]))) return { refused: { code: 'bad_camera', params: { view: name } } };
    viewOffset = { fullWidth: vo.fullWidth, fullHeight: vo.fullHeight, x: vo.x, y: vo.y, width: vo.width, height: vo.height };
  }
  return { ok: true, pos: cam.pos, target: cam.target, fov: three.fov, aspect: three.aspect, viewOffset };
}

function checkView(name, v, plateBytesByPath, warn) {
  if (!v || typeof v !== 'object') return null;
  const cameraResult = checkCamera(v.camera, name);
  if (cameraResult.refused) return cameraResult;

  const plateResult = checkPlate(v.plate, (plateBytesByPath && plateBytesByPath.get(v.plate)) || null, (code, params) => warn(code, { view: name, ...params }));
  if (plateResult && plateResult.refused) return plateResult;
  if (!plateResult) warn('missing_plate', { view: name });

  const lookTargets = checkLookTargets(v.look_targets, (code, params) => warn(code, { view: name, ...params }));
  if (!lookTargets.length) warn('missing_look_targets', { view: name });

  const lights = checkLights(v.lights, (code, params) => warn(code, { view: name, ...params }));

  const rawOccluders = Array.isArray(v.occluders) ? v.occluders : [];
  if (rawOccluders.length > CAPS_V2.occludersPerViewRefuse) return { refused: { code: 'too_many_occluders', params: { view: name, count: rawOccluders.length, cap: CAPS_V2.occludersPerViewRefuse } } };
  if (rawOccluders.length > CAPS_V2.occludersPerViewWarn) warn('approaching_occluders', { view: name, count: rawOccluders.length });
  const occluders = [];
  for (const o of rawOccluders) {
    if (!o || typeof o.node !== 'string' || !o.node) { warn('bad_occluder', { view: name }); continue; } // `node`: the mesh name in `model` (occluders.glb) -- geometry/transform/material are authoring metadata, already baked into that mesh
    occluders.push({ name: typeof o.name === 'string' ? o.name : o.node, node: o.node });
  }

  const seat = checkSeat(v.zumi_seat, null, (code, params) => warn(code, { view: name, ...params }));
  if (!seat) warn('missing_seat', { view: name });

  const allowedRegion = checkAllowedRegion(v.allowed_region, (code, params) => warn(code, { view: name, ...params }));
  const seatCushionLine = checkSeatCushionLine(v.seat_cushion_line, (code, params) => warn(code, { view: name, ...params }));

  const grade = checkGrade(v.grade, (code, params) => warn(code, { view: name, ...params }));

  return { ok: true, camera: cameraResult, plate: plateResult, look_targets: lookTargets, occluders, lights, zumi_seat: seat, allowed_region: allowedRegion, seat_cushion_line: seatCushionLine, grade };
}

/**
 * Validates a parsed v2 room.json object. `plateBytesByPath` is an optional `Map<relativePlatePath, Buffer>` --
 * omit it to validate structure only (every plate then warns `plate_unchecked`); the real caller
 * (checkRoomJsonFile below) always supplies it by reading the plate files that sit beside room.json.
 * @returns {{ ok, refused, warnings, views: {talk,work,room}|null, fallback: {work:boolean, room:boolean}|null, model: string|null }}
 */
export function checkRoomJsonV2(json, plateBytesByPath = null) {
  if (!json || typeof json !== 'object' || json.version !== 2) return refuseV2('not_a_room_json');
  if (!json.views || typeof json.views !== 'object') return refuseV2('not_a_room_json');

  const warnings = [];
  const warn = (code, params = {}) => warnings.push({ code, params });

  const talk = checkView('talk', json.views.talk, plateBytesByPath, warn);
  if (!talk) return refuseV2('missing_talk_view');
  if (talk.refused) return refuseV2(talk.refused.code, talk.refused.params);

  const fallback = { work: false, room: false };
  const views = { talk };
  for (const name of ['work', 'room']) {
    const got = checkView(name, json.views[name], plateBytesByPath, warn);
    if (!got) { fallback[name] = true; warn('view_falls_back_to_talk', { view: name }); views[name] = talk; continue; }
    if (got.refused) return refuseV2(got.refused.code, got.refused.params);
    views[name] = got;
  }

  if (!json.model || typeof json.model !== 'string') warn('missing_occluders_model', {});

  return { ok: true, refused: null, warnings, views, fallback, model: typeof json.model === 'string' ? json.model : null };
}

/** Convenience for real files: reads room.json plus every plate PNG/JPEG it references (siblings, relative
 *  paths), so size/dimension caps are enforced from real bytes, not trusted from the JSON alone. Does NOT read
 *  `model` (occluders.glb) -- that is a 3D asset, out of scope for this checker (same division of labour as v1
 *  never re-verifying a model's own rig); the renderer's loader degrades per-occluder if a referenced node is
 *  missing from it. */
export function checkRoomJsonFile(absJsonPath) {
  const fsMod = fs;
  let json;
  try { json = JSON.parse(fsMod.readFileSync(absJsonPath, 'utf8')); } catch { return refuseV2('not_a_room_json'); }
  const dir = absJsonPath.slice(0, Math.max(absJsonPath.lastIndexOf('/'), absJsonPath.lastIndexOf('\\')) + 1);
  const plateBytesByPath = new Map();
  if (json && json.views) {
    for (const name of VIEW_NAMES) {
      const p = json.views[name] && json.views[name].plate;
      if (typeof p === 'string' && p) { try { plateBytesByPath.set(p, fsMod.readFileSync(dir + p)); } catch { /* checkPlate(null) below reports it via plate_unchecked; a hard-missing file still fails the dim/size checks it can't run, caught instead by the renderer's own load failure */ } }
    }
  }
  return checkRoomJsonV2(json, plateBytesByPath);
}
