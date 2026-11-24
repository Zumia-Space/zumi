//! Model transport behind a trait. Two implementations:
//!
//!   * `MockTransport` replays fixture turns (JSON under `fixtures/`). The only transport any P3 test or goal run uses.
//!   * `SidecarTransport` calls the host-only sidecar method `__host.modelTurn` through an `RpcCall`. It is compiled
//!     and unit-tested against canned replies; it is not pointed at a live provider in P3 (the owner has not approved
//!     spend). The sidecar method does the model call only: it executes no tool.
use crate::cancel::Cancel;
use crate::types::{ToolCall, TurnRequest, TurnResponse, Usage};
use serde_json::{json, Value};
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq)]
pub enum TransportError {
    /// The cancel token was set while waiting.
    Cancelled,
    /// A code word and a detail (never a key, never a prompt).
    Failed(String, String),
}

/// The most output tokens one turn may produce (sent to the sidecar, which never asks the provider for more).
pub const MAX_OUTPUT_TOKENS: u64 = 1000;

pub trait ModelTransport {
    /// The model the next turn will use, if known before the call. None: the cost of a turn cannot be bounded.
    fn model_id(&self) -> Option<String> {
        None
    }
    fn turn(&mut self, req: &TurnRequest, cancel: &Cancel) -> Result<TurnResponse, TransportError>;
}

// ---------- mock ----------

#[derive(Debug, Clone)]
struct MockTurn {
    delay_ms: u64,
    text: String,
    calls: Vec<(String, Value)>,
    usage: Usage,
    /// R7 K1: `when_system`: the first entry whose `contains` is in the system message replaces this turn's text (and calls when it has
    /// them). Lets a fixture act like a model that reads its instructions, so a skill in the prompt changes the reply.
    when_system: Vec<(String, Option<String>, Option<Vec<(String, Value)>>)>,
}

/// Replays the turns of a fixture, in order. `{{name}}` in any string of a turn is replaced from `vars` (the harness
/// fills them from the user's sentence, the way a real model would copy them), and `{{result.<tool>.<a.b>}}` from the
/// latest result of that tool in the conversation.
pub struct MockTransport {
    pub name: String,
    pub model: String,
    turns: Vec<MockTurn>,
    next: usize,
    vars: HashMap<String, String>,
    pub requests_seen: usize,
}

impl MockTransport {
    pub fn from_json(v: &Value, vars: HashMap<String, String>) -> Result<MockTransport, String> {
        let name = v.get("name").and_then(Value::as_str).unwrap_or("unnamed").to_string();
        let model = v.get("model").and_then(Value::as_str).ok_or("fixture needs a string \"model\"")?.to_string();
        let turns = v.get("turns").and_then(Value::as_array).ok_or("fixture needs a \"turns\" array")?;
        let mut out = Vec::new();
        for (i, t) in turns.iter().enumerate() {
            let calls = t
                .get("tool_calls")
                .and_then(Value::as_array)
                .map(|cs| {
                    cs.iter()
                        .map(|c| {
                            let n = c.get("name").and_then(Value::as_str).ok_or(format!("turn {i}: a tool call needs a name"))?;
                            Ok((n.to_string(), c.get("args").cloned().unwrap_or_else(|| json!({}))))
                        })
                        .collect::<Result<Vec<_>, String>>()
                })
                .transpose()?
                .unwrap_or_default();
            let when_system = t
                .get("when_system")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(|w| {
                            let needle = w.get("contains").and_then(Value::as_str)?.to_string();
                            let text = w.get("text").and_then(Value::as_str).map(str::to_string);
                            let calls = w.get("tool_calls").and_then(Value::as_array).map(|cs| cs.iter().filter_map(|c| Some((c.get("name")?.as_str()?.to_string(), c.get("args").cloned().unwrap_or_else(|| json!({}))))).collect());
                            Some((needle, text, calls))
                        })
                        .collect()
                })
                .unwrap_or_default();
            let u = t.get("usage");
            let n = |k: &str| u.and_then(|u| u.get(k)).and_then(Value::as_u64).unwrap_or(0);
            out.push(MockTurn {
                delay_ms: t.get("delay_ms").and_then(Value::as_u64).unwrap_or(0),
                text: t.get("text").and_then(Value::as_str).unwrap_or("").to_string(),
                calls,
                usage: Usage { input: n("in"), output: n("out") },
                when_system,
            });
        }
        Ok(MockTransport { name, model, turns: out, next: 0, vars, requests_seen: 0 })
    }

    pub fn load(path: &std::path::Path, vars: HashMap<String, String>) -> Result<MockTransport, String> {
        let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let v: Value = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
        MockTransport::from_json(&v, vars)
    }

    fn subst(&self, v: &Value, messages: &[Value]) -> Value {
        match v {
            Value::String(s) => Value::String(self.subst_str(s, messages)),
            Value::Array(a) => Value::Array(a.iter().map(|x| self.subst(x, messages)).collect()),
            Value::Object(o) => Value::Object(o.iter().map(|(k, x)| (k.clone(), self.subst(x, messages))).collect()),
            other => other.clone(),
        }
    }

    fn subst_str(&self, s: &str, messages: &[Value]) -> String {
        let mut out = String::new();
        let mut rest = s;
        while let Some(i) = rest.find("{{") {
            out.push_str(&rest[..i]);
            let after = &rest[i + 2..];
            let Some(j) = after.find("}}") else {
                out.push_str(&rest[i..]);
                return out;
            };
            let key = after[..j].trim();
            out.push_str(&self.lookup(key, messages).unwrap_or_default());
            rest = &after[j + 2..];
        }
        out.push_str(rest);
        out
    }

    fn lookup(&self, key: &str, messages: &[Value]) -> Option<String> {
        if let Some(rest) = key.strip_prefix("result.") {
            // Tool names contain dots (hands.launch): match the latest tool message whose name prefixes the path.
            let (msg, path) = messages.iter().rev().find_map(|m| {
                let n = m["name"].as_str()?;
                (m["role"] == "tool").then_some(())?;
                rest.strip_prefix(n)?.strip_prefix(".").map(|p| (m, p))
            })?;
            let mut cur: Value = serde_json::from_str(msg["content"].as_str()?).ok()?;
            for part in path.split(".") {
                cur = cur.get(part)?.clone();
            }
            return Some(match cur {
                Value::String(s) => s,
                other => other.to_string(),
            });
        }
        self.vars.get(key).cloned()
    }
}

impl ModelTransport for MockTransport {
    fn model_id(&self) -> Option<String> {
        Some(self.model.clone())
    }
    fn turn(&mut self, req: &TurnRequest, cancel: &Cancel) -> Result<TurnResponse, TransportError> {
        self.requests_seen += 1;
        let i = self.next;
        let Some(t) = self.turns.get(i).cloned() else {
            return Err(TransportError::Failed("fixture_exhausted".into(), format!("fixture {:?} has {} turns", self.name, self.turns.len())));
        };
        self.next += 1;
        let t0 = std::time::Instant::now();
        if !cancel.sleep(t.delay_ms) {
            return Err(TransportError::Cancelled);
        }
        let system = req.messages.iter().find(|m| m["role"] == "system").and_then(|m| m["content"].as_str()).unwrap_or("");
        let alt = t.when_system.iter().find(|(needle, _, _)| system.contains(needle.as_str()));
        let text = alt.and_then(|(_, text, _)| text.clone()).unwrap_or_else(|| t.text.clone());
        let calls = alt.and_then(|(_, _, calls)| calls.clone()).unwrap_or_else(|| t.calls.clone());
        let tool_calls = calls
            .iter()
            .enumerate()
            .map(|(k, (name, args))| ToolCall { id: format!("mock-{i}-{k}"), name: name.clone(), args: self.subst(args, &req.messages) })
            .collect();
        Ok(TurnResponse { text: self.subst_str(&text, &req.messages), tool_calls, usage: t.usage, model: self.model.clone(), ms: t0.elapsed().as_millis() as u64 })
    }
}

// ---------- sidecar ----------

/// One JSON-RPC call to the sidecar (the host's supervisor implements it; the bin bridges it over stdio). `params` is
/// the JSON array the sidecar spreads into the handler.
pub trait RpcCall {
    fn call(&mut self, method: &str, params: Value, cancel: &Cancel) -> Result<Value, TransportError>;
}

pub const MODEL_TURN_METHOD: &str = "__host.modelTurn";
/// Aborts the in-flight `__host.modelTurn` with that `requestId` (the sidecar aborts its provider fetch).
pub const MODEL_TURN_CANCEL_METHOD: &str = "__host.modelTurnCancel";

pub struct SidecarTransport<R: RpcCall> {
    pub rpc: R,
    pub model: Option<String>,
}

/// A source of independent sidecar clients: the model call blocks on one, the abort goes out on another.
pub type RpcFactory = std::sync::Arc<dyn Fn() -> Box<dyn RpcCall + Send> + Send + Sync>;

/// An `RpcCall` that takes a fresh client from the factory for each call, so calls never queue behind one another.
#[derive(Clone)]
pub struct FactoryRpc(pub RpcFactory);

impl RpcCall for FactoryRpc {
    fn call(&mut self, method: &str, params: Value, cancel: &Cancel) -> Result<Value, TransportError> {
        (self.0)().call(method, params, cancel)
    }
}

static REQUEST_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

impl<R: RpcCall + Clone + Send + 'static> ModelTransport for SidecarTransport<R> {
    fn model_id(&self) -> Option<String> {
        self.model.clone()
    }
    fn turn(&mut self, req: &TurnRequest, cancel: &Cancel) -> Result<TurnResponse, TransportError> {
        // The sidecar dispatches params as an array: one object argument. The request id lets us abort it.
        let id = format!("turn-{}-{}", std::process::id(), REQUEST_SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst));
        let params = json!([{ "messages": req.messages, "tools": req.tools, "model": self.model, "maxTokens": MAX_OUTPUT_TOKENS, "requestId": id }]);
        // The blocking call runs on a thread of its own; this thread watches the cancel token in short slices. On a cancel
        // the sidecar is told to abort its provider fetch, and the turn ends at once without waiting for the answer.
        let (tx, rx) = std::sync::mpsc::channel();
        let mut worker = self.rpc.clone();
        std::thread::spawn(move || {
            let _ = tx.send(worker.call(MODEL_TURN_METHOD, params, &Cancel::new()));
        });
        loop {
            match rx.recv_timeout(crate::cancel::SLICE) {
                Ok(reply) => return parse_model_turn(&reply?),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    if cancel.is_set() {
                        let mut aborter = self.rpc.clone();
                        std::thread::spawn(move || {
                            let _ = aborter.call(MODEL_TURN_CANCEL_METHOD, json!([id]), &Cancel::new());
                        });
                        return Err(TransportError::Cancelled);
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return Err(TransportError::Failed("rpc_gone".into(), String::new())),
            }
        }
    }
}

/// The sidecar's reply: `{ok:true, text, toolCalls:[{id,name,args}], usage:{in,out,total}, model, ms}` or
/// `{ok:false, error}`. Anything else is a failure, not a guess.
pub fn parse_model_turn(v: &Value) -> Result<TurnResponse, TransportError> {
    let bad = |why: &str| TransportError::Failed("bad_model_reply".into(), why.to_string());
    if v.get("ok") != Some(&json!(true)) {
        let code = v.get("error").and_then(Value::as_str).unwrap_or("model_failed");
        return Err(TransportError::Failed(code.to_string(), String::new()));
    }
    let text = v.get("text").and_then(Value::as_str).unwrap_or("").to_string();
    let mut tool_calls = Vec::new();
    for (k, c) in v.get("toolCalls").and_then(Value::as_array).map(|a| a.as_slice()).unwrap_or(&[]).iter().enumerate() {
        let name = c.get("name").and_then(Value::as_str).ok_or_else(|| bad("a tool call has no name"))?;
        let args = c.get("args").cloned().unwrap_or_else(|| json!({}));
        if !args.is_object() {
            return Err(bad("tool call arguments are not an object"));
        }
        let id = c.get("id").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| format!("call-{k}"));
        tool_calls.push(ToolCall { id, name: name.to_string(), args });
    }
    let u = v.get("usage").ok_or_else(|| bad("no usage"))?;
    let n = |k: &str| u.get(k).and_then(Value::as_u64);
    let usage = Usage { input: n("in").ok_or_else(|| bad("usage.in missing"))?, output: n("out").ok_or_else(|| bad("usage.out missing"))? };
    Ok(TurnResponse { text, tool_calls, usage, model: v.get("model").and_then(Value::as_str).unwrap_or("unknown").to_string(), ms: v.get("ms").and_then(Value::as_u64).unwrap_or(0) })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Value {
        json!({ "name": "t", "model": "mock/loop-v1", "turns": [
            { "text": "opening {{app}}", "tool_calls": [{ "name": "hands.launch", "args": { "app": "{{app}}", "n": 3 } }], "usage": { "in": 100, "out": 10 } },
            { "tool_calls": [{ "name": "hands.type", "args": { "text": "pid {{result.hands.launch.pid}}" } }], "usage": { "in": 200, "out": 20 }, "delay_ms": 10 },
            { "text": "done", "usage": { "in": 300, "out": 5 } }
        ] })
    }
    fn req(messages: Vec<Value>) -> TurnRequest {
        TurnRequest { messages, tools: vec![] }
    }

    #[test]
    fn mock_replays_turns_in_order_with_vars_and_results() {
        let mut t = MockTransport::from_json(&fixture(), HashMap::from([("app".to_string(), "notepad".to_string())])).unwrap();
        let c = Cancel::new();
        let r1 = t.turn(&req(vec![]), &c).unwrap();
        assert_eq!(r1.text, "opening notepad");
        assert_eq!(r1.tool_calls[0].args, json!({ "app": "notepad", "n": 3 }));
        assert_eq!(r1.usage, Usage { input: 100, output: 10 });
        assert_eq!(r1.model, "mock/loop-v1");
        let history = vec![json!({ "role": "tool", "name": "hands.launch", "content": "{\"pid\":4242}" })];
        let r2 = t.turn(&req(history), &c).unwrap();
        assert_eq!(r2.tool_calls[0].args["text"], "pid 4242");
        let r3 = t.turn(&req(vec![]), &c).unwrap();
        assert!(r3.tool_calls.is_empty());
        assert_eq!(r3.text, "done");
    }

    #[test]
    fn mock_bite_exhausted_fixture_is_a_failure_not_a_repeat() {
        let mut t = MockTransport::from_json(&fixture(), HashMap::new()).unwrap();
        let c = Cancel::new();
        for _ in 0..3 {
            t.turn(&req(vec![]), &c).unwrap();
        }
        assert!(matches!(t.turn(&req(vec![]), &c), Err(TransportError::Failed(code, _)) if code == "fixture_exhausted"));
    }

    #[test]
    fn mock_bite_cancel_during_the_latency_ends_the_turn_early() {
        let v = json!({ "model": "m", "turns": [{ "delay_ms": 5000, "text": "slow" }] });
        let mut t = MockTransport::from_json(&v, HashMap::new()).unwrap();
        let c = Cancel::new();
        let c2 = c.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(20));
            c2.set("killed");
        });
        let t0 = std::time::Instant::now();
        assert_eq!(t.turn(&req(vec![]), &c), Err(TransportError::Cancelled));
        assert!(t0.elapsed() < std::time::Duration::from_millis(500));
    }

    #[test]
    fn m2_the_model_is_known_before_the_call_for_the_mock_and_only_when_configured_for_the_sidecar() {
        let t = MockTransport::from_json(&fixture(), HashMap::new()).unwrap();
        assert_eq!(t.model_id().as_deref(), Some("mock/loop-v1"));
        let with = SidecarTransport { rpc: Canned::new(vec![]), model: Some("m1".into()) };
        let without = SidecarTransport { rpc: Canned::new(vec![]), model: None };
        assert_eq!(with.model_id().as_deref(), Some("m1"));
        assert_eq!(without.model_id(), None, "the sidecar's default model has no known price: refuse before the call");
    }

    /// A sidecar whose model call hangs until it is told to abort (the stub seam for an in-flight provider fetch).
    #[derive(Clone, Default)]
    struct Hanging {
        aborted: std::sync::Arc<std::sync::atomic::AtomicBool>,
        calls: std::sync::Arc<std::sync::Mutex<Vec<(String, Value)>>>,
    }
    impl RpcCall for Hanging {
        fn call(&mut self, method: &str, params: Value, _c: &Cancel) -> Result<Value, TransportError> {
            self.calls.lock().unwrap().push((method.to_string(), params));
            if method == MODEL_TURN_CANCEL_METHOD {
                self.aborted.store(true, std::sync::atomic::Ordering::SeqCst);
                return Ok(json!({ "ok": true }));
            }
            let end = std::time::Instant::now() + std::time::Duration::from_millis(1500);
            while std::time::Instant::now() < end {
                if self.aborted.load(std::sync::atomic::Ordering::SeqCst) {
                    return Ok(json!({ "ok": false, "error": "cancelled" }));
                }
                std::thread::sleep(std::time::Duration::from_millis(2));
            }
            Ok(json!({ "ok": false, "error": "never_aborted" }))
        }
    }

    #[test]
    fn m4_cancel_aborts_an_in_flight_sidecar_model_call_and_the_turn_ends_within_200_ms() {
        let rpc = Hanging::default();
        let calls = rpc.calls.clone();
        let mut t = SidecarTransport { rpc, model: Some("m1".into()) };
        let c = Cancel::new();
        let c2 = c.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(50));
            c2.set("killed");
        });
        let t0 = std::time::Instant::now();
        let r = t.turn(&req(vec![json!({ "role": "user", "content": "x" })]), &c);
        let waited = t0.elapsed().as_millis();
        assert_eq!(r, Err(TransportError::Cancelled));
        assert!(waited <= 50 + 200, "ended {waited} ms after the call started, kill set at 50");
        std::thread::sleep(std::time::Duration::from_millis(60));
        let seen = calls.lock().unwrap().clone();
        let turn_id = seen.iter().find(|(m, _)| m == MODEL_TURN_METHOD).map(|(_, p)| p[0]["requestId"].clone()).unwrap();
        let cancels: Vec<_> = seen.iter().filter(|(m, _)| m == MODEL_TURN_CANCEL_METHOD).collect();
        assert!(turn_id.is_string(), "the request carries an id the sidecar can abort by");
        assert_eq!(cancels.len(), 1, "exactly one abort");
        assert_eq!(cancels[0].1[0], turn_id, "for that request");
    }

    #[test]
    fn m4_pass_twin_without_a_cancel_the_call_is_not_aborted() {
        let rpc = Hanging::default();
        let calls = rpc.calls.clone();
        let mut t = SidecarTransport { rpc, model: Some("m1".into()) };
        let r = t.turn(&req(vec![]), &Cancel::new());
        assert!(matches!(r, Err(TransportError::Failed(ref c, _)) if c == "never_aborted"), "{r:?}");
        assert!(calls.lock().unwrap().iter().all(|(m, _)| m != MODEL_TURN_CANCEL_METHOD));
    }

    #[test]
    fn mock_rejects_a_malformed_fixture() {
        assert!(MockTransport::from_json(&json!({ "turns": [] }), HashMap::new()).is_err());
        assert!(MockTransport::from_json(&json!({ "model": "m" }), HashMap::new()).is_err());
        assert!(MockTransport::from_json(&json!({ "model": "m", "turns": [{ "tool_calls": [{ "args": {} }] }] }), HashMap::new()).is_err());
    }

    #[derive(Clone)]
    struct Canned(std::sync::Arc<std::sync::Mutex<Vec<Value>>>, std::sync::Arc<std::sync::Mutex<Vec<(String, Value)>>>);
    impl Canned {
        fn new(replies: Vec<Value>) -> Canned {
            Canned(std::sync::Arc::new(std::sync::Mutex::new(replies)), Default::default())
        }
    }
    impl RpcCall for Canned {
        fn call(&mut self, method: &str, params: Value, _c: &Cancel) -> Result<Value, TransportError> {
            self.1.lock().unwrap().push((method.to_string(), params));
            Ok(self.0.lock().unwrap().remove(0))
        }
    }

    #[test]
    fn sidecar_transport_calls_the_one_host_method_and_parses_text_calls_and_usage() {
        let reply = json!({ "ok": true, "text": "hi", "toolCalls": [{ "id": "a", "name": "note.save", "args": { "text": "x" } }], "usage": { "in": 7, "out": 3, "total": 10 }, "model": "m1", "ms": 12 });
        let mut t = SidecarTransport { rpc: Canned::new(vec![reply]), model: Some("m1".into()) };
        let r = t.turn(&TurnRequest { messages: vec![json!({ "role": "user", "content": "q" })], tools: vec![json!({ "name": "note.save" })] }, &Cancel::new()).unwrap();
        assert_eq!(r.tool_calls, vec![ToolCall::new("a", "note.save", json!({ "text": "x" }))]);
        assert_eq!(r.usage, Usage { input: 7, output: 3 });
        let seen = t.rpc.1.lock().unwrap().clone();
        assert_eq!(seen[0].0, "__host.modelTurn");
        assert_eq!(seen[0].1[0]["model"], "m1");
    }

    #[test]
    fn sidecar_reply_bites_failure_missing_usage_and_non_object_args() {
        assert!(matches!(parse_model_turn(&json!({ "ok": false, "error": "auth" })), Err(TransportError::Failed(c, _)) if c == "auth"));
        assert!(parse_model_turn(&json!({ "ok": true, "text": "x" })).is_err(), "no usage: refuse, never invent a cost of 0");
        assert!(parse_model_turn(&json!({ "ok": true, "usage": { "in": 1, "out": 1 }, "toolCalls": [{ "name": "a", "args": "rm -rf" }] })).is_err());
        assert!(parse_model_turn(&json!({ "usage": { "in": 1, "out": 1 } })).is_err(), "ok must be true");
    }
}
