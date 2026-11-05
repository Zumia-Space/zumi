// Camera-modes renders (T-31 camera modes, PLAN-camera-modes.md item 9): talk/work/room, frame 300, through the
// REAL production pipeline -- room-loader-v2.js, CameraDirector, seat.js (measureSeatDropM/placeSeated/
// enterSeated), exactly the modules app.js wires, driven headless in Chromium (same vendored playwright-core +
// local static server pattern as scripts/variety-sheet-v5.mjs -- SKIPs, not fails, when the vendored copy is
// unavailable). The plate (2D canvas, camera-director.js's own drawPlate) and the WebGL render (transparent
// clear, same as app.js's renderer) are composited onto one output canvas, same layering the real app's DOM
// does with CSS (#stage-plate behind #stage-canvas).
//   node scripts/render-camera-views.mjs [--model <file.vrm>] [--room <dir with room.json>] [--tag <prefix>] [--out <dir>] [--width N] [--height N]
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { ownerPath } from './lib/owner-paths.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const arg = (name, def = null) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : def; };
const modelPath = path.resolve(arg('model', ownerPath('testModel', 'local/test-model.vrm')));
const roomDir = path.resolve(arg('room', ownerPath('standinRoom', 'local/standin-room-v2')));
const tag = arg('tag', '');
const outDir = path.resolve(arg('out', `${ownerPath('laneOut', 'out')}/camera`));
const W = Number(arg('width', 960)), H = Number(arg('height', 600));

if (!fs.existsSync(path.join(roomDir, 'room.json'))) { console.error(`missing room.json in ${roomDir}`); process.exit(2); }

const PW_SOURCE = ownerPath('playwrightCore', 'node_modules/playwright-core');
if (!fs.existsSync(PW_SOURCE)) { console.error(`SKIP: no vendored playwright-core at ${PW_SOURCE} and installing one is not allowed here`); process.exit(0); }
const { chromium } = createRequire(path.join(PW_SOURCE, 'package.json'))(PW_SOURCE);

const PLAYER_HTML = `<!doctype html>
<html><head><meta charset="utf-8"></head><body>
<script type="importmap">
{"imports":{"three":"/nm/three/build/three.module.js","three/addons/":"/nm/three/examples/jsm/","@pixiv/three-vrm":"/nm/@pixiv/three-vrm/lib/three-vrm.module.js","@pixiv/three-vrm-animation":"/nm/@pixiv/three-vrm-animation/lib/three-vrm-animation.module.js"}}
</script></head><body>
<script type="module">
import { applyAvatarTint } from '/renderer/room/apply-grade.js';
// virtual clock: lets the 300-frame settle run instantly instead of 5 real seconds, same technique
// check-motion-seated.mjs / variety-sheet-v5.mjs already use. Module scope (not inside setup()) so both
// window.setup and window.renderView can advance/read it.
let vclock = 1e6;
performance.now = () => vclock;
// Look-tuning defaults (same as src/renderer/room/look-tuning.js's defaultOverride): talk gets the owner's
// "Chest-up (webcam)" framing preset -- an editorial/QC framing CHOICE, not authored in room.json, so it stays
// a constant here. exposure/tint/tintStrength (coordinator round 2, 2026-10-05) now come from the loaded
// room's own views.<v>.grade instead of a hand-picked constant -- GRADE is built in window.setup(), once the
// room has actually loaded, by merging FRAMING with each view's grade (or neutral, if that view has none).
// window.__grade=false (the --before shot) renders with NO override -- Vesta's original camera numbers, no
// blur, no tint, no exposure change -- for a direct comparison. Module scope: both window.setup (builds
// CameraDirector with this as its getFramingOverride) and window.renderView (applies blur/tint/exposure when
// compositing) need GRADE.
window.__grade = true;
const FORCE_FULL_TALK = ${process.env.FORCE_FULL_TALK ? 'true' : 'false'}; // measurement-only escape hatch: talk's chest-up crop hides the sofa throw a luminance sample needs in frame alongside her suit
const FRAMING = { talk: { chestUp: !FORCE_FULL_TALK, blur: 'soft' }, work: { overShoulder: true, blur: 'off' }, room: { chestUp: false, blur: 'off' } };
let GRADE = null;

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

  const catalog = await Catalog.load('/renderer/reflex/gestures/'); // served straight from src/renderer/reflex/gestures/ (the build step flattens this to gestures/, but this script serves src/ directly)
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
    getFramingOverride: (name) => (window.__grade ? GRADE[name] : null),
  });

  const res = await fetch('/room/room.json');
  const json = await res.json();
  const room = await loadRoomV2(json, (rel) => '/room/' + rel);
  if (!room) throw new Error('loadRoomV2 returned null');
  scene.add(room.scene); // the occluders + lights groups live here -- app.js's switchRoom() does this same add() on a real room load

  GRADE = {};
  for (const name of ['talk', 'work', 'room']) {
    const g = room.views[name].grade; // { exposure, tint, tintStrength } | null -- room.json's own authored default (coordinator round 2)
    GRADE[name] = { ...FRAMING[name], tint: g ? g.tint : '#000000', tintStrength: g ? g.tintStrength : 0, exposure: g ? g.exposure : 1 };
  }

  hipOffsetXZ = measureHipOffsetXZ(engine); // synchronous -- see seat.js header
  const drop = await measureSeatDropM(engine);
  // enterSeated() awaits ClipLayer.warm(), which builds+registers the sit-idle AnimationAction for real before
  // returning -- required here specifically because window.renderView()'s own 300-tick settle loop below is a
  // tight synchronous loop (manually-advanced clock, no event-loop turns between ticks), where the OLD lazy
  // action()-via-.then() path could never get a turn to run during the FIRST view ever rendered (see seat.js
  // enterSeated's header for the full chain -- found 2026-10-05 QC, real-talk.png's straight standing legs).
  if (drop != null) { seatDropM = drop; await enterSeated(engine); }
  director.setRoom(room);

  window.__state = { THREE, renderer, scene, camera, vrm, engine, director, plateCanvas, plateCtx, enterSeated };
  return { views: Object.keys(room.views), seatDropM, hipOffsetXZ };
};

window.renderView = async function (viewName) {
  const { renderer, scene, camera, vrm, engine, director, enterSeated } = window.__state;
  director.jumpToView(viewName); // instant cut: this is a controlled QC render, not a transition shot -- jumpToView's own setLookTargets() call already set engine.primaryGaze from this view's primary:true look_target (engine.js), the SAME live mechanism app.js uses; no render-only override needed (removed 2026-10-05, coordinator round 4 -- a render-script-only gaze lock showed a shot the live app could not reproduce)
  // round 6: per-view seated pose (zumi_seat.pose, default 'sit-idle') -- switches the sustained clip when
  // this view's own pose differs from whatever was playing (seat.js enterSeated is idempotent per pose
  // name). Awaited BEFORE the settle loop below for the same reason the first enterSeated() call in setup()
  // already is (see that call's own comment): a tight synchronous frame loop never gives the clip's lazy
  // action-build promise a turn to run otherwise.
  const pose = (director.room.views[viewName].seat && director.room.views[viewName].seat.pose) || 'sit-idle';
  await enterSeated(engine, pose);
  const dt = 1 / 60;
  for (let i = 0; i < 300; i++) {
    vclock += dt * 1000;
    engine.update(dt);
    vrm.scene.updateMatrixWorld(true);
  }
  director.drawPlate(); // CameraDirector.update() is what normally calls this each frame; this render loop drives engine.update() directly (to force a specific view, not the idle-based FSM), so the plate is drawn explicitly here, once, for the final frame -- it also registers camera.viewOffset to the SAME cover-crop it just drew (applyFrameCrop), so the 3D render below lines up with it pixel-for-pixel
  renderer.render(scene, camera); // full canvas -- a v2 room's plate+camera cover it edge-to-edge by construction, nothing to scissor to

  const out = document.createElement('canvas'); out.width = ${W}; out.height = ${H};
  const g = out.getContext('2d');
  const grade = window.__grade ? GRADE[viewName] : null;
  const BLUR_PX = { off: 0, soft: 4, strong: 10 };
  g.filter = grade && BLUR_PX[grade.blur] ? 'blur(' + BLUR_PX[grade.blur] + 'px)' : 'none';
  g.drawImage(director.plateCtx.canvas, 0, 0); // the plate, camera-locked full-screen background (drawn behind) -- same CSS filter:blur() the live app applies to #stage-plate; grade (below) never touches it
  g.filter = 'none';

  // Avatar layer, built on its OWN canvas so exposure/tint apply to ONLY it, never the plate already drawn
  // above -- coordinator round 3 QC (2026-10-05): a flat tint fillRect drawn straight onto the output canvas (even in
  // 'multiply' mode) still deposits alpha = its own globalAlpha at pixels where the avatar canvas was fully
  // TRANSPARENT (Porter-Duff "over" alpha is source-alpha-union, independent of the blend function), so the
  // tint leaked through onto the plate wherever there was no avatar in front of it (measured ~11% dimmer on a
  // no-avatar plate region). Exposure (a canvas filter, applied while DRAWING the source) was already scoped
  // correctly; only the tint step needed this.
  const avatarCanvas = document.createElement('canvas'); avatarCanvas.width = ${W}; avatarCanvas.height = ${H};
  const ag = avatarCanvas.getContext('2d');
  ag.filter = grade && grade.exposure !== 1 ? 'brightness(' + grade.exposure + ')' : 'none';
  ag.drawImage(renderer.domElement, 0, 0); // the WebGL render, transparent-cleared -- alpha is 0 everywhere except the avatar's own silhouette
  ag.filter = 'none';
  if (grade && grade.tintStrength) {
    const img = ag.getImageData(0, 0, ${W}, ${H});
    applyAvatarTint(img, grade.tint, grade.tintStrength);
    ag.putImageData(img, 0, 0);
  }
  g.drawImage(avatarCanvas, 0, 0); // composite the (now avatar-only-graded) layer over the untouched plate

  return out.toDataURL('image/png');
};
window.ready = true;
</script></body></html>`;

const ROOTS = {
  '/nm/': path.join(ROOT, 'node_modules') + path.sep,
  '/renderer/': path.join(ROOT, 'src', 'renderer') + path.sep,
  '/scripts/': path.join(ROOT, 'scripts') + path.sep, // seat.js imports ../../../scripts/seat-offset.mjs -- resolves to this root in URL terms
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
  fs.readFile(file, (e, buf) => {
    if (e) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => srv.once('listening', r));
const port = srv.address().port;

fs.mkdirSync(outDir, { recursive: true });
let browser;
try {
  browser = await chromium.launch({ headless: true, args: ['--use-gl=swiftshader'], timeout: 60000 });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('pageerror', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.error('console error:', m.text()); });
  await page.goto(`http://127.0.0.1:${port}/player.html`);
  await page.waitForFunction(() => window.ready === true, null, { timeout: 30000 });
  const info = await page.evaluate(() => window.setup());
  console.log('views:', info.views, 'seatDropM:', info.seatDropM, 'hipOffsetXZ:', info.hipOffsetXZ);
  for (const view of ['talk', 'work', 'room']) {
    const dataUrl = await page.evaluate((v) => window.renderView(v), view);
    const file = path.join(outDir, `${tag}${view}.png`);
    fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
    console.log(`wrote ${file}`);
  }
  if (arg('before-talk')) {
    // Coordinator addendum: one extra talk shot with NO look-tuning override (Vesta's original camera, no blur,
    // no tint) for a direct before/after comparison against the graded default above.
    const dataUrl = await page.evaluate(async (v) => { window.__grade = false; const d = await window.renderView(v); window.__grade = true; return d; }, 'talk');
    const file = path.join(outDir, `${tag}talk-before.png`);
    fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
    console.log(`wrote ${file}`);
  }
} catch (e) {
  console.error('FAILED:', e.stack || e.message);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  srv.close();
}
