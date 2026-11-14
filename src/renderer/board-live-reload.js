// The Board tab's Reload in live mode (T-31 bridge self-heal, owner report 14-11). Reload used to re-load the origin the
// tab first got, so once the loopback bridge died and came back on a new port, Reload could only fail. It now asks the
// host first (board.liveOpen, which also replaces a dead bridge) and decides with the answer:
//   - same origin: reload in place through the fresh single-use session URL (a restarted bridge has a new caller secret);
//   - another origin: a new board guest (the Tauri guest is pinned to the origin it opened with, guest.rs guest_navigate);
//   - an error: shown, nothing loaded.
/**
 * @param {{liveOpen: () => Promise<{origin?:string, openUrl?:string, error?:string}|null>, currentOrigin: string|null}} o
 * @returns {Promise<{action:'navigate', url:string} | {action:'reopen', r:object} | {action:'fail', error:string|null}>}
 */
export async function planLiveReload({ liveOpen, currentOrigin }) {
  const r = await liveOpen();
  if (!r || r.error || !r.origin) return { action: 'fail', error: (r && r.error) || null };
  if (r.origin === currentOrigin) return { action: 'navigate', url: r.openUrl || `${r.origin}/` };
  return { action: 'reopen', r };
}
