// T-31 0.2.10: Board > Stats goes through the bridge. The vendored page reads GET /api/stats (public/app.js) -- a route
// outside /api/v1/ -- so the bridge must proxy exactly that one read-only route and nothing broader.
// Node only, stub upstream, no Electron, no real board:
//   node scripts/check-board-bridge-stats.mjs   (or: npm run check:board-bridge-stats)
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBridge as rawCreateBridge } from '../src/main/board-bridge.mjs';
// Caller-auth: requests carry the per-launch secret like the app's own readers (board-bridge.mjs callerHeaders()).
const bridgeTokens = new Map();
const createBridge = (o) => { const b = rawCreateBridge(o); b.port().then((p) => bridgeTokens.set(p, b.callerHeaders())); return b; };

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'vendor', 'laneboard', 'public');
let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); } };

const STATS = { generated_at: '2026-10-25T00:00:00Z', tasks: { total: 7, open: 3 }, marker: 'stub-stats-doc' };
const seen = []; // every request the stub upstream received
const upstream = http.createServer((req, res) => {
  seen.push({ method: req.method, url: req.url, auth: req.headers.authorization || null, token: req.headers['x-laneboard-token'] || null });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(req.url.startsWith('/api/stats') ? STATS : { stub: req.url }));
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const upstreamOrigin = `http://127.0.0.1:${upstream.address().port}`;

function request(port, method, p) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { connection: 'close', ...(bridgeTokens.get(port) || {}) } }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let j = null; try { j = JSON.parse(text); } catch { /* not json */ } resolve({ status: res.statusCode, text, json: j }); });
    });
    r.on('error', reject); r.end();
  });
}
const reached = (fn) => seen.filter(fn).length;

let bridge, liveBridge, lockedBridge;
try {
  // local mode: bearer
  bridge = createBridge({ upstreamOrigin, getToken: () => 'owner-secret-token', publicDir });
  const port = await bridge.port();

  const get = await request(port, 'GET', '/api/stats');
  ok(get.status === 200 && get.json && get.json.marker === STATS.marker && get.json.tasks.total === 7, 'GET /api/stats returns the upstream numbers', `status=${get.status} body=${get.text.slice(0, 80)}`);
  const up = seen.find((s) => s.url === '/api/stats');
  ok(up && up.method === 'GET' && up.auth === 'Bearer owner-secret-token', 'the bridge adds the bearer upstream (local mode)', JSON.stringify(up));
  ok(!get.text.includes('owner-secret-token'), 'the token is not in the response');

  const before = seen.length;
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const r = await request(port, method, '/api/stats');
    ok(r.status >= 400 && r.status < 500, `${method} /api/stats is refused`, `status=${r.status}`);
  }
  ok(seen.length === before, 'no non-GET /api/stats ever reached the upstream', JSON.stringify(seen.slice(before)));

  // unlisted routes stay refused and are never forwarded
  const UNLISTED = ['/api/statsx', '/api/stats/extra', '/api/stats%2Fx', '/api/other', '/api/tokens', '/api/stat'];
  const before2 = seen.length;
  for (const p of UNLISTED) {
    const r = await request(port, 'GET', p);
    ok(r.status === 404 || r.status === 403, `GET ${p} is refused`, `status=${r.status}`);
  }
  ok(seen.length === before2, 'no unlisted route reached the upstream', JSON.stringify(seen.slice(before2)));

  // live mode: Basic in Authorization, raw token in X-Laneboard-Token
  liveBridge = createBridge({ upstreamOrigin, getToken: () => 'owner-secret-token', getBasicAuth: () => ({ user: 'u', pass: 'p' }), publicDir });
  const lp = await liveBridge.port();
  const lg = await request(lp, 'GET', '/api/stats');
  const lup = seen.filter((s) => s.url === '/api/stats').pop();
  ok(lg.status === 200 && lup && lup.auth === `Basic ${Buffer.from('u:p').toString('base64')}` && lup.token === 'owner-secret-token', 'live mode: same auth handling as the other reads (Basic + X-Laneboard-Token)', JSON.stringify(lup));

  // locked: no credential -> 401, nothing forwarded
  lockedBridge = createBridge({ upstreamOrigin, getToken: () => null, publicDir });
  const kp = await lockedBridge.port();
  const n = reached((s) => s.url === '/api/stats');
  const lk = await request(kp, 'GET', '/api/stats');
  ok(lk.status === 401 && reached((s) => s.url === '/api/stats') === n, 'locked bridge: GET /api/stats -> 401, nothing forwarded', `status=${lk.status}`);
} finally {
  for (const b of [bridge, liveBridge, lockedBridge]) if (b) await b.close();
  await new Promise((r) => upstream.close(r));
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
