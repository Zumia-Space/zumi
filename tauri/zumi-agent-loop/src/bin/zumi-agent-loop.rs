//! `zumi-agent-loop run`: runs one task on the mock model and prints one JSON event per line on stdout. The goal
//! harness (scripts/maus-p3-goals.mjs) drives it. Notes and any sidecar call are bridged over the same stdio: the
//! bin prints `{"ev":"rpc","id":N,"method":..,"params":[..]}` and reads `{"rpc_result":{"id":N,"result":..}}` lines.
//!
//!   zumi-agent-loop run --sentence S --fixture F [--var k=v ...] [--hands EXE --control-dir D --workspace D]
//!                       [--notes-bridge] [--reminders-dir D] --loop-audit F [--usage-dir D --prices F] [--task-id T]
//!     --reminders-dir: offers `reminder.add` on an A2 store (`zumi-routines`) in D, a directory of the harness's own, and
//!     prints `{"ev":"reminders","items":[..]}` (what `routines.list` shows) when the task ends. The store never fires here.
//!   zumi-agent-loop run --live --model M --max-usd X --usage-dir D --prices F --sentence S ... (same optional flags)
//!     --live: model turns are `__host.modelTurn` rpcs over the same stdio (the harness forwards them to the real
//!     sidecar, which holds the BYOK key). The cap on this run is X USD over what the ledger in D already holds, never
//!     above TOTAL_CAP_USD; an unreadable ledger stops the task before any call.
//!   zumi-agent-loop run ... --egress-config F [--engine custom]
//!     R3: F is `{ "mcpServers": { "<name>": { "url": .., "headers": .., "enabled": true } }, "endpoint": { "baseUrl", "model",
//!     "inputPerMtok", "outputPerMtok", "apiKeyEnv"? } }`: what the user added. Each enabled MCP server is connected and its read-only
//!     tools are offered (`{"ev":"mcp",..}` says how each went); `--engine custom` runs the model on `endpoint` (needs --usage-dir and
//!     --prices: the endpoint's model is priced there as `custom:<model>`). Every origin in F is one the user added; nothing else
//!     is reachable. At the end the bin prints `{"ev":"final","stop":..,"text":..}`.
//!   zumi-agent-loop run ... [--ask yes,no,...] [--consent given] [--saved-steps FILE]
//!     R5 (harness only, the desktop checks of scripts/maus-r5-desktop.mjs): --ask plays the person: the nth question the hands put (the
//!     first-use question, then each confirm for a final action) gets the nth answer, the last answer repeats, and every question is
//!     printed as {"ev":"question","text":..,"answer":..}. Without --ask nobody can be asked: a final action is refused.
//!     --consent given skips the first-use question (the harness started the run). --saved-steps FILE keeps and replays saved steps.
//!   zumi-agent-loop run-chat --sentence S --data-dir D --prices F (--fixture F [--var k=v ...] | --live --model M --max-usd X)
//!     R2: the same task, but started through the chat-run registry (`agent.start`, `zumi_agent_loop::runs`), exactly as the chat
//!     does. Notes go over the bridge. Prints the run events (each stamped with its run id), then {"ev":"chat_status","start","status"}:
//!     what `agent.start` answered and what `agent.status` returns for the run. Audit under D/audit/agent, ledger in D/usage.
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use zumi_agent_loop::cancel::Cancel;
use zumi_agent_loop::ledger::{total_agent_cost_usd, Ledger, Prices};
use zumi_agent_loop::loop_run::{Meter, NullMeter};
use zumi_agent_loop::mcp_http::McpServerConfig;
use zumi_agent_loop::openai_compat::CustomEndpoint;
use zumi_agent_loop::runner::{run_task, run_task_with, HandsOpts, ModelSource, TaskExtras, TaskOpts};
use zumi_agent_loop::tool_gate::TOTAL_CAP_USD;
use zumi_agent_loop::transport::{RpcCall, TransportError};

fn emit(v: &Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{v}").and_then(|_| out.flush());
}

/// Sidecar calls over the bin's own stdio (the harness plays the sidecar, or forwards to the real one in --live). One
/// reader thread routes each `rpc_result` to the call waiting on its id, so the model turn, its abort and a note call
/// can be in flight at once. Clones share the one stdin.
#[derive(Clone)]
struct Bridge {
    waiting: Arc<Mutex<HashMap<u64, mpsc::Sender<Value>>>>,
    next: Arc<AtomicU64>,
}

impl Bridge {
    fn start() -> Bridge {
        let waiting: Arc<Mutex<HashMap<u64, mpsc::Sender<Value>>>> = Arc::default();
        let w = waiting.clone();
        std::thread::spawn(move || {
            for line in std::io::stdin().lock().lines().map_while(Result::ok) {
                let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
                let Some(id) = v["rpc_result"]["id"].as_u64() else { continue };
                if let Some(tx) = w.lock().unwrap().remove(&id) {
                    let _ = tx.send(v["rpc_result"]["result"].clone());
                }
            }
        });
        Bridge { waiting, next: Arc::new(AtomicU64::new(1)) }
    }
}

/// A model turn can take a while (the host allows 90 s too); a note call is local.
const RPC_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(90);

impl RpcCall for Bridge {
    fn call(&mut self, method: &str, params: Value, cancel: &Cancel) -> Result<Value, TransportError> {
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = mpsc::channel();
        self.waiting.lock().unwrap().insert(id, tx);
        emit(&json!({ "ev": "rpc", "id": id, "method": method, "params": params }));
        let end = std::time::Instant::now() + RPC_TIMEOUT;
        let out = loop {
            if cancel.is_set() {
                break Err(TransportError::Cancelled);
            }
            if std::time::Instant::now() >= end {
                break Err(TransportError::Failed("rpc_timeout".into(), method.to_string()));
            }
            if let Ok(v) = rx.recv_timeout(std::time::Duration::from_millis(10)) {
                break Ok(v);
            }
        };
        self.waiting.lock().unwrap().remove(&id);
        out
    }
}

/// R2: one task through the chat-run registry, the way the chat starts it. The task is built inside the registry's thread
/// (the opts hold boxed stores that are not `Send`), from plain values and one bridge.
fn run_chat(argv: &[String]) -> std::process::ExitCode {
    use zumi_agent_loop::ledger::local_date;
    use zumi_agent_loop::runs::{Runs, TaskFn};
    let (mut one, mut vars, mut live) = (HashMap::<String, String>::new(), HashMap::<String, String>::new(), false);
    let mut it = argv.iter();
    while let Some(k) = it.next() {
        match k.as_str() {
            "--live" => live = true,
            "--var" => {
                if let Some((a, b)) = it.next().and_then(|v| v.split_once('=')) {
                    vars.insert(a.to_string(), b.to_string());
                }
            }
            flag if flag.starts_with("--") => {
                if let Some(v) = it.next() {
                    one.insert(flag[2..].to_string(), v.clone());
                }
            }
            other => {
                eprintln!("bad argument {other:?}");
                return std::process::ExitCode::from(2);
            }
        }
    }
    let fail = |msg: String| {
        emit(&json!({ "ev": "error", "error": msg }));
        std::process::ExitCode::from(2)
    };
    let need = |k: &str| one.get(k).cloned().ok_or(format!("--{k} is required"));
    let (sentence, data, prices_file) = match (need("sentence"), need("data-dir"), need("prices")) {
        (Ok(s), Ok(d), Ok(p)) => (s, PathBuf::from(d), p),
        (Err(e), _, _) | (_, Err(e), _) | (_, _, Err(e)) => return fail(e),
    };
    let prices = match Prices::load(std::path::Path::new(&prices_file)) {
        Ok(p) => p,
        Err(e) => return fail(e),
    };
    let (model, fixture, max_usd) = if live {
        let max: f64 = match need("max-usd").and_then(|m| m.parse().map_err(|_| "--max-usd must be a number".to_string())) {
            Ok(m) if m > 0.0 => m,
            Ok(_) => return fail("--max-usd must be above 0".into()),
            Err(e) => return fail(e),
        };
        match need("model") {
            Ok(m) => (Some(m), None, Some(max.min(TOTAL_CAP_USD))),
            Err(e) => return fail(e),
        }
    } else {
        match need("fixture") {
            Ok(f) => (None, Some(PathBuf::from(f)), None),
            Err(e) => return fail(e),
        }
    };
    let bridge = Bridge::start();
    let task_data = data.clone();
    let task: TaskFn = Arc::new(move |id, sentence, cancel, sink| {
        let source = match (&model, &fixture) {
            (Some(m), _) => {
                let b = bridge.clone();
                let make: zumi_agent_loop::transport::RpcFactory = Arc::new(move || Box::new(b.clone()) as Box<dyn RpcCall + Send>);
                ModelSource::Rpc { make, model: Some(m.clone()) }
            }
            (None, Some(f)) => ModelSource::Mock { fixture: f.clone(), vars: vars.clone() },
            (None, None) => return Err("no model source".to_string()),
        };
        let opts = TaskOpts {
            task_id: id.to_string(),
            sentence: sentence.to_string(),
            model: source,
            hands: None,
            notes: Some(Box::new(bridge.clone())),
            reminders: None,
            loop_audit: task_data.join("audit").join("agent").join(format!("{}.jsonl", local_date())),
            prior_usd: total_agent_cost_usd(&task_data),
            max_total_usd: max_usd,
            cancel,
        };
        let mut ledger = Ledger::new(task_data.clone(), prices.clone(), id);
        run_task(opts, &mut ledger, sink)
    });
    let runs = Runs::new(&data, Arc::new(|v| emit(&v)), task);
    let start = match runs.serve("agent.start", &[json!(sentence)]) {
        Ok(v) => v,
        Err(e) => return fail(e),
    };
    let Some(id) = start["id"].as_str().map(str::to_string) else {
        emit(&json!({ "ev": "chat_status", "start": start, "status": null }));
        return std::process::ExitCode::from(1);
    };
    // The run is on its own thread; wait for it as the chat would, by asking for the status.
    let end = std::time::Instant::now() + std::time::Duration::from_secs(600);
    let status = loop {
        let st = runs.serve("agent.status", &[json!(id)]).unwrap_or(Value::Null);
        if st["active"].is_null() || std::time::Instant::now() > end {
            break st;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    };
    let done = status["runs"].as_array().is_some_and(|r| r.iter().any(|row| row["id"] == id.as_str() && row["status"] == "done"));
    emit(&json!({ "ev": "chat_status", "start": start, "status": status }));
    std::process::ExitCode::from(if done { 0 } else { 1 })
}

/// R3: the user's added origins: `mcpServers` and `endpoint` of one JSON file. A key is read from the environment variable the
/// file names, never from the file.
fn read_egress_config(file: &str) -> Result<(Vec<McpServerConfig>, Option<CustomEndpoint>), String> {
    let text = std::fs::read_to_string(file).map_err(|e| format!("{file}: {e}"))?;
    let v: Value = serde_json::from_str(&text).map_err(|e| format!("{file}: {e}"))?;
    let servers = match v.get("mcpServers") {
        Some(s) => McpServerConfig::list_from_json(s).map_err(|e| format!("mcpServers: {} ({})", e.code(), e.detail()))?,
        None => Vec::new(),
    };
    let ep = match v.get("endpoint") {
        Some(e) => Some(CustomEndpoint::from_json(e, &|n| std::env::var(n).ok())?),
        None => None,
    };
    Ok((servers, ep))
}

fn main() -> std::process::ExitCode {
    // The pipes to the harness must not be inherited by the hands helper or the app it launches (zumi-audit inherit.rs).
    zumi_audit::inherit::private_std_handles();
    let argv: Vec<String> = std::env::args().skip(1).collect();
    if argv.first().map(String::as_str) == Some("run-chat") {
        return run_chat(&argv[1..]);
    }
    if argv.first().map(String::as_str) != Some("run") {
        eprintln!("usage: zumi-agent-loop run --sentence S --fixture F ... (see the file header)");
        return std::process::ExitCode::from(2);
    }
    let mut one: HashMap<String, String> = HashMap::new();
    let mut vars: HashMap<String, String> = HashMap::new();
    let mut notes_bridge = false;
    let mut live = false;
    let mut it = argv[1..].iter();
    while let Some(k) = it.next() {
        match k.as_str() {
            "--notes-bridge" => notes_bridge = true,
            "--live" => live = true,
            "--var" => {
                if let Some((a, b)) = it.next().and_then(|v| v.split_once('=')) {
                    vars.insert(a.to_string(), b.to_string());
                }
            }
            flag if flag.starts_with("--") => {
                if let Some(v) = it.next() {
                    one.insert(flag[2..].to_string(), v.clone());
                }
            }
            other => {
                eprintln!("bad argument {other:?}");
                return std::process::ExitCode::from(2);
            }
        }
    }
    let need = |k: &str| one.get(k).cloned().ok_or(format!("--{k} is required"));
    let bridge = (notes_bridge || live).then(Bridge::start);
    // R3: what the user added (MCP servers, a custom endpoint).
    let (mut extras, custom_ep) = match one.get("egress-config") {
        None => (TaskExtras::default(), None),
        Some(file) => match read_egress_config(file) {
            Ok((servers, ep)) => (TaskExtras { mcp_servers: servers, ..Default::default() }, ep),
            Err(e) => {
                emit(&json!({ "ev": "error", "error": e }));
                return std::process::ExitCode::from(2);
            }
        },
    };
    if let Some(list) = one.get("ask") {
        let answers: Vec<bool> = list.split(',').map(|a| a.trim() == "yes").collect();
        let n = Arc::new(AtomicU64::new(0));
        extras.ask = Some(Arc::new(move |text: &str, _c: &Cancel| {
            let i = n.fetch_add(1, Ordering::SeqCst) as usize;
            let answer = answers.get(i).or(answers.last()).copied().unwrap_or(false);
            emit(&json!({ "ev": "question", "text": text, "answer": answer }));
            answer
        }));
    }
    extras.consent_given = one.get("consent").map(String::as_str) == Some("given");
    extras.saved_steps = one.get("saved-steps").map(PathBuf::from);
    let engine_custom = one.get("engine").map(String::as_str) == Some("custom");
    let built = (|| -> Result<TaskOpts, String> {
        let (model, prior_usd, max_total_usd) = if engine_custom {
            let ep = custom_ep.clone().ok_or("--engine custom needs an endpoint in --egress-config")?;
            need("prices")?;
            let dir = need("usage-dir")?;
            (ModelSource::Custom(ep), total_agent_cost_usd(std::path::Path::new(&dir)), Some(TOTAL_CAP_USD))
        } else if live {
            let b = bridge.clone().ok_or("bridge")?;
            let max: f64 = need("max-usd")?.parse().map_err(|_| "--max-usd must be a number".to_string())?;
            if !(max > 0.0) {
                return Err("--max-usd must be above 0".into());
            }
            let dir = need("usage-dir")?;
            need("prices")?;
            let make: zumi_agent_loop::transport::RpcFactory = Arc::new(move || Box::new(b.clone()) as Box<dyn RpcCall + Send>);
            (ModelSource::Rpc { make, model: Some(need("model")?) }, total_agent_cost_usd(std::path::Path::new(&dir)), Some(max.min(TOTAL_CAP_USD)))
        } else {
            (ModelSource::Mock { fixture: PathBuf::from(need("fixture")?), vars }, Ok(0.0), None)
        };
        Ok(TaskOpts {
            task_id: one.get("task-id").cloned().unwrap_or_else(|| format!("task-{}", zumi_audit::unix_ms())),
            sentence: need("sentence")?,
            model,
            hands: match one.get("hands") {
                Some(exe) => Some(HandsOpts { exe: PathBuf::from(exe), control_dir: PathBuf::from(need("control-dir")?), workspace: PathBuf::from(need("workspace")?), deadman_ms: 10 * 60 * 1000, accept_key: None }),
                None => None,
            },
            reminders: None,
            notes: if notes_bridge { bridge.clone().map(|b| Box::new(b) as Box<dyn RpcCall>) } else { None },
            loop_audit: PathBuf::from(need("loop-audit")?),
            prior_usd,
            max_total_usd,
            cancel: Cancel::new(),
        })
    })();
    // A store of the run's own for `reminder.add`: the real A2 store, system clock and zone, but a tick period so long (and a
    // sink that always says "not now") that nothing is ever spoken from a harness run.
    let routines = match one.get("reminders-dir") {
        Some(dir) => {
            let mut cfg = zumi_routines::Config::system(PathBuf::from(dir), || zumi_routines::Quiet::DEFAULT, |_| Err("harness run: nothing is spoken".to_string()), zumi_audit::keepawake::KeepAwake::off());
            cfg.period = std::time::Duration::from_secs(3600);
            match zumi_routines::Routines::start(cfg) {
                Ok(r) => Some(r),
                Err(e) => {
                    emit(&json!({ "ev": "error", "error": format!("reminders store: {e:?}") }));
                    return std::process::ExitCode::from(2);
                }
            }
        }
        None => None,
    };
    let opts = match built {
        Ok(mut o) => {
            if let Some(r) = &routines {
                o.reminders = Some(Box::new(zumi_agent_loop::reminders::RoutinesStore(r.clone())));
            }
            o
        }
        Err(e) => {
            emit(&json!({ "ev": "error", "error": e }));
            return std::process::ExitCode::from(2);
        }
    };
    // Tokens and cost per turn go to the usage ledger when --usage-dir is given (prices: --prices, USD per Mtok).
    let mut meter: Box<dyn Meter> = match (one.get("usage-dir"), one.get("prices")) {
        (Some(dir), Some(prices)) => match Prices::load(std::path::Path::new(prices)) {
            Ok(p) => {
                // The custom endpoint's model is priced by the user's own setting, never by a hosted model's table row.
                let p = match (&custom_ep, engine_custom) {
                    (Some(ep), true) => p.with_model(&ep.ledger_model(), ep.input_per_mtok, ep.output_per_mtok),
                    _ => p,
                };
                Box::new(Ledger::new(PathBuf::from(dir), p, &opts.task_id))
            }
            Err(e) => {
                emit(&json!({ "ev": "error", "error": e }));
                return std::process::ExitCode::from(2);
            }
        },
        (None, None) => Box::new(NullMeter),
        _ => {
            emit(&json!({ "ev": "error", "error": "--usage-dir and --prices go together" }));
            return std::process::ExitCode::from(2);
        }
    };
    let result = run_task_with(opts, extras, meter.as_mut(), &mut |v| emit(&v));
    if let Some(r) = routines {
        let items = r.handle("routines.list", &[]).map(|v| v["items"].clone()).unwrap_or(json!([]));
        emit(&json!({ "ev": "reminders", "items": items }));
        r.stop();
    }
    match result {
        Ok(o) => {
            emit(&json!({ "ev": "final", "stop": o.stop.code(), "text": o.final_text }));
            std::process::ExitCode::from(if matches!(o.stop, zumi_agent_loop::loop_run::StopReason::Done) { 0 } else { 1 })
        }
        Err(e) => {
            emit(&json!({ "ev": "error", "error": e }));
            std::process::ExitCode::from(2)
        }
    }
}
