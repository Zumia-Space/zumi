//! R3 goal check, egress part (catalogue T48 HTTP parts + the loopback rule): a request to an origin the user did not add is
//! refused 10/10 and never reaches the server; an added origin passes 10/10; the only way to reach loopback is to add it.
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use zumi_egress::fixture::{FixtureResp, Server};
use zumi_egress::{is_public_ip, Egress, EgressError, Request};

type Lines = Arc<Mutex<Vec<String>>>;

fn egress() -> (Egress, Lines) {
    let lines: Lines = Arc::default();
    let l = lines.clone();
    (Egress::new(Arc::new(move |s| l.lock().unwrap().push(s.to_string()))), lines)
}
fn never() -> bool {
    false
}
fn ok_server() -> Server {
    Server::start(|_| FixtureResp::json(200, r#"{"ok":true}"#))
}

#[test]
fn an_origin_the_user_did_not_add_is_refused_10_of_10_and_never_reaches_the_server() {
    let server = ok_server();
    let (mut e, lines) = egress();
    let other = ok_server();
    e.add_user_origin(&other.origin()).unwrap(); // some other origin IS added: the allow-list is not empty
    for i in 0..10 {
        let url = format!("{}/mcp?try={i}", server.origin());
        assert_eq!(e.send(&Request::new("GET", &url), &never), Err(EgressError::Refused("egress_host")), "run {i}");
    }
    assert_eq!(server.hits(), 0, "a refused request must not reach the server");
    let l = lines.lock().unwrap();
    assert_eq!(l.len(), 10);
    let want = format!("egress {}:{} egress_host", "http://127.0.0.1", server.port());
    assert!(l.iter().all(|x| x == &want), "{l:?}");
    assert!(l.iter().all(|x| !x.contains("/mcp") && !x.contains("try=")), "no path or query in the audit line");
}

#[test]
fn an_added_loopback_origin_passes_10_of_10_with_its_headers_and_body() {
    let server = Server::start(|r| {
        let echo = format!(r#"{{"method":"{}","path":"{}","auth":"{}","len":{}}}"#, r.method, r.path, r.header("authorization").unwrap_or(""), r.body.len());
        FixtureResp::json(200, &echo)
    });
    let (mut e, lines) = egress();
    e.add_user_origin(&server.origin()).unwrap();
    for i in 0..10 {
        let url = format!("{}/v1/chat?i={i}", server.origin());
        let headers = [("Authorization".to_string(), "Bearer sk-secret-123".to_string())];
        let mut req = Request::new("POST", &url);
        req.headers = &headers;
        req.body = Some(b"hello".to_vec());
        let r = e.send(&req, &never).unwrap_or_else(|x| panic!("run {i}: {x:?}"));
        assert_eq!(r.head.status, 200);
        let v: serde_json::Value = serde_json::from_slice(&r.body).unwrap();
        assert_eq!(v["method"], "POST");
        assert_eq!(v["path"], format!("/v1/chat?i={i}"));
        assert_eq!(v["auth"], "Bearer sk-secret-123");
        assert_eq!(v["len"], 5);
    }
    assert_eq!(server.hits(), 10);
    let l = lines.lock().unwrap();
    assert!(l.iter().all(|x| x.ends_with(" 200") && !x.contains("sk-secret") && !x.contains("/v1")), "{l:?}");
}

#[test]
fn the_origin_is_compared_exactly_port_scheme_host_userinfo_and_bad_urls() {
    let a = ok_server();
    let b = ok_server();
    let (mut e, _) = egress();
    e.add_user_origin(&a.origin()).unwrap();
    let port = a.port();
    for (url, code, why) in [
        (format!("{}/", b.origin()), "egress_host", "another port on the same host"),
        (format!("http://localhost:{port}/"), "egress_host", "localhost is not 127.0.0.1: names are compared, not addresses"),
        (format!("https://127.0.0.1:{port}/"), "egress_host", "https where http was added"),
        (format!("http://user:pw@127.0.0.1:{port}/"), "egress_userinfo", "credentials in the address"),
        (format!("http://127.0.0.1.evil.test:{port}/"), "egress_scheme", "a look-alike public host over plain http"),
        ("http://example.com/".to_string(), "egress_scheme", "plain http to a public host"),
        ("ftp://127.0.0.1/".to_string(), "egress_scheme", "another scheme"),
        ("file:///C:/Windows/win.ini".to_string(), "egress_scheme", "a file URL"),
        ("not a url".to_string(), "egress_bad_url", "garbage"),
        ("https://example.com/".to_string(), "egress_host", "a public https origin nobody added"),
    ] {
        assert_eq!(e.send(&Request::new("GET", &url), &never), Err(EgressError::Refused(code)), "{why}: {url}");
    }
    assert_eq!(a.hits() + b.hits(), 0);
    // pass twin: the added origin itself, spelled with a path and a query
    let url = format!("http://127.0.0.1:{port}/x?y=1");
    assert_eq!(e.send(&Request::new("GET", &url), &never).unwrap().head.status, 200);
}

#[test]
fn loopback_is_reachable_only_when_the_user_added_that_exact_origin() {
    // The loopback rule: an engine on this PC (a local model) works when the user adds it, and nothing else does.
    let server = ok_server();
    let (mut e, _) = egress();
    for i in 0..10 {
        assert_eq!(e.send(&Request::new("GET", &format!("{}/", server.origin())), &never), Err(EgressError::Refused("egress_host")), "not added, run {i}");
    }
    assert_eq!(server.hits(), 0);
    e.add_user_origin(&server.origin()).unwrap();
    for i in 0..10 {
        assert_eq!(e.send(&Request::new("GET", &format!("{}/", server.origin())), &never).unwrap().head.status, 200, "added, run {i}");
    }
    assert_eq!(server.hits(), 10);
}

#[test]
fn adding_an_origin_has_its_own_rules() {
    let (mut e, _) = egress();
    for (text, code, why) in [
        ("http://example.com", "egress_scheme", "plain http to a public host cannot be added"),
        ("https://10.0.0.5", "egress_private", "a private address cannot be added as a public origin"),
        ("https://192.168.1.20:8443", "egress_private", "LAN"),
        ("https://169.254.169.254", "egress_private", "link-local (cloud metadata)"),
        ("https://100.64.0.1", "egress_private", "carrier-grade NAT"),
        ("https://[fd00::1]", "egress_private", "unique-local v6"),
        ("https://[::ffff:127.0.0.1]", "egress_private", "loopback in a v4-mapped v6 address is still loopback"),
        ("https://user:pw@example.com", "egress_userinfo", "userinfo"),
        ("example.com", "egress_bad_url", "no scheme"),
        ("ftp://localhost", "egress_scheme", "other scheme"),
    ] {
        assert_eq!(e.add_user_origin(text), Err(EgressError::Refused(code)), "{why}: {text}");
    }
    assert!(e.origins().is_empty(), "nothing was added");
    for ok in ["https://api.example.com", "http://localhost:11434", "http://127.0.0.1:8080", "https://127.0.0.1:8443", "http://[::1]:9000"] {
        assert_eq!(e.add_user_origin(ok), Ok(()), "{ok}");
    }
    assert_eq!(e.origins(), vec!["https://api.example.com:443", "http://localhost:11434", "http://127.0.0.1:8080", "https://127.0.0.1:8443", "http://[::1]:9000"]);
}

#[test]
fn which_addresses_a_public_origin_may_reach() {
    for ip in ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111"] {
        assert!(is_public_ip(ip.parse().unwrap()), "{ip}");
    }
    for ip in ["127.0.0.1", "127.8.8.8", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.0.1", "169.254.1.1", "0.0.0.0", "100.64.0.1", "100.127.255.255", "224.0.0.1", "255.255.255.255", "::1", "::", "fe80::1", "fd12::1", "fc00::1", "::ffff:10.0.0.1", "::ffff:127.0.0.1"] {
        assert!(!is_public_ip(ip.parse().unwrap()), "{ip}");
    }
}

#[test]
fn a_redirect_is_refused_and_never_followed() {
    let target = ok_server();
    let t = target.origin();
    let hop = Server::start(move |_| FixtureResp::Full { status: 302, headers: vec![("location".into(), format!("{t}/stolen"))], body: Vec::new() });
    let (mut e, lines) = egress();
    e.add_user_origin(&hop.origin()).unwrap();
    e.add_user_origin(&target.origin()).unwrap(); // even an added target is not followed to
    for i in 0..10 {
        let url = format!("{}/", hop.origin());
        let mut req = Request::new("GET", &url);
        let headers = [("authorization".to_string(), "Bearer k".to_string())];
        req.headers = &headers;
        assert_eq!(e.send(&req, &never), Err(EgressError::Refused("egress_redirect")), "run {i}");
    }
    assert_eq!(target.hits(), 0, "the bearer never travelled to the redirect target");
    assert!(lines.lock().unwrap().iter().all(|l| l.ends_with(" egress_redirect")));
}

#[test]
fn a_body_over_the_cap_is_an_error_not_a_truncation() {
    let server = Server::start(|_| FixtureResp::Full { status: 200, headers: Vec::new(), body: vec![b'x'; 5000] });
    let (mut e, _) = egress();
    e.add_user_origin(&server.origin()).unwrap();
    let url = format!("{}/", server.origin());
    let mut req = Request::new("GET", &url);
    req.max_body = 1000;
    assert_eq!(e.send(&req, &never), Err(EgressError::TooLarge));
    req.max_body = 5000;
    assert_eq!(e.send(&req, &never).unwrap().body.len(), 5000, "pass twin");
}

#[test]
fn chunks_arrive_one_by_one_and_the_reader_may_stop_early() {
    let server = Server::start(|_| FixtureResp::Chunked {
        status: 200,
        headers: vec![("content-type".into(), "text/event-stream".into())],
        chunks: vec![(0, b"data: 1\n\n".to_vec()), (300, b"data: 2\n\n".to_vec()), (300, b"data: 3\n\n".to_vec())],
    });
    let (mut e, _) = egress();
    e.add_user_origin(&server.origin()).unwrap();
    let url = format!("{}/s", server.origin());
    let start = Instant::now();
    let mut seen: Vec<(u128, String)> = Vec::new();
    let head = e.send_streaming(&Request::new("GET", &url), &never, &mut |c| {
        seen.push((start.elapsed().as_millis(), String::from_utf8_lossy(c).to_string()));
        true
    });
    assert_eq!(head.unwrap().status, 200);
    let text: String = seen.iter().map(|s| s.1.as_str()).collect();
    assert_eq!(text, "data: 1\n\ndata: 2\n\ndata: 3\n\n");
    assert!(seen.len() >= 3 && seen[0].0 < 250 && seen.last().unwrap().0 >= 500, "chunks were delivered as they arrived, not at the end: {seen:?}");
    // stop after the first chunk
    let t = Instant::now();
    let mut n = 0;
    let head = e.send_streaming(&Request::new("GET", &url), &never, &mut |_| {
        n += 1;
        false
    });
    assert_eq!(head.unwrap().status, 200);
    assert_eq!(n, 1);
    assert!(t.elapsed() < Duration::from_millis(500), "stopped early: {:?}", t.elapsed());
}

#[test]
fn cancel_ends_a_slow_call_within_a_fraction_of_a_second() {
    let server = Server::start(|_| FixtureResp::Chunked { status: 200, headers: Vec::new(), chunks: vec![(3000, b"late".to_vec())] });
    let (mut e, lines) = egress();
    e.add_user_origin(&server.origin()).unwrap();
    let (start, url) = (Instant::now(), format!("{}/", server.origin()));
    let cancel = move || start.elapsed() > Duration::from_millis(150);
    assert_eq!(e.send(&Request::new("GET", &url), &cancel), Err(EgressError::Cancelled));
    assert!(start.elapsed() < Duration::from_millis(600), "{:?}", start.elapsed());
    assert!(lines.lock().unwrap().last().unwrap().ends_with(" egress_cancelled"));
    // already cancelled before the call: nothing is sent
    let hits = server.hits();
    assert_eq!(e.send(&Request::new("GET", &url), &|| true), Err(EgressError::Cancelled));
    assert_eq!(server.hits(), hits);
}

#[test]
fn a_slow_server_times_out() {
    let server = Server::start(|_| FixtureResp::Chunked { status: 200, headers: Vec::new(), chunks: vec![(2000, b"late".to_vec())] });
    let (mut e, _) = egress();
    e.add_user_origin(&server.origin()).unwrap();
    let url = format!("{}/", server.origin());
    let mut req = Request::new("GET", &url);
    req.timeout = Duration::from_millis(300);
    assert_eq!(e.send(&req, &never), Err(EgressError::Timeout));
}

#[test]
fn a_bad_header_is_refused_before_anything_is_sent() {
    let server = ok_server();
    let (mut e, _) = egress();
    e.add_user_origin(&server.origin()).unwrap();
    let headers = [("x-a".to_string(), "line1\r\nx-injected: 1".to_string())];
    let url = format!("{}/", server.origin());
    let mut req = Request::new("GET", &url);
    req.headers = &headers;
    assert_eq!(e.send(&req, &never), Err(EgressError::Refused("egress_bad_header")));
    assert_eq!(server.hits(), 0);
}

/// The TLS path, against a real public host, without a key and without a body. Run by hand: `cargo test --features fixture
/// -- --ignored real_tls`. Any status is fine: what matters is that the handshake and the certificate check succeed
/// through the platform verifier.
#[test]
#[ignore]
fn real_tls_handshake_through_the_platform_verifier() {
    let (mut e, lines) = egress();
    e.add_user_origin("https://api.deepseek.com").unwrap();
    let r = e.send(&Request::new("GET", "https://api.deepseek.com/"), &never).expect("tls handshake and a response");
    println!("status {}", r.head.status);
    assert!(r.head.status >= 200);
    println!("{:?}", lines.lock().unwrap());
}

/// R3 gate fixes (GATE-OPUS-R3 item 5): addresses that point back into this machine or its LAN by another spelling.
#[test]
fn h_r3_more_private_spellings_are_not_public() {
    for ip in [
        "::1.2.3.4", "::7f00:1", "::a00:1", // IPv4-compatible ::/96 (::127.0.0.1 is ::7f00:1)
        "64:ff9b::7f00:1", "64:ff9b::a00:1", "64:ff9b::808:808", // NAT64 64:ff9b::/96: reaches an IPv4 host through a gateway
        "fec0::1", "feff::1", // site-local fec0::/10
        "2002:7f00:1::", "2002:a00:1::1", // 6to4 of a loopback / private address
        "2001:0:4136:e378:8000:63bf:3fff:fdd2", // Teredo 2001::/32
        "240.0.0.1", "255.1.2.3", "198.18.0.1", "198.19.255.255", // 240/4 reserved, 198.18/15 benchmarking
    ] {
        assert!(!is_public_ip(ip.parse().unwrap()), "{ip}");
    }
    // twins: real public addresses next to those ranges stay public
    for ip in ["2606:4700:4700::1111", "2001:4860:4860::8888", "2a00:1450:4001::1", "198.17.0.1", "198.20.0.1", "93.184.216.34"] {
        assert!(is_public_ip(ip.parse().unwrap()), "{ip}");
    }
}

/// The negative twin of the real-TLS test (a check that has never refused anything proves nothing): a handshake that
/// must fail does fail. Run by hand: `cargo test --features fixture -- --ignored real_tls_refuses`. Anonymous GETs, no key.
#[test]
#[ignore]
fn real_tls_refuses_a_bad_certificate_4_of_4() {
    for host in ["expired.badssl.com", "self-signed.badssl.com", "wrong.host.badssl.com", "untrusted-root.badssl.com"] {
        let (mut e, _lines) = egress();
        let origin = format!("https://{host}");
        e.add_user_origin(&origin).unwrap();
        let r = e.send(&Request::new("GET", &format!("{origin}/")), &never);
        assert_eq!(r.err(), Some(EgressError::Network), "{host}: a bad certificate must not give an answer");
    }
}

#[test]
fn a_redirect_is_handed_back_only_when_the_caller_asks_and_is_still_never_followed() {
    let target = ok_server();
    let t = target.origin();
    let hop = Server::start(move |_| FixtureResp::Full { status: 302, headers: vec![("location".into(), format!("{t}/signed?x=1"))], body: Vec::new() });
    let (mut e, lines) = egress();
    e.add_user_origin(&hop.origin()).unwrap();
    e.add_user_origin(&target.origin()).unwrap();
    let url = format!("{}/file", hop.origin());
    // The default is unchanged: refused.
    assert_eq!(e.send(&Request::new("GET", &url), &never), Err(EgressError::Refused("egress_redirect")));
    // Asked for: the head comes back, with the address, and nothing went to the target.
    let mut req = Request::new("GET", &url);
    req.hand_back_redirect = true;
    let head = e.send_streaming(&req, &never, &mut |_| true).unwrap();
    assert_eq!(head.status, 302);
    assert_eq!(head.header("location"), Some(format!("{}/signed?x=1", target.origin()).as_str()));
    assert_eq!(target.hits(), 0, "handed back, not followed");
    assert!(lines.lock().unwrap().last().unwrap().ends_with(" 302"), "audited as a status, still without a path: {:?}", lines.lock().unwrap());
}

#[test]
fn the_head_is_seen_before_any_body_and_may_stop_the_call() {
    let server = Server::start(|_| FixtureResp::Full { status: 200, headers: vec![("x-mark".into(), "yes".into())], body: vec![b'x'; 5000] });
    let (mut e, _) = egress();
    e.add_user_origin(&server.origin()).unwrap();
    let url = format!("{}/", server.origin());
    let (mut seen_head, mut chunks) = (None, 0);
    let head = e.send_streaming_head(&Request::new("GET", &url), &never, &mut |h| { seen_head = Some(h.clone()); false }, &mut |_| { chunks += 1; true }).unwrap();
    assert_eq!(head.status, 200);
    assert_eq!(seen_head.unwrap().header("x-mark"), Some("yes"));
    assert_eq!(chunks, 0, "no body was read after the head said stop");
    // And true reads the body as before.
    let mut got = 0;
    e.send_streaming_head(&Request::new("GET", &url), &never, &mut |_| true, &mut |c| { got += c.len(); true }).unwrap();
    assert_eq!(got, 5000);
}
