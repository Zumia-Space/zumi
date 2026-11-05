// Electron probe for Brain's three read-only host calls (T-31 slice 3a-3, GATE-SEC-3a-3 C4 "EP" asserts). Runs the REAL src/main/main.js of
// --app (a scratch copy made by scripts/check-brain-host-electron.mjs: one built OFF or ON) in its own userData, in a window shown off the
// desktop (never over the owner's screen), against a FIXTURE board on 127.0.0.1 read through ZUMI_TEST_BOARD_MIRROR. shell.openPath /
// shell.openExternal are recorders: nothing is ever opened. Never touches an installed Zumi or its data.
//   electron scripts/electron-brain-host.cjs --app <dir> --mode off|on --out <dir> --userdata <dir>
// Writes <out>/result.json { mode, checks, boardRequests, opened, errors }; exits 1 on any failed check.
'use strict';
// Runs inside Electron: render box only (scripts/lib/electron-guard.cjs), refused (exit 1, no dialog) before the app starts.
require('./lib/electron-guard.cjs').exitUnlessElectronHost('electron-brain-host.cjs');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, shell } = require('electron');

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const ROOT = path.join(__dirname, '..');
const APP = path.resolve(arg('--app') || ROOT);
const MODE = arg('--mode');
const OUT = path.resolve(arg('--out'));
const USERDATA = path.resolve(arg('--userdata'));
if (MODE !== 'off' && MODE !== 'on') { console.error('--mode off|on'); process.exit(1); }
fs.mkdirSync(OUT, { recursive: true });
fs.rmSync(USERDATA, { recursive: true, force: true });
fs.mkdirSync(USERDATA, { recursive: true });

process.env.ZUMI_ROOM_V2_DEFAULT_PATH = path.join(ROOT, 'resources-pinned', 'room-v2', 'room.json');
fs.writeFileSync(path.join(USERDATA, 'settings.json'), JSON.stringify({ room: 'default-v2', uiLang: 'en', voiceEnabled: false, talkLevel: 'off', talkQuietHours: { on: false, start: '22:30', end: '07:30' } }, null, 2));

// ---- fixture board: the real boardView shape, with a non-empty notify.webhook_url, and refs the page may cite ----
const SECRET = 'https://hooks.example.test/services/T000/B000/SECRET-WEBHOOK-TOKEN';
const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'fixtures', 'brain-board-state.json'), 'utf8'));
fixture.notify = { ...(fixture.notify || {}), webhook_url: SECRET };
fixture.tasks[0].goal = 'Brain panel. Spec: [Spec](https://example.com/spec?a=1) and the dossier.';
fixture.tasks[0].next = 'Local: `D:/data/notes/t31/next/PLAN-SLICE3-BRAIN.md`';
const boardRequests = [];
const board = http.createServer((req, res) => {
  boardRequests.push(`${req.method} ${req.url.split('?')[0]}`);
  if (req.url.split('?')[0] === '/api/v1/state') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(fixture)); }
  res.writeHead(404); res.end('no');
});
// main.js reads ZUMI_TEST_BOARD_MIRROR when the app is ready, so the port is fixed before the app code loads (same as electron-hud.cjs)
const boardPort = 47100 + (process.pid % 800);
process.env.ZUMI_TEST_BOARD_MIRROR = `http://127.0.0.1:${boardPort}`;
const boardReady = new Promise((r) => board.listen(boardPort, '127.0.0.1', r));

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

const result = { app: APP, mode: MODE, checks: [], opened, errors: [], boardRequests };
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
const finish = async (code) => {
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(result, null, 1));
  await new Promise((r) => board.close(r)).catch(() => {});
  setTimeout(() => app.exit(code), 100);
};

require(path.join(APP, 'src', 'main', 'main.js')); // before the app is ready: it registers the app:// scheme

app.whenReady().then(async () => {
  const timer = setTimeout(() => { result.errors.push('harness timeout (240 s)'); finish(2); }, 240000);
  try {
    await boardReady;
    const win = await until(() => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()), 'main window');
    win.setContentSize(1280, 800);
    const page = win.webContents;
    page.on('console-message', (e) => { const m = e.message || ''; if (/board|error/i.test(m)) result.errors.push(`console: ${m}`.slice(0, 300)); });
    await until(() => !page.isLoading() && page.getURL().startsWith('app://'), 'app page loaded');
    const r = (js) => page.executeJavaScript(js, true);
    await until(() => r(`typeof window.zumi === 'object' && typeof window.zumi.board === 'object' && typeof window.zumi.board.status === 'function'`), 'preload bridge');
    await sleep(1500);

    // the probe window: a second page with a raw ipcRenderer.invoke
    const probe = new BrowserWindow({ width: 200, height: 200, show: false, webPreferences: { preload: path.join(__dirname, 'lib', 'brain-host-probe-preload.cjs'), sandbox: true, contextIsolation: true } });
    await probe.loadURL('data:text/html,<title>probe</title>');
    const raw = (channel, ...args) => probe.webContents.executeJavaScript(`window.probe.invoke(${JSON.stringify(channel)}, ...${JSON.stringify(args)})`, true);
    const CHANNELS = [['board:state'], ['board:media', 'att-17', { w: 480 }], ['board:open-ref', { kind: 'url', target: 'https://example.com/spec?a=1' }]];

    const keys = await r(`(() => { const b = window.zumi.board; return { state: typeof b.state, media: typeof b.media, openRef: typeof b.openRef, status: typeof b.status, signOut: typeof b.signOut }; })()`);
    check('EP-0 the legacy board keys are there (the bridge itself works in both builds)', keys.status === 'function' && keys.signOut === 'function', keys);

    if (MODE === 'off') {
      check('EP-1a OFF build: window.zumi.board.state / media / openRef are undefined', keys.state === 'undefined' && keys.media === 'undefined' && keys.openRef === 'undefined', keys);
      const before = boardRequests.length;
      const answers = [];
      for (const [ch, ...a] of CHANNELS) answers.push([ch, await raw(ch, ...a)]);
      check('EP-1b OFF build: ipcRenderer.invoke of each of the 3 channels rejects (no handler registered)', answers.every(([, x]) => x.ok === false && /No handler registered/i.test(x.error)), answers);
      await sleep(500);
      check('EP-1c OFF build: the fixture board saw no request from those calls', boardRequests.length === before, { before, after: boardRequests.length, log: boardRequests.slice(-4) });
      check('EP-1d OFF build: ZUMI_NEXT_UI=' + JSON.stringify(process.env.ZUMI_NEXT_UI || '') + ' in the app environment does not turn it on (the build artefact decides)', keys.state === 'undefined' && answers.every(([, x]) => x.ok === false), { env: process.env.ZUMI_NEXT_UI || null });
    } else {
      check('EP-2a ON build: window.zumi.board.state / media / openRef are functions', keys.state === 'function' && keys.media === 'function' && keys.openRef === 'function', keys);
      check('EP-2b ON build: ZUMI_NEXT_UI=' + JSON.stringify(process.env.ZUMI_NEXT_UI || '') + ' in the app environment does not turn it off (the build artefact decides)', keys.state === 'function', { env: process.env.ZUMI_NEXT_UI || null });
      const before = boardRequests.length;
      const s = await r(`window.zumi.board.state()`);
      const STATE_KEYS = ['version', 'seq', 'now', 'tasks', 'asks', 'attachments', 'times', 'task_times', 'goals', 'plans', 'attention'].sort();
      check('EP-2c ON build: board.state() answers ok with exactly the 11 gate keys', s && s.ok === true && JSON.stringify(Object.keys(s.state).sort()) === JSON.stringify(STATE_KEYS), s && s.ok ? Object.keys(s.state) : s);
      check('EP-2d ON build: no webhook URL in the answer, notify / me / routing absent', s && s.ok === true && !JSON.stringify(s).includes('SECRET-WEBHOOK-TOKEN') && !('notify' in s.state) && !('me' in s.state) && !('routing' in s.state), s && s.ok ? 'clean' : s);
      check('EP-2e ON build: the answer came from the board (positive control for the request log)', boardRequests.length > before && boardRequests.some((x) => x === 'GET /api/v1/state'), boardRequests);
      check('EP-2f ON build: tasks carry only the fields Brain renders (no attribution / worker / roles)', s.ok && s.state.tasks.every((t) => !('attribution' in t) && !('worker' in t) && !('roles' in t) && !('gate_fails' in t)), s.ok ? s.state.tasks.map((t) => Object.keys(t).length) : null);
      const answers = [];
      for (const [ch, ...a] of CHANNELS) answers.push([ch, await raw(ch, ...a)]);
      check('EP-3a ON build: the handlers exist, and a page that is not the main window is refused ("forbidden")', answers.every(([, x]) => x.ok === true && x.value && (x.value.reason === 'forbidden') && x.value.opened !== true), answers);
      const m1 = await r(`window.zumi.board.media('att-1/../state')`);
      const m2 = await r(`window.zumi.board.media('att-17', { w: 480 })`);
      check('EP-3b ON build: media with a bad id -> bad_id; a valid id with no live board -> unconfigured (nothing fetched)', m1.ok === false && m1.reason === 'bad_id' && m2.ok === false && m2.reason === 'unconfigured', [m1, m2]);
      const o1 = await r(`window.zumi.board.openRef({ kind: 'url', target: 'https://example.com/never-cited' })`);
      check('EP-3c ON build: openRef of a ref the board does not cite -> not_on_board, nothing opened', o1.opened === false && o1.reason === 'not_on_board' && opened.length === 0, { o1, opened });
      await sleep(1100);
      const o2 = await r(`window.zumi.board.openRef({ kind: 'url', target: 'https://example.com/spec?a=1' })`);
      check('EP-3d ON build: a cited https link opens once, through the host opener', o2.opened === true && opened.length === 1 && opened[0].fn === 'openExternal' && opened[0].arg === 'https://example.com/spec?a=1', { o2, opened });
      await sleep(1100);
      const o3 = await r(`window.zumi.board.openRef({ kind: 'local', target: 'D:/data/notes/t31/next/PLAN-SLICE3-BRAIN.md' })`);
      check('EP-3e ON build (public flavour: no zumiOwnerAdmin): a cited local file -> not_owner_build, nothing opened', o3.opened === false && o3.reason === 'not_owner_build' && opened.length === 1, { o3, opened });
      const logFile = path.join(USERDATA, 'logs', 'board-open-refusals.log');
      const logText = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
      check('EP-3f the refusals reached board-open-refusals.log as "<time> <reason> <origin>" with no path or query', /not_on_board https:\/\/example\.com\n/.test(logText) && /not_owner_build -\n/.test(logText) && !/D:|notes|never-cited|spec|\?/.test(logText), logText.split('\n').slice(0, 4));
      // EP-4: Electron's own global fetch (what main.js hands to board-reads) with redirect:'manual' sees a 302 as http_302 (Tauri's pinned transport says "offline" for the same case)
      const { createBoardReads } = await import(pathToFileURL(path.join(APP, 'src', 'main', 'board-reads.mjs')).href);
      const media = http.createServer((req, res) => { res.writeHead(302, { location: `http://127.0.0.1:${boardPort}/api/v1/state` }); res.end(); });
      const mport = await new Promise((rr) => media.listen(0, '127.0.0.1', () => rr(media.address().port)));
      const reads = createBoardReads({
        boardReader: { getState: async () => ({ ok: true, state: { attachments: [{ id: 'att-17', mime: 'image/png' }] } }) },
        liveBoard: { status: () => ({ configured: true, locked: false, mode: 'live' }), bridgePort: async () => mport, bridgeHeaders: async () => ({}) },
        fetchImpl: (url, init) => fetch(url, init), decide: () => ({ action: 'refuse', reason: 'x' }), open: async () => {},
      });
      const reqBefore = boardRequests.length;
      const red = await reads.media('att-17');
      await new Promise((rr) => media.close(rr));
      check('EP-4 Electron: a 302 from the bridge is refused as http_302 and the redirect is not followed', red.ok === false && red.reason === 'http_302' && boardRequests.length === reqBefore, { red, followed: boardRequests.length - reqBefore });
    }
    clearTimeout(timer);
    const failed = result.checks.filter((c) => !c.ok).length;
    console.log(`${MODE}: ${result.checks.length - failed} passed, ${failed} failed`);
    await finish(failed ? 1 : 0);
  } catch (e) {
    result.errors.push(String((e && e.stack) || e).slice(0, 600));
    console.log(`ERROR ${result.errors[result.errors.length - 1]}`);
    await finish(2);
  }
});
