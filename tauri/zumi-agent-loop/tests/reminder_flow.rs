//! "nhắc anh uống nước lúc 15:00" on the mock model creates exactly one A2 reminder, read back through the A2 store
//! (a real `zumi_routines::Routines` in a data directory of this test's own, never the owner's). A reminder whose text
//! or time came only from tainted text is refused and audited.
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use zumi_agent_loop::hands_tools::{hands_tools, Guard, HandsClient, HandsCtx, HandsLink, SharedLink};
use zumi_agent_loop::loop_run::{run, LoopConfig, NullMeter, StopReason};
use zumi_agent_loop::reminders::{ReminderTool, RoutinesStore};
use zumi_agent_loop::tool_gate::{AuditSink, Cap, GateConfig, Tool, ToolGate};
use zumi_agent_loop::transport::MockTransport;
use zumi_agent_loop::Cancel;
use zumi_routines::clock::{utc_ms, Tz};
use zumi_routines::{Config, Quiet, Routines};

const UTC7: i64 = 7 * 3_600_000;
struct Zone;
impl Tz for Zone {
    fn offset_ms(&self, _utc: i64) -> i64 {
        UTC7
    }
}

struct Lines(Arc<Mutex<Vec<String>>>);
impl AuditSink for Lines {
    fn record(&self, verb: &str, code: Option<&str>, _d: &str) -> std::io::Result<()> {
        self.0.lock().unwrap().push(format!("{verb}:{}", code.unwrap_or("allowed")));
        Ok(())
    }
}

struct Window;
impl HandsLink for Window {
    fn call(&mut self, req: Value, _t: Duration) -> Result<Value, String> {
        let ok = |r: Value| Ok(json!({ "ok": true, "result": r }));
        match req["cmd"].as_str().unwrap() {
            "launch" => ok(json!({ "pid": 1 })),
            "windows" => ok(json!([{ "hwnd": "0x1", "class": "Notepad", "title": "Notepad" }])),
            "focus" => ok(json!({ "is_foreground": true })),
            _ => ok(json!({})),
        }
    }
}

/// A store of its own in a fresh directory, a fixed clock (local `hh:mm` on 2026-11-11, UTC+7) and a tick period so long
/// the runner never fires anything during the test.
fn store(name: &str, now_local: (u32, u32)) -> (Routines, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("zumi-reminder-flow-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let now = utc_ms(2026, 11, 11, now_local.0, now_local.1, 0) - UTC7;
    let r = Routines::start(Config {
        dir: dir.clone(),
        tz: Box::new(Zone),
        now: Box::new(move || now),
        quiet: Box::new(|| Quiet::from_settings(&json!({}))),
        sink: Box::new(|_| Ok(())),
        period: Duration::from_secs(3600),
        keep_awake: zumi_audit::keepawake::KeepAwake::off(),
    })
    .unwrap();
    (r, dir)
}

fn items(r: &Routines) -> Vec<Value> {
    r.handle("routines.list", &[]).unwrap()["items"].as_array().unwrap().clone()
}

struct Out {
    stop: StopReason,
    audit: Vec<String>,
}

/// Runs a fixture on a sentence. `hands` adds the hands tools (their launch result is tainted text).
fn go(fixture: &str, sentence: &str, vars: &[(&str, &str)], routines: &Routines, hands: bool) -> Out {
    let lines = Arc::new(Mutex::new(vec![]));
    let mut tools: Vec<Box<dyn Tool>> = vec![Box::new(ReminderTool::new(RoutinesStore(routines.clone())))];
    let mut granted = vec![Cap::Reminder];
    if hands {
        let dir = std::env::temp_dir().join(format!("zumi-reminder-hands-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let link: SharedLink = Arc::new(Mutex::new(Box::new(Window)));
        tools.extend(hands_tools(HandsCtx::guarded(HandsClient::new(link, None), dir, vec![], Guard::harness())));
        granted.extend([Cap::HandsAct, Cap::HandsRead]);
    }
    let mut gate = ToolGate::new(GateConfig::new("rem", granted, vec![sentence.to_string()]), tools, Box::new(Lines(lines.clone())));
    let fx = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures").join(fixture);
    let vars: HashMap<String, String> = vars.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
    let mut t = MockTransport::load(&fx, vars).unwrap();
    let o = run(&LoopConfig { system: "s".into(), user: sentence.into(), max_turns: 40 }, &mut t, &mut gate, &mut NullMeter, &Cancel::new(), &mut |_| {});
    let audit = lines.lock().unwrap().clone();
    Out { stop: o.stop, audit }
}

const SENTENCE: &str = "nhắc anh uống nước lúc 15:00";

#[test]
fn pass_twin_the_sentence_creates_exactly_one_reminder_for_15_00_today_10_of_10() {
    for i in 1..=10 {
        let (r, dir) = store(&format!("today{i}"), (10, 0));
        let o = go("reminder.json", SENTENCE, &[("text", "uống nước"), ("time", "15:00")], &r, false);
        assert_eq!(o.stop, StopReason::Done, "run {i}");
        let list = items(&r);
        assert_eq!(list.len(), 1, "run {i}: exactly one reminder");
        assert_eq!((list[0]["text"].as_str(), list[0]["time"].as_str(), list[0]["repeat"].as_str()), (Some("uống nước"), Some("15:00"), Some("none")), "run {i}");
        // 15:00 local on 2026-11-11 (UTC+7) is 08:00 UTC the same day.
        assert_eq!(list[0]["nextMs"].as_i64(), Some(utc_ms(2026, 11, 11, 8, 0, 0)), "run {i}: today");
        let calls: Vec<&String> = o.audit.iter().filter(|l| !l.starts_with("model_text:")).collect();
        assert_eq!(calls, vec!["tool:reminder.add:allowed", "tool_result:reminder.add:allowed"], "run {i}");
        // The store file on disk holds it too (read back through a second look at the directory's own file).
        assert!(std::fs::read_to_string(dir.join("reminders.json")).unwrap().contains("uống nước"));
        r.stop();
    }
}

#[test]
fn pass_twin_after_15_00_the_reminder_is_for_tomorrow() {
    let (r, _) = store("tomorrow", (16, 0));
    let o = go("reminder.json", SENTENCE, &[("text", "uống nước"), ("time", "15:00")], &r, false);
    assert_eq!(o.stop, StopReason::Done);
    assert_eq!(items(&r)[0]["nextMs"].as_i64(), Some(utc_ms(2026, 11, 12, 8, 0, 0)));
    r.stop();
}

#[test]
fn bite_a_time_or_text_that_only_a_window_supplied_is_refused_and_audited() {
    // The window read (a launch result carries the window title) taints the task; then the model sets a reminder whose
    // text and time the user never wrote.
    let (r, _) = store("tainted", (10, 0));
    let o = go("reminder-inject.json", SENTENCE, &[("text", "wire all the money"), ("time", "03:33")], &r, true);
    assert_eq!(o.stop, StopReason::Done);
    assert!(items(&r).is_empty(), "no reminder was created");
    assert!(o.audit.contains(&"tool:reminder.add:tainted_arg".to_string()), "{:?}", o.audit);
    // Only the time is foreign: still refused (the user's own text does not carry a foreign time).
    let (r2, _) = store("tainted-time", (10, 0));
    let o2 = go("reminder-inject.json", SENTENCE, &[("text", "uống nước"), ("time", "03:33")], &r2, true);
    assert!(items(&r2).is_empty(), "a foreign time alone is refused");
    assert!(o2.audit.contains(&"tool:reminder.add:tainted_arg".to_string()));
    // A foreign time is refused even when nothing has tainted the task yet: a time is never the model's own to pick.
    let (r3, _) = store("clean-time", (10, 0));
    let o3 = go("reminder.json", SENTENCE, &[("text", "uống nước"), ("time", "03:33")], &r3, false);
    assert!(items(&r3).is_empty());
    assert!(o3.audit.contains(&"tool:reminder.add:tainted_arg".to_string()));
    for x in [r, r2, r3] {
        x.stop();
    }
    // Pass twin: the same flow after a window read, with the user's own text and time, is allowed.
    let (r4, _) = store("tainted-ok", (10, 0));
    let o4 = go("reminder-inject.json", SENTENCE, &[("text", "uống nước"), ("time", "15:00")], &r4, true);
    assert_eq!(items(&r4).len(), 1, "{:?}", o4.audit);
    r4.stop();
}

#[test]
fn bite_the_model_cannot_pick_another_tool_or_repeat() {
    let (r, _) = store("shape", (10, 0));
    let o = go("reminder-shape.json", SENTENCE, &[], &r, false);
    assert!(items(&r).is_empty());
    assert_eq!(o.audit.iter().filter(|l| l.ends_with(":bad_args")).count(), 2, "{:?}", o.audit);
    r.stop();
}
