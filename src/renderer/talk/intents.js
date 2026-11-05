// Speech-gesture vocabulary of this round, the owner-facing words for it, and the cache key.
// The model answers with an abstract intent (never a clip name); the app decides what plays.
// Labels are what the owner reads: plain words, never codes or the model's English labels. The stable English
// literals below come from i18n.js (the live UI reads the active locale through `t('intent.<id>')`).
import { en } from '../i18n.js';

export const INTENTS = ['greet', 'agree', 'disagree', 'point-screen', 'think', 'celebrate', 'explain'];
export const ENERGIES = ['low', 'mid', 'high'];
export const DEIXES = ['none', 'user', 'board', 'screen-left', 'screen-right'];

const INTENT_KEYS = [...INTENTS, 'none'];
const SOURCE_KEYS = ['composed', 'cache', 'library', 'builtin'];

export const INTENT_LABEL_VI = Object.fromEntries(INTENT_KEYS.map((k) => [k, en('intent.' + k)]));
export const SOURCE_LABEL_VI = Object.fromEntries(SOURCE_KEYS.map((k) => [k, en('source.' + k)]));

// Speech length buckets: a gesture fitted to a 1.5 s line differs from one for a 6 s line.
export function durBucket(ms) { return ms < 2000 ? 'short' : ms <= 5000 ? 'mid' : 'long'; }

// Before the audio is decoded the length is estimated from the text (Vietnamese Chirp3 speaks roughly 13 chars/s;
// an assumption, replaced by the decoded length as soon as the audio is ready).
export const CHARS_PER_SEC = 13;
export function estimateSpeechMs(text) { return Math.round((String(text).length / CHARS_PER_SEC) * 1000); }

export function cacheKey({ intent, energy, deixis }, speechMs, rigVersion) {
  return `${intent}|${energy}|${durBucket(speechMs)}|${deixis}|${rigVersion}`;
}

// Which side of the screen a deixis points to (+1 = viewer's right, -1 = viewer's left; the board sidebar is on the left).
export function deixisSide(deixis) { return deixis === 'screen-right' ? 1 : deixis === 'board' || deixis === 'screen-left' ? -1 : 0; }

// Last-resort fallback for an intent that has no library or cached variant yet: an existing built-in reflex variant
// that carries the same meaning. null = nothing fitting exists; the turn then speaks without a gesture (logged).
export const BUILTIN_FALLBACK = {
  greet: ['focus', 'wave'],
  agree: ['send', 'nod'],
  'point-screen': ['board', 'turn-point'],
  disagree: null,
  think: null,
  celebrate: null,
  explain: null,
};
