//! A kill-on-close job object per pack: the helper and everything it starts go into it, so a kill ends the whole tree at once and a
//! host exit leaves nothing running (roadmap 1.4 layer 3; the host already does this for the sidecar, `node_runtime.rs`).
//! No breakaway is allowed. A job that cannot be made is an error: the caller refuses to start the process (fail closed).
//!
//! R7b M3: the job also carries the USER-interface limits (roadmap 1.4 layer 3): no use of window or other USER handles owned outside the
//! job, no clipboard read or write, no desktop create or switch, no global atoms, no system parameter or display setting changes, no log off
//! or shut down. A job whose limits cannot be set is not made.
//!
//! What this does NOT do (R7c, re-gate R7b S-A; it was claimed to keep every pack process from reaching the host's windows, and it does not):
//! - The limits bind a process whose innermost job is THIS job. A process that makes a job of its own and joins it (PowerShell
//!   `Start-Process -Wait` does) is under that job's own, empty, UI limits: the re-gate saw it press Yes on a host message box.
//! - A process started through WMI, Task Scheduler or COM is in no job of ours at all: the job neither limits it nor ends it on `terminate`.
//! Nothing a job can say prevents either. What holds against them is the token: a program a pack starts runs at LOW integrity
//! (`proc::Level::Low`), so UIPI drops its window messages to the host's windows whatever job it is in, and Low cannot use WMI or Task
//! Scheduler (tests/r7c_ui.rs, each with a control at the user's integrity that does press Yes and does register a task).
//! A helper that declares `input.inject` runs at the user's integrity (it has to reach the user's windows), so for it the job's limits are
//! all there is, and a process of such a pack can still leave them.
#[cfg(windows)]
mod imp {
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicUIRestrictions, JobObjectExtendedLimitInformation, SetInformationJobObject, TerminateJobObject,
        JOBOBJECT_BASIC_UI_RESTRICTIONS, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOB_OBJECT_UILIMIT_DESKTOP, JOB_OBJECT_UILIMIT_DISPLAYSETTINGS,
        JOB_OBJECT_UILIMIT_EXITWINDOWS, JOB_OBJECT_UILIMIT_GLOBALATOMS, JOB_OBJECT_UILIMIT_HANDLES, JOB_OBJECT_UILIMIT_READCLIPBOARD, JOB_OBJECT_UILIMIT_SYSTEMPARAMETERS,
        JOB_OBJECT_UILIMIT_WRITECLIPBOARD,
    };

    pub struct Job(HANDLE);

    // SAFETY: a job handle is a kernel object handle; the calls on it are thread-safe.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    impl Job {
        pub fn new() -> Result<Job, String> {
            // SAFETY: no security attributes, no name: a fresh private job.
            let h = unsafe { CreateJobObjectW(None, None) }.map_err(|e| format!("job_create: {e}"))?;
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            // SAFETY: `info` is a valid, correctly sized struct of the stated class.
            let set = unsafe { SetInformationJobObject(h, JobObjectExtendedLimitInformation, &info as *const _ as *const _, std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32) };
            if let Err(e) = set {
                // SAFETY: `h` was just made here and is closed once.
                let _ = unsafe { CloseHandle(h) };
                return Err(format!("job_limit: {e}"));
            }
            let ui = JOBOBJECT_BASIC_UI_RESTRICTIONS {
                UIRestrictionsClass: JOB_OBJECT_UILIMIT_HANDLES
                    | JOB_OBJECT_UILIMIT_READCLIPBOARD
                    | JOB_OBJECT_UILIMIT_WRITECLIPBOARD
                    | JOB_OBJECT_UILIMIT_SYSTEMPARAMETERS
                    | JOB_OBJECT_UILIMIT_DISPLAYSETTINGS
                    | JOB_OBJECT_UILIMIT_GLOBALATOMS
                    | JOB_OBJECT_UILIMIT_DESKTOP
                    | JOB_OBJECT_UILIMIT_EXITWINDOWS,
            };
            // SAFETY: `ui` is a valid, correctly sized struct of the stated class.
            let set = unsafe { SetInformationJobObject(h, JobObjectBasicUIRestrictions, &ui as *const _ as *const _, std::mem::size_of::<JOBOBJECT_BASIC_UI_RESTRICTIONS>() as u32) };
            if let Err(e) = set {
                // SAFETY: `h` was just made here and is closed once.
                let _ = unsafe { CloseHandle(h) };
                return Err(format!("job_ui_limit: {e}"));
            }
            Ok(Job(h))
        }

        /// Puts a process (created suspended by `proc::start`) into the job.
        pub fn assign_raw(&self, process: HANDLE) -> Result<(), String> {
            // SAFETY: a valid process handle owned by the caller for the duration of the call.
            unsafe { AssignProcessToJobObject(self.0, process) }.map_err(|e| format!("job_assign: {e}"))
        }

        pub fn terminate(&self) {
            // SAFETY: a valid job handle; exit code 1 for every member.
            let _ = unsafe { TerminateJobObject(self.0, 1) };
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            // SAFETY: closed once; KILL_ON_JOB_CLOSE ends the members.
            let _ = unsafe { CloseHandle(self.0) };
        }
    }
}

#[cfg(not(windows))]
mod imp {
    pub struct Job;
    impl Job {
        pub fn new() -> Result<Job, String> {
            Err("job_unsupported".to_string())
        }
        pub fn assign_raw(&self, _: ()) -> Result<(), String> {
            Err("job_unsupported".to_string())
        }
        pub fn terminate(&self) {}
    }
}

pub use imp::Job;
