// check:voice-lint (T-31-YOKI step 2.1). Plain Node, no network, no model call, no app.
//   1. bad-20.jsonl reports exactly the seeded defects: 4 repeated openers, 3 help-desk phrases, 2 wrong-language replies,
//      flat length, and nothing else;
//   2. good-20.jsonl reports 0 flags (the negative control);
//   3. the detector bites: one defect injected into good-20 gives exactly that one flag, one defect removed from bad-20 drops it;
//   4. unit rows: opener (tags, punctuation, Chinese, Japanese), repeatOf (opener / ending / run), phrase edges, length needs 10 rows.
// Thresholds are provisional until step 2.2 (baseline replay); this check does not tune them.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lint, openerOf, repeatOf, phraseHits, DEFAULTS } from '../src/main/voice-lint.mjs';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'voice-lint');
const load = (f) => fs.readFileSync(path.join(DIR, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); } };
const counts = (res) => Object.fromEntries(res.flags.map((f) => [f.code, f.count]));
const same = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
const show = (label, res) => {
  console.log(`\n${label}: ${res.n} rows, flags ${JSON.stringify(counts(res))}`);
  console.log(`  repeated rows ${JSON.stringify(res.repeats.map((r) => r.row))}, top opener ${JSON.stringify(res.topOpeners[0])}`);
  console.log(`  phrase hits ${JSON.stringify(res.phraseHits.map((h) => `${h.row}:${h.kind}:${h.phrase}`))}`);
  console.log(`  wrong language ${JSON.stringify(res.wrongLang)}`);
  console.log(`  length ${JSON.stringify(res.length)}, address share ${res.addressShare}, question share ${res.questionShare}, worn words ${res.wornWords.length}`);
};

const bad = load('bad-20.jsonl'), good = load('good-20.jsonl');
const rb = lint(bad), rg = lint(good);
show('bad-20', rb); show('good-20', rg);

// 1 + 2. the two fixtures
ok(bad.length === 20 && good.length === 20, 'both fixtures have 20 rows');
ok(same(counts(rb), { 'repeated-opener': 4, helpDesk: 3, 'wrong-language': 2, 'flat-length': 1 }), 'bad-20: exactly 4 repeated openers, 3 help-desk phrases, 2 wrong-language replies, flat length, nothing else', JSON.stringify(counts(rb)));
ok(JSON.stringify(rb.flags.find((f) => f.code === 'repeated-opener').rows) === '[3,4,5,6]' && JSON.stringify(rb.flags.find((f) => f.code === 'wrong-language').rows) === '[7,10]', 'bad-20: the flagged rows are the seeded ones');
ok(rg.flags.length === 0, 'good-20: 0 flags', JSON.stringify(rg.flags));
ok(rg.length.cv > 2 * DEFAULTS.flatCv && rb.length.cv < DEFAULTS.flatCv / 1.5, 'length spread: good-20 well above the line, bad-20 well under it', `${rg.length.cv} / ${rb.length.cv}`);

// 3. the detector bites (each mutation is one change to good-20)
const mutate = (i, patch) => good.map((r, k) => (k === i ? { ...r, ...patch } : r));
let m = lint(mutate(10, { reply: 'How can I assist you today with dinner ideas?' }));
ok(same(counts(m), { helpDesk: 1 }), 'inject a help-desk phrase -> exactly 1 helpDesk flag', JSON.stringify(counts(m)));
m = lint(mutate(5, { reply: 'Dạ anh viết nháp trước đi, em đọc giúp sau.' }).map((r, k) => (k === 6 ? { ...r, reply: 'Dạ anh cứ làm tiếp đi ạ.' } : r)));
ok(counts(m)['repeated-opener'] === 1, 'inject one repeated opener -> exactly 1 repeated-opener flag', JSON.stringify(counts(m)));
m = lint(mutate(4, { reply: 'So that is a long day, is anything missing from the report?' }));
ok(same(counts(m), { 'wrong-language': 1 }), 'swap one Vietnamese reply to English -> exactly 1 wrong-language flag', JSON.stringify(counts(m)));
m = lint(good.map((r) => ({ ...r, reply: 'x'.repeat(40) + ' ' + 'y'.repeat(10) })));
ok(counts(m)['flat-length'] === 1, 'give every reply the same length -> flat-length flag');
m = lint(mutate(2, { reply: 'As an AI, I want you to know that life is a journey.' }));
ok(counts(m).disclaimer === 1 && counts(m).sermon === 1, 'disclaimer and sermon phrases are told apart', JSON.stringify(counts(m)));
m = lint(bad.filter((_, k) => ![9, 13, 17].includes(k)));
ok(!counts(m).helpDesk, 'remove the 3 help-desk rows from bad-20 -> helpDesk flag gone', JSON.stringify(counts(m)));

// 4. unit rows
ok(openerOf('[joy] [greet] Dạ anh, em đây') === 'dạ anh', 'openerOf strips gesture and emotion tags and punctuation', openerOf('[joy] [greet] Dạ anh, em đây'));
ok(openerOf('...  Well, hello there') === 'well hello', 'openerOf takes 2 words');
ok(openerOf('好的，我来帮你看看') === '好的', 'openerOf takes 2 characters for Chinese');
ok(openerOf('ありがとう！助かりました') === 'ありが', 'openerOf takes 3 characters for Japanese');
ok(openerOf('[unknown] kept as written') === 'unknown kept', 'an unknown bracket is not a tag (same rule as the chat path)');
ok(openerOf('') === '' && openerOf('😀') === '', 'openerOf of nothing is empty');
let r = repeatOf('Sure thing, here you go', ['Sure thing, I will check']);
ok(r.opener && !r.ending && !r.run, 'repeatOf: same opener only');
r = repeatOf('Oh nice one, that works for me today', ['Right then, that works for me today']);
ok(!r.opener && r.ending && r.run, 'repeatOf: same ending and a shared 5-word run');
r = repeatOf('Totally different words here', ['Nothing in common at all, honestly']);
ok(!r.opener && !r.ending && !r.run, 'repeatOf: nothing shared');
r = repeatOf('Sure thing again', ['a', 'b', 'c', 'Sure thing, first time']);
ok(r.opener, 'repeatOf: the newest of the recent replies is compared');
r = repeatOf('Sure thing again', ['Sure thing, first time', 'a', 'b', 'c']);
ok(!r.opener, 'repeatOf: a reply older than the last 3 is not compared');
r = repeatOf('谢谢，我明天下午再来看看你', ['好的，我明天下午再来看看吧']);
ok(!r.opener && r.run, 'repeatOf: Chinese uses an 8-character run', JSON.stringify(r));
ok(phraseHits('Is there anything else I can help you with?').length === 1, 'phrase: matches across a longer sentence');
ok(phraseHits('Wonderful question, no cheese here').length === 0 && phraseHits('Great questions deserve time').length === 0, 'phrase: whole words only ("great questions" is not "great question")');
ok(phraseHits('我是个助手。作为一个AI助手，我不能这样做').some((h) => h.kind === 'disclaimer' && h.lang === 'zh'), 'phrase: Chinese phrase inside Chinese text');
ok(lint(bad.slice(0, 5)).length.flat === false && lint(bad.slice(0, 5)).length.enough === false, 'length spread needs 10 replies (5 rows -> not enough, not flat)');
ok(lint([]).n === 0 && lint([]).flags.length === 0, 'lint of no rows is empty, not an error');

// 5. review 21-11: correct replies must not be flagged wrong-language (collision words, names, untold), plus the nits
const wl = (user, reply) => lint([{ user, reply }]).wrongLang.length;
ok(wl('thanks', 'As soon as possible, sure.') === 0, 'collision: "As soon as possible" is not another language');
ok(wl('AI', 'Yes, I can do that for you.') === 0, 'collision: user "AI" is untold, no flag');
ok(wl('Hôm nay mình hơi mệt', 'em an com chua?') === 0, 'collision: unaccented Vietnamese reply is not Portuguese');
ok(wl('Tell Đức and Phương I said hi', 'Sure, I will tell them.') === 0, 'names: English with Vietnamese names, English reply');
ok(wl('Meeting with Đức at Quận 1', 'Sounds good, see you there.') === 0, 'names: second name case');
ok(wl('ありがとう', '了解！') === 0, 'untold: Han-only reply to a Japanese message');
ok(wl('Same as before', 'Sure, same as before.') === 0, 'collision: shared words, both English');
ok(wl('pro tip', 'Ha, nice one, thanks.') === 0, 'collision: "pro tip" untold');
ok(wl('Em oi', 'Dạ, em đây ạ.') === 0, 'collision: "em oi" is Vietnamese, same as the reply');
ok(wl('Chó con', 'Dễ thương quá.') === 0, 'collision: "Chó con" is untold');
ok(wl('Cảm ơn nhiều', 'You are welcome, anytime.') === 1, 'still bites: Vietnamese message, English reply');
ok(wl('Tell Đức and Phương I said hi', 'Vâng, em sẽ nói với họ ạ.') === 1, 'still bites: English message with names, Vietnamese reply');
ok(wl('Hello there', 'Bonjour, merci beaucoup pour tout') === 1, 'still bites: English message, French reply');
ok(wl('Gracias, as always', 'You are welcome, anytime.') === 0, 'one Spanish word against one English word is unsure, no flag');
ok(openerOf('はい、わかりました') === 'はい' && repeatOf('はい、わかりました', ['はい、そうです']).opener, 'nit: Japanese "はい、" opener is caught');
ok(!repeatOf('ここで少し待ってください', ['この本を読んでください']).ending && !repeatOf('ご連絡ありがとうございます', ['おはようございます']).ending, 'nit: kana-only grammar tails (ください, ございます) are not a repeated ending');
ok(repeatOf('请稍等一下好吗你知道的', ['我们再说一下好吗你知道的']).ending, 'nit: a Han tail still counts as a repeated ending');
ok(phraseHits('我要记住这个地址').length === 0 && phraseHits('请记住你的密码').length === 0, 'nit: plain Chinese statements are no sermon');
ok(phraseHits('You should always back up your files first.').length === 0, 'nit: plain advice is no sermon');
ok(phraseHits('How can I help you today?').some((h) => h.kind === 'helpDesk'), 'nit: "How can I help you" is help-desk');
ok(phraseHits('How can I help you with the next step today?').some((h) => h.kind === 'helpDesk'), 'nit: the longer form is caught too');
ok(phraseHits('Let me know if you have any other questions!').some((h) => h.kind === 'helpDesk'), 'nit: "any other questions" is help-desk');
ok(phraseHits('Em giúp gì được cho anh ạ?').some((h) => h.kind === 'helpDesk' && h.lang === 'vi'), 'nit: Vietnamese "giúp gì được cho" is help-desk');
ok(phraseHits('Can you help me pick a movie?').length === 0, 'negative: asking for help is no help-desk line');

console.log(`\ncheck:voice-lint ${fail === 0 ? 'PASS' : 'FAIL'} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
