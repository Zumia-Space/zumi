//! The agent loop: ask the model, run the tool calls it returns through the door, feed the results back, repeat until
//! the model answers without a tool call or something stops it (a cap, the kill, the user, a transport failure).
//!
//! The loop knows nothing about hands, notes or the audit log. Every tool call goes through one `ToolDoor`
//! (`tool_gate::ToolGate` in production); every model turn is reported to one `Meter` (the usage ledger).
use crate::cancel::Cancel;
use crate::transport::{ModelTransport, TransportError};
use crate::types::{unix_ms, ToolCall, ToolResult, TurnRequest, TurnResponse};
use serde_json::{json, Value};

#[derive(Debug, Clone, PartialEq)]
pub enum StopReason {
    /// The model answered without asking for a tool.
    Done,
    /// The per-task step cap.
    StepCap,
    /// The per-task cost cap.
    CostCap,
    /// The cost of a turn is unknown (an unpriced model): the cap cannot be enforced, so the task stops.
    CostUnknown,
    /// The kill hotkey (or a hands call refused `killed`).
    Killed,
    /// The user's stop, or any other cancel reason.
    Cancelled(String),
    /// The transport failed: code word and detail.
    Transport(String, String),
    /// The usage ledger could not record a turn: spend that cannot be recorded cannot be capped, so the task stops.
    LedgerFailed(String),
    /// The usage ledger could not be read before the task: what earlier tasks spent is unknown, so the total cap cannot
    /// be enforced and no model call is made.
    LedgerUnreadable(String),
    /// R6: the calendar month's budget has no room for the next call. The text says which cap, which month and what was spent.
    BudgetMonth(String),
    /// R6: the budget file or the month's ledger could not be read, so the cap cannot be enforced and nothing is spent.
    BudgetUnreadable(String),
}

impl StopReason {
    pub fn code(&self) -> &str {
        match self {
            StopReason::Done => "done",
            StopReason::StepCap => "step_cap",
            StopReason::CostCap => "cost_cap",
            StopReason::CostUnknown => "cost_unknown",
            StopReason::Killed => "killed",
            StopReason::Cancelled(_) => "cancelled",
            StopReason::Transport(..) => "transport",
            StopReason::LedgerFailed(_) => "ledger_failed",
            StopReason::LedgerUnreadable(_) => "ledger_unreadable",
            StopReason::BudgetMonth(_) => "budget_month",
            StopReason::BudgetUnreadable(_) => "budget_unreadable",
        }
    }
}

/// The one door every tool call passes. `ToolGate` implements it.
pub trait ToolDoor {
    /// The definitions of the tools the model may call now (a tool that is off is absent, not merely refused).
    fn tool_defs(&self) -> Vec<Value>;
    /// Called before each model turn: the step cap.
    fn begin_step(&mut self, step: u32) -> Result<(), StopReason>;
    /// Called before each model call with the worst-case cost of that call (None = the model or its price is unknown):
    /// refuse a call that could pass a cap, or that cannot be priced, BEFORE it is paid for.
    fn precheck(&mut self, _worst_case_usd: Option<f64>) -> Result<(), StopReason> {
        Ok(())
    }
    /// Called after each model turn with its cost (None = unknown): the cost cap.
    fn charge(&mut self, usd: Option<f64>) -> Result<(), StopReason>;
    /// Gate, execute and audit one call.
    fn call(&mut self, call: &ToolCall, cancel: &Cancel) -> ToolResult;
    /// Called after each model turn with what the model said (its text, possibly empty): the audit records it, so what the
    /// model wrote can be read next to the calls it made. Not an action: a failure to record it stops nothing.
    fn model_text(&mut self, _step: u32, _text: &str) {}
}

/// Transport failure codes that mean no provider call was made (the sidecar refused first, or the mock has no turn left):
/// nothing was spent, so nothing is recorded. Any other failure may have been paid for and is recorded at its worst case.
pub const NO_CALL_CODES: &[&str] = &["bad_request", "no_key", "bad_model", "fixture_exhausted"];

/// Receives each model turn: the usage ledger. Returns the turn's cost in USD (None = the model is unpriced).
pub trait Meter {
    /// The most this call could cost: the request's size (one token per byte, an upper bound) at the input price plus
    /// MAX_OUTPUT_TOKENS at the output price. None when the model is unpriced.
    fn worst_case_usd(&self, _model: &str, _request_bytes: usize) -> Option<f64> {
        Some(0.0)
    }
    fn record_turn(&mut self, resp: &TurnResponse, step: u32) -> Option<f64>;
    /// A turn whose call may have reached the provider but returned no usage (failed or cancelled in flight).
    fn record_failed_turn(&mut self, _model: &str, _worst_case_usd: Option<f64>, _step: u32, _code: &str) {}
    /// Why the meter could not write its record, if it could not.
    fn write_error(&self) -> Option<String> {
        None
    }
}

pub struct NullMeter;
impl Meter for NullMeter {
    fn record_turn(&mut self, _resp: &TurnResponse, _step: u32) -> Option<f64> {
        Some(0.0)
    }
}

pub struct LoopConfig {
    pub system: String,
    pub user: String,
    /// Hard bound on model turns, independent of the door's own caps.
    pub max_turns: u32,
}

#[derive(Debug, Clone)]
pub struct Outcome {
    pub stop: StopReason,
    pub steps: u32,
    pub final_text: String,
    pub messages: Vec<Value>,
}

/// What the runner reports, one JSON line each in the bin (all carry the unix ms they happened).
#[derive(Debug, Clone)]
pub enum Event {
    TurnStart { step: u32 },
    Turn { step: u32, model: String, input: u64, output: u64, cost_usd: Option<f64>, ms: u64, calls: usize },
    ToolStart { step: u32, name: String },
    ToolEnd { step: u32, name: String, ok: bool, error: Option<String>, detail: Option<String>, ms: u64 },
    Stopped { reason: String, steps: u32, detail: String },
}

impl Event {
    pub fn to_json(&self) -> Value {
        let t = unix_ms();
        match self {
            Event::TurnStart { step } => json!({ "ev": "turn_start", "t_unix_ms": t, "step": step }),
            Event::Turn { step, model, input, output, cost_usd, ms, calls } => {
                json!({ "ev": "turn", "t_unix_ms": t, "step": step, "model": model, "in": input, "out": output, "cost_usd": cost_usd, "ms": ms, "calls": calls })
            }
            Event::ToolStart { step, name } => json!({ "ev": "tool_start", "t_unix_ms": t, "step": step, "name": name }),
            Event::ToolEnd { step, name, ok, error, detail, ms } => json!({ "ev": "tool_end", "t_unix_ms": t, "step": step, "name": name, "ok": ok, "error": error, "detail": detail, "ms": ms }),
            Event::Stopped { reason, steps, detail } => json!({ "ev": "stopped", "t_unix_ms": t, "reason": reason, "steps": steps, "detail": detail }),
        }
    }
}

pub(crate) fn stop_for_cancel(cancel: &Cancel) -> StopReason {
    match cancel.info() {
        Some((r, _)) if r == "killed" => StopReason::Killed,
        Some((r, _)) => StopReason::Cancelled(r),
        None => StopReason::Cancelled("unknown".into()),
    }
}

pub fn run(
    cfg: &LoopConfig,
    transport: &mut dyn ModelTransport,
    door: &mut dyn ToolDoor,
    meter: &mut dyn Meter,
    cancel: &Cancel,
    sink: &mut dyn FnMut(Event),
) -> Outcome {
    let mut messages = vec![json!({ "role": "system", "content": cfg.system }), json!({ "role": "user", "content": cfg.user })];
    let mut steps = 0u32;
    let mut final_text = String::new();
    let stop = 'run: loop {
        if cancel.is_set() {
            break stop_for_cancel(cancel);
        }
        if steps >= cfg.max_turns {
            break StopReason::StepCap;
        }
        let step = steps + 1;
        if let Err(s) = door.begin_step(step) {
            break s;
        }
        steps = step;
        sink(Event::TurnStart { step });
        let req = TurnRequest { messages: messages.clone(), tools: door.tool_defs() };
        let request_bytes = req.messages.iter().chain(req.tools.iter()).map(|v| v.to_string().len()).sum::<usize>();
        let priced_model = transport.model_id();
        let worst = priced_model.as_deref().and_then(|m| meter.worst_case_usd(m, request_bytes));
        if let Err(s) = door.precheck(worst) {
            break s;
        }
        // S2: a call that may have reached the provider but brought back no usage is recorded at its worst case, so the
        // running total in the ledger never under-counts.
        let model_name = priced_model.clone().unwrap_or_default();
        let resp = match transport.turn(&req, cancel) {
            Ok(r) => r,
            Err(TransportError::Cancelled) => {
                meter.record_failed_turn(&model_name, worst, step, "cancelled");
                if let Some(e) = meter.write_error() {
                    break StopReason::LedgerFailed(format!("{e} (the turn was cancelled: {})", stop_for_cancel(cancel).code()));
                }
                break stop_for_cancel(cancel);
            }
            Err(TransportError::Failed(c, d)) => {
                if !NO_CALL_CODES.contains(&c.as_str()) {
                    meter.record_failed_turn(&model_name, worst, step, &c);
                    if let Some(e) = meter.write_error() {
                        break StopReason::LedgerFailed(format!("{e} (the turn failed: {c}: {d})"));
                    }
                }
                break StopReason::Transport(c, d);
            }
        };
        let cost = meter.record_turn(&resp, step);
        sink(Event::Turn { step, model: resp.model.clone(), input: resp.usage.input, output: resp.usage.output, cost_usd: cost, ms: resp.ms, calls: resp.tool_calls.len() });
        if let Some(e) = meter.write_error() {
            break StopReason::LedgerFailed(e);
        }
        if let Err(s) = door.charge(cost) {
            break s;
        }
        // N2: the precheck priced `priced_model`; a reply from another model was recorded at its own price above, and
        // the task stops: the next precheck would price the wrong model again.
        if priced_model.as_deref() != Some(resp.model.as_str()) {
            break StopReason::Transport("model_mismatch".into(), format!("priced {:?}, answered by {:?}", priced_model, resp.model));
        }
        final_text = resp.text.clone();
        door.model_text(step, &resp.text);
        let mut assistant = json!({ "role": "assistant", "content": resp.text });
        if !resp.tool_calls.is_empty() {
            assistant["tool_calls"] = Value::Array(resp.tool_calls.iter().map(ToolCall::to_message_json).collect());
        }
        messages.push(assistant);
        if resp.tool_calls.is_empty() {
            break StopReason::Done;
        }
        for call in &resp.tool_calls {
            if cancel.is_set() {
                break 'run stop_for_cancel(cancel);
            }
            sink(Event::ToolStart { step, name: call.name.clone() });
            let t0 = std::time::Instant::now();
            let result = door.call(call, cancel);
            let detail = result.value.get("detail").and_then(Value::as_str).map(str::to_string);
            sink(Event::ToolEnd { step, name: call.name.clone(), ok: result.ok, error: result.error.clone(), detail, ms: t0.elapsed().as_millis() as u64 });
            messages.push(json!({ "role": "tool", "tool_call_id": call.id, "name": call.name, "content": result.to_message_content() }));
            if result.error.as_deref() == Some("killed") {
                cancel.set("killed");
                break 'run StopReason::Killed;
            }
        }
    };
    let detail = match &stop {
        StopReason::Cancelled(r) => r.clone(),
        StopReason::Transport(c, d) => format!("{c}: {d}"),
        StopReason::LedgerFailed(e) | StopReason::LedgerUnreadable(e) | StopReason::BudgetMonth(e) | StopReason::BudgetUnreadable(e) => e.clone(),
        _ => String::new(),
    };
    sink(Event::Stopped { reason: stop.code().to_string(), steps, detail });
    Outcome { stop, steps, final_text, messages }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::MockTransport;
    use std::collections::HashMap;

    /// A door with a step cap and a cost cap and no gate: it runs what it is given.
    struct FakeDoor {
        max_steps: u32,
        max_usd: f64,
        spent: f64,
        calls: Vec<String>,
        kill_on: Option<String>,
        texts: Vec<(u32, String)>,
    }
    impl FakeDoor {
        fn new() -> FakeDoor {
            FakeDoor { max_steps: 40, max_usd: 0.5, spent: 0.0, calls: vec![], kill_on: None, texts: vec![] }
        }
    }
    impl ToolDoor for FakeDoor {
        fn tool_defs(&self) -> Vec<Value> {
            vec![json!({ "name": "note.save" })]
        }
        fn begin_step(&mut self, step: u32) -> Result<(), StopReason> {
            if step > self.max_steps { Err(StopReason::StepCap) } else { Ok(()) }
        }
        fn precheck(&mut self, worst: Option<f64>) -> Result<(), StopReason> {
            let w = worst.ok_or(StopReason::CostUnknown)?;
            if self.spent + w > self.max_usd { Err(StopReason::CostCap) } else { Ok(()) }
        }
        fn charge(&mut self, usd: Option<f64>) -> Result<(), StopReason> {
            let u = usd.ok_or(StopReason::CostUnknown)?;
            self.spent += u;
            if self.spent > self.max_usd { Err(StopReason::CostCap) } else { Ok(()) }
        }
        fn model_text(&mut self, step: u32, text: &str) {
            self.texts.push((step, text.to_string()));
        }
        fn call(&mut self, call: &ToolCall, _c: &Cancel) -> ToolResult {
            self.calls.push(call.name.clone());
            if self.kill_on.as_deref() == Some(call.name.as_str()) {
                return ToolResult::err("killed", "hotkey");
            }
            ToolResult::ok(json!({ "saved": true }))
        }
    }

    struct FixedMeter(Option<f64>);
    impl Meter for FixedMeter {
        fn worst_case_usd(&self, _m: &str, _b: usize) -> Option<f64> {
            self.0
        }
        fn record_turn(&mut self, _r: &TurnResponse, _s: u32) -> Option<f64> {
            self.0
        }
    }

    fn cfg() -> LoopConfig {
        LoopConfig { system: "sys".into(), user: "save a note that milk".into(), max_turns: 100 }
    }
    fn mock(turns: Value) -> MockTransport {
        MockTransport::from_json(&json!({ "model": "mock/loop-v1", "turns": turns }), HashMap::new()).unwrap()
    }
    fn run_with(t: &mut MockTransport, d: &mut FakeDoor, m: &mut dyn Meter, c: &Cancel) -> (Outcome, Vec<Event>) {
        let mut ev = Vec::new();
        let o = run(&cfg(), t, d, m, c, &mut |e| ev.push(e));
        (o, ev)
    }

    #[test]
    fn tool_call_then_answer_ends_done_and_feeds_the_result_back() {
        let mut t = mock(json!([
            { "tool_calls": [{ "name": "note.save", "args": { "text": "milk" } }], "usage": { "in": 10, "out": 2 } },
            { "text": "Saved.", "usage": { "in": 20, "out": 3 } }
        ]));
        let (mut d, c) = (FakeDoor::new(), Cancel::new());
        let (o, ev) = run_with(&mut t, &mut d, &mut NullMeter, &c);
        assert_eq!(o.stop, StopReason::Done);
        assert_eq!(o.steps, 2);
        assert_eq!(o.final_text, "Saved.");
        assert_eq!(d.calls, vec!["note.save"]);
        let tool_msg = o.messages.iter().find(|m| m["role"] == "tool").unwrap();
        assert_eq!(tool_msg["name"], "note.save");
        assert!(tool_msg["content"].as_str().unwrap().contains("saved"));
        assert!(matches!(ev.last(), Some(Event::Stopped { reason, .. }) if reason == "done"));
    }

    #[test]
    fn every_model_turn_hands_its_text_to_the_door_for_the_audit() {
        // The 19-11 spare run: the audit had the calls but never what the model said.
        let mut t = mock(json!([
            { "text": "I will save the note.", "tool_calls": [{ "name": "note.save", "args": { "text": "milk" } }], "usage": { "in": 10, "out": 2 } },
            { "tool_calls": [{ "name": "note.save", "args": { "text": "eggs" } }], "usage": { "in": 12, "out": 2 } },
            { "text": "Saved both.", "usage": { "in": 20, "out": 3 } }
        ]));
        let (mut d, c) = (FakeDoor::new(), Cancel::new());
        let (o, _) = run_with(&mut t, &mut d, &mut NullMeter, &c);
        assert_eq!(o.stop, StopReason::Done);
        assert_eq!(d.texts, vec![(1, "I will save the note.".to_string()), (2, String::new()), (3, "Saved both.".to_string())], "one call per turn, empty text included");
    }

    #[test]
    fn bite_step_cap_stops_a_model_that_never_stops_asking() {
        let turns: Vec<Value> = (0..60).map(|_| json!({ "tool_calls": [{ "name": "note.save", "args": {} }], "usage": { "in": 1, "out": 1 } })).collect();
        let mut t = mock(Value::Array(turns));
        let (mut d, c) = (FakeDoor::new(), Cancel::new());
        let (o, _) = run_with(&mut t, &mut d, &mut NullMeter, &c);
        assert_eq!(o.stop, StopReason::StepCap);
        assert_eq!(o.steps, 40, "exactly the cap, no 41st model call");
        assert_eq!(t.requests_seen, 40);
    }

    #[test]
    fn pass_twin_a_task_inside_the_step_cap_is_not_stopped() {
        let mut turns: Vec<Value> = (0..39).map(|_| json!({ "tool_calls": [{ "name": "note.save", "args": {} }], "usage": { "in": 1, "out": 1 } })).collect();
        turns.push(json!({ "text": "ok", "usage": { "in": 1, "out": 1 } }));
        let mut t = mock(Value::Array(turns));
        let (mut d, c) = (FakeDoor::new(), Cancel::new());
        let (o, _) = run_with(&mut t, &mut d, &mut NullMeter, &c);
        assert_eq!(o.stop, StopReason::Done);
        assert_eq!(o.steps, 40);
    }

    #[test]
    fn bite_cost_cap_and_unknown_cost_stop_the_task() {
        let turns = json!([{ "tool_calls": [{ "name": "note.save", "args": {} }], "usage": { "in": 1, "out": 1 } }, { "text": "x", "usage": { "in": 1, "out": 1 } }]);
        let (mut d, c) = (FakeDoor::new(), Cancel::new());
        let (o, _) = run_with(&mut mock(turns.clone()), &mut d, &mut FixedMeter(Some(0.30)), &c);
        assert_eq!(o.stop, StopReason::CostCap, "0.30 + 0.30 > 0.50 after the second turn");
        assert_eq!(o.steps, 2);
        let (mut d2, c2) = (FakeDoor::new(), Cancel::new());
        let (o2, _) = run_with(&mut mock(turns.clone()), &mut d2, &mut FixedMeter(None), &c2);
        assert_eq!(o2.stop, StopReason::CostUnknown);
        assert_eq!(o2.steps, 1);
        assert!(d2.calls.is_empty(), "no tool runs once the cost of the turn is unknown");
        let (mut d3, c3) = (FakeDoor::new(), Cancel::new());
        let (o3, _) = run_with(&mut mock(turns), &mut d3, &mut FixedMeter(Some(0.10)), &c3);
        assert_eq!(o3.stop, StopReason::Done, "pass twin: 0.10 + 0.10 stays under the cap");
    }

    #[test]
    fn m2_an_unpriced_model_makes_no_call_and_a_call_that_could_pass_the_cap_is_not_made() {
        let turns = json!([{ "tool_calls": [{ "name": "note.save", "args": {} }], "usage": { "in": 1, "out": 1 } }, { "text": "x", "usage": { "in": 1, "out": 1 } }]);
        let (mut t, mut d, c) = (mock(turns.clone()), FakeDoor::new(), Cancel::new());
        let (o, _) = run_with(&mut t, &mut d, &mut FixedMeter(None), &c);
        assert_eq!((o.stop, t.requests_seen), (StopReason::CostUnknown, 0), "not even one paid turn");
        let (mut t2, mut d2) = (mock(turns.clone()), FakeDoor::new());
        let (o2, _) = run_with(&mut t2, &mut d2, &mut FixedMeter(Some(0.6)), &c);
        assert_eq!((o2.stop, t2.requests_seen), (StopReason::CostCap, 0), "a worst case over the cap is refused first");
        let (mut t3, mut d3) = (mock(turns), FakeDoor::new());
        let (o3, _) = run_with(&mut t3, &mut d3, &mut FixedMeter(Some(0.1)), &c);
        assert_eq!(o3.stop, StopReason::Done, "pass twin");
    }

    #[test]
    fn bite_cancel_before_the_task_runs_nothing() {
        let mut t = mock(json!([{ "text": "x", "usage": { "in": 1, "out": 1 } }]));
        let (mut d, c) = (FakeDoor::new(), Cancel::new());
        c.set("user");
        let (o, _) = run_with(&mut t, &mut d, &mut NullMeter, &c);
        assert_eq!(o.stop, StopReason::Cancelled("user".into()));
        assert_eq!(t.requests_seen, 0);
    }

    #[test]
    fn bite_cancel_during_a_turn_stops_without_running_its_tools() {
        let mut t = mock(json!([{ "delay_ms": 3000, "tool_calls": [{ "name": "note.save", "args": {} }], "usage": { "in": 1, "out": 1 } }]));
        let (mut d, c) = (FakeDoor::new(), Cancel::new());
        let c2 = c.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(30));
            c2.set("killed");
        });
        let t0 = std::time::Instant::now();
        let (o, _) = run_with(&mut t, &mut d, &mut NullMeter, &c);
        assert_eq!(o.stop, StopReason::Killed);
        assert!(t0.elapsed() < std::time::Duration::from_millis(500));
        assert!(d.calls.is_empty());
    }

    #[test]
    fn a_tool_that_reports_killed_stops_the_loop_and_sets_the_token() {
        let mut t = mock(json!([
            { "tool_calls": [{ "name": "note.save", "args": {} }, { "name": "note.save", "args": {} }], "usage": { "in": 1, "out": 1 } },
            { "text": "never", "usage": { "in": 1, "out": 1 } }
        ]));
        let (mut d, c) = (FakeDoor::new(), Cancel::new());
        d.kill_on = Some("note.save".into());
        let (o, _) = run_with(&mut t, &mut d, &mut NullMeter, &c);
        assert_eq!(o.stop, StopReason::Killed);
        assert_eq!(d.calls.len(), 1, "the second call of the batch is not run");
        assert_eq!(t.requests_seen, 1);
        assert_eq!(c.info().unwrap().0, "killed");
    }

    /// A transport whose reply names another model than the one the precheck priced (a sidecar that swapped models).
    struct Swapped(MockTransport, &'static str);
    impl ModelTransport for Swapped {
        fn model_id(&self) -> Option<String> {
            Some(self.1.to_string())
        }
        fn turn(&mut self, req: &TurnRequest, cancel: &Cancel) -> Result<TurnResponse, TransportError> {
            self.0.turn(req, cancel)
        }
    }
    struct ModelsSeen(Vec<String>);
    impl Meter for ModelsSeen {
        fn worst_case_usd(&self, _m: &str, _b: usize) -> Option<f64> {
            Some(0.01)
        }
        fn record_turn(&mut self, r: &TurnResponse, _s: u32) -> Option<f64> {
            self.0.push(r.model.clone());
            Some(0.01)
        }
    }

    #[test]
    fn n2_a_reply_from_another_model_than_the_one_priced_is_recorded_at_its_own_price_and_stops_the_task() {
        let turns = json!([{ "tool_calls": [{ "name": "note.save", "args": {} }], "usage": { "in": 1, "out": 1 } }, { "text": "x", "usage": { "in": 1, "out": 1 } }]);
        let mut t = Swapped(mock(turns.clone()), "priced/model");
        let (mut d, mut m, c) = (FakeDoor::new(), ModelsSeen(vec![]), Cancel::new());
        let o = run(&cfg(), &mut t, &mut d, &mut m, &c, &mut |_| {});
        assert!(matches!(o.stop, StopReason::Transport(ref code, _) if code == "model_mismatch"), "{:?}", o.stop);
        assert_eq!(m.0, vec!["mock/loop-v1"], "the paid turn is in the ledger under the model that answered");
        assert!(d.calls.is_empty(), "no tool of that turn runs");
        let mut t2 = Swapped(mock(turns), "mock/loop-v1");
        let (mut d2, mut m2) = (FakeDoor::new(), ModelsSeen(vec![]));
        assert_eq!(run(&cfg(), &mut t2, &mut d2, &mut m2, &c, &mut |_| {}).stop, StopReason::Done, "pass twin: same model");
    }

    struct BrokenLedger;
    impl Meter for BrokenLedger {
        fn worst_case_usd(&self, _m: &str, _b: usize) -> Option<f64> {
            Some(0.01)
        }
        fn record_turn(&mut self, _r: &TurnResponse, _s: u32) -> Option<f64> {
            Some(0.01)
        }
        fn write_error(&self) -> Option<String> {
            Some("disk full".into())
        }
    }

    #[test]
    fn s2_a_ledger_that_cannot_write_stops_the_task_before_any_tool_of_the_turn_runs() {
        let turns = json!([{ "tool_calls": [{ "name": "note.save", "args": {} }], "usage": { "in": 1, "out": 1 } }, { "text": "x", "usage": { "in": 1, "out": 1 } }]);
        let (mut t, mut d, c) = (mock(turns), FakeDoor::new(), Cancel::new());
        let (o, _) = run_with(&mut t, &mut d, &mut BrokenLedger, &c);
        assert_eq!(o.stop.code(), "ledger_failed", "{:?}", o.stop);
        assert!(d.calls.is_empty(), "no tool runs once spend cannot be recorded");
        assert_eq!(t.requests_seen, 1);
    }

    /// A transport whose call fails with a given code.
    struct FailT(&'static str);
    impl ModelTransport for FailT {
        fn model_id(&self) -> Option<String> {
            Some("m".into())
        }
        fn turn(&mut self, _r: &TurnRequest, _c: &Cancel) -> Result<TurnResponse, TransportError> {
            Err(TransportError::Failed(self.0.into(), String::new()))
        }
    }
    #[derive(Default)]
    struct Failed(Vec<(String, Option<f64>, u32)>);
    impl Meter for Failed {
        fn worst_case_usd(&self, _m: &str, _b: usize) -> Option<f64> {
            Some(0.02)
        }
        fn record_turn(&mut self, _r: &TurnResponse, _s: u32) -> Option<f64> {
            Some(0.01)
        }
        fn record_failed_turn(&mut self, _m: &str, w: Option<f64>, step: u32, code: &str) {
            self.0.push((code.to_string(), w, step));
        }
    }

    #[test]
    fn s2_failed_and_cancelled_turns_are_recorded_at_their_worst_case_and_refusals_before_any_call_are_not() {
        for code in ["upstream", "timeout", "sidecar", "auth"] {
            let (mut m, mut d, c) = (Failed::default(), FakeDoor::new(), Cancel::new());
            let o = run(&cfg(), &mut FailT(code), &mut d, &mut m, &c, &mut |_| {});
            assert_eq!(o.stop.code(), "transport");
            assert_eq!(m.0, vec![(code.to_string(), Some(0.02), 1)], "{code}: the call may have been paid");
        }
        for code in ["no_key", "bad_model", "bad_request", "fixture_exhausted"] {
            let (mut m, mut d, c) = (Failed::default(), FakeDoor::new(), Cancel::new());
            run(&cfg(), &mut FailT(code), &mut d, &mut m, &c, &mut |_| {});
            assert!(m.0.is_empty(), "{code}: refused before any provider call, nothing was spent");
        }
        let mut t = mock(json!([{ "delay_ms": 3000, "text": "slow", "usage": { "in": 1, "out": 1 } }]));
        let (mut m, mut d, c) = (Failed::default(), FakeDoor::new(), Cancel::new());
        let c2 = c.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(30));
            c2.set("user");
        });
        let (o, _) = run_with(&mut t, &mut d, &mut m, &c);
        assert_eq!(o.stop, StopReason::Cancelled("user".into()));
        assert_eq!(m.0, vec![("cancelled".to_string(), Some(0.02), 1)], "a turn cancelled in flight is counted at its worst case");
    }

    /// Records failed turns, but every write fails (a full disk): `write_error` is set only once a line was attempted.
    #[derive(Default)]
    struct FailedUnwritable(u32);
    impl Meter for FailedUnwritable {
        fn worst_case_usd(&self, _m: &str, _b: usize) -> Option<f64> {
            Some(0.02)
        }
        fn record_turn(&mut self, _r: &TurnResponse, _s: u32) -> Option<f64> {
            self.0 += 1;
            Some(0.01)
        }
        fn record_failed_turn(&mut self, _m: &str, _w: Option<f64>, _step: u32, _code: &str) {
            self.0 += 1;
        }
        fn write_error(&self) -> Option<String> {
            (self.0 > 0).then(|| "disk full".to_string())
        }
    }

    #[test]
    fn p3d_a_failed_or_cancelled_turn_that_cannot_be_recorded_stops_ledger_failed() {
        for code in ["upstream", "timeout"] {
            let (mut m, mut d, c) = (FailedUnwritable::default(), FakeDoor::new(), Cancel::new());
            let o = run(&cfg(), &mut FailT(code), &mut d, &mut m, &c, &mut |_| {});
            assert_eq!(o.stop.code(), "ledger_failed", "{code}: {:?}", o.stop);
        }
        let mut t = mock(json!([{ "delay_ms": 3000, "text": "slow", "usage": { "in": 1, "out": 1 } }]));
        let (mut m, mut d, c) = (FailedUnwritable::default(), FakeDoor::new(), Cancel::new());
        let c2 = c.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(30));
            c2.set("user");
        });
        let (o, _) = run_with(&mut t, &mut d, &mut m, &c);
        assert_eq!(o.stop.code(), "ledger_failed", "cancelled in flight: {:?}", o.stop);
        // Pass twin: a refusal before any call writes nothing, so no write error and the transport code stays.
        let (mut m, mut d, c) = (FailedUnwritable::default(), FakeDoor::new(), Cancel::new());
        assert_eq!(run(&cfg(), &mut FailT("no_key"), &mut d, &mut m, &c, &mut |_| {}).stop.code(), "transport");
    }

    #[test]
    fn transport_failure_is_a_stop_with_its_code() {
        let mut t = mock(json!([]));
        let (mut d, c) = (FakeDoor::new(), Cancel::new());
        let (o, _) = run_with(&mut t, &mut d, &mut NullMeter, &c);
        assert!(matches!(o.stop, StopReason::Transport(ref code, _) if code == "fixture_exhausted"));
    }
}
