// T-31 bridge FIN-swallow (root cause caught live on the owner's PC, 14-11 06:28Z): the bridge was alive, but the Board
// guest's WebView2 held exactly 6 sockets to it, all Established on the client side, while the server side showed them in
// FinWait1. The bridge had closed its idle keep-alive sockets (FIN sent) and the client never saw the FIN (a loopback filter
// driver ate it). Chromium's per-host pool (6) was then full of half-dead sockets, and the next load or XHR on one of them
// failed as ERR_CONNECTION_ABORTED.
//
// Repro, Node only, loopback only: a TCP proxy between the client and the real bridge that SWALLOWS the server's FIN (never
// forwards the half-close and keeps the client side open; data sent afterwards on that socket resets it, as the field saw).
// The client is a keep-alive pool capped at 6 (Chromium's per-host limit). It fills the pool, idles past the server's
// keep-alive, then sends 8 more requests with idle gaps past the keep-alive. Every request must get its 200.
//
// Time is compressed: the bridge's keepAliveTimeout, when above 1 s, is lowered to 1 s on the captured server, and each gap is
// 3 s (Node 24 closes an idle socket at keepAliveTimeout + keepAliveTimeoutBuffer, 1 s by default; the field
// gap was 30+ minutes, far past any keep-alive). What is under test is whether a response leaves a reusable idle socket.
//   [BRIDGE_ROOT=<tree>] node scripts/check-board-bridge-finswallow.mjs
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE_ROOT = path.resolve(process.env.BRIDGE_ROOT || ROOT);
const publicDir = path.join(BRIDGE_ROOT, 'vendor', 'laneboard', 'public');
const POOL = 6, AFTER = 8, IDLE_CLOSE_MS = 1000, GAP_MS = 3000, REQ_TIMEOUT_MS = 5000;
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- upstream stub (the live board) ----
const upstream = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"tasks":[],"me":{}}'); });
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const UPSTREAM = `http://127.0.0.1:${upstream.address().port}/zumia`;

// ---- the real bridge (its http server captured to compress the keep-alive) ----
const made = [];
const realCreate = http.createServer;
http.createServer = function (...a) { const s = realCreate.apply(this, a); made.push(s); return s; };
const { createBridge } = await import(pathToFileURL(path.join(BRIDGE_ROOT, 'src', 'main', 'board-bridge.mjs')).href);
const bridge = createBridge({ upstreamOrigin: UPSTREAM, publicDir, getBasicAuth: () => ({ user: 'u', pass: 'p' }) });
http.createServer = realCreate;
const bridgePort = await bridge.port();
const server = made.at(-1);
const keepAliveWas = server.keepAliveTimeout;
if (server.keepAliveTimeout > IDLE_CLOSE_MS) server.keepAliveTimeout = IDLE_CLOSE_MS;
console.log(`bridge from ${BRIDGE_ROOT} on ${bridgePort}, keepAliveTimeout ${keepAliveWas} ms -> ${server.keepAliveTimeout} ms`);

// ---- the FIN-swallowing proxy ----
const stats = { conns: 0, finSwallowed: 0, resetAfterFin: 0 };
const proxy = net.createServer({ allowHalfOpen: true }, (client) => {
  stats.conns++;
  const up = net.connect({ host: '127.0.0.1', port: bridgePort, allowHalfOpen: true });
  let serverFin = false;
  client.on('data', (d) => {
    if (serverFin) { stats.resetAfterFin++; client.resetAndDestroy(); up.destroy(); return; } // a dead pooled socket reused: aborted
    up.write(d);
  });
  up.on('data', (d) => { if (!client.destroyed) client.write(d); });
  up.on('end', () => { serverFin = true; stats.finSwallowed++; }); // the server's FIN never reaches the client
  client.on('end', () => up.end()); // the client's own close still goes through
  up.on('error', () => {});
  client.on('error', () => {});
  client.on('close', () => up.destroy());
});
await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
const proxyPort = proxy.address().port;

// ---- the client: keep-alive pool of 6, like Chromium's per-host limit ----
const agent = new http.Agent({ keepAlive: true, maxSockets: POOL, maxFreeSockets: POOL, keepAliveMsecs: 60_000 });
// Chromium ignores the server's `Keep-Alive: timeout=N` hint (Node's agent expires its idle socket by it): keep the idle
// socket pooled as Chromium does, and let only a FIN the client actually sees, or Connection: close, take it out.
agent.keepSocketAlive = (socket) => { socket.setKeepAlive(true, 60_000); socket.unref(); return true; };
const headers = { host: `127.0.0.1:${bridgePort}`, ...bridge.callerHeaders() };
const get = (p) => new Promise((resolve) => {
  const req = http.request({ host: '127.0.0.1', port: proxyPort, path: p, method: 'GET', agent, headers }, (res) => {
    const chunks = []; res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, connection: res.headers.connection || null, reused: req.reusedSocket }));
    res.on('error', (e) => resolve({ status: null, error: e.code || e.message, reused: req.reusedSocket }));
  });
  req.setTimeout(REQ_TIMEOUT_MS, () => req.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })));
  req.on('error', (e) => resolve({ status: null, error: e.code || e.message, reused: req.reusedSocket }));
  req.end();
});

const fill = await Promise.all(Array.from({ length: POOL }, () => get('/api/v1/state')));
check(`the pool fills: ${POOL} parallel reads through the proxy all answer 200`, fill.every((r) => r.status === 200), fill.map((r) => r.status));
const after = [];
for (let i = 0; i < AFTER; i++) {
  await wait(GAP_MS); // idle past the server's keep-alive: it closes its idle sockets; the proxy eats each FIN
  after.push(await get(i % 2 ? '/api/v1/state' : '/healthz'));
}
const failed = after.filter((r) => r.status !== 200);
console.log('after the idle gaps:', JSON.stringify(after), JSON.stringify(stats));
check(`${AFTER} requests after idle gaps longer than the server keep-alive all answer 200 (no request lands on a socket the server closed)`, failed.length === 0, { failed: failed.length, sample: failed.slice(0, 3), stats });
check('no request was sent on a socket whose FIN had been swallowed', stats.resetAfterFin === 0, stats);
check('every bridge answer says Connection: close (no idle pooled socket to go stale)', [...fill, ...after].filter((r) => r.status).every((r) => r.connection === 'close'), [...new Set([...fill, ...after].map((r) => r.connection))]);

agent.destroy();
proxy.close();
await bridge.close().catch(() => {});
upstream.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0; // no process.exit(): exiting with sockets still closing trips a libuv assert on Windows (async.c:76)
