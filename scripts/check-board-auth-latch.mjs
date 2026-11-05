// T-31 0.2.11 auth-401 check: a live board that answers 401 (wrong sign-in) must be asked ONCE, not polled forever.
// The 401 latch (board-live.mjs `authRejected`) is set only at the bridge's UPSTREAM edge (board-bridge.mjs, after
// upstreamFetch); the reader and the bridge skip upstream while it is set; configure / configureOs / signOut /
// unlock clear it; a late 401 from an older sign-in (credential generation) is ignored.
// A bridge-generated 401 (PIN-locked `locked`, missing caller token `unauthorized`) never latches; 5xx stays retried.
// Also measures the fresh-install case: no board configured -> the HUD poller opens ZERO TCP connections.
// Node only, no Electron, NO network beyond 127.0.0.1 stubs. Time is simulated (node:test mock timers: setInterval +
// Date), the HTTP is real loopback.
//   node scripts/check-board-auth-latch.mjs   (or: npm run check:board-auth-latch)
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { mock } from 'node:test';
import { createLiveBoard } from '../src/main/board-live.mjs';
import { createBoardReader } from '../src/main/board-reader.mjs';
import { createHudHost } from '../src/main/hud-host.mjs';
import { answerOutcome, createAskAnswerer } from '../src/main/hud-answer.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'vendor', 'laneboard', 'public');
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: Boolean(ok) }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`); };

const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from([...Buffer.from(s, 'utf8')].map((b) => b ^ 0x5a)),
  decryptString: (b) => Buffer.from([...b].map((x) => x ^ 0x5a)).toString('utf8'),
};
const CREDS = { token: '', user: 'fake-user', pass: 'fake-pass-wrong' };
const CREDS2 = { token: '', user: 'fake-user', pass: 'fake-pass-right' };
const PIN = '482913';
const tmpDirs = [];
const mkdtemp = (tag) => { const d = path.join(root, `.check-auth-latch-${tag}-${process.pid}-${Math.random().toString(36).slice(2)}`); fs.mkdirSync(d, { recursive: true }); tmpDirs.push(d); return d; };

// ---- stub upstream (the live board's nginx + Laneboard), counts every request it sees ----
const stub = { mode: '401', hits: [], delayMs: 0 };
const upstreamServer = http.createServer((req, res) => {
  stub.hits.push(req.url);
  const mode = stub.mode; // decided on ARRIVAL: a delayed answer keeps the verdict of the credentials it was sent with
  if (stub.delayMs) return void setTimeout(() => answer(mode, res), stub.delayMs);
  return answer(mode, res);
});
function answer(mode, res) {
  if (mode === '401') { res.writeHead(401, { 'Content-Type': 'text/html' }); return res.end('<html><head><title>401 Authorization Required</title></head></html>'); }
  if (mode === '503') { res.writeHead(503, { 'Content-Type': 'text/html' }); return res.end('bad gateway'); }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  return res.end(JSON.stringify({ tasks: [] }));
}
await new Promise((r) => upstreamServer.listen(0, '127.0.0.1', r));
const UPSTREAM = `http://127.0.0.1:${upstreamServer.address().port}/zumia`;

function bridgeReq(port, p, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method: 'GET', path: p, headers: { connection: 'close', ...headers } }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => { let json = null; try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not json */ } resolve({ status: res.statusCode, json }); });
    });
    r.on('error', reject); r.end();
  });
}

// ---- simulated time: the HUD's 5 s setInterval + Date.now are fake; each tick awaits the read it started ----
mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1_700_000_000_000 });

/** A live board + the SAME reader/HUD wiring main.js uses, with talk on and the HUD hidden (default install). */
function rig(tag) {
  const liveBoard = createLiveBoard({ safeStorage: fakeSafeStorage, secretsDir: mkdtemp(tag), publicDir, upstream: UPSTREAM, allowTestUpstream: true });
  const reader = createBoardReader({ liveBoard });
  let pending = null;
  const reasons = [];
  const getState = (o) => { pending = reader.getState(o).then((r) => { reasons.push(r.ok ? 'ok' : r.reason); return r; }); return pending; };
  const hud = createHudHost({ getState, idleSeconds: () => 0, settings: { get: () => ({ hudStyle: 'off' }), set() {} }, send() {}, decide: () => ({}), open() {}, talkActive: () => true });
  const settle = async () => { for (let i = 0; i < 3; i++) { if (pending) { const p = pending; await p; if (p === pending) pending = null; } await new Promise((r) => setImmediate(r)); } };
  /** Advance simulated time by `ms` in 5 s HUD ticks, letting each started read finish (real loopback I/O). */
  const advance = async (ms) => { for (let t = 0; t < ms; t += 5000) { mock.timers.tick(5000); await settle(); } };
  return { liveBoard, reader, hud, settle, advance, reasons };
}
const FIVE_MIN = 5 * 60_000;
const errOf = (text) => { try { return JSON.parse(text).error; } catch { return null; } };

// ---- 1. fresh OSS install, nothing configured: the poller must open ZERO connections (measured at the socket) ----
{
  const connects = [];
  const realConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) { connects.push(typeof args[0] === 'object' ? `${args[0].host}:${args[0].port}` : String(args[0])); return realConnect.apply(this, args); };
  stub.hits = [];
  const r = rig('fresh');
  r.hud.start(); await r.settle();
  await r.advance(FIVE_MIN);
  r.hud.stop();
  net.Socket.prototype.connect = realConnect;
  check('fresh install: liveBoard is local + unconfigured', r.liveBoard.status().mode === 'local' && r.liveBoard.status().configured === false, r.liveBoard.status());
  check('fresh install: the HUD poller read the board (talk on, HUD off)', r.reasons.length >= 10, { reads: r.reasons.length, reasons: [...new Set(r.reasons)] });
  check('fresh install: every read short-circuits as unconfigured', r.reasons.every((x) => x === 'unconfigured'), [...new Set(r.reasons)]);
  check('fresh install: ZERO outbound TCP connections over 5 simulated min', connects.length === 0, connects);
  check('fresh install: the stub upstream saw nothing', stub.hits.length === 0, stub.hits);
  check('fresh install: no bridge exists', (await r.liveBoard.bridgePort()) === null);
  await r.liveBoard.close();
}

// ---- 2. wrong sign-in: upstream 401 -> latch; EXACTLY 1 upstream request over 5 simulated minutes ----
let latched;
{
  stub.mode = '401'; stub.hits = [];
  const r = rig('latch');
  check('latch: configureOs ok', r.liveBoard.secrets.configureOs(CREDS).ok === true);
  check('latch: setMode live ok', (await r.liveBoard.setMode('live')).ok === true);
  r.hud.start(); await r.settle();
  await r.advance(FIVE_MIN);
  check('latch: stub upstream saw EXACTLY 1 request in 5 min after the 401', stub.hits.length === 1, { hits: stub.hits.length });
  check('latch: board status says authRejected', r.liveBoard.status().authRejected === true, r.liveBoard.status());
  check('latch: reader reports auth_rejected', r.reasons.slice(1).every((x) => x === 'auth_rejected') && r.reasons.length > 1, [...new Set(r.reasons)]);
  // the bridge itself refuses upstream while latched (the Board tab page / any loopback reader)
  const port = await r.liveBoard.bridgePort();
  const viaBridge = await bridgeReq(port, '/api/v1/whoami', (await r.liveBoard.bridgeHeaders()));
  check('latch: bridge answers 401 auth_rejected locally, no upstream call', viaBridge.status === 401 && viaBridge.json?.error === 'auth_rejected' && stub.hits.length === 1, { status: viaBridge.status, body: viaBridge.json, hits: stub.hits.length });
  const relay = await r.liveBoard.relay('feedback.add', { text: 'x' });
  check('latch: relay write refused locally with auth_rejected', relay.status === 401 && errOf(relay.text) === 'auth_rejected' && stub.hits.length === 1, { relay, hits: stub.hits.length });
  latched = r;
}

// ---- 3. configure (Change sign-in) clears the latch and polling resumes ----
{
  const r = latched;
  stub.mode = '200';
  check('clear: configureOs with new sign-in ok', r.liveBoard.secrets.configureOs(CREDS2).ok === true);
  check('clear: authRejected cleared by configureOs', !r.liveBoard.status().authRejected, r.liveBoard.status());
  const before = stub.hits.length;
  await r.advance(60_000);
  check('clear: polling resumed and reached upstream', stub.hits.length > before, { before, after: stub.hits.length });
  check('clear: reader reads ok again', r.reasons.at(-1) === 'ok', r.reasons.slice(-3));
  // latch again, then the PIN-sealed configure path (Change sign-in on a PIN install) clears it too
  stub.mode = '401';
  await r.reader.getState({ maxAgeMs: 0 });
  check('clear: re-latched on a new upstream 401', r.liveBoard.status().authRejected === true);
  check('clear: configure (PIN) clears the latch', r.liveBoard.secrets.configure({ ...CREDS2, pin: PIN }).ok === true && !r.liveBoard.status().authRejected, r.liveBoard.status());
  await r.reader.getState({ maxAgeMs: 0 });
  check('clear: re-latched again', r.liveBoard.status().authRejected === true);
  const so = r.liveBoard.secrets.signOut(PIN);
  check('clear: signOut clears the latch', so.ok === true && !r.liveBoard.status().authRejected, { so, st: r.liveBoard.status() });
  // unlock clears it too (review probe F): the cause of a 401 may be fixed server-side; one request re-latches if not
  check('clear: configure again ok', r.liveBoard.secrets.configure({ ...CREDS, pin: PIN }).ok === true);
  await r.reader.getState({ maxAgeMs: 0 });
  r.liveBoard.secrets.lock('manual');
  r.liveBoard.secrets.unlock(PIN);
  check('clear: unlock clears the latch (server-side fix, then unlock)', !r.liveBoard.status().authRejected, r.liveBoard.status());
  // probe F: the board is fixed server-side; lock + unlock with the SAME sign-in -> one request, reads ok again
  await r.reader.getState({ maxAgeMs: 0 });
  check('F: latched again before the server fix', r.liveBoard.status().authRejected === true);
  stub.mode = '200';
  r.liveBoard.secrets.lock('manual');
  const hitsBeforeUnlock = stub.hits.length;
  check('F: unlock ok', r.liveBoard.secrets.unlock(PIN).ok === true);
  const afterFix = await r.reader.getState({ maxAgeMs: 0 });
  check('F: after unlock the next read reaches upstream and is ok', afterFix.ok === true && stub.hits.length === hitsBeforeUnlock + 1 && !r.liveBoard.status().authRejected, { afterFix: afterFix.ok, hits: stub.hits.length - hitsBeforeUnlock });
  // still wrong server-side: unlock costs exactly one request, which re-latches (no loop)
  stub.mode = '401';
  await r.reader.getState({ maxAgeMs: 0 });
  r.liveBoard.secrets.lock('manual'); r.liveBoard.secrets.unlock(PIN);
  const h0 = stub.hits.length;
  await r.advance(FIVE_MIN);
  check('F: unlock with still-wrong creds -> exactly 1 request in 5 min, re-latched', stub.hits.length === h0 + 1 && r.liveBoard.status().authRejected === true, { hits: stub.hits.length - h0, st: r.liveBoard.status() });
  r.hud.stop();
  await r.liveBoard.close();
}

// ---- 4. a LOCAL locked-PIN 401 never latches ----
{
  stub.mode = '401'; stub.hits = [];
  const r = rig('locked');
  check('locked: configure (PIN) ok', r.liveBoard.secrets.configure({ ...CREDS, pin: PIN }).ok === true);
  check('locked: setMode live ok', (await r.liveBoard.setMode('live')).ok === true);
  const port = await r.liveBoard.bridgePort();
  const headers = await r.liveBoard.bridgeHeaders();
  r.liveBoard.secrets.lock('manual');
  const viaBridge = await bridgeReq(port, '/api/v1/state', headers);
  check('locked: bridge answers its own 401 locked', viaBridge.status === 401 && viaBridge.json?.error === 'locked', viaBridge);
  const noCaller = await bridgeReq(port, '/api/v1/state');
  check('locked: missing caller token -> bridge 401 unauthorized', noCaller.status === 401 && noCaller.json?.error === 'unauthorized', noCaller);
  const relay = await r.liveBoard.relay('feedback.add', { text: 'x' });
  check('locked: relay 401 locked', relay.status === 401 && errOf(relay.text) === 'locked', relay);
  r.hud.start(); await r.settle();
  await r.advance(FIVE_MIN);
  check('locked: reader says locked, never auth_rejected', r.reasons.every((x) => x === 'locked'), [...new Set(r.reasons)]);
  check('locked: authRejected NOT set by local 401s', !r.liveBoard.status().authRejected, r.liveBoard.status());
  check('locked: stub upstream saw nothing', stub.hits.length === 0, stub.hits);
  // unlock -> the first upstream 401 is a real credential rejection and does latch
  r.liveBoard.secrets.unlock(PIN);
  await r.reader.getState({ maxAgeMs: 0 });
  check('locked: after unlock, a real upstream 401 latches', r.liveBoard.status().authRejected === true && stub.hits.length === 1, { st: r.liveBoard.status(), hits: stub.hits.length });
  r.hud.stop();
  await r.liveBoard.close();
}

// ---- 4b. probe H: a late 401 from the OLD sign-in must not latch a just-saved new one ----
{
  stub.mode = '401'; stub.hits = []; stub.delayMs = 600;
  const r = rig('stale');
  r.liveBoard.secrets.configureOs(CREDS);
  await r.liveBoard.setMode('live');
  const inflight = r.reader.getState({ maxAgeMs: 0 }); // old (wrong) creds, answered 401 after 600 ms
  while (stub.hits.length === 0) await new Promise((res) => setImmediate(res));
  stub.mode = '200'; stub.delayMs = 0;
  check('H: new sign-in saved while the old read is in flight', r.liveBoard.secrets.configureOs(CREDS2).ok === true);
  await inflight;
  check('H: the stale 401 did NOT latch the new sign-in', !r.liveBoard.status().authRejected, r.liveBoard.status());
  const next = await r.reader.getState({ maxAgeMs: 0 });
  check('H: the next read uses the new sign-in and is ok', next.ok === true && stub.hits.length === 2, { ok: next.ok, hits: stub.hits.length });
  await r.liveBoard.close();
}

// ---- 5. 5xx / network errors stay retryable (no latch) ----
{
  stub.mode = '503'; stub.hits = [];
  const r = rig('5xx');
  r.liveBoard.secrets.configureOs(CREDS);
  await r.liveBoard.setMode('live');
  r.hud.start(); await r.settle();
  await r.advance(FIVE_MIN);
  check('5xx: retried on the normal cadence (>= 7 upstream hits in 5 min)', stub.hits.length >= 7, { hits: stub.hits.length });
  check('5xx: no latch', !r.liveBoard.status().authRejected, r.liveBoard.status());
  check('5xx: reader reports http_503', r.reasons.every((x) => x === 'http_503'), [...new Set(r.reasons)]);
  r.hud.stop();
  await r.liveBoard.close();
}

// ---- 6. HUD answer taxonomy: auth_rejected is its own reason, not retryable "failed", not "locked" ----
{
  check('answer: 401 auth_rejected -> auth_rejected', answerOutcome({ status: 401, text: '{"error":"auth_rejected"}' }).reason === 'auth_rejected');
  check('answer: raw upstream 401 (nginx HTML) -> auth_rejected', answerOutcome({ status: 401, text: '<html>401</html>' }).reason === 'auth_rejected');
  check('answer: 401 locked -> locked (unchanged)', answerOutcome({ status: 401, text: '{"error":"locked"}' }).reason === 'locked');
  let relayed = 0;
  const answerer = createAskAnswerer({ ownerAdmin: true, relay: async () => { relayed++; return { status: 200, text: '{}' }; }, boardStatus: () => ({ mode: 'live', configured: true, locked: false, authRejected: true }) });
  const out = await answerer.answer({ id: 'A-1', rev: 1, choice: 'yes' });
  check('answer: latched board refuses before any relay call', out.ok === false && out.reason === 'auth_rejected' && relayed === 0, { out, relayed });
}

// ---- 7. the rejected state has a visible way out everywhere it shows (HUD note, HUD answer error, Board tab) ----
{
  const read = (...p) => fs.readFileSync(path.join(root, 'src', 'renderer', ...p), 'utf8');
  const html = read('index.html'), hudJs = read('hud', 'hud.js'), appJs = read('app.js'), settingsJs = read('settings.js'), i18n = read('i18n.js');
  const updates = html.slice(html.indexOf('hud-updates"><header'), html.indexOf('id="hud-updates"'));
  check('way out: HUD updates panel carries a #hud-signin button (Change sign-in)', /<button id="hud-signin"[^>]*data-i18n="board.rejected.action"/.test(updates));
  check('way out: hud.js shows #hud-signin only for auth_rejected', /\$\('hud-signin'\)\.hidden = [^;]*auth_rejected/.test(hudJs) || /\$\('hud-signin'\)\.hidden = !rejected/.test(hudJs));
  check('way out: hud.js answer error offers the sign-in action on auth_rejected', /chosen\.error === 'auth_rejected'[^\n]*signinButton\(\)/.test(hudJs));
  check('way out: HUD buttons open the board sign-in (zumi:board-signin event)', /dispatchEvent\(new CustomEvent\('zumi:board-signin'\)\)/.test(hudJs));
  const hudCss = read('hud', 'hud.css');
  check('way out: #hud-signin is clickable (pointer-events:auto under the click-through HUD root)', /\.hud-signin \{[^}]*pointer-events: auto/.test(hudCss));
  check('way out: the Board tab rejected button opens the sign-in form too', /zumi:board-signin/.test(appJs));
  check('way out: settings opens Account + the sign-in form on zumi:board-signin', /addEventListener\('zumi:board-signin'[\s\S]{0,400}formOpen = true/.test(settingsJs));
  const viBody = (i18n.match(/'board\.rejected\.body': '([^']*)'/g) || [])[1] || '';
  check('VI copy: board.rejected.body says "đăng nhập" at most once', (viBody.match(/đăng nhập/gi) || []).length <= 1, viBody);
}

mock.timers.reset();
upstreamServer.close();
for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
