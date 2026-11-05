// T-31 BYOK chat errors (20-10): a failed turn must say WHY, and the answer must be safe. Plain Node, no Electron,
// no network: every request goes to a stubbed fetch and every "key" is a fake built from repeated characters.
// Verifies:
//   1. the classifier: the STATUS decides first (401/403 -> auth, not retryable, even with a funds body); then 402 or
//      an insufficient-funds/credit body -> credit (not retryable); 429 -> quota (retryable); else upstream (retryable);
//   2. the behaviour through createChatBrain.turn(): the error code, the retryable flag and the module's own
//      http_<status> message, for every status/body, on a non-streamed and a streamed turn (including a streamed 400
//      with an out-of-funds body and a streamed 429, free and paid);
//   3. the renderer mapping (src/renderer/talk/error-line.js) and the exact VI lines the owner asked for, in en/vi/zh:
//      a free-tier (gemini/groq) 429 keeps the free-quota line naming the provider, any other 429 is the busy line;
//   4. redaction: the provider's response body is never returned or logged (it can echo the key or request content),
//      and no log line, error object or renderer line ever contains the key.
//   node scripts/check-byok-errors.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { TABLES } from '../src/renderer/i18n.js';
import { failureLineKey } from '../src/renderer/talk/error-line.js';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); } };

const { createChatBrain, classifyUpstreamError } = require('../src/main/chat-brain.js');
const { createKeyStore } = require('../src/main/reflex-jev.js');
const { PROVIDERS } = require('../src/main/providers.js');

// Shape-valid fake keys, never real secrets. They must never show up in an error or a log line.
const FAKE = { opencode: `oc_sk_${'d'.repeat(48)}`, groq: `gsk_${'b'.repeat(48)}`, openrouter: `sk-or-v1-${'c'.repeat(48)}` };
const ALL_KEYS = Object.values(FAKE);
const leaks = (x) => { const s = typeof x === 'string' ? x : JSON.stringify(x); return ALL_KEYS.some((k) => s.includes(k)); };
// The provider bodies used below. Each carries a marker phrase that must never surface either.
const BODY = {
  invalid: `{"error":{"type":"server_error","message":"Upstream request failed: Invalid credential"}}`,
  funds: `{"error":{"type":"server_error","message":"Upstream request failed: Insufficient account funds"}}`,
  credits: `{"error":{"type":"server_error","message":"Insufficient credits"}}`,
  freeTier: `{"error":{"type":"FreeTierError","message":"OpenCode's free tier can only be used from within OpenCode"}}`,
  boom: `{"error":{"message":"boom"}}`,
};
const BODY_MARKERS = ['Invalid credential', 'Insufficient account funds', 'Insufficient credits', 'free tier', 'boom'];

function stubSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(`enc:${s}`, 'utf8'),
    decryptString: (b) => b.toString('utf8').slice(4),
  };
}
const tmpDirs = [];
const tmpDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-errors-')); tmpDirs.push(d); return d; };
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });

// Non-ok stub: records the call, answers the chosen status + body. `text()` is what the classifier reads.
function stubFetch({ status, body = '{}', calls = [] } = {}) {
  return (url, opts) => {
    calls.push({ url: String(url), body: opts && opts.body });
    return Promise.resolve({ ok: false, status, text: async () => body, json: async () => ({}) });
  };
}
function brainWith(id, dir, fetchImpl, log = () => {}) {
  const p = PROVIDERS[id];
  createKeyStore({ safeStorage: stubSafeStorage(), dir, name: p.keyName, shape: p.keyShape }).write(FAKE[id]);
  return createChatBrain({ safeStorage: stubSafeStorage(), dir, provider: p, ownerAdmin: true, fetchImpl, log });
}
const oneTurn = async (id, status, body) => {
  const calls = [], logs = [];
  const cb = brainWith(id, tmpDir(), stubFetch({ status, body, calls }), (m) => logs.push(m));
  const r = await cb.turn({ message: 'hello', history: [] });
  return { r, calls, logs };
};

try {
  // ---------- 1. the classifier table ----------
  {
    const cases = [
      ['401 invalid key', 401, false, 'auth', false],
      ['403 no permission', 403, false, 'auth', false],
      ['401 whose body also mentions funds -> still auth', 401, true, 'auth', false],
      ['403 whose body also mentions funds -> still auth', 403, true, 'auth', false],
      ['402 no funds', 402, false, 'credit', false],
      ['400 + insufficient funds body', 400, true, 'credit', false],
      ['500 + insufficient credits body', 500, true, 'credit', false],
      ['429 provider busy', 429, false, 'quota', true],
      ['500 generic', 500, false, 'upstream', true],
      ['no status (network/timeout)', undefined, false, 'upstream', true],
    ];
    for (const [name, status, insufficient, code, retryable] of cases) {
      const got = classifyUpstreamError(status, insufficient);
      ok(got.code === code && got.retryable === retryable, `classifier: ${name} -> ${code}, retryable ${retryable}`, JSON.stringify(got));
    }
  }

  // ---------- 2a. a non-streamed turn: code + retryable + no body in the error ----------
  {
    const cases = [
      ['401 (invalid credential)', 'opencode', 401, BODY.invalid, 'auth', false],
      ['403 (free tier refused)', 'opencode', 403, BODY.freeTier, 'auth', false],
      ['401 with an insufficient-funds body (status wins)', 'opencode', 401, BODY.funds, 'auth', false],
      ['403 with an insufficient-credits body (status wins)', 'opencode', 403, BODY.credits, 'auth', false],
      ['402 (insufficient account funds)', 'opencode', 402, BODY.funds, 'credit', false],
      ['400 with an insufficient-funds body', 'opencode', 400, BODY.funds, 'credit', false],
      ['500 with an insufficient-credits body', 'groq', 500, BODY.credits, 'credit', false],
      ['402 from Groq', 'groq', 402, BODY.boom, 'credit', false],
      ['429 (busy)', 'opencode', 429, BODY.boom, 'quota', true],
      ['500 generic', 'opencode', 500, BODY.boom, 'upstream', true],
    ];
    for (const [name, id, status, body, code, retryable] of cases) {
      const { r, logs } = await oneTurn(id, status, body);
      const e = r && r.error;
      ok(r && r.ok === false && e && e.code === code && e.retryable === retryable && e.message === `http_${status}`,
        `turn: ${name} -> code "${code}", retryable ${retryable}, message http_${status}`, JSON.stringify(e));
      const surface = JSON.stringify(e) + '\n' + logs.join('\n');
      ok(!BODY_MARKERS.some((m) => surface.toLowerCase().includes(m.toLowerCase())),
        `turn: ${name} never surfaces the provider body (classification only)`, surface);
      ok(!leaks(surface), `turn: ${name} never surfaces the key`, surface);
    }
  }

  // ---------- 2b. a streamed turn that is refused before its first clause: one call, same code/flag ----------
  for (const [status, body, code] of [
    [401, BODY.invalid, 'auth'],
    [402, BODY.funds, 'credit'],
    [403, BODY.freeTier, 'auth'],
    [401, BODY.funds, 'auth'], // the status wins over a funds body on the streamed path too
    [403, BODY.funds, 'auth'], // same for 403
    [400, BODY.funds, 'credit'], // an out-of-funds body under 400 is still the money line, never a fallback
  ]) {
    const calls = [], logs = [];
    const cb = brainWith('opencode', tmpDir(), stubFetch({ status, body, calls }), (m) => logs.push(m));
    const { head, live } = await cb.turnStream({ turnId: `${status}`.padEnd(32, 'a'), message: 'hello', history: [] });
    const e = head && head.error;
    ok(head && head.ok === false && live === null && e && e.code === code && e.retryable === false && e.message === `http_${status}` && calls.length === 1,
      `stream: http_${status} -> code "${code}", retryable false, exactly 1 call (no fallback)`,
      JSON.stringify({ e, calls: calls.length }));
    ok(!leaks(JSON.stringify(head) + '\n' + logs.join('\n')) && !BODY_MARKERS.some((m) => (JSON.stringify(head) + logs.join('\n')).includes(m)),
      `stream: http_${status} never surfaces the key or the provider body`, JSON.stringify(head));
  }

  // ---------- 2c. a streamed 429: gemini/groq (free tier) and paid OpenCode refuse in one call (the no-fallback rule
  // covers every non-OpenRouter provider); a paid OpenRouter key's rate limit may clear, so it falls back once and the
  // fallback's 429 yields the same 'quota' code.
  for (const [id, expectedCalls] of [['groq', 1], ['opencode', 1], ['openrouter', 2]]) {
    const calls = [], logs = [];
    const cb = brainWith(id, tmpDir(), stubFetch({ status: 429, body: BODY.boom, calls }), (m) => logs.push(m));
    const { head } = await cb.turnStream({ turnId: 'q'.repeat(32), message: 'hello', history: [] });
    const e = head && head.error;
    ok(head && head.ok === false && e && e.code === 'quota' && e.retryable === true && calls.length === expectedCalls,
      `stream: ${id} 429 -> quota, retryable true, ${expectedCalls} call(s)`,
      JSON.stringify({ e, calls: calls.length }));
    ok(!leaks(JSON.stringify(head) + '\n' + logs.join('\n')) && !BODY_MARKERS.some((m) => (JSON.stringify(head) + logs.join('\n')).includes(m)),
      `stream: ${id} 429 never surfaces the key or the provider body`, JSON.stringify(head));
  }

  // ---------- 2d. a provider that echoes the key in its refusal body ----------
  {
    const echo = `{"error":{"message":"Invalid credential: ${FAKE.opencode}"}}`;
    const { r, logs } = await oneTurn('opencode', 401, echo);
    const surface = JSON.stringify(r) + '\n' + logs.join('\n');
    ok(r.error.code === 'auth' && r.error.retryable === false, 'echo: a body echoing the key still classifies as auth', JSON.stringify(r.error));
    ok(!leaks(surface) && !surface.includes('Invalid credential'), 'echo: the echoed key and the body never reach the error or the log', surface);
  }

  // ---------- 3. the renderer line + the exact VI wording ----------
  {
    ok(failureLineKey({ code: 'auth' }) === 'app.keyRefused', 'renderer: auth -> the check-your-key line');
    ok(failureLineKey({ code: 'credit' }) === 'app.creditOut', 'renderer: credit -> the out-of-funds line');
    ok(failureLineKey({ code: 'quota' }) === 'app.providerBusy' && failureLineKey({ code: 'quota', free: false }) === 'app.providerBusy',
      'renderer: a 429 without the free-tier signal -> the provider-is-busy line');
    ok(failureLineKey({ code: 'quota', free: true, provider: 'Gemini' }) === 'app.quota',
      'renderer: a free-tier 429 (gemini/groq) keeps the free-quota line that names the provider');
    ok(failureLineKey({ code: 'upstream' }) === 'app.replyFailed' && failureLineKey(null) === 'app.replyFailed' && failureLineKey({}) === 'app.replyFailed',
      'renderer: everything else -> today\'s generic line');
    ok(TABLES.vi['app.keyRefused'] === 'Khoá không hợp lệ hoặc không có quyền — kiểm tra lại khoá trong Cài đặt',
      'i18n: the VI auth line is the owner\'s wording', TABLES.vi['app.keyRefused']);
    ok(TABLES.vi['app.creditOut'] === 'Tài khoản nhà cung cấp hết tiền — nạp thêm hoặc đổi nhà cung cấp',
      'i18n: the VI credit line is the owner\'s wording', TABLES.vi['app.creditOut']);
    ok(TABLES.vi['app.providerBusy'] === 'Nhà cung cấp đang bận, thử lại sau ít phút',
      'i18n: the VI busy line is the owner\'s wording', TABLES.vi['app.providerBusy']);
    ok(TABLES.vi['app.quota'] === 'Hết lượt miễn phí hôm nay của {provider}; thử lại sau hoặc chọn nhà cung cấp khác.',
      'i18n: the free-tier 429 keeps the owner\'s "hết lượt miễn phí hôm nay của {provider}" wording', TABLES.vi['app.quota']);
    for (const key of ['app.keyRefused', 'app.creditOut', 'app.providerBusy', 'app.quota']) {
      const all = ['en', 'vi', 'zh'].map((l) => TABLES[l][key]);
      ok(all.every((s) => typeof s === 'string' && s.trim().length > 10), `i18n: ${key} exists in en/vi/zh`, JSON.stringify(all));
    }
    ok(['en', 'vi', 'zh'].every((l) => TABLES[l]['app.quota'].includes('{provider}')), 'i18n: the free-quota line names the provider in en/vi/zh');
    ok(['en', 'vi', 'zh'].every((l) => !('app.quotaPaid' in TABLES[l]) && !('app.opencodeCredit' in TABLES[l])),
      'i18n: the now-dead paid-quota / OpenCode-credit keys are removed, not orphaned');
    const director = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'talk', 'director.js'), 'utf8');
    ok(/tr\(failureLineKey\(r && r\.error\)/.test(director), 'wiring: the failed-turn bubble uses error-line.js (one mapping, no inline guesses)');
    ok(/r && r\.error && r\.error\.provider \? \{ provider: r\.error\.provider \}/.test(director),
      'wiring: the free-quota line is interpolated with the provider label main.js stamps on a 429');
  }
} catch (e) {
  fail++;
  console.log(`FAIL uncaught: ${(e && e.stack) || e}`);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
