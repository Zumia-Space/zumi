// Node checks for the owner token-usage ledger (T-31 owner-admin + usage, Fable ruling 05-10): offline/mocked
// fetch only, no real OpenRouter call, no real key (every "key" here is a synthetic sk-or-... string, same
// convention as check-chat-brain.mjs / check-reflex-jev.mjs). Covers:
//   usage-ledger.js: appendUsage (success + failure, never throws), tolerant malformed-line read, aggregateUsage math;
//   usage-cost.js: the price-table estimate math, including the deliberately-unverified Jev entry;
//   chat-brain.js + reflex-jev.js wiring: onUsage fires for a REAL call (ok and failing), never for a no-call path
//     (no key, cap-blocked, call-ledger-capped) -- and the resulting ledger file never contains the key, the user's
//     message, or the model's reply text;
//   ownerAdmin: the chat daily cap is OFF when true, unchanged (ON) when false/absent;
//   i18n: the usage.* keys exist, non-empty, in en/vi/zh, and the cost footnote literally carries the word the
//     plan requires per locale ("estimate" EN, "ước tính" VI, "估算" ZH);
//   T-31 zumi-roles: `kind` is chat|plan|check|lookup|jev (anything else -> chat), aggregateUsage keeps date x model x
//     kind apart, a lookup row adds the flat web-search fee ($0.007 per line, usage-prices.json `_webSearch`), and the
//     Usage card names the role after the model ("DeepSeek V4 · Check").
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { TABLES, LOCALES } from '../src/renderer/i18n.js';

const require = createRequire(import.meta.url);
const { appendUsage, readDay, aggregateUsage, localDate, KINDS } = require('../src/main/usage-ledger.js');
const { estimateCostUsd, withEstimatedCost, PRICES, WEB_SEARCH_USD } = require('../src/main/usage-cost.js');
const { createChatBrain, DAILY_CAP, CAP_MESSAGE_VI, MODEL: CHAT_MODEL, isClaudeModel } = require('../src/main/chat-brain.js');
const { createReflexJev, JEV_MODEL } = require('../src/main/reflex-jev.js');

let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); } };

const FAKE_KEY = 'sk-or-TESTFAKEKEY1234567890ABCDEFGHIJ'; // shape-valid, never a real secret
const SECRET_MESSAGE = 'XYZZY-USER-MESSAGE-MUST-NEVER-LEAK';
const SECRET_REPLY = 'XYZZY-REPLY-TEXT-MUST-NEVER-LEAK';

function stubSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(`ENC:${s}`, 'utf8'),
    decryptString: (b) => { const s = b.toString('utf8'); if (!s.startsWith('ENC:')) throw new Error('bad blob'); return s.slice(4); },
  };
}

const tmpDirs = [];
function tmpDir() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-test-')); tmpDirs.push(d); return d; }
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });

function seedKey(dir) {
  const { createKeyStore } = require('../src/main/reflex-jev.js');
  const ks = createKeyStore({ safeStorage: stubSafeStorage(), dir, log: () => {} });
  fs.writeFileSync(path.join(dir, 'jev-key.import'), `${FAKE_KEY}\n`);
  ks.importIfPresent();
}

function ledgerText(dir) {
  const file = path.join(dir, 'usage', `${localDate()}.jsonl`);
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

// ======================================================================================
// usage-ledger.js: append + tolerant read + aggregation math
// ======================================================================================
{
  const dir = tmpDir();
  ok(appendUsage(dir, { model: 'm1', kind: 'chat', in: 10, out: 5, total: 15, ms: 123, ok: true }), 'appendUsage: a normal success record appends (returns true)');
  ok(appendUsage(dir, { model: 'm1', kind: 'chat', in: 3, out: 2, total: 5, ms: 50, ok: false }), 'appendUsage: a normal failure record appends too');
  const recs = readDay(dir, localDate());
  ok(recs.length === 2, 'readDay: both appended lines come back', String(recs.length));
  ok(recs[0].model === 'm1' && recs[0].kind === 'chat' && recs[0].total === 15 && recs[0].ok === true, 'readDay: the first record\'s fields round-trip', JSON.stringify(recs[0]));
  ok(recs[1].ok === false && recs[1].total === 5, 'readDay: the second (failed) record\'s fields round-trip too', JSON.stringify(recs[1]));
  ok(typeof recs[0].ts === 'string' && !Number.isNaN(Date.parse(recs[0].ts)), 'readDay: ts is a parseable ISO timestamp', recs[0].ts);
}
{
  // Tolerant read: a hand-corrupted line (as if a write was interrupted) must not break reading the good lines.
  const dir = tmpDir();
  const file = path.join(dir, 'usage', `${localDate()}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"model":"ok1","kind":"chat","in":1,"out":1,"total":2,"ms":1,"ok":true}\n{not json at all\n{"model":"ok2","kind":"jev","in":2,"out":2,"total":4,"ms":2,"ok":true}\n');
  const recs = readDay(dir, localDate());
  ok(recs.length === 2 && recs[0].model === 'ok1' && recs[1].model === 'ok2', 'readDay: a malformed line in the middle is skipped, the good lines on either side still parse', JSON.stringify(recs));
}
{
  // appendUsage never throws, even when the dir cannot be created (here: a FILE sits where a directory is wanted).
  const dir = tmpDir();
  const blocker = path.join(dir, 'blocked');
  fs.writeFileSync(blocker, 'not a directory');
  let threw = false;
  let logged = '';
  let r;
  try { r = appendUsage(blocker, { model: 'm', kind: 'chat', in: 1, out: 1, total: 2, ms: 1, ok: true }, (m) => { logged = m; }); }
  catch { threw = true; }
  ok(!threw, 'appendUsage: a filesystem error never throws into the caller');
  ok(r === false, 'appendUsage: a filesystem error returns false');
  ok(logged.length > 0, 'appendUsage: a filesystem error is still surfaced to the caller\'s log sink', logged);
}
{
  // Aggregation math: today (via appendUsage, the real local date) plus a synthetic 3-days-ago file.
  const dir = tmpDir();
  appendUsage(dir, { model: 'alpha', kind: 'chat', in: 100, out: 50, total: 150, ms: 10, ok: true });
  appendUsage(dir, { model: 'alpha', kind: 'chat', in: 200, out: 100, total: 300, ms: 10, ok: true });
  appendUsage(dir, { model: 'beta', kind: 'jev', in: 5, out: 0, total: 5, ms: 10, ok: false });

  const past = new Date(Date.now() - 3 * 86400000);
  const y = past.getFullYear(), m = String(past.getMonth() + 1).padStart(2, '0'), d = String(past.getDate()).padStart(2, '0');
  const pastDate = `${y}-${m}-${d}`;
  const pastFile = path.join(dir, 'usage', `${pastDate}.jsonl`);
  fs.writeFileSync(pastFile, [
    { model: 'alpha', kind: 'chat', in: 1, out: 1, total: 2, ms: 1, ok: true },
    { model: 'alpha', kind: 'chat', in: 1, out: 1, total: 2, ms: 1, ok: false },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');

  const { today, rows } = aggregateUsage(dir, { days: 30 });
  ok(today === localDate(), 'aggregateUsage: today matches the local calendar date', today);
  const todayAlpha = rows.find((r) => r.date === today && r.model === 'alpha');
  ok(todayAlpha && todayAlpha.calls === 2 && todayAlpha.ok === 2 && todayAlpha.in === 300 && todayAlpha.out === 150 && todayAlpha.total === 450, 'aggregateUsage: today\'s two alpha calls sum correctly', JSON.stringify(todayAlpha));
  const todayBeta = rows.find((r) => r.date === today && r.model === 'beta');
  ok(todayBeta && todayBeta.calls === 1 && todayBeta.ok === 0, 'aggregateUsage: today\'s single failed beta call counts as 1 call, 0 ok', JSON.stringify(todayBeta));
  const pastAlpha = rows.find((r) => r.date === pastDate && r.model === 'alpha');
  ok(pastAlpha && pastAlpha.calls === 2 && pastAlpha.ok === 1 && pastAlpha.total === 4, '3-days-ago: the two synthetic alpha calls sum correctly (1 ok, 1 failed)', JSON.stringify(pastAlpha));

  const narrow = aggregateUsage(dir, { days: 1 });
  ok(!narrow.rows.some((r) => r.date === pastDate), 'aggregateUsage: days=1 excludes the 3-days-ago rows entirely', JSON.stringify(narrow.rows));
  ok(narrow.rows.some((r) => r.date === today), 'aggregateUsage: days=1 still includes today\'s rows');
}

// ======================================================================================
// usage-cost.js: price-table estimate math
// ======================================================================================
{
  const { usd, priced } = estimateCostUsd(CHAT_MODEL, 1_000_000, 1_000_000);
  ok(priced && Math.abs(usd - (PRICES[CHAT_MODEL].inputPerMtok + PRICES[CHAT_MODEL].outputPerMtok)) < 1e-9, `estimateCostUsd: ${CHAT_MODEL} at 1M/1M tokens matches inputPerMtok+outputPerMtok`, `usd=${usd}`);
  const half = estimateCostUsd(CHAT_MODEL, 500_000, 250_000);
  const expected = 500_000 / 1e6 * PRICES[CHAT_MODEL].inputPerMtok + 250_000 / 1e6 * PRICES[CHAT_MODEL].outputPerMtok;
  ok(half.priced && Math.abs(half.usd - expected) < 1e-9, 'estimateCostUsd: a fractional-Mtok split computes linearly', `usd=${half.usd} expected=${expected}`);
}
{
  const r = estimateCostUsd(JEV_MODEL, 1000, 1000);
  ok(r.priced === false && r.usd === 0, `estimateCostUsd: ${JEV_MODEL} is marked unverified -> priced:false, usd:0 (never a silently invented number)`, JSON.stringify(r));
  ok(PRICES[JEV_MODEL] && PRICES[JEV_MODEL].unverified === true, 'usage-prices.json: the Jev entry is explicitly marked unverified');
}
{
  const r = estimateCostUsd('not/a-real-model', 1000, 1000);
  ok(r.priced === false && r.usd === 0, 'estimateCostUsd: a model missing from the table is priced:false, usd:0, not a thrown error', JSON.stringify(r));
}
{
  const rows = withEstimatedCost([{ date: '2026-01-01', model: CHAT_MODEL, calls: 1, ok: 1, in: 1_000_000, out: 0, total: 1_000_000 }]);
  ok(rows[0].priced && Math.abs(rows[0].estCostUsd - PRICES[CHAT_MODEL].inputPerMtok) < 1e-9, 'withEstimatedCost: adds estCostUsd/priced onto a plain aggregateUsage row without mutating its other fields', JSON.stringify(rows[0]));
}

// ======================================================================================
// chat-brain.js wiring: ownerAdmin cap bypass + onUsage ledger entries (success AND failure), no leak
// ======================================================================================
function mockFetch({ delayMs = 0, status = 200, body = { choices: [{ message: { content: SECRET_REPLY } }], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } } } = {}) {
  return (url, opts) => new Promise((resolve) => setTimeout(() => resolve({ ok: status === 200, status, json: async () => body }), delayMs));
}
{
  // ownerAdmin: false -> cap behaves exactly as check-chat-brain.mjs already proves (DAILY_CAP+1th call is capped).
  const dir = tmpDir();
  seedKey(dir);
  const cb = createChatBrain({ safeStorage: stubSafeStorage(), dir, ownerAdmin: false, fetchImpl: mockFetch(), log: () => {} });
  for (let i = 0; i < DAILY_CAP; i++) await cb.turn({ message: `t${i}`, history: [] });
  const over = await cb.turn({ message: 'one more', history: [] });
  ok(over.ok && over.reply === CAP_MESSAGE_VI, 'chatBrain ownerAdmin=false: the cap still blocks the 201st turn', JSON.stringify(over));
}
{
  // ownerAdmin: true -> no limit (anh's own verbatim requirement): run well past DAILY_CAP, every turn still answers.
  const dir = tmpDir();
  seedKey(dir);
  const cb = createChatBrain({ safeStorage: stubSafeStorage(), dir, ownerAdmin: true, fetchImpl: mockFetch(), log: () => {} });
  let allNormal = true;
  for (let i = 0; i < DAILY_CAP + 10; i++) {
    const r = await cb.turn({ message: `t${i}`, history: [] });
    if (!r.ok || r.model !== CHAT_MODEL) { allNormal = false; break; }
  }
  ok(allNormal, `chatBrain ownerAdmin=true: all ${DAILY_CAP + 10} turns (past the normal cap) answer normally, never capped`);
  ok(!fs.existsSync(path.join(dir, 'chat-turn-cap.json')), 'chatBrain ownerAdmin=true: the cap file is never even written (cap.count() is skipped entirely)');
}
{
  // onUsage ledger wiring: a successful turn logs one line with the real counts, never the message/reply/key.
  const dir = tmpDir();
  seedKey(dir);
  const events = [];
  const cb = createChatBrain({ safeStorage: stubSafeStorage(), dir, ownerAdmin: true, fetchImpl: mockFetch(), onUsage: (rec) => events.push(rec), log: () => {} });
  const r = await cb.turn({ message: SECRET_MESSAGE, history: [] });
  ok(r.ok && r.reply === SECRET_REPLY, 'chatBrain: the turn itself still answers normally with onUsage wired');
  ok(events.length === 1 && events[0].model === CHAT_MODEL && events[0].kind === 'chat' && events[0].ok === true && events[0].total === 18, 'onUsage: fires exactly once, with the real model/kind/usage/ok', JSON.stringify(events));

  const r2 = await cb.turn({ message: 'another one', history: [] });
  ok(r2.ok, 'chatBrain: a second turn also answers (sanity)');
  ok(events.length === 2, 'onUsage: fires once per real turn, not once total');
}
{
  // Failure path: onUsage must still fire (ok:false), per plan item 2 ("success AND failure").
  const dir = tmpDir();
  seedKey(dir);
  const events = [];
  const cb = createChatBrain({ safeStorage: stubSafeStorage(), dir, ownerAdmin: true, fetchImpl: mockFetch({ status: 500, body: {} }), onUsage: (rec) => events.push(rec), log: () => {} });
  const r = await cb.turn({ message: 'x', history: [] });
  ok(!r.ok, 'chatBrain: an upstream failure is still reported as a failure to the caller');
  ok(events.length === 1 && events[0].ok === false && events[0].model === CHAT_MODEL, 'onUsage: fires on a FAILED real call too, ok:false', JSON.stringify(events));
}
{
  // No-call paths never log: no key, and (ownerAdmin:false) the cap-blocked turn.
  const dirNoKey = tmpDir(); // no jev-key.import dropped
  const eventsNoKey = [];
  const cbNoKey = createChatBrain({ safeStorage: stubSafeStorage(), dir: dirNoKey, fetchImpl: mockFetch(), onUsage: (rec) => eventsNoKey.push(rec), log: () => {} });
  await cbNoKey.turn({ message: 'x', history: [] });
  ok(eventsNoKey.length === 0, 'onUsage: never fires when there is no key (no real call was attempted)');

  const dirCap = tmpDir();
  seedKey(dirCap);
  const eventsCap = [];
  const cbCap = createChatBrain({ safeStorage: stubSafeStorage(), dir: dirCap, ownerAdmin: false, fetchImpl: mockFetch(), onUsage: (rec) => eventsCap.push(rec), log: () => {} });
  for (let i = 0; i < DAILY_CAP; i++) await cbCap.turn({ message: `t${i}`, history: [] });
  const beforeOver = eventsCap.length;
  await cbCap.turn({ message: 'one more', history: [] }); // the capped 201st turn: no real call
  ok(eventsCap.length === beforeOver, 'onUsage: the cap-blocked turn never fires onUsage (no model call happened)', `before=${beforeOver} after=${eventsCap.length}`);
}
{
  // Leak sweep: the actual ledger FILE a real onUsage->appendUsage wiring writes must never contain the key,
  // the user's message, or the model's reply text -- exactly what the task asks to grep for.
  const dir = tmpDir();
  seedKey(dir);
  const cb = createChatBrain({
    safeStorage: stubSafeStorage(), dir, ownerAdmin: true, fetchImpl: mockFetch(),
    onUsage: (rec) => appendUsage(dir, rec, () => {}),
    log: () => {},
  });
  await cb.turn({ message: SECRET_MESSAGE, history: [] });
  const text = ledgerText(dir);
  ok(text.length > 0, 'leak sweep (chat): the ledger file was actually written');
  ok(!text.includes(FAKE_KEY) && !text.includes('sk-or-'), 'leak sweep (chat): the ledger file never contains the key or anything sk-or- shaped', text);
  ok(!text.includes(SECRET_MESSAGE), 'leak sweep (chat): the ledger file never contains the user\'s message text', text);
  ok(!text.includes(SECRET_REPLY), 'leak sweep (chat): the ledger file never contains the model\'s reply text', text);
  ok(text.includes(CHAT_MODEL) && text.includes('"kind":"chat"'), 'leak sweep (chat): the ledger file DOES carry the model id and kind (that is the point of it)', text);
}

// ======================================================================================
// reflex-jev.js wiring: callJev usage parsing + onUsage ledger entries (success AND failure), no leak
// ======================================================================================
function mockJevFetch({ status = 200, body = { answers: { reaction: { choice: 'happy', confidence: 0.9 } }, usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 } } } = {}) {
  return async () => ({ ok: status === 200, status, json: async () => body });
}
{
  const dir = tmpDir();
  seedKey(dir);
  const events = [];
  const rj = createReflexJev({ egressAllowed: true, safeStorage: stubSafeStorage(), dir, fetchImpl: mockJevFetch(), onUsage: (rec) => events.push(rec), log: () => {} });
  const r = await rj.classify(SECRET_MESSAGE);
  ok(r.reaction === 'happy' && r.source === 'jev', 'reflexJev: classify() still returns its normal narrow shape with onUsage wired', JSON.stringify(r));
  ok(events.length === 1 && events[0].model === JEV_MODEL && events[0].kind === 'jev' && events[0].ok === true && events[0].total === 5, 'onUsage (jev): fires once, with the real model/kind/usage/ok', JSON.stringify(events));
}
{
  // Failure path (http error): onUsage still fires, ok:false, usage 0s (no body was parsed).
  const dir = tmpDir();
  seedKey(dir);
  const events = [];
  const rj = createReflexJev({ egressAllowed: true, safeStorage: stubSafeStorage(), dir, fetchImpl: mockJevFetch({ status: 500, body: {} }), onUsage: (rec) => events.push(rec), log: () => {} });
  await rj.classify('x');
  ok(events.length === 1 && events[0].ok === false && events[0].model === JEV_MODEL, 'onUsage (jev): fires on a FAILED real call too, ok:false', JSON.stringify(events));
}
{
  // No-call path: egress off -> classify() falls straight to local/neutral, never calls onUsage.
  const dir = tmpDir();
  const events = [];
  const rj = createReflexJev({ egressAllowed: false, safeStorage: stubSafeStorage(), dir, fetchImpl: mockJevFetch(), onUsage: (rec) => events.push(rec), log: () => {} });
  await rj.classify('x');
  ok(events.length === 0, 'onUsage (jev): never fires when egress is off (no real call was attempted)');
}
{
  // Leak sweep (jev): same discipline as the chat one above.
  const dir = tmpDir();
  seedKey(dir);
  const rj = createReflexJev({ egressAllowed: true, safeStorage: stubSafeStorage(), dir, fetchImpl: mockJevFetch(), onUsage: (rec) => appendUsage(dir, rec, () => {}), log: () => {} });
  await rj.classify(SECRET_MESSAGE);
  const text = ledgerText(dir);
  ok(text.length > 0, 'leak sweep (jev): the ledger file was actually written');
  ok(!text.includes(FAKE_KEY) && !text.includes('sk-or-'), 'leak sweep (jev): the ledger file never contains the key or anything sk-or- shaped', text);
  ok(!text.includes(SECRET_MESSAGE), 'leak sweep (jev): the ledger file never contains the classified text', text);
  ok(text.includes(JEV_MODEL) && text.includes('"kind":"jev"'), 'leak sweep (jev): the ledger file DOES carry the model id and kind', text);
}

// ======================================================================================
// T-31 zumi-roles: a `kind` per role, kept apart in the summary, the web-search fee on lookup rows
// ======================================================================================
{
  const dir = tmpDir();
  ok(KINDS.join() === 'chat,plan,check,lookup,jev', 'kinds: chat, plan, check, lookup, jev', KINDS.join());
  for (const kind of ['chat', 'plan', 'check', 'check', 'lookup', 'lookup', 'lookup', 'mystery']) appendUsage(dir, { model: kind === 'lookup' ? CHAT_MODEL : kind === 'chat' || kind === 'mystery' ? CHAT_MODEL : 'deepseek/deepseek-v4', kind, in: 1000, out: 100, total: 1100, ms: 5, ok: kind !== 'mystery' });
  const recs = readDay(dir, localDate());
  ok(recs.map((r) => r.kind).join() === 'chat,plan,check,check,lookup,lookup,lookup,chat', 'kinds: each role is recorded as its own kind; an unknown kind is recorded as chat', recs.map((r) => r.kind).join());
  const { rows } = aggregateUsage(dir, { days: 1 });
  const key = (r) => `${r.model}|${r.kind}|${r.calls}`;
  ok(JSON.stringify(rows.map(key)) === JSON.stringify(['deepseek/deepseek-v4|plan|1', 'deepseek/deepseek-v4|check|2', `${CHAT_MODEL}|chat|2`, `${CHAT_MODEL}|lookup|3`]), 'aggregateUsage: date x model x kind -- the same model as chat and as lookup is two rows', JSON.stringify(rows.map(key)));
  const priced = withEstimatedCost(rows);
  const look = priced.find((r) => r.kind === 'lookup');
  const chat = priced.find((r) => r.kind === 'chat');
  const tokenUsd = estimateCostUsd(CHAT_MODEL, look.in, look.out).usd;
  ok(WEB_SEARCH_USD === 0.007 && PRICES._webSearch && /web-search/.test(PRICES._webSearch.source), 'usage-prices.json: web search $0.007 per request, with its source', JSON.stringify(PRICES._webSearch));
  ok(Math.abs(look.webSearchUsd - 3 * 0.007) < 1e-12 && Math.abs(look.estCostUsd - (tokenUsd + 0.021)) < 1e-12 && look.priced, 'cost: a lookup row adds $0.007 per line on top of its tokens', JSON.stringify(look));
  ok(chat.webSearchUsd === 0 && Math.abs(chat.estCostUsd - estimateCostUsd(CHAT_MODEL, chat.in, chat.out).usd) < 1e-12, 'cost: a chat row has no web-search fee', JSON.stringify(chat));
  const unpricedLook = withEstimatedCost([{ date: 'd', model: 'not/priced', kind: 'lookup', calls: 2, ok: 2, in: 10, out: 10, total: 20, searches: 2 }])[0];
  ok(!unpricedLook.priced && Math.abs(unpricedLook.estCostUsd - 0.014) < 1e-12, 'cost: an unpriced model still carries its web-search fee (tokens n/a, never guessed)', JSON.stringify(unpricedLook));
  const ui = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer', 'usage.js'), 'utf8');
  ok(/ROLE_KINDS = \['plan', 'check', 'lookup'\]/.test(ui) && /`\$\{modelName\(r\.model\)\} · \$\{t\(`roles\.\$\{r\.kind\}`\)\}`/.test(ui), 'Usage card: a Plan / Check / Look up row reads "<model name> · <role>"');
  ok(/cost: a\.cost \+ \(Number\(r\.estCostUsd\) \|\| 0\)/.test(ui), 'Usage card: the summary cost includes web-search fees (unpriced rows add only that fee)');
}

// ======================================================================================
// Review of b4d6d75 (10-10): period totals were 31% low in the smoke -- the Plan/Check model had no price and unpriced
// rows were left out silently. The model now has a price; any unpriced row left makes the total "≥ $X" plus a note.
// ======================================================================================
{
  const PRO = 'deepseek/deepseek-v4-pro-0813';
  const pro = estimateCostUsd(PRO, 1_000_000, 1_000_000);
  ok(pro.priced && Math.abs(pro.usd - (1.32 + 3.96)) < 1e-9 && /OpenRouter public \/api\/v1\/models, read 2026-10-10/.test(PRICES[PRO].source) && /overrides/.test(PRICES[PRO].source),
    `usage-prices.json: ${PRO} is priced ($1.32 / $3.96 per Mtok, OpenRouter's weekday peak rate, source cited)`, JSON.stringify(PRICES[PRO]));
  // the smoke's own ledger rows (MORNING-1010 run-head): chat + lookup on flash, one Plan call on the pro model
  const smokeRows = withEstimatedCost([
    { date: '2026-10-10', model: CHAT_MODEL, kind: 'chat', calls: 3, ok: 3, in: 7066, out: 125, total: 7191 },
    { date: '2026-10-10', model: CHAT_MODEL, kind: 'lookup', calls: 1, ok: 1, in: 4807, out: 289, total: 5096 },
    { date: '2026-10-10', model: PRO, kind: 'plan', calls: 1, ok: 1, in: 35, out: 164, total: 199 },
  ]);
  ok(smokeRows.every((r) => r.priced), 'smoke rows: every chat-role row of the 10-10 smoke is priced now (Jev is the only unpriced model left)', JSON.stringify(smokeRows.map((r) => [r.model, r.priced])));
  // table refresh (scripts/refresh-usage-prices.mjs, 10-10): dated + sourced, the default model at its 10-10 list price,
  // every model the app can list priced, and no Claude model or Claude-capable router in it
  const priceIds = Object.keys(PRICES).filter((id) => !id.startsWith('_'));
  ok(PRICES._source && PRICES._source.url === 'https://openrouter.ai/api/v1/models' && /^2026-10-10T/.test(PRICES._source.readAt) && /highest rate/.test(PRICES._source.rules),
    'usage-prices.json: dated, with its source URL and the peak/base rule', JSON.stringify(PRICES._source));
  ok(PRICES[CHAT_MODEL].inputPerMtok === 0.0148 && PRICES[CHAT_MODEL].outputPerMtok === 1.28, `usage-prices.json: ${CHAT_MODEL} at $0.0148 / $1.28 per Mtok (list price read 10-10; was $0.042 / $0.084)`, JSON.stringify(PRICES[CHAT_MODEL]));
  ok(priceIds.length > 300 && priceIds.every((id) => id === JEV_MODEL || (PRICES[id].unverified === false && PRICES[id].inputPerMtok >= 0 && PRICES[id].outputPerMtok >= 0)), `usage-prices.json: ${priceIds.length - 1} catalog models priced, Jev the only unverified entry`);
  ok(!priceIds.some((id) => isClaudeModel(id)) && PRICES['openrouter/free'] && PRICES['openrouter/free'].inputPerMtok === 0, 'usage-prices.json: no Claude model or Claude-capable router; openrouter/free at $0', priceIds.filter((id) => isClaudeModel(id)).join());

  // the Usage card itself, on a minimal DOM: one unpriced row in a period -> "≥ $X" + the note; none -> plain "$X"
  const mk = () => {
    const e = { className: '', textContent: '', title: '', hidden: false, children: [], append(...c) { e.children.push(...c); }, appendChild(c) { e.children.push(c); }, addEventListener() {}, setAttribute() {} };
    Object.defineProperty(e, 'innerHTML', { set() { e.children = []; } });
    return e;
  };
  globalThis.document = { createElement: mk, addEventListener() {} };
  const { initUsage } = await import('../src/renderer/usage.js');
  const ids = ['usage-refresh', 'usage-summary-body', 'usage-partial', 'usage-tbody', 'usage-empty', 'usage-details-toggle', 'usage-details-label', 'usage-detail'];
  const paintWith = async (rows) => {
    const els = Object.fromEntries(ids.map((id) => [id, mk()]));
    await initUsage({ usage: { summary: async () => ({ today: '2026-10-10', rows: withEstimatedCost(rows) }) } }, (id) => els[id]);
    return { costs: els['usage-summary-body'].children.map((tr) => tr.children[3]), note: els['usage-partial'] };
  };
  const jev = { date: '2026-10-08', model: 'typesafe/jev-1.13', kind: 'jev', calls: 4, ok: 4, in: 400, out: 40, total: 440 };
  const today = { date: '2026-10-10', model: CHAT_MODEL, kind: 'chat', calls: 2, ok: 2, in: 1_000_000, out: 0, total: 1_000_000 };
  const a = await paintWith([today, jev]);
  const usd = `$${PRICES[CHAT_MODEL].inputPerMtok.toFixed(4)}`;
  ok(a.costs.length === 3 && a.costs[0].textContent === usd && !a.costs[0].title, 'Usage card: Today (all priced) shows the plain total', JSON.stringify(a.costs.map((c) => c.textContent)));
  ok(a.costs[1].textContent === `≥ ${usd}` && a.costs[2].textContent === `≥ ${usd}` && a.costs[1].title === TABLES.en['usage.costPartial'], 'Usage card: 7 / 30 days hold an unpriced row -> "≥ $X" with the note as its tooltip', JSON.stringify(a.costs.map((c) => [c.textContent, c.title])));
  ok(a.note.hidden === false && a.note.textContent === TABLES.en['usage.costPartial'], 'Usage card: the "≥" note under the summary is shown', JSON.stringify(a.note));
  const b = await paintWith([today]);
  ok(b.costs.every((c) => c.textContent === usd) && b.note.hidden === true, 'Usage card: no unpriced row -> no "≥", note hidden', JSON.stringify({ costs: b.costs.map((c) => c.textContent), hidden: b.note.hidden }));
  ok(LOCALES.every((l) => typeof TABLES[l]['usage.costPartial'] === 'string' && TABLES[l]['usage.costPartial'].startsWith('≥')), 'i18n: usage.costPartial in en/vi/zh, each explaining "≥"');
  const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer', 'index.html'), 'utf8');
  ok(/<p id="usage-partial" class="note" hidden><\/p>/.test(html), 'index.html: the Usage card has the note element (#usage-partial, hidden by default)');
  delete globalThis.document;
}

// ======================================================================================
// i18n: usage.* strings exist, non-empty, in en/vi/zh -- and the cost footnote carries the required word per locale
// ======================================================================================
const USAGE_KEYS = ['usage.title', 'usage.todaySummary', 'usage.refresh', 'usage.empty', 'usage.colDate', 'usage.colModel', 'usage.colCalls', 'usage.colIn', 'usage.colOut', 'usage.colTotal', 'usage.colCost', 'usage.costNa', 'usage.costFootnote'];
for (const locale of LOCALES) {
  for (const key of USAGE_KEYS) {
    const v = TABLES[locale] && TABLES[locale][key];
    ok(typeof v === 'string' && v.trim().length > 0, `i18n: ${locale}.${key} exists and is non-empty`, String(v));
  }
}
ok(/estimate/i.test(TABLES.en['usage.costFootnote']), 'i18n: the EN cost footnote literally says "estimate"', TABLES.en['usage.costFootnote']);
ok(TABLES.vi['usage.costFootnote'].includes('ước tính'), 'i18n: the VI cost footnote literally says "ước tính"', TABLES.vi['usage.costFootnote']);
ok(TABLES.zh['usage.costFootnote'].includes('估算'), 'i18n: the ZH cost footnote literally says "估算"', TABLES.zh['usage.costFootnote']);

// The web-search fee follows the provider (T-31 alpha.13, review item 6): only a call that really sent the web plugin pays it.
{
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-web-'));
  appendUsage(d, { model: 'deepseek-v4.1-flash', kind: 'lookup', in: 1, out: 1, total: 2, ms: 1, ok: true, web: false });
  appendUsage(d, { model: 'vendor/model', kind: 'lookup', in: 1, out: 1, total: 2, ms: 1, ok: true, web: true });
  const rows = withEstimatedCost(aggregateUsage(d).rows);
  const fee = (m) => rows.find((r) => r.model === m).webSearchUsd;
  ok(fee('deepseek-v4.1-flash') === 0, 'a Look up off OpenRouter adds no web-search fee', JSON.stringify(rows[0]));
  ok(fee('vendor/model') === 0.007, 'a Look up on OpenRouter adds one fee');
  const legacy = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-old-'));
  fs.mkdirSync(path.join(legacy, 'usage'));
  fs.writeFileSync(path.join(legacy, 'usage', `${localDate()}.jsonl`), [{ model: 'deepseek-v4.1-flash', kind: 'lookup', ok: true }, { model: 'vendor/model', kind: 'lookup', ok: true }].map((x) => JSON.stringify(x)).join('\n'));
  const old = withEstimatedCost(aggregateUsage(legacy).rows);
  ok(old.find((r) => r.model === 'deepseek-v4.1-flash').webSearchUsd === 0 && old.find((r) => r.model === 'vendor/model').webSearchUsd === 0.007, 'an old line with no flag: a vendor/model id (OpenRouter shape) pays, a bare id does not');
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} check-usage — ${pass}/${pass + fail} assertions passed`);
process.exit(fail === 0 ? 0 : 1);
