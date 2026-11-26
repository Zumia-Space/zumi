//! The runner: one thread that ticks the engine once a period and hands each fire to the sink (the host speaks it).
//!
//! Wake after suspend: while the PC sleeps the thread sleeps too. `on_resume` (called by the host when Windows reports a
//! resume, `os_signals.rs`) wakes it at once instead of waiting out the period, so an overdue reminder speaks when the PC
//! wakes. Waking early is harmless: the engine records a fire before it returns it, so a reminder fires once however many
//! resume signals arrive (Windows sends two: automatic and by-user) and however the periodic tick races with them.
use crate::clock::Tz;
use crate::engine::{Engine, Fire, Quiet};
use crate::lock::DirLock;
use crate::store::{Store, StoreError};
use zumi_audit::keepawake::{Hold, KeepAwake};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

/// How often the thread ticks when nothing wakes it. One second keeps a spoken reminder within a second of its minute.
pub const DEFAULT_PERIOD: Duration = Duration::from_secs(1);
/// How long before a routine is due the PC is kept awake (upstream: the hour before a due routine).
pub const UPCOMING_MS: i64 = 3_600_000;

impl Config {
    /// The real clock and this machine's time zone.
    #[cfg(windows)]
    pub fn system(
        dir: std::path::PathBuf,
        quiet: impl Fn() -> Quiet + Send + Sync + 'static,
        sink: impl Fn(&Fire) -> Result<(), String> + Send + Sync + 'static,
        keep_awake: KeepAwake,
    ) -> Config {
        Config {
            dir,
            tz: Box::new(crate::clock::SystemTz),
            now: Box::new(|| zumi_audit::unix_ms() as i64),
            quiet: Box::new(quiet),
            sink: Box::new(sink),
            period: DEFAULT_PERIOD,
            keep_awake,
        }
    }
}

pub struct Config {
    /// The routines directory (`reminders.json` and `audit.jsonl` live here).
    pub dir: std::path::PathBuf,
    pub tz: Box<dyn Tz + Send + Sync>,
    /// Unix ms now. Injected so tests can jump the clock.
    pub now: Box<dyn Fn() -> i64 + Send + Sync>,
    /// Quiet hours, read per due reminder (the host reads settings.json).
    pub quiet: Box<dyn Fn() -> Quiet + Send + Sync>,
    /// Hands one fire to the speaker. `Err` means "not now" (sidecar not ready): the fire is taken back and retried.
    pub sink: Box<dyn Fn(&Fire) -> Result<(), String> + Send + Sync>,
    pub period: Duration,
    /// R6: the PC is held awake for the hour before a routine is due and while its fire is handed over; released otherwise.
    pub keep_awake: KeepAwake,
}

pub(crate) struct Inner {
    pub(crate) engine: Mutex<Engine>,
    pub(crate) tz: Box<dyn Tz + Send + Sync>,
    pub(crate) now: Box<dyn Fn() -> i64 + Send + Sync>,
    quiet: Box<dyn Fn() -> Quiet + Send + Sync>,
    sink: Box<dyn Fn(&Fire) -> Result<(), String> + Send + Sync>,
    /// Counts resume signals; the thread waits on it with the period as timeout.
    wake: (Mutex<u64>, Condvar),
    stop: AtomicBool,
    /// The directory lock; released by `stop`.
    lock: Mutex<Option<DirLock>>,
    keep_awake: KeepAwake,
    /// The hold for "a routine is due within the hour"; None when none is.
    soon: Mutex<Option<Hold>>,
    /// Ticks finished (any thread). Tests wait on it so the runner thread's first tick is over before they move the clock.
    #[cfg(test)]
    ticks: std::sync::atomic::AtomicUsize,
}

#[derive(Clone)]
pub struct Routines {
    pub(crate) inner: Arc<Inner>,
}

impl Routines {
    /// Opens the store and starts the ticking thread. The thread ends with `stop()` or with the process.
    pub fn start(cfg: Config) -> Result<Routines, StoreError> {
        // First, before anything reads or writes the directory: a second process must not touch the store or the audit.
        let lock = DirLock::acquire(&cfg.dir)?;
        let store = Store::open(Path::new(&cfg.dir))?;
        let audit = zumi_audit::Audit::open(&cfg.dir.join("audit.jsonl")).map_err(|e| StoreError::Io(e.to_string()))?;
        let inner = Arc::new(Inner {
            engine: Mutex::new(Engine::new(store, Box::new(audit))?),
            tz: cfg.tz,
            now: cfg.now,
            quiet: cfg.quiet,
            sink: cfg.sink,
            wake: (Mutex::new(0), Condvar::new()),
            stop: AtomicBool::new(false),
            lock: Mutex::new(Some(lock)),
            keep_awake: cfg.keep_awake,
            soon: Mutex::new(None),
            #[cfg(test)]
            ticks: std::sync::atomic::AtomicUsize::new(0),
        });
        let thread_inner = inner.clone();
        let period = cfg.period;
        std::thread::Builder::new()
            .name("zumi-routines".into())
            .spawn(move || thread_inner.run(period))
            .map_err(|e| StoreError::Io(e.to_string()))?;
        Ok(Routines { inner })
    }

    /// Where an unreadable `reminders.json` was moved when this runner started (None = it was fine). The host logs it.
    pub fn quarantined(&self) -> Option<std::path::PathBuf> {
        self.inner.engine.lock().unwrap_or_else(|p| p.into_inner()).store().quarantined.clone()
    }

    /// The OS reported a resume from suspend: tick now.
    pub fn on_resume(&self) {
        let (count, cv) = &self.inner.wake;
        *count.lock().unwrap_or_else(|p| p.into_inner()) += 1;
        cv.notify_all();
    }

    pub fn stop(&self) {
        self.inner.stop.store(true, Ordering::SeqCst);
        self.on_resume();
        *self.inner.lock.lock().unwrap_or_else(|p| p.into_inner()) = None;
    }

    /// One tick at the injected clock, on the caller's thread. Returns how many fires were handed to the sink.
    pub fn tick_now(&self) -> Result<usize, StoreError> {
        self.inner.tick_once()
    }
}

impl Inner {
    fn run(&self, period: Duration) {
        let (count, cv) = &self.wake;
        let mut seen = *count.lock().unwrap_or_else(|p| p.into_inner());
        while !self.stop.load(Ordering::SeqCst) {
            // A failed tick (disk error) is retried on the next one; the engine wrote nothing it could not save.
            let _ = self.tick_once();
            let guard = count.lock().unwrap_or_else(|p| p.into_inner());
            let (guard, _) = cv.wait_timeout_while(guard, period, |c| *c == seen).unwrap_or_else(|p| p.into_inner());
            seen = *guard;
        }
    }

    pub(crate) fn tick_once(&self) -> Result<usize, StoreError> {
        let done = self.tick_at_clock();
        #[cfg(test)]
        self.ticks.fetch_add(1, Ordering::SeqCst);
        done
    }

    fn tick_at_clock(&self) -> Result<usize, StoreError> {
        let now = (self.now)();
        let fires = {
            let mut e = self.engine.lock().unwrap_or_else(|p| p.into_inner());
            let fires = e.tick(now, self.tz.as_ref(), &|| (self.quiet)())?;
            if let Some(err) = e.take_history_error() {
                eprintln!("routines: a history line was not written ({})", err.code());
            }
            fires
        };
        // R6: the PC is held while this tick's fires are handed over, then only if another routine is due within the hour.
        let _handing = (!fires.is_empty()).then(|| self.keep_awake.hold());
        let mut handed = 0;
        let mut undo_error = None;
        for f in &fires {
            // The engine lock is not held while speaking: the sink may call the sidecar.
            if (self.sink)(f).is_ok() {
                handed += 1;
                if let Err(err) = self.engine.lock().unwrap_or_else(|p| p.into_inner()).record_fired(f, now) {
                    eprintln!("routines: a history line was not written ({})", err.code());
                }
            } else if let Err(e) = self.engine.lock().unwrap_or_else(|p| p.into_inner()).undo(f) {
                // Every fire of this tick is already recorded as fired: the rest must still be handed over, so the error waits
                // until after the loop (an early return here dropped them).
                undo_error.get_or_insert(e);
            }
        }
        drop(_handing);
        self.update_hold(now);
        // The charger may have come out or gone back since the last tick (upstream re-reads the power source every 60 s).
        self.keep_awake.refresh();
        match undo_error {
            Some(e) => Err(e),
            None => Ok(handed),
        }
    }

    /// Holds the PC awake from an hour before the next due routine; gives it back when none is due within the hour.
    fn update_hold(&self, now: i64) {
        let soon = self.engine.lock().unwrap_or_else(|p| p.into_inner()).due_soon(now, self.tz.as_ref(), UPCOMING_MS);
        let mut held = self.soon.lock().unwrap_or_else(|p| p.into_inner());
        match (soon, held.is_some()) {
            (true, false) => *held = Some(self.keep_awake.hold()),
            (false, true) => *held = None,
            _ => {}
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::clock::tests::{ho_chi_minh, FixedZone};
    use crate::clock::DAY_MS;
    use crate::engine::tests::{hcm, quiet_off};
    use crate::store::tests::tmp_dir;
    use crate::store::Repeat;
    use std::sync::atomic::AtomicI64;
    use std::time::Instant;

    pub struct Bench {
        pub routines: Routines,
        pub clock: Arc<AtomicI64>,
        pub spoken: Arc<Mutex<Vec<(String, i64)>>>,
        pub dir: std::path::PathBuf,
    }

    pub fn bench(name: &str, start_ms: i64, quiet: Quiet, period: Duration) -> Bench {
        let dir = tmp_dir(name);
        bench_in(dir, start_ms, quiet, period)
    }

    pub fn bench_in(dir: std::path::PathBuf, start_ms: i64, quiet: Quiet, period: Duration) -> Bench {
        bench_keep(dir, start_ms, quiet, period, KeepAwake::off())
    }

    pub fn bench_keep(dir: std::path::PathBuf, start_ms: i64, quiet: Quiet, period: Duration, keep_awake: KeepAwake) -> Bench {
        bench_slow(dir, start_ms, quiet, period, keep_awake, Duration::ZERO)
    }

    /// `first_tick_delay`: the runner thread's very first read of the clock takes this long (a thread the OS starts late). It lets a test
    /// pin the race the bench used to have: the thread's first tick read the clock before the test moved it, then finished after the
    /// test's own tick.
    pub fn bench_slow(dir: std::path::PathBuf, start_ms: i64, quiet: Quiet, period: Duration, keep_awake: KeepAwake, first_tick_delay: Duration) -> Bench {
        let clock = Arc::new(AtomicI64::new(start_ms));
        let first = Arc::new(AtomicBool::new(true));
        let spoken = Arc::new(Mutex::new(Vec::new()));
        let (c, s) = (clock.clone(), spoken.clone());
        let routines = Routines::start(Config {
            dir: dir.clone(),
            tz: Box::new(FixedZone(vec![(i64::MIN, 7 * 3_600_000)])),
            now: Box::new({
                let c = clock.clone();
                move || {
                    let t = c.load(Ordering::SeqCst);
                    if std::thread::current().name() == Some("zumi-routines") && first.swap(false, Ordering::SeqCst) {
                        std::thread::sleep(first_tick_delay);
                    }
                    t
                }
            }),
            quiet: Box::new(move || quiet),
            sink: Box::new(move |f| {
                s.lock().unwrap().push((f.text.clone(), c.load(Ordering::SeqCst)));
                Ok(())
            }),
            period,
            keep_awake,
        })
        .unwrap();
        // The runner thread ticks as soon as it starts. Wait until that tick is over: a test that moves the clock and ticks while it is
        // still running would race it (it reads the clock it saw at the start and finishes after the test's own tick).
        let t = Instant::now();
        while routines.inner.ticks.load(Ordering::SeqCst) == 0 {
            assert!(t.elapsed() < Duration::from_secs(10), "the runner thread never made its first tick");
            std::thread::sleep(Duration::from_millis(1));
        }
        Bench { routines, clock, spoken, dir }
    }

    pub fn add(b: &Bench, text: &str, time: &str, repeat: Repeat) {
        let now = b.clock.load(Ordering::SeqCst);
        b.routines.inner.engine.lock().unwrap().add(text, time, repeat, now, &ho_chi_minh()).unwrap();
    }

    fn wait_for(b: &Bench, n: usize, within: Duration) -> bool {
        let t = Instant::now();
        while t.elapsed() < within {
            if b.spoken.lock().unwrap().len() >= n {
                return true;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        false
    }

    #[derive(Clone, Default)]
    struct Rec(Arc<Mutex<Vec<bool>>>);
    impl zumi_audit::keepawake::Sleep for Rec {
        fn hold(&self, on: bool) -> bool {
            self.0.lock().unwrap().push(on);
            true
        }
    }

    fn kept(name: &str, start: i64, quiet: Quiet) -> (Bench, KeepAwake, Rec) {
        kept_slow(name, start, quiet, Duration::ZERO)
    }

    fn kept_slow(name: &str, start: i64, quiet: Quiet, first_tick_delay: Duration) -> (Bench, KeepAwake, Rec) {
        let rec = Rec::default();
        let keep = KeepAwake::new(Box::new(rec.clone()));
        (bench_slow(tmp_dir(name), start, quiet, Duration::from_secs(30), keep.clone(), first_tick_delay), keep, rec)
    }

    fn set_clock(b: &Bench, t: i64) {
        b.clock.store(t, Ordering::SeqCst);
    }

    #[test]
    fn r6_keep_awake_nothing_to_do_means_the_pc_is_never_held() {
        let (b, keep, rec) = kept("ka0", hcm(10, 0, 0), quiet_off());
        let _ = b.routines.tick_now();
        assert_eq!((keep.holders(), rec.0.lock().unwrap().len()), (0, 0));
        // a routine far off (tomorrow) is not "due within the hour"
        add(&b, "later", "09:00", Repeat::Daily);
        set_clock(&b, hcm(10, 5, 0));
        let _ = b.routines.tick_now();
        assert_eq!((keep.holders(), rec.0.lock().unwrap().len()), (0, 0));
        b.routines.stop();
        let _ = std::fs::remove_dir_all(&b.dir);
    }

    #[test]
    fn r6_keep_awake_the_hour_before_a_due_routine_and_released_when_it_has_fired() {
        hour_before_then_fired("ka1", Duration::ZERO);
    }

    /// M1 (gate R6): the same test with a runner thread that starts its first tick late. The bench must not let that tick overlap the test.
    #[test]
    fn r6_keep_awake_hour_before_is_the_same_when_the_runner_threads_first_tick_is_slow() {
        hour_before_then_fired("ka1slow", Duration::from_millis(150));
    }

    fn hour_before_then_fired(name: &str, first_tick_delay: Duration) {
        let (b, keep, rec) = kept_slow(name, hcm(13, 0, 0), quiet_off(), first_tick_delay);
        add(&b, "meeting", "15:00", Repeat::None);
        set_clock(&b, hcm(13, 59, 0)); // 61 minutes before
        let _ = b.routines.tick_now();
        assert_eq!(keep.holders(), 0, "61 minutes before: not yet");
        set_clock(&b, hcm(14, 1, 0)); // 59 minutes before
        let _ = b.routines.tick_now();
        assert_eq!((keep.holders(), rec.0.lock().unwrap().clone()), (1, vec![true]), "inside the hour: held");
        // A runner thread that is still on its first tick lands here, in the middle of the test, with the clock it read at the start.
        std::thread::sleep(first_tick_delay * 2);
        let _ = b.routines.tick_now();
        assert_eq!(rec.0.lock().unwrap().len(), 1, "a second tick does not ask the OS again");
        set_clock(&b, hcm(15, 0, 0));
        assert_eq!(b.routines.tick_now().unwrap(), 1, "it fires");
        assert_eq!((keep.holders(), rec.0.lock().unwrap().last().copied()), (0, Some(false)), "fired and nothing else is due: released");
        b.routines.stop();
        let _ = std::fs::remove_dir_all(&b.dir);
    }

    #[test]
    fn r6_keep_awake_a_routine_waiting_out_quiet_hours_does_not_hold_the_pc_all_night() {
        let (b, keep, _rec) = kept("ka2", hcm(22, 0, 0), Quiet::DEFAULT);
        add(&b, "late", "23:00", Repeat::None);
        set_clock(&b, hcm(22, 10, 0));
        let _ = b.routines.tick_now();
        assert_eq!(keep.holders(), 1, "inside the hour before 23:00");
        set_clock(&b, hcm(23, 30, 0)); // overdue, held back by quiet hours (22:30-07:30)
        assert_eq!(b.routines.tick_now().unwrap(), 0, "quiet: it does not fire");
        assert_eq!(keep.holders(), 0, "and the PC is not kept awake for it");
        b.routines.stop();
        let _ = std::fs::remove_dir_all(&b.dir);
    }

    #[derive(Clone, Default)]
    struct Battery(Arc<AtomicBool>);
    impl zumi_audit::keepawake::Power for Battery {
        fn on_battery(&self) -> bool {
            self.0.load(Ordering::SeqCst)
        }
    }

    /// M2 (gate R6): upstream never holds the PC on battery. A routine due within the hour does not hold it then; the charger coming out
    /// during the hour gives it back on the next tick, and the charger returning holds it again.
    #[test]
    fn r6_keep_awake_never_on_battery_and_follows_the_charger() {
        let (rec, battery) = (Rec::default(), Battery::default());
        battery.0.store(true, Ordering::SeqCst);
        let keep = KeepAwake::with_power(Box::new(rec.clone()), Box::new(battery.clone()));
        let b = bench_keep(tmp_dir("ka-batt"), hcm(14, 0, 0), quiet_off(), Duration::from_secs(30), keep.clone());
        add(&b, "meeting", "14:30", Repeat::None);
        let _ = b.routines.tick_now();
        assert_eq!(rec.0.lock().unwrap().clone(), Vec::<bool>::new(), "on battery: a routine due in 30 minutes does not hold the PC");
        battery.0.store(false, Ordering::SeqCst);
        let _ = b.routines.tick_now();
        assert_eq!(rec.0.lock().unwrap().clone(), vec![true], "the charger is back: held");
        battery.0.store(true, Ordering::SeqCst);
        let _ = b.routines.tick_now();
        assert_eq!(rec.0.lock().unwrap().clone(), vec![true, false], "the charger is out again: given back on the next tick");
        b.routines.stop();
        let _ = std::fs::remove_dir_all(&b.dir);
    }

    #[test]
    fn r6_keep_awake_the_setting_off_never_holds() {
        let (b, keep, rec) = kept("ka3", hcm(14, 0, 0), quiet_off());
        keep.set_enabled(false);
        add(&b, "meeting", "14:30", Repeat::None);
        let _ = b.routines.tick_now();
        assert_eq!((keep.holders(), rec.0.lock().unwrap().len()), (0, 0));
        b.routines.stop();
        let _ = std::fs::remove_dir_all(&b.dir);
    }

    #[test]
    fn after_a_suspend_an_overdue_reminder_fires_once_when_the_resume_signal_arrives() {
        // The thread's period is 30 s: only the resume signal can make it tick inside this test.
        let b = bench("resume1", hcm(14, 0, 0), quiet_off(), Duration::from_secs(30));
        add(&b, "meeting", "15:00", Repeat::None);
        std::thread::sleep(Duration::from_millis(150));
        // The PC sleeps, the wall clock jumps three hours.
        b.clock.store(hcm(18, 0, 0), Ordering::SeqCst);
        assert!(!wait_for(&b, 1, Duration::from_millis(400)), "bite: nothing ticks before the resume signal");
        b.routines.on_resume();
        assert!(wait_for(&b, 1, Duration::from_secs(2)), "the resume signal wakes the runner");
        // Windows sends two resume messages, and the periodic tick may also run: still exactly one fire.
        b.routines.on_resume();
        b.routines.on_resume();
        let _ = b.routines.tick_now();
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(b.spoken.lock().unwrap().len(), 1);
        assert_eq!(b.spoken.lock().unwrap()[0].0, "meeting");
        b.routines.stop();
        let _ = std::fs::remove_dir_all(&b.dir);
    }

    #[test]
    fn a_daily_reminder_missed_for_three_days_fires_once_not_three_times() {
        let b = bench("resume3", hcm(14, 0, 0), quiet_off(), Duration::from_secs(30));
        add(&b, "stretch", "15:00", Repeat::Daily);
        b.clock.store(hcm(15, 0, 0) + 3 * DAY_MS + 1_000, Ordering::SeqCst); // woke 3 days later
        b.routines.on_resume();
        assert!(wait_for(&b, 1, Duration::from_secs(2)));
        b.routines.on_resume();
        let _ = b.routines.tick_now();
        std::thread::sleep(Duration::from_millis(200));
        assert_eq!(b.spoken.lock().unwrap().len(), 1);
        // The next one is the following 15:00, not an immediate repeat.
        b.clock.store(hcm(15, 0, 0) + 4 * DAY_MS, Ordering::SeqCst);
        let _ = b.routines.tick_now();
        assert_eq!(b.spoken.lock().unwrap().len(), 2);
        b.routines.stop();
        let _ = std::fs::remove_dir_all(&b.dir);
    }

    #[test]
    fn a_resume_inside_quiet_hours_stays_silent_until_they_end() {
        let b = bench("resumeq", hcm(22, 0, 0), Quiet::DEFAULT, Duration::from_secs(30));
        add(&b, "late", "23:00", Repeat::None);
        b.clock.store(hcm(3, 0, 0) + DAY_MS, Ordering::SeqCst); // woke at 03:00, inside 22:30-07:30
        b.routines.on_resume();
        std::thread::sleep(Duration::from_millis(400));
        assert!(b.spoken.lock().unwrap().is_empty());
        b.clock.store(hcm(7, 30, 0) + DAY_MS, Ordering::SeqCst);
        b.routines.on_resume();
        assert!(wait_for(&b, 1, Duration::from_secs(2)));
        b.routines.on_resume();
        std::thread::sleep(Duration::from_millis(200));
        assert_eq!(b.spoken.lock().unwrap().len(), 1);
        b.routines.stop();
        let _ = std::fs::remove_dir_all(&b.dir);
    }

    #[test]
    fn a_restart_does_not_repeat_a_reminder_that_already_fired() {
        let b = bench("restart", hcm(14, 0, 0), quiet_off(), Duration::from_secs(30));
        add(&b, "once only", "15:00", Repeat::Daily);
        b.clock.store(hcm(15, 0, 0), Ordering::SeqCst);
        assert_eq!(b.routines.tick_now().unwrap(), 1);
        b.routines.stop();
        // The app restarts at 15:00:20 over the same directory.
        let b2 = bench_in(b.dir.clone(), hcm(15, 0, 20), quiet_off(), Duration::from_secs(30));
        assert_eq!(b2.routines.tick_now().unwrap(), 0);
        std::thread::sleep(Duration::from_millis(200));
        assert!(b2.spoken.lock().unwrap().is_empty());
        // And a reminder that came due while the app was closed fires at the first tick after the restart, once.
        b2.clock.store(hcm(15, 0, 0) + DAY_MS + 5_000, Ordering::SeqCst);
        b2.routines.on_resume();
        assert!(wait_for(&b2, 1, Duration::from_secs(2)));
        b2.routines.stop();
        let _ = std::fs::remove_dir_all(&b.dir);
    }

    #[test]
    fn a_sink_that_is_not_ready_gets_the_fire_again_and_a_ready_one_gets_it_once() {
        let dir = tmp_dir("sink");
        let clock = Arc::new(AtomicI64::new(hcm(14, 0, 0)));
        let ready = Arc::new(AtomicBool::new(false));
        let got = Arc::new(Mutex::new(0usize));
        let (r, g) = (ready.clone(), got.clone());
        let routines = Routines::start(Config {
            dir: dir.clone(),
            tz: Box::new(FixedZone(vec![(i64::MIN, 7 * 3_600_000)])),
            now: Box::new({
                let c = clock.clone();
                move || c.load(Ordering::SeqCst)
            }),
            quiet: Box::new(quiet_off),
            sink: Box::new(move |_| {
                if r.load(Ordering::SeqCst) {
                    *g.lock().unwrap() += 1;
                    Ok(())
                } else {
                    Err("sidecar_not_ready".into())
                }
            }),
            period: Duration::from_secs(30),
            keep_awake: KeepAwake::off(),
        })
        .unwrap();
        routines.inner.engine.lock().unwrap().add("wait for me", "15:00", Repeat::None, clock.load(Ordering::SeqCst), &ho_chi_minh()).unwrap();
        clock.store(hcm(15, 0, 0), Ordering::SeqCst);
        assert_eq!(routines.tick_now().unwrap(), 0);
        assert_eq!(routines.tick_now().unwrap(), 0);
        ready.store(true, Ordering::SeqCst);
        assert_eq!(routines.tick_now().unwrap(), 1);
        assert_eq!(routines.tick_now().unwrap(), 0);
        assert_eq!(*got.lock().unwrap(), 1);
        routines.stop();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unreadable_store_is_reported_to_the_host_and_a_good_one_is_not() {
        let dir = tmp_dir("quarantine-report");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(crate::store::FILE_NAME), "    ").unwrap(); // what a power loss can leave
        let b = bench_in(dir.clone(), hcm(14, 0, 0), quiet_off(), Duration::from_secs(30));
        assert!(b.routines.quarantined().is_some_and(|p| p.exists()));
        b.routines.stop();
        let ok = bench_in(dir.clone(), hcm(14, 0, 0), quiet_off(), Duration::from_secs(30));
        assert!(ok.routines.quarantined().is_none());
        ok.routines.stop();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_failed_undo_save_does_not_drop_the_later_fires_of_the_same_tick() {
        let dir = tmp_dir("undo-save");
        let clock = Arc::new(AtomicI64::new(hcm(14, 0, 0)));
        let spoken = Arc::new(Mutex::new(Vec::<String>::new()));
        let (sp, d2) = (spoken.clone(), dir.clone());
        let routines = Routines::start(Config {
            dir: dir.clone(),
            tz: Box::new(FixedZone(vec![(i64::MIN, 7 * 3_600_000)])),
            now: Box::new({ let c = clock.clone(); move || c.load(Ordering::SeqCst) }),
            quiet: Box::new(quiet_off),
            sink: Box::new(move |f| {
                if f.text == "first" {
                    // The speaker refuses this one, and the disk refuses the undo save that follows.
                    let _ = std::fs::create_dir_all(d2.join("reminders.json.tmp"));
                    return Err("sidecar_not_ready".into());
                }
                sp.lock().unwrap().push(f.text.clone());
                Ok(())
            }),
            period: Duration::from_secs(30),
            keep_awake: KeepAwake::off(),
        })
        .unwrap();
        for t in ["first", "second", "third"] {
            routines.inner.engine.lock().unwrap().add(t, "15:00", Repeat::None, clock.load(Ordering::SeqCst), &ho_chi_minh()).unwrap();
        }
        clock.store(hcm(15, 0, 0), Ordering::SeqCst);
        assert!(routines.tick_now().is_err(), "the undo failure is surfaced after the loop");
        assert_eq!(*spoken.lock().unwrap(), ["second", "third"], "the later fires of the tick were still handed over");
        let _ = std::fs::remove_dir_all(dir.join("reminders.json.tmp"));
        routines.stop();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_second_runner_on_the_same_directory_gets_no_scheduler_and_the_reminder_fires_once() {
        let a = bench("lock2", hcm(14, 0, 0), quiet_off(), Duration::from_secs(30));
        add(&a, "only once", "15:00", Repeat::None);
        // A second runner over the same directory (another app process: owner and self-test builds have no single-instance rule).
        let second = Routines::start(Config {
            dir: a.dir.clone(),
            tz: Box::new(FixedZone(vec![(i64::MIN, 7 * 3_600_000)])),
            now: Box::new({ let c = a.clock.clone(); move || c.load(Ordering::SeqCst) }),
            quiet: Box::new(quiet_off),
            sink: Box::new(|_| Ok(())),
            period: Duration::from_secs(30),
            keep_awake: KeepAwake::off(),
        });
        assert!(matches!(second, Err(StoreError::Locked)), "the second runner must be refused");
        a.clock.store(hcm(15, 0, 0), Ordering::SeqCst);
        assert_eq!(a.routines.tick_now().unwrap(), 1);
        // The store and the audit are the first runner's, intact.
        assert_eq!(crate::store::Store::open(&a.dir).unwrap().list().len(), 1);
        assert_eq!(crate::gate::tests::read_lines(&a.dir.join("audit.jsonl")).len(), 1);
        // Pass twin: once the first runner stopped, the directory is free again (a restart in the same process works).
        a.routines.stop();
        let again = bench_in(a.dir.clone(), hcm(15, 0, 20), quiet_off(), Duration::from_secs(30));
        assert_eq!(again.routines.tick_now().unwrap(), 0);
        again.routines.stop();
        let _ = std::fs::remove_dir_all(&a.dir);
    }
}
