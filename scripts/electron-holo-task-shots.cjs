// Shots of the holo panel showing the live task (T-31 alpha.3 R3). Runs the REAL app (src/main/main.js from this source tree) in its own
// userData, in a window shown off the desktop (never over the owner's screen, never focused, no taskbar button), like
// scripts/electron-float-holo.cjs, and drives the same dev seams (window.__zumiScene.holo / .work / .float). No board is involved: the
// fixture rows below exist only in this harness and go in through setFeed / work.feed (the dev seam), never into the app.
//   ZUMI_ELECTRON_HOST=box electron scripts/electron-holo-task-shots.cjs --app <dir> --out <dir> --userdata <dir> --model <file.vrm> [--theme blue|black|white]
//     [--sizes 1680x987,1366x768] (two window content sizes, default 1366x768,1920x1080) [--room <video room id>] (fresh userdata
//     only, default scifi-bridge) [--hud] (seated shots also show the HUD side panels with a fixture feed, as the owner runs it)
// Per run (one theme): at 1366x768 and 1920x1080 a float shot and a seated shot with the fixture task; at 1366x768 the empty-feed state and a
// Vietnamese step label (+ a 2x crop of the panel, to read the diacritics). Every shot is written at <= 1600 px wide. result.json lists the
// shots, the panel's projected NDC rect (x1 <= 1 = inside the frame), holo.state() and the font the canvas asks for.
'use strict';
require('./lib/electron-guard.cjs').exitUnlessElectronHost('electron-holo-task-shots.cjs');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const ROOT = path.join(__dirname, '..');
const APP = path.resolve(arg('--app') || ROOT);
const OUT = path.resolve(arg('--out'));
const USERDATA = path.resolve(arg('--userdata'));
const THEME = ['blue', 'black', 'white'].includes(arg('--theme')) ? arg('--theme') : 'blue';
const STATE = arg('--state') === 'waiting' ? 'waiting' : 'active'; // the step state the fixture row carries (the panel's state word)
const TAG = THEME + (STATE === 'waiting' ? '-waiting' : ''); // file-name tag
const SIZES = (arg('--sizes') || '1366x768,1920x1080').split(',').map((p) => p.split('x').map(Number));
if (SIZES.length !== 2 || SIZES.some(([w, h]) => !(w > 0 && h > 0))) throw new Error('--sizes takes two WxH sizes, e.g. 1680x987,1366x768');
const ROOM = arg('--room') || 'scifi-bridge';
const HUD = process.argv.includes('--hud');
const MAX_W = 1600; // shots stay <= 1600 px wide (the image-size rule)
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(USERDATA, { recursive: true });
try { os.setPriority(process.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* best effort; the launcher also starts us below normal */ }

process.env.ZUMI_ROOM_V2_DEFAULT_PATH = path.join(ROOT, 'resources-pinned', 'room-v2', 'room.json');
const settingsFile = path.join(USERDATA, 'settings.json');
if (!fs.existsSync(settingsFile)) fs.writeFileSync(settingsFile, JSON.stringify({ room: 'default-v2', uiLang: 'en', voiceEnabled: false, sceneRoom: ROOM }, null, 2));
app.setPath('userData', USERDATA);
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('num-raster-threads', '2');
app.on('browser-window-created', (_e, win) => {
  win.setSkipTaskbar(true);
  win.show = () => { win.setPosition(-32000, -32000); win.showInactive(); };
  win.maximize = () => {};
  win.focus = () => {};
});

const MIN_ON_SCREEN_PX = 9; // the HUD's smallest line (owner 01-11; was 11 px, REVIEW-OPUS)
const result = { app: APP, theme: THEME, shots: [], panels: {}, legible: {}, errors: [] };
const finish = (code) => { fs.writeFileSync(path.join(OUT, `result-${TAG}.json`), JSON.stringify(result, null, 1)); setTimeout(() => app.exit(code), 100); };
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

// Fixture rows (shape = a hud:feed row, src/main/hud-feed.mjs). Harness only.
const ROW = { id: 'T-FIX', title: 'Render the float demo video', status: 'working', stepId: 's19', stepState: 'active', stepTotal: 37, steps: [] };
const rowFor = (extra) => [{ ...ROW, at: new Date().toISOString(), ...extra }];
const FEED_EN = () => rowFor({ stepState: STATE, step: 'Check the framing of the hero shot', doneCount: 19, log: [{ label: 'Receive the report', from: 'active', to: 'done' }, { label: 'Find the memory', from: 'active', to: 'done' }, { label: 'Open the browser', from: 'active', to: 'done' }] });
const FEED_VI = () => rowFor({ title: 'Dựng video demo nổi', step: 'Bước 24 - Lỗi phòng bị cắt ế ỡ ợ', doneCount: 23, log: [{ label: 'Nhận báo cáo', from: 'active', to: 'done' }, { label: 'Tìm lại bộ nhớ', from: 'active', to: 'done' }, { label: 'Mở trình duyệt', from: 'active', to: 'done' }] });

// --hud: two waiting asks for the side panel (shape = hud-feed.mjs waitOut), ages from a fixed offset to now.
const HUD_WAITING = [
  { key: 'ask:a1', kind: 'ask', taskId: 'H-03', title: 'Hunter Tool', step: '', text: 'Approve the second Upwork offer', since: new Date(Date.now() - 26 * 3600000).toISOString(), refs: [], id: 'a1', rev: 1, options: [] },
  { key: 'ask:a2', kind: 'ask', taskId: 'V-02', title: 'AI video', step: '', text: 'Review the 6 test clips', since: new Date(Date.now() - 6.3 * 86400000).toISOString(), refs: [], id: 'a2', rev: 1, options: [] },
];

// The panel's projected NDC rect + holo.state(), read in the page (same projection as electron-float-holo.cjs SNAP).
const PANEL = `(() => {
  const s = window.__zumiScene, cam = s.camera, THREE = s.THREE;
  const grp = s.scene.getObjectByName('holo-screen'); if (!grp || !grp.children[0]) return null;
  const mesh = grp.children[0], g = mesh.geometry.parameters, w = g.width / 2, h = g.height / 2;
  mesh.updateMatrixWorld(true);
  const canvas = document.getElementById('stage-canvas'), cr = canvas.getBoundingClientRect();
  const pts = [[-w, -h], [w, -h], [w, h], [-w, h]].map(([x, y]) => mesh.localToWorld(new THREE.Vector3(x, y, 0)).project(cam));
  const rect = { x0: Math.min(...pts.map((p) => p.x)), x1: Math.max(...pts.map((p) => p.x)), y0: Math.min(...pts.map((p) => p.y)), y1: Math.max(...pts.map((p) => p.y)) };
  const css = { x: cr.left + (rect.x0 + 1) / 2 * cr.width, y: cr.top + (1 - rect.y1) / 2 * cr.height, w: (rect.x1 - rect.x0) / 2 * cr.width, h: (rect.y1 - rect.y0) / 2 * cr.height };
  return { ndc: rect, css, visible: grp.visible, state: s.holo.state(), theme: document.documentElement.dataset.theme || null, cls: document.documentElement.className, win: { w: window.innerWidth, h: window.innerHeight } };
})()`;

app.whenReady().then(async () => {
  const timer = setTimeout(() => { result.errors.push('harness timeout (15 min)'); finish(2); }, 900_000);
  try {
    const win = await until(() => BrowserWindow.getAllWindows()[0], 'main window');
    win.setContentSize(SIZES[0][0], SIZES[0][1]);
    const page = win.webContents;
    page.on('console-message', (...a) => {
      let level, message;
      if (a[0] && typeof a[0] === 'object' && 'level' in a[0]) { level = a[0].level; message = a[0].message; } else { level = a[1]; message = a[2]; }
      if (level === 'error' || level === 3) { result.errors.push(`console: ${String(message).slice(0, 400)}`); console.log(`[renderer] ${String(message).slice(0, 300)}`); }
    });
    const r = (js) => page.executeJavaScript(js, true);
    const boot = async () => {
      await until(() => !page.isLoading() && page.getURL().startsWith('app://'), 'app page loaded');
      await until(() => r(`!!(window.__zumiScene && window.__zumiScene.director.room)`), 'painted v2 room loaded', 90000);
      await until(() => r(`document.getElementById('loading').hidden && document.getElementById('empty-model').hidden`), 'model on stage', 90000);
      await sleep(3000);
    };
    await boot();
    if (THEME !== 'blue') { await r(`localStorage.setItem('zumi.theme', ${JSON.stringify(THEME)})`); page.reload(); await sleep(500); await boot(); }
    result.themeAtBoot = await r(`document.documentElement.dataset.theme || null`);
    result.font = { asked: '"Consolas", "Segoe UI", monospace', consolasOnDisk: fs.existsSync('C:/Windows/Fonts/consola.ttf'), segoeOnDisk: fs.existsSync('C:/Windows/Fonts/segoeui.ttf') };
    await r(`window.__zumiScene.holo.pin(true)`); // the panel keeps its own accent (cyan), never the Settings pick

    const shot = async (name, rectCss) => {
      await sleep(900); // flicker (220 ms) + accent crossfade (250 ms) + a few real frames
      const pad = rectCss ? rectCss.h * 0.25 : 0; // the hover bob moves the panel between reading its rect and the capture: pad the crop above and below
      let img = await page.capturePage(rectCss ? { x: Math.max(0, Math.floor(rectCss.x - 8)), y: Math.max(0, Math.floor(rectCss.y - pad)), width: Math.ceil(rectCss.w + 16), height: Math.ceil(rectCss.h + 2 * pad) } : undefined);
      if (rectCss) img = img.resize({ width: Math.min(MAX_W, img.getSize().width * 2) });
      else if (img.getSize().width > MAX_W) img = img.resize({ width: MAX_W });
      fs.writeFileSync(path.join(OUT, name), img.toPNG());
      result.shots.push({ name, ...img.getSize() });
      console.log(`shot ${name} ${img.getSize().width}x${img.getSize().height}`);
    };
    const resize = async (w, h) => { // setContentSize on this off-screen window leaves the frame in the size (1920 -> 1936): correct by the measured delta until the content is exact
      let tw = w, th = h;
      for (let i = 0; i < 4; i++) { win.setContentSize(tw, th); await sleep(700); const [cw, ch] = win.getContentSize(); if (cw === w && ch === h) break; tw += w - cw; th += h - ch; }
      await sleep(800);
    };
    // The panel + its legibility: the smallest canvas font the last draw used x (panel on-screen width / 512 canvas px). Under 11 px = a failed run.
    const rec = async (key) => {
      const p = await r(PANEL); result.panels[key] = p;
      if (p && p.css && p.state) {
        const onScreen = p.state.minFontPx * p.css.w / p.state.cssW;
        result.legible[key] = { panelCssW: Math.round(p.css.w), minFontPx: p.state.minFontPx, onScreenPx: +onScreen.toFixed(1) };
        console.log(`legible ${key}: ${Math.round(p.css.w)} px wide, ${p.state.minFontPx} px font -> ${onScreen.toFixed(1)} px on screen`);
        if (!(onScreen >= MIN_ON_SCREEN_PX)) result.errors.push(`legibility: ${key} smallest text ${onScreen.toFixed(1)} px on screen < ${MIN_ON_SCREEN_PX}`);
      } else result.errors.push(`no panel read for ${key}`);
      return p;
    };
    const floatOn = async (on) => { await r(`window.__zumiScene.float.set(${on})`); await sleep(2500); };
    const feed = (rows) => r(`window.__zumiScene.holo.setFeed(${JSON.stringify(rows)})`);
    const work = (rows) => r(`window.__zumiScene.work.feed(${JSON.stringify(rows)})`);

    // float shot + seated shot (the panel is up only while the working signal is on: an active step with recent activity)
    const pair = async (w, h) => {
      const tag = `${TAG}-${w}x${h}`;
      await resize(w, h);
      await floatOn(true); await feed(FEED_EN());
      await shot(`holo-float-${tag}.png`);
      await rec(`float-${tag}`);
      await floatOn(false); await feed(FEED_EN()); await work(rowFor({ stepState: 'active' }));
      if (HUD) { page.send('hud:feed', { style: 'a', feed: { updates: FEED_EN(), waiting: HUD_WAITING, waitingCount: HUD_WAITING.length, taskKeys: {}, waitKeys: {} } }); await sleep(800); } // the seated panel is up only while the WORKING signal is on: an active step (the holo row keeps STATE)
      await sleep(1200);
      await shot(`holo-seated-${tag}.png`);
      await rec(`seated-${tag}`);
      if (HUD) { page.send('hud:feed', { style: 'off' }); await sleep(400); }
      await work([]);
    };
    const [w1, h1] = SIZES[0], [w2, h2] = SIZES[1];
    // 1. the REAL feed path (REVIEW-OPUS S1): main sends 'hud:feed' exactly as hud-host does -> preload -> hud.js -> onHoloFeed -> holo.setFeed. No dev seam is called here.
    await resize(w1, h1); await floatOn(true);
    page.send('hud:feed', { style: 'a', feed: { updates: FEED_EN(), waiting: [], taskKeys: {}, waitKeys: {} } });
    await sleep(600);
    const viaHud = await r(`window.__zumiScene.holo.state().pageName`);
    result.hudPath = { pageNameAfterHudFeed: viaHud };
    if (viaHud !== 'task') result.errors.push(`hud:feed did not reach the panel (pageName ${viaHud})`);
    await shot(`holo-hudpath-float-${TAG}-${w1}x${h1}.png`);
    await rec(`hudpath-float-${TAG}-${w1}x${h1}`);
    page.send('hud:feed', { style: 'off' });
    await sleep(600);
    result.hudPath.pageNameAfterHudOff = await r(`window.__zumiScene.holo.state().pageName`);
    // 2. float + seated through the seam
    await pair(w1, h1);
    // 3. the talk framing in float: FLOAT_CLOSE (head-to-knees), where the panel is largest; seated already uses the CHEST_UP talk crop
    await r(`window.__zumiScene.float.setFraming('close')`); await floatOn(true); await feed(FEED_EN());
    await shot(`holo-float-close-${TAG}-${w1}x${h1}.png`);
    await rec(`float-close-${TAG}-${w1}x${h1}`);
    await r(`window.__zumiScene.float.setFraming('wide')`); await sleep(1500);
    // the empty feed (HUD off / nothing running): the float panel reads NO LIVE TASK, nothing invented
    await floatOn(true); await feed([]);
    await shot(`holo-empty-float-${TAG}-${w1}x${h1}.png`);
    await rec(`empty-float-${TAG}-${w1}x${h1}`);
    // a Vietnamese step label (the board's text is author-written): full shot + a 2x crop of the panel
    await feed(FEED_VI());
    await shot(`holo-vi-float-${TAG}-${w1}x${h1}.png`);
    const pv = await rec(`vi-float-${TAG}-${w1}x${h1}`);
    if (pv && pv.css) await shot(`holo-vi-crop-${TAG}.png`, pv.css);
    await pair(w2, h2);
    clearTimeout(timer);
    finish(result.errors.length ? 1 : 0);
  } catch (e) {
    result.errors.push(String(e && e.stack || e));
    console.error(e);
    clearTimeout(timer);
    finish(2);
  }
});
