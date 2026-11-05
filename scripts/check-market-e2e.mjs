#!/usr/bin/env node
// check:market-e2e (T-31 Marketplace, 05-11). Installs EVERY item of the shipped catalog (tauri/sidecar/market-host.mjs CATALOG) by clicking
// its card in the built renderer, from the real package bytes, through the real host, egress guard, sha256 pin and package validator.
// The only stand-in is the server: each catalog URL is answered by a local mirror of the same file, so the run proves the app side
// whether or not the file is on GitHub yet (check-packs-asset / check-packs-public ask GitHub). The Kokoro model download (Hugging Face, 163 MB)
// is a stub here; check:kokoro-download-redirect covers it.
//   node scripts/check-market-e2e.mjs [--packs <dir>] [--shots <dir>] [--out <result.json>]
//   --packs: a folder holding each item's zip under its download file name; a missing Kokoro zip is rebuilt from this tree.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ownerPath } from './lib/owner-paths.mjs';
import { sha256 } from './lib/zip-write.mjs';
import { MARKET_STUB } from './lib/market-stub.mjs';
import { CATALOG, createMarketHost } from '../tauri/sidecar/market-host.mjs';
import { marketFetch } from '../tauri/sidecar/egress.mjs';
import { validatePackDir } from '../tauri/sidecar/market-standard.mjs';
import { TABLES } from '../src/renderer/i18n.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(ROOT, 'package.json'));
const args = process.argv.slice(2);
const arg = (k) => (args.includes(k) ? path.resolve(args[args.indexOf(k) + 1]) : null);
const shotsDir = arg('--shots');
if (shotsDir) fs.mkdirSync(shotsDir, { recursive: true });
let pass = 0, fail = 0;
const ok = (c, name, detail = '') => { if (c) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`); } };
const EN = TABLES.en;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zumi-market-e2e-'));
const results = [];

// ---------- the package bytes for every listed item ----------
const packsDir = arg('--packs') || path.join(tmp, 'packs-src');
fs.mkdirSync(packsDir, { recursive: true });
const zips = new Map(); // catalog url -> bytes
for (const c of CATALOG) {
  const file = path.join(packsDir, path.basename(new URL(c.download.url).pathname));
  if (!fs.existsSync(file) && c.id === 'voice.kokoro-82m') execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'market-pack-kokoro.mjs'), '--out', file], { cwd: ROOT, stdio: 'ignore', timeout: 600000 });
  const bytes = fs.existsSync(file) ? fs.readFileSync(file) : null;
  ok(Boolean(bytes), `${c.id}: a package exists`, file);
  ok(bytes && sha256(bytes) === c.download.sha256 && bytes.length === c.download.bytes, `${c.id}: the package equals the catalog pin`, bytes ? `${sha256(bytes)} ${bytes.length}` : 'none');
  if (bytes) zips.set(c.download.url, bytes);
}

// ---------- the mirror: same path as the catalog URL, HEAD and GET ----------
let tamper = false;
const mirror = http.createServer((q, s) => {
  const hit = [...zips.entries()].find(([u]) => new URL(u).pathname === new URL(q.url, 'http://x').pathname);
  if (!hit) { s.writeHead(404); return s.end(); }
  const body = tamper ? Buffer.concat([hit[1].subarray(0, -1), Buffer.from([hit[1][hit[1].length - 1] ^ 1])]) : hit[1];
  s.writeHead(200, { 'content-type': 'application/zip', 'content-length': body.length });
  s.end(q.method === 'HEAD' ? undefined : body);
});
await new Promise((r) => mirror.listen(0, '127.0.0.1', r));
const mirrored = [];
// The app's own guard sees the real catalog URL (github.com); only after it says yes does the request go to the mirror.
const viaMirror = async (url, init) => { const u = new URL(url); mirrored.push(u.origin); return fetch(`http://127.0.0.1:${mirror.address().port}${u.pathname}`, { ...init, redirect: 'manual' }); };
const fetchImpl = marketFetch(viaMirror);

// ---------- the page ----------
execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-renderer.mjs')], { cwd: ROOT, stdio: 'ignore', timeout: 300000 });
const { chromium } = req(process.env.ZUMI_PLAYWRIGHT_DIR || ownerPath('playwrightDir', 'node_modules/playwright'));
const BUILD = path.join(ROOT, 'build', 'renderer');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png' };
const web = http.createServer((q, s) => {
  const p = decodeURIComponent(new URL(q.url, 'http://x').pathname);
  const file = p === '/tokens.css' ? path.join(ROOT, 'vendor', 'laneboard', 'public', 'tokens.css') : path.join(BUILD, p === '/' ? 'index.html' : p);
  if (!path.resolve(file).startsWith(path.resolve(ROOT))) { s.writeHead(403); return s.end(); }
  fs.readFile(file, (e, buf) => { if (e) { s.writeHead(404); return s.end(); } s.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' }); s.end(buf); });
});
await new Promise((r) => web.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ executablePath: process.env.ZUMI_CHROMIUM || ownerPath('chromiumExe', 'local/chrome.exe'), headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], timeout: 60000 });
const dataDir = path.join(tmp, 'data');
fs.mkdirSync(dataDir);
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
const errors = []; page.on('pageerror', (e) => errors.push(String(e.message).split('\n')[0]));
const model = { here: false, calls: 0, present() { return this.here; }, async download(cb) { this.calls++; cb({ loaded: 1, total: 1 }); this.here = true; return true; }, stop() {}, remove() { this.here = false; } };
const host = createMarketHost({ dataDir, fetchImpl, bundled: () => false, model, emit: (c, p) => { page.evaluate((x) => window.__marketProgress(x), p).catch(() => {}); return true; } });
await page.exposeFunction('__market', (name, id) => host.handlers[`market.${name}`](id));
await page.addInitScript('window.__uiLang = "en";');
await page.addInitScript(MARKET_STUB);
await page.goto(`http://127.0.0.1:${web.address().port}/index.html`, { waitUntil: 'load' });
await page.waitForFunction(() => document.querySelector('#market-cats .stab'), null, { timeout: 30000 });
await page.locator('.tab[data-tab="market"]').click();
const stateOf = (id) => page.locator(`.market-card[data-id="${id}"]`).getAttribute('data-state');
const waitState = (id, want, ms = 120000) => page.waitForFunction(([i, w]) => { const c = document.querySelector(`.market-card[data-id="${i}"]`); return c && c.dataset.state === w; }, [id, want], { timeout: ms });

for (const c of CATALOG) {
  const row = { id: c.id, version: c.version, bytes: c.download.bytes, sha256: c.download.sha256, listed: false, install: 'not run', files: 0, remove: 'not run', hashRefused: 'not run' };
  results.push(row);
  const cardSel = page.locator(`.market-card[data-id="${c.id}"]`);
  row.listed = await cardSel.count() === 1;
  ok(row.listed, `${c.id}: listed as a card`);
  if (!row.listed || !zips.has(c.download.url)) continue;
  await waitState(c.id, 'available', 15000).catch(() => {});
  ok(await stateOf(c.id) === 'available', `${c.id}: offered for install once the server has it`, await stateOf(c.id));
  // A tampered download is refused and leaves nothing.
  tamper = true;
  await cardSel.locator('button.market-go').click();
  await page.waitForSelector(`.market-card[data-id="${c.id}"] .market-err`, { timeout: 120000 });
  const refused = await cardSel.locator('.market-err').innerText();
  row.hashRefused = refused === EN['market.err.sha_mismatch'] && !fs.existsSync(path.join(dataDir, 'packs', c.id)) ? 'refused, nothing installed' : `NOT refused: ${refused}`;
  ok(row.hashRefused.startsWith('refused'), `${c.id}: a download that misses the pin by one bit is refused, nothing installed`, row.hashRefused);
  tamper = false;
  // The real install.
  const t0 = Date.now();
  await cardSel.locator('button.market-go').click();
  await waitState(c.id, 'installed').catch(() => {});
  const dir = path.join(dataDir, 'packs', c.id);
  const verdict = fs.existsSync(dir) ? await validatePackDir(dir, { expectId: c.id, publisher: 'zumia' }) : { ok: false, errors: [{ message: 'no folder' }], manifest: null };
  const record = JSON.parse(fs.readFileSync(path.join(dataDir, 'packs', 'installed.json'), 'utf8'))[c.id] || {};
  row.files = verdict.manifest ? verdict.manifest.files.length : 0;
  row.install = verdict.ok && record.sha256 === c.download.sha256 && await stateOf(c.id) === 'installed' ? `installed in ${((Date.now() - t0) / 1000).toFixed(1)} s` : `FAILED ${JSON.stringify(verdict.errors.slice(0, 2))}`;
  ok(row.install.startsWith('installed'), `${c.id}: Install puts a valid pack on disk (every file re-hashed), records the sha, reads Installed`, row.install);
  if (c.id === 'voice.kokoro-82m') {
    const entry = path.join(dir, 'voice-modules', 'node_modules', 'kokoro-js', 'dist', 'kokoro.js');
    ok(fs.existsSync(entry) && model.calls === 1, 'voice.kokoro-82m: the runtime the app loads is where kokoro-tts.js looks, and the model step ran');
    // The installed runtime really loads: kokoro-js, transformers and the onnxruntime binding from the pack, in a child that exits before Remove.
    let loaded = '';
    try { loaded = execFileSync(process.execPath, ['--input-type=module', '-e', `const m = await import(${JSON.stringify(new URL(`file:///${entry.replace(/\\/g, '/')}`).href)}); console.log(typeof m.KokoroTTS)`], { cwd: tmp, encoding: 'utf8', timeout: 120000 }).trim(); } catch (e) { loaded = String(e.stderr || e.message).split('\n')[0]; }
    row.runtime = loaded === 'function' ? 'loads (KokoroTTS)' : `does not load: ${loaded}`;
    ok(loaded === 'function', 'voice.kokoro-82m: the installed runtime loads in Node (KokoroTTS is exported)', loaded);
  }
  await cardSel.click();
  if (shotsDir) await page.screenshot({ path: path.join(shotsDir, `e2e-${c.id}-installed-en-1366x768.png`) });
  await page.locator('#market-detail button[data-act="remove"]').click();
  await waitState(c.id, 'available', 15000).catch(() => {});
  row.remove = !fs.existsSync(dir) && await stateOf(c.id) === 'available' ? 'removed' : 'FAILED';
  ok(row.remove === 'removed', `${c.id}: Remove deletes the pack and offers Install again`, row.remove);
}
ok(mirrored.length > 0 && mirrored.every((o) => o === 'https://github.com'), 'every request passed the app\'s egress guard as a github.com request', [...new Set(mirrored)].join());
ok(!errors.length, 'no page error', errors.join(' | '));
await browser.close();
web.close(); mirror.close();
console.log('\n| item | version | download | listed | install | files | runtime | tampered download | remove |\n|---|---|---|---|---|---|---|---|---|');
for (const r of results) console.log(`| ${r.id} | ${r.version} | ${(r.bytes / 1048576).toFixed(1)} MB | ${r.listed ? 'yes' : 'no'} | ${r.install} | ${r.files} | ${r.runtime || 'n/a'} | ${r.hashRefused} | ${r.remove} |`);
if (arg('--out')) fs.writeFileSync(arg('--out'), `${JSON.stringify({ tool: 'scripts/check-market-e2e.mjs', at: new Date().toISOString(), catalogItems: CATALOG.length, model: 'stub (no Hugging Face download)', results, pass, fail }, null, 2)}\n`);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`check:market-e2e: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
