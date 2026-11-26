//! The engine decides, for a clock reading, which reminders fire now. It owns the store and writes the decision to disk
//! BEFORE returning it, so a crash or a restart after a fire can never fire the same reminder again (at most once).
//!
//! The engine never speaks and never reads the clock: `now_ms` and the zone are passed in, so every rule is testable with a
//! simulated clock. The runner (`runner.rs`) is the only thing that calls it with the real one.
use crate::clock::{catch_up, due_ms, next_daily_after, to_local, Tz, CATCH_UP_MS, DAY_MS};
use crate::gate::{authorize, AuditSink, Verdict};
use crate::history::{Entry as HistoryEntry, History, Status as HistoryStatus};
use crate::store::{clean_text, parse_hhmm, Reminder, Repeat, Rule, Store, StoreError, TOOL_SPEAK};
use serde_json::Value;
use std::collections::HashMap;

/// Fired one-shots stay listed for this long, then are removed.
pub const DONE_KEEP_MS: i64 = DAY_MS;

/// Quiet hours: the same window the speech scheduler uses (`talkQuietHours` in settings.json): start inclusive, end
/// exclusive, wrapping midnight.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Quiet {
    pub on: bool,
    pub start_min: u32,
    pub end_min: u32,
}

impl Quiet {
    /// The scheduler's default: on, 22:30 to 07:30.
    pub const DEFAULT: Quiet = Quiet { on: true, start_min: 22 * 60 + 30, end_min: 7 * 60 + 30 };

    /// Reads `talkQuietHours` from a settings.json value. A missing or invalid value is the default, as in the scheduler
    /// (`on` boolean, `start` and `end` valid `HH:MM`, start different from end).
    pub fn from_settings(settings: &Value) -> Quiet {
        let q = &settings["talkQuietHours"];
        let (Some(on), Some(start), Some(end)) = (q["on"].as_bool(), q["start"].as_str(), q["end"].as_str()) else {
            return Quiet::DEFAULT;
        };
        let (Some((sh, sm)), Some((eh, em))) = (parse_hhmm(start), parse_hhmm(end)) else {
            return Quiet::DEFAULT;
        };
        let (start_min, end_min) = (sh * 60 + sm, eh * 60 + em);
        if start_min == end_min {
            return Quiet::DEFAULT;
        }
        Quiet { on, start_min, end_min }
    }

    pub fn contains(&self, tz: &dyn Tz, now_ms: i64) -> bool {
        if !self.on || self.start_min == self.end_min {
            return false;
        }
        let l = to_local(tz, now_ms);
        let m = l.h * 60 + l.mi;
        if self.start_min < self.end_min {
            m >= self.start_min && m < self.end_min
        } else {
            m >= self.start_min || m < self.end_min
        }
    }
}

/// A start later than this after its time is a late start (upstream CATCH_UP_LATE_MS).
const LATE_START_MS: i64 = 2 * 60_000;
/// Late starts found in one pass begin this far apart, over at most this many steps (upstream CATCH_UP_STAGGER_MS / _STEPS).
const STAGGER_MS: i64 = 15_000;
const STAGGER_STEPS: usize = 40;

/// One reminder that is due and allowed to speak now. Already recorded as fired; `Engine::undo` takes it back if the
/// speech could not be handed over.
#[derive(Clone, Debug, PartialEq)]
pub struct Fire {
    pub id: String,
    pub text: String,
    pub due_ms: i64,
    /// Older occurrences folded behind this one by a catch-up; logged as one "Missed N" row when this fire is spoken.
    pub older_missed: u32,
    prev_last_fired_ms: Option<i64>,
    prev_done: bool,
}

/// How late `occ` is at `now`, leaving out the time inside quiet hours (those are held on purpose, not missed). Only measured when
/// it could matter: within the catch-up window the plain difference is enough, and past three days it is late whatever the window.
fn late_ms(tz: &dyn Tz, quiet: Quiet, occ: i64, now: i64) -> i64 {
    let raw = now - occ;
    if raw <= CATCH_UP_MS || !quiet.on || raw > 3 * DAY_MS {
        return raw;
    }
    let mut late = 0;
    let mut t = occ;
    while t < now {
        let step = (now - t).min(60_000);
        if !quiet.contains(tz, t) {
            late += step;
        }
        t += step;
    }
    late
}

pub struct Engine {
    store: Store,
    history: History,
    audit: Box<dyn AuditSink>,
    /// Id -> allowed, for decisions already audited whose fire did not stick (taken back because the speaker was not ready, or a failed
    /// save). The retry reuses the decision instead of auditing again: one decision, one audit line, however many ticks it takes.
    decided: HashMap<String, bool>,
    seq: u64,
    /// Late starts held back by the spreading (upstream `staggered`): routine id -> when it may start. Memory only: a routine still due when
    /// the app restarts is found late again and spread again.
    stagger: HashMap<String, i64>,
    /// The last history write that failed (disk), until `take_history_error`. The decision it was about already stuck.
    history_error: Option<StoreError>,
}

impl Engine {
    /// The history file sits next to the store.
    pub fn new(store: Store, audit: Box<dyn AuditSink>) -> Result<Engine, StoreError> {
        let history = History::open(store.path().parent().unwrap_or_else(|| std::path::Path::new(".")))?;
        Ok(Engine { store, history, audit, decided: HashMap::new(), seq: 0, stagger: HashMap::new(), history_error: None })
    }

    pub fn history(&self) -> &History {
        &self.history
    }

    /// A history line that could not be written (the decision it records is already saved, so it is not retried). Cleared by reading.
    pub fn take_history_error(&mut self) -> Option<StoreError> {
        self.history_error.take()
    }

    pub fn store(&self) -> &Store {
        &self.store
    }

    /// Adds a reminder made through the form. `time` is local `HH:MM`; a `none` reminder is due at the next such time.
    pub fn add(&mut self, text: &str, time: &str, repeat: Repeat, now_ms: i64, tz: &dyn Tz) -> Result<Reminder, StoreError> {
        self.add_with_rule(text, time, repeat, Rule::default(), now_ms, tz)
    }

    /// `add` for monthly, yearly and interval rows. An interval's anchor is the next `time` after now (the first slot), unless the
    /// rule carries one.
    pub fn add_with_rule(&mut self, text: &str, time: &str, repeat: Repeat, mut rule: Rule, now_ms: i64, tz: &dyn Tz) -> Result<Reminder, StoreError> {
        let text = clean_text(text).ok_or(StoreError::BadText)?;
        let (hh, mm) = parse_hhmm(time).ok_or(StoreError::BadTime)?;
        let at_ms = (repeat == Repeat::None).then(|| next_daily_after(tz, hh, mm, now_ms));
        if repeat == Repeat::Interval && rule.anchor_ms.is_none() {
            rule.anchor_ms = Some(next_daily_after(tz, hh, mm, now_ms));
        }
        let id = loop {
            self.seq += 1;
            let id = format!("r-{now_ms}-{}", self.seq);
            if !self.store.list().iter().any(|r| r.id == id) {
                break id;
            }
        };
        let r = Reminder {
            id, text, time: time.to_string(), repeat, at_ms, created_ms: now_ms, last_fired_ms: None, done: false,
            tool: TOOL_SPEAK.to_string(), rule,
        };
        self.store.add(r.clone())?;
        Ok(r)
    }

    pub fn delete(&mut self, id: &str) -> Result<(), StoreError> {
        self.decided.remove(id);
        self.stagger.remove(id);
        self.store.delete(id)
    }

    /// The reminders that fire now. Each is recorded as fired (and saved) before this returns.
    ///
    /// Quiet hours: a due reminder inside the window is left untouched, so it is still due on the first tick after the
    /// window ends and fires then, once.
    pub fn tick(&mut self, now_ms: i64, tz: &dyn Tz, quiet: &dyn Fn() -> Quiet) -> Result<Vec<Fire>, StoreError> {
        let mut quiet_now: Option<Quiet> = None;
        let mut fires = Vec::new();
        let mut changed = false;
        let Engine { store, audit, decided, history, history_error, stagger, .. } = self;
        let mut late_starts = 0usize;
        // Rows are mutated in memory first and saved at the end; a failed save puts them back, so memory never says "fired" while the file
        // says "not fired" (the fire would be lost until a restart).
        let backup = store.list().to_vec();
        let mut decided_now: Vec<(String, bool)> = Vec::new();
        // History lines for decisions that end a routine's turn here (a missed row, a refusal). Written only once the save stuck, so a
        // retried tick does not write them twice.
        let mut pending: Vec<HistoryEntry> = Vec::new();
        for r in store.rows_mut().iter_mut() {
            let Some(due) = due_ms(tz, r, now_ms) else { continue };
            if due > now_ms {
                continue;
            }
            let q = *quiet_now.get_or_insert_with(|| quiet());
            if q.contains(tz, now_ms) {
                continue;
            }
            // A long absence: the newest occurrence that passed is the one that may run; the older ones fold behind it. Later than 12 hours
            // (quiet hours not counted) nothing runs: one missed row stands for all of them.
            let cu = catch_up(tz, r, due, now_ms);
            let entry = |status: HistoryStatus, missed: u32| HistoryEntry { at_ms: now_ms, id: r.id.clone(), text: r.text.clone(), scheduled_ms: cu.newest, status, missed };
            if late_ms(tz, q, cu.newest, now_ms) > CATCH_UP_MS {
                pending.push(entry(HistoryStatus::Missed, cu.older.saturating_add(1)));
                r.last_fired_ms = Some(now_ms);
                if r.repeat == Repeat::None {
                    r.done = true;
                }
                changed = true;
                continue;
            }
            // Upstream `routine-catch-up.ts` `staggered`: a start more than 2 minutes after its time is a late start, and the late starts found in one
            // pass begin 15 s apart (the first at once) over at most 40 steps, so a long downtime does not speak every routine in the same second.
            if now_ms - due > LATE_START_MS {
                match stagger.get(&r.id) {
                    Some(&until) if now_ms >= until => {
                        stagger.remove(&r.id);
                    }
                    Some(_) => continue,
                    None => {
                        let step = (late_starts % STAGGER_STEPS) as i64;
                        late_starts += 1;
                        if step > 0 {
                            stagger.insert(r.id.clone(), now_ms + step * STAGGER_MS);
                            continue;
                        }
                    }
                }
            } else {
                stagger.remove(&r.id);
            }
            // The one door: a routine only runs a tool the gate allows. A refused routine is finished (it must not be
            // asked again every second); one whose decision could not be logged is left untouched and retried.
            let verdict = match decided.remove(&r.id) {
                Some(true) => Verdict::Allowed,
                Some(false) => Verdict::Refused,
                None => authorize(audit.as_ref(), &r.id, &r.tool),
            };
            match verdict {
                Verdict::NotLogged => continue,
                Verdict::Refused => {
                    decided_now.push((r.id.clone(), false));
                    if cu.older > 0 {
                        pending.push(entry(HistoryStatus::Missed, cu.older));
                    }
                    pending.push(entry(HistoryStatus::Refused, 0));
                    r.last_fired_ms = Some(now_ms);
                    if r.repeat == Repeat::None {
                        r.done = true;
                    }
                    changed = true;
                    continue;
                }
                Verdict::Allowed => decided_now.push((r.id.clone(), true)),
            }
            fires.push(Fire {
                id: r.id.clone(), text: r.text.clone(), due_ms: cu.newest, older_missed: cu.older, prev_last_fired_ms: r.last_fired_ms, prev_done: r.done,
            });
            r.last_fired_ms = Some(now_ms);
            if r.repeat == Repeat::None {
                r.done = true;
            }
            changed = true;
        }
        let before = store.list().len();
        store.rows_mut().retain(|r| !(r.done && r.last_fired_ms.is_some_and(|t| now_ms - t > DONE_KEEP_MS)));
        changed |= store.list().len() != before;
        if changed {
            if let Err(e) = store.save() {
                *store.rows_mut() = backup;
                decided.extend(decided_now);
                return Err(e);
            }
        }
        for e in pending {
            if let Err(e) = history.append(e) {
                *history_error = Some(e);
            }
        }
        Ok(fires)
    }

    /// True when a routine is due within `horizon_ms` after `now_ms`. Not one that is already overdue (held back by quiet hours, or taken back
    /// until the speaker is ready: the PC is not kept awake all night for it) and not a finished one-shot.
    pub fn due_soon(&self, now_ms: i64, tz: &dyn Tz, horizon_ms: i64) -> bool {
        self.store.list().iter().any(|r| due_ms(tz, r, now_ms).is_some_and(|d| d > now_ms && d <= now_ms + horizon_ms))
    }

    /// The speaker took this fire: one `fired` line in the history. Called by the runner after the hand-over, not by `tick`, so a fire
    /// that is taken back and retried is logged once, when it is finally spoken.
    pub fn record_fired(&mut self, fire: &Fire, now_ms: i64) -> Result<(), StoreError> {
        let line = |status: HistoryStatus, missed: u32| HistoryEntry { at_ms: now_ms, id: fire.id.clone(), text: fire.text.clone(), scheduled_ms: fire.due_ms, status, missed };
        if fire.older_missed > 0 {
            self.history.append(line(HistoryStatus::Missed, fire.older_missed))?;
        }
        self.history.append(line(HistoryStatus::Fired, 0))
    }

    /// Takes a fire back (the speech could not be handed over): the reminder is due again on the next tick.
    pub fn undo(&mut self, fire: &Fire) -> Result<(), StoreError> {
        if let Some(r) = self.store.rows_mut().iter_mut().find(|r| r.id == fire.id) {
            r.last_fired_ms = fire.prev_last_fired_ms;
            r.done = fire.prev_done;
            self.decided.insert(fire.id.clone(), true);
            self.store.save()?;
        }
        Ok(())
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::clock::tests::{ho_chi_minh, new_york};
    use crate::clock::utc_ms;
    use crate::store::tests::tmp_dir;

    pub fn quiet_off() -> Quiet {
        Quiet { on: false, ..Quiet::DEFAULT }
    }

    /// 2026-11-11 `h:m:s` local time in Ho Chi Minh (+7), as unix ms.
    pub fn hcm(h: u32, m: u32, s: u32) -> i64 {
        utc_ms(2026, 11, 11, h, m, s) - 7 * 3_600_000
    }

    pub fn engine(name: &str) -> (Engine, std::path::PathBuf) {
        let d = tmp_dir(name);
        let audit = zumi_audit::Audit::open(&d.join("audit.jsonl")).unwrap();
        (Engine::new(Store::open(&d).unwrap(), Box::new(audit)).unwrap(), d)
    }

    #[test]
    fn a_reminder_fires_at_its_minute_once_and_not_before() {
        let tz = ho_chi_minh();
        let (mut e, d) = engine("ontime");
        e.add("drink water", "15:00", Repeat::None, hcm(14, 58, 0), &tz).unwrap();
        let q = || quiet_off();
        assert!(e.tick(hcm(14, 59, 59), &tz, &q).unwrap().is_empty());
        let fires = e.tick(hcm(15, 0, 0), &tz, &q).unwrap();
        assert_eq!(fires.len(), 1);
        assert_eq!(fires[0].text, "drink water");
        assert_eq!(fires[0].due_ms, hcm(15, 0, 0));
        assert!(e.tick(hcm(15, 0, 1), &tz, &q).unwrap().is_empty());
        assert!(e.tick(hcm(15, 5, 0), &tz, &q).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_reminder_inside_quiet_hours_stays_silent_until_they_end_then_fires_once() {
        let tz = ho_chi_minh();
        let (mut e, d) = engine("quiet");
        // Quiet 22:30-07:30 (the default). A reminder for 23:00.
        e.add("late one", "23:00", Repeat::None, hcm(22, 0, 0), &tz).unwrap();
        let q = || Quiet::DEFAULT;
        assert!(e.tick(hcm(22, 59, 59), &tz, &q).unwrap().is_empty()); // not due yet
        for (h, m, s) in [(23, 0, 0), (23, 30, 0), (3, 0, 0), (7, 29, 59)] {
            let now = if h < 8 { hcm(h, m, s) + DAY_MS } else { hcm(h, m, s) };
            assert!(e.tick(now, &tz, &q).unwrap().is_empty(), "{h}:{m}:{s} is inside quiet hours");
        }
        let end = hcm(7, 30, 0) + DAY_MS;
        let fires = e.tick(end, &tz, &q).unwrap();
        assert_eq!(fires.len(), 1, "fires when quiet hours end");
        assert_eq!(fires[0].text, "late one");
        assert!(e.tick(end + 1000, &tz, &q).unwrap().is_empty(), "once");
        assert!(e.tick(end + 3_600_000, &tz, &q).unwrap().is_empty(), "still once");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn the_same_reminder_with_quiet_hours_off_fires_at_its_minute() {
        let tz = ho_chi_minh();
        let (mut e, d) = engine("quietoff");
        e.add("late one", "23:00", Repeat::None, hcm(22, 0, 0), &tz).unwrap();
        let q = || quiet_off();
        let fires = e.tick(hcm(23, 0, 0), &tz, &q).unwrap();
        assert_eq!(fires.len(), 1);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_daily_reminder_held_by_quiet_hours_fires_once_that_night_and_the_next_evening() {
        let tz = ho_chi_minh();
        let (mut e, d) = engine("dailyquiet");
        e.add("night owl", "23:00", Repeat::Daily, hcm(12, 0, 0), &tz).unwrap();
        let q = || Quiet::DEFAULT;
        assert!(e.tick(hcm(23, 0, 0), &tz, &q).unwrap().is_empty());
        let morning = hcm(7, 30, 0) + DAY_MS;
        assert_eq!(e.tick(morning, &tz, &q).unwrap().len(), 1);
        assert!(e.tick(morning + 60_000, &tz, &q).unwrap().is_empty());
        // The evening after: due 23:00 again, inside quiet again, so it waits again.
        assert!(e.tick(hcm(23, 0, 0) + DAY_MS, &tz, &q).unwrap().is_empty());
        assert_eq!(e.tick(hcm(7, 30, 0) + 2 * DAY_MS, &tz, &q).unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn quiet_hours_read_from_settings_with_the_schedulers_defaults() {
        let tz = ho_chi_minh();
        let at = |h, m| hcm(h, m, 0);
        let default = Quiet::from_settings(&serde_json::json!({}));
        assert_eq!(default, Quiet::DEFAULT);
        assert!(default.contains(&tz, at(23, 0)) && default.contains(&tz, at(7, 29)));
        assert!(!default.contains(&tz, at(7, 30)) && !default.contains(&tz, at(22, 29)) && default.contains(&tz, at(22, 30)));
        let custom = Quiet::from_settings(&serde_json::json!({"talkQuietHours": {"on": true, "start": "12:00", "end": "13:00"}}));
        assert!(custom.contains(&tz, at(12, 30)) && !custom.contains(&tz, at(13, 0)) && !custom.contains(&tz, at(23, 0)));
        let off = Quiet::from_settings(&serde_json::json!({"talkQuietHours": {"on": false, "start": "12:00", "end": "13:00"}}));
        assert!(!off.contains(&tz, at(12, 30)));
        for bad in [
            serde_json::json!({"talkQuietHours": {"on": true, "start": "12:00", "end": "12:00"}}),
            serde_json::json!({"talkQuietHours": {"on": true, "start": "25:00", "end": "07:00"}}),
            serde_json::json!({"talkQuietHours": {"on": "yes", "start": "22:00", "end": "07:00"}}),
            serde_json::json!({"talkQuietHours": "always"}),
        ] {
            assert_eq!(Quiet::from_settings(&bad), Quiet::DEFAULT, "{bad}");
        }
    }

    #[test]
    fn quiet_hours_follow_the_local_wall_clock_across_dst() {
        let tz = new_york();
        let q = Quiet::DEFAULT; // 22:30-07:30 local
        // 2026-03-08 06:00Z is 01:00 EST: inside. 12:00Z the same day is 08:00 EDT: outside.
        assert!(q.contains(&tz, utc_ms(2026, 3, 8, 6, 0, 0)));
        assert!(!q.contains(&tz, utc_ms(2026, 3, 8, 12, 0, 0)));
        // 11:30Z is 07:30 EDT on the 8th (outside); 10:59Z is 06:59 EDT (inside).
        assert!(!q.contains(&tz, utc_ms(2026, 3, 8, 11, 30, 0)) && q.contains(&tz, utc_ms(2026, 3, 8, 10, 59, 0)));
    }

    /// Local (Ho Chi Minh, +7) wall clock of any date, as unix ms.
    pub fn lt(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> i64 {
        utc_ms(y, mo, d, h, mi, 0) - 7 * 3_600_000
    }

    fn rule_day(day: u32) -> Rule {
        Rule { day: Some(day), ..Rule::default() }
    }

    fn hist(e: &Engine) -> Vec<(HistoryStatus, u32, String)> {
        e.history().list(None, 100).iter().rev().map(|h| (h.status, h.missed, h.text.clone())).collect()
    }

    #[test]
    fn a_monthly_reminder_fires_on_its_day_once_and_the_month_after() {
        let tz = ho_chi_minh();
        let (mut e, d) = engine("monthly");
        let r = e.add_with_rule("pay rent", "09:00", Repeat::Monthly, rule_day(1), lt(2026, 11, 11, 8, 0), &tz).unwrap();
        assert_eq!(r.rule.day, Some(1));
        let q = || quiet_off();
        assert!(e.tick(lt(2026, 11, 30, 23, 0), &tz, &q).unwrap().is_empty(), "not before its day");
        let fires = e.tick(lt(2026, 12, 1, 9, 0), &tz, &q).unwrap();
        assert_eq!(fires.len(), 1);
        assert_eq!(fires[0].due_ms, lt(2026, 12, 1, 9, 0));
        assert!(e.tick(lt(2026, 12, 1, 9, 0) + 1_000, &tz, &q).unwrap().is_empty());
        assert!(e.tick(lt(2026, 12, 31, 23, 0), &tz, &q).unwrap().is_empty());
        assert_eq!(e.tick(lt(2027, 1, 1, 9, 0), &tz, &q).unwrap().len(), 1);
        assert!(!e.store().list()[0].done, "a monthly one is never finished");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_yearly_reminder_fires_on_its_date_once_a_year() {
        let tz = ho_chi_minh();
        let (mut e, d) = engine("yearly");
        e.add_with_rule("mum's birthday", "09:00", Repeat::Yearly, Rule { month: Some(12), day: Some(25), ..Rule::default() }, lt(2026, 11, 11, 8, 0), &tz).unwrap();
        let q = || quiet_off();
        assert!(e.tick(lt(2026, 12, 24, 9, 0), &tz, &q).unwrap().is_empty());
        assert_eq!(e.tick(lt(2026, 12, 25, 9, 0), &tz, &q).unwrap().len(), 1);
        assert!(e.tick(lt(2027, 6, 1, 9, 0), &tz, &q).unwrap().is_empty());
        assert_eq!(e.tick(lt(2027, 12, 25, 9, 0), &tz, &q).unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn an_interval_starts_at_its_time_then_repeats_every_n_minutes() {
        let tz = ho_chi_minh();
        let (mut e, d) = engine("interval");
        let rule = Rule { every_min: Some(90), ..Rule::default() };
        let r = e.add_with_rule("stretch", "08:00", Repeat::Interval, rule, lt(2026, 11, 11, 7, 0), &tz).unwrap();
        assert_eq!(r.rule.anchor_ms, Some(lt(2026, 11, 11, 8, 0)), "the first slot is the next 08:00");
        let q = || quiet_off();
        assert!(e.tick(lt(2026, 11, 11, 7, 59), &tz, &q).unwrap().is_empty());
        assert_eq!(e.tick(lt(2026, 11, 11, 8, 0), &tz, &q).unwrap().len(), 1);
        assert!(e.tick(lt(2026, 11, 11, 9, 29), &tz, &q).unwrap().is_empty());
        assert_eq!(e.tick(lt(2026, 11, 11, 9, 30), &tz, &q).unwrap().len(), 1);
        assert_eq!(e.tick(lt(2026, 11, 11, 11, 0), &tz, &q).unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn several_missed_interval_slots_are_one_fire_for_the_newest_and_one_missed_row_for_the_older() {
        let tz = ho_chi_minh();
        let (mut e, d) = engine("fold");
        let rule = Rule { every_min: Some(90), ..Rule::default() };
        e.add_with_rule("stretch", "08:00", Repeat::Interval, rule, lt(2026, 11, 11, 7, 0), &tz).unwrap();
        let q = || quiet_off();
        assert_eq!(e.tick(lt(2026, 11, 11, 8, 0), &tz, &q).unwrap().len(), 1);
        // The app was off: slots 09:30, 11:00 and 12:30 passed; it is 12:40.
        let fires = e.tick(lt(2026, 11, 11, 12, 40), &tz, &q).unwrap();
        assert_eq!(fires.len(), 1, "one fire, not three");
        assert_eq!(fires[0].due_ms, lt(2026, 11, 11, 12, 30), "for the newest slot");
        assert!(e.history().is_empty(), "the folded row is written when the fire is spoken, so a taken-back fire does not write it twice");
        e.record_fired(&fires[0], lt(2026, 11, 11, 12, 40)).unwrap();
        assert_eq!(hist(&e), [(HistoryStatus::Missed, 2, "stretch".to_string()), (HistoryStatus::Fired, 0, "stretch".to_string())], "the two older ones fold into one Missed 2 row");
        assert!(e.tick(lt(2026, 11, 11, 12, 41), &tz, &q).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&d);
    }

    /// Upstream `routine-catch-up.ts`: "Late starts found in one scheduler pass are spread out, so a long downtime does not start every routine in the
    /// same second." A run more than CATCH_UP_LATE_MS (2 min) after its time is a late start; in one pass the first starts at once and each next
    /// one CATCH_UP_STAGGER_MS (15 s) later, over at most CATCH_UP_STAGGER_STEPS (40) steps.
    #[test]
    fn routines_found_late_in_one_pass_start_fifteen_seconds_apart_and_on_time_ones_start_together() {
        let tz = ho_chi_minh();
        let q = || quiet_off();
        let (mut e, d) = engine("stagger");
        for t in ["one", "two", "three"] {
            e.add(t, "10:00", Repeat::Daily, lt(2026, 11, 11, 9, 0), &tz).unwrap();
        }
        let ten_thirty = lt(2026, 11, 11, 10, 30);
        let texts = |f: Vec<Fire>| f.into_iter().map(|f| f.text).collect::<Vec<_>>();
        assert_eq!(texts(e.tick(ten_thirty, &tz, &q).unwrap()), ["one"], "30 min late (the computer was off): the first starts at once");
        assert!(e.tick(ten_thirty + 14_999, &tz, &q).unwrap().is_empty(), "the next waits 15 s");
        assert_eq!(texts(e.tick(ten_thirty + 15_000, &tz, &q).unwrap()), ["two"]);
        assert!(e.tick(ten_thirty + 29_999, &tz, &q).unwrap().is_empty());
        assert_eq!(texts(e.tick(ten_thirty + 30_000, &tz, &q).unwrap()), ["three"], "the third 30 s after the first");
        assert!(e.tick(ten_thirty + 45_000, &tz, &q).unwrap().is_empty(), "each fires once");
        let _ = std::fs::remove_dir_all(&d);
        // pass twin: within 2 minutes of their time they are not late, so they all start together
        let (mut e, d) = engine("nostagger");
        for t in ["one", "two", "three"] {
            e.add(t, "10:00", Repeat::Daily, lt(2026, 11, 11, 9, 0), &tz).unwrap();
        }
        assert_eq!(texts(e.tick(lt(2026, 11, 11, 10, 2), &tz, &q).unwrap()), ["one", "two", "three"], "2 min late is not a late start");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_run_more_than_twelve_hours_late_is_a_missed_row_and_is_not_spoken() {
        let tz = ho_chi_minh();
        let (mut e, d) = engine("late12");
        e.add("stretch", "15:00", Repeat::Daily, lt(2026, 11, 11, 14, 0), &tz).unwrap();
        let q = || quiet_off();
        // 12 hours exactly is still a fire.
        let mut on_time = engine("late12b");
        on_time.0.add("stretch", "15:00", Repeat::Daily, lt(2026, 11, 11, 14, 0), &tz).unwrap();
        assert_eq!(on_time.0.tick(lt(2026, 11, 12, 3, 0), &tz, &q).unwrap().len(), 1, "12 h late is the last one still run");
        // 12 h and one millisecond: missed, nothing spoken.
        assert!(e.tick(lt(2026, 11, 12, 3, 0) + 1, &tz, &q).unwrap().is_empty());
        assert_eq!(hist(&e), [(HistoryStatus::Missed, 1, "stretch".to_string())]);
        assert_eq!(e.history().list(None, 1)[0].scheduled_ms, lt(2026, 11, 11, 15, 0));
        // It is moved on: the next one is the next 15:00, and nothing more is written for the old one.
        assert!(e.tick(lt(2026, 11, 12, 3, 1), &tz, &q).unwrap().is_empty());
        assert_eq!(e.history().len(), 1);
        assert_eq!(e.tick(lt(2026, 11, 12, 15, 0), &tz, &q).unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(&d);
        let _ = std::fs::remove_dir_all(&on_time.1);
    }

    #[test]
    fn a_one_shot_that_is_over_twelve_hours_late_is_missed_and_finished() {
        let tz = ho_chi_minh();
        let (mut e, d) = engine("late12once");
        e.add("call mum", "15:00", Repeat::None, lt(2026, 11, 11, 14, 0), &tz).unwrap();
        assert!(e.tick(lt(2026, 11, 12, 9, 0), &tz, &|| quiet_off()).unwrap().is_empty());
        assert!(e.store().list()[0].done);
        assert_eq!(hist(&e), [(HistoryStatus::Missed, 1, "call mum".to_string())]);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn the_hours_held_by_quiet_hours_do_not_count_as_late() {
        let tz = ho_chi_minh();
        let (mut e, d) = engine("quietlate");
        let q = || Quiet { on: true, start_min: 20 * 60, end_min: 9 * 60 }; // 20:00 to 09:00, thirteen hours
        e.add("evening", "20:30", Repeat::None, lt(2026, 11, 11, 20, 0), &tz).unwrap();
        // 12.5 h after its time, but all of it inside quiet hours: it speaks now.
        assert!(e.tick(lt(2026, 11, 12, 8, 59), &tz, &q).unwrap().is_empty(), "still quiet");
        assert_eq!(e.tick(lt(2026, 11, 12, 9, 0), &tz, &q).unwrap().len(), 1);
        assert!(e.history().is_empty());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_fire_that_was_handed_over_is_in_the_history_and_a_refusal_is_too() {
        let tz = ho_chi_minh();
        let (mut e, d) = engine("histfire");
        e.add("drink water", "15:00", Repeat::None, lt(2026, 11, 11, 14, 0), &tz).unwrap();
        e.store.add(one_shot_with_tool("bad", "hands.click", lt(2026, 11, 11, 15, 0))).unwrap();
        let fires = e.tick(lt(2026, 11, 11, 15, 0), &tz, &|| quiet_off()).unwrap();
        assert_eq!(fires.len(), 1);
        assert_eq!(hist(&e), [(HistoryStatus::Refused, 0, "do it".to_string())], "the refusal is logged at once, the fire only when it is spoken");
        e.record_fired(&fires[0], lt(2026, 11, 11, 15, 0)).unwrap();
        assert_eq!(hist(&e).len(), 2);
        let last = &e.history().list(None, 1)[0];
        assert_eq!((last.status, last.text.as_str(), last.scheduled_ms), (HistoryStatus::Fired, "drink water", lt(2026, 11, 11, 15, 0)));
        // survives a reopen
        let again = History::open(&d).unwrap();
        assert_eq!(again.len(), 2);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_failed_save_writes_no_history_and_the_retry_writes_one_line() {
        let tz = ho_chi_minh();
        let (mut e, d) = engine("histfail");
        e.add("late", "15:00", Repeat::None, lt(2026, 11, 11, 14, 0), &tz).unwrap();
        let tmp = d.join("reminders.json.tmp");
        std::fs::create_dir_all(&tmp).unwrap();
        for s in 0..3 {
            assert!(e.tick(lt(2026, 11, 12, 9, 0) + s, &tz, &|| quiet_off()).is_err());
            assert!(e.history().is_empty(), "nothing is logged for a decision that did not stick");
        }
        std::fs::remove_dir_all(&tmp).unwrap();
        assert!(e.tick(lt(2026, 11, 12, 9, 0) + 5, &tz, &|| quiet_off()).unwrap().is_empty());
        assert_eq!(e.history().len(), 1);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_fire_taken_back_is_due_again_and_an_ordinary_fire_is_not() {
        let tz = ho_chi_minh();
        let (mut e, d) = engine("undo");
        e.add("hand over", "15:00", Repeat::None, hcm(14, 0, 0), &tz).unwrap();
        let q = || quiet_off();
        let fires = e.tick(hcm(15, 0, 0), &tz, &q).unwrap();
        assert!(e.tick(hcm(15, 0, 1), &tz, &q).unwrap().is_empty());
        e.undo(&fires[0]).unwrap();
        assert_eq!(e.tick(hcm(15, 0, 2), &tz, &q).unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_fire_retried_until_the_speaker_is_ready_is_audited_once() {
        let tz = ho_chi_minh();
        let (mut e, d) = engine("retryaudit");
        e.add("patient", "15:00", Repeat::None, hcm(14, 0, 0), &tz).unwrap();
        let q = || quiet_off();
        for s in 0..3 {
            let fires = e.tick(hcm(15, 0, s), &tz, &q).unwrap();
            assert_eq!(fires.len(), 1);
            e.undo(&fires[0]).unwrap(); // the speaker was not ready
        }
        assert_eq!(e.tick(hcm(15, 0, 3), &tz, &q).unwrap().len(), 1); // ready now
        assert!(e.tick(hcm(15, 0, 4), &tz, &q).unwrap().is_empty());
        let lines = crate::gate::tests::read_lines(&d.join("audit.jsonl"));
        assert_eq!(lines.len(), 1, "one decision, one audit line, four attempts");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_failed_save_does_not_lose_the_fire_it_is_retried_and_audited_once() {
        let tz = ho_chi_minh();
        let (mut e, d) = engine("failsave");
        e.add("keep me", "15:00", Repeat::None, hcm(14, 0, 0), &tz).unwrap();
        let q = || quiet_off();
        // The disk refuses the write: a directory sits where the temp file goes.
        let tmp = d.join("reminders.json.tmp");
        std::fs::create_dir_all(&tmp).unwrap();
        for s in 0..3 {
            assert!(e.tick(hcm(15, 0, s), &tz, &q).is_err(), "the failure is surfaced, not swallowed");
            assert!(!e.store().list()[0].done && e.store().list()[0].last_fired_ms.is_none(), "memory still says not fired");
        }
        std::fs::remove_dir_all(&tmp).unwrap();
        assert_eq!(e.tick(hcm(15, 0, 4), &tz, &q).unwrap().len(), 1, "fires once the disk works again");
        assert!(e.tick(hcm(15, 0, 5), &tz, &q).unwrap().is_empty());
        assert_eq!(crate::gate::tests::read_lines(&d.join("audit.jsonl")).len(), 1, "one decision, one audit line");
        // A failed add or delete leaves memory equal to the file.
        std::fs::create_dir_all(&tmp).unwrap();
        assert!(e.add("lost add", "16:00", Repeat::None, hcm(15, 1, 0), &tz).is_err());
        assert_eq!(e.store().list().len(), 1);
        assert!(e.delete(&e.store().list()[0].id.clone()).is_err());
        assert_eq!(e.store().list().len(), 1);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_finished_one_shot_is_removed_a_day_later() {
        let tz = ho_chi_minh();
        let (mut e, d) = engine("prune");
        e.add("once", "15:00", Repeat::None, hcm(14, 0, 0), &tz).unwrap();
        let q = || quiet_off();
        e.tick(hcm(15, 0, 0), &tz, &q).unwrap();
        assert_eq!(e.store().list().len(), 1);
        assert!(e.store().list()[0].done);
        e.tick(hcm(15, 0, 0) + DAY_MS - 1, &tz, &q).unwrap();
        assert_eq!(e.store().list().len(), 1);
        e.tick(hcm(15, 0, 0) + DAY_MS + 1, &tz, &q).unwrap();
        assert!(e.store().list().is_empty());
        let _ = std::fs::remove_dir_all(&d);
    }

    fn one_shot_with_tool(id: &str, tool: &str, at_ms: i64) -> Reminder {
        let mut r = crate::store::tests::sample(id, "do it", "15:00");
        r.repeat = Repeat::None;
        r.at_ms = Some(at_ms);
        r.tool = tool.to_string();
        r
    }

    #[test]
    fn ten_routines_naming_a_hands_or_pack_tool_are_refused_ten_of_ten_and_nothing_is_spoken() {
        let tz = ho_chi_minh();
        let (mut e, d) = engine("refuse10");
        let tools = [
            "hands.click", "hands.type", "hands.key", "hands.launch", "hands.snapshot", "pack.shell", "pack.adb", "pack.browser-hands",
            "power.shell", "pack.run",
        ];
        for (i, t) in tools.iter().enumerate() {
            e.store.add(one_shot_with_tool(&format!("p{i}"), t, hcm(15, 0, 0))).unwrap();
        }
        let q = || quiet_off();
        let fires = e.tick(hcm(15, 0, 0), &tz, &q).unwrap();
        assert!(fires.is_empty(), "no routine with a forbidden tool may reach the speaker");
        let lines = crate::gate::tests::read_lines(&d.join("audit.jsonl"));
        assert_eq!(lines.len(), 10);
        assert!(lines.iter().all(|l| l["decision"] == "refused" && l["code"] == "routine_tool_refused"));
        // Each is finished: a second and third tick neither speak nor add audit lines.
        assert!(e.tick(hcm(15, 0, 1), &tz, &q).unwrap().is_empty());
        assert!(e.tick(hcm(15, 1, 0), &tz, &q).unwrap().is_empty());
        assert_eq!(crate::gate::tests::read_lines(&d.join("audit.jsonl")).len(), 10);
        assert!(e.store().list().iter().all(|r| r.done));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn ten_routines_naming_speak_all_fire_and_are_logged_as_allowed() {
        let tz = ho_chi_minh();
        let (mut e, d) = engine("allow10");
        for i in 0..10 {
            e.store.add(one_shot_with_tool(&format!("s{i}"), "speak", hcm(15, 0, 0))).unwrap();
        }
        let fires = e.tick(hcm(15, 0, 0), &tz, &|| quiet_off()).unwrap();
        assert_eq!(fires.len(), 10);
        let lines = crate::gate::tests::read_lines(&d.join("audit.jsonl"));
        assert_eq!(lines.len(), 10);
        assert!(lines.iter().all(|l| l["decision"] == "allowed"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_stored_hands_routine_does_not_block_the_speak_routine_next_to_it() {
        let tz = ho_chi_minh();
        let (mut e, d) = engine("mixed");
        e.store.add(one_shot_with_tool("bad", "hands.click", hcm(15, 0, 0))).unwrap();
        e.store.add(one_shot_with_tool("good", "speak", hcm(15, 0, 0))).unwrap();
        let fires = e.tick(hcm(15, 0, 0), &tz, &|| quiet_off()).unwrap();
        assert_eq!(fires.iter().map(|f| f.id.as_str()).collect::<Vec<_>>(), ["good"]);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_routine_whose_decision_cannot_be_logged_does_not_run_and_is_retried() {
        let tz = ho_chi_minh();
        let d = tmp_dir("nolog");
        let mut e = Engine::new(Store::open(&d).unwrap(), Box::new(crate::gate::tests::FailingAudit)).unwrap();
        e.store.add(one_shot_with_tool("a", "speak", hcm(15, 0, 0))).unwrap();
        assert!(e.tick(hcm(15, 0, 0), &tz, &|| quiet_off()).unwrap().is_empty());
        assert!(!e.store().list()[0].done, "left untouched, so it is retried when the log works again");
        let audit = zumi_audit::Audit::open(&d.join("audit.jsonl")).unwrap();
        e.audit = Box::new(audit);
        assert_eq!(e.tick(hcm(15, 0, 5), &tz, &|| quiet_off()).unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(&d);
    }
}
