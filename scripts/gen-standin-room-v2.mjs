// Stand-in room.json v2 generator (T-31 camera modes, PLAN-camera-modes.md item 7 + coordinator rounds 2-3):
// writes a complete, checker-passing v2 room MIRRORING VESTA'S REAL v2-B SCHEMA (the v2-B room repo
// out/room.json) -- per-view zumi_seat/camera (pos/target/three.fov/aspect/viewOffset), occluders referencing
// named meshes in a generated occluders.glb, and a per-view `lights` test case (round 3: work has its own rig,
// talk/room fall back to the app's default lights, exercising both branches) -- so the rest of this task
// (CameraDirector, seated wiring, the registration tool, the render/latency gates) has something real to load.
// Plates are drawn with a plain 2D canvas in headless Chromium (no WebGL needed for a flat gradient + text) --
// same vendored playwright-core + no-GPU-args posture as scripts/variety-sheet-v5.mjs, SKIPs instead of failing
// when that vendored copy is unavailable (installing one is not allowed in this worktree). occluders.glb is
// built directly with three.js's GLTFExporter (plain Node, no browser needed for untextured boxes).
//   node scripts/gen-standin-room-v2.mjs [--out <dir>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { ownerPath } from './lib/owner-paths.mjs';

globalThis.self = globalThis;
globalThis.window = globalThis;
// GLTFExporter's binary (.glb) path reads its blob through a browser-only FileReader; Node has no FileReader but
// DOES have the global Blob it reads from (since Node 18) -- this is the minimal shim GLTFExporter actually
// calls (readAsArrayBuffer + onloadend/result), nothing more.
globalThis.FileReader = class {
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then((buf) => { this.result = buf; if (this.onloadend) this.onloadend(); }).catch((e) => { if (this.onerror) this.onerror(e); });
  }
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, def = null) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : def; };
const OUT = path.resolve(arg('out', ownerPath('standinRoom', 'local/standin-room-v2')));
const PLATE_W = 960, PLATE_H = 540;
const ASPECT = PLATE_W / PLATE_H;

const PW_SOURCE = ownerPath('playwrightCore', 'node_modules/playwright-core');
if (!fs.existsSync(PW_SOURCE)) { console.error(`SKIP: no vendored playwright-core at ${PW_SOURCE} and installing one is not allowed here`); process.exit(0); }
const { chromium } = createRequire(path.join(PW_SOURCE, 'package.json'))(PW_SOURCE);

// ---------- occluders.glb: a few named box meshes per view, exported with three.js's own GLTFExporter ----------
const THREE = await import('three');
const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');

// Box specs in the SAME per-view local frames the cameras/seats below use. node names follow Vesta's own
// "occ_<view>_<part>" convention (not required by the loader, which only ever matches the exact `node` string
// room.json gives -- this is just for a human reading the file to recognise it).
const OCCLUDER_BOXES = {
  talk: [],
  work: [{ node: 'occ_work_desk', pos: [0, 0.35, 0.42], size: [0.9, 0.7, 0.5] }],
  room: [{ node: 'occ_room_desk', pos: [0, 0.35, 0.42], size: [0.9, 0.7, 0.5] }],
};

const occScene = new THREE.Scene();
const occMat = new THREE.MeshBasicMaterial({ color: 0x888888 }); // authoring material only -- the loader always replaces it with a depth-only one
for (const boxes of Object.values(OCCLUDER_BOXES)) {
  for (const b of boxes) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...b.size), occMat);
    mesh.position.set(...b.pos);
    mesh.name = b.node;
    occScene.add(mesh);
  }
}
const occGlb = await new Promise((resolve, reject) => {
  new GLTFExporter().parse(occScene, (result) => resolve(result), (err) => reject(err), { binary: true });
});
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'occluders.glb'), Buffer.from(occGlb));
console.log(`wrote ${path.join(OUT, 'occluders.glb')} (${occScene.children.length} named meshes)`);

// ---------- plates: gradient + a big label + a small sublabel, one per view ----------
const PLATES = {
  talk: { w: PLATE_W, h: PLATE_H, top: '#2b3a55', bottom: '#15202e', label: 'TALK VIEW (stand-in)', sub: 'front-facing, webcam framing — PLAN-camera-modes.md' },
  work: { w: PLATE_W, h: PLATE_H, top: '#3a3322', bottom: '#1c1810', label: 'WORK VIEW (stand-in)', sub: 'seated at the desk, screen in front -- has its own light rig' },
  room: { w: PLATE_W, h: PLATE_H, top: '#223328', bottom: '#101c14', label: 'ROOM VIEW (stand-in)', sub: 'wide idle shot' },
};

const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<script>
window.renderPlate = function (spec) {
  const c = document.createElement('canvas'); c.width = spec.w; c.height = spec.h;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, spec.h);
  grad.addColorStop(0, spec.top); grad.addColorStop(1, spec.bottom);
  g.fillStyle = grad; g.fillRect(0, 0, spec.w, spec.h);
  const rad = g.createRadialGradient(spec.w / 2, spec.h * 0.55, 40, spec.w / 2, spec.h * 0.55, spec.w * 0.65);
  rad.addColorStop(0, 'rgba(255,255,255,0.05)'); rad.addColorStop(1, 'rgba(0,0,0,0.12)');
  g.fillStyle = rad; g.fillRect(0, 0, spec.w, spec.h);
  g.strokeStyle = 'rgba(255,255,255,0.18)'; g.lineWidth = 3; g.strokeRect(1.5, 1.5, spec.w - 3, spec.h - 3);
  g.fillStyle = '#e8ecf4'; g.font = 'bold 40px sans-serif'; g.textAlign = 'center';
  g.fillText(spec.label, spec.w / 2, spec.h / 2 - 8);
  g.fillStyle = 'rgba(232,236,244,0.75)'; g.font = '18px sans-serif';
  g.fillText(spec.sub, spec.w / 2, spec.h / 2 + 26);
  g.fillStyle = 'rgba(232,236,244,0.55)'; g.font = '14px monospace'; g.textAlign = 'left';
  g.fillText(spec.w + 'x' + spec.h, 14, spec.h - 14);
  return c.toDataURL('image/png');
};
window.ready = true;
</script></body></html>`;

// ---------- room.json v2 (mirrors Vesta's real v2-B field names, round-3 frozen) ----------
// Camera: "front-facing, webcam" (owner, verbatim, PLAN-camera-modes.md) for talk; a closer, down-angled shot at
// the desk for work (a deliberate off-centre viewOffset here, exercising that code path -- the real room uses
// one too); a wide shot for room. Each view has its OWN zumi_seat (round 2: views are not geometrically
// consistent) -- rotYDeg varies per view like the real room's does.
function cam(pos, target, fov, viewOffset) {
  return { pos, target, fovDeg: fov, three: { fov, aspect: ASPECT, ...(viewOffset ? { viewOffset } : {}) } };
}
const room = {
  format: 'zumi-room',
  version: 2,
  name: 'T-31 camera-modes stand-in (generated, no painted plates yet)',
  model: 'occluders.glb',
  plateSize: [PLATE_W, PLATE_H],
  views: {
    talk: {
      camera: cam([0, 1.45, 1.15], [0, 1.35, 0], 32),
      plate: 'plates/talk.png',
      zumi_seat: { pos: [0, 0.587, 0], rotYDeg: 0, pose: 'sit-idle' },
      look_targets: [
        { name: 'window', pos: [-1.1, 1.6, -1.4] },
        { name: 'door', pos: [1.2, 1.4, -1.0] },
      ],
      occluders: [],
    },
    work: {
      // Pulled back from the first draft (was framed too tight to show the desk/legs at all, QC'd via an actual
      // render -- camera/work.png): waist-up-ish so the desk occluder's effect is visible.
      camera: cam([0, 1.5, 1.7], [0, 0.85, 0], 30, { fullWidth: PLATE_W, fullHeight: PLATE_H * 1.08, x: 0, y: PLATE_H * 0.08, width: PLATE_W, height: PLATE_H }),
      plate: 'plates/work.png',
      zumi_seat: { pos: [0, 0.587, 0], rotYDeg: 18, pose: 'sit-idle' },
      look_targets: [
        { name: 'screen-edge', pos: [0.35, 1.25, -0.35] },
        { name: 'cup', pos: [-0.3, 0.9, 0.2] },
      ],
      // Hides the legs behind the painted desk (coordinator addendum): references the box baked into
      // occluders.glb above, same geometry the registration tool's wireframe would show for reference.
      occluders: [{ name: 'desk', node: 'occ_work_desk' }],
      // Round 3: this view's own light rig REPLACES the app's default lights while work is active (talk/room
      // have no `lights` field, so they keep using the default rig -- both branches are exercised this way).
      lights: [
        { name: 'key', type: 'directional', color: '#ffe3b0', intensity: 2.2, toward: [0.3, -0.6, 0.5] },
        { name: 'lamp', type: 'point', color: '#6fa8ff', intensity: 1.4, position: [-0.6, 1.1, 0.4], distance: 3, decay: 1 },
        { name: 'ambient', type: 'hemisphere', skyColor: '#5a6fd2', groundColor: '#22283a', intensity: 0.9 },
      ],
    },
    room: {
      camera: cam([1.3, 1.65, 2.1], [0, 1.0, -0.3], 46),
      plate: 'plates/room.png',
      zumi_seat: { pos: [0, 0.587, 0], rotYDeg: 24, pose: 'sit-idle' },
      look_targets: [
        { name: 'shelf', pos: [-1.6, 1.7, -1.2] },
        { name: 'plant', pos: [1.6, 0.6, -0.8] },
      ],
      occluders: [{ name: 'desk', node: 'occ_room_desk' }],
    },
  },
};

fs.mkdirSync(path.join(OUT, 'plates'), { recursive: true });
fs.writeFileSync(path.join(OUT, 'room.json'), JSON.stringify(room, null, 2));
console.log(`wrote ${path.join(OUT, 'room.json')}`);

const t0 = Date.now();
let browser;
try {
  browser = await chromium.launch({ headless: true, timeout: 60000 }); // plain 2D canvas: no WebGL/GPU args needed
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('pageerror', e.message));
  await page.setContent(PAGE_HTML);
  await page.waitForFunction(() => window.ready === true, null, { timeout: 10000 });
  for (const [name, spec] of Object.entries(PLATES)) {
    const dataUrl = await page.evaluate((s) => window.renderPlate(s), spec);
    const file = path.join(OUT, 'plates', `${name}.png`);
    fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
    console.log(`wrote ${file} (${spec.w}x${spec.h})`);
  }
  console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
} catch (e) {
  console.error('FAILED:', e.stack || e.message);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
}
