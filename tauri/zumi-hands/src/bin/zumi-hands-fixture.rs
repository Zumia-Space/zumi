//! `zumi-hands-fixture --out FILE`: the P2 test window. A small top-level window with a normal edit ("Name:") and a
//! password edit ("Password:", ES_PASSWORD). Every 200 ms it writes what the fields hold to FILE:
//!   name=<the name field's text>
//!   pwlen=<number of characters in the password field>
//!   remember=<0|1: the "Remember me" check box; the "Flip" button flips it without any UIA event>
//!   spawned=<children started by "Search with Bing..." / "Run tool" / "Run tool later" (2 s later): ping.exe on
//!   127.0.0.1 for about 5 s, no window>
//! so the goal check can prove the password field received nothing and the normal field received the text.
//! `--advance-after N`: once the name field holds N characters, the fixture moves the focus to the password field
//! itself (a form that auto-advances): the mid-type focus move the per-keystroke password check must catch.
//! Test-only: it is listed only in the P2 test policy file, never in the default allowlist.
#![cfg_attr(not(test), windows_subsystem = "windows")]

#[cfg(windows)]
fn main() {
    use std::path::PathBuf;
    use std::sync::OnceLock;
    use windows::core::w;
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::*;

    static OUT: OnceLock<PathBuf> = OnceLock::new();
    static NAME: OnceLock<usize> = OnceLock::new();
    static PASS: OnceLock<usize> = OnceLock::new();
    static ADVANCE: OnceLock<i32> = OnceLock::new();
    static REMEMBER: OnceLock<usize> = OnceLock::new();
    static FLIP: OnceLock<usize> = OnceLock::new();
    static BING: OnceLock<usize> = OnceLock::new();
    static TOOL: OnceLock<usize> = OnceLock::new();
    static SPAWNED: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    static LATER: OnceLock<usize> = OnceLock::new();

    /// A child of another image than this one: ping.exe on the loopback address for about 5 s, no window, no network
    /// beyond 127.0.0.1. Stands in for an app that starts a browser or another program.
    fn start_child() {
        use std::os::windows::process::CommandExt;
        let ping = std::process::Command::new(r"C:\Windows\System32\PING.EXE")
            .args(["-n", "6", "127.0.0.1"])
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
            .stdout(std::process::Stdio::null())
            .spawn();
        if ping.is_ok() {
            SPAWNED.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
    }

    fn text_of(h: usize) -> String {
        let mut buf = [0u16; 2048];
        // SAFETY: our own child window; the buffer is sized and the length returned is clamped.
        let n = unsafe { GetWindowTextW(HWND(h as *mut _), &mut buf) }.max(0) as usize;
        String::from_utf16_lossy(&buf[..n.min(buf.len())])
    }

    extern "system" fn wndproc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
        // SAFETY: the fixture's own window procedure.
        unsafe {
            match msg {
                WM_TIMER if wp.0 != 2 => {
                    if let (Some(out), Some(n), Some(p)) = (OUT.get(), NAME.get(), PASS.get()) {
                        let pw = GetWindowTextLengthW(HWND(*p as *mut _));
                        let rem = REMEMBER.get().map(|r| SendMessageW(HWND(*r as *mut _), 0x00F0, None, None).0).unwrap_or(-1); // BM_GETCHECK
                        let sp = SPAWNED.load(std::sync::atomic::Ordering::SeqCst);
                        let _ = std::fs::write(out, format!("name={}\npwlen={}\nremember={}\nspawned={}\n", text_of(*n), pw, rem, sp));
                    }
                    LRESULT(0)
                }
                // "Search with Bing..." or "Run tool" pressed: start a child (this exe with --child: it waits 3 s and
                // exits; no window, no network). Stands in for an app that opens a browser or another program.
                WM_COMMAND if (wp.0 >> 16) & 0xFFFF == 0 && (BING.get().is_some_and(|b| lp.0 as usize == *b) || TOOL.get().is_some_and(|t| lp.0 as usize == *t)) => {
                    start_child();
                    LRESULT(0)
                }
                // "Run tool later": the child starts 2 s after the click (review R5 M2: past any short watch window).
                WM_COMMAND if (wp.0 >> 16) & 0xFFFF == 0 && LATER.get().is_some_and(|t| lp.0 as usize == *t) => {
                    SetTimer(Some(hwnd), 2, 2000, None);
                    LRESULT(0)
                }
                WM_TIMER if wp.0 == 2 => {
                    let _ = KillTimer(Some(hwnd), 2);
                    start_child();
                    LRESULT(0)
                }
                // "Flip" pressed (BN_CLICKED): the window flips its own check box (BM_SETCHECK), a change no UIA event
                // reports: the state behind a cache's back that rule (b) must catch.
                WM_COMMAND if (wp.0 >> 16) & 0xFFFF == 0 && FLIP.get().is_some_and(|f| lp.0 as usize == *f) => {
                    if let Some(r) = REMEMBER.get() {
                        let h = HWND(*r as *mut _);
                        let on = SendMessageW(h, 0x00F0, None, None).0; // BM_GETCHECK
                        let _ = SendMessageW(h, 0x00F1, Some(WPARAM(if on == 1 { 0 } else { 1 })), None); // BM_SETCHECK
                    }
                    // The button renames itself, so the hands' re-read of it sees a change (review R4 M1 bench).
                    let _ = SetWindowTextW(HWND(lp.0 as *mut _), w!("Flipped"));
                    LRESULT(0)
                }
                // EN_CHANGE from the name field: auto-advance to the password field after N characters.
                WM_COMMAND if (wp.0 >> 16) & 0xFFFF == 0x0300 => {
                    if let (Some(n), Some(p), Some(after)) = (NAME.get(), PASS.get(), ADVANCE.get()) {
                        if lp.0 as usize == *n && GetWindowTextLengthW(HWND(*n as *mut _)) >= *after {
                            let _ = windows::Win32::UI::Input::KeyboardAndMouse::SetFocus(Some(HWND(*p as *mut _)));
                        }
                    }
                    LRESULT(0)
                }
                WM_DESTROY => {
                    PostQuitMessage(0);
                    LRESULT(0)
                }
                _ => DefWindowProcW(hwnd, msg, wp, lp),
            }
        }
    }

    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--child") {
        std::thread::sleep(std::time::Duration::from_secs(3));
        return;
    }
    let out = args.iter().position(|a| a == "--out").and_then(|i| args.get(i + 1)).map(PathBuf::from);
    let Some(out) = out else {
        eprintln!("usage: zumi-hands-fixture --out FILE");
        std::process::exit(2);
    };
    let _ = OUT.set(out);
    if let Some(n) = args.iter().position(|a| a == "--advance-after").and_then(|i| args.get(i + 1)).and_then(|v| v.parse().ok()) {
        let _ = ADVANCE.set(n);
    }
    // SAFETY: window class, windows and the message loop all belong to this thread.
    unsafe {
        let class = w!("ZumiHandsP2Fixture");
        let wc = WNDCLASSW { lpfnWndProc: Some(wndproc), lpszClassName: class, hbrBackground: windows::Win32::Graphics::Gdi::HBRUSH((5 + 1) as *mut _), ..Default::default() };
        RegisterClassW(&wc);
        let Ok(frame) = CreateWindowExW(WINDOW_EX_STYLE(0), class, w!("zumi-hands P2 fixture"), WS_OVERLAPPEDWINDOW | WS_VISIBLE, 120, 120, 460, 230, None, None, None, None) else {
            std::process::exit(3);
        };
        let child = |cls: windows::core::PCWSTR, text: windows::core::PCWSTR, style: WINDOW_STYLE, x, y, w| {
            CreateWindowExW(WINDOW_EX_STYLE(0), cls, text, WS_CHILD | WS_VISIBLE | style, x, y, w, 24, Some(frame), None, None, None).map(|h| h.0 as usize).unwrap_or(0)
        };
        child(w!("STATIC"), w!("Name:"), WINDOW_STYLE(0), 16, 24, 90);
        let name = child(w!("EDIT"), w!(""), WS_BORDER | WS_TABSTOP | WINDOW_STYLE(0x0080), 110, 22, 300); // ES_AUTOHSCROLL
        child(w!("STATIC"), w!("Password:"), WINDOW_STYLE(0), 16, 72, 90);
        let pass = child(w!("EDIT"), w!(""), WS_BORDER | WS_TABSTOP | WINDOW_STYLE(0x0020 | 0x0080), 110, 70, 300); // ES_PASSWORD
        let remember = child(w!("BUTTON"), w!("Remember me"), WS_TABSTOP | WINDOW_STYLE(0x0003), 110, 110, 200); // BS_AUTOCHECKBOX
        let _ = REMEMBER.set(remember);
        let flip = child(w!("BUTTON"), w!("Flip"), WS_TABSTOP, 320, 110, 60); // BS_PUSHBUTTON
        let _ = FLIP.set(flip);
        let bing = child(w!("BUTTON"), w!("Search with Bing..."), WS_TABSTOP, 16, 140, 160);
        let tool = child(w!("BUTTON"), w!("Run tool"), WS_TABSTOP, 190, 140, 100);
        let later = child(w!("BUTTON"), w!("Run tool later"), WS_TABSTOP, 300, 140, 130);
        let _ = BING.set(bing);
        let _ = TOOL.set(tool);
        let _ = LATER.set(later);
        let _ = NAME.set(name);
        let _ = PASS.set(pass);
        // --focus-box: the check box starts with the keyboard focus (review R6 S1: a keystroke into an element type
        // the allowlist does not list for keys must be refused by the per-batch check).
        if args.iter().any(|a| a == "--focus-box") {
            let _ = windows::Win32::UI::Input::KeyboardAndMouse::SetFocus(Some(HWND(remember as *mut _)));
        }
        SetTimer(Some(frame), 1, 200, None);
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

#[cfg(not(windows))]
fn main() {}
