'use strict';
// quick.speech text (T-31 0.2.3 B1 item 3): the board voice notice ("quick speech") must never read a board ask's
// raw text -- that line arrives truncated and often mangled (anh). Instead it speaks the
// task title plus the ask's step label, both short and human, through a whitelist sanitiser so that no markup, url,
// file path, code span or emoji can ever reach the voice. Pure and dependency-free, so scripts/check-speech-text.mjs
// tests it under plain Node and hud-feed.mjs attaches the result to each ask item.

const { spokenPauses } = require('./speech-chunker.js'); // the one rule for "..." (fixed lines and model replies)

// Dropped before the character whitelist. Order matters: whole url / path / bracket tokens first, then stray markup.
const URL_RE = /\b(?:https?:\/\/|www\.|file:\/\/)\S+/gi;
const IMG_RE = /!\[[^\]]*\]\([^)]*\)/g;
const LINK_RE = /\[([^\]]*)\]\([^)]*\)/g;
const WINPATH_RE = /[A-Za-z]:\\[^\s]*/g;
const UNCPATH_RE = /\\{2}[^\s]+/g;
const CODE_RE = /`[^`]*`/g;
const BRACKET_RE = /<[^>]{0,200}>|\[[^\]]{0,200}\]/g;
const MARKUP_RE = /[*_~#>|]/g;
// Task codes are never spoken (T-31 talk-mode, plan F5): the board hands back ids such as T-31, F-04 and C52-x, and
// today's quickSpeechText falls back to one when a title is missing. Strip them before the character whitelist so no
// code can survive as speech. The shape is uppercase letters, optional digits, a hyphen, then digits (with an optional
// letter) or one letter; "X-ray" is deliberately left alone because its suffix is a word, not a code.
const TASK_CODE_RE = /\b[A-Z]{1,3}\d{0,3}-(?:\d{1,3}[A-Za-z]?|[A-Za-z])\b/g;
// Whitelist: letters (any script, incl. Vietnamese diacritics), digits, spaces, and a small, safe punctuation set.
// Deliberately no ':' '/' '\' or backtick, so a leftover url, host:port or path can never survive as speakable text.
const DISALLOWED = /[^\p{L}\p{N}\s.,;!?'’()«»\-–—%]/gu;

/** Text -> a short, speakable, whitelist-sanitised line. Never empty-markup, never a url/path. */
function sanitizeSpeech(text, maxLen = 90) {
  let s = String(text == null ? '' : text)
    .replace(IMG_RE, ' ')
    .replace(LINK_RE, '$1')
    .replace(URL_RE, ' ')
    .replace(WINPATH_RE, ' ')
    .replace(UNCPATH_RE, ' ')
    .replace(CODE_RE, ' ')
    .replace(BRACKET_RE, ' ')
    .replace(MARKUP_RE, ' ')
    .replace(TASK_CODE_RE, ' ')
    .replace(DISALLOWED, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  s = spokenPauses(s).trim();
  if (s.length > maxLen) s = s.slice(0, maxLen).replace(/\s+\S*$/, '').trim();
  return s;
}

/** The step label of `stepId` on a board task ({steps:[{id,label}]}); '' when absent. Handles a bare id ('hud') and
 *  a nested one ('T-31/hud'), the two forms the board can hand back. */
function stepLabelOf(task, stepId) {
  const id = String(stepId == null ? '' : stepId);
  if (!task || !id || !Array.isArray(task.steps)) return '';
  const hit = task.steps.find((s) => s && (s.id === id || String(s.id) === id || String(s.id).endsWith(`/${id}`) || id.endsWith(`/${s.id}`)));
  return hit && hit.label != null ? String(hit.label) : '';
}

/** The spoken line for an ask/update: the task title plus the (human) step label, sanitised. Falls back to whichever
 *  part is present. -> string ('' when there is nothing safe to say). */
function quickSpeechText({ title, step } = {}, { maxLen = 90 } = {}) {
  const t = sanitizeSpeech(title, maxLen);
  const s = sanitizeSpeech(step, Math.min(maxLen, 60));
  if (t && s && t !== s) return sanitizeSpeech(`${t} — ${s}`, maxLen);
  return t || s;
}

module.exports = { sanitizeSpeech, quickSpeechText, stepLabelOf };
