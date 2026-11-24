//! `zumi-pack-attacker` (test only, feature `canary`): the UI attacker of the R7b re-gate (n8, n10c) as a compiled program, so it runs at any
//! integrity level (a script that compiles C# needs a writable temp folder, which a Low process has not). It is NOT in `src/`: the canary
//! helper stays free of any socket of its own (that is its point), and this program reports over loopback because a Low process writes no file.
//!   `--click <title> <hwnd> <port>`   tries to answer Yes on a plain window (FindWindow on its own desktop, and the handle it is given)
//!   `--nested <title> <hwnd> <port>`  first puts itself into a job of its own (what `Start-Process -Wait` does), then starts `--click`
//!   `--open-process <pid>`            asks for the access an injector needs on that process and prints OK or the Win32 error (stdout)
//!   `--pipe <name>`                   opens the host's named pipe of that name for writing and writes to it (prints OK or the Win32 error)
//!   (no argument)                     as `zumi-r7d-marker.exe` with a `.port` file beside it: reports its pid and integrity level (Explorer test)
#[cfg(windows)]
mod attack {
    use std::io::Write;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{GetLastError, HWND, LPARAM, WPARAM};
    use windows::Win32::System::JobObjects::{AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicUIRestrictions, QueryInformationJobObject, JOBOBJECT_BASIC_UI_RESTRICTIONS};
    use windows::Win32::System::Threading::GetCurrentProcess;
    use windows::Win32::UI::WindowsAndMessaging::{FindWindowW, GetDlgItem, IsWindow, PostMessageW, SendMessageW, BM_CLICK, WM_COMMAND};

    fn report(port: u16, text: &str) {
        if let Ok(mut s) = std::net::TcpStream::connect(("127.0.0.1", port)) {
            let _ = s.write_all(text.as_bytes());
        }
    }

    fn press_yes(h: HWND) -> String {
        // SAFETY: plain window calls on a handle that may be invalid; each reports its own error.
        unsafe {
            let yes = GetDlgItem(Some(h), 6).ok();
            let (valid, dlg_err) = (IsWindow(Some(h)).as_bool(), GetLastError().0);
            let Some(yes) = yes else { return format!("is_window={valid} no_yes_button dlg_err={dlg_err}") };
            let _ = GetLastError();
            SendMessageW(yes, BM_CLICK, Some(WPARAM(0)), Some(LPARAM(0)));
            let send_err = GetLastError().0;
            let posted = PostMessageW(Some(h), WM_COMMAND, WPARAM(6), LPARAM(yes.0 as isize)).is_ok();
            format!("is_window={valid} send_err={send_err} posted={posted}")
        }
    }

    pub fn click(title: &str, hwnd: isize, port: u16) {
        let mut out = vec![format!("click pid={}", std::process::id())];
        let mut ui = JOBOBJECT_BASIC_UI_RESTRICTIONS::default();
        // SAFETY: the innermost job of this process (a null handle); `ui` is a valid out struct of the stated class.
        let q = unsafe { QueryInformationJobObject(None, JobObjectBasicUIRestrictions, &mut ui as *mut _ as *mut _, std::mem::size_of::<JOBOBJECT_BASIC_UI_RESTRICTIONS>() as u32, None) };
        out.push(format!("innermost_job_ui={}", if q.is_ok() { format!("{:#x}", ui.UIRestrictionsClass.0) } else { "none".to_string() }));
        let t: Vec<u16> = title.encode_utf16().chain([0]).collect();
        let c: Vec<u16> = "#32770".encode_utf16().chain([0]).collect();
        // SAFETY: NUL-terminated buffers that outlive the call.
        let found = unsafe { FindWindowW(PCWSTR(c.as_ptr()), PCWSTR(t.as_ptr())) }.ok().filter(|h| !h.0.is_null());
        out.push(match found {
            Some(h) => format!("by-title: {}", press_yes(h)),
            None => "by-title: no-window".to_string(),
        });
        out.push(format!("by-handle: {}", press_yes(HWND(hwnd as *mut _))));
        out.push("done".to_string());
        report(port, &out.join("\n"));
    }

    pub fn nested(title: &str, hwnd: isize, port: u16) {
        // SAFETY: a fresh unnamed job; this process joins it (nested under the pack job when it has one).
        let assigned = unsafe { CreateJobObjectW(None, None).ok().map(|j| AssignProcessToJobObject(j, GetCurrentProcess()).is_ok()) };
        report(port, &format!("nested pid={} assigned={assigned:?}", std::process::id()));
        if let Ok(exe) = std::env::current_exe() {
            let _ = std::process::Command::new(exe).args(["--click", title, &hwnd.to_string(), &port.to_string()]).status();
        }
    }

    pub fn open_process(pid: u32) -> String {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Threading::{OpenProcess, PROCESS_CREATE_THREAD, PROCESS_VM_OPERATION, PROCESS_VM_WRITE};
        // SAFETY: a handle opened here and closed here; nothing is done with it.
        match unsafe { OpenProcess(PROCESS_VM_WRITE | PROCESS_VM_OPERATION | PROCESS_CREATE_THREAD, false, pid) } {
            Ok(h) => {
                let _ = unsafe { CloseHandle(h) };
                "open-host-process: OK".to_string()
            }
            Err(e) => format!("open-host-process: DENIED win32={}", e.code().0 as u32 & 0xFFFF),
        }
    }

    pub fn own_integrity() -> u32 {
        use windows::Win32::Foundation::{CloseHandle, HANDLE};
        use windows::Win32::Security::{GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation, TokenIntegrityLevel, TOKEN_MANDATORY_LABEL, TOKEN_QUERY};
        use windows::Win32::System::Threading::OpenProcessToken;
        // SAFETY: the token of this process, closed here; the buffer is sized by the first call.
        unsafe {
            let mut t = HANDLE::default();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut t).is_err() {
                return 0;
            }
            let mut need = 0u32;
            let _ = GetTokenInformation(t, TokenIntegrityLevel, None, 0, &mut need);
            let mut buf = vec![0u8; need as usize];
            let mut rid = 0;
            if GetTokenInformation(t, TokenIntegrityLevel, Some(buf.as_mut_ptr() as *mut _), need, &mut need).is_ok() {
                let label = &*(buf.as_ptr() as *const TOKEN_MANDATORY_LABEL);
                let n = *GetSidSubAuthorityCount(label.Label.Sid);
                rid = *GetSidSubAuthority(label.Label.Sid, (n - 1) as u32);
            }
            let _ = CloseHandle(t);
            rid
        }
    }

    /// Opens a named pipe of the host for writing and writes to it (what a program does to talk to a running medium process).
    pub fn pipe(name: &str) -> String {
        match std::fs::OpenOptions::new().write(true).open(format!(r"\\.\pipe\{name}")) {
            Ok(mut f) => {
                let _ = f.write_all(b"pipe-write-from-attacker");
                "pipe: OK".to_string()
            }
            Err(e) => format!("pipe: DENIED win32={}", e.raw_os_error().unwrap_or(-1)),
        }
    }

    /// Started by someone else (Explorer, which takes no arguments for a program): a copy of this exe named `zumi-r7d-marker.exe`, with its port
    /// in `zumi-r7d-marker.port` beside it, says who it is and at what integrity it runs (0x1000 Low, 0x2000 Medium), over loopback.
    fn marker() -> bool {
        let Ok(exe) = std::env::current_exe() else { return false };
        if !exe.file_stem().is_some_and(|s| s == "zumi-r7d-marker") {
            return false;
        }
        let Some(port) = std::fs::read_to_string(exe.with_extension("port")).ok().and_then(|p| p.trim().parse::<u16>().ok()) else { return false };
        report(port, &format!("marker pid={} rid={:#x}", std::process::id(), own_integrity()));
        true
    }

    pub fn run(args: &[String]) -> bool {
        if args.is_empty() {
            return marker();
        }
        match (args.first().map(String::as_str), args.get(1)) {
            (Some("--open-process"), Some(pid)) if pid.parse::<u32>().is_ok() => {
                println!("{}", open_process(pid.parse().unwrap_or(0)));
                return true;
            }
            (Some("--pipe"), Some(name)) => {
                println!("{}", pipe(name));
                return true;
            }
            _ => {}
        }
        let (Some(mode), Some(title), Some(hwnd), Some(port)) = (args.first(), args.get(1), args.get(2).and_then(|h| h.parse().ok()), args.get(3).and_then(|p| p.parse().ok())) else { return false };
        match mode.as_str() {
            "--click" => click(title, hwnd, port),
            "--nested" => nested(title, hwnd, port),
            _ => return false,
        }
        true
    }
}

fn main() {
    #[cfg(windows)]
    if !attack::run(&std::env::args().skip(1).collect::<Vec<_>>()) {
        eprintln!("usage: zumi-pack-attacker --click|--nested <title> <hwnd> <port>");
        std::process::exit(2);
    }
}
