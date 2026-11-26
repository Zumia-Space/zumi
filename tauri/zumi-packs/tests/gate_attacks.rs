//! Opus gate R7 (GATE-OPUS-R7.md) attacks, kept as permanent tests. The reviewer's scratch copy asserted that each attack SUCCEEDS; here
//! each one asserts that it FAILS. Section per must-fix (M1 broker scope over the host's own files, M2 audit anchor, M3 consent window)
//! and per should-fix taken in R7b.
#![allow(dead_code)]
mod common;
use common::*;
use serde_json::json;
use std::path::{Path, PathBuf};
use zumi_packs::scope::{Env, Grants};

fn junction(link: &Path, target: &Path) {
    let s = std::process::Command::new("cmd").args(["/c", "mklink", "/J"]).arg(link).arg(target).output().unwrap();
    assert!(s.status.success(), "mklink: {}", String::from_utf8_lossy(&s.stdout));
}

/// The 8.3 short form of an existing path, or None when the volume makes no short names.
fn short_name(p: &Path) -> Option<PathBuf> {
    let out = std::process::Command::new("cmd").args(["/c", &format!("for %I in (\"{}\") do @echo %~sI", p.display())]).output().ok()?;
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!s.is_empty() && s.to_lowercase() != p.to_string_lossy().to_lowercase()).then(|| PathBuf::from(s))
}

fn fs_caps() -> serde_json::Value {
    json!([{ "id": "fs.write", "scope": { "roots": ["workspace", "pack-data"] } }, { "id": "fs.read", "scope": { "roots": ["workspace", "pack-data"] } }])
}

// ---------------------------------------------------------------- M1 ----------------------------------------------------------------

/// G1: a pack with fs.write in its workspace, where the user picked a folder that CONTAINS the Zumi data dir (a user profile does), must
/// not reach its own grants, consent, audit HEAD or any other host file through the broker. Its own `data/` folder and the rest of the
/// workspace still work (the refusal is not "refuse everything").
#[test]
fn m1_g1_a_workspace_that_contains_the_data_dir_does_not_reach_grants_consent_audit_or_settings() {
    let w = world("m1g1", fs_caps(), |ws, _| Grants { workspace: Some(ws.parent().unwrap().to_path_buf()), ..Default::default() });
    let state = w.data.join("packs-state").join(ID);
    std::fs::write(state.join("grants.json"), r#"{"workspace":null,"paths":[],"origins":[],"programs":[],"lan":false}"#).unwrap();
    std::fs::write(state.join("consent.jsonl"), "").unwrap();
    std::fs::write(w.data.join("settings.json"), "{}").unwrap();
    w.audit.append(&zumi_packs::audit::Row::event(ID, "1.0.0", "install", "n/a", None, "")).unwrap();
    let widened = json!({ "workspace": "C:\\", "paths": ["C:\\"], "origins": [], "programs": [], "lan": true }).to_string();
    for target in [state.join("grants.json"), state.join("consent.jsonl"), w.data.join("audit").join(ID).join("HEAD"), w.data.join("settings.json"), w.data.join("new-file.txt"), w.data.join("packs").join("x.txt")] {
        assert!(w.broker.write(ID, &target, widened.as_bytes()).is_err(), "write {target:?} must be refused");
        assert!(w.broker.read(ID, &target).is_err(), "read {target:?} must be refused");
    }
    assert!(!std::fs::read_to_string(state.join("grants.json")).unwrap().contains("\"lan\":true"), "grants.json unchanged");
    // the pack's own folder and the rest of the workspace still work
    assert_eq!(w.broker.write(ID, &w.pack_data.join("own.txt"), b"mine"), Ok(()));
    assert_eq!(w.broker.write(ID, &w.workspace.join("doc.txt"), b"doc"), Ok(()));
    assert_eq!(w.broker.read(ID, &w.workspace.join("doc.txt")), Ok(b"doc".to_vec()));
}

/// The same host files by every other spelling of the path: other case, the 8.3 short name, a junction in the workspace, `\\?\`, UNC.
#[test]
fn m1_every_spelling_of_a_host_file_is_refused() {
    let w = world("m1spell", fs_caps(), |ws, _| Grants { workspace: Some(ws.parent().unwrap().to_path_buf()), ..Default::default() });
    let grants = w.data.join("packs-state").join(ID).join("grants.json");
    std::fs::write(&grants, "{}").unwrap();
    let upper = PathBuf::from(grants.to_string_lossy().to_uppercase());
    let mut spellings = vec![upper, PathBuf::from(format!(r"\\?\{}", grants.display())), PathBuf::from(format!(r"\\localhost\{}", grants.display().to_string().replacen(':', "$", 1)))];
    if let Some(s) = short_name(&w.data.join("packs-state")) {
        spellings.push(s.join(ID).join("grants.json"));
    } else {
        eprintln!("note: this volume makes no 8.3 names; the short-name spelling is not exercised here");
    }
    junction(&w.workspace.join("j"), &w.data);
    spellings.push(w.workspace.join("j").join("packs-state").join(ID).join("grants.json"));
    for p in &spellings {
        assert!(w.broker.write(ID, p, b"{\"lan\":true}").is_err(), "{p:?}");
        assert!(w.broker.read(ID, p).is_err(), "{p:?}");
    }
    assert_eq!(std::fs::read_to_string(&grants).unwrap(), "{}");
}

/// A hard link inside the pack's own folder to a host file is the host file: refused (the path check alone cannot see it).
#[test]
fn m1_a_hard_link_in_pack_data_to_a_host_file_is_refused() {
    let w = world("m1hard", fs_caps(), |ws, _| Grants { workspace: Some(ws.to_path_buf()), ..Default::default() });
    let grants = w.data.join("packs-state").join(ID).join("grants.json");
    std::fs::write(&grants, "{}").unwrap();
    std::fs::hard_link(&grants, w.pack_data.join("g.json")).unwrap();
    assert!(w.broker.write(ID, &w.pack_data.join("g.json"), b"{\"lan\":true}").is_err());
    assert!(w.broker.read(ID, &w.pack_data.join("g.json")).is_err());
    assert_eq!(std::fs::read_to_string(&grants).unwrap(), "{}");
}

/// The pack's own `data/` folder swapped for a junction to the data dir does not turn the carve-out into the whole data dir.
#[test]
fn m1_pack_data_replaced_by_a_junction_to_the_data_dir_is_refused() {
    let w = world("m1pdj", fs_caps(), |ws, _| Grants { workspace: Some(ws.to_path_buf()), ..Default::default() });
    let grants = w.data.join("packs-state").join(ID).join("grants.json");
    std::fs::write(&grants, "{}").unwrap();
    std::fs::remove_dir(&w.pack_data).unwrap();
    junction(&w.pack_data, &w.data);
    let via = w.pack_data.join("packs-state").join(ID).join("grants.json");
    assert!(w.broker.write(ID, &via, b"{\"lan\":true}").is_err());
    assert!(w.broker.read(ID, &via).is_err());
    assert_eq!(std::fs::read_to_string(&grants).unwrap(), "{}");
}

/// Another protected folder the host names (the app's own install or local-data folder) is refused the same way, and a spawn cannot start
/// in it either.
#[test]
fn m1_a_host_named_app_folder_is_protected_too() {
    let root = unique("m1app");
    let (data, ws, app) = (root.join("data"), root.join("ws"), root.join("ws").join("Zumi-app"));
    let pack_data = data.join("packs-state").join(ID).join("data");
    for d in [&pack_data, &app] {
        std::fs::create_dir_all(d).unwrap();
    }
    let audit = std::sync::Arc::new(zumi_packs::audit::PackAudit::new(&data.join("audit")));
    let broker = zumi_packs::broker::Broker::new(audit);
    let caps = json!([{ "id": "fs.write", "scope": { "roots": ["workspace"] } }, { "id": "proc.spawn", "scope": { "programs": ["hostname"], "cwd": "workspace", "shell": false } }]);
    let m = zumi_packs::manifest::Manifest::parse(&manifest_text(caps)).unwrap();
    broker.register(m, Grants { workspace: Some(ws.clone()), ..Default::default() }, Env { pack_data: pack_data.clone(), protected: vec![data.clone(), app.clone()] }).unwrap();
    assert!(broker.write(ID, &app.join("zumi.exe"), b"MZ").is_err(), "the app folder");
    assert!(broker.spawn(ID, "hostname", &[], Some(&app)).is_err(), "no start inside the app folder");
    assert_eq!(broker.write(ID, &ws.join("ok.txt"), b"x"), Ok(()));
    broker.kill_all();
    let _ = std::fs::remove_dir_all(&root);
}

/// The host refuses a broker door whose environment names no protected folder (fail closed: a host that forgot to say what to protect).
#[test]
fn m1_a_door_without_protected_folders_is_not_opened() {
    let root = unique("m1noprot");
    let broker = zumi_packs::broker::Broker::new(std::sync::Arc::new(zumi_packs::audit::PackAudit::new(&root.join("audit"))));
    let m = zumi_packs::manifest::Manifest::parse(&manifest_text(fs_caps())).unwrap();
    assert!(broker.register(m, Grants::default(), Env { pack_data: root.join("pd"), protected: vec![] }).is_err());
    let _ = std::fs::remove_dir_all(&root);
}

/// At the host: a grant that puts a folder or program INSIDE the data dir is refused when it is set and when it is found on disk, the
/// consent window shows the grants, and a grants file changed after the person accepted does not enable (the record covers the grants).
#[test]
fn m1_grants_inside_the_data_dir_are_refused_shown_in_the_window_and_bound_into_the_consent() {
    let h = host("m1grants", fs_caps());
    h.packs.install(&h.src).unwrap();
    let data = h.root.join("data");
    for bad in [
        Grants { workspace: Some(data.clone()), ..Default::default() },
        Grants { workspace: Some(data.join("packs-state")), ..Default::default() },
        Grants { paths: vec![data.join("audit")], ..Default::default() },
        Grants { programs: vec![data.join("packs").join(ID).join("bin").join("zumi-pack-canary.exe")], ..Default::default() },
    ] {
        assert_eq!(h.packs.set_grants(ID, &bad), Err("grant_protected".to_string()), "{bad:?}");
    }
    let ws = h.root.join("my-workspace");
    std::fs::create_dir_all(&ws).unwrap();
    h.packs.set_grants(ID, &Grants { workspace: Some(ws.clone()), ..Default::default() }).unwrap();
    let dialog = Says::yes();
    assert_eq!(h.packs.accept(ID, &dialog), Ok(true));
    let text = dialog.1.borrow()[0].1.clone();
    assert!(text.contains(&ws.display().to_string()), "the window names the folder the person granted: {text}");
    // widened behind the person's back (any same-user writer): not what was accepted
    let file = h.packs.state_dir(ID).join("grants.json");
    let widened = std::fs::read_to_string(&file).unwrap().replace("\"lan\":false", "\"lan\":true");
    std::fs::write(&file, &widened).unwrap();
    assert_eq!(h.packs.enable(ID), Err("consent_stale".to_string()), "grants changed after the acceptance");
    // a grants file on disk that names the data dir is refused at enable even with a fresh acceptance
    std::fs::write(&file, json!({ "workspace": data.to_string_lossy(), "paths": [], "origins": [], "programs": [], "lan": false }).to_string()).unwrap();
    assert!(h.packs.accept(ID, &Says::yes()).is_err(), "no window for a grant into the data dir");
    assert!(h.packs.enable(ID).is_err());
    assert!(!h.packs.is_enabled(ID));
}

// ---------------------------------------------------------------- M2 ----------------------------------------------------------------

use zumi_packs::audit::{PackAudit, Row};

fn four_rows(name: &str) -> (PathBuf, PackAudit) {
    let d = unique(name);
    let a = PackAudit::new(&d);
    for i in 0..4 {
        a.append(&Row::event(ID, "1.0.0", "action", if i == 2 { "refused-scope" } else { "allowed" }, None, &format!("row {i}"))).unwrap();
    }
    assert_eq!(a.verify(ID), Ok(4));
    (d, a)
}

fn jsonl(dir: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(dir).unwrap().flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "jsonl")).collect()
}

/// G2a: every line deleted, HEAD kept.
#[test]
fn m2_g2a_deleting_every_line_is_detected() {
    let (d, a) = four_rows("m2del");
    for f in jsonl(&d.join(ID)) {
        std::fs::remove_file(f).unwrap();
    }
    assert!(a.verify(ID).is_err(), "an emptied log must not verify");
    assert!(a.append(&Row::event(ID, "1.0.0", "action", "allowed", None, "after")).is_err(), "and nothing more is written onto it");
}

/// G2b: one row dropped (the refusal), the rest re-chained and HEAD rewritten the way R7 wrote it (no key).
#[test]
fn m2_g2b_a_rechained_log_with_a_rewritten_head_is_detected() {
    let (d, a) = four_rows("m2rechain");
    let dir = d.join(ID);
    let file = jsonl(&dir).remove(0);
    let saved = std::fs::read_to_string(&file).unwrap();
    let kept: Vec<serde_json::Value> = saved.lines().enumerate().filter(|(i, _)| *i != 2).map(|(_, l)| serde_json::from_str(l).unwrap()).collect();
    let mut prev = "0".repeat(64);
    let mut out = String::new();
    for mut v in kept {
        v["prev"] = json!(prev);
        let line = v.to_string();
        prev = zumi_audit::hostmac::sha256_hex(line.as_bytes());
        out.push_str(&line);
        out.push('\n');
    }
    std::fs::write(&file, &out).unwrap();
    std::fs::write(dir.join("HEAD"), &prev).unwrap();
    assert!(a.verify(ID).is_err(), "a plain-hash HEAD over a rechained log");
    // the same with a HEAD in the new shape but made without the host's key
    let head = json!({ "n": 3, "hash": prev, "mac": zumi_audit::hostmac::mac_hex(&[1u8; 32], &["zumi-pack-audit-head/1", ID, "3", &prev]) }).to_string();
    std::fs::write(dir.join("HEAD"), head).unwrap();
    assert!(a.verify(ID).is_err(), "a HEAD signed by another key");
    assert!(PackAudit::new(&d).verify(ID).is_err(), "and a fresh reader (another run) sees it too");
}

/// A cut-off tail (newest line removed) with HEAD left alone, and with HEAD restored from an earlier copy.
#[test]
fn m2_truncation_and_an_older_head_are_detected() {
    let d = unique("m2trunc");
    let a = PackAudit::new(&d);
    for i in 0..3 {
        a.append(&Row::event(ID, "1.0.0", "action", "allowed", None, &format!("row {i}"))).unwrap();
    }
    let dir = d.join(ID);
    let head_at_3 = std::fs::read(dir.join("HEAD")).unwrap();
    let file = jsonl(&dir).remove(0);
    let text_at_3 = std::fs::read_to_string(&file).unwrap();
    a.append(&Row::event(ID, "1.0.0", "action", "refused-scope", None, "row 3")).unwrap();
    assert_eq!(a.verify(ID), Ok(4));
    // cut the newest line only
    std::fs::write(&file, &text_at_3).unwrap();
    assert!(a.verify(ID).is_err(), "the newest line removed");
    // roll the whole pack folder back to the earlier, self-consistent state (HEAD and lines both from row 3)
    std::fs::write(dir.join("HEAD"), &head_at_3).unwrap();
    assert!(a.verify(ID).is_err(), "a rollback to an earlier HEAD during this run");
}

/// HEAD deleted with the lines kept, and the host key deleted with the chains kept.
#[test]
fn m2_a_missing_head_or_a_missing_key_is_detected() {
    let (d, a) = four_rows("m2nohead");
    std::fs::remove_file(d.join(ID).join("HEAD")).unwrap();
    assert!(a.verify(ID).is_err(), "lines with no HEAD");
    let (d2, _) = four_rows("m2nokey");
    let keys: Vec<PathBuf> = std::fs::read_dir(&d2).unwrap().flatten().map(|e| e.path()).filter(|p| p.is_file()).collect();
    assert!(!keys.is_empty(), "the audit folder holds its key file beside the pack chains");
    for k in keys {
        std::fs::remove_file(k).unwrap();
    }
    assert!(PackAudit::new(&d2).verify(ID).is_err(), "chains with no key: nothing can be checked, so nothing verifies");
    assert!(PackAudit::new(&d2).append(&Row::event(ID, "1.0.0", "action", "allowed", None, "x")).is_err(), "and no new key is made over them");
}

/// At the host: a tampered or missing audit means the pack does not run, and the reason is a code word the UI can show.
#[test]
fn m2_a_tampered_or_missing_audit_stops_the_pack_and_says_why() {
    let h = host("m2host", spawn_caps());
    h.packs.install(&h.src).unwrap();
    assert_eq!(h.packs.accept(ID, &Says::yes()), Ok(true));
    let dir = h.packs.audit().pack_dir(ID);
    let file = jsonl(&dir).remove(0);
    let saved = std::fs::read_to_string(&file).unwrap();
    // one line edited
    std::fs::write(&file, saved.replacen("\"allowed\"", "\"n/a\"", 1)).unwrap();
    let e = h.packs.enable(ID).unwrap_err();
    assert!(e.starts_with("audit_tampered"), "{e}");
    assert!(!h.packs.is_enabled(ID));
    assert!(h.packs.accept(ID, &Says::yes()).unwrap_err().starts_with("audit_tampered"), "no window over a tampered audit either");
    // the audit folder of the pack removed altogether
    std::fs::write(&file, &saved).unwrap();
    h.packs.enable(ID).unwrap();
    h.packs.disable(ID).unwrap();
    let mut moved = dir.clone().into_os_string();
    moved.push(".gone");
    std::fs::rename(&dir, &moved).unwrap();
    assert_eq!(h.packs.enable(ID), Err("audit_missing".to_string()), "an installed pack with no audit");
    assert_eq!(h.packs.audit_state(ID), Err("audit_missing".to_string()), "the state the pack list shows");
    std::fs::rename(&moved, &dir).unwrap();
    assert_eq!(h.packs.audit_state(ID), Ok(()));
}

/// While a pack runs, a tampered HEAD stops every brokered action (the line before the action cannot be written).
#[test]
fn m2_a_tampered_head_refuses_the_next_action() {
    let w = world("m2live", fs_caps(), |ws, _| Grants { workspace: Some(ws.to_path_buf()), ..Default::default() });
    assert_eq!(w.broker.write(ID, &w.pack_data.join("a.txt"), b"1"), Ok(()));
    let head = w.data.join("audit").join(ID).join("HEAD");
    std::fs::write(&head, "0".repeat(64)).unwrap();
    assert_eq!(w.broker.write(ID, &w.pack_data.join("b.txt"), b"2"), Err("audit_failed"));
    assert!(!w.pack_data.join("b.txt").exists());
}

/// A kill still kills when its audit line cannot be written (a tampered chain must never keep a pack running).
#[cfg(feature = "canary")]
#[test]
fn m2_a_kill_over_a_tampered_audit_still_ends_the_pack() {
    let h = canary_host("m2kill", json!([{ "id": "fs.write", "scope": { "roots": ["pack-data"] } }]));
    h.packs.install(&h.src).unwrap();
    let helper = h.run_canary(json!([]), true);
    assert!(alive(helper));
    std::fs::write(h.packs.audit().pack_dir(ID).join("HEAD"), "0".repeat(64)).unwrap();
    assert!(h.packs.kill(ID).is_err(), "the kill's audit line could not be written, and that is reported");
    assert!(wait_for(2, || (!alive(helper)).then_some(())).is_some(), "but the helper is gone");
    assert!(!h.packs.is_enabled(ID));
}

// ---------------------------------------------------------------- M3 ----------------------------------------------------------------

const PROBE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/click-probe.ps1");

fn probe_args(title: &str, hwnd: isize, out: &Path) -> Vec<String> {
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", PROBE].iter().map(|s| s.to_string()).chain([title.to_string(), hwnd.to_string(), out.to_string_lossy().into_owned()]).collect()
}

#[cfg(windows)]
fn find_box(title: &str) -> Option<isize> {
    use windows::core::PCWSTR;
    use windows::Win32::UI::WindowsAndMessaging::FindWindowW;
    let t: Vec<u16> = title.encode_utf16().chain([0]).collect();
    let c: Vec<u16> = "#32770".encode_utf16().chain([0]).collect();
    // SAFETY: NUL-terminated buffers that outlive the call.
    unsafe { FindWindowW(PCWSTR(c.as_ptr()), PCWSTR(t.as_ptr())) }.ok().map(|h| h.0 as isize).filter(|h| *h != 0)
}

#[cfg(windows)]
fn click_no(hwnd: isize) {
    use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{GetDlgItem, SendMessageW, BM_CLICK};
    // SAFETY: a window handle found on this desktop; BM_CLICK on its No button.
    unsafe {
        if let Ok(no) = GetDlgItem(Some(HWND(hwnd as *mut _)), 7) {
            SendMessageW(no, BM_CLICK, Some(WPARAM(0)), Some(LPARAM(0)));
        }
    }
}

/// A host window outside the job (what the R7 consent was: a plain message box), and an attacker started by the broker INSIDE the pack's
/// job, given the window's title and its handle: the job's UI limits leave it no way to press Yes.
#[cfg(windows)]
#[test]
fn m3_a_process_in_a_pack_job_cannot_find_or_click_a_host_window() {
    use windows::core::PCWSTR;
    use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_DEFBUTTON2, MB_ICONWARNING, MB_YESNO};
    let caps = json!([{ "id": "proc.spawn", "scope": { "programs": ["powershell"], "cwd": "workspace", "shell": true } }]);
    let w = world("m3job", caps, |ws, _| Grants { workspace: Some(ws.to_path_buf()), ..Default::default() });
    let title = format!("zumi-r7b-m3-host-box-{}", std::process::id());
    let t2 = title.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let t: Vec<u16> = t2.encode_utf16().chain([0]).collect();
        let x: Vec<u16> = "probe: Accept this risk?".encode_utf16().chain([0]).collect();
        // SAFETY: NUL-terminated buffers that outlive the call.
        let r = unsafe { MessageBoxW(None, PCWSTR(x.as_ptr()), PCWSTR(t.as_ptr()), MB_YESNO | MB_ICONWARNING | MB_DEFBUTTON2) };
        let _ = tx.send(r.0);
    });
    let hwnd = wait_for(10, || find_box(&title)).expect("the host box is shown");
    let out = w.workspace.join("probe.txt");
    // R7c: what the broker starts is LOW integrity now (UIPI stops the click before the job does). This test is about the JOB's own UI limits,
    // so the attacker is started at the user's integrity into a pack job, as a helper that declares input.inject is.
    let job = zumi_packs::job::Job::new().unwrap();
    let ps = std::path::PathBuf::from(std::env::var_os("SystemRoot").unwrap()).join(r"System32\WindowsPowerShell\v1.0\powershell.exe");
    let env: Vec<(String, std::ffi::OsString)> = ["SystemRoot", "TEMP", "TMP"].iter().filter_map(|k| std::env::var_os(k).map(|v| (k.to_string(), v))).collect();
    let _attacker = zumi_packs::proc::start(&ps, &probe_args(&title, hwnd, &out), &w.workspace, &env, zumi_packs::proc::Io::Null, &job, &zumi_packs::proc::Level::User).expect("the attacker starts inside the job");
    let report = wait_for(60, || std::fs::read_to_string(&out).ok().filter(|t| t.contains("done"))).unwrap_or_else(|| "no report".to_string());
    // whatever the attacker did, the box is answered No now unless it was answered already
    if find_box(&title).is_some() {
        click_no(hwnd);
    }
    let answer = rx.recv_timeout(std::time::Duration::from_secs(10)).expect("the box closed");
    eprintln!("{report}");
    assert_ne!(answer, 6, "IDYES was pressed from inside the pack job: {report}");
    // FindWindow still hands back the number, but inside the job no USER call accepts it (ERROR_INVALID_WINDOW_HANDLE, 1400).
    for line in report.lines().filter(|l| l.starts_with("own-desktop") || l.starts_with("given-handle")) {
        assert!(line.contains("no-window") || (line.contains("isWindow=False") && line.contains("posted=False") && line.contains("errSend=1400")), "the job used the host window: {line}");
    }
    assert!(report.contains("given-handle"), "the handle-given attempt ran: {report}");
}

/// The real consent window (a private desktop that only the host can open), with no person to answer it: the strongest local attacker
/// that is not inside the Zumi process (same user, same integrity, no job) cannot see it, open its desktop or press Yes. It times out to No.
#[cfg(windows)]
#[test]
fn m3_the_consent_window_cannot_be_answered_by_another_process() {
    use zumi_packs::consent::{secure_ask, SecureOpts};
    let root = unique("m3desk");
    let title = format!("Zumi: power.canary 1.0.0 r7b-{}", std::process::id());
    let t2 = title.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(secure_ask(&t2, "probe: a consent window", &SecureOpts { switch: false, timeout: std::time::Duration::from_secs(20) }));
    });
    std::thread::sleep(std::time::Duration::from_millis(500));
    let out = root.join("probe.txt");
    let st = std::process::Command::new("powershell").args(probe_args(&title, 0, &out)).status().unwrap();
    assert!(st.success());
    let report = std::fs::read_to_string(&out).unwrap();
    eprintln!("{report}");
    let answer = rx.recv_timeout(std::time::Duration::from_secs(40)).expect("the window answered or timed out");
    assert_eq!(answer, Ok(false), "pressed by another process: {report}");
    assert!(report.contains("own-desktop: no-window"), "{report}");
    assert!(!report.contains("opened"), "another process opened the consent desktop: {report}");
    let _ = std::fs::remove_dir_all(&root);
}

/// Positive control: the same window answered from inside the host (a thread of this process on that desktop) does return the answer, so
/// the window is really there and "No" above is not "always No".
#[cfg(all(windows, feature = "canary"))]
#[test]
fn m3_bite_the_host_itself_can_answer_its_own_window() {
    use zumi_packs::consent::{secure_ask_answered_by_host, SecureOpts};
    let opts = SecureOpts { switch: false, timeout: std::time::Duration::from_secs(20) };
    assert_eq!(secure_ask_answered_by_host("Zumi: bite yes", "text", &opts, true), Ok(true));
    assert_eq!(secure_ask_answered_by_host("Zumi: bite no", "text", &opts, false), Ok(false));
}

/// The integrity level (RID) of a running process.
#[cfg(windows)]
fn integrity(pid: u32) -> u32 {
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::Security::{GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation, TokenIntegrityLevel, TOKEN_MANDATORY_LABEL, TOKEN_QUERY};
    use windows::Win32::System::Threading::{OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION};
    // SAFETY: query-only handles closed here; the buffer is sized by the first call.
    unsafe {
        let p = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).unwrap();
        let mut t = HANDLE::default();
        OpenProcessToken(p, TOKEN_QUERY, &mut t).unwrap();
        let mut need = 0u32;
        let _ = GetTokenInformation(t, TokenIntegrityLevel, None, 0, &mut need);
        let mut buf = vec![0u8; need as usize];
        GetTokenInformation(t, TokenIntegrityLevel, Some(buf.as_mut_ptr() as *mut _), need, &mut need).unwrap();
        let label = &*(buf.as_ptr() as *const TOKEN_MANDATORY_LABEL);
        let n = *GetSidSubAuthorityCount(label.Label.Sid);
        let rid = *GetSidSubAuthority(label.Label.Sid, (n - 1) as u32);
        let _ = CloseHandle(t);
        let _ = CloseHandle(p);
        rid
    }
}

/// A helper that declares no capability that needs the user's desktop runs in an AppContainer (Low integrity, R7c), with `proc.spawn` too (the
/// programs it asks the broker for run at Low, not the helper); one that declares `input.inject` keeps the user's integrity (it must reach the
/// user's windows).
#[cfg(all(windows, feature = "canary"))]
#[test]
fn m3_a_helper_without_spawn_or_inject_runs_at_low_integrity() {
    let h = canary_host("m3low", json!([{ "id": "fs.write", "scope": { "roots": ["pack-data"] } }]));
    h.packs.install(&h.src).unwrap();
    let pid = h.run_canary(json!([]), true);
    assert_eq!(integrity(pid), 0x1000, "low integrity");
    h.packs.kill(ID).unwrap();
    let h2 = canary_host("m3med", json!([{ "id": "input.inject", "scope": {} }]));
    h2.packs.install(&h2.src).unwrap();
    let pid2 = h2.run_canary(json!([]), true);
    assert_eq!(integrity(pid2), 0x2000, "input.inject keeps medium");
    h2.packs.kill(ID).unwrap();
    let h3 = canary_host("m3spawn", spawn_caps());
    h3.packs.install(&h3.src).unwrap();
    let pid3 = h3.run_canary(json!([]), true);
    assert_eq!(integrity(pid3), 0x1000, "proc.spawn: the helper is contained, the programs it asks for run at Low");
}

// ------------------------------------------------------- should-fixes 1, 2, 4 -------------------------------------------------------

use zumi_packs::manifest::Manifest;
use zumi_packs::scope::{decide, Action};

fn env_for(w: &World) -> Env {
    Env { pack_data: w.pack_data.clone(), protected: vec![w.data.clone()] }
}

/// S1 / G4: `shell: false` is not a boundary when the listed program runs other commands by argument (forfiles /c "cmd /c ...") or is an
/// interpreter. Each is a shell: allowed only when the manifest says `shell: true`.
#[test]
fn s1_g4_a_listed_lolbin_or_interpreter_counts_as_a_shell() {
    let w = world("s1g4", fs_caps(), |ws, _| Grants { workspace: Some(ws.to_path_buf()), ..Default::default() });
    for prog in ["forfiles", "wmic", "schtasks", "certutil", "bitsadmin", "msbuild", "node", "python", "py", "git", "ssh", "explorer", "reg", "sc", "runas", "cmstp"] {
        let m = Manifest::parse(&manifest_text(json!([{ "id": "proc.spawn", "scope": { "programs": [prog], "cwd": "workspace", "shell": false } }]))).unwrap();
        let g = Grants { workspace: Some(w.workspace.clone()), ..Default::default() };
        let r = decide(&m, &g, &env_for(&w), &Action::Spawn { program: prog, cwd: None, args: &[] });
        assert!(matches!(r, Err("shell_not_declared") | Err("program_not_found")), "{prog} under shell:false: {r:?}");
    }
    // forfiles ships with Windows, so this one is refused for being a shell, not for being absent
    let m = Manifest::parse(&manifest_text(json!([{ "id": "proc.spawn", "scope": { "programs": ["forfiles"], "cwd": "workspace", "shell": false } }]))).unwrap();
    let g = Grants { workspace: Some(w.workspace.clone()), ..Default::default() };
    assert_eq!(decide(&m, &g, &env_for(&w), &Action::Spawn { program: "forfiles", cwd: None, args: &[] }), Err("shell_not_declared"));
}

/// S1 / G4 + G5 through the broker: the reviewer's two forfiles runs are refused and leave nothing behind.
#[test]
fn s1_g4_g5_forfiles_runs_no_command_and_copies_nothing() {
    let caps = json!([{ "id": "proc.spawn", "scope": { "programs": ["forfiles"], "cwd": "workspace", "shell": false } }, { "id": "fs.read", "scope": { "roots": ["workspace"] } }]);
    let w = world("s1g5", caps, |ws, _| Grants { workspace: Some(ws.to_path_buf()), ..Default::default() });
    std::fs::write(w.workspace.join("marker.txt"), "x").unwrap();
    std::fs::write(w.outside.join("secret.txt"), "s").unwrap();
    let run = vec!["/p".into(), w.workspace.to_string_lossy().into_owned(), "/m".into(), "marker.txt".into(), "/c".into(), "cmd /c echo shell-ran>owned.txt".into()];
    assert_eq!(w.broker.spawn(ID, "forfiles", &run, Some(&w.workspace)), Err("shell_not_declared"));
    let copy = vec!["/p".into(), w.outside.to_string_lossy().into_owned(), "/m".into(), "secret.txt".into(), "/c".into(), format!("cmd /c copy @path \"{}\"", w.workspace.join("leak.txt").display())];
    assert_eq!(w.broker.spawn(ID, "forfiles", &copy, None), Err("shell_not_declared"));
    std::thread::sleep(std::time::Duration::from_millis(1500));
    assert!(!w.workspace.join("owned.txt").exists() && !w.workspace.join("leak.txt").exists());
}

/// S1: a user-chosen program that is a script (.cmd, .bat, .ps1) is not a program the broker starts (Windows would run it through a shell).
#[test]
fn s1_a_user_chosen_script_is_refused_by_the_scope() {
    let w = world("s1cmd", fs_caps(), |ws, _| Grants { workspace: Some(ws.to_path_buf()), ..Default::default() });
    for name in ["run.cmd", "run.bat", "run.ps1", "run.com"] {
        let script = w.workspace.join(name);
        std::fs::write(&script, "echo hi").unwrap();
        let m = Manifest::parse(&manifest_text(json!([{ "id": "proc.spawn", "scope": { "programs": ["user-chosen"], "cwd": "workspace", "shell": false } }]))).unwrap();
        let g = Grants { workspace: Some(w.workspace.clone()), programs: vec![script.clone()], ..Default::default() };
        let program = script.to_string_lossy().into_owned();
        assert_eq!(decide(&m, &g, &env_for(&w), &Action::Spawn { program: &program, cwd: None, args: &[] }), Err("program_not_allowed"), "{name}");
    }
}

/// S1: the consent words say what `proc.spawn` and `net.listen` really allow, and do not claim that data leaves only to the listed places.
#[test]
fn s1_the_consent_text_does_not_promise_more_than_the_broker_enforces() {
    use zumi_packs::consent::consent_text;
    let none = Grants::default();
    let spawn = Manifest::parse(&manifest_text(spawn_caps())).unwrap();
    let (en, vi) = consent_text(&spawn, "risk", "rui ro", &none);
    assert!(en.contains("can do anything you can do on this PC"), "{en}");
    assert!(vi.contains("làm được mọi việc anh làm được trên máy này"), "{vi}");
    assert!(!en.contains("Data leaves this PC only to the places listed above"), "{en}");
    assert!(en.contains("not only to the places listed above"), "{en}");
    let listen = Manifest::parse(&manifest_text(json!([{ "id": "net.listen", "scope": { "bind": "loopback", "ports": [18800] } }]))).unwrap();
    let (en, _) = consent_text(&listen, "risk", "rui ro", &none);
    assert!(!en.contains("Data leaves this PC only to the places listed above") && en.contains("connects to the door"), "{en}");
    // a pack with neither keeps the plain sentence (it is true there)
    let read = Manifest::parse(&manifest_text(json!([{ "id": "fs.read", "scope": { "roots": ["pack-data"] } }]))).unwrap();
    let (en, _) = consent_text(&read, "risk", "rui ro", &none);
    assert!(en.contains("Data leaves this PC only to the places listed above"), "{en}");
}

/// S2 / G3: a pack's `user-added` origins never include this PC (loopback) even when the grant names one (roadmap 1.6); a public https
/// origin still works.
#[test]
fn s2_g3_user_added_loopback_origins_are_refused_for_a_pack() {
    let m = Manifest::parse(&manifest_text(json!([{ "id": "net.egress", "scope": { "origins": "user-added" } }]))).unwrap();
    let env = Env { pack_data: std::env::temp_dir(), protected: vec![std::env::temp_dir().join("zumi-protected")] };
    for (origin, url) in [("http://127.0.0.1:11434", "http://127.0.0.1:11434/api/tags"), ("http://localhost:8080", "http://localhost:8080/x"), ("http://[::1]:9000", "http://[::1]:9000/"), ("https://localhost", "https://localhost/")] {
        let g = Grants { origins: vec![origin.into()], ..Default::default() };
        assert!(decide(&m, &g, &env, &Action::Connect { url }).is_err(), "{origin} must be refused for a pack");
    }
    let g = Grants { origins: vec!["https://api.example.com".into()], ..Default::default() };
    assert!(decide(&m, &g, &env, &Action::Connect { url: "https://api.example.com/v1" }).is_ok(), "a public https origin the person added");
}

/// A second installed pack with its own id (the shared helpers make `power.canary` only).
fn second_pack(dir: &Path, id: &str) -> (PathBuf, zumi_packs::packs::CatalogEntry) {
    std::fs::create_dir_all(dir.join("bin")).unwrap();
    for (p, b) in [("bin/h.exe", &b"MZ-second"[..]), ("RISK.en.md", b"A worst case."), ("RISK.vi.md", b"Mot truong hop.")] {
        std::fs::write(dir.join(p), b).unwrap();
    }
    let entry = |p: &str| {
        let b = std::fs::read(dir.join(p)).unwrap();
        json!({ "path": p, "sha256": zumi_audit::hostmac::sha256_hex(&b), "bytes": b.len() })
    };
    let manifest = json!({ "format": "zumi-pack/1", "kind": "power", "id": id, "version": "1.0.0", "files": [entry("bin/h.exe"), entry("RISK.en.md"), entry("RISK.vi.md")],
        "power": { "protocol": "zumi-power/1", "helper": "bin/h.exe", "risk": { "level": "high", "revision": 1, "text": { "en": "RISK.en.md", "vi": "RISK.vi.md" } },
            "capabilities": [{ "id": "fs.read", "scope": { "roots": ["pack-data"] } }] } }).to_string();
    std::fs::write(dir.join("zumi-pack.json"), &manifest).unwrap();
    (dir.to_path_buf(), zumi_packs::packs::CatalogEntry { id: id.into(), version: "1.0.0".into(), manifest_sha256: zumi_audit::hostmac::sha256_hex(manifest.as_bytes()) })
}

/// S4: the stop-all control ends EVERY pack, even when the first one's consent cannot be taken away (R7 stopped at the first error).
#[test]
fn s4_kill_all_ends_every_pack_even_when_one_consent_cannot_be_revoked() {
    let root = unique("s4");
    let (a_src, a) = second_pack(&root.join("a"), "power.aaa");
    let (b_src, b) = second_pack(&root.join("b"), "power.bbb");
    let packs = zumi_packs::packs::Packs::with_sid(&root.join("data"), &KEY, zumi_packs::packs::Catalog(vec![a, b]), SID.to_string()).unwrap();
    for (src, id) in [(&a_src, "power.aaa"), (&b_src, "power.bbb")] {
        packs.install(src).unwrap();
        assert_eq!(packs.accept(id, &Says::yes()), Ok(true));
        packs.enable(id).unwrap();
    }
    // the first pack's consent file cannot be removed: a folder where the file was
    let consent = packs.state_dir("power.aaa").join(zumi_packs::consent::CONSENT_FILE);
    std::fs::remove_file(&consent).unwrap();
    std::fs::create_dir_all(consent.join("x")).unwrap();
    assert!(packs.kill_all().is_err(), "the failure is reported");
    assert!(!packs.is_enabled("power.aaa") && !packs.is_enabled("power.bbb"), "but both packs are off");
    assert!(!packs.state_dir("power.bbb").join(zumi_packs::consent::CONSENT_FILE).exists(), "and the second one's consent is revoked");
    packs.broker().kill_all();
    let _ = std::fs::remove_dir_all(&root);
}
