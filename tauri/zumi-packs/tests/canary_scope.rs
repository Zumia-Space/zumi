//! R7 K0a goal check: a pack helper may spawn, read, write, connect and listen only inside its declared manifest scope.
//! Out of scope, each of spawn, path, origin and listener is refused 10/10 and audited 10/10; in scope each passes 10/10.
//! (The broker is what a helper's request reaches; the helper itself has no call of its own: layer 1.)
mod common;
use common::*;
use serde_json::json;
use std::path::Path;
use zumi_packs::scope::Grants;

fn spawn_caps() -> serde_json::Value {
    json!([{ "id": "proc.spawn", "scope": { "programs": ["hostname"], "cwd": "workspace", "shell": false } }])
}

#[test]
fn spawn_in_scope_passes_10_of_10_and_each_start_is_audited_before_it_acts() {
    let w = world("spawn-in", spawn_caps(), |ws, _| Grants { workspace: Some(ws.to_path_buf()), ..Default::default() });
    for i in 0..10 {
        let pid = w.broker.spawn(ID, "hostname", &[], Some(&w.workspace)).unwrap_or_else(|c| panic!("run {i}: {c}"));
        assert!(pid > 0);
    }
    assert_eq!(w.rows("allowed").len(), 10, "one allowed row per start");
    assert_eq!(w.audit.verify(ID), Ok(10));
}

#[test]
fn spawn_out_of_scope_is_refused_10_of_10_and_audited_10_of_10() {
    let w = world("spawn-out", spawn_caps(), |ws, out| Grants { workspace: Some(ws.to_path_buf()), paths: vec![out.to_path_buf()], ..Default::default() });
    // a planted program in the workspace: a bare name must never resolve there
    let planted = w.workspace.join("hostname.exe");
    std::fs::copy(r"C:\Windows\System32\hostname.exe", &planted).unwrap();
    let attempts: Vec<(&str, String)> = vec![
        ("a program not in the list", "whoami".into()),
        ("a shell, not declared", "cmd".into()),
        ("a shell with .exe", "cmd.exe".into()),
        ("powershell", "powershell".into()),
        ("an absolute path to an unlisted program", r"C:\Windows\System32\whoami.exe".into()),
        ("an absolute path to the listed name, not granted", r"C:\Windows\System32\hostname.exe".into()),
        ("the planted copy by path", planted.to_string_lossy().into_owned()),
        ("a relative path", r".\hostname.exe".into()),
        ("a path with a traversal", r"..\..\Windows\System32\whoami.exe".into()),
        ("empty", "".into()),
    ];
    assert_eq!(attempts.len(), 10);
    for (what, program) in &attempts {
        let r = w.broker.spawn(ID, program, &[], None);
        assert!(r.is_err(), "{what} must be refused, got pid {r:?}");
    }
    assert_eq!(w.rows("refused-scope").len(), 10, "every refusal is an audit line");
    assert_eq!(w.rows("allowed").len(), 0, "no start was allowed");
    // and a bare in-list name still goes to the system copy, never to the workspace one
    let manifest = zumi_packs::manifest::Manifest::parse(&manifest_text(spawn_caps())).unwrap();
    let grants = Grants { workspace: Some(w.workspace.clone()), ..Default::default() };
    let env = zumi_packs::scope::Env { pack_data: w.pack_data.clone(), protected: vec![w.data.clone()] };
    let allowed = zumi_packs::scope::decide(&manifest, &grants, &env, &zumi_packs::scope::Action::Spawn { program: "hostname", args: &[], cwd: None }).unwrap();
    match allowed {
        zumi_packs::scope::Allowed::Spawn { exe, .. } => assert!(!exe.starts_with(&w.workspace), "resolved into the workspace: {exe:?}"),
        other => panic!("{other:?}"),
    }
}

fn fs_caps() -> serde_json::Value {
    json!([
        { "id": "fs.read", "scope": { "roots": ["pack-data", "workspace"] } },
        { "id": "fs.write", "scope": { "roots": ["pack-data", "workspace"] } }
    ])
}

fn junction(link: &Path, target: &Path) {
    let s = std::process::Command::new("cmd").args(["/c", "mklink", "/J"]).arg(link).arg(target).output().unwrap();
    assert!(s.status.success(), "mklink: {}", String::from_utf8_lossy(&s.stdout));
}

#[test]
fn paths_in_scope_read_and_write_10_of_10() {
    let w = world("path-in", fs_caps(), |ws, _| Grants { workspace: Some(ws.to_path_buf()), ..Default::default() });
    for i in 0..10 {
        let f = if i % 2 == 0 { w.workspace.join(format!("a{i}.txt")) } else { w.pack_data.join(format!("b{i}.txt")) };
        w.broker.write(ID, &f, format!("hello {i}").as_bytes()).unwrap_or_else(|c| panic!("write {i}: {c}"));
        assert_eq!(w.broker.read(ID, &f).unwrap_or_else(|c| panic!("read {i}: {c}")), format!("hello {i}").as_bytes());
    }
    assert_eq!(w.rows("allowed").len(), 20);
}

#[test]
fn paths_out_of_scope_are_refused_10_of_10_and_audited_10_of_10() {
    let w = world("path-out", fs_caps(), |ws, _| Grants { workspace: Some(ws.to_path_buf()), ..Default::default() });
    let secret = w.outside.join("secret.txt");
    std::fs::write(&secret, "do not read").unwrap();
    junction(&w.workspace.join("link"), &w.outside);
    let other_pack = w.data.join("packs-state").join("power.other").join("data");
    std::fs::create_dir_all(&other_pack).unwrap();
    std::fs::write(other_pack.join("token.txt"), "other pack").unwrap();
    let attempts: Vec<(&str, std::path::PathBuf)> = vec![
        ("a folder outside every root", secret.clone()),
        ("a traversal out of the workspace", w.workspace.join("..").join("outside").join("secret.txt")),
        ("a junction inside the workspace leading out", w.workspace.join("link").join("secret.txt")),
        ("another pack folder", other_pack.join("token.txt")),
        ("the packs-state folder of another pack", w.data.join("packs-state").join("power.other")),
        ("a relative path", "secret.txt".into()),
        ("a UNC path", r"\\localhost\c$\Windows\win.ini".into()),
        ("a device path", r"\\?\C:\Windows\win.ini".into()),
        ("a stream name", w.workspace.join("x.txt:hidden")),
        ("a sibling whose name starts like the root", std::path::PathBuf::from(format!("{}-evil\\a.txt", w.workspace.display()))),
    ];
    assert_eq!(attempts.len(), 10);
    for (what, p) in &attempts {
        assert!(w.broker.read(ID, p).is_err(), "read of {what} must be refused");
    }
    // writes out of scope: nothing lands outside
    for (what, p) in &attempts {
        assert!(w.broker.write(ID, p, b"x").is_err(), "write to {what} must be refused");
    }
    assert_eq!(std::fs::read_to_string(&secret).unwrap(), "do not read");
    assert_eq!(w.rows("refused-scope").len(), 20, "every refusal is an audit line");
    assert_eq!(w.rows("allowed").len(), 0);
    // a write into the junction must not land in the folder it points at
    assert!(w.broker.write(ID, &w.workspace.join("link").join("new.txt"), b"x").is_err());
    assert!(!w.outside.join("new.txt").exists());
}

fn net_caps(origin: &str) -> serde_json::Value {
    json!([{ "id": "net.egress", "scope": { "origins": [origin] } }])
}

#[test]
fn origins_in_scope_pass_10_of_10_and_out_of_scope_never_reach_the_server() {
    let server = zumi_egress::fixture::Server::start(|_| zumi_egress::fixture::FixtureResp::json(200, "{}"));
    let origin = server.origin();
    let w = world("origin", net_caps(&origin), |_, _| Grants { origins: vec![origin.clone()], ..Default::default() });
    for i in 0..10 {
        let (status, _) = w.broker.connect(ID, "GET", &format!("{origin}/ping?i={i}")).unwrap_or_else(|c| panic!("run {i}: {c}"));
        assert_eq!(status, 200);
    }
    assert_eq!(server.hits(), 10);
    let port = server.port();
    let attempts = vec![
        "https://evil.example/".to_string(),
        format!("http://localhost:{port}/"),                   // the same server by another name
        format!("http://127.0.0.1:{}/", port.wrapping_add(1)), // another port
        format!("https://127.0.0.1:{port}/"),                  // another scheme
        format!("http://user:pw@127.0.0.1:{port}/"),           // userinfo
        "http://169.254.169.254/latest/meta-data".to_string(),
        "ftp://127.0.0.1/".to_string(),
        "file:///C:/Windows/win.ini".to_string(),
        "not a url".to_string(),
        "https://127.0.0.1.evil.example/".to_string(),
    ];
    assert_eq!(attempts.len(), 10);
    for a in &attempts {
        assert!(w.broker.connect(ID, "GET", a).is_err(), "{a} must be refused");
    }
    assert_eq!(server.hits(), 10, "a refused request never reached the server");
    assert_eq!(w.rows("refused-scope").len(), 10);
    assert_eq!(w.rows("allowed").len(), 10);
    // the audit line names an origin, never a path, query or password
    let text = std::fs::read_dir(w.audit.pack_dir(ID)).unwrap().flatten().filter(|e| e.path().extension().is_some_and(|x| x == "jsonl")).map(|e| std::fs::read_to_string(e.path()).unwrap()).collect::<String>();
    assert!(!text.contains("i=3") && !text.contains(":pw@"), "no query or password in the audit");
}

#[test]
fn a_pack_with_no_origin_granted_reaches_nothing_even_if_the_manifest_names_one() {
    let server = zumi_egress::fixture::Server::start(|_| zumi_egress::fixture::FixtureResp::json(200, "{}"));
    let origin = server.origin();
    // the manifest ceiling names the origin, the user granted none
    let w = world("origin-nogrant", net_caps(&origin), |_, _| Grants::default());
    for _ in 0..10 {
        assert!(w.broker.connect(ID, "GET", &format!("{origin}/")).is_err());
    }
    assert_eq!(server.hits(), 0);
}

#[test]
fn listeners_in_scope_open_10_of_10_and_out_of_scope_never_open() {
    let ports: Vec<u16> = (0..10).map(|_| free_port()).collect();
    let caps = json!([{ "id": "net.listen", "scope": { "bind": "loopback", "ports": ports } }]);
    let w = world("listen", caps, |_, _| Grants::default());
    for p in &ports {
        assert_eq!(w.broker.listen(ID, "loopback", *p), Ok(*p));
        assert!(std::net::TcpStream::connect(("127.0.0.1", *p)).is_ok(), "port {p} is open");
    }
    let spare = free_port();
    let attempts: Vec<(&str, &str, u16)> = vec![
        ("a port the manifest did not declare", "loopback", spare),
        ("port zero", "loopback", 0),
        ("lan when the manifest says loopback", "lan", ports[0]),
        ("tunnel", "tunnel", ports[0]),
        ("all interfaces by name", "0.0.0.0", ports[0]),
        ("a bind word that is not one", "", ports[1]),
        ("an address instead of a word", "127.0.0.1", ports[1]),
        ("lan on another port", "lan", spare),
        ("upper case", "LAN", ports[2]),
        ("a privileged port", "loopback", 80),
    ];
    assert_eq!(attempts.len(), 10);
    for (what, bind, port) in &attempts {
        assert!(w.broker.listen(ID, bind, *port).is_err(), "{what} must be refused");
    }
    assert!(std::net::TcpStream::connect(("127.0.0.1", spare)).is_err(), "the undeclared port stayed closed");
    assert_eq!(w.rows("refused-scope").len(), 10);
    assert_eq!(w.rows("allowed").len(), 10);
}

#[test]
fn lan_needs_the_manifest_and_the_users_separate_grant() {
    let p = free_port();
    let caps = json!([{ "id": "net.listen", "scope": { "bind": "lan", "ports": [p] } }]);
    let w = world("lan-nogrant", caps.clone(), |_, _| Grants::default());
    assert!(w.broker.listen(ID, "lan", p).is_err(), "declared but not granted");
    let w2 = world("lan-grant", caps, |_, _| Grants { lan: true, ..Default::default() });
    assert_eq!(w2.broker.listen(ID, "lan", p), Ok(p));
}

#[test]
fn a_capability_the_manifest_never_declared_is_refused_whatever_the_scope_of_another() {
    let w = world("nocap", json!([{ "id": "fs.read", "scope": { "roots": ["workspace"] } }]), |ws, _| Grants { workspace: Some(ws.to_path_buf()), ..Default::default() });
    assert!(w.broker.spawn(ID, "hostname", &[], None).is_err());
    assert!(w.broker.write(ID, &w.workspace.join("x"), b"x").is_err());
    assert!(w.broker.connect(ID, "GET", "https://example.com/").is_err());
    assert!(w.broker.listen(ID, "loopback", free_port()).is_err());
    assert_eq!(w.rows("refused-scope").len(), 4);
}

#[test]
fn the_helper_protocol_answers_with_a_code_word_never_a_path() {
    let w = world("proto", fs_caps(), |ws, _| Grants { workspace: Some(ws.to_path_buf()), ..Default::default() });
    let secret = w.outside.join("s.txt");
    std::fs::write(&secret, "x").unwrap();
    let reply = w.broker.request(ID, &json!({ "op": "read", "path": secret.to_string_lossy() }).to_string());
    let v: serde_json::Value = serde_json::from_str(&reply).unwrap();
    assert_eq!(v["ok"], false);
    assert!(v["code"].as_str().is_some_and(|c| !c.contains('\\') && !c.contains('/')), "{reply}");
    assert!(!reply.contains("s.txt") && !reply.contains("zumi-packs"), "the answer does not echo the path");
    for bad in ["", "not json", r#"{"op":"exec","cmd":"calc"}"#, r#"{"op":"spawn"}"#, r#"{"op":"listen","bind":"loopback","port":70000}"#] {
        let v: serde_json::Value = serde_json::from_str(&w.broker.request(ID, bad)).unwrap();
        assert_eq!(v["ok"], false, "{bad:?}");
    }
    let ok = w.broker.request(ID, &json!({ "op": "write", "path": w.workspace.join("n.txt").to_string_lossy(), "text": "hi" }).to_string());
    assert_eq!(serde_json::from_str::<serde_json::Value>(&ok).unwrap()["ok"], true);
}

#[test]
fn a_pack_that_is_not_registered_has_no_door() {
    let w = world("unreg", fs_caps(), |ws, _| Grants { workspace: Some(ws.to_path_buf()), ..Default::default() });
    assert!(w.broker.read("power.stranger", &w.workspace.join("x")).is_err());
    assert_eq!(w.broker.spawn("power.stranger", "hostname", &[], None), Err("not_enabled"));
}
