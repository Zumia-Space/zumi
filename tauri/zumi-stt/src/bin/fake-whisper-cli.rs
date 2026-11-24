//! A stand-in for `whisper-cli` (whisper.cpp) for tests and goal harnesses (feature `fixture`). It takes the real flags
//! (`-m model -f wav -l lang -t threads -nt -np`), checks that it was given a readable model and a 16 kHz mono 16-bit WAV,
//! and prints the text a table maps the audio to (the `table` setting: lines `<fnv1a of the data chunk, hex>\t<text>`).
//! It cannot hear: the text comes from the table, so a test proves the plumbing, never the accuracy of a model.
//!
//! Settings come from `<model path>.fake` (one `key=value` per line), so parallel tests never share process state:
//!   `log`      append one line `args=<all args> wav=<path> prio=<class> exe=<the program that ran>` (a test reads the thread cap, language and temp path)
//!   `pidfile`  write this process id there (a test proves a killed child is gone)
//!   `mode`     hang | fail | grandchild (a child that keeps our stdout open for 6 s) | tree (a child and ourselves asleep) | flood (4 MB of output)
//!   `grandpidfile`  where the grandchild writes its pid
//!   `table`    path of the table
//! A file `runtime-missing.flag` beside the program makes it exit 0xC0000135 at once (a missing dll); `-h` exits 0.
use std::io::Write;
use std::process::{Command, Stdio};

fn fnv1a(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

fn data_chunk(wav: &[u8]) -> Option<&[u8]> {
    if wav.len() < 44 || &wav[0..4] != b"RIFF" || &wav[8..12] != b"WAVE" {
        return None;
    }
    let (channels, rate, bits) = (u16::from_le_bytes([wav[22], wav[23]]), u32::from_le_bytes([wav[24], wav[25], wav[26], wav[27]]), u16::from_le_bytes([wav[34], wav[35]]));
    if channels != 1 || rate != 16_000 || bits != 16 {
        return None;
    }
    let mut at = 12;
    while at + 8 <= wav.len() {
        let size = u32::from_le_bytes([wav[at + 4], wav[at + 5], wav[at + 6], wav[at + 7]]) as usize;
        if &wav[at..at + 4] == b"data" {
            return wav.get(at + 8..(at + 8 + size).min(wav.len()));
        }
        at += 8 + size + (size & 1);
    }
    None
}

/// The scheduling priority class this process runs at (0x4000 = below normal).
#[cfg(windows)]
fn priority_class() -> u32 {
    use windows::Win32::System::Threading::{GetCurrentProcess, GetPriorityClass};
    // SAFETY: the pseudo handle of this process; the call only reads.
    unsafe { GetPriorityClass(GetCurrentProcess()) }
}
#[cfg(not(windows))]
fn priority_class() -> u32 {
    0
}

fn main() {
    // A grandchild (this program again, asleep). It records its pid where the test looks, so the test can prove it is gone.
    if let Ok(mode) = std::env::var("FAKE_WHISPER_MODE") {
        if let Some(secs) = mode.strip_prefix("sleep").and_then(|s| s.parse::<u64>().ok()) {
            if let Ok(p) = std::env::var("FAKE_GRAND_PIDFILE") {
                let _ = std::fs::write(p, std::process::id().to_string());
            }
            std::thread::sleep(std::time::Duration::from_secs(secs));
            return;
        }
    }
    // `runtime-missing.flag` beside this program: what Windows does when a dll the program imports (the Visual C++ runtime,
    // the Vulkan loader) is not on the PC. The process dies with the loader's status before it can do anything.
    if std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.join("runtime-missing.flag"))).is_some_and(|f| f.exists()) {
        std::process::exit(0xC000_0135u32 as i32);
    }
    let args: Vec<String> = std::env::args().skip(1).collect();
    // `-h`: the install's one start of the program to see that it runs here.
    if args.iter().any(|a| a == "-h") {
        return;
    }
    let flag = |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned();
    let (model, wav_path) = (flag("-m"), flag("-f"));
    let config = model.as_ref().and_then(|m| std::fs::read_to_string(format!("{m}.fake")).ok()).unwrap_or_default();
    let setting = |key: &str| config.lines().find_map(|l| l.strip_prefix(&format!("{key}=")).map(str::to_string));
    if let Some(log) = setting("log") {
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(log) {
            let _ = writeln!(f, "args={} wav={} prio={:#x} exe={}", args.join(" "), wav_path.clone().unwrap_or_default(), priority_class(), std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_default());
        }
    }
    if let Some(p) = setting("pidfile") {
        let _ = std::fs::write(p, std::process::id().to_string());
    }
    if !model.as_ref().is_some_and(|m| std::path::Path::new(m).is_file()) {
        eprintln!("fake-whisper: no model");
        std::process::exit(4);
    }
    let Some(wav) = wav_path.as_ref().and_then(|p| std::fs::read(p).ok()) else {
        eprintln!("fake-whisper: no audio file");
        std::process::exit(5);
    };
    let Some(data) = data_chunk(&wav) else {
        eprintln!("fake-whisper: audio is not a 16 kHz mono 16-bit WAV");
        std::process::exit(6);
    };
    match setting("mode").as_deref() {
        Some("hang") => std::thread::sleep(std::time::Duration::from_secs(600)),
        Some("fail") => {
            eprintln!("fake-whisper: boom C:\\Profiles\\someone\\secret-path");
            std::process::exit(3);
        }
        Some("flood") => {
            let line = "x".repeat(1000);
            let mut out = std::io::stdout();
            for _ in 0..4000 {
                if writeln!(out, "{line}").is_err() {
                    break;
                }
            }
            return;
        }
        Some(mode @ ("grandchild" | "tree")) => {
            // The grandchild (this program again, asleep) inherits our stdout and stderr. `grandchild`: it outlives us by about
            // 6 s. `tree`: it sleeps 10 minutes and so do we (the test kills the tree and looks for both).
            let mut c = Command::new(std::env::current_exe().expect("own path"));
            c.env("FAKE_WHISPER_MODE", if mode == "tree" { "sleep600" } else { "sleep6" }).stdin(Stdio::null()).stdout(Stdio::inherit()).stderr(Stdio::inherit());
            if let Some(p) = setting("grandpidfile") {
                c.env("FAKE_GRAND_PIDFILE", p);
            }
            #[cfg(windows)]
            std::os::windows::process::CommandExt::creation_flags(&mut c, 0x0800_0000);
            let _ = c.spawn();
            if mode == "tree" {
                std::thread::sleep(std::time::Duration::from_secs(600));
            }
        }
        _ => {}
    }
    let want = format!("{:016x}", fnv1a(data));
    let table = setting("table").and_then(|p| std::fs::read_to_string(p).ok()).unwrap_or_default();
    for line in table.lines() {
        if let Some((hash, text)) = line.split_once('\t') {
            if hash == want {
                println!(" {text}");
            }
        }
    }
}
