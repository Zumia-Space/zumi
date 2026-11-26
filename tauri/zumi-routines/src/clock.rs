//! Next-fire rules. Pure functions over an injected `Tz`, so DST and clock changes are tested without touching the real
//! clock or the real time zone.
//!
//! Rules (the README lists them too):
//! - A daily reminder is a local wall-clock time. Its next fire is the first instant strictly after the anchor whose
//!   local time is that `HH:MM`. The anchor is the last fire, or the creation time before the first fire.
//! - A local time that does not exist (spring forward gap) fires at the same offset the day before the change used, which
//!   lands just after the gap (02:30 becomes 03:30).
//! - A local time that happens twice (fall back fold) fires at its FIRST occurrence only. The second one is never a
//!   candidate, so one day never fires twice.
//! - A one-shot reminder stores the absolute instant; the wall clock changing afterwards does not move it.
//! - An anchor far in the future (more than 36 h after `now`) means the clock was set back a lot, or the file is wrong:
//!   it is replaced by `now`, so a daily reminder is never frozen for months. A smaller step back keeps the anchor, so
//!   a clock set back by a few minutes or an hour (NTP, a manual fix, resume) cannot fire the same day twice.
use crate::store::{parse_hhmm, Reminder, Repeat, Rule, LAST_DAY};

pub const DAY_MS: i64 = 86_400_000;
/// An anchor later than `now` by more than this is treated as bogus.
pub const MAX_FUTURE_ANCHOR_MS: i64 = 36 * 3_600_000;

/// Local time zone: the UTC offset in force at an instant.
pub trait Tz {
    fn offset_ms(&self, utc_ms: i64) -> i64;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LocalTime {
    pub y: i32,
    pub mo: u32,
    pub d: u32,
    pub h: u32,
    pub mi: u32,
    pub s: u32,
}

/// Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant's algorithm).
pub fn days_from_civil(y: i32, m: u32, d: u32) -> i64 {
    let y = i64::from(y) - i64::from(m <= 2);
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (i64::from(m) + 9) % 12;
    let doy = (153 * mp + 2) / 5 + i64::from(d) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

pub fn civil_from_days(z: i64) -> (i32, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    ((y + i64::from(m <= 2)) as i32, m, d)
}

pub fn to_local(tz: &dyn Tz, utc_ms: i64) -> LocalTime {
    let local = utc_ms + tz.offset_ms(utc_ms);
    let days = local.div_euclid(DAY_MS);
    let ms = local.rem_euclid(DAY_MS);
    let (y, mo, d) = civil_from_days(days);
    let secs = (ms / 1000) as u32;
    LocalTime { y, mo, d, h: secs / 3600, mi: secs % 3600 / 60, s: secs % 60 }
}

/// The unix ms of a UTC calendar time. Test and diagnostics helper.
pub fn utc_ms(y: i32, mo: u32, d: u32, h: u32, mi: u32, s: u32) -> i64 {
    days_from_civil(y, mo, d) * DAY_MS + (i64::from(h) * 3600 + i64::from(mi) * 60 + i64::from(s)) * 1000
}

#[derive(Debug, PartialEq, Eq)]
enum Resolved {
    One(i64),
    /// The local time does not exist; this is the instant it is moved to.
    Gap(i64),
    /// The local time happens twice; (first, second).
    Fold(i64, i64),
}

fn resolve_local(tz: &dyn Tz, local_ms: i64) -> Resolved {
    // Offsets change at most once near a given local time, so one probe a day either side sees both.
    let before = tz.offset_ms(local_ms - DAY_MS);
    let after = tz.offset_ms(local_ms + DAY_MS);
    let mut valid: Vec<i64> = [before, after]
        .iter()
        .map(|o| local_ms - o)
        .filter(|u| tz.offset_ms(*u) == local_ms - u)
        .collect();
    valid.sort_unstable();
    valid.dedup();
    match valid.as_slice() {
        [one] => Resolved::One(*one),
        [first, second] => Resolved::Fold(*first, *second),
        _ => Resolved::Gap(local_ms - before),
    }
}

/// The first instant strictly after `after_ms` whose local wall clock reads `hh:mm`, one fire per local day.
pub fn next_daily_after(tz: &dyn Tz, hh: u32, mm: u32, after_ms: i64) -> i64 {
    let l = to_local(tz, after_ms);
    let base = days_from_civil(l.y, l.mo, l.d);
    for k in 0..=2 {
        let local_ms = (base + k) * DAY_MS + (i64::from(hh) * 60 + i64::from(mm)) * 60_000;
        let at = match resolve_local(tz, local_ms) {
            Resolved::One(u) | Resolved::Gap(u) | Resolved::Fold(u, _) => u,
        };
        if at > after_ms {
            return at;
        }
    }
    after_ms + DAY_MS
}

/// The anchor a daily reminder counts from, with the bogus-future rule applied.
fn anchor_of(r: &Reminder, now_ms: i64) -> i64 {
    let anchor = r.last_fired_ms.unwrap_or(r.created_ms);
    if anchor > now_ms + MAX_FUTURE_ANCHOR_MS {
        now_ms
    } else {
        anchor
    }
}

/// Longest a month of this number can be (February: 29).
pub fn max_days_in_month(month: u32) -> u32 {
    match month {
        2 => 29,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

pub fn days_in_month(year: i32, month: u32) -> u32 {
    if month == 2 && (year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)) {
        29
    } else if month == 2 {
        28
    } else {
        max_days_in_month(month)
    }
}

/// The unix ms of local `hh:mm` on a civil date. A time inside a spring-forward gap lands just after it; a time that happens
/// twice is its first occurrence (the same rules as a daily reminder).
fn at_local(tz: &dyn Tz, y: i32, mo: u32, d: u32, hh: u32, mm: u32) -> i64 {
    let local_ms = days_from_civil(y, mo, d) * DAY_MS + (i64::from(hh) * 60 + i64::from(mm)) * 60_000;
    match resolve_local(tz, local_ms) {
        Resolved::One(u) | Resolved::Gap(u) | Resolved::Fold(u, _) => u,
    }
}

/// The first instant strictly after `after_ms` on day `day` of a month at local `hh:mm`. `day` is 1..=31 or `LAST_DAY`.
/// A month without that day is skipped (the 31st skips the shorter months; `LAST_DAY` is every month's own last day).
pub fn next_monthly_after(tz: &dyn Tz, day: u32, hh: u32, mm: u32, after_ms: i64) -> Option<i64> {
    if day > 31 {
        return None;
    }
    let l = to_local(tz, after_ms);
    let (mut y, mut m) = (l.y, l.mo);
    // Every month has a last day and a 31st turns up within three months, so a hundred years is a hard bound only.
    for _ in 0..1_200 {
        let dim = days_in_month(y, m);
        let d = if day == LAST_DAY { dim } else { day };
        if d <= dim {
            let at = at_local(tz, y, m, d, hh, mm);
            if at > after_ms {
                return Some(at);
            }
        }
        m += 1;
        if m > 12 {
            m = 1;
            y += 1;
        }
    }
    None
}

/// The first instant strictly after `after_ms` on `month`/`day` at local `hh:mm`. Feb 29 waits for the next leap year; a date
/// that never exists (Feb 30, Apr 31) has no next.
pub fn next_yearly_after(tz: &dyn Tz, month: u32, day: u32, hh: u32, mm: u32, after_ms: i64) -> Option<i64> {
    if !(1..=12).contains(&month) || day < 1 || day > max_days_in_month(month) {
        return None;
    }
    let l = to_local(tz, after_ms);
    // Leap years are at most eight years apart (2096 to 2104).
    for y in l.y..=l.y + 9 {
        if day <= days_in_month(y, month) {
            let at = at_local(tz, y, month, day, hh, mm);
            if at > after_ms {
                return Some(at);
            }
        }
    }
    None
}

/// How far an interval with days, a window or an end looks for a slot that is allowed (upstream: nine days).
const INTERVAL_SEARCH_MS: i64 = 9 * DAY_MS;

/// The first slot `anchor + k * every` strictly after `after_ms` that its weekdays, window and end allow. Slots are elapsed time from
/// the anchor, so a daylight-saving change does not move them; the weekday and the window are read on the local wall clock.
pub fn next_interval_after(tz: &dyn Tz, rule: &Rule, after_ms: i64) -> Option<i64> {
    let every = i64::from(rule.every_min?) * 60_000;
    let anchor = rule.anchor_ms?;
    if every <= 0 {
        return None;
    }
    let mut cand = if anchor > after_ms { anchor } else { anchor.checked_add(((after_ms - anchor) / every + 1).checked_mul(every)?)? };
    if rule.weekdays.is_none() && rule.window.is_none() && rule.ends_ms.is_none() {
        return Some(cand);
    }
    let window = match &rule.window {
        Some((a, b)) => {
            let (ah, am) = parse_hhmm(a)?;
            let (bh, bm) = parse_hhmm(b)?;
            Some((ah * 60 + am, bh * 60 + bm))
        }
        None => None,
    };
    for _ in 0..(INTERVAL_SEARCH_MS / every + 2) {
        if rule.ends_ms.is_some_and(|e| cand > e) {
            return None;
        }
        let l = to_local(tz, cand);
        let weekday = (days_from_civil(l.y, l.mo, l.d) + 4).rem_euclid(7) as u32; // 1970-01-01 was a Thursday; Sunday = 0
        let minute = l.h * 60 + l.mi;
        let day_ok = rule.weekdays.as_ref().map_or(true, |w| w.contains(&weekday));
        let window_ok = window.map_or(true, |(start, end)| minute >= start && minute < end);
        if day_ok && window_ok {
            return Some(cand);
        }
        cand = cand.checked_add(every)?;
    }
    None
}

/// The next occurrence strictly after `after_ms` by the schedule alone. None for a one-shot (its instant is `at_ms`).
pub fn schedule_next(tz: &dyn Tz, r: &Reminder, after_ms: i64) -> Option<i64> {
    match r.repeat {
        Repeat::None => None,
        Repeat::Daily => {
            let (hh, mm) = parse_hhmm(&r.time)?;
            Some(next_daily_after(tz, hh, mm, after_ms))
        }
        Repeat::Monthly => {
            let (hh, mm) = parse_hhmm(&r.time)?;
            next_monthly_after(tz, r.rule.day?, hh, mm, after_ms)
        }
        Repeat::Yearly => {
            let (hh, mm) = parse_hhmm(&r.time)?;
            next_yearly_after(tz, r.rule.month?, r.rule.day?, hh, mm, after_ms)
        }
        Repeat::Interval => next_interval_after(tz, &r.rule, after_ms),
    }
}

/// A run later than this after its time is not run: it is a missed row (upstream `CATCH_UP_MS`).
pub const CATCH_UP_MS: i64 = 12 * 3_600_000;
/// Occurrences counted in one catch-up; a longer absence still counts as "at least" this many.
const MAX_WALK: u32 = 20_000;

/// What a long absence leaves: the newest occurrence that has passed, and how many older ones are folded behind it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CatchUp {
    pub newest: i64,
    pub older: u32,
}

/// `due` is the first occurrence that passed. Walks the schedule up to `now`.
pub fn catch_up(tz: &dyn Tz, r: &Reminder, due: i64, now_ms: i64) -> CatchUp {
    let mut c = CatchUp { newest: due, older: 0 };
    while c.older < MAX_WALK {
        match schedule_next(tz, r, c.newest) {
            Some(n) if n <= now_ms => {
                c.newest = n;
                c.older += 1;
            }
            _ => break,
        }
    }
    c
}

/// When the reminder is next due (unix ms). None when it never fires again (a finished one-shot).
pub fn due_ms(tz: &dyn Tz, r: &Reminder, now_ms: i64) -> Option<i64> {
    match r.repeat {
        Repeat::None => {
            if r.done {
                None
            } else {
                r.at_ms
            }
        }
        _ => schedule_next(tz, r, anchor_of(r, now_ms)),
    }
}

/// The local time zone of this machine (Windows). The offset comes from the OS rules, so a DST change is followed.
#[cfg(windows)]
pub struct SystemTz;

#[cfg(windows)]
impl Tz for SystemTz {
    fn offset_ms(&self, utc: i64) -> i64 {
        use windows::Win32::Foundation::SYSTEMTIME;
        use windows::Win32::System::Time::SystemTimeToTzSpecificLocalTime;
        let days = utc.div_euclid(DAY_MS);
        let (y, mo, d) = civil_from_days(days);
        // SYSTEMTIME covers years 1601..=30827; outside that there is nothing sensible to ask the OS.
        if !(1601..=30827).contains(&y) {
            return 0;
        }
        let ms = utc.rem_euclid(DAY_MS);
        let secs = ms / 1000;
        let st = SYSTEMTIME {
            wYear: y as u16,
            wMonth: mo as u16,
            wDayOfWeek: 0,
            wDay: d as u16,
            wHour: (secs / 3600) as u16,
            wMinute: (secs % 3600 / 60) as u16,
            wSecond: (secs % 60) as u16,
            wMilliseconds: (ms % 1000) as u16,
        };
        let mut local = SYSTEMTIME::default();
        // SAFETY: both pointers are valid SYSTEMTIME values for the call; a null zone means the current one.
        if unsafe { SystemTimeToTzSpecificLocalTime(None, &st, &mut local) }.is_err() {
            return 0;
        }
        let local_ms = days_from_civil(i32::from(local.wYear), u32::from(local.wMonth), u32::from(local.wDay)) * DAY_MS
            + (i64::from(local.wHour) * 3600 + i64::from(local.wMinute) * 60 + i64::from(local.wSecond)) * 1000
            + i64::from(local.wMilliseconds);
        local_ms - utc
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::store::{Reminder, Rule, LAST_DAY, TOOL_SPEAK};

    /// A zone with explicit transitions: (utc ms from which the offset applies, offset ms).
    pub struct FixedZone(pub Vec<(i64, i64)>);

    impl Tz for FixedZone {
        fn offset_ms(&self, utc: i64) -> i64 {
            self.0.iter().rev().find(|(from, _)| utc >= *from).map(|(_, o)| *o).unwrap_or(self.0[0].1)
        }
    }

    const H: i64 = 3_600_000;

    /// New York 2026: EST -5 h, EDT -4 h from 2026-03-08 07:00Z (02:00 local jumps to 03:00), back to EST at 2026-11-01 06:00Z
    /// (02:00 EDT falls back to 01:00 EST, so 01:00..02:00 local happens twice).
    pub fn new_york() -> FixedZone {
        FixedZone(vec![
            (i64::MIN, -5 * H),
            (utc_ms(2026, 3, 8, 7, 0, 0), -4 * H),
            (utc_ms(2026, 11, 1, 6, 0, 0), -5 * H),
        ])
    }

    pub fn ho_chi_minh() -> FixedZone {
        FixedZone(vec![(i64::MIN, 7 * H)])
    }

    pub fn daily(time: &str, created_ms: i64, last: Option<i64>) -> Reminder {
        Reminder {
            id: "r".into(), text: "t".into(), time: time.into(), repeat: Repeat::Daily, at_ms: None,
            created_ms, last_fired_ms: last, done: false, tool: TOOL_SPEAK.into(), rule: Rule::default(),
        }
    }

    #[test]
    fn civil_dates_round_trip_and_match_known_days() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(2000, 3, 1), 11_017);
        assert_eq!(civil_from_days(11_017), (2000, 3, 1));
        for z in (-800_000..800_000).step_by(997) {
            let (y, m, d) = civil_from_days(z);
            assert_eq!(days_from_civil(y, m, d), z);
        }
        assert_eq!(utc_ms(2026, 11, 11, 0, 0, 0) / DAY_MS, days_from_civil(2026, 11, 11));
    }

    #[test]
    fn a_daily_fire_is_strictly_after_the_anchor() {
        let tz = ho_chi_minh(); // +7
        let t = |h, m, s| utc_ms(2026, 11, 11, h, m, s);
        // 15:00 local = 08:00Z
        assert_eq!(next_daily_after(&tz, 15, 0, t(7, 59, 30)), t(8, 0, 0)); // 14:59:30 local -> today
        assert_eq!(next_daily_after(&tz, 15, 0, t(8, 0, 0)), t(8, 0, 0) + DAY_MS); // exactly 15:00 -> tomorrow
        assert_eq!(next_daily_after(&tz, 15, 0, t(8, 0, 1)), t(8, 0, 0) + DAY_MS);
        // 00:30 local is 17:30Z of the day before: 23:00Z on the 10th is 06:00 local on the 11th.
        assert_eq!(next_daily_after(&tz, 0, 30, utc_ms(2026, 11, 10, 23, 0, 0)), utc_ms(2026, 11, 11, 17, 30, 0));
    }

    #[test]
    fn a_time_inside_the_spring_forward_gap_fires_just_after_it_and_once() {
        let tz = new_york();
        // 2026-03-08 02:30 local does not exist. Offset before the change is -5 h: 02:30 -> 07:30Z = 03:30 EDT.
        let from = utc_ms(2026, 3, 7, 17, 0, 0); // noon EST on the 7th
        let fire = next_daily_after(&tz, 2, 30, from);
        assert_eq!(fire, utc_ms(2026, 3, 8, 7, 30, 0));
        assert_eq!(to_local(&tz, fire), LocalTime { y: 2026, mo: 3, d: 8, h: 3, mi: 30, s: 0 });
        // After that fire the next one is the 9th at a real 02:30 EDT (06:30Z), not the 8th again.
        assert_eq!(next_daily_after(&tz, 2, 30, fire), utc_ms(2026, 3, 9, 6, 30, 0));
        // A time outside the gap is untouched on the same day: 03:30 EDT is the same instant, 04:00 EDT is 08:00Z.
        assert_eq!(next_daily_after(&tz, 4, 0, from), utc_ms(2026, 3, 8, 8, 0, 0));
    }

    #[test]
    fn a_time_inside_the_fall_back_fold_fires_at_its_first_occurrence_only() {
        let tz = new_york();
        let from = utc_ms(2026, 10, 31, 16, 0, 0); // noon EDT on 31 Oct
        let first = next_daily_after(&tz, 1, 30, from);
        assert_eq!(first, utc_ms(2026, 11, 1, 5, 30, 0)); // 01:30 EDT
        // The second 01:30 (EST) is 06:30Z on 1 Nov. It must NOT be the next fire: the next one is 2 Nov 01:30 EST.
        assert_eq!(next_daily_after(&tz, 1, 30, first), utc_ms(2026, 11, 2, 6, 30, 0));
        // Anchored inside the fold after the first fire (clock read 01:45 EST the second time): still tomorrow.
        assert_eq!(next_daily_after(&tz, 1, 30, utc_ms(2026, 11, 1, 6, 45, 0)), utc_ms(2026, 11, 2, 6, 30, 0));
    }

    #[test]
    fn a_noon_reminder_stays_at_noon_local_across_both_changes() {
        let tz = new_york();
        let before = next_daily_after(&tz, 12, 0, utc_ms(2026, 3, 7, 18, 0, 0));
        assert_eq!(before, utc_ms(2026, 3, 8, 16, 0, 0)); // 12:00 EDT
        assert_eq!(before - utc_ms(2026, 3, 7, 17, 0, 0), 23 * H); // the day after the change is 23 h long
        let fall = next_daily_after(&tz, 12, 0, utc_ms(2026, 10, 31, 16, 0, 0));
        assert_eq!(fall, utc_ms(2026, 11, 1, 17, 0, 0)); // 12:00 EST
        assert_eq!(fall - utc_ms(2026, 10, 31, 16, 0, 0), 25 * H);
    }

    #[test]
    fn a_one_shot_is_the_stored_instant_and_a_finished_one_never_fires_again() {
        let tz = new_york();
        let mut r = daily("09:00", 0, None);
        r.repeat = Repeat::None;
        r.at_ms = Some(1_234_567);
        assert_eq!(due_ms(&tz, &r, 99), Some(1_234_567));
        r.done = true;
        assert_eq!(due_ms(&tz, &r, 99), None);
    }

    #[test]
    fn a_daily_counts_from_its_last_fire_and_a_missed_day_is_one_fire_not_two() {
        let tz = ho_chi_minh();
        let created = utc_ms(2026, 11, 1, 1, 0, 0);
        let r = daily("15:00", created, None);
        // Created 08:00 local on the 1st: first due 15:00 local the same day = 08:00Z.
        assert_eq!(due_ms(&tz, &r, created), Some(utc_ms(2026, 11, 1, 8, 0, 0)));
        // Last fired on the 1st; the app was off for 9 days. The next due is the 2nd (overdue). It is ONE instant.
        let r = daily("15:00", created, Some(utc_ms(2026, 11, 1, 8, 0, 5)));
        assert_eq!(due_ms(&tz, &r, utc_ms(2026, 11, 10, 20, 0, 0)), Some(utc_ms(2026, 11, 2, 8, 0, 0)));
    }

    #[test]
    fn a_clock_set_back_an_hour_cannot_fire_the_same_day_twice_but_a_year_off_clock_cannot_freeze_it() {
        let tz = ho_chi_minh();
        let fired = utc_ms(2026, 11, 11, 8, 0, 2); // fired today 15:00:02 local
        let r = daily("15:00", 0, Some(fired));
        // The clock is set back 1 h (14:00 local): still due tomorrow, not today at 15:00 again.
        let now = fired - 3_600_000;
        assert_eq!(due_ms(&tz, &r, now), Some(utc_ms(2026, 11, 12, 8, 0, 0)));
        // The last fire was recorded while the clock was a year ahead: the anchor is replaced by `now`.
        let r = daily("15:00", 0, Some(fired + 365 * DAY_MS));
        let now = utc_ms(2026, 11, 11, 9, 0, 0);
        assert_eq!(due_ms(&tz, &r, now), Some(utc_ms(2026, 11, 12, 8, 0, 0)));
        // 30 hours ahead (inside the 36 h tolerance) is kept, so it cannot fire early either.
        let r = daily("15:00", 0, Some(now + 30 * 3_600_000));
        assert!(due_ms(&tz, &r, now).unwrap() > now + 30 * 3_600_000);
    }


    const D: i64 = DAY_MS;

    fn at(tz: &dyn Tz, y: i32, mo: u32, d: u32, h: u32, mi: u32) -> i64 {
        // local wall clock -> unix ms (only for zones without a change on that day)
        utc_ms(y, mo, d, h, mi, 0) - tz.offset_ms(utc_ms(y, mo, d, h, mi, 0))
    }

    #[test]
    fn a_monthly_31st_skips_the_months_that_lack_it() {
        let tz = ho_chi_minh();
        // after 31 Jan 10:00 local: February has no 31st, so the next is 31 March.
        assert_eq!(next_monthly_after(&tz, 31, 9, 0, at(&tz, 2026, 1, 31, 10, 0)), Some(at(&tz, 2026, 3, 31, 9, 0)));
        // before the time on the 31st: the same day.
        assert_eq!(next_monthly_after(&tz, 31, 9, 0, at(&tz, 2026, 1, 31, 8, 0)), Some(at(&tz, 2026, 1, 31, 9, 0)));
        // 30th: April has it, February does not.
        assert_eq!(next_monthly_after(&tz, 30, 9, 0, at(&tz, 2026, 1, 30, 10, 0)), Some(at(&tz, 2026, 3, 30, 9, 0)));
        // the 15th is every month, strictly after the anchor.
        assert_eq!(next_monthly_after(&tz, 15, 9, 0, at(&tz, 2026, 11, 15, 9, 0)), Some(at(&tz, 2026, 12, 15, 9, 0)));
        assert_eq!(next_monthly_after(&tz, 15, 9, 0, at(&tz, 2026, 12, 15, 9, 0)), Some(at(&tz, 2027, 1, 15, 9, 0)));
    }

    #[test]
    fn last_day_is_every_months_own_last_day_and_the_leap_february() {
        let tz = ho_chi_minh();
        assert_eq!(next_monthly_after(&tz, LAST_DAY, 9, 0, at(&tz, 2026, 2, 10, 0, 0)), Some(at(&tz, 2026, 2, 28, 9, 0)));
        assert_eq!(next_monthly_after(&tz, LAST_DAY, 9, 0, at(&tz, 2028, 2, 10, 0, 0)), Some(at(&tz, 2028, 2, 29, 9, 0)));
        assert_eq!(next_monthly_after(&tz, LAST_DAY, 9, 0, at(&tz, 2026, 4, 30, 9, 0)), Some(at(&tz, 2026, 5, 31, 9, 0)));
        assert_eq!(next_monthly_after(&tz, LAST_DAY, 9, 0, at(&tz, 2026, 12, 31, 9, 0)), Some(at(&tz, 2027, 1, 31, 9, 0)));
    }

    #[test]
    fn a_monthly_time_in_the_spring_gap_moves_through_it_and_in_the_fold_fires_once() {
        let tz = new_york();
        // 8 March 02:30 does not exist: it lands at 03:30 EDT (07:30Z), as a daily one does.
        assert_eq!(next_monthly_after(&tz, 8, 2, 30, utc_ms(2026, 2, 20, 0, 0, 0)), Some(utc_ms(2026, 3, 8, 7, 30, 0)));
        // 1 Nov 01:30 happens twice: the first (EDT, 05:30Z) only; anchored after it, the next is 1 Dec.
        assert_eq!(next_monthly_after(&tz, 1, 1, 30, utc_ms(2026, 10, 20, 0, 0, 0)), Some(utc_ms(2026, 11, 1, 5, 30, 0)));
        assert_eq!(next_monthly_after(&tz, 1, 1, 30, utc_ms(2026, 11, 1, 5, 30, 0)), Some(utc_ms(2026, 12, 1, 6, 30, 0)));
        assert_eq!(next_monthly_after(&tz, 1, 1, 30, utc_ms(2026, 11, 1, 6, 45, 0)), Some(utc_ms(2026, 12, 1, 6, 30, 0)));
    }

    #[test]
    fn a_yearly_date_is_once_a_year_and_feb_29_waits_for_the_leap_year() {
        let tz = ho_chi_minh();
        assert_eq!(next_yearly_after(&tz, 11, 11, 15, 0, at(&tz, 2026, 11, 11, 14, 0)), Some(at(&tz, 2026, 11, 11, 15, 0)));
        assert_eq!(next_yearly_after(&tz, 11, 11, 15, 0, at(&tz, 2026, 11, 11, 15, 0)), Some(at(&tz, 2027, 11, 11, 15, 0)));
        assert_eq!(next_yearly_after(&tz, 2, 29, 9, 0, at(&tz, 2026, 3, 1, 0, 0)), Some(at(&tz, 2028, 2, 29, 9, 0)));
        // 2100 is not a leap year: 29 Feb 2096 is followed by 2104.
        assert_eq!(next_yearly_after(&tz, 2, 29, 9, 0, at(&tz, 2096, 3, 1, 0, 0)), Some(at(&tz, 2104, 2, 29, 9, 0)));
        // a date that never exists has no next
        assert_eq!(next_yearly_after(&tz, 2, 30, 9, 0, at(&tz, 2026, 3, 1, 0, 0)), None);
        assert_eq!(next_yearly_after(&tz, 4, 31, 9, 0, at(&tz, 2026, 3, 1, 0, 0)), None);
    }

    fn interval(every: u32, anchor: i64) -> Rule {
        Rule { every_min: Some(every), anchor_ms: Some(anchor), ..Rule::default() }
    }

    #[test]
    fn an_interval_counts_elapsed_minutes_from_its_anchor() {
        let tz = ho_chi_minh();
        let a = at(&tz, 2026, 11, 11, 8, 0);
        let r = interval(90, a);
        assert_eq!(next_interval_after(&tz, &r, a - 1), Some(a), "before the anchor: the anchor itself");
        assert_eq!(next_interval_after(&tz, &r, a), Some(a + 90 * 60_000));
        assert_eq!(next_interval_after(&tz, &r, a + 100 * 60_000), Some(a + 180 * 60_000));
        assert_eq!(next_interval_after(&tz, &r, a + 180 * 60_000 - 1), Some(a + 180 * 60_000));
        // elapsed time, not wall clock: 17 h later is still a multiple of 90 min from the anchor
        assert_eq!((next_interval_after(&tz, &r, a + 17 * 3_600_000).unwrap() - a) % (90 * 60_000), 0);
    }

    #[test]
    fn an_interval_keeps_to_its_weekdays_its_window_and_its_end() {
        let tz = ho_chi_minh();
        // Friday 13 Nov 2026, daily slots at 09:00, Monday to Friday only: after Friday's slot comes Monday's.
        let fri = at(&tz, 2026, 11, 13, 9, 0);
        let mut r = interval(1440, fri);
        r.weekdays = Some(vec![1, 2, 3, 4, 5]);
        assert_eq!(next_interval_after(&tz, &r, fri), Some(at(&tz, 2026, 11, 16, 9, 0)));
        // every 60 min between 09:00 (inclusive) and 17:00 (exclusive)
        let mut w = interval(60, at(&tz, 2026, 11, 11, 8, 0));
        w.window = Some(("09:00".into(), "17:00".into()));
        assert_eq!(next_interval_after(&tz, &w, at(&tz, 2026, 11, 11, 7, 0)), Some(at(&tz, 2026, 11, 11, 9, 0)), "08:00 is before the window");
        assert_eq!(next_interval_after(&tz, &w, at(&tz, 2026, 11, 11, 15, 30)), Some(at(&tz, 2026, 11, 11, 16, 0)));
        assert_eq!(next_interval_after(&tz, &w, at(&tz, 2026, 11, 11, 16, 0)), Some(at(&tz, 2026, 11, 12, 9, 0)), "17:00 is outside, the next is tomorrow 09:00");
        // an end: the slot AT the end counts, later ones do not
        let mut e = interval(60, at(&tz, 2026, 11, 11, 8, 0));
        e.ends_ms = Some(at(&tz, 2026, 11, 11, 10, 0));
        assert_eq!(next_interval_after(&tz, &e, at(&tz, 2026, 11, 11, 9, 0)), Some(at(&tz, 2026, 11, 11, 10, 0)));
        assert_eq!(next_interval_after(&tz, &e, at(&tz, 2026, 11, 11, 10, 0)), None);
        // the search is bounded: Sundays only, a slot that never lands on a Sunday inside the search span, is None, not a hang
        let mut never = interval(1440 / 2, at(&tz, 2026, 11, 11, 8, 0));
        never.weekdays = Some(vec![0]);
        never.window = Some(("13:00".into(), "13:30".into()));
        let t0 = std::time::Instant::now();
        assert_eq!(next_interval_after(&tz, &never, at(&tz, 2026, 11, 11, 9, 0)), None);
        assert!(t0.elapsed() < std::time::Duration::from_millis(500));
        let _ = D;
    }

    #[test]
    fn due_ms_follows_the_repeat_kind_from_the_last_fire() {
        let tz = ho_chi_minh();
        let created = at(&tz, 2026, 11, 1, 8, 0);
        let mut m = daily("09:00", created, None);
        m.repeat = Repeat::Monthly;
        m.rule.day = Some(15);
        assert_eq!(due_ms(&tz, &m, created), Some(at(&tz, 2026, 11, 15, 9, 0)));
        m.last_fired_ms = Some(at(&tz, 2026, 11, 15, 9, 0));
        assert_eq!(due_ms(&tz, &m, at(&tz, 2026, 11, 15, 9, 1)), Some(at(&tz, 2026, 12, 15, 9, 0)));
        let mut y = daily("09:00", created, None);
        y.repeat = Repeat::Yearly;
        y.rule.month = Some(3);
        y.rule.day = Some(2);
        assert_eq!(due_ms(&tz, &y, created), Some(at(&tz, 2027, 3, 2, 9, 0)));
        let mut i = daily("09:00", created, None);
        i.repeat = Repeat::Interval;
        i.rule = interval(30, created + 60 * 60_000);
        assert_eq!(due_ms(&tz, &i, created), Some(created + 60 * 60_000));
        i.last_fired_ms = Some(created + 61 * 60_000);
        assert_eq!(due_ms(&tz, &i, created + 62 * 60_000), Some(created + 90 * 60_000));
    }

    #[cfg(windows)]
    #[test]
    fn the_system_zone_gives_a_quarter_hour_offset_that_follows_the_os_rules() {
        let tz = SystemTz;
        let now = zumi_audit::unix_ms() as i64;
        for probe in [now, now + 90 * DAY_MS, now + 200 * DAY_MS] {
            let o = tz.offset_ms(probe);
            assert!(o.abs() <= 14 * H && o % (15 * 60_000) == 0, "offset {o}");
            // to_local and the offset agree with each other.
            let l = to_local(&tz, probe);
            assert_eq!(utc_ms(l.y, l.mo, l.d, l.h, l.mi, l.s) - o, probe - probe.rem_euclid(1000));
        }
    }
}
