// T-31 pin-owner (owner report 14-11: "T-31 tính năng pin task chưa hoạt động trên board thì phải anh pin thử không thấy phần Pin
// ở đâu"). The Board tab's Pin, end to end, through the REAL sidecar and its REAL bridge, in a headless Chromium (no app window).
//
// Upstream = a LOCAL stub of the live board: a scratch vendor/laneboard (the real whoami / pin.set / state routes) behind an
// nginx-shaped shim (Basic auth on the whole /zumia/ path, the proxy-owner header set by the shim itself, as on the VPS). The real
// live board is never named: the sidecar runs a `test` flavour, so ZUMI_BOARD_UPSTREAM (loopback only) is honoured.
//
// Flavours (flavour.json beside the host dir, exactly what a build writes):
//   owner  = the board-relevant owner values (test=true, ownerAdmin=true) with cloud/reflex/mirror egress off, so this run
//            reaches nothing but the loopback stub. board-host.mjs reads only `test` and `ownerAdmin`.
//   public = the same with ownerAdmin=false: the bridge's page channel keeps OWNER_OPS (pin.set) refused.
// Rows:
//   A owner, signed in like the sign-in card (user + password, no token): whoami through the bridge says owner; the page's
//     isOwner() is true; the Pin toggle is in the rail and the task header; a click reaches the stub as pin.set
//     {pinned:true} on T-31 with a zumi-ui- request id; the board has T-31 pinned and the Home "Đang ghim" strip shows it; a
//     second click unpins.
//   B owner, signed in WITH a non-owner token in the optional token field: X-Laneboard-Token alone decides identity
//     (vendor/laneboard/src/server.mjs), so the page is that token's role and shows no Pin. The only identity loss reachable here.
//   C ownerAdmin=false: the page's pin.set is refused by the bridge (403 forbidden_op, logged), and the stub never sees it.
//   D public, the real shape: a scratch export of HEAD WITHOUT src/main/owner-values.json and no flavour file. There is no
//     live origin, so live mode is refused and no live Board page (and no owner Pin) exists.
// Row A also pins the header label (owner follow-up 14-11, cause 2: the header Pin was an unlabelled grey icon): icon + "Ghim"
// when not pinned, "Đã ghim" in the pinned (.on) style when pinned, and the hover title.
// Mutation: PIN_MUT=ownerops-off runs row A with ownerAdmin=false; row A must go red. PIN_SHOTS=<dir> writes the owner
// header shots (unpinned, pinned) at 1280x800 in the app's default theme (blue: ?zumiTheme=blue#theme=dark).
//
//   ZUMI_VAULT_EXE=<zumi-vault.exe> [ZUMI_PLAYWRIGHT_DIR=..] [ZUMI_CHROMIUM=..] [PIN_MUT=ownerops-off] [PIN_SHOTS=<dir>] node scripts/check-tauri-board-pin-owner.mjs
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createBoard } from '../vendor/laneboard/src/board.mjs';
import { createServer } from '../vendor/laneboard/src/server.mjs';
import { ownerPath } from './lib/owner-paths.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MUT = process.env.PIN_MUT || '';
const SHOTS = process.env.PIN_SHOTS ? path.resolve(process.env.PIN_SHOTS) : null;
let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(pred, ms, step = 100) { const end = Date.now() + ms; while (Date.now() < end) { const v = await pred(); if (v) return v; await wait(step); } return null; }

const HELPER = process.env.ZUMI_VAULT_EXE ? path.resolve(process.env.ZUMI_VAULT_EXE) : null;
if (!HELPER || !fs.existsSync(HELPER)) { console.log('FAIL set ZUMI_VAULT_EXE to a built zumi-vault.exe'); process.exit(1); }
const PW_DIR = process.env.ZUMI_PLAYWRIGHT_DIR || ownerPath('playwrightDir', 'node_modules/playwright');
const EXE = process.env.ZUMI_CHROMIUM || ownerPath('chromiumExe', 'local/chrome.exe');
const { chromium } = createRequire(path.join(ROOT, 'package.json'))(PW_DIR);

const work = fs.mkdtempSync(path.join(ROOT, '.tauri-check-tmp-pin-'));

// ---- the stub upstream: scratch Laneboard + nginx-shaped shim ----
const board = createBoard({ dataDir: path.join(work, 'board') });
const OWNER = fs.readFileSync(board.bootstrapTokenFile, 'utf8').trim();
let seq = 0;
const seed = (tok, op, id, data = {}) => board.write(tok, { version: 1, request_id: `seed-req-${String(++seq).padStart(4, '0')}`, op, target_id: id, data });
const COORD = seed(OWNER, 'token.issue', 'coordinator', { role: 'coordinator', lane: 'coordination', model: 'opus' }).token;
for (const [id, title] of [['T-31', 'Zumi avatar'], ['L-01', 'Game livestream']]) seed(COORD, 'task.create', id, { title, steps: [{ id: 's1', label: 'Build', zone: 'build', state: 'active' }] });
const pinnedOf = (id) => Boolean(board.view(COORD).tasks.find((t) => t.id === id)?.pinned);
const PROXY_SECRET = `shim-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
const boardServer = createServer(board, { ownerProxySecret: PROXY_SECRET });
const boardPort = await new Promise((r) => boardServer.listen(0, '127.0.0.1', () => r(boardServer.address().port)));
const USER = 'pin-check-user', PASS = 'pin-check-pass-7q7q';
const BASIC = `Basic ${Buffer.from(`${USER}:${PASS}`, 'utf8').toString('base64')}`;
const seen = []; // every request that reached the "VPS": method, path, and for a write its op/target/data/request_id
const shim = http.createServer((req, res) => {
  if (!req.url.startsWith('/zumia/')) { res.writeHead(404); return res.end('{"error":"not_found"}'); }
  if (req.headers.authorization !== BASIC) { res.writeHead(401); return res.end('{"error":"bad_basic"}'); }
  const headers = { ...req.headers }; delete headers.host;
  headers['x-laneboard-owner-proxy'] = PROXY_SECRET; // nginx proxy_set_header: replaces whatever a client sent
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const rec = { method: req.method, path: req.url.split('?')[0].slice('/zumia'.length) };
    if (req.method === 'POST') { try { const j = JSON.parse(body.toString('utf8')); Object.assign(rec, { op: j.op, target: j.target_id, data: j.data, request_id: j.request_id }); } catch { /* not json */ } }
    seen.push(rec);
    const up = http.request({ host: '127.0.0.1', port: boardPort, path: req.url.slice('/zumia'.length), method: req.method, headers }, (u) => { res.writeHead(u.statusCode, u.headers); u.pipe(res); });
    up.end(body);
  });
});
const shimPort = await new Promise((r) => shim.listen(0, '127.0.0.1', () => r(shim.address().port)));

// ---- the real sidecar ----
function hostFor(name, ownerAdmin) {
  const hostDir = path.join(work, `host-${name}`);
  fs.mkdirSync(hostDir, { recursive: true });
  if (ownerAdmin !== null) fs.writeFileSync(path.join(hostDir, 'flavour.json'), `${JSON.stringify({ v: 1, cloudBase: null, test: true, reflexEgress: false, ownerAdmin, boardMirror: null }, null, 2)}\n`);
  fs.copyFileSync(HELPER, path.join(hostDir, 'zumi-vault.exe'));
  return hostDir;
}
async function startSidecar(name, ownerAdmin, root = ROOT) {
  const hostDir = hostFor(name, ownerAdmin);
  const dataDir = path.join(work, `data-${name}`);
  fs.mkdirSync(dataDir, { recursive: true });
  // ownerAdmin null = the public form: no flavour file at all (flavour.mjs: absence is the only public form)
  const args = [path.join(root, 'tauri', 'sidecar', 'main.mjs'), '--data-dir', dataDir, '--no-voice-prefetch', '--vault-exe', path.join(hostDir, 'zumi-vault.exe'), '--host-dir', hostDir, ...(ownerAdmin === null ? [] : ['--flavour', path.join(hostDir, 'flavour.json')])];
  const child = spawn(process.execPath, args, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ZUMI_BOARD_UPSTREAM: `http://127.0.0.1:${shimPort}/zumia` } });
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
  if (!(await Promise.race([ready.then(() => true), wait(20000).then(() => false)]))) throw new Error(`sidecar ${name} not ready: ${s.stderr.slice(-400)}`);
  return s;
}
async function stopSidecar(s) {
  if (!s || s.child.exitCode !== null || s.child.signalCode !== null) return;
  s.child.stdin.end();
  await until(() => s.child.exitCode !== null || s.child.signalCode !== null, 5000);
  if (s.child.exitCode === null && s.child.signalCode === null) s.child.kill();
}

// ---- the Board tab: the session URL the renderer loads (app.js withEmbedLang), in headless Chromium ----
const browser = await chromium.launch({ executablePath: EXE, headless: true, timeout: 60000 });
async function openBoard(sc, hash = '') {
  const r = await sc.call('board.liveOpen');
  if (!r || !r.openUrl) throw new Error(`board.liveOpen: ${JSON.stringify(r)}`);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const u = new URL(r.openUrl);
  // the renderer's URL shape (app.js withEmbedLang + theme.js withBoardTheme, default theme blue)
  u.searchParams.set('embed', '1'); u.searchParams.set('lang', 'vi'); u.searchParams.set('local', 'open'); u.searchParams.set('zumiTheme', 'blue'); u.hash = 'theme=dark';
  await page.goto(u.href, { waitUntil: 'networkidle' });
  await page.waitForSelector('#main', { timeout: 15000 });
  if (hash) { await page.evaluate((h) => { location.hash = h; }, hash); }
  await page.waitForFunction(() => document.querySelector('.lrow, .row, .tv-head'), null, { timeout: 15000 }).catch(() => {});
  return { ctx, page, origin: r.origin, errors };
}
// what the page itself sees: whoami through its own fetch, the role its state carries, and the Pin toggles it rendered
const pageView = (page) => page.evaluate(async () => {
  const who = await fetch('api/v1/whoami', { cache: 'no-store' }).then((r) => r.json()).catch(() => null);
  const st = await fetch('api/v1/state?v=2', { cache: 'no-store' }).then((r) => r.json()).catch(() => null);
  return { whoRole: who && who.role, stateRole: st && st.me && st.me.role, rail: [...document.querySelectorAll('.lmeta .pin-btn')].map((b) => b.dataset.task), head: [...document.querySelectorAll('.tv-head .pin-btn')].map((b) => b.dataset.task), strip: [...document.querySelectorAll('.pin-strip .pin-code')].map((e) => e.textContent) };
});
const pinWrites = () => seen.filter((x) => x.op === 'pin.set');
// the task header's Pin as the owner sees it: visible text, the pinned style, aria-pressed, hover title and its box
const headPin = (page) => page.evaluate(() => {
  const b = document.querySelector('.tv-head .pin-btn');
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return { text: b.innerText.trim(), on: b.classList.contains('on'), pressed: b.getAttribute('aria-pressed'), title: b.title, w: Math.round(r.width), h: Math.round(r.height) };
});
async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, name + '.png') });
  await page.locator('.tv-head').screenshot({ path: path.join(SHOTS, name + '-header.png') });
}

try {
  // ---- row A: owner flavour, no token (the sign-in card) ----
  {
    const ownerAdmin = MUT !== 'ownerops-off';
    const sc = await startSidecar('owner', ownerAdmin);
    ok(sc.stderr.includes(`ownerAdmin=${ownerAdmin}`), `A0 the sidecar resolved the flavour file with ownerAdmin=${ownerAdmin}`, sc.stderr.split('\n').find((l) => l.includes('flavour:')) || '');
    const sign = await sc.call('board.setSecretsOs', [{ user: USER, pass: PASS }]);
    const mode = await sc.call('board.setMode', ['live']);
    ok(sign && sign.ok && mode && mode.ok, 'A1 signed in like the Board sign-in card (user + password, no token) and live', { sign, mode });
    const before = pinWrites().length;
    const b = await openBoard(sc, '#/task/T-31');
    await b.page.waitForSelector('.tv-head', { timeout: 15000 });
    const v = await pageView(b.page);
    ok(v.whoRole === 'owner' && v.stateRole === 'owner', 'A2 through the bridge the page is the owner (whoami and state me.role)', v);
    ok(v.rail.includes('T-31') && v.rail.includes('L-01') && v.head.includes('T-31'), 'A3 isOwner(): the Pin toggle is on every rail row and in the T-31 header', v);
    const h0 = await headPin(b.page);
    ok(h0 && h0.text === 'Ghim' && !h0.on && h0.pressed === 'false' && h0.title === 'Ghim task này' && h0.w >= 40, 'A3b the header Pin is labelled: icon + "Ghim", not pinned, hover title "Ghim task này"', h0);
    await shot(b.page, 'owner-header-unpinned');
    await b.page.click('.tv-head .pin-btn');
    const got = await until(() => pinWrites().length > before && pinWrites().at(-1), 8000);
    ok(got && got.target === 'T-31' && got.data && got.data.pinned === true && /^zumi-ui-/.test(got.request_id || ''), 'A4 the click reaches the stub upstream as pin.set {pinned:true} on T-31 with a zumi-ui- request id', got || seen.slice(-3));
    ok(await until(() => pinnedOf('T-31'), 5000), 'A5 the stub board now has T-31 pinned');
    const h1 = await until(async () => { const h = await headPin(b.page); return h && h.on && h; }, 8000);
    ok(h1 && h1.text === 'Đã ghim' && h1.pressed === 'true' && h1.title === 'Bỏ ghim task này', 'A5b after pin.set the header reads "Đã ghim" in the pinned (.on) style, hover title "Bỏ ghim task này"', h1 || await headPin(b.page));
    if (h1) await shot(b.page, 'owner-header-pinned');
    await b.page.evaluate(() => { location.hash = '#/'; });
    const strip = await until(async () => { const x = await pageView(b.page); return x.strip.includes('T-31') && x; }, 20000, 500);
    ok(strip, 'A6 the Home "Đang ghim" strip shows T-31 after the next poll', strip || await pageView(b.page));
    await b.page.evaluate(() => { location.hash = '#/task/T-31'; });
    await b.page.waitForSelector('.tv-head .pin-btn.on', { timeout: 20000 }).catch(() => {});
    const n = pinWrites().length;
    await b.page.click('.tv-head .pin-btn').catch(() => {});
    const un = await until(() => pinWrites().length > n && pinWrites().at(-1), 8000);
    const h2 = await until(async () => { const h = await headPin(b.page); return h && !h.on && h; }, 8000);
    ok(h2 && h2.text === 'Ghim', 'A7b after the unpin the header reads "Ghim" again', h2);
    ok(un && un.data && un.data.pinned === false && !(await until(() => !pinnedOf('T-31') || null, 3000) === null), 'A7 a second click unpins (pin.set {pinned:false})', un);
    ok(!/bridge refused POST \/api\/v1\/write/.test(sc.stderr) && b.errors.length === 0, 'A8 no bridge refusal and no page error', { refused: sc.stderr.split('\n').filter((l) => l.includes('refused')), errors: b.errors });
    await b.ctx.close();
    await stopSidecar(sc);
  }
  // ---- row B: owner flavour, a non-owner token in the optional token field ----
  {
    const sc = await startSidecar('owner-coord-token', true);
    const sign = await sc.call('board.setSecretsOs', [{ user: USER, pass: PASS, token: COORD }]);
    await sc.call('board.setMode', ['live']);
    const b = await openBoard(sc, '#/task/T-31');
    await b.page.waitForSelector('.tv-head', { timeout: 15000 });
    const v = await pageView(b.page);
    ok(sign && sign.ok && v.whoRole === 'coordinator' && v.rail.length === 0 && v.head.length === 0, 'B1 a non-owner token in the token field decides identity (X-Laneboard-Token): the page is coordinator and shows no Pin', v);
    await b.ctx.close();
    await stopSidecar(sc);
  }
  // ---- row C: public flavour (ownerAdmin=false): pin.set refused at the bridge, never upstream ----
  {
    const sc = await startSidecar('public', false);
    ok(sc.stderr.includes('ownerAdmin=false'), 'C0 the sidecar resolved ownerAdmin=false');
    await sc.call('board.setSecretsOs', [{ user: USER, pass: PASS }]);
    await sc.call('board.setMode', ['live']);
    const b = await openBoard(sc);
    const before = pinWrites().length;
    const r = await b.page.evaluate(async () => {
      const res = await fetch('api/v1/write', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'laneboard' }, body: JSON.stringify({ version: 1, request_id: 'ui-pin-check-0001', op: 'pin.set', target_id: 'L-01', data: { pinned: true } }) });
      return { status: res.status, body: await res.json().catch(() => null) };
    });
    await wait(300);
    ok(r.status === 403 && r.body && r.body.error === 'forbidden_op' && pinWrites().length === before && !pinnedOf('L-01'), 'C1 public: the page\'s pin.set is refused 403 forbidden_op and never reaches the stub', { r, pinWrites: pinWrites().length - before });
    ok(/bridge refused POST \/api\/v1\/write 403 forbidden_op/.test(sc.stderr), 'C2 the refusal is in the sidecar log');
    await b.ctx.close();
    await stopSidecar(sc);
  }
  // ---- row D: public, the real shape: no owner values, no flavour file -> no live origin, no live Board page ----
  {
    const pubRoot = path.join(work, 'public-src');
    fs.mkdirSync(pubRoot, { recursive: true });
    execFileSync('git', ['-C', ROOT, 'archive', '--format=tar', '-o', path.join(work, 'public-src.tar'), 'HEAD']);
    execFileSync('tar', ['-xf', 'public-src.tar', '-C', 'public-src'], { cwd: work }); // relative: GNU tar reads "D:" as a remote host
    fs.rmSync(path.join(pubRoot, 'src', 'main', 'owner-values.json'), { force: true });
    const sc = await startSidecar('public-real', null, pubRoot);
    const sign = await sc.call('board.setSecretsOs', [{ user: USER, pass: PASS }]);
    const mode = await sc.call('board.setMode', ['live']);
    const open = await sc.call('board.liveOpen');
    const before = seen.length;
    ok(sc.stderr.includes('flavour: public (no flavour file)') && !sc.stderr.includes('[board-live] upstream '), 'D0 public source + no flavour file: flavour public, no live upstream logged', sc.stderr.split('\n').filter((l) => /flavour|upstream/.test(l)));
    ok(mode && mode.ok === false && mode.error === 'no_live_board' && open && open.error === 'not_live' && seen.length === before, 'D1 public: live mode is refused (no_live_board) and board.liveOpen is not_live, so no live Board page and no owner Pin', { sign, mode, open });
    await stopSidecar(sc);
  }
} catch (e) {
  fail++; console.log(`FAIL harness error: ${e && e.stack ? e.stack : e}`);
} finally {
  await browser.close().catch(() => {});
  boardServer.close(); shim.close();
  fs.rmSync(work, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed${MUT ? ` (mutation ${MUT})` : ''}`);
process.exit(fail ? 1 : 0);
