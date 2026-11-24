//! R6c C item 2: a finished run hands the person's sentence and Zumi's reply to the sidecar's `__host.memoryAddTurn` at the run's end.
//! The sidecar decides whether Memory is on and keeps the row (local file, nothing uploaded); the loop only offers the pair. A run that
//! did not finish offers nothing, and a sidecar that cannot take it never fails the run (the run says so in an event instead).
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use zumi_agent_loop::budget::MonthCap;
use zumi_agent_loop::cancel::Cancel;
use zumi_agent_loop::loop_run::{NullMeter, Outcome, StopReason};
use zumi_agent_loop::runner::{run_task_with, ModelSource, TaskExtras, TaskOpts};
use zumi_agent_loop::transport::{RpcCall, TransportError};

type Calls = Arc<Mutex<Vec<(String, Value)>>>;

/// Records every call. `answer` is what the sidecar says back; None = the sidecar cannot be reached.
struct Rec(Calls, Option<Value>);
impl RpcCall for Rec {
    fn call(&mut self, method: &str, params: Value, _c: &Cancel) -> Result<Value, TransportError> {
        self.0.lock().unwrap().push((method.to_string(), params));
        self.1.clone().ok_or_else(|| TransportError::Failed("sidecar".into(), "down".into()))
    }
}

fn root(name: &str) -> PathBuf {
    let r = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("turn-log-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&r);
    std::fs::create_dir_all(r.join("audit")).unwrap();
    r
}

fn run(name: &str, turn_log: Option<Rec>, month_budget: Option<Result<MonthCap, String>>) -> (Outcome, Vec<Value>) {
    let r = root(name);
    let fixture = r.join("f.json");
    std::fs::write(&fixture, json!({ "name": "f", "model": "mock/loop-v1", "turns": [{ "text": "Done.", "usage": { "in": 10, "out": 5 } }] }).to_string()).unwrap();
    let opts = TaskOpts {
        task_id: format!("t-{name}"),
        sentence: "say hello".into(),
        model: ModelSource::Mock { fixture, vars: Default::default() },
        hands: None,
        notes: None,
        reminders: None,
        loop_audit: r.join("audit").join("a.jsonl"),
        prior_usd: Ok(0.0),
        max_total_usd: None,
        cancel: Cancel::new(),
    };
    let mut events = Vec::new();
    let extras = TaskExtras { month_budget, turn_log: turn_log.map(|t| Box::new(t) as Box<dyn RpcCall>), ..Default::default() };
    let out = run_task_with(opts, extras, &mut NullMeter, &mut |e| events.push(e)).expect("the task ran");
    (out, events)
}

#[test]
fn a_finished_run_hands_the_sentence_and_the_reply_to_memory_once() {
    let calls: Calls = Arc::default();
    let (out, events) = run("ok", Some(Rec(calls.clone(), Some(json!({ "ok": true, "stored": true, "id": 5 })))), None);
    assert_eq!(out.stop, StopReason::Done);
    assert_eq!(*calls.lock().unwrap(), vec![("__host.memoryAddTurn".to_string(), json!(["t-ok", "say hello", "Done."]))]);
    let ev = events.iter().find(|e| e["ev"] == "memory_turn").expect("the run says what happened to the turn");
    assert_eq!(ev["stored"], true);
}

#[test]
fn memory_off_is_not_an_error_the_sidecar_just_keeps_nothing() {
    let calls: Calls = Arc::default();
    let (out, events) = run("off", Some(Rec(calls.clone(), Some(json!({ "ok": true, "stored": false })))), None);
    assert_eq!(out.stop, StopReason::Done);
    assert_eq!(calls.lock().unwrap().len(), 1);
    let ev = events.iter().find(|e| e["ev"] == "memory_turn").unwrap();
    assert_eq!((ev["stored"].clone(), ev.get("error").cloned()), (json!(false), None));
}

#[test]
fn bite_a_run_that_did_not_finish_offers_nothing() {
    let calls: Calls = Arc::default();
    let cap = MonthCap { cap_usd: 5.0, month: "2026-11".into(), spent_usd: 5.0, unpriced_calls: 0, torn_lines: 0 };
    let (out, events) = run("stopped", Some(Rec(calls.clone(), Some(json!({ "ok": true, "stored": true })))), Some(Ok(cap)));
    assert!(matches!(out.stop, StopReason::BudgetMonth(_)), "{:?}", out.stop);
    assert!(calls.lock().unwrap().is_empty(), "no reply, nothing to keep");
    assert!(events.iter().all(|e| e["ev"] != "memory_turn"));
}

#[test]
fn bite_a_sidecar_that_cannot_take_the_turn_never_fails_the_run() {
    let calls: Calls = Arc::default();
    let (out, events) = run("down", Some(Rec(calls.clone(), None)), None);
    assert_eq!(out.stop, StopReason::Done, "the person still gets the answer");
    let ev = events.iter().find(|e| e["ev"] == "memory_turn").expect("and the failure is said, not swallowed");
    assert_eq!(ev["stored"], false);
    assert!(ev["error"].as_str().is_some_and(|e| e.contains("down")), "{ev}");
}

#[test]
fn without_a_turn_log_nothing_is_called() {
    let (out, events) = run("none", None, None);
    assert_eq!(out.stop, StopReason::Done);
    assert!(events.iter().all(|e| e["ev"] != "memory_turn"));
}
