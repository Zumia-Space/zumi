//! P2 kill switch: the stop hotkey, the killed state and key release, in one place.
//!
//! The hotkey is Ctrl+Alt+Pause through RegisterHotKey (no keyboard hook). With Ctrl held, the Pause key reports
//! VK_CANCEL (Ctrl+Break), so the physical chord is registered as Ctrl+Alt+VK_CANCEL; Ctrl+Alt+VK_PAUSE is registered
//! too (software sending VK_PAUSE). Either kills acting for the life of the process, releases all modifier keys and
//! hides the overlay. The moment of the kill and the form that fired are kept for the audit log and the goal check.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::Duration;
use windows::Win32::UI::Input::KeyboardAndMouse::*;
use windows::Win32::UI::WindowsAndMessaging::{GetMessageW, MSG, WM_HOTKEY};

const HOTKEY_ID_CANCEL: i32 = 0x5A31;
const HOTKEY_ID_PAUSE: i32 = 0x5A32;

static KILLED: AtomicBool = AtomicBool::new(false);
static REGISTERED: AtomicBool = AtomicBool::new(false);
static KILL_INFO: Mutex<Option<(u128, &'static str)>> = Mutex::new(None);

pub fn unix_ms() -> u128 {
    zumi_audit::unix_ms()
}

pub fn is_killed() -> bool {
    KILLED.load(Ordering::SeqCst)
}

pub fn hotkey_registered() -> bool {
    REGISTERED.load(Ordering::SeqCst)
}

/// (unix ms, "cancel" | "pause" | "verb") of the first kill.
pub fn kill_info() -> Option<(u128, &'static str)> {
    *KILL_INFO.lock().unwrap_or_else(|p| p.into_inner())
}

/// Kill now: from the hotkey thread or the `kill` verb.
pub fn kill(by: &'static str) {
    KILLED.store(true, Ordering::SeqCst);
    let at = *KILL_INFO.lock().unwrap_or_else(|p| p.into_inner()).get_or_insert((unix_ms(), by));
    release_all_keys();
    release_mouse();
    crate::hands_overlay::hide();
    crate::act::record_kill(by, at.0);
}

/// Registers both forms of the hotkey on a thread of their own (idempotent). False if either cannot be registered;
/// then neither is kept.
pub fn start_hotkey() -> bool {
    if hotkey_registered() {
        return true;
    }
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        // SAFETY: RegisterHotKey binds to this thread's message queue; GetMessageW pumps only this thread.
        unsafe {
            let mods = MOD_CONTROL | MOD_ALT | MOD_NOREPEAT;
            let a = RegisterHotKey(None, HOTKEY_ID_CANCEL, mods, VK_CANCEL.0 as u32).is_ok();
            let b = RegisterHotKey(None, HOTKEY_ID_PAUSE, mods, VK_PAUSE.0 as u32).is_ok();
            if !(a && b) {
                if a {
                    let _ = UnregisterHotKey(None, HOTKEY_ID_CANCEL);
                }
                if b {
                    let _ = UnregisterHotKey(None, HOTKEY_ID_PAUSE);
                }
                let _ = tx.send(false);
                return;
            }
            let _ = tx.send(true);
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                let id = msg.wParam.0 as i32;
                if msg.message == WM_HOTKEY && (id == HOTKEY_ID_CANCEL || id == HOTKEY_ID_PAUSE) {
                    kill(if id == HOTKEY_ID_CANCEL { "cancel" } else { "pause" });
                }
            }
        }
    });
    let ok = rx.recv_timeout(Duration::from_secs(2)).unwrap_or(false);
    REGISTERED.store(ok, Ordering::SeqCst);
    ok
}

fn key_up(vk: VIRTUAL_KEY) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: vk, wScan: 0, dwFlags: KEYEVENTF_KEYUP, time: 0, dwExtraInfo: 0 } },
    }
}

static MOUSE_DOWN: AtomicBool = AtomicBool::new(false);

fn mouse_input(flags: MOUSE_EVENT_FLAGS) -> INPUT {
    INPUT { r#type: INPUT_MOUSE, Anonymous: INPUT_0 { mi: MOUSEINPUT { dx: 0, dy: 0, mouseData: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 } } }
}

/// R5: presses the left button and remembers it, so any abort or the kill can let it go.
pub fn press_left() -> bool {
    MOUSE_DOWN.store(true, Ordering::SeqCst);
    // SAFETY: a fully initialised INPUT; SendInput copies it.
    unsafe { SendInput(&[mouse_input(MOUSEEVENTF_LEFTDOWN)], std::mem::size_of::<INPUT>() as i32) == 1 }
}

/// R5: lets the left button go if THIS helper pressed it (a stray button-up is never sent otherwise).
pub fn release_mouse() {
    if MOUSE_DOWN.swap(false, Ordering::SeqCst) {
        // SAFETY: a fully initialised INPUT; SendInput copies it.
        let _ = unsafe { SendInput(&[mouse_input(MOUSEEVENTF_LEFTUP)], std::mem::size_of::<INPUT>() as i32) };
    }
}

/// Key-up for every modifier, sent on any abort and on the kill (harmless for keys that are not down).
pub fn release_all_keys() {
    let ups: Vec<INPUT> = [VK_SHIFT, VK_CONTROL, VK_MENU, VK_LWIN, VK_RWIN].into_iter().map(key_up).collect();
    // SAFETY: a fully initialised INPUT array; SendInput copies it.
    let _ = unsafe { SendInput(&ups, std::mem::size_of::<INPUT>() as i32) };
}
