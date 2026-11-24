// T-31 board-poll: does the Board guest keep polling while its tab is shown? Runs a BUILT owner app (extracted payload, nothing
// installed) ON-SCREEN on the spare with its own --data-dir, against a FIXTURE board (vendored Laneboard on 127.0.0.1 through the owner
// build's test-only ZUMI_BOARD_UPSTREAM). The real board is never touched. The window is driven by Win32 only (scripts/lib/window-drive.ps1):
// occlude with a topmost form, minimise/restore, move off/on screen, and a Zumi -> Board tab switch through the main page. No GUI input.
// Display power phases post SC_MONITORPOWER (off, then on) — the spare's own monitor only.
//   node scripts/probe-board-visibility.mjs --app <payload dir> [--exe ZumiPreview.exe] --data <empty dir> --run <out dir> [--phase-s 35]
//     [--start-offscreen] [--lang vi] [--browser-args "<WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS>"] [--dark-only] [--args-only]
//     [--idle <n> [--idle-every-s 30]]
// --idle (T-31 alpha.9.7, the owner-PC smoke's "guest hidden in 20/20 idle samples"): no phases; n samples while the Board tab is shown, then
// three on the Zumi tab. Each sample lists EVERY guest page under the data dir (not just the first one found), with its visibilityState and
// poll count, the main page's <webview> elements, and the native child windows (window-drive.ps1 tree), so a second, never-shown guest or a
// controller left hidden is told apart from the shown guest reporting hidden. Written to idle.json; exit 1 on any bad sample.
// Per phase it records the guest's and the main page's document.visibilityState (1 s samples), the guest's own GET /api/v1/state count,
// the fixture's hit count, for a "shown" phase the seconds until the first poll, the main page's rAF ticks per second (the <webview>
// shim shows a guest only from a rAF tick) and every guest_* IPC call and guest:event (read off CDP Network / the event bus).
// browser-args.json records the effective --disable-features of the main and guest browser processes. The Laneboard page polls every
// 15 s while visible.
// Exit 1 when the Board tab is shown and the guest is hidden or does not poll within one interval (+3 s slack) in any phase.
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
const PHASE_MS = Number(opt('phase-s') || 35) * 1000, POLL_MS = 15000, SLACK_MS = 3000;
if (!app || !data || !run) { console.error('usage: --app <dir> [--exe ZumiPreview.exe] --data <empty dir> --run <out dir> [--phase-s 35]'); process.exit(2); }
if (fs.existsSync(data) && fs.readdirSync(data).length) { console.error(`--data must be a new or empty folder: ${data}`); process.exit(2); }
fs.mkdirSync(data, { recursive: true }); fs.mkdirSync(run, { recursive: true });
const log = (s) => { const line = `${new Date().toISOString()} ${s}`; console.log(line); fs.appendFileSync(path.join(run, 'probe.log'), line + '\n'); };
const DRIVE = path.join(ROOT, 'scripts', 'lib', 'window-drive.ps1');
const drive = (pid, action) => JSON.parse(execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', DRIVE, '-ProcessId', String(pid), '-Action', action], { encoding: 'utf8' }).trim().split(/\r?\n/).pop());

// ---- fixture board: one owner token, one task; counts every GET /api/v1/state it serves ----
const boardDir = path.join(run, 'fixture-board');
const board = createBoard({ dataDir: boardDir });
const owner = fs.readFileSync(board.bootstrapTokenFile, 'utf8').trim();
const coord = board.write(owner, { version: 1, request_id: `vis-${process.pid}-1`, op: 'token.issue', target_id: 'coordinator', data: { role: 'coordinator' } }).token;
board.write(coord, { version: 1, request_id: `vis-${process.pid}-2`, op: 'task.create', target_id: 'V-01', data: { title: 'Visibility probe task', lane: 'Worker A', steps: [{ id: 'a', label: 'Poll me', state: 'todo', zone: 'build' }] } });
const upstream = createServer(board);
let fixtureHits = 0;
upstream.prependListener('request', (req) => { if (req.method === 'GET' && /\/api\/v1\/state/.test(req.url)) fixtureHits++; });
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
log(`fixture board ${upstreamUrl}`);

// ---- the app, ON-screen (or, with --start-offscreen, kept at (-32000,-32000) from launch by packs/room-preview/offscreen.ps1 as the
// alpha.9 smoke probes run it, until the second phase moves it on-screen); remote debugging is the only extra browser arg (the app's own
// per-webview args stay in force: the env var is merged with them, browser-args.json records the effective switches) ----
const START_OFFSCREEN = args.includes('--start-offscreen');
// --strict (alpha.9.5): the Board tab is the active tab in the covered / minimised / off-screen phases too, and the Board must keep polling
// there, as the main page does (occlusion off) and as Electron did; only the Zumi-tab phases (the shell hides the guest) are exempt.
const STRICT = args.includes('--strict');
const IDLE = Number(opt('idle') || 0), IDLE_EVERY_MS = Number(opt('idle-every-s') || 30) * 1000;
let idleBad = 0;
let helper = null;
if (START_OFFSCREEN) {
  helper = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'packs', 'room-preview', 'offscreen.ps1'), '-Exe', path.resolve(app, exe), '-Seconds', '900', '-Log', path.join(run, 'offscreen.log')], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((res, rej) => { helper.stdout.on('data', (d) => { if (String(d).includes('ready')) res(); }); helper.on('exit', () => rej(new Error('offscreen helper exited'))); });
}
const endHelper = () => { if (helper) { try { execFileSync('taskkill', ['/PID', String(helper.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ } helper = null; } };
const child = spawn(path.join(app, exe), ['--data-dir', data], { cwd: app, stdio: 'ignore', env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: opt('browser-args') || '--remote-debugging-port=0', ZUMI_BOARD_UPSTREAM: upstreamUrl } });
log(`app pid ${child.pid}`);
let occluder = null;
const stop = async () => {
  endHelper();
  if (occluder) { try { execFileSync('taskkill', ['/PID', String(occluder.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ } }
  try { execFileSync('taskkill', ['/PID', String(child.pid), '/T'], { stdio: 'ignore' }); } catch { /* gone */ }
  for (let i = 0; i < 30 && child.exitCode === null; i++) await sleep(500);
  if (child.exitCode === null) { try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ } }
};
async function waitAny(re, timeoutMs = 90000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    for (const { port } of findPorts(data)) {
      try { const t = (await targets(port)).find((x) => x.type === 'page' && re.test(x.url) && x.webSocketDebuggerUrl); if (t) return t; } catch { /* stale port */ }
    }
    await sleep(500);
  }
  throw new Error(`no target matching ${re} within ${timeoutMs} ms`);
}
const until = async (cdp, expr, timeoutMs = 30000) => { const end = Date.now() + timeoutMs; while (Date.now() < end) { if (await cdp.evaluate(expr).catch(() => false)) return true; await sleep(300); } return false; };
/** The effective command line of every WebView2 browser process under the data dir: is native occlusion off for main and guest? */
function browserArgs() {
  const ps = `Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | Where-Object { $_.CommandLine -notmatch '--type=' } | ForEach-Object { $_.CommandLine }`;
  const lines = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).split(/\r?\n/).filter((l) => l.includes(data));
  return lines.map((l) => ({ userData: (l.match(/--user-data-dir="?([^"]+?)"?(\s--|$)/) || [])[1]?.replace(data, '<data>'), occlusionOff: /CalculateNativeWinOcclusion/.test(l), timerThrottlingOff: /--disable-background-timer-throttling/.test(l), disableFeatures: (l.match(/--disable-features=\S+/g) || []) }));
}

const phases = [];
let failed = 0;
let page = null;
/** Every guest page under the data dir (all browser processes), not only the first match: a stale or never-shown guest shows up here. */
async function guestPages() {
  const out = [];
  for (const { port } of findPorts(data)) {
    try { for (const t of await targets(port)) if (t.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\//.test(t.url) && t.webSocketDebuggerUrl) out.push({ port, t }); } catch { /* stale port */ }
  }
  return out;
}
const STATE_POLLS = `performance.getEntriesByType('resource').filter((e) => e.name.includes('api/v1/state'))`;
async function idleSample(label) {
  const guests = [];
  for (const { port, t } of await guestPages()) {
    let c = null;
    try {
      c = await connect(t.webSocketDebuggerUrl);
      const v = await c.evaluate(`(() => { const p = ${STATE_POLLS}; return { vis: document.visibilityState, polls: p.length, lastPollAgoS: p.length ? Math.round((performance.now() - p.at(-1).startTime) / 1000) : null }; })()`);
      guests.push({ port, target: t.id.slice(0, 8), origin: new URL(t.url).origin, ...v });
    } catch (e) { guests.push({ port, target: t.id.slice(0, 8), err: String(e?.message || e) }); } finally { try { c?.close(); } catch { /* closed */ } }
  }
  const tab = await page.evaluate(`document.querySelector('.tab.active')?.dataset.tab`).catch(() => 'err');
  const main = await page.evaluate('document.visibilityState').catch(() => 'err');
  const webviews = await page.evaluate(`[...document.querySelectorAll('webview')].map((w) => { const r = w.getBoundingClientRect(); return { host: w.parentElement?.id || '', w: Math.round(r.width), h: Math.round(r.height), loaded: w.dataset.loaded === '1' }; })`).catch(() => 'err');
  let tree = [];
  try { tree = drive(child.pid, 'tree').windows.flatMap((w) => w.tree || []); } catch (e) { tree = [`tree failed: ${e.message}`]; }
  return { at: new Date().toISOString(), label, tab, main, webviews, guests, tree };
}
/** --idle: n samples with the Board tab shown (each must show exactly one guest page, visible, polling at the 15 s rate), then three on the
 *  Zumi tab (every guest page must be hidden), then the Board tab again (visible). */
async function idleRun() {
  // The vendored page polls from a 15 s interval when >= 10 s passed (>= 55 s while hidden), and at once on visibilitychange; a poll on a
  // show can make the next tick skip, so a visible page's gap is at most 25 s (+3 s slack), while a hidden page's is about 60 s.
  const VISIBLE_GAP_S = 28;
  const samples = [];
  const judge = (s, wantVisible) => {
    const bad = [];
    if (s.guests.length !== 1) bad.push(`${s.guests.length} guest pages`);
    for (const g of s.guests) {
      if (g.err) bad.push(`guest ${g.target}: ${g.err}`);
      else if (wantVisible && g.vis !== 'visible') bad.push(`guest ${g.target} ${g.vis}`);
      else if (!wantVisible && g.vis !== 'hidden') bad.push(`guest ${g.target} ${g.vis} on the Zumi tab`);
      if (wantVisible && g.lastPollAgoS !== null && g.lastPollAgoS > VISIBLE_GAP_S) bad.push(`guest ${g.target} last poll ${g.lastPollAgoS}s ago`);
    }
    s.bad = bad; if (bad.length) idleBad++;
    samples.push(s); log(`${bad.length ? 'BAD ' : 'ok  '}${s.label} tab=${s.tab} main=${s.main} guests=${JSON.stringify(s.guests)} webviews=${JSON.stringify(s.webviews)}${bad.length ? ' :: ' + bad.join('; ') : ''}`);
  };
  const t0 = Date.now();
  for (let i = 1; i <= IDLE; i++) {
    await sleep(Math.max(0, t0 + i * IDLE_EVERY_MS - Date.now()));
    judge(await idleSample(`idle ${i}/${IDLE} +${Math.round((Date.now() - t0) / 1000)}s`), true);
  }
  await page.evaluate(`document.querySelector('.tab[data-tab="zumi"]').click(), true`);
  for (let i = 1; i <= 3; i++) { await sleep(i === 1 ? 10000 : 20000); judge(await idleSample(`zumi tab ${i}/3`), false); }
  await page.evaluate(`document.querySelector('.tab[data-tab="board"]').click(), true`);
  await sleep(20000); judge(await idleSample('board tab again +20s'), true);
  fs.writeFileSync(path.join(run, 'idle.json'), JSON.stringify(samples, null, 1));
}
try {
  page = await connect((await waitAny(/^http:\/\/tauri\.localhost\//, 120000)).webSocketDebuggerUrl);
  await until(page, '!!(window.zumi && window.zumi.board)', 60000);
  const signIn = await page.evaluate(`(async () => { const s = await window.zumi.board.setSecretsOs({ user: 'probe', pass: 'probe', token: ${JSON.stringify(owner)} }); const m = await window.zumi.board.setMode('live'); const st = await window.zumi.board.status(); return { s: s?.ok, m: m?.ok, mode: st.mode }; })()`);
  log(`sign-in ${JSON.stringify(signIn)}`);
  await page.evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Skip' && x.offsetParent); if (b) b.click(); return !!b; })()`);
  // Instrument the main page: its rAF rate (the <webview> shim places and SHOWS a guest only from a rAF loop) and every guest_*
  // command / guest:event the shim sends or gets (core.invoke is looked up per call by the shim, so wrapping it sees them all).
  log(`instrument ${JSON.stringify(await page.evaluate(`(() => { const P = window.__probe = { raf: 0, calls: [] }; (function f() { P.raf++; requestAnimationFrame(f); })();
    window.__TAURI__.event.listen('guest:event', (e) => P.calls.push([Date.now(), 'event', e.payload.type + (e.payload.errorCode ? ' ' + e.payload.errorCode : '')]));
    return true; })()`))}`);
  // The IPC objects are frozen, so the guest_* commands are read off the wire: Tauri's IPC is a POST to http://ipc.localhost/<cmd>.
  const ipc = new Map();
  page.on((m) => {
    if (m.method === 'Network.requestWillBeSent' && /^http:\/\/ipc\.localhost\/guest_/.test(m.params.request.url)) {
      const cmd = m.params.request.url.split('/').pop(); let d = '';
      try { const b = JSON.parse(m.params.request.postData || '{}'); if (cmd === 'guest_bounds') d = `${b.visible} ${[b.bounds.x, b.bounds.y, b.bounds.width, b.bounds.height].map(Math.round).join(',')}`; } catch { d = 'body?'; }
      ipc.set(m.params.requestId, { t: Date.now(), cmd, d });
    } else if (m.method === 'Network.responseReceived' && ipc.has(m.params.requestId)) {
      const r = ipc.get(m.params.requestId); ipc.delete(m.params.requestId);
      page.evaluate(`window.__probe.calls.push([${r.t}, ${JSON.stringify(r.cmd)}, ${JSON.stringify(`${r.d} -> ${m.params.response.status}`)}]), true`).catch(() => {});
    }
  });
  await page.send('Network.enable', { maxPostDataSize: 4096 });
  const openBoard = async () => {
    for (const end = Date.now() + 60000; Date.now() < end;) {
      await page.evaluate(`(document.querySelector('.tab[data-tab="board"]') || { click() {} }).click(), true`);
      if (await until(page, `!!document.querySelector('#tab-board webview[src]') && document.querySelector('.tab[data-tab="board"]')?.classList.contains('active')`, 3000)) return true;
    }
    return false;
  };
  if (opt('lang')) {
    // The alpha.9 board probe's start: click the EN / VI switch until the saved setting reads it (its handler is wired only after boot).
    const lang = opt('lang'); let set = false;
    for (const end = Date.now() + 60000; Date.now() < end && !set;) {
      await page.evaluate(`(() => { const b = document.querySelector('#lang-switch button[data-lang="${lang}"]'); if (b) b.click(); return true; })()`);
      await sleep(700);
      set = await page.evaluate(`(async () => document.querySelector('#lang-switch button[data-lang="${lang}"]')?.getAttribute('aria-checked') === 'true' && (await window.zumi.ui.getLang('en')) === '${lang}')()`).catch(() => false);
    }
    log(`language ${lang} set: ${set}`);
  }
  if (!(await openBoard())) throw new Error('the Board tab did not open');
  if (!START_OFFSCREEN) {
    log(`window ${JSON.stringify(drive(child.pid, 'onscreen'))}`);
    log(`window ${JSON.stringify(drive(child.pid, 'topmost'))}`);
  }
  const guest = await connect((await waitAny(/^http:\/\/127\.0\.0\.1:\d+\/(\?|#|$)/, 90000)).webSocketDebuggerUrl);
  if (!(await until(guest, `!!document.querySelector('#main') && document.body.innerText.includes('V-01')`, 60000))) log('WARN the fixture task V-01 is not on the board page');
  await guest.evaluate('performance.setResourceTimingBufferSize(100000), true');
  const args0 = browserArgs();
  log(`browser processes ${JSON.stringify(args0)}`);
  fs.writeFileSync(path.join(run, 'browser-args.json'), JSON.stringify(args0, null, 1));
  log(`guest calls while the Board tab opened ${JSON.stringify(await page.evaluate('window.__probe.calls').catch((e) => String(e)))}`);
  if (args.includes('--args-only')) throw new Error('--args-only: stopped after recording the browser args');
  if (IDLE) { await idleRun(); throw new Error('IDLE_DONE'); }
  const guestFetches = () => guest.evaluate(`performance.getEntriesByType('resource').filter((e) => e.name.includes('api/v1/state')).length`);

  /** One phase: run `enter` at t=0, sample for PHASE_MS. `shown` = the Board tab is on screen to a person, so the page must poll. */
  async function phase(name, shown, enter) {
    const f0 = await guestFetches(), h0 = fixtureHits, t0 = Date.now();
    const how = await enter();
    const samples = [], rafs = []; let firstPollMs = null, last = f0, raf0 = await page.evaluate('window.__probe.raf').catch(() => 0);
    const calls0 = await page.evaluate('window.__probe.calls.length').catch(() => 0);
    while (Date.now() - t0 < PHASE_MS) {
      await sleep(1000);
      const raf = await page.evaluate('window.__probe.raf').catch(() => raf0); rafs.push(raf - raf0); raf0 = raf;
      const s = await guest.evaluate(`({ g: document.visibilityState, n: performance.getEntriesByType('resource').filter((e) => e.name.includes('api/v1/state')).length })`).catch((e) => ({ g: 'err', n: last }));
      const m = await page.evaluate('document.visibilityState').catch(() => 'err');
      if (firstPollMs === null && s.n > last) firstPollMs = Date.now() - t0;
      last = s.n; samples.push(`${s.g[0]}${m[0]}`);
    }
    const guestHiddenSamples = samples.filter((x) => x[0] === 'h').length;
    const row = { name, shown, how, guestHidden: `${guestHiddenSamples}/${samples.length}`, mainHidden: `${samples.filter((x) => x[1] === 'h').length}/${samples.length}`, guestPolls: last - f0, fixtureHits: fixtureHits - h0, firstPollS: firstPollMs === null ? null : +(firstPollMs / 1000).toFixed(1) };
    row.mainRafPerS = { min: Math.min(...rafs), max: Math.max(...rafs) };
    row.guestCalls = (await page.evaluate(`window.__probe.calls.slice(${calls0})`).catch(() => [])).map(([t, c, d]) => `+${((t - t0) / 1000).toFixed(1)}s ${c} ${d}`.trim());
    row.ok = !shown || (guestHiddenSamples === 0 && firstPollMs !== null && firstPollMs <= POLL_MS + SLACK_MS);
    if (!row.ok) failed++;
    phases.push(row); log(`${row.ok ? 'PASS' : 'FAIL'} phase ${JSON.stringify(row)}`);
  }
  const startOccluder = () => new Promise((res, rej) => {
    occluder = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', DRIVE, '-Action', 'occlude', '-Seconds', '900'], { stdio: ['ignore', 'pipe', 'inherit'] });
    occluder.stdout.on('data', (d) => { if (String(d).includes('occluding')) res('topmost form over the virtual screen'); });
    occluder.on('exit', () => rej(new Error('occluder exited')));
  });
  const endOccluder = () => { execFileSync('taskkill', ['/PID', String(occluder.pid), '/T', '/F'], { stdio: 'ignore' }); occluder = null; return 'occluder closed'; };

  if (START_OFFSCREEN) {
    // Off-screen is not "shown" to a person; the row records what the page believes while its tab is the active one.
    await phase('off-screen since launch (Board tab active)', STRICT, async () => JSON.stringify(drive(child.pid, 'rect').windows.map((w) => w.rect)));
    await phase('moved on-screen (helper stopped)', true, async () => { endHelper(); const r = drive(child.pid, 'onscreen'); drive(child.pid, 'topmost'); return JSON.stringify(r.windows.map((w) => w.rect)); });
  }
  await phase('base (Board tab shown, window on top)', true, async () => 'start');
  if (!args.includes('--dark-only')) {
  await phase('occluded (window fully covered)', STRICT, startOccluder);
  await phase('uncovered', true, async () => { const r = endOccluder(); drive(child.pid, 'topmost'); return r; });
  await phase('minimised', STRICT, async () => JSON.stringify(drive(child.pid, 'minimize').windows.map((w) => w.iconic)));
  await phase('restored', true, async () => { const r = drive(child.pid, 'restore'); drive(child.pid, 'topmost'); return JSON.stringify(r.windows.map((w) => w.rect)); });
  await phase('off-screen (-32000,-32000)', STRICT, async () => JSON.stringify(drive(child.pid, 'offscreen').windows.map((w) => w.rect)));
  await phase('back on-screen', true, async () => { const r = drive(child.pid, 'onscreen'); drive(child.pid, 'topmost'); return JSON.stringify(r.windows.map((w) => w.rect)); });
  await phase('Zumi tab (Board hidden by the shell)', false, async () => page.evaluate(`document.querySelector('.tab[data-tab="zumi"]').click(), document.querySelector('.tab.active')?.dataset.tab`));
  await phase('Board tab again', true, async () => String(await openBoard()));
  }
  // The owner-PC failures (alpha.9.2/9.3 smoke, 15-11 03:10-03:45 local) came after ~2.5 h without input: the display power state is
  // the one OS signal those runs had and the others did not. SC_MONITORPOWER drives it the way the power manager does.
  await phase('display off (SC_MONITORPOWER 2)', false, async () => JSON.stringify(drive(0, 'displayoff')));
  await phase('display on (SC_MONITORPOWER -1)', true, async () => { const r = drive(0, 'displayon'); drive(child.pid, 'topmost'); return JSON.stringify(r); });
  await phase('display on, next interval', true, async () => 'wait');
  // The Board tab shown again while the display is off: the shim must re-show the guest, which it does only from a rAF tick.
  await phase('Zumi tab, then display off', false, async () => { const tab = await page.evaluate(`document.querySelector('.tab[data-tab="zumi"]').click(), document.querySelector('.tab.active')?.dataset.tab`); return tab + ' ' + JSON.stringify(drive(0, 'displayoff')); });
  await phase('Board tab while the display is off', false, async () => String(await page.evaluate(`document.querySelector('.tab[data-tab="board"]').click(), document.querySelector('.tab.active')?.dataset.tab`)));
  await phase('display on after the tab switch in the dark', true, async () => { const r = drive(0, 'displayon'); drive(child.pid, 'topmost'); return JSON.stringify(r); });
  await phase('display on, next interval (2)', true, async () => 'wait');
  guest.close(); page.close();
} catch (e) {
  if (String(e?.message) !== 'IDLE_DONE') { failed++; log(`FAIL the probe ran to the end: ${String(e?.stack || e).split('\n').slice(0, 3).join(' | ')}`); }
} finally {
  await stop();
  upstream.closeAllConnections?.(); await new Promise((r) => upstream.close(r)); board.close();
  fs.writeFileSync(path.join(run, 'phases.json'), JSON.stringify(phases, null, 1));
  // alpha.9.6: the host logs every guest visibility change with its reason into sidecar.log; keep those lines with the run
  const sidecarLog = path.join(data, 'logs', 'sidecar.log');
  if (fs.existsSync(sidecarLog)) fs.writeFileSync(path.join(run, 'guest-visibility.log'), fs.readFileSync(sidecarLog, 'utf8').split(/\r?\n/).filter((l) => /\[guest\] (visibility|load failed)/.test(l)).join('\n') + '\n');
}
log(IDLE ? `idle: ${idleBad} bad sample(s), ${failed} failed` : `${phases.filter((p) => p.ok).length}/${phases.length} phases ok, ${failed} failed`);
process.exitCode = failed || idleBad ? 1 : 0;
