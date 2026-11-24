// T-31 local-board self-heal: the restart BACKOFF, measured on the REAL sidecar (GATE-OPUS-ALPHA8 S2: the bound was only checked
// by a regex, and a "no backoff" mutation, an immediate restart loop, passed every check). Plain Node, no window, loopback only,
// a temp data dir. scripts/lib/local-board-storm-hook.mjs makes every local board server fail with the Windows accept error
// 300 ms after it listens, so the sidecar has to restart it again and again for about 68 s. Asserted:
//   1. the sidecar survives the storm (no exit, no unhandled 'error');
//   2. the wait between a fault and the next listen follows the backoff, 1 s doubling to the 30 s cap: 1, 2, 4, 8, 16, 30 s,
//      each within [want - 0.1 s, want + 1.5 s]. Removing the backoff or the cap turns this red;
//   3. at most one local board listener at a time (netstat, sampled every second), and every server carries exactly one
//      'error' and one 'close' handler (no handler leak across restarts);
//   4. after the storm, openBoard (what Reload asks first) still answers an origin.
//   node scripts/check-tauri-local-board-backoff.mjs [<root with tauri/sidecar/main.mjs>]   (or: npm run check:tauri-local-board-backoff)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.argv[2] || path.join(HERE, '..'));
const SIDECAR = path.join(ROOT, 'tauri', 'sidecar', 'main.mjs');
const HOOK = path.join(HERE, 'lib', 'local-board-storm-hook.mjs');
const { STORM_FAULT_MS } = await import(pathToFileURL(HOOK).href);
const WANT_MS = [1000, 2000, 4000, 8000, 16000, 30000]; // tauri/sidecar/main.mjs BOARD_BACKOFF: 1 s doubling, 30 s cap
const STORM_MS = WANT_MS.reduce((a, b) => a + b, 0) + WANT_MS.length * STORM_FAULT_MS + 6000;
let pass = 0, fail = 0;
const ok = (c, n, d = '') => { if (c) { pass++; console.log(`PASS ${n}`); } else { fail++; console.log(`FAIL ${n}${d ? '  ' + d : ''}`); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const listenersFor = (pid) => execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/)
  .map((l) => l.trim().split(/\s+/)).filter((p) => p.length >= 5 && p[3] === 'LISTENING' && p[4] === String(pid)).map((p) => Number(p[1].split(':').pop()));

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'zumi-localboard-backoff-'));
const dataDir = path.join(work, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const LOG = path.join(work, 'storm.log');
const child = spawn(process.execPath, ['--import', pathToFileURL(HOOK).href, SIDECAR, '--data-dir', dataDir, '--no-voice-prefetch'],
  { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ZUMI_TEST_LOCALBOARD_STORM_LOG: LOG } });
console.log(`  sidecar pid ${child.pid} (${SIDECAR}), storm ${Math.round(STORM_MS / 1000)} s`);
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
const rpc = (method) => new Promise((resolve) => {
  if (child.exitCode !== null) return resolve({ error: { message: 'sidecar_exited' } });
  const id = nextId++;
  pending.set(id, resolve);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: [] }) + '\n');
  setTimeout(() => { if (pending.delete(id)) resolve({ error: { message: 'rpc_timeout' } }); }, 15000);
});
try {
  await Promise.race([ready, wait(30000)]);
  const before = listenersFor(child.pid);
  const first = await rpc('openBoard');
  ok(Boolean(first.result && first.result.origin), 'openBoard answers before the storm', JSON.stringify(first.error || {}));
  const t0 = Date.now();
  let maxBoard = 0;
  while (Date.now() - t0 < STORM_MS && child.exitCode === null) {
    await wait(1000);
    maxBoard = Math.max(maxBoard, listenersFor(child.pid).filter((p) => !before.includes(p)).length);
  }
  ok(child.exitCode === null && !/Unhandled|ERR_UNHANDLED_ERROR/.test(stderr), '1. the sidecar survives a persistent accept-error storm', `exitCode ${child.exitCode}`);
  const ev = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const listens = ev.filter((e) => e.ev === 'listen').map((e) => e.at);
  const faults = ev.filter((e) => e.ev === 'fault');
  // wait = the next listen minus the fault that took the previous server down (the hook's own 300 ms is not backoff)
  const waits = faults.map((f) => listens.find((t) => t > f.at)).map((next, i) => (next ? next - faults[i].at : null)).filter((w) => w !== null);
  const got = waits.slice(0, WANT_MS.length);
  const inBand = got.length === WANT_MS.length && got.every((w, i) => w >= WANT_MS[i] - 100 && w <= WANT_MS[i] + 1500);
  ok(inBand, '2. restarts follow the backoff: 1, 2, 4, 8, 16, 30 s (1 s doubling, 30 s cap)', JSON.stringify({ waitsMs: waits.slice(0, 12), restarts: waits.length, wantMs: WANT_MS }));
  console.log(`  waits between a fault and the next listen (ms): ${JSON.stringify(waits.slice(0, 12))}${waits.length > 12 ? ` ... (${waits.length})` : ''}`);
  const handlers = [...new Set(faults.map((f) => `error=${f.errL} close=${f.closeL}`))];
  ok(maxBoard <= 1 && handlers.length === 1 && handlers[0] === 'error=1 close=1', '3. at most one board listener at a time, one error and one close handler per server', JSON.stringify({ maxBoard, handlers }));
  const after = await rpc('openBoard');
  ok(Boolean(after.result && after.result.origin), '4. openBoard (what Reload asks first) answers after the storm', JSON.stringify(after.error || {}));
} finally {
  if (child.exitCode === null) { child.stdin.end(); for (let i = 0; i < 50 && child.exitCode === null; i++) await wait(100); if (child.exitCode === null) child.kill(); }
  fs.rmSync(work, { recursive: true, force: true });
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
