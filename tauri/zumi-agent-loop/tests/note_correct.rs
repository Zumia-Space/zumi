//! R6c C item 4: the chat route to correct ONE note. The sentence "that is wrong, it is Monday now" reaches the sidecar's `__host.memoryCorrect`
//! through the gate as `note.correct` (match = a few words that name the note, text = the corrected note). The same edit the Memory tab
//! makes, so both routes give one result. The loop has no tool that removes or rewrites more than one note.
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use zumi_agent_loop::cancel::Cancel;
use zumi_agent_loop::loop_run::{NullMeter, Outcome, StopReason};
use zumi_agent_loop::runner::{run_task_with, ModelSource, TaskExtras, TaskOpts};
use zumi_agent_loop::transport::{RpcCall, TransportError};

type Calls = Arc<Mutex<Vec<(String, Value)>>>;

/// Records every call and answers with `reply` (None = the sidecar cannot be reached).
struct Rec(Calls, Option<Value>);
impl RpcCall for Rec {
    fn call(&mut self, method: &str, params: Value, _c: &Cancel) -> Result<Value, TransportError> {
        self.0.lock().unwrap().push((method.to_string(), params));
        self.1.clone().ok_or_else(|| TransportError::Failed("sidecar".into(), "down".into()))
    }
}

fn root(name: &str) -> PathBuf {
    let r = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("note-correct-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&r);
    std::fs::create_dir_all(r.join("audit")).unwrap();
    r
}

/// One task: the model calls `tool` with `args`, then answers. Returns the outcome, the audit text and the rpc calls.
fn run(name: &str, sentence: &str, tool: &str, args: Value, reply: Option<Value>) -> (Outcome, String, Vec<(String, Value)>, Vec<Value>) {
    let r = root(name);
    let fixture = r.join("f.json");
    std::fs::write(
        &fixture,
        json!({ "name": "f", "model": "mock/loop-v1", "turns": [
            { "text": "Looking.", "tool_calls": [{ "name": tool, "args": args }], "usage": { "in": 100, "out": 10 } },
            { "text": "Done.", "usage": { "in": 120, "out": 4 } }
        ] })
        .to_string(),
    )
    .unwrap();
    let calls: Calls = Arc::default();
    let opts = TaskOpts {
        task_id: format!("t-{name}"),
        sentence: sentence.into(),
        model: ModelSource::Mock { fixture, vars: Default::default() },
        hands: None,
        notes: Some(Box::new(Rec(calls.clone(), reply))),
        reminders: None,
        loop_audit: r.join("audit").join("a.jsonl"),
        prior_usd: Ok(0.0),
        max_total_usd: None,
        cancel: Cancel::new(),
    };
    let mut events = Vec::new();
    let out = run_task_with(opts, TaskExtras::default(), &mut NullMeter, &mut |e| events.push(e)).expect("the task ran");
    let audit = std::fs::read_to_string(r.join("audit").join("a.jsonl")).unwrap_or_default();
    let seen = calls.lock().unwrap().clone();
    (out, audit, seen, events)
}

#[test]
fn a_correction_reaches_memory_correct_with_the_words_and_the_new_text() {
    let reply = json!({ "ok": true, "item": { "id": 7, "kind": "note", "text": "Dentist on Monday" }, "previous": "Dentist on Friday" });
    let (out, audit, calls, events) = run("ok", "The dentist note is wrong, it is Monday now", "note.correct", json!({ "match": "dentist", "text": "Dentist on Monday" }), Some(reply));
    assert_eq!(out.stop, StopReason::Done);
    assert_eq!(calls, vec![("__host.memoryCorrect".to_string(), json!(["dentist", "Dentist on Monday"]))]);
    assert!(audit.contains("note.correct"), "the gate audited the call: {audit}");
    let end = events.iter().find(|e| e["ev"] == "tool_end" && e["name"] == "note.correct").expect("a tool_end event");
    assert_eq!(end["ok"], true);
}

#[test]
fn bite_the_model_sees_what_changed_so_it_can_confirm_in_one_sentence() {
    let reply = json!({ "ok": true, "item": { "id": 7, "kind": "note", "text": "Dentist on Monday" }, "previous": "Dentist on Friday" });
    let (out, _audit, _calls, _events) = run("seen", "The dentist note is wrong, it is Monday now", "note.correct", json!({ "match": "dentist", "text": "Dentist on Monday" }), Some(reply));
    let tool_msg = out.messages.iter().find(|m| m["role"] == "tool").expect("the tool result went back to the model");
    let body = tool_msg["content"].as_str().unwrap();
    assert!(body.contains("Dentist on Friday") && body.contains("Dentist on Monday") && body.contains("corrected"), "{body}");
}

#[test]
fn several_matching_notes_change_nothing_and_the_model_is_given_the_candidates_to_ask_which() {
    let reply = json!({ "ok": false, "error": "ambiguous", "candidates": [{ "id": 1, "text": "Dentist on Friday" }, { "id": 2, "text": "Dentist phone number" }] });
    let (out, _audit, calls, events) = run("ambiguous", "The dentist note is wrong", "note.correct", json!({ "match": "dentist", "text": "Dentist on Monday" }), Some(reply));
    assert_eq!(out.stop, StopReason::Done, "the model answers, it is not a stop");
    assert_eq!(calls.len(), 1, "one call, no retry loop");
    let end = events.iter().find(|e| e["ev"] == "tool_end" && e["name"] == "note.correct").unwrap();
    assert_eq!(end["ok"], false);
    assert_eq!(end["error"], "note_ambiguous");
    let tool_msg = out.messages.iter().find(|m| m["role"] == "tool").unwrap();
    let body = tool_msg["content"].as_str().unwrap();
    assert!(body.contains("Dentist on Friday") && body.contains("Dentist phone number"), "the model can ask which one: {body}");
}

#[test]
fn no_matching_note_is_an_error_the_model_can_say_in_words() {
    let (_out, _audit, _calls, events) = run("none", "Fix the gym note", "note.correct", json!({ "match": "gym", "text": "Gym at 7" }), Some(json!({ "ok": false, "error": "not_found" })));
    let end = events.iter().find(|e| e["ev"] == "tool_end" && e["name"] == "note.correct").unwrap();
    assert_eq!((end["ok"].clone(), end["error"].clone()), (json!(false), json!("note_not_found")));
}

#[test]
fn bite_an_empty_match_or_text_never_reaches_the_sidecar() {
    for args in [json!({ "match": "  ", "text": "x" }), json!({ "match": "dentist", "text": "" })] {
        let (_out, _audit, calls, events) = run("empty", "fix it", "note.correct", args, Some(json!({ "ok": true })));
        assert!(calls.is_empty(), "no call for an empty field");
        let end = events.iter().find(|e| e["ev"] == "tool_end" && e["name"] == "note.correct").unwrap();
        assert_eq!(end["error"], "bad_args");
    }
}

#[test]
fn bite_there_is_no_tool_that_removes_or_rewrites_more_than_one_note() {
    for tool in ["note.delete_all", "note.forget_all", "memory.deleteAll", "note.delete", "note.clear", "note.rewrite_all"] {
        let (out, audit, calls, events) = run(&format!("nope-{tool}"), "forget everything", tool, json!({}), Some(json!({ "ok": true })));
        assert!(calls.is_empty(), "{tool}: nothing reached the sidecar");
        let end = events.iter().find(|e| e["ev"] == "tool_end" && e["name"] == tool);
        assert!(end.is_none_or(|e| e["ok"] == false), "{tool}: {end:?}");
        assert!(audit.contains("unknown_tool"), "{tool}: refused as an unknown tool: {audit}");
        assert_eq!(out.stop, StopReason::Done);
    }
}
