// T-31 node-bundle option (c): the installer ships WITHOUT node.exe. The sidecar's Node comes from, in order:
//   1. a compatible system Node (PATH, version >= MIN_MAJOR);
//   2. the per-user provisioned runtime `<local app data>/runtime/node-v<PINNED_VERSION>/node.exe`;
//   3. otherwise the host asks the user (consent), downloads the pinned official zip from nodejs.org, checks its
//      sha256 against BOTH the pin below and nodejs.org's SHASUMS256.txt (fail closed), extracts it into the per-user
//      directory (no admin) and uses that.
// Everything pure (version parsing, hash checks, path choice, the provisioning order) is unit-tested with fixtures;
// the real network/archive steps sit behind two small function parameters so tests never touch the network.
use std::path::{Path, PathBuf};

/// The Node release downloaded when no usable runtime exists. Same version the Electron build and the old bundle used.
pub(crate) const PINNED_VERSION: &str = "24.14.0";
/// File name of the pinned official Windows x64 archive.
pub(crate) const PINNED_ZIP: &str = "node-v24.14.0-win-x64.zip";
/// sha256 of `PINNED_ZIP`, from https://nodejs.org/dist/v24.14.0/SHASUMS256.txt. Pinned in code so a tampered
/// SHASUMS256.txt cannot approve a different archive. Provenance: the `node-v24.14.0-win-x64.zip` line of that file
/// was fetched over https on 2026-10-24 and equals this value (re-check on every pin bump).
pub(crate) const PINNED_ZIP_SHA256: &str = "313fa40c0d7b18575821de8cb17483031fe07d95de5994f6f435f3b345f85c66";
/// Oldest Node major accepted from the system (22 = oldest maintained LTS; the voice stack ships
/// N-API bindings (napi-v3), which are ABI-stable across majors).
pub(crate) const MIN_MAJOR: u64 = 22;

const DIST_BASE: &str = "https://nodejs.org/dist";

/// Why a runtime could not be provided. `Display` is the user-facing text (a stable `node_runtime_*` code first).
#[derive(Debug, PartialEq)]
pub(crate) enum RuntimeError {
    Declined,
    Download(String),
    HashMismatch { expected: String, got: String },
    NotInShasums,
    Extract(String),
    #[allow(dead_code)] // only constructed off Windows
    Unsupported,
}

impl std::fmt::Display for RuntimeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RuntimeError::Declined => write!(
                f,
                "node_runtime_declined: Zumi needs Node.js {MIN_MAJOR} or newer to run its local services. Install Node.js from nodejs.org, or restart Zumi and allow the download."
            ),
            RuntimeError::Download(why) => write!(
                f,
                "node_runtime_download_failed: could not download Node.js {PINNED_VERSION} from nodejs.org (check your internet connection and retry): {why}"
            ),
            RuntimeError::HashMismatch { expected, got } => write!(
                f,
                "node_runtime_hash_mismatch: the downloaded Node.js archive did not match its published checksum and was discarded (expected {expected}, got {got})"
            ),
            RuntimeError::NotInShasums => write!(
                f,
                "node_runtime_hash_mismatch: nodejs.org's checksum list has no entry for {PINNED_ZIP}; the download was discarded"
            ),
            RuntimeError::Extract(why) => write!(f, "node_runtime_extract_failed: could not unpack Node.js: {why}"),
            RuntimeError::Unsupported => write!(
                f,
                "node_runtime_unsupported: automatic Node.js setup is only available on Windows; install Node.js {MIN_MAJOR}+ yourself"
            ),
        }
    }
}

/// `v24.14.0` / `24.14.0\r\n` -> (24, 14, 0). Anything else (pre-release suffix included) is `None`.
pub(crate) fn parse_version(text: &str) -> Option<(u64, u64, u64)> {
    let mut parts = text.trim().trim_start_matches('v').split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((major, minor, patch))
}

pub(crate) fn is_compatible(version_text: &str) -> bool {
    parse_version(version_text).is_some_and(|(major, _, _)| major >= MIN_MAJOR)
}

/// The expected hash for `file_name` in a SHASUMS256.txt body (`<64 hex>  <name>` lines).
pub(crate) fn shasums_entry(shasums: &str, file_name: &str) -> Option<String> {
    shasums.lines().find_map(|line| {
        let (hash, name) = line.split_once(char::is_whitespace)?;
        let name = name.trim().trim_start_matches('*');
        (name == file_name && hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit())).then(|| hash.to_ascii_lowercase())
    })
}

pub(crate) fn sha256_file(path: &Path) -> std::io::Result<String> {
    use sha2::{Digest, Sha256};
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher)?;
    Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// Fail closed: the archive's sha256 must equal `pin` AND the SHASUMS256.txt entry for `PINNED_ZIP`.
fn verify_archive(archive: &Path, shasums: &str, pin: &str) -> Result<(), RuntimeError> {
    let got = sha256_file(archive).map_err(|e| RuntimeError::Download(format!("cannot read the archive: {e}")))?;
    if got != pin {
        return Err(RuntimeError::HashMismatch { expected: pin.to_string(), got });
    }
    match shasums_entry(shasums, PINNED_ZIP) {
        None => Err(RuntimeError::NotInShasums),
        Some(listed) if listed != got => Err(RuntimeError::HashMismatch { expected: listed, got }),
        Some(_) => Ok(()),
    }
}

/// `<local app data>/runtime/node-v<ver>`: per user, never admin-only, never inside the install dir.
pub(crate) fn runtime_dir(local_data: &Path) -> PathBuf {
    local_data.join("runtime").join(format!("node-v{PINNED_VERSION}"))
}

const NODE_FILE: &str = if cfg!(windows) { "node.exe" } else { "node" };

pub(crate) fn runtime_node_exe(local_data: &Path) -> PathBuf {
    runtime_dir(local_data).join(NODE_FILE)
}

/// First compatible `node` among `dirs` (PATH order). `probe` returns the `-v` output of a candidate. Relative or
/// empty PATH entries (`.`, `""`, an unexpanded `%VAR%`) are skipped: they would resolve against the cwd.
pub(crate) fn find_system_node(dirs: &[PathBuf], probe: &dyn Fn(&Path) -> Option<String>) -> Option<PathBuf> {
    dirs.iter()
        .filter(|d| d.is_absolute())
        .map(|d| d.join(NODE_FILE))
        .filter(|p| p.is_file())
        .find(|p| probe(p).is_some_and(|v| is_compatible(&v)))
}

/// Child processes of this module must never open a console window (the release host has no console of its own).
fn no_window(cmd: &mut std::process::Command) -> &mut std::process::Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// The only way this module starts a child: no console window, and the child (with everything it spawns) goes into the
/// host's kill-on-close job, so a host exit (a user quit mid-download, a guard failure) never leaves a `node -v` probe,
/// curl.exe or tar.exe running. The assign happens right after the spawn; best-effort like the sidecar's.
fn spawn_in_job(cmd: &mut std::process::Command) -> std::io::Result<std::process::Child> {
    let child = no_window(cmd).spawn()?;
    crate::assign_to_job(child.id());
    Ok(child)
}

/// The update E2E's stubborn job member: waits on a stdin the caller keeps open. Compiled only with the off-by-default feature.
#[cfg(all(windows, feature = "update-e2e"))]
pub(crate) fn spawn_e2e_hold(exe: &std::path::Path) -> std::io::Result<std::process::Child> {
    let mut cmd = std::process::Command::new(exe);
    cmd.arg("protect").stdin(std::process::Stdio::piped());
    spawn_in_job(&mut cmd)
}

/// `Command::output()` for a child that is placed in the job (see `spawn_in_job`).
#[cfg(windows)]
fn output_in_job(cmd: &mut std::process::Command) -> std::io::Result<std::process::Output> {
    cmd.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    spawn_in_job(cmd)?.wait_with_output()
}

const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// Run `<node> -v`, killed after `PROBE_TIMEOUT` so a hung shim on PATH cannot freeze startup.
pub(crate) fn probe_version(node: &Path) -> Option<String> {
    match probe_once(node, PROBE_TIMEOUT) {
        Probe::TimedOut => match probe_once(node, PROBE_RETRY_TIMEOUT) {
            Probe::Done(v) => v,
            Probe::TimedOut => None,
        },
        Probe::Done(v) => v,
    }
}

/// A fresh node.exe can take longer than `PROBE_TIMEOUT` the first time (Defender scans it), so a timeout gets one
/// patient retry instead of being treated as "no runtime" (which would re-download).
const PROBE_RETRY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(25);

enum Probe {
    Done(Option<String>),
    TimedOut,
}

fn probe_once(node: &Path, timeout: std::time::Duration) -> Probe {
    use std::io::Read;
    let mut cmd = std::process::Command::new(node);
    cmd.arg("-v").stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null());
    let Ok(mut child) = spawn_in_job(&mut cmd) else { return Probe::Done(None) };
    let deadline = std::time::Instant::now() + timeout;
    let status = loop {
        let waited = match child.try_wait() {
            Err(_) => return Probe::Done(None),
            Ok(w) => w,
        };
        match waited {
            Some(status) => break status,
            None if std::time::Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Probe::TimedOut;
            }
            None => std::thread::sleep(std::time::Duration::from_millis(25)),
        }
    };
    let mut text = String::new();
    let read_ok = child.stdout.take().is_some_and(|mut o| o.read_to_string(&mut text).is_ok());
    Probe::Done((read_ok && status.success()).then(|| text.trim().to_string()))
}

pub(crate) fn path_dirs() -> Vec<PathBuf> {
    std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default()
}

/// The runtime to use WITHOUT any prompt or network: a compatible system Node, else the provisioned one when it still
/// reports the pinned version. `None` means provisioning is needed.
pub(crate) fn find_existing(
    local_data: Option<&Path>,
    dirs: &[PathBuf],
    probe: &dyn Fn(&Path) -> Option<String>,
) -> Option<PathBuf> {
    if let Some(system) = find_system_node(dirs, probe) {
        return Some(system);
    }
    let provisioned = runtime_node_exe(local_data?);
    (provisioned.is_file() && probe(&provisioned).and_then(|v| parse_version(&v)) == parse_version(PINNED_VERSION))
        .then_some(provisioned)
}

/// Exclusive install lock on `runtime/.provision.lock`. On Windows the file is held open with `share_mode(0)` for the
/// whole critical section, so the OS frees it the moment the holder exits or crashes: no stale-lock logic, no PID. The
/// file itself is never deleted (deleting would race another waiter). A waiter gives up with a clear error after `wait`.
struct InstallLock(#[allow(dead_code)] std::fs::File);

#[derive(Clone, Copy)]
struct LockTiming {
    wait: std::time::Duration,
}

/// Long enough for a normal download by the other window, short enough that nobody stares at nothing for half an hour.
const LOCK_TIMING: LockTiming = LockTiming { wait: std::time::Duration::from_secs(3 * 60) };

impl InstallLock {
    fn acquire(path: &Path, timing: LockTiming) -> Result<InstallLock, RuntimeError> {
        let started = std::time::Instant::now();
        loop {
            let mut opts = std::fs::OpenOptions::new();
            opts.write(true).create(true).truncate(false);
            #[cfg(windows)]
            {
                use std::os::windows::fs::OpenOptionsExt;
                opts.share_mode(0);
            }
            match opts.open(path) {
                Ok(file) => return Ok(InstallLock(file)),
                // 32 = ERROR_SHARING_VIOLATION (held by a live holder); 5 = access denied while it is being torn down
                Err(e) if matches!(e.raw_os_error(), Some(32) | Some(5)) || e.kind() == std::io::ErrorKind::PermissionDenied => {
                    if started.elapsed() > timing.wait {
                        return Err(RuntimeError::Extract(
                            "another Zumi window is still setting up Node.js; wait for it to finish, then restart Zumi".into(),
                        ));
                    }
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
                Err(e) => return Err(RuntimeError::Extract(format!("cannot take the install lock: {e}"))),
            }
        }
    }
}

/// Lock, re-check, ask, download, verify, extract. `existing()` is re-run under the lock so a second instance reuses
/// what the first installed. `fetch(url, dest)` and `extract(zip, dest_dir)` are the only side effects besides file
/// moves, so tests pass fixtures. Nothing is fetched if `consent()` says no.
fn provision_with(
    local_data: &Path,
    pin: &str,
    lock_timing: LockTiming,
    existing: &dyn Fn() -> Option<PathBuf>,
    consent: &dyn Fn() -> bool,
    fetch: &dyn Fn(&str, &Path) -> Result<(), String>,
    extract: &dyn Fn(&Path, &Path) -> Result<(), String>,
) -> Result<PathBuf, RuntimeError> {
    let runtime_parent = local_data.join("runtime");
    std::fs::create_dir_all(&runtime_parent).map_err(|e| RuntimeError::Extract(e.to_string()))?;
    let _lock = InstallLock::acquire(&runtime_parent.join(".provision.lock"), lock_timing)?;
    if let Some(found) = existing() {
        return Ok(found);
    }
    if !consent() {
        return Err(RuntimeError::Declined);
    }
    // Under the lock no other installer is alive: every `.download-*` dir is a leftover of a crashed run.
    if let Ok(entries) = std::fs::read_dir(&runtime_parent) {
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy().starts_with(".download-") {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }
    let final_dir = runtime_dir(local_data);
    let work = runtime_parent.join(format!(".download-{}", std::process::id()));
    std::fs::create_dir_all(&work).map_err(|e| RuntimeError::Extract(e.to_string()))?;
    let result = (|| {
        let zip = work.join(PINNED_ZIP);
        let shasums_path = work.join("SHASUMS256.txt");
        fetch(&format!("{DIST_BASE}/v{PINNED_VERSION}/{PINNED_ZIP}"), &zip).map_err(RuntimeError::Download)?;
        fetch(&format!("{DIST_BASE}/v{PINNED_VERSION}/SHASUMS256.txt"), &shasums_path).map_err(RuntimeError::Download)?;
        let shasums = std::fs::read_to_string(&shasums_path).map_err(|e| RuntimeError::Download(e.to_string()))?;
        verify_archive(&zip, &shasums, pin)?;
        let unpacked = work.join("unpacked");
        extract(&zip, &unpacked).map_err(RuntimeError::Extract)?;
        let inner = unpacked.join(PINNED_ZIP.trim_end_matches(".zip"));
        if !inner.join(NODE_FILE).is_file() {
            return Err(RuntimeError::Extract("the archive has no node executable at its expected path".into()));
        }
        // `existing()` found no valid runtime under the lock, so whatever is at `final_dir` is a broken leftover.
        let _ = std::fs::remove_dir_all(&final_dir);
        std::fs::rename(&inner, &final_dir).map_err(|e| RuntimeError::Extract(e.to_string()))?;
        Ok(runtime_node_exe(local_data))
    })();
    let _ = std::fs::remove_dir_all(&work);
    result
}

/// Real fetch: Windows' own `curl.exe` (System32, Windows 10 1803+), https only, redirects limited, fail on HTTP errors.
#[cfg(windows)]
fn curl_fetch(url: &str, dest: &Path) -> Result<(), String> {
    let mut cmd = std::process::Command::new(system32("curl.exe"));
    cmd.args([
        "--fail", "--silent", "--show-error", "--location", "--max-redirs", "3", "--proto", "=https", "--proto-redir", "=https",
        "--connect-timeout", "20", "--max-time", "900", "-o",
    ])
    .arg(dest)
    .arg(url);
    let out = output_in_job(&mut cmd).map_err(|e| format!("curl.exe not runnable: {e}"))?;
    if out.status.success() { Ok(()) } else { Err(String::from_utf8_lossy(&out.stderr).trim().to_string()) }
}

/// Real extract: Windows' bsdtar (System32\tar.exe) reads zip and refuses `..` escapes by default.
#[cfg(windows)]
fn tar_extract(zip: &Path, dest: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    let mut cmd = std::process::Command::new(system32("tar.exe"));
    cmd.arg("-xf").arg(zip).arg("-C").arg(dest);
    let out = output_in_job(&mut cmd).map_err(|e| format!("tar.exe not runnable: {e}"))?;
    if out.status.success() { Ok(()) } else { Err(String::from_utf8_lossy(&out.stderr).trim().to_string()) }
}

#[cfg(windows)]
fn system32(exe: &str) -> PathBuf {
    PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into())).join("System32").join(exe)
}

/// Bytes of the Node archive on disk while it downloads; None before the first byte and after the work folder is gone. For the first-run progress line.
pub(crate) fn download_progress(local_data: &Path) -> Option<u64> {
    std::fs::read_dir(local_data.join("runtime")).ok()?.flatten().find_map(|entry| {
        let is_work = entry.file_name().to_string_lossy().starts_with(".download-");
        if !is_work {
            return None;
        }
        std::fs::metadata(entry.path().join(PINNED_ZIP)).ok().map(|m| m.len())
    })
}

/// Native Yes/No box (the app window may not be usable yet). Default button is No.
#[cfg(windows)]
fn ask_consent() -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, IDYES, MB_DEFBUTTON2, MB_ICONQUESTION, MB_TOPMOST, MB_YESNO};
    let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let text = wide(&format!(
        "Zumi cần Node.js để chạy các dịch vụ trên máy này, và máy chưa có bản phù hợp (từ {MIN_MAJOR} trở lên).\n\nTải Node.js {PINNED_VERSION} (khoảng 35 MB) từ nodejs.org ngay bây giờ? Bản tải được đối chiếu với mã kiểm tra công bố và chỉ cài cho tài khoản Windows này. Không có Node.js thì Zumi chưa chạy được.\n\n----\n\nZumi needs Node.js to run its local services, and no compatible Node.js ({MIN_MAJOR} or newer) was found.\n\nDownload Node.js {PINNED_VERSION} (about 35 MB) from nodejs.org now? It is checked against its published checksum and installed only for your Windows account. Zumi cannot run without it."
    ));
    let title = wide("Zumi - cần Node.js / Node.js required");
    // SAFETY: both buffers are NUL-terminated and live across the call; a null owner window is allowed.
    unsafe {
        MessageBoxW(std::ptr::null_mut(), text.as_ptr(), title.as_ptr(), MB_YESNO | MB_ICONQUESTION | MB_DEFBUTTON2 | MB_TOPMOST)
            == IDYES
    }
}

/// Full interactive provisioning with the real dialog, network and archive tools.
#[cfg(windows)]
pub(crate) fn provision_interactive(local_data: &Path) -> Result<PathBuf, RuntimeError> {
    let existing = || find_existing(Some(local_data), &path_dirs(), &probe_version);
    provision_with(local_data, PINNED_ZIP_SHA256, LOCK_TIMING, &existing, &ask_consent, &curl_fetch, &tar_extract)
}

#[cfg(not(windows))]
pub(crate) fn provision_interactive(_local_data: &Path) -> Result<PathBuf, RuntimeError> {
    Err(RuntimeError::Unsupported)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::time::Duration;

    #[cfg(windows)]
    #[test]
    fn a_provisioning_child_runs_inside_the_kill_on_close_job() {
        let mut cmd = std::process::Command::new(system32("cmd.exe"));
        cmd.args(["/c", "ping", "-n", "30", "127.0.0.1"]);
        let mut child = spawn_in_job(&mut cmd).expect("spawn");
        let job = crate::ensure_job().expect("job");
        let inside = crate::winjob::contains_pid(job, child.id());
        let _ = child.kill();
        let _ = child.wait();
        assert!(inside, "a host exit would leave this child running");
        // curl.exe / tar.exe take the same path through output_in_job.
        let mut quick = std::process::Command::new(system32("cmd.exe"));
        quick.args(["/c", "exit", "0"]);
        assert!(output_in_job(&mut quick).expect("output").status.success());
    }

    const FAST: LockTiming = LockTiming { wait: Duration::from_secs(20) };

    fn scratch(name: &str) -> PathBuf {
        let base = std::env::var_os("ZUMI_TEST_SCRATCH").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
        let dir = base.join(format!("zumi-node-runtime-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn versions_parse_with_or_without_v_and_reject_junk() {
        assert_eq!(parse_version("v24.14.0\r\n"), Some((24, 14, 0)));
        assert_eq!(parse_version("22.1.3"), Some((22, 1, 3)));
        assert_eq!(parse_version("v24.14"), None);
        assert_eq!(parse_version("v24.14.0-nightly"), None);
        assert_eq!(parse_version("v1.2.3.4"), None);
        assert_eq!(parse_version(""), None);
    }

    #[test]
    fn compatibility_is_a_major_floor() {
        assert!(is_compatible("v22.0.0") && is_compatible("v24.14.0") && is_compatible("v26.1.0"));
        assert!(!is_compatible("v20.19.0") && !is_compatible("v21.7.3") && !is_compatible("garbage"));
    }

    #[test]
    fn the_node_22_floor_is_exercised_at_its_edges() {
        for v in ["v21.7.3", "v21.99.99", "v20.19.0"] {
            assert!(!is_compatible(v), "{v} must be rejected");
        }
        for v in ["v22.0.0", "22.0.0\r\n", "v22.11.0"] {
            assert!(is_compatible(v), "{v} must be accepted");
        }
        let dir = scratch("floor");
        let (low, edge) = (dir.join("low"), dir.join("edge"));
        for d in [&low, &edge] {
            std::fs::create_dir_all(d).unwrap();
            std::fs::write(d.join(NODE_FILE), b"x").unwrap();
        }
        let probe = |p: &Path| Some(if p.starts_with(&low) { "v21.9.9".to_string() } else { "v22.0.0".to_string() });
        assert_eq!(find_system_node(&[low.clone(), edge.clone()], &probe), Some(edge.join(NODE_FILE)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn relative_and_empty_path_entries_are_never_probed() {
        // a real node file reachable through a cwd-relative entry (a unique dir under the test cwd, removed below)
        let rel_dir = PathBuf::from(format!("zumi-rel-test-{}", std::process::id()));
        std::fs::create_dir_all(&rel_dir).unwrap();
        std::fs::write(rel_dir.join(NODE_FILE), b"x").unwrap();
        assert!(rel_dir.join(NODE_FILE).is_file());
        let probe = |p: &Path| -> Option<String> { panic!("must not probe {p:?}") };
        let rel = [rel_dir.clone(), PathBuf::from("."), PathBuf::from(""), PathBuf::from("%NVM_HOME%")];
        let found = find_system_node(&rel, &probe);
        let _ = std::fs::remove_dir_all(&rel_dir);
        assert_eq!(found, None);
    }

    #[test]
    fn the_pin_is_consistent() {
        assert_eq!(PINNED_ZIP, format!("node-v{PINNED_VERSION}-win-x64.zip"));
        assert_eq!(PINNED_ZIP_SHA256.len(), 64);
        assert!(is_compatible(PINNED_VERSION));
    }

    #[test]
    fn shasums_lookup_finds_the_exact_name_only() {
        let body = format!("{}  node-v24.14.0-win-arm64.zip\n{PINNED_ZIP_SHA256}  {PINNED_ZIP}\nbad  {PINNED_ZIP}.sig\n", "a".repeat(64));
        assert_eq!(shasums_entry(&body, PINNED_ZIP).as_deref(), Some(PINNED_ZIP_SHA256));
        assert_eq!(shasums_entry(&body, "node-v24.14.0-linux-x64.tar.gz"), None);
        assert_eq!(shasums_entry("short  node.zip", "node.zip"), None);
    }

    #[test]
    fn sha256_matches_a_known_vector() {
        let dir = scratch("sha");
        let f = dir.join("abc");
        std::fs::write(&f, b"abc").unwrap();
        assert_eq!(sha256_file(&f).unwrap(), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn verification_fails_closed_on_every_mismatch() {
        let dir = scratch("verify");
        let zip = dir.join(PINNED_ZIP);
        std::fs::write(&zip, b"fixture archive").unwrap();
        let got = sha256_file(&zip).unwrap();
        let listed = format!("{got}  {PINNED_ZIP}\n");
        // pin and SHASUMS both agree -> ok
        assert_eq!(verify_archive(&zip, &listed, &got), Ok(()));
        // the code pin differs even though SHASUMS agrees with the file -> refused
        assert!(matches!(verify_archive(&zip, &listed, PINNED_ZIP_SHA256), Err(RuntimeError::HashMismatch { .. })));
        // SHASUMS lists another hash, or no entry -> refused
        let other = format!("{}  {PINNED_ZIP}\n", "b".repeat(64));
        assert!(matches!(verify_archive(&zip, &other, &got), Err(RuntimeError::HashMismatch { .. })));
        assert_eq!(verify_archive(&zip, "", &got), Err(RuntimeError::NotInShasums));
        assert!(matches!(verify_archive(&dir.join("missing.zip"), &listed, &got), Err(RuntimeError::Download(_))));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn path_selection_prefers_a_compatible_system_node_then_the_provisioned_one() {
        let dir = scratch("select");
        let (old, new) = (dir.join("old"), dir.join("new"));
        for d in [&old, &new] {
            std::fs::create_dir_all(d).unwrap();
            std::fs::write(d.join(NODE_FILE), b"x").unwrap();
        }
        let probe = |p: &Path| Some(if p.starts_with(&old) { "v20.1.0".to_string() } else { "v24.0.0".to_string() });
        assert_eq!(find_existing(None, &[old.clone(), new.clone()], &probe), Some(new.join(NODE_FILE)));
        assert_eq!(find_existing(Some(&dir), &[old.clone()], &probe), None);
        let local = dir.join("local");
        std::fs::create_dir_all(runtime_dir(&local)).unwrap();
        std::fs::write(runtime_node_exe(&local), b"x").unwrap();
        let pinned_probe = |p: &Path| Some(if p.starts_with(&old) { "v20.1.0".to_string() } else { format!("v{PINNED_VERSION}") });
        assert_eq!(find_existing(Some(&local), &[old.clone()], &pinned_probe), Some(runtime_node_exe(&local)));
        let other = |_: &Path| Some("v23.0.0".to_string());
        assert_eq!(find_existing(Some(&local), &[], &other), None, "a provisioned runtime of another version is not used");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn runtime_dir_is_under_the_per_user_data_dir() {
        let got = runtime_dir(Path::new("L")).to_string_lossy().replace('\\', "/");
        assert_eq!(got, format!("L/runtime/node-v{PINNED_VERSION}"));
    }

    #[test]
    fn declining_fetches_nothing_and_writes_nothing() {
        let dir = scratch("decline");
        let fetched = Cell::new(false);
        let fetch = |_: &str, _: &Path| {
            fetched.set(true);
            Ok(())
        };
        assert_eq!(provision_with(&dir, PINNED_ZIP_SHA256, FAST, &|| None, &|| false, &fetch, &|_, _| Ok(())), Err(RuntimeError::Declined));
        assert!(!fetched.get());
        assert!(runtime_entries(&dir.join("runtime")).is_empty(), "no work dir or runtime is left behind");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn offline_and_tampered_downloads_are_refused_and_cleaned_up() {
        let dir = scratch("refuse");
        let offline = provision_with(&dir, PINNED_ZIP_SHA256, FAST, &|| None, &|| true, &|_, _| Err("could not resolve host".into()), &|_, _| Ok(()));
        assert!(matches!(offline, Err(RuntimeError::Download(_))));
        let tampered = provision_with(
            &dir,
            PINNED_ZIP_SHA256,
            FAST,
            &|| None,
            &|| true,
            &|url, dest| std::fs::write(dest, if url.ends_with(".zip") { &b"evil"[..] } else { &b"x"[..] }).map_err(|e| e.to_string()),
            &|_, _| panic!("a refused archive must never be extracted"),
        );
        assert!(matches!(tampered, Err(RuntimeError::HashMismatch { .. })));
        assert!(!runtime_dir(&dir).exists());
        assert!(runtime_entries(&dir.join("runtime")).is_empty(), "the download work dir is removed on failure");
        for e in [RuntimeError::Declined, RuntimeError::NotInShasums, RuntimeError::Download("x".into())] {
            assert!(e.to_string().starts_with("node_runtime_"));
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_verified_fixture_archive_is_installed_in_the_per_user_dir() {
        let dir = scratch("install");
        let payload = b"fixture zip bytes";
        let hash = {
            let f = dir.join("p");
            std::fs::write(&f, payload).unwrap();
            sha256_file(&f).unwrap()
        };
        let shasums = format!("{hash}  {PINNED_ZIP}\n");
        let fetch = |url: &str, dest: &Path| {
            std::fs::write(dest, if url.ends_with(".zip") { payload.to_vec() } else { shasums.clone().into_bytes() }).map_err(|e| e.to_string())
        };
        let extract = |_zip: &Path, to: &Path| {
            let inner = to.join(PINNED_ZIP.trim_end_matches(".zip"));
            std::fs::create_dir_all(&inner).map_err(|e| e.to_string())?;
            std::fs::write(inner.join(NODE_FILE), b"fake node").map_err(|e| e.to_string())
        };
        let local = dir.join("local");
        let node = provision_with(&local, &hash, FAST, &|| None, &|| true, &fetch, &extract).unwrap();
        assert_eq!(node, runtime_node_exe(&local));
        assert!(node.is_file());
        assert_eq!(runtime_entries(&local.join("runtime")).len(), 1, "only the final dir remains");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// fixture fetch/extract pair that "installs" a fake node, counting archive downloads
    fn fixture_installer(
        hash: String,
        zip_fetches: &std::sync::atomic::AtomicUsize,
    ) -> (impl Fn(&str, &Path) -> Result<(), String> + '_, impl Fn(&Path, &Path) -> Result<(), String>) {
        let fetch = move |url: &str, dest: &Path| {
            if url.ends_with(".zip") {
                zip_fetches.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(150)); // widen the race window
                std::fs::write(dest, b"fixture zip bytes").map_err(|e| e.to_string())
            } else {
                std::fs::write(dest, format!("{hash}  {PINNED_ZIP}\n")).map_err(|e| e.to_string())
            }
        };
        let extract = |_zip: &Path, to: &Path| {
            let inner = to.join(PINNED_ZIP.trim_end_matches(".zip"));
            std::fs::create_dir_all(&inner).map_err(|e| e.to_string())?;
            std::fs::write(inner.join(NODE_FILE), b"fake node").map_err(|e| e.to_string())
        };
        (fetch, extract)
    }

    /// entries of the runtime parent except the persistent lock file
    fn runtime_entries(parent: &Path) -> Vec<String> {
        let all = std::fs::read_dir(parent).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned());
        all.filter(|n| n != ".provision.lock").collect()
    }

    fn fixture_hash(dir: &Path) -> String {
        let f = dir.join("hash-src");
        std::fs::write(&f, b"fixture zip bytes").unwrap();
        sha256_file(&f).unwrap()
    }

    #[test]
    fn two_concurrent_first_launches_install_once_and_both_get_a_working_runtime() {
        let dir = scratch("race");
        let local = dir.join("local");
        let hash = fixture_hash(&dir);
        let zip_fetches = std::sync::atomic::AtomicUsize::new(0);
        let (fetch, extract) = fixture_installer(hash.clone(), &zip_fetches);
        // the "probe": a runtime counts as valid once its exe exists (as find_existing would after a real probe)
        let existing = || runtime_node_exe(&local).is_file().then(|| runtime_node_exe(&local));
        let results: Vec<_> = std::thread::scope(|s| {
            let handles: Vec<_> = (0..2)
                .map(|_| s.spawn(|| provision_with(&local, &hash, FAST, &existing, &|| true, &fetch, &extract)))
                .collect();
            handles.into_iter().map(|h| h.join().unwrap()).collect()
        });
        for r in &results {
            assert_eq!(r.as_ref().unwrap(), &runtime_node_exe(&local));
        }
        assert_eq!(zip_fetches.load(std::sync::atomic::Ordering::SeqCst), 1, "the second launch reuses the first one's runtime");
        assert!(runtime_node_exe(&local).is_file(), "the installed runtime was not deleted by the second launch");
        assert!(InstallLock::acquire(&local.join("runtime").join(".provision.lock"), FAST).is_ok(), "the lock is released");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_runtime_that_appears_while_waiting_for_the_lock_is_used_without_asking() {
        let dir = scratch("recheck");
        let local = dir.join("local");
        std::fs::create_dir_all(runtime_dir(&local)).unwrap();
        std::fs::write(runtime_node_exe(&local), b"x").unwrap();
        let existing = || Some(runtime_node_exe(&local));
        let got = provision_with(&local, PINNED_ZIP_SHA256, FAST, &existing, &|| panic!("no consent dialog"), &|_, _| panic!("no fetch"), &|_, _| panic!("no extract"));
        assert_eq!(got, Ok(runtime_node_exe(&local)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unheld_lock_file_and_stale_download_dirs_from_a_crashed_run_are_cleaned_up() {
        let dir = scratch("stale");
        let local = dir.join("local");
        let parent = local.join("runtime");
        std::fs::create_dir_all(parent.join(".download-99999").join("unpacked")).unwrap();
        std::fs::write(parent.join(".download-99999").join("junk.zip"), b"x").unwrap();
        std::fs::write(parent.join(".provision.lock"), b"99999").unwrap();
        let hash = fixture_hash(&dir);
        let zip_fetches = std::sync::atomic::AtomicUsize::new(0);
        let (fetch, extract) = fixture_installer(hash.clone(), &zip_fetches);
        let node = provision_with(&local, &hash, FAST, &|| None, &|| true, &fetch, &extract).unwrap();
        assert!(node.is_file());
        assert!(!parent.join(".download-99999").exists());
        let names = runtime_entries(&parent);
        assert_eq!(names, vec![format!("node-v{PINNED_VERSION}")]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_live_lock_times_out_instead_of_being_stolen() {
        let dir = scratch("locked");
        let local = dir.join("local");
        std::fs::create_dir_all(local.join("runtime")).unwrap();
        let holder = InstallLock::acquire(&local.join("runtime").join(".provision.lock"), FAST).unwrap();
        let timing = LockTiming { wait: Duration::from_millis(200) };
        let got = provision_with(&local, PINNED_ZIP_SHA256, timing, &|| None, &|| panic!("must not ask"), &|_, _| panic!("no fetch"), &|_, _| panic!("no extract"));
        assert!(matches!(got, Err(RuntimeError::Extract(_))));
        drop(holder);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_waiter_proceeds_promptly_when_the_holder_dies() {
        let dir = scratch("holder-dies");
        let path = dir.join(".provision.lock");
        let holder = InstallLock::acquire(&path, FAST).unwrap();
        // dropping the handle is what the OS does when the holder process exits or is killed
        let killer = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            drop(holder);
        });
        let t = std::time::Instant::now();
        assert!(InstallLock::acquire(&path, FAST).is_ok());
        assert!(t.elapsed() < Duration::from_secs(3), "waited {:?}", t.elapsed());
        killer.join().unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Network, run on demand: `cargo test --lib -- --ignored pin_matches_nodejs_org` (once per pin bump).
    #[test]
    #[ignore]
    fn pin_matches_nodejs_org() {
        let dir = scratch("pin-net");
        let dest = dir.join("SHASUMS256.txt");
        #[cfg(windows)]
        curl_fetch(&format!("{DIST_BASE}/v{PINNED_VERSION}/SHASUMS256.txt"), &dest).unwrap();
        #[cfg(not(windows))]
        assert!(std::process::Command::new("curl").args(["--fail", "-sSLo"]).arg(&dest).arg(format!("{DIST_BASE}/v{PINNED_VERSION}/SHASUMS256.txt")).status().unwrap().success());
        let body = std::fs::read_to_string(&dest).unwrap();
        assert_eq!(shasums_entry(&body, PINNED_ZIP).as_deref(), Some(PINNED_ZIP_SHA256));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
