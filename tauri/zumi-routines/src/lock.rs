//! One scheduler per routines directory. The crate's "a reminder fires at most once" and the store's whole-file writes assume one
//! writer, and the host cannot promise it: owner and self-test builds skip the app's single-instance rule on purpose. So the
//! crate takes an exclusive OS lock on `routines.lock` in the directory and holds it until `Routines::stop` (or the process ends;
//! the OS releases it then, even after a crash). A second process is refused with `StoreError::Locked`.
use crate::store::StoreError;
use std::fs::{File, OpenOptions, TryLockError};
use std::path::Path;

pub const LOCK_FILE: &str = "routines.lock";

pub struct DirLock(#[allow(dead_code)] File);

impl DirLock {
    pub fn acquire(dir: &Path) -> Result<DirLock, StoreError> {
        std::fs::create_dir_all(dir)?;
        let mut opts = OpenOptions::new();
        opts.create(true).write(true).truncate(false);
        // Windows: share read and write but NOT delete (FILE_SHARE_READ | FILE_SHARE_WRITE = 3). The default also shares delete, so an
        // outside delete would remove the name while it is held and a second scheduler could lock a fresh file.
        #[cfg(windows)]
        std::os::windows::fs::OpenOptionsExt::share_mode(&mut opts, 3);
        let file = opts.open(dir.join(LOCK_FILE))?;
        match file.try_lock() {
            Ok(()) => Ok(DirLock(file)),
            Err(TryLockError::WouldBlock) => Err(StoreError::Locked),
            Err(TryLockError::Error(e)) => Err(e.into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::tests::tmp_dir;

    #[test]
    fn deleting_the_lock_file_while_it_is_held_fails_and_a_second_scheduler_still_cannot_start() {
        let d = tmp_dir("lockdel");
        let held = DirLock::acquire(&d).unwrap();
        // An outside tool (a cleaner, a sync client, the user) deletes the lock file: with the default share mode Windows lets it
        // go at once and a fresh file can then be locked by a second scheduler.
        assert!(std::fs::remove_file(d.join(LOCK_FILE)).is_err(), "the held lock file cannot be deleted");
        assert!(matches!(DirLock::acquire(&d), Err(StoreError::Locked)));
        drop(held);
        // Pass twin: once released, the file can be deleted and the directory is free again.
        std::fs::remove_file(d.join(LOCK_FILE)).unwrap();
        assert!(DirLock::acquire(&d).is_ok());
        let _ = std::fs::remove_dir_all(&d);
    }
}
