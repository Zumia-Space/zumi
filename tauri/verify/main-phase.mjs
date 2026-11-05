// T-31 P1c4 spare-PC main-webview phase (imported by drive-guard-probe.mjs; never run on the main PC).
//
// Proves, on the real preview build, what the cargo tests and static checks cannot:
//   * the main webview's request guard (guest_guard.rs install_main_guard) blocks every remote vector;
//   * main's navigation lock and always-deny new-window hold (form post, location, window.open);
//   * the window shell: shown only after the guard is in, focus/visible events fire once per change,
//     update.* and info().minWindow answer as Electron's;
//   * the app closes on WM_CLOSE within 5 s.
//
// CSP isolation: main's own CSP refuses every remote vector before the network layer, so a plain run would
// measure the CSP, not the guard. The phase therefore turns `Page.setBypassCSP` on and reloads, then proves
// the bypass with a CONTROL: a loopback fetch from main must reach the probe server. Without that control a
// "BLOCKED" would mean nothing and the run is INSTRUMENT_INVALID.
//
// Pure verdict functions are exported first (and unit-checked by scripts/check-tauri-guard-host.mjs);
// the CDP/helper-driven steps follow. A missing report, a `throw`, a timeout or an `n/a` is never a PASS.
// No URL, query or window title is ever printed or written.

import { spawnSync } from 'node:child_process';

const APP_ORIGIN = 'http://tauri.localhost';
const REPORT_TIMEOUT_MS = 8000; // per vector, page side
const EVENT_SETTLE_MS = 1500; // after a helper action, before the event log is read

// vector name -> the unique path it would hit on the remote listener. ws is separate (gate G4).
export const MAIN_VECTORS = {
  fetch: '/main-vector-fetch',
  img: '/main-vector-img',
  script: '/main-vector-script',
  iframe: '/main-vector-iframe',
  'iframe-img': '/main-vector-iframe-img',
  'worker-fetch': '/main-vector-worker-fetch',
  'shared-worker-fetch': '/main-vector-shared-worker-fetch',
  beacon: '/main-vector-beacon',
  redirect: '/main-vector-redirect-remote',
  'form-post': '/main-vector-form',
  'location-nav': '/main-vector-nav',
  'window-open': '/main-vector-open',
};
export const MAIN_WS_PATH = '/main-vector-ws';
// The top-level navigations run last: if the guard failed the page would leave the app and end the phase.
const NAV_VECTORS = ['form-post', 'location-nav'];

// ---- pure verdicts ----------------------------------------------------------

/** One vector's verdict. `value` is the page's own completion report (undefined = never reported). */
export function judgeVector(name, value, leaked, stillOnApp = true) {
  if (value === undefined) return { status: 'FAIL', why: 'no completion report' };
  if (value === 'throw') return { status: 'FAIL', why: 'did not run' };
  if (typeof value === 'string' && (value.startsWith('n/a') || value === 'timeout')) return { status: 'INCONCLUSIVE', why: value };
  if (leaked) return { status: 'FAIL', why: 'remote received the request' };
  if (name === 'window-open' && value !== 'denied') return { status: 'FAIL', why: 'window.open was not denied' };
  if (NAV_VECTORS.includes(name) && !stillOnApp) return { status: 'FAIL', why: 'the main page navigated away' };
  return { status: 'PASS', why: value };
}

/** An event step: the values of events of `type` since the step began must equal `expected` exactly. */
export function judgeEvents(events, type, expected) {
  const got = (events || []).filter((e) => e && e.t === type).map((e) => e.v);
  const same = got.length === expected.length && got.every((v, i) => v === expected[i]);
  return { status: same ? 'PASS' : 'FAIL', got };
}

/** The click-into-guest step: no focus:false may follow (a spurious blur puts the avatar in its blur state). */
export function judgeNoBlur(events) {
  const blurs = (events || []).filter((e) => e && e.t === 'focus' && e.v === false);
  return { status: blurs.length === 0 ? 'PASS' : 'FAIL', blurs: blurs.length };
}

/** Longest gap accepted between the window turning visible and the `window: main shown` line being seen. */
const SHOW_TO_LINE_MS = 250;

/**
 * Startup ordering from stderr + the watcher (win-helper.ps1 watch). Lines are matched exactly:
 *   guard: main source-kinds=all  <  guard: main first=document  <  window: main shown
 * and the first visible top-level window must not predate the guard line (within one poll).
 * `first=document` is gate condition 1: the first request the main filter saw was the document itself.
 */
export function judgeStartup(stderrText, watch) {
  const lines = String(stderrText || '').split(/\r?\n/).map((l) => l.trim());
  const at = (text) => lines.indexOf(text);
  const guard = at('guard: main source-kinds=all');
  const first = at('guard: main first=document');
  const shown = at('window: main shown');
  const failed = lines.some((l) => l.startsWith('guard: main FAILED'));
  const firstOther = at('guard: main first=other') >= 0;
  const orderOk = guard >= 0 && first > guard && shown > first;
  const out = { guardLine: guard >= 0, firstDocument: first >= 0, firstOther, shownLine: shown >= 0, failed, orderOk, visibleAfterGuard: null, visibleOnlyAtShow: null, shownMinusVisibleMs: null };
  if (failed || !orderOk) return { status: 'FAIL', ...out };
  if (!watch || watch.timedOut || typeof watch.firstVisibleMs !== 'number' || typeof watch.guardSeenMs !== 'number') {
    return { status: 'INCONCLUSIVE', ...out, why: 'the window watcher did not see all three moments' };
  }
  if (typeof watch.shownSeenMs !== 'number') {
    return { status: 'INCONCLUSIVE', ...out, why: 'the window watcher did not see the "window: main shown" line' };
  }
  const slack = Number(watch.pollMs) || 20;
  // (1) nothing may be visible before the guard line.
  out.visibleAfterGuard = watch.firstVisibleMs >= watch.guardSeenMs - slack;
  // (2) the only legitimate show is the one that prints `window: main shown` right after show(): the
  // window may become visible at most SHOW_TO_LINE_MS before that line is seen (show + focus + one
  // poll) and, because both are polled, a few ms after it. Any earlier visibility was not that show.
  out.shownMinusVisibleMs = watch.shownSeenMs - watch.firstVisibleMs;
  out.visibleOnlyAtShow = out.shownMinusVisibleMs <= SHOW_TO_LINE_MS;
  return { status: out.visibleAfterGuard && out.visibleOnlyAtShow ? 'PASS' : 'FAIL', ...out };
}

/** The rpc/shell answers Electron gives (info().minWindow, feed-less update.*). */
export function judgeRpc(r) {
  if (!r || r.error) return { status: 'FAIL', why: (r && r.error) || 'no reply' };
  const checks = {
    minWindow: Boolean(r.minWindow) && r.minWindow.width === 900 && r.minWindow.height === 600,
    updateStatus: Boolean(r.status) && r.status.phase === 'off',
    updateInstall: r.install === false,
    updateLater: r.later === false,
    // Parity 11-2: the main webview is refused the guest-only wardrobe bridge (never forwarded to the sidecar).
    bridgeRefused: typeof r.bridgeRefused === 'string' && r.bridgeRefused.includes('unknown_method:zumiHost.apply'),
  };
  return { status: Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL', checks };
}

/** WM_CLOSE must end the process within 5 s. */
export function judgeExit(r) {
  if (!r || r.ok !== true) return { status: 'INCONCLUSIVE', why: (r && r.reason) || 'helper_not_ok' };
  return { status: r.exited === true && r.ms <= 5000 ? 'PASS' : 'FAIL', ms: r.ms, exited: r.exited };
}

/** Combine every part. FAIL beats INCONCLUSIVE beats PASS. */
export function combine(statuses) {
  if (statuses.includes('FAIL')) return 'FAIL';
  if (statuses.includes('INCONCLUSIVE')) return 'INCONCLUSIVE';
  return 'PASS';
}

// ---- helpers ------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One win-helper.ps1 command; parses its single JSON line. */
export function helperRun(ctx, cmd, extra = []) {
  if (!ctx.helper || !ctx.pid) return { ok: false, reason: 'no_helper' };
  const r = spawnSync(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ctx.helper, '-Cmd', cmd, '-TargetPid', String(ctx.pid), ...extra],
    { encoding: 'utf8', timeout: 60000 },
  );
  const line = String(r.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop();
  try {
    return JSON.parse(line);
  } catch {
    return { ok: false, reason: 'helper_unparsable' };
  }
}

async function evalOrNull(cdp, expression) {
  try {
    return await cdp.eval(expression);
  } catch {
    return null; // the context went away (navigation) or the page is not ready
  }
}

async function pageTargetCount(cdpPort) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
    return list.filter((t) => t.type === 'page').length;
  } catch {
    return null;
  }
}

const prelude = (remote, loopback) => `(() => {
  window.__p1c4 = [];
  const L = ${JSON.stringify(loopback)}, R = ${JSON.stringify(remote)};
  window.__p1c4h = {
    L, R, W: R.replace(/^http/, 'ws'),
    // Posts one key of the main webview's own completion report to the probe server (simple request, no preflight).
    rep(k, v) { try { fetch(L + '/__main_page', { method: 'POST', mode: 'no-cors', body: JSON.stringify({ k, v: String(v) }) }).catch(() => {}); } catch (e) { /* the driver reads the server */ } return String(v); },
  };
  return true;
})()`;

const vectorBodies = {
  fetch: `fetch(h.R + '/main-vector-fetch', { mode: 'no-cors' }).then(() => 'resolved', (e) => 'rejected:' + (e && e.name))`,
  img: `new Promise((res) => { const i = new Image(); i.onload = () => res('loaded'); i.onerror = () => res('error'); i.src = h.R + '/main-vector-img'; })`,
  script: `new Promise((res) => { const s = document.createElement('script'); s.onload = () => res('loaded'); s.onerror = () => res('error'); s.src = h.R + '/main-vector-script'; document.body.appendChild(s); })`,
  iframe: `new Promise((res) => { const f = document.createElement('iframe'); f.onload = () => res('settled'); f.onerror = () => res('error'); f.src = h.R + '/main-vector-iframe'; document.body.appendChild(f); })`,
  'iframe-img': `new Promise((res) => { const f = document.createElement('iframe'); f.onload = () => setTimeout(() => res('settled'), 1500); f.src = h.L + '/main-iframe'; document.body.appendChild(f); })`,
  'worker-fetch': `new Promise((res) => { const src = 'self.onmessage=function(){fetch(' + JSON.stringify(h.R + '/main-vector-worker-fetch') + ',{mode:"no-cors"}).then(function(){postMessage("done")}).catch(function(){postMessage("fail")})};'; const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' }))); w.onmessage = (e) => res(String(e.data)); w.onerror = () => res('n/a:worker-error'); w.postMessage('go'); })`,
  'shared-worker-fetch': `new Promise((res) => { const src = 'onconnect=function(e){var p=e.ports[0];p.onmessage=function(){fetch(' + JSON.stringify(h.R + '/main-vector-shared-worker-fetch') + ',{mode:"no-cors"}).then(function(){p.postMessage("done")}).catch(function(){p.postMessage("fail")})}};'; const w = new SharedWorker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' }))); w.onerror = () => res('n/a:worker-error'); w.port.onmessage = (e) => res(String(e.data)); w.port.postMessage('go'); })`,
  beacon: `(navigator.sendBeacon(h.R + '/main-vector-beacon', 'x') ? 'queued' : 'refused')`,
  redirect: `fetch(h.L + '/main-redirect', { mode: 'no-cors' }).then(() => 'settled', (e) => 'rejected:' + (e && e.name))`,
  'window-open': `(() => { const w = window.open(h.R + '/main-vector-open'); return w ? 'opened' : 'denied'; })()`,
  // Top-level navigations: the report is posted BEFORE the attempt (h.rep inside), because a navigation that
  // got through would destroy this page.
  'form-post': `(() => { const f = document.createElement('form'); f.method = 'post'; f.action = h.R + '/main-vector-form'; document.body.appendChild(f); h.rep('form-post', 'submitted'); f.submit(); return 'submitted'; })()`,
  'location-nav': `(() => { h.rep('location-nav', 'assigned'); location.href = h.R + '/main-vector-nav'; return 'assigned'; })()`,
};
const wsBody = `new Promise((res) => { try { const s = new WebSocket(h.W + '/main-vector-ws'); s.onopen = () => res('open'); s.onerror = () => res('error'); s.onclose = () => res('closed'); } catch (e) { res('throw'); } })`;

const runVector = (name, body) => `(async () => {
  const h = window.__p1c4h;
  let v;
  try { v = await Promise.race([${body}, new Promise((r) => setTimeout(() => r('timeout'), ${REPORT_TIMEOUT_MS}))]); } catch (e) { v = 'throw'; }
  return h.rep(${JSON.stringify(name)}, v);
})()`;

// ---- steps ---------------------------------------------------------------------

/**
 * Before the guest phase: bypass CSP + reload, prove the bypass with the loopback control, run every vector,
 * the rpc checks and the pre-guest event steps. `ctx` = { cdpPort, origin (probe loopback), readResults,
 * waitQuiet, helper, pid }. Returns the `main` block (without the startup/exit parts, which come last).
 */
export async function runMainPhase(cdp, ctx) {
  const main = { control: false, boot: false, vectors: {}, vectorOutcomes: {}, ws: 'UNOBSERVED', rpc: null, events: { pre: {}, post: {} }, instrumentError: null };
  const before = await ctx.readResults(ctx.origin);
  const remoteBase = before && before.instrument && before.instrument.remoteBase;
  if (!remoteBase || before.instrument.preflight !== true) {
    main.instrumentError = 'remote listener unavailable';
    return main;
  }

  // 1. CSP off for this document, then reload; wait for the app page + the zumi shim.
  await cdp.send('Page.enable', {});
  await cdp.send('Page.setBypassCSP', { enabled: true });
  // A marker on the OLD document: ready means the marker is gone, so a "complete" old page is not mistaken for the reloaded one.
  await cdp.eval('window.__p1c4Old = true');
  await cdp.send('Page.reload', { ignoreCache: true });
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const ready = await evalOrNull(cdp, `window.__p1c4Old === undefined && document.readyState === 'complete' && typeof window.zumi === 'object' && location.origin === ${JSON.stringify(APP_ORIGIN)}`);
    if (ready === true) { main.boot = true; break; }
    await sleep(300);
  }
  if (!main.boot) { main.instrumentError = 'the app page did not boot after the CSP bypass'; return main; }
  await cdp.eval(prelude(remoteBase, ctx.origin));

  // 2. Control: a loopback fetch from main MUST arrive. Without it the bypass did not take and every BLOCKED is void.
  await cdp.eval(`fetch(window.__p1c4h.L + '/main-ok', { mode: 'no-cors' }).then(() => true, () => false)`);
  const controlDeadline = Date.now() + 5000;
  while (Date.now() < controlDeadline && !main.control) {
    const r = await ctx.readResults(ctx.origin);
    main.control = Boolean(r && r.controls && r.controls.mainOk);
    if (!main.control) await sleep(250);
  }
  if (!main.control) { main.instrumentError = 'CSP bypass control did not arrive'; return main; }

  // 3. Event subscriptions (the same calls the renderer makes) and the rpc checks.
  await cdp.eval(`(async () => { await window.zumi.onWindowFocus((v) => window.__p1c4.push({ t: 'focus', v })); await window.zumi.onWindowVisible((v) => window.__p1c4.push({ t: 'visible', v })); return true; })()`);
  main.rpc = judgeRpc(await evalOrNull(cdp, `(async () => {
    try {
      const z = window.zumi;
      const info = await z.info();
      // Parity 11-2: the main renderer must be refused the wardrobe bridge's guest-only method. The rpc
      // command answers unknown_method BEFORE any sidecar call; a resolved value here would be a FAIL.
      let bridgeRefused = 'missing';
      try {
        await window.__TAURI_INTERNALS__.invoke('rpc', { method: 'zumiHost.apply', args: [{}] });
        bridgeRefused = 'allowed';
      } catch (e) {
        bridgeRefused = String((e && e.message) || e);
      }
      return { minWindow: info && info.minWindow, status: await z.update.status(), install: await z.update.install(), later: await z.update.later('9.9.9'), bridgeRefused };
    } catch (e) { return { error: (e && e.message) || String(e) }; }
  })()`));

  // 4. Vectors: everything except the two top-level navigations, then ws on its own line, then the navigations.
  const targetsBefore = await pageTargetCount(ctx.cdpPort);
  const windowsBefore = helperRun(ctx, 'top-count');
  const order = [...Object.keys(MAIN_VECTORS).filter((n) => !NAV_VECTORS.includes(n)), '__ws', ...NAV_VECTORS];
  const stillOnApp = {};
  for (const name of order) {
    if (name === '__ws') {
      await evalOrNull(cdp, runVector('ws', wsBody));
      continue;
    }
    await evalOrNull(cdp, runVector(name, vectorBodies[name]));
    if (NAV_VECTORS.includes(name)) {
      await sleep(2000);
      stillOnApp[name] = (await evalOrNull(cdp, `location.origin === ${JSON.stringify(APP_ORIGIN)}`)) === true;
    }
  }
  // A leak that lands late is still counted: read the hit log only after it has been quiet.
  const results = (await ctx.waitQuiet(ctx.origin, 3000, 15000)) || (await ctx.readResults(ctx.origin));
  const outcomes = (results && results.mainOutcomes) || {};
  const remoteHits = ((results && results.remoteHits) || []).filter((h) => h.path.startsWith('/main-'));
  const wsHits = ((results && results.wsHits) || []).filter((h) => h.path === MAIN_WS_PATH);
  for (const [name, hitPath] of Object.entries(MAIN_VECTORS)) {
    const v = judgeVector(name, outcomes[name], remoteHits.some((h) => h.path === hitPath), stillOnApp[name] !== false);
    main.vectors[name] = v;
    main.vectorOutcomes[name] = outcomes[name] === undefined ? null : outcomes[name];
  }
  // window.open: no new CDP page target and no new top-level window for the process.
  const targetsAfter = await pageTargetCount(ctx.cdpPort);
  const windowsAfter = helperRun(ctx, 'top-count');
  main.windowOpen = {
    targetsBefore, targetsAfter,
    windowsBefore: windowsBefore.ok ? windowsBefore.count : null,
    windowsAfter: windowsAfter.ok ? windowsAfter.count : null,
  };
  const noNewTarget = targetsBefore !== null && targetsAfter !== null && targetsAfter <= targetsBefore;
  const noNewWindow = main.windowOpen.windowsBefore !== null && main.windowOpen.windowsAfter !== null && main.windowOpen.windowsAfter <= main.windowOpen.windowsBefore;
  if (main.vectors['window-open'].status === 'PASS' && !noNewTarget) main.vectors['window-open'] = { status: 'FAIL', why: 'a new CDP page target appeared' };
  if (main.vectors['window-open'].status === 'PASS' && main.windowOpen.windowsBefore === null) main.vectors['window-open'] = { status: 'INCONCLUSIVE', why: 'the window helper could not count windows' };
  else if (main.vectors['window-open'].status === 'PASS' && !noNewWindow) main.vectors['window-open'] = { status: 'FAIL', why: 'a new top-level window appeared' };
  // ws: its own line (gate G4: the CSP is main's closure for the preview). Never part of the vector PASS.
  // P1c4 probe (19-10): this document runs with Page.setBypassCSP(true) (step 1), and the CSP IS main's ws closure (G4), so a hit
  // here only shows what the WebView2 request filter cannot see (a WebSocket upgrade is not a WebResourceRequested). Reporting it
  // as LEAK measured the instrument, not the product. The raw observation is kept; the verdict is UNMEASURED until a ws attempt
  // runs in a document whose CSP is enforced (a fresh launch with no bypass; CDP Runtime.evaluate is not subject to the page CSP).
  main.wsRaw = wsHits.length > 0 || outcomes.ws === 'open' ? 'upgrade_seen_csp_bypassed' : typeof outcomes.ws === 'string' ? 'no_upgrade_csp_bypassed' : 'unobserved';
  main.ws = 'UNMEASURED';

  // 5. Window events before the first guest exists (focus comes from the webview's own Got/LostFocus here).
  main.events.pre = await eventSteps(cdp, ctx, 'pre');
  return main;
}

async function readEvents(cdp, from) {
  return (await evalOrNull(cdp, `window.__p1c4.slice(${from})`)) || [];
}

async function lengthNow(cdp) {
  return (await evalOrNull(cdp, 'window.__p1c4.length')) || 0;
}

/** One helper-driven event step. A helper that could not do its job is INCONCLUSIVE, never FAIL. */
async function eventStep(cdp, ctx, act, type, expected) {
  const from = await lengthNow(cdp);
  const h = act();
  if (!h || h.ok !== true) return { status: 'INCONCLUSIVE', why: (h && h.reason) || 'helper could not move the window or the foreground' };
  await sleep(EVENT_SETTLE_MS);
  return judgeEvents(await readEvents(cdp, from), type, expected);
}

/** `pre`: minimise, restore, focus out, focus back. `post` (a guest exists): focus out/back, then a click into the guest. */
export async function eventSteps(cdp, ctx, label) {
  const steps = {};
  if (label === 'pre') {
    steps.minimize = await eventStep(cdp, ctx, () => helperRun(ctx, 'minimize'), 'visible', [false]);
    steps.restore = await eventStep(cdp, ctx, () => helperRun(ctx, 'restore'), 'visible', [true]);
  }
  helperRun(ctx, 'focus-zumi'); // start from a known state: Zumi foreground
  await sleep(EVENT_SETTLE_MS);
  steps.focusOut = await eventStep(cdp, ctx, () => helperRun(ctx, 'focus-away', ['-HoldMs', '1500']), 'focus', [false]);
  steps.focusBack = await eventStep(cdp, ctx, () => helperRun(ctx, 'focus-zumi'), 'focus', [true]);
  if (label === 'post') steps.guestClick = await guestClickStep(cdp, ctx);
  return steps;
}

/** Click inside the guest rect: Tauri must not report the window as blurred while focus moves to a child webview. */
async function guestClickStep(cdp, ctx) {
  // Best effort: the preview's tab handlers are dead (app.js:47), so make the wardrobe host visible and sized.
  const rect = await evalOrNull(cdp, `(async () => {
    const host = document.getElementById('guard-probe-host');
    const wv = host && host.querySelector('webview');
    if (!wv) return null;
    for (let n = host; n && n !== document.body; n = n.parentElement) { n.hidden = false; if (getComputedStyle(n).display === 'none') n.style.display = 'block'; }
    host.style.cssText += ';position:fixed;left:40px;top:40px;width:600px;height:400px;z-index:9999';
    wv.style.cssText += ';display:block;width:600px;height:400px';
    await new Promise((r) => setTimeout(r, 800)); // the shim's rAF loop pushes the new bounds to Rust
    try { wv.focus(); } catch (e) { /* the placeholder element may not be focusable */ }
    const b = wv.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width, h: b.height, dpr: window.devicePixelRatio || 1 };
  })()`);
  if (!rect || rect.w < 10 || rect.h < 10) return { status: 'INCONCLUSIVE', why: 'the guest has no visible rect in this build' };
  const from = await lengthNow(cdp);
  const clicked = helperRun(ctx, 'click', ['-X', String(Math.round(rect.x * rect.dpr)), '-Y', String(Math.round(rect.y * rect.dpr))]);
  if (!clicked.ok) return { status: 'INCONCLUSIVE', why: clicked.reason || 'click failed' };
  await sleep(EVENT_SETTLE_MS);
  return judgeNoBlur(await readEvents(cdp, from));
}

/** Last step: WM_CLOSE, then the process must be gone within 5 s. (Orphans are checked by the runner.) */
export function closeAndMeasure(ctx) {
  return judgeExit(helperRun(ctx, 'close', ['-TimeoutSec', '5']));
}

/** Fold the parts into the `main` block's verdict. `startup` and `exit` come from the end of the run. */
export function finishMain(main, startup, exit) {
  main.startup = startup;
  main.exit = exit;
  // No post-guest events (the guest never opened, or the phase stopped early) is a missing measurement.
  const postSteps = Object.values(main.events.post);
  const statuses = [
    ...(postSteps.length ? [] : ['INCONCLUSIVE']),
    ...Object.values(main.vectors).map((v) => v.status),
    main.rpc ? main.rpc.status : 'FAIL',
    startup.status,
    exit.status,
    ...Object.values(main.events.pre).map((s) => s.status),
    ...Object.values(main.events.post).map((s) => s.status),
  ];
  if (main.instrumentError) main.verdict = 'INSTRUMENT_INVALID';
  else if (!main.boot) main.verdict = 'FAIL';
  else main.verdict = combine(statuses);
  return main;
}
