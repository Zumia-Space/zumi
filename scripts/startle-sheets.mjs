// BEFORE/AFTER contact sheets for the "startle" (giật mình) reflex, so a human can see the chest-contact fix
// (d3d1f50 "put the 'chest' contact on the front of the chest" vs its parent). Evidence only: it does not touch the
// app. One sheet per (commit, view): one row per startle scenario that scripts/check-motion.mjs plays (poke side +,
// poke side −, wake), sampled at 30 Hz over the first ~700 ms of the reaction (21 frames), from the front and from
// −25°, with Vietnamese labels and the frame time in ms on every tile. The scenarios are played through the app's
// own ReflexEngine (life layer, gaze, player, rig IK, spring bones) on a virtual clock, in ONE headless Chrome.
//
// Two module trees are served at once — /b/ = before the fix, /a/ = after — extracted per commit with
//   git archive <commit> src/renderer
// so the page can render both without swapping files. The player HTML is served from memory (no asset file needed).
//
//   node startle-sheets.mjs [--before <src/renderer>] [--after <src/renderer>] [--vrm <file.vrm>]
//                           [--nm <node_modules>] [--out <dir>] [--lock <file>] [--skip-lock] [--crop]
//
// --crop writes ONE waist-up comparison image (crop-before-after-front.png) instead of the four full-body sheets:
// 4 rows (poke side + / − × before / after) × 6 frames at 60 Hz (0, 83, 150, 250, 350, 467 ms), front view only,
// camera framed hips→top of head/halo so the hands read large. Same red-ms-chip rule (wrist > 2 cm behind the back).
//
// On a shared PC it waits for the owner's input to be idle (>= 300 s, polled every 60 s, up to 30 min) and takes
// render.lock (its own PID) for the run, releasing it after. It never touches other processes: it starts one browser
// and closes that one; no taskkill by image name.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import os from 'node:os';
import { ownerPath } from './lib/owner-paths.mjs';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, def = null) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : def; };
const flag = (name) => process.argv.includes(`--${name}`);

const beforeDir = path.resolve(arg('before', path.join(HERE, 'before', 'src', 'renderer')));
const afterDir = path.resolve(arg('after', path.join(HERE, 'after', 'src', 'renderer')));
const vrmPath = path.resolve(arg('vrm', path.join(HERE, 'vrm', 'zumi-v3.1.vrm')));
const nmDir = path.resolve(arg('nm', path.join(HERE, 'nm')));
const outDir = path.resolve(arg('out', path.join(HERE, 'out')));
const lockPath = arg('lock', ownerPath('renderLock', path.join(os.tmpdir(), 'zumi-render.lock'))); // the render box's lock (owner values)
const only = arg('only'); // 'before' | 'after'
const crop = flag('crop'); // one waist-up 4×6 before/after comparison image (see header)

for (const [name, p] of [['before', beforeDir], ['after', afterDir], ['vrm', vrmPath], ['nm', nmDir]]) {
  if (!fs.existsSync(p)) { console.error(`missing ${name}: ${p}`); process.exit(2); }
}
if (path.basename(vrmPath) !== 'zumi-v3.1.vrm') { console.error(`expected the model to be named zumi-v3.1.vrm, got ${path.basename(vrmPath)}`); process.exit(2); }

const { chromium } = createRequire(path.join(nmDir, 'playwright-core', 'package.json'))('playwright-core');

// ---------- owner-idle gate (Windows GetLastInputInfo) ----------
const idleMs = () => {
  const ps = [
    "$sig = @'",
    'using System;',
    'using System.Runtime.InteropServices;',
    'public class HiveIdle {',
    '  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }',
    '  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);',
    '  public static uint Ms() { LASTINPUTINFO l = new LASTINPUTINFO(); l.cbSize = (uint)Marshal.SizeOf(l); GetLastInputInfo(ref l); return (uint)Environment.TickCount - l.dwTime; }',
    '}',
    "'@",
    'Add-Type -TypeDefinition $sig',
    '[HiveIdle]::Ms()',
  ].join('\n');
  return Number(String(execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { encoding: 'utf8' })).trim());
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const IDLE_MIN = 300_000, POLL = 60_000, WAIT_MAX = 30 * 60_000;
async function waitForOwnerIdle() {
  const t0 = Date.now();
  let idle = idleMs();
  if (idle >= IDLE_MIN) { console.log(`owner idle ${(idle / 1000).toFixed(0)} s — ok`); return (Date.now() - t0) / 1000; }
  while (Date.now() - t0 < WAIT_MAX) {
    console.log(`owner active (idle ${(idle / 1000).toFixed(0)} s < 300 s) — waiting 60 s (waited ${((Date.now() - t0) / 1000).toFixed(0)} s)`);
    await sleep(POLL);
    idle = idleMs();
    if (idle >= IDLE_MIN) { console.log(`owner idle ${(idle / 1000).toFixed(0)} s — ok after ${((Date.now() - t0) / 1000).toFixed(0)} s`); return (Date.now() - t0) / 1000; }
  }
  throw new Error(`owner still active after ${WAIT_MAX / 60000} min (idle ${(idle / 1000).toFixed(0)} s)`);
}

// ---------- single-renderer lock ----------
let locked = false;
function takeLock() {
  if (flag('skip-lock')) { console.log('lock skipped (--skip-lock)'); return; }
  if (fs.existsSync(lockPath)) throw new Error(`render.lock already present (${lockPath}) — another render is running`);
  fs.writeFileSync(lockPath, String(process.pid));
  locked = true;
  console.log(`lock taken ${lockPath} pid ${process.pid}`);
}
function dropLock() { if (locked) { try { fs.unlinkSync(lockPath); console.log('lock released'); } catch {} locked = false; } }

// ---------- the page (served from memory; the app's own ReflexEngine plays the scenarios) ----------
const PLAYER_HTML = `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><title>Tờ khung hình phản xạ giật mình</title>
<style>body{margin:0;background:#20242b}</style>
<script type="importmap">
{"imports":{"three":"/nm/three/build/three.module.js","three/addons/":"/nm/three/examples/jsm/","@pixiv/three-vrm":"/nm/@pixiv/three-vrm/lib/three-vrm.module.js"}}
</script></head><body>
<script type="module">
let vclock = 0;
performance.now = function () { return vclock; };

// rootKey: '/b/' (before) | '/a/' (after). rows: [{ name, kind:'poke'|'wake', side }].
window.renderVariant = async function (rootKey, rows, yaw, title) {
  const THREE = await import('three');
  const GLTFLoaderMod = await import('three/addons/loaders/GLTFLoader.js');
  const VRMMod = await import('@pixiv/three-vrm');
  const engMod = await import(rootKey + 'reflex/engine.js');
  const catMod = await import(rootKey + 'reflex/catalog.js');
  const GLTFLoader = GLTFLoaderMod.GLTFLoader;
  const VRMLoaderPlugin = VRMMod.VRMLoaderPlugin, VRMUtils = VRMMod.VRMUtils;
  const ReflexEngine = engMod.ReflexEngine, Catalog = catMod.Catalog;

  const catalog = await Catalog.load(rootKey + 'reflex/gestures/');

  const CW = 300, CH = 380, FPS = 60, DT = 1 / FPS;
  const SAMPLES = 21, SPAN = 700, COLS = 11;
  const rowsPerScen = Math.ceil(SAMPLES / COLS);
  const HEAD = 58, SCEN = 26, GAP = 8;
  const scenH = SCEN + rowsPerScen * CH;
  const out = document.createElement('canvas');
  out.width = COLS * CW;
  out.height = HEAD + rows.length * (scenH + GAP);
  const g = out.getContext('2d');
  g.fillStyle = '#20242b'; g.fillRect(0, 0, out.width, out.height);
  g.fillStyle = '#ffffff'; g.font = 'bold 22px sans-serif'; g.fillText(title, 12, 30);
  g.fillStyle = '#9fb0c4'; g.font = '14px sans-serif';
  g.fillText('Phản xạ giật mình · Zumi v3.1 · 21 khung · 30 Hz · 0–700 ms', 12, 50);

  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(CW, CH); renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0xe9ecf1);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x667788, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6); sun.position.set(1, 3, 2); scene.add(sun);
  scene.add(new THREE.GridHelper(4, 16, 0x8892a0, 0xc4cad3));

  const loader = new GLTFLoader(); loader.register(function (p) { return new VRMLoaderPlugin(p); });
  const gltf = await loader.loadAsync('/vrm/zumi-v3.1.vrm');
  const vrm = gltf.userData.vrm;
  VRMUtils.removeUnnecessaryVertices(gltf.scene);
  VRMUtils.combineSkeletons(gltf.scene);
  if (vrm.meta && vrm.meta.metaVersion === '0') VRMUtils.rotateVRM0(vrm);
  vrm.scene.traverse(function (o) { o.frustumCulled = false; });
  scene.add(vrm.scene);

  let seed = 7;
  const random = function () { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const clips = { has: function () { return false; }, bind: function () {}, unbind: function () {}, sample: function () { return false; }, blend: function () {}, wasActive: false };
  const stageCam = new THREE.PerspectiveCamera(28, CW / CH, 0.05, 50);
  const engine = new ReflexEngine({ catalog: catalog, clips: clips, random: random });
  engine.bind(vrm, stageCam);
  engine.autoIdle = false;
  (function () {
    const rig = engine.rig, s = rig.shoulderWidth;
    const box = new THREE.Box3().setFromObject(vrm.scene);
    const bottom = rig.hipsPos.y - 0.05 * s;
    const rawTop = Math.max(box.max.y, rig.shoulderY + 0.8 * rig.armLength, rig.headPos.y + 0.6 * s);
    const top = rawTop + 0.04 * (rawTop - bottom), cy = (top + bottom) / 2;
    const dist = ((top - bottom) / 2) / Math.tan(14 * Math.PI / 180) * 1.03;
    stageCam.position.set(0, cy + 0.03 * (top - bottom), rig.headPos.z + dist);
    stageCam.lookAt(0, cy, rig.headPos.z); stageCam.updateMatrixWorld();
  })();

  const cam = (function () {
    const c = new THREE.PerspectiveCamera(30, CW / CH, 0.05, 50);
    const a = THREE.MathUtils.degToRad(yaw);
    c.position.set(Math.sin(a) * 3.6, 1.05, Math.cos(a) * 3.6);
    c.lookAt(0, 0.82, 0);
    return c;
  })();

  function step() { vclock += 1000 * DT; engine.update(DT); vrm.scene.updateMatrixWorld(true); }
  function reset() {
    engine.player.stopAll(true);
    engine.states.clear();
    if (engine.rig && engine.rig.routes) engine.rig.routes.clear();
    engine.resetForTest();
    seed = 7;
    engine.life.phase = [0, 1, 2, 3, 4, 5].map(function () { return random() * 100; });
    engine.life.blinkNext = vclock + 99999;
    for (let i = 0; i < FPS; i++) step();
  }
  function variant(trig, id) { return catalog.get(trig).variants.find(function (v) { return v.id === id; }).command; }
  function play(cmd, side) {
    const res = engine.player.play(cmd, { side: side });
    if (!res.ok) throw new Error(res.errors.join('; '));
    return res.id;
  }
  // the fix itself: the chest-contact point in chest-local space (behind = z<0). Same numbers the commit quotes.
  const contact = engine.rig && engine.rig.surf && engine.rig.surf.chest
    ? [+engine.rig.surf.chest.x.toFixed(3), +engine.rig.surf.chest.y.toFixed(3), +engine.rig.surf.chest.z.toFixed(3)]
    : null;
  // wrist behind the back of the torso, cm: exactly scripts/check-motion.mjs's test (chest-local, inside body width).
  function behindCm(side) {
    const rig = engine.rig, arm = rig && rig.arms[side], bx = rig && rig.surf && rig.surf.chestBox;
    if (!arm || !bx) return null;
    const wr = arm.hand.getWorldPosition(new THREE.Vector3());
    const inv = new THREE.Matrix4().copy(rig.frame(rig.chestNode)).invert();
    const lw = wr.clone().applyMatrix4(inv);
    const hipsY = rig.nodes.hips.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv).y;
    if (Math.abs(lw.x) < bx.max.x && lw.y > hipsY - 0.1 && lw.y < bx.max.y) return (bx.min.z - lw.z) * 100;
    return null;
  }

  const info = [];
  for (let si = 0; si < rows.length; si++) {
    const row = rows[si];
    const y0 = HEAD + si * (scenH + GAP);
    g.fillStyle = '#ffffff'; g.font = 'bold 18px sans-serif';
    g.fillText(row.name + ' · ' + title, 12, y0 + 18);

    reset();
    let t0, schedule;
    if (row.kind === 'wake') {
      engine.trigger('sleepy');
      for (let i = 0; i < 3 * FPS; i++) step();
      t0 = vclock + 200;
      schedule = function () { engine.exitState('sleepy'); play(variant('wake', 'startle-wake')); };
    } else {
      t0 = vclock + 200;
      schedule = function () { play(variant('poke', 'startle'), row.side); };
    }

    const times = [];
    for (let i = 0; i < SAMPLES; i++) times.push((i * SPAN) / (SAMPLES - 1));
    let evDone = false, ti = 0;
    const seen = [];
    let maxBehind = -Infinity, firstBehindMs = null, lastBehindMs = null;
    const limit = Math.ceil((t0 - vclock + SPAN + 500) / (1000 * DT)) + 20;
    for (let f = 0; f < limit && ti < SAMPLES; f++) {
      if (!evDone && vclock + 1e-6 >= t0) { evDone = true; schedule(); }
      step();
      const tMs = Math.round(vclock - t0);
      if (tMs >= times[ti]) {
        const bL = behindCm('left'), bR = behindCm('right');
        const behind = Math.max(bL == null ? -Infinity : bL, bR == null ? -Infinity : bR);
        if (behind > maxBehind) maxBehind = behind;
        if (behind > 2) { if (firstBehindMs == null) firstBehindMs = tMs; lastBehindMs = tMs; }
        renderer.render(scene, cam);
        const col = ti % COLS, gr = Math.floor(ti / COLS);
        const x = col * CW, y = y0 + SCEN + gr * CH;
        g.drawImage(renderer.domElement, x, y);
        g.strokeStyle = '#20242b'; g.lineWidth = 1; g.strokeRect(x + 0.5, y + 0.5, CW - 1, CH - 1);
        const txt = tMs + ' ms';
        g.font = 'bold 16px sans-serif';
        const w = g.measureText(txt).width;
        g.fillStyle = 'rgba(32,36,43,0.8)'; g.fillRect(x + 6, y + 6, w + 14, 24);
        g.fillStyle = behind > 2 ? '#ff6b6b' : '#ffe08a'; g.fillText(txt, x + 13, y + 24);
        seen.push(tMs);
        ti++;
      }
    }
    info.push({ row: row.name, frames: seen.length, first: seen[0], last: seen[seen.length - 1], contact: contact, maxBehindCm: Number.isFinite(maxBehind) ? +maxBehind.toFixed(1) : null, firstBehindMs: firstBehindMs, lastBehindMs: lastBehindMs });
  }
  return { png: out.toDataURL('image/png'), info: info };
};

// Waist-up crop comparison: rows = [{ name, root:'/b/'|'/a/', side }]. One row per (poke side, before/after), six
// 60 Hz frames at 0/83/150/250/350/467 ms, front view only, camera framed hips→top of head/halo. Same red-ms-chip
// rule as renderVariant (a wrist more than 2 cm behind the back). Everything else mirrors renderVariant.
window.renderCropSheet = async function (rows, title) {
  const THREE = await import('three');
  const GLTFLoaderMod = await import('three/addons/loaders/GLTFLoader.js');
  const VRMMod = await import('@pixiv/three-vrm');
  const GLTFLoader = GLTFLoaderMod.GLTFLoader;
  const VRMLoaderPlugin = VRMMod.VRMLoaderPlugin, VRMUtils = VRMMod.VRMUtils;

  const CW = 300, CH = 380, FPS = 60, DT = 1 / FPS;
  const TIMES = [0, 83, 150, 250, 350, 467];
  const HEAD = 58, SCEN = 26, GAP = 8;
  const out = document.createElement('canvas');
  out.width = TIMES.length * CW;
  out.height = HEAD + rows.length * (SCEN + CH + GAP);
  const g = out.getContext('2d');
  g.fillStyle = '#20242b'; g.fillRect(0, 0, out.width, out.height);
  g.fillStyle = '#ffffff'; g.font = 'bold 22px sans-serif'; g.fillText(title, 12, 30);
  g.fillStyle = '#9fb0c4'; g.font = '14px sans-serif';
  g.fillText('Zumi v3.1 · 6 khung chọn: 0–467 ms · khung đỏ: cổ tay > 2 cm sau lưng', 12, 50);

  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(CW, CH); renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const info = [];
  for (let si = 0; si < rows.length; si++) {
    const row = rows[si];
    const y0 = HEAD + si * (SCEN + CH + GAP);
    g.fillStyle = '#ffffff'; g.font = 'bold 18px sans-serif';
    g.fillText(row.name, 12, y0 + 18);

    const engMod = await import(row.root + 'reflex/engine.js');
    const catMod = await import(row.root + 'reflex/catalog.js');
    const ReflexEngine = engMod.ReflexEngine, Catalog = catMod.Catalog;
    const catalog = await Catalog.load(row.root + 'reflex/gestures/');

    const scene = new THREE.Scene(); scene.background = new THREE.Color(0xe9ecf1);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x667788, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6); sun.position.set(1, 3, 2); scene.add(sun);
    scene.add(new THREE.GridHelper(4, 16, 0x8892a0, 0xc4cad3));

    const loader = new GLTFLoader(); loader.register(function (p) { return new VRMLoaderPlugin(p); });
    const gltf = await loader.loadAsync('/vrm/zumi-v3.1.vrm');
    const vrm = gltf.userData.vrm;
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.combineSkeletons(gltf.scene);
    if (vrm.meta && vrm.meta.metaVersion === '0') VRMUtils.rotateVRM0(vrm);
    vrm.scene.traverse(function (o) { o.frustumCulled = false; });
    scene.add(vrm.scene);

    let seed = 7;
    const random = function () { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const clips = { has: function () { return false; }, bind: function () {}, unbind: function () {}, sample: function () { return false; }, blend: function () {}, wasActive: false };
    // Waist-up: the render camera IS the stage camera (hips → top of head/halo), so the hands read large.
    const cam = new THREE.PerspectiveCamera(28, CW / CH, 0.05, 50);
    const engine = new ReflexEngine({ catalog: catalog, clips: clips, random: random });
    engine.bind(vrm, cam);
    engine.autoIdle = false;
    (function () {
      const rig = engine.rig, s = rig.shoulderWidth;
      const box = new THREE.Box3().setFromObject(vrm.scene);
      const bottom = rig.hipsPos.y - 0.05 * s;
      const rawTop = Math.max(box.max.y, rig.shoulderY + 0.8 * rig.armLength, rig.headPos.y + 0.6 * s);
      const top = rawTop + 0.04 * (rawTop - bottom), cy = (top + bottom) / 2;
      const dist = ((top - bottom) / 2) / Math.tan(14 * Math.PI / 180) * 1.03;
      cam.position.set(0, cy + 0.03 * (top - bottom), rig.headPos.z + dist);
      cam.lookAt(0, cy, rig.headPos.z); cam.updateMatrixWorld();
    })();

    function step() { vclock += 1000 * DT; engine.update(DT); vrm.scene.updateMatrixWorld(true); }
    function reset() {
      engine.player.stopAll(true);
      engine.states.clear();
      if (engine.rig && engine.rig.routes) engine.rig.routes.clear();
      engine.resetForTest();
      seed = 7;
      engine.life.phase = [0, 1, 2, 3, 4, 5].map(function () { return random() * 100; });
      engine.life.blinkNext = vclock + 99999;
      for (let i = 0; i < FPS; i++) step();
    }
    function variant(trig, id) { return catalog.get(trig).variants.find(function (v) { return v.id === id; }).command; }
    function play(cmd, side) {
      const res = engine.player.play(cmd, { side: side });
      if (!res.ok) throw new Error(res.errors.join('; '));
      return res.id;
    }
    const contact = engine.rig && engine.rig.surf && engine.rig.surf.chest
      ? [+engine.rig.surf.chest.x.toFixed(3), +engine.rig.surf.chest.y.toFixed(3), +engine.rig.surf.chest.z.toFixed(3)]
      : null;
    function behindCm(side) {
      const rig = engine.rig, arm = rig && rig.arms[side], bx = rig && rig.surf && rig.surf.chestBox;
      if (!arm || !bx) return null;
      const wr = arm.hand.getWorldPosition(new THREE.Vector3());
      const inv = new THREE.Matrix4().copy(rig.frame(rig.chestNode)).invert();
      const lw = wr.clone().applyMatrix4(inv);
      const hipsY = rig.nodes.hips.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv).y;
      if (Math.abs(lw.x) < bx.max.x && lw.y > hipsY - 0.1 && lw.y < bx.max.y) return (bx.min.z - lw.z) * 100;
      return null;
    }

    reset();
    const t0 = vclock + 200;
    const schedule = function () { play(variant('poke', 'startle'), row.side); };
    let evDone = false;
    const seen = [];
    let maxBehind = -Infinity, firstBehindMs = null, lastBehindMs = null;
    const limit = Math.ceil((t0 - vclock + TIMES[TIMES.length - 1] + 500) / (1000 * DT)) + 20;
    for (let f = 0, ti = 0; f < limit && ti < TIMES.length; f++) {
      if (!evDone && vclock + 1e-6 >= t0) { evDone = true; schedule(); }
      step();
      const tMs = Math.round(vclock - t0);
      if (tMs >= TIMES[ti]) {
        const bL = behindCm('left'), bR = behindCm('right');
        const behind = Math.max(bL == null ? -Infinity : bL, bR == null ? -Infinity : bR);
        if (behind > maxBehind) maxBehind = behind;
        if (behind > 2) { if (firstBehindMs == null) firstBehindMs = tMs; lastBehindMs = tMs; }
        renderer.render(scene, cam);
        const x = ti * CW, y = y0 + SCEN;
        g.drawImage(renderer.domElement, x, y);
        g.strokeStyle = '#20242b'; g.lineWidth = 1; g.strokeRect(x + 0.5, y + 0.5, CW - 1, CH - 1);
        const txt = tMs + ' ms';
        g.font = 'bold 16px sans-serif';
        const w = g.measureText(txt).width;
        g.fillStyle = 'rgba(32,36,43,0.8)'; g.fillRect(x + 6, y + 6, w + 14, 24);
        g.fillStyle = behind > 2 ? '#ff6b6b' : '#ffe08a'; g.fillText(txt, x + 13, y + 24);
        seen.push(tMs);
        ti++;
      }
    }
    info.push({ row: row.name, root: row.root, side: row.side, frames: seen.length, framesMs: seen, contact: contact, maxBehindCm: Number.isFinite(maxBehind) ? +maxBehind.toFixed(1) : null, firstBehindMs: firstBehindMs, lastBehindMs: lastBehindMs });
    scene.remove(vrm.scene);
  }
  return { png: out.toDataURL('image/png'), info: info };
};
window.ready = true;
</script></body></html>`;

// ---------- static server: /nm/, /b/, /a/, /vrm/, else HERE ----------
const ROOTS = {
  '/nm/': nmDir + '/',
  '/b/': beforeDir + '/',
  '/a/': afterDir + '/',
  '/vrm/': path.dirname(vrmPath) + '/',
  '/': HERE + '/',
};
const TYPES = { '.js': 'text/javascript', '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.vrm': 'application/octet-stream' };
const srv = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/player.html' || url === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(PLAYER_HTML); }
  const pre = Object.keys(ROOTS).find((p) => url.startsWith(p));
  const file = ROOTS[pre] + url.slice(pre.length);
  fs.readFile(file, (e, buf) => {
    if (e) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => srv.once('listening', r));
const port = srv.address().port;

// ---------- render ----------
const SCEN = [
  { name: 'Giật mình — chọc bên phải', kind: 'poke', side: 1 },
  { name: 'Giật mình — chọc bên trái', kind: 'poke', side: -1 },
  { name: 'Giật mình — thức giấc sau khi ngủ', kind: 'wake' },
];
const VARIANTS = [
  { root: '/b/', label: 'trước khi sửa', prefix: 'before' },
  { root: '/a/', label: 'sau khi sửa', prefix: 'after' },
].filter((v) => !only || v.prefix === only);
const VIEWS = [{ yaw: 0, tag: 'front', vi: 'chính diện' }, { yaw: -25, tag: '34', vi: 'nghiêng 25°' }];
// --crop: rows are per (poke side, before/after); 'bên phải' = side +1, as in SCEN.
const CROP_ROWS = [
  { name: 'Chọc bên phải — trước khi sửa', root: '/b/', side: 1 },
  { name: 'Chọc bên phải — sau khi sửa', root: '/a/', side: 1 },
  { name: 'Chọc bên trái — trước khi sửa', root: '/b/', side: -1 },
  { name: 'Chọc bên trái — sau khi sửa', root: '/a/', side: -1 },
];
const CROP_TITLE = 'Giật mình — tay trước và sau khi sửa (Zumi v3.1)';

let browser;
const result = { idleWaitS: null, wrote: [], failed: [] };
try {
  result.idleWaitS = await waitForOwnerIdle();
  takeLock();

  for (let attempt = 1; attempt <= 3; attempt++) {
    const gl = attempt < 3 ? ['--use-gl=angle', '--use-angle=d3d11'] : ['--use-angle=swiftshader'];
    browser = await chromium.launch({ channel: 'chrome', headless: true, args: [...gl, '--ignore-gpu-blocklist'], timeout: 120000 });
    const page = await browser.newPage();
    let glError = false;
    page.on('pageerror', (e) => { if (/WebGL/.test(e.message)) glError = true; else console.error('pageerror', e.message); });
    await page.goto(`http://127.0.0.1:${port}/player.html`);
    try {
      await page.waitForFunction(() => window.ready === true, null, { timeout: 90000 });
      fs.mkdirSync(outDir, { recursive: true });
      if (crop) {
        const { png, info } = await page.evaluate(([rows, t]) => window.renderCropSheet(rows, t), [CROP_ROWS, CROP_TITLE]);
        const file = path.join(outDir, 'crop-before-after-front.png');
        fs.writeFileSync(file, Buffer.from(png.split(',')[1], 'base64'));
        result.wrote.push({ file, info });
        console.log('wrote', file, JSON.stringify(info));
      } else {
        for (const v of VARIANTS) {
          for (const view of VIEWS) {
            const title = `Giật mình (phản xạ) · ${v.label} · Zumi v3.1 · góc nhìn ${view.vi}`;
            const { png, info } = await page.evaluate(([root, rows, yaw, t]) => window.renderVariant(root, rows, yaw, t), [v.root, SCEN, view.yaw, title]);
            const file = path.join(outDir, `${v.prefix}-${view.tag}.png`);
            fs.writeFileSync(file, Buffer.from(png.split(',')[1], 'base64'));
            result.wrote.push({ file, info });
            console.log('wrote', file, JSON.stringify(info));
          }
        }
      }
      break;
    } catch (e) {
      console.error(`attempt ${attempt} failed${glError ? ' (WebGL context)' : ''}: ${e.message}`);
      await browser.close(); browser = null;
      if (attempt === 3) throw e;
    }
  }
} catch (e) {
  result.failed.push(e.message);
  console.error('FAILED:', e.message);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  srv.close();
  dropLock();
  fs.writeFileSync(path.join(HERE, 'render-result.json'), JSON.stringify(result, null, 2));
}
