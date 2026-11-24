//! R6 keep-awake through the real run registry: the PC is held while a run is active and given back when it ends, whichever way it ends
//! (done, error, panic, the user's stop), BEFORE the chat is told the run ended. The OS call is a recorder.
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use zumi_agent_loop::cancel::Cancel;
use zumi_agent_loop::loop_run::{Outcome, StopReason};
use zumi_agent_loop::runs::{Runs, TaskFn};
use zumi_audit::keepawake::{KeepAwake, Sleep};

#[derive(Clone, Default)]
struct Rec(Arc<Mutex<Vec<bool>>>);
impl Sleep for Rec {
    fn hold(&self, on: bool) -> bool {
        self.0.lock().unwrap().push(on);
        true
    }
}

fn data(name: &str) -> std::path::PathBuf {
    let d = std::path::PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("keep-awake-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn done() -> Outcome {
    Outcome { stop: StopReason::Done, steps: 1, final_text: "ok".into(), messages: vec![] }
}

/// Runs one sentence and returns (holders seen inside the task, holders seen at the `run_end` event, the recorder's calls).
fn one(name: &str, task: impl Fn(&str, &str, Cancel, &mut dyn FnMut(Value)) -> Result<Outcome, String> + Send + Sync + 'static, stop_it: bool) -> (usize, usize, Vec<bool>) {
    let rec = Rec::default();
    let keep = KeepAwake::new(Box::new(rec.clone()));
    let inside = Arc::new(Mutex::new(usize::MAX));
    let at_end = Arc::new(Mutex::new(usize::MAX));
    let ended = Arc::new(AtomicBool::new(false));
    let (k_emit, at_end2, ended2) = (keep.clone(), at_end.clone(), ended.clone());
    let emit: Arc<dyn Fn(Value) + Send + Sync> = Arc::new(move |v: Value| {
        if v["ev"] == "run_end" {
            *at_end2.lock().unwrap() = k_emit.holders();
            ended2.store(true, Ordering::SeqCst);
        }
    });
    let (k_task, inside2) = (keep.clone(), inside.clone());
    let task: TaskFn = Arc::new(move |id, s, c, sink| {
        *inside2.lock().unwrap() = k_task.holders();
        task(id, s, c, sink)
    });
    let runs = Runs::new_with(&data(name), emit, task, keep.clone());
    assert_eq!(runs.serve("agent.start", &[json!("say hello")]).unwrap()["ok"], true);
    if stop_it {
        std::thread::sleep(Duration::from_millis(100));
        runs.serve("agent.stop", &[]).unwrap();
    }
    let t0 = Instant::now();
    while !ended.load(Ordering::SeqCst) && t0.elapsed() < Duration::from_secs(10) {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(ended.load(Ordering::SeqCst), "the run ended");
    let (i, e) = (*inside.lock().unwrap(), *at_end.lock().unwrap());
    let calls = rec.0.lock().unwrap().clone();
    (i, e, calls)
}

#[test]
fn a_run_holds_the_pc_while_it_is_active_and_gives_it_back_before_the_chat_hears_it_ended() {
    let (inside, at_end, calls) = one("done", |_, _, _, _| Ok(done()), false);
    assert_eq!((inside, at_end, calls), (1, 0, vec![true, false]));
}

#[test]
fn a_run_that_fails_panics_or_is_stopped_also_gives_it_back() {
    let (inside, at_end, calls) = one("err", |_, _, _, _| Err("boom".into()), false);
    assert_eq!((inside, at_end, calls), (1, 0, vec![true, false]), "an error");
    let (inside, at_end, calls) = one("panic", |_, _, _, _| panic!("the task blew up"), false);
    assert_eq!((inside, at_end, calls), (1, 0, vec![true, false]), "a panic");
    let (inside, at_end, calls) = one(
        "stop",
        |_, _, cancel, _| {
            while !cancel.is_set() {
                std::thread::sleep(Duration::from_millis(5));
            }
            Ok(Outcome { stop: StopReason::Cancelled("user".into()), steps: 0, final_text: String::new(), messages: vec![] })
        },
        true,
    );
    assert_eq!((inside, at_end, calls), (1, 0, vec![true, false]), "the user's stop");
}
