// Node checks for the BYO chat brain (T-31, Fable ruling 02-10): offline/mocked fetch only, no real OpenRouter
// call, no real key (every "key" here is a synthetic sk-or-... string that only needs to match reflex-jev's shape
// gate, since chat-brain reads the SAME key store).
//   mocked chat completions (success / http error / timeout / bad response) -> reply/usage/fallback,
//   the daily turn cap (blocks the 201st turn, resets on the next calendar date),
//   the origin allowlist (openrouter.ai only, across every call this script makes),
//   a key-leak sweep over every IPC-shaped surface chat-brain can hand back (turn() result, status(), the
//   talk:brainInfo projection main.js builds from it, and log lines).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const CB = require('../src/main/chat-brain.js');
const { createChatBrain, createDailyCap, callChat, assertAllowedUrl, parseReplyIntent, createReplyParser, EMOTIONS, EMOTION_PRESETS, ALLOWED_ORIGIN, CHAT_PATH, MODEL, DAILY_CAP, CAP_MESSAGE_VI, SYSTEM_PROMPT } = CB;

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
function tmpDir() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-brain-test-')); tmpDirs.push(d); return d; }
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });

// Same import flow reflex-jev.js owns: drop jev-key.import, let a keystore round-trip it into jev-key.bin. Mirrors
// check-reflex-jev.mjs's keystore tests (not re-asserted here — this file only asserts chat-brain's own surface).
function seedKey(dir) {
  const { createKeyStore } = require('../src/main/reflex-jev.js');
  const ks = createKeyStore({ safeStorage: stubSafeStorage(), dir, log: () => {} });
  fs.writeFileSync(path.join(dir, 'jev-key.import'), `${FAKE_KEY}\n`);
  ks.importIfPresent();
}

// ---------- origin allowlist ----------
ok(ALLOWED_ORIGIN === 'https://openrouter.ai', 'origin: the allowlisted origin is openrouter.ai, https');
ok(assertAllowedUrl(CHAT_PATH).href === 'https://openrouter.ai/api/v1/chat/completions', 'origin: the chat-completions url resolves inside the allowlist');
{
  let threw = false;
  try { assertAllowedUrl('https://evil.example/x'); } catch { threw = true; }
  ok(threw, 'origin: a non-allowlisted host is refused');
}

// ---------- mocked chat transport (callChat), tracking every URL requested across the whole file ----------
const requestedUrls = [];
function mockFetch({ delayMs = 1, status = 200, body = { choices: [{ message: { content: 'hi there' } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }, networkErrorMsg = null } = {}) {
  return (url, opts) => {
    requestedUrls.push(String(url));
    return new Promise((resolve, reject) => {
      if (networkErrorMsg) return reject(new Error(networkErrorMsg));
      const timer = setTimeout(() => resolve({ ok: status === 200, status, json: async () => body }), delayMs);
      const signal = opts && opts.signal;
      if (signal) {
        if (signal.aborted) { clearTimeout(timer); return reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }
        signal.addEventListener('abort', () => { clearTimeout(timer); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
      }
    });
  };
}

{
  const r = await callChat('hello', [], FAKE_KEY, { fetchImpl: mockFetch({ delayMs: 2, body: { choices: [{ message: { content: ' Xin chao! ' } }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } } }) });
  ok(r.ok && r.text === 'Xin chao!' && r.usage && r.usage.total === 5, 'callChat: a normal answer parses, trimmed', JSON.stringify(r));
}
{
  const r = await callChat('hi', [], FAKE_KEY, { fetchImpl: mockFetch({ status: 500, body: {} }) });
  ok(!r.ok && r.error === 'http_500', 'callChat: a non-200 status is a clean failure', JSON.stringify(r));
}
{
  const r = await callChat('hi', [], FAKE_KEY, { fetchImpl: mockFetch({ networkErrorMsg: 'getaddrinfo ENOTFOUND' }) });
  ok(!r.ok && !r.error.includes(FAKE_KEY), 'callChat: a network error is a clean, scrubbed failure', JSON.stringify(r));
}
{
  const r = await callChat('hi', [], FAKE_KEY, { fetchImpl: mockFetch({ body: { choices: [] } }) });
  ok(!r.ok && r.error === 'bad_response', 'callChat: an empty/odd body is refused, not thrown', JSON.stringify(r));
}
{
  // Timeout path: abort fires immediately (a pre-aborted signal), same shape check-reflex-jev.mjs exercises —
  // without waiting out chat-brain's real 20s budget in an offline check.
  const r = await callChat('hi', [], FAKE_KEY, {
    fetchImpl: (url, opts) => { requestedUrls.push(String(url)); return new Promise((_resolve, reject) => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))); },
  });
  ok(!r.ok && r.error === 'timeout', 'callChat: an aborted request reports a clean timeout', JSON.stringify(r));
}

// ---------- daily cap (generic mechanism) ----------
{
  const dir = tmpDir();
  const file = path.join(dir, 'cap.json');
  const cap = createDailyCap(file, 3);
  ok(cap.count() && cap.count() && cap.count(), 'dailyCap: the first `cap` calls all succeed');
  ok(cap.count() === false, 'dailyCap: the next call is refused once the cap is reached');
  ok(cap.total() === 3, 'dailyCap: total() stops counting the refused call');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  saved.date = '2000-01-01'; // force a stale date, as if this were yesterday's file
  fs.writeFileSync(file, JSON.stringify(saved));
  ok(cap.count() === true, 'dailyCap: a new calendar date resets the counter');
  ok(cap.total() === 1, 'dailyCap: the reset count starts from 1, not 4');
}

// ---------- createChatBrain integration: 200 turns ok, the 201st is the Vietnamese cap message, next day resets ----------
{
  const dir = tmpDir();
  seedKey(dir);
  const fetchImpl = mockFetch({ delayMs: 0 });
  const cb = createChatBrain({ safeStorage: stubSafeStorage(), dir, fetchImpl, log: () => {} });
  ok(cb.hasKey(), 'chatBrain: the seeded key is readable (same jev-key.bin reflex-jev would have imported)');
  ok(cb.status().enabled === true && cb.status().mode === 'byo', 'chatBrain: status() is enabled/byo with a key present');

  let allNormal = true;
  for (let i = 0; i < DAILY_CAP; i++) {
    const r = await cb.turn({ message: `turn ${i}`, history: [] });
    if (!r.ok || r.reply !== 'hi there' || r.model !== MODEL) { allNormal = false; break; }
  }
  ok(allNormal, `chatBrain: all ${DAILY_CAP} turns within the daily cap answer normally`);

  const over = await cb.turn({ message: 'one more', history: [] });
  ok(over.ok && over.reply === CAP_MESSAGE_VI && over.model === 'cap', `chatBrain: turn ${DAILY_CAP + 1} is blocked with the daily cap message`, JSON.stringify(over));

  // Simulate the next calendar day the same way the generic dailyCap test did: edit the persisted date.
  const capFile = path.join(dir, 'chat-turn-cap.json');
  const saved = JSON.parse(fs.readFileSync(capFile, 'utf8'));
  saved.date = '2000-01-01';
  fs.writeFileSync(capFile, JSON.stringify(saved));
  const nextDay = await cb.turn({ message: 'tomorrow', history: [] });
  ok(nextDay.ok && nextDay.reply === 'hi there' && nextDay.model === MODEL, 'chatBrain: the next calendar day answers normally again (cap reset)', JSON.stringify(nextDay));
}

// ---------- no key present: chat-brain refuses cleanly, never calls fetch ----------
{
  const dir = tmpDir(); // no jev-key.import ever dropped here
  let called = false;
  const cb = createChatBrain({ safeStorage: stubSafeStorage(), dir, fetchImpl: () => { called = true; return Promise.reject(new Error('should never be called')); }, log: () => {} });
  ok(!cb.hasKey(), 'chatBrain: no key imported -> hasKey() is false');
  ok(cb.status().enabled === false && cb.status().mode === 'off', 'chatBrain: status() is off without a key');
  const r = await cb.turn({ message: 'hello', history: [] });
  ok(!r.ok && r.error.code === 'talk_off', 'chatBrain: turn() refuses cleanly without a key', JSON.stringify(r));
  ok(!called, 'chatBrain: fetch is never reached without a key');
}

// ---------- origin sweep: every URL any test above actually requested was openrouter.ai, https ----------
ok(requestedUrls.length > 0, 'origin sweep: at least one request was made across this file\'s tests');
ok(requestedUrls.every((u) => u.startsWith(ALLOWED_ORIGIN + '/')), 'origin sweep: every request made in this whole file targeted openrouter.ai, nothing else', JSON.stringify(requestedUrls.filter((u) => !u.startsWith(ALLOWED_ORIGIN + '/'))));

// ---------- key-leak sweep: the key must not appear anywhere IPC would hand to the renderer ----------
{
  const dir = tmpDir();
  seedKey(dir);
  const cb = createChatBrain({ safeStorage: stubSafeStorage(), dir, fetchImpl: mockFetch({ delayMs: 0 }), log: () => {} });
  const turnResult = await cb.turn({ message: 'hello', history: [] });
  const status = cb.status();
  // Exactly the projection main.js's talk:brainInfo handler builds from chatBrain.status() — the renderer never
  // sees chatBrain.status() itself, only this narrower shape.
  const brainInfo = { provider: status.provider, model: status.model };
  const surfaces = { turnResult, status, brainInfo };
  const blob = JSON.stringify(surfaces);
  ok(!blob.includes(FAKE_KEY), 'leak sweep: turn()/status()/brainInfo together never contain the raw key', blob);
  ok(!blob.includes('sk-or-'), 'leak sweep: no sk-or- shaped string leaks either (scrub() replaces it)', blob);
  ok(Object.keys(brainInfo).sort().join(',') === 'model,provider', 'brainInfo: the renderer-facing projection carries exactly {provider, model}, nothing else');

  // Error-path surfaces too: an upstream failure must still come back scrubbed.
  const fresh = tmpDir();
  seedKey(fresh);
  const errCb2 = createChatBrain({ safeStorage: stubSafeStorage(), dir: fresh, fetchImpl: mockFetch({ status: 401, body: {} }), log: () => {} });
  const errResult = await errCb2.turn({ message: 'hello', history: [] });
  ok(!JSON.stringify(errResult).includes(FAKE_KEY), 'leak sweep: an upstream error turn() result never contains the raw key', JSON.stringify(errResult));
}

// ---------- emotion tags (T-31 0.2.3 B1 item 2): the inline-tag parser maps joy/sad/surprised/angry/neutral to the
// VRM expression presets, strips any tag (known or unknown) from the text, and a gesture + emotion may both lead. ----------
{
  ok(EMOTIONS.join(',') === 'joy,sad,surprised,angry,neutral', 'emotions: the five tags are recognised', EMOTIONS.join(','));
  ok(JSON.stringify(EMOTION_PRESETS) === JSON.stringify({ joy: 'happy', sad: 'sad', surprised: 'surprised', angry: 'angry', neutral: 'relaxed' }), 'emotions: each maps to a VRM expression preset (the renderer ships no neutral preset)', JSON.stringify(EMOTION_PRESETS));

  const tagCases = [['[joy] Yay!', 'happy', 'Yay!'], ['[sad] oh no', 'sad', 'oh no'], ['[surprised] Wow', 'surprised', 'Wow'], ['[angry] Stop', 'angry', 'Stop'], ['[neutral] Sure', 'relaxed', 'Sure']];
  for (const [raw, preset, reply] of tagCases) {
    const r = parseReplyIntent(raw, '');
    ok(r.reply === reply && r.emotion === preset, `emotion tag: ${JSON.stringify(raw)} -> emotion ${preset}, text ${JSON.stringify(reply)}`, JSON.stringify(r));
  }
  // gesture + emotion, either order: both are honoured and both are stripped from the reply
  ok(JSON.stringify(parseReplyIntent('[agree][joy] Sure', '')) === JSON.stringify({ reply: 'Sure', intent: 'agree', by: 'tag', emotion: 'happy' }), 'emotion tag: gesture then emotion are both honoured', JSON.stringify(parseReplyIntent('[agree][joy] Sure', '')));
  ok(parseReplyIntent('[joy] [agree] Sure', '').intent === 'agree' && parseReplyIntent('[joy] [agree] Sure', '').emotion === 'happy', 'emotion tag: emotion then gesture (either order) also honoured', JSON.stringify(parseReplyIntent('[joy] [agree] Sure', '')));
  ok(parseReplyIntent('[joy] [agree] Sure', '').by === 'tag' && parseReplyIntent('[joy] [agree] Sure', '').reply === 'Sure', 'emotion tag: space-separated tags are both consumed as the model\'s choice', JSON.stringify(parseReplyIntent('[joy] [agree] Sure', '')));
  // unknown and inline tags are stripped, and never set an emotion
  const unk = parseReplyIntent('[banana] hello there', '');
  ok(unk.reply === 'hello there' && unk.emotion === null && unk.by === 'rules', 'emotion tag: an unknown leading tag is stripped, no emotion, rule intent decides', JSON.stringify(unk));
  ok(parseReplyIntent('hello [joy] world', '').reply === 'hello world' && parseReplyIntent('hello [joy] world', '').emotion === null, 'emotion tag: an inline (non-leading) tag is stripped and ignored', JSON.stringify(parseReplyIntent('hello [joy] world', '')));

  // streaming twin: a leading emotion tag split across deltas is decided, and text stays tag-free
  const p = createReplyParser();
  let out = '';
  for (const d of ['[jo', 'y]', ' Hello', ' there [agree]', ' friend']) out += p.push(d);
  out += p.end();
  ok(p.emotion() === 'happy' && p.clean() === 'Hello there friend' && !/[[\]]/.test(out), 'emotion tag: streaming parser decides a split emotion tag and never leaks a tag', JSON.stringify({ emotion: p.emotion(), out }));
  const p2 = createReplyParser();
  let out2 = '';
  for (const d of ['[agree]', '[sur', 'prised] Behold']) out2 += p2.push(d);
  out2 += p2.end();
  ok(p2.lead() === 'agree' && p2.emotion() === 'surprised' && p2.clean() === 'Behold', 'emotion tag: a gesture then a split emotion, both decided', JSON.stringify({ lead: p2.lead(), emotion: p2.emotion(), out: out2 }));
  const p3 = createReplyParser();
  let out3 = '';
  for (const d of ['[agree] ', '[joy] ', 'Sure']) out3 += p3.push(d);
  out3 += p3.end();
  ok(p3.lead() === 'agree' && p3.emotion() === 'happy' && p3.clean() === 'Sure', 'emotion tag: a space-separated gesture+emotion pair is decided in the stream too', JSON.stringify({ lead: p3.lead(), emotion: p3.emotion(), out: out3 }));
}

// ---------- tag-stripping scope (T-31 0.2.3 B1 item 1 fix): an UNKNOWN bracketed token is a tag only when it LEADS
// the reply; anywhere else it is the owner's own text and must survive to the display and the voice. A KNOWN
// gesture/emotion tag is still stripped wherever it sits. ----------
{
  const SENT = 'Use arr[i] and - [x] done, see [docs]';
  const r = parseReplyIntent(SENT, '');
  ok(r.reply === SENT && r.emotion === null && r.by === 'rules', 'tag scope: the measured sentence (array index, checkbox, bracket label) survives intact', JSON.stringify(r));
  for (const raw of ['see [docs] for more', '- [x] done\n- [ ] todo', 'arr[i] = arr[j]', 'a [x] b [i] c [docs] d']) {
    const g = parseReplyIntent(raw, '');
    ok(g.reply === raw, `tag scope: ${JSON.stringify(raw)} is left alone`, `got ${JSON.stringify(g.reply)}`);
  }
  // a leading KNOWN tag is consumed, then the owner's brackets behind it still survive
  ok(parseReplyIntent('[agree] - [x] done', '').reply === '- [x] done', 'tag scope: a leading gesture tag is stripped, the checkbox behind it is kept', JSON.stringify(parseReplyIntent('[agree] - [x] done', '')));
  // a KNOWN gesture/emotion tag is still stripped wherever it sits
  ok(parseReplyIntent('hello [joy] world', '').reply === 'hello world', 'tag scope: a known emotion tag mid-reply is still stripped');
  ok(parseReplyIntent('hi [think] there', '').reply === 'hi there', 'tag scope: a known gesture tag mid-reply is still stripped');
  // an unknown LEADING tag is still stripped (the model opened with a tag we do not know)
  const lead = parseReplyIntent('[banana] hello there', '');
  ok(lead.reply === 'hello there' && lead.by === 'rules' && lead.emotion === null, 'tag scope: an unknown LEADING tag is stripped', JSON.stringify(lead));
  // the streaming twin keeps the owner's brackets too, and still drops the leading tag
  const p = createReplyParser();
  let out = '';
  for (const d of ['[explain] Use arr[', 'i] and - [x] done, see [docs]']) out += p.push(d);
  out += p.end();
  ok(p.clean() === SENT && out === SENT, 'tag scope: the streaming parser keeps arr[i] / [x] / [docs] and drops the leading [explain]', JSON.stringify({ clean: p.clean(), out }));
}

// ---------- the system prompt asks for emotion tags (T-31 0.2.3 B1 item 2 fix): without the line the model is never
// told the tags exist, so the whole emotion feature would be dead. ----------
{
  ok(['[joy]', '[sad]', '[surprised]', '[angry]', '[neutral]'].every((tag) => SYSTEM_PROMPT.includes(tag)), 'prompt: SYSTEM_PROMPT names all five emotion tags', SYSTEM_PROMPT.slice(-260));
  ok(/emotion tag/i.test(SYSTEM_PROMPT) && /sparing/i.test(SYSTEM_PROMPT), 'prompt: SYSTEM_PROMPT asks for one emotion tag, used sparingly');
  ok(/gesture tag in square brackets/.test(SYSTEM_PROMPT) && /You are Zumi/.test(SYSTEM_PROMPT), 'prompt: the persona text and the gesture-tag line are otherwise unchanged');
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} check-chat-brain — ${pass}/${pass + fail} assertions passed`);
process.exit(fail === 0 ? 0 : 1);
