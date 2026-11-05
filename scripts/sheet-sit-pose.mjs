// Visual contact sheet for the T-31 seated-pose prep (coordinator's own QC gate: "looks natural?" --
// knee angle, feet on the floor or floating, hand placement, spine, any clipping into the chair box).
// Renders the REAL production path end to end: the seated clip plays through engine.player.play() and
// ClipLayer.sample()/blend() exactly like a built-in, over a real http fetch (a browser page, unlike the
// Node check-*.mjs scripts, so fetch() genuinely works here). Rendered at FRAME 300 of that live path, per
// the coordinator's QC request -- not frame 1, and not any workaround. Seat height (the scene-root drop) is
// applied here, in the render only -- the pure function it previews lives in scripts/seat-offset.mjs / is
// unit-tested (incl. an integration assertion against this exact model+clip) by scripts/check-seat-offset.mjs.
//
// FOUND BUG, NOW FIXED in src/renderer/reflex/clips.js: ClipLayer.sample() used to call
// vrm.humanoid.resetNormalizedPose() on every invocation. The clip's first sampled frame was fine, but that
// reset corrupted THREE.AnimationMixer's cached PropertyMixer state for the bones the action targets --
// every mixer.update() call after it silently re-applied IDENTITY, no error, no warning. Root cause,
// repro, and the fix are documented in clips.js's own comment; scripts/check-clip-hold.mjs regression-tests
// it (asserts the pose holds at frames 1/60/300). This was apparently the first script in this repo to
// drive a real loaded clip through more than one frame of ClipLayer (check-idle-life.mjs /
// check-r4a-latency.mjs both bind a ClipLayer with `clipAvailable: () => false`).
//
// Seated arm rest: engine.rig.seated = true (src/renderer/reflex/rig.js) turns on the seated-base arm pose
// (hands on the thighs, loose/soft hand shape) at the lowest priority -- nothing else is playing here, so
// it shows undisturbed; check:motion-seated verifies every reflex still overrides it correctly.
//   node scripts/sheet-sit-pose.mjs [--model <file.vrm>] [--out-dir <dir>]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { ownerPath } from './lib/owner-paths.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const arg = (name, def = null) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : def; };
const modelPath = path.resolve(arg('model', ownerPath('testModel', 'local/test-model.vrm')));
const outDir = path.resolve(arg('out-dir', `${ownerPath('laneOut', 'out')}/sit`));

const PW_SOURCE = ownerPath('playwrightCoreAlt', 'node_modules/playwright-core');
if (!fs.existsSync(PW_SOURCE)) { console.error(`SKIP: no vendored playwright-core at ${PW_SOURCE} and installing one is not allowed here`); process.exit(0); }
const { chromium } = createRequire(path.join(PW_SOURCE, 'package.json'))(PW_SOURCE);

const PLAYER_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>T-31 sit-prep -- seated pose contact sheet</title>
<style>body{margin:0;background:#20242b}</style>
<script type="importmap">
{"imports":{"three":"/nm/three/build/three.module.js","three/addons/":"/nm/three/examples/jsm/","@pixiv/three-vrm":"/nm/@pixiv/three-vrm/lib/three-vrm.module.js","@pixiv/three-vrm-animation":"/nm/@pixiv/three-vrm-animation/lib/three-vrm-animation.module.js"}}
</script></head><body>
<script type="module">
window.renderViews = async function () {
  const THREE = await import('three');
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const { VRMLoaderPlugin } = await import('@pixiv/three-vrm');
  const { prepareVrm } = await import('/renderer/model-facing.js');
  const { ReflexEngine } = await import('/renderer/reflex/engine.js');
  const { ClipLayer } = await import('/renderer/reflex/clips.js');
  const { Catalog } = await import('/renderer/reflex/catalog.js');

  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0xe9ecf1);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x667788, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6); sun.position.set(1, 3, 2); scene.add(sun);

  const loader = new GLTFLoader(); loader.register((p) => new VRMLoaderPlugin(p));
  const gltf = await loader.loadAsync('/vrm/model.vrm');
  const vrm = gltf.userData.vrm;
  prepareVrm(gltf, vrm); // the app's load path: clean-up + the VRM 0.x flip + the base-orientation capture Rig's IK needs
  scene.add(vrm.scene);

  const cam = new THREE.PerspectiveCamera(28, 1, 0.05, 50);
  const catalog = await Catalog.load('/renderer/reflex/gestures/');
  const clips = new ClipLayer();
  const engine = new ReflexEngine({ catalog, clips, random: () => 0.5 });
  engine.bind(vrm, cam);
  engine.autoIdle = false;
  engine.rig.seated = true; // seated-base arm rest (hands on thighs) + default loose hand shape, lowest priority

  let vclock = 1e6;
  performance.now = () => vclock;
  const FPS = 60, DT = 1 / FPS;
  function step() { vclock += 1000 * DT; engine.update(DT); vrm.scene.updateMatrixWorld(true); }

  const V = () => new THREE.Vector3();
  const liveY = (bone) => vrm.humanoid.getNormalizedBoneNode(bone).getWorldPosition(V()).y;
  const liveZ = (bone) => vrm.humanoid.getNormalizedBoneNode(bone).getWorldPosition(V()).z;
  const restAnkleY = liveY('leftFoot'); // standing ankle-to-floor clearance, measured BEFORE the clip ever plays

  // Engage the seated base through the REAL ClipLayer path: a plain sustained GestureCommand carrying only
  // a clip reference, exactly how a built-in would request one. ClipLayer.setAvailable()+load() fetches the
  // real file over http (fetch() works fine in a browser page) -- awaited explicitly here, because a tight
  // synchronous frame loop never yields long enough for the browser's own event loop to complete that
  // fetch (confirmed directly: without this await, the clip is still unresolved at frame 300).
  clips.setAvailable([{ name: 'sit-idle', url: '/clips/sit-idle.vrma' }]);
  await clips.load('sit-idle');
  const res = engine.player.play({ id: 'sit-idle-base', sustain: true, clip: { name: 'sit-idle', weight: 1 } });
  if (!res.ok) throw new Error('sit-idle clip failed to queue: ' + res.errors.join('; '));
  step();
  await new Promise((r) => setTimeout(r, 0)); // flush the AnimationAction's own .then() (cache entry is already resolved)

  // Render at FRAME 300 of this live path (coordinator QC request) -- not frame 1, not a workaround.
  for (let i = 0; i < 299; i++) step();
  if (!engine.clips.wasActive) throw new Error('sit-idle clip never engaged (ClipLayer.wasActive stayed false) by frame 300');

  // Seat height: drop the scene root so the ANKLE lands at its own standing (flat-footed) height, not the
  // nominal seat height via the hips -- hip-anchoring left the soles 2-9cm through the floor (coordinator
  // QC, 2026-10-03). See scripts/seat-offset.mjs / scripts/check-seat-offset.mjs for the full reasoning and
  // the tested pure function (computeRootDrop(A, B) = A - B is generic; this just feeds it ankle heights
  // instead of hip heights). rig.hipsPos/headPos/shoulderY are measured ONCE at engine.bind() and do NOT
  // track this manual vrm.scene.position edit, so every absolute height below is re-read live off the bones.
  const seatedAnkleY = liveY('leftFoot');
  const drop = seatedAnkleY - restAnkleY;
  vrm.scene.position.y -= drop;
  vrm.scene.updateMatrixWorld(true);
  const seatHeightActualM = liveY('hips'); // wherever the pelvis actually lands once soles are on the floor

  // Stand-in chair: a thin seat SLAB at the ACTUAL resulting seat height (not the old nominal 0.45m -- see
  // above), not a floor-to-seat pedestal (a solid pedestal would occlude the shins/knees, which is exactly
  // what this sheet needs to judge), under the pelvis.
  const hipsZ = liveZ('hips');
  const seatThickness = 0.05;
  const chairGeo = new THREE.BoxGeometry(0.42, seatThickness, 0.42);
  const chair = new THREE.Mesh(chairGeo, new THREE.MeshStandardMaterial({ color: 0x8a6a4a }));
  chair.position.set(0, seatHeightActualM - seatThickness / 2, hipsZ - 0.05);
  scene.add(chair);
  const floorGeo = new THREE.PlaneGeometry(2, 2);
  const floor = new THREE.Mesh(floorGeo, new THREE.MeshStandardMaterial({ color: 0xcfd6e0 }));
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);

  const toPng = () => renderer.domElement.toDataURL('image/png');
  const views = {};
  const headZ = liveZ('head');

  // view 1 + 2: full body (floor to above head), front and 3/4.
  {
    const box = new THREE.Box3().setFromObject(vrm.scene);
    const bottom = Math.min(0, box.min.y) - 0.05;
    const top = box.max.y + 0.08;
    const cy = (top + bottom) / 2;
    const W = 520, H = 760;
    renderer.setSize(W, H); cam.aspect = W / H; cam.updateProjectionMatrix();
    const dist = ((top - bottom) / 2) / Math.tan((cam.fov / 2) * Math.PI / 180) * 1.08;
    cam.position.set(0, cy, headZ + dist);
    cam.lookAt(0, cy, headZ); cam.updateMatrixWorld();
    renderer.render(scene, cam); views.front = toPng();
    const az = 40 * Math.PI / 180;
    cam.position.set(Math.sin(az) * dist, cy, headZ + Math.cos(az) * dist);
    cam.lookAt(0, cy, headZ); cam.updateMatrixWorld();
    renderer.render(scene, cam); views.threeQuarter = toPng();
  }

  // view 3: frontal webcam, mid-chest up, full head with headroom, eyes at ~1/3 from the top (coordinator
  // QC fix -- the previous framing put the eyes AT the top edge, cutting off the top of the head).
  {
    const headNode = vrm.humanoid.getNormalizedBoneNode('head');
    const S = engine.rig.surf;
    // measured eye line (head-local, from rig.js's measureSurfaces -- same landmark check-motion.mjs's
    // FACE-CLEARANCE guard uses), not the head BONE itself (which sits well below the eyes on this rig).
    const eyeY = S && S.head && S.head.eye ? S.head.eye.clone().applyMatrix4(engine.rig.frame(headNode)).y : liveY('head') + 0.08;
    const bottom = liveY('chest'); // mid-chest
    // Solve top so eyeY lands at exactly 1/3 from the top of the frame: (top - eyeY) / (top - bottom) = 1/3.
    let top = (3 * eyeY - bottom) / 2;
    // Safety floor: never crop the actual head -- if the solved top is still below the model's own highest
    // point (hair, antennae etc. near the head), extend it with the same headroom margin used elsewhere.
    const headTop = new THREE.Box3().setFromObject(headNode).max.y;
    top = Math.max(top, headTop + 0.05);
    const cy = (top + bottom) / 2;
    const W = 640, H = 480;
    renderer.setSize(W, H); cam.aspect = W / H; cam.updateProjectionMatrix();
    const dist = ((top - bottom) / 2) / Math.tan((cam.fov / 2) * Math.PI / 180) * 1.0;
    cam.position.set(0, cy, headZ + dist);
    cam.lookAt(0, cy, headZ); cam.updateMatrixWorld();
    renderer.render(scene, cam); views.webcam = toPng();
  }

  return { views, measured: { drop, seatHeightActualM, headY: liveY('head'), ankleY: liveY('leftFoot'), toeY: liveY('leftToes') } };
};
window.ready = true;
</script></body></html>`;

const ROOTS = { '/nm/': path.join(ROOT, 'node_modules') + '/', '/renderer/': path.join(ROOT, 'src', 'renderer') + '/', '/vrm/': path.dirname(modelPath) + '/', '/clips/': path.join(ROOT, 'assets', 'clips') + '/' };
const TYPES = { '.js': 'text/javascript', '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.vrm': 'application/octet-stream', '.vrma': 'application/octet-stream' };
const srv = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/' || url === '/player.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(PLAYER_HTML); }
  if (url === '/vrm/model.vrm') { return fs.readFile(modelPath, (e, buf) => { if (e) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(buf); }); }
  const pre = Object.keys(ROOTS).find((p) => url.startsWith(p));
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

const t0 = Date.now();
let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=swiftshader'], timeout: 60000 });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('pageerror', e.message));
  page.on('console', (m) => { if (m.type() === 'warning' || m.type() === 'error') console.log('[page]', m.type(), m.text()); });
  await page.goto(`http://127.0.0.1:${port}/player.html`);
  await page.waitForFunction(() => window.ready === true, null, { timeout: 30000 });
  const { views, measured } = await page.evaluate(() => window.renderViews());
  fs.mkdirSync(outDir, { recursive: true });
  const write = (name, dataUrl) => { const f = path.join(outDir, name); fs.writeFileSync(f, Buffer.from(dataUrl.split(',')[1], 'base64')); console.log(`wrote ${f}`); };
  write('seated-front.png', views.front);
  write('seated-side.png', views.threeQuarter);
  write('seated-webcam.png', views.webcam);
  console.log('measured:', JSON.stringify(measured));
  console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
} catch (e) {
  console.error('FAILED:', e.stack || e.message);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  srv.close();
}
