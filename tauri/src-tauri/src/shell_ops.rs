// T-31 P1c3 — off-origin guest links open in the OS browser (gate GATE-P1c3.md).
//
// A guest that calls `window.open` or navigates its top level off its own origin never gets a window or
// a navigation: Rust denies/cancels at once (synchronously) and asks the sidecar's
// `__host.decideExternalUrl` — board-open.mjs `decideExternalUrl`, unchanged — in the background. Only
// an `openExternal` verdict reaches `ShellExecuteW`, and only after this module re-validates the URL
// itself (condition 1): the policy is the sidecar's job, this is the independent last check before the
// OS shell. Anything else (sidecar error, timeout, malformed answer, missing method, a re-validation
// failure) refuses: the guest stays on its page and nothing opens (condition 2).
//
// Logging (condition 7): a refusal is written by the sidecar's own refusal-log helper (reason + origin
// only, `<preview data dir>/logs/board-open-refusals.log`). The sidecar logs the policy's refusals
// itself; this module asks it to log the refusals only Rust knows (`host_revalidate`, `sidecar_failed`,
// `sidecar_malformed`, `shell_failed`) with `__host.logRefusal`. A URL, query or fragment is never
// logged: the `origin` handed over is `scheme://host[:port]` computed here, `scheme:` or `-`.
//
// `handle_request` and `open_external_with` take their side effects as closures, so every branch is
// tested without a sidecar, a window or a ShellExecute call.

use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{mpsc, Arc};
use std::time::Duration;

use serde_json::Value;
use tauri::Url;

/// Longest URL the OS shell is handed (gate condition 1). board-open.mjs has no length cap.
pub const MAX_URL_LEN: usize = 2048;

/// Refusal reasons Rust originates (every one matches the log helper's `/^[a-z_]+$/`).
const REASON_REVALIDATE: &str = "host_revalidate";
/// The 0.2.5 Electron rule (main.js `fromBoardTab`): only THE Board tab guest may open an external link.
const REASON_OPENER: &str = "opener_not_board_tab";
const REASON_SIDECAR_FAILED: &str = "sidecar_failed";
const REASON_SIDECAR_MALFORMED: &str = "sidecar_malformed";
const REASON_SHELL_FAILED: &str = "shell_failed";

/// The sidecar's answer to `__host.decideExternalUrl`, parsed strictly.
#[derive(Debug, PartialEq, Eq)]
enum Verdict {
    /// `{ action: 'openExternal', url }` — the only answer that can reach the shell.
    Open(String),
    /// `{ action: 'refuse', reason }` — the sidecar already logged it.
    Refuse,
    /// `{ action: 'none' }` — the URL is one of the app's own guest origins; nothing to do.
    Nothing,
}

/// Strict parse: a missing/odd `action`, an `openExternal` without a string `url`, or a non-object is
/// malformed (`Err`), never "allow".
fn parse_verdict(value: &Value) -> Result<Verdict, ()> {
    match value.get("action").and_then(Value::as_str) {
        Some("openExternal") => match value.get("url").and_then(Value::as_str) {
            Some(url) => Ok(Verdict::Open(url.to_string())),
            None => Err(()),
        },
        Some("refuse") => Ok(Verdict::Refuse),
        Some("none") => Ok(Verdict::Nothing),
        _ => Err(()),
    }
}

/// Why `revalidate` refused. The log only ever carries `host_revalidate`; the variant is for tests.
#[derive(Debug, PartialEq, Eq)]
pub enum Revalidate {
    TooLong,
    ControlChar,
    Unparsable,
    Scheme,
    NoHost,
    Userinfo,
}

/// Gate condition 1: the independent check before `ShellExecuteW`. http/https only, a non-empty host,
/// no username/password, no ASCII control character, at most `MAX_URL_LEN` bytes. Returns the
/// RE-SERIALISED URL (what the shell is given), so whatever the parser normalised is what opens.
///
/// It is deliberately NOT a second copy of the allow-list: a punycode host, a non-default port or a
/// host outside the list passes here and is the sidecar's policy to refuse (no Rust copy of the list).
pub fn revalidate(url: &str) -> Result<String, Revalidate> {
    if url.len() > MAX_URL_LEN {
        return Err(Revalidate::TooLong);
    }
    // Before parsing: the url crate silently strips tab/CR/LF, so a control character must be refused
    // on the raw string or it would vanish from the re-serialised one.
    if url.chars().any(|c| c.is_ascii_control()) {
        return Err(Revalidate::ControlChar);
    }
    let parsed = Url::parse(url).map_err(|_| Revalidate::Unparsable)?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(Revalidate::Scheme);
    }
    if parsed.host_str().map_or(true, str::is_empty) {
        return Err(Revalidate::NoHost);
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(Revalidate::Userinfo);
    }
    let out = parsed.as_str();
    if out.len() > MAX_URL_LEN {
        return Err(Revalidate::TooLong);
    }
    Ok(out.to_string())
}

/// `scheme://host[:port]` for http(s), `scheme:` for any other parsable URL, `-` otherwise: the same
/// shape as refusal-log.mjs `safeOrigin`, so the origin handed to the log never carries a path, query,
/// fragment or userinfo. An input past `MAX_URL_LEN` is not parsed at all.
pub fn log_origin(url: &str) -> String {
    if url.len() > MAX_URL_LEN {
        return "-".to_string();
    }
    let Ok(parsed) = Url::parse(url) else { return "-".to_string() };
    match parsed.scheme() {
        "http" | "https" => match parsed.host_str() {
            Some(host) if !host.is_empty() => match parsed.port() {
                Some(port) => format!("{}://{}:{}", parsed.scheme(), host, port),
                None => format!("{}://{}", parsed.scheme(), host),
            },
            _ => "-".to_string(),
        },
        scheme => format!("{scheme}:"),
    }
}

/// Re-validate, then hand the re-serialised URL to `shell`. The shell closure is injected so a test
/// never calls `ShellExecuteW`.
pub fn open_external_with(url: &str, shell: impl FnOnce(&str) -> Result<(), String>) -> Result<(), String> {
    let checked = revalidate(url).map_err(|_| REASON_REVALIDATE.to_string())?;
    shell(&checked)
}

/// `open_external(url)` — Rust re-validation (condition 1), then `ShellExecuteW` with the `open` verb
/// and `SW_SHOWNORMAL`. A return value of 32 or less is an error, logged by the caller and not retried
/// (condition 5).
pub fn open_external(url: &str) -> Result<(), String> {
    open_external_with(url, shell_execute)
}

/// Not run yet / run started / given up on. One atomic so "the closure starts" and "the waiter times
/// out" cannot both win: whichever swaps out of `QUEUED` first decides.
const QUEUED: u8 = 0;
const STARTED: u8 = 1;
const CANCELLED: u8 = 2;

/// Run `shell(checked)` on the main thread (through `schedule`) and wait at most `timeout` for it. A
/// timed-out open must never fire later: on timeout the waiter marks the job `CANCELLED`, and the queued
/// closure checks that mark before it touches the shell, so a link whose `shell_failed` was logged cannot
/// open afterwards. If the closure already started when the timeout hits, it is past the point of no
/// return; wait once more for its real result instead of reporting a timeout for a link that opened.
/// `schedule` is injected (the real one is `AppHandle::run_on_main_thread`) so tests run without a window.
pub fn open_on_main_with_timeout(
    checked: &str,
    timeout: Duration,
    schedule: impl FnOnce(Box<dyn FnOnce() + Send + 'static>) -> Result<(), String>,
    shell: impl FnOnce(&str) -> Result<(), String> + Send + 'static,
) -> Result<(), String> {
    let state = Arc::new(AtomicU8::new(QUEUED));
    let job_state = state.clone();
    let (tx, rx) = mpsc::channel::<Result<(), String>>();
    let checked_owned = checked.to_string();
    schedule(Box::new(move || {
        if job_state.compare_exchange(QUEUED, STARTED, Ordering::SeqCst, Ordering::SeqCst).is_err() {
            return; // the waiter gave up first: this open must not fire
        }
        let _ = tx.send(shell(&checked_owned));
    }))?;
    match rx.recv_timeout(timeout) {
        Ok(result) => result,
        Err(_) => match state.compare_exchange(QUEUED, CANCELLED, Ordering::SeqCst, Ordering::SeqCst) {
            Ok(_) => Err("shell_timeout".to_string()),
            Err(_) => rx.recv_timeout(timeout).map_err(|_| "shell_timeout".to_string())?,
        },
    }
}

/// A NUL-terminated UTF-16 buffer for a `PCWSTR` argument.
#[cfg(windows)]
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// The only `unsafe` in this module: one `ShellExecuteW` call. `url` was re-validated by
/// `open_external_with`, or is the resolved path of step 9-2's `open_path::decide_local_path`. The caller
/// runs this on the main (UI) thread, where COM is already initialised for the window, as the API's
/// documentation asks.
#[cfg(windows)]
pub(crate) fn shell_execute(url: &str) -> Result<(), String> {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let verb = wide("open");
    let file = wide(url);
    // SAFETY: `verb` and `file` are NUL-terminated and outlive the call; a null hwnd, parameters and
    // directory are documented as valid. The URL carries no executable path: http/https only.
    let result = unsafe {
        ShellExecuteW(std::ptr::null_mut(), verb.as_ptr(), file.as_ptr(), std::ptr::null(), std::ptr::null(), SW_SHOWNORMAL)
    } as isize;
    // ShellExecuteW returns a value greater than 32 on success; 32 or less is an error code.
    if result > 32 {
        Ok(())
    } else {
        Err(format!("shell_execute_failed:{result}"))
    }
}

/// The shell is Windows-only; any other platform refuses, so nothing can open.
#[cfg(not(windows))]
pub(crate) fn shell_execute(_url: &str) -> Result<(), String> {
    Err("shell_windows_only".to_string())
}

/// What a request ended as. Tests assert on it; the caller ignores it.
#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    /// The shell was handed a re-validated URL.
    Opened,
    /// The policy (sidecar) or the Rust re-validation refused; nothing opened.
    Refused,
    /// The URL is one of the app's own origins; nothing to do.
    Ignored,
    /// The sidecar failed (error, timeout, malformed, missing method) or the shell failed; nothing
    /// opened (fail closed).
    Failed,
}

/// Decide and (maybe) open one guest link. Runs off the wry callback (the caller already denied the
/// window / cancelled the navigation synchronously). `decide` asks the sidecar; `open` hands a
/// re-validated URL to the shell; `log(reason, origin)` records a refusal only Rust knows about.
/// `opener_is_board` is false for any guest but the Board tab: refused before the
/// sidecar is asked, like Electron's `opener_not_board_tab`.
pub fn handle_request(
    url: &str,
    opener_is_board: bool,
    decide: impl FnOnce(&str) -> Result<Value, String>,
    open: impl FnOnce(&str) -> Result<(), String>,
    mut log: impl FnMut(&str, &str),
) -> Outcome {
    // Never ship an oversized string to the sidecar or the shell.
    if url.len() > MAX_URL_LEN {
        log(REASON_REVALIDATE, "-");
        return Outcome::Refused;
    }
    let origin = log_origin(url);
    if !opener_is_board {
        log(REASON_OPENER, &origin);
        return Outcome::Refused;
    }
    let answer = match decide(url) {
        Ok(answer) => answer,
        Err(_) => {
            log(REASON_SIDECAR_FAILED, &origin);
            return Outcome::Failed;
        }
    };
    match parse_verdict(&answer) {
        Err(()) => {
            log(REASON_SIDECAR_MALFORMED, &origin);
            Outcome::Failed
        }
        Ok(Verdict::Refuse) => Outcome::Refused,
        Ok(Verdict::Nothing) => Outcome::Ignored,
        Ok(Verdict::Open(verdict_url)) => match open_external_with(&verdict_url, open) {
            Ok(()) => Outcome::Opened,
            Err(reason) if reason == REASON_REVALIDATE => {
                log(REASON_REVALIDATE, &log_origin(&verdict_url));
                Outcome::Refused
            }
            Err(_) => {
                log(REASON_SHELL_FAILED, &log_origin(&verdict_url));
                Outcome::Failed
            }
        },
    }
}

#[cfg(test)]
mod tests {
    use std::cell::{Cell, RefCell};

    use serde_json::json;

    use super::*;

    // ---- revalidate: one test per gate vector ----

    #[test]
    fn plain_http_and_https_pass_and_are_reserialised() {
        assert_eq!(revalidate("https://zumia.space/a?b=1#c").unwrap(), "https://zumia.space/a?b=1#c");
        assert_eq!(revalidate("http://127.0.0.1:4212/").unwrap(), "http://127.0.0.1:4212/");
        // The parser's normal form is what opens (host lower-cased, empty path becomes "/").
        assert_eq!(revalidate("HTTPS://ZUMIA.Space").unwrap(), "https://zumia.space/");
    }

    #[test]
    fn javascript_file_ms_and_data_schemes_are_refused() {
        for url in [
            "javascript:alert(1)",
            "JavaScript:alert(1)",
            "file:///C:/Windows/System32/calc.exe",
            "file://server/share/x.exe",
            "ms-msdt:/id PCWDiagnostic",
            "ms-settings:network",
            "data:text/html,<script>1</script>",
            "ftp://example.org/",
            "about:blank",
            "mailto:a@b.example",
            "vbscript:msgbox(1)",
        ] {
            assert_eq!(revalidate(url), Err(Revalidate::Scheme), "{url}");
        }
    }

    #[test]
    fn unc_paths_and_relative_strings_are_refused() {
        for url in [r"\\server\share\x.exe", "//server/share/x.exe", r"\\?\C:\x", "C:\\Windows\\notepad.exe", "notepad.exe", "", "://x"] {
            assert!(revalidate(url).is_err(), "{url}");
        }
        // "C:\..." parses as scheme "c" and is refused as a non-http scheme.
        assert_eq!(revalidate("C:\\Windows\\notepad.exe"), Err(Revalidate::Scheme));
    }

    #[test]
    fn userinfo_is_refused() {
        assert_eq!(revalidate("https://claude.ai@evil.example/"), Err(Revalidate::Userinfo));
        assert_eq!(revalidate("https://user:pass@zumia.space/"), Err(Revalidate::Userinfo));
        assert_eq!(revalidate("http://:pw@zumia.space/"), Err(Revalidate::Userinfo));
        assert_eq!(revalidate("http://user@127.0.0.1:1/"), Err(Revalidate::Userinfo));
    }

    #[test]
    fn an_empty_host_is_refused() {
        for url in ["http://", "http://:80/", "https://@/", "https://:443/x"] {
            assert!(revalidate(url).is_err(), "{url}");
        }
    }

    #[test]
    fn ascii_control_characters_are_refused_before_the_parser_can_strip_them() {
        for url in [
            "https://zumia.space/a\tb",
            "https://zumia.space/a\nb",
            "https://zumia.space/a\rb",
            "https://zumia.space/a\u{0}b",
            "https://zumia.space/a\u{1b}b",
            "https://zumia.space/a\u{7f}b",
            "https://zumia.space/\n",
            "\thttps://zumia.space/",
        ] {
            assert_eq!(revalidate(url), Err(Revalidate::ControlChar), "{url:?}");
        }
    }

    #[test]
    fn the_length_limit_is_2048() {
        let base = "https://zumia.space/";
        let at_limit = format!("{base}{}", "a".repeat(MAX_URL_LEN - base.len()));
        assert_eq!(at_limit.len(), MAX_URL_LEN);
        assert_eq!(revalidate(&at_limit).unwrap(), at_limit);
        let over = format!("{at_limit}a");
        assert_eq!(revalidate(&over), Err(Revalidate::TooLong));
        assert_eq!(revalidate(&"a".repeat(1_000_000)), Err(Revalidate::TooLong));
    }

    #[test]
    fn a_punycode_host_passes_here_because_the_policy_is_the_sidecars_job() {
        // The sidecar's decideExternalUrl refuses punycode/IDN hosts (url_idn_host); Rust holds no
        // copy of that rule (gate "Cut"). If the policy ever allowed one, Rust would not block it.
        assert_eq!(revalidate("https://xn--clude-9ve.ai/x").unwrap(), "https://xn--clude-9ve.ai/x");
        assert_eq!(revalidate("https://clаude.ai/").unwrap(), "https://xn--clude-5ve.ai/", "an IDN look-alike is re-serialised as punycode");
        // A non-default port and a host outside any list also pass: both are policy decisions.
        assert!(revalidate("https://example.org:8443/").is_ok());
    }

    // ---- log_origin: never a path, query, fragment or userinfo ----

    #[test]
    fn the_logged_origin_has_no_path_query_fragment_or_userinfo() {
        assert_eq!(log_origin("https://user:pw@example.org:8443/p?q=1#f"), "https://example.org:8443");
        assert_eq!(log_origin("http://127.0.0.1:4212/__zumi-open?path=C:/x#tok"), "http://127.0.0.1:4212");
        assert_eq!(log_origin("javascript:alert(document.cookie)"), "javascript:");
        assert_eq!(log_origin("file:///C:/secret.txt"), "file:");
        assert_eq!(log_origin("not a url"), "-");
        assert_eq!(log_origin(&format!("https://a.example/{}", "x".repeat(3000))), "-");
    }

    // ---- open_external_with: re-validation sits in front of the shell ----

    #[test]
    fn the_shell_gets_the_reserialised_url_only_after_revalidation() {
        let seen = RefCell::new(Vec::<String>::new());
        let ok = open_external_with("HTTPS://ZUMIA.Space", |u| { seen.borrow_mut().push(u.to_string()); Ok(()) });
        assert!(ok.is_ok());
        assert_eq!(*seen.borrow(), vec!["https://zumia.space/".to_string()]);

        let refused = open_external_with("javascript:alert(1)", |u| { seen.borrow_mut().push(u.to_string()); Ok(()) });
        assert_eq!(refused.unwrap_err(), "host_revalidate");
        assert_eq!(seen.borrow().len(), 1, "the shell was not called for a refused URL");
    }

    // ---- open_on_main_with_timeout: a timed-out open never fires ----

    #[test]
    fn a_timed_out_open_never_fires_when_the_main_thread_runs_it_late() {
        use std::sync::atomic::AtomicUsize;
        use std::sync::Mutex;
        let opened = Arc::new(AtomicUsize::new(0));
        let queued: Arc<Mutex<Option<Box<dyn FnOnce() + Send>>>> = Arc::new(Mutex::new(None));
        let shell_opened = opened.clone();
        let slot = queued.clone();
        // The mocked main thread only queues the job; it runs after the waiter has timed out.
        let result = open_on_main_with_timeout(
            "https://zumia.space/",
            Duration::from_millis(20),
            move |job| { *slot.lock().unwrap() = Some(job); Ok(()) },
            move |_| { shell_opened.fetch_add(1, Ordering::SeqCst); Ok(()) },
        );
        assert_eq!(result.unwrap_err(), "shell_timeout");
        let job = queued.lock().unwrap().take().expect("the job was queued");
        job(); // the main thread finally gets to it
        assert_eq!(opened.load(Ordering::SeqCst), 0, "the timed-out link must not open");
    }

    #[test]
    fn an_open_the_main_thread_runs_in_time_reports_its_result_and_hands_over_the_checked_url() {
        use std::sync::Mutex;
        let seen = Arc::new(Mutex::new(Vec::<String>::new()));
        let shell_seen = seen.clone();
        let ok = open_on_main_with_timeout(
            "https://zumia.space/",
            Duration::from_secs(2),
            |job| { job(); Ok(()) },
            move |u| { shell_seen.lock().unwrap().push(u.to_string()); Ok(()) },
        );
        assert!(ok.is_ok());
        assert_eq!(*seen.lock().unwrap(), vec!["https://zumia.space/".to_string()]);

        let failed = open_on_main_with_timeout(
            "https://zumia.space/",
            Duration::from_secs(2),
            |job| { job(); Ok(()) },
            |_| Err("shell_execute:5".to_string()),
        );
        assert_eq!(failed.unwrap_err(), "shell_execute:5");
    }

    #[test]
    fn a_failed_dispatch_to_the_main_thread_is_an_error_and_opens_nothing() {
        let err = open_on_main_with_timeout(
            "https://zumia.space/",
            Duration::from_millis(20),
            |_job| Err("shell_dispatch:closed".to_string()),
            |_| panic!("the shell must not run"),
        );
        assert_eq!(err.unwrap_err(), "shell_dispatch:closed");
    }

    // ---- handle_request: every branch, with mocks ----

    struct Harness {
        decide_calls: Cell<u32>,
        open_calls: RefCell<Vec<String>>,
        logs: RefCell<Vec<(String, String)>>,
    }

    impl Harness {
        fn new() -> Self {
            Harness { decide_calls: Cell::new(0), open_calls: RefCell::new(vec![]), logs: RefCell::new(vec![]) }
        }

        fn run(&self, url: &str, answer: Result<Value, String>, shell: Result<(), String>) -> Outcome {
            self.run_from(url, true, answer, shell)
        }

        fn run_from(&self, url: &str, opener_is_board: bool, answer: Result<Value, String>, shell: Result<(), String>) -> Outcome {
            handle_request(
                url,
                opener_is_board,
                |_| { self.decide_calls.set(self.decide_calls.get() + 1); answer },
                |u| { self.open_calls.borrow_mut().push(u.to_string()); shell },
                |reason, origin| self.logs.borrow_mut().push((reason.to_string(), origin.to_string())),
            )
        }

        fn opened(&self) -> usize {
            self.open_calls.borrow().len()
        }
    }

    #[test]
    fn a_non_board_opener_is_refused_logged_and_never_asks_the_sidecar() {
        let h = Harness::new();
        let out = h.run_from("https://shopee.vn/x?q=SECRET", false, Ok(json!({ "action": "openExternal", "url": "https://shopee.vn/x" })), Ok(()));
        assert_eq!(out, Outcome::Refused);
        assert_eq!(h.decide_calls.get(), 0);
        assert_eq!(h.opened(), 0);
        assert_eq!(*h.logs.borrow(), vec![("opener_not_board_tab".to_string(), "https://shopee.vn".to_string())]);
    }

    #[test]
    fn an_open_external_verdict_opens_the_reserialised_url() {
        let h = Harness::new();
        let out = h.run("https://zumia.space/x", Ok(json!({ "action": "openExternal", "url": "https://zumia.space/x" })), Ok(()));
        assert_eq!(out, Outcome::Opened);
        assert_eq!(*h.open_calls.borrow(), vec!["https://zumia.space/x".to_string()]);
        assert!(h.logs.borrow().is_empty());
    }

    #[test]
    fn the_url_that_opens_is_the_verdicts_not_the_guests() {
        // The sidecar returns the normalised href (loopback hosts become 127.0.0.1); that is what opens.
        let h = Harness::new();
        let out = h.run("http://localhost:4212/a", Ok(json!({ "action": "openExternal", "url": "http://127.0.0.1:4212/a" })), Ok(()));
        assert_eq!(out, Outcome::Opened);
        assert_eq!(*h.open_calls.borrow(), vec!["http://127.0.0.1:4212/a".to_string()]);
    }

    #[test]
    fn a_policy_refusal_or_none_opens_nothing_and_adds_no_rust_log() {
        let h = Harness::new();
        assert_eq!(h.run("https://evil.example/", Ok(json!({ "action": "refuse", "reason": "url_not_allowed", "origin": "https://evil.example" })), Ok(())), Outcome::Refused);
        assert_eq!(h.run("http://127.0.0.1:1/", Ok(json!({ "action": "none" })), Ok(())), Outcome::Ignored);
        assert_eq!(h.opened(), 0);
        assert!(h.logs.borrow().is_empty(), "the sidecar already logged its refusal");
    }

    #[test]
    fn a_verdict_url_that_fails_revalidation_is_refused_and_logged_as_host_revalidate() {
        // Even a (hypothetical) policy bug cannot reach the shell with these.
        for bad in [
            "javascript:alert(1)",
            "file:///C:/x",
            "ms-msdt:x",
            "data:text/html,1",
            r"\\server\share",
            "https://a@b.example/",
            "https://zumia.space/\n",
            &format!("https://a.example/{}", "x".repeat(MAX_URL_LEN)),
        ] {
            let h = Harness::new();
            let out = h.run("https://zumia.space/", Ok(json!({ "action": "openExternal", "url": bad })), Ok(()));
            assert_eq!(out, Outcome::Refused, "{bad:?}");
            assert_eq!(h.opened(), 0, "{bad:?} must not reach the shell");
            let logs = h.logs.borrow();
            assert_eq!(logs.len(), 1);
            assert_eq!(logs[0].0, "host_revalidate");
            assert!(!logs[0].1.contains("alert") && !logs[0].1.contains('?') && !logs[0].1.contains('#') && !logs[0].1.contains('@') && logs[0].1.len() < 64, "origin only: {}", logs[0].1);
        }
    }

    #[test]
    fn the_sidecar_failing_in_any_way_fails_closed() {
        // error / timeout / a JSON-RPC "method not found" all surface as Err from Rpc::call.
        for err in ["sidecar_not_ready", "timeout", "rpc_error:-32601:not_implemented:__host.decideExternalUrl", "sidecar_exited"] {
            let h = Harness::new();
            let out = h.run("https://zumia.space/", Err(err.to_string()), Ok(()));
            assert_eq!(out, Outcome::Failed, "{err}");
            assert_eq!(h.opened(), 0, "{err}");
            assert_eq!(*h.logs.borrow(), vec![("sidecar_failed".to_string(), "https://zumia.space".to_string())]);
        }
    }

    #[test]
    fn a_malformed_verdict_fails_closed() {
        for answer in [
            json!(null),
            json!(true),
            json!("openExternal"),
            json!([]),
            json!({}),
            json!({ "action": "open" }),
            json!({ "action": "OpenExternal", "url": "https://zumia.space/" }),
            json!({ "action": "openExternal" }),
            json!({ "action": "openExternal", "url": 42 }),
            json!({ "action": "openExternal", "url": null }),
            json!({ "allow": true, "url": "https://zumia.space/" }),
            json!({ "action": 1 }),
        ] {
            let h = Harness::new();
            let out = h.run("https://zumia.space/", Ok(answer.clone()), Ok(()));
            assert_eq!(out, Outcome::Failed, "{answer}");
            assert_eq!(h.opened(), 0, "{answer}");
            assert_eq!(h.logs.borrow()[0].0, "sidecar_malformed", "{answer}");
        }
    }

    #[test]
    fn a_shell_failure_is_logged_once_and_not_retried() {
        let h = Harness::new();
        let out = h.run("https://zumia.space/", Ok(json!({ "action": "openExternal", "url": "https://zumia.space/" })), Err("shell_execute_failed:31".to_string()));
        assert_eq!(out, Outcome::Failed);
        assert_eq!(h.opened(), 1, "one attempt, no retry");
        assert_eq!(*h.logs.borrow(), vec![("shell_failed".to_string(), "https://zumia.space".to_string())]);
    }

    #[test]
    fn an_oversized_guest_url_never_reaches_the_sidecar() {
        let h = Harness::new();
        let out = h.run(&format!("https://a.example/{}", "x".repeat(MAX_URL_LEN)), Ok(json!({ "action": "openExternal", "url": "https://a.example/" })), Ok(()));
        assert_eq!(out, Outcome::Refused);
        assert_eq!(h.decide_calls.get(), 0);
        assert_eq!(h.opened(), 0);
        assert_eq!(*h.logs.borrow(), vec![("host_revalidate".to_string(), "-".to_string())]);
    }

    #[test]
    fn the_verdict_parser_is_strict() {
        assert_eq!(parse_verdict(&json!({ "action": "openExternal", "url": "https://a/" })), Ok(Verdict::Open("https://a/".to_string())));
        assert_eq!(parse_verdict(&json!({ "action": "refuse", "reason": "x" })), Ok(Verdict::Refuse));
        assert_eq!(parse_verdict(&json!({ "action": "none" })), Ok(Verdict::Nothing));
        assert_eq!(parse_verdict(&json!({ "action": "other" })), Err(()));
    }
}
