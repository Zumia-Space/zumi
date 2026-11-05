// T-31 parity step 9-2: the sidecar -> Rust host request channel.
//
// Until this step every JSON-RPC request went host -> sidecar. The HUD's consent answer needs the opposite:
// `hud-host.mjs` (frozen) hands an open decision to its `open` seam, and only Rust may run ShellExecuteW. The
// sidecar therefore sends one request line on stdout and waits for the host's response on stdin.
//
// The channel is deliberately tiny:
//   - ids are strings (`sc-<n>`), so they can never be mistaken for the host's numeric request ids;
//   - a message with a `method` is a request (never a response) and is left to the sidecar's dispatcher;
//   - a message with an `id` and no `method` is the host's response;
//   - every call has a deadline, so a dead or wedged host never hangs a renderer call.
// What the host may be asked is fixed on the Rust side (only `__sidecarHost.shell.*`), and every path is
// re-validated there: this module is transport only.

// Longer than Rust's 10 s open deadline: a timed-out shell job is cancelled on the host side, so the sidecar
// must never give up so early that it reports a failure while the host is still finishing the same attempt.
export const HOST_CALL_TIMEOUT_MS = 15_000;

/**
 * @param {(frame: object) => void} write  the sidecar's NDJSON writer (`writeLine` in main.mjs)
 * @param {{timeoutMs?: number, log?: (m: string) => void}} [o]
 * @returns {{call: (method: string, params?: unknown[]) => Promise<unknown>, settle: (msg: object) => boolean,
 *            rejectAll: (reason: string) => void, pendingCount: () => number}}
 */
export function createHostCalls(write, { timeoutMs = HOST_CALL_TIMEOUT_MS, log = () => {} } = {}) {
  const pending = new Map();
  let seq = 0;

  function call(method, params = []) {
    return new Promise((resolve, reject) => {
      const id = `sc-${++seq}`;
      const timer = setTimeout(() => {
        if (!pending.delete(id)) return;
        log(`[sidecar] host call timed out: ${method}`);
        reject(new Error('host_timeout'));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer, method });
      try {
        write({ jsonrpc: '2.0', id, method, params });
      } catch (e) {
        clearTimeout(timer);
        pending.delete(id);
        reject(e);
      }
    });
  }

  /** Resolve/reject one host response. Returns false when `msg` is not a response (a request or a push). */
  function settle(msg) {
    if (!msg || typeof msg !== 'object') return false;
    if (typeof msg.method === 'string') return false;
    if (!Object.prototype.hasOwnProperty.call(msg, 'id')) return false;
    const p = pending.get(msg.id);
    if (!p) return false;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) {
      const reason = msg.error && typeof msg.error.message === 'string' ? msg.error.message : 'host_error';
      p.reject(new Error(reason));
    } else {
      p.resolve(msg.result === undefined ? null : msg.result);
    }
    return true;
  }

  function rejectAll(reason) {
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
      pending.delete(id);
    }
  }

  return { call, settle, rejectAll, pendingCount: () => pending.size };
}
