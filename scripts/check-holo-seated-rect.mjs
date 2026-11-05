// T-31 alpha.3 R3 gate (plain Node, no Electron, no window): the SEATED holo panel on the real rig (shipped VRM, room-v2 talk camera, CHEST_UP crop).
//   2b  B2: the projected rect has x1 <= 1 at 1366x768 and 1920x1080 (seated and float placement), with a control that fails for a panel pushed to the camera-right
//   2c  R3 round 2: the smallest task text is >= 11 px on screen at both window sizes (scripts/lib/holo-legible.mjs)
//   node scripts/check-holo-seated-rect.mjs [--model <file.vrm>]   (npm run check:holo-seated-rect; exit 1 on a failure, 2 on a missing model)
// New file by CoS rule A (alpha.3): these were sections 2b/2c of scripts/check-work-seated.mjs, which stays frozen. The rig set-up is the same as there.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// three's GLTFLoader decodes with createImageBitmap and fires ProgressEvent (same stubs as the other rig gates).
globalThis.self = globalThis;
globalThis.window = globalThis;
globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
globalThis.ProgressEvent = class ProgressEvent { constructor(type, init) { this.type = type; Object.assign(this, init); } };

const THREE = await import('three');
const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
const { VRMAnimationLoaderPlugin } = await import('@pixiv/three-vrm-animation');
const { clock, modelFromArgs, loadHarness, makeFreshEngine } = await import('./lib/reflex-harness.mjs');
const { GesturePlayer } = await import('../src/renderer/reflex/player.js');
const { measureSeatDropM, measureHipOffsetXZ, placeSeated, enterSeated } = await import('../src/renderer/room/seat.js');
const { FLOAT } = await import('../src/renderer/room/float-mode.js');
const {
  HoloScreen, SCREEN_OFFSET, SEATED_SCREEN_OFFSET, SEATED_PANEL_SCALE, panelSize, panelOffset, workPanelOn,
} = await import('../src/renderer/room/holo-screen.js');
const { faceCamera } = await import('../src/renderer/room/holo-screen.js');
const { coverCropRect } = await import('../src/renderer/room/camera-director.js');
const { createWorkLoop } = await import('../src/renderer/talk/work-loop.js');
const { measureHolo, MIN_ON_SCREEN_PX, STAGE_CANVAS } = await import('./lib/holo-legible.mjs');
const { makeTouchPlan, touchContact, planeDistance, onPanel } = await import('../src/renderer/talk/panel-touch.js');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
let pass = 0, fail = 0;
const ok = (cond, name, detail) => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`); } };

// Deterministic LCG, never Math.random (the repo's check convention).
function makeRandom(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 0x100000000);
}

const modelPath = modelFromArgs();
if (!fs.existsSync(modelPath)) { console.error(`usage: npm run check:work-seated -- --model <file.vrm> (missing: ${modelPath})`); process.exit(2); }

// ---------- the talk camera, exactly as the app builds it (room.json + CameraDirector's CHEST_UP crop) ----------
const roomJson = JSON.parse(read('resources-pinned/room-v2/room.json'));
const talk = roomJson.views.talk;
const t3 = talk.camera.three;
const [plateW, plateH] = talk.plateSize;
const CHEST_UP = { zoom: 1.45, anchor: { plateYFrac: 0.269, frameYFrac: 0.375 } };
const ASPECTS = [[1204, 689], [1600, 1000], [1920, 1080]];

function cameraAt(canvasW, canvasH) {
  const c = new THREE.PerspectiveCamera(t3.fov, t3.aspect, 0.05, 50);
  c.position.set(talk.camera.pos[0], talk.camera.pos[1], talk.camera.pos[2]);
  c.lookAt(new THREE.Vector3(talk.camera.target[0], talk.camera.target[1], talk.camera.target[2]));
  const plate = coverCropRect(plateW, plateH, canvasW, canvasH, CHEST_UP.zoom, 0, 0, CHEST_UP.anchor);
  const vo = t3.viewOffset, s = vo.width / plateW;
  c.setViewOffset(vo.fullWidth, vo.fullHeight, vo.x + plate.x * s, vo.y + plate.y * s, plate.w * s, plate.h * s);
  c.updateProjectionMatrix(); c.updateMatrixWorld(true);
  return c;
}
const ndcOf = (camera, p) => p.clone().project(camera);
const insideFrame = (p, margin = 0) => Math.abs(p.x) <= 1 - margin && Math.abs(p.y) <= 1 - margin;

// ---------- the real seated rig: model, seat, panel (the exact placement update() applies) ----------
const camera = cameraAt(1204, 689);
const { vrm } = await loadHarness(modelPath);
const { engine } = makeFreshEngine(vrm, camera, 11);
engine.autoIdle = false;
// The clip cache is pre-seeded (Node has no file:// fetch -- same pattern as check-motion-seated.mjs); the player must
// accept clips, so it is rebuilt against the engine's own ClipLayer instead of the gesture-only harness player.
engine.player = new GesturePlayer({ random: makeRandom(3), clipAvailable: (n) => engine.clips.has(n), now: () => clock.t });
const vrmaBuf = fs.readFileSync(path.join(ROOT, 'assets', 'clips', 'sit-idle.vrma'));
const vrmaLoader = new GLTFLoader();
vrmaLoader.register((p) => new VRMAnimationLoaderPlugin(p));
const vrmaGltf = await vrmaLoader.parseAsync(vrmaBuf.buffer.slice(vrmaBuf.byteOffset, vrmaBuf.byteOffset + vrmaBuf.byteLength), '');
engine.clips.setAvailable([{ name: 'sit-idle', url: 'unused (cache pre-seeded, see above)' }]);
engine.clips.cache.set('sit-idle', Promise.resolve({ kind: 'vrma', data: vrmaGltf.userData.vrmAnimations[0] }));

const scene = new THREE.Scene();
scene.add(vrm.scene);
const seat = talk.zumi_seat;
const dropM = await measureSeatDropM(engine);
const hipOffset = measureHipOffsetXZ(engine);
placeSeated(engine, seat, dropM, hipOffset);
await enterSeated(engine, 'sit-idle');
clock.t = 1_000_000;
for (let i = 0; i < 90; i++) { clock.t += 16; engine.update(0.016); } // settle the seated clip envelope
vrm.scene.updateMatrixWorld(true);
ok(dropM != null, 'rig: the sit-idle drop measured and Zumi is seated on the talk seat', { dropM });

// The panel proto: the REAL HoloScreen projection/touch methods, positioned exactly as update() does for 'seated'.
const holo = Object.create(HoloScreen.prototype);
holo.on = true; holo.placement = 'seated'; holo.P = FLOAT; holo.camera = camera; holo.engine = engine; holo._v = new THREE.Vector3();
holo.group = new THREE.Group();
const seatedSize = panelSize('seated', FLOAT);
holo.mesh = new THREE.Mesh(new THREE.PlaneGeometry(seatedSize.w, seatedSize.h), new THREE.MeshBasicMaterial());
holo.halo = new THREE.Mesh(new THREE.PlaneGeometry(seatedSize.w * 1.4, seatedSize.h * 1.4), new THREE.MeshBasicMaterial());
holo.group.add(holo.mesh); holo.group.add(holo.halo);
scene.add(holo.group);
function placeSeatedPanel() {
  const hips = engine.rig.hipsNode.getWorldPosition(new THREE.Vector3());
  const o = panelOffset('seated', FLOAT);
  holo.group.position.copy(hips).add(new THREE.Vector3(o[0], o[1], o[2]).applyQuaternion(vrm.scene.getWorldQuaternion(new THREE.Quaternion())));
  faceCamera(holo.group, camera); // update()'s orientation since alpha.10
  holo.group.updateMatrixWorld(true);
}
placeSeatedPanel();

// ---------- 2b. T-31 alpha.3 B2: no right-edge overshoot at the two sizes the owner uses (1366x768, 1920x1080) ----------
// The owner saw the panel clipped at the right edge. This is the MEASURED half of that claim: the projected rect of the
// panel under the CHEST_UP talk crop (seated placement as update() applies it, and the float placement for reference)
// must have x1 <= 1. A control proves the assertion can fail: the same panel mirrored to the camera-RIGHT side clips.
{
  const SIZES = [[1366, 768], [1920, 1080]];
  const rectFor = (mode, size, mirrorX = 1) => {
    const g = new THREE.Group();
    const sz = panelSize(mode, FLOAT);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(sz.w, sz.h), new THREE.MeshBasicMaterial());
    g.add(mesh); scene.add(g);
    const hips = engine.rig.hipsNode.getWorldPosition(new THREE.Vector3());
    const o = panelOffset(mode, FLOAT);
    g.position.copy(hips).add(new THREE.Vector3(o[0] * mirrorX, o[1], o[2]).applyQuaternion(vrm.scene.getWorldQuaternion(new THREE.Quaternion())));
    const cam = cameraAt(size[0], size[1]);
    faceCamera(g, cam); // update()'s orientation since alpha.10
    g.updateMatrixWorld(true);
    // screenRect() answers null for a panel fully outside the frame; for this gate that is also "clipped", so project directly.
    const hw = sz.w / 2, hh = sz.h / 2;
    let x0 = Infinity, x1 = -Infinity;
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const v = new THREE.Vector3(sx * hw, sy * hh, 0).applyMatrix4(mesh.matrixWorld).project(cam);
      x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x);
    }
    scene.remove(g); mesh.geometry.dispose();
    return { x0: +x0.toFixed(3), x1: +x1.toFixed(3) };
  };
  const seatedRects = {}, floatRects = {};
  let seatedOk = true, floatOk = true;
  for (const size of SIZES) {
    const key = `${size[0]}x${size[1]}`;
    seatedRects[key] = rectFor('seated', size); floatRects[key] = rectFor('float', size);
    if (!(seatedRects[key].x1 <= 1)) seatedOk = false;
    if (!(floatRects[key].x1 <= 1)) floatOk = false;
  }
  console.log(`  B2 measured CHEST_UP rects (NDC x0..x1): seated ${JSON.stringify(Object.fromEntries(Object.entries(seatedRects).map(([k, r]) => [k, [r.x0, r.x1]])))}, float ${JSON.stringify(Object.fromEntries(Object.entries(floatRects).map(([k, r]) => [k, [r.x0, r.x1]])))}`);
  ok(seatedOk, 'B2: the SEATED panel projected rect has x1 <= 1 under CHEST_UP at 1366x768 and 1920x1080', seatedRects);
  ok(floatOk, 'B2: the FLOAT panel placement projected under the same crop has x1 <= 1 at 1366x768 and 1920x1080', floatRects);
  const control = rectFor('seated', [1920, 1080], -3);
  ok(control.x1 > 1, 'B2 control: the same assertion DOES fail for a panel pushed out to the camera-right side (offset x mirrored and tripled, x1 > 1), so a pass above is a measurement', control);
  // ---- 2c. R3 round 2: the seated panel's text is >= 11 px ON SCREEN at both window sizes (REVIEW-OPUS), measured on the stage canvas of each window ----
  for (const [win, stage] of Object.entries(STAGE_CANVAS)) {
    const r = rectFor('seated', stage);
    const cssW = (r.x1 - r.x0) / 2 * stage[0];
    const m = measureHolo(HoloScreen, FLOAT, cssW);
    ok(m.liveOnScreen >= MIN_ON_SCREEN_PX, `R3 legible: seated ${win}: the smallest task text is >= ${MIN_ON_SCREEN_PX} px on screen (panel ${m.cssW} px wide, ${m.layout || 'no layout'}, ${m.liveOnScreen.toFixed(1)} px)`, m.live.map((t) => `${t.px}:${t.s}`));
    ok(m.idleOnScreen >= MIN_ON_SCREEN_PX, `R3 legible: seated ${win}: NO LIVE TASK is >= ${MIN_ON_SCREEN_PX} px on screen (${m.idleOnScreen.toFixed(1)} px)`, m.idle.map((t) => `${t.px}:${t.s}`));
  }
}


console.log(`\ncheck:holo-seated-rect ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
