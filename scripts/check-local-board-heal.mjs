// T-31 local-board self-heal (public 0.3.7). Node only, loopback only, temp dirs. The public Board tab is the LOCAL board
// (src/main/laneboard-host.mjs). Same pattern as the live bridge (check-board-bridge-heal.mjs):
//   1. an 'error' after listen (Windows accept error) never reaches the process as an unhandled 'error' event: the server
//      closes, alive() turns false and onDown is called once;
//   2. a server that closed under the host is reported through onDown once; the host's own close() is not;
//   3. the sidecar drops a dead cached board and restarts it (tauri/sidecar/main.mjs), with bounded backoff;
//   4. Reload in local mode asks the host first (zumi.openBoard) instead of re-loading the cached origin.
//   node scripts/check-local-board-heal.mjs   (or: npm run check:local-board-heal)
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (url) => new Promise((resolve) => {
  const req = http.get(url, { headers: { connection: 'close' } }, (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode })); });
  req.on('error', (e) => resolve({ error: e.code || e.message }));
});
const { openLocalBoard } = await import('../src/main/laneboard-host.mjs');
const laneboardDir = path.join(root, 'vendor', 'laneboard');
const sampleFixture = path.join(root, 'src', 'main', 'sample-board.json');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zumi-localboard-unit-'));

async function open(name) {
  const downs = [];
  const b = await openLocalBoard({ laneboardDir, root: path.join(tmp, name), sampleFixture, onDown: (err) => downs.push(err ? err.code || err.message : null) });
  return { b, downs };
}

try {
  // 1. accept error after listen
  {
    const { b, downs } = await open('error');
    check('error: the board opens and serves its page', (await get(`${b.origin}/`)).status === 200);
    check('error: alive() is true while listening', typeof b.alive === 'function' && b.alive() === true);
    let threw = null;
    try { b.server.emit('error', Object.assign(new Error('accept ENOTSOCK'), { code: 'ENOTSOCK', syscall: 'accept' })); } catch (e) { threw = e.code || e.message; }
    check('error: an accept error after listen is handled (no unhandled \'error\' event that kills the sidecar)', threw === null, threw);
    await wait(100);
    check('error: the half-dead listener is closed', b.server.listening === false);
    check('error: onDown is called once, with the error code', downs.length === 1 && downs[0] === 'ENOTSOCK', downs);
    check('error: alive() is false afterwards', typeof b.alive === 'function' && b.alive() === false);
    b.close();
    await wait(50);
    check('error: the host closing the dead board later does not call onDown again', downs.length === 1, downs);
  }
  // 2. closed under the host vs closed by the host
  {
    const { b, downs } = await open('close');
    b.server.close(); b.server.closeAllConnections();
    await wait(100);
    check('close: a server closed under the host calls onDown once (no error)', downs.length === 1 && downs[0] === null, downs);
    check('close: alive() is false', typeof b.alive === 'function' && b.alive() === false);
    b.close();
    const { b: b2, downs: d2 } = await open('own-close');
    b2.close();
    await wait(100);
    check('own close: the host\'s own close() does not call onDown', d2.length === 0, d2);
  }
  // 2b. (0.3.7 gate S2) an open that fails after the Laneboard store was opened closes the store and the server: the
  // restart loop retries once per backoff step, and each failed try used to leak the journal and mailbox handles.
  // A stand-in Laneboard core counts close() calls and the servers it made; its seed throws on demand.
  {
    const fake = path.join(tmp, 'fake-laneboard');
    fs.mkdirSync(path.join(fake, 'src'), { recursive: true });
    fs.mkdirSync(path.join(fake, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(fake, 'src', 'board.mjs'), `import fs from 'node:fs'; import path from 'node:path';
export function createBoard({ dataDir }) { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(path.join(dataDir, 'owner.token'), 't');
  return { state: { seq: 1 }, close() { globalThis.__fakeBoardCloses = (globalThis.__fakeBoardCloses || 0) + 1; } }; }\n`);
    fs.writeFileSync(path.join(fake, 'src', 'server.mjs'), `import http from 'node:http';
export function createServer() { return http.createServer((q, r) => r.end('ok')); }
`);
    // every server laneboard-host.mjs itself creates (it calls http.createServer at open time)
    const made = [];
    const realCreate = http.createServer;
    http.createServer = function (...args) { const srv = realCreate.apply(this, args); made.push(srv); return srv; };
    fs.writeFileSync(path.join(fake, 'scripts', 'seed.mjs'), `export async function seed() { if (globalThis.__fakeSeedThrows) throw Object.assign(new Error('seed failed'), { code: 'ECONNRESET' }); }\n`);
    const tryOpen = async (name, opts) => {
      globalThis.__fakeBoardCloses = 0;
      const downs = [];
      let err = null;
      try { await openLocalBoard({ laneboardDir: fake, root: path.join(tmp, name), sampleFixture, onDown: (e) => downs.push(e ? e.code || e.message : null), ...opts }); } catch (e) { err = e.code || e.message; }
      await wait(50);
      return { err, downs, closes: globalThis.__fakeBoardCloses, listening: made.filter((srv) => srv.listening).length };
    };
    globalThis.__fakeSeedThrows = true;
    const seedFail = await tryOpen('seed-fail', {});
    globalThis.__fakeSeedThrows = false;
    check('S2 seed fails: the open rejects', seedFail.err === 'ECONNRESET', seedFail);
    check('S2 seed fails: the Laneboard store is closed (no leaked journal/mailbox handles)', seedFail.closes === 1, seedFail);
    check('S2 seed fails: no server is left listening, and the host is not told "down" for a board it never got', seedFail.listening === 0 && seedFail.downs.length === 0, seedFail);
    for (const srv of made) if (srv.listening) srv.close(); // each case starts with nothing listening
    const listenFail = await tryOpen('listen-fail', { port: 70000 }); // not EADDRINUSE: no fallback to port 0, the open throws
    check('S2 listen fails (not EADDRINUSE): the open rejects and the store is closed', Boolean(listenFail.err) && listenFail.closes === 1 && listenFail.listening === 0, listenFail);
    for (const srv of made) if (srv.listening) srv.close();
    const good = await tryOpen('fake-ok', {});
    check('S2 control: a good open keeps the store open', good.err === null && good.closes === 0 && good.listening === 1, good);
    for (const srv of made) if (srv.listening) srv.close();
    http.createServer = realCreate;
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// 3. the sidecar: a dead board is dropped (on demand and by itself), its store closed, and restarted with bounded backoff
const main = fs.readFileSync(path.join(root, 'tauri', 'sidecar', 'main.mjs'), 'utf8');
check('sidecar: openLocalBoard gets an onDown that drops the cached board', /openLocalBoard\(\{[^}]*onDown:/.test(main) && /function localBoardDown\(/.test(main));
check('sidecar: openBoard replaces a cached board that is no longer listening', /if \(board && !board\.alive\(\)\)/.test(main));
check('sidecar: restart backoff is bounded (doubling, capped)', /Math\.min\(BOARD_BACKOFF\.baseMs \* 2 \*\* boardRestartFails, BOARD_BACKOFF\.maxMs\)/.test(main));

// 4. renderer: local Reload asks openBoard first (planLiveReload with zumi.openBoard), so a dead origin is never re-loaded blind
const appJs = fs.readFileSync(path.join(root, 'src', 'renderer', 'app.js'), 'utf8');
const at = appJs.indexOf("$('board-reload').addEventListener('click'");
const handler = at >= 0 ? appJs.slice(at, appJs.indexOf('});', at)) : '';
check('reload: local Reload goes through reloadLocalInPlace() (openBoard first) before the gated re-open', /if \(webview && webviewMode === 'local' && await reloadLocalInPlace\(\)\) return null;/.test(handler) && /planLiveReload\(\{ liveOpen: \(\) => zumi\.openBoard\(\)/.test(appJs), handler.split('\n').length);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
