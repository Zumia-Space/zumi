// T-31 board-bridge self-heal round 2: the REAL sidecar plus the Board tab's page logic, driven through every field
// trigger (field report 14-11: the Board tab lost its connection again while the sidecar lived).
// Plain Node, no window, no OS network change: the upstream is a loopback stub the harness controls, sleep is the
// sidecar process really suspended (NtSuspendProcess) while the page/renderer timers are paused, plus a Date.now jump.
//
// Per trigger a fresh sidecar (same sandbox data dir, signed in without a PIN unless the trigger says PIN) and a fresh
// Board tab are opened and fed, the trigger runs, and the tab is then given 30 s. "alive" = the page the tab shows got
// a 200 board AFTER the trigger ended, with no Reload click; the time it took is printed. Stricter rows (gate S4/S-b):
// a moved bridge must be followed within 10 s, keepalive-idle-reuse (behind a FIN-swallowing filter, bridge-finswallow)
// must not fail a load at all, and abort-outage-2min
// (every bridge load cut for 2 min) gets 45 s after the outage, one slow retry.
//
// The Board tab is simulated in two layers, both from code, not from guesses:
//   - the page: vendor/laneboard/public/app.js's boot (session URL -> cookie -> GET /api/v1/state) and its 15 s poll,
//     which only runs once the page HAS a board (`if (S.data && ...) refresh()`), and drops the board on a 401;
//   - the renderer: WATCH=on runs src/renderer/board-live-watch.js decideLiveWatch every 5 s and on sidecar-ready, as
//     app.js does; WATCH=off is the alpha.7 renderer (it never asks the host again without a Reload click).
//
//   ZUMI_VAULT_EXE=<zumi-vault.exe> [SIDECAR_ROOT=<tree>] [WATCH=on|off] [TRIGGERS=a,b] [OUT=<json>] node scripts/check-tauri-board-bridge-heal2.mjs
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIDECAR_ROOT = path.resolve(process.env.SIDECAR_ROOT || ROOT);
const SIDECAR = path.join(SIDECAR_ROOT, 'tauri', 'sidecar', 'main.mjs');
const KILL_HOOK = pathToFileURL(path.join(ROOT, 'scripts', 'lib', 'bridge-kill-hook.mjs')).href;
const CLOCK_HOOK = pathToFileURL(path.join(ROOT, 'scripts', 'lib', 'clock-jump-hook.mjs')).href;
const WATCH = (process.env.WATCH || 'on') === 'on';
const OUTAGE_MS = Number(process.env.OUTAGE_MS || 30_000);
const RECOVER_MS = 30_000;
const PAGE_POLL_MS = 15_000; // vendor/laneboard/public/app.js setInterval(..., 15000)
const WATCH_MS = 5_000;
// gate S4 (GATE-OPUS-HEAL2): rows that bite on the keep-alive values and on the port-follow, and a 2 min outage (S-b).
const KEEPALIVE_IDLE_MS = 7_000; // past Node's 5 s keepAliveTimeout (+1 s buffer), well inside Chromium's reuse window
const LONG_OUTAGE_MS = 120_000; // past the ~31 s fast backoff
const LONG_RECOVER_MS = 45_000; // one 30 s slow retry plus the rebuild
const MOVE_ROWS = ['bridge-close', 'bridge-accept-error', 'sidecar-respawn'];
const MOVE_BAR_S = 10; // the 5 s watch follows a moved bridge in one or two ticks; the fed=false fallback takes 20 s+
const ALL = ['reload-mid-destroy', 'reload-aborted', 'keepalive-idle-reuse', 'io-blip', 'upstream-5xx', 'upstream-stall', 'net-loss', 'bridge-close', 'bridge-accept-error', 'sleep-wake', 'sleep-wake-pin', 'sidecar-respawn', 'respawn-during-net-loss', 'abort-outage-2min'];
const TRIGGERS = (process.env.TRIGGERS || ALL.join(',')).split(',').filter(Boolean);
const log = (m) => console.log(`  ${new Date().toISOString()} ${m}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(pred, ms, step = 200) { const end = Date.now() + ms; while (Date.now() < end) { const v = await pred(); if (v) return v; await wait(step); } return null; }

const HELPER = process.env.ZUMI_VAULT_EXE ? path.resolve(process.env.ZUMI_VAULT_EXE) : null;
if (!HELPER || !fs.existsSync(HELPER)) { console.log('FAIL set ZUMI_VAULT_EXE to a built zumi-vault.exe'); process.exit(1); }
// RECOVER=on: a live guest's did-fail-load goes to createFailLoadRecovery (app.js does the same). Default = WATCH.
const RECOVER = (process.env.RECOVER || (WATCH ? 'on' : 'off')) === 'on';
const watchMod = WATCH || RECOVER ? await import(pathToFileURL(path.join(ROOT, 'src', 'renderer', 'board-live-watch.js')).href) : null;
const decideLiveWatch = WATCH ? watchMod.decideLiveWatch : null;

const work = fs.mkdtempSync(path.join(ROOT, '.tauri-check-tmp-heal2-'));
const hostDir = path.join(work, 'host');
fs.mkdirSync(hostDir, { recursive: true });
fs.writeFileSync(path.join(hostDir, 'flavour.json'), `${JSON.stringify({ v: 1, cloudBase: null, test: true, reflexEgress: false, ownerAdmin: false, boardMirror: null }, null, 2)}\n`);
fs.copyFileSync(HELPER, path.join(hostDir, 'zumi-vault.exe'));
const KILL_FILE = path.join(work, 'kill-bridge');
const JUMP_FILE = path.join(work, 'clock-jump');

// ---- the upstream stub: ok | reset-once | 503 | hang | down (listener closed, sockets cut = network loss) ----
let upMode = 'ok';
const upSockets = new Set();
const hung = new Set();
const upstream = http.createServer((req, res) => {
  if (upMode === 'reset-once') { upMode = 'ok'; req.socket.destroy(); return; }
  if (upMode === '503') { res.writeHead(503, { 'content-type': 'text/html' }); res.end('<html>503 Service Temporarily Unavailable</html>'); return; }
  if (upMode === 'hang') { hung.add(res); return; }
  res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ tasks: [{ id: 'T-1' }], me: {} }));
});
upstream.on('connection', (s) => { upSockets.add(s); s.on('close', () => upSockets.delete(s)); });
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const UP_PORT = upstream.address().port;
async function setUpstream(mode) {
  if (mode === 'down') { upMode = 'ok'; await new Promise((r) => { upstream.close(r); for (const s of upSockets) s.destroy(); }); return; }
  if (!upstream.listening) await new Promise((r) => upstream.listen(UP_PORT, '127.0.0.1', r));
  if (upMode === 'hang' && mode !== 'hang') { for (const res of hung) res.destroy(); hung.clear(); }
  upMode = mode;
}

function listenersFor(pid) {
  const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true });
  return out.split(/\r?\n/).map((l) => l.trim().split(/\s+/)).filter((p) => p.length >= 5 && p[3] === 'LISTENING' && p[4] === String(pid)).map((p) => Number(p[1].split(':').pop()));
}
/** Suspend/resume a process we started (NtSuspendProcess / NtResumeProcess), like a laptop going to sleep. */
function suspendProcess(pid, on) {
  const fn = on ? 'NtSuspendProcess' : 'NtResumeProcess';
  const ps = `$s=@'\nusing System;using System.Runtime.InteropServices;public static class P{[DllImport("ntdll.dll")]public static extern int ${fn}(IntPtr h);[DllImport("kernel32.dll")]public static extern IntPtr OpenProcess(int a,bool i,int p);}\n'@;Add-Type -TypeDefinition $s;$h=[P]::OpenProcess(0x0800,$false,${pid});[P]::${fn}($h)`;
  return execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true }).trim();
}

/** GET over loopback; resolves {status, headers} or {error}. */
function get(url, headers = {}, timeoutMs = 20_000) {
  return new Promise((resolve) => {
    const req = http.get(url, { headers: { connection: 'close', ...headers } }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
      res.on('aborted', () => resolve({ error: 'ERR_CONNECTION_ABORTED', midResponse: true })); // the socket died mid-response
      res.on('error', () => resolve({ error: 'ERR_CONNECTION_ABORTED', midResponse: true }));
    });
    req.on('error', (e) => resolve({ error: e.code || e.message }));
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
  });
}

/**
 * Chromium keeps an idle loopback socket and sends the page's next main-frame load on it, unless the answer said
 * Connection: close. Field root cause (owner's PC 14-11 06:28Z): a loopback filter ate the bridge's FIN when the bridge
 * closed an idle socket, so the client kept a half-dead socket. Here the load goes through a proxy that swallows the
 * server's FIN (never forwards the half-close, keeps the client side open, and resets a socket used after it).
 * GET on a keep-alive socket; after `idleMs` the next GET goes on the SAME socket if the first answer allowed reuse
 * (Chromium), else on a new one. A bridge that leaves a reusable idle socket gets an aborted second load.
 */
async function reuseIdleSocket(origin, urlPath, cookie, idleMs) {
  const u = new URL(origin);
  let finSwallowed = 0;
  const proxy = net.createServer({ allowHalfOpen: true }, (client) => {
    const up = net.connect({ host: '127.0.0.1', port: Number(u.port), allowHalfOpen: true });
    let serverFin = false;
    client.on('data', (d) => { if (serverFin) { client.resetAndDestroy(); up.destroy(); return; } up.write(d); });
    up.on('data', (d) => { if (!client.destroyed) client.write(d); });
    up.on('end', () => { serverFin = true; finSwallowed++; });
    client.on('end', () => up.end());
    up.on('error', () => {}); client.on('error', () => {}); client.on('close', () => up.destroy());
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  const req = `GET ${urlPath} HTTP/1.1\r\nHost: ${u.host}\r\nCookie: ${cookie}\r\nConnection: keep-alive\r\n\r\n`;
  const t0 = Date.now();
  // one GET on `sock` (a new proxied socket when null); resolves the head's status + Connection header, or an abort
  const once = (sock) => new Promise((resolve) => {
    const s = sock || net.connect(proxy.address().port, '127.0.0.1');
    let buf = '', done = false;
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); s.removeListener('data', onData); resolve({ ...r, sock: s }); };
    const timer = setTimeout(() => finish({ error: 'ETIMEDOUT' }), 20_000);
    const onData = (d) => {
      buf += d;
      if (!buf.includes('\r\n\r\n')) return;
      const head = buf.split('\r\n\r\n')[0];
      const st = /^HTTP\/1\.1 (\d{3})/.exec(head);
      const c = /\r\nconnection:\s*([^\r\n]+)/i.exec(head);
      finish({ status: st ? Number(st[1]) : null, connection: c ? c[1].trim().toLowerCase() : null });
    };
    s.on('data', onData);
    const cut = () => finish({ error: 'ERR_CONNECTION_ABORTED', closedAfterMs: Date.now() - t0 });
    s.once('error', cut); s.once('close', cut);
    if (sock) s.write(req); else s.once('connect', () => s.write(req));
  });
  const first = await once(null);
  let out;
  if (first.status !== 200) out = { status: first.status, error: first.error };
  else {
    await wait(idleMs);
    const reuse = first.connection !== 'close' && !first.sock.destroyed; // what Chromium does with a keep-alive answer
    if (!reuse) first.sock.destroy();
    const second = await once(reuse ? first.sock : null);
    out = { status: second.status, error: second.error, closedAfterMs: second.closedAfterMs, firstConnection: first.connection, reused: reuse };
    second.sock.destroy();
  }
  first.sock.destroy();
  proxy.close();
  return { ...out, finSwallowed };
}

// ---- the page (vendored Laneboard app.js, as far as the tab's life is concerned) ----
let paused = false; // sleep: the app's own timers do not run while the machine sleeps
class Page {
  constructor(origin) { this.origin = origin; this.cookie = ''; this.data = false; this.okAt = 0; this.dead = false; this.lastError = null; }
  // A main-frame load that fails is the guest's did-fail-load (-103 CONNECTION_ABORTED for a cut response or
  // connection, -102 refused): the guest shows an error page, the board's own JS is gone, nothing polls any more.
  failLoad(r) {
    this.lastError = r.error || r.status; this.data = false; this.crashed = true; clearInterval(this.timer); this.timer = null;
    const code = r.error === 'ECONNREFUSED' ? -102 : -103;
    if (tab.guest === this) tab.onFailLoad(code, r);
  }
  async boot(url) {
    this.crashed = false;
    const first = await get(url);
    if (first.error) return this.failLoad(first);
    if (first.status !== 302) { this.lastError = first.status; this.data = false; return; } // a 401 page: loaded, but no board
    this.cookie = String((first.headers['set-cookie'] || [])[0] || '').split(';')[0];
    return this.mainFrame(`${this.origin}/`);
  }
  /** The main frame itself (the board page), with the caller cookie: a boot's second hop, or the page reloading in place. */
  async mainFrame(url) {
    this.crashed = false;
    const page = await get(url, { cookie: this.cookie });
    if (page.error) return this.failLoad(page);
    tab.onLoaded();
    await this.refresh();
    if (!this.timer) { this.timer = setInterval(() => { if (!paused && !this.dead && !this.crashed && this.data) this.refresh(); }, PAGE_POLL_MS); }
  }
  async refresh() {
    const r = await get(`${this.origin}/api/v1/state?v=2`, { cookie: this.cookie });
    if (r.status === 200) { this.data = true; this.okAt = Date.now(); this.lastError = null; return; }
    if (r.status === 401) { this.data = false; this.lastError = 401; return; } // data.unauthorized: board dropped
    this.lastError = r.error || r.status; // offline/failed: keep the last board on screen, banner says offline
  }
  close() { this.dead = true; clearInterval(this.timer); }
}

// ---- the sidecar ----
let sc = null;
async function startSidecar(dataDir) {
  const args = ['--import', KILL_HOOK, '--import', CLOCK_HOOK, SIDECAR, '--data-dir', dataDir, '--no-voice-prefetch', '--vault-exe', path.join(hostDir, 'zumi-vault.exe'), '--host-dir', hostDir, '--flavour', path.join(hostDir, 'flavour.json')];
  const child = spawn(process.execPath, args, { cwd: SIDECAR_ROOT, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ZUMI_BOARD_UPSTREAM: `http://127.0.0.1:${UP_PORT}/zumia`, ZUMI_TEST_BRIDGE_KILL_FILE: KILL_FILE, ZUMI_TEST_CLOCK_JUMP_FILE: JUMP_FILE } });
  const s = { child, pending: new Map(), nextId: 1, stderr: '' };
  child.stderr.on('data', (d) => { s.stderr += d.toString(); });
  let readyResolve; s.ready = new Promise((r) => { readyResolve = r; });
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let m; try { m = JSON.parse(line); } catch { return; }
    if (m.method === 'ready') readyResolve();
    else if (m.id != null && s.pending.has(m.id)) { const p = s.pending.get(m.id); s.pending.delete(m.id); p(m); }
  });
  child.on('exit', () => { for (const p of s.pending.values()) p({ error: { message: 'sidecar_exited' } }); s.pending.clear(); });
  s.rpc = (method, params = []) => new Promise((resolve) => {
    if ((child.exitCode !== null || child.signalCode !== null)) return resolve({ error: { message: 'sidecar_exited' } });
    const id = s.nextId++; s.pending.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  await s.ready;
  sc = s;
  return s;
}
async function stopSidecar(s, hard = false) {
  if (!s || (s.child.exitCode !== null || s.child.signalCode !== null)) return;
  if (hard) s.child.kill(); else s.child.stdin.end();
  await until(() => (s.child.exitCode !== null || s.child.signalCode !== null), 5000);
  if (s.child.exitCode === null && s.child.signalCode === null) s.child.kill();
}
const call = async (method, params) => { const m = await sc.rpc(method, params); return m.error ? { error: String(m.error.message || m.error) } : m.result; };

// ---- the renderer's Board tab ----
const tab = { guest: null, openedAt: 0, card: false, reopens: 0, navigates: 0, rebuilds: 0, failLoads: [] };
let failedGuest = null;
if (RECOVER && typeof watchMod.createFailLoadRecovery !== 'function') console.log('FAIL src/renderer/board-live-watch.js has no createFailLoadRecovery: a failed guest load is never recovered');
const recovery = RECOVER && typeof watchMod.createFailLoadRecovery === 'function' ? watchMod.createFailLoadRecovery({
  liveOpen: () => call('board.liveOpen'),
  rebuild: (r) => { if (!failedGuest || failedGuest !== tab.guest) return; failedGuest = null; tab.rebuilds++; openGuest(r); },
}) : null;
tab.onFailLoad = (code, r) => {
  tab.failLoads.push(code);
  // what the Rust host forwards for every guest did-fail-load (guest_guard.rs push_guest_load_failed): code + raw status
  if (sc) sc.rpc('__host.guestLoadFailed', [{ label: 'board-live', errorCode: code, errorDescription: code === -103 ? 'ERR_CONNECTION_ABORTED' : 'ERR_CONNECTION_REFUSED', webErrorStatus: code === -103 ? 9 : 12 }]);
  failedGuest = tab.guest;
  if (recovery) recovery.onFail(code);
};
tab.onLoaded = () => { if (recovery) recovery.onLoaded(); };
async function openGuest(r) {
  if (tab.guest) tab.guest.close();
  tab.guest = new Page(r.origin);
  tab.openedAt = Date.now();
  tab.card = false;
  await tab.guest.boot(r.openUrl);
}
let watching = false;
async function watchTick() {
  if (!WATCH || paused || watching || !sc) return;
  watching = true;
  try {
    const status = await call('board.status');
    const live = status && !status.error && status.mode === 'live' && !status.locked && !status.authRejected;
    const open = live ? await call('board.liveOpen') : null;
    const plan = decideLiveWatch({ status: status && !status.error ? status : null, open, currentOrigin: tab.guest ? tab.guest.origin : null, openedAt: tab.openedAt, now: Date.now() });
    if (process.env.DEBUG) log(`watch: status ${JSON.stringify(status)} open ${JSON.stringify(open && (open.error || open.origin))} -> ${plan.action}`);
    if (plan.action === 'render') {
      if (status && !status.error) { if (tab.guest) { tab.guest.close(); tab.guest = null; } tab.card = Boolean(status.locked); }
    } else if (plan.action === 'reopen') { tab.reopens++; await openGuest(plan.r); }
    else if (plan.action === 'navigate') { tab.navigates++; tab.openedAt = Date.now(); await tab.guest.boot(plan.url); }
    else if (!tab.guest && live && open && !open.error) { tab.reopens++; await openGuest(open); } // the card was up; status is live again
  } finally { watching = false; }
}
const watchTimer = setInterval(() => { watchTick(); }, WATCH_MS);

// ---- one trigger ----
const results = [];
async function runTrigger(name) {
  const pin = name === 'sleep-wake-pin';
  const dataDir = path.join(work, `data-${name}`);
  fs.mkdirSync(dataDir, { recursive: true });
  await setUpstream('ok');
  await startSidecar(dataDir);
  const set = pin ? await call('board.setSecrets', [{ user: 'heal-user', pass: 'heal-pass', pin: '246813' }]) : await call('board.setSecretsOs', [{ user: 'heal-user', pass: 'heal-pass', token: '' }]);
  const mode = await call('board.setMode', ['live']);
  const r0 = await call('board.liveOpen');
  if (!set.ok || !mode.ok || r0.error) { results.push({ name, verdict: 'setup-failed', detail: JSON.stringify({ set, mode, r0 }) }); await stopSidecar(sc, true); return; }
  await openGuest(r0);
  const fedBefore = tab.guest.data;
  log(`${name}: tab open on ${r0.origin}, page fed=${fedBefore}, sidecar pid ${sc.child.pid}`);
  const port0 = Number(new URL(r0.origin).port);
  let tEnd = 0, note = '';

  if (name === 'reload-mid-destroy') {
    // the page reloads its main frame in place on a LIVE bridge and the socket is destroyed mid-response
    fs.writeFileSync(KILL_FILE, 'mid:/');
    await until(() => fs.existsSync(`${KILL_FILE}.done`), 3000, 100);
    fs.rmSync(`${KILL_FILE}.done`, { force: true });
    await tab.guest.mainFrame(`${tab.guest.origin}/?embed=1&lang=en`);
    note = `failed loads ${JSON.stringify(tab.failLoads)}`; tEnd = Date.now();
  } else if (name === 'reload-aborted') {
    // the user clicks Reload: board.liveOpen first (same origin), then the session URL load is aborted (CONNECTION_ABORTED)
    fs.writeFileSync(KILL_FILE, 'early:/__bridge-session');
    await until(() => fs.existsSync(`${KILL_FILE}.done`), 3000, 100);
    fs.rmSync(`${KILL_FILE}.done`, { force: true });
    const r = await call('board.liveOpen');
    await tab.guest.boot(r.openUrl);
    note = `failed loads ${JSON.stringify(tab.failLoads)}`; tEnd = Date.now();
  } else if (name === 'keepalive-idle-reuse') {
    // the page's next main-frame load goes out on the idle keep-alive socket 7 s later (Chromium's reuse); alive here
    // also needs NO failed load: the recovery would mask a socket the bridge closed. Through a FIN-swallowing proxy
    // (bridge-finswallow): a keep-alive answer leaves the client a half-dead socket; Connection: close never does.
    const r = await reuseIdleSocket(tab.guest.origin, '/?embed=1&lang=en', tab.guest.cookie, KEEPALIVE_IDLE_MS);
    note = `FIN-swallow proxy, next load ${KEEPALIVE_IDLE_MS / 1000} s idle later on ${r.reused ? 'the SAME socket' : 'a new socket'} (first answer Connection: ${r.firstConnection}, FINs swallowed ${r.finSwallowed}): ${r.error ? `${r.error} (after ${r.closedAfterMs} ms)` : r.status}`; tEnd = Date.now();
    if (r.error) tab.guest.failLoad(r); else { tab.onLoaded(); await tab.guest.refresh(); }
  } else if (name === 'abort-outage-2min') {
    // a loopback filter cuts every bridge load for 2 min (longer than the ~31 s fast backoff); the page reloads into it
    fs.writeFileSync(KILL_FILE, `outage:${LONG_OUTAGE_MS}`);
    await until(() => fs.existsSync(`${KILL_FILE}.done`), 3000, 100);
    fs.rmSync(`${KILL_FILE}.done`, { force: true });
    const t0 = Date.now();
    await tab.guest.mainFrame(`${tab.guest.origin}/?embed=1&lang=en`);
    await wait(Math.max(0, t0 + LONG_OUTAGE_MS - Date.now()));
    note = `failed loads during the outage ${tab.failLoads.length}, rebuilds ${tab.rebuilds}`; tEnd = Date.now();
  } else if (name === 'io-blip') { await setUpstream('reset-once'); await tab.guest.refresh(); note = `page saw ${tab.guest.lastError}`; tEnd = Date.now(); }
  else if (name === 'upstream-5xx' || name === 'upstream-stall' || name === 'net-loss') {
    await setUpstream({ 'upstream-5xx': '503', 'upstream-stall': 'hang', 'net-loss': 'down' }[name]);
    await wait(OUTAGE_MS);
    note = `page during outage: ${tab.guest.lastError}`;
    await setUpstream('ok'); tEnd = Date.now();
  } else if (name === 'bridge-close' || name === 'bridge-accept-error') {
    fs.writeFileSync(KILL_FILE, name === 'bridge-close' ? 'close' : 'error');
    await until(() => fs.existsSync(`${KILL_FILE}.done`), 3000, 100);
    fs.rmSync(`${KILL_FILE}.done`, { force: true });
    tEnd = Date.now();
  } else if (name === 'sleep-wake' || name === 'sleep-wake-pin') {
    await call('__host.osEvent', ['suspend']); // PBT_APMSUSPEND, pushed by the Rust host before the machine sleeps
    paused = true;
    suspendProcess(sc.child.pid, true);
    await setUpstream('down'); // the Wi-Fi is gone across sleep...
    await wait(OUTAGE_MS);
    fs.writeFileSync(JUMP_FILE, String(OUTAGE_MS + 3_600_000)); // the wall clock jumped while the process was frozen
    suspendProcess(sc.child.pid, false);
    paused = false;
    await until(() => fs.existsSync(`${JUMP_FILE}.done`), 3000, 100);
    fs.rmSync(`${JUMP_FILE}.done`, { force: true });
    await wait(8_000); // ...and comes back a few seconds after resume
    await setUpstream('ok'); tEnd = Date.now();
    note = `page after wake: ${tab.guest ? tab.guest.lastError : 'card'}`;
  } else if (name === 'sidecar-respawn' || name === 'respawn-during-net-loss') {
    if (name === 'respawn-during-net-loss') await setUpstream('down');
    const old = sc;
    old.child.kill(); // a crash; the Rust host respawns after 500 ms (lib.rs on_sidecar_exit)
    await until(() => (old.child.exitCode !== null || old.child.signalCode !== null), 5000);
    await wait(500);
    await startSidecar(dataDir);
    log(`${name}: respawned, new pid ${sc.child.pid}, listeners ${JSON.stringify(listenersFor(sc.child.pid))}`);
    watchTick(); // the shim's zumi:sidecar-ready (app.js runs the watch on it)
    if (name === 'respawn-during-net-loss') { await wait(OUTAGE_MS); await setUpstream('ok'); }
    tEnd = Date.now();
  }

  const listenersAtEnd = listenersFor(sc.child.pid);
  const healed = await until(() => tab.guest && tab.guest.okAt > tEnd && tab.guest.data ? Date.now() : null, name === 'abort-outage-2min' ? LONG_RECOVER_MS : RECOVER_MS, 250);
  const status = await call('board.status');
  const listeners = listenersFor(sc.child.pid);
  let verdict = healed ? 'alive' : (tab.card ? 'card' : 'dead');
  let secs = healed ? ((healed - tEnd) / 1000).toFixed(1) : '-';
  if (healed && MOVE_ROWS.includes(name) && Number(secs) > MOVE_BAR_S) verdict = `slow (over the ${MOVE_BAR_S} s bar: the watch did not follow the moved bridge)`;
  if (name === 'keepalive-idle-reuse' && tab.failLoads.length) verdict += ' (the guest reused an idle keep-alive socket whose FIN a filter ate: the load was aborted)';
  if (pin && tab.card) {
    // the user enters the PIN: the tab must come back by itself
    await call('board.unlock', ['246813']);
    const t1 = Date.now();
    const back = await until(() => tab.guest && tab.guest.okAt > t1 && tab.guest.data ? Date.now() : null, RECOVER_MS, 250);
    verdict = back ? 'card->alive after PIN' : 'card->dead after PIN';
    secs = back ? ((back - t1) / 1000).toFixed(1) : '-';
  }
  const row = { name, rebuilds: tab.rebuilds, verdict, secs, mode: status.mode, locked: status.locked, bridgeBefore: port0, listenersAtEnd, listeners, guestOrigin: tab.guest ? tab.guest.origin : null, pageError: tab.guest ? tab.guest.lastError : null, reopens: tab.reopens, navigates: tab.navigates, note };
  results.push(row);
  log(`${name}: ${verdict} ${secs}s ${JSON.stringify(row)}`);
  if (tab.guest) { tab.guest.close(); tab.guest = null; }
  tab.reopens = 0; tab.navigates = 0; tab.rebuilds = 0; tab.failLoads = [];
  const logFile = path.join(dataDir, 'logs', 'sidecar.log');
  row.sidecarLog = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '(no sidecar.log)';
  // the persistent log must hold the evidence (guest load failures with the raw status, bridge port, mode) and no secret
  const leaks = ['heal-pass', 'heal-user:', '246813', 'Basic ', 'zumi_bridge_'].filter((k) => row.sidecarLog.includes(k)).concat((row.sidecarLog.match(/[0-9a-f]{32,}/g) || []).slice(0, 1));
  row.logLeaks = leaks;
  if (leaks.length) row.verdict += ' (LOG LEAK)';
  if (/^reload-/.test(name) && !/\[guest\] load failed: board-live code -103 ERR_CONNECTION_ABORTED webErrorStatus 9/.test(row.sidecarLog)) row.verdict += ' (no guest failure in sidecar.log)';
  row.stderrBoard = sc.stderr.split(/\r?\n/).filter((l) => /\[board-live\]|bridge|upstream/i.test(l)).slice(-20);
  await stopSidecar(sc);
}

try {
  log(`sidecar root ${SIDECAR_ROOT}, renderer watch ${WATCH ? 'ON' : 'OFF (alpha.7)'}, outage ${OUTAGE_MS} ms`);
  for (const t of TRIGGERS) await runTrigger(t);
} finally {
  clearInterval(watchTimer);
  if (sc) await stopSidecar(sc, true);
  if (upstream.listening) upstream.close();
  for (const s of upSockets) s.destroy();
  for (const res of hung) res.destroy();
}
console.log('\n| trigger | result | seconds | mode | bridge listeners at trigger end |');
console.log('|---|---|---|---|---|');
for (const r of results) console.log(`| ${r.name} | ${r.verdict} | ${r.secs ?? '-'} | ${r.mode ?? '-'} | ${JSON.stringify(r.listenersAtEnd ?? [])} |`);
if (process.env.OUT) fs.writeFileSync(process.env.OUT, JSON.stringify({ sidecarRoot: SIDECAR_ROOT, watch: WATCH, results }, null, 2));
fs.rmSync(work, { recursive: true, force: true });
const bad = results.filter((r) => !/^alive$|->alive after PIN$/.test(r.verdict));
console.log(`\n${results.length - bad.length} alive, ${bad.length} not alive`);
process.exitCode = bad.length ? 1 : 0;
