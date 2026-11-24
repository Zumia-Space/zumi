// check:voice-route (T-31-YOKI step 3.3, plan M3): the TTS route for a chat reply on `auto` follows langOf of the reply text.
// A reply in a script no voice speaks (ja zh ko ru th ar hi) stays text only: talk.tts answers the existing voice-off-lang quiet result and
// reaches no provider. Plain Node, no network, no model call, no window: talk-voice-core with recording stub adapters and a stub Kokoro router.
//   1. the route table, through talk-voice-core.tts: one reply per language, which voice (if any) got called;
//   2. fixed reply language and Zumi's own lines are never overridden by detection;
//   3. negative control: the same texts through the OLD rule (no `reply` argument) all route to a voice, so check 1 is the change and not
//      a property of the stubs;
//   4. resolveVoice, pure.
import { createRequire } from 'node:module';
import { createTalkVoiceCore } from '../src/main/talk-voice-core.mjs';
import { langOf, LANG_TABLE } from '../src/main/voice-lang.mjs';

const require = createRequire(import.meta.url);
const { resolveVoice } = require('../src/main/tts-select.js');
let pass = 0, fail = 0;
const ok = (c, name, detail = '') => { if (c) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); } };

// One host per call: records which route spoke. settings: the saved prefs; `say` makes sayId 'live-1' a live line.
function host(settings = {}) {
  const calls = { kokoro: [], google: [], other: [] };
  const adapter = (id) => ({ synthesize: async (text, lang) => { (id === 'google' ? calls.google : calls.other).push({ id, text, lang }); return { ok: true, mime: 'audio/wav', audios: [Buffer.from('wav')], voice: id }; } });
  const logs = [];
  const core = createTalkVoiceCore({
    settings: () => settings, saveSettings: () => settings,
    adapters: () => ({ google: adapter('google'), gemini: adapter('gemini'), elevenlabs: adapter('elevenlabs') }),
    enTts: () => ({ speak: async (p) => { calls.kokoro.push(p.text); return { ok: true, mime: 'audio/wav', audios: [Buffer.from('wav')], voice: 'kokoro' }; } }),
    isLiveSay: (id) => id === 'live-1',
    forceTtsFail: () => null, realTts: () => false,
    log: (l) => logs.push(l),
  });
  return { core, calls, logs };
}
const spoke = (h) => (h.calls.kokoro.length ? 'kokoro' : h.calls.google.length ? 'google' : h.calls.other.length ? h.calls.other[0].id : 'none');
const say = async (h, text, extra = {}) => { const r = await h.core.tts({ text, turnId: 't'.repeat(32), ...extra }); return { r, voice: spoke(h) }; };

const TEXTS = {
  en: 'Sure, I can open that for you right now.',
  vi: 'Được rồi anh, em mở giúp anh ngay đây.',
  es: 'Claro, puedo abrirlo para ti ahora mismo, también si quieres.',
  fr: 'Bien sûr, je peux ouvrir cela pour vous tout de suite, et même plus.',
  pt: 'Claro, posso abrir isso para você agora mesmo, se quiser também.',
  ja: 'はい、すぐに開きますね。少しお待ちください。',
  zh: '好的，我现在就帮你打开，请稍等一下。',
  ko: '네, 지금 바로 열어 드릴게요. 잠시만 기다려 주세요.',
  ru: 'Конечно, я открою это для вас прямо сейчас.',
  th: 'ได้เลยค่ะ เดี๋ยวเปิดให้เดี๋ยวนี้นะคะ',
  ar: 'بالتأكيد، سأفتح ذلك لك الآن.',
  hi: 'ज़रूर, मैं इसे अभी आपके लिए खोल देता हूँ।',
};

// 0. the fixtures say what they claim
for (const [code, text] of Object.entries(TEXTS)) ok(langOf(text) === code, `fixture ${code}: langOf says ${code}`, String(langOf(text)));

// 1. the route table (auto, defaults: EN = kokoro, VI = google)
for (const [code, text] of Object.entries(TEXTS)) {
  const h = host({ voiceReplyLang: 'auto' });
  const { r, voice } = await say(h, text);
  const want = LANG_TABLE[code].voice; // own | english-voice | off
  if (want === 'off') ok(r.ok === true && r.reason === 'voice-off-lang' && Array.isArray(r.audios) && r.audios.length === 0 && voice === 'none', `${code}: no voice for this language -> voice-off-lang, text only, no provider called`, JSON.stringify(r).slice(0, 160));
  else if (code === 'vi') ok(voice === 'google' && h.calls.google[0].lang === 'vi', 'vi: the Vietnamese provider speaks it (lang vi)', voice);
  else ok(voice === 'kokoro' && h.calls.kokoro.length === 1, `${code}: ${want === 'own' ? 'the English voice' : 'the English voice (known limit)'} speaks it`, voice);
  if (want === 'off') ok(h.logs.some((l) => /result=voice-off-lang/.test(l) && new RegExp(`lang=${code}`).test(l)), `${code}: the turn logs result=voice-off-lang with its language`, h.logs.join('|'));
}
{
  const h = host({ voiceReplyLang: 'auto' });
  const { voice } = await say(h, 'Yes');
  ok(voice === 'kokoro', 'a reply langOf cannot tell keeps the old rule (no accent -> English voice)');
  const h2 = host({ voiceReplyLang: 'auto' });
  const { voice: v2 } = await say(h2, 'Đúng rồi');
  ok(v2 === 'google', 'a short accented Vietnamese reply still reaches the Vietnamese voice');
  const h3 = host({ voiceReplyLang: 'auto' });
  const mixed = await say(h3, 'Mình đã mở file report.pdf cho anh rồi, anh xem thử nhé.');
  ok(mixed.voice === 'google', 'Vietnamese with an English word in it stays Vietnamese');
  const h4 = host({ voiceReplyLang: 'auto' });
  const en = await say(h4, 'Hà Nội is the capital, and the weather there is mild today.');
  ok(en.voice === 'kokoro', 'English with a Vietnamese place name stays English');
}

// 2. fixed language and Zumi's own lines are not overridden
{
  const h = host({ voiceReplyLang: 'en' });
  const { r, voice } = await say(h, TEXTS.ja);
  ok(voice === 'kokoro' && r.reason !== 'voice-off-lang', 'a reply language fixed to English is the user\'s choice: detection does not override it');
  const hv = host({ voiceReplyLang: 'vi' });
  const rv = await say(hv, TEXTS.ja);
  ok(rv.voice === 'google', 'fixed to Vietnamese: same');
  const hs = host({ voiceReplyLang: 'auto', talkVoiceLang: 'en' });
  const rs = await hs.core.tts({ text: TEXTS.ja, turnId: 's'.repeat(32), sayId: 'live-1' });
  ok(rs.reason !== 'voice-off-lang', 'Zumi\'s own line routes by talkVoiceLang, not by detection');
  const hp = host({ voiceReplyLang: 'auto', voiceProviderVi: 'off' });
  const rp = await say(hp, TEXTS.vi);
  ok(rp.r.reason === 'voice-off-lang' && rp.voice === 'none', 'the Vietnamese provider set to Off still gives voice-off-lang (unchanged)');
  const hd = host({ voiceReplyLang: 'auto', voiceEnabled: false });
  ok((await say(hd, TEXTS.ja)).r.reason === 'voice-off', 'voice switched off stays voice-off (the master switch comes first)');
}

// 3. negative control: the old rule routes every one of these to a voice
for (const code of ['ja', 'zh', 'ko', 'ru', 'th', 'ar', 'hi']) {
  const r = resolveVoice({ prefs: { voiceReplyLang: 'auto' }, text: TEXTS[code] });
  ok(r.off === false && r.lang === 'en', `control: without the langOf argument ${code} text goes to the English voice (the bug 3.3 closes)`, JSON.stringify(r));
}

// 4. resolveVoice, pure
{
  const reply = (lang) => ({ lang, voice: LANG_TABLE[lang] ? LANG_TABLE[lang].voice : undefined });
  ok(JSON.stringify(resolveVoice({ prefs: { voiceReplyLang: 'auto' }, text: TEXTS.ja, reply: reply('ja') })) === JSON.stringify({ lang: 'ja', providerId: 'off', off: true }), 'resolveVoice: ja on auto -> off');
  ok(resolveVoice({ prefs: { voiceReplyLang: 'auto' }, text: TEXTS.vi, reply: reply('vi') }).lang === 'vi', 'resolveVoice: vi on auto -> vi');
  ok(resolveVoice({ prefs: { voiceReplyLang: 'auto' }, text: TEXTS.fr, reply: reply('fr') }).lang === 'en', 'resolveVoice: fr on auto -> English voice (not Vietnamese: the accent letters no longer mislead)');
  ok(resolveVoice({ prefs: { voiceReplyLang: 'auto' }, text: TEXTS.fr }).lang === 'vi', 'control: the old rule read this French text as Vietnamese (Latin-1 accents)');
  ok(resolveVoice({ prefs: { voiceReplyLang: 'auto' }, text: 'ok', reply: reply('latin') }).lang === 'en', 'resolveVoice: latin (untold) keeps the old rule');
  ok(resolveVoice({ prefs: { voiceReplyLang: 'auto' }, text: 'Xin chào', reply: reply(null) }).lang === 'vi', 'resolveVoice: null (untold) keeps the old rule');
  ok(resolveVoice({ prefs: { voiceReplyLang: 'en' }, text: TEXTS.ja, reply: reply('ja') }).off === false, 'resolveVoice: a fixed language is never overridden');
  ok(resolveVoice({ prefs: { talkVoiceLang: 'vi' }, isSay: true, text: TEXTS.ja, reply: reply('ja') }).lang === 'vi', 'resolveVoice: a say line ignores `reply`');
  ok(JSON.stringify(resolveVoice({ prefs: { voiceReplyLang: 'auto' }, text: 'hello' })) === JSON.stringify({ lang: 'en', providerId: 'kokoro', off: false }), 'resolveVoice: no `reply` argument = the old result, byte for byte');
}

console.log(`\ncheck:voice-route ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
