// T-31 P1c1 — guest request guard + exact load-status decisions.
//
// Two jobs, both mirroring Electron's src/main/main.js:
//   1. `guard_blocks` is the exact port of `guardSession`'s loopback-only rule (main.js:585-594):
//      every non-loopback http/https/ws/wss/ftp request a guest makes is refused before it leaves the
//      PC. The wider rule is "refuse network requests, allow loopback" — a superset of Electron's
//      app: / ipc: traffic stays allowed because those schemes are not network schemes.
//   2. `nav_outcome` replaces the deleted TCP preflight: a guest load that fails now reports a
//      Chromium-style `did-fail-load` code mapped from WebView2's NavigationCompleted status.
//   3. ws/wss: WebView2 raises no WebResourceRequested for a WebSocket handshake (probe-p1c4 `ws: LEAK`), so this filter
//      cannot cancel one. The guest page's own CSP closes it: board-bridge.mjs serves every guest HTML response with
//      GUEST_HTML_CSP (`connect-src 'self'`); scripts/check-tauri-board-csp.mjs pins it. A GUI re-probe must flip the
//      LEAK row to BLOCKED_BY_CSP before board.liveOpen turns on.
//
// `guard_blocks` and `nav_outcome` are pure and unit-tested. The only `cfg(windows)` piece is the
// `install_guard` COM block below, which needs a live WebView2 and a window — never opened on the
// main PC. It is also the only user of the `COREWEBVIEW2_*` constants.
//
// A refused request is answered with a constant synthetic 403 (WebView2 offers no "cancel"): status
// 403, reason "Blocked by Zumi", empty body, no headers — the request method, URI and headers are
// never echoed. This is not byte-identical to Electron's net::ERR_BLOCKED_BY_CLIENT (gate Q2).
//
// P1c4: the main webview gets the same filter + 403 (`install_main_guard`), with one widening: Tauri's
// own in-process hosts `tauri.localhost` / `ipc.localhost` (Electron's `app://` equivalent, answered by
// the app and never by the network). Guests keep blocking both hosts. Main also gets the top-level
// navigation lock (`main_nav_allowed`). The filter install is one function (`install_request_filter`)
// shared by guests and main.
//
// Every guest blocks `ipc.localhost` and `tauri.localhost` (`guard_blocks`). The one guest exception (the wardrobe
// bridge's `ipc.localhost`, parity 11-2) was removed with the wardrobe in 0.3.0-alpha.11.

use std::sync::mpsc;

use tauri::webview::PlatformWebview;
use tauri::{AppHandle, Url};

#[cfg(windows)]
use std::cell::Cell;
#[cfg(windows)]
use std::rc::Rc;

#[cfg(windows)]
use serde_json::json;
#[cfg(windows)]
use tauri::{Emitter, Manager};
#[cfg(windows)]
use webview2_com::Microsoft::Web::WebView2::Win32 as w32;
#[cfg(windows)]
use webview2_com::{
    take_pwstr, NavigationCompletedEventHandler, NavigationStartingEventHandler,
    WebResourceRequestedEventHandler,
};
#[cfg(windows)]
use windows_core::{Interface, BOOL, PCWSTR, PWSTR};

#[cfg(windows)]
use crate::guest::{GuestRegistry, MAIN_LABEL};

/// Electron's `LOOPBACK_HOSTS` (main.js:129). Exact match, never widened: `127.0.0.2`, `0.0.0.0`,
/// `localhost.` and `ipc.localhost` are remote and are blocked, exactly as in Electron, for every guest.
const LOOPBACK_HOSTS: [&str; 4] = ["127.0.0.1", "localhost", "[::1]", "::1"];

/// The schemes Electron treats as a network request (main.js:587, `/^(https?|wss?|ftp):$/`). Anything
/// else (app:, ipc:, data:, blob:, about:, filesystem:) is not a network request and is allowed.
pub(crate) fn is_network_scheme(scheme: &str) -> bool {
    matches!(scheme, "http" | "https" | "ws" | "wss" | "ftp")
}

/// Exact port of `guardSession`'s verdict (main.js:585-594). `true` means "this request must be
/// refused". An unparsable URL is not a network URL (`false`, let through); otherwise a network
/// request is refused unless its host is exactly one of `LOOPBACK_HOSTS`.
pub fn guard_blocks(uri: &str) -> bool {
    let Ok(url) = Url::parse(uri) else { return false };
    if !is_network_scheme(url.scheme()) {
        return false;
    }
    !url.host_str().is_some_and(|host| LOOPBACK_HOSTS.contains(&host))
}

/// The two hosts Tauri answers in-process on Windows (wry's `http://<protocol>.localhost` workaround for
/// the `tauri` and `ipc` custom protocols). They are the main webview's `app://` (Electron parity): the
/// request never reaches the network. Exact match, http only, no explicit port.
const MAIN_APP_HOSTS: [&str; 2] = ["tauri.localhost", "ipc.localhost"];

/// `http://tauri.localhost` or `http://ipc.localhost`, default port. `https://`, any other port and any
/// sub/superdomain (`a.tauri.localhost`, `tauri.localhost.evil.example`) are not app hosts. (`url` drops
/// an explicit default port, so `http://tauri.localhost:80/` is the same origin and counts.)
fn is_app_host(url: &Url) -> bool {
    url.scheme() == "http" && url.port().is_none() && url.host_str().is_some_and(|host| MAIN_APP_HOSTS.contains(&host))
}

/// The main webview's verdict: the guest rule (`guard_blocks`) minus the app's own two hosts. `true`
/// means "refuse". Unparsable is allowed, as for guests.
pub fn main_guard_blocks(uri: &str) -> bool {
    let Ok(url) = Url::parse(uri) else { return false };
    guard_blocks(uri) && !is_app_host(&url)
}

/// Main's top-level navigation lock (Electron: `will-navigate` prevents anything not starting with
/// `app://`). Only the app page itself, `http://tauri.localhost`, may be navigated to — reload and
/// fragment changes included. Loopback, `about:blank`, `file:`, `data:` and every remote URL are refused.
pub fn main_nav_allowed(url: &Url) -> bool {
    url.scheme() == "http" && url.port().is_none() && url.host_str() == Some("tauri.localhost")
}

/// Answer the app's own asset protocol (`tauri.localhost`) with the same constant synthetic 403 the
/// request guard uses. wry answers that protocol asynchronously and overwrites the 403 set from
/// `WebResourceRequested`, so this `on_web_resource_request` hook — which tauri runs on the built asset
/// response just before it is handed to wry — is the write that actually reaches a guest.
pub fn deny_app_asset(response: &mut tauri::http::Response<std::borrow::Cow<'static, [u8]>>) {
    *response.status_mut() = tauri::http::StatusCode::FORBIDDEN;
    response.headers_mut().clear();
    *response.body_mut() = std::borrow::Cow::Borrowed(&[]);
}

/// The guest's answer to one `tauri.localhost` request. A path in one of the parity-4b asset namespaces
/// (asset_route) is a bare 404: the route serves main only, and a guest learns nothing about whether an
/// imported avatar, room or video exists on this PC — a 403 there would say "this file path is special".
/// Every other app asset keeps the constant synthetic 403.
pub fn deny_guest_asset(
    path: &str,
    response: &mut tauri::http::Response<std::borrow::Cow<'static, [u8]>>,
) {
    if crate::asset_route::is_asset_path(path) {
        crate::asset_route::not_found(response);
    } else {
        deny_app_asset(response);
    }
}

/// A guest load's outcome, mirroring Electron's `did-finish-load` / `did-fail-load` split.
#[derive(Debug, PartialEq, Eq)]
pub enum NavOutcome {
    Finished,
    Failed { code: i32, description: &'static str },
}

/// Map a WebView2 NavigationCompleted result to the shim's outcome. Electron fires no `did-fail-load`
/// for an HTTP error response, so a non-success navigation that still produced an HTTP status in
/// `100..=599` counts as Finished. Everything else maps through `net_error`.
pub fn nav_outcome(is_success: bool, http_status: Option<i32>, web_error: i32) -> NavOutcome {
    if is_success {
        return NavOutcome::Finished;
    }
    if matches!(http_status, Some(status) if (100..=599).contains(&status)) {
        return NavOutcome::Finished;
    }
    let (code, description) = net_error(web_error);
    NavOutcome::Failed { code, description }
}

/// The in-flight navigation decision for one `NavigationStarting`. A refused navigation (wry's
/// same-origin `on_navigation` cancelled it) is `Clear` — its `NavigationCompleted` must emit nothing.
/// The `about:blank` bootstrap is `Ignore`; anything else arms the id.
#[derive(Debug, PartialEq, Eq)]
enum NavStart {
    Clear,
    Ignore,
    Arm,
}

/// Decide one `NavigationStarting`. Pure: a refused navigation clears, the bootstrap is ignored,
/// anything else arms. `url` is only meaningful when `cancelled` is false (the caller never reads the
/// URI of a refused navigation).
fn nav_start_action(cancelled: bool, url: &str) -> NavStart {
    if cancelled {
        NavStart::Clear
    } else if url == "about:blank" {
        NavStart::Ignore
    } else {
        NavStart::Arm
    }
}

/// Gate P1c3 condition 3: only a top-level, non-redirect navigation that wry's same-origin rule refused
/// asks the external-link policy. A redirect hop (`IsRedirected`) is never consulted (the P1c1 refusal
/// stands), the `about:blank` bootstrap is not a link, and an allowed navigation is not a link either.
/// Iframe navigations never reach this handler: WebView2 reports them as FrameNavigationStarting, which
/// is not hooked. Pure so the redirect rule is tested.
fn consults_external_policy(cancelled: bool, redirected: bool, url: &str) -> bool {
    cancelled && !redirected && !url.is_empty() && url != "about:blank"
}

/// One `NavigationStarting` fully decided: what to do with the in-flight id, and the link (if any) to
/// hand to the external-link policy.
#[derive(Debug, PartialEq, Eq)]
struct NavStartDecision {
    action: NavStart,
    forward: Option<String>,
}

/// Combine what the handler read from COM into one decision. Pure and generic over the error so the
/// failure paths are tested without COM. Fail closed: a failed `IsRedirected` read counts as a redirect
/// (the policy is not consulted, the P1c1 refusal stands) and does NOT abort the decision, so a refused
/// navigation still clears the in-flight id. A failed `Uri` read is fatal only for an allowed navigation
/// (no id can be armed without knowing it is not `about:blank`); a refused one just forwards no link.
fn decide_navigation_start<E>(
    cancelled: bool,
    redirected: Result<bool, E>,
    uri: Result<String, E>,
) -> Result<NavStartDecision, E> {
    let redirected = redirected.unwrap_or(true);
    let url = match uri {
        Ok(url) => url,
        Err(_) if cancelled => String::new(),
        Err(e) => return Err(e),
    };
    let forward = consults_external_policy(cancelled, redirected, &url).then(|| url.clone());
    let action = nav_start_action(cancelled, if cancelled { "" } else { &url });
    Ok(NavStartDecision { action, forward })
}

/// Whether a `NavigationCompleted` with `nav_id` belongs to the in-flight navigation and is therefore
/// reported. A cleared id (a refused navigation, or one already completed) never matches, so a refused
/// redirect's `-3` status emits nothing and the shim does not hide the guest.
fn completion_is_reported(in_flight: Option<u64>, nav_id: u64) -> bool {
    in_flight == Some(nav_id)
}

/// What to do with one request the guest guard saw. Fail closed: `Block` unless we could read the URI
/// and it is not a remote network request. An unreadable URI (a COM error on any path) is `Block`, so a
/// failed COM call can never let a request fall through to the network.
#[derive(Debug, PartialEq, Eq)]
enum RequestVerdict {
    Allow,
    Block,
}

/// Pure verdict for one request: `Some(uri)` is allowed only when `blocks` (the guest rule or the main
/// rule) says it is not a remote network request; `None` (the URI could not be read) is always blocked.
fn request_verdict(uri: Option<&str>, blocks: &dyn Fn(&str) -> bool) -> RequestVerdict {
    match uri {
        Some(uri) if !blocks(uri) => RequestVerdict::Allow,
        _ => RequestVerdict::Block,
    }
}

/// The Chromium `net::Error` code + name for a failed WebView2 load, matched on the named
/// `COREWEBVIEW2_WEB_ERROR_STATUS_*` constants (never a literal).
///
/// `CANNOT_CONNECT` (0xC, "a connection to the destination was not established" in Microsoft's enum
/// docs) is the refused-connection row and maps to `ERR_CONNECTION_REFUSED`. Everything unlisted maps
/// to `ERR_FAILED` (-2): the enum has no dedicated refused row, and `UNKNOWN` (0x0) is documented as
/// "an unknown error occurred". The spare-PC run measured -2 for a stopped loopback server, which means
/// the runtime reported a row this mapping does not name (UNKNOWN is the documented catch-all); that is
/// an honest -2, not a mapping bug. `did-fail-load` also carries the raw `webErrorStatus` so the next
/// run names the row. Do not map the default to -102.
#[cfg(windows)]
fn net_error(web_error: i32) -> (i32, &'static str) {
    match web_error {
        v if v == w32::COREWEBVIEW2_WEB_ERROR_STATUS_CANNOT_CONNECT.0 => (-102, "ERR_CONNECTION_REFUSED"),
        v if v == w32::COREWEBVIEW2_WEB_ERROR_STATUS_OPERATION_CANCELED.0 => (-3, "ERR_ABORTED"),
        v if v == w32::COREWEBVIEW2_WEB_ERROR_STATUS_TIMEOUT.0 => (-7, "ERR_TIMED_OUT"),
        v if v == w32::COREWEBVIEW2_WEB_ERROR_STATUS_CONNECTION_RESET.0 => (-101, "ERR_CONNECTION_RESET"),
        v if v == w32::COREWEBVIEW2_WEB_ERROR_STATUS_CONNECTION_ABORTED.0 => (-103, "ERR_CONNECTION_ABORTED"),
        v if v == w32::COREWEBVIEW2_WEB_ERROR_STATUS_DISCONNECTED.0 => (-106, "ERR_INTERNET_DISCONNECTED"),
        v if v == w32::COREWEBVIEW2_WEB_ERROR_STATUS_HOST_NAME_NOT_RESOLVED.0 => (-105, "ERR_NAME_NOT_RESOLVED"),
        v if v == w32::COREWEBVIEW2_WEB_ERROR_STATUS_SERVER_UNREACHABLE.0 => (-109, "ERR_ADDRESS_UNREACHABLE"),
        v if v == w32::COREWEBVIEW2_WEB_ERROR_STATUS_ERROR_HTTP_INVALID_SERVER_RESPONSE.0 => (-320, "ERR_INVALID_RESPONSE"),
        _ => (-2, "ERR_FAILED"),
    }
}

/// The guard is WebView2-only; any other platform fail-closes exactly like a failed install, so a
/// guest can never run unguarded. (The preview itself only ever builds for Windows.)
#[cfg(not(windows))]
fn net_error(_web_error: i32) -> (i32, &'static str) {
    (-2, "ERR_FAILED")
}

/// Install the loopback-only request guard + the NavigationCompleted status reporter on one guest,
/// then report `Ok(source_kinds)` (`"all"` or `"document-only"`) or `Err(reason)` on `tx`. Runs on the
/// webview's own thread (`with_webview` marshals there). Every error is reported, never swallowed:
/// the caller closes the guest on any `Err`.
#[cfg(windows)]
pub fn install_guard(
    platform: PlatformWebview,
    app: AppHandle,
    id: u64,
    label: String,
    tx: mpsc::Sender<Result<String, String>>,
) {
    // SAFETY: this runs on the webview's own UI thread (with_webview marshals the closure there), which
    // is the thread WebView2 requires for these COM calls. Every call is checked; any failure returns
    // Err, so the guest is closed rather than left partly installed.
    let _ = tx.send(unsafe { install_guard_inner(platform, app, id, label) });
}

/// Non-Windows counterpart so the shared call site in `guest.rs` compiles; fails closed.
#[cfg(not(windows))]
pub fn install_guard(
    _platform: PlatformWebview,
    _app: AppHandle,
    _id: u64,
    _label: String,
    tx: mpsc::Sender<Result<String, String>>,
) {
    let _ = tx.send(Err("guest_guard_windows_only".to_string()));
}

/// A NUL-terminated UTF-16 buffer for a COM `PCWSTR` argument.
#[cfg(windows)]
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Wake the guest's pending `guest_navigate` waiter, if any, with the load result.
#[cfg(windows)]
fn wake(app: &AppHandle, label: &str, result: Result<(), String>) {
    if let Some(registry) = app.try_state::<GuestRegistry>() {
        if let Some(tx) = registry.take_waiter(label) {
            let _ = tx.send(result);
        }
    }
}

/// (a)+(b) of every guard, guest or main: register the `*` filter for every request source, and answer a
/// guarded request with a constant synthetic 403. `blocks` is the verdict rule (`guard_blocks` for a
/// guest, `main_guard_blocks` for main).
/// Returns `"all"` (ICoreWebView2_22: documents, iframes and dedicated/shared/service workers) or
/// `"document-only"` (older runtime: documents only).
/// `log_first` is `Some(tag)` for main only: the handler prints `guard: <tag> first=<document|other>` for
/// the first request it sees, so the probe can prove the filter was in before any subresource (gate P1c4
/// condition 1). The line carries the ResourceContext only, never a URL.
#[cfg(windows)]
unsafe fn install_request_filter(
    core: &w32::ICoreWebView2,
    environment: &w32::ICoreWebView2Environment,
    blocks: impl Fn(&str) -> bool + 'static,
    log_first: Option<&'static str>,
    // Failure-reason prefix of the caller (`guest_guard` / `main_guard`): a main failure must not read as a guest's.
    failure_prefix: &'static str,
) -> Result<&'static str, String> {
    // (a) Register the filter for every request source. On a runtime with ICoreWebView2_22 this covers
    // documents, iframes and dedicated/shared/service workers; the old call covers documents only, and
    // the caller records which happened.
    let filter = wide("*");
    let source_kinds = if let Ok(core22) = core.cast::<w32::ICoreWebView2_22>() {
        core22
            .AddWebResourceRequestedFilterWithRequestSourceKinds(
                PCWSTR(filter.as_ptr()),
                w32::COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
                w32::COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL,
            )
            .map_err(|e| format!("{failure_prefix}_filter:{e}"))?;
        "all"
    } else {
        core.AddWebResourceRequestedFilter(PCWSTR(filter.as_ptr()), w32::COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL)
            .map_err(|e| format!("{failure_prefix}_filter:{e}"))?;
        "document-only"
    };

    // (b) Answer a guarded request with a constant synthetic 403 (status + reason + empty body, no
    // headers). An allowed request is left untouched so wry's custom-protocol handler keeps working.
    // Fail closed: an unreadable URI blocks the request. (WebView2 has no cancel, so the synthetic
    // response is the only block; a COM failure building it is the one residual this API cannot close.)
    let reason = wide("Blocked by Zumi");
    let headers = wide("");
    let response_env = environment.clone();
    let first_pending = Cell::new(log_first);
    let mut token = 0i64;
    core.add_WebResourceRequested(
        &WebResourceRequestedEventHandler::create(Box::new(move |_sender, args| -> windows_core::Result<()> {
            if let Some(tag) = first_pending.take() {
                let mut context = w32::COREWEBVIEW2_WEB_RESOURCE_CONTEXT::default();
                let is_document = args
                    .as_ref()
                    .is_some_and(|args| args.ResourceContext(&mut context).is_ok() && context.0 == w32::COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT.0);
                eprintln!("guard: {tag} first={}", if is_document { "document" } else { "other" });
            }
            // A request we cannot prove is allowed is blocked: a null args, a failed Request()/Uri()
            // all yield None, which request_verdict maps to Block.
            let uri = args
                .as_ref()
                .and_then(|args| args.Request().ok())
                .and_then(|request| {
                    let mut uri = PWSTR::null();
                    request.Uri(&mut uri).ok()?;
                    Some(take_pwstr(uri))
                });
            if request_verdict(uri.as_deref(), &blocks) == RequestVerdict::Block {
                if let Some(args) = args.as_ref() {
                    if let Ok(response) = response_env.CreateWebResourceResponse(
                        None,
                        403,
                        PCWSTR(reason.as_ptr()),
                        PCWSTR(headers.as_ptr()),
                    ) {
                        let _ = args.SetResponse(&response);
                    }
                }
            }
            Ok(())
        })),
        &mut token,
    )
    .map_err(|e| format!("{failure_prefix}_request_handler:{e}"))?;
    Ok(source_kinds)
}

/// Install the request guard on the MAIN webview (P1c4): the same filter + 403 as a guest, with main's
/// own rule (`main_guard_blocks`) and the first-request self-check line. No NavigationStarting /
/// NavigationCompleted hooks: main's navigation lock is Tauri's `on_navigation`, and main has no
/// `did-fail-load` consumer (gate G6). Reports `Ok(source_kinds)` / `Err(reason)` on `tx`; the caller
/// exits the app on any `Err` or on a missing report. Runs on the webview's own thread (`with_webview`
/// marshals there; inline when called from the main thread, which `setup` is).
#[cfg(windows)]
pub fn install_main_guard(platform: PlatformWebview, tx: mpsc::Sender<Result<String, String>>) {
    // SAFETY: with_webview runs the closure on the webview's UI thread, which WebView2 requires for
    // these COM calls. Every call is checked and reported.
    let result = unsafe {
        platform
            .controller()
            .CoreWebView2()
            .map_err(|e| format!("main_guard_core:{e}"))
            .and_then(|core| {
                install_request_filter(&core, &platform.environment(), main_guard_blocks, Some("main"), "main_guard")
                    .map(str::to_string)
            })
    };
    let _ = tx.send(result);
}

/// Non-Windows counterpart so `lib.rs` compiles; fails closed.
#[cfg(not(windows))]
pub fn install_main_guard(_platform: PlatformWebview, tx: mpsc::Sender<Result<String, String>>) {
    let _ = tx.send(Err("main_guard_windows_only".to_string()));
}

/// The only `unsafe` in this increment: every WebView2 COM call for a guest's guard lives here (the
/// job-object host in lib.rs has its own). Its caller is `install_guard`, which runs it on the UI
/// thread and reports the result.
#[cfg(windows)]
unsafe fn install_guard_inner(platform: PlatformWebview, app: AppHandle, id: u64, label: String) -> Result<String, String> {
    let core = platform.controller().CoreWebView2().map_err(|e| format!("guest_guard_core:{e}"))?;
    let environment = platform.environment();

    // (a)+(b) The request filter + constant 403 (shared with the main webview's guard). A board guest gets the loopback
    // rule; a pack guest (MKT, pack_host.rs) gets its own prefix only, and each refusal is logged with its origin.
    let pack = crate::guest::pack_guard_for_label(&app, &label);
    let is_pack = pack.is_some();
    let blocks = move |uri: &str| {
        crate::guest_requests::record(uri);
        match &pack {
            Some((prefix, pack_id, data_dir)) => {
                let blocked = crate::pack_host::pack_request_blocks(uri, prefix);
                if blocked {
                    let origin = Url::parse(uri).ok().map(|u| format!("{}://{}", u.scheme(), u.host_str().unwrap_or(""))).unwrap_or_else(|| "unparsable".to_string());
                    crate::pack_host::log_line(data_dir.as_deref(), &format!("refused request pack={pack_id} origin={origin}"));
                }
                blocked
            }
            None => guard_blocks(uri),
        }
    };
    let source_kinds = install_request_filter(&core, &environment, blocks, None, "guest_guard")?;

    // (c) Remember the one in-flight top-level navigation. wry's own NavigationStarting handler was
    // registered first (on_navigation), so reading Cancel() here sees its verdict.
    let in_flight: Rc<Cell<Option<u64>>> = Rc::new(Cell::new(None));
    let starting_in_flight = in_flight.clone();
    let starting_app = app.clone();
    let starting_is_board = crate::guest::is_board_label(&label);
    let mut token = 0i64;
    core.add_NavigationStarting(
        &NavigationStartingEventHandler::create(Box::new(move |_sender, args| {
            let Some(args) = args else { return Ok(()) };
            // Any COM failure below clears the in-flight id before it returns: a stale id must never
            // survive a NavigationStarting we could not fully read (fail closed).
            let fail = |e: windows_core::Error| {
                starting_in_flight.set(None);
                Err(e)
            };
            let mut cancel = BOOL::default();
            if let Err(e) = args.Cancel(&mut cancel) {
                return fail(e);
            }
            let cancelled = cancel.as_bool();
            // wry's same_origin handler was registered first (on_navigation), so Cancel() here is its
            // verdict: a refused navigation (e.g. a redirect to a non-loopback URL) clears any in-flight
            // id, so its NavigationCompleted (-3) emits nothing and the shim does not hide the guest.
            // P1c3: a refused (cancelled) top-level navigation, redirect hops excepted, is a link the
            // guest tried to follow: ask the policy in the background (the cancel above already kept
            // the guest on its page). The URL is read here only to hand it on; it is never logged.
            let mut redirected = BOOL::default();
            let redirected = args.IsRedirected(&mut redirected).map(|()| redirected.as_bool());
            let mut uri = PWSTR::null();
            let uri = args.Uri(&mut uri).map(|()| take_pwstr(uri));
            let decision = match decide_navigation_start(cancelled, redirected, uri) {
                Ok(decision) => decision,
                Err(e) => return fail(e),
            };
            if let Some(link) = decision.forward {
                if is_pack {
                    // A pack leaves its own files only through links.open (a declared key); a navigation is refused, full stop.
                    let data_dir = starting_app.try_state::<crate::pack_host::PackState>().and_then(|s| s.data_dir.lock().unwrap().clone());
                    crate::pack_host::log_line(data_dir.as_deref(), "refused navigation off the pack");
                } else {
                    crate::guest::request_external_open(&starting_app, link, starting_is_board);
                }
            }
            match decision.action {
                NavStart::Clear => starting_in_flight.set(None),
                NavStart::Ignore => {}
                NavStart::Arm => {
                    let mut nav_id = 0u64;
                    if let Err(e) = args.NavigationId(&mut nav_id) {
                        return fail(e);
                    }
                    starting_in_flight.set(Some(nav_id));
                }
            }
            Ok(())
        })),
        &mut token,
    )
    .map_err(|e| format!("guest_guard_navstarting:{e}"))?;

    // (d) Report the real load status. An id that is not the in-flight one is the about:blank bootstrap
    // or a refused navigation: those emit nothing (Electron ignores did-fail-load for a refused (-3) nav).
    let completed_in_flight = in_flight;
    let completed_app = app;
    let completed_label = label;
    let mut token = 0i64;
    core.add_NavigationCompleted(
        &NavigationCompletedEventHandler::create(Box::new(move |sender, args| {
            let Some(args) = args else { return Ok(()) };
            let mut nav_id = 0u64;
            args.NavigationId(&mut nav_id)?;
            if !completion_is_reported(completed_in_flight.get(), nav_id) {
                return Ok(());
            }
            completed_in_flight.set(None);

            let mut success = BOOL::default();
            args.IsSuccess(&mut success)?;
            let mut web_error = w32::COREWEBVIEW2_WEB_ERROR_STATUS::default();
            args.WebErrorStatus(&mut web_error)?;
            let http_status = match args.cast::<w32::ICoreWebView2NavigationCompletedEventArgs2>() {
                Ok(args2) => {
                    let mut status = 0i32;
                    args2.HttpStatusCode(&mut status)?;
                    Some(status)
                }
                Err(_) => None,
            };
            let url = match sender {
                Some(sender) => {
                    let mut source = PWSTR::null();
                    sender.Source(&mut source)?;
                    take_pwstr(source)
                }
                None => String::new(),
            };
            match nav_outcome(success.as_bool(), http_status, web_error.0) {
                NavOutcome::Finished => {
                    let _ = completed_app.emit_to(MAIN_LABEL, "guest:event", json!({ "id": id, "type": "dom-ready", "url": url }));
                    let _ = completed_app.emit_to(MAIN_LABEL, "guest:event", json!({ "id": id, "type": "did-finish-load", "url": url }));
                    wake(&completed_app, &completed_label, Ok(()));
                }
                NavOutcome::Failed { code, description } => {
                    // webErrorStatus is the raw COREWEBVIEW2_WEB_ERROR_STATUS value the code above mapped.
                    // It is probe instrumentation: the driver records it so a code can be attributed to
                    // an enum row instead of guessed (the P1c1 spare-PC run got -2 for a stopped server).
                    let _ = completed_app.emit_to(MAIN_LABEL, "guest:event", json!({ "id": id, "type": "did-fail-load", "errorCode": code, "errorDescription": description, "webErrorStatus": web_error.0 }));
                    crate::os_signals::push_guest_load_failed(&completed_app, &completed_label, code, &description, web_error.0);
                    wake(&completed_app, &completed_label, Err(format!("guest_load_failed:{code}")));
                }
            }
            Ok(())
        })),
        &mut token,
    )
    .map_err(|e| format!("guest_guard_navcompleted:{e}"))?;

    Ok(source_kinds.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_hosts_are_allowed() {
        for uri in [
            "http://127.0.0.1/",
            "http://127.0.0.1:4212/x?y=1#z",
            "https://localhost/",
            "http://[::1]:9/",
            "ws://127.0.0.1:1/",
            "wss://localhost/",
            "ftp://127.0.0.1/",
            "HTTP://LOCALHOST/", // scheme and host are case-insensitive
        ] {
            assert!(!guard_blocks(uri), "{uri} is loopback");
        }
    }

    #[test]
    fn remote_hosts_are_blocked_without_widening() {
        for uri in [
            "http://127.0.0.2/",
            "http://0.0.0.0/",
            "http://localhost./",
            "http://ipc.localhost/",
            "http://evil.example/",
            "ws://10.0.0.5:9/",
            "wss://remote.example/",
            "ftp://remote.example/",
            "http://user@127.0.0.1@evil.example/", // the host is the part after the LAST '@'
        ] {
            assert!(guard_blocks(uri), "{uri} is remote");
        }
    }

    #[test]
    fn no_guest_reaches_the_ipc_host() {
        // 0.3.0-alpha.11: the wardrobe bridge (the one guest that had Tauri's IPC host re-opened) is gone, so every
        // guest blocks every form of it, like any other remote host.
        for uri in [
            "http://ipc.localhost/",
            "http://ipc.localhost/__zumi_bridge?x=1",
            "https://ipc.localhost/",
            "http://ipc.localhost:8080/",
            "ws://ipc.localhost/",
            "wss://ipc.localhost/",
            "http://a.ipc.localhost/",
            "http://ipc.localhost.evil.example/",
            "http://tauri.localhost/",
        ] {
            assert!(guard_blocks(uri), "a guest blocks {uri}");
        }
        assert_eq!(request_verdict(Some("http://ipc.localhost/"), &guard_blocks), RequestVerdict::Block);
    }

    #[test]
    fn non_network_schemes_and_unparsable_urls_are_allowed() {
        for uri in ["data:text/plain,x", "blob:http://127.0.0.1/1", "about:blank", "", "not a url", "://x"] {
            assert!(!guard_blocks(uri), "{uri} is not a network request");
        }
    }

    #[test]
    fn a_refused_navigation_clears_the_in_flight_id() {
        // A refused redirect (wry cancelled the navigation) clears any in-flight id, so the matching
        // NavigationCompleted (-3) is not reported and the shim does not hide the guest.
        assert_eq!(nav_start_action(true, "http://evil.example/"), NavStart::Clear);
        // The about:blank bootstrap is ignored; every other navigation arms the id.
        assert_eq!(nav_start_action(false, "about:blank"), NavStart::Ignore);
        assert_eq!(nav_start_action(false, "http://127.0.0.1:4212/"), NavStart::Arm);

        // End to end: an allowed navigation arms id 7; a refused redirect hop clears it, so the hop's
        // completion (id 7) emits nothing. Without the clear it would be reported as -3.
        let mut in_flight = None;
        if nav_start_action(false, "http://127.0.0.1:4212/redirect") == NavStart::Arm {
            in_flight = Some(7);
        }
        assert!(completion_is_reported(in_flight, 7), "the allowed navigation is reported");
        if nav_start_action(true, "http://remote.example/") == NavStart::Clear {
            in_flight = None;
        }
        assert!(!completion_is_reported(in_flight, 7), "the refused hop's completion emits nothing");
    }

    #[test]
    fn an_is_redirected_error_still_clears_the_in_flight_id_and_never_asks_the_policy() {
        // P1c1 regression guard: IsRedirected failing must not abort the decision (the old `?` returned
        // early and left the previous navigation's id armed).
        let decision = decide_navigation_start::<()>(true, Err(()), Ok("https://zumia.space/x".to_string())).unwrap();
        assert_eq!(decision.action, NavStart::Clear);
        assert_eq!(decision.forward, None, "an unknown redirect state is treated as a redirect: not consulted");
        // End to end with the id: armed for navigation 7, then a refused one whose IsRedirected failed.
        let mut in_flight = Some(7);
        if decision.action == NavStart::Clear {
            in_flight = None;
        }
        assert!(!completion_is_reported(in_flight, 7));
        // An allowed navigation whose IsRedirected failed still arms (its redirect state is irrelevant).
        let allowed = decide_navigation_start::<()>(false, Err(()), Ok("http://127.0.0.1:4212/".to_string())).unwrap();
        assert_eq!(allowed.action, NavStart::Arm);
        assert_eq!(allowed.forward, None);
    }

    #[test]
    fn a_refused_navigation_with_an_unreadable_uri_clears_and_forwards_nothing_while_an_allowed_one_fails() {
        let refused = decide_navigation_start(true, Ok(false), Err(())).unwrap();
        assert_eq!(refused, NavStartDecision { action: NavStart::Clear, forward: None });
        assert!(decide_navigation_start(false, Ok(false), Err(())).is_err());
    }

    #[test]
    fn a_readable_refused_non_redirect_navigation_forwards_its_url_once() {
        let decision = decide_navigation_start::<()>(true, Ok(false), Ok("https://zumia.space/x".to_string())).unwrap();
        assert_eq!(decision, NavStartDecision { action: NavStart::Clear, forward: Some("https://zumia.space/x".to_string()) });
        let hop = decide_navigation_start::<()>(true, Ok(true), Ok("https://zumia.space/x".to_string())).unwrap();
        assert_eq!(hop, NavStartDecision { action: NavStart::Clear, forward: None });
    }

    #[test]
    fn only_a_refused_top_level_non_redirect_navigation_asks_the_external_policy() {
        // The guest followed a link off its origin: wry cancelled it, it is not a redirect hop.
        assert!(consults_external_policy(true, false, "https://zumia.space/x"));
        // Redirect hops are never consulted (gate P1c3 condition 3).
        assert!(!consults_external_policy(true, true, "https://zumia.space/x"));
        // An allowed (same-origin) navigation is not a link.
        assert!(!consults_external_policy(false, false, "http://127.0.0.1:4212/"));
        // The about:blank bootstrap and an unreadable URL are not links.
        assert!(!consults_external_policy(true, false, "about:blank"));
        assert!(!consults_external_policy(true, false, ""));
    }

    #[test]
    fn an_unreadable_request_is_blocked() {
        // The URI could not be read (a COM error on any path): fail closed.
        assert_eq!(request_verdict(None, &guard_blocks), RequestVerdict::Block);
        // Allowed only once the URI was read and is not a remote network request.
        assert_eq!(request_verdict(Some("http://127.0.0.1:4212/"), &guard_blocks), RequestVerdict::Allow);
        assert_eq!(request_verdict(Some("data:text/plain,x"), &guard_blocks), RequestVerdict::Allow);
        // Remote network requests are blocked.
        assert_eq!(request_verdict(Some("http://evil.example/"), &guard_blocks), RequestVerdict::Block);
        assert_eq!(request_verdict(Some("ws://10.0.0.5/"), &guard_blocks), RequestVerdict::Block);
        assert_eq!(request_verdict(Some("http://ipc.localhost/"), &guard_blocks), RequestVerdict::Block);
    }

    #[test]
    fn main_allows_the_app_hosts_the_loopback_set_and_non_network_urls() {
        for uri in [
            "http://tauri.localhost/",
            "http://tauri.localhost/index.html?x#y",
            "http://ipc.localhost/plugin%3Aevent%7Clisten",
            "http://127.0.0.1:4212/x",
            "https://localhost/",
            "http://[::1]:9/",
            "ws://127.0.0.1:1/",
            "data:text/plain,x",
            "blob:http://tauri.localhost/1",
            "about:blank",
            "not a url",
            "",
        ] {
            assert!(!main_guard_blocks(uri), "{uri} is allowed on main");
        }
    }

    #[test]
    fn main_blocks_everything_else_without_widening() {
        for uri in [
            "https://tauri.localhost/",
            "http://tauri.localhost:8080/",
            "http://a.tauri.localhost/",
            "http://tauri.localhost.evil.example/",
            "http://ipc.localhost@evil.example/",
            "http://tauri.localhost@evil.example/",
            "https://ipc.localhost/",
            "ws://tauri.localhost/",
            "http://evil.example/",
            "wss://evil.example/",
            "https://fonts.googleapis.com/",
            "http://localhost./",
            "http://127.0.0.2/",
            "http://0.0.0.0/",
            "ftp://remote.example/",
        ] {
            assert!(main_guard_blocks(uri), "{uri} is blocked on main");
        }
    }

    #[test]
    fn guests_still_block_the_app_hosts() {
        // Gate Q4 condition 4: main's widening must not leak into the guest rule.
        assert!(guard_blocks("http://tauri.localhost/"));
        assert!(guard_blocks("http://ipc.localhost/"));
        assert_eq!(request_verdict(Some("http://tauri.localhost/"), &guard_blocks), RequestVerdict::Block);
        assert_eq!(request_verdict(Some("http://tauri.localhost/"), &main_guard_blocks), RequestVerdict::Allow);
    }

    #[test]
    fn an_unreadable_main_request_is_blocked() {
        assert_eq!(request_verdict(None, &main_guard_blocks), RequestVerdict::Block);
        assert_eq!(request_verdict(Some("http://evil.example/"), &main_guard_blocks), RequestVerdict::Block);
    }

    #[test]
    fn main_navigation_is_locked_to_the_app_page() {
        let allowed = |s: &str| main_nav_allowed(&Url::parse(s).expect("a valid url"));
        assert!(allowed("http://tauri.localhost/index.html"));
        assert!(allowed("http://tauri.localhost/#settings"));
        assert!(allowed("http://tauri.localhost/"));
        for refused in [
            "about:blank",
            "http://127.0.0.1:4212/",
            "http://localhost/",
            "https://tauri.localhost/",
            "http://tauri.localhost:8080/",
            "http://ipc.localhost/",
            "file:///C:/x",
            "data:text/html,x",
            "http://evil.example/",
            "https://zumia.space/",
        ] {
            assert!(!allowed(refused), "{refused} is refused on main");
        }
    }

    #[test]
    fn the_app_asset_hook_answers_a_constant_403() {
        use std::borrow::Cow;

        use tauri::http::{header, Response, StatusCode};

        // A plausible app-asset response: 200, content headers, a non-empty body.
        let mut response = Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "text/html")
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "http://tauri.localhost")
            .header(header::CONTENT_SECURITY_POLICY, "default-src 'self'")
            .body(Cow::Borrowed(b"<html>app</html>".as_slice()))
            .expect("a valid response");
        assert_eq!(response.status(), StatusCode::OK);
        assert!(!response.headers().is_empty());
        assert!(!response.body().is_empty());

        deny_app_asset(&mut response);

        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert!(response.headers().is_empty());
        assert!(response.body().is_empty());
    }

    #[test]
    fn a_guest_gets_a_bare_404_for_every_asset_route_path_and_a_403_for_the_rest() {
        use std::borrow::Cow;

        use tauri::http::{header, Response, StatusCode};

        let page = || {
            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, "application/octet-stream")
                .header(header::CONTENT_SECURITY_POLICY, "default-src 'self'")
                .body(Cow::Borrowed(b"file bytes".as_slice()))
                .expect("a valid response")
        };

        // Parity 4b: every shape the main webview's asset route owns — served or malformed — is a bare 404 for a
        // guest, whether the file exists on this PC or not (the answer must not depend on it).
        for path in [
            "/external/user.vrm",
            "/external/test.vrm",
            "/external/../user.vrm",
            "/external/%2e%2e%2fuser.vrm",
            "/rooms/0123456789ab/room.glb",
            "/rooms/0123456789ab/check.json",
            "/rooms/0123456789ab/room.json",
            "/rooms/0123456789ab/../../user.vrm",
            "/rooms/%2e%2e/room.glb",
            "/rooms/0123456789abc/room.glb",
            "/scenes/loft.mp4",
            "/scenes/chair",
            "/scenes/../chair",
        ] {
            let mut response = page();
            deny_guest_asset(path, &mut response);
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "{path}");
            assert!(response.body().is_empty(), "{path}");
            assert_eq!(response.headers().get(header::CONTENT_LENGTH).and_then(|v| v.to_str().ok()), Some("0"), "{path}");
            assert!(response.headers().get(header::CONTENT_TYPE).is_none(), "{path}");
            assert!(response.headers().get(header::CONTENT_SECURITY_POLICY).is_none(), "{path}");
        }

        // Everything else keeps the guest's constant 403: the app's own page, bundled models/clips, and the pinned
        // v2 room (a bundled asset, not an imported one).
        for path in ["/", "/index.html", "/models/a.vrm", "/clips/a.vrma", "/rooms/default-v2/room.json"] {
            let mut response = page();
            deny_guest_asset(path, &mut response);
            assert_eq!(response.status(), StatusCode::FORBIDDEN, "{path}");
            assert!(response.headers().is_empty(), "{path}");
            assert!(response.body().is_empty(), "{path}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn a_successful_load_finishes() {
        assert_eq!(nav_outcome(true, None, 0), NavOutcome::Finished);
        use webview2_com::Microsoft::Web::WebView2::Win32 as w32;
        assert_eq!(nav_outcome(true, None, w32::COREWEBVIEW2_WEB_ERROR_STATUS_UNKNOWN.0), NavOutcome::Finished);
    }

    #[cfg(windows)]
    #[test]
    fn an_http_error_status_is_a_finished_load() {
        use webview2_com::Microsoft::Web::WebView2::Win32 as w32;
        let err = w32::COREWEBVIEW2_WEB_ERROR_STATUS_CANNOT_CONNECT.0;
        assert_eq!(nav_outcome(false, Some(404), err), NavOutcome::Finished);
        assert_eq!(nav_outcome(false, Some(500), err), NavOutcome::Finished);
    }

    #[cfg(windows)]
    #[test]
    fn an_unknown_web_status_is_err_failed_not_refused() {
        use webview2_com::Microsoft::Web::WebView2::Win32 as w32;
        // Measured on the spare PC: a stopped loopback server produced -2 ERR_FAILED. WebView2's
        // COREWEBVIEW2_WEB_ERROR_STATUS_UNKNOWN (0x0) means "an unknown error occurred" (Microsoft's
        // CoreWebView2WebErrorStatus docs); the refused-connection row is CANNOT_CONNECT (0xC), which
        // the mapping above turns into -102. So the honest result for an unlisted status is the
        // default -2, and this test pins it so the default is never "fixed" into a false -102.
        assert_eq!(
            nav_outcome(false, Some(0), w32::COREWEBVIEW2_WEB_ERROR_STATUS_UNKNOWN.0),
            NavOutcome::Failed { code: -2, description: "ERR_FAILED" }
        );
    }

    #[cfg(windows)]
    #[test]
    fn each_webview2_status_maps_to_its_chromium_code() {
        use webview2_com::Microsoft::Web::WebView2::Win32 as w32;
        let table = [
            (w32::COREWEBVIEW2_WEB_ERROR_STATUS_CANNOT_CONNECT.0, -102, "ERR_CONNECTION_REFUSED"),
            (w32::COREWEBVIEW2_WEB_ERROR_STATUS_OPERATION_CANCELED.0, -3, "ERR_ABORTED"),
            (w32::COREWEBVIEW2_WEB_ERROR_STATUS_TIMEOUT.0, -7, "ERR_TIMED_OUT"),
            (w32::COREWEBVIEW2_WEB_ERROR_STATUS_CONNECTION_RESET.0, -101, "ERR_CONNECTION_RESET"),
            (w32::COREWEBVIEW2_WEB_ERROR_STATUS_CONNECTION_ABORTED.0, -103, "ERR_CONNECTION_ABORTED"),
            (w32::COREWEBVIEW2_WEB_ERROR_STATUS_DISCONNECTED.0, -106, "ERR_INTERNET_DISCONNECTED"),
            (w32::COREWEBVIEW2_WEB_ERROR_STATUS_HOST_NAME_NOT_RESOLVED.0, -105, "ERR_NAME_NOT_RESOLVED"),
            (w32::COREWEBVIEW2_WEB_ERROR_STATUS_SERVER_UNREACHABLE.0, -109, "ERR_ADDRESS_UNREACHABLE"),
            (w32::COREWEBVIEW2_WEB_ERROR_STATUS_ERROR_HTTP_INVALID_SERVER_RESPONSE.0, -320, "ERR_INVALID_RESPONSE"),
        ];
        for (status, code, description) in table {
            assert_eq!(nav_outcome(false, None, status), NavOutcome::Failed { code, description });
        }
        // An unlisted status falls back to ERR_FAILED.
        assert_eq!(
            nav_outcome(false, None, w32::COREWEBVIEW2_WEB_ERROR_STATUS_UNEXPECTED_ERROR.0),
            NavOutcome::Failed { code: -2, description: "ERR_FAILED" }
        );
    }
}
