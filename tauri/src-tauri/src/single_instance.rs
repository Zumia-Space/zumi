//! One running app per data folder, for a stranger's build (first-run finding B3: a second launch opened a second app on the same
//! settings, with its own Node dialog). The first launch holds a named mutex for its lifetime; a later one tells it to come
//! forward and quits. Owner and self-test launches keep running side by side, as they always have.
#![cfg(windows)]

use sha2::{Digest, Sha256};
use std::path::Path;
use windows_sys::Win32::Foundation::{WAIT_ABANDONED, WAIT_OBJECT_0};
use windows_sys::Win32::System::Threading::{CreateEventW, CreateMutexW, SetEvent, WaitForSingleObject, INFINITE};
use windows_sys::Win32::UI::WindowsAndMessaging::{AllowSetForegroundWindow, ASFW_ANY};

/// A restart or an update hands over: the old process may still be leaving when the new one starts.
pub(crate) const HANDOVER_WAIT_MS: u32 = 3000;

#[derive(Debug, PartialEq)]
pub(crate) enum Claim {
    First,
    Second,
}

/// The two kernel object names for a data folder. Windows paths ignore case, and the same folder must give the same name.
fn object_names(data_dir: &Path) -> (Vec<u16>, Vec<u16>) {
    let folder = data_dir.to_string_lossy().to_lowercase();
    let hash: String = Sha256::digest(folder.as_bytes()).iter().take(12).map(|b| format!("{b:02x}")).collect();
    let wide = |s: String| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    (wide(format!("Local\\Zumi-{hash}-running")), wide(format!("Local\\Zumi-{hash}-focus")))
}

/// `First`: this process owns the folder until it exits, and `on_focus` runs whenever a later launch asks. `Second`: the first was told; quit.
/// A failure to create the objects counts as `First`: a machine that cannot make a mutex still gets its app.
pub(crate) fn claim(data_dir: &Path, wait_ms: u32, on_focus: impl Fn() + Send + 'static) -> Claim {
    let (running, focus) = object_names(data_dir);
    // SAFETY: both names are NUL-terminated and outlive the calls. The handles stay open for the process's life on purpose:
    // the mutex is what says "running", and Windows releases it however the process ends.
    unsafe {
        let mutex = CreateMutexW(std::ptr::null(), 0, running.as_ptr());
        let event = CreateEventW(std::ptr::null(), 0, 0, focus.as_ptr());
        if mutex.is_null() || event.is_null() {
            return Claim::First;
        }
        let got = WaitForSingleObject(mutex, wait_ms);
        if got != WAIT_OBJECT_0 && got != WAIT_ABANDONED {
            AllowSetForegroundWindow(ASFW_ANY); // the launch the user just made may bring a window forward; the first process may not on its own
            SetEvent(event);
            return Claim::Second;
        }
        let event = event as usize;
        std::thread::spawn(move || loop {
            if WaitForSingleObject(event as _, INFINITE) != WAIT_OBJECT_0 {
                return;
            }
            on_focus();
        });
    }
    Claim::First
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn a_second_claim_on_the_same_folder_focuses_the_first_and_another_folder_is_free() {
        let folder = std::env::temp_dir().join(format!("zumi-instance-{}", std::process::id()));
        let (focused_tx, focused_rx) = mpsc::channel();
        let (claimed_tx, claimed_rx) = mpsc::channel();
        let (end_tx, end_rx) = mpsc::channel::<()>();
        let first_folder = folder.clone();
        // A mutex is owned per thread, so the first claim lives on its own thread, as the first process would.
        let holder = std::thread::spawn(move || {
            let claim = claim(&first_folder, 0, move || focused_tx.send(()).unwrap());
            claimed_tx.send(claim).unwrap();
            end_rx.recv().unwrap();
        });
        assert_eq!(claimed_rx.recv().unwrap(), Claim::First);
        let upper = std::path::PathBuf::from(folder.to_string_lossy().to_uppercase());
        assert_eq!(claim(&upper, 0, || {}), Claim::Second, "the same folder in other case is the same folder");
        focused_rx.recv_timeout(Duration::from_secs(5)).expect("the first was told to come forward");
        assert_eq!(claim(&folder.join("other"), 0, || {}), Claim::First);
        end_tx.send(()).unwrap();
        holder.join().unwrap();
    }

    #[test]
    fn a_folder_left_by_a_finished_process_is_free_again() {
        let folder = std::env::temp_dir().join(format!("zumi-instance-left-{}", std::process::id()));
        let first = folder.clone();
        // The thread ends holding the mutex: Windows reports it abandoned, the same answer a crash leaves behind.
        std::thread::spawn(move || assert_eq!(claim(&first, 0, || {}), Claim::First)).join().unwrap();
        assert_eq!(claim(&folder, 1000, || {}), Claim::First);
    }
}
