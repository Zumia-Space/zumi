//! M3 (HB-2) with the real helper: an acceptance counts only when the host's dialog path made it with the host's key.
//! Needs the built helper (`cargo build --release` in tauri/zumi-hands); the dialog is a scripted stand-in here (the real
//! MessageBox needs a person: owner check). `arm` is asked with no input injected and nothing is launched.
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;
use zumi_agent_loop::dialog::{accept_pack_with_helper, WarningDialog};
use zumi_agent_loop::hands_tools::{HandsLink, StdioHands};

// One helper at a time: each registers the stop hotkey, and a second registration is refused.
static ONE_HELPER: std::sync::Mutex<()> = std::sync::Mutex::new(());

const KEY: [u8; 32] = [11u8; 32];
const EXPLORER: &str = r"C:\Windows\explorer.exe";

struct Click(bool);
impl WarningDialog for Click {
    fn ask(&self, _title: &str, _text: &str) -> bool {
        self.0
    }
}

fn helper() -> PathBuf {
    let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("../zumi-hands/target/release/zumi-hands.exe");
    assert!(p.is_file(), "build the helper first: {}", p.display());
    p
}

fn dir(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("zumi-hb2-signed-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn policy(d: &Path) -> PathBuf {
    let p = d.join("policy.json");
    std::fs::write(&p, json!({ "apps": [EXPLORER], "args": { EXPLORER: { "directory": true } } }).to_string()).unwrap();
    p
}

/// What a helper started with `key` (or none) reports as accepted when armed on `policy`.
fn accepted_by(key: Option<&[u8]>, policy: &Path, audit: &Path) -> Vec<String> {
    let mut h = StdioHands::spawn_with_key(&helper(), key).unwrap();
    let r = h.call(json!({ "cmd": "arm", "deadman-ms": 30000, "audit": audit, "policy": policy, "capture-root": policy.parent().unwrap() }), Duration::from_secs(20)).unwrap();
    assert_eq!(r["ok"], true, "{r}");
    r["result"]["packs_accepted"].as_array().unwrap().iter().filter_map(Value::as_str).map(str::to_string).collect()
}

#[test]
fn a_click_through_the_host_path_is_accepted_by_a_helper_that_has_the_hosts_key_and_by_no_other() {
    let _one = ONE_HELPER.lock().unwrap_or_else(|p| p.into_inner());
    let d = dir("click");
    let policy = policy(&d);
    let audit = d.join("audit.jsonl");
    assert_eq!(accept_pack_with_helper(&helper(), "explorer", &policy, &audit, &KEY, &Click(true)), Ok(true));
    assert_eq!(accepted_by(Some(&KEY), &policy, &audit), vec!["explorer"], "pass twin: the host's key");
    assert!(accepted_by(Some(&[12u8; 32]), &policy, &audit).is_empty(), "another key");
    assert!(accepted_by(None, &policy, &audit).is_empty(), "a helper without a key (a bench script's)");
}

#[test]
fn bite_a_declined_dialog_and_hand_written_lines_are_not_acceptances() {
    let _one = ONE_HELPER.lock().unwrap_or_else(|p| p.into_inner());
    let d = dir("declined");
    let policy = policy(&d);
    let audit = d.join("audit.jsonl");
    assert_eq!(accept_pack_with_helper(&helper(), "explorer", &policy, &audit, &KEY, &Click(false)), Ok(false));
    assert!(accepted_by(Some(&KEY), &policy, &audit).is_empty(), "no click, no record");
    // A driver builds the line from what pack_warning gives it, with no key: refused by a helper that holds the real key.
    let mut h = StdioHands::spawn(&helper()).unwrap();
    let a = h.call(json!({ "cmd": "arm", "deadman-ms": 30000, "audit": audit, "policy": policy, "capture-root": d }), Duration::from_secs(20)).unwrap();
    assert_eq!(a["ok"], true);
    let w = h.call(json!({ "cmd": "pack_warning", "pack": "explorer" }), Duration::from_secs(20)).unwrap()["result"].clone();
    drop(h); // one helper at a time (the stop hotkey)
    let line = json!({ "pack": "explorer", "policy_version": w["policy_version"], "warning_fnv": w["warning_fnv"], "t_unix_ms": 1 }).to_string();
    std::fs::write(format!("{}.accepted.jsonl", policy.display()), format!("{line}\n")).unwrap();
    assert!(accepted_by(Some(&KEY), &policy, &audit).is_empty(), "a forged plain line");
    let forged = json!({ "pack": "explorer", "policy_version": w["policy_version"], "warning_fnv": w["warning_fnv"], "t_unix_ms": 1, "mac": "00".repeat(32) }).to_string();
    std::fs::write(format!("{}.accepted.jsonl", policy.display()), format!("{forged}\n")).unwrap();
    assert!(accepted_by(Some(&KEY), &policy, &audit).is_empty(), "a forged mac");
}
