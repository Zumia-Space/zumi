// T-31-MAUS R2 "usable from chat": the thin wiring between the app and the chat-run registry (`zumi_agent_loop::runs`, no
// tauri dependency). The crate owns the one-run-at-a-time rule, the run list, the activity read, the stop token and the
// confirm seam; `agent_wiring::run_sentence_as` owns what one task is. This file supplies only what the crate cannot know:
//   - the data dir the sidecar was started with (the usage ledger, the audit and the run list all live under it),
//   - the push channel: every run event goes to the main webview as `agent:event` (events.rs, main label only),
//   - the model id of the chat brain (`talk.status`), the price table beside the sidecar's source, the hands pack beside
//     this exe, the A2 reminders runner,
//   - the renderer's four rpc methods (`agent.start|stop|status|confirm`), answered here without a sidecar call.
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use zumi_agent_loop::runs::{Emit, Runs, TaskFn};

use crate::agent_wiring::{self, AgentEnv, HostSidecar};
use crate::{events, routines_host, Rpc};

/// The push channel of the chat's run events (the inventory's `agent.onEvent`).
pub const EVENT_CHANNEL: &str = "agent:event";
/// `talk.status` is a local read; a slow answer means the sidecar is not ready.
const STATUS_TIMEOUT: Duration = Duration::from_secs(10);

/// The one registry of this process. Set once, by the first sidecar spawn that knows the data dir.
#[derive(Default)]
pub struct State(OnceLock<Runs>);

/// A renderer rpc name this module answers.
pub fn is_method(method: &str) -> bool {
    zumi_agent_loop::runs::is_method(method)
}

/// The data dir the sidecar was started with, kept for the chat turn's budget gate (set by the first `ensure_started`).
static DATA_DIR: OnceLock<PathBuf> = OnceLock::new();

/// R6b S1: the reply `talk.turn` gets when the monthly budget has no room (or cannot be read), in the shape the chat already shows for a
/// failed turn. The words are the agent task's own (`zumi_agent_loop::budget::turn_stop`). None: the turn may go to the sidecar.
pub fn chat_turn_gate(data_dir: &Path, prices_file: &Path) -> Option<Value> {
    let (code, why) = zumi_agent_loop::budget::turn_stop(data_dir, prices_file)?;
    Some(json!({ "ok": false, "error": { "code": code, "message": why, "retryable": false } }))
}

/// `chat_turn_gate` for this process: its data dir and the price table beside the sidecar's script. None before the first sidecar spawn.
pub fn chat_turn_stop(app: &AppHandle) -> Option<Value> {
    let data_dir = DATA_DIR.get()?;
    let prices = match crate::sidecar_script(app) {
        Ok(script) => prices_file_for(&script),
        Err(e) => return Some(json!({ "ok": false, "error": { "code": "budget_unreadable", "message": e, "retryable": false } })),
    };
    chat_turn_gate(data_dir, &prices)
}

/// The usage price table the staged bundle keeps at `src/main/usage-prices.json`, next to `tauri/sidecar/main.mjs`.
pub fn prices_file_for(sidecar_script: &Path) -> PathBuf {
    // The dev path is `<repo>/tauri/src-tauri/../sidecar/main.mjs`: fold the `..` first, or "three levels up" lands in `tauri/`.
    let mut folded = PathBuf::new();
    for part in sidecar_script.components() {
        match part {
            std::path::Component::ParentDir => {
                folded.pop();
            }
            other => folded.push(other),
        }
    }
    let root = folded.parent().and_then(Path::parent).and_then(Path::parent).unwrap_or(&folded).to_path_buf();
    root.join("src").join("main").join("usage-prices.json")
}

/// The hands pack beside this exe; none when it is not installed (the task then has no hands tools).
pub fn hands_exe_beside(host_exe: &Path) -> Option<PathBuf> {
    Some(host_exe.with_file_name("zumi-hands.exe")).filter(|p| p.is_file())
}

/// The model id the chat brain would use, from `talk.status`. A brain that is off says why; the run row shows it.
pub fn model_from_status(status: &Value) -> Result<String, String> {
    if status["enabled"] != true {
        let why = status["reason"].as_str().unwrap_or("chat is off");
        return Err(format!("chat_off: {}", why.chars().take(120).collect::<String>()));
    }
    match status["model"].as_str() {
        Some(m) if !m.is_empty() => Ok(m.to_string()),
        _ => Err("chat_off: no model id from talk.status".to_string()),
    }
}

/// Starts the registry once. Later calls (a sidecar restart) do nothing: a run in flight keeps its own clients.
pub fn ensure_started(app: &AppHandle, rpc: &Rpc, data_dir: &Path) {
    let _ = DATA_DIR.set(data_dir.to_path_buf());
    let Some(state) = app.try_state::<State>() else { return };
    if state.0.get().is_some() {
        return;
    }
    let emit_app = app.clone();
    let emit: Emit = Arc::new(move |ev| events::emit_main(&emit_app, EVENT_CHANNEL, ev));
    let (task_app, task_rpc, task_dir) = (app.clone(), rpc.clone(), data_dir.to_path_buf());
    // The task asks its questions through the registry that runs it (a cycle that lives as long as the process).
    let registry: Arc<OnceLock<Runs>> = Arc::new(OnceLock::new());
    let ask = confirm_asker(registry.clone());
    let task: TaskFn = Arc::new(move |id, sentence, cancel, sink| {
        // Stop must work from the first moment of a run: the prefetch gives up within a slice of the token being set.
        let model = model_from_status(&task_rpc.call_cancellable("talk.status", Vec::new(), STATUS_TIMEOUT, &|| cancel.is_set())?)?;
        let script = crate::sidecar_script(&task_app)?;
        let env = AgentEnv {
            data_dir: task_dir.clone(),
            prices_file: prices_file_for(&script),
            hands_exe: std::env::current_exe().ok().and_then(|exe| hands_exe_beside(&exe)),
            model: Some(model),
            total_cap_usd: None,
            routines: routines_host::runner(&task_app),
            ask: Some(ask.clone()),
        };
        let rpc_for_loop = task_rpc.clone();
        agent_wiring::run_sentence_as(&env, id, sentence, move || Box::new(HostSidecar(rpc_for_loop.clone())), cancel, sink)
    });
    // R6: a run holds the PC awake while it works (the same hold the routines use; the setting is read when the runs start).
    let keep_awake = zumi_agent_loop::keepawake::KeepAwake::process();
    keep_awake.set_enabled(crate::routines_host::read_keep_awake(data_dir));
    let runs = Runs::new_with(data_dir, emit, task, keep_awake);
    let _ = registry.set(runs.clone());
    if state.0.set(runs).is_ok() {
        eprintln!("agent: chat runs ready, data in {}", data_dir.join("agent").display());
    }
}

/// How long the person has to answer a question before it counts as a no.
pub const CONFIRM_WAIT: Duration = Duration::from_secs(120);

/// R5: the question seam of a task, over the registry of this process: the question goes to the chat as a `confirm` card
/// (`Runs::ask_confirm`), and only the renderer's `agent.confirm` with that card's id answers it. The registry does not exist
/// until the first sidecar spawn: a question asked before then is a no.
pub fn confirm_asker(runs: Arc<OnceLock<Runs>>) -> zumi_agent_loop::hands_tools::Asker {
    Arc::new(move |text, cancel| runs.get().is_some_and(|r| r.ask_confirm(text, CONFIRM_WAIT, cancel)))
}

/// The renderer's `agent.*` call.
pub fn serve(app: &AppHandle, method: &str, args: &[Value]) -> Result<Value, String> {
    match app.try_state::<State>().and_then(|s| s.0.get().cloned()) {
        Some(runs) => runs.serve(method, args),
        None => Err("agent_not_ready".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_the_four_agent_names_are_answered_here() {
        for m in ["agent.start", "agent.stop", "agent.status", "agent.confirm"] {
            assert!(is_method(m), "{m}");
        }
        assert!(!is_method("routines.list") && !is_method("agent.accept") && !is_method("talk.turn") && !is_method("agentx"));
    }

    #[test]
    fn the_price_table_is_found_from_the_sidecar_script_in_the_dev_tree_and_the_staged_bundle_layout() {
        let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("sidecar").join("main.mjs");
        let prices = prices_file_for(&dev);
        assert!(prices.is_file(), "the dev tree keeps the table where the host looks: {}", prices.display());
        assert_eq!(prices_file_for(Path::new("C:/app/tauri/sidecar/main.mjs")), PathBuf::from("C:/app/src/main/usage-prices.json"));
    }

    #[test]
    fn r5_the_asker_puts_the_question_on_the_chat_card_and_only_an_agent_confirm_yes_with_that_id_answers_it() {
        use std::sync::Mutex;
        let seen: Arc<Mutex<Vec<Value>>> = Arc::default();
        let s2 = seen.clone();
        let dir = std::env::temp_dir().join(format!("zumi-agent-host-ask-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let task: TaskFn = Arc::new(|_, _, _, _| Err("unused".to_string()));
        let runs = Runs::new(&dir, Arc::new(move |v| s2.lock().unwrap().push(v)), task);
        let cell: Arc<OnceLock<Runs>> = Arc::new(OnceLock::new());
        let ask = confirm_asker(cell.clone());
        let cancel = zumi_agent_loop::cancel::Cancel::new();
        // Before the registry exists nothing can be asked: a no, at once.
        assert!(!ask("anything", &cancel));
        cell.set(runs.clone()).ok();
        for (answer, want) in [(true, true), (false, false)] {
            let (ask2, c2) = (ask.clone(), cancel.clone());
            let h = std::thread::spawn(move || ask2("Delete?", &c2));
            let id = loop {
                if let Some(id) = seen.lock().unwrap().iter().rev().find(|e| e["ev"] == "confirm").and_then(|e| e["id"].as_str()).map(str::to_string) {
                    break id;
                }
                std::thread::sleep(Duration::from_millis(5));
            };
            assert_eq!(runs.serve("agent.confirm", &[json!("c-forged"), json!(true)]).unwrap()["ok"], false, "a guessed id answers nothing");
            assert_eq!(runs.serve("agent.confirm", &[json!(id), json!(answer)]).unwrap()["ok"], true);
            assert_eq!(h.join().unwrap(), want);
            seen.lock().unwrap().clear();
        }
        // A cancel (Stop) is a no, within a slice.
        let c3 = zumi_agent_loop::cancel::Cancel::new();
        c3.set("user");
        assert!(!ask("Delete?", &c3));
    }

    /// R6b S1 (gate R6 should-fix 1): the plain chat turn is stopped by the monthly cap before any model call, with the agent task's words.
    #[test]
    fn r6b_a_chat_turn_is_stopped_by_the_monthly_cap_with_the_agent_tasks_words_and_goes_through_inside_it() {
        let dir = std::env::temp_dir().join(format!("zumi-agent-host-chatcap-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("usage")).unwrap();
        let prices = dir.join("prices.json");
        std::fs::write(&prices, json!({ "_source": {}, "m/p": { "inputPerMtok": 1.0, "outputPerMtok": 1.0, "unverified": false } }).to_string()).unwrap();
        assert_eq!(chat_turn_gate(&dir, &prices), None, "no budget set: the turn goes");
        std::fs::write(dir.join("budget.json"), r#"{"monthly_usd": 2.0}"#).unwrap();
        let ts = zumi_agent_loop::ledger::iso_utc(zumi_agent_loop::types::unix_ms());
        let write_ledger = |tokens: u64| {
            let line = json!({ "ts": ts, "model": "m/p", "kind": "chat", "in": tokens, "out": 0, "ok": true });
            std::fs::write(dir.join("usage").join(format!("{}.jsonl", zumi_agent_loop::ledger::local_date())), format!("{line}\n")).unwrap();
        };
        write_ledger(1_000_000);
        assert_eq!(chat_turn_gate(&dir, &prices), None, "1.00 of 2.00 spent: the turn goes");
        write_ledger(2_500_000);
        let stop = chat_turn_gate(&dir, &prices).expect("2.50 of 2.00 spent: the turn is stopped");
        let (code, why) = zumi_agent_loop::budget::turn_stop(&dir, &prices).unwrap();
        assert_eq!(stop, json!({ "ok": false, "error": { "code": code, "message": why, "retryable": false } }));
        assert_eq!(code, "budget_month");
        std::fs::write(dir.join("budget.json"), "garbage").unwrap();
        assert_eq!(chat_turn_gate(&dir, &prices).unwrap()["error"]["code"], "budget_unreadable", "a cap that cannot be read stops the turn too");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// R6c A (spare live run of R6b): real chat spend on OpenCode Go (the bare model id `deepseek-v4.1-flash`) must trip the monthly cap, as it
    /// does for the vendor-keyed id. A cap that is not set changes nothing, and a model the table does not know at all still counts 0 for chat.
    #[test]
    fn r6c_chat_spend_on_a_bare_model_id_trips_the_monthly_cap_and_no_cap_means_no_change() {
        let dir = std::env::temp_dir().join(format!("zumi-agent-host-gocap-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("usage")).unwrap();
        let prices = dir.join("prices.json");
        std::fs::write(&prices, json!({ "_source": {}, "deepseek/deepseek-v4.1-flash": { "inputPerMtok": 0.3, "outputPerMtok": 1.2, "unverified": false } }).to_string()).unwrap();
        let ts = zumi_agent_loop::ledger::iso_utc(zumi_agent_loop::types::unix_ms());
        let day = dir.join("usage").join(format!("{}.jsonl", zumi_agent_loop::ledger::local_date()));
        let write = |model: &str, tokens: u64| {
            let line = json!({ "ts": ts, "model": model, "kind": "chat", "in": tokens, "out": 0, "ok": true });
            std::fs::write(&day, format!("{line}\n")).unwrap();
        };
        write("deepseek-v4.1-flash", 10_000_000); // 3.00 USD at 0.3 per Mtok
        assert_eq!(chat_turn_gate(&dir, &prices), None, "no budget file: no monthly cap, the turn goes");
        std::fs::write(dir.join("budget.json"), r#"{"monthly_usd": 2.0}"#).unwrap();
        let stop = chat_turn_gate(&dir, &prices).expect("3.00 of 2.00 spent on the bare id: the turn is stopped");
        assert_eq!(stop["error"]["code"], "budget_month");
        write("deepseek/deepseek-v4.1-flash", 10_000_000);
        assert_eq!(chat_turn_gate(&dir, &prices).unwrap()["error"]["code"], "budget_month", "the vendor id still does");
        write("some-model-nobody-priced", 10_000_000);
        assert_eq!(chat_turn_gate(&dir, &prices), None, "a model with no price at all is unchanged: 0 for chat, as upstream counts an unpriced model");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_hands_pack_is_offered_only_when_the_exe_is_there() {
        let dir = std::env::temp_dir().join(format!("zumi-agent-host-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let host = dir.join("zumi.exe");
        assert_eq!(hands_exe_beside(&host), None);
        std::fs::write(dir.join("zumi-hands.exe"), b"x").unwrap();
        assert_eq!(hands_exe_beside(&host), Some(dir.join("zumi-hands.exe")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_model_comes_from_talk_status_and_a_brain_that_is_off_is_a_visible_reason_not_a_default() {
        assert_eq!(model_from_status(&json!({ "enabled": true, "mode": "byo", "model": "deepseek/deepseek-v4-flash" })).unwrap(), "deepseek/deepseek-v4-flash");
        let off = model_from_status(&json!({ "enabled": false, "mode": "off", "reason": "no OpenRouter key saved" })).unwrap_err();
        assert!(off.starts_with("chat_off:") && off.contains("no OpenRouter key"), "{off}");
        assert!(model_from_status(&json!({ "enabled": true })).unwrap_err().starts_with("chat_off:"));
        assert!(model_from_status(&json!({ "enabled": true, "model": "" })).is_err());
        assert!(model_from_status(&Value::Null).is_err());
    }
}
