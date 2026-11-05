#!/usr/bin/env node
// check:board-step-overlap (T-31 alpha.14). The owner saw board step labels overlap in the right column. The app serves the vendored page from disk through the
// bridge, so this goes through the app's own path: real board server (vendored) -> src/main/board-bridge.mjs with a session url -> the vendored page, headless
// Chromium. 36 long Vietnamese labels, right column 340 px: no adjacent rows overlap, every label stays inside its row, a short label stays one line.
//   node scripts/check-board-step-overlap.mjs [--public <dir>] [--shot <file>]
// --public is the negative control: the page of another Laneboard commit, for example `git archive 7de4b61 public`. No network, no key, no window.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ownerPath } from './lib/owner-paths.mjs';
import { createBridge } from '../src/main/board-bridge.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(ROOT, 'package.json'));
const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const publicDir = path.resolve(opt('--public') || path.join(ROOT, 'vendor', 'laneboard', 'public'));
let pass = 0, fail = 0;
const ok = (c, name, detail = '') => { if (c) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}  ${detail}`); } };
const WIDTH = 340;
const LONG = ['Đặt nhân vật 2026 vào đúng cảnh thời trần 2026 kèm clip cho anh xem lại', 'Gói Colab chỉ gắn xương, bốn mẫu còn thiếu và đo độ lệch từng khớp', 'Xoá khỏi cửa thừa rồi thử chuyển động trong cảnh của năm 2026', 'Nghiên cứu kho mã nguồn anh gửi và chép lại phần cần dùng cho bản sau', 'Anh xem clip chuyển động tám giây trong thị trấn năm 2026 rồi chốt'];
const LABELS = Array.from({ length: 35 }, (_, i) => `${i + 1}. ${LONG[i % LONG.length]}`);
LABELS.splice(17, 0, 'Việc ngắn');

const { createBoard } = await import(pathToFileURL(path.join(ROOT, 'vendor', 'laneboard', 'src', 'board.mjs')));
const { createServer } = await import(pathToFileURL(path.join(ROOT, 'vendor', 'laneboard', 'src', 'server.mjs')));
const { chromium } = req(process.env.ZUMI_PLAYWRIGHT_DIR || ownerPath('playwrightDir', 'node_modules/playwright'));
const EXE = process.env.ZUMI_CHROMIUM || ownerPath('chromiumExe', 'local/chrome.exe');

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'zumi-step-overlap-'));
const secret = crypto.randomBytes(32).toString('base64url');
const board = createBoard({ dataDir: data });
const server = createServer(board, { ownerProxySecret: secret });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const upstream = `http://127.0.0.1:${server.address().port}`;
const OWNER = { 'X-Laneboard-Owner-Proxy': secret, 'X-Requested-With': 'laneboard' };
const write = async (headers, op, target_id, d) => {
  const r = await fetch(`${upstream}/api/v1/write`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ version: 1, request_id: `so-${crypto.randomBytes(6).toString('hex')}`, op, target_id, data: d }) });
  const j = await r.json();
  if (!r.ok) throw new Error(`seed ${op}: ${r.status} ${JSON.stringify(j)}`);
  return j;
};
let bridge, browser;
try {
  const issued = await write(OWNER, 'token.issue', `overlap-${crypto.randomBytes(3).toString('hex')}`, { role: 'coordinator', replace_coordinator: true, label: 'step-overlap' });
  const token = issued.token || (issued.result && issued.result.token);
  await write({ Authorization: `Bearer ${token}` }, 'task.create', 'SO-1', { title: 'Step overlap', lane: 'fixture', now: 'Synthetic.', steps: LABELS.map((label, i) => ({ id: `s${i + 1}`, label, zone: 'build', state: 'todo' })) });
  bridge = createBridge({ upstreamOrigin: upstream, getToken: () => token, publicDir });
  const session = await bridge.sessionUrl();
  browser = await chromium.launch({ executablePath: EXE, headless: true, timeout: 60000 });
  const ctx = await browser.newContext({ viewport: { width: 1204, height: 900 }, colorScheme: 'dark' });
  const page = await ctx.newPage();
  await page.goto(session, { waitUntil: 'load' });
  await page.goto(`${new URL(session).origin}/#/task/SO-1`, { waitUntil: 'load' });
  await page.waitForSelector('.srow-main', { timeout: 30000 });
  if (await page.$('.more[data-action="steps-all"][aria-expanded="false"]')) await page.click('.more[data-action="steps-all"]');
  await page.evaluate((w) => { const c = document.querySelector('.ctx'); for (const [k, v] of [['width', `${w}px`], ['max-width', `${w}px`], ['flex', 'none']]) c.style.setProperty(k, v, 'important'); }, WIDTH);
  await page.waitForTimeout(600);
  const rows = await page.evaluate(() => [...document.querySelectorAll('.slist .srow')].map((r, i, all) => {
    const b = r.getBoundingClientRect(), s = r.querySelector('.sl'), sb = s.getBoundingClientRect(), prevLabel = i ? all[i - 1].querySelector('.sl').getBoundingClientRect() : null, prev = i ? all[i - 1].getBoundingClientRect() : null;
    return { n: i + 1, text: s.textContent, h: Math.round(b.height), lines: Math.round(sb.height / parseFloat(getComputedStyle(s).lineHeight)), overlap: prev ? +(prev.bottom - b.top).toFixed(1) : 0, labelOverlap: prevLabel ? +(prevLabel.bottom - sb.top).toFixed(1) : 0, inside: sb.top >= b.top - 0.5 && sb.bottom <= b.bottom + 0.5 };
  }));
  const paneWidth = await page.evaluate(() => Math.round(document.querySelector('.ctx').getBoundingClientRect().width));
  console.log(`INFO page ${publicDir}, pane ${paneWidth} px, ${rows.length} rows, heights ${[...new Set(rows.map((r) => r.h))].join('/')}`);
  ok(paneWidth === WIDTH, `the right column is ${WIDTH} px`, String(paneWidth));
  ok(rows.length === 36, 'all 36 steps are listed', String(rows.length));
  ok(rows.filter((r) => r.lines >= 2).length >= 20, 'the labels really wrap, so the check is not vacuous', String(rows.filter((r) => r.lines >= 2).length));
  // A fixed-height row can hold its box and still let its two-line label run over the next row, so the labels are what is measured.
  const over = rows.filter((r) => r.overlap > 0.5 || r.labelOverlap > 0.5);
  ok(over.length === 0, 'no adjacent rows or labels overlap', `${over.length} overlaps, rows ${over.slice(0, 8).map((r) => r.n).join(',')}`);
  const out = rows.filter((r) => !r.inside);
  ok(out.length === 0, 'every label stays inside its row', `${out.length} labels outside`);
  const short = rows.find((r) => r.text.includes('Việc ngắn'));
  ok(short && short.lines === 1, 'a short label stays one line');
  if (opt('--shot')) await (await page.$('.slist')).screenshot({ path: path.resolve(opt('--shot')) });
} finally {
  if (browser) await browser.close();
  if (bridge) await bridge.close();
  server.closeAllConnections(); await new Promise((r) => server.close(r));
  board.close();
  fs.rmSync(data, { recursive: true, force: true });
}
console.log(`check:board-step-overlap: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
