//! The reminder store: one JSON file, `reminders.json`, in the routines directory the host passes in.
//!
//! The crate never resolves the data dir (only the store module of the host may); it is given a directory.
//! Writes are atomic (temp file, then rename), so a crash leaves either the old or the new file, never half of one.
//! A file that does not parse is moved aside as `reminders.json.corrupt-<unix ms>` (never deleted) and the store starts
//! empty; `Store::quarantined` says so, `Routines::quarantined()` hands it to the host, which logs it.
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub const FILE_NAME: &str = "reminders.json";
/// Written version. Version 1 files (only `none` and `daily` rows, none of the rule fields) are still read as they are.
pub const FORMAT_VERSION: u64 = 2;
pub const MAX_REMINDERS: usize = 100;
pub const MAX_TEXT_CHARS: usize = 200;
/// The only routine action that exists today: say the text. Anything else is refused by `gate`.
pub const TOOL_SPEAK: &str = "speak";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Repeat {
    None,
    Daily,
    /// Day of the month at `time`; a day the month lacks is skipped; `LAST_DAY` is the last day of every month.
    Monthly,
    /// Month and day at `time`; Feb 29 runs in leap years only.
    Yearly,
    /// Every `every_min` minutes from `anchor_ms`, optionally only on some weekdays, inside a daily window, until `ends_ms`.
    Interval,
}

/// `Rule::day` value meaning "last day of the month" (upstream's `L`).
pub const LAST_DAY: u32 = 0;
pub const MIN_INTERVAL_MIN: u32 = 5;
pub const MAX_INTERVAL_MIN: u32 = 1_440;

impl Repeat {
    pub fn as_str(self) -> &'static str {
        match self {
            Repeat::None => "none",
            Repeat::Daily => "daily",
            Repeat::Monthly => "monthly",
            Repeat::Yearly => "yearly",
            Repeat::Interval => "interval",
        }
    }
    pub fn parse(s: &str) -> Option<Repeat> {
        match s {
            "none" => Some(Repeat::None),
            "daily" => Some(Repeat::Daily),
            "monthly" => Some(Repeat::Monthly),
            "yearly" => Some(Repeat::Yearly),
            "interval" => Some(Repeat::Interval),
            _ => None,
        }
    }
}

/// What a monthly, yearly or interval row adds to `time`. Every field is None for `none` and `daily`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Rule {
    /// monthly: 1..=31 or `LAST_DAY`; yearly: 1..=31 (valid for `month`).
    pub day: Option<u32>,
    /// yearly: 1..=12.
    pub month: Option<u32>,
    /// interval: 5..=1440 minutes.
    pub every_min: Option<u32>,
    /// interval: the first slot (unix ms); slots are `anchor_ms + k * every_min`, in elapsed time, not wall-clock time.
    pub anchor_ms: Option<i64>,
    /// interval: local weekdays, Sunday = 0; None = every day.
    pub weekdays: Option<Vec<u32>>,
    /// interval: local wall-clock window `HH:MM` start (inclusive) and end (exclusive); None = all day.
    pub window: Option<(String, String)>,
    /// interval: no slot after this instant (inclusive).
    pub ends_ms: Option<i64>,
}

impl Rule {
    /// Does this rule fit the repeat kind? Fields a kind does not use must be absent, so a stored row cannot hide a second meaning.
    pub fn check(&self, repeat: Repeat) -> Result<(), StoreError> {
        let none_of = |a: bool| if a { Err(StoreError::BadRule) } else { Ok(()) };
        let interval_fields = self.every_min.is_some() || self.anchor_ms.is_some() || self.weekdays.is_some() || self.window.is_some() || self.ends_ms.is_some();
        match repeat {
            Repeat::None | Repeat::Daily => none_of(*self != Rule::default()),
            Repeat::Monthly => {
                none_of(self.month.is_some() || interval_fields)?;
                match self.day {
                    Some(d) if d <= 31 => Ok(()),
                    _ => Err(StoreError::BadRule),
                }
            }
            Repeat::Yearly => {
                none_of(interval_fields)?;
                let (Some(m), Some(d)) = (self.month, self.day) else { return Err(StoreError::BadRule) };
                // Feb 29 is allowed (leap years only); Feb 30, Apr 31 never exist.
                if (1..=12).contains(&m) && d >= 1 && d <= crate::clock::max_days_in_month(m) { Ok(()) } else { Err(StoreError::BadRule) }
            }
            Repeat::Interval => {
                none_of(self.day.is_some() || self.month.is_some())?;
                let (Some(every), Some(anchor)) = (self.every_min, self.anchor_ms) else { return Err(StoreError::BadRule) };
                if !(MIN_INTERVAL_MIN..=MAX_INTERVAL_MIN).contains(&every) {
                    return Err(StoreError::BadRule);
                }
                if let Some(w) = &self.weekdays {
                    let mut seen = [false; 7];
                    if w.is_empty() || w.len() > 6 || w.iter().any(|d| *d > 6 || std::mem::replace(&mut seen[*d as usize], true)) {
                        return Err(StoreError::BadRule);
                    }
                }
                if let Some((a, b)) = &self.window {
                    let (Some((ah, am)), Some((bh, bm))) = (parse_hhmm(a), parse_hhmm(b)) else { return Err(StoreError::BadRule) };
                    let (start, end) = (ah * 60 + am, bh * 60 + bm);
                    // Same-day window at least as long as the interval (upstream's two messages).
                    if start >= end || end - start < every {
                        return Err(StoreError::BadRule);
                    }
                }
                match self.ends_ms {
                    Some(e) if e < anchor => Err(StoreError::BadRule),
                    _ => Ok(()),
                }
            }
        }
    }

    fn to_json(&self, o: &mut serde_json::Map<String, Value>) {
        if let Some(d) = self.day { o.insert("day".into(), json!(d)); }
        if let Some(m) = self.month { o.insert("month".into(), json!(m)); }
        if let Some(e) = self.every_min { o.insert("every_min".into(), json!(e)); }
        if let Some(a) = self.anchor_ms { o.insert("anchor_ms".into(), json!(a)); }
        if let Some(w) = &self.weekdays { o.insert("weekdays".into(), json!(w)); }
        if let Some((a, b)) = &self.window { o.insert("window_start".into(), json!(a)); o.insert("window_end".into(), json!(b)); }
        if let Some(e) = self.ends_ms { o.insert("ends_ms".into(), json!(e)); }
    }

    /// Strict: a field that is present with the wrong type makes the whole row unreadable (the file is then quarantined).
    fn from_json(o: &serde_json::Map<String, Value>) -> Option<Rule> {
        let int = |k: &str| -> Option<Option<i64>> {
            match o.get(k) {
                None | Some(Value::Null) => Some(None),
                Some(v) => v.as_i64().map(Some),
            }
        };
        let small = |k: &str| -> Option<Option<u32>> {
            match int(k)? {
                None => Some(None),
                Some(v) => u32::try_from(v).ok().map(Some),
            }
        };
        let weekdays = match o.get("weekdays") {
            None | Some(Value::Null) => None,
            Some(v) => Some(v.as_array()?.iter().map(|d| d.as_u64().and_then(|d| u32::try_from(d).ok())).collect::<Option<Vec<u32>>>()?),
        };
        let window = match (o.get("window_start").and_then(Value::as_str), o.get("window_end").and_then(Value::as_str)) {
            (None, None) => None,
            (Some(a), Some(b)) => Some((a.to_string(), b.to_string())),
            _ => return None,
        };
        Some(Rule { day: small("day")?, month: small("month")?, every_min: small("every_min")?, anchor_ms: int("anchor_ms")?, weekdays, window, ends_ms: int("ends_ms")? })
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Reminder {
    pub id: String,
    pub text: String,
    /// Local wall-clock "HH:MM" (24 h).
    pub time: String,
    pub repeat: Repeat,
    /// repeat none: the absolute instant (unix ms) it is due. Absent for daily.
    pub at_ms: Option<i64>,
    pub created_ms: i64,
    /// The instant the last fire was decided (unix ms); the daily next-fire is computed after it.
    pub last_fired_ms: Option<i64>,
    /// repeat none: fired (or refused) already; it never fires again.
    pub done: bool,
    /// What the routine does when due. Always `speak` for a reminder made through the form.
    pub tool: String,
    /// The extra fields of a monthly, yearly or interval row.
    pub rule: Rule,
}

/// "HH:MM" -> (hour, minute). None when it is not a valid 24-hour time.
pub fn parse_hhmm(s: &str) -> Option<(u32, u32)> {
    let b = s.as_bytes();
    if b.len() != 5 || b[2] != b':' || !b.iter().enumerate().all(|(i, c)| i == 2 || c.is_ascii_digit()) {
        return None;
    }
    let h: u32 = s[0..2].parse().ok()?;
    let m: u32 = s[3..5].parse().ok()?;
    (h < 24 && m < 60).then_some((h, m))
}

/// Text of a reminder: 1..=200 characters after trimming, no control characters.
pub fn clean_text(s: &str) -> Option<String> {
    let t = s.trim();
    let n = t.chars().count();
    (n >= 1 && n <= MAX_TEXT_CHARS && !t.chars().any(|c| c.is_control())).then(|| t.to_string())
}

impl Reminder {
    pub fn to_json(&self) -> Value {
        let mut v = json!({
            "id": self.id, "text": self.text, "time": self.time, "repeat": self.repeat.as_str(),
            "at_ms": self.at_ms, "created_ms": self.created_ms, "last_fired_ms": self.last_fired_ms,
            "done": self.done, "tool": self.tool,
        });
        if let Some(o) = v.as_object_mut() {
            self.rule.to_json(o);
        }
        v
    }

    /// Strict parse of one stored row. None when a required field is missing or has the wrong type.
    pub fn from_json(v: &Value) -> Option<Reminder> {
        let o = v.as_object()?;
        let text = o.get("text")?.as_str()?;
        let time = o.get("time")?.as_str()?;
        parse_hhmm(time)?;
        let repeat = Repeat::parse(o.get("repeat")?.as_str()?)?;
        let at_ms = match o.get("at_ms") {
            None | Some(Value::Null) => None,
            Some(x) => Some(x.as_i64()?),
        };
        if repeat == Repeat::None && at_ms.is_none() {
            return None;
        }
        let last_fired_ms = match o.get("last_fired_ms") {
            None | Some(Value::Null) => None,
            Some(x) => Some(x.as_i64()?),
        };
        let rule = Rule::from_json(o)?;
        rule.check(repeat).ok()?;
        Some(Reminder {
            id: o.get("id")?.as_str().filter(|s| !s.is_empty())?.to_string(),
            text: text.to_string(),
            time: time.to_string(),
            repeat,
            at_ms,
            created_ms: o.get("created_ms")?.as_i64()?,
            last_fired_ms,
            done: o.get("done").and_then(Value::as_bool).unwrap_or(false),
            tool: o.get("tool").and_then(Value::as_str).unwrap_or(TOOL_SPEAK).to_string(),
            rule,
        })
    }
}

/// Business errors are code words, never panics.
#[derive(Debug, PartialEq, Eq)]
pub enum StoreError {
    BadText,
    BadTime,
    /// The day, month, interval, weekdays, window or end of a monthly, yearly or interval row is out of range, or missing.
    BadRule,
    TooMany,
    DuplicateId,
    NotFound,
    /// Another process holds the routines directory's lock: this one gets no scheduler.
    Locked,
    Io(String),
}

impl StoreError {
    pub fn code(&self) -> String {
        match self {
            StoreError::BadText => "bad_text".into(),
            StoreError::BadTime => "bad_time".into(),
            StoreError::BadRule => "bad_rule".into(),
            StoreError::TooMany => "too_many".into(),
            StoreError::DuplicateId => "duplicate_id".into(),
            StoreError::NotFound => "not_found".into(),
            StoreError::Locked => "locked".into(),
            StoreError::Io(m) => format!("io:{m}"),
        }
    }
}

impl From<std::io::Error> for StoreError {
    fn from(e: std::io::Error) -> Self {
        StoreError::Io(e.to_string())
    }
}

pub struct Store {
    path: PathBuf,
    rows: Vec<Reminder>,
    /// Where an unreadable file was moved to when this store was opened.
    pub quarantined: Option<PathBuf>,
}

impl Store {
    /// Opens (creating the directory if needed) `<dir>/reminders.json`. A missing file is an empty store.
    pub fn open(dir: &Path) -> Result<Store, StoreError> {
        std::fs::create_dir_all(dir)?;
        let path = dir.join(FILE_NAME);
        let mut store = Store { path, rows: Vec::new(), quarantined: None };
        let text = match std::fs::read_to_string(&store.path) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(store),
            Err(e) => return Err(e.into()),
        };
        match parse_file(&text) {
            Some(rows) => store.rows = rows,
            None => {
                let aside = dir.join(format!("{FILE_NAME}.corrupt-{}", zumi_audit::unix_ms()));
                std::fs::rename(&store.path, &aside)?;
                store.quarantined = Some(aside);
            }
        }
        Ok(store)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn list(&self) -> &[Reminder] {
        &self.rows
    }

    /// Mutable access for the engine (fire bookkeeping). The caller must `save()` after changing a row.
    pub(crate) fn rows_mut(&mut self) -> &mut Vec<Reminder> {
        &mut self.rows
    }

    pub fn add(&mut self, r: Reminder) -> Result<(), StoreError> {
        if clean_text(&r.text).as_deref() != Some(r.text.as_str()) {
            return Err(StoreError::BadText);
        }
        if parse_hhmm(&r.time).is_none() {
            return Err(StoreError::BadTime);
        }
        r.rule.check(r.repeat)?;
        if self.rows.len() >= MAX_REMINDERS {
            return Err(StoreError::TooMany);
        }
        if self.rows.iter().any(|x| x.id == r.id) {
            return Err(StoreError::DuplicateId);
        }
        self.rows.push(r);
        if let Err(e) = self.save() {
            self.rows.pop(); // memory must equal the file
            return Err(e);
        }
        Ok(())
    }

    pub fn delete(&mut self, id: &str) -> Result<(), StoreError> {
        let backup = self.rows.clone();
        self.rows.retain(|r| r.id != id);
        if self.rows.len() == backup.len() {
            return Err(StoreError::NotFound);
        }
        if let Err(e) = self.save() {
            self.rows = backup; // memory must equal the file
            return Err(e);
        }
        Ok(())
    }

    pub fn save(&self) -> Result<(), StoreError> {
        let doc = json!({ "v": FORMAT_VERSION, "reminders": self.rows.iter().map(Reminder::to_json).collect::<Vec<_>>() });
        let tmp = self.path.with_extension("json.tmp");
        let bytes = serde_json::to_vec_pretty(&doc).map_err(|e| StoreError::Io(e.to_string()))?;
        // Write, flush to the disk, then rename: after a power loss the file is the old one or the new one, never a zero-filled one that
        // would be quarantined and make every reminder vanish.
        let mut f = std::fs::File::create(&tmp)?;
        std::io::Write::write_all(&mut f, &bytes)?;
        f.sync_all()?;
        drop(f);
        std::fs::rename(&tmp, &self.path)?;
        Ok(())
    }
}

/// None = the file is not a version-1 reminder file (including one row that does not parse: no half-trusted file).
fn parse_file(text: &str) -> Option<Vec<Reminder>> {
    let v: Value = serde_json::from_str(text).ok()?;
    if !matches!(v.get("v")?.as_u64()?, 1 | FORMAT_VERSION) {
        return None;
    }
    v.get("reminders")?.as_array()?.iter().map(Reminder::from_json).collect()
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub fn tmp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("zumi-routines-test-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    pub fn sample(id: &str, text: &str, time: &str) -> Reminder {
        Reminder {
            id: id.into(), text: text.into(), time: time.into(), repeat: Repeat::Daily, at_ms: None,
            created_ms: 1_000, last_fired_ms: None, done: false, tool: TOOL_SPEAK.into(), rule: Rule::default(),
        }
    }

    #[test]
    fn rows_survive_a_reopen() {
        let d = tmp_dir("reopen");
        let mut s = Store::open(&d).unwrap();
        s.add(sample("r1", "drink water", "15:00")).unwrap();
        let mut once = sample("r2", "call mum", "09:30");
        once.repeat = Repeat::None;
        once.at_ms = Some(5_000);
        s.add(once.clone()).unwrap();
        let again = Store::open(&d).unwrap();
        assert_eq!(again.list().len(), 2);
        assert_eq!(again.list()[1], once);
        assert_eq!(again.list()[0].text, "drink water");
        assert!(again.quarantined.is_none());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_bad_time_is_refused_and_a_good_one_is_not() {
        let d = tmp_dir("time");
        let mut s = Store::open(&d).unwrap();
        for bad in ["24:00", "12:60", "9:00", "12-30", "ab:cd", "", "12:3x"] {
            assert_eq!(s.add(sample("x", "t", bad)), Err(StoreError::BadTime), "{bad}");
        }
        for (i, good) in ["00:00", "07:05", "23:59"].iter().enumerate() {
            s.add(sample(&format!("g{i}"), "t", good)).unwrap();
        }
        assert_eq!(s.list().len(), 3);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_bad_text_is_refused_and_a_good_one_is_not() {
        let d = tmp_dir("text");
        let mut s = Store::open(&d).unwrap();
        assert_eq!(s.add(sample("a", "", "10:00")), Err(StoreError::BadText));
        assert_eq!(s.add(sample("b", "   ", "10:00")), Err(StoreError::BadText));
        assert_eq!(s.add(sample("c", "two\nlines", "10:00")), Err(StoreError::BadText));
        assert_eq!(s.add(sample("d", &"x".repeat(201), "10:00")), Err(StoreError::BadText));
        s.add(sample("e", &"x".repeat(200), "10:00")).unwrap();
        s.add(sample("f", "uống nước đi anh", "10:00")).unwrap();
        assert_eq!(s.list().len(), 2);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn the_hundred_and_first_reminder_and_a_repeated_id_are_refused() {
        let d = tmp_dir("cap");
        let mut s = Store::open(&d).unwrap();
        for i in 0..MAX_REMINDERS {
            s.add(sample(&format!("r{i}"), "t", "10:00")).unwrap();
        }
        assert_eq!(s.add(sample("over", "t", "10:00")), Err(StoreError::TooMany));
        s.delete("r0").unwrap();
        assert_eq!(s.add(sample("r1", "t", "10:00")), Err(StoreError::DuplicateId));
        s.add(sample("fresh", "t", "10:00")).unwrap();
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn delete_removes_one_row_and_an_unknown_id_is_not_found() {
        let d = tmp_dir("del");
        let mut s = Store::open(&d).unwrap();
        s.add(sample("a", "one", "10:00")).unwrap();
        s.add(sample("b", "two", "11:00")).unwrap();
        assert_eq!(s.delete("zzz"), Err(StoreError::NotFound));
        assert_eq!(s.list().len(), 2);
        s.delete("a").unwrap();
        assert_eq!(Store::open(&d).unwrap().list().iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["b"]);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn an_unreadable_file_is_moved_aside_not_deleted_and_not_trusted() {
        let d = tmp_dir("corrupt");
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join(FILE_NAME), "{not json").unwrap();
        let s = Store::open(&d).unwrap();
        assert!(s.list().is_empty());
        let aside = s.quarantined.clone().expect("moved aside");
        assert_eq!(std::fs::read_to_string(aside).unwrap(), "{not json");
        assert!(!d.join(FILE_NAME).exists());
        // One bad row spoils the whole file: no half-trusted store.
        std::fs::write(
            d.join(FILE_NAME),
            r#"{"v":1,"reminders":[{"id":"a","text":"ok","time":"10:00","repeat":"daily","created_ms":1},{"id":"b","text":"x","time":"99:99","repeat":"daily","created_ms":1}]}"#,
        )
        .unwrap();
        assert!(Store::open(&d).unwrap().quarantined.is_some());
        // The same file with every row valid is read.
        std::fs::write(d.join(FILE_NAME), r#"{"v":1,"reminders":[{"id":"a","text":"ok","time":"10:00","repeat":"daily","created_ms":1}]}"#).unwrap();
        let ok = Store::open(&d).unwrap();
        assert!(ok.quarantined.is_none());
        assert_eq!(ok.list().len(), 1);
        let _ = std::fs::remove_dir_all(&d);
    }

    fn with_rule(id: &str, repeat: Repeat, rule: Rule) -> Reminder {
        let mut r = sample(id, "rule row", "09:00");
        r.repeat = repeat;
        r.rule = rule;
        r
    }

    fn rule(f: impl FnOnce(&mut Rule)) -> Rule {
        let mut r = Rule::default();
        f(&mut r);
        r
    }

    #[test]
    fn monthly_yearly_and_interval_rows_survive_a_reopen_with_every_field() {
        let d = tmp_dir("rules");
        let mut s = Store::open(&d).unwrap();
        let rows = vec![
            with_rule("m", Repeat::Monthly, rule(|r| r.day = Some(LAST_DAY))),
            with_rule("y", Repeat::Yearly, rule(|r| { r.month = Some(2); r.day = Some(29); })),
            with_rule("i", Repeat::Interval, rule(|r| {
                r.every_min = Some(90);
                r.anchor_ms = Some(1_700_000_000_000);
                r.weekdays = Some(vec![1, 2, 3]);
                r.window = Some(("09:00".into(), "17:00".into()));
                r.ends_ms = Some(1_800_000_000_000);
            })),
        ];
        for r in &rows {
            s.add(r.clone()).unwrap();
        }
        let again = Store::open(&d).unwrap();
        assert!(again.quarantined.is_none());
        assert_eq!(again.list(), rows.as_slice());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_rule_out_of_range_or_for_the_wrong_kind_is_refused() {
        let d = tmp_dir("badrules");
        let mut s = Store::open(&d).unwrap();
        let bad: Vec<(Repeat, Rule)> = vec![
            (Repeat::Monthly, Rule::default()),
            (Repeat::Monthly, rule(|r| r.day = Some(32))),
            (Repeat::Monthly, rule(|r| { r.day = Some(5); r.month = Some(3); })),
            (Repeat::Yearly, rule(|r| r.day = Some(5))),
            (Repeat::Yearly, rule(|r| { r.month = Some(13); r.day = Some(1); })),
            (Repeat::Yearly, rule(|r| { r.month = Some(2); r.day = Some(30); })),
            (Repeat::Yearly, rule(|r| { r.month = Some(4); r.day = Some(31); })),
            (Repeat::Yearly, rule(|r| { r.month = Some(4); r.day = Some(0); })),
            (Repeat::Interval, rule(|r| r.every_min = Some(30))),
            (Repeat::Interval, rule(|r| { r.every_min = Some(4); r.anchor_ms = Some(1); })),
            (Repeat::Interval, rule(|r| { r.every_min = Some(1441); r.anchor_ms = Some(1); })),
            (Repeat::Interval, rule(|r| { r.every_min = Some(60); r.anchor_ms = Some(1); r.weekdays = Some(vec![]); })),
            (Repeat::Interval, rule(|r| { r.every_min = Some(60); r.anchor_ms = Some(1); r.weekdays = Some(vec![7]); })),
            (Repeat::Interval, rule(|r| { r.every_min = Some(60); r.anchor_ms = Some(1); r.weekdays = Some(vec![1, 1]); })),
            (Repeat::Interval, rule(|r| { r.every_min = Some(60); r.anchor_ms = Some(1); r.window = Some(("17:00".into(), "09:00".into())); })),
            (Repeat::Interval, rule(|r| { r.every_min = Some(120); r.anchor_ms = Some(1); r.window = Some(("09:00".into(), "10:00".into())); })),
            (Repeat::Interval, rule(|r| { r.every_min = Some(60); r.anchor_ms = Some(1); r.window = Some(("9:00".into(), "10:30".into())); })),
            (Repeat::Interval, rule(|r| { r.every_min = Some(60); r.anchor_ms = Some(100); r.ends_ms = Some(99); })),
            (Repeat::Interval, rule(|r| { r.every_min = Some(60); r.anchor_ms = Some(1); r.day = Some(3); })),
            (Repeat::Daily, rule(|r| r.day = Some(3))),
        ];
        for (i, (repeat, rule)) in bad.into_iter().enumerate() {
            assert_eq!(s.add(with_rule(&format!("b{i}"), repeat, rule)), Err(StoreError::BadRule), "case {i}");
        }
        assert!(s.list().is_empty());
        // and the boundary values that are fine
        s.add(with_rule("ok1", Repeat::Interval, rule(|r| { r.every_min = Some(5); r.anchor_ms = Some(1); }))).unwrap();
        s.add(with_rule("ok2", Repeat::Interval, rule(|r| { r.every_min = Some(1380); r.anchor_ms = Some(1); r.window = Some(("00:00".into(), "23:59".into())); }))).unwrap();
        s.add(with_rule("ok3", Repeat::Monthly, rule(|r| r.day = Some(31)))).unwrap();
        s.add(with_rule("ok4", Repeat::Yearly, rule(|r| { r.month = Some(2); r.day = Some(29); }))).unwrap();
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_version_1_file_is_still_read_and_a_row_with_a_wrong_rule_spoils_the_file() {
        let d = tmp_dir("v1");
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join(FILE_NAME), r#"{"v":1,"reminders":[{"id":"a","text":"ok","time":"10:00","repeat":"daily","created_ms":1}]}"#).unwrap();
        let s = Store::open(&d).unwrap();
        assert!(s.quarantined.is_none() && s.list().len() == 1);
        // saving writes version 2
        s.save().unwrap();
        assert!(std::fs::read_to_string(d.join(FILE_NAME)).unwrap().contains("\"v\": 2"));
        // a monthly row without its day is not half-trusted
        std::fs::write(d.join(FILE_NAME), r#"{"v":2,"reminders":[{"id":"a","text":"ok","time":"10:00","repeat":"monthly","created_ms":1}]}"#).unwrap();
        assert!(Store::open(&d).unwrap().quarantined.is_some());
        std::fs::write(d.join(FILE_NAME), r#"{"v":2,"reminders":[{"id":"a","text":"ok","time":"10:00","repeat":"monthly","day":"first","created_ms":1}]}"#).unwrap();
        assert!(Store::open(&d).unwrap().quarantined.is_some(), "a day that is not a number");
        std::fs::write(d.join(FILE_NAME), r#"{"v":3,"reminders":[]}"#).unwrap();
        assert!(Store::open(&d).unwrap().quarantined.is_some(), "a later version is not guessed at");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_save_leaves_no_temp_file() {
        let d = tmp_dir("tmp");
        let mut s = Store::open(&d).unwrap();
        s.add(sample("a", "one", "10:00")).unwrap();
        let names: Vec<String> = std::fs::read_dir(&d).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(names, [FILE_NAME]);
        let _ = std::fs::remove_dir_all(&d);
    }
}
