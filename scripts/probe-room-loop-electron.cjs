// Real-frame probe for the room-video plate flash (T-31 0.2.11): counts, per rendered frame, every frame on which
// CameraDirector.drawPlate() painted the PAINTED B PLATE instead of the room video, through a loop-restart path AND a
// room-switch path. Renders only on the render box (guard below); never on anh's main PC.
//
//   electron scripts/probe-room-loop-electron.cjs --app <dir | …/resources/app.asar> --out <dir> --userdata <dir> --model <file.vrm>
//     [--videos <dir>]       the .mp4 folder (default: the manifest's localDir; a packed build: <resources>/rooms-video)
//     [--loops N]            loop wraps to observe on the launch room (default 6; cozy-study loops every 6.08 s)
//     [--switches M]         room switches to make, cycling every video room (default 8)
//     [--expect-plates]      BASELINE mode (the unfixed c2d733aa + scripts/probe-room-loop-hook-only.patch): exit 0 only if plate
//                            frames WERE seen after the first video frame, i.e. the probe can see the defect.
//
// How: the page gets `window.__zumiPlateProbe` injected over CDP before its first script (the same mechanism as the
// room-picker harness's drawImage spy). app.js hands it to CameraDirector.plateProbe, which calls it once per drawPlate()
// with { kind: 'video' | 'plate' | 'hold', reason, view, switching, t }. No installed app sets that global, so the hook is
// off everywhere else. `plate` = the B plate was painted (reason no-scene | not-ready | other-view); `hold` = the fix kept
// the last video frame (loop seek gap); `video` = the video was painted. The injected script also remembers the <video>
// (HTMLMediaElement.play spy) so loop wraps are counted per frame from currentTime, which works on a packaged app.
// PASS = 0 `plate` frames after the first `video` frame, over >= N loop wraps and >= M switches. Plate frames BEFORE the first
// video frame (first launch: nothing to hold yet) are reported separately and do not count.
// Writes <out>/probe.json (+ the first 60 plate events) and exits 0/1.
'use strict';
const path = require('node:path');
const fs = require('node:fs');
require('./lib/electron-guard.cjs').exitUnlessElectronHost('probe-room-loop-electron.cjs');
const { app, BrowserWindow } = require('electron');

const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const ROOT = path.join(__dirname, '..');
const APP = path.resolve(arg('--app') || ROOT);
const OUT = path.resolve(arg('--out'));
const USERDATA = path.resolve(arg('--userdata'));
const LOOPS = Number(arg('--loops', 6)), SWITCHES = Number(arg('--switches', 8));
const EXPECT_PLATES = process.argv.includes('--expect-plates');
const LAUNCH_ROOM = 'cozy-study'; // 6.08 s loop
const ROOMS = ['scifi-bridge', 'cozy-study', 'rooftop-night', 'zen-garden', 'grand-library', 'beach-cabin', 'space-station']; // switch cycle (ids from assets/rooms-video/rooms.json)
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(USERDATA, { recursive: true });

process.env.ZUMI_ROOM_V2_DEFAULT_PATH = path.join(ROOT, 'resources-pinned', 'room-v2', 'room.json');
if (arg('--videos')) process.env.ZUMI_ROOMS_VIDEO_DIR = path.resolve(arg('--videos'));
const settingsFile = path.join(USERDATA, 'settings.json');
if (!fs.existsSync(settingsFile)) fs.writeFileSync(settingsFile, JSON.stringify({ room: 'default-v2', uiLang: 'en', sceneRoom: LAUNCH_ROOM }, null, 2));

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

const PROBE_JS = `(() => {
  if (window.__plateProbe) return;
  const S = { video: 0, plate: 0, hold: 0, wraps: 0, firstVideoT: null, phase: 'launch', log: [], byReason: {} };
  window.__plateProbe = S;
  window.__zumiPlateProbe = (e) => {
    if (e.kind === 'video') { S.video++; if (S.firstVideoT == null) S.firstVideoT = e.t; return; }
    S[e.kind]++;
    if (e.kind === 'plate') { const k = (S.firstVideoT == null ? 'launch' : S.phase) + ':' + e.reason; S.byReason[k] = (S.byReason[k] || 0) + 1; }
    if (S.log.length < 400) S.log.push({ kind: e.kind, reason: e.reason, view: e.view, switching: e.switching, t: Math.round(e.t * 10) / 10, phase: S.phase, afterFirstVideo: S.firstVideoT != null });
  };
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...a) { window.__plateProbeVid = this; return play.apply(this, a); };
  let cur = null, last = 0;
  const step = () => { const v = window.__plateProbeVid;
    if (v !== cur) { cur = v; last = v ? v.currentTime : 0; } else if (v) { if (v.currentTime < last - 0.5) S.wraps++; last = v.currentTime; }
    requestAnimationFrame(step); };
  requestAnimationFrame(step);
})();`;

const result = { app: APP, loopsWanted: LOOPS, switchesWanted: SWITCHES, checks: [], errors: [] };
const check = (name, ok, detail) => { result.checks.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); };
const finish = (code) => { fs.writeFileSync(path.join(OUT, 'probe.json'), JSON.stringify(result, null, 1)); setTimeout(() => app.exit(code), 100); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 60000) {
  const t0 = Date.now();
  for (;;) {
    let v; try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`);
    await sleep(100);
  }
}

let probeAttached = null;
app.on('web-contents-created', (_e, wc) => {
  if (probeAttached || wc.getType() !== 'window') return;
  probeAttached = (async () => { wc.debugger.attach('1.3'); await wc.debugger.sendCommand('Page.enable'); await wc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: PROBE_JS }); return true; })()
    .catch((e) => { result.errors.push(`probe inject: ${e && e.message || e}`); return false; });
});

require(path.join(APP, 'src', 'main', 'main.js'));

app.whenReady().then(async () => {
  const timer = setTimeout(() => { result.errors.push('harness timeout (900 s)'); finish(2); }, 900000);
  try {
    const win = await until(() => BrowserWindow.getAllWindows()[0], 'main window');
    win.setContentSize(1280, 800);
    const page = win.webContents;
    await until(() => !page.isLoading() && page.getURL().startsWith('app://'), 'app page loaded');
    const r = (js) => page.executeJavaScript(js, true);
    // The first document can commit before CDP registers the script: reload once so it runs before the first page script.
    if (!(await probeAttached)) throw new Error('probe not injected');
    if (!(await r('!!window.__plateProbe').catch(() => false))) { await new Promise((res) => { page.once('did-finish-load', res); page.reload(); }); result.reloaded = true; }
    check('probe injected before the first page script', await r('!!window.__zumiPlateProbe'));
    const S = (js) => r(`(() => { const S = window.__plateProbe; return ${js}; })()`);

    // ---- launch: plate frames here are expected (nothing to hold yet); the video's first frame ends this phase ----
    await until(() => S('S.firstVideoT != null'), 'first video frame', 120000);
    await sleep(500);
    const launch = await S('({ plate: S.plate, byReason: { ...S.byReason } })');
    result.launch = launch;
    console.log(`launch: ${launch.plate} plate frame(s) before the first video frame (expected, not counted)`);

    // ---- loop path: N wraps of the launch room ----
    await S('(S.phase = "loop", true)');
    const w0 = await S('S.wraps'), p0 = await S('S.plate'), h0 = await S('S.hold'), v0 = await S('S.video');
    await until(async () => (await S('S.wraps')) - w0 >= LOOPS, `${LOOPS} loop wraps`, LOOPS * 7000 + 60000);
    const loop = { wraps: (await S('S.wraps')) - w0, plateFrames: (await S('S.plate')) - p0, holdFrames: (await S('S.hold')) - h0, videoFrames: (await S('S.video')) - v0 };
    result.loop = loop;
    check(`loop path: 0 plate frames across ${loop.wraps} loop wraps (hold frames, where the fix kept the last frame: ${loop.holdFrames})`, loop.wraps >= LOOPS && loop.plateFrames === 0, loop);

    // ---- switch path: M switches through the real picker ----
    await S('(S.phase = "switch", true)');
    const p1 = await S('S.plate'), v1 = await S('S.video');
    let done = 0, prev = LAUNCH_ROOM;
    for (let i = 0; i < SWITCHES; i++) {
      const id = ROOMS.filter((x) => x !== prev)[i % (ROOMS.length - 1)];
      const vidBefore = await r('(window.__plateProbeVid || {}).src || null');
      await r(`(() => { const sel = document.getElementById('scene-select'); sel.value = ${JSON.stringify(id)}; sel.dispatchEvent(new Event('change')); })()`);
      try {
        await until(async () => r(`(() => { const v = window.__plateProbeVid; return !!v && v.src !== ${JSON.stringify(vidBefore)} && v.readyState >= 2 && document.getElementById('scene-select').value === ${JSON.stringify(id)}; })()`), `room ${id} playing`, 30000);
        done++; prev = id;
      } catch (e) { result.errors.push(String(e.message || e)); break; }
      await sleep(900);
    }
    const sw = { switches: done, plateFrames: (await S('S.plate')) - p1, videoFrames: (await S('S.video')) - v1 };
    result.switch = sw;
    check(`switch path: 0 plate frames across ${sw.switches} room switches`, sw.switches >= SWITCHES && sw.plateFrames === 0, sw);

    const total = await S('({ plate: S.plate, hold: S.hold, video: S.video, wraps: S.wraps, byReason: { ...S.byReason }, log: S.log.filter((e) => e.kind === "plate").slice(0, 60) })');
    result.total = { plate: total.plate, hold: total.hold, video: total.video, wraps: total.wraps, byReason: total.byReason };
    result.plateEvents = total.log;
    const afterFirstVideo = total.plate - launch.plate;
    result.plateFramesAfterFirstVideo = afterFirstVideo;
    result.verdict = EXPECT_PLATES ? (afterFirstVideo > 0 ? 'BASELINE-DEFECT-SEEN' : 'BASELINE-NOT-SEEN') : (afterFirstVideo === 0 && result.checks.every((c) => c.ok) ? 'PASS' : 'FAIL');
    console.log(`verdict ${result.verdict}: ${afterFirstVideo} plate frame(s) after the first video frame; by reason ${JSON.stringify(total.byReason)}`);
    clearTimeout(timer);
    finish(EXPECT_PLATES ? (afterFirstVideo > 0 ? 0 : 1) : (result.verdict === 'PASS' ? 0 : 1));
  } catch (e) {
    result.errors.push(String(e && e.stack || e)); result.verdict = 'ERROR';
    console.log(`ERROR ${e && e.message || e}`);
    clearTimeout(timer); finish(2);
  }
});
