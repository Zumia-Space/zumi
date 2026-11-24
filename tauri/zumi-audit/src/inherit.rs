//! Our own stdin/stdout/stderr must not reach a grandchild.
//!
//! Windows `CreateProcess` with `bInheritHandles = TRUE` (what Rust's `Command` uses) hands the child EVERY inheritable
//! handle of the parent, not only the three it names as stdio. The pipes our parent gave us are inheritable, so an app the
//! hands helper launches (Notepad) ends up holding the pipe to the loop bin, and the bin's pipe to the harness or host.
//! The reader then sees no end-of-file until that app is closed (GATE-OPUS-R1 should-fix 2, measured in the tests below).

/// Marks this process's std handles non-inheritable. Call first thing in a process that starts children.
pub fn private_std_handles() {
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::Foundation::{SetHandleInformation, HANDLE, HANDLE_FLAGS, HANDLE_FLAG_INHERIT};
        let handles = [std::io::stdin().as_raw_handle(), std::io::stdout().as_raw_handle(), std::io::stderr().as_raw_handle()];
        for h in handles {
            // A std handle can be missing (a GUI process without a console) or already closed: nothing to protect then.
            // `Stdio::inherit` duplicates the handle for a child by itself, so clearing the flag costs nothing there.
            if !h.is_null() {
                // SAFETY: a handle the std library returned for this process; the call only clears one flag.
                let _ = unsafe { SetHandleInformation(HANDLE(h), HANDLE_FLAG_INHERIT.0, HANDLE_FLAGS(0)) };
            }
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use std::io::Read;
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    const ROLE: &str = "ZUMI_INHERIT_TEST_ROLE";

    /// The middle process of the chain (host or helper stand-in): optionally hardens its std handles, then starts a
    /// child exactly as `act::launch` does (all three std handles null) that outlives it by about 5 s, and exits.
    #[test]
    fn middle() {
        let Ok(role) = std::env::var(ROLE) else { return };
        if role == "hardened" {
            super::private_std_handles();
        }
        let _app = Command::new(r"C:\Windows\System32\PING.EXE")
            .args(["-n", "6", "127.0.0.1"])
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("start the app stand-in");
    }

    /// Runs `middle` as a child of this test with a piped stdout (like the harness or host reading the bin), and says how
    /// long the pipe took to reach end-of-file after the middle process exited.
    fn eof_after(role: &str) -> Duration {
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "inherit::tests::middle", "--nocapture", "--test-threads=1"])
            .env(ROLE, role)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let t0 = Instant::now();
        let mut sink = Vec::new();
        child.stdout.take().unwrap().read_to_end(&mut sink).unwrap();
        let took = t0.elapsed();
        child.wait().unwrap();
        took
    }

    /// Control, measured: without the call the app stand-in keeps the pipe open for its whole life (about 5 s).
    #[test]
    fn without_the_call_the_app_holds_the_pipe_open() {
        let took = eof_after("leaky");
        assert!(took >= Duration::from_secs(3), "the leak is not reproduced here (EOF after {took:?}); the next test would prove nothing");
    }

    /// The fix: after `private_std_handles` the pipe ends when the middle process ends, whatever the app does.
    #[test]
    fn after_the_call_the_pipe_ends_with_its_owner() {
        let took = eof_after("hardened");
        assert!(took < Duration::from_secs(2), "EOF only after {took:?}: a grandchild still holds our stdout");
    }
}
