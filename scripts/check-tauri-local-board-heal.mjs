// T-31 local-board self-heal (public 0.3.7), REAL sidecar. The public build has no live board; its Board tab is the LOCAL
// board (src/main/laneboard-host.mjs, served through the sidecar's openBoard). Before 0.3.7 that server was cached forever
// and had no 'error' listener after listen, so an accept error (libuv on Windows stops accepting: sleep/resume, adapter
// reset) crashed the whole sidecar, and a server that closed left the tab on a dead origin until an app restart.
// Plain Node, no window, loopback only, a temp data dir. scripts/lib/local-board-kill-hook.mjs is preloaded and takes the
// local board server down from inside the running sidecar. For each way down (close, accept error):
//   1. openBoard answers and the page loads;  2. the hook takes the server down;  3. the sidecar is still alive;
//   4. the server comes back BY ITSELF (no rpc call) within the backoff;  5. openBoard (what Reload asks first) answers a
//      live origin and the page loads.
// Plus (0.3.7 gate S1) 'seed': the server goes down during the first-run seed, before openLocalBoard returned.
//   node scripts/check-tauri-local-board-heal.mjs [<root with tauri/sidecar/main.mjs, e.g. an extracted installer payload>]
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.argv[2] || path.join(HERE, '..'));
const SIDECAR = path.join(ROOT, 'tauri', 'sidecar', 'main.mjs');
const HOOK = pathToFileURL(path.join(HERE, 'lib', 'local-board-kill-hook.mjs')).href;
let pass = 0, fail = 0;
const ok = (c, n, d = '') => { if (c) { pass++; console.log(`PASS ${n}`); } else { fail++; console.log(`FAIL ${n}${d ? '  ' + d : ''}`); } };
const log = (m) => console.log(`  ${new Date().toISOString()} ${m}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(pred, ms, step = 100) { const end = Date.now() + ms; while (Date.now() < end) { const v = await pred(); if (v) return v; await wait(step); } return null; }
function listenersFor(pid) {
  const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true });
  return out.split(/\r?\n/).map((l) => l.trim().split(/\s+/)).filter((p) => p.length >= 5 && p[3] === 'LISTENING' && p[4] === String(pid)).map((p) => Number(p[1].split(':').pop()));
}
function get(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { headers: { connection: 'close' } }, (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode })); });
    req.on('error', (e) => resolve({ error: e.code || e.message }));
    req.setTimeout(5000, () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
  });
}

async function run(how) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'zumi-localboard-heal-'));
  const dataDir = path.join(work, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const TRIGGER = path.join(work, 'kill');
  const env = { ...process.env, ZUMI_TEST_LOCALBOARD_KILL_FILE: TRIGGER, ...(how === 'seed' ? { ZUMI_TEST_LOCALBOARD_KILL_ON_FIRST_REQUEST: 'error' } : {}) };
  const child = spawn(process.execPath, ['--import', HOOK, SIDECAR, '--data-dir', dataDir, '--no-voice-prefetch'], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'], env });
  log(`${how}: sidecar pid ${child.pid} (${SIDECAR})`);
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  const pending = new Map();
  let nextId = 1, readyResolve;
  const ready = new Promise((r) => { readyResolve = r; });
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let m; try { m = JSON.parse(line); } catch { return; }
    if (m.method === 'ready') readyResolve();
    else if (m.id != null && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); p(m); }
  });
  const rpc = (method, params = []) => {
    if (child.exitCode !== null) return Promise.resolve({ error: { message: 'sidecar_exited' } });
    return new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      setTimeout(() => { if (pending.delete(id)) resolve({ error: { message: 'rpc_timeout' } }); }, 15000);
    });
  };
  const openBoard = async () => { const m = await rpc('openBoard'); return m.result || { error: m.error && m.error.message }; };
  try {
    await Promise.race([ready, wait(30000)]);
    if (how === 'seed') {
      // 0.3.7 gate S1: the server goes down during the first-run seed, before openLocalBoard returned to the sidecar.
      const r0 = await openBoard();
      await wait(500);
      log(`seed: first openBoard -> ${r0.origin || r0.error}; sidecar alive=${child.exitCode === null}`);
      ok(child.exitCode === null, 'seed: a server that goes down during the first-run seed does not crash the sidecar', `exitCode ${child.exitCode}`);
      const r1s = await openBoard();
      const page = r1s.origin ? await get(`${r1s.origin}/`) : { error: r1s.error || 'no origin' };
      log(`seed: openBoard again -> ${r1s.origin || r1s.error}; page ${JSON.stringify(page)}`);
      ok(page.status === 200, 'seed: the next openBoard (the tab, Reload) gets a live local board', JSON.stringify({ origin: r1s.origin, page }));
      return;
    }
    const r1 = await openBoard();
    const page1 = r1.origin ? await get(`${r1.origin}/`) : { error: r1.error || 'no origin' };
    ok(page1.status === 200, `${how}: openBoard answers and the local board page loads on ${r1.origin}`, JSON.stringify({ r1err: r1.error, page1 }));
    const port1 = r1.origin ? Number(new URL(r1.origin).port) : null;
    const others = listenersFor(child.pid).filter((p) => p !== port1); // the sidecar's other loopback listeners, if any
    fs.writeFileSync(TRIGGER, how);
    const killed = await until(() => { try { return fs.readFileSync(`${TRIGGER}.done`, 'utf8'); } catch { return null; } }, 3000);
    ok(port1 && Number(killed) === port1, `${how}: the hook took the local board server on ${port1} down inside the running sidecar`, String(killed));
    await wait(300);
    const alive = child.exitCode === null;
    log(`${how}: right after the kill: sidecar alive=${alive} exitCode=${child.exitCode} listeners=${alive ? JSON.stringify(listenersFor(child.pid)) : '-'}`);
    ok(alive, `${how}: the sidecar survives the local board server going down (no crash)`, `exitCode ${child.exitCode}`);
    const boardPorts = () => listenersFor(child.pid).filter((p) => !others.includes(p));
    const healed = alive ? await until(() => (child.exitCode === null && boardPorts().length ? boardPorts() : null), 6000, 200) : null;
    log(`${how}: listeners once healed (waited up to 6 s, NO rpc call) ${JSON.stringify(healed)}`);
    ok(Boolean(healed), `${how}: the local board server restarted by itself (a loopback listener again, no rpc call)`, JSON.stringify(healed));
    const r2 = await openBoard();
    const page2 = r2.origin ? await get(`${r2.origin}/`) : { error: r2.error || 'no origin' };
    log(`${how}: openBoard again (what Reload asks first) -> ${r2.origin || r2.error}; page ${JSON.stringify(page2)}`);
    ok(page2.status === 200, `${how}: Reload via openBoard gets a live local board and the page loads`, JSON.stringify({ origin: r2.origin, page2 }));
  } finally {
    if (child.exitCode === null) { child.stdin.end(); await until(() => child.exitCode !== null, 5000); if (child.exitCode === null) child.kill(); }
    const lines = stderr.split(/\r?\n/).filter((l) => /local board|openBoard|Unhandled|ENOTSOCK/i.test(l)).slice(0, 8);
    console.log(`  ${how}: sidecar board log lines:\n${lines.map((l) => `    ${l.slice(0, 200)}`).join('\n') || '    (none)'}`);
    fs.rmSync(work, { recursive: true, force: true });
  }
}
for (const how of (process.env.HEAL_ORDER || 'close,error,seed').split(',')) await run(how);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
