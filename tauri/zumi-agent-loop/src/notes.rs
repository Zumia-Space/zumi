//! Built-in tools that are not hands: `note.save` (one row in the user's memory notes, the same table `memory.*`
//! reads), `note.correct` (R6c C: correct exactly ONE of those notes when the person says it is wrong or has changed; the Memory tab's
//! edit is the other route to the same result) and `reminder.add` (declared, `not_available` until phase A2 passes: no reminder is
//! built here). There is no tool that removes or rewrites more than one note.
use crate::cancel::Cancel;
use crate::tool_gate::{ArgKind, Cap, Param, Tool, ToolSpec};
use crate::transport::{RpcCall, TransportError};
use crate::types::ToolResult;
use serde_json::{json, Value};
use std::cell::RefCell;
use std::rc::Rc;

/// One sidecar rpc shared by the note tools of a task (the host hands the loop a single `Box<dyn RpcCall>` for notes).
pub struct SharedRpc(Rc<RefCell<Box<dyn RpcCall>>>);

impl SharedRpc {
    pub fn new(rpc: Box<dyn RpcCall>) -> SharedRpc {
        SharedRpc(Rc::new(RefCell::new(rpc)))
    }
}

impl Clone for SharedRpc {
    fn clone(&self) -> SharedRpc {
        SharedRpc(self.0.clone())
    }
}

impl RpcCall for SharedRpc {
    fn call(&mut self, method: &str, params: Value, cancel: &Cancel) -> Result<Value, TransportError> {
        self.0.borrow_mut().call(method, params, cancel)
    }
}

/// Where a note goes. Production: the sidecar's `memory.add` (memory-notes keeps the file; the redaction of secrets and
/// the length cap happen there). Failure is (code word, detail).
pub trait NoteStore {
    fn add(&mut self, text: &str, cancel: &Cancel) -> Result<i64, (String, String)>;
}

/// `memory.add` over the sidecar rpc.
pub struct RpcNoteStore<R: RpcCall> {
    pub rpc: R,
}

impl<R: RpcCall> NoteStore for RpcNoteStore<R> {
    fn add(&mut self, text: &str, cancel: &Cancel) -> Result<i64, (String, String)> {
        let reply = match self.rpc.call("memory.add", json!([text, { "actor": "agent" }]), cancel) {
            Ok(v) => v,
            Err(TransportError::Cancelled) => return Err(("cancelled".into(), String::new())),
            Err(TransportError::Failed(c, d)) => return Err((c, d)),
        };
        if reply.get("ok") != Some(&json!(true)) {
            let code = reply.get("error").and_then(Value::as_str).unwrap_or("memory_failed");
            return Err((code.to_string(), String::new()));
        }
        reply.pointer("/item/id").and_then(Value::as_i64).ok_or(("bad_memory_reply".to_string(), "no item id".to_string()))
    }
}

pub struct NoteTool<S: NoteStore> {
    spec: ToolSpec,
    store: S,
}

impl<S: NoteStore> NoteTool<S> {
    pub fn new(store: S) -> NoteTool<S> {
        NoteTool {
            spec: ToolSpec {
                name: "note.save",
                description: "Save one short note that the user asked you to remember. It is stored on this PC and shown in their memory list.",
                cap: Cap::MemoryWrite,
                params: vec![Param { name: "text", required: true, kind: ArgKind::Text, values: None }],
                available: true,
                taints: false,
            },
            store,
        }
    }
}

impl<S: NoteStore> Tool for NoteTool<S> {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }
    fn execute(&mut self, args: &Value, cancel: &Cancel) -> ToolResult {
        let text = args.get("text").and_then(Value::as_str).unwrap_or("").trim();
        if text.is_empty() {
            return ToolResult::err("bad_args", "the note is empty");
        }
        match self.store.add(text, cancel) {
            Ok(id) => ToolResult::ok(json!({ "saved": true, "id": id })),
            Err((code, detail)) => ToolResult::err(&format!("note_{code}"), &detail),
        }
    }
}

/// What a correction did.
#[derive(Debug, PartialEq)]
pub struct Correction {
    pub id: i64,
    pub previous: String,
    pub text: String,
}

/// Why a correction did not happen: a code word, a detail, and (several notes matched) the candidates to ask the person about.
#[derive(Debug, PartialEq)]
pub struct Refusal {
    pub code: String,
    pub detail: String,
    pub candidates: Option<Value>,
}

/// Where a correction goes. Production: the sidecar's `__host.memoryCorrect` (it finds the ONE note the words name, redacts, journals it as the
/// agent's, and refuses when none or several match).
pub trait NoteCorrector {
    fn correct(&mut self, matching: &str, text: &str, cancel: &Cancel) -> Result<Correction, Refusal>;
}

/// `__host.memoryCorrect` over the sidecar rpc.
pub struct RpcNoteCorrector<R: RpcCall> {
    pub rpc: R,
}

impl<R: RpcCall> NoteCorrector for RpcNoteCorrector<R> {
    fn correct(&mut self, matching: &str, text: &str, cancel: &Cancel) -> Result<Correction, Refusal> {
        let refuse = |code: &str, detail: &str| Refusal { code: code.to_string(), detail: detail.to_string(), candidates: None };
        let reply = match self.rpc.call("__host.memoryCorrect", json!([matching, text]), cancel) {
            Ok(v) => v,
            Err(TransportError::Cancelled) => return Err(refuse("cancelled", "")),
            Err(TransportError::Failed(c, d)) => return Err(refuse(&c, &d)),
        };
        if reply.get("ok") != Some(&json!(true)) {
            let code = reply.get("error").and_then(Value::as_str).unwrap_or("memory_failed");
            return Err(Refusal { code: code.to_string(), detail: String::new(), candidates: reply.get("candidates").cloned() });
        }
        let id = reply.pointer("/item/id").and_then(Value::as_i64).ok_or_else(|| refuse("bad_memory_reply", "no item id"))?;
        let now = reply.pointer("/item/text").and_then(Value::as_str).unwrap_or(text).to_string();
        let previous = reply.get("previous").and_then(Value::as_str).unwrap_or("").to_string();
        Ok(Correction { id, previous, text: now })
    }
}

pub struct NoteCorrectTool<S: NoteCorrector> {
    spec: ToolSpec,
    store: S,
}

impl<S: NoteCorrector> NoteCorrectTool<S> {
    pub fn new(store: S) -> NoteCorrectTool<S> {
        NoteCorrectTool {
            spec: ToolSpec {
                name: "note.correct",
                description: "Correct exactly ONE saved note when the person says it is wrong or has changed. `match` is a few words that name that note \
                    (they must appear in it); `text` is the whole corrected note. It changes one note and can never remove or rewrite several. \
                    If it answers note_ambiguous, ask the person which of the listed notes they mean; do not guess. After it succeeds, confirm in one short sentence.",
                cap: Cap::MemoryWrite,
                params: vec![
                    Param { name: "match", required: true, kind: ArgKind::Text, values: None },
                    Param { name: "text", required: true, kind: ArgKind::Text, values: None },
                ],
                available: true,
                taints: false,
            },
            store,
        }
    }
}

impl<S: NoteCorrector> Tool for NoteCorrectTool<S> {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }
    fn execute(&mut self, args: &Value, cancel: &Cancel) -> ToolResult {
        let field = |k: &str| args.get(k).and_then(Value::as_str).unwrap_or("").trim().to_string();
        let (matching, text) = (field("match"), field("text"));
        if matching.is_empty() || text.is_empty() {
            return ToolResult::err("bad_args", "both the words that name the note and the corrected text are needed");
        }
        match self.store.correct(&matching, &text, cancel) {
            Ok(c) => ToolResult::ok(json!({ "corrected": true, "id": c.id, "was": c.previous, "now": c.text })),
            Err(r) => {
                let code = format!("note_{}", r.code);
                let mut value = json!({ "error": code, "detail": r.detail });
                if let (Some(c), Some(o)) = (r.candidates, value.as_object_mut()) {
                    o.insert("candidates".to_string(), c);
                }
                ToolResult { ok: false, error: Some(code), value }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct Mem(Vec<String>, bool);
    impl NoteStore for Mem {
        fn add(&mut self, text: &str, _c: &Cancel) -> Result<i64, (String, String)> {
            if self.1 {
                return Err(("unavailable".into(), "no sqlite".into()));
            }
            self.0.push(text.to_string());
            Ok(self.0.len() as i64)
        }
    }

    #[test]
    fn note_save_writes_one_row_and_reports_its_id() {
        let mut t = NoteTool::new(Mem::default());
        let r = t.execute(&json!({ "text": "  buy milk  " }), &Cancel::new());
        assert!(r.ok);
        assert_eq!(r.value, json!({ "saved": true, "id": 1 }));
        assert_eq!(t.store.0, vec!["buy milk"]);
    }

    #[test]
    fn bite_empty_note_and_a_failing_store_are_errors_not_successes() {
        let mut t = NoteTool::new(Mem::default());
        assert_eq!(t.execute(&json!({ "text": "   " }), &Cancel::new()).error.as_deref(), Some("bad_args"));
        assert!(t.store.0.is_empty());
        let mut f = NoteTool::new(Mem(vec![], true));
        let r = f.execute(&json!({ "text": "x y z" }), &Cancel::new());
        assert_eq!(r.error.as_deref(), Some("note_unavailable"));
        assert!(!r.ok);
    }

    struct Canned(Value, std::cell::RefCell<Vec<(String, Value)>>);
    impl RpcCall for Canned {
        fn call(&mut self, m: &str, p: Value, _c: &Cancel) -> Result<Value, TransportError> {
            self.1.borrow_mut().push((m.to_string(), p));
            Ok(self.0.clone())
        }
    }

    #[test]
    fn rpc_store_calls_memory_add_with_the_text_and_reads_the_item_id() {
        let mut s = RpcNoteStore { rpc: Canned(json!({ "ok": true, "item": { "id": 7, "kind": "note" } }), Default::default()) };
        assert_eq!(s.add("milk", &Cancel::new()), Ok(7));
        assert_eq!(s.rpc.1.borrow()[0], ("memory.add".to_string(), json!(["milk", { "actor": "agent" }])), "the sidecar journals this note as the agent's");
    }

    #[test]
    fn rpc_store_bites_a_refused_or_malformed_reply() {
        let mut s = RpcNoteStore { rpc: Canned(json!({ "ok": false, "error": "unavailable" }), Default::default()) };
        assert_eq!(s.add("milk", &Cancel::new()), Err(("unavailable".into(), String::new())));
        let mut s2 = RpcNoteStore { rpc: Canned(json!({ "ok": true }), Default::default()) };
        assert!(s2.add("milk", &Cancel::new()).is_err(), "no id back means no row was proven");
    }

}
