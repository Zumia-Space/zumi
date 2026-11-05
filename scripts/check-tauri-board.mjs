// T-31 Tauri parity step 10a: the live board in the sidecar (board-host.mjs + board-live/secrets/bridge as-is).
// Plain Node, no Electron, no window, NO network: the only upstream ever named is a loopback mock on 127.0.0.1, and the
// real sidecar is always started in the PUBLIC flavour unless a section says otherwise, which must never even read the
// test override.
//
//   node scripts/check-tauri-board.mjs
//
//   1. the upstream rule: the test-only ZUMI_BOARD_UPSTREAM override is honoured only in the test flavour
//      (resolveBoardUpstream); a public flavour with the env planted stays on LIVE_UPSTREAM, and a non-loopback
//      override in a test flavour is refused by createLiveBoard (falls back to the real origin);
//   2. the real sidecar, public flavour, env planted + a loopback mock listening: board.status/setSecrets, lock/unlock,
//      setSecretsOs answer Electron's shapes, the mock sees ZERO requests, and the user/pass/token/PIN sentinels appear
//      in no rpc reply, no event payload and no stderr line;
//   3. PIN toggle, mode and the lock triggers (10a-2) over the real rpc;
//   4-9. 10a-3: the board golden, then the five Electron-era board checks re-run through the sidecar path:
//      check-board-live (secrets/backoff/token-optional/mode gate), check-board-bridge (pinned page, guards, auth
//      headers, channel allowlists, state drop, redirects), check-board-pin-toggle (ON<->OFF re-seal, edge cases,
//      restart), check-owner-board (the ownerOps gate the renderer half relies on) and check-board-aware (the digest
//      path over the sidecar's real bridge + the chat-host wiring).
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import { LIVE_ORIGIN, LIVE_UPSTREAM } from '../src/main/board-live.mjs';
import { buildBoardDigest, unavailableDigestText } from '../src/main/board-digest.mjs';
import { createBoardReader } from '../src/main/board-reader.mjs';
import { createSecretsController, IDLE_LOCK_MS as ELECTRON_IDLE_LOCK_MS } from '../src/main/board-secrets.mjs';
import { FLAVOURS } from '../tauri/sidecar/flavour.mjs';
import { BOARD_UPSTREAM_ENV, BOARD_IDLE_LOCK_MS, boardUpstream, createBoardHost } from '../tauri/sidecar/board-host.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIDECAR = path.join(ROOT, 'tauri', 'sidecar', 'main.mjs');
const TARGET = path.join(ROOT, 'tauri', 'src-tauri', 'target');
let pass = 0;
let fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${detail ? '  ' + detail : ''}`); } };
const stable = (v) => JSON.stringify(v);

const TMP_ROOT = path.join(ROOT, '.tauri-check-tmp');
fs.mkdirSync(TMP_ROOT, { recursive: true });
const work = fs.mkdtempSync(path.join(TMP_ROOT, 'board-'));
const freshDir = (name, initial = null) => {
  const d = path.join(work, name);
  fs.mkdirSync(d, { recursive: true });
  if (initial) fs.writeFileSync(path.join(d, 'settings.json'), JSON.stringify(initial));
  return d;
};
const fakeSafe = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`enc:${s}`, 'utf8'),
  decryptString: (b) => b.toString('utf8').replace(/^enc:/, ''),
};

// The real vault helper (built by cargo; check-tauri-vault needs it too). The sentinel test must run the REAL
// safeStorage path, not a fake, or "the secrets never leave the process" would be an untested claim.
function findHelper() {
  if (process.env.ZUMI_VAULT_EXE) return path.resolve(process.env.ZUMI_VAULT_EXE);
  const found = ['release', 'debug'].map((p) => path.join(TARGET, p, 'zumi-vault.exe')).filter((p) => fs.existsSync(p));
  found.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return found[0] || null;
}
const HELPER = findHelper();
const HAVE_VAULT = Boolean(HELPER) && process.platform === 'win32';

// ---------------------------------------------------------------- 1. the upstream rule
{
  const env = { [BOARD_UPSTREAM_ENV]: 'http://127.0.0.1:54321' };
  const pub = boardUpstream({ flavour: { name: 'public', values: FLAVOURS.public }, env });
  ok(pub.upstream === LIVE_UPSTREAM && pub.allowTestUpstream === false, 'public flavour: a planted loopback ZUMI_BOARD_UPSTREAM is refused, the real upstream wins', stable(pub));

  const test = boardUpstream({ flavour: { name: 'owner', values: FLAVOURS.owner }, env });
  ok(test.upstream === 'http://127.0.0.1:54321' && test.allowTestUpstream === true, 'test flavour: the loopback override is honoured', stable(test));

  const noEnv = boardUpstream({ flavour: { name: 'owner', values: FLAVOURS.owner }, env: {} });
  ok(noEnv.upstream === LIVE_UPSTREAM && noEnv.allowTestUpstream === false, 'test flavour with no env var: still the real upstream', stable(noEnv));

  const settings = () => ({});
  const saveSettings = () => ({});
  const log = (m) => log.lines.push(m);
  log.lines = [];

  const hostPublic = createBoardHost({ safeStorage: fakeSafe, dataDir: freshDir('host-public'), flavour: { values: FLAVOURS.public }, settings, saveSettings, log, env });
  ok(hostPublic.upstream === LIVE_UPSTREAM, 'createBoardHost (public) is built on the real origin even with the env planted', hostPublic.upstream);
  ok(hostPublic.status().configured === false && hostPublic.status().locked === true, 'createBoardHost (public, no secrets): unconfigured + locked');
  // S2 (GATE-BRIDGE-AUTH): board.testBridgeAuth exists only in a test flavour; a public flavour never registers it.
  const hostTestFlavour = createBoardHost({ safeStorage: fakeSafe, dataDir: freshDir('host-testflavour'), flavour: { values: { ...FLAVOURS.public, test: true } }, settings, saveSettings, log, env });
  ok(!('board.testBridgeAuth' in hostPublic.handlers) && typeof hostTestFlavour.handlers['board.testBridgeAuth'] === 'function', 'S2: board.testBridgeAuth is registered in a test flavour and NOT in the public flavour');
  await hostTestFlavour.dispose();
  {
    const hostSrc = fs.readFileSync(path.join(ROOT, 'tauri', 'sidecar', 'board-host.mjs'), 'utf8');
    const spread = hostSrc.match(/\.\.\.\(isBoardTestBuild\(flavour\) \? \{\s*'board\.testBridgeAuth'/);
    ok(Boolean(spread) && hostSrc.split('testBridgeAuth').length === 2, 'S2 source pin: board.testBridgeAuth is registered only inside the isBoardTestBuild(flavour) spread (one registration, no other mention)');
    // stage/bundle marker, like the measure stub's: no renderer / ui / shim / preload / built-bundle / generated-list file names the method;
    // the staged sidecar mentions it only in board-host.mjs (gated above) and main.mjs's presence-guarded forward.
    const tracked = execFileSync('git', ['ls-files', '--', 'src/renderer', 'src/main/preload.js', 'tauri/ui', 'tauri/shim', 'tauri/src-tauri/src', 'tauri/src-tauri/bundle', 'docs/migration/api-inventory.json'], { cwd: ROOT, encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
    const named = tracked.filter((f) => fs.existsSync(path.join(ROOT, f)) && fs.readFileSync(path.join(ROOT, f)).includes('testBridgeAuth'));
    ok(named.length === 0, 'S2 marker: no renderer / preload / ui / shim / Rust / inventory / bundle file names board.testBridgeAuth', named.join(','));
    const stagedHits = (await import('../tauri/stage-bundle.mjs')).stagedTrackedFiles('tauri/sidecar').filter((f) => fs.readFileSync(path.join(ROOT, f), 'utf8').includes('testBridgeAuth'));
    ok(stagedHits.sort().join(',') === 'tauri/sidecar/board-host.mjs,tauri/sidecar/main.mjs', 'S2 marker: in the staged sidecar only board-host.mjs (gated) and main.mjs (presence-guarded forward) mention it', stagedHits.join(','));
  }
  await hostPublic.dispose();

  const hostTest = createBoardHost({ safeStorage: fakeSafe, dataDir: freshDir('host-test'), flavour: { values: FLAVOURS.owner }, settings, saveSettings, log, env });
  ok(hostTest.upstream === 'http://127.0.0.1:54321', 'createBoardHost (test flavour) uses the loopback override', hostTest.upstream);
  await hostTest.dispose();

  const hostBad = createBoardHost({ safeStorage: fakeSafe, dataDir: freshDir('host-bad'), flavour: { values: FLAVOURS.owner }, settings, saveSettings, log, env: { [BOARD_UPSTREAM_ENV]: 'http://example.com' } });
  ok(hostBad.upstream === LIVE_UPSTREAM, 'createBoardHost (test flavour, non-loopback override): the real origin, a logged refusal', `${hostBad.upstream} / ${log.lines.length} line(s)`);
  await hostBad.dispose();
}

// ---------------------------------------------------------------- 2. the real sidecar process
function startMockUpstream() {
  const calls = [];
  const srv = http.createServer((req, res) => { calls.push(req.url); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
  return new Promise((resolve) => { srv.listen(0, '127.0.0.1', () => resolve({ srv, calls, port: srv.address().port })); });
}

function startSidecar(dataDir, extraEnv = {}, extraArgs = []) {
  const args = [SIDECAR, '--data-dir', dataDir, '--no-voice-prefetch', ...extraArgs];
  if (HAVE_VAULT && !extraArgs.includes('--vault-exe')) args.push('--vault-exe', HELPER, '--host-dir', path.dirname(HELPER));
  const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...extraEnv } });
  const rl = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  const events = [];
  const replies = [];
  let stderr = '';
  let nextId = 1;
  let readyResolve;
  const ready = new Promise((r) => { readyResolve = r; });
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  child.once('exit', (code) => { for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error(`sidecar exited (${code})`)); } pending.clear(); });
  rl.on('line', (line) => {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m.method === 'ready') readyResolve();
    else if (m.method === 'event') events.push(m.params);
    else if (m.id != null && pending.has(m.id)) { replies.push(m); const p = pending.get(m.id); pending.delete(m.id); clearTimeout(p.timer); p.resolve(m); }
  });
  return {
    child, events, replies, stderrText: () => stderr, ready,
    request(method, params = []) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout waiting for ${method}`)); }, 30000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
    close() { child.stdin.end(); return new Promise((r) => child.on('close', r)); },
  };
}

// Runtime-generated sentinels: never a literal, never printed.
const S = {
  user: `user-${crypto.randomBytes(9).toString('hex')}`,
  pass: `pass-${crypto.randomBytes(9).toString('hex')}`,
  token: `tok-${crypto.randomBytes(9).toString('hex')}`,
  pin: String(crypto.randomInt(100000, 999999)),
  altPass: `pass2-${crypto.randomBytes(9).toString('hex')}`,
};
const distinctPin = (avoid) => { let p; do { p = String(crypto.randomInt(100000, 999999)); } while (avoid.includes(p)); return p; };
S.wrongPin = distinctPin([S.pin]);
S.newPin = distinctPin([S.pin, S.wrongPin]);
// Advisory A: a failing scan reports the count and the KIND, never the value itself (the suite's own scanDir rule).
const LEAK_KINDS = [
  ['user', S.user], ['pass', S.pass], ['pass', S.altPass], ['token', S.token],
  ['pin', S.pin], ['pin', S.wrongPin], ['pin', S.newPin],
];
const SENTINELS = LEAK_KINDS.map(([, value]) => value);
const leakDetail = (leaked) => {
  const kinds = [...new Set(leaked.map((v) => (LEAK_KINDS.find(([, s]) => s === v) || ['unknown'])[0]))];
  return `${leaked.length} sentinel kind(s): ${kinds.join(',') || 'none'}`;
};

if (!HAVE_VAULT) {
  console.log('FAIL the vault helper is not built. Run: cargo build --manifest-path tauri/src-tauri/Cargo.toml --bins');
  process.exit(1);
}

// A test-flavour sidecar for the 10a-2 section: `test` lets the loopback upstream override through (never the real
// live origin). flavour.json must sit beside the host exe and the vault helper must live in the same dir, so the
// helper is copied into an isolated temp host dir.
function testFlavourHost(name, values = {}) {
  const host = path.join(work, name);
  fs.mkdirSync(host, { recursive: true });
  fs.writeFileSync(path.join(host, 'flavour.json'), `${JSON.stringify({ v: 1, cloudBase: null, test: true, reflexEgress: false, ownerAdmin: false, boardMirror: null, ...values }, null, 2)}\n`);
  const exe = path.join(host, 'zumi-vault.exe');
  fs.copyFileSync(HELPER, exe);
  return ['--vault-exe', exe, '--host-dir', host, '--flavour', path.join(host, 'flavour.json')];
}

/** The loopback port the sidecar's live bridge is listening on (its only listener). */
const bridgeAuthByPort = new Map(); // port -> caller-secret header (test flavour board.testBridgeAuth); never printed
async function bridgePortOf(c) {
  const addrs = await waitForListeners(c.child.pid);
  const port = addrs.length ? Number(String(addrs[0]).split(':').pop()) : null;
  if (!Number.isInteger(port) || port <= 0) throw new Error('the sidecar has no loopback listener');
  const auth = (await c.request('board.testBridgeAuth')).result;
  if (auth && auth.port === port) bridgeAuthByPort.set(port, auth.headers);
  return port;
}

/** Every file under `dir` read as utf8, scanned for any secret substring (the plaintext-on-disk rule). Detail is a
 *  file name only: a failing assertion must never print the sentinel itself. */
function scanDir(dir, secrets) {
  const hits = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      const text = fs.readFileSync(full).toString('utf8');
      if (secrets.some((s) => text.includes(s))) hits.push(e.name);
    }
  };
  walk(dir);
  return [...new Set(hits)];
}

/** One request to the sidecar's loopback bridge, shaped like the served page (Host = this bridge, CSRF on writes). */
function bridgeRequest(port, method, p, { body, headers: extra = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const headers = {
      connection: 'close',
      ...(bridgeAuthByPort.get(port) || {}),
      ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}),
      ...(method === 'POST' ? { 'x-requested-with': 'laneboard' } : {}),
      ...extra,
    };
    for (const k of Object.keys(headers)) if (headers[k] === undefined) delete headers[k];
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* html */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

/** A minimal stand-in for the live board behind nginx: enforces Basic on /zumia/*, plus the CSRF header and the RAW
 *  owner token on writes, so a passing request proves the bridge really sent both. Never a real upstream. */
function startLiveMock() {
  const hits = [];
  let fail = 0; // a forced upstream status for the digest path's http_<status> reason
  const expectedBasic = `Basic ${Buffer.from(`${S.user}:${S.pass}`, 'utf8').toString('base64')}`;
  const state = {
    seq: 7,
    tasks: [{ id: 'T-1', title: 'cho Orvik', status: 'doing', next: 'wire camera path' }],
    attention: { waiting: [] },
    freshness: { stale_h: 6 },
    notify: { coordinator_feedback: true },
    stale_text: [],
  };
  const srv = http.createServer((req, res) => {
    hits.push({ url: req.url, method: req.method, headers: req.headers, body: null });
    const send = (status, payload) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(typeof payload === 'string' ? payload : JSON.stringify(payload)); };
    if (!String(req.url).startsWith('/zumia/')) return send(404, { error: 'not_found' });
    if (req.headers.authorization !== expectedBasic) return send(401, { error: 'bad_basic' }); // the nginx front
    if (req.method === 'POST') {
      if (req.headers['x-requested-with'] !== 'laneboard') return send(403, { error: 'missing_csrf' });
      if (req.headers['x-laneboard-token'] !== S.token) return send(401, { error: 'missing_token' });
      let body = '';
      req.on('data', (c) => { body += c; });
      return req.on('end', () => {
        hits[hits.length - 1].body = body;
        let echo = null;
        try { echo = JSON.parse(body); } catch { /* not json */ }
        send(200, { ok: true, echo });
      });
    }
    if (req.url === '/zumia/api/v1/state') return send(fail || 200, fail ? { error: 'down' } : state);
    if (req.url === '/zumia/api/v1/whoami') return send(200, { role: 'owner' });
    return send(200, {});
  });
  return new Promise((resolve) => { srv.listen(0, '127.0.0.1', () => resolve({ srv, hits, state, port: srv.address().port, setFail: (status) => { fail = status; } })); });
}

/** The owner build's loopback board mirror: exactly the one GET /api/v1/state board-reader.mjs requests. */
function startMirrorMock(state) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    hits.push(req.url);
    if (req.url !== '/api/v1/state') { res.writeHead(404); return res.end('{}'); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(state));
  });
  return new Promise((resolve) => { srv.listen(0, '127.0.0.1', () => resolve({ srv, hits, port: srv.address().port })); });
}

// sha256 of every file under `dir`, keyed by relative path (the wrong-PIN disk assertion).
function hashDir(dir) {
  const out = {};
  const walk = (d, base) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const rel = base ? `${base}/${e.name}` : e.name;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full, rel);
      else out[rel] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    }
  };
  walk(dir, '');
  return out;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await pred()) return true; await wait(100); }
  return false;
}

/** LISTENING addresses of one pid, from netstat (Windows: Proto/Address/Foreign/State/PID). */
function listenersFor(pid) {
  const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true });
  return out.split(/\r?\n/).map((l) => l.trim().split(/\s+/))
    .filter((p) => p.length >= 5 && p[3] === 'LISTENING' && p[4] === String(pid))
    .map((p) => p[1]);
}
async function waitForListeners(pid) {
  const end = Date.now() + 5000;
  let addrs = [];
  while (Date.now() < end) { addrs = listenersFor(pid); if (addrs.length) return addrs; await wait(100); }
  return addrs;
}

{
  const mock = await startMockUpstream();
  const dir = freshDir('rpc-public', {});
  // Public flavour is the absence of --flavour. The override is planted in the CHILD's environment only.
  const c = startSidecar(dir, { [BOARD_UPSTREAM_ENV]: `http://127.0.0.1:${mock.port}` });
  try {
    await c.ready;

    // Gate 10a M3: the public flavour's board host must be built on the REAL origin even with the test override
    // planted. This line is the process-level proof; the "mock got 0 calls" check alone is vacuous here because the
    // bridge never starts in public mode. Never start it: that would contact the live origin.
    // Without the owner values (the public source, a public/official build) there is no live board: no upstream line at all.
    await waitFor(() => /\[board-live\] upstream \S+/.test(c.stderrText()), 2000);
    const publicUpstream = (c.stderrText().match(/\[board-live\] upstream (\S+)/) || [])[1] || '';
    if (LIVE_ORIGIN) ok(publicUpstream === LIVE_ORIGIN, 'public flavour: the board host logs LIVE_ORIGIN (the planted loopback override is ignored)', publicUpstream);
    else ok(publicUpstream === '' && !/upstream/.test(c.stderrText().split('\n').filter((l) => l.includes('[board-live]')).join('\n')), 'no owner values: the board host logs no upstream, not even the planted loopback override', publicUpstream);
    const liveTry = (await c.request('board.setMode', ['live'])).result;
    ok(liveTry && liveTry.ok === false && liveTry.error === (LIVE_ORIGIN ? 'locked_or_unconfigured' : 'no_live_board'), `public flavour: live is refused (${LIVE_ORIGIN ? 'unconfigured' : 'no live board without the owner values'})`, stable(liveTry));

    const noAuth = await c.request('board.testBridgeAuth');
    ok(noAuth.error && noAuth.error.message === 'not_implemented:board.testBridgeAuth' && noAuth.result === undefined, 'S2: the public sidecar rejects board.testBridgeAuth as not_implemented (no secret handed out)', stable(noAuth));
    const fresh = (await c.request('board.status')).result;
    ok(stable(fresh) === stable({ mode: 'local', configured: false, locked: true, pinRequired: true }), 'board.status (fresh public install): Electron\'s unconfigured shape', stable(fresh));
    // check-board-aware pair: the digest path short-circuits on the same unconfigured status, before any fetch.
    const freshDigest = await createBoardReader({ liveBoard: { status: () => fresh, bridgePort: async () => null } }).getDigestText();
    ok(freshDigest === unavailableDigestText('unconfigured'), '10a-3 digest: an unconfigured board is unavailable(unconfigured), never a fetch', freshDigest);

    const set = (await c.request('board.setSecrets', [S])).result;
    ok(set && set.ok === true, 'board.setSecrets stores user/pass/token under the PIN', stable(set));

    const configured = (await c.request('board.status')).result;
    // Electron parity: configure() unlocks but does NOT switch the mode — the renderer calls board:set-mode after the
    // sign-in form (main.js:1427), which is step 10a-2. So `local` + configured + unlocked is the true post-set state.
    ok(configured.mode === 'local' && configured.configured === true && configured.locked === false && configured.pinRequired === true, 'board.status after setSecrets: configured, unlocked, PIN required, mode still local until setMode', stable(configured));
    const localDigest = await createBoardReader({ liveBoard: { status: () => configured, bridgePort: async () => null } }).getDigestText();
    ok(localDigest === unavailableDigestText('not_live'), '10a-3 digest: configured but the live toggle is off -> not_live', localDigest);

    const locked = (await c.request('board.lock')).result;
    const afterLock = (await c.request('board.status')).result;
    ok(locked === true && afterLock.locked === true && afterLock.configured === true, 'board.lock locks the session and keeps the secrets configured', stable(afterLock));

    const wrong = (await c.request('board.unlock', [S.pin === '000000' ? '111111' : '000000'])).result;
    ok(wrong.ok === false && wrong.error === 'wrong_pin', 'board.unlock with a wrong PIN is refused as wrong_pin', stable(wrong));

    const right = (await c.request('board.unlock', [S.pin])).result;
    ok(right.ok === true && (await c.request('board.status')).result.locked === false, 'board.unlock with the PIN unlocks', stable(right));

    ok((await c.request('board.setSecretsOs', [{ user: S.user, pass: S.altPass, token: S.token }])).result.ok === false && (await c.request('board.status')).result.pinRequired === true, 'board.setSecretsOs on a PIN store without the current PIN is refused and keeps the PIN');
    const osSet = (await c.request('board.setSecretsOs', [{ user: S.user, pass: S.altPass, token: S.token, currentPin: S.pin }])).result;
    const osStatus = (await c.request('board.status')).result;
    const settingsOnDisk = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
    ok(osSet.ok === true && osStatus.pinRequired === false && osStatus.configured === true && settingsOnDisk.requireBoardPin === false, 'board.setSecretsOs re-seals without a PIN and records requireBoardPin:false', `${stable(osStatus)} ${stable(settingsOnDisk.requireBoardPin)}`);
    ok((await c.request('board.setSecrets', [{}])).result.error === 'bad_request', 'board.setSecrets refuses a bad shape with bad_request');
    ok((await c.request('board.setSecretsOs', [{ user: S.user }])).result.error === 'bad_request', 'board.setSecretsOs refuses a missing pass with bad_request');
    ok((await c.request('board.unlock', [123456])).result.error === 'bad_request', 'board.unlock refuses a non-string PIN with bad_request');

    const seen = [...c.replies.map((r) => stable(r)), ...c.events.map((e) => stable(e)), c.stderrText()].join('\n');
    const leaked = SENTINELS.filter((s) => seen.includes(s));
    ok(leaked.length === 0, 'no sentinel (user/pass/token/PIN) appears in any rpc reply, event payload or stderr line', leakDetail(leaked));
    ok(mock.calls.length === 0, 'public flavour: the planted loopback upstream received ZERO requests', mock.calls.join(','));
  } finally {
    await c.close();
    await new Promise((r) => mock.srv.close(r));
  }
}

// The fresh-install PIN preference: settings.requireBoardPin=false is the shape Electron returns when unconfigured.
{
  const dir = freshDir('rpc-pref-off', { requireBoardPin: false });
  const c = startSidecar(dir);
  try {
    await c.ready;
    const st = (await c.request('board.status')).result;
    ok(st.configured === false && st.pinRequired === false, 'board.status (unconfigured, requireBoardPin:false): pinRequired follows the saved preference', stable(st));

    const on = (await c.request('board.setPinRequired', [true])).result;
    const stOn = (await c.request('board.status')).result;
    ok(on.ok === true && stOn.pinRequired === true, 'board.setPinRequired (unconfigured) flips the fresh-install preference', stable(stOn));
    const off = (await c.request('board.setPinRequired', [false])).result;
    ok(off.ok === true && (await c.request('board.status')).result.pinRequired === false, 'board.setPinRequired (unconfigured) flips it back', stable(off));
  } finally { await c.close(); }
}

// ---------------------------------------------------------------- 3. PIN toggle, mode and lock triggers (10a-2)
{
  const args = testFlavourHost('host-test-flavour');
  const mock = await startMockUpstream();
  const dir = freshDir('rpc-pin-mode');
  const c = startSidecar(dir, { [BOARD_UPSTREAM_ENV]: `http://127.0.0.1:${mock.port}` }, args);
  try {
    await c.ready;

    // The other half of gate M3: in the test flavour the same stderr line must name the loopback mock, so the line is
    // a real discriminator between the two build flavours (not a constant).
    await waitFor(() => /\[board-live\] upstream \S+/.test(c.stderrText()), 2000);
    const testUpstream = (c.stderrText().match(/\[board-live\] upstream (\S+)/) || [])[1] || '';
    ok(testUpstream === `http://127.0.0.1:${mock.port}`, 'test flavour: the board host logs the loopback mock origin (the override is honoured)', testUpstream);

    ok((await c.request('board.setSecrets', [S])).result.ok === true, '10a-2 setup: secrets configured under the PIN');

    const live = (await c.request('board.setMode', ['live'])).result;
    const liveStatus = (await c.request('board.status')).result;
    ok(live.ok === true && live.mode === 'live' && liveStatus.mode === 'live', 'board.setMode live starts the bridge and status reports live', `${stable(live)} ${stable(liveStatus)}`);

    const addrs = await waitForListeners(c.child.pid);
    ok(addrs.length > 0 && addrs.every((a) => a.startsWith('127.0.0.1:')), 'the live bridge listens on 127.0.0.1 only (bound address from netstat)', addrs.join(','));

    const local = (await c.request('board.setMode', ['local'])).result;
    ok(local.ok === true && local.mode === 'local' && (await c.request('board.status')).result.mode === 'local', 'board.setMode local closes the bridge', stable(local));
    ok((await c.request('board.setMode', ['nope'])).result?.error === 'bad_mode', 'board.setMode refuses an unknown mode with bad_mode');
    ok((await c.request('board.lock')).result === true, 'board.lock locks the session before the wrong-PIN disk check');
    ok((await c.request('board.setMode', ['live'])).result.error === 'locked_or_unconfigured', 'board.setMode live is refused while locked');

    // Gate 10a M15: unlock is the everyday wrong-PIN path, so it gets the same disk proof as disablePin. The real
    // vault (DPAPI) re-encrypts non-deterministically, so a re-seal here shows up as a changed envelope byte.
    const beforeUnlock = hashDir(dir);
    const wrongUnlock = (await c.request('board.unlock', [S.wrongPin])).result;
    const afterUnlock = hashDir(dir);
    const changedUnlock = [...new Set([...Object.keys(beforeUnlock), ...Object.keys(afterUnlock)])].filter((k) => beforeUnlock[k] !== afterUnlock[k]).sort();
    ok(wrongUnlock.ok === false && wrongUnlock.error === 'wrong_pin', 'board.unlock with a wrong PIN is refused as wrong_pin', stable(wrongUnlock));
    ok(beforeUnlock['board-secrets.bin'] === afterUnlock['board-secrets.bin'], 'a wrong unlock PIN leaves the sealed secrets envelope byte-identical');
    ok(changedUnlock.every((k) => k === 'board-secrets.meta.json'), 'a wrong unlock PIN changes no file except the persisted brute-force counter', changedUnlock.join(','));
    const metaUnlock = JSON.parse(fs.readFileSync(path.join(dir, 'board-secrets.meta.json'), 'utf8'));
    ok(Object.keys(metaUnlock).sort().join(',') === 'failedAttempts,lockoutUntil', 'the wrong-unlock counter file holds the counters only', stable(metaUnlock));

    // A wrong PIN must change nothing: hash the whole secrets dir before and after. board-secrets.mjs persists the
    // brute-force counter in board-secrets.meta.json by design (it holds no secret), so that is the ONLY allowed move.
    const before = hashDir(dir);
    const wrong = (await c.request('board.disablePin', [S.wrongPin])).result;
    const after = hashDir(dir);
    const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => before[k] !== after[k]).sort();
    ok(wrong.ok === false && wrong.error === 'wrong_pin', 'board.disablePin with a wrong PIN is refused as wrong_pin', stable(wrong));
    ok(before['board-secrets.bin'] === after['board-secrets.bin'], 'a wrong PIN leaves the sealed secrets envelope byte-identical');
    ok(changed.every((k) => k === 'board-secrets.meta.json'), 'a wrong PIN changes no file except the persisted brute-force counter', changed.join(','));
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'board-secrets.meta.json'), 'utf8'));
    ok(Object.keys(meta).sort().join(',') === 'failedAttempts,lockoutUntil', 'the changed file holds the counters only', stable(meta));

    ok((await c.request('board.setPinRequired', [false])).result.error === 'use_toggle', 'board.setPinRequired is refused once secrets exist (use_toggle)');

    const off = (await c.request('board.disablePin', [S.pin])).result;
    const offStatus = (await c.request('board.status')).result;
    const offSettings = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
    ok(off.ok === true && offStatus.pinRequired === false && offStatus.configured === true && offSettings.requireBoardPin === false, 'board.disablePin re-seals under the OS key and records requireBoardPin:false', `${stable(off)} ${stable(offStatus)} ${stable(offSettings.requireBoardPin)}`);

    const on = (await c.request('board.enablePin', [S.newPin])).result;
    const onStatus = (await c.request('board.status')).result;
    const onSettings = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
    ok(on.ok === true && onStatus.pinRequired === true && onSettings.requireBoardPin === true, 'board.enablePin re-seals under the new PIN and records requireBoardPin:true', `${stable(on)} ${stable(onStatus)} ${stable(onSettings.requireBoardPin)}`);

    ok((await c.request('board.disablePin', [123456])).result.error === 'bad_request', 'board.disablePin refuses a non-string PIN with bad_request');
    ok((await c.request('board.enablePin', [null])).result.error === 'bad_request', 'board.enablePin refuses a non-string PIN with bad_request');
    ok((await c.request('board.enablePin', [S.newPin])).result.error === 'already_pin', 'board.enablePin is refused while the PIN is already on');

    // OS lock/suspend push (6-pre's __host.osEvent) locks immediately, like main.js:1971-1972.
    ok((await c.request('board.unlock', [S.newPin])).result.ok === true, 'setup: the new PIN unlocks');
    ok((await c.request('__host.osEvent', ['lock-screen'])).result === true && (await c.request('board.status')).result.locked === true, "__host.osEvent 'lock-screen' locks the board");
    ok((await c.request('board.unlock', [S.newPin])).result.ok === true, 'setup: unlock again for suspend');
    ok((await c.request('__host.osEvent', ['suspend'])).result === true && (await c.request('board.status')).result.locked === true, "__host.osEvent 'suspend' locks the board");

    // The idle lock reads the cached __host.idle and matches shipped Electron's 15 min (IDLE_LOCK_MS): 31 s never locks.
    ok(BOARD_IDLE_LOCK_MS === ELECTRON_IDLE_LOCK_MS && BOARD_IDLE_LOCK_MS === 15 * 60 * 1000, 'the idle-lock threshold equals the shipped Electron IDLE_LOCK_MS (15 min)', `${BOARD_IDLE_LOCK_MS} vs ${ELECTRON_IDLE_LOCK_MS}`);
    await c.request('__host.idle', [31]);
    ok((await c.request('board.unlock', [S.newPin])).result.ok === true, 'setup: unlock for the idle check');
    await wait(2500);
    ok((await c.request('board.status')).result.locked === false, '31 s of idle does not lock the board (Electron parity)');
    await c.request('__host.idle', [15 * 60 - 1]);
    await wait(2500);
    ok((await c.request('board.status')).result.locked === false, '14 min 59 s of idle does not lock the board');
    await c.request('__host.idle', [15 * 60]);
    ok(await waitFor(async () => (await c.request('board.status')).result.locked === true, 3000), '15 min of idle (fed via __host.idle) locks the board');
    await c.request('__host.idle', [0]);

    const seen = [...c.replies.map((r) => stable(r)), ...c.events.map((e) => stable(e)), c.stderrText()].join('\n');
    const leaked = SENTINELS.filter((s) => seen.includes(s));
    ok(leaked.length === 0, '10a-2: no user/pass/token/old PIN/new PIN appears in any rpc reply, event payload or stderr line', leakDetail(leaked));
    ok(mock.calls.length === 0, '10a-2: the loopback upstream received ZERO requests (the bridge is started, never used)', mock.calls.join(','));
  } finally {
    await c.close();
    await new Promise((r) => mock.srv.close(r));
  }
}

// -------------------- 2b. a settings-shots run never re-locks from the OS idle clock (12-runtime finding 5)
//
// A headless box reports a large OS idle time the whole run, so the idle clock locked the board again seconds
// after the run unlocked it (the box's "the right PIN after that unlocks" failed at +5.7 s). A test/shots run must
// keep the OS lock/suspend triggers but skip the idle clock; a normal launch keeps both (asserted just above).
{
  const dir = freshDir('shots-idle', {});
  const out = path.join(work, 'shots-idle-out');
  fs.mkdirSync(out, { recursive: true });
  const c = startSidecar(dir, {}, ['--settings-shots', out]);
  try {
    await c.ready;
    const stored = (await c.request('board.setSecrets', [{ token: S.token, user: S.user, pass: S.pass, pin: S.pin }])).result;
    ok(stored.ok === true, 'setup: a shots run stores the board secrets', stable(stored));
    await c.request('board.lock');
    await c.request('__host.idle', [15 * 60 + 1]);
    ok((await c.request('board.unlock', [S.pin])).result.ok === true, 'setup: the shots run unlocks with its PIN');
    await wait(2500);
    ok((await c.request('board.status')).result.locked === false,
      'a shots run stays unlocked while the OS idle clock is past the threshold (no idle re-lock; mutation: idleLock always true)');
    await c.request('__host.idle', [0]);
  } finally {
    await c.close();
  }
}

// ---------------------------------------------- 3b. counter PIN-independence (CoS ruling; gate M18)
// Ported from gate10a-tools/counter-probe.mjs. The persisted brute-force counter (board-secrets.meta.json) may hold
// attempt state only: nothing that changes with the PIN VALUE. Two controllers with the same secrets and right PIN
// take 8 wrong PINs that DIFFER between the runs, on a frozen clock; after every attempt the two meta files must be
// byte-identical and hold exactly {failedAttempts, lockoutUntil}. A hash of the PIN hidden in either field (M17/M18)
// breaks byte-identity. Runs for both wrong-PIN paths.
{
  const T0 = 1_800_000_000_000;
  const creds = { token: S.token, user: S.user, pass: S.pass };
  const pins = (n, avoid) => {
    const out = [];
    while (out.length < n) { const p = String(crypto.randomInt(100000, 999999)); if (!avoid.includes(p) && !out.includes(p)) out.push(p); }
    return out;
  };
  const wrongA = pins(8, [S.pin]);
  const wrongB = pins(8, [S.pin, ...wrongA]);
  const mk = (name) => {
    const dir = fs.mkdtempSync(path.join(work, `ctr-${name}-`));
    let t = T0;
    const ctrl = createSecretsController({ safeStorage: fakeSafe, dir, now: () => t });
    ctrl.configure({ ...creds, pin: S.pin });
    ctrl.lock('probe');
    return { dir, ctrl, tick: (ms) => { t += ms; } };
  };
  const metaOf = (x) => fs.readFileSync(path.join(x.dir, 'board-secrets.meta.json'), 'utf8');

  for (const op of ['unlock', 'disablePin']) {
    const a = mk(`${op}-a`);
    const b = mk(`${op}-b`);
    let identical = true;
    let keysOnly = true;
    let noPinText = true;
    for (let i = 0; i < 8; i++) {
      a.ctrl[op](wrongA[i]);
      b.ctrl[op](wrongB[i]);
      const ma = metaOf(a);
      const mb = metaOf(b);
      if (ma !== mb) identical = false;
      if (Object.keys(JSON.parse(ma)).sort().join(',') !== 'failedAttempts,lockoutUntil') keysOnly = false;
      if ([...wrongA, ...wrongB, S.pin].some((p) => ma.includes(p) || mb.includes(p))) noPinText = false;
      a.tick(31_000); b.tick(31_000); // step past any backoff window so every attempt is a real PIN check
    }
    ok(identical, `10a counter (${op}): two runs with different wrong PINs leave byte-identical counter files after every attempt`);
    ok(keysOnly, `10a counter (${op}): the counter file holds exactly {failedAttempts, lockoutUntil}`);
    ok(noPinText, `10a counter (${op}): no PIN text ever appears in the counter file`);
    ok(JSON.parse(metaOf(a)).failedAttempts === 8, `10a counter (${op}): the count really advanced (8)`, metaOf(a));
  }
}

// ---------------------------------------------------------------- 4. board.status golden (10a-3)
{
  const golden = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'fixtures', 'tauri-board', 'status.golden.json'), 'utf8'));
  const expect = (label, actual) => ok(stable(actual) === stable(golden.cases[label]), `board.status golden: ${label}`, `${stable(actual)} != ${stable(golden.cases[label])}`);

  const mock = await startMockUpstream();
  const dir = freshDir('golden');
  const c = startSidecar(dir, { [BOARD_UPSTREAM_ENV]: `http://127.0.0.1:${mock.port}` }, testFlavourHost('host-golden'));
  try {
    await c.ready;
    expect('freshDefault', (await c.request('board.status')).result);

    ok((await c.request('board.setSecrets', [S])).result.ok === true, 'golden setup: secrets configured');
    expect('configuredUnlocked', (await c.request('board.status')).result);

    ok((await c.request('board.setMode', ['live'])).result.ok === true, 'golden setup: live mode on');
    expect('liveUnlocked', (await c.request('board.status')).result);

    ok((await c.request('board.setMode', ['local'])).result.ok === true && (await c.request('board.lock')).result === true, 'golden setup: back to local and locked');
    expect('locked', (await c.request('board.status')).result);

    ok((await c.request('board.setSecretsOs', [{ user: S.user, pass: S.altPass, token: S.token, currentPin: S.pin }])).result.ok === true, 'golden setup: OS-sealed, no PIN');
    expect('osModeUnlocked', (await c.request('board.status')).result);
    ok(mock.calls.length === 0, 'golden: the live bridge was only started, never used (zero upstream requests)', mock.calls.join(','));
  } finally {
    await c.close();
    await new Promise((r) => mock.srv.close(r));
  }

  const cOff = startSidecar(freshDir('golden-pref-off', { requireBoardPin: false }));
  try {
    await cOff.ready;
    expect('freshPreferenceOff', (await cOff.request('board.status')).result);
  } finally { await cOff.close(); }
}

// ---------------------------------------------------------------- 5. check-board-live + check-board-bridge through the sidecar
// The RELAY channel (ask.answer / feedback.add / inbox.submit) has no rpc in this step: it arrives with board.liveOpen
// (10b), so it is covered there, not silently skipped here. The PAGE channel below is the whole bridge surface today.
{
  const mock = await startLiveMock();
  const dir = freshDir('rpc-live-bridge');
  const c = startSidecar(dir, { [BOARD_UPSTREAM_ENV]: `http://127.0.0.1:${mock.port}/zumia` }, testFlavourHost('host-live-bridge'));
  const bodies = [];
  try {
    await c.ready;
    ok((await c.request('board.setSecrets', [S])).result.ok === true, '10a-3 live: secrets configured under the PIN');
    const live = (await c.request('board.setMode', ['live'])).result;
    ok(live.ok === true && live.mode === 'live', '10a-3 live: board.setMode live starts the bridge', stable(live));
    const addrs = await waitForListeners(c.child.pid);
    const port = await bridgePortOf(c);
    ok(addrs.every((a) => a.startsWith('127.0.0.1:')), '10a-3 live: the bridge is loopback-only', addrs.join(','));

    // check-board-bridge §1: the pinned page, served locally (never proxied).
    const page = await bridgeRequest(port, 'GET', '/');
    bodies.push(page.text);
    ok(page.status === 200 && page.text.includes('Zumia · Laneboard') && page.text.includes('id="app"'), '10a-3 bridge: GET / serves the pinned page', page.status);
    const script = await bridgeRequest(port, 'GET', '/app.js');
    bodies.push(script.text);
    ok(script.status === 200 && script.text.includes('authHeaders'), '10a-3 bridge: GET /app.js serves the pinned script');
    ok(!page.text.includes(S.token) && !script.text.includes(S.token), '10a-3 bridge: the served page/script never carry the owner token');

    // caller-auth (GATE-B3-SECURITY C1): no caller secret -> 401 on reads, the page and writes; nothing reaches upstream.
    const noSecret = { 'x-zumi-bridge-token': undefined };
    const bare = await Promise.all([bridgeRequest(port, 'GET', '/api/v1/state', { headers: noSecret }), bridgeRequest(port, 'GET', '/', { headers: noSecret }), bridgeRequest(port, 'POST', '/api/v1/write', { body: { op: 'task.update' }, headers: noSecret })]);
    ok(bare.every((r) => r.status === 401) && mock.hits.length === 0, '10a-3 bridge: no caller secret -> 401 on read, page and write; nothing reached upstream', bare.map((r) => r.status).join(','));
    ok((await bridgeRequest(port, 'GET', '/api/v1/inbox?lane=cos')).status === 404 && mock.hits.length === 0, '10a-3 bridge: /api/v1/inbox with the secret is still refused (allow-list), nothing upstream');

    // check-board-bridge §1b: the browser-origin guards, and no CORS answer ever.
    const rebind = await bridgeRequest(port, 'GET', '/api/v1/state', { headers: { host: 'evil.example' } });
    ok(rebind.status === 403 && rebind.json?.error === 'forbidden_host', '10a-3 bridge: a foreign Host is refused (forbidden_host)', rebind.json);
    const simple = await bridgeRequest(port, 'POST', '/api/v1/write', {
      body: { version: 1, request_id: 'csrf-1', op: 'task.update', target_id: 'T-1', data: { status: 'doing' } },
      headers: { 'content-type': 'text/plain', 'x-requested-with': undefined },
    });
    ok(simple.status === 403 && simple.json?.error === 'csrf_header_required', '10a-3 bridge: a cross-site simple POST is refused (csrf_header_required)', simple.json);
    const pre = await bridgeRequest(port, 'OPTIONS', '/api/v1/write', { headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
    const acHeaders = [pre, page].flatMap((r) => Object.keys(r.headers).filter((h) => h.startsWith('access-control-')));
    ok(pre.status === 405 && acHeaders.length === 0, '10a-3 bridge: CORS preflight -> 405, no Access-Control-* header', `${pre.status} ${acHeaders.join(',')}`);
    ok(mock.hits.length === 0, '10a-3 bridge: none of the refused requests reached the loopback upstream', mock.hits.map((h) => h.url).join(','));

    // check-board-bridge §2/§10: live-shaped auth on the upstream hop (Basic + raw owner token).
    const expectedBasic = `Basic ${Buffer.from(`${S.user}:${S.pass}`, 'utf8').toString('base64')}`;
    const h0 = mock.hits.length;
    const me = await bridgeRequest(port, 'GET', '/api/v1/whoami');
    bodies.push(me.text);
    const meHit = mock.hits[h0];
    ok(me.status === 200 && me.json?.role === 'owner', '10a-3 bridge: whoami through the bridge is the owner identity', me.json);
    ok(meHit && meHit.url === '/zumia/api/v1/whoami' && meHit.headers.authorization === expectedBasic && meHit.headers['x-laneboard-token'] === S.token, '10a-3 live: the upstream hop carries Basic + the RAW owner token, path prefix kept');

    // check-board-bridge §4: an allowed PAGE write reaches upstream with the CSRF header and a zumi-ui- request_id.
    const h1 = mock.hits.length;
    const write = await bridgeRequest(port, 'POST', '/api/v1/write', { body: { version: 1, request_id: 'page-status-1', op: 'task.update', target_id: 'T-1', data: { status: 'doing' } } });
    bodies.push(write.text);
    const wHit = mock.hits[h1];
    ok(write.status === 200 && write.json?.ok === true, '10a-3 bridge PAGE channel: task.update is forwarded', write.text.slice(0, 120));
    ok(wHit && wHit.headers['x-requested-with'] === 'laneboard' && wHit.headers['x-laneboard-token'] === S.token && String(write.json?.echo?.request_id || '').startsWith('zumi-ui-'), '10a-3 bridge PAGE channel: CSRF + raw token + zumi-ui- request_id');

    // check-board-bridge §5: the release build's PAGE allowlist (no ownerOps in the public/test flavour here).
    const h2 = mock.hits.length;
    for (const [op, target, data] of [
      ['roles.set', 'T-1', { role: 'plan', model: 'opus', effort: 'low' }],
      ['token.issue', 'sneaky', { role: 'owner' }],
      ['task.delete', 'T-1', {}],
    ]) {
      const r = await bridgeRequest(port, 'POST', '/api/v1/write', { body: { version: 1, request_id: `page-${op}`, op, target_id: target, data } });
      ok(r.status === 403 && r.json?.error === 'forbidden_op', `10a-3 bridge (release): ${op} is refused (403 forbidden_op)`, r.json);
    }
    ok(mock.hits.length === h2, '10a-3 bridge (release): refused ops never reached upstream');

    // check-board-bridge §5c: the page state drops freshness/notify, keeps the rest.
    const st = await bridgeRequest(port, 'GET', '/api/v1/state');
    bodies.push(st.text);
    ok(st.status === 200 && Array.isArray(st.json?.tasks) && st.json.tasks.some((t) => t.id === 'T-1') && st.json?.seq === mock.state.seq && !('freshness' in st.json) && !('notify' in st.json), '10a-3 bridge: page state keeps tasks/seq and drops freshness/notify');

    // check-board-bridge §3/§11: no secret in any page, state or response body this section produced.
    const blob = bodies.join('\n');
    ok(!blob.includes(S.token) && !blob.includes(S.pass) && !blob.includes(S.user), '10a-3 bridge: no served response body carries user/pass/token');

    // check-board-live §4/§7b: the mode gate (live needs configured + unlocked) and the locked bridge refusing before
    // any upstream call.
    ok((await c.request('board.lock')).result === true, '10a-3 live: board.lock locks the live session');
    const h3 = mock.hits.length;
    const lockedRead = await bridgeRequest(port, 'GET', '/api/v1/whoami');
    ok(lockedRead.status === 401 && lockedRead.json?.error === 'locked' && mock.hits.length === h3, '10a-3 live: a locked bridge refuses with 401 locked before any upstream call');
    ok((await c.request('board.setMode', ['live'])).result.error === 'locked_or_unconfigured', '10a-3 live: re-entering live mode while locked is refused');
    ok((await c.request('board.unlock', [S.pin])).result.ok === true, '10a-3 live: the PIN unlocks again');
    ok((await c.request('board.setMode', ['local'])).result.ok === true && (await c.request('board.setMode', ['nope'])).result?.error === 'bad_mode', '10a-3 live: local closes the bridge; an unknown mode is bad_mode');

    const seen = [...c.replies.map((r) => stable(r)), ...c.events.map((e) => stable(e)), c.stderrText()].join('\n');
    const leaked = SENTINELS.filter((s) => seen.includes(s));
    ok(leaked.length === 0, '10a-3 live: no sentinel appears in any rpc reply, event payload or stderr line', leakDetail(leaked));
  } finally {
    await c.close();
    await new Promise((r) => mock.srv.close(r));
  }
}

// ---------------------------------------------------------------- 6. check-board-live §1-3b/§6: backoff, token-optional, mode gate
{
  const dir = freshDir('rpc-backoff');
  const c = startSidecar(dir);
  try {
    await c.ready;
    ok((await c.request('board.unlock', [S.pin])).result.error === 'not_configured', '10a-3 backoff: unlock before configure -> not_configured');
    ok((await c.request('board.setMode', ['live'])).result.error === (LIVE_ORIGIN ? 'locked_or_unconfigured' : 'no_live_board'), `10a-3 mode gate: live is refused while unconfigured${LIVE_ORIGIN ? '' : ' (no live board without the owner values)'}`);
    ok((await c.request('board.setSecrets', [S])).result.ok === true, '10a-3 backoff setup: configured and unlocked');
    ok((await c.request('board.lock')).result === true, '10a-3 backoff setup: locked');

    const free = [];
    for (let i = 0; i < 5; i++) free.push((await c.request('board.unlock', [S.wrongPin])).result);
    ok(free.every((r) => r.error === 'wrong_pin' && !(r.retryAfterMs > 0)), '10a-3 backoff: the first 5 wrong tries cost nothing', stable(free.map((r) => r.retryAfterMs)));
    const sixth = (await c.request('board.unlock', [S.wrongPin])).result;
    ok(sixth.error === 'wrong_pin' && sixth.retryAfterMs > 0, '10a-3 backoff: the 6th wrong try carries a delay', stable(sixth));
    const blocked = (await c.request('board.unlock', [S.pin])).result;
    ok(blocked.error === 'backoff' && blocked.retryAfterMs > 0, '10a-3 backoff: a correct PIN inside the window is refused as backoff', stable(blocked));
    await wait(blocked.retryAfterMs + 300);
    ok((await c.request('board.unlock', [S.pin])).result.ok === true, '10a-3 backoff: the right PIN works once the window elapses');
  } finally { await c.close(); }
}

{
  const dir = freshDir('rpc-token-optional');
  const c = startSidecar(dir);
  try {
    await c.ready;
    ok((await c.request('board.setSecrets', [{ user: S.user, pass: S.pass, pin: S.pin }])).result.ok === true, '10a-3 token: configure succeeds with the token field entirely absent');
    ok((await c.request('board.setSecrets', [{ user: S.user, pass: S.pass, pin: S.pin, token: 123 }])).result.error === 'bad_request', '10a-3 token: a non-string token is refused (bad_request)');
    ok((await c.request('board.setSecrets', [{ user: S.user, pass: S.pass, pin: S.pin, token: '', currentPin: S.pin }])).result.ok === true, '10a-3 token: an explicitly empty token is accepted');

    ok((await c.request('board.setSecretsOs', [{ user: S.user, pass: S.altPass, currentPin: S.pin }])).result.ok === true, '10a-3 token: setSecretsOs without a token succeeds');
    const st = (await c.request('board.status')).result;
    ok(st.configured === true && st.pinRequired === false && st.locked === false, '10a-3 token: OS mode is configured, unlocked and PIN-free', stable(st));
    ok((await c.request('board.lock')).result === true && (await c.request('board.status')).result.locked === false, '10a-3 token: lock() is a no-op in OS mode');
    ok((await c.request('board.unlock', [''])).result.ok === true, '10a-3 token: unlock() in OS mode is a harmless success');
    const hits = scanDir(dir, SENTINELS);
    ok(hits.length === 0, '10a-3 token: no user/pass/token is written to disk in plaintext', hits.join(','));
  } finally { await c.close(); }
}

// ---------------------------------------------------------------- 7. check-board-pin-toggle through the sidecar
{
  const dir = freshDir('rpc-pin-toggle');
  const c1 = startSidecar(dir);
  try {
    await c1.ready;
    ok((await c1.request('board.disablePin', [S.pin])).result.error === 'not_configured', '10a-3 pin: disablePin before configure -> not_configured');
    ok((await c1.request('board.enablePin', [S.newPin])).result.error === 'not_configured', '10a-3 pin: enablePin before configure -> not_configured');
    ok((await c1.request('board.setSecrets', [S])).result.ok === true, '10a-3 pin setup: secrets under the PIN');
    ok((await c1.request('board.disablePin', ['12345'])).result.error === 'bad_pin_shape', '10a-3 pin: a 5-digit PIN is refused before the envelope is touched');
    const wrong = (await c1.request('board.disablePin', [S.wrongPin])).result;
    ok(wrong.error === 'wrong_pin', '10a-3 pin: a wrong current PIN is refused', stable(wrong));

    const off = (await c1.request('board.disablePin', [S.pin])).result;
    const offStatus = (await c1.request('board.status')).result;
    ok(off.ok === true && offStatus.pinRequired === false && offStatus.locked === false, '10a-3 pin: the right PIN turns the requirement off (re-sealed under the OS key)', stable(offStatus));
    ok((await c1.request('board.disablePin', [S.pin])).result.error === 'already_os', '10a-3 pin: disablePin again -> already_os');
    ok((await c1.request('board.enablePin', ['1234'])).result.error === 'bad_pin_shape', '10a-3 pin: enablePin refuses a short PIN');
    const on = (await c1.request('board.enablePin', [S.newPin])).result;
    ok(on.ok === true && (await c1.request('board.status')).result.pinRequired === true, '10a-3 pin: a new PIN turns the requirement back on');
    ok((await c1.request('board.enablePin', [S.newPin])).result.error === 'already_pin', '10a-3 pin: enablePin again -> already_pin');

    ok((await c1.request('board.lock')).result === true && (await c1.request('board.status')).result.locked === true, '10a-3 pin: lock() works again once a PIN exists');
    ok((await c1.request('board.unlock', [S.wrongPin])).result.error === 'wrong_pin', '10a-3 pin: a wrong new PIN fails to unlock');
    ok((await c1.request('board.unlock', [S.newPin])).result.ok === true, '10a-3 pin: the new PIN unlocks');
    const hits = scanDir(dir, SENTINELS);
    ok(hits.length === 0, '10a-3 pin: no PIN or credential is ever written to disk in plaintext', hits.join(','));
    ok((await c1.request('board.lock')).result === true, '10a-3 pin setup: locked for the restart');
  } finally { await c1.close(); }

  const c2 = startSidecar(dir);
  try {
    await c2.ready;
    const rest = (await c2.request('board.status')).result;
    ok(rest.configured === true && rest.locked === true && rest.pinRequired === true, '10a-3 pin: after a restart a PIN-sealed board boots locked', stable(rest));
    ok((await c2.request('board.unlock', [S.newPin])).result.ok === true, '10a-3 pin: the new PIN still unlocks after a restart');
  } finally { await c2.close(); }
}

{
  // OFF mode has no PIN to ask for: a fresh controller bootstraps straight to unlocked, and lock() is a no-op.
  const dir = freshDir('rpc-os-restart');
  const c1 = startSidecar(dir);
  try {
    await c1.ready;
    ok((await c1.request('board.setSecretsOs', [{ user: S.user, pass: S.altPass, token: S.token }])).result.ok === true, '10a-3 pin: configureOs succeeds (OS-sealed, unlocked)');
    ok((await c1.request('board.lock')).result === true && (await c1.request('board.status')).result.locked === false, '10a-3 pin: OS mode lock() strands nobody (still unlocked)');
  } finally { await c1.close(); }

  const c2 = startSidecar(dir);
  try {
    await c2.ready;
    const st = (await c2.request('board.status')).result;
    ok(st.configured === true && st.locked === false && st.pinRequired === false, '10a-3 pin: OS mode survives a restart unlocked, with no PIN anywhere', stable(st));
  } finally { await c2.close(); }
}

// ---------------------------------------------------------------- 8. check-owner-board (the ownerOps gate) through the sidecar
{
  const releaseMock = await startLiveMock();
  const cRel = startSidecar(freshDir('rpc-owner-release'), { [BOARD_UPSTREAM_ENV]: `http://127.0.0.1:${releaseMock.port}/zumia` }, testFlavourHost('host-owner-release'));
  try {
    await cRel.ready;
    ok((await cRel.request('board.setSecrets', [S])).result.ok === true && (await cRel.request('board.setMode', ['live'])).result.ok === true, '10a-3 owner: release-flavour board is live');
    const port = await bridgePortOf(cRel);
    const hits = releaseMock.hits.length;
    const r = await bridgeRequest(port, 'POST', '/api/v1/write', { body: { version: 1, request_id: 'owner-release-1', op: 'roles.set', target_id: 'T-1', data: { role: 'plan', model: 'opus', effort: 'low' } } });
    ok(r.status === 403 && r.json?.error === 'forbidden_op' && releaseMock.hits.length === hits, '10a-3 owner: a release board keeps lane routing refused (403, nothing upstream)');
  } finally {
    await cRel.close();
    await new Promise((r) => releaseMock.srv.close(r));
  }

  const ownerMock = await startLiveMock();
  const cOwn = startSidecar(freshDir('rpc-owner-build'), { [BOARD_UPSTREAM_ENV]: `http://127.0.0.1:${ownerMock.port}/zumia` }, testFlavourHost('host-owner-build', { ownerAdmin: true }));
  try {
    await cOwn.ready;
    ok((await cOwn.request('board.setSecrets', [S])).result.ok === true && (await cOwn.request('board.setMode', ['live'])).result.ok === true, '10a-3 owner: owner-flavour board is live');
    const port = await bridgePortOf(cOwn);
    const hits = ownerMock.hits.length;
    const routed = await bridgeRequest(port, 'POST', '/api/v1/write', { body: { version: 1, request_id: 'owner-build-1', op: 'roles.set', target_id: 'T-1', data: { role: 'plan', model: 'opus', effort: 'low' } } });
    ok(routed.status === 200 && routed.json?.ok === true && ownerMock.hits.length === hits + 1, '10a-3 owner: the owner build forwards roles.set (lane routing)', routed.text.slice(0, 120));
    ok(String(routed.json?.echo?.request_id || '').startsWith('zumi-ui-') && routed.json?.echo?.op === 'roles.set', '10a-3 owner: the forwarded write still carries the zumi-ui- channel prefix');
    for (const [op, target, data] of [['token.issue', 'sneaky', { role: 'owner' }], ['roles.escalate', 'T-1', { gate: 'g' }], ['task.delete', 'T-1', {}]]) {
      const r = await bridgeRequest(port, 'POST', '/api/v1/write', { body: { version: 1, request_id: `owner-${op}`, op, target_id: target, data } });
      ok(r.status === 403 && r.json?.error === 'forbidden_op', `10a-3 owner: ${op} stays refused even in the owner build`);
    }
  } finally {
    await cOwn.close();
    await new Promise((r) => ownerMock.srv.close(r));
  }

  // The renderer half of check-owner-board (app.js's renderBoardTab gates) is Electron-only by construction; this is
  // the sidecar-side guarantee it rests on: ownerOps reaches the bridge only when the flavour really says ownerAdmin.
  const hostSrc = fs.readFileSync(path.join(ROOT, 'tauri', 'sidecar', 'board-host.mjs'), 'utf8');
  ok(/const ownerAdmin = Boolean\(flavour && flavour\.values && flavour\.values\.ownerAdmin === true\)/.test(hostSrc) && /ownerOps: ownerAdmin,/.test(hostSrc), '10a-3 owner: board-host passes ownerOps only for an ownerAdmin flavour (exactly true)');
  ok(FLAVOURS.public.ownerAdmin === false, '10a-3 owner: the public flavour never enables ownerOps');
}

// ---------------------------------------------------------------- 9. check-board-bridge §9: redirects are errors, credentials never replayed
{
  const targetHits = [];
  const target = http.createServer((req, res) => { targetHits.push(req.url); res.writeHead(200); res.end('followed'); });
  await new Promise((r) => target.listen(0, '127.0.0.1', r));
  const redir = http.createServer((req, res) => { res.writeHead(302, { location: `http://127.0.0.1:${target.address().port}/elsewhere` }); res.end(); });
  await new Promise((r) => redir.listen(0, '127.0.0.1', r));

  const c = startSidecar(freshDir('rpc-redirect'), { [BOARD_UPSTREAM_ENV]: `http://127.0.0.1:${redir.address().port}/zumia` }, testFlavourHost('host-redirect'));
  try {
    await c.ready;
    ok((await c.request('board.setSecrets', [S])).result.ok === true && (await c.request('board.setMode', ['live'])).result.ok === true, '10a-3 redirect: live against the redirecting loopback upstream');
    const port = await bridgePortOf(c);
    const r = await bridgeRequest(port, 'GET', '/api/v1/whoami');
    ok(r.status === 502 && r.json?.error === 'upstream_redirect', '10a-3 redirect: an upstream 3xx is a 502 upstream_redirect', r.text.slice(0, 120));
    ok(targetHits.length === 0, '10a-3 redirect: the owner credentials are never replayed to the redirect target');
  } finally {
    await c.close();
    await new Promise((r) => redir.close(r));
    await new Promise((r) => target.close(r));
  }
}

// ---------------------------------------------------------------- 10. check-board-aware: the digest path over the sidecar's bridge
{
  const mock = await startLiveMock();
  const c = startSidecar(freshDir('rpc-digest'), { [BOARD_UPSTREAM_ENV]: `http://127.0.0.1:${mock.port}/zumia` }, testFlavourHost('host-digest'));
  try {
    await c.ready;
    ok((await c.request('board.setSecrets', [S])).result.ok === true, '10a-3 digest setup: secrets configured');
    ok((await c.request('board.setMode', ['live'])).result.ok === true, '10a-3 digest setup: live mode');
    const port = await bridgePortOf(c);
    const statusNow = async () => (await c.request('board.status')).result;
    const readerFor = (st, opts = {}) => createBoardReader({
      liveBoard: { status: () => st, bridgePort: async () => (st.mode === 'live' ? port : null), bridgeHeaders: async () => bridgeAuthByPort.get(port) || {} },
      log: () => {},
      ...opts,
    });

    let st = await statusNow();
    ok(st.mode === 'live' && st.locked === false, '10a-3 digest setup: live and unlocked');
    const text = await readerFor(st).getDigestText();
    ok(text === buildBoardDigest(mock.state).text, '10a-3 digest: live+unlocked digest == buildBoardDigest of the upstream state', text.slice(0, 160));
    ok(text.includes('[T-1]') && text.includes('cho Orvik'), '10a-3 digest: task id and title come through the real bridge');

    const redacted = await readerFor(st, { getRedact: () => ({ sendClientNames: false, names: ['Orvik'], mask: '[client]' }) }).getDigestText();
    ok(redacted.includes('[client]') && !redacted.includes('Orvik'), '10a-3 digest: redaction flows through the sidecar bridge state');

    mock.setFail(503);
    const down = await readerFor(st).getDigestText();
    mock.setFail(0);
    ok(down === unavailableDigestText('http_503'), '10a-3 digest: an upstream 503 is reason=http_503, never a partial digest', down.slice(0, 100));

    ok((await c.request('board.lock')).result === true, '10a-3 digest setup: locked');
    st = await statusNow();
    const lockedHits = mock.hits.length;
    ok((await readerFor(st).getDigestText()) === unavailableDigestText('locked') && mock.hits.length === lockedHits, '10a-3 digest: a locked board short-circuits before any bridge fetch');

    const mirror = await startMirrorMock(mock.state);
    try {
      const viaMirror = await readerFor(st, { mirrorOrigin: `http://127.0.0.1:${mirror.port}` }).getDigestText();
      ok(viaMirror === buildBoardDigest(mock.state).text && mirror.hits.length === 1, '10a-3 digest: a locked bridge falls back to the loopback mirror (one /api/v1/state)', `mirror hits ${mirror.hits.length}`);
      let mirrorCalls = 0;
      const refused = await readerFor(st, { mirrorOrigin: 'http://evil.example:3100', fetchImpl: async () => { mirrorCalls++; throw new Error('must not be called'); } }).getDigestText();
      ok(mirrorCalls === 0 && refused === unavailableDigestText('locked'), '10a-3 digest: a non-loopback mirror is refused (no fetch, honest reason)', refused);
    } finally { await new Promise((r) => mirror.srv.close(r)); }

    ok((await c.request('board.unlock', [S.pin])).result.ok === true && (await c.request('board.setMode', ['local'])).result.ok === true, '10a-3 digest setup: unlocked and back to local');
    st = await statusNow();
    const localHits = mock.hits.length;
    ok((await readerFor(st).getDigestText()) === unavailableDigestText('not_live') && mock.hits.length === localHits, '10a-3 digest: local mode -> not_live, no bridge fetch');

    // The sidecar wiring this section reads through: chat-host builds the SAME reader over the SAME liveBoard the board
    // rpcs use, the flavour's mirror and the owner's redact settings (Electron: main.js:1873-1893).
    const chatSrc = fs.readFileSync(path.join(ROOT, 'tauri', 'sidecar', 'chat-host.mjs'), 'utf8');
    ok(/createBoardReader\(\{\s*liveBoard: liveBoard \|\| OFFLINE_LIVE_BOARD/.test(chatSrc) && /mirrorOrigin: fv\.boardMirror \|\| null/.test(chatSrc) && /getRedact: \(\) => \(\{ sendClientNames: settings\(\)\.sendClientNamesToAi === true/.test(chatSrc), '10a-3 digest: chat-host wires the reader to the sidecar liveBoard, the flavour mirror and the owner settings');
    ok(/liveBoard: boardHost\.liveBoard/.test(fs.readFileSync(SIDECAR, 'utf8')), '10a-3 digest: main.mjs passes the SAME liveBoard to the chat host');

    const seen = [...c.replies.map((r) => stable(r)), ...c.events.map((e) => stable(e)), c.stderrText()].join('\n');
    const leaked = SENTINELS.filter((s) => seen.includes(s));
    ok(leaked.length === 0, '10a-3 digest: no sentinel appears in any rpc reply, event payload or stderr line', leakDetail(leaked));
  } finally {
    await c.close();
    await new Promise((r) => mock.srv.close(r));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
