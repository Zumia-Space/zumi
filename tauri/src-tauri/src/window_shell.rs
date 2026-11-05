// T-31 P1c4 — the main window's Electron shell behaviour (src/main/main.js:625-665).
//
//   * show once when the app page has finished loading (Electron: `show:false` + `ready-to-show`);
//   * `window:focus` (true/false) on a focus change, `window:visible` (true/false) when the window is
//     shown, minimised or restored — both pushed to the main webview with `emit_to(MAIN_LABEL, …)`.
//
// The renderer acts on both: `onWindowFocus(false)` puts the avatar into its blur state and
// `onWindowVisible(false)` pauses the room video, so a spurious `false` is a visible regression. Hence
// every emit goes through `changed`: an unchanged value emits nothing.
//
// Focus source (probe-p1c4, spare PC): Tauri's own `WindowEvent::Focused` is NOT window activation on
// Windows. For a window that owns a webview, tauri-runtime-wry drops tao's Focused and synthesises it
// from WebView2's controller GotFocus/LostFocus (keyboard focus inside the webview), which fires in the
// wrong order around a restore and an app switch (restore: true,false while Zumi is foreground; switch
// away: true). Electron's `focus`/`blur` are window activation, so on Windows the focus value comes from
// the main HWND's WM_ACTIVATE (a window subclass, `activation::activation_proc`); `WindowEvent::Focused`
// is still used to re-read visibility. Other platforms keep the tao event, which is activation there.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tauri::{Emitter, Manager, WebviewWindow, WindowEvent};

use crate::guest::MAIN_LABEL;

/// What to emit for a value that may not have changed: `Some(now)` when it differs from the last
/// emitted value (or nothing was emitted yet), `None` when it is a repeat. Used for focus and visibility.
fn changed(last: Option<bool>, now: bool) -> Option<bool> {
    if last == Some(now) {
        None
    } else {
        Some(now)
    }
}

/// Window title with the app version appended ("Zumi Preview 0.2.10-preview.3"), so the owner sees which build
/// is running without Developer mode. An empty version keeps the plain title.
pub fn window_title(base: &str, version: &str) -> String {
    let v = version.trim();
    if v.is_empty() { base.to_string() } else { format!("{base} {v}") }
}

/// Per-window shell state, shared between the page-load hook and the window-event hook.
#[derive(Default)]
pub struct Shell {
    /// The window has been shown (or must never be shown). Visibility is only tracked after this.
    shown: AtomicBool,
    last_focus: Mutex<Option<bool>>,
    last_visible: Mutex<Option<bool>>,
}

impl Shell {
    /// The app page finished loading: show and focus the window exactly once (a reload must not re-show
    /// a window the user minimised). `Finished` fires even for a failed document, as Electron's
    /// `ready-to-show` would not — gate G5 accepts that, no timer.
    pub fn on_page_finished(&self, window: &WebviewWindow) {
        if self.shown.swap(true, Ordering::SeqCst) {
            return;
        }
        if let Err(e) = window.show().and_then(|()| window.set_focus()) {
            eprintln!("window: main show failed {e}");
            return;
        }
        eprintln!("window: main shown");
        // Electron's `show` event sends `window:visible true`.
        self.emit_visible(window, true);
    }

    /// Never show this window (the main guard failed and the app is exiting).
    pub fn disarm(&self) {
        self.shown.store(true, Ordering::SeqCst);
    }

    /// The window's activation state changed (`active` = the main window is the active window): emit
    /// `window:focus` once per real change, then re-read visibility (a hide raises no resize).
    #[cfg(windows)]
    fn on_activation(&self, window: &WebviewWindow, active: bool) {
        self.emit_focus(window, active);
        if self.shown.load(Ordering::SeqCst) {
            self.sync_visible(window);
        }
    }

    /// The value to emit for an activation report, or `None` for a repeat. Records it as the last emitted.
    fn note_focus(&self, active: bool) -> Option<bool> {
        let mut last = self.last_focus.lock().unwrap();
        let value = changed(*last, active)?;
        *last = Some(value);
        Some(value)
    }

    fn emit_focus(&self, window: &WebviewWindow, active: bool) {
        if let Some(value) = self.note_focus(active) {
            let _ = window.app_handle().emit_to(MAIN_LABEL, "window:focus", value);
        }
    }

    fn on_event(&self, window: &WebviewWindow, event: &WindowEvent) {
        match event {
            WindowEvent::Focused(focused) => {
                // Windows: the value is ignored (see the header); only WM_ACTIVATE emits focus.
                #[cfg(not(windows))]
                self.emit_focus(window, *focused);
                #[cfg(windows)]
                let _ = focused;
                // Electron sends `window:visible false` on `hide`. A hide (ShowWindow SW_HIDE) raises no
                // WM_SIZE, so no Resized; the only event a hidden foreground window raises is the loss of
                // focus. Re-read the real state here so a hide is reported (a repeat is filtered).
                if self.shown.load(Ordering::SeqCst) {
                    self.sync_visible(window);
                }
            }
            // tao raises Resized on every WM_SIZE, minimise and restore included (there is no Minimized
            // event), so the visible/minimised state is re-read on each one. Before the first show the
            // window is not "visible" to the user yet: nothing is emitted.
            WindowEvent::Resized(_) if self.shown.load(Ordering::SeqCst) => self.sync_visible(window),
            _ => {}
        }
    }

    /// Emit `window:visible` from the window's real state (shown and not minimised).
    fn sync_visible(&self, window: &WebviewWindow) {
        let (Ok(visible), Ok(minimized)) = (window.is_visible(), window.is_minimized()) else {
            return; // cannot read the state: keep the last emitted value
        };
        self.emit_visible(window, visible && !minimized);
    }

    fn emit_visible(&self, window: &WebviewWindow, now: bool) {
        let mut last = self.last_visible.lock().unwrap();
        if let Some(value) = changed(*last, now) {
            *last = Some(value);
            let _ = window.app_handle().emit_to(MAIN_LABEL, "window:visible", value);
            // Same moment, same value, for the sidecar's sync `windowVisible` reader (os_signals.rs).
            crate::os_signals::push_visible(window.app_handle(), value);
        }
    }
}

/// `WM_ACTIVATE` carries the state in the low word of `wParam`: `WA_INACTIVE` (0) is a deactivation,
/// `WA_ACTIVE` (1) and `WA_CLICKACTIVE` (2) an activation. The high word (minimised flag) is ignored.
#[cfg(any(windows, test))]
fn activation_from_wparam(wparam: usize) -> bool {
    wparam & 0xFFFF != 0
}

/// `WM_SYSCOMMAND` low nibble is used by the system; the command is `wParam & 0xFFF0`.
#[cfg(any(windows, test))]
const SC_KEYMENU: usize = 0xF100;

/// True for the `WM_SYSCOMMAND` a lone Alt press+release raises: `SC_KEYMENU` with `lParam == 0`. Default
/// handling enters the keyboard menu mode, which (probe-r5 ALT-CHECK) eats the next key-down and stalls
/// the WebView2 input / CDP path until a key or click. The window has no menu bar, so nothing is lost by
/// swallowing it. Alt+Space (`lParam` = ' ', the system menu), Alt+mnemonic (`lParam` = the char), and
/// every other command (`SC_CLOSE` = Alt+F4, `SC_MOVE`, ...) keep the default handling.
#[cfg(any(windows, test))]
fn swallow_syscommand(wparam: usize, lparam: isize) -> bool {
    wparam & 0xFFF0 == SC_KEYMENU && lparam == 0
}

/// `WM_EXITMENULOOP`: the window's menu mode (system menu from Alt+Space, or a lone Alt) has ended.
#[cfg(any(windows, test))]
const WM_EXITMENULOOP: u32 = 0x0212;

/// True for the message after which the page must get keyboard focus back. Alt+Space opens the system
/// menu, a modal loop in which the OS takes keyboard focus off the WebView2 controller; Esc closes it
/// but focus is not handed back (probe-r5 ALT-CHECK: the page stalls and the next key is lost, 3/3).
/// `WM_EXITSIZEMOVE` is not included: the size/move loop is started from the caption/border, which does
/// not move focus off the child, and no probe showed the symptom there.
#[cfg(any(windows, test))]
fn refocus_page_after(msg: u32) -> bool {
    msg == WM_EXITMENULOOP
}

/// Wire the window-event half of the shell onto the main window.
pub fn attach(window: &WebviewWindow, shell: Arc<Shell>) {
    let handle = window.clone();
    let events = shell.clone();
    window.on_window_event(move |event| events.on_event(&handle, event));
    #[cfg(windows)]
    {
        activation::install(window, shell);
        if let Ok(h) = window.hwnd() {
            close_guard::install(h.0 as isize);
        }
    }
}

/// How long the app may stay alive once its main window is gone. Past this the process ends itself: the kill-on-close
/// job (lib.rs) takes the sidecar with it. Same bound as a finished self-test run (guest_cdp::EXIT_GRACE).
pub const CLOSED_EXIT_GRACE: std::time::Duration = crate::guest_cdp::EXIT_GRACE;

/// Run `force` after `grace` on its own thread. The normal path (tao's Destroyed -> RunEvent::Exit) ends the process first,
/// so this only ever fires when that path did not finish. It takes no lock and needs no event loop.
pub fn force_after<F: FnOnce() + Send + 'static>(grace: std::time::Duration, force: F) {
    std::thread::spawn(move || {
        std::thread::sleep(grace);
        force();
    });
}

/// tao keeps a hidden helper, class "Tao Thread Event Target", as a VISIBLE 16x16 top-level window, and the event loop's
/// messages go through it. So anything that sends WM_CLOSE to "the process's windows" reaches it: `Process.CloseMainWindow`
/// picks it as soon as the main window is minimised (z-order measured, logs/exit-hidden-installed-minimized.log). Default
/// handling destroys it. Measured on 0.3.0-alpha.13: main closed alone = gone in 1 s; helper closed, then main = window gone,
/// exe and node alive with no end. Here a close sent to the helper means "close the app": the helper stays, main closes.
#[cfg(windows)]
pub(crate) mod close_guard {
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::System::Threading::GetCurrentThreadId;
    use windows_sys::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
    use windows_sys::Win32::UI::WindowsAndMessaging::{EnumThreadWindows, GetClassNameW, IsWindow, PostMessageW, WM_CLOSE, WM_NCDESTROY};

    const HELPER_CLASS: &str = "Tao Thread Event Target";
    const SUBCLASS_ID: usize = 0x5A55_4D43; // "ZUMC"

    fn class_is(hwnd: HWND, want: &str) -> bool {
        let mut buf = [0u16; 64];
        // SAFETY: the buffer outlives the call and its length is passed.
        let n = unsafe { GetClassNameW(hwnd, buf.as_mut_ptr(), buf.len() as i32) };
        n > 0 && String::from_utf16_lossy(&buf[..n as usize]) == want
    }

    unsafe extern "system" fn find_helper(hwnd: HWND, out: LPARAM) -> i32 {
        if class_is(hwnd, HELPER_CLASS) {
            // SAFETY: `out` is the `&mut HWND` passed by `install`, alive for the whole enumeration.
            unsafe { *(out as *mut HWND) = hwnd };
            return 0;
        }
        1
    }

    /// Must run on the thread that owns the event loop (setup does). Returns whether the helper was guarded.
    pub fn install(main_hwnd: isize) -> bool {
        let mut helper: HWND = std::ptr::null_mut();
        // SAFETY: the callback only writes through the pointer it is given, during this call.
        unsafe { EnumThreadWindows(GetCurrentThreadId(), Some(find_helper), &mut helper as *mut HWND as LPARAM) };
        if helper.is_null() {
            eprintln!("window: close guard found no event-loop helper");
            return false;
        }
        // SAFETY: `helper` is live and owned by this thread, as SetWindowSubclass requires.
        let ok = unsafe { SetWindowSubclass(helper, Some(guard_proc), SUBCLASS_ID, main_hwnd as usize) } != 0;
        if !ok {
            eprintln!("window: close guard failed (SetWindowSubclass)");
        }
        ok
    }

    unsafe extern "system" fn guard_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM, _id: usize, main_hwnd: usize) -> LRESULT {
        match msg {
            WM_CLOSE => {
                let main = main_hwnd as HWND;
                // SAFETY: IsWindow accepts any value, and a post to a live window has no other precondition.
                unsafe {
                    if IsWindow(main) != 0 {
                        PostMessageW(main, WM_CLOSE, 0, 0);
                    }
                }
                0
            }
            WM_NCDESTROY => {
                // SAFETY: the last message this window gets; removes this subclass from its own chain.
                unsafe { RemoveWindowSubclass(hwnd, Some(guard_proc), SUBCLASS_ID) };
                unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
            }
            // SAFETY: forwards the unmodified message to the next procedure in the chain.
            _ => unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) },
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::sync::atomic::{AtomicU32, Ordering};
        use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, PeekMessageW, RegisterClassW, SendMessageW, MSG, PM_REMOVE, WNDCLASSW,
        };

        static MAIN_CLOSES: AtomicU32 = AtomicU32::new(0);

        unsafe extern "system" fn plain_proc(h: HWND, m: u32, w: WPARAM, l: LPARAM) -> LRESULT {
            // SAFETY: default handling of a test window.
            unsafe { DefWindowProcW(h, m, w, l) }
        }
        unsafe extern "system" fn main_proc(h: HWND, m: u32, w: WPARAM, l: LPARAM) -> LRESULT {
            if m == WM_CLOSE {
                MAIN_CLOSES.fetch_add(1, Ordering::SeqCst);
                return 0;
            }
            // SAFETY: default handling of a test window.
            unsafe { DefWindowProcW(h, m, w, l) }
        }
        fn wide(s: &str) -> Vec<u16> {
            s.encode_utf16().chain(std::iter::once(0)).collect()
        }
        fn window(class: &str, proc_: unsafe extern "system" fn(HWND, u32, WPARAM, LPARAM) -> LRESULT) -> HWND {
            let name = wide(class);
            // SAFETY: plain Win32 registration of a test class; the name outlives both calls.
            unsafe {
                let mut wc: WNDCLASSW = std::mem::zeroed();
                wc.lpfnWndProc = Some(proc_);
                wc.hInstance = GetModuleHandleW(std::ptr::null());
                wc.lpszClassName = name.as_ptr();
                RegisterClassW(&wc);
                CreateWindowExW(0, name.as_ptr(), name.as_ptr(), 0, 0, 0, 16, 16, std::ptr::null_mut(), std::ptr::null_mut(), wc.hInstance, std::ptr::null())
            }
        }

        #[test]
        fn a_close_sent_to_the_helper_keeps_it_alive_and_closes_the_main_window() {
            let helper = window(HELPER_CLASS, plain_proc);
            let main = window("ZumiCloseGuardTestMain", main_proc);
            assert!(!helper.is_null() && !main.is_null());
            assert!(install(main as isize), "the guard finds the helper by its class");
            // SAFETY: both windows belong to this thread; the message pump drains this thread's own queue.
            unsafe {
                SendMessageW(helper, WM_CLOSE, 0, 0);
                assert_ne!(IsWindow(helper), 0, "tao's event loop lives on this window");
                let mut msg: MSG = std::mem::zeroed();
                while PeekMessageW(&mut msg, std::ptr::null_mut(), 0, 0, PM_REMOVE) != 0 {
                    DispatchMessageW(&msg);
                }
                assert_eq!(MAIN_CLOSES.load(Ordering::SeqCst), 1, "the close reached the main window");
                DestroyWindow(main);
                SendMessageW(helper, WM_CLOSE, 0, 0); // main is gone: nothing to forward to, and the helper still stays
                assert_ne!(IsWindow(helper), 0);
                DestroyWindow(helper);
            }
        }
    }
}

/// The Windows activation hook: a comctl32 window subclass on the main window's HWND.
#[cfg(windows)]
mod activation {
    use super::{activation_from_wparam, refocus_page_after, swallow_syscommand, Shell};
    use std::sync::Arc;
    use tauri::{Manager, WebviewWindow};
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
    use windows_sys::Win32::System::RemoteDesktop::{WTSRegisterSessionNotification, WTSUnRegisterSessionNotification, NOTIFY_FOR_THIS_SESSION};
    use windows_sys::Win32::UI::WindowsAndMessaging::{WM_ACTIVATE, WM_NCDESTROY, WM_SYSCOMMAND};

    /// Subclass id: any value unique among our subclasses of this window.
    const SUBCLASS_ID: usize = 0x5A55_4D49; // "ZUMI"

    /// Owned by the subclass (`dwRefData`) until `WM_NCDESTROY`.
    struct Sink {
        window: WebviewWindow,
        shell: Arc<Shell>,
    }

    pub fn install(window: &WebviewWindow, shell: Arc<Shell>) {
        let hwnd = match window.hwnd() {
            Ok(h) => h.0 as HWND,
            Err(e) => return eprintln!("window: main focus hook failed (hwnd: {e})"),
        };
        let sink = Box::into_raw(Box::new(Sink { window: window.clone(), shell }));
        // SAFETY: `hwnd` is the live main window and `setup` runs on the thread that owns it, as
        // SetWindowSubclass requires. `sink` stays valid until `activation_proc` frees it on WM_NCDESTROY;
        // if the call fails the box is reclaimed here, so it is freed exactly once either way.
        let installed = unsafe { SetWindowSubclass(hwnd, Some(activation_proc), SUBCLASS_ID, sink as usize) };
        if installed == 0 {
            drop(unsafe { Box::from_raw(sink) });
            eprintln!("window: main focus hook failed (SetWindowSubclass)");
            return;
        }
        // Session lock/unlock arrive as WM_WTSSESSION_CHANGE only to a window that registered (os_signals.rs). A refusal
        // costs the lock-screen signal, not the window. SAFETY: `hwnd` is the live main window.
        if unsafe { WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION) } == 0 {
            eprintln!("window: session notification registration failed (lock-screen signal off)");
        }
    }

    unsafe extern "system" fn activation_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _subclass_id: usize,
        ref_data: usize,
    ) -> LRESULT {
        match msg {
            WM_ACTIVATE => {
                // SAFETY: `ref_data` is the `Sink` leaked by `install`, alive until WM_NCDESTROY below.
                let sink = unsafe { &*(ref_data as *const Sink) };
                sink.shell.on_activation(&sink.window, activation_from_wparam(wparam));
            }
            // Native signals for the sidecar's sync readers (os_signals.rs). Forwarded, never consumed: the default
            // procedure still runs below.
            _ if crate::os_signals::os_event_for(msg, wparam).is_some() => {
                // SAFETY: `ref_data` is the `Sink` leaked by `install`, alive until WM_NCDESTROY below.
                let sink = unsafe { &*(ref_data as *const Sink) };
                if let Some(name) = crate::os_signals::os_event_for(msg, wparam) {
                    crate::os_signals::push_os_event(sink.window.app_handle(), name);
                }
            }
            // A lone Alt would put the window in keyboard menu mode and swallow the next key.
            WM_SYSCOMMAND if swallow_syscommand(wparam, lparam) => return 0,
            WM_NCDESTROY => {
                eprintln!("window: main destroyed");
                // The window is gone, so the app is ending. Whatever the event loop does next, the process does not outlive this.
                super::force_after(super::CLOSED_EXIT_GRACE, || {
                    eprintln!("window: exit stalled after the main window closed, forcing");
                    std::process::exit(0);
                });
                // SAFETY: the last message the window receives; nothing reads `ref_data` after this.
                unsafe { WTSUnRegisterSessionNotification(hwnd) };
                unsafe { RemoveWindowSubclass(hwnd, Some(activation_proc), SUBCLASS_ID) };
                let result = unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) };
                drop(unsafe { Box::from_raw(ref_data as *mut Sink) });
                return result;
            }
            _ => {}
        }
        // SAFETY: forwards the unmodified message to the next procedure in the chain.
        let result = unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) };
        if refocus_page_after(msg) {
            // After the default handling, so the menu loop is fully closed. SAFETY: as for WM_ACTIVATE.
            let sink = unsafe { &*(ref_data as *const Sink) };
            // Webview::set_focus = WebView2 controller MoveFocus(PROGRAMMATIC).
            if let Err(e) = AsRef::<tauri::Webview>::as_ref(&sink.window).set_focus() {
                eprintln!("window: page refocus after the system menu failed {e}");
            }
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_forced_exit_waits_out_the_grace_then_runs() {
        let (tx, rx) = std::sync::mpsc::channel();
        force_after(std::time::Duration::from_millis(50), move || tx.send(()).unwrap());
        assert!(rx.try_recv().is_err(), "nothing runs before the grace");
        rx.recv_timeout(std::time::Duration::from_secs(5)).expect("the force runs even though nothing else happened");
    }

    #[test]
    fn the_first_value_is_emitted() {
        assert_eq!(changed(None, true), Some(true));
        assert_eq!(changed(None, false), Some(false));
    }

    #[test]
    fn a_repeat_emits_nothing() {
        assert_eq!(changed(Some(true), true), None);
        assert_eq!(changed(Some(false), false), None);
    }

    #[test]
    fn minimise_and_restore_each_emit_once() {
        // visible -> minimised -> restored, as the Resized events would report them.
        let mut last = None;
        let mut emitted = Vec::new();
        for now in [true, true, false, false, true, true] {
            if let Some(value) = changed(last, now) {
                last = Some(value);
                emitted.push(value);
            }
        }
        assert_eq!(emitted, vec![true, false, true]);
    }

    #[test]
    fn wm_activate_low_word_is_the_activation() {
        assert!(!activation_from_wparam(0)); // WA_INACTIVE
        assert!(activation_from_wparam(1)); // WA_ACTIVE
        assert!(activation_from_wparam(2)); // WA_CLICKACTIVE
        assert!(!activation_from_wparam(0x1_0000)); // inactive + minimised flag in the high word
        assert!(activation_from_wparam(0x1_0001)); // active + minimised flag
    }

    #[test]
    fn a_lone_alt_menu_command_is_swallowed() {
        assert!(swallow_syscommand(0xF100, 0)); // SC_KEYMENU, Alt alone
        assert!(swallow_syscommand(0xF103, 0)); // the system uses the low nibble; mask it
    }

    #[test]
    fn alt_with_a_key_and_other_commands_keep_the_default() {
        assert!(!swallow_syscommand(0xF100, 0x20)); // Alt+Space: system menu
        assert!(!swallow_syscommand(0xF100, b'f' as isize)); // Alt+mnemonic
        assert!(!swallow_syscommand(0xF060, 0)); // SC_CLOSE (Alt+F4 / close button)
        assert!(!swallow_syscommand(0xF010, 0)); // SC_MOVE
        assert!(!swallow_syscommand(0xF020, 0)); // SC_MINIMIZE
    }

    #[test]
    fn leaving_the_menu_loop_returns_focus_to_the_page() {
        assert!(refocus_page_after(0x0212)); // WM_EXITMENULOOP
        assert!(!refocus_page_after(0x0211)); // WM_ENTERMENULOOP
        assert!(!refocus_page_after(0x0232)); // WM_EXITSIZEMOVE
        assert!(!refocus_page_after(0x0112)); // WM_SYSCOMMAND
    }

    /// Feed a sequence of activation reports through the shell; return what `window:focus` would carry.
    fn focus_emitted(reports: &[bool]) -> Vec<bool> {
        let shell = Shell::default();
        reports.iter().filter_map(|&active| shell.note_focus(active)).collect()
    }

    #[test]
    fn focus_follows_activation_not_webview_keyboard_focus() {
        // Probe-p1c4 (Tauri's synthesised events, wrong): restore -> true,false ; app switch -> true.
        // With WM_ACTIVATE the same user actions are: restore -> activate ; switch away -> deactivate ;
        // switch back -> activate. Each real change is emitted exactly once, in that order.
        assert_eq!(focus_emitted(&[true]), vec![true]); // restore: Zumi ends in the foreground
        assert_eq!(focus_emitted(&[true, false, true]), vec![true, false, true]); // away, then back
        // A duplicate report is dropped (show + set_focus, then a click on the title bar).
        assert_eq!(focus_emitted(&[true, true, false, false, true]), vec![true, false, true]);
    }

    #[test]
    fn the_first_deactivation_is_reported() {
        // A window that never saw an activation still tells the renderer it is blurred.
        assert_eq!(focus_emitted(&[false]), vec![false]);
    }

    #[test]
    fn a_disarmed_shell_never_shows() {
        // Pure state check (no window needed): disarm marks the show as already done.
        let shell = Shell::default();
        assert!(!shell.shown.load(Ordering::SeqCst));
        shell.disarm();
        assert!(shell.shown.load(Ordering::SeqCst), "on_page_finished returns at once after disarm");
    }

    // preview.3 nit: the version is visible without Developer mode, in the window title.
    #[test]
    fn the_title_carries_the_app_version() {
        assert_eq!(window_title("Zumi Preview", "0.2.10-preview.3"), "Zumi Preview 0.2.10-preview.3");
    }

    #[test]
    fn an_empty_version_keeps_the_plain_title() {
        assert_eq!(window_title("Zumi Preview", ""), "Zumi Preview");
        assert_eq!(window_title("Zumi Preview", "  "), "Zumi Preview");
    }
}
