// Electron harness for the talk-camera HUD (T-31 hud-react, 13-10). Runs the REAL app (src/main/main.js from a source
// tree or a packed app.asar) in its own userData, in a window shown off the desktop (never over the owner's screen,
// never focused, no taskbar button), against a FIXTURE board (scripts/fixtures/hud-board.mjs on 127.0.0.1, read through
// ZUMI_TEST_BOARD_MIRROR), with the pinned painted room and a test model. shell.openPath / shell.openExternal are
// recorders: nothing is ever opened. Voice: the old HUD voice gate is gone (talk-mode, 19-10); Zumi's own lines come from
// the speech scheduler (talkLevel normal here) as 'speech:say', and ZUMI_TEST_SAY_SILENT makes talk:tts return no audio
// for them, so the lines run the real path (subtitle in #say-line) but no sound plays. Never touches an installed Zumi
// or its data.
//   electron scripts/electron-hud.cjs --app <dir | …/resources/app.asar> --out <dir> --userdata <dir> --model <file.vrm>
// Writes <out>/result.json { checks, shots, opened, hudLog } and hud-*.png; exits 1 on any failed check.
'use strict';
// Runs inside Electron: render box only (scripts/lib/electron-guard.cjs), refused (exit 1, no dialog) before the app starts.
require('./lib/electron-guard.cjs').exitUnlessElectronHost('electron-hud.cjs');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, shell } = require('electron');

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const ROOT = path.join(__dirname, '..');
const APP = path.resolve(arg('--app') || ROOT);
const OUT = path.resolve(arg('--out'));
const USERDATA = path.resolve(arg('--userdata'));
fs.mkdirSync(OUT, { recursive: true });
fs.rmSync(USERDATA, { recursive: true, force: true });
fs.mkdirSync(USERDATA, { recursive: true });

process.env.ZUMI_ROOM_V2_DEFAULT_PATH = path.join(ROOT, 'resources-pinned', 'room-v2', 'room.json');
// Fresh userData: the painted room, English (the owner's own UI language), voice off (no sound from a test run). No
// hudStyle: the run starts from the default and checks it is Off.
// talkLevel normal + quiet hours off: the scheduler decision does not depend on the box clock.
fs.writeFileSync(path.join(USERDATA, 'settings.json'), JSON.stringify({ room: 'default-v2', uiLang: 'en', voiceEnabled: false, talkLevel: 'normal', talkQuietHours: { on: false, start: '22:30', end: '07:30' } }, null, 2));
// The fixture board's port is fixed before main.js loads (main reads the env when the app is ready).
const BOARD_PORT = 47100 + (process.pid % 800);
process.env.ZUMI_TEST_BOARD_MIRROR = `http://127.0.0.1:${BOARD_PORT}`;
process.env.ZUMI_TEST_HUD_POLL_MS = '2000';
process.env.ZUMI_TEST_SAY_SILENT = '1'; // talk:tts for a scheduler line returns no audio (test builds only): the line shows as a subtitle
process.env.ZUMI_TEST_HUD_IDLE_SEC = '2'; // "the user is active" without touching the keyboard (idle/away is covered by check-hud.mjs)

const opened = [];
shell.openPath = async (p) => { opened.push({ fn: 'openPath', arg: String(p) }); return ''; };
shell.openExternal = async (u) => { opened.push({ fn: 'openExternal', arg: String(u) }); };

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

const result = { app: APP, checks: [], shots: [], opened, errors: [] };
const check = (name, ok, detail) => { result.checks.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 60000) {
  const t0 = Date.now();
  for (;;) {
    let v; try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`);
    await sleep(200);
  }
}

// Fixture board: started now (before the app is ready), on the port main.js was told.
const boardReady = (async () => {
  const { startHudBoard } = await import(pathToFileURL(path.join(__dirname, 'fixtures', 'hud-board.mjs')).href);
  const dataDir = path.join(ROOT, '.hud-check-tmp', `board-${process.pid}`);
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  return startHudBoard({ dataDir, port: BOARD_PORT });
})();

let board = null;
const finish = async (code) => {
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(result, null, 1));
  if (board) await board.close().catch(() => {});
  setTimeout(() => app.exit(code), 100);
};

require(path.join(APP, 'src', 'main', 'main.js'));

app.whenReady().then(async () => {
  const timer = setTimeout(() => { result.errors.push('harness timeout (480 s)'); finish(2); }, 480000);
  try {
    board = await boardReady;
    const win = await until(() => BrowserWindow.getAllWindows()[0], 'main window');
    win.setContentSize(1280, 800);
    const page = win.webContents;
    // Every line the scheduler sends to the renderer ('speech:say'), recorded as it goes out.
    const says = [];
    const sendOrig = page.send.bind(page);
    page.send = (channel, ...a) => { if (channel === 'speech:say' && a[0]) says.push({ ...a[0], at: Date.now() }); return sendOrig(channel, ...a); };
    page.on('console-message', (e) => { const m = e.message || ''; if (/hud|error/i.test(m)) { result.errors.push(`console: ${m}`.slice(0, 400)); console.log(`[renderer] ${m.slice(0, 300)}`); } });
    await until(() => !page.isLoading() && page.getURL().startsWith('app://'), 'app page loaded');
    const r = (js) => page.executeJavaScript(js, true);
    const shot = async (name) => { const img = await page.capturePage(); fs.writeFileSync(path.join(OUT, name), img.toPNG()); result.shots.push(name); console.log(`shot ${name}`); };
    await until(() => r(`!!(window.__zumiScene && window.__zumiScene.director.room)`), 'painted v2 room loaded', 90000);
    await until(() => r(`document.getElementById('loading').hidden && document.getElementById('empty-model').hidden`), 'model on stage', 90000);
    await until(() => r(`!!window.__zumiHud`), 'hud ready', 20000);
    await r(`(() => { const v = document.getElementById('room-view-select'); v.value = 'talk'; v.dispatchEvent(new Event('change')); })()`); // the harness gives no input: pin the talk camera
    await sleep(5000); // seat pose + spring bones settle

    const hud = () => r(`(() => { const h = window.__zumiHud, el = document.getElementById('hud'), c = document.getElementById('hud-consent');
      return { style: h.prefs.style, hidden: el.hidden, dataStyle: el.dataset.style, hasFeed: !!(h.last && h.last.feed), updates: [...document.querySelectorAll('#hud-updates .hud-item')].map((x) => x.dataset.task || ''),
        hot: [...document.querySelectorAll('#hud .hud-item.hot')].map((x) => x.dataset.task), consent: !c.hidden, consentText: c.hidden ? '' : c.innerText,
        log: h.log.slice(), select: document.getElementById('hud-style').value, chip: document.getElementById('reflex-chip').textContent }; })()`);
    const settings = () => JSON.parse(fs.readFileSync(path.join(USERDATA, 'settings.json'), 'utf8'));
    const pickStyle = (v) => r(`(() => { const s = document.getElementById('hud-style'); s.value = ${JSON.stringify(v)}; s.dispatchEvent(new Event('change')); })()`);
    const reactions = async () => (await hud()).log.filter((x) => x.kind === 'reaction');

    // ---- 1. default Off ----
    await sleep(4500); // two poll periods
    let h = await hud();
    check('default: HUD style is Off with no stored setting', h.style === 'off' && h.select === 'off' && settings().hudStyle === undefined, { style: h.style, select: h.select });
    check('default: nothing on the stage, no board read for the HUD', h.hidden && !h.hasFeed && h.log.length === 0, h);
    await shot('hud-off.png');

    // ---- 2. style A: panels, the first read is a baseline ----
    await pickStyle('a');
    await until(async () => (await hud()).hasFeed, 'HUD A feed', 15000);
    await sleep(1500);
    h = await hud();
    check('style A: panels shown at the talk camera with the fixture tasks', !h.hidden && h.dataStyle === 'a' && h.updates.includes('T-31') && h.updates.length === 4, h.updates);
    check('style A: switching on is a baseline (no reaction, no voice)', (await reactions()).length === 0);
    check('style A: persisted', settings().hudStyle === 'a');
    check('style A: at rest no panel group has stepped aside (arms in the lap, far from the corners)', await r(`document.querySelectorAll('#hud .hud-group.yield').length === 0`));
    await shot('hud-style-a.png');

    // ---- 3. an update with an acceptance image: reaction + consent, nothing opened ----
    const accA = path.join(OUT, 'hud-style-a.png').replace(/\\/g, '/');
    board.update('T-31', 'hud', { detail: `Style A shots ready for QC\n\`${accA}\`` });
    await until(async () => (await reactions()).length === 1, 'reaction 1', 15000);
    await sleep(1100); // the double-take's closer look peaks ~1050 ms in
    await shot('hud-reaction.png');
    h = await hud();
    const re1 = (await reactions())[0];
    check('reaction: one reaction for the update, on T-31', JSON.stringify(re1.taskIds) === '["T-31"]', re1);
    check('reaction: the T-31 row is highlighted', h.hot.includes('T-31'), h.hot);
    check('reaction: Zumi turns to the panels (board double-take, no arm across the HUD)', /closer look/i.test(h.chip), h.chip);
    check('reaction: consent prompt shown with the file name', h.consent && h.consentText.includes('hud-style-a.png'), h.consentText);
    check('consent: nothing opened before an answer (user activity is not consent)', opened.length === 0, opened);
    await sleep(1200);
    await shot('hud-consent.png');
    await r(`document.getElementById('hud-consent-no').click()`);
    await until(async () => !(await hud()).consent, 'prompt closed after No', 5000);
    check('consent: "No" closes the prompt and opens nothing', opened.length === 0, opened);

    // ---- 4. the same board read again: no second reaction ----
    await sleep(4500);
    check('dedupe: the same update is not reported again', (await reactions()).length === 1);

    // ---- 5. OK opens exactly the offered file, through the allowlist ----
    const accB = path.join(OUT, 'hud-off.png').replace(/\\/g, '/');
    board.update('T-31', 'hud', { detail: `Default-off shot\n\`${accB}\`` });
    await until(async () => (await reactions()).length === 2, 'reaction 2', 15000);
    await until(async () => (await hud()).consent, 'prompt 2', 5000);
    await r(`document.getElementById('hud-consent-ok').click()`);
    await until(() => opened.length > 0, 'open recorded', 5000);
    check('consent: OK opens exactly the offered file, once', opened.length === 1 && opened[0].fn === 'openPath' && opened[0].arg.replace(/\\/g, '/').toLowerCase() === accB.toLowerCase(), opened);

    // ---- 6. an acceptance file outside the allowed folders: no prompt at all ----
    await sleep(2500);
    board.update('C-52', 'gate', { detail: 'Report\n`C:/Windows/win.ini`' });
    await until(async () => (await reactions()).length === 3, 'reaction 3', 15000);
    const re3 = (await reactions())[2];
    await sleep(500);
    h = await hud();
    check('allowlist: a file outside the allowed folders is never offered (no prompt, nothing opened)', re3.consent === false && !h.consent && opened.length === 1, { re3, consent: h.consent });

    // ---- 7. style B ----
    await pickStyle('b');
    await until(async () => (await hud()).dataStyle === 'b', 'style B', 10000);
    await sleep(2500);
    h = await hud();
    check('style B: arc panels shown at the talk camera', !h.hidden && h.dataStyle === 'b' && h.updates.length === 4, h.dataStyle);
    await shot('hud-style-b.png');
    board.update('F-04', 'r4', { detail: `Round 4 sheet\n\`${accA}\`` });
    await until(async () => (await reactions()).length === 4, 'reaction 4', 15000);
    await sleep(800);
    await shot('hud-reaction-b.png');
    await until(async () => (await hud()).consent, 'prompt B', 5000);
    await sleep(1000);
    await shot('hud-consent-b.png');
    await r(`document.getElementById('hud-consent-no').click()`);

    // style B, an update with no acceptance file: reaction only (the clearance check needs both states in both styles)
    await sleep(2500);
    board.update('C-52', 'gate', { detail: 'Gate passed for 12 drafts' });
    await until(async () => (await reactions()).length === 5, 'reaction 5 (B, no consent)', 15000);

    // ---- 8. Vietnamese UI: the prompt in anh's words ----
    await r(`document.querySelector('#lang-switch button[data-lang="vi"]').click()`);
    await sleep(2500);
    board.update('H-03', 'scan', { detail: `Scanner report\n\`${accA}\`` });
    await until(async () => (await reactions()).length === 6, 'reaction 6', 15000);
    await until(async () => (await hud()).consent, 'prompt VI', 5000);
    await sleep(1200);
    h = await hud();
    check('vi: the prompt reads "Em mở ảnh nghiệm thu này nhé?" with OK / Không', h.consentText.includes('Em mở ảnh nghiệm thu này nhé?') && h.consentText.includes('Không'), h.consentText);
    await shot('hud-consent-vi.png');
    await r(`document.getElementById('hud-consent-no').click()`);
    await r(`document.querySelector('#lang-switch button[data-lang="en"]').click()`);

    // ---- clearance (06-10 intersection rule): during every reaction gesture, in A and B, with and without the consent
    // prompt, no arm sample (upper arm, forearm, hand, finger tip, projected with the live camera) is inside a panel ----
    await until(async () => (await hud()).log.filter((x) => x.kind === 'clearance').length >= 6, 'clearance records', 15000);
    const clear = (await hud()).log.filter((x) => x.kind === 'clearance');
    result.clearance = clear;
    for (const want of [['a', true], ['a', false], ['b', true], ['b', false]]) {
      const rec = clear.filter((c) => c.style === want[0] && c.consent === want[1]);
      check(`clearance: style ${want[0].toUpperCase()} ${want[1] ? 'with the consent prompt' : 'reaction only'}: no arm sample inside a HUD panel during the reaction gesture`,
        rec.some((c) => c.panels > 0) && rec.every((c) => c.points > 0 && c.frames > 30 && c.hits.length === 0), // panels = most panels on screen in one frame
        rec.map((c) => ({ tasks: c.taskIds, frames: c.frames, points: c.points, panels: c.panels, hits: c.hits.slice(0, 4) })));
    }

    const session = await r(`window.__zumiHud.session`);
    result.sessionClearance = session;
    check('clearance: whole run with the HUD on (idle moves included): no arm sample inside a HUD panel', session.frames > 300 && session.hits.length === 0, { frames: session.frames, hits: session.hits.slice(0, 6) });

    // ---- 9. Off again ----
    await pickStyle('off');
    await sleep(1000);
    h = await hud();
    check('off: switching the HUD off hides it', h.hidden && settings().hudStyle === 'off', h);
    check('consent: only the one OK ever opened anything', opened.length === 1, opened);

    // ---- 10. talk-mode (PLAN sections 5, 6): the scheduler's lines with the HUD Off, the gap, mute, Ctrl+Shift+M ----
    // The HUD is Off here (step 9) and the talk level is Normal: an ask is still said. The scheduler gap is 60 s for an
    // ask, so wait until everything from the earlier steps (held asks, a morning line) has flushed.
    const lastSayAt = says.length ? says[says.length - 1].at : 0;
    if (Date.now() - lastSayAt < 62000) await sleep(62000 - (Date.now() - lastSayAt));
    const muteBtn = `document.getElementById('talk-mute')`;
    const sayLine = () => r(`(() => { const e = document.getElementById('say-line'); return { visible: !!e && !e.hidden, text: e ? e.textContent : '' }; })()`);
    const muted = () => r(`${muteBtn}.getAttribute('aria-pressed') === 'true'`);
    const nSays = says.length;
    board.raise('H-03', 'Should the scanner re-run on the failed links?');
    const askA = await until(() => says.slice(nSays).find((l) => l.kind === 'ask' && /Hunter|job review/i.test(l.text)), 'ask said with the HUD Off', 100000);
    check('talk: with HUD style Off and level Normal an ask is still said (speech:say, voiced)', settings().hudStyle === 'off' && askA.voice === true, { hud: settings().hudStyle, line: { kind: askA.kind, voice: askA.voice } });
    check('talk: the ask line carries the task title and no task code', /Hunter|job review/i.test(askA.text) && !/\b[A-Z]-\d{2}\b/.test(askA.text), askA.text);
    await until(async () => (await sayLine()).visible, '#say-line visible', 8000);
    check('talk: #say-line shows the line (test-silent = subtitle path)', (await sayLine()).text.length > 0, await sayLine());
    const nAfterA = says.length;
    board.raise('T-31', 'Publish the second batch too?');
    await sleep(9000);
    check('talk: a second ask inside the 60 s gap is held, not said', !says.slice(nAfterA).some((l) => l.kind === 'ask'), says.slice(nAfterA).map((l) => ({ kind: l.kind, voice: l.voice })));
    check('talk: #talk-mute exists and starts unmuted', (await muted()) === false);
    await r(`${muteBtn}.click()`);
    await until(muted, 'muted after clicking #talk-mute', 8000);
    check('talk: clicking #talk-mute mutes (persisted in settings)', Boolean(settings().talkMute), settings().talkMute);
    const askB = await until(() => says.slice(nAfterA).find((l) => l.kind === 'ask'), 'held ask released while muted', 20000);
    check('talk: while muted the next ask is subtitle-only (voice false)', askB.voice === false, { kind: askB.kind, voice: askB.voice });
    await r(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyM', key: 'M', ctrlKey: true, shiftKey: true, bubbles: true }))`);
    await until(async () => !(await muted()), 'unmuted by Ctrl+Shift+M', 8000);
    check('talk: Ctrl+Shift+M unmutes', !settings().talkMute, settings().talkMute);

    result.says = says.map((l) => ({ kind: l.kind, voice: l.voice, text: l.text }));
    result.hudLog = h.log;
    clearTimeout(timer);
    await finish(result.checks.every((c) => c.ok) ? 0 : 1);
  } catch (e) {
    result.errors.push(String((e && e.stack) || e));
    console.log(`ERROR ${e && e.message}`);
    clearTimeout(timer);
    await finish(2);
  }
});
