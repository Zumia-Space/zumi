//! R7b RE-GATE (Opus reviewer, 20-11, scratch copy only): NEW attacks the worker has not seen. Each test prints what happened
//! ("ATTACK ..."); an assert marks the expected SAFE outcome unless the name says `residual_` (then it only shows what happens).
#![allow(dead_code)]
mod common;
use common::*;
use serde_json::json;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use zumi_packs::audit::{PackAudit, Row};
use zumi_packs::manifest::Manifest;
use zumi_packs::scope::{decide, Action, Allowed, Env, Grants};

const TOOLS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/r7b");
const PS: &str = r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe";

fn junction(link: &Path, target: &Path) {
    let s = std::process::Command::new("cmd").args(["/c", "mklink", "/J"]).arg(link).arg(target).output().unwrap();
    assert!(s.status.success(), "mklink: {}", String::from_utf8_lossy(&s.stdout));
}

fn fs_caps() -> serde_json::Value {
    json!([{ "id": "fs.write", "scope": { "roots": ["workspace", "pack-data"] } }, { "id": "fs.read", "scope": { "roots": ["workspace", "pack-data"] } }])
}

/// The workspace grant is the folder that CONTAINS the data dir (a user profile does).
fn profile_world(name: &str) -> World {
    world(name, fs_caps(), |ws, _| Grants { workspace: Some(ws.parent().unwrap().to_path_buf()), ..Default::default() })
}

fn grants_file(w: &World) -> PathBuf {
    let g = w.data.join("packs-state").join(ID).join("grants.json");
    std::fs::write(&g, "ORIGINAL").unwrap();
    g
}

fn race(w: &World, target: &Path, a: PathBuf, b: PathBuf, c: PathBuf, rounds: usize) -> (u32, usize, usize, usize) {
    let stop = Arc::new(AtomicBool::new(false));
    let s2 = stop.clone();
    let t = std::thread::spawn(move || {
        let mut swaps = 0u32;
        while !s2.load(Ordering::SeqCst) {
            if std::fs::rename(&a, &c).is_ok() {
                let _ = std::fs::rename(&b, &a);
                std::thread::yield_now();
                let _ = std::fs::rename(&a, &b);
                let _ = std::fs::rename(&c, &a);
                swaps += 1;
            }
        }
        swaps
    });
    let (mut ok, mut refused, mut leaked) = (0, 0, 0);
    for i in 0..rounds {
        match w.broker.write(ID, target, format!("WIDENED {i}").as_bytes()) {
            Ok(()) => ok += 1,
            Err(_) => refused += 1,
        }
        if let Ok(b) = w.broker.read(ID, target) {
            if b == b"ORIGINAL" {
                leaked += 1;
            }
        }
    }
    stop.store(true, Ordering::SeqCst);
    (t.join().unwrap(), ok, refused, leaked)
}

// ------------------------------------------------------------ M1 ------------------------------------------------------------

#[test]
fn n1_a_hard_link_in_the_workspace_not_pack_data_to_grants() {
    let w = profile_world("n1");
    let g = grants_file(&w);
    let link = w.workspace.join("innocent.txt");
    std::fs::hard_link(&g, &link).unwrap();
    let wr = w.broker.write(ID, &link, b"WIDENED");
    let rd = w.broker.read(ID, &link).map(|b| String::from_utf8_lossy(&b).into_owned());
    eprintln!("ATTACK n1 hard link in workspace: write={wr:?} read={rd:?}");
    assert_eq!(std::fs::read_to_string(&g).unwrap(), "ORIGINAL");
    assert!(wr.is_err() && rd.is_err());
}

#[test]
fn n2_a_junction_swapped_in_between_check_and_open() {
    let w = profile_world("n2");
    let g = grants_file(&w);
    let state = g.parent().unwrap().to_path_buf();
    let (sw, jx, tmp) = (w.workspace.join("sw"), w.workspace.join("jx"), w.workspace.join("tmp"));
    std::fs::create_dir_all(&sw).unwrap();
    std::fs::write(sw.join("grants.json"), "decoy").unwrap();
    junction(&jx, &state);
    let (swaps, ok, refused, leaked) = race(&w, &sw.join("grants.json"), sw.clone(), jx, tmp, 1500);
    eprintln!("ATTACK n2 junction race: swaps={swaps} writes ok={ok} refused={refused} host-file reads leaked={leaked}");
    assert!(swaps > 50 && ok > 0 && refused > 0, "the race really ran both ways");
    assert_eq!(std::fs::read_to_string(&g).unwrap(), "ORIGINAL", "grants changed through a swapped junction");
    assert_eq!(leaked, 0);
}

#[test]
fn n3_rename_over_a_hard_link_between_check_and_open() {
    let w = profile_world("n3");
    let g = grants_file(&w);
    let (f, hl, real) = (w.workspace.join("f.txt"), w.workspace.join("hl.txt"), w.workspace.join("real.txt"));
    std::fs::write(&f, "decoy").unwrap();
    std::fs::hard_link(&g, &hl).unwrap();
    let (swaps, ok, refused, leaked) = race(&w, &f, f.clone(), hl, real, 1500);
    eprintln!("ATTACK n3 rename-over race: swaps={swaps} writes ok={ok} refused={refused} host-file reads leaked={leaked}");
    assert!(swaps > 50 && ok > 0, "the race really ran");
    assert_eq!(std::fs::read_to_string(&g).unwrap(), "ORIGINAL");
    assert_eq!(leaked, 0);
}

#[test]
fn n4_every_other_spelling_relative_streams_devices_and_namespaces() {
    let w = profile_world("n4");
    let g = grants_file(&w);
    let gs = g.to_string_lossy().into_owned();
    let ws = w.workspace.to_string_lossy().into_owned();
    let rel = format!("{ws}\\..\\data\\packs-state\\{ID}\\grants.json");
    let spellings = vec![
        rel.clone(),
        rel.replace('\\', "/"),
        format!("{ws}\\.\\..\\data\\packs-state\\{ID}\\grants.json"),
        gs[2..].to_string(),
        format!("{}{}", &gs[..2], &gs[3..]),
        format!("{gs}::$DATA"),
        format!("{gs}:x"),
        format!("{gs}."),
        format!("{gs} "),
        format!("{gs}\\"),
        format!(r"\\.\{gs}"),
        format!(r"\??\{gs}"),
        format!("//?/{}", gs.replace('\\', "/")),
        format!(r"\\?\GLOBALROOT\??\{gs}"),
        gs.replace('\\', "/"),
        gs.replace('\\', "\\\\"),
        "packs-state\\power.canary\\grants.json".to_string(),
        format!("%TEMP%\\..\\{gs}"),
    ];
    let mut report = Vec::new();
    for s in &spellings {
        let p = PathBuf::from(s);
        let wr = w.broker.write(ID, &p, b"WIDENED");
        let rd = w.broker.read(ID, &p).map(|b| String::from_utf8_lossy(&b).into_owned());
        report.push(format!("{s} -> write {wr:?} read {rd:?}"));
        assert!(wr.is_err(), "write by {s}");
        assert!(!matches!(rd, Ok(ref t) if t == "ORIGINAL"), "read by {s}");
    }
    for dev in ["CONOUT$", "CONIN$", "COM\u{b9}", "LPT\u{b2}", "conout$.txt"] {
        let p = w.workspace.join(dev);
        let wr = w.broker.write(ID, &p, b"X");
        report.push(format!("device {dev} -> write {wr:?} exists-after={}", p.exists()));
    }
    eprintln!("ATTACK n4:\n{}", report.join("\n"));
    assert_eq!(std::fs::read_to_string(&g).unwrap(), "ORIGINAL");
}

/// The updater's temp folder and the user's autostart places are NOT protected: a workspace grant over the profile reaches them.
/// Decide only, nothing is written.
#[test]
fn n5_residual_temp_updater_and_autostart_are_inside_a_profile_workspace() {
    let profile = PathBuf::from(std::env::var("USERPROFILE").unwrap());
    let local = PathBuf::from(std::env::var("LOCALAPPDATA").unwrap());
    let roaming = PathBuf::from(std::env::var("APPDATA").unwrap());
    let m = Manifest::parse(&manifest_text(fs_caps())).unwrap();
    let grants = Grants { workspace: Some(profile.clone()), ..Default::default() };
    let env = Env { pack_data: roaming.join("space.zumia.preview").join("packs-state").join(ID).join("data"), protected: vec![roaming.join("space.zumia.preview"), local.join("space.zumia.preview")] };
    for p in [
        local.join("Temp").join("Zumi-9.9.9-updater-abc123").join("Zumi-9.9.9-installer.exe"),
        roaming.join(r"Microsoft\Windows\Start Menu\Programs\Startup\zumi-r7b-gate-probe.cmd"),
        profile.join(r"Documents\WindowsPowerShell\Microsoft.PowerShell_profile.ps1"),
        roaming.join(r"space.zumia.preview\packs-state").join(ID).join("grants.json"),
    ] {
        eprintln!("ATTACK n5 decide write {} -> {:?}", p.display(), decide(&m, &grants, &env, &Action::Write { path: &p }).map(|a| matches!(a, Allowed::Path(_))));
    }
}

// ------------------------------------------------------------ M2 ------------------------------------------------------------

fn audit_dir_with(rows: usize, name: &str) -> (PathBuf, PackAudit) {
    let root = unique(name);
    let a = PackAudit::new(&root.join("audit"));
    for i in 0..rows {
        a.append(&Row::event(ID, "1.0.0", "install", "n/a", None, &format!("row {i}"))).unwrap();
    }
    (root, a)
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for e in std::fs::read_dir(from).unwrap().flatten() {
        std::fs::copy(e.path(), to.join(e.file_name())).unwrap();
    }
}

fn empty_dir(d: &Path) {
    for e in std::fs::read_dir(d).unwrap().flatten() {
        std::fs::remove_file(e.path()).unwrap();
    }
}

/// Verify in a FRESH process (an app restart): this test binary again, running only `n_child_verify`.
fn verify_in_new_process(audit: &Path) -> String {
    let out = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--ignored", "--exact", "n_child_verify", "--nocapture", "--test-threads=1"])
        .env("R7B_AUDIT", audit)
        .output()
        .unwrap();
    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    text.lines().find_map(|l| l.find("CHILD ").map(|i| l[i..].to_string())).unwrap_or_else(|| format!("CHILD <no line> {text}"))
}

#[test]
#[ignore]
fn n_child_verify() {
    if let Ok(d) = std::env::var("R7B_AUDIT") {
        let a = PackAudit::new(Path::new(&d));
        println!("CHILD verify={:?}", a.verify(ID));
    }
}

#[test]
fn n6_residual_rollback_to_an_older_valid_state_across_a_restart() {
    let (root, a) = audit_dir_with(4, "n6");
    let dir = a.pack_dir(ID);
    let snap = root.join("snap");
    copy_dir(&dir, &snap);
    a.append(&Row::event(ID, "1.0.0", "action", "refused-scope", Some("path_protected"), "the evidence to hide")).unwrap();
    a.append(&Row::event(ID, "1.0.0", "action", "allowed", None, "more")).unwrap();
    assert_eq!(a.verify(ID), Ok(6));
    empty_dir(&dir);
    copy_dir(&snap, &dir);
    let in_run = a.verify(ID);
    let fresh_same_process = PackAudit::new(&root.join("audit")).verify(ID);
    let after_restart = verify_in_new_process(&root.join("audit"));
    eprintln!("ATTACK n6 rollback (old lines + old HEAD copied back): in-run={in_run:?} new PackAudit same process={fresh_same_process:?} after restart: {after_restart}");
    assert!(in_run.is_err());
    assert!(after_restart.contains("Err("), "R7c: after a restart the rollback must show: {after_restart}");
}

/// Another same-user process unseals the audit key with DPAPI (the entropy is a constant in the source), then the log is re-chained
/// without the refusal and HEAD signed for the shorter count.
#[test]
fn n7_residual_key_unsealed_by_another_process_forges_a_rechained_log() {
    use zumi_audit::hostmac::{mac_hex, sha256_hex};
    let (root, a) = audit_dir_with(3, "n7");
    a.append(&Row::event(ID, "1.0.0", "action", "refused-scope", Some("path_protected"), "the evidence to hide")).unwrap();
    assert_eq!(a.verify(ID), Ok(4));
    let out = root.join("probe.txt");
    let st = std::process::Command::new(PS)
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", &format!("{TOOLS}/r7b-probe.ps1"), "-out"])
        .arg(&out)
        .arg("-key")
        .arg(root.join("audit").join("KEY.dpapi"))
        .status()
        .unwrap();
    assert!(st.success());
    let report = std::fs::read_to_string(&out).unwrap();
    let hex = report.lines().find_map(|l| l.strip_prefix("unseal-audit-key: OK ")).map(str::trim).unwrap_or("").to_string();
    eprintln!("ATTACK n7 outside process: {}", report.lines().filter(|l| !l.starts_with("unseal")).collect::<Vec<_>>().join(" | "));
    eprintln!("ATTACK n7 key unsealed by another process: {}", !hex.is_empty());
    if hex.is_empty() {
        return;
    }
    let key: Vec<u8> = (0..hex.len() / 2).map(|i| u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).unwrap()).collect();
    let dir = a.pack_dir(ID);
    let file = std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.path()).find(|p| p.extension().is_some_and(|x| x == "jsonl")).unwrap();
    let mut prev = "0".repeat(64);
    let mut kept = Vec::new();
    for l in std::fs::read_to_string(&file).unwrap().lines().filter(|l| !l.contains("evidence to hide")) {
        let mut v: serde_json::Value = serde_json::from_str(l).unwrap();
        v["prev"] = json!(prev);
        let t = v.to_string();
        prev = sha256_hex(t.as_bytes());
        kept.push(t);
    }
    std::fs::write(&file, kept.join("\n") + "\n").unwrap();
    let n = kept.len();
    let head = json!({ "n": n, "hash": prev, "mac": mac_hex(&key, &["zumi-pack-audit-head/1", ID, &n.to_string(), &prev]) }).to_string();
    std::fs::write(dir.join("HEAD"), head).unwrap();
    let in_run = a.verify(ID);
    let after_restart = verify_in_new_process(&root.join("audit"));
    eprintln!("ATTACK n7 forged re-chain with the unsealed key: in-run={in_run:?} after restart: {after_restart}");
    assert!(in_run.is_err(), "caught during the run");
    assert!(after_restart.contains("Err("), "R7c: after a restart the re-chain must show: {after_restart}");
}
// ------------------------------------------------------------ M3 ------------------------------------------------------------

#[cfg(windows)]
fn find_box(title: &str) -> Option<isize> {
    use windows::core::PCWSTR;
    use windows::Win32::UI::WindowsAndMessaging::FindWindowW;
    let t: Vec<u16> = title.encode_utf16().chain([0]).collect();
    let c: Vec<u16> = "#32770".encode_utf16().chain([0]).collect();
    // SAFETY: NUL-terminated buffers.
    unsafe { FindWindowW(PCWSTR(c.as_ptr()), PCWSTR(t.as_ptr())) }.ok().map(|h| h.0 as isize).filter(|h| *h != 0)
}

#[cfg(windows)]
fn click_no(hwnd: isize) {
    use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{GetDlgItem, SendMessageW, BM_CLICK};
    // SAFETY: a window found on this desktop.
    unsafe {
        if let Ok(no) = GetDlgItem(Some(HWND(hwnd as *mut _)), 7) {
            SendMessageW(no, BM_CLICK, Some(WPARAM(0)), Some(LPARAM(0)));
        }
    }
}

/// A plain host message box on the person's desktop (what HB-2's hands dialog still is). Returns (title, hwnd, answer receiver).
#[cfg(windows)]
fn plain_box(tag: &str) -> (String, isize, std::sync::mpsc::Receiver<i32>) {
    use windows::core::PCWSTR;
    use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_DEFBUTTON2, MB_ICONWARNING, MB_YESNO};
    let title = format!("zumi-r7b-regate-{tag}-{}", std::process::id());
    let t2 = title.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let t: Vec<u16> = t2.encode_utf16().chain([0]).collect();
        let x: Vec<u16> = "HB-2 style box: allow hands?".encode_utf16().chain([0]).collect();
        // SAFETY: NUL-terminated buffers.
        let r = unsafe { MessageBoxW(None, PCWSTR(x.as_ptr()), PCWSTR(t.as_ptr()), MB_YESNO | MB_ICONWARNING | MB_DEFBUTTON2) };
        let _ = tx.send(r.0);
    });
    let hwnd = wait_for(10, || find_box(&title)).expect("box shown");
    (title, hwnd, rx)
}

fn click_probe() -> String {
    concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/click-probe.ps1").replace('/', "\\")
}

fn probe_line(title: &str, hwnd: isize, out: &Path) -> String {
    format!(r#""{PS}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{}" "{title}" {hwnd} "{}""#, click_probe(), out.display())
}

/// A program a proc.spawn pack starts (medium, in the job) asks WMI to start the click probe: is the new process born outside the job,
/// can it press Yes on a plain host box, does kill end it? It also tries to open the host process for code injection.
#[cfg(windows)]
#[test]
#[ignore = "R7c: a program the broker starts is Low and writes no report file; the same attacks run with a bite control in r7c_ui.rs"]
fn n8_residual_medium_job_process_escapes_the_job_by_wmi() {
    let caps = json!([{ "id": "proc.spawn", "scope": { "programs": ["powershell"], "cwd": "workspace", "shell": true } }]);
    let w = world("n8", caps, |ws, _| Grants { workspace: Some(ws.to_path_buf()), ..Default::default() });
    let (title, hwnd, rx) = plain_box("n8");
    let (out, probe_out) = (w.workspace.join("esc.txt"), w.workspace.join("probe.txt"));
    let args: Vec<String> = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", &format!("{TOOLS}/r7b-probe.ps1"), "-out", &out.to_string_lossy(), "-hostpid", &std::process::id().to_string(), "-wmi", &probe_line(&title, hwnd, &probe_out)].iter().map(|s| s.to_string()).collect();
    w.broker.spawn(ID, "powershell", &args, Some(&w.workspace)).expect("spawned in the job");
    let rep = wait_for(60, || std::fs::read_to_string(&out).ok().filter(|t| t.contains("done"))).unwrap_or_default();
    let probe = wait_for(40, || std::fs::read_to_string(&probe_out).ok().filter(|t| t.contains("done"))).unwrap_or_else(|| "no probe report".into());
    let escaped_pid: Option<u32> = rep.lines().find(|l| l.starts_with("wmi-create: ReturnValue=0")).and_then(|l| l.split("pid=").nth(1)).and_then(|s| s.trim().parse().ok());
    if find_box(&title).is_some() {
        click_no(hwnd);
    }
    let answer = rx.recv_timeout(std::time::Duration::from_secs(10)).unwrap_or(-1);
    eprintln!("ATTACK n8 in-job process:\n{rep}\nATTACK n8 WMI-born probe:\n{probe}\nATTACK n8 box answer = {answer} (6 = Yes)");
    let _ = w.broker.kill(ID);
    if let Some(pid) = escaped_pid {
        std::thread::sleep(std::time::Duration::from_millis(300));
        eprintln!("ATTACK n8 escaped pid {pid} alive after broker.kill: {}", alive(pid));
    }
}

/// A LOW integrity process in a pack job (what a helper without proc.spawn/input.inject is): what it can still do with its OWN calls,
/// without the broker.
#[cfg(windows)]
#[test]
#[ignore = "R7c: a program the broker starts is Low and writes no report file; the same attacks run with a bite control in r7c_ui.rs"]
fn n9_what_a_low_integrity_job_process_does_without_the_broker() {
    let root = unique("n9");
    let lowdir = root.join("low");
    std::fs::create_dir_all(&lowdir).unwrap();
    let st = std::process::Command::new("icacls").arg(&lowdir).args(["/setintegritylevel", "(OI)(CI)low"]).output().unwrap();
    assert!(st.status.success(), "icacls: {}", String::from_utf8_lossy(&st.stdout));
    let secret = root.join("secret-outside-every-root.txt");
    std::fs::write(&secret, "user-secret-42").unwrap();
    let medfile = root.join("user-file.txt");
    std::fs::write(&medfile, "untouched").unwrap();
    let (_r2, audit) = audit_dir_with(1, "n9audit");
    let key = audit.pack_dir(ID).parent().unwrap().join("KEY.dpapi");
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    listener.set_nonblocking(true).unwrap();
    let job = zumi_packs::job::Job::new().unwrap();
    let out = lowdir.join("low.txt");
    let child = lowdir.join("grandchild.txt");
    let wmi_line = format!(r#""{PS}" -NoProfile -Command "Set-Content -Path '{}' -Value wmi-born""#, lowdir.join("wmi.txt").display());
    let args: Vec<String> = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", &format!("{TOOLS}/r7b-probe.ps1"), "-out", &out.to_string_lossy(), "-secret", &secret.to_string_lossy(), "-medfile", &medfile.to_string_lossy(), "-port", &port.to_string(), "-key", &key.to_string_lossy(), "-hostpid", &std::process::id().to_string(), "-wmi", &wmi_line, "-child", &child.to_string_lossy()].iter().map(|s| s.to_string()).collect();
    let env: Vec<(String, std::ffi::OsString)> = ["SystemRoot", "TEMP", "TMP"].iter().filter_map(|k| std::env::var_os(k).map(|v| (k.to_string(), v))).collect();
    let p = zumi_packs::proc::start(Path::new(PS), &args, &root, &env, zumi_packs::proc::Io::Null, &job, &zumi_packs::proc::Level::Low).expect("low start");
    let mut got = Vec::new();
    let rep = wait_for(90, || {
        if let Ok((mut s, _)) = listener.accept() {
            use std::io::Read;
            let _ = s.set_nonblocking(false);
            let mut b = Vec::new();
            let _ = s.read_to_end(&mut b);
            got = b;
        }
        std::fs::read_to_string(&out).ok().filter(|t| t.contains("done"))
    })
    .unwrap_or_else(|| "no report".into());
    let gc = std::fs::read_to_string(&child).unwrap_or_else(|_| "no grandchild report".into());
    let shown: Vec<&str> = rep.lines().map(|l| if l.starts_with("unseal-audit-key: OK") { "unseal-audit-key: OK <key hex hidden>" } else { l }).collect();
    eprintln!("ATTACK n9 low job process (pid {}):\n{}\nlistener got: {:?}\nATTACK n9 grandchild:\n{gc}\nwmi-born file exists: {}\nuser file now: {}", p.id(), shown.join("\n"), String::from_utf8_lossy(&got), lowdir.join("wmi.txt").exists(), std::fs::read_to_string(&medfile).unwrap());
    job.terminate();
}

/// The grandchild of a MEDIUM job process (a program a proc.spawn pack starts, which starts another) is still in the job: the click
/// probe it runs against a plain host box gets ERROR_INVALID_WINDOW_HANDLE.
#[cfg(windows)]
#[test]
#[ignore = "R7c: a program the broker starts is Low and writes no report file; the same attacks run with a bite control in r7c_ui.rs"]
fn n10_a_grandchild_of_a_job_process_keeps_the_ui_limits() {
    let caps = json!([{ "id": "proc.spawn", "scope": { "programs": ["powershell"], "cwd": "workspace", "shell": true } }]);
    let w = world("n10", caps, |ws, _| Grants { workspace: Some(ws.to_path_buf()), ..Default::default() });
    let (title, hwnd, rx) = plain_box("n10");
    let probe_out = w.workspace.join("probe.txt");
    let inner = format!("Start-Process -Wait -WindowStyle Hidden -FilePath '{PS}' -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','{}','{title}','{hwnd}','{}'", click_probe(), probe_out.display());
    w.broker.spawn(ID, "powershell", &["-NoProfile".to_string(), "-Command".to_string(), inner], Some(&w.workspace)).unwrap();
    let probe = wait_for(60, || std::fs::read_to_string(&probe_out).ok().filter(|t| t.contains("done"))).unwrap_or_else(|| "no probe report".into());
    if find_box(&title).is_some() {
        click_no(hwnd);
    }
    let answer = rx.recv_timeout(std::time::Duration::from_secs(10)).unwrap_or(-1);
    eprintln!("ATTACK n10 grandchild probe:\n{probe}\nanswer={answer}");
    assert_ne!(answer, 6);
    assert!(probe.contains("errSend=1400") || probe.contains("no-window"), "{probe}");
}

#[cfg(windows)]
#[test]
#[ignore]
fn n_child_consent_on_invisible_station() {
    use windows::core::PCWSTR;
    use windows::Win32::System::StationsAndDesktops::{CreateWindowStationW, SetProcessWindowStation};
    if std::env::var("R7B_STATION").is_err() {
        return;
    }
    // SAFETY: a fresh unnamed window station for this child process only.
    let set = unsafe { CreateWindowStationW(PCWSTR::null(), 0, 0x037F, None).and_then(|ws| SetProcessWindowStation(ws)) };
    let r = zumi_packs::consent::secure_ask("Zumi: r7b station", "text", &zumi_packs::consent::SecureOpts { switch: true, timeout: std::time::Duration::from_secs(3) });
    println!("CHILD station set={set:?} secure_ask={r:?}");
}

/// Fail closed: the consent asked from a process on a NON-interactive window station (the screen cannot switch) is an error.
#[cfg(windows)]
#[test]
fn n11_consent_fails_closed_when_the_screen_cannot_switch() {
    let out = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--ignored", "--exact", "n_child_consent_on_invisible_station", "--nocapture", "--test-threads=1"])
        .env("R7B_STATION", "1")
        .output()
        .unwrap();
    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    let line = text.lines().find_map(|l| l.find("CHILD ").map(|i| l[i..].to_string())).unwrap_or_else(|| format!("CHILD <no line> {text}"));
    eprintln!("ATTACK n11 {line}");
    assert!(line.contains("secure_ask=Err"), "{line}");
}

/// Outside process (no job, same user) against the consent with switch:false: UI Automation sees nothing named like it.
#[cfg(windows)]
#[test]
fn n12_uia_from_outside_finds_no_consent_window() {
    use zumi_packs::consent::{secure_ask, SecureOpts};
    let root = unique("n12");
    let title = format!("Zumi: power.canary 1.0.0 n12-{}", std::process::id());
    let t2 = title.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(secure_ask(&t2, "n12", &SecureOpts { switch: false, timeout: std::time::Duration::from_secs(15) }));
    });
    std::thread::sleep(std::time::Duration::from_millis(500));
    let out = root.join("inj.txt");
    let st = std::process::Command::new(PS).args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", &format!("{TOOLS}/r7b-inject.ps1"), "-title", &title, "-out"]).arg(&out).status().unwrap();
    assert!(st.success());
    let rep = std::fs::read_to_string(&out).unwrap();
    let answer = rx.recv_timeout(std::time::Duration::from_secs(30)).unwrap();
    eprintln!("ATTACK n12 outside UIA:\n{rep}\nanswer={answer:?}");
    assert!(rep.contains("uia windows named like the consent: 0"));
    assert_eq!(answer, Ok(false));
}

/// THE REAL SCREEN (run once by hand: `--ignored --exact n13_real_screen_switch`): the consent switches the screen to its private
/// desktop for 6 s; an outside process injects Y, Alt+Y and two clicks only while the private desktop is up. Expect No (timeout) and
/// the person's desktop back.
#[cfg(windows)]
#[test]
#[ignore]
fn n13_real_screen_switch() {
    use zumi_packs::consent::{secure_ask, SecureOpts};
    let root = unique("n13");
    let title = format!("Zumi: power.canary 1.0.0 n13-{}", std::process::id());
    let t2 = title.clone();
    let started = std::time::Instant::now();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(secure_ask(&t2, "R7b gate test: this window closes by itself in 6 seconds. Do not answer.", &SecureOpts { switch: true, timeout: std::time::Duration::from_secs(6) }));
    });
    std::thread::sleep(std::time::Duration::from_millis(1500));
    let out = root.join("inj.txt");
    let _ = std::process::Command::new(PS).args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", &format!("{TOOLS}/r7b-inject.ps1"), "-title", &title, "-inject", "-out"]).arg(&out).status();
    let answer = rx.recv_timeout(std::time::Duration::from_secs(20));
    let took = started.elapsed();
    let after = root.join("after.txt");
    let _ = std::process::Command::new(PS).args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", &format!("{TOOLS}/r7b-inject.ps1"), "-title", "none", "-out"]).arg(&after).status();
    let rep = std::fs::read_to_string(&out).unwrap_or_default();
    let back = std::fs::read_to_string(&after).unwrap_or_default();
    println!("ATTACK n13 injector:\n{rep}\nanswer={answer:?} after {took:?}\nafter: {back}");
}
#[cfg(windows)]
#[test]
#[ignore = "R7c: a program the broker starts is Low and writes no report file; the same attacks run with a bite control in r7c_ui.rs"]
fn n10b_which_grandchildren_stay_in_the_job() {
    let caps = json!([{ "id": "proc.spawn", "scope": { "programs": ["powershell"], "cwd": "workspace", "shell": true } }]);
    let w = world("n10b", caps, |ws, _| Grants { workspace: Some(ws.to_path_buf()), ..Default::default() });
    let (out, c1, c2) = (w.workspace.join("p.txt"), w.workspace.join("c1.txt"), w.workspace.join("c2.txt"));
    let args: Vec<String> = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", &format!("{TOOLS}/r7b-probe.ps1"), "-out", &out.to_string_lossy(), "-child", &c1.to_string_lossy(), "-direct", &c2.to_string_lossy()].iter().map(|s| s.to_string()).collect();
    w.broker.spawn(ID, "powershell", &args, Some(&w.workspace)).unwrap();
    let rep = wait_for(90, || std::fs::read_to_string(&out).ok().filter(|t| t.contains("done"))).unwrap_or_else(|| "no report".into());
    let r1 = std::fs::read_to_string(&c1).unwrap_or_else(|_| "no c1".into());
    let r2 = std::fs::read_to_string(&c2).unwrap_or_else(|_| "no c2".into());
    eprintln!("ATTACK n10b child in job:\n{rep}\nStart-Process grandchild:\n{r1}\nCreateProcess grandchild:\n{r2}");
}
#[cfg(windows)]
fn grandchild_click(mode: &str) -> (String, String, i32) {
    let caps = json!([{ "id": "proc.spawn", "scope": { "programs": ["powershell"], "cwd": "workspace", "shell": true } }]);
    let w = world(&format!("n10c{mode}"), caps, |ws, _| Grants { workspace: Some(ws.to_path_buf()), ..Default::default() });
    let (title, hwnd, rx) = plain_box(&format!("n10c{mode}"));
    let (out, jobout) = (w.workspace.join("probe.txt"), w.workspace.join("job.txt"));
    let args: Vec<String> = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", &format!("{TOOLS}/gc-launch.ps1"), "-mode", mode, "-title", &title, "-hwnd", &hwnd.to_string(), "-out", &out.to_string_lossy(), "-jobout", &jobout.to_string_lossy()].iter().map(|s| s.to_string()).collect();
    let pid = w.broker.spawn(ID, "powershell", &args, Some(&w.workspace)).unwrap();
    let probe = wait_for(60, || std::fs::read_to_string(&out).ok().filter(|t| t.contains("done"))).unwrap_or_else(|| "no probe report".into());
    if find_box(&title).is_some() {
        click_no(hwnd);
    }
    let answer = rx.recv_timeout(std::time::Duration::from_secs(10)).unwrap_or(-1);
    let job = std::fs::read_to_string(&jobout).unwrap_or_default();
    (format!("in-job launcher pid={pid}; {job}"), probe, answer)
}

#[cfg(windows)]
#[test]
#[ignore = "R7c: a program the broker starts is Low and writes no report file; the same attacks run with a bite control in r7c_ui.rs"]
fn n10c_grandchild_click_by_shellexecute_and_by_createprocess() {
    for mode in ["shell", "direct", "shell"] {
        let (job, probe, answer) = grandchild_click(mode);
        eprintln!("ATTACK n10c mode={mode}: {job}\n{probe}\nanswer={answer} (6 = Yes)");
    }
}
/// n9 again, reporting over the stdout pipe (a low process cannot write a file in a normal folder).
#[cfg(windows)]
#[test]
fn n9b_what_a_low_integrity_job_process_does_without_the_broker() {
    use std::io::Read;
    let root = unique("n9b");
    let secret = root.join("secret-outside-every-root.txt");
    std::fs::write(&secret, "user-secret-42").unwrap();
    let medfile = root.join("user-file.txt");
    std::fs::write(&medfile, "untouched").unwrap();
    let (_r2, audit) = audit_dir_with(1, "n9baudit");
    let key = audit.pack_dir(ID).parent().unwrap().join("KEY.dpapi");
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    let acc = std::thread::spawn(move || {
        listener.set_nonblocking(false).unwrap();
        let (mut s, _) = listener.accept().unwrap();
        let mut b = Vec::new();
        let _ = s.read_to_end(&mut b);
        String::from_utf8_lossy(&b).into_owned()
    });
    let job = zumi_packs::job::Job::new().unwrap();
    let wmi_line = format!(r#""{PS}" -NoProfile -Command "Start-Sleep 1""#);
    let args: Vec<String> = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", &format!("{TOOLS}/r7b-probe.ps1"), "-out", "stdout", "-secret", &secret.to_string_lossy(), "-medfile", &medfile.to_string_lossy(), "-port", &port.to_string(), "-key", &key.to_string_lossy(), "-hostpid", &std::process::id().to_string(), "-wmi", &wmi_line, "-direct", "stdout"].iter().map(|s| s.to_string()).collect();
    let env: Vec<(String, std::ffi::OsString)> = ["SystemRoot", "TEMP", "TMP"].iter().filter_map(|k| std::env::var_os(k).map(|v| (k.to_string(), v))).collect();
    let mut p = zumi_packs::proc::start(Path::new(PS), &args, &root, &env, zumi_packs::proc::Io::Piped, &job, &zumi_packs::proc::Level::Low).expect("low start");
    drop(p.stdin.take());
    let mut text = String::new();
    let _ = p.stdout.take().unwrap().read_to_string(&mut text);
    let shown: Vec<String> = text.lines().map(|l| if l.contains("unseal-audit-key: OK") { "unseal-audit-key: OK <key hex hidden>".to_string() } else { l.to_string() }).collect();
    let got = if text.contains("own-socket-connect: OK") { acc.join().unwrap_or_default() } else { "<no connection>".into() };
    eprintln!("ATTACK n9b low job process (pid {}):\n{}\nlistener got: {got:?}\nuser file now: {}", p.id(), shown.join("\n"), std::fs::read_to_string(&medfile).unwrap());
    job.terminate();
}

/// The WMI-born process of a proc.spawn pack: outside the job, and still alive after the pack's kill.
#[cfg(windows)]
#[test]
#[ignore = "R7c: a program the broker starts is Low and writes no report file; the same attacks run with a bite control in r7c_ui.rs"]
fn n8b_residual_wmi_born_process_survives_kill() {
    let caps = json!([{ "id": "proc.spawn", "scope": { "programs": ["powershell"], "cwd": "workspace", "shell": true } }]);
    let w = world("n8b", caps, |ws, _| Grants { workspace: Some(ws.to_path_buf()), ..Default::default() });
    let (out, wout) = (w.workspace.join("esc.txt"), w.workspace.join("wmi.txt"));
    let wmi = format!(r#""{PS}" -NoProfile -ExecutionPolicy Bypass -Command "& '{TOOLS}/r7b-probe.ps1' -out '{}'; Start-Sleep 20""#, wout.display());
    let args: Vec<String> = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", &format!("{TOOLS}/r7b-probe.ps1"), "-out", &out.to_string_lossy(), "-wmi", &wmi].iter().map(|s| s.to_string()).collect();
    w.broker.spawn(ID, "powershell", &args, Some(&w.workspace)).unwrap();
    let rep = wait_for(60, || std::fs::read_to_string(&out).ok().filter(|t| t.contains("done"))).unwrap_or_default();
    let wrep = wait_for(40, || std::fs::read_to_string(&wout).ok().filter(|t| t.contains("done"))).unwrap_or_else(|| "no wmi report".into());
    let pid: Option<u32> = rep.lines().find(|l| l.starts_with("wmi-create: ReturnValue=0")).and_then(|l| l.split("pid=").nth(1)).and_then(|s| s.trim().parse().ok());
    let killed = w.broker.kill(ID);
    std::thread::sleep(std::time::Duration::from_millis(500));
    let alive_after = pid.map(alive);
    eprintln!("ATTACK n8b in-job:\n{rep}\nWMI-born:\n{wrep}\nkill report {killed:?}; WMI-born pid {pid:?} alive after kill: {alive_after:?}");
    if let Some(pid) = pid {
        let _ = std::process::Command::new("taskkill").args(["/PID", &pid.to_string(), "/F"]).output();
    }
}
/// shell:false with a listed program the deny list does not know: decide for several, and one real run (xcopy copies a file from
/// outside every root into the workspace, which the pack then reads through the broker).
#[cfg(windows)]
#[test]
fn n14_residual_shell_false_with_unlisted_command_runners_and_copiers() {
    let names = ["curl", "tar", "xcopy", "robocopy", "netsh", "diskshadow", "wuauclt", "uvx", "cargo", "code", "docker", "winget", "esentutl", "expand", "replace", "msxsl", "ffmpeg", "7z", "scp", "sftp", "pnputil", "ttdinject", "cmdkey"];
    let caps = json!([{ "id": "proc.spawn", "scope": { "programs": names, "cwd": "workspace", "shell": false } }, { "id": "fs.read", "scope": { "roots": ["workspace"] } }]);
    let w = world("n14", caps.clone(), |ws, _| Grants { workspace: Some(ws.to_path_buf()), ..Default::default() });
    let m = Manifest::parse(&manifest_text(caps)).unwrap();
    let env = Env { pack_data: w.pack_data.clone(), protected: vec![w.data.clone()] };
    let g = Grants { workspace: Some(w.workspace.clone()), ..Default::default() };
    let mut line = Vec::new();
    for n in names {
        let d = decide(&m, &g, &env, &Action::Spawn { program: n, cwd: Some(&w.workspace), args: &[] });
        line.push(format!("{n}={}", match d { Ok(_) => "ALLOWED".to_string(), Err(c) => c.to_string() }));
    }
    eprintln!("ATTACK n14 shell:false decide: {}", line.join(" "));
    let secret = w.outside.join("secret.txt");
    std::fs::write(&secret, "outside-every-root").unwrap();
    let r = w.broker.spawn(ID, "xcopy", &[secret.to_string_lossy().into_owned(), format!("{}\\", w.workspace.display()), "/Y".to_string()], Some(&w.workspace));
    let copied = wait_for(20, || std::fs::read_to_string(w.workspace.join("secret.txt")).ok());
    let via_broker = w.broker.read(ID, &w.workspace.join("secret.txt")).map(|b| String::from_utf8_lossy(&b).into_owned());
    eprintln!("ATTACK n14 xcopy spawn={r:?} copied={copied:?} read back through the broker={via_broker:?}");
    assert_eq!(r, Err("program_not_reviewed"), "R7c: xcopy is not a reviewed program");
    assert!(copied.is_none() && via_broker.is_err(), "R7c: nothing was copied");
}
#[test]
fn n15_print_the_consent_wording() {
    let caps = json!([
        { "id": "proc.spawn", "scope": { "programs": ["git"], "cwd": "workspace", "shell": false } },
        { "id": "fs.read", "scope": { "roots": ["workspace"] } },
        { "id": "net.egress", "scope": { "origins": ["https://api.example.com"] } },
        { "id": "net.listen", "scope": { "bind": "loopback", "ports": [18800] } }
    ]);
    let m = Manifest::parse(&manifest_text(caps)).unwrap();
    let g = Grants { workspace: Some(PathBuf::from(r"C:\Profiles\me\Projects")), ..Default::default() };
    let (en, vi) = zumi_packs::consent::consent_text(&m, "WORST-CASE LINE FROM THE PACK", "DONG RUI RO CUA GOI", &g);
    println!("=====EN=====\n{en}\n=====VI=====\n{vi}\n=====END=====");
    let m2 = Manifest::parse(&manifest_text(json!([{ "id": "fs.read", "scope": { "roots": ["pack-data"] } }]))).unwrap();
    let (en2, vi2) = zumi_packs::consent::consent_text(&m2, "W", "W", &Grants::default());
    println!("=====EN2=====\n{en2}\n=====VI2=====\n{vi2}\n=====END2=====");
}
// ------------------------------------------------------------ R7c: S-A and S-B, as asserts ------------------------------------------------------------

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

/// S-A: what the broker starts for a pack runs at Low integrity (the UIPI mechanism above rests on it).
#[cfg(windows)]
#[test]
fn r7c_sa_a_program_the_broker_starts_runs_at_low_integrity() {
    let caps = json!([{ "id": "proc.spawn", "scope": { "programs": ["ping"], "cwd": "workspace", "shell": false } }]);
    let w = world("r7c-sa-low", caps, |ws, _| Grants { workspace: Some(ws.to_path_buf()), ..Default::default() });
    let pid = w.broker.spawn(ID, "ping", &["-n".into(), "30".into(), "127.0.0.1".into()], Some(&w.workspace)).unwrap();
    assert_eq!(integrity(pid), 0x1000, "low integrity");
    let _ = w.broker.kill(ID);
}

/// The reviewer's n9b through `proc::start`: the probe (a Zumia-style helper's own code, no broker) at the given level. Returns what the
/// probe printed on stdout and what a local listener got.
#[cfg(windows)]
fn probe_at(level: zumi_packs::proc::Level, tag: &str) -> (String, String) {
    use std::io::Read;
    let root = unique(tag);
    let probe_dir = root.join("probe");
    std::fs::create_dir_all(&probe_dir).unwrap();
    std::fs::copy(format!("{TOOLS}/r7b-probe.ps1"), probe_dir.join("probe.ps1")).unwrap();
    if let zumi_packs::proc::Level::Box(name) = &level {
        let sid = zumi_packs::proc::container_sid(name).expect("sid");
        zumi_packs::proc::grant(&probe_dir, &sid, "RX").expect("the container may run the probe and nothing else");
    }
    let secret = root.join("secret-outside-every-root.txt");
    std::fs::write(&secret, "user-secret-42").unwrap();
    let medfile = root.join("user-file.txt");
    std::fs::write(&medfile, "untouched").unwrap();
    let (_r2, audit) = audit_dir_with(1, &format!("{tag}-audit"));
    let key = audit.pack_dir(ID).parent().unwrap().join("KEY.dpapi");
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    listener.set_nonblocking(true).unwrap();
    let job = zumi_packs::job::Job::new().unwrap();
    let script = probe_dir.join("probe.ps1");
    let args: Vec<String> = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", &script.to_string_lossy(), "-out", "stdout", "-secret", &secret.to_string_lossy(), "-medfile", &medfile.to_string_lossy(), "-port", &port.to_string(), "-key", &key.to_string_lossy(), "-hostpid", &std::process::id().to_string(), "-direct", "stdout"].iter().map(|s| s.to_string()).collect();
    let mut env: Vec<(String, std::ffi::OsString)> = ["SystemRoot", "TEMP", "TMP"].iter().filter_map(|k| std::env::var_os(k).map(|v| (k.to_string(), v))).collect();
    if matches!(level, zumi_packs::proc::Level::Box(_)) {
        // As the broker gives a contained helper: the system needs these, and they point at the pack's own folder.
        env = ["SystemRoot"].iter().filter_map(|k| std::env::var_os(k).map(|v| (k.to_string(), v))).chain(["LOCALAPPDATA", "APPDATA", "USERPROFILE", "TEMP", "TMP"].map(|k| (k.to_string(), probe_dir.clone().into_os_string()))).collect();
    }
    let mut p = zumi_packs::proc::start(Path::new(PS), &args, &probe_dir, &env, zumi_packs::proc::Io::Piped, &job, &level).expect("start");
    drop(p.stdin.take());
    let mut text = String::new();
    let _ = p.stdout.take().unwrap().read_to_string(&mut text);
    let mut got = Vec::new();
    if let Ok((mut s, _)) = listener.accept() {
        let _ = s.set_nonblocking(false);
        let _ = s.read_to_end(&mut got);
    }
    job.terminate();
    let shown: Vec<String> = text.lines().map(|l| if l.contains("unseal-audit-key: OK") { "unseal-audit-key: OK <key hex hidden>".to_string() } else { l.to_string() }).collect();
    (shown.join("\n"), String::from_utf8_lossy(&got).into_owned())
}

/// S-B: what a helper's OWN code can do without the broker. Control first: at Low it reads a file outside every root, opens a socket and
/// unseals the audit key (the reviewer's n9b). In an AppContainer none of that works, for the helper and for what it starts.
#[cfg(windows)]
#[test]
fn r7c_sb_a_contained_helper_cannot_read_outside_open_a_socket_or_unseal_the_audit_key() {
    let (low, low_got) = probe_at(zumi_packs::proc::Level::Low, "r7c-sb-low");
    eprintln!("R7c S-B control (Low):\n{low}\nlistener got {low_got:?}");
    assert!(low.contains("read-outside-roots: OK") && low.contains("own-socket-connect: OK") && low.contains("unseal-audit-key: OK"), "the control must show what Low can do: {low}");
    let (boxed, got) = probe_at(zumi_packs::proc::Level::Box("zumi-pack-r7c-test".to_string()), "r7c-sb-box");
    eprintln!("R7c S-B contained:\n{boxed}\nlistener got {got:?}");
    assert!(boxed.contains("Low Mandatory Level"), "{boxed}");
    for denied in ["read-outside-roots: DENIED", "write-user-file: DENIED", "own-socket-connect: DENIED"] {
        assert!(boxed.contains(denied), "{denied}: {boxed}");
    }
    assert!(!boxed.contains("read-audit-key-file: OK") && !boxed.contains("unseal-audit-key: OK"), "the audit key was reached: {boxed}");
    assert!(got.is_empty(), "something reached the local listener: {got:?}");
    assert!(!boxed.contains("OK 'user-secret-42'") && !boxed.contains("own-socket-connect: OK"), "a grandchild reached out: {boxed}");
}
