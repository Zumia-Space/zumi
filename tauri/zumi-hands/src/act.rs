//! Acting verbs (P1, with the P2 rails). Every verb on a window passes, in this order: gate (armed, not killed,
//! dead-man not expired), own pid (launched by this helper), not the helper's own window, the target executable on
//! the hands allowlist (hands_policy), the window owned by that pid (re-checked on every call), and the freshness
//! rule when the window is watched (cache not updating and updated since our last action; bounded wait, then fail
//! closed). Then the verb's own checks (password fields, element owner, foreground per SendInput batch).
//! Every decision, allowed or refused, is one line in the audit log (zumi-audit); `arm` refuses without one.
//! UIA patterns are the first choice; SendInput only for typed text and key chords. The overlay (hands_overlay)
//! sits on the target while it is acted on; the kill switch is kill.rs.
use crate::hands_policy::{self, Policy, Waited, FRESH_WAIT_MS, TYPE_BATCH_CHARS};
use crate::kill;
use crate::rails::{self, Gate, Refusal};
use crate::tree::Node;
use crate::uia::{self, read_cached, MAX_NODES};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use windows::core::BSTR;
use windows::Win32::Foundation::{CloseHandle, HWND, RECT};
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
use windows::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
use windows::Win32::System::ProcessStatus::EnumProcesses;
use windows::Win32::System::Threading::{GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};
use windows::Win32::UI::Accessibility::*;
use windows::Win32::UI::Input::KeyboardAndMouse::*;
use windows::core::BOOL;
use windows::Win32::Foundation::LPARAM;
use windows::Win32::UI::WindowsAndMessaging::{EnumChildWindows, GetAncestor, GetClassNameW, GetGUIThreadInfo, GA_ROOT, GUITHREADINFO, GetForegroundWindow, GetWindowRect, GetWindowThreadProcessId, SetCursorPos, SetForegroundWindow, WindowFromPoint};
use zumi_audit::{Audit, Entry};

/// How long after a pattern action the acted element is re-read for its own change (review R3 S1).
const REFRESH_MS: u64 = 250;

struct State {
    armed_until: Option<Instant>,
    own: Vec<rails::OwnProcess>,
    capture_root: Option<PathBuf>,
    policy: Policy,
    audit: Option<Audit>,
    /// When this helper last acted on each window (the freshness rule compares the cache with it).
    last_action: HashMap<u64, Instant>,
    /// Opt-in packs whose warning the user accepted (CoS E1); each holds for one policy version.
    accepted: Vec<hands_policy::Acceptance>,
    /// Places the hands never target (CoS E2 (3)): the policy and audit directories, the Startup folders.
    protected: Vec<String>,
}

static STATE: Mutex<Option<State>> = Mutex::new(None);

fn with<R>(f: impl FnOnce(&mut State) -> R) -> R {
    let mut g = STATE.lock().unwrap_or_else(|p| p.into_inner());
    let st = g.get_or_insert_with(|| State {
        armed_until: None,
        own: Vec::new(),
        capture_root: None,
        policy: Policy::default(),
        audit: None,
        last_action: HashMap::new(),
        accepted: Vec::new(),
        protected: Vec::new(),
    });
    f(st)
}

pub fn unix_ms() -> u128 {
    kill::unix_ms()
}

fn gate() -> Result<(), Refusal> {
    let armed_until = with(|s| s.armed_until);
    Gate { armed_until, killed: kill::is_killed() }.check(Instant::now())
}

fn win32<T>(r: windows::core::Result<T>) -> Result<T, Refusal> {
    r.map_err(|e| ("uia_error", e.to_string()))
}

/// Runs one verb and writes its decision to the audit log. A refusal is logged with its code. If the line cannot be
/// written the verb reports `audit_failed`.
pub fn audited(verb: &str, pid: Option<u32>, hwnd: Option<u64>, f: impl FnOnce() -> Result<Value, Refusal>) -> Result<Value, Refusal> {
    let r = f();
    let exe = pid.and_then(exe_of);
    let (code, detail) = match &r {
        Ok(v) => (None, v.to_string()),
        Err((c, d)) => (Some(*c), d.clone()),
    };
    let wrote = with(|s| {
        s.audit.as_ref().map(|a| a.record(&Entry { verb, pid, exe: exe.as_deref(), hwnd, code, detail: &detail }).is_ok())
    });
    match (wrote, r) {
        (Some(false), Ok(_)) => Err(("audit_failed", "the action ran but its audit line could not be written".into())),
        (_, r) => r,
    }
}

/// Full executable path of a process, or None.
pub fn exe_of(pid: u32) -> Option<String> {
    // SAFETY: a limited-information handle, closed before return; the buffer is sized and the length returned.
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 1024];
        let mut n = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, windows::core::PWSTR(buf.as_mut_ptr()), &mut n).is_ok();
        let _ = CloseHandle(h);
        ok.then(|| String::from_utf16_lossy(&buf[..n as usize]))
    }
}

/// Creation time of a process (FILETIME as u64), or None when there is no such process.
fn created_of(pid: u32) -> Option<u64> {
    // SAFETY: a limited-information handle, closed before return; the FILETIMEs are plain out-parameters.
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let (mut c, mut e, mut k, mut u) = Default::default();
        let ok = GetProcessTimes(h, &mut c, &mut e, &mut k, &mut u).is_ok();
        let _ = CloseHandle(h);
        ok.then(|| (u64::from(c.dwHighDateTime) << 32) | u64::from(c.dwLowDateTime))
    }
}

/// Pids of every running process whose executable is `exe` (case-insensitive full path).
fn pids_of_exe(exe: &str) -> Vec<u32> {
    let mut pids = vec![0u32; 4096];
    let mut bytes = 0u32;
    // SAFETY: the buffer is sized; EnumProcesses writes at most its size and reports the bytes written.
    if unsafe { EnumProcesses(pids.as_mut_ptr(), (pids.len() * 4) as u32, &mut bytes) }.is_err() {
        return Vec::new();
    }
    pids.truncate(bytes as usize / 4);
    pids.into_iter().filter(|&p| p != 0 && exe_of(p).is_some_and(|e| e.eq_ignore_ascii_case(exe))).collect()
}

/// `arm --deadman-ms N --audit FILE [--policy FILE] [--capture-root DIR]`. Requires the stop hotkey and an audit log.
pub fn arm(deadman_ms: u64, capture_root: Option<PathBuf>, policy: Option<&Path>, audit: Option<&Path>) -> Result<Value, Refusal> {
    if !kill::start_hotkey() {
        return Err(("no_hotkey", "Ctrl+Alt+Pause could not be registered; refusing to arm".into()));
    }
    if kill::is_killed() {
        return Err(("killed", "the stop hotkey was pressed; restart the helper".into()));
    }
    let audit_path = audit.ok_or(("no_audit", "arm needs --audit FILE: no action without an audit log".to_string()))?;
    let log = Audit::open(audit_path).map_err(|e| ("no_audit", format!("{}: {e}", audit_path.display())))?;
    let pol = match policy {
        Some(p) => Policy::load(p)?,
        None => Policy::default(),
    };
    // Packs count only as accepted through the host's own warning dialog (a person clicked Accept), for this policy version.
    let accepted = policy
        .map(|p| hands_policy::acceptances_from_store(&std::fs::read_to_string(hands_policy::store_path(p)).unwrap_or_default(), &pol, hands_policy::host_key()))
        .unwrap_or_default();
    let packs: Vec<String> = accepted.iter().map(|a| a.pack.clone()).collect();
    let (appdata, programdata) = env_dirs();
    let mut protected = hands_policy::startup_dirs(&appdata, &programdata);
    for f in [policy, Some(audit_path)].into_iter().flatten() {
        let full = std::fs::canonicalize(f).unwrap_or_else(|_| f.to_path_buf());
        if let Some(dir) = full.parent() {
            protected.push(dir.to_string_lossy().trim_start_matches(r"\\?\").to_string());
        }
    }
    let apps = pol.apps.clone();
    with(|s| {
        s.armed_until = Some(Instant::now() + Duration::from_millis(deadman_ms));
        s.capture_root = capture_root;
        s.policy = pol;
        s.audit = Some(log);
        s.accepted = accepted;
        s.protected = protected;
    });
    start_spawn_watch();
    Ok(json!({ "armed_ms": deadman_ms, "hotkey": "ctrl+alt+pause", "allowlist": apps, "audit": audit_path, "packs_accepted": packs }))
}

pub fn disarm() -> Value {
    with(|s| s.armed_until = None);
    crate::hands_overlay::hide();
    json!({ "armed": false })
}

/// `status`: gate, kill and overlay state.
pub fn status() -> Value {
    let (armed, audit) = with(|s| (s.armed_until.is_some_and(|t| t > Instant::now()), s.audit.as_ref().map(|a| a.path().to_path_buf())));
    let ki = kill::kill_info();
    json!({ "killed": kill::is_killed(), "killed_at_unix_ms": ki.map(|k| k.0 as u64), "killed_by": ki.map(|k| k.1),
            "hotkey_registered": kill::hotkey_registered(), "armed": armed, "audit": audit,
            "overlay_hwnd": format!("0x{:X}", crate::hands_overlay::overlay_hwnd()), "overlay_visible": crate::hands_overlay::visible() })
}

/// `pack_warning --pack P`: the risk warning for opt-in pack P (English and Vietnamese), its fingerprint and the
/// current policy version. Read-only; accepting it is not a stdio verb: only the host's warning dialog records it.
pub fn pack_warning(pack: &str) -> Result<Value, Refusal> {
    let (_, exe, warning) = hands_policy::PACKS.iter().find(|(p, _, _)| *p == pack).ok_or(("bad_args", format!("no pack {pack:?}")))?;
    let version = with(|s| s.policy.version.clone());
    Ok(json!({ "pack": pack, "exe": exe, "warning": warning, "warning_vi": hands_policy::EXPLORER_WARNING_VI, "warning_fnv": hands_policy::fnv_hex(warning), "policy_version": version }))
}

/// The kill as one audit line (review S4): from the hotkey thread or the `kill` verb, with the form that fired and
/// the kill time. Without an audit log (not armed yet) there is nothing to write to.
pub fn record_kill(by: &str, at_unix_ms: u128) {
    let detail = json!({ "by": by, "killed_at_unix_ms": at_unix_ms as u64 }).to_string();
    with(|s| {
        if let Some(a) = s.audit.as_ref() {
            let _ = a.record(&Entry { verb: "kill", pid: None, exe: None, hwnd: None, code: None, detail: &detail });
        }
    });
}

/// Test hook and `kill` verb: the same effect as the hotkey.
pub fn kill_now() -> Value {
    kill::kill("verb");
    json!({ "killed": true })
}

/// `launch --exe E [--args [..]]`: start an allowlisted executable with the arguments its policy rule allows (none
/// without a rule). Explorer's directory rule runs `/separate,<dir>`: the process we start hands the folder window to
/// a new process and exits; that process is adopted only as hands_policy::pick_handoff allows.
pub fn launch(exe: &str, args: &[String]) -> Result<Value, Refusal> {
    gate()?;
    let plan = with(|s| s.policy.allow_app_with(exe, &s.accepted).and_then(|_| s.policy.launch_plan(exe, args)))?;
    for a in &plan.argv {
        not_protected(a.trim_start_matches("/separate,"))?;
    }
    let before = if plan.handoff_titles.is_some() { pids_of_exe(exe) } else { Vec::new() };
    // The child gets no handle of ours: inherited stdio would let it write into the protocol channel (stdout), read
    // the requests (stdin), or keep the pipe open after we exit (seen with VS Code, 11-11).
    // The spawn is a side effect: the gate is checked right before it (review R2 S2).
    let mut child = hands_policy::guarded(gate, || {
        std::process::Command::new(exe)
            .args(&plan.argv)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| ("launch_failed", e.to_string()))
    })?;
    let started = child.id();
    let Some(titles) = plan.handoff_titles else {
        // The process we started must be the executable we checked (review R1 N1).
        if !exe_of(started).is_some_and(|e| e.eq_ignore_ascii_case(exe)) {
            let _ = child.kill();
            return Err(("launch_mismatch", format!("pid {started} is not {exe}; stopped it")));
        }
        with(|s| s.own.push((started, created_of(started).unwrap_or(0))));
        return Ok(json!({ "pid": started, "exe": exe, "argv": plan.argv }));
    };
    let (mut exited, mut seen) = (false, Vec::new());
    // A kill during this wait refuses the launch: no "allowed" launch line after a kill.
    let adopted = hands_policy::poll_until(|| {
        exited = matches!(child.try_wait(), Ok(Some(_)));
        // Only processes that did not exist before the start are looked at (and only their windows are read).
        let now: Vec<hands_policy::Candidate> = pids_of_exe(exe)
            .into_iter()
            .filter(|p| *p != started && !before.contains(p))
            .map(|pid| hands_policy::Candidate { pid, windows: uia::windows_of(pid).into_iter().map(|w| (w.class_name, w.title)).collect() })
            .collect();
        seen = now.iter().map(|c| (c.pid, c.windows.len())).collect();
        hands_policy::pick_handoff(started, exited, &before, &now, &titles)
    }, gate, Duration::from_secs(15), Duration::from_millis(250))?;
    if let Some(pid) = adopted {
        with(|s| s.own.push((pid, created_of(pid).unwrap_or(0))));
        return Ok(json!({ "pid": pid, "exe": exe, "argv": plan.argv, "handoff_from": started }));
    }
    Err(("handoff_failed", format!("no new process showed the requested folder within 15 s (started {started} exited: {exited}; new (pid, windows): {seen:?})")))
}

/// The freshness rule on `hwnd`: when it is watched, wait (at most FRESH_WAIT_MS, the gate re-checked on every poll)
/// until its cache is not updating and has changed since our last action on it. Unwatched: current (callers read
/// fresh). The caller decides what a stale end means.
fn wait_fresh(hwnd: u64, el: Option<&str>) -> Result<Waited, Refusal> {
    let Some(w) = crate::watch::get(hwnd) else { return Ok(Waited::Current(0)) };
    let last = with(|s| s.last_action.get(&hwnd).copied());
    // The element acted on may be current by the hands' own re-read of it; every other element only by the cache.
    let rid = el.and_then(|id| w.cached_runtime_id(id));
    let probe = || (w.pending(), hands_policy::as_of_for_element(w.as_of(), rid.as_deref().and_then(|r| w.element_refreshed_at(r))));
    hands_policy::wait_fresh(probe, last, gate, Duration::from_millis(FRESH_WAIT_MS))
}

fn env_dirs() -> (String, String) {
    (std::env::var("APPDATA").unwrap_or_default(), std::env::var("ProgramData").unwrap_or_default())
}

/// CoS E2 (3): text that names a protected place is refused.
fn not_protected(text: &str) -> Result<(), Refusal> {
    let (appdata, programdata) = env_dirs();
    match with(|s| hands_policy::protected_hit(text, &s.protected, &appdata, &programdata)) {
        Some(p) => Err(("protected_path", format!("the hands never target {p}"))),
        None => Ok(()),
    }
}

/// Classes of a window's child windows (no message is sent: GetClassNameW reads the class atom).
fn child_classes(hwnd: u64) -> Vec<String> {
    unsafe extern "system" fn collect(h: HWND, lp: LPARAM) -> BOOL {
        // SAFETY: lp is the &mut Vec<String> passed below, alive for the whole EnumChildWindows call.
        let out = unsafe { &mut *(lp.0 as *mut Vec<String>) };
        let mut buf = [0u16; 128];
        // SAFETY: a sized buffer; the length returned is clamped.
        let n = unsafe { GetClassNameW(h, &mut buf) }.max(0) as usize;
        out.push(String::from_utf16_lossy(&buf[..n.min(buf.len())]));
        BOOL(1)
    }
    let mut out: Vec<String> = Vec::new();
    // SAFETY: enumerates the children of a window; the callback only reads class names.
    unsafe {
        let _ = EnumChildWindows(Some(HWND(hwnd as usize as *mut _)), Some(collect), LPARAM(&mut out as *mut _ as isize));
    }
    out
}

/// The top-level window that holds `hwnd` (itself for a top-level or owned window).
fn root_of(hwnd: u64) -> u64 {
    // SAFETY: reads a window's ancestry; sends nothing.
    unsafe { GetAncestor(HWND(hwnd as usize as *mut _), GA_ROOT) }.0 as usize as u64
}

/// The element's window (`root`) is the addressed one, or a popup menu of the same process (R5d).
fn root_ok(pid: u32, hwnd: u64, root: u64) -> Result<(), Refusal> {
    if root == hwnd {
        return Ok(());
    }
    let mut root_pid = 0u32;
    // SAFETY: reads the process id of a window; sends nothing.
    unsafe { GetWindowThreadProcessId(HWND(root as usize as *mut _), Some(&mut root_pid)) };
    hands_policy::same_root_or_menu(hwnd, root, &class_of(root), root_pid, pid)
}

fn class_of(hwnd: u64) -> String {
    let mut buf = [0u16; 128];
    // SAFETY: a sized buffer; the length returned is clamped.
    let n = unsafe { GetClassNameW(HWND(hwnd as usize as *mut _), &mut buf) }.max(0) as usize;
    String::from_utf16_lossy(&buf[..n.min(buf.len())])
}

/// CoS E2 (1): a file dialog or Explorer window needs the Explorer pack.
fn surface_ok(hwnd: u64) -> Result<(), Refusal> {
    let accepted = with(|s| s.accepted.iter().any(|a| a.pack == "explorer"));
    hands_policy::shell_surface_ok(hands_policy::is_shell_surface(&class_of(hwnd), &child_classes(hwnd)), accepted)
}

/// Every process as (pid, parent pid).
fn process_list() -> Vec<(u32, u32)> {
    let mut out = Vec::new();
    // SAFETY: a process snapshot read entry by entry and closed; the entry's size is set before the first call.
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return out };
        let mut e = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        if Process32FirstW(snap, &mut e).is_ok() {
            loop {
                out.push((e.th32ProcessID, e.th32ParentProcessID));
                if Process32NextW(snap, &mut e).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
    }
    out
}

/// CoS E2 (2), session-long (review R5 M2): any process whose parent chain leads to one of ours and that `launch`
/// did not start (other than a same-image helper of the app) means an app of ours started a program the hands did
/// not launch. Stop acting (the kill switch, form "spawn"), write a `spawned` audit line, refuse. Checked at the
/// start of every verb, right after every action, and every 250 ms by a watcher thread while the helper runs.
fn spawn_check() -> Result<(), Refusal> {
    if kill::is_killed() {
        return Ok(());
    }
    // Only own processes that are still the same process (pid and creation time) count as ancestors.
    let own: Vec<u32> = with(|s| s.own.clone()).into_iter().filter(|(p, c)| created_of(*p) == Some(*c)).map(|(p, _)| p).collect();
    if own.is_empty() {
        return Ok(());
    }
    let same = |a: u32, b: u32| matches!((exe_of(a), exe_of(b)), (Some(x), Some(y)) if x.eq_ignore_ascii_case(&y));
    let new = hands_policy::spawned_descendants(&process_list(), &own, same);
    if new.is_empty() {
        return Ok(());
    }
    let exes: Vec<String> = new.iter().map(|p| exe_of(*p).unwrap_or_default()).collect();
    let detail = json!({ "new_processes": new, "exes": exes }).to_string();
    with(|s| {
        if let Some(a) = s.audit.as_ref() {
            let _ = a.record(&Entry { verb: "spawned", pid: None, exe: None, hwnd: None, code: Some("spawned_process"), detail: &detail });
        }
    });
    kill::kill("spawn");
    Err(("spawned_process", format!("an app of ours started a process the hands did not launch: {detail}; acting stopped")))
}

/// The watcher thread for spawn_check, started once (at the first arm).
fn start_spawn_watch() {
    static STARTED: std::sync::Once = std::sync::Once::new();
    STARTED.call_once(|| {
        std::thread::spawn(|| loop {
            std::thread::sleep(Duration::from_millis(250));
            if kill::is_killed() {
                break;
            }
            let _ = spawn_check();
        });
    });
}

/// The rails every SendInput batch re-checks (no freshness wait: freshness is decided once, when the verb starts).
fn rails_ok(pid: u32, hwnd: u64) -> Result<uia::WindowInfo, Refusal> {
    gate()?;
    let created = created_of(pid);
    with(|s| rails::own_pid(&s.own, pid, created))?;
    hands_policy::not_own_window(pid, std::process::id())?;
    let exe = exe_of(pid).unwrap_or_default();
    with(|s| s.policy.allow_app_with(&exe, &s.accepted))?;
    let w = uia::pick_window(pid, Some(hwnd))?;
    surface_ok(hwnd)?;
    with(|s| s.policy.ui_window_allowed(&exe, &w.class_name))?;
    Ok(w)
}

/// Rails shared by every verb on a window, then the freshness wait. After the wait the gate is checked again and the
/// overlay follows the window (never after a kill).
fn target(pid: u32, hwnd: u64, el: Option<&str>) -> Result<(uia::WindowInfo, Waited), Refusal> {
    // The spawn check runs once per verb here (and after its action, and on the watcher thread), not before every
    // keystroke: a process snapshot per key made the kill stop late (R5 goal run: 7/20 over 200 ms).
    spawn_check()?;
    let w = rails_ok(pid, hwnd)?;
    let waited = wait_fresh(hwnd, el)?;
    gate()?;
    crate::hands_overlay::follow(hwnd);
    Ok((w, waited))
}

fn acted(hwnd: u64) {
    with(|s| s.last_action.insert(hwnd, Instant::now()));
}

/// `freshness --hwnd H`: read-only. Whether an action on H would find the cache current now, and the times involved.
pub fn freshness(hwnd: u64) -> Value {
    let now = Instant::now();
    let ago = |t: Option<Instant>| t.map(|t| now.saturating_duration_since(t).as_millis() as u64);
    let last = with(|s| s.last_action.get(&hwnd).copied());
    match crate::watch::get(hwnd) {
        None => json!({ "watched": false, "last_action_ms_ago": ago(last) }),
        Some(w) => {
            let (pending, as_of) = (w.pending(), w.as_of());
            json!({ "watched": true, "pending": pending, "cache_as_of_ms_ago": ago(as_of), "last_action_ms_ago": ago(last),
                    "current": hands_policy::fresh(pending, as_of, last).is_ok() })
        }
    }
}

fn foreground_pid() -> u32 {
    let mut pid = 0u32;
    // SAFETY: reads the foreground window and its owner pid; sends nothing.
    unsafe { GetWindowThreadProcessId(GetForegroundWindow(), Some(&mut pid)) };
    pid
}

pub fn focus(pid: u32, hwnd: u64) -> Result<Value, Refusal> {
    let (_, w) = target(pid, hwnd, None)?;
    let waited = hands_policy::require_current(w)?;
    // SAFETY: a request to the window manager for a window of our own launched process.
    let asked = hands_policy::guarded(gate, || Ok(unsafe { SetForegroundWindow(HWND(hwnd as usize as *mut _)) }.as_bool()))?;
    acted(hwnd);
    std::thread::sleep(Duration::from_millis(100));
    let fg = foreground_pid();
    Ok(json!({ "requested": asked, "foreground_pid": fg, "is_foreground": fg == pid, "waited_ms": waited }))
}

thread_local! {
    static CLIENT: std::cell::RefCell<Option<uia::Client>> = const { std::cell::RefCell::new(None) };
}

fn automation() -> Result<IUIAutomation, Refusal> {
    // SAFETY: COM on this (the serve) thread, initialised once.
    CLIENT.with(|c| -> Result<IUIAutomation, Refusal> {
        if c.borrow().is_none() {
            unsafe {
                let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
                *c.borrow_mut() = Some(win32(uia::new_client())?);
            }
        }
        Ok(c.borrow().as_ref().map(|c| c.automation.clone()).expect("set above"))
    })
}

/// The live element with prune id `id` in a fresh read of `hwnd`, its pruned entry (role, name, path) and that read.
fn find(pid: u32, hwnd: u64, id: &str) -> Result<(IUIAutomationElement, crate::prune::Element, Node, u64), Refusal> {
    // SAFETY (whole fn): COM on this (the serve) thread, initialised once; UIA calls on our own client.
    unsafe {
        let automation = automation()?;
        let request = CLIENT.with(|c| c.borrow().as_ref().map(|c| c.subtree_live.clone()).expect("set above"));
        let root = win32(automation.ElementFromHandleBuildCache(HWND(hwnd as usize as *mut _), &request))?;
        let mut budget = MAX_NODES;
        let tree: Node = read_cached(&root, 0, &mut budget);
        let el = crate::prune::prune(&tree).into_iter().find(|e| e.id == id).ok_or(("no_element", format!("no element {id} in the window now")))?;
        let mut cur = root;
        // The deepest native window on the way down: its top-level window is the one that holds the element (an
        // owned dialog shows up in the owner's UIA tree, review R5 M1).
        let mut native = hwnd;
        for &i in &el.path {
            let kids = win32(cur.GetCachedChildren())?;
            cur = win32(kids.GetElement(i as i32))?;
            if let Ok(h) = cur.CurrentNativeWindowHandle() {
                if !h.0.is_null() {
                    native = h.0 as usize as u64;
                }
            }
        }
        rails::element_owner(win32(cur.CurrentProcessId())? as u32, pid)?;
        Ok((cur, el, tree, root_of(native)))
    }
}

fn waited_ms(w: Waited) -> u64 {
    match w {
        Waited::Current(ms) | Waited::Stale(ms) => ms,
    }
}

/// `find`, plus rule (b) on every action on a watched window, current or stale (review R4 M1): the element the
/// cache shows (by id) and the live one, with their ancestors up to the window, must match
/// (hands_policy::same_as_cache), else the action is refused. `verified`: the check ran (false only unwatched).
fn find_checked(pid: u32, hwnd: u64, id: &str, w: Waited) -> Result<(IUIAutomationElement, crate::prune::Element, bool, u64), Refusal> {
    let watch = crate::watch::get(hwnd);
    if !hands_policy::live_check_needed(watch.is_some(), w) {
        let (e, info, _, root) = find(pid, hwnd, id)?;
        return Ok((e, info, false, root));
    }
    let ms = waited_ms(w);
    let cached_tree = watch.map(|w| w.read().0).ok_or(("stale_cache", "the window is no longer watched".to_string()))?;
    let cached_el = crate::prune::prune(&cached_tree).into_iter().find(|e| e.id == id).ok_or(("stale_cache", format!("element {id} is not in the cached snapshot (waited_ms={ms})")))?;
    let cached = hands_policy::chain(&cached_tree, &cached_el.path).ok_or(("stale_cache", "the cached path leads nowhere".to_string()))?;
    let (e, info, live_tree, root) = match find(pid, hwnd, id) {
        Ok(x) => x,
        Err(("no_element", _)) => return Err(hands_policy::same_as_cache(id, &cached, None).err().unwrap_or(("stale_gone", id.to_string()))),
        Err(other) => return Err(other),
    };
    let live = hands_policy::chain(&live_tree, &info.path).ok_or(("stale_mismatch", "the live path leads nowhere".to_string()))?;
    hands_policy::same_as_cache(id, &cached, Some((info.id.as_str(), &live))).map_err(|(c, d)| (c, format!("{d} (waited_ms={ms})")))?;
    Ok((e, info, true, root))
}

/// One control pattern of a live element. An element without it answers S_OK with no object: `no_pattern`.
fn pat<T: windows::core::Interface>(el: &IUIAutomationElement, id: UIA_PATTERN_ID, name: &str) -> Result<T, Refusal> {
    // SAFETY: a pattern query on a live element of our own launched process.
    unsafe { el.GetCurrentPatternAs::<T>(id) }.map_err(|e| ("no_pattern", format!("the element has no {name} pattern ({e})")))
}

/// `act --pid P --hwnd H --el E --do set_value|invoke|toggle|select|expand|collapse [--value V]`: a UIA pattern on our element.
pub fn pattern(pid: u32, hwnd: u64, id: &str, action: &str, value: Option<&str>) -> Result<Value, Refusal> {
    // Per-phase times in ms (review R5 S4): the rails and freshness wait, the live read and checks, the side effect,
    // the spawn check, the element re-read.
    let t0 = Instant::now();
    let ms = |t: Instant| (t.elapsed().as_secs_f64() * 10000.0).round() / 10.0;
    let (_, w) = target(pid, hwnd, Some(id))?;
    let t_target = ms(t0);
    let t1 = Instant::now();
    let (el, info, verified, root) = find_checked(pid, hwnd, id, w)?;
    let waited = waited_ms(w);
    // The allowlist (CoS R5): the element's own window is the addressed one, and its window class, control type and
    // this verb are listed for the app.
    root_ok(pid, hwnd, root)?;
    let exe = exe_of(pid).unwrap_or_default();
    with(|s| s.policy.ui_allows(&exe, &class_of(root), info.role, &info.name, action))?;
    if action != "collapse" && action != "set_value" && hands_policy::launches_outside(&info.name) {
        return Err(("external_launch", format!("{:?} starts something outside the app (CoS E2): refused", info.name)));
    }
    if let Some(v) = value {
        not_protected(v)?;
    }
    let t_find = ms(t1);
    let t2 = Instant::now();
    // SAFETY: pattern calls on a live element of our own launched process.
    unsafe {
        match action {
            "set_value" => {
                let v = value.ok_or(("bad_args", "set_value needs --value".to_string()))?;
                hands_policy::not_password(win32(el.CurrentIsPassword())?.as_bool())?;
                let p: IUIAutomationValuePattern = pat(&el, UIA_ValuePatternId, "Value")?;
                hands_policy::guarded(gate, || win32(p.SetValue(&BSTR::from(v))))?;
            }
            "invoke" => {
                let p: IUIAutomationInvokePattern = pat(&el, UIA_InvokePatternId, "Invoke")?;
                hands_policy::guarded(gate, || win32(p.Invoke()))?;
            }
            "toggle" => {
                let p: IUIAutomationTogglePattern = pat(&el, UIA_TogglePatternId, "Toggle")?;
                hands_policy::guarded(gate, || win32(p.Toggle()))?;
            }
            "select" => {
                let p: IUIAutomationSelectionItemPattern = pat(&el, UIA_SelectionItemPatternId, "SelectionItem")?;
                hands_policy::guarded(gate, || win32(p.Select()))?;
            }
            "expand" | "collapse" => {
                let p: IUIAutomationExpandCollapsePattern = pat(&el, UIA_ExpandCollapsePatternId, "ExpandCollapse")?;
                hands_policy::guarded(gate, || win32(if action == "expand" { p.Expand() } else { p.Collapse() }))?;
            }
            other => return Err(("bad_args", format!("unknown pattern action {other:?}"))),
        }
    }
    acted(hwnd);
    let t_effect = ms(t2);
    let t3 = Instant::now();
    spawn_check()?;
    let t_spawn = ms(t3);
    let t4 = Instant::now();
    // The cache learns our own change even when the provider raises no event for it (review R3 S1).
    let own = CLIENT.with(|c| c.borrow().as_ref().map(|c| c.own_live.clone()));
    // Win32 proxies apply a Toggle a moment after the call returns (live 11-11: no difference at once): look again
    // for up to REFRESH_MS. An action that changes nothing on its element costs that wait and leaves the cache stale.
    let refreshed = match (crate::watch::get(hwnd), own) {
        (Some(w), Some(own)) => {
            let t0 = Instant::now();
            loop {
                // SAFETY: a fresh read of our own element on this thread's client.
                if unsafe { w.refresh_after_action(&el, &own) } {
                    break true;
                }
                if t0.elapsed() >= Duration::from_millis(REFRESH_MS) {
                    break false;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
        }
        _ => false,
    };
    let phases = json!({ "target_and_wait": t_target, "find_and_check": t_find, "effect": t_effect, "spawn_check": t_spawn, "refresh": ms(t4), "total": ms(t0) });
    Ok(json!({ "done": action, "id": id, "role": info.role, "name": info.name, "waited_ms": waited, "verified": verified, "cache_refreshed": refreshed, "phases_ms": phases }))
}

fn key_input(vk: u16, scan: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VIRTUAL_KEY(vk), wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
    }
}

/// One SendInput batch, sent only if the gate passes immediately before it (review B1).
/// The target thread's state, read as the very last step before the keys go out (review R8 S3: nothing else runs
/// between the read and SendInput). `element_native`: the focused element's own window from before_batch (0: none).
fn thread_state_now(hwnd: u64, element_native: u64) -> Result<(), Refusal> {
    // SAFETY: reads thread ids and the GUI thread state; no input.
    unsafe {
        let tid = GetWindowThreadProcessId(HWND(hwnd as usize as *mut _), None);
        let fg_tid = GetWindowThreadProcessId(GetForegroundWindow(), None);
        hands_policy::same_input_thread(tid, fg_tid)?;
        let mut gui = GUITHREADINFO { cbSize: std::mem::size_of::<GUITHREADINFO>() as u32, ..Default::default() };
        let query_ok = GetGUIThreadInfo(tid, &mut gui).is_ok();
        let focus = gui.hwndFocus.0 as usize as u64;
        let focus_root = if focus == 0 { 0 } else { root_of(focus) };
        hands_policy::thread_state_ok(query_ok, gui.flags.0, gui.hwndCapture.0 as usize as u64, focus, focus_root, hwnd, element_native)
    }
}

/// One SendInput batch: the gate, then the target thread's state, then SendInput, with nothing in between.
fn send(hwnd: u64, element_native: u64, inputs: &[INPUT]) -> Result<(), Refusal> {
    hands_policy::guarded(gate, || {
        thread_state_now(hwnd, element_native)?;
        // SAFETY: a fully initialised INPUT array; SendInput copies it.
        let n = unsafe { SendInput(inputs, std::mem::size_of::<INPUT>() as i32) };
        if n as usize == inputs.len() {
            Ok(())
        } else {
            Err(("send_failed", "SendInput was blocked".to_string()))
        }
    })
}

/// Before a batch: the window rails, foreground owned by the target, and the focused element (where the keys will
/// land) belongs to the target and is not a password field.
fn before_batch(pid: u32, hwnd: u64, verb: &str) -> Result<u64, Refusal> {
    rails_ok(pid, hwnd)?;
    rails::foreground_ok(pid, foreground_pid())?;
    // SAFETY: reads the foreground window handle.
    surface_ok(unsafe { GetForegroundWindow() }.0 as usize as u64)?;
    // SAFETY: reads the focused element's owner and password flag, and the target thread's GUI state; no input.
    unsafe {
        let f = win32(automation()?.GetFocusedElement())?;
        rails::element_owner(win32(f.CurrentProcessId())? as u32, pid)?;
        hands_policy::not_password(win32(f.CurrentIsPassword())?.as_bool())?;
        // The target thread's state (review R7 B1-R7) is read in `send`, as the last step before the keys go out.
        let element_native = f.CurrentNativeWindowHandle().ok().filter(|h| !h.0.is_null()).map(|h| h.0 as usize as u64).unwrap_or(0);
        // The keys land in the focused element: it must sit in the addressed window and be listed for this verb.
        let native = if element_native != 0 { element_native } else { GetForegroundWindow().0 as usize as u64 };
        let root = root_of(native);
        root_ok(pid, hwnd, root)?;
        let role = crate::tree::role_name(win32(f.CurrentControlType())?.0);
        let exe = exe_of(pid).unwrap_or_default();
        let name = crate::tree::display_name(role, &f.CurrentName().map(|b| b.to_string()).unwrap_or_default());
        with(|s| s.policy.ui_allows(&exe, &class_of(root), role, &name, verb))?;
        Ok(element_native)
    }
}

/// `type --pid P --hwnd H --text T [--el E]`: Unicode keystrokes, one per batch (TYPE_BATCH_CHARS), the focused
/// field re-checked before each. With --el, that element is focused first through UIA (refused before focusing if it
/// is a password field).
pub fn type_text(pid: u32, hwnd: u64, text: &str, el: Option<&str>) -> Result<Value, Refusal> {
    not_protected(text)?;
    let exe = exe_of(pid).unwrap_or_default();
    with(|s| s.policy.ui_text_allowed(&exe, text))?;
    let (_, w) = target(pid, hwnd, el)?;
    // With an element, rule (b) can stand in for a stale cache; without one there is nothing to check live.
    let mut verified = false;
    if el.is_none() {
        hands_policy::require_current(w)?;
    }
    let waited = waited_ms(w);
    if let Some(id) = el {
        let (e, info, v, root) = find_checked(pid, hwnd, id, w)?;
        root_ok(pid, hwnd, root)?;
        let exe = exe_of(pid).unwrap_or_default();
        with(|s| s.policy.ui_allows(&exe, &class_of(root), info.role, &info.name, "type"))?;
        verified = v;
        // SAFETY: password flag read and SetFocus on our own element.
        unsafe {
            hands_policy::not_password(win32(e.CurrentIsPassword())?.as_bool())?;
            hands_policy::guarded(gate, || win32(e.SetFocus()))?;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let mut sent = 0usize;
    for b in rails::batches(text, TYPE_BATCH_CHARS) {
        let mut inputs = Vec::new();
        for u in b.encode_utf16() {
            inputs.push(key_input(0, u, KEYEVENTF_UNICODE));
            inputs.push(key_input(0, u, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
        }
        if let Err(e) = before_batch(pid, hwnd, "type").and_then(|native| send(hwnd, native, &inputs)) {
            kill::release_all_keys();
            if sent > 0 {
                acted(hwnd);
            }
            return Err((e.0, format!("{} (after {sent} chars; stopped_at_unix_ms={})", e.1, unix_ms())));
        }
        sent += b.chars().count();
        std::thread::sleep(Duration::from_millis(5));
    }
    acted(hwnd);
    spawn_check()?;
    if let Err(e) = before_batch(pid, hwnd, "type").and_then(|native| thread_state_now(hwnd, native)) {
        kill::release_all_keys();
        return Err((e.0, format!("{} (after the last batch, {sent} chars sent)", e.1)));
    }
    Ok(json!({ "typed_chars": sent, "waited_ms": waited, "verified": verified }))
}

/// `key --pid P --hwnd H --chord ctrl+s`.
pub fn key_chord(pid: u32, hwnd: u64, chord: &str) -> Result<Value, Refusal> {
    let (mods, vk) = rails::parse_chord(chord)?;
    let (_, w) = target(pid, hwnd, None)?;
    let waited = hands_policy::require_current(w)?;
    let mut inputs: Vec<INPUT> = mods.iter().map(|m| key_input(*m, 0, KEYBD_EVENT_FLAGS(0))).collect();
    inputs.push(key_input(vk, 0, KEYBD_EVENT_FLAGS(0)));
    inputs.push(key_input(vk, 0, KEYEVENTF_KEYUP));
    inputs.extend(mods.iter().rev().map(|m| key_input(*m, 0, KEYEVENTF_KEYUP)));
    let r = before_batch(pid, hwnd, "key").and_then(|native| send(hwnd, native, &inputs));
    kill::release_all_keys();
    r?;
    acted(hwnd);
    spawn_check()?;
    Ok(json!({ "chord": chord, "waited_ms": waited }))
}

/// A point the pointer will touch: inside the target's own top-level window (nothing covers it), owned by the target process, not a
/// password field, and with no named control to act on instead (the pixel fallback is for places without a label).
fn point_ok(pid: u32, hwnd: u64, x: i32, y: i32) -> Result<(), Refusal> {
    let pt = windows::Win32::Foundation::POINT { x, y };
    // SAFETY: reads which window is under a screen point; sends nothing.
    let top = root_of(unsafe { WindowFromPoint(pt) }.0 as usize as u64);
    if top != root_of(hwnd) {
        return Err(("covered", format!("another window is over ({x},{y})")));
    }
    // SAFETY: UI Automation reads of the element under the point; nothing is invoked.
    unsafe {
        let e = win32(automation()?.ElementFromPoint(pt))?;
        rails::element_owner(win32(e.CurrentProcessId())? as u32, pid)?;
        hands_policy::not_password(win32(e.CurrentIsPassword())?.as_bool())?;
        let role = crate::tree::role_name(win32(e.CurrentControlType())?.0);
        let name = crate::tree::display_name(role, &e.CurrentName().map(|b| b.to_string()).unwrap_or_default());
        rails::label_blocks_pointer(role, &name)?;
    }
    Ok(())
}

/// `pointer --pid P --hwnd H --do click|drag --x X --y Y [--x2 X --y2 Y]` (R5 pixel fallback): the left button at a point in
/// thousandths of the window, or dragged between two. Rails: the policy must list the app's window with the `Pointer` control type,
/// the foreground belongs to the target, both ends of the path pass `point_ok`, the gate is checked before every move, and the
/// button is always let go (a kill lets it go too).
pub fn pointer(pid: u32, hwnd: u64, verb: &str, a: (i64, i64), b: Option<(i64, i64)>) -> Result<Value, Refusal> {
    let (w, waited) = target(pid, hwnd, None)?;
    let waited_ms = hands_policy::require_current(waited)?;
    let exe = exe_of(pid).unwrap_or_default();
    with(|s| s.policy.ui_allows(&exe, &w.class_name, "Pointer", "", verb))?;
    let points = rails::pointer_plan(verb, w.rect, a, b)?;
    rails::foreground_ok(pid, foreground_pid())?;
    // SAFETY: reads the foreground window handle.
    surface_ok(unsafe { GetForegroundWindow() }.0 as usize as u64)?;
    let (first, last) = (points[0], points[points.len() - 1]);
    point_ok(pid, hwnd, first.0, first.1)?;
    if last != first {
        point_ok(pid, hwnd, last.0, last.1)?;
    }
    let moved = (|| -> Result<(), Refusal> {
        for (i, (x, y)) in points.iter().enumerate() {
            hands_policy::guarded(gate, || {
                rails::foreground_ok(pid, foreground_pid())?;
                // SAFETY: moves the cursor to a point planned inside the target window's rectangle.
                win32(unsafe { SetCursorPos(*x, *y) })?;
                if i == 0 && !kill::press_left() {
                    return Err(("send_failed", "SendInput was blocked".to_string()));
                }
                Ok(())
            })?;
            std::thread::sleep(Duration::from_millis(if verb == "drag" { 15 } else { 30 }));
        }
        hands_policy::guarded(gate, || {
            kill::release_mouse();
            Ok(())
        })
    })();
    // Whatever happened, the button is up.
    kill::release_mouse();
    moved?;
    acted(hwnd);
    spawn_check()?;
    Ok(json!({ "verb": verb, "points": points.len(), "waited_ms": waited_ms }))
}

/// `capture --pid P --hwnd H --out F.bmp [--screen true]`: PrintWindow(PW_RENDERFULLCONTENT) of our window, or with
/// --screen the screen pixels over its rectangle (that shows the overlay too), to a 32-bit BMP.
pub fn capture(pid: u32, hwnd: u64, out: &Path, screen_px: bool) -> Result<Value, Refusal> {
    target(pid, hwnd, None)?;
    let root = with(|s| s.capture_root.clone()).ok_or(("bad_capture_path", "arm with --capture-root first".to_string()))?;
    rails::capture_path_ok(&root, out)?;
    // SAFETY: GDI objects created, used and released in this block; the pixel buffer is sized from the rect.
    let (w, h, pixels) = unsafe {
        let hw = HWND(hwnd as usize as *mut _);
        let mut r = RECT::default();
        win32(GetWindowRect(hw, &mut r))?;
        let (w, h) = (r.right - r.left, r.bottom - r.top);
        let screen = GetDC(None);
        let mem = CreateCompatibleDC(Some(screen));
        let bmp = CreateCompatibleBitmap(screen, w, h);
        let old = SelectObject(mem, bmp.into());
        let printed = if screen_px {
            BitBlt(mem, 0, 0, w, h, Some(screen), r.left, r.top, SRCCOPY).is_ok()
        } else {
            PrintWindow(hw, mem, PRINT_WINDOW_FLAGS(2)).as_bool()
        };
        let mut bi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: -h,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut buf = vec![0u8; (w.max(0) * h.max(0) * 4) as usize];
        let lines = GetDIBits(mem, bmp, 0, h as u32, Some(buf.as_mut_ptr() as *mut _), &mut bi, DIB_RGB_COLORS);
        SelectObject(mem, old);
        let _ = DeleteObject(bmp.into());
        let _ = DeleteDC(mem);
        ReleaseDC(None, screen);
        if !printed || lines != h {
            return Err(("capture_failed", format!("PrintWindow {printed}, {lines}/{h} lines")));
        }
        // GDI leaves the alpha byte undefined (often 0): make every pixel opaque so viewers do not show it as clear.
        for px in buf.chunks_exact_mut(4) {
            px[3] = 255;
        }
        (w, h, buf)
    };
    let mut file = Vec::with_capacity(54 + pixels.len());
    let size = 54 + pixels.len() as u32;
    file.extend_from_slice(b"BM");
    file.extend_from_slice(&size.to_le_bytes());
    file.extend_from_slice(&[0, 0, 0, 0]);
    file.extend_from_slice(&54u32.to_le_bytes());
    file.extend_from_slice(&40u32.to_le_bytes());
    file.extend_from_slice(&w.to_le_bytes());
    file.extend_from_slice(&(-h).to_le_bytes());
    file.extend_from_slice(&1u16.to_le_bytes());
    file.extend_from_slice(&32u16.to_le_bytes());
    file.extend_from_slice(&[0u8; 24]);
    file.extend_from_slice(&pixels);
    if let Some(dir) = out.parent() {
        std::fs::create_dir_all(dir).map_err(|e| ("capture_failed", e.to_string()))?;
    }
    std::fs::write(out, &file).map_err(|e| ("capture_failed", e.to_string()))?;
    Ok(json!({ "out": out, "w": w, "h": h }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Another registration of the same chord (here: on a thread of this test process) makes `arm` refuse with
    /// no_hotkey; once it is released, `arm` registers; without an audit log it refuses no_audit; with one it arms.
    #[test]
    fn arm_needs_the_hotkey_and_an_audit_log() {
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        let (held_tx, held_rx) = std::sync::mpsc::channel::<bool>();
        let holder = std::thread::spawn(move || {
            // SAFETY: registers and unregisters on this thread only.
            unsafe {
                let ok = RegisterHotKey(None, 7, MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, VK_CANCEL.0 as u32).is_ok();
                let _ = held_tx.send(ok);
                let _ = rx.recv();
                let _ = UnregisterHotKey(None, 7);
            }
        });
        let audit = std::env::temp_dir().join(format!("zumi-hands-arm-test-{}.jsonl", std::process::id()));
        assert!(held_rx.recv().unwrap(), "test could take the chord first");
        assert_eq!(arm(1000, None, None, Some(&audit)).unwrap_err().0, "no_hotkey");
        tx.send(()).unwrap();
        holder.join().unwrap();
        assert_eq!(arm(1000, None, None, None).unwrap_err().0, "no_audit", "no audit log, no arming");
        assert!(arm(1000, None, None, Some(&audit)).is_ok(), "arms with the chord free and a log");
        assert_eq!(status()["hotkey_registered"], json!(true));
        // A kill by the hotkey (the form the physical keys produce) is one audit line of its own (review S4). Runs
        // last: the kill lasts for the life of this test process.
        crate::kill::kill("cancel");
        let log = std::fs::read_to_string(&audit).unwrap();
        let kills: Vec<Value> = log.lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()).filter(|l| l["verb"] == "kill").collect();
        assert_eq!(kills.len(), 1, "one kill line: {log}");
        assert!(kills[0]["detail"].as_str().unwrap_or("").contains("\"by\":\"cancel\""), "{}", kills[0]);
        assert_eq!(gate().unwrap_err().0, "killed");
        let _ = std::fs::remove_file(&audit);
    }
}
