//! whisper.cpp on this PC, supervised. One `whisper-cli` run per clip, the measured mode (large-v3-turbo-q5_0 on Vulkan,
//! about 1.5 s for a 5 s clip, DOSSIER 18-11). The program and the model are files the user points at in the settings; this
//! module downloads nothing and installs nothing.
//!
//! What "supervised" means here:
//!   - the audio is a temp file in the work dir (the data dir, never the system temp), removed on every exit path;
//!   - the run is bounded: a time limit, the cancel flag polled every 10 ms, and the output read up to a cap; a run that
//!     goes past any of them is killed and reaped, not left behind;
//!   - the thread count is capped (1 to 16, the user's setting) and the process runs below normal priority with no window,
//!     so dictation never starves the app or the PC;
//!   - our own stdin/stdout/stderr are made non-inheritable first (`zumi_audit::inherit`): Windows hands a child every
//!     inheritable handle, and a program holding the harness's pipe would keep its reader waiting;
//!   - the answer does not wait for the pipe to close: a program that outlives the CLI while holding its output (a helper the
//!     CLI started) cannot hold the transcript back;
//!   - an error is one code word. What the program printed (paths, a model name) is never carried in it.
use crate::{Clip, Provider, SttError};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// The CLI and everything it starts, as one unit that dies together: a Windows job object with
/// KILL_ON_JOB_CLOSE (GATE-OPUS-R4 should-fix 5: killing the CLI alone left a helper it started running).
#[cfg(windows)]
mod tree {
    use std::ffi::c_void;
    use std::os::windows::io::AsRawHandle;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32};
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject, TerminateJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows::Win32::System::Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};

    pub struct Job(HANDLE);

    impl Job {
        pub fn new() -> Option<Job> {
            // SAFETY: a fresh unnamed job; the limit struct lives for the call.
            unsafe {
                let h = CreateJobObjectW(None, PCWSTR::null()).ok()?;
                let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let set = SetInformationJobObject(h, JobObjectExtendedLimitInformation, &info as *const _ as *const c_void, std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32);
                if set.is_err() {
                    let _ = CloseHandle(h);
                    return None;
                }
                Some(Job(h))
            }
        }

        /// Puts a process (started suspended) in the job, then lets its main thread run: nothing it starts can leave the job.
        pub fn adopt_and_resume(&self, child: &std::process::Child) -> bool {
            // SAFETY: the child's own process handle, valid while `child` lives.
            if unsafe { AssignProcessToJobObject(self.0, HANDLE(child.as_raw_handle())) }.is_err() {
                return false;
            }
            resume_threads(child.id())
        }

        pub fn kill(&self) {
            // SAFETY: a handle this struct owns.
            let _ = unsafe { TerminateJobObject(self.0, 1) };
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            // Closing the last handle ends every process still in the job.
            // SAFETY: a handle this struct owns, closed once.
            let _ = unsafe { CloseHandle(self.0) };
        }
    }

    fn resume_threads(pid: u32) -> bool {
        // SAFETY: a snapshot of thread ids, read to the end and closed; each thread handle opened is closed.
        unsafe {
            let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) else { return false };
            let mut entry = THREADENTRY32 { dwSize: std::mem::size_of::<THREADENTRY32>() as u32, ..Default::default() };
            let mut resumed = false;
            let mut more = Thread32First(snap, &mut entry).is_ok();
            while more {
                if entry.th32OwnerProcessID == pid {
                    if let Ok(t) = OpenThread(THREAD_SUSPEND_RESUME, false, entry.th32ThreadID) {
                        resumed |= ResumeThread(t) != u32::MAX;
                        let _ = CloseHandle(t);
                    }
                }
                more = Thread32Next(snap, &mut entry).is_ok();
            }
            let _ = CloseHandle(snap);
            resumed
        }
    }
}

/// The CLI process, and on Windows the job object that holds it and everything it starts.
struct Running {
    child: std::process::Child,
    #[cfg(windows)]
    job: tree::Job,
}

impl Running {
    #[cfg(windows)]
    fn start(cmd: &mut Command) -> Result<Running, SttError> {
        const FAILED: SttError = SttError("stt_local_failed");
        let mut child = cmd.spawn().map_err(|_| FAILED)?;
        // No job, no run: a CLI outside the job could leave a helper behind when it is killed.
        let Some(job) = tree::Job::new() else {
            let _ = child.kill();
            let _ = child.wait();
            return Err(FAILED);
        };
        if !job.adopt_and_resume(&child) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(FAILED);
        }
        Ok(Running { child, job })
    }

    #[cfg(not(windows))]
    fn start(cmd: &mut Command) -> Result<Running, SttError> {
        Ok(Running { child: cmd.spawn().map_err(|_| SttError("stt_local_failed"))? })
    }

    /// Kills the whole tree, then reaps the CLI.
    fn stop(&mut self) {
        #[cfg(windows)]
        self.job.kill();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// More output than this from a transcriber is not a transcript.
const MAX_OUTPUT: usize = 1024 * 1024;
/// After the CLI exits, how long the reader gets to collect what is still in the pipe.
const DRAIN_GRACE: Duration = Duration::from_millis(300);
const POLL: Duration = Duration::from_millis(10);

pub struct LocalWhisper {
    /// `whisper-cli.exe` (whisper.cpp).
    pub exe: PathBuf,
    /// A `ggml-*.bin` model file.
    pub model: PathBuf,
    /// Clamped to 1..=16.
    pub threads: u32,
    /// None = whisper detects the language.
    pub language: Option<String>,
    /// Where the temp audio file lives.
    pub work_dir: PathBuf,
    pub timeout: Duration,
}

/// The temp audio file; removed when this goes out of scope, whatever the way out.
struct TempWav(PathBuf);
impl Drop for TempWav {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Is a process with this id still running?
#[cfg(windows)]
fn process_alive(pid: u32) -> bool {
    use windows::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    use windows::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    // SAFETY: opens a query-only handle, reads the exit code, closes it.
    unsafe {
        let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else { return false };
        let mut code = 0u32;
        let alive = GetExitCodeProcess(h, &mut code).is_ok() && code == STILL_ACTIVE.0 as u32;
        let _ = CloseHandle(h);
        alive
    }
}
#[cfg(not(windows))]
fn process_alive(_pid: u32) -> bool {
    true
}

/// A crash (or a power cut) skips `TempWav`'s Drop and leaves the audio of that run in the work dir. Call once when the host
/// starts: removes every `stt-<pid>-*.wav` whose process is gone. A file of a process that still runs (this one, or another
/// copy of the app) is left alone, and so is every other file. Returns how many were removed.
pub fn sweep_stale(dir: &Path) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
    let mut removed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(rest) = name.strip_prefix("stt-").filter(|_| name.ends_with(".wav")) else { continue };
        let Some(pid) = rest.split('-').next().and_then(|p| p.parse::<u32>().ok()) else { continue };
        if !process_alive(pid) && std::fs::remove_file(entry.path()).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// Windows' loader statuses for "the program could not even start": a dll it imports was not found (0xC0000135: the Visual C++
/// runtime, the Vulkan loader), an entry point is missing (0xC0000139), a dll failed to initialise (0xC0000142). The person can
/// act on these (install the runtime, or choose an API engine); any other failure is not worded this way.
fn loader_refused(status: std::process::ExitStatus) -> bool {
    status.code().is_some_and(|c| matches!(c as u32, 0xC000_0135 | 0xC000_0139 | 0xC000_0142))
}

/// How long the probe lets the program run before it counts as started.
const PROBE_LIMIT: Duration = Duration::from_secs(15);

/// Starts `exe` once with `-h` (the program's own help: no model, no audio) to see that it can run on this PC. `Err` is
/// `stt_local_runtime_missing` when Windows' loader refused it; any other outcome, a hang included, means it did start.
pub fn probe(exe: &Path) -> Result<(), SttError> {
    if !exe.is_file() {
        return Err(SttError("stt_local_missing"));
    }
    zumi_audit::inherit::private_std_handles();
    let mut cmd = Command::new(exe);
    cmd.arg("-h").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    hidden_below_normal(&mut cmd);
    let mut run = Running::start(&mut cmd)?;
    let started = Instant::now();
    loop {
        match run.child.try_wait() {
            Ok(Some(status)) => return if loader_refused(status) { Err(SttError("stt_local_runtime_missing")) } else { Ok(()) },
            Ok(None) if started.elapsed() > PROBE_LIMIT => {
                run.stop();
                return Ok(());
            }
            Ok(None) => std::thread::sleep(POLL),
            Err(_) => {
                run.stop();
                return Err(SttError("stt_local_failed"));
            }
        }
    }
}

/// No window, below-normal priority and, on Windows, started suspended so the job object holds it from its first instruction.
fn hidden_below_normal(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x0000_4000;
        // Suspended until it is inside the job object, so nothing it starts can ever be outside it.
        const CREATE_SUSPENDED: u32 = 0x0000_0004;
        cmd.creation_flags(CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS | CREATE_SUSPENDED);
    }
    #[cfg(not(windows))]
    let _ = cmd;
}

static NEXT: AtomicU64 = AtomicU64::new(0);

fn temp_wav(dir: &Path, wav: &[u8]) -> Result<TempWav, SttError> {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let path = dir.join(format!("stt-{}-{nanos:x}-{}.wav", std::process::id(), NEXT.fetch_add(1, Ordering::SeqCst)));
    std::fs::create_dir_all(dir).map_err(|_| SttError("stt_local_failed"))?;
    std::fs::write(&path, wav).map_err(|_| SttError("stt_local_failed"))?;
    Ok(TempWav(path))
}

/// Reads `source` into a shared buffer up to `cap` bytes; `over` is set when more came. Stops at end of file.
fn collect<R: Read + Send + 'static>(mut source: R, cap: usize, keep: bool) -> (Arc<Mutex<Vec<u8>>>, Arc<AtomicBool>, Arc<AtomicBool>) {
    let (buf, done, over) = (Arc::new(Mutex::new(Vec::new())), Arc::new(AtomicBool::new(false)), Arc::new(AtomicBool::new(false)));
    let (b, d, o) = (buf.clone(), done.clone(), over.clone());
    std::thread::spawn(move || {
        let mut chunk = [0u8; 8192];
        loop {
            match source.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if keep {
                        let mut v = b.lock().unwrap_or_else(|e| e.into_inner());
                        if v.len() + n > cap {
                            o.store(true, Ordering::SeqCst);
                            break;
                        }
                        v.extend_from_slice(&chunk[..n]);
                    }
                }
            }
        }
        d.store(true, Ordering::SeqCst);
    });
    (buf, done, over)
}

/// Whisper prints bracketed tags for what is not speech ("[BLANK_AUDIO]", "[Music]"): they are not dictation.
fn speech_lines(raw: &[u8]) -> String {
    String::from_utf8_lossy(raw)
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !(l.starts_with('[') && l.ends_with(']')))
        .collect::<Vec<_>>()
        .join(" ")
}

impl Provider for LocalWhisper {
    fn id(&self) -> &'static str {
        "local"
    }

    fn transcribe(&self, clip: &Clip, cancel: &dyn Fn() -> bool) -> Result<String, SttError> {
        if !self.exe.is_file() || !self.model.is_file() {
            return Err(SttError("stt_local_missing"));
        }
        zumi_audit::inherit::private_std_handles();
        let audio = temp_wav(&self.work_dir, &clip.wav)?;
        let mut cmd = Command::new(&self.exe);
        cmd.arg("-m")
            .arg(&self.model)
            .arg("-f")
            .arg(&audio.0)
            .arg("-l")
            .arg(self.language.as_deref().unwrap_or("auto"))
            .arg("-t")
            .arg(self.threads.clamp(1, 16).to_string())
            .args(["-nt", "-np"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        hidden_below_normal(&mut cmd);
        let mut run = Running::start(&mut cmd)?;
        let (out, out_done, out_over) = collect(run.child.stdout.take().expect("piped"), MAX_OUTPUT, true);
        // stderr is drained so the program never blocks on a full pipe; its words are not kept (they can hold paths).
        let _ = collect(run.child.stderr.take().expect("piped"), 0, false);

        let started = Instant::now();
        let status = loop {
            if cancel() {
                run.stop();
                return Err(SttError("stt_cancelled"));
            }
            if started.elapsed() > self.timeout {
                run.stop();
                return Err(SttError("stt_local_timeout"));
            }
            if out_over.load(Ordering::SeqCst) {
                run.stop();
                return Err(SttError("stt_bad_reply"));
            }
            match run.child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) => std::thread::sleep(POLL),
                Err(_) => {
                    run.stop();
                    return Err(SttError("stt_local_failed"));
                }
            }
        };
        // The CLI has exited. Give the reader a moment to take what is left in the pipe, then answer: never wait for the pipe to
        // close, because a program the CLI started may hold it open for as long as it likes.
        let drain = Instant::now();
        while !out_done.load(Ordering::SeqCst) && drain.elapsed() < DRAIN_GRACE {
            std::thread::sleep(Duration::from_millis(5));
        }
        if out_over.load(Ordering::SeqCst) {
            return Err(SttError("stt_bad_reply"));
        }
        if loader_refused(status) {
            return Err(SttError("stt_local_runtime_missing"));
        }
        if !status.success() {
            return Err(SttError("stt_local_failed"));
        }
        let raw = out.lock().unwrap_or_else(|e| e.into_inner()).clone();
        Ok(speech_lines(&raw))
    }
}
