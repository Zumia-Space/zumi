// T-31 board-bridge self-heal, round 2 (field report 14-11, the Board tab lost its connection again: the sidecar
// lived, only its own port listened, no bridge port, and nothing on disk said why). Node only, loopback only.
//   1. lead board-host.mjs:142 (a transient 'io' flips the board to local mode for good): one transient upstream
//      io error, then a healthy upstream, must leave the board live with a working bridge.
//   2. a persistent, bounded sidecar log (<data-dir>/logs/sidecar.log, ~1 MB, one old file) that carries bridge
//      up/down, port, mode changes with the reason, upstream errors as codes only, and wall-clock gaps; no secrets.
//   3. the Board tab watch (src/renderer/board-live-watch.js): the tab finds the live port by itself (a restarted
//      bridge, a restarted sidecar), shows the lock/sign-in card when the host says so, and re-loads a page that
//      booted while the upstream was down and never got its board (the vendored page stops polling then).
//   node scripts/check-board-bridge-heal2.mjs
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'vendor', 'laneboard', 'public');
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const tryImport = async (rel, name) => { try { return await import(rel); } catch (e) { check(`${name} loads`, false, e.message); return null; } };

const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from([...Buffer.from(s, 'utf8')].map((b) => b ^ 0x5a)),
  decryptString: (b) => Buffer.from([...b].map((x) => x ^ 0x5a)).toString('utf8'),
};

// A controllable upstream: ok | reset (destroy the socket once = a transient io error) | 503 | down (refuse: closed).
let upMode = 'ok';
const upSockets = new Set();
const upstream = http.createServer((req, res) => {
  if (upMode === 'reset') { upMode = 'ok'; req.socket.destroy(); return; }
  if (upMode === '503') { res.writeHead(503, { 'content-type': 'text/plain' }); res.end('busy'); return; }
  res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"tasks":[],"me":{}}');
});
upstream.on('connection', (s) => { upSockets.add(s); s.on('close', () => upSockets.delete(s)); });
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const UP_PORT = upstream.address().port;
const UPSTREAM = `http://127.0.0.1:${UP_PORT}/zumia`;

const { createLiveBoard } = await import('../src/main/board-live.mjs');
const { createBoardHost } = await import('../tauri/sidecar/board-host.mjs');
const dirs = [];
const mkdir = (tag) => { const d = path.join(root, `.check-bridge-heal2-${tag}-${process.pid}`); fs.mkdirSync(d, { recursive: true }); dirs.push(d); return d; };

/** GET over loopback; resolves {status, headers, body} or {error}. */
function get(url, headers = {}) {
  return new Promise((resolve) => {
    const req = http.get(url, { headers: { connection: 'close', ...headers } }, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b })); });
    req.on('error', (e) => resolve({ error: e.code || e.message }));
  });
}
/** The vendored page's first load: the single-use session URL, then the board state with the caller cookie. */
async function pageBoot(openUrl) {
  const first = await get(openUrl);
  const cookie = String((first.headers?.['set-cookie'] || [])[0] || '').split(';')[0];
  const origin = new URL(openUrl).origin;
  return { cookie, state: await get(`${origin}/api/v1/state?v=2`, { cookie }) };
}

// ---- 1. lead: board-host.mjs:142 ----
{
  const dir = mkdir('lead142');
  const logs = [];
  const host = createBoardHost({
    safeStorage: fakeSafeStorage, dataDir: dir, flavour: { values: { test: true, ownerAdmin: true } }, settings: () => ({}), saveSettings: () => ({}),
    log: (m) => logs.push(m), env: { ZUMI_BOARD_UPSTREAM: UPSTREAM }, idleLock: false,
  });
  const h = host.handlers;
  const set = await h['board.setSecretsOs']({ user: 'u', pass: 'p' });
  const live = await h['board.setMode']('live');
  const r1 = await h['board.liveOpen']();
  const boot = await pageBoot(r1.openUrl);
  check('lead 142 setup: live, page fed', set.ok && live.ok && boot.state.status === 200, { set, live, s: boot.state.status });
  upMode = 'reset';
  const hit = await get(`${r1.origin}/api/v1/state?v=2`, { cookie: boot.cookie });
  check('lead 142: the transient upstream io error reaches the page as an error answer', hit.status >= 500 || Boolean(hit.error), { status: hit.status, error: hit.error });
  const after = await get(`${r1.origin}/api/v1/state?v=2`, { cookie: boot.cookie });
  const st = h['board.status']();
  const r2 = await h['board.liveOpen']();
  check('lead 142 DISPROVED: after one transient io error and a healthy upstream the board is still live, same bridge, page fed again', st.mode === 'live' && after.status === 200 && r2.origin === r1.origin, { mode: st.mode, after: after.status, same: r2.origin === r1.origin });
  check('lead 142: the "io" at board-host.mjs:142 is board-secrets signOut\'s failed file delete only (signOut is the one caller)', !/setMode\('local'\)/.test(fs.readFileSync(path.join(root, 'tauri/sidecar/board-host.mjs'), 'utf8').replace(/'board\.signOut'[\s\S]*?\n {4}\},/, '')));
  check('log: an upstream io error is logged once as a code, then "ok again"', logs.some((l) => /upstream failing: (ECONNRESET|UND_ERR_SOCKET|other_side_closed|fetch_failed)/.test(l)) && logs.some((l) => /upstream ok again/.test(l)), logs);
  await host.dispose();
}

// ---- 2. the sidecar log ----
const sl = await tryImport('../tauri/sidecar/sidecar-log.mjs', 'sidecar-log.mjs');
if (sl) {
  const dir = mkdir('slog');
  const L = sl.createSidecarLog({ dataDir: dir, maxBytes: 4000 });
  check('log: lives at <data-dir>/logs/sidecar.log', L.file === path.join(dir, 'logs', 'sidecar.log'), L.file);
  for (let i = 0; i < 200; i++) L.write(`[board-live] line ${i} ${'x'.repeat(40)}`);
  const files = fs.readdirSync(path.join(dir, 'logs')).sort();
  const sz = files.map((f) => fs.statSync(path.join(dir, 'logs', f)).size);
  check('log: rotates at maxBytes and keeps exactly one old file', files.join(',') === 'sidecar.log,sidecar.log.1' && sz.every((s) => s <= 4000 + 200), { files, sz });
  check('log: lines carry an ISO time', /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z /.test(fs.readFileSync(L.file, 'utf8')));
  const planted = [
    'upstream http://heal-user:heal-pass@127.0.0.1:9/zumia refused',
    'session http://127.0.0.1:5555/__bridge-session?n=0123456789abcdef0123456789abcdef0123456789abcdef',
    'hdr Authorization: Basic aGVhbC11c2VyOmhlYWwtcGFzcw==',
    'hdr X-Laneboard-Token: lbt_SECRETTOKEN123',
    'cookie zumi_bridge_5555=feedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface',
    'bare token=abc.def.ghi and password=hunter2 and Bearer sk-abcdefghijklmnop',
    // gate S-c (GATE-OPUS-HEAL2 S3): key:value and key=value, any case, quoted JSON keys and values
    'password: pwcolon1 and Password = pweq2 and TOKEN: tkcolon3',
    'client secret: sccolon4 and SECRET=sceq5 and cookie: ckcolon6 and Cookie=ckeq7',
    'Authorization=azeq8 and apikey: akcolon9 and ApiKey=akeq10 and api_key: akcolon11 and x-api-key: akcolon12',
    '{"password":"pwjson13","user":"bob"} {\'token\': \'tkjson14\'} {"apiKey": "akjson15"}',
  ];
  const D2 = mkdir('slog2');
  const L2 = sl.createSidecarLog({ dataDir: D2 });
  for (const p of planted) L2.write(p);
  const text = fs.readFileSync(L2.file, 'utf8');
  const leaks = ['heal-pass', 'heal-user:', '0123456789abcdef0123456789abcdef', 'aGVhbC11c2VyOmhlYWwtcGFzcw', 'SECRETTOKEN123', 'feedfacefeedface', 'abc.def.ghi', 'hunter2', 'sk-abcdefghijklmnop', 'pwcolon1', 'pweq2', 'tkcolon3', 'sccolon4', 'sceq5', 'ckcolon6', 'ckeq7', 'azeq8', 'akcolon9', 'akeq10', 'akcolon11', 'akcolon12', 'pwjson13', 'tkjson14', 'akjson15'].filter((s) => text.includes(s));
  check('log: no secret, token, cookie, nonce or URL credential survives into the file', leaks.length === 0, { leaks, text });
  check('log: the redacted lines still say what happened (origin and port kept)', /127\.0\.0\.1:9/.test(text) && /127\.0\.0\.1:5555/.test(text));
  const evidence = ['upstream failing: ECONNREFUSED', '[guest] load failed: board-live code -106 ERR_INTERNET_DISCONNECTED webErrorStatus 4', 'live board mode at start: local'];
  check('log: the key:value rule leaves event lines alone (codes and modes stay readable)', evidence.every((e) => sl.sanitizeLogLine(e) === e), evidence.map((e) => sl.sanitizeLogLine(e)));

  // gate GATE-OPUS-037-DELTA3 S1: the scrubber runs synchronously on the sidecar thread for every line (the stderr tee too);
  // a long identifier-like line used to take seconds (4 KB of `xtokenx-` 5.6 s) and a 20 KB one minutes. Each case runs in a
  // worker with a hard stop, so a regression shows as a FAIL, not a hung check.
  const SCRUB_MS = 250, HARD_STOP_MS = 15_000;
  const timedScrub = (line) => new Promise((resolve) => {
    const src = "const { parentPort, workerData } = require('node:worker_threads'); import(workerData.mod).then(({ sanitizeLogLine }) => { const t = performance.now(); const out = sanitizeLogLine(workerData.line); parentPort.postMessage({ ms: Math.round(performance.now() - t), out }); });";
    const wk = new Worker(src, { eval: true, workerData: { mod: pathToFileURL(path.join(root, 'tauri', 'sidecar', 'sidecar-log.mjs')).href, line } });
    const stop = setTimeout(() => { wk.terminate(); resolve({ ms: Infinity, out: '', hardStop: true }); }, HARD_STOP_MS);
    wk.once('message', (m) => { clearTimeout(stop); wk.terminate(); resolve(m); });
    wk.once('error', (e) => { clearTimeout(stop); resolve({ ms: Infinity, out: '', error: e.message }); });
  });
  const CAP = sl.SIDECAR_LOG_LINE_MAX ?? 2048;
  const kw2k = 'xtokenx-'.repeat(256);
  const r2k = await timedScrub(kw2k);
  check(`log perf: a 2 KB keyword-dense line (xtokenx- x 256) scrubs within ${SCRUB_MS} ms (the key rules are linear, not cubic)`, r2k.ms <= SCRUB_MS, { ms: r2k.ms, hardStop: r2k.hardStop });
  const kw1m = `password=lead-secret-aa ${'xtokenx-'.repeat(131_072)} token=tail-secret-zz`;
  const hy1m = `Authorization: Bearer lead-secret-bb ${'a-'.repeat(524_288)} password: tail-secret-yy`;
  for (const [name, line] of [['keyword-dense', kw1m], ['hyphenated', hy1m]]) {
    const r = await timedScrub(line);
    const leaks = ['lead-secret-aa', 'lead-secret-bb', 'tail-secret-zz', 'tail-secret-yy'].filter((s) => r.out.includes(s));
    check(`log perf: a 1 MB ${name} line is capped and scrubbed within ${SCRUB_MS} ms`, r.ms <= SCRUB_MS, { ms: r.ms, hardStop: r.hardStop, error: r.error });
    check(`log cap: the 1 MB ${name} line is cut to the cap with a marker, and no secret survives (head scrubbed, tail dropped)`, r.out.length <= CAP + 64 && /\[\+\d+ chars cut\]$/.test(r.out) && leaks.length === 0, { len: r.out.length, tail: r.out.slice(-40), leaks });
  }
  // the wall-clock gap detector: injected clock, a 40 s jump between two 5 s ticks
  const gapLines = [];
  let wall = 1_000_000, mono = 0;
  const g = sl.createClockGapWatch({ log: (m) => gapLines.push(m), everyMs: 5000, gapMs: 15000, wallNow: () => wall, monoNow: () => mono });
  wall += 5000; mono += 5000; g.tick();
  check('gap: a normal tick logs nothing', gapLines.length === 0, gapLines);
  wall += 45000; mono += 5000; g.tick();
  check('gap: a 45 s wall-clock jump is logged as a sleep/resume or clock jump, with both deltas', gapLines.length === 1 && /wall-clock gap 45 s/.test(gapLines[0]) && /monotonic 5 s/.test(gapLines[0]), gapLines);
  wall += 5000; mono += 30000; g.tick();
  check('gap: a process stall (monotonic jump too: suspended process) is logged as well', gapLines.length === 2 && /monotonic 30 s/.test(gapLines[1]), gapLines);
}

// ---- 2b. the board-live log lines (bridge up + port, mode change + reason) ----
{
  const dir = mkdir('modelog');
  const logs = [];
  const lb = createLiveBoard({ safeStorage: fakeSafeStorage, secretsDir: dir, publicDir, upstream: UPSTREAM, allowTestUpstream: true, log: (m) => logs.push(m), bridgeBackoff: { baseMs: 50, maxMs: 200 } });
  lb.secrets.configureOs({ user: 'u', pass: 'p', token: '' });
  await lb.setMode('live', 'test-enter');
  const port = await lb.bridgePort();
  await lb.setMode('local', 'test-leave');
  check('log: bridge up names its port', logs.some((l) => l === `live board bridge up on port ${port}`), logs);
  check('log: mode changes name both modes and the reason', logs.some((l) => /mode local -> live \(test-enter\)/.test(l)) && logs.some((l) => /mode live -> local \(test-leave\)/.test(l)), logs);
  await lb.close();
}

// ---- 3. the Board tab watch (renderer half, pure) ----
const w = await tryImport('../src/renderer/board-live-watch.js', 'board-live-watch.js');
if (w) {
  const live = { mode: 'live', configured: true, locked: false };
  const cur = 'http://127.0.0.1:5000';
  const open = (port, extra = {}) => ({ origin: `http://127.0.0.1:${port}`, partition: 'p', openUrl: `http://127.0.0.1:${port}/__bridge-session?n=x`, ...extra });
  const d = (o) => w.decideLiveWatch({ currentOrigin: cur, openedAt: 0, now: 60_000, ...o });
  check('watch: the host moved the bridge (restart, or a restarted sidecar) -> a new guest on the new port, no Reload', d({ status: live, open: open(6000, { fed: true }) }).action === 'reopen');
  check('watch: same port, page fed -> nothing (no reload while the page works)', d({ status: live, open: open(5000, { fed: true }) }).action === 'none');
  check('watch: same port, the page never got its board (booted while the upstream was down) -> reload in place', d({ status: live, open: open(5000, { fed: false }) }).action === 'navigate');
  check('watch: ...but not before the page had time to load (20 s grace)', d({ status: live, open: open(5000, { fed: false }), openedAt: 50_000 }).action === 'none');
  check('watch: a host without the fed flag (Electron main, frozen) never triggers a reload', d({ status: live, open: open(5000) }).action === 'none');
  check('watch: locked (sleep/idle lock) -> render the tab (the unlock card), not a page of 401s', d({ status: { ...live, locked: true } }).action === 'render');
  check('watch: not live -> render', d({ status: { ...live, mode: 'local' } }).action === 'render');
  check('watch: sign-in refused -> render', d({ status: { ...live, authRejected: true } }).action === 'render');
  check('watch: the host cannot give a port right now -> keep the guest and ask again next tick', d({ status: live, open: { error: 'bridge_down' } }).action === 'none');
  const appJs = fs.readFileSync(path.join(root, 'src', 'renderer', 'app.js'), 'utf8');
  check('watch: app.js runs the watch on a timer and on sidecar-ready (a restarted sidecar)', /decideLiveWatch\(/.test(appJs) && /setInterval\(\s*watchLiveBoard/.test(appJs) && /zumi:sidecar-ready['"],\s*watchLiveBoard/.test(appJs));
}

// ---- 4. a failed main-frame load (field 14-11: CONNECTION_ABORTED on a LIVE bridge) re-asks the host and rebuilds ----
if (w) {
  const ok4 = typeof w.createFailLoadRecovery === 'function';
  check('recover: board-live-watch.js exports createFailLoadRecovery', ok4);
  if (ok4) {
    const timers = [];
    const setTimer = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
    const run = async () => { const t = timers.shift(); await t.fn(); return t.ms; };
    let answers = [];
    const rebuilt = [];
    const rec = w.createFailLoadRecovery({ liveOpen: async () => answers.shift(), rebuild: (r) => rebuilt.push(r.origin), setTimer });
    check('recover: an aborted-by-navigation (-3) is not a failure', rec.onFail(-3) === false && timers.length === 0);
    check('recover: any other failed load (CONNECTION_ABORTED -103) schedules one host call', rec.onFail(-103) === true && timers.length === 1);
    check('recover: a second failure while one is pending adds nothing', rec.onFail(-101) === false && timers.length === 1);
    answers = [{ origin: 'http://127.0.0.1:7001', openUrl: 'http://127.0.0.1:7001/__bridge-session?n=a' }];
    const d1 = await run();
    check('recover: after ~1 s it asks board.liveOpen and rebuilds the guest on the RETURNED origin (same or new port)', d1 === 1000 && rebuilt.join() === 'http://127.0.0.1:7001', { d1, rebuilt });
    const delays = [];
    answers = Array(20).fill({ error: 'bridge_down' });
    rec.onFail(-103);
    for (let i = 0; i < 12 && timers.length; i++) delays.push(await run());
    // gate S-b (GATE-OPUS-HEAL2 S2): the six fast tries end ~31 s in; a longer outage left the tab dead until Reload
    check('recover: while the host cannot answer: doubling, capped fast backoff, then a slow retry every 30 s that never gives up', delays.join() === '2000,4000,8000,8000,8000,30000,30000,30000,30000,30000,30000,30000' && timers.length === 1, { delays, pending: timers.length });
    answers = [{ origin: 'http://127.0.0.1:7002', openUrl: 'http://127.0.0.1:7002/__bridge-session?n=b' }];
    if (timers.length) await run();
    check('recover: a slow retry that gets an answer rebuilds the guest (no Reload)', rebuilt.at(-1) === 'http://127.0.0.1:7002' && timers.length === 0, rebuilt);
    rec.onLoaded();
    check('recover: a load that finished resets the budget', rec.onFail(-103) === true && timers[0].ms === 1000);
    timers.length = 0;
    // the slow retry runs only while the tab is on screen and the failed guest is still the tab's guest
    let shown = true, calls = 0;
    const rec2 = w.createFailLoadRecovery({ liveOpen: async () => { calls++; return { error: 'bridge_down' }; }, rebuild: () => {}, setTimer, active: () => shown });
    rec2.onFail(-103);
    shown = false;
    await run();
    check('recover: tab hidden or guest gone -> no host call and no further timer', calls === 0 && timers.length === 0, { calls, pending: timers.length });
    shown = true;
    const rec3 = w.createFailLoadRecovery({ liveOpen: async () => null, rebuild: () => {}, setTimer });
    rec3.resume?.();
    check('recover: resume() with nothing parked does nothing', typeof rec3.resume === 'function' && timers.length === 0);
    rec2.resume?.();
    const resumed = timers.length === 1;
    if (resumed) await run();
    check('recover: shown again -> resume() picks the retry up', resumed && calls === 1, { resumed, calls });
    timers.length = 0;
  }
  const appJs = fs.readFileSync(path.join(root, 'src', 'renderer', 'app.js'), 'utf8');
  const open = appJs.slice(appJs.indexOf('const openLiveBoard = '), appJs.indexOf('// Owner words only (PLAN-live-board.md'));
  check('recover: the live guest\'s did-fail-load hands the failure to the recovery, did-finish-load resets it', /liveFailRecovery\.onFail\(/.test(open) && /liveFailRecovery\.onLoaded\(\)/.test(open));
  const recBlock = appJs.slice(appJs.indexOf('const liveFailRecovery = '), appJs.indexOf('let boardStatus = '));
  check('recover: app.js runs the slow retry only while the failed guest is on screen, and the live watch resumes it', /active: \(\) => liveFailedGuest === webview[^\n]*isBoardTabActive\(\)[^\n]*visibilityState/.test(recBlock) && /liveFailRecovery\.resume\(\)/.test(appJs.slice(appJs.indexOf('async function watchLiveBoard'))));
}

// ---- 5. no pooled bridge socket (bridge-finswallow supersedes heal-2's 330 s keep-alive): even a keep-alive client gets
//      Connection: close on every answer, so no idle socket can go stale behind a filter that eats the FIN.
//      The FIN-swallow repro itself: scripts/check-board-bridge-finswallow.mjs ----
{
  const made = [];
  const realCreate = http.createServer;
  http.createServer = function (...a) { const s = realCreate.apply(this, a); made.push(s); return s; };
  const { createBridge } = await import('../src/main/board-bridge.mjs');
  const b = createBridge({ upstreamOrigin: UPSTREAM, publicDir, getBasicAuth: () => ({ user: 'u', pass: 'p' }) });
  http.createServer = realCreate;
  const port = await b.port();
  const s = made.at(-1);
  const agent = new http.Agent({ keepAlive: true });
  const ask = (p, headers = {}) => new Promise((resolve) => { http.get({ host: '127.0.0.1', port, path: p, agent, headers: { connection: 'keep-alive', ...headers } }, (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode, connection: res.headers.connection })); }).on('error', (e) => resolve({ error: e.code })); });
  const answers = [await ask('/api/v1/state', b.callerHeaders()), await ask('/api/v1/state'), await ask('/', b.callerHeaders())];
  agent.destroy();
  check('keep-alive: every bridge answer (proxied read, refusal, static page) says Connection: close to a keep-alive client', answers.every((x) => x.connection === 'close') && answers[0].status === 200 && answers[1].status === 401, answers);
  check('keep-alive: the 330 s keep-alive is gone (no idle socket is left open to need it)', s.keepAliveTimeout < 300_000, s.keepAliveTimeout);
  await b.close();
}

// ---- 6. the host's guest load-failure report lands in the sidecar log (raw webErrorStatus), and stderr is kept ----
{
  const main = fs.readFileSync(path.join(root, 'tauri', 'sidecar', 'main.mjs'), 'utf8');
  check('log: the sidecar handles __host.guestLoadFailed (code, description, raw webErrorStatus)', /'__host\.guestLoadFailed'/.test(main));
  check('log: every sidecar stderr line is also written to sidecar.log', /process\.stderr\.write = /.test(main));
  const rs = fs.readFileSync(path.join(root, 'tauri', 'src-tauri', 'src', 'guest_guard.rs'), 'utf8');
  check('log: the Rust host forwards each guest did-fail-load to the sidecar', /push_guest_load_failed\(/.test(rs));
}

// ---- 3b. the host half of "fed": liveOpen says whether the page loaded through the session URL got a 200 board ----
{
  const dir = mkdir('fed');
  const host = createBoardHost({ safeStorage: fakeSafeStorage, dataDir: dir, flavour: { values: { test: true, ownerAdmin: true } }, settings: () => ({}), saveSettings: () => ({}), env: { ZUMI_BOARD_UPSTREAM: UPSTREAM }, idleLock: false });
  const h = host.handlers;
  await h['board.setSecretsOs']({ user: 'u', pass: 'p' });
  await h['board.setMode']('live');
  upMode = '503';
  const r1 = await h['board.liveOpen']();
  const b1 = await pageBoot(r1.openUrl);
  const r2 = await h['board.liveOpen']();
  check('fed: a page that booted while the upstream answered 503 is reported unfed', b1.state.status === 503 && r2.fed === false, { s: b1.state.status, fed: r2.fed });
  upMode = 'ok';
  const b2 = await pageBoot(r2.openUrl);
  const r3 = await h['board.liveOpen']();
  check('fed: once its board came back 200 it is reported fed', b2.state.status === 200 && r3.fed === true, { s: b2.state.status, fed: r3.fed });
  const hdr = await h['board.testBridgeAuth']();
  await get(`http://127.0.0.1:${hdr.port}/api/v1/state`, hdr.headers);
  const b3 = await get(r3.openUrl);
  const r4 = await h['board.liveOpen']();
  check('fed: a new page load resets it, and an in-process reader (caller header) does not count as the page', b3.status === 302 && r4.fed === false, { s: b3.status, fed: r4.fed });
  await host.dispose();
}

// ---- 7. gate S-a (GATE-OPUS-HEAL2 S1): the 5 s live watch mints a session nonce per tick; the map must stay bounded ----
{
  const { createBridge } = await import('../src/main/board-bridge.mjs');
  const b = createBridge({ upstreamOrigin: UPSTREAM, publicDir, getBasicAuth: () => ({ user: 'u', pass: 'p' }) });
  await b.port();
  const realNow = Date.now;
  let fake = realNow();
  Date.now = () => fake;
  let peak = 0, last = null;
  try {
    for (let i = 0; i < 720; i++) { last = await b.sessionUrl(); peak = Math.max(peak, b.pendingNonces?.() ?? Infinity); fake += 5000; } // one simulated hour, tab on screen
  } finally { Date.now = realNow; }
  check('nonce: an hour of the 5 s watch (720 session URLs, none loaded) keeps at most a TTL\'s worth of nonces (<= 13), not ~720', peak <= 13, { peak });
  for (let i = 0; i < 1000; i++) last = await b.sessionUrl(); // a burst inside one TTL
  check('nonce: a burst inside one TTL is capped too', (b.pendingNonces?.() ?? Infinity) <= 64, b.pendingNonces?.());
  const r = await get(last);
  check('nonce: the newest session URL still works after the prune and the cap', r.status === 302, r.status);
  await b.close();
}

upstream.close();
for (const s of upSockets) s.destroy();
for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0; // no process.exit(): exiting with sockets still closing trips a libuv assert on Windows (async.c:76)
