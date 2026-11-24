//! R7 K0a goal check, end to end with a REAL helper process (`power.canary`, feature `canary`): the helper tries ten out-of-scope spawns,
//! paths, origins and listeners through the helper protocol. Each is refused and each is an audit line written by the host. A bite case
//! runs the same kinds of request against a pack whose manifest declares them, and they pass: the check can tell the two apart.
#![allow(dead_code)]
mod common;
use common::*;
use serde_json::{json, Value};

fn caps(listen: u16, fixture_origin: &str) -> Value {
    json!([
        { "id": "proc.spawn", "scope": { "programs": ["hostname"], "cwd": "workspace", "shell": false } },
        { "id": "fs.read", "scope": { "roots": ["pack-data"] } },
        { "id": "fs.write", "scope": { "roots": ["pack-data"] } },
        { "id": "net.egress", "scope": { "origins": [fixture_origin] } },
        { "id": "net.listen", "scope": { "bind": "loopback", "ports": [listen] } }
    ])
}

fn out_of_scope(h: &Host, listen: u16, spare: u16, fixture_port: u16) -> Vec<Value> {
    let state = h.packs.state_dir(ID);
    let p = |x: std::path::PathBuf| x.to_string_lossy().into_owned();
    let mut v = Vec::new();
    for program in ["whoami", "cmd", "powershell", r"C:\Windows\System32\whoami.exe", r".\hostname.exe", r"..\..\evil.exe", "", "calc", "ping", "cmd.exe /c calc"] {
        v.push(json!({ "op": "spawn", "program": program }));
    }
    for path in [
        r"C:\Windows\win.ini".to_string(),
        p(state.join("consent.jsonl")),
        p(state.join("grants.json")),
        p(state.join("data").join("..").join("consent.jsonl")),
        r"\\localhost\c$\Windows\win.ini".to_string(),
        r"\\?\C:\Windows\win.ini".to_string(),
        p(state.join("data").join("x.txt:hidden")),
        "relative.txt".to_string(),
        p(h.packs.pack_dir(ID).join("zumi-pack.json")),
        p(h.root.join("data").join("audit").join(ID).join("HEAD")),
    ] {
        v.push(json!({ "op": "read", "path": path }));
    }
    for url in [
        "https://evil.example/".to_string(),
        format!("http://localhost:{fixture_port}/"),
        format!("http://127.0.0.1:{}/", fixture_port.wrapping_add(1)),
        format!("http://user:pw@127.0.0.1:{fixture_port}/"),
        "http://169.254.169.254/latest/meta-data".to_string(),
        "ftp://127.0.0.1/".to_string(),
        "file:///C:/Windows/win.ini".to_string(),
        "not a url".to_string(),
        "https://127.0.0.1.evil.example/".to_string(),
        "https://example.com/".to_string(),
    ] {
        v.push(json!({ "op": "connect", "url": url, "method": "GET" }));
    }
    for (bind, port) in [("loopback", spare), ("lan", listen), ("tunnel", listen), ("0.0.0.0", listen), ("", listen), ("127.0.0.1", listen), ("loopback", 0), ("loopback", 80), ("LAN", listen), ("lan", spare)] {
        v.push(json!({ "op": "listen", "bind": bind, "port": port }));
    }
    v
}

#[test]
fn a_real_helper_trying_everything_out_of_scope_is_refused_40_of_40_and_audited_40_of_40() {
    let server = zumi_egress::fixture::Server::start(|_| zumi_egress::fixture::FixtureResp::json(200, "{}"));
    let (listen, spare) = (free_port(), free_port());
    let h = canary_host("canary40", caps(listen, "https://api.allowed.example"));
    h.packs.install(&h.src).unwrap();
    let attempts = out_of_scope(&h, listen, spare, server.port());
    assert_eq!(attempts.len(), 40);
    h.run_canary(Value::Array(attempts), true);
    let report = wait_for(20, || h.report()).expect("the canary reported");
    let answers = report.as_array().unwrap();
    assert_eq!(answers.len(), 40);
    for (i, a) in answers.iter().enumerate() {
        assert_eq!(a["answer"]["ok"], false, "attempt {i} {} was NOT refused: {}", a["attempt"], a["answer"]);
        let code = a["answer"]["code"].as_str().unwrap();
        assert!(!code.contains(['\\', '/', ':']), "the answer carries only a code word: {code}");
    }
    // by kind: ten each
    for (kind, range) in [("spawn", 0..10), ("read", 10..20), ("connect", 20..30), ("listen", 30..40)] {
        assert!(range.clone().all(|i| answers[i]["attempt"]["op"] == kind), "{kind}");
    }
    let rows = h.packs.audit().rows(ID).unwrap();
    let refused: Vec<_> = rows.iter().filter(|r| r["decision"] == "refused-scope" && r["event"] == "action").collect();
    assert_eq!(refused.len(), 40, "every refusal is an audit line written by the host");
    for cap in ["proc.spawn", "fs.read", "net.egress", "net.listen"] {
        assert_eq!(refused.iter().filter(|r| r["capability"] == cap).count(), 10, "{cap}");
    }
    assert_eq!(rows.iter().filter(|r| r["decision"] == "allowed" && r["event"] == "action").count(), 1, "only the report write itself was allowed");
    assert_eq!(server.hits(), 0, "nothing reached the fixture server");
    for port in [listen, spare] {
        assert!(std::net::TcpStream::connect(("127.0.0.1", port)).is_err(), "port {port} stayed closed");
    }
    assert_eq!(h.packs.audit().verify(ID), Ok(rows.len()));
    assert_eq!(std::fs::read_to_string(h.packs.state_dir(ID).join("grants.json")).is_err(), true, "the helper did not make a grants file");
}

#[test]
fn bite_the_same_kinds_of_request_pass_when_the_manifest_declares_them() {
    let server = zumi_egress::fixture::Server::start(|_| zumi_egress::fixture::FixtureResp::json(200, "{}"));
    let (listen, other) = (free_port(), free_port());
    let origin = server.origin();
    let h = canary_host("canarybite", json!([
        { "id": "proc.spawn", "scope": { "programs": ["whoami", "hostname"], "cwd": "workspace", "shell": false } },
        { "id": "fs.read", "scope": { "roots": ["pack-data"] } },
        { "id": "fs.write", "scope": { "roots": ["pack-data"] } },
        { "id": "net.egress", "scope": { "origins": [origin.clone()] } },
        { "id": "net.listen", "scope": { "bind": "loopback", "ports": [listen, other] } }
    ]));
    h.packs.install(&h.src).unwrap();
    h.packs.set_grants(ID, &zumi_packs::scope::Grants { origins: vec![origin.clone()], ..Default::default() }).unwrap();
    let data = h.packs.state_dir(ID).join("data");
    std::fs::write(data.join("own.txt"), "mine").unwrap();
    let attempts = json!([
        { "op": "spawn", "program": "whoami" },
        { "op": "read", "path": data.join("own.txt").to_string_lossy() },
        { "op": "connect", "url": format!("{origin}/"), "method": "GET" },
        { "op": "listen", "bind": "loopback", "port": listen }
    ]);
    h.run_canary(attempts, true);
    let report = wait_for(20, || h.report()).expect("report");
    for a in report.as_array().unwrap() {
        assert_eq!(a["answer"]["ok"], true, "{} should pass when declared: {}", a["attempt"], a["answer"]);
    }
    assert_eq!(server.hits(), 1);
    assert!(std::net::TcpStream::connect(("127.0.0.1", listen)).is_ok());
}
