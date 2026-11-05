// Electron harness for the 3D chair concept (T-31 chair3d, 13-10). Runs the REAL app (src/main/main.js from a source
// tree or a packed app.asar) in its own userData, in a window shown off the desktop (never over the owner's screen,
// never focused, no taskbar button), with the pinned painted room (resources-pinned/room-v2). Never touches an
// installed Zumi or its data.
//   electron scripts/electron-chair3d.cjs --out <dir> --userdata <dir> [--app <dir | …/app.asar>] [--only <id,id>]
// Per chair ('painted' first, then every chairs.json id):
//   chair-<id>-talk.png         the real app window at the talk camera (1280x800 window, chest-up crop)
//   chair-<id>-qc-front.png     WebGL only (no plate, desk occluders off), low front camera on hips/armrests
//   chair-<id>-qc-side.png      the same from her right side (backrest contact, thighs on the seat, boots)
//   chair-<id>-qc-34.png        three-quarter view
// and the QC numbers (scale vs the chair; skinned-vertex intersections with the chair mesh) in <out>/result.json.
'use strict';
// Runs inside Electron: render box only (scripts/lib/electron-guard.cjs), refused (exit 1, no dialog) before the app starts.
require('./lib/electron-guard.cjs').exitUnlessElectronHost('electron-chair3d.cjs');
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow } = require('electron');

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const ROOT = path.join(__dirname, '..');
const APP = path.resolve(arg('--app') || ROOT);
const OUT = path.resolve(arg('--out'));
const USERDATA = path.resolve(arg('--userdata'));
const ONLY = arg('--only') ? arg('--only').split(',') : null;
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(USERDATA, { recursive: true });

process.env.ZUMI_ROOM_V2_DEFAULT_PATH = path.join(ROOT, 'resources-pinned', 'room-v2', 'room.json');
const settingsFile = path.join(USERDATA, 'settings.json');
fs.writeFileSync(settingsFile, JSON.stringify({ room: 'default-v2', uiLang: 'en', chair3d: 'painted' }, null, 2));

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

const result = { app: APP, checks: [], shots: [], qc: {}, errors: [] };
const check = (name, ok, detail) => { result.checks.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); };
const finish = (code) => { fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(result, null, 1)); setTimeout(() => app.exit(code), 100); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 60000) {
  const t0 = Date.now();
  for (;;) {
    let v; try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`);
    await sleep(250);
  }
}

// In-page QC, evaluated after a chair is applied and the pose has settled. Uses only what app.js exposes on
// window.__zumiScene in a dev run (never in a packaged build), incl. its THREE namespace.
const QC_JS = `(async () => {
  const z = window.__zumiScene, vrm = z.getModel(), sf = z.seatFit, chair = z.chair3d;
  const V = z.THREE.Vector3;
  const nb = (n) => vrm.humanoid.getNormalizedBoneNode(n);
  const wp = (n) => { const b = nb(n); return b ? b.getWorldPosition(new V()) : null; };
  vrm.scene.updateMatrixWorld(true);
  const out = { chair: chair.entry ? chair.entry.id : 'painted', chairScale: chair.attached ? chair.scale : null, lean: sf.lean, last: sf.last && { legs: Object.fromEntries(Object.entries(sf.last.legs || {}).map(([k, l]) => [k, { thighDeg: l.thighDeg, hang: l.hang, knee: l.K.toArray().map((v) => +v.toFixed(3)), ankle: l.A.toArray().map((v) => +v.toFixed(3)) }])) } };
  out.model = { scale: vrm.scene.scale.x, clearance: sf.model.clearance, rearDepth: sf.model.rearDepth, L1: sf.model.L1, L2: sf.model.L2, ankleY: sf.model.ankleY };
  // skinned vertices, world space, with their dominant bone name
  const verts = [];
  const p = new V();
  vrm.scene.traverse((o) => {
    if (!o.isSkinnedMesh || !o.visible) return;
    const g = o.geometry, sI = g.attributes.skinIndex, sW = g.attributes.skinWeight;
    const names = o.skeleton.bones.map((b) => b.name);
    for (let i = 0; i < g.attributes.position.count; i++) {
      o.getVertexPosition(i, p).applyMatrix4(o.matrixWorld);
      let b = 0; for (let k = 1; k < 4; k++) if (sW.getComponent(i, k) > sW.getComponent(i, b)) b = k;
      verts.push({ x: p.x, y: p.y, z: p.z, bone: names[sI.getComponent(i, b)] || '?' });
    }
  });
  const minY = Math.min(...verts.map((v) => v.y)), maxY = Math.max(...verts.map((v) => v.y));
  const sh = [wp('leftUpperArm'), wp('rightUpperArm')];
  const hips = [wp('leftUpperLeg'), wp('rightUpperLeg')];
  out.body = { headTopY: +maxY.toFixed(3), lowestY: +minY.toFixed(3), shoulderY: +((sh[0].y + sh[1].y) / 2).toFixed(3), hipJointY: +((hips[0].y + hips[1].y) / 2).toFixed(3), hipJointZ: +((hips[0].z + hips[1].z) / 2).toFixed(3),
    elbowY: +(((wp('leftLowerArm') || sh[0]).y + (wp('rightLowerArm') || sh[1]).y) / 2).toFixed(3), elbowX: [+(wp('leftLowerArm') || sh[0]).x.toFixed(3), +(wp('rightLowerArm') || sh[1]).x.toFixed(3)],
    kneeY: +(((wp('leftLowerLeg')).y + (wp('rightLowerLeg')).y) / 2).toFixed(3), ankleY: +(((wp('leftFoot')).y + (wp('rightFoot')).y) / 2).toFixed(3) };
  const footV = verts.filter((v) => /foot|toe/i.test(v.bone));
  out.body.footLowestY = footV.length ? +Math.min(...footV.map((v) => v.y)).toFixed(3) : null;
  out.body.footRearZ = footV.length ? +Math.min(...footV.map((v) => v.z)).toFixed(3) : null;
  if (!chair.attached) return out;
  const T = z.THREE, box = new T.Box3(); chair.group.traverse((o) => { if (o.isMesh && o.name !== 'chair3d-contact-shadow') box.expandByObject(o); });
  const e = chair.entry, cf = sf.chairFit.talk;
  out.chairWorld = { fwd: +cf.chairFwd.toFixed(3), bbox: [box.min.toArray().map((v) => +v.toFixed(3)), box.max.toArray().map((v) => +v.toFixed(3))], seatTopUnderHips: +sf.chairSeat('talk', out.body.hipJointZ).seatTopY.toFixed(3), armInnerX: e.seat.arm.innerX == null ? null : +(e.seat.arm.innerX * chair.scale[0]).toFixed(3), seatFrontZ: +cf.frontFwd.toFixed(3), backTopScaledY: +(e.seat.backTopY * chair.scale[1]).toFixed(3), armTopScaledY: e.seat.arm.topY == null ? null : +(e.seat.arm.topY * chair.scale[1]).toFixed(3) };
  return out;
})().catch((err) => ({ error: String(err && err.message || err) }))`;

// Intersections: a skinned vertex inside the chair = odd hit counts on >= 4 of 6 axis rays (chair faces double-sided for
// the count); its depth = the nearest hit. Backrest contact: per torso part, the shortest distance straight back.
const QC_INTERSECT_JS = `(() => {
  const z = window.__zumiScene, T = z.THREE, vrm = z.getModel(), chair = z.chair3d;
  if (!chair.attached) return null;
  const meshes = []; chair.group.traverse((o) => { if (o.isMesh && o.name !== 'chair3d-contact-shadow') meshes.push(o); });
  const saved = []; for (const m of meshes) for (const mat of (Array.isArray(m.material) ? m.material : [m.material])) { saved.push([mat, mat.side]); mat.side = T.DoubleSide; }
  chair.group.updateMatrixWorld(true);
  const box = new T.Box3(); for (const m of meshes) box.expandByObject(m);
  box.expandByScalar(0.005);
  const rc = new T.Raycaster(); rc.firstHitOnly = false;
  const dirs = [[0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]].map((d) => new T.Vector3(...d));
  const p = new T.Vector3();
  const inside = [], parityOnly = []; let tested = 0;
  const nW = new T.Vector3();
  vrm.scene.updateMatrixWorld(true);
  vrm.scene.traverse((o) => {
    if (!o.isSkinnedMesh || !o.visible) return;
    const g = o.geometry, sI = g.attributes.skinIndex, sW = g.attributes.skinWeight, names = o.skeleton.bones.map((b) => b.name);
    for (let i = 0; i < g.attributes.position.count; i += 2) { // every 2nd vertex: same regions, half the time
      o.getVertexPosition(i, p).applyMatrix4(o.matrixWorld);
      if (!box.containsPoint(p)) continue;
      tested++;
      let odd = 0, back = 0, depth = Infinity;
      for (const d of dirs) {
        rc.set(p, d); rc.far = 3;
        const hits = rc.intersectObjects(meshes, false);
        if (hits.length % 2 === 1) odd++;
        if (hits.length) {
          depth = Math.min(depth, hits[0].distance);
          // first surface met from inside a closed part is its back face (outward normal along the ray)
          if (hits[0].face) { nW.copy(hits[0].face.normal).transformDirection(hits[0].object.matrixWorld); if (nW.dot(d) > 0) back++; }
        }
      }
      // Parity alone misreads OPEN shells (mesh-office's single-layer mesh seat and back, r2f: hands in her lap "16 cm
      // inside" with no chair surface within 16 cm on any axis). A vertex counts as inside only when the parity AND the
      // back-face test agree; parity-only hits are still reported (parityOnly) so nothing is hidden.
      if (odd >= 4) {
        let b = 0; for (let k = 1; k < 4; k++) if (sW.getComponent(i, k) > sW.getComponent(i, b)) b = k;
        const v = { bone: names[sI.getComponent(i, b)] || '?', depth: depth, p: p.toArray().map((x) => +x.toFixed(3)) };
        if (back >= 4) inside.push(v); else parityOnly.push(v);
      }
    }
  });
  for (const [mat, side] of saved) mat.side = side;
  const byBone = {}; for (const v of inside) { const k = v.bone; byBone[k] = byBone[k] || { n: 0, maxDepthCm: 0 }; byBone[k].n++; byBone[k].maxDepthCm = Math.max(byBone[k].maxDepthCm, +(v.depth * 100).toFixed(1)); }
  // backrest contact: from each pelvis/spine vertex inside the chair's width, the distance straight back (-Z) to the chair
  const gaps = {};
  const back = new T.Vector3(0, 0, -1);
  vrm.scene.traverse((o) => {
    if (!o.isSkinnedMesh || !o.visible) return;
    const g = o.geometry, sI = g.attributes.skinIndex, sW = g.attributes.skinWeight, names = o.skeleton.bones.map((b) => b.name);
    for (let i = 0; i < g.attributes.position.count; i += 2) {
      let b = 0; for (let k = 1; k < 4; k++) if (sW.getComponent(i, k) > sW.getComponent(i, b)) b = k;
      const bn = (names[sI.getComponent(i, b)] || '').toLowerCase();
      const part = /hips|pelvis/.test(bn) ? 'hips' : /upperchest|chest/.test(bn) ? 'chest' : /spine/.test(bn) ? 'spine' : null;
      if (!part) continue;
      o.getVertexPosition(i, p).applyMatrix4(o.matrixWorld);
      if (Math.abs(p.x) > 0.12) continue;
      rc.set(p, back); rc.far = 0.6;
      const h = rc.intersectObjects(meshes, false)[0];
      if (h) gaps[part] = Math.min(gaps[part] == null ? Infinity : gaps[part], h.distance);
    }
  });
  for (const [mat, side] of saved) mat.side = side;
  for (const k of Object.keys(gaps)) gaps[k] = +(gaps[k] * 100).toFixed(1);
  return { tested, deepest: inside.sort((x, y) => y.depth - x.depth).slice(0, 6).map((v) => ({ bone: v.bone, cm: +(v.depth * 100).toFixed(1), p: v.p })), insideCount: inside.length, parityOnly: { n: parityOnly.length, maxDepthCm: parityOnly.length ? +(Math.max(...parityOnly.map((v) => v.depth)) * 100).toFixed(1) : 0, sample: parityOnly.sort((x, y) => y.depth - x.depth).slice(0, 3).map((v) => ({ bone: v.bone, cm: +(v.depth * 100).toFixed(1), p: v.p })) }, maxDepthCm: inside.length ? +(Math.max(...inside.map((v) => v.depth)) * 100).toFixed(1) : 0, byBone, backGapCm: gaps };
})()`;

// Offscreen QC render with a custom camera: WebGL canvas only (plate hidden), desk occluders off, chair + avatar + the
// talk light rig. Rendered and read back inside one task (the drawing buffer is valid until the next composite).
const QC_SHOT_JS = (cam) => `(() => {
  const z = window.__zumiScene, T = z.THREE, r = z.renderer, scene = z.scene, cnv = r.domElement;
  const talk = z.director.room.views.talk;
  const occ = []; talk.occludersGroup.traverse((o) => { if (o.isMesh && o.material && o.material.colorWrite === false && o.visible) { o.visible = false; occ.push(o); } });
  const cam = new T.PerspectiveCamera(${cam.fov}, cnv.width / cnv.height, 0.02, 20);
  cam.position.set(${cam.pos.join(',')}); cam.lookAt(${cam.at.join(',')}); cam.updateMatrixWorld(); cam.updateProjectionMatrix();
  r.setClearColor(0x30323a, 1); r.render(scene, cam);
  const url = cnv.toDataURL('image/png');
  r.setClearColor(0x000000, 0);
  for (const o of occ) o.visible = true;
  return url;
})()`;
// Light match input: the chair alone at the talk camera (avatar hidden), raw WebGL pixels (before the stage's CSS grade);
// mean sRGB of the chair pixels visible in the talk crop. scripts/chair3d-lightmatch.py turns it into chairs.json look.tint.
const CHAIR_ONLY_JS = `(() => {
  const z = window.__zumiScene, r = z.renderer, cnv = r.domElement, vrm = z.getModel();
  vrm.scene.visible = false; r.setClearColor(0x000000, 0); r.render(z.scene, z.camera);
  const url = cnv.toDataURL('image/png');
  vrm.scene.visible = true; r.render(z.scene, z.camera);
  return url;
})()`;
const QC_CAMS = {
  front: { fov: 40, pos: [0, 0.85, 2.0], at: [0, 0.62, 0.05] },
  side: { fov: 40, pos: [2.0, 0.75, 0.15], at: [0, 0.62, 0.1] },
  '34': { fov: 40, pos: [1.45, 1.1, 1.65], at: [0, 0.62, 0.05] },
};

require(path.join(APP, 'src', 'main', 'main.js'));

app.whenReady().then(async () => {
  const timer = setTimeout(() => { result.errors.push('harness timeout (3000 s)'); finish(2); }, 3000000);
  try {
    const win = await until(() => BrowserWindow.getAllWindows()[0], 'main window');
    win.setContentSize(1280, 800);
    const page = win.webContents;
    page.on('preload-error', (_e, p, err) => console.log('[preload-error]', p, err && err.message));
    page.on('console-message', (e) => { const m = e.message || ''; if (/chair3d|error|uncaught|exception|failed/i.test(m) || process.env.CHAIR3D_VERBOSE) { result.errors.push(`console: ${m}`.slice(0, 400)); console.log(`[renderer] ${m.slice(0, 300)}`); } });
    await until(() => !page.isLoading() && page.getURL().startsWith('app://'), 'app page loaded');
    const r = (js) => page.executeJavaScript(js, true);
    const shot = async (name) => { await sleep(300); const img = await page.capturePage(); fs.writeFileSync(path.join(OUT, name), img.toPNG()); result.shots.push(name); console.log(`shot ${name}`); };
    const qcShot = async (name, cam) => { const url = await r(QC_SHOT_JS(cam)); fs.writeFileSync(path.join(OUT, name), Buffer.from(url.split(',')[1], 'base64')); result.shots.push(name); console.log(`shot ${name}`); };
    await until(() => r(`!!(window.__zumiScene && window.__zumiScene.director.room)`), 'painted v2 room loaded', 90000).catch(async (e) => {
      console.log('DEBUG', JSON.stringify(await r(`({ zs: typeof window.__zumiScene, keys: window.__zumiScene ? Object.keys(window.__zumiScene) : null, room: window.__zumiScene && !!window.__zumiScene.director.room, note: (document.getElementById('room-note') || {}).textContent, loading: document.getElementById('loading').hidden })`)));
      throw e;
    });
    await until(() => r(`document.getElementById('loading').hidden && document.getElementById('empty-model').hidden`), 'model on stage', 90000);
    await sleep(4000);
    await r(`(() => { const v = document.getElementById('room-view-select'); v.value = 'talk'; v.dispatchEvent(new Event('change')); })()`);
    await sleep(1500);
    const list = await r(`window.__zumiScene.applyChair('painted')`);
    check('chairs listed (manifest + files verified by main)', list.chairs.length >= 2 && !list.error, list.chairs.map((c) => c.id));
    check('default pick is the painted chair', list.selected === 'painted', list.selected);
    const ids = ['painted', ...list.chairs.map((c) => c.id)].filter((id) => !ONLY || ONLY.includes(id));
    // Fair shots: every candidate is shot in the same neutral idle (no blink/glance/saccade/idle gesture), frozen at the
    // same breathing phase (t mod 4.2 s ~ 0, engine.js lifeLayer), so only the chair differs between the frames.
    const freezeNeutral = () => r(`new Promise((res) => { const z = window.__zumiScene; const f = () => { const ph = (performance.now() / 1000) % 4.2; if (ph < 0.035) { z.freeze(); res(ph); } else requestAnimationFrame(f); }; requestAnimationFrame(f); })`);
    for (const id of ids) {
      await r(`window.__zumiScene.thaw()`);
      const l = await r(`window.__zumiScene.applyChair(${JSON.stringify(id)})`);
      await r(`window.__zumiScene.holdNeutral()`);
      await sleep(3000); // lean/recline smoothing + spring bones + gaze back to centre
      await freezeNeutral();
      await sleep(400);
      const st = await r(`(() => { const z = window.__zumiScene; return { selected: ${JSON.stringify(id)}, stored: null, attached: z.chair3d.active, view: z.director.view, plateSwapped: z.director.room.views.talk.plateTexture === z.chair3d.noChairPlate }; })()`);
      check(`${id}: applied (3D chair ${id === 'painted' ? 'off' : 'on'}, talk view, plate ${id === 'painted' ? 'painted' : 'no-chair'})`, l.selected === id && st.attached === (id !== 'painted') && st.view === 'talk' && st.plateSwapped === (id !== 'painted'), st);
      await shot(`chair-${id}-talk.png`);
      const qc = await r(QC_JS);
      if (id !== 'painted') qc.intersect = await r(QC_INTERSECT_JS);
      result.qc[id] = qc;
      console.log(`QC ${id} ${JSON.stringify(qc)}`);
      for (const [k, cam] of Object.entries(QC_CAMS)) await qcShot(`chair-${id}-qc-${k}.png`, cam);
      if (id !== 'painted') { const url = await r(CHAIR_ONLY_JS); fs.writeFileSync(path.join(OUT, `chair-${id}-only-talk.png`), Buffer.from(url.split(',')[1], 'base64')); }
    }
    const stored = JSON.parse(fs.readFileSync(settingsFile, 'utf8')).chair3d;
    check('the pick persists in settings.json (chair3d)', stored === ids[ids.length - 1], stored);
    await r(`window.__zumiScene.thaw()`);
    await r(`window.__zumiScene.applyChair('painted')`);
    await sleep(800);
    const back = await r(`(() => { const z = window.__zumiScene; return { attached: z.chair3d.active, plate: z.director.room.views.talk.plateTexture !== z.chair3d.noChairPlate, occ: (() => { let n = 0; z.director.room.views.talk.occludersGroup.traverse((o) => { if (o.isMesh && o.visible && /armrest|seat_top/.test(o.name)) n++; }); return n; })() }; })()`);
    check("'painted' restores the painted plate and its 5 chair occluders", !back.attached && back.plate && back.occ === 5, back);
    clearTimeout(timer);
    finish(result.checks.every((c) => c.ok) ? 0 : 1);
  } catch (e) {
    result.errors.push(String((e && e.stack) || e));
    console.log(`ERROR ${e && e.message}`);
    clearTimeout(timer);
    finish(2);
  }
});
