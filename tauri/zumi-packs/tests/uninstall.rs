//! R7 K0a uninstall (roadmap 1.9): removes the pack, its state, consent, grants, data and audit, ends what it started, never follows a
//! junction, and leaves the data dir as it was before the install (the `power-uninstall-check` snapshot, for what this crate owns).
#![allow(dead_code)]
mod common;
use common::*;
use serde_json::json;
use std::collections::BTreeMap;
use std::path::Path;
use zumi_audit::hostmac::sha256_hex;
use zumi_packs::packs::{Catalog, Packs};
use zumi_packs::scope::Grants;

fn caps(port: u16) -> serde_json::Value {
    json!([
        { "id": "proc.spawn", "scope": { "programs": ["ping"], "cwd": "workspace", "shell": false } },
        { "id": "fs.write", "scope": { "roots": ["pack-data"] } },
        { "id": "net.listen", "scope": { "bind": "loopback", "ports": [port] } }
    ])
}

/// Every file under `dir` (relative path -> sha256), except the host's own one-line log.
fn snapshot(dir: &Path) -> BTreeMap<String, String> {
    fn walk(root: &Path, at: &Path, out: &mut BTreeMap<String, String>) {
        let Ok(rd) = std::fs::read_dir(at) else { return };
        for e in rd.flatten() {
            let p = e.path();
            let rel = p.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
            // The host's own audit key (R7b M2, made at the first audit line of any pack, never per pack) and the host's own log with its anchor (R7c) are the host's, not a pack trace.
            if rel.starts_with("audit/host-packs") || rel.starts_with("audit-anchor/host-packs") || rel == "audit/KEY.dpapi" || e.file_name() == "script.json" {
                continue;
            }
            if p.is_dir() {
                walk(root, &p, out);
            } else {
                out.insert(rel, sha256_hex(&std::fs::read(&p).unwrap()));
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(dir, dir, &mut out);
    out
}

fn junction(link: &Path, target: &Path) {
    let s = std::process::Command::new("cmd").args(["/c", "mklink", "/J"]).arg(link).arg(target).output().unwrap();
    assert!(s.status.success(), "mklink: {}", String::from_utf8_lossy(&s.stdout));
}

#[test]
fn uninstall_leaves_the_data_dir_as_it_was_and_ends_everything_the_pack_started() {
    let port = free_port();
    let h = canary_host("uninstall", caps(port));
    let data = h.root.join("data");
    let before = snapshot(&data);
    h.packs.install(&h.src).unwrap();
    h.packs.set_grants(ID, &Grants { origins: vec![], ..Default::default() }).unwrap();
    let attempts = json!([
        { "op": "spawn", "program": "ping", "args": ["-n", "600", "127.0.0.1"] },
        { "op": "listen", "bind": "loopback", "port": port },
        { "op": "write", "path": h.packs.state_dir(ID).join("data").join("note.txt").to_string_lossy(), "text": "kept by the helper" }
    ]);
    let helper = h.run_canary(attempts, true);
    let report = wait_for(10, || h.report()).unwrap();
    let child = report[0]["answer"]["pid"].as_u64().unwrap() as u32;
    assert!(alive(helper) && alive(child));
    assert!(snapshot(&data) != before, "the pack left files behind while it ran");
    h.packs.uninstall(ID, None).unwrap();
    assert!(!alive(helper) && !alive(child), "the helper and its child are ended");
    assert!(std::net::TcpStream::connect(("127.0.0.1", port)).is_err(), "its port is closed");
    assert!(!h.packs.is_enabled(ID));
    assert_eq!(snapshot(&data), before, "the data dir is as it was before the install");
    for gone in [h.packs.pack_dir(ID), h.packs.state_dir(ID), h.packs.audit().pack_dir(ID)] {
        assert!(!gone.exists(), "{gone:?} is gone");
    }
    // one line stays in the host's own log
    let host_log = h.packs.audit().rows("host-packs").unwrap();
    assert_eq!(host_log.len(), 1);
    assert_eq!((host_log[0]["event"].as_str(), host_log[0]["detail"].as_str()), (Some("uninstall"), Some("power.canary 1.0.0")));
    // a clean slate: the same pack installs again and asks for consent again
    h.packs.install(&h.src).unwrap();
    assert_eq!(h.packs.enable(ID), Err("consent_missing".to_string()));
}

#[test]
fn uninstall_unlinks_a_junction_and_never_enters_it() {
    let port = free_port();
    let h = canary_host("junction", caps(port));
    h.packs.install(&h.src).unwrap();
    let victim = h.root.join("victim");
    std::fs::create_dir_all(&victim).unwrap();
    std::fs::write(victim.join("precious.txt"), "keep me").unwrap();
    junction(&h.packs.state_dir(ID).join("data").join("link"), &victim);
    junction(&h.packs.pack_dir(ID).join("bin-link"), &victim);
    h.packs.uninstall(ID, None).unwrap();
    assert_eq!(std::fs::read_to_string(victim.join("precious.txt")).unwrap(), "keep me", "what the junction pointed at is untouched");
    assert!(!h.packs.state_dir(ID).exists() && !h.packs.pack_dir(ID).exists());
}

#[test]
fn the_audit_is_exported_first_when_asked_and_the_chain_still_verifies_there() {
    let port = free_port();
    let h = canary_host("export", caps(port));
    h.packs.install(&h.src).unwrap();
    h.packs.accept(ID, &Says::yes()).unwrap();
    let rows_before = h.packs.audit().rows(ID).unwrap().len();
    let out = h.root.join("export");
    h.packs.uninstall(ID, Some(&out)).unwrap();
    let exported = zumi_packs::audit::PackAudit::new(&out);
    // install, consent, and the uninstall's own kill (which revokes the consent)
    assert_eq!(exported.verify(ID), Ok(rows_before + 1), "the chain is intact");
    assert_eq!(exported.rows(ID).unwrap().last().unwrap()["event"], "consent-revoked");
    assert!(!h.packs.audit().pack_dir(ID).exists());
}

#[test]
fn a_withdrawn_or_unknown_pack_can_still_be_removed_or_is_reported_missing() {
    let port = free_port();
    let h = canary_host("withdrawn", caps(port));
    h.packs.install(&h.src).unwrap();
    let gone = Packs::with_sid(&h.root.join("data"), &KEY, Catalog::compiled(), SID.to_string()).unwrap();
    gone.uninstall(ID, None).unwrap();
    assert!(!h.packs.pack_dir(ID).exists());
    assert_eq!(gone.uninstall(ID, None), Err("not_installed".to_string()));
    assert_eq!(gone.uninstall("../escape", None), Err("not_installed".to_string()), "an id that is a path names nothing");
    assert_eq!(gone.uninstall("power.nope", None), Err("not_installed".to_string()));
}
