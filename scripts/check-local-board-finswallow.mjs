// T-31 local-board FIN-swallow (the bridge root cause of 14-11, applied to the LOCAL board server that public users run):
// a loopback filter driver (Avast and others) can eat the FIN a server sends when it closes an idle keep-alive socket. The
// client then keeps the socket pooled; once Chromium's per-host pool (6) is full of such half-dead sockets, the next load or
// XHR on one fails as ERR_CONNECTION_ABORTED. src/main/laneboard-host.mjs serves the Board guest with Node's default
// keep-alive, so it has the same exposure as the bridge had before Connection: close (check-board-bridge-finswallow.mjs).
//
// Repro, Node only, loopback only, same method as check-board-bridge-finswallow.mjs: the REAL local board (openLocalBoard,
// temp root), a TCP proxy that swallows the server's FIN, a keep-alive client pool capped at 6. Fill the pool, then 8
// requests with idle gaps longer than the server's keep-alive (compressed to 1 s on the returned server). Every request
// must get its 200, and every answer must say Connection: close.
//   node scripts/check-local-board-finswallow.mjs
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const POOL = 6, AFTER = 8, IDLE_CLOSE_MS = 1000, GAP_MS = 3000, REQ_TIMEOUT_MS = 5000;
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const { openLocalBoard } = await import('../src/main/laneboard-host.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zumi-local-finswallow-'));
const b = await openLocalBoard({ laneboardDir: path.join(root, 'vendor', 'laneboard'), root: tmp, sampleFixture: path.join(root, 'src', 'main', 'sample-board.json') });
const boardPort = b.port;
const keepAliveWas = b.server.keepAliveTimeout;
if (b.server.keepAliveTimeout > IDLE_CLOSE_MS) b.server.keepAliveTimeout = IDLE_CLOSE_MS;
console.log(`local board on ${boardPort}, keepAliveTimeout ${keepAliveWas} ms -> ${b.server.keepAliveTimeout} ms`);
const ownerToken = fs.readFileSync(path.join(b.dataDir, 'owner.token'), 'utf8').trim();

// ---- the FIN-swallowing proxy ----
const stats = { conns: 0, finSwallowed: 0, resetAfterFin: 0 };
const proxy = net.createServer({ allowHalfOpen: true }, (client) => {
  stats.conns++;
  const up = net.connect({ host: '127.0.0.1', port: boardPort, allowHalfOpen: true });
  let serverFin = false;
  client.on('data', (d) => {
    if (serverFin) { stats.resetAfterFin++; client.resetAndDestroy(); up.destroy(); return; } // a dead pooled socket reused: aborted
    up.write(d);
  });
  up.on('data', (d) => { if (!client.destroyed) client.write(d); });
  up.on('end', () => { serverFin = true; stats.finSwallowed++; }); // the server's FIN never reaches the client
  client.on('end', () => up.end());
  up.on('error', () => {});
  client.on('error', () => {});
  client.on('close', () => up.destroy());
});
await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
const proxyPort = proxy.address().port;

// ---- the client: keep-alive pool of 6, idle sockets kept as Chromium keeps them ----
const agent = new http.Agent({ keepAlive: true, maxSockets: POOL, maxFreeSockets: POOL, keepAliveMsecs: 60_000 });
agent.keepSocketAlive = (socket) => { socket.setKeepAlive(true, 60_000); socket.unref(); return true; };
const headers = { host: `127.0.0.1:${boardPort}`, authorization: `Bearer ${ownerToken}` };
const get = (p) => new Promise((resolve) => {
  const req = http.request({ host: '127.0.0.1', port: proxyPort, path: p, method: 'GET', agent, headers }, (res) => {
    res.resume();
    res.on('end', () => resolve({ status: res.statusCode, connection: res.headers.connection || null, reused: req.reusedSocket }));
    res.on('error', (e) => resolve({ status: null, error: e.code || e.message, reused: req.reusedSocket }));
  });
  req.setTimeout(REQ_TIMEOUT_MS, () => req.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })));
  req.on('error', (e) => resolve({ status: null, error: e.code || e.message, reused: req.reusedSocket }));
  req.end();
});

try {
  const fill = await Promise.all(Array.from({ length: POOL }, () => get('/api/v1/state')));
  check(`the pool fills: ${POOL} parallel reads through the proxy all answer 200`, fill.every((r) => r.status === 200), fill.map((r) => r.status));
  const after = [];
  for (let i = 0; i < AFTER; i++) {
    await wait(GAP_MS); // idle past the server's keep-alive: it closes its idle sockets; the proxy eats each FIN
    after.push(await get(i % 2 ? '/api/v1/state' : '/'));
  }
  const failed = after.filter((r) => r.status !== 200);
  console.log('after the idle gaps:', JSON.stringify(after), JSON.stringify(stats));
  check(`${AFTER} requests after idle gaps longer than the server keep-alive all answer 200 (no request lands on a socket the server closed)`, failed.length === 0, { failed: failed.length, sample: failed.slice(0, 3), stats });
  check('no request was sent on a socket whose FIN had been swallowed', stats.resetAfterFin === 0, stats);
  check('every local board answer says Connection: close (no idle pooled socket to go stale)', [...fill, ...after].filter((r) => r.status).every((r) => r.connection === 'close'), [...new Set([...fill, ...after].map((r) => r.connection))]);
  const forbidden = await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: boardPort, path: '/', method: 'GET', headers: { host: 'evil.example' } }, (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode, connection: res.headers.connection || null })); });
    req.on('error', (e) => resolve({ error: e.code }));
    req.end();
  });
  check('the forbidden-host answer is Connection: close too', forbidden.status === 403 && forbidden.connection === 'close', forbidden);
} finally {
  agent.destroy();
  proxy.close();
  b.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0; // no process.exit(): exiting with sockets still closing trips a libuv assert on Windows (async.c:76)
