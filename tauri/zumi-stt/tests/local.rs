//! whisper.cpp on this PC, supervised: the local engine against a fake `whisper-cli` (it takes the real flags and checks the
//! audio it is given; it cannot hear, so these tests prove supervision, never accuracy). Needs `--features fixture`.
mod common;
use common::*;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use zumi_stt::local::LocalWhisper;
use zumi_stt::{Clip, Provider};

const FAKE: &str = env!("CARGO_BIN_EXE_fake-whisper-cli");

struct Rig {
    dir: PathBuf,
    engine: LocalWhisper,
}

/// A fake model file, the fake CLI's settings next to it, and an engine pointing at both.
fn rig(tag: &str, settings: &[&str]) -> Rig {
    let dir = temp_dir(tag);
    let model = dir.join("ggml-fake.bin");
    std::fs::write(&model, b"not a model").unwrap();
    let clip = tone(1.0);
    let table = dir.join("table.tsv");
    std::fs::write(&table, format!("{}\tmade up text\n", data_hash(&clip))).unwrap();
    let mut config = format!("log={}\npidfile={}\ntable={}\ngrandpidfile={}\n", dir.join("log.txt").display(), dir.join("pid.txt").display(), table.display(), dir.join("grand.txt").display());
    for s in settings {
        config.push_str(s);
        config.push('\n');
    }
    std::fs::write(dir.join("ggml-fake.bin.fake"), config).unwrap();
    let work = dir.join("work");
    std::fs::create_dir_all(&work).unwrap();
    let engine = LocalWhisper { exe: PathBuf::from(FAKE), model, threads: 2, language: None, work_dir: work, timeout: Duration::from_secs(20) };
    Rig { dir, engine }
}

fn clip() -> Clip {
    Clip { wav: tone(1.0), seconds: 1.0 }
}

fn log(r: &Rig) -> String {
    std::fs::read_to_string(r.dir.join("log.txt")).unwrap_or_default()
}

fn process_alive(pid: u32) -> bool {
    let out = std::process::Command::new("tasklist").args(["/FI", &format!("PID eq {pid}"), "/NH"]).output().unwrap();
    String::from_utf8_lossy(&out.stdout).contains(&pid.to_string())
}

fn pid(r: &Rig) -> u32 {
    std::fs::read_to_string(r.dir.join("pid.txt")).unwrap().trim().parse().unwrap()
}

fn leftovers(dir: &Path) -> usize {
    std::fs::read_dir(dir).unwrap().count()
}

#[test]
fn it_runs_the_cli_with_the_thread_cap_the_model_the_language_and_below_normal_priority_then_removes_the_audio_file() {
    let mut r = rig("args", &[]);
    r.engine.language = Some("vi".into());
    assert_eq!(r.engine.transcribe(&clip(), &never), Ok("made up text".to_string()));
    let line = log(&r);
    assert!(line.contains(" -t 2 ") || line.contains("-t 2"), "{line}");
    assert!(line.contains("-l vi") && line.contains("-nt") && line.contains("-np"), "{line}");
    assert!(line.contains(&format!("-m {}", r.engine.model.display())), "{line}");
    assert!(line.contains("prio=0x4000"), "below-normal priority: {line}");
    assert_eq!(leftovers(&r.engine.work_dir), 0, "the temp audio file is gone");
    assert!(line.contains(&r.engine.work_dir.display().to_string()), "the audio file lived in the work dir: {line}");

    r.engine.language = None;
    r.engine.threads = 99;
    r.engine.transcribe(&clip(), &never).unwrap();
    let line = log(&r);
    assert!(line.lines().last().unwrap().contains("-l auto"), "no language set: whisper detects it: {line}");
    assert!(line.lines().last().unwrap().contains("-t 16"), "the cap is clamped: {line}");
    r.engine.threads = 0;
    r.engine.transcribe(&clip(), &never).unwrap();
    assert!(log(&r).lines().last().unwrap().contains("-t 1"));
}

#[test]
fn a_missing_program_or_model_is_one_code_word_and_nothing_is_started() {
    let mut r = rig("missing", &[]);
    r.engine.model = r.dir.join("no-such-model.bin");
    assert_eq!(r.engine.transcribe(&clip(), &never).unwrap_err().code(), "stt_local_missing");
    r.engine.model = r.dir.join("ggml-fake.bin");
    r.engine.exe = r.dir.join("no-such-whisper-cli.exe");
    assert_eq!(r.engine.transcribe(&clip(), &never).unwrap_err().code(), "stt_local_missing");
    assert_eq!(log(&r), "", "the CLI never ran");
    assert_eq!(leftovers(&r.engine.work_dir), 0);
}

#[test]
fn a_failed_run_is_one_code_word_that_carries_nothing_the_program_printed() {
    let r = rig("fail", &["mode=fail"]);
    let err = r.engine.transcribe(&clip(), &never).unwrap_err();
    assert_eq!(err.code(), "stt_local_failed");
    assert!(!format!("{err:?}").contains("secret-path"));
    assert_eq!(leftovers(&r.engine.work_dir), 0, "the temp audio file is gone after a failure too");
}

#[test]
fn a_run_past_its_time_is_killed_and_reported() {
    let mut r = rig("timeout", &["mode=hang"]);
    r.engine.timeout = Duration::from_millis(800);
    let t0 = Instant::now();
    assert_eq!(r.engine.transcribe(&clip(), &never).unwrap_err().code(), "stt_local_timeout");
    assert!(t0.elapsed() < Duration::from_secs(5), "{:?}", t0.elapsed());
    std::thread::sleep(Duration::from_millis(300));
    assert!(!process_alive(pid(&r)), "the CLI was killed, not left running");
    assert_eq!(leftovers(&r.engine.work_dir), 0);
}

#[test]
fn cancel_kills_the_run_at_once() {
    let r = rig("cancel", &["mode=hang"]);
    let t0 = Instant::now();
    let err = r.engine.transcribe(&clip(), &|| t0.elapsed() > Duration::from_millis(500)).unwrap_err();
    assert_eq!(err.code(), "stt_cancelled");
    assert!(t0.elapsed() < Duration::from_secs(3), "{:?}", t0.elapsed());
    std::thread::sleep(Duration::from_millis(300));
    assert!(!process_alive(pid(&r)), "the CLI was killed");
    assert_eq!(leftovers(&r.engine.work_dir), 0);
}

#[test]
fn a_grandchild_that_keeps_the_pipe_open_does_not_hold_the_answer() {
    // GATE-OPUS-R1 should-fix 2: a program that outlives the CLI while holding its stdout made the reader wait for it.
    let r = rig("grandchild", &["mode=grandchild"]);
    let t0 = Instant::now();
    assert_eq!(r.engine.transcribe(&clip(), &never), Ok("made up text".to_string()));
    assert!(t0.elapsed() < Duration::from_secs(3), "answered after {:?}; the grandchild lives 6 s", t0.elapsed());
}

#[test]
fn a_program_that_floods_its_output_is_stopped_at_the_cap() {
    let r = rig("flood", &["mode=flood"]);
    let t0 = Instant::now();
    assert_eq!(r.engine.transcribe(&clip(), &never).unwrap_err().code(), "stt_bad_reply");
    assert!(t0.elapsed() < Duration::from_secs(10), "{:?}", t0.elapsed());
}

#[cfg(windows)]
#[test]
fn our_own_standard_handles_are_kept_from_the_children_we_start() {
    use windows::Win32::Foundation::{GetHandleInformation, HANDLE_FLAG_INHERIT};
    use windows::Win32::System::Console::{GetStdHandle, STD_ERROR_HANDLE, STD_OUTPUT_HANDLE};
    let r = rig("inherit", &[]);
    r.engine.transcribe(&clip(), &never).unwrap();
    for which in [STD_OUTPUT_HANDLE, STD_ERROR_HANDLE] {
        // SAFETY: reading flags of this process's own std handles.
        let h = unsafe { GetStdHandle(which) }.unwrap();
        if h.is_invalid() {
            continue; // no console and no pipe: nothing to protect
        }
        let mut flags = 0u32;
        // SAFETY: as above.
        unsafe { GetHandleInformation(h, &mut flags) }.unwrap();
        assert_eq!(flags & HANDLE_FLAG_INHERIT.0, 0, "std handle {which:?} is still inheritable after a child was started");
    }
}

// ---- R4b item 3: the whole tree dies (a Windows job object), and a crash leaves no audio behind -----------------------------

fn grand_pid(r: &Rig) -> Option<u32> {
    std::fs::read_to_string(r.dir.join("grand.txt")).ok().and_then(|t| t.trim().parse().ok())
}

/// True when the process is gone within 3 s (a wall-clock limit: `tasklist` itself takes a while per call).
fn wait_dead(pid: u32) -> bool {
    let t0 = Instant::now();
    while t0.elapsed() < Duration::from_secs(3) {
        if !process_alive(pid) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    !process_alive(pid)
}

fn tree_rig(tag: &str, mode: &str) -> Rig {
    rig(tag, &[&format!("mode={mode}")])
}

#[test]
fn cancel_kills_the_cli_and_the_program_it_started() {
    let r = tree_rig("tree-cancel", "tree");
    let t0 = Instant::now();
    let err = r.engine.transcribe(&clip(), &|| grand_pid(&r).is_some() || t0.elapsed() > Duration::from_secs(10)).unwrap_err();
    assert_eq!(err.code(), "stt_cancelled");
    let (cli, grand) = (pid(&r), grand_pid(&r).expect("the grandchild started"));
    assert!(wait_dead(cli), "the CLI is dead");
    assert!(wait_dead(grand), "the grandchild of the CLI is dead too (a job object kills the tree)");
}

#[test]
fn a_timeout_kills_the_tree_too() {
    let mut r = tree_rig("tree-timeout", "tree");
    r.engine.timeout = Duration::from_millis(1500);
    assert_eq!(r.engine.transcribe(&clip(), &never).unwrap_err().code(), "stt_local_timeout");
    let grand = grand_pid(&r).expect("the grandchild started");
    assert!(wait_dead(pid(&r)), "the CLI is dead");
    assert!(wait_dead(grand), "the grandchild is dead");
}

#[test]
fn a_helper_left_behind_by_a_finished_run_is_stopped_with_it() {
    // The answer still does not wait for the helper (the test above this block), but the helper does not outlive the run.
    let r = tree_rig("tree-exit", "grandchild");
    assert_eq!(r.engine.transcribe(&clip(), &never), Ok("made up text".to_string()));
    let grand = grand_pid(&r).expect("the grandchild started");
    assert!(wait_dead(grand), "the helper that held the pipe is gone once the run is over");
}

#[test]
fn leftover_audio_of_a_crashed_run_is_swept_and_a_live_runs_audio_is_not() {
    use zumi_stt::local::sweep_stale;
    let dir = temp_dir("sweep");
    // A process that has exited: its pid is dead.
    let mut child = std::process::Command::new(FAKE).env("FAKE_WHISPER_MODE", "sleep0").spawn().unwrap();
    let dead_pid = child.id();
    child.wait().unwrap();
    let stale = dir.join(format!("stt-{dead_pid}-1a2b-0.wav"));
    let live = dir.join(format!("stt-{}-1a2b-1.wav", std::process::id()));
    let foreign = dir.join("notes.wav");
    let other = dir.join(format!("stt-{dead_pid}-1a2b-0.txt"));
    for p in [&stale, &live, &foreign, &other] {
        std::fs::write(p, b"audio").unwrap();
    }
    assert_eq!(sweep_stale(&dir), 1, "exactly the dead process's file");
    assert!(!stale.exists());
    assert!(live.exists(), "this process is alive: its file may be in use");
    assert!(foreign.exists() && other.exists(), "only stt-<pid>-*.wav files are ours to delete");
    assert_eq!(sweep_stale(&dir.join("no-such-dir")), 0, "a missing folder is nothing to sweep");
}

/// A private copy of the fake CLI in its own folder (a flag file beside the program is how the fake plays "a dll is missing").
fn own_program(r: &Rig) -> PathBuf {
    let dir = r.dir.join("prog");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::copy(FAKE, dir.join("whisper-cli.exe")).unwrap();
    dir.join("whisper-cli.exe")
}

#[test]
fn a_program_the_loader_cannot_start_is_named_so_the_screen_can_say_what_to_do() {
    // The Visual C++ runtime or a Vulkan driver is not on the PC: Windows ends the process with 0xC0000135 before it runs.
    // Not "failed": the person can act on this one (install the runtime, or pick an API engine).
    let mut r = rig("runtime", &[]);
    r.engine.exe = own_program(&r);
    assert_eq!(r.engine.transcribe(&clip(), &never), Ok("made up text".to_string()), "control: the same program runs");
    std::fs::write(r.engine.exe.with_file_name("runtime-missing.flag"), b"x").unwrap();
    let err = r.engine.transcribe(&clip(), &never).unwrap_err();
    assert_eq!(err.code(), "stt_local_runtime_missing");
    assert_eq!(leftovers(&r.engine.work_dir), 0, "the temp audio is gone");
    // Any other failure is still the plain one (the fail twin above), so the message is not shown for a bad model.
}

#[test]
fn probing_the_program_tells_a_program_that_runs_from_one_the_loader_refused() {
    let r = rig("probe", &[]);
    let exe = own_program(&r);
    assert_eq!(zumi_stt::local::probe(&exe), Ok(()));
    std::fs::write(exe.with_file_name("runtime-missing.flag"), b"x").unwrap();
    assert_eq!(zumi_stt::local::probe(&exe).unwrap_err().code(), "stt_local_runtime_missing");
    // A program that is not there is not "a runtime is missing" either.
    assert_eq!(zumi_stt::local::probe(&r.dir.join("nope.exe")).unwrap_err().code(), "stt_local_missing");
}
