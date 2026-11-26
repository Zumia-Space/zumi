//! Push-to-talk: a global hotkey (RegisterHotKey), as upstream's `talk-shortcut` / `talk-keys` (Electron `globalShortcut`).
//! The three chords are upstream's, by upstream's ids (`ctrl-opt-space` is Control+Alt+Space on Windows).
//!
//! RegisterHotKey tells us when the chord goes DOWN, not when it comes UP, so the thread that owns the registration also
//! watches the keys (GetAsyncKeyState) while it is held: the hold ends when any key of the chord is released, as upstream
//! finishes on the modifiers' release. The OS repeat of a held key is not another press (MOD_NOREPEAT).
//!
//! The callback runs on the hotkey thread: it must return quickly (`Dictation::on_hotkey` does).
use crate::SttError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HotkeyEvent {
    Press,
    Release,
}

/// Win32 `MOD_*` bits (Alt 1, Control 2, Shift 4, Win 8) and a virtual-key code.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Chord {
    pub id: &'static str,
    pub label: &'static str,
    pub mods: u32,
    pub vk: u32,
}

pub const DEFAULT_KEY: &str = "ctrl-opt-space";

const MOD_ALT: u32 = 1;
const MOD_CONTROL: u32 = 2;
const MOD_SHIFT: u32 = 4;
const VK_SPACE: u32 = 0x20;

const CHORDS: [Chord; 3] = [
    Chord { id: "ctrl-opt-space", label: "Ctrl+Alt+Space", mods: MOD_CONTROL | MOD_ALT, vk: VK_SPACE },
    Chord { id: "ctrl-shift-space", label: "Ctrl+Shift+Space", mods: MOD_CONTROL | MOD_SHIFT, vk: VK_SPACE },
    Chord { id: "opt-shift-space", label: "Alt+Shift+Space", mods: MOD_ALT | MOD_SHIFT, vk: VK_SPACE },
];

/// The chords the settings offer.
pub fn chords() -> &'static [Chord] {
    &CHORDS
}

pub fn chord(id: &str) -> Option<Chord> {
    CHORDS.iter().find(|c| c.id == id).copied()
}

/// A registered hotkey. Dropping it unregisters the chord.
pub struct Hotkey {
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Drop for Hotkey {
    fn drop(&mut self) {
        self.stop.store(true, std::sync::atomic::Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

#[cfg(windows)]
impl Hotkey {
    /// `stt_hotkey_taken` when another program (or another registration of ours) holds the chord.
    pub fn register(chord: Chord, on: impl Fn(HotkeyEvent) + Send + 'static) -> Result<Hotkey, SttError> {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::{mpsc, Arc};
        use std::time::Duration;
        use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, RegisterHotKey, UnregisterHotKey, HOT_KEY_MODIFIERS, MOD_NOREPEAT};
        use windows::Win32::UI::WindowsAndMessaging::{PeekMessageW, MSG, PM_REMOVE, WM_HOTKEY};

        /// ERROR_HOTKEY_ALREADY_REGISTERED as an HRESULT.
        const TAKEN: i32 = 0x8007_0581_u32 as i32;
        const ID: i32 = 1;
        let down = |vk: u32| unsafe { GetAsyncKeyState(vk as i32) } as u16 & 0x8000 != 0;
        let chord_down = move || {
            let mods = [(MOD_ALT, 0x12), (MOD_CONTROL, 0x11), (MOD_SHIFT, 0x10), (8, 0x5B)];
            down(chord.vk) && mods.iter().all(|(bit, vk)| chord.mods & bit == 0 || down(*vk))
        };

        let stop = Arc::new(AtomicBool::new(false));
        let (told, hear) = mpsc::channel::<Result<(), SttError>>();
        let stop_thread = stop.clone();
        let thread = std::thread::Builder::new()
            .name("zumi-stt-hotkey".into())
            .spawn(move || {
                // The registration belongs to this thread (hwnd NULL): WM_HOTKEY comes to this thread's queue.
                // SAFETY: plain Win32 calls with a null window, and a MSG we own.
                let registered = unsafe { RegisterHotKey(None, ID, HOT_KEY_MODIFIERS(chord.mods) | MOD_NOREPEAT, chord.vk) };
                let failed = registered.is_err();
                let _ = told.send(registered.map_err(|e| if e.code().0 == TAKEN { SttError("stt_hotkey_taken") } else { SttError("stt_hotkey_failed") }));
                if failed {
                    return;
                }
                let mut held = false;
                let mut msg = MSG::default();
                while !stop_thread.load(Ordering::SeqCst) {
                    // SAFETY: as above.
                    while unsafe { PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE) }.as_bool() {
                        if msg.message == WM_HOTKEY && msg.wParam.0 as i32 == ID && !held {
                            held = true;
                            on(HotkeyEvent::Press);
                        }
                    }
                    if held && !chord_down() {
                        held = false;
                        on(HotkeyEvent::Release);
                    }
                    std::thread::sleep(Duration::from_millis(8));
                }
                // SAFETY: the registration this thread made.
                let _ = unsafe { UnregisterHotKey(None, ID) };
            })
            .map_err(|_| SttError("stt_hotkey_failed"))?;
        match hear.recv() {
            Ok(Ok(())) => Ok(Hotkey { stop, thread: Some(thread) }),
            Ok(Err(e)) => {
                let _ = thread.join();
                Err(e)
            }
            Err(_) => Err(SttError("stt_hotkey_failed")),
        }
    }
}

#[cfg(not(windows))]
impl Hotkey {
    pub fn register(_chord: Chord, _on: impl Fn(HotkeyEvent) + Send + 'static) -> Result<Hotkey, SttError> {
        Err(SttError("stt_hotkey_unsupported"))
    }
}
