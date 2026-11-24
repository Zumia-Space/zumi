// The room guest's REAL page, booted (check-room-live-real.mjs). The guest target is listed with the pack URL before WebView2 has swapped
// its first document for the page (and a host-side reload swaps it again), so an evaluate sent then died with "Execution context was
// destroyed" (the live/a3/zt3d/rbar harness failures, on alpha.7.1 and alpha.9 alike). Now the ready marker is evaluated only in a document
// whose own location is the pack page, and a context that goes away under it is retried on a fresh connection to the current target, never
// reported as a test failure.
export const GUEST_PAGE = 'http://zumipack.localhost/plugin.room-preview/ui/index.html';
export const CONTEXT_GONE = /Execution context was destroyed|Cannot find context with specified id|Inspected target navigated or closed|ws connect failed/;
// A reload in place aborts the fetches of the document it replaces, and that document, still alive for a moment, rejects its boot
// ("THREE.GLTFLoader: Failed to load buffer", T31reload run red1) while the new document boots fine. So a rejected boot is held for
// SWAP_GRACE_MS: a document being replaced dies inside it (CONTEXT_GONE, retried on the new document); one still there really failed.
export const SWAP_GRACE_MS = 2000;
export const GUEST_BOOT = `(async () => { if (!location.href.startsWith(${JSON.stringify(GUEST_PAGE)})) return { page: false, href: location.href };
  for (let i = 0; i < 1800 && !window.__room; i++) await new Promise((r) => setTimeout(r, 100));
  try { const r = await window.__room.ready; return { page: true, ok: true, gpu: r.gpu, marks: r.marks }; } catch (e) { await new Promise((r) => setTimeout(r, ${SWAP_GRACE_MS})); return { page: true, ok: false, err: String(e) }; } })()`;

/** The guest showed its page, and the page's own boot (`window.__room.ready`) rejected. Carries the boot facts and the live connection. */
export class GuestBootError extends Error {
  constructor(boot, guest) {
    super(`guest boot failed: ${boot.err} (after ${boot.retries} retries)`);
    this.name = 'GuestBootError';
    this.boot = boot;
    this.guest = guest;
  }
}

/**
 * Resolves only for a booted page; a page whose boot rejected throws GuestBootError (callers must not go on with a dead room).
 * @param {object} o
 * @param {(timeoutMs: number) => Promise<{evaluate: Function, close: Function}>} o.connectGuest a fresh connection to the current guest target
 * @param {number} [o.timeoutMs]
 * @param {(ms: number) => Promise<void>} o.sleep
 * @param {(line: string) => void} [o.log]
 * @returns {Promise<{guest: object, boot: {page: true, ok: true, gpu: string, marks: object, retries: number}}>}
 */
export async function guestReady({ connectGuest, timeoutMs = 240000, sleep, log = console.log }) {
  const end = Date.now() + timeoutMs;
  let retries = 0, lastWhy = '';
  for (;;) {
    const left = () => Math.max(1000, end - Date.now());
    let guest = null;
    try {
      guest = await connectGuest(left());
      const boot = await guest.evaluate(GUEST_BOOT, { timeoutMs: left() });
      if (boot.page) {
        if (retries) log(`guest page ready after ${retries} retr${retries > 1 ? 'ies' : 'y'} (${lastWhy})`);
        if (!boot.ok) throw new GuestBootError({ ...boot, retries }, guest);
        return { guest, boot: { ...boot, retries } };
      }
      lastWhy = `not the page yet: ${boot.href}`;
    } catch (e) {
      if (e instanceof GuestBootError || !CONTEXT_GONE.test(String(e && e.message)) || Date.now() > end) throw e;
      lastWhy = String(e.message).split('\n')[0];
    }
    if (guest) guest.close();
    if (Date.now() > end) throw new Error(`the guest never showed its page within ${timeoutMs} ms`);
    retries++;
    await sleep(300);
  }
}
