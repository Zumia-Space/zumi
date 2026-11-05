// Contact sheet for Jev reaction variety (T-31 PLAN-variety.md, task item 7): 2 labels x 4 distinct (body, face)
// picks each, peak frame, front view, waist-up. Headless Chromium via playwright-core (no download: this
// workspace already has a vendored chromium cached at PLAYWRIGHT_BROWSERS_PATH -- see the comment below), same
// serve-the-renderer-tree-over-http approach as scripts/startle-sheets.mjs, trimmed to one build (this tree,
// no before/after) and no owner-idle gate (this is a few seconds of headless render, not a shared-PC batch job).
//   node scripts/variety-sheet.mjs [--model <file.vrm>] [--out <file.png>]
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
const outFile = path.resolve(arg('out', `${ownerPath('laneOut', 'out')}/variety/sheet-v1.png`));

// playwright-core is not a devDependency of this app (it ships no browser-automation code) -- reused read-only
// from a sibling project's node_modules, pinned to a chromium revision this machine already has cached at
// PLAYWRIGHT_BROWSERS_PATH (a local ms-playwright chromium-1223). No npm install, no download, no installer.
const PW_SOURCE = ownerPath('playwrightCore', 'node_modules/playwright-core');
if (!fs.existsSync(PW_SOURCE)) { console.error(`SKIP: no vendored playwright-core at ${PW_SOURCE} and installing one is not allowed here`); process.exit(0); }
const { chromium } = createRequire(path.join(PW_SOURCE, 'package.json'))(PW_SOURCE);

const PLAYER_HTML = `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><title>Jev variety contact sheet</title>
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
  const { JevSelector } = await import('/renderer/talk/jevSelector.js');
  const { JEV_LABEL_VI } = await import('/renderer/talk/jevlabels.js');

  const sel = new JevSelector({ log: () => {} });
  sel.warm('sheet-rig'); // schema-only: this sheet is a visual check, not a re-run of check:rig/check:motion

  const CW = 320, CH = 420, HEAD = 60, ROWH = 28;
  const cols = Math.max(...rows.map((r) => r.picks.length));
  const out = document.createElement('canvas');
  out.width = cols * CW;
  out.height = HEAD + rows.length * (ROWH + CH + 10);
  const g = out.getContext('2d');
  g.fillStyle = '#20242b'; g.fillRect(0, 0, out.width, out.height);
  g.fillStyle = '#ffffff'; g.font = 'bold 20px sans-serif'; g.fillText(title, 12, 28);
  g.fillStyle = '#9fb0c4'; g.font = '13px sans-serif';
  g.fillText('T-31 Jev variety -- 4 distinct (body, face) picks per label, peak frame, front view, waist-up', 12, 46);

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
  const engine = new ReflexEngine({ catalog: null, clips: { has: () => false, bind() {}, unbind() {}, sample: () => false, blend() {}, wasActive: false }, random: () => 0.5 });
  engine.bind(vrm, cam);
  engine.autoIdle = false;
  // Waist-up framing from the model's real bounds (app.js's own frameCamera, inlined).
  (function () {
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
  function step() { vclock += 1000 * DT; engine.update(DT); vrm.scene.updateMatrixWorld(true); }
  function reset() {
    engine.player.stopAll(true);
    engine.states.clear();
    if (engine.rig && engine.rig.routes) engine.rig.routes.clear();
    engine.resetForTest();
    engine.life.blinkNext = vclock + 99999;
    for (let i = 0; i < FPS; i++) step();
  }

  const info = [];
  for (let ri = 0; ri < rows.length; ri++) {
    const row = rows[ri];
    const y0 = HEAD + ri * (ROWH + CH + 10);
    g.fillStyle = '#ffffff'; g.font = 'bold 16px sans-serif';
    g.fillText(JEV_LABEL_VI[row.label] + ' (' + row.label + ')', 12, y0 + 18);
    for (let ci = 0; ci < row.picks.length; ci++) {
      const pick = row.picks[ci];
      reset();
      const playCmd = pick.side === -1 ? { ...pick.command, mirror: 'random' } : pick.command;
      const res = engine.player.play(playCmd, { side: pick.side });
      if (!res.ok) throw new Error('play failed: ' + res.errors.join('; '));
      const peakMs = 600; // in -> well into hold for every authored Jev motion/face (see jevlabels.js durations)
      for (let t = 0; t < peakMs; t += 1000 * DT) step();
      renderer.render(scene, cam);
      const x = ci * CW, y = y0 + ROWH;
      g.drawImage(renderer.domElement, x, y);
      g.strokeStyle = '#20242b'; g.lineWidth = 1; g.strokeRect(x + 0.5, y + 0.5, CW - 1, CH - 1);
      const label = pick.bodyId + ' + ' + pick.faceId;
      g.font = 'bold 13px sans-serif';
      const w = g.measureText(label).width;
      g.fillStyle = 'rgba(32,36,43,0.82)'; g.fillRect(x + 6, y + CH - 28, Math.min(CW - 12, w + 14), 22);
      g.fillStyle = '#ffe08a'; g.fillText(label, x + 13, y + CH - 12);
      info.push({ label: row.label, bodyId: pick.bodyId, faceId: pick.faceId, family: pick.family, kind: pick.kind });
    }
  }
  return { png: out.toDataURL('image/png'), info };
};
window.jevSelectorReady = async function (labels) {
  const { JevSelector } = await import('/renderer/talk/jevSelector.js');
  const { mergeBodyFace } = await import('/renderer/talk/jevVariety.js');
  const sel = new JevSelector({ log: () => {} });
  sel.warm('pick-rig');
  const rows = [];
  for (const label of labels) {
    const pool = sel.bodyPool.get(label);
    // 4 visibly distinct picks: the 2 authored bases, one mirror/amp derivative of each (prefer mirror).
    const pickFor = (base) => pool.find((v) => v.id === base.id + '-mirror') || pool.find((v) => v.id === base.id + '-amp110') || pool.find((v) => v.id === base.id + '-gaze');
    const bases = pool.filter((v) => v.kind === 'base');
    const picks = [];
    for (const b of bases) { picks.push(b); const d = pickFor(b); if (d) picks.push(d); }
    const faces = sel.facePool.get(label);
    rows.push({
      label,
      picks: picks.slice(0, 4).map((p, i) => {
        const face = faces[i % faces.length];
        return { bodyId: p.id, faceId: face.id, family: p.family, kind: p.kind, side: p.side, command: mergeBodyFace(p.command, face.expressions) };
      }),
    });
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

const LABELS = ['nod', 'surprise']; // this build's closest Jev equivalents to the brief's example "agree, surprised"
const t0 = Date.now();
let browser;
try {
  browser = await chromium.launch({ headless: true, args: ['--use-gl=swiftshader'], timeout: 60000 });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('pageerror', e.message));
  await page.goto(`http://127.0.0.1:${port}/player.html`);
  await page.waitForFunction(() => window.ready === true, null, { timeout: 30000 });
  const rows = await page.evaluate((labels) => window.jevSelectorReady(labels), LABELS);
  const title = 'Jev reaction variety -- ' + LABELS.join(', ') + ' (T-31)';
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
