//! Shared by the integration tests: fixtures, WAV builders, the table the fake engines read.
#![allow(dead_code)]
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

/// The recorded clips. Vietnamese: Piper `vi_VN-vais1000-medium` (22.05 kHz mono) saying the phrase; English: Windows SAPI
/// "Zira" (16 kHz mono). Synthesized, not a microphone: the catalogue's "recorded" clip is a fixed audio file, no live mic.
pub const FIXTURES: [(&str, &str, &str); 3] = [
    ("vi-chon-phuong-an-mot.wav", "vi", "Chọn phương án một"),
    ("vi-chi-tiet-muc-nay.wav", "vi", "Chi tiết mục này"),
    ("en-open-the-project-board.wav", "en", "Please open the project board and read the last message."),
];

/// The public source holds these three clips back until they are remade by a script (scripts/lib/zumi-only.cjs HOLD); a test that
/// plays them says so and skips there. True = skip.
pub fn held_clips_absent(test: &str) -> bool {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    let missing: Vec<&str> = FIXTURES.iter().map(|f| f.0).filter(|n| !dir.join(n).is_file()).collect();
    if missing.is_empty() {
        return false;
    }
    eprintln!("SKIP {test}: clip(s) not in this source tree (held from the public export): {}", missing.join(", "));
    true
}

pub fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name)).expect("fixture file")
}

static N: AtomicUsize = AtomicUsize::new(0);

/// A fresh empty directory under the system temp dir (the test run's own drive setting decides where that is).
pub fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("zumi-stt-{tag}-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// A 16-bit PCM WAV header plus `samples` (interleaved when `channels` is 2).
pub fn wav_bytes(rate: u32, channels: u16, samples: &[i16]) -> Vec<u8> {
    let data_len = (samples.len() * 2) as u32;
    let mut out = Vec::new();
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&channels.to_le_bytes());
    out.extend_from_slice(&rate.to_le_bytes());
    out.extend_from_slice(&(rate * channels as u32 * 2).to_le_bytes());
    out.extend_from_slice(&(channels * 2).to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for s in samples {
        out.extend_from_slice(&s.to_le_bytes());
    }
    out
}

pub fn silence(rate: u32, seconds: f64) -> Vec<u8> {
    wav_bytes(rate, 1, &vec![0i16; (rate as f64 * seconds) as usize])
}

/// A loud tone: not silent, and 16 kHz mono so it goes to an engine unchanged.
pub fn tone(seconds: f64) -> Vec<u8> {
    let n = (16_000.0 * seconds) as usize;
    let samples: Vec<i16> = (0..n).map(|i| ((i as f64 * 0.2).sin() * 12_000.0) as i16).collect();
    wav_bytes(16_000, 1, &samples)
}

/// FNV-1a of the `data` chunk: how the fake engines (the fake CLI and the mock API) tell the clips apart.
pub fn data_hash(wav: &[u8]) -> String {
    let mut at = 12;
    while at + 8 <= wav.len() {
        let size = u32::from_le_bytes([wav[at + 4], wav[at + 5], wav[at + 6], wav[at + 7]]) as usize;
        if &wav[at..at + 4] == b"data" {
            let mut h: u64 = 0xcbf29ce484222325;
            for b in &wav[at + 8..(at + 8 + size).min(wav.len())] {
                h ^= *b as u64;
                h = h.wrapping_mul(0x100000001b3);
            }
            return format!("{h:016x}");
        }
        at += 8 + size + (size & 1);
    }
    panic!("no data chunk");
}

/// What an engine is given for a fixture: the clip as 16 kHz mono 16-bit (the crate's own conversion).
pub fn engine_wav(name: &str) -> Vec<u8> {
    let pcm = zumi_stt::wav::parse(&fixture(name)).expect("fixture parses");
    zumi_stt::wav::encode(&zumi_stt::wav::to_16k_mono(&pcm))
}

/// The fake CLI's table: every fixture's engine audio -> its phrase.
pub fn write_table(dir: &Path) -> PathBuf {
    let path = dir.join("table.tsv");
    let text: String = FIXTURES.iter().map(|(name, _, phrase)| format!("{}\t{}\n", data_hash(&engine_wav(name)), phrase)).collect();
    std::fs::write(&path, text).unwrap();
    path
}

/// Pulls the file part (the bytes after the first blank line of the part named `file_field`) out of a multipart body.
pub fn multipart_file(body: &[u8], file_field: &str) -> Option<Vec<u8>> {
    let needle = format!("name=\"{file_field}\"");
    let at = find(body, needle.as_bytes())?;
    let start = at + find(&body[at..], b"\r\n\r\n")? + 4;
    let end = start + find(&body[start..], b"\r\n--")?;
    Some(body[start..end].to_vec())
}

/// The text value of a multipart field.
pub fn multipart_field(body: &[u8], name: &str) -> Option<String> {
    let needle = format!("name=\"{name}\"");
    let at = find(body, needle.as_bytes())?;
    let start = at + find(&body[at..], b"\r\n\r\n")? + 4;
    let end = start + find(&body[start..], b"\r\n--")?;
    Some(String::from_utf8_lossy(&body[start..end]).to_string())
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

pub fn never() -> bool {
    false
}

// ---------------------------------------------------------------------------------------------------- install fixtures

use sha2::Digest;
use std::sync::{Arc, Mutex};
use zumi_egress::fixture::{FixtureReq, FixtureResp, Server};

pub fn sha256_hex(bytes: &[u8]) -> String {
    sha2::Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// Pseudo-random, so a wrong offset shows up as a wrong hash.
pub fn blob(len: usize, seed: u64) -> Vec<u8> {
    let mut x = seed | 1;
    (0..len)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            (x >> 24) as u8
        })
        .collect()
}

/// The `range` header each hit carried (None for a whole-file request).
pub type Seen = Arc<Mutex<Vec<Option<String>>>>;

/// Serves `data`, honouring `Range: bytes=N-`.
pub fn serve(data: Vec<u8>) -> (Server, Seen) {
    let seen: Seen = Arc::default();
    let s = seen.clone();
    let server = Server::start(move |r: &FixtureReq| {
        let range = r.header("range").map(str::to_string);
        s.lock().unwrap().push(range.clone());
        match range.as_deref().and_then(|v| v.strip_prefix("bytes=")).and_then(|v| v.strip_suffix('-')).and_then(|v| v.parse::<usize>().ok()) {
            Some(from) if from < data.len() => FixtureResp::Full {
                status: 206,
                headers: vec![("content-range".into(), format!("bytes {from}-{}/{}", data.len() - 1, data.len()))],
                body: data[from..].to_vec(),
            },
            Some(_) => FixtureResp::empty(416),
            None => FixtureResp::Full { status: 200, headers: Vec::new(), body: data.clone() },
        }
    });
    (server, seen)
}

/// A zip made by the system's tar (the program is a zip): the fake CLI (`fake`) as `whisper-cli.exe`, a dll, and extras.
pub fn make_zip(dir: &Path, fake: &str, extra: &[(&str, &[u8])]) -> Vec<u8> {
    let src = dir.join("zipsrc");
    std::fs::create_dir_all(&src).unwrap();
    std::fs::copy(fake, src.join("whisper-cli.exe")).unwrap();
    std::fs::write(src.join("ggml.dll"), blob(5000, 7)).unwrap();
    let mut names = vec!["whisper-cli.exe".to_string(), "ggml.dll".to_string()];
    for (n, b) in extra {
        std::fs::write(src.join(n), b).unwrap();
        names.push(n.to_string());
    }
    let zip = dir.join("prog.zip");
    let out = std::process::Command::new(r"C:\Windows\System32\tar.exe").args(["-a", "-c", "-f"]).arg(&zip).arg("-C").arg(&src).args(&names).output().unwrap();
    assert!(out.status.success(), "tar: {}", String::from_utf8_lossy(&out.stderr));
    std::fs::read(zip).unwrap()
}
