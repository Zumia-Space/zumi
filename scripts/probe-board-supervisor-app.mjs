// T-31 supervisor port, red test 5: the INSTALLED app's Board tab shows the supervisor. Runs a BUILT owner app (an extracted
// installer payload: nothing is installed) with its own --data-dir, its window kept off-screen (packs/room-preview/offscreen.ps1;
// no GUI input reaches the console), against a FIXTURE board: the vendored Laneboard in-process on 127.0.0.1 with the supervisor
// on and an injected daytime clock, reached through the owner build's test-only loopback override (ZUMI_BOARD_UPSTREAM).
// Everything is driven over CDP inside the app's own webviews; the real board, the VPS and %APPDATA% are never touched.
//   node scripts/probe-board-supervisor-app.mjs --app <payload dir> --exe ZumiPreview.exe --data <empty dir> --run <out dir>
// Checks: sign-in through the app's own board API (no PIN, OS vault), live mode, the Board tab loads the bridge page; Home shows
// the "Giám sát" strip with the fixture's open nudges; E-07 (owner level) shows its chip and the "Đã nhận" button, F-12 (lane
// level) a chip and no button; pressing "Đã nhận" in the app closes the L3 on the board, and the chain stays visible at L2.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, findPorts, sleep, targets } from './lib/cdp-lite.mjs';
import { createBoard } from '../vendor/laneboard/src/board.mjs';
import { createServer } from '../vendor/laneboard/src/server.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const app = opt('app') && path.resolve(opt('app')), exe = opt('exe') || 'ZumiPreview.exe', data = opt('data') && path.resolve(opt('data')), run = opt('run') && path.resolve(opt('run'));
if (!app || !data || !run) { console.error('usage: --app <dir> [--exe ZumiPreview.exe] --data <empty dir> --run <out dir>'); process.exit(2); }
if (fs.existsSync(data) && fs.readdirSync(data).length) { console.error(`--data must be a new or empty folder: ${data}`); process.exit(2); }
fs.mkdirSync(data, { recursive: true }); fs.mkdirSync(run, { recursive: true });
let pass = 0, fail = 0;
const ok = (c, name, detail = '') => { console.log(`${c ? 'PASS' : 'FAIL'} ${name}${detail ? `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); c ? pass++ : fail++; };
const info = (name, detail) => console.log(`INFO ${name}  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
const shot = async (cdp, file) => { const r = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(file, Buffer.from(r.data, 'base64')); info('shot', file); };

// ---- the fixture board (same scenario as scripts/shot-board-supervisor.mjs) ----
const H = 3600000, MIN = 60000, T0 = Date.parse('2026-11-12T02:00:00.000Z'), iso = (ms) => new Date(ms).toISOString();
const clock = { ms: T0 };
const boardDir = path.join(run, 'fixture-board');
fs.rmSync(boardDir, { recursive: true, force: true });
const board = createBoard({ dataDir: boardDir, now: () => clock.ms, supervisorSince: iso(T0 - 24 * H), supervisorConfig: { digestHourIct: 24 } });
const owner = fs.readFileSync(board.bootstrapTokenFile, 'utf8').trim();
let n = 0;
const w = (token, op, target_id, d = {}) => board.write(token, { version: 1, request_id: `probe-sv-${process.pid}-${++n}`, op, target_id, data: d });
const coord = w(owner, 'token.issue', 'coordinator', { role: 'coordinator' }).token;
w(coord, 'task.create', 'E-07', { title: 'Release build that went quiet', lane: 'Worker A', steps: [{ id: 'build', label: 'Build the release', sub: `run:x@${iso(T0)}`, state: 'active', zone: 'build' }] });
clock.ms += 90 * MIN;
w(coord, 'task.create', 'F-12', { title: 'Docs sync, quiet run', lane: 'Worker B', steps: [{ id: 'sync', label: 'Sync the docs', sub: `run:y@${iso(clock.ms)}`, state: 'active', zone: 'build' }] });
w(coord, 'task.create', 'G-03', { title: 'Healthy task', lane: 'Worker A', steps: [{ id: 'a', label: 'Write the plan', state: 'todo', zone: 'build' }] });
clock.ms = T0 + 4 * H + MIN; board.sweepSupervisor(); clock.ms += 61 * MIN; board.sweepSupervisor(); clock.ms += 61 * MIN; board.sweepSupervisor();
const openOf = () => board.supervisorView(owner).open.map((x) => [x.task_id, x.rule, x.level]);
info('fixture open nudges', openOf());
const upstream = createServer(board);
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
info('fixture board', upstreamUrl);

// ---- the app, off-screen, own data dir, test-only loopback upstream ----
const BROWSER_ARGS = '--remote-debugging-port=0 --disable-features=msWebOOUI,msPdfOOUI,CalculateNativeWinOcclusion --disable-renderer-backgrounding --disable-background-timer-throttling';
const helper = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'packs', 'room-preview', 'offscreen.ps1'), '-Exe', path.resolve(app, exe), '-Seconds', '900', '-Log', path.join(run, 'offscreen.log')], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res, rej) => { helper.stdout.on('data', (d) => { if (String(d).includes('ready')) res(); }); helper.on('exit', () => rej(new Error('offscreen helper exited'))); });
const child = spawn(path.join(app, exe), ['--data-dir', data], { cwd: app, stdio: 'ignore', env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: BROWSER_ARGS, ZUMI_BOARD_UPSTREAM: upstreamUrl } });
info('app pid', String(child.pid));
const stop = async () => {
  try { execFileSync('taskkill', ['/PID', String(child.pid), '/T'], { stdio: 'ignore' }); } catch { /* gone */ }
  for (let i = 0; i < 30 && child.exitCode === null; i++) await sleep(500);
  if (child.exitCode === null) { try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ } }
  try { execFileSync('taskkill', ['/PID', String(helper.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
};
/** A page or frame target whose url matches `re`, on any DevTools port under the data dir. */
async function waitAny(re, timeoutMs = 90000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    for (const { port } of findPorts(data)) {
      try { const t = (await targets(port)).find((x) => ['page', 'iframe', 'webview', 'other'].includes(x.type) && re.test(x.url) && x.webSocketDebuggerUrl); if (t) return t; } catch { /* stale port */ }
    }
    await sleep(500);
  }
  throw new Error(`no target matching ${re} within ${timeoutMs} ms`);
}
const until = async (cdp, expr, timeoutMs = 30000) => { const end = Date.now() + timeoutMs; while (Date.now() < end) { if (await cdp.evaluate(expr).catch(() => false)) return true; await sleep(300); } return false; };

const result = {};
try {
  const page = await connect((await waitAny(/^http:\/\/tauri\.localhost\//, 120000)).webSocketDebuggerUrl);
  await until(page, '!!(window.zumi && window.zumi.board)', 60000);
  const flavour = await page.evaluate('(async () => { try { return await window.zumi.appInfo?.(); } catch (e) { return String(e); } })()').catch(() => null);
  info('app info', flavour);
  const signIn = await page.evaluate(`(async () => { const s = await window.zumi.board.setSecretsOs({ user: 'probe', pass: 'probe', token: ${JSON.stringify(owner)} }); const m = await window.zumi.board.setMode('live'); const st = await window.zumi.board.status(); return { s, m, st: { mode: st.mode, configured: st.configured, locked: st.locked } }; })()`);
  result.signIn = signIn;
  ok(signIn.s?.ok === true && signIn.m?.ok === true && signIn.st.mode === 'live', 'the app signs in to the fixture board through its own board API and goes live (no PIN, OS vault, isolated data dir)', signIn);
  // a fresh data dir opens the first-run personality picker over everything: skip it like a person would
  const skipped = await page.evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Skip' && x.offsetParent); if (b) b.click(); return !!b; })()`);
  info('first-run picker skipped', String(skipped));
  // The language under test (--lang, default vi), set through the app's own EN / VI / 中文 switch (settings.json uiLang in the isolated
  // data dir). The switch's click handler is wired only once the app has booted (app.js), so a click before that is lost: click
  // until the switch reports the language as checked AND the saved setting reads it back, else fail. --no-switch leaves the app in
  // its OS language on purpose (the negative run: a probe that expects vi must then FAIL).
  const lang = opt('lang') || 'vi';
  const LOC = (l) => JSON.parse(fs.readFileSync(path.join(ROOT, 'vendor', 'laneboard', 'public', 'locales', `${l}.json`), 'utf8'));
  const want = LOC(lang), en = LOC('en');
  if (!args.includes('--no-switch')) {
    const isSet = `(async () => document.querySelector('#lang-switch button[data-lang="${lang}"]')?.getAttribute('aria-checked') === 'true' && (await window.zumi.ui.getLang('en')) === '${lang}')()`;
    let set = false;
    for (const end = Date.now() + 60000; Date.now() < end && !set;) {
      await page.evaluate(`(() => { const b = document.querySelector('#lang-switch button[data-lang="${lang}"]'); if (b) b.click(); return true; })()`);
      await sleep(700);
      set = await page.evaluate(isSet).catch(() => false);
    }
    ok(set, `the app language is set to ${lang} (switch checked and the saved setting reads ${lang})`);
  } else {
    info('language switch', `skipped (--no-switch): the app stays in its OS language while the probe expects ${lang}`);
    // still wait until the app has booted (the switch shows the current language), so only the language differs from a real run
    ok(await until(page, `[...document.querySelectorAll('#lang-switch button')].some((b) => b.getAttribute('aria-checked') === 'true')`, 60000), 'the app has booted (the language switch shows the current language)');
  }
  const shell = await page.evaluate(`(async () => ({ htmlLang: document.documentElement.lang, checked: [...document.querySelectorAll('#lang-switch button')].map((b) => b.dataset.lang + '=' + b.getAttribute('aria-checked')), saved: await window.zumi.ui?.getLang?.('en').catch((e) => 'err ' + e), boardTabLabel: document.querySelector('.tab[data-tab="board"]')?.textContent.trim() }))()`);
  result.shellLang = shell; info('app language after the switch', shell);
  // the tab's click handler is wired only after boot too: click until the Board tab holds the board guest (its <webview> stand-in)
  let opened = false;
  for (const end = Date.now() + 60000; Date.now() < end && !opened;) {
    await page.evaluate(`(document.querySelector('.tab[data-tab="board"]') || { click() {} }).click(), true`);
    opened = await until(page, `!!document.querySelector('#tab-board webview[src]')`, 3000);
  }
  ok(opened, 'the Board tab opens the board guest');
  await sleep(3000);
  const all = []; for (const { port, dir } of findPorts(data)) { try { for (const t of await targets(port)) all.push({ port, dir: path.relative(data, dir), type: t.type, url: String(t.url).replace(/n=[0-9a-f]+/, 'n=…').slice(0, 120) }); } catch { /* stale */ } }
  info('targets after the Board tab click', all);
  info('board tab', await page.evaluate(`(() => { const p = document.querySelector('#tab-board'); return { text: (p?.innerText || '').replace(/\\s+/g, ' ').slice(0, 300), webviews: [...document.querySelectorAll('#tab-board webview, #tab-board iframe')].map((x) => x.tagName + ' ' + (x.getAttribute('src') || '').replace(/n=[0-9a-f]+/, 'n=…').slice(0, 100)) }; })()`).catch((e) => String(e)));
  await shot(page, path.join(run, 'app-0-board-tab.png'));
  const bt = await waitAny(/^http:\/\/127\.0\.0\.1:\d+\/(\?|#|$)/, 90000);
  info('board target', { type: bt.type, url: bt.url.replace(/n=[0-9a-f]+/, 'n=…') });
  const guest = await connect(bt.webSocketDebuggerUrl);
  ok(await until(guest, `!!document.querySelector('.supervisor-strip')`, 60000), 'Home shows the "Giám sát" strip (GET /api/v1/supervisor through the app bridge)');
  const pageLang = await guest.evaluate('document.documentElement.lang');
  ok(pageLang === lang, `the Board page runs in ${lang} (html lang)`, pageLang);
  const strip = await guest.evaluate(`({ title: document.querySelector('.supervisor-strip h2')?.childNodes[0]?.textContent.trim(), rows: [...document.querySelectorAll('.supervisor-strip .sv-row')].map((r) => r.innerText.replace(/\\s+/g, ' ').slice(0, 90)) })`);
  result.strip = strip; info('strip', strip);
  ok(strip.title === want['supervisor.title'] && (lang === 'en' || strip.title !== en['supervisor.title']), `the strip title is the ${lang} "${want['supervisor.title']}"`, strip.title);
  ok(strip.rows.length === 2 && /E-07/.test(strip.rows[0]) && /R1 · L3/.test(strip.rows[0]) && /F-12/.test(strip.rows[1]), 'the strip lists E-07 (R1 · L3) first, then F-12', strip.rows);
  await sleep(800); await shot(guest, path.join(run, 'app-1-board-home-strip.png')); // the board is a native child WebView2 over the tab: shoot the guest itself
  await guest.evaluate(`location.hash = '#/task/F-12', true`);
  await until(guest, `!!document.querySelector('.tv-head .sv-badge')`);
  const f12 = await guest.evaluate(`({ chip: document.querySelector('.tv-head .sv-badge')?.textContent, button: !!document.querySelector('.tv-head .sv-receipt') })`);
  ok(f12.chip?.startsWith('R1 · ') && !f12.button, 'F-12 (lane level): a chip, no button', f12);
  const chipTip = await guest.evaluate(`document.querySelector('.tv-head .sv-badge')?.title || ''`);
  const tipHead = want['supervisor.chipTitle'].split('{')[0];
  ok(chipTip.startsWith(tipHead), `the chip's tooltip is in ${lang} ("${tipHead}…")`, chipTip.slice(0, 80));
  await guest.evaluate(`location.hash = '#/task/E-07', true`);
  ok(await until(guest, `!!document.querySelector('.tv-head .sv-receipt')`), 'E-07 (owner level): the receipt button is in the task header');
  const e07 = await guest.evaluate(`({ chip: document.querySelector('.tv-head .sv-badge')?.textContent, cls: document.querySelector('.tv-head .sv-badge')?.className, button: document.querySelector('.tv-head .sv-receipt')?.textContent, lang: document.documentElement.lang })`);
  result.e07 = e07; info('E-07 header', e07);
  // strict per language: the label must be the one of the language under test ("Đã nhận" for vi); "Received" in a vi run FAILS
  const label = want['supervisor.receipt'];
  ok(/lvl3/.test(e07.cls || '') && e07.button === label && (lang === 'en' || e07.button !== en['supervisor.receipt']), `E-07 chip is owner level and the button reads the ${lang} label "${label}"`, e07);
  await sleep(500); await shot(guest, path.join(run, 'app-2-task-E07-L3.png'));
  await guest.evaluate(`document.querySelector('.tv-head .sv-receipt').click(), true`);
  ok(await until(guest, `!document.querySelector('.tv-head .sv-receipt') && !!document.querySelector('.tv-head .sv-badge.lvl2')`), 'after "Đã nhận" the button is gone and the chip shows the chain at L2');
  const after = openOf();
  result.after = after; info('board open nudges after the click', after);
  const l3 = Object.values(board.state.feedback).filter((f) => f.kind === 'nudge' && f.task_id === 'E-07' && f.level === 3);
  ok(l3.length === 1 && l3[0].status === 'resolved' && l3[0].resolved?.by?.role === 'owner' && after.some(([t, , l]) => t === 'E-07' && l === 2), 'the app\'s click closed the L3 on the board as the owner; E-07 stays visible at L2', { l3: l3.map((f) => [f.status, f.resolved?.by?.role]), after });
  await sleep(500); await shot(guest, path.join(run, 'app-3-task-E07-after-da-nhan.png'));
  guest.close(); page.close();
} catch (e) {
  ok(false, 'the probe ran to the end', String(e?.stack || e).split('\n').slice(0, 3).join(' | '));
} finally {
  await stop();
  upstream.closeAllConnections?.(); await new Promise((r) => upstream.close(r)); board.close();
  fs.writeFileSync(path.join(run, 'probe-board-supervisor-result.json'), JSON.stringify(result, null, 1));
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
