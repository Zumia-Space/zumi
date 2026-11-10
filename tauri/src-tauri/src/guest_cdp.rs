// T-31 parity step 12-2 — the CDP self-test surface. The `guest_cdp` command IS always in the Tauri invoke table
// (`generate_handler!` in lib.rs); what a launch does not get is permission to run it.
//
// GATE-ANSWER Q5 / BRIEF-12 "Security core": the six Electron self-test methods
// (`executeJavaScript`, `sendInputEvent`, `insertText`, `paste`, `focus`, `capturePage`) are a privileged class
// (main -> eval/input in a guest). They are therefore:
//   * driven by CLI args ONLY, read once at process start (`SelfTest::from_args`), never by settings, an rpc or the
//     environment. The renderer cannot reach or flip the flag;
//   * absent from the shipped capability set: `capabilities-selftest/selftest.json` lives outside `capabilities/` and
//     only `selftest_capability` hands it to `add_capability`, so a normal launch has no ACL grant at all;
//   * refused again in the command body (`not_selftest`), so the two independent locks (ACL + body check) cannot
//     drift. `command_table`/`method_allowed` below are this module's internal method allow-list, NOT the Tauri
//     invoke table.
//
// The pixel half of the self-test (the sidecar -> host requests `__sidecarHost.capture`, `.clipboardImage` and
// `.resize`) is gated on the same flag. `capturePage` runs WebView2's CDP `Page.captureScreenshot`; the PNG is decoded
// here to the BGRA frame the sidecar's frameStats/frameDiff measure (exactly what Electron's `toBitmap()` returns).
//
// Everything that needs a live WebView2 is cfg(windows) and is never exercised by a unit test: the tests below cover
// the CLI gate, the authorization decision, the method allow-list, the self-test-sidecar argument forwarding, and the
// pure PNG/BGRA code.
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::Manager;

use crate::guest::GuestRegistry;

/// The six webview methods, in the order PARITY-PLAN 12 names them. This is this module's internal method allow-list
/// (`command_table`): empty in a normal launch and exactly these in a self-test launch.
pub const CDP_METHODS: [&str; 6] = [
    "executeJavaScript",
    "sendInputEvent",
    "insertText",
    "paste",
    "focus",
    "capturePage",
];

/// How long one CDP round-trip may take. A capture is the slow one; an eval or an input event is milliseconds.
const CDP_TIMEOUT_MS: u64 = 15_000;

/// The self-test modes Electron reads from argv (main.js:138-188) and the sidecar already understands (12-1). The host
/// forwards exactly these to the sidecar, so both halves always agree on the mode and never disagree on a run dir.
const SELF_TEST_DIR_FLAGS: [(&str, &str); 3] = [
    ("--settings-shots", "settingsShots"),
    ("--room-shots", "roomShots"),
    ("--board-stress", "boardStress"),
];

/// The test-only sidecar -> host requests (12-1's selftest-host calls them).
pub const HOST_CAPTURE: &str = "__sidecarHost.capture";
pub const HOST_CLIPBOARD_IMAGE: &str = "__sidecarHost.clipboardImage";
pub const HOST_RESIZE: &str = "__sidecarHost.resize";
/// The guests' network log (guest_requests), for selftest:board-log's `net`.
pub const HOST_NET_LOG: &str = "__sidecarHost.netLog";

/// `true` for the three host requests this module owns. Routed before `open_path`'s shell methods.
pub fn is_host_method(method: &str) -> bool {
    matches!(method, HOST_CAPTURE | HOST_CLIPBOARD_IMAGE | HOST_RESIZE | HOST_NET_LOG)
}

/// The self-test capability document a launch may add, or None for a normal launch. Pure: setup and the resolved-ACL
/// test apply exactly the same decision, so a normal launch can never receive the grant.
pub fn selftest_capability(self_test: &SelfTest) -> Option<&'static str> {
    self_test
        .enabled()
        .then_some(include_str!("../capabilities-selftest/selftest.json"))
}

/// Whether a sidecar -> host request may run. The same CLI mode gates the pixel work; a normal launch refuses every
/// request even if a sidecar somehow sends one.
pub fn host_request_allowed(self_test: &SelfTest, method: &str) -> bool {
    is_host_method(method) && self_test.enabled()
}

/// The command body's decision, in order: the caller is the main webview, the launch is a self-test launch, the method
/// is in the allow-list. Pure, so each refusal is unit-tested (a mutation that drops one layer fails a test).
pub fn authorize(is_main: bool, self_test: &SelfTest, method: &str) -> Result<(), String> {
    if !is_main {
        return Err("not_main_webview".to_string());
    }
    if !self_test.enabled() {
        return Err("not_selftest".to_string());
    }
    if !method_allowed(self_test.enabled(), method) {
        return Err(format!("cdp_method_not_allowed:{method}"));
    }
    Ok(())
}

/// This module's method allow-list for a launch. Empty for a normal launch: no CDP method is dispatchable, whatever the
/// Tauri invoke table holds. The ACL is the other lock (`selftest_capability` grants it only in a self-test run).
pub fn command_table(self_test: bool) -> &'static [&'static str] {
    if self_test {
        &CDP_METHODS
    } else {
        &[]
    }
}

/// The runtime allow-list. Same predicate as the table, kept separate so a caller can never dispatch a name the table
/// does not hold.
pub fn method_allowed(self_test: bool, method: &str) -> bool {
    command_table(self_test).contains(&method)
}

/// Electron's exit code for a finished run, or None when this call is not a run finisher (or not a self-test launch).
/// main.js: selftest/demo/shots exit 0 on `report.ok`, 1 otherwise; the settings probe always exits 0.
pub fn run_finish_code(method: &str, args: &[Value], self_test: bool) -> Option<i32> {
    if !self_test {
        return None;
    }
    match method {
        "probe.finish" => Some(0),
        "selftest.finish" | "demo.finish" | "shots.finish" => {
            let ok = args.first().and_then(|r| r.get("ok")).and_then(Value::as_bool).unwrap_or(false);
            Some(if ok { 0 } else { 1 })
        }
        _ => None,
    }
}

/// Electron's run watchdog: 20 min for a demo, 90 s for the settings probe, 8 min for every other self-test mode.
pub fn run_timeout(self_test: &SelfTest) -> Option<Duration> {
    if !self_test.enabled() {
        return None;
    }
    if self_test.forwarded_args().iter().any(|a| a == "--demo-script") {
        return Some(Duration::from_secs(20 * 60));
    }
    if self_test.forwarded_args().iter().any(|a| a == "--settings-probe") {
        return Some(Duration::from_secs(90));
    }
    Some(Duration::from_secs(8 * 60))
}

/// Set by a run finisher so the watchdog thread stands down; shared by the rpc handler and the timer.
#[derive(Clone, Default)]
pub struct RunWatchdog(std::sync::Arc<std::sync::atomic::AtomicBool>);

impl RunWatchdog {
    pub fn finish(&self) {
        self.0.store(true, Ordering::SeqCst);
    }
    pub fn is_finished(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

/// How long a graceful app.exit may take before the host force-quits. A guest WebView2 that is mid-call can keep the
/// graceful path from ever reaching the Exit event (box re-probe 2ef16d1: a shots run stayed alive 540 s after
/// finishing ok=false); Electron app.exit is immediate, so a finished or timed-out run must never linger.
pub const EXIT_GRACE: Duration = Duration::from_secs(5);

/// Run graceful on its own thread; if the process is still here after grace, run force (which must not return).
/// Generic over the two actions so the fallback is unit-tested without a real app.
pub fn exit_with_fallback<G, F>(graceful: G, force: F, grace: Duration)
where
    G: FnOnce() + Send + 'static,
    F: FnOnce(),
{
    std::thread::spawn(graceful);
    std::thread::sleep(grace);
    force();
}

/// Quit with code: graceful first, then (after EXIT_GRACE) kill the sidecar and end the process.
pub fn exit_run(app: &tauri::AppHandle, code: i32) {
    let graceful_app = app.clone();
    let force_app = app.clone();
    exit_with_fallback(
        move || graceful_app.exit(code),
        move || {
            eprintln!("self-test: graceful exit stalled, forcing exit {code}");
            crate::shutdown_sidecar(force_app.state::<crate::Rpc>().inner());
            std::process::exit(code);
        },
        EXIT_GRACE,
    );
}

/// Exit after the rpc reply has had time to reach the renderer (Electron waits 200-300 ms), like app.exit.
pub fn schedule_exit(app: &tauri::AppHandle, code: i32) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(200));
        exit_run(&app, code);
    });
}

/// Start the run watchdog once at setup. A run that never finishes exits 2, Electron's TIMEOUT code. A normal launch
/// has no watchdog (no mode).
pub fn start_watchdog(app: &tauri::AppHandle, self_test: &SelfTest) {
    let Some(timeout) = run_timeout(self_test) else { return };
    let app = app.clone();
    let watchdog = app.state::<RunWatchdog>().inner().clone();
    std::thread::spawn(move || {
        std::thread::sleep(timeout);
        if !watchdog.is_finished() {
            eprintln!("self-test: TIMEOUT after {}s", timeout.as_secs());
            exit_run(&app, 2);
        }
    });
}

/// A self-test flag value: the next argv item, accepted only when it is an absolute path (the sidecar's own rule, so a
/// relative value can never guess a writable run dir).
fn value_at(argv: &[String], flag: &str) -> Option<String> {
    let i = argv.iter().position(|a| a == flag)?;
    let v = argv.get(i + 1)?;
    Path::new(v).is_absolute().then(|| v.clone())
}

/// The winning mode's run dir, with the sidecar's precedence: selftest > demo > shots > probe. `None` = normal launch.
fn winning_run_dir(argv: &[String]) -> Option<PathBuf> {
    if let Some(dir) = value_at(argv, "--selftest") {
        return Some(PathBuf::from(dir));
    }
    if value_at(argv, "--demo-script").is_some() {
        if let Some(out) = value_at(argv, "--demo-out") {
            return Some(PathBuf::from(out));
        }
    }
    for (flag, _) in SELF_TEST_DIR_FLAGS {
        if let Some(dir) = value_at(argv, flag) {
            return Some(PathBuf::from(dir));
        }
    }
    value_at(argv, "--settings-probe").map(PathBuf::from)
}

/// The argv subset the host forwards to the sidecar: every recognized self-test flag whose value is absolute, plus the
/// mode's boolean switches. Unknown host arguments are never forwarded. A normal launch forwards nothing.
fn forwarded_self_test_args(argv: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    fn push(out: &mut Vec<String>, flag: &str, value: &str) {
        out.push(flag.to_string());
        out.push(value.to_string());
    }
    if let Some(dir) = value_at(argv, "--selftest") {
        push(&mut out, "--selftest", &dir);
    }
    if let (Some(script), Some(out_dir)) = (value_at(argv, "--demo-script"), value_at(argv, "--demo-out")) {
        push(&mut out, "--demo-script", &script);
        push(&mut out, "--demo-out", &out_dir);
        for flag in ["--demo-fixture", "--demo-reflex-only"] {
            if argv.iter().any(|a| a == flag) {
                out.push(flag.to_string());
            }
        }
    }
    for flag in ["--settings-shots", "--room-shots", "--board-stress"] {
        if let Some(dir) = value_at(argv, flag) {
            push(&mut out, flag, &dir);
        }
    }
    if let Some(dir) = value_at(argv, "--settings-probe") {
        push(&mut out, "--settings-probe", &dir);
    }
    // The first-answer-time metric's offline chat provider: only INSIDE a demo launch (it never enables one itself). The
    // plain --selftest suite expects the cloud fixture (talk.js mode 'fixture'), so it never gets the stub; selftest
    // wins the sidecar's precedence over demo, so a combined launch is a selftest launch.
    let demo_launch = value_at(argv, "--selftest").is_none()
        && value_at(argv, "--demo-script").is_some()
        && value_at(argv, "--demo-out").is_some();
    if demo_launch && argv.iter().any(|a| a == "--measure-stub-provider") {
        out.push("--measure-stub-provider".to_string());
    }
    out
}

/// The self-test launch mode. Constructed ONCE from the process argv (`run`), stored in Tauri managed state, and only
/// read afterwards. There is deliberately no setter: the renderer cannot turn it on, and no rpc or setting is consulted.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SelfTest {
    enabled: bool,
    forwarded: Vec<String>,
    run_dir: Option<PathBuf>,
    /// `--data-dir <abs>` of a NORMAL launch (Electron's `--user-data-dir`). Argv only; ignored by a self-test run.
    user_data_dir: Option<PathBuf>,
}

/// The `--data-dir` value of a normal launch: `Ok(None)` when absent, an explicit error when the value is missing,
/// relative or a UNC/verbatim path (a network share would put the profile and secrets on another machine).
pub fn parse_data_dir(argv: &[String]) -> Result<Option<PathBuf>, String> {
    let Some(i) = argv.iter().position(|a| a == "--data-dir") else { return Ok(None) };
    let Some(value) = argv.get(i + 1) else { return Err("--data-dir needs a value".to_string()) };
    if value.starts_with("\\\\") || value.starts_with("//") {
        return Err(format!("--data-dir refuses a UNC path: {value}"));
    }
    if !Path::new(value).is_absolute() {
        return Err(format!("--data-dir must be an absolute path: {value}"));
    }
    Ok(Some(PathBuf::from(value)))
}

/// The file beside the exe that remembers a kit's `--data-dir` (one line: the absolute path). T-31 voice-persist, 09-11:
/// the flag lived only in a shortcut, so a launch without it (the exe double-clicked, a restart by a script) silently
/// opened the roaming app data dir and the kit's data (owner voice, keys, settings) looked lost. The pointer sits in
/// the install folder: whoever can write it can already replace the exe, so it adds no new way to redirect the data.
/// Delete it to go back to the app data dir.
pub const DATA_DIR_POINTER: &str = "zumi-data-dir.txt";
const MAX_POINTER_BYTES: u64 = 4096;

/// Why a remembered data dir was not used. `previous` is the remembered path only when it was a valid path (a missing
/// folder, e.g. an unplugged drive); a rejected or unreadable pointer keeps its text out of every log and notice.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PointerProblem {
    pub reason: &'static str,
    pub previous: Option<PathBuf>,
}

/// The data dir of this launch plus, when a remembered dir could not be used, why (see `data_dir_notice`).
#[derive(Debug, Default, PartialEq, Eq)]
pub struct ResolvedDataDir {
    pub dir: Option<PathBuf>,
    pub problem: Option<PointerProblem>,
}

/// The data dir of this launch (`exe_dir` = the folder of the running exe; `self_test` = a self-test launch).
/// `--data-dir` wins and is remembered beside the exe; without it a normal launch uses the remembered dir. A self-test
/// launch neither reads nor writes the pointer (its data dir is the run dir). A flag-less launch with no pointer reads
/// one missing file and writes nothing.
pub fn resolve_data_dir(argv: &[String], exe_dir: Option<&Path>, self_test: bool) -> Result<ResolvedDataDir, String> {
    let flag = parse_data_dir(argv)?;
    let Some(pointer) = exe_dir.filter(|_| !self_test).map(|d| d.join(DATA_DIR_POINTER)) else {
        return Ok(ResolvedDataDir { dir: flag, problem: None });
    };
    Ok(match flag {
        Some(dir) => {
            remember_data_dir(&pointer, &dir);
            ResolvedDataDir { dir: Some(dir), problem: None }
        }
        None => match remembered_data_dir(&pointer) {
            Ok(dir) => ResolvedDataDir { dir, problem: None },
            Err(problem) => ResolvedDataDir { dir: None, problem: Some(problem) },
        },
    })
}

/// Write the pointer when it is missing or names another dir. A failure (a read-only install folder) is logged and the
/// launch goes on with the flag's dir: only the NEXT flag-less launch is affected.
fn remember_data_dir(pointer: &Path, dir: &Path) {
    let text = dir.to_string_lossy();
    if std::fs::read_to_string(pointer).is_ok_and(|t| t.trim() == text) {
        return;
    }
    let tmp = pointer.with_extension("txt.tmp");
    if let Err(e) = std::fs::write(&tmp, text.as_bytes()).and_then(|()| std::fs::rename(&tmp, pointer)) {
        eprintln!("zumi: --data-dir not remembered in {}: {e}", pointer.display());
    }
}

/// The remembered dir, held to the flag's rules (absolute, no UNC, at most MAX_POINTER_BYTES) and required to still be a
/// folder. `Ok(None)` = no pointer; `Err` = a pointer that cannot be used (the caller records and shows it, because a
/// release build has no stderr).
fn remembered_data_dir(pointer: &Path) -> Result<Option<PathBuf>, PointerProblem> {
    let problem = |reason, previous| PointerProblem { reason, previous };
    let size = match std::fs::metadata(pointer) {
        Ok(meta) => meta.len(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(problem("pointer_unreadable", None)),
    };
    if size > MAX_POINTER_BYTES {
        return Err(problem("pointer_too_large", None));
    }
    let Ok(text) = std::fs::read_to_string(pointer) else { return Err(problem("pointer_unreadable", None)) };
    match parse_data_dir(&["--data-dir".to_string(), text.trim_start_matches('\u{feff}').trim().to_string()]) {
        Ok(Some(dir)) if dir.is_dir() => Ok(Some(dir)),
        Ok(Some(dir)) => Err(problem("folder_not_found", Some(dir))),
        Ok(None) | Err(_) => Err(problem("pointer_rejected", None)),
    }
}

impl SelfTest {
    /// Attach the validated `--data-dir` (see `parse_data_dir`). Only the process entry calls this, from argv.
    pub fn with_user_data_dir(mut self, dir: Option<PathBuf>) -> Self {
        self.user_data_dir = dir;
        self
    }

    /// The launch's `--data-dir` override, only for a normal launch.
    pub fn user_data_dir(&self) -> Option<&Path> {
        if self.enabled { None } else { self.user_data_dir.as_deref() }
    }

    /// Read the mode from argv only. A mode flag with a missing/relative value is not a self-test launch.
    pub fn from_args(argv: &[String]) -> Self {
        let forwarded = forwarded_self_test_args(argv);
        let enabled = !forwarded.is_empty();
        Self {
            enabled,
            forwarded: if enabled { forwarded } else { Vec::new() },
            run_dir: if enabled { winning_run_dir(argv) } else { None },
            user_data_dir: None,
        }
    }

    pub fn enabled(&self) -> bool {
        self.enabled
    }

    /// The args the sidecar must see for the same mode. Empty for a normal launch.
    pub fn forwarded_args(&self) -> &[String] {
        &self.forwarded
    }

    pub fn run_dir(&self) -> Option<&Path> {
        self.run_dir.as_deref()
    }

    /// The data dir a launch owns: a self-test run's `<runDir>/ud` (Electron's per-mode userData layout), otherwise the
    /// app's real data dir. ONE rule, shared by the sidecar spawn and the asset route, so `/external/user.vrm` re-checks
    /// the very settings.json the renderer wrote in that mode. Pure, so the isolation rule is unit-tested.
    pub fn data_dir(&self, app_data_dir: &Path) -> PathBuf {
        match self.run_dir() {
            Some(run_dir) if self.enabled() => run_dir.join("ud"),
            _ => self.user_data_dir().unwrap_or(app_data_dir).to_path_buf(),
        }
    }

    /// `data_dir` when the app data dir may be unavailable (the self-test branch still resolves then).
    pub fn data_dir_or(&self, app_data_dir: Option<&Path>) -> Option<PathBuf> {
        if self.enabled() {
            if let Some(run_dir) = self.run_dir() {
                return Some(run_dir.join("ud"));
            }
        }
        self.user_data_dir().or(app_data_dir).map(Path::to_path_buf)
    }

    /// A capture's `save` path, accepted only inside this run's own directory. The sidecar builds it with path.join(run
    /// dir, basename), so a refusal here means the request did not come from the expected shape.
    fn save_path(&self, save: &str) -> Option<PathBuf> {
        let root = self.run_dir.as_ref()?;
        let path = PathBuf::from(save);
        // A lexical `..` could step out of the run dir; refuse it rather than resolve it.
        if path.components().any(|c| matches!(c, Component::ParentDir)) {
            return None;
        }
        (path.is_absolute() && path.starts_with(root)).then_some(path)
    }
}

/// One captured frame: the PNG (for saving) and the BGRA pixels (for the sidecar's stats/diff), plus its geometry.
struct Grab {
    png: Vec<u8>,
    bgra: Vec<u8>,
    width: u32,
    height: u32,
}

/// `guest_cdp(target, method, args)` — the one command behind the six `<webview>` methods.
///
/// `authorize` checks, in order: the caller is the main webview; the host was launched in self-test mode; the method is
/// in the module allow-list. Only then is a webview resolved and a CDP call issued.
///
/// `#[tauri::command(async)]` (not a plain sync command): `with_webview` only QUEUES the closure on the event-loop
/// thread, so a sync command would read the result before the closure ran (the 12-runtime race: `cdp_no_result`). The
/// async wrapper runs this body on Tauri's thread pool, leaving the event loop free to run the queued closure while
/// `await_cdp` waits on its channel. The wait is bounded by `CDP_TIMEOUT_MS`; a caller that ever ran on the event-loop
/// thread would return the explicit timeout error instead of hanging.
#[tauri::command(async)]
pub fn guest_cdp(
    app: tauri::AppHandle,
    caller: tauri::Webview,
    self_test: tauri::State<'_, SelfTest>,
    registry: tauri::State<'_, GuestRegistry>,
    target: Value,
    method: String,
    args: Option<Vec<Value>>,
) -> Result<Value, String> {
    authorize(crate::guest::is_main(&caller), self_test.inner(), &method)?;
    let webview = resolve_target(&app, &registry, &target)?;
    let args = args.unwrap_or_default();
    run_method(&webview, &method, &args)
}

/// Resolve a command target: `"main"`, `"board"` (the first local board guest) or a guest id from `guest_open`.
fn resolve_target(
    app: &tauri::AppHandle,
    registry: &GuestRegistry,
    target: &Value,
) -> Result<tauri::Webview, String> {
    match target {
        Value::String(name) if name == crate::guest::MAIN_LABEL => {
            app.get_webview(crate::guest::MAIN_LABEL).ok_or_else(|| "no_main_webview".to_string())
        }
        Value::String(name) if name == "board" => registry.board_webview().ok_or_else(|| "no_board_guest".to_string()),
        Value::Number(_) => target
            .as_u64()
            .and_then(|id| registry.webview_for(id))
            .ok_or_else(|| "guest_unknown".to_string()),
        _ => Err("cdp_target".to_string()),
    }
}

/// Map one `<webview>` method to its WebView2 CDP call (or the window command for `focus`).
fn run_method(webview: &tauri::Webview, method: &str, args: &[Value]) -> Result<Value, String> {
    match method {
        "focus" => {
            webview.set_focus().map_err(|e| format!("focus_failed:{e}"))?;
            Ok(json!(true))
        }
        "executeJavaScript" => {
            let code = args.first().and_then(Value::as_str).ok_or_else(|| "bad_request".to_string())?;
            let reply = call_cdp(
                webview,
                "Runtime.evaluate",
                &json!({ "expression": code, "returnByValue": true, "awaitPromise": true, "userGesture": true }),
            )?;
            eval_value(&reply)
        }
        "insertText" => {
            let text = args.first().and_then(Value::as_str).ok_or_else(|| "bad_request".to_string())?;
            call_cdp(webview, "Input.insertText", &json!({ "text": text }))?;
            Ok(json!(true))
        }
        "sendInputEvent" => {
            let event = args.first().ok_or_else(|| "bad_request".to_string())?;
            send_input_event(webview, event)?;
            Ok(json!(true))
        }
        "paste" => {
            // A trusted paste needs a real shortcut: Ctrl+V down (modifiers 2 = Ctrl), then up. Electron's paste() does
            // the same at the WebContents level; WebView2 exposes no paste() of its own.
            let down = json!({ "type": "rawKeyDown", "modifiers": 2, "key": "v", "code": "KeyV",
                               "windowsVirtualKeyCode": 86, "nativeVirtualKeyCode": 86 });
            let up = json!({ "type": "keyUp", "modifiers": 2, "key": "v", "code": "KeyV",
                             "windowsVirtualKeyCode": 86, "nativeVirtualKeyCode": 86 });
            call_cdp(webview, "Input.dispatchKeyEvent", &down)?;
            call_cdp(webview, "Input.dispatchKeyEvent", &up)?;
            Ok(json!(true))
        }
        "capturePage" => {
            let rect = args.first().filter(|r| !r.is_null());
            let grab = grab(webview, rect)?;
            Ok(json!({
                "width": grab.width,
                "height": grab.height,
                "pngBase64": encode_b64(&grab.png),
                "bitmapBase64": encode_b64(&grab.bgra),
            }))
        }
        other => Err(format!("cdp_method_not_allowed:{other}")),
    }
}

/// Electron's `executeJavaScript` resolves to the evaluated value and rejects on a thrown exception.
fn eval_value(reply: &Value) -> Result<Value, String> {
    if let Some(details) = reply.get("exceptionDetails") {
        let text = details
            .get("exception")
            .and_then(|e| e.get("description"))
            .or_else(|| details.get("text"))
            .and_then(Value::as_str)
            .unwrap_or("exception");
        return Err(format!("executeJavaScript:{text}"));
    }
    Ok(reply.get("result").and_then(|r| r.get("value")).cloned().unwrap_or(Value::Null))
}

/// Electron's `sendInputEvent` shapes -> CDP `Input.dispatchKeyEvent` / `Input.dispatchMouseEvent`.
fn send_input_event(webview: &tauri::Webview, event: &Value) -> Result<(), String> {
    let kind = event.get("type").and_then(Value::as_str).ok_or_else(|| "bad_input".to_string())?;
    let reply = match kind {
        "keyDown" | "keyUp" => {
            let key = event.get("keyCode").and_then(Value::as_str).unwrap_or("");
            let (key_name, code, vk) = key_description(key);
            let cdp_type = if kind == "keyDown" { "keyDown" } else { "keyUp" };
            let mut params = json!({
                "type": cdp_type,
                "key": key_name,
                "code": code,
                "windowsVirtualKeyCode": vk,
                "nativeVirtualKeyCode": vk,
            });
            // A printable key carries its text, which is what the page's input handlers see.
            if kind == "keyDown"
                && key.chars().count() == 1
                && key.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
            {
                params["text"] = json!(key);
            }
            call_cdp(webview, "Input.dispatchKeyEvent", &params)?
        }
        "char" => {
            let text = event.get("keyCode").and_then(Value::as_str).unwrap_or("");
            call_cdp(webview, "Input.dispatchKeyEvent", &json!({ "type": "char", "text": text }))?
        }
        "mouseMove" | "mouseDown" | "mouseUp" | "mouseWheel" => {
            let cdp_type = match kind {
                "mouseMove" => "mouseMoved",
                "mouseDown" => "mousePressed",
                "mouseUp" => "mouseReleased",
                _ => "mouseWheel",
            };
            let x = event.get("x").and_then(Value::as_f64).unwrap_or(0.0);
            let y = event.get("y").and_then(Value::as_f64).unwrap_or(0.0);
            let button = event.get("button").and_then(Value::as_str).unwrap_or("left");
            let click_count = event.get("clickCount").and_then(Value::as_u64).unwrap_or(1);
            let mut params = json!({
                "type": cdp_type,
                "x": x,
                "y": y,
                "button": if cdp_type == "mouseMoved" { "none" } else { button },
                "clickCount": click_count,
            });
            if cdp_type == "mouseWheel" {
                params["deltaX"] = event.get("deltaX").cloned().unwrap_or(json!(0));
                params["deltaY"] = event.get("deltaY").cloned().unwrap_or(json!(0));
            }
            call_cdp(webview, "Input.dispatchMouseEvent", &params)?
        }
        other => return Err(format!("bad_input_type:{other}")),
    };
    let _ = reply;
    Ok(())
}

/// Electron key name/char -> (CDP `key`, `code`, Windows virtual-key code).
fn key_description(key: &str) -> (String, String, i32) {
    let named = match key {
        "End" => Some(("End", "End", 35)),
        "Home" => Some(("Home", "Home", 36)),
        "Down" | "ArrowDown" => Some(("ArrowDown", "ArrowDown", 40)),
        "Up" | "ArrowUp" => Some(("ArrowUp", "ArrowUp", 38)),
        "Left" | "ArrowLeft" => Some(("ArrowLeft", "ArrowLeft", 37)),
        "Right" | "ArrowRight" => Some(("ArrowRight", "ArrowRight", 39)),
        "Enter" | "Return" => Some(("Enter", "Enter", 13)),
        "Escape" | "Esc" => Some(("Escape", "Escape", 27)),
        "Tab" => Some(("Tab", "Tab", 9)),
        "Backspace" => Some(("Backspace", "Backspace", 8)),
        "Delete" => Some(("Delete", "Delete", 46)),
        "Space" => Some((" ", "Space", 32)),
        _ => None,
    };
    if let Some((name, code, vk)) = named {
        return (name.to_string(), code.to_string(), vk);
    }
    let mut chars = key.chars();
    match (chars.next(), chars.next()) {
        (Some(c), None) if c.is_ascii_alphanumeric() => {
            let upper = c.to_ascii_uppercase();
            (c.to_string(), format!("Key{upper}"), upper as i32)
        }
        (Some(c), None) => (c.to_string(), String::new(), c as i32),
        _ => (key.to_string(), String::new(), 0),
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Sidecar -> host requests (12-1's selftest-host `hostCall`s).
// ---------------------------------------------------------------------------------------------------------------------

/// Dispatch one `__sidecarHost.*` self-test request. Re-checks the gate itself, so a caller that forgot it still cannot
/// reach a webview or the clipboard on a normal launch.
pub fn dispatch_host_request(
    app: &tauri::AppHandle,
    self_test: &SelfTest,
    method: &str,
    args: &[Value],
) -> Result<Value, String> {
    if !is_host_method(method) {
        return Err(format!("unknown_host_method:{method}"));
    }
    if !host_request_allowed(self_test, method) {
        return Err("not_selftest".to_string());
    }
    match method {
        HOST_RESIZE => {
            let width = args.first().and_then(Value::as_f64).ok_or_else(|| "bad_request".to_string())?;
            let height = args.get(1).and_then(Value::as_f64).ok_or_else(|| "bad_request".to_string())?;
            resize_main(app, width, height)
        }
        HOST_CAPTURE => {
            let request = args.first().cloned().unwrap_or(Value::Null);
            capture(app, self_test, &request)
        }
        HOST_CLIPBOARD_IMAGE => clipboard_image(),
        HOST_NET_LOG => Ok(Value::Array(
            crate::guest_requests::snapshot().into_iter().map(|url| json!({ "url": url })).collect(),
        )),
        other => Err(format!("unknown_host_method:{other}")),
    }
}

/// `mainWindow.setContentSize(w, h); return mainWindow.getContentSize()`. Tauri's `set_size` is the client-area
/// (content) size, the same measure. The sidecar already clamped to 900x600; a non-finite request is refused.
fn resize_main(app: &tauri::AppHandle, width: f64, height: f64) -> Result<Value, String> {
    if !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0 {
        return Err("bad_request".to_string());
    }
    let width = width.round() as u32;
    let height = height.round() as u32;
    let window = app.get_window(crate::guest::MAIN_LABEL).ok_or_else(|| "no_main_window".to_string())?;
    window
        .set_size(tauri::Size::Logical(tauri::LogicalSize::new(width as f64, height as f64)))
        .map_err(|e| format!("resize_failed:{e}"))?;
    Ok(json!([width, height]))
}

/// One capture request: write the raw BGRA frame (for stats/diff) and/or the PNG under the run dir, and report the
/// geometry. `target` is `main` or `board`; `rect` clips (Electron's capturePage(rect)).
fn capture(app: &tauri::AppHandle, self_test: &SelfTest, request: &Value) -> Result<Value, String> {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let target = request.get("target").and_then(Value::as_str).unwrap_or("main");
    let registry = app
        .try_state::<GuestRegistry>()
        .ok_or_else(|| "no_guest_registry".to_string())?;
    let webview = resolve_target(app, registry.inner(), &json!(target))?;
    let rect = request.get("rect").filter(|r| !r.is_null());
    let frame = grab(&webview, rect)?;

    let mut raw_path = Value::Null;
    if request.get("raw").and_then(Value::as_bool).unwrap_or(false) {
        let root = self_test.run_dir().ok_or_else(|| "not_selftest".to_string())?;
        let path = root.join(format!("raw-{}.bgra", NEXT.fetch_add(1, Ordering::Relaxed)));
        std::fs::write(&path, &frame.bgra).map_err(|e| format!("capture_raw_write:{e}"))?;
        raw_path = json!(path.to_string_lossy());
    }

    let mut png_path = Value::Null;
    if let Some(save) = request.get("save").and_then(Value::as_str) {
        let path = self_test.save_path(save).ok_or_else(|| "capture_save_outside_run".to_string())?;
        let png = if request.get("saveFull").and_then(Value::as_bool).unwrap_or(false) && rect.is_some() {
            grab(&webview, None)?.png
        } else {
            frame.png
        };
        std::fs::write(&path, png).map_err(|e| format!("capture_png_write:{e}"))?;
        png_path = json!(path.to_string_lossy());
    }

    Ok(json!({
        "width": frame.width,
        "height": frame.height,
        "pixels": frame.bgra.len() / 4,
        "rawPath": raw_path,
        "pngPath": png_path,
    }))
}

/// Capture the webview as PNG via CDP, then decode it to BGRA. The clip is Electron's rect (CSS px).
fn grab(webview: &tauri::Webview, rect: Option<&Value>) -> Result<Grab, String> {
    let mut params = json!({ "format": "png", "fromSurface": true });
    if let Some(rect) = rect {
        params["clip"] = clip(rect)?;
    }
    let reply = call_cdp(webview, "Page.captureScreenshot", &params)?;
    let data = reply.get("data").and_then(Value::as_str).ok_or_else(|| "capture_no_data".to_string())?;
    let png = decode_b64(data)?;
    let (rgba, width, height) = decode_png(&png)?;
    Ok(Grab { png, bgra: rgba_to_bgra(&rgba), width, height })
}

fn clip(rect: &Value) -> Result<Value, String> {
    let num = |key: &str| rect.get(key).and_then(Value::as_f64).ok_or_else(|| "capture_rect".to_string());
    Ok(json!({
        "x": num("x")?,
        "y": num("y")?,
        "width": num("width")?,
        "height": num("height")?,
        "scale": 1,
    }))
}

/// The self-test clipboard card: a two-colour BGRA image (96x64), written to the OS clipboard as CF_DIB, plus the same
/// image as PNG (base64) so a page that refuses the OS clipboard can `navigator.clipboard.write` it. Mirrors
/// main.js's `selftest:clipboard-image`.
fn clipboard_image() -> Result<Value, String> {
    const W: u32 = 96;
    const H: u32 = 64;
    let mut bgra = Vec::with_capacity((W * H * 4) as usize);
    for y in 0..H {
        for x in 0..W {
            let _ = y;
            let left = x < W / 2;
            // BGRA, the same two-colour card Electron wrote.
            bgra.extend_from_slice(if left { &[40, 120, 220, 255] } else { &[90, 200, 60, 255] });
        }
    }
    let png = encode_png(&rgba_from_bgra(&bgra), W, H)?;
    let (has_png, text_ok, tries) = set_clipboard(&bgra, W, H);
    Ok(json!({
        "width": W,
        "height": H,
        "bytes": png.len(),
        "pngBase64": encode_b64(&png),
        "hasPng": has_png,
        "textOk": text_ok,
        "tries": tries,
    }))
}

// ---------------------------------------------------------------------------------------------------------------------
// WebView2 CDP (Windows only; a unit test never runs it).
// ---------------------------------------------------------------------------------------------------------------------

/// Wait for one dispatch to hand back its result. `dispatch` receives the completion callback and may run it on ANY
/// thread and at any later time (`with_webview` queues it), so this waits on a channel instead of reading a slot.
///
/// The wait is a blocking `recv_timeout`, not a spin, and it cannot deadlock: `call_cdp` is only reached from the
/// `#[tauri::command(async)]` body, which Tauri runs on its blocking pool, so the event-loop thread that must run the
/// queued completion stays free. A timeout returns `cdp_timeout:<ms>`; a dropped callback returns `cdp_no_result`.
fn await_cdp<F>(dispatch: F, timeout: Duration) -> Result<Value, String>
where
    F: FnOnce(Box<dyn FnOnce(Result<Value, String>) + Send>) -> Result<(), String>,
{
    let (tx, rx) = mpsc::channel::<Result<Value, String>>();
    dispatch(Box::new(move |outcome| {
        // A receiver that already timed out is fine: the caller has its answer and the callback is a no-op.
        let _ = tx.send(outcome);
    }))?;
    match rx.recv_timeout(timeout) {
        Ok(outcome) => outcome,
        Err(RecvTimeoutError::Timeout) => Err(format!("cdp_timeout:{}ms", timeout.as_millis())),
        Err(RecvTimeoutError::Disconnected) => Err("cdp_no_result".to_string()),
    }
}

#[cfg(windows)]
fn call_cdp(webview: &tauri::Webview, method: &str, params: &Value) -> Result<Value, String> {
    let timeout = Duration::from_millis(cdp_timeout_ms(method, params));
    let method = method.to_string();
    let params = params.to_string();
    await_cdp(
        move |done| {
            webview
                .with_webview(move |platform| {
                    // On failure to even start the call, answer now; otherwise the completion handler answers later.
                    if let Err(e) = unsafe { call_cdp_on(platform, &method, &params, done) } {
                        eprintln!("cdp: {e}");
                    }
                })
                .map_err(|e| format!("cdp_dispatch:{e}"))
        },
        timeout,
    )
}

/// Issue one CallDevToolsProtocolMethod on the webview's UI thread and RETURN: the completion handler (run later by
/// WebView2 on that same thread) hands the answer to 'done'. It must not pump messages while it waits: a Runtime.evaluate
/// that awaits a promise (a long page action; the old wardrobe Apply took 125-155 s) used to hold the UI thread in a nested pump, which starved
/// every other queued UI job (the next capture timed out: box re-probe 2ef16d1, finding 3).
#[cfg(windows)]
unsafe fn call_cdp_on(
    platform: tauri::webview::PlatformWebview,
    method: &str,
    params: &str,
    done: Box<dyn FnOnce(Result<Value, String>) + Send>,
) -> Result<(), String> {
    use std::cell::RefCell;
    use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
    use windows_core::PCWSTR;

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }
    let core = platform.controller().CoreWebView2().map_err(|e| format!("cdp_core:{e}"))?;
    let method_w = wide(method);
    let params_w = wide(params);
    let done = RefCell::new(Some(done));
    let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |error, json| {
        if let Some(done) = done.borrow_mut().take() {
            done(match error {
                Ok(()) => serde_json::from_str::<Value>(&json).map_err(|e| format!("cdp_bad_json:{e}")),
                Err(e) => Err(format!("cdp_failed:{e}")),
            });
        }
        Ok(())
    }));
    core.CallDevToolsProtocolMethod(PCWSTR(method_w.as_ptr()), PCWSTR(params_w.as_ptr()), &handler)
        .map_err(|e| format!("cdp_call:{e}"))
}

/// How long the caller waits for one CDP answer. A script that awaits a promise has no fixed bound in Electron
/// (executeJavaScript resolves whenever the page does); a long page action (the old wardrobe Apply: 125-155 s) gets 10 minutes
/// (the run watchdog is 8). Every other call keeps the short bound.
pub fn cdp_timeout_ms(method: &str, params: &Value) -> u64 {
    let awaits = method == "Runtime.evaluate" && params.get("awaitPromise").and_then(Value::as_bool).unwrap_or(false);
    if awaits { AWAIT_PROMISE_TIMEOUT_MS } else { CDP_TIMEOUT_MS }
}

const AWAIT_PROMISE_TIMEOUT_MS: u64 = 10 * 60 * 1000;

#[cfg(not(windows))]
fn call_cdp(_webview: &tauri::Webview, _method: &str, _params: &Value) -> Result<Value, String> {
    Err("cdp_windows_only".to_string())
}

// ---------------------------------------------------------------------------------------------------------------------
// Win32 clipboard (self-test card). The system takes ownership of a successful SetClipboardData handle; only a failed
// SetClipboardData frees it.
// ---------------------------------------------------------------------------------------------------------------------

#[cfg(windows)]
fn set_clipboard(bgra: &[u8], width: u32, height: u32) -> (bool, bool, Value) {
    use windows::Win32::Foundation::{HANDLE, HGLOBAL};
    use windows::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard, SetClipboardData,
    };
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    use windows::Win32::System::Ole::{CF_DIB, CF_UNICODETEXT};

    /// A bottom-up 32-bit BI_RGB DIB: the 40-byte BITMAPINFOHEADER followed by BGRA rows.
    fn dib(bgra: &[u8], width: u32, height: u32) -> Vec<u8> {
        let stride = width as usize * 4;
        let mut out = vec![0u8; 40 + stride * height as usize];
        out[0..4].copy_from_slice(&40u32.to_le_bytes());
        out[4..8].copy_from_slice(&(width as i32).to_le_bytes());
        out[8..12].copy_from_slice(&(height as i32).to_le_bytes());
        out[12..14].copy_from_slice(&1u16.to_le_bytes());
        out[14..16].copy_from_slice(&32u16.to_le_bytes());
        out[20..24].copy_from_slice(&((stride * height as usize) as u32).to_le_bytes());
        for row in 0..height as usize {
            let source = (height as usize - 1 - row) * stride;
            let dest = 40 + row * stride;
            out[dest..dest + stride].copy_from_slice(&bgra[source..source + stride]);
        }
        out
    }

    let put = |format: u32, bytes: &[u8]| -> bool {
        unsafe {
            let Ok(handle) = GlobalAlloc(GMEM_MOVEABLE, bytes.len()) else { return false };
            let ptr = GlobalLock(handle);
            if ptr.is_null() {
                let _ = windows::Win32::Foundation::GlobalFree(Some(handle));
                return false;
            }
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr as *mut u8, bytes.len());
            let _ = GlobalUnlock(handle);
            match SetClipboardData(format, Some(HANDLE(handle.0))) {
                Ok(_) => true,
                Err(_) => {
                    let _ = windows::Win32::Foundation::GlobalFree(Some(handle));
                    false
                }
            }
        }
    };

    let image = dib(bgra, width, height);
    let text: Vec<u16> = "zumi-selftest".encode_utf16().chain(std::iter::once(0)).collect();
    let text_bytes: Vec<u8> = text.iter().flat_map(|u| u.to_le_bytes()).collect();
    let (mut image_ok, mut text_ok) = (false, false);
    unsafe {
        if OpenClipboard(None).is_ok() {
            let _ = EmptyClipboard();
            image_ok = put(CF_DIB.0 as u32, &image) && IsClipboardFormatAvailable(CF_DIB.0 as u32).is_ok();
            text_ok = put(CF_UNICODETEXT.0 as u32, &text_bytes) && {
                match GetClipboardData(CF_UNICODETEXT.0 as u32) {
                    Ok(handle) => {
                        let ptr = GlobalLock(HGLOBAL(handle.0));
                        let ok = if ptr.is_null() {
                            false
                        } else {
                            let mut len = 0usize;
                            while *(ptr as *const u16).add(len) != 0 {
                                len += 1;
                            }
                            let read = String::from_utf16_lossy(std::slice::from_raw_parts(ptr as *const u16, len));
                            let _ = GlobalUnlock(HGLOBAL(handle.0));
                            read == "zumi-selftest"
                        };
                        ok
                    }
                    Err(_) => false,
                }
            };
            let _ = CloseClipboard();
        }
    }
    let tries = json!([
        { "label": "CF_DIB", "has": image_ok },
        { "label": "CF_UNICODETEXT", "has": text_ok },
    ]);
    (image_ok, text_ok, tries)
}

#[cfg(not(windows))]
fn set_clipboard(_bgra: &[u8], _width: u32, _height: u32) -> (bool, bool, Value) {
    (false, false, json!([{ "label": "unsupported", "has": false }]))
}

// ---------------------------------------------------------------------------------------------------------------------
// PNG / base64 / colour helpers (pure; unit-tested).
// ---------------------------------------------------------------------------------------------------------------------

fn decode_b64(value: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(value)
        .map_err(|e| format!("base64_decode:{e}"))
}

fn encode_b64(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// Decode a PNG to 8-bit RGBA, whatever its stored colour type.
fn decode_png(bytes: &[u8]) -> Result<(Vec<u8>, u32, u32), String> {
    let mut decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder.read_info().map_err(|e| format!("png_read:{e}"))?;
    let mut buf = vec![0u8; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf).map_err(|e| format!("png_frame:{e}"))?;
    let data = &buf[..info.buffer_size()];
    let (width, height) = (info.width, info.height);
    let rgba = match info.color_type {
        png::ColorType::Rgba => data.to_vec(),
        png::ColorType::Rgb => {
            let mut out = Vec::with_capacity((width as usize) * (height as usize) * 4);
            for px in data.chunks_exact(3) {
                out.extend_from_slice(&[px[0], px[1], px[2], 255]);
            }
            out
        }
        png::ColorType::Grayscale => {
            let mut out = Vec::with_capacity((width as usize) * (height as usize) * 4);
            for &g in data {
                out.extend_from_slice(&[g, g, g, 255]);
            }
            out
        }
        png::ColorType::GrayscaleAlpha => {
            let mut out = Vec::with_capacity((width as usize) * (height as usize) * 4);
            for px in data.chunks_exact(2) {
                out.extend_from_slice(&[px[0], px[0], px[0], px[1]]);
            }
            out
        }
        other => return Err(format!("png_color:{other:?}")),
    };
    Ok((rgba, width, height))
}

fn encode_png(rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().map_err(|e| format!("png_header:{e}"))?;
        writer.write_image_data(rgba).map_err(|e| format!("png_write:{e}"))?;
    }
    Ok(out)
}

/// RGBA -> BGRA by swapping the red and blue channels (every byte, alpha untouched).
fn rgba_to_bgra(rgba: &[u8]) -> Vec<u8> {
    let mut out = rgba.to_vec();
    for px in out.chunks_exact_mut(4) {
        px.swap(0, 2);
    }
    out
}

fn rgba_from_bgra(bgra: &[u8]) -> Vec<u8> {
    rgba_to_bgra(bgra)
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_script_that_awaits_a_promise_may_run_longer_than_the_short_cdp_bound() {
        let awaiting = json!({ "expression": "x", "awaitPromise": true });
        let plain = json!({ "expression": "x", "awaitPromise": false });
        assert!(super::cdp_timeout_ms("Runtime.evaluate", &awaiting) >= 3 * 60 * 1000, "a long page action (125-155 s measured) fits");
        assert_eq!(super::cdp_timeout_ms("Runtime.evaluate", &plain), super::CDP_TIMEOUT_MS);
        assert_eq!(super::cdp_timeout_ms("Page.captureScreenshot", &json!({})), super::CDP_TIMEOUT_MS);
    }

    #[test]
    fn a_stalled_graceful_exit_is_forced_after_the_grace() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;
        let forced = Arc::new(AtomicBool::new(false));
        let flag = forced.clone();
        // The graceful path never returns (a hung WebView2 teardown); the fallback must still run.
        super::exit_with_fallback(|| std::thread::sleep(std::time::Duration::from_secs(60)), move || flag.store(true, Ordering::SeqCst), std::time::Duration::from_millis(50));
        assert!(forced.load(Ordering::SeqCst), "the force path ran although the graceful exit never finished");
    }

    use super::*;

    fn argv(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_normal_launch_has_no_self_test_mode_and_no_allowed_cdp_method() {
        for flags in [vec![], vec!["--data-dir", "D:/data"], vec!["--selftest", "relative"], vec!["ZUMI_SELFTEST=1"]] {
            let mode = SelfTest::from_args(&argv(&flags));
            assert!(!mode.enabled(), "{flags:?} must not be a self-test launch");
            assert!(mode.forwarded_args().is_empty(), "nothing is forwarded for {flags:?}");
            assert!(mode.run_dir().is_none());
            assert!(command_table(mode.enabled()).is_empty(), "a normal launch's method allow-list is empty");
            for method in CDP_METHODS {
                assert!(!method_allowed(mode.enabled(), method), "{method} must not be allowed in a normal launch");
            }
        }
    }

    #[test]
    fn data_dir_override_moves_every_normal_launch_path_and_is_argv_only() {
        // SAFETY of the argv-only rule: an env var / settings value never reaches parse_data_dir or from_args.
        std::env::set_var("ZUMI_DATA_DIR", "D:/from-env");
        let none = SelfTest::from_args(&argv(&[])).with_user_data_dir(parse_data_dir(&argv(&[])).unwrap());
        assert_eq!(none.user_data_dir(), None, "no flag -> no override, whatever the env says");
        let app = Path::new("C:/appdata/space.zumia.preview");
        assert_eq!(none.data_dir(app), app, "without the flag behaviour is unchanged");
        let flags = argv(&["--data-dir", "D:/portable"]);
        let mode = SelfTest::from_args(&flags).with_user_data_dir(parse_data_dir(&flags).unwrap());
        assert!(!mode.enabled(), "--data-dir is not a self-test mode");
        assert_eq!(mode.data_dir(app), Path::new("D:/portable"));
        assert_eq!(mode.data_dir_or(None), Some(PathBuf::from("D:/portable")));
        assert_eq!(crate::guest::guest_profile_base(&mode, Path::new("C:/local")), PathBuf::from("D:/portable"));
        assert_eq!(crate::webview_data_dir(&mode), Some(PathBuf::from("D:/portable/webview")));
        // A self-test run keeps its own run dir even when the flag is also given.
        let st = argv(&["--selftest", "D:/run", "--data-dir", "D:/portable"]);
        let both = SelfTest::from_args(&st).with_user_data_dir(parse_data_dir(&st).unwrap());
        assert_eq!(both.data_dir(app), Path::new("D:/run").join("ud"));
        assert_eq!(crate::webview_data_dir(&both), Some(Path::new("D:/run").join("webview")));
    }

    #[test]
    fn data_dir_override_refuses_relative_unc_and_missing_values() {
        for bad in [vec!["--data-dir"], vec!["--data-dir", "rel/dir"], vec!["--data-dir", r"\\srv\share\z"],
                    vec!["--data-dir", "//srv/share/z"], vec!["--data-dir", r"\\?\D:\x"], vec!["--data-dir", ""]] {
            assert!(parse_data_dir(&argv(&bad)).is_err(), "{bad:?} must be refused");
        }
    }

    /// A fresh `<temp>/<name>-<pid>` dir in the OS temp dir (never %APPDATA%).
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn launch(args: &[&str], exe_dir: &Path) -> SelfTest {
        let a = argv(args);
        let mode = SelfTest::from_args(&a);
        let enabled = mode.enabled();
        mode.with_user_data_dir(resolve_data_dir(&a, Some(exe_dir), enabled).unwrap().dir)
    }

    #[test]
    fn a_kit_started_without_its_data_dir_flag_keeps_the_kit_data() {
        // T-31 voice-persist, measured on anh's PC 09-11: the preview kit kept its data (owner-voice.json + the owner key)
        // in <kit>/data through a `--data-dir` shortcut; the app started 06-11 WITHOUT the flag opened the roaming
        // %APPDATA%\space.zumia.preview instead, and Zumi had no voice.
        let kit = scratch("zumi-kit-data-dir");
        let (exe_dir, data, roaming) = (kit.join("app"), kit.join("data"), kit.join("roaming").join("space.zumia.preview"));
        for d in [&exe_dir, &data, &roaming] { std::fs::create_dir_all(d).unwrap(); }
        std::fs::write(data.join("owner-voice.json"), r#"{"v":1,"zumiaVoice":true}"#).unwrap();
        let data_arg = data.to_str().unwrap();

        let first = launch(&["--data-dir", data_arg], &exe_dir);
        assert_eq!(first.data_dir(&roaming), data, "the flag still chooses the data dir");
        let plain = launch(&[], &exe_dir);
        assert_eq!(plain.data_dir(&roaming), data, "a launch without the flag must open the kit data, not the roaming dir");
        assert!(plain.data_dir(&roaming).join("owner-voice.json").is_file(), "the owner voice is found");
        assert_eq!(crate::webview_data_dir(&plain), Some(data.join("webview")), "the webview profile follows too");

        // A self-test launch never uses the remembered dir: its data dir is the run dir.
        let run = kit.join("run");
        let st = launch(&["--selftest", run.to_str().unwrap()], &exe_dir);
        assert_eq!(st.data_dir(&roaming), run.join("ud"));

        // A new flag replaces the remembered dir.
        let other = kit.join("data2");
        std::fs::create_dir_all(&other).unwrap();
        launch(&["--data-dir", other.to_str().unwrap()], &exe_dir);
        assert_eq!(launch(&[], &exe_dir).data_dir(&roaming), other);
        // A pointer written by hand (PowerShell 5 `Set-Content -Encoding UTF8` adds a BOM, Notepad a CRLF) still works.
        std::fs::write(exe_dir.join(DATA_DIR_POINTER), format!("\u{feff}{}\r\n", data.display())).unwrap();
        assert_eq!(launch(&[], &exe_dir).data_dir(&roaming), data, "a BOM and a line end are not part of the path");

        // The remembered dir passes the same rules as the flag, and must still be a folder; otherwise the app data dir.
        for bad in [r"\\srv\share\z", "rel/dir", ""] {
            std::fs::write(exe_dir.join(DATA_DIR_POINTER), bad).unwrap();
            assert_eq!(launch(&[], &exe_dir).data_dir(&roaming), roaming, "{bad:?} must be ignored");
            let problem = resolve_data_dir(&[], Some(&exe_dir), false).unwrap().problem;
            assert_eq!(problem, Some(PointerProblem { reason: "pointer_rejected", previous: None }), "{bad:?}: reported, its text kept out");
        }
        std::fs::write(exe_dir.join(DATA_DIR_POINTER), "x".repeat(5000)).unwrap();
        assert_eq!(resolve_data_dir(&[], Some(&exe_dir), false).unwrap(), ResolvedDataDir { dir: None, problem: Some(PointerProblem { reason: "pointer_too_large", previous: None }) });
        let gone = kit.join("gone");
        std::fs::write(exe_dir.join(DATA_DIR_POINTER), gone.to_str().unwrap()).unwrap();
        assert_eq!(launch(&[], &exe_dir).data_dir(&roaming), roaming, "a remembered dir that no longer exists is ignored");
        assert_eq!(
            resolve_data_dir(&[], Some(&exe_dir), false).unwrap().problem,
            Some(PointerProblem { reason: "folder_not_found", previous: Some(gone.clone()) }),
            "an unplugged drive is reported with the folder it named"
        );
        assert_eq!(resolve_data_dir(&[], Some(&exe_dir), true).unwrap(), ResolvedDataDir::default(), "a self-test launch never reads it");
        let _ = std::fs::remove_dir_all(&kit);
    }

    #[test]
    fn a_flagless_launch_without_a_pointer_writes_nothing() {
        // The public install (no --data-dir ever given) is unchanged: the app data dir, no problem, no file created.
        let exe_dir = scratch("zumi-no-pointer");
        assert_eq!(resolve_data_dir(&argv(&[]), Some(&exe_dir), false).unwrap(), ResolvedDataDir::default());
        assert_eq!(std::fs::read_dir(&exe_dir).unwrap().count(), 0, "nothing is written beside the exe");
        let _ = std::fs::remove_dir_all(&exe_dir);
    }

    #[test]
    fn may1_keeps_the_roaming_dir_with_or_without_the_flag() {
        // CoS decision 09-11 (0.3.2 RC): Máy 1 keeps roaming %APPDATA%\space.zumia.preview as its live data dir. A
        // flag-less launch with no pointer must use the app data dir and write nothing; a launch with --data-dir set to
        // that roaming dir must record it, replacing a pointer to the old portable kit dir, so later flag-less launches
        // (and a Zumi.exe whose own app data dir is space.zumia.zumi) keep opening it.
        let root = scratch("zumi-may1-roaming");
        let (exe_dir, kit, roaming) = (root.join("app"), root.join("kit-data"), root.join("Roaming").join("space.zumia.preview"));
        for d in [&exe_dir, &kit, &roaming] { std::fs::create_dir_all(d).unwrap(); }
        let pointer = exe_dir.join(DATA_DIR_POINTER);

        let plain = resolve_data_dir(&argv(&[]), Some(&exe_dir), false).unwrap();
        assert_eq!(plain, ResolvedDataDir::default(), "no flag, no pointer: the app data dir, no problem");
        assert_eq!(launch(&[], &exe_dir).data_dir(&roaming), roaming);
        assert!(!pointer.exists(), "a flag-less launch writes no pointer");

        std::fs::write(&pointer, kit.to_str().unwrap()).unwrap();
        let flagged = launch(&["--data-dir", roaming.to_str().unwrap()], &exe_dir);
        assert_eq!(flagged.data_dir(&roaming), roaming);
        assert_eq!(std::fs::read_to_string(&pointer).unwrap(), roaming.to_str().unwrap(), "the pointer now names roaming");
        let other_app_dir = root.join("Roaming").join("space.zumia.zumi");
        assert_eq!(launch(&[], &exe_dir).data_dir(&other_app_dir), roaming, "a flag-less launch follows the pointer");
        assert_eq!(resolve_data_dir(&argv(&[]), Some(&exe_dir), false).unwrap().problem, None);

        // `--data-dir=<path>` is not the flag (argv needs two tokens): it is ignored, so a shortcut must use a space.
        let eq = format!("--data-dir={}", kit.display());
        assert_eq!(parse_data_dir(&argv(&[eq.as_str()])).unwrap(), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_self_test_launch_has_the_six_methods_in_the_allow_list() {
        let mode = SelfTest::from_args(&argv(&["--selftest", "D:/run"]));
        assert!(mode.enabled());
        assert_eq!(mode.run_dir(), Some(Path::new("D:/run")));
        assert_eq!(command_table(true), &CDP_METHODS[..]);
        assert_eq!(command_table(true).len(), 6);
        for method in CDP_METHODS {
            assert!(method_allowed(true, method), "{method} must be allowed in self-test mode");
        }
        for other in ["Runtime.evaluate", "Page.captureScreenshot", "guest_cdp", "__sidecarHost.capture", ""] {
            assert!(!method_allowed(true, other), "{other} is not a webview method");
        }
    }

    #[test]
    fn the_renderer_cannot_set_the_flag() {
        // The mode is created from the process argv once (run), kept in managed state, and only read later. There is no
        // request field, rpc, setting or environment read that can change it: a renderer-shaped token is just an
        // unknown argument, and a normal launch's allow-list stays empty no matter what the renderer names.
        let off = SelfTest::from_args(&argv(&["--data-dir", "D:/data", "--guest_cdp=1", "--selftest-mode", "D:/run"]));
        assert!(!off.enabled(), "only the exact CLI flags are a mode; a renderer/option-shaped token is not");
        assert!(command_table(off.enabled()).is_empty());
        let on = SelfTest::from_args(&argv(&["--selftest", "D:/run"]));
        assert!(on.enabled());
        assert!(!command_table(true).is_empty());
        // The three shot modes and the demo/probe modes are the same CLI-only set.
        for flags in [
            vec!["--settings-shots", "D:/shots"],
            vec!["--room-shots", "D:/shots"],
            vec!["--board-stress", "D:/shots"],
            vec!["--settings-probe", "D:/probe"],
            vec!["--demo-script", "D:/demo/lines.json", "--demo-out", "D:/demo/out"],
        ] {
            assert!(SelfTest::from_args(&argv(&flags)).enabled(), "{flags:?} is a self-test mode");
        }
    }

    #[test]
    fn the_sidecar_receives_exactly_the_flag_that_enabled_the_mode() {
        let mode = SelfTest::from_args(&argv(&[
            "ZumiPreview.exe", "--selftest", "D:/run", "--data-dir", "D:/data", "--other", "x",
        ]));
        assert_eq!(mode.forwarded_args(), argv(&["--selftest", "D:/run"]).as_slice());
        let demo = SelfTest::from_args(&argv(&[
            "--demo-script", "D:/demo/lines.json", "--demo-out", "D:/demo/out", "--demo-fixture", "--data-dir", "D:/d",
        ]));
        assert_eq!(
            demo.forwarded_args(),
            argv(&["--demo-script", "D:/demo/lines.json", "--demo-out", "D:/demo/out", "--demo-fixture"]).as_slice()
        );
        assert_eq!(demo.run_dir(), Some(Path::new("D:/demo/out")));
        let shots = SelfTest::from_args(&argv(&["--room-shots", "D:/shots", "--other"]));
        assert_eq!(shots.forwarded_args(), argv(&["--room-shots", "D:/shots"]).as_slice());
        // 0.3.0-alpha.11: --wardrobe-shots is no longer a mode at all.
        assert!(!SelfTest::from_args(&argv(&["--wardrobe-shots", "D:/shots"])).enabled());
    }

    #[test]
    fn the_measure_stub_flag_reaches_the_sidecar_only_inside_a_demo_launch() {
        let demo = argv(&["--demo-script", "D:/demo/lines.json", "--demo-out", "D:/demo/out", "--measure-stub-provider"]);
        assert_eq!(SelfTest::from_args(&demo).forwarded_args(), demo.as_slice());
        // The plain selftest suite expects the cloud fixture (talk.js: mode 'fixture'), so the stub is not forwarded there.
        let selftest = SelfTest::from_args(&argv(&["--selftest", "D:/run", "--measure-stub-provider"]));
        assert_eq!(selftest.forwarded_args(), argv(&["--selftest", "D:/run"]).as_slice());
        // selftest wins the sidecar's precedence over demo, so a combined launch is a selftest launch: no stub.
        let both = SelfTest::from_args(&argv(&["--selftest", "D:/run", "--demo-script", "D:/d/l.json", "--demo-out", "D:/d/o", "--measure-stub-provider"]));
        assert!(!both.forwarded_args().iter().any(|a| a == "--measure-stub-provider"));
        let shots = SelfTest::from_args(&argv(&["--settings-shots", "D:/shots", "--measure-stub-provider"]));
        assert_eq!(shots.forwarded_args(), argv(&["--settings-shots", "D:/shots"]).as_slice());
        // Alone it neither enables a mode nor is forwarded: a normal launch cannot reach the stub.
        let alone = SelfTest::from_args(&argv(&["--measure-stub-provider"]));
        assert!(!alone.enabled());
        assert!(alone.forwarded_args().is_empty());
    }

    #[test]
    fn the_command_body_refuses_not_main_not_selftest_and_not_allowed() {
        let normal = SelfTest::default();
        let on = SelfTest::from_args(&argv(&["--selftest", "D:/run"]));
        // Layer 1: only the main webview may call it, in either mode.
        assert_eq!(authorize(false, &on, "executeJavaScript").unwrap_err(), "not_main_webview");
        assert_eq!(authorize(false, &normal, "executeJavaScript").unwrap_err(), "not_main_webview");
        // Layer 2: the launch must be a self-test launch.
        assert_eq!(authorize(true, &normal, "executeJavaScript").unwrap_err(), "not_selftest");
        for method in CDP_METHODS {
            assert_eq!(authorize(true, &normal, method).unwrap_err(), "not_selftest", "{method} on a normal launch");
        }
        // Layer 3: only the six webview methods, and only in a self-test launch.
        assert_eq!(
            authorize(true, &on, "guest_cdp").unwrap_err(),
            "cdp_method_not_allowed:guest_cdp",
            "the command itself is not a webview method"
        );
        assert_eq!(authorize(true, &on, "").unwrap_err(), "cdp_method_not_allowed:");
        for method in CDP_METHODS {
            assert_eq!(authorize(true, &on, method), Ok(()), "{method} must pass all three layers");
        }
    }

    #[test]
    fn only_a_self_test_launch_gets_the_capability_document() {
        assert!(selftest_capability(&SelfTest::default()).is_none(), "a normal launch adds no capability");
        assert!(selftest_capability(&SelfTest::from_args(&argv(&[]))).is_none());
        // A renderer/option-shaped token is not a mode either.
        assert!(selftest_capability(&SelfTest::from_args(&argv(&["--guest_cdp=1"]))).is_none());
        for flags in [
            vec!["--selftest", "D:/run"],
            vec!["--settings-shots", "D:/shots"],
            vec!["--room-shots", "D:/shots"],
            vec!["--board-stress", "D:/shots"],
            vec!["--settings-probe", "D:/probe"],
            vec!["--demo-script", "D:/demo/lines.json", "--demo-out", "D:/demo/out"],
        ] {
            let mode = SelfTest::from_args(&argv(&flags));
            let capability = selftest_capability(&mode).unwrap_or_else(|| panic!("{flags:?} must grant the capability"));
            assert!(capability.contains("selftest-cdp"), "{flags:?} must hand over the self-test capability document");
            assert!(capability.contains("allow-guest-cdp"), "{flags:?}");
        }
    }

    #[test]
    fn a_normal_launch_refuses_every_sidecar_host_request() {
        let normal = SelfTest::default();
        for method in [HOST_CAPTURE, HOST_CLIPBOARD_IMAGE, HOST_RESIZE, HOST_NET_LOG] {
            assert!(!host_request_allowed(&normal, method), "{method} must be refused on a normal launch");
        }
        let on = SelfTest::from_args(&argv(&["--selftest", "D:/run"]));
        for method in [HOST_CAPTURE, HOST_CLIPBOARD_IMAGE, HOST_RESIZE, HOST_NET_LOG] {
            assert!(host_request_allowed(&on, method), "{method} is available in a self-test launch");
        }
        // Only the three names this module owns, in any mode.
        assert!(!host_request_allowed(&on, "__sidecarHost.shell.openPath"));
        assert!(!host_request_allowed(&on, "guest_cdp"));
    }

    #[test]
    fn the_self_test_mode_reads_no_environment_variable() {
        // R6 regression guard: the mode comes from argv alone. Read this file's own source (its comments included) and
        // refuse the env reader spellings; the needles are assembled so the assertion text cannot match itself.
        let source = include_str!("guest_cdp.rs");
        for needle in [format!("env{}var", "::"), format!("env{}var_os", "::")] {
            assert!(!source.contains(&needle), "guest_cdp.rs must not read {needle} (the mode is argv-only)");
        }
    }

    #[test]
    fn a_capture_may_only_write_inside_its_own_run_dir() {
        let mode = SelfTest::from_args(&argv(&["--selftest", "D:/run"]));
        assert_eq!(mode.save_path("D:/run/00-idle.png"), Some(PathBuf::from("D:/run/00-idle.png")));
        assert_eq!(mode.save_path("D:/run/nested/a.png"), Some(PathBuf::from("D:/run/nested/a.png")));
        for bad in ["D:/elsewhere/a.png", "D:/runner/a.png", "relative.png", "D:/run/../escape.png", ""] {
            assert_eq!(mode.save_path(bad), None, "{bad:?} must not be written");
        }
        // No run dir = no capture write at all.
        assert_eq!(SelfTest::from_args(&argv(&[])).save_path("D:/run/a.png"), None);
    }

    #[test]
    fn the_host_methods_are_the_three_selftest_host_requests_only() {
        for method in [HOST_CAPTURE, HOST_CLIPBOARD_IMAGE, HOST_RESIZE, HOST_NET_LOG] {
            assert!(is_host_method(method), "{method}");
        }
        for other in ["__sidecarHost.shell.openPath", "__sidecarHost.shell.openExternal", "__sidecarHost.nope", ""] {
            assert!(!is_host_method(other), "{other} belongs to another dispatcher");
        }
    }

    #[test]
    fn an_input_event_maps_to_the_cdp_key_names() {
        assert_eq!(key_description("End"), ("End".to_string(), "End".to_string(), 35));
        assert_eq!(key_description("Home"), ("Home".to_string(), "Home".to_string(), 36));
        assert_eq!(key_description("Down"), ("ArrowDown".to_string(), "ArrowDown".to_string(), 40));
        assert_eq!(key_description("Up"), ("ArrowUp".to_string(), "ArrowUp".to_string(), 38));
        assert_eq!(key_description("A"), ("A".to_string(), "KeyA".to_string(), 65));
        assert_eq!(key_description("z"), ("z".to_string(), "KeyZ".to_string(), 90));
        assert_eq!(key_description("!"), ("!".to_string(), "".to_string(), 33));
    }

    #[test]
    fn the_png_round_trip_is_bgra_for_the_sidecar_stats() {
        // A two-colour RGBA card -> PNG -> decode -> BGRA, the path a real capture takes.
        let (w, h) = (8u32, 4u32);
        let mut rgba = Vec::new();
        for x in 0..w {
            let (r, g, b) = if x < w / 2 { (220, 120, 40) } else { (60, 200, 90) };
            for _ in 0..h {
                rgba.extend_from_slice(&[r, g, b, 255]);
            }
        }
        // The helper expects row-major: rebuild properly (x outer above is column-major, same pixels either way).
        let png = encode_png(&rgba, w, h).expect("encode");
        let (decoded, dw, dh) = decode_png(&png).expect("decode");
        assert_eq!((dw, dh), (w, h));
        assert_eq!(decoded, rgba, "RGBA survives the PNG round trip");
        let bgra = rgba_to_bgra(&decoded);
        assert_eq!(&bgra[0..4], &[40, 120, 220, 255], "BGRA has blue first, like toBitmap()");
        assert_eq!(rgba_from_bgra(&bgra), decoded);
    }

    #[test]
    fn base64_is_the_standard_alphabet_and_round_trips() {
        let bytes = b"\x89PNG\r\n\x1a\n\0\xff";
        assert_eq!(decode_b64(&encode_b64(bytes)).unwrap(), bytes.to_vec());
        assert!(decode_b64("not base64!").is_err());
    }

    #[test]
    fn the_eval_reply_returns_the_value_and_rejects_a_thrown_exception() {
        let ok = json!({ "result": { "type": "number", "value": 2 } });
        assert_eq!(eval_value(&ok).unwrap(), json!(2));
        let undefined = json!({ "result": { "type": "undefined" } });
        assert_eq!(eval_value(&undefined).unwrap(), Value::Null);
        let thrown = json!({ "exceptionDetails": { "text": "Uncaught", "exception": { "description": "Error: boom" } } });
        assert_eq!(eval_value(&thrown).unwrap_err(), "executeJavaScript:Error: boom");
    }

    // ---- 12-runtime finding 1: the completion handler runs after `with_webview` returns ----
    //
    // The fake dispatcher below fires its callback on another thread 50 ms later, exactly like the queued
    // `with_webview` closure. The old implementation read a slot right after dispatch and answered `cdp_no_result`;
    // this test fails on that code and passes only when the wait is a channel with a timeout.
    #[test]
    fn a_cdp_result_that_arrives_after_dispatch_is_waited_for() {
        let value = await_cdp(
            |done| {
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(50));
                    done(Ok(json!({ "data": "late" })));
                });
                Ok(())
            },
            Duration::from_secs(2),
        )
        .expect("the asynchronous completion must be waited for");
        assert_eq!(value, json!({ "data": "late" }));
    }

    #[test]
    fn a_cdp_wait_that_never_completes_is_an_explicit_timeout() {
        // Hold the callback so the channel stays connected: this is a slow CDP call, not a dropped one.
        let err = await_cdp(
            |done| {
                std::mem::forget(done);
                Ok(())
            },
            Duration::from_millis(30),
        )
        .expect_err("a completion that never fires must time out");
        assert!(err.starts_with("cdp_timeout:"), "explicit timeout error, got {err}");
    }

    #[test]
    fn a_dispatch_failure_is_returned_before_any_wait() {
        let err = await_cdp(|_| Err("cdp_dispatch:closed".to_string()), Duration::from_millis(10))
            .expect_err("a dispatch error must propagate");
        assert_eq!(err, "cdp_dispatch:closed");
    }

    #[test]
    fn a_dropped_callback_is_cdp_no_result_not_a_hang() {
        let err = await_cdp(
            |done| {
                drop(done);
                Ok(())
            },
            Duration::from_millis(500),
        )
            .expect_err("a dropped completion must fail at once");
        assert_eq!(err, "cdp_no_result");
    }
}
