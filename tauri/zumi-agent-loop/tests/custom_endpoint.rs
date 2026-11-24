//! R3 goal check, engine part (F02, F54): one custom OpenAI-compatible endpoint, local or API. A loopback fixture endpoint
//! answers a chat turn; a non-added origin is refused 10/10; the whole task runs on it with an MCP tool of the user's.
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use zumi_agent_loop::cancel::Cancel;
use zumi_agent_loop::ledger::{Ledger, Prices};
use zumi_agent_loop::loop_run::StopReason;
use zumi_agent_loop::mcp_http::McpServerConfig;
use zumi_agent_loop::openai_compat::{CustomEndpoint, CustomTransport};
use zumi_agent_loop::runner::{run_task_with, ModelSource, TaskExtras, TaskOpts};
use zumi_agent_loop::transport::{ModelTransport, TransportError};
use zumi_agent_loop::types::TurnRequest;
use zumi_egress::fixture::{FixtureResp, Server};
use zumi_egress::Egress;

#[path = "common/mcp_fixture.rs"]
mod mcp_fixture;
use mcp_fixture::McpFixture;

fn endpoint(base: &str) -> CustomEndpoint {
    CustomEndpoint::from_json(&json!({ "baseUrl": base, "model": "llama3.1", "inputPerMtok": 0, "outputPerMtok": 0 }), &|_| None).unwrap()
}

fn egress_for(origin: Option<&str>) -> Arc<Egress> {
    let mut e = Egress::new(Arc::new(|_| {}));
    if let Some(o) = origin {
        e.add_user_origin(o).unwrap();
    }
    Arc::new(e)
}

fn chat_reply(content: Value, tool_calls: Value, usage: Value) -> String {
    json!({ "choices": [{ "message": { "role": "assistant", "content": content, "tool_calls": tool_calls } }], "usage": usage }).to_string()
}

fn req(user: &str) -> TurnRequest {
    TurnRequest { messages: vec![json!({ "role": "system", "content": "s" }), json!({ "role": "user", "content": user })], tools: vec![] }
}

#[test]
fn a_loopback_fixture_endpoint_answers_one_chat_turn() {
    let seen: Arc<Mutex<Vec<(String, String, String)>>> = Arc::default();
    let s2 = seen.clone();
    let server = Server::start(move |r| {
        s2.lock().unwrap().push((r.method.clone(), r.path.clone(), r.header("authorization").unwrap_or("").to_string()));
        s2.lock().unwrap().push(("body".into(), String::from_utf8_lossy(&r.body).to_string(), String::new()));
        FixtureResp::json(200, &chat_reply(json!("Xin chào anh Kei"), Value::Null, json!({ "prompt_tokens": 12, "completion_tokens": 5 })))
    });
    let base = format!("{}/v1", server.origin());
    let mut ep = endpoint(&base);
    ep.api_key = Some("sk-local-test".into());
    let mut t = CustomTransport::new(egress_for(Some(&server.origin())), ep);
    assert_eq!(t.model_id().as_deref(), Some("custom:llama3.1"));
    let r = t.turn(&req("chào"), &Cancel::new()).unwrap();
    assert_eq!(r.text, "Xin chào anh Kei");
    assert_eq!((r.usage.input, r.usage.output), (12, 5));
    assert_eq!(r.model, "custom:llama3.1");
    assert!(r.tool_calls.is_empty());
    let s = seen.lock().unwrap();
    assert_eq!((s[0].0.as_str(), s[0].1.as_str(), s[0].2.as_str()), ("POST", "/v1/chat/completions", "Bearer sk-local-test"));
    let body: Value = serde_json::from_str(&s[1].1).unwrap();
    assert_eq!(body["model"], "llama3.1");
    assert_eq!(body["messages"][1]["content"], "chào");
    assert_eq!(body["stream"], false);
    assert!(body["max_tokens"].as_u64().unwrap() <= 1000, "the same output bound as every engine");
    assert!(body.get("tools").is_none(), "no tools in the request when there are none");
}

#[test]
fn the_dots_in_tool_names_travel_as_double_underscores_and_come_back() {
    let server = Server::start(|r| {
        let b: Value = serde_json::from_slice(&r.body).unwrap();
        let wire_names: Vec<String> = b["tools"].as_array().unwrap().iter().map(|t| t["function"]["name"].as_str().unwrap().to_string()).collect();
        assert_eq!(wire_names, vec!["mcp__fixture__get_weather", "note__save"], "the wire name has no dot");
        assert_eq!(b["messages"][2]["tool_calls"][0]["function"]["name"], "note__save", "history is mapped too");
        assert_eq!(b["messages"][3]["name"], "note__save");
        FixtureResp::json(200, &chat_reply(Value::Null, json!([{ "id": "c9", "type": "function", "function": { "name": "mcp__fixture__get_weather", "arguments": "{\"city\":\"Hanoi\"}" } }, { "id": "c10", "type": "function", "function": { "name": "made__up", "arguments": "" } }]), json!({ "prompt_tokens": 40, "completion_tokens": 9 })))
    });
    let mut t = CustomTransport::new(egress_for(Some(&server.origin())), endpoint(&format!("{}/v1", server.origin())));
    let tool = |n: &str| json!({ "type": "function", "function": { "name": n, "description": "d", "parameters": { "type": "object" } } });
    let mut r = req("weather");
    r.tools = vec![tool("mcp.fixture.get_weather"), tool("note.save")];
    r.messages.push(json!({ "role": "assistant", "tool_calls": [{ "id": "c1", "type": "function", "function": { "name": "note.save", "arguments": "{}" } }] }));
    r.messages.push(json!({ "role": "tool", "tool_call_id": "c1", "name": "note.save", "content": "{}" }));
    let out = t.turn(&r, &Cancel::new()).unwrap();
    assert_eq!(out.tool_calls[0].name, "mcp.fixture.get_weather");
    assert_eq!(out.tool_calls[0].args, json!({ "city": "Hanoi" }));
    assert_eq!(out.tool_calls[1].name, "made__up", "a name the request never offered is passed on as it came; the gate refuses it");
    assert_eq!(out.tool_calls[1].args, json!({}), "empty arguments are an empty object");
}

#[test]
fn an_endpoint_the_user_did_not_add_is_refused_10_of_10_and_never_reached() {
    let server = Server::start(|_| FixtureResp::json(200, &chat_reply(json!("hi"), Value::Null, json!({ "prompt_tokens": 1, "completion_tokens": 1 }))));
    let added = Server::start(|_| FixtureResp::empty(500));
    let mut t = CustomTransport::new(egress_for(Some(&added.origin())), endpoint(&format!("{}/v1", server.origin())));
    for i in 0..10 {
        let e = t.turn(&req("x"), &Cancel::new()).unwrap_err();
        assert_eq!(e, TransportError::Failed("egress_host".into(), String::new()), "run {i}");
    }
    assert_eq!(server.hits(), 0);
    // pass twin: the same transport once the origin is added
    let mut t2 = CustomTransport::new(egress_for(Some(&server.origin())), endpoint(&format!("{}/v1", server.origin())));
    for i in 0..10 {
        assert_eq!(t2.turn(&req("x"), &Cancel::new()).unwrap().text, "hi", "run {i}");
    }
    assert_eq!(server.hits(), 10);
}

#[test]
fn the_endpoint_setting_follows_the_egress_rules_and_never_prints_the_key() {
    let env = |n: &str| (n == "MY_KEY").then(|| "sk-very-secret".to_string());
    let ok = |v: Value| CustomEndpoint::from_json(&v, &env);
    let base = json!({ "baseUrl": "https://api.example.com/v1/", "model": "m", "inputPerMtok": 0.5, "outputPerMtok": 1.5 });
    let e = ok(base.clone()).unwrap();
    assert_eq!(e.base_url, "https://api.example.com/v1", "no trailing slash");
    assert_eq!(e.api_key, None);
    let mut with_key = base.clone();
    with_key["apiKeyEnv"] = json!("MY_KEY");
    let k = ok(with_key.clone()).unwrap();
    assert_eq!(k.api_key.as_deref(), Some("sk-very-secret"));
    assert!(!format!("{k:?}").contains("sk-very-secret"), "Debug never shows the key");
    with_key["apiKeyEnv"] = json!("NOT_SET");
    assert!(ok(with_key).unwrap_err().contains("NOT_SET"), "a named variable that is not set is an error, not a silent no-key call");
    for missing in ["baseUrl", "model", "inputPerMtok", "outputPerMtok"] {
        let mut v = base.clone();
        v.as_object_mut().unwrap().remove(missing);
        assert!(ok(v).unwrap_err().contains(missing), "{missing}");
    }
    let mut neg = base.clone();
    neg["inputPerMtok"] = json!(-1);
    assert!(ok(neg).is_err(), "a price is not negative");
    // origin rules
    let mut e = Egress::new(Arc::new(|_| {}));
    for (url, code) in [("http://api.example.com/v1", Some("egress_scheme")), ("https://10.0.0.8/v1", Some("egress_private")), ("https://user:pw@api.example.com/v1", Some("egress_userinfo")), ("http://127.0.0.1:11434/v1", None), ("http://localhost:11434/v1", None), ("https://api.example.com/v1", None)] {
        let mut v = base.clone();
        v["baseUrl"] = json!(url);
        let r = ok(v).unwrap().allow_origin(&mut e);
        assert_eq!(r.err().map(|x| x.code()), code, "{url}");
    }
}

#[test]
fn bad_replies_are_failures_not_guesses() {
    let go = |status: u16, body: &str| {
        let body = body.to_string();
        let server = Server::start(move |_| FixtureResp::json(status, &body));
        let mut t = CustomTransport::new(egress_for(Some(&server.origin())), endpoint(&format!("{}/v1", server.origin())));
        t.turn(&req("x"), &Cancel::new())
    };
    let code = |r: Result<zumi_agent_loop::types::TurnResponse, TransportError>| match r {
        Err(TransportError::Failed(c, _)) => c,
        other => format!("unexpected {other:?}"),
    };
    let usage = json!({ "prompt_tokens": 1, "completion_tokens": 1 });
    assert_eq!(code(go(401, "{}")), "model_auth");
    assert_eq!(code(go(403, "{}")), "model_auth");
    assert_eq!(code(go(500, "{}")), "model_http_500");
    assert_eq!(code(go(200, "not json")), "bad_model_reply");
    assert_eq!(code(go(200, &json!({ "choices": [], "usage": usage }).to_string())), "bad_model_reply");
    assert_eq!(code(go(200, &json!({ "choices": [{ "message": { "content": "x" } }] }).to_string())), "bad_model_reply", "no usage: the cost cannot be known");
    assert_eq!(code(go(200, &chat_reply(json!("x"), json!([{ "function": { "name": "a", "arguments": "{oops" } }]), usage.clone()))), "bad_model_reply");
    assert_eq!(code(go(200, &chat_reply(json!("x"), json!([{ "function": { "name": "a", "arguments": "[1]" } }]), usage))), "bad_model_reply", "arguments must be an object");
}

#[test]
fn a_cancel_ends_a_slow_turn_at_once() {
    let server = Server::start(|_| FixtureResp::Chunked { status: 200, headers: vec![], chunks: vec![(3000, b"{}".to_vec())] });
    let mut t = CustomTransport::new(egress_for(Some(&server.origin())), endpoint(&format!("{}/v1", server.origin())));
    let cancel = Cancel::new();
    let c2 = cancel.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(150));
        c2.set("cancelled");
    });
    let t0 = std::time::Instant::now();
    assert_eq!(t.turn(&req("x"), &cancel), Err(TransportError::Cancelled));
    assert!(t0.elapsed() < std::time::Duration::from_millis(800));
}

fn task_opts(dir: &std::path::Path, ep: CustomEndpoint, sentence: &str) -> TaskOpts {
    TaskOpts {
        task_id: "t-r3".into(),
        sentence: sentence.into(),
        model: ModelSource::Custom(ep),
        hands: None,
        notes: None,
        reminders: None,
        loop_audit: dir.join("audit.jsonl"),
        prior_usd: Ok(0.0),
        max_total_usd: Some(0.5),
        cancel: Cancel::new(),
    }
}

#[test]
fn a_whole_task_runs_on_the_custom_endpoint_with_an_mcp_tool_and_is_priced_at_the_users_price() {
    let mcp = McpFixture::start();
    // The endpoint plays a model: first it asks for the weather tool, then it answers with what the tool returned.
    let turn = Arc::new(Mutex::new(0usize));
    let t2 = turn.clone();
    let model = Server::start(move |r| {
        let b: Value = serde_json::from_slice(&r.body).unwrap();
        let mut n = t2.lock().unwrap();
        *n += 1;
        if *n == 1 {
            assert!(b["tools"].as_array().unwrap().iter().any(|t| t["function"]["name"] == "mcp__fixture__get_weather"));
            FixtureResp::json(200, &chat_reply(Value::Null, json!([{ "id": "c1", "type": "function", "function": { "name": "mcp__fixture__get_weather", "arguments": "{\"city\":\"Hanoi\"}" } }]), json!({ "prompt_tokens": 100, "completion_tokens": 10 })))
        } else {
            let tool_msg = b["messages"].as_array().unwrap().iter().find(|m| m["role"] == "tool").expect("the tool result is in the history");
            assert!(tool_msg["content"].as_str().unwrap().contains("kumquat-7"));
            FixtureResp::json(200, &chat_reply(json!("It is 31 C in Hanoi (kumquat-7)."), Value::Null, json!({ "prompt_tokens": 200, "completion_tokens": 20 })))
        }
    });
    let dir = std::env::temp_dir().join(format!("zumi-r3-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let mut ep = endpoint(&format!("{}/v1", model.origin()));
    ep.input_per_mtok = 1.0;
    ep.output_per_mtok = 2.0;
    let prices = Prices::from_json(&json!({})).unwrap().with_model(&ep.ledger_model(), ep.input_per_mtok, ep.output_per_mtok);
    let mut ledger = Ledger::new(dir.clone(), prices, "t-r3");
    let extras = TaskExtras { mcp_servers: vec![McpServerConfig::from_json("fixture", &json!({ "url": mcp.url(), "enabled": true })).unwrap()], ..Default::default() };
    let mut events: Vec<Value> = Vec::new();
    let out = run_task_with(task_opts(&dir, ep, "What is the weather in Hanoi? Use the weather tool."), extras, &mut ledger, &mut |v| events.push(v)).unwrap();
    assert_eq!(out.stop, StopReason::Done, "{events:?}");
    assert!(out.final_text.contains("kumquat-7"));
    assert_eq!(*turn.lock().unwrap(), 2);
    assert_eq!(mcp.calls("tools/call").len(), 1);
    assert_eq!(mcp.calls("tools/call")[0].args, json!({ "city": "Hanoi" }));
    assert!(events.iter().any(|e| e["ev"] == "mcp" && e["server"] == "fixture" && e["ok"] == true && e["tools"] == 8 && e["usable"] == 7), "{events:?}");
    // 300 tokens in, 30 out at the user's price: 300/1e6*1 + 30/1e6*2
    let spent = zumi_agent_loop::ledger::total_agent_cost_usd(&dir).unwrap();
    assert!((spent - 0.00036).abs() < 1e-9, "{spent}");
    assert_eq!(mcp.calls("").len(), 1, "the session was closed");
    let audit = std::fs::read_to_string(dir.join("audit.jsonl")).unwrap();
    assert!(audit.contains("tool:mcp.fixture.get_weather"), "{audit}");
    // The tool's RESULT never enters the audit (its lines carry a byte count); the model's own words do, per turn, so the answer
    // that repeats the result is in its `model_text` line and nowhere else.
    let leaks: Vec<&str> = audit.lines().filter(|l| l.contains("kumquat") && !l.contains("\"model_text\"")).collect();
    assert!(leaks.is_empty(), "no tool line carries the result text: {leaks:?}");
    assert!(audit.lines().any(|l| l.contains("\"model_text\"") && l.contains("kumquat-7")), "the model's answer is in the audit");
}

#[test]
fn a_custom_endpoint_without_a_price_in_the_table_makes_no_call() {
    let model = Server::start(|_| FixtureResp::json(200, &chat_reply(json!("hi"), Value::Null, json!({ "prompt_tokens": 1, "completion_tokens": 1 }))));
    let dir = std::env::temp_dir().join(format!("zumi-r3-np-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let ep = endpoint(&format!("{}/v1", model.origin()));
    let mut ledger = Ledger::new(dir.clone(), Prices::from_json(&json!({})).unwrap(), "t");
    let out = run_task_with(task_opts(&dir, ep, "hello"), TaskExtras::default(), &mut ledger, &mut |_| {}).unwrap();
    assert_eq!(out.stop, StopReason::CostUnknown);
    assert_eq!(model.hits(), 0);
}

#[test]
fn a_server_that_does_not_answer_is_left_out_and_the_task_goes_on() {
    let model = Server::start(|_| FixtureResp::json(200, &chat_reply(json!("done"), Value::Null, json!({ "prompt_tokens": 1, "completion_tokens": 1 }))));
    let dead = Server::start(|_| FixtureResp::empty(500));
    let dir = std::env::temp_dir().join(format!("zumi-r3-dead-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let ep = endpoint(&format!("{}/v1", model.origin()));
    let mut ledger = Ledger::new(dir.clone(), Prices::from_json(&json!({})).unwrap().with_model(&ep.ledger_model(), 0.0, 0.0), "t");
    let extras = TaskExtras {
        mcp_servers: vec![
            McpServerConfig::from_json("dead", &json!({ "url": format!("{}/mcp", dead.origin()), "enabled": true })).unwrap(),
            McpServerConfig::from_json("off", &json!({ "url": "https://example.com/mcp" })).unwrap(),
            McpServerConfig::from_json("lan", &json!({ "url": "https://192.168.1.9/mcp", "enabled": true })).unwrap(),
        ],
        ..Default::default()
    };
    let mut events: Vec<Value> = Vec::new();
    let out = run_task_with(task_opts(&dir, ep, "hello"), extras, &mut ledger, &mut |v| events.push(v)).unwrap();
    assert_eq!(out.stop, StopReason::Done);
    let mcp: Vec<(String, bool, String)> = events.iter().filter(|e| e["ev"] == "mcp").map(|e| (e["server"].as_str().unwrap().to_string(), e["ok"].as_bool().unwrap(), e["error"].as_str().unwrap_or("").to_string())).collect();
    assert_eq!(mcp, vec![("lan".to_string(), false, "egress_private".to_string()), ("dead".to_string(), false, "mcp_http_500".to_string())], "{events:?}");
}

/// R3 gate blocking item 2: a hosted endpoint priced 0 makes the cap pre-check 0, so the caps never bite and the ledger books 0
/// for real spend. A price of 0 is for a model on this PC only (a loopback origin the user added).
#[test]
fn h_r3_a_public_endpoint_cannot_be_priced_zero_but_a_loopback_one_can() {
    let mk = |url: &str, i: f64, o: f64| CustomEndpoint::from_json(&json!({ "baseUrl": url, "model": "m", "inputPerMtok": i, "outputPerMtok": o }), &|_| None);
    for (url, i, o) in [("https://api.example.com/v1", 0.0, 0.0), ("https://api.example.com/v1", 0.5, 0.0), ("https://api.example.com/v1", 0.0, 1.5), ("https://localtest.me:9/v1", 0.0, 0.0), ("https://10.0.0.8/v1", 0.0, 0.0)] {
        let r = mk(url, i, o);
        assert!(r.as_ref().is_err_and(|e| e.contains("price")), "{url} {i}/{o} must be refused for its price: {r:?}");
    }
    for (url, i, o) in [("https://api.example.com/v1", 0.5, 1.5), ("http://127.0.0.1:11434/v1", 0.0, 0.0), ("http://localhost:11434/v1", 0.0, 0.0), ("http://[::1]:11434/v1", 0.0, 0.0), ("http://127.0.0.1:11434/v1", 0.2, 0.2)] {
        assert!(mk(url, i, o).is_ok(), "{url} {i}/{o}");
    }
}
