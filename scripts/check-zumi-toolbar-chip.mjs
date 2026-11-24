#!/usr/bin/env node
// check:zumi-toolbar-chip (T-31-ALPHA12, Fable final HOLD + Opus gate F1). The reflex chip shows ~3 s per reaction, cursor moves
// included. While it sat in the wrapping Zumi toolbar row, each reaction pushed mute / View / Room along (and could wrap the row), so
// the toolbar and the stage below it moved under the cursor. This check lays out the real index.html + styles (tokens, styles.css,
// look A, hud.css) in Chromium with the Vietnamese labels, at the client widths of a 1296 px and a 900 px window, and measures every
// toolbar control and the stage with the chip hidden, then with the longest chip showing. Nothing may move by even 0.5 px.
// The chip must stay in the toolbar row (a 3D room is a native guest webview above the stage that would cover an overlay there).
//   node scripts/check-zumi-toolbar-chip.mjs [--css <styles.css>] [--html <index.html>]   (lay out other sources, e.g. old ones as a control)
// Not the Tauri window; app.js is not run (static shell only). No network, no key.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ownerPath } from './lib/owner-paths.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(ROOT, 'package.json'));
const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const htmlFile = opt('--html') ? path.resolve(opt('--html')) : path.join(ROOT, 'src', 'renderer', 'index.html');
const cssFile = opt('--css') ? path.resolve(opt('--css')) : path.join(ROOT, 'src', 'renderer', 'styles.css');
let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`); } };

const { TABLES } = await import(pathToFileURL(path.join(ROOT, 'src', 'renderer', 'i18n.js')).href);
const VI = { ...TABLES.en, ...TABLES.vi };
// The widest chip the owner sees: a cursor reaction with the longest cursor gesture label (reflex/engine.js builds 'reflex.chip').
const CHIP = VI['reflex.chip'].replace('{label}', `${VI['gesture.cursor.trigger']} → ${VI['gesture.cursor.eyes-lead']}`);

// The page the built renderer serves (build-renderer.mjs: next-ui links + zumi-next class), without app.js.
const SRC = path.join(ROOT, 'src', 'renderer');
const indexHtml = fs.readFileSync(htmlFile, 'utf8')
  .replace('<!-- next-ui:head -->', '<link rel="stylesheet" href="next/tokens-a.css">\n  <link rel="stylesheet" href="next/theme-a.css">')
  .replace('<html lang="en" class="dark">', '<html lang="vi" class="dark zumi-next" data-theme="blue">')
  .replace('<script src="app.js"></script>', '');
const FILES = {
  '/tokens.css': path.join(ROOT, 'vendor', 'laneboard', 'public', 'tokens.css'),
  '/styles.css': cssFile,
  '/hud.css': path.join(SRC, 'hud', 'hud.css'),
  '/next/tokens-a.css': path.join(ROOT, 'src', 'next-tokens', 'tokens-a.css'),
  '/next/theme-a.css': path.join(SRC, 'next', 'theme-a.css'),
};
const server = http.createServer((q, s) => {
  const p = decodeURIComponent(new URL(q.url, 'http://x').pathname);
  if (p === '/') { s.writeHead(200, { 'content-type': 'text/html' }); return s.end(indexHtml); }
  const file = FILES[p] || path.join(SRC, p);
  fs.readFile(file, (e, buf) => { if (e) { s.writeHead(404); return s.end(); } s.writeHead(200, { 'content-type': p.endsWith('.css') ? 'text/css' : p.endsWith('.svg') ? 'image/svg+xml' : 'application/octet-stream' }); s.end(buf); });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

const { chromium } = req(process.env.ZUMI_PLAYWRIGHT_DIR || ownerPath('playwrightDir', 'node_modules/playwright'));
const EXE = process.env.ZUMI_CHROMIUM || ownerPath('chromiumExe', 'local/chrome.exe');
const browser = await chromium.launch({ executablePath: EXE, headless: true, timeout: 60000 });

// The owner's toolbar as app.js leaves it on the default model in a room with a camera view and video rooms (shots-final measure-*.json).
const setup = (vi) => {
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = vi[el.getAttribute('data-i18n')] ?? el.textContent;
  const fill = (id, labels) => { const s = document.getElementById(id); s.innerHTML = ''; for (const l of labels) s.add(new Option(l)); };
  fill('model-picker', [vi['model.zumiDefault'], vi['model.zumiClassic'], vi['model.fromThisPc']]);
  fill('scene-select', [vi['scene.current'], vi['room3d.option'], vi['room3d.option2']]);
  document.getElementById('model-default').hidden = true;
  document.getElementById('room-view-picker').hidden = false;
  document.getElementById('scene-picker').hidden = false;
};
const IDS = ['model-picker', 'open-vrm', 'talk-mute', 'room-view-select', 'scene-select', 'stage'];
const measure = (ids) => {
  const r = (el) => { const b = el.getBoundingClientRect(); return [b.left, b.top, b.right, b.bottom].map((v) => Math.round(v * 2) / 2); };
  const tb = document.querySelector('#tab-zumi > .toolbar');
  return { toolbar: r(tb), rects: Object.fromEntries(ids.map((id) => [id, r(document.getElementById(id))])) };
};
const showChip = (text) => {
  const chip = document.getElementById('reflex-chip');
  chip.textContent = text; chip.hidden = false; chip.classList.add('show');
  const b = chip.getBoundingClientRect();
  return { l: b.left, t: b.top, r: b.right, b: b.bottom, opacity: getComputedStyle(chip).opacity };
};

for (const [label, w, h] of [['1296 px window', 1280, 800], ['900 px window', 884, 720]]) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load' });
  await page.evaluate(setup, VI);
  await page.evaluate(() => document.fonts.ready);
  const idle = await page.evaluate(measure, IDS);
  const chip = await page.evaluate(showChip, CHIP);
  await page.waitForTimeout(400); // past the .25 s opacity/transform transition
  const shown = await page.evaluate(measure, IDS);
  const moved = IDS.filter((id) => JSON.stringify(idle.rects[id]) !== JSON.stringify(shown.rects[id]));
  ok(JSON.stringify(idle.toolbar) === JSON.stringify(shown.toolbar), `${label}: the toolbar keeps its box while the chip shows`, { idle: idle.toolbar, shown: shown.toolbar });
  ok(moved.length === 0, `${label}: no toolbar control and not the stage moves while the chip shows`, Object.fromEntries(moved.map((id) => [id, [idle.rects[id], shown.rects[id]]])));
  const overlaps = IDS.filter((id) => id !== 'stage').filter((id) => { const [l, t, r, b] = shown.rects[id]; return chip.l < r && chip.r > l && chip.t < b && chip.b > t; });
  ok(chip.t >= shown.toolbar[1] && chip.b <= shown.toolbar[3] && chip.l >= shown.toolbar[0] && chip.r <= w && overlaps.length === 0, `${label}: the chip shows inside the toolbar, inside the window, over no control`, { chip, toolbar: shown.toolbar, overlaps });
  ok(chip.r - chip.l >= 150 && chip.opacity === '1', `${label}: the chip is readable (at least 150 px wide, opaque)`, chip);
  ok(idle.rects['talk-mute'][0] > idle.rects['open-vrm'][2] + 40, `${label}: the right-hand group (mute, View, Room) sits apart from the model controls, as before alpha.12`, { mute: idle.rects['talk-mute'], vrm: idle.rects['open-vrm'] });
  const offRight = IDS.filter((id) => idle.rects[id][2] > w + 0.5);
  ok(offRight.length === 0, `${label}: nothing past the right edge`, offRight);
  await page.close();
}

await browser.close();
server.close();
console.log(`\ncheck:zumi-toolbar-chip: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
