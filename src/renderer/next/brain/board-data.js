// Brain's only door to the task board (T-31 slice 3, PLAN-SLICE3-BRAIN section 2; the host calls are slice 3a-3, GATE-SEC-3a-3). Read-only:
//   zumi.board.state()            -> { ok:true, state } | { ok:false, reason }                      the board's 11-key projection (host: board-reads.mjs)
//   zumi.board.media(id, { w })   -> { ok:true, mime, bytes } | { ok:false, reason }                 an image attachment, w = 480 (thumbnail) or 1600 (lightbox)
//   zumi.board.openRef({kind,target}) -> { opened:true } | { opened:false, reason }                  a link or file the board's own text cites, owner build only
// A build that has none of them (a release build without the next-version UI, or a host that does not carry them) answers
// { ok:false, reason:'unconfigured' }: the library shows the honest reason card. There is no fallback data in this file.
// state reasons: unconfigured | locked | not_live | auth_rejected | offline | timeout | too_large | http_<status> | bad_state.
// media reasons add: bad_id | bad_width | busy | rate_limited | unknown_attachment | not_image | bad_image. Never a URL, a port or a path.
let devSource = null;
let devMedia = null;

/** Dev-run seams for screenshots (exposed on window.__zumiNext only when the app is not packaged, see boot.js): a function that returns the same
 *  shape as the host call it replaces. Never installed in a packaged build, never called by shipped code. */
export function setDevSource(fn) { devSource = typeof fn === 'function' ? fn : null; }
export function setDevMedia(fn) { devMedia = typeof fn === 'function' ? fn : null; }

const hostCall = (name) => (window.zumi && window.zumi.board && typeof window.zumi.board[name] === 'function' ? (...a) => window.zumi.board[name](...a) : null);

/** -> { ok:true, state } | { ok:false, reason }. Never throws, never invents a state. */
export async function getBoardState() {
  const source = devSource || hostCall('state');
  if (!source) return { ok: false, reason: 'unconfigured' };
  let res;
  try { res = await source(); } catch (e) { return { ok: false, reason: 'offline' }; } // the call itself failed: the board cannot be read
  if (!res || typeof res !== 'object') return { ok: false, reason: 'bad_state' };
  if (res.ok === false) return { ok: false, reason: typeof res.reason === 'string' && res.reason ? res.reason : 'bad_state' };
  if (!res.state || !Array.isArray(res.state.tasks)) return { ok: false, reason: 'bad_state' };
  return { ok: true, state: res.state };
}

/** One image attachment: -> { ok:true, mime, bytes: Uint8Array } | { ok:false, reason }. Never throws. `w` is 480 or 1600 (the host refuses anything else). */
export async function getBoardMedia(id, w) {
  const source = devMedia || hostCall('media');
  if (!source) return { ok: false, reason: 'unconfigured' };
  let res;
  try { res = await source(id, { w }); } catch (e) { return { ok: false, reason: 'offline' }; }
  if (!res || typeof res !== 'object') return { ok: false, reason: 'bad_state' };
  if (res.ok === true && typeof res.mime === 'string' && res.bytes && typeof res.bytes.byteLength === 'number' && res.bytes.byteLength > 0) return { ok: true, mime: res.mime, bytes: res.bytes };
  return { ok: false, reason: res.ok === false && typeof res.reason === 'string' && res.reason ? res.reason : 'bad_state' };
}

/** Asks the host to open a link or file that a task's own text cites. `ref` is { kind, target } with the target copied verbatim from refs.js.
 *  -> { opened:true } | { opened:false, reason }. Never throws. */
export async function openBoardRef(ref) {
  const call = hostCall('openRef');
  if (!call) return { opened: false, reason: 'unconfigured' };
  let res;
  try { res = await call({ kind: ref && ref.kind, target: ref && ref.target }); } catch (e) { return { opened: false, reason: 'offline' }; }
  if (res && res.opened === true) return { opened: true };
  return { opened: false, reason: res && typeof res.reason === 'string' && res.reason ? res.reason : 'bad_state' };
}

const KNOWN = new Set(['unconfigured', 'locked', 'not_live', 'auth_rejected', 'offline', 'timeout', 'bad_state', 'too_large', 'busy', 'rate_limited']);
/** The i18n key of the reason text, and its variables. http_<n> has its own line; anything else is the generic one. */
export function reasonKey(reason) {
  const r = String(reason || '');
  if (KNOWN.has(r)) return { key: `brain.reason.${r}`, vars: {} };
  const http = /^http_(\d{3})$/.exec(r);
  if (http) return { key: 'brain.reason.http', vars: { code: http[1] } };
  return { key: 'brain.reason.other', vars: { reason: r || 'unknown' } };
}
