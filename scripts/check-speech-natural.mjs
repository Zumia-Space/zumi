// check:speech-natural (T-31 alpha.13). Owner 02-11: replies are spoken, so a voice must not read emoji, "..." or markdown. Plain Node, no model, no network, no paid call.
//   1. the fixed rule: in the system text after the persona, every reply language, with the tag contract in place;
//   2. the voice filter removes only its short list; everything else passes unchanged;
//   3. the screen shows what the model wrote, minus gesture and emotion tags;
//   4. property: every corpus reply, split at every boundary, gives the voice the same chunks as the non-streamed reply;
//   5. a reply with nothing to say settles at once with no audio, through the router and the real kokoro-tts.js with `live`.
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTalkVoiceCore } from '../src/main/talk-voice-core.mjs';
const require = createRequire(import.meta.url);
const { stripMarkup, createStreamChunker, createSpeechFeed } = require('../src/main/speech-chunker.js');
const { sanitizeSpeech } = require('../src/main/quick-speech.js');
const { createReplyParser, parseReplyIntent } = require('../src/main/chat-brain.js');
const { SPOKEN_RULE, soulSystemPrompt } = require('../src/main/soul-prefs.js');
const { createKokoroTts } = require('../src/main/kokoro-tts.js');
const { createEnTtsRouter } = require('../src/main/tts-router.js');
let pass = 0, fail = 0;
const ok = (c, name, detail = '') => { if (c) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); } };

// ---------- 1. the rule ----------
const PERSONA = 'Always use lots of emoji and end every line with an ellipsis.';
for (const replyLang of ['auto', 'en', 'vi', 'zh']) {
  const text = soulSystemPrompt({ name: 'Zumi', role: 'assistant', style: 'Warm.', persona: PERSONA, replyLang, template: 'custom' });
  ok(text.indexOf(SPOKEN_RULE) > text.indexOf(PERSONA) && text.indexOf(SPOKEN_RULE) > text.indexOf('[explain]') && text.includes('Start every reply with exactly one gesture tag'), `${replyLang}: the rule is sent after the persona and the tag contract`);
}
for (const w of ['emoji', 'ellipsis', 'markdown', 'bullets', 'headings', 'code', 'URLs', 'file paths', 'symbols', 'numbers', 'leading tags']) ok(SPOKEN_RULE.includes(w), `the rule names: ${w}`);

// ---------- 2. the filter ----------
const REMOVED = [
  ['em chỉ... đứng nhìn thôi', 'em chỉ, đứng nhìn thôi'], ['em chỉ… đứng nhìn thôi', 'em chỉ, đứng nhìn thôi'], ['Để em xem...', 'Để em xem.'], ['...thật ra thì được', 'thật ra thì được'], ['Vậy à...?', 'Vậy à?'],
  ['Dạ anh 😀 em làm xong rồi 🚀👍🏽', 'Dạ anh em làm xong rồi'], ['Cờ 🇻🇳 và số 1️⃣ nhé', 'Cờ và số 1 nhé'],
  ['**Xong** rồi *anh* nhé', 'Xong rồi anh nhé'], ['một _nhẹ_ thôi', 'một nhẹ thôi'], ['# Tiêu đề\n- một\n- hai\n1. ba', 'Tiêu đề một hai 1. ba'],
  ['Chạy `npm test` đi', 'Chạy npm test đi'], ['Đây:\n```js\nconst a = 1;\n```\nxong', 'Đây: xong'],
  ['xem [tài liệu](https://a.com/x) nhé', 'xem tài liệu nhé'], ['Xem https://example.com/a?b=1 nhé', 'Xem nhé'], ['Xem www.example.com nhé', 'Xem nhé'],
  ['5 * 3 = 15', '5 × 3 = 15'], ['5*3', '5×3'], ['Dạ [smile] anh nhé', 'Dạ anh nhé'], ['[smile] Dạ anh', 'Dạ anh'], ['[Smile] Dạ anh', 'Dạ anh'], ['**7** cộng 5 * 3 **8**', '7 cộng 5 × 3 8'],
  ['10 - 3 = **7**', '10 - 3 = 7'], ['<think>nháp</think>trả lời', 'trả lời'],
];
const UNCHANGED = ['Chọn A/B/C/D nhé', 'Mon/Tue/Wed/Thu', 'Hẹn anh ngày 12/11/2026 nhé', 'Sai Gon/TP.HCM nhé', 'src/main/a.js và D:/x/y.txt', 'km/h và 3/4 và và/hoặc', '10 - 3 = 7. Anh thấy đúng', '5~10', '5 ≥ 3', '5×3 = 15', '2**3', '2 ** 3', '7. Đúng rồi', '[TODO] xong', '2+2=5', 'a = b | c', 'Một - hai — ba', 'Xong → tiếp • nữa', 'Giá 1.000 đồng, 3,5 triệu, lúc 12:30, 50%, $0.007.', 'T-31, C#, #1, snake_case_name, __init__', '[A] đúng', 'arr[i] và [x]', '<b>đậm</b>', 'Tiếng Việt: ắ ằ ẳ ẵ ặ ơ ư đ ệ ộ ữ ỹ.', '你好，今天很好。'];
for (const [input, want] of REMOVED) ok(stripMarkup(input) === want, `filter removes: ${JSON.stringify(input)}`, `got ${JSON.stringify(stripMarkup(input))}`);
for (const input of UNCHANGED) ok(stripMarkup(input) === input, `filter leaves: ${JSON.stringify(input)}`, `got ${JSON.stringify(stripMarkup(input))}`);
for (const [input] of REMOVED) ok(stripMarkup(stripMarkup(input)) === stripMarkup(input), `idempotent: ${JSON.stringify(input)}`);
ok(sanitizeSpeech('em chỉ... đứng nhìn thôi') === 'em chỉ, đứng nhìn thôi', 'a fixed line: "..." becomes a pause', sanitizeSpeech('em chỉ... đứng nhìn thôi'));

// ---------- 3. the screen ----------
const R = parseReplyIntent('[think] [sad] em chỉ... đứng nhìn thôi 😅', 'x');
ok(R.reply === 'em chỉ... đứng nhìn thôi 😅' && R.intent === 'think' && R.by === 'tag' && R.emotion, 'screen: gesture and emotion tags gone, all else stays', JSON.stringify(R));
const SCREEN = ['[docs](https://a.com) xem nhé', '[A] là đáp án đúng', 'https://example.com/a?b=1', '`npm test`', '```js\nconst a  =  1;\n```', 'Hẹn anh ngày 12/11/2026 nhé', '# Tiêu đề\n1. một\n2. hai', 'Xem src/main/a.js 😀 nhé', 'hai  khoảng trắng'];
for (const raw of SCREEN) {
  ok(parseReplyIntent(raw, 'x').reply === raw, `screen, no tag: ${JSON.stringify(raw)}`, JSON.stringify(parseReplyIntent(raw, 'x').reply));
  ok(parseReplyIntent(`[explain] ${raw}`, 'x').reply === raw, `screen, tag first: ${JSON.stringify(raw)}`, JSON.stringify(parseReplyIntent(`[explain] ${raw}`, 'x').reply));
  const p = createReplyParser();
  for (const c of `[explain] ${raw}`) p.push(c);
  p.end();
  ok(p.clean() === raw, `screen, streamed: ${JSON.stringify(raw)}`, JSON.stringify(p.clean()));
}

// ---------- 4. every boundary ----------
const CORPUS = [
  '5 * 3 = 15 anh nhé', 'Kết quả 2**3 là 8 nhé', '7. Đúng rồi anh', 'Dạ [smile] em làm xong rồi', '[smile] Dạ anh', 'Được 3 *rồi* 5 nhé',
  ...REMOVED.map((x) => x[0]), ...UNCHANGED, ...SCREEN,
  'Việc của anh nhé:\n1. Mở bảng\n2. Xem lại\n3. Chốt lại nhé', 'Việc của anh:\n- một việc\n- hai việc\n\nXong nhé.',
  'Chạy `npm test` rồi `npm run build` nhé, xong báo em.', 'Mã đây:\n```js\nconst a = 1;\n```\nXong rồi anh.',
  'A rocket climbs first... then **turns** sideways 🚀, see [the docs](https://a.io/x) or https://b.io/y now.', 'a... 😀 b', 'Một. Hai! Ba? Bốn, năm; sáu: bảy',
  '2**3 và **đậm** rồi *nghiêng*', '_nhẹ_ và _chưa đóng', '[nhãn] rồi [nhãn](u) và ![ảnh](u) xong', '今天很好😀。明天... 也好，你觉得呢？',
];
const voiceWhole = (text) => { const c = createStreamChunker(); return [...c.push(stripMarkup(text)), ...c.end()]; };
function stream(pieces, viaParser) {
  const c = createStreamChunker();
  const feed = createSpeechFeed(c);
  const out = [];
  const p = createReplyParser();
  let raw = '';
  for (const piece of pieces) {
    raw += piece;
    if (viaParser) { p.push(piece); out.push(...feed(p.clean(), false)); } else out.push(...feed(raw, false));
  }
  if (viaParser) { p.end(); out.push(...feed(p.clean(), true)); } else out.push(...feed(raw, true));
  return [...out, ...c.end()];
}
let splits = 0;
for (const text of CORPUS) {
  const want = JSON.stringify(voiceWhole(text));
  const bad = [];
  const tagged = `[explain] ${text}`;
  for (let i = 1; i < text.length; i++) { splits++; const got = JSON.stringify(stream([text.slice(0, i), text.slice(i)], false)); if (got !== want) bad.push([i, got]); }
  for (let i = 1; i < tagged.length; i++) { splits++; const got = JSON.stringify(stream([tagged.slice(0, i), tagged.slice(i)], true)); if (got !== want) bad.push([`tag ${i}`, got]); }
  for (const size of [1, 2, 3, 5, 7]) { const parts = []; for (let i = 0; i < text.length; i += size) parts.push(text.slice(i, i + size)); splits++; const got = JSON.stringify(stream(parts, false)); if (got !== want) bad.push([`by ${size}`, got]); }
  ok(bad.length === 0, `every boundary: ${JSON.stringify(text.slice(0, 44))}`, `${bad.length} bad, first ${JSON.stringify(bad[0])} want ${want}`);
}
console.log(`INFO ${CORPUS.length} replies, ${splits} splits`);
{
  const long = 'A rocket climbs first, then it turns sideways, then it keeps going for a long while. And after that it lands.';
  const c = createStreamChunker();
  const feed = createSpeechFeed(c);
  let early = 0;
  for (let i = 1; i < long.length; i++) early += feed(long.slice(0, i), false).length;
  ok(early >= 2, 'the voice speaks while the reply streams, not only at its end', String(early));
}

// ---------- 5. nothing to say ----------
const EMPTY = ['https://example.com/a', '```js\nconst a = 1;\n```', '😀🚀', '...', '…'];
const within = (promise, ms) => Promise.race([promise, new Promise((r) => setTimeout(() => r('HANG'), ms))]);
class FakeWorker extends EventEmitter { constructor() { super(); this.sent = []; } postMessage(m) { this.sent.push(m.cmd); if (m.cmd === 'ensure') setImmediate(() => this.emit('message', { type: 'ready' })); if (m.cmd === 'end') setImmediate(() => this.emit('message', { type: 'done', turnId: m.turnId })); } terminate() { return Promise.resolve(); } }
const liveOf = (text) => ({ text: () => text, onText: () => () => {}, final: Promise.resolve({ ok: true, reply: text, sources: [] }) });
for (const text of EMPTY) {
  ok(stripMarkup(text) === '', `nothing speakable: ${JSON.stringify(text)}`, stripMarkup(text));
  const fake = new FakeWorker();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-natural-'));
  const kokoro = createKokoroTts({ userDataDir: dir, workerFactory: () => fake });
  const router = createEnTtsRouter({ kokoro: { ...kokoro, available: () => true, isReady: () => true, status: () => ({ state: 'ready' }) }, sapi: { available: () => true, speak: async () => { throw new Error('sapi must not run'); } }, onMore: () => {}, log: () => {} });
  const r = await within(router.speak({ turnId: 't'.repeat(32), text, live: liveOf(text) }), 700);
  ok(r !== 'HANG' && r.ok === true && r.audios.length === 0 && r.reason === 'nothing-to-say', `live, through the router: settles with no audio: ${JSON.stringify(text)}`, JSON.stringify(r).slice(0, 120));
  ok(!fake.sent.includes('chunk'), `live: the worker gets no chunk: ${JSON.stringify(text)}`, fake.sent.join());
  const core = createTalkVoiceCore({ settings: () => ({}), saveSettings: () => {} });
  const q = await core.tts({ text }).catch((e) => ({ threw: String(e) }));
  ok(q.ok === true && q.audios && q.audios.length === 0 && q.reason === 'nothing-to-say', `not live, voice core: settles with no audio: ${JSON.stringify(text)}`, JSON.stringify(q).slice(0, 120));
}
{
  // Kokoro not loaded yet: a reply with nothing to say does not wait for it.
  const never = new Promise(() => {});
  const router = createEnTtsRouter({ kokoroOnly: true, kokoro: { available: () => true, isReady: () => false, status: () => ({ state: 'loading' }), prefetch: () => never }, sapi: { available: () => false }, onMore: () => {}, log: () => {} });
  const r = await within(router.speak({ turnId: 'u'.repeat(32), text: 'https://a.io', live: liveOf('https://a.io') }), 700);
  ok(r !== 'HANG' && r.reason === 'nothing-to-say', 'Kokoro still loading: settles at once', JSON.stringify(r));
}
const director = fs.readFileSync(new URL('../src/renderer/talk/director.js', import.meta.url), 'utf8');
ok(/'nothing-to-say'/.test(director), 'director: nothing to say is a known silence, not a failed voice (source regex)');

console.log(`\ncheck:speech-natural: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
