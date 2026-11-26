//! One cancel token for a task: the kill hotkey, the user's stop and a cap all end the loop through it.
//! The first reason sticks. Everything that waits (the mock transport's latency, the hands calls' window waits)
//! polls `is_set` in short slices, so a kill is seen within one slice.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Clone, Default)]
pub struct Cancel {
    inner: Arc<Inner>,
}

#[derive(Default)]
struct Inner {
    set: AtomicBool,
    info: Mutex<Option<(String, u64)>>,
}

/// Slice used by every cancellable wait.
pub const SLICE: Duration = Duration::from_millis(5);

impl Cancel {
    pub fn new() -> Cancel {
        Cancel::default()
    }

    /// Sets the token with a reason ("killed", "user", ...). The first call wins; returns whether this call set it.
    pub fn set(&self, reason: &str) -> bool {
        let mut info = self.inner.info.lock().unwrap_or_else(|p| p.into_inner());
        if info.is_some() {
            return false;
        }
        *info = Some((reason.to_string(), crate::types::unix_ms()));
        self.inner.set.store(true, Ordering::SeqCst);
        true
    }

    pub fn is_set(&self) -> bool {
        self.inner.set.load(Ordering::SeqCst)
    }

    /// (reason, unix ms it was set) once set.
    pub fn info(&self) -> Option<(String, u64)> {
        self.inner.info.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    /// Sleeps `ms`, in slices; true if the whole time passed, false if the token was set meanwhile.
    pub fn sleep(&self, ms: u64) -> bool {
        let end = std::time::Instant::now() + Duration::from_millis(ms);
        while std::time::Instant::now() < end {
            if self.is_set() {
                return false;
            }
            std::thread::sleep(SLICE.min(end.saturating_duration_since(std::time::Instant::now())));
        }
        !self.is_set()
    }
}

/// Runs `action(reason)` once, on a thread of its own, within one slice of the token being set; dropping it first
/// cancels the wait. Used to stop things a cancel cannot reach by itself (a helper blocked in a long call).
pub struct OnCancel {
    stop: Arc<AtomicBool>,
    handle: Option<std::thread::JoinHandle<()>>,
}

impl OnCancel {
    pub fn start(cancel: Cancel, action: impl FnOnce(&str) + Send + 'static) -> OnCancel {
        let stop = Arc::new(AtomicBool::new(false));
        let s2 = stop.clone();
        let handle = std::thread::spawn(move || {
            while !s2.load(Ordering::SeqCst) {
                if let Some((reason, _)) = cancel.info() {
                    action(&reason);
                    return;
                }
                std::thread::sleep(SLICE);
            }
        });
        OnCancel { stop, handle: Some(handle) }
    }
}

impl Drop for OnCancel {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_reason_sticks() {
        let c = Cancel::new();
        assert!(!c.is_set());
        assert!(c.set("killed"));
        assert!(!c.set("user"));
        assert_eq!(c.info().unwrap().0, "killed");
    }

    #[test]
    fn sleep_ends_early_when_set_and_runs_full_when_not() {
        let c = Cancel::new();
        let t = std::time::Instant::now();
        assert!(c.sleep(30));
        assert!(t.elapsed() >= Duration::from_millis(30));
        let c2 = c.clone();
        let h = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(20));
            c2.set("killed");
        });
        let t = std::time::Instant::now();
        assert!(!c.sleep(5000));
        assert!(t.elapsed() < Duration::from_millis(500));
        h.join().unwrap();
    }

    #[test]
    fn m4_on_cancel_runs_its_action_with_the_reason_soon_after_the_token_is_set_and_not_otherwise() {
        let got = Arc::new(Mutex::new(Vec::<String>::new()));
        let (c, g) = (Cancel::new(), got.clone());
        let w = OnCancel::start(c.clone(), move |r| g.lock().unwrap().push(r.to_string()));
        std::thread::sleep(Duration::from_millis(40));
        assert!(got.lock().unwrap().is_empty(), "bite: nothing runs while the token is unset");
        let t = std::time::Instant::now();
        c.set("user");
        while got.lock().unwrap().is_empty() && t.elapsed() < Duration::from_millis(500) {
            std::thread::sleep(Duration::from_millis(2));
        }
        assert_eq!(*got.lock().unwrap(), vec!["user".to_string()]);
        assert!(t.elapsed() < Duration::from_millis(100));
        drop(w);
        // Dropped first: the action never runs.
        let (c2, g2) = (Cancel::new(), Arc::new(Mutex::new(0u32)));
        let g3 = g2.clone();
        let w2 = OnCancel::start(c2.clone(), move |_| *g3.lock().unwrap() += 1);
        drop(w2);
        c2.set("user");
        std::thread::sleep(Duration::from_millis(40));
        assert_eq!(*g2.lock().unwrap(), 0);
    }
}
