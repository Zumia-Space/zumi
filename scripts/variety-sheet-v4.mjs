// Contact sheet v4 (coordinator QC on v3: surprise-chest-clutch and concern-hug both read as a THUMBS-UP at
// lower-chest/belly height, not a chest touch -- rig.js's 'open'/'relaxed' HAND_SHAPES leave the thumb at its
// bind-pose direction, which reads as thumbs-up once any other finger has curl; happy-wave's arm was still
// fully extended, hand touching the frame edge; surprise-hands-up's fingers read as pointing inward. Fixed in
// jevlabels.js: every Jev hand near the body now uses 'loose' (thumb tucked) at a weight high enough for the
// tuck to actually apply, happy-wave's reach weight lowered so the elbow stays bent instead of the arm reaching
// full extension, and scripts/check-jev-rig.mjs now runs a REAL geometric HAND-SHAPE guard (thumb-tip rise
// above the index MCP) against every one of the 197 pool entries, not just these 4 cells. Same layout as v2/v3:
// 4 labels (nod, surprise, happy, concern) x 4 DISTINCT BASE FAMILIES each, each motion's MOST EXPRESSIVE frame
// (measured via engine.acc.mag, not guessed), waist-up so arms show, same headless-Chromium approach as
// variety-sheet.mjs.
//   node scripts/variety-sheet-v4.mjs [--model <file.vrm>] [--out <file.png>]
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
const outFile = path.resolve(arg('out', `${ownerPath('laneOut', 'out')}/variety/sheet-v4.png`));

const PW_SOURCE = ownerPath('playwrightCore', 'node_modules/playwright-core');
if (!fs.existsSync(PW_SOURCE)) { console.error(`SKIP: no vendored playwright-core at ${PW_SOURCE} and installing one is not allowed here`); process.exit(0); }
const { chromium } = createRequire(path.join(PW_SOURCE, 'package.json'))(PW_SOURCE);

const PLAYER_HTML = `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><title>Jev variety contact sheet v4</title>
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
  const { JEV_LABEL_VI } = await import('/renderer/talk/jevlabels.js');

  // CW widened from v2's 320 (coordinator QC: happy-wave's hand clipped the left edge). The camera's vertical
  // framing (waist-up) comes only from top/bottom in frameCamera below; a wider CW at the same CH adds
  // horizontal headroom at the SAME vertical crop, not a different "waist-up" -- it does not change where the
  // gesture lands, only how much of it the sheet shows.
  const CW = 520, CH = 420, HEAD = 60, ROWH = 28;
  const cols = Math.max(...rows.map((r) => r.picks.length));
  const out = document.createElement('canvas');
  out.width = cols * CW;
  out.height = HEAD + rows.length * (ROWH + CH + 10);
  const g = out.getContext('2d');
  g.fillStyle = '#20242b'; g.fillRect(0, 0, out.width, out.height);
  g.fillStyle = '#ffffff'; g.font = 'bold 20px sans-serif'; g.fillText(title, 12, 28);
  g.fillStyle = '#9fb0c4'; g.font = '13px sans-serif';
  g.fillText('T-31 Jev variety v4 -- 4 distinct BASE FAMILIES per label, measured peak frame, front view, waist-up', 12, 46);

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
  function step() { vclock += 1000 * DT; engine.update(DT); vrm.scene.updateMatrixWorld(true); return engine.acc.mag; }
  function reset() {
    engine.player.stopAll(true);
    engine.states.clear();
    if (engine.rig && engine.rig.routes) engine.rig.routes.clear();
    engine.resetForTest();
    engine.life.blinkNext = vclock + 99999;
    for (let i = 0; i < FPS; i++) step();
  }

  // Two-pass: measure acc.mag (the engine's own per-frame "how much is currently moving" scalar) for 1.8 s after
  // onset, find the frame of maximum magnitude, then replay the IDENTICAL deterministic sequence (fixed
  // random:()=>0.5, same play() call) up to that frame and render there -- not a guessed fixed offset.
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
    g.fillText(JEV_LABEL_VI[row.label] + ' (' + row.label + ')', 12, y0 + 18);
    for (let ci = 0; ci < row.picks.length; ci++) {
      const pick = row.picks[ci];
      const playCmd = pick.side === -1 ? { ...pick.command, mirror: 'random' } : pick.command;
      const bestF = peakFrame(playCmd, pick.side);
      reset();
      engine.player.play(playCmd, { side: pick.side });
      for (let f = 0; f <= bestF; f++) step();
      renderer.render(scene, cam);
      const x = ci * CW, y = y0 + ROWH;
      g.drawImage(renderer.domElement, x, y);
      g.strokeStyle = '#20242b'; g.lineWidth = 1; g.strokeRect(x + 0.5, y + 0.5, CW - 1, CH - 1);
      const label = pick.family + ' (' + pick.bodyId + ' + ' + pick.faceId + ')';
      g.font = 'bold 12px sans-serif';
      const w = g.measureText(label).width;
      g.fillStyle = 'rgba(32,36,43,0.82)'; g.fillRect(x + 6, y + CH - 26, Math.min(CW - 12, w + 14), 20);
      g.fillStyle = '#ffe08a'; g.fillText(label, x + 13, y + CH - 11);
      g.fillStyle = 'rgba(32,36,43,0.7)'; g.font = '11px sans-serif';
      g.fillText('peak @ ' + Math.round(bestF * 1000 / FPS) + ' ms', x + 8, y + 16);
      info.push({ label: row.label, bodyId: pick.bodyId, faceId: pick.faceId, family: pick.family, peakMs: Math.round(bestF * 1000 / FPS) });
    }
  }
  return { png: out.toDataURL('image/png'), info };
};
window.jevSelectorReady = async function (labels) {
  const { JevSelector } = await import('/renderer/talk/jevSelector.js');
  const { mergeBodyFace } = await import('/renderer/talk/jevVariety.js');
  const sel = new JevSelector({ log: () => {} });
  sel.warm('sheet-v2-rig'); // schema-only: this sheet is visual evidence, not a re-run of check:jev-rig
  const rows = [];
  for (const label of labels) {
    const pool = sel.bodyPool.get(label);
    const bases = pool.filter((v) => v.kind === 'base'); // one per family, the clearest form of each motion
    const faces = sel.facePool.get(label);
    rows.push({
      label,
      picks: bases.map((p, i) => {
        const face = faces[i % faces.length];
        return { bodyId: p.id, faceId: face.id, family: p.family, side: p.side, command: mergeBodyFace(p.command, face.expressions) };
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

const LABELS = ['nod', 'surprise', 'happy', 'concern'];
const t0 = Date.now();
let browser;
try {
  browser = await chromium.launch({ headless: true, args: ['--use-gl=swiftshader'], timeout: 60000 });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('pageerror', e.message));
  await page.goto(`http://127.0.0.1:${port}/player.html`);
  await page.waitForFunction(() => window.ready === true, null, { timeout: 30000 });
  const rows = await page.evaluate((labels) => window.jevSelectorReady(labels), LABELS);
  const title = 'Jev reaction variety v4 -- ' + LABELS.join(', ') + ' (T-31)';
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
