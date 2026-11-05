// Board reader (T-31 board-aware, owner brief 07-10 + coordinator follow-up): the one place chat-brain.js goes to
// ask "what's on the board right now". Source order, same 60s cache either way:
//   1. the live bridge (board-live.mjs/board-bridge.mjs) — the owner already turned it on; never opens a new
//      connection, never flips live mode on, never unlocks anything. GET /api/v1/state is already in the
//      bridge's read-allowlist.
//   2. the owner build's local mirror (the owner's local-mirror.mjs), ONLY when the OWNER build's
//      packaged package.json carries `zumiBoardMirror` (main.js's BOARD_MIRROR, set by
//      scripts/builder-selftest.cjs's extraMetadata; the public build has no such field) AND that origin is
//      loopback http(s) — same loopback-only shape check board-live.mjs's assertAllowedUpstream uses. Exactly one
//      path is ever requested on it: GET <origin>/api/v1/state. This exists so the owner's own PC sees the board
//      without a PIN step; it is never reachable from a public build.
//   3. the honest "can't see the board" reason — never silence, never invented.
// Read-only throughout: no write op exists in this module's vocabulary at all.
// Privacy (CoS decision 07-10): whichever source answers, the digest is built through `getRedact()` — by default
// every name on the owner's redact list (board-redact.mjs) is masked before the text ever reaches chat-brain.js.
import { buildBoardDigest, unavailableDigestText } from './board-digest.mjs';

export const REFRESH_MS = 60_000;
const FETCH_TIMEOUT_MS = 8000;
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost']);

/** `raw` (e.g. "http://127.0.0.1:3100") -> its normalized origin, or null when missing/malformed/not loopback
 *  http(s). Mirrors board-live.mjs's assertAllowedUpstream loopback check — same two hostnames, same protocols. */
function allowedMirrorOrigin(raw, log) {
  if (!raw) return null;
  let u;
  try { u = new URL(raw); } catch { log(`board-reader: zumiBoardMirror is not a valid URL, ignoring: ${raw}`); return null; }
  if (!LOOPBACK_HOSTNAMES.has(u.hostname) || (u.protocol !== 'http:' && u.protocol !== 'https:')) {
    log(`board-reader: zumiBoardMirror refused (not loopback http/https): ${raw}`);
    return null;
  }
  return u.origin;
}

/**
 * @param {object} o
 * @param {{status():{mode:string,configured:boolean,locked:boolean,authRejected?:boolean}, bridgePort():Promise<number|null>, bridgeHeaders():Promise<object>}} o.liveBoard
 * @param {string|null} [o.mirrorOrigin]  the owner build's package.json `zumiBoardMirror`, or null (public build)
 * @param {typeof fetch} [o.fetchImpl]
 * @param {() => number} [o.now]
 * @param {(msg:string) => void} [o.log]  never passed a secret or the raw board state
 * @param {() => {sendClientNames: boolean, names: string[], mask?: string}} [o.getRedact]  CoS privacy decision
 *   07-10: called fresh on every refresh (the owner's toggle/list can change without restarting the app). Default:
 *   nothing to redact (same digest as before this existed). `sendClientNames: true` turns redaction OFF entirely.
 */
export function createBoardReader({
  liveBoard, mirrorOrigin = null, fetchImpl = fetch, now = Date.now, log = () => {},
  getRedact = () => ({ sendClientNames: false, names: [] }),
}) {
  const mirror = allowedMirrorOrigin(mirrorOrigin, log);
  let cache = null; // { ok, digest, reason, builtAt }
  let inflight = null;

  async function getJson(url, headers = {}) {
    try {
      const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) return { ok: false, reason: `http_${res.status}` };
      return { ok: true, state: await res.json() };
    } catch (e) {
      const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
      return { ok: false, reason: timeout ? 'timeout' : 'offline' };
    }
  }

  /** Source 1: the live bridge. Never throws. Short-circuits before any network call whenever liveBoard.status()
   *  already says no (saves a bridgePort()/fetch round trip, and gives a precise reason). */
  async function fetchFromBridge() {
    const st = liveBoard.status();
    if (!st.configured) return { ok: false, reason: 'unconfigured' };
    if (st.locked) return { ok: false, reason: 'locked' };
    if (st.authRejected) return { ok: false, reason: 'auth_rejected' }; // the board refused this sign-in: no retry until it changes (board-live.mjs)
    if (st.mode !== 'live') return { ok: false, reason: 'not_live' }; // secrets fine, owner just hasn't switched the toggle
    const port = await liveBoard.bridgePort();
    if (!port) return { ok: false, reason: 'not_live' }; // mode flipped back between status() and here
    return getJson(`http://127.0.0.1:${port}/api/v1/state`, await liveBoard.bridgeHeaders());
  }

  /** Source 2: the owner build's local mirror. Exactly one path, the allowlisted origin only. */
  async function fetchFromMirror() { return getJson(`${mirror}/api/v1/state`); }

  /** Tries each source in order; the first ok wins. Never throws. */
  async function fetchState() {
    const bridge = await fetchFromBridge();
    if (bridge.ok) return bridge;
    if (!mirror) return bridge; // public build, or an owner build with no/invalid mirror configured: unchanged
    log(`board-reader: bridge unavailable (${bridge.reason}), trying the local mirror`);
    return fetchFromMirror();
  }

  async function refresh() {
    const r = await fetchState();
    const redact = getRedact() || { sendClientNames: false, names: [] };
    const digestOpts = redact.sendClientNames ? {} : { redact: { names: redact.names, mask: redact.mask || '[client]' } };
    cache = r.ok
      ? { ok: true, digest: buildBoardDigest(r.state, now(), digestOpts), state: r.state, builtAt: now() }
      : { ok: false, reason: r.reason, builtAt: now() };
    log(cache.ok ? `board-reader: refreshed, ${cache.digest.taskCount} task(s), ${cache.digest.waitingCount} waiting on owner`
      : `board-reader: unavailable (${cache.reason})`);
    return cache;
  }

  /** The text block chat-brain prepends to a turn: a real digest, or an honest "can't see it" line. Never throws. */
  async function getDigestText({ force = false } = {}) {
    const fresh = cache && now() - cache.builtAt < REFRESH_MS;
    if (force || !fresh) {
      if (!inflight) inflight = refresh().finally(() => { inflight = null; });
      await inflight;
    }
    if (!cache) return unavailableDigestText('not read yet');
    return cache.ok ? cache.digest.text : unavailableDigestText(cache.reason);
  }

  /** The raw state for the talk-camera HUD (hud-host.mjs; local display only, never sent to a model, so no
   *  redaction). Same sources and the same cache as the digest; refreshed when older than maxAgeMs. Never throws.
   *  -> { ok: true, state } | { ok: false, reason } */
  async function getState({ maxAgeMs = REFRESH_MS } = {}) {
    if (!cache || now() - cache.builtAt >= maxAgeMs) {
      if (!inflight) inflight = refresh().finally(() => { inflight = null; });
      await inflight;
    }
    return cache && cache.ok ? { ok: true, state: cache.state } : { ok: false, reason: cache ? cache.reason : 'not read yet' };
  }

  return { getDigestText, getState, _test: { fetchState, fetchFromBridge, fetchFromMirror, mirror } };
}
