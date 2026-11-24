// langOf (T-31-YOKI step 3.1, plan M3): which language is this one message in? Pure, no I/O after load, no model call.
// Table and word lists: voice-lang-table.json (ours). Nothing here edits the chat path; step 3.2/3.3 plug it in later.
//
// Result of langOf(text):
//   'en' | 'vi' | 'es' | 'fr' | 'pt'   a Latin-script language, told by letters and word lists
//   'ja' | 'zh' | 'ko' | 'ru' | 'th' | 'ar' | 'hi'   told by script alone
//   'latin'   Latin script, at least 4 letters, but the language is not clear (a tie or no list word)
//   null      cannot tell: nothing but emoji / digits / code / links, or fewer than 2 Latin letters
// WHEN_UNTOLD states what the caller does with 'latin' and null. langDetail() adds the reason.
//
// Why not isVietnamese() from local-tts.js (the plan's first idea): its accent class is the whole Latin-1 block, so
// French, Spanish and Portuguese text would read as Vietnamese. Here Vietnamese is told by letters no other
// supported language uses (ă đ ơ ư and U+1EA0-1EF9), counted as a share of words so a name or two ("Hà Nội",
// "Đức and Phương") inside an English sentence does not flip it: Vietnamese wins only when its marked words outnumber
// the English list words.
//
// Evidence rule (review 21-11): es/fr/pt need a distinctive list word. Words that English or Vietnamese also use
// (as em com um pro oi os ai con son, plus every en/vi list word) count for nothing there, and accent letters alone are
// never enough. With no distinctive word the text stays 'latin' (or null when very short).
//
// Script limit: pure Han text that is a common word in both Japanese and Chinese (了解, 大丈夫 ...) cannot be told
// without kana, so it is untold (null, reason 'han-ambiguous').
import { createRequire } from 'node:module';

const TABLE = createRequire(import.meta.url)('./voice-lang-table.json');

export const LANG_TABLE = Object.freeze({
  ...Object.fromEntries(Object.entries(TABLE.latinLangs).map(([k, v]) => [k, { name: v.name, script: 'latin', voice: v.voice }])),
  ...Object.fromEntries(Object.entries(TABLE.scriptLangs).map(([k, v]) => [k, { name: v.name, script: 'own', voice: v.voice }])),
});

export const WHEN_UNTOLD = "When langOf returns null or 'latin' the language cannot be told: the caller sends no language note and the conversation language continues (the previous reply's language stands). Only a 'latin' result after a reply in another language earns the generic note 'Reply in the language of this message.'";

const VI_ONLY = /[ăđơưẠ-ỹ]/;
const VI_SHARE = 0.25; // share of words carrying a Vietnamese-only letter; provisional, no real-reply baseline yet
const NOISE = [
  /```[\s\S]*?```/g, /`[^`\n]*`/g,
  /\b(?:https?:\/\/|www\.)\S+/gi, /[\w.+-]+@[\w-]+\.[\w.-]+/g, /[@#]\w+/g,
  /[\p{Extended_Pictographic}️‍]/gu, /\p{N}/gu,
];
const SCRIPTS = [ // order only breaks ties
  ['han', /\p{Script=Han}/u], ['kana', /[\p{Script=Hiragana}\p{Script=Katakana}]/u], ['ko', /\p{Script=Hangul}/u],
  ['ru', /\p{Script=Cyrillic}/u], ['th', /\p{Script=Thai}/u], ['ar', /\p{Script=Arabic}/u], ['hi', /\p{Script=Devanagari}/u],
];

const wordLangs = new Map(); // word -> Set(lang), the words that count as evidence
const stop = new Set();      // every list word of every language, for STOPWORDS
const shared = new Set([...TABLE.latinLangs.en.words, ...TABLE.latinLangs.vi.words, ...TABLE.latinLangs.vi.wordsPlain, ...(TABLE.sharedWithEnVi || [])]);
for (const [lang, def] of Object.entries(TABLE.latinLangs)) {
  for (const w of [...def.words, ...(def.wordsPlain || [])]) {
    stop.add(w);
    if ((lang === 'en' || lang === 'vi' || !shared.has(w)) && !(def.skipWords || []).includes(w)) {
      if (!wordLangs.has(w)) wordLangs.set(w, new Set());
      wordLangs.get(w).add(lang);
    }
  }
}
/** Every list word of every Latin language (lower case): the words a "worn word" check must skip. */
export const STOPWORDS = stop;
const AMBIGUOUS_HAN = new Set(TABLE.ambiguousHan || []);
const LATIN_CODES = Object.keys(TABLE.latinLangs);

/** @param {unknown} text @returns {{lang: string|null, reason: string}} */
export function langDetail(text) {
  let s = String(text ?? '').normalize('NFC');
  for (const re of NOISE) s = s.replace(re, ' ');
  const count = Object.fromEntries(SCRIPTS.map(([k]) => [k, 0]));
  let latin = 0;
  for (const ch of s) {
    if (!/\p{L}/u.test(ch)) continue;
    const hit = SCRIPTS.find(([, re]) => re.test(ch));
    if (hit) count[hit[0]]++; else if (/\p{Script=Latin}/u.test(ch)) latin++;
  }
  if (!count.kana && AMBIGUOUS_HAN.has(s.replace(/[^\p{Script=Han}]/gu, '')) && !/\p{Script=Latin}/u.test(s)) return { lang: null, reason: 'han-ambiguous' };
  // Japanese text mixes kana and kanji; Chinese has no kana.
  const groups = { ja: count.kana ? count.kana + count.han : 0, zh: count.kana ? 0 : count.han, ko: count.ko, ru: count.ru, th: count.th, ar: count.ar, hi: count.hi };
  const [topScript, topN] = Object.entries(groups).sort((a, b) => b[1] - a[1])[0];
  // One kanji/hanzi/hangul carries about a word, a Latin letter a fraction of one: weight them x2 against Latin.
  const dense = topScript === 'ja' || topScript === 'zh' || topScript === 'ko' ? 2 : 1;
  if (topN > 0 && topN * dense >= latin) return { lang: topScript, reason: 'script' };
  if (latin < 2) return { lang: null, reason: topN + latin === 0 ? 'no-letters' : 'too-short' };

  const lower = s.toLowerCase();
  // One-letter tokens ("I", "a") say nothing, so they stay out of the share.
  const tokens = lower.split(/[^\p{L}]+/u).filter((t) => [...t].length >= 2);
  const wordScore = Object.fromEntries(LATIN_CODES.map((c) => [c, 0]));
  for (const t of tokens) for (const lang of wordLangs.get(t) || []) wordScore[lang]++;
  const marked = tokens.filter((t) => VI_ONLY.test(t)).length;
  if (tokens.length && marked / tokens.length >= VI_SHARE && marked > wordScore.en) return { lang: 'vi', reason: 'vi-letters' };

  const score = { ...wordScore };
  for (const { chars, langs, score: add } of TABLE.markers.list) {
    for (const ch of lower) if (chars.includes(ch)) for (const l of langs) score[l] += add;
  }
  // A language needs at least one word of its own; accent letters only add weight to it.
  const ranked = Object.entries(score).filter(([l]) => wordScore[l] >= 1).sort((a, b) => b[1] - a[1]);
  if (ranked.length && (ranked.length === 1 || ranked[0][1] > ranked[1][1])) return { lang: ranked[0][0], reason: 'words' };
  return latin >= 4 ? { lang: 'latin', reason: 'unsure-latin' } : { lang: null, reason: 'too-short' };
}

/** @param {unknown} text @returns {string|null} */
export const langOf = (text) => langDetail(text).lang;

// ---- per-message language note (T-31-YOKI step 3.2, plan M3 table) ----
// Sent only while the soul's replyLang is `auto` (the host decides). It rides in the voiceNote carrier (voice-note.mjs), so a turn
// with nothing to say adds nothing. One row per case of the plan's table:
//   a sure script (ja zh ko ru th ar hi)                       -> LANG_NOTE_SCRIPT(name)
//   'latin' and the previous reply was in a told language other than English -> LANG_NOTE_GENERIC
//   'latin' otherwise, null, or a Latin language told by its words (en vi es fr pt) -> nothing (the base sentence carries the turn)
export const LANG_NOTE_SCRIPT = (name) => `The user's message is in ${name}. Reply only in ${name}.`;
export const LANG_NOTE_GENERIC = 'Reply in the language of this message.';

/** @param {unknown} message the user's message  @param {unknown} previousReply the last final reply, or undefined  @returns {string} '' or one note sentence */
export function langNoteOf(message, previousReply) {
  const told = langOf(message);
  if (told && LANG_TABLE[told] && LANG_TABLE[told].script === 'own') return LANG_NOTE_SCRIPT(LANG_TABLE[told].name);
  if (told !== 'latin' || previousReply === undefined || previousReply === null) return '';
  const before = langOf(previousReply);
  return before && before !== 'latin' && before !== 'en' && LANG_TABLE[before] ? LANG_NOTE_GENERIC : '';
}
