//! The broker (roadmap 1.4 layer 2): every spawn, file access, connection and listener a pack helper wants crosses here. The helper
//! only asks; the host decides from the manifest scope and the user's grants (`scope::decide`), writes the audit line BEFORE it acts
//! (a line that cannot be written means the action does not happen), and then acts itself, so a helper has no `CreateProcess`, file or
//! socket call of its own to misuse (layer 1, by construction).
//!
//! A pack that is not registered (not accepted and enabled) has no door at all. `kill` ends everything a pack holds and closes the door.
use crate::audit::{PackAudit, Row};
use crate::job::Job;
use crate::manifest::Manifest;
use crate::scope::{decide, Action, Allowed, Env, Grants};
use serde_json::{json, Value};
use crate::proc::{Io, Level, PackProcess};
use std::path::Path;
use std::sync::{Arc, Mutex};
use zumi_audit::hostmac::sha256_hex;

/// The checks on an OPENED file: the path check alone can be raced (a folder swapped for a junction between check and use) and cannot see a
/// hard link (a second name of a host file inside a root).
mod handle {
    use super::Pack;
    use crate::scope::{decide, Action, Allowed};
    use std::fs::File;
    use std::path::{Path, PathBuf};

    /// Where the opened object really is (`GetFinalPathNameByHandleW`, normalized, `\\?\` stripped) and how many names it has.
    #[cfg(windows)]
    fn final_path_and_links(f: &File) -> Result<(PathBuf, u32), &'static str> {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::Foundation::HANDLE;
        use windows::Win32::Storage::FileSystem::{GetFileInformationByHandle, GetFinalPathNameByHandleW, BY_HANDLE_FILE_INFORMATION, FILE_NAME_NORMALIZED, GETFINALPATHNAMEBYHANDLE_FLAGS, VOLUME_NAME_DOS};
        let h = HANDLE(f.as_raw_handle());
        let mut buf = vec![0u16; 1024];
        // SAFETY: a valid open handle and a buffer of the stated length.
        let n = unsafe { GetFinalPathNameByHandleW(h, &mut buf, GETFINALPATHNAMEBYHANDLE_FLAGS(FILE_NAME_NORMALIZED.0 | VOLUME_NAME_DOS.0)) } as usize;
        if n == 0 || n >= buf.len() {
            return Err("path_unresolved");
        }
        let text = String::from_utf16(&buf[..n]).map_err(|_| "path_unresolved")?;
        let plain = match text.strip_prefix(r"\\?\") {
            Some(rest) if !rest.starts_with(r"UNC\") => rest.to_string(),
            _ => return Err("path_bad"), // a network path is never inside a root
        };
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        // SAFETY: a valid open handle and a correctly sized out struct.
        unsafe { GetFileInformationByHandle(h, &mut info) }.map_err(|_| "path_unresolved")?;
        Ok((PathBuf::from(plain), info.nNumberOfLinks))
    }

    #[cfg(not(windows))]
    fn final_path_and_links(_: &File) -> Result<(PathBuf, u32), &'static str> {
        Err("path_unresolved")
    }

    /// The opened object must be a file with ONE name, and that name must pass the same scope and protected-folder check again.
    pub fn recheck(f: &File, pack: &Pack, write: bool) -> Result<(), &'static str> {
        let (real, links) = final_path_and_links(f)?;
        if links != 1 {
            return Err("path_linked");
        }
        let action = if write { Action::Write { path: &real } } else { Action::Read { path: &real } };
        match decide(&pack.manifest, &pack.grants, &pack.env, &action) {
            Ok(Allowed::Path(_)) => Ok(()),
            Ok(_) => Err("scope_mismatch"),
            Err(code) => Err(code),
        }
    }

    /// Opens an existing file for writing without truncating it, or creates a new one (with delete access, so a refused new file can be
    /// removed through its handle). `true` = this call created it.
    pub fn open_for_write(p: &Path) -> std::io::Result<(File, bool)> {
        match std::fs::OpenOptions::new().write(true).open(p) {
            Ok(f) => Ok((f, false)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => create_new(p).map(|f| (f, true)),
            Err(e) => Err(e),
        }
    }

    #[cfg(windows)]
    fn create_new(p: &Path) -> std::io::Result<File> {
        use std::os::windows::fs::OpenOptionsExt;
        const GENERIC_READ_WRITE: u32 = 0x8000_0000 | 0x4000_0000;
        const DELETE: u32 = 0x0001_0000;
        std::fs::OpenOptions::new().write(true).create_new(true).access_mode(GENERIC_READ_WRITE | DELETE).open(p)
    }

    #[cfg(not(windows))]
    fn create_new(p: &Path) -> std::io::Result<File> {
        std::fs::OpenOptions::new().write(true).create_new(true).open(p)
    }

    /// Marks the file for deletion through its own handle (it goes when the handle closes).
    #[cfg(windows)]
    pub fn delete(f: &File) {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::Foundation::HANDLE;
        use windows::Win32::Storage::FileSystem::{FileDispositionInfo, SetFileInformationByHandle, FILE_DISPOSITION_INFO};
        let info = FILE_DISPOSITION_INFO { DeleteFile: true.into() };
        // SAFETY: a valid handle opened with DELETE access; the struct is the documented one for this class.
        let _ = unsafe { SetFileInformationByHandle(HANDLE(f.as_raw_handle()), FileDispositionInfo, &info as *const _ as *const _, std::mem::size_of::<FILE_DISPOSITION_INFO>() as u32) };
    }

    #[cfg(not(windows))]
    pub fn delete(_: &File) {}
}

/// The few variables a pack process gets from the host's environment (nothing else, so no key or token is inherited).
fn allowed_env(names: &[&str]) -> Vec<(String, std::ffi::OsString)> {
    names.iter().filter_map(|k| std::env::var_os(k).map(|v| (k.to_string(), v))).collect()
}

/// How contained a pack's helper is (R7c, re-gate R7b S-B), with the few variables it gets.
/// - Needs the user's desktop (`input.inject`): the user's own integrity. NOT contained: its own code can read the user's files, open
///   sockets and reach the user's secrets; only "Zumia wrote the helper" (layer 1) stands in for the broker there.
/// - `screen.capture`, `audio.capture`, `device.usb`: LOW integrity, as in R7b (it cannot write the user's files or act on the host's
///   windows). Not contained either: Low still reads files and opens sockets.
/// - Everything else: an AppContainer with no capability. It reads only the helper exe and its own data folder, has no network and cannot
///   read the audit key. If the container or its grants cannot be made, the helper does not start.
fn helper_level(pack: &Pack, exe: &Path) -> Result<(Level, Vec<(String, std::ffi::OsString)>), &'static str> {
    let has = |c: &str| pack.manifest.capability(c).is_some();
    if has("input.inject") {
        return Ok((Level::User, allowed_env(&["SystemRoot", "TEMP", "TMP"])));
    }
    if has("screen.capture") || has("audio.capture") || has("device.usb") {
        return Ok((Level::Low, allowed_env(&["SystemRoot", "TEMP", "TMP"])));
    }
    let name = crate::proc::container_name(&pack.manifest.id);
    let sid = crate::proc::container_sid(&name).map_err(|_| "contain_failed")?;
    crate::proc::grant(exe, &sid, "RX").map_err(|_| "contain_failed")?;
    crate::proc::grant(&pack.env.pack_data, &sid, "M").map_err(|_| "contain_failed")?;
    // The system needs these to make a container's environment; they point at the pack's own folder, never at the user's.
    let mut env = allowed_env(&["SystemRoot"]);
    env.extend(["LOCALAPPDATA", "APPDATA", "USERPROFILE", "TEMP", "TMP"].map(|k| (k.to_string(), pack.env.pack_data.clone().into_os_string())));
    Ok((Level::Box(name), env))
}

/// A file the broker reads or writes for a helper is at most this big.
pub const MAX_FILE_BYTES: usize = 1024 * 1024;

/// One helper request is one line of at most this many bytes.
pub const MAX_REQUEST_BYTES: u64 = 2 * 1024 * 1024;

struct Live {
    open: bool,
    /// The pack's helper has been started (one per pack, until the pack is killed or disabled).
    helper: bool,
    job: Option<Job>,
    children: Vec<PackProcess>,
    listeners: Vec<zumi_egress::Listener>,
}

pub struct Pack {
    pub manifest: Manifest,
    pub grants: Grants,
    pub env: Env,
    live: Mutex<Live>,
}

/// What a kill ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct KillReport {
    pub processes: usize,
    pub listeners: usize,
}

pub struct Broker {
    audit: Arc<PackAudit>,
    packs: Mutex<std::collections::HashMap<String, Arc<Pack>>>,
}

fn cut(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// `https://host:port` from a URL text, never the path, query or userinfo (an audit line must not carry a token).
fn origin_of(url: &str) -> String {
    let Some((scheme, rest)) = url.split_once("://") else { return "?".to_string() };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = authority.rsplit('@').next().unwrap_or("");
    if scheme.is_empty() || host.is_empty() {
        return "?".to_string();
    }
    cut(&format!("{scheme}://{host}"), 120)
}

impl Broker {
    pub fn new(audit: Arc<PackAudit>) -> Broker {
        Broker { audit, packs: Mutex::new(Default::default()) }
    }

    pub fn audit(&self) -> &Arc<PackAudit> {
        &self.audit
    }

    /// Opens the door for one pack: only the host calls this, after consent and the enable step. A pack already registered is killed first.
    pub fn register(&self, manifest: Manifest, grants: Grants, env: Env) -> Result<(), String> {
        if env.protected.is_empty() {
            // A host that did not say which folders hold its own files gets no door (fail closed).
            return Err("env_unprotected".to_string());
        }
        let id = manifest.id.clone();
        let _ = self.kill(&id);
        let job = Job::new()?;
        let pack = Pack { manifest, grants, env, live: Mutex::new(Live { open: true, helper: false, job: Some(job), children: Vec::new(), listeners: Vec::new() }) };
        self.packs.lock().unwrap_or_else(|p| p.into_inner()).insert(id, Arc::new(pack));
        Ok(())
    }

    pub fn is_registered(&self, pack: &str) -> bool {
        self.pack(pack).is_some_and(|p| p.live.lock().unwrap_or_else(|e| e.into_inner()).open)
    }

    fn pack(&self, id: &str) -> Option<Arc<Pack>> {
        self.packs.lock().unwrap_or_else(|p| p.into_inner()).get(id).cloned()
    }

    /// The one path every brokered call takes: open door, scope, audit, in that order.
    fn gate(&self, pack_id: &str, action: &Action, target: &str, arg_digest: Option<String>) -> Result<(Arc<Pack>, Allowed), &'static str> {
        let refuse = |version: &str, code: &'static str, decision: &str| {
            // A refusal that cannot be logged is still a refusal.
            let _ = self.audit.append(&Row { pack: pack_id, version, event: "action", capability: Some(action.capability()), target: Some(target), arg_digest: arg_digest.clone(), decision, code: Some(code), detail: "" });
            code
        };
        let Some(pack) = self.pack(pack_id) else { return Err(refuse("-", "not_enabled", "refused-scope")) };
        let version = pack.manifest.version.clone();
        if !pack.live.lock().unwrap_or_else(|e| e.into_inner()).open {
            return Err(refuse(&version, "not_enabled", "refused-scope"));
        }
        let allowed = match decide(&pack.manifest, &pack.grants, &pack.env, action) {
            Ok(a) => a,
            Err(code) => return Err(refuse(&version, code, "refused-scope")),
        };
        let row = Row { pack: pack_id, version: &version, event: "action", capability: Some(action.capability()), target: Some(target), arg_digest, decision: "allowed", code: None, detail: "" };
        if self.audit.append(&row).is_err() {
            return Err("audit_failed");
        }
        Ok((pack, allowed))
    }

    /// Starts a program for the helper: resolved by the host, no shell unless declared, a stripped environment, inside the pack's job.
    pub fn spawn(&self, pack_id: &str, program: &str, args: &[String], cwd: Option<&Path>) -> Result<u32, &'static str> {
        let digest = Some(sha256_hex(args.join("\u{1f}").as_bytes()));
        let (pack, allowed) = self.gate(pack_id, &Action::Spawn { program, cwd, args }, &cut(program, 120), digest)?;
        let Allowed::Spawn { exe, cwd } = allowed else { return Err("scope_mismatch") };
        let env = allowed_env(&["SystemRoot", "PATH", "TEMP", "TMP"]);
        let mut live = pack.live.lock().unwrap_or_else(|e| e.into_inner());
        if !live.open {
            return Err("not_enabled");
        }
        let Some(job) = live.job.as_ref() else { return Err("job_failed") };
        // Suspended, into the job, then resumed (proc.rs), at LOW integrity (R7c, S-A): UIPI keeps what it starts, a nested job or a process
        // born through WMI included, from answering a window of the host; it cannot write the user's files or use WMI.
        let child = crate::proc::start(&exe, args, &cwd, &env, Io::Null, job, &Level::Low).map_err(|_| "spawn_failed")?;
        let pid = child.id();
        live.children.push(child);
        Ok(pid)
    }

    pub fn read(&self, pack_id: &str, path: &Path) -> Result<Vec<u8>, &'static str> {
        use std::io::Read;
        let (pack, allowed) = self.gate(pack_id, &Action::Read { path }, &cut(&path.to_string_lossy(), 200), None)?;
        let Allowed::Path(p) = allowed else { return Err("scope_mismatch") };
        let mut f = std::fs::File::open(&p).map_err(|_| "read_failed")?;
        // The scope said yes to a path; this checks the object actually opened (where it really is, and that it has no second name).
        handle::recheck(&f, &pack, false)?;
        let meta = f.metadata().map_err(|_| "read_failed")?;
        if !meta.is_file() || meta.len() as usize > MAX_FILE_BYTES {
            return Err("read_refused");
        }
        let mut out = Vec::with_capacity(meta.len() as usize);
        f.by_ref().take(MAX_FILE_BYTES as u64 + 1).read_to_end(&mut out).map_err(|_| "read_failed")?;
        if out.len() > MAX_FILE_BYTES {
            return Err("read_refused");
        }
        Ok(out)
    }

    pub fn write(&self, pack_id: &str, path: &Path, data: &[u8]) -> Result<(), &'static str> {
        use std::io::Write;
        if data.len() > MAX_FILE_BYTES {
            return Err("write_refused");
        }
        let (pack, allowed) = self.gate(pack_id, &Action::Write { path }, &cut(&path.to_string_lossy(), 200), Some(sha256_hex(data)))?;
        let Allowed::Path(p) = allowed else { return Err("scope_mismatch") };
        // Opened WITHOUT truncation, checked through the handle, and only then emptied and written. A file this call created and then
        // refused is deleted through the same handle (never by path, which may point elsewhere by now).
        let (mut f, created) = handle::open_for_write(&p).map_err(|_| "write_failed")?;
        if let Err(code) = handle::recheck(&f, &pack, true) {
            if created {
                handle::delete(&f);
            }
            return Err(code);
        }
        f.set_len(0).and_then(|_| f.write_all(data)).and_then(|_| f.flush()).map_err(|_| "write_failed")
    }

    /// One request through the egress guard, to an origin the manifest ceiling and the user's grants both allow.
    pub fn connect(&self, pack_id: &str, method: &str, url: &str) -> Result<(u16, Vec<u8>), &'static str> {
        let (_, allowed) = self.gate(pack_id, &Action::Connect { url }, &origin_of(url), Some(sha256_hex(method.as_bytes())))?;
        let Allowed::Origins(origins) = allowed else { return Err("scope_mismatch") };
        let mut egress = zumi_egress::Egress::new(Arc::new(|_| {}));
        for o in &origins {
            // An origin the guard will not accept (a private address typed as a public one) is simply not reachable.
            let _ = egress.add_user_origin(o);
        }
        let version = self.pack(pack_id).map(|p| p.manifest.version.clone()).unwrap_or_default();
        let sent = egress.send(&zumi_egress::Request::new(method, url), &|| false);
        match sent {
            Ok(r) => Ok((r.head.status, r.body)),
            Err(e) => {
                let code = e.code();
                let _ = self.audit.append(&Row { pack: pack_id, version: &version, event: "result", capability: Some("net.egress"), target: Some(&origin_of(url)), arg_digest: None, decision: "n/a", code: Some(code), detail: "" });
                Err(code)
            }
        }
    }

    /// Opens a listener for the helper. The host owns the socket: the port number is all the helper gets back.
    pub fn listen(&self, pack_id: &str, bind: &str, port: u16) -> Result<u16, &'static str> {
        let (pack, allowed) = self.gate(pack_id, &Action::Listen { bind, port }, &format!("{bind}:{port}"), None)?;
        let Allowed::Listen { lan } = allowed else { return Err("scope_mismatch") };
        let l = zumi_egress::listen(if lan { zumi_egress::Bind::Lan } else { zumi_egress::Bind::Loopback }, port).map_err(|_| "listen_failed")?;
        let mut live = pack.live.lock().unwrap_or_else(|e| e.into_inner());
        if !live.open {
            return Err("not_enabled");
        }
        live.listeners.push(l);
        Ok(port)
    }

    /// Starts the pack's helper exe inside the pack's job and serves its requests (`request`) on a thread. The host starts it; the helper
    /// never starts anything itself. Its environment is stripped (it does not inherit the host key or any other variable).
    pub fn start_helper(self: &Arc<Self>, pack_id: &str, exe: &Path, args: &[String]) -> Result<u32, &'static str> {
        let pack = self.pack(pack_id).ok_or("not_enabled")?;
        {
            let live = pack.live.lock().unwrap_or_else(|e| e.into_inner());
            if !live.open {
                return Err("not_enabled");
            }
            if live.helper {
                return Err("helper_running");
            }
        }
        let digest = Some(sha256_hex(args.join("\u{1f}").as_bytes()));
        // R7d (gate R7c should-fix 5): the containment is made BEFORE the start is logged as allowed, so a start that cannot be contained
        // leaves a refusal row and no "allowed" row.
        let (level, env) = match helper_level(&pack, exe) {
            Ok(l) => l,
            Err(code) => {
                let _ = self.audit.append(&Row { pack: pack_id, version: &pack.manifest.version, event: "helper-start", capability: None, target: Some("helper"), arg_digest: digest, decision: "refused-scope", code: Some(code), detail: "" });
                return Err(code);
            }
        };
        let row = Row { pack: pack_id, version: &pack.manifest.version, event: "helper-start", capability: None, target: Some("helper"), arg_digest: digest, decision: "allowed", code: None, detail: "" };
        self.audit.append(&row).map_err(|_| "audit_failed")?;
        let mut live = pack.live.lock().unwrap_or_else(|e| e.into_inner());
        if !live.open || live.helper {
            return Err(if live.open { "helper_running" } else { "not_enabled" });
        }
        let Some(job) = live.job.as_ref() else { return Err("job_failed") };
        let mut child = crate::proc::start(exe, args, &pack.env.pack_data, &env, Io::Piped, job, &level).map_err(|_| "spawn_failed")?;
        let (Some(mut to_helper), Some(from_helper)) = (child.stdin.take(), child.stdout.take()) else {
            child.kill(2000);
            return Err("spawn_failed");
        };
        let pid = child.id();
        live.helper = true;
        live.children.push(child);
        drop(live);
        let broker = self.clone();
        let id = pack_id.to_string();
        std::thread::spawn(move || {
            use std::io::{BufRead, Read, Write};
            let mut input = std::io::BufReader::new(from_helper);
            let mut line = String::new();
            loop {
                line.clear();
                // A request is one line of at most MAX_REQUEST_BYTES: a longer one ends the conversation.
                match input.by_ref().take(MAX_REQUEST_BYTES).read_line(&mut line) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
                let whole = line.ends_with('\n');
                let reply = if whole { broker.request(&id, line.trim_end()) } else { json!({ "ok": false, "code": "request_too_long" }).to_string() };
                if writeln!(to_helper, "{reply}").and_then(|_| to_helper.flush()).is_err() || !whole {
                    break;
                }
            }
        });
        Ok(pid)
    }

    /// Ends everything the pack holds: its processes (and their children, through the job), its listeners. The door closes and stays shut
    /// until the host registers the pack again. One audit line says what was ended.
    pub fn kill(&self, pack_id: &str) -> KillReport {
        let Some(pack) = self.pack(pack_id) else { return KillReport::default() };
        let mut live = pack.live.lock().unwrap_or_else(|e| e.into_inner());
        let was_open = live.open;
        live.open = false;
        let mut report = KillReport { processes: 0, listeners: live.listeners.len() };
        if let Some(job) = live.job.as_ref() {
            job.terminate();
        }
        for child in live.children.iter() {
            child.kill(2000);
            report.processes += 1;
        }
        live.children.clear();
        live.helper = false;
        live.listeners.clear();
        live.job = None;
        drop(live);
        if was_open {
            let detail = format!("processes {}, listeners {}", report.processes, report.listeners);
            let _ = self.audit.append(&Row::event(pack_id, &pack.manifest.version, "kill", "n/a", None, &detail));
        }
        report
    }

    pub fn kill_all(&self) -> KillReport {
        let ids: Vec<String> = self.packs.lock().unwrap_or_else(|p| p.into_inner()).keys().cloned().collect();
        ids.iter().fold(KillReport::default(), |acc, id| {
            let r = self.kill(id);
            KillReport { processes: acc.processes + r.processes, listeners: acc.listeners + r.listeners }
        })
    }

    /// The helper protocol (`zumi-power/1`): one JSON request per line, one JSON answer. The pack id is the host's (the connection the
    /// helper was started on), never the helper's own claim. An answer carries a fixed code word on refusal, never a path or an address.
    pub fn request(&self, pack_id: &str, line: &str) -> String {
        let fail = |code: &str| json!({ "ok": false, "code": code }).to_string();
        let Ok(v) = serde_json::from_str::<Value>(line) else { return fail("bad_request") };
        let s = |k: &str| v.get(k).and_then(Value::as_str);
        let reply = match s("op") {
            Some("spawn") => {
                let args: Vec<String> = v.get("args").and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default();
                let cwd = s("cwd").map(std::path::PathBuf::from);
                s("program").ok_or("bad_request").and_then(|p| self.spawn(pack_id, p, &args, cwd.as_deref())).map(|pid| json!({ "ok": true, "pid": pid }))
            }
            Some("read") => s("path").ok_or("bad_request").and_then(|p| self.read(pack_id, Path::new(p))).map(|b| json!({ "ok": true, "bytes": b.len(), "text": String::from_utf8_lossy(&b) })),
            Some("write") => match (s("path"), s("text")) {
                (Some(p), Some(t)) => self.write(pack_id, Path::new(p), t.as_bytes()).map(|_| json!({ "ok": true })),
                _ => Err("bad_request"),
            },
            Some("connect") => s("url").ok_or("bad_request").and_then(|u| self.connect(pack_id, s("method").unwrap_or("GET"), u)).map(|(status, b)| json!({ "ok": true, "status": status, "bytes": b.len() })),
            Some("listen") => match (s("bind"), v.get("port").and_then(Value::as_u64).and_then(|p| u16::try_from(p).ok())) {
                (Some(b), Some(p)) => self.listen(pack_id, b, p).map(|port| json!({ "ok": true, "port": port })),
                _ => Err("bad_request"),
            },
            _ => Err("bad_request"),
        };
        match reply {
            Ok(v) => v.to_string(),
            Err(code) => fail(code),
        }
    }
}
