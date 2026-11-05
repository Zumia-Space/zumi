#!/usr/bin/env node
// Theme smoke shots (T-31 alpha.3 R1): the three whole themes (blue, black, white) of the SHELL, the HUD cards over the stage, Brain and
// Settings at 1366x768, in headless Chromium. Same harness as scripts/check-brain.mjs (a SCRATCH copy of the renderer built with ZUMI_NEXT_UI=1,
// served over loopback, a stub of the preload bridge, the Brain board fixture); no Tauri/Electron app is started and nothing touches the network.
//   node scripts/shot-themes.mjs --out <dir>
// Writes <theme>-<view>.png (views: shell, hud, hud-devices, brain, settings) and theme-switch.log: the Settings select flips data-theme + the dark
// class, the pick survives a reload (localStorage zumi.theme), an unknown stored value falls back to blue, and an open Board webview is reloaded
// with #theme=.
// Playwright: $ZUMI_PLAYWRIGHT_DIR; Chromium: $ZUMI_CHROMIUM (same defaults as check-brain.mjs).
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const sharp = createRequire(import.meta.url)('sharp'); // from the junctioned node_modules (the same one the harness's playwright lives in)
import { ownerPath } from './lib/owner-paths.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PW = process.env.ZUMI_PLAYWRIGHT_DIR || ownerPath('playwrightDir', 'node_modules/playwright');
const EXE = process.env.ZUMI_CHROMIUM || ownerPath('chromiumExe', 'local/chrome.exe');
const args = process.argv.slice(2);
if (!args.includes('--out')) { console.error('usage: node scripts/shot-themes.mjs --out <dir>'); process.exit(2); }
const outDir = path.resolve(args[args.indexOf('--out') + 1]);
const SCRATCH = `${ownerPath('scratchRoot', os.tmpdir())}/shot-themes-${process.pid}`;
const VIEWPORT = { width: 1366, height: 768 };
// --baseline: a tree from before R1 (no theme.js, no data-theme): blue shots only and no theme assertions, to pixel-compare 'blue = today's look'.
const BASELINE = args.includes('--baseline');
// --links-set: the host answers links.list() with donate + discord set (the owner build since af759ff4): both buttons must be enabled.
const LINKS_SET = args.includes('--links-set');
const THEMES = BASELINE ? ['blue'] : ['blue', 'black', 'white'];
const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'fixtures', 'brain-board-state.json'), 'utf8'));
/** Mean blue cast (b - max(r,g), 0..255) over the pixels of each HUD pill on the current page, read from a real screenshot (what the owner sees,
 *  not a computed value). A neutral theme has ~0; a blue-tinted pill is well above 4. Also the mean chroma (max - min of r,g,b), which sees any tint (blue's cyan has a small b - max(r,g) but a large chroma). Returns [{ text, cast, chroma }]. */
async function hudPillCast(page) {
  const boxes = await page.evaluate(() => [...document.querySelectorAll('.hud .hud-panel, .hud-task-panel, .hud-item')]
    .filter((e) => { const b = e.getBoundingClientRect(); return b.width > 40 && b.height > 14 && e.getClientRects().length; })
    .map((e) => { const b = e.getBoundingClientRect(); return { text: e.textContent.trim().slice(0, 24), x: Math.floor(b.left), y: Math.floor(b.top), w: Math.ceil(b.width), h: Math.ceil(b.height) }; }));
  const png = await page.screenshot();
  const out = [];
  for (const b of boxes) {
    const { data, info } = await sharp(png).extract({ left: b.x, top: b.y, width: Math.min(b.w, VIEWPORT.width - b.x), height: Math.min(b.h, VIEWPORT.height - b.y) }).raw().toBuffer({ resolveWithObject: true });
    let sum = 0, chroma = 0, n = 0;
    for (let i = 0; i < data.length; i += info.channels) { sum += data[i + 2] - Math.max(data[i], data[i + 1]); chroma += Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2]); n++; }
    out.push({ text: b.text.replace(/\s+/g, ' '), cast: n ? sum / n : 0, chroma: n ? chroma / n : 0 });
  }
  return out;
}
const log = [];
const say = (line) => { log.push(line); console.log(line); };

function makeScratch() {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.mkdirSync(path.join(SCRATCH, 'scripts'), { recursive: true });
  for (const f of ['build-renderer.mjs', 'rig-version.mjs', 'seat-offset.mjs']) fs.copyFileSync(path.join(ROOT, 'scripts', f), path.join(SCRATCH, 'scripts', f));
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(SCRATCH, 'package.json'));
  fs.cpSync(path.join(ROOT, 'src', 'renderer'), path.join(SCRATCH, 'src', 'renderer'), { recursive: true });
  fs.mkdirSync(path.join(SCRATCH, 'src', 'main'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'src', 'main', 'providers.js'), path.join(SCRATCH, 'src', 'main', 'providers.js'));
  fs.cpSync(path.join(ROOT, 'src', 'next-tokens'), path.join(SCRATCH, 'src', 'next-tokens'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'vendor', 'laneboard', 'public'), path.join(SCRATCH, 'vendor', 'laneboard', 'public'), { recursive: true });
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(SCRATCH, 'node_modules'), 'junction');
}

// ---- copied from scripts/check-brain.mjs (serve, stubScript, pageFor) ----
function serve(buildDir) {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = p === '/tokens.css' ? path.join(ROOT, 'vendor', 'laneboard', 'public', 'tokens.css') : path.join(buildDir, p === '/' ? 'index.html' : p);
    if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (p !== '/tokens.css' && !path.resolve(file).startsWith(path.resolve(buildDir))) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (e, buf) => {
      if (e) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' }); res.end(buf);
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

// A stand-in for the preload bridge. window.__cfg: { board: <what board.state answers>, memory: <fixture> | undefined }. `memory` is
// NOT answered by the catch-all proxy: absent means absent (the Electron build), so feature detection sees the truth.
// A fixture window.zumi.memory (the Tauri host's API, PLAN-MEMORY section 4) for the memory list tests: 120 items, newest first, 60 notes and

function stubScript() {
  const info = { version: '0.0.0-check', packaged: true, disabledViews: [], ownerAdmin: false, boardPartition: 'persist:check', demo: false, selftest: false };
  return `(() => {
    const deep = () => new Proxy(function () {}, { get: (t, k) => (k === 'then' ? undefined : k === Symbol.toPrimitive ? () => '' : deep()), apply: () => Promise.resolve(deep()) });
    const withFallback = (o) => new Proxy(o, { get: (t, k) => (k in t ? t[k] : (k === 'then' || k === 'memory' ? undefined : deep())) });
    window.__cfg = window.__cfg || { board: { ok: false, reason: 'unconfigured' } };
    window.__calls = [];
    const board = withFallback({ state: async () => { window.__calls.push('board.state'); return window.__cfg.board; }, status: async () => ({ configured: false, mode: 'local' }) });
    const base = { info: async () => (${JSON.stringify(info)}), listModels: async () => ({ models: [], selected: null }), listClips: async () => [],
      rooms: withFallback({ list: async () => ({ rooms: [], geometry: null }) }), scenes: withFallback({ list: async () => ({ rooms: [], geometry: null, selected: null }) }),
      chairs: withFallback({ list: async () => ({ chairs: [], selected: null }) }), wardrobe: withFallback({ canUndo: async () => false }), ui: withFallback({ getLang: async () => 'en', setLang: async () => {} }),
      openBoard: async () => ({ url: 'http://127.0.0.1:9/', origin: 'http://127.0.0.1:9', dataDir: 'x' }), board,
      links: { list: async () => ({ discord: ${LINKS_SET}, upgrade: false, donate: ${LINKS_SET} }), open: async (id) => { window.__opened = (window.__opened || []).concat(id); return true; } } }; // the shipped links.mjs: every URL empty
    window.zumi = withFallback(base);
    if (window.__cfg.memory) window.zumi.memory = window.__cfg.memory;
    // <webview> is an Electron element: in plain Chromium it is a bare HTMLElement, so give it what app.js and Brain use of it (loadURL, dom-ready).
    window.__loads = [];
    HTMLElement.prototype.loadURL = function (u) { window.__loads.push(u); return Promise.resolve(); };
    new MutationObserver(() => { for (const w of document.querySelectorAll('#board-host webview')) w.dataset.domReady = '1'; }).observe(document, { childList: true, subtree: true });
  })();`;
}

async function pageFor(browser, server, cfg, opts = {}) {
  const page = await browser.newPage({ viewport: opts.viewport || { width: 1296, height: 839 } });
  const bad = [];
  page.on('pageerror', (e) => bad.push(`pageerror: ${String(e.message).split('\n')[0]}`));
  page.on('console', (m) => { if (m.type() === 'error') bad.push(`console: ${m.text().split('\n')[0]}`); });
  page.on('response', (r) => { if (r.status() >= 400) bad.push(`http ${r.status()}: ${r.url()}`); });
  await page.addInitScript(`window.__cfg = ${JSON.stringify(cfg)};`);
  if (opts.memoryFixture) await page.addInitScript(opts.memoryFixture);
  await page.addInitScript(stubScript());
  if (opts.reduce) await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.getElementById('app-version') && document.getElementById('app-version').textContent.startsWith('v0.0.0'), null, { timeout: 20000 });
  await page.waitForSelector('.tab[data-next="brain"]', { timeout: 20000 });
  return { page, bad };
}

// The junction goes first, so removing the scratch never walks into the real node_modules.
const removeScratch = (dir) => {
  try { fs.unlinkSync(path.join(dir, 'node_modules')); } catch { /* none */ }
  fs.rmSync(dir, { recursive: true, force: true });
};

makeScratch();
let browser, server;
let failed = 0;
const check = (cond, name, detail = '') => { say(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : ' ' + detail}`); if (!cond) failed++; };
const ready = async (page) => {
  await page.waitForFunction(() => document.getElementById('app-version') && document.getElementById('app-version').textContent.startsWith('v0.0.0'), null, { timeout: 20000 });
  await page.waitForSelector('.tab[data-next="brain"]', { timeout: 20000 });
};
try {
  execFileSync(process.execPath, [path.join(SCRATCH, 'scripts', 'build-renderer.mjs')], { cwd: SCRATCH, env: { ...process.env, ZUMI_NEXT_UI: '1' }, encoding: 'utf8' });
  fs.mkdirSync(outDir, { recursive: true });
  const { chromium } = createRequire(import.meta.url)(PW);
  browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'], timeout: 60000 });
  server = await serve(path.join(SCRATCH, 'build', 'renderer'));
  const full = { ok: true, state: fixture };
  const shot = (page, name) => page.screenshot({ path: path.join(outDir, `${name}.png`) });

  for (const theme of THEMES) {
    const { page, bad } = await pageFor(browser, server, { board: full }, { viewport: VIEWPORT });
    if (!BASELINE) await page.evaluate((t) => localStorage.setItem('zumi.theme', t), theme);
    await page.reload({ waitUntil: 'load' });
    await ready(page);
    await page.waitForTimeout(1200);
    const state = BASELINE ? null : await page.evaluate(() => ({ theme: document.documentElement.dataset.theme, dark: document.documentElement.classList.contains('dark'), bg: getComputedStyle(document.body).backgroundColor, scheme: getComputedStyle(document.documentElement).colorScheme }));
    if (state) check(state.theme === theme && state.dark === (theme !== 'white'), `${theme}: <html data-theme="${theme}"> and class dark ${theme !== 'white' ? 'kept' : 'removed'}`, JSON.stringify(state));
    if (state) say(`  ${theme}: body background ${state.bg}, color-scheme ${state.scheme}`);
    await shot(page, `${theme}-shell`);
    const pills = await hudPillCast(page);
    say(`  ${theme}: HUD pill mean blue cast (b - max(r,g)): ${pills.map((x) => `${x.text || '(icon)'} cast ${x.cast.toFixed(1)} chroma ${x.chroma.toFixed(1)}`).join(', ')}`);
    if (theme === 'blue') check(pills.length > 0 && pills.every((x) => x.chroma > 20), 'blue: the HUD pills are tinted (control: the probe can see a tint, mean chroma > 20)', JSON.stringify(pills));
    else check(pills.length > 0 && pills.every((x) => x.cast <= 4 && x.chroma <= 8), `${theme}: the HUD pills have no blue cast (mean b - max(r,g) <= 4, mean chroma <= 8)`, JSON.stringify(pills));
    // HUD: the cards over the Zumi stage (Skills, Devices: the next-UI HUD groups)
    await page.click('.tab[data-next="skills"]'); await page.waitForTimeout(600);
    await shot(page, `${theme}-hud`);
    await page.click('.tab[data-next="devices"]'); await page.waitForTimeout(400);
    await shot(page, `${theme}-hud-devices`);
    await page.click('.tab[data-next="brain"]'); await page.click('.nb-tab[data-tab="tasks"]'); await page.waitForSelector('.nb-row', { timeout: 5000 });
    await page.click('.nb-row[data-task="T-31"]'); await page.waitForTimeout(500);
    await shot(page, `${theme}-brain`);
    // alpha.4 item 1 (anh 30-10): Pricing is a full page on the theme background. While it is open the
    // avatar canvas, the room plate, the HUD, the stage toolbar and the composer are hidden; closing it restores the stage exactly as it was.
    if (!BASELINE) {
      const probe = () => page.evaluate(() => {
        const panel = document.getElementById('tab-zumi');
        const vis = (e) => (e ? getComputedStyle(e).visibility : 'missing');
        const c = document.getElementById('stage-canvas'), s = document.getElementById('stage').getBoundingClientRect();
        return { canvas: vis(c), plate: vis(document.getElementById('stage-plate')), hud: vis(document.getElementById('hud')), header: vis(panel.querySelector(':scope > header')),
          composer: vis(panel.querySelector(':scope > .composer')), size: `${c.width}x${c.height}`, stage: `${Math.round(s.width)}x${Math.round(s.height)}@${Math.round(s.left)},${Math.round(s.top)}` };
      });
      await page.click('.tab[data-tab="zumi"]'); await page.waitForTimeout(400);
      const before = await probe();
      const item = await page.$('.tab[data-next="pricing"]');
      check(Boolean(item), `${theme}: the Pricing rail item exists`);
      if (item) {
        await item.click(); await page.waitForTimeout(500);
        const open = await probe();
        const page2 = await page.evaluate(() => {
          const panel = document.getElementById('tab-zumi'), card = document.getElementById('next-pricing');
          const p = panel.getBoundingClientRect(), r = card.getBoundingClientRect();
          const donate = card.querySelector('[data-link="donate"]');
          return { full: Math.abs(r.left - p.left) < 1 && Math.abs(r.right - p.right) < 1 && Math.abs(r.top - p.top) < 1 && Math.abs(r.bottom - p.bottom) < 1,
            rect: `${Math.round(r.width)}x${Math.round(r.height)} in ${Math.round(p.width)}x${Math.round(p.height)}`, cardBg: getComputedStyle(card).backgroundColor, bodyBg: getComputedStyle(document.body).backgroundColor,
            donate: donate ? { shown: donate.getClientRects().length > 0, disabled: donate.disabled, text: donate.textContent.trim() } : null };
        });
        check(['canvas', 'plate', 'hud', 'header', 'composer'].every((k) => open[k] === 'hidden'), `${theme}: Pricing open -> avatar canvas, room plate, HUD, stage toolbar and composer hidden`, JSON.stringify(open));
        check(page2.full, `${theme}: the Pricing page fills the whole Zumi panel`, page2.rect);
        check(page2.cardBg === page2.bodyBg, `${theme}: the Pricing page background is the theme background (${page2.bodyBg})`, page2.cardBg);
        if (LINKS_SET) {
          check(page2.donate && page2.donate.shown && !page2.donate.disabled && page2.donate.text === 'Donate', `${theme}: links set -> Donate shown and enabled`, JSON.stringify(page2.donate));
          await page.click('#next-pricing [data-link="donate"]');
          check((await page.evaluate(() => window.__opened || [])).includes('donate'), `${theme}: a Donate click asks the host to open "donate" (id only)`);
        } else check(page2.donate && page2.donate.shown && page2.donate.disabled && /Coming soon/.test(page2.donate.text), `${theme}: Donate is shown, disabled, "Coming soon" while its link is empty`, JSON.stringify(page2.donate));
        await shot(page, `${theme}-pricing`);
        await page.click('.tab[data-tab="zumi"]'); await page.waitForTimeout(400);
        const after = await probe();
        check(JSON.stringify(after) === JSON.stringify(before), `${theme}: closing Pricing restores the stage exactly (visibility, canvas size, stage box)`, `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
      }
    }
    await page.click('.tab[data-tab="settings"]'); await page.click('#stab-app'); await page.waitForTimeout(400);
    if (!BASELINE) {
      const d = await page.evaluate(() => { const row = document.getElementById('join-discord-row'), b = document.getElementById('join-discord'); return { shown: Boolean(row) && !row.hidden && row.getClientRects().length > 0, disabled: b && b.disabled, text: b && b.textContent.trim() }; });
      if (LINKS_SET) check(d.shown && !d.disabled && d.text === 'Join Discord', `${theme}: links set -> Join Discord shown and enabled`, JSON.stringify(d));
      else check(d.shown && d.disabled && d.text === 'Coming soon', `${theme}: Settings > App shows the Discord row, its button disabled "Coming soon" while the link is empty`, JSON.stringify(d));
    }
    await shot(page, `${theme}-settings`);
    check(bad.length === 0, `${theme}: no console error, page error or failed request`, bad.slice(0, 3).join(' | '));
    await page.close();
  }

  if (!BASELINE) // the setting itself: flips the theme live, survives a reload, a stale value is ignored, an open Board webview is reloaded with #theme=
  {
    const { page, bad } = await pageFor(browser, server, { board: full }, { viewport: VIEWPORT });
    await page.click('.tab[data-tab="board"]');
    await page.waitForSelector('#board-host webview', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(800);
    const opened = await page.evaluate(() => { const w = document.querySelector('#board-host webview'); return w ? w.getAttribute('src') : null; });
    check(opened && new URL(opened).hash === '#theme=dark', 'default theme: the Board webview opens with #theme=dark', String(opened));
    await page.click('.tab[data-tab="settings"]'); await page.click('#stab-app');
    const opts = await page.$$eval('#theme-select option', (o) => o.map((x) => `${x.value}:${x.textContent}`));
    check(opts.join() === 'blue:Blue,black:Black,white:White', 'Settings > App > Appearance: the select offers Blue, Black, White', opts.join());
    const rows = await page.evaluate(() => ({ inApp: document.getElementById('appearance-card').closest('#stabpanel-app') !== null, head: document.querySelector('#appearance-card h2').textContent }));
    check(rows.inApp && rows.head === 'Appearance', 'the card is in the App panel, titled Appearance', JSON.stringify(rows));
    await page.selectOption('#theme-select', 'white');
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => ({ theme: document.documentElement.dataset.theme, dark: document.documentElement.classList.contains('dark'), ls: localStorage.getItem('zumi.theme'), loads: window.__loads.slice() }));
    check(after.theme === 'white' && !after.dark && after.ls === 'white', 'select -> white: data-theme=white, dark class removed, zumi.theme saved', JSON.stringify(after));
    const reload = after.loads.map((u) => new URL(u)).find((u) => u.hash.includes('theme=light'));
    check(Boolean(reload) && reload.searchParams.has('r') && reload.searchParams.get('embed') === '1', 'select -> white: the open Board webview was reloaded with ?r= and #theme=light', after.loads.join(' '));
    await page.selectOption('#theme-select', 'black'); await page.waitForTimeout(200);
    const black = await page.evaluate(() => ({ dark: document.documentElement.classList.contains('dark'), loads: window.__loads.slice(-1) }));
    check(black.dark && new URL(black.loads[0]).hash.includes('theme=dark'), 'select -> black: dark class back, the Board reloaded with #theme=dark', JSON.stringify(black));
    await page.selectOption('#theme-select', 'white'); await page.waitForTimeout(100);
    await page.reload({ waitUntil: 'load' });
    await ready(page);
    const kept = await page.evaluate(() => ({ theme: document.documentElement.dataset.theme, dark: document.documentElement.classList.contains('dark') }));
    check(kept.theme === 'white' && !kept.dark, 'restart (reload): the white pick is applied again', JSON.stringify(kept));
    await page.evaluate(() => localStorage.setItem('zumi.theme', 'neon'));
    await page.reload({ waitUntil: 'load' });
    await ready(page);
    const stale = await page.evaluate(() => ({ theme: document.documentElement.dataset.theme, dark: document.documentElement.classList.contains('dark') }));
    check(stale.theme === 'blue' && stale.dark, 'a stale / unknown zumi.theme value is ignored (blue)', JSON.stringify(stale));
    check(bad.length === 0, 'theme switching: no console error, page error or failed request', bad.slice(0, 3).join(' | '));
    await page.close();
  }
} finally {
  if (browser) await browser.close();
  if (server) server.close();
  removeScratch(SCRATCH);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'theme-switch.log'), `${log.join('\n')}\n`);
}
console.log(failed ? `shot-themes: ${failed} FAILED` : 'shot-themes: OK');
process.exit(failed ? 1 : 0);
