// T-31 P1b — native child-webview guest host (DESIGN.md §3 "approach B").
//
// The renderer's `<webview>` stand-in (tauri/shim/webview-element.js) is a placeholder with no
// content. The shim reports the element's bounding rect to Rust, and Rust puts a native WebView2
// child (`Window::add_child`) exactly over it. The three guests the renderer builds are the local
// board and the live board (the wardrobe guest was removed in 0.3.0-alpha.11).
//
// Two invariants hold for every command in this module:
//   * every command is `async` — `Window::add_child` deadlocks when called from a *sync* command on
//     Windows (it posts to the main thread and blocks on a channel; a sync command already runs on it);
//   * every command refuses unless the calling webview's label is `main` — defence in depth on top of
//     the ACL (`capabilities/default.json` grants the commands to `main` only, and no guest gets any
//     runtime capability in P1b, so a remote guest origin can reach nothing).
//
// A guest URL's query and fragment are NEVER logged: the local board's URL carries the owner token in
// its `#fragment`. Only the origin (scheme://host:port) is ever compared.
//
// P1c1: every guest gets Electron's loopback-only request guard plus an exact NavigationCompleted
// status (guest_guard.rs), and the old TCP preflight probe is gone — a dead server is now reported by
// the WebView2 navigation itself.
// P1c1: the app's own `tauri.localhost` assets are refused with the same constant 403 via wry's
// `on_web_resource_request`, which runs after wry's deferred custom-protocol response would overwrite
// the guard's 403. Parity 4b-2: a path in the main webview's asset namespaces (`external/`, `rooms/`,
// `scenes/`) is a bare 404 instead — that route serves main only, and a guest learns nothing about the
// files it can name.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::webview::NewWindowResponse;
use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, Position, Rect, Size, State, Url, Webview,
    WebviewBuilder, WebviewUrl,
};

use crate::board_open;
use crate::guest_guard;
use crate::shell_ops;
use crate::{Rpc, CALL_TIMEOUT};

/// The one webview that may call an app command: the shell renderer. Guests (children of the same
/// window) have their own labels and are refused.
pub(crate) const MAIN_LABEL: &str = "main";
/// How long `guest_open` waits for the request guard to install before failing the open closed.
const GUARD_TIMEOUT: Duration = Duration::from_secs(5);
/// How long `guest_navigate` waits for the next NavigationCompleted before rejecting.
const NAV_TIMEOUT: Duration = Duration::from_secs(10);
/// How long the sidecar has to answer `__host.decideExternalUrl` / `__host.logRefusal`. Short: a link
/// is a click, and a slow sidecar means the link is refused (fail closed), not queued.
const EXTERNAL_TIMEOUT: Duration = Duration::from_secs(5);
/// How long the background task waits for the main thread to run `ShellExecuteW`.
const SHELL_TIMEOUT: Duration = Duration::from_secs(10);
/// A bounds value past this is nonsense (not a real element rect) and is refused.
const MAX_BOUND: f64 = 16_384.0;
/// WebView2 browser args for every guest (parity step 7, gate ruling (a)): wry's default when no args are given disables
/// SmartScreen (`--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection`), which would switch the protection off
/// for the guests that carry proxied remote content. Naming the two UI features we do want keeps SmartScreen ON, exactly
/// like the main webview's arg string. Each guest already has its own data directory, which wry requires for differing args.
pub(crate) const GUEST_BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI";

/// The element rect the shim reports, in logical px (CSS px: the main webview fills the client area at
/// zoom 1, so no scaling is applied).
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Which kind of guest an entry is; decides its label prefix.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GuestKind {
    Board,
    /// MKT: one web-app pack (pack_host.rs). Partition `pack:<id>`.
    Pack,
}

impl GuestKind {
    fn label_prefix(self) -> &'static str {
        match self {
            GuestKind::Board => "guest-board",
            GuestKind::Pack => "guest-pack",
        }
    }
}

/// True for a pack guest's label.
pub(crate) fn is_pack_label(label: &str) -> bool {
    label.starts_with(&format!("{}-", GuestKind::Pack.label_prefix()))
}

/// For a pack guest: (its only allowed request prefix, its pack id, the data dir for the refusal log). None for any other
/// guest. Read from the label -> pack binding guest_open made, never from the page.
pub(crate) fn pack_guard_for_label(app: &AppHandle, label: &str) -> Option<(String, String, Option<PathBuf>)> {
    if !is_pack_label(label) {
        return None;
    }
    let state = app.try_state::<crate::pack_host::PackState>()?;
    let data_dir = state.data_dir.lock().unwrap().clone();
    // A pack label with no bound pack still gets a pack rule that matches nothing: fail closed.
    let (prefix, id) = match state.pack_for(label) {
        Some(pack) => (crate::pack_host::pack_origin_prefix(&pack.id), pack.id.clone()),
        None => ("\u{0}".to_string(), "?".to_string()),
    };
    Some((prefix, id, data_dir))
}

/// True for the Board tab guest's label; anything else is not a link opener.
pub(crate) fn is_board_label(label: &str) -> bool {
    label.starts_with(&format!("{}-", GuestKind::Board.label_prefix()))
}

/// The WebView2 profile a partition maps to. `incognito` is the live board's in-memory requirement.
#[derive(Debug, PartialEq, Eq)]
pub struct Profile {
    pub data_dir: PathBuf,
    pub incognito: bool,
}

/// Map a preview partition to its profile. This is the SINGLE place the mapping lives (one guest data dir:
/// board — Q4). The live board shares the board dir but runs incognito, so it stays in memory without a
/// second process tree. Unknown partitions (including the removed `preview-wardrobe`) are refused.
pub fn profile_for_partition(partition: &str, base: &Path) -> Result<Profile, String> {
    let guest_webview = base.join("guest-webview");
    match partition {
        "preview-board" => Ok(Profile { data_dir: guest_webview.join("board"), incognito: false }),
        "preview-board-live" => Ok(Profile { data_dir: guest_webview.join("board"), incognito: true }),
        // MKT: each pack has its own profile, so its storage, cache and browser process are its own.
        other => match crate::pack_host::partition_pack_id(other) {
            Some(id) => Ok(Profile { data_dir: guest_webview.join(format!("pack-{id}")), incognito: false }),
            None => Err(format!("unknown_partition:{other}")),
        },
    }
}

/// Where the guest profiles live for a launch: a self-test run keeps them under its own run dir (like the main
/// <runDir>/webview), so a probe never touches the real Local\space.zumia.preview\guest-webview; a normal launch is unchanged.
pub fn guest_profile_base(self_test: &crate::guest_cdp::SelfTest, local_data_dir: &Path) -> PathBuf {
    match self_test.run_dir() {
        Some(run_dir) if self_test.enabled() => run_dir.to_path_buf(),
        _ => self_test.user_data_dir().unwrap_or(local_data_dir).to_path_buf(),
    }
}

/// The guest kind for a partition; unknown partitions are refused.
fn kind_for_partition(partition: &str) -> Result<GuestKind, String> {
    match partition {
        "preview-board" | "preview-board-live" => Ok(GuestKind::Board),
        other if crate::pack_host::partition_pack_id(other).is_some() => Ok(GuestKind::Pack),
        other => Err(format!("unknown_partition:{other}")),
    }
}

/// What a guest's top-level navigation (not the about:blank bootstrap) does. Pure so the callback's wiring is tested.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum NavAction {
    /// Same origin: an ordinary page load.
    Allow,
    /// Off-origin: cancelled (the guard forwards it to the external-link policy).
    Cancel,
    /// The Board tab guest's own /__zumi-open: cancelled and decided as an open request, never as a page load.
    BoardOpen,
}

pub(crate) fn nav_action(url: &Url, guest_origin: &str, opener_is_board: bool) -> NavAction {
    if !same_origin(url.as_str(), guest_origin) {
        NavAction::Cancel
    } else if opener_is_board && board_open::is_open_request(url) {
        NavAction::BoardOpen
    } else {
        NavAction::Allow
    }
}

/// What a guest's window.open / target=_blank does (the window itself is always denied).
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum WindowAction {
    External,
    BoardOpen,
    Nothing,
}

pub(crate) fn window_action(url: &Url, guest_origin: &str, opener_is_board: bool) -> WindowAction {
    if !same_origin(url.as_str(), guest_origin) {
        WindowAction::External
    } else if opener_is_board && board_open::is_open_request(url) {
        WindowAction::BoardOpen
    } else {
        WindowAction::Nothing
    }
}

/// Exact-origin match, mirroring src/main/webview-policy.mjs sameOrigin() and the sidecar's copy: a
/// prefix match would let `http://127.0.0.1:4212evil.example` pass for origin `http://127.0.0.1:4212`.
pub fn same_origin(url: &str, origin: &str) -> bool {
    !origin.is_empty() && (url == origin || url.starts_with(&format!("{origin}/")))
}

/// Validate a reported rect: finite, non-negative, and within `MAX_BOUND`. Anything else is refused
/// rather than passed to the platform (a NaN or a negative size is a renderer bug, not a guest).
pub fn sanitize_bounds(b: &Bounds) -> Result<(f64, f64, f64, f64), String> {
    let values = [b.x, b.y, b.width, b.height];
    if values.iter().any(|v| !v.is_finite()) {
        return Err("guest_bounds_not_finite".to_string());
    }
    if values.iter().any(|v| *v < 0.0) {
        return Err("guest_bounds_negative".to_string());
    }
    if values.iter().any(|v| *v > MAX_BOUND) {
        return Err("guest_bounds_too_large".to_string());
    }
    Ok((b.x, b.y, b.width, b.height))
}

/// A live guest: its label/kind/origin plus its webview once created. `webview` is `None`
/// between a successful `guest_open` registration and creation, and after a failed guard install (the
/// entry is removed then, so `None` never survives a completed open). `pending_nav` is the one-shot
/// waiter `guest_navigate` sets before each load; NavigationCompleted wakes it.
#[derive(Clone)]
struct Guest {
    label: String,
    // Stored for diagnostics/extensions; the label already encodes the kind for the shim.
    #[allow(dead_code)]
    kind: GuestKind,
    origin: String,
    webview: Option<Webview>,
    pending_nav: Option<mpsc::Sender<Result<(), String>>>,
}

/// The registry of open guests, keyed by the id handed back to the shim. Managed Tauri state.
#[derive(Default)]
pub struct GuestRegistry {
    next: AtomicU64,
    guests: Mutex<HashMap<u64, Guest>>,
}

impl GuestRegistry {
    fn alloc(&self, kind: GuestKind) -> (u64, String) {
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        (id, format!("{}-{}", kind.label_prefix(), id))
    }

    fn insert(&self, id: u64, guest: Guest) {
        self.guests.lock().unwrap().insert(id, guest);
    }

    fn snapshot(&self, id: u64) -> Option<Guest> {
        self.guests.lock().unwrap().get(&id).cloned()
    }

    /// Attach a created webview to an existing entry. Returns false when the entry is gone (the
    /// element was removed while the child was being created) so the caller can close the orphan.
    fn set_webview(&self, id: u64, webview: Webview) -> bool {
        match self.guests.lock().unwrap().get_mut(&id) {
            Some(g) => { g.webview = Some(webview); true }
            None => false,
        }
    }

    fn remove(&self, id: u64) -> Option<Guest> {
        self.guests.lock().unwrap().remove(&id)
    }

    fn set_waiter(&self, id: u64, tx: mpsc::Sender<Result<(), String>>) {
        if let Some(g) = self.guests.lock().unwrap().get_mut(&id) {
            g.pending_nav = Some(tx);
        }
    }

    /// Take (and clear) the pending-navigation waiter for a labelled guest, if any. Called from the
    /// NavigationCompleted handler (in guest_guard); iterates because a guest is addressed by label
    /// there, by id elsewhere.
    pub(crate) fn take_waiter(&self, label: &str) -> Option<mpsc::Sender<Result<(), String>>> {
        let mut guests = self.guests.lock().unwrap();
        guests.values_mut().find(|g| g.label == label).and_then(|g| g.pending_nav.take())
    }

    /// The first open local board guest's webview (parity 12-2: a test-only capture or CDP call names "board").
    /// A guest between registration and creation has no webview yet; it is skipped.
    pub(crate) fn board_webview(&self) -> Option<Webview> {
        self.guests
            .lock()
            .unwrap()
            .values()
            .find(|g| is_board_label(&g.label))
            .and_then(|g| g.webview.clone())
    }

    /// The webview of one open guest by id; `None` for an unknown or not-yet-created guest.
    pub(crate) fn webview_for(&self, id: u64) -> Option<Webview> {
        self.guests.lock().unwrap().get(&id).and_then(|g| g.webview.clone())
    }
}

/// Refuse a command from anything but the main webview.
fn ensure_main(caller: &Webview) -> Result<(), String> {
    if is_main(caller) {
        Ok(())
    } else {
        Err("guest_not_main".to_string())
    }
}

/// Whether the calling webview is the shell renderer (the only caller allowed to reach app commands).
/// Used by both the `rpc` command and every `guest_*` command.
pub(crate) fn is_main(caller: &Webview) -> bool {
    caller.label() == MAIN_LABEL
}

/// Ask the sidecar's policy module (webview-policy.mjs, unchanged) whether this src/partition may attach.
async fn decide(rpc: &Rpc, src: &str, partition: &str) -> Result<Value, String> {
    let client = rpc.clone();
    let src = src.to_string();
    let partition = partition.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        client.call("__host.guestDecide", vec![json!(src), json!(partition)], CALL_TIMEOUT)
    })
    .await
    .map_err(|e| format!("guest_decide_task:{e}"))?
}

/// Build and attach one native child webview for a guest, then hide it (the shim decides visibility).
///
/// The child is created at `about:blank`; the request guard is installed on its own thread right after
/// creation, and only the caller navigates the real URL (after the guard reports success). The returned
/// receiver carries the guard install result (`Ok(source_kinds)` / `Err(reason)`) from the UI thread.
fn add_guest_webview(
    app: &AppHandle,
    id: u64,
    label: &str,
    origin: &str,
    profile: &Profile,
) -> Result<(Webview, mpsc::Receiver<Result<String, String>>), String> {
    let window = app.get_window(MAIN_LABEL).ok_or("guest_no_main_window")?;
    let nav_origin = origin.to_string();
    let window_origin = origin.to_string();
    let window_app = app.clone();
    let nav_app = app.clone();
    let nav_label = label.to_string();
    let window_label = label.to_string();
    let opener_is_board = is_board_label(label);
    let blank: Url = "about:blank".parse().map_err(|_| "guest_blank_url".to_string())?;
    // about:blank is allowed exactly once (the bootstrap); every later navigation must be same-origin.
    // One flag suffices because the guest is created at about:blank, so the first navigation is it.
    let armed = AtomicBool::new(true);
    let builder = WebviewBuilder::new(label, WebviewUrl::External(blank))
        .data_directory(profile.data_dir.clone())
        .additional_browser_args(GUEST_BROWSER_ARGS)
        .incognito(profile.incognito)
        .focused(false)
        .on_navigation(move |url| {
            if url.as_str() == "about:blank" {
                armed.swap(false, Ordering::SeqCst)
            } else {
                match nav_action(url, &nav_origin, opener_is_board) {
                    NavAction::Allow => true,
                    NavAction::Cancel => false,
                    // P3-B: a chip navigation to the board's own /__zumi-open is an open request, not a page load.
                    NavAction::BoardOpen => {
                        request_board_open(&nav_app, &nav_label, url.as_str().to_string());
                        false
                    }
                }
            }
        })
        .on_web_resource_request(|request, response| {
            guest_guard::deny_guest_asset(request.uri().path(), response)
        })
        .on_new_window(move |url, _features| {
            // P1c3: the window is ALWAYS denied (synchronously); a link to another origin is decided in
            // the background. A request for the guest's own origin is denied and nothing more, like
            // Electron's setWindowOpenHandler (`!inBoard(url)`).
            match window_action(&url, &window_origin, opener_is_board) {
                // MKT: a pack never opens the OS browser by itself (links.open with a declared key is its only way out).
                WindowAction::External if is_pack_label(&window_label) => {
                    let data_dir = window_app.try_state::<crate::pack_host::PackState>().and_then(|s| s.data_dir.lock().unwrap().clone());
                    crate::pack_host::log_line(data_dir.as_deref(), "refused new window off the pack");
                }
                WindowAction::External => request_external_open(&window_app, url.as_str().to_string(), opener_is_board),
                // P3-B: a chip (a target=_blank link) on the live board. Still denied here; decided in the background.
                WindowAction::BoardOpen => request_board_open(&window_app, &window_label, url.as_str().to_string()),
                WindowAction::Nothing => {}
            }
            NewWindowResponse::<tauri::Wry>::Deny
        });
    // B1: with the default handler WebView2 hands an OS file drop to Rust and the page never gets dragover/drop, so the
    // Laneboard composer cannot take a dropped image. Only the Board guest turns it off (repro: alpha.3 b1 NOTES.md).
    let builder = if is_board_label(label) {
        builder.disable_drag_drop_handler()
    } else {
        builder
    };
    let webview = window
        .add_child(builder, LogicalPosition::new(0.0, 0.0), LogicalSize::new(0.0, 0.0))
        .map_err(|e| format!("guest_add_child:{e}"))?;
    let _ = webview.hide();

    let (tx, rx) = mpsc::channel::<Result<String, String>>();
    let guard_app = app.clone();
    let guard_label = label.to_string();
    if let Err(e) = webview.with_webview(move |platform| {
        guest_guard::install_guard(platform, guard_app, id, guard_label, tx);
    }) {
        let _ = webview.close();
        return Err(format!("guest_guard_dispatch:{e}"));
    }
    Ok((webview, rx))
}

/// P1c3: ask the sidecar whether a guest's link may open in the OS browser, and open it if so. Returns at
/// once: the caller (a wry `NewWindowRequested` callback or the guard's `NavigationStarting` handler) has
/// already denied/cancelled, and must not block on the RPC. All decisions live in
/// `shell_ops::handle_request`; this is only the wiring (sidecar call, main-thread `ShellExecuteW`,
/// refusal log).
pub(crate) fn request_external_open(app: &AppHandle, url: String, opener_is_board: bool) {
    // S1: the board's own bridge routes are never an OS-browser link, whatever the sidecar currently believes (a stale guest
    // after setMode('local') / signOut). An intercepted /__zumi-open is terminal.
    if board_open::is_bridge_link(&url) {
        eprintln!("external-link: Refused (bridge route)");
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let Some(rpc) = app.try_state::<Rpc>() else { return };
        let client = rpc.inner().clone();
        let decide_client = client.clone();
        let outcome = shell_ops::handle_request(
            &url,
            opener_is_board,
            |u| decide_client.call("__host.decideExternalUrl", vec![json!(u)], EXTERNAL_TIMEOUT),
            |checked| {
                // ShellExecuteW runs on the main thread, where COM is initialised for the window. A job
                // still queued after SHELL_TIMEOUT is cancelled, so it never opens a link already logged
                // as failed.
                shell_ops::open_on_main_with_timeout(
                    checked,
                    SHELL_TIMEOUT,
                    |job| app.run_on_main_thread(job).map_err(|e| format!("shell_dispatch:{e}")),
                    |url| shell_ops::open_external(url),
                )
            },
            |reason, origin| {
                if client.call("__host.logRefusal", vec![json!(reason), json!(origin)], EXTERNAL_TIMEOUT).is_err() {
                    // The sidecar could not write it: reason only, never a URL.
                    eprintln!("external-link: refusal not logged reason={reason}");
                }
            },
        );
        eprintln!("external-link: {outcome:?}"); // outcome name only; never a URL
    });
}

/// P3-B: a chip on the owner's live board asked to open a file or link (`/__zumi-open`, intercepted from the Board tab
/// guest's new-window / navigation callback; there is no HTTP route). Returns at once: the caller already denied the window /
/// cancelled the navigation. All decisions live in `board_open::handle_board_open` (owner flag = this host's own flavour,
/// sidecar verdict, then the independent re-validation inside the openers); this is only the wiring. Nothing here logs a
/// path or URL.
pub(crate) fn request_board_open(app: &AppHandle, label: &str, url: String) {
    let app = app.clone();
    let label = label.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let Some(rpc) = app.try_state::<Rpc>() else { return };
        let client = rpc.inner().clone();
        let owner = crate::request_owner(&client);
        // The page the chip was clicked on, read from the webview itself (never from the request): the sidecar requires it to
        // be on the live bridge origin (Electron's `openerUrl: contents.getURL()`).
        let opener = app
            .get_webview(&label)
            .and_then(|w| w.url().ok())
            .map(|u| u.to_string())
            .unwrap_or_default();
        let decide_client = client.clone();
        let outcome = board_open::board_open_for_label(
            &label,
            &url,
            owner,
            |u| decide_client.call("__host.boardOpenVerdict", vec![json!(u), json!(opener)], EXTERNAL_TIMEOUT),
            |p| crate::open_path_from_sidecar(&app, p, owner),
            |u| crate::open_external_from_sidecar(&app, u),
            |reason, origin| {
                if client.call("__host.logRefusal", vec![json!(reason), json!(origin)], EXTERNAL_TIMEOUT).is_err() {
                    eprintln!("board-open: refusal not logged reason={reason}");
                }
            },
        );
        eprintln!("board-open: {outcome:?}"); // outcome name only; never a path or URL
    });
}

/// Step 6 (GATE-6pre/Fable: app-page `openExternal` paths): an open requested by the APP page itself, `ai.openKeyPage` and
/// `talk.openSource`. The page never supplies the URL that opens: the sidecar answers a VERDICT from its own tables
/// (`host_method`: the active provider's key page, or exactly a URL a reply cited), then the SAME Rust path as a guest link
/// runs (`shell_ops::handle_request`: strict verdict parse, re-validation, `ShellExecuteW` on the main thread, a timed-out
/// open never fires later). `candidate` is the page's string for `talk.openSource` and empty for the key page. Blocking:
/// call it from a worker thread. True only when the shell was handed a URL (Electron returns true/false the same way).
pub(crate) fn open_for_app_page(app: &AppHandle, client: &Rpc, host_method: &str, candidate: &str) -> bool {
    let log_client = client.clone();
    let outcome = shell_ops::handle_request(
        candidate,
        true, // the caller is the main app page; the guest-only opener rule does not apply
        |u| client.call(host_method, if u.is_empty() { vec![] } else { vec![json!(u)] }, EXTERNAL_TIMEOUT),
        |checked| {
            shell_ops::open_on_main_with_timeout(
                checked,
                SHELL_TIMEOUT,
                |job| app.run_on_main_thread(job).map_err(|e| format!("shell_dispatch:{e}")),
                |url| shell_ops::open_external(url),
            )
        },
        |reason, origin| {
            if log_client.call("__host.logRefusal", vec![json!(reason), json!(origin)], EXTERNAL_TIMEOUT).is_err() {
                eprintln!("app-open: refusal not logged reason={reason}");
            }
        },
    );
    eprintln!("app-open: {outcome:?}"); // outcome name only; never a URL
    matches!(outcome, shell_ops::Outcome::Opened)
}

/// Run `insert`, then `build`. If `build` fails, run `remove` and return the error, so a failed open
/// never leaves a half-registered guest: the renderer only sees the command's error and could never
/// `guest_close` an id that leaked this way. Extracted so it is testable without owning a `Webview`
/// (a test binary that owns one needs the Common-Controls manifest tauri embeds only for its own tests).
fn insert_then_build<T>(
    insert: impl FnOnce(),
    remove: impl FnOnce(),
    build: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    insert();
    match build() {
        Ok(value) => Ok(value),
        Err(e) => {
            remove();
            Err(e)
        }
    }
}

/// `guest_open(src, partition)` — decide via the sidecar, then create the native child.
///
/// On a refusal the command returns `guest_refused` and creates nothing. On an allow it creates the
/// child at about:blank, installs the loopback-only request guard + NavigationCompleted status on the
/// UI thread, and only navigates the real `src` once the guard reports success. If the guard errors or
/// does not report within `GUARD_TIMEOUT`, the open fails closed: the child is closed, the registry
/// entry removed, and `guest_guard_failed` returned — an unguarded guest can never load. The element's
/// rect is NOT part of the open: the child is created hidden at 0x0 and placed later by `guest_bounds`,
/// which is where the rect is validated.
#[tauri::command]
pub async fn guest_open(
    app: AppHandle,
    caller: Webview,
    registry: State<'_, GuestRegistry>,
    rpc: State<'_, Rpc>,
    src: String,
    partition: String,
) -> Result<Value, String> {
    ensure_main(&caller)?;

    // MKT: a pack tab is decided by the Rust pack host alone (installed, store-listed, every file re-hashed), never by the
    // sidecar; its src must be exactly the pack's own ui page. Anything else goes through the sidecar policy as before.
    let pack = match crate::pack_host::partition_pack_id(&partition) {
        Some(id) => {
            let state = app.state::<crate::pack_host::PackState>();
            let loaded = match crate::pack_host::open_pack(&state, id) {
                Ok(p) => p,
                Err(code) => {
                    let data_dir = state.data_dir.lock().unwrap().clone();
                    crate::pack_host::log_line(data_dir.as_deref(), &format!("refused open {code} pack={id}"));
                    return Err(format!("pack_refused:{code}"));
                }
            };
            if src != format!("{}{}", crate::pack_host::pack_origin_prefix(id), loaded.ui) {
                return Err("guest_refused".to_string());
            }
            Some(loaded)
        }
        None => None,
    };
    let origin = match &pack {
        Some(p) => format!("{}/{}", crate::pack_host::ORIGIN, p.id),
        None => {
            let decision = decide(rpc.inner(), &src, &partition).await?;
            let allow = decision.get("allow").and_then(Value::as_bool).unwrap_or(false);
            let origin = decision.get("origin").and_then(Value::as_str).unwrap_or("").to_string();
            if !allow || origin.is_empty() {
                return Err("guest_refused".to_string());
            }
            origin
        }
    };
    let kind = kind_for_partition(&partition)?;

    let local_data = app.path().app_local_data_dir().map_err(|e| format!("guest_no_local_data_dir:{e}"))?;
    let base = guest_profile_base(app.state::<crate::guest_cdp::SelfTest>().inner(), &local_data);
    let profile = profile_for_partition(&partition, &base)?;
    std::fs::create_dir_all(&profile.data_dir).map_err(|e| format!("guest_dir_create:{e}"))?;

    let (id, label) = registry.alloc(kind);
    // Parse BEFORE registering: an unparseable src must not leave a registry entry behind.
    let url: Url = src.parse().map_err(|_| "guest_open_url".to_string())?;
    // MKT: bind the label to its pack BEFORE the webview exists, so its very first request is already scoped.
    if let Some(p) = &pack {
        app.state::<crate::pack_host::PackState>().bind(&label, p.clone());
    }
    let unbind_app = app.clone();
    let unbind_label = label.clone();
    let unbind = move || {
        if let Some(state) = unbind_app.try_state::<crate::pack_host::PackState>() {
            state.unbind(&unbind_label);
        }
    };
    let guest = Guest {
        label: label.clone(),
        kind,
        origin: origin.clone(),
        webview: None,
        pending_nav: None,
    };

    // Register, then create the native child; a failed add_child removes the entry so a half-open
    // guest (an id the shim could never close) cannot leak.
    let (webview, guard_rx) = match insert_then_build(
        || registry.insert(id, guest),
        || { registry.remove(id); },
        || add_guest_webview(&app, id, &label, &origin, &profile),
    ) {
        Ok(built) => built,
        Err(e) => {
            unbind();
            return Err(e);
        }
    };

    // Fail closed until the guard is confirmed live on the webview.
    let guard_result = tauri::async_runtime::spawn_blocking(move || guard_rx.recv_timeout(GUARD_TIMEOUT))
        .await
        .map_err(|e| format!("guest_guard_task:{e}"))?;
    let source_kinds = match guard_result {
        Ok(Ok(source_kinds)) => source_kinds,
        _ => {
            let _ = webview.close();
            registry.remove(id);
            unbind();
            return Err("guest_guard_failed".to_string());
        }
    };
    // One stderr line per guest. Never contains a URL.
    eprintln!("guard: {label} source-kinds={source_kinds}");

    if !registry.set_webview(id, webview.clone()) {
        let _ = webview.close();
        return Err("guest_unknown".to_string());
    }
    webview.navigate(url).map_err(|e| format!("guest_navigate:{e}"))?;
    Ok(json!({ "id": id, "label": label }))
}

/// `guest_navigate(id, url)` — reload to a same-origin URL, resolving after the next NavigationCompleted
/// (a finished load) and rejecting with the mapped error when the load fails. The guest's webview was
/// created and guarded by `guest_open`, so a missing one is `guest_not_ready`, not a retry.
#[tauri::command]
pub async fn guest_navigate(
    caller: Webview,
    registry: State<'_, GuestRegistry>,
    id: u64,
    url: String,
) -> Result<Value, String> {
    ensure_main(&caller)?;
    let guest = registry.snapshot(id).ok_or("guest_unknown")?;
    if !same_origin(&url, &guest.origin) {
        return Err("guest_navigate_origin".to_string());
    }
    let parsed: Url = url.parse().map_err(|_| "guest_navigate_url".to_string())?;
    let Some(webview) = guest.webview else {
        return Err("guest_not_ready".to_string());
    };

    let (tx, rx) = mpsc::channel::<Result<(), String>>();
    registry.set_waiter(id, tx); // set BEFORE navigating so a fast NavigationCompleted cannot race past it
    webview.navigate(parsed).map_err(|e| format!("guest_navigate:{e}"))?;

    let received = tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(NAV_TIMEOUT))
        .await
        .map_err(|e| format!("guest_wait_task:{e}"))?;
    match received {
        Ok(Ok(())) => Ok(json!(true)),
        Ok(Err(e)) => Err(e),
        Err(_) => Err("guest_navigate_timeout".to_string()),
    }
}

/// `guest_bounds(id, bounds, visible)` — place and show/hide the native child. The shim calls this only
/// when the rect or the visibility verdict changed.
#[tauri::command]
pub async fn guest_bounds(
    caller: Webview,
    registry: State<'_, GuestRegistry>,
    id: u64,
    bounds: Bounds,
    visible: bool,
) -> Result<(), String> {
    ensure_main(&caller)?;
    let (x, y, width, height) = sanitize_bounds(&bounds)?;
    let guest = registry.snapshot(id).ok_or("guest_unknown")?;
    let Some(webview) = guest.webview else {
        return Ok(()); // open in flight (guard not yet confirmed): nothing to place yet
    };
    let rect = Rect {
        position: Position::Logical(LogicalPosition::new(x, y)),
        size: Size::Logical(LogicalSize::new(width, height)),
    };
    webview.set_bounds(rect).map_err(|e| format!("guest_set_bounds:{e}"))?;
    let result = if visible { webview.show() } else { webview.hide() };
    result.map_err(|e| format!("guest_visibility:{e}"))?;
    Ok(())
}

/// `guest_close(id)` — drop the registry entry and close the native child (the element was removed).
#[tauri::command]
pub async fn guest_close(
    caller: Webview,
    registry: State<'_, GuestRegistry>,
    id: u64,
) -> Result<(), String> {
    ensure_main(&caller)?;
    if let Some(guest) = registry.remove(id) {
        if let Some(state) = caller.app_handle().try_state::<crate::pack_host::PackState>() {
            state.unbind(&guest.label);
        }
        if let Some(webview) = guest.webview {
            let _ = webview.close();
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> PathBuf {
        PathBuf::from("C:/base")
    }

    #[test]
    fn navigation_and_new_window_decisions_for_the_open_route() {
        let origin = "http://127.0.0.1:4545";
        let u = |s: &str| s.parse::<Url>().unwrap();
        let chip = u("http://127.0.0.1:4545/__zumi-open?path=x");
        let page = u("http://127.0.0.1:4545/index.html");
        let off = u("https://zumia.space/");
        // navigation
        assert_eq!(nav_action(&chip, origin, true), NavAction::BoardOpen);
        assert_eq!(nav_action(&chip, origin, false), NavAction::Allow, "any other guest never intercepts");
        assert_eq!(nav_action(&page, origin, true), NavAction::Allow);
        assert_eq!(nav_action(&off, origin, true), NavAction::Cancel);
        assert_eq!(nav_action(&u("http://127.0.0.1:45450/__zumi-open"), origin, true), NavAction::Cancel, "a prefix origin is another origin");
        assert_eq!(nav_action(&u("http://127.0.0.1:4545/__zumi-openx"), origin, true), NavAction::Allow);
        // new window
        assert_eq!(window_action(&chip, origin, true), WindowAction::BoardOpen);
        assert_eq!(window_action(&chip, origin, false), WindowAction::Nothing, "another guest's chip is not an open request");
        assert_eq!(window_action(&page, origin, true), WindowAction::Nothing);
        assert_eq!(window_action(&off, origin, true), WindowAction::External);
        assert_eq!(window_action(&off, origin, false), WindowAction::External);
    }

    #[test]
    fn only_the_board_guest_label_is_a_link_opener() {
        assert!(is_board_label("guest-board-1"));
        assert!(is_board_label("guest-board-17"));
        assert!(!is_board_label("guest-wardrobe-2"));
        assert!(!is_board_label("main"));
        assert!(!is_board_label("guest-boardx-3"));
        assert!(!is_board_label(""));
    }

    #[test]
    fn board_and_live_share_the_board_profile_but_live_is_incognito() {
        let board = profile_for_partition("preview-board", &base()).unwrap();
        let live = profile_for_partition("preview-board-live", &base()).unwrap();
        assert_eq!(board.data_dir, PathBuf::from("C:/base/guest-webview/board"));
        assert!(!board.incognito);
        assert_eq!(live.data_dir, board.data_dir, "the live board shares the board dir");
        assert!(live.incognito, "the live board is in memory (InPrivate)");
    }

    #[test]
    fn a_self_test_launch_keeps_the_guest_profiles_in_its_run_dir() {
        let normal = crate::guest_cdp::SelfTest::default();
        assert_eq!(guest_profile_base(&normal, &base()), base(), "a normal launch keeps the real local data dir");
        for flags in [vec!["--selftest", "D:/runs/self"], vec!["--room-shots", "D:/runs/self"]] {
            let args: Vec<String> = flags.iter().map(|s| s.to_string()).collect();
            let mode = crate::guest_cdp::SelfTest::from_args(&args);
            let profile = profile_for_partition("preview-board", &guest_profile_base(&mode, &base())).unwrap();
            assert_eq!(profile.data_dir, PathBuf::from("D:/runs/self/guest-webview/board"), "{flags:?}");
        }
    }

    #[test]
    fn an_unknown_partition_is_refused() {
        assert_eq!(profile_for_partition("preview-nope", &base()).unwrap_err(), "unknown_partition:preview-nope");
        assert_eq!(kind_for_partition("persist:zumi-board").unwrap_err(), "unknown_partition:persist:zumi-board");
        // 0.3.0-alpha.11: the wardrobe guest is gone; its partition is now just another unknown name.
        assert_eq!(profile_for_partition("preview-wardrobe", &base()).unwrap_err(), "unknown_partition:preview-wardrobe");
        assert_eq!(kind_for_partition("preview-wardrobe").unwrap_err(), "unknown_partition:preview-wardrobe");
    }

    #[test]
    fn same_origin_is_exact_and_a_prefix_is_refused() {
        let origin = "http://127.0.0.1:4212";
        assert!(same_origin(origin, origin), "exact match");
        assert!(same_origin("http://127.0.0.1:4212/", origin), "origin + '/'");
        assert!(same_origin("http://127.0.0.1:4212/a/b?x=1", origin), "a path under the origin");
        assert!(!same_origin("http://127.0.0.1:4212evil.example", origin), "prefix attack");
        assert!(!same_origin("http://127.0.0.1:4213/", origin), "a different port");
        assert!(!same_origin("https://127.0.0.1:4212/", origin), "a different scheme");
        assert!(!same_origin("http://127.0.0.1:4212", ""), "an empty origin never matches");
    }

    #[test]
    fn bounds_are_validated() {
        let ok = Bounds { x: 10.0, y: 20.0, width: 800.0, height: 600.0 };
        assert_eq!(sanitize_bounds(&ok).unwrap(), (10.0, 20.0, 800.0, 600.0));
        assert_eq!(sanitize_bounds(&Bounds { x: -1.0, ..ok }).unwrap_err(), "guest_bounds_negative");
        assert_eq!(sanitize_bounds(&Bounds { width: f64::NAN, ..ok }).unwrap_err(), "guest_bounds_not_finite");
        assert_eq!(sanitize_bounds(&Bounds { height: f64::INFINITY, ..ok }).unwrap_err(), "guest_bounds_not_finite");
        assert_eq!(sanitize_bounds(&Bounds { width: MAX_BOUND + 1.0, ..ok }).unwrap_err(), "guest_bounds_too_large");
    }

    #[test]
    fn a_failed_build_removes_the_registered_entry() {
        // The cleanup guest_open uses, exercised with plain data: owning a real Guest (and so a
        // Webview) in a test binary would need the Common-Controls manifest tauri embeds only for its
        // own workspace tests, and the process dies with STATUS_ENTRYPOINT_NOT_FOUND without it.
        let entries = std::cell::RefCell::new(Vec::<u64>::new());
        let kept = insert_then_build(|| entries.borrow_mut().push(7), || { entries.borrow_mut().retain(|&e| e != 7); }, || Ok::<u32, String>(42));
        assert_eq!(kept.unwrap(), 42);
        assert_eq!(*entries.borrow(), vec![7], "a successful build keeps the entry");
        let failed = insert_then_build(|| entries.borrow_mut().push(8), || { entries.borrow_mut().retain(|&e| e != 8); }, || Err::<u32, String>("guest_add_child:boom".to_string()));
        assert_eq!(failed.unwrap_err(), "guest_add_child:boom");
        assert_eq!(*entries.borrow(), vec![7], "a failed build removes the entry (no half-open guest)");
    }
}
