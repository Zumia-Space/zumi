#!/usr/bin/env node
// check:market-ui (T-31 Marketplace). The owner QCs inside the app, so every visible control must work or be labelled. Chromium (Playwright), the
// built renderer, the REAL market host behind a stub bridge (real zip, real sha256, real validator, files on disk, fake server). Buttons are clicked
// with the mouse and their effect read from disk or from the stage's own pickers. No network, no key, no paid call. Not the Tauri window.
//   node scripts/check-market-ui.mjs [--shots <dir>]
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ownerPath } from './lib/owner-paths.mjs';
import { packZip, sha256 } from './lib/zip-write.mjs';
import { createMarketHost } from '../tauri/sidecar/market-host.mjs';
import { TABLES } from '../src/renderer/i18n.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(ROOT, 'package.json'));
const args = process.argv.slice(2);
const shotsDir = args.includes('--shots') ? path.resolve(args[args.indexOf('--shots') + 1]) : null;
if (shotsDir) fs.mkdirSync(shotsDir, { recursive: true });
let pass = 0, fail = 0;
const ok = (c, name, detail = '') => { if (c) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`); } };

// ---------- text: all three languages, every key the page can ask for ----------
const keys = Object.keys(TABLES.en).filter((k) => k.startsWith('market.'));
ok(keys.length > 60, 'the page has its own text keys', String(keys.length));
for (const loc of ['vi', 'zh']) {
  const miss = keys.filter((k) => !TABLES[loc][k]);
  ok(!miss.length, `${loc} has every market key`, miss.join());
}
const src = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'market.js'), 'utf8');
ok(!/innerHTML/.test(src), 'market.js never uses innerHTML');
for (const code of ['download_failed', 'sha_mismatch', 'invalid_pack', 'model_failed', 'restart_needed', 'not_packaged', 'busy', 'bundled', 'not_installed', 'unknown_item', 'install_failed']) ok(TABLES.en[`market.err.${code}`], `error ${code} has a plain sentence`);

// ---------- the page ----------
execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-renderer.mjs')], { cwd: ROOT, stdio: 'ignore', timeout: 300000 });
const { chromium } = req(process.env.ZUMI_PLAYWRIGHT_DIR || ownerPath('playwrightDir', 'node_modules/playwright'));
const EXE = process.env.ZUMI_CHROMIUM || ownerPath('chromiumExe', 'local/chrome.exe');
const BUILD = path.join(ROOT, 'build', 'renderer');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png' };
const server = http.createServer((q, s) => {
  const p = decodeURIComponent(new URL(q.url, 'http://x').pathname);
  const file = p === '/tokens.css' ? path.join(ROOT, 'vendor', 'laneboard', 'public', 'tokens.css') : path.join(BUILD, p === '/' ? 'index.html' : p);
  if (!path.resolve(file).startsWith(path.resolve(ROOT))) { s.writeHead(403); return s.end(); }
  fs.readFile(file, (e, buf) => { if (e) { s.writeHead(404); return s.end(); } s.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' }); s.end(buf); });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

const STUB = `(() => {
  const deep = () => new Proxy(function () {}, { get: (t, k) => (k === 'then' ? undefined : k === Symbol.toPrimitive ? () => '' : deep()), apply: () => Promise.resolve(deep()) });
  const withFallback = (o) => new Proxy(o, { get: (t, k) => (k in t ? t[k] : (k === 'then' || k === 'memory' ? undefined : deep())) });
  const info = { version: 'check', packaged: true, disabledViews: [], ownerAdmin: true, boardPartition: 'b', boardLivePartition: 'bl', demo: false, selftest: false, minWidth: 600, minHeight: 400 };
  const models = { models: [{ id: 'zumi-default', label: 'Zumi default', source: 'bundled', isDefault: true }, { id: 'other', label: 'Second model', source: 'bundled' }, { id: 'user', label: 'Model from this PC', source: 'user' }], selected: 'zumi-default', bundledCount: 2 };
  const sceneList = { selected: 'current', geometry: null, rooms: [{ id: 'cozy-study', label: 'Cozy study' }, { id: 'zen-garden', label: 'Zen garden room' }] };
  window.__picked = [];
  const progress = new Set();
  window.__marketProgress = (p) => { for (const cb of progress) cb(p); };
  window.zumi = withFallback({ info: async () => info, listModels: async () => models, selectModel: async (id) => { window.__picked.push(['model', id]); models.selected = id; return models; }, listClips: async () => [],
    rooms: withFallback({ list: async () => ({ rooms: [], selected: null }) }),
    scenes: withFallback({ list: async () => sceneList, select: async (id) => { window.__picked.push(['room', id]); sceneList.selected = id; return sceneList; } }),
    chairs: withFallback({ list: async () => ({ chairs: [], selected: null }) }),
    ui: withFallback({ getLang: async () => window.__uiLang, setLang: async () => {}, getDevTools: async () => false }),
    board: withFallback({ status: async () => ({ configured: false, mode: 'local' }), state: async () => ({ ok: false, reason: 'unconfigured' }) }),
    hud: withFallback({ getPrefs: async () => ({ style: 'a', voiceMuted: false }), setPrefs: async (p) => p, ready: async () => true, onFeed: () => () => {} }),
    market: { list: () => window.__market('list'), install: (id) => window.__market('install', id), remove: (id) => window.__market('remove', id), onProgress: (cb) => { progress.add(cb); return () => progress.delete(cb); } } });
  HTMLElement.prototype.loadURL = function () { return Promise.resolve(); };
})();`;

const RUNTIME = {
  'LICENSE.txt': 'Apache-2.0',
  'voice-modules/node_modules/kokoro-js/dist/kokoro.js': '//k',
  'voice-modules/node_modules/@huggingface/transformers/dist/transformers.node.mjs': '//t',
  'voice-modules/node_modules/@huggingface/transformers/node_modules/onnxruntime-node/bin/napi-v3/win32/x64/onnxruntime_binding.node': 'b',
};
const goodZip = packZip({ format: 'zumi-pack/1', id: 'voice.kokoro-82m', kind: 'voice', version: '1.2.1', name: { en: 'Kokoro' }, author: { name: 'hexgrad' }, licence: { spdx: 'Apache-2.0', file: 'LICENSE.txt' }, platforms: ['win-x64'], voice: { engine: 'kokoro', langs: ['en'] } }, RUNTIME);
const catalog = [
  { id: 'voice.kokoro-82m', kind: 'voice', version: '1.2.1', recommended: true, licence: 'Apache-2.0', author: 'hexgrad', langs: ['en'], platforms: ['win-x64'], bytes: 87194313, modelBytes: 156 * 1024 * 1024, download: { url: 'https://zumia.space/packs/k.zip', sha256: sha256(goodZip), bytes: goodZip.length } },
  { id: 'voice.vieneu-tts', kind: 'voice', version: '3.0.0', recommended: false, licence: 'Apache-2.0', author: 'pnnbao97', langs: ['vi', 'en'], platforms: ['win-x64'], bytes: 1360 * 1024 * 1024, modelBytes: 0, download: null },
];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zumi-market-ui-'));
let run = 0;
const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], timeout: 60000 });

async function open({ w = 1680, h = 987, lang = 'vi', bundled = false, serverBytes = goodZip, status = 200 } = {}) {
  const dataDir = path.join(tmp, `d${++run}`); fs.mkdirSync(dataDir);
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  const errors = []; page.on('pageerror', (e) => errors.push(String(e.message).split('\n')[0]));
  let modelHere = bundled; let release = () => {};
  const gate = { hold: null };
  const host = createMarketHost({
    dataDir, catalog, bundled: (id) => bundled && id === 'voice.kokoro-82m',
    fetchImpl: async () => { if (gate.hold) await gate.hold; return { ok: status === 200, status, body: new Blob([serverBytes]).stream() }; },
    emit: (c, p) => { page.evaluate((x) => window.__marketProgress(x), p).catch(() => {}); return true; },
    model: { present: () => modelHere, download: async (cb) => { cb({ loaded: 5, total: 10 }); modelHere = true; return true; }, stop() {}, remove() { modelHere = false; } },
  });
  await page.exposeFunction('__market', (name, id) => host.handlers[`market.${name}`](id));
  await page.addInitScript(`window.__uiLang = ${JSON.stringify(lang)};`);
  await page.addInitScript(STUB);
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelector('#market-cats .stab'), null, { timeout: 30000 });
  // The stage shows the room picker only with the 3D room on; there is none in this harness.
  // The stage fills its room picker only with the 3D room on, and there is none in this harness: fill it the way paintScenePicker does. The app's own change listener stays.
  await page.evaluate(() => {
    const s = document.getElementById('scene-select'); s.replaceChildren();
    for (const [v, l] of [['current', 'Current room'], ['cozy-study', 'Cozy study'], ['zen-garden', 'Zen garden room']]) { const o = document.createElement('option'); o.value = v; o.textContent = l; s.appendChild(o); }
    s.value = 'current'; document.getElementById('scene-picker').hidden = false;
  });
  await page.locator('.tab[data-tab="market"]').click();
  await page.waitForTimeout(150);
  return { page, dataDir, errors, gate, setRelease: (r) => { release = r; }, release: () => release() };
}
const card = (page, id) => page.locator(`.market-card[data-id="${id}"]`);
const shot = async (page, name) => { if (shotsDir) await page.screenshot({ path: path.join(shotsDir, `${name}.png`) }); };

// ---------- 1. the rail and the list ----------
{
  const { page, errors } = await open();
  const rail = await page.$$eval('#sidebar .tab', (els) => els.filter((e) => !e.hidden).map((e) => e.dataset.tab || e.dataset.next));
  const iBoard = rail.indexOf('board'), iMarket = rail.indexOf('market'), iSettings = rail.indexOf('settings');
  ok(iMarket > iBoard && iMarket < iSettings, 'the tab sits between Board and Settings', rail.join());
  ok(await page.locator('#tab-market').evaluate((e) => e.classList.contains('active') && getComputedStyle(e).display !== 'none'), 'clicking the tab opens the panel');
  const cats = await page.$$eval('#market-cats .stab', (els) => els.map((e) => e.dataset.cat));
  ok(cats.join() === 'all,voice,room,model,skill,soul,plugin,agent,installed', 'every category has a tab', cats.join());
  const kokoro = card(page, 'voice.kokoro-82m');
  ok(await kokoro.locator('.pill.rec').count() === 1, 'Kokoro is Recommended');
  ok(await kokoro.locator('button.market-go').count() === 1, 'Kokoro has an Install button');
  const vieneu = card(page, 'voice.vieneu-tts');
  ok(await vieneu.locator('button').count() === 0 && (await vieneu.innerText()).includes(TABLES.vi['market.pill.packaging']), 'VieNeu is listed, labelled, with no button', await vieneu.innerText());
  ok((await card(page, 'os.voice').innerText()).includes(TABLES.vi['market.pill.os']) && await card(page, 'os.voice').locator('button').count() === 0, 'the Windows voice is an OS row, not a package');
  await shot(page, 'market-list-vi-1680x987');
  // Every button on every visible card does something real (proved below); no disabled button anywhere.
  ok(await page.locator('#tab-market button[disabled]').count() === 0, 'no dead button: what cannot run has words, not a greyed button');
  ok(!(await page.locator('#tab-market').innerText()).match(/SAMPLE|lorem/i), 'no sample text');
  ok(!(await page.locator('#tab-market').innerText()).match(/USD|\$\d|mua|trả phí/i), 'no paid item');
  // Details follow the selection.
  await vieneu.click();
  ok((await page.locator('#market-detail').innerText()).includes('VieNeu'), 'clicking a card shows its details');
  const facts = await page.locator('#market-detail').innerText();
  for (const k of ['market.f.author', 'market.f.version', 'market.f.licence', 'market.f.price', 'market.f.platform']) ok(facts.includes(TABLES.vi[k]), `details show ${k}`);
  await kokoro.click();
  ok((await page.locator('#market-detail').innerText()).includes('sha256'), 'an installable item shows its sha256');
  ok(errors.length === 0, 'no page error', errors.join(' | '));
  await page.close();
}
// ---------- 2. categories and search are real ----------
{
  const { page } = await open();
  const ids = () => page.$$eval('.market-card[data-id]', (els) => els.map((e) => e.dataset.id));
  await page.locator('[data-cat="voice"]').click();
  ok((await ids()).every((i) => i.startsWith('voice.') || i === 'os.voice') && (await ids()).length === 3, 'Voice shows only voices', (await ids()).join());
  await page.locator('[data-cat="room"]').click();
  ok((await ids()).join() === 'room.current,room.cozy-study,room.zen-garden', 'Rooms lists the rooms of the stage picker', (await ids()).join());
  await page.locator('[data-cat="model"]').click();
  ok((await ids()).join() === 'model.zumi-default,model.other,model.user', 'Models lists the models of the stage picker', (await ids()).join());
  for (const k of ['skill', 'soul', 'plugin', 'agent']) {
    await page.locator(`[data-cat="${k}"]`).click();
    const soon = page.locator(`.market-soon[data-soon="${k}"]`);
    ok(await soon.count() === 1 && (await soon.innerText()).includes(TABLES.vi['market.pill.soon']) && await page.locator('.market-card button').count() === 0, `${k}: labelled coming soon, no control, no item`);
    if (k === 'plugin') await shot(page, 'market-coming-soon-vi-1680x987');
  }
  await page.locator('[data-cat="all"]').click();
  await page.locator('#market-search').fill('vieneu');
  ok((await ids()).join() === 'voice.vieneu-tts', 'search narrows the list', (await ids()).join());
  await page.locator('#market-search').fill('khong co gi');
  ok((await ids()).length === 0 && (await page.locator('#market-list').innerText()).includes(TABLES.vi['market.none.search']), 'search with no hit says so');
  await page.locator('#market-search').fill('');
  await page.locator('[data-cat="installed"]').click();
  const here = await ids();
  ok(!here.includes('voice.kokoro-82m') && !here.includes('voice.vieneu-tts') && here.includes('os.voice') && here.includes('room.cozy-study'), 'On this PC leaves out what is not installed', here.join());
  await page.close();
}
// ---------- 3. Use is the stage's own switch ----------
{
  const { page } = await open();
  await page.locator('[data-cat="room"]').click();
  await card(page, 'room.cozy-study').locator('button').click();
  await page.waitForFunction(() => window.__picked.some((p) => p[0] === 'room' && p[1] === 'cozy-study'), null, { timeout: 5000 });
  ok(await page.locator('#scene-select').inputValue() === 'cozy-study', 'Use on a room moves the stage picker');
  ok(await card(page, 'room.cozy-study').locator('.pill.ok').count() === 1 && await card(page, 'room.cozy-study').locator('button').count() === 0, 'the room reads In use');
  await page.locator('[data-cat="model"]').click();
  ok(!(await card(page, 'model.user').innerText()).includes('Zumia'), 'a model he imported is not credited to Zumia', await card(page, 'model.user').innerText());
  await card(page, 'model.other').locator('button').click();
  await page.waitForFunction(() => window.__picked.some((p) => p[0] === 'model' && p[1] === 'other'), null, { timeout: 5000 });
  ok(await card(page, 'model.other').locator('.pill.ok').count() === 1, 'Use on a model selects it');
  await page.close();
}
// ---------- 4. Install and Remove, on disk ----------
{
  const { page, dataDir, gate } = await open();
  let open_; gate.hold = new Promise((r) => { open_ = r; });
  const pack = path.join(dataDir, 'packs', 'voice.kokoro-82m', 'zumi-pack.json');
  const kokoro = card(page, 'voice.kokoro-82m');
  await kokoro.locator('button.market-go').click();
  await page.waitForFunction(() => document.querySelector('.market-card[data-id="voice.kokoro-82m"] .bar'), null, { timeout: 5000 });
  ok(await kokoro.locator('button').count() === 0, 'while installing there is progress and no button');
  await shot(page, 'market-installing-vi-1680x987');
  open_();
  await page.waitForFunction(() => document.querySelector('.market-card[data-id="voice.kokoro-82m"] .pill.ok'), null, { timeout: 15000 });
  ok(fs.existsSync(pack), 'Install really wrote the pack');
  ok(await kokoro.locator('.bar').count() === 0 && (await kokoro.innerText()).includes(TABLES.vi['market.remove']), 'then it reads Installed with a Remove button');
  await shot(page, 'market-installed-vi-1680x987');
  await page.locator('[data-cat="installed"]').click();
  ok(await kokoro.count() === 1, 'On this PC now lists it');
  await page.locator('[data-cat="voice"]').click();
  await kokoro.locator('button').click();
  await page.waitForFunction(() => document.querySelector('.market-card[data-id="voice.kokoro-82m"] button.market-go'), null, { timeout: 5000 });
  ok(!fs.existsSync(pack), 'Remove really deleted it');
  await page.close();
}
// ---------- 5. failures are sentences ----------
{
  const cases = [['download_failed', { status: 404 }], ['sha_mismatch', { serverBytes: Buffer.concat([goodZip.subarray(0, -1), Buffer.from([1])]) }]];
  for (const [code, o] of cases) {
    const { page, dataDir } = await open(o);
    await card(page, 'voice.kokoro-82m').locator('button.market-go').click();
    await page.waitForSelector('.market-card[data-id="voice.kokoro-82m"] .market-err', { timeout: 8000 });
    ok((await card(page, 'voice.kokoro-82m').locator('.market-err').innerText()) === TABLES.vi[`market.err.${code}`], `${code}: a plain sentence under the button`);
    ok(await card(page, 'voice.kokoro-82m').locator('button.market-go').count() === 1, `${code}: Install stays, so he can retry`);
    ok(!fs.existsSync(path.join(dataDir, 'packs', 'voice.kokoro-82m')), `${code}: nothing was installed`);
    if (code === 'download_failed') await shot(page, 'market-not-published-vi-1680x987');
    await page.close();
  }
}
// ---------- 6. the owner build: Kokoro in the installer ----------
{
  const { page } = await open({ bundled: true });
  const kokoro = card(page, 'voice.kokoro-82m');
  ok((await kokoro.innerText()).includes(TABLES.vi['market.pill.bundled']) && await kokoro.locator('button').count() === 0, 'owner build: Kokoro reads In the installer, no Install, no Remove', await kokoro.innerText());
  ok((await card(page, 'voice.vieneu-tts').innerText()).includes(TABLES.vi['market.pill.packaging']), 'owner build: VieNeu still reads Being packaged');
  ok(!(await page.locator('#market-detail').innerText()).includes(TABLES.vi['market.item.voice_kokoro_82m.note']), 'owner build: the details do not talk about installing what is already here');
  await shot(page, 'market-owner-build-vi-1680x987');
  await page.close();
}
// ---------- 7. layout: nothing cut, three languages, three sizes ----------
for (const [w, h] of [[1680, 987], [1366, 768], [900, 600]]) for (const lang of ['vi', 'en', 'zh']) {
  const { page, errors } = await open({ w, h, lang });
  const m = await page.evaluate(() => {
    const out = { overflow: [], list: document.getElementById('market-list') };
    const panel = document.getElementById('tab-market').getBoundingClientRect();
    for (const e of document.querySelectorAll('#tab-market .market-card, #tab-market .market-ctl, #tab-market .toolbar, #market-cats')) { const r = e.getBoundingClientRect(); if (r.width && r.right > panel.right + 1) out.overflow.push(e.className || e.id); }
    const c = document.getElementById('market-list');
    return { overflow: out.overflow, hscroll: c.scrollWidth > c.clientWidth + 1, vscrollable: c.scrollHeight >= c.clientHeight, foot: document.querySelector('.market-foot').getBoundingClientRect().bottom <= innerHeight + 1 };
  });
  ok(!m.overflow.length && !m.hscroll && m.foot, `${lang} ${w}x${h}: nothing runs off the window`, m);
  await page.locator('.market-card').last().scrollIntoViewIfNeeded();
  ok(await page.locator('.market-card').last().isVisible(), `${lang} ${w}x${h}: the last card can be reached`);
  ok(!errors.length, `${lang} ${w}x${h}: no page error`, errors.join(' | '));
  if (shotsDir && lang === 'vi') await shot(page, `market-end-vi-${w}x${h}`);
  await page.close();
}
await browser.close();
server.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`check:market-ui: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
