//! R7c: `shell: false` is a boundary (re-gate R7b n14). A program a pack lists must be one Zumia reviewed (a short allow-list, not a deny
//! list that every LOLBin walks around), and its arguments may name files only inside the pack's roots. `shell: true` (declared, shown in
//! the consent) lifts both. The reviewer's run: `xcopy <outside file> <workspace>` copied a file the pack had no right to, and the
//! broker then read it back.
mod common;
use common::*;
use serde_json::json;
use std::path::PathBuf;
use zumi_packs::scope::Grants;

fn world_with(name: &str, programs: serde_json::Value, shell: bool) -> World {
    let caps = json!([{ "id": "proc.spawn", "scope": { "programs": programs, "cwd": "workspace", "shell": shell } }, { "id": "fs.read", "scope": { "roots": ["workspace"] } }]);
    world(name, caps, |ws, _| Grants { workspace: Some(ws.to_path_buf()), ..Default::default() })
}

fn s(p: &std::path::Path) -> String {
    p.to_string_lossy().into_owned()
}

/// The reviewer's n14 run, through the broker: nothing is copied, and the pack cannot read the outside file through the workspace.
#[test]
fn xcopy_under_shell_false_is_refused_and_copies_nothing() {
    let w = world_with("r7c-xcopy", json!(["xcopy", "robocopy", "curl", "tar", "esentutl", "expand", "replace", "cmdkey"]), false);
    let secret = w.outside.join("secret.txt");
    std::fs::write(&secret, "outside-every-root").unwrap();
    let r = w.broker.spawn(ID, "xcopy", &[s(&secret), format!("{}\\", w.workspace.display()), "/Y".to_string()], Some(&w.workspace));
    assert_eq!(r, Err("program_not_reviewed"));
    std::thread::sleep(std::time::Duration::from_millis(800));
    assert!(!w.workspace.join("secret.txt").exists(), "nothing was copied");
    assert!(w.broker.read(ID, &w.workspace.join("secret.txt")).is_err());
    for name in ["robocopy", "curl", "tar", "esentutl", "expand", "replace", "cmdkey"] {
        let r = w.broker.spawn(ID, name, &[], Some(&w.workspace));
        assert!(matches!(r, Err("program_not_reviewed") | Err("program_not_found")), "{name}: {r:?}");
    }
}

/// The reviewed programs start, and a path they are given must be inside the pack's roots, however it is spelled.
#[test]
fn a_path_argument_outside_the_roots_is_refused_however_it_is_spelled() {
    let w = world_with("r7c-args", json!(["hostname", "whoami"]), false);
    let (inside, outside) = (w.workspace.join("a.txt"), w.outside.join("secret.txt"));
    std::fs::write(&outside, "x").unwrap();
    let ok = |args: Vec<String>| w.broker.spawn(ID, "hostname", &args, Some(&w.workspace));
    assert!(ok(vec![]).is_ok());
    assert!(ok(vec!["/?".into()]).is_ok(), "a switch is not a path");
    assert!(ok(vec![s(&inside)]).is_ok(), "a path inside the workspace");
    assert!(ok(vec!["a.txt".into()]).is_ok(), "a name relative to the (allowed) working folder");
    let bad = [
        s(&outside),
        format!("--out={}", outside.display()),
        format!("-i{}", outside.display()),
        s(&outside).replace('\\', "/"),
        format!("{}\\..\\outside\\secret.txt", w.workspace.display()),
        "..\\outside\\secret.txt".to_string(),
        "sub\\..\\..\\x".to_string(),
        r"\\127.0.0.1\c$\Windows\win.ini".to_string(),
        r"\Windows\win.ini".to_string(),
        "file:///C:/Windows/win.ini".to_string(),
        "https://example.com/a".to_string(),
        s(&w.data.join("packs-state")),
        format!("{}\\grants.json", w.pack_data.parent().unwrap().display()),
    ];
    for a in bad {
        assert_eq!(ok(vec![a.clone()]), Err("arg_outside"), "{a}");
    }
}

/// `shell: true` is the declared, shown power: a listed shell may be started and its arguments are not scoped (the consent says so).
#[test]
fn shell_true_lifts_the_review_and_the_argument_scope() {
    let w = world_with("r7c-shell", json!(["powershell", "xcopy"]), true);
    let outside = w.outside.join("secret.txt");
    std::fs::write(&outside, "x").unwrap();
    let r = w.broker.spawn(ID, "xcopy", &["/?".to_string()], Some(&w.workspace));
    assert!(r.is_ok(), "{r:?}");
    let r = w.broker.spawn(ID, "powershell", &["-NoProfile".into(), "-Command".into(), format!("Get-Content '{}'", outside.display())], Some(&w.workspace));
    assert!(r.is_ok(), "{r:?}");
}

/// A program the PERSON chose (an exact file, in her grants) needs no review, but its arguments are scoped just the same under shell:false.
#[test]
fn a_user_chosen_program_keeps_the_argument_scope() {
    let xcopy = PathBuf::from(r"C:\Windows\System32\xcopy.exe");
    let caps = json!([{ "id": "proc.spawn", "scope": { "programs": ["user-chosen"], "cwd": "workspace", "shell": false } }, { "id": "fs.read", "scope": { "roots": ["workspace"] } }]);
    let w = world("r7c-chosen", caps, |ws, _| Grants { workspace: Some(ws.to_path_buf()), programs: vec![xcopy.clone()], ..Default::default() });
    let secret = w.outside.join("secret.txt");
    std::fs::write(&secret, "outside-every-root").unwrap();
    let r = w.broker.spawn(ID, &s(&xcopy), &[s(&secret), format!("{}\\", w.workspace.display()), "/Y".to_string()], Some(&w.workspace));
    assert_eq!(r, Err("arg_outside"));
    std::thread::sleep(std::time::Duration::from_millis(800));
    assert!(!w.workspace.join("secret.txt").exists());
    std::fs::write(w.workspace.join("one.txt"), "in").unwrap();
    let r = w.broker.spawn(ID, &s(&xcopy), &[s(&w.workspace.join("one.txt")), s(&w.pack_data) + "\\", "/Y".to_string()], Some(&w.workspace));
    assert!(r.is_ok(), "an inside copy starts: {r:?}");
}

fn junction(link: &std::path::Path, target: &std::path::Path) {
    let s = std::process::Command::new("cmd").args(["/c", "mklink", "/J"]).arg(link).arg(target).output().unwrap();
    assert!(s.status.success(), "mklink: {}", String::from_utf8_lossy(&s.stdout));
}

/// R7d (gate R7c should-fix 1): the three spellings the first claim missed. Each is refused, and each has a CONTROL that is allowed.
#[test]
fn a_drive_relative_argument_is_refused() {
    let w = world_with("r7d-driverel", json!(["hostname"]), false);
    let drive = w.outside.to_string_lossy().chars().next().unwrap();
    let go = |a: String| w.broker.spawn(ID, "hostname", &[a], Some(&w.workspace));
    assert!(go(s(&w.workspace.join("a.txt"))).is_ok(), "control: an absolute path inside");
    for a in [format!("{drive}:secret.txt"), format!(r"{drive}:outside\secret.txt"), format!(r"{drive}:..\x")] {
        assert_eq!(go(a.clone()), Err("arg_outside"), "{a}");
    }
}

#[test]
fn a_relative_argument_through_a_junction_is_refused() {
    let w = world_with("r7d-junction", json!(["hostname"]), false);
    std::fs::write(w.outside.join("secret.txt"), "x").unwrap();
    std::fs::create_dir_all(w.workspace.join("real")).unwrap();
    std::fs::write(w.workspace.join("real").join("a.txt"), "x").unwrap();
    junction(&w.workspace.join("j"), &w.outside);
    let go = |a: &str| w.broker.spawn(ID, "hostname", &[a.to_string()], Some(&w.workspace));
    assert!(go(r"real\a.txt").is_ok(), "control: a relative path to a real folder inside");
    // the same file spelled absolute is already refused (R7c); relative it must be too, and a bare link name as well
    assert_eq!(go(&s(&w.workspace.join("j").join("secret.txt"))), Err("arg_outside"));
    assert_eq!(go(r"j\secret.txt"), Err("arg_outside"));
    assert_eq!(go("j/secret.txt"), Err("arg_outside"));
    assert_eq!(go("j"), Err("arg_outside"));
}

#[test]
fn a_rooted_single_component_argument_is_refused() {
    let w = world_with("r7d-rooted", json!(["hostname"]), false);
    let go = |a: &str| w.broker.spawn(ID, "hostname", &[a.to_string()], Some(&w.workspace));
    assert!(go("/?").is_ok(), "control: a switch");
    for a in [r"\Users", r"\Windows", r"\"] {
        assert_eq!(go(a), Err("arg_outside"), "{a}");
    }
}
