//! Run history: what each routine did and when, one JSON line per decision in `history.jsonl` next to the store.
//!
//! Upstream keeps a run log per routine (run, missed receipt, failure); this is the same for the three outcomes a
//! reminder routine has: `fired` (the speaker took it), `missed` (offline for more than 12 hours, or older occurrences
//! folded into one "Missed N" row) and `refused` (the gate refused its tool). Newest first when read.
//!
//! A log, not a store: a line that does not parse is skipped and counted (`dropped`), never trusted and never fatal.
//! Past `MAX_ENTRIES` rows the file is cut back the way upstream `evictRuns` does (the busiest routine loses its oldest row first); the trim is write-temp-then-rename.
use crate::store::StoreError;
use serde_json::{json, Value};
use std::io::Write;
use std::path::{Path, PathBuf};

pub const FILE_NAME: &str = "history.jsonl";
/// At most this many rows are kept (upstream `MAX_RUNS` in `server/routines.ts`). Past it each row dropped is the oldest of the routine holding
/// the most rows (upstream `evictRuns`, `routine-run-history.ts`), so a routine that fires every few minutes uses up its own history and not the
/// others'. A row that has not ended is never dropped upstream; a line here is written once the fire is handed over, so every row has ended.
pub const MAX_ENTRIES: usize = 2000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Fired,
    Missed,
    Refused,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Fired => "fired",
            Status::Missed => "missed",
            Status::Refused => "refused",
        }
    }
    fn parse(s: &str) -> Option<Status> {
        match s {
            "fired" => Some(Status::Fired),
            "missed" => Some(Status::Missed),
            "refused" => Some(Status::Refused),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    /// When it was decided (unix ms).
    pub at_ms: i64,
    pub id: String,
    pub text: String,
    /// The occurrence this line is about (unix ms). For a `Missed` row folding several: the newest of them.
    pub scheduled_ms: i64,
    pub status: Status,
    /// `Missed` only: how many occurrences this row stands for (1 = one late run, N = "Missed N"). 0 otherwise.
    pub missed: u32,
}

impl Entry {
    pub fn to_json(&self) -> Value {
        json!({ "at_ms": self.at_ms, "id": self.id, "text": self.text, "scheduled_ms": self.scheduled_ms, "status": self.status.as_str(), "missed": self.missed })
    }

    fn from_json(v: &Value) -> Option<Entry> {
        Some(Entry {
            at_ms: v.get("at_ms")?.as_i64()?,
            id: v.get("id")?.as_str()?.to_string(),
            text: v.get("text")?.as_str()?.to_string(),
            scheduled_ms: v.get("scheduled_ms")?.as_i64()?,
            status: Status::parse(v.get("status")?.as_str()?)?,
            missed: u32::try_from(v.get("missed")?.as_u64()?).ok()?,
        })
    }
}

pub struct History {
    path: PathBuf,
    /// Oldest first, as in the file.
    items: Vec<Entry>,
    /// Lines of the file that did not parse when it was opened.
    pub dropped: usize,
}

impl History {
    pub fn open(dir: &Path) -> Result<History, StoreError> {
        std::fs::create_dir_all(dir)?;
        let path = dir.join(FILE_NAME);
        let text = match std::fs::read_to_string(&path) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(e) => return Err(e.into()),
        };
        let (mut items, mut dropped) = (Vec::new(), 0);
        for line in text.lines().filter(|l| !l.trim().is_empty()) {
            match serde_json::from_str::<Value>(line).ok().as_ref().and_then(Entry::from_json) {
                Some(e) => items.push(e),
                None => dropped += 1,
            }
        }
        Ok(History { path, items, dropped })
    }

    /// Appends one line and flushes it to the disk. The line is kept in memory only when it reached the file, so memory equals the file.
    pub fn append(&mut self, e: Entry) -> Result<(), StoreError> {
        let mut line = serde_json::to_vec(&e.to_json()).map_err(|x| StoreError::Io(x.to_string()))?;
        line.push(b'\n');
        let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&self.path)?;
        f.write_all(&line)?;
        f.sync_data()?;
        drop(f);
        self.items.push(e);
        if self.items.len() > MAX_ENTRIES {
            self.trim()?;
        }
        Ok(())
    }

    /// Cuts the history to `MAX_ENTRIES` rows, the way upstream `evictRuns` does, and rewrites the file (temp file, then rename).
    fn trim(&mut self) -> Result<(), StoreError> {
        // Per routine, the positions of its rows oldest first; routines in the order their first row appears (upstream's Map order).
        let mut order: Vec<&str> = Vec::new();
        let mut rows: std::collections::HashMap<&str, std::collections::VecDeque<usize>> = std::collections::HashMap::new();
        for (i, e) in self.items.iter().enumerate() {
            rows.entry(e.id.as_str()).or_insert_with(|| {
                order.push(e.id.as_str());
                Default::default()
            }).push_back(i);
        }
        let mut dropped = vec![false; self.items.len()];
        for _ in 0..self.items.len().saturating_sub(MAX_ENTRIES) {
            let (mut most, mut held) = ("", 0);
            for id in &order {
                let n = rows[id].len();
                if n > held {
                    (most, held) = (id, n);
                }
            }
            let oldest = rows.get_mut(most).and_then(|q| q.pop_front()).expect("a routine holding rows");
            dropped[oldest] = true;
        }
        let keep: Vec<Entry> = self.items.iter().zip(&dropped).filter(|(_, d)| !**d).map(|(e, _)| e.clone()).collect();
        let mut bytes = Vec::new();
        for e in &keep {
            bytes.extend(serde_json::to_vec(&e.to_json()).map_err(|x| StoreError::Io(x.to_string()))?);
            bytes.push(b'\n');
        }
        let tmp = self.path.with_extension("jsonl.tmp");
        let write = (|| -> std::io::Result<()> {
            let mut f = std::fs::File::create(&tmp)?;
            f.write_all(&bytes)?;
            f.sync_all()?;
            drop(f);
            std::fs::rename(&tmp, &self.path)
        })();
        match write {
            Ok(()) => {
                self.items = keep;
                Ok(())
            }
            // The file still holds every line and so does memory.
            Err(e) => Err(e.into()),
        }
    }

    /// Newest first, at most `limit`, optionally only one routine's.
    pub fn list(&self, id: Option<&str>, limit: usize) -> Vec<&Entry> {
        self.items.iter().rev().filter(|e| id.map_or(true, |i| e.id == i)).take(limit).collect()
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::tests::tmp_dir;

    fn e(n: i64, status: Status) -> Entry {
        Entry { at_ms: n, id: format!("r{}", n % 2), text: format!("t{n}"), scheduled_ms: n - 1, status, missed: u32::from(status == Status::Missed) }
    }

    #[test]
    fn lines_survive_a_reopen_newest_first_and_filter_by_routine() {
        let d = tmp_dir("hist1");
        let mut h = History::open(&d).unwrap();
        for n in 1..=4 {
            h.append(e(n, if n == 3 { Status::Missed } else { Status::Fired })).unwrap();
        }
        let again = History::open(&d).unwrap();
        assert_eq!(again.len(), 4);
        assert_eq!(again.list(None, 10).iter().map(|x| x.at_ms).collect::<Vec<_>>(), [4, 3, 2, 1]);
        assert_eq!(again.list(Some("r1"), 10).iter().map(|x| x.at_ms).collect::<Vec<_>>(), [3, 1]);
        assert_eq!(again.list(None, 2).len(), 2);
        assert_eq!(again.list(None, 10)[1].status, Status::Missed);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_line_that_does_not_parse_is_skipped_and_counted_not_trusted() {
        let d = tmp_dir("hist2");
        std::fs::create_dir_all(&d).unwrap();
        let good = serde_json::to_string(&e(1, Status::Fired).to_json()).unwrap();
        std::fs::write(d.join(FILE_NAME), format!("{good}\n{{broken\n{{\"at_ms\":1}}\n{good}\n")).unwrap();
        let h = History::open(&d).unwrap();
        assert_eq!((h.len(), h.dropped), (2, 2));
        let _ = std::fs::remove_dir_all(&d);
    }

    fn line(id: &str, n: i64) -> String {
        let en = Entry { at_ms: n, id: id.to_string(), text: format!("t{n}"), scheduled_ms: n - 1, status: Status::Fired, missed: 0 };
        format!("{}\n", serde_json::to_string(&en.to_json()).unwrap())
    }
    fn fired(id: &str, n: i64) -> Entry {
        Entry { at_ms: n, id: id.to_string(), text: format!("t{n}"), scheduled_ms: n - 1, status: Status::Fired, missed: 0 }
    }
    fn names(d: &Path) -> Vec<String> {
        std::fs::read_dir(d).unwrap().map(|x| x.unwrap().file_name().to_string_lossy().into_owned()).collect()
    }

    /// Upstream `routine-run-history.ts` `evictRuns` with `MAX_RUNS = 2_000`: at most that many rows are kept; each one dropped is the oldest of
    /// the routine holding the most of them, "so a routine that runs every few minutes uses up its own history and not the others'".
    #[test]
    fn the_history_keeps_two_thousand_rows_and_a_busy_routine_uses_up_its_own_not_the_others() {
        assert_eq!(MAX_ENTRIES, 2000, "upstream MAX_RUNS");
        let d = tmp_dir("hist-fair");
        std::fs::create_dir_all(&d).unwrap();
        // "rare" has the three OLDEST rows; "busy" fills the rest to exactly the cap.
        let mut text = String::new();
        for n in 1..=3 {
            text.push_str(&line("rare", n));
        }
        for n in 4..=2000 {
            text.push_str(&line("busy", n));
        }
        std::fs::write(d.join(FILE_NAME), text).unwrap();
        let mut h = History::open(&d).unwrap();
        assert_eq!(h.len(), 2000);
        h.append(fired("busy", 2001)).unwrap();
        assert_eq!(h.len(), 2000, "back to the cap");
        assert_eq!(h.list(Some("rare"), 10).len(), 3, "the rare routine keeps all of its rows although they are the oldest");
        assert_eq!(h.list(Some("busy"), 5000).last().unwrap().at_ms, 5, "the busy routine's oldest row (4) is the one dropped");
        let again = History::open(&d).unwrap();
        assert_eq!((again.len(), again.list(Some("rare"), 10).len()), (2000, 3), "the file says the same");
        assert_eq!(names(&d), [FILE_NAME], "no temp file left");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_file_over_the_cap_is_cut_to_it_and_with_one_routine_that_is_oldest_first() {
        let d = tmp_dir("hist-over");
        std::fs::create_dir_all(&d).unwrap();
        let mut text = String::new();
        for n in 1..=2005 {
            text.push_str(&line("only", n));
        }
        std::fs::write(d.join(FILE_NAME), text).unwrap();
        let mut h = History::open(&d).unwrap();
        h.append(fired("only", 2006)).unwrap();
        assert_eq!(h.len(), 2000);
        assert_eq!((h.list(None, 1)[0].at_ms, h.list(None, 5000).last().unwrap().at_ms), (2006, 7), "newest kept, the 6 oldest dropped");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_failed_append_leaves_memory_equal_to_the_file() {
        let d = tmp_dir("hist4");
        let mut h = History::open(&d).unwrap();
        h.append(e(1, Status::Fired)).unwrap();
        // The disk refuses: a directory sits where the file goes.
        std::fs::remove_file(d.join(FILE_NAME)).unwrap();
        std::fs::create_dir_all(d.join(FILE_NAME)).unwrap();
        assert!(h.append(e(2, Status::Fired)).is_err());
        assert_eq!(h.len(), 1);
        let _ = std::fs::remove_dir_all(&d);
    }
}
