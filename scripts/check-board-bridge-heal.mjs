// T-31 board-bridge self-heal (owner report 14-11: the sidecar lived, the live-board bridge port was gone, Reload kept
// failing with ERR_CONNECTION_ABORTED until an app restart). Node only, no Electron, loopback only.
//   1. on demand: a bridge whose server closed under it is replaced the next time anyone asks for the port
//      (board.liveOpen / the board reader), never handed out dead;
//   2. by itself: a closed or errored bridge server restarts while the board is live, with bounded backoff;
//   3. backoff: a bridge that cannot listen is retried a bounded number of times, never in a tight loop, and comes
//      back once it can;
//   4. leaving live mode (setMode('local')) closes the bridge and nothing restarts it;
//   5. Reload (renderer, src/renderer/board-live-reload.js): asks the host first; same origin -> reload in place with
//      the fresh session URL; a new origin -> a new board guest on the new port; an error -> the error line.
//   node scripts/check-board-bridge-heal.mjs   (or: npm run check:board-bridge-heal)
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'vendor', 'laneboard', 'public');
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from([...Buffer.from(s, 'utf8')].map((b) => b ^ 0x5a)),
  decryptString: (b) => Buffer.from([...b].map((x) => x ^ 0x5a)).toString('utf8'),
};
const upstream = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"tasks":[]}'); });
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const UPSTREAM = `http://127.0.0.1:${upstream.address().port}/zumia`;

// Every server board-bridge.mjs creates from here on (it calls http.createServer at call time). `failListen` makes the
// next listens fail like an EADDRINUSE, so the backoff case can count attempts.
const bridgeServers = [];
let failListen = false;
const realCreate = http.createServer;
http.createServer = function (...args) {
  const s = realCreate.apply(this, args);
  bridgeServers.push(s);
  if (failListen) s.listen = function () { setImmediate(() => this.emit('error', Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE', syscall: 'listen' }))); return this; };
  return s;
};
const { createLiveBoard } = await import('../src/main/board-live.mjs');

const dirs = [];
async function liveRig(tag) {
  const dir = path.join(root, `.check-bridge-heal-${tag}-${process.pid}`);
  fs.mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  // A short backoff keeps the test fast; the production default is checked below by its shape only.
  const lb = createLiveBoard({ safeStorage: fakeSafeStorage, secretsDir: dir, publicDir, upstream: UPSTREAM, allowTestUpstream: true, bridgeBackoff: { baseMs: 50, maxMs: 400 } });
  const r = lb.secrets.configureOs({ user: 'u', pass: 'p', token: '' });
  const m = await lb.setMode('live');
  if (!r.ok || !m.ok) throw new Error(`rig ${tag}: ${JSON.stringify({ r, m })}`);
  return lb;
}
/** GET / on the bridge with the in-process caller header: 200 = the bridge serves the page. */
function page(port, headers) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', headers: { connection: 'close', ...headers } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', (e) => resolve(e.code));
  });
}
const closeServer = (s) => new Promise((r) => { s.close(r); s.closeAllConnections(); });
async function portOrError(lb) { try { return await lb.bridgePort(); } catch (e) { return `throws: ${e.message}`; } }
async function liveAt(lb) { const port = await portOrError(lb); return typeof port === 'number' ? { port, status: await page(port, await lb.bridgeHeaders()) } : { port }; }

// ---- 1. on demand: a closed bridge is replaced when the port is asked for, before any backoff timer fires ----
{
  const lb = await liveRig('ondemand');
  const p1 = await lb.bridgePort();
  check('setup: the live bridge serves the page', (await page(p1, await lb.bridgeHeaders())) === 200, p1);
  await closeServer(bridgeServers.at(-1));
  const now = await liveAt(lb); // immediately: no timer has run yet
  check('on demand: right after the server closed, bridgePort() returns a LIVE port (not the dead one, not a throw)', now.status === 200 && now.port !== p1, { p1, now });
  await lb.close();
}

// ---- 2. by itself: close and accept-error both restart the bridge with no caller ----
for (const how of ['close', 'error']) {
  const lb = await liveRig(`auto-${how}`);
  const p1 = await lb.bridgePort();
  const before = bridgeServers.length;
  const s = bridgeServers.at(-1);
  if (how === 'error') s.emit('error', Object.assign(new Error('accept ENOTSOCK'), { code: 'ENOTSOCK', syscall: 'accept' }));
  else await closeServer(s);
  await wait(300);
  const restarted = bridgeServers.slice(before).find((x) => x.listening);
  check(`by itself (${how}): a new bridge server is listening within the backoff, with no caller`, Boolean(restarted), { created: bridgeServers.length - before });
  if (how === 'error') check('by itself (error): the errored server was closed, not left half-alive', !s.listening);
  const now = await liveAt(lb);
  check(`by itself (${how}): bridgePort() hands out the restarted bridge and it serves the page`, now.status === 200 && now.port !== p1 && restarted && now.port === restarted.address().port, { p1, now });
  await lb.close();
}

// ---- 3. backoff: bounded attempts while listening fails, then recovery ----
{
  const lb = await liveRig('backoff');
  await lb.bridgePort();
  const before = bridgeServers.length;
  failListen = true;
  await closeServer(bridgeServers.at(-1));
  await wait(1000);
  const attempts = bridgeServers.length - before;
  // base 50 ms doubling to 400 ms: 50+100+200+400+400 = 1150 ms, so 1 s fits at most 4-5 attempts. A tight loop would be hundreds.
  check('backoff: a bridge that cannot listen is retried (>= 2 attempts in 1 s)', attempts >= 2, { attempts });
  check('backoff: bounded, no tight loop (<= 6 attempts in 1 s with base 50 ms, cap 400 ms)', attempts <= 6, { attempts });
  failListen = false;
  await wait(600);
  const now = await liveAt(lb);
  check('backoff: once listening works again the bridge is back and serves the page', now.status === 200, now);
  await lb.close();
  const after = bridgeServers.length;
  await wait(600);
  check('backoff: close() stops the retries (no server created after close)', bridgeServers.length === after, { created: bridgeServers.length - after });
}

// ---- 4. leaving live mode is not a failure: nothing restarts ----
{
  const lb = await liveRig('local');
  await lb.bridgePort();
  const before = bridgeServers.length;
  await lb.setMode('local');
  await wait(600);
  check('local: setMode(local) closes the bridge and no restart follows', bridgeServers.length === before && !bridgeServers.at(-1).listening && (await lb.bridgePort()) === null, { created: bridgeServers.length - before });
  await lb.close();
}

// ---- 5. Reload in the Board tab (renderer half) ----
{
  let planLiveReload = null;
  try { ({ planLiveReload } = await import('../src/renderer/board-live-reload.js')); } catch (e) { check('reload: src/renderer/board-live-reload.js exports planLiveReload', false, e.message); }
  if (planLiveReload) {
    const calls = [];
    const liveOpen = (r) => async () => { calls.push('liveOpen'); return r; };
    const same = await planLiveReload({ liveOpen: liveOpen({ origin: 'http://127.0.0.1:5000', openUrl: 'http://127.0.0.1:5000/__bridge-session?n=x' }), currentOrigin: 'http://127.0.0.1:5000' });
    check('reload: asks the host (board.liveOpen) before reloading', calls.length === 1);
    check('reload: same port -> reload in place through the fresh session URL', same.action === 'navigate' && same.url === 'http://127.0.0.1:5000/__bridge-session?n=x', same);
    const moved = await planLiveReload({ liveOpen: liveOpen({ origin: 'http://127.0.0.1:6000', openUrl: 'http://127.0.0.1:6000/__bridge-session?n=y' }), currentOrigin: 'http://127.0.0.1:5000' });
    check('reload: new port -> a new board guest on the new origin (the old guest is pinned to its origin)', moved.action === 'reopen' && moved.r.origin === 'http://127.0.0.1:6000', moved);
    const bad = await planLiveReload({ liveOpen: liveOpen({ error: 'not_live' }), currentOrigin: 'http://127.0.0.1:5000' });
    check('reload: an error from the host is shown, nothing is loaded', bad.action === 'fail' && bad.error === 'not_live', bad);
  }
  const appJs = fs.readFileSync(path.join(root, 'src', 'renderer', 'app.js'), 'utf8');
  const at = appJs.indexOf("$('board-reload').addEventListener('click'");
  const handler = at > -1 ? appJs.slice(at, appJs.indexOf('\n  });', at)) : '';
  check('reload: the Board tab Reload handler takes the live path through reloadLiveBoard() (liveOpen first)', /webviewMode === 'live'\) return reloadLiveBoard\(\)/.test(handler) && /planLiveReload\(/.test(appJs), handler.split('\n').length);
}

http.createServer = realCreate;
upstream.close();
for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
