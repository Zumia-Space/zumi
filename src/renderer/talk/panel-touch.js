// Panel touch (T-31 C1 step 9, CONCEPTS.md §4 concept C): the ONE designed contact with the float holo panel --
// the only reach allowed to cross the panel plane (the 0.2.6 clamp still bans every sweep). A beat is a tap or a
// swipe on the live panel mesh: the fingertip lands ON the plane, stays 150-250 ms (the swipe then slides 6-10 cm
// along the plane), and every enter/leave runs through its own inMs/outMs envelope so the wrist never jumps.
//
// Pure planning math (no DOM, no three, no timers): scripts/check-panel-touch.mjs drives it directly, and
// talk/work-loop.js turns a plan + a live frame (room/holo-screen.js touchFrame) into a per-frame world contact.
//
// Frame = { c, n, r, u, hw, hh, toward, hand } in world space:
//   c  the panel centre, n its unit normal (local +Z -- toward the camera since alpha.10), r/u the panel's own
//      right/up axes, hw/hh its half width/height in metres, `toward` +1 when her body is on the +r side of the
//      panel (the near edge), `hand` the hand on that side ('right' for the shipped float offset).
export const TOUCH_IN_MS = 700; // enter envelope (smoothstep): measured peak wrist speed ~0.7 m/s (< 1.5)
export const TOUCH_OUT_MS = 700; // leave envelope
export const CONTACT_MIN_MS = 150;
export const CONTACT_MAX_MS = 250;
export const SWIPE_LATERAL_MS = 300; // the swipe's lateral move; the fingertip stays on the plane through it
export const SWIPE_MIN_M = 0.06;
export const SWIPE_MAX_M = 0.10;
export const BEAT_PAD_MS = 50; // beat time left after the plan: the reach is home, and the longest swipe + pad stays <= 2 s
export const PANEL_TOUCH_WEIGHT = 3; // vs read-panel's 1 (with two beats the anti-repeat alternates them; duration sets the share)
export const TOUCH_U0 = 0.55; // contact start, fraction of half-width toward her (the panel's near edge)
export const TOUCH_V0 = -0.25; // contact start, fraction of half-height (slightly below centre)

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
/** The enter/leave curve, exported so the work loop's interrupted-contact ease-out uses the SAME envelope as the
 *  planned one (review B2): a C1 smoothstep has zero slope at both ends, so a hand never starts or stops with a
 *  visible step. */
export function smoothstep(x) { const c = clamp01(x); return c * c * (3 - 2 * c); }

/** One tap or swipe, deterministic from `random`: 1.55-1.65 s (tap) / 1.85-1.95 s (swipe) of reach + contact +
 *  retract. The swipe starts near her and slides toward the panel centre, so the whole move stays inside the glass. */
export function makeTouchPlan(random = Math.random) {
  const kind = random() < 0.5 ? 'tap' : 'swipe';
  const contactMs = CONTACT_MIN_MS + random() * (CONTACT_MAX_MS - CONTACT_MIN_MS);
  const lateralMs = kind === 'swipe' ? SWIPE_LATERAL_MS : 0;
  const lateralM = kind === 'swipe' ? SWIPE_MIN_M + random() * (SWIPE_MAX_M - SWIPE_MIN_M) : 0;
  return { kind, inMs: TOUCH_IN_MS, contactMs, lateralMs, outMs: TOUCH_OUT_MS, lateralM, u0: TOUCH_U0, v0: TOUCH_V0, totalMs: TOUCH_IN_MS + contactMs + lateralMs + TOUCH_OUT_MS };
}

/** The plan at `tMs` after the beat began: the reach weight (0..1, smooth in/out) and how far the fingertip has
 *  slid along the plane (metres, 0 until a swipe's contact hold ends). `contact` is true exactly while the weight
 *  is 1, i.e. while the fingertip is meant to be ON the plane. */
export function touchAt(plan, tMs) {
  const holdStart = plan.inMs;
  const outStart = holdStart + plan.contactMs + plan.lateralMs;
  let weight;
  let phase;
  if (tMs < holdStart) { weight = smoothstep(clamp01(tMs / plan.inMs)); phase = 'enter'; }
  else if (tMs < outStart) { weight = 1; phase = tMs < holdStart + plan.contactMs ? 'contact' : 'swipe'; }
  else if (tMs < outStart + plan.outMs) { weight = 1 - smoothstep(clamp01((tMs - outStart) / plan.outMs)); phase = 'leave'; }
  else { weight = 0; phase = 'done'; }
  const lateralM = plan.lateralMs > 0 && tMs > holdStart + plan.contactMs
    ? plan.lateralM * smoothstep(clamp01((tMs - holdStart - plan.contactMs) / plan.lateralMs))
    : 0;
  return { weight: clamp01(weight), lateralM, phase, contact: weight >= 1 - 1e-9 };
}

/** A world point at pane coordinates (u, v) -- both fractions of the half extents, 0 = panel centre. */
export function panelPoint(frame, u, v) {
  const { c, r, u: up, hw, hh } = frame;
  return [c[0] + r[0] * u * hw + up[0] * v * hh, c[1] + r[1] * u * hw + up[1] * v * hh, c[2] + r[2] * u * hw + up[2] * v * hh];
}

/** The planned fingertip contact at `tMs`: a world point on the plane, plus the pane coordinates it lands on.
 *  The swipe slides from the near edge toward the centre, so it never runs off the glass on either hand. */
export function touchContact(frame, plan, tMs) {
  const at = touchAt(plan, tMs);
  const sign = frame.toward >= 0 ? 1 : -1;
  const u = sign * (plan.u0 - (frame.hw > 0 ? at.lateralM / frame.hw : 0));
  const v = plan.v0;
  return { ...at, u, v, point: panelPoint(frame, u, v) };
}

/** Signed distance of a world point from the panel plane (metres; negative = her side, 0 = on the glass). */
export function planeDistance(frame, p) {
  return (p[0] - frame.c[0]) * frame.n[0] + (p[1] - frame.c[1]) * frame.n[1] + (p[2] - frame.c[2]) * frame.n[2];
}

/** True when pane coordinates are on the glass (a 0.9 margin keeps a contact off the border). */
export function onPanel(frame, u, v, margin = 0.9) {
  return Math.abs(u) <= margin && Math.abs(v) <= margin;
}

/** Which hand is on the panel's side. `rightAxis` is her own right in world space (VRM 1.0: -X in the scene's
 *  frame), so the shipped float panel (SCREEN_OFFSET x < 0 = out to her right) resolves to her right hand. */
export function panelHandSide(hips, centre, rightAxis) {
  const dx = centre[0] - hips[0], dy = centre[1] - hips[1], dz = centre[2] - hips[2];
  return dx * rightAxis[0] + dy * rightAxis[1] + dz * rightAxis[2] >= 0 ? 'right' : 'left';
}
