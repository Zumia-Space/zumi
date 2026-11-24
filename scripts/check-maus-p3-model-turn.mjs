// T-31-MAUS P3: the sidecar's one narrow host-only method for the Rust agent loop, `__host.modelTurn`
// (chat-brain.js modelTurn -> chat-host.mjs -> main.mjs). It makes ONE model call with tool definitions and returns the
// text, the tool calls (as data) and the token usage. It executes no tool. Plain Node, no network: every request goes to
// a stub fetch (the egress self-test guard and the measure-stub provider are the existing stub seams); keys are fakes.
//   node scripts/check-maus-p3-model-turn.mjs
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { selfTestFetch } from '../tauri/sidecar/egress.mjs';
import { MEASURE_STUB_PROVIDER, MEASURE_STUB_REPLY, measureStubFetch } from '../tauri/sidecar/measure-stub.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createChatBrain } = require('../src/main/chat-brain.js');
const { createKeyStore } = require('../src/main/reflex-jev.js');
const { PROVIDERS } = require('../src/main/providers.js');
let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); } };

const FAKE_KEY = `sk-or-v1-${'c'.repeat(48)}`;
const storage = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(`enc:${s}`, 'utf8'), decryptString: (b) => b.toString('utf8').slice(4) };
const dirs = [];
const tmpDir = () => { const d = fs.mkdtempSync(path.join(ROOT, 'tmp', 'mt-check-')); dirs.push(d); return d; };
fs.mkdirSync(path.join(ROOT, 'tmp'), { recursive: true });
process.on('exit', () => { for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });

function brain({ provider = PROVIDERS.openrouter, key = FAKE_KEY, fetchImpl, ownerAdmin = true, dir = tmpDir() }) {
  if (key) createKeyStore({ safeStorage: storage, dir, name: provider.keyName, shape: provider.keyShape }).write(key);
  return createChatBrain({ safeStorage: storage, dir, provider, ownerAdmin, fetchImpl, log: () => {} });
}
const completion = (message, usage = { prompt_tokens: 120, completion_tokens: 15, total_tokens: 135 }) => ({ choices: [{ message }], usage });
const replying = (body, calls = []) => (url, init) => { calls.push({ url: String(url), init }); return Promise.resolve({ ok: true, status: 200, json: async () => body, text: async () => '' }); };
const failing = (status, calls = []) => (url, init) => { calls.push({ url: String(url), init }); return Promise.resolve({ ok: false, status, text: async () => '{"error":"x"}', json: async () => ({}) }); };
const REQ = { messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'open notepad' }], tools: [{ type: 'function', function: { name: 'hands.launch', description: 'd', parameters: { type: 'object', properties: {} } } }] };
const leaks = (x) => JSON.stringify(x).includes(FAKE_KEY);

// 1. A reply with tool calls comes back as data, with usage and model; the request carried the tools.
{
  const calls = [];
  const cb = brain({ fetchImpl: replying(completion({ content: 'Opening.', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'hands.launch', arguments: '{"app":"notepad"}' } }] }), calls) });
  const r = await cb.modelTurn(REQ);
  ok(r.ok === true && r.text === 'Opening.', 'reply text');
  ok(r.toolCalls.length === 1 && r.toolCalls[0].name === 'hands.launch' && r.toolCalls[0].args.app === 'notepad' && r.toolCalls[0].id === 'c1', 'tool call parsed to an object');
  ok(r.usage.in === 120 && r.usage.out === 15 && r.usage.total === 135, 'usage');
  ok(calls.length === 1, 'exactly one provider call (the tool is NOT run here)', String(calls.length));
  const sent = JSON.parse(calls[0].init.body);
  ok(sent.tools.length === 1 && sent.tool_choice === 'auto' && sent.messages.length === 2, 'the request carries messages and tools');
  ok(calls[0].init.redirect === 'error', 'redirects are refused');
  ok(!leaks(r), 'the key is not in the reply');
  ok(cb.status().enabled !== undefined, 'the brain still works after a modelTurn (status)');
}

// 1b. The output cap the loop priced is the one sent: maxTokens is honoured and never above 1000 (M2).
{
  const calls = [];
  const cb = brain({ fetchImpl: replying(completion({ content: 'x' }), calls) });
  await cb.modelTurn({ ...REQ, maxTokens: 200 });
  await cb.modelTurn({ ...REQ, maxTokens: 50000 });
  await cb.modelTurn(REQ);
  const mt = calls.map((c) => JSON.parse(c.init.body).max_tokens);
  ok(mt[0] === 200 && mt[1] === 1000 && mt[2] === 1000, 'max_tokens: 200 honoured, 50000 clamped to 1000, default 1000', JSON.stringify(mt));
}

// 1b2. N2: a model the sidecar would not send is refused loudly (bad_model), never swapped for the default model the
//      loop did not price; no provider call is made. A good model id is sent as named and named in the reply.
{
  const calls = [];
  const cb = brain({ fetchImpl: replying(completion({ content: 'x' }), calls) });
  for (const bad of ['not a model id!', 'anthropic/claude-3.5-sonnet', 42, '']) {
    const r = await cb.modelTurn({ ...REQ, model: bad });
    ok(r.ok === false && r.error === 'bad_model', `N2 bad_model, no fallback: ${JSON.stringify(bad)}`, JSON.stringify(r));
  }
  ok(calls.length === 0, 'N2 no provider call for a refused model', String(calls.length));
  const good = PROVIDERS.openrouter.models.do;
  const r = await cb.modelTurn({ ...REQ, model: good });
  ok(r.ok === true && r.model === good && calls.length === 1 && JSON.parse(calls[0].init.body).model === good, 'N2 pass twin: the named model is the one sent and reported', JSON.stringify(r));
}

// 1b3. P3c: no local daily cap on agent or chat turns (CoS 12-11, then owner "Bỏ hạn mức đi nhé": the 200/day chat cap is
//      removed for all builds). Zumi is BYOK; agent turns are bounded by the per-task cap only (tool_gate.rs: 0.50 USD,
//      40 steps; cargo tests). Non-owner build (ownerAdmin false), stub fetch, fake key.
{
  const TURNS = 201; // one past the old 200/day cap
  const today = new Date().toISOString().slice(0, 10);
  const capFile = (dir) => path.join(dir, 'chat-turn-cap.json');
  const dir = tmpDir();
  const calls = [];
  const b = brain({ dir, ownerAdmin: false, fetchImpl: replying(completion({ content: 'x' }), calls) });
  let agentOk = 0;
  for (let i = 0; i < TURNS; i++) { const r = await b.modelTurn(REQ); if (r.ok === true) agentOk++; }
  ok(agentOk === TURNS && calls.length === TURNS, `P3c ${TURNS} agent turns all run on a non-owner build (no daily_cap)`, JSON.stringify({ agentOk, calls: calls.length }));
  let chatOk = 0;
  for (let i = 0; i < TURNS; i++) { const r = await b.turn({ message: `t${i}`, history: [] }); if (r.ok && r.model !== 'cap') chatOk++; }
  ok(chatOk === TURNS, `P3c then ${TURNS} chat turns on the same brain all answer (no chat cap)`, String(chatOk));
  ok(!fs.existsSync(capFile(dir)), 'P3c no chat-turn-cap.json is written');
  // An old install's counter file at 200 changes nothing.
  const old = tmpDir();
  fs.writeFileSync(capFile(old), JSON.stringify({ date: today, count: 200 }));
  const calls2 = [];
  const ob = brain({ dir: old, ownerAdmin: false, fetchImpl: replying(completion({ content: 'x' }), calls2) });
  const r1 = await ob.modelTurn(REQ);
  const r2 = await ob.turn({ message: 'hi', history: [] });
  ok(r1.ok === true && r2.ok && r2.model !== 'cap' && calls2.length === 2, 'P3c an old chat-turn-cap.json at 200 refuses neither an agent nor a chat turn', JSON.stringify({ r1: r1.ok, r2: r2.model, calls: calls2.length }));
}

// 1c. A kill aborts an in-flight modelTurn (M4): a stub fetch that hangs until its signal fires, no live provider.
{
  const hanging = (url, init) => new Promise((_res, rej) => { init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))); });
  const cb = brain({ fetchImpl: hanging });
  const t0 = Date.now();
  const pending = cb.modelTurn({ ...REQ, requestId: 'turn-1-1' });
  await new Promise((r) => setTimeout(r, 40));
  const c = cb.cancelModelTurn('turn-1-1');
  const r = await pending;
  const ms = Date.now() - t0;
  ok(c.ok === true && c.aborted === true, 'cancelModelTurn aborts the in-flight call');
  ok(r.ok === false && r.error === 'cancelled' && ms < 40 + 200, 'the call ends as cancelled within 200 ms of the cancel', JSON.stringify({ r, ms }));
  ok(cb.cancelModelTurn('turn-1-1').aborted === false && cb.cancelModelTurn(5).aborted === false, 'an unknown, finished or malformed id aborts nothing and is not an error');
  const other = brain({ fetchImpl: replying(completion({ content: 'fine' })) });
  const done = await other.modelTurn({ ...REQ, requestId: 'turn-2-1' });
  ok(done.ok === true && other.cancelModelTurn('turn-2-1').aborted === false, 'pass twin: a finished turn is not abortable and was not aborted');
}

// 2. Bites: the request shape, no key, upstream failures, no usage, bad tool arguments.
{
  const cb = brain({ fetchImpl: replying(completion({ content: 'x' })) });
  for (const [bad, why] of [[null, 'null'], [{}, 'no messages'], [{ messages: [] }, 'empty messages'], [{ messages: 'hi' }, 'messages not an array'], [{ messages: [{ role: 'user', content: 'x' }], tools: 'x' }, 'tools not an array'], [{ messages: Array.from({ length: 201 }, () => ({ role: 'user', content: 'x' })) }, 'too many messages']]) {
    const r = await cb.modelTurn(bad);
    ok(r.ok === false && r.error === 'bad_request', `bad_request: ${why}`, JSON.stringify(r));
  }
  const noKey = await brain({ key: null, fetchImpl: replying(completion({ content: 'x' })) }).modelTurn(REQ);
  ok(noKey.ok === false && noKey.error === 'no_key', 'no key saved -> no_key, no call');
  for (const [status, code] of [[401, 'auth'], [403, 'auth'], [402, 'credit'], [429, 'quota'], [500, 'upstream']]) {
    const calls = [];
    const r = await brain({ fetchImpl: failing(status, calls) }).modelTurn(REQ);
    ok(r.ok === false && r.error === code && !leaks(r), `HTTP ${status} -> ${code}`, JSON.stringify(r));
  }
  const noUsage = await brain({ fetchImpl: replying({ choices: [{ message: { content: 'hi' } }] }) }).modelTurn(REQ);
  ok(noUsage.ok === false && noUsage.error === 'no_usage', 'a reply without usage is an error, never a zero cost');
  for (const [args, why] of [['{not json', 'invalid JSON'], ['[1,2]', 'an array'], ['"rm -rf"', 'a string']]) {
    const r = await brain({ fetchImpl: replying(completion({ content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'hands.type', arguments: args } }] })) }).modelTurn(REQ);
    ok(r.ok === false && r.error === 'bad_tool_args', `bad_tool_args: ${why}`, JSON.stringify(r));
  }
  const empty = await brain({ fetchImpl: replying(completion({ content: null })) }).modelTurn(REQ);
  ok(empty.ok === true && empty.text === '' && empty.toolCalls.length === 0, 'pass twin: a reply with neither text nor calls is an empty turn, not an error');
  const res = await brain({ fetchImpl: () => Promise.reject(Object.assign(new Error('boom sk-or-v1-secret'), { name: 'TimeoutError' })) }).modelTurn(REQ);
  ok(res.ok === false && res.error === 'timeout' && !JSON.stringify(res).includes('boom'), 'a timeout is a code word, the thrown text never leaves');
}

// 3. The existing stub seams. The egress self-test guard is loopback only: with it under the transport, no request leaves
//    (the provider origin is refused), and the base fetch is never called.
{
  let base = 0;
  const guarded = selfTestFetch(() => { base++; return Promise.resolve({ ok: true, status: 200, json: async () => completion({ content: 'x' }) }); });
  const r = await brain({ fetchImpl: guarded }).modelTurn(REQ);
  ok(r.ok === false && r.error === 'upstream' && base === 0, 'selfTestFetch: a non-loopback provider origin is refused and nothing is fetched', JSON.stringify(r));
  // The measure-stub provider: a fixed offline reply through the real brain path.
  const stub = brain({ provider: MEASURE_STUB_PROVIDER, key: 'measure-stub-placeholder', fetchImpl: measureStubFetch });
  const s = await stub.modelTurn({ messages: [{ role: 'user', content: 'hi' }], model: 'measure-stub' });
  ok(s.ok === true && s.text === MEASURE_STUB_REPLY && s.toolCalls.length === 0 && s.usage.in === 1 && s.usage.out === 8, 'measure-stub provider through modelTurn', JSON.stringify(s));
}

// 4. Wiring: the handler is host-only (named __host.*) and present in chat-host and main.
{
  const chatHost = fs.readFileSync(path.join(ROOT, 'tauri/sidecar/chat-host.mjs'), 'utf8');
  const main = fs.readFileSync(path.join(ROOT, 'tauri/sidecar/main.mjs'), 'utf8');
  ok(chatHost.includes("'__host.modelTurn'") && main.includes("'__host.modelTurn'") && chatHost.includes("'__host.modelTurnCancel'") && main.includes("'__host.modelTurnCancel'"), 'handlers registered in chat-host.mjs and main.mjs');
  const inventory = fs.readFileSync(path.join(ROOT, 'docs/migration/api-inventory.json'), 'utf8');
  ok(!inventory.includes('modelTurn'), 'not in the renderer inventory (the page cannot call it)');
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
