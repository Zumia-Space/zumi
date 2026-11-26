//! "Save a note that X": a chat sentence, the mock model, the gate and the note tool, end to end in the crate.
//! The 10/10 readback through the real memory-notes module is the goal harness (scripts/maus-p3-goals.mjs).
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use zumi_agent_loop::loop_run::{run, LoopConfig, NullMeter, StopReason};
use zumi_agent_loop::notes::{NoteStore, NoteTool};
use zumi_agent_loop::tool_gate::{AuditSink, Cap, GateConfig, ToolGate};
use zumi_agent_loop::transport::MockTransport;
use zumi_agent_loop::Cancel;

struct Rows(Rc<RefCell<Vec<String>>>);
impl NoteStore for Rows {
    fn add(&mut self, text: &str, _c: &Cancel) -> Result<i64, (String, String)> {
        self.0.borrow_mut().push(text.to_string());
        Ok(self.0.borrow().len() as i64)
    }
}
struct Lines(Rc<RefCell<Vec<String>>>);
impl AuditSink for Lines {
    fn record(&self, verb: &str, code: Option<&str>, _d: &str) -> std::io::Result<()> {
        self.0.borrow_mut().push(format!("{verb}:{}", code.unwrap_or("allowed")));
        Ok(())
    }
}

fn run_sentence(sentence: &str, note_text: &str, granted: Vec<Cap>) -> (StopReason, Vec<String>, Vec<String>) {
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/smoke.json");
    let mut t = MockTransport::load(&fixture, HashMap::from([("note".to_string(), note_text.to_string())])).unwrap();
    let (rows, lines) = (Rc::new(RefCell::new(vec![])), Rc::new(RefCell::new(vec![])));
    let tools: Vec<Box<dyn zumi_agent_loop::tool_gate::Tool>> = vec![Box::new(NoteTool::new(Rows(rows.clone())))];
    let mut gate = ToolGate::new(GateConfig::new("t", granted, vec![sentence.to_string()]), tools, Box::new(Lines(lines.clone())));
    let cfg = LoopConfig { system: "You are Zumi.".into(), user: sentence.into(), max_turns: 40 };
    let o = run(&cfg, &mut t, &mut gate, &mut NullMeter, &Cancel::new(), &mut |_| {});
    let (r, l) = (rows.borrow().clone(), lines.borrow().clone());
    (o.stop, r, l)
}

/// The call lines of an audit: the per-turn `model_text` lines (what the model said) are checked on their own.
fn calls_only(lines: &[String]) -> Vec<String> {
    lines.iter().filter(|l| !l.starts_with("model_text:")).cloned().collect()
}

#[test]
fn a_sentence_saves_one_note_through_the_gate() {
    let (stop, rows, lines) = run_sentence("Save a note that the dentist is on Friday", "the dentist is on Friday", vec![Cap::MemoryWrite]);
    assert_eq!(stop, StopReason::Done);
    assert_eq!(rows, vec!["the dentist is on Friday"]);
    assert_eq!(calls_only(&lines), vec!["tool:note.save:allowed", "tool_result:note.save:allowed"]);
    assert_eq!(lines.iter().filter(|l| l.starts_with("model_text:")).count(), 2, "one line per model turn (the call, then the answer): {lines:?}");
}

#[test]
fn bite_without_the_memory_capability_no_row_is_written() {
    let (stop, rows, lines) = run_sentence("Save a note that the dentist is on Friday", "x", vec![]);
    assert_eq!(stop, StopReason::Done, "the model gets the refusal and answers");
    assert!(rows.is_empty());
    assert_eq!(calls_only(&lines), vec!["tool:note.save:capability_denied"]);
}
