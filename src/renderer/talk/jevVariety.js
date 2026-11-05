// Derived-variant generator + gate for Jev reaction motions (T-31 variety, PLAN-variety.md §2.2/§3). Pure,
// framework-free: every function here takes/returns plain GestureCommand-shaped data (reflex/schema.js) and runs
// the SAME substantive gate every speech gesture passes (schema, no clamping, 1.5-3.5 s) before a variant is
// allowed into a pool -- gateJevVariant() below, NOT talk/validate.js's checkSpeechGesture, because that gate
// also forces priority:6/interrupt:true/mirror:'none' (the speech-gesture pipeline's own call, not Jev's: Jev
// reactions have run at priority 5 -- 4 for 'neutral' -- since before this task, and raising them to 6 would
// start interrupting the 'send'/'focus'/'board' built-ins they never used to touch).
//
// Mirroring is NOT implemented here: the engine already mirrors a whole command at play time (reflex/player.js
// swaps left<->right bone names and negates y/z when mirror:'random' + side:-1 -- the same mechanism
// talk/director.js already uses for library variants, g.flip). jevSelector.js flags a variant mirrorable and
// plays it with side:-1 instead of recomputing the flip; this module only derives commands that need new
// numbers: amplitude (x0.85/x1.1 on bone rot), time (x0.9/x1.1 on timing), and a gaze aversion (added lookAt).
//
// Every Jev body variant is authored as PLAIN bone/lookAt elements (rot + delay/in/hold/out), never the `moves`
// shorthand or raw `keys` -- a keyed element's NORMALIZED shape (rot:[0,0,0], inMs:0, ...) is not valid as fresh
// validateGesture() input again (schema.js's keyed() rejects rot/inMs/holdMs alongside keys), so re-validating an
// already-normalized keyed bone -- exactly what deriving from a gated base requires -- would fail. Plain
// elements round-trip through validateGesture() safely any number of times; this module assumes that and throws
// if it ever sees a keyed one, instead of silently producing a wrong result.
import { validateGesture } from '../reflex/schema.js';
import { commandDurationMs, SPEECH_MIN_MS, SPEECH_MAX_MS } from './validate.js';

// validateGesture()'s NORMALIZED output sets follow/clip, and every channel element's own `osc`, to `null` when
// absent (every other field either stays a concrete value or an empty array). Feeding any of those back in as
// fresh input breaks: e.g. `input.follow !== undefined` is true for `null`, so it reaches `ctx.keys(null, ...)`
// -> "must be an object" (same story for a bone/root/lookAt/reach/expression element's `osc`). Harmless for a
// freshly-authored command (these fields are simply omitted, i.e. undefined) but real for anything derived from
// an already-gated base (gateJevVariant() below, and deriveAmplitude/deriveTime/deriveGaze, all re-validate) --
// and, just as real, for the FINAL played command: reflex/player.js's play() re-validates every command handed
// to it ("the ONE contract every reaction goes through"), so gateJevVariant() below also sanitizes its OUTPUT,
// not just the input, before returning it. Every reader of these fields elsewhere (player.js, engine.js) uses a
// truthy check (`if (cmd.clip)`, `if (el.osc)`), so an omitted key behaves exactly like an explicit `null`.
export const OSC_CHANNELS = ['bones', 'root', 'lookAt', 'reach', 'expressions'];
export function sanitizeForRevalidation(cmd) {
  const { follow, clip, ...rest } = cmd;
  for (const ch of OSC_CHANNELS) {
    if (Array.isArray(rest[ch])) rest[ch] = rest[ch].map((el) => (el.osc == null ? (({ osc, ...r }) => r)(el) : el));
  }
  return { ...rest, ...(follow ? { follow } : {}), ...(clip ? { clip } : {}) };
}

// -> { ok, command, durationMs } | { ok: false, errors }. Schema (no clamp warnings) + 1.5-3.5 s, the author's own
// priority/interrupt/mirror/jitter kept as-is (unlike checkSpeechGesture's OVERRIDES). Safe to call on either a
// freshly-authored command or an already-gated (and since-transformed) one, and its OWN output is sanitized too
// -- so `command` is always safe to feed into engine.playCommand() / validateGesture() again, any number of
// times (jevSelector.js stores and re-merges these; the engine's player re-validates on every play()).
export function gateJevVariant(command) {
  const input = sanitizeForRevalidation(command);
  const v = validateGesture(input);
  if (!v.ok) return { ok: false, errors: v.errors };
  if (v.warnings.length) return { ok: false, errors: v.warnings.map((w) => `needs clamping: ${w}`) };
  const durationMs = commandDurationMs(input);
  if (durationMs == null || durationMs < SPEECH_MIN_MS || durationMs > SPEECH_MAX_MS) {
    return { ok: false, errors: [`duration ${durationMs} ms outside ${SPEECH_MIN_MS}-${SPEECH_MAX_MS} ms`] };
  }
  return { ok: true, command: sanitizeForRevalidation(v.command), durationMs };
}

function scaleBones(bones, k) {
  return bones.map((b) => {
    if (b.keys) throw new Error('jevVariety: keyed bones are not supported -- author Jev motions as plain rot/timing');
    return { ...b, rot: b.rot.map((c) => c * k) };
  });
}
function scaleTimingList(list, k) {
  return list.map((el) => {
    if (el.keys) throw new Error('jevVariety: keyed elements are not supported -- author Jev motions as plain rot/timing');
    return { ...el, delayMs: Math.round(el.delayMs * k), inMs: Math.round(el.inMs * k), holdMs: Math.round(el.holdMs * k), outMs: Math.round(el.outMs * k) };
  });
}

// PLAN §2.2: "an amplitude scale of 0.85 or 1.1 on rot/osc" -- bones only, expressions/weights stay as authored.
export function deriveAmplitude(command, k) {
  return { ...command, bones: scaleBones(command.bones, k) };
}
// PLAN §2.2: "a time scale of 0.9-1.1 (still 1.5-3.5 s)".
export function deriveTime(command, k) {
  return { ...command, bones: scaleTimingList(command.bones, k), lookAt: scaleTimingList(command.lookAt, k) };
}
// PLAN §2.2: "a gaze variant (look away on the onset, back to the user on the stress)". Skipped when the base
// already drives lookAt -- its own gaze intent wins, never doubled up.
export function deriveGaze(command, target = 'away-left') {
  if (command.lookAt.length) return null;
  return {
    ...command,
    lookAt: [
      { target, weight: 0.5, delayMs: 0, inMs: 120, holdMs: 260, outMs: 180 },
      { target: 'camera', weight: 0.5, delayMs: 380, inMs: 150, holdMs: 700, outMs: 250 },
    ],
  };
}

// base: { id, family, mirrorable, command } (command already gateJevVariant-normalized).
// -> [{ id, family, kind, side, command }], every one re-gated (schema + 1.5-3.5 s) before it can play.
export function deriveVariants(base) {
  const out = [];
  const add = (kind, command, side = 1) => {
    if (!command) return;
    const g = gateJevVariant(command);
    if (!g.ok) return; // a derived variant that fails its own gate is simply not offered, never played unchecked
    out.push({ id: `${base.id}-${kind}`, family: base.family, kind, side, command: g.command });
  };
  // mirror: same numbers, played with side:-1 (engine-level flip) -- never for pointing/deixis (none of the 8 Jev
  // labels point at anything, so this only gates on the author's per-variant judgement call, `mirrorable`).
  if (base.mirrorable) add('mirror', base.command, -1);
  add('amp85', deriveAmplitude(base.command, 0.85));
  add('amp110', deriveAmplitude(base.command, 1.1));
  add('time90', deriveTime(base.command, 0.9));
  add('time110', deriveTime(base.command, 1.1));
  add('gaze', deriveGaze(base.command));
  return out;
}

// PLAN §3: "the face scaled down where it would fight the arm command". Jev body variants never carry their own
// expressions (that's the whole point of keeping body and face as separate pools), so this branch does not fire
// today -- it exists so a future body variant that DOES embed an expression (meaning-critical, e.g. a wince)
// still wins over the independently-picked face phrase instead of fighting it for the same emotion group.
export function mergeBodyFace(bodyCommand, faceExpressions) {
  const scale = bodyCommand.expressions && bodyCommand.expressions.length ? 0.6 : 1;
  const expressions = scale === 1 ? faceExpressions : faceExpressions.map((e) => ({ ...e, weight: +(e.weight * scale).toFixed(3) }));
  return { ...bodyCommand, expressions };
}
