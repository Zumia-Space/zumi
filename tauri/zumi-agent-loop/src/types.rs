//! Plain data shared by the loop, the gate, the tools and the transports. Messages are OpenAI-shaped JSON values.
use serde_json::{json, Value};

#[derive(Debug, Clone, PartialEq)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub args: Value,
}

impl ToolCall {
    pub fn new(id: &str, name: &str, args: Value) -> ToolCall {
        ToolCall { id: id.to_string(), name: name.to_string(), args }
    }
    /// The assistant message's `tool_calls` entry (OpenAI shape, arguments as a JSON string).
    pub fn to_message_json(&self) -> Value {
        json!({ "id": self.id, "type": "function", "function": { "name": self.name, "arguments": self.args.to_string() } })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Usage {
    pub input: u64,
    pub output: u64,
}

#[derive(Debug, Clone)]
pub struct TurnRequest {
    /// The whole conversation so far: system, user, assistant (with tool_calls) and tool messages.
    pub messages: Vec<Value>,
    /// The tool definitions the model may call (only tools the gate would admit; a tool that is off is absent).
    pub tools: Vec<Value>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TurnResponse {
    pub text: String,
    pub tool_calls: Vec<ToolCall>,
    pub usage: Usage,
    pub model: String,
    pub ms: u64,
}

/// What a tool returns to the loop. `error` is a code word; `value` is what the model reads.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolResult {
    pub ok: bool,
    pub error: Option<String>,
    pub value: Value,
}

impl ToolResult {
    pub fn ok(value: Value) -> ToolResult {
        ToolResult { ok: true, error: None, value }
    }
    pub fn err(code: &str, detail: &str) -> ToolResult {
        ToolResult { ok: false, error: Some(code.to_string()), value: json!({ "error": code, "detail": detail }) }
    }
    /// The tool message content the model sees.
    pub fn to_message_content(&self) -> String {
        self.value.to_string()
    }
}

pub fn unix_ms() -> u64 {
    zumi_audit::unix_ms() as u64
}
