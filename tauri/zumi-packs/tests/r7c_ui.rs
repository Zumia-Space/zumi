//! R7c S-A (re-gate R7b n8, n8b, n10c): a program a pack starts must not reach the host's windows through a job of its own (`Start-Process
//! -Wait` puts the child in a nested job whose UI limits are empty) or through WMI (the new process is in no job). The attacker is the test-only
//! `zumi-pack-attacker` exe in `--click` / `--nested` mode (a compiled program: it runs at any integrity level and reports over loopback, since a Low process
//! writes no file). Each attack runs twice. The CONTROL runs it at the user's integrity in a pack job (what the broker did in R7b): the box is
//! answered Yes, which proves the attack bites. The real run starts it through the broker, which gives the program a Low token: UIPI stops
//! every message to the host's windows, whatever job it is in, and Low cannot use WMI.
#![cfg(all(windows, feature = "canary"))]
mod common;
use common::*;
use serde_json::json;
use std::io::Read;
use std::path::PathBuf;
use zumi_packs::proc::{Io, Level};
use zumi_packs::scope::Grants;

const CANARY: &str = env!("CARGO_BIN_EXE_zumi-pack-attacker");

fn find_box(title: &str) -> Option<isize> {
    use windows::core::PCWSTR;
    use windows::Win32::UI::WindowsAndMessaging::FindWindowW;
    let t: Vec<u16> = title.encode_utf16().chain([0]).collect();
    let c: Vec<u16> = "#32770".encode_utf16().chain([0]).collect();
    // SAFETY: NUL-terminated buffers.
    unsafe { FindWindowW(PCWSTR(c.as_ptr()), PCWSTR(t.as_ptr())) }.ok().map(|h| h.0 as isize).filter(|h| *h != 0)
}

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

/// A plain host message box on the person's desktop (what a hands dialog was before R7c). Returns (title, hwnd, answer receiver).
fn plain_box(tag: &str) -> (String, isize, std::sync::mpsc::Receiver<i32>) {
    use windows::core::PCWSTR;
    use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_DEFBUTTON2, MB_ICONWARNING, MB_YESNO};
    let title = format!("zumi-r7c-{tag}-{}", std::process::id());
    let t2 = title.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let t: Vec<u16> = t2.encode_utf16().chain([0]).collect();
        let x: Vec<u16> = "probe box: answer Yes?".encode_utf16().chain([0]).collect();
        // SAFETY: NUL-terminated buffers.
        let r = unsafe { MessageBoxW(None, PCWSTR(x.as_ptr()), PCWSTR(t.as_ptr()), MB_YESNO | MB_ICONWARNING | MB_DEFBUTTON2) };
        let _ = tx.send(r.0);
    });
    let hwnd = wait_for(10, || find_box(&title)).expect("box shown");
    (title, hwnd, rx)
}

/// Everything the attack programs send to the loopback port, until `enough` is true of it or `secs` pass.
fn collect(listener: &std::net::TcpListener, secs: u64, enough: impl Fn(&str) -> bool) -> String {
    let mut all = String::new();
    wait_for(secs, || {
        while let Ok((mut s, _)) = listener.accept() {
            let _ = s.set_nonblocking(false);
            let mut t = String::new();
            let _ = s.read_to_string(&mut t);
            all.push_str(&t);
            all.push('\n');
        }
        enough(&all).then_some(())
    });
    all
}

/// R7d (gate R7c should-fix 3): the WMI run has two reporters, PowerShell (the `wmi-create:` line) and the process it made (`done`), and the
/// second may speak first. The run is over when PowerShell has spoken and, if it made a process, that process has too.
fn wmi_settled(t: &str) -> bool {
    t.contains("wmi-create: DENIED") || (t.contains("wmi-create: ReturnValue") && t.contains("done"))
}

fn reporter() -> (std::net::TcpListener, u16) {
    let l = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    l.set_nonblocking(true).unwrap();
    let port = l.local_addr().unwrap().port();
    (l, port)
}

/// Ends the box (No, if nobody answered) and returns the answer: 6 = Yes, 7 = No.
fn answer_of(title: &str, hwnd: isize, rx: &std::sync::mpsc::Receiver<i32>) -> i32 {
    if find_box(title).is_some() {
        click_no(hwnd);
    }
    rx.recv_timeout(std::time::Duration::from_secs(10)).unwrap_or(-1)
}

fn at_user_level(exe: &str, args: &[String], root: &std::path::Path) -> (zumi_packs::job::Job, zumi_packs::proc::PackProcess) {
    let job = zumi_packs::job::Job::new().unwrap();
    let env: Vec<(String, std::ffi::OsString)> = ["SystemRoot", "TEMP", "TMP"].iter().filter_map(|k| std::env::var_os(k).map(|v| (k.to_string(), v))).collect();
    let p = zumi_packs::proc::start(std::path::Path::new(exe), args, root, &env, Io::Null, &job, &Level::User).expect("control start");
    (job, p)
}

fn user_chosen_world(name: &str, program: &str, shell: bool) -> World {
    let caps = json!([{ "id": "proc.spawn", "scope": { "programs": ["user-chosen", "powershell"], "cwd": "workspace", "shell": shell } }]);
    let exe = PathBuf::from(program);
    world(name, caps, move |ws, _| Grants { workspace: Some(ws.to_path_buf()), programs: vec![exe.clone()], ..Default::default() })
}

fn a(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

/// n10c: the grandchild in a job of its own.
#[test]
fn a_nested_job_grandchild_answers_yes_at_the_users_integrity_and_cannot_at_low() {
    // control: the user's integrity, in a pack job
    let (title, hwnd, rx) = plain_box("nest-ctl");
    let (l, port) = reporter();
    let root = unique("r7c-nest-ctl");
    let (job, _p) = at_user_level(CANARY, &a(&["--nested", &title, &hwnd.to_string(), &port.to_string()]), &root);
    let said = collect(&l, 30, |t| t.contains("done"));
    let answer = answer_of(&title, hwnd, &rx);
    job.terminate();
    eprintln!("R7c nested CONTROL (user integrity in a pack job): answer={answer}\n{said}");
    assert!(said.contains("assigned=Some(true)"), "the attacker must really have joined a job of its own: {said}");
    assert_eq!(answer, 6, "the control must press Yes, or this test proves nothing: {said}");
    // real: through the broker (Low)
    let w = user_chosen_world("r7c-nest", CANARY, false);
    let (title, hwnd, rx) = plain_box("nest");
    let (l, port) = reporter();
    let pid = w.broker.spawn(ID, CANARY, &a(&["--nested", &title, &hwnd.to_string(), &port.to_string()]), Some(&w.workspace)).expect("spawned");
    let said = collect(&l, 30, |t| t.contains("done"));
    let answer = answer_of(&title, hwnd, &rx);
    let _ = w.broker.kill(ID);
    eprintln!("R7c nested through the broker (pid {pid}): answer={answer}\n{said}");
    assert!(said.contains("assigned=Some(true)") && said.contains("by-handle:") && said.contains("done"), "the attack ran to the end: {said}");
    assert_ne!(answer, 6, "the grandchild of a program the broker started answered Yes: {said}");
    assert!(said.contains("posted=false") && !said.contains("posted=true"), "UIPI refuses the posted message: {said}");
}

/// n8 and n8b: a process born through WMI (in no job), and what is left after the kill.
#[test]
fn a_wmi_born_process_answers_yes_at_the_users_integrity_and_cannot_at_low_and_nothing_outlives_the_kill() {
    let ps = |title: &str, hwnd: isize, port: u16| {
        let cmd = format!("\"{CANARY}\" --click {title} {hwnd} {port}");
        let report = format!(
            "function Send([string]$t) {{ $c = New-Object Net.Sockets.TcpClient('127.0.0.1', {port}); $b = [Text.Encoding]::UTF8.GetBytes($t); $s = $c.GetStream(); $s.Write($b, 0, $b.Length); $c.Close() }}; \
             try {{ $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{{ CommandLine = '{}' }} -ErrorAction Stop; $m = \"wmi-create: ReturnValue=$($r.ReturnValue) pid=$($r.ProcessId)\" }} catch {{ $m = \"wmi-create: DENIED $($_.Exception.Message)\" }};              Start-Sleep -Milliseconds 2000; Send $m",
            cmd.replace('\'', "''")
        );
        a(&["-NoProfile", "-NonInteractive", "-Command", &report])
    };
    let powershell = format!(r"{}\System32\WindowsPowerShell\v1.0\powershell.exe", std::env::var("SystemRoot").unwrap());
    // control: PowerShell at the user's integrity in a pack job asks WMI
    let (title, hwnd, rx) = plain_box("wmi-ctl");
    let (l, port) = reporter();
    let root = unique("r7c-wmi-ctl");
    let (job, _p) = at_user_level(&powershell, &ps(&title, hwnd, port), &root);
    let said = collect(&l, 60, wmi_settled);
    let answer = answer_of(&title, hwnd, &rx);
    job.terminate();
    eprintln!("R7c WMI CONTROL (user integrity in a pack job): answer={answer}\n{said}");
    assert!(said.contains("wmi-create: ReturnValue=0") && said.contains("innermost_job_ui=none"), "the WMI-born process is in no job: {said}");
    assert_eq!(answer, 6, "the control must press Yes, or this test proves nothing: {said}");
    // real: through the broker
    let w = user_chosen_world("r7c-wmi", &powershell, true);
    let (title, hwnd, rx) = plain_box("wmi");
    let (l, port) = reporter();
    w.broker.spawn(ID, &powershell, &ps(&title, hwnd, port), Some(&w.workspace)).expect("spawned");
    let said = collect(&l, 60, wmi_settled);
    let answer = answer_of(&title, hwnd, &rx);
    let born: Option<u32> = said.lines().find(|l| l.starts_with("wmi-create: ReturnValue=0")).and_then(|l| l.split("pid=").nth(1)).and_then(|s| s.trim().parse().ok());
    let _ = w.broker.kill(ID);
    std::thread::sleep(std::time::Duration::from_millis(500));
    let survivor = born.filter(|p| alive(*p));
    if let Some(pid) = survivor {
        let _ = std::process::Command::new("taskkill").args(["/PID", &pid.to_string(), "/F"]).output();
    }
    eprintln!("R7c WMI through the broker: answer={answer} born={born:?} survivor={survivor:?}\n{said}");
    assert_ne!(answer, 6, "a WMI-born process of a program the broker started answered Yes: {said}");
    assert!(said.contains("wmi-create: DENIED") || (said.contains("posted=false") && !said.contains("posted=true")), "WMI refused the Low program, or the process it made could not click: {said}");
    assert_eq!(survivor, None, "a process outlived the kill");
}

/// Task Scheduler is the other service that starts a process for the user, outside any job: a Low program must not be able to register a task.
/// The control (the user's integrity, same script) registers one, so the probe bites; the task is deleted again at once, in both runs.
#[test]
fn a_low_program_cannot_register_a_scheduled_task() {
    let powershell = format!(r"{}\System32\WindowsPowerShell\v1.0\powershell.exe", std::env::var("SystemRoot").unwrap());
    let name = format!("zumi-r7c-probe-{}", std::process::id());
    let st = format!(r"{}\System32\schtasks.exe", std::env::var("SystemRoot").unwrap());
    let script = |port: u16| {
        format!(
            "function Send([string]$t) {{ $c = New-Object Net.Sockets.TcpClient('127.0.0.1', {port}); $b = [Text.Encoding]::UTF8.GetBytes($t); $s = $c.GetStream(); $s.Write($b, 0, $b.Length); $c.Close() }}; \
             $st = '{st}'; \
             try {{ $p = Start-Process -FilePath $st -ArgumentList '/Create /TN {name} /TR \"cmd.exe /c exit\" /SC ONCE /ST 23:59 /SD 01/01/2030 /F' -Wait -PassThru -WindowStyle Hidden; $code = $p.ExitCode }} catch {{ $code = 'exception ' + $_.Exception.Message }};              if ($code -eq 0) {{ Start-Process -FilePath $st -ArgumentList '/Delete /TN {name} /F' -Wait -WindowStyle Hidden }}; Send \"schtasks-create: exit=$code done\""
        )
    };
    // control
    let (l, port) = reporter();
    let root = unique("r7c-task-ctl");
    let (job, _p) = at_user_level(&powershell, &a(&["-NoProfile", "-NonInteractive", "-Command", &script(port)]), &root);
    let said = collect(&l, 60, |t| t.contains("done"));
    job.terminate();
    let _ = std::process::Command::new("schtasks.exe").args(["/Delete", "/TN", &name, "/F"]).output();
    eprintln!("R7c Task Scheduler CONTROL (user integrity): {said}");
    assert!(said.contains("exit=0"), "the control must register a task, or this test proves nothing: {said}");
    // real
    let w = user_chosen_world("r7c-task", &powershell, true);
    let (l, port) = reporter();
    w.broker.spawn(ID, &powershell, &a(&["-NoProfile", "-NonInteractive", "-Command", &script(port)]), Some(&w.workspace)).expect("spawned");
    let said = collect(&l, 60, |t| t.contains("done"));
    let _ = w.broker.kill(ID);
    let _ = std::process::Command::new("schtasks.exe").args(["/Delete", "/TN", &name, "/F"]).output();
    eprintln!("R7c Task Scheduler from a Low program: {said}");
    assert!(said.contains("done"), "the probe ran: {said}");
    assert!(!said.contains("exit=0"), "a Low program registered a scheduled task (it would run outside the job, as the user): {said}");
}

/// Runs the compiled attacker with `args` at a level (the user's, Low, or an AppContainer as the broker makes it) and returns what it printed.
fn attacker_at(level: Level, tag: &str, args: &[&str]) -> String {
    use zumi_packs::proc::{container_sid, grant};
    let root = unique(tag);
    let exe = root.join("attacker.exe");
    std::fs::copy(CANARY, &exe).unwrap();
    if let Level::Box(name) = &level {
        grant(&root, &container_sid(name).expect("sid"), "RX").expect("the container may run the attacker and nothing else");
    }
    let job = zumi_packs::job::Job::new().unwrap();
    let mut env: Vec<(String, std::ffi::OsString)> = ["SystemRoot"].iter().filter_map(|k| std::env::var_os(k).map(|v| (k.to_string(), v))).collect();
    if matches!(level, Level::Box(_)) {
        // As the broker gives a contained helper: the system needs these to make the container's environment.
        env.extend(["LOCALAPPDATA", "APPDATA", "USERPROFILE", "TEMP", "TMP"].map(|k| (k.to_string(), root.clone().into_os_string())));
    }
    let mut p = zumi_packs::proc::start(&exe, &a(args), &root, &env, Io::Piped, &job, &level).expect("start");
    drop(p.stdin.take());
    let mut text = String::new();
    let _ = p.stdout.take().unwrap().read_to_string(&mut text);
    job.terminate();
    text.trim().to_string()
}

const TEST_BOX: &str = "zumi-pack-r7c-test";

/// R7d (gate R7c should-fix 4): can the program open the host with the access that injecting code needs? The R7c probe line did not measure
/// that ("Process with an Id of N is not running" at Low as well). This asks the compiled attacker, which calls OpenProcess on the host's
/// pid and prints the Win32 error. Control first: at the user's integrity the host opens; at Low and in a container it is refused (5).
#[test]
fn the_host_process_cannot_be_opened_for_injection_by_a_low_or_contained_program_and_can_by_a_user_level_one() {
    let host = std::process::id().to_string();
    let user = attacker_at(Level::User, "r7d-open-user", &["--open-process", &host]);
    let low = attacker_at(Level::Low, "r7d-open-low", &["--open-process", &host]);
    let boxed = attacker_at(Level::Box(TEST_BOX.to_string()), "r7d-open-box", &["--open-process", &host]);
    eprintln!("R7d open host process: user={user:?} low={low:?} contained={boxed:?}");
    assert_eq!(user, "open-host-process: OK", "the control must open the host, or this probe proves nothing");
    assert_eq!(low, "open-host-process: DENIED win32=5");
    assert_eq!(boxed, "open-host-process: DENIED win32=5");
}

/// R7d, untested class 1 of the R7c gate ("named pipes to medium processes"): the host (or any medium process) has a named pipe, a program
/// of the pack opens it and writes. Control first: at the user's integrity the write arrives. At Low and in a container the open is refused.
#[test]
fn a_named_pipe_of_a_medium_process_cannot_be_written_by_a_low_or_contained_program_and_can_by_a_user_level_one() {
    use std::io::Read;
    use std::os::windows::io::FromRawHandle;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::PIPE_ACCESS_INBOUND;
    use windows::Win32::System::Pipes::{CreateNamedPipeW, PIPE_NOWAIT, PIPE_TYPE_BYTE};
    // The server is a named pipe made with the default security descriptor (what any program of this user gets). It is read until a client
    // has written or the deadline passes; a read on a pipe nobody has opened yet says "listening" (error 536).
    let serve = |name: &str| {
        let wide: Vec<u16> = format!(r"\\.\pipe\{name}").encode_utf16().chain([0]).collect();
        // SAFETY: a NUL-terminated name.
        let h = unsafe { CreateNamedPipeW(PCWSTR(wide.as_ptr()), PIPE_ACCESS_INBOUND, PIPE_TYPE_BYTE | PIPE_NOWAIT, 1, 0, 4096, 0, None) };
        assert!(!h.is_invalid(), "the pipe server");
        // SAFETY: the handle was just made and is owned by this File from here on.
        let mut f = unsafe { std::fs::File::from_raw_handle(h.0) };
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let end = std::time::Instant::now() + std::time::Duration::from_millis(2500);
            let mut buf = [0u8; 64];
            while std::time::Instant::now() < end {
                match f.read(&mut buf) {
                    Ok(n) if n > 0 => {
                        let _ = tx.send(String::from_utf8_lossy(&buf[..n]).into_owned());
                        return;
                    }
                    _ => std::thread::sleep(std::time::Duration::from_millis(20)),
                }
            }
        });
        rx
    };
    let run = |level: Level, tag: &str| {
        let name = format!("zumi-r7d-{tag}-{}", std::process::id());
        let rx = serve(&name);
        let said = attacker_at(level, tag, &["--pipe", &name]);
        let got = rx.recv_timeout(std::time::Duration::from_millis(3000)).ok();
        (said, got)
    };
    let user = run(Level::User, "pipe-user");
    let low = run(Level::Low, "pipe-low");
    let boxed = run(Level::Box(TEST_BOX.to_string()), "pipe-box");
    eprintln!("R7d named pipe: user={user:?} low={low:?} contained={boxed:?}");
    assert_eq!(user, ("pipe: OK".to_string(), Some("pipe-write-from-attacker".to_string())), "the control must reach the pipe, or this probe proves nothing");
    assert_eq!(low, ("pipe: DENIED win32=5".to_string(), None));
    assert_eq!(boxed, ("pipe: DENIED win32=5".to_string(), None));
}

/// R7d, untested class 2 of the R7c gate ("explorer as a proxy"): a program asks Explorer, which runs at the user's integrity, to start a
/// program for it. If that worked, the program would be born OUTSIDE the Low token and outside the job. The marker reports its own pid and
/// integrity over loopback. Control: at the user's integrity the marker starts and says MEDIUM (0x2000), so the mechanism is real. Started
/// by a Low program, the marker is either never started or says LOW (0x1000), never medium.
#[test]
fn explorer_does_not_start_a_medium_program_for_a_low_one() {
    let explorer = format!(r"{}\explorer.exe", std::env::var("SystemRoot").unwrap());
    // Explorer takes no arguments for a program, so the marker is a copy of the attacker with its port in a file beside it.
    let go = |port: u16, tag: &str| {
        let dir = unique(tag);
        let exe = dir.join("zumi-r7d-marker.exe");
        std::fs::copy(CANARY, &exe).unwrap();
        std::fs::write(dir.join("zumi-r7d-marker.port"), port.to_string()).unwrap();
        a(&[&exe.to_string_lossy()])
    };
    let marker = |said: &str| said.lines().find(|l| l.starts_with("marker pid=")).map(str::to_string);
    // control
    let (l, port) = reporter();
    let root = unique("r7d-explorer-ctl");
    let (job, _p) = at_user_level(&explorer, &go(port, "r7d-marker-ctl"), &root);
    let said = collect(&l, 20, |t| t.contains("marker pid="));
    job.terminate();
    let ctl = marker(&said);
    eprintln!("R7d explorer CONTROL (user integrity): {ctl:?}");
    assert!(ctl.as_deref().is_some_and(|m| m.contains("rid=0x2000")), "the control must get Explorer to start a MEDIUM marker, or this probe proves nothing: {said:?}");
    // real: through the broker, a Low program
    let w = user_chosen_world("r7d-explorer", &explorer, true);
    let (l, port) = reporter();
    w.broker.spawn(ID, &explorer, &go(port, "r7d-marker-low"), Some(&w.workspace)).expect("spawned");
    let said = collect(&l, 20, |t| t.contains("marker pid="));
    let _ = w.broker.kill(ID);
    let low = marker(&said);
    eprintln!("R7d explorer from a Low program: {low:?}");
    assert!(low.as_deref().is_none_or(|m| !m.contains("rid=0x2000")), "Explorer started a MEDIUM program for a Low one: {low:?}");
}

/// Housekeeping, not a check: the tests start helpers in the containers `zumi-pack-power.canary` and `zumi-pack-r7c-test`, and the system keeps
/// a profile (a registry key of the user) for each until it is deleted. A real uninstall deletes the pack's own; run this after a test session:
/// `cargo test --features canary --test r7c_ui -- --ignored cleanup_test_containers`.
#[test]
#[ignore]
fn cleanup_test_containers() {
    for n in [zumi_packs::proc::container_name(ID).as_str(), "zumi-pack-r7c-test"] {
        zumi_packs::proc::forget_container(n);
    }
}
