// Pure HUD interaction math (T-31 0.2.3 batch A). No DOM, no three, no Electron: imported by hud.js (renderer) and
// scripts/check-hud.mjs (plain Node), so the card geometry, the state -> gesture-variant map and the click throttle
// are unit-testable without a browser.

/** A card's centre rect -> stage NDC from the stage viewport rect, the same space reflex/schema.js lookAt targets use
 *  (x: left edge -1 .. right edge +1; y: bottom -1 .. top +1). `rect`/`viewport` are DOMRect-shaped
 *  { left, top, width, height }. */
export function rectToNdc(rect, viewport) {
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const x = ((cx - viewport.left) / viewport.width) * 2 - 1;
  const y = -(((cy - viewport.top) / viewport.height) * 2 - 1);
  return { x, y };
}

/** True when a card rect overlaps the stage at all. A zero-size or fully off-stage card gives a meaningless look
 *  target (and the yaw would be huge), so it is skipped rather than clamped. */
export function rectOnStage(rect, viewport) {
  if (!rect || !(rect.width > 0) || !(rect.height > 0)) return false;
  return rect.left < viewport.left + viewport.width && rect.left + rect.width > viewport.left
    && rect.top < viewport.top + viewport.height && rect.top + rect.height > viewport.top;
}

const clamp1 = (v) => (v < -1 ? -1 : v > 1 ? 1 : v);

/** The one-shot look target for a card, or null to skip it (A1: "clamp or skip when the card is offscreen or
 *  faded"). `flags.hidden` = the row is display:none; `flags.faded` = its group stepped aside for an arm (.yield). */
export function lookTarget(rect, viewport, { hidden = false, faded = false } = {}) {
  if (hidden || faded || !rectOnStage(rect, viewport)) return null;
  const { x, y } = rectToNdc(rect, viewport);
  return { x: clamp1(x), y: clamp1(y) };
}

/** The look target for a reaction (T-31 fix round 4, DIAG r3 #3): like `lookTarget`, but a passing arm-yield never
 *  skips the gaze. The yield only fades the group's opacity; the card's rect does not move and the gaze never enters
 *  the panel, so a reaction that lands during the 0.2 s fade must still look at its card (the old shared `faded` skip
 *  made about 1 reaction in 7 log `look:null` and play the double-take with no target). `hidden` and off-stage rects
 *  are still skipped: those give no usable point. Click glances keep `lookTarget` (a click on a yielded group is
 *  impossible anyway: hud.css disables its pointer events). */
export function reactionLook(rect, viewport, { hidden = false } = {}) {
  if (hidden || !rectOnStage(rect, viewport)) return null;
  const { x, y } = rectToNdc(rect, viewport);
  return { x: clamp1(x), y: clamp1(y) };
}

// A task's step state (or 'failed', defensively) -> the board gesture variant the reaction plays (A2). Anything else
// keeps the generic double-take. Every value must be an id present in reflex/gestures/board.json (check-hud.mjs ties
// the two together).
export const REACTION_VARIANTS = {
  done: 'nod-smile',
  blocked: 'concerned',
  failed: 'concerned',
};

// T-31 0.2.7 step 5 (DIAG 20-10 §5 row 5 + the 21-10 re-measure): a board reaction with an ARM, chosen from the
// card's REAL stage position. The float-holo panel sits on her right = screen LEFT, so:
//   screen-right card -> point at it with the hand on that side (her left, panel-far): card-point-*.
//   screen-left card, seated -> the hand on that side is her right: card-point-left-* (no panel in seated mode).
//   screen-left card, float  -> her right hand is the panel hand, so use the OTHER hand's small wave instead
//                               (card-nod-wave-*, left hand): a raised reach that never enters the panel.
// The status expression travels with the variant on BOTH sides (done -> happy, blocked/failed -> sad, running ->
// relaxed/focused), so an arm reaction no longer loses 'concerned'. Variant ids must exist in board.json.
export const ARM_STATE = Object.freeze({ done: 'done', blocked: 'blocked', failed: 'blocked', running: 'focused' });
// Keyed by the ARM_STATE tier (done / blocked / focused), so 'failed' shares the blocked pose + expression.
export const CARD_ARM_VARIANTS = Object.freeze({
  done: 'card-point-done', blocked: 'card-point-blocked', focused: 'card-point-focused',
});
export const CARD_ARM_LEFT_VARIANTS = Object.freeze({
  done: 'card-point-left-done', blocked: 'card-point-left-blocked', focused: 'card-point-left-focused',
});
export const CARD_FLOAT_LEFT_VARIANTS = Object.freeze({
  done: 'card-nod-wave-done', blocked: 'card-nod-wave-blocked', focused: 'card-nod-wave-focused',
});

/** Every board variant an arm reaction may pick (check-hud.mjs asserts each is in board.json). */
export const CARD_ARM_VARIANT_IDS = Object.freeze([
  ...Object.values(CARD_ARM_VARIANTS), ...Object.values(CARD_ARM_LEFT_VARIANTS), ...Object.values(CARD_FLOAT_LEFT_VARIANTS),
]);

/** step state (+ the changed card's stage-NDC point, optional, + {float} = the holo panel is up) -> board variant id.
 *  The point is the live card rect mapped by rectToNdc (hud.js) -- never a hand-placed side. Unknown / empty /
 *  in-progress states fall back to 'double-take'. A centred / non-finite / missing point keeps the head-only mapping. */
export function stateToVariant(state, look = null, { float = false } = {}) {
  const tier = ARM_STATE[state];
  const x = look && Number.isFinite(look.x) ? look.x : 0;
  if (!tier || x === 0) return REACTION_VARIANTS[state] || 'double-take';
  if (x > 0) return CARD_ARM_VARIANTS[tier];
  return (float ? CARD_FLOAT_LEFT_VARIANTS : CARD_ARM_LEFT_VARIANTS)[tier];
}

/** The HUD card groups' layout, in client px, exactly as hud.css places them (style 'a' default side panels,
 *  'b' arc panels): the step-update cards are the LEFT group (.hud-left), the ask cards the RIGHT one (.hud-right).
 *  Production uses the live getBoundingClientRect (hud.js cardLookOf); this is the same source for the plain-Node
 *  checks, so a test can never place a card where the HUD does not. check-hud.mjs ties these numbers to hud.css. */
export function hudCardRect(side, viewport, style = 'a') {
  const clamp = (min, frac, max) => Math.min(max, Math.max(min, frac * viewport.width));
  const base = { left: viewport.left || 0, top: viewport.top || 0 };
  if (style === 'b') {
    const wl = clamp(200, 0.23, 300), wr = clamp(200, 0.22, 290);
    return side === 'left'
      ? { ...base, left: base.left + 0.025 * viewport.width, top: base.top + 0.04 * viewport.height, width: wl, height: 0.42 * viewport.height }
      : { ...base, left: base.left + viewport.width - 0.025 * viewport.width - wr, top: base.top + 0.24 * viewport.height, width: wr, height: 0.24 * viewport.height };
  }
  const wl = clamp(210, 0.25, 330), wr = clamp(200, 0.22, 290);
  return side === 'left'
    ? { ...base, left: base.left + 14, top: base.top + 14, width: wl, height: 0.46 * viewport.height - 14 }
    : { ...base, left: base.left + viewport.width - 14 - wr, top: base.top + 0.24 * viewport.height, width: wr, height: 0.24 * viewport.height };
}

/**
 * Per-ask answer drafts that survive a HUD repaint (T-31 fix round 1610 r3). Every `hud:feed` poll repaints the HUD
 * (hud-host.mjs sends a feed on every board read: 2 s in the harness, 20 s in production) and paint() rebuilds the open
 * ask card from scratch. Before this, the picked option/verdict, the note text and the send-enabled state lived only in
 * the answerControls closure, so a pick made just before a poll was wiped, Send went back to disabled and doSend
 * returned early -- the answer never reached the board. One mutable `{ choice, verdict, text }` per ask key, kept the
 * same way the `answered` set lives in hud.js, so a repaint renders the same draft back. -> { get, drop, prune, clear }.
 */
export function createAnswerDrafts() {
  const map = new Map();
  return {
    /** The draft for `key`, created empty on first use; the SAME object is returned on every later call. */
    get(key) {
      let d = map.get(key);
      if (!d) { d = { choice: null, verdict: null, text: '' }; map.set(key, d); }
      return d;
    },
    /** Forget one ask's draft (an answer was sent: the board owns it now). */
    drop(key) { map.delete(key); },
    /** Keep only the drafts whose ask is still waiting (`liveKeys`: a Set of answer keys). */
    prune(liveKeys) { for (const k of [...map.keys()]) if (!liveKeys.has(k)) map.delete(k); },
    /** Drop every draft (the HUD switched off). */
    clear() { map.clear(); },
  };
}

/** True when a draft carries an answer worth sending: a picked option, a verdict, or a non-blank note. Mirrors
 *  ops.mjs's choice_or_text_required, so Send stays disabled until the draft can actually be answered. */
export const canSendDraft = (d) => Boolean(d && (d.choice || d.verdict || String(d.text || '').trim()));

/** The age label of a board time (an ask's `since`, a task's activity), in the board rail's own rule
 *  (vendor/laneboard/public/app.js shortDur): whole days rounded DOWN from 48 h, whole hours rounded down from 1 h,
 *  minutes below, `nowWord` under half a minute. Rounding to the nearest day made the HUD read a day older than the
 *  Board tab's rail for the same item (owner 31-10: GW 12d in the HUD, 11d on the rail). '' for a bad or future time. */
export function ageLabel(iso, nowMs, nowWord = 'now') {
  const ms = nowMs - Date.parse(iso || '');
  if (!Number.isFinite(ms) || ms < 0) return '';
  const m = Math.round(ms / 60000);
  if (m < 1) return nowWord;
  if (ms < 3600000) return `${m}m`;
  if (ms < 172800000) return `${Math.floor(ms / 3600000)}h`;
  return `${Math.floor(ms / 86400000)}d`;
}

/** A put-once-per-window gate (B5: the click reaction must not fire more than once per `minMs`, default 800 ms).
 *  Call the returned function with the current time; it returns true and records the time only when the window has
 *  passed. */
export function createClickThrottle(minMs = 800) {
  let last = -Infinity;
  return function allow(now) {
    if (!(now - last >= minMs)) return false;
    last = now;
    return true;
  };
}
