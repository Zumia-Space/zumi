// Pure decision function for main.js's `will-attach-webview` guard (no Electron import, so it is testable in plain
// Node -- scripts/check-webview-policy.mjs, and the Tauri sidecar runs it unchanged for its guest host).
//
// Exact-origin match ONLY -- a prefix match (`src.startsWith(origin)` without the
// trailing '/') would let `http://127.0.0.1:4212evil.example` pass for an origin `http://127.0.0.1:4212`.
function sameOrigin(src, origin) {
  return Boolean(origin) && (src === origin || src.startsWith(origin + '/'));
}

/**
 * @param {object} o
 * @param {string} o.src              the <webview>'s requested `src` (params.src in `will-attach-webview`)
 * @param {string} o.partition        the <webview>'s requested partition (params.partition)
 * @param {string|null} [o.boardOrigin]        local board origin, or null when not open
 * @param {string|null} [o.liveBridgeOrigin]   live-board bridge origin, or null when not in live mode
 * @param {string} [o.boardPartition]          default 'persist:zumi-board'
 * @param {string} [o.boardLivePartition]      default 'zumi-board-live'
 * @returns {{allow:boolean}}  a guest never gets a preload; main.js strips it on every attach
 */
export function decideWebviewAttach({
  src, partition,
  boardOrigin = null, liveBridgeOrigin = null,
  boardPartition = 'persist:zumi-board', boardLivePartition = 'zumi-board-live',
} = {}) {
  if (sameOrigin(src, liveBridgeOrigin)) return { allow: partition === boardLivePartition };
  if (sameOrigin(src, boardOrigin)) return { allow: partition === boardPartition };
  return { allow: false };
}
