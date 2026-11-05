// Electron main-process harness for scripts/check-board-open-electron.mjs (T-31 ask-media review 10-10). Runs the REAL
// app (its own src/main/main.js, renderer and vendored board page, from a source tree or a packaged app.asar) in a
// window that is shown off the desktop (never over the owner's screen, never focused, no taskbar button), opens the
// Board tab on the live board through the real bridge (ZUMI_BOARD_UPSTREAM = the driver's scratch board), and clicks
// link chips with real input events in the board <webview>. shell.openPath / shell.openExternal are replaced by
// recorders before main.js loads, so nothing is ever opened; main's "[board-open] refused" lines are captured.
// Plain Chromium cannot test this: a guest page's window.open reaching main.js's setWindowOpenHandler depends on the
// <webview> (allowpopups), which is exactly what the Chromium shots missed.
//   electron scripts/electron-board-click.cjs --app <dir with src/main/main.js | …/resources/app.asar> --out <dir> [--userdata <dir>]
//     --plan <plan.json>   { user, pass, clicks: [{ name, task, label }], shots: [{ name, hash?, task?, theme, w, h }] }
// Writes <out>/result.json: { pkgOwnerAdmin, ownerAllowlistPacked, ownerAdmin, refusalLog, clicks: [{ name, href, calls, refused, windows }], shots, texts, errors }.
'use strict';
const path = require('node:path');
const fs = require('node:fs');
// Runs inside Electron: render box only (scripts/lib/electron-guard.cjs), refused (exit 1, no dialog) before the app starts.
require('./lib/electron-guard.cjs').exitUnlessElectronHost('electron-board-click.cjs');
const { app, shell, BrowserWindow, nativeTheme, webContents } = require('electron');
const { findChip, overlayState } = require('./lib/chip-spot.cjs');

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const APP = path.resolve(arg('--app') || path.join(__dirname, '..'));
const OUT = path.resolve(arg('--out') || path.join(__dirname, '..', '.board-click-out'));
const PLAN = JSON.parse(fs.readFileSync(arg('--plan'), 'utf8'));
fs.mkdirSync(OUT, { recursive: true });

// ---- recorders instead of the OS (nothing opens) ----
const calls = [];
shell.openPath = async (p) => { calls.push({ fn: 'openPath', arg: String(p) }); return ''; };
shell.openExternal = async (u) => { calls.push({ fn: 'openExternal', arg: String(u) }); };
const warns = [];
const warn0 = console.warn.bind(console);
console.warn = (...a) => { warns.push(a.map(String).join(' ')); warn0(...a); };

// ---- own profile, window off the desktop ----
const USERDATA = path.resolve(arg('--userdata') || path.join(OUT, 'userdata')); // the driver passes a scratch folder it removes
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

// What the app under test IS, read from its own package.json and file list (Electron's fs reads inside app.asar):
// the owner flag and whether the owner-only link allowlist (review v6 C2) is packed at all.
const appPkg = (() => { try { return JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8')); } catch { return null; } })();
const result = { app: APP, pkgOwnerAdmin: appPkg ? appPkg.zumiOwnerAdmin === true : null, ownerAllowlistPacked: fs.existsSync(path.join(APP, 'src', 'main', 'link-allowlist.owner.json')), ownerAdmin: null, clicks: [], shots: [], texts: {}, errors: [] };
const finish = (code) => {
  result.warns = warns.filter((w) => /\[board-open\]/.test(w));
  // review v6 C1: the durable refusal log main.js keeps under userData (read here, before the driver removes the folder)
  try { result.refusalLog = fs.readFileSync(path.join(USERDATA, 'logs', 'board-open-refusals.log'), 'utf8'); } catch (e) { result.refusalLog = null; result.refusalLogError = String((e && e.code) || e); }
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(result, null, 1));
  setTimeout(() => app.exit(code), 100);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 30000) {
  const t0 = Date.now();
  for (;;) {
    let v; try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`);
    await sleep(200);
  }
}

// The real app.
require(path.join(APP, 'src', 'main', 'main.js'));

app.whenReady().then(async () => {
  const timer = setTimeout(() => { result.errors.push('harness timeout (180 s)'); finish(2); }, 180000);
  try {
    const win = await until(() => BrowserWindow.getAllWindows()[0], 'main window');
    win.setContentSize(1280, 800);
    const page = win.webContents;
    await until(() => !page.isLoading() && page.getURL().startsWith('app://'), 'app page loaded');
    const r = (js) => page.executeJavaScript(js, true);
    await until(() => r(`typeof zumi === 'object' && !!document.querySelector('.tab[data-tab="board"]')`), 'renderer ready');
    result.ownerAdmin = await r('zumi.info().then((i) => i.ownerAdmin)').catch(() => null);
    // Sign in to the live board the way board-signin.js does (no PIN), switch to live, open the Board tab.
    const set = await r(`zumi.board.setSecretsOs(${JSON.stringify({ user: PLAN.user, pass: PLAN.pass, token: '' })})`);
    if (!set || !set.ok) throw new Error(`board:setSecretsOs ${JSON.stringify(set)}`);
    const mode = await r(`zumi.board.setMode('live')`);
    if (!mode || !mode.ok) throw new Error(`board:setMode ${JSON.stringify(mode)}`);
    // The tab's click listener is attached once the renderer finished its own start-up: click until the webview exists.
    const boardGuest = () => webContents.getAllWebContents().find((c) => c.getType() === 'webview' && /^http:\/\/127\.0\.0\.1:\d+\//.test(c.getURL()));
    let clicks = 0;
    const guest = await until(async () => { const found = boardGuest(); if (found) return found; if (clicks++ % 10 === 0) await r(`document.querySelector('.tab[data-tab="board"]').click()`); return null; }, 'board webview', 60000);
    result.guestUrl = guest.getURL();
    result.allowpopups = await r(`(() => { const w = document.querySelector('#board-host webview'); return w ? w.hasAttribute('allowpopups') : null; })()`);
    const g = (js) => guest.executeJavaScript(js, true);
    await until(() => g(`!!document.querySelector('.attention .row.ask')`), 'Needs-you card rendered', 45000);
    await sleep(600);
    // Laneboard 3727919+ (Home Needs-you grouped by task): an ask row inside a group shows only its own label, and a task
    // with several asks folds them behind one <details>. Record the groups as rendered (the "one row per task" check),
    // then open each folded group the way a click on its head does (the page's toggle listener keeps it open across
    // re-renders) and give every ask row back its task/step code from the page's own state, so the chip clicks, texts
    // and shots below address each ask exactly as they did before the grouping.
    result.needGroups = await g(`(() => {
      const waiting = (typeof S !== 'undefined' && S.data && S.data.attention && S.data.attention.waiting) || [];
      return { waiting: waiting.length, waitingTasks: [...new Set(waiting.map((w) => w.task_id))],
        groups: [...document.querySelectorAll('.attention.queue .need-group')].map((el) => ({ code: el.querySelector('.need-head .code')?.textContent || '', folded: el.tagName === 'DETAILS', open: el.tagName === 'DETAILS' ? el.open : true, asks: el.querySelectorAll('.row.ask').length, badge: el.querySelector('.need-head .badge')?.textContent || '' })) };
    })()`);
    if (result.needGroups.groups.some((x) => x.folded && !x.open)) {
      const img = await guest.capturePage();
      const file = path.join(OUT, 'needs-you-grouped-folded.png'); fs.writeFileSync(file, img.toPNG()); result.needGroups.shot = file;
    }
    await g(`(() => {
      window.__rowCode = (el) => {
        const own = el.querySelector('.ask-head .code'); if (own) return own.textContent;
        const id = new URLSearchParams((el.querySelector('.ask-head')?.getAttribute('href') || '').split('?')[1] || '').get('ask');
        const w = id && typeof S !== 'undefined' && S.data && S.data.attention ? S.data.attention.waiting.find((x) => x.id === id) : null;
        if (w) return w.task_id + (w.step_id ? '/' + w.step_id : '');
        return el.closest('.need-group')?.querySelector('.need-head .code')?.textContent || '';
      };
      document.querySelectorAll('.attention details.need-group:not([open]) > summary').forEach((x) => x.click());
    })()`);
    await sleep(400);
    result.ownerAdmin ??= /[?&]local=open\b/.test(guest.getURL());

    // ---- clicks: real mouse events on the chip, then what main did ----
    for (const c of PLAN.clicks) {
      const spot = await findChip(g, sleep, c.task, c.label);
      if (spot.missing) { result.clicks.push({ name: c.name, missing: true, chips: spot.chips }); continue; }
      if (spot.covered) { result.clicks.push({ name: c.name, covered: true, coveredBy: spot.coveredBy, unexpected: spot.unexpected, dismissed: spot.dismissed }); continue; } // never click blind
      await sleep(250);
      const n0 = calls.length, w0 = warns.length, win0 = BrowserWindow.getAllWindows().length;
      guest.sendInputEvent({ type: 'mouseMove', x: spot.x, y: spot.y });
      guest.sendInputEvent({ type: 'mouseDown', x: spot.x, y: spot.y, button: 'left', clickCount: 1 });
      guest.sendInputEvent({ type: 'mouseUp', x: spot.x, y: spot.y, button: 'left', clickCount: 1 });
      await sleep(1200);
      const overlayAfter = await overlayState(g);
      result.clicks.push({ name: c.name, href: spot.href, target: spot.target, dismissed: spot.dismissed, overlayAfter, calls: calls.slice(n0), refused: warns.slice(w0).filter((w) => /\[board-open\] refused/.test(w)), windows: BrowserWindow.getAllWindows().length - win0, guestUrlAfter: guest.getURL() });
    }

    // ---- what the cards say (ages, measured time, which links sit on which task) ----
    result.texts = await g(`(() => {
      const rows = [...document.querySelectorAll('.attention .row.ask')].map((el) => ({ code: window.__rowCode ? window.__rowCode(el) : (el.querySelector('.code')?.textContent || ''), text: (el.querySelector('.text')?.textContent || '').slice(0, 120), age: el.querySelector('.sub')?.textContent || '', thumbs: el.querySelectorAll('.ref-img').length, links: [...el.querySelectorAll('.ref-link')].map((a) => a.textContent.trim()), hrefs: [...el.querySelectorAll('.ref-link')].map((a) => a.getAttribute('href') || '') }));
      return { rows };
    })()`);

    // ---- shots (guest only: the board as anh sees it in the Board tab) ----
    for (const s of PLAN.shots || []) {
      nativeTheme.themeSource = s.theme || 'light';
      win.setContentSize(s.w || 1280, s.h || 800);
      if (s.hash !== undefined) { await g(`location.hash = ${JSON.stringify(s.hash)}`); }
      await sleep(900);
      if (s.wait) await until(() => g(`!!document.querySelector(${JSON.stringify(s.wait)})`), `shot ${s.name}: ${s.wait}`, 20000);
      let rect;
      if (s.task) {
        rect = await g(`(() => { const row = [...document.querySelectorAll('.attention .row.ask')].find((el) => (window.__rowCode ? window.__rowCode(el) : (el.querySelector('.code')?.textContent || '')).startsWith(${JSON.stringify(s.task)})); if (!row) return null; row.scrollIntoView({ block: 'center' }); const b = row.getBoundingClientRect(); return { x: Math.max(0, Math.floor(b.x)), y: Math.max(0, Math.floor(b.y)), width: Math.ceil(b.width), height: Math.ceil(b.height) }; })()`);
        await sleep(300);
        if (!rect) { result.shots.push({ name: s.name, missing: true }); continue; }
      }
      if (s.eval) result.texts[s.name] = await g(s.eval);
      const img = await guest.capturePage(rect);
      const file = path.join(OUT, `${s.name}.png`);
      fs.writeFileSync(file, img.toPNG());
      const size = img.getSize();
      result.shots.push({ name: s.name, file, width: size.width, height: size.height });
    }
    clearTimeout(timer);
    finish(0);
  } catch (e) {
    clearTimeout(timer);
    result.errors.push(String(e && e.stack || e));
    finish(1);
  }
});
