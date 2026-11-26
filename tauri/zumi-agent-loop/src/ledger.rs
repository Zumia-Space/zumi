//! Tokens and cost per model turn, written to the existing usage ledger (`src/main/usage-ledger.js`): one JSON line per
//! model call in `<dir>/usage/YYYY-MM-DD.jsonl`, the date being the owner's LOCAL calendar date. The line keeps the
//! JS fields (`ts, model, kind, in, out, total, ms, ok`) so `aggregateUsage` reads it, and adds `cost_usd`, `priced`,
//! `task` and `step`. Prices come from the same table the Settings screen uses (`src/main/usage-prices.json`,
//! USD per million tokens); a model that is missing from it, unverified or negative is unpriced: its cost is `None`,
//! never a guess of 0, and the gate stops the task (the cap cannot be enforced on a price nobody knows).
use crate::loop_run::Meter;
use crate::types::{unix_ms, TurnResponse};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq)]
pub struct Prices(HashMap<String, (f64, f64)>);

impl Prices {
    /// The `usage-prices.json` shape: `{ "<model>": { inputPerMtok, outputPerMtok, unverified? }, "_source": .. }`.
    pub fn from_json(v: &Value) -> Result<Prices, String> {
        let o = v.as_object().ok_or("prices must be a JSON object")?;
        let mut m = HashMap::new();
        for (model, p) in o {
            if model.starts_with('_') {
                continue;
            }
            let (i, out) = (p.get("inputPerMtok").and_then(Value::as_f64), p.get("outputPerMtok").and_then(Value::as_f64));
            if let (Some(i), Some(out), false) = (i, out, p.get("unverified") == Some(&json!(true))) {
                if i >= 0.0 && out >= 0.0 {
                    m.insert(model.clone(), (i, out));
                }
            }
        }
        Ok(Prices(m))
    }

    pub fn load(path: &std::path::Path) -> Result<Prices, String> {
        let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
        Prices::from_json(&serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?)
    }

    /// This table plus one model the user priced (R3: a custom endpoint's `custom:<model>`; 0 and 0 for a model on this PC).
    pub fn with_model(mut self, model: &str, input_per_mtok: f64, output_per_mtok: f64) -> Prices {
        self.0.insert(model.to_string(), (input_per_mtok, output_per_mtok));
        self
    }

    /// The price of a model: the exact id, or, for a bare id (no `vendor/`), the ONE vendor entry whose model part is that id. OpenCode Go
    /// sends `deepseek-v4.1-flash` for the model the table keys as `deepseek/deepseek-v4.1-flash` (R6c A). Upstream prices by `driver/model`,
    /// then `model`, then a default. Two vendors with one bare id, an unverified entry or no entry at all: unpriced, never a guess.
    fn price_of(&self, model: &str) -> Option<(f64, f64)> {
        if let Some(p) = self.0.get(model) {
            return Some(*p);
        }
        if model.is_empty() || model.contains('/') {
            return None;
        }
        let mut hits = self.0.iter().filter(|(k, _)| k.rsplit_once('/').is_some_and(|(_, m)| m == model));
        match (hits.next(), hits.next()) {
            (Some((_, p)), None) => Some(*p),
            _ => None,
        }
    }

    /// USD for a turn, or None when the model is unpriced.
    pub fn cost(&self, model: &str, input: u64, output: u64) -> Option<f64> {
        self.price_of(model).map(|(i, o)| (input as f64 / 1e6) * i + (output as f64 / 1e6) * o)
    }
}

/// `YYYY-MM-DDTHH:MM:SS.mmmZ` for a unix time in ms (what `Date.toISOString` prints).
pub fn iso_utc(ms: u64) -> String {
    let (days, rem) = ((ms / 86_400_000) as i64, ms % 86_400_000);
    // Howard Hinnant's civil-from-days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z", rem / 3_600_000, rem / 60_000 % 60, rem / 1000 % 60, rem % 1000)
}

/// The owner's local calendar date, `YYYY-MM-DD` (usage-ledger.js `localDate`).
#[cfg(windows)]
pub fn local_date() -> String {
    // SAFETY: GetLocalTime has no preconditions; it returns the current local time by value.
    let t = unsafe { windows::Win32::System::SystemInformation::GetLocalTime() };
    format!("{:04}-{:02}-{:02}", t.wYear, t.wMonth, t.wDay)
}
#[cfg(not(windows))]
pub fn local_date() -> String {
    iso_utc(unix_ms())[..10].to_string()
}

/// What every agent task has spent so far: the sum of `cost_usd` over the ledger lines that carry a `task`.
/// No `usage/` folder yet is 0. Anything else that cannot be read (the folder, a file, a line that is not JSON) is an
/// error, never 0: a total that silently under-counts would let the total cap pass a call (P3d, fail closed).
pub fn total_agent_cost_usd(dir: &std::path::Path) -> Result<f64, String> {
    let usage = dir.join("usage");
    let files = match std::fs::read_dir(&usage) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0.0),
        Err(e) => return Err(format!("{}: {e}", usage.display())),
    };
    let mut total = 0.0;
    for f in files {
        let path = f.map_err(|e| format!("{}: {e}", usage.display()))?.path();
        // The ledger is the `*.jsonl` files; anything else in the folder (a backup, an editor's temp file) is not.
        if path.extension().and_then(|x| x.to_str()) != Some("jsonl") {
            continue;
        }
        let text = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        for (n, l) in text.lines().enumerate().filter(|(_, l)| !l.trim().is_empty()) {
            let v: Value = serde_json::from_str(l).map_err(|e| format!("{} line {}: {e}", path.display(), n + 1))?;
            if v.get("task").is_some() {
                total += v.get("cost_usd").and_then(Value::as_f64).unwrap_or(0.0);
            }
        }
    }
    Ok(total)
}

/// Writes one ledger record, newline included, in ONE write call: the file is opened in append mode and the JS chat
/// ledger appends to it too, so a record split over several calls could get the other writer's line in between.
fn write_record(w: &mut impl Write, line: &Value) -> std::io::Result<()> {
    let mut record = line.to_string().into_bytes();
    record.push(b'\n');
    w.write_all(&record)
}

pub struct Ledger {
    dir: PathBuf,
    prices: Prices,
    task: String,
    date: Box<dyn Fn() -> String>,
    now: Box<dyn Fn() -> u64>,
    /// Lines that could not be written. The JS ledger swallows such errors; here they are counted, and the last one is
    /// what `Meter::write_error` gives the loop, which stops the task `ledger_failed` (after a paid turn or a failed one).
    pub write_errors: u32,
    last_write_error: Option<String>,
}

impl Ledger {
    pub fn new(dir: PathBuf, prices: Prices, task: &str) -> Ledger {
        Ledger { dir, prices, task: task.to_string(), date: Box::new(local_date), now: Box::new(unix_ms), write_errors: 0, last_write_error: None }
    }

    pub fn with_clock(mut self, date: impl Fn() -> String + 'static, now: impl Fn() -> u64 + 'static) -> Ledger {
        self.date = Box::new(date);
        self.now = Box::new(now);
        self
    }

    fn append(&mut self, line: &Value) {
        let dir = self.dir.join("usage");
        let wrote = std::fs::create_dir_all(&dir).and_then(|_| std::fs::OpenOptions::new().create(true).append(true).open(dir.join(format!("{}.jsonl", (self.date)())))).and_then(|mut f| write_record(&mut f, line));
        if let Err(e) = wrote {
            self.write_errors += 1;
            self.last_write_error = Some(format!("usage ledger {}: {e}", dir.display()));
        }
    }
}

impl Meter for Ledger {
    fn worst_case_usd(&self, model: &str, request_bytes: usize) -> Option<f64> {
        self.prices.cost(model, request_bytes as u64, crate::transport::MAX_OUTPUT_TOKENS)
    }

    fn record_turn(&mut self, r: &TurnResponse, step: u32) -> Option<f64> {
        let cost = self.prices.cost(&r.model, r.usage.input, r.usage.output);
        let line = json!({
            "ts": iso_utc((self.now)()), "model": r.model, "kind": "chat", "in": r.usage.input, "out": r.usage.output,
            "total": r.usage.input + r.usage.output, "ms": r.ms, "ok": true,
            "cost_usd": cost, "priced": cost.is_some(), "task": self.task, "step": step,
        });
        self.append(&line);
        cost
    }

    /// No usage came back, so the line carries the worst case the precheck allowed (`cost_basis: worst_case`), counted by
    /// `total_agent_cost_usd` like any other agent line.
    fn record_failed_turn(&mut self, model: &str, worst_case_usd: Option<f64>, step: u32, code: &str) {
        let line = json!({
            "ts": iso_utc((self.now)()), "model": model, "kind": "chat", "in": 0, "out": 0, "total": 0, "ms": 0, "ok": false,
            "error": code, "cost_usd": worst_case_usd, "priced": worst_case_usd.is_some(), "cost_basis": "worst_case", "task": self.task, "step": step,
        });
        self.append(&line);
    }

    fn write_error(&self) -> Option<String> {
        self.last_write_error.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Usage;

    fn resp(model: &str, i: u64, o: u64) -> TurnResponse {
        TurnResponse { text: String::new(), tool_calls: vec![], usage: Usage { input: i, output: o }, model: model.to_string(), ms: 42 }
    }
    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("zumi-ledger-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }
    fn prices() -> Prices {
        Prices::from_json(&json!({ "_source": {}, "mock/loop-v1": { "inputPerMtok": 1.0, "outputPerMtok": 3.0, "unverified": false }, "x/unverified": { "inputPerMtok": 1, "outputPerMtok": 1, "unverified": true }, "x/negative": { "inputPerMtok": -1, "outputPerMtok": 1 } })).unwrap()
    }

    /// Counts the `write` calls a record takes.
    struct CountingWriter {
        writes: usize,
        bytes: Vec<u8>,
    }
    impl Write for CountingWriter {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
            self.writes += 1;
            self.bytes.extend_from_slice(b);
            Ok(b.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn p3e_one_record_is_one_write_call_so_a_concurrent_append_cannot_tear_it() {
        // The JS chat ledger appends to the same file. With O_APPEND each write call lands whole at the end, but two
        // calls for one record let the other writer's line land between them: a torn line, which (P3d) stops every task.
        let line = json!({ "ts": "2026-11-12T00:00:00.000Z", "model": "m", "kind": "chat", "in": 1, "out": 2, "task": "t", "step": 1 });
        let mut w = CountingWriter { writes: 0, bytes: Vec::new() };
        write_record(&mut w, &line).unwrap();
        assert_eq!(w.writes, 1, "one record, one write call");
        assert_eq!(w.bytes, format!("{line}\n").into_bytes());
    }

    #[test]
    fn cost_is_tokens_times_the_per_million_price() {
        let p = prices();
        assert_eq!(p.cost("mock/loop-v1", 1_000_000, 1_000_000), Some(4.0));
        let c = p.cost("mock/loop-v1", 520, 70).unwrap();
        assert!((c - (520.0 / 1e6 + 70.0 * 3.0 / 1e6)).abs() < 1e-12);
    }

    #[test]
    fn m2_worst_case_is_the_request_at_the_input_price_plus_max_output_at_the_output_price() {
        let mut l = Ledger::new(tmp("worst"), prices(), "t");
        let w = l.worst_case_usd("mock/loop-v1", 2000).unwrap();
        assert!((w - (2000.0 / 1e6 * 1.0 + 1000.0 / 1e6 * 3.0)).abs() < 1e-12, "{w}");
        assert_eq!(l.worst_case_usd("never/heard-of-it", 10), None, "unpriced: no bound, so no call");
        assert_eq!(l.worst_case_usd("x/unverified", 10), None);
        let _ = &mut l;
    }

    #[test]
    fn bite_unpriced_models_have_no_cost_never_zero() {
        let p = prices();
        for m in ["x/unverified", "x/negative", "never/heard-of-it"] {
            assert_eq!(p.cost(m, 1000, 1000), None, "{m}");
        }
        assert!(Prices::from_json(&json!([1])).is_err());
    }

    #[test]
    fn the_repos_own_price_table_loads_and_prices_a_known_model() {
        let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src/main/usage-prices.json");
        let p = Prices::load(&file).unwrap();
        // inputPerMtok 1, outputPerMtok 2.7 in the table (usage-cost.js estimateCostUsd gives the same figure).
        assert_eq!(p.cost("stepfun/step-5-preview", 1_000_000, 1_000_000), Some(3.7));
        assert_eq!(p.cost("mock/loop-v1", 1, 1), None, "the mock model is not in the shared table");
    }

    /// R6c A: OpenCode Go sends the bare id `deepseek-v4.1-flash`; the table keys the same model as `deepseek/deepseek-v4.1-flash`
    /// (OpenRouter). Upstream prices a turn by `driver/model`, then `model`, then a default; here the one vendor entry whose model part is
    /// the bare id is that model. Two vendors with the same bare id stay unpriced (no guess), and `:batch` variants are other ids.
    #[test]
    fn r6c_a_bare_model_id_is_priced_by_the_one_vendor_entry_that_has_it() {
        let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src/main/usage-prices.json");
        let p = Prices::load(&file).unwrap();
        let vendor = p.cost("deepseek/deepseek-v4.1-flash", 1_000_000, 1_000_000).expect("the table prices the vendor id");
        assert_eq!(p.cost("deepseek-v4.1-flash", 1_000_000, 1_000_000), Some(vendor), "the bare id Go sends is the same model");
        let t = Prices::from_json(&json!({
            "_source": {},
            "a/shared-id": { "inputPerMtok": 1.0, "outputPerMtok": 1.0 }, "b/shared-id": { "inputPerMtok": 9.0, "outputPerMtok": 9.0 },
            "a/only-here": { "inputPerMtok": 1.0, "outputPerMtok": 2.0 }, "a/only-here:batch": { "inputPerMtok": 0.5, "outputPerMtok": 1.0 },
            "a/unv": { "inputPerMtok": 1.0, "outputPerMtok": 2.0, "unverified": true }
        })).unwrap();
        assert_eq!(t.cost("shared-id", 1, 1), None, "two vendors, two prices: not guessed");
        assert_eq!(t.cost("only-here", 1_000_000, 0), Some(1.0), "the :batch twin is another id");
        assert_eq!(t.cost("unv", 1, 1), None, "an unverified entry stays unpriced under its bare id too");
        assert_eq!(t.cost("a/unlisted", 1, 1), None);
        assert_eq!(t.cost("", 1, 1), None);
    }

    #[test]
    fn iso_time_matches_date_to_iso_string() {
        assert_eq!(iso_utc(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_utc(1_700_000_000_123), "2023-11-14T22:13:20.123Z");
        assert_eq!(iso_utc(951_782_400_000), "2000-02-29T00:00:00.000Z", "a leap day");
    }

    #[test]
    fn each_turn_is_one_line_in_the_usage_ledger_shape_in_the_local_dated_file() {
        let dir = tmp("lines");
        let mut l = Ledger::new(dir.clone(), prices(), "t1").with_clock(|| "2026-11-11".into(), || 1_700_000_000_123);
        let c1 = l.record_turn(&resp("mock/loop-v1", 520, 70), 1);
        let c2 = l.record_turn(&resp("mock/loop-v1", 640, 40), 2);
        assert!(c1.is_some() && c2.is_some());
        let text = std::fs::read_to_string(dir.join("usage/2026-11-11.jsonl")).unwrap();
        let lines: Vec<Value> = text.lines().map(|l| serde_json::from_str(l).unwrap()).collect();
        assert_eq!(lines.len(), 2);
        let a = &lines[0];
        for k in ["ts", "model", "kind", "in", "out", "total", "ms", "ok"] {
            assert!(a.get(k).is_some(), "the ledger field {k}");
        }
        assert_eq!((a["in"].as_u64(), a["out"].as_u64(), a["total"].as_u64(), a["kind"].as_str(), a["ts"].as_str()), (Some(520), Some(70), Some(590), Some("chat"), Some("2023-11-14T22:13:20.123Z")));
        assert_eq!(a["cost_usd"].as_f64(), c1);
        assert_eq!((lines[1]["task"].as_str(), lines[1]["step"].as_u64()), (Some("t1"), Some(2)));
        assert_eq!(l.write_errors, 0);
    }

    #[test]
    fn an_unpriced_turn_is_still_a_line_but_with_a_null_cost_and_the_meter_says_none() {
        let dir = tmp("unpriced");
        let mut l = Ledger::new(dir.clone(), prices(), "t").with_clock(|| "2026-11-11".into(), || 0);
        assert_eq!(l.record_turn(&resp("other/model", 10, 10), 1), None);
        let line: Value = serde_json::from_str(std::fs::read_to_string(dir.join("usage/2026-11-11.jsonl")).unwrap().trim()).unwrap();
        assert_eq!((line["cost_usd"].clone(), line["priced"].clone()), (Value::Null, json!(false)));
    }

    #[test]
    fn the_running_total_sums_the_agent_lines_only() {
        let dir = tmp("total");
        let mut l = Ledger::new(dir.clone(), prices(), "t1").with_clock(|| "2026-11-11".into(), || 0);
        l.record_turn(&resp("mock/loop-v1", 1_000_000, 0), 1);
        l.record_turn(&resp("mock/loop-v1", 0, 1_000_000), 2);
        std::fs::write(dir.join("usage/2026-11-10.jsonl"), "{\"model\":\"chat\",\"cost_usd\":99}
{\"task\":\"old\",\"cost_usd\":0.25}

").unwrap();
        assert!((total_agent_cost_usd(&dir).unwrap() - (1.0 + 3.0 + 0.25)).abs() < 1e-9, "chat lines are not counted");
        assert_eq!(total_agent_cost_usd(&tmp("none")), Ok(0.0), "no ledger yet: nothing spent");
    }

    #[test]
    fn p3d_a_ledger_that_cannot_be_read_is_an_error_never_zero() {
        let dir = tmp("garbage");
        std::fs::create_dir_all(dir.join("usage")).unwrap();
        std::fs::write(dir.join("usage/2026-11-10.jsonl"), "{\"task\":\"old\",\"cost_usd\":0.25}
not json
").unwrap();
        let e = total_agent_cost_usd(&dir).unwrap_err();
        assert!(e.contains("2026-11-10.jsonl line 2"), "{e}");
        let other = tmp("other-files");
        std::fs::create_dir_all(other.join("usage/sub.jsonl.d")).unwrap();
        std::fs::write(other.join("usage/2026-11-10.jsonl"), "{\"task\":\"old\",\"cost_usd\":0.25}\n").unwrap();
        std::fs::write(other.join("usage/2026-11-10.jsonl.bak"), "not json\n").unwrap();
        std::fs::write(other.join("usage/notes.txt"), "not json\n").unwrap();
        assert_eq!(total_agent_cost_usd(&other), Ok(0.25), "P3e: only *.jsonl files are the ledger");
        let file = tmp("usage-file");
        std::fs::create_dir_all(&file).unwrap();
        std::fs::write(file.join("usage"), "a file where the folder should be").unwrap();
        assert!(total_agent_cost_usd(&file).is_err());
    }

    #[test]
    fn s2_a_failed_or_cancelled_turn_is_a_line_at_its_worst_case_and_counts_in_the_running_total() {
        let dir = tmp("failed");
        let mut l = Ledger::new(dir.clone(), prices(), "t9").with_clock(|| "2026-11-12".into(), || 0);
        l.record_failed_turn("mock/loop-v1", Some(0.004), 3, "cancelled");
        let text = std::fs::read_to_string(dir.join("usage/2026-11-12.jsonl")).unwrap_or_default();
        let line: Value = serde_json::from_str(text.trim()).unwrap_or(Value::Null);
        assert_eq!((line["ok"].clone(), line["cost_usd"].as_f64(), line["error"].as_str(), line["task"].as_str(), line["step"].as_u64()), (json!(false), Some(0.004), Some("cancelled"), Some("t9"), Some(3)), "{text}");
        assert_eq!(line["cost_basis"], "worst_case");
        assert!((total_agent_cost_usd(&dir).unwrap() - 0.004).abs() < 1e-12, "the running total does not under-count");
        assert_eq!(l.write_error(), None);
    }

    #[test]
    fn s2_a_write_that_fails_is_reported_through_the_meter() {
        let dir = tmp("blocked2");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("usage"), "a file where the folder should be").unwrap();
        let mut l = Ledger::new(dir, prices(), "t");
        assert_eq!(l.write_error(), None);
        l.record_turn(&resp("mock/loop-v1", 1, 1), 1);
        assert!(l.write_error().is_some(), "the loop must be able to see it");
    }

    #[test]
    fn a_write_that_fails_is_counted_not_hidden() {
        let dir = tmp("blocked");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("usage"), "a file where the folder should be").unwrap();
        let mut l = Ledger::new(dir, prices(), "t");
        assert!(l.record_turn(&resp("mock/loop-v1", 1, 1), 1).is_some(), "the cost is still known");
        assert_eq!(l.write_errors, 1);
    }
}
