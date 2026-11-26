// T-31-MOBILE B2 (vendor bump to Laneboard b6d8417): the Board tab's Home shows the important-news feed (vendor/laneboard/public/news.js)
// with the coordinator's cos-report / cos-event under their feedback.kind.* labels, and no supervisor noise (nudges of every level,
// idle notices), through BOTH hosts that serve the vendored page, in a headless Chromium (no app window):
//   T  Tauri: the REAL sidecar (tauri/sidecar/main.mjs, owner test flavour) and its REAL bridge (board-host.mjs -> board-bridge.mjs),
//      upstream = a local stub of the live board (scratch vendored Laneboard behind an nginx-shaped shim; ZUMI_BOARD_UPSTREAM is
//      loopback-only and honoured only in a test flavour). The page the owner's Board tab loads.
//   E  Electron / local board: src/main/laneboard-host.mjs openLocalBoard over a copy of the same fixture data dir (also what the
//      Tauri sidecar opens for a local board, tauri/sidecar/main.mjs).
// Fixture: scripts/lib/news-fixture.mjs (the board's own write path and timers: an R1 chain L1 -> L3, R4 idle chains, a cos-report on
// NEWS linked to E-1, a cos-event on W-2, a reply, an owner status re-brief, an owner note). Nothing reaches a live board.
// Red: on a tree whose vendor/laneboard predates the B2 news feed (ce780d8, the 9.7 tree) the Home has no feed: rows fail.
//
//   ZUMI_VAULT_EXE=<zumi-vault.exe> [ZUMI_PLAYWRIGHT_DIR=..] [ZUMI_CHROMIUM=..] [NEWS_SHOTS=<dir>] node scripts/check-tauri-board-news.mjs
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createBoard } from '../vendor/laneboard/src/board.mjs';
import { createServer } from '../vendor/laneboard/src/server.mjs';
import { openLocalBoard } from '../src/main/laneboard-host.mjs';
import { ownerPath } from './lib/owner-paths.mjs';
import { buildNewsFixture, NEWS_FIXTURE } from './lib/news-fixture.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const LB = path.join(ROOT, 'vendor', 'laneboard');
const SHOTS = process.env.NEWS_SHOTS ? path.resolve(process.env.NEWS_SHOTS) : null;
let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}  ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 600)}`); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(pred, ms, step = 200) { const end = Date.now() + ms; while (Date.now() < end) { const v = await pred(); if (v) return v; await wait(step); } return null; }

const HELPER = process.env.ZUMI_VAULT_EXE ? path.resolve(process.env.ZUMI_VAULT_EXE) : null;
if (!HELPER || !fs.existsSync(HELPER)) { console.log('FAIL set ZUMI_VAULT_EXE to a built zumi-vault.exe'); process.exit(1); }
const PW_DIR = process.env.ZUMI_PLAYWRIGHT_DIR || ownerPath('playwrightDir', 'node_modules/playwright');
const EXE = process.env.ZUMI_CHROMIUM || ownerPath('chromiumExe', 'local/chrome.exe');
const { chromium } = createRequire(path.join(ROOT, 'package.json'))(PW_DIR);
const VI = JSON.parse(fs.readFileSync(path.join(LB, 'public', 'locales', 'vi.json'), 'utf8'));
const kindOf = (cls) => String(cls).split(/\s+/).map((c) => c.slice(5)).find((k) => k && !["item", "status"].includes(k)); // li class "news-item news-<kind>[ news-status]"
const LABEL = { 'cos-report': 'Cập nhật tiến độ', 'cos-event': 'Sự kiện', reply: 'Trả lời' };

const work = fs.mkdtempSync(path.join(ROOT, '.tauri-check-tmp-news-'));
const fixtureDir = path.join(work, 'fixture');
await buildNewsFixture({ laneboardDir: LB, dataDir: fixtureDir });

// ---- the stub upstream: the fixture board + nginx-shaped shim (Basic auth on /zumia/, the proxy-owner header set by the shim) ----
const upDir = path.join(work, 'upstream');
fs.cpSync(fixtureDir, upDir, { recursive: true });
const board = createBoard({ dataDir: upDir });
const OWNER = fs.readFileSync(path.join(upDir, 'owner.token'), 'utf8').trim();
const view = board.view(OWNER);
const kinds = (k) => view.messages.filter((m) => m.kind === k);
const levels = kinds('nudge').map((m) => view.feedback.find((f) => f.id === m.id)?.level);
ok([1, 2, 3].every((l) => levels.includes(l)) && kinds('idle').length >= 1 && kinds('rebrief').length === 1 && kinds('cos-report').length === 1 && kinds('cos-event').length === 1,
  'N0 the fixture holds the noise (nudges L1, L2, L3, idle, a status re-brief) and the news (cos-report, cos-event)', { levels, idle: kinds('idle').length });
const PROXY_SECRET = `shim-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
const boardServer = createServer(board, { ownerProxySecret: PROXY_SECRET });
const boardPort = await new Promise((r) => boardServer.listen(0, '127.0.0.1', () => r(boardServer.address().port)));
const USER = 'news-check-user', PASS = 'news-check-pass-8w8w';
const BASIC = `Basic ${Buffer.from(`${USER}:${PASS}`, 'utf8').toString('base64')}`;
const shim = http.createServer((req, res) => {
  if (!req.url.startsWith('/zumia/')) { res.writeHead(404); return res.end('{"error":"not_found"}'); }
  if (req.headers.authorization !== BASIC) { res.writeHead(401); return res.end('{"error":"bad_basic"}'); }
  const headers = { ...req.headers }; delete headers.host;
  headers['x-laneboard-owner-proxy'] = PROXY_SECRET;
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const up = http.request({ host: '127.0.0.1', port: boardPort, path: req.url.slice('/zumia'.length), method: req.method, headers }, (u) => { res.writeHead(u.statusCode, u.headers); u.pipe(res); });
    up.end(Buffer.concat(chunks));
  });
});
const shimPort = await new Promise((r) => shim.listen(0, '127.0.0.1', () => r(shim.address().port)));

// ---- the real sidecar, owner test flavour ----
async function startSidecar() {
  const hostDir = path.join(work, 'host-owner');
  fs.mkdirSync(hostDir, { recursive: true });
  fs.writeFileSync(path.join(hostDir, 'flavour.json'), `${JSON.stringify({ v: 1, cloudBase: null, test: true, reflexEgress: false, ownerAdmin: true, boardMirror: null }, null, 2)}\n`);
  fs.copyFileSync(HELPER, path.join(hostDir, 'zumi-vault.exe'));
  const dataDir = path.join(work, 'data-owner');
  fs.mkdirSync(dataDir, { recursive: true });
  const args = [path.join(ROOT, 'tauri', 'sidecar', 'main.mjs'), '--data-dir', dataDir, '--no-voice-prefetch', '--vault-exe', path.join(hostDir, 'zumi-vault.exe'), '--host-dir', hostDir, '--flavour', path.join(hostDir, 'flavour.json')];
  const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ZUMI_BOARD_UPSTREAM: `http://127.0.0.1:${shimPort}/zumia` } });
  const s = { child, pending: new Map(), nextId: 1, stderr: '' };
  child.stderr.on('data', (d) => { s.stderr += d.toString(); });
  let readyResolve; const ready = new Promise((r) => { readyResolve = r; });
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let m; try { m = JSON.parse(line); } catch { return; }
    if (m.method === 'ready') readyResolve();
    else if (m.id != null && s.pending.has(m.id)) { const p = s.pending.get(m.id); s.pending.delete(m.id); p(m); }
  });
  child.on('exit', () => { for (const p of s.pending.values()) p({ error: { message: 'sidecar_exited' } }); s.pending.clear(); });
  s.call = (method, params = []) => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve({ error: 'sidecar_exited' });
    const id = s.nextId++;
    s.pending.set(id, (m) => resolve(m.error ? { error: String(m.error.message || m.error) } : m.result));
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  if (!(await Promise.race([ready.then(() => true), wait(20000).then(() => false)]))) throw new Error(`sidecar not ready: ${s.stderr.slice(-400)}`);
  return s;
}

// ---- what the Home's news section shows ----
const feedOf = (page) => page.evaluate(() => {
  const sec = document.querySelector('section.news');
  if (!sec) return null;
  return {
    title: (sec.querySelector('h2') || {}).textContent || '',
    toggle: (sec.querySelector('.news-toggle') || {}).textContent || '',
    items: [...sec.querySelectorAll('li.news-item')].map((li) => ({
      cls: li.className, chip: (li.querySelector('.chip') || {}).textContent || '', lead: (li.querySelector('.news-lead') || {}).textContent || '',
      body: (li.querySelector('.news-body') || {}).textContent || '', href: (li.querySelector('a.news-link') || { getAttribute: () => '' }).getAttribute('href') || '',
    })),
  };
});
async function checkHome(tag, page) {
  const f = await until(async () => { const x = await feedOf(page); return x && x.items.length ? x : null; }, 20000);
  ok(f && f.title === VI['news.title'] && f.title === 'Tin quan trọng', `${tag}1 the Home shows the news section "Tin quan trọng"`, f);
  if (!f) return;
  const kindsShown = f.items.map((x) => kindOf(x.cls));
  ok(JSON.stringify(kindsShown) === JSON.stringify(['reply', 'cos-event', 'cos-report']), `${tag}2 three news items, newest first: reply, cos-event, cos-report`, kindsShown);
  // T-31-ALPHA11: cos-report reads "Cập nhật tiến độ" as on the live board (J-05 17-11, Laneboard 988ecc6), not B2's "Báo cáo"; one label for both
  ok(f.items.every((x) => x.chip === LABEL[kindOf(x.cls)]) && VI['feedback.kind.cos-report'] === 'Cập nhật tiến độ' && VI['feedback.kind.cos-event'] === 'Sự kiện',
    `${tag}3 labels from feedback.kind.*: cos-report "Cập nhật tiến độ", cos-event "Sự kiện", reply "Trả lời"`, f.items.map((x) => x.chip));
  const noise = f.items.filter((x) => /news-(nudge|idle|rebrief)/.test(x.cls) || /\[R\d|Đứng yên|Chưa nhận sau/.test(x.body + x.lead));
  ok(noise.length === 0, `${tag}4 no nudge (L1-L3), idle or status re-brief row in the feed`, noise);
  const rep = f.items.find((x) => x.cls.includes('news-cos-report'));
  ok(rep && rep.lead === NEWS_FIXTURE.report.split('\n')[0] && rep.href === '#/task/E-1' && !f.items.some((x) => x.href.includes('NEWS')),
    `${tag}5 the report's Chốt line is bold and the NEWS item links its first related task (#/task/E-1, never #/task/NEWS)`, rep);
  ok(/Hiện cả nhắc trạng thái \(1\)/.test(f.toggle), `${tag}6 the toggle counts the one hidden status re-brief`, f.toggle);
  return f;
}
async function toggleAndOpen(tag, page) {
  await page.click('section.news .news-toggle');
  const g = await until(async () => { const x = await feedOf(page); return x && x.items.length === 4 ? x : null; }, 8000);
  ok(g && g.items.filter((x) => x.cls.includes('news-status')).length === 1 && !g.items.some((x) => /news-(nudge|idle)/.test(x.cls)),
    `${tag}7 with the toggle on: the re-brief shows (one status row), still no nudge or idle row`, g && g.items.map((x) => x.cls));
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${tag}-home-news-toggle-on.png`) });
  await page.click('section.news .news-toggle');
  await page.click('section.news li.news-cos-report a.news-link');
  const h = await until(() => page.evaluate(() => location.hash.startsWith('#/task/E-1') && location.hash), 8000);
  ok(h, `${tag}8 tapping the report opens its task (E-1)`, await page.evaluate(() => location.hash));
}

const browser = await chromium.launch({ executablePath: EXE, headless: true, timeout: 60000 });
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
let sc = null, local = null;
try {
  // ---- T: Tauri sidecar + bridge (the owner's Board tab) ----
  sc = await startSidecar();
  const sign = await sc.call('board.setSecretsOs', [{ user: USER, pass: PASS }]);
  const mode = await sc.call('board.setMode', ['live']);
  ok(sign && sign.ok && mode && mode.ok, 'T0 the sidecar boots, signs in like the Board card and goes live (the bridge serves the vendored page)', { sign, mode });
  const r = await sc.call('board.liveOpen');
  ok(r && r.openUrl, 'T0b board.liveOpen answers a session URL', r);
  if (r && r.openUrl) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const u = new URL(r.openUrl);
    u.searchParams.set('embed', '1'); u.searchParams.set('lang', 'vi'); u.searchParams.set('local', 'open'); u.searchParams.set('zumiTheme', 'blue'); u.hash = 'theme=dark';
    await page.goto(u.href, { waitUntil: 'networkidle' });
    await page.waitForSelector('#main', { timeout: 15000 });
    await page.evaluate(() => { location.hash = '#/'; });
    const f = await checkHome('T', page);
    if (SHOTS && f) await page.screenshot({ path: path.join(SHOTS, 'T-home-news.png') });
    if (f) await toggleAndOpen('T', page);
    ok(errors.length === 0, 'T9 no page error', errors);
    await ctx.close();
  }

  // ---- E: the local board host (Electron; the Tauri sidecar's local board is the same openLocalBoard) ----
  const root = path.join(work, 'electron-root');
  fs.cpSync(fixtureDir, path.join(root, 'laneboard'), { recursive: true });
  local = await openLocalBoard({ laneboardDir: LB, root, sampleFixture: path.join(ROOT, 'src', 'main', 'sample-board.json'), lang: 'vi' });
  ok(local.outcome === 'opened' && local.alive(), 'E0 openLocalBoard boots the vendored board over the fixture (opened, no re-seed)', local.outcome);
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(local.url, { waitUntil: 'networkidle' });
    await page.waitForSelector('#main', { timeout: 15000 });
    const f = await checkHome('E', page);
    if (SHOTS && f) await page.screenshot({ path: path.join(SHOTS, 'E-home-news.png') });
    if (f) await toggleAndOpen('E', page);
    ok(errors.length === 0, 'E9 no page error', errors);
    await ctx.close();
  }
} catch (e) {
  ok(false, 'the run finished', e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : String(e));
} finally {
  await browser.close().catch(() => {});
  if (local) local.close();
  if (sc) { sc.child.stdin.end(); await until(() => sc.child.exitCode !== null || sc.child.signalCode !== null, 5000); if (sc.child.exitCode === null) sc.child.kill(); }
  shim.close(); boardServer.close(); board.close();
  await wait(300);
  fs.rmSync(work, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
