// Electron harness for the video-room picker (T-31 room picker, 13-10). Runs the REAL app (src/main/main.js from a
// source tree or a packed app.asar) in its own userData, in a window shown off the desktop (never over the owner's
// screen, never focused, no taskbar button), with the pinned painted room (resources-pinned/room-v2) and a test model.
// Never touches an installed Zumi or its data.
//   electron scripts/electron-room-picker.cjs --app <dir | …/resources/app.asar> --out <dir> --userdata <dir> --model <file.vrm>
//     [--videos <dir>]          the .mp4 folder (default: the manifest's localDir; a packed build: <resources>/rooms-video)
//     [--expect-selected <id>]  phase 2 of the persistence check: the picker must come up on <id> after a restart
//     [--shots]                 app-*.png for the dropdown + every room at the talk camera
//     [--rooms-chair]           qc-021 ROOM-CROP gate instead of the picker run: a fresh userData with no chair3d key (anh's
//                               case) gets DEFAULT_CHAIR in every video room, with the painted cut-out never drawn; the
//                               Settings chair select writes settings.json chair3d ('painted' brings the cut-out back)
//     [--launch-room <id>]      with --rooms-chair: the LAUNCH case instead (review of 0.2.2: no cut-out flash at launch).
//                               A fresh userData whose stored room is the video room <id> and no chair3d key (anh's 0.2.1
//                               state). A drawImage spy is put into the page before any page script runs (CDP
//                               addScriptToEvaluateOnNewDocument), so it sees the plate canvas from its first frame; early
//                               frames are captured every ~300 ms as launch-<id>-<ms>.png. If the first document beat the
//                               spy, the page is reloaded once (result.json spy.reloaded).
// Writes <out>/result.json { checks: [{name, ok, detail}], shots: [...] } and exits 1 on any failed check.
'use strict';
const path = require('node:path');
const fs = require('node:fs');
// Runs inside Electron: render box only (scripts/lib/electron-guard.cjs), refused (exit 1, no dialog) before the app starts.
require('./lib/electron-guard.cjs').exitUnlessElectronHost('electron-room-picker.cjs');
const { app, BrowserWindow } = require('electron');

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const ROOT = path.join(__dirname, '..');
const APP = path.resolve(arg('--app') || ROOT);
const OUT = path.resolve(arg('--out'));
const USERDATA = path.resolve(arg('--userdata'));
const EXPECT = arg('--expect-selected');
const SHOTS = process.argv.includes('--shots');
const ROOMS_CHAIR = process.argv.includes('--rooms-chair');
const LAUNCH_ROOM = ROOMS_CHAIR ? arg('--launch-room') : null;
const PROFILE = LAUNCH_ROOM && process.argv.includes('--profile'); // launch.cpuprofile: a V8 CPU profile of the renderer over the launch
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(USERDATA, { recursive: true });

// The approved painted room, pinned in this tree (the same files the owner build ships as extraResources).
process.env.ZUMI_ROOM_V2_DEFAULT_PATH = path.join(ROOT, 'resources-pinned', 'room-v2', 'room.json');
if (arg('--videos')) process.env.ZUMI_ROOMS_VIDEO_DIR = path.resolve(arg('--videos'));
// First run: start on the painted v2 room (what the owner's install uses); a phase-2 run keeps the stored settings.
const settingsFile = path.join(USERDATA, 'settings.json');
if (!fs.existsSync(settingsFile)) fs.writeFileSync(settingsFile, JSON.stringify({ room: 'default-v2', uiLang: 'en', ...(LAUNCH_ROOM ? { sceneRoom: LAUNCH_ROOM } : {}) }, null, 2));

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
// --launch-room: every drawImage on the plate canvas (#stage-plate) is counted per image object from the page's first
// script on, so a cut-out drawn for even one frame before the 3D chair is attached cannot be missed.
const CUT_SPY = `(() => { const P = CanvasRenderingContext2D.prototype, orig = P.drawImage, seen = new Map();
  window.__cutSpy = { t0: performance.now(), seen, long: [] };
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__cutSpy.long.push([Math.round(e.startTime), Math.round(e.duration)]); }).observe({ type: 'longtask', buffered: true }); } catch {}
  P.drawImage = function (img, ...a) {
    try { if (img && this.canvas && this.canvas.id === 'stage-plate') { const now = performance.now(), e = seen.get(img);
      if (e) { e.n++; e.last = now; } else seen.set(img, { n: 1, first: now, last: now, w: img.width || img.videoWidth, h: img.height || img.videoHeight }); } } catch {}
    return orig.call(this, img, ...a); }; })();`;
let spyAttached = null;
if (LAUNCH_ROOM) {
  app.on('web-contents-created', (_e, wc) => {
    if (spyAttached || wc.getType() !== 'window') return;
    spyAttached = (async () => { wc.debugger.attach('1.3'); await wc.debugger.sendCommand('Page.enable'); await wc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: CUT_SPY }); return true; })()
      .catch((e) => { result.errors.push(`cut spy: ${e && e.message || e}`); return false; });
  });
}

const result = { app: APP, checks: [], shots: [], errors: [] };
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

require(path.join(APP, 'src', 'main', 'main.js'));

app.whenReady().then(async () => {
  const timer = setTimeout(() => { result.errors.push('harness timeout (420 s)'); finish(2); }, 420000);
  try {
    const win = await until(() => BrowserWindow.getAllWindows()[0], 'main window');
    win.setContentSize(1280, 800); // the app's own default content size
    const page = win.webContents;
    page.on('console-message', (e) => { const m = e.message || ''; if (/video room|error/i.test(m)) { result.errors.push(`console: ${m}`.slice(0, 400)); console.log(`[renderer] ${m.slice(0, 300)}`); } });
    await until(() => !page.isLoading() && page.getURL().startsWith('app://'), 'app page loaded');
    const r = (js) => page.executeJavaScript(js, true);
    const shot = async (name) => { await sleep(300); const img = await page.capturePage(); fs.writeFileSync(path.join(OUT, name), img.toPNG()); result.shots.push(name); console.log(`shot ${name}`); };
    if (LAUNCH_ROOM) {
      const spyOk = await spyAttached;
      // The first document can commit before CDP registers the spy (box run launch1, 14-10: spy null). Then the renderer
      // is started again by one reload: same stored settings, same main process, and the spy runs before its first script.
      const reloaded = spyOk && !(await r('!!window.__cutSpy').catch(() => false));
      if (PROFILE) { await page.debugger.sendCommand('Profiler.enable'); await page.debugger.sendCommand('Profiler.setSamplingInterval', { interval: 2000 }); await page.debugger.sendCommand('Profiler.start'); }
      if (reloaded) await new Promise((res) => { page.once('did-finish-load', res); page.reload(); });
      result.spy = { reloaded, atLoad: await r('window.__cutSpy ? window.__cutSpy.t0 : null').catch(() => null) };
      const t0 = Date.now();
      const look = () => r(`(() => { const s = window.__zumiScene; if (!s) return { boot: true };
        return { scene: !!s.director.scene, ready: s.sceneVideo.ready, chair: s.chair3d.active ? (s.chair3d.entry || {}).id : null, drawChair: s.sceneVideo.drawChair }; })()`).catch(() => ({ boot: true }));
      // Early frames: from the first one where the renderer's scene exists until the video room shows with the 3D chair on,
      // plus 3 s (the stage before the video's first frame is the painted room or the loading screen).
      const frames = [];
      let doneAt = null;
      // the moment the 3D chair is attached, on the page clock (for: never a video room without its chair)
      const wrapAttach = () => r(`(() => { const s = window.__zumiScene; if (!s || s.__attachWrapped || !window.__cutSpy) return; s.__attachWrapped = true;
        const c = s.chair3d, a = c.attach.bind(c); c.attach = (...x) => { if (window.__cutSpy.chairAt == null) window.__cutSpy.chairAt = performance.now(); return a(...x); }; })()`).catch(() => {});
      while (Date.now() - t0 < 120000) {
        await wrapAttach();
        const st = await look();
        const img = await page.capturePage().catch(() => null);
        const ms = Date.now() - t0;
        if (img && !st.boot) frames.push({ ms, st, png: img.toPNG() });
        if (!doneAt && st.scene && st.ready && st.chair) doneAt = Date.now();
        if (doneAt && Date.now() - doneAt > 3000) break;
        await sleep(300);
      }
      const keep = frames.length <= 16 ? frames : frames.filter((_, i) => i < 10 || i % Math.ceil(frames.length / 6) === 0);
      for (const f of keep) { const name = `launch-${LAUNCH_ROOM}-${String(f.ms).padStart(6, '0')}.png`; fs.writeFileSync(path.join(OUT, name), f.png); result.shots.push(name); }
      result.launchFrames = frames.map((f) => ({ ms: f.ms, ...f.st }));
      const spy = await r(`(() => { const sp = window.__cutSpy, sv = window.__zumiScene.sceneVideo; if (!sp) return null;
        const all = [...sp.seen].map(([img, e]) => ({ kind: img === sv.chair ? 'cut-out' : img === sv.video ? 'video' : (img.constructor && img.constructor.name) || '?', ...e }));
        return { spyAt: sp.t0, cut: (sp.seen.get(sv.chair) || { n: 0 }).n, video: (sp.seen.get(sv.video) || { n: 0 }).n, all }; })()`);
      if (PROFILE) { const { profile } = await page.debugger.sendCommand('Profiler.stop'); fs.writeFileSync(path.join(OUT, 'launch.cpuprofile'), JSON.stringify(profile)); }
      result.timing = await r(`(() => { const sp = window.__cutSpy, sv = window.__zumiScene.sceneVideo; if (!sp) return null; const e = [...sp.seen].filter(([img]) => img !== sv.video && img !== sv.chair).map(([, v]) => v);
        return { firstPlate: e.length ? Math.round(Math.min(...e.map((v) => v.first))) : null, firstVideo: sp.seen.get(sv.video) ? Math.round(sp.seen.get(sv.video).first) : null, chairAt: sp.chairAt == null ? null : Math.round(sp.chairAt), long: sp.long.filter((x) => x[1] >= 500) }; })()`).catch(() => null);
      console.log(`timing ${JSON.stringify(result.timing)}`);
      let settings = {}; try { settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch {}
      const fin = await look();
      check(`launch ${LAUNCH_ROOM}: the drawImage spy ran from the page's first script (CDP) and saw the video frames`, spyOk === true && result.spy.atLoad !== null && spy && spy.video > 0, { spyOk, ...result.spy, spy: spy && { spyAt: spy.spyAt, video: spy.video } });
      check(`launch ${LAUNCH_ROOM}: stored room ${LAUNCH_ROOM}, no chair3d key -> the video room shows with the default 3D chair`, settings.chair3d === undefined && settings.sceneRoom === LAUNCH_ROOM && fin.scene && fin.ready && !!fin.chair && fin.drawChair === false, { fin, chair3d: settings.chair3d, sceneRoom: settings.sceneRoom });
      check(`launch ${LAUNCH_ROOM}: the painted cut-out was drawn 0 times from the first frame on (no flash at launch)`, spy && spy.cut === 0, spy && spy.all);
      const tm = result.timing || {};
      if (tm.firstVideo != null) result.timing.videoWithChair = Math.max(tm.firstVideo, tm.chairAt == null ? Infinity : tm.chairAt);
      check(`launch ${LAUNCH_ROOM}: never a video room without its 3D chair (first video frame after the chair attached)`, tm.chairAt != null && tm.firstVideo != null && tm.firstVideo >= tm.chairAt, tm);
      check(`launch ${LAUNCH_ROOM}: early frames kept (${keep.length} of ${frames.length})`, keep.length > 0, result.launchFrames.slice(0, 6));
      clearTimeout(timer); finish(result.checks.every((x) => x.ok) ? 0 : 1); return;
    }
    await until(() => r(`!!(window.__zumiScene && window.__zumiScene.director.room)`), 'painted v2 room loaded', 90000);
    await sleep(1500);
    await until(() => r(`document.getElementById('loading').hidden && document.getElementById('empty-model').hidden`), 'model on stage', 90000);
    await sleep(4000); // seat pose + spring bones settle

    const state = () => r(`(() => { const s = window.__zumiScene, v = s.sceneVideo.video, sel = document.getElementById('scene-select');
      return { selected: sel.value, options: [...sel.options].map((o) => o.value + '|' + o.textContent), pickerHidden: document.getElementById('scene-picker').hidden,
        active: !!s.director.scene, ready: s.sceneVideo.ready, paused: v ? v.paused : null, loop: v ? v.loop : null, muted: v ? v.muted : null, t: v ? v.currentTime : null,
        view: s.director.view, viewPickerDisabled: document.getElementById('room-view-select').disabled }; })()`);
    const pick = async (id) => {
      await r(`(() => { const sel = document.getElementById('scene-select'); sel.value = ${JSON.stringify(id)}; sel.dispatchEvent(new Event('change')); })()`);
      if (id === 'current') await until(async () => !(await state()).active, 'back to the painted room', 20000);
      else await until(async () => { const s = await state(); return s.active && s.ready && s.selected === id; }, `room ${id} playing`, 30000);
      await sleep(1200);
    };
    // Edge pixels of the plate canvas: a part of the crop window the video does not cover stays cleared (alpha 0).
    const edges = () => r(`(() => { const c = document.getElementById('stage-plate'), x = c.getContext('2d'), w = c.width, h = c.height;
      const strips = [x.getImageData(0, 0, w, 2), x.getImageData(0, h - 2, w, 2), x.getImageData(0, 0, 2, h), x.getImageData(w - 2, 0, 2, h)];
      let empty = 0; for (const s of strips) for (let i = 3; i < s.data.length; i += 4) if (s.data[i] < 250) empty++; return { w, h, empty }; })()`);
    // Topmost element at the stage centre and the order below it.
    const zorder = () => r(`(() => { const st = document.getElementById('stage').getBoundingClientRect();
      return document.elementsFromPoint(st.left + st.width / 2, st.top + st.height / 2).map((e) => e.id || e.tagName).slice(0, 4); })()`);

    let s = await state();
    if (EXPECT) {
      check(`persist: after a restart the picker comes up on '${EXPECT}'`, s.selected === EXPECT, s.selected);
      await until(async () => (await state()).ready, 'stored room playing', 30000).catch(() => null);
      s = await state();
      check('persist: the stored room is the one playing', s.active && s.ready && !s.paused, s);
      if (SHOTS) await shot(`app-restart-${EXPECT}.png`);
      clearTimeout(timer); finish(result.checks.every((c) => c.ok) ? 0 : 1); return;
    }

    if (ROOMS_CHAIR) {
      // Counts drawImage calls of the painted cut-out bitmap on the plate canvas since the last call.
      const cutoutDraws = () => r(`(() => { const sv = window.__zumiScene.sceneVideo; if (sv.__cut === undefined) { sv.__cut = 0;
        const c = document.getElementById('stage-plate').getContext('2d'), orig = c.drawImage.bind(c);
        c.drawImage = (img, ...a) => { if (img && img === sv.chair) sv.__cut++; return orig(img, ...a); }; }
        const n = sv.__cut; sv.__cut = 0; return n; })()`);
      const chairState = () => r(`(() => { const s = window.__zumiScene, p = document.getElementById('chair-picker');
        return { picker: p.value, options: [...p.options].map((o) => o.value + '|' + o.textContent), pickerDisabled: p.disabled,
          active: s.chair3d.active, chair: s.chair3d.entry ? s.chair3d.entry.id : null, drawChair: s.sceneVideo.drawChair }; })()`);
      const stored = () => { try { return JSON.parse(fs.readFileSync(settingsFile, 'utf8')).chair3d; } catch { return undefined; } };
      const pickChair = async (id) => {
        await r(`(() => { const p = document.getElementById('chair-picker'); p.value = ${JSON.stringify(id)}; p.dispatchEvent(new Event('change')); })()`);
        await until(async () => { const c = await chairState(); return c.picker === id && c.active === (id !== 'painted') && (id === 'painted' || c.chair === id); }, `chair ${id} applied`, 30000);
        await sleep(800);
      };
      let c = await chairState();
      const dflt = c.picker;
      check('rooms-chair: no chair3d key -> the Settings chair select starts on a 3D chair (DEFAULT_CHAIR)', dflt !== 'painted' && stored() === undefined && c.active && c.chair === dflt, c);
      check('rooms-chair: the chair select lists painted + every chair with a label', !c.pickerDisabled && c.options.length >= 2 && c.options[0].startsWith('painted|') && c.options.every((o) => o.split('|')[1]), c.options);
      if (SHOTS) {
        // Settings > Room > Chair as a fresh install sees it, then its options as an expanded list box (a native <select>
        // popup is its own OS window, which capturePage cannot see), then back to the Zumi tab.
        await r(`document.querySelector('.tab[data-tab="settings"]').click()`);
        await sleep(800);
        await r(`document.getElementById('chair-picker').scrollIntoView({ block: 'center' })`);
        await shot('settings-chair-picker.png');
        await r(`(() => { const sel = document.getElementById('chair-picker'), b = sel.getBoundingClientRect(); sel.size = sel.options.length;
          Object.assign(sel.style, { position: 'fixed', left: b.left + 'px', top: b.top + 'px', width: Math.max(b.width, 220) + 'px', height: 'auto', maxHeight: 'none', overflow: 'hidden', zIndex: 50 }); })()`);
        await shot('settings-chair-picker-open.png');
        await r(`(() => { const sel = document.getElementById('chair-picker'); sel.size = 0; sel.removeAttribute('style'); document.querySelector('.tab[data-tab="zumi"]').click(); })()`);
        await sleep(800);
      }
      const rooms = s.options.slice(1).map((o) => o.split('|')[0]);
      check('rooms-chair: 7 video rooms listed', rooms.length === 7, rooms);
      for (const id of rooms) {
        await pick(id);
        await cutoutDraws(); await sleep(1500);
        const n = await cutoutDraws();
        c = await chairState();
        const st = await state();
        check(`rooms-chair ${id}: 3D chair '${dflt}' attached, painted cut-out drawn 0 times over 1.5 s`, st.active && st.ready && c.active && c.chair === dflt && c.drawChair === false && n === 0, { n, c });
        if (SHOTS) await shot(`rooms-chair-${id}.png`);
      }
      // The control: 'painted' from the Settings select is stored and brings the cut-out back (so the 0 above can bite).
      await pickChair('painted');
      await cutoutDraws(); await sleep(1500);
      let n = await cutoutDraws();
      check("rooms-chair: Settings select 'painted' -> settings.json chair3d 'painted', cut-out drawn again", stored() === 'painted' && n > 0 && (await chairState()).drawChair === true, { stored: stored(), n });
      await pickChair(dflt);
      await cutoutDraws(); await sleep(1500);
      n = await cutoutDraws();
      check(`rooms-chair: Settings select '${dflt}' -> settings.json chair3d '${dflt}', cut-out gone again`, stored() === dflt && n === 0, { stored: stored(), n });
      await pick('current');
      c = await chairState();
      check('rooms-chair: the painted room keeps the 3D chair too', c.active && c.chair === dflt, c);
      if (SHOTS) await shot('rooms-chair-current.png');
      clearTimeout(timer); finish(result.checks.every((x) => x.ok) ? 0 : 1); return;
    }

    check('default: the picker starts on "Current room (default)"', s.selected === 'current' && !s.active, s);
    check('picker: visible with Current room + 7 rooms', !s.pickerHidden && s.options.length === 8 && s.options[0] === 'current|Current room (default)', s.options);
    const plateSample = await r(`(() => { const c = document.getElementById('stage-plate'); return Array.from(c.getContext('2d').getImageData(Math.round(c.width * 0.8), Math.round(c.height * 0.2), 1, 1).data); })()`);
    if (SHOTS) {
      // The current room at the TALK camera (the harness gives no input, so Auto would drift to the idle 'room' view).
      await r(`(() => { const v = document.getElementById('room-view-select'); v.value = 'talk'; v.dispatchEvent(new Event('change')); })()`);
      await sleep(1500);
      await shot('app-current.png');
      // A native <select> popup is its own OS window, which capturePage cannot see: show the same options as an
      // expanded list box for this one shot, then restore the normal dropdown.
      await r(`(() => { const sel = document.getElementById('scene-select'), b = sel.getBoundingClientRect(); sel.size = sel.options.length;
        Object.assign(sel.style, { position: 'fixed', left: b.left + 'px', top: b.top + 'px', width: b.width + 'px', height: 'auto', maxHeight: 'none', overflow: 'hidden', zIndex: 50 }); })()`);
      await shot('app-dropdown-open.png');
      await r(`(() => { const sel = document.getElementById('scene-select'); sel.size = 0; sel.removeAttribute('style'); })()`);
    }

    const rooms = s.options.slice(1).map((o) => o.split('|')[0]);
    const SIZES = [[1280, 800], [1280, 720], [1920, 1080]];
    for (const id of rooms) {
      await pick(id);
      s = await state();
      check(`${id}: plays muted + looping behind the model, talk view`, s.active && s.ready && !s.paused && s.loop && s.muted && s.view === 'talk' && s.viewPickerDisabled, s);
      const z = await zorder();
      check(`${id}: z-order at the stage centre is model canvas over the room canvas`, z[0] === 'stage-canvas' && z.indexOf('stage-plate') > 0, z);
      const sample = await r(`(() => { const c = document.getElementById('stage-plate'); return Array.from(c.getContext('2d').getImageData(Math.round(c.width * 0.8), Math.round(c.height * 0.2), 1, 1).data); })()`);
      check(`${id}: the room canvas shows the video, not the painted plate`, sample.slice(0, 3).some((v, i) => Math.abs(v - plateSample[i]) > 12), { sample, plateSample });
      if (SHOTS) await shot(`app-${id}.png`); // all room shots first, at the same 1280x800 window as app-current.png
    }
    // Edges, after the shots: resizing the off-screen window does not always come back to the exact first size.
    for (const id of rooms) {
      await pick(id);
      for (const [w, h] of SIZES) {
        win.setContentSize(w, h);
        await sleep(700);
        const e = await edges();
        check(`${id}: no visible video edge at window ${w}x${h} (stage ${e.w}x${e.h})`, e.empty === 0, e);
      }
    }
    win.setContentSize(1280, 800);
    await sleep(500);
    // Seamless loop: the clock wraps (6.5-7.4 s clips) while the element keeps playing.
    {
      const id = rooms[0];
      await pick(id);
      const times = [];
      for (let i = 0; i < 18; i++) { times.push((await state()).t); await sleep(500); }
      const wrapped = times.some((t, i) => i > 0 && t < times[i - 1]);
      s = await state();
      check(`${id}: the loop wraps and keeps playing`, wrapped && !s.paused, times.map((t) => +t.toFixed(2)));
    }
    // Battery: paused while the window is minimized, playing again on restore.
    win.minimize(); await sleep(1200);
    s = await state();
    check('hidden window: the room video pauses (minimize)', s.paused === true, s);
    win.restore(); win.setPosition(-32000, -32000); await sleep(1500);
    s = await state();
    check('visible again: the room video resumes (restore)', s.paused === false, s);
    await pick('current');
    s = await state();
    check('"Current room (default)" restores the painted plate', !s.active && !s.viewPickerDisabled, s);
    // Leave a pick stored for the restart phase.
    await pick('beach-cabin');
    clearTimeout(timer);
    finish(result.checks.every((c) => c.ok) ? 0 : 1);
  } catch (e) {
    result.errors.push(String((e && e.stack) || e));
    console.log(`ERROR ${e && e.message}`);
    clearTimeout(timer);
    finish(2);
  }
});
