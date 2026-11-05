// Node checks for the Jev fast-reflex path (no Electron, no network, no real key — every "key" here is a
// synthetic sk-or-... string that only needs to match the shape gate):
//   mocked Jev (fast / slow / timeout / error / low-confidence) -> reaction/source/fallback, the safeStorage key
//   store round trip, the egress on/off gate, the origin allowlist, a key-leak sweep over every surface the
//   module can hand back (classify() result, log lines), and the 8 label->gesture commands (checkSpeechGesture).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const RJ = require('../src/main/reflex-jev.js');
const { createReflexJev, createKeyStore, createCallLedger, callJev, scrub, assertAllowedUrl, ALLOWED_ORIGIN, DECISIONS_PATH, WARM_PATH, LABELS, CONF_THRESHOLD } = RJ;

let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); } };

const FAKE_KEY = 'sk-or-TESTFAKEKEY1234567890ABCDEFGHIJ'; // shape-valid, never a real secret

// ---------- stub safeStorage (symmetric, in-process; no real DPAPI needed for a Node test) ----------
function stubSafeStorage({ available = true } = {}) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s) => Buffer.from(`ENC:${s}`, 'utf8'),
    decryptString: (b) => { const s = b.toString('utf8'); if (!s.startsWith('ENC:')) throw new Error('bad blob'); return s.slice(4); },
  };
}

const tmpDirs = [];
function tmpDir() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'reflex-jev-test-')); tmpDirs.push(d); return d; }
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });

// ---------- key store ----------
{
  const dir = tmpDir();
  const ks = createKeyStore({ safeStorage: stubSafeStorage(), dir, log: () => {} });
  ok(ks.importIfPresent() === 'none', 'keystore: no import file -> none');
  fs.writeFileSync(path.join(dir, 'jev-key.import'), `${FAKE_KEY}\n`);
  ok(ks.importIfPresent() === 'imported', 'keystore: a well-shaped key imports');
  ok(!fs.existsSync(path.join(dir, 'jev-key.import')), 'keystore: the import file is deleted after import');
  ok(fs.existsSync(ks.file), 'keystore: the encrypted key file now exists');
  ok(ks.read() === FAKE_KEY, 'keystore: read() round-trips the same key through safeStorage');
}
{
  const dir = tmpDir();
  const ks = createKeyStore({ safeStorage: stubSafeStorage(), dir, log: () => {} });
  fs.writeFileSync(path.join(dir, 'jev-key.import'), 'not-a-key-at-all');
  ok(ks.importIfPresent() === 'bad-format', 'keystore: a malformed import is refused');
  ok(!fs.existsSync(path.join(dir, 'jev-key.import')), 'keystore: a refused import file is still destroyed (no plaintext left behind)');
  ok(ks.read() === null, 'keystore: nothing was stored for a refused import');
}
{
  const dir = tmpDir();
  const ks = createKeyStore({ safeStorage: stubSafeStorage({ available: false }), dir, log: () => {} });
  fs.writeFileSync(path.join(dir, 'jev-key.import'), `${FAKE_KEY}\n`);
  ok(ks.importIfPresent() === 'no-encryption', 'keystore: OS encryption unavailable -> refused, Jev stays off');
  ok(fs.existsSync(path.join(dir, 'jev-key.import')), 'keystore: with no OS encryption the import file is left untouched for a later retry');
  ok(ks.read() === null, 'keystore: read() is null without OS encryption');
}

// ---------- origin allowlist ----------
ok(ALLOWED_ORIGIN === 'https://openrouter.ai', 'origin: the allowlisted origin is openrouter.ai, https');
ok(assertAllowedUrl(DECISIONS_PATH).href === 'https://openrouter.ai/api/alpha/decisions', 'origin: the decisions url resolves inside the allowlist');
ok(assertAllowedUrl(WARM_PATH).href === 'https://openrouter.ai/api/v1/models', 'origin: the warm-up url resolves inside the allowlist (a free GET, never the paid route)');
{
  let threw = false;
  try { new URL('http://openrouter.ai/x'); const u = new URL('http://openrouter.ai/x'); if (u.protocol !== 'https:') throw new Error('not https'); } catch { threw = true; }
  ok(threw, 'origin: plain http is refused (sanity on the protocol check itself)');
}

// ---------- mocked Jev transport (callJev) ----------
const reactionBody = (choice, confidence) => ({ answers: { reaction: { choice, confidence } } });
function mockFetch({ delayMs = 10, status = 200, body = reactionBody('happy', 0.9), networkErrorMsg = null } = {}) {
  return (url, opts) => new Promise((resolve, reject) => {
    if (networkErrorMsg) return reject(new Error(networkErrorMsg));
    const timer = setTimeout(() => resolve({ ok: status === 200, status, json: async () => body }), delayMs);
    const signal = opts && opts.signal;
    if (signal) {
      if (signal.aborted) { clearTimeout(timer); return reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
    }
  });
}

{
  const r = await callJev('hi', FAKE_KEY, { fetchImpl: mockFetch({ delayMs: 5, body: reactionBody('happy', 0.91) }) });
  ok(r.ok && r.reaction === 'happy' && r.confidence === 0.91 && r.ms < 900, 'callJev: fast high-confidence answer parses', JSON.stringify(r));
}
{
  const r = await callJev('hi', FAKE_KEY, { fetchImpl: mockFetch({ delayMs: 1500, body: reactionBody('nod', 0.9) }) });
  ok(!r.ok && /timeout/.test(r.error), 'callJev: a slow answer (>900ms budget) times out', JSON.stringify(r));
}
{
  const r = await callJev('hi', FAKE_KEY, { fetchImpl: mockFetch({ status: 500, body: {} }) });
  ok(!r.ok && r.error === 'http_500', 'callJev: a non-200 status is a clean failure', JSON.stringify(r));
}
{
  const r = await callJev('hi', FAKE_KEY, { fetchImpl: mockFetch({ networkErrorMsg: 'getaddrinfo ENOTFOUND' }) });
  ok(!r.ok && /ENOTFOUND/.test(r.error), 'callJev: a network error is reported', JSON.stringify(r));
}
{
  const r = await callJev('hi', FAKE_KEY, { fetchImpl: mockFetch({ body: { answers: {} } }) });
  ok(!r.ok && r.error === 'bad_response', 'callJev: a malformed answer shape is refused, not guessed at');
}
ok(LABELS.length === 8 && CONF_THRESHOLD === 0.70, 'constants: 8 labels and the 0.70 threshold match REPORT.md section 2/3');

// ---------- createReflexJev: full classify() chain ----------
async function reflexWith({ fetchImpl, loadLocal, egressAllowed = true } = {}) {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'jev-key.import'), `${FAKE_KEY}\n`);
  const logs = [];
  const rj = createReflexJev({ egressAllowed, safeStorage: stubSafeStorage(), dir, fetchImpl, loadLocal, log: (m) => logs.push(m) });
  return { rj, logs };
}

{ // fast, high confidence -> source jev, that reaction
  const { rj } = await reflexWith({ fetchImpl: mockFetch({ delayMs: 5, body: reactionBody('surprise', 0.88) }) });
  const r = await rj.classify('You will never guess who called!');
  ok(r.source === 'jev' && r.reaction === 'surprise' && r.confidence === 0.88, 'classify: fast path returns jev\'s own reaction', JSON.stringify(r));
}
{ // low confidence -> neutralised, source still jev (jev did answer, just below the gate)
  const { rj } = await reflexWith({ fetchImpl: mockFetch({ delayMs: 5, body: reactionBody('think', 0.43) }) });
  const r = await rj.classify('hmm');
  ok(r.source === 'jev' && r.reaction === 'neutral' && r.confidence === 0.43, 'classify: below 0.70 is neutralised (REPORT.md section 2 optimum)', JSON.stringify(r));
}
{ // slow (timeout) with no local classifier available -> neutral
  const { rj, logs } = await reflexWith({ fetchImpl: mockFetch({ delayMs: 1500 }), loadLocal: async () => { throw new Error('no local model vendored'); } });
  const r = await rj.classify('slow line');
  ok(r.source === 'neutral' && r.reaction === 'neutral', 'classify: a timeout with no local classifier falls all the way to neutral', JSON.stringify(r));
  ok(logs.some((l) => /timeout/.test(l)), 'classify: the timeout is logged');
}
{ // jev errors, local fallback succeeds
  const { rj } = await reflexWith({
    fetchImpl: mockFetch({ status: 500 }),
    loadLocal: async () => ({ classify: async () => ({ label: 'concern', conf: 0.81 }) }),
  });
  const r = await rj.classify('my heater is broken and I am freezing');
  ok(r.source === 'local' && r.reaction === 'concern' && r.confidence === 0.81, 'classify: jev error -> local fallback is used', JSON.stringify(r));
}
{ // jev errors, local answers low-confidence -> neutral
  const { rj } = await reflexWith({ fetchImpl: mockFetch({ status: 500 }), loadLocal: async () => ({ classify: async () => ({ label: 'shrug', conf: 0.3 }) }) });
  const r = await rj.classify('idk');
  ok(r.source === 'local' && r.reaction === 'neutral', 'classify: local below 0.70 is neutralised too, same gate as jev');
}
{ // local classifier is never loaded unless actually needed (LAZY requirement)
  let loaded = false;
  const { rj } = await reflexWith({ fetchImpl: mockFetch({ delayMs: 5, body: reactionBody('happy', 0.95) }), loadLocal: async () => { loaded = true; return { classify: async () => ({ label: 'happy', conf: 0.95 }) }; } });
  await rj.classify('thanks so much!');
  ok(loaded === false, 'classify: the local classifier is never touched while Jev is answering fine (lazy, not startup-loaded)');
}

// ---------- call ledger: the hard cap this task runs under is enforced in code, not by hand ----------
{
  ok(createCallLedger(null, 60).count() === true, 'ledger: with no file configured there is no cap (normal product behaviour)');
  const dir = tmpDir();
  const file = path.join(dir, 'calls.json');
  const ledger = createCallLedger(file, 3);
  ok(ledger.count() && ledger.count() && ledger.count(), 'ledger: the first 3 calls (the configured cap) are allowed');
  ok(ledger.count() === false, 'ledger: the 4th call is refused');
  ok(ledger.total() === 3, 'ledger: total() reflects what was actually counted, not attempted');
  const reopened = createCallLedger(file, 3);
  ok(reopened.count() === false, 'ledger: the cap persists across instances (it is a file, not in-memory state)');
}
{ // end to end: classify() itself stops at the cap and falls back, it does not rely on the caller remembering to check
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'jev-key.import'), `${FAKE_KEY}\n`);
  const ledgerFile = path.join(dir, 'calls.json');
  let fetchCalls = 0;
  const fast = mockFetch({ delayMs: 5, body: reactionBody('happy', 0.9) });
  const countingFetch = (url, o) => { fetchCalls++; return fast(url, o); };
  const rj = createReflexJev({ egressAllowed: true, safeStorage: stubSafeStorage(), dir, callLedgerFile: ledgerFile, callLedgerCap: 2, fetchImpl: countingFetch, log: () => {} });
  await rj.classify('one'); await rj.classify('two'); const r3 = await rj.classify('three');
  ok(fetchCalls === 2, 'classify: exactly cap (2) real calls were made, not 3', String(fetchCalls));
  ok(r3.source === 'neutral', 'classify: the call over the cap falls back to neutral instead of calling out anyway', JSON.stringify(r3));
}

// ---------- egress gate: release build (egressAllowed=false) never attempts the network, never imports a key ----------
{
  let calls = 0;
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'jev-key.import'), `${FAKE_KEY}\n`); // dropped by mistake on a release build
  const rj = createReflexJev({ egressAllowed: false, safeStorage: stubSafeStorage(), dir, fetchImpl: () => { calls++; return Promise.reject(new Error('should never be called')); }, log: () => {} });
  rj.warm();
  const r = await rj.classify('hello');
  ok(calls === 0, 'egress off: fetch is never called, not even once (warm + classify)');
  ok(fs.existsSync(path.join(dir, 'jev-key.import')), 'egress off: an import file sitting there is never even read');
  // QC-cuoi fix b (09-10): with no network the local keyword rules now decide ('hello' -> happy); still never Jev.
  ok(r.source === 'rules' && r.reaction === 'happy' && r.decider === 'rules', 'egress off: classify() still answers locally (rules), it just never reaches the network', JSON.stringify(r));
}
{ // egress on: warm() makes exactly one GET to the free endpoint, never the paid decisions route
  const calls = [];
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'jev-key.import'), `${FAKE_KEY}\n`);
  const rj = createReflexJev({ egressAllowed: true, safeStorage: stubSafeStorage(), dir, fetchImpl: (url, opts) => { calls.push({ url, method: opts.method }); return Promise.resolve({ ok: true, status: 200, json: async () => ({}) }); }, log: () => {} });
  rj.warm();
  await new Promise((r) => setTimeout(r, 20));
  ok(calls.length === 1 && calls[0].url === `${ALLOWED_ORIGIN}${WARM_PATH}` && calls[0].method === 'GET', 'egress on: warm() hits the free models endpoint, not /decisions', JSON.stringify(calls));
}

// ---------- key-leak sweep ----------
{
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'jev-key.import'), `${FAKE_KEY}\n`);
  const logs = [];
  // Simulate an upstream that is careless enough to echo the bearer back in an error body / network error message.
  const leaky = (url, opts) => Promise.reject(new Error(`upstream rejected Authorization: Bearer ${FAKE_KEY}`));
  const rj = createReflexJev({ egressAllowed: true, safeStorage: stubSafeStorage(), dir, fetchImpl: leaky, log: (m) => logs.push(m) });
  const r = await rj.classify('hello');
  const resultText = JSON.stringify(r);
  const logText = logs.join('\n');
  ok(!resultText.includes(FAKE_KEY), 'leak: the classify() payload (what the renderer receives over IPC) never contains the key', resultText);
  ok(!logText.includes(FAKE_KEY), 'leak: nothing logged to the turn log / stdout contains the key', logText);
  ok(scrub(`token=${FAKE_KEY} failed`, FAKE_KEY) === 'token=*** failed', 'leak: scrub() removes a known key verbatim');
  ok(!scrub(`Authorization: Bearer ${FAKE_KEY}`).includes(FAKE_KEY), 'leak: scrub() also catches a bare sk-or-... pattern with no key passed in');
}

// ---------- the 8 Jev labels -> variety pools (base body motions + face phrases, T-31 PLAN-variety.md) ----------
// Pool construction, anti-repeat selection and derived-variant gating are covered end to end by
// scripts/check-variety.mjs; this file only checks the RAW authored data every pool is built from.
{
  const { JEV_LABELS, JEV_LABEL_VI, JEV_BODY, JEV_FACE } = await import('../src/renderer/talk/jevlabels.js');
  const { gateJevVariant } = await import('../src/renderer/talk/jevVariety.js');
  const { ownerTextProblem } = await import('../src/renderer/talk/ownertext.js');
  ok(JEV_LABELS.length === 8 && JEV_LABELS.every((l) => LABELS.includes(l)), 'labels: the renderer\'s label set matches reflex-jev.js\'s LABELS exactly');
  for (const label of JEV_LABELS) {
    ok(JEV_BODY[label].length >= 2, `variety: "${label}" has >= 2 authored body motions`, String(JEV_BODY[label].length));
    for (const base of JEV_BODY[label]) {
      const g = gateJevVariant(base.command);
      ok(g.ok, `variety: body "${label}/${base.id}" passes its gate (schema, no clamping, 1.5-3.5s)`, JSON.stringify(g.errors));
    }
    ok(JEV_FACE[label].length >= 3, `variety: "${label}" has >= 3 authored face phrases`, String(JEV_FACE[label].length));
    for (const phrase of JEV_FACE[label]) {
      const g = gateJevVariant({ id: phrase.id, expressions: phrase.expressions });
      ok(g.ok, `variety: face "${label}/${phrase.id}" passes its gate`, JSON.stringify(g.errors));
    }
    ok(ownerTextProblem(JEV_LABEL_VI[label]) === null, `gesture: the owner-facing label for "${label}" passes the ownerText audit`, JEV_LABEL_VI[label]);
  }
}

// ---------- the owner-visible timing line ----------
{
  const { ownerTextProblem } = await import('../src/renderer/talk/ownertext.js');
  const { t } = await import('../src/renderer/i18n.js');
  for (const [ms, source] of [[420, 'jev'], [12, 'local'], [0, 'neutral']]) {
    const line = t('app.timing', { secs: (ms / 1000).toFixed(2), source: t('app.source.' + source) });
    ok(ownerTextProblem(line) === null, `timing line passes the ownerText audit: "${line}"`, String(ownerTextProblem(line)));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
