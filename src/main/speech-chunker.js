'use strict';
// Incremental twin of kokoro-worker.mjs's chunkText() (T-31 voice round 6): text arrives as LLM stream deltas, and
// Kokoro must start on the first clause instead of waiting for the whole reply. Same limits as the worker: chunk 0
// at most FIRST_MAX chars (a short lead-in clause bounds the first synth time), later chunks at most MAX chars, cut
// at a clause boundary (punctuation + whitespace) or else at the last space inside the limit.
// Invariant (tested): a chunk is emitted only once the text seen so far fully decides it, so the chunks are the same
// however the text is split into deltas (one call with the whole reply, or one character at a time).
// No Electron/worker imports: chat-brain.js uses it to detect "first clause ready", kokoro-tts.js to feed the worker.
const FIRST_MAX = 24;
const MAX = 45;
const BOUNDARY = /[.!?;:,](?=\s)/g;

// ---------- the voice filter (owner 02-11; deliberately small) ----------
// A voice must not read emoji, code fences, markdown markers, bare urls or "...". It removes those and nothing else: slashes, dates, -, =, ×, ~, ≥ and % pass unchanged,
// because guessing at text deleted real content twice. Spoken wording is the model's job (soul-prefs.js SPOKEN_RULE). Pure and idempotent. Voice only: the screen never comes
// through here. <think> and images are the older exceptions: reasoning and alt text are not speech.
const EMOJI = /\p{Extended_Pictographic}|[\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}\u{20E3}\u{1F1E6}-\u{1F1FF}]/gu; // pictographs, skin tones, VS16, ZWJ, keycaps, flags
// "..." is a pause: a comma mid-sentence, a full stop at the end, nothing at the start or before other punctuation.
const spokenPauses = (text) => String(text).replace(/^[\s.…]*(?:\.{2,}|…)[\s.…]*/, '').replace(/[ \t]*(?:\.{2,}|…)[\s.…]*$/, '.').replace(/[ \t]*(?:\.{2,}|…)[.…]*[ \t]*(?=[,;:!?])/g, '').replace(/[ \t]*(?:\.{2,}|…)[.…]*[ \t]*/g, ', ');
// A star between two numbers is arithmetic, tight or spaced on both sides. Single: "×", which the voice reads as "times" (espeak measured; "*" reads "asterisk"). Double stays. Any other star is emphasis.
function starOrOperator(stars, at, text) {
  const before = text.slice(Math.max(0, at - 8), at), after = text.slice(at + stars.length, at + stars.length + 8);
  const arithmetic = stars.length <= 2 && ((/\d$/.test(before) && /^\d/.test(after)) || (/\d[ \t]+$/.test(before) && /^[ \t]+\d/.test(after)));
  return !arithmetic ? '' : stars.length === 1 ? '×' : stars;
}
function stripMarkup(text) {
  const s = String(text == null ? '' : text)
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, ' ').replace(/<think\b[^>]*>[\s\S]*$/i, ' ').replace(/<\/?think\b[^>]*>/gi, ' ')
    .replace(/```[\s\S]*?(?:```|$)/g, ' ') // a code block
    .replace(/!\[[^\]\n]*\]\([^)\n]*\)/g, ' ') // an image
    .replace(/\[([^\]\n]*)\]\([^)\n]*\)/g, '$1') // a link keeps its label
    .replace(/\b(?:https?:\/\/|file:\/\/|www\.)\S+/gi, ' ') // a bare url
    .replace(/(?<![_\w])_([^_\n]+)_(?![_\w])/g, '$1') // _emphasis_, never __dunder__ or snake_case
    .replace(/`/g, '') // inline code keeps its words
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '').replace(/^[ \t]*[-*+][ \t]+/gm, '') // heading and bullet markers; a numbered line keeps its number
    .replace(/\*+/g, starOrOperator)
    .replace(/\[\p{L}\p{Ll}{1,24}\]/gu, ' ') // an inline stage direction such as [smile]; [A] and [TODO] stay
    .replace(EMOJI, '');
  return spokenPauses(s.replace(/\s+/g, ' ')).replace(/\s+/g, ' ').trim();
}

// What a growing reply may still turn into a marker is held back, and only that. Each rule cuts the tail; they repeat because a cut can expose another.
const OPEN_TAILS = [
  /\s+$/, /[\uD800-\uDBFF]$/, /[*`!]+$/, // whitespace, half an emoji, a marker's first characters
  /[.…][.…\s\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}]*$/u, // dots that may become "..."
  /\[[^\]\n]*\]?(?:\([^)\n]*)?$/, // [label, [label] or [label](url
  /(?<![_\w])_[^_\n]*_*$/, // _emphasis not closed yet
  /\b(?:https?:\/\/|file:\/\/|www\.)\S*$/i, /\b(?:h|ht|htt|https?:?\/?|f|fi|fil|file:?\/?|w|ww|www)$/i, // a url, or the start of one
  /<\/?(?:t(?:h(?:i(?:n(?:k[^>]*)?)?)?)?)?$/i, // a <think> tag
  /(?<=^|\n)[ \t]*(?:[-+]|#{1,6})$/, // a bullet or heading marker at a line start
];
function holdOpenSpeech(text) {
  let s = String(text == null ? '' : text);
  for (let before = null; before !== s;) {
    before = s;
    if (s.split('```').length % 2 === 0) s = s.slice(0, s.lastIndexOf('```')); // inside a code block
    for (const tail of OPEN_TAILS) s = s.replace(tail, '');
  }
  return s;
}

// A growing reply -> voice chunks. feed(fullText, final) gives the chunks to speak now. Every snapshot is a prefix of the final filtered text, so no character is lost or repeated.
function createSpeechFeed(chunker) {
  let fed = 0;
  return (full, final) => {
    const clean = stripMarkup(final ? full : holdOpenSpeech(full));
    if (clean.length <= fed) return [];
    const added = clean.slice(fed);
    fed = clean.length;
    return chunker.push(added);
  };
}

function createStreamChunker({ firstMax = FIRST_MAX, max = MAX } = {}) {
  let buf = '';
  let emitted = 0;
  const limit = () => (emitted === 0 ? firstMax : max);

  function take() {
    const out = [];
    for (;;) {
      buf = buf.replace(/^\s+/, '');
      if (!buf) break;
      const L = limit();
      BOUNDARY.lastIndex = 0;
      const m = BOUNDARY.exec(buf);
      if (m && m.index + 1 <= L) { out.push(buf.slice(0, m.index + 1).trim()); buf = buf.slice(m.index + 1); emitted++; continue; }
      if (buf.length <= L) break; // not decided yet: the clause may still end inside the limit
      let cut = buf.lastIndexOf(' ', L);
      if (cut <= 0) cut = L; // one long token: hard cut rather than stall
      const head = buf.slice(0, cut).trim();
      buf = buf.slice(cut);
      if (head) { out.push(head); emitted++; }
    }
    return out;
  }

  return {
    push(text) { buf += String(text || ''); return take(); },
    // Stream finished: whatever is left is the last chunk.
    end() { const out = take(); const rest = buf.trim(); buf = ''; if (rest) { out.push(rest); emitted++; } return out; },
    count: () => emitted,
  };
}

module.exports = { createStreamChunker, stripMarkup, createSpeechFeed, spokenPauses, FIRST_MAX, MAX };
