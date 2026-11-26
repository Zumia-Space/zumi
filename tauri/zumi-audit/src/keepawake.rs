//! Keep-awake (R6, F56): the PC is kept from idle-sleeping only while a run or a routine is active, and released when it ends.
//! Upstream: `electron/keep-awake.mjs` (the desktop keeps the computer awake for the hour before a due routine and while one runs; a
//! setting, on by default; a closed lid still sleeps). The matrix says: "one OS call" -- here `SetThreadExecutionState`.
//!
//! `KeepAwake::hold()` returns a `Hold`; the OS is asked to stay awake when the first hold is taken and released when the last one is
//! dropped, so a run that ends, is stopped, fails or panics gives the PC back (a `Drop`, not a call somebody must remember).
//! The execution state belongs to a thread, so on Windows one thread of its own makes every call.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// The platform call. `true` = it took effect. Tests use a recorder.
pub trait Sleep: Send + Sync {
    fn hold(&self, on: bool) -> bool;
}

/// Where the PC gets its power. Upstream (`electron/routine-wake.mjs` `routineWakeDecision`): on battery the PC is never held awake.
pub trait Power: Send + Sync {
    /// `true` = running on the battery (charger out). Unknown is `false`: a desktop has no battery to protect.
    fn on_battery(&self) -> bool;
}

struct Mains;
impl Power for Mains {
    fn on_battery(&self) -> bool {
        false
    }
}

struct Inner {
    sleep: Box<dyn Sleep>,
    power: Box<dyn Power>,
    state: Mutex<State>,
    enabled: AtomicBool,
}

struct State {
    /// Reasons to stay awake that are active (a run, a routine due soon).
    holders: usize,
    /// Whether the OS has been asked to stay awake (and not yet told to stop). Differs from `holders > 0` on battery.
    os_held: bool,
}

impl Inner {
    /// Makes the OS request match what is wanted: awake while there is a reason AND the PC is on the charger. Call with the lock held.
    fn apply(&self, st: &mut State) {
        let want = st.holders > 0 && !self.power.on_battery();
        if want == st.os_held {
            return;
        }
        let took = self.sleep.hold(want);
        st.os_held = want;
        if !took {
            eprintln!("keep-awake: the OS did not accept the {}", if want { "request, so the PC may sleep during this run" } else { "release; the request ends with the process" });
        }
    }
}

#[derive(Clone)]
pub struct KeepAwake {
    inner: Arc<Inner>,
}

/// A reason to stay awake. Dropping it gives the PC back (when it was the last one).
#[must_use = "dropping the hold ends it at once"]
pub struct Hold(Option<Arc<Inner>>);

struct Nothing;
impl Sleep for Nothing {
    fn hold(&self, _on: bool) -> bool {
        true
    }
}

impl KeepAwake {
    pub fn new(sleep: Box<dyn Sleep>) -> KeepAwake {
        KeepAwake::with_power(sleep, Box::new(Mains))
    }

    pub fn with_power(sleep: Box<dyn Sleep>, power: Box<dyn Power>) -> KeepAwake {
        KeepAwake { inner: Arc::new(Inner { sleep, power, state: Mutex::new(State { holders: 0, os_held: false }), enabled: AtomicBool::new(true) }) }
    }

    /// Looks at the power source again: a hold taken on the charger is given back when the charger comes out, and taken again when it
    /// returns (upstream re-reads the power source every 60 s). The routines runner calls this on every tick.
    pub fn refresh(&self) {
        let mut st = self.inner.state.lock().unwrap_or_else(|p| p.into_inner());
        self.inner.apply(&mut st);
    }

    /// Never touches the OS (tests, and builds that must not).
    pub fn off() -> KeepAwake {
        KeepAwake::new(Box::new(Nothing))
    }

    /// The one for this process: the real OS call. Every caller gets the same holders count.
    pub fn process() -> KeepAwake {
        static ONE: std::sync::OnceLock<KeepAwake> = std::sync::OnceLock::new();
        ONE.get_or_init(|| KeepAwake::with_power(system_sleep(), system_power())).clone()
    }

    /// The user's setting ("keep this computer awake for routines", on by default). Only holds taken after the change are affected.
    pub fn set_enabled(&self, on: bool) {
        self.inner.enabled.store(on, Ordering::SeqCst);
    }

    /// A reason to stay awake. With the setting off this is an inert hold (the OS is never asked).
    pub fn hold(&self) -> Hold {
        if !self.inner.enabled.load(Ordering::SeqCst) {
            return Hold(None);
        }
        let mut st = self.inner.state.lock().unwrap_or_else(|p| p.into_inner());
        st.holders += 1;
        self.inner.apply(&mut st);
        Hold(Some(self.inner.clone()))
    }

    pub fn holders(&self) -> usize {
        self.inner.state.lock().unwrap_or_else(|p| p.into_inner()).holders
    }
}

impl Drop for Hold {
    fn drop(&mut self) {
        let Some(inner) = self.0.take() else { return };
        let mut st = inner.state.lock().unwrap_or_else(|p| p.into_inner());
        st.holders = st.holders.saturating_sub(1);
        inner.apply(&mut st);
    }
}

#[cfg(windows)]
fn system_sleep() -> Box<dyn Sleep> {
    Box::new(win::ThreadSleep::start())
}

/// `SetThreadExecutionState` keeps its state per thread: the state set on one thread is cleared when THAT thread clears it or ends.
/// So one thread of its own makes every call and the callers only send it a message and wait for the answer.
#[cfg(windows)]
mod win {
    use super::Sleep;
    use std::sync::mpsc::{channel, Sender};
    use std::sync::Mutex;
    use std::time::Duration;
    use windows::Win32::System::Power::{GetSystemPowerStatus, SetThreadExecutionState, ES_CONTINUOUS, ES_SYSTEM_REQUIRED, SYSTEM_POWER_STATUS};

    /// `ACLineStatus`: 0 = offline (the battery), 1 = online, 255 = unknown. Only "offline" is battery (Electron's `isOnBatteryPower`).
    pub struct SystemPower;
    impl super::Power for SystemPower {
        fn on_battery(&self) -> bool {
            let mut status = SYSTEM_POWER_STATUS::default();
            // SAFETY: `status` is a valid, writable SYSTEM_POWER_STATUS for the duration of the call.
            let ok = unsafe { GetSystemPowerStatus(&mut status) }.is_ok();
            ok && status.ACLineStatus == 0
        }
    }

    pub struct ThreadSleep(Mutex<Sender<(bool, Sender<bool>)>>);

    impl ThreadSleep {
        pub fn start() -> ThreadSleep {
            let (tx, rx) = channel::<(bool, Sender<bool>)>();
            let spawned = std::thread::Builder::new().name("zumi-keep-awake".into()).spawn(move || {
                for (on, reply) in rx {
                    // ES_SYSTEM_REQUIRED stops idle sleep; the display may still turn off. ES_CONTINUOUS alone clears the request.
                    let flags = if on { ES_CONTINUOUS | ES_SYSTEM_REQUIRED } else { ES_CONTINUOUS };
                    // SAFETY: SetThreadExecutionState takes flags by value and has no pointer arguments.
                    let previous = unsafe { SetThreadExecutionState(flags) };
                    // 0 is the documented failure value.
                    let _ = reply.send(previous.0 != 0);
                }
            });
            if let Err(e) = spawned {
                eprintln!("keep-awake: could not start its thread: {e}");
            }
            ThreadSleep(Mutex::new(tx))
        }
    }

    impl Sleep for ThreadSleep {
        fn hold(&self, on: bool) -> bool {
            let (reply, answer) = channel();
            let sent = self.0.lock().unwrap_or_else(|p| p.into_inner()).send((on, reply)).is_ok();
            sent && answer.recv_timeout(Duration::from_secs(2)).unwrap_or(false)
        }
    }
}
#[cfg(not(windows))]
fn system_sleep() -> Box<dyn Sleep> {
    Box::new(Nothing)
}

#[cfg(windows)]
fn system_power() -> Box<dyn Power> {
    Box::new(win::SystemPower)
}
#[cfg(not(windows))]
fn system_power() -> Box<dyn Power> {
    Box::new(Mains)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default, Clone)]
    struct Rec(Arc<Mutex<Vec<bool>>>);
    impl Sleep for Rec {
        fn hold(&self, on: bool) -> bool {
            self.0.lock().unwrap().push(on);
            true
        }
    }
    fn rig() -> (KeepAwake, Rec) {
        let r = Rec::default();
        (KeepAwake::new(Box::new(r.clone())), r)
    }
    fn calls(r: &Rec) -> Vec<bool> {
        r.0.lock().unwrap().clone()
    }

    #[test]
    fn the_first_hold_asks_the_os_and_the_last_release_gives_it_back_once() {
        let (k, r) = rig();
        assert_eq!(calls(&r), Vec::<bool>::new(), "nothing is held until something is active");
        let a = k.hold();
        let b = k.hold();
        assert_eq!((k.holders(), calls(&r)), (2, vec![true]), "a second reason does not ask again");
        drop(a);
        assert_eq!((k.holders(), calls(&r)), (1, vec![true]), "one reason is still active: still awake");
        drop(b);
        assert_eq!((k.holders(), calls(&r)), (0, vec![true, false]), "the last one ended: released");
        let _c = k.hold();
        assert_eq!(calls(&r), vec![true, false, true], "a later run holds again");
    }

    #[test]
    fn a_hold_dropped_by_a_panic_is_released() {
        let (k, r) = rig();
        let k2 = k.clone();
        let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
            let _h = k2.hold();
            panic!("the run blew up");
        }));
        assert!(res.is_err());
        assert_eq!((k.holders(), calls(&r)), (0, vec![true, false]));
    }

    #[test]
    fn the_setting_off_means_no_hold_and_a_hold_already_taken_still_releases() {
        let (k, r) = rig();
        k.set_enabled(false);
        let h = k.hold();
        assert_eq!((k.holders(), calls(&r)), (0, Vec::<bool>::new()), "setting off: the OS is never asked");
        drop(h);
        assert!(calls(&r).is_empty());
        k.set_enabled(true);
        let h = k.hold();
        k.set_enabled(false);
        drop(h);
        assert_eq!(calls(&r), vec![true, false], "turning it off mid-run does not leave the PC held");
    }

    #[test]
    fn clones_share_one_count() {
        let (k, r) = rig();
        let k2 = k.clone();
        let (a, b) = (k.hold(), k2.hold());
        assert_eq!(k.holders(), 2);
        drop((a, b));
        assert_eq!(calls(&r), vec![true, false]);
    }

    #[derive(Clone, Default)]
    struct FakePower(Arc<AtomicBool>);
    impl Power for FakePower {
        fn on_battery(&self) -> bool {
            self.0.load(Ordering::SeqCst)
        }
    }
    fn rig_power(on_battery: bool) -> (KeepAwake, Rec, FakePower) {
        let (r, p) = (Rec::default(), FakePower::default());
        p.0.store(on_battery, Ordering::SeqCst);
        (KeepAwake::with_power(Box::new(r.clone()), Box::new(p.clone())), r, p)
    }

    #[test]
    fn on_battery_the_os_is_never_asked_to_stay_awake() {
        let (k, r, _p) = rig_power(true);
        let h = k.hold();
        assert_eq!(calls(&r), Vec::<bool>::new(), "upstream routineWakeDecision: onBattery -> hold false (reason battery)");
        drop(h);
        assert_eq!(calls(&r), Vec::<bool>::new(), "and nothing was held, so nothing is released");
    }

    #[test]
    fn pulling_the_charger_out_gives_the_pc_back_and_plugging_it_in_asks_again() {
        let (k, r, p) = rig_power(false);
        let h = k.hold();
        assert_eq!(calls(&r), vec![true], "on the charger: held");
        k.refresh();
        assert_eq!(calls(&r), vec![true], "nothing changed: the OS is not asked again");
        p.0.store(true, Ordering::SeqCst);
        k.refresh();
        assert_eq!((calls(&r), k.holders()), (vec![true, false], 1), "charger out: released, the reason to stay awake is still counted");
        k.refresh();
        assert_eq!(calls(&r), vec![true, false], "still on battery: not asked again");
        p.0.store(false, Ordering::SeqCst);
        k.refresh();
        assert_eq!(calls(&r), vec![true, false, true], "charger back: held again");
        drop(h);
        assert_eq!(calls(&r), vec![true, false, true, false]);
    }

    #[cfg(windows)]
    #[test]
    fn the_windows_power_source_answers() {
        // The value depends on the machine; the call must work and agree with itself.
        let (a, b) = (system_power().on_battery(), system_power().on_battery());
        assert_eq!(a, b);
    }

    #[cfg(windows)]
    #[test]
    fn the_windows_call_takes_effect_and_is_released() {
        let s = system_sleep();
        assert!(s.hold(true), "SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) was accepted");
        assert!(s.hold(false));
        assert!(s.hold(true) && s.hold(false), "and again");
    }
}
