// Visual contact sheet of EVERY built-in reflex gesture (reflex/gestures/*.json) and speech-library
// (reflex/speech/*.json) variant, one tile per variant, at its MOST EXPRESSIVE frame (measured via the
// engine's own acc.mag over a fixed post-onset window, same method as variety-sheet-v5.mjs), front view,
// waist-up, labelled. Built for the coordinator's hand-shape QC pass (T-31 builtin-hands): a human look at
// every built-in's hands in one image, after the thumb-rise / out-of-plane guard (check:jev-rig) already
// passed green. This script renders; it never changes app data.
//   node scripts/sheet-builtins.mjs [--model <file.vrm>] [--out <file.png>]
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
const outFile = path.resolve(arg('out', `${ownerPath('laneOut', 'out')}/hands/builtins-sheet.png`));

// No playwright-core is vendored in this worktree (node_modules is a junction; installing one here is not
// allowed). Reuse an already-installed copy elsewhere on disk, same approach as variety-sheet-v5.mjs's
// PW_SOURCE -- read-only, nothing is installed or modified.
const PW_SOURCE = ownerPath('playwrightCoreAlt', 'node_modules/playwright-core');
if (!fs.existsSync(PW_SOURCE)) { console.error(`SKIP: no vendored playwright-core at ${PW_SOURCE} and installing one is not allowed here`); process.exit(0); }
const { chromium } = createRequire(path.join(PW_SOURCE, 'package.json'))(PW_SOURCE);

const PLAYER_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Built-in gesture + speech hand-shape sheet</title>
<style>body{margin:0;background:#20242b}</style>
<script type="importmap">
{"imports":{"three":"/nm/three/build/three.module.js","three/addons/":"/nm/three/examples/jsm/","@pixiv/three-vrm":"/nm/@pixiv/three-vrm/lib/three-vrm.module.js"}}
</script></head><body>
<script type="module">
window.renderSheet = async function (rows, title) {
  const THREE = await import('three');
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const { VRMLoaderPlugin } = await import('@pixiv/three-vrm');
  const { prepareVrm } = await import('/renderer/model-facing.js');
  const { ReflexEngine } = await import('/renderer/reflex/engine.js');
  const { Catalog } = await import('/renderer/reflex/catalog.js');
  const { SpeechLibrary } = await import('/renderer/talk/library.js');

  // CW widened from 360 (coordinator QC: wave/wave-small/point-sidebar reaches, played at the viewer's left
  // since they are the character's RIGHT hand facing the camera, clipped past the left edge) -- same fix and
  // same value variety-sheet-v5.mjs already used for the identical "happy-wave clips the left edge" defect.
  // Widening CW (not CH) only adds horizontal FOV at the same vertical (waist-up) framing; it does not zoom
  // or re-crop top/bottom.
  const CW = 640, CH = 440, HEAD = 60, ROWH = 26;
  const cols = Math.max(...rows.map((r) => r.picks.length));
  const out = document.createElement('canvas');
  out.width = cols * CW;
  out.height = HEAD + rows.length * (ROWH + CH + 10);
  const g = out.getContext('2d');
  g.fillStyle = '#20242b'; g.fillRect(0, 0, out.width, out.height);
  g.fillStyle = '#ffffff'; g.font = 'bold 20px sans-serif'; g.fillText(title, 12, 28);
  g.fillStyle = '#9fb0c4'; g.font = '13px sans-serif';
  g.fillText('Every built-in gesture + speech variant, measured peak frame, front view, waist-up', 12, 46);

  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(CW, CH); renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0xe9ecf1);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x667788, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6); sun.position.set(1, 3, 2); scene.add(sun);

  const loader = new GLTFLoader(); loader.register((p) => new VRMLoaderPlugin(p));
  const gltf = await loader.loadAsync('/vrm/model.vrm');
  const vrm = gltf.userData.vrm;
  prepareVrm(gltf, vrm); // the app's load path: clean-up + the VRM 0.x flip + the base-orientation capture Rig's IK needs
  scene.add(vrm.scene);

  const cam = new THREE.PerspectiveCamera(28, CW / CH, 0.05, 50);
  const catalog = await Catalog.load('/renderer/reflex/gestures/');
  const engine = new ReflexEngine({ catalog, clips: { has: () => false, bind() {}, unbind() {}, sample: () => false, blend() {}, wasActive: false }, random: () => 0.5 });
  engine.bind(vrm, cam);
  engine.autoIdle = false;
  (function () { // hips -> top of head/halo, same framing every sheet in this repo uses (waist-up, hands read large)
    const rig = engine.rig, s = rig.shoulderWidth;
    const box = new THREE.Box3().setFromObject(vrm.scene);
    const bottom = rig.hipsPos.y - 0.05 * s;
    const rawTop = Math.max(box.max.y, rig.shoulderY + 0.8 * rig.armLength, rig.headPos.y + 0.6 * s);
    const top = rawTop + 0.04 * (rawTop - bottom), cy = (top + bottom) / 2;
    const dist = ((top - bottom) / 2) / Math.tan((cam.fov / 2) * Math.PI / 180) * 1.03;
    cam.position.set(0, cy + 0.03 * (top - bottom), rig.headPos.z + dist);
    cam.lookAt(0, cy, rig.headPos.z); cam.updateMatrixWorld();
  })();

  let vclock = 1e6;
  performance.now = () => vclock;
  const FPS = 60, DT = 1 / FPS;
  function step() { vclock += 1000 * DT; engine.update(DT); vrm.scene.updateMatrixWorld(true); return engine.acc.mag; }
  function reset() {
    engine.player.stopAll(true);
    engine.states.clear();
    if (engine.rig && engine.rig.routes) engine.rig.routes.clear();
    engine.resetForTest();
    engine.life.blinkNext = vclock + 99999;
    for (let i = 0; i < FPS; i++) step();
  }

  // Two-pass, identical to variety-sheet-v5.mjs: measure acc.mag for a fixed post-onset window, replay to the
  // frame of maximum magnitude, render there -- not a guessed fixed offset. 1.8 s covers inMs+holdMs for every
  // built-in; sustain:true reflexes (blur) never end on their own, so the window is a cap, not a wait-for-end.
  function peakFrame(playCmd, side) {
    reset();
    const res = engine.player.play(playCmd, { side });
    if (!res.ok) throw new Error('play failed: ' + res.errors.join('; '));
    const steps = Math.round(1800 / (1000 * DT));
    let bestF = 0, bestMag = -Infinity;
    for (let f = 0; f <= steps; f++) { const m = step(); if (m > bestMag) { bestMag = m; bestF = f; } }
    return bestF;
  }

  const info = [];
  for (let ri = 0; ri < rows.length; ri++) {
    const row = rows[ri];
    const y0 = HEAD + ri * (ROWH + CH + 10);
    g.fillStyle = '#ffffff'; g.font = 'bold 16px sans-serif';
    g.fillText(row.label, 12, y0 + 18);
    for (let ci = 0; ci < row.picks.length; ci++) {
      const pick = row.picks[ci];
      const bestF = peakFrame(pick.command, 1);
      reset();
      engine.player.play(pick.command, { side: 1 });
      for (let f = 0; f <= bestF; f++) step();
      renderer.render(scene, cam);
      const x = ci * CW, y = y0 + ROWH;
      g.drawImage(renderer.domElement, x, y);
      g.strokeStyle = '#20242b'; g.lineWidth = 1; g.strokeRect(x + 0.5, y + 0.5, CW - 1, CH - 1);
      const label = pick.id;
      g.font = 'bold 13px sans-serif';
      const w = g.measureText(label).width;
      g.fillStyle = 'rgba(32,36,43,0.82)'; g.fillRect(x + 6, y + CH - 26, Math.min(CW - 12, w + 14), 20);
      g.fillStyle = '#ffe08a'; g.fillText(label, x + 13, y + CH - 11);
      g.fillStyle = 'rgba(32,36,43,0.7)'; g.font = '11px sans-serif';
      g.fillText('peak @ ' + Math.round(bestF * 1000 / FPS) + ' ms', x + 8, y + 16);
      info.push({ kind: row.kind, key: row.label + '/' + pick.id, peakMs: Math.round(bestF * 1000 / FPS) });
    }
  }
  return { png: out.toDataURL('image/png'), info };
};
window.buildRows = async function () {
  const { Catalog } = await import('/renderer/reflex/catalog.js');
  const { SpeechLibrary } = await import('/renderer/talk/library.js');
  const catalog = await Catalog.load('/renderer/reflex/gestures/');
  const rows = [];
  for (const trig of catalog.names()) {
    const t = catalog.get(trig);
    rows.push({ kind: 'gesture', label: 'gesture ' + trig, picks: t.variants.map((v) => ({ id: v.id, command: v.command })) });
  }
  const lib = await SpeechLibrary.load((f) => fetch('/renderer/reflex/speech/' + f).then((r) => r.json()));
  for (const [intent, def] of lib.byIntent) {
    rows.push({ kind: 'speech', label: 'speech ' + intent, picks: def.variants.map((v) => ({ id: v.id, command: v.command })) });
  }
  return rows;
};
window.ready = true;
</script></body></html>`;

const ROOTS = { '/nm/': path.join(ROOT, 'node_modules') + '/', '/renderer/': path.join(ROOT, 'src', 'renderer') + '/', '/vrm/': path.dirname(modelPath) + '/' };
const TYPES = { '.js': 'text/javascript', '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.vrm': 'application/octet-stream' };
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
  await page.goto(`http://127.0.0.1:${port}/player.html`);
  await page.waitForFunction(() => window.ready === true, null, { timeout: 30000 });
  let rows = await page.evaluate(() => window.buildRows());
  // --rows focus,entrance,send,greet : render only those rows (gesture trigger / speech intent), so a re-render
  // after a data fix can target the affected rows instead of the whole sheet.
  const rowFilter = arg('rows');
  if (rowFilter) { const want = new Set(rowFilter.split(',').map((s) => s.trim())); rows = rows.filter((r) => want.has(r.label.replace(/^(gesture|speech) /, ''))); }
  if (!rows.length) throw new Error(`--rows matched no rows (got: ${rowFilter})`);
  const title = 'Built-in gestures + speech library -- hand-shape sheet (Zumi v3.1, T-31)';
  const { png, info } = await page.evaluate(([r, t]) => window.renderSheet(r, t), [rows, title]);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, Buffer.from(png.split(',')[1], 'base64'));
  console.log(`wrote ${outFile}`);
  console.log(JSON.stringify(info, null, 1));
  console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
} catch (e) {
  console.error('FAILED:', e.stack || e.message);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  srv.close();
}
