// The Board tab's live watch (T-31 bridge self-heal 2, field report 14-11: the tab lost its connection again).
// The tab used to ask the host for the bridge once, when it opened; after that only a Reload click asked again. So a
// sidecar the host had restarted (a fresh process: no bridge until someone asks, the old port gone) or a bridge that came
// back on a new port left the tab on a dead origin for good. app.js now runs this every few seconds while the tab shows a
// live board, and at once on sidecar-ready, and acts on the answer:
//   - render:   the host is not live, locked (sleep/idle lock) or refused the sign-in: the tab's own card/overlay;
//   - reopen:   the bridge is on another origin: a new guest there (the Tauri guest is pinned to its origin);
//   - navigate: same origin, but the page loaded through the last session URL never got its board (it booted while the
//               upstream was down, and the vendored page polls only once it has one): reload it in place, after a grace;
//   - none:     the page is fine, or the host cannot give a port right now (asked again next tick).
export const UNFED_GRACE_MS = 20_000;

/**
 * @param {{status: object|null, open: {origin?:string, openUrl?:string, fed?:boolean, error?:string}|null,
 *          currentOrigin: string|null, openedAt: number, now: number}} o
 * @returns {{action:'render'} | {action:'reopen', r:object} | {action:'navigate', url:string} | {action:'none'}}
 */
export function decideLiveWatch({ status, open, currentOrigin, openedAt, now }) {
  if (!status || status.mode !== 'live' || status.locked || status.authRejected === true) return { action: 'render' };
  if (!open || open.error || !open.origin) return { action: 'none' };
  if (open.origin !== currentOrigin) return { action: 'reopen', r: open };
  if (open.fed === false && now - openedAt >= UNFED_GRACE_MS) return { action: 'navigate', url: open.openUrl || `${open.origin}/` };
  return { action: 'none' };
}

// A live guest's did-fail-load (field report 14-11: ERR_CONNECTION_ABORTED while the bridge was ALIVE; the likely cause, a
// loopback filter or a reused keep-alive socket, is outside the app): any failed main-frame load except -3 (aborted by a
// newer navigation) asks the host again (board.liveOpen) and rebuilds the guest on the origin it returns, same port or
// new. Retries back off 1, 2, 4, 8, 8, 8 s, then (gate S-b: an outage longer than ~31 s left the tab dead until Reload)
// go on every 30 s until a load finishes. A retry that finds the tab hidden or the guest gone (`active()` false) makes no
// host call and parks; `resume()` (the live watch, once the tab is on screen again) picks it up.
export const FAIL_LOAD_BACKOFF = { baseMs: 1_000, maxMs: 8_000, maxAttempts: 6, slowMs: 30_000 };

/**
 * @param {{liveOpen: () => Promise<object|null>, rebuild: (r: object) => void, setTimer?: (fn: Function, ms: number) => unknown,
 *          active?: () => boolean, baseMs?: number, maxMs?: number, maxAttempts?: number, slowMs?: number}} o
 * @returns {{onFail: (code: number|null) => boolean, onLoaded: () => void, resume: () => void}}  onFail: true when a retry was scheduled
 */
export function createFailLoadRecovery({ liveOpen, rebuild, setTimer = setTimeout, active = () => true, baseMs = FAIL_LOAD_BACKOFF.baseMs, maxMs = FAIL_LOAD_BACKOFF.maxMs, maxAttempts = FAIL_LOAD_BACKOFF.maxAttempts, slowMs = FAIL_LOAD_BACKOFF.slowMs }) {
  let attempts = 0, pending = false, parked = false;
  function onFail(code) {
    if (code === -3 || pending) return false;
    const delay = attempts < maxAttempts ? Math.min(baseMs * 2 ** attempts, maxMs) : slowMs;
    attempts++;
    pending = true;
    parked = false;
    setTimer(async () => {
      pending = false;
      if (!active()) { parked = true; return; }
      let r = null;
      try { r = await liveOpen(); } catch (e) { r = { error: String((e && e.message) || e) }; } // the sidecar may be restarting
      if (r && !r.error && r.origin) rebuild(r); else onFail(null);
    }, delay);
    return true;
  }
  return {
    onFail,
    onLoaded() { attempts = 0; parked = false; },
    resume() { if (parked) onFail(null); },
  };
}
