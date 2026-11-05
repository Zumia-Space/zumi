// Electron harness for the floating-mode + hologram-screen pilot (T-31 float-holo). Runs the REAL app (src/main/main.js
// from a source tree or a packed app.asar) in its own userData, in a window shown off the desktop (never over the
// owner's screen, never focused, no taskbar button), on the pinned painted room (resources-pinned/room-v2) with the
// scifi-bridge video room and a test model. Never touches an installed Zumi or its data.
//   electron scripts/electron-float-holo.cjs --app <dir | …/resources/app.asar> --out <dir> --userdata <dir> --model <file.vrm>
//     [--clip-seconds 18] [--fps 12] [--clip-mode point|rim] [--framing wide|close]
//     (--clip-mode default rim: the clip records rim, the stills still capture both; --framing default wide: the
//      whole-body crop, while `close` is the head-to-knees crop that makes the rim + the panel read -- it captures
//      the two rim stills still-rim-cyan-close.png / still-rim-amber-close.png instead of the per-mode set)
// Env: ZUMI_PILOT_LIGHT_CD overrides the screen light intensity (box tuning, passed via holo.setIntensity).
//      ZUMI_PILOT_LIGHT_MODE=point|rim captures ONE mode; unset captures BOTH (stills get a -point/-rim suffix).
//      FH_SWEEP=1 runs the r6 PARAMETER SWEEP instead of the clip/stills: the four tunables (rimMul, fresnelPower,
//      centerBackM, soleY) are set through the renderer's runtime overrides, and for each grid cell the harness
//      captures the close + full stills of BOTH accent colours (sweep-<tag>-{cyan,amber}-{close,full}.png), measures
//      rim-edge + rim-front per colour and toe-gap once (a cell passes only if cyan AND amber pass), and writes
//      <out>/sweep.csv (one column per colour metric).
//      FH_SWEEP_GRID='{"rimMul":[1,2],...}' (inline JSON) or FH_SWEEP_GRID=<file.json> replaces the grid; an axis
//      left out or malformed is an ERROR, never a silently empty sweep.
//      FH_PARAMS='{"rimStrength":3,"fresnelPower":2,"centerBackM":0.16,"soleY":0.24}' runs a normal stills/clip run with
//      ONE picked combo (the sweep's winner) applied through the renderer's runtime overrides before the float
//      settles. Keys: rimMul (alias rimStrength), fresnelPower, centerBackM, soleY -- any subset; unknown keys,
//      non-numbers and out-of-range values abort with exit 2; unset = the shipped defaults. Not combinable with
//      FH_SWEEP=1 (the sweep sets its own params). The applied combo is stored in result.json as `fhParams`.
//      FH_TALK_CLIP=1 records ONE talk-framing comparison clip (scripts/fh-clips.mjs runs it 6x on the box): the real
//      `wide` talk crop (a --framing close request exits 2), the page pinned to FH_COLOUR=cyan|amber, FH_PARAMS applied,
//      a talk loop (mouth + nods) and scripted arm gestures that cross the panel (scripts/lib/fh-clip-plan.cjs), the
//      same deterministic timeline every run (aligned virtual clock, seeded Math.random FH_SEED, float restarted at
//      that clock). Writes frames/f_%04d.png + result.json (clip.arms: overlap/travel/mouth stats; FAIL when the arms
//      never reach the panel or the mouth never moves). Defaults 8 s at 30 fps; --size WxH sets the window (1280x800).
// Writes <out>/result.json (incl. `gates`), still-*-<mode>.png and frames/f_*.png + frames/frames.ffconcat; exits 1
// on any failed gate. The r6 GATE lines (rim-edge / rim-front / toe-gap) are printed AND stored in result.gates.
//
// Clip timing is DETERMINISTIC: after the float settles we replace the page's requestAnimationFrame/performance.now
// with a virtual clock and advance exactly 1000/fps ms per captured frame. Real time (capturePage ~470 ms) no longer
// throttles the clip -- the box's earlier 2.1 fps-of-12 run came from sleeping wall time between captures.
// capturePage reports the frame the compositor LAST presented, which trails the render loop by one: sampling right
// after a light toggle read the PREVIOUS toggle's frame (fh3 point printed off 65.5% / on 14.5%, rim printed the same
// mean twice). Every A/B toggle now settles >= 2 fresh frames and waits for the reported light state, and an off/on
// pair that is still byte-identical is a "stale sample" FAIL, never a PASS.
'use strict';
require('./lib/electron-guard.cjs').exitUnlessElectronHost('electron-float-holo.cjs');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const PX = require('./lib/float-holo-pixels.cjs'); // pure luma/band/gate + sweep-grid helpers (unit-tested, no Electron)
const CP = require('./lib/fh-clip-plan.cjs'); // talk-clip timeline, aligned clock, arm/overlap stats (unit-tested, no Electron)
// R3 dev seam: the two accents the r6 sweep measured, and the fixture rows the harness feeds the panel (shape = a hud:feed row).
const ACCENT = Object.freeze({ cyan: '#39d0ff', amber: '#ffb347' }); // the two accents the r6 sweep measured (= HOLO_COLOURS in src/renderer/room/float-holo-prefs.js)
const FH_ROW = { id: 'T-FH', title: 'Render the float demo', status: 'working', stepId: 's19', stepState: 'active', stepTotal: 37, steps: [] };
const FH_FEED_A = [{ ...FH_ROW, step: 'Check the framing of the hero shot', doneCount: 19, log: [{ label: 'Receive the report', from: 'active', to: 'done' }, { label: 'Find the memory', from: 'active', to: 'done' }, { label: 'Open the browser', from: 'active', to: 'done' }] }];
const FH_FEED_B = [{ ...FH_ROW, step: 'Render the video', doneCount: 20, log: [{ label: 'Find the memory', from: 'active', to: 'done' }, { label: 'Open the browser', from: 'active', to: 'done' }, { label: 'Check the framing of the hero shot', from: 'active', to: 'done' }] }];
const { app, BrowserWindow } = require('electron');

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const ROOT = path.join(__dirname, '..');
const APP = path.resolve(arg('--app') || ROOT);
const OUT = path.resolve(arg('--out'));
const USERDATA = path.resolve(arg('--userdata'));
const TALK = process.env.FH_TALK_CLIP === '1'; // one talk-framing comparison clip (see header)
const CLIP_SECONDS = Number(arg('--clip-seconds') || (TALK ? 8 : 18));
const FPS = Number(arg('--fps') || (TALK ? 30 : 12));
const SIZE = (() => { const m = /^(\d{3,5})x(\d{3,5})$/.exec(arg('--size') || '1280x800'); return m ? { w: Number(m[1]), h: Number(m[2]) } : null; })();
const LIGHT_CD = process.env.ZUMI_PILOT_LIGHT_CD ? Number(process.env.ZUMI_PILOT_LIGHT_CD) : null;
const LIGHT_MODE = process.env.ZUMI_PILOT_LIGHT_MODE === 'rim' ? 'rim' : process.env.ZUMI_PILOT_LIGHT_MODE === 'point' ? 'point' : null;
// --framing close: the head-to-knees crop (app.js FLOAT_CLOSE) that makes the rim + the panel read. It captures ONLY
// the two rim stills with the `-close` names the brief asks for; `wide` (default) keeps the per-mode still set.
const FRAMING = arg('--framing') === 'close' ? 'close' : 'wide';
const MODES = LIGHT_MODE ? [LIGHT_MODE] : FRAMING === 'close' ? ['rim'] : ['point', 'rim'];
const CLIP_MODE = arg('--clip-mode') === 'point' ? 'point' : 'rim'; // the 18 s clip records THIS light mode (default rim); the stills still capture every MODES entry
// r6 parameter sweep (FH_SWEEP=1): no clip, no hero stills -- one CSV row per grid cell, chosen from measurements.
const SWEEP = process.env.FH_SWEEP === '1';
let FH_PARAMS = null; // one picked combo (see header); null = shipped defaults
try {
  FH_PARAMS = PX.parseFhParams(process.env.FH_PARAMS);
  if (FH_PARAMS && SWEEP) throw new Error('FH_PARAMS cannot be combined with FH_SWEEP=1 (the sweep sets its own params)');
  if (!SIZE) throw new Error('--size must be <width>x<height>, e.g. 1920x1080');
  if (TALK && SWEEP) throw new Error('FH_TALK_CLIP=1 cannot be combined with FH_SWEEP=1');
  if (TALK && arg('--framing') === 'close') throw new Error('FH_TALK_CLIP=1 records the real talk crop (wide); --framing close is the harness crop');
  if (TALK && process.env.FH_COLOUR && !CP.COLOURS.includes(process.env.FH_COLOUR)) throw new Error(`FH_COLOUR must be one of ${CP.COLOURS.join('|')}`);
} catch (e) { console.error(`ERROR ${e.message}`); process.exit(2); }
const TALK_COLOUR = process.env.FH_COLOUR === 'amber' ? 'amber' : 'cyan';
const FH_SEED = Number(process.env.FH_SEED || 1031);
const FRAMES = path.join(OUT, 'frames');
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(USERDATA, { recursive: true });
fs.mkdirSync(FRAMES, { recursive: true });

// The approved painted room, pinned in this tree; scifi-bridge video room; default 3D chair (no chair3d key).
process.env.ZUMI_ROOM_V2_DEFAULT_PATH = path.join(ROOT, 'resources-pinned', 'room-v2', 'room.json');
const settingsFile = path.join(USERDATA, 'settings.json');
if (!fs.existsSync(settingsFile)) fs.writeFileSync(settingsFile, JSON.stringify({ room: 'default-v2', uiLang: 'en', voiceEnabled: false, sceneRoom: 'scifi-bridge' }, null, 2));

app.setPath('userData', USERDATA);
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.on('browser-window-created', (_e, win) => {
  win.setSkipTaskbar(true);
  win.show = () => { win.setPosition(-32000, -32000); win.showInactive(); };
  win.maximize = () => {};
  win.focus = () => {};
});

const result = { app: APP, framing: FRAMING, checks: [], shots: [], captures: [], errors: [], modes: MODES, fhParams: FH_PARAMS };
// Every artifact the brief names, with the LIGHT MODE actually read from holo.state() at capture time (never the
// requested one), so the box can assert the clip + the two close stills really came back in rim mode.
const recordCapture = (file, mode) => result.captures.push({ file, mode });
const check = (name, ok, detail) => { result.checks.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); };
const finish = (code) => { fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(result, null, 1)); setTimeout(() => app.exit(code), 100); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 90000) {
  const t0 = Date.now();
  for (;;) {
    let v; try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`);
    await sleep(250);
  }
}

require(path.join(APP, 'src', 'main', 'main.js'));

// In-page snapshot: float state, head/foot bone NDC, the face box NDC, the panel quad NDC, and the LIVE leg pose
// (knee bend + ankle height) -- so a clip that loads but never poses the legs fails, not just a missing file.
const SNAP = `(() => {
  const s = window.__zumiScene; if (!s) return { boot: true };
  const vrm = s.getModel(); if (!vrm) return { nomodel: true };
  const cam = s.camera, THREE = s.THREE;
  const proj = (v) => v.clone().project(cam);
  const wp = (n) => { const b = vrm.humanoid.getNormalizedBoneNode(n); return b ? b.getWorldPosition(new THREE.Vector3()) : null; };
  const bone = wp;
  const ndc = (n) => { const p = bone(n); return p ? proj(p) : null; };
  const scale = (s.float && s.float.params && s.float.params.scale) || 1;
  const hp = bone('head');
  let face = null;
  if (hp) { const pts = [[-1,-1],[1,-1],[1,1],[-1,1]].map(([sx,sy]) => proj(new THREE.Vector3(hp.x+sx*0.11*scale, hp.y+sy*0.11*scale, hp.z)));
    face = { x0: Math.min(...pts.map(p=>p.x)), x1: Math.max(...pts.map(p=>p.x)), y0: Math.min(...pts.map(p=>p.y)), y1: Math.max(...pts.map(p=>p.y)) }; }
  const grp = s.scene.getObjectByName('holo-screen');
  let panel = null;
  if (grp && grp.children[0]) { const mesh = grp.children[0], g = mesh.geometry.parameters, w = g.width/2, h = g.height/2;
    mesh.updateMatrixWorld(true);
    const pts = [[-w,-h],[w,-h],[w,h],[-w,h]].map(([x,y]) => proj(mesh.localToWorld(new THREE.Vector3(x,y,0))));
    panel = { x0: Math.min(...pts.map(p=>p.x)), x1: Math.max(...pts.map(p=>p.x)), y0: Math.min(...pts.map(p=>p.y)), y1: Math.max(...pts.map(p=>p.y)) }; }
  // live knee bend: angle between the thigh line and the shin line (0 = straight) -- the float-idle pose must show one.
  const knee = (side) => { const up = wp(side+'UpperLeg'), lo = wp(side+'LowerLeg'), ft = wp(side+'Foot');
    if (!up || !lo || !ft) return null;
    const a = lo.clone().sub(up).normalize(), b = ft.clone().sub(lo).normalize();
    return Math.acos(Math.max(-1, Math.min(1, a.dot(b)))) * 180 / Math.PI; };
  const lf = wp('leftFoot'), rf = wp('rightFoot'), head = wp('head');
  const lt = wp('leftToes'), rt = wp('rightToes');
  const crownY = head ? head.y + 0.12 * scale : null;
  const height = (crownY != null && lf) ? crownY - lf.y : null;
  // r5: the gap the eye reads is under the TOE TIP (the foot plantar-flexes, so the toe hangs below the ankle bone).
  const toeY = (lt && rt) ? Math.min(lt.y, rt.y) : null;
  return { on: s.float.get(), head: ndc('head'), leftFoot: ndc('leftFoot'), rightFoot: ndc('rightFoot'), face, panel, scale, holo: s.holo.state(),
    knees: { left: knee('left'), right: knee('right') }, ankleY: lf ? lf.y : null, rightAnkleY: rf ? rf.y : null, toeY,
    height, gapPct: (toeY != null && height) ? (toeY / height * 100) : null };
})()`;
// Screen-side (lit) and far-side sample boxes, in stage-canvas CSS px. The point light sits at the screen, which is
// camera-LEFT (world -X); the right arm is on that side. Midpoint of the head and the arm = the shoulder/collar, on
// her body (not the bright video-room window behind her, which is what made the old cheek/shoulder rect read 33%
// clipped with the light OFF -- the plate is a 2D canvas and is never lit by the 3D light).
const REGION = `(() => {
  const s = window.__zumiScene, vrm = s.getModel(), cam = s.camera, THREE = s.THREE;
  const canvas = document.getElementById('stage-canvas');
  const W = canvas.clientWidth, H = canvas.clientHeight;
  const wp = (n) => vrm.humanoid.getNormalizedBoneNode(n).getWorldPosition(new THREE.Vector3());
  const px = (v) => { const p = v.clone().project(cam); return { x: (p.x+1)/2*W, y: (1-p.y)/2*H }; };
  const head = wp('head');
  const box = (mid, half) => { const pts = [[-1,-1],[1,-1],[1,1],[-1,1]].map(([sx,sy]) => px(new THREE.Vector3(mid.x+sx*half, mid.y+sy*half, mid.z)));
    const xs = pts.map(p=>p.x), ys = pts.map(p=>p.y);
    return { x: Math.max(0, Math.round(Math.min(...xs))), y: Math.max(0, Math.round(Math.min(...ys))),
      w: Math.max(4, Math.round(Math.max(...xs) - Math.min(...xs))), h: Math.max(4, Math.round(Math.max(...ys) - Math.min(...ys))) }; };
  const mid = (n) => head.clone().add(wp(n)).multiplyScalar(0.5);
  return { near: box(mid('rightUpperArm'), 0.07), far: box(mid('leftUpperArm'), 0.07) };
})()`;
const MTOON = `(() => { const vrm = window.__zumiScene.getModel(); const types = {}; let mtoon = 0;
  vrm.scene.traverse((o) => { if (!o.isMesh) return; for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
    if (!m) continue; const t = m.isMToonMaterial ? 'MToon' : (m.type || m.constructor.name); types[t] = (types[t]||0)+1; if (m.isMToonMaterial) mtoon++; } });
  return { mtoon, types }; })()`;
// ---------- r5 PIXEL gates: sample points computed IN-PAGE from the live skinned mesh, so these measure real
// pixels (the parameter-only checks in scripts/check-float-holo.mjs can never prove a render) ----------
// RIM_BAND: vertices whose |N·V| is LOW (the silhouette edge band, where MToon's fresnel rim lives) vs HIGH (a
// front-facing facet, which must stay put). The accent is toggled OFF vs ON and the captured pixels are compared.
const RIM_BAND = `(() => {
  const s = window.__zumiScene, vrm = s.getModel(), cam = s.camera, THREE = s.THREE;
  const canvas = document.getElementById('stage-canvas');
  const W = canvas.clientWidth, H = canvas.clientHeight;
  const camPos = cam.position.clone();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3(), view = new THREE.Vector3();
  const edge = [], front = [];
  vrm.scene.updateMatrixWorld(true);
  vrm.scene.traverse((o) => {
    if (!o.isMesh || !o.isSkinnedMesh) return;
    const geo = o.geometry, pos = geo.attributes.position, idx = geo.index;
    if (!pos || !idx) return;
    const triCount = Math.floor(idx.count / 3);
    const stride = Math.max(1, Math.floor(triCount / 900)); // ~900 samples per mesh: enough for a mean, cheap in-page
    for (let t = 0; t < triCount; t += stride) {
      // SKINNED world-space triangle: getVertexPosition() is bind-space (three r186), so the mesh's matrixWorld is
      // applied -- r5's unused script projected the raw bind-space point, which would have sampled the wrong pixels.
      o.getVertexPosition(idx.getX(t * 3), a).applyMatrix4(o.matrixWorld);
      o.getVertexPosition(idx.getX(t * 3 + 1), b).applyMatrix4(o.matrixWorld);
      o.getVertexPosition(idx.getX(t * 3 + 2), c).applyMatrix4(o.matrixWorld);
      // Geometric face normal of the LIVE surface (the alternative, a skinned normal matrix, can drift from what
      // is actually drawn; a face normal cannot). |N.V| low = the silhouette band the fresnel rim lives on.
      n.subVectors(b, a).cross(view.copy(c).sub(a)).normalize();
      const mid = a.clone().add(b).add(c).multiplyScalar(1 / 3);
      view.copy(camPos).sub(mid).normalize();
      const nv = n.dot(view);
      if (nv <= 0.08) continue; // back-facing -> not a visible pixel
      const p = mid.clone().project(cam);
      const px = Math.round((p.x + 1) / 2 * W), py = Math.round((1 - p.y) / 2 * H);
      if (px < 0 || px >= W || py < 0 || py >= H) continue;
      if (nv < 0.35) edge.push({ x: px, y: py }); else if (nv > 0.7) front.push({ x: px, y: py });
    }
  });
  return { w: W, h: H, edge, front };
})()`;
// TOE_FLOOR: the floor points the float gate samples -- under the TOE TIPS (the strip the eye should read as a gap),
// at the contact-shadow core (the darkest floor), and on the open floor away from her (the reference).
const TOE_FLOOR = `(() => {
  const s = window.__zumiScene, vrm = s.getModel(), cam = s.camera, THREE = s.THREE;
  const canvas = document.getElementById('stage-canvas');
  const W = canvas.clientWidth, H = canvas.clientHeight;
  const wp = (nm) => { const b = vrm.humanoid.getNormalizedBoneNode(nm); return b ? b.getWorldPosition(new THREE.Vector3()) : null; };
  const lt = wp('leftToes'), rt = wp('rightToes');
  const px = (v) => { const p = v.clone().project(cam); return { x: Math.round((p.x + 1) / 2 * W), y: Math.round((1 - p.y) / 2 * H) }; };
  const toe = (lt && rt) ? new THREE.Vector3((lt.x + rt.x) / 2, 0.002, (lt.z + rt.z) / 2) : null;
  const sh = s.scene.getObjectByName('float-shadow');
  const core = sh ? px(sh.getWorldPosition(new THREE.Vector3()).setY(0.002)) : null;
  const away = toe ? px(new THREE.Vector3(toe.x + 0.9, 0.002, toe.z)) : null;
  return { w: W, h: H, toe: toe && px(toe), core, away };
})()`;

app.whenReady().then(async () => {
  const TIMEOUT_MS = SWEEP ? 3_600_000 : TALK ? 1_800_000 : 900_000; // a sweep captures 3 stills per grid cell; the clip run stays at 15 min
  const timer = setTimeout(() => { result.errors.push(`harness timeout (${TIMEOUT_MS / 1000} s)`); finish(2); }, TIMEOUT_MS);
  try {
    const win = await until(() => BrowserWindow.getAllWindows()[0], 'main window');
    win.setContentSize(SIZE.w, SIZE.h);
    const page = win.webContents;
    page.on('console-message', (...a) => {
      let level, message;
      if (a[0] && typeof a[0] === 'object' && 'level' in a[0]) { level = a[0].level; message = a[0].message; }
      else { level = a[1]; message = a[2]; }
      if (level === 'error' || level === 3) { result.errors.push(`console: ${String(message).slice(0, 400)}`); console.log(`[renderer] ${String(message).slice(0, 300)}`); }
    });
    await until(() => !page.isLoading() && page.getURL().startsWith('app://'), 'app page loaded');
    const r = (js) => page.executeJavaScript(js, true);

    await until(() => r(`!!(window.__zumiScene && window.__zumiScene.director.room)`), 'painted v2 room loaded', 90000);
    await until(() => r(`document.getElementById('loading').hidden && document.getElementById('empty-model').hidden`), 'model on stage', 90000);
    await sleep(3000); // seat pose + spring bones settle
    // r5 pixel gates: the stage canvas rect + the window viewport (page-CSS px) map the in-page sample points onto
    // the captured bitmap (which is the viewport at the display's device scale).
    const canvasRect = await r(`(() => { const c = document.getElementById('stage-canvas').getBoundingClientRect(); return { x: c.left, y: c.top }; })()`);
    const VIEW = await r('({ w: window.innerWidth, h: window.innerHeight })');

    if (LIGHT_CD) { await r(`window.__zumiScene.holo.setIntensity(${LIGHT_CD})`); result.lightCd = LIGHT_CD; }
    await r(`window.__zumiScene.float.set(true)`);
    // R3: the panel shows the live task. The harness has no board, so ONE fixture row goes in through the dev seam (the
    // only place a fake row exists); the accent is pinned to the panel's own colour so the Settings pick never leaks into a still.
    await r(`window.__zumiScene.holo.pin(true)`);
    await r(`window.__zumiScene.holo.setFeed(${JSON.stringify(FH_FEED_A)})`);
    if (FRAMING === 'close') await r(`window.__zumiScene.float.setFraming('close')`); // head-to-knees crop (FLOAT_CLOSE)
    if (FH_PARAMS) { await r(`window.__zumiScene.float.setParams(${JSON.stringify(FH_PARAMS)})`); console.log(`FH_PARAMS applied ${JSON.stringify(FH_PARAMS)}`); }
    await sleep(2500); // float + clip settle (real frames still running here)
    // Talk clip prelude (real time, real frames still running): pin + choose the accent page and the rim mode, let the
    // 120 ms page-change glance fire and expire, so nothing time-random is left once the virtual clock takes over.
    let clockStart = null;
    if (TALK) {
      await r(`window.__zumiScene.holo.pin(true)`);
      const want = ACCENT[TALK_COLOUR];
      await r(`window.__zumiScene.holo.setPageAccent(${JSON.stringify(want)})`); await sleep(300);
      await r(`window.__zumiScene.holo.setMode('rim'); window.__zumiScene.holo.setLight(true)`);
      await sleep(800);
      clockStart = CP.alignedClockStart(await r('performance.now()'));
      result.talkClock = { clockStart, hoverLcmMs: CP.HOVER_LCM_MS };
    }

    // ---------- deterministic clock: from here on the render loop only advances via __stepFrame ----------
    await r(`(() => {
      if (window.__stepFrame) return true;
      const start = ${clockStart != null ? clockStart : 'performance.now()'};
      window.__vclock = { t: start, q: [], dt: 1000 / ${FPS} };
      performance.now = () => window.__vclock.t;
      window.__realRAF = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (cb) => { window.__vclock.q.push(cb); return window.__vclock.q.length; };
      window.__stepFrame = (dtMs) => {
        window.__vclock.t += dtMs;
        const q = window.__vclock.q; window.__vclock.q = [];
        for (const cb of q) { try { cb(window.__vclock.t); } catch (e) { console.error('stepFrame', e); } }
        return q.length;
      };
      return true;
    })()`);
    // The loop's already-scheduled real rAF fires once, calls the (now virtual) requestAnimationFrame and re-queues.
    await until(() => r('!!(window.__vclock && window.__vclock.q.length > 0)'), 'render loop registered on the virtual clock', 5000);
    const stepFrame = () => r('window.__stepFrame(window.__vclock.dt)');
    const stepMs = async (ms) => { const n = Math.max(1, Math.round(ms / (1000 / FPS))); for (let i = 0; i < n; i++) await stepFrame(); };
    const shot = async (name) => { await stepMs(60); const img = await page.capturePage(); fs.writeFileSync(path.join(OUT, name), img.toPNG()); result.shots.push(name); console.log(`shot ${name}`); };
    // A/B toggle + settle. capturePage reports the frame the compositor last presented, one behind the render loop,
    // so a capture taken immediately after a toggle came back as the PREVIOUS state. Swap the light, render at least
    // TWO new animation frames, and wait until holo.state() reports the requested light state, before any capture.
    const settleLight = async (want) => {
      await r(`window.__zumiScene.holo.setLight(${want})`);
      await stepFrame(); await stepFrame();
      await until(async () => (await r('window.__zumiScene.holo.state()')).lightOn === want, `holo light ${want ? 'on' : 'off'}`, 5000);
    };

    let snap = await r(SNAP);
    check('float: the mode is on', snap.on === 'float', snap.on);
    check('float: the panel exists and is visible', snap.panel && snap.holo && snap.holo.visible === true, snap.holo);

    // ---------- r6 PIXEL gates (shared by the still run and the sweep) ----------
    // One GATE line per metric, printed in the brief's exact format and stored in result.gates. `gateCheck` also
    // records it as a normal check, so a FAILING gate exits 1 -- the r5 harness defined the helpers and never
    // called them, which is exactly what this block replaces.
    const gateCheck = (line, ok, detail) => { result.checks.push({ name: line, ok: Boolean(ok), detail }); console.log(`${line}${ok ? '' : `  ${JSON.stringify(detail)}`}`); };
    const canvasOrigin = () => r(`(() => { const c = document.getElementById('stage-canvas').getBoundingClientRect(); return { x: c.left, y: c.top }; })()`);
    const viewSize = () => r('({ w: window.innerWidth, h: window.innerHeight })');
    const saveShot = (img, name) => { fs.writeFileSync(path.join(OUT, name), img.toPNG()); result.shots.push(name); };
    let liveFraming = FRAMING; // the framing ACTUALLY live (the sweep switches it), not the launch arg
    const setFraming = async (f) => {
      if (liveFraming === f) return;
      await r(`window.__zumiScene.float.setFraming(${JSON.stringify(f)})`);
      await stepMs(400); // the crop preset is read per frame; give the camera + plate a few virtual frames
      liveFraming = f;
    };
    // The light toggle is the SAME settle contract as the still A/B (2 fresh frames + the reported state); the extra
    // 300 ms of virtual frames lets the rim crossfade (250 ms) finish, so a half-faded tint cannot flatter a gate.
    const setGateLight = async (want) => {
      await r(`window.__zumiScene.holo.setLight(${want})`);
      await stepFrame(); await stepFrame();
      await until(async () => (await r('window.__zumiScene.holo.state()')).lightOn === want, `gate light ${want ? 'on' : 'off'}`, 5000);
      await stepMs(300);
    };
    const cyanPage = async () => { await r(`window.__zumiScene.holo.setPageAccent(${JSON.stringify(ACCENT.cyan)})`); await stepMs(500); };
    // amber is the second accent the r6 sweep measured; anything else means the colour under test is wrong.
    const amberPage = async () => {
      await cyanPage();
      await r(`window.__zumiScene.holo.setPageAccent(${JSON.stringify(ACCENT.amber)})`); await stepMs(500);
      const h = (await r(SNAP)).holo;
      if (h.pageAccent !== ACCENT.amber) throw new Error(`amber expected pageAccent ${ACCENT.amber}, got ${h.pageAccent}`);
    };
    /** All metrics for the CURRENT parameters/pose, for BOTH accent colours. rim-edge/rim-front come from a rim
     *  ON-vs-OFF pair per colour in the CLOSE framing (the crop the brief measures the rim in); toe-gap comes ONCE
     *  from the cyan FULL framing, because the close crop deliberately puts the feet below the frame -- reading it
     *  there would be a fake FAIL. A run/cell passes only if cyan AND amber pass (gates.pass).
     *  @param saveAs when set, <saveAs>-{cyan,amber}-{close,full}.png are written */
    const measureGates = async ({ saveAs = null } = {}) => {
      const startFraming = liveFraming;
      await r(`window.__zumiScene.holo.setMode('rim')`);
      await setFraming('close');
      await cyanPage();
      const band = await r(RIM_BAND);
      const origin = await canvasOrigin();
      const view = await viewSize();
      const edgePts = PX.offsetPts(band.edge, origin.x, origin.y);
      const frontPts = PX.offsetPts(band.front, origin.x, origin.y);
      const pair = async (colour) => {
        await setGateLight(false);
        const off = bitmapOf(await page.capturePage());
        await setGateLight(true);
        const onImg = await page.capturePage();
        if (saveAs) saveShot(onImg, `${saveAs}-${colour}-close.png`);
        return { off, on: bitmapOf(onImg) };
      };
      const cyan = await pair('cyan');
      await amberPage();
      const amber = await pair('amber');
      await setFraming('wide'); // light stays ON; amber page still live
      if (saveAs) saveShot(await page.capturePage(), `${saveAs}-amber-full.png`);
      await cyanPage();
      const fullImg = await page.capturePage();
      if (saveAs) saveShot(fullImg, `${saveAs}-cyan-full.png`);
      const floor = await r(TOE_FLOOR);
      const toe = floor.toe ? { x: floor.toe.x + origin.x, y: floor.toe.y + origin.y } : null;
      const core = floor.core ? { x: floor.core.x + origin.x, y: floor.core.y + origin.y } : null;
      const gates = PX.computeColourGates({ cyan, amber, full: bitmapOf(fullImg), edgePts, frontPts, toe, core, cssW: view.w, cssH: view.h });
      gates.samples = { edge: edgePts.length, front: frontPts.length, toe, core };
      await setFraming(startFraming); // the caller's framing stays live (the close run's own gates read it)
      return gates;
    };
    const printGates = (gates) => {
      const lines = PX.formatColourGateLines(gates);
      gateCheck(lines[0], gates.rimEdge.pass, gates.rimEdge);
      gateCheck(lines[1], gates.rimFront.pass, gates.rimFront);
      gateCheck(lines[2], gates.toeGap.pass, gates.toeGap);
      gateCheck(lines[3], gates.amber.rimEdge.pass, gates.amber.rimEdge);
      gateCheck(lines[4], gates.amber.rimFront.pass, gates.amber.rimFront);
    };

    // ---------- r6 TALK CLIP: FH_TALK_CLIP=1 -- the real talk crop, a talk loop + arm gestures, one accent ----------
    if (TALK) {
      const totalFrames = Math.round(CLIP_SECONDS * FPS);
      await r(`(() => { const mk = ${CP.mulberry32.toString()}; Math.random = mk(${FH_SEED}); })()`);
      // Neutral life (no blinks/glances/idle variety: holdNeutral also stops every clip), then restart the float at the
      // aligned virtual clock so its legs clip phase and the clock-locked hover bob are identical in every run. The
      // virtual rAF only advances through stepFrame, so pump frames while the async float.set(true) resolves.
      await r(`window.__zumiScene.holdNeutral()`);
      const restart = r(`window.__zumiScene.float.set(true)`);
      let restarted = false;
      restart.then(() => { restarted = true; }, () => { restarted = true; });
      for (let i = 0; i < 400 && !restarted; i++) await stepFrame();
      await restart;
      await stepMs(1500); // legs clip + springs + shadow settle on the virtual clock
      snap = await r(SNAP);
      const kneeLive = snap.knees && snap.knees.left >= 25 && snap.knees.right >= 25;
      check(`talk clip: the float legs are live after the restart (knees L ${snap.knees && snap.knees.left != null ? snap.knees.left.toFixed(1) : '?'} R ${snap.knees && snap.knees.right != null ? snap.knees.right.toFixed(1) : '?'} deg, >= 25)`, kneeLive, snap.knees);
      check(`talk clip: accent ${TALK_COLOUR} (${ACCENT[TALK_COLOUR]}), rim mode, light on`, snap.holo && snap.holo.pageAccent === ACCENT[TALK_COLOUR] && snap.holo.mode === 'rim' && snap.holo.lightOn === true, snap.holo);
      check('talk clip: the talk crop is the real wide float framing', liveFraming === 'wide', liveFraming);
      const ARM_PROBE = `(() => {
        const s = window.__zumiScene, vrm = s.getModel(), cam = s.camera, THREE = s.THREE;
        const pt = (n) => { const b = vrm.humanoid.getNormalizedBoneNode(n); if (!b) return null; const p = b.getWorldPosition(new THREE.Vector3()).project(cam); return { x: p.x, y: p.y }; };
        const pts = {}; for (const n of ${JSON.stringify(CP.ARM_PROBE_POINTS)}) pts[n] = pt(n);
        const grp = s.scene.getObjectByName('holo-screen'); let panel = null;
        if (grp && grp.children[0]) { const mesh = grp.children[0], g = mesh.geometry.parameters, w = g.width / 2, h = g.height / 2; mesh.updateMatrixWorld(true);
          const q = [[-w,-h],[w,-h],[w,h],[-w,h]].map(([x, y]) => mesh.localToWorld(new THREE.Vector3(x, y, 0)).project(cam));
          panel = { x0: Math.min(...q.map((p) => p.x)), x1: Math.max(...q.map((p) => p.x)), y0: Math.min(...q.map((p) => p.y)), y1: Math.max(...q.map((p) => p.y)) }; }
        const em = vrm.expressionManager; const aa = em && em.getValue ? em.getValue('aa') : null;
        return { pts, panel, aa };
      })()`;
      const timeline = CP.talkTimeline(CLIP_SECONDS * 1000);
      const verdicts = [], samples = [], frames = [], hashes = new Set();
      let imgSize = null;
      const v0 = await r('performance.now()');
      for (let i = 0; i < totalFrames; i++) {
        // a command starts exactly at the current virtual time: no frame runs between the IPC round trip and the step
        for (const cmd of CP.commandsAtFrame(timeline, i, FPS)) {
          const res = await r(`window.zumi.playGesture(${JSON.stringify(cmd)})`);
          verdicts.push({ frame: i, id: cmd.id, ok: Boolean(res && res.ok), errors: res && res.errors, warnings: res && res.warnings });
        }
        await stepFrame();
        samples.push(await r(ARM_PROBE));
        const img = await page.capturePage();
        if (!imgSize) imgSize = img.getSize();
        const png = img.toPNG();
        const name = `f_${String(i).padStart(4, '0')}.png`;
        fs.writeFileSync(path.join(FRAMES, name), png);
        hashes.add(crypto.createHash('sha1').update(png).digest('hex'));
        frames.push(name);
      }
      const v1 = await r('performance.now()');
      const stats = CP.armStats(samples);
      const view = await viewSize();
      result.clip = { talk: true, colour: TALK_COLOUR, params: FH_PARAMS, framing: 'wide', frames: frames.length, fps: FPS, seconds: +(frames.length / FPS).toFixed(2), virtualSeconds: +((v1 - v0) / 1000).toFixed(2),
        distinctFrames: hashes.size, size: imgSize, viewport: view, seed: FH_SEED, clockStart, arms: stats, gestures: verdicts };
      check(`talk clip: ${frames.length}/${totalFrames} frames at exactly ${FPS} fps (${result.clip.seconds}s; virtual +${result.clip.virtualSeconds}s, ${hashes.size} distinct)`, frames.length === totalFrames && Math.abs((v1 - v0) / 1000 - CLIP_SECONDS) < CLIP_SECONDS * 0.05 && hashes.size >= Math.ceil(totalFrames * 0.5), result.clip);
      check(`talk clip: captured at ${imgSize.width}x${imgSize.height} (viewport ${view.w}x${view.h})`, imgSize.width >= 640, imgSize);
      check(`talk clip: all ${verdicts.length} talk/arm commands were accepted by the validator`, verdicts.length > 0 && verdicts.every((v) => v.ok), verdicts.filter((v) => !v.ok));
      check(`talk clip: the arms moved (max hand travel ${stats.maxTravelNdc.toFixed(2)} NDC, >= ${CP.MIN_ARM_TRAVEL_NDC})`, stats.armsMoved, stats);
      check(`talk clip: an arm/hand is over the panel in ${(stats.overlapShare * 100).toFixed(0)}% of the frames (>= ${CP.MIN_OVERLAP_FRAME_SHARE * 100}%)`, stats.overlapOk, stats);
      check(`talk clip: the mouth moves (aa ${stats.mouthAaMin == null ? '?' : stats.mouthAaMin.toFixed(2)}..${stats.mouthAaMax == null ? '?' : stats.mouthAaMax.toFixed(2)})`, stats.mouthMoved, stats);
      check('talk clip: zero console errors', result.errors.filter((e) => /^console:/.test(e)).length === 0, result.errors);
      clearTimeout(timer);
      finish(result.checks.every((x) => x.ok) ? 0 : 1);
      return;
    }

    // ---------- r6 SWEEP: FH_SWEEP=1 -- measure the 3 gates per grid cell, no clip ----------
    if (SWEEP) {
      const grid = PX.parseSweepGrid(process.env.FH_SWEEP_GRID, (f) => fs.readFileSync(f, 'utf8'));
      const combos = PX.sweepCombos(grid);
      result.sweep = { grid, cells: combos.length, rows: [] };
      await r(`window.__zumiScene.float.setFraming('close')`); // the rim must be measured where it is visible
      await r(`window.__zumiScene.freeze()`); // one pose for every cell: the params are the only variable
      await stepMs(500);
      console.log(`sweep: ${combos.length} cells, grid ${JSON.stringify(grid)}`);
      const lines = [PX.SWEEP_CSV_HEADER];
      for (let i = 0; i < combos.length; i++) {
        const c = combos[i];
        const tag = `r${c.rimMul}_p${c.fresnelPower}_b${c.centerBackM}_s${c.soleY}`;
        await r(`window.__zumiScene.float.setParams(${JSON.stringify(c)})`);
        await stepMs(500); // re-place (soleY) + shadow move + rim tint settle, all on the virtual clock
        const g = await measureGates({ saveAs: `sweep-${tag}` });
        const row = { ...PX.sweepRow(c, tag, g), samples: g.samples };
        result.sweep.rows.push(row);
        lines.push(PX.sweepCsvLine(row));
        const f1 = (v) => (v == null ? 'n/a' : Number(v).toFixed(1));
        console.log(`sweep ${i + 1}/${combos.length} ${tag}: edge cyan ${f1(row.rimEdgeCyanGainPct)}% amber ${f1(row.rimEdgeAmberGainPct)}% | front cyan ${f1(row.rimFrontCyanGainPct)}% amber ${f1(row.rimFrontAmberGainPct)}% | toe-gap ${f1(row.toeGapPx)}px | ${row.cellPass ? 'PASS' : 'fail'}`);
      }
      fs.writeFileSync(path.join(OUT, 'sweep.csv'), lines.join('\n') + '\n');
      result.sweep.csv = 'sweep.csv';
      // A cell with an UNMEASURABLE metric is an instrument failure (off-frame sample), not a slow parameter: fail.
      const broken = result.sweep.rows.filter(PX.sweepRowBroken);
      check(`sweep: every cell produced all 5 metrics (cyan+amber edge/front, toe; ${combos.length} cells, ${broken.length} broken)`, broken.length === 0, broken.map((x) => x.tag));
      await r(`window.__zumiScene.thaw()`);
      clearTimeout(timer);
      finish(broken.length ? 1 : 0);
      return;
    }

    // ---------- clip: fixed timestep, 12 fps x 18 s, page change at 3/9/15 s of VIRTUAL time ----------
    await r(`window.__zumiScene.holo.setMode(${JSON.stringify(CLIP_MODE)})`);
    const totalFrames = Math.round(CLIP_SECONDS * FPS);
    const frames = [];
    const hashes = new Set();
    const ySamples = []; // the root's Y each virtual frame -- the runtime hover bob (cheap-win-2 assertion)
    const changeFrames = new Set([3, 9, 15].map((sec) => Math.round(sec * FPS)));
    let changeN = 0;
    const v0 = await r('performance.now()'); // virtual clock before the loop
    for (let i = 0; i < totalFrames; i++) {
      if (changeFrames.has(i)) await r(`window.__zumiScene.holo.setFeed(${JSON.stringify(changeN++ % 2 ? FH_FEED_A : FH_FEED_B)})`); // R3: a content change (the step moves on) = the flicker the old page flip gave
      await stepFrame();
      ySamples.push(await r(`window.__zumiScene.getModel().scene.position.y`));
      const img = await page.capturePage();
      const png = img.toPNG();
      const name = `f_${String(i).padStart(4, '0')}.png`;
      fs.writeFileSync(path.join(FRAMES, name), png);
      hashes.add(crypto.createHash('sha1').update(png).digest('hex'));
      frames.push(name);
    }
    const v1 = await r('performance.now()'); // virtual clock after the loop
    let ff = 'ffconcat version 1.0\n';
    for (const name of frames) ff += `file ${name}\nduration ${(1 / FPS).toFixed(4)}\n`;
    ff += `file ${frames[frames.length - 1]}\n`;
    fs.writeFileSync(path.join(FRAMES, 'frames.ffconcat'), ff);
    result.clip = { frames: frames.length, seconds: +(frames.length / FPS).toFixed(2), fps: FPS, requestedFps: FPS, mode: CLIP_MODE, virtualSeconds: +((v1 - v0) / 1000).toFixed(2), distinctFrames: hashes.size };
    // the mode ACTUALLY active during the clip (holo.state().mode), not the requested one: the box names the mp4
    // from clip.mode, and the capture gate below compares these records to the intended mode.
    result.clip.mode = (await r('window.__zumiScene.holo.state()')).mode;
    recordCapture(`float-holo-clip-${result.clip.mode}.mp4`, result.clip.mode);
    // frame count alone is tautological (the loop runs exactly totalFrames); also require the VIRTUAL clock to have
    // advanced by ~clip-seconds AND the frames to actually differ (a stalled clip would repeat one image).
    const timeOk = Math.abs((v1 - v0) / 1000 - CLIP_SECONDS) < CLIP_SECONDS * 0.05;
    const motionOk = hashes.size >= Math.ceil(totalFrames * 0.5);
    check(`clip: ${frames.length} frames at exactly ${FPS} fps by a fixed timestep (${result.clip.seconds}s; virtual +${result.clip.virtualSeconds}s, ${hashes.size} distinct frames)`, frames.length === totalFrames && timeOk && motionOk, result.clip);
    // runtime hover bob: the root Y sampled over the clip's virtual frames. Half the peak-to-peak is the amplitude;
    // the brief asks for +-2-3 cm over a 3-4 s period (float-mode.js HOVER_AMPLITUDE_M / HOVER_PERIOD_S).
    const bobAmp = (Math.max(...ySamples) - Math.min(...ySamples)) / 2;
    result.bob = { amplitudeM: +bobAmp.toFixed(4), rangeM: +(Math.max(...ySamples) - Math.min(...ySamples)).toFixed(4) };
    check(`float: the runtime hover bob is ~2-3 cm (measured ${(bobAmp * 100).toFixed(1)} cm over ${CLIP_SECONDS}s of virtual frames)`, bobAmp >= 0.02 && bobAmp <= 0.033, result.bob);

    // ---------- stills ----------
    // close framing: the two rim stills the brief asks for (head-to-knees crop). wide (default): the per-mode set
    // (suffix -point / -rim) + the light A/B, unchanged.
    await r(`window.__zumiScene.freeze()`);
    if (FRAMING === 'close') {
      await r(`window.__zumiScene.holo.setMode('rim')`);
      await r(`window.__zumiScene.holo.setPageAccent(${JSON.stringify(ACCENT.cyan)})`); await stepMs(300);
      await stepMs(400);
      await shot(`still-rim-cyan-close.png`); recordCapture(`still-rim-cyan-close.png`, (await r(SNAP)).holo.mode);
      await r(`window.__zumiScene.holo.setPageAccent(${JSON.stringify(ACCENT.amber)})`);
      await stepMs(300);
      await shot(`still-rim-amber-close.png`); recordCapture(`still-rim-amber-close.png`, (await r(SNAP)).holo.mode);
      snap = await r(SNAP);
      check(`[rim/close] still-2: the accent changed to amber`, snap.holo && snap.holo.accent === ACCENT.amber, snap.holo && snap.holo.accent);
      check(`[rim/close] the panel rect does not overlap the face box`, !overlap(snap.panel, snap.face), { panel: snap.panel, face: snap.face });
      result.ab = result.ab || {}; result.ab.rim = { framing: 'close', panel: snap.panel, face: snap.face };
    } else {
    for (const mode of MODES) {
      await r(`window.__zumiScene.holo.setMode(${JSON.stringify(mode)})`);
      // settle on the cyan page (page 0) for a clean first still
      await r(`window.__zumiScene.holo.setPageAccent(${JSON.stringify(ACCENT.cyan)})`); await stepMs(300);
      await stepMs(400);
      await shot(`still-1-cyan-${mode}.png`);
      await r(`window.__zumiScene.holo.setPageAccent(${JSON.stringify(ACCENT.amber)})`);
      await stepMs(300);
      await shot(`still-2-amber-${mode}.png`);
      snap = await r(SNAP);
      check(`[${mode}] still-2: the accent changed to amber`, snap.holo && snap.holo.accent === ACCENT.amber, snap.holo && snap.holo.accent);

      // still-3 A/B: freezer holds one pose; light OFF vs ON, composed side by side in-page
      const before = await r(SNAP);
      check(`[${mode}] still-3: the panel rect does not overlap the face box`, !overlap(before.panel, before.face), { panel: before.panel, face: before.face });
      await settleLight(false);
      const offImg = await page.capturePage(); const offUrl = offImg.toDataURL();
      await settleLight(true);
      const onImg = await page.capturePage(); const onUrl = onImg.toDataURL();
      const abUrl = await r(`(async () => {
        const load = (u) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = u; });
        const [a, b] = await Promise.all([load(${JSON.stringify(offUrl)}), load(${JSON.stringify(onUrl)})]);
        const c = document.createElement('canvas'); c.width = a.width + b.width; c.height = Math.max(a.height, b.height);
        const g = c.getContext('2d'); g.drawImage(a, 0, 0); g.drawImage(b, a.width, 0);
        return c.toDataURL('image/png');
      })()`);
      fs.writeFileSync(path.join(OUT, `still-3-ab-${mode}.png`), Buffer.from(String(abUrl).split(',')[1], 'base64'));
      result.shots.push(`still-3-ab-${mode}.png`);

      // A/B pixel gate over the screen-side shoulder and the far side, sampled by re-toggling the effect
      const region = await r(REGION);
      const canvasRect = await r(`(() => { const c = document.getElementById('stage-canvas').getBoundingClientRect(); return { x: c.left, y: c.top }; })()`);
      const cropOf = (b) => ({ x: Math.max(0, Math.round(canvasRect.x + b.x)), y: Math.max(0, Math.round(canvasRect.y + b.y)), width: b.w, height: b.h });
      const accent = (await r(SNAP)).holo.accent;
      const dom = dominantChannel(accent);
      await settleLight(false);
      const offNear = await sampleRegion(page, cropOf(region.near), dom);
      const offFar = await sampleRegion(page, cropOf(region.far), dom);
      await settleLight(true);
      const onNear = await sampleRegion(page, cropOf(region.near), dom);
      const onFar = await sampleRegion(page, cropOf(region.far), dom);
      const detail = { dom, near: { off: offNear, on: onNear }, far: { off: offFar, on: onFar } };
      // Stale-sample gate: settleLight() waits for fresh frames, and this backstop FAILs (never PASSes) when the
      // off and on samples are still byte-identical -- i.e. the WHOLE sampled area did not change, so the frame
      // never advanced (fh3's lag made a naive clip gate PASS a stale pair). A single region that is genuinely
      // invariant to the effect (rim mode: the point light is off, the near-side box does not move) does NOT trip
      // it -- only a fully unchanged pair does.
      const stale = offNear.hash === onNear.hash && offFar.hash === onFar.hash;
      check(`[${mode}] A/B: the off and on samples are not byte-identical`, !stale, stale ? 'stale sample' : { nearDiffers: offNear.hash !== onNear.hash, farDiffers: offFar.hash !== onFar.hash });
      if (mode === 'point') {
        check(`[point] A/B near-side: mean of the accent's dominant channel changes by >= 12/255 (off ${offNear.mean.toFixed(1)} on ${onNear.mean.toFixed(1)})`, Math.abs(onNear.mean - offNear.mean) >= 12, detail);
        check(`[point] A/B near-side: blown share with the light ON is at most the OFF share + 5 points (off ${(offNear.clip * 100).toFixed(1)}% on ${(onNear.clip * 100).toFixed(1)}%)`, onNear.clip <= offNear.clip + 0.05, detail);
        check(`[point] A/B far-side: changes less than the near side (far ${Math.abs(onFar.mean - offFar.mean).toFixed(1)} < near ${Math.abs(onNear.mean - offNear.mean).toFixed(1)})`, Math.abs(onFar.mean - offFar.mean) < Math.abs(onNear.mean - offNear.mean), detail);
      } else {
        check(`[rim] rim-only: blown share with the effect ON is at most the OFF share + 5 points (off ${(offNear.clip * 100).toFixed(1)}% on ${(onNear.clip * 100).toFixed(1)}%)`, onNear.clip <= offNear.clip + 0.05, detail);
      }
      result.ab = result.ab || {}; result.ab[mode] = detail;
    }
    }
    // ---------- r6 pixel gates on the A/B stills: rim ON vs OFF, then the full-framing floor strip ----------
    // Runs while the pose is still frozen (the stills' own contract), so the only difference between OFF and ON
    // is the light. result.gates keeps the raw numbers for the review seat.
    result.gates = await measureGates({ saveAs: 'gate' });
    printGates(result.gates);

    await r(`window.__zumiScene.thaw()`);
    if (FRAMING !== 'close') {
      // optional still-4: HUD style B (first mode only)
      await r(`(() => { const el = document.getElementById('hud-style'); el.value = 'b'; el.dispatchEvent(new Event('change')); })()`);
      await stepMs(200);
      await shot(`still-4-hud-b-${MODES[0]}.png`);
    }

    // ---------- gates ----------
    snap = await r(SNAP);
    check('gates: head bone NDC inside the frame with a 5% top margin', snap.head && snap.head.x >= -1 && snap.head.x <= 1 && snap.head.y <= 0.9 && snap.head.y >= -1, snap.head);
    if (FRAMING === 'close') {
      // close framing is a head-to-knees crop: the feet are DELIBERATELY below the frame (the whole point).
      check('gates[close]: the feet are cropped below the frame (head-to-knees crop)', snap.leftFoot && snap.leftFoot.y < -1 && snap.rightFoot && snap.rightFoot.y < -1, { leftFoot: snap.leftFoot, rightFoot: snap.rightFoot });
    } else {
      check('gates: foot bone NDC inside the frame with an 8% bottom margin', snap.leftFoot && snap.leftFoot.y >= -0.84 && snap.leftFoot.y <= 1 && snap.rightFoot && snap.rightFoot.y >= -0.84, { leftFoot: snap.leftFoot, rightFoot: snap.rightFoot });
    }
    const kneeOk = snap.knees && snap.knees.left >= 25 && snap.knees.right >= 25;
    check(`float: a live knee bend of >= 25deg on BOTH legs (L ${snap.knees && snap.knees.left != null ? snap.knees.left.toFixed(1) : '?'}deg, R ${snap.knees && snap.knees.right != null ? snap.knees.right.toFixed(1) : '?'}deg)`, kneeOk, snap.knees);
    check(`float: feet hang above the floor with a visible gap (ankle ${snap.ankleY != null ? snap.ankleY.toFixed(3) : '?'} m = ${snap.gapPct != null ? snap.gapPct.toFixed(1) : '?'}% of her height, >= 8%)`, snap.gapPct != null && snap.gapPct >= 8, { ankleY: snap.ankleY, height: snap.height, gapPct: snap.gapPct });
    const mt = await r(MTOON);
    result.materials = mt;
    check('gates: at least one MToon material on the model', mt.mtoon > 0, mt);
    // the mode actually active at capture time for every artifact, recorded in result.json (the brief: rim for the
    // clip + both close stills).
    if (FRAMING === 'close') check(`capture[close]: the clip + both close stills are rim (${result.captures.map((c) => `${c.file}:${c.mode}`).join(', ')})`, result.captures.length === 3 && result.captures.every((c) => c.mode === 'rim'), result.captures);
    else check(`capture: the clip is ${CLIP_MODE} (${result.captures.map((c) => `${c.file}:${c.mode}`).join(', ')})`, result.captures.every((c) => c.mode === CLIP_MODE), result.captures);
    check('gates: zero console errors', result.errors.filter((e) => /^console:/.test(e)).length === 0, result.errors);
    result.final = { float: snap.holo && snap.holo.mode, ankleY: snap.ankleY, gapPct: snap.gapPct, knees: snap.knees, head: snap.head, leftFoot: snap.leftFoot, rightFoot: snap.rightFoot };

    clearTimeout(timer);
    finish(result.checks.every((x) => x.ok) ? 0 : 1);
  } catch (e) {
    result.errors.push(String((e && e.stack) || e));
    console.log(`ERROR ${e && e.message}`);
    clearTimeout(timer);
    finish(2);
  }
});

function overlap(a, b) { return a && b && a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0; }
function dominantChannel(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
  if (!m) return 0;
  const rgb = [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
  return rgb.indexOf(Math.max(...rgb)); // 0=R 1=G 2=B
}
async function sampleRegion(page, rect, channel) {  const img = await page.capturePage(rect);
  const bmp = img.toBitmap(); const { width, height } = img.getSize(); // BGRA
  const ci = [2, 1, 0][channel]; // R->2, G->1, B->0 in BGRA
  let sum = 0, n = 0, clip = 0;
  for (let i = 0; i < width * height; i++) {
    const b = bmp[i * 4], g = bmp[i * 4 + 1], r = bmp[i * 4 + 2];
    sum += ci === 0 ? b : ci === 1 ? g : r; n++;
    if (b >= 250 || g >= 250 || r >= 250) clip++;
  }
  const hash = crypto.createHash('sha1').update(bmp).digest('hex'); // identity of the captured frame (stale-sample gate)
  return { mean: n ? sum / n : 0, clip: n ? clip / n : 1, size: { width, height }, hash };
}
// ---------- r5 PIXEL helpers: read a whole-window capture at page-CSS points (scaled to the bitmap's device size) --
function bitmapOf(img) { const { width, height } = img.getSize(); return { buf: img.toBitmap(), width, height }; }
// The luma/band/gate maths lives in scripts/lib/float-holo-pixels.cjs (PX), so check-float-holo.mjs unit-tests the
// SAME code with synthetic images. bitmapOf is the only adapter here: Electron NativeImage -> { buf, width, height }.
