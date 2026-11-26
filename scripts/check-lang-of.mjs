// check:lang-of (T-31-YOKI step 3.1). Plain Node, no network, no model call, no app.
//   1. every supported language (en vi ja zh es fr pt): at least 5 samples, at least 2 of them 1-3 words, all told right;
//   2. the other scripts the table knows (ko ru th ar hi) are told by script;
//   3. mixed text, a Vietnamese name inside English, and Vietnamese without tone marks;
//   4. text that cannot be told: emoji only, digits, code, links, one letter, an ambiguous word: null or 'latin', never a guess;
//   5. the output states what the caller does when the language cannot be told.
import { langOf, langDetail, LANG_TABLE, WHEN_UNTOLD } from '../src/main/voice-lang.mjs';

let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); } };
const words = (s) => s.trim().split(/\s+/).length;

const SAMPLES = {
  en: ['Hello', 'thanks a lot', 'Can you help me with this?', 'What time is it in Tokyo right now?', 'I think we should leave before it gets dark.', 'yes please', 'Good morning! How are you today?'],
  vi: ['Cảm ơn', 'Dạ vâng ạ', 'Hôm nay mình hơi mệt', 'Em có thể giúp anh việc này không?', 'Mai trời có mưa không nhỉ?', 'Chào buổi sáng', 'Anh muốn nghe nhạc nhẹ nhàng một chút'],
  ja: ['ありがとう', 'こんにちは', '今日はとても疲れました', '東京の天気はどうですか？', 'この資料を日本語に訳してください', 'おはよう', 'カレーが食べたいです'],
  zh: ['谢谢', '你好', '今天天气怎么样？', '请帮我看看这份文件', '我有点累了，想早点休息', '早上好', '明天有会议吗'],
  es: ['Gracias', 'Hola', 'buenos días', '¿Qué hora es en Madrid?', 'Necesito ayuda con esto, por favor', 'Mañana voy a estar muy ocupado', 'No sé cómo hacerlo'],
  fr: ['Merci', 'Bonjour', 'je ne sais pas', "Qu'est-ce que tu fais ce soir ?", "Pouvez-vous m'aider avec ceci, s'il vous plaît ?", 'Il fait très beau aujourd’hui', 'Où est la gare ?'],
  pt: ['Obrigado', 'Olá', 'bom dia', 'Preciso de ajuda com isso, por favor', 'Eu não sei como fazer isso', 'Amanhã eu vou estar muito ocupado', 'Você está aí?'],
};
const OTHER_SCRIPTS = { ko: ['감사합니다', '오늘 날씨가 어때요?'], ru: ['Спасибо', 'Как дела сегодня?'], th: ['ขอบคุณ', 'วันนี้อากาศเป็นอย่างไร'], ar: ['شكرا', 'كيف حالك اليوم؟'], hi: ['धन्यवाद', 'आज मौसम कैसा है?'] };

// 1. supported languages
for (const [lang, list] of Object.entries(SAMPLES)) {
  const short = list.filter((t) => words(t) <= 3).length;
  ok(list.length >= 5 && short >= 2, `${lang}: ${list.length} samples, ${short} of 1-3 words`);
  const wrong = list.map((t) => [t, langOf(t)]).filter(([, got]) => got !== lang);
  ok(wrong.length === 0, `${lang}: all ${list.length} told right`, JSON.stringify(wrong));
}
// 2. other scripts
for (const [lang, list] of Object.entries(OTHER_SCRIPTS)) {
  const wrong = list.map((t) => [t, langOf(t)]).filter(([, got]) => got !== lang);
  ok(wrong.length === 0, `${lang}: told by script`, JSON.stringify(wrong));
}
// 3. mixed and tricky text
const MIXED = [
  ['Open the Chrome settings and click 設定 to change it', 'en', 'mostly English, one Japanese word'],
  ['Hanoi (Hà Nội) is lovely in autumn, you should visit', 'en', 'one Vietnamese name inside English'],
  ['Mở Chrome rồi vào Settings giúp mình nhé', 'vi', 'Vietnamese with English app words'],
  ['toi khong biet', 'vi', 'Vietnamese without tone marks'],
  ['cam on ban nhieu', 'vi', 'Vietnamese without tone marks'],
  ['你好 ok', 'zh', 'Chinese with an English word'],
  ['今日は meeting がある', 'ja', 'Japanese with an English word'],
  ['https://example.com 谢谢你', 'zh', 'link stripped, Chinese stays'],
  ['Thanks 😊 see you at 5', 'en', 'emoji and digits stripped'],
];
for (const [t, want, why] of MIXED) ok(langOf(t) === want, `mixed: ${why}`, `${JSON.stringify(t)} -> ${langOf(t)}`);
// 3b. collision words and names (review 21-11): a word that English or Vietnamese also uses must not decide es/fr/pt,
//     and a few Vietnamese names must not turn an English sentence Vietnamese. `want` may be a list when two answers are fine.
const COLLIDE = [
  ['As soon as possible', ['en'], 'review: "as" is not Portuguese'], ['Same as before', ['en'], 'review'], ['as well', ['en'], 'review'],
  ['AI', [null], 'review: "ai" is not French'], ['Ok AI', ['latin'], 'review'], ['pro tip', ['latin'], 'review: "pro" is not Portuguese'],
  ['um ok', ['latin'], 'review: "um" is not Portuguese'], ['em an com chua', ['vi', 'latin'], 'review: unaccented Vietnamese is never pt'],
  ['e an com chua', ['vi', 'latin'], 'review'], ['em oi', ['vi', 'latin'], 'review'], ['oi', [null], 'review: one word'],
  ['Chó con', ['latin', null], 'review: "con" is not Spanish'], ['Mã', [null], 'review: one accent letter is no evidence'],
  ['Vã quá', ['vi', 'latin'], 'review'],
  ['Tell Đức and Phương I said hi', ['en'], 'review: two Vietnamese names in English'],
  ['Meeting with Đức at Quận 1', ['en', 'latin'], 'review: two Vietnamese names in English'],
  ['Ask Hùng and Thư what they want', ['en'], 'own: two names, English words win'],
  ['Mom met Lan and Dũng at the market today', ['en'], 'own: names inside English'],
  ['Thanks, Phương!', ['en'], 'own: one name, one English word'],
  ['I said so to Đức', ['en'], 'own: one name'],
  ['Anh Đức ơi, em đây', ['vi'], 'own: Vietnamese that carries marked words'],
  ['Em ơi, giúp anh với', ['vi'], 'own: Vietnamese, short'],
  ['pro um ai', ['latin'], 'own: only collision words'],
  ['son con ai', ['latin'], 'own: only collision words'],
  ['A son of the sea, as they say', ['en'], 'own: "son" and "as" inside English'],
  ['Gracias, as always', ['latin'], 'own: one Spanish word against one English word is a tie'],
  ['ça va', ['fr', 'latin'], 'own: short French'], ['Tudo bem?', ['pt'], 'own: short Portuguese'],
  ['quero um café', ['pt'], 'own: Portuguese with the shared word "um"'],
  ['vamos com calma', ['latin', null], 'own: no distinctive list word, stays unsure'],
  ['Hola, ¿cómo estás?', ['es'], 'own'], ['Merci beaucoup pour tout', ['fr'], 'own'], ['Não sei, tá', ['pt'], 'own'],
  ['了解', [null], 'review: Han only, Japanese or Chinese'], ['大丈夫', [null], 'review: Han only, Japanese or Chinese'],
  ['了解です', ['ja'], 'own: kana settles it'], ['谢谢你', ['zh'], 'own: simplified Chinese still told'],
];
for (const [t, want, why] of COLLIDE) { const got = langOf(t); ok(want.includes(got), `collide: ${why}`, `${JSON.stringify(t)} -> ${got}, wanted ${JSON.stringify(want)}`); }
ok(langDetail('了解').reason === 'han-ambiguous', 'Han-only ambiguous word says why it is untold');
// 4. cannot be told
const UNTOLD = [
  ['😀😀😀', null, 'emoji only'], ['12345 678', null, 'digits only'], ['', null, 'empty'], [null, null, 'null input'],
  ['```js\nconst a = 1;\n```', null, 'a code block only'], ['https://example.com/a/b?c=d', null, 'a link only'],
  ['k', null, 'one letter'], ['ok', null, 'a two-letter word in no list'], ['hmm', null, 'three letters in no list'],
  ['no', null, 'two letters used by en, es and pt'],
  ['la', null, 'a word es and fr share, too short to count'],
  ['la casa es grande', 'es', 'sanity: a shared word plus clear ones'], ['haha', 'latin', 'four Latin letters, no list word'],
  ['no no no', 'latin', 'a word used by several languages, in no list'],
];
for (const [t, want, why] of UNTOLD) {
  const got = langOf(t);
  ok(got === want, `untold: ${why}`, `${JSON.stringify(t)} -> ${got}`);
}
ok(langDetail('😀').reason === 'no-letters' && langDetail('ok').reason === 'too-short' && langDetail('haha').reason === 'unsure-latin', 'langDetail gives a reason for every untold case');
ok(['en', 'vi', 'ja', 'zh', 'es', 'fr', 'pt'].every((l) => LANG_TABLE[l]), 'the table covers en vi ja zh es fr pt');
ok(LANG_TABLE.en.voice === 'own' && LANG_TABLE.vi.voice === 'own' && LANG_TABLE.ja.voice === 'off' && LANG_TABLE.es.voice === 'english-voice', 'table says which voice route each language has today');

// 5. the policy line
console.log('\nLanguage table (code: name, voice route today)');
for (const [code, d] of Object.entries(LANG_TABLE)) console.log(`  ${code}: ${d.name}, ${d.voice}`);
console.log('\nWhat happens when the language cannot be told:');
console.log(`  ${WHEN_UNTOLD}`);
console.log(`  null    = ${['😀', 'ok', ''].map((t) => `${JSON.stringify(t)} (${langDetail(t).reason})`).join(', ')}`);
console.log(`  'latin' = ${['haha', 'no no no'].map((t) => `${JSON.stringify(t)} (${langDetail(t).reason})`).join(', ')}`);
ok(/null or 'latin'/.test(WHEN_UNTOLD) && /continues/.test(WHEN_UNTOLD), 'WHEN_UNTOLD states the untold behaviour');

console.log(`\ncheck:lang-of ${fail === 0 ? 'PASS' : 'FAIL'} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
