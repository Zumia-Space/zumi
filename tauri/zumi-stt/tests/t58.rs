//! T58 (catalogue; matrix F40, plan R4): hold the hotkey, say one Vietnamese and one English sentence; text lands in the chat
//! input 10/10; zero egress while the local engine hears; the API engine reaches only the origin the user chose; WER measured.
//! Fixed audio files, no live microphone. The engines here are fakes (a table keyed by the audio), so this proves the whole
//! path from the hotkey to the input; WER of a real model is the `#[ignore]` test at the end (needs the program and a model).
mod common;
use common::*;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use zumi_egress::fixture::{FixtureResp, Server};
use zumi_stt::api::{ApiKind, ApiProvider};
use zumi_stt::dictation::{Dictation, Recorder, Sink};
use zumi_stt::hotkey::HotkeyEvent::{Press, Release};
use zumi_stt::local::LocalWhisper;
use zumi_stt::wer::wer;
use zumi_stt::{Stt, SttError};

const FAKE: &str = env!("CARGO_BIN_EXE_fake-whisper-cli");

/// Plays a fixture file as if it had just been recorded.
struct Playback {
    name: Mutex<&'static str>,
    cancelled: AtomicUsize,
}
impl Recorder for Playback {
    fn start(&self) -> Result<(), SttError> {
        Ok(())
    }
    fn finish(&self) -> Result<Vec<u8>, SttError> {
        Ok(fixture(self.name.lock().unwrap().as_ref()))
    }
    fn cancel(&self) {
        self.cancelled.fetch_add(1, Ordering::SeqCst);
    }
}

#[derive(Default)]
struct Input {
    texts: Mutex<Vec<String>>,
    notices: Mutex<Vec<&'static str>>,
}
impl Sink for Input {
    fn text(&self, t: &str) {
        self.texts.lock().unwrap().push(t.to_string());
    }
    fn notice(&self, c: &'static str) {
        self.notices.lock().unwrap().push(c);
    }
}

fn local_engine(tag: &str) -> Stt {
    let dir = temp_dir(tag);
    let model = dir.join("ggml-fake.bin");
    std::fs::write(&model, b"not a model").unwrap();
    std::fs::write(dir.join("ggml-fake.bin.fake"), format!("table={}\n", write_table(&dir).display())).unwrap();
    let work = dir.join("work");
    std::fs::create_dir_all(&work).unwrap();
    Stt::new(Box::new(LocalWhisper { exe: PathBuf::from(FAKE), model, threads: 2, language: None, work_dir: work, timeout: Duration::from_secs(20) }))
}

fn say(d: &Dictation, mic: &Playback, name: &'static str, input: &Input, expect: usize) {
    *mic.name.lock().unwrap() = name;
    d.on_hotkey(Press);
    d.on_hotkey(Release);
    let t0 = Instant::now();
    while input.texts.lock().unwrap().len() < expect || d.busy() {
        assert!(t0.elapsed() < Duration::from_secs(10), "{name}: no text after 10 s (notices {:?})", input.notices.lock().unwrap());
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn t58_local_engine_ten_of_ten_and_zero_egress() {
    if held_clips_absent("t58_local_engine_ten_of_ten_and_zero_egress") {
        return;
    }
    // A server stands by, and an egress audit hook: if the local engine opened any connection, one of them would see it.
    let bystander = Server::start(|_| FixtureResp::json(200, r#"{"text":"wrong"}"#));
    let stt = Arc::new(local_engine("t58-local"));
    let mic = Arc::new(Playback { name: Mutex::new(FIXTURES[0].0), cancelled: 0.into() });
    let input = Arc::new(Input::default());
    let d = Dictation::new(stt, mic.clone(), input.clone(), Duration::from_secs(60));
    let mut worst: f64 = 0.0;
    for i in 0..10 {
        let (name, _lang, phrase) = FIXTURES[i % FIXTURES.len()];
        say(&d, &mic, name, &input, i + 1);
        let heard = input.texts.lock().unwrap()[i].clone();
        worst = worst.max(wer(phrase, &heard));
        assert_eq!(heard, phrase, "run {i}: {name}");
    }
    assert_eq!(input.texts.lock().unwrap().len(), 10, "text landed 10/10");
    assert!(input.notices.lock().unwrap().is_empty());
    assert_eq!(bystander.hits(), 0, "zero egress while the local engine hears");
    println!("T58 local: 10/10 delivered, worst WER {worst:.3} (fake engine: the table, not a model)");
}

#[test]
fn t58_api_engine_ten_of_ten_and_only_the_chosen_origin() {
    if held_clips_absent("t58_api_engine_ten_of_ten_and_only_the_chosen_origin") {
        return;
    }
    let dir = temp_dir("t58-api");
    let table: HashMap<String, &'static str> = FIXTURES.iter().map(|(n, _, p)| (data_hash(&engine_wav(n)), *p)).collect();
    let chosen = Server::start(move |req| {
        let heard = multipart_file(&req.body, "file").map(|w| data_hash(&w)).and_then(|h| table.get(&h).copied());
        match heard {
            Some(text) => FixtureResp::json(200, &format!(r#"{{"text":"{text}"}}"#)),
            None => FixtureResp::json(400, "{}"),
        }
    });
    let other = Server::start(|_| FixtureResp::json(200, r#"{"text":"wrong"}"#));
    let lines: Arc<Mutex<Vec<String>>> = Arc::default();
    let l = lines.clone();
    let audit: Arc<dyn Fn(&str) + Send + Sync> = Arc::new(move |s: &str| l.lock().unwrap().push(s.to_string()));
    let api = ApiProvider::new(ApiKind::OpenAi, Some(&format!("{}/v1", chosen.origin())), "test-key-0001", Some("vi"), None, audit).unwrap();
    let stt = Arc::new(Stt::new(Box::new(api)));
    let mic = Arc::new(Playback { name: Mutex::new(FIXTURES[0].0), cancelled: 0.into() });
    let input = Arc::new(Input::default());
    let d = Dictation::new(stt, mic.clone(), input.clone(), Duration::from_secs(60));
    for i in 0..10 {
        let (name, _, phrase) = FIXTURES[i % FIXTURES.len()];
        say(&d, &mic, name, &input, i + 1);
        assert_eq!(input.texts.lock().unwrap()[i], phrase, "run {i}: {name}");
    }
    assert_eq!(chosen.hits(), 10, "one request per dictation, to the engine the user chose");
    assert_eq!(other.hits(), 0, "no other origin was touched");
    let lines = lines.lock().unwrap();
    assert_eq!(lines.len(), 10);
    let want = format!("egress {} 200", chosen.origin());
    assert!(lines.iter().all(|x| x == &want), "{lines:?}");
    drop(dir);
}

#[cfg(windows)]
#[test]
fn t58_hold_the_real_hotkey_say_it_and_the_text_lands() {
    if held_clips_absent("t58_hold_the_real_hotkey_say_it_and_the_text_lands") {
        return;
    }
    use windows::Win32::UI::Input::KeyboardAndMouse::{SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, VIRTUAL_KEY};
    use zumi_stt::hotkey::{Chord, Hotkey};
    fn key(vk: u32, up: bool) {
        let input = INPUT { r#type: INPUT_KEYBOARD, Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VIRTUAL_KEY(vk as u16), wScan: 0, dwFlags: if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) }, time: 0, dwExtraInfo: 0 } } };
        // SAFETY: one well-formed INPUT, its true size.
        assert_eq!(unsafe { SendInput(&[input], std::mem::size_of::<INPUT>() as i32) }, 1, "SendInput needs an interactive desktop");
        std::thread::sleep(Duration::from_millis(30));
    }
    // Ctrl+Alt+Shift+F23: no other program uses it, so the injected keys type nothing anywhere.
    let chord = Chord { id: "t58", label: "t58", mods: 1 | 2 | 4, vk: 0x86 };
    let stt = Arc::new(local_engine("t58-hotkey"));
    let mic = Arc::new(Playback { name: Mutex::new(FIXTURES[0].0), cancelled: 0.into() });
    let input = Arc::new(Input::default());
    let d = Arc::new(Dictation::new(stt, mic.clone(), input.clone(), Duration::from_secs(60)));
    let d2 = d.clone();
    let _hk = Hotkey::register(chord, move |e| d2.on_hotkey(e)).expect("the chord is free");
    for (i, (name, _, phrase)) in FIXTURES.iter().enumerate() {
        *mic.name.lock().unwrap() = name;
        for vk in [0x11, 0x12, 0x10, 0x86] {
            key(vk, false);
        }
        std::thread::sleep(Duration::from_millis(200)); // "speaking"
        for vk in [0x86, 0x10, 0x12, 0x11] {
            key(vk, true);
        }
        let t0 = Instant::now();
        while input.texts.lock().unwrap().len() <= i {
            assert!(t0.elapsed() < Duration::from_secs(10), "{name}: no text (notices {:?})", input.notices.lock().unwrap());
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(input.texts.lock().unwrap()[i], *phrase, "{name}");
    }
}

/// The real thing, run by hand: `ZUMI_WHISPER_EXE=<whisper-cli> ZUMI_WHISPER_MODEL=<ggml model> cargo test --features fixture
/// --test t58 -- --ignored --nocapture`. Thread cap 2 (the machine rules for the main PC). Prints each clip's WER.
#[test]
#[ignore = "needs whisper-cli and a ggml model on this PC"]
fn t58_real_whisper_wer() {
    if held_clips_absent("t58_real_whisper_wer") {
        return;
    }
    let (Ok(exe), Ok(model)) = (std::env::var("ZUMI_WHISPER_EXE"), std::env::var("ZUMI_WHISPER_MODEL")) else {
        panic!("set ZUMI_WHISPER_EXE and ZUMI_WHISPER_MODEL");
    };
    let work = temp_dir("t58-real");
    let mut total = 0.0;
    for (name, lang, phrase) in FIXTURES {
        let stt = Stt::new(Box::new(LocalWhisper { exe: PathBuf::from(&exe), model: PathBuf::from(&model), threads: 2, language: Some(lang.to_string()), work_dir: work.clone(), timeout: Duration::from_secs(120) }));
        let t0 = Instant::now();
        let heard = stt.transcribe(&fixture(name), &never).expect("the real engine hears the clip");
        let w = wer(phrase, &heard);
        println!("T58 real: {name} [{lang}] {:.1}s WER {w:.3}\n  want: {phrase}\n  heard: {heard}", t0.elapsed().as_secs_f64());
        total += w;
    }
    let mean = total / FIXTURES.len() as f64;
    println!("T58 real: mean WER {mean:.3}");
    assert!(mean <= 0.25, "mean WER {mean:.3}");
}

// ---- R4b: the 20-sentence set (10 vi + 10 en), fixed audio, WER on the real model ------------------------------------------------

/// (id, language, sentence) of `tests/fixtures/t58-20/sentences.tsv`.
fn set20() -> Vec<(String, String, String)> {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/t58-20");
    let text = std::fs::read_to_string(dir.join("sentences.tsv")).expect("the sentence list");
    text.lines().filter(|l| !l.trim().is_empty()).map(|l| {
        let f: Vec<&str> = l.splitn(3, '\t').collect();
        (f[0].to_string(), f[1].to_string(), f[2].to_string())
    }).collect()
}

fn set20_wav(id: &str) -> Vec<u8> {
    std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/t58-20").join(format!("{id}.wav"))).expect("a clip of the set")
}

#[test]
fn t58_the_set_is_twenty_fixed_sentences_ten_vi_and_ten_en_each_with_a_real_clip() {
    let set = set20();
    assert_eq!(set.len(), 20);
    assert_eq!(set.iter().filter(|s| s.1 == "vi").count(), 10);
    assert_eq!(set.iter().filter(|s| s.1 == "en").count(), 10);
    let mut seen = std::collections::HashSet::new();
    for (id, lang, text) in &set {
        assert!(seen.insert(text.clone()), "{id}: a sentence twice");
        assert!(text.split_whitespace().count() >= 6, "{id}: a sentence, not a word");
        let pcm = zumi_stt::wav::parse(&set20_wav(id)).expect("a WAV");
        let pcm = zumi_stt::wav::to_16k_mono(&pcm);
        assert!(!zumi_stt::wav::is_silent(&pcm), "{id} [{lang}] is silent");
        assert!((1.0..20.0).contains(&pcm.seconds()), "{id}: {} s", pcm.seconds());
    }
}

/// The real thing, run by hand:
/// `ZUMI_WHISPER_EXE=<whisper-cli> ZUMI_WHISPER_MODEL=<ggml model> [ZUMI_T58_OUT=<file.tsv>] cargo test --features fixture --test t58 -- --ignored --nocapture t58_real_whisper_wer_20`.
/// Thread cap 2 and below-normal priority (the local engine's own), one clip at a time. Prints every sentence with what was heard.
#[test]
#[ignore = "needs whisper-cli and a ggml model on this PC"]
fn t58_real_whisper_wer_20() {
    let (Ok(exe), Ok(model)) = (std::env::var("ZUMI_WHISPER_EXE"), std::env::var("ZUMI_WHISPER_MODEL")) else {
        panic!("set ZUMI_WHISPER_EXE and ZUMI_WHISPER_MODEL");
    };
    let work = temp_dir("t58-real20");
    let (mut sums, mut counts) = (HashMap::<String, f64>::new(), HashMap::<String, usize>::new());
    let mut table = String::from("id\tlang\tseconds\twer\treference\theard\n");
    for (id, lang, text) in set20() {
        let stt = Stt::new(Box::new(LocalWhisper { exe: PathBuf::from(&exe), model: PathBuf::from(&model), threads: 2, language: Some(lang.clone()), work_dir: work.clone(), timeout: Duration::from_secs(120) }));
        let t0 = Instant::now();
        let heard = stt.transcribe(&set20_wav(&id), &never).expect("the real engine hears the clip");
        let (secs, w) = (t0.elapsed().as_secs_f64(), wer(&text, &heard));
        println!("T58-20 {id} [{lang}] {secs:.1}s WER {w:.3}\n  want:  {text}\n  heard: {heard}");
        table.push_str(&format!("{id}\t{lang}\t{secs:.1}\t{w:.3}\t{text}\t{}\n", heard.replace('\t', " ")));
        *sums.entry(lang.clone()).or_default() += w;
        *counts.entry(lang).or_default() += 1;
    }
    let mean = |l: &str| sums[l] / counts[l] as f64;
    println!("T58-20 mean WER: vi {:.3} (n={}), en {:.3} (n={}), all {:.3}", mean("vi"), counts["vi"], mean("en"), counts["en"], sums.values().sum::<f64>() / 20.0);
    if let Ok(out) = std::env::var("ZUMI_T58_OUT") {
        std::fs::write(out, table).expect("write the result table");
    }
    assert!(mean("vi") <= 0.25 && mean("en") <= 0.25, "vi {:.3} en {:.3}", mean("vi"), mean("en"));
}
