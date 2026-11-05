// T-31 auto-update for the public Windows build (PLAN-UPDATER.md), driven from Rust only: the page reaches it through the
// `rpc` allow-list and never touches the plugin (no `updater:*` capability exists).
//
//   check (startup, every 6 h, About button) -> newer version -> download + signature check -> <local data>/update-pending/<v>.exe
//   -> one offer -> Restart now | Later. Later installs on the next normal quit. A pending file lasts one session.
//
// Owner and self-test launches never run this (`enabled`): the feed carries the public flavour. Their `update.*` calls fall
// through to the sidecar's feed-less stubs, so what they see is unchanged.
//
// The signature is checked by the plugin at download and again at install, so the file on disk needs no trust. The feed JSON
// itself is not signed: its version and notes are protected by HTTPS only, and the notes reach the page as text.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::{events, Rpc};

/// Electron's value (src/main/updater.mjs CHECK_INTERVAL_MS).
pub const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
/// A whole-download bound, so a stalled transfer cannot hold the single-flight lock for ever. The plugin's timeout covers the
/// body too, so this must outlast the full installer on a slow line.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(60 * 60);
/// How long a sidecar gets to run its own `dispose()` after stdin closes (the same bound as guest_cdp::EXIT_GRACE).
const SIDECAR_STOP_GRACE: Duration = Duration::from_secs(5);
const PENDING_DIR: &str = "update-pending";
const LOG_MAX_BYTES: u64 = 256 * 1024;
/// Notes come from the unsigned feed JSON. One release's notes are short; the bound keeps a bad feed from reaching the page.
const NOTES_MAX_CHARS: usize = 16_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Op {
    Status,
    Install,
    Later,
    Check,
}

impl Op {
    pub fn from_method(method: &str) -> Option<Op> {
        match method {
            "update.status" => Some(Op::Status),
            "update.install" => Some(Op::Install),
            "update.later" => Some(Op::Later),
            "update.check" => Some(Op::Check),
            _ => None,
        }
    }
}

/// Whether this launch may update itself. Only a release build with no flavour file beside the exe, no self-test and a real
/// public key: an empty key means the owner has not generated one yet, so nothing could ever pass the signature check.
pub fn enabled(flavour_file: bool, self_test: bool, pubkey: &str, debug_build: bool) -> bool {
    !flavour_file && !self_test && !pubkey.trim().is_empty() && !debug_build
}

/// The version comes from the unsigned feed JSON, so it is checked before it names a file. The plugin already parsed it as
/// semver, which allows only these characters: this keeps that fact from being an unwritten assumption.
pub fn pending_file(dir: &Path, version: &str) -> Option<PathBuf> {
    let plain = !version.is_empty()
        && !version.contains("..")
        && version.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+'));
    plain.then(|| dir.join(format!("{version}.exe")))
}

/// Delete everything in the pending folder (startup: a pending update lasts one session). A failed delete is only logged.
pub fn clear_pending_dir(dir: &Path) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
    let mut removed = 0;
    for entry in entries.flatten() {
        if std::fs::remove_file(entry.path()).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// The plugin extracts the installer to <temp>/<app>-<version>-updater-<random> and keeps that folder: the installer must outlive this
/// process, and nothing removes it after. Exactly that shape matches, so another app's folder in %TEMP% never does.
pub fn is_leftover_installer_dir(name: &str, app_name: &str) -> bool {
    let Some(rest) = name.strip_prefix(app_name).and_then(|r| r.strip_prefix('-')) else { return false };
    let Some((version, random)) = rest.rsplit_once("-updater-") else { return false };
    !version.is_empty()
        && version.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+'))
        && !random.is_empty()
        && random.chars().all(|c| c.is_ascii_alphanumeric())
}

/// Startup: remove what earlier updates left. A folder still in use (the installer that just relaunched us) stays until the next start.
pub fn clear_leftover_installers(temp: &Path, app_name: &str) -> usize {
    let Ok(entries) = std::fs::read_dir(temp) else { return 0 };
    let mut removed = 0;
    for entry in entries.flatten() {
        let matches = entry.file_name().to_str().is_some_and(|n| is_leftover_installer_dir(n, app_name));
        if matches && entry.file_type().is_ok_and(|t| t.is_dir()) && std::fs::remove_dir_all(entry.path()).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// How many files listed in install-manifest.json are missing or differ from what this install should hold. None when the text is not
/// a manifest. A file outside the list (a stale one from an older version) is harmless and not counted.
pub fn install_mismatches(dir: &Path, manifest: &str) -> Option<usize> {
    use sha2::{Digest, Sha256};
    let doc: Value = serde_json::from_str(manifest).ok()?;
    let files = doc.get("files")?.as_object()?;
    let mut mismatches = 0;
    for (rel, pin) in files {
        let want = pin.get("sha256").and_then(Value::as_str)?;
        let bytes = pin.get("bytes").and_then(Value::as_u64)?;
        let path = dir.join(rel);
        let same = std::fs::metadata(&path).is_ok_and(|m| m.len() == bytes)
            && std::fs::File::open(&path).ok().and_then(|mut f| {
                let mut hash = Sha256::new();
                std::io::copy(&mut f, &mut hash).ok()?;
                Some(hash.finalize().iter().map(|b| format!("{b:02x}")).collect::<String>() == want)
            }) == Some(true);
        if !same {
            mismatches += 1;
        }
    }
    Some(mismatches)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Idle,
    Downloading,
    Error,
    Ready,
}

impl Phase {
    fn name(self) -> &'static str {
        match self {
            Phase::Idle => "idle",
            Phase::Downloading => "downloading",
            Phase::Error => "error",
            Phase::Ready => "ready",
        }
    }
}

/// A verified download waiting on disk. `update` is the plugin's handle (a unit in tests).
#[derive(Clone)]
pub struct Pending<U> {
    pub version: String,
    pub notes: String,
    pub file: PathBuf,
    pub update: U,
}

/// What a feed answer with an update means for this session.
#[derive(Debug, PartialEq, Eq)]
pub enum Found {
    /// That version is already on disk: nothing to fetch, and an earlier Later stays in force.
    AlreadyPending,
    Download,
}

/// The state machine, with no plugin, window or file in it, so every rule below is unit-tested.
pub struct Core<U> {
    phase: Phase,
    version: Option<String>,
    percent: u8,
    ready: Option<(String, String)>,
    put_off: Vec<String>,
    pending: Option<Pending<U>>,
    /// A check or a download is running. One at a time, and a stuck one is bounded by the timeouts above.
    busy: bool,
    installing: bool,
    /// The files on disk differ from this install's list: the page tells the user to run the installer again.
    repair: bool,
}

impl<U> Default for Core<U> {
    fn default() -> Self {
        Core { phase: Phase::Idle, version: None, percent: 0, ready: None, put_off: Vec::new(), pending: None, busy: false, installing: false, repair: false }
    }
}

impl<U: Clone> Core<U> {
    pub fn snapshot(&self) -> Value {
        json!({
            "phase": self.phase.name(),
            "version": self.version,
            "percent": self.percent,
            "ready": self.ready.as_ref().map(|(version, notes)| json!({ "version": version, "notes": notes })),
            "repair": self.repair,
        })
    }

    pub fn set_repair(&mut self, repair: bool) {
        self.repair = repair;
    }

    /// Single-flight: false while a check or a download runs, or an install has started.
    pub fn begin_check(&mut self) -> bool {
        if self.busy || self.installing {
            return false;
        }
        self.busy = true;
        true
    }

    pub fn end_check(&mut self) {
        self.busy = false;
    }

    /// The feed answered "nothing newer". This is the ONLY answer that withdraws a pending update: an error says nothing
    /// about the release. Returns the file to delete.
    pub fn on_no_update(&mut self) -> Option<PathBuf> {
        self.busy = false;
        let withdrawn = self.pending.take()?;
        self.phase = Phase::Idle;
        self.version = None;
        self.percent = 0;
        self.ready = None;
        Some(withdrawn.file)
    }

    /// The feed offers `version`. `busy` stays set when a download follows; it ends in on_downloaded / on_download_failed.
    pub fn on_found(&mut self, version: &str) -> Found {
        if self.pending.as_ref().is_some_and(|p| p.version == version) {
            self.busy = false;
            return Found::AlreadyPending;
        }
        self.phase = Phase::Downloading;
        self.version = Some(version.to_string());
        self.percent = 0;
        Found::Download
    }

    /// True when the percentage moved: progress is pushed to the page only then.
    pub fn on_progress(&mut self, received: u64, total: Option<u64>) -> bool {
        let Some(total) = total.filter(|t| *t > 0) else { return false };
        let percent = (received.saturating_mul(100) / total).min(100) as u8;
        if self.phase != Phase::Downloading || percent == self.percent {
            return false;
        }
        self.percent = percent;
        true
    }

    /// The bytes passed the signature check and are on disk. Returns a replaced older file to delete.
    pub fn on_downloaded(&mut self, pending: Pending<U>) -> Option<PathBuf> {
        self.busy = false;
        self.phase = Phase::Ready;
        self.version = Some(pending.version.clone());
        self.percent = 100;
        self.ready = if self.put_off.contains(&pending.version) { None } else { Some((pending.version.clone(), pending.notes.clone())) };
        let replaced = self.pending.replace(pending).map(|old| old.file);
        replaced.filter(|old| self.pending.as_ref().is_some_and(|p| &p.file != old))
    }

    /// A failed download or signature check. Returns the one `error` state for the page; the state itself goes back to what
    /// is really on disk (the earlier pending update, or nothing), and the next check retries.
    pub fn on_download_failed(&mut self) -> Value {
        self.busy = false;
        self.phase = Phase::Error;
        let shown = self.snapshot();
        match &self.pending {
            Some(p) => {
                self.phase = Phase::Ready;
                self.version = Some(p.version.clone());
                self.percent = 100;
            }
            None => {
                self.phase = Phase::Idle;
                self.version = None;
                self.percent = 0;
            }
        }
        shown
    }

    /// Later: not offered again this session (a higher version still is). It still installs on quit.
    pub fn later(&mut self, version: &str) -> bool {
        if self.ready.as_ref().map(|(v, _)| v.as_str()) != Some(version) {
            return false;
        }
        self.put_off.push(version.to_string());
        self.ready = None;
        true
    }

    /// The pending update, claimed for one install attempt. None when there is none or one already started: a second
    /// click returns false.
    pub fn begin_install(&mut self) -> Option<Pending<U>> {
        if self.installing {
            return None;
        }
        let pending = self.pending.clone()?;
        self.installing = true;
        Some(pending)
    }

    pub fn end_install(&mut self) {
        self.installing = false;
    }
}

/// What one install attempt came to. `install` only returns on failure in production: on success the plugin ends the process.
#[derive(Debug, PartialEq, Eq)]
pub enum Applied<E> {
    Launched,
    /// Failed before the sidecar was touched (read, signature, extract): the app keeps working.
    Failed(E),
    /// Failed after the sidecar stopped (ShellExecuteW): the host must come back through a restart.
    Recovered(E),
}

/// `stopped` is set by the plugin's on_before_exit hook. The hook runs after the signature check and extraction, right
/// before ShellExecuteW, so a failure with `stopped` clear never disturbed the running app.
pub fn apply<E>(stopped: &AtomicBool, install: impl FnOnce() -> Result<(), E>, recover: impl FnOnce()) -> Applied<E> {
    match install() {
        Ok(()) => Applied::Launched,
        Err(e) if stopped.load(Ordering::SeqCst) => {
            recover();
            Applied::Recovered(e)
        }
        Err(e) => Applied::Failed(e),
    }
}

/// The kind of a plugin error: this is all that reaches the log (a message can carry the feed URL's details).
pub fn error_kind(e: &tauri_plugin_updater::Error) -> &'static str {
    use tauri_plugin_updater::Error as E;
    match e {
        E::Minisign(_) | E::Base64(_) | E::SignatureUtf8(_) => "signature",
        E::SignedVersionMismatch { .. } | E::MissingSignedVersion => "signed_version",
        E::ReleaseNotFound => "feed_not_found",
        E::Reqwest(_) | E::Network(_) => "network",
        E::Serialization(_) | E::Semver(_) | E::TargetNotFound(_) | E::TargetsNotFound(_) => "feed_invalid",
        E::InvalidUpdaterFormat => "not_an_installer",
        E::Io(_) => "io",
        _ => "other",
    }
}

/// Append one capped line to <app data>/logs/updater.log (one `.1` copy, Electron's rotation). Never fails the caller.
fn append_log(file: &Path, line: &str) {
    use std::io::Write as _;
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let size = std::fs::metadata(file).map(|m| m.len()).unwrap_or(0);
    if size > 0 && size + line.len() as u64 + 1 > LOG_MAX_BYTES {
        let _ = std::fs::rename(file, file.with_extension("log.1"));
    }
    let millis = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    if let Ok(mut out) = std::fs::OpenOptions::new().create(true).append(true).open(file) {
        let _ = writeln!(out, "{millis} {}", line.replace(['\r', '\n'], " "));
    }
}

/// Tauri managed state. `on` stays false unless `start` decided this launch updates itself.
#[derive(Default)]
pub struct State {
    on: AtomicBool,
    stopped: AtomicBool,
    core: Mutex<Core<Update>>,
    pending_dir: Mutex<Option<PathBuf>>,
    log_file: Mutex<Option<PathBuf>>,
}

impl State {
    pub fn is_on(&self) -> bool {
        self.on.load(Ordering::SeqCst)
    }

    fn log(&self, line: &str) {
        if let Some(file) = self.log_file.lock().unwrap().as_deref() {
            append_log(file, line);
        }
    }
}

fn push(app: &AppHandle, state: Value) {
    events::emit_main(app, "update:state", state);
}

fn pubkey_from_config(app: &AppHandle) -> String {
    app.config().plugins.0.get("updater").and_then(|u| u.get("pubkey")).and_then(Value::as_str).unwrap_or("").to_string()
}

/// `setup` calls this once the main guard is up. Decides for this launch, clears the last session's pending file and starts
/// the check loop on its own thread. `data_dir` is the launch's data dir (`--data-dir` when given, else the app data dir): the
/// log goes there, so a `--data-dir` launch writes nothing under %APPDATA% (alpha.14 F1).
pub fn start(app: &AppHandle, flavour_file: bool, self_test: bool, data_dir: Option<PathBuf>) {
    if !enabled(flavour_file, self_test, &pubkey_from_config(app), cfg!(debug_assertions)) {
        return;
    }
    let state = app.state::<State>();
    *state.log_file.lock().unwrap() = data_dir.map(|d| d.join("logs").join("updater.log"));
    let Ok(local) = app.path().app_local_data_dir() else {
        state.log("off: no local data dir");
        return;
    };
    let dir = local.join(PENDING_DIR);
    let cleared = clear_pending_dir(&dir);
    *state.pending_dir.lock().unwrap() = Some(dir);
    state.on.store(true, Ordering::SeqCst);
    let leftovers = clear_leftover_installers(&std::env::temp_dir(), &app.package_info().name);
    state.log(&format!("on: current {}, cleared {cleared} old pending file(s), {leftovers} leftover installer folder(s)", app.package_info().version));
    #[cfg(feature = "update-e2e")]
    e2e::start(app);
    let app = app.clone();
    {
        let app = app.clone();
        std::thread::spawn(move || check_install(&app));
    }
    std::thread::spawn(move || loop {
        let result = tauri::async_runtime::block_on(check_once(&app));
        app.state::<State>().log(&format!("automatic check: {}", result.name()));
        #[cfg(feature = "update-e2e")]
        e2e::after_check(&app);
        std::thread::sleep(check_interval());
    });
}

/// The mixed-install notice. Off the main thread: it reads every installed file once per launch.
fn check_install(app: &AppHandle) {
    let state = app.state::<State>();
    let Some(dir) = std::env::current_exe().ok().and_then(|exe| exe.parent().map(Path::to_path_buf)) else { return };
    let Ok(manifest) = std::fs::read_to_string(dir.join("install-manifest.json")) else {
        state.log("install check: no list");
        return;
    };
    match install_mismatches(&dir, &manifest) {
        Some(0) => state.log("install check: ok"),
        Some(n) => {
            state.log(&format!("install check: {n} file(s) differ"));
            let snapshot = {
                let mut core = state.core.lock().unwrap();
                core.set_repair(true);
                core.snapshot()
            };
            push(app, snapshot);
        }
        None => state.log("install check: unreadable list"),
    }
}

fn check_interval() -> Duration {
    #[cfg(feature = "update-e2e")]
    if let Some(ms) = std::env::var("ZUMI_UPDATE_INTERVAL_MS").ok().and_then(|v| v.parse::<u64>().ok()) {
        return Duration::from_millis(ms);
    }
    CHECK_INTERVAL
}

/// What the About button shows. An automatic check logs this and shows nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckResult {
    Busy,
    None,
    Available,
    Error,
}

impl CheckResult {
    pub fn name(self) -> &'static str {
        match self {
            CheckResult::Busy => "busy",
            CheckResult::None => "none",
            CheckResult::Available => "available",
            CheckResult::Error => "error",
        }
    }
}

/// The plugin's updater with this app's hook in place of its default: stop the sidecar tree, then Tauri's own cleanup.
fn updater_for(app: &AppHandle) -> Result<tauri_plugin_updater::Updater, tauri_plugin_updater::Error> {
    let hook_app = app.clone();
    app.updater_builder()
        .timeout(CHECK_TIMEOUT)
        .on_before_exit(move || {
            crate::stop_sidecar_for_update(hook_app.state::<Rpc>().inner(), SIDECAR_STOP_GRACE);
            let state = hook_app.state::<State>();
            state.stopped.store(true, Ordering::SeqCst);
            state.log(&format!("sidecar stopped, {} job process(es) left; running the installer", crate::job_active_processes()));
            hook_app.cleanup_before_exit();
        })
        .build()
}

async fn check_once(app: &AppHandle) -> CheckResult {
    let state = app.state::<State>();
    if !state.core.lock().unwrap().begin_check() {
        return CheckResult::Busy;
    }
    let answer = match updater_for(app) {
        Ok(updater) => updater.check().await,
        Err(e) => Err(e),
    };
    match answer {
        Ok(None) => {
            if let Some(file) = state.core.lock().unwrap().on_no_update() {
                let _ = std::fs::remove_file(&file);
                state.log("feed is below the pending version: withdrawn, file deleted, not installed on quit");
                push(app, state.core.lock().unwrap().snapshot());
            }
            CheckResult::None
        }
        Ok(Some(update)) => {
            let version = update.version.clone();
            if state.core.lock().unwrap().on_found(&version) == Found::AlreadyPending {
                return CheckResult::Available;
            }
            state.log(&format!("available {version}; downloading"));
            push(app, state.core.lock().unwrap().snapshot());
            let app = app.clone();
            tauri::async_runtime::spawn(async move { download_pending(&app, update).await });
            CheckResult::Available
        }
        Err(e) => {
            state.core.lock().unwrap().end_check();
            state.log(&format!("check failed: {}", error_kind(&e)));
            CheckResult::Error
        }
    }
}

async fn download_pending(app: &AppHandle, mut update: Update) {
    let state = app.state::<State>();
    update.timeout = Some(DOWNLOAD_TIMEOUT);
    let mut received: u64 = 0;
    let progress_app = app.clone();
    let bytes = update
        .download(
            move |chunk, total| {
                received += chunk as u64;
                let state = progress_app.state::<State>();
                let moved = {
                    let mut core = state.core.lock().unwrap();
                    core.on_progress(received, total).then(|| core.snapshot())
                };
                if let Some(snapshot) = moved {
                    push(&progress_app, snapshot);
                }
            },
            || {},
        )
        .await;
    let stored = match bytes {
        Ok(bytes) => store_pending(&state, &update.version, &bytes),
        Err(e) => {
            state.log(&format!("download rejected: {} (version {})", error_kind(&e), update.version));
            Err(())
        }
    };
    match stored {
        Ok(file) => {
            let notes: String = update.body.clone().unwrap_or_default().chars().take(NOTES_MAX_CHARS).collect();
            let version = update.version.clone();
            let pending = Pending { version: version.clone(), notes, file, update };
            let (replaced, snapshot) = {
                let mut core = state.core.lock().unwrap();
                let replaced = core.on_downloaded(pending);
                (replaced, core.snapshot())
            };
            if let Some(old) = replaced {
                let _ = std::fs::remove_file(old);
            }
            state.log(&format!("downloaded {version}; signature ok; installs on quit"));
            push(app, snapshot);
            #[cfg(feature = "update-e2e")]
            e2e::on_ready(app, &version);
        }
        Err(()) => {
            let shown = state.core.lock().unwrap().on_download_failed();
            push(app, shown);
        }
    }
}

/// The verified bytes go to disk and leave memory (dropped by the caller): the installer can be hundreds of MB.
fn store_pending(state: &State, version: &str, bytes: &[u8]) -> Result<PathBuf, ()> {
    let dir = state.pending_dir.lock().unwrap().clone().ok_or(())?;
    let file = pending_file(&dir, version).ok_or_else(|| state.log("refused a version that cannot name a file"))?;
    std::fs::create_dir_all(&dir)
        .and_then(|()| std::fs::write(&file, bytes))
        .map_err(|e| state.log(&format!("could not store the download: {:?}", e.kind())))?;
    Ok(file)
}

/// Restart now. True is never seen in practice: a successful install ends this process.
pub fn install_now(app: &AppHandle) -> bool {
    let state = app.state::<State>();
    let Some(pending) = state.core.lock().unwrap().begin_install() else { return false };
    state.log(&format!("restart to install {}", pending.version));
    let Ok(bytes) = std::fs::read(&pending.file) else {
        state.log("the pending file could not be read");
        state.core.lock().unwrap().end_install();
        return false;
    };
    let applied = apply(
        &state.stopped,
        || pending.update.clone().restart_after_install(true).install(&bytes),
        || {
            state.log("the installer did not start after the sidecar stopped; restarting the old version");
            app.restart()
        },
    );
    match applied {
        Applied::Launched => true,
        Applied::Failed(e) => {
            state.log(&format!("install failed before the sidecar stopped: {}", error_kind(&e)));
            state.core.lock().unwrap().end_install();
            false
        }
        // Not reached in production: the recovery above restarts the process.
        Applied::Recovered(_) => false,
    }
}

/// The normal-quit half of Later (RunEvent::Exit, after shutdown_sidecar). The installer runs, the app does not reopen. No
/// network call here. If the process is forced to end first (window_shell::CLOSED_EXIT_GRACE) nothing installs and the next
/// run offers again.
pub fn install_on_quit(app: &AppHandle) {
    let state = app.state::<State>();
    if !state.is_on() {
        return;
    }
    let Some(pending) = state.core.lock().unwrap().begin_install() else { return };
    state.log(&format!("quit: installing {}", pending.version));
    let result = std::fs::read(&pending.file)
        .map_err(|_| "read".to_string())
        .and_then(|bytes| pending.update.clone().restart_after_install(false).install(&bytes).map_err(|e| error_kind(&e).to_string()));
    if let Err(kind) = result {
        state.log(&format!("quit install failed: {kind}; the old version stays"));
    }
}

/// One intercepted `update.*` call. The page's arguments are read only for Later's version string.
pub async fn serve(app: AppHandle, op: Op, args: Vec<Value>) -> Result<Value, String> {
    let state = app.state::<State>();
    match op {
        Op::Status => Ok(state.core.lock().unwrap().snapshot()),
        Op::Later => {
            let Some(version) = args.first().and_then(Value::as_str) else { return Ok(Value::Bool(false)) };
            let done = state.core.lock().unwrap().later(version);
            if done {
                state.log(&format!("later {version}; installs on quit"));
            }
            Ok(Value::Bool(done))
        }
        Op::Check => {
            let result = check_once(&app).await;
            state.log(&format!("about-button check: {}", result.name()));
            Ok(json!({ "result": result.name() }))
        }
        Op::Install => {
            let installed = tauri::async_runtime::spawn_blocking(move || install_now(&app)).await.map_err(|e| format!("rpc_task_failed:{e}"))?;
            Ok(Value::Bool(installed))
        }
    }
}

/// The box E2E's stand-in for the two clicks (scripts/box-e2e-tauri-update.mjs): the same functions the page reaches, chosen by
/// an env var, compiled only with the off-by-default feature. scripts/check-tauri-updater.mjs pins it out of default features.
#[cfg(feature = "update-e2e")]
mod e2e {
    use super::*;

    fn close_main(app: &AppHandle) {
        if let Some(window) = app.get_webview_window(crate::guest::MAIN_LABEL) {
            let _ = window.close();
        }
    }

    pub fn start(app: &AppHandle) {
        // A normal close when the harness creates this file: the same path as the user closing the window.
        if let Ok(file) = std::env::var("ZUMI_UPDATE_E2E_QUIT_FILE") {
            let app = app.clone();
            std::thread::spawn(move || loop {
                if Path::new(&file).exists() {
                    close_main(&app);
                    return;
                }
                std::thread::sleep(Duration::from_millis(250));
            });
        }
        // A stubborn descendant: the vault helper running from the install dir (its image is locked while it runs), waiting on a
        // stdin nobody closes, in the sidecar's job. Only TerminateJobObject can end it before the installer copies files.
        if std::env::var("ZUMI_UPDATE_E2E_HOLD").as_deref() == Ok("1") {
            let vault = std::env::current_exe().ok().and_then(|exe| exe.parent().map(|d| d.join("zumi-vault.exe")));
            let held = vault.and_then(|exe| crate::node_runtime::spawn_e2e_hold(&exe).ok());
            if let Some(child) = held {
                app.state::<State>().log(&format!("hold pid {}", child.id()));
                std::mem::forget(child); // the stdin pipe stays open until this process ends
            }
        }
    }

    /// Whether the sidecar still answers: the page's own way in, one rpc.
    pub fn after_check(app: &AppHandle) {
        let answers = app.state::<Rpc>().call("info", Vec::new(), Duration::from_secs(10)).is_ok();
        app.state::<State>().log(&format!("sidecar answers: {answers}"));
    }

    pub fn on_ready(app: &AppHandle, version: &str) {
        match std::env::var("ZUMI_UPDATE_E2E").as_deref() {
            Ok("restart") => {
                let app = app.clone();
                std::thread::spawn(move || {
                    install_now(&app);
                });
            }
            Ok("quit") => {
                app.state::<State>().core.lock().unwrap().later(version);
                app.state::<State>().log(&format!("later {version}; installs on quit"));
                close_main(app);
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn core() -> Core<()> {
        Core::default()
    }
    fn pending(version: &str) -> Pending<()> {
        Pending { version: version.into(), notes: "n".into(), file: PathBuf::from(format!("{version}.exe")), update: () }
    }

    #[test]
    fn the_four_update_methods_and_nothing_else_are_intercepted() {
        assert_eq!(Op::from_method("update.status"), Some(Op::Status));
        assert_eq!(Op::from_method("update.install"), Some(Op::Install));
        assert_eq!(Op::from_method("update.later"), Some(Op::Later));
        assert_eq!(Op::from_method("update.check"), Some(Op::Check));
        for other in ["update.onState", "update", "update.status ", "info", ""] {
            assert_eq!(Op::from_method(other), None, "{other:?}");
        }
    }

    #[test]
    fn only_a_public_release_launch_with_a_key_updates() {
        assert!(enabled(false, false, "KEY", false));
        assert!(!enabled(true, false, "KEY", false), "an owner build (flavour file) never updates");
        assert!(!enabled(false, true, "KEY", false), "a self-test launch never updates");
        assert!(!enabled(false, false, "", false), "no key yet");
        assert!(!enabled(false, false, "   ", false), "a blank key is no key");
        assert!(!enabled(false, false, "KEY", true), "a debug build never updates");
    }

    #[test]
    fn a_feed_version_cannot_name_a_file_outside_the_folder() {
        let dir = Path::new("d");
        assert_eq!(pending_file(dir, "1.2.3-beta.1+x"), Some(dir.join("1.2.3-beta.1+x.exe")));
        for bad in ["", "..", "../x", "a/b", "a\\b", "1..2", "c:", "1 2"] {
            assert_eq!(pending_file(dir, bad), None, "{bad:?}");
        }
    }

    #[test]
    fn checks_are_single_flight_and_a_download_keeps_the_lock() {
        let mut c = core();
        assert!(c.begin_check());
        assert!(!c.begin_check(), "second check during a check");
        assert_eq!(c.on_found("2.0.0"), Found::Download);
        assert!(!c.begin_check(), "a tick during a download is skipped");
        assert_eq!(c.on_downloaded(pending("2.0.0")), None);
        assert!(c.begin_check(), "free again after the download");
    }

    #[test]
    fn progress_moves_only_when_the_percentage_does() {
        let mut c = core();
        c.begin_check();
        c.on_found("2.0.0");
        assert!(c.on_progress(10, Some(100)));
        assert!(!c.on_progress(10, Some(100)), "same percent");
        assert!(!c.on_progress(50, None), "no Content-Length");
        assert!(c.on_progress(100, Some(100)));
        assert_eq!(c.snapshot()["percent"], 100);
    }

    #[test]
    fn a_downloaded_version_is_offered_once_and_later_holds_until_a_higher_one() {
        let mut c = core();
        c.begin_check();
        c.on_found("2.0.0");
        c.on_downloaded(pending("2.0.0"));
        assert_eq!(c.snapshot()["phase"], "ready");
        assert_eq!(c.snapshot()["ready"]["version"], "2.0.0");
        assert!(!c.later("9.9.9"), "Later for another version does nothing");
        assert!(c.later("2.0.0"));
        assert_eq!(c.snapshot()["ready"], Value::Null, "not offered again");
        assert_eq!(c.snapshot()["phase"], "ready", "still pending for the quit");
        assert!(!c.later("2.0.0"), "already put off");

        c.begin_check();
        assert_eq!(c.on_found("2.0.0"), Found::AlreadyPending, "no second download");
        assert_eq!(c.snapshot()["ready"], Value::Null, "a later check does not re-offer it");

        c.begin_check();
        assert_eq!(c.on_found("2.1.0"), Found::Download);
        let replaced = c.on_downloaded(pending("2.1.0"));
        assert_eq!(replaced, Some(PathBuf::from("2.0.0.exe")), "the older file goes");
        assert_eq!(c.snapshot()["ready"]["version"], "2.1.0", "a higher version is offered");
    }

    #[test]
    fn only_a_nothing_newer_answer_withdraws_never_an_error() {
        let mut c = core();
        c.begin_check();
        c.on_found("2.0.0");
        c.on_downloaded(pending("2.0.0"));

        // A failed check: the caller only releases the lock, so the pending update stands.
        c.begin_check();
        c.end_check();
        assert!(c.begin_install().is_some());
        c.end_install();

        c.begin_check();
        assert_eq!(c.on_no_update(), Some(PathBuf::from("2.0.0.exe")));
        assert_eq!(c.snapshot()["phase"], "idle");
        assert_eq!(c.snapshot()["ready"], Value::Null);
        assert!(c.begin_install().is_none(), "nothing left to install on quit");

        c.begin_check();
        assert_eq!(c.on_no_update(), None, "nothing pending, nothing to delete");
    }

    #[test]
    fn a_rejected_download_shows_one_error_and_stores_nothing() {
        let mut c = core();
        c.begin_check();
        c.on_found("2.0.0");
        let shown = c.on_download_failed();
        assert_eq!(shown["phase"], "error");
        assert_eq!(c.snapshot()["phase"], "idle");
        assert!(c.begin_install().is_none());
        assert!(c.begin_check(), "the next check retries");
    }

    #[test]
    fn a_rejected_higher_version_falls_back_to_the_pending_one() {
        let mut c = core();
        c.begin_check();
        c.on_found("2.0.0");
        c.on_downloaded(pending("2.0.0"));
        c.begin_check();
        c.on_found("2.1.0");
        assert_eq!(c.on_download_failed()["phase"], "error");
        assert_eq!(c.snapshot()["phase"], "ready");
        assert_eq!(c.snapshot()["version"], "2.0.0");
        assert_eq!(c.begin_install().map(|p| p.version), Some("2.0.0".to_string()));
    }

    #[test]
    fn a_second_install_click_gets_false_and_a_failure_frees_it() {
        let mut c = core();
        assert!(c.begin_install().is_none(), "nothing pending");
        c.begin_check();
        c.on_found("2.0.0");
        c.on_downloaded(pending("2.0.0"));
        assert!(c.begin_install().is_some());
        assert!(c.begin_install().is_none(), "second click");
        assert!(!c.begin_check(), "no check once an install started");
        c.end_install();
        assert!(c.begin_install().is_some());
    }

    #[test]
    fn apply_failing_before_the_stop_keeps_the_app_and_never_restarts() {
        let stopped = AtomicBool::new(false);
        let restarted = Cell::new(false);
        assert_eq!(apply(&stopped, || Err("signature"), || restarted.set(true)), Applied::Failed("signature"));
        assert!(!restarted.get());
    }

    #[test]
    fn apply_failing_after_the_stop_restarts_the_old_version() {
        // ShellExecuteW failed: the hook already ran, so only a restart brings the sidecar back.
        let stopped = AtomicBool::new(false);
        let restarted = Cell::new(false);
        let out = apply(
            &stopped,
            || {
                stopped.store(true, Ordering::SeqCst);
                Err("shell")
            },
            || restarted.set(true),
        );
        assert_eq!(out, Applied::Recovered("shell"));
        assert!(restarted.get());
    }

    #[test]
    fn apply_success_runs_no_recovery() {
        let stopped = AtomicBool::new(true);
        let restarted = Cell::new(false);
        assert_eq!(apply::<()>(&stopped, || Ok(()), || restarted.set(true)), Applied::Launched);
        assert!(!restarted.get());
    }

    #[test]
    fn the_pending_folder_clears_and_the_log_is_capped() {
        let dir = std::env::temp_dir().join(format!("zumi-updater-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("1.0.0.exe"), b"x").unwrap();
        assert_eq!(clear_pending_dir(&dir), 1);
        assert_eq!(clear_pending_dir(&dir.join("absent")), 0);

        let log = dir.join("updater.log");
        std::fs::write(&log, vec![b'x'; LOG_MAX_BYTES as usize]).unwrap();
        append_log(&log, "line\nwith break");
        assert!(dir.join("updater.log.1").exists(), "rotated");
        let text = std::fs::read_to_string(&log).unwrap();
        assert!(text.ends_with("line with break\n") && text.len() < 64, "{text}");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn only_the_plugins_own_temp_folders_are_leftovers() {
        assert!(is_leftover_installer_dir("Zumi-1.2.3-updater-AbC123", "Zumi"));
        assert!(is_leftover_installer_dir("Zumi-1.2.3-beta.1-updater-x", "Zumi"));
        for other in ["Zumi-1.2.3-updater-", "Zumi--updater-x", "Zumi-1.2.3-update-x", "ZumiOther-1.2.3-updater-x", "Other-1.2.3-updater-x", "Zumi", "Zumi-1.2.3-updater-a/b", "Zumi-1 2-updater-x"] {
            assert!(!is_leftover_installer_dir(other, "Zumi"), "{other}");
        }
    }

    #[test]
    fn startup_removes_leftover_folders_and_nothing_else() {
        let dir = std::env::temp_dir().join(format!("zumi-leftover-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("Zumi-1.0.0-updater-abc")).unwrap();
        std::fs::write(dir.join("Zumi-1.0.0-updater-abc").join("Zumi-1.0.0-installer.exe"), b"MZ").unwrap();
        std::fs::create_dir_all(dir.join("Other-1.0.0-updater-abc")).unwrap();
        std::fs::write(dir.join("Zumi-2.0.0-updater-file"), b"a file, not ours").unwrap();
        assert_eq!(clear_leftover_installers(&dir, "Zumi"), 1);
        assert!(!dir.join("Zumi-1.0.0-updater-abc").exists());
        assert!(dir.join("Other-1.0.0-updater-abc").exists());
        assert!(dir.join("Zumi-2.0.0-updater-file").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_install_check_counts_changed_and_missing_files_and_ignores_extras() {
        use sha2::{Digest, Sha256};
        let dir = std::env::temp_dir().join(format!("zumi-install-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        let hex = |b: &[u8]| Sha256::digest(b).iter().map(|x| format!("{x:02x}")).collect::<String>();
        std::fs::write(dir.join("a.txt"), b"new").unwrap();
        std::fs::write(dir.join("sub").join("b.txt"), b"same").unwrap();
        std::fs::write(dir.join("stale.txt"), b"from an old version").unwrap();
        let list = |a: &[u8]| json!({ "files": { "a.txt": { "bytes": a.len(), "sha256": hex(a) }, "sub/b.txt": { "bytes": 4, "sha256": hex(b"same") } } }).to_string();
        assert_eq!(install_mismatches(&dir, &list(b"new")), Some(0));
        assert_eq!(install_mismatches(&dir, &list(b"old")), Some(1), "same size, other bytes");
        assert_eq!(install_mismatches(&dir, &list(b"longer")), Some(1), "other size");
        std::fs::remove_file(dir.join("a.txt")).unwrap();
        assert_eq!(install_mismatches(&dir, &list(b"new")), Some(1), "missing");
        assert_eq!(install_mismatches(&dir, "not json"), None);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn events_go_through_the_main_only_emitter() {
        let source = include_str!("updater.rs");
        assert!(source.contains(concat!("events::emit_main(app, ", "\"update:state\"")));
        assert!(!source.contains(concat!("app.emit", "(")), "no broadcast");
    }
}
