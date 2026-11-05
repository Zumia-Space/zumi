#!/usr/bin/env node
// Brain gates (T-31 slice 3: AC-B1..B10, AC-M1, AC-M8, export AC 12, plus the Open-on-board navigation). Two parts:
//   1. Node, no DOM: the board model (library rows, one task's detail), the board-data door and its reason table, the diagram geometry;
//   2. Chromium (Playwright), the ZUMI_NEXT_UI build of a SCRATCH copy of the renderer with a stub of the preload bridge, fed the real
//      boardView body scripts/fixtures/brain-board-state.json (made by scripts/fixtures/make-brain-state.mjs from the vendored Laneboard
//      server). The fixture is loaded here only, never by shipped code: in the app the data comes from window.zumi.board.state or the card
//      says why it cannot.
// AC-B2 negative control: `--leak` patches the scratch copy of board-model.js so task A's detail takes B's asks / plans / attachments /
// steps as well; the AC-B2 asserts must then FAIL (exit 1). Anchors that are not found make the run exit 2, never pass.
//   node scripts/check-brain.mjs [--leak] [--keep] [--shots <dir>]
// Playwright: $ZUMI_PLAYWRIGHT_DIR; Chromium: $ZUMI_CHROMIUM (same defaults as check-next-ui-boots-without-next.mjs).
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ownerPath } from './lib/owner-paths.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PW = process.env.ZUMI_PLAYWRIGHT_DIR || ownerPath('playwrightDir', 'node_modules/playwright');
const EXE = process.env.ZUMI_CHROMIUM || ownerPath('chromiumExe', 'local/chrome.exe');
const args = process.argv.slice(2);
const leak = args.includes('--leak');
const keep = args.includes('--keep');
const shotsDir = args.includes('--shots') ? path.resolve(args[args.indexOf('--shots') + 1]) : null;
const SCRATCH = `${ownerPath('scratchRoot', os.tmpdir())}/brain-check-${process.pid}`;
let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); } };
const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'fixtures', 'brain-board-state.json'), 'utf8'));
const byId = (id) => fixture.tasks.find((t) => t.id === id);
const LIVE = fixture.tasks.filter((t) => t.status !== 'closed' && t.status !== 'paused');

// ---------- scratch copy of the renderer (leak mode patches it; the tree is never touched) ----------
function makeScratch() {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.mkdirSync(path.join(SCRATCH, 'scripts'), { recursive: true });
  for (const f of ['build-renderer.mjs', 'rig-version.mjs', 'seat-offset.mjs']) fs.copyFileSync(path.join(ROOT, 'scripts', f), path.join(SCRATCH, 'scripts', f));
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(SCRATCH, 'package.json'));
  fs.cpSync(path.join(ROOT, 'src', 'renderer'), path.join(SCRATCH, 'src', 'renderer'), { recursive: true });
  fs.mkdirSync(path.join(SCRATCH, 'src', 'main'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'src', 'main', 'providers.js'), path.join(SCRATCH, 'src', 'main', 'providers.js'));
  fs.copyFileSync(path.join(ROOT, 'src', 'main', 'free-key-routes.js'), path.join(SCRATCH, 'src', 'main', 'free-key-routes.js')); // free-key-guide.js imports it
  fs.cpSync(path.join(ROOT, 'src', 'next-tokens'), path.join(SCRATCH, 'src', 'next-tokens'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'vendor', 'laneboard', 'public'), path.join(SCRATCH, 'vendor', 'laneboard', 'public'), { recursive: true });
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(SCRATCH, 'node_modules'), 'junction');
}
function patchLeak() {
  const f = path.join(SCRATCH, 'src', 'renderer', 'next', 'brain', 'board-model.js');
  let s = fs.readFileSync(f, 'utf8');
  const swaps = [
    ['r && r.task_id === id)', 'r)'], // asks + attachments of every task
    ['arr(state.plans && state.plans[id])', 'Object.values(state.plans || {}).flat()'], // plans of every task
    ['arr(task.steps).map(', 'arr(state.tasks.flatMap((x) => arr(x.steps))).map('], // steps of every task
  ];
  for (const [a, b] of swaps) { if (!s.includes(a)) { console.error(`leak patch: anchor not found: ${a}`); process.exit(2); } s = s.replace(a, b); }
  fs.writeFileSync(f, s);
}

// ---------- part 1: Node ----------
async function nodePart() {
  const model = await import(pathToFileURL(path.join(SCRATCH, 'src/renderer/next/brain/board-model.js')).href);
  const data = await import(pathToFileURL(path.join(SCRATCH, 'src/renderer/next/brain/board-data.js')).href);
  const rows = model.libraryRows(fixture);
  ok(rows.length === 4 && rows.length === LIVE.length && rows.every((r) => r.status !== 'closed' && r.status !== 'paused'), 'model AC-B1: library rows = the board tasks that are not closed or paused (fixture: 4 of 6)', rows.map((r) => r.id).join());
  ok(model.libraryRows(fixture, { showClosed: true }).length === 6, 'model: "show paused and closed" adds the 2 parked tasks (6)');
  ok(model.libraryRows(fixture, { query: 'wardrobe' }).map((r) => r.id).join() === 'F-04' && model.libraryRows(fixture, { query: 'ZZZ' }).length === 0, 'model: the text filter matches title/lane/id, case-insensitive, and can match nothing');
  ok(model.libraryRows(fixture).filter((r) => r.needsOwner).map((r) => r.id).join() === 'T-31,F-04', 'model: needs-owner flag = the board attention list (T-31, F-04)');
  const a = model.taskDetail(fixture, 'T-31'), b = model.taskDetail(fixture, 'F-04');
  ok(a && b && model.taskDetail(fixture, 'NOPE') === null, 'model: taskDetail finds a task, null for an unknown one');
  ok(a.steps.length === 6 && a.asks.length === 2 && a.plans.length === 2 && a.media.length === 2 && a.asks[0].status === 'open', 'model: T-31 detail = its 6 steps, 2 asks (open first), 2 plans, 2 attachments', JSON.stringify([a.steps.length, a.asks.length, a.plans.length, a.media.length]));
  ok(b.steps.length === 2 && b.asks.length === 1 && b.plans.length === 1 && b.media.length === 1, 'model: F-04 detail = its own 2 steps, 1 ask, 1 plan, 1 attachment');
  ok(a.steps.find((s) => s.short === 'diagrams').history.length === 2, 'model: step history = the transitions the board recorded for that step');

  // board-data: the only door. Node has no window: give it the one it reads.
  const run = async (zumi, dev) => { globalThis.window = { zumi }; data.setDevSource(dev || null); const r = await data.getBoardState(); data.setDevSource(null); return r; };
  ok(JSON.stringify(await run({})) === '{"ok":false,"reason":"unconfigured"}', 'board-data AC-B3: no window.zumi.board.state -> { ok:false, reason:"unconfigured" }, no fallback data');
  ok(JSON.stringify(await run({ board: { status() {} } })) === '{"ok":false,"reason":"unconfigured"}', 'board-data: window.zumi.board without .state (today\'s Electron preload) -> unconfigured');
  const good = await run({ board: { state: async () => ({ ok: true, state: fixture }) } });
  ok(good.ok && good.state.tasks.length === 6, 'board-data: { ok:true, state } passes through');
  for (const reason of ['unconfigured', 'locked', 'not_live', 'auth_rejected', 'offline', 'timeout', 'http_503']) {
    const r = await run({ board: { state: async () => ({ ok: false, reason }) } });
    ok(r.ok === false && r.reason === reason, `board-data: the host's reason "${reason}" is kept as is`);
  }
  ok((await run({ board: { state: async () => { throw new Error('ipc'); } } })).reason === 'offline', 'board-data: a throwing host call -> offline (never an empty list)');
  ok((await run({ board: { state: async () => ({ ok: true, state: { tasks: 'x' } }) } })).reason === 'bad_state' && (await run({ board: { state: async () => null } })).reason === 'bad_state', 'board-data: a malformed answer -> bad_state');
  const rk = data.reasonKey;
  ok(rk('locked').key === 'brain.reason.locked' && rk('http_503').key === 'brain.reason.http' && rk('http_503').vars.code === '503' && rk('weird').key === 'brain.reason.other', 'board-data: reasonKey maps known reasons, http_<n>, and anything else');
  delete globalThis.window;

  // 3a-2: the copy of the board's layout engine next to diagram.js is byte-exact (it stays a copy only because the next-ui-off scratch build has no vendor/ tree)
  const sha = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  ok(sha(path.join(ROOT, 'vendor/laneboard/public/diagram.js')) === sha(path.join(ROOT, 'src/renderer/next/brain/vendor/diagram.js')), 'AC-B7 (pin): src/renderer/next/brain/vendor/diagram.js is byte-identical to vendor/laneboard/public/diagram.js');
  // 3a-2: the vendored layout is imported as is; one box per step, one edge between consecutive steps (fixture: every task)
  await import(pathToFileURL(path.join(SCRATCH, 'src/renderer/next/brain/diagram.js')).href);
  const LD = globalThis.LaneDiagram;
  ok(fixture.tasks.every((t) => LD.layoutTask(t).boxes.length === t.steps.length), 'AC-B7 (geometry): layoutTask gives one box per step for every fixture task', fixture.tasks.map((t) => t.id + ':' + LD.layoutTask(t).boxes.length + '/' + t.steps.length).join(' '));
  const arch = LD.layoutArchitecture(byId('T-31').architecture, { compact: true });
  ok(arch.nodes.length === byId('T-31').architecture.nodes.length && arch.edges.length === byId('T-31').architecture.edges.length, 'AC-B7 (geometry): layoutArchitecture gives one node per node and one edge per edge');
  ok(LD.layoutArchitecture(undefined).empty === true && LD.layoutArchitecture({ format: 'graph', nodes: [] }).empty === true, 'AC-B8 (geometry): no architecture -> empty layout');
}

// ---------- part 2: Chromium ----------
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
// 60 conversation lines, some Vietnamese; list() folds diacritics like the host's FTS does (the UI only passes the query on).
const MEMORY_FIXTURE = String.raw`(() => {
  const fold = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').toLowerCase();
  const TEXTS = ['Anh Kei muốn câu trả lời ngắn', 'Uống cà phê lúc 8 giờ', 'Round 4 looks ready for review', 'Thích áo khoác trắng', 'Robot demo on Friday', 'Nhớ gửi hóa đơn cho khách'];
  let items = Array.from({ length: 120 }, (_, i) => ({ id: 120 - i, kind: i % 2 ? 'turn' : 'note', text: TEXTS[i % TEXTS.length] + ' #' + (120 - i), createdAt: Date.UTC(2026, 9, 27, 8, 0) - i * 3600000 }));
  window.__memCalls = [];
  const log = (name, arg) => window.__memCalls.push({ name, arg: arg === undefined ? undefined : JSON.parse(JSON.stringify(arg)) });
  window.__cfg = window.__cfg || {};
  window.__cfg.memory = {
    status: async () => { log('status'); return { enabled: window.__memEnabled !== false, count: items.length }; },
    setEnabled: async (on) => { log('setEnabled', on); window.__memEnabled = on; },
    list: async (a) => { log('list', a); let r = items; if (a.kind) r = r.filter((x) => x.kind === a.kind); if (a.search) r = r.filter((x) => fold(x.text).includes(fold(a.search))); if (a.beforeId) r = r.filter((x) => x.id < a.beforeId); return { items: r.slice(0, a.limit), more: r.length > a.limit }; },
    delete: async (id) => { log('delete', id); items = items.filter((x) => x.id !== id); return { ok: true }; },
    deleteAll: async () => { log('deleteAll'); items = []; return { ok: true }; },
    exportFile: async () => { log('exportFile'); return { ok: true, path: 'D:/exports/zumi-memory-2026-10-28.json' }; },
  };
})();`;

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
      openBoard: async () => ({ url: 'http://127.0.0.1:9/', origin: 'http://127.0.0.1:9', dataDir: 'x' }), board };
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
const openBrain = async (page, tab) => { await page.click('.tab[data-next="brain"]'); if (tab) await page.click(`.nb-tab[data-tab="${tab}"]`); await page.waitForTimeout(250); };

async function chromiumPart(buildDir) {
  const { chromium } = createRequire(import.meta.url)(PW);
  const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'], timeout: 60000 });
  const server = await serve(buildDir);
  try {
    const full = { ok: true, state: fixture };

    // --- sidebar, card, library (AC-B1) ---
    {
      const { page, bad } = await pageFor(browser, server, { board: full });
      const tabs = await page.$$eval('#sidebar .tab', (b) => b.map((x) => x.textContent.trim()));
      ok(tabs.indexOf('Brain') === 2 && tabs.length >= 5, 'sidebar: the "Brain" item is the third (Zumi, Board, Brain, ...)', tabs.join(','));
      await openBrain(page);
      const c = await page.evaluate(() => {
        const e = document.getElementById('next-brain'), b = e.getBoundingClientRect(), s = document.getElementById('stage').getBoundingClientRect();
        return { shown: !e.hidden && b.width > 0, insideStage: b.left >= s.left && b.top >= s.top && b.right <= s.right && b.bottom <= s.bottom, onRight: b.left > s.left + s.width * 0.4, zumi: document.getElementById('tab-zumi').classList.contains('active'),
          tabs: [...e.querySelectorAll('.nb-tab')].map((x) => x.textContent), graph: /graph/i.test(e.textContent), css: [...document.styleSheets].some((x) => /next\/brain\/brain\.css/.test(x.href || '')) };
      });
      ok(c.shown && c.insideStage && c.onRight && c.zumi, 'card AC-B6: Brain opens a card over the Zumi stage, on the right (concept A-1)', JSON.stringify(c));
      ok(c.tabs.join() === 'Memory,Tasks,Soul' && !c.graph && c.css, 'card: three tabs Memory · Tasks · Soul (Soul: T-31 alpha.12), no Graph toggle (slice 4), brain.css linked', JSON.stringify(c));
      await page.click('.nb-tab[data-tab="tasks"]'); await page.waitForSelector('.nb-row', { timeout: 5000 });
      const lib = await page.evaluate(() => ({ rows: [...document.querySelectorAll('#next-brain .nb-row')].map((r) => r.dataset.task), meta: document.querySelector('#next-brain .meta').textContent,
        chips: Object.fromEntries([...document.querySelectorAll('#next-brain .nb-row')].map((r) => [r.dataset.task, [...r.querySelectorAll('.nb-chip')].map((c) => c.textContent)])) }));
      ok(lib.rows.length === LIVE.length && lib.rows.join() === LIVE.map((t) => t.id).join(), 'AC-B1: library rows = board tasks not closed/paused, in board order (fixture: 4)', lib.rows.join());
      ok(lib.meta === '4 live · 6 in all', 'AC-B1: header count = live · total', lib.meta);
      ok(lib.chips['T-31'].includes('Needs you') && lib.chips['F-04'].includes('Needs you') && !lib.chips['C-52'].includes('Needs you') && lib.chips['F-04'].includes('WAITING') && Object.values(lib.chips).every((c) => c.some((x) => /^[A-Z]+$/.test(x))), 'library: needs-you chip on the 2 tasks the board says wait, a status chip on every row', JSON.stringify(lib.chips));
      await page.click('.nb-toggle[aria-pressed]');
      ok((await page.$$('#next-brain .nb-row')).length === 6, 'AC-B1: "Show paused and closed" -> all 6 rows');
      await page.fill('.nb-filter', 'wardrobe');
      ok((await page.$$eval('#next-brain .nb-row', (r) => r.map((x) => x.dataset.task))).join() === 'F-04', 'library: the filter narrows the rows client-side (wardrobe -> F-04)');
      await page.fill('.nb-filter', 'nothing-like-this');
      ok((await page.$$('#next-brain .nb-empty')).length === 1, 'library: a filter with no match shows the empty line, not a blank card');
      ok(bad.length === 0, 'library page: no console error, page error or failed request', bad.slice(0, 3).join(' | '));
      await page.close();
    }

    // --- AC-B2: detail scoping, both directions, with positive controls ---
    {
      const { page } = await pageFor(browser, server, { board: full });
      await openBrain(page, 'tasks');
      const markersOf = (id) => {
        const t = byId(id);
        return { steps: t.steps.flatMap((s) => [s.id, s.label]), asks: fixture.asks.filter((a) => a.task_id === id).flatMap((a) => [a.id, a.text]),
          plans: Object.values(fixture.plans).flat().filter((p) => p.task_id === id).flatMap((p) => [p.id, p.reviewer + p.body.slice(0, 20)]),
          media: fixture.attachments.filter((m) => m.task_id === id).flatMap((m) => [m.id, m.name]) };
      };
      const dump = async () => page.evaluate(() => { const b = document.querySelector('#next-brain .nb-body'); return { text: b.innerText, html: b.innerHTML }; });
      for (const [A, B] of [['T-31', 'F-04'], ['F-04', 'T-31']]) {
        await page.click(`.nb-row[data-task="${A}"]`);
        const d = await dump();
        const mine = markersOf(A), other = markersOf(B);
        const counts = await page.evaluate(() => ({ steps: document.querySelectorAll('.nb-step').length, asks: document.querySelectorAll('.nb-ask').length, plans: document.querySelectorAll('.nb-plan').length, att: document.querySelectorAll('.nb-att').length, head: document.querySelector('.nb-dhead').dataset.task }));
        const a = byId(A);
        ok(counts.head === A && counts.steps === a.steps.length && counts.asks === mine.asks.length / 2 && counts.plans === mine.plans.length / 2 && counts.att === mine.media.length / 2,
          `AC-B2 control (${A}): its own steps/asks/plans/attachments are all there (the check can see them)`, JSON.stringify(counts));
        const leaked = Object.entries(other).flatMap(([k, list]) => list.filter((m) => d.text.includes(m) || d.html.includes(m)).map((m) => `${k}:${m}`));
        ok(leaked.length === 0, `AC-B2: ${A}'s detail holds no step, ask, plan or attachment of ${B}`, leaked.join(' | '));
        await page.click('.nb-back');
      }
      await page.close();
    }

    // --- AC-B3: the reason card for each reason of board-reader ---
    {
      for (const reason of ['unconfigured', 'locked', 'not_live', 'auth_rejected', 'offline', 'timeout', 'http_503', 'something_new']) {
        const { page, bad } = await pageFor(browser, server, { board: { ok: false, reason } });
        await openBrain(page, 'tasks');
        const r = await page.evaluate(() => { const c = document.querySelector('#next-brain [data-reason]'); return c ? { reason: c.dataset.reason, text: c.innerText, rows: document.querySelectorAll('#next-brain .nb-row').length } : null; });
        ok(r && r.reason === reason && r.text.includes(reason) && r.rows === 0 && /Can't see the task board/.test(r.text), `AC-B3: reason card for "${reason}" names the reason, shows no task`, JSON.stringify(r));
        if (reason === 'unconfigured') ok(bad.length === 0, 'AC-B3: the unconfigured page loads clean (today\'s Electron: no board.state)', bad.slice(0, 3).join(' | '));
        await page.close();
      }
      // the real Electron preload today: window.zumi.board exists but has no .state
      const { page } = await pageFor(browser, server, { board: { ok: true, state: fixture } });
      await page.evaluate(() => { delete window.zumi.board.state; });
      await page.evaluate(() => { window.zumi.board = { status: async () => ({}) }; });
      await openBrain(page, 'tasks');
      ok((await page.$$('#next-brain [data-reason="unconfigured"]')).length === 1 && (await page.$$('#next-brain .nb-row')).length === 0, 'AC-B3: a build with no board.state shows the unconfigured card even though a fixture exists (no hidden fallback data)');
      await page.close();
    }

    // --- Open on board: renderer-only navigation ---
    {
      const { page } = await pageFor(browser, server, { board: full });
      await openBrain(page, 'tasks');
      await page.click('.nb-row[data-task="T-31"]');
      await page.click('.nb-open');
      await page.waitForFunction(() => window.__loads.length > 0, null, { timeout: 8000 }).catch(() => {});
      const o = await page.evaluate(() => ({ loads: window.__loads, boardActive: document.querySelector('.tab[data-tab="board"]').classList.contains('active'), cardHidden: document.getElementById('next-brain').hidden, calls: window.__calls.length }));
      const u = o.loads[0] ? new URL(o.loads[0]) : null;
      ok(o.boardActive && o.cardHidden, 'open on board: the Board tab becomes active and the Brain card closes');
      ok(u && u.hash === '#/task/T-31' && u.searchParams.get('embed') === '1' && u.searchParams.get('lang') === 'en' && u.searchParams.get('local') === 'hide' && u.searchParams.has('r') && !u.searchParams.has('t') && u.origin === 'http://127.0.0.1:9',
        'open on board: the board webview is sent to <home>#/task/T-31 (embed, lang, local, r) with no nonce (never openUrl)', o.loads.join(' '));
      await page.close();
    }

    // --- 3a-2: diagrams in the detail view (AC-B7, AC-B8), at the default and the minimum window ---
    for (const viewport of [{ width: 1296, height: 839 }, { width: 916, height: 639 }]) {
      const { page, bad } = await pageFor(browser, server, { board: full }, { viewport });
      await openBrain(page, 'tasks');
      const probe = async (id) => { await page.click(`.nb-row[data-task="${id}"]`); return page.evaluate(() => {
        const body = document.querySelector('#next-brain .nb-body'), svgs = [...body.querySelectorAll('svg.bd')];
        return { svgs: svgs.length, steps: body.querySelectorAll('svg.bd [data-step]').length, nodes: body.querySelectorAll('svg.bd [data-node]').length, edges: body.querySelectorAll('svg.bd .bd-edge').length,
          empties: [...body.querySelectorAll('.nb-empty')].map((e) => e.textContent), overflow: body.scrollWidth - body.clientWidth, svgW: svgs.map((v) => Math.round(v.getBoundingClientRect().width)), ratios: svgs.map((v) => v.getBoundingClientRect().width / v.viewBox.baseVal.width), bodyW: body.clientWidth,
          labelled: svgs.every((v) => v.getAttribute('role') === 'img' && v.getAttribute('aria-label')) }; }); };
      const a = await probe('T-31');
      if (shotsDir) { fs.mkdirSync(shotsDir, { recursive: true }); await page.screenshot({ path: path.join(shotsDir, `chromium-detail-${viewport.width}.png`) }); await page.evaluate(() => document.querySelector('#next-brain svg.bd').closest('.nb-sec').scrollIntoView()); await page.screenshot({ path: path.join(shotsDir, `chromium-diagram-${viewport.width}.png`) }); }
      ok(a.svgs === 2 && a.steps === byId('T-31').steps.length && a.nodes === byId('T-31').architecture.nodes.length && a.edges === byId('T-31').steps.length - 1 + byId('T-31').architecture.edges.length,
        `AC-B7 (${viewport.width}): T-31 step-flow boxes = its 6 steps, structure nodes = its 6, one edge per link`, JSON.stringify(a));
      ok(a.overflow <= 1 && a.ratios.every((r) => r >= 0.549) && a.labelled, `AC-B7 (${viewport.width}): the diagrams are drawn at the engine's readable scale (>= 0.55) with no sideways overflow of the card (a wider one scrolls inside its box), each has role=img and a label`, JSON.stringify(a));
      await page.click('.nb-back');
      const b = await probe('F-04');
      ok(b.svgs === 1 && b.steps === 2 && b.nodes === 0 && b.empties.includes('No structure diagram for this task.'), `AC-B8 (${viewport.width}): a task without architecture shows the empty line, not a blank box (flow still drawn)`, JSON.stringify(b));
      ok(bad.length === 0, `diagram page (${viewport.width}): no console error or failed request`, bad.slice(0, 3).join(' | '));
      await page.close();
    }

    // --- 3b: Memory tab. Electron (no window.zumi.memory): the SPEC card and nothing else (AC-M8) ---
    {
      const { page, bad } = await pageFor(browser, server, { board: full });
      await openBrain(page, 'memory');
      const r = await page.evaluate(() => ({ memory: typeof window.zumi.memory, card: !!document.querySelector('#next-brain [data-memory="tauri-card"]'), text: document.querySelector('#next-brain .nb-body').innerText,
        controls: document.querySelectorAll('#next-brain .nb-body input, #next-brain .nb-body button').length, meta: document.querySelector('#next-brain .meta').textContent }));
      ok(r.memory === 'undefined' && r.card && /Memory is in the Tauri build/.test(r.text) && r.controls === 0 && r.meta === '', 'AC-M8: no window.zumi.memory -> the "Memory is in the Tauri build" card, no list, no control, no count', JSON.stringify(r));
      ok(bad.length === 0, 'AC-M8: the Electron-shaped page ends with a clean log (no error, no failed request)', bad.slice(0, 3).join(' | '));
      await page.close();
    }
    // --- 3b: the list against the fixture API (AC-M1, export AC 12, on/off, delete, delete all) ---
    {
      const { page, bad } = await pageFor(browser, server, { board: full }, { memoryFixture: MEMORY_FIXTURE });
      await openBrain(page, 'memory');
      await page.waitForSelector('.nb-mem', { timeout: 5000 });
      const rows = () => page.$$eval('#next-brain .nb-mem', (r) => r.map((x) => ({ id: x.dataset.memory, text: x.querySelector('.nb-text').textContent, chip: x.querySelector('.nb-chip').textContent })));
      const calls = () => page.evaluate(() => window.__memCalls);
      const meta = () => page.$eval('#next-brain .meta', (m) => m.textContent);
      let r = await rows();
      ok(await meta() === '120 memories' && r.length === 50 && r[0].id === '120' && r[49].id === '71', 'AC-M1: the header count = status().count (120); the first page is 50 rows, newest first', `${await meta()} rows=${r.length} ${r[0] && r[0].id}..${r[r.length - 1] && r[r.length - 1].id}`);
      let c = await calls();
      ok(c.find((x) => x.name === 'list').arg.limit === 50 && c.find((x) => x.name === 'list').arg.beforeId === undefined, 'AC-M1: the first list() call asks for 50 with no cursor');
      await page.click('.nb-more'); await page.waitForTimeout(150);
      r = await rows(); c = await calls();
      ok(r.length === 100 && c.filter((x) => x.name === 'list').pop().arg.beforeId === 71, 'AC-M1: "Show more" adds the next 50 with beforeId = the last id shown', `rows=${r.length}`);
      await page.click('.nb-more'); await page.waitForTimeout(150);
      ok((await rows()).length === 120 && (await page.$eval('.nb-more', (b) => b.hidden)), 'AC-M1: the last page shows all 120 and hides "Show more"');
      await page.click('.nb-kinds [data-kind="note"]'); await page.waitForTimeout(200);
      r = await rows();
      ok(r.length === 50 && r.every((x) => x.chip === 'NOTE') && (await calls()).filter((x) => x.name === 'list').pop().arg.kind === 'note', 'AC-M1: the Notes filter shows notes only (kind passed to the host)', `rows=${r.length}`);
      await page.click('.nb-kinds [data-kind="all"]');
      // The + Note composer (c8ba5fb5) is also .nb-filter and comes first: name the search box itself.
      const MEM_SEARCH = '#next-brain input.nb-filter[type="search"]';
      for (const q of ['ca phe', 'cà phê']) {
        await page.fill(MEM_SEARCH, q); await page.waitForTimeout(500);
        r = await rows();
        ok(r.length > 0 && r.every((x) => /c[àa] ph[êe]/.test(x.text)), `AC-M1: searching "${q}" finds the Vietnamese text "cà phê" (with and without diacritics)`, `rows=${r.length}`);
      }
      await page.fill(MEM_SEARCH, 'zzzz'); await page.waitForTimeout(500);
      ok((await rows()).length === 0 && (await page.$$('#next-brain .nb-empty')).length === 1, 'memory: a search with no hit shows the empty line');
      await page.fill(MEM_SEARCH, ''); await page.waitForTimeout(500);
      const first = (await rows())[0].id;
      await page.click('.nb-mem .nb-toggle.danger'); await page.waitForTimeout(200);
      ok(!(await rows()).some((x) => x.id === first) && await meta() === '119 memories' && (await calls()).some((x) => x.name === 'delete' && x.arg === Number(first)), 'memory: forgetting one removes the row, calls delete(id) and the count drops to 119');
      await page.click('.nb-mem-foot .nb-toggle:not(.danger)'); await page.waitForTimeout(150);
      const st = await page.$eval('.nb-mem-status', (e) => e.textContent), lab = await page.$eval('.nb-mem-foot .nb-toggle:not(.danger)', (e) => e.textContent);
      ok(/zumi-memory-\d{4}-\d{2}-\d{2}\.json$/.test(st) && /not encrypted/.test(lab), 'export AC 12 (fixture): the button says "not encrypted"; the saved path shown is zumi-memory-<date>.json (the save dialog itself is the host side)', `${lab} | ${st}`);
      await page.click('.nb-switch input'); await page.waitForTimeout(150);
      ok((await calls()).some((x) => x.name === 'setEnabled' && x.arg === false), 'memory: the on/off switch calls setEnabled(false)');
      const txt = await page.$eval('#next-brain', (e) => e.innerText);
      ok(!/\+\s*Note|Add note|New note/i.test(txt) && /Kept only on this computer/.test(txt), 'memory: no "+ Note" composer (slice 3c), and the one-line privacy sentence is there');
      await page.click('.nb-mem-foot .nb-toggle.danger'); await page.waitForTimeout(100);
      const conf = await page.$eval('.nb-confirm', (e) => ({ hidden: e.hidden, text: e.innerText }));
      ok(!conf.hidden && /Forget all 119 memories/.test(conf.text) && !(await calls()).some((x) => x.name === 'deleteAll'), 'memory: "Forget all…" asks first (the count is in the question) and has not deleted yet', conf.text);
      await page.click('.nb-confirm .nb-toggle:not(.danger)');
      ok((await page.$eval('.nb-confirm', (e) => e.hidden)) && !(await calls()).some((x) => x.name === 'deleteAll'), 'memory: Cancel closes the question and deletes nothing');
      await page.click('.nb-mem-foot .nb-toggle.danger'); await page.click('.nb-confirm .nb-toggle.danger'); await page.waitForTimeout(250);
      ok((await calls()).some((x) => x.name === 'deleteAll') && (await rows()).length === 0 && await meta() === '0 memories', 'memory: confirmed "Forget all" calls deleteAll(), the list empties and the count reads 0');
      ok(bad.length === 0, 'memory list page: no console error or failed request', bad.slice(0, 3).join(' | '));
      await page.close();
    }

    // --- layout by window class (CoS ruling 28-10): the card is visible and clear of the octagon zone and of the "No model yet" panel ---
    // The Chromium page has no avatar, so the octagons are checked by their measured position: they end 25% of the stage width in from each side
    // (Electron, default pose: slice 2's clearance-octagon.json, and this slice's clearance-brain.json). The panel is the real one (no model in the stub).
    const layout = {};
    for (const [w, h] of [[916, 639], [1296, 839], [1440, 900]]) {
      const { page, bad } = await pageFor(browser, server, { board: full }, { viewport: { width: w, height: h } });
      await openBrain(page, 'tasks'); await page.waitForTimeout(700);
      const r = await page.evaluate(() => {
        const c = document.getElementById('next-brain'), b = c.getBoundingClientRect(), st = document.getElementById('stage').getBoundingClientRect(), pn = document.querySelector('#empty-model:not([hidden]) .card');
        const p = pn ? pn.getBoundingClientRect() : null;
        return { card: [b.left, b.top, b.right, b.bottom], stage: [st.left, st.top, st.right, st.bottom], panel: p ? [p.left, p.top, p.right, p.bottom] : null,
          opacity: getComputedStyle(c).opacity, yielded: c.classList.contains('nx-yield'), collapsed: c.classList.contains('nx-collapsed'), hidden: c.hidden };
      });
      const sw = r.stage[2] - r.stage[0], cw = r.card[2] - r.card[0], octRight = r.stage[2] - 0.25 * sw, expectW = w <= 1000 ? 180 : Math.min(346, Math.max(250, 0.25 * sw - 26));
      const gapOct = r.card[0] - octRight, gapPanel = r.panel ? r.card[0] - r.panel[2] : null;
      layout[w] = { window: [w, h], ...r, cardWidth: cw, expectedWidth: Math.round(expectW), gapToOctagonZone: Math.round(gapOct), gapToPanel: gapPanel === null ? null : Math.round(gapPanel) };
      ok(!r.hidden && r.opacity === '1' && !r.yielded && !r.collapsed, `layout (${w}x${h}): the card is visible, not faded, not collapsed`, JSON.stringify(layout[w]));
      ok(Math.abs(cw - expectW) <= 1.5 && r.card[2] <= r.stage[2] && r.card[1] >= r.stage[1] && r.card[3] <= r.stage[3], `layout (${w}x${h}): width ${Math.round(cw)} = the ${w <= 1000 ? "180 px" : "clamp(250, 25% - 26, 346)"} class, inside the stage`, JSON.stringify(layout[w]));
      ok(gapOct >= 11, `layout (${w}x${h}): ${Math.round(gapOct)} px clear of the octagon zone (the octagons end 25% of the stage in from the edge)`, JSON.stringify(layout[w]));
      ok(r.panel && gapPanel >= 8, `layout (${w}x${h}): ${gapPanel === null ? "no panel" : Math.round(gapPanel) + " px"} clear of the No model yet panel`, JSON.stringify(layout[w]));
      ok(bad.length === 0, `layout (${w}x${h}): no console error or page error`, bad.slice(0, 3).join(' | '));
      if (w === 916) {
        // the guard bites: a panel wide enough to reach the card collapses it to its head strip (and normal width does not, above)
        await page.addStyleTag({ content: '#empty-model .card { max-width: 640px !important; width: 640px !important; }' });
        await page.waitForTimeout(500);
        const g = await page.evaluate(() => ({ collapsed: document.getElementById('next-brain').classList.contains('nx-collapsed'), h: document.getElementById('next-brain').getBoundingClientRect().height, kids: [...document.querySelectorAll('#next-brain > :not(.head)')].every((e) => getComputedStyle(e).display === 'none') }));
        ok(g.collapsed && g.kids && g.h < 80, 'layout guard: with the panel forced to 640 px the card collapses to its head strip (control for the clear gaps above)', JSON.stringify(g));
      }
      await page.close();
    }
    if (process.env.BRAIN_LAYOUT_JSON) fs.writeFileSync(process.env.BRAIN_LAYOUT_JSON, JSON.stringify(layout, null, 1));

    // --- AC-B5 / reduced motion (AC-B9) ---
    for (const reduce of [false, true]) {
      const { page } = await pageFor(browser, server, { board: full }, { reduce });
      await openBrain(page, 'tasks'); await page.click('.nb-row[data-task="T-31"]'); await page.waitForTimeout(300);
      const n = await page.evaluate(() => document.getAnimations().filter((a) => a.effect && a.effect.target && a.effect.target.closest && a.effect.target.closest('#next-brain') && a.playState === 'running').length);
      if (reduce) ok(n === 0, 'AC-B9: reduced motion: no running animation inside the Brain card', `running: ${n}`);
      else ok(n >= 1, 'AC-B9 control: without reduced motion the card has a running animation (the glow line), so "0" above is something the probe can tell apart', `running: ${n}`);
      await page.close();
    }
  } finally { await browser.close(); server.close(); }
}

// ---------- AC-B5: no write op in next/brain ----------
function noWrites() {
  const dir = path.join(ROOT, 'src', 'renderer', 'next', 'brain');
  const hits = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) fs.readFileSync(path.join(dir, f), 'utf8').split('\n').forEach((l, i) => { if (/api\/v1\/write|relay\(/.test(l)) hits.push(`${f}:${i + 1}`); });
  ok(hits.length === 0, 'AC-B5: no write op in src/renderer/next/brain (api/v1/write, relay()): 0 hits', hits.join(','));
}

try {
  if (!fs.existsSync(path.join(PW, 'package.json')) || !fs.existsSync(EXE)) { console.error(`ENV: need playwright at ${PW} and Chromium at ${EXE}`); process.exit(2); }
  makeScratch();
  if (leak) { patchLeak(); console.log('(self-test: the scratch board-model.js now leaks the other tasks into a task detail)'); }
  console.log(`build: ${execFileSync(process.execPath, [path.join(SCRATCH, 'scripts', 'build-renderer.mjs')], { cwd: SCRATCH, env: { ...process.env, ZUMI_NEXT_UI: '1' }, encoding: 'utf8' }).trim()}`);
  // flag OFF (explicit ZUMI_NEXT_UI=0; the default is ON since 28-10): the built renderer carries nothing of Brain (the full check is check:next-ui-off; this is the Brain-specific grep)
  const offOut = path.join(SCRATCH, 'off-build');
  execFileSync(process.execPath, [path.join(SCRATCH, 'scripts', 'build-renderer.mjs')], { cwd: SCRATCH, env: { ...process.env, ZUMI_NEXT_UI: '0', ZUMI_RENDERER_OUT: offOut }, encoding: 'utf8' });
  const offJs = fs.readFileSync(path.join(offOut, 'app.js'), 'utf8');
  ok(!fs.existsSync(path.join(offOut, 'next')) && !/next-brain|next\/brain|initBrain|nx-brain/.test(offJs + fs.readFileSync(path.join(offOut, 'index.html'), 'utf8')), 'flag OFF: no next/ dir and no trace of the Brain code (next-brain, next/brain, initBrain, nx-brain) in the built app.js / index.html; its i18n strings stay in the tables, as for Devices');
  ok(/next-brain|initBrain|nx-brain/.test(fs.readFileSync(path.join(SCRATCH, 'build', 'renderer', 'app.js'), 'utf8')), 'flag OFF control: the same grep finds the Brain code in the ON build (so "no trace" above is something the probe can tell apart)');
  await nodePart();
  noWrites();
  await chromiumPart(path.join(SCRATCH, 'build', 'renderer'));
} catch (e) {
  fail++; console.log(`FAIL check crashed: ${(e && e.stack) || e}`);
} finally {
  if (!keep) fs.rmSync(SCRATCH, { recursive: true, force: true });
}
console.log(`\ncheck:brain ${pass}/${pass + fail} passed${leak ? ' (leak mode: failures expected)' : ''}`);
process.exit(fail ? 1 : 0);
