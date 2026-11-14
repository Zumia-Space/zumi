// T-31 board-bridge self-heal, REAL sidecar (owner field report 14-11: "Could not connect to the live board
// (ERR_CONNECTION_ABORTED)" while the sidecar lived and no bridge port listened).
// Plain Node, no window, no network beyond 127.0.0.1. The sidecar runs in a TEST flavour (loopback mock upstream) with
// scripts/lib/bridge-kill-hook.mjs preloaded, which takes the live bridge's server down from inside the process.
// For each way down (close, accept error) it measures, at the OS (netstat) and over loopback:
//   1. the page the Board tab shows before: loaded through the single-use session URL;
//   2. the listener is gone after the kill (the field state), the process still runs;
//   3. the old Reload (webview.loadURL on the cached origin) fails: the Board tab's error line is printed;
//   4. the bridge comes back BY ITSELF (no rpc call) within the backoff;
//   5. the new Reload (board.liveOpen first) gets a live origin and the page loads;
// and finally that leaving live mode closes the bridge and nothing restarts it.
//   ZUMI_VAULT_EXE=<zumi-vault.exe> node scripts/check-tauri-board-bridge-heal.mjs
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIDECAR = path.join(ROOT, 'tauri', 'sidecar', 'main.mjs');
const HOOK = pathToFileURL(path.join(ROOT, 'scripts', 'lib', 'bridge-kill-hook.mjs')).href;
let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${detail ? '  ' + detail : ''}`); } };
const log = (m) => console.log(`  ${new Date().toISOString()} ${m}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const HELPER = process.env.ZUMI_VAULT_EXE ? path.resolve(process.env.ZUMI_VAULT_EXE) : null;
if (!HELPER || !fs.existsSync(HELPER)) { console.log('FAIL set ZUMI_VAULT_EXE to a built zumi-vault.exe'); process.exit(1); }
const work = fs.mkdtempSync(path.join(ROOT, '.tauri-check-tmp-heal-'));
const host = path.join(work, 'host');
fs.mkdirSync(host, { recursive: true });
fs.writeFileSync(path.join(host, 'flavour.json'), `${JSON.stringify({ v: 1, cloudBase: null, test: true, reflexEgress: false, ownerAdmin: false, boardMirror: null }, null, 2)}\n`);
fs.copyFileSync(HELPER, path.join(host, 'zumi-vault.exe'));
const dataDir = path.join(work, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const TRIGGER = path.join(work, 'kill-bridge');

const LIVE_CONNECT_FAILED = 'Could not connect to the live board ({error}). Check your network, then click "Reload".'; // i18n board.liveConnectFailed
const boardTabLine = (error) => LIVE_CONNECT_FAILED.replace('{error}', error);

const mock = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"tasks":[]}'); });
await new Promise((r) => mock.listen(0, '127.0.0.1', r));

function listenersFor(pid) {
  const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true });
  return out.split(/\r?\n/).map((l) => l.trim().split(/\s+/)).filter((p) => p.length >= 5 && p[3] === 'LISTENING' && p[4] === String(pid)).map((p) => Number(p[1].split(':').pop()));
}
async function until(pred, ms, step = 100) { const end = Date.now() + ms; while (Date.now() < end) { const v = await pred(); if (v) return v; await wait(step); } return null; }

/** GET over loopback, no redirect following. Resolves {status, headers} or {error: code}. */
function get(url, headers = {}) {
  return new Promise((resolve) => {
    const req = http.get(url, { headers: { connection: 'close', ...headers } }, (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers })); });
    req.on('error', (e) => resolve({ error: e.code || e.message }));
    req.setTimeout(5000, () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
  });
}
/** What the board webview does with liveOpen's answer: load openUrl (302 + caller cookie), then the page itself. */
async function loadBoard(r) {
  const first = await get(r.openUrl);
  if (first.error) return { error: first.error };
  const cookie = String((first.headers['set-cookie'] || [])[0] || '').split(';')[0];
  if (first.status !== 302 || !cookie) return { error: `session ${first.status}` };
  const page = await get(`${r.origin}/`, { cookie });
  return page.error ? { error: page.error } : { status: page.status, cookie };
}

const args = ['--import', HOOK, SIDECAR, '--data-dir', dataDir, '--no-voice-prefetch', '--vault-exe', path.join(host, 'zumi-vault.exe'), '--host-dir', host, '--flavour', path.join(host, 'flavour.json')];
const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ZUMI_BOARD_UPSTREAM: `http://127.0.0.1:${mock.address().port}`, ZUMI_TEST_BRIDGE_KILL_FILE: TRIGGER } });
log(`sidecar pid ${child.pid}`);
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
const rpc = (method, params = []) => new Promise((resolve) => { const id = nextId++; pending.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
/** board.liveOpen as the renderer sees it: a rejection settles as { error } (zumi-shim.js liveOpen). */
const liveOpen = async () => { const m = await rpc('board.liveOpen'); return m.error ? { error: String(m.error.message || m.error) } : m.result; };

try {
  await ready;
  const set = (await rpc('board.setSecretsOs', [{ user: 'heal-user', pass: 'heal-pass', token: '' }])).result;
  const mode = (await rpc('board.setMode', ['live'])).result;
  ok(set && set.ok && mode && mode.ok, 'setup: signed in (no PIN) and live', JSON.stringify({ set, mode }));

  for (const how of (process.env.HEAL_ORDER || 'close,error').split(',')) {
    const r1 = await liveOpen();
    if (r1.error) { ok(false, `${how}: board.liveOpen answers before the kill`, r1.error); continue; }
    const port1 = Number(new URL(r1.origin).port);
    const page1 = await loadBoard(r1);
    ok(page1.status === 200, `${how}: the Board tab loads the live page on ${r1.origin}`, JSON.stringify(page1));
    log(`${how}: listeners before kill ${JSON.stringify(listenersFor(child.pid))}`);

    fs.writeFileSync(TRIGGER, how);
    const killed = await until(() => { try { return fs.readFileSync(`${TRIGGER}.done`, 'utf8'); } catch { return null; } }, 3000);
    fs.rmSync(`${TRIGGER}.done`, { force: true });
    ok(Number(killed) === port1, `${how}: the hook took the bridge on ${port1} down inside the running sidecar`, String(killed));
    const after = listenersFor(child.pid);
    log(`${how}: listeners right after kill ${JSON.stringify(after)} (sidecar alive: ${child.exitCode === null})`);
    ok(!after.includes(port1) && child.exitCode === null, `${how}: field state reproduced: sidecar alive, port ${port1} no longer listening`);

    const oldReload = await get(`${r1.origin}/?embed=1`, { cookie: page1.cookie });
    log(`${how}: OLD Reload (loadURL on the cached origin) -> ${JSON.stringify(oldReload)}; Board tab: "${boardTabLine(oldReload.error ? `ERR_${oldReload.error}` : oldReload.status)}"`);
    ok(Boolean(oldReload.error), `${how}: the cached origin is dead (this is the Board tab error the owner saw)`);

    const healed = await until(() => listenersFor(child.pid).find((p) => p !== port1) || null, 6000, 200);
    log(`${how}: listeners once healed (waited up to 6 s, NO rpc call) ${JSON.stringify(listenersFor(child.pid))}`);
    ok(Boolean(healed), `${how}: the bridge restarted by itself (a new loopback listener, no rpc call)`, JSON.stringify(listenersFor(child.pid)));

    const r2 = await liveOpen();
    log(`${how}: NEW Reload asks board.liveOpen first -> ${r2.error ? `error ${r2.error}; Board tab: "${boardTabLine(r2.error)}"` : r2.origin}`);
    const page2 = r2.error ? { error: r2.error } : await loadBoard(r2);
    ok(!r2.error && page2.status === 200, `${how}: Reload via liveOpen gets a live origin and the page loads`, JSON.stringify({ r2: r2.error || r2.origin, page2 }));
    if (!r2.error) ok(r2.origin !== r1.origin, `${how}: the port changed (${port1} -> ${new URL(r2.origin).port}) and the reload uses the new one`);
  }

  const local = (await rpc('board.setMode', ['local'])).result;
  await wait(2500);
  ok(local && local.ok && listenersFor(child.pid).length === 0, 'leaving live mode closes the bridge and nothing restarts it (2.5 s)', JSON.stringify(listenersFor(child.pid)));
} finally {
  child.stdin.end();
  await until(() => child.exitCode !== null, 5000);
  if (child.exitCode === null) child.kill();
  mock.close();
  fs.rmSync(work, { recursive: true, force: true });
}
const bridgeLines = stderr.split(/\r?\n/).filter((l) => /\[board-live\]|bridge/i.test(l));
console.log(`  sidecar board log lines:\n${bridgeLines.map((l) => `    ${l}`).join('\n') || '    (none)'}`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
