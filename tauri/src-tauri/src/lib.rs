// T-31 P1a — Zumi Tauri preview host.
//
// The renderer bundle runs unchanged inside the Tauri webview; a compatibility shim (installed by
// tauri/prep-ui.mjs before the bundle) turns every `window.zumi.*` call into a Tauri `invoke('rpc',
// { method, args })`. This file is the host half of that bridge:
//
//   renderer shim  --invoke('rpc')-->  this crate  --JSON-RPC/NDJSON over stdio-->  Node sidecar
//
// The sidecar runs the Electron-free main-process logic (settings, roles, …). This crate owns its
// lifecycle: spawn, a versioned handshake that GATES every call (nothing is served until the sidecar
// reports the expected protocol version; a sidecar that never does is killed and reported fatal),
// restart-on-crash with a bounded cap (each failure is reported to the UI as a `sidecar:error` event
// so a dead sidecar is a recoverable error, not a hung window), and kill-on-exit with no orphans.
//
// Isolation: a normal launch's sidecar data directory is `app_data_dir()` (derived from the
// "space.zumia.preview" identifier), passed on the command line; it is never Electron's userData path.
// A self-test launch gets `<runDir>/ud` instead (Electron's per-mode userData layout), so a test run can
// never write the real preview data dir.
// Note (gate 12, should-fix): the WebView2 PROFILE folder still uses Tauri's default app-data location in a
// self-test launch; only the sidecar's data dir is isolated. Electron also moves userData for the profile.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

mod asset_route;
mod board_open;
mod dialog_ops;
mod events;
mod guest;
mod guest_cdp;
mod guest_guard;
mod guest_requests;
mod host_path;
mod node_runtime;
mod open_path;
mod os_signals;
mod phone_pair;
mod rpc_allow_list;
mod shell_ops;
#[cfg(windows)]
mod single_instance;
mod updater;
pub mod vault;
mod test_model;
mod window_shell;
#[cfg(test)]
mod acl_tests;

/// Handshake protocol version. The sidecar reports it on startup; a mismatch is fatal and surfaced,
/// so a stale bundle can never talk to a newer host without anyone noticing.
const PROTOCOL_VERSION: u64 = 1;
/// Per-call timeout. A wedged-but-alive sidecar must not hang the UI forever.
const CALL_TIMEOUT: Duration = Duration::from_secs(30);
/// `talk.turn` gets its own bound: its head is resolved at the first speakable clause, but a stream that fails or times
/// out before that falls back to one non-streamed call. The two budgets are chat-brain's FIRST_TOKEN_MS = 30 s and the
/// non-streamed postChat TIMEOUT_MS = 20 s, i.e. 50 s worst case before a fallback answer, plus the board digest. 60 s
/// = 50 s + a 5 s margin, rounded up so the host never cuts a fallback that is about to answer. Every other method
/// keeps CALL_TIMEOUT. No cancel rpc: a turn ends by the module's own timeout, the provider closing, or sidecar death,
/// exactly as in Electron. scripts/check-tauri-sidecar.mjs pins this number and re-derives the bound from those budgets.
const TALK_TURN_TIMEOUT: Duration = Duration::from_secs(60);
/// `talk.tts` may wait for the Kokoro load (voice-host.mjs VOICE_LOAD_WAIT_MS = 60 s, then an explicit retryable
/// `kokoro_loading`); 70 s = that cap + a 10 s margin so the host never cuts the wait before the sidecar answers.
const TALK_TTS_TIMEOUT: Duration = Duration::from_secs(70);

/// The host-side bound for one sidecar call: talk.turn (TALK_TURN_TIMEOUT) and talk.tts (TALK_TTS_TIMEOUT) are the long ones.
fn method_timeout(method: &str) -> Duration {
    match method {
        "talk.turn" => TALK_TURN_TIMEOUT,
        "talk.tts" => TALK_TTS_TIMEOUT,
        _ => CALL_TIMEOUT,
    }
}
/// How long the host waits for the `ready` handshake before it declares the sidecar unusable. Until
/// the handshake passes, every call is refused (`sidecar_not_ready`); if the deadline passes the
/// sidecar is killed and reported fatally, so a hung handshake is a visible error, not a silent stall.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// Restart cap: a sidecar that can never start must not spin forever.
const MAX_RESTARTS: u64 = 5;
/// Largest frame the host WRITES to the sidecar (a renderer request), in bytes, excluding the newline. Must match
/// `MAX_REQUEST_FRAME_BYTES` in tauri/sidecar/protocol.mjs. A larger frame is refused here as that call's error
/// (the sidecar would answer it with a `fatal`). 4 MB carries Electron's largest argument, `gcache.save` (2.5 MB),
/// through JSON escaping; it applies after the rpc allow-list check, which `rpc` runs first.
const MAX_REQUEST_FRAME_BYTES: u64 = 4_000_000;
/// Largest frame the host READS from the sidecar, in bytes, excluding the newline. Must match
/// `MAX_RESPONSE_FRAME_BYTES` in tauri/sidecar/protocol.mjs (which turns a bigger reply into that call's error).
/// A larger frame is still a fatal protocol error.
const MAX_RESPONSE_FRAME_BYTES: u64 = 16_000_000;
/// Cap on in-flight requests (PLAN §4 "bound frame size and pending requests"): a caller that floods
/// the sidecar must not grow the waiter map without bound.
const MAX_PENDING: usize = 128;
/// A sidecar that stayed up at least this long has earned a fresh restart budget: the restart counter
/// resets, so a long-lived process that later crashes is not treated as a crash loop.
const STABLE_PERIOD: Duration = Duration::from_secs(60);

/// In-flight requests plus the connection state, under one lock. Keeping `conn`/`ready` and the waiter
/// map together makes "the sidecar just died" atomic with "a caller is about to wait": a caller either
/// sees `conn == false` and fails at once, or it is in the map and `fail_pending` will fail it.
struct Pending {
    /// A sidecar process is spawned and its stdin handle is usable. Says nothing about the protocol.
    conn: bool,
    /// First-start provisioning/spawn is still in progress (not yet spawned, not failed). While `starting && !conn`
    /// a call is `sidecar_not_ready` (the shim holds it) rather than `sidecar_not_running` (the shim fails it).
    starting: bool,
    /// The versioned handshake passed. No request is ever written before this is true.
    ready: bool,
    waiters: HashMap<u64, Sender<Result<Value, String>>>,
}

/// Shared host state. Every field is behind a primitive that makes the whole struct Send + Sync so it
/// can live in Tauri's managed state and be cloned into the reader/restart threads.
struct Inner {
    stdin: Mutex<Option<ChildStdin>>,
    child: Mutex<Option<Child>>,
    pending: Mutex<Pending>,
    shutting_down: AtomicBool,
    /// True from `setup` start until the main webview's request guard is installed: the sidecar is spawned in
    /// parallel with the WebView2 build, but `Rpc::serving()` is false while this is set, so the webview rpc, the
    /// sidecar's host requests and its push events are all refused/dropped (never queued).
    guard_pending: AtomicBool,
    /// Set when the sidecar is fundamentally unusable (protocol mismatch / handshake timeout): do not
    /// restart it.
    fatal: AtomicBool,
    /// Step 9-2: the owner flag read from the flavour file beside this exe. The sidecar may ASK for an open,
    /// but a public build's host refuses it even if the sidecar is compromised.
    owner: AtomicBool,
    version: Mutex<Option<String>>,
    restarts: AtomicU64,
    /// Monotonic sidecar generation, bumped on every spawn. A handshake watchdog records the
    /// generation it was started for and stands down once a newer one exists, so a watchdog from a
    /// previous sidecar can never mark a restarted sidecar fatal.
    generation: AtomicU64,
    /// When the current sidecar passed its handshake; None while it is not (yet) ready. Used to reset
    /// the restart counter after a stable period.
    ready_since: Mutex<Option<Instant>>,
}

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// The sidecar client. Cheap to clone (an Arc); stored as Tauri managed state and also handed to the
/// supervision threads.
#[derive(Clone)]
pub struct Rpc(Arc<Inner>);

impl Rpc {
    fn new() -> Self {
        Rpc(Arc::new(Inner {
            stdin: Mutex::new(None),
            child: Mutex::new(None),
            pending: Mutex::new(Pending { conn: false, starting: false, ready: false, waiters: HashMap::new() }),
            shutting_down: AtomicBool::new(false),
            guard_pending: AtomicBool::new(false),
            fatal: AtomicBool::new(false),
            owner: AtomicBool::new(false),
            version: Mutex::new(None),
            restarts: AtomicU64::new(0),
            generation: AtomicU64::new(0),
            ready_since: Mutex::new(None),
        }))
    }

    /// The one predicate for "a sidecar-originated or sidecar-bound effect may happen now": the sidecar passed its
    /// versioned handshake AND the main webview's request guard is installed. Used by `call` (webview -> sidecar rpc),
    /// `answer_sidecar_request` (sidecar -> host requests) and `route_event` (sidecar push events).
    fn serving_with(&self, pending: &Pending) -> bool {
        pending.ready && !self.0.guard_pending.load(Ordering::SeqCst)
    }

    fn serving(&self) -> bool {
        self.serving_with(&self.0.pending.lock().unwrap())
    }

    /// Send one JSON-RPC request and block for its response. Blocking is deliberate: the `rpc`
    /// command runs this on a blocking worker via `spawn_blocking`, never on the UI thread.
    fn call(&self, method: &str, args: Vec<Value>, timeout: Duration) -> Result<Value, String> {
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::channel::<Result<Value, String>>();
        {
            let mut pending = self.0.pending.lock().unwrap();
            if !pending.conn {
                if pending.starting {
                    return Err("sidecar_not_ready".to_string());
                }
                return Err("sidecar_not_running".to_string());
            }
            if !self.serving_with(&pending) {
                // Not serving: either the versioned handshake is not done (refuse rather than send a request a
                // not-yet-trusted protocol version might mis-handle) or the main guard is not up yet.
                return Err("sidecar_not_ready".to_string());
            }
            if pending.waiters.len() >= MAX_PENDING {
                return Err("sidecar_busy".to_string());
            }
            pending.waiters.insert(id, tx);
        }

        let request = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": args });
        if let Err(err) = self.write_line(&request) {
            self.0.pending.lock().unwrap().waiters.remove(&id);
            return Err(err);
        }

        match rx.recv_timeout(timeout) {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                self.0.pending.lock().unwrap().waiters.remove(&id);
                Err(format!("sidecar_timeout:{method}"))
            }
            // Sender dropped = the sidecar died before answering (the reader failed all pending).
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(format!("sidecar_gone:{method}")),
        }
    }

    fn write_line(&self, value: &Value) -> Result<(), String> {
        let mut line = encode_frame(value)?;
        line.push(b'\n');
        let mut guard = self.0.stdin.lock().unwrap();
        let stdin = guard.as_mut().ok_or_else(|| "sidecar_not_running".to_string())?;
        stdin
            .write_all(&line)
            .and_then(|_| stdin.flush())
            .map_err(|e| format!("sidecar_write_failed:{e}"))
    }

    /// Answer one sidecar -> host request (step 9-2). The id is echoed verbatim: sidecar ids are strings, so
    /// they can never collide with the host's numeric request ids.
    fn respond(&self, id: &Value, outcome: Result<Value, String>) {
        let frame = match outcome {
            Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            Err(message) => json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": -32000, "message": message }
            }),
        };
        let _ = self.write_line(&frame);
    }

    /// Push a notification (no id, no reply) to the sidecar. Dropped while the sidecar is not ready: the signals sent this
    /// way (os_signals.rs) are re-sent on a timer or at the next handshake, so a missed one is never queued.
    pub(crate) fn notify(&self, method: &str, params: Vec<Value>) {
        if !self.0.pending.lock().unwrap().ready {
            return;
        }
        let _ = self.write_line(&notification_frame(method, params));
    }

    /// Mark the connection down and fail every in-flight request, so no caller waits out its timeout.
    fn fail_pending(&self, message: &str) {
        let mut pending = self.0.pending.lock().unwrap();
        pending.conn = false;
        pending.ready = false;
        for (_, tx) in pending.waiters.drain() {
            let _ = tx.send(Err(message.to_string()));
        }
    }
}

/// A JSON-RPC notification: no `id`, so the sidecar never answers it.
fn notification_frame(method: &str, params: Vec<Value>) -> Value {
    json!({ "jsonrpc": "2.0", "method": method, "params": params })
}

/// Serialize one outbound frame to JSON bytes, refusing an oversized one. The host must never write a
/// frame larger than `MAX_REQUEST_FRAME_BYTES`: the sidecar answers such a frame with a `fatal` notification
/// (it has no usable id) that takes the whole connection down. Refusing here fails just this call and
/// the request is never forwarded. The bound matches the sidecar's own request cap, which it
/// measures without the trailing newline.
fn encode_frame(value: &Value) -> Result<Vec<u8>, String> {
    let line = serde_json::to_vec(value).map_err(|e| format!("sidecar_encode_failed:{e}"))?;
    if line.len() as u64 > MAX_REQUEST_FRAME_BYTES {
        return Err("sidecar_request_too_large".to_string());
    }
    Ok(line)
}

/// Stop the sidecar from the host side: fail every pending call and close its stdin. `permanent`
/// (protocol mismatch / handshake timeout) also sets the fatal flag so it is never restarted; a
/// recoverable stop (a single bad frame) leaves the flag clear, so `on_sidecar_exit` restarts it with
/// backoff instead of disabling the sidecar forever.
fn stop_sidecar(rpc: &Rpc, permanent: bool, message: &str) {
    if permanent {
        rpc.0.fatal.store(true, Ordering::SeqCst);
    }
    rpc.fail_pending(message);
    *rpc.0.stdin.lock().unwrap() = None;
}

/// Outcome of a sidecar notification that carries no id. Only `ready` is meaningful here.
enum Handshake {
    Ready { version: String },
    Mismatch { got: u64 },
    NotReady,
}

/// Parse a no-id notification: `ready` with a matching protocol is `Ready`, `ready` with any other
/// protocol is `Mismatch` (fatal), anything else is `NotReady`.
fn parse_handshake(msg: &Value) -> Handshake {
    if msg.get("method").and_then(|m| m.as_str()) != Some("ready") {
        return Handshake::NotReady;
    }
    let params = msg.get("params").cloned().unwrap_or(Value::Null);
    let protocol = params.get("protocol").and_then(|p| p.as_u64()).unwrap_or(0);
    let version = params.get("version").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if protocol == PROTOCOL_VERSION {
        Handshake::Ready { version }
    } else {
        Handshake::Mismatch { got: protocol }
    }
}

/// Why no Node runtime could be used right now. Typed (not a bare string) so the caller can tell "provisioning is
/// needed" from a spawn failure.
#[derive(Debug, PartialEq)]
enum NodeExeError {
    /// No compatible system Node and no provisioned runtime: the host must provision one (consent + download).
    NeedsRuntime,
}

impl std::fmt::Display for NodeExeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            NodeExeError::NeedsRuntime => write!(
                f,
                "node_runtime_missing: no compatible Node.js ({} or newer) was found on this PC",
                node_runtime::MIN_MAJOR
            ),
        }
    }
}

/// Resolve the sidecar's Node executable (node-bundle option (c): the installer carries no node.exe). Only a debug/dev
/// build (`allow_dev`) honours the `ZUMI_NODE` seam; a release build IGNORES it, so a shipped app never picks a runtime
/// from the environment. Otherwise `existing` (a compatible system Node, else the provisioned per-user runtime) or a
/// typed "needs provisioning".
fn resolve_node(explicit: Option<&str>, allow_dev: bool, existing: Option<PathBuf>) -> Result<PathBuf, NodeExeError> {
    if allow_dev {
        if let Some(p) = explicit {
            return Ok(PathBuf::from(p));
        }
    }
    existing.ok_or(NodeExeError::NeedsRuntime)
}

/// The Node executable for this launch: compatible system Node, else `<local app data>/runtime/node-v<ver>/node.exe`.
fn node_exe(app: &AppHandle) -> Result<PathBuf, NodeExeError> {
    let local = app.path().app_local_data_dir().ok();
    let existing = node_runtime::find_existing(local.as_deref(), &node_runtime::path_dirs(), &node_runtime::probe_version);
    let explicit = std::env::var("ZUMI_NODE").ok();
    resolve_node(explicit.as_deref(), cfg!(debug_assertions), existing)
}

/// How often the host tells the shim that first-start provisioning is still running. Well under the shim's 10 s
/// bound, so one missed beat (webview not loaded yet) never fails a held call.
const PROVISIONING_BEAT: Duration = Duration::from_secs(2);

/// While `starting` is true, emit `sidecar:provisioning` now and every `beat`; the shim re-arms its hold timer on each
/// one, so calls stay held for the whole (unbounded) provisioning phase. One last beat when it ends gives the shim a
/// fresh handshake window; after that the normal deadline applies.
fn run_provisioning_beats(sink: &impl events::EventSink, rpc: &Rpc, beat: Duration, downloaded: &dyn Fn() -> Option<u64>) {
    loop {
        let active = rpc.0.pending.lock().unwrap().starting;
        events::emit_main(sink, "sidecar:provisioning", json!({ "active": active, "downloaded": downloaded() }));
        if !active {
            return;
        }
        std::thread::sleep(beat);
    }
}

/// First start: if no Node runtime exists, provision one off the main thread (consent dialog + download can take a
/// while and must not freeze startup), then spawn. Any failure is the visible `sidecar:error` event.
fn start_sidecar_provisioning_node(app: &AppHandle, rpc: &Rpc) {
    let report = |app: &AppHandle, message: String| {
        events::emit_main(app, "sidecar:error", json!({ "message": message, "fatal": true, "restarts": 0 }));
    };
    // Always off the main thread: probing PATH entries runs `node -v` and must never block window startup.
    let (app, rpc) = (app.clone(), rpc.clone());
    // Set before the thread exists so an early renderer call is held (`sidecar_not_ready`), never failed.
    rpc.0.pending.lock().unwrap().starting = true;
    {
        let (app, rpc) = (app.clone(), rpc.clone());
        std::thread::spawn(move || {
            let local = app.path().app_local_data_dir().ok();
            let downloaded = move || local.as_deref().and_then(node_runtime::download_progress);
            run_provisioning_beats(&app, &rpc, PROVISIONING_BEAT, &downloaded)
        });
    }
    std::thread::spawn(move || {
        let provision_and_spawn = || {
            if node_exe(&app) != Err(NodeExeError::NeedsRuntime) {
                if let Err(e) = spawn_sidecar(&app, &rpc) {
                    report(&app, e);
                }
                return;
            }
            let provisioned = match app.path().app_local_data_dir() {
                Ok(dir) => node_runtime::provision_interactive(&dir).map_err(|e| e.to_string()),
                Err(e) => Err(format!("node_runtime_extract_failed: no per-user data dir: {e}")),
            };
            if let Err(e) = provisioned.and_then(|_| spawn_sidecar(&app, &rpc)) {
                report(&app, e);
            }
        };
        provision_and_spawn();
        // Spawned (conn takes over) or failed (`sidecar:error` reported): either way provisioning is over.
        rpc.0.pending.lock().unwrap().starting = false;
    });
}

/// `(<host dir>/zumi-vault.exe, <host dir>)` when the helper exists beside the running exe. Never PATH, never a guess.
fn vault_helper_beside(host_exe: &std::path::Path) -> Option<(PathBuf, PathBuf)> {
    let dir = host_exe.parent()?.to_path_buf();
    let exe = dir.join("zumi-vault.exe");
    exe.is_file().then_some((exe, dir))
}

/// `(<host dir>/flavour.json, <host dir>)` when a build wrote a flavour file beside the running exe (GATE-6pre item 2).
/// A `public` build writes none, so absence = public. Only this directory is ever looked at: not the data dir, not PATH.
/// The sidecar re-validates everything (flavour.mjs): absolute, exact name, parent == `--host-dir`, strict schema.
fn flavour_beside(host_exe: &std::path::Path) -> Option<(PathBuf, PathBuf)> {
    let dir = host_exe.parent()?.to_path_buf();
    let file = dir.join("flavour.json");
    file.is_file().then_some((file, dir))
}

/// The host's owner answer from the flavour file it found beside its exe. Absent / unreadable / not `ownerAdmin` = public.
fn host_owner(flavour: Option<&(PathBuf, PathBuf)>) -> bool {
    flavour.map(|(file, _)| open_path::read_owner_admin(file)).unwrap_or(false)
}

/// The owner flag a sidecar request is served with: the host's own value stored at spawn (step 9-2), never a claim in the
/// request and never a constant.
fn request_owner(rpc: &Rpc) -> bool {
    rpc.0.owner.load(Ordering::SeqCst)
}

/// Pick sidecar/main.mjs. `debug` (production: `cfg!(debug_assertions)`) is the only build that may honour the
/// `ZUMI_SIDECAR` dev seam; a release build always uses the packaged script and never one named by the environment.
fn choose_sidecar_script(
    explicit: Option<PathBuf>,
    packaged: Option<PathBuf>,
    dev: PathBuf,
    debug: bool,
) -> Result<PathBuf, String> {
    if debug {
        if let Some(p) = explicit {
            return Ok(p);
        }
    }
    if let Some(p) = packaged {
        return Ok(p);
    }
    if dev.exists() {
        return Ok(dev);
    }
    Err("sidecar_script_not_found".to_string())
}

/// Locate sidecar/main.mjs: an explicit override (debug only), then the packaged resource dir, then the dev tree.
fn sidecar_script(app: &AppHandle) -> Result<PathBuf, String> {
    let explicit = std::env::var("ZUMI_SIDECAR").ok().map(PathBuf::from);
    let packaged = app.path().resource_dir().ok().and_then(|dir| {
        // The staged bundle keeps the repo-relative layout (`tauri/sidecar` + `src/main`, which the sidecar imports).
        let packaged = dir.join("tauri").join("sidecar").join("main.mjs");
        packaged.exists().then_some(packaged)
    });
    // Dev fallback: <repo>/tauri/sidecar/main.mjs (this crate lives at <repo>/tauri/src-tauri).
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("sidecar").join("main.mjs");
    choose_sidecar_script(explicit, packaged, dev, cfg!(debug_assertions))
}

/// The Windows job object the sidecar tree is placed in, created once and kept open for the whole
/// process lifetime — that open handle IS the kill-on-close guarantee (the OS kills every process in
/// the job when its last handle closes, i.e. when this host exits). 0 means creation failed.
#[cfg(windows)]
static JOB: std::sync::OnceLock<isize> = std::sync::OnceLock::new();

/// Create (once) or return the kill-on-close job handle. `None` if it could not be created.
#[cfg(windows)]
fn ensure_job() -> Option<isize> {
    let handle = *JOB.get_or_init(|| winjob::create_kill_on_close().unwrap_or(0));
    if handle == 0 {
        None
    } else {
        Some(handle)
    }
}

/// Put a freshly spawned sidecar (by pid) inside the kill-on-close job so killing the host kills the
/// whole sidecar tree. Best-effort: if the job cannot be created, or the host already runs inside a
/// job that forbids nesting, we log and continue — a failed assign must not stop the preview.
fn assign_to_job(pid: u32) {
    #[cfg(windows)]
    match ensure_job() {
        Some(job) => {
            if !winjob::assign_pid(job, pid) {
                eprintln!("[sidecar] could not place pid {pid} in the kill-on-close job object");
            }
        }
        None => eprintln!("[sidecar] could not create the kill-on-close job object"),
    }
    #[cfg(not(windows))]
    let _ = pid;
}

/// Minimal Win32 job-object calls (the `windows-sys` crate is already a Windows dependency of tauri).
#[cfg(windows)]
mod winjob {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

    /// Create an anonymous job object that terminates every assigned process when its last handle
    /// closes. The handle is intentionally leaked (never closed) for the process lifetime.
    pub fn create_kill_on_close() -> Option<isize> {
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return None;
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if ok == 0 {
                CloseHandle(job);
                return None;
            }
            Some(job as isize)
        }
    }

    /// End every process still in the job, grandchildren included, without closing it (the update path: nothing may hold
    /// install-dir files open when NSIS starts copying). False when no job exists or the call failed.
    pub fn terminate_all() -> bool {
        match super::JOB.get() {
            Some(&job) if job != 0 => unsafe { TerminateJobObject(job as HANDLE, 1) != 0 },
            _ => false,
        }
    }

    pub fn active_processes() -> u32 {
        use windows_sys::Win32::System::JobObjects::{JobObjectBasicAccountingInformation, QueryInformationJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION};
        let Some(&job) = super::JOB.get() else { return 0 };
        unsafe {
            let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = std::mem::zeroed();
            let ok = QueryInformationJobObject(
                job as HANDLE,
                JobObjectBasicAccountingInformation,
                &mut info as *mut _ as *mut core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                std::ptr::null_mut(),
            );
            if ok != 0 { info.ActiveProcesses } else { 0 }
        }
    }

    /// Test-only: whether process `pid` is in `job`.
    #[cfg(test)]
    pub fn contains_pid(job: isize, pid: u32) -> bool {
        use windows_sys::Win32::System::JobObjects::IsProcessInJob;
        use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
        unsafe {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if process.is_null() {
                return false;
            }
            let mut inside = 0;
            let ok = IsProcessInJob(process, job as HANDLE, &mut inside);
            CloseHandle(process);
            ok != 0 && inside != 0
        }
    }

    /// Assign the process `pid` to the job. False on any failure (e.g. a non-breakaway parent job).
    pub fn assign_pid(job: isize, pid: u32) -> bool {
        unsafe {
            let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            if process.is_null() {
                return false;
            }
            let ok = AssignProcessToJobObject(job as HANDLE, process);
            CloseHandle(process);
            ok != 0
        }
    }
}

/// Spawn the sidecar, wire its stdio to the reader threads, and store the child for supervision.
fn spawn_sidecar(app: &AppHandle, rpc: &Rpc) -> Result<(), String> {
    spawn_sidecar_at(app, rpc, None)
}

/// The sidecar's data dir for a launch. A self-test launch uses `<runDir>/ud` -- the same per-mode userData layout
/// Electron uses (main.js:199-233) -- so a test can never write the real preview data dir. Everything else uses the
/// app data dir. Pure, so the isolation rule is unit-tested.
fn sidecar_data_dir(self_test: &guest_cdp::SelfTest, app_data_dir: &Path) -> PathBuf {
    self_test.data_dir(app_data_dir)
}

/// Spawn the sidecar with an optional data-dir override. Only the headless packaged probe passes one (so a probe never
/// writes the app's real data dir); every real launch derives it with `sidecar_data_dir` (self-test = run dir, normal =
/// app data dir).
fn spawn_sidecar_at(app: &AppHandle, rpc: &Rpc, data_dir: Option<&std::path::Path>) -> Result<(), String> {
    // Claim a new generation before anything else: a handshake watchdog still watching the previous
    // sidecar sees a newer generation and stands down, so it can never mark this restarted one fatal.
    let generation = rpc.0.generation.fetch_add(1, Ordering::SeqCst) + 1;
    // Node 24 cannot load a verbatim (`\\?\`) path: the same path goes to it in plain form (host_path.rs).
    let script = host_path::node_path(&sidecar_script(app)?);
    let self_test = app.state::<guest_cdp::SelfTest>();
    let data_dir = match data_dir {
        Some(dir) => dir.to_path_buf(),
        None => {
            let app_data_dir = app.path().app_data_dir().map_err(|e| format!("no_app_data_dir:{e}"))?;
            sidecar_data_dir(&self_test, &app_data_dir)
        }
    };
    std::fs::create_dir_all(&data_dir).map_err(|e| format!("data_dir_create_failed:{e}"))?;

    let mut cmd = Command::new(host_path::node_path(&node_exe(app).map_err(|e| e.to_string())?));
    cmd.arg(&script)
        .arg("--data-dir")
        .arg(host_path::node_path(&data_dir))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Step 7-1: the resource root, so the sidecar's Electron-parity modules (kokoro-tts.js keys on
    // process.resourcesPath) find `voice-modules/` in a bundled run. Plain Node does not define the property; the
    // sidecar sets it only from this argument, and only when the directory exists.
    if let Ok(resources) = app.path().resource_dir() {
        if resources.is_dir() {
            cmd.arg("--resources-dir").arg(host_path::node_path(&resources));
        }
    }
    // Step 7-4: the version the installer was built with, so a packaged sidecar never reports 0.0.0 (it has no
    // package.json to read). The sidecar uses this argument when present and falls back to package.json in dev.
    cmd.arg("--app-version").arg(app.package_info().version.to_string());
    // Parity step 5 (GATE-step5 condition 2): hand the sidecar the secrets-vault helper that sits next to THIS exe, and the
    // exe dir itself, so the sidecar can check "absolute, exactly zumi-vault.exe, same dir as the host". A missing helper
    // passes nothing: the sidecar then reports isEncryptionAvailable() false (honest no-encryption), never a stub success.
    // Step 6-pre (GATE-6pre item 2): the build-flavour file beside the exe goes the same way (`--flavour`); none = public.
    let host_exe = std::env::current_exe().ok();
    let vault = host_exe.as_deref().and_then(vault_helper_beside);
    let flavour = host_exe.as_deref().and_then(flavour_beside);
    // Step 9-2: the host's own owner flag (never the sidecar's claim). No file / anything doubtful = public.
    rpc.0.owner.store(host_owner(flavour.as_ref()), Ordering::SeqCst);
    if let Some((vault_exe, _)) = &vault {
        cmd.arg("--vault-exe").arg(host_path::node_path(vault_exe));
    }
    if let Some((flavour_file, _)) = &flavour {
        cmd.arg("--flavour").arg(host_path::node_path(flavour_file));
    }
    if let Some((_, host_dir)) = vault.as_ref().or(flavour.as_ref()) {
        cmd.arg("--host-dir").arg(host_path::node_path(host_dir));
    }
    // Electron's --model / ZUMI_TEST_MODEL (every build): the sidecar lists the slot; it never reads the env.
    if let Some(model) = test_model::configured() {
        cmd.arg("--test-model").arg(host_path::node_path(&model));
    }
    // A release build gives the sidecar no console at all (no flash, no conhost.exe); dev keeps it for logs.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(sidecar_creation_flags(cfg!(debug_assertions)));
    }
    // Parity 12-2: the same CLI mode the host decided on (argv only) must reach the sidecar, or its 12-1 test
    // handlers stay off while the CDP surface is on. Only the recognized self-test flags are forwarded.
    cmd.args(self_test.forwarded_args());
    let mut child = cmd.spawn().map_err(|e| format!("sidecar_spawn_failed:{e}"))?;
    let child_id = child.id();
    // Put the child (and everything it later spawns) in the kill-on-close job immediately.
    assign_to_job(child_id);

    // Take the pipes BEFORE moving the child into the mutex (moving it first would drop the handles).
    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    *rpc.0.stdin.lock().unwrap() = stdin;
    *rpc.0.child.lock().unwrap() = Some(child);
    // Spawned, but NOT ready: `conn` only means the process is up. Calls stay refused until the
    // handshake below flips `ready`.
    {
        let mut pending = rpc.0.pending.lock().unwrap();
        pending.conn = true;
        pending.ready = false;
    }

    if let Some(stdout) = stdout {
        let reader_app = app.clone();
        let reader_rpc = rpc.clone();
        std::thread::spawn(move || read_stdout(reader_app, reader_rpc, stdout));
    }
    if let Some(stderr) = stderr {
        std::thread::spawn(move || log_stderr(stderr));
    }

    // A sidecar that never completes the handshake is unusable: kill it and report fatally.
    spawn_handshake_watchdog(app, rpc, generation);

    // Close the shutdown race: if the app started quitting while we were spawning, kill now. Otherwise
    // the child stored above could outlive `shutdown_sidecar` and become an orphan.
    if rpc.0.shutting_down.load(Ordering::SeqCst) {
        *rpc.0.stdin.lock().unwrap() = None;
        {
            let mut pending = rpc.0.pending.lock().unwrap();
            pending.conn = false;
            pending.ready = false;
        }
        kill_child(rpc);
    }
    Ok(())
}

/// Win32 DETACHED_PROCESS: the child gets no console at all, so Windows starts no conhost.exe for it. CREATE_NO_WINDOW
/// would still allocate a hidden console (and its conhost.exe, 5.8 MB measured). Stdio pipes (STARTF_USESTDHANDLES) and
/// the kill-on-close job do not depend on a console; node children spawned with `windowsHide: true` get their own hidden one.
const DETACHED_PROCESS: u32 = 0x0000_0008;

/// Process-creation flags for the sidecar `node` spawn. Every release build runs it detached (no console); only a debug
/// build (console-subsystem host, logs wanted) keeps the console. Pure, so the rule is unit-tested without spawning.
fn sidecar_creation_flags(debug: bool) -> u32 {
    if debug { 0 } else { DETACHED_PROCESS }
}

/// Whether a handshake watchdog that was started for `my_generation` may declare its sidecar fatal
/// right now. It must not once a newer sidecar exists (`current_generation != my_generation`) — the
/// bug this guards is an old watchdog marking a restarted sidecar fatal — nor once the handshake
/// passed, we are shutting down, or the sidecar is already fatal.
fn watchdog_should_fatal(
    my_generation: u64,
    current_generation: u64,
    ready: bool,
    shutting_down: bool,
    fatal: bool,
) -> bool {
    current_generation == my_generation && !ready && !shutting_down && !fatal
}

/// Kill a sidecar that never completes the handshake within `HANDSHAKE_TIMEOUT`, and surface it as a
/// fatal error. Without this a hung sidecar would leave every call refused with no error ever shown.
/// The watchdog is bound to the generation of the sidecar it was spawned for, so it can never fire
/// against a sidecar that was restarted underneath it.
fn spawn_handshake_watchdog(app: &AppHandle, rpc: &Rpc, generation: u64) {
    let app = app.clone();
    let rpc = rpc.clone();
    std::thread::spawn(move || {
        let deadline = Instant::now() + HANDSHAKE_TIMEOUT;
        loop {
            let act = watchdog_should_fatal(
                generation,
                rpc.0.generation.load(Ordering::SeqCst),
                rpc.0.pending.lock().unwrap().ready,
                rpc.0.shutting_down.load(Ordering::SeqCst),
                rpc.0.fatal.load(Ordering::SeqCst),
            );
            if !act {
                return; // handshake done, standing down, stale generation, or already fatal
            }
            if Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        // Deadline reached: act only if this watchdog still watches the current sidecar generation
        // (a restart may have happened since the last tick).
        if !watchdog_should_fatal(
            generation,
            rpc.0.generation.load(Ordering::SeqCst),
            rpc.0.pending.lock().unwrap().ready,
            rpc.0.shutting_down.load(Ordering::SeqCst),
            rpc.0.fatal.load(Ordering::SeqCst),
        ) {
            return;
        }
        stop_sidecar(&rpc, true, "sidecar_fatal");
        events::emit_main(
            &app,
            "sidecar:error",
            json!({
                "message": "sidecar did not complete the handshake in time",
                "fatal": true,
                "restarts": rpc.0.restarts.load(Ordering::SeqCst),
            }),
        );
        kill_child(&rpc);
    });
}

/// One bounded read of the sidecar's stdout.
#[derive(Debug, PartialEq, Eq)]
enum Frame {
    Eof,
    /// A line, with its trailing newline if it had one.
    Line(Vec<u8>),
    /// More than `limit` bytes before a newline: the rest of the line was NOT read.
    TooLarge,
}

/// Read one NDJSON line, never buffering more than `limit` + 1 bytes (a runaway sidecar must not grow host memory).
fn read_frame<R: BufRead>(reader: &mut R, limit: u64) -> std::io::Result<Frame> {
    let mut buf: Vec<u8> = Vec::new();
    if reader.by_ref().take(limit + 1).read_until(b'\n', &mut buf)? == 0 {
        return Ok(Frame::Eof);
    }
    let content_len = if buf.last() == Some(&b'\n') { buf.len() - 1 } else { buf.len() };
    Ok(if content_len as u64 > limit { Frame::TooLarge } else { Frame::Line(buf) })
}

/// Read sidecar stdout as NDJSON, bounded to `MAX_RESPONSE_FRAME_BYTES` per frame, until EOF or a fatal
/// frame, then hand off to exit handling. The bound is enforced while reading (not after allocating a
/// whole line), so a runaway sidecar cannot grow the host's memory.
fn read_stdout(app: AppHandle, rpc: Rpc, stdout: ChildStdout) {
    let mut reader = BufReader::new(stdout);
    loop {
        match read_frame(&mut reader, MAX_RESPONSE_FRAME_BYTES) {
            Ok(Frame::Eof) => break,
            Ok(Frame::TooLarge) => {
                on_fatal(&app, &rpc, "sidecar frame too large");
                break;
            }
            Ok(Frame::Line(buf)) => {
                let line = String::from_utf8_lossy(&buf);
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                match serde_json::from_str::<Value>(line) {
                    Ok(msg) => {
                        if !handle_message(&app, &rpc, msg) {
                            break; // fatal frame: the sidecar is being stopped
                        }
                    }
                    Err(e) => eprintln!("[sidecar] unparseable line: {e}"),
                }
            }
            Err(_) => break,
        }
    }
    on_sidecar_exit(&app, &rpc);
}

/// Dispatch one message from the sidecar. Returns false when the sidecar has been declared fatal
/// (protocol mismatch or a fatal frame) and the read loop must stop.
fn handle_message(app: &AppHandle, rpc: &Rpc, msg: Value) -> bool {
    let has_id = msg.get("id").map(|v| !v.is_null()).unwrap_or(false);
    if !has_id {
        match parse_handshake(&msg) {
            Handshake::Ready { version } => {
                *rpc.0.version.lock().unwrap() = Some(version.clone());
                // Handshake passed: calls may now be served, and the stability clock starts.
                rpc.0.pending.lock().unwrap().ready = true;
                *rpc.0.ready_since.lock().unwrap() = Some(Instant::now());
                events::emit_main(app, "sidecar:ready", json!({ "version": version, "protocol": PROTOCOL_VERSION }));
                os_signals::on_sidecar_ready(app);
            }
            Handshake::Mismatch { got } => {
                // Incompatible sidecar: stop it so no request is ever answered by the wrong protocol,
                // and never restart it (on_fatal sets `fatal`).
                on_fatal(app, rpc, &format!("sidecar protocol mismatch: got {got}, want {PROTOCOL_VERSION}"));
                return false;
            }
            Handshake::NotReady => {
                // A `fatal` notification: the sidecar could not frame a request (parse error / frame
                // too large) and cannot answer it by id, so it tells the host to fail fast. One bad
                // frame is recoverable — the sidecar is restarted — unlike a handshake/version error.
                match msg.get("method").and_then(|m| m.as_str()) {
                    Some("fatal") => {
                        let detail = msg
                            .get("params")
                            .and_then(|p| p.get("message"))
                            .and_then(|m| m.as_str())
                            .unwrap_or("frame error");
                        on_frame_fatal(app, rpc, detail);
                        return false;
                    }
                    // A push event for the renderer (events.rs checks channel + size and emits to main only).
                    // Nothing is forwarded from a sidecar that is not serving (handshake not passed, or main guard not up).
                    Some("event") => {
                        route_event(rpc, msg.get("params").cloned().unwrap_or(Value::Null), |params| {
                            let _ = events::forward(app, params);
                        });
                    }
                    _ => {}
                }
            }
        }
        return true;
    }

    // Step 9-2: the sidecar can make one kind of request itself (the HUD's consent open). A message with a
    // `method` is a request, never a response to one of the host's pending calls.
    if msg.get("method").and_then(Value::as_str).is_some() {
        handle_sidecar_request(app, rpc, &msg);
        return true;
    }

    let id = match msg.get("id").and_then(|v| v.as_u64()) {
        Some(id) => id,
        None => return true,
    };
    let waiter = rpc.0.pending.lock().unwrap().waiters.remove(&id);
    if let Some(tx) = waiter {
        let outcome = if let Some(err) = msg.get("error") {
            Err(err.get("message").and_then(|m| m.as_str()).unwrap_or("sidecar_error").to_string())
        } else {
            Ok(msg.get("result").cloned().unwrap_or(Value::Null))
        };
        let _ = tx.send(outcome);
    }
    true
}

/// Serve one sidecar -> host request. Only the fixed `__sidecarHost.shell.*` names are routed
/// (`open_path::dispatch_host_request`); every path is re-validated in Rust before ShellExecuteW. The
/// answer goes back on the sidecar's stdin as a JSON-RPC response with the request's own id.
fn handle_sidecar_request(app: &AppHandle, rpc: &Rpc, msg: &Value) {
    answer_sidecar_request(rpc, msg, |method, args| {
        // Parity 12-2: the test-only capture/clipboard/resize requests exist only when this host was launched with a
        // self-test CLI flag (the same state that grants guest_cdp). A normal launch answers not_selftest and never
        // touches a webview or the clipboard.
        if guest_cdp::is_host_method(method) {
            let self_test = app.state::<guest_cdp::SelfTest>();
            return if guest_cdp::host_request_allowed(self_test.inner(), method) {
                guest_cdp::dispatch_host_request(app, self_test.inner(), method, args)
            } else {
                Err("not_selftest".to_string())
            };
        }
        let owner = request_owner(rpc);
        open_path::dispatch_host_request(
            method,
            args,
            owner,
            |p| open_path_from_sidecar(app, p, owner),
            |url| open_external_from_sidecar(app, url),
        )
    });
}

/// The gate for a sidecar -> host request: while the sidecar is not serving (handshake not passed, or the main guard not
/// up yet) `run` is never called, so nothing reaches the OS shell, a webview or the clipboard, and the sidecar gets
/// `sidecar_not_ready`. Split from `handle_sidecar_request` so the gate is unit-testable without an AppHandle.
fn answer_sidecar_request(rpc: &Rpc, msg: &Value, run: impl FnOnce(&str, &[Value]) -> Result<Value, String>) {
    let id = msg.get("id").cloned().unwrap_or(Value::Null);
    if !rpc.serving() {
        rpc.respond(&id, Err("sidecar_not_ready".to_string()));
        return;
    }
    let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
    let args = msg.get("params").and_then(Value::as_array).cloned().unwrap_or_default();
    rpc.respond(&id, run(method, &args));
}

/// The gate for a sidecar push event: forwarded to the renderer only while the sidecar is serving, otherwise dropped
/// (never queued, so it cannot be delivered after the guard comes up). Returns whether it was forwarded.
fn route_event(rpc: &Rpc, params: Value, forward: impl FnOnce(Value)) -> bool {
    if rpc.serving() {
        forward(params);
        true
    } else {
        eprintln!("events: dropped an event received before the sidecar was serving");
        false
    }
}

/// The production `openPath` opener: re-validate against this flavour's roots (`open_path::open_roots`) and OPEN_EXT in Rust, then ShellExecuteW on
/// the main thread. A queued job that misses its deadline is cancelled and never fires later.
fn open_path_from_sidecar(app: &AppHandle, p: &str, owner: bool) -> Result<(), String> {
    open_path::open_path_on_main_with_timeout(
        p,
        owner,
        app.path().app_data_dir().ok().as_deref(),
        open_path::OPEN_TIMEOUT,
        |job| app.run_on_main_thread(job).map_err(|e| format!("shell_dispatch:{e}")),
        shell_ops::shell_execute,
    )
    .map(|_| ())
}

/// The production URL opener for a HUD acceptance ref. Same re-validation and main-thread rule as every
/// other link the app opens (`shell_ops`).
fn open_external_from_sidecar(app: &AppHandle, url: &str) -> Result<(), String> {
    shell_ops::open_external_with(url, |checked| {
        shell_ops::open_on_main_with_timeout(
            checked,
            open_path::OPEN_TIMEOUT,
            |job| app.run_on_main_thread(job).map_err(|e| format!("shell_dispatch:{e}")),
            shell_ops::shell_execute,
        )
    })
}

/// Declare the sidecar permanently unusable from the host side (protocol mismatch or a handshake
/// timeout): fail every pending call at once, report fatally, and kill the child. Never restarted.
fn on_fatal(app: &AppHandle, rpc: &Rpc, message: &str) {
    stop_sidecar(rpc, true, "sidecar_fatal");
    events::emit_main(
        app,
        "sidecar:error",
        json!({
            "message": message,
            "fatal": true,
            "restarts": rpc.0.restarts.load(Ordering::SeqCst),
        }),
    );
    kill_child(rpc);
}

/// The sidecar sent a `fatal` notification that it could not tie to a request (a parse error or an
/// oversized frame). Unlike a handshake/version error this is NOT permanent: one bad frame must not
/// disable the sidecar forever, so the fatal flag stays clear and `on_sidecar_exit` restarts it with
/// backoff. The error is still surfaced (as non-fatal) so a corrupted stream is visible.
fn on_frame_fatal(app: &AppHandle, rpc: &Rpc, detail: &str) {
    stop_sidecar(rpc, false, "sidecar_frame_error");
    events::emit_main(
        app,
        "sidecar:error",
        json!({
            "message": format!("sidecar frame error: {detail}"),
            "fatal": false,
            "restarts": rpc.0.restarts.load(Ordering::SeqCst),
        }),
    );
    kill_child(rpc);
}

/// A sidecar that was up for at least `STABLE_PERIOD` has earned a fresh restart budget, so its exit
/// resets the counter; a shorter uptime keeps counting toward the cap.
fn restarts_after_stable(previous: u64, uptime: Option<Duration>) -> u64 {
    match uptime {
        Some(d) if d >= STABLE_PERIOD => 0,
        _ => previous,
    }
}

/// The `sidecar:error` payload for a sidecar that exited on its own. `reason` tells the shim that every
/// in-flight rpc call was just rejected with "sidecar_exited" and that a streamed turn the renderer is
/// waiting on is dead too (zumi-shim.js $onSidecarError ends it through the renderer's own failure path).
fn exit_payload(fatal: bool, restarts: u64) -> Value {
    json!({
        "message": if fatal { "the app sidecar stopped and will not be restarted" } else { "the app sidecar stopped; restarting" },
        "fatal": fatal,
        "restarts": restarts,
        "reason": "sidecar_exited",
    })
}

/// The sidecar exited on its own (crash or clean quit): fail callers, report to the UI, restart.
fn on_sidecar_exit(app: &AppHandle, rpc: &Rpc) {
    rpc.fail_pending("sidecar_exited");
    // Reset the counter if the sidecar had run stably; forget the handshake time either way.
    let uptime = rpc.0.ready_since.lock().unwrap().take().map(|t| t.elapsed());
    let restarts = restarts_after_stable(rpc.0.restarts.load(Ordering::SeqCst), uptime);
    rpc.0.restarts.store(restarts, Ordering::SeqCst);
    if rpc.0.shutting_down.load(Ordering::SeqCst) {
        return; // the app is quitting; do not restart
    }
    if rpc.0.fatal.load(Ordering::SeqCst) {
        return; // already declared unusable (e.g. protocol mismatch); the error was already emitted
    }
    let fatal = restarts >= MAX_RESTARTS;
    events::emit_main(app, "sidecar:error", exit_payload(fatal, restarts));
    if fatal {
        return;
    }
    let app2 = app.clone();
    let rpc2 = rpc.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(500 * (restarts + 1)));
        if rpc2.0.shutting_down.load(Ordering::SeqCst) {
            return;
        }
        rpc2.0.restarts.fetch_add(1, Ordering::SeqCst);
        if let Err(e) = spawn_sidecar(&app2, &rpc2) {
            rpc2.0.fatal.store(true, Ordering::SeqCst);
            events::emit_main(
                &app2,
                "sidecar:error",
                json!({ "message": e, "fatal": true, "restarts": rpc2.0.restarts.load(Ordering::SeqCst) }),
            );
        }
    });
}

/// Forward sidecar stderr (its logs) to the host's stderr, tagged so it is attributable.
fn log_stderr(stderr: ChildStderr) {
    for line in BufReader::new(stderr).lines().map_while(Result::ok) {
        eprintln!("[sidecar] {line}");
    }
}

/// Take and kill the sidecar child (no restart decision here).
fn kill_child(rpc: &Rpc) {
    if let Some(mut child) = rpc.0.child.lock().unwrap().take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// The main guard could not be installed: stop the early-started sidecar and keep `guard_pending` raised for good, so
/// anything it already queued (requests, events, rpc) is refused or dropped by `serving()` and never delivered later.
fn fail_guard_closed(rpc: &Rpc) {
    rpc.0.guard_pending.store(true, Ordering::SeqCst);
    shutdown_sidecar(rpc);
}

/// Close the sidecar's stdin and kill the child. Called from the app's exit event.
fn shutdown_sidecar(rpc: &Rpc) {
    rpc.0.shutting_down.store(true, Ordering::SeqCst);
    *rpc.0.stdin.lock().unwrap() = None; // closing stdin lets a cooperative sidecar exit on its own
    kill_child(rpc);
}

/// How many processes the sidecar's job still holds, for the update log. 0 when no job exists.
pub(crate) fn job_active_processes() -> u32 {
    #[cfg(windows)]
    return winjob::active_processes();
    #[cfg(not(windows))]
    0
}

/// Stop the sidecar tree before an installer runs (updater.rs, the plugin's on_before_exit). Unlike `shutdown_sidecar` it gives
/// the sidecar its `dispose()`: stdin closes, then up to `grace` for it to exit, then the kill. The job is terminated last,
/// because a surviving grandchild can hold an install-dir file open and NSIS only checks the main exe's path.
pub(crate) fn stop_sidecar_for_update(rpc: &Rpc, grace: Duration) {
    end_sidecar_within(rpc, grace);
    #[cfg(windows)]
    winjob::terminate_all();
}

/// The sidecar's own end: stdin closes, up to `grace` to exit, then the kill. Split from the job call because the job is one per
/// process: a test that terminated it would kill whatever a parallel test has running in it.
fn end_sidecar_within(rpc: &Rpc, grace: Duration) {
    rpc.0.shutting_down.store(true, Ordering::SeqCst); // no respawn from on_sidecar_exit
    *rpc.0.stdin.lock().unwrap() = None;
    let deadline = Instant::now() + grace;
    loop {
        let exited = match rpc.0.child.lock().unwrap().as_mut() {
            Some(child) => !matches!(child.try_wait(), Ok(None)),
            None => true,
        };
        if exited || Instant::now() >= deadline {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    kill_child(rpc);
}

/// Renderer -> host reply channels (generated from the inventory's `channels[]`) and the host-only sidecar method
/// each one is delivered to. `None` for any other name.
fn reply_target(channel: &str) -> Option<&'static str> {
    if !rpc_allow_list::ALLOWED_REPLY_CHANNELS.contains(&channel) {
        return None;
    }
    match channel {
        "gesture:result" => Some("__host.gestureResult"),
        _ => None,
    }
}

/// The app-page opens the host runs itself (step 6, step 8b's guide links, R4's fixed app links): rpc name -> the sidecar's host-only
/// VERDICT method. Everything else goes to the sidecar as an ordinary call.
fn app_open_target(method: &str) -> Option<&'static str> {
    match method {
        "ai.openKeyPage" => Some("__host.aiKeyPageVerdict"),
        "talk.openSource" => Some("__host.citedUrlVerdict"),
        "talk.openGuide" => Some("__host.voiceGuideVerdict"),
        "links.open" => Some("__host.linkVerdict"),
        _ => None,
    }
}

/// The main window's HWND as an integer (the dialog's owner); 0 when unavailable.
#[cfg(windows)]
fn main_window_handle(caller: &tauri::Webview) -> isize {
    caller.window().hwnd().map(|h| h.0 as isize).unwrap_or(0)
}
#[cfg(not(windows))]
fn main_window_handle(_caller: &tauri::Webview) -> isize {
    0
}

#[cfg(windows)]
fn run_file_dialog(
    kind: dialog_ops::Kind,
    gate: &dialog_ops::SingleFlight,
    owner: isize,
    call: impl FnOnce(&str, Vec<Value>) -> Result<Value, String>,
) -> Result<Value, String> {
    dialog_ops::run(kind, gate, &dialog_ops::WinDialog, owner, call)
}
#[cfg(not(windows))]
fn run_file_dialog(
    _kind: dialog_ops::Kind,
    _gate: &dialog_ops::SingleFlight,
    _owner: isize,
    _call: impl FnOnce(&str, Vec<Value>) -> Result<Value, String>,
) -> Result<Value, String> {
    Err("dialog_unsupported".to_string())
}

/// The real side effects of phone_pair.rs: the main window, its native confirm and the sidecar's host-only calls.
#[derive(Clone)]
struct PhoneHost {
    app: tauri::AppHandle,
    window: tauri::Window,
    owner: isize,
    client: Rpc,
}

impl phone_pair::Host for PhoneHost {
    fn self_test_active(&self) -> bool {
        self.app.state::<guest_cdp::SelfTest>().enabled()
    }
    fn confirm(&self) -> bool {
        phone_pair::native_confirm(self.owner)
    }
    fn protect(&self, on: bool) {
        let _ = self.window.set_content_protected(on);
    }
    fn remove_qr(&self) {
        if let Some(w) = self.app.get_webview_window(guest::MAIN_LABEL) {
            let _ = w.eval(&format!("(function(){{var e=document.getElementById('{}');if(e)e.remove();}})()", phone_pair::QR_ELEMENT_ID));
        }
    }
    fn call(&self, method: &str) -> Result<Value, String> {
        self.client.call(method, Vec::new(), CALL_TIMEOUT)
    }
}

/// The `rpc` command's method gate: only the generated renderer allow-list. Pure, so a test can pin that a
/// guest-only bridge name (`zumiHost.apply`) is refused here, before the sidecar is ever called (11-2).
/// The first-run screen's Try again (src/renderer/node-setup.js): not an inventory method, because no sidecar is running to answer one.
const NODE_SETUP_RETRY: &str = "host.retryNodeSetup";

fn renderer_method_allowed(method: &str) -> Result<(), String> {
    // The gate expression is the one scripts/check-tauri-step4.mjs pins (allow-list before the forwards).
    let method = method.to_string();
    if !rpc_allow_list::ALLOWED_METHODS.contains(&method.as_str()) {
        return Err(format!("unknown_method:{method}"));
    }
    Ok(())
}

/// The single bridge command. The shim sends the public API name as `method` and its declared
/// arguments as `args`; the sidecar either answers, or rejects with `not_implemented:<method>`.
/// Only the main webview may call it (defence in depth on top of the ACL in capabilities/default.json).
#[tauri::command]
async fn rpc(
    caller: tauri::Webview,
    state: tauri::State<'_, Rpc>,
    dialog_gate: tauri::State<'_, dialog_ops::SingleFlight>,
    method: String,
    args: Option<Vec<Value>>,
) -> Result<Value, String> {
    if !guest::is_main(&caller) {
        return Err("not_main_webview".to_string());
    }
    // The renderer's reply half of a host push (`gesture:result`): not an inventory method, so it is mapped to a
    // host-only sidecar method here and never reaches ALLOWED_METHODS.
    if let Some(target) = reply_target(&method) {
        let client = state.inner().clone();
        let args = args.unwrap_or_default();
        return tauri::async_runtime::spawn_blocking(move || client.call(target, args, CALL_TIMEOUT))
            .await
            .map_err(|e| format!("rpc_task_failed:{e}"))?;
    }
    // A fresh start asks again. Refused once Node is there: then a restart would help nothing.
    if method == NODE_SETUP_RETRY {
        let app = caller.app_handle().clone();
        return tauri::async_runtime::spawn_blocking(move || {
            if node_exe(&app) != Err(NodeExeError::NeedsRuntime) {
                return Err("node_present".to_string());
            }
            app.restart()
        })
        .await
        .map_err(|e| format!("rpc_task_failed:{e}"))?;
    }
    // Only the frozen inventory's methods may reach the sidecar (generated allow-list, checked in and
    // verified by scripts/check-tauri-allowlist.mjs). Anything else (including every removed wardrobe name) is
    // refused up front, before any sidecar call.
    renderer_method_allowed(&method)?;
    // The public build's updater answers `update.*` itself. In an owner or self-test launch it is off, so these fall through to the
    // sidecar's feed-less stubs.
    if let Some(op) = updater::Op::from_method(&method) {
        if caller.app_handle().state::<updater::State>().is_on() {
            return updater::serve(caller.app_handle().clone(), op, args.unwrap_or_default()).await;
        }
    }
    let client = state.inner().clone();
    // T-31-MOBILE M3 phone pairing (phone_pair.rs): the host runs it; the page's arguments are dropped and the bundle text
    // never reaches the page: only the QR picture does, which ENCODES the login (held by the page for 60 s).
    if let Some(op) = phone_pair::Op::from_method(&method) {
        let host = PhoneHost { app: caller.app_handle().clone(), window: caller.window(), owner: main_window_handle(&caller), client };
        let qr = caller.app_handle().state::<phone_pair::QrState>().inner().clone();
        return tauri::async_runtime::spawn_blocking(move || {
            let timer_host = host.clone();
            let timer_state = qr.clone();
            phone_pair::run(op, &qr, &host, &move |gen| {
                let (h, st) = (timer_host.clone(), timer_state.clone());
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_secs(phone_pair::QR_SECONDS));
                    phone_pair::expire(&st, &h, gen);
                });
            })
        })
        .await
        .map_err(|e| format!("rpc_task_failed:{e}"))?;
    }
    // App-page opens (step 6 + 8b): the sidecar only gives a verdict; Rust re-validates and opens. `ai.openKeyPage` takes
    // nothing from the page; `talk.openSource`, `talk.openGuide` and `links.open` take one string (a cited URL / a guide id /
    // a link id), and anything else is Electron's plain `false` (no sidecar call).
    if let Some(host_method) = app_open_target(&method) {
        let candidate = if method == "ai.openKeyPage" {
            String::new()
        } else {
            match args.as_deref().and_then(|a| a.first()).and_then(Value::as_str) {
                Some(s) => s.to_string(),
                None => return Ok(Value::Bool(false)),
            }
        };
        let app = caller.app_handle().clone();
        return tauri::async_runtime::spawn_blocking(move || Ok(Value::Bool(guest::open_for_app_page(&app, &client, host_method, &candidate))))
            .await
            .map_err(|e| format!("rpc_task_failed:{e}"))?;
    }
    // File dialogs (step 4 gate): the OS dialog runs here and the page's own arguments are dropped, so the page
    // can never name the file; the picked path goes to the sidecar's host-only importer. See dialog_ops.rs.
    if let Some(kind) = dialog_ops::Kind::from_method(&method) {
        let gate = dialog_gate.inner().clone();
        let owner = main_window_handle(&caller);
        return tauri::async_runtime::spawn_blocking(move || {
            run_file_dialog(kind, &gate, owner, |m, a| client.call(m, a, CALL_TIMEOUT))
        })
        .await
        .map_err(|e| format!("rpc_task_failed:{e}"))?;
    }
    let timeout = method_timeout(&method);
    let args = args.unwrap_or_default();
    // 12-runtime finding 4: a run finisher quits the host with Electron's code (0 ok / 1 failed; the probe always 0)
    // AFTER the sidecar has written the report and answered, so the renderer's promise settles first.
    let app = caller.app_handle().clone();
    let self_test = app.state::<guest_cdp::SelfTest>();
    let finish = guest_cdp::run_finish_code(&method, &args, self_test.enabled());
    let outcome = tauri::async_runtime::spawn_blocking(move || client.call(&method, args, timeout))
        .await
        .map_err(|e| format!("rpc_task_failed:{e}"))?;
    if let (Some(code), Ok(_)) = (finish, &outcome) {
        if let Some(watchdog) = app.try_state::<guest_cdp::RunWatchdog>() {
            watchdog.inner().finish();
        }
        guest_cdp::schedule_exit(&app, code);
    }
    outcome
}

/// The main WebView2 profile dir for a launch: a self-test run's `<runDir>/webview`, None for a normal launch (WebView2's
/// default under %LOCALAPPDATA%). Gate 12: a test run must never rewrite the real EBWebView profile. Pure, so the
/// isolation rule is unit-tested.
fn webview_data_dir(self_test: &guest_cdp::SelfTest) -> Option<PathBuf> {
    self_test.run_dir().or(self_test.user_data_dir()).map(|base| base.join("webview"))
}

/// Build the main window from its tauri.conf.json entry (`create: false`) with its P1c4 hooks, then put
/// the request guard on its webview. Called from `setup` AFTER the sidecar's start-up was kicked off (they overlap),
/// with `guard_pending` raised: the sidecar serves nothing until this returns Ok.
///
/// Why the guard is in time with no `about:blank` bootstrap: wry registers its own custom-protocol filter
/// before it navigates, and the app document is served through a WebResourceRequested event that only
/// fires once the UI loop pumps, i.e. after `setup` returns — after `install_main_guard` has run here.
/// `setup` runs on the main thread, so `with_webview` runs inline and the result is already in the channel;
/// an empty channel means that assumption broke (a Tauri update made it async) and counts as a failure.
///
/// Returns `Err(reason)` (never shown a URL) on any doubt; the caller exits the app. The window has not
/// been shown at that point (`visible: false`), and the show-once flag is spent so it can never be.
fn open_guarded_main(app: &tauri::App) -> Result<(), String> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == guest::MAIN_LABEL)
        .cloned()
        .ok_or("main_config_missing")?;
    // Show once when the app page has finished loading (Electron: show:false + ready-to-show); focus and
    // visibility events come from the same shell (window_shell.rs).
    let shell = Arc::new(window_shell::Shell::default());
    let page_shell = shell.clone();
    let mut builder = tauri::WebviewWindowBuilder::from_config(app, &config)
        .map_err(|e| format!("main_builder:{e}"))?
        // The product name, so a public build's window says Zumi: tauri.public.conf.json cannot patch one field of the windows array.
        .title(window_shell::window_title(app.config().product_name.as_deref().unwrap_or(&config.title), &app.package_info().version.to_string()))
        // Electron's will-navigate: only the app page itself. Silent, nothing logged.
        .on_navigation(guest_guard::main_nav_allowed)
        // Electron's setWindowOpenHandler: always deny, and never open the OS browser for main's own links
        // (gate G6). Without a handler WebView2 would open an unfiltered popup.
        .on_new_window(|_url, _features| tauri::webview::NewWindowResponse::Deny)
        .on_page_load(move |window, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                page_shell.on_page_finished(&window);
            }
        });
    // 12-runtime finding 6: a self-test launch keeps the main WebView2 profile inside its own run dir, so a run never
    // rewrites the real %LOCALAPPDATA%\space.zumia.preview\EBWebView. A normal launch keeps WebView2's default.
    let self_test = app.state::<guest_cdp::SelfTest>();
    if let Some(dir) = webview_data_dir(&self_test) {
        std::fs::create_dir_all(&dir).map_err(|e| format!("webview_dir:{e}"))?;
        builder = builder.data_directory(dir);
    }
    // The main webview's asset route (parity 4b): the imported avatar / room / video files the app has on disk, re-checked
    // by Rust and streamed with Range. One handler only (WebviewBuilder::on_web_resource_request replaces): the test-only
    // avatar `/external/test.vrm` is answered first, then the 4b route sees the rest.
    let route_app = app.handle().clone();
    let builder = builder.on_web_resource_request(move |request, response| {
        test_model::serve(&request, response);
        asset_route::serve(&route_app, &request, response);
    });
    let window = builder.build().map_err(|e| format!("main_build:{e}"))?;
    window_shell::attach(&window, shell.clone());

    let (tx, rx) = mpsc::channel::<Result<String, String>>();
    let guarded = window
        .with_webview(move |platform| guest_guard::install_main_guard(platform, tx))
        .map_err(|e| format!("main_guard_dispatch:{e}"))
        .and_then(|()| match rx.try_recv() {
            Ok(Ok(source_kinds)) => Ok(source_kinds),
            Ok(Err(reason)) => Err(reason),
            Err(e) => Err(format!("main_guard_not_inline:{e}")),
        })
        // `document-only` (a WebView2 runtime without ICoreWebView2_22) leaves main's workers unfiltered:
        // not a guard, so the app does not run on it (gate G3).
        .and_then(|source_kinds| {
            if source_kinds == "all" {
                eprintln!("guard: main source-kinds={source_kinds}");
                Ok(())
            } else {
                Err(format!("main_guard_{source_kinds}"))
            }
        });
    if let Err(reason) = guarded {
        shell.disarm(); // never show an unguarded main
        return Err(reason);
    }
    Ok(())
}

/// The compiled tauri context (config, capabilities, resolved ACL). One expansion of generate_context!, shared by
/// `run` and the resolved-ACL tests, so the tests judge the exact ACL the shipped app is built with.
fn app_context() -> tauri::Context {
    tauri::generate_context!()
}

/// Headless spawn probe for a built bundle (`tauri/verify/packaged-probe.mjs`).
///
/// This drives the REAL host path: the same `resource_dir()`, `node_exe()`, `sidecar_script()` and `spawn_sidecar()`
/// the app uses, but it builds the Tauri app without its setup hook, so no window is created. On Windows
/// `resource_dir()` is a verbatim (`\\?\`) path; Node refuses that form, so a regression that stops normalising paths
/// makes this probe fail with EISDIR instead of a `ready` handshake. Prints one machine-readable stdout line:
///
///   PROBE {"ok":true,"resourceDir":"...","nodeExe":"...","script":"...","dataDir":"...","info":{...}}
///
/// Exit 0 only when the sidecar completes the protocol-1 handshake and answers `info`.
pub fn probe_sidecar_spawn(data_dir_override: Option<&std::path::Path>) -> i32 {
    let app = match tauri::Builder::default()
        .manage(Rpc::new())
        // The probe is a normal (non-self-test) launch: manage the default mode so spawn_sidecar_at can read it.
        .manage(guest_cdp::SelfTest::default())
        .build(app_context())
    {
        Ok(app) => app,
        Err(e) => {
            println!("PROBE {}", json!({ "ok": false, "error": format!("app_build_failed:{e}") }));
            return 2;
        }
    };
    let handle = app.handle().clone();
    let rpc = handle.state::<Rpc>().inner().clone();
    let resource_dir = handle.path().resource_dir().ok();
    let node = node_exe(&handle).ok();
    let script = sidecar_script(&handle).ok();
    let data_dir = data_dir_override.map(|dir| dir.to_path_buf()).or_else(|| handle.path().app_data_dir().ok());

    let started = spawn_sidecar_at(&handle, &rpc, data_dir_override);
    let ready = if started.is_ok() {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if rpc.0.pending.lock().unwrap().ready {
                break true;
            }
            if rpc.0.fatal.load(Ordering::SeqCst) || Instant::now() >= deadline {
                break false;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    } else {
        false
    };
    let info = if ready { rpc.call("info", Vec::new(), CALL_TIMEOUT).ok() } else { None };
    let ok = ready && info.is_some();

    println!(
        "PROBE {}",
        json!({
            "ok": ok,
            "error": started.err(),
            "resourceDir": resource_dir.map(|p| p.to_string_lossy().into_owned()),
            "nodeExe": node.map(|p| p.to_string_lossy().into_owned()),
            "script": script.map(|p| p.to_string_lossy().into_owned()),
            "dataDir": data_dir.map(|p| p.to_string_lossy().into_owned()),
            "info": info,
        })
    );
    use std::io::Write as _;
    let _ = std::io::stdout().flush();

    // This process never runs Tauri's Exit event, so stop the sidecar here.
    shutdown_sidecar(&rpc);
    if ok { 0 } else { 1 }
}

/// Build and run the preview app. Identical entry point to the binary.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let client = Rpc::new();
    let setup_client = client.clone();
    // Parity 12-2 (GATE-ANSWER Q5): the self-test mode is read from the ARGV once, here, and then only read. Nothing in
    // the renderer, the settings or the environment can turn it on. The `guest_cdp` command itself is always in the
    // Tauri invoke table; a normal launch is protected by the ACL (no grant) plus the command body's `not_selftest`
    // check, not by an empty invoke table.
    let argv: Vec<String> = std::env::args().skip(1).collect();
    // Electron's `--user-data-dir`: a bad value ends the launch before anything is created or written.
    let user_data_dir = match guest_cdp::parse_data_dir(&argv) {
        Ok(dir) => dir,
        Err(reason) => {
            eprintln!("zumi: {reason}");
            std::process::exit(2);
        }
    };
    let self_test = guest_cdp::SelfTest::from_args(&argv).with_user_data_dir(user_data_dir);
    // Electron's avatar switch, read once here so the sidecar spawn and the /external/test.vrm route agree.
    test_model::init(&argv);

    tauri::Builder::default()
        .manage(client)
        .manage(self_test.clone())
        .manage(guest::GuestRegistry::default())
        .manage(dialog_ops::SingleFlight::default())
        .manage(phone_pair::QrState::default())
        .manage(os_signals::OsSignals::default())
        .manage(guest_cdp::RunWatchdog::default())
        .manage(updater::State::default())
        // Rust-driven only: no capability grants the plugin's commands to any webview (capabilities/default.json).
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            rpc,
            guest::guest_open,
            guest::guest_navigate,
            guest::guest_bounds,
            guest::guest_close,
            guest_cdp::guest_cdp
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            let flavour_file = std::env::current_exe().ok().as_deref().and_then(flavour_beside).is_some();
            // A stranger's build: one app per data folder. Before the sidecar, so a second launch starts nothing and asks nothing.
            #[cfg(windows)]
            if !flavour_file && !self_test.enabled() {
                let folder = self_test.data_dir_or(app.path().app_local_data_dir().ok().as_deref());
                if let Some(folder) = folder {
                    let focus = handle.clone();
                    let bring_forward = move || {
                        if let Some(window) = focus.get_webview_window("main") {
                            let _ = window.unminimize();
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    };
                    if single_instance::claim(&folder, single_instance::HANDOVER_WAIT_MS, bring_forward) == single_instance::Claim::Second {
                        std::process::exit(0);
                    }
                }
            }
            // Parity 12-2: grant the CDP command for THIS launch only. The capability file lives outside capabilities/
            // so tauri-build never enables it; a normal launch adds nothing and the command is ACL-denied at runtime.
            if let Some(capability) = guest_cdp::selftest_capability(&self_test) {
                if let Err(e) = app.add_capability(capability) {
                    eprintln!("selftest: could not add the self-test capability: {e}");
                    handle.exit(1);
                    return Ok(());
                }
            }
            // Perf: the sidecar (Node + its modules, ~1 s) starts BEFORE the WebView2 build (~250 ms, blocking this
            // thread) so the two overlap. Invariant (CoS R1 25-10): no sidecar-originated effect reaches a webview or
            // the OS shell before the main guard is up. `guard_pending` makes `Rpc::serving()` false, which refuses the
            // webview rpc, the sidecar's host requests and its push events until the guard is installed. NOT unchanged
            // from the old order: on a guard failure the sidecar has already started (its own start-up work ran) and is
            // then killed and its queued effects dropped (`fail_guard_closed`), instead of never being started.
            let early_rpc = setup_client.clone();
            early_rpc.0.guard_pending.store(true, Ordering::SeqCst);
            start_sidecar_provisioning_node(&handle, &setup_client);
            // The main window is built here (not from tauri.conf.json: `create: false`) so it can carry its
            // navigation lock and request guard. A main webview that cannot be guarded means the app does not run
            // (gate P1c4 G3).
            if let Err(reason) = open_guarded_main(app) {
                eprintln!("guard: main FAILED {reason}");
                fail_guard_closed(&early_rpc);
                handle.exit(1);
                return Ok(());
            }
            early_rpc.0.guard_pending.store(false, Ordering::SeqCst);
            guest_cdp::start_watchdog(&handle, &self_test);
            if self_test.enabled() {
                guest_requests::enable();
            }
            os_signals::start_idle_ticker(handle.clone());
            updater::start(&handle, flavour_file, self_test.enabled(), self_test.data_dir_or(app.path().app_data_dir().ok().as_deref()));
            Ok(())
        })
        .build(app_context())
        .expect("error while building the Zumi preview app")
        .run(|app, event| {
            // Only the final Exit event tears the sidecar down. ExitRequested can be cancelled (a tray
            // app that hides instead of quitting), and shutting the sidecar down there would be
            // permanent — it must not happen unless the process is really ending.
            if let tauri::RunEvent::Exit = event {
                shutdown_sidecar(app.state::<Rpc>().inner());
                updater::install_on_quit(app);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A sidecar stand-in that Rpc owns, as spawn_sidecar_at stores it. `findstr` exits at stdin EOF; `ping` ignores stdin.
    #[cfg(windows)]
    fn rpc_with_child(program: &str, args: &[&str]) -> Rpc {
        let rpc = Rpc::new();
        let mut child = Command::new(program).args(args).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().expect("spawn");
        *rpc.0.stdin.lock().unwrap() = child.stdin.take();
        *rpc.0.child.lock().unwrap() = Some(child);
        rpc
    }

    #[cfg(windows)]
    #[test]
    fn a_cooperative_sidecar_ends_on_stdin_close_before_the_grace_runs_out() {
        let rpc = rpc_with_child("findstr", &["x"]);
        let started = Instant::now();
        end_sidecar_within(&rpc, Duration::from_secs(20));
        assert!(started.elapsed() < Duration::from_secs(10), "{:?}", started.elapsed());
        assert!(rpc.0.child.lock().unwrap().is_none());
        assert!(rpc.0.stdin.lock().unwrap().is_none());
        assert!(rpc.0.shutting_down.load(Ordering::SeqCst), "no respawn");
    }

    #[cfg(windows)]
    #[test]
    fn a_stubborn_sidecar_is_killed_at_the_end_of_the_grace() {
        let rpc = rpc_with_child("ping", &["-n", "60", "127.0.0.1"]);
        let pid = rpc.0.child.lock().unwrap().as_ref().unwrap().id();
        let started = Instant::now();
        end_sidecar_within(&rpc, Duration::from_millis(300));
        let took = started.elapsed();
        assert!(took >= Duration::from_millis(300) && took < Duration::from_secs(10), "{took:?}");
        assert!(rpc.0.child.lock().unwrap().is_none());
        let listed = Command::new("tasklist").args(["/FI", &format!("PID eq {pid}"), "/NH"]).output().expect("tasklist");
        assert!(!String::from_utf8_lossy(&listed.stdout).contains(&pid.to_string()), "pid {pid} is gone");
    }

    #[test]
    fn stopping_with_no_sidecar_returns_at_once() {
        let started = Instant::now();
        end_sidecar_within(&Rpc::new(), Duration::from_secs(20));
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn gesture_result_is_routed_to_the_host_only_method_and_nothing_else_is() {
        assert_eq!(reply_target("gesture:result"), Some("__host.gestureResult"));
        for other in ["gesture:play", "playGesture", "rooms.delete", "__host.gestureResult", "gesture:result ", ""] {
            assert_eq!(reply_target(other), None, "{other}");
        }
        assert!(!rpc_allow_list::ALLOWED_METHODS.contains(&"gesture:result"));
        assert!(!rpc_allow_list::ALLOWED_METHODS.iter().any(|m| m.starts_with("__host.")));
    }

    #[test]
    fn no_wardrobe_name_reaches_the_sidecar_through_rpc() {
        // 0.3.0-alpha.11: the wardrobe is gone from the inventory, so the generated allow-list refuses every one of
        // its names before any sidecar call (unknown_method), and no guest-only bridge name is left at all.
        for m in ["wardrobe.open", "wardrobe.undo", "wardrobe.canUndo", "wardrobe.verifyFull", "zumiHost.apply"] {
            assert_eq!(renderer_method_allowed(m).unwrap_err(), format!("unknown_method:{m}"), "{m}");
        }
        assert!(!rpc_allow_list::ALLOWED_METHODS.iter().any(|m| m.contains("wardrobe") || m.starts_with("zumiHost.")));
        assert!(!rpc_allow_list::ALLOWED_EVENT_CHANNELS.iter().any(|c| c.starts_with("wardrobe:")));
        assert!(rpc_allow_list::GUEST_ONLY_METHODS.is_empty(), "no guest bridge name is left");
        assert_eq!(renderer_method_allowed("rpc").unwrap_err(), "unknown_method:rpc");
        assert!(renderer_method_allowed("info").is_ok());
    }

    #[test]
    fn voice_warm_is_main_webview_only_and_never_guest_reachable() {
        // T-31-TAURI R1: the typing pre-warm. Main renderer reaches it through the generated allow-list; a guest
        // (board) webview cannot: no capability grants a guest allow-rpc, the rpc command also refuses any non-main
        // caller, and the name is not a guest-only bridge name.
        assert!(renderer_method_allowed("talk.voiceWarm").is_ok());
        assert!(!rpc_allow_list::GUEST_ONLY_METHODS.contains(&"talk.voiceWarm"));
        let main: Value = serde_json::from_str(include_str!("../capabilities/default.json")).expect("default.json parses");
        assert_eq!(main["webviews"], json!(["main"]), "the rpc permission is scoped to the main webview label only");
        let main_ids: Vec<&str> = main["permissions"].as_array().expect("permissions").iter().filter_map(Value::as_str).collect();
        assert!(main_ids.contains(&"allow-rpc"));
        assert!(include_str!("lib.rs").contains("if !guest::is_main(&caller) {"), "the rpc command itself also refuses non-main callers");
    }

    #[test]
    fn only_the_talk_methods_get_a_long_timeout() {
        assert_eq!(method_timeout("talk.turn"), TALK_TURN_TIMEOUT);
        assert_eq!(method_timeout("talk.tts"), TALK_TTS_TIMEOUT);
        assert!(TALK_TTS_TIMEOUT >= Duration::from_secs(60 + 5), "outlives the sidecar's 60 s load-wait cap");
        for other in ["info", "zumiHost.apply", "wardrobe.verifyFull", "rooms.delete", ""] {
            assert_eq!(method_timeout(other), CALL_TIMEOUT, "{other:?} keeps the ordinary bound");
        }
    }

    #[test]
    fn the_wardrobe_bridge_command_and_capability_are_gone() {
        // 0.3.0-alpha.11: build.rs no longer declares zumi_host_apply and no capability file grants it.
        assert!(!include_str!("../build.rs").contains("\"zumi_host_apply\""), "build.rs declares no bridge command");
        assert!(!include_str!("lib.rs").contains(concat!("guest::zumi_", "host_apply")), "no bridge command is registered");
        let main: Value = serde_json::from_str(include_str!("../capabilities/default.json")).expect("default.json parses");
        assert!(!main.to_string().contains("zumi-host-apply"));
    }

    #[test]
    fn the_app_page_opens_are_intercepted_and_stay_in_the_allow_list() {
        assert_eq!(app_open_target("ai.openKeyPage"), Some("__host.aiKeyPageVerdict"));
        assert_eq!(app_open_target("talk.openSource"), Some("__host.citedUrlVerdict"));
        assert_eq!(app_open_target("talk.openGuide"), Some("__host.voiceGuideVerdict"));
        assert_eq!(app_open_target("links.open"), Some("__host.linkVerdict"));
        for other in ["board.liveOpen", "__host.aiKeyPageVerdict", "ai.openKeyPage ", "ai.setProvider", "talk.openGuide ", "links.list", "__host.linkVerdict", ""] {
            assert!(app_open_target(other).is_none(), "{other:?} must not be intercepted");
        }
        for m in ["ai.openKeyPage", "talk.openSource", "talk.openGuide", "links.open"] {
            assert!(rpc_allow_list::ALLOWED_METHODS.contains(&m), "{m} stays an inventory method");
        }
    }
    #[test]
    fn board_sign_out_is_a_renderer_rpc_method_next_to_lock_and_never_guest_only() {
        // T-31-TAURI: Settings > Board "Sign out of Board" reaches the sidecar keystore through rpc; the PIN rule is the
        // sidecar controller's (scripts/check-board-signout.mjs), the host only has to forward it.
        assert!(rpc_allow_list::ALLOWED_METHODS.contains(&"board.signOut"));
        assert!(rpc_allow_list::ALLOWED_METHODS.contains(&"board.lock"));
        assert!(!rpc_allow_list::GUEST_ONLY_METHODS.contains(&"board.signOut"));
    }
    #[test]
    fn the_sidecar_open_methods_are_host_only_and_never_in_the_renderer_allow_list() {
        for m in [open_path::HOST_OPEN_PATH, open_path::HOST_OPEN_EXTERNAL] {
            assert!(!rpc_allow_list::ALLOWED_METHODS.contains(&m), "{m} must stay host-only");
            assert!(!rpc_allow_list::ALLOWED_METHODS.iter().any(|a| a.starts_with("__sidecarHost.")));
        }
    }

    #[test]
    fn the_dialog_methods_stay_in_the_allow_list_and_are_intercepted() {
        for m in ["openModelFile", "rooms.openFile"] {
            assert!(rpc_allow_list::ALLOWED_METHODS.contains(&m));
            assert!(dialog_ops::Kind::from_method(m).is_some());
        }
    }

    #[test]
    fn a_release_sidecar_spawn_is_detached_with_no_console_at_all_and_a_debug_one_is_not() {
        assert_eq!(DETACHED_PROCESS, 0x0000_0008);
        assert_eq!(sidecar_creation_flags(false) & DETACHED_PROCESS, DETACHED_PROCESS);
        // CREATE_NO_WINDOW still allocates a hidden console (conhost.exe); DETACHED_PROCESS allocates none.
        assert_eq!(sidecar_creation_flags(false) & 0x0800_0000, 0);
        assert_eq!(sidecar_creation_flags(true), 0);
    }

    #[test]
    fn no_rpc_reaches_a_ready_sidecar_while_the_main_guard_is_pending() {
        let rpc = Rpc::new();
        {
            let mut pending = rpc.0.pending.lock().unwrap();
            pending.conn = true;
            pending.ready = true; // the early-spawned sidecar already finished its handshake
        }
        rpc.0.guard_pending.store(true, Ordering::SeqCst);
        let err = rpc.call("info", vec![], Duration::from_millis(10)).unwrap_err();
        assert_eq!(err, "sidecar_not_ready", "held, and nothing was queued for the sidecar");
        assert!(rpc.0.pending.lock().unwrap().waiters.is_empty());
        rpc.0.guard_pending.store(false, Ordering::SeqCst);
        // Guard up: the call now passes the gate and fails only on the missing stdin of this fake sidecar.
        assert_eq!(rpc.call("info", vec![], Duration::from_millis(10)).unwrap_err(), "sidecar_not_running");
    }

    /// A sidecar that already passed its handshake (the early spawn) while the main guard is still being built.
    fn ready_rpc_with_guard_pending() -> Rpc {
        let rpc = Rpc::new();
        {
            let mut pending = rpc.0.pending.lock().unwrap();
            pending.conn = true;
            pending.ready = true;
        }
        rpc.0.guard_pending.store(true, Ordering::SeqCst);
        rpc
    }

    #[test]
    fn serving_needs_the_handshake_and_the_guard() {
        let rpc = Rpc::new();
        assert!(!rpc.serving(), "not ready");
        rpc.0.pending.lock().unwrap().ready = true;
        assert!(rpc.serving());
        rpc.0.guard_pending.store(true, Ordering::SeqCst);
        assert!(!rpc.serving(), "ready but the guard is pending");
    }

    #[test]
    fn no_sidecar_request_is_run_while_the_main_guard_is_pending() {
        let rpc = ready_rpc_with_guard_pending();
        let msg = json!({ "jsonrpc": "2.0", "id": 7, "method": "__sidecarHost.shell.openExternal", "params": ["https://example.com"] });
        let ran = std::cell::Cell::new(false);
        answer_sidecar_request(&rpc, &msg, |_, _| {
            ran.set(true);
            Ok(Value::Null)
        });
        assert!(!ran.get(), "the OS shell / webview handler must not run before the guard is up");
        rpc.0.guard_pending.store(false, Ordering::SeqCst);
        answer_sidecar_request(&rpc, &msg, |method, args| {
            ran.set(true);
            assert_eq!(method, "__sidecarHost.shell.openExternal");
            assert_eq!(args.len(), 1);
            Ok(Value::Null)
        });
        assert!(ran.get(), "with the guard up the request is served");
    }

    #[test]
    fn no_sidecar_event_is_forwarded_while_the_main_guard_is_pending() {
        let rpc = ready_rpc_with_guard_pending();
        let forwarded = std::cell::Cell::new(0);
        assert!(!route_event(&rpc, json!({ "channel": "x" }), |_| forwarded.set(forwarded.get() + 1)));
        assert_eq!(forwarded.get(), 0, "dropped, not forwarded");
        rpc.0.guard_pending.store(false, Ordering::SeqCst);
        assert!(!route_event(&Rpc::new(), Value::Null, |_| forwarded.set(forwarded.get() + 1)), "no handshake: dropped");
        assert!(route_event(&rpc, json!({ "channel": "x" }), |_| forwarded.set(forwarded.get() + 1)));
        assert_eq!(forwarded.get(), 1, "an event after the guard is forwarded, and the earlier one was not queued");
    }

    #[test]
    fn a_guard_failure_stops_the_sidecar_and_nothing_it_queued_is_delivered_later() {
        let rpc = ready_rpc_with_guard_pending();
        // A request / event the sidecar had already written before the failure is still in the reader's pipe.
        fail_guard_closed(&rpc);
        assert!(rpc.0.shutting_down.load(Ordering::SeqCst), "the sidecar is being killed");
        assert!(rpc.0.guard_pending.load(Ordering::SeqCst), "the guard stays pending for good");
        assert!(rpc.0.child.lock().unwrap().is_none() && rpc.0.stdin.lock().unwrap().is_none());
        assert!(!rpc.serving());
        let ran = std::cell::Cell::new(false);
        answer_sidecar_request(&rpc, &json!({ "id": 1, "method": "m" }), |_, _| {
            ran.set(true);
            Ok(Value::Null)
        });
        assert!(!route_event(&rpc, json!({}), |_| ran.set(true)));
        assert!(!ran.get(), "a late request or event from the killed sidecar has no effect");
        assert_eq!(rpc.call("info", vec![], Duration::from_millis(10)).unwrap_err(), "sidecar_not_ready");
    }

    #[test]
    fn call_without_a_sidecar_is_rejected() {
        let rpc = Rpc::new();
        let err = rpc.call("info", vec![], Duration::from_millis(10)).unwrap_err();
        assert_eq!(err, "sidecar_not_running");
    }

    #[test]
    fn call_while_provisioning_is_held_not_failed() {
        let rpc = Rpc::new();
        rpc.0.pending.lock().unwrap().starting = true; // thread spawned, child not yet
        let err = rpc.call("ui.getLang", vec![], Duration::from_millis(10)).unwrap_err();
        assert_eq!(err, "sidecar_not_ready");
    }

    #[test]
    fn provisioning_beats_run_while_starting_and_end_with_an_inactive_beat() {
        use std::cell::RefCell;
        struct Sink(RefCell<Vec<(String, String, Value)>>);
        impl events::EventSink for Sink {
            fn emit_to_label(&self, label: &str, channel: &str, payload: &Value) {
                self.0.borrow_mut().push((label.to_string(), channel.to_string(), payload.clone()));
            }
        }
        let rpc = Rpc::new();
        rpc.0.pending.lock().unwrap().starting = true;
        let flipper = rpc.clone();
        let t = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(60));
            flipper.0.pending.lock().unwrap().starting = false;
        });
        let sink = Sink(RefCell::new(Vec::new()));
        run_provisioning_beats(&sink, &rpc, Duration::from_millis(10), &|| None);
        t.join().unwrap();
        let got = sink.0.borrow();
        assert!(got.len() >= 3, "beats repeat while starting");
        assert!(got.iter().all(|(l, c, _)| l == "main" && c == "sidecar:provisioning"));
        assert_eq!(got[0].2["active"], true);
        assert_eq!(got.last().unwrap().2["active"], false, "the last beat reports provisioning over");
    }

    #[test]
    fn call_after_provisioning_failed_is_not_running() {
        let rpc = Rpc::new();
        rpc.0.pending.lock().unwrap().starting = true;
        rpc.0.pending.lock().unwrap().starting = false; // what the provisioning thread does when it ends (failure)
        let err = rpc.call("ui.getLang", vec![], Duration::from_millis(10)).unwrap_err();
        assert_eq!(err, "sidecar_not_running");
    }

    #[test]
    fn call_before_the_handshake_is_rejected() {
        let rpc = Rpc::new();
        // A sidecar that is spawned (conn) but whose handshake has not passed (ready == false).
        {
            let mut pending = rpc.0.pending.lock().unwrap();
            pending.conn = true;
            pending.ready = false;
        }
        let err = rpc.call("ui.getLang", vec![], Duration::from_millis(10)).unwrap_err();
        assert_eq!(err, "sidecar_not_ready");
    }

    #[test]
    fn a_matching_protocol_is_ready() {
        let msg = json!({
            "jsonrpc": "2.0",
            "method": "ready",
            "params": { "protocol": PROTOCOL_VERSION, "version": "0.2.3" }
        });
        match parse_handshake(&msg) {
            Handshake::Ready { version } => assert_eq!(version, "0.2.3"),
            _ => panic!("a matching protocol must be accepted as Ready"),
        }
    }

    #[test]
    fn a_wrong_protocol_is_refused() {
        let msg = json!({
            "jsonrpc": "2.0",
            "method": "ready",
            "params": { "protocol": PROTOCOL_VERSION + 1, "version": "9.9.9" }
        });
        match parse_handshake(&msg) {
            Handshake::Mismatch { got } => assert_eq!(got, PROTOCOL_VERSION + 1),
            _ => panic!("a mismatched protocol must be refused"),
        }
    }

    #[test]
    fn a_non_ready_notification_is_ignored() {
        let msg = json!({ "jsonrpc": "2.0", "method": "log", "params": {} });
        assert!(matches!(parse_handshake(&msg), Handshake::NotReady));
    }

    #[cfg(windows)]
    #[test]
    fn a_kill_on_close_job_can_be_created() {
        // Proves CreateJobObjectW + SetInformationJobObject(KILL_ON_JOB_CLOSE) succeed on this host.
        assert!(
            winjob::create_kill_on_close().is_some(),
            "could not create the kill-on-close job object"
        );
    }

    #[cfg(windows)]
    #[test]
    fn closing_the_kill_on_close_job_kills_a_detached_child_and_the_handle_is_not_inheritable() {
        use std::os::windows::process::CommandExt;
        use std::time::{Duration, Instant};
        use windows_sys::Win32::Foundation::{
            CloseHandle, GetHandleInformation, HANDLE, HANDLE_FLAG_INHERIT,
        };
        use windows_sys::Win32::System::Threading::{
            GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        const STILL_ACTIVE: u32 = 259;

        // The real job (same constructor as ensure_job), not the process-wide one: closing it must not hit other tests.
        let job = winjob::create_kill_on_close().expect("job");
        // An inherited job handle would keep the job alive after the host closes its own copy.
        let mut flags = 0u32;
        let ok = unsafe { GetHandleInformation(job as HANDLE, &mut flags) };
        assert!(ok != 0, "GetHandleInformation failed");
        assert_eq!(flags & HANDLE_FLAG_INHERIT, 0, "job handle must not be inheritable");

        // Same spawn shape as the sidecar: release creation flags, piped stdio.
        let mut child = std::process::Command::new("ping")
            .args(["-n", "60", "127.0.0.1"])
            .creation_flags(sidecar_creation_flags(false))
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .expect("spawn ping");
        let pid = child.id();
        assert!(winjob::assign_pid(job, pid), "assign_pid failed");
        assert!(winjob::contains_pid(job, pid), "child not in job");

        unsafe { CloseHandle(job as HANDLE) };

        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        assert!(!process.is_null(), "could not open child");
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut gone = false;
        while Instant::now() < deadline {
            let mut code = 0u32;
            if unsafe { GetExitCodeProcess(process, &mut code) } != 0 && code != STILL_ACTIVE {
                gone = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        unsafe { CloseHandle(process) };
        if !gone {
            let _ = child.kill();
        }
        let _ = child.wait();
        assert!(gone, "child still alive 2 s after the kill-on-close job handle was closed");
    }

    #[test]
    fn too_many_pending_requests_are_rejected() {
        let rpc = Rpc::new();
        {
            let mut pending = rpc.0.pending.lock().unwrap();
            pending.conn = true;
            pending.ready = true;
            for i in 0..MAX_PENDING as u64 {
                pending.waiters.insert(i, mpsc::channel().0);
            }
        }
        assert_eq!(rpc.call("info", vec![], Duration::from_millis(10)).unwrap_err(), "sidecar_busy");
    }

    #[test]
    fn a_dead_sidecar_rejects_every_pending_call_with_sidecar_exited() {
        let rpc = Rpc::new();
        {
            let mut pending = rpc.0.pending.lock().unwrap();
            pending.conn = true;
            pending.ready = true;
        }
        // No stdin is attached, so write_line would refuse: register the waiters the way call() does and
        // wait on them from threads, exactly as the blocking rpc workers do.
        let mut waiting = Vec::new();
        for id in 1..=3u64 {
            let (tx, rx) = mpsc::channel::<Result<Value, String>>();
            rpc.0.pending.lock().unwrap().waiters.insert(id, tx);
            waiting.push(std::thread::spawn(move || rx.recv_timeout(Duration::from_secs(5))));
        }
        rpc.fail_pending("sidecar_exited"); // what on_sidecar_exit does first
        for w in waiting {
            assert_eq!(w.join().unwrap().unwrap(), Err("sidecar_exited".to_string()), "no pending call is left hanging");
        }
        // And a call made afterwards fails at once instead of waiting out its timeout.
        assert_eq!(rpc.call("info", vec![], Duration::from_secs(5)).unwrap_err(), "sidecar_not_running");
        assert!(rpc.0.pending.lock().unwrap().waiters.is_empty());
    }

    #[test]
    fn the_sidecar_exit_event_names_its_reason_and_whether_it_will_restart() {
        let restarting = exit_payload(false, 1);
        assert_eq!(restarting["reason"], "sidecar_exited");
        assert_eq!(restarting["fatal"], false);
        assert_eq!(restarting["restarts"], 1);
        let gone = exit_payload(true, MAX_RESTARTS);
        assert_eq!((gone["reason"].as_str(), gone["fatal"].as_bool()), (Some("sidecar_exited"), Some(true)));
    }

    #[test]
    fn a_stable_run_resets_the_restart_counter() {
        assert_eq!(restarts_after_stable(5, Some(STABLE_PERIOD)), 0, "stable period reached -> reset");
        assert_eq!(restarts_after_stable(5, Some(STABLE_PERIOD + Duration::from_secs(1))), 0, "past stable -> reset");
        assert_eq!(restarts_after_stable(5, Some(STABLE_PERIOD - Duration::from_secs(1))), 5, "short run -> keep");
        assert_eq!(restarts_after_stable(5, None), 5, "never became ready -> keep");
    }

    #[test]
    fn a_notification_has_no_id_and_is_never_sent_before_the_handshake() {
        let frame = notification_frame("__host.idle", vec![json!(7)]);
        assert_eq!(frame, json!({ "jsonrpc": "2.0", "method": "__host.idle", "params": [7] }));
        assert!(frame.get("id").is_none(), "an id would make the sidecar answer");
        // Not ready (no handshake, no stdin): dropped without a panic or a waiter.
        let rpc = Rpc::new();
        rpc.notify("__host.idle", vec![json!(1)]);
        assert!(rpc.0.pending.lock().unwrap().waiters.is_empty());
    }

    #[test]
    fn a_frame_over_the_limit_is_refused_and_a_small_one_is_not() {
        let small = json!({ "jsonrpc": "2.0", "id": 1, "method": "info", "params": [] });
        assert!(encode_frame(&small).is_ok(), "a normal request must encode");
        let huge =
            json!({ "jsonrpc": "2.0", "id": 1, "method": "info", "params": ["x".repeat(MAX_REQUEST_FRAME_BYTES as usize)] });
        assert_eq!(encode_frame(&huge).unwrap_err(), "sidecar_request_too_large");
    }

    /// A request frame whose serialized size (no newline) is exactly `len` bytes.
    fn request_of_len(len: usize) -> Value {
        let base = json!({ "jsonrpc": "2.0", "id": 1, "method": "gcache.save", "params": [""] });
        let overhead = serde_json::to_vec(&base).unwrap().len();
        json!({ "jsonrpc": "2.0", "id": 1, "method": "gcache.save", "params": ["x".repeat(len - overhead)] })
    }

    #[test]
    fn a_gcache_sized_request_encodes_and_the_cap_is_exact() {
        // Electron's gcache.save accepts 2.5 MB; that must reach the sidecar (it used to be refused at 1 MB).
        assert!(encode_frame(&request_of_len(2_500_000)).is_ok(), "2.5 MB request");
        assert!(encode_frame(&request_of_len(MAX_REQUEST_FRAME_BYTES as usize)).is_ok(), "exactly the cap");
        assert_eq!(encode_frame(&request_of_len(MAX_REQUEST_FRAME_BYTES as usize + 1)).unwrap_err(), "sidecar_request_too_large");
    }

    #[test]
    fn a_response_frame_is_read_up_to_the_response_cap_and_one_byte_more_is_too_large() {
        let line_of = |len: usize| {
            let mut v = vec![b'y'; len];
            v.push(b'\n');
            v
        };
        // A 2.4 MB gcache.load reply (over the old 1 MB cap) comes through whole.
        let mut r = std::io::Cursor::new(line_of(2_400_000));
        assert!(matches!(read_frame(&mut r, MAX_RESPONSE_FRAME_BYTES), Ok(Frame::Line(b)) if b.len() == 2_400_001));
        // Exactly the cap passes, one byte more does not.
        let cap = MAX_RESPONSE_FRAME_BYTES as usize;
        assert!(matches!(read_frame(&mut std::io::Cursor::new(line_of(cap)), MAX_RESPONSE_FRAME_BYTES), Ok(Frame::Line(_))));
        assert_eq!(read_frame(&mut std::io::Cursor::new(line_of(cap + 1)), MAX_RESPONSE_FRAME_BYTES).unwrap(), Frame::TooLarge);
        assert_eq!(read_frame(&mut std::io::Cursor::new(Vec::new()), MAX_RESPONSE_FRAME_BYTES).unwrap(), Frame::Eof);
        // An unterminated final line is still a line.
        assert!(matches!(read_frame(&mut std::io::Cursor::new(b"abc".to_vec()), 10), Ok(Frame::Line(b)) if b == b"abc"));
    }

    #[test]
    fn an_oversized_call_fails_that_call_only() {
        let rpc = Rpc::new();
        {
            let mut pending = rpc.0.pending.lock().unwrap();
            pending.conn = true;
            pending.ready = true;
        }
        // The cap's worth of argument plus the JSON envelope is over MAX_REQUEST_FRAME_BYTES. It must be rejected as this
        // call's error and never forwarded to the sidecar (which would go fatal on it).
        let huge = vec![json!("x".repeat(MAX_REQUEST_FRAME_BYTES as usize))];
        let err = rpc.call("info", huge, Duration::from_millis(10)).unwrap_err();
        assert_eq!(err, "sidecar_request_too_large");
        // The refused request must not linger in the waiter map (it would otherwise eat a MAX_PENDING slot).
        assert!(rpc.0.pending.lock().unwrap().waiters.is_empty(), "no waiter left behind");
    }

    #[test]
    fn a_frame_fatal_is_recoverable_but_a_handshake_fatal_is_permanent() {
        // One bad frame must not permanently disable the sidecar: the fatal flag stays clear so
        // on_sidecar_exit restarts it.
        let frame = Rpc::new();
        stop_sidecar(&frame, false, "sidecar_frame_error");
        assert!(!frame.0.fatal.load(Ordering::SeqCst), "a single bad frame stays restartable");

        // A protocol mismatch / handshake timeout is permanent: no restart.
        let handshake = Rpc::new();
        stop_sidecar(&handshake, true, "sidecar_fatal");
        assert!(handshake.0.fatal.load(Ordering::SeqCst), "a handshake/version error is permanent");
    }

    #[test]
    fn a_stale_handshake_watchdog_cannot_fatal_a_restarted_sidecar() {
        // Its own generation, not ready: the watchdog acts.
        assert!(watchdog_should_fatal(1, 1, false, false, false), "own generation + not ready -> act");
        // A newer sidecar replaced it (a restart): stand down.
        assert!(!watchdog_should_fatal(1, 2, false, false, false), "stale generation -> stand down");
        assert!(!watchdog_should_fatal(1, 1, true, false, false), "handshake passed -> stand down");
        assert!(!watchdog_should_fatal(1, 1, false, true, false), "shutting down -> stand down");
        assert!(!watchdog_should_fatal(1, 1, false, false, true), "already fatal -> stand down");
    }
    #[test]
    fn the_flavour_file_is_found_only_beside_the_host_exe() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target").join(format!("zumi-flavour-beside-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("data")).unwrap();
        let host = dir.join("ZumiPreview.exe");
        std::fs::write(dir.join("data").join("flavour.json"), b"{}").unwrap();
        assert!(flavour_beside(&host).is_none(), "no file beside the exe -> public, even with a file in a data-like subdir");
        std::fs::write(dir.join("flavour.json"), b"{}").unwrap();
        let (file, host_dir) = flavour_beside(&host).expect("flavour beside the host");
        assert_eq!(file, dir.join("flavour.json"));
        assert_eq!(host_dir, dir);
        std::fs::remove_file(dir.join("flavour.json")).unwrap();
        std::fs::create_dir(dir.join("flavour.json")).unwrap();
        assert!(flavour_beside(&host).is_none(), "a directory named flavour.json is not a flavour file");
        let _ = std::fs::remove_dir_all(&dir);
    }
    #[test]
    fn node_resolution_uses_an_existing_runtime_or_asks_for_provisioning() {
        let found = PathBuf::from("C:/Program Files/nodejs/node.exe");
        assert_eq!(resolve_node(None, false, Some(found.clone())).unwrap(), found, "a release build uses the system/provisioned runtime");
        assert_eq!(resolve_node(None, false, None), Err(NodeExeError::NeedsRuntime), "nothing found -> provisioning, never a PATH guess");
        let err = resolve_node(None, false, None).unwrap_err();
        assert!(err.to_string().starts_with("node_runtime_missing:"), "{err}");
        // A release build IGNORES ZUMI_NODE: no environment value may pick the runtime.
        assert_eq!(resolve_node(Some("D:/node/node.exe"), false, None), Err(NodeExeError::NeedsRuntime));
        assert_eq!(resolve_node(Some("D:/node/node.exe"), false, Some(found.clone())).unwrap(), found);
        // The debug/dev seam keeps honouring ZUMI_NODE (guard-probe / dev workflow).
        assert_eq!(resolve_node(Some("D:/node/node.exe"), true, Some(found)).unwrap(), PathBuf::from("D:/node/node.exe"));
    }

    #[test]
    fn the_owner_flag_comes_from_the_flavour_file_and_is_public_by_default() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target").join(format!("zumi-owner-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("flavour.json");
        let pair = (file.clone(), dir.clone());
        // No flavour file beside the exe = public, whatever the sidecar later asks for.
        assert!(!host_owner(None), "no flavour file is a public build");
        assert!(!host_owner(Some(&pair)), "a missing flavour file is a public build");
        std::fs::write(&file, r#"{"v":1,"ownerAdmin":true}"#).unwrap();
        assert!(host_owner(Some(&pair)), "ownerAdmin:true is the owner build");
        std::fs::write(&file, r#"{"v":1,"ownerAdmin":false}"#).unwrap();
        assert!(!host_owner(Some(&pair)), "ownerAdmin:false is a public build");
        // And the request path reads the host's stored flag, not a constant.
        let rpc = Rpc::new();
        assert!(!request_owner(&rpc), "a fresh host is public");
        rpc.0.owner.store(true, Ordering::SeqCst);
        assert!(request_owner(&rpc), "the request is served with the host's own flag");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_release_build_ignores_the_sidecar_script_override() {
        let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("sidecar").join("main.mjs");
        let packaged = PathBuf::from("C:/app/tauri/sidecar/main.mjs");
        let explicit = PathBuf::from("D:/elsewhere/main.mjs");
        assert_eq!(choose_sidecar_script(Some(explicit.clone()), Some(packaged.clone()), dev.clone(), false).unwrap(), packaged,
            "a release build uses the packaged script, never ZUMI_SIDECAR");
        assert_eq!(choose_sidecar_script(Some(explicit.clone()), None, dev.clone(), false).unwrap(), dev,
            "a release build with no packaged script falls back to the dev tree, never ZUMI_SIDECAR");
        assert_eq!(choose_sidecar_script(Some(explicit), None, dev, true).unwrap(), PathBuf::from("D:/elsewhere/main.mjs"),
            "a debug build still honours ZUMI_SIDECAR");
    }


    #[test]
    fn the_vault_helper_is_found_only_beside_the_host_exe() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target").join(format!("zumi-vault-beside-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let host = dir.join("ZumiPreview.exe");
        assert!(vault_helper_beside(&host).is_none(), "no helper file -> nothing is passed to the sidecar");
        std::fs::write(dir.join("zumi-vault.exe"), b"x").unwrap();
        let (exe, host_dir) = vault_helper_beside(&host).expect("helper beside the host");
        assert_eq!(exe, dir.join("zumi-vault.exe"));
        assert_eq!(host_dir, dir);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_self_test_launch_uses_its_own_data_dir_and_never_the_app_data_dir() {
        let app_data = Path::new("D:/appdata/Roaming/space.zumia.preview");
        // A normal launch keeps the real app data dir.
        assert_eq!(sidecar_data_dir(&guest_cdp::SelfTest::default(), app_data), app_data);
        assert_eq!(
            sidecar_data_dir(&guest_cdp::SelfTest::from_args(&[]), app_data),
            app_data,
            "no CLI mode = a normal launch"
        );
        // Every self-test mode isolates its data dir under the run dir (Electron's <userData>/ud layout).
        for (flags, run_dir) in [
            (vec!["--selftest", "D:/runs/self"], "D:/runs/self"),
            (vec!["--settings-shots", "D:/runs/settings"], "D:/runs/settings"),
            (vec!["--room-shots", "D:/runs/room"], "D:/runs/room"),
            (vec!["--board-stress", "D:/runs/board"], "D:/runs/board"),
            (vec!["--settings-probe", "D:/runs/probe"], "D:/runs/probe"),
            (vec!["--demo-script", "D:/runs/demo/lines.json", "--demo-out", "D:/runs/demo/out"], "D:/runs/demo/out"),
        ] {
            let argv: Vec<String> = flags.iter().map(|s| s.to_string()).collect();
            let mode = guest_cdp::SelfTest::from_args(&argv);
            assert!(mode.enabled(), "{flags:?} is a self-test mode");
            let dir = sidecar_data_dir(&mode, app_data);
            assert_eq!(dir, Path::new(run_dir).join("ud"), "{flags:?} must write inside its run dir");
            assert_ne!(dir, app_data, "{flags:?} must never use the real preview data dir");
        }
    }

    #[test]
    fn the_asset_route_and_the_sidecar_share_the_self_test_data_dir() {
        // 12-runtime finding 2: external/user.vrm must re-check the SAME <runDir>/ud settings the sidecar writes.
        let app_data = Path::new("D:/appdata/Roaming/space.zumia.preview");
        let mode = guest_cdp::SelfTest::from_args(&["--selftest".to_string(), "D:/runs/self".to_string()]);
        assert_eq!(mode.data_dir(app_data), Path::new("D:/runs/self").join("ud"));
        assert_eq!(mode.data_dir_or(Some(app_data)), Some(Path::new("D:/runs/self").join("ud")));
        assert_eq!(mode.data_dir_or(None), Some(Path::new("D:/runs/self").join("ud")), "a self-test run resolves without an app data dir");
        let normal = guest_cdp::SelfTest::default();
        assert_eq!(normal.data_dir_or(Some(app_data)), Some(app_data.to_path_buf()));
        assert_eq!(normal.data_dir_or(None), None);
    }

    #[test]
    fn a_self_test_launch_keeps_the_webview_profile_in_its_run_dir() {
        // 12-runtime finding 6: gate 12's "ideally <runDir>/webview"; a normal launch keeps WebView2's default.
        assert_eq!(webview_data_dir(&guest_cdp::SelfTest::default()), None, "a normal launch must not move the real profile");
        for (flags, run_dir) in [
            (vec!["--selftest", "D:/runs/self"], "D:/runs/self"),
            (vec!["--settings-shots", "D:/runs/settings"], "D:/runs/settings"),
            (vec!["--room-shots", "D:/runs/room"], "D:/runs/room"),
            (vec!["--board-stress", "D:/runs/board"], "D:/runs/board"),
            (vec!["--settings-probe", "D:/runs/probe"], "D:/runs/probe"),
            (vec!["--demo-script", "D:/runs/demo/lines.json", "--demo-out", "D:/runs/demo/out"], "D:/runs/demo/out"),
        ] {
            let argv: Vec<String> = flags.iter().map(|s| s.to_string()).collect();
            let mode = guest_cdp::SelfTest::from_args(&argv);
            assert_eq!(webview_data_dir(&mode), Some(Path::new(run_dir).join("webview")), "{flags:?}");
        }
    }

    #[test]
    fn a_finished_run_exits_with_electrons_codes() {
        let ok = serde_json::json!([{ "ok": true }]);
        let failed = serde_json::json!([{ "ok": false }]);
        let missing = serde_json::json!([{}]);
        for method in ["selftest.finish", "demo.finish", "shots.finish"] {
            assert_eq!(guest_cdp::run_finish_code(method, ok.as_array().unwrap(), true), Some(0), "{method} ok");
            assert_eq!(guest_cdp::run_finish_code(method, failed.as_array().unwrap(), true), Some(1), "{method} failed");
            assert_eq!(guest_cdp::run_finish_code(method, missing.as_array().unwrap(), true), Some(1), "{method} without ok is a failure");
            assert_eq!(guest_cdp::run_finish_code(method, ok.as_array().unwrap(), false), None, "{method} is not a normal launch's exit");
        }
        assert_eq!(guest_cdp::run_finish_code("probe.finish", failed.as_array().unwrap(), true), Some(0), "the probe always exits 0");
        assert_eq!(guest_cdp::run_finish_code("shots.log", ok.as_array().unwrap(), true), None, "only a finisher quits the host");
    }

    #[test]
    fn the_run_watchdog_matches_electrons_timeouts() {
        let mode = |flags: &[&str]| guest_cdp::SelfTest::from_args(&flags.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        assert_eq!(guest_cdp::run_timeout(&guest_cdp::SelfTest::default()), None, "a normal launch has no watchdog");
        assert_eq!(guest_cdp::run_timeout(&mode(&["--selftest", "D:/r"])), Some(Duration::from_secs(8 * 60)));
        assert_eq!(guest_cdp::run_timeout(&mode(&["--settings-shots", "D:/r"])), Some(Duration::from_secs(8 * 60)));
        assert_eq!(guest_cdp::run_timeout(&mode(&["--settings-probe", "D:/r"])), Some(Duration::from_secs(90)));
        assert_eq!(
            guest_cdp::run_timeout(&mode(&["--demo-script", "D:/r/lines.json", "--demo-out", "D:/r/out"])),
            Some(Duration::from_secs(20 * 60))
        );
    }
}
