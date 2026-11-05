// T-31 QC-cuoi fix a (09-10): the LIVE chat path (chat-brain.js, DeepSeek via OpenRouter) must hand the renderer a
// real speech intent, so the SAME mapping the fixture path uses (TalkDirector.pickAtStart: cache > library >
// built-in) plays exactly ONE gesture per reply, at speech start, through the same gesture runtime.
// Red on 17382db: chat-brain returned intent 'none' on every live turn, so 0 gestures played.
// No network, no real key: mocked fetch + a synthetic shape-valid key, same convention as check-chat-brain.mjs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { TalkDirector } from '../src/renderer/talk/director.js';
import { SpeechLibrary } from '../src/renderer/talk/library.js';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createChatBrain } = require('../src/main/chat-brain.js');
const { createKeyStore } = require('../src/main/reflex-jev.js');

let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); } };

const FAKE_KEY = 'sk-or-TESTFAKEKEY1234567890ABCDEFGHIJ'; // shape-valid, never a real secret
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`ENC:${s}`, 'utf8'),
  decryptString: (b) => b.toString('utf8').slice(4),
};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-gesture-'));
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
fs.writeFileSync(path.join(dir, 'jev-key.import'), FAKE_KEY);
createKeyStore({ safeStorage, dir }).importIfPresent();

// Mocked OpenRouter: answers with whatever `nextContent` holds, records the request body.
let nextContent = '';
let lastBody = null;
const fetchImpl = async (url, opts) => {
  lastBody = JSON.parse(opts.body);
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: nextContent } }], usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 } }) };
};
const logs = [];
const brain = createChatBrain({ safeStorage, dir, fetchImpl, ownerAdmin: true, log: (m) => logs.push(m) });

// ---------- 1. chat-brain emits a real intent (tagged by the model, or by the fallback rule), never 'none' ----------
const CASES = [
  { content: '[greet] Good morning! Glad yesterday went well.', intent: 'greet', by: 'tag' },
  { content: '[agree] Sure, I can draft that email for you.', intent: 'agree', by: 'tag' },
  { content: '[disagree] I would not skip the tests.', intent: 'disagree', by: 'tag' },
  { content: '[think] Renting is cheaper at first; buying wins after two years.', intent: 'think', by: 'tag' },
  { content: '[celebrate] Ten thousand users, that is huge!', intent: 'celebrate', by: 'tag' },
  { content: '[point-screen] Your board shows two tasks waiting on you.', intent: 'point-screen', by: 'tag' },
  { content: '[explain] A rocket burns fuel to climb, then turns sideways to gain speed.', intent: 'explain', by: 'tag' },
  { content: 'Hello there! How can I help today?', intent: 'greet', by: 'rules' }, // model ignored the tag
  { content: 'Sounds good, I will keep it short.', intent: 'agree', by: 'rules' },
  { content: 'A rocket reaches orbit by going sideways fast enough.', intent: 'explain', by: 'rules' },
];
const replies = [];
for (const c of CASES) {
  nextContent = c.content;
  const r = await brain.turn({ message: 'test line', history: [] });
  replies.push({ ...c, r });
  ok(r.ok && r.gesture && r.gesture.intent === c.intent, `chat-brain: "${c.content.slice(0, 40)}" -> intent ${c.intent}`, JSON.stringify(r.gesture));
  ok(r.ok && !/\[[a-z-]+\]/i.test(r.reply), `chat-brain: the gesture tag never reaches the reply text (${c.intent})`, JSON.stringify(r.reply));
  ok(r.ok && ['low', 'mid', 'high'].includes(r.gesture.energy) && typeof r.gesture.brief === 'string' && r.gesture.deixis, `chat-brain: gesture has the fixture/cloud contract shape (${c.intent})`, JSON.stringify(r.gesture));
}
ok(logs.some((l) => /intent=greet intentBy=tag/.test(l)) && logs.some((l) => /intentBy=rules/.test(l)), 'chat-brain: the log says which intent and whether the model tag or the rule chose it', JSON.stringify(logs.slice(-2)));
ok(logs.every((l) => !l.includes(FAKE_KEY) && !l.includes('Good morning')), 'chat-brain: the log carries no key and no reply text');
ok(lastBody && /gesture tag/.test(lastBody.messages[0].content), 'chat-brain: the system prompt asks the model for the gesture tag');
{
  nextContent = '[agree]';
  const r = await brain.turn({ message: 'x', history: [] });
  ok(!r.ok, 'chat-brain: a reply that is only a tag is a failed turn, never an empty spoken reply', JSON.stringify(r));
}

// ---------- 2. the SAME mapping the fixture path uses: TalkDirector + the real shipped speech library ----------
const speechDir = path.join(ROOT, 'src', 'renderer', 'reflex', 'speech');
const library = await SpeechLibrary.load(async (f) => JSON.parse(fs.readFileSync(path.join(speechDir, f), 'utf8')));
const played = [];
let audioStarts = 0;
const director = new TalkDirector({
  engine: { playCommand: (cmd, layer) => { played.push({ cmd, layer, atAudioStarts: audioStarts }); return { ok: true, trackId: `t${played.length}` }; }, player: { stop() {} }, waitLatency: () => Promise.resolve(null) },
  catalog: { get: () => null },
  cloud: {
    turn: (p) => brain.turn(p), // the LIVE chat-brain path (mocked network), not cloud.js fixtures
    tts: async () => ({ ok: true, mime: 'audio/wav', audios: [new ArrayBuffer(8)], voice: 'af_heart' }),
    gesture: async () => ({ ok: false, error: { code: 'talk_off', message: 'off', retryable: false } }), // as in the owner build
  },
  speech: {
    prepare: async () => ({ durationMs: 2400, start: () => { audioStarts++; return { startedAt: performance.now(), ended: Promise.resolve('ended') }; } }),
    speaking: () => false, remainingMs: () => 0, stop() {}, append() {},
  },
  library,
  cache: { pick: () => null, variants: () => [], add: () => false, toJSON: () => ({}) },
  saveCache: () => {}, probe: () => null, rigVersion: () => 'v-test',
  ui: { userLine() {}, thinking() {}, reply() {}, analysis() {}, gesture() {}, voiceNote() {}, voiceFailed() {} },
  log: () => {},
});
for (const c of CASES) {
  nextContent = c.content;
  const before = played.length;
  const rec = await director.send('test line');
  const mine = played.slice(before);
  const libIds = (library.byIntent.get(c.intent) || { variants: [] }).variants.map((v) => v.id);
  ok(rec.outcome === 'spoken' && mine.length === 1, `director: exactly ONE gesture for the live "${c.intent}" reply`, `played=${mine.length} outcome=${rec.outcome}`);
  ok(rec.first && rec.first.source === 'library' && libIds.includes(rec.first.id), `director: it is a ${c.intent} variant from the shipped library (same mapping as fixtures)`, JSON.stringify(rec.first));
  ok(mine.length === 1 && mine[0].layer === 'speech' && mine[0].atAudioStarts === audioStarts, `director: it starts with the speech audio (${c.intent})`, JSON.stringify(mine.map((m) => m.atAudioStarts)));
}

// ---------- 3. the logged LLM time covers the whole reply, not just the headers (round-5 instrument fix) ----------
// OpenRouter sends status/headers at once and the body when the model is done; a 300 ms body must show up.
{
  const slowBody = async () => ({ ok: true, status: 200, json: () => new Promise((res) => setTimeout(() => res({ choices: [{ message: { content: '[agree] Sure.' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), 300)) });
  const tlogs = [];
  const b2 = createChatBrain({ safeStorage, dir, fetchImpl: slowBody, ownerAdmin: true, log: (m) => tlogs.push(m) });
  const r = await b2.turn({ message: 'x', history: [] });
  ok(r.ok && r.latencyMs >= 290, `chat-brain: latencyMs includes the body wait (${r.latencyMs} ms >= 290)`);
  ok(tlogs.some((l) => /latencyMs=\d{3,} headersMs=\d+ /.test(l)), 'chat-brain: the log carries both the whole-call and the headers time', JSON.stringify(tlogs));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
