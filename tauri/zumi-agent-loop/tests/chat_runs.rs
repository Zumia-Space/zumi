//! R2 "usable from chat": the registry behind `agent.start|stop|status|confirm`. It runs the REAL loop where the question
//! is about the loop (stop latency, the audit the activity panel reads) and a plain fake task where it is about bookkeeping.
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use zumi_agent_loop::cancel::Cancel;
use zumi_agent_loop::ledger::{local_date, Ledger, Prices};
use zumi_agent_loop::loop_run::{Outcome, StopReason};
use zumi_agent_loop::runner::{run_task, ModelSource, TaskOpts};
use zumi_agent_loop::runs::{is_method, Emit, Runs, TaskFn, MAX_SENTENCE_CHARS};

fn dir(name: &str) -> PathBuf {
    let d = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("chat-runs-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

type Seen = Arc<Mutex<Vec<Value>>>;
fn collector() -> (Emit, Seen) {
    let seen: Seen = Arc::new(Mutex::new(vec![]));
    let s2 = seen.clone();
    (Arc::new(move |v| s2.lock().unwrap().push(v)), seen)
}
fn outcome(stop: StopReason, steps: u32) -> Outcome {
    Outcome { stop, steps, final_text: String::new(), messages: vec![] }
}
fn fake(events: Vec<Value>, stop: StopReason) -> TaskFn {
    Arc::new(move |_id, _sentence, _cancel, sink| {
        for e in &events {
            sink(e.clone());
        }
        Ok(outcome(stop.clone(), 1))
    })
}
fn idle(runs: &Runs, within: Duration) -> bool {
    let t = Instant::now();
    while t.elapsed() < within {
        if runs.serve("agent.status", &[]).unwrap()["active"].is_null() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    false
}
fn start(runs: &Runs, sentence: &str) -> Value {
    runs.serve("agent.start", &[json!(sentence)]).unwrap()
}
fn rows(runs: &Runs) -> Vec<Value> {
    runs.serve("agent.status", &[]).unwrap()["runs"].as_array().unwrap().clone()
}

#[test]
fn start_streams_events_stamped_with_the_run_id_and_ends_with_a_run_end_that_carries_the_cost() {
    let (emit, seen) = collector();
    let events = vec![
        json!({ "ev": "task_start", "task": "x" }),
        json!({ "ev": "tool_start", "step": 1, "name": "hands.launch" }),
        json!({ "ev": "tool_end", "step": 1, "name": "hands.launch", "ok": true, "error": null, "detail": null, "ms": 12 }),
        json!({ "ev": "turn", "step": 1, "cost_usd": 0.002 }),
        json!({ "ev": "turn", "step": 2, "cost_usd": 0.0015 }),
        json!({ "ev": "stopped", "reason": "done", "steps": 2, "detail": "" }),
    ];
    let runs = Runs::new(&dir("stream"), emit, fake(events, StopReason::Done));
    let r = start(&runs, "open notepad");
    assert_eq!(r["ok"], true, "{r}");
    let id = r["id"].as_str().unwrap().to_string();
    assert!(idle(&runs, Duration::from_secs(5)));
    let seen = seen.lock().unwrap().clone();
    assert!(seen.len() >= 7, "every loop event plus run_end: {seen:?}");
    assert!(seen.iter().all(|e| e["run"] == id.as_str()), "each event names its run: {seen:?}");
    let names: Vec<&str> = seen.iter().filter(|e| e["ev"] == "tool_start" || e["ev"] == "tool_end").map(|e| e["name"].as_str().unwrap()).collect();
    assert_eq!(names, vec!["hands.launch", "hands.launch"], "the chip source events pass through unchanged");
    let end = seen.last().unwrap();
    assert_eq!(end["ev"], "run_end");
    assert_eq!(end["status"], "done");
    assert!((end["cost_usd"].as_f64().unwrap() - 0.0035).abs() < 1e-12, "{end}");
}

#[test]
fn only_one_run_at_a_time_and_a_bad_sentence_never_reaches_the_task() {
    let (emit, _) = collector();
    let started = Arc::new(Mutex::new(0u32));
    let s2 = started.clone();
    let task: TaskFn = Arc::new(move |_id, _s, cancel, _sink| {
        *s2.lock().unwrap() += 1;
        cancel.sleep(30_000);
        Ok(outcome(StopReason::Cancelled("user".into()), 0))
    });
    let runs = Runs::new(&dir("busy"), emit, task);
    for bad in ["", "   ", "\n\t", &"a".repeat(MAX_SENTENCE_CHARS + 1), "has a nul \u{0} byte"] {
        let r = start(&runs, bad);
        assert_eq!(r["ok"], false, "{bad:?}");
        assert_eq!(r["error"], "bad_sentence", "{bad:?}");
    }
    assert_eq!(*started.lock().unwrap(), 0, "no bad sentence started a task");
    assert_eq!(start(&runs, &"a".repeat(MAX_SENTENCE_CHARS))["ok"], true, "exactly the limit is fine");
    let second = start(&runs, "another");
    assert_eq!((second["ok"].clone(), second["error"].clone()), (json!(false), json!("busy")));
    runs.serve("agent.stop", &[]).unwrap();
    assert!(idle(&runs, Duration::from_secs(2)));
    assert_eq!(*started.lock().unwrap(), 1);
    assert_eq!(start(&runs, "again")["ok"], true, "free again once the first ended");
    runs.serve("agent.stop", &[]).unwrap();
    assert!(idle(&runs, Duration::from_secs(2)));
}

/// The REAL loop, a model turn that takes a minute (the mock's own latency, which polls the cancel token), the real
/// ledger and audit. Stop must end it within 200 ms, 10 times in 10 (R2 goal check).
#[test]
fn stop_halts_a_real_loop_in_a_slow_model_turn_within_200_ms_ten_of_ten() {
    let data = dir("stop200");
    let fixture = data.join("slow.json");
    std::fs::write(&fixture, json!({ "name": "slow", "model": "mock/loop-v1", "turns": [{ "delay_ms": 60000, "text": "never" }] }).to_string()).unwrap();
    let prices = data.join("prices.json");
    std::fs::write(&prices, r#"{"mock/loop-v1": {"inputPerMtok": 1, "outputPerMtok": 3}}"#).unwrap();
    let (data2, fixture2, prices2) = (data.clone(), fixture.clone(), prices.clone());
    let task: TaskFn = Arc::new(move |id, sentence, cancel, sink| {
        let opts = TaskOpts {
            task_id: id.to_string(),
            sentence: sentence.to_string(),
            model: ModelSource::Mock { fixture: fixture2.clone(), vars: Default::default() },
            hands: None,
            notes: None,
            reminders: None,
            loop_audit: data2.join("audit").join("agent").join(format!("{}.jsonl", local_date())),
            prior_usd: Ok(0.0),
            max_total_usd: None,
            cancel,
        };
        let mut ledger = Ledger::new(data2.clone(), Prices::load(&prices2).unwrap(), id);
        run_task(opts, &mut ledger, sink)
    });
    let (emit, seen) = collector();
    let runs = Runs::new(&data, emit, task);
    for i in 0..10 {
        let id = start(&runs, "wait for the model")["id"].as_str().unwrap().to_string();
        // Wait until the loop is inside the slow turn, so the stop is a real mid-turn stop.
        let t = Instant::now();
        while !seen.lock().unwrap().iter().any(|e| e["run"] == id.as_str() && e["ev"] == "turn_start") && t.elapsed() < Duration::from_secs(3) {
            std::thread::sleep(Duration::from_millis(2));
        }
        std::thread::sleep(Duration::from_millis(20));
        let t = Instant::now();
        let r = runs.serve("agent.stop", &[]).unwrap();
        assert_eq!(r["stopped"], 1, "round {i}");
        assert!(idle(&runs, Duration::from_millis(1000)), "round {i}: never ended");
        let took = t.elapsed();
        assert!(took < Duration::from_millis(200), "round {i}: stop to idle took {took:?}");
        let row = rows(&runs).into_iter().find(|r| r["id"] == id.as_str()).unwrap();
        assert_eq!(row["status"], "stopped", "round {i}: {row}");
        assert_eq!(row["reason"], "cancelled", "round {i}: {row}");
        std::thread::sleep(Duration::from_millis(2));
    }
}

#[test]
fn stop_with_nothing_running_is_ok_and_says_zero() {
    let (emit, _) = collector();
    let runs = Runs::new(&dir("stop0"), emit, fake(vec![], StopReason::Done));
    let r = runs.serve("agent.stop", &[json!({ "all": true })]).unwrap();
    assert_eq!((r["ok"].clone(), r["stopped"].clone()), (json!(true), json!(0)));
}

#[test]
fn the_run_list_is_one_row_per_run_newest_first_with_status_and_cost_and_survives_a_restart() {
    let data = dir("list");
    let (emit, _) = collector();
    let runs = Runs::new(&data, emit, fake(vec![json!({ "ev": "turn", "cost_usd": 0.004 })], StopReason::Done));
    for s in ["first", "second", "third"] {
        assert_eq!(start(&runs, s)["ok"], true);
        assert!(idle(&runs, Duration::from_secs(2)));
        std::thread::sleep(Duration::from_millis(3));
    }
    let list = rows(&runs);
    assert_eq!(list.iter().map(|r| r["sentence"].as_str().unwrap()).collect::<Vec<_>>(), vec!["third", "second", "first"]);
    assert!(list.iter().all(|r| r["status"] == "done" && r["cost_usd"] == 0.004 && r["steps"] == 1), "{list:?}");
    assert_eq!(list.len(), 3, "one row per run, not one per event");
    // A new process (a restart of the app): the same rows, read from disk.
    let (emit2, _) = collector();
    let again = Runs::new(&data, emit2, fake(vec![], StopReason::Done));
    assert_eq!(rows(&again), list);
}

#[test]
fn an_error_a_cap_stop_and_a_panic_are_rows_not_silence_and_free_the_slot() {
    let (emit, _) = collector();
    let n = Arc::new(Mutex::new(0u32));
    let n2 = n.clone();
    let task: TaskFn = Arc::new(move |_id, _s, _c, _sink| {
        let mut k = n2.lock().unwrap();
        *k += 1;
        match *k {
            1 => Err("helper: the hands pack is not installed".to_string()),
            2 => Ok(outcome(StopReason::CostCap, 3)),
            _ => {
                drop(k);
                panic!("the task crashed")
            }
        }
    });
    let runs = Runs::new(&dir("errors"), emit, task);
    for _ in 0..3 {
        assert_eq!(start(&runs, "go")["ok"], true);
        assert!(idle(&runs, Duration::from_secs(2)), "the slot must free after any ending");
        std::thread::sleep(Duration::from_millis(3));
    }
    let list = rows(&runs);
    let by = |status: &str| list.iter().filter(|r| r["status"] == status).count();
    assert_eq!((by("error"), by("stopped")), (2, 1), "{list:?}");
    let cap = list.iter().find(|r| r["status"] == "stopped").unwrap();
    assert_eq!(cap["reason"], "cost_cap");
    assert!(list.iter().any(|r| r["status"] == "error" && r["reason"].as_str().unwrap().contains("hands pack")));
    assert!(list.iter().any(|r| r["status"] == "error" && r["reason"] == "task_panicked"));
}

#[test]
fn the_activity_panel_reads_the_audit_lines_written_during_the_run_and_none_from_before() {
    let data = dir("activity");
    let audit_file = data.join("audit").join("agent").join(format!("{}.jsonl", local_date()));
    // A line from earlier work, before any run.
    let old = zumi_audit::Audit::open(&audit_file).unwrap();
    old.record(&zumi_audit::Entry { verb: "tool:note.save", pid: None, exe: None, hwnd: None, code: None, detail: "{\"step\":1,\"task\":\"chat-old\"}" }).unwrap();
    std::thread::sleep(Duration::from_millis(5));
    let f2 = audit_file.clone();
    let task: TaskFn = Arc::new(move |_id, _s, _c, _sink| {
        let a = zumi_audit::Audit::open(&f2).unwrap();
        a.record(&zumi_audit::Entry { verb: "tool:hands.launch", pid: None, exe: None, hwnd: None, code: None, detail: "{\"step\":1,\"task\":\"t\"}" }).unwrap();
        a.record(&zumi_audit::Entry { verb: "tool_result:hands.launch", pid: None, exe: None, hwnd: None, code: None, detail: "{\"step\":1,\"task\":\"t\"}" }).unwrap();
        a.record(&zumi_audit::Entry { verb: "tool:hands.type", pid: None, exe: None, hwnd: None, code: Some("not_foreground"), detail: "{\"step\":2,\"task\":\"t\"}" }).unwrap();
        Ok(outcome(StopReason::Done, 2))
    });
    let (emit, _) = collector();
    let runs = Runs::new(&data, emit, task);
    let id = start(&runs, "launch it")["id"].as_str().unwrap().to_string();
    assert!(idle(&runs, Duration::from_secs(2)));
    let st = runs.serve("agent.status", &[json!(id)]).unwrap();
    let act = st["activity"].as_array().unwrap();
    assert_eq!(act.len(), 3, "only this run's lines: {act:?}");
    assert_eq!(act[0]["kind"], "tool");
    assert_eq!(act[0]["name"], "hands.launch");
    assert_eq!(act[1]["kind"], "result");
    assert_eq!((act[2]["decision"].clone(), act[2]["code"].clone(), act[2]["step"].clone()), (json!("refused"), json!("not_foreground"), json!(2)));
    assert!(!act.iter().any(|a| a["name"] == "note.save"), "the earlier line is not shown");
    assert_eq!(st["selected"], id.as_str());
    // A run id nobody knows reads no activity (it does not fall back to someone else's).
    let none = runs.serve("agent.status", &[json!("chat-nope")]).unwrap();
    assert_eq!(none["activity"].as_array().unwrap().len(), 0);
}

#[test]
fn a_frame_file_of_the_run_shows_in_status_and_a_big_or_foreign_file_does_not() {
    let data = dir("frame");
    let d2 = data.clone();
    let task: TaskFn = Arc::new(move |id, _s, _c, _sink| {
        let frames = d2.join("agent").join("control").join(id).join("frames");
        std::fs::create_dir_all(&frames).unwrap();
        std::fs::write(frames.join("a.png"), [0x89, b'P', b'N', b'G', 1, 2, 3]).unwrap();
        std::fs::write(frames.join("big.png"), vec![0u8; 700 * 1024]).unwrap();
        std::fs::write(frames.join("note.txt"), "not an image").unwrap();
        Ok(outcome(StopReason::Done, 1))
    });
    let (emit, _) = collector();
    let runs = Runs::new(&data, emit, task);
    let id = start(&runs, "show a frame")["id"].as_str().unwrap().to_string();
    assert!(idle(&runs, Duration::from_secs(2)));
    let st = runs.serve("agent.status", &[json!(id)]).unwrap();
    assert_eq!(st["frame"]["name"], "a.png", "{}", st["frame"]);
    assert!(st["frame"]["dataUrl"].as_str().unwrap().starts_with("data:image/png;base64,"));
    let other = runs.serve("agent.status", &[json!("chat-nope")]).unwrap();
    assert!(other["frame"].is_null());
}

#[test]
fn a_confirm_is_answered_once_by_its_own_id_and_unanswered_or_cancelled_means_no() {
    let (emit, seen) = collector();
    let runs = Runs::new(&dir("confirm"), emit, fake(vec![], StopReason::Done));
    // Answered yes.
    let r2 = runs.clone();
    let asker = std::thread::spawn(move || r2.ask_confirm("Delete the file?", Duration::from_secs(5), &Cancel::new()));
    let t = Instant::now();
    let pending = loop {
        let c = runs.serve("agent.status", &[]).unwrap()["confirm"].clone();
        if !c.is_null() {
            break c;
        }
        assert!(t.elapsed() < Duration::from_secs(3), "the confirm never appeared in status");
        std::thread::sleep(Duration::from_millis(2));
    };
    assert_eq!(pending["text"], "Delete the file?");
    let cid = pending["id"].as_str().unwrap().to_string();
    assert!(seen.lock().unwrap().iter().any(|e| e["ev"] == "confirm" && e["id"] == cid.as_str()), "the chat was told");
    let wrong = runs.serve("agent.confirm", &[json!("c-other"), json!(true)]).unwrap();
    assert_eq!((wrong["ok"].clone(), wrong["error"].clone()), (json!(false), json!("no_pending")), "a stale or foreign id answers nothing");
    assert_eq!(runs.serve("agent.confirm", &[json!(cid), json!(true)]).unwrap()["ok"], true);
    assert!(asker.join().unwrap(), "yes reached the asker");
    assert!(runs.serve("agent.status", &[]).unwrap()["confirm"].is_null(), "cleared once answered");
    assert_eq!(runs.serve("agent.confirm", &[json!(cid), json!(true)]).unwrap()["error"], "no_pending", "answering twice does nothing");
    // Answered no.
    let r3 = runs.clone();
    let asker = std::thread::spawn(move || r3.ask_confirm("Again?", Duration::from_secs(5), &Cancel::new()));
    let t = Instant::now();
    let id2 = loop {
        let c = runs.serve("agent.status", &[]).unwrap()["confirm"].clone();
        if let Some(i) = c["id"].as_str() {
            break i.to_string();
        }
        assert!(t.elapsed() < Duration::from_secs(3));
        std::thread::sleep(Duration::from_millis(2));
    };
    runs.serve("agent.confirm", &[json!(id2), json!(false)]).unwrap();
    assert!(!asker.join().unwrap());
    // Nobody answers: no, after the wait. A cancelled task: no, at once.
    assert!(!runs.ask_confirm("Nobody?", Duration::from_millis(60), &Cancel::new()));
    let c = Cancel::new();
    c.set("user");
    let t = Instant::now();
    assert!(!runs.ask_confirm("Cancelled?", Duration::from_secs(5), &c));
    assert!(t.elapsed() < Duration::from_millis(100));
    assert!(runs.serve("agent.status", &[]).unwrap()["confirm"].is_null());
}

#[test]
fn serve_answers_only_its_four_names_and_refuses_bad_arguments() {
    let (emit, _) = collector();
    let runs = Runs::new(&dir("serve"), emit, fake(vec![], StopReason::Done));
    for m in ["agent.start", "agent.stop", "agent.status", "agent.confirm"] {
        assert!(is_method(m), "{m}");
    }
    for m in ["agent.run", "agent.", "agents.start", "routines.list", "talk.turn", "hands.click", ""] {
        assert!(!is_method(m), "{m}");
    }
    assert!(runs.serve("agent.run", &[]).is_err());
    for args in [vec![], vec![json!(7)], vec![json!({ "sentence": "x" })], vec![json!(null)]] {
        let r = runs.serve("agent.start", &args).unwrap();
        assert_eq!((r["ok"].clone(), r["error"].clone()), (json!(false), json!("bad_args")), "{args:?}");
    }
    for args in [vec![], vec![json!("c-1")], vec![json!("c-1"), json!("yes")], vec![json!(1), json!(true)]] {
        let r = runs.serve("agent.confirm", &args).unwrap();
        assert_eq!(r["error"], "bad_args", "{args:?}");
    }
}

// ---- H5-H8 (GATE-OPUS-R2 should-fixes) ----

fn pending_confirm(runs: &Runs) -> Value {
    let t = Instant::now();
    loop {
        let c = runs.serve("agent.status", &[]).unwrap()["confirm"].clone();
        if !c.is_null() {
            return c;
        }
        assert!(t.elapsed() < Duration::from_secs(3), "the confirm never appeared in status");
        std::thread::sleep(Duration::from_millis(2));
    }
}
fn ask_in_thread(runs: &Runs, text: &'static str) -> std::thread::JoinHandle<bool> {
    let r = runs.clone();
    std::thread::spawn(move || r.ask_confirm(text, Duration::from_secs(2), &Cancel::new()))
}
fn all_ok(v: &Value) -> bool {
    v["ok"] == true
}

#[test]
fn h5_a_confirm_id_is_random_and_not_derivable_from_the_clock_or_a_counter() {
    let (emit, _seen) = collector();
    let runs = Runs::new(&dir("cid-random"), emit, fake(vec![], StopReason::Done));
    let mut ids = Vec::new();
    for _ in 0..3 {
        let asker = ask_in_thread(&runs, "ok?");
        let id = pending_confirm(&runs)["id"].as_str().unwrap().to_string();
        runs.serve("agent.confirm", &[json!(id), json!(false)]).unwrap();
        asker.join().unwrap();
        ids.push(id);
    }
    for id in &ids {
        let hex = id.strip_prefix("c-").unwrap_or("");
        assert_eq!(hex.len(), 32, "{id}: c- and 128 random bits as hex");
        assert!(hex.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)), "{id}");
    }
    let mut sorted = ids.clone();
    sorted.sort();
    sorted.dedup();
    assert_eq!(sorted.len(), 3, "three questions, three different ids: {ids:?}");
}

#[test]
fn h5_a_confirm_asked_outside_a_run_cannot_be_answered_from_inside_another_run() {
    let (emit, _seen) = collector();
    let task: TaskFn = Arc::new(|_id, _s, cancel, _sink| {
        while !cancel.is_set() {
            std::thread::sleep(Duration::from_millis(2));
        }
        Ok(outcome(StopReason::Done, 1))
    });
    let runs = Runs::new(&dir("cid-bound"), emit, task);
    let asker = ask_in_thread(&runs, "outside any run?");
    let id = pending_confirm(&runs)["id"].as_str().unwrap().to_string();
    let run = start(&runs, "a run that started after the question");
    assert!(all_ok(&run), "{run}");
    let answer = runs.serve("agent.confirm", &[json!(id), json!(true)]).unwrap();
    assert_eq!(answer["error"], "no_pending", "{answer}: the answer must come in the run that asked");
    runs.serve("agent.stop", &[]).unwrap();
    assert!(!asker.join().unwrap(), "never answered: a no");
}

#[test]
fn h5_twin_the_run_that_asked_can_be_answered_once_and_a_replay_is_refused() {
    let (emit, _seen) = collector();
    let r_cell: Arc<Mutex<Option<Runs>>> = Arc::new(Mutex::new(None));
    let got: Arc<Mutex<Option<bool>>> = Arc::new(Mutex::new(None));
    let (rc, g2) = (r_cell.clone(), got.clone());
    let task: TaskFn = Arc::new(move |_id, _s, cancel, _sink| {
        let runs = rc.lock().unwrap().clone().unwrap();
        *g2.lock().unwrap() = Some(runs.ask_confirm("inside the run?", Duration::from_secs(3), &cancel));
        Ok(outcome(StopReason::Done, 1))
    });
    let runs = Runs::new(&dir("cid-twin"), emit, task);
    *r_cell.lock().unwrap() = Some(runs.clone());
    assert!(all_ok(&start(&runs, "ask me")));
    let id = pending_confirm(&runs)["id"].as_str().unwrap().to_string();
    assert_eq!(runs.serve("agent.confirm", &[json!(id), json!(true)]).unwrap()["ok"], true);
    assert!(idle(&runs, Duration::from_secs(3)));
    assert_eq!(*got.lock().unwrap(), Some(true), "the run saw the yes");
    assert_eq!(runs.serve("agent.confirm", &[json!(id), json!(true)]).unwrap()["error"], "no_pending", "single use");
}

#[test]
fn h6_a_secret_typed_into_the_chat_is_masked_in_the_run_list_and_in_runs_jsonl_and_an_ordinary_sentence_is_not() {
    let (emit, _seen) = collector();
    let d = dir("redact");
    let runs = Runs::new(&d, emit, fake(vec![], StopReason::Done));
    let key = "sk-proj-AbCdEf0123456789xyzXYZ";
    let ghp = "ghp_0123456789abcdefghijABCDEFGHIJ";
    for s in [
        format!("dung key {key} de mo notepad"),
        format!("token={ghp} roi mo notepad"),
        "Authorization: Bearer abcdefghijklmnop1234 mo notepad".to_string(),
        "dat PASSWORD=hunter2hunter2 vao may".to_string(),
        "mở Notepad, gõ 'xin chào Zumi', lưu vào D:/x/out.txt".to_string(),
    ] {
        assert!(all_ok(&start(&runs, &s)), "{s}");
        assert!(idle(&runs, Duration::from_secs(3)));
    }
    let list = rows(&runs);
    let text = list.iter().map(|r| r["sentence"].as_str().unwrap().to_string()).collect::<Vec<_>>().join("\n");
    let file = std::fs::read_to_string(d.join("agent").join("runs.jsonl")).unwrap();
    for secret in [key, ghp, "abcdefghijklmnop1234", "hunter2hunter2"] {
        assert!(!text.contains(secret), "run list still shows {secret}: {text}");
        assert!(!file.contains(secret), "runs.jsonl still holds {secret}");
    }
    assert!(text.contains("«redacted"), "the shape is kept so the row still reads: {text}");
    assert!(text.contains("mở Notepad, gõ 'xin chào Zumi', lưu vào D:/x/out.txt"), "an ordinary sentence is untouched: {text}");
}

#[test]
fn h8_a_stop_that_ends_the_task_before_the_loop_starts_is_a_stop_not_an_error() {
    let (emit, _seen) = collector();
    let d = dir("prefetch-stop");
    // What the host's task does while `talk.status` is pending: it waits on the cancel token and gives up with an error.
    let task: TaskFn = Arc::new(|_id, _s, cancel, _sink| {
        while !cancel.is_set() {
            std::thread::sleep(Duration::from_millis(2));
        }
        Err("cancelled: stopped before the loop started".to_string())
    });
    let runs = Runs::new(&d, emit, task);
    assert!(all_ok(&start(&runs, "open notepad")));
    let t = Instant::now();
    runs.serve("agent.stop", &[]).unwrap();
    assert!(idle(&runs, Duration::from_secs(2)));
    assert!(t.elapsed() < Duration::from_millis(500));
    let row = rows(&runs)[0].clone();
    assert_eq!((row["status"].clone(), row["reason"].clone()), (json!("stopped"), json!("user")), "{row}");
}
