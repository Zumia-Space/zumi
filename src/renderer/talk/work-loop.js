// Work loop (T-31 C1 steps 8-10, CONCEPTS.md §4 concept C + §5 mouse rule): the per-frame beat scheduler that gives
// Zumi something to DO while the working signal is on, instead of standing still and following the mouse.
// Renderer-only, like the signal it reads. A beat is one piece of work behaviour:
//   - "read panel" (step 8) -- a gaze target inside the holo panel, driven through the same primaryGaze slot the
//     engine's gaze layer already reads (the pointer baseline is then bypassed, CONCEPTS.md §5);
//   - "panel-touch" (step 9) -- a tap or a short swipe on the live panel mesh, driven through the engine's work-reach
//     slot (setWorkReach), which the engine injects AFTER the holo clamp (the one designed contact);
//   - "look at anh" (step 10) -- every 20-40 s she looks at the camera for 0.8-1.5 s with a small smile (the shipped
//     'happy' expression through engine.setWorkExpression), then returns to work.
// Step 10 also owns the working mouse rule (§5): a pointer resting on her hit region for 400 ms pauses the work and
// looks up at the camera (max 4 s, then work resumes even if the pointer never leaves); a click/poke/pat plays its own
// existing reaction and work resumes 1.5 s after that reaction ends; and a task event while working is work behaviour,
// not a card glance -- step done plays the HUD's own 'nod-smile' at the panel, blocked/failed its 'concerned', then a
// second look at the camera. Neither path awaits, and neither adds latency to a reflex (the CameraDirector latency
// rule): every gate here is a read of engine/runtime state, and the only command ever triggered is the board reaction
// the HUD would have played anyway.
//
// Rules:
//   - Starts and stops with the working signal: update() reads engine.working, the flag app.js's work-signal sink
//     already writes -- no second wire, no new IPC (src/main is frozen). The camera view is NOT driven by that signal
//     (review B1 / spec §5: talk and video rooms stay on the talk view). A task event is the one short exception: it
//     already started while working, so its 1-3 s timeline finishes even if that same feed ended the signal.
//   - Yields to talk, typing and speech: a chat turn in flight, engine.speechMouth, or the 'typing' state release the
//     gaze (she looks up at anh) and the next beat starts fresh once the gate clears; after the mouth closes the beat
//     waits SPEECH_RESUME_MS (spec §5: work resumes 1 s after the speech). A pointer hover and a reflex are pauses, not
//     ends: the working signal is untouched (CONCEPTS §5 pauses work).
//   - A touch contact is never cut: when a beat is interrupted while the hand is on (or reaching for) the panel, the
//     contact eases out through the same envelope as the planned leave (review B2) instead of snapping home.
//   - A beat is picked by weight with no immediate repeat -- the same anti-repeat idea as Catalog.pick() -- so the
//     C2 beats (keyboard/typing) can just be appended to BEATS without touching the scheduler.
//   - The read beat's target stays INSIDE the panel's projected NDC rect and scans it line by line over 3-4 s (small
//     offsets, random length per beat), so the gaze reads as reading rather than as a frozen look.
//   - The touch beat asks the live panel mesh for its plane (holo.touchFrame) and hands the engine one world
//     fingertip point per frame (setWorkReach): the fingertip lands ON the plane (tap) or slides 6-10 cm along it
//     (swipe), with inMs/outMs envelopes on every enter/leave. It is the ONE designed contact, and it never passes
//     through the holo clamp: engine.applyPose injects it after the clamp, on the panel hand only.
// Pure ES module (no DOM, no three, no timers): scripts/check-work-loop.mjs and check-panel-touch.mjs drive it and
// the real engine on a fake clock in milliseconds.
import { makeTouchPlan, touchContact, smoothstep, TOUCH_OUT_MS, PANEL_TOUCH_WEIGHT, BEAT_PAD_MS } from './panel-touch.js';

export const READ_PANEL_MIN_MS = 3000;
// The read draw is kept in the lower half of the brief's 3-5 s window: with only two shipped beats the anti-repeat
// strictly alternates them, so the touch beat's share of the working time is touchMs / (touchMs + readMs). A 1.2-2.0 s
// touch beat needs a ~3-4 s read to hold the owner's >= 30% arm share (scripts/check-panel-touch.mjs section 4).
export const READ_PANEL_MAX_MS = 4000;
export const SCAN_SPAN = 0.5; // fraction of the panel's half-width/half-height the scan uses (keeps a margin inside the rect)
export const SCAN_LINES = 3; // text lines read per beat: left -> right, then a saccade down to the next line
export const PANEL_TOUCH_MIN_MS = 1200; // every touch plan (tap or swipe) is 1-2 s, per the C1 brief
export const PANEL_TOUCH_MAX_MS = 2000;

// ---------- step 10: the look-at-anh beat + the mouse rule (CONCEPTS §4 item 5, §5) ----------
export const LOOK_AT_ANH_MIN_MS = 20_000; // gap between two look-at-anh beats (the brief's 20-40 s range)
export const LOOK_AT_ANH_MAX_MS = 40_000;
export const LOOK_AT_ANH_MIN_DURATION_MS = 800; // how long she holds the look (0.8-1.5 s)
export const LOOK_AT_ANH_MAX_DURATION_MS = 1500;
/** A look that comes due while the touch beat is live waits for it to finish (ending a contact mid-reach would snap
 *  the hand home). A touch beat is at most 2 s, so the draw below reserves exactly that much: the interval between
 *  two ACTUAL looks still lands inside the brief's 20-40 s window. */
export const LOOK_AT_ANH_DEFER_MAX_MS = PANEL_TOUCH_MAX_MS + BEAT_PAD_MS;
/** The camera in stage NDC: the centre of the stage is where she looks to meet anh's eyes (gazeLayer's yaw/pitch are
 *  zero here). Same space as every other work gaze target, so no second gaze path. */
export const CAMERA_NDC = Object.freeze({ x: 0, y: 0 });
/** The "small smile" of the look-at-anh beat -- a shipped expression, held softly (0.35), cleared the frame the look
 *  ends. Written through engine.setWorkExpression, which adds it on top of the life layer + the player each frame. */
export const WORK_SMILE = Object.freeze({ name: 'happy', weight: 0.35 });
export const HOVER_DELAY_MS = 400; // §5: pointer resting on her this long pauses the work
export const HOVER_MAX_MS = 4000; // ... and she holds the look-up at most this long, then goes back to work
export const REACTION_RESUME_MS = 1500; // §5: a click/poke/pat reaction -> work resumes 1.5 s after it ends
export const SPEECH_RESUME_MS = 1000; // §5: work resumes 1 s after the speech ends (review S5)
export const TASK_CAMERA_MS = 1000; // blocked: a concerned look at the panel, then this long at the camera
/** A step event while working reuses the HUD's shipped board variants (hud-logic REACTION_VARIANTS), only aimed at the
 *  panel instead of the card. Kept here because the work loop is what plays them; check-work-loop ties the ids back to
 *  hud-logic so the two can never drift. */
export const WORK_EVENT_VARIANTS = Object.freeze({ done: 'nod-smile', blocked: 'concerned', failed: 'concerned' });

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** The read-panel scan: `u` 0..1 across the beat -> a stage-NDC target inside `rect` ({x0,x1,y0,y1}). Line by line,
 *  top to bottom; the jump between lines is the eye's own saccade, the sweep within a line is the read. Pure, so the
 *  check can sample it at any resolution. */
export function readPanelGaze(rect, u) {
  const cx = (rect.x0 + rect.x1) / 2;
  const cy = (rect.y0 + rect.y1) / 2;
  const hw = ((rect.x1 - rect.x0) / 2) * SCAN_SPAN;
  const hh = ((rect.y1 - rect.y0) / 2) * SCAN_SPAN;
  const f = clamp01(u) * SCAN_LINES;
  const line = Math.min(SCAN_LINES - 1, Math.floor(f));
  const inLine = clamp01(f - line);
  return { x: cx + hw * (2 * inLine - 1), y: cy + hh * (1 - (2 * (line + 0.5)) / SCAN_LINES) };
}

/** Weighted pick with no immediate repeat (Catalog.pick's rule): the previous beat is out of the pool while any other
 *  beat exists. Pure; `random` is injected so the check is deterministic. */
export function pickBeat(beats, lastId, random = Math.random) {
  const list = Array.isArray(beats) ? beats.filter((b) => b && b.weight > 0) : [];
  if (!list.length) return null;
  const pool = list.length > 1 ? list.filter((b) => b.id !== lastId) : list;
  let r = random() * pool.reduce((s, b) => s + b.weight, 0);
  for (const b of pool) { r -= b.weight; if (r < 0) return b; }
  return pool[pool.length - 1];
}

/** The panel-touch beat (C1 step 9): a tap or swipe on the panel. A touch beat builds its own plan per pick
 *  (makeTouchPlan) and lasts that plan + BEAT_PAD_MS, so minMs/maxMs are only the documented 1-2 s envelope.
 *  NOT shipped since alpha.10 (owner 31-10: the hologram "interacting" with her looked wrong; it is a flat screen
 *  beside her, not a thing in her hand). Kept, with its engine slot, so check-panel-touch still proves the mechanism. */
export const PANEL_TOUCH_BEAT = Object.freeze({ id: 'panel-touch', weight: PANEL_TOUCH_WEIGHT, minMs: PANEL_TOUCH_MIN_MS, maxMs: PANEL_TOUCH_MAX_MS, touch: true });

/** The shipped beat table: reading the panel only (alpha.10 dropped PANEL_TOUCH_BEAT). Frozen so a stray write cannot
 *  change the schedule. The look-at-anh beat is NOT in this table: it is scheduled by its own 20-40 s clock, not drawn
 *  by weight. */
export const BEATS = Object.freeze([
  Object.freeze({ id: 'read-panel', weight: 1, minMs: READ_PANEL_MIN_MS, maxMs: READ_PANEL_MAX_MS, gaze: readPanelGaze }),
]);

/**
 * @param {object} deps
 *   engine    ReflexEngine  -- reads .working (the signal app.js's sink already writes) + speechMouth +
 *                              isState('typing'/'pat') + isBusy(); writes the gaze via setWorkGaze(point|null), the one
 *                              contact via setWorkReach({hand, point, weight}|null) and the held smile via
 *                              setWorkExpression(expr|null)
 *   holo      HoloScreen | null -- .on, .screenRect(), .screenNdc() and .touchFrame(); null / off (no panel: seated
 *                              and not working -- step 11 keeps the panel up while working seated, see app.js's
 *                              applyWorkPanel and holo-screen.js's workPanelOn) means no beat
 *   busy      () => boolean -- a talk turn is in flight (app.js passes the talk director's turn state)
 *   hover     () => boolean -- the pointer rests on her hit region this frame (app.js: input.pointerOver())
 *   react     (variant, look) => number -- play one shipped board reaction aimed at `look`, returning its length in
 *                              ms so the task timeline matches the real command (app.js: catalog + engine.trigger)
 *   now/random injected clock + RNG (a fake clock in scripts/check-work-loop.mjs)
 *   beats     the beat table (tests inject a multi-beat table to prove the weighted anti-repeat pick)
 */
export function createWorkLoop({ engine, holo, busy = () => false, hover = null, react = null, now = () => performance.now(), random = Math.random, beats = BEATS } = {}) {
  let beat = null; // { def, at, durationMs, plan? } -- the weighted work beat in flight
  let lookBeat = null; // { at, durationMs } -- the scheduled look-at-anh beat in flight
  let nextLookAtAt = null; // when the next look-at-anh beat is due (null until the loop first runs)
  let hoverSince = null; // continuous hover start (CONCEPTS §5: >= 400 ms pauses the work)
  let hoverHold = null; // { at } while she is holding the look-up
  let hoverLatched = false; // the 4 s cap was reached: stay in work until the pointer leaves her
  let reacting = false; // a one-shot reflex / pat is live
  let reactEndAt = null; // when it stopped being live (the 1.5 s resume clock starts here)
  let task = null; // { state, variant, at, panel, panelMs, cameraMs, phase } -- a task-event timeline
  let lastId = null; // anti-repeat memory (the previous work beat's id)
  let owning = false; // this loop currently owns engine.primaryGaze
  let contact = null; // { hand, point, weight } -- the contact last written to the engine (B2's leave starts here)
  let leaving = null; // { hand, point, from, at, outMs } -- an interrupted contact easing out (B2)
  let speaking = false; // the mouth was open on the previous frame
  let speechEndAt = null; // the frame it closed: SPEECH_RESUME_MS's clock (S5)

  const lookGap = () => LOOK_AT_ANH_MIN_MS + random() * Math.max(0, LOOK_AT_ANH_MAX_MS - LOOK_AT_ANH_MIN_MS - LOOK_AT_ANH_DEFER_MAX_MS);

  // One gaze write. Every work mode (read, touch, look-at-anh, hover, task) goes through here, so a mode change can
  // never leave a stale contact or a stale expression armed. `expression` null clears the held smile. A mode change
  // out of a live contact starts B2's leave instead of clearing the reach on the spot.
  function write(point, expression) {
    owning = true;
    if (!engine) return point;
    beginLeave(now());
    if (typeof engine.setWorkReach === 'function' && !leaving) engine.setWorkReach(null);
    if (typeof engine.setWorkGaze === 'function') engine.setWorkGaze(point);
    if (typeof engine.setWorkExpression === 'function') engine.setWorkExpression(expression || null);
    return point;
  }

  // B2: an interruption must never snap the arm home. The planned beat already eases through its plan's outMs; when
  // the beat is cut short (hover, speech, typing, a reaction, a task event, the signal going off) the hand eases out
  // from the weight that was ON SCREEN, over TOUCH_OUT_MS scaled by that weight -- the same tip-space envelope as the
  // enter (panel-touch.smoothstep), so the wrist speed stays in the same sub-1.5 m/s band. The gaze and the
  // expression may still switch at once; only the contact is eased.
  function beginLeave(t) {
    if (!contact) return;
    const from = contact.weight;
    if (from > 0) leaving = { hand: contact.hand, point: contact.point, from, at: t, outMs: Math.max(1, TOUCH_OUT_MS * from) };
    contact = null;
  }

  // One leave frame: write the shrinking contact, and clear it (the engine's own way) on the last frame. Returns true
  // while the leave is still running; the caller starts no new beat until it is home.
  function leaveFrame(t) {
    if (!leaving) return false;
    const k = (t - leaving.at) / leaving.outMs;
    if (k >= 1) {
      leaving = null;
      if (engine && typeof engine.setWorkReach === 'function') engine.setWorkReach(null);
      return false;
    }
    const weight = leaving.from * (1 - smoothstep(Math.max(0, k)));
    if (engine && typeof engine.setWorkReach === 'function' && weight > 0) {
      engine.setWorkReach({ hand: leaving.hand, point: leaving.point, weight });
    }
    return true;
  }

  // Hand the view its own gaze back and drop the contact + the smile. Idempotent: called every paused frame, only the
  // first frame writes. A live touch contact is not dropped: beginLeave() eases it out first (B2).
  function release(t = now()) {
    if (!owning) return;
    owning = false;
    beat = null;
    if (!engine) return;
    beginLeave(t);
    if (typeof engine.setWorkGaze === 'function') engine.setWorkGaze(null);
    if (typeof engine.setWorkExpression === 'function') engine.setWorkExpression(null);
    if (!leaving && typeof engine.setWorkReach === 'function') engine.setWorkReach(null);
  }

  // The signal went off (or the app tore the loop down): forget every schedule, so a new work session starts clean.
  // A contact that was live keeps its ease-out: leaving is advanced by update() every frame, then clears itself.
  function stop(t = now()) {
    release(t);
    beat = null; lookBeat = null; nextLookAtAt = null;
    hoverSince = null; hoverHold = null; hoverLatched = false;
    reacting = false; reactEndAt = null;
  }

  // Talk / typing / a talk turn in flight: yield until the gate clears, then resume at once (step 8's behaviour --
  // these are not the "reaction" of §5, so no 1.5 s settle).
  function talking(t) {
    if (engine && engine.speechMouth) return true;
    if (engine && typeof engine.isState === 'function' && engine.isState('typing')) return true;
    return Boolean(busy());
  }

  // A click / poke / pat owns the stage while it plays. `isBusy` is the engine's own "a one-shot interrupt gesture is
  // live" signal (poke included); 'pat' is a sustained STATE, so it has to be asked for separately. Once it ends the
  // loop waits REACTION_RESUME_MS (§5: work resumes 1.5 s after the reaction).
  function reactionLive(t) {
    if (engine && typeof engine.isState === 'function' && engine.isState('pat')) return true;
    return Boolean(engine && typeof engine.isBusy === 'function' && engine.isBusy(t) > 0.05);
  }

  // The panel must be on screen with a valid projected rect; null means there is no beat for this frame. Since step 11
  // that is "no panel up" (seated and not working, or no talk view), never "seated" by itself: app.js brings the SAME
  // panel up in its seated placement while working, and the beats below read that placement's rect/plane unchanged.
  function panelRect() {
    if (!holo || !holo.on || typeof holo.screenRect !== 'function') return null;
    const rect = holo.screenRect();
    return rect && rect.x1 > rect.x0 && rect.y1 > rect.y0 ? rect : null;
  }

  function start(t) {
    const def = pickBeat(beats, lastId, random);
    if (!def) return false;
    lastId = def.id;
    if (def.touch) {
      const plan = makeTouchPlan(random);
      beat = { def, at: t, durationMs: plan.totalMs + BEAT_PAD_MS, plan };
    } else {
      beat = { def, at: t, durationMs: def.minMs + random() * Math.max(0, def.maxMs - def.minMs) };
    }
    return true;
  }

  // The task-event timeline: the reaction gesture plays against `task.panel` (the panel centre) for its own length,
  // then a blocked step adds a look at the camera. Returns the gaze it wrote, or null when the timeline is over.
  function taskFrame(t) {
    if (task.phase === 'panel') {
      if (t - task.at < task.panelMs) return write(task.panel, null);
      if (!task.cameraMs) { task = null; beat = null; return null; }
      task.phase = 'camera';
      task.at = t;
    }
    if (t - task.at >= task.cameraMs) { task = null; beat = null; return null; }
    return write(CAMERA_NDC, null);
  }

  return {
    /** One call per frame. Never awaits; a task timeline first, then the gates, then the hover rule, then the
     *  look-at-anh clock, then one weighted beat (and, for a touch beat, one world fingertip contact). Returns the
     *  gaze it set this frame, or null when it yielded / stopped (tests assert both directly). */
    update(t = now()) {
      // S5 + B2 run before every gate: the speech clock has to see the mouth close even on a frame that yields for
      // another reason, and an interrupted contact must keep easing out after the beat, gate or signal that cut it.
      if (engine && engine.speechMouth) { speaking = true; speechEndAt = null; }
      else if (speaking) { speaking = false; speechEndAt = t; }
      if (leaving) leaveFrame(t);

      // A task event started while working: let its short timeline finish even if that very feed dropped the signal.
      if (task) {
        const out = taskFrame(t);
        if (out) return out;
        if (!(engine && engine.working)) { stop(t); return null; }
      }
      if (!engine || !engine.working) { stop(t); return null; }
      if (talking(t)) { release(t); return null; }
      // Spec §5: work resumes 1 s after the speech ends, not on the next frame (review S5).
      if (speechEndAt != null) {
        if (t - speechEndAt < SPEECH_RESUME_MS) { release(t); return null; }
        speechEndAt = null;
      }
      if (reactionLive(t)) { reacting = true; reactEndAt = null; release(t); return null; }
      if (reacting) { reacting = false; reactEndAt = t; }
      if (reactEndAt != null) {
        if (t - reactEndAt < REACTION_RESUME_MS) { release(t); return null; }
        reactEndAt = null;
      }
      const rect = panelRect();
      if (!rect) { release(t); return null; }

      // Mouse rule #1 (§5): a pointer resting on her for HOVER_DELAY_MS pauses the work and looks up at anh; the look
      // holds while she is hovered, capped at HOVER_MAX_MS, after which work resumes even if the pointer never leaves
      // (hoverLatched) until it does. The pause ends the current beat, so work restarts on a fresh beat.
      const hovered = Boolean(hover && hover());
      if (!hovered) {
        hoverSince = null; hoverHold = null; hoverLatched = false;
      } else {
        if (hoverSince == null) hoverSince = t;
        if (!hoverHold && !hoverLatched && t - hoverSince >= HOVER_DELAY_MS) { hoverHold = { at: t }; beat = null; lookBeat = null; }
        if (hoverHold && t - hoverHold.at >= HOVER_MAX_MS) { hoverHold = null; hoverLatched = true; beat = null; }
      }
      if (hoverHold) return write(CAMERA_NDC, null);

      // The look-at-anh beat, on its own 20-40 s clock: it holds the camera for 0.8-1.5 s with the small smile, then
      // the next frame starts a fresh work beat (the gaze returns to the panel by itself). It may cut a READ beat
      // (gaze only), but never a TOUCH beat mid-contact -- ending the contact early would snap the hand home; a touch
      // beat is at most ~2 s and the draw reserved that deferral (LOOK_AT_ANH_DEFER_MAX_MS). The clock restarts from
      // the ACTUAL look, so the observed gap between two looks stays inside the brief's 20-40 s.
      if (nextLookAtAt == null) nextLookAtAt = t + lookGap();
      const touchInFlight = Boolean(beat && beat.def.touch && t - beat.at < beat.durationMs);
      if (!lookBeat && t >= nextLookAtAt && !touchInFlight) {
        lookBeat = { at: t, durationMs: LOOK_AT_ANH_MIN_DURATION_MS + random() * (LOOK_AT_ANH_MAX_DURATION_MS - LOOK_AT_ANH_MIN_DURATION_MS) };
        nextLookAtAt = t + lookGap();
        beat = null;
      }
      if (lookBeat) {
        if (t - lookBeat.at < lookBeat.durationMs) return write(CAMERA_NDC, WORK_SMILE);
        lookBeat = null; beat = null;
      }

      if (!beat || t - beat.at >= beat.durationMs) {
        if (leaving) return null; // B2: an interrupted contact is still easing out -- no new beat until the hand is home
        if (!start(t)) { release(t); return null; }
      }
      if (beat.def.touch) {
        const frame = typeof holo.touchFrame === 'function' ? holo.touchFrame() : null;
        if (!frame || !(frame.hw > 0) || !(frame.hh > 0)) { release(t); return null; } // no live plane -> no contact
        const touch = touchContact(frame, beat.plan, t - beat.at);
        const gaze = typeof holo.screenNdc === 'function' ? holo.screenNdc() : { x: 0, y: 0 };
        owning = true;
        if (engine && typeof engine.setWorkReach === 'function') {
          engine.setWorkReach({ hand: frame.hand, point: touch.point, weight: touch.weight });
          // Remember what is on screen, so an interruption on ANY later frame eases out from exactly that weight (B2).
          contact = { hand: frame.hand, point: touch.point, weight: touch.weight };
        }
        if (engine && typeof engine.setWorkExpression === 'function') engine.setWorkExpression(null);
        if (engine && typeof engine.setWorkGaze === 'function') engine.setWorkGaze(gaze);
        return gaze;
      }
      const gaze = beat.def.gaze(rect, clamp01((t - beat.at) / beat.durationMs));
      return write(gaze, null); // a read beat never reaches and never smiles
    },
    /** A step event while she is working: play the HUD's shipped board variant aimed at the panel, then (blocked) a
     *  look at the camera. Returns false when the loop is not running, so the HUD can fall back to its card reaction. */
    taskEvent({ state } = {}) {
      const variant = WORK_EVENT_VARIANTS[state];
      if (!variant) return false;
      if (!(engine && engine.working) && !owning) return false;
      const rect = panelRect();
      if (!rect) return false;
      const panel = typeof holo.screenNdc === 'function' ? holo.screenNdc() : { x: (rect.x0 + rect.x1) / 2, y: (rect.y0 + rect.y1) / 2 };
      release(); // the gesture owns the stage -- drop the work gaze/contact/smile before it starts
      const ms = typeof react === 'function' ? Number(react(variant, panel)) : 0;
      task = {
        state, variant, at: now(), panel,
        panelMs: Number.isFinite(ms) && ms > 0 ? ms : 0,
        cameraMs: state === 'done' ? 0 : TASK_CAMERA_MS, // done: the nod+smile is the whole reaction
        phase: 'panel',
      };
      return true;
    },
    /** Current state (dev hook + the check's timing assertions). */
    get state() {
      return {
        owning, beat: beat ? beat.def.id : null, startedAt: beat ? beat.at : null, durationMs: beat ? beat.durationMs : null, lastId,
        lookAt: lookBeat ? { at: lookBeat.at, durationMs: lookBeat.durationMs } : null,
        hover: Boolean(hoverHold), hoverLatched,
        leaving: Boolean(leaving), // B2: a cut contact is still easing out
        task: task ? { state: task.state, variant: task.variant, phase: task.phase } : null,
        nextLookAtAt,
      };
    },
    /** Explicit stop (app teardown / tests); update() already stops on its own when the signal drops. */
    stop,
  };
}
