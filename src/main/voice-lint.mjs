// Tone lint core (T-31-YOKI step 2.1, plan M1): "does this sound like a machine, and did she repeat herself?"
// Pure: no file, network, clock or model. Phrase data is voice-lint-phrases.json (ours); language comes from voice-lang.mjs.
// Plugs (sidecar handler, voiceNote, owner card) are later steps and are NOT wired here.
//
// Input rows: [{ user?: string, reply: string }] in time order. `user` is only needed for the wrong-language check.
// Every threshold in DEFAULTS is PROVISIONAL: none has fired on real replies yet. Step 2.2 (baseline replay) fixes them
// and writes them to the dossier; do not tune them before that.
import { createRequire } from 'node:module';
import { langOf, STOPWORDS } from './voice-lang.mjs';

const PHRASES = createRequire(import.meta.url)('./voice-lint-phrases.json');

export const DEFAULTS = Object.freeze({
  recent: 3,        // a reply is compared with the last 3 replies
  runWords: 5,      // a shared run of 5 words (8 characters for scripts without spaces) counts as a repeat
  runChars: 8,
  endWords: 3,      // same last 3 words (4 characters)
  endChars: 4,
  wornWindow: 10,   // a content word in 3 of the last 10 replies is "worn" (reported, no flag until 2.2)
  wornMin: 3,
  wornLetters: 5,   // content words are 5+ letters, not in any language's list words
  minRows: 10,      // length spread needs 10 replies to mean anything
  flatCv: 0.15,     // stdev/mean of reply length (characters) under this is "flat"
});

// Same tag set the chat path strips (chat-brain.js KNOWN_TAG); a copy so this module stays pure and standalone.
const TAGS = /\[\s*(?:greet|agree|disagree|point-screen|think|celebrate|explain|joy|sad|surprised|angry|neutral)\s*\]/gi;
const NO_SPACE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;
const HAN = /\p{Script=Han}/u;

const clean = (text) => String(text ?? '').replace(TAGS, ' ').normalize('NFC').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
const wordsOf = (text) => clean(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
const charsOf = (text) => [...clean(text).toLowerCase()].filter((c) => /[\p{L}\p{N}]/u.test(c));
// A tail made only of kana is grammar (ください, ございます), not a habit; Han, Thai and Latin tails still count.
const KANA_ONLY = /^[\p{Script=Hiragana}\p{Script=Katakana}ー]+$/u;
const unitsOf = (text) => (NO_SPACE.test(clean(text)) ? { kind: 'char', list: charsOf(text) } : { kind: 'word', list: wordsOf(text) });

/** First 2 words, or 2 (Han) / 3 (kana, Thai) characters for scripts without spaces, after gesture/emotion tags and leading marks. */
export function openerOf(text) {
  const s = clean(text).replace(/^[^\p{L}\p{N}]+/u, '').toLowerCase();
  const first = s[0];
  if (!first) return '';
  // Stop at the first mark: "はい、わかりました" and "はい、そうです" both open with "はい".
  if (NO_SPACE.test(first)) return charsOf(s.split(/[^\p{L}\p{N}]/u)[0]).slice(0, HAN.test(first) ? 2 : 3).join('');
  return (s.match(/[\p{L}\p{N}]+/gu) || []).slice(0, 2).join(' ');
}

const hasRun = (a, b, n) => {
  if (a.length < n || b.length < n) return false;
  const grams = new Set();
  for (let i = 0; i + n <= a.length; i++) grams.add(a.slice(i, i + n).join('\u0001'));
  for (let i = 0; i + n <= b.length; i++) if (grams.has(b.slice(i, i + n).join('\u0001'))) return true;
  return false;
};

/** Does `text` repeat one of the `recent` replies (caller passes the last few)? Same opener, same ending, or a shared run. */
export function repeatOf(text, recent, opt = {}) {
  const o = { ...DEFAULTS, ...opt };
  const opener = openerOf(text);
  const mine = unitsOf(text);
  const out = { opener: false, ending: false, run: false };
  for (const prev of recent.slice(-o.recent)) {
    if (opener && opener === openerOf(prev)) out.opener = true;
    const theirs = unitsOf(prev);
    if (mine.kind !== theirs.kind) continue;
    const endN = mine.kind === 'char' ? o.endChars : o.endWords;
    const runN = mine.kind === 'char' ? o.runChars : o.runWords;
    const tail = mine.list.slice(-endN);
    if (mine.list.length >= endN && theirs.list.length >= endN && tail.join('\u0001') === theirs.list.slice(-endN).join('\u0001') && !(mine.kind === 'char' && KANA_ONLY.test(tail.join('')))) out.ending = true;
    if (hasRun(mine.list, theirs.list, runN)) out.run = true;
  }
  return out;
}

/** Content words that sit in `wornMin` or more of any `wornWindow` consecutive replies. Space-separated scripts only. */
export function wornWords(lines, opt = {}) {
  const o = { ...DEFAULTS, ...opt };
  const sets = lines.map((l) => new Set(wordsOf(l).filter((w) => [...w].length >= o.wornLetters && !STOPWORDS.has(w) && !/\p{N}/u.test(w) && !NO_SPACE.test(w))));
  const found = new Map();
  for (let start = 0; start === 0 || start + o.wornWindow <= sets.length; start++) {
    const rows = new Map();
    sets.slice(start, start + o.wornWindow).forEach((set, k) => { for (const w of set) rows.set(w, [...(rows.get(w) || []), start + k]); });
    for (const [w, idx] of rows) if (idx.length >= o.wornMin) found.set(w, [...new Set([...(found.get(w) || []), ...idx])].sort((a, b) => a - b));
  }
  return [...found].map(([word, rowsOfWord]) => ({ word, rows: rowsOfWord })).sort((a, b) => b.rows.length - a.rows.length || a.word.localeCompare(b.word));
}

// ---- phrase hits ----
const LATIN = /\p{Script=Latin}/u;
const compiled = [];
for (const kind of ['helpDesk', 'sermon', 'disclaimer']) {
  for (const [lang, list] of Object.entries(PHRASES[kind])) {
    for (const phrase of list) {
      const p = phrase.normalize('NFC').toLowerCase();
      const body = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
      const pre = LATIN.test(p[0]) ? '(?<!\\p{Script=Latin})' : '';
      const post = LATIN.test(p[p.length - 1]) ? '(?!\\p{Script=Latin})' : '';
      compiled.push({ kind, lang, phrase, re: new RegExp(pre + body + post, 'u') });
    }
  }
}
/** Help-desk, sermon and disclaimer phrases found in one reply: [{kind, lang, phrase}]. */
export function phraseHits(text) {
  const s = clean(text).toLowerCase();
  return compiled.filter((c) => c.re.test(s)).map(({ kind, lang, phrase }) => ({ kind, lang, phrase }));
}

const ADDRESS = (() => {
  const all = Object.entries(PHRASES.addressWords).filter(([k]) => !k.startsWith('_')).flatMap(([, v]) => v);
  return { words: new Set(all.filter((w) => !NO_SPACE.test(w))), han: all.filter((w) => NO_SPACE.test(w)) };
})();
const opensWithAddress = (text) => {
  const op = openerOf(text);
  return ADDRESS.words.has(op.split(' ')[0]) || ADDRESS.han.some((w) => op.startsWith(w));
};
const SURE = (l) => l !== null && l !== 'latin';

/**
 * @param {{user?: string, reply: string}[]} rows
 * @returns {{n: number, repeats: object[], topOpeners: object[], wornWords: object[], phraseHits: object[], wrongLang: object[],
 *   addressShare: number, questionShare: number, length: object, flags: {code: string, count: number, rows?: number[]}[]}}
 */
export function lint(rows, opt = {}) {
  const o = { ...DEFAULTS, ...opt };
  const replies = rows.map((r) => String(r.reply ?? ''));
  const n = replies.length;

  const repeats = [];
  replies.forEach((text, i) => {
    const r = repeatOf(text, replies.slice(Math.max(0, i - o.recent), i), o);
    if (r.opener || r.ending || r.run) repeats.push({ row: i, ...r });
  });

  const openerCount = new Map();
  for (const t of replies) { const op = openerOf(t); if (op) openerCount.set(op, (openerCount.get(op) || 0) + 1); }
  const topOpeners = [...openerCount].map(([opener, count]) => ({ opener, count })).sort((a, b) => b.count - a.count || a.opener.localeCompare(b.opener)).slice(0, 5);

  const hits = [];
  replies.forEach((t, row) => { for (const h of phraseHits(t)) hits.push({ row, ...h }); });

  const wrongLang = [];
  rows.forEach((r, row) => {
    if (r.user == null) return;
    const userLang = langOf(r.user), replyLang = langOf(r.reply);
    if (SURE(userLang) && SURE(replyLang) && userLang !== replyLang) wrongLang.push({ row, userLang, replyLang });
  });

  const lens = replies.map((t) => [...clean(t)].length);
  const mean = n ? lens.reduce((a, b) => a + b, 0) / n : 0;
  const sd = n ? Math.sqrt(lens.reduce((a, b) => a + (b - mean) ** 2, 0) / n) : 0;
  const cv = mean ? sd / mean : 0;
  const length = { min: n ? Math.min(...lens) : 0, max: n ? Math.max(...lens) : 0, mean: +mean.toFixed(1), cv: +cv.toFixed(3), enough: n >= o.minRows, flat: n >= o.minRows && cv < o.flatCv };

  const share = (pred) => (n ? +(replies.filter(pred).length / n).toFixed(3) : 0);
  const rowsOf = (list) => list.map((x) => x.row);
  const flags = [];
  const push = (code, list) => { if (list.length) flags.push({ code, count: list.length, rows: rowsOf(list) }); };
  push('repeated-opener', repeats.filter((r) => r.opener));
  push('repeated-ending', repeats.filter((r) => r.ending));
  push('repeated-run', repeats.filter((r) => r.run));
  for (const kind of ['helpDesk', 'sermon', 'disclaimer']) push(kind, hits.filter((h) => h.kind === kind));
  push('wrong-language', wrongLang);
  if (length.flat) flags.push({ code: 'flat-length', count: 1 });

  return {
    n, repeats, topOpeners, wornWords: wornWords(replies, o), phraseHits: hits, wrongLang,
    addressShare: share(opensWithAddress), questionShare: share((t) => /[?？]["')\]\s]*$/.test(clean(t))),
    length, flags,
  };
}
