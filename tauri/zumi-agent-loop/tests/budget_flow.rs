//! R6 monthly budget through the real runner: the cap stops a turn BEFORE the model is called and says why; inside the cap the same
//! task runs; a budget that cannot be read stops the task. The model is a fixture; no network, no window.
use serde_json::{json, Value};
use std::path::PathBuf;
use zumi_agent_loop::budget::MonthCap;
use zumi_agent_loop::cancel::Cancel;
use zumi_agent_loop::loop_run::{Meter, Outcome, StopReason};
use zumi_agent_loop::runner::{run_task_with, ModelSource, TaskExtras, TaskOpts};
use zumi_agent_loop::types::TurnResponse;

/// Prices every call at 0.01 USD, worst case 0.02.
#[derive(Default)]
struct Cent(u32);
impl Meter for Cent {
    fn worst_case_usd(&self, _m: &str, _b: usize) -> Option<f64> {
        Some(0.02)
    }
    fn record_turn(&mut self, _r: &TurnResponse, _s: u32) -> Option<f64> {
        self.0 += 1;
        Some(0.01)
    }
}

fn root(name: &str) -> PathBuf {
    let r = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("budget-flow-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&r);
    std::fs::create_dir_all(r.join("audit")).unwrap();
    r
}

fn run(name: &str, month_budget: Option<Result<MonthCap, String>>) -> (Outcome, Vec<Value>, u32) {
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
    let mut meter = Cent::default();
    let mut events = Vec::new();
    let out = run_task_with(opts, TaskExtras { month_budget, ..Default::default() }, &mut meter, &mut |e| events.push(e)).expect("the task ran");
    (out, events, meter.0)
}

fn cap(cap_usd: f64, spent_usd: f64) -> MonthCap {
    MonthCap { cap_usd, month: "2026-11".into(), spent_usd, unpriced_calls: 0, torn_lines: 0 }
}

#[test]
fn a_month_that_has_spent_its_cap_stops_the_task_before_the_model_and_says_why() {
    let (out, events, turns) = run("over", Some(Ok(cap(5.0, 5.0))));
    assert_eq!(turns, 0, "no model call, so no spend");
    assert!(matches!(out.stop, StopReason::BudgetMonth(_)), "{:?}", out.stop);
    let stopped = events.iter().find(|e| e["ev"] == "stopped").expect("a stopped event");
    assert_eq!(stopped["reason"], "budget_month");
    let why = stopped["detail"].as_str().unwrap();
    for part in ["monthly budget", "5.00", "2026-11", "already spent"] {
        assert!(why.contains(part), "{part} in {why}");
    }
}

/// Upstream usage-caps.md: "Nothing is cut off mid-turn ... a cap is checked only before new work starts, so the last turn can take the total
/// past the limit." 4.995 of 5.00 is inside the cap, so the task starts; its 0.01 call takes the month past 5.00 and the task still finishes.
#[test]
fn a_task_that_starts_inside_the_cap_is_not_cut_off_when_its_call_takes_the_month_past_it() {
    let (out, events, turns) = run("last-turn", Some(Ok(cap(5.0, 4.995))));
    assert_eq!((turns, out.stop), (1, StopReason::Done));
    assert!(events.iter().all(|e| e["reason"] != "budget_month"));
}

#[test]
fn the_same_task_inside_the_cap_runs_to_the_end() {
    let (out, events, turns) = run("inside", Some(Ok(cap(5.0, 1.0))));
    assert_eq!((turns, out.stop), (1, StopReason::Done));
    assert!(events.iter().all(|e| e["reason"] != "budget_month"));
    // and with no budget at all (the default) nothing changes
    let (out, _, turns) = run("none", None);
    assert_eq!((turns, out.stop), (1, StopReason::Done));
}

#[test]
fn a_budget_that_cannot_be_read_stops_the_task_before_any_call() {
    let (out, events, turns) = run("unreadable", Some(Err("budget.json: not a number".into())));
    assert_eq!(turns, 0);
    assert!(matches!(out.stop, StopReason::BudgetUnreadable(_)), "{:?}", out.stop);
    let stopped = events.iter().find(|e| e["ev"] == "stopped").expect("a stopped event");
    assert_eq!(stopped["reason"], "budget_unreadable");
    assert!(stopped["detail"].as_str().unwrap().contains("budget.json"));
}
