// T-31 voice round 6: the REAL chat path streams the reply into the voice. Round 5 measured first audio p50 3.4 s /
// p95 11.0 s, with the voice under 0.9 s of it: the app waited for the whole non-streamed reply. Checks here (no
// network, no real key, mocked SSE, same conventions as check-chat-brain.mjs / check-live-gesture.mjs):
//   1. speech-chunker: chunk 0 <= 24 chars, later <= 45, and the SAME chunks however the text is split into deltas;
//   2. reply parser: the gesture tag is stripped even when split across deltas, never a half tag in the text;
//   3. chat-brain turnStream: the head (what talk:turn returns) arrives at the first clause, BEFORE the stream ends,
//      with the intent decided once; the rest arrives on `live`; final reply = the whole reply;
//   4. request: stream on, reasoning off, the owner's model untouched, provider pinned after a fast call, unpinned
//      after a failed one; a model that refuses reasoning-off is retried once without it;
//   5. errors: a stream that fails before the first clause falls back to ONE non-streamed call (logged), except a
//      refused key; a stream that breaks after it keeps what was said (logged);
//   6. kokoro-tts speakLive: chunk 0 reaches the worker while the model is still writing;
//   7. TalkDirector on a streamed turn: one gesture at speech start, the bubble grows, history gets the final reply,
//      the turn record carries the stage split, and no "could not explain this turn" line (chat-brain: explains:false).
//   8. think ack: only when no audio by 1.2 s;
//   9. Models by role (T-31 zumi-roles): a simple turn is exactly 1 POST; Plan = one outline call before the reply
//      (hidden system message, head.planned), timeout 8 s -> plain reply; Look up = the reply's own call on the Look up
//      model + web plugin, no pin, sources from annotations, 502 -> plain Do; Check = one review after [DONE], OK/FIX,
//      500 -> nothing; switches off -> 0 extra calls; usage `kind` per role; no Claude model ever posted; the director
//      paints the chips and appends a correction to the history.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { TalkDirector } from '../src/renderer/talk/director.js';
import { SpeechLibrary } from '../src/renderer/talk/library.js';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createStreamChunker } = require('../src/main/speech-chunker.js');
const CB = require('../src/main/chat-brain.js');
const { createChatBrain, createReplyParser, MODEL, streamChat, FIRST_TOKEN_MS, IDLE_MS } = CB;
const { createKeyStore } = require('../src/main/reflex-jev.js');
const { createKokoroTts } = require('../src/main/kokoro-tts.js');

let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 1. speech-chunker ----------
const TEXTS = [
  'Sure, I can draft that email for you. Want it short and friendly, or formal?',
  'I would not skip the tests; shipping a broken build costs more time than it saves, every single time.',
  'Renting is cheaper at first because there is no upfront hardware cost at all for us.',
  'Okay!',
  'Supercalifragilisticexpialidociousandthensome is long.',
  'Version 3.5 is out, e.g. today: nice.',
];
const split = (text, mode) => {
  if (mode === 'whole') return [text];
  if (mode === 'chars') return [...text];
  const out = []; let i = 0, n = 1; while (i < text.length) { out.push(text.slice(i, i + n)); i += n; n = (n % 7) + 1; } return out;
};
for (const text of TEXTS) {
  const runs = ['whole', 'chars', 'ragged'].map((mode) => { const c = createStreamChunker(); const out = []; for (const d of split(text, mode)) out.push(...c.push(d)); out.push(...c.end()); return out; });
  ok(runs.every((r) => JSON.stringify(r) === JSON.stringify(runs[0])), `chunker: same chunks whole / per char / ragged deltas ("${text.slice(0, 24)}...")`, JSON.stringify(runs));
  const ch = runs[0];
  ok(ch[0].length <= 24 && ch.slice(1).every((c) => c.length <= 45), 'chunker: chunk 0 <= 24 chars, the rest <= 45', JSON.stringify(ch));
  ok(ch.join(' ').split(/\s+/).join(' ') === text.split(/\s+/).join(' ') || /Supercali/.test(text), 'chunker: every word kept, in order', JSON.stringify(ch));
}
{
  const c = createStreamChunker();
  ok(c.push('Sure,').length === 0, 'chunker: "Sure," with nothing after it is not a clause yet (could be "3,5")');
  ok(JSON.stringify(c.push(' I')) === '["Sure,"]', 'chunker: the clause is emitted as soon as whitespace follows the comma');
}

// ---------- 2. reply parser ----------
{
  const p = createReplyParser();
  let out = '';
  for (const d of ['[ag', 'ree]', ' Sure', ', I can [think', '] do it.']) out += p.push(d);
  out += p.end();
  ok(p.lead() === 'agree', 'parser: a lead tag split across deltas is the model\'s intent', String(p.lead()));
  ok(out === p.clean() && !/[[\]]/.test(out) && /^Sure, I can do it\.$/.test(out.replace(/\s+/g, ' ')), 'parser: tags never reach the text, even mid-stream', JSON.stringify(out));
}
{
  const p = createReplyParser();
  p.push('Hello there');
  ok(p.lead() === null && p.clean() === 'Hello there', 'parser: no leading tag -> lead null, text passes through');
}

// ---------- shared mocks ----------
const FAKE_KEY = 'sk-or-TESTFAKEKEY1234567890ABCDEFGHIJ'; // shape-valid, never a real secret
const safeStorage = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(`ENC:${s}`, 'utf8'), decryptString: (b) => b.toString('utf8').slice(4) };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-stream-'));
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
fs.writeFileSync(path.join(dir, 'jev-key.import'), FAKE_KEY);
createKeyStore({ safeStorage, dir }).importIfPresent();

const enc = new TextEncoder();
const sse = (obj) => enc.encode(`data: ${JSON.stringify(obj)}\n\n`);
// One scripted SSE response: deltas with a gap between them; `breakAfter` throws mid-stream (connection lost).
function sseResponse(deltas, { gapMs = 5, provider = 'Baidu', breakAfter = null, usage = { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52, completion_tokens_details: { reasoning_tokens: 0 } } } = {}) {
  return {
    ok: true, status: 200,
    body: (async function* () {
      yield enc.encode(': OPENROUTER PROCESSING\n\n');
      let i = 0;
      for (const d of deltas) {
        await sleep(gapMs);
        yield sse({ provider, choices: [{ delta: { content: d } }] });
        if (breakAfter !== null && ++i >= breakAfter) throw new TypeError('terminated');
      }
      yield sse({ provider, choices: [{ delta: {}, finish_reason: 'stop' }], usage });
      yield enc.encode('data: [DONE]\n\n');
    })(),
  };
}
const bodies = [];
let script = []; // queue of (body) => response
const fetchImpl = async (url, opts) => {
  const body = JSON.parse(opts.body);
  bodies.push(body);
  const next = script.shift();
  if (!next) throw new Error('test: no scripted response left');
  return next(body, opts);
};
const logs = [];
const brainFor = (extra = {}) => createChatBrain({ safeStorage, dir, fetchImpl, ownerAdmin: true, log: (m) => logs.push(m), ...extra });
const DELTAS = ['[agree]', ' Sure', ', I can', ' draft that', ' email for you.', ' Want it', ' short and friendly?'];
const FULL = 'Sure, I can draft that email for you. Want it short and friendly?';

// ---------- 3 + 4. head at the first clause, live text, final reply, request shape, provider pin ----------
{
  const OWNER_MODEL = 'google/gemini-2.5-flash-lite';
  const brain = brainFor({ model: OWNER_MODEL });
  bodies.length = 0;
  script = [() => sseResponse(DELTAS, { gapMs: 40 })];
  const t0 = Date.now();
  const { head, live } = await brain.turnStream({ turnId: 'a'.repeat(32), message: 'Can you write a short email?', history: [] });
  const headMs = Date.now() - t0;
  ok(head.ok && head.streaming === true && head.reply.startsWith('Sure,') && FULL.startsWith(head.reply) && head.reply.length < FULL.length / 2, 'turnStream: the head carries the text so far at the first clause, not the whole reply', JSON.stringify(head));
  ok(head.gesture && head.gesture.intent === 'agree', 'turnStream: the intent is decided once, at the first clause (model tag)', JSON.stringify(head.gesture));
  ok(headMs < 200, `turnStream: the head arrives before the stream ends (${headMs} ms, stream ~280 ms)`);
  ok(head.timing && head.timing.firstTokenAt >= head.timing.requestAt && head.timing.firstClauseAt >= head.timing.firstTokenAt, 'turnStream: timing has request -> first token -> first clause', JSON.stringify(head.timing));
  const seen = [];
  live.onText((t) => seen.push(t));
  const fin = await live.final;
  ok(fin.ok && fin.reply === FULL, 'turnStream: final reply is the whole tag-free reply', JSON.stringify(fin));
  ok(seen.length >= 2 && seen.every((s, i) => i === 0 || s.startsWith(seen[i - 1])) && FULL.startsWith(seen[seen.length - 1].trim()), 'turnStream: live text only ever grows', JSON.stringify(seen));
  const b = bodies[0];
  ok(b.stream === true && b.model === OWNER_MODEL, 'request: streamed, with the owner\'s model unchanged', JSON.stringify({ stream: b.stream, model: b.model }));
  ok(b.reasoning && b.reasoning.enabled === false, 'request: reasoning off per request', JSON.stringify(b.reasoning));
  ok(!b.provider, 'request: the first call is not pinned (OpenRouter routes it)', JSON.stringify(b.provider));
  ok(logs.some((l) => /turn ok model=google\/gemini-2\.5-flash-lite stream=1 firstTokenMs=\d+ firstClauseMs=\d+ .*provider=Baidu pin=none reasoning=off reasoningTokens=0 intent=agree intentBy=tag/.test(l)), 'log: one metadata line with first token, first clause, provider, pin, reasoning', JSON.stringify(logs.slice(-1)));

  script = [() => sseResponse(['[explain] Rockets', ' go sideways fast.'])];
  const second = await brain.turnStream({ turnId: 'b'.repeat(32), message: 'x', history: [] });
  await second.live.final;
  ok(bodies[1].provider && JSON.stringify(bodies[1].provider.order) === '["Baidu"]' && bodies[1].provider.allow_fallbacks === true, 'request: after a fast call the provider is pinned, fallbacks still allowed', JSON.stringify(bodies[1].provider));
  ok(bodies[1].model === OWNER_MODEL, 'request: pinning never changes the model');

  script = [() => ({ ok: false, status: 503, text: async () => 'busy' }), () => ({ ok: true, status: 200, json: async () => ({ provider: 'StreamLake', choices: [{ message: { content: '[think] Hmm, let me see.' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) })];
  const third = await brain.turnStream({ turnId: 'c'.repeat(32), message: 'x', history: [] });
  ok(third.head.ok && third.head.streaming !== true && third.head.reply === 'Hmm, let me see.' && third.live === null, 'fallback: a stream that fails before its first clause -> one non-streamed call', JSON.stringify(third.head));
  ok(bodies[3] && bodies[3].stream === undefined && bodies[3].model === OWNER_MODEL, 'fallback: the second call is non-streamed, same model', JSON.stringify(bodies[3] && { stream: bodies[3].stream, model: bodies[3].model }));
  ok(logs.some((l) => /stream failed before the first clause \(http_503\); falling back to one non-streamed call/.test(l)), 'fallback: logged explicitly');
  ok(brain.routing().provider === null, 'pin: a failed stream drops the provider pin', JSON.stringify(brain.routing()));
}

// ---------- 5. refused key: no fallback; reasoning refused: retried without it; break after first clause ----------
{
  const brain = brainFor();
  bodies.length = 0;
  script = [() => ({ ok: false, status: 401, text: async () => 'no auth' })];
  const r = await brain.turnStream({ turnId: 'd'.repeat(32), message: 'x', history: [] });
  ok(!r.head.ok && bodies.length === 1, 'errors: a refused key (401) fails once, no second call', JSON.stringify({ head: r.head, calls: bodies.length }));
  ok(!JSON.stringify(r.head).includes(FAKE_KEY), 'errors: the failure carries no key');
}
{
  // product rule: a hand-set Claude or router id in settings.json `chatModel` never runs; the default model does
  for (const bad of ['anthropic/claude-opus-5.5', 'openrouter/auto', 'nvidia/switchyard']) {
    const brain = brainFor({ model: bad });
    bodies.length = 0;
    script = [() => sseResponse(['[agree] Ok.'])];
    const r = await brain.turnStream({ turnId: '3'.repeat(32), message: 'x', history: [] });
    await r.live.final;
    ok(brain.defaultModel === MODEL && brain.status().model === MODEL && bodies.length === 1 && bodies[0].model === MODEL && logs.some((l) => /settings chatModel is not an allowed model id/.test(l)),
      `no Claude: settings chatModel ${bad} falls back to the default model (logged)`, JSON.stringify({ d: brain.defaultModel, posted: bodies.map((b) => b.model) }));
  }
  // openrouter/free picks only free models, none of them Claude (docs free-router, read 10-10): it runs as set
  const free = brainFor({ model: 'openrouter/free' });
  bodies.length = 0;
  script = [() => sseResponse(['[agree] Ok.'])];
  const rf = await free.turnStream({ turnId: '4'.repeat(32), message: 'x', history: [] });
  await rf.live.final;
  ok(free.defaultModel === 'openrouter/free' && bodies.length === 1 && bodies[0].model === 'openrouter/free', 'settings chatModel openrouter/free is sent as set (the one router allowed)', JSON.stringify(bodies.map((b) => b.model)));
}
{
  const brain = brainFor();
  bodies.length = 0;
  script = [() => ({ ok: false, status: 400, text: async () => '{"error":{"message":"Reasoning is mandatory for this endpoint and cannot be disabled."}}' }), () => sseResponse(['[agree] Yes, done.'])];
  const r = await brain.turnStream({ turnId: 'e'.repeat(32), message: 'x', history: [] });
  ok(r.head.ok && r.head.streaming && bodies.length === 2 && bodies[0].reasoning && !bodies[1].reasoning, 'reasoning: a model that refuses reasoning-off is retried once without it, still streamed', JSON.stringify(bodies.map((b) => b.reasoning || null)));
  ok(brain.routing().reasoningOff === false && logs.some((l) => /refused reasoning-off/.test(l)), 'reasoning: the session stops sending it, and says so in the log');
  await r.live.final;
}
{
  const brain = brainFor();
  script = [() => sseResponse(['[explain] A rocket', ' climbs first, then', ' turns sideways'], { breakAfter: 2 })];
  const r = await brain.turnStream({ turnId: 'f'.repeat(32), message: 'x', history: [] });
  ok(r.head.ok && r.head.streaming, 'break: the head was already sent when the stream breaks');
  const fin = await r.live.final;
  ok(!fin.ok && fin.reply === 'A rocket climbs first, then' && /terminated/.test(fin.error), 'break: the final keeps what was said and names the error', JSON.stringify(fin));
  ok(logs.some((l) => /stream broke after the first clause/.test(l)), 'break: logged explicitly');
}
{
  const brain = brainFor();
  script = [() => sseResponse(['Hello', ' there! How', ' can I help?'])];
  const r = await brain.turnStream({ turnId: '1'.repeat(32), message: 'Hi Zumi', history: [] });
  ok(r.head.gesture.intent === 'greet' && /intentBy=rules/.test((await r.live.final, logs[logs.length - 1])), 'no tag: the rule picks the intent from the first clause', JSON.stringify(r.head.gesture));
}
{
  const brain = brainFor();
  script = [() => sseResponse(['[agree] Ok.'])];
  const r = await brain.turnStream({ turnId: '2'.repeat(32), message: 'x', history: [] });
  const fin = await r.live.final;
  ok(r.head.ok && r.head.reply === 'Ok.' && fin.reply === 'Ok.', 'short reply: a reply shorter than one clause still gets a head', JSON.stringify(r.head));
}
ok(logs.every((l) => !l.includes(FAKE_KEY) && !l.includes('draft that email')), 'log: no key and no reply text in any line');

// ---------- 5b. stream timeouts (T-31 22-10): first token vs idle gap, not one 20 s total ----------
// WHY (LIVE-CHAT.md round 4/5, spare PC): Gemini streamed turns died at the old 20 s WHOLE-REQUEST limit while a
// non-streamed call on the same route answered in 10 s. A long, steadily streaming answer must no longer be cut.
const waitOrAbort = (ms, signal) => new Promise((resolve, reject) => {
  if (signal.aborted) return reject(signal.reason || Object.assign(new Error('aborted'), { name: 'AbortError' }));
  const onAbort = () => { clearTimeout(t); reject(signal.reason || Object.assign(new Error('aborted'), { name: 'AbortError' })); };
  const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
  signal.addEventListener('abort', onAbort, { once: true });
});
const timedBody = (signal, steps) => (async function* () {
  for (const s of steps) {
    if (s.wait) await waitOrAbort(s.wait, signal);
    if (s.raw) yield s.raw;
    else yield sse({ provider: 'Slow', choices: [{ delta: s.content === undefined ? {} : { content: s.content } }] });
  }
})();
const timedFetch = (steps) => async (_url, opts) => ({ ok: true, status: 200, body: timedBody(opts.signal, steps) });
const timedChat = (steps, extra = {}) => streamChat([{ role: 'user', content: 'hi' }], FAKE_KEY, { fetchImpl: timedFetch(steps), ...extra });
{
  ok(FIRST_TOKEN_MS === 30000 && IDLE_MS === 15000, 'timeouts: FIRST_TOKEN_MS is 30 s and IDLE_MS is 15 s (the two stream limits)', JSON.stringify({ FIRST_TOKEN_MS, IDLE_MS }));
}
{
  // Scaled limits keep this check near its old ~16 s runtime: 600/300 ms stand in for FIRST_TOKEN_MS/IDLE_MS, and the
  // waits keep the real ratios (a 25 s first token under a 30 s budget; 5 s chunks under a 15 s idle budget).
  const FT = 600, IDLE = 300;
  // 25/30 of the first-token budget, then steady chunks: this is exactly what the old 20 s total killed.
  const steps = [{ wait: 500, content: 'Sure' }];
  for (let i = 0; i < 4; i++) steps.push({ wait: 20, content: ' more' });
  steps.push({ raw: enc.encode('data: [DONE]\n\n') });
  const r = await timedChat(steps, { firstTokenTimeoutMs: FT, idleTimeoutMs: IDLE });
  ok(r.ok && r.text === 'Sure more more more more' && r.firstTokenMs >= 480 && r.ms >= 500,
    `timeouts: a first token at 25/30 of FIRST_TOKEN_MS then steady chunks completes (scaled; old 20 s total would cut it)`, JSON.stringify({ ok: r.ok, error: r.error, firstTokenMs: r.firstTokenMs, ms: r.ms, text: r.text }));
}
{
  // First token fast, then eight chunks at 1/3 of the idle budget (5 s under 15 s, scaled): no gap exceeds the idle
  // limit, so the turn completes. Same ratios, ~800 ms instead of 40 s.
  const steps = [{ wait: 10, content: 'Start' }];
  for (let i = 0; i < 8; i++) steps.push({ wait: 100, content: ` ${i + 1}` });
  steps.push({ raw: enc.encode('data: [DONE]\n\n') });
  const r = await timedChat(steps, { firstTokenTimeoutMs: 600, idleTimeoutMs: 300 });
  ok(r.ok && r.text === `Start ${Array.from({ length: 8 }, (_, i) => i + 1).join(' ')}` && r.ms >= 800,
    `timeouts: chunks at 1/3 of IDLE_MS for 8 rounds complete (scaled 5 s / 40 s; no idle gap, no total cap)`, JSON.stringify({ ok: r.ok, error: r.error, ms: r.ms }));
}
{
  // A mid-answer stall longer than IDLE_MS fails as timeout_idle, and the partial text survives in the fail record.
  const r = await timedChat([{ wait: 5, content: 'A' }, { wait: 400, content: 'B' }, { raw: enc.encode('data: [DONE]\n\n') }], { idleTimeoutMs: 200 });
  ok(!r.ok && r.error === 'timeout_idle' && r.gotContent === true && r.text === 'A',
    'timeouts: a stall longer than IDLE_MS fails with timeout_idle and keeps the partial text', JSON.stringify({ ok: r.ok, error: r.error, gotContent: r.gotContent, text: r.text }));
}
{
  // No content delta by FIRST_TOKEN_MS: its own error, distinct from an idle stall.
  const r = await timedChat([{ wait: 500, content: 'late' }, { raw: enc.encode('data: [DONE]\n\n') }], { firstTokenTimeoutMs: 200 });
  ok(!r.ok && r.error === 'timeout_first_token' && r.gotContent === false && r.firstTokenMs === null,
    'timeouts: no first token by FIRST_TOKEN_MS fails with timeout_first_token', JSON.stringify({ ok: r.ok, error: r.error, gotContent: r.gotContent, firstTokenMs: r.firstTokenMs }));
}
{
  // A provider that sends only SSE comment lines (keep-alives) proves the connection is alive, but it has not started
  // the answer: keep-alives must NOT re-arm the first-token budget. 300 ms budget, a ": ping" every 50 ms for 800 ms:
  // the turn must still fail at ~300 ms, not survive to the end of the keep-alive train. A mutant that re-arms the
  // first-token timer on any chunk passes the idle tests but dies here (it ends on bad_response, not timeout_first_token).
  const steps = [];
  for (let i = 0; i < 16; i++) steps.push({ wait: 50, raw: enc.encode(': ping\n\n') });
  steps.push({ raw: enc.encode('data: [DONE]\n\n') });
  const r = await timedChat(steps, { firstTokenTimeoutMs: 300 });
  ok(!r.ok && r.error === 'timeout_first_token' && r.gotContent === false && r.firstTokenMs === null && r.ms >= 295 && r.ms < 700,
    'timeouts: keep-alives alone never extend the first-token budget (timeout_first_token at FIRST_TOKEN_MS)', JSON.stringify({ ok: r.ok, error: r.error, gotContent: r.gotContent, firstTokenMs: r.firstTokenMs, ms: r.ms }));
}
{
  // The other half of the keep-alive rule: once the first content token is in, the answer has STARTED, so every chunk
  // proves the stream is alive and a keep-alive must re-arm the idle timer exactly like a content delta does. Fast first
  // delta, then ~3x IDLE_MS carrying ONLY ": ping" lines (each gap well inside IDLE_MS), then the last content delta and
  // [DONE]: the turn completes. A mutant that re-arms on content deltas only dies here with timeout_idle.
  const IDLE = 150;
  const steps = [{ wait: 10, content: 'Start' }];
  for (let i = 0; i < 9; i++) steps.push({ wait: 50, raw: enc.encode(': ping\n\n') }); // 450 ms = 3x IDLE_MS, keep-alives only
  steps.push({ wait: 10, content: ' end' });
  steps.push({ raw: enc.encode('data: [DONE]\n\n') });
  const r = await timedChat(steps, { firstTokenTimeoutMs: 300, idleTimeoutMs: IDLE });
  ok(r.ok && r.text === 'Start end' && r.error !== 'timeout_idle',
    'timeouts: after the first token ANY chunk re-arms the idle timer (3x IDLE_MS of only ": ping" keep-alives completes, no timeout_idle)', JSON.stringify({ ok: r.ok, error: r.error, ms: r.ms, text: r.text }));
}

// ---------- 6. kokoro-tts speakLive: chunk 0 reaches the worker while the reply is still streaming ----------
{
  const posted = [];
  const fake = new EventEmitter();
  fake.postMessage = (m) => {
    posted.push({ ...m, at: Date.now() });
    if (m.cmd === 'chunk') setTimeout(() => fake.emit('message', { type: 'sentence', turnId: m.turnId, index: posted.filter((p) => p.cmd === 'chunk').length - 1, text: m.text, wav: new ArrayBuffer(4), synthEndedAt: Date.now() }), 5);
    if (m.cmd === 'end') setTimeout(() => fake.emit('message', { type: 'done', turnId: m.turnId }), 10);
  };
  fake.terminate = () => {};
  const kt = createKokoroTts({ userDataDir: dir, workerFactory: () => fake });
  const brain = brainFor();
  script = [() => sseResponse(DELTAS, { gapMs: 40 })];
  const { live } = await brain.turnStream({ turnId: '3'.repeat(32), message: 'x', history: [] });
  const sentences = [];
  const done = kt.speakLive('3'.repeat(32), live, (s) => sentences.push(s));
  await sleep(15);
  const firstChunk = posted.find((p) => p.cmd === 'chunk');
  ok(firstChunk && firstChunk.text === 'Sure,' && !posted.some((p) => p.cmd === 'end'), 'speakLive: chunk 0 ("Sure,") is in the worker before the reply ends', JSON.stringify(posted.map((p) => p.cmd + ':' + (p.text || ''))));
  await done;
  const chunks = posted.filter((p) => p.cmd === 'chunk').map((p) => p.text);
  ok(chunks.join(' ') === FULL && posted[posted.length - 1].cmd === 'end', 'speakLive: every chunk, in order, then end', JSON.stringify(chunks));
  ok(sentences.length === chunks.length, 'speakLive: one sentence back per chunk');
}

// ---------- 6b. speakLive strips markup even when a construct spans deltas (T-31 0.2.3 B1 item 1) ----------
{
  const posted = [];
  const fake = new EventEmitter();
  fake.postMessage = (m) => {
    posted.push({ ...m });
    if (m.cmd === 'chunk') setTimeout(() => fake.emit('message', { type: 'sentence', turnId: m.turnId, index: posted.filter((p) => p.cmd === 'chunk').length - 1, text: m.text, wav: new ArrayBuffer(4), synthEndedAt: Date.now() }), 2);
    if (m.cmd === 'end') setTimeout(() => fake.emit('message', { type: 'done', turnId: m.turnId }), 4);
  };
  fake.terminate = () => {};
  const kt = createKokoroTts({ userDataDir: dir, workerFactory: () => fake });
  const brain = brainFor();
  const MD = ['[explain] Sure, see ', '[the docs](https://exa', 'mple.com/a/very/long/pa', 'th/here) and `pnpm test` ', 'with **care**.'];
  script = [() => sseResponse(MD, { gapMs: 15 })];
  const { live } = await brain.turnStream({ turnId: 'm'.repeat(32), message: 'x', history: [] });
  await kt.speakLive('m'.repeat(32), live, () => {});
  const spoken = posted.filter((p) => p.cmd === 'chunk').map((p) => p.text).join(' ').replace(/\s+/g, ' ').trim();
  ok(!/[[\]()`*]|https?|example\.com/.test(spoken), 'speakLive: no markup/url survives a link split across deltas', JSON.stringify(posted.filter((p) => p.cmd === 'chunk').map((p) => p.text)));
  ok(spoken === 'Sure, see the docs and pnpm test with care.', 'speakLive: the whole cleaned reply is spoken, in order', JSON.stringify(spoken));
}

// ---------- 7. TalkDirector on a streamed turn ----------
{
  const speechDir = path.join(ROOT, 'src', 'renderer', 'reflex', 'speech');
  const library = await SpeechLibrary.load(async (f) => JSON.parse(fs.readFileSync(path.join(speechDir, f), 'utf8')));
  const played = [];
  const replies = [];
  const recs = [];
  const bus = new EventEmitter();
  let audioStarts = 0;
  const analysisPainted = [];
  const brain = brainFor();
  const director = new TalkDirector({
    engine: { playCommand: (cmd, layer) => { played.push({ layer, atAudioStarts: audioStarts }); return { ok: true, trackId: `t${played.length}` }; }, player: { stop() {} }, waitLatency: () => Promise.resolve(null) },
    catalog: { get: () => null },
    cloud: {
      // What main.js's talk:turn + preload do, in-process: head back, live text/final forwarded as events.
      turn: async (p) => {
        const { head, live } = await brain.turnStream(p);
        if (live) { live.onText((text) => bus.emit('more', { turnId: p.turnId, text })); live.final.then((fin) => bus.emit('done', { turnId: p.turnId, ...fin })); }
        return head;
      },
      onReplyMore: (id, cb) => { const h = (m) => { if (m.turnId === id) cb(m.text); }; bus.on('more', h); return () => bus.off('more', h); },
      onReplyDone: (id, cb) => { const h = (m) => { if (m.turnId === id) cb(m); }; bus.on('done', h); return () => bus.off('done', h); },
      tts: async () => { await sleep(20); return { ok: true, mime: 'audio/wav', audios: [new ArrayBuffer(8)], voice: 'af_heart' }; },
      gesture: async () => ({ ok: false, error: { code: 'talk_off', message: 'off', retryable: false } }),
    },
    speech: {
      prepare: async () => ({ durationMs: 2400, start: () => { audioStarts++; return { startedAt: performance.now(), ended: sleep(400).then(() => 'ended') }; } }),
      speaking: () => false, remainingMs: () => 0, stop() {}, append() {},
    },
    library,
    cache: { pick: () => null, variants: () => [], add: () => false, toJSON: () => ({}) },
    saveCache: () => {}, probe: () => null, rigVersion: () => 'v-test',
    ui: { userLine() {}, thinking() {}, reply: (t) => replies.push(t), analysis: (lines, missing) => analysisPainted.push({ lines, missing }), gesture() {}, voiceNote() {}, voiceFailed() {} },
    log: (rec) => recs.push(rec),
  });
  script = [() => sseResponse(DELTAS, { gapMs: 40 })];
  const rec = await director.send('Can you write a short email?');
  ok(rec.outcome === 'spoken' && played.length === 1 && played[0].layer === 'speech' && played[0].atAudioStarts === 1, 'director: exactly ONE gesture, at speech start, on a streamed turn', JSON.stringify(played));
  ok(replies[0].startsWith('Sure,') && replies[0].length < FULL.length / 2 && replies[replies.length - 1] === FULL, 'director: the bubble starts at the first clause and ends with the whole reply', JSON.stringify(replies));
  ok(director.history.length === 2 && director.history[1].text === FULL, 'director: history gets the final reply, not the first clause', JSON.stringify(director.history));
  // chat-brain never asks for an explanation (explains:false): no "could not explain this turn" line on a good turn
  ok(analysisPainted.length === 0 && rec.analysis && rec.analysis.shown === null && /does not write an explanation/.test(rec.analysis.reason), 'director: a BYO turn paints no "could not explain" line (explains:false), the record says why', JSON.stringify({ analysisPainted, analysis: rec.analysis }));
  const st = rec.stages || {};
  ok(rec.streaming === true && ['requestStart', 'firstToken', 'firstClause', 'replyInRenderer', 'kokoroChunk0', 'audioStart'].every((k) => typeof st[k] === 'number') && st.firstToken <= st.firstClause && st.firstClause <= st.kokoroChunk0 && st.kokoroChunk0 <= st.audioStart, 'director: the turn record has the stage split in order', JSON.stringify(st));
}

// ---------- 7b. an instant reply (alpha.14 launch fix N1): the rest of the reply and its end arrive BEFORE talk:turn returns ----------
// The sidecar pushes talk:replyMore / talk:replyDone as the stream produces them; with a fast provider (or the first-run fetch mock)
// the whole reply is in before the head is handed back. The director used to subscribe only after the head, so those events
// were dropped: the caption kept the first clause and the history never got the reply. Two transports: Electron's ipcRenderer.on
// (a listener is live at once) and the Tauri shim's listen() (live only once it resolves: the unsubscribe carries `ready`).
for (const asyncListen of [false, true]) {
  const speechDir = path.join(ROOT, 'src', 'renderer', 'reflex', 'speech');
  const library = await SpeechLibrary.load(async (f) => JSON.parse(fs.readFileSync(path.join(speechDir, f), 'utf8')));
  const replies = [];
  const rolesPainted = [];
  const bus = new EventEmitter();
  const brain = brainFor();
  const sub = (event, id, cb, pick) => {
    const h = (m) => { if (m.turnId === id) cb(pick(m)); };
    let off;
    if (!asyncListen) { bus.on(event, h); off = () => bus.off(event, h); return off; }
    let live = true;
    // The listener goes live after the whole reply has been pushed (stream ~15 ms, listen 150 ms), so a director that sends
    // before `ready` resolves loses every event: this row fails without the director's `await ... ready` (review R2-a).
    const ready = sleep(150).then(() => { if (live) bus.on(event, h); });
    off = () => { live = false; bus.off(event, h); };
    off.ready = ready;
    return off;
  };
  const director = new TalkDirector({
    engine: { playCommand: () => ({ ok: true, trackId: 't1' }), player: { stop() {} }, waitLatency: () => Promise.resolve(null) },
    catalog: { get: () => null },
    cloud: {
      turn: async (p) => {
        const { head, live } = await brain.turnStream(p);
        if (live) { live.onText((text) => bus.emit('more', { turnId: p.turnId, text })); const fin = await live.final; bus.emit('done', { turnId: p.turnId, ...fin }); }
        bus.emit('check', { turnId: p.turnId, verdict: 'fix', text: 'Add a subject line.' }); // the Check verdict, also before the head
        return head; // the whole reply has been pushed before the head comes back
      },
      onReplyMore: (id, cb) => sub('more', id, cb, (m) => m.text),
      onReplyDone: (id, cb) => sub('done', id, cb, (m) => m),
      onCheckDone: (id, cb) => sub('check', id, cb, (m) => ({ verdict: m.verdict, text: m.text })),
      tts: async () => ({ ok: true, mime: 'audio/wav', audios: [new ArrayBuffer(8)], voice: 'af_heart' }),
      gesture: async () => ({ ok: false, error: { code: 'talk_off', message: 'off', retryable: false } }),
    },
    speech: {
      prepare: async () => ({ durationMs: 400, start: () => ({ startedAt: performance.now(), ended: sleep(50).then(() => 'ended') }) }),
      speaking: () => false, remainingMs: () => 0, stop() {}, append() {},
    },
    library,
    cache: { pick: () => null, variants: () => [], add: () => false, toJSON: () => ({}) },
    saveCache: () => {}, probe: () => null, rigVersion: () => 'v-test',
    ui: { userLine() {}, thinking() {}, reply: (t) => replies.push(t), analysis() {}, gesture() {}, voiceNote() {}, voiceFailed() {}, roles: (r) => rolesPainted.push(r.check && r.check.verdict) },
    log: () => {},
  });
  script = [() => sseResponse(DELTAS, { gapMs: 2 })];
  const rec = await director.send('Can you write a short email?');
  const how = asyncListen ? 'async listen (Tauri shim)' : 'sync listener (Electron)';
  ok(rec.outcome === 'spoken' && replies[replies.length - 1] === FULL, `director, instant reply, ${how}: the caption ends with the whole reply, not the first clause`, JSON.stringify(replies));
  ok(director.history.length === 2 && String((director.history[1] || {}).text).startsWith(FULL), `director, instant reply, ${how}: the history gets the final reply`, JSON.stringify(director.history));
  ok((director.history[1] || {}).text === `${FULL} (Correction: Add a subject line.)` && rolesPainted.includes('fix'), `director, instant reply, ${how}: a Check verdict that also beat the head reaches the chip and the history`, JSON.stringify({ history: director.history[1], rolesPainted }));
  ok(bus.listenerCount('more') === 0 && bus.listenerCount('done') === 0 && bus.listenerCount('check') === 0, `director, instant reply, ${how}: no reply or check listener is left behind`, `${bus.listenerCount('more')}/${bus.listenerCount('done')}/${bus.listenerCount('check')}`);
}

// ---------- 7c. a rejected turn (review R2-b, round 4): the turn call throws (e.g. sidecar_not_ready) ----------
// It ends like any failed turn: no reply / check listener stays, the thinking indicator goes off, the think gesture and the soft
// chime never start (or the gesture stops if it already played), the normal failure line shows, and send() resolves (app.js
// calls it without a catch, so a rejection there was unhandled).
for (const rejectAfterMs of [0, 1500]) {
  const speechDir = path.join(ROOT, 'src', 'renderer', 'reflex', 'speech');
  const library = await SpeechLibrary.load(async (f) => JSON.parse(fs.readFileSync(path.join(speechDir, f), 'utf8')));
  const bus = new EventEmitter();
  const sub = (event) => (id, cb) => { const h = (m) => { if (m.turnId === id) cb(m); }; bus.on(event, h); return () => bus.off(event, h); };
  const plays = [];
  const stops = [];
  let chimes = 0;
  const thinking = [];
  const replies = [];
  const director = new TalkDirector({
    engine: { playCommand: () => { const id = `p${plays.length + 1}`; plays.push(id); return { ok: true, trackId: id }; }, player: { stop: (id) => stops.push(id) }, waitLatency: () => Promise.resolve(null) },
    catalog: { get: () => null },
    cloud: {
      turn: async () => { await sleep(rejectAfterMs); throw new Error('sidecar_not_ready'); },
      onReplyMore: sub('more'), onReplyDone: sub('done'), onCheckDone: sub('check'),
      tts: async () => ({ ok: true, mime: 'audio/wav', audios: [], voice: 'none' }),
      gesture: async () => ({ ok: false, error: { code: 'talk_off', message: 'off', retryable: false } }),
      getThinkSound: async () => true, // "Soft sound while thinking" on
    },
    speech: { prepare: async () => null, speaking: () => false, remainingMs: () => 0, stop() {}, append() {}, chime: () => { chimes++; return true; } },
    library,
    cache: { pick: () => null, variants: () => [], add: () => false, toJSON: () => ({}) },
    saveCache: () => {}, probe: () => null, rigVersion: () => 'v-test',
    ui: { userLine() {}, thinking: (on) => thinking.push(on), reply: (text, fallback) => replies.push({ text, fallback }), analysis() {}, gesture() {}, voiceNote() {}, voiceFailed() {} },
    log: () => {},
  });
  let err = null;
  let rec = null;
  try { rec = await director.send('hello?'); } catch (e) { err = e; }
  const chimesAtEnd = chimes;
  const playsAtEnd = plays.length;
  await sleep(1500); // past the think delay (1200 ms): nothing may start after the turn ended
  const left = ['more', 'done', 'check'].map((e) => bus.listenerCount(e));
  const when = rejectAfterMs ? 'after the think ack started' : 'at once';
  ok(err === null && rec && rec.outcome === 'turn-failed' && rec.error && /sidecar_not_ready/.test(rec.error.message || ''), `director, turn rejected ${when}: send() resolves with a turn-failed record that keeps the cause`, JSON.stringify({ err: err && err.message, outcome: rec && rec.outcome, error: rec && rec.error }));
  ok(left.every((n) => n === 0), `director, turn rejected ${when}: no reply / check listener stays registered`, JSON.stringify(left));
  ok(thinking[thinking.length - 1] === false && replies.length === 1 && replies[0].text === null && typeof replies[0].fallback === 'string' && replies[0].fallback.length > 0, `director, turn rejected ${when}: the thinking indicator goes off and the normal failure line shows`, JSON.stringify({ thinking, replies }));
  ok(plays.length === playsAtEnd && chimes === chimesAtEnd && (rejectAfterMs ? plays.length === 1 && stops.includes('p1') : plays.length === 0 && chimes === 0), `director, turn rejected ${when}: ${rejectAfterMs ? 'the think gesture that started is stopped' : 'no think gesture and no chime'}, and nothing starts later`, JSON.stringify({ plays, stops, chimes }));
}

// ---------- 7d. a rejected TTS or gesture call (review R4 should-fix): the text turn stands, as for any TTS / gesture failure ----------
// A TTS call that answers ok:false keeps the shown reply, ends the turn without voice and offers the retry control; a gesture
// compose that fails leaves t.composed { ok:false } and the turn goes on. A REJECTED call (the shim's sidecar_not_ready) must end
// the same way, not skip finish(): indicator on, think ack later, an unhandled rejection in app.js.
for (const which of ['tts', 'gesture']) {
  const speechDir = path.join(ROOT, 'src', 'renderer', 'reflex', 'speech');
  const library = await SpeechLibrary.load(async (f) => JSON.parse(fs.readFileSync(path.join(speechDir, f), 'utf8')));
  const thinking = [];
  const replies = [];
  const retry = [];
  const plays = [];
  const director = new TalkDirector({
    engine: { playCommand: () => { plays.push(1); return { ok: true, trackId: `p${plays.length}` }; }, player: { stop() {} }, waitLatency: () => Promise.resolve(null) },
    catalog: { get: () => null },
    cloud: {
      turn: async () => ({ ok: true, reply: 'Sure.', analysis: null, explains: false, gesture: { intent: 'agree', brief: 'agree', energy: 'mid', deixis: 'none' } }),
      tts: async () => { if (which === 'tts') throw new Error('sidecar_not_ready'); return { ok: true, mime: 'audio/wav', audios: [], voice: 'none', reason: 'voice-off' }; },
      gesture: async () => { if (which === 'gesture') throw new Error('sidecar_not_ready'); return { ok: false, error: { code: 'talk_off', message: 'off', retryable: false } }; },
      getThinkSound: async () => true,
    },
    speech: { prepare: async () => null, speaking: () => false, remainingMs: () => 0, stop() {}, append() {}, chime: () => true },
    library,
    cache: { pick: () => null, variants: () => [], add: () => false, toJSON: () => ({}) },
    saveCache: () => {}, probe: () => null, rigVersion: () => 'v-test',
    ui: { userLine() {}, thinking: (on) => thinking.push(on), reply: (text, fallback) => replies.push({ text, fallback }), analysis() {}, gesture() {}, voiceNote() {}, voiceFailed: (fn) => retry.push(typeof fn) },
    log: () => {},
  });
  let err = null;
  let rec = null;
  try { rec = await director.send('hello?'); } catch (e) { err = e; }
  const t = director.lastTurn || {};
  await sleep(1400); // past the think delay: nothing may start after the turn ended
  ok(err === null && rec && rec.outcome === 'spoken' && replies.length === 1 && replies[0].text === 'Sure.' && thinking[thinking.length - 1] === false && plays.length === 0,
    `director, ${which} call rejected: the text reply stands, the turn ends (spoken, thinking off), no think ack starts later`, JSON.stringify({ err: err && err.message, outcome: rec && rec.outcome, replies, thinking, plays }));
  if (which === 'tts') {
    ok(rec && /sidecar_not_ready/.test(String(rec.ttsError)) && retry.length === 1 && retry[0] === 'function', 'director, tts call rejected: like a TTS ok:false, the cause is recorded and ONE retry control is offered', JSON.stringify({ ttsError: rec && rec.ttsError, retry }));
    // Review R5: the Retry voice click calls cloud.tts again; while the sidecar is still not ready that rejects too.
    const evs = [];
    director.onEvent((e) => evs.push(e));
    let retryErr = null;
    try { await director.retryVoice(t); } catch (e) { retryErr = e; }
    const rv = evs.find((e) => e.type === 'retryVoice');
    ok(retryErr === null && rv && rv.ok === false && /sidecar_not_ready/.test(String(rv.error)), 'director, Retry voice while the TTS call still rejects: resolves with a retryVoice { ok:false } event that keeps the cause', JSON.stringify({ retryErr: retryErr && retryErr.message, rv }));
  } else {
    ok(t.composed && t.composed.ok === false && /gesture_rejected/.test(t.composed.reason) && /sidecar_not_ready/.test(String(t.composed.cause)), 'director, gesture call rejected: like a failed compose, t.composed is { ok:false } with the reason and the cause', JSON.stringify(t.composed));
  }
}

// ---------- 7e. a stale turn ends while a newer one is thinking (review R4 nit): only the current turn drives the indicator ----------
// Turn A's call answers (or rejects) after turn B barged in; A's finish() used to switch the thinking indicator off under B.
for (const [aEnds, aMs, bMs] of [['resolves', 200, 600], ['rejects', 200, 600], ['resolves after B finished', 900, 300]]) {
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(String((e && e.message) || e));
  process.on('unhandledRejection', onUnhandled);
  const speechDir = path.join(ROOT, 'src', 'renderer', 'reflex', 'speech');
  const library = await SpeechLibrary.load(async (f) => JSON.parse(fs.readFileSync(path.join(speechDir, f), 'utf8')));
  const events = [];
  let calls = 0;
  const director = new TalkDirector({
    engine: { playCommand: () => ({ ok: true, trackId: 'p' }), player: { stop() {} }, waitLatency: () => Promise.resolve(null) },
    catalog: { get: () => null },
    cloud: {
      turn: async () => {
        const n = ++calls;
        await sleep(n === 1 ? aMs : bMs);
        if (n === 1 && aEnds === 'rejects') throw new Error('sidecar_not_ready');
        return { ok: true, reply: n === 1 ? 'Old.' : 'New.', analysis: null, explains: false, gesture: { intent: 'none' } };
      },
      tts: async () => ({ ok: true, mime: 'audio/wav', audios: [], voice: 'none', reason: 'voice-off' }),
      gesture: async () => ({ ok: false, error: { code: 'talk_off', message: 'off', retryable: false } }),
      ttsAbandon: async () => { throw new Error('sidecar_not_ready'); }, // the barge-in's best-effort "stop synthesizing" call
    },
    speech: { prepare: async () => null, speaking: () => false, remainingMs: () => 0, stop() {}, append() {} },
    library,
    cache: { pick: () => null, variants: () => [], add: () => false, toJSON: () => ({}) },
    saveCache: () => {}, probe: () => null, rigVersion: () => 'v-test',
    ui: { userLine: (x) => events.push(`user ${x}`), thinking: (on) => events.push(`thinking ${on}`), reply: (x, f) => events.push(`reply ${x || f}`), analysis() {}, gesture() {}, voiceNote() {}, voiceFailed() {} },
    log: () => {},
  });
  const a = director.send('A');
  await sleep(50);
  const b = director.send('B');
  const [ra, rb] = await Promise.all([a, b]);
  // Until B's reply the only "off" is B's own, right before its reply line (director: thinking(false), then reply).
  const fromB = events.slice(events.indexOf('user B'));
  const beforeReply = fromB.slice(0, fromB.indexOf('reply New.'));
  await sleep(20);
  process.off('unhandledRejection', onUnhandled);
  ok(ra.outcome === 'cancelled' && rb.outcome === 'spoken' && fromB.indexOf('reply New.') > 0 && beforeReply.filter((e) => e === 'thinking false').length === 1 && beforeReply[beforeReply.length - 1] === 'thinking false',
    `director, stale turn A ${aEnds} under turn B: B's thinking indicator stays on until B's own reply`, JSON.stringify({ ra: ra.outcome, rb: rb.outcome, events }));
  ok(director.lastTurn && director.lastTurn.id === rb.turnId, `director, stale turn A ${aEnds}: lastTurn stays B (B's Retry voice still works)`, JSON.stringify({ lastTurn: director.lastTurn && director.lastTurn.text }));
  ok(unhandled.length === 0, `director, stale turn A ${aEnds}: no unhandled rejection (a rejecting ttsAbandon at barge-in included)`, JSON.stringify(unhandled));
}

// ---------- 8. think ack (CoS decision after round 6): ONLY when no audio has started by 1200 ms, the think GESTURE;
// the soft chime only when the owner turned on Settings > Voice "Soft sound while thinking" (off by default) ----------
{
  const { THINK_AFTER_MS } = await import('../src/renderer/talk/director.js');
  const speechDir = path.join(ROOT, 'src', 'renderer', 'reflex', 'speech');
  const library = await SpeechLibrary.load(async (f) => JSON.parse(fs.readFileSync(path.join(speechDir, f), 'utf8')));
  let chimes = 0;
  let replyMs = 0;
  let ttsMs = 0;
  let thinkSound = false;
  const thinkPlays = [];
  const stopped = [];
  const d = new TalkDirector({
    engine: { playCommand: (cmd, layer, o) => { const id = `t${thinkPlays.length + stopped.length + Math.random()}`; if (/think/i.test((o && o.labelVi) || '')) thinkPlays.push(id); return { ok: true, trackId: id }; }, player: { stop: (id) => stopped.push(id) }, waitLatency: () => Promise.resolve(null) },
    catalog: { get: () => null },
    cloud: {
      turn: async () => { await sleep(replyMs); return { ok: true, reply: 'Sure.', analysis: null, gesture: { intent: 'agree', brief: 'agree', energy: 'mid', deixis: 'none' } }; },
      tts: async () => { await sleep(ttsMs); return { ok: true, mime: 'audio/wav', audios: [new ArrayBuffer(8)], voice: 'af_heart' }; },
      gesture: async () => ({ ok: false, error: { code: 'talk_off', message: 'off', retryable: false } }),
      getThinkSound: async () => thinkSound,
    },
    speech: {
      prepare: async () => ({ durationMs: 500, start: () => ({ startedAt: performance.now(), ended: Promise.resolve('ended') }) }),
      speaking: () => false, remainingMs: () => 0, stop() {}, append() {}, chime: () => { chimes++; return true; },
    },
    library, cache: { pick: () => null, variants: () => [], add: () => false, toJSON: () => ({}) },
    saveCache: () => {}, probe: () => null, rigVersion: () => 'v-test',
    ui: { userLine() {}, thinking() {}, reply() {}, analysis() {}, gesture() {}, voiceNote() {}, voiceFailed() {} },
    log: () => {},
  });
  ok(THINK_AFTER_MS === 1200, `ack: the think ack waits ${THINK_AFTER_MS} ms (CoS: 1200)`);
  replyMs = 1400; ttsMs = 0;
  const slow = await d.send('slow one');
  ok(typeof slow.timeline.thinkAt === 'number' && slow.timeline.thinkAt >= 1190 && slow.timeline.thinkAt < 1300 && thinkPlays.length === 1, `ack: no audio by 1.2 s -> the think gesture at ~1.2 s (thinkAt ${slow.timeline.thinkAt})`);
  ok(chimes === 0 && slow.timeline.ackSoundAt === undefined, 'ack: the chime is OFF by default (setting not turned on)', `chimes=${chimes}`);
  ok(stopped.includes(thinkPlays[0]), 'ack: the think gesture is stopped when the reply speaks');
  replyMs = 900; ttsMs = 500; // reply text before 1.2 s, but the first audio only at ~1.4 s: still an ack
  const late = await d.send('reply early, audio late');
  ok(typeof late.timeline.thinkAt === 'number' && late.timeline.speechStartAt > 1200 && thinkPlays.length === 2, `ack: keyed on AUDIO start, not on reply text (reply ${late.timeline.replyAt}, audio ${late.timeline.speechStartAt}, think ${late.timeline.thinkAt})`);
  replyMs = 100; ttsMs = 100;
  const fast = await d.send('fast one');
  ok(fast.timeline.thinkAt === undefined && thinkPlays.length === 2, 'ack: audio before 1.2 s -> no think gesture', JSON.stringify(fast.timeline));
  thinkSound = true; replyMs = 1400; ttsMs = 0;
  const withSound = await d.send('slow, sound on');
  ok(chimes === 1 && typeof withSound.timeline.ackSoundAt === 'number', 'ack: with "Soft sound while thinking" on, one chime with the think gesture', `chimes=${chimes}`);
  const html = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');
  const i18n = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'i18n.js'), 'utf8');
  ok(/id="think-sound"/.test(html) && /data-i18n="settings\.thinkSound"/.test(html) && !/id="think-sound"[^>]*checked/.test(html), 'settings: Voice card has the "Soft sound while thinking" checkbox, unchecked in the markup');
  ok(i18n.includes("'settings.thinkSound': 'Soft sound while thinking'") && i18n.includes("'settings.thinkSound': 'Âm báo nhẹ khi đang nghĩ'"), 'settings: EN + VI labels as decided');
}

// ---------- 9. Models by role (T-31 zumi-roles, ASTRA-SPEC.md 10-10): Plan / Check / Look up on the real turn path ----------
// Budget: a turn = the reply + at most one Plan call + at most one Check call; Look up is the reply's own call.
{
  const { resolveRoles, setRoleOn } = require('../src/main/role-models.js');
  const DO = 'deepseek/deepseek-v4-flash';
  // The provider list as Settings caches it (anthropic entries included on purpose: they must never run).
  const LIST = [
    { id: DO, name: 'DeepSeek: DeepSeek V4 Flash', reasoning: true },
    { id: 'deepseek/deepseek-v4', name: 'DeepSeek: DeepSeek V4', reasoning: true },
    { id: 'anthropic/claude-opus-5.5', name: 'Anthropic: Claude Opus 5.5', reasoning: true },
    { id: 'google/gemini-3.8-flash', name: 'Google: Gemini 3.8 Flash', reasoning: true },
  ];
  let stored = {};
  const usage = [];
  const roleLogs = [];
  const posts = []; // { body, at } of the current turn
  const allPosted = []; // every body of this section
  let rscript = [];
  let doneAt = 0; // when the last scripted stream sent [DONE]
  const roleFetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    posts.push({ body, at: Date.now() });
    allPosted.push(body);
    const next = rscript.shift();
    if (!next) throw new Error('test: no scripted response left');
    return next(body, opts);
  };
  const json = (content) => () => ({ ok: true, status: 200, json: async () => ({ provider: 'P', choices: [{ message: { content } }], usage: { prompt_tokens: 30, completion_tokens: 9, total_tokens: 39 } }) });
  const hang = () => (body, opts) => new Promise((_, reject) => { opts.signal.addEventListener('abort', () => reject(opts.signal.reason)); });
  const status = (code) => () => ({ ok: false, status: code, text: async () => 'upstream' });
  // A streamed reply; `annotations` ride on the last content delta (repeated, as OpenRouter can) and the stop chunk.
  const sseWith = (deltas, annotations) => ({
    ok: true, status: 200,
    body: (async function* () {
      for (const d of deltas) { await sleep(3); yield sse({ provider: 'Fast', choices: [{ delta: { content: d, ...(annotations ? { annotations } : {}) } }] }); }
      yield sse({ provider: 'Fast', choices: [{ delta: {}, finish_reason: 'stop', message: annotations ? { annotations } : undefined }], usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 } });
      doneAt = Date.now();
      yield enc.encode('data: [DONE]\n\n');
    })(),
  });
  const brain = createChatBrain({
    safeStorage, dir, fetchImpl: roleFetch, ownerAdmin: true, model: DO, log: (m) => roleLogs.push(m), onUsage: (rec) => usage.push(rec),
    getRoute: (defaultModel) => resolveRoles(stored, defaultModel).roles.do,
    getRoles: (defaultModel) => resolveRoles(stored, defaultModel, LIST).roles,
  });
  const defaults = resolveRoles({}, DO, LIST).defaults;
  ok(defaults.check.model !== DO && defaults.plan.model !== DO && !/claude|anthropic/i.test(defaults.check.model + defaults.plan.model) && defaults.plan.effort === 'low',
    'roles: Check/Plan default to a model other than Do (never Claude); Plan effort defaults to low', JSON.stringify(defaults));
  const turn = async (message, script) => {
    posts.length = 0; usage.length = 0; rscript = script;
    const t0 = Date.now();
    const { head, live } = await brain.turnStream({ turnId: 'r'.repeat(32), message, history: [] });
    const headAt = Date.now();
    const fin = live ? await live.final : null;
    const finAt = Date.now();
    const checked = live ? await live.checked : null;
    return { head, live, fin, checked, ms: headAt - t0, finAt };
  };
  const SHORT = ['[agree] Sure,', ' happy to help', ' with that.'];
  const LONG = ['[explain] Here is the longer answer.', ...Array.from({ length: 12 }, (_, i) => ` Point ${i + 1} explains one more detail of the plan in a full sentence.`)];

  // A. simple turn: exactly ONE POST, no web plugin, no role calls, no chips
  {
    const r = await turn('Hi Zumi, how are you?', [() => sseWith(SHORT)]);
    ok(posts.length === 1 && !posts[0].body.plugins && posts[0].body.model === DO && posts[0].body.stream === true, 'roles: a simple turn makes exactly 1 POST (no plugins, the Do model)', JSON.stringify(posts.map((p) => ({ m: p.body.model, s: p.body.stream, pl: Boolean(p.body.plugins) }))));
    ok(!r.head.planned && r.fin.ok && Array.isArray(r.fin.sources) && r.fin.sources.length === 0 && r.checked === null, 'roles: a simple turn has no Planned flag, no sources, no Check verdict', JSON.stringify({ planned: r.head.planned, sources: r.fin.sources, checked: r.checked }));
    ok(usage.length === 1 && usage[0].kind === 'chat', 'usage: a simple turn writes one "chat" line', JSON.stringify(usage));
  }
  // B. Plan: 2 POSTs, the outline reaches the reply as a hidden system message, head.planned + outline
  {
    const OUTLINE = '1. Pick a date\n2. Write the post';
    const r = await turn('Plan the launch of our app: what are the steps?', [json(`[explain] ${OUTLINE}`), () => sseWith(SHORT)]);
    const [p1, p2] = posts.map((p) => p.body);
    ok(posts.length === 2 && p1 && !p1.stream && p1.model === defaults.plan.model && p1.max_tokens === 200 && JSON.stringify(p1.reasoning) === '{"effort":"low"}' && /at most 5 one-line steps/.test(p1.messages[0].content),
      'plan: one non-streamed outline call on the Plan model (low effort, 200 tokens) before the reply', JSON.stringify(p1 && { m: p1.model, s: p1.stream, mt: p1.max_tokens, r: p1.reasoning }));
    const sys = p2 ? p2.messages.filter((m) => m.role === 'system').map((m) => m.content) : [];
    ok(p2 && p2.stream === true && p2.model === DO && sys.filter((c) => c.startsWith('Follow this outline, do not list it: ') && c.includes('Pick a date') && !/\[explain\]/.test(c)).length === 1, 'plan: the reply (Do model, streamed) gets the outline as one extra system message, tag-free', JSON.stringify(sys));
    ok(r.head.ok && r.head.planned === true && r.head.outline === OUTLINE && posts[1].at >= posts[0].at, 'plan: head.planned + the outline (the "Planned" chip tooltip)', JSON.stringify({ planned: r.head.planned, outline: r.head.outline }));
    ok(JSON.stringify(usage.map((u) => [u.kind, u.model, u.ok])) === JSON.stringify([['plan', defaults.plan.model, true], ['chat', DO, true]]), 'usage: plan + chat lines, each with its own model', JSON.stringify(usage));
    ok(roleLogs.some((l) => /plan ok model=deepseek\/deepseek-v4 effort=low ms=\d+/.test(l)) && roleLogs.some((l) => /turn ok .* planned=1$/.test(l)), 'plan: logged (metadata only)');
  }
  // C. Plan timeout (8 s): the reply still answers, without an outline
  {
    const keepAlive = setTimeout(() => {}, 12000); // AbortSignal.timeout is unref'd: hold the loop open (Electron always does)
    const r = await turn('Plan my week, step by step please', [hang(), () => sseWith(SHORT)]);
    clearTimeout(keepAlive);
    const sys = posts[1] ? posts[1].body.messages.filter((m) => m.role === 'system').map((m) => m.content) : [];
    ok(r.head.ok && !r.head.planned && r.fin.ok && posts.length === 2 && !sys.some((c) => c.startsWith('Follow this outline')), 'plan timeout: the turn still answers via Do, no outline', JSON.stringify({ head: r.head.ok, posts: posts.length }));
    ok(r.ms >= 7900 && r.ms < 9500, `plan timeout: gives up at 8 s (head after ${r.ms} ms)`);
    ok(roleLogs.some((l) => /plan skipped \(timeout\)/.test(l)) && usage[0].kind === 'plan' && usage[0].ok === false, 'plan timeout: logged as skipped, one plan usage line ok:false');
  }
  // D. Look up: ONE POST on the Look up model + web plugin, no provider pin, sources from annotations
  {
    stored = { lookup: { model: 'google/gemini-3.8-flash', effort: 'low' } };
    await turn('Hi again', [() => sseWith(SHORT)]); // a fast Do call pins its provider
    ok(brain.routing().provider === 'Fast', 'look up: (setup) the Do model has a provider pin', JSON.stringify(brain.routing()));
    const ANN = [
      { type: 'url_citation', url_citation: { url: 'https://www.kitco.com/charts/gold', title: 'Gold chart', content: 'x', start_index: 0, end_index: 3 } },
      { type: 'url_citation', url_citation: { url: 'https://www.kitco.com/charts/gold', title: 'Gold chart (dup)' } },
      { type: 'url_citation', url_citation: { url: 'javascript:alert(1)', title: 'bad' } },
      { type: 'url_citation', url_citation: { url: 'https://www.reuters.com/markets/', title: 'Markets' } },
      ...['a', 'b', 'c', 'd'].map((x) => ({ type: 'url_citation', url_citation: { url: `https://${x}.example.org/`, title: x } })),
    ];
    const r = await turn('What is the gold price today?', [() => sseWith(SHORT, ANN)]);
    const b = posts[0] && posts[0].body;
    ok(posts.length === 1 && b.model === 'google/gemini-3.8-flash' && b.stream === true && Array.isArray(b.plugins) && b.plugins[0].id === 'web' && b.plugins[0].engine === 'exa' && b.plugins[0].max_results === 5 && /no links/i.test(b.plugins[0].search_prompt),
      'look up: exactly 1 POST, the Look up model, plugins[0].id === "web" (exa, 5 results, no-links prompt)', JSON.stringify(b && { m: b.model, pl: b.plugins }));
    ok(b && !('provider' in b) && JSON.stringify(b.reasoning) === '{"effort":"low"}', 'look up: no provider pin (the pin belongs to the Do model), the Look up effort', JSON.stringify(b && { p: b.provider, r: b.reasoning }));
    const urls = r.fin.sources.map((s) => s.url);
    ok(r.fin.ok && urls.length === 5 && urls[0] === 'https://www.kitco.com/charts/gold' && urls[1] === 'https://www.reuters.com/markets/' && !urls.some((u) => !/^https:/.test(u)) && r.fin.sources[0].title === 'Gold chart',
      'look up: sources parsed from annotations (deduped by url, http(s) only, max 5, titles kept)', JSON.stringify(r.fin.sources));
    ok(usage.length === 1 && usage[0].kind === 'lookup' && usage[0].model === 'google/gemini-3.8-flash' && usage[0].ok, 'usage: the Look up reply is one "lookup" line on the Look up model', JSON.stringify(usage));
    ok(brain.routing().provider === 'Fast', 'look up: the Do model\'s pin is untouched by the Look up call');
    ok(roleLogs.some((l) => /turn ok model=google\/gemini-3\.8-flash stream=1 .* lookup=1 sources=5$/.test(l)), 'look up: logged with the Look up model and the source count');
  }
  // E. Look up 502 before the first clause: one non-streamed Do call, no plugin
  {
    const r = await turn('Latest news on rockets?', [status(502), json('[explain] Rockets are going well.')]);
    const [p1, p2] = posts.map((p) => p.body);
    ok(r.head.ok && r.head.reply === 'Rockets are going well.' && posts.length === 2 && p1.plugins && !p2.plugins && !p2.stream && p2.model === DO, 'look up 502: the turn answers via the plain Do model (non-streamed, no web plugin)', JSON.stringify({ head: r.head, p2: p2 && { m: p2.model, s: p2.stream } }));
    ok(JSON.stringify(usage.map((u) => [u.kind, u.ok])) === JSON.stringify([['lookup', false], ['chat', true]]) && roleLogs.some((l) => /lookup failed before the first clause \(http_502\)/.test(l)), 'look up 502: usage lookup ok:false + chat ok:true, logged');
  }
  // E2. Look up with a refused key (401/402/403): one error, no Do fallback call (it could only be refused again)
  for (const code of [401, 402, 403]) {
    const logFrom = roleLogs.length;
    const r = await turn('Latest news on rockets?', [status(code)]);
    const lines = roleLogs.slice(logFrom);
    ok(!r.head.ok && r.head.error && r.head.error.message === `http_${code}` && r.live === null && posts.length === 1 && posts[0].body.plugins,
      `look up ${code}: the key error surfaces once, exactly 1 POST (no Do fallback)`, JSON.stringify({ head: r.head, posts: posts.map((p) => p.body.model) }));
    ok(usage.length === 1 && usage[0].kind === 'lookup' && !usage[0].ok && lines.filter((l) => new RegExp(`turn failed: http_${code} \\(stream lookup; ${code === 402 ? 'credit' : 'auth'}, no fallback\\)`).test(l)).length === 1 && !lines.some((l) => /falling back/.test(l)),
      `look up ${code}: one lookup usage line, one "refused, no fallback" log line, no fallback line`, JSON.stringify({ usage, lines }));
  }
  // F. Check on a long reply: after [DONE], on the Check model; OK verdict; never before the final reply
  {
    stored = {};
    const r = await turn('Tell me about our product', [() => sseWith(LONG), json('OK')]);
    const c = posts[1] && posts[1].body;
    ok(r.fin.ok && r.fin.reply.length >= 400 && posts.length === 2 && c && !c.stream && c.model === defaults.check.model && c.model !== DO && c.max_tokens === 150 && c.messages[1].content.includes('Point 12'),
      'check: a 400+ char reply gets ONE review call on the Check model (not Do\'s), with the final reply', JSON.stringify(c && { m: c.model, mt: c.max_tokens, len: r.fin.reply.length }));
    ok(posts[1].at >= doneAt && r.ms <= doneAt - posts[0].at, 'check: the head came before the stream ended, the review only after [DONE] (the voice is never delayed)', JSON.stringify({ headMs: r.ms, doneMs: doneAt - posts[0].at, checkMs: posts[1].at - posts[0].at }));
    ok(r.checked && r.checked.verdict === 'ok' && r.checked.text === '', 'check: "OK" -> verdict ok (the "Checked" chip)', JSON.stringify(r.checked));
    ok(JSON.stringify(usage.map((u) => [u.kind, u.model])) === JSON.stringify([['chat', DO], ['check', defaults.check.model]]), 'usage: chat + check lines', JSON.stringify(usage));
  }
  // G. Check asked for in words, short reply: FIX with one correction sentence
  {
    const r = await turn('Check this for me: 2+2=5, right?', [() => sseWith(['[agree] Yes, 2 + 2 = 5.']), json('Correction: 2 + 2 equals 4, not 5.')]);
    ok(posts.length === 2 && r.checked && r.checked.verdict === 'fix' && r.checked.text === '2 + 2 equals 4, not 5.', 'check: asked for in words -> FIX with the correction text', JSON.stringify(r.checked));
    const vi = await turn('kiểm tra giúp anh: 2+2=5?', [() => sseWith(['[agree] Đúng rồi.']), json('2 + 2 = 4.')]);
    ok(posts.length === 2 && vi.checked && vi.checked.verdict === 'fix', 'check: Vietnamese "kiểm tra" triggers it too', JSON.stringify(vi.checked));
  }
  // H. Check 500: the turn is unchanged, no verdict, logged
  {
    const r = await turn('Please verify the totals', [() => sseWith(SHORT), status(500)]);
    ok(r.fin.ok && r.fin.reply === 'Sure, happy to help with that.' && r.checked === null && posts.length === 2, 'check 500: the reply stands, no verdict (no chip)', JSON.stringify({ fin: r.fin.ok, checked: r.checked }));
    ok(roleLogs.some((l) => /check skipped \(http_500\)/.test(l)) && usage[1].kind === 'check' && usage[1].ok === false, 'check 500: logged as skipped, one check usage line ok:false');
  }
  // I. All three switched off: a message that would trigger every role makes exactly ONE POST
  {
    stored = setRoleOn(setRoleOn(setRoleOn({}, 'plan', false).next, 'check', false).next, 'lookup', false).next;
    const r = await turn('Plan and check the latest gold price today, step by step: https://example.org/gold', [() => sseWith(LONG)]);
    ok(posts.length === 1 && !posts[0].body.plugins && posts[0].body.model === DO && !posts[0].body.messages.some((m) => /Follow this outline/.test(m.content)), 'switches off: Plan / Check / Look up all off -> exactly 1 POST, no plugin, no outline', JSON.stringify(posts.map((p) => p.body.model)));
    ok(!r.head.planned && r.checked === null && r.fin.sources.length === 0 && usage.length === 1 && usage[0].kind === 'chat', 'switches off: no Planned flag, no Check verdict, no sources; one chat usage line');
    stored = setRoleOn(stored, 'lookup', true).next;
    await turn('gold price today?', [() => sseWith(SHORT)]);
    ok(posts.length === 1 && posts[0].body.plugins && posts[0].body.plugins[0].id === 'web', 'switches: turning Look up back on applies on the next turn (no restart)');
    stored = {};
  }
  // J. no Claude model ever runs: a stored Claude choice for every role falls back to the defaults
  {
    stored = { plan: { model: 'anthropic/claude-opus-5.5', effort: 'low' }, check: { model: 'anthropic/claude-opus-5.5', effort: 'high' }, lookup: { model: 'someone/claude-distill', effort: 'low' } };
    await turn('Plan the steps and check them', [json('1. a'), () => sseWith(LONG), json('OK')]);
    const lookTurn = await turn('news today?', [() => sseWith(SHORT)]);
    ok(posts.length === 1 && posts[0].body.model === DO && lookTurn.fin.ok, 'no Claude: a stored Claude Look up model falls back to the default (Do\'s model)');
    stored = {};
  }
  ok(roleLogs.every((l) => !l.includes(FAKE_KEY) && !l.includes('Point 12') && !l.includes('Pick a date')), 'roles log: no key, no reply or outline text');
  ok(allPosted.every((b) => !/claude|anthropic/i.test(b.model)), `no Claude: none of the ${allPosted.length} POSTs in this section asked for a Claude model`, JSON.stringify(allPosted.map((b) => b.model)));

  // K. TalkDirector: the chips (Planned, Sources, Check) and the correction appended to the history
  {
    const speechDir = path.join(ROOT, 'src', 'renderer', 'reflex', 'speech');
    const library = await SpeechLibrary.load(async (f) => JSON.parse(fs.readFileSync(path.join(speechDir, f), 'utf8')));
    const bus = new EventEmitter();
    const painted = [];
    const roleAnalysis = [];
    const director = new TalkDirector({
      engine: { playCommand: () => ({ ok: true, trackId: 't' }), player: { stop() {} }, waitLatency: () => Promise.resolve(null) },
      catalog: { get: () => null },
      cloud: {
        turn: async (p) => {
          const { head, live } = await brain.turnStream(p);
          if (live) {
            live.final.then((fin) => bus.emit('done', { turnId: p.turnId, ...fin }));
            live.checked.then((c) => { if (c) bus.emit('check', { turnId: p.turnId, ...c }); });
          }
          return head;
        },
        onReplyMore: () => () => {},
        onReplyDone: (id, cb) => { const h = (m) => { if (m.turnId === id) cb(m); }; bus.on('done', h); return () => bus.off('done', h); },
        onCheckDone: (id, cb) => { const h = (m) => { if (m.turnId === id) cb({ verdict: m.verdict, text: m.text }); }; bus.on('check', h); return () => bus.off('check', h); },
        tts: async () => ({ ok: true, mime: 'audio/wav', audios: [], voice: 'none', reason: 'voice-off' }),
        gesture: async () => ({ ok: false, error: { code: 'talk_off', message: 'off', retryable: false } }),
      },
      speech: { prepare: async () => null, speaking: () => false, remainingMs: () => 0, stop() {}, append() {} },
      library, cache: { pick: () => null, variants: () => [], add: () => false, toJSON: () => ({}) },
      saveCache: () => {}, probe: () => null, rigVersion: () => 'v-test',
      ui: { userLine() {}, thinking() {}, reply() {}, analysis: (lines, missing) => roleAnalysis.push(missing), gesture() {}, voiceNote() {}, voiceFailed() {}, roles: (s) => painted.push(JSON.parse(JSON.stringify(s))) },
      log: () => {},
    });
    const checkedP = new Promise((res) => director.onEvent((ev) => { if (ev.type === 'checked') res(ev); }));
    rscript = [json('1. Do the sum'), () => sseWith(['[agree] Yes, 2 + 2 = 5.']), json('2 + 2 equals 4, not 5.')];
    const rec = await director.send('Plan it: check 2+2=5 step by step');
    await checkedP;
    const last = painted[painted.length - 1];
    ok(rec.planned === true && painted[0].planned === true && painted[0].outline === '1. Do the sum', 'director: the Planned chip is painted with the reply (outline as its tooltip)', JSON.stringify(painted[0]));
    ok(last.check && last.check.verdict === 'fix' && last.check.text === '2 + 2 equals 4, not 5.', 'director: the Check correction is painted after the reply (text row)', JSON.stringify(last));
    ok(director.history[1].text === 'Yes, 2 + 2 = 5. (Correction: 2 + 2 equals 4, not 5.)', 'director: the correction is appended to the assistant history entry, so the next turn knows', JSON.stringify(director.history));
    rscript = [() => sseWith(SHORT, [{ type: 'url_citation', url_citation: { url: 'https://www.bbc.com/news', title: 'BBC' } }])];
    painted.length = 0;
    await director.send('weather today?');
    await sleep(30);
    ok(painted.some((s) => s.sources.length === 1 && s.sources[0].url === 'https://www.bbc.com/news'), 'director: a Look up reply paints its Sources row', JSON.stringify(painted));
    ok(roleAnalysis.length === 0, 'director: Plan / Check / Look up turns paint no "could not explain this turn" line either', JSON.stringify(roleAnalysis));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
