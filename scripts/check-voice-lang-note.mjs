// check:voice-lang-note (T-31-YOKI step 3.2, plan M3): the per-message language note and the auto base sentence. Pure, no network, no model.
// The EXACT prompt strings under test are listed, with file:line, in the CoS gate note PROMPT-TEXT-3.2-FOR-COS.md (YOKI learn lane, outside this repo).
//   1. the plan's table, row by row (langNoteOf): a sure script names its language; untold Latin after a reply in another language gets the
//      generic note; everything else says nothing;
//   2. the carrier: voiceNoteOf adds it only on langAuto, leads the note, shares one bracket with the anti-repeat note, and stays under 300 characters;
//   3. the base sentence in soulSystemPrompt: new text on auto (owner and public), a fixed language unchanged, the old "English by default" gone.
import { createRequire } from 'node:module';
import { langOf, langNoteOf, LANG_NOTE_SCRIPT, LANG_NOTE_GENERIC, LANG_TABLE } from '../src/main/voice-lang.mjs';
import { voiceNoteOf } from '../src/main/voice-note.mjs';

const require = createRequire(import.meta.url);
const { soulSystemPrompt, LANG_AUTO, LANG_AUTO_PUBLIC, DEFAULT_SOUL, validateSoul } = require('../src/main/soul-prefs.js');
let pass = 0, fail = 0;
const ok = (c, name, detail = '') => { if (c) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); } };

const SAMPLE = {
  ja: 'こんにちは、今日の天気を教えてください。', zh: '你好，请告诉我今天的天气怎么样。', ko: '안녕하세요, 오늘 날씨가 어때요?',
  ru: 'Привет, какая сегодня погода?', th: 'สวัสดีครับ วันนี้อากาศเป็นอย่างไร', ar: 'مرحبا، كيف حال الطقس اليوم؟', hi: 'नमस्ते, आज मौसम कैसा है?',
};
const NAMES = { ja: 'Japanese', zh: 'Chinese', ko: 'Korean', ru: 'Russian', th: 'Thai', ar: 'Arabic', hi: 'Hindi' };

// 1. the table
for (const [code, text] of Object.entries(SAMPLE)) {
  ok(langOf(text) === code, `fixture ${code}: langOf says ${code}`, String(langOf(text)));
  ok(langNoteOf(text, undefined) === `The user's message is in ${NAMES[code]}. Reply only in ${NAMES[code]}.`, `${code}: the note names ${NAMES[code]} twice`, langNoteOf(text, undefined));
  ok(langNoteOf(text, 'Sure, here you go.') === langNoteOf(text, undefined) && langNoteOf(text, 'はい') === langNoteOf(text, undefined), `${code}: a sure script gets the same note whatever the last reply was`);
}
ok(LANG_NOTE_SCRIPT('Japanese') === "The user's message is in Japanese. Reply only in Japanese." && LANG_NOTE_GENERIC === 'Reply in the language of this message.', 'the two note texts are exactly the plan table text');
ok(Object.keys(SAMPLE).every((c) => LANG_TABLE[c] && LANG_TABLE[c].script === 'own' && LANG_TABLE[c].name === NAMES[c]), 'the names come from the language table');
const UNTOLD = 'Zebra quokka lumo vexa';
ok(langOf(UNTOLD) === 'latin', 'fixture: the untold Latin text is "latin" to langOf');
ok(langNoteOf(UNTOLD, SAMPLE.ja) === LANG_NOTE_GENERIC, 'latin after a Japanese reply: the generic note');
ok(langNoteOf(UNTOLD, 'Được rồi anh, em mở giúp anh ngay đây.') === LANG_NOTE_GENERIC, 'latin after a Vietnamese reply: the generic note');
ok(langNoteOf(UNTOLD, 'Sure, I can open that for you right now.') === '', 'latin after an English reply: nothing');
ok(langNoteOf(UNTOLD, undefined) === '' && langNoteOf(UNTOLD, null) === '', 'latin with no earlier reply: nothing');
ok(langNoteOf(UNTOLD, '👍') === '' && langNoteOf(UNTOLD, 'ok') === '', 'latin after a reply langOf cannot tell: nothing');
ok(langNoteOf('Thanks a lot, that is great', SAMPLE.ja) === '', 'a message told English by its words: nothing (the base sentence carries it)');
ok(langNoteOf('Cảm ơn em nhiều lắm nhé', SAMPLE.ja) === '', 'a message told Vietnamese by its letters: nothing');
ok(langNoteOf('Claro, puedo abrirlo para ti ahora mismo, también si quieres.', SAMPLE.ja) === '', 'a message told Spanish: nothing');
ok(langNoteOf('👍👍', SAMPLE.ja) === '' && langNoteOf('12345', SAMPLE.ja) === '' && langNoteOf('', SAMPLE.ja) === '' && langNoteOf(undefined, SAMPLE.ja) === '', 'emoji only, digits, empty, undefined: nothing');
ok(langNoteOf('```js\nconst a = 1;\n```', SAMPLE.ja) === '' && langNoteOf('https://example.com/a/b?c=d', SAMPLE.ja) === '', 'a fenced code block only, a link only: nothing');
ok(langNoteOf('const x = 42; // https://example.com', SAMPLE.ja) === LANG_NOTE_GENERIC && langNoteOf('const x = 42; // https://example.com', 'Sure.') === '', 'unfenced inline code is "latin" to langOf: it follows the latin row (generic note only after a reply in another language)');
ok(langNoteOf('了解', SAMPLE.ja) === '', 'a Han word common to Chinese and Japanese cannot be told: nothing');

// 2. the carrier
const note = (recent, msg, auto) => voiceNoteOf(recent, msg, { langAuto: auto });
ok(note([], SAMPLE.ja, true) === "[Note from the app, not from the user: the user's message is in Japanese. Reply only in Japanese.]", 'first turn, Japanese, auto: the note alone (no earlier replies needed)');
ok(note(['Sure, here you go.'], SAMPLE.ja, true) === note([], SAMPLE.ja, true), 'an earlier English reply changes nothing for a Japanese message');
ok(note([], SAMPLE.ja, false) === '' && voiceNoteOf([], SAMPLE.ja) === '' && voiceNoteOf(['x'], SAMPLE.ja, {}) === '', 'not auto (or no option): no language note');
ok(note([], 'Hello there, how are you?', true) === '', 'auto, English, nothing worn: empty, so the prompt stays byte-identical');
ok(note([SAMPLE.ja], UNTOLD, true) === '[Note from the app, not from the user: reply in the language of this message.]', 'the generic note, in the carrier');
{
  const both = note(['Dạ anh, em mở bảng rồi.', 'Dạ anh, bước hai xong nhé.'], SAMPLE.ja, true);
  ok(both.startsWith("[Note from the app, not from the user: the user's message is in Japanese. Reply only in Japanese. Your last replies opened with \"dạ anh\"") && both.split('[Note from the app').length === 2 && both.endsWith(']'), 'with a repeated opener: ONE note, the language sentence first', both);
  ok(both.length <= 300, 'under the 300-character cap', String(both.length));
  const worst = note(['Dạ anh, thật abcdefghijklmnopqrst luôn.', 'Dạ anh, abcdefghijklmnopqrst quá chừng.', 'Em thấy abcdefghijklmnopqrst thật.', 'Dạ anh, zyxwvutsrqponmlkjihg đó.'], SAMPLE.ar, true);
  ok(worst.length <= 300 && worst.endsWith(']'), 'worst case (longest allowed words, two clauses and the language sentence) stays under 300 and keeps its closing bracket', String(worst.length));
  ok(!note(['Dạ anh, thật supercalifragilisticexpialidocious luôn.', 'Dạ anh, supercalifragilisticexpialidocious quá.', 'Em thấy supercalifragilisticexpialidocious thật.'], 'hello there friend', true).includes('supercali'), 'a word longer than 20 letters is never quoted');
}

// 3. the base sentence
{
  const owner = soulSystemPrompt(null);
  const pub = soulSystemPrompt(null, { publicBuild: true });
  ok(owner.includes(LANG_AUTO) && !owner.includes('English by default') && !owner.includes('same language'), 'owner prompt: the new auto sentence, the old one gone');
  ok(pub.includes(LANG_AUTO_PUBLIC) && !pub.includes('English by default') && !pub.includes('same language'), 'public prompt: the new auto sentence, the old one gone');
  ok(LANG_AUTO === "Reply in the language of your owner's latest message; when it is too short to tell, keep the language you were just using." && LANG_AUTO_PUBLIC === "Reply in the language of the user's latest message; when it is too short to tell, keep the language you were just using.", 'the two sentences are exactly the pinned text');
  const fixedVi = soulSystemPrompt(validateSoul({ replyLang: 'vi' }, DEFAULT_SOUL).soul);
  ok(fixedVi.includes('Always reply in Vietnamese.') && !fixedVi.includes(LANG_AUTO) && !fixedVi.includes('latest message'), 'a fixed language keeps its own sentence and carries no auto sentence');
  ok(owner.split(LANG_AUTO).length === 2, 'the auto sentence appears once');
}

console.log(`\ncheck:voice-lang-note ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
