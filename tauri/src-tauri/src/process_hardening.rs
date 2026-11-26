//! R5 gate item (GATE-OPUS-R3 should-fix 1): the host's own stdin/stdout/stderr must not be inherited by the children it
//! starts. `std::process::Command` on Windows passes every inheritable handle to the child, so a Node sidecar (or any other
//! child that starts before the first hands helper) would hold the pipe a harness or launcher gave the host, and its reader
//! would see no end-of-file until that child died. `run()` calls `harden()` as its very first statement.

/// Marks this process's own stdin, stdout and stderr non-inheritable (see `zumi_audit::inherit`). Idempotent.
pub fn harden() {
    zumi_agent_loop::private_std_handles();
}

#[cfg(test)]
mod tests {
    #[cfg(windows)]
    fn inheritable(h: std::os::windows::io::RawHandle) -> Option<bool> {
        use windows_sys::Win32::Foundation::{GetHandleInformation, HANDLE_FLAG_INHERIT};
        if h.is_null() {
            return None;
        }
        let mut flags = 0u32;
        // SAFETY: reads the flags of a handle the std library returned for this process.
        let ok = unsafe { GetHandleInformation(h as _, &mut flags) };
        (ok != 0).then_some(flags & HANDLE_FLAG_INHERIT != 0)
    }

    #[cfg(windows)]
    #[test]
    fn r5_harden_makes_the_hosts_standard_handles_non_inheritable() {
        use std::os::windows::io::AsRawHandle;
        // A pipe the way a launcher gives one, so the handle is inheritable before `harden` (cargo's own test pipe is).
        let handles = [std::io::stdin().as_raw_handle(), std::io::stdout().as_raw_handle(), std::io::stderr().as_raw_handle()];
        let live: Vec<_> = handles.iter().filter(|h| inheritable(**h).is_some()).collect();
        if live.is_empty() {
            eprintln!("no standard handle in this test process: nothing to harden");
            return;
        }
        super::harden();
        for h in live {
            assert_eq!(inheritable(*h), Some(false), "a standard handle is still inheritable after harden()");
        }
    }

    fn first_statement(src: &str, header: &str) -> String {
        let body = &src[src.find(header).unwrap_or_else(|| panic!("{header} exists")) + header.len()..];
        body.lines().map(str::trim).find(|l| !l.is_empty() && !l.starts_with("//")).expect("a statement").to_string()
    }

    #[test]
    fn r5_run_and_the_probe_call_harden_before_anything_else_so_the_sidecar_cannot_inherit() {
        let lib = include_str!("lib.rs");
        for header in ["pub fn run() {", "pub fn probe_sidecar_spawn(data_dir_override: Option<&std::path::Path>) -> i32 {"] {
            assert_eq!(first_statement(lib, header), "process_hardening::harden();", "{header}");
        }
    }
}
