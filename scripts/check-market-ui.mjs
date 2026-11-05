#!/usr/bin/env node
// check:market-ui (T-31 Marketplace, store layout 05-11). The owner QCs inside the app, so every visible control must work or be labelled.
// Chromium (Playwright), the built renderer, the REAL market host behind a stub bridge (real zip, real sha256, real validator, files on disk,
// fake server). Buttons are clicked with the mouse and their effect read from disk or from the stage's own pickers. No network, no key,
// no paid call. Not the Tauri window. The shipped catalog and the real Kokoro pack are check:market-e2e.
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
import { MARKET_STUB as STUB } from './lib/market-stub.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(ROOT, 'package.json'));
const args = process.argv.slice(2);
const shotsDir = args.includes('--shots') ? path.resolve(args[args.indexOf('--shots') + 1]) : null;
if (shotsDir) fs.mkdirSync(shotsDir, { recursive: true });
let pass = 0, fail = 0;
const ok = (c, name, detail = '') => { if (c) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`); } };
const EN = TABLES.en;

// ---------- text: all three languages, every key the page can ask for ----------
const keys = Object.keys(EN).filter((k) => k.startsWith('market.'));
ok(keys.length > 60, 'the page has its own text keys', String(keys.length));
for (const loc of ['vi', 'zh']) {
  const miss = keys.filter((k) => !TABLES[loc][k]);
  ok(!miss.length, `${loc} has every market key`, miss.join());
}
const src = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'market.js'), 'utf8');
ok(!/innerHTML/.test(src), 'market.js never uses innerHTML');
for (const code of ['download_failed', 'offline', 'not_published', 'sha_mismatch', 'invalid_pack', 'model_failed', 'restart_needed', 'not_packaged', 'busy', 'bundled', 'not_installed', 'unknown_item', 'install_failed']) ok(EN[`market.err.${code}`], `error ${code} has a plain sentence`);
for (const n of ['runs-code', 'model-download', 'data-only', 'os-speech']) ok(EN[`market.need.${n}`], `permission ${n} has words`);

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


const RUNTIME = {
  'LICENSE.txt': 'Apache-2.0',
  'voice-modules/node_modules/kokoro-js/dist/kokoro.js': '//k',
  'voice-modules/node_modules/@huggingface/transformers/dist/transformers.node.mjs': '//t',
  'voice-modules/node_modules/@huggingface/transformers/node_modules/onnxruntime-node/bin/napi-v3/win32/x64/onnxruntime_binding.node': 'b',
};
const manifest = { format: 'zumi-pack/1', id: 'voice.kokoro-82m', kind: 'voice', version: '1.2.1', name: { en: 'Kokoro' }, author: { name: 'hexgrad' }, licence: { spdx: 'Apache-2.0', file: 'LICENSE.txt' }, platforms: ['win-x64'], voice: { engine: 'kokoro', langs: ['en'] } };
const goodZip = packZip(manifest, RUNTIME);
const newerZip = packZip({ ...manifest, version: '1.3.0' }, RUNTIME);
const item = (zip, over = {}) => ({ id: 'voice.kokoro-82m', kind: 'voice', version: '1.2.1', recommended: true, licence: 'Apache-2.0', author: 'hexgrad', langs: ['en'], platforms: ['win-x64'], bytes: 87194313, modelBytes: 156 * 1024 * 1024, needs: ['runs-code', 'model-download'], download: { url: 'https://github.com/x/packs/k.zip', sha256: sha256(zip), bytes: zip.length }, ...over });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zumi-market-ui-'));
let run = 0;
const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], timeout: 60000 });

/** fetchImpl: 'ok' serves the bytes, a number answers that status, 'offline' throws the way fetch does with no network. */
async function open({ w = 1366, h = 768, lang = 'en', bundled = false, serverBytes = goodZip, net = 'ok', catalog = [item(goodZip)], dataDir: given = null } = {}) {
  const dataDir = given || path.join(tmp, `d${++run}`); fs.mkdirSync(dataDir, { recursive: true });
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  const errors = []; page.on('pageerror', (e) => errors.push(String(e.message).split('\n')[0]));
  let modelHere = bundled;
  const gate = { hold: null, net, serverBytes };
  const host = createMarketHost({
    dataDir, catalog, bundled: (id) => bundled && id === 'voice.kokoro-82m',
    fetchImpl: async (u, init) => {
      if (gate.hold) await gate.hold;
      if (gate.net === 'offline') throw new TypeError('fetch failed');
      const status = gate.net === 'ok' ? 200 : gate.net;
      if (init && init.method === 'HEAD') return { ok: status === 200, status, headers: new Headers() };
      return { ok: status === 200, status, headers: new Headers(), body: new Blob([gate.serverBytes]).stream() };
    },
    emit: (c, p) => { page.evaluate((x) => window.__marketProgress(x), p).catch(() => {}); return true; },
    model: { present: () => modelHere, download: async (cb) => { cb({ loaded: 5, total: 10 }); modelHere = true; return true; }, stop() {}, remove() { modelHere = false; } },
  });
  await page.exposeFunction('__market', (name, id) => host.handlers[`market.${name}`](id));
  await page.addInitScript(`window.__uiLang = ${JSON.stringify(lang)};`);
  await page.addInitScript(STUB);
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelector('#market-cats .stab'), null, { timeout: 30000 });
  // The stage fills its room picker only with the 3D room on, and there is none in this harness: fill it the way paintScenePicker does. The app's own change listener stays.
  await page.evaluate(() => {
    const s = document.getElementById('scene-select'); s.replaceChildren();
    for (const [v, l] of [['current', 'Current room'], ['cozy-study', 'Cozy study'], ['zen-garden', 'Zen garden room']]) { const o = document.createElement('option'); o.value = v; o.textContent = l; s.appendChild(o); }
    s.value = 'current'; document.getElementById('scene-picker').hidden = false;
  });
  await page.locator('.tab[data-tab="market"]').click();
  await page.waitForTimeout(200);
  return { page, dataDir, errors, gate, host };
}
const card = (page, id) => page.locator(`.market-card[data-id="${id}"]`);
const detail = (page) => page.locator('#market-detail');
const shot = async (page, name) => { if (shotsDir) await page.screenshot({ path: path.join(shotsDir, `${name}.png`) }); };
const installed = (page, id) => page.waitForFunction((i) => { const c = document.querySelector(`.market-card[data-id="${i}"]`); return c && c.dataset.state === 'installed'; }, id, { timeout: 15000 });

// ---------- 1. the store: rail, chips, grid of cards ----------
{
  const { page, errors } = await open();
  const rail = await page.$$eval('#sidebar .tab', (els) => els.filter((e) => !e.hidden).map((e) => e.dataset.tab || e.dataset.next));
  const iBoard = rail.indexOf('board'), iMarket = rail.indexOf('market'), iSettings = rail.indexOf('settings');
  ok(iMarket > iBoard && iMarket < iSettings, 'the tab sits between Board and Settings', rail.join());
  ok(await page.locator('#tab-market').evaluate((e) => e.classList.contains('active') && getComputedStyle(e).display !== 'none'), 'clicking the tab opens the panel');
  const cats = await page.$$eval('#market-cats .stab', (els) => els.map((e) => e.dataset.cat));
  ok(cats.join() === 'all,voice,room,model,installed', 'one chip per kind that has items, plus All and Installed; no empty Coming soon kinds', cats.join());
  ok(await page.locator('.market-soon').count() === 0, 'no Coming soon cards');
  const grid = await page.locator('#market-list').evaluate((e) => getComputedStyle(e).gridTemplateColumns.split(' ').length);
  ok(grid >= 2, 'the list is a grid of cards', String(grid));
  const anatomy = await page.$$eval('.market-card[data-id]', (els) => els.map((c) => ({ id: c.dataset.id, icon: Boolean(c.querySelector('.market-icon svg path')), name: (c.querySelector('.k') || {}).textContent, desc: (c.querySelector('.d') || {}).textContent, chip: (c.querySelector('.market-chip') || {}).textContent, ctl: Boolean(c.querySelector('.market-ctl button, .market-ctl .market-status')) })));
  ok(anatomy.length === 8 && anatomy.every((a) => a.icon && a.name && a.desc && a.chip && a.ctl), 'every card has an icon, a name, a line, a category chip and an action or a status', anatomy);
  const kokoro = card(page, 'voice.kokoro-82m');
  ok(await kokoro.locator('.market-chip.rec').count() === 1, 'Kokoro is Recommended');
  ok((await kokoro.locator('button.market-go').innerText()) === EN['market.install'], 'Kokoro has an Install button');
  ok((await card(page, 'os.voice').locator('.market-status').innerText()) === EN['market.status.builtin'] && await card(page, 'os.voice').locator('button').count() === 0, 'the Windows voice reads Built in, with no button');
  ok(await page.locator('#tab-market button[disabled]').count() === 0, 'no dead button: what cannot run has words, not a greyed button');
  ok(!(await page.locator('#tab-market').innerText()).match(/SAMPLE|lorem/i), 'no sample text');
  ok(!(await page.locator('#tab-market').innerText()).match(/USD|\$\d/i), 'no paid item');
  await shot(page, 'market-store-en-1366x768');
  // The detail panel: description, permissions, version, size, source.
  const d = await detail(page).textContent(); // textContent: the headings are upper-cased by CSS only
  for (const k of ['market.f.permissions', 'market.need.runs-code', 'market.need.model-download', 'market.f.version', 'market.f.size', 'market.f.source', 'market.f.licence', 'market.f.price']) ok(d.includes(EN[k]), `details show ${k}`);
  ok(d.includes('github.com') && d.includes('1.2.1') && d.includes('83 MB'), 'details carry the real source, version and size', d);
  await card(page, 'model.other').click();
  ok((await detail(page).innerText()).includes('Second model') && (await detail(page).innerText()).includes(EN['market.need.data-only']), 'clicking a card shows its details; a model needs nothing');
  ok(errors.length === 0, 'no page error', errors.join(' | '));
  await page.close();
}
// ---------- 2. categories and search are real ----------
{
  const { page } = await open();
  const ids = () => page.$$eval('.market-card[data-id]', (els) => els.map((e) => e.dataset.id));
  await page.locator('[data-cat="voice"]').click();
  ok((await ids()).join() === 'voice.kokoro-82m,os.voice', 'Voices shows only voices', (await ids()).join());
  await page.locator('[data-cat="room"]').click();
  ok((await ids()).join() === 'room.current,room.cozy-study,room.zen-garden', 'Rooms lists the rooms of the stage picker', (await ids()).join());
  await page.locator('[data-cat="model"]').click();
  ok((await ids()).join() === 'model.zumi-default,model.other,model.user', 'Models lists the models of the stage picker', (await ids()).join());
  ok((await page.locator('[data-cat="model"] .n').innerText()) === '3', 'a chip counts its items');
  await page.locator('[data-cat="all"]').click();
  await page.locator('#market-search').fill('kokoro');
  ok((await ids()).join() === 'voice.kokoro-82m', 'search narrows the list', (await ids()).join());
  await page.locator('#market-search').fill('hexgrad');
  ok((await ids()).join() === 'voice.kokoro-82m', 'search finds an author too', (await ids()).join());
  await page.locator('#market-search').fill('nothing like this');
  ok((await ids()).length === 0 && (await page.locator('#market-list').innerText()).includes(EN['market.none.search']), 'search with no hit says so');
  await page.locator('#market-search').fill('');
  await page.locator('[data-cat="installed"]').click();
  const here = await ids();
  ok(!here.includes('voice.kokoro-82m') && here.includes('os.voice') && here.includes('room.cozy-study'), 'Installed leaves out what is not installed', here.join());
  await page.close();
}
// ---------- 3. Use is the stage's own switch ----------
{
  const { page } = await open();
  await page.locator('[data-cat="room"]').click();
  await card(page, 'room.cozy-study').locator('button').click();
  await page.waitForFunction(() => window.__picked.some((p) => p[0] === 'room' && p[1] === 'cozy-study'), null, { timeout: 5000 });
  ok(await page.locator('#scene-select').inputValue() === 'cozy-study', 'Use on a room moves the stage picker');
  ok((await card(page, 'room.cozy-study').locator('.market-status').innerText()) === EN['market.status.inuse'] && await card(page, 'room.cozy-study').locator('button').count() === 0, 'the room reads In use');
  await page.locator('[data-cat="model"]').click();
  ok(!(await card(page, 'model.user').innerText()).includes('Zumia'), 'a model he imported is not credited to Zumia', await card(page, 'model.user').innerText());
  await card(page, 'model.other').locator('button').click();
  await page.waitForFunction(() => window.__picked.some((p) => p[0] === 'model' && p[1] === 'other'), null, { timeout: 5000 });
  ok((await card(page, 'model.other').locator('.market-status').innerText()) === EN['market.status.inuse'], 'Use on a model selects it');
  await page.close();
}
// ---------- 4. Install (progress), Installed, Remove from the details, on disk ----------
{
  const { page, dataDir, gate } = await open();
  let open_; gate.hold = new Promise((r) => { open_ = r; });
  const pack = path.join(dataDir, 'packs', 'voice.kokoro-82m', 'zumi-pack.json');
  const kokoro = card(page, 'voice.kokoro-82m');
  await kokoro.locator('button.market-go').click();
  await page.waitForFunction(() => document.querySelector('.market-card[data-id="voice.kokoro-82m"] .market-bar[role="progressbar"]'), null, { timeout: 5000 });
  ok(await kokoro.locator('button').count() === 0, 'while installing there is a progress bar and no button');
  ok(await kokoro.locator('.market-chip').count() === 0, 'while installing the bar has the row to itself: no chip under it');
  await shot(page, 'market-installing-en-1366x768');
  open_();
  await installed(page, 'voice.kokoro-82m');
  ok(fs.existsSync(pack), 'Install really wrote the pack');
  ok((await kokoro.locator('.market-status').innerText()) === EN['market.status.installed'] && await kokoro.locator('.market-bar').count() === 0, 'then the card reads Installed');
  await kokoro.click();
  ok(await detail(page).locator('button[data-act="remove"]').count() === 1, 'the details offer Remove');
  await shot(page, 'market-installed-en-1366x768');
  await page.locator('[data-cat="installed"]').click();
  ok(await kokoro.count() === 1, 'Installed now lists it');
  await page.locator('[data-cat="all"]').click();
  await detail(page).locator('button[data-act="remove"]').click();
  await page.waitForFunction(() => document.querySelector('.market-card[data-id="voice.kokoro-82m"] button.market-go'), null, { timeout: 5000 });
  ok(!fs.existsSync(pack), 'Remove really deleted it, and Install is back');
  await page.close();
}
// ---------- 5. failures are sentences, and nothing is installed ----------
for (const [code, o] of [['download_failed', { net: 404 }], ['sha_mismatch', { serverBytes: Buffer.concat([goodZip.subarray(0, -1), Buffer.from([1])]) }], ['offline', { net: 'offline' }]]) {
  const { page, dataDir, gate } = await open(o);
  await card(page, 'voice.kokoro-82m').locator('button.market-go').click();
  await page.waitForSelector('.market-card[data-id="voice.kokoro-82m"] .market-err', { timeout: 8000 });
  ok((await card(page, 'voice.kokoro-82m').locator('.market-err').innerText()) === EN[`market.err.${code}`], `${code}: a plain sentence on the card`);
  ok(await card(page, 'voice.kokoro-82m').locator('button.market-go').count() === 1, `${code}: Install stays, so he can retry`);
  ok(!fs.existsSync(path.join(dataDir, 'packs', 'voice.kokoro-82m')), `${code}: nothing was installed`);
  if (code === 'sha_mismatch') await shot(page, 'market-hash-refused-en-1366x768');
  if (code === 'offline') { // the network is back: the same button installs
    gate.net = 'ok';
    await card(page, 'voice.kokoro-82m').locator('button.market-go').click();
    await installed(page, 'voice.kokoro-82m');
    ok(await card(page, 'voice.kokoro-82m').locator('.market-err').count() === 0, 'offline, then online: the retry installs and the error goes');
  }
  await page.close();
}
// ---------- 6. a Release asset: offline reads Offline with Retry; not published reads Not available yet ----------
{
  const rel = [item(goodZip, { download: { url: 'https://github.com/x/packs/k.zip', sha256: sha256(goodZip), bytes: goodZip.length, releaseAsset: true } })];
  const { page, gate } = await open({ catalog: rel, net: 'offline' });
  await page.waitForFunction(() => { const c = document.querySelector('.market-card[data-id="voice.kokoro-82m"]'); return c && c.dataset.state === 'offline'; }, null, { timeout: 8000 });
  const k = card(page, 'voice.kokoro-82m');
  ok((await k.locator('.market-status').innerText()) === EN['market.status.offline'] && (await k.locator('button').innerText()) === EN['market.retry'], 'offline: the card says Offline and offers Retry');
  ok(await k.locator('.market-chip.rec').count() === 1, 'offline: still Recommended, it is only the network');
  await shot(page, 'market-offline-en-1366x768');
  await k.locator('button').click();
  await page.waitForSelector('.market-card[data-id="voice.kokoro-82m"] .market-err', { timeout: 8000 });
  ok((await k.locator('.market-err').innerText()) === EN['market.err.offline'], 'Retry while offline: the offline sentence');
  gate.net = 'ok';
  await k.locator('button').click();
  await installed(page, 'voice.kokoro-82m');
  ok(true, 'Retry once online: it installs');
  await page.close();
  const gone = await open({ catalog: rel, net: 404 });
  await gone.page.waitForTimeout(300);
  const g = card(gone.page, 'voice.kokoro-82m');
  ok((await g.locator('.market-status').innerText()) === EN['market.status.unavailable'] && await g.locator('button').count() === 0 && await g.locator('.market-chip.rec').count() === 0, 'not published: Not available yet, no button, not Recommended');
  await gone.page.close();
}
// ---------- 7. Update: an older pack on disk, a newer one in the catalog ----------
{
  const dataDir = path.join(tmp, `d${++run}`);
  await createMarketHost({ dataDir, catalog: [item(goodZip)], fetchImpl: async () => ({ ok: true, status: 200, headers: new Headers(), body: new Blob([goodZip]).stream() }), model: { present: () => true, download: async () => true, stop() {}, remove() {} } }).handlers['market.install']('voice.kokoro-82m');
  const { page } = await open({ dataDir, catalog: [item(newerZip, { version: '1.3.0' })], serverBytes: newerZip });
  const k = card(page, 'voice.kokoro-82m');
  ok((await k.locator('button.market-go').innerText()) === EN['market.update'], 'an older pack: the card offers Update');
  ok((await detail(page).innerText()).includes('1.2.1') && (await detail(page).innerText()).includes('1.3.0'), 'the details show both versions');
  await shot(page, 'market-update-en-1366x768');
  await k.locator('button.market-go').click();
  await installed(page, 'voice.kokoro-82m');
  ok(JSON.parse(fs.readFileSync(path.join(dataDir, 'packs', 'voice.kokoro-82m', 'zumi-pack.json'), 'utf8')).version === '1.3.0', 'Update put the new pack on disk');
  await page.close();
}
// ---------- 8. the owner build: Kokoro in the installer ----------
{
  const { page } = await open({ bundled: true });
  const kokoro = card(page, 'voice.kokoro-82m');
  ok((await kokoro.locator('.market-status').innerText()) === EN['market.status.builtin'] && await kokoro.locator('button').count() === 0, 'owner build: Kokoro reads Built in, no Install, no Remove', await kokoro.innerText());
  ok(!(await detail(page).innerText()).includes(EN['market.item.voice_kokoro_82m.note']), 'owner build: the details do not talk about installing what is already here');
  await page.close();
}
// ---------- 9. layout: nothing cut, three languages, three sizes ----------
for (const [w, h] of [[1680, 987], [1366, 768], [900, 600]]) for (const lang of ['en', 'vi', 'zh']) {
  const { page, errors } = await open({ w, h, lang });
  const m = await page.evaluate(() => {
    const out = [];
    const panel = document.getElementById('tab-market').getBoundingClientRect();
    for (const e of document.querySelectorAll('#tab-market .market-card, #tab-market .market-ctl, #tab-market .toolbar, #market-cats, .market-side')) { const r = e.getBoundingClientRect(); if (r.width && r.right > panel.right + 1) out.push(e.className || e.id); }
    // A card's action never spills out of its card.
    for (const c of document.querySelectorAll('.market-card')) { const r = c.getBoundingClientRect(); for (const x of c.querySelectorAll('.market-ctl > *')) { const q = x.getBoundingClientRect(); if (q.right > r.right + 1 || q.left < r.left - 1) out.push(`ctl in ${c.dataset.id}`); } }
    const c = document.getElementById('market-list');
    return { overflow: out, hscroll: c.scrollWidth > c.clientWidth + 1, foot: document.querySelector('.market-foot').getBoundingClientRect().bottom <= innerHeight + 1, side: document.querySelector('.market-side').getBoundingClientRect().height > 60 };
  });
  ok(!m.overflow.length && !m.hscroll && m.foot, `${lang} ${w}x${h}: nothing runs off the window`, m);
  ok(m.side, `${lang} ${w}x${h}: the details stay on screen, so Remove is reachable`, m);
  await page.locator('.market-card').last().scrollIntoViewIfNeeded();
  ok(await page.locator('.market-card').last().isVisible(), `${lang} ${w}x${h}: the last card can be reached`);
  ok(!errors.length, `${lang} ${w}x${h}: no page error`, errors.join(' | '));
  if (shotsDir && (lang === 'en' || w === 1366)) await shot(page, `market-store-${lang}-${w}x${h}`);
  await page.close();
}
await browser.close();
server.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`check:market-ui: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
