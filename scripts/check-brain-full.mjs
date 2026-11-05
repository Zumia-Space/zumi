#!/usr/bin/env node
// R2 (T-31 alpha.3, owner 29-10):
// an open Brain task detail fills the stage edge to edge in two columns (task text left; step flow, structure and every plan open right),
// with no sideways scroll; Back and the Memory tab return to the narrow card. A new file, not an extension of check-brain.mjs: check:brain-host
// BH-11e freezes the existing check scripts (CoS decision A). Same harness as check-brain.mjs (ZUMI_NEXT_UI build of a SCRATCH copy of the
// renderer, a stub of the preload bridge, the board state fixture scripts/fixtures/brain-board-state.json); the stub has no model, so the
// "No model yet" panel sits under the full card and the arm-yield / collapse guard must leave a full card alone (boot.js).
//   node scripts/check-brain-full.mjs [--keep] [--shots <dir>]
// Playwright: $ZUMI_PLAYWRIGHT_DIR; Chromium: $ZUMI_CHROMIUM (same defaults as check-brain.mjs).
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ownerPath } from './lib/owner-paths.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PW = process.env.ZUMI_PLAYWRIGHT_DIR || ownerPath('playwrightDir', 'node_modules/playwright');
const EXE = process.env.ZUMI_CHROMIUM || ownerPath('chromiumExe', 'local/chrome.exe');
const args = process.argv.slice(2);
const keep = args.includes('--keep');
const shotsDir = args.includes('--shots') ? path.resolve(args[args.indexOf('--shots') + 1]) : null;
const fixtureFile = args.includes('--fixture') ? path.resolve(args[args.indexOf('--fixture') + 1]) : path.join(ROOT, 'scripts', 'fixtures', 'brain-board-state.json'); // a denser board for screenshots only
const SCRATCH = `${ownerPath('scratchRoot', os.tmpdir())}/brain-full-check-${process.pid}`;
let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); } };
const fixture = JSON.parse(fs.readFileSync(fixtureFile, 'utf8'));
const byId = (id) => fixture.tasks.find((t) => t.id === id);

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

// The preload stand-in of check-brain.mjs (board.state answers window.__cfg.board; no window.zumi.memory: the Electron build).
function stubScript() {
  const info = { version: '0.0.0-check', packaged: true, disabledViews: [], ownerAdmin: false, boardPartition: 'persist:check', demo: false, selftest: false };
  return `(() => {
    const deep = () => new Proxy(function () {}, { get: (t, k) => (k === 'then' ? undefined : k === Symbol.toPrimitive ? () => '' : deep()), apply: () => Promise.resolve(deep()) });
    const withFallback = (o) => new Proxy(o, { get: (t, k) => (k in t ? t[k] : (k === 'then' || k === 'memory' ? undefined : deep())) });
    window.__cfg = window.__cfg || { board: { ok: false, reason: 'unconfigured' } };
    const board = withFallback({ state: async () => window.__cfg.board, status: async () => ({ configured: false, mode: 'local' }) });
    const base = { info: async () => (${JSON.stringify(info)}), listModels: async () => ({ models: [], selected: null }), listClips: async () => [],
      rooms: withFallback({ list: async () => ({ rooms: [], geometry: null }) }), scenes: withFallback({ list: async () => ({ rooms: [], geometry: null, selected: null }) }),
      chairs: withFallback({ list: async () => ({ chairs: [], selected: null }) }), wardrobe: withFallback({ canUndo: async () => false }), ui: withFallback({ getLang: async () => 'en', setLang: async () => {} }),
      openBoard: async () => ({ url: 'http://127.0.0.1:9/', origin: 'http://127.0.0.1:9', dataDir: 'x' }), board };
    window.zumi = withFallback(base);
    HTMLElement.prototype.loadURL = function () { return Promise.resolve(); };
  })();`;
}

async function pageFor(browser, server, cfg, viewport) {
  const page = await browser.newPage({ viewport });
  const bad = [];
  page.on('pageerror', (e) => bad.push(`pageerror: ${String(e.message).split('\n')[0]}`));
  page.on('console', (m) => { if (m.type() === 'error') bad.push(`console: ${m.text().split('\n')[0]}`); });
  page.on('response', (r) => { if (r.status() >= 400) bad.push(`http ${r.status()}: ${r.url()}`); });
  await page.addInitScript(`window.__cfg = ${JSON.stringify(cfg)};`);
  await page.addInitScript(stubScript());
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.getElementById('app-version') && document.getElementById('app-version').textContent.startsWith('v0.0.0'), null, { timeout: 20000 });
  await page.waitForSelector('.tab[data-next="brain"]', { timeout: 20000 });
  return { page, bad };
}
const openBrain = async (page, tab) => { await page.click('.tab[data-next="brain"]'); if (tab) await page.click(`.nb-tab[data-tab="${tab}"]`); await page.waitForTimeout(250); };

// alpha.7 (owner QC 30-10: the diagram text is too small): each diagram has a Fullscreen button; the overlay fills the app window (not the OS
// screen), draws the same graph larger, follows the theme, and Esc or Close restores the panel exactly (tab, task, scroll, focus).
async function fullscreenPart(browser, server, full) {
  const viewport = { width: 1366, height: 768 };
  for (const theme of ['blue', 'white']) {
    const { page, bad } = await pageFor(browser, server, { board: full }, viewport);
    await page.evaluate((th) => { document.documentElement.dataset.theme = th; document.documentElement.classList.toggle('dark', th !== 'white'); }, theme); // what Settings > theme does (shot-themes.mjs)
    await openBrain(page, 'tasks');
    await page.waitForSelector('#next-brain .nb-row', { timeout: 5000 });
    await page.click('.nb-row[data-task="T-31"]'); await page.waitForTimeout(500);
    const probe = () => page.evaluate(() => {
      const c = document.getElementById('next-brain'), body = c.querySelector('.nb-body');
      const p = document.createElement('i'); p.style.background = 'var(--background)'; document.body.appendChild(p); const bg = getComputedStyle(p).backgroundColor; p.remove();
      const o = document.querySelector('.bd-full'), r = o && o.getBoundingClientRect(), sv = o && o.querySelector('svg.bd');
      const sr = sv && sv.getBoundingClientRect(), vb = sv && sv.viewBox.baseVal;
      return { overlay: Boolean(o), fixed: o ? getComputedStyle(o).position : null, rect: r ? [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] : null, win: [0, 0, innerWidth, innerHeight],
        bgOk: o ? getComputedStyle(o).backgroundColor === bg : null, bg, scale: sr && vb ? Math.min(sr.width / vb.width, sr.height / vb.height) : null, steps: o ? o.querySelectorAll('[data-step]').length : 0, nodes: o ? o.querySelectorAll('[data-node]').length : 0,
        tab: document.querySelector('.nb-tab.on').dataset.tab, task: c.querySelector('.nb-dhead').dataset.task, scrollTop: body.scrollTop, full: c.classList.contains('nx-brain-full'),
        panelSvgs: c.querySelectorAll('svg.bd').length, inCard: Boolean(o && c.contains(o)), focusBtn: document.activeElement && document.activeElement.className };
    });
    ok(await page.evaluate(() => document.querySelectorAll('#next-brain .bd-full-btn').length) === 2, `FS (${theme}): both diagrams (step flow, structure) have a Fullscreen button`);
    for (const kind of ['flow', 'structure']) {
      const idx = kind === 'flow' ? 0 : 1, sel = `#next-brain .nb-col-r .nb-sec:nth-of-type(${idx + 1}) .bd-full-btn`;
      await page.evaluate(() => { document.querySelector('#next-brain .nb-body').scrollTop = 40; });
      const sBefore = await page.evaluate((i) => { const sv = document.querySelectorAll('#next-brain svg.bd')[i], r = sv.getBoundingClientRect(); return r.width / sv.viewBox.baseVal.width; }, idx);
      const before = await probe();
      if (shotsDir && theme === 'blue' || shotsDir && theme === 'white' && kind === 'flow') { fs.mkdirSync(shotsDir, { recursive: true }); await page.evaluate((i) => document.querySelectorAll('#next-brain svg.bd')[i].scrollIntoView({ block: 'center' }), idx); await page.screenshot({ path: path.join(shotsDir, `fs-${kind}-before-${theme}.png`) }); await page.evaluate(() => { document.querySelector('#next-brain .nb-body').scrollTop = 40; }); }
      const btnFound = (await page.$(sel)) !== null;
      ok(btnFound, `FS (${theme}, ${kind}): the Fullscreen button sits in the ${kind} section`);
      if (!btnFound) continue;
      await page.focus(sel); // focus scrolls the button into view, as the user's own approach does; the scroll to compare is the one at the moment of the click
      const scrollBefore = await page.evaluate(() => document.querySelector('#next-brain .nb-body').scrollTop);
      await page.click(sel); await page.waitForTimeout(250);
      const on = await probe();
      ok(on.overlay && on.fixed === 'fixed' && JSON.stringify(on.rect) === JSON.stringify(on.win), `FS (${theme}, ${kind}): the overlay fills the app window exactly (position fixed, ${on.win.join('x')})`, JSON.stringify(on));
      ok(on.overlay && !on.inCard && on.bgOk === true && (theme === 'white') === (Number(on.bg.match(/\d+/)[0]) > 200), `FS (${theme}, ${kind}): the overlay follows the theme (background ${on.bg} = var(--background); light only under white)`, JSON.stringify(on));
      ok(on.scale > sBefore * 1.15 && (kind === 'flow' ? on.steps === 6 : on.nodes > 0), `FS (${theme}, ${kind}): the same graph is drawn larger (scale ${sBefore.toFixed(2)} -> ${on.scale && on.scale.toFixed(2)}; ${on.steps} steps, ${on.nodes} nodes)`, JSON.stringify(on));
      // The engine clamps labels to 2 short lines and cuts them with an ellipsis; fullscreen must show the whole text, inside its box, and the panel keeps the clamp.
      const want = kind === 'flow' ? byId('T-31').steps.map((x) => x.label) : byId('T-31').architecture.nodes.flatMap((x) => (x.sub ? [x.label, x.sub] : [x.label]));
      const txt = await page.evaluate((k) => {
        const o = document.querySelector('.bd-full'), norm = (x) => x.replace(/\s+/g, ' ').trim();
        const boxes = [...o.querySelectorAll('.bd-box')];
        const texts = boxes.flatMap((g) => [[...g.querySelectorAll('.bd-label')].map((e) => e.textContent).join(' '), [...g.querySelectorAll('.bd-sub')].map((e) => e.textContent).join(' ')]).map(norm).filter(Boolean);
        const outside = boxes.flatMap((g) => { const r = g.querySelector('rect').getBBox(); return [...g.querySelectorAll('text')].filter((e) => { const b = e.getBBox(); return b.x < r.x - 0.5 || b.y < r.y - 0.5 || b.x + b.width > r.x + r.width + 0.5 || b.y + b.height > r.y + r.height + 0.5; }).map((e) => e.textContent); });
        const panel = [...document.querySelectorAll('#next-brain svg.bd')][k === 'flow' ? 0 : 1];
        return { ellipsis: [...o.querySelectorAll('text')].some((e) => e.textContent.includes('…')), texts, outside, panelEllipsis: [...panel.querySelectorAll('text')].filter((e) => e.textContent.includes('…')).length };
      }, kind);
      ok(!txt.ellipsis && JSON.stringify([...txt.texts].sort()) === JSON.stringify([...want].sort()), `FS (${theme}, ${kind}): every label${kind === 'flow' ? '' : ' and sub-text'} is shown whole, no ellipsis (${want.length} texts)`, JSON.stringify({ want, txt }));
      ok(txt.outside.length === 0, `FS (${theme}, ${kind}): every text sits inside its box`, JSON.stringify(txt.outside));
      ok(txt.panelEllipsis > 0, `FS (${theme}, ${kind}): the panel diagram keeps the engine's clamp (${txt.panelEllipsis} cut texts), so the check above bites`);
      if (shotsDir && (theme === 'blue' || kind === 'flow')) await page.screenshot({ path: path.join(shotsDir, `fs-${kind}-full-${theme}.png`) });
      // alpha.8 (owner QC 30-10: many steps are still hard to read at fit): wheel zoom at the cursor, drag to pan, Fit / key 0 back, + / - buttons, zoom limits.
      const zs = () => page.evaluate(() => { const v = document.querySelector('.bd-full svg.bd'), r = v.getBoundingClientRect(); return { z: Number(v.dataset.zoom), tx: Number(v.dataset.tx), ty: Number(v.dataset.ty), w: r.width, h: r.height, hasG: Boolean(v.querySelector(':scope > g.bd-pan')), btn: ['.bd-zoom-in', '.bd-zoom-out', '.bd-zoom-fit'].map((c) => document.querySelectorAll(`.bd-full ${c}`).length), pct: (document.querySelector('.bd-full-pct') || {}).textContent }; });
      const z0 = await zs();
      ok(z0.hasG && z0.z === 1 && z0.tx === 0 && z0.ty === 0 && z0.btn.join() === '1,1,1', `FS (${theme}, ${kind}): opens at fit (zoom 1, offset 0), with + / - / Fit buttons`, JSON.stringify(z0));
      const cx = viewport.width / 2, cy = viewport.height / 2;
      await page.mouse.move(cx, cy); await page.mouse.wheel(0, -500); await page.waitForTimeout(100);
      const z1 = await zs();
      ok(z1.z > 1.5 && z1.z <= 4 && z1.pct === `${Math.round(z1.z * 100)}%`, `FS (${theme}, ${kind}): wheel up zooms in (zoom ${z0.z} -> ${z1.z}, label ${z1.pct})`, JSON.stringify(z1));
      // the drawing point under the cursor stays under it: view point (cx,cy) maps to the same drawing point before and after
      const under = (z) => ({ x: (cx - z.left - z.tx * z.sc) / (z.sc * z.z), y: (cy - z.top - z.ty * z.sc) / (z.sc * z.z) });
      const geo = await page.evaluate(() => { const v = document.querySelector('.bd-full svg.bd'), r = v.getBoundingClientRect(), vb = v.viewBox.baseVal, sc = Math.min(r.width / vb.width, r.height / vb.height); return { left: r.left + (r.width - vb.width * sc) / 2, top: r.top + (r.height - vb.height * sc) / 2, sc }; });
      const u0 = under({ ...geo, z: 1, tx: 0, ty: 0 }), u1 = under({ ...geo, z: z1.z, tx: z1.tx, ty: z1.ty });
      ok(Math.abs(u0.x - u1.x) < 1.5 && Math.abs(u0.y - u1.y) < 1.5, `FS (${theme}, ${kind}): zoom is centred on the cursor (drawing point ${u0.x.toFixed(1)},${u0.y.toFixed(1)} -> ${u1.x.toFixed(1)},${u1.y.toFixed(1)})`);
      await page.mouse.wheel(0, -4000); await page.waitForTimeout(100);
      ok((await zs()).z === 4, `FS (${theme}, ${kind}): zoom is clamped at 400 %`);
      await page.mouse.wheel(0, 9000); await page.waitForTimeout(100);
      ok((await zs()).z === 1, `FS (${theme}, ${kind}): zooming out stops at fit`);
      await page.mouse.wheel(0, -500); await page.waitForTimeout(100);
      const d0 = await zs();
      await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx + 60, cy + 40, { steps: 6 }); await page.mouse.up(); await page.waitForTimeout(100);
      const d1 = await zs();
      ok(d1.z === d0.z && Math.abs(d1.tx - d0.tx) > 5 && Math.abs(d1.ty - d0.ty) > 5, `FS (${theme}, ${kind}): dragging pans (offset ${d0.tx},${d0.ty} -> ${d1.tx},${d1.ty}), zoom unchanged`, JSON.stringify({ d0, d1 }));
      await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx + 1, cy + 1); await page.mouse.up();
      const d2 = await zs();
      ok(d2.tx === d1.tx && d2.ty === d1.ty, `FS (${theme}, ${kind}): a click without drag does not move the drawing`);
      for (let i = 0; i < 8; i++) { await page.mouse.move(100, 100); await page.mouse.down(); await page.mouse.move(1200, 700, { steps: 3 }); await page.mouse.up(); }
      const d3 = await page.evaluate(() => { const v = document.querySelector('.bd-full svg.bd'); return { tx: Number(v.dataset.tx), ty: Number(v.dataset.ty), w: v.viewBox.baseVal.width, h: v.viewBox.baseVal.height }; });
      ok(d3.tx > d1.tx && d3.tx <= d3.w * 0.8 + 0.5 && d3.ty <= d3.h * 0.8 + 0.5 && (Math.abs(d3.tx - d3.w * 0.8) < 0.5 || Math.abs(d3.ty - d3.h * 0.8) < 0.5), `FS (${theme}, ${kind}): a drag cannot throw the drawing out of reach (offset ${d3.tx},${d3.ty} stops at 80 % of ${d3.w}x${d3.h})`, JSON.stringify(d3));
      if (shotsDir && (theme === 'blue' || kind === 'flow')) { await page.click('.bd-full .bd-zoom-fit'); await page.mouse.move(cx, cy); await page.mouse.wheel(0, -610); await page.waitForTimeout(100); await page.screenshot({ path: path.join(shotsDir, `fs-${kind}-zoom-${theme}.png`) }); }
      await page.click('.bd-full .bd-zoom-fit'); await page.waitForTimeout(50);
      const f1 = await zs();
      ok(f1.z === 1 && f1.tx === 0 && f1.ty === 0, `FS (${theme}, ${kind}): the Fit button restores zoom 1 and offset 0`, JSON.stringify(f1));
      await page.click('.bd-full .bd-zoom-in'); await page.click('.bd-full .bd-zoom-in');
      const b1 = await zs();
      await page.click('.bd-full .bd-zoom-out');
      const b2 = await zs();
      ok(b1.z > 1.9 && b2.z < b1.z && b2.z > 1, `FS (${theme}, ${kind}): + and - buttons zoom in and out (${b1.z}, then ${b2.z})`, JSON.stringify({ b1, b2 }));
      await page.keyboard.press('0');
      const f2 = await zs();
      ok(f2.z === 1 && f2.tx === 0 && f2.ty === 0, `FS (${theme}, ${kind}): key 0 restores fit`, JSON.stringify(f2));
      await page.mouse.move(cx, cy); await page.mouse.wheel(0, -800); // leave it zoomed: Esc must still restore the panel exactly
      await page.keyboard.press('Escape'); await page.waitForTimeout(150);
      const off = await probe();
      ok(!off.overlay && off.tab === before.tab && off.task === before.task && off.full === before.full && off.panelSvgs === before.panelSvgs && off.scrollTop === scrollBefore, `FS (${theme}, ${kind}): Esc closes it and the panel is as before (tab ${off.tab}, task ${off.task}, scroll ${off.scrollTop}, ${off.panelSvgs} diagrams)`, JSON.stringify({ before, off }));
      ok(off.focusBtn.includes('bd-full-btn'), `FS (${theme}, ${kind}): focus returns to the Fullscreen button`, off.focusBtn);
      await page.click(sel); await page.waitForTimeout(150);
      await page.click('.bd-full .bd-full-close'); await page.waitForTimeout(150);
      const viaBtn = await probe();
      ok(!viaBtn.overlay && viaBtn.scrollTop === scrollBefore, `FS (${theme}, ${kind}): the Close button closes it too, scroll unchanged`, JSON.stringify(viaBtn));
    }
    await page.click('.nb-back'); await page.waitForTimeout(150);
    ok(await page.evaluate(() => document.querySelectorAll('.bd-full').length) === 0, `FS (${theme}): no overlay left after Back`);
    ok(bad.length === 0, `FS (${theme}): no console error or failed request`, bad.slice(0, 3).join(' | '));
    await page.close();
  }
}

async function chromiumPart(buildDir) {
  const { chromium } = createRequire(import.meta.url)(PW);
  const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'], timeout: 60000 });
  const server = await serve(buildDir);
  try {
    const full = { ok: true, state: fixture };
    const t31 = byId('T-31'), plans = fixture.plans['T-31'].length;
    for (const viewport of [{ width: 1366, height: 768 }, { width: 1920, height: 1080 }, { width: 916, height: 639 }]) {
      const { page, bad } = await pageFor(browser, server, { board: full }, viewport);
      const tag = `${viewport.width}x${viewport.height}`;
      await openBrain(page, 'tasks');
      await page.waitForSelector('#next-brain .nb-row', { timeout: 5000 });
      const cardW = () => page.evaluate(() => Math.round(document.getElementById('next-brain').getBoundingClientRect().width));
      const narrowW = await cardW();
      await page.click('.nb-row[data-task="T-31"]'); await page.waitForTimeout(700);
      const r = await page.evaluate((goalText) => {
        const c = document.getElementById('next-brain'), b = c.getBoundingClientRect(), s = document.getElementById('stage').getBoundingClientRect(), body = c.querySelector('.nb-body');
        const L = c.querySelector('.nb-col-l'), R = c.querySelector('.nb-col-r'), lr = L && L.getBoundingClientRect(), rr = R && R.getBoundingClientRect();
        return { full: c.classList.contains('nx-brain-full'), gapL: Math.round(b.left - s.left), gapR: Math.round(s.right - b.right), opacity: getComputedStyle(c).opacity, yielded: c.classList.contains('nx-yield'), collapsed: c.classList.contains('nx-collapsed'),
          overflowX: body.scrollWidth - body.clientWidth, cols: Boolean(L && R) && rr.left >= lr.right && Math.abs(rr.top - lr.top) <= 1,
          left: L ? { steps: L.querySelectorAll('.nb-step').length, goal: L.innerText.includes(goalText), svgs: L.querySelectorAll('svg.bd').length, plans: L.querySelectorAll('.nb-plan').length } : null,
          right: R ? { svgs: R.querySelectorAll('svg.bd').length, plans: R.querySelectorAll('.nb-plan').length, open: [...R.querySelectorAll('.nb-plan')].every((d) => d.open), steps: R.querySelectorAll('.nb-step').length } : null };
      }, t31.goal);
      ok(r.full && Math.abs(r.gapL - 14) <= 1.5 && Math.abs(r.gapR - 14) <= 1.5 && r.opacity === '1' && !r.yielded && !r.collapsed, `R2 (${tag}): an open task puts nx-brain-full on the card, which fills the stage edge to edge (14 px each side), not faded, not collapsed`, JSON.stringify(r));
      ok(r.cols && r.left && r.left.steps === t31.steps.length && r.left.goal && r.left.svgs === 0 && r.left.plans === 0 && r.right && r.right.svgs === 2 && r.right.plans === plans && r.right.open && r.right.steps === 0,
        `R2 (${tag}): two columns side by side, goal and steps left, step flow + structure + every plan (open) right`, JSON.stringify(r));
      ok(r.overflowX <= 1, `R2 (${tag}): no sideways scroll inside the full detail`, JSON.stringify(r));
      if (shotsDir && viewport.width === 1366) { fs.mkdirSync(shotsDir, { recursive: true }); await page.screenshot({ path: path.join(shotsDir, 'chromium-r2-full-1366.png') }); }
      await page.click('.nb-back'); await page.waitForTimeout(300);
      const back = await page.evaluate(() => document.getElementById('next-brain').classList.contains('nx-brain-full'));
      const backW = await cardW();
      await page.click('.nb-row[data-task="T-31"]'); await page.waitForTimeout(300);
      await page.click('.nb-tab[data-tab="memory"]'); await page.waitForTimeout(300);
      const mem = await page.evaluate(() => document.getElementById('next-brain').classList.contains('nx-brain-full'));
      ok(!back && Math.abs(backW - narrowW) <= 1 && !mem, `R2 (${tag}): Back and the Memory tab return to the narrow card (${narrowW} px)`, JSON.stringify({ back, backW, narrowW, mem }));
      ok(bad.length === 0, `R2 (${tag}): no console error or failed request`, bad.slice(0, 3).join(' | '));
      await page.close();
    }
    await fullscreenPart(browser, server, full);
  } finally { await browser.close(); server.close(); }
}

try {
  if (!fs.existsSync(path.join(PW, 'package.json')) || !fs.existsSync(EXE)) { console.error(`ENV: need playwright at ${PW} and Chromium at ${EXE}`); process.exit(2); }
  makeScratch();
  console.log(`build: ${execFileSync(process.execPath, [path.join(SCRATCH, 'scripts', 'build-renderer.mjs')], { cwd: SCRATCH, env: { ...process.env, ZUMI_NEXT_UI: '1' }, encoding: 'utf8' }).trim()}`);
  const css = fs.readFileSync(path.join(SCRATCH, 'src', 'renderer', 'next', 'brain', 'brain.css'), 'utf8');
  ok(/\.nx-brain\.nx-brain-full\s*\{[^}]*left:\s*14px;[^}]*right:\s*14px;[^}]*width:\s*auto;/.test(css) && /\.nx-brain-full \.nb-body\s*\{[^}]*display:\s*grid;/.test(css), 'R2: brain.css holds the .nx-brain.nx-brain-full rule (left/right 14px, width auto) and the two-column body grid');
  await chromiumPart(path.join(SCRATCH, 'build', 'renderer'));
} catch (e) {
  fail++; console.log(`FAIL check crashed: ${(e && e.stack) || e}`);
} finally {
  if (!keep) fs.rmSync(SCRATCH, { recursive: true, force: true });
}
console.log(`\ncheck:brain-full ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
