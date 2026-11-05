// Electron harness for the T1/T2/T3 HUD panel (T-31 hud-panels step 7, PLAN section 8). Same rules as
// scripts/electron-hud.cjs: runs the REAL app in its own userData, window off the desktop, fixture board on 127.0.0.1,
// shell.open* are recorders. Render box only (electron-guard).
//   electron scripts/electron-hud-panels.cjs --app <app dir> --out <dir> --userdata <dir> --model <file.vrm> [--mode panels|base]
//   --mode panels (default): design x place x size matrix + settings-select exercise + checks, on the tree under test.
//   --mode nits: short re-check of the 0.2.8 HUD state-column fix (T3 log state labels in EN/VI) + a crowded in-place left group.
//   --mode base: the LAST APPROVED look (an app tree without the new panel): HUD off / style A / style B at the same
//                three window sizes, so a reviewer can put the shots side by side with the panels run.
// Sizes: small = the window minimum (900x600 content), default = 1280x800, large = 1920x1080.
// Writes <out>/result.json { checks, shots, probes, errors, console } and <out>/console.log; exits 1 on a failed check.
'use strict';
require('./lib/electron-guard.cjs').exitUnlessElectronHost('electron-hud-panels.cjs');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, shell } = require('electron');

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const ROOT = path.join(__dirname, '..');
const APP = path.resolve(arg('--app') || ROOT);
const OUT = path.resolve(arg('--out'));
const USERDATA = path.resolve(arg('--userdata'));
const MODE = arg('--mode') || 'panels';
fs.mkdirSync(OUT, { recursive: true });
fs.rmSync(USERDATA, { recursive: true, force: true });
fs.mkdirSync(USERDATA, { recursive: true });

process.env.ZUMI_ROOM_V2_DEFAULT_PATH = path.join(ROOT, 'resources-pinned', 'room-v2', 'room.json');
fs.writeFileSync(path.join(USERDATA, 'settings.json'), JSON.stringify({ room: 'default-v2', uiLang: 'en', voiceEnabled: false, talkLevel: 'normal', talkQuietHours: { on: false, start: '22:30', end: '07:30' } }, null, 2));
const BOARD_PORT = 47100 + (process.pid % 800);
process.env.ZUMI_TEST_BOARD_MIRROR = `http://127.0.0.1:${BOARD_PORT}`;
process.env.ZUMI_TEST_HUD_POLL_MS = '2000';
process.env.ZUMI_TEST_SAY_SILENT = '1';
process.env.ZUMI_TEST_HUD_IDLE_SEC = '2';

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

const SIZES = [['small', 900, 600], ['default', 1280, 800], ['large', 1920, 1080]];
const DESIGNS = ['t1', 't2', 't3'];
// The two below places are no longer offered by the settings select (Opus review 2026-10-24); a saved below value reads back
// as in place, so the matrix runs the one offered place.
const PLACES = ['inplace'];

const result = { app: APP, mode: MODE, checks: [], shots: [], probes: [], sizes: {}, opened, errors: [], console: [] };
const consoleLines = [];
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

const boardReady = (async () => {
  const { startHudBoard } = await import(pathToFileURL(path.join(__dirname, 'fixtures', 'hud-board.mjs')).href);
  const dataDir = path.join(ROOT, '.hud-check-tmp', `board-panels-${process.pid}`);
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  return startHudBoard({ dataDir, port: BOARD_PORT });
})();

let board = null;
const finish = async (code) => {
  result.console = consoleLines;
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(result, null, 1));
  fs.writeFileSync(path.join(OUT, 'console.log'), consoleLines.join('\n') + '\n');
  if (board) await board.close().catch(() => {});
  setTimeout(() => app.exit(code), 100);
};

require(path.join(APP, 'src', 'main', 'main.js'));

app.whenReady().then(async () => {
  const timer = setTimeout(() => { result.errors.push('harness timeout (1500 s)'); finish(2); }, 1500000);
  try {
    board = await boardReady;
    const win = await until(() => BrowserWindow.getAllWindows()[0], 'main window');
    win.setContentSize(1280, 800);
    const page = win.webContents;
    // EVERY console message, with its level (0 verbose, 1 info, 2 warning, 3 error), goes to console.log; warnings and
    // errors also go to result.errors so the run summary shows them.
    page.on('console-message', (e) => {
      const lvl = e.level;
      const name = typeof lvl === 'number' ? ['verbose', 'info', 'warning', 'error'][lvl] || String(lvl) : String(lvl);
      const line = `[${name}] ${String(e.message || '').slice(0, 600)} (${String(e.sourceId || '').split('/').slice(-2).join('/')}:${e.lineNumber || 0})`;
      consoleLines.push(line);
      if (name === 'error' || name === 'warning') result.errors.push(line);
    });
    page.on('render-process-gone', (_e, d) => { result.errors.push(`render-process-gone ${JSON.stringify(d)}`); });
    page.on('did-fail-load', (_e, code, desc, url) => { result.errors.push(`did-fail-load ${code} ${desc} ${url}`); });
    await until(() => !page.isLoading() && page.getURL().startsWith('app://'), 'app page loaded');
    const r = (js) => page.executeJavaScript(js, true);
    const shot = async (name) => { const img = await page.capturePage(); fs.writeFileSync(path.join(OUT, name), img.toPNG()); result.shots.push(name); console.log(`shot ${name}`); };
    await until(() => r(`!!(window.__zumiScene && window.__zumiScene.director.room)`), 'painted v2 room loaded', 90000);
    await until(() => r(`document.getElementById('loading').hidden && document.getElementById('empty-model').hidden`), 'model on stage', 90000);
    await until(() => r(`!!window.__zumiHud`), 'hud ready', 20000);
    await r(`(() => { const v = document.getElementById('room-view-select'); v.value = 'talk'; v.dispatchEvent(new Event('change')); })()`);
    await sleep(5000);

    const setSize = async (name, w, h) => {
      win.setContentSize(w, h);
      await sleep(1800);
      const got = await r(`({ w: window.innerWidth, h: window.innerHeight, stage: (() => { const b = document.getElementById('stage-canvas').getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height) }; })() })`);
      result.sizes[name] = { asked: [w, h], got };
      check(`size ${name}: the window is at least the asked content size (the OS minimum / frame may add a few px; actual sizes are in result.sizes)`, got.w >= w - 2 && got.h >= h - 2, { asked: [w, h], got });
      return got;
    };
    const pickStyle = (v) => r(`(() => { const s = document.getElementById('hud-style'); s.value = ${JSON.stringify(v)}; s.dispatchEvent(new Event('change')); })()`);
    const pick = (id, v) => r(`(() => { const s = document.getElementById(${JSON.stringify(id)}); s.value = ${JSON.stringify(v)}; s.dispatchEvent(new Event('change')); return s.value; })()`);
    // hud.js keeps at most 40 arm hits in window.__zumiHud.session.hits (an app-side cap). To check the WHOLE run, move them into
    // the harness every 250 ms; a drain that finds the cap reached is itself a finding (hits may have been lost).
    const allHits = []; let saturatedDrains = 0; let pauseDrain = false; let draining = null;
    const drainOnce = async () => { const got = await r(`window.__zumiHud.session.hits.splice(0)`); if (got.length >= 40) saturatedDrains++; allHits.push(...got); };
    const drainTimer = setInterval(() => { if (pauseDrain || draining) return; draining = drainOnce().catch(() => {}).finally(() => { draining = null; }); }, 250);
    const drainIdle = async () => { while (draining) await draining; };
    const feedReady = async () => { await until(() => r(`!!(window.__zumiHud.last && window.__zumiHud.last.feed)`), 'HUD feed', 15000); };

    // ================= base: the last approved look, same sizes =================
    if (MODE === 'base') {
      for (const [sn, w, h] of SIZES) {
        await setSize(sn, w, h);
        await pickStyle('off'); await sleep(900);
        await shot(`base-hud-off-${sn}.png`);
        for (const st of ['a', 'b']) {
          await pickStyle(st); await feedReady(); await sleep(2500);
          await shot(`base-hud-style-${st}-${sn}.png`);
        }
      }
      check('base: no new panel in this tree (the baseline is the old two panels only)', await r(`!document.getElementById('hud-panel') && !document.getElementById('hud-panel-design')`));
      check('base: no console errors', !result.errors.some((l) => /^\[error\]/.test(l)), result.errors.slice(0, 5));
      clearTimeout(timer);
      return finish(result.checks.every((c) => c.ok) ? 0 : 1);
    }

    // ================= panels: the matrix =================
    check('panels: the two new selects and the panel node exist', await r(`!!(document.getElementById('hud-panel-design') && document.getElementById('hud-panel-place') && document.getElementById('hud-panel'))`));
    await pickStyle('a'); await feedReady(); await sleep(1500);
    check('panels: the default pair (no stored pref) is T1 + in place', await r(`document.getElementById('hud-panel-design').value === 't1' && document.getElementById('hud-panel-place').value === 'inplace'`));

    // One probe per shot: where the panel is, whether it is cut by its own group, whether it hits the lines that must stay
    // clear, and the text-fit facts a reviewer would otherwise eyeball.
    const probe = (label) => r(`(() => {
      const $ = (id) => document.getElementById(id);
      const label = ${JSON.stringify(label)};
      const p = $('hud-panel');
      const vis = (e) => { if (!e || e.hidden) return false; const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
      const rc = (e) => { const b = e.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) }; };
      const hit = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      const out = { label, visible: vis(p), design: p.dataset.design || '', size: p.dataset.size || '', host: '', rect: null, inWindow: null, groupCut: null, overlaps: [], clipped: [], nowOk: null, logLastInside: null, yielded: null, tag: '' };
      if (!out.visible) return out;
      const b = p.getBoundingClientRect();
      const host = p.closest('.hud-group');
      out.host = host ? (host.classList.contains('hud-below') ? 'below:' + host.dataset.place : 'left') : '';
      out.rect = rc(p);
      out.inWindow = b.left >= -0.5 && b.top >= -0.5 && b.right <= innerWidth + 0.5 && b.bottom <= innerHeight + 0.5;
      if (host) { const hb = host.getBoundingClientRect(); out.groupCut = { panelBottom: Math.round(b.bottom), groupBottom: Math.round(hb.bottom), cut: b.bottom > hb.bottom + 1 }; out.yielded = host.classList.contains('yield'); }
      for (const id of ['say-line', 'heard', 'talk']) { const e = $(id); if (vis(e) && hit(b, e.getBoundingClientRect())) out.overlaps.push(id); }
      for (const g of document.querySelectorAll('#hud .hud-group')) { if (g === host || g.hidden || g.classList.contains('yield')) continue; if (vis(g) && hit(b, g.getBoundingClientRect())) out.overlaps.push('group:' + (g.className.replace('hud-group', '').trim() || '?')); }
      for (const n of p.querySelectorAll('*')) {
        if (n.closest('svg')) continue;
        const cs = getComputedStyle(n);
        const clampedY = cs.webkitLineClamp && cs.webkitLineClamp !== 'none';
        const vCut = !clampedY && n.scrollHeight > n.clientHeight + 1 && /hidden|clip/.test(cs.overflowY);
        const hCut = n.scrollWidth > n.clientWidth + 1 && /hidden|clip/.test(cs.overflowX) && !n.dataset.full && cs.textOverflow !== 'ellipsis';
        if (vCut || hCut) out.clipped.push({ cls: String(n.className).slice(0, 40), text: (n.textContent || '').slice(0, 40), v: vCut, h: hCut });
      }
      const nowEls = [...p.querySelectorAll('[data-full]')];
      out.nowOk = nowEls.every((n) => { const t = n.textContent, f = n.dataset.full; if (t === f) return true; if (!t.endsWith('…')) return false; const base = t.slice(0, -1); return base === '' || (f.startsWith(base) && /[\\s,.;:!?)\\]\\-]/.test(f[base.length] || ' ')); });
      const log = p.querySelector('.hp-log');
      if (log) { const rows = [...log.querySelectorAll('.hp-ln')]; const lb = log.getBoundingClientRect(); const last = rows[rows.length - 1]; out.logLastInside = last ? (last.getBoundingClientRect().bottom <= lb.bottom + 1 && last.getBoundingClientRect().top >= lb.top - 1) : null; out.logRows = rows.length; }
      out.tag = (p.querySelector('.hp-tag') || {}).textContent || '';
      // frame + fill (the pseudo-elements must span the panel, not the 12 px corner-bracket size) and text fit facts
      const pw = p.offsetWidth, ph = p.offsetHeight; // layout size: style B tilts the group, so the bounding rect is a projection
      const f1 = getComputedStyle(p, '::before'), f2 = getComputedStyle(p, '::after');
      const alpha = (c) => { const m = /\\(([^)]+)\\)/.exec(c || ''); if (!m) return 0; const q = m[1].split(/[ ,/]+/).filter(Boolean); const a = q.length > 3 ? parseFloat(q[q.length - 1]) : 1; return Number.isFinite(a) ? a : 1; }; // rgb(), rgba() and the color(srgb r g b / a) form Chromium returns
      out.frame = { panel: [pw, ph], before: [Math.round(parseFloat(f1.width)), Math.round(parseFloat(f1.height))], after: [Math.round(parseFloat(f2.width)), Math.round(parseFloat(f2.height))], afterBg: f2.backgroundColor, afterAlpha: alpha(f2.backgroundColor), beforeBorder: f1.borderTopWidth };
      out.frameOk = Math.abs(out.frame.before[0] - pw) <= 2 && Math.abs(out.frame.before[1] - ph) <= 2 && Math.abs(out.frame.after[0] - pw) <= 2 && Math.abs(out.frame.after[1] - ph) <= 2 && parseFloat(f1.borderTopWidth) === 0 && parseFloat(f2.borderTopWidth) === 0;
      out.lnOverlap = [];
      for (const ln of p.querySelectorAll('.hp-ln')) {
        const at = ln.querySelector('.at'), tg = ln.querySelector('.tg');
        if (!at || !tg) continue;
        const ar = at.getBoundingClientRect(), tr = tg.getBoundingClientRect();
        if (at.scrollWidth > at.clientWidth + 1 || ar.right > tr.left + 0.5) out.lnOverlap.push({ at: at.textContent, atBox: [Math.round(ar.left), Math.round(ar.right)], tgLeft: Math.round(tr.left), scrollW: at.scrollWidth, clientW: at.clientWidth });
      }
      out.codeWrap = [];
      for (const n of p.querySelectorAll('.hp-code')) {
        const rg = document.createRange(); rg.selectNodeContents(n);
        const tops = new Set([...rg.getClientRects()].map((q) => Math.round(q.top)));
        if (tops.size > 1) out.codeWrap.push(n.textContent);
      }
      return out;
    })()`);

    const matrixShot = async (file, label, { expectSize } = {}) => {
      await sleep(1100); // the NOW fit runs on the next frame
      // The arm rule fades a group (.yield) while an arm is near it. The reviewer needs a frame where the panel is shown, so
      // (1) sample how often the host group is faded over 3 s (that ratio is itself a finding: a panel that is faded most of
      // the time is effectively hidden), then (2) wait up to 8 s for a frame where it is not, and shoot that one.
      const yieldNow = () => r(`(() => { const g = document.getElementById('hud-panel').closest('.hud-group'); return !!(g && g.classList.contains('yield')); })()`);
      let ys = 0; const N = 15;
      for (let i = 0; i < N; i++) { if (await yieldNow()) ys++; await sleep(200); }
      let waited = 0;
      while ((await yieldNow()) && waited < 8000) { await sleep(250); waited += 250; }
      await sleep(350); // the fade-in transition
      const pr = await probe(label);
      pr.yieldRatio = Math.round((ys / N) * 100) / 100;
      pr.yieldWaitedMs = waited;
      result.probes.push(pr);
      await shot(file);
      if (pr.visible && pr.yielded) {
        pauseDrain = true; await drainIdle(); // the forced fade would put an invisible panel in the arm-clearance count
        // Still arm-faded after the wait: keep that shot as the as-shipped evidence, and add a -forced twin with the fade
        // overridden (test-only CSS, removed again) so the reviewer can still judge the panel's own look.
        const key = await page.insertCSS('#hud .hud-group.yield { opacity: 1 !important; transition: none !important; }');
        await sleep(500);
        await shot(file.replace(/\.png$/, '-forced.png'));
        await page.removeInsertedCSS(key);
        await r(`window.__zumiHud.session.hits.length = 0`); // drop whatever the forced (not really shown) panel collected
        pauseDrain = false;
      }
      check(`${label}: panel visible`, pr.visible, pr.visible ? undefined : pr);
      if (pr.visible) check(`${label}: shot taken with the panel shown (not arm-faded)`, !pr.yielded, { yieldRatio: pr.yieldRatio, waitedMs: pr.yieldWaitedMs });
      if (!pr.visible) return pr;
      // 'full-or-fit': the small window cannot hold the full panel in its group, so compact is the right answer there; what
      // must never happen is a FULL panel that is cut.
      if (expectSize === 'full-or-fit') check(`${label}: compact, or full and whole inside its group`, pr.size === 'compact' || (pr.size === 'full' && pr.groupCut && !pr.groupCut.cut), { size: pr.size, groupCut: pr.groupCut });
      else if (expectSize) check(`${label}: ${expectSize} state`, pr.size === expectSize, { got: pr.size });
      check(`${label}: frame and fill span the whole panel (not the 12 px bracket size)`, pr.frameOk && pr.frame.afterAlpha > 0, pr.frame);
      check(`${label}: log time column does not overlap the state`, pr.lnOverlap.length === 0, pr.lnOverlap.slice(0, 3));
      check(`${label}: task code does not wrap`, pr.codeWrap.length === 0, pr.codeWrap);
      check(`${label}: rect inside the window`, pr.inWindow, pr.rect);
      check(`${label}: not cut by its own group (no clipped content)`, !pr.groupCut || !pr.groupCut.cut, pr.groupCut);
      check(`${label}: no overlap with #say-line / #heard / #talk / another visible group`, pr.overlaps.length === 0, pr.overlaps);
      check(`${label}: NOW line ends whole or with an ellipsis after a whole word`, pr.nowOk !== false);
      if (pr.logLastInside !== null) check(`${label}: log last line inside its window`, pr.logLastInside, { rows: pr.logRows });
      return pr;
    };

    // ================= nits: the 0.2.8 HUD state-column fix (53adf7d), a short visual re-check =================
    // 1. T3 log: the state column fits the longest label ("đang làm", "waiting") in the full panel and the compact strip.
    // 2. A crowded in-place left group (5 update rows): the full panel stays full at default and large (at small it may
    //    fall back to the strip). "Task updates" may shrink to its header when full (plan-accepted), so no row count is asserted.
    if (MODE === 'nits') {
      const nitProbe = () => r(`(() => {
        const p = document.getElementById('hud-panel');
        const tg = [...p.querySelectorAll('.hp-ln .tg')].map((n) => ({ text: n.textContent, scrollW: n.scrollWidth, clientW: n.clientWidth, ell: n.textContent.endsWith('…') }));
        const list = document.getElementById('hud-updates'); const card = list.closest('.hud-updates');
        const rows = [...list.children].filter((li) => !li.classList.contains('empty'));
        const cb = card.getBoundingClientRect();
        const whole = rows.filter((li) => { const b = li.getBoundingClientRect(); return !li.hidden && b.height > 0 && b.top >= cb.top - 1 && b.bottom <= cb.bottom + 1; });
        return { size: p.dataset.size, design: p.dataset.design, tg, rows: rows.length, wholeRows: whole.length, rowH: rows.map((li) => Math.round(li.getBoundingClientRect().height)), cardH: Math.round(cb.height), headH: Math.round(card.querySelector('.hud-head').getBoundingClientRect().height) };
      })()`);
      const tgCheck = (label, np, expect) => {
        check(`${label}: every log state label is whole (no ellipsis, not cut)`, np.tg.length > 0 && np.tg.every((x) => !x.ell && x.scrollW <= x.clientW), np.tg);
        for (const w of expect) check(`${label}: state label "${w}" shows in full`, np.tg.some((x) => x.text === w && !x.ell && x.scrollW <= x.clientW), np.tg.map((x) => x.text));
      };
      const logShot = async (lang, sn, w, h, file, expect, expectSize) => {
        await setSize(sn, w, h);
        await pick('hud-panel-design', 't3'); await pick('hud-panel-place', 'inplace');
        const pr = await matrixShot(file, `nit1 ${lang} ${sn} t3`, { expectSize });
        tgCheck(`nit1 ${lang} ${sn} t3`, await nitProbe(), expect);
        return pr;
      };
      const setLang = async (l) => { await r(`document.querySelector('#lang-switch button[data-lang="${l}"]').click()`); await sleep(2500); };
      // qc stays todo for the whole nits run: a waiting step before a done step breaks the board rule waiting_before_done.
      board.update('T-31', 'qc', { state: 'todo' });
      await sleep(1500);
      // 1) T3 log, EN then VI, default and small. Newest log row = "hud -> active".
      board.update('T-31', 'hud', { state: 'waiting' });
      await sleep(2500);
      board.update('T-31', 'hud', { state: 'active', sub: 'T1 card, T2 steps, T3 log (62%)' });
      await sleep(5000);
      await logShot('en', 'default', 1280, 800, 'nit1-t3-default-en.png', ['doing'], 'full');
      await logShot('en', 'small', 900, 600, 'nit1-t3-small-en.png', ['doing'], 'full-or-fit');
      await logShot('en', 'large', 1920, 1080, 'nit1-t3-large-en.png', ['waiting', 'doing'], 'full');
      await setLang('vi');
      await logShot('vi', 'default', 1280, 800, 'nit1-t3-default-vi.png', ['đang làm'], 'full');
      await logShot('vi', 'small', 900, 600, 'nit1-t3-small-vi.png', ['đang làm'], 'full-or-fit');
      await logShot('vi', 'large', 1920, 1080, 'nit1-t3-large-vi.png', ['chờ', 'đang làm'], 'full');
      // newest log row = "hud -> waiting" (the chart step keeps T-31 working), so the small strip shows the waiting label
      board.update('T-31', 'hud', { state: 'waiting' });
      await sleep(5000);
      await logShot('vi', 'default', 1280, 800, 'nit1-t3-default-waiting-vi.png', ['chờ'], 'full');
      await logShot('vi', 'small', 900, 600, 'nit1-t3-small-waiting-vi.png', ['chờ'], 'full-or-fit');
      await setLang('en');
      await logShot('en', 'default', 1280, 800, 'nit1-t3-default-waiting-en.png', ['waiting'], 'full');
      await logShot('en', 'small', 900, 600, 'nit1-t3-small-waiting-en.png', ['waiting'], 'full-or-fit');
      board.update('T-31', 'hud', { state: 'active', sub: 'T1 card, T2 steps, T3 log (62%)' });
      await sleep(3000);
      // 2) crowded left group: 6 open tasks -> the feed's 5 update rows; T-31 made most recent again so the panel follows it.
      for (const [id, title] of [['X-11', 'Crowd filler one: a long enough title to wrap in the card'], ['X-12', 'Crowd filler two: another long title for the left group']]) {
        board.addTask(id, { title, status: 'doing', lane: 'Pi', steps: [{ id: 's1', label: 'A running step with a label of some length', zone: 'build', state: 'active' }] });
      }
      board.update('T-31', 'hud', { state: 'waiting' }); await sleep(2500);
      board.update('T-31', 'hud', { state: 'active', sub: 'T1 card, T2 steps, T3 log (62%)' });
      await sleep(5000);
      await setSize('default', 1280, 800);
      for (const [sn, w, h] of SIZES) {
        await setSize(sn, w, h);
        for (const d of DESIGNS) {
          await pick('hud-panel-design', d); await pick('hud-panel-place', 'inplace');
          const label = `nit2 crowded ${sn} ${d}`;
          await matrixShot(`nit2-crowded-${d}-${sn}-en.png`, label, { expectSize: sn === 'small' ? 'full-or-fit' : 'full' });
          const np = await nitProbe();
          result.probes.push({ label: `${label} updates`, ...np, tg: undefined });
          check(`${label}: left group is crowded (5 update rows)`, np.rows === 5, { rows: np.rows });
        }
      }
      pauseDrain = true; await drainIdle(); clearInterval(drainTimer);
      check('console: no error-level message from the renderer', !result.errors.some((l) => /^\[error\]/.test(l)), result.errors.filter((l) => /^\[error\]/.test(l)).slice(0, 5));
      check('opened: nothing was opened', opened.length === 0, opened);
      clearTimeout(timer);
      return finish(result.checks.every((c) => c.ok) ? 0 : 1);
    }

    // ---- the settings selects: every option of both, saved + painted, no reload ----
    const opts = await r(`({ design: [...document.getElementById('hud-panel-design').options].map((o) => o.value), place: [...document.getElementById('hud-panel-place').options].map((o) => o.value) })`);
    check('selects: design options are none / t1 / t2 / t3', JSON.stringify(opts.design) === JSON.stringify(['none', 't1', 't2', 't3']), opts.design);
    check('selects: the place select offers in place only (the below places are gone)', JSON.stringify(opts.place) === JSON.stringify(['inplace']), opts.place);
    await setSize('default', 1280, 800);
    for (const d of opts.design) {
      await pick('hud-panel-design', d); await sleep(900);
      const st = await r(`(() => { const p = document.getElementById('hud-panel'); return { stored: JSON.parse(localStorage.getItem('zumi.hud.panel') || '{}'), value: document.getElementById('hud-panel-design').value, hidden: p.hidden, design: p.dataset.design || '' }; })()`);
      check(`selects: design ${d} is saved, shown in the select and ${d === 'none' ? 'hides' : 'paints'} the panel`, st.stored.design === d && st.value === d && (d === 'none' ? st.hidden : (!st.hidden && st.design === d)), st);
    }
    for (const pl of opts.place) {
      await pick('hud-panel-design', 't1'); await pick('hud-panel-place', pl); await sleep(900);
      const st = await r(`(() => { const p = document.getElementById('hud-panel'); const h = p.closest('.hud-group'); return { stored: JSON.parse(localStorage.getItem('zumi.hud.panel') || '{}'), value: document.getElementById('hud-panel-place').value, host: h ? (h.classList.contains('hud-below') ? 'below:' + h.dataset.place : 'left') : '' }; })()`);
      check(`selects: place ${pl} is saved and moves the panel to ${pl === 'inplace' ? 'the left group' : 'its below group'}`, st.stored.place === pl && st.value === pl && st.host === (pl === 'inplace' ? 'left' : `below:${pl}`), st);
    }

    // ---- design x place x size, T-31 running (expanded in place) ----
    for (const [sn, w, h] of SIZES) {
      await setSize(sn, w, h);
      for (const d of DESIGNS) for (const pl of PLACES) {
        await pick('hud-panel-design', d); await pick('hud-panel-place', pl);
        const suffix = sn === 'default' ? '' : `-${sn}`;
        await matrixShot(`panel-${d}-${pl}${suffix}-en.png`, `${sn} ${d} ${pl}`, { expectSize: sn === 'small' ? 'full-or-fit' : 'full' });
      }
    }
    // design none: no panel rect at all (default size, both an in-place and a below place)
    await setSize('default', 1280, 800);
    for (const pl of ['inplace']) {
      await pick('hud-panel-place', pl); await pick('hud-panel-design', 'none'); await sleep(900);
      const pr = await probe(`none ${pl}`);
      check(`none ${pl}: adds no panel rect`, !pr.visible && await r(`document.querySelector('#hud .hud-below') ? document.querySelector('#hud .hud-below').hidden : true`), pr);
    }
    await pick('hud-panel-place', 'inplace'); await sleep(500);
    await shot('panel-none-inplace-en.png');

    // ---- Vietnamese at the default size: chrome strings switch with no reload, strings fit ----
    const enLabel = await r(`document.querySelector('label[for="hud-panel-design"]').textContent`);
    await r(`document.querySelector('#lang-switch button[data-lang="vi"]').click()`);
    await sleep(2500);
    const viLabel = await r(`document.querySelector('label[for="hud-panel-design"]').textContent`);
    check('vi: switching uiLang changes settings.hudPanel with no reload', enLabel !== viLabel && /Bảng task/i.test(viLabel), { enLabel, viLabel });
    for (const d of DESIGNS) for (const pl of PLACES) {
      await pick('hud-panel-design', d); await pick('hud-panel-place', pl);
      const pr = await matrixShot(`panel-${d}-${pl}-vi.png`, `vi default ${d} ${pl}`, { expectSize: 'full' });
      if (d === 't1' && pr && pr.visible) check(`vi default ${d} ${pl}: T1 tag painted`, pr.tag.length > 0, pr.tag);
    }
    await r(`document.querySelector('#lang-switch button[data-lang="en"]').click()`);
    await sleep(1500);

    // ---- in place, compact: finish every running step of T-31 so nothing is "working" ----
    await pick('hud-panel-place', 'inplace');
    board.update('T-31', 'hud', { state: 'done' });
    board.update('T-31', 'chart', { state: 'done' });
    await sleep(14000); // two polls + past the 8 s reaction window
    for (const [sn, w, h] of SIZES) {
      await setSize(sn, w, h);
      for (const d of DESIGNS) {
        await pick('hud-panel-design', d);
        const suffix = sn === 'default' ? '' : `-${sn}`;
        await matrixShot(`panel-${d}-inplace-compact${suffix}-en.png`, `${sn} ${d} inplace compact`, { expectSize: 'compact' });
      }
    }
    // ---- and expanded again after the next board update makes a step active ----
    await setSize('default', 1280, 800);
    board.update('T-31', 'hud', { state: 'active', sub: 'T1 card, T2 steps, T3 log (62%)' });
    await sleep(5000);
    await pick('hud-panel-design', 't1');
    const again = await matrixShot('panel-t1-inplace-expanded-again-en.png', 'default t1 inplace after an update', { expectSize: 'full' });
    check('inplace: compact while idle, expanded after a board update makes a step active', again && again.size === 'full');

    // ---- HUD style B (curved arc panels) with the new panel: the left group is shorter and tilted, so a full panel may not fit
    // and must then fall back to compact; both are fine, a cut full panel is not. Same three sizes, board step active. ----
    await pick('hud-panel-place', 'inplace');
    await pickStyle('b'); await feedReady(); await sleep(1500);
    board.update('T-31', 'hud', { state: 'active', sub: 'T1 card, T2 steps, T3 log (62%)' });
    await sleep(4000);
    for (const [sn, w, h] of SIZES) {
      await setSize(sn, w, h);
      for (const d of DESIGNS) {
        await pick('hud-panel-design', d);
        await matrixShot(`panel-${d}-inplace-styleb${sn === 'default' ? '' : `-${sn}`}-en.png`, `style-b ${sn} ${d} inplace`, { expectSize: 'full-or-fit' });
      }
    }
    await pickStyle('a'); await feedReady(); await sleep(1000);

    // ---- the arm rule over the whole run (the existing clearance probe) ----
    pauseDrain = true; await drainIdle(); clearInterval(drainTimer);
    const session = await r(`({ frames: window.__zumiHud.session.frames, hits: window.__zumiHud.session.hits.splice(0) })`);
    allHits.push(...session.hits);
    result.sessionClearance = { frames: session.frames, hits: allHits.slice(0, 40), total: allHits.length, saturatedDrains };
    check('clearance: whole run (all designs, both HUD styles, in place): 0 arm hits on a non-yielded panel; the in-app 40-hit cap is drained every 250 ms so the whole run is counted', session.frames > 300 && allHits.length === 0 && saturatedDrains === 0, { frames: session.frames, total: allHits.length, saturatedDrains, hits: allHits.slice(0, 6) });
    check('console: no error-level message from the renderer', !result.errors.some((l) => /^\[error\]/.test(l)), result.errors.filter((l) => /^\[error\]/.test(l)).slice(0, 5));
    check('opened: nothing was opened', opened.length === 0, opened);

    clearTimeout(timer);
    await finish(result.checks.every((c) => c.ok) ? 0 : 1);
  } catch (e) {
    result.errors.push(String((e && e.stack) || e));
    console.log(`ERROR ${e && e.message}`);
    clearTimeout(timer);
    await finish(2);
  }
});
