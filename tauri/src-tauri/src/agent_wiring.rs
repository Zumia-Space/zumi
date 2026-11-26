//! Thin wiring between the host and `zumi-agent-loop` (T-31-MAUS P3, roadmap call A1 as revised 11-11): the agent loop
//! and its tool gate are Rust in their own crate (no `tauri` dependency); provider adapters and key stores stay in the
//! sidecar. The loop reaches the sidecar through two host-only calls this module supplies: `__host.modelTurn` (one model
//! call, no tool executed) and `memory.add` (a note). This module only decides where files go and hands the sidecar
//! client over; every decision is the crate's.
//!
//! The renderer reaches `run_sentence_as` through `agent_host.rs` (R2: the four `agent.*` inventory methods).
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;
use zumi_agent_loop::cancel::Cancel;
use zumi_agent_loop::ledger::{local_date, Ledger, Prices};
use zumi_agent_loop::loop_run::Outcome;
use zumi_agent_loop::runner::{run_task_with, HandsOpts, ModelSource, TaskExtras, TaskOpts};
use zumi_agent_loop::tool_gate::TOTAL_CAP_USD;
use zumi_agent_loop::transport::{RpcCall, TransportError};

use crate::Rpc;

/// The acceptance key of this host process (HB-2): random, made on first use, never written to disk and given only to the
/// helpers this host starts (their environment). A record signed with it can come only from this process, after the
/// native dialog. Acceptances therefore last for this run of the app.
pub fn host_accept_key() -> &'static [u8] {
    static KEY: std::sync::OnceLock<Vec<u8>> = std::sync::OnceLock::new();
    KEY.get_or_init(|| zumi_audit_key())
}

#[cfg(windows)]
fn zumi_audit_key() -> Vec<u8> {
    // No fallback: a key that cannot be made randomly would make an acceptance forgeable, so the process stops.
    zumi_agent_loop::hostmac_new_key().expect("the OS random generator")
}

/// HB-2: the host's own "turn on the Explorer pack" action, called by the `agent_accept_pack` command (main webview only;
/// the page can ask for the dialog but cannot click it) and by nothing else: not an rpc method, a tool or the sidecar.
/// The pack's policy file lives under the data dir; the acceptance is recorded next to it, signed with the host key.
#[cfg(windows)]
pub fn accept_explorer_pack(data_dir: &Path, hands_exe: &Path) -> Result<bool, String> {
    const EXPLORER: &str = r"C:\Windows\explorer.exe";
    let dir = data_dir.join("agent").join("packs").join("explorer");
    std::fs::create_dir_all(&dir).map_err(|e| format!("pack dir: {e}"))?;
    let policy = dir.join("policy.json");
    let text = json!({ "apps": [EXPLORER], "args": { EXPLORER: { "directory": true } } }).to_string();
    std::fs::write(&policy, text).map_err(|e| format!("policy: {e}"))?;
    zumi_agent_loop::dialog::accept_pack_with_helper_native(hands_exe, "explorer", &policy, &dir.join("audit.jsonl"), host_accept_key())
}

/// A model turn can take a while; the note call is local.
const SIDECAR_TIMEOUT: Duration = Duration::from_secs(90);

/// The sidecar client as the loop's `RpcCall`.
pub struct HostSidecar(pub Rpc);

impl RpcCall for HostSidecar {
    fn call(&mut self, method: &str, params: Value, cancel: &Cancel) -> Result<Value, TransportError> {
        if cancel.is_set() {
            return Err(TransportError::Cancelled);
        }
        let args = match params {
            Value::Array(a) => a,
            other => vec![other],
        };
        self.0.call(method, args, SIDECAR_TIMEOUT).map_err(|e| TransportError::Failed("sidecar".to_string(), e))
    }
}

/// Where things live. `hands_exe: None` means the hands pack is not installed: the task gets no hands tools.
pub struct AgentEnv {
    pub data_dir: PathBuf,
    /// `usage-prices.json` (USD per million tokens), the table the Settings usage screen reads.
    pub prices_file: PathBuf,
    pub hands_exe: Option<PathBuf>,
    /// The provider model id the turns use (from the owner's settings). None: no call is made (no known price).
    pub model: Option<String>,
    /// A lower cap on everything agent tasks have spent in the usage ledger. None, or anything above it: the crate's
    /// `TOTAL_CAP_USD` (0.50 USD, CoS P3b N3). There is no way to run a task without a total cap.
    pub total_cap_usd: Option<f64>,
    /// The running A2 runner (the host's own `routines_host` state): `reminder.add` goes to its store. None: not offered.
    pub routines: Option<zumi_routines::Routines>,
    /// R5: puts a yes/no question to the person (the chat's confirm card). None: nobody to ask, so the hands run nothing.
    pub ask: Option<zumi_agent_loop::hands_tools::Asker>,
}

/// R5: what the host adds to a task beyond the built-in tools: the question seam and the saved-steps file. The host never
/// sets `consent_given`: the first-use question is asked in every run (a replay too).
pub fn extras_for(env: &AgentEnv) -> TaskExtras {
    // R6: the monthly budget (`<data dir>/budget.json`), read at the start of every task. No file = no monthly cap.
    TaskExtras {
        ask: env.ask.clone(),
        saved_steps: Some(env.data_dir.join("agent").join("saved-steps.json")),
        month_budget: zumi_agent_loop::budget::month_cap_for(&env.data_dir, &env.prices_file),
        ..Default::default()
    }
}

/// A chat sentence enters the loop: builds the task (audit under `<data>/audit/agent/`, usage ledger in `<data>/usage/`,
/// hands policy and the helper's audit under `<data>/agent/control/<task>/`, files only inside `<data>/agent/workspace`),
/// runs it and returns how it ended. `make_rpc` gives one sidecar client per consumer (model, notes).
pub fn run_sentence_with(env: &AgentEnv, sentence: &str, make_rpc: impl Fn() -> Box<dyn RpcCall + Send> + Send + Sync + 'static, cancel: Cancel, sink: &mut dyn FnMut(Value)) -> Result<Outcome, String> {
    let task_id = format!("chat-{}", zumi_agent_loop::types::unix_ms());
    run_sentence_as(env, &task_id, sentence, make_rpc, cancel, sink)
}

/// `run_sentence_with` under an id the caller chose (the run id of `zumi_agent_loop::runs`, so the usage ledger, the audit
/// and the activity panel all name the same task).
pub fn run_sentence_as(env: &AgentEnv, task_id: &str, sentence: &str, make_rpc: impl Fn() -> Box<dyn RpcCall + Send> + Send + Sync + 'static, cancel: Cancel, sink: &mut dyn FnMut(Value)) -> Result<Outcome, String> {
    let workspace = env.data_dir.join("agent").join("workspace");
    std::fs::create_dir_all(&workspace).map_err(|e| format!("workspace: {e}"))?;
    let hands = env.hands_exe.as_ref().filter(|p| p.is_file()).map(|exe| HandsOpts {
        exe: exe.clone(),
        control_dir: env.data_dir.join("agent").join("control").join(task_id),
        workspace: workspace.clone(),
        deadman_ms: 10 * 60 * 1000,
        accept_key: Some(host_accept_key().to_vec()),
    });
    let make_rpc = std::sync::Arc::new(make_rpc);
    let (for_model, for_notes, for_turns) = (make_rpc.clone(), make_rpc.clone(), make_rpc);
    let opts = TaskOpts {
        task_id: task_id.to_string(),
        sentence: sentence.to_string(),
        model: ModelSource::Rpc { make: for_model, model: env.model.clone() },
        hands,
        notes: Some(for_notes()),
        reminders: env.routines.clone().map(|r| Box::new(zumi_agent_loop::reminders::RoutinesStore(r)) as Box<dyn zumi_agent_loop::reminders::ReminderStore>),
        loop_audit: env.data_dir.join("audit").join("agent").join(format!("{}.jsonl", local_date())),
        prior_usd: zumi_agent_loop::ledger::total_agent_cost_usd(&env.data_dir),
        max_total_usd: Some(env.total_cap_usd.map_or(TOTAL_CAP_USD, |c| c.min(TOTAL_CAP_USD))),
        cancel,
    };
    let mut ledger = Ledger::new(env.data_dir.clone(), Prices::load(&env.prices_file)?, task_id);
    // R6c C: the finished run's sentence and reply go to the sidecar's __host.memoryAddTurn (it keeps them only while Memory is on).
    let mut extras = extras_for(env);
    extras.turn_log = Some(for_turns());
    run_task_with(opts, extras, &mut ledger, sink)
}

/// `run_sentence_with` over the running sidecar.
pub fn run_sentence(rpc: &Rpc, env: &AgentEnv, sentence: &str, cancel: Cancel, sink: &mut dyn FnMut(Value)) -> Result<Outcome, String> {
    let rpc = rpc.clone();
    run_sentence_with(env, sentence, move || Box::new(HostSidecar(rpc.clone())), cancel, sink)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use zumi_agent_loop::loop_run::StopReason;

    /// A fake sidecar: `__host.modelTurn` replays two turns (a note.save call, then an answer), `memory.add` records.
    struct FakeSidecar {
        notes: Arc<Mutex<Vec<String>>>,
        turns: Arc<Mutex<Vec<Value>>>,
        /// `__host.memoryAddTurn` calls (R6c C): [turn id, sentence, reply].
        logged: Arc<Mutex<Vec<Value>>>,
    }
    impl RpcCall for FakeSidecar {
        fn call(&mut self, method: &str, params: Value, _c: &Cancel) -> Result<Value, TransportError> {
            match method {
                "__host.modelTurn" => {
                    let tools = params[0]["tools"].as_array().map(|a| a.len()).unwrap_or(0);
                    assert!(tools >= 1, "the model is offered tools");
                    Ok(self.turns.lock().unwrap().remove(0))
                }
                "memory.add" => {
                    let text = params[0].as_str().unwrap().to_string();
                    self.notes.lock().unwrap().push(text);
                    Ok(json!({ "ok": true, "item": { "id": 11, "kind": "note" } }))
                }
                "__host.memoryAddTurn" => {
                    self.logged.lock().unwrap().push(params);
                    Ok(json!({ "ok": true, "stored": true, "id": 12 }))
                }
                other => Err(TransportError::Failed("unexpected".into(), other.into())),
            }
        }
    }

    #[test]
    fn r5_the_extras_carry_the_question_seam_and_the_saved_steps_file_under_the_data_dir_and_never_a_prior_consent() {
        let mut e = env("extras", "{}");
        assert!(extras_for(&e).ask.is_none(), "no seam, no ask");
        e.ask = Some(std::sync::Arc::new(|_t, _c| true));
        let x = extras_for(&e);
        assert!(x.ask.is_some());
        assert!(!x.consent_given, "the host asks first-use in every run");
        assert_eq!(x.saved_steps, Some(e.data_dir.join("agent").join("saved-steps.json")));
    }

    fn env(name: &str, prices: &str) -> AgentEnv {
        let dir = std::env::temp_dir().join(format!("zumi-agent-wiring-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("prices.json"), prices).unwrap();
        AgentEnv { data_dir: dir.clone(), prices_file: dir.join("prices.json"), hands_exe: None, routines: None, model: Some("fixture/model".to_string()), total_cap_usd: None, ask: None }
    }

    #[test]
    fn m3_the_host_key_is_random_stable_for_the_run_and_not_blank() {
        let (a, b) = (host_accept_key(), host_accept_key());
        assert_eq!(a.len(), 32);
        assert!(std::ptr::eq(a, b), "one key for the whole run");
        assert!(a.iter().any(|x| *x != 0) && a.windows(2).any(|p| p[0] != p[1]), "not blank, not one repeated byte");
    }

    #[test]
    fn a_chat_sentence_saves_a_note_through_the_sidecar_and_logs_each_turn() {
        let e = env("note", r#"{"fixture/model": {"inputPerMtok": 1, "outputPerMtok": 3}}"#);
        let notes = Arc::new(Mutex::new(vec![]));
        let turns = Arc::new(Mutex::new(vec![
            json!({ "ok": true, "text": "", "toolCalls": [{ "id": "a", "name": "note.save", "args": { "text": "the dentist is on Friday" } }], "usage": { "in": 400, "out": 30, "total": 430 }, "model": "fixture/model", "ms": 5 }),
            json!({ "ok": true, "text": "Saved.", "toolCalls": [], "usage": { "in": 450, "out": 5, "total": 455 }, "model": "fixture/model", "ms": 5 }),
        ]));
        let (n2, t2) = (notes.clone(), turns.clone());
        let out = run_sentence_with(&e, "Save a note that the dentist is on Friday", move || Box::new(FakeSidecar { notes: n2.clone(), turns: t2.clone(), logged: Default::default() }), Cancel::new(), &mut |_| {}).unwrap();
        assert_eq!(out.stop, StopReason::Done);
        assert_eq!(*notes.lock().unwrap(), vec!["the dentist is on Friday"]);
        let usage = std::fs::read_dir(e.data_dir.join("usage")).unwrap().next().unwrap().unwrap().path();
        assert_eq!(std::fs::read_to_string(usage).unwrap().lines().count(), 2, "one ledger line per model turn");
        assert!(std::fs::read_dir(e.data_dir.join("audit").join("agent")).unwrap().next().is_some(), "the gate wrote its audit file");
    }

    #[test]
    fn r6c_a_finished_chat_run_offers_the_sentence_and_the_reply_to_memory_through_the_sidecar() {
        let e = env("turn", r#"{"fixture/model": {"inputPerMtok": 1, "outputPerMtok": 3}}"#);
        let logged = Arc::new(Mutex::new(vec![]));
        let turns = Arc::new(Mutex::new(vec![json!({ "ok": true, "text": "Hello there.", "toolCalls": [], "usage": { "in": 50, "out": 5, "total": 55 }, "model": "fixture/model", "ms": 5 })]));
        let (l2, t2) = (logged.clone(), turns.clone());
        let out = run_sentence_as(&e, "chat-turn-1", "Say hello", move || Box::new(FakeSidecar { notes: Default::default(), turns: t2.clone(), logged: l2.clone() }), Cancel::new(), &mut |_| {}).unwrap();
        assert_eq!(out.stop, StopReason::Done);
        assert_eq!(*logged.lock().unwrap(), vec![json!(["chat-turn-1", "Say hello", "Hello there."])], "the run id names the turn, so a repeat is one row");
    }

    #[test]
    fn n3_the_050_usd_total_cap_applies_by_default_and_cannot_be_raised_and_refuses_the_call_over_it() {
        for (name, cap) in [("cap-default", None), ("cap-raised", Some(5.0))] {
            let mut e = env(name, r#"{"fixture/model": {"inputPerMtok": 1, "outputPerMtok": 3}}"#);
            e.total_cap_usd = cap;
            std::fs::create_dir_all(e.data_dir.join("usage")).unwrap();
            std::fs::write(e.data_dir.join("usage").join("2026-11-01.jsonl"), "{\"task\":\"chat-old\",\"cost_usd\":0.499}\n").unwrap();
            let notes = Arc::new(Mutex::new(vec![]));
            let turns = Arc::new(Mutex::new(vec![json!({ "ok": true, "text": "", "toolCalls": [{ "id": "a", "name": "note.save", "args": { "text": "x y z" } }], "usage": { "in": 1, "out": 1, "total": 2 }, "model": "fixture/model", "ms": 1 })]));
            let (n2, t2) = (notes.clone(), turns.clone());
            let out = run_sentence_with(&e, "Save a note that x y z", move || Box::new(FakeSidecar { notes: n2.clone(), turns: t2.clone(), logged: Default::default() }), Cancel::new(), &mut |_| {}).unwrap();
            assert_eq!(out.stop, StopReason::CostCap, "{name}: 0.499 spent + this call's worst case > 0.50");
            assert_eq!(turns.lock().unwrap().len(), 1, "{name}: the model call over the cap was never made");
            assert!(notes.lock().unwrap().is_empty(), "{name}");
        }
    }

    #[test]
    fn p3d_an_unreadable_or_corrupt_ledger_stops_the_task_before_any_model_call() {
        for name in ["usage-is-a-file", "corrupt-line"] {
            let e = env(name, r#"{"fixture/model": {"inputPerMtok": 1, "outputPerMtok": 3}}"#);
            if name == "usage-is-a-file" {
                std::fs::write(e.data_dir.join("usage"), "a file where the folder should be").unwrap();
            } else {
                std::fs::create_dir_all(e.data_dir.join("usage")).unwrap();
                // A torn agent line: what it spent cannot be known, so the total cannot be.
                std::fs::write(e.data_dir.join("usage").join("2026-11-01.jsonl"), "{\"task\":\"chat-old\",\"cost_usd\":0.4\n").unwrap();
            }
            let notes = Arc::new(Mutex::new(vec![]));
            let turns = Arc::new(Mutex::new(vec![json!({ "ok": true, "text": "Hi.", "toolCalls": [], "usage": { "in": 1, "out": 1, "total": 2 }, "model": "fixture/model", "ms": 1 })]));
            let (n2, t2) = (notes.clone(), turns.clone());
            let mut events = Vec::new();
            let out = run_sentence_with(&e, "Say hi", move || Box::new(FakeSidecar { notes: n2.clone(), turns: t2.clone(), logged: Default::default() }), Cancel::new(), &mut |v| events.push(v)).unwrap();
            assert_eq!(out.stop.code(), "ledger_unreadable", "{name}: {:?}", out.stop);
            assert_eq!(turns.lock().unwrap().len(), 1, "{name}: no model call was made");
            if name == "corrupt-line" {
                // P3e: what the user is shown names the file and line to fix, in the stop event and in the outcome.
                let stopped = events.iter().find(|v| v["ev"] == "stopped").expect("a stopped event");
                let detail = stopped["detail"].as_str().unwrap_or_default();
                assert_eq!(stopped["reason"], "ledger_unreadable");
                assert!(detail.contains("2026-11-01.jsonl line 1"), "{detail}");
                assert!(matches!(&out.stop, StopReason::LedgerUnreadable(d) if d == detail), "{:?}", out.stop);
            }
        }
    }

    #[test]
    fn bite_an_unpriced_model_stops_the_task_before_its_tool_runs() {
        let e = env("unpriced", r#"{}"#);
        let notes = Arc::new(Mutex::new(vec![]));
        let turns = Arc::new(Mutex::new(vec![json!({ "ok": true, "text": "", "toolCalls": [{ "id": "a", "name": "note.save", "args": { "text": "x y z" } }], "usage": { "in": 1, "out": 1, "total": 2 }, "model": "who/knows", "ms": 1 })]));
        let mut e = e;
        e.model = Some("who/knows".to_string());
        let (n2, t2) = (notes.clone(), turns.clone());
        let out = run_sentence_with(&e, "Save a note that x y z", move || Box::new(FakeSidecar { notes: n2.clone(), turns: t2.clone(), logged: Default::default() }), Cancel::new(), &mut |_| {}).unwrap();
        assert_eq!(out.stop, StopReason::CostUnknown);
        assert!(notes.lock().unwrap().is_empty());
        assert_eq!(turns.lock().unwrap().len(), 1, "the model call itself was never made: no paid turn");
    }
}
