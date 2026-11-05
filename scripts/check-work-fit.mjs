// Work-view fit gate (owner QC: "model vẫn hơi bé so với ghế và có vài chi tiết 3D bị lòi ra khỏi ghế ko đúng
// vật lý lắm" -- the avatar reads too small next to the painted chair, with parts poking outside it). Renders
// the REAL production pipeline's WORK view at frame 300 (same harness as render-camera-views.mjs: room-loader-
// v2.js, CameraDirector, seat.js, driven headless in Chromium), then checks the avatar-only silhouette against
// two authored, camera-independent references:
//
//   1. views.<view>.allowed_region (room.json, plate pixel coords, src/main/room-check.mjs's checkAllowedRegion):
//      the union of where avatar pixels may legitimately appear -- the painted chair/desk silhouette plus the
//      zone above the chair back where the head/shoulders/hair may show. Any avatar pixel OUTSIDE this union is
//      a defect (a leg/boot poking past the chair, an arm floating off the desk, ...).
//   2. the chair's own armrest occluders (occluders.glb, loaded by the real pipeline, found by matching the
//      occluder's own node name -- never hand re-authored): any avatar pixel INSIDE an armrest's projected 2D
//      footprint is necessarily rendered "in front of" it (the occluder's depth-only write would otherwise have
//      hidden a pixel truly behind it) -- a forearm/hand crossing the armrest instead of resting on/behind it.
//
// Also reports shoulder-width / chair-back-width (coordinator addendum, 2026-10-06): the mask tests above
// cannot catch a uniformly-too-small avatar that still stays fully inside allowed_region, so this measures the
// avatar's own rendered silhouette width at shoulder height against the chair backrest occluder's projected
// width at that same row, both in plate pixels -- the SAME bone pair (leftUpperArm/rightUpperArm) rig.js's own
// shoulderWidth already uses, so "shoulder height" means the same thing here as everywhere else in this app.
//
//   node scripts/check-work-fit.mjs [--model <file.vrm>] [--room <dir with room.json>] [--view work] [--width 1920] [--height 1200] [--out <dir>] [--tag <prefix>]
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { checkRoomJsonFile } from '../src/main/room-check.mjs';
import { ownerPath } from './lib/owner-paths.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const arg = (name, def = null) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : def; };
// default = the shipped default avatar (PIN-MANIFEST); the old zumi-v3.1.vrm default is superseded and its hair pokes 132 px outside allowed_region
const modelPath = path.resolve(arg('model', createRequire(import.meta.url)('./lib/default-vrm.cjs').resolveSource()));
const roomDir = path.resolve(arg('room', ownerPath('roomV2Dir', 'local/room-v2')));
const viewName = arg('view', 'work');
const outDir = arg('out') ? path.resolve(arg('out')) : null;
const tag = arg('tag', '');
const W = Number(arg('width', 1920)), H = Number(arg('height', 1200));

const roomJsonPath = path.join(roomDir, 'room.json');
if (!fs.existsSync(roomJsonPath)) { console.error(`missing room.json in ${roomDir}`); process.exit(2); }

// ---------- 1. the authored reference data, through the SAME checker the app itself uses (never hand-reparsed) ----------
const checked = checkRoomJsonFile(roomJsonPath);
if (!checked.ok) { console.error('room.json does not pass checkRoomJsonFile:', JSON.stringify(checked.refused)); process.exit(2); }
const view = checked.views[viewName];
if (!view) { console.error(`no such view: ${viewName}`); process.exit(2); }
const allowedRegion = view.allowed_region; // array of polygons, [x,y] plate-pixel points -- [] means "not authored yet"
if (!allowedRegion.length) console.error(`WARNING: views.${viewName}.allowed_region is empty -- every avatar pixel will count as "outside" (author it first)`);
const seatCushionLine = view.seat_cushion_line; // [[x1,y1],[x2,y2]] plate pixels, or null -- not authored yet
if (!seatCushionLine) console.error(`WARNING: views.${viewName}.seat_cushion_line is not authored -- the seat-contact check is skipped`);

const PW_SOURCE = ownerPath('playwrightCore', 'node_modules/playwright-core');
if (!fs.existsSync(PW_SOURCE)) { console.error(`SKIP: no vendored playwright-core at ${PW_SOURCE} and installing one is not allowed here`); process.exit(0); }
const { chromium } = createRequire(path.join(PW_SOURCE, 'package.json'))(PW_SOURCE);

const PLAYER_HTML = `<!doctype html>
<html><head><meta charset="utf-8"></head><body>
<script type="importmap">
{"imports":{"three":"/nm/three/build/three.module.js","three/addons/":"/nm/three/examples/jsm/","@pixiv/three-vrm":"/nm/@pixiv/three-vrm/lib/three-vrm.module.js","@pixiv/three-vrm-animation":"/nm/@pixiv/three-vrm-animation/lib/three-vrm-animation.module.js"}}
</script></head><body>
<script type="module">
let vclock = 1e6;
performance.now = () => vclock;

window.setup = async function () {
  const THREE = await import('three');
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const { VRMLoaderPlugin } = await import('@pixiv/three-vrm');
  const { prepareVrm } = await import('/renderer/model-facing.js');
  const { ReflexEngine, ClipLayer, Catalog } = await import('/renderer/reflex/index.js');
  const { loadRoomV2 } = await import('/renderer/room/room-loader-v2.js');
  const { CameraDirector } = await import('/renderer/room/camera-director.js');
  const { measureSeatDropM, measureHipOffsetXZ, placeSeated, enterSeated } = await import('/renderer/room/seat.js');

  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: true });
  renderer.setSize(${W}, ${H}); renderer.setPixelRatio(1);
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  const key = new THREE.DirectionalLight(0xffffff, Math.PI * 0.95); key.position.set(0.6, 1.4, 1.6); scene.add(key);
  const rim = new THREE.DirectionalLight(0xbcc8ff, 1.1); rim.position.set(-1.2, 1.2, -1.5); scene.add(rim);
  const ambient = new THREE.AmbientLight(0xffffff, 0.55); scene.add(ambient);
  const defaultLights = [key, rim, ambient];

  const camera = new THREE.PerspectiveCamera(28, ${W} / ${H}, 0.05, 50);
  const plateCanvas = document.createElement('canvas'); plateCanvas.width = ${W}; plateCanvas.height = ${H};
  const plateCtx = plateCanvas.getContext('2d');

  const loader = new GLTFLoader(); loader.register((p) => new VRMLoaderPlugin(p));
  const gltf = await loader.loadAsync('/vrm/model.vrm');
  const vrm = gltf.userData.vrm;
  prepareVrm(gltf, vrm); // the app's load path: clean-up + the VRM 0.x flip + the base-orientation capture Rig's IK needs
  scene.add(vrm.scene);

  const catalog = await Catalog.load('/renderer/reflex/gestures/');
  const engine = new ReflexEngine({ catalog, clips: new ClipLayer(), random: () => 0.5 });
  engine.clips.setAvailable([{ name: 'sit-idle', url: '/clips/sit-idle.vrma' }, { name: 'sit-work', url: '/clips/sit-work.vrma' }]);
  engine.bind(vrm, camera);
  engine.autoIdle = false;

  let seatDropM = 0;
  let hipOffsetXZ = null;
  const director = new CameraDirector({
    engine, camera, plateCtx, defaultLights,
    setLookTargets: (t) => engine.setLookTargets(t),
    placeSeat: (seat) => placeSeated(engine, seat, seatDropM, hipOffsetXZ),
    // round 7: work's own over-the-shoulder crop is now a PRODUCTION framing (camera-director.js's
    // WORK_OVER_SHOULDER), not an optional look-tuning override -- this check must match what actually
    // renders, or it is checking a picture nobody sees. allowed_region/seat_cushion_line/backrest_top_line are
    // all authored against THIS cropped output's own pixel space (still "plate pixels" -- the plate as this
    // view actually shows it, same convention as every other authored-polygon field here).
    getFramingOverride: (name) => (name === 'work' ? { overShoulder: true } : null),
  });

  const res = await fetch('/room/room.json');
  const json = await res.json();
  const room = await loadRoomV2(json, (rel) => '/room/' + rel);
  if (!room) throw new Error('loadRoomV2 returned null');
  scene.add(room.scene);

  hipOffsetXZ = measureHipOffsetXZ(engine);
  const drop = await measureSeatDropM(engine);
  if (drop != null) { seatDropM = drop; await enterSeated(engine); }
  director.setRoom(room);

  window.__state = { THREE, renderer, scene, camera, vrm, engine, director, room };
  return true;
};

// Ray-casting point-in-polygon (even-odd rule); poly = [[x,y],...].
function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}
function pointInAny(x, y, polys) { for (const p of polys) if (pointInPoly(x, y, p)) return true; return false; }

// 2D convex hull (monotone chain) of a point cloud -- used for an armrest occluder's projected vertices (a
// triangulated mesh's position buffer is NOT an ordered boundary ring, but the real armrest pads/posts are
// convex-ish planar shapes, so their hull is a safe, slightly-generous stand-in: any pixel it flags was AT
// LEAST as close to crossing the real occluder, never further).
function convexHull(points) {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

// min/max X where a (possibly non-convex) polygon's EDGES cross horizontal line y=Y -- "how wide is this shape
// at this row", the same scanline idea pointInPoly uses, generalised to a width instead of a boolean.
function scanlineWidthAtY(poly, y) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) === (yj > y)) continue; // edge does not cross this row
    const x = xi + (y - yi) * (xj - xi) / (yj - yi);
    lo = Math.min(lo, x); hi = Math.max(hi, x);
  }
  return Number.isFinite(lo) ? { minX: lo, maxX: hi } : null;
}

function projectToPixel(vec3, camera, W, H) {
  const p = vec3.clone().project(camera);
  return [(p.x * 0.5 + 0.5) * W, (1 - (p.y * 0.5 + 0.5)) * H];
}

// Seat-contact check (coordinator round 5, 2026-10-07): r4's scale/offset fix passed the allowed_region and
// armrest checks while leaving the hips floating ~15-20cm above the painted cushion, visibly IN FRONT of the
// seat/backrest occluders (at armrest height) -- those two checks only bound "has she escaped the chair's
// silhouette", not "is she actually resting ON the cushion", so a new, independent check is needed.
//
// seatCushionLine = [[x1,y1],[x2,y2]], plate pixels, hand-authored against the EMPTY plate (an intrinsic
// property of the chair, never derived from wherever the avatar currently happens to be -- that would make the
// check unable to catch the exact defect it exists to catch).
//
// What "floating" actually looks like in the avatar-only mask (found empirically, round 5): when she IS seated
// correctly, her hip/thigh is DEPTH-TESTED AWAY ENTIRELY by the seat/backrest occluders from this camera angle
// (a high-back mesh chair seen mostly from behind -- no hip pixels are visible there at all, same as the empty
// chair reference), not merely "a pixel exactly on the line" -- an earlier version of this check assumed a hip
// pixel must be found near the line and instead picked up a stray boot/forearm pixel from far outside the
// cushion's real footprint, reporting a false ~150px miss on a render that looks correct by eye. The actual
// failure mode (confirmed against the real r4 regression) is avatar pixels APPEARING in the zone between the
// armrest's own top edge and the cushion line (minus a small tolerance) -- that zone should be EMPTY (hidden
// behind the chair) for a correctly-seated pose; any avatar pixel found there is "floating in front of the
// chair instead of settled into it", exactly what the owner/coordinator saw. Absence of pixels there is PASS,
// not a skipped/inconclusive sample -- the check does not require a contact pixel to exist, only that nothing
// shows where it shouldn't.
const SEAT_CONTACT_TOL_PX = 12;
function checkSeatContact(mask, W, H, line, armrestTopY) {
  if (!line) return null;
  const [[x1, y1], [x2, y2]] = line;
  const xLo = Math.min(x1, x2), xHi = Math.max(x1, x2);
  const N = 9;
  const samples = [];
  for (let i = 0; i < N; i++) {
    const t = N === 1 ? 0 : i / (N - 1);
    const x = Math.round(xLo + t * (xHi - xLo));
    const lineY = y1 + (y2 - y1) * (x2 === x1 ? 0 : (x - x1) / (x2 - x1));
    const zoneBottom = Math.round(lineY - SEAT_CONTACT_TOL_PX); // the cushion line itself, minus tolerance -- anything above this is "not resting on the cushion"
    const zoneTop = armrestTopY != null ? Math.round(armrestTopY) : Math.max(0, zoneBottom - 300);
    let floatingTopY = null; // the HIGHEST (min-y) avatar pixel found floating in the zone, i.e. the worst offender
    for (let y = Math.max(0, zoneTop); y < zoneBottom; y++) {
      if (mask[(y * W + x) * 4 + 3] > 0) { floatingTopY = y; break; }
    }
    samples.push({ x, lineY, zoneTop, zoneBottom, floating: floatingTopY != null, floatingTopY });
  }
  const violations = samples.filter((s) => s.floating).length;
  const worstFloatY = samples.reduce((m, s) => (s.floating && (m == null || s.floatingTopY < m) ? s.floatingTopY : m), null);
  return { samples, violations, worstFloatY, tolPx: SEAT_CONTACT_TOL_PX };
}

window.analyze = async function (viewName, allowedRegion, armrestPattern, seatCushionLine, W, H) {
  const armrestMatch = new RegExp(armrestPattern, 'i');
  const { THREE, renderer, scene, camera, vrm, engine, director, room } = window.__state;
  director.jumpToView(viewName);
  // round 6: per-view seated pose (zumi_seat.pose) -- same reasoning as render-camera-views.mjs's renderView.
  const pose = (room.views[viewName].seat && room.views[viewName].seat.pose) || 'sit-idle';
  const { enterSeated } = await import('/renderer/room/seat.js');
  const dt = 1 / 60;
  // Found empirically (round 6): switching straight into a seated pose that has never been through a settle
  // loop before (this script's only call, vs. render-camera-views.mjs which always settles 'talk' -> sit-idle
  // first) leaves the arm bones at an unposed/procedural-rest state for the WHOLE 300-tick loop that follows
  // -- the clip's own snapshot is present (engine.clips.snapshot.size matches the animated bone count) but the
  // rendered arm never reaches its target. A single throwaway settle cycle in whatever pose setup() already
  // started avoids the cold-start path entirely and reproduces render-camera-views.mjs's own working order;
  // root-caused no further than that (reflex engine first-tick init, not this script's own logic) given the
  // time this task had -- noted here so a future pass can dig into ReflexEngine/ClipLayer's cold-start path.
  for (let i = 0; i < 300; i++) { vclock += dt * 1000; engine.update(dt); vrm.scene.updateMatrixWorld(true); }
  await enterSeated(engine, pose);
  for (let i = 0; i < 300; i++) { vclock += dt * 1000; engine.update(dt); vrm.scene.updateMatrixWorld(true); }
  director.drawPlate(); // registers camera.viewOffset to the active view's crop, same as render-camera-views.mjs
  renderer.render(scene, camera);

  // ---------- avatar-only alpha mask ----------
  const maskCanvas = document.createElement('canvas'); maskCanvas.width = W; maskCanvas.height = H;
  const mg = maskCanvas.getContext('2d');
  mg.drawImage(renderer.domElement, 0, 0);
  const mask = mg.getImageData(0, 0, W, H).data; // RGBA; alpha>0 = avatar visible here
  const maskDataUrl = maskCanvas.toDataURL('image/png'); // captured now -- a separate canvas builds the violation-highlight overlay below, this one is never mutated

  // ---------- armrest occluder polygons (projected from the REAL loaded mesh, not re-authored) ----------
  const activeOccluders = room.views[viewName].occludersGroup;
  const armrestHulls = [];
  for (const mesh of activeOccluders.children) {
    if (!armrestMatch.test(mesh.name)) continue;
    const posAttr = mesh.geometry.getAttribute('position');
    const pts2d = [];
    const v = new THREE.Vector3();
    for (let i = 0; i < posAttr.count; i++) {
      v.fromBufferAttribute(posAttr, i).applyMatrix4(mesh.matrixWorld);
      pts2d.push(projectToPixel(v, camera, W, H));
    }
    if (pts2d.length >= 3) armrestHulls.push({ name: mesh.name, hull: convexHull(pts2d) });
  }
  const armrestTopY = armrestHulls.length ? Math.min(...armrestHulls.flatMap((h) => h.hull.map((p) => p[1]))) : null;

  // ---------- pixel sweep: outside-allowed-region count + armrest-violation count ----------
  let outsideCount = 0, armrestCount = 0, avatarPixels = 0;
  let outBox = null, armBox = null; // [minX,minY,maxX,maxY] of violating pixels, for locating a residual by eye
  const grow = (box, x, y) => (box ? [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x), Math.max(box[3], y)] : [x, y, x, y]);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const a = mask[(y * W + x) * 4 + 3];
      if (a === 0) continue;
      avatarPixels++;
      if (allowedRegion.length && !pointInAny(x + 0.5, y + 0.5, allowedRegion)) { outsideCount++; outBox = grow(outBox, x, y); }
      for (const h of armrestHulls) {
        if (pointInPoly(x + 0.5, y + 0.5, h.hull)) {
          armrestCount++; armBox = grow(armBox, x, y);
          h.count = (h.count || 0) + 1; h.box = grow(h.box, x, y);
          break;
        }
      }
    }
  }

  // ---------- shoulder width vs chair-back width, in plate pixels, at shoulder height (rig.js's own bone pair) ----------
  const nb = (n) => vrm.humanoid.getNormalizedBoneNode(n);
  const luPx = projectToPixel(nb('leftUpperArm').getWorldPosition(new THREE.Vector3()), camera, W, H);
  const ruPx = projectToPixel(nb('rightUpperArm').getWorldPosition(new THREE.Vector3()), camera, W, H);
  const shoulderRowY = (luPx[1] + ruPx[1]) / 2;
  // true RENDERED shoulder width (silhouette extent at that row), not the bone-to-bone distance (bones sit
  // inside the body; clothing/the actual drawn edge is what the owner is comparing by eye) -- scan the mask row.
  let shL = Infinity, shR = -Infinity;
  const row = Math.round(shoulderRowY);
  for (let x = 0; x < W; x++) { if (mask[(row * W + x) * 4 + 3] > 0) { shL = Math.min(shL, x); shR = Math.max(shR, x); } }
  const shoulderWidthPx = Number.isFinite(shL) ? shR - shL : null;

  let backW = null;
  const backrest = activeOccluders.children.find((m) => /backrest/i.test(m.name));
  if (backrest) {
    const posAttr = backrest.geometry.getAttribute('position');
    const v = new THREE.Vector3();
    const pts2d = [];
    for (let i = 0; i < posAttr.count; i++) { v.fromBufferAttribute(posAttr, i).applyMatrix4(backrest.matrixWorld); pts2d.push(projectToPixel(v, camera, W, H)); }
    const hull = convexHull(pts2d);
    let w = scanlineWidthAtY(hull, shoulderRowY);
    if (!w) { // shoulder row is above/below the backrest entirely -- fall back to the hull's own widest row
      let best = null;
      for (const [, y] of hull) { const ww = scanlineWidthAtY(hull, y); if (ww && (!best || ww.maxX - ww.minX > best.maxX - best.minX)) best = ww; }
      w = best;
    }
    if (w) backW = { minX: w.minX, maxX: w.maxX, width: w.maxX - w.minX };
  }

  // ---------- seat contact (coordinator round 5): is she resting ON the cushion, not floating above it ----------
  const seatContact = checkSeatContact(mask, W, H, seatCushionLine, armrestTopY);

  // ---------- diagnostic overlay: the full composited render + allowed_region (green) / armrest hulls (red) /
  // shoulder+backrest marker lines (cyan/yellow), and any OUT-OF-REGION avatar pixels tinted magenta. Used both
  // to author allowed_region by eye and as the self-QC crop source -- never consumed by the app. ----------
  const out = document.createElement('canvas'); out.width = W; out.height = H;
  const og = out.getContext('2d');
  og.drawImage(director.plateCtx.canvas, 0, 0);
  og.drawImage(renderer.domElement, 0, 0);
  if (allowedRegion.length || armrestHulls.length) {
    const violationCanvas = document.createElement('canvas'); violationCanvas.width = W; violationCanvas.height = H;
    const vg = violationCanvas.getContext('2d');
    const violation = vg.createImageData(W, H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        if (mask[i + 3] === 0) continue;
        const bad = (allowedRegion.length && !pointInAny(x + 0.5, y + 0.5, allowedRegion)) || armrestHulls.some(({ hull }) => pointInPoly(x + 0.5, y + 0.5, hull));
        if (bad) { violation.data[i] = 255; violation.data[i + 1] = 0; violation.data[i + 2] = 255; violation.data[i + 3] = 220; }
      }
    }
    vg.putImageData(violation, 0, 0);
    og.drawImage(violationCanvas, 0, 0);
  }
  og.lineWidth = 2;
  og.strokeStyle = '#00ff66';
  for (const poly of allowedRegion) { og.beginPath(); poly.forEach(([x, y], i) => og[i ? 'lineTo' : 'moveTo'](x, y)); og.closePath(); og.stroke(); }
  og.strokeStyle = '#ff2222';
  for (const { hull } of armrestHulls) { og.beginPath(); hull.forEach(([x, y], i) => og[i ? 'lineTo' : 'moveTo'](x, y)); og.closePath(); og.stroke(); }
  if (shoulderWidthPx != null) {
    og.strokeStyle = '#00ddff'; og.beginPath(); og.moveTo(shL, row); og.lineTo(shR, row); og.stroke();
    og.fillStyle = '#00ddff'; og.fillRect(shL - 2, row - 8, 4, 16); og.fillRect(shR - 2, row - 8, 4, 16);
  }
  if (backW) {
    og.strokeStyle = '#ffdd00'; og.beginPath(); og.moveTo(backW.minX, shoulderRowY); og.lineTo(backW.maxX, shoulderRowY); og.stroke();
    og.fillStyle = '#ffdd00'; og.fillRect(backW.minX - 2, shoulderRowY - 8, 4, 16); og.fillRect(backW.maxX - 2, shoulderRowY - 8, 4, 16);
  }
  if (seatCushionLine) {
    const [[lx1, ly1], [lx2, ly2]] = seatCushionLine;
    og.strokeStyle = '#ff8800'; og.lineWidth = 3; og.beginPath(); og.moveTo(lx1, ly1); og.lineTo(lx2, ly2); og.stroke(); og.lineWidth = 2;
    if (seatContact) {
      for (const s of seatContact.samples) {
        og.strokeStyle = s.floating ? '#ff2222' : '#22ff22';
        og.beginPath(); og.moveTo(s.x, s.zoneTop); og.lineTo(s.x, s.zoneBottom); og.stroke();
        if (s.floating) { og.fillStyle = '#ff2222'; og.fillRect(s.x - 3, s.floatingTopY - 3, 6, 6); }
      }
    }
  }

  return {
    avatarPixels, outsideCount, outsideBox: outBox, armrestCount, armrestBox: armBox, armrestHullNames: armrestHulls.map((h) => h.name),
    armrestPerHull: armrestHulls.map((h) => ({ name: h.name, count: h.count || 0, box: h.box || null })),
    shoulderRowY, shoulderWidthPx, shoulderLeftRightPx: Number.isFinite(shL) ? [shL, shR] : null,
    backrestWidthPx: backW,
    armrestTopY, seatContact,
    maskDataUrl,
    overlayDataUrl: out.toDataURL('image/png'),
  };
};
window.ready = true;
</script></body></html>`;

const ROOTS = {
  '/nm/': path.join(ROOT, 'node_modules') + path.sep,
  '/renderer/': path.join(ROOT, 'src', 'renderer') + path.sep,
  '/scripts/': path.join(ROOT, 'scripts') + path.sep,
  '/vrm/model.vrm': modelPath,
  '/clips/sit-idle.vrma': path.join(ROOT, 'assets', 'clips', 'sit-idle.vrma'),
  '/clips/sit-work.vrma': path.join(ROOT, 'assets', 'clips', 'sit-work.vrma'),
  '/room/': roomDir + path.sep,
};
const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.vrm': 'application/octet-stream', '.vrma': 'application/octet-stream', '.glb': 'model/gltf-binary', '.png': 'image/png' };
const srv = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/' || url === '/player.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(PLAYER_HTML); }
  if (ROOTS[url]) { return fs.readFile(ROOTS[url], (e, buf) => { if (e) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'content-type': TYPES[path.extname(ROOTS[url])] || 'application/octet-stream' }); res.end(buf); }); }
  const pre = Object.keys(ROOTS).find((p) => p.endsWith('/') && url.startsWith(p));
  if (!pre) { res.writeHead(404); return res.end(); }
  const file = ROOTS[pre] + url.slice(pre.length);
  fs.readFile(file, (e, buf) => { if (e) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' }); res.end(buf); });
}).listen(0, '127.0.0.1');
await new Promise((r) => srv.once('listening', r));
const port = srv.address().port;

let browser;
let pass = true;
try {
  // Test-only: ZUMI_PW_EXECUTABLE points at an installed chromium(-headless-shell) when the vendored playwright's pinned revision is absent.
  browser = await chromium.launch({ headless: true, args: ['--use-gl=swiftshader'], timeout: 60000, ...(process.env.ZUMI_PW_EXECUTABLE ? { executablePath: process.env.ZUMI_PW_EXECUTABLE } : {}) });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('pageerror', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.error('console error:', m.text()); });
  await page.goto(`http://127.0.0.1:${port}/player.html`);
  await page.waitForFunction(() => window.ready === true, null, { timeout: 30000 });
  await page.evaluate(() => window.setup());
  // armrest occluder nodes are named occ_<view>_<name> (room-loader-v2.js re-parents them, keeping the glb's own
  // mesh name) -- match "armrest" anywhere in the name so near/far-side variants are both caught.
  //
  // NOTE on occ_work_backrest_frame_ext (coordinator round 6 #2): tried folding this into the SAME "0 pixels
  // in the hull" gate as the armrest and reverted it -- unlike an armrest (nothing should ever rest in front
  // of it), she is SUPPOSED to sit with her back/torso in front of most of the backrest frame's own depth
  // (that's what "sitting in the chair" looks like), so a convex-hull-of-the-whole-box "0 pixels" gate flags
  // >30,000 legitimate torso pixels as violations -- a check that produces a bigger false-positive than the
  // defect it was meant to catch is worse than no check (misleads instead of informing). The occluder mesh
  // itself is still live in the real render (it physically hides what's truly behind it, confirmed by eye);
  // a real frame-specific gate would need the frame's actual thin visible boundary, not its full depth box --
  // left as a follow-up, not shipped as a misleading number this round.
  const r = await page.evaluate(([v, region, pat, line, w, h]) => window.analyze(v, region, pat, line, w, h), [viewName, allowedRegion, 'armrest', seatCushionLine, W, H]);

  console.log(`view=${viewName} plate=${W}x${H}`);
  console.log(`avatar pixels: ${r.avatarPixels}`);
  console.log(`outside allowed_region: ${r.outsideCount} (${allowedRegion.length} polygon(s) authored)${r.outsideBox ? ` bbox=[${r.outsideBox.join(',')}]` : ''}`);
  console.log(`inside armrest hull(s) [${r.armrestHullNames.join(', ') || 'none found'}]: ${r.armrestCount}${r.armrestBox ? ` bbox=[${r.armrestBox.join(',')}]` : ''}`);
  for (const h of r.armrestPerHull || []) console.log(`  ${h.name}: ${h.count || 0}${h.box ? ` bbox=[${h.box.join(',')}]` : ''}`);
  const ratio = r.shoulderWidthPx != null && r.backrestWidthPx ? r.shoulderWidthPx / r.backrestWidthPx.width : null;
  console.log(`shoulder width: ${r.shoulderWidthPx}px (row y=${Math.round(r.shoulderRowY)}) | backrest width at that row: ${r.backrestWidthPx ? r.backrestWidthPx.width.toFixed(1) : 'n/a'}px | ratio: ${ratio != null ? ratio.toFixed(3) : 'n/a'}`);
  if (r.seatContact) {
    const sc = r.seatContact;
    console.log(`seat contact: ${sc.samples.length} sample column(s) scanned between armrest-top (y=${r.armrestTopY != null ? Math.round(r.armrestTopY) : 'n/a'}) and cushion-line-${sc.tolPx}px; ${sc.violations} column(s) have an avatar pixel floating in that zone${sc.worstFloatY != null ? ` (highest at y=${sc.worstFloatY})` : ''}`);
  }

  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    const maskFile = path.join(outDir, `${tag}${viewName}-mask.png`);
    fs.writeFileSync(maskFile, Buffer.from(r.maskDataUrl.split(',')[1], 'base64'));
    const overlayFile = path.join(outDir, `${tag}${viewName}-overlay.png`);
    fs.writeFileSync(overlayFile, Buffer.from(r.overlayDataUrl.split(',')[1], 'base64'));
    fs.writeFileSync(path.join(outDir, `${tag}${viewName}-fit.json`), JSON.stringify(r, (k, v2) => (k === 'maskDataUrl' || k === 'overlayDataUrl' ? undefined : v2), 1));
    console.log(`wrote ${maskFile}`);
    console.log(`wrote ${overlayFile}`);
  }

  if (allowedRegion.length && r.outsideCount > 0) { console.log(`FAIL: ${r.outsideCount} avatar pixel(s) outside the authored allowed_region`); pass = false; }
  // round 7: no longer a pass/fail gate for work -- the new sit-work pose DELIBERATELY rests the forearm ON the
  // armrest while reaching for the keyboard (the brief's own "hands rest on/just above the keys"), so armrest-
  // hull pixels are now the expected, correct picture, not a crossing defect. Reported for visibility only.
  if (r.armrestCount > 0) console.log(`INFO: ${r.armrestCount} avatar pixel(s) inside an armrest occluder's footprint (forearm resting on the armrest -- expected with the sit-work pose, not gated)`);
  if (!allowedRegion.length) { console.log('FAIL: views.' + viewName + '.allowed_region is not authored -- nothing was actually checked'); pass = false; }
  if (seatCushionLine && r.seatContact) {
    if (r.seatContact.violations > 0) { console.log(`FAIL: ${r.seatContact.violations} column(s) have an avatar pixel floating between the armrest top and the cushion line -- hips/thighs not resting on the cushion`); pass = false; }
  } else if (!seatCushionLine) { console.log('SKIP: views.' + viewName + '.seat_cushion_line is not authored -- round 7\'s tight over-the-shoulder crop has no visible cushion, so this check no longer applies to work (left null, not a failure)'); }
} catch (e) {
  console.error('FAILED:', e.stack || e.message);
  pass = false;
} finally {
  if (browser) await browser.close().catch(() => {});
  srv.close();
}
console.log(pass ? 'PASS check:work-fit' : 'FAIL check:work-fit');
process.exitCode = pass ? 0 : 1;
