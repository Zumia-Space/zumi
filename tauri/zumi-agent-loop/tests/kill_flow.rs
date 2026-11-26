//! The kill during the loop: the helper's kill state reaches the loop through the kill watch, the loop stops, and no
//! tool runs after it. The live hotkey runs (real helper, real Ctrl+Alt+Pause) are scripts/maus-p3-goals.mjs.
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use zumi_agent_loop::hands_tools::{hands_tools, Guard, HandsClient, HandsCtx, HandsLink, KillWatch, SharedLink};
use zumi_agent_loop::loop_run::{run, LoopConfig, NullMeter, StopReason};
use zumi_agent_loop::tool_gate::{AuditSink, Cap, GateConfig, Tool, ToolGate};
use zumi_agent_loop::transport::MockTransport;
use zumi_agent_loop::Cancel;

/// A helper that is killed when `killed` is set: `status` says so and every acting verb after that is `killed`.
struct Helper {
    killed: Arc<AtomicBool>,
}
impl HandsLink for Helper {
    fn call(&mut self, req: Value, _t: Duration) -> Result<Value, String> {
        let ok = |r: Value| Ok(json!({ "ok": true, "result": r }));
        let cmd = req["cmd"].as_str().unwrap().to_string();
        if cmd == "status" {
            return ok(json!({ "killed": self.killed.load(Ordering::SeqCst) }));
        }
        let dead = self.killed.load(Ordering::SeqCst);
        if dead && matches!(cmd.as_str(), "type" | "key" | "focus" | "launch") {
            return Ok(json!({ "ok": false, "error": "killed", "detail": "the stop hotkey was pressed" }));
        }
        match cmd.as_str() {
            "launch" => ok(json!({ "pid": 7 })),
            "windows" => ok(json!([{ "hwnd": "0x2", "class": "Notepad", "title": "t - Notepad" }])),
            "focus" => ok(json!({ "is_foreground": true })),
            "type" => {
                // A long typing run. Like the real helper (P2: the gate is checked before every key, stop in 15-45 ms),
                // it ends the moment the kill is set.
                for _ in 0..80 {
                    std::thread::sleep(Duration::from_millis(5));
                    if self.killed.load(Ordering::SeqCst) {
                        return Ok(json!({ "ok": false, "error": "killed", "detail": "stopped mid-text" }));
                    }
                }
                ok(json!({}))
            }
            _ => ok(json!({})),
        }
    }
}
struct Null;
impl AuditSink for Null {
    fn record(&self, _v: &str, _c: Option<&str>, _d: &str) -> std::io::Result<()> {
        Ok(())
    }
}

/// Runs the goal fixture; at `kill_after` the helper is killed (None: never). Returns (stop, ms from the kill to the
/// loop's end).
fn goal(kill_after: Option<Duration>) -> (StopReason, Option<u128>) {
    let dir = std::env::temp_dir().join(format!("zumi-kill-flow-{}-{}", std::process::id(), kill_after.map_or(0, |d| d.as_millis())));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("p3-out.txt").to_string_lossy().replace('\\', "/");
    let sentence = format!("open notepad, type 'xin chao Zumi', save to {file}");
    let killed = Arc::new(AtomicBool::new(false));
    let link: SharedLink = Arc::new(Mutex::new(Box::new(Helper { killed: killed.clone() })));
    let ctx = HandsCtx::guarded(HandsClient::new(link.clone(), None), dir, zumi_agent_loop::hands_setup::extract_paths(&sentence), Guard::harness());
    let tools: Vec<Box<dyn Tool>> = hands_tools(ctx);
    let mut gate = ToolGate::new(GateConfig::new("kill", vec![Cap::HandsAct, Cap::HandsRead], vec![sentence.clone()]), tools, Box::new(Null));
    let fx = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/goal-notepad.json");
    let mut t = MockTransport::load(&fx, HashMap::from([("path".to_string(), file), ("text".to_string(), "xin chao Zumi".to_string())])).unwrap();
    let cancel = Cancel::new();
    let _watch = KillWatch::start(HandsClient::new(link, None), cancel.clone());
    let killed_at = Arc::new(Mutex::new(None::<Instant>));
    if let Some(d) = kill_after {
        let (k, at) = (killed.clone(), killed_at.clone());
        std::thread::spawn(move || {
            std::thread::sleep(d);
            *at.lock().unwrap() = Some(Instant::now());
            k.store(true, Ordering::SeqCst);
        });
    }
    let o = run(&LoopConfig { system: "s".into(), user: sentence, max_turns: 40 }, &mut t, &mut gate, &mut NullMeter, &cancel, &mut |_| {});
    let ms = killed_at.lock().unwrap().map(|k| k.elapsed().as_millis());
    (o.stop, ms)
}

#[test]
fn pass_twin_without_a_kill_the_task_finishes() {
    let (stop, ms) = goal(None);
    assert_eq!(stop, StopReason::Done);
    assert!(ms.is_none());
}

#[test]
fn bite_a_kill_anywhere_in_the_task_stops_the_loop_within_200_ms() {
    // Turn latencies are 150 ms; the launch call takes about 0.7 s; the typing call 400 ms. These cut the task in a
    // model turn, in the launch, in the typing call and in the last turn.
    for kill_ms in [60, 300, 900, 1300, 1500] {
        let (stop, since_kill) = goal(Some(Duration::from_millis(kill_ms)));
        assert_eq!(stop, StopReason::Killed, "kill at {kill_ms} ms");
        let since = since_kill.unwrap();
        assert!(since <= 200, "kill at {kill_ms} ms: the loop ended {since} ms after it");
    }
}
