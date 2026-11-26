//! Starting a pack process (R7b M3; gate should-fix 5). Every process a pack runs (its helper, a program it asks the broker to start) is
//! made here, never with `std::process::Command`, because three things must hold from the process's FIRST instruction:
//! - it is created SUSPENDED, put in the pack's job (kill-on-close, UI limits, `job.rs`), and only then resumed: nothing it starts with
//!   CreateProcess can be born outside the job (R7 assigned after the start, so a fast fork could escape). What it asks a service for (WMI,
//!   Task Scheduler) is not its child and is in no job: the token level below is what holds there (see `Level`);
//! - its token is as low as the pack's capabilities allow (`Level`): a program a pack starts is LOW, a helper that needs no desktop or
//!   device is in an AppContainer, only an `input.inject` helper keeps the user's integrity;
//! - it inherits exactly its three standard handles (`PROC_THREAD_ATTRIBUTE_HANDLE_LIST`), nothing else the host has open.
//! Only `.exe` files are started: Windows runs a `.bat`/`.cmd` through `cmd.exe`, which would be a shell nobody declared.
//! Any step that fails ends the process (if one was made) and returns an error: there is no "start it anyway".
/// How much of the user a started process is (R7c, re-gate R7b S-A and S-B).
/// - `User`: the user's own token. Only a helper that must reach the user's windows (`input.inject`).
/// - `Low`: LOW integrity. Windows (UIPI) stops its window messages to every window of a higher integrity, whatever job it is in, so a
///   nested job (`Start-Process -Wait`) or a process born through WMI cannot press a button of the host; it cannot write the user's files
///   (no write-up), open the user's processes for writing, or use WMI. The level of the programs a pack starts.
/// - `Box(name)`: an AppContainer named `name`, no capabilities. Its token is Low and, besides, an access check passes only for objects
///   whose ACL names the container or ALL APPLICATION PACKAGES: no file of the user (not the audit key, not a file outside the pack), no
///   network (no capability, loopback included), no DPAPI secret of the user. The level of a helper that needs none of the user's desktop.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Level {
    User,
    Low,
    Box(String),
}

/// The container of a pack: one per pack id (lowercase letters, digits, `-`, `.`: all allowed in a container name).
pub fn container_name(pack_id: &str) -> String {
    format!("zumi-pack-{pack_id}")
}

/// What the process's standard handles are: all three the NUL device, or stdin/stdout pipes to the host (stderr NUL).
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Io {
    Null,
    Piped,
}

/// The command line Windows programs parse back into exactly `args` (the MSVC rules: quotes, and backslashes doubled before a quote).
pub fn command_line(exe: &str, args: &[String]) -> Result<String, &'static str> {
    let mut out = String::new();
    for (i, a) in std::iter::once(exe).chain(args.iter().map(String::as_str)).enumerate() {
        if a.contains('\0') {
            return Err("arg_nul");
        }
        if i > 0 {
            out.push(' ');
        }
        if !a.is_empty() && !a.contains([' ', '\t', '\n', '\u{b}', '"']) {
            out.push_str(a);
            continue;
        }
        out.push('"');
        let mut slashes = 0usize;
        for c in a.chars() {
            match c {
                '\\' => slashes += 1,
                '"' => {
                    out.extend(std::iter::repeat_n('\\', slashes * 2 + 1));
                    out.push('"');
                    slashes = 0;
                }
                _ => {
                    out.extend(std::iter::repeat_n('\\', slashes));
                    out.push(c);
                    slashes = 0;
                }
            }
        }
        out.extend(std::iter::repeat_n('\\', slashes * 2));
        out.push('"');
    }
    Ok(out)
}

#[cfg(windows)]
mod imp {
    use super::{command_line, Io, Level};
    use crate::job::Job;
    use std::ffi::OsString;
    use std::fs::File;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::{FromRawHandle, RawHandle};
    use std::path::Path;
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::{CloseHandle, LocalFree, SetHandleInformation, GENERIC_READ, GENERIC_WRITE, HANDLE, HANDLE_FLAGS, HANDLE_FLAG_INHERIT, HLOCAL};
    use windows::Win32::Security::Authorization::ConvertStringSidToSidW;
    use windows::Win32::Security::{
        DuplicateTokenEx, GetLengthSid, SecurityImpersonation, SetTokenInformation, TokenIntegrityLevel, TokenPrimary, PSID, SECURITY_ATTRIBUTES, SECURITY_CAPABILITIES, SID_AND_ATTRIBUTES,
        TOKEN_ADJUST_DEFAULT, TOKEN_ASSIGN_PRIMARY, TOKEN_DUPLICATE, TOKEN_MANDATORY_LABEL, TOKEN_QUERY,
    };
    use windows::Win32::Storage::FileSystem::{CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING};
    use windows::Win32::System::Pipes::CreatePipe;
    use windows::Win32::System::Threading::{
        CreateProcessAsUserW, CreateProcessW, DeleteProcThreadAttributeList, GetCurrentProcess, InitializeProcThreadAttributeList, OpenProcessToken, ResumeThread, TerminateProcess,
        UpdateProcThreadAttribute, WaitForSingleObject, CREATE_NO_WINDOW, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, EXTENDED_STARTUPINFO_PRESENT, LPPROC_THREAD_ATTRIBUTE_LIST,
        PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, STARTF_USESTDHANDLES, STARTUPINFOEXW,
    };

    /// A handle closed when dropped (every error path below closes what it opened).
    struct Owned(HANDLE);
    impl Drop for Owned {
        fn drop(&mut self) {
            if !self.0.is_invalid() && !self.0 .0.is_null() {
                // SAFETY: a handle this module opened, closed once.
                let _ = unsafe { CloseHandle(self.0) };
            }
        }
    }
    impl Owned {
        fn take(mut self) -> HANDLE {
            std::mem::replace(&mut self.0, HANDLE::default())
        }
    }

    /// A started pack process: its pid and its own process handle (ended and closed by the host).
    pub struct PackProcess {
        pid: u32,
        process: Owned,
        pub stdin: Option<File>,
        pub stdout: Option<File>,
    }

    // SAFETY: a process handle is a kernel object handle; the calls on it are thread-safe.
    unsafe impl Send for PackProcess {}

    impl PackProcess {
        pub fn id(&self) -> u32 {
            self.pid
        }

        /// Ends the process and waits for it (at most `wait_ms`).
        pub fn kill(&self, wait_ms: u32) {
            // SAFETY: our own valid process handle.
            unsafe {
                let _ = TerminateProcess(self.process.0, 1);
                let _ = WaitForSingleObject(self.process.0, wait_ms);
            }
        }
    }

    fn wide(s: &std::ffi::OsStr) -> Vec<u16> {
        s.encode_wide().chain(std::iter::once(0)).collect()
    }

    fn inheritable() -> SECURITY_ATTRIBUTES {
        SECURITY_ATTRIBUTES { nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: std::ptr::null_mut(), bInheritHandle: true.into() }
    }

    /// `K=V\0...\0\0`, sorted by name as Windows expects.
    fn env_block(env: &[(String, OsString)]) -> Vec<u16> {
        let mut pairs: Vec<&(String, OsString)> = env.iter().collect();
        pairs.sort_by_key(|(k, _)| k.to_uppercase());
        let mut out = Vec::new();
        for (k, v) in pairs {
            out.extend(std::ffi::OsStr::new(k).encode_wide());
            out.push('=' as u16);
            out.extend(v.encode_wide());
            out.push(0);
        }
        if out.is_empty() {
            out.push(0);
        }
        out.push(0);
        out
    }

    /// A primary token like ours at LOW integrity (S-1-16-4096).
    fn low_token() -> Result<Owned, String> {
        // SAFETY: handles opened here are owned by `Owned`; the SID from ConvertStringSidToSidW is freed with LocalFree.
        unsafe {
            let mut mine = HANDLE::default();
            OpenProcessToken(GetCurrentProcess(), TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ADJUST_DEFAULT | TOKEN_ASSIGN_PRIMARY, &mut mine).map_err(|e| format!("token_open: {e}"))?;
            let mine = Owned(mine);
            let mut dup = HANDLE::default();
            DuplicateTokenEx(mine.0, TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ADJUST_DEFAULT | TOKEN_ASSIGN_PRIMARY, None, SecurityImpersonation, TokenPrimary, &mut dup).map_err(|e| format!("token_dup: {e}"))?;
            let dup = Owned(dup);
            let mut sid = PSID::default();
            let low: Vec<u16> = "S-1-16-4096\0".encode_utf16().collect();
            ConvertStringSidToSidW(PCWSTR(low.as_ptr()), &mut sid).map_err(|e| format!("token_sid: {e}"))?;
            let label = TOKEN_MANDATORY_LABEL { Label: SID_AND_ATTRIBUTES { Sid: sid, Attributes: windows::Win32::System::SystemServices::SE_GROUP_INTEGRITY as u32 } };
            let set = SetTokenInformation(dup.0, TokenIntegrityLevel, &label as *const _ as *const _, std::mem::size_of::<TOKEN_MANDATORY_LABEL>() as u32 + GetLengthSid(sid));
            let _ = LocalFree(Some(HLOCAL(sid.0)));
            set.map_err(|e| format!("token_low: {e}"))?;
            Ok(dup)
        }
    }

    /// The container's SID as text (`S-1-15-2-...`), the name an ACL gives it. Derived from the name: no profile is made, nothing is written.
    pub fn container_sid(name: &str) -> Result<String, String> {
        use windows::Win32::Security::Authorization::ConvertSidToStringSidW;
        let sid = BoxSid::derive(name)?;
        // SAFETY: the SID is valid until `sid` drops; the text the system allocates is copied and freed with LocalFree.
        unsafe {
            let mut text = PWSTR::null();
            ConvertSidToStringSidW(sid.0, &mut text).map_err(|e| format!("box_sid_text: {e}"))?;
            let s = text.to_string().map_err(|e| format!("box_sid_text: {e}"));
            let _ = LocalFree(Some(HLOCAL(text.0 as *mut _)));
            s
        }
    }

    /// Removes the container's profile (the system made it at the first start; the uninstall leaves nothing of the pack behind).
    pub fn forget_container(name: &str) {
        use windows::Win32::Security::Isolation::DeleteAppContainerProfile;
        let n: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
        // SAFETY: a NUL-terminated name. A profile that is not there is not an error here.
        let _ = unsafe { DeleteAppContainerProfile(PCWSTR(n.as_ptr())) };
    }

    /// An AppContainer SID derived from its name (the system allocates it; freed on drop).
    struct BoxSid(PSID);
    impl BoxSid {
        fn derive(name: &str) -> Result<BoxSid, String> {
            use windows::Win32::Security::Isolation::{CreateAppContainerProfile, DeriveAppContainerSidFromAppContainerName};
            let n: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
            // SAFETY: a NUL-terminated name.
            unsafe {
                // A profile deleted a moment ago (an uninstall, then an install; or a delete of the same pack still running beside this
                // start) is "marked for deletion" or half removed until the delete ends, and the system answers with a changing error
                // (0x800703FA, 2, 3, 5, 0x20 were all seen). Every other error than "exists already" is retried for three seconds, then reported.
                let mut last = String::new();
                for _ in 0..30 {
                    match CreateAppContainerProfile(PCWSTR(n.as_ptr()), PCWSTR(n.as_ptr()), PCWSTR(n.as_ptr()), None) {
                        Ok(sid) => return Ok(BoxSid(sid)),
                        Err(e) if e.code().0 as u32 == 0x8007_00B7 => return DeriveAppContainerSidFromAppContainerName(PCWSTR(n.as_ptr())).map(BoxSid).map_err(|e| format!("box_sid: {e}")),
                        Err(e) => {
                            last = format!("box_profile: {e}");
                            std::thread::sleep(std::time::Duration::from_millis(100));
                        }
                    }
                }
                Err(last)
            }
        }
    }
    impl Drop for BoxSid {
        fn drop(&mut self) {
            // SAFETY: allocated by DeriveAppContainerSidFromAppContainerName, freed once.
            unsafe { windows::Win32::Security::FreeSid(self.0) };
        }
    }

    /// Gives the container (by SID text) `rights` (icacls letters: `RX`, `M`) on a file or folder (inherited by what is inside it). Fail
    /// closed: a grant that did not happen is an error and the process is not started. Not through a link: a junction or symlink here
    /// would grant on the place it points to.
    pub fn grant(path: &Path, sid: &str, rights: &str) -> Result<(), String> {
        use std::os::windows::fs::MetadataExt;
        use std::os::windows::process::CommandExt;
        let meta = std::fs::symlink_metadata(path).map_err(|e| format!("box_grant: {e}"))?;
        if meta.file_type().is_symlink() || meta.file_attributes() & 0x400 != 0 {
            return Err("box_grant_link".to_string());
        }
        let icacls = std::path::PathBuf::from(std::env::var_os("SystemRoot").ok_or("box_grant_root")?).join(r"System32\icacls.exe");
        // Inheritance flags only on a folder: on a file they would make the ACE apply to nothing.
        let spec = format!("*{sid}:{}{rights}", if meta.is_dir() { "(OI)(CI)" } else { "" });
        let out = std::process::Command::new(icacls).arg(path).args(["/grant", &spec]).creation_flags(0x0800_0000).output().map_err(|e| format!("box_grant: {e}"))?;
        if out.status.success() {
            Ok(())
        } else {
            Err(format!("box_grant: icacls said {}", String::from_utf8_lossy(&out.stdout).lines().next().unwrap_or("")))
        }
    }

    pub fn start(exe: &Path, args: &[String], cwd: &Path, env: &[(String, OsString)], io: Io, job: &Job, level: &Level) -> Result<PackProcess, String> {
        let low = *level == Level::Low;
        let box_sid = match level {
            Level::Box(name) => Some(BoxSid::derive(name)?),
            _ => None,
        };
        let attr_count = 1 + u32::from(box_sid.is_some());
        if !exe.extension().is_some_and(|x| x.eq_ignore_ascii_case("exe")) {
            return Err("not_an_exe".to_string());
        }
        let line = command_line(&exe.to_string_lossy(), args).map_err(str::to_string)?;
        let mut line_w: Vec<u16> = line.encode_utf16().chain(std::iter::once(0)).collect();
        let (exe_w, cwd_w) = (wide(exe.as_os_str()), wide(cwd.as_os_str()));
        let block = env_block(env);
        let sa = inheritable();
        // SAFETY: every handle made below is owned by an `Owned` until it is handed to a `File` or closed; buffers outlive the calls.
        unsafe {
            let nul_name: Vec<u16> = "NUL\0".encode_utf16().collect();
            let nul = Owned(CreateFileW(PCWSTR(nul_name.as_ptr()), (GENERIC_READ | GENERIC_WRITE).0, FILE_SHARE_READ | FILE_SHARE_WRITE, Some(&sa), OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, None).map_err(|e| format!("nul: {e}"))?);
            let (mut child_in, mut child_out, mut host_in, mut host_out) = (None, None, None, None);
            if io == Io::Piped {
                let (mut r, mut w) = (HANDLE::default(), HANDLE::default());
                CreatePipe(&mut r, &mut w, Some(&sa), 0).map_err(|e| format!("pipe: {e}"))?;
                let (r, w) = (Owned(r), Owned(w));
                SetHandleInformation(w.0, HANDLE_FLAG_INHERIT.0, HANDLE_FLAGS(0)).map_err(|e| format!("pipe: {e}"))?;
                child_in = Some(r);
                host_in = Some(w);
                let (mut r, mut w) = (HANDLE::default(), HANDLE::default());
                CreatePipe(&mut r, &mut w, Some(&sa), 0).map_err(|e| format!("pipe: {e}"))?;
                let (r, w) = (Owned(r), Owned(w));
                SetHandleInformation(r.0, HANDLE_FLAG_INHERIT.0, HANDLE_FLAGS(0)).map_err(|e| format!("pipe: {e}"))?;
                child_out = Some(w);
                host_out = Some(r);
            }
            let std_in = child_in.as_ref().map(|h| h.0).unwrap_or(nul.0);
            let std_out = child_out.as_ref().map(|h| h.0).unwrap_or(nul.0);
            let mut inherit: Vec<HANDLE> = vec![std_in];
            for h in [std_out, nul.0] {
                if !inherit.contains(&h) {
                    inherit.push(h);
                }
            }
            let mut size = 0usize;
            let _ = InitializeProcThreadAttributeList(None, attr_count, None, &mut size);
            let mut attr_buf = vec![0u8; size];
            let attrs = LPPROC_THREAD_ATTRIBUTE_LIST(attr_buf.as_mut_ptr() as *mut _);
            InitializeProcThreadAttributeList(Some(attrs), attr_count, None, &mut size).map_err(|e| format!("attrs: {e}"))?;
            let caps = SECURITY_CAPABILITIES { AppContainerSid: box_sid.as_ref().map(|s| s.0).unwrap_or_default(), Capabilities: std::ptr::null_mut(), CapabilityCount: 0, Reserved: 0 };
            let made = (|| -> Result<PROCESS_INFORMATION, String> {
                if box_sid.is_some() {
                    // No capability at all: no network, no user folders, no devices. Everything it may touch is named by an ACL.
                    UpdateProcThreadAttribute(attrs, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize, Some(&caps as *const _ as *const _), std::mem::size_of::<SECURITY_CAPABILITIES>(), None, None).map_err(|e| format!("box_attrs: {e}"))?;
                }
                UpdateProcThreadAttribute(attrs, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize, Some(inherit.as_ptr() as *const _), std::mem::size_of_val(inherit.as_slice()), None, None).map_err(|e| format!("attrs: {e}"))?;
                let mut si = STARTUPINFOEXW::default();
                si.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
                si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
                si.StartupInfo.hStdInput = std_in;
                si.StartupInfo.hStdOutput = std_out;
                si.StartupInfo.hStdError = nul.0;
                si.lpAttributeList = attrs;
                let flags = CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT;
                let mut proc_info = PROCESS_INFORMATION::default();
                let cmd = Some(PWSTR(line_w.as_mut_ptr()));
                let envp = Some(block.as_ptr() as *const _);
                if low {
                    let token = low_token()?;
                    CreateProcessAsUserW(Some(token.0), PCWSTR(exe_w.as_ptr()), cmd, None, None, true, flags, envp, PCWSTR(cwd_w.as_ptr()), &si.StartupInfo, &mut proc_info).map_err(|e| format!("spawn_low: {e}"))?;
                } else {
                    CreateProcessW(PCWSTR(exe_w.as_ptr()), cmd, None, None, true, flags, envp, PCWSTR(cwd_w.as_ptr()), &si.StartupInfo, &mut proc_info).map_err(|e| format!("spawn: {e}"))?;
                }
                Ok(proc_info)
            })();
            DeleteProcThreadAttributeList(attrs);
            let proc_info = made?;
            let (process, thread) = (Owned(proc_info.hProcess), Owned(proc_info.hThread));
            // Into the job BEFORE its first instruction; a process that cannot be put there never runs.
            if let Err(e) = job.assign_raw(process.0) {
                let _ = TerminateProcess(process.0, 1);
                return Err(e);
            }
            if ResumeThread(thread.0) == u32::MAX {
                let _ = TerminateProcess(process.0, 1);
                return Err("resume_failed".to_string());
            }
            drop(thread);
            drop((child_in, child_out, nul));
            let to_file = |h: Option<Owned>| h.map(|h| File::from_raw_handle(h.take().0 as RawHandle));
            Ok(PackProcess { pid: proc_info.dwProcessId, process, stdin: to_file(host_in), stdout: to_file(host_out) })
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use super::{Io, Level};
    use crate::job::Job;
    use std::ffi::OsString;
    use std::fs::File;
    use std::path::Path;

    pub struct PackProcess {
        pub stdin: Option<File>,
        pub stdout: Option<File>,
    }

    impl PackProcess {
        pub fn id(&self) -> u32 {
            0
        }
        pub fn kill(&self, _: u32) {}
    }

    pub fn start(_: &Path, _: &[String], _: &Path, _: &[(String, OsString)], _: Io, _: &Job, _: &Level) -> Result<PackProcess, String> {
        Err("spawn_unsupported".to_string())
    }

    pub fn container_sid(_: &str) -> Result<String, String> {
        Err("box_unsupported".to_string())
    }

    pub fn forget_container(_: &str) {}

    pub fn grant(_: &Path, _: &str, _: &str) -> Result<(), String> {
        Err("box_unsupported".to_string())
    }
}

pub use imp::{container_sid, forget_container, grant, start, PackProcess};

#[cfg(test)]
mod tests {
    use super::command_line;

    #[test]
    fn the_command_line_quotes_as_windows_parses_it() {
        let a = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(command_line(r"C:\x\a.exe", &a(&["plain", "two words", ""])).unwrap(), r#"C:\x\a.exe plain "two words" """#);
        assert_eq!(command_line("a.exe", &a(&[r#"say "hi""#])).unwrap(), r#"a.exe "say \"hi\"""#);
        assert_eq!(command_line("a.exe", &a(&[r"C:\dir with space\"])).unwrap(), r#"a.exe "C:\dir with space\\""#);
        assert_eq!(command_line("a.exe", &a(&[r"back\\slash"])).unwrap(), r"a.exe back\\slash");
        assert!(command_line("a.exe", &a(&["nul\0byte"])).is_err());
    }
}
