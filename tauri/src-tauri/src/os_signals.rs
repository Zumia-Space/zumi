// T-31 step 6-pre (F6) — native OS signals pushed from Rust to the sidecar.
//
// Electron reads three things SYNCHRONOUSLY: `powerMonitor.getSystemIdleTime()`, the main window's visible flag and the
// powerMonitor `lock-screen` / `suspend` events (main.js:2062-2126). The Electron-free modules the sidecar reuses
// (talk-mode scheduler `signals()`, hud-host `idleSeconds()`, the board idle lock) call them in the same sync way, and an
// async rpc pull cannot serve a sync caller. So the host PUSHES them as JSON-RPC notifications (no id, no reply) and
// tauri/sidecar/host-signals.mjs caches the latest value:
//
//   __host.idle(sec)           every second, from GetLastInputInfo
//   __host.windowVisible(bool) whenever window_shell.rs emits `window:visible`, and again on every sidecar handshake
//   __host.osEvent(name)       'lock-screen' (WM_WTSSESSION_CHANGE / WTS_SESSION_LOCK) | 'suspend' (PBT_APMSUSPEND)
//
// None of these names is in the renderer allow-list, so the page can neither send nor read them. A notification is
// dropped (never queued) while the sidecar is not ready: the next tick or the handshake re-push supplies the value.

use std::sync::Mutex;
use std::time::Duration;

use serde_json::json;
use tauri::{AppHandle, Manager};

use crate::Rpc;

/// How often the idle time is pushed.
const IDLE_PERIOD: Duration = Duration::from_secs(1);

// The two window messages and their wParam values (winuser.h / wtsapi32.h). Local constants so the mapping is a pure
// function, testable on every platform.
pub(crate) const WM_POWERBROADCAST: u32 = 0x0218;
pub(crate) const WM_WTSSESSION_CHANGE: u32 = 0x02B1;
const PBT_APMSUSPEND: usize = 0x0004;
const WTS_SESSION_LOCK: usize = 0x0007;

/// The last `window:visible` value, kept so a restarted sidecar learns the current state at its handshake.
#[derive(Default)]
pub struct OsSignals {
    visible: Mutex<Option<bool>>,
}

/// The sidecar-facing name of an OS window message, or `None` for every message / wParam we do not forward.
pub(crate) fn os_event_for(msg: u32, wparam: usize) -> Option<&'static str> {
    match (msg, wparam) {
        (WM_WTSSESSION_CHANGE, WTS_SESSION_LOCK) => Some("lock-screen"),
        (WM_POWERBROADCAST, PBT_APMSUSPEND) => Some("suspend"),
        _ => None,
    }
}

/// Whole seconds between the last input tick and now. Both are GetTickCount-style 32-bit millisecond counters that wrap
/// every ~49.7 days, so the difference is a wrapping subtraction.
pub(crate) fn idle_seconds(last_input_tick: u32, now_tick: u32) -> u64 {
    u64::from(now_tick.wrapping_sub(last_input_tick)) / 1000
}

/// Send one notification to the sidecar; dropped when it is not ready.
fn notify(app: &AppHandle, method: &str, params: Vec<serde_json::Value>) {
    if let Some(rpc) = app.try_state::<Rpc>() {
        rpc.notify(method, params);
    }
}

/// The main window's visibility changed (called from window_shell.rs next to the `window:visible` emit).
pub fn push_visible(app: &AppHandle, visible: bool) {
    if let Some(state) = app.try_state::<OsSignals>() {
        *state.visible.lock().unwrap() = Some(visible);
    }
    notify(app, "__host.windowVisible", vec![json!(visible)]);
}

/// A sidecar finished its handshake: it starts with Electron's defaults, so hand it the real visibility if we know it.
pub fn on_sidecar_ready(app: &AppHandle) {
    let known = app.try_state::<OsSignals>().and_then(|s| *s.visible.lock().unwrap());
    if let Some(visible) = known {
        notify(app, "__host.windowVisible", vec![json!(visible)]);
    }
}

/// Forward an OS event the window subclass saw.
pub fn push_os_event(app: &AppHandle, name: &str) {
    notify(app, "__host.osEvent", vec![json!(name)]);
}

/// Push the idle time once a second for the life of the process. The thread ends with the process.
pub fn start_idle_ticker(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(IDLE_PERIOD);
        if let Some(sec) = system_idle_seconds() {
            notify(&app, "__host.idle", vec![json!(sec)]);
        }
    });
}

#[cfg(windows)]
fn system_idle_seconds() -> Option<u64> {
    use windows_sys::Win32::System::SystemInformation::GetTickCount;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
    let mut info = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
    // SAFETY: `info` is a valid LASTINPUTINFO with cbSize set, as GetLastInputInfo requires.
    if unsafe { GetLastInputInfo(&mut info) } == 0 {
        return None;
    }
    // SAFETY: no arguments, no preconditions.
    Some(idle_seconds(info.dwTime, unsafe { GetTickCount() }))
}

#[cfg(not(windows))]
fn system_idle_seconds() -> Option<u64> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_session_lock_and_a_suspend_are_forwarded() {
        assert_eq!(os_event_for(WM_WTSSESSION_CHANGE, WTS_SESSION_LOCK), Some("lock-screen"));
        assert_eq!(os_event_for(WM_POWERBROADCAST, PBT_APMSUSPEND), Some("suspend"));
        // WTS_SESSION_UNLOCK (8), WTS_SESSION_LOGON (5), PBT_APMRESUMEAUTOMATIC (0x12), PBT_APMRESUMESUSPEND (7): not forwarded.
        for (msg, wparam) in [(WM_WTSSESSION_CHANGE, 8), (WM_WTSSESSION_CHANGE, 5), (WM_POWERBROADCAST, 0x12), (WM_POWERBROADCAST, 7)] {
            assert_eq!(os_event_for(msg, wparam), None, "{msg:#x}/{wparam}");
        }
        // The same wParam on another message is not an event (7 is a lock only inside WM_WTSSESSION_CHANGE).
        assert_eq!(os_event_for(WM_POWERBROADCAST, WTS_SESSION_LOCK), None);
        assert_eq!(os_event_for(0x0001, PBT_APMSUSPEND), None);
    }

    #[test]
    fn idle_is_whole_seconds_and_survives_the_tick_counter_wrap() {
        assert_eq!(idle_seconds(1_000, 1_000), 0);
        assert_eq!(idle_seconds(1_000, 1_999), 0);
        assert_eq!(idle_seconds(1_000, 4_500), 3);
        // The counter wrapped between the last input and now: 2 s before the wrap + 3 s after = 5 s.
        assert_eq!(idle_seconds(u32::MAX - 1_999, 3_000), 5);
    }
}
