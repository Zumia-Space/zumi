// T-31 P1c1 spare-PC guard-probe driver.
//
// Drives the running preview build over CDP (Node >= 22, global WebSocket, no dependencies) and proves
// the guest request guard on the sparsest contract: the probe stand-in guest plus the local board guest.
// T-31 alpha.12: the wardrobe guest that used to carry the probe page is gone (alpha.11). The runner now starts the
// probe server and passes its origin (ZUMI_GUARD_PROBE_ORIGIN); the stand-in is a board-partition guest the sidecar
// admits for that one origin on the render box only. Every guest is a board guest now, with no bridge at all, so
// ipc.localhost and tauri.localhost are both expected BLOCKED and the page must find no window.zumiHost.
//
// The renderer's boot aborts at src/renderer/app.js:47 (`zumi.listModels` is not_implemented in the
// P1c1 sidecar), so the tab click handlers never attach and clicking a tab is a no-op. The driver
// therefore opens both guests the way those handlers would, via the same IPC:
//   * probe stand-in (alpha.12): a `<webview>` on the board partition (`info().boardPartition`) whose src is the
//     runner-started probe server (ZUMI_GUARD_PROBE_ORIGIN), appended to a #guard-probe-host the driver adds;
//   * board: `zumi.openBoard()` then the `<webview>` appended to #board-host — what `openBoard()`
//     (app.js:638-680) builds for a non-owner build (`board.status` is always local in the preview).
// Both are opened in ONE driver run. Nothing in the app or the sidecar is stubbed.
//
//   1. open the probe stand-in guest directly (see above);
//   2. wait for EVERY vector's own completion report (or the per-vector timeout), then read the probe
//      server's /__results only after the hit log has been quiet for >= 3 s (a late leak is counted);
//   3. through the <webview> element, exercise the three load-status cases (404 finishes, die fails
//      with a code < 0 and != -3, a stopped server fails) and record the actual codes;
//   4. open the board guest directly, then write results.json and print PASS/FAIL per vector.
//
// PASS requires: every http vector reported and left zero remote hits (a vector that did not run or
// timed out, or reported n/a, is never a PASS), both loopback controls arrived, the three load-status
// cases as above, and `source-kinds=all` for BOTH guest kinds in stderr. Parity 11-2 changed the two
// custom-protocol rows for this WARDROBE page: ipc.localhost must be REACHABLE now (the guest's one
// bridge re-opens it; the ACL admits only that command, measured by bridge_other=denied) while
// tauri.localhost stays BLOCKED. The board guest keeps blocking both (Rust guard test + capability
// check; it has no probe page hook). `ws` is reported on its own line (LEAK / BLOCKED / UNOBSERVED) and
// never folded into PASS: it is gate Q3's separate row, not a ship-blocker criterion for these guests.
//
// Custom-protocol hosts are measured by the GUEST PAGE itself, not over CDP: a guest webview does not
// appear in the host's /json target list on 9333 (the previous run measured only
// `http://tauri.localhost/`), so the page issues the two requests and posts the result to the probe
// server over its allowed loopback origin (see `probeHtml` in guard-probe/server/server.mjs).
//
// P1c4 adds a MAIN-webview phase (tauri/verify/main-phase.mjs) to the same run: before the guests are
// appended, the main page gets Page.setBypassCSP + a reload (its own CSP would otherwise refuse every remote
// vector before the guard is reached), a loopback control proves the bypass, and the remote vectors, the
// navigation lock, window.open, the rpc answers and the focus/visible events are measured. After the guest
// phase the app is closed with WM_CLOSE and the exit time is measured. `pass` requires BOTH the main PASS
// list and the guest PASS list. `ws` from main is its own line (`mainWs`), never part of the PASS.
//
// This file is never run on the main PC. Run it only via tauri/verify/run-guard-probe.ps1.

import fs from 'node:fs';
import path from 'node:path';

import { runMainPhase, eventSteps, judgeStartup, closeAndMeasure, finishMain } from './main-phase.mjs';

const args = parseArgs(process.argv.slice(2));
const CDP_PORT = Number(args.cdp || 9333);
const OUT = args.out || '.';
const STDERR = args.stderr || path.join(OUT, 'stderr.log');
const PID = Number(args.pid || 0); // the preview exe, for win-helper.ps1
const HELPER = typeof args.helper === 'string' ? args.helper : '';
const WATCH = typeof args.watch === 'string' ? args.watch : path.join(OUT, 'watch.json');

// vector name -> the unique path it would hit on the remote listener
const HTTP_VECTORS = {
  'early-img': '/vector-early-img',
  fetch: '/vector-fetch',
  img: '/vector-img',
  script: '/vector-script',
  'iframe-img': '/vector-iframe-img',
  'worker-fetch': '/vector-worker-fetch',
  'shared-worker-fetch': '/vector-shared-worker-fetch',
  'sw-fetch': '/vector-sw-fetch',
  beacon: '/vector-beacon',
  redirect: '/vector-redirect-remote',
};
const WS_VECTOR = '/vector-ws';

// Every vector must send its OWN completion report before the run is complete: a vector that never
// ran (no report) or reported `n/a` is never a PASS. The server-side hit log is the source of truth
// and the verdict is taken only after a quiet period with no new hits (see waitQuiet).
const VECTOR_REPORTS = {
  'early-img': 'early-img',
  fetch: 'fetch',
  img: 'img',
  script: 'script',
  'iframe-img': 'iframe-img',
  'worker-fetch': 'worker-fetch',
  'shared-worker-fetch': 'shared-worker-fetch',
  'sw-fetch': 'sw-fetch',
  beacon: 'beacon',
  redirect: 'redirect',
};
const VECTOR_TIMEOUT_MS = 20000; // per-vector wait for its own completion report (page sets done=true)
const QUIET_MS = 3000; // the verdict requires the hit log to stay unchanged for at least this long

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) out[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(url) {
    this.url = url;
    this.seq = 0;
    this.pending = new Map();
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error('cdp connect failed'));
      this.ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (!msg.id) return; // no CDP events are subscribed (the guest host measurements are page-side)
        const slot = this.pending.get(msg.id);
        if (!slot) return;
        this.pending.delete(msg.id);
        if (msg.error) slot.reject(new Error(msg.error.message));
        else slot.resolve(msg.result);
      };
    });
  }
  send(method, params) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'eval exception');
    return r.result ? r.result.value : undefined;
  }
}

async function pickMainTarget(targetSubstr) {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
  const list = await res.json();
  const pages = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  let candidates = pages;
  if (targetSubstr) candidates = pages.filter((t) => String(t.url || '').includes(targetSubstr));
  else candidates = pages.filter((t) => !/^https?:\/\/(127\.0\.0\.1|localhost):/.test(String(t.url || '')));
  if (!candidates.length) throw new Error(`no main webview target; targets=${JSON.stringify(pages.map((t) => t.url))}`);
  return candidates[0];
}

async function readResults(origin) {
  const res = await fetch(`${origin}/__results`);
  return res.json();
}

// Whether wry's deferred custom-protocol response overwrites our 403 for ipc.localhost /
// tauri.localhost. Measured by the guest page itself (no CDP on the guest; it is not a target on 9333)
// and reported through the probe server's allowed loopback origin. The page records one string per
// host (guard-probe/server/server.mjs `probeHtml`):
//   ipc.localhost   -> `blocked-noncors` (our headerless 403 made the CORS fetch reject, while a no-cors
//                      fetch still resolved) or `overwritten:<status>` (Tauri's IPC handler answered a
//                      GET with 405 + Access-Control-Allow-Origin: *, so the CORS fetch resolved).
//   tauri.localhost -> `blocked-noncors` (a real frontendDist image did not load, but a no-cors fetch got
//                      a non-CORS response) or `overwritten:asset` (wry's asset handler served the
//                      image). "A non-CORS response" is not enough here: wry answering 404 for the
//                      path looks identical, so `assetControl` (the same image loaded in the unguarded
//                      main webview) must be true before this host can be called BLOCKED.
// `blocked-noncors` does not claim the status is 403; it means a response arrived that the CORS fetch
// could not read, which is what our headerless synthetic response is.
// `n/a:*` means no HTTP response was observed at all, which proves nothing and is INCONCLUSIVE.
const LOCALHOST_HOSTS = ['ipc.localhost', 'tauri.localhost'];
const HOST_OUTCOMES = { 'ipc.localhost': 'host_ipc', 'tauri.localhost': 'host_tauri' };
// Parity 11-2: this probe page is the WARDROBE guest, whose whole point is the one bridge command, so its
// ipc.localhost is expected REACHABLE now (the guard re-opens it for this guest; the ACL admits exactly
// one command, measured separately by bridge_other). tauri.localhost stays blocked even for it. The board
// guest keeps Electron's rule (both hosts blocked); that is pinned by the Rust guard test and the
// capability check, since the board page has no probe hook.
const LOCALHOST_EXPECT = { 'ipc.localhost': 'BLOCKED', 'tauri.localhost': 'BLOCKED' };
const TAURI_ASSET = 'brand/zumia-mark.svg'; // in frontendDist (tauri/ui/brand); query is ignored by the protocol

function localhostVerdict(pageOutcomes, host, assetControlOk) {
  // Without the control, a 404 from wry's asset handler would masquerade as "our 403".
  if (host === 'tauri.localhost' && !assetControlOk) return 'INCONCLUSIVE';
  const value = pageOutcomes && pageOutcomes[HOST_OUTCOMES[host]];
  if (typeof value !== 'string') return 'INCONCLUSIVE';
  if (value === 'blocked-noncors') return 'BLOCKED';
  if (value.startsWith('overwritten')) return 'OVERWRITTEN';
  return 'INCONCLUSIVE';
}

// Read /__results until the hit log (http and ws) has been unchanged for `quietMs`, or `maxMs` passes.
// This is the only moment a verdict may be taken: a vector that leaks late (a delayed service-worker
// fetch) lands in the log during this window, not after the first page report.
async function waitQuiet(origin, quietMs, maxMs) {
  const start = Date.now();
  let latest = null;
  let lastCount = -1;
  let quietSince = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      latest = await readResults(origin);
    } catch {
      return latest; // the server is gone; report what we last saw
    }
    const n = (latest.remoteHits || []).length + (latest.wsHits || []).length;
    if (n !== lastCount) {
      lastCount = n;
      quietSince = Date.now();
    } else if (Date.now() - quietSince >= quietMs) {
      return latest;
    }
    await sleep(250);
  }
  return latest;
}

function guardLines(stderrPath) {
  let text = '';
  try {
    text = fs.readFileSync(stderrPath, 'utf8');
  } catch {
    return [];
  }
  const found = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^guard:\s+(\S+)\s+source-kinds=(\S+)\s*$/.exec(line.trim());
    if (m) found.push({ label: m[1], sourceKinds: m[2] });
  }
  return found;
}

function kindSourceKinds(lines, needle) {
  const hit = lines.filter((l) => l.label.includes(needle));
  return hit.length ? hit.map((l) => l.sourceKinds) : [];
}

async function main() {
  const target = await pickMainTarget(args.target);
  process.stdout.write(`[driver] main target: ${target.url}\n`);
  const cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.connect();

  // 1. the probe stand-in: the runner already started the probe server (no wardrobe guest since alpha.11). The boot
  // abort at app.js:47 means the tab handler was never attached, so a click would be a no-op (measured run).
  // The <webview> itself is appended only after the MAIN phase, which needs the probe server first.
  // alpha.12: the runner started the probe server; its origin comes from the runner's env, the partition from info().
  const probeOrigin = String(process.env.ZUMI_GUARD_PROBE_ORIGIN || '').replace(/\/$/, '');
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(probeOrigin)) throw new Error('ZUMI_GUARD_PROBE_ORIGIN is not set by the runner');
  const wardrobeOpen = await cdp.eval(`(async () => {
    try { const info = await window.zumi.info(); return { partition: info.boardPartition, origin: ${JSON.stringify(probeOrigin)} }; }
    catch (e) { return { error: (e && e.message) || String(e) }; }
  })()`);
  if (!wardrobeOpen || wardrobeOpen.error || !wardrobeOpen.partition) throw new Error(`probe stand-in could not be prepared: ${wardrobeOpen && wardrobeOpen.error}`);

  // P1c4 MAIN phase (CSP bypass + reload, control, vectors, rpc, events before the first guest).
  const ctx = {
    cdpPort: CDP_PORT,
    origin: String(wardrobeOpen.origin).replace(/\/$/, ''),
    readResults,
    waitQuiet,
    helper: HELPER,
    pid: PID,
  };
  const mainBlock = await runMainPhase(cdp, ctx);
  process.stdout.write(`[driver] main phase: boot=${mainBlock.boot} control=${mainBlock.control}${mainBlock.instrumentError ? ` INSTRUMENT_INVALID: ${mainBlock.instrumentError}` : ''}\n`);

  // Now append the stand-in <webview> on the board partition, built like the old wardrobe one.
  const wardrobe = await cdp.eval(`(() => {
    try {
      const r = ${JSON.stringify({ partition: wardrobeOpen.partition, origin: wardrobeOpen.origin })};
      const wv = document.createElement('webview');
      wv.setAttribute('partition', r.partition);
      const u = new URL(r.origin + '/');
      u.searchParams.set('embed', '1');
      u.searchParams.set('lang', 'en');
      wv.setAttribute('src', u.href);
      wv.dataset.home = r.origin + '/';
      let host = document.getElementById('guard-probe-host');
      if (!host) { host = document.createElement('div'); host.id = 'guard-probe-host'; host.style.cssText = 'position:fixed;left:40px;top:40px;width:600px;height:400px;z-index:9999'; document.body.appendChild(host); }
      wv.style.cssText = 'display:block;width:600px;height:400px';
      host.appendChild(wv);
      return { partition: r.partition };
    } catch (e) { return { error: (e && e.message) || String(e) }; }
  })()`);
  if (!wardrobe || wardrobe.error) throw new Error(`wardrobe guest could not be opened: ${wardrobe && wardrobe.error}`);
  process.stdout.write(`[driver] wardrobe guest: opened (partition=${wardrobe.partition})\n`);

  // 2. wait for the wardrobe guest element + its origin, then for the probe page's first report.
  let origin = null;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const home = await cdp.eval(`(() => { const wv = document.querySelector('#guard-probe-host webview'); return wv && wv.dataset ? wv.dataset.home : null; })()`);
    if (home) { origin = String(home).replace(/\/$/, ''); break; }
    await sleep(250);
  }
  if (!origin) throw new Error('wardrobe guest never appeared');

  // Wait for every vector's own completion report (or the per-vector timeout). The page sets
  // pageOutcomes.done once every vector has settled; a vector that never reports is a FAIL below.
  let results = null;
  const reportDeadline = Date.now() + VECTOR_TIMEOUT_MS;
  while (Date.now() < reportDeadline) {
    results = await readResults(origin);
    if (results && results.pageOutcomes && results.pageOutcomes.done === true) break;
    await sleep(500);
  }
  if (!results) throw new Error('probe server never answered /__results');

  // The hit log is the source of truth: read the final state only after a quiet period, so a leak that
  // arrives after the last page report is still counted.
  results = await waitQuiet(origin, QUIET_MS, 15000) || results;

  // ipc.localhost / tauri.localhost: whether wry's deferred custom-protocol response overwrites our 403
  // (wry mod.rs:1065-1081). The guest page measured it and posted the outcome through the loopback
  // probe server (no guest CDP target exists on 9333). An unobserved vector is INCONCLUSIVE, never PASS.
  // Control first: prove the asset path the guest probes loads in THIS build (main webview, unguarded).
  const assetControl = await cdp.eval(`(async () => new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    const img = new Image();
    img.onload = () => finish(true);
    img.onerror = () => finish(false);
    setTimeout(() => finish(false), 8000);
    img.src = ${JSON.stringify(TAURI_ASSET)} + '?probe=' + Date.now();
  }))()`);
  const assetControlOk = assetControl === true;
  process.stdout.write(`[driver] asset control (${TAURI_ASSET} in the main webview): ${assetControlOk ? 'loaded' : 'MISSING'}\n`);
  const localhostVerdicts = {};
  for (const host of LOCALHOST_HOSTS) localhostVerdicts[host] = localhostVerdict(results.pageOutcomes, host, assetControlOk);
  process.stdout.write(`[driver] localhost: ${LOCALHOST_HOSTS.map((h) => `${h}=${localhostVerdicts[h]}`).join(' ')}\n`);

  // P1c4: window events once a guest exists (focus then comes from the child's LostFocus, not tao's blur).
  if (mainBlock.boot && !mainBlock.instrumentError) mainBlock.events.post = await eventSteps(cdp, ctx, 'post');

  // 3. the three load-status cases.
  const cases = await cdp.eval(`(async function () {
    var wv = document.querySelector('#guard-probe-host webview');
    var origin = (wv.dataset.home || '').replace(/\\/$/, '');
    var out = { http404: null, die: null, stopped: null };
    var last = null;
    // webErrorStatus is the raw COREWEBVIEW2_WEB_ERROR_STATUS value the guard mapped. It is recorded so
    // a failure code can be attributed to an enum row instead of guessed.
    function onFail(e) { last = { code: e.errorCode, desc: e.errorDescription, webErrorStatus: e.webErrorStatus }; }
    wv.addEventListener('did-fail-load', onFail);
    try { await wv.loadURL(origin + '/404'); out.http404 = 'finished'; } catch (e) { out.http404 = 'failed:' + (e && e.message); }
    last = null;
    try { await wv.loadURL(origin + '/die'); out.die = 'finished'; } catch (e) { out.die = 'failed:' + (e && e.message); }
    out.dieFail = last;
    wv.removeEventListener('did-fail-load', onFail);
    return out;
  })()`);

  // Stop the probe server from Node, then expect the load to fail. The contract is a negative code that
  // is not -3 (aborted); it is NOT a claim of -102. The previous run measured -2 ERR_FAILED here, which
  // is the guard's default for a WebErrorStatus row it does not name. That is honest, not a mapping
  // bug: the enum's refused-connection row is CANNOT_CONNECT (0xC, "a connection to the destination
  // was not established"), which the guard maps to -102; UNKNOWN (0x0) is documented as "an unknown
  // error occurred". `webErrorStatus` in the result now records the exact row that arrived.
  try { await fetch(`${origin}/__quit`); } catch { /* exits */ }
  await sleep(500);
  const stopped = await cdp.eval(`(async function () {
    var wv = document.querySelector('#guard-probe-host webview');
    var origin = (wv.dataset.home || '').replace(/\\/$/, '');
    var last = null;
    function onFail(e) { last = { code: e.errorCode, desc: e.errorDescription, webErrorStatus: e.webErrorStatus }; }
    wv.addEventListener('did-fail-load', onFail);
    try { await wv.loadURL(origin + '/'); } catch (e) { /* expected */ }
    await new Promise(function (r) { setTimeout(r, 500); });
    wv.removeEventListener('did-fail-load', onFail);
    return last;
  })()`);
  cases.stoppedFail = stopped;

  // 4. open the board guest directly through the same IPC `openBoard()` uses (board.status is always
  // `local` in the preview, so renderBoardTab would take this branch). The tab click is dead for the
  // same app.js:47 reason as the wardrobe one. The local board URL carries the owner token in its
  // fragment: it is used only to build the <webview> and is NEVER printed or written to results.json.
  const board = await cdp.eval(`(async () => {
    try {
      const info = await window.zumi.info();
      const b = await window.zumi.openBoard();
      if (!b || b.error) return { error: (b && b.error) || 'no-reply' };
      if (b.refused) return { error: 'board import refused' };
      const wv = document.createElement('webview');
      wv.setAttribute('partition', info.boardPartition);
      wv.setAttribute('allowpopups', '');
      const u = new URL(b.url);
      u.searchParams.set('embed', '1');
      u.searchParams.set('lang', 'en');
      u.searchParams.set('local', 'hide');
      wv.setAttribute('src', u.href);
      wv.dataset.home = b.url;
      wv.addEventListener('did-finish-load', () => { wv.dataset.loaded = '1'; });
      wv.addEventListener('did-fail-load', (e) => { wv.dataset.failed = String(e.errorCode); });
      document.getElementById('board-host').appendChild(wv);
      return { origin: b.origin };
    } catch (e) { return { error: (e && e.message) || String(e) }; }
  })()`);
  // A board open failure is not an instrument failure: record it, let guardOk fail (no board guard
  // line) and still write results.json, so the wardrobe evidence from this run survives.
  let boardGuest = { origin: null, loaded: false, failed: null, error: null };
  if (!board || board.error) {
    boardGuest.error = (board && board.error) || 'no-reply';
    process.stdout.write(`[driver] board guest: open failed (${boardGuest.error})\n`);
  } else {
    boardGuest.origin = board.origin;
    process.stdout.write(`[driver] board guest: opened\n`);
    // Wait for the board guest's own load (the guard line is emitted at open, before navigation).
    const boardDeadline = Date.now() + 25000;
    while (Date.now() < boardDeadline) {
      const st = await cdp.eval(`(() => {
        const wv = document.querySelector('#board-host webview');
        return wv && wv.dataset ? { loaded: wv.dataset.loaded === '1', failed: wv.dataset.failed || null } : null;
      })()`);
      if (st) {
        boardGuest.loaded = st.loaded;
        boardGuest.failed = st.failed;
        if (st.loaded || st.failed) break;
      }
      await sleep(250);
    }
    process.stdout.write(`[driver] board guest: loaded=${boardGuest.loaded} failed=${boardGuest.failed || 'no'}\n`);
  }

  // ---- P1c4: close the app (WM_CLOSE, <= 5 s), then judge startup order from stderr + the watcher ----
  const exitResult = closeAndMeasure(ctx);
  let stderrText = '';
  try { stderrText = fs.readFileSync(STDERR, 'utf8'); } catch { /* an unreadable log is a startup FAIL below */ }
  let watch = null;
  for (let i = 0; i < 20 && !watch; i += 1) {
    try { watch = JSON.parse(fs.readFileSync(WATCH, 'utf8').replace(/^\uFEFF/, '')); } catch { await sleep(250); }
  }
  finishMain(mainBlock, judgeStartup(stderrText, watch), exitResult);
  mainBlock.watch = watch;

  // ---- verdicts ----
  // remoteHits is http-only; ws handshakes live in wsHits (gate Q3) and never decide the overall PASS.
  const remoteHits = (results.remoteHits || []).filter((h) => h.path !== '/__preflight');
  const wsHits = results.wsHits || [];
  const leaked = (p) => remoteHits.some((h) => h.path === p);
  const controls = results.controls || {};
  const instrument = results.instrument || {};

  const lines = [];
  const instrumentValid = Boolean(instrument.remoteBase) && instrument.preflight === true && !instrument.error;
  if (!instrumentValid) {
    process.stdout.write(`INSTRUMENT_INVALID: ${instrument.error || 'remote listener preflight failed'}\n`);
  }

  const pageOutcomes = results.pageOutcomes || {};
  const vectorVerdicts = {};
  for (const [name, p] of Object.entries(HTTP_VECTORS)) {
    const key = VECTOR_REPORTS[name];
    const value = key ? pageOutcomes[key] : undefined;
    const reported = key !== undefined && key in pageOutcomes;
    const didNotRun = value === 'throw'; // the vector's own setup threw: it never ran
    const noRun = typeof value === 'string' && value.startsWith('n/a');
    const bad = leaked(p);
    if (!reported) {
      vectorVerdicts[name] = 'FAIL';
      lines.push(`FAIL ${name} (no completion report within ${VECTOR_TIMEOUT_MS} ms)`);
    } else if (didNotRun) {
      vectorVerdicts[name] = 'FAIL';
      lines.push(`FAIL ${name} (did not run: ${value})`);
    } else if (noRun) {
      vectorVerdicts[name] = 'INCONCLUSIVE';
      lines.push(`INCONCLUSIVE ${name} (${value})`);
    } else if (bad) {
      vectorVerdicts[name] = 'FAIL';
      lines.push(`FAIL ${name} (remote received ${p})`);
    } else {
      vectorVerdicts[name] = 'PASS';
      lines.push(`PASS ${name} (${value})`);
    }
  }
  const wsLeak = wsHits.some((h) => h.path === WS_VECTOR) || pageOutcomes.ws === 'open';
  // Gate Q3 only: never in `pass`. A page that never reported ws is UNOBSERVED, not BLOCKED.
  const wsVerdict = wsLeak ? 'LEAK' : typeof pageOutcomes.ws === 'string' ? 'BLOCKED' : 'UNOBSERVED';
  const wsLine = `ws: ${wsVerdict}`;

  // The redirect vector's finding: whether WebView2 raised WebResourceRequested on the hop. `leaked`
  // means it did not (the remote listener was hit); `blocked` means it did; anything else is unknown.
  const redirectHop = !instrumentValid
    ? 'inconclusive'
    : leaked('/vector-redirect-remote')
      ? 'leaked'
      : 'redirect' in pageOutcomes
        ? 'blocked'
        : 'inconclusive';

  const controlsOk = Boolean(controls.ok && controls.ok2);
  const http404Ok = cases.http404 === 'finished';
  const dieOk = cases.dieFail && typeof cases.dieFail.code === 'number' && cases.dieFail.code < 0 && cases.dieFail.code !== -3;
  const stoppedOk = cases.stoppedFail && typeof cases.stoppedFail.code === 'number' && cases.stoppedFail.code < 0 && cases.stoppedFail.code !== -3;

  const guards = guardLines(STDERR);
  // alpha.12: both guests (the probe stand-in and the board) are board guests (guest-board-<n>): two guard lines, both all.
  const boardKinds = kindSourceKinds(guards, 'board');
  const guardOk = boardKinds.length >= 2 && boardKinds.every((k) => k === 'all');

  const vectorsOk = Object.values(vectorVerdicts).every((v) => v === 'PASS');
  const localhostOk = LOCALHOST_HOSTS.every((h) => localhostVerdicts[h] === LOCALHOST_EXPECT[h]);
  // Parity 11-2, from the wardrobe page itself: the bridge carries exactly `apply`, the command is answered
  // by the sidecar (reachable), and the main rpc command is ACL-refused from this guest (only one command).
  const bridgeKeys = pageOutcomes.bridge_keys || 'missing';
  const bridgeApply = pageOutcomes.bridge_apply || 'not reported';
  const bridgeOther = pageOutcomes.bridge_other || 'not reported';
  // alpha.12: no guest has a bridge any more; the page must find none, and the main rpc must not answer it.
  const bridgeOk = bridgeKeys === 'missing' && bridgeOther !== 'allowed';
  const guestPass = instrumentValid && remoteHits.length === 0 && controlsOk && http404Ok && dieOk && stoppedOk && guardOk && vectorsOk && localhostOk && bridgeOk;
  const pass = guestPass && mainBlock.verdict === 'PASS';
  const verdict = !instrumentValid || mainBlock.verdict === 'INSTRUMENT_INVALID'
    ? 'INSTRUMENT_INVALID'
    : pass
      ? 'PASS'
      : !guestPass || mainBlock.verdict === 'FAIL'
        ? 'FAIL'
        : 'INCONCLUSIVE';

  const out = {
    verdict,
    guestPass,
    main: mainBlock,
    mainWs: mainBlock.ws,
    vectorsOk,
    localhostOk,
    bridgeOk,
    bridge: { keys: bridgeKeys, apply: bridgeApply, other: bridgeOther },
    localhost: localhostVerdicts,
    localhostOutcomes: {
      'ipc.localhost': pageOutcomes.host_ipc || null,
      'tauri.localhost': pageOutcomes.host_tauri || null,
    },
    assetControl: assetControlOk,
    instrument,
    origin,
    boardGuest,
    controls,
    pageOutcomes: results.pageOutcomes || null,
    remoteHits,
    wsHits,
    vectorVerdicts,
    ws: wsVerdict,
    redirectHop,
    loadCases: {
      http404: cases.http404,
      die: cases.die,
      dieFail: cases.dieFail,
      stoppedFail: cases.stoppedFail,
    },
    guardLines: guards,
    guardOk,
    stoppedOk,
  };

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(out, null, 2));

  for (const l of lines) process.stdout.write(l + '\n');
  process.stdout.write(wsLine + '\n');
  process.stdout.write(`redirect hop: ${redirectHop} (whether WebResourceRequested fired on the hop)\n`);
  process.stdout.write(`localhost: ${LOCALHOST_HOSTS.map((h) => `${h}=${localhostVerdicts[h]} (expected ${LOCALHOST_EXPECT[h]}; ${out.localhostOutcomes[h] || 'not reported'})`).join(' ')}` + '\n');
  process.stdout.write(`wardrobe bridge: ${bridgeOk ? 'PASS' : 'FAIL'} (keys=${bridgeKeys} apply=${bridgeApply} other=${bridgeOther})` + '\n');
  process.stdout.write(`controls: same-origin=${Boolean(controls.ok)} cross-loopback=${Boolean(controls.ok2)}\n`);
  process.stdout.write(`load 404=${cases.http404} die=${JSON.stringify(cases.dieFail)} stopped=${JSON.stringify(cases.stoppedFail)}\n`);
  process.stdout.write(`guard lines: ${guards.map((g) => `${g.label}=${g.sourceKinds}`).join(', ') || '(none)'} guardOk=${guardOk}\n`);
  // P1c4 main phase. Statuses and outcome names only: no URL, no title.
  process.stdout.write(`main: ${mainBlock.verdict} (boot=${mainBlock.boot} control=${mainBlock.control})\n`);
  for (const [name, v] of Object.entries(mainBlock.vectors)) process.stdout.write(`main ${v.status} ${name} (${mainBlock.vectorOutcomes[name]})${v.status === 'PASS' ? '' : ` ${v.why}`}\n`);
  process.stdout.write(`mainWs: ${mainBlock.ws}\n`);
  process.stdout.write(`main rpc: ${mainBlock.rpc ? mainBlock.rpc.status : 'n/a'}\n`);
  process.stdout.write(`main startup: ${mainBlock.startup.status} guard-before-shown=${mainBlock.startup.orderOk} first=${mainBlock.startup.firstDocument ? 'document' : mainBlock.startup.firstOther ? 'other' : 'missing'} visibleAfterGuard=${mainBlock.startup.visibleAfterGuard}\n`);
  for (const label of ['pre', 'post']) {
    for (const [name, v] of Object.entries(mainBlock.events[label])) process.stdout.write(`main events.${label}.${name}: ${v.status}${v.why ? ` (${v.why})` : ''}\n`);
  }
  process.stdout.write(`main exit: ${mainBlock.exit.status}${mainBlock.exit.ms !== undefined ? ` (${mainBlock.exit.ms} ms)` : ''}\n`);
  process.stdout.write(`VERDICT: ${out.verdict}\n`);

  process.exit(out.verdict === 'PASS' ? 0 : 1);
}

main().catch((e) => {
  process.stdout.write(`INSTRUMENT_INVALID: ${e && e.message}\n`);
  process.exit(1);
});
