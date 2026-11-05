// Native OS signals pushed by the Rust host (step 6-pre, F6). Electron reads these synchronously
// (powerMonitor.getSystemIdleTime(), the main window's visible flag, powerMonitor 'lock-screen'/'suspend'); an async rpc
// pull cannot serve those sync readers (the talk-mode scheduler's signals(), hud-host idleSeconds(), the board idle lock),
// so Rust PUSHES them as notifications (no id, no reply) and this module caches the latest value for sync reads.
//
//   __host.idle(sec)           every 1 s from GetLastInputInfo
//   __host.windowVisible(bool) from the same window_shell.rs hooks that emit `window:visible`, and once on every handshake
//   __host.osEvent(name)       'lock-screen' (WTS session lock) | 'suspend' (PBT_APMSUSPEND)
//
// Host-only: none of these names is in the renderer allow-list (scripts/check-tauri-allowlist.mjs). A value that is not the
// right shape is ignored, so the cache never holds a NaN or a negative idle time.

const OS_EVENTS = new Set(['lock-screen', 'suspend']);

export function createHostSignals() {
  let idle = 0; // seconds since the last user input; 0 until the host reports (= "the user is here")
  let visible = true; // Electron's `windowVisible` starts true
  const listeners = new Set();
  return {
    idleSeconds: () => idle,
    windowVisible: () => visible,
    /** Subscribe to OS events; returns the unsubscribe function. A listener that throws never breaks the others. */
    onOsEvent(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    handlers: {
      '__host.idle': (sec) => {
        if (typeof sec === 'number' && Number.isFinite(sec) && sec >= 0) idle = Math.floor(sec);
        return true;
      },
      '__host.windowVisible': (value) => {
        if (typeof value === 'boolean') visible = value;
        return true;
      },
      '__host.osEvent': (name) => {
        if (typeof name !== 'string' || !OS_EVENTS.has(name)) return false;
        for (const cb of [...listeners]) {
          try { cb(name); } catch { /* one subscriber must not stop the rest */ }
        }
        return true;
      },
    },
  };
}
