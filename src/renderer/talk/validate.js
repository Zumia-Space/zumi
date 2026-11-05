// Gate for every speech gesture BEFORE it can play or enter the cache (LLM output, cache load, library seed), and the
// gate for the model's "analysis" text before it is shown. Pure functions: also run by scripts/check-speech.mjs in Node.
import { validateGesture } from '../reflex/schema.js';
import { GesturePlayer, isFaceOnly } from '../reflex/player.js';
import { en } from '../i18n.js';

export const SPEECH_MIN_MS = 1500;
export const SPEECH_MAX_MS = 3500;

// Speech gestures are fixed one-shots: these fields are the app's call, not the model's.
const OVERRIDES = { priority: 6, interrupt: true, mirror: 'none' };

// raw: a command as written (the player validates it again); -> its length in ms, or null if it does not play
export function commandDurationMs(raw) {
  const p = new GesturePlayer({ now: () => 0, random: () => 0.5 });
  const res = p.play(raw, { noJitter: true });
  return res.ok ? p.duration(p.find(res.id)) : null;
}

// -> { ok, command (raw command with the overrides applied), durationMs, errors[] }
// Rejects: schema errors, ANY clamp warning (a command that needs clamping is wrong, not almost right), clips (no canned
// animation in the speech path), sustained commands, more than one reach per hand, a length outside 1.5–3.5 s.
// The ONE exception: a face-only emotion held for the whole reply (T-31 0.2.3 B2 item 1) — it is sustained and its
// length is not a fixed one-shot, so it is exempt from the one-shot rule and the 1.5–3.5 s cap (durationMs is null).
export function checkSpeechGesture(input) {
  const errors = [];
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return { ok: false, errors: ['command must be an object'] };
  const held = input.sustain === true && isFaceOnly(input);
  const raw = { ...input, ...OVERRIDES };
  if (held) raw.sustain = true; else delete raw.sustain;
  if (input.sustain === true && !held) errors.push('sustain: speech gestures are one-shots');
  if (input.clip !== undefined) errors.push('clip: no canned clips in the speech path');
  const v = validateGesture(raw);
  if (!v.ok) errors.push(...v.errors);
  if (v.warnings && v.warnings.length) errors.push(...v.warnings.map((w) => `needs clamping: ${w}`));
  let durationMs = null;
  if (v.ok) {
    const hands = v.command.reach.map((r) => r.hand);
    if (new Set(hands).size !== hands.length) errors.push('reach: at most one reach per hand');
    durationMs = held ? null : commandDurationMs(raw);
    if (!held && (durationMs == null || durationMs < SPEECH_MIN_MS || durationMs > SPEECH_MAX_MS)) errors.push(`duration ${durationMs} ms outside ${SPEECH_MIN_MS}–${SPEECH_MAX_MS} ms`);
  }
  return errors.length ? { ok: false, errors, durationMs } : { ok: true, command: raw, durationMs, errors: [] };
}

// ---------- analysis panel text ----------
// The three lines come from the model's own structured output for the turn. Shown only when every line is a plain
// Vietnamese sentence; anything that looks like an ID, code, JSON or jargon is refused and the panel says so honestly.
const VI_MARKS = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i;
const BAD = [
  [/\b[A-Z]{1,6}-\d+\b/, 'task code'],
  [/\b[a-z]+_[a-z0-9_]+\b/, 'snake_case'],
  [/\b[a-z]+[A-Z][A-Za-z]+\b/, 'camelCase'],
  [/[{}[\]<>`#*|]/, 'markup or JSON'],
  [/\b(GestureCommand|intent|schema|json|api|turnId|rigVersion)\b/i, 'jargon'],
  [/https?:\/\//i, 'link'],
];
export const ANALYSIS_MAX_CHARS = 160;
export const ANALYSIS_FIELDS = ['understood', 'plan', 'why'];

// -> { ok, lines: {understood, plan, why} } | { ok: false, reason }
export function checkAnalysis(a) {
  if (a == null) return { ok: false, reason: 'no analysis from the model' };
  if (typeof a !== 'object') return { ok: false, reason: 'not an object' };
  const lines = {};
  for (const k of ANALYSIS_FIELDS) {
    const t = typeof a[k] === 'string' ? a[k].trim() : '';
    if (!t) return { ok: false, reason: `${k}: empty` };
    if (t.length > ANALYSIS_MAX_CHARS) return { ok: false, reason: `${k}: longer than ${ANALYSIS_MAX_CHARS} chars` };
    if (!VI_MARKS.test(t)) return { ok: false, reason: `${k}: not Vietnamese` };
    for (const [re, what] of BAD) if (re.test(t)) return { ok: false, reason: `${k}: ${what}` };
    lines[k] = t;
  }
  return { ok: true, lines };
}

export const ANALYSIS_MISSING_VI = en('app.analysisMissing');
