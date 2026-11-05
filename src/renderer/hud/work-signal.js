// Working signal (T-31 C1 step 7): the renderer's own "she is working" flag, derived from the HUD feed the renderer
// already receives (hud/hud.js 'hud:feed', built by src/main/hud-feed.mjs) plus the talk turn clock. Renderer-only by
// design -- src/main is frozen, so no new IPC. Two sources turn it on (CONCEPTS.md §5):
//   - a board step in a running state whose task saw activity within the last 10 min;
//   - a chat turn (TalkDirector.send() has not finished), and for CHAT_HOLD_MS after it ends.
// It drives engine.working (the work loop and the seated work panel read that flag). It deliberately does NOT drive
// CameraDirector: spec §5 keeps talk/video rooms on the talk view, so a working signal must never cut the camera to
// the over-the-shoulder Work view (review B1). When HUD style is Off the feed never reaches the renderer, so working
// stays false -- accepted for C1.
// Pure: no DOM, no timers, no clock of its own (the injected `now`), so scripts/check-work-signal.mjs runs it under a
// fake clock in milliseconds.

export const WORK_IDLE_MS = 10 * 60 * 1000; // "activity in the last 10 min" (CONCEPTS.md §5)
// A chat turn alone raised the seated panel and dropped it the frame the reply ended, so the panel popped up and
// vanished around every message and cancelled any reach in flight (review S2). The chat half therefore stays true
// for this long after the turn ends, with no board feed needed: the panel appears once and settles.
export const CHAT_HOLD_MS = 10_000;
// The board step state that means "running": rules.mjs reports the current step as active/waiting/blocked/todo, and
// i18n's hud.state.active reads "doing". A waiting/blocked step is not running, so it does not make her work.
export const RUNNING_STEP_STATE = 'active';

/** Pure, on already-parsed rows [{ state, at }]: is any running step's activity within `idleMs` of `now`? */
export function anyRunningStep(steps, now, idleMs = WORK_IDLE_MS) {
  return Array.isArray(steps) && steps.some((s) => s && s.state === RUNNING_STEP_STATE && Number.isFinite(s.at) && now - s.at <= idleMs);
}

/**
 * Pure, on a HUD feed's task rows (buildHudFeed: { stepState, at }). working = a chat turn is in flight, or any task
 * has a running step whose activity is within `idleMs`. `<= idleMs` keeps a step working through the whole 10th
 * minute and drops it on the first tick after -- "after 10 min of silence". A row whose `at` does not parse never
 * counts (no invented activity).
 */
export function deriveWorking(updates, chatBusy, now, idleMs = WORK_IDLE_MS) {
  if (chatBusy) return true;
  const steps = (Array.isArray(updates) ? updates : []).map((u) => ({ state: u && u.stepState, at: Date.parse((u && u.at) || '') }));
  return anyRunningStep(steps, now, idleMs);
}

/**
 * Stateful wrapper: remembers the last feed + the chat flag, and publishes only on a real change.
 * @param {() => number} [now]      epoch ms (Date.now in the app; a fake clock in the check)
 * @param {(line: string) => void} [log]   one line per change, exactly "[work] working=true|false"
 * @param {(on: boolean) => void} [apply]  the sink: app.js sets CameraDirector.setWorking + engine.working here
 */
export function createWorkSignal({ now = () => Date.now(), idleMs = WORK_IDLE_MS, chatHoldMs = CHAT_HOLD_MS, log = (line) => console.log(line), apply = () => {} } = {}) {
  let steps = []; // [{ state, at }] from the last feed -- `at` parsed once per feed, not per frame
  let chatBusy = false;
  let chatEndedAt = null; // epoch ms of the last true->false turn edge; the chat half holds for chatHoldMs after it
  let working = false;

  const derive = (t) => chatBusy
    || (chatEndedAt != null && t - chatEndedAt < chatHoldMs) // S2: a turn end holds the signal on, so the panel cannot flicker
    || anyRunningStep(steps, t, idleMs);
  function publish() {
    const next = derive(now());
    if (next === working) return working;
    working = next;
    log(`[work] working=${next}`);
    try { apply(next); } catch (e) { console.error('work signal: apply failed', e); }
    return working;
  }

  return {
    get working() { return working; },
    /** A HUD feed arrived: keep every task row's step state + activity time. null / [] clears the board side (style
     *  Off, or a failed read), so working falls back to the chat signal (and its hold). */
    setFeed(updates) {
      steps = (Array.isArray(updates) ? updates : [])
        .map((u) => ({ state: u && u.stepState, at: Date.parse((u && u.at) || '') }))
        .filter((s) => Number.isFinite(s.at));
      return publish();
    },
    /** A chat turn is in flight. Called every frame from app.js, so this is also the clock that expires both the
     *  10-min board rule (no new feed arrives; the feed itself is polled every 20 s) and the S2 hold after a turn. */
    setChatBusy(on) {
      const next = Boolean(on);
      if (next !== chatBusy) {
        chatBusy = next;
        chatEndedAt = next ? null : now(); // a new turn cancels the old hold; a turn end starts one
      }
      return publish();
    },
    /** Re-derive against the clock alone, with no new feed and no new turn state (the 10-min and 10 s expiries). */
    update() { return publish(); },
  };
}
