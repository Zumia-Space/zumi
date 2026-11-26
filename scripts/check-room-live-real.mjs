// Room live B, P1 merge: the REAL app (built owner payload, WebView2, the real room guest) on the spare box, off-screen, HEAVY lock.
//   node scripts/check-room-live-real.mjs --app <payload dir> --work <scratch dir> --vrm <zumi-v3.1.vrm> --out <dir> [--scenarios live,a1,a3,videorooms] [--pack-dir <unpacked pack>] [--base-app <older payload>] [--kokoro-cache <tts folder>]
//
// live        the 3D room tab opens in the real guest, the host's voice (SpeechOut) + producer drive it through `rpc stage.produce`, the guest
//             polls over the bridge. Measures the mouth-to-audio offset over 3 utterances, the barge-in stop latency over 3 cancels, proves the
//             main webview's Zumi renderer is stopped while the room tab is shown, takes the mid-talk and after-barge-in shots, and (with
//             --pack-dir) proves the pack loads through the owner flavour's --pack-dir (marked as a dev folder, not the bundled copy).
// a1          weak machine: WebView2 on a software renderer, room.live3d = auto, first open -> the app shows the video room, the reason line
//             carries the code, the main Zumi renderer runs, the guest is gone and is not reopened; only a bench verdict is saved on disk
//             (alpha.9.4, ask-11130717, ADR A11: a runtime fallback such as no_ready is for this launch only).
// a3          engine failure: the guest's renderer process crashes (CDP Page.crash) -> `guest_gone`, same four facts.
// videorooms  the Zumi tab with its video room, this build next to --base-app (the bridge payload): same rooms, same framing.
// seated      (alpha.9, needs --pack-dir) Zumi sits at the desk: Zumi tab typing, mid-talk turned to the viewer, barge-in, back to the desk; Room tab
//             wide view, tour frames and Photo shot 1. Not in the default list; name it.
// lag         (T31lag) the Room tab's lip-sync latency on Photo shot 1: 9 utterances in one launch, tone onset -> the guest's mouth open, each
//             <= 120 ms and the median <= LAG_MEDIAN_MS (the alpha.7.1 room). --guest-patch <js file> is evaluated in the guest before the
//             9 utterances (bisect toggles). Not in the default list; name it.
// webcamset   (needs --pack-dir) the Zumi tab's talk set behind her: the guest opens on the local clock's time of day; Day and Night are set through
//             the guest's own day/night chip (CDP mouse events on the guest page, no desktop input); a still of each; then the app is
//             closed and started again on the same data folder: the stored pick wins over the clock; then Auto is picked on the chip and
//             the app closed and started a third time: it follows the clock again. Not in the default list; name it.
// roomnight   (needs --pack-dir) the Room tab by night (its own Night button, a CDP mouse click): her face at the desk is clear, not blown
//             out; wide, Photo shot 1 and close-up stills. Not in the default list; name it.
// ztsay       the 3D room in the Zumi tab: the talk status, Retry voice and the subtitle of Zumi's own line (Kokoro, mid-talk) stay visible,
//             off the guest and above the message box (GATE-OPUS-ALPHA7 should-fix 1). Not in the default list; name it.
// greload     (T31reload) the guest is reloaded in place WHILE it boots (CDP Page.reload 400 ms after its target shows): guestReady must
//             return the new document booted, and that document must poll the stage (stage_tests.rs f2_a_reload_is_a_new_document_not_a_dead_guest).
//             Also records what the first document's boot said and the host's log lines. Not in the default list; name it.
// No paid call, no GUI click on the owner's screen (the window is moved off-screen by offscreen.ps1), nothing outside --work.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { connect, findPorts, sleep, targets, waitTarget } from './lib/cdp-lite.mjs';
import { GuestBootError, guestReady as guestReadyLib } from './lib/guest-ready.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const app = opt('app'), work = opt('work'), vrm = opt('vrm'), out = opt('out'), packDir = opt('pack-dir'), baseApp = opt('base-app'), guestPatch = opt('guest-patch');
const scenarios = (opt('scenarios') || 'live,a1,a3').split(',');
if (!app || !work || !vrm || !out) { console.error('usage: check-room-live-real.mjs --app <dir> --work <dir> --vrm <file> --out <dir> [--scenarios live,a1,a3,videorooms] [--pack-dir <dir>] [--base-app <dir>]'); process.exit(2); }
fs.mkdirSync(out, { recursive: true });
const ID = 'plugin.room-preview';
const GPU_ARGS = '--remote-debugging-port=0 --disable-features=msWebOOUI,msPdfOOUI,CalculateNativeWinOcclusion --disable-renderer-backgrounding --disable-background-timer-throttling --autoplay-policy=no-user-gesture-required';
const SOFT_ARGS = `${GPU_ARGS} --use-angle=swiftshader --disable-gpu`;

const results = {};
const record = (id, pass, detail) => { pass = Boolean(pass); results[id] = { pass, ...detail }; console.log(`${pass ? 'PASS' : 'FAIL'} ${id} ${JSON.stringify(detail).slice(0, 900)}`); };

const KOKORO_CACHE = opt('kokoro-cache'); // a `tts` folder holding the Kokoro model cache (free, local); only the kokoro scenario needs it
async function launch(name, { browserArgs = GPU_ARGS, settings = {}, extraArgs: extra = [], exe = app, keep = false, seedKokoro = false } = {}) {
  const extraArgs = ['--stage-test-hook', ...extra];
  const root = path.join(work, name);
  if (!keep) fs.rmSync(root, { recursive: true, force: true });
  const data = path.join(root, 'data');
  fs.mkdirSync(data, { recursive: true });
  if (seedKokoro && !fs.existsSync(path.join(data, 'tts'))) { if (!KOKORO_CACHE) throw new Error('the kokoro scenario needs --kokoro-cache <tts folder>'); fs.cpSync(KOKORO_CACHE, path.join(data, 'tts'), { recursive: true }); }
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify(settings));
  const helper = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(repo, 'packs', 'room-preview', 'offscreen.ps1'), '-Exe', path.resolve(exe, 'ZumiPreview.exe'), '-Seconds', '900', '-Log', path.join(root, 'offscreen.log')], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise((res, rej) => { helper.stdout.on('data', (d) => { if (String(d).includes('ready')) res(); }); helper.on('exit', () => rej(new Error('offscreen helper exited'))); });
  const child = spawn(path.join(exe, 'ZumiPreview.exe'), ['--data-dir', data, ...extraArgs], { cwd: exe, stdio: 'ignore', env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: browserArgs } });
  console.log(`[${name}] app pid ${child.pid}, helper pid ${helper.pid}`);
  const stop = async () => {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T'], { stdio: 'ignore' }); } catch { /* gone */ }
    for (let i = 0; i < 30 && child.exitCode === null; i++) await sleep(500);
    if (child.exitCode === null) { try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ } }
    try { execFileSync('taskkill', ['/PID', String(helper.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
  };
  const main = await connect((await waitTarget(data, /^http:\/\/tauri\.localhost\//, 120000)).target.webSocketDebuggerUrl);
  await sleep(3000);
  // The sidecar normalises settings.json at start-up; the model and the room switch are written AFTER it (the host reads the file on use).
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ userModelPath: vrm, ...settings }));
  const log = () => {
    const walk = (d, depth) => {
      if (depth > 5) return '';
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isFile() && e.name === 'pack-host.log') return fs.readFileSync(p, 'utf8');
        if (e.isDirectory() && !/^(Cache|Code Cache|GPUCache|EBWebView)$/.test(e.name)) { const r = walk(p, depth + 1); if (r) return r; }
      }
      return '';
    };
    return walk(data, 0);
  };
  return { main, data, stop, log, child };
}

const clickRoomTab = (main) => main.evaluate(`(() => { const b = document.querySelector('[data-tab="pack-${ID}"]'); if (!b) return 'no tab'; b.click(); return 'clicked'; })()`);
const frameCount = (main) => main.evaluate('window.__zumiStageTest ? window.__zumiStageTest.renderer.info.render.frame : -1');
async function guestTarget(data, timeoutMs = 90000) { return connect((await waitTarget(data, /^http:\/\/zumipack\.localhost\/plugin\.room-preview\/ui\/index\.html/, timeoutMs)).target.webSocketDebuggerUrl); }
// The guest's REAL page, booted (scripts/lib/guest-ready.mjs): only in a document whose location is the pack page, a destroyed context retried.
// A page whose boot rejected throws GuestBootError: sLive records it as the `guest boot` row; every other caller (guestUp, sLeadProbe,
// sKokoro, sA3) lets it end the scenario, and the runner records `<scenario> harness` FAIL with the page's error.
const guestReady = (data, timeoutMs = 240000) => guestReadyLib({ connectGuest: (ms) => guestTarget(data, ms), timeoutMs, sleep });
async function guestAlive(data) {
  for (const { port } of findPorts(data)) { try { if ((await targets(port)).some((t) => t.type === 'page' && /zumipack\.localhost/.test(t.url))) return true; } catch { /* stale port */ } }
  return false;
}
const rendererAdvances = async (main, ms = 1500) => { const a = await frameCount(main); await sleep(ms); const b = await frameCount(main); return { a, b, advancing: b - a > 5 }; };
const pngSize = (buf) => ({ w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) });

async function shoot(cdp, file) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const buf = Buffer.from(r.data, 'base64');
  fs.writeFileSync(file, buf);
  return { file, ...pngSize(buf) };
}

// A test tone the host speaks through its real SpeechOut + stage producer (live, seated): burst start/length and total length in ms.
const makeWav = `(burstStartMs, burstMs, totalMs) => { const sr = 24000, n = Math.round(sr * totalMs / 1000), v = new DataView(new ArrayBuffer(44 + n * 2)); const s = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
  s(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); s(8, 'WAVE'); s(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); s(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) { const t = i / sr * 1000; const on = t >= burstStartMs && t < burstStartMs + burstMs; v.setInt16(44 + i * 2, on ? Math.round(9000 * Math.sin(2 * Math.PI * 520 * i / sr) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 4 * i / sr))) : 0, true); }
  return v.buffer; }`;
const speakJs = (burstStartMs, burstMs, totalMs) => `(async () => { const T = window.__zumiStageTest; await T.stage.refresh(); T.stage.setEmotion(1, 80); const mk = ${makeWav}; const prepared = await T.speech.prepare([mk(${burstStartMs}, ${burstMs}, ${totalMs})]); const a = prepared.start(); return { audioStartEpoch: Date.now() + (a.startedAt - performance.now()), sent: T.stage.stats.sent, refused: T.stage.stats.refused, lastError: T.stage.stats.lastError }; })()`;
// ---------------------------------------------------------------------------------------------------------------------------------
async function sLive() {
  const L = await launch('live', { settings: { room: { live3d: 'auto' } }, extraArgs: packDir ? ['--pack-dir', packDir] : [] });
  try {
    const hook = await L.main.evaluate('typeof window.__zumiStageTest');
    console.log('stage test hook', hook, await L.main.evaluate("JSON.stringify({ scene: typeof window.__zumiScene, say: typeof window.__zumiSay, hud: typeof window.__zumiHud, title: document.title, tabs: [...document.querySelectorAll('#sidebar .tab')].map((b) => b.dataset.tab) })"), await L.main.evaluate('window.zumi.info().then((i) => JSON.stringify({ packaged: i.packaged, selftest: i.selftest, demo: i.demo, v: i.version }))'));
    const before = await rendererAdvances(L.main);
    record('D1 main renderer runs on the Zumi tab', before.advancing, before);
    if (packDir) {
      const tabs = await L.main.evaluate("window.__TAURI_INTERNALS__.invoke('pack_list')");
      const t = tabs.find((x) => x.id === ID);
      record('item4 --pack-dir load', Boolean(t) && t.dev === true && t.bundled === false && t.stage === true, { tab: t && { id: t.id, version: t.version, dev: t.dev, bundled: t.bundled, stage: t.stage } });
    }
    console.log('tab click', await clickRoomTab(L.main));
    // a failed boot is its own FAIL row (with the page's error), then ends the scenario: nothing after it can run on a dead room
    const { guest, boot } = await guestReady(L.data).catch((e) => { if (e instanceof GuestBootError) record('guest boot', false, e.boot); throw e; });
    console.log('room boot', JSON.stringify(boot));
    record('guest boot', true, { gpu: boot.gpu, retries: boot.retries });
    await sleep(2000);
    const during = await rendererAdvances(L.main);
    record('D1 main renderer is stopped while the 3D room tab is shown', !during.advancing, during);
    // the stage channel is up: ready, polling, the host says a room is open
    const st = await guest.evaluate('(() => { const s = window.__room.stage; return s ? { polls: s.client.state.polls, closed: s.closed, anchors: true } : null; })()');
    const status = await L.main.evaluate("window.zumi.stage.produce('status', {})");
    record('stage channel up', Boolean(st) && st.polls > 0 && status.active === true, { st, status });
    // F1 bench: 6 s after ready the verdict is made; on the GPU it passes, and is written to disk under a key that names the adapter
    await sleep(9000);
    const benchFile = path.join(L.data, 'stage-bench.json');
    const bench = fs.existsSync(benchFile) ? JSON.parse(fs.readFileSync(benchFile, 'utf8')) : null;
    const key = bench ? Object.keys(bench)[0] : null;
    const stillOpen = await guestAlive(L.data);
    record('item5 bench verdict persisted with the GPU adapter key', Boolean(bench) && Object.values(bench).every((v) => v === true) && key && !key.startsWith('unknown|') && stillOpen, { key, bench, guestOpen: stillOpen, verdictLine: L.log().split('\n').filter((l) => /bench_verdict/.test(l)).slice(-1)[0] });

    // ---- the talk path: SpeechOut + the producer in the main webview, the real rpc, the real bridge, the real guest ----
    await guest.evaluate("window.__room.setMode('photo'); window.__room.setShot(1); true");
    await guest.evaluate(`window.__rec = []; (function loop() { const z = window.__room.zumi; if (z) { const e = z.vrm.expressionManager; window.__rec.push([Date.now(), ['aa','ih','ou','ee','oh'].reduce((a, n) => a + (e.getValue(n) || 0), 0), e.getValue('happy') || 0]); if (window.__rec.length > 4000) window.__rec.shift(); } requestAnimationFrame(loop); })(); true`);
    const offsets = [];
    for (let i = 0; i < 3; i++) {
      await guest.evaluate('window.__rec.length = 0; true');
      const r = await L.main.evaluate(speakJs(300, 1200, 1800), { timeoutMs: 30000 });
      await sleep(2800);
      const sent = await L.main.evaluate('JSON.stringify(window.__zumiStageTest.stage.stats)');
      const rec = await guest.evaluate('window.__rec');
      const onset = r.audioStartEpoch + 300; // the tone starts 300 ms into the audio
      const open = rec.find(([t, m]) => t >= r.audioStartEpoch - 100 && m > 0.2);
      const close = rec.find(([t, m]) => t >= onset + 1000 && m < 0.05);
      offsets.push({ run: i + 1, audioStartEpoch: r.audioStartEpoch, mouthOpenMinusToneOnsetMs: open ? Math.round(open[0] - onset) : null, mouthCloseMinusToneEndMs: close ? Math.round(close[0] - (onset + 1200)) : null, stats: JSON.parse(sent) });
      await sleep(600);
    }
    console.log('mouth-to-audio offsets', JSON.stringify(offsets));
    record('mouth-to-audio offset (3 utterances)', offsets.every((o) => o.mouthOpenMinusToneOnsetMs !== null && Math.abs(o.mouthOpenMinusToneOnsetMs) <= 120 && o.stats.refused === 0), { offsets });

    // ---- barge-in x3: stop the voice and send utterance.cancel exactly like TalkDirector.cancel; time the guest's mouth ----
    const barge = [];
    let midShot = null, afterShot = null;
    for (let i = 0; i < 3; i++) {
      await guest.evaluate('window.__rec.length = 0; true');
      const r = await L.main.evaluate(speakJs(100, 4200, 4500), { timeoutMs: 30000 });
      await sleep(1700);
      if (i === 0) midShot = await shoot(guest, path.join(out, 'shot-1-mid-talk.png'));
      const t = await L.main.evaluate('(() => { const T = window.__zumiStageTest; const at = Date.now(); T.speech.stop(); T.stage.cancel(); return at; })()');
      await sleep(900);
      if (i === 0) afterShot = await shoot(guest, path.join(out, 'shot-2-after-barge-in.png'));
      const rec = await guest.evaluate('window.__rec');
      const openBefore = rec.filter(([x]) => x < t).slice(-8).map((x) => x[1]);
      const closed = rec.find(([x, m]) => x >= t && m < 0.02);
      barge.push({ run: i + 1, mouthOpenJustBefore: Math.max(...openBefore).toFixed(2), closedAfterMs: closed ? Math.round(closed[0] - t) : null });
      await sleep(500);
    }
    console.log('barge-in', JSON.stringify(barge), JSON.stringify({ midShot, afterShot }));
    record('barge-in stops the guest mouth within one poll cycle (3 cancels)', barge.every((b) => b.closedAfterMs !== null && b.closedAfterMs <= 125 + 80 && Number(b.mouthOpenJustBefore) > 0.3), { barge });
    record('shots <= 1600 px', [midShot, afterShot].every((s) => s && s.w <= 1600 && s.h <= 1600), { midShot, afterShot });
    const log = L.log();
    record('no refusal lines in the host log for the stage channel', !/refused (schema_violation|rate_limited|bad_seq)/.test(log), { sample: log.split('\n').filter((l) => /refused/.test(l)).slice(0, 4) });
  } finally { await L.stop(); }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// F1 across two starts (alpha.9.4, ask-11130717: a weak PC falls back automatically, the first launch measures and decides, there is a manual
// override; ADR A11): only the start-up bench verdict is saved. A bench failure opens the video room at once on the next start; a runtime
// fallback (no_ready on the software renderer, the usual case here) saves nothing, so the next start tries 3D again. "Try 3D anyway" is one
// guarded attempt: F1 still closes a dead guest, and that attempt's fallback is not saved either.
const runtimeSaved = (mem) => Boolean(mem) && Object.values(mem).some((v) => typeof v === 'string');
async function sA1b() {
  const name = 'a1b';
  const t0 = Date.now();
  // start 1: the software renderer falls back (bench, or no_ready when it cannot boot inside 20 s)
  let L = await launch(name, { browserArgs: SOFT_ARGS, settings: { room: { live3d: 'auto' } } });
  let first = [];
  try {
    await L.main.evaluate('window.__fb = []; window.zumi.stage.onFallback((p) => window.__fb.push(p)); true');
    await clickRoomTab(L.main);
    for (let i = 0; i < 90 && !first.length; i++) { await sleep(1000); first = await L.main.evaluate('window.__fb'); }
  } finally { await L.stop(); }
  const file = path.join(work, name, 'data', 'stage-bench.json');
  const readMem = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null);
  const mem1 = readMem();
  const reason1 = first[0] ? first[0].reason : null;
  const benchFell = reason1 === 'bench';
  record(benchFell ? 'F1 start 1: weak machine fails the bench, and the bench failure is saved' : 'F1 start 1: weak machine falls back at runtime, and nothing is saved for it',
    first.length === 1 && (benchFell ? Boolean(mem1) && Object.values(mem1).includes(false) : !runtimeSaved(mem1)), { first, mem1, waitedMs: Date.now() - t0 });

  // start 2: same data dir, same adapter and app version
  L = await launch(name, { browserArgs: SOFT_ARGS, settings: { room: { live3d: 'auto' } }, keep: true });
  try {
    await L.main.evaluate('window.__fb = []; window.zumi.stage.onFallback((p) => window.__fb.push(p)); true');
    const t1 = Date.now();
    await clickRoomTab(L.main);
    let fb = [];
    if (benchFell) {
      // a saved bench failure: the video room at once, no bench, no guest
      for (let i = 0; i < 100 && !fb.length; i++) { await sleep(100); fb = await L.main.evaluate('window.__fb'); }
      const tookMs = Date.now() - t1;
      await sleep(1500);
      // The host's own clock: the refusal is logged the moment the tab opens (a software-rendered main page can be slow to run its click handler).
      const refusedAt = Number((L.log().split('\n').filter((l) => /refused open stage_fallback/.test(l)).slice(-1)[0] || '').split(' ')[0]) || null;
      const hostMs = refusedAt ? refusedAt - t1 : null;
      const line = await L.main.evaluate(`(() => { const e = document.querySelector('.stage-reason'); return e ? { reason: e.dataset.reason, retry: !!e.querySelector('.stage-retry') } : null; })()`);
      const alive = await guestAlive(L.data);
      record('F1 start 2: the saved bench failure opens the video room straight away (no bench, no guest)', fb.length === 1 && fb[0].reason === 'bench' && hostMs !== null && hostMs < 15000 && !alive && Boolean(line) && line.reason === 'bench' && line.retry, { fb, tookMs, hostMs, line, guestOpened: alive });
    } else {
      // a runtime fallback saved nothing: 3D is tried again (the host does not refuse the open, the guest opens), and F1 may close it again
      let opened = false;
      for (let i = 0; i < 60 && !opened; i++) { await sleep(500); opened = await guestAlive(L.data); }
      const refusedAtOpen = L.log().split('\n').some((l) => /refused open stage_fallback/.test(l));
      record('F1 start 2: after a runtime fallback the next start tries 3D again (guest opens, no refusal at open)', opened && !refusedAtOpen, { reason1, guestOpened: opened, refusedAtOpen, tookMs: Date.now() - t1 });
      for (let i = 0; i < 90 && !fb.length; i++) { await sleep(1000); fb = await L.main.evaluate('window.__fb'); }
      await sleep(1500);
    }

    // Try 3D anyway (the reason line of this start): one guarded attempt. The guest opens; the software renderer cannot boot it, so R1 closes it
    // (a dead guest is never hidden), the reason line comes back, there is no automatic retry, and the attempt's runtime fallback is not saved.
    await L.main.evaluate('window.__fb = []; true');
    await L.main.evaluate("document.querySelector('.stage-retry').click(); true");
    let opened = false;
    for (let i = 0; i < 60 && !opened; i++) { await sleep(500); opened = await guestAlive(L.data); }
    let fb2 = [];
    for (let i = 0; i < 90 && !fb2.length; i++) { await sleep(1000); fb2 = await L.main.evaluate('window.__fb'); }
    await sleep(1500);
    const line2 = await L.main.evaluate(`(() => { const e = document.querySelector('.stage-reason'); return e ? e.dataset.reason : null; })()`);
    const reopen = await L.main.evaluate(`window.__TAURI_INTERNALS__.invoke('guest_open', { src: 'http://zumipack.localhost/${ID}/ui/index.html', partition: 'pack:${ID}' }).then((r) => ({ resolved: true }), (e) => ({ rejected: String(e) }))`);
    const mem2 = readMem();
    const savedOk = benchFell ? Boolean(mem2) && Object.values(mem2).includes(false) && !runtimeSaved(mem2) : !runtimeSaved(mem2);
    record('F1 Try 3D anyway: one guarded attempt opens the guest, F1 still closes a dead one, no automatic retry, its fallback is not saved', fb.length >= 1 && opened && fb2.length === 1 && line2 === fb2[0].reason && Boolean(reopen.rejected) && /stage_fallback/.test(reopen.rejected) && savedOk, { fbStart2: fb, guestOpenedForTheAttempt: opened, fb2, line2, reopen, mem2 });
  } finally { await L.stop(); }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Lead probe: how many schedules does the host refuse at a given voice lead? (the real producer, the real rpc, the real hub)
async function sLeadProbe() {
  const L = await launch('leadprobe', { settings: { room: { live3d: 'on' } } });
  try {
    await clickRoomTab(L.main);
    const { guest } = await guestReady(L.data);
    await sleep(5000);
    const probe = (lead, n) => `(async () => { const T = window.__zumiStageTest; await T.stage.refresh(); T.stage.leadMs = ${lead};
      const mk = (ms) => { const sr = 24000, k = Math.round(sr * ms / 1000), v = new DataView(new ArrayBuffer(44 + k * 2)); const s = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
        s(0, 'RIFF'); v.setUint32(4, 36 + k * 2, true); s(8, 'WAVE'); s(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); s(36, 'data'); v.setUint32(40, k * 2, true);
        for (let i = 0; i < k; i++) v.setInt16(44 + i * 2, Math.round(9000 * Math.sin(2 * Math.PI * 520 * i / sr)), true); return v.buffer; };
      const before = { sent: T.stage.stats.sent, refused: T.stage.stats.refused }; const errors = [];
      for (let i = 0; i < ${n}; i++) { const prepared = await T.speech.prepare([mk(700 + (i % 5) * 900)]); const a = prepared.start(); await new Promise((r) => setTimeout(r, 120)); T.speech.stop(); await T.stage.cancel(); if (T.stage.stats.lastError) errors.push(T.stage.stats.lastError); T.stage.stats.lastError = null; await new Promise((r) => setTimeout(r, 400)); }
      return { lead: ${lead}, n: ${n}, sent: T.stage.stats.sent - before.sent, refused: T.stage.stats.refused - before.refused, errors: [...new Set(errors)] }; })()`;
    const out = [];
    for (const lead of [150, 160, 175, 200]) out.push(await L.main.evaluate(probe(lead, 20), { timeoutMs: 120000 }));
    console.log('lead probe', JSON.stringify(out));
    const chosen = out.find((o) => o.lead === 175);
    record('voice lead 175 ms: no schedule refused over 20 utterances', chosen.refused === 0, { out });
  } finally { await L.stop(); }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The real talk path with the LOCAL TTS (Kokoro, free, no paid API): zumi.talk.tts -> SpeechOut -> producer -> rpc -> hub -> bridge -> guest.
async function sKokoro() {
  const L = await launch('kokoro', { settings: { room: { live3d: 'on' } }, seedKokoro: true });
  try {
    const info = await L.main.evaluate('Promise.all([window.zumi.talk.voiceInfo(), window.zumi.talk.voiceState()]).then(JSON.stringify)');
    console.log('voice info/state', info);
    await L.main.evaluate('window.zumi.talk.voiceWarm()');
    let st = null;
    for (let i = 0; i < 120; i++) { st = await L.main.evaluate('window.zumi.talk.voiceState().then(JSON.stringify)'); if (/"state":"ready"|"state":"error"/.test(st)) break; await sleep(1000); }
    console.log('voice state after warm', st);
    await clickRoomTab(L.main);
    const { guest } = await guestReady(L.data);
    await sleep(6000);
    await guest.evaluate("window.__room.setMode('photo'); window.__room.setShot(1); true");
    await guest.evaluate(`window.__rec = []; (function loop() { const z = window.__room.zumi; if (z) { const e = z.vrm.expressionManager; window.__rec.push([Date.now(), ['aa','ih','ou','ee','oh'].reduce((a, n) => a + (e.getValue(n) || 0), 0)]); if (window.__rec.length > 6000) window.__rec.shift(); } requestAnimationFrame(loop); })(); true`);
    const lines = ['Hello, I am Zumi. It is nice to see you again today.', 'The weather in the room is lovely, and the sun is coming through the blinds.', 'Tell me what you would like to work on, and I will help you with it.'];
    const results = [];
    let shot = null;
    for (let i = 0; i < lines.length; i++) {
      await guest.evaluate('window.__rec.length = 0; true');
      const r = await L.main.evaluate(`(async () => { const T = window.__zumiStageTest; await T.stage.refresh();
        const turnId = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
        const t0 = performance.now(); const res = await window.zumi.talk.tts({ turnId, text: ${JSON.stringify(lines[i])} });
        if (!res || !res.ok || !res.audios || !res.audios.length) return { ok: false, res: JSON.stringify(res).slice(0, 300) };
        const synthMs = performance.now() - t0;
        const probeCtx = new AudioContext(); const a0 = res.audios[0]; const copy = a0 instanceof ArrayBuffer ? a0.slice(0) : a0.buffer.slice(a0.byteOffset, a0.byteOffset + a0.byteLength);
        const dec = await probeCtx.decodeAudioData(copy); const ch = dec.getChannelData(0); let first = 0; while (first < ch.length && Math.abs(ch[first]) < 0.03) first++;
        const prepared = await T.speech.prepare(res.audios); const a = prepared.start();
        return { ok: true, synthMs: Math.round(synthMs), audioMs: Math.round(prepared.durationMs), firstSoundMs: Math.round(first / dec.sampleRate * 1000), audioStartEpoch: Date.now() + (a.startedAt - performance.now()), refused: T.stage.stats.refused, lastError: T.stage.stats.lastError }; })()`, { timeoutMs: 120000 });
      if (!r.ok) { results.push(r); continue; }
      let spent = 0;
      if (i === 1) { await sleep(600); shot = await shoot(guest, path.join(out, 'shot-3-kokoro-mid-talk.png')); spent = 600; } // the longest line is still being spoken
      await sleep(Math.max(300, r.audioMs + 800 - spent));
      const rec = await guest.evaluate('window.__rec');
      const onset = r.audioStartEpoch + r.firstSoundMs;
      const open = rec.find(([t, m]) => t >= r.audioStartEpoch - 100 && m > 0.15);
      results.push({ run: i + 1, line: lines[i].length, synthMs: r.synthMs, audioMs: r.audioMs, firstSoundMs: r.firstSoundMs, mouthOpenMinusFirstSoundMs: open ? Math.round(open[0] - onset) : null, mouthPeak: Math.max(...rec.map((x) => x[1])).toFixed(2), refused: r.refused, lastError: r.lastError });
    }
    console.log('kokoro talk', JSON.stringify(results), JSON.stringify(shot));
    record('real talk with the local TTS (Kokoro): mouth-open offset on 3 utterances', results.length === 3 && results.every((x) => x.ok !== false && x.mouthOpenMinusFirstSoundMs !== null && Math.abs(x.mouthOpenMinusFirstSoundMs) <= 150 && x.refused === 0) && Boolean(shot) && shot.w <= 1600, { results, shot });
  } finally { await L.stop(); }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Fix round 2 (Opus gate): the 3D room as a choice in the Zumi tab's Room list, on the real app.
const REPLY = 'Hello, I am doing well, thank you for asking. It is lovely to talk with you here in the room.';
const ZT_SETTINGS = { uiLang: 'en', soul: { template: 'friendly' }, room: { live3d: 'auto' } };

const pick3d = (main) => main.evaluate(`(async () => { for (let i = 0; i < 400 && !document.querySelector('#scene-select option[value="3d"]'); i++) await new Promise((r) => setTimeout(r, 100)); const s = document.getElementById('scene-select'); if (!s.querySelector('option[value="3d"]')) return 'no 3d option'; s.value = '3d'; s.dispatchEvent(new Event('change')); return s.value; })()`, { timeoutMs: 60000 });
async function guestUp(L, extraMs = 4000) {
  const { guest } = await guestReady(L.data);
  await guest.evaluate('(async () => { for (let i = 0; i < 300 && !(window.__room.stage && window.__room.stage.client && window.__room.stage.client.state.polls > 0); i++) await new Promise((r) => setTimeout(r, 100)); return true; })()', { timeoutMs: 240000 });
  await sleep(extraMs);
  return guest;
}
const layoutFacts = (main) => main.evaluate(`(() => { const r = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), bottom: Math.round(b.bottom) }; };
  const msg = document.getElementById('msg'); const mb = msg.getBoundingClientRect(); const top = document.elementFromPoint(mb.x + mb.width / 2, mb.y + mb.height / 2);
  const bar = document.querySelector('.stage-reason'); const box = document.getElementById('stage3d'); const view = document.querySelector('.stage3d-view');
  return { select: document.getElementById('scene-select').value, stage3d: r(box), view: r(view), caption: r(document.querySelector('.stage3d-caption')), composer: r(document.querySelector('.composer')), msg: r(msg), msgReachable: top === msg, bar: r(bar), barReason: bar ? bar.dataset.reason : null,
    reply: (document.getElementById('talk-reply') || {}).textContent || '', captionText: (document.querySelector('.stage3d-caption') || {}).textContent || '', tabZumiActive: document.querySelector('.tab[data-tab="zumi"]').classList.contains('active') }; })()`);
function composeShot(mainPng, guestPng, rect, outPng) {
  const py = `from PIL import Image\nm=Image.open(r'${mainPng}').convert('RGB'); g=Image.open(r'${guestPng}').convert('RGB')\nx,y,w,h=${rect.x},${rect.y},${rect.w},${rect.h}\nm.paste(g.resize((w,h)),(x,y)); m.save(r'${outPng}')\n`;
  const r = spawnSync('python', ['-c', py], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`compose failed: ${r.stderr}`);
  const buf = fs.readFileSync(outPng);
  return { file: outPng, ...pngSize(buf) };
}
// The app window is captured twice: the main page (chrome, composer, caption: a native child webview is not part of it) and the guest; the
// guest picture is pasted into the rectangle of the 3D view, which is exactly where the native guest sits.
async function appShot(main, guest, name) {
  const facts = await layoutFacts(main);
  const m = await shoot(main, path.join(out, `${name}-main.png`));
  const g = await shoot(guest, path.join(out, `${name}-guest.png`));
  const composed = composeShot(m.file, g.file, facts.view || { x: 0, y: 0, w: m.w, h: m.h }, path.join(out, `${name}.png`));
  return { facts, composed };
}
const typeIn = (main, text) => main.evaluate(`(() => { const m = document.getElementById('msg'); m.focus(); m.value = ${JSON.stringify(text)}; m.dispatchEvent(new Event('input', { bubbles: true })); m.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return Date.now(); })()`);

async function sZumiTab3d() {
  let L = await launch('zt3d', { settings: ZT_SETTINGS, seedKokoro: true });
  let guest, typedAt, shotA = null, facts0 = null;
  try {
    console.log('pick 3d ->', await pick3d(L.main));
    guest = await guestUp(L, 9000);
    facts0 = await layoutFacts(L.main);
    const noOverlap = facts0.stage3d && facts0.composer && facts0.stage3d.bottom <= facts0.composer.y + 1 && facts0.msgReachable;
    const frames = await rendererAdvances(L.main);
    record('3D room picked in the Zumi tab list: stage3d inside the Zumi tab, message box untouched and reachable, main renderer stopped', facts0.select === '3d' && facts0.tabZumiActive && noOverlap && !frames.advancing, { facts0, frames });
    // the room's guest is the one room (the Room tab viewer stays closed)
    const viewerOpen = await L.main.evaluate("[...document.querySelectorAll('.pack-host webview')].length");
    record('one guest per pack: the Room tab viewer holds none while the Zumi tab shows the 3D room', viewerOpen === 0, { viewerOpen });
    // a TYPED turn: the LLM leg is stubbed at zumi.talk.turn (no key, no paid call); composer, director, Kokoro, speech, producer, hub, bridge and guest are real
    const en = await L.main.evaluate(`(() => { const T = window.__zumiStageTest; T.talk.status.enabled = true; window.zumi.talk.turn = async () => ({ ok: true, reply: ${JSON.stringify(REPLY)}, analysis: null, explains: false, planned: false, gesture: { intent: 'none', brief: '', energy: 'low', deixis: 'none' }, timing: null }); return T.talk.enabled; })()`);
    // the Zumi tab room stays in its default Tour view: no photo mode, no toolbar (it is opened with ?ui=0, alpha.7 S3)
    await guest.evaluate(`window.__rec = []; (function loop() { const z = window.__room.zumi; if (z) { const e = z.vrm.expressionManager; window.__rec.push([Date.now(), ['aa','ih','ou','ee','oh'].reduce((a, n) => a + (e.getValue(n) || 0), 0)]); if (window.__rec.length > 8000) window.__rec.shift(); } requestAnimationFrame(loop); })(); true`);
    typedAt = await typeIn(L.main, 'Hello Zumi, how are you today?');
    await sleep(3200);
    shotA = await appShot(L.main, guest, 'shot-4-zumi-tab-3d-typed-mid-talk');
    await sleep(6000);
    const rec = await guest.evaluate('window.__rec');
    const open = rec.find(([t, m]) => t >= typedAt && m > 0.2);
    const peak = Math.max(...rec.filter(([t]) => t >= typedAt).map((x) => x[1]));
    const f = await layoutFacts(L.main);
    const stats = await L.main.evaluate('JSON.stringify(window.__zumiStageTest.stage.stats)');
    record('a typed message in the Zumi tab: Zumi answers in the 3D room with her mouth moving (Kokoro), reply caption under the stage', en === true && f.reply === REPLY && f.captionText === REPLY && peak > 0.5 && JSON.parse(stats).refused === 0, { typedToMouthOpenMs: open ? Math.round(open[0] - typedAt) : null, peak: +peak.toFixed(2), reply: f.reply.slice(0, 40), captionMirrored: f.captionText === REPLY, stats: JSON.parse(stats), shot: shotA.composed });
    record('shot of the typed turn is <= 1600 px', shotA.composed.w <= 1600 && shotA.composed.h <= 1600, { shot: shotA.composed });
  } finally { await L.stop(); }

  // restart: the 3D room is still the chosen room, with no click
  L = await launch('zt3d', { settings: ZT_SETTINGS, seedKokoro: true, keep: true });
  try {
    const restored = await L.main.evaluate(`(async () => { for (let i = 0; i < 600 && !document.getElementById('stage3d'); i++) await new Promise((r) => setTimeout(r, 100)); return { stage3d: !!document.getElementById('stage3d'), select: document.getElementById('scene-select').value }; })()`, { timeoutMs: 90000 });
    const g2 = await guestUp(L, 6000);
    const shotB = await appShot(L.main, g2, 'shot-5-zumi-tab-3d-after-restart');
    record('restart: the 3D room is still the chosen room in the Zumi tab list', restored.stage3d && restored.select === '3d' && shotB.facts.select === '3d', { restored, shot: shotB.composed });
  } finally { await L.stop(); }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// alpha.7 fix (GATE-OPUS-ALPHA7 should-fix 1): with the 3D room on in the Zumi tab, the tab's own talk UI stays VISIBLE and off the chat:
// the "Thinking" status during a turn, Retry voice after a turn whose voice failed, and the subtitle of Zumi's own line while Kokoro speaks it.
// "Visible" = shown, not inside the native guest's rect (a native window covers any DOM under it), above the message box, and the topmost
// element at its centre. The talk UI is turned on as with a saved AI key (talk.status reports enabled). Own line: a `speech:say` event is
// emitted to the page, so say.js -> zumi.talk.tts (Kokoro) -> playback + subtitle run for real; only the scheduler's decision is skipped (it
// drops every line while the OS reports no user input for 60 s, and this box gets no input). Stubbed: the LLM leg, and the turn's tts call for
// the failed-voice turn only (no key, no paid call).
const SAY_SETTINGS = { ...ZT_SETTINGS, talkQuietHours: { on: false, start: '22:30', end: '07:30' } };
const talkUiFacts = (main, ids) => main.evaluate(`(() => { const view = document.querySelector('.stage3d-view'); const v = view ? view.getBoundingClientRect() : null;
  const comp = document.querySelector('.composer').getBoundingClientRect(); const msg = document.getElementById('msg'); const mb = msg.getBoundingClientRect();
  const out = { view: v && { x: Math.round(v.x), y: Math.round(v.y), w: Math.round(v.width), h: Math.round(v.height) }, composerTop: Math.round(comp.top), msgReachable: document.elementFromPoint(mb.x + mb.width / 2, mb.y + mb.height / 2) === msg, els: {} };
  for (const id of ${JSON.stringify(ids)}) { const e = document.getElementById(id); if (!e) { out.els[id] = { missing: true }; continue; } const b = e.getBoundingClientRect();
    const shown = !e.hidden && b.width > 0 && b.height > 0 && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden';
    const underGuest = !!v && b.right > v.left && b.left < v.right && b.bottom > v.top && b.top < v.bottom;
    // hit-testing skips pointer-events:none (the talk box and the subtitle are click-through), so the element is made hittable for this one read
    const pe = e.style.pointerEvents; e.style.pointerEvents = 'auto';
    const top = shown ? document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2) : null;
    e.style.pointerEvents = pe;
    out.els[id] = { text: (e.textContent || '').trim().slice(0, 60), rect: [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)], shown, underGuest, aboveChat: b.bottom <= comp.top + 1, topmost: !!top && (top === e || e.contains(top)),
      visible: shown && !underGuest && b.bottom <= comp.top + 1 && !!top && (top === e || e.contains(top)) }; }
  return out; })()`);
async function sZumiTabTalkUi() {
  const L = await launch('ztsay', { settings: SAY_SETTINGS, seedKokoro: true });
  try {
    await L.main.evaluate('window.zumi.talk.voiceWarm()');
    let st = null;
    for (let i = 0; i < 120; i++) { st = await L.main.evaluate('window.zumi.talk.voiceState().then(JSON.stringify)'); if (/"state":"ready"|"state":"error"/.test(st)) break; await sleep(1000); }
    console.log('voice state after warm', st);
    console.log('pick 3d ->', await pick3d(L.main));
    const guest = await guestUp(L, 6000);
    // the Zumi tab room stays in its default Tour view: no photo mode, no toolbar (it is opened with ?ui=0, alpha.7 S3)
    // 1. a typed turn whose LLM leg takes 4 s and whose voice fails: "Thinking" shows during it, Retry voice after it
    await L.main.evaluate(`(async () => { const T = window.__zumiStageTest; const realStatus = window.zumi.talk.status; window.zumi.talk.status = async () => ({ ...(await realStatus()), enabled: true }); await T.talk.refreshStatus(); return true; })()`);
    await L.main.evaluate(`(() => { const T = window.__zumiStageTest; T.talk.status.enabled = true; window.__realTts = window.zumi.talk.tts;
      window.zumi.talk.turn = async () => { await new Promise((r) => setTimeout(r, 4000)); return { ok: true, reply: ${JSON.stringify(REPLY)}, analysis: null, explains: false, planned: false, gesture: { intent: 'none', brief: '', energy: 'low', deixis: 'none' }, timing: null }; };
      window.zumi.talk.tts = async () => ({ ok: false, error: { code: 'probe_failed' } }); return true; })()`);
    await typeIn(L.main, 'Hello Zumi, how are you today?');
    await sleep(1500);
    const thinking = await talkUiFacts(L.main, ['talk-status']);
    const shotT = await appShot(L.main, guest, 'shot-6-zumi-tab-3d-thinking');
    record('3D room on: the talk status ("Thinking") is visible during a turn, off the guest and above the message box', thinking.els['talk-status'].visible && thinking.els['talk-status'].text.length > 0 && thinking.msgReachable, { thinking, shot: shotT.composed });
    await sleep(6000);
    const retry = await talkUiFacts(L.main, ['talk-retry-voice']);
    record('3D room on: Retry voice is visible after a turn whose voice failed, off the guest and above the message box', retry.els['talk-retry-voice'].visible && retry.msgReachable, { retry });
    // 2. Zumi's own line through the real path, spoken by Kokoro: its subtitle is visible while she talks
    await L.main.evaluate('window.zumi.talk.tts = window.__realTts; true');
    await guest.evaluate(`window.__rec = []; (function loop() { const z = window.__room.zumi; if (z) { const e = z.vrm.expressionManager; window.__rec.push([Date.now(), ['aa','ih','ou','ee','oh'].reduce((a, n) => a + (e.getValue(n) || 0), 0)]); if (window.__rec.length > 8000) window.__rec.shift(); } requestAnimationFrame(loop); })(); true`);
    const SAY = 'I am still here with you in the room. Take your time, I will wait right here.';
    const asked = await L.main.evaluate(`window.__TAURI__.event.emit('speech:say', { sayId: 'probe-say-1', kind: 'event', text: ${JSON.stringify(SAY)}, show: ${JSON.stringify(SAY)}, voice: true, lang: 'en', mood: null }).then(() => true)`);
    const up = await L.main.evaluate(`(async () => { for (let i = 0; i < 300; i++) { const e = document.getElementById('say-line'); if (e && !e.hidden && e.textContent) return Date.now(); await new Promise((r) => setTimeout(r, 100)); } return 0; })()`, { timeoutMs: 40000 });
    await sleep(700);
    const say = await talkUiFacts(L.main, ['say-line', 'talk-retry-voice']);
    const shotS = await appShot(L.main, guest, 'shot-7-zumi-tab-3d-own-line-subtitle-mid-talk');
    await sleep(2500);
    const rec = await guest.evaluate('window.__rec');
    const peak = rec.length ? Math.max(...rec.map((x) => x[1])) : 0;
    const stats = JSON.parse(await L.main.evaluate('JSON.stringify(window.__zumiStageTest.stage.stats)'));
    record('3D room on: the subtitle of Zumi\'s own line (Kokoro) is visible mid-talk, off the guest and above the message box; Retry voice still visible; chat reachable',
      asked === true && up > 0 && say.els['say-line'].visible && SAY.startsWith(say.els['say-line'].text) && say.els['say-line'].text.length > 20 && say.els['talk-retry-voice'].visible && say.msgReachable && peak > 0.3 && stats.refused === 0,
      { asked, say, mouthPeak: +peak.toFixed(2), refused: stats.refused, shot: shotS.composed });
    record('talk-UI shots are <= 1600 px', [shotT, shotS].every((s) => s.composed.w <= 1600 && s.composed.h <= 1600), { shots: [shotT.composed, shotS.composed] });
    // S3: the Zumi tab room shows NO controls (no Tour/Photo/Walk bar, no sun presets, no photo exit, no hint) and stays in Tour mid-talk
    const GUEST_UI = `(() => { const shown = (sel) => { const el = document.querySelector(sel); if (!el) return false; const cs = getComputedStyle(el), r = el.getBoundingClientRect(); return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
      return { search: location.search, bar: shown('#bar'), photoBtn: shown('#modes button[data-k="photo"]'), walkBtn: shown('#modes button[data-k="walk"]'), tods: shown('#tods'), exitPhoto: shown('#exit-photo'), photo: document.body.classList.contains('photo'), mode: document.querySelector('#modes button.on')?.dataset.k || null }; })()`;
    const zt = await guest.evaluate(GUEST_UI);
    record('S3: the Zumi tab 3D room shows no dev toolbar (no Tour/Photo/Walk, no sun presets, no photo exit) and is in Tour mid-talk',
      zt.search === '?ui=0' && !zt.bar && !zt.photoBtn && !zt.walkBtn && !zt.tods && !zt.exitPhoto && !zt.photo && zt.mode === 'tour', { zt, shot: shotS.composed });
    // the Room tab viewer keeps them: leave the 3D room through the picker (a video room), then open the Room tab
    await L.main.evaluate(`(() => { const s = document.getElementById('scene-select'); s.value = 'current'; s.dispatchEvent(new Event('change')); return s.value; })()`);
    await sleep(2000);
    console.log('room tab', await clickRoomTab(L.main));
    const rg = await guestUp(L, 3000);
    const rt = await rg.evaluate(GUEST_UI);
    const shotR = await shoot(rg, path.join(out, 'shot-8-room-tab-keeps-toolbar.png'));
    record('S3: the Room tab viewer keeps the room toolbar (Tour/Photo/Walk + sun presets)', rt.search === '' && rt.bar && rt.photoBtn && rt.walkBtn && rt.tods, { rt, shot: shotR });
  } finally { await L.stop(); }
}

async function sReasonBar() {
  const L = await launch('rbar', { settings: ZT_SETTINGS });
  try {
    await L.main.evaluate('window.__fb = []; window.zumi.stage.onFallback((p) => window.__fb.push(p)); true');
    await pick3d(L.main);
    let guest = await guestUp(L, 9000);
    const file = path.join(L.data, 'stage-bench.json');
    const mem = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {});
    const memBefore = mem();
    // a real crash of the guest renderer: F1 closes the guest (guest_gone is NOT saved: a runtime fallback, ADR A11), and the reason line appears in
    // the column above the message box
    try { await Promise.race([guest.send('Page.crash'), sleep(5000)]); } catch { /* dies with the page */ }
    let fb = [];
    for (let i = 0; i < 60 && !fb.length; i++) { await sleep(1000); fb = await L.main.evaluate('window.__fb'); }
    await sleep(1500);
    const f = await layoutFacts(L.main);
    const bar = f.bar, comp = f.composer;
    const noCover = bar && comp && bar.bottom <= comp.y + 1 && f.msgReachable;
    const mShot = await shoot(L.main, path.join(out, 'shot-6-reason-line-above-the-message-box.png'));
    const memAfter = mem();
    record('F1 reason line: sits above the message box (never covers it), has dismiss / Try anyway / Test again, and guest_gone is not saved', fb.length === 1 && fb[0].reason === 'guest_gone' && noCover && f.barReason === 'guest_gone' && !runtimeSaved(memAfter), { fb, bar, composer: comp, msgReachable: f.msgReachable, memAfter, shot: { w: mShot.w, h: mShot.h } });
    const hasButtons = await L.main.evaluate("['stage-retry', 'stage-again', 'stage-dismiss'].map((c) => !!document.querySelector('.stage-reason .' + c))");
    record('the three buttons exist', hasButtons.every(Boolean), { hasButtons });

    // Try 3D anyway (this session's fallback is not applied for one attempt)
    await L.main.evaluate("document.querySelector('.stage-reason .stage-retry').click(); true");
    guest = await guestUp(L, 6000);
    const afterTry = await appShot(L.main, guest, 'shot-7-after-try-anyway');
    record('Try 3D anyway in the Zumi tab: the guest opens although this session fell back, line gone, 3D room shown', afterTry.facts.stage3d && !afterTry.facts.bar && afterTry.facts.select === '3d', { facts: afterTry.facts, shot: afterTry.composed });

    // crash again (nothing saved for it), then Test again: the saved bench verdict is forgotten, the guest opens, the bench runs and passes
    await L.main.evaluate('window.__fb = []; true');
    try { await Promise.race([guest.send('Page.crash'), sleep(5000)]); } catch { /* dies with the page */ }
    fb = [];
    for (let i = 0; i < 60 && !fb.length; i++) { await sleep(1000); fb = await L.main.evaluate('window.__fb'); }
    await sleep(1500);
    const memCrashed = mem();
    await L.main.evaluate("document.querySelector('.stage-reason .stage-again').click(); true");
    await sleep(500);
    const memCleared = mem();
    guest = await guestUp(L, 12000);
    const memPass = mem();
    const afterAgain = await appShot(L.main, guest, 'shot-8-after-test-again');
    record('Test again: the crash saved nothing, the saved bench verdict is forgotten, the bench runs again and its pass is saved', fb.length === 1 && !runtimeSaved(memCrashed) && !Object.values(memCleared).includes(true) && Object.values(memPass).includes(true) && afterAgain.facts.stage3d, { memCrashed, memCleared, memPass, shot: afterAgain.composed });
    void memBefore;
  } finally { await L.stop(); }
}

async function sCleanClose() {
  const L = await launch('cclose', { settings: ZT_SETTINGS });
  try {
    await pick3d(L.main);
    let guest = await guestUp(L, 10000);
    const file = path.join(L.data, 'stage-bench.json');
    const memA = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    // the user picks a video room: the guest is closed on purpose
    await L.main.evaluate("(() => { const s = document.getElementById('scene-select'); s.value = 'current'; s.dispatchEvent(new Event('change')); return s.value; })()");
    await sleep(45000);
    const log1 = L.log();
    const gone = !(await guestAlive(L.data));
    const memB = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    record('a room closed on purpose (another room picked) is not read as dead: no fallback after 45 s, memory unchanged', gone && !/fallback /.test(log1) && memA === memB && !/guest_gone|no_poll|no_ready/.test(memB), { gone, fallbackLines: log1.split('\n').filter((l) => /fallback /.test(l)), memA, memB });
    // pick 3D again, then F5 inside the guest: a new document, not a dead guest
    await pick3d(L.main);
    guest = await guestUp(L, 8000);
    try { await Promise.race([guest.send('Page.reload'), sleep(3000)]); } catch { /* reloads */ }
    await sleep(2000);
    const g2 = await guestUp(L, 2000);
    await sleep(45000);
    const log2 = L.log();
    const alive = await guestAlive(L.data);
    const closed = await g2.evaluate('window.__room.stage.closed');
    const memC = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    record('a reloaded room (F5) is a new document, not a dead guest: still polling after 45 s, no fallback, nothing remembered', alive && closed === null && !/fallback /.test(log2) && !/guest_gone|no_poll|no_ready/.test(memC), { alive, closed, reloadLines: log2.split('\n').filter((l) => /stage_reload|fallback /.test(l)), memC });
  } finally { await L.stop(); }
}

// ---------------------------------------------------------------------------------------------------------------------------------
async function fallbackFacts(L, code) {
  // the four facts of ADR D8: video room visible + reason line carries the code, main Zumi renderer running, guest gone, not reopened
  await sleep(2500);
  const line = await L.main.evaluate(`(() => { const e = document.querySelector('.stage-reason'); return e ? { reason: e.dataset.reason, text: e.textContent } : null; })()`);
  const zumiTab = await L.main.evaluate(`(() => { const p = document.getElementById('tab-zumi'); const b = document.querySelector('[data-tab="zumi"]'); return { panelVisible: !!p && !p.hidden && getComputedStyle(p).display !== 'none', active: !!b && b.classList.contains('active') }; })()`);
  const adv = await rendererAdvances(L.main);
  const alive = await guestAlive(L.data);
  const reopen = await L.main.evaluate(`window.__TAURI_INTERNALS__.invoke('guest_open', { src: 'http://zumipack.localhost/${ID}/ui/index.html', partition: 'pack:${ID}' }).then((r) => ({ resolved: true, r }), (e) => ({ rejected: String(e) }))`);
  return { code, line, zumiTab, rendererAdvances: adv, guestStillAlive: alive, reopen };
}
const factsOk = (f, code) => f.line && f.line.reason === code && /video room/.test(f.line.text) && f.zumiTab.active && f.rendererAdvances.advancing && !f.guestStillAlive && f.reopen.rejected && /stage_fallback/.test(f.reopen.rejected);

async function sA1() {
  const L = await launch('a1', { browserArgs: SOFT_ARGS, settings: { room: { live3d: 'auto' } } });
  try {
    await L.main.evaluate('window.__fb = []; window.zumi.stage.onFallback((p) => window.__fb.push(p)); true');
    console.log('tab click', await clickRoomTab(L.main));
    let fb = [];
    for (let i = 0; i < 120 && !fb.length; i++) { await sleep(1000); fb = await L.main.evaluate('window.__fb'); }
    console.log('fallback events', JSON.stringify(fb));
    const f = await fallbackFacts(L, fb[0] ? fb[0].reason : 'none');
    const benchFile = path.join(L.data, 'stage-bench.json');
    const bench = fs.existsSync(benchFile) ? JSON.parse(fs.readFileSync(benchFile, 'utf8')) : null;
    record('A1 weak machine (software renderer): first open falls back', fb.length === 1 && factsOk(f, fb[0].reason), { fb, f, bench });
    if (fb[0] && fb[0].reason === 'bench') record('A1 the bench failure is saved per (adapter, driver, app version)', Boolean(bench) && Object.values(bench).includes(false), { reason: 'bench', bench });
    else record('A1 note: the software renderer cannot boot the room inside the host 20 s limit, so the fallback is no_ready, not bench, and it is not saved (the next start tries 3D again)', Boolean(fb[0]) && fb[0].reason === 'no_ready' && !runtimeSaved(bench), { reason: fb[0] && fb[0].reason, bench }); // alpha.9.4, ADR A11: only a bench verdict is saved
  } finally { await L.stop(); }
}

async function sA3() {
  const L = await launch('a3', { settings: { room: { live3d: 'auto' } } });
  try {
    await L.main.evaluate('window.__fb = []; window.zumi.stage.onFallback((p) => window.__fb.push(p)); true');
    console.log('tab click', await clickRoomTab(L.main));
    const { guest } = await guestReady(L.data);
    await sleep(3000);
    const up = await L.main.evaluate("window.zumi.stage.produce('status', {})");
    // the guest's renderer process crashes (a real crash, not a flag)
    try { await Promise.race([guest.send('Page.crash'), sleep(5000)]); } catch { /* the socket dies with the page */ }
    let fb = [];
    for (let i = 0; i < 60 && !fb.length; i++) { await sleep(1000); fb = await L.main.evaluate('window.__fb'); }
    const f = await fallbackFacts(L, fb[0] ? fb[0].reason : 'none');
    record('A3 engine failure (guest renderer crash) -> guest_gone, video room', up.active === true && fb.length === 1 && fb[0].reason === 'guest_gone' && factsOk(f, 'guest_gone'), { up, fb, f });
  } finally { await L.stop(); }
}

async function sVideoRooms() {
  const shotsOf = async (exe, tag) => {
    const L = await launch(`rooms-${tag}`, { exe, settings: { uiLang: 'en', soul: { template: 'friendly' } } });
    const files = [];
    try {
      await L.main.evaluate('(async () => { for (let i = 0; i < 300 && !(window.zumi && window.zumi.scenes); i++) await new Promise((r) => setTimeout(r, 100)); return true; })()');
      await sleep(4000);
      const list = await L.main.evaluate('window.zumi.scenes.list()');
      console.log('scenes.list', JSON.stringify(list).slice(0, 600));
      const ids = (list.scenes || list.rooms || []).map((s) => s.id).filter(Boolean).slice(0, 3);
      for (const id of ids) {
        await L.main.evaluate(`(() => { const s = document.getElementById('scene-select'); s.value = ${JSON.stringify(id)}; s.dispatchEvent(new Event('change')); return s.value; })()`);
        await sleep(5000);
        files.push(await shoot(L.main, path.join(out, `rooms-${tag}-${id}.png`)));
      }
      return { ids, files };
    } finally { await L.stop(); }
  };
  const mine = await shotsOf(app, 'new');
  const base = baseApp ? await shotsOf(baseApp, 'base') : null;
  record('video rooms: shots taken (new and base)', mine.files.length > 0 && (!base || base.files.length === mine.files.length), { ids: mine.ids, mine: mine.files.map((f) => `${f.w}x${f.h}`), base: base && base.files.map((f) => `${f.w}x${f.h}`) });
  if (base) {
    // The same room in both builds: pixels that differ by more than 24 on any channel. The plate is a playing video and idle life is random per
    // run, so this is not zero (2-3% in a quiet run; 12% when Zumi's own start-up greeting subtitle and wave happen in one build and not the other); the point is that nothing moved (same framing, same chrome).
    const { readPng } = createRequire(import.meta.url)('./lib/png-read.cjs');
    const diffs = mine.files.map((f, i) => {
      const a = readPng(f.file), b = readPng(base.files[i].file);
      let n = 0;
      for (let k = 0; k < a.buf.length; k += 4) if (Math.abs(a.buf[k] - b.buf[k]) > 24 || Math.abs(a.buf[k + 1] - b.buf[k + 1]) > 24 || Math.abs(a.buf[k + 2] - b.buf[k + 2]) > 24) n++;
      return { room: mine.ids[i], differingPct: +(100 * n / (a.width * a.height)).toFixed(2), sameSize: a.width === b.width && a.height === b.height };
    });
    const rooms = new Set(mine.files.map((f) => fs.readFileSync(f.file).length));
    record('video rooms unchanged vs the pre-merge build (same rooms, same framing)', diffs.every((d) => d.sameSize && d.differingPct < 15) && rooms.size > 1, { diffs, distinctRoomShots: rooms.size });
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// alpha.9 seated: Zumi sits at the desk in the 3D room, on the real app with the pack built from this tree (--pack-dir). Zumi tab (the
// webcam view): she types facing the viewer; a line spoken through the host's real SpeechOut + producer: she looks into the camera, mouth
// open; a barge-in closes the mouth and her hands go back to the keys. Room tab: the wide view at the tour's opening, the tour frames (contact sheet), Photo shot 1 and a
// close-up of her typing.
const SEATED_FACE = `(() => { const R = window.__room, z = R.zumi, cam = R.three.camera, V = cam.position.constructor; const w = (n) => { const b = z.vrm.humanoid.getNormalizedBoneNode(n); return b ? b.getWorldPosition(new V()) : null; };
  const h = w('head'), le = w('leftEye'), re = w('rightEye'), e = z.vrm.expressionManager, mouth = ['aa', 'ih', 'ou', 'ee', 'oh'].reduce((a, n) => a + (e.getValue(n) || 0), 0);
  let face = null; if (le && re) { const f = le.add(re).multiplyScalar(0.5).sub(h); f.y = 0; const c = cam.position.clone().sub(h); c.y = 0; face = +(f.angleTo(c) * 180 / Math.PI).toFixed(1); }
  const seat = R.three.scene.getObjectByName('desk_seat'), kb = seat ? new V().fromArray(seat.userData.keyboard) : null;
  const hands = kb ? +Math.max(w('leftHand').distanceTo(kb), w('rightHand').distanceTo(kb)).toFixed(3) : null;
  return { seated: z.seated, anchor: Boolean(seat), face, mouth: +mouth.toFixed(2), handsToKeys: hands }; })()`;
async function sSeated() {
  if (!packDir) throw new Error('the seated scenario needs --pack-dir <the pack built from this tree>');
  const L = await launch('seated', { settings: ZT_SETTINGS, extraArgs: ['--pack-dir', packDir] });
  try {
    const t = (await L.main.evaluate("window.__TAURI_INTERNALS__.invoke('pack_list')")).find((x) => x.id === ID);
    record('seated: the pack under test is the --pack-dir one', Boolean(t) && t.dev === true, { tab: t && { id: t.id, version: t.version, dev: t.dev } });
    console.log('pick 3d ->', await pick3d(L.main));
    const zg = await guestUp(L, 6000);
    const typing = await zg.evaluate(SEATED_FACE);
    const sTyping = await appShot(L.main, zg, 'seated-1-zumi-tab-typing');
    record('seated: in the Zumi tab (the webcam on her monitor) she sits at the desk (desk_seat anchor), facing the viewer, hands at the keys', typing.seated && typing.anchor && typing.face <= 40 && typing.handsToKeys <= 0.15, { typing, shot: sTyping.composed });
    await zg.evaluate(`window.__rec = []; (function loop() { const z = window.__room.zumi; if (z) { const e = z.vrm.expressionManager; window.__rec.push([Date.now(), ['aa','ih','ou','ee','oh'].reduce((a, n) => a + (e.getValue(n) || 0), 0)]); if (window.__rec.length > 8000) window.__rec.shift(); } requestAnimationFrame(loop); })(); true`);
    const r = await L.main.evaluate(speakJs(100, 4200, 4500), { timeoutMs: 30000 });
    await sleep(2400);
    const talk = await zg.evaluate(SEATED_FACE);
    const sTalk = await appShot(L.main, zg, 'seated-2-zumi-tab-mid-talk');
    const at = await L.main.evaluate('(() => { const T = window.__zumiStageTest; const at = Date.now(); T.speech.stop(); T.stage.cancel(); return at; })()');
    await sleep(900);
    const rec = await zg.evaluate('window.__rec');
    const closed = rec.find(([x, m]) => x >= at && m < 0.02);
    const sAfter = await appShot(L.main, zg, 'seated-3-zumi-tab-after-barge-in');
    record('seated: mid-talk she turns to the viewer (face within 40 deg) with the mouth open; a barge-in closes it within one poll cycle',
      talk.face !== null && talk.face <= 40 && talk.mouth > 0.3 && Boolean(closed) && closed[0] - at <= 125 + 80 && r.refused === 0, { talk, closedAfterMs: closed ? closed[0] - at : null, refused: r.refused, shots: [sTalk.composed, sAfter.composed] });
    await sleep(5000);
    const back = await zg.evaluate(SEATED_FACE);
    record('seated: after the talk her hands are back at the keys', back.handsToKeys <= 0.15, { back });
    await L.main.evaluate(`(() => { const s = document.getElementById('scene-select'); s.value = 'current'; s.dispatchEvent(new Event('change')); return s.value; })()`);
    await sleep(2000);
    console.log('room tab', await clickRoomTab(L.main));
    const rg = await guestUp(L, 4000);
    await rg.evaluate('window.__room.freezeTour(true); window.__room.setTourClock(0); true'); await sleep(800);
    const wide = await shoot(rg, path.join(out, 'seated-4-room-tab-wide-typing.png'));
    const frames = [];
    for (const k of [0, 6, 12, 18, 24, 30, 36, 42]) { await rg.evaluate(`window.__room.setTourClock(${k}); true`); await sleep(700); frames.push(await shoot(rg, path.join(out, `seated-tour-${String(k).padStart(2, '0')}.png`))); }
    await rg.evaluate("window.__room.freezeTour(false); window.__room.setMode('photo'); window.__room.setShot(1); true"); await sleep(1200);
    const photo = await shoot(rg, path.join(out, 'seated-5-room-tab-photo-zumi-at-work.png'));
    await rg.evaluate("window.__room.exitPhoto(); window.__room.setCamera([0.2, 1.25, -1.6], [0.8, 1.0, -1.15], 44); true"); await sleep(1500);
    const close = await shoot(rg, path.join(out, 'seated-6-close-up-typing.png'));
    record('seated: Room tab shots (wide, 8 tour frames, Photo shot 1, close-up) are <= 1600 px', [wide, photo, close, ...frames].every((s) => s.w <= 1600 && s.h <= 1600), { wide, photo, close, frames: frames.length });
  } finally { await L.stop(); }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// T31lag: alpha.9 (the seated room) measured ~30 ms more lip-sync lag than alpha.7.1 on the owner PC (mouth open 80 vs 49 ms, 2 of 9 runs
// over the 120 ms bar). The talk path of `live`, 9 utterances, with the guest's frame times per utterance.
const LAG_BAR_MS = 120;
const LAG_MEDIAN_MS = 50; // spare box: alpha.7.1 room 40-45, alpha.9 head 65-76, fixed 28-38 (LAG-RESULT.md); 65 let a mutation run pass
// T31reload: a reload in place during the boot. `docMark` tells the first document from the new one (only the first carries it).
async function sGuestReload() {
  const L = await launch('greload', { settings: { room: { live3d: 'auto' } }, extraArgs: packDir ? ['--pack-dir', packDir] : [] });
  try {
    await L.main.evaluate('window.__fb = []; window.zumi.stage.onFallback((p) => window.__fb.push(p)); true');
    console.log('tab click', await clickRoomTab(L.main));
    const first = await guestTarget(L.data);
    const mark = await first.evaluate('window.__docMark = 1; ({ href: location.href, room: Boolean(window.__room), ready: document.readyState })');
    // the first document's own view of its boot, read on a connection the harness does not reuse
    const firstBoot = first.evaluate(`(async () => { for (let i = 0; i < 100 && !window.__room; i++) await new Promise((r) => setTimeout(r, 50));
      try { await window.__room.ready; return { mark: window.__docMark === 1, ok: true }; } catch (e) { return { mark: window.__docMark === 1, ok: false, err: String(e) }; } })()`, { timeoutMs: 60000 }).then((v) => ({ value: v }), (e) => ({ threw: String(e.message).split('\n')[0] }));
    // guestReady starts BEFORE the reload, so its evaluate is waiting in the first document when the reload aborts that document's boot
    // (the race the lag probe hit; without this it lands on either document by chance: 2 of 5 unfixed launches)
    const grStarted = guestReady(L.data).then((r) => ({ r }), (e) => ({ e }));
    await sleep(400);
    console.log('reload in place during the boot', JSON.stringify(mark));
    first.send('Page.reload', {}).catch(() => {});
    let gr = null;
    const settledGr = await grStarted;
    try { if (settledGr.e) throw settledGr.e; const { guest, boot } = settledGr.r; gr = { guest, boot, mark: await guest.evaluate('window.__docMark === 1') }; } catch (e) {
      // whose boot failed: the document guestReady read is gone (the first one) or still there (look for the first document's mark)
      const failedDoc = e.guest ? await e.guest.evaluate('({ mark: window.__docMark === 1, href: location.href })').catch((x) => ({ gone: String(x.message).split('\n')[0] })) : null;
      gr = { error: String(e.message), boot: e.boot || null, failedDoc };
    }
    const firstSaid = await Promise.race([firstBoot, sleep(5000).then(() => ({ pending: true }))]);
    console.log('first document boot', JSON.stringify(firstSaid), 'guestReady', JSON.stringify({ error: gr.error, boot: gr.boot, mark: gr.mark, failedDoc: gr.failedDoc }));
    // the product side, independent of guestReady: after the reload, the CURRENT document boots and polls the stage
    await sleep(3000);
    const now = await guestTarget(L.data);
    const doc = await now.evaluate(`(async () => { for (let i = 0; i < 600 && !window.__room; i++) await new Promise((r) => setTimeout(r, 100));
      let boot; try { const r = await window.__room.ready; boot = { ok: true, firstFrameMs: r.marks.firstFrameMs }; } catch (e) { boot = { ok: false, err: String(e) }; }
      for (let i = 0; i < 300 && !(window.__room.stage && window.__room.stage.client && window.__room.stage.client.state.polls > 0) && !(window.__room.stage && window.__room.stage.closed); i++) await new Promise((r) => setTimeout(r, 100));
      const s = window.__room.stage; return { mark: window.__docMark === 1, boot, polls: s && s.client ? s.client.state.polls : 0, closed: s ? s.closed : 'no stage' }; })()`, { timeoutMs: 120000 });
    await sleep(2000);
    const fb = await L.main.evaluate('window.__fb');
    const lines = L.log().split('\n').filter((l) => /stage_|refused|fallback /.test(l));
    record('greload: after a reload in place during the boot, the new document boots and polls the stage, no fallback', doc.mark === false && doc.boot.ok && doc.polls > 0 && doc.closed === null && fb.length === 0, { doc, fb, lines: lines.slice(-12) });
    record('greload: guestReady returns the reloaded guest booted (not the first document\'s aborted boot)', Boolean(gr.guest) && gr.boot.ok && gr.mark === false, { error: gr.error, boot: gr.boot, mark: gr.mark, failedDoc: gr.failedDoc, firstSaid });
  } finally { await L.stop(); }
}

// --lag-runs N: a soak (T31sfdrift, CoS 55fe5e7c: about 350 runs = 30 min in one launch); each run also samples the guest's
// performance.timeOrigin + performance.now() - Date.now() (the monotonic timeline's drift from the wall clock).
const LAG_RUNS = Number(opt('lag-runs')) || 9;
async function sLag() {
  const L = await launch('lag', { settings: { room: { live3d: 'auto' } }, extraArgs: packDir ? ['--pack-dir', packDir] : [] });
  try {
    console.log('tab click', await clickRoomTab(L.main));
    const guest = await guestUp(L, 9000);
    await guest.evaluate("window.__room.setMode('photo'); window.__room.setShot(1); true");
    if (guestPatch) console.log('guest patch', JSON.stringify(await guest.evaluate(fs.readFileSync(guestPatch, 'utf8'))));
    await sleep(1500);
    await guest.evaluate(`window.__rec = []; (function loop() { const z = window.__room.zumi; if (z) { const e = z.vrm.expressionManager; window.__rec.push([Date.now(), ['aa','ih','ou','ee','oh'].reduce((a, n) => a + (e.getValue(n) || 0), 0)]); if (window.__rec.length > 4000) window.__rec.shift(); } requestAnimationFrame(loop); })(); true`);
    const runs = [];
    for (let i = 0; i < LAG_RUNS; i++) {
      await guest.evaluate('window.__rec.length = 0; window.__room.resetStats(); true');
      const r = await L.main.evaluate(speakJs(300, 1200, 1800), { timeoutMs: 30000 });
      await sleep(2800);
      const rec = await guest.evaluate('window.__rec');
      const st = await guest.evaluate('window.__room.stats()');
      const diag = await guest.evaluate('window.__lagDiag ? window.__lagDiag() : null'); // a --guest-patch may define it
      const driftMs = await guest.evaluate('Math.round((performance.timeOrigin + performance.now() - Date.now()) * 10) / 10');
      const onset = r.audioStartEpoch + 300; // the tone starts 300 ms into the audio
      const k = rec.findIndex(([t, m]) => t >= r.audioStartEpoch - 100 && m > 0.2);
      runs.push({ run: i + 1, openMs: k >= 0 ? Math.round(rec[k][0] - onset) : null, frameBeforeOpenMs: k > 0 ? rec[k][0] - rec[k - 1][0] : null, msAvg: st && st.msAvg, msP95: st && st.msP95, msMax: st && st.msMax, refused: r.refused, driftMs, ...(diag ? { diag, audioStartEpoch: r.audioStartEpoch } : {}) });
      console.log('lag run', JSON.stringify(runs[runs.length - 1])); // a soak keeps its data if it is cut short
      await sleep(600);
    }
    const open = runs.map((x) => x.openMs).filter((x) => x !== null).sort((a, b) => a - b);
    const median = open.length ? open[Math.floor(open.length / 2)] : null;
    console.log('lag runs', JSON.stringify(runs));
    record(`lip-sync lag: ${LAG_RUNS}/${LAG_RUNS} utterances open the mouth <= ${LAG_BAR_MS} ms after the tone onset, median <= ${LAG_MEDIAN_MS} ms`,
      open.length === LAG_RUNS && open.every((x) => Math.abs(x) <= LAG_BAR_MS) && median <= LAG_MEDIAN_MS && runs.every((x) => x.refused === 0),
      { median, max: open[open.length - 1], over: open.filter((x) => x > LAG_BAR_MS).length, runs, patch: guestPatch || null });
  } finally { await L.stop(); }
}

async function sWebcamSet() {
  if (!packDir) throw new Error('the webcamset scenario needs --pack-dir <the pack built from this tree>');
  const L = await launch('webcamset', { settings: ZT_SETTINGS, extraArgs: ['--pack-dir', packDir] });
  try {
    console.log('pick 3d ->', await pick3d(L.main));
    const zg = await guestUp(L, 6000);
    const boot = await zg.evaluate(`(() => { const R = window.__room, set = R.three.scene.getObjectByName('webcam-set'); return { search: location.search, tod: R.stats().tod, want: R.todAt ? R.todAt(new Date().getHours() * 60 + new Date().getMinutes()).name : null, hour: new Date().getHours(), set: Boolean(set), cameraLayers: R.three.camera.layers.mask, seated: R.zumi.seated, size: [innerWidth, innerHeight] }; })()`);
    record('webcamset: the Zumi tab guest (?ui=0) opens on the local clock time of day, seated, with the talk set on the webcam camera', boot.search === '?ui=0' && boot.tod === boot.want && boot.set && (boot.cameraLayers & 4) === 4 && boot.seated, { boot });
    const rect = (sel, g = zg) => g.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const b = e.getBoundingClientRect(); return b.width < 1 ? null : { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
    const click = async (at, g = zg) => { for (const [type, buttons] of [['mouseMoved', 0], ['mousePressed', 1], ['mouseReleased', 0]]) await g.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: type === 'mouseMoved' ? 'none' : 'left', buttons, clickCount: type === 'mouseMoved' ? 0 : 1 }); await sleep(300); };
    const chipState = "({ tod: window.__room.stats().tod, stored: localStorage.getItem('zumi-room-tod'), clock: window.__room.todAt(new Date().getHours() * 60 + new Date().getMinutes()).name, on: [...document.querySelectorAll('#todchip .menu button.on')].map((b) => b.dataset.k).join(',') })";
    // a still is taken with her eyes open (a blink lasts ~0.15 s)
    const eyesOpen = () => zg.evaluate("(async () => { const e = window.__room.zumi.vrm.expressionManager; for (let i = 0; i < 60 && (e.getValue('blink') || 0) > 0.05; i++) await new Promise((r) => setTimeout(r, 50)); return true; })()");
    const set = {}, shots = [];
    for (const tod of ['day', 'night']) {
      const toggle = await rect('#todchip > button'); if (!toggle) throw new Error('no day/night chip in the guest');
      await click(toggle); const entry = await rect(`#todchip [data-k="${tod}"]`); if (!entry) throw new Error(`no chip entry for ${tod}`);
      await click(entry); await sleep(4200);
      set[tod] = await zg.evaluate('window.__room.stats().tod');
      await zg.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5, button: 'none', buttons: 0 }); await sleep(600);
      await eyesOpen(); shots.push((await appShot(L.main, zg, `webcamset-${tod}`)).composed);
    }
    record('webcamset: a click on the chip entries Day and Night sets that time of day in the real guest; a still of each', set.day === 'day' && set.night === 'night' && shots.length === 2 && shots.every((s) => s.w <= 1600), { set, shots });
    // a pick that is not the clock's own, then the app closed and started again on the same data folder
    const clock = boot.want, pick = clock === 'day' ? 'night' : 'day';
    await click(await rect('#todchip > button')); await click(await rect(`#todchip [data-k="${pick}"]`)); await sleep(1500);
    const stored = await zg.evaluate("localStorage.getItem('zumi-room-tod')");
    await L.stop(); await sleep(2000);
    const L2 = await launch('webcamset', { settings: ZT_SETTINGS, extraArgs: ['--pack-dir', packDir], keep: true });
    try {
      console.log('pick 3d (second start) ->', await pick3d(L2.main));
      const zg2 = await guestUp(L2, 4000);
      const again = await zg2.evaluate("({ tod: window.__room.stats().tod, stored: localStorage.getItem('zumi-room-tod'), clock: window.__room.todAt(new Date().getHours() * 60 + new Date().getMinutes()).name })");
      record('webcamset: the stored pick wins on the next boot (the app closed and started again on the same data folder)', stored === pick && again.tod === pick && again.stored === pick && again.clock !== pick, { pick, stored, again });
      // Auto on the chip, then a third start on the same data folder: the clock decides again
      await click(await rect('#todchip > button', zg2), zg2); const autoEntry = await rect('#todchip [data-k="auto"]', zg2);
      if (!autoEntry) { record('webcamset: the chip has an entry Auto', false, { entries: await zg2.evaluate("[...document.querySelectorAll('#todchip .menu button')].map((b) => b.dataset.k)") }); return; }
      await click(autoEntry, zg2); await sleep(1500);
      const autoNow = await zg2.evaluate(chipState);
      await L2.stop(); await sleep(2000);
      const L3 = await launch('webcamset', { settings: ZT_SETTINGS, extraArgs: ['--pack-dir', packDir], keep: true });
      try {
        console.log('pick 3d (third start) ->', await pick3d(L3.main));
        const zg3 = await guestUp(L3, 4000);
        const third = await zg3.evaluate(chipState);
        record('webcamset: Auto picked on the chip clears the stored pick and follows the clock, at once and on the next boot (the app closed and started a third time)', autoNow.tod === autoNow.clock && autoNow.stored === null && autoNow.on === 'auto' && third.tod === third.clock && third.stored === null && third.on === 'auto' && third.clock !== pick, { pick, autoNow, third });
      } finally { await L3.stop(); }
    } finally { await L2.stop(); }
  } finally { await L.stop(); }
}

// Her face skin as the guest shows it (the disc under her eyes of check-spawn rows FL / RF, on the frame's own pixels around its centre point).
const FACE_Y = `(() => { const R = window.__room, { camera, renderer, composer } = R.three, z = R.zumi, V = camera.position.constructor; const gl = renderer.getContext(), W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
  const w = (n) => z.vrm.humanoid.getNormalizedBoneNode(n).getWorldPosition(new V()); camera.updateMatrixWorld(true);
  const c = w('leftEye').add(w('rightEye')).multiplyScalar(0.5); c.y -= 0.035; const q = c.clone().project(camera), cx = (q.x + 1) / 2 * W, cy = (q.y + 1) / 2 * H, rad = 0.02 * (H / 2) / Math.tan(camera.fov * Math.PI / 360) / c.distanceTo(camera.position);
  composer.render(0); const px = new Uint8Array(W * H * 4); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px); const ys = [];
  for (let y = Math.max(0, Math.floor(cy - rad)); y <= Math.min(H - 1, cy + rad); y++) for (let x = Math.max(0, Math.floor(cx - rad)); x <= Math.min(W - 1, cx + rad); x++) if (Math.hypot(x - cx, y - cy) <= rad) { const i = 4 * (y * W + x); ys.push(0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]); }
  ys.sort((a, b) => a - b); return { tod: R.stats().tod, pixels: ys.length, median: Math.round(ys[ys.length >> 1]), clipped: +(ys.filter((v) => v >= 250).length / ys.length).toFixed(3) }; })()`;
async function sRoomNight() {
  if (!packDir) throw new Error('the roomnight scenario needs --pack-dir <the pack built from this tree>');
  const L = await launch('roomnight', { settings: ZT_SETTINGS, extraArgs: ['--pack-dir', packDir] });
  try {
    console.log('room tab', await clickRoomTab(L.main));
    const rg = await guestUp(L, 5000);
    const btn = await rg.evaluate(`(() => { const e = document.querySelector('#tods button[data-k="night"]'); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
    if (!btn) throw new Error('no Night button in the Room tab');
    for (const [type, buttons] of [['mouseMoved', 0], ['mousePressed', 1], ['mouseReleased', 0]]) await rg.send('Input.dispatchMouseEvent', { type, x: btn.x, y: btn.y, button: type === 'mouseMoved' ? 'none' : 'left', buttons, clickCount: type === 'mouseMoved' ? 0 : 1 });
    await sleep(4500);
    await rg.evaluate('window.__room.freezeTour(true); window.__room.setTourClock(0); true'); await sleep(900);
    const wide = await shoot(rg, path.join(out, 'roomnight-1-room-tab-wide.png'));
    await rg.evaluate("window.__room.freezeTour(false); window.__room.setMode('photo'); window.__room.setShot(1); true"); await sleep(1300);
    const photo = await shoot(rg, path.join(out, 'roomnight-2-photo-zumi-at-work.png'));
    await rg.evaluate("window.__room.exitPhoto(); window.__room.setCamera([0.2, 1.25, -1.6], [0.8, 1.0, -1.15], 44); true"); await sleep(1600);
    const face = await rg.evaluate(FACE_Y);
    const close = await shoot(rg, path.join(out, 'roomnight-3-close-up.png'));
    record('roomnight: in the Room tab by night (its own Night button) her face at the desk is clear: face skin median Y 105-242, at most 10% blown out', face.tod === 'night' && face.median >= 105 && face.median <= 242 && face.clipped <= 0.1, { face, shots: [wide, photo, close] });
  } finally { await L.stop(); }
}

try {
  for (const s of scenarios) {
    console.log(`\n=== ${s} ===`);
    try {
      const run = { live: sLive, a1: sA1, a1b: sA1b, a3: sA3, videorooms: sVideoRooms, leadprobe: sLeadProbe, kokoro: sKokoro, zt3d: sZumiTab3d, ztsay: sZumiTabTalkUi, rbar: sReasonBar, cclose: sCleanClose, seated: sSeated, lag: sLag, greload: sGuestReload, webcamset: sWebcamSet, roomnight: sRoomNight }[s]();
      const hungMs = s === 'lag' ? Math.max(420000, LAG_RUNS * 8000 + 120000) : 420000; // a --lag-runs soak runs about 5 s per utterance
      await Promise.race([run, sleep(hungMs).then(() => { throw new Error(`scenario ${s} hung for ${Math.round(hungMs / 60000)} minutes`); })]);
    } catch (e) { record(`${s} harness`, false, { error: String((e && e.stack) || e).slice(0, 700) }); }
  }
} finally {
  fs.writeFileSync(path.join(out, 'real-run.json'), JSON.stringify({ when: new Date().toISOString(), results }, null, 1));
}
const failed = Object.entries(results).filter(([, r]) => r.pass !== true).map(([k]) => k);
console.log(failed.length ? `FAILED: ${failed.join(' | ')}` : 'ALL OK');
process.exit(failed.length ? 1 : 0);
