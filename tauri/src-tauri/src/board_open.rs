// T-31-TAURI P3-B — the owner board's "open this" chips (`/__zumi-open`), the Tauri half of Electron's main.js `boardOpen`.
//
// There is NO HTTP route for it: the board page opens `<its bridge origin>/__zumi-open?path=|url=` as a new window (a chip
// is `<a target="_blank">`) or navigates to it, and the guest webview's own `on_new_window` / `on_navigation` callback
// (guest.rs) intercepts that request before it loads. The bridge itself answers 401 (no caller cookie) or 404 for the
// same path (scripts/check-tauri-board-live-open.mjs), so no local process can make the host open anything by calling it.
//
// Three independent checks stand between a chip and `ShellExecuteW`, each fail-closed:
//   1. here, before the sidecar is asked: the request must come from the Board tab guest (`opener_is_board`), the host's OWN
//      flavour must be the owner's (`owner`, never a claim from the sidecar or the page), and the URL must be exactly the
//      `/__zumi-open` pathname within the length cap;
//   2. the sidecar's verdict (`__host.boardOpenVerdict` = board-open.mjs `decideBoardOpen`, unchanged): the live bridge origin,
//      the opener page, OPEN_ROOTS / OPEN_EXT, the real path with junctions and `..` resolved, name tricks;
//   3. the opener closures re-validate: `open_path::open_path_on_main_with_timeout` re-checks the same roots and extensions
//      against the real filesystem (a second, independent port), `shell_ops::open_external_with` re-validates a web URL.
//
// `handle_board_open` takes every side effect as a closure, so each branch is tested without a sidecar, a window or a shell.

use serde_json::Value;
use tauri::Url;

use crate::shell_ops::{log_origin, MAX_URL_LEN};

/// The one request pathname this module acts on (board-open.mjs OPEN_PATHNAME).
pub const OPEN_PATHNAME: &str = "/__zumi-open";

/// Refusal words Rust originates (each matches the sidecar log helper's `/^[a-z_]+$/`).
const REASON_OPENER: &str = "opener_not_board_tab";
/// The sidecar said the opener is not the live bridge origin (a stale guest after setMode('local') / signOut): same word the
/// external-link policy uses for the board's own routes. Behaviour is unchanged (nothing opens, outcome stays Ignored).
const REASON_BRIDGE_ROUTE: &str = "bridge_route";
const REASON_NOT_OWNER: &str = "not_owner_build";
const REASON_SIDECAR_FAILED: &str = "sidecar_failed";
const REASON_SIDECAR_MALFORMED: &str = "sidecar_malformed";
const REASON_OPEN_FAILED: &str = "shell_failed";

/// What one chip request ended as. The name is the only thing logged (never a path or URL).
#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    Opened,
    /// A policy refusal (ours or the sidecar's, which already logged its own).
    Refused,
    /// Not an open request at all (another pathname, or the sidecar says it is not the live bridge origin).
    Ignored,
    /// The sidecar failed or answered garbage, or the shell failed; nothing opened.
    Failed,
}

/// True when `url` is a request for the open route: any host/port (the guest callback already pinned the origin), exactly
/// the `/__zumi-open` pathname.
pub fn is_open_request(url: &Url) -> bool {
    url.path() == OPEN_PATHNAME
}

/// S1: the board's own bridge routes on a loopback host. They are never handed to the OS browser (external-link path), whatever
/// the sidecar believes about the live origin: an intercepted /__zumi-open is terminal, and the single-use session URL is dead
/// weight outside the guest. (A chip's own `?url=http://127.0.0.1:4320/` preview is a different path and still opens.)
pub fn is_bridge_link(url: &str) -> bool {
    let Ok(u) = Url::parse(url) else { return false };
    let loopback = matches!(u.host_str(), Some("127.0.0.1") | Some("localhost") | Some("[::1]"));
    loopback && matches!(u.path(), OPEN_PATHNAME | "/__bridge-session")
}

/// The testable seam of the production wiring (guest.rs request_board_open): the opener flag is derived HERE from the guest
/// label (only the Board tab guest passes), and `owner` is the host's own flavour flag the caller reads from the Rpc.
#[allow(clippy::too_many_arguments)]
pub fn board_open_for_label(
    label: &str,
    url: &str,
    owner: bool,
    decide: impl FnOnce(&str) -> Result<Value, String>,
    open_path: impl FnOnce(&str) -> Result<(), String>,
    open_external: impl FnOnce(&str) -> Result<(), String>,
    log: impl FnMut(&str, &str),
) -> Outcome {
    handle_board_open(url, crate::guest::is_board_label(label), owner, decide, open_path, open_external, log)
}

/// The sidecar's answer, parsed strictly: a missing or odd `action`, an `openPath` without a string `path`, an
/// `openExternal` without a string `url`, or a non-object is malformed, never "allow".
#[derive(Debug, PartialEq, Eq)]
enum Verdict {
    OpenPath(String),
    OpenExternal(String),
    Refuse,
    None,
}

fn parse_verdict(v: &Value) -> Result<Verdict, ()> {
    let s = |key: &str| v.get(key).and_then(Value::as_str).map(str::to_string);
    match v.get("action").and_then(Value::as_str) {
        Some("openPath") => s("path").map(Verdict::OpenPath).ok_or(()),
        Some("openExternal") => s("url").map(Verdict::OpenExternal).ok_or(()),
        Some("refuse") => Ok(Verdict::Refuse),
        Some("none") => Ok(Verdict::None),
        _ => Err(()),
    }
}

/// Decide and (maybe) open one chip. `decide` asks the sidecar (the caller supplies the opener page URL itself);
/// `open_path` / `open_external` re-validate and open; `log(reason, origin)` records a refusal only Rust knows.
pub fn handle_board_open(
    url: &str,
    opener_is_board: bool,
    owner: bool,
    decide: impl FnOnce(&str) -> Result<Value, String>,
    open_path: impl FnOnce(&str) -> Result<(), String>,
    open_external: impl FnOnce(&str) -> Result<(), String>,
    mut log: impl FnMut(&str, &str),
) -> Outcome {
    if url.len() > MAX_URL_LEN {
        log("host_revalidate", "-");
        return Outcome::Refused;
    }
    let Ok(parsed) = Url::parse(url) else { return Outcome::Ignored };
    if !is_open_request(&parsed) {
        return Outcome::Ignored;
    }
    let origin = log_origin(url);
    if !opener_is_board {
        log(REASON_OPENER, &origin);
        return Outcome::Refused;
    }
    if !owner {
        log(REASON_NOT_OWNER, &origin);
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
        Ok(Verdict::None) => {
            log(REASON_BRIDGE_ROUTE, &origin);
            Outcome::Ignored
        }
        Ok(Verdict::Refuse) => Outcome::Refused,
        Ok(Verdict::OpenPath(path)) => match open_path(&path) {
            Ok(()) => Outcome::Opened,
            // The re-validation refused what the sidecar allowed: a policy refusal, logged as the word it is.
            Err(reason) if is_policy_refusal(&reason) => {
                log(&reason, &origin);
                Outcome::Refused
            }
            Err(_) => {
                log(REASON_OPEN_FAILED, &origin);
                Outcome::Failed
            }
        },
        Ok(Verdict::OpenExternal(link)) => match open_external(&link) {
            Ok(()) => Outcome::Opened,
            Err(reason) if reason == "host_revalidate" => {
                log("host_revalidate", &log_origin(&link));
                Outcome::Refused
            }
            Err(_) => {
                log(REASON_OPEN_FAILED, &log_origin(&link));
                Outcome::Failed
            }
        },
    }
}

/// The words `open_path::Refusal::reason()` can return: the re-validation said no (not a shell fault).
fn is_policy_refusal(reason: &str) -> bool {
    matches!(
        reason,
        "not_owner_build"
            | "not_an_absolute_drive_path"
            | "name_trick"
            | "not_found"
            | "outside_allowed_folders"
            | "type_not_allowed"
    )
}

#[cfg(test)]
mod tests {
    use std::cell::{Cell, RefCell};

    use serde_json::json;

    use super::*;

    const CHIP: &str = "http://127.0.0.1:4545/__zumi-open?path=C%3A%2Fdata%2Fnote.md";

    struct Spy {
        asked: Cell<u32>,
        path_opened: RefCell<Vec<String>>,
        ext_opened: RefCell<Vec<String>>,
        logged: RefCell<Vec<(String, String)>>,
    }
    impl Spy {
        fn new() -> Self {
            Spy { asked: Cell::new(0), path_opened: RefCell::new(vec![]), ext_opened: RefCell::new(vec![]), logged: RefCell::new(vec![]) }
        }
        fn run(&self, url: &str, board: bool, owner: bool, answer: Result<Value, String>, path_res: Result<(), String>, ext_res: Result<(), String>) -> Outcome {
            handle_board_open(
                url,
                board,
                owner,
                |_| { self.asked.set(self.asked.get() + 1); answer },
                |p| { self.path_opened.borrow_mut().push(p.to_string()); path_res },
                |u| { self.ext_opened.borrow_mut().push(u.to_string()); ext_res },
                |r, o| self.logged.borrow_mut().push((r.to_string(), o.to_string())),
            )
        }
        fn nothing_opened(&self) -> bool {
            self.path_opened.borrow().is_empty() && self.ext_opened.borrow().is_empty()
        }
    }

    #[test]
    fn a_valid_md_chip_from_the_owner_board_guest_opens_the_path() {
        let spy = Spy::new();
        let out = spy.run(CHIP, true, true, Ok(json!({ "action": "openPath", "path": "C:\\data\\note.md", "kind": "file" })), Ok(()), Ok(()));
        assert_eq!(out, Outcome::Opened);
        assert_eq!(spy.path_opened.borrow().as_slice(), ["C:\\data\\note.md"]);
        assert!(spy.ext_opened.borrow().is_empty());
        assert!(spy.logged.borrow().is_empty());
    }

    #[test]
    fn a_web_chip_opens_through_the_external_opener_only() {
        let spy = Spy::new();
        let out = spy.run("http://127.0.0.1:4545/__zumi-open?url=https%3A%2F%2Fzumia.space%2F", true, true, Ok(json!({ "action": "openExternal", "url": "https://zumia.space/" })), Ok(()), Ok(()));
        assert_eq!(out, Outcome::Opened);
        assert_eq!(spy.ext_opened.borrow().as_slice(), ["https://zumia.space/"]);
        assert!(spy.path_opened.borrow().is_empty());
    }

    #[test]
    fn any_guest_but_the_board_tab_is_refused_before_the_sidecar_is_asked() {
        let spy = Spy::new();
        let out = spy.run(CHIP, false, true, Ok(json!({ "action": "openPath", "path": "C:\\data\\note.md" })), Ok(()), Ok(()));
        assert_eq!(out, Outcome::Refused);
        assert_eq!(spy.asked.get(), 0, "any other opener never reaches the sidecar");
        assert!(spy.nothing_opened());
        assert_eq!(spy.logged.borrow()[0].0, "opener_not_board_tab");
    }

    #[test]
    fn the_public_flavour_is_refused_by_the_hosts_own_flag_even_if_the_sidecar_would_allow() {
        let spy = Spy::new();
        let out = spy.run(CHIP, true, false, Ok(json!({ "action": "openPath", "path": "C:\\data\\note.md" })), Ok(()), Ok(()));
        assert_eq!(out, Outcome::Refused);
        assert_eq!(spy.asked.get(), 0);
        assert!(spy.nothing_opened());
        assert_eq!(spy.logged.borrow()[0].0, "not_owner_build");
    }

    #[test]
    fn only_the_exact_open_pathname_is_acted_on() {
        for url in [
            "http://127.0.0.1:4545/",
            "http://127.0.0.1:4545/__zumi-open/",
            "http://127.0.0.1:4545/__zumi-openx?path=x",
            "http://127.0.0.1:4545/a/__zumi-open?path=x",
            "http://127.0.0.1:4545/__bridge-session?n=1",
            "not a url",
            "",
        ] {
            let spy = Spy::new();
            let out = spy.run(url, true, true, Ok(json!({ "action": "openPath", "path": "C:\\data\\note.md" })), Ok(()), Ok(()));
            assert_eq!(out, Outcome::Ignored, "{url:?}");
            assert_eq!(spy.asked.get(), 0, "{url:?}: the sidecar is not asked");
            assert!(spy.nothing_opened(), "{url:?}");
        }
    }

    #[test]
    fn an_oversized_request_is_refused_unasked() {
        let spy = Spy::new();
        let big = format!("http://127.0.0.1:4545/__zumi-open?path={}", "a".repeat(MAX_URL_LEN));
        assert_eq!(spy.run(&big, true, true, Ok(json!({ "action": "openPath", "path": "x" })), Ok(()), Ok(())), Outcome::Refused);
        assert_eq!(spy.asked.get(), 0);
        assert!(spy.nothing_opened());
    }

    #[test]
    fn a_sidecar_refusal_or_none_opens_nothing() {
        let spy = Spy::new();
        assert_eq!(spy.run(CHIP, true, true, Ok(json!({ "action": "refuse", "reason": "outside_allowed_folders" })), Ok(()), Ok(())), Outcome::Refused);
        assert!(spy.nothing_opened());
        let spy = Spy::new();
        assert_eq!(spy.run(CHIP, true, true, Ok(json!({ "action": "none" })), Ok(()), Ok(())), Outcome::Ignored);
        assert!(spy.nothing_opened());
        // G5(iii)/(iv): a stale guest (setMode local / signOut) now leaves a reason, origin only, and still opens nothing.
        assert_eq!(spy.logged.borrow().as_slice(), [("bridge_route".to_string(), "http://127.0.0.1:4545".to_string())]);
    }

    #[test]
    fn a_failed_or_malformed_sidecar_answer_fails_closed() {
        for answer in [
            Err("timeout".to_string()),
            Ok(json!(null)),
            Ok(json!({})),
            Ok(json!({ "action": "allow" })),
            Ok(json!({ "action": "openPath" })),
            Ok(json!({ "action": "openPath", "path": 5 })),
            Ok(json!({ "action": "openExternal" })),
            Ok(json!({ "path": "C:\\data\\note.md" })),
            Ok(json!("openPath")),
        ] {
            let spy = Spy::new();
            let out = spy.run(CHIP, true, true, answer.clone(), Ok(()), Ok(()));
            assert_eq!(out, Outcome::Failed, "{answer:?}");
            assert!(spy.nothing_opened(), "{answer:?}");
        }
    }

    #[test]
    fn the_opener_revalidation_refusing_is_a_refusal_and_a_shell_error_is_a_failure() {
        let spy = Spy::new();
        let out = spy.run(CHIP, true, true, Ok(json!({ "action": "openPath", "path": "C:\\Windows\\win.ini" })), Err("outside_allowed_folders".into()), Ok(()));
        assert_eq!(out, Outcome::Refused);
        assert_eq!(spy.logged.borrow()[0].0, "outside_allowed_folders");
        let spy = Spy::new();
        let out = spy.run(CHIP, true, true, Ok(json!({ "action": "openPath", "path": "C:\\data\\note.md" })), Err("shell_dispatch:boom".into()), Ok(()));
        assert_eq!(out, Outcome::Failed);
        assert_eq!(spy.logged.borrow()[0].0, "shell_failed");
    }

    #[test]
    fn the_label_seam_lets_only_the_board_guest_open_and_only_for_the_owner() {
        let allow = || Ok(json!({ "action": "openPath", "path": "C:/data/note.md" }));
        for (label, owner, want) in [
            ("guest-board-0", true, Outcome::Opened),
            ("guest-board-7", true, Outcome::Opened),
            ("guest-wardrobe-0", true, Outcome::Refused),
            ("main", true, Outcome::Refused),
            ("", true, Outcome::Refused),
            ("guest-board-0", false, Outcome::Refused),
        ] {
            let opened = Cell::new(false);
            let out = board_open_for_label(label, CHIP, owner, |_| allow(), |_| { opened.set(true); Ok(()) }, |_| Ok(()), |_, _| {});
            assert_eq!(out, want, "{label} owner={owner}");
            assert_eq!(opened.get(), want == Outcome::Opened, "{label} owner={owner}");
        }
    }

    #[test]
    fn bridge_routes_are_never_an_os_browser_link() {
        for url in [
            "http://127.0.0.1:4545/__zumi-open?path=D%3A%2Fx.md",
            "http://localhost:4545/__zumi-open",
            "http://127.0.0.1:4545/__bridge-session?n=abc",
        ] {
            assert!(is_bridge_link(url), "{url}");
        }
        for url in ["http://127.0.0.1:4320/", "https://zumia.space/__zumi-open", "https://zumia.space/", "not a url", "http://127.0.0.1:1/__zumi-openx"] {
            assert!(!is_bridge_link(url), "{url}");
        }
    }

    #[test]
    fn the_guest_wiring_is_pinned_in_source() {
        let src = include_str!("guest.rs");
        let body = |start: &str| { let i = src.find(start).expect(start); &src[i..(i + 1800).min(src.len())] };
        let nav = body(".on_navigation(move |url|");
        assert!(nav.contains("nav_action(url, &nav_origin, opener_is_board)") && nav.contains("NavAction::BoardOpen => {") && nav.contains("request_board_open(&nav_app, &nav_label,"), "navigation interception");
        assert!(nav.contains("NavAction::Cancel => false"), "a cancelled navigation stays cancelled");
        let win = body(".on_new_window(move |url, _features|");
        assert!(win.contains("window_action(&url, &window_origin, opener_is_board)") && win.contains("WindowAction::BoardOpen => request_board_open(&window_app, &window_label,"), "new-window interception");
        assert!(win.contains("NewWindowResponse::<tauri::Wry>::Deny"), "the window is always denied");
        let req = body("pub(crate) fn request_board_open(");
        assert!(req.contains("let owner = crate::request_owner(&client);") && req.contains("board_open::board_open_for_label(") && req.contains("&label,") && req.contains("owner,"), "owner flag comes from the host's own Rpc, label from the guest");
        assert!(!req.contains("true,"), "no literal true is passed for owner/opener");
        let ext = body("pub(crate) fn request_external_open(");
        assert!(ext.contains("board_open::is_bridge_link(&url)"), "S1 guard at the top of request_external_open");
    }

    #[test]
    fn the_log_origin_never_carries_the_path_or_query() {
        let spy = Spy::new();
        spy.run(CHIP, false, true, Ok(json!(null)), Ok(()), Ok(()));
        let logged = spy.logged.borrow();
        assert_eq!(logged[0].1, "http://127.0.0.1:4545");
        assert!(!logged[0].1.contains("note.md") && !logged[0].1.contains("__zumi-open"));
    }

    #[test]
    fn the_logged_reasons_are_the_log_helpers_word_shape() {
        for r in [REASON_OPENER, REASON_NOT_OWNER, REASON_SIDECAR_FAILED, REASON_SIDECAR_MALFORMED, REASON_OPEN_FAILED] {
            assert!(r.bytes().all(|b| b.is_ascii_lowercase() || b == b'_'), "{r}");
        }
    }
}
