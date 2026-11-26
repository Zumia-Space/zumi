// voiceNote (T-31-YOKI step 2.3, plan M2): the anti-repeat hint. Pure: no file, network, clock or model.
// voiceNoteOf(recent, message) -> '' (nothing worn: the caller adds nothing, the prompt stays byte-identical) or one short note
// for the host to hand to chat-brain, which appends it to the last user message.
// Triggers (plan M2): an opener used in 2 of the last 3 replies, or a content word in 3 of the last 10 replies that the user did not
// just say. Both come from voice-lint.mjs (openerOf, wornWords) so the lint card and the live hint agree. Thresholds stay at the
// lint's provisional values until step 2.2 fixes them from real replies; none is tuned here.
import { openerOf, wornWords } from './voice-lint.mjs';
import { langNoteOf } from './voice-lang.mjs';

export const VOICE_NOTE_RING = 20;       // final replies kept in RAM by the host
const OPENER_WINDOW = 3;                  // an opener in 2 of the last 3 replies is a habit
const OPENER_MIN = 2;
const WORN_WINDOW = 10;                   // wornWords' own window and minimum (3 of 10), applied to the last 10 replies
const WORN_SHOWN = 2;                     // at most two worn words are named
const HEAD = '[Note from the app, not from the user: ';
const QUOTE_MAX_LETTERS = 20;             // a longer word is never quoted: the note must stay far under the host's 300-character cap
const quotable = (w) => [...w].length <= QUOTE_MAX_LETTERS;

const lowerFirst = (s) => (s ? s[0].toLowerCase() + s.slice(1) : s);
const wordsOfMessage = (s) => new Set((String(s ?? '').normalize('NFC').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []));

/**
 * @param {string[]} recent final replies, oldest first  @param {string} message the user's message of this turn
 * @param {{ langAuto?: boolean }} [opt] langAuto: the soul's replyLang is `auto`, so the per-message language note (voice-lang.mjs) may lead
 */
export function voiceNoteOf(recent, message, opt = {}) {
  const langNote = opt && opt.langAuto === true ? langNoteOf(message, Array.isArray(recent) && recent.length ? recent[recent.length - 1] : undefined) : '';
  if (!Array.isArray(recent) || !recent.length) return langNote ? `${HEAD}${lowerFirst(langNote)}]` : '';
  const replies = recent.slice(-VOICE_NOTE_RING).map((r) => String(r ?? ''));
  const parts = [];

  const counts = new Map();
  for (const r of replies.slice(-OPENER_WINDOW)) {
    const op = openerOf(r);
    if (op) counts.set(op, (counts.get(op) || 0) + 1);
  }
  const opener = [...counts].find(([w, n]) => n >= OPENER_MIN && w.split(' ').every(quotable));

  const said = wordsOfMessage(message);
  const worn = wornWords(replies.slice(-WORN_WINDOW)).map((w) => w.word).filter((w) => !said.has(w) && quotable(w)).slice(0, WORN_SHOWN);

  if (!opener && !worn.length && !langNote) return '';
  // Only letters and digits ever reach the quotes (openerOf and wornWords keep those), so a reply cannot inject a bracket or a quote.
  // Sentences are written as sentences; the whole body starts in lower case after the head's colon, as in the plan's example.
  if (langNote) parts.push(langNote);
  if (opener) parts.push(`Your last replies opened with "${opener[0]}". Open differently this time.`);
  if (worn.length) parts.push(`You have leaned on ${worn.map((w) => `"${w}"`).join(' and ')}; avoid ${worn.length > 1 ? 'them' : 'it'} unless the user asks.`);
  return `${HEAD}${lowerFirst(parts.join(' '))}]`;
}
