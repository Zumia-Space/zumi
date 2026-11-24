//! P2 overlay: while the hands act on a window, a red frame and a label ("Zumi is acting - Ctrl+Alt+Pause stops")
//! sit on top of that window. The overlay is topmost, layered (its black interior is transparent), click-through
//! (WS_EX_TRANSPARENT) and never activated (WS_EX_NOACTIVATE, SW_SHOWNOACTIVATE), so it cannot take focus or input.
//! It follows the target's rectangle every 100 ms on its own thread. `hide` removes it (disarm, kill).
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use windows::core::w;
use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::UI::WindowsAndMessaging::*;

/// Border width in pixels and the label strip height.
const BORDER: i32 = 5;
const LABEL_H: i32 = 22;
const TIMER_ID: usize = 1;

/// The window the overlay follows (0 = hidden) and the overlay's own HWND (0 = not created).
static TARGET: AtomicU64 = AtomicU64::new(0);
static OVERLAY: AtomicU64 = AtomicU64::new(0);
static STARTED: Mutex<bool> = Mutex::new(false);

pub fn overlay_hwnd() -> u64 {
    OVERLAY.load(Ordering::SeqCst)
}

/// True while the overlay window is shown.
pub fn visible() -> bool {
    let h = overlay_hwnd();
    // SAFETY: reads the visibility of our own window.
    h != 0 && unsafe { IsWindowVisible(HWND(h as usize as *mut _)) }.as_bool()
}

/// Show the overlay over `target` (starts the overlay thread on first use). Never after a kill: the kill hid it
/// and it stays hidden (review B1).
pub fn follow(target: u64) {
    if crate::kill::is_killed() {
        return;
    }
    TARGET.store(target, Ordering::SeqCst);
    let mut started = STARTED.lock().unwrap_or_else(|p| p.into_inner());
    if !*started {
        *started = true;
        std::thread::spawn(overlay_thread);
    }
}

pub fn hide() {
    TARGET.store(0, Ordering::SeqCst);
    let h = overlay_hwnd();
    if h != 0 {
        // SAFETY: hides our own overlay window; ShowWindow is safe to call from any thread.
        unsafe {
            let _ = ShowWindow(HWND(h as usize as *mut _), SW_HIDE);
        }
    }
}

extern "system" fn wndproc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    // SAFETY: standard window procedure for our own overlay class.
    unsafe {
        match msg {
            WM_PAINT => {
                let mut ps = PAINTSTRUCT::default();
                let dc = BeginPaint(hwnd, &mut ps);
                let mut r = RECT::default();
                let _ = GetClientRect(hwnd, &mut r);
                let red = CreateSolidBrush(COLORREF(0x0000_00E0));
                let black = CreateSolidBrush(COLORREF(0));
                FillRect(dc, &r, black);
                for edge in [
                    RECT { left: 0, top: 0, right: r.right, bottom: BORDER },
                    RECT { left: 0, top: r.bottom - BORDER, right: r.right, bottom: r.bottom },
                    RECT { left: 0, top: 0, right: BORDER, bottom: r.bottom },
                    RECT { left: r.right - BORDER, top: 0, right: r.right, bottom: r.bottom },
                    RECT { left: r.right - 340, top: 0, right: r.right, bottom: LABEL_H },
                ] {
                    FillRect(dc, &edge, red);
                }
                SetBkMode(dc, TRANSPARENT);
                SetTextColor(dc, COLORREF(0x00FF_FFFF));
                let mut label = RECT { left: r.right - 334, top: 2, right: r.right - 4, bottom: LABEL_H };
                let mut text: Vec<u16> = "Zumi is acting - Ctrl+Alt+Pause stops".encode_utf16().collect();
                DrawTextW(dc, &mut text, &mut label, DT_LEFT | DT_SINGLELINE | DT_VCENTER);
                let _ = DeleteObject(red.into());
                let _ = DeleteObject(black.into());
                let _ = EndPaint(hwnd, &ps);
                LRESULT(0)
            }
            WM_TIMER => {
                place(hwnd);
                LRESULT(0)
            }
            WM_NCHITTEST => LRESULT(-1), // HTTRANSPARENT: never a click target
            _ => DefWindowProcW(hwnd, msg, wp, lp),
        }
    }
}

/// Moves the overlay onto the target (or hides it when there is none or the target is gone).
fn place(hwnd: HWND) {
    let t = TARGET.load(Ordering::SeqCst);
    // SAFETY: reads the target's rect and positions our own window without activating it.
    unsafe {
        let target = HWND(t as usize as *mut _);
        let mut r = RECT::default();
        if t == 0 || crate::kill::is_killed() || !IsWindow(Some(target)).as_bool() || GetWindowRect(target, &mut r).is_err() {
            let _ = ShowWindow(hwnd, SW_HIDE);
            return;
        }
        let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), r.left, r.top, r.right - r.left, r.bottom - r.top, SWP_NOACTIVATE | SWP_SHOWWINDOW);
        let _ = InvalidateRect(Some(hwnd), None, true);
    }
}

fn overlay_thread() {
    // SAFETY: the overlay window lives and is pumped on this thread only.
    unsafe {
        let class = w!("ZumiHandsOverlay");
        let wc = WNDCLASSW { lpfnWndProc: Some(wndproc), lpszClassName: class, hbrBackground: HBRUSH(std::ptr::null_mut()), ..Default::default() };
        RegisterClassW(&wc);
        let ex = WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW;
        let Ok(hwnd) = CreateWindowExW(ex, class, w!("Zumi hands overlay"), WS_POPUP, 0, 0, 10, 10, None, None, None, None) else {
            return;
        };
        // Black is the colour key: the interior is see-through; only the red frame and label show.
        let _ = SetLayeredWindowAttributes(hwnd, COLORREF(0), 255, LWA_COLORKEY);
        OVERLAY.store(hwnd.0 as usize as u64, Ordering::SeqCst);
        SetTimer(Some(hwnd), TIMER_ID, 100, None);
        place(hwnd);
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}
