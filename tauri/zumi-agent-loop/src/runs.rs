//! Chat runs (T-31-MAUS R2 "usable from chat"): the registry behind the four renderer methods `agent.start`, `agent.stop`,
//! `agent.status` and `agent.confirm`. A sentence typed in the chat box becomes ONE task on a thread of its own; this module
//! only does the bookkeeping the chat needs and decides nothing about the task itself (the gate, the caps and the hands
//! pack are `runner::run_task`'s, reached through the `TaskFn` the host supplies).
//!
//! * One run at a time: the desktop has one foreground, so a second `agent.start` answers `busy`.
//! * Every loop event is stamped with the run id and handed to `Emit` (the host forwards it to the chat as `agent:event`),
//!   so the chat shows a chip per `tool_start` / `tool_end` without a second event source. A `run_end` event closes the run.
//! * The run list is one JSON line per finished run in `<data>/agent/runs.jsonl` (status, reason, steps, cost): no threads,
//!   no folders. `agent.status` returns the newest rows, the activity of one run read from the gate's audit file
//!   (`<data>/audit/agent/<date>.jsonl`, the same lines `zumi-audit` writes) and the newest frame file of that run.
//! * Stop is `Cancel::set("user")`: the same token the kill hotkey's watch sets (`hands_tools::KillWatch`), so a stop ends the
//!   model wait, the hands call in flight and the helper process within one `cancel::SLICE`.
//! * `ask_confirm` / `agent.confirm` are the one-shot yes/no seam for a native confirm (R5 asks it; nothing in the loop does
//!   yet). An unanswered, cancelled or second answer is a "no", never a "yes".
use crate::cancel::Cancel;
use crate::loop_run::{Outcome, StopReason};
use crate::types::unix_ms;
use serde_json::{json, Value};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Where the host sends each run event (the chat's `agent:event` channel).
pub type Emit = Arc<dyn Fn(Value) + Send + Sync>;
/// One task: (run id, sentence, cancel token, event sink) -> how it ended. The host builds the real one from `agent_wiring`.
pub type TaskFn = Arc<dyn Fn(&str, &str, Cancel, &mut dyn FnMut(Value)) -> Result<Outcome, String> + Send + Sync>;

pub const MAX_SENTENCE_CHARS: usize = 500;
/// Rows `agent.status` returns.
pub const LIST_MAX: usize = 30;
/// Activity lines `agent.status` returns for one run.
pub const ACTIVITY_MAX: usize = 40;
/// A frame bigger than this is not sent over the event/rpc pipe (the pipe's own limit is 512 KB per event).
pub const FRAME_MAX_BYTES: u64 = 512 * 1024;
/// The most of a file read back from its end (runs list, audit): a day of audit lines is far below it.
const TAIL_BYTES: u64 = 4 * 1024 * 1024;
const ROW_SENTENCE_CHARS: usize = 120;
const REASON_CHARS: usize = 200;

pub fn is_method(method: &str) -> bool {
    matches!(method, "agent.start" | "agent.stop" | "agent.status" | "agent.confirm")
}

struct Active {
    id: String,
    sentence: String,
    cancel: Cancel,
    started_ms: u64,
    cost_usd: f64,
    steps: u32,
}

struct Pending {
    id: String,
    text: String,
    run: Option<String>,
    answer: Option<bool>,
}

#[derive(Default)]
struct State {
    active: Option<Active>,
    pending: Option<Pending>,
    last_ms: u64,
}

struct Shared {
    /// R6: held for the whole of a run (see `run_one`), so the PC does not idle-sleep under a task and is given back when it ends.
    keep_awake: zumi_audit::keepawake::KeepAwake,
    data_dir: PathBuf,
    emit: Emit,
    task: TaskFn,
    state: Mutex<State>,
}

#[derive(Clone)]
pub struct Runs {
    shared: Arc<Shared>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

fn err(code: &str) -> Value {
    json!({ "ok": false, "error": code })
}

fn clip(s: &str, chars: usize) -> String {
    s.chars().take(chars).collect()
}

/// `c-` and 32 hex digits of OS randomness; None when the OS gives none (the question is then not asked: a "no").
fn new_confirm_id() -> Option<String> {
    let key = zumi_audit::hostmac::new_key().ok()?;
    key.get(..16).map(|b| format!("c-{}", zumi_audit::hostmac::to_hex(b)))
}

/// A run id is `chat-<unix ms>`; anything else is never turned into a path.
fn id_ok(id: &str) -> bool {
    !id.is_empty() && id.len() <= 40 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

fn sentence_ok(s: &str) -> bool {
    !s.is_empty() && s.chars().count() <= MAX_SENTENCE_CHARS && !s.chars().any(|c| c.is_control() && c != '\n' && c != '\t')
}

impl Runs {
    pub fn new(data_dir: &Path, emit: Emit, task: TaskFn) -> Runs {
        Runs::new_with(data_dir, emit, task, zumi_audit::keepawake::KeepAwake::off())
    }

    /// `new`, with the keep-awake the host shares between the runs and the routines.
    pub fn new_with(data_dir: &Path, emit: Emit, task: TaskFn, keep_awake: zumi_audit::keepawake::KeepAwake) -> Runs {
        Runs { shared: Arc::new(Shared { keep_awake, data_dir: data_dir.to_path_buf(), emit, task, state: Mutex::new(State::default()) }) }
    }

    /// The renderer's `agent.*` call. `Err` only for a name this module does not own; every refusal of a known name is a
    /// value `{ ok:false, error }` the chat can show.
    pub fn serve(&self, method: &str, args: &[Value]) -> Result<Value, String> {
        match method {
            "agent.start" => Ok(match args.first().and_then(Value::as_str) {
                Some(sentence) if args.len() == 1 => self.start(sentence),
                _ => err("bad_args"),
            }),
            // `{ all: true }` is accepted and means the same: there is one run at a time, so "stop" is already "stop all".
            "agent.stop" => Ok(self.stop()),
            "agent.status" => match args.first() {
                None | Some(Value::Null) => Ok(self.status(None)),
                Some(Value::String(id)) => Ok(self.status(Some(id))),
                Some(_) => Ok(err("bad_args")),
            },
            "agent.confirm" => Ok(match (args.first().and_then(Value::as_str), args.get(1).and_then(Value::as_bool)) {
                (Some(id), Some(allow)) => self.confirm(id, allow),
                _ => err("bad_args"),
            }),
            other => Err(format!("not_implemented:{other}")),
        }
    }

    fn start(&self, sentence: &str) -> Value {
        let sentence = sentence.trim().to_string();
        if !sentence_ok(&sentence) {
            return err("bad_sentence");
        }
        let (id, cancel, started_ms) = {
            let mut st = lock(&self.shared.state);
            if st.active.is_some() {
                return err("busy");
            }
            let now = unix_ms();
            let ms = if now > st.last_ms { now } else { st.last_ms + 1 };
            st.last_ms = ms;
            let (id, cancel) = (format!("chat-{ms}"), Cancel::new());
            st.active = Some(Active { id: id.clone(), sentence: sentence.clone(), cancel: cancel.clone(), started_ms: ms, cost_usd: 0.0, steps: 0 });
            (id, cancel, ms)
        };
        let shared = self.shared.clone();
        let (run_id, run_sentence) = (id.clone(), sentence.clone());
        let spawned = std::thread::Builder::new().name(format!("zumi-{id}")).spawn(move || run_one(&shared, &run_id, &run_sentence, cancel, started_ms));
        if let Err(e) = spawned {
            lock(&self.shared.state).active = None;
            eprintln!("agent: could not start a thread for {id}: {e}");
            return err("thread_failed");
        }
        json!({ "ok": true, "id": id })
    }

    fn stop(&self) -> Value {
        let st = lock(&self.shared.state);
        // A task waiting on a confirm sees the same token and takes it as a "no".
        let stopped = match &st.active {
            Some(a) => u32::from(a.cancel.set("user")),
            None => 0,
        };
        json!({ "ok": true, "stopped": stopped })
    }

    fn status(&self, wanted: Option<&str>) -> Value {
        let (active_row, pending) = {
            let st = lock(&self.shared.state);
            let row = st.active.as_ref().map(|a| row_json(&a.id, &a.sentence, "running", None, a.steps, a.cost_usd, a.started_ms, None));
            let pending = st.pending.as_ref().filter(|p| p.answer.is_none()).map(|p| json!({ "id": p.id, "text": p.text, "run": p.run }));
            (row, pending)
        };
        let (mut history, skipped) = read_rows(&self.shared.data_dir);
        if let Some(a) = &active_row {
            history.retain(|r| r["id"] != a["id"]);
        }
        let mut runs: Vec<Value> = active_row.iter().cloned().collect();
        runs.extend(history);
        runs.truncate(LIST_MAX);
        let selected = match wanted {
            Some(id) => runs.iter().find(|r| r["id"] == id).cloned(),
            None => runs.first().cloned(),
        };
        let (activity, frame) = match &selected {
            Some(row) => {
                let id = row["id"].as_str().unwrap_or_default();
                (read_activity(&self.shared.data_dir, row["started_ms"].as_u64().unwrap_or(0), row["ended_ms"].as_u64()), read_frame(&self.shared.data_dir, id))
            }
            None => (Vec::new(), Value::Null),
        };
        json!({
            "ok": true,
            "active": active_row,
            "runs": runs,
            "selected": selected.as_ref().map(|r| r["id"].clone()).unwrap_or(Value::Null),
            "activity": activity,
            "frame": frame,
            "confirm": pending,
            "skipped": skipped,
        })
    }

    /// Asks the user yes/no through the chat and waits for `agent.confirm`. True only for an explicit yes with the same id.
    /// No answer within `wait`, a set cancel token, or another question already open: false.
    pub fn ask_confirm(&self, text: &str, wait: Duration, cancel: &Cancel) -> bool {
        let (id, run) = {
            let mut st = lock(&self.shared.state);
            if st.pending.is_some() || cancel.is_set() {
                return false;
            }
            // 128 random bits from the OS: another process or the sidecar cannot guess the id of a pending question.
            let Some(id) = new_confirm_id() else { return false };
            let run = st.active.as_ref().map(|a| a.id.clone());
            st.pending = Some(Pending { id: id.clone(), text: clip(text, 300), run: run.clone(), answer: None });
            (id, run)
        };
        (self.shared.emit)(json!({ "ev": "confirm", "t_unix_ms": unix_ms(), "run": run, "id": id, "text": clip(text, 300) }));
        let end = Instant::now() + wait;
        let mut allowed = false;
        while Instant::now() < end && !cancel.is_set() {
            if let Some(answer) = lock(&self.shared.state).pending.as_ref().and_then(|p| p.answer) {
                allowed = answer;
                break;
            }
            std::thread::sleep(crate::cancel::SLICE);
        }
        lock(&self.shared.state).pending = None;
        (self.shared.emit)(json!({ "ev": "confirm_end", "t_unix_ms": unix_ms(), "run": run, "id": id }));
        allowed
    }

    fn confirm(&self, id: &str, allow: bool) -> Value {
        let mut st = lock(&self.shared.state);
        // The answer must come in the run that asked: a question asked outside a run (or by an earlier run) is not answered
        // from another one. Single use: once answered the slot is closed (`answer` is set) and then cleared by the asker.
        let in_run = st.active.as_ref().map(|a| a.id.clone());
        match st.pending.as_mut() {
            Some(p) if p.id == id && p.answer.is_none() && p.run == in_run => {
                p.answer = Some(allow);
                json!({ "ok": true })
            }
            _ => err("no_pending"),
        }
    }
}

/// The thread of one run.
fn run_one(shared: &Arc<Shared>, id: &str, sentence: &str, cancel: Cancel, started_ms: u64) {
    let emit = shared.emit.clone();
    // R6: the PC stays awake while the task works; the hold is dropped as soon as the task is over (done, error, panic or stop),
    // before the chat is told the run ended.
    let awake = shared.keep_awake.hold();
    let mut cost = 0.0f64;
    let stop_token = cancel.clone();
    let result = {
        let mut sink = |mut ev: Value| {
            if let Value::Object(map) = &mut ev {
                map.insert("run".to_string(), json!(id));
                if map.get("ev").and_then(Value::as_str) == Some("turn") {
                    cost += map.get("cost_usd").and_then(Value::as_f64).unwrap_or(0.0);
                    if let Some(a) = lock(&shared.state).active.as_mut() {
                        a.cost_usd = cost;
                        a.steps = map.get("step").and_then(Value::as_u64).unwrap_or(0) as u32;
                    }
                }
            }
            emit(ev);
        };
        let task = shared.task.clone();
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| task(id, sentence, cancel, &mut sink)))
    };
    drop(awake);
    let (status, reason, steps) = match result {
        Ok(Ok(o)) => end_of(&o),
        // A task that gave up with an error because the user pressed Stop (for instance while the host was still asking the
        // sidecar for the model id, before the loop started) is a stop, not a failure.
        Ok(Err(_)) if stop_token.info().is_some_and(|(why, _)| why == "user") => ("stopped", Some("user".to_string()), 0),
        Ok(Err(e)) => ("error", Some(clip(&e, REASON_CHARS)), 0),
        Err(_) => ("error", Some("task_panicked".to_string()), 0),
    };
    let ended_ms = unix_ms();
    let row = row_json(id, sentence, status, reason.as_deref(), steps, cost, started_ms, Some(ended_ms));
    if let Err(e) = append_row(&shared.data_dir, &row) {
        eprintln!("agent: could not record {id} in the run list: {e}");
    }
    (shared.emit)(json!({ "ev": "run_end", "t_unix_ms": ended_ms, "run": id, "status": status, "reason": reason, "steps": steps, "cost_usd": cost }));
    let mut st = lock(&shared.state);
    st.active = None;
    st.pending = None;
}

/// (status, reason, steps) for an outcome. A stop the user or a cap caused is "stopped"; a failure of the transport or the
/// ledger is "error" (it needs attention, not a retry of the sentence).
fn end_of(o: &Outcome) -> (&'static str, Option<String>, u32) {
    match &o.stop {
        StopReason::Done => ("done", None, o.steps),
        StopReason::Transport(..) | StopReason::LedgerFailed(_) | StopReason::LedgerUnreadable(_) => ("error", Some(o.stop.code().to_string()), o.steps),
        // R6: the chat shows the reason line, so the numbers travel with the code (`budget_month: monthly budget 5.00 USD ...`).
        StopReason::BudgetMonth(why) => ("stopped", Some(clip(&format!("budget_month: {why}"), REASON_CHARS)), o.steps),
        StopReason::BudgetUnreadable(why) => ("error", Some(clip(&format!("budget_unreadable: {why}"), REASON_CHARS)), o.steps),
        other => ("stopped", Some(other.code().to_string()), o.steps),
    }
}

#[allow(clippy::too_many_arguments)]
fn row_json(id: &str, sentence: &str, status: &str, reason: Option<&str>, steps: u32, cost_usd: f64, started_ms: u64, ended_ms: Option<u64>) -> Value {
    // The row is what `runs.jsonl` keeps and what the run list shows: a secret typed into the chat never reaches either.
    json!({ "id": id, "sentence": clip(&redact_secrets(sentence), ROW_SENTENCE_CHARS), "status": status, "reason": reason, "steps": steps, "cost_usd": cost_usd, "started_ms": started_ms, "ended_ms": ended_ms })
}

// Secrets in a typed sentence or a window's text: upstream's redaction, ported wholesale (R4g). Kept here as `runs::redact_secrets`.
pub use crate::redact::{holds_credential, redact_secrets};

fn runs_file(data_dir: &Path) -> PathBuf {
    data_dir.join("agent").join("runs.jsonl")
}

fn append_row(data_dir: &Path, row: &Value) -> std::io::Result<()> {
    let path = runs_file(data_dir);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&path)?;
    writeln!(f, "{row}")?;
    f.flush()
}

/// The last `TAIL_BYTES` of a file as lines (the first line is dropped when the read started mid-file). A missing file is empty.
fn tail_lines(path: &Path) -> Vec<String> {
    let Ok(mut f) = std::fs::File::open(path) else { return Vec::new() };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let start = len.saturating_sub(TAIL_BYTES);
    if f.seek(SeekFrom::Start(start)).is_err() {
        return Vec::new();
    }
    let mut bytes = Vec::new();
    if f.read_to_end(&mut bytes).is_err() {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&bytes).into_owned();
    let mut lines: Vec<String> = text.lines().map(str::to_string).collect();
    if start > 0 && !lines.is_empty() {
        lines.remove(0);
    }
    lines
}

/// Newest first; (rows, number of unreadable lines skipped).
fn read_rows(data_dir: &Path) -> (Vec<Value>, usize) {
    let mut rows = Vec::new();
    let mut skipped = 0;
    for line in tail_lines(&runs_file(data_dir)) {
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<Value>(&line) {
            Ok(v) if v["id"].as_str().is_some_and(id_ok) && v["status"].is_string() => rows.push(v),
            _ => skipped += 1,
        }
    }
    rows.reverse();
    (rows, skipped)
}

/// The gate's audit lines inside `[from, to]` (to None: still running), oldest first, the last `ACTIVITY_MAX`.
fn read_activity(data_dir: &Path, from: u64, to: Option<u64>) -> Vec<Value> {
    let dir = data_dir.join("audit").join("agent");
    let mut files: Vec<PathBuf> = std::fs::read_dir(&dir).map(|d| d.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.extension().and_then(|x| x.to_str()) == Some("jsonl")).collect()).unwrap_or_default();
    files.sort();
    let mut out: Vec<Value> = Vec::new();
    for path in files.iter().rev().take(2).rev() {
        for line in tail_lines(path) {
            let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
            let Some(t) = v["t_unix_ms"].as_u64() else { continue };
            if t < from || to.is_some_and(|end| t > end) {
                continue;
            }
            let verb = v["verb"].as_str().unwrap_or_default();
            let (kind, name) = match verb.split_once(':') {
                Some(("tool", n)) => ("tool", n),
                Some(("tool_result", n)) => ("result", n),
                _ => ("act", verb),
            };
            let step = v["detail"].as_str().and_then(|d| serde_json::from_str::<Value>(d).ok()).and_then(|d| d["step"].as_u64());
            out.push(json!({ "t": t, "kind": kind, "name": name, "decision": v["decision"], "code": v["code"], "step": step }));
        }
    }
    out.sort_by_key(|e| e["t"].as_u64().unwrap_or(0));
    let skip = out.len().saturating_sub(ACTIVITY_MAX);
    out.split_off(skip)
}

/// The newest `.png` under `<data>/agent/control/<id>/frames` that fits the pipe, as a data URL. Nothing else is read.
fn read_frame(data_dir: &Path, id: &str) -> Value {
    if !id_ok(id) {
        return Value::Null;
    }
    let dir = data_dir.join("agent").join("control").join(id).join("frames");
    let Ok(entries) = std::fs::read_dir(&dir) else { return Value::Null };
    let mut best: Option<(std::time::SystemTime, String, PathBuf)> = None;
    for e in entries.filter_map(|e| e.ok()) {
        let (path, name) = (e.path(), e.file_name().to_string_lossy().into_owned());
        let Ok(meta) = e.metadata() else { continue };
        if !meta.is_file() || meta.len() > FRAME_MAX_BYTES || !name.to_ascii_lowercase().ends_with(".png") {
            continue;
        }
        let key = (meta.modified().unwrap_or(std::time::UNIX_EPOCH), name.clone(), path);
        if best.as_ref().is_none_or(|b| (&key.0, &key.1) > (&b.0, &b.1)) {
            best = Some(key);
        }
    }
    let Some((_, name, path)) = best else { return Value::Null };
    match std::fs::read(&path) {
        Ok(bytes) => json!({ "name": name, "dataUrl": format!("data:image/png;base64,{}", base64(&bytes)) }),
        Err(_) => Value::Null,
    }
}

fn base64(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let n = (u32::from(c[0]) << 16) | (u32::from(*c.get(1).unwrap_or(&0)) << 8) | u32::from(*c.get(2).unwrap_or(&0));
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn r6_a_run_stopped_by_the_month_cap_is_stopped_with_its_reason_in_words_and_an_unreadable_budget_is_an_error() {
        let why = "monthly budget 5.00 USD (2026-11): 4.99 USD already spent".to_string();
        let o = |stop| Outcome { stop, steps: 0, final_text: String::new(), messages: vec![] };
        assert_eq!(end_of(&o(StopReason::BudgetMonth(why.clone()))), ("stopped", Some(format!("budget_month: {why}")), 0));
        assert_eq!(end_of(&o(StopReason::BudgetUnreadable("budget.json: x".into()))), ("error", Some("budget_unreadable: budget.json: x".to_string()), 0));
        // the reason is clipped for the run list, the code stays first
        let long = "x".repeat(500);
        let (_, reason, _) = end_of(&o(StopReason::BudgetMonth(long)));
        assert!(reason.unwrap().starts_with("budget_month: "));
    }

    use super::*;

    #[test]
    fn base64_matches_the_rfc_4648_vectors() {
        for (i, o) in [("", ""), ("f", "Zg=="), ("fo", "Zm8="), ("foo", "Zm9v"), ("foob", "Zm9vYg=="), ("fooba", "Zm9vYmE="), ("foobar", "Zm9vYmFy")] {
            assert_eq!(base64(i.as_bytes()), o);
        }
    }

    #[test]
    fn an_id_that_is_not_ours_is_never_a_path() {
        assert!(id_ok("chat-1795059288006"));
        for bad in ["", "..", "a/b", "a\\b", "chat-1 ", &"a".repeat(41)] {
            assert!(!id_ok(bad), "{bad:?}");
        }
    }
}
