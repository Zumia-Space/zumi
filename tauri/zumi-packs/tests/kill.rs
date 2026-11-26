//! R7 K0a kill switch (roadmap 1.7): one press ends the helper, everything it started and every door it opened, within 200 ms, and the pack
//! stays off, across a restart too, until the user accepts and enables it again. Real helper process (the canary), real children.
#![allow(dead_code)]
mod common;
use common::*;
use serde_json::json;
use std::time::{Duration, Instant};
use zumi_packs::consent::CONSENT_FILE;
use zumi_packs::packs::{Catalog, Packs};

fn caps(port: u16) -> serde_json::Value {
    json!([
        { "id": "proc.spawn", "scope": { "programs": ["ping"], "cwd": "workspace", "shell": false } },
        { "id": "fs.write", "scope": { "roots": ["pack-data"] } },
        { "id": "net.listen", "scope": { "bind": "loopback", "ports": [port] } }
    ])
}

fn child_pid(h: &Host) -> u32 {
    let report = wait_for(10, || h.report()).expect("the canary reported");
    report[0]["answer"]["pid"].as_u64().unwrap_or_else(|| panic!("the child did not start: {report}")) as u32
}

fn start_with_child(h: &Host, port: u16) -> (u32, u32) {
    let attempts = json!([
        { "op": "spawn", "program": "ping", "args": ["-n", "600", "127.0.0.1"] },
        { "op": "listen", "bind": "loopback", "port": port }
    ]);
    let helper = h.run_canary(attempts, true);
    (helper, child_pid(h))
}

#[test]
fn kill_ends_the_helper_its_child_and_its_listener_within_200_ms_20_of_20() {
    let port = free_port();
    let h = canary_host("kill20", caps(port));
    h.packs.install(&h.src).unwrap();
    let mut worst = Duration::ZERO;
    for run in 0..20 {
        let (helper, child) = start_with_child(&h, port);
        assert!(alive(helper) && alive(child), "run {run}: both run before the kill");
        assert!(std::net::TcpStream::connect(("127.0.0.1", port)).is_ok(), "run {run}: the door is open");
        let t = Instant::now();
        h.packs.kill(ID).unwrap();
        let took = t.elapsed();
        worst = worst.max(took);
        assert!(took < Duration::from_millis(200), "run {run}: kill took {took:?}");
        assert!(!alive(helper), "run {run}: the helper is gone");
        assert!(!alive(child), "run {run}: its child is gone (the job ends the tree)");
        assert!(std::net::TcpStream::connect(("127.0.0.1", port)).is_err(), "run {run}: the door is closed");
        assert!(!h.packs.is_enabled(ID));
    }
    eprintln!("worst kill: {worst:?}");
}

#[test]
fn after_a_kill_the_pack_stays_off_across_a_restart_until_the_user_accepts_and_enables_again() {
    let port = free_port();
    let h = canary_host("restart", caps(port));
    h.packs.install(&h.src).unwrap();
    let (helper, child) = start_with_child(&h, port);
    h.packs.kill(ID).unwrap();
    assert!(!alive(helper) && !alive(child));
    assert!(!h.packs.state_dir(ID).join(CONSENT_FILE).exists(), "a kill revokes the consent");
    // a restart: a new host over the same data dir, the same key
    let again = Packs::with_sid(&h.root.join("data"), &KEY, Catalog(vec![h.entry.clone()]), SID.to_string()).unwrap();
    assert!(!again.is_enabled(ID), "nothing starts by itself");
    assert_eq!(again.enable(ID), Err("consent_missing".to_string()), "off until the user accepts again");
    assert_eq!(again.start_helper(ID, &[]), Err("not_enabled".to_string()));
    assert_eq!(again.broker().spawn(ID, "ping", &[], None), Err("not_enabled"));
    assert_eq!(again.accept(ID, &Says::yes()), Ok(true));
    again.enable(ID).unwrap();
    assert!(again.is_enabled(ID));
}

#[test]
fn a_helper_is_started_only_for_an_enabled_pack_and_only_once() {
    let port = free_port();
    let h = canary_host("once", caps(port));
    h.packs.install(&h.src).unwrap();
    assert_eq!(h.packs.start_helper(ID, &[]), Err("not_enabled".to_string()), "installed is not enough");
    h.packs.accept(ID, &Says::yes()).unwrap();
    h.packs.enable(ID).unwrap();
    let script = h.root.join("s.json");
    std::fs::write(&script, json!({ "attempts": [], "hold": true }).to_string()).unwrap();
    // The helper is contained (R7c): the script is the one file of the user's it is handed.
    zumi_packs::proc::grant(&script, &zumi_packs::proc::container_sid(&zumi_packs::proc::container_name(ID)).unwrap(), "R").unwrap();
    let args = [script.to_string_lossy().into_owned()];
    let pid = h.packs.start_helper(ID, &args).unwrap();
    assert_eq!(h.packs.start_helper(ID, &args), Err("helper_running".to_string()));
    assert!(alive(pid));
    h.packs.disable(ID).unwrap();
    assert!(!alive(pid), "turning the pack off ends the helper");
    assert!(!h.packs.is_enabled(ID));
}

#[test]
fn a_changed_helper_on_disk_is_not_started() {
    let port = free_port();
    let h = canary_host("swap", caps(port));
    h.packs.install(&h.src).unwrap();
    h.packs.accept(ID, &Says::yes()).unwrap();
    h.packs.enable(ID).unwrap();
    let exe = h.packs.pack_dir(ID).join("bin").join("zumi-pack-canary.exe");
    let mut bytes = std::fs::read(&exe).unwrap();
    let last = bytes.len() - 1;
    bytes[last] ^= 0xff;
    std::fs::write(&exe, bytes).unwrap();
    assert_eq!(h.packs.start_helper(ID, &[]), Err("files_sha".to_string()));
}

#[test]
fn the_helper_does_not_inherit_the_host_key_or_any_variable_it_was_not_given() {
    let port = free_port();
    let h = canary_host("env", caps(port));
    h.packs.install(&h.src).unwrap();
    std::env::set_var("ZUMI_HANDS_ACCEPT_KEY", "00112233445566778899aabbccddeeff");
    std::env::set_var("ZUMI_CANARY_SECRET", "leak");
    h.run_canary(json!([{ "op": "__env" }]), true);
    let report = wait_for(10, || h.report()).expect("report");
    let names: Vec<String> = report[0]["answer"]["env"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect();
    assert!(!names.iter().any(|n| n.starts_with("ZUMI_")), "{names:?}");
    // R7c: a contained helper also gets the four folder variables the system needs to make its container's environment; they name its own folder.
    assert!(names.len() <= 6, "only a short allow-list reaches the helper: {names:?}");
    std::env::remove_var("ZUMI_HANDS_ACCEPT_KEY");
    std::env::remove_var("ZUMI_CANARY_SECRET");
}

#[test]
fn start_kill_and_every_brokered_action_are_in_one_unbroken_audit_chain() {
    let port = free_port();
    let h = canary_host("chain", caps(port));
    h.packs.install(&h.src).unwrap();
    start_with_child(&h, port);
    h.packs.kill(ID).unwrap();
    let rows = h.packs.audit().rows(ID).unwrap();
    let events: Vec<&str> = rows.iter().map(|r| r["event"].as_str().unwrap()).collect();
    for want in ["install", "consent", "enable", "helper-start", "action", "kill"] {
        assert!(events.contains(&want), "no {want} row in {events:?}");
    }
    let actions: Vec<_> = rows.iter().filter(|r| r["event"] == "action").collect();
    assert!(actions.len() >= 3, "spawn, listen and the report write: {}", actions.len());
    assert!(actions.iter().all(|r| r["decision"] == "allowed"));
    // R7b: the switch acts first (the broker's kill line), then the consent is noted as revoked; nothing that can fail comes before the kill.
    assert_eq!(events[events.len() - 2..], ["kill", "consent-revoked"]);
    assert_eq!(h.packs.audit().verify(ID), Ok(rows.len()));
}
