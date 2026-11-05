// T-31 L1 check: live-board secrets + PIN unlock + the bridge's live-mode auth (board-secrets.mjs, board-live.mjs,
// the live-auth additions to board-bridge.mjs). Node only, no Electron, NO network to the real live board — every
// upstream in this file is a local mock on 127.0.0.1. `safeStorage` is a reversible fake (same convention as
// scripts/check-speech.mjs's cloud token test): real enough to prove "encrypted, not plaintext", not real DPAPI.
//   node scripts/check-board-live.mjs   (or: npm run check:board-live)
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { realSafeStorage } from './lib/real-safe-storage.mjs';
import { createSecretsController, IDLE_LOCK_MS } from '../src/main/board-secrets.mjs';
import { createLiveBoard, LIVE_ORIGIN, LIVE_UPSTREAM, isTestBuild, resolveBoardUpstream } from '../src/main/board-live.mjs';
import { ownerPath } from './lib/owner-paths.mjs';

// The live board origin is an owner value (alpha.14 F7): the owner tree and owner builds have it, the public source and the
// public/official builds do not (LIVE_ORIGIN and LIVE_UPSTREAM are null there). The mode, relay and ownerOps rows below test
// board-live's own gating, not the origin, so where there is no origin they run on a loopback test upstream instead.
const OWNER_ORIGIN = ownerPath('liveOrigin', null);
const GATE_UPSTREAM = LIVE_UPSTREAM ? { upstream: LIVE_UPSTREAM } : { upstream: 'http://127.0.0.1:9/zumia', allowTestUpstream: true };
import { createBridge as rawCreateBridge } from '../src/main/board-bridge.mjs';
// Caller-auth (board-bridge.mjs): every request must carry the per-launch secret. The wrapper records each bridge's
// header by port so the helpers send it like the app's own webview/reader would; a test drops it with `undefined`.
const bridgeTokens = new Map();
const createBridge = (o) => { const b = rawCreateBridge(o); b.port().then((p) => bridgeTokens.set(p, b.callerHeaders())); return b; };
const tokenFor = (port) => bridgeTokens.get(port) || {};

import { createBoard } from '../vendor/laneboard/src/board.mjs';
import { createServer } from '../vendor/laneboard/src/server.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'vendor', 'laneboard', 'public');

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: Boolean(ok) }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`); };

// Fake secrets. TOKEN/USER/PASS are planted on disk/over "IPC" and must never be found in plaintext.
const TOKEN = 'lb_FAKEtoken_9a8b7c6d5e4f';
const USER = 'kei-fake-user';
const PASS = 'fake-nginx-pass-7x7x';
const PIN = '482913';
const WRONG_PIN = '000000';

// ZUMI_VAULT_EXE (GATE-step5 test 9) swaps the reversible fake for the real vault adapter; unset keeps the fake.
const fakeSafeStorage = realSafeStorage() || {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from([...Buffer.from(s, 'utf8')].map((b) => b ^ 0x5a)),
  decryptString: (b) => Buffer.from([...b].map((x) => x ^ 0x5a)).toString('utf8'),
};

let clock = 1_700_000_000_000;
const now = () => clock;

function mkdtemp(prefix) {
  const dir = path.join(root, `.check-board-live-${prefix}-${process.pid}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function rmrf(dir) { fs.rmSync(dir, { recursive: true, force: true }); }

// Every file under `dir`, read as both utf8 text and hex, scanned for any secret substring. Used for the "nothing
// secret on disk in plaintext" requirement.
function scanForPlaintextSecrets(dir, secrets) {
  const hits = [];
  const walk = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, f.name);
      if (f.isDirectory()) { walk(full); continue; }
      const buf = fs.readFileSync(full);
      const text = buf.toString('utf8');
      for (const s of secrets) if (text.includes(s)) hits.push({ file: full, secret: s });
    }
  };
  walk(dir);
  return hits;
}

function req(port, method, p, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) : null;
    // a write carries X-Requested-With: laneboard like the served page's write() (the bridge refuses one without it)
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { connection: 'close', ...tokenFor(port), ...(data ? { 'content-type': 'application/json', 'content-length': data.length, 'x-requested-with': 'laneboard' } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let json = null; try { json = JSON.parse(text); } catch { /* not json */ } resolve({ status: res.statusCode, text, json, reqHeaders: r.getHeaders() }); });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

// ====================================================================================================
// 1-3. secrets controller: round-trip, wrong PIN, backoff, plaintext scan, idle/lock
// ====================================================================================================
{
  const dir = mkdtemp('secrets');
  try {
    const log = [];
    const ctl = createSecretsController({ safeStorage: fakeSafeStorage, dir, now, log: (m) => log.push(m) });

    check('fresh controller: not configured, locked, pinRequired defaults true', JSON.stringify(ctl.status()) === JSON.stringify({ configured: false, locked: true, pinRequired: true }));
    check('getSecrets() is null before configure', ctl.getSecrets() === null);

    const bad1 = ctl.configure({ token: TOKEN, user: USER, pass: PASS, pin: '12345' }); // 5 digits
    check('configure refuses a non-6-digit PIN', bad1.ok === false && bad1.error === 'bad_pin_shape');

    const r0 = ctl.configure({ token: TOKEN, user: USER, pass: PASS, pin: PIN });
    check('configure with the right shape succeeds', r0.ok === true);
    check('configure also unlocks (the PIN was just re-entered = the fresh-auth tap)', ctl.status().locked === false);
    check('configure never returns a secret in its own result', !JSON.stringify(r0).includes(TOKEN) && !JSON.stringify(r0).includes(PASS));

    const got = ctl.getSecrets();
    check('round-trip: getSecrets() after configure returns exactly what was stored', got && got.token === TOKEN && got.user === USER && got.pass === PASS);

    ctl.lock('test');
    check('lock() wipes the in-memory secret', ctl.getSecrets() === null && ctl.status().locked === true);

    const wrong = ctl.unlock(WRONG_PIN);
    check('unlock refuses a wrong PIN', wrong.ok === false && wrong.error === 'wrong_pin' && ctl.getSecrets() === null);
    check('a failed unlock never returns a secret', !JSON.stringify(wrong).includes(TOKEN) && !JSON.stringify(wrong).includes(PASS));

    const right = ctl.unlock(PIN);
    check('unlock with the right PIN succeeds and restores the exact secrets', right.ok === true && ctl.getSecrets().token === TOKEN && ctl.getSecrets().pass === PASS);
    ctl.lock('test');

    // backoff: 5 free tries, then an increasing delay
    for (let i = 1; i <= 5; i++) ctl.unlock(WRONG_PIN);
    const stillFree = ctl._test.backoffRemainingMs();
    check('5 wrong tries cost nothing yet', stillFree === 0);
    const r6 = ctl.unlock(WRONG_PIN); // 6th attempt itself still *runs* (and is also wrong) but now sets a delay for the next one
    check('the 6th wrong try itself still runs, and now carries a backoff delay', r6.ok === false && r6.error === 'wrong_pin' && r6.retryAfterMs > 0);
    const blocked = ctl.unlock(PIN); // correct PIN, but still inside the backoff window -> refused without even trying
    check('a correct PIN inside the backoff window is refused without decrypting', blocked.ok === false && blocked.error === 'backoff' && blocked.retryAfterMs > 0);
    clock += blocked.retryAfterMs + 1;
    const afterWait = ctl.unlock(PIN);
    check('after the backoff window elapses, the right PIN works again', afterWait.ok === true);
    ctl.lock('test');

    // idle lock
    const u2 = ctl.unlock(PIN);
    check('unlocked again for the idle test', u2.ok === true);
    ctl.checkIdle(IDLE_LOCK_MS - 1);
    check('idle just under the threshold does not lock', ctl.status().locked === false);
    ctl.checkIdle(IDLE_LOCK_MS);
    check('idle at/over the threshold locks (powerMonitor.getSystemIdleTime() wiring in main.js)', ctl.status().locked === true);

    // plaintext scan — the whole point of the two-layer encryption
    const hits = scanForPlaintextSecrets(dir, [TOKEN, PASS, PIN]);
    check('nothing secret is ever written to disk in plaintext (token/pass/pin)', hits.length === 0, hits.slice(0, 3));
    check('the backoff metadata file holds no secret (plaintext by design, counters only)', fs.existsSync(path.join(dir, 'board-secrets.meta.json')) && JSON.stringify(JSON.parse(fs.readFileSync(path.join(dir, 'board-secrets.meta.json'), 'utf8'))).match(/^[{]"failedAttempts":\d+,"lockoutUntil":\d+[}]$/) !== null);
  } finally { rmrf(dir); }
}

// ====================================================================================================
// 3b. the owner app token is OPTIONAL (coordinator decision, auth-approved): absent or explicitly empty both
//     configure fine; user/pass stay required either way (shape validation).
// ====================================================================================================
{
  const dir = mkdtemp('secrets-no-token');
  try {
    const ctl = createSecretsController({ safeStorage: fakeSafeStorage, dir, now, log: () => {} });

    const absent = ctl.configure({ user: USER, pass: PASS, pin: PIN }); // token field not present at all
    check('configure succeeds with the token field entirely absent', absent.ok === true, absent);
    check('getSecrets() after an absent-token configure returns token: "" (never undefined/null)', ctl.getSecrets().token === '' && ctl.getSecrets().user === USER && ctl.getSecrets().pass === PASS);
    ctl.lock('test');

    const right = ctl.unlock(PIN);
    check('unlock still round-trips user/pass when the stored token is empty', right.ok === true && ctl.getSecrets().token === '' && ctl.getSecrets().pass === PASS);
    ctl.lock('test');
  } finally { rmrf(dir); }

  const dir2 = mkdtemp('secrets-empty-token');
  try {
    const ctl = createSecretsController({ safeStorage: fakeSafeStorage, dir: dir2, now, log: () => {} });
    const empty = ctl.configure({ token: '', user: USER, pass: PASS, pin: PIN }); // token field explicitly ''
    check('configure succeeds with an explicitly empty token string', empty.ok === true && ctl.getSecrets().token === '');
  } finally { rmrf(dir2); }

  const dir3 = mkdtemp('secrets-still-required');
  try {
    const ctl = createSecretsController({ safeStorage: fakeSafeStorage, dir: dir3, now, log: () => {} });
    const noUser = ctl.configure({ token: TOKEN, user: '', pass: PASS, pin: PIN });
    check('configure still refuses an empty user (only the token is optional)', noUser.ok === false && noUser.error === 'bad_secrets_shape');
    const noPass = ctl.configure({ token: TOKEN, user: USER, pass: '', pin: PIN });
    check('configure still refuses an empty pass (only the token is optional)', noPass.ok === false && noPass.error === 'bad_secrets_shape');
    const badTokenType = ctl.configure({ token: 12345, user: USER, pass: PASS, pin: PIN });
    check('configure refuses a non-string, non-absent token (shape check, not just emptiness)', badTokenType.ok === false && badTokenType.error === 'bad_secrets_shape');
  } finally { rmrf(dir3); }
}

// ====================================================================================================
// 4. board-live.mjs: egress allowlist + mode gate ("live mode requires configured+unlocked")
// ====================================================================================================
{
  const badDir = mkdtemp('egress-bad');
  let threw = null;
  try { createLiveBoard({ safeStorage: fakeSafeStorage, secretsDir: badDir, publicDir, upstream: 'https://evil.example/zumia' }); } catch (e) { threw = e; } finally { rmrf(badDir); }
  check('egress allowlist: a non-owner upstream is refused at construction (never reaches "on")', threw && /live board egress refused/.test(threw.message) && (!LIVE_ORIGIN || threw.message.includes(LIVE_ORIGIN)), threw && threw.message);
  check('LIVE_ORIGIN is exactly the owner value (owner-values.json liveOrigin), null without it', LIVE_ORIGIN === OWNER_ORIGIN, `${LIVE_ORIGIN} vs ${OWNER_ORIGIN}`);
  if (OWNER_ORIGIN) check('owner: the production default upstream is the owner origin', new URL(LIVE_UPSTREAM).origin === LIVE_ORIGIN);
  else check('public (no owner values): no live board upstream at all', LIVE_UPSTREAM === null);

  // No origin = no live board, in every tree: configured and unlocked secrets still never go live, open a bridge or relay.
  const noneDir = mkdtemp('no-live-board');
  try {
    const none = createLiveBoard({ safeStorage: fakeSafeStorage, secretsDir: noneDir, publicDir, now, upstream: null });
    none.secrets.configure({ token: TOKEN, user: USER, pass: PASS, pin: PIN });
    const r = await none.setMode('live');
    const relayed = await none.relay('ask.answer', {});
    const paired = await none.phone.pair();
    check('no origin: configured + unlocked, live is refused as no_live_board, no bridge, relay 401, no phone pairing', r.ok === false && r.error === 'no_live_board' && none.status().mode === 'local' && (await none.bridgePort()) === null && (await none.bridgeSessionUrl()) === null && relayed.status === 401 && paired.ok === false, { r, relayed, paired });
    await none.close();
  } finally { rmrf(noneDir); }
  if (!OWNER_ORIGIN) {
    const defDir = mkdtemp('no-live-board-default');
    try {
      const def = createLiveBoard({ safeStorage: fakeSafeStorage, secretsDir: defDir, publicDir, now });
      def.secrets.configure({ token: TOKEN, user: USER, pass: PASS, pin: PIN });
      check('public (no owner values): the default live board refuses live as no_live_board', (await def.setMode('live')).error === 'no_live_board');
      await def.close();
    } finally { rmrf(defDir); }
  }

  const dir = mkdtemp('mode-gate');
  try {
    const lb = createLiveBoard({ safeStorage: fakeSafeStorage, secretsDir: dir, publicDir, now, ...GATE_UPSTREAM });
    check('egress off: default mode is local, no bridge exists yet', (await lb.bridgePort()) === null);
    const r1 = await lb.setMode('live');
    check('live mode refused: not configured', r1.ok === false && r1.error === 'locked_or_unconfigured');

    lb.secrets.configure({ token: TOKEN, user: USER, pass: PASS, pin: PIN });
    const r2 = await lb.setMode('live');
    check('live mode allowed: configured + unlocked (configure() just unlocked it)', r2.ok === true && r2.mode === 'live');
    const port = await lb.bridgePort();
    check('egress on: a live bridge now exists (pointed at the allowlisted origin, no request sent yet)', Number.isInteger(port) && port > 0);

    const su = await lb.bridgeSessionUrl(); const hdr = await lb.bridgeHeaders();
    check('live board hands the host a session URL on the bridge port (single-use nonce) and in-process readers a caller header', new URL(su).port === String(port) && new URL(su).pathname === '/__bridge-session' && /^[0-9a-f]{64}$/.test(new URL(su).searchParams.get('n')) && /^[0-9a-f]{64}$/.test(hdr['x-zumi-bridge-token'] || ''));
    lb.secrets.lock('test');
    const r3 = await lb.setMode('live'); // re-entering live mode while locked is refused even though it was configured before
    check('live mode refused once locked, even if it was configured earlier', r3.ok === false && r3.error === 'locked_or_unconfigured');
    await lb.close();
  } finally { rmrf(dir); }

  // ownerOps (T-31 role-ui-port): createLiveBoard hands the bridge ownerOps only when the caller passed exactly true
  // (main.js passes OWNER_ADMIN, which is false in the release build), so the release bridge keeps the 403.
  for (const [label, arg, want] of [['release build (omitted)', undefined, false], ['release build (false)', false, false], ['owner build (true)', true, true], ['truthy non-boolean', 'yes', false]]) {
    const d = mkdtemp('owner-ops');
    try {
      let seen;
      const lb = createLiveBoard({ safeStorage: fakeSafeStorage, secretsDir: d, publicDir, now, ...GATE_UPSTREAM, ...(arg === undefined ? {} : { ownerOps: arg }), createBridgeImpl: (o) => { seen = o.ownerOps; return { port: async () => 1, close: async () => {} }; } });
      lb.secrets.configure({ token: TOKEN, user: USER, pass: PASS, pin: PIN });
      await lb.setMode('live');
      check(`ownerOps to the bridge: ${label} -> ${want}`, seen === want, { seen });
      await lb.close();
    } finally { rmrf(d); }
  }
}

// ====================================================================================================
// 5. the bridge: locked -> refuses; live-shaped auth (Basic + owner-token header + CSRF header) reaches a mock
//    upstream that requires all three on a write, and refuses the write when any one is missing.
// ====================================================================================================
{
  // A minimal stand-in for "nginx auth_basic in front of the live board" (see board-live.mjs's header comment /
  // the Laneboard cutover runbook): requires Basic on everything under /zumia/, and — on a
  // write — the CSRF header plus the owner-token header the live board reads to decide identity. The mock requires
  // the RAW token in `X-Laneboard-Token` (no "Bearer " prefix), so a passing write proves the bridge sends it exactly.
  const hits = [];
  const expectedBasic = `Basic ${Buffer.from(`${USER}:${PASS}`, 'utf8').toString('base64')}`;
  const mock = http.createServer((r, res) => {
    hits.push({ url: r.url, method: r.method });
    if (!r.url.startsWith('/zumia/')) { res.writeHead(404); return res.end('{"error":"not_found"}'); }
    if (r.headers.authorization !== expectedBasic) { res.writeHead(401); return res.end('{"error":"bad_basic"}'); } // the nginx gate
    if (r.method === 'POST') {
      if (r.headers['x-requested-with'] !== 'laneboard') { res.writeHead(403); return res.end('{"error":"missing_csrf"}'); }
      if (r.headers['x-laneboard-token'] !== TOKEN) { res.writeHead(401); return res.end('{"error":"missing_token"}'); }
      let body = ''; r.on('data', (c) => body += c); return r.on('end', () => { res.writeHead(200); res.end(JSON.stringify({ ok: true, ...JSON.parse(body) })); });
    }
    res.writeHead(200); res.end('{"role":"owner-proxy"}');
  });
  await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
  const upstream = `http://127.0.0.1:${mock.address().port}/zumia`; // path-prefixed, like the real live board (LIVE_UPSTREAM)

  try {
    // ---- locked: no basic, no bearer -> the bridge refuses before any upstream call is made ----
    const lockedBridge = createBridge({ upstreamOrigin: upstream, getToken: () => null, getBasicAuth: () => null, publicDir });
    const lport = await lockedBridge.port();
    const lockedResp = await req(lport, 'GET', '/api/v1/whoami');
    check('locked: the bridge refuses (401 locked) and never calls upstream', lockedResp.status === 401 && lockedResp.json?.error === 'locked' && hits.length === 0);
    await lockedBridge.close();

    // ---- live-shaped, both secrets present: Basic in Authorization + raw token in X-Laneboard-Token + path prefix ----
    const liveBridge = createBridge({ upstreamOrigin: upstream, getToken: () => TOKEN, getBasicAuth: () => ({ user: USER, pass: PASS }), publicDir });
    const port = await liveBridge.port();
    const who = await req(port, 'GET', '/api/v1/whoami');
    check('upstream path prefix is preserved (/zumia/api/v1/whoami, not /api/v1/whoami)', who.status === 200 && who.json?.role === 'owner-proxy' && hits.some((h) => h.url === '/zumia/api/v1/whoami'));
    const write = await liveBridge.relay('ask.answer', { target_id: 'ask-1', data: { choice: 'a' } });
    const writeJson = JSON.parse(write.text);
    check('write succeeds only because Basic + raw X-Laneboard-Token + CSRF header all reached the mock', write.status === 200 && writeJson.ok === true);
    check('no response body or hit log ever contains the raw token/pass (the leak-scan half of this case)', !JSON.stringify(hits).includes(TOKEN) && !JSON.stringify(hits).includes(PASS) && !write.text.includes(TOKEN) && !write.text.includes(PASS));
    await liveBridge.close();

    // ---- live-shaped but one required header missing each time: the mock's requirement proves each is necessary ----
    const basicOnly = createBridge({ upstreamOrigin: upstream, getToken: () => null, getBasicAuth: () => ({ user: USER, pass: PASS }), publicDir });
    const boPort = await basicOnly.port();
    const boWrite = await basicOnly.relay('ask.answer', { target_id: 'ask-1', data: { choice: 'a' } });
    check('Basic alone (no owner token): the mock refuses the write (missing_token)', boWrite.status === 401 && JSON.parse(boWrite.text).error === 'missing_token');
    await basicOnly.close();

    const bearerOnly = createBridge({ upstreamOrigin: upstream, getToken: () => TOKEN, getBasicAuth: () => null, publicDir });
    const beWrite = await bearerOnly.relay('ask.answer', { target_id: 'ask-1', data: { choice: 'a' } }); // Authorization becomes "Bearer <token>", which is not valid Basic
    check('bearer alone (no basic): the mock\'s nginx-shaped gate refuses it (bad_basic) — this is the header conflict board-live.mjs documents', beWrite.status === 401 && JSON.parse(beWrite.text).error === 'bad_basic');
    await bearerOnly.close();
  } finally { await new Promise((resolve) => mock.close(resolve)); }
}

// ====================================================================================================
// 6. ZUMI_BOARD_UPSTREAM test-only override (L1-UI-CONTRACT.md): release ignores it outright; a test build's
//    override is still refused by createLiveBoard unless it is a loopback http(s) URL.
// ====================================================================================================
{
  check('isTestBuild: a packaged build with no zumiTest flag is NOT a test build (release)', isTestBuild({ packaged: true, zumiTestFlag: false }) === false);
  check('isTestBuild: unpackaged (dev `electron .`) counts as a test build on its own', isTestBuild({ packaged: false, zumiTestFlag: false }) === true);
  check('isTestBuild: a packaged build WITH the zumiTest flag (scripts/builder-selftest.cjs) is a test build', isTestBuild({ packaged: true, zumiTestFlag: true }) === true);

  const releaseWithEnvSet = resolveBoardUpstream({ isTestBuild: false, envOverride: 'http://127.0.0.1:9999' });
  check('release ignores ZUMI_BOARD_UPSTREAM outright, whatever it is set to', releaseWithEnvSet.upstream === LIVE_UPSTREAM && releaseWithEnvSet.allowTestUpstream === false, releaseWithEnvSet);
  const testNoEnv = resolveBoardUpstream({ isTestBuild: true, envOverride: undefined });
  check('test build with no env var set: still the real upstream', testNoEnv.upstream === LIVE_UPSTREAM && testNoEnv.allowTestUpstream === false, testNoEnv);
  const testWithEnv = resolveBoardUpstream({ isTestBuild: true, envOverride: 'http://127.0.0.1:54321' });
  check('test build with the env var set: tries the override (createLiveBoard still has the final say)', testWithEnv.upstream === 'http://127.0.0.1:54321' && testWithEnv.allowTestUpstream === true, testWithEnv);

  const dir1 = mkdtemp('upstream-loopback-ok');
  try {
    const lb = createLiveBoard({ safeStorage: fakeSafeStorage, secretsDir: dir1, publicDir, now, upstream: 'http://127.0.0.1:54321', allowTestUpstream: true });
    check('a loopback http override IS accepted when allowTestUpstream is true', true);
    await lb.close();
  } catch (e) { check('a loopback http override IS accepted when allowTestUpstream is true', false, e.message); } finally { rmrf(dir1); }

  const dir2 = mkdtemp('upstream-loopback-localhost-ok');
  try {
    const lb = createLiveBoard({ safeStorage: fakeSafeStorage, secretsDir: dir2, publicDir, now, upstream: 'https://localhost:54322', allowTestUpstream: true });
    check('https://localhost is also accepted (http(s) to 127.0.0.1/localhost, not just http+127.0.0.1)', true);
    await lb.close();
  } catch (e) { check('https://localhost is also accepted (http(s) to 127.0.0.1/localhost, not just http+127.0.0.1)', false, e.message); } finally { rmrf(dir2); }

  const dir3 = mkdtemp('upstream-nonloopback-refused');
  let threw3 = null;
  try { createLiveBoard({ safeStorage: fakeSafeStorage, secretsDir: dir3, publicDir, now, upstream: 'http://evil.example', allowTestUpstream: true }); }
  catch (e) { threw3 = e; } finally { rmrf(dir3); }
  check('a non-loopback override is refused even with allowTestUpstream=true (not just http(s) anywhere)', threw3 !== null, threw3 && threw3.message);

  const dir4 = mkdtemp('upstream-release-env-set-but-ignored');
  // Simulates the actual main.js call path for a release build: resolveBoardUpstream already dropped the env
  // override (isTestBuild:false), so createLiveBoard only ever sees LIVE_UPSTREAM/allowTestUpstream:false — proving
  // "release ignores ZUMI_BOARD_UPSTREAM" end to end, not just at the resolveBoardUpstream step above.
  try {
    const r = resolveBoardUpstream({ isTestBuild: false, envOverride: 'http://127.0.0.1:1' }); // the release call site always passes isTestBuild:false
    const lb = createLiveBoard({ safeStorage: fakeSafeStorage, secretsDir: dir4, publicDir, now, upstream: r.upstream, allowTestUpstream: r.allowTestUpstream });
    check('end-to-end: a release build constructs the live board on the real origin even with ZUMI_BOARD_UPSTREAM set', r.upstream === LIVE_UPSTREAM && r.allowTestUpstream === false);
    await lb.close();
  } catch (e) { check('end-to-end: a release build constructs the live board on the real origin even with ZUMI_BOARD_UPSTREAM set', false, e.message); } finally { rmrf(dir4); }
}

// ====================================================================================================
// 7. Basic-only write against the REAL vendored Laneboard core (board.mjs/server.mjs), through a small shim that
//    emulates the ONE nginx behaviour this bridge's Basic-only path depends on: validate Authorization: Basic
//    itself, rewrite the /zumia/ location prefix (proxy_pass), and set X-Laneboard-Owner-Proxy to its own secret on
//    every request that passes Basic (server.mjs's `proxyOwner`). HONEST ABOUT WHAT THIS EMULATES: the real VPS
//    nginx.conf is untouched and out of scope (CLAUDE.md) — this shim is a stand-in for its proxy-owner behaviour
//    only, "as close as the server allows locally", not a copy of the deployed config. Proves, against the real
//    board core (not a synthetic mock like section 5 above):
//      a. no token configured -> the bridge sends Basic only, zero X-Laneboard-Token, and the write still lands,
//         attributed to the proxy-owner actor (role owner, via:'proxy') — the Basic-only path works end to end.
//      b. a token IS configured -> X-Laneboard-Token is sent even though Basic is ALSO present and valid, and
//         identity comes from the token (via is undefined, never 'proxy') — "with a token it still sends it".
//      c. no secret (the real bootstrap owner token, the Basic password) ever reaches an HTTP response body.
// ====================================================================================================
{
  const dataDir = mkdtemp('real-board');
  const BASIC_USER = 'kei-fake-user', BASIC_PASS = 'fake-nginx-pass-7x7x';
  const OWNER_PROXY_SECRET = `shim-secret-${Math.random().toString(36).slice(2)}`;
  let boardServer = null, shim = null;
  try {
    const board = createBoard({ dataDir, now });
    // The real bootstrap owner secret board.mjs just minted for this scratch board — stands in for the real
    // zumi-desktop owner token in case (b): a genuine, authenticate()-able owner credential, not a fixture string.
    const ownerToken = fs.readFileSync(path.join(dataDir, 'owner.token'), 'utf8').trim();
    boardServer = createServer(board, { ownerProxySecret: OWNER_PROXY_SECRET });
    const boardPort = await new Promise((resolve) => boardServer.listen(0, '127.0.0.1', () => resolve(boardServer.address().port)));

    const expectedBasic = `Basic ${Buffer.from(`${BASIC_USER}:${BASIC_PASS}`, 'utf8').toString('base64')}`;
    let shimHits = [];
    shim = http.createServer((shimReq, shimRes) => {
      if (!shimReq.url.startsWith('/zumia/')) { shimRes.writeHead(404); return shimRes.end('{"error":"not_found"}'); }
      if (shimReq.headers.authorization !== expectedBasic) { shimRes.writeHead(401); return shimRes.end('{"error":"bad_basic"}'); } // the nginx auth_basic gate
      shimHits.push({ url: shimReq.url, hadToken: 'x-laneboard-token' in shimReq.headers, hadCsrf: shimReq.headers['x-requested-with'] === 'laneboard' });
      const headers = { ...shimReq.headers };
      delete headers.host;
      headers['x-laneboard-owner-proxy'] = OWNER_PROXY_SECRET; // nginx sets this itself (proxy_set_header) -- a client-sent value would never survive the real hop
      const upstreamReq = http.request({ host: '127.0.0.1', port: boardPort, path: shimReq.url.slice('/zumia'.length) || '/', method: shimReq.method, headers }, (upRes) => {
        shimRes.writeHead(upRes.statusCode, upRes.headers);
        upRes.pipe(shimRes);
      });
      shimReq.pipe(upstreamReq);
    });
    const shimPort = await new Promise((resolve) => shim.listen(0, '127.0.0.1', () => resolve(shim.address().port)));
    const upstream = `http://127.0.0.1:${shimPort}/zumia`;

    // ---- (a) Basic-only: nothing configured as a token anywhere -> the bridge omits X-Laneboard-Token entirely ----
    const basicOnlyBridge = createBridge({ upstreamOrigin: upstream, getToken: () => '', getBasicAuth: () => ({ user: BASIC_USER, pass: BASIC_PASS }), publicDir });
    const bPort = await basicOnlyBridge.port();
    const write1 = await req(bPort, 'POST', '/api/v1/write', { body: { op: 'ping.send', target_id: 'board', request_id: 'proof-basic-only-aaa', data: { kind: 'send', task_id: '', note: 'basic-only proof' } } });
    check('Basic-only write against the REAL vendored board (nginx-shim proxy-owner path) succeeds', write1.status === 200 && write1.json?.ok === true, write1.text.slice(0, 300));
    check('the shim never saw X-Laneboard-Token on that write (the bridge omitted it, not just the board ignoring it)', shimHits.length === 1 && shimHits[0].hadToken === false);
    check("the write still carried the CSRF header (server.mjs's proxyOwner requires it on non-GET/HEAD)", shimHits[0] && shimHits[0].hadCsrf === true);
    const whoProxy = await req(bPort, 'GET', '/api/v1/whoami');
    check('whoami (still Basic-only) resolves to the owner via the proxy path', whoProxy.status === 200 && whoProxy.json?.role === 'owner' && whoProxy.json?.via === 'proxy', whoProxy.json);
    await basicOnlyBridge.close();

    // ---- (b) a token IS configured: X-Laneboard-Token is sent, and identity comes from the token, not the proxy ----
    shimHits = [];
    const tokenBridge = createBridge({ upstreamOrigin: upstream, getToken: () => ownerToken, getBasicAuth: () => ({ user: BASIC_USER, pass: BASIC_PASS }), publicDir });
    const tPort = await tokenBridge.port();
    const write2 = await req(tPort, 'POST', '/api/v1/write', { body: { op: 'ping.send', target_id: 'board', request_id: 'proof-token-path-bbb', data: { kind: 'send', task_id: '', note: 'token-path proof' } } });
    check('with a token configured, the write still succeeds (now via the token path)', write2.status === 200 && write2.json?.ok === true, write2.text.slice(0, 300));
    check('with a token configured, the bridge DOES send X-Laneboard-Token ("optional" never means "silently disabled")', shimHits.length === 1 && shimHits[0].hadToken === true);
    const whoToken = await req(tPort, 'GET', '/api/v1/whoami');
    check('whoami with a token present resolves via the token (via is undefined, never "proxy") -- the token always wins once sent', whoToken.status === 200 && whoToken.json?.role === 'owner' && whoToken.json?.via === undefined, whoToken.json);
    await tokenBridge.close();

    // ---- (c) no secret ever reaches an HTTP response body ----
    const bodies = JSON.stringify([write1.text, write2.text, whoProxy.text, whoToken.text]);
    check('no secret (the real owner token / Basic password) ever appears in a response body', !bodies.includes(ownerToken) && !bodies.includes(BASIC_PASS));
  } finally {
    if (shim) await new Promise((resolve) => shim.close(resolve));
    if (boardServer) await new Promise((resolve) => boardServer.close(resolve));
    rmrf(dataDir);
  }
}

// ====================================================================================================
// 7b. board-live.mjs relay gate (T-31 0.2.3 batch C): the app's own ask.answer write is delegated to the SAME bridge
//     only while the board is live AND unlocked; a local/mirror or locked board is refused with 401 `locked` before
//     any bridge or network call (the mirror is read-only — a write must be refused, not attempted).
// ====================================================================================================
{
  const dir = mkdtemp('relay-gate');
  try {
    let relayed = null;
    const fakeBridge = { port: async () => 1, close: async () => {}, relay: async (op, body) => { relayed = { op, body }; return { status: 200, text: '{"ok":true}' }; } };
    const lb = createLiveBoard({ safeStorage: fakeSafeStorage, secretsDir: dir, publicDir, now, ...GATE_UPSTREAM, createBridgeImpl: () => fakeBridge });

    const locked1 = await lb.relay('ask.answer', { target_id: 'ask-1', expected_revision: 1, data: { choice: 'A' } }); // local mode
    check('relay gate: local/unconfigured -> 401 locked, never delegated', locked1.status === 401 && JSON.parse(locked1.text).error === 'locked' && relayed === null, locked1);

    lb.secrets.configure({ token: TOKEN, user: USER, pass: PASS, pin: PIN }); // configure() also unlocks
    await lb.setMode('live');
    const okRelay = await lb.relay('ask.answer', { target_id: 'ask-1', expected_revision: 1, data: { choice: 'A' } });
    check('relay gate: live + unlocked -> delegated to the bridge relay', okRelay.status === 200 && relayed && relayed.op === 'ask.answer', { okRelay, relayed });

    lb.secrets.lock('test'); // still mode 'live', but locked again
    relayed = null;
    const locked2 = await lb.relay('ask.answer', { target_id: 'ask-1', expected_revision: 1, data: { choice: 'A' } });
    check('relay gate: locked again -> 401 locked, never delegated', locked2.status === 401 && JSON.parse(locked2.text).error === 'locked' && relayed === null, locked2);
    await lb.close();
  } finally { rmrf(dir); }
}

// Wiring pins (no Electron here): main.js hands the webview the session URL and app.js loads it first. Without these
// two the webview opens origin/ with no cookie, gets 401 and the board is blank (E2 covers the real run).
{
  const rd = (rel) => fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', rel), 'utf8');
  const mainSrc = rd('src/main/main.js'), appSrc = rd('src/renderer/app.js');
  const at = mainSrc.indexOf("ipcMain.handle('board:live-open'");
  const openHandler = at < 0 ? '' : mainSrc.slice(at, mainSrc.indexOf('});', at));
  check('main.js board:live-open returns openUrl from liveBoard.bridgeSessionUrl()', at >= 0 && openHandler.includes('openUrl: await liveBoard.bridgeSessionUrl()'), openHandler.slice(-160));
  check('renderer app.js loads r.openUrl first (falls back to homeUrl), and reloads keep using dataset.home', appSrc.includes("setAttribute('src', withEmbedLang(r.openUrl || homeUrl).href)") && appSrc.includes('webview.dataset.home = homeUrl'));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length ? 'FAIL' : 'PASS'} check-board-live — ${results.length - failed.length}/${results.length} assertions passed`);
process.exitCode = failed.length ? 1 : 0;
