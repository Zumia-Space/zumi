//! Stdio line-JSON protocol: one request object per stdin line, one response object per stdout line.
//!
//!   request : {"id": <any JSON>, "cmd": "<verb>", ...args}
//!   response: {"id": <echoed>, "ok": true, "result": {...}}  or  {"id": <echoed>, "ok": false, "error": "<code>", "detail": "<text>"}
//!
//! A malformed line never ends the loop: it gets an error response with id null. P0 verbs are read-only
//! (ping, windows, snapshot); there is no verb that injects input, invokes a pattern or sets a value.
use serde_json::{json, Map, Value};

/// What a verb handler returns: a result object, or (error code, human detail).
pub type VerbResult = Result<Value, (&'static str, String)>;

/// Parses one line and dispatches it. `dispatch` maps (verb, args) to a result; it is a parameter so the protocol
/// is testable without UI Automation.
pub fn handle_line(line: &str, dispatch: &mut dyn FnMut(&str, &Map<String, Value>) -> VerbResult) -> Value {
    let parsed: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => return error(Value::Null, "bad_json", e.to_string()),
    };
    let Value::Object(obj) = parsed else {
        return error(Value::Null, "bad_request", "request must be a JSON object".into());
    };
    let id = obj.get("id").cloned().unwrap_or(Value::Null);
    let Some(cmd) = obj.get("cmd").and_then(Value::as_str) else {
        return error(id, "bad_request", "missing string field cmd".into());
    };
    match dispatch(cmd, &obj) {
        Ok(result) => json!({ "id": id, "ok": true, "result": result }),
        Err((code, detail)) => error(id, code, detail),
    }
}

fn error(id: Value, code: &str, detail: String) -> Value {
    json!({ "id": id, "ok": false, "error": code, "detail": detail })
}

/// Reads an unsigned integer argument that may be given as a JSON number or a decimal/0x-hex string
/// (HWNDs are printed as hex by most tools).
pub fn arg_u64(args: &Map<String, Value>, name: &str) -> Option<u64> {
    match args.get(name)? {
        Value::Number(n) => n.as_u64(),
        Value::String(s) => parse_u64(s),
        _ => None,
    }
}

pub fn parse_u64(s: &str) -> Option<u64> {
    let s = s.trim();
    match s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
        Some(hex) => u64::from_str_radix(hex, 16).ok(),
        None => s.parse().ok(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn echo(cmd: &str, _args: &Map<String, Value>) -> VerbResult {
        match cmd {
            "ping" => Ok(json!("pong")),
            _ => Err(("unknown_cmd", cmd.to_string())),
        }
    }

    #[test]
    fn ping_echoes_id_and_answers_pong() {
        let r = handle_line(r#"{"id":7,"cmd":"ping"}"#, &mut echo);
        assert_eq!(r, json!({"id":7,"ok":true,"result":"pong"}));
    }

    #[test]
    fn unknown_verb_is_an_error_not_a_crash() {
        let r = handle_line(r#"{"id":"a","cmd":"click"}"#, &mut echo);
        assert_eq!(r["ok"], json!(false));
        assert_eq!(r["error"], json!("unknown_cmd"));
        assert_eq!(r["id"], json!("a"));
    }

    #[test]
    fn malformed_lines_get_error_responses() {
        assert_eq!(handle_line("not json", &mut echo)["error"], json!("bad_json"));
        assert_eq!(handle_line("[1,2]", &mut echo)["error"], json!("bad_request"));
        assert_eq!(handle_line(r#"{"id":1}"#, &mut echo)["error"], json!("bad_request"));
    }

    #[test]
    fn u64_args_accept_numbers_and_hex_strings() {
        let m: Map<String, Value> = serde_json::from_str(r#"{"a":42,"b":"0x1A","c":"17","d":true}"#).unwrap();
        assert_eq!(arg_u64(&m, "a"), Some(42));
        assert_eq!(arg_u64(&m, "b"), Some(26));
        assert_eq!(arg_u64(&m, "c"), Some(17));
        assert_eq!(arg_u64(&m, "d"), None);
        assert_eq!(arg_u64(&m, "missing"), None);
    }
}
