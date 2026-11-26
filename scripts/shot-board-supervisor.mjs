// QC shots for the T-31 supervisor port: the Board tab's "Giám sát" strip, the per-task chip and the owner's L3 button.
// Headless Chromium via the vendored playwright-core (same convention as shot-laneboard-owner-ui.mjs); NO Electron, no window.
// What the Board tab shows is the vendored page served by the app's own bridge (src/main/board-bridge.mjs) at the URL the
// renderer builds (session URL + embed=1 + lang + local=hide, src/renderer/app.js withEmbedLang). Here that bridge fronts a
// FIXTURE board: the vendored Laneboard in-process on a throwaway data dir, supervisor on, on an injected daytime clock
// (the supervisor files nothing at night ICT), and the browser clock is pinned to the same time so the ages read true.
//   node scripts/shot-board-supervisor.mjs <out dir>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createBoard } from '../vendor/laneboard/src/board.mjs';
import { createServer } from '../vendor/laneboard/src/server.mjs';
import { createBridge } from '../src/main/board-bridge.mjs';
import { ownerPath } from './lib/owner-paths.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.argv[2];
if (!OUT) { console.error('usage: node scripts/shot-board-supervisor.mjs <out dir>'); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });
const PW_SOURCE = process.env.PW_CORE || ownerPath('playwrightCore', ''); // owner values; the public source passes PW_CORE
if (!PW_SOURCE || !fs.existsSync(PW_SOURCE)) { console.error(`SKIP: no playwright-core at ${PW_SOURCE} (set PW_CORE)`); process.exit(0); }
const { chromium } = createRequire(path.join(PW_SOURCE, 'package.json'))(PW_SOURCE);

const H = 3600000, MIN = 60000, T0 = Date.parse('2026-11-12T02:00:00.000Z'), iso = ms => new Date(ms).toISOString();
const clock = { ms: T0 };
const dataDir = path.join(ROOT, `.shot-sv-${process.pid}`);
fs.rmSync(dataDir, { recursive: true, force: true });
const board = createBoard({ dataDir, now: () => clock.ms, supervisorSince: iso(T0 - 24 * H), supervisorConfig: { digestHourIct: 24 } });
const owner = fs.readFileSync(board.bootstrapTokenFile, 'utf8').trim();
let n = 0;
const w = (token, op, target_id, data = {}, extra = {}) => board.write(token, { version: 1, request_id: `shot-sv-${process.pid}-${++n}`, op, target_id, data, ...extra });
const coord = w(owner, 'token.issue', 'coordinator', { role: 'coordinator' }).token;
const run = id => [{ id: 'build', label: 'Build the release', sub: `run:x@${iso(T0)}`, state: 'active', zone: 'build' }, { id: 'qc', label: 'Owner QC', state: 'todo', zone: 'owner' }];

// E: a run that never reports -> R1 at 4 h, CoS level after 1 h, owner level after another hour. F starts 90 min later, so it
// is only at R1 (quiet counts from the task's last activity) when E reaches the owner. G is healthy.
w(coord, 'task.create', 'E-07', { title: 'Release build that went quiet', lane: 'Worker A', steps: run('E-07') });
clock.ms += 90 * MIN;
w(coord, 'task.create', 'F-12', { title: 'Docs sync, quiet run', lane: 'Worker B', steps: [{ id: 'sync', label: 'Sync the docs', sub: `run:y@${iso(clock.ms)}`, state: 'active', zone: 'build' }] });
w(coord, 'task.create', 'G-03', { title: 'Healthy task', lane: 'Worker A', steps: [{ id: 'a', label: 'Write the plan', state: 'done', zone: 'build' }, { id: 'b', label: 'Code it', state: 'todo', zone: 'build' }] });
clock.ms = T0 + 4 * H + MIN; board.sweepSupervisor();
clock.ms += 61 * MIN; board.sweepSupervisor();
clock.ms += 61 * MIN; board.sweepSupervisor();
const sv = board.supervisorView(owner);
console.log('fixture open nudges:', JSON.stringify(sv.open.map(x => [x.task_id, x.rule, x.level])));
const browserNow = clock.ms + 20 * MIN;

const upstream = createServer(board);
await new Promise(r => upstream.listen(0, '127.0.0.1', r));
const bridge = createBridge({ upstreamOrigin: `http://127.0.0.1:${upstream.address().port}`, getToken: () => owner, publicDir: path.join(ROOT, 'vendor', 'laneboard', 'public') });
await bridge.port();

// Headless Edge (installed with Windows; no browser download), like check-board-open-owner.mjs.
let browser;
const shots = [];
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true, timeout: 60000 });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, colorScheme: 'light' });
  const page = await ctx.newPage();
  await page.clock.setFixedTime(new Date(browserNow));
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  const u = new URL(await bridge.sessionUrl());
  u.searchParams.set('embed', '1'); u.searchParams.set('lang', 'vi'); u.searchParams.set('local', 'hide');
  await page.goto(u.href);
  const shot = async (name, sel) => {
    await page.waitForSelector(sel, { timeout: 15000 });
    await page.waitForTimeout(400);
    const file = path.join(OUT, name);
    await page.screenshot({ path: file });
    shots.push(file);
    console.log('shot', file);
  };
  await shot('1-home-giam-sat-strip.png', '.supervisor-strip');
  await page.evaluate(() => { location.hash = '#/task/E-07'; });
  await shot('2-task-E07-L3-chip-and-button.png', '.tv-head .sv-receipt');
  await page.evaluate(() => { location.hash = '#/task/F-12'; });
  await shot('3-task-F12-L1-chip-no-button.png', '.tv-head .sv-badge');
  console.log('F-12 has a button:', await page.locator('.tv-head .sv-receipt').count());
  await page.evaluate(() => { location.hash = '#/task/G-03'; });
  await page.waitForSelector('.tv-head');
  console.log('G-03 chips:', await page.locator('.tv-head .sv-badge').count());
  await page.evaluate(() => { location.hash = '#/task/E-07'; });
  await page.waitForSelector('.tv-head .sv-receipt');
  await page.click('.tv-head .sv-receipt');
  await page.waitForFunction(() => !document.querySelector('.tv-head .sv-receipt'), null, { timeout: 15000 });
  await shot('4-task-E07-after-da-nhan.png', '.tv-head');
  console.log('after: open nudges', JSON.stringify(board.supervisorView(owner).open.map(x => [x.task_id, x.rule, x.level])));
  await page.evaluate(() => { location.hash = '#/'; });
  await shot('5-home-after-da-nhan.png', '.stack');
  // 4 h 30 later (still daytime ICT), no work on E-07: the lane gets a fresh L1 (Laneboard rearmCandidates), the owner no new L3.
  clock.ms += 4 * H + 30 * MIN; board.sweepSupervisor();
  console.log('after the grace: open nudges', JSON.stringify(board.supervisorView(owner).open.map(x => [x.task_id, x.rule, x.level, x.lane])), 'owner-level nudges on E-07:', Object.values(board.state.feedback).filter(f => f.kind === 'nudge' && f.task_id === 'E-07' && f.level === 3).length);
  await page.clock.setFixedTime(new Date(clock.ms + 5 * MIN));
  await page.reload();
  await shot('6-home-lane-renudged.png', '.supervisor-strip');
  console.log('page errors:', errors.length ? errors : 'none');
} finally {
  await browser?.close();
  await bridge.close();
  upstream.closeAllConnections?.();
  await new Promise(r => upstream.close(r));
  board.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
console.log(`${shots.length} shots in ${OUT}`);
