// Seated work-panel gate (T-31 C1 step 11, DIAG 20-10 §5 row 11): plain Node, no Electron, no window, no network.
// Proves the C1 beats also play in the SEATED talk view, using the repo's own frame maths (room.json's talk camera +
// CameraDirector's CHEST_UP cover-crop) and the REAL seated rig on the shipped VRM:
//   1. placement        the seated panel is SMALLER than the float one and BESIDE her (alpha.10: out to her right,
//                       barely in front of her, not at her hand); the float placement/size are unchanged
//                       (a regression guard on SCREEN_OFFSET)
//   2. inside the frame seated + working: the panel's projected NDC rect is fully inside the chest-up frame at every
//                       checked aspect, left of centre (to the side), and screenRect()/screenNdc() agree
//   3. flat + upright  alpha.10 (owner 31-10): the panel is square to the camera, so its
//                       projection is an axis-aligned rectangle (no tilt, no skew) at every aspect, and it stays
//                       clear of her right arm on screen
//   4. the real arm    seated + working: the REAL engine + rig + SHIPPED work loop over a simulated 60 s play the
//                       read and look-at-anh beats only; no contact is ever armed, the upper arm stays in her lap
//                       pose (< 15 deg) and her right fingertip never comes within 10 cm of the panel
//   5. not working     seated + not working: the panel is hidden (workPanelOn false), the loop is silent, and the
//                       app's working sink only toggles the PANEL -- the chair/occluders/pose/float path is untouched
//                       (source guard), so the shipped non-working seated look cannot change
//   Usage: npm run check:work-seated [-- --model <file.vrm>]   (exit 1 on any failure, 2 on a missing model)
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
  HoloScreen, SCREEN_OFFSET, SEATED_SCREEN_OFFSET, SEATED_PANEL_SCALE, panelSize, panelOffset, workPanelOn, faceCamera,
} = await import('../src/renderer/room/holo-screen.js');
const { coverCropRect } = await import('../src/renderer/room/camera-director.js');
const { createWorkLoop } = await import('../src/renderer/talk/work-loop.js');
const { planeDistance } = await import('../src/renderer/talk/panel-touch.js');

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

// ---------- 1. the placement: smaller, beside her; float untouched ----------
{
  const seated = panelSize('seated', FLOAT), floatSize = panelSize('float', FLOAT);
  ok(SEATED_PANEL_SCALE < FLOAT.scale && seated.w < floatSize.w && seated.h < floatSize.h,
    'placement: the seated panel is SMALLER than the float panel', { seated: seated.w, float: floatSize.w, floatScale: FLOAT.scale });
  ok(SEATED_SCREEN_OFFSET[2] >= 0 && SEATED_SCREEN_OFFSET[2] <= 0.2 && SEATED_SCREEN_OFFSET[2] < SCREEN_OFFSET[2] * FLOAT.scale,
    'placement (alpha.10): the seated panel is BESIDE her, barely in front (z <= 0.2 m), not out at her hand', { seatedZ: SEATED_SCREEN_OFFSET[2], floatZ: SCREEN_OFFSET[2] * FLOAT.scale });
  ok(Math.abs(SEATED_SCREEN_OFFSET[0]) >= 0.45 && SEATED_SCREEN_OFFSET[0] < 0,
    'placement: the seated panel is TO THE SIDE (out to her right, camera-left, where the float panel lives too)', SEATED_SCREEN_OFFSET);
  ok(SEATED_SCREEN_OFFSET[1] > 0 && SEATED_SCREEN_OFFSET[1] < 0.6,
    'placement: the seated panel is at chest height above the hips (inside the chest-up crop)', SEATED_SCREEN_OFFSET);
  const floatOff = panelOffset('float', FLOAT);
  ok(floatOff.every((v, i) => Math.abs(v - SCREEN_OFFSET[i] * FLOAT.scale) < 1e-12),
    'float: the pilot placement is unchanged (SCREEN_OFFSET * FLOAT.scale, one source of truth)', { floatOff, SCREEN_OFFSET });
  ok(floatSize.w === 0.42 * FLOAT.scale && floatSize.h === 0.26 * FLOAT.scale,
    'float: the pilot panel size is unchanged (0.42 x 0.26 m at the float scale)', floatSize);

  ok(workPanelOn('float', false) === true && workPanelOn('float', true) === true,
    'rule: float always has the panel (unchanged since the pilot)');
  ok(workPanelOn('seated', true) === true, 'rule: seated + working -> the panel is up (step 11 parity)');
  ok(workPanelOn('seated', false) === false, 'rule: seated + not working -> the panel is hidden (the shipped look)');
  ok(workPanelOn(undefined, false) === false && workPanelOn('', false) === false,
    'rule: an unknown/empty stage mode is treated as seated, never as float');
}

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
  faceCamera(holo.group, holo.camera); // update()'s own orientation (alpha.10)
  holo.group.updateMatrixWorld(true);
}
placeSeatedPanel();

// ---------- 2. the projected panel rect is INSIDE the chest-up frame at every aspect ----------
{
  let worst = 0, leftOfCentre = true, centred = true;
  const rects = {};
  for (const [cw, ch] of ASPECTS) {
    holo.camera = cameraAt(cw, ch);
    placeSeatedPanel(); // square to THIS camera, as update() does every frame
    const r = holo.screenRect();
    const c = holo.screenNdc();
    if (!r) { ok(false, `frame ${cw}x${ch}: the panel projects to a rect`); continue; }
    rects[`${cw}x${ch}`] = { x0: +r.x0.toFixed(3), x1: +r.x1.toFixed(3), y0: +r.y0.toFixed(3), y1: +r.y1.toFixed(3) };
    const edge = Math.max(Math.abs(r.x0), Math.abs(r.x1), Math.abs(r.y0), Math.abs(r.y1));
    worst = Math.max(worst, edge);
    if (!(r.x0 > -1 && r.x1 < 1 && r.y0 > -1 && r.y1 < 1)) leftOfCentre = false; // outside the frame at all
    if (!(r.x1 < 0)) leftOfCentre = false; // camera-left (to the side), never across her face
    // The seated panel is closer to the camera and turned toward her head, so perspective skews the NDC bounding
    // box's centre by a few 1e-3 from the projected centre (the float check's near-frontal panel stays under 1e-3).
    // 2e-2 still proves "same point on screen", and screenNdc must also land INSIDE the rect (the read scan needs it).
    const dx = (r.x0 + r.x1) / 2 - c.x, dy = (r.y0 + r.y1) / 2 - c.y;
    if (Math.abs(dx) > 2e-2 || Math.abs(dy) > 2e-2 || !(c.x > r.x0 && c.x < r.x1 && c.y > r.y0 && c.y < r.y1)) centred = false;
  }
  ok(leftOfCentre, 'frame: the seated panel rect is fully INSIDE the frame and camera-left (to the side) at every aspect', rects);
  ok(worst <= 0.95, 'frame: the whole panel keeps a margin to every frame edge (worst |NDC| <= 0.95)', { worst: +worst.toFixed(3), rects });
  ok(centred, 'frame: screenRect() is centred on screenNdc() (one source of truth)', rects);
}
holo.camera = camera;
placeSeatedPanel();

// ---------- 3. flat + upright: an axis-aligned rectangle on screen, clear of her arm ----------
{
  let maxSkew = 0, minArmGap = Infinity;
  const per = {};
  for (const [cw, ch] of ASPECTS) {
    const cam = cameraAt(cw, ch);
    holo.camera = cam; placeSeatedPanel();
    const p = holo.mesh.geometry.parameters, hw = p.width / 2, hh = p.height / 2;
    const [bl, br, tr, tl] = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => new THREE.Vector3(x, y, 0).applyMatrix4(holo.mesh.matrixWorld).project(cam));
    // pixel-space skew: the top and bottom edges level, the left and right edges plumb
    const px = (v) => [v.x * cw / 2, v.y * ch / 2];
    const [BL, BR, TR, TL] = [bl, br, tr, tl].map(px);
    const skew = Math.max(Math.abs(TL[1] - TR[1]), Math.abs(BL[1] - BR[1]), Math.abs(TL[0] - BL[0]), Math.abs(TR[0] - BR[0]));
    maxSkew = Math.max(maxSkew, skew);
    const r = holo.screenRect();
    let armX = Infinity;
    for (const bone of ['rightUpperArm', 'rightLowerArm', 'rightHand']) armX = Math.min(armX, vrm.humanoid.getNormalizedBoneNode(bone).getWorldPosition(new THREE.Vector3()).project(cam).x);
    const gapPx = (armX - r.x1) * cw / 2;
    minArmGap = Math.min(minArmGap, gapPx);
    per[`${cw}x${ch}`] = { skewPx: +skew.toFixed(3), panelRightNdc: +r.x1.toFixed(3), armNdc: +armX.toFixed(3), gapPx: Math.round(gapPx) };
  }
  ok(maxSkew < 0.5, 'flat: the seated panel projects as an upright, unskewed rectangle at every aspect (corner offsets < 0.5 px)', per);
  ok(minArmGap >= 60, 'beside: the panel ends >= 60 px left of her right arm/hand bones at every aspect (not held, not at her hand)', per);
  const holoSrc = read('src/renderer/room/holo-screen.js');
  ok(/faceCamera\(this\.group, this\.camera\);/.test(holoSrc) && !/this\.group\.lookAt\(/.test(holoSrc),
    'holo-screen.js: update() turns the panel square to the camera (faceCamera), never toward her head');
}
holo.camera = camera;
placeSeatedPanel();

// ---------- 4. the REAL seated arm with the SHIPPED loop: read + look beats, no touch, hand stays off the panel ----------
{
  const loop = createWorkLoop({ engine, holo, now: () => clock.t, random: makeRandom(7) });
  const rest = {};
  engine.setWorkReach(null);
  engine.setWorking(true);
  engine.update(0.016);
  for (const side of ['left', 'right']) rest[side] = engine.rig.nodes[`${side}UpperArm`].quaternion.clone();
  const plane = holo.touchFrame();
  const centre = new THREE.Vector3(...plane.c);
  const tip = new THREE.Vector3();
  let maxArmDeg = 0, lookFrames = 0, armedFrames = 0, minTipDist = Infinity;
  const beats = new Set();
  for (let i = 0; i < 3750; i++) { // ~60 s at 16 ms
    clock.t += 16;
    loop.update(clock.t);
    engine.update(0.016);
    beats.add(loop.state.beat);
    if (loop.state.lookAt) lookFrames++;
    if (engine.workReach) armedFrames++;
    maxArmDeg = Math.max(maxArmDeg, ...['left', 'right'].map((side) => engine.rig.nodes[`${side}UpperArm`].quaternion.angleTo(rest[side]) * 180 / Math.PI));
    engine.rig.fingertip(engine.rig.arms.right, 'right', tip);
    minTipDist = Math.min(minTipDist, tip.distanceTo(centre));
  }
  engine.setWorking(false);
  ok(beats.has('read-panel') && !beats.has('panel-touch') && lookFrames > 0,
    'beats (alpha.10): seated, she reads the panel and looks at anh; no touch beat plays', { beats: [...beats].filter(Boolean), lookFrames });
  ok(armedFrames === 0, 'arm: no work contact is ever armed on the seated panel', { armedFrames });
  ok(maxArmDeg < 15, 'arm: her upper arms stay in the seated pose while she works (< 15 deg, no reach to the panel)', { maxArmDeg: +maxArmDeg.toFixed(1) });
  ok(minTipDist > 0.10, 'arm: her right fingertip never comes within 10 cm of the panel centre', { minTipDist: +minTipDist.toFixed(3), planeDistanceAtEnd: +planeDistance(plane, [tip.x, tip.y, tip.z]).toFixed(3) });
}

// ---------- 5. seated + not working: the panel is hidden and nothing else moves ----------
{
  const rect = { x0: -0.7, x1: -0.4, y0: -0.5, y1: -0.2 };
  let gazeWrites = 0, reachWrites = 0;
  const stubEngine = {
    working: true, speechMouth: null, states: new Set(), isState() { return false; }, isBusy() { return 0; },
    setWorkGaze() { gazeWrites++; }, setWorkReach() { reachWrites++; },
  };
  const hidden = { on: false, screenRect: () => ({ ...rect }), screenNdc: () => ({ x: -0.55, y: -0.35 }), touchFrame: () => null };
  const loopWorking = createWorkLoop({ engine: stubEngine, holo: hidden, now: () => 1_000_000, random: makeRandom(5) });
  ok(loopWorking.update(1_016) === null && gazeWrites === 0 && reachWrites === 0,
    'not working: with the panel hidden, even a working signal produces no beat and no gaze/reach write', { gazeWrites, reachWrites });
  const visible = { on: true, screenRect: () => ({ ...rect }), screenNdc: () => ({ x: -0.55, y: -0.35 }), touchFrame: () => null };
  stubEngine.working = false;
  const loopIdle = createWorkLoop({ engine: stubEngine, holo: visible, now: () => 2_000_000, random: makeRandom(5) });
  ok(loopIdle.update(2_016) === null && !loopIdle.state.owning && gazeWrites === 0,
    'not working: the work loop is silent with the signal off (the pre-step-11 seated behaviour)', loopIdle.state);

  // Source wiring: the app's sink only touches the PANEL; the seated (non-working) look path is untouched.
  const app = read('src/renderer/app.js');
  ok(/apply: \(on\) => \{ engine\.setWorking\(on\); applyWorkPanel\(\); \}/.test(app),
    'app.js: the working signal drives engine.working + applyWorkPanel (the seated panel follows the signal, the camera does not)');
  const body = (app.match(/function applyWorkPanel\(\) \{[\s\S]*?\n  \}/) || [''])[0];
  ok(body.length > 0 && !/chair3d|occluder|enterFloat|exitFloat|placeSeat|applyChair/.test(body),
    'app.js: applyWorkPanel touches the PANEL ONLY -- chair, occluders, pose and the float path are untouched', body.slice(0, 240));
  ok(/const on = workPanelOn\(stageMode, engine\.working, isPublicBuild\(info\)\);/.test(body) && /if \(on !== holo\.on\) holo\.setOn\(on\);/.test(body),
    'app.js: applyWorkPanel uses the shared rule and only re-arms holo on a real change');
  ok(/const panelOn = workPanelOn\(stageMode, engine\.working, isPublicBuild\(info\)\);/.test(app) && /holo\.setPlacement\(floatOn \? 'float' : 'seated'\);/.test(app),
    'app.js: applyStageMode derives the panel state from the same rule and picks the placement');
  ok(/engine\.setHoloPanel\(panelOn\);/.test(app) && /holo\.setOn\(panelOn\); \/\/ seated/.test(app),
    'app.js: the reflex clamp tracks the panel in BOTH modes (never left on with no panel)');

  const holoSrc = read('src/renderer/room/holo-screen.js');
  ok(/export function workPanelOn\(stageMode, working, publicBuild = false\)/.test(holoSrc) && /export function panelOffset\(mode, P\)/.test(holoSrc)
    && /export function panelSize\(mode, P\)/.test(holoSrc) && /setPlacement\(mode\) \{/.test(holoSrc),
  'holo-screen.js: exports the shared rule + placement maths and owns setPlacement');
  ok(/const o = panelOffset\(this\.placement, this\.P\);/.test(holoSrc) && /SEATED_SCREEN_OFFSET/.test(holoSrc) && /SEATED_PANEL_SCALE/.test(holoSrc),
    'holo-screen.js: update() positions from the active placement (float and seated from one function)');

  const pkg = JSON.parse(read('package.json'));
  ok(pkg.scripts['check:work-seated'] === 'node scripts/check-work-seated.mjs',
    'package.json: check:work-seated runs this gate', pkg.scripts['check:work-seated']);
}

console.log(`\ncheck:work-seated ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
