//! The monthly budget (R6, pulled forward from D11): a cap the user sets on what the month may spend, counted from the usage ledger
//! (every priced call of the month: the chat's and the agent's). Upstream: `docs/usage-caps.md` and `server/usage-caps.ts` (v0.1.169):
//! - the month is the UTC month ("Days and months are UTC, as the usage ledger's are");
//! - `measure`: percent = min(999, round(used / limit * 100)), warn at 80%, reached when `used >= limit` (no worst case of a next call);
//! - a cap is checked only before new work starts ("Nothing is cut off mid-turn ... the last turn can take the total past the limit");
//! - a ledger line that does not parse is skipped (`try { JSON.parse(line) } catch { continue }`).
//!
//! `<data dir>/budget.json`: `{ "monthly_usd": 5.0 }`. No file, or `monthly_usd: null`, is no cap (the 0.50 USD running total of
//! `tool_gate::TOTAL_CAP_USD` still applies to agent tasks, per call: this cap can only add a stop, never raise what a task may spend).
//! A budget file that cannot be read or holds a value that is not a positive number stops the work (`budget_unreadable`): a cap that
//! cannot be read cannot be enforced. A ledger FILE that cannot be read is the same; a torn LINE is skipped and said.
use crate::ledger::Prices;
use serde_json::Value;
use std::path::Path;

pub const FILE_NAME: &str = "budget.json";

/// What this calendar month has spent when a task starts, and the cap it is held to.
#[derive(Clone, Debug, PartialEq)]
pub struct MonthCap {
    pub cap_usd: f64,
    /// `YYYY-MM`, the UTC month (upstream: "Days and months are UTC").
    pub month: String,
    pub spent_usd: f64,
    /// Calls of this month that could not be priced (an unknown model): they count as 0 and are said, never hidden.
    pub unpriced_calls: u32,
    /// Ledger lines of the month that could not be read and were skipped (upstream skips them too); said, never hidden.
    pub torn_lines: u32,
}

/// What the ledger says a month spent.
#[derive(Clone, Debug, PartialEq)]
pub struct MonthSpend {
    pub usd: f64,
    pub unpriced_calls: u32,
    pub torn_lines: u32,
}

/// The current month in UTC, `YYYY-MM`.
pub fn utc_month_now() -> String {
    crate::ledger::iso_utc(crate::types::unix_ms())[..7].to_string()
}

/// `YYYY-MM` one month before / after.
fn shift_month(month: &str, by: i32) -> Option<String> {
    let (y, m) = (month.get(..4)?.parse::<i32>().ok()?, month.get(5..7)?.parse::<i32>().ok()?);
    let n = y * 12 + (m - 1) + by;
    Some(format!("{:04}-{:02}", n.div_euclid(12), n.rem_euclid(12) + 1))
}

/// Why a chat turn must not be sent: the code the chat shows and the words.
/// Used by the chat turn before it calls the model (upstream: the licensed monthly limit "stops every kind of turn"). The words are the
/// agent task's own.
pub fn turn_stop(data_dir: &Path, prices_file: &Path) -> Option<(&'static str, String)> {
    match month_cap_for(data_dir, prices_file)? {
        Err(e) => Some(("budget_unreadable", e)),
        Ok(cap) => cap.reached().map(|why| ("budget_month", why)),
    }
}

/// The cap from `<data dir>/budget.json`. No file, no `monthly_usd` or `null` is no cap; a value that is not a positive finite number,
/// or a file that is not a JSON object, is an error (never "no cap").
pub fn load_cap(data_dir: &Path) -> Result<Option<f64>, String> {
    let path = data_dir.join(FILE_NAME);
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("{FILE_NAME}: {e}")),
    };
    let v: Value = serde_json::from_str(&text).map_err(|e| format!("{FILE_NAME}: {e}"))?;
    let Some(o) = v.as_object() else { return Err(format!("{FILE_NAME}: not an object")) };
    match o.get("monthly_usd") {
        None | Some(Value::Null) => Ok(None),
        Some(n) => match n.as_f64() {
            Some(x) if x.is_finite() && x > 0.0 => Ok(Some(x)),
            _ => Err(format!("{FILE_NAME}: monthly_usd must be a positive number")),
        },
    }
}

/// What the ledger says the UTC month `YYYY-MM` spent, and how many of its calls could not be priced. A line's own `cost_usd` is used
/// when it has one (the agent's lines); otherwise its tokens are priced by the table (the chat's lines). A line is the month's by its own
/// `ts` (UTC); a line with no `ts` by the name of its file. The ledger names its files by the owner's LOCAL day, so the files of the day
/// before and after the month are read too (a UTC month and a local month differ by at most a day at each end). A line that does not parse
/// is skipped and counted (upstream skips it); a file that cannot be read is an error, never 0.
pub fn spent_in_month(data_dir: &Path, prices: &Prices, month: &str) -> Result<MonthSpend, String> {
    let usage = data_dir.join("usage");
    let files = match std::fs::read_dir(&usage) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(MonthSpend { usd: 0.0, unpriced_calls: 0, torn_lines: 0 }),
        Err(e) => return Err(format!("{}: {e}", usage.display())),
    };
    let (before, after) = (shift_month(month, -1), shift_month(month, 1));
    let (mut total, mut unpriced, mut torn) = (0.0, 0u32, 0u32);
    for f in files {
        let path = f.map_err(|e| format!("{}: {e}", usage.display()))?.path();
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        // `YYYY-MM-DD.jsonl`: the ledger's own file name for a local day.
        if !(name.len() == 16 && name.ends_with(".jsonl") && name.as_bytes()[7] == b'-') {
            continue;
        }
        let (file_month, day) = (&name[..7], &name[8..10]);
        let near = file_month == month
            || (before.as_deref() == Some(file_month) && day >= "28")
            || (after.as_deref() == Some(file_month) && day == "01");
        if !near {
            continue;
        }
        let text = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        for l in text.lines().filter(|l| !l.trim().is_empty()) {
            let Ok(v) = serde_json::from_str::<Value>(l) else {
                // Only a torn line of a file that could hold this month's spend counts as torn.
                torn += 1;
                continue;
            };
            let line_month = v.get("ts").and_then(Value::as_str).and_then(|t| t.get(..7)).unwrap_or(file_month);
            if line_month != month {
                continue;
            }
            if let Some(c) = v.get("cost_usd").and_then(Value::as_f64) {
                total += c;
                continue;
            }
            let (input, output) = (v.get("in").and_then(Value::as_u64).unwrap_or(0), v.get("out").and_then(Value::as_u64).unwrap_or(0));
            if input + output == 0 {
                continue;
            }
            match v.get("model").and_then(Value::as_str).and_then(|m| prices.cost(m, input, output)) {
                Some(c) => total += c,
                None => unpriced += 1,
            }
        }
    }
    Ok(MonthSpend { usd: total, unpriced_calls: unpriced, torn_lines: torn })
}

/// The cap and the month's spend for a task that is about to start. None: the user set no budget. Err: the budget file, the price table
/// or the ledger could not be read (the task stops: a cap that cannot be checked cannot be kept).
pub fn month_cap_for(data_dir: &Path, prices_file: &Path) -> Option<Result<MonthCap, String>> {
    let cap_usd = match load_cap(data_dir) {
        Ok(Some(c)) => c,
        Ok(None) => return None,
        Err(e) => return Some(Err(e)),
    };
    let build = || -> Result<MonthCap, String> {
        let prices = Prices::load(prices_file)?;
        let month = utc_month_now();
        let spent = spent_in_month(data_dir, &prices, &month)?;
        Ok(MonthCap { cap_usd, month, spent_usd: spent.usd, unpriced_calls: spent.unpriced_calls, torn_lines: spent.torn_lines })
    };
    Some(build())
}

impl MonthCap {
    /// Upstream `measure`: the percent is rounded and capped at 999.
    fn percent(&self) -> u32 {
        ((self.spent_usd / self.cap_usd) * 100.0).round().min(999.0) as u32
    }

    /// Upstream `measure`: reached when the month's use is at or over the cap (`used >= limit`). The words the chat shows. Checked only before
    /// new work starts: a turn that is running finishes, and may take the month past the cap.
    pub fn reached(&self) -> Option<String> {
        if self.spent_usd < self.cap_usd {
            return None;
        }
        let mut why = format!("monthly budget {:.2} USD ({}): {:.2} USD already spent this month", self.cap_usd, self.month, self.spent_usd);
        if self.unpriced_calls > 0 {
            why.push_str(&format!(" ({} call(s) this month could not be priced and are not counted)", self.unpriced_calls));
        }
        if self.torn_lines > 0 {
            why.push_str(&format!(" ({} ledger line(s) could not be read and are not counted)", self.torn_lines));
        }
        Some(why)
    }

    /// Upstream CAP_WARN_PERCENT = 80: at 80% of the cap one line in the log (`usage cap at 81%: ...`). None below 80% and once the cap is
    /// reached (that stops work, `reached`).
    pub fn warning(&self) -> Option<String> {
        let percent = self.percent();
        (percent >= 80 && self.spent_usd < self.cap_usd)
            .then(|| format!("monthly budget at {percent}%: {:.2} USD of {:.2} USD spent ({})", self.spent_usd, self.cap_usd, self.month))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tmp(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("zumi-budget-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("usage")).unwrap();
        d
    }
    fn prices() -> Prices {
        Prices::from_json(&json!({ "_source": {}, "m/p": { "inputPerMtok": 1.0, "outputPerMtok": 3.0, "unverified": false } })).unwrap()
    }
    fn day(d: &Path, date: &str, lines: &[Value]) {
        let text: String = lines.iter().map(|l| format!("{l}\n")).collect();
        std::fs::write(d.join("usage").join(format!("{date}.jsonl")), text).unwrap();
    }

    #[test]
    fn the_cap_is_read_from_budget_json_and_a_missing_one_is_no_cap() {
        let d = tmp("cap");
        assert_eq!(load_cap(&d), Ok(None), "no file: no cap");
        let w = |s: &str| std::fs::write(d.join(FILE_NAME), s).unwrap();
        w(r#"{"monthly_usd": 5.0}"#);
        assert_eq!(load_cap(&d), Ok(Some(5.0)));
        w(r#"{"monthly_usd": null}"#);
        assert_eq!(load_cap(&d), Ok(None));
        w(r#"{}"#);
        assert_eq!(load_cap(&d), Ok(None));
        for bad in [r#"{"monthly_usd": 0}"#, r#"{"monthly_usd": -1}"#, r#"{"monthly_usd": "5"}"#, r#"{"monthly_usd": 1e999}"#, "not json", "[]"] {
            w(bad);
            assert!(load_cap(&d).is_err(), "{bad} must be refused, not read as no cap");
        }
    }

    #[test]
    fn the_month_counts_agent_and_chat_lines_of_that_month_only() {
        let d = tmp("sum");
        day(&d, "2026-11-03", &[json!({ "model": "m/p", "in": 1_000_000, "out": 0, "task": "t", "cost_usd": 0.25 }), json!({ "model": "m/p", "kind": "chat", "in": 1_000_000, "out": 100_000, "ok": true })]);
        day(&d, "2026-11-19", &[json!({ "model": "m/p", "in": 0, "out": 0, "ok": false })]);
        day(&d, "2026-10-31", &[json!({ "model": "m/p", "in": 5_000_000, "out": 0, "ok": true })]);
        day(&d, "2026-12-01", &[json!({ "model": "m/p", "in": 5_000_000, "out": 0, "ok": true })]);
        std::fs::write(d.join("usage").join("notes.txt"), "ignored").unwrap();
        let s = spent_in_month(&d, &prices(), "2026-11").unwrap();
        // agent line: its own cost 0.25; chat line priced by the table: 1.0 + 0.3 = 1.3; the failed empty call is 0
        assert!((s.usd - 1.55).abs() < 1e-9, "{}", s.usd);
        assert_eq!((s.unpriced_calls, s.torn_lines), (0, 0));
        assert!((spent_in_month(&d, &prices(), "2026-10").unwrap().usd - 5.0).abs() < 1e-9);
        assert_eq!(spent_in_month(&d, &prices(), "2025-01").unwrap(), MonthSpend { usd: 0.0, unpriced_calls: 0, torn_lines: 0 }, "an empty month is 0");
    }

    /// Upstream (usage-caps.md): "Days and months are UTC, as the usage ledger's are." Zumi's ledger names its files by the owner's LOCAL day,
    /// so a line is placed by its own `ts`, and the files next to the month's are read too.
    #[test]
    fn the_month_is_the_utc_month_of_each_line_whatever_local_day_its_file_is_named_for() {
        let d = tmp("utc");
        // UTC+7: 20:00Z on 30 Nov is 03:00 on 1 Dec local, so the file is a December one; the line is November's.
        day(&d, "2026-12-01", &[json!({ "ts": "2026-11-30T20:00:00.000Z", "model": "m/p", "in": 1_000_000, "out": 0, "ok": true }), json!({ "ts": "2026-12-01T01:00:00.000Z", "model": "m/p", "in": 2_000_000, "out": 0, "ok": true })]);
        // UTC-5: 00:30Z on 1 Dec is 19:30 on 30 Nov local, so the file is a November one; the line is December's.
        day(&d, "2026-11-30", &[json!({ "ts": "2026-12-01T00:30:00.000Z", "model": "m/p", "in": 4_000_000, "out": 0, "ok": true }), json!({ "ts": "2026-11-30T12:00:00.000Z", "model": "m/p", "in": 8_000_000, "out": 0, "ok": true })]);
        // a line with no ts is placed by its file's name
        day(&d, "2026-11-10", &[json!({ "model": "m/p", "in": 16_000_000, "out": 0, "ok": true })]);
        // far-away files are never opened (a torn line there does not matter)
        std::fs::write(d.join("usage").join("2026-09-15.jsonl"), "{torn\n").unwrap();
        let nov = spent_in_month(&d, &prices(), "2026-11").unwrap().usd;
        let dec = spent_in_month(&d, &prices(), "2026-12").unwrap().usd;
        assert!((nov - (1.0 + 8.0 + 16.0)).abs() < 1e-9, "November by UTC: {nov}");
        assert!((dec - (2.0 + 4.0)).abs() < 1e-9, "December by UTC: {dec}");
    }

    /// Upstream usage-caps.ts reads a ledger line with `try { JSON.parse(line) } catch { continue }`: a torn line is skipped. Said, not hidden.
    #[test]
    fn a_call_that_cannot_be_priced_is_unpriced_and_a_torn_line_is_skipped_and_counted_but_an_unreadable_file_is_an_error() {
        let d = tmp("unpriced");
        day(&d, "2026-11-03", &[json!({ "model": "never/heard", "in": 1000, "out": 1000, "ok": true }), json!({ "model": "m/p", "in": 1_000_000, "out": 0, "ok": true })]);
        let s = spent_in_month(&d, &prices(), "2026-11").unwrap();
        assert_eq!(((s.usd * 1000.0).round(), s.unpriced_calls, s.torn_lines), (1000.0, 1, 0));
        std::fs::write(d.join("usage").join("2026-11-04.jsonl"), "{torn\n{\"model\":\"m/p\",\"in\":1000000,\"out\":0,\"ok\":true}\n").unwrap();
        let s = spent_in_month(&d, &prices(), "2026-11").unwrap();
        assert_eq!(((s.usd * 1000.0).round(), s.torn_lines), (2000.0, 1), "the torn line is skipped, the line after it still counts");
        // a file that cannot be read at all is still an error (not 0): a directory named like a ledger day
        std::fs::create_dir(d.join("usage").join("2026-11-05.jsonl")).unwrap();
        assert!(spent_in_month(&d, &prices(), "2026-11").is_err(), "an unreadable file is an error, never 0");
    }

    fn cap(cap_usd: f64, spent_usd: f64) -> MonthCap {
        MonthCap { cap_usd, month: "2026-11".into(), spent_usd, unpriced_calls: 0, torn_lines: 0 }
    }

    /// Upstream `measure`: `reached: used >= limit`. No worst case of a next call: a cap is checked before new work starts only.
    #[test]
    fn the_cap_is_reached_when_the_month_has_spent_the_cap_and_the_words_say_the_cap_the_month_and_the_spend() {
        assert_eq!(cap(5.0, 4.99).reached(), None, "4.99 of 5.00: new work may start");
        let why = cap(5.0, 5.0).reached().expect("exactly at the cap is reached (used >= limit)");
        for part in ["monthly budget", "5.00", "2026-11", "already spent"] {
            assert!(why.contains(part), "{part} in {why}");
        }
        assert!(!why.contains("next call"), "no worst-case projection: {why}");
        assert!(cap(5.0, 6.25).reached().unwrap().contains("6.25"));
        let with = MonthCap { unpriced_calls: 3, torn_lines: 2, ..cap(5.0, 5.0) };
        let why = with.reached().unwrap();
        assert!(why.contains("3 call") && why.contains("2 ledger line"), "what could not be counted is said: {why}");
    }

    /// Upstream CAP_WARN_PERCENT = 80: "one line in the server log (usage cap at 81%: ...)".
    #[test]
    fn at_eighty_percent_there_is_one_warning_line_and_below_it_and_at_the_cap_there_is_none() {
        assert_eq!(cap(5.0, 3.9).warning(), None, "78%");
        assert!(cap(5.0, 3.99).warning().unwrap().contains("80%"), "79.8% rounds to 80, as upstream's measure does");
        let w = cap(5.0, 4.05).warning().expect("81%");
        for part in ["81%", "4.05", "5.00", "2026-11"] {
            assert!(w.contains(part), "{part} in {w}");
        }
        assert!(cap(5.0, 4.0).warning().is_some(), "exactly 80%");
        assert_eq!(cap(5.0, 5.0).warning(), None, "at the cap it is reached, not a warning");
    }

    #[test]
    fn a_turn_is_stopped_with_the_same_words_when_the_month_is_reached_or_the_files_cannot_be_read() {
        let d = tmp("turn");
        let prices_file = d.join("prices.json");
        std::fs::write(&prices_file, json!({ "_source": {}, "m/p": { "inputPerMtok": 1.0, "outputPerMtok": 3.0, "unverified": false } }).to_string()).unwrap();
        assert_eq!(turn_stop(&d, &prices_file), None, "no budget: no stop");
        std::fs::write(d.join(FILE_NAME), r#"{"monthly_usd": 2.0}"#).unwrap();
        let line = |tokens: u64| json!({ "ts": crate::ledger::iso_utc(crate::types::unix_ms()), "model": "m/p", "kind": "chat", "in": tokens, "out": 0, "ok": true });
        day(&d, &crate::ledger::local_date(), &[line(1_000_000)]);
        assert_eq!(turn_stop(&d, &prices_file), None, "1.00 of 2.00 spent: the turn may go");
        day(&d, &crate::ledger::local_date(), &[line(1_000_000), line(1_500_000)]);
        let (code, text) = turn_stop(&d, &prices_file).expect("2.50 of 2.00 spent");
        assert_eq!(code, "budget_month");
        let c = month_cap_for(&d, &prices_file).unwrap().unwrap();
        assert_eq!(text, c.reached().unwrap(), "the very words the agent task stops with");
        std::fs::write(d.join(FILE_NAME), "garbage").unwrap();
        let (code, text) = turn_stop(&d, &prices_file).expect("a budget that cannot be read stops the turn");
        assert_eq!(code, "budget_unreadable");
        assert!(text.contains("budget.json"), "{text}");
    }

    #[test]
    fn month_cap_for_is_none_without_a_budget_and_an_error_when_the_files_are_broken() {
        let d = tmp("for");
        let prices_file = d.join("prices.json");
        std::fs::write(&prices_file, json!({ "_source": {}, "m/p": { "inputPerMtok": 1.0, "outputPerMtok": 3.0, "unverified": false } }).to_string()).unwrap();
        assert!(month_cap_for(&d, &prices_file).is_none());
        std::fs::write(d.join(FILE_NAME), r#"{"monthly_usd": 2.0}"#).unwrap();
        let date = crate::ledger::local_date();
        day(&d, &date, &[json!({ "ts": crate::ledger::iso_utc(crate::types::unix_ms()), "model": "m/p", "in": 500_000, "out": 0, "ok": true })]);
        let c = month_cap_for(&d, &prices_file).unwrap().unwrap();
        assert_eq!((c.cap_usd, c.month.as_str()), (2.0, utc_month_now().as_str()));
        assert!((c.spent_usd - 0.5).abs() < 1e-9);
        std::fs::write(d.join(FILE_NAME), "garbage").unwrap();
        assert!(month_cap_for(&d, &prices_file).unwrap().is_err(), "a budget that cannot be read stops the task");
        std::fs::write(d.join(FILE_NAME), r#"{"monthly_usd": 2.0}"#).unwrap();
        assert!(month_cap_for(&d, &d.join("missing-prices.json")).unwrap().is_err());
    }
}
