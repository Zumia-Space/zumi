//! R3 (F02, F54): one custom OpenAI-compatible endpoint. It covers a custom engine, a hosted API that speaks
//! `/chat/completions` (OpenRouter, DeepSeek, Z.ai, ModelGo...) and a model running on this PC (Ollama, llama.cpp, LM Studio).
//! The user adds the address; `zumi-egress` is the only way out, so the rules are the egress rules: https for a public
//! address, plain http only for a loopback address the user added, no redirect, no private address behind a public name.
//!
//! The endpoint's model has a price the user states (0 for a model on this PC): without one the cost of a turn cannot be
//! bounded and no call is made (the gate's `cost_unknown`). The ledger names it `custom:<model>`, so it never borrows the
//! price of a hosted model of the same name. The key, if any, is read from the environment variable the settings name,
//! held in memory, sent as a bearer and never written anywhere.
//!
//! No tool-selection bridge (`find_tool` / `use_tool`): every tool the gate admits is sent in the request, as with any
//! other engine.
use crate::cancel::Cancel;
use crate::transport::{ModelTransport, TransportError, MAX_OUTPUT_TOKENS};
use crate::types::{ToolCall, TurnRequest, TurnResponse, Usage};
use serde_json::{json, Value};
use std::sync::Arc;
use zumi_egress::{Egress, EgressError, Request};

#[derive(Clone, PartialEq)]
pub struct CustomEndpoint {
    /// Up to and including the version segment, e.g. `https://api.example.com/v1` or `http://127.0.0.1:11434/v1`.
    pub base_url: String,
    pub model: String,
    pub api_key: Option<String>,
    pub input_per_mtok: f64,
    pub output_per_mtok: f64,
}

// The key is never printed, not even by a derived Debug.
impl std::fmt::Debug for CustomEndpoint {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CustomEndpoint").field("base_url", &self.base_url).field("model", &self.model).field("api_key", &self.api_key.as_ref().map(|_| "<set>")).finish()
    }
}

impl CustomEndpoint {
    /// `{ "baseUrl", "model", "inputPerMtok", "outputPerMtok", "apiKeyEnv"? }`. `env` looks a variable up (the host passes
    /// `std::env::var`); a named variable that is not set is an error, never a silent no-key call.
    pub fn from_json(v: &Value, env: &dyn Fn(&str) -> Option<String>) -> Result<CustomEndpoint, String> {
        let s = |k: &str| v.get(k).and_then(Value::as_str).filter(|x| !x.is_empty()).map(str::to_string);
        let price = |k: &str| v.get(k).and_then(Value::as_f64).filter(|p| *p >= 0.0 && p.is_finite()).ok_or(format!("endpoint needs {k}: the price in USD per million tokens (0 for a model on this PC)"));
        let api_key = match s("apiKeyEnv") {
            Some(name) => Some(env(&name).filter(|k| !k.is_empty()).ok_or(format!("the environment variable {name} named by apiKeyEnv is not set"))?),
            None => None,
        };
        let base_url = s("baseUrl").ok_or("endpoint needs baseUrl")?.trim_end_matches('/').to_string();
        let (input_per_mtok, output_per_mtok) = (price("inputPerMtok")?, price("outputPerMtok")?);
        // A price of 0 makes the worst case of a turn 0, so the per-task and total caps never bite and the ledger books 0 for
        // real spend. It is honest only for a model on this PC: a hosted endpoint must state a price above 0 for both.
        if !zumi_egress::is_loopback_origin(&base_url) && (input_per_mtok <= 0.0 || output_per_mtok <= 0.0) {
            return Err("a hosted endpoint needs a price above 0 for inputPerMtok and outputPerMtok: with a price of 0 no cost cap could ever stop it (0 is for a model on this PC)".to_string());
        }
        Ok(CustomEndpoint { base_url, model: s("model").ok_or("endpoint needs model")?, api_key, input_per_mtok, output_per_mtok })
    }

    /// The name the usage ledger and the price table use.
    pub fn ledger_model(&self) -> String {
        format!("custom:{}", self.model)
    }

    /// The user added this endpoint, so its origin is one the agent may reach.
    pub fn allow_origin(&self, egress: &mut Egress) -> Result<(), EgressError> {
        egress.add_user_origin(&self.base_url)
    }
}

pub struct CustomTransport {
    egress: Arc<Egress>,
    ep: CustomEndpoint,
}

impl CustomTransport {
    pub fn new(egress: Arc<Egress>, ep: CustomEndpoint) -> CustomTransport {
        CustomTransport { egress, ep }
    }
}

/// Function names on the wire are `[A-Za-z0-9_-]`: the gate's dots travel as `__`.
fn wire(name: &str) -> String {
    name.replace('.', "__")
}

fn to_wire_messages(messages: &[Value]) -> Vec<Value> {
    messages
        .iter()
        .map(|m| {
            let mut m = m.clone();
            if let Some(n) = m.get("name").and_then(Value::as_str).map(wire) {
                m["name"] = json!(n);
            }
            if let Some(calls) = m.get_mut("tool_calls").and_then(Value::as_array_mut) {
                for c in calls {
                    if let Some(n) = c.pointer("/function/name").and_then(Value::as_str).map(wire) {
                        c["function"]["name"] = json!(n);
                    }
                }
            }
            m
        })
        .collect()
}

fn to_wire_tools(tools: &[Value]) -> Vec<Value> {
    tools
        .iter()
        .map(|t| {
            let mut t = t.clone();
            if let Some(n) = t.pointer("/function/name").and_then(Value::as_str).map(wire) {
                t["function"]["name"] = json!(n);
            }
            t
        })
        .collect()
}

fn failed(code: &str, detail: &str) -> TransportError {
    TransportError::Failed(code.to_string(), detail.to_string())
}

impl ModelTransport for CustomTransport {
    fn model_id(&self) -> Option<String> {
        Some(self.ep.ledger_model())
    }

    fn turn(&mut self, req: &TurnRequest, cancel: &Cancel) -> Result<TurnResponse, TransportError> {
        let t0 = std::time::Instant::now();
        let mut body = json!({ "model": self.ep.model, "messages": to_wire_messages(&req.messages), "max_tokens": MAX_OUTPUT_TOKENS, "stream": false });
        if !req.tools.is_empty() {
            body["tools"] = json!(to_wire_tools(&req.tools));
        }
        let mut headers = vec![("Content-Type".to_string(), "application/json".to_string())];
        if let Some(k) = &self.ep.api_key {
            headers.push(("Authorization".to_string(), format!("Bearer {k}")));
        }
        let url = format!("{}/chat/completions", self.ep.base_url);
        let mut r = Request::new("POST", &url);
        r.headers = &headers;
        r.body = Some(body.to_string().into_bytes());
        r.timeout = std::time::Duration::from_secs(90);
        let resp = self.egress.send(&r, &|| cancel.is_set()).map_err(|e| match e {
            EgressError::Cancelled => TransportError::Cancelled,
            other => failed(other.code(), ""),
        })?;
        match resp.head.status {
            200 => {}
            401 | 403 => return Err(failed("model_auth", "the endpoint refused the key")),
            s => return Err(failed(&format!("model_http_{s}"), "")),
        }
        let v: Value = serde_json::from_slice(&resp.body).map_err(|_| failed("bad_model_reply", "the reply is not JSON"))?;
        let msg = v.pointer("/choices/0/message").ok_or_else(|| failed("bad_model_reply", "no choices[0].message"))?;
        let known: Vec<String> = req.tools.iter().filter_map(|t| t.pointer("/function/name").and_then(Value::as_str).map(str::to_string)).collect();
        let mut tool_calls = Vec::new();
        for (k, c) in msg.get("tool_calls").and_then(Value::as_array).map(|a| a.as_slice()).unwrap_or(&[]).iter().enumerate() {
            let wire_name = c.pointer("/function/name").and_then(Value::as_str).ok_or_else(|| failed("bad_model_reply", "a tool call has no name"))?;
            // Back to the gate's name; a name the request never offered is passed on as it came and the gate refuses it.
            let name = known.iter().find(|n| wire(n) == wire_name).cloned().unwrap_or_else(|| wire_name.to_string());
            let raw = c.pointer("/function/arguments");
            let args = match raw {
                Some(Value::String(s)) if s.trim().is_empty() => json!({}),
                Some(Value::String(s)) => serde_json::from_str::<Value>(s).map_err(|_| failed("bad_model_reply", "tool call arguments are not JSON"))?,
                Some(o @ Value::Object(_)) => o.clone(),
                None | Some(Value::Null) => json!({}),
                Some(_) => return Err(failed("bad_model_reply", "tool call arguments are not an object")),
            };
            if !args.is_object() {
                return Err(failed("bad_model_reply", "tool call arguments are not an object"));
            }
            let id = c.get("id").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| format!("call-{k}"));
            tool_calls.push(ToolCall { id, name, args });
        }
        let u = v.get("usage").ok_or_else(|| failed("bad_model_reply", "no usage: the cost of the turn cannot be known"))?;
        let n = |k: &str| u.get(k).and_then(Value::as_u64);
        let usage = Usage { input: n("prompt_tokens").ok_or_else(|| failed("bad_model_reply", "usage.prompt_tokens missing"))?, output: n("completion_tokens").ok_or_else(|| failed("bad_model_reply", "usage.completion_tokens missing"))? };
        Ok(TurnResponse { text: msg.get("content").and_then(Value::as_str).unwrap_or("").to_string(), tool_calls, usage, model: self.ep.ledger_model(), ms: t0.elapsed().as_millis() as u64 })
    }
}
