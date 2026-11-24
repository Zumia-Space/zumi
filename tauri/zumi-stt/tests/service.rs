//! R4b items 1 and 2: the host-side service that makes dictated text reach the chat input, and that only the owner's settings
//! screen may configure. No window, no real hotkey and no microphone: the hotkey port is a fake that hands the test the
//! callback, and the "page" is the test (it answers the `Stop` event with a recorded WAV, as the webview does).
//! Needs `--features fixture` (the fake whisper CLI).
mod common;
use common::*;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use zumi_egress::fixture::{FixtureResp, Server};
use zumi_stt::hotkey::{Chord, HotkeyEvent};
use zumi_stt::install::{Item, Manifest, Place};
use zumi_stt::policy::Policy;
use zumi_stt::service::{Caller, Config, Event, HotkeyPort, Service};
use zumi_stt::SttError;

const FAKE: &str = env!("CARGO_BIN_EXE_fake-whisper-cli");
const SECRET: &str = "sk-SERVICE-TEST-SECRET-VALUE";

fn b64(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for c in bytes.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

/// A hotkey port that keeps the callback so the test can press and release by hand.
#[derive(Default)]
struct FakePort {
    taken: Mutex<bool>,
    registered: Mutex<Vec<&'static str>>,
    live: Arc<Mutex<Vec<&'static str>>>,
    callback: Mutex<Option<Arc<dyn Fn(HotkeyEvent) + Send + Sync>>>,
}
struct Registration {
    chord: &'static str,
    live: Arc<Mutex<Vec<&'static str>>>,
}
impl Drop for Registration {
    fn drop(&mut self) {
        let mut l = self.live.lock().unwrap();
        if let Some(i) = l.iter().position(|c| *c == self.chord) {
            l.remove(i);
        }
    }
}
impl HotkeyPort for FakePort {
    fn register(&self, chord: Chord, on: Arc<dyn Fn(HotkeyEvent) + Send + Sync>) -> Result<Box<dyn Send>, SttError> {
        if *self.taken.lock().unwrap() {
            return Err(SttError("stt_hotkey_taken"));
        }
        self.registered.lock().unwrap().push(chord.id);
        self.live.lock().unwrap().push(chord.id);
        *self.callback.lock().unwrap() = Some(on);
        Ok(Box::new(Registration { chord: chord.id, live: self.live.clone() }))
    }
}
impl FakePort {
    fn press(&self) {
        (self.callback.lock().unwrap().clone().expect("a registered hotkey"))(HotkeyEvent::Press);
    }
    fn release(&self) {
        (self.callback.lock().unwrap().clone().expect("a registered hotkey"))(HotkeyEvent::Release);
    }
}

struct Rig {
    dir: PathBuf,
    svc: Service,
    port: Arc<FakePort>,
    events: Arc<Mutex<Vec<Event>>>,
    audit: Arc<Mutex<Vec<String>>>,
}

/// `<dir>/bin/whisper-cli.exe` is a copy of the fake CLI (the one program the policy knows), `<dir>/ggml-fake.bin` its model,
/// the table maps the 1 s tone to "made up text".
fn rig(tag: &str) -> Rig {
    let dir = temp_dir(tag);
    let bin = dir.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::copy(FAKE, bin.join("whisper-cli.exe")).unwrap();
    std::fs::write(dir.join("ggml-fake.bin"), b"not a model").unwrap();
    let table = dir.join("table.tsv");
    std::fs::write(&table, format!("{}\tmade up text\n", data_hash(&tone(1.0)))).unwrap();
    std::fs::write(dir.join("ggml-fake.bin.fake"), format!("table={}\n", table.display())).unwrap();
    rig_in(dir, Policy { exe_dirs: vec![bin] })
}

fn rig_in(dir: PathBuf, policy: Policy) -> Rig {
    rig_full(dir, policy, Manifest::default())
}

fn rig_full(dir: PathBuf, policy: Policy, install: Manifest) -> Rig {
    let port = Arc::new(FakePort::default());
    let events = Arc::new(Mutex::new(Vec::new()));
    let audit = Arc::new(Mutex::new(Vec::new()));
    let (e, a) = (events.clone(), audit.clone());
    let svc = Service::start(Config {
        data_dir: dir.join("data"),
        policy,
        env: Arc::new(|name| if name == "OPENAI_API_KEY" || name == "PATH" { Some(SECRET.to_string()) } else { None }),
        audit: Arc::new(move |l| a.lock().unwrap().push(l.to_string())),
        emit: Arc::new(move |ev| e.lock().unwrap().push(ev)),
        hotkeys: port.clone(),
        max_listen: Duration::from_secs(60),
        audio_wait: Duration::from_secs(5),
        install,
        redirect_ok: Arc::new(|u| u.starts_with("http://127.0.0.1:")),
    });
    Rig { dir, svc, port, events, audit }
}

fn local_settings(r: &Rig) -> Value {
    json!({"engine": "local", "whisperExe": r.dir.join("bin").join("whisper-cli.exe"), "whisperModel": r.dir.join("ggml-fake.bin"), "threads": 2, "language": "vi"})
}

fn owner(r: &Rig, method: &str, args: Vec<Value>) -> Value {
    r.svc.handle(Caller::OwnerUi, method, &args)
}

fn wait_for(r: &Rig, what: &str, f: impl Fn(&[Event]) -> bool) {
    let t0 = Instant::now();
    while t0.elapsed() < Duration::from_secs(15) {
        if f(&r.events.lock().unwrap()) {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("never saw: {what}; events so far: {:?}", r.events.lock().unwrap());
}

// ---------------------------------------------------------------------------------------------------------------- the owner only

#[test]
fn only_the_owners_settings_screen_may_change_or_drive_voice_in() {
    let r = rig("svc-owner");
    for who in [Caller::Model, Caller::Sidecar, Caller::Hands] {
        for (m, args) in [("stt.set", vec![local_settings(&r)]), ("stt.state", vec![]), ("stt.ptt", vec![json!("press")]), ("stt.audio", vec![json!(b64(&tone(1.0)))]), ("stt.install", vec![json!("start")]), ("stt.install", vec![json!("cancel")])] {
            let out = r.svc.handle(who, m, &args);
            assert_eq!(out, json!({"ok": false, "error": "stt_not_owner"}), "{who:?} {m}");
        }
    }
    assert!(!r.dir.join("data").join("stt.json").exists(), "nothing was saved");
    assert!(r.port.registered.lock().unwrap().is_empty(), "no hotkey was registered");
    assert!(r.events.lock().unwrap().is_empty());
    assert_eq!(owner(&r, "stt.state", vec![])["engine"], Value::Null, "still not configured");
    assert_eq!(owner(&r, "stt.set", vec![local_settings(&r)])["ok"], true, "the owner can");
    assert!(r.dir.join("data").join("stt.json").is_file());
}

#[test]
fn an_unknown_method_is_refused_and_the_names_are_the_five_the_inventory_lists() {
    let r = rig("svc-names");
    assert_eq!(owner(&r, "stt.nope", vec![]), json!({"ok": false, "error": "unknown_method"}));
    for m in ["stt.state", "stt.set", "stt.ptt", "stt.audio", "stt.install"] {
        assert!(Service::is_method(m), "{m}");
    }
    assert!(!Service::is_method("stt.set2") && !Service::is_method("talk.send") && !Service::is_method("stt"));
}

#[test]
fn a_setting_the_policy_refuses_is_not_saved_and_the_old_one_keeps_working() {
    let r = rig("svc-policy");
    assert_eq!(owner(&r, "stt.set", vec![local_settings(&r)])["ok"], true);
    let before = std::fs::read_to_string(r.dir.join("data").join("stt.json")).unwrap();
    for bad in [
        json!({"engine": "local", "whisperExe": r"C:\Windows\System32\cmd.exe", "whisperModel": r.dir.join("ggml-fake.bin")}),
        json!({"engine": "openai", "keyEnv": "PATH"}),
        json!({"engine": "openai", "keyEnv": "OPENAI_API_KEY", "baseUrl": "https://evil.example/v1"}),
        json!({"engine": "fish", "chord": "ctrl-a"}),
        json!({"engine": "fish", "keyEnv": "FISH_API_KEY", "surprise": 1}),
    ] {
        let out = owner(&r, "stt.set", vec![bad.clone()]);
        assert_eq!(out["ok"], false, "{bad}");
        assert!(out["error"].as_str().unwrap().starts_with("stt_") || out["error"].as_str().unwrap().starts_with("egress_"), "{out}");
    }
    assert_eq!(std::fs::read_to_string(r.dir.join("data").join("stt.json")).unwrap(), before, "the file is untouched");
    assert_eq!(owner(&r, "stt.state", vec![])["engine"], "local", "the old engine is still the engine");
}

#[test]
fn a_tampered_settings_file_runs_nothing() {
    // Whoever can write the file (not through stt.set) still cannot make the host start another program or read another variable.
    let r = rig("svc-tamper");
    let data = r.dir.join("data");
    std::fs::create_dir_all(&data).unwrap();
    std::fs::write(data.join("stt.json"), json!({"engine": "local", "whisperExe": r"C:\Windows\System32\cmd.exe", "whisperModel": r.dir.join("ggml-fake.bin")}).to_string()).unwrap();
    let again = rig_in(r.dir.clone(), Policy { exe_dirs: vec![r.dir.join("bin")] });
    let state = again.svc.handle(Caller::OwnerUi, "stt.state", &[]);
    assert_eq!(state["ready"], false);
    assert_eq!(state["error"], "stt_policy_exe");
    assert!(again.port.registered.lock().unwrap().is_empty(), "no hotkey for a refused setting");
    // And the key variable: a tampered keyEnv names PATH; the host never reads it.
    std::fs::write(data.join("stt.json"), json!({"engine": "openai", "keyEnv": "PATH"}).to_string()).unwrap();
    let again = rig_in(r.dir.clone(), Policy { exe_dirs: vec![] });
    assert_eq!(again.svc.handle(Caller::OwnerUi, "stt.state", &[])["error"], "stt_policy_key");
}

#[test]
fn the_state_never_shows_a_key() {
    let r = rig("svc-key");
    assert_eq!(owner(&r, "stt.set", vec![json!({"engine": "openai", "keyEnv": "OPENAI_API_KEY"})])["ok"], true);
    let state = owner(&r, "stt.state", vec![]);
    assert_eq!(state["keyEnv"], "OPENAI_API_KEY", "the NAME is shown");
    assert_eq!(state["keySet"], true, "whether it is set is shown");
    assert!(!state.to_string().contains(SECRET), "the value never is: {state}");
    assert!(!std::fs::read_to_string(r.dir.join("data").join("stt.json")).unwrap().contains(SECRET));
    assert!(state["keyEnvNames"].to_string().contains("OPENAI_API_KEY") && state["keyEnvNames"].to_string().contains("ZUMI_STT_API_KEY"), "the settings screen offers the allow-list");
    assert_eq!(state["chords"].as_array().unwrap().len(), 3);
}

// -------------------------------------------------------------------------------------------------------------- text reaches the page

#[test]
fn hold_the_hotkey_speak_release_and_the_words_reach_the_page() {
    let r = rig("svc-hotkey");
    assert_eq!(owner(&r, "stt.set", vec![local_settings(&r)])["ok"], true);
    assert_eq!(r.port.registered.lock().unwrap().as_slice(), ["ctrl-opt-space"], "the default chord");

    r.port.press();
    wait_for(&r, "start", |e| e.contains(&Event::Start));
    r.port.release();
    wait_for(&r, "stop", |e| e.contains(&Event::Stop));
    // The page answers with what it recorded.
    assert_eq!(owner(&r, "stt.audio", vec![json!(b64(&tone(1.0)))])["ok"], true);
    wait_for(&r, "text", |e| e.contains(&Event::Text("made up text".into())));
    assert!(!r.dir.join("data").join("stt").read_dir().map(|mut d| d.any(|f| f.unwrap().file_name().to_string_lossy().ends_with(".wav"))).unwrap_or(false), "no audio file is left");
    assert!(r.audit.lock().unwrap().is_empty(), "the local engine makes no network request");
}

#[test]
fn the_mic_button_does_the_same_through_stt_ptt() {
    let r = rig("svc-button");
    assert_eq!(owner(&r, "stt.set", vec![local_settings(&r)])["ok"], true);
    assert_eq!(owner(&r, "stt.ptt", vec![json!("press")])["ok"], true);
    wait_for(&r, "start", |e| e.contains(&Event::Start));
    assert_eq!(owner(&r, "stt.ptt", vec![json!("release")])["ok"], true);
    wait_for(&r, "stop", |e| e.contains(&Event::Stop));
    owner(&r, "stt.audio", vec![json!(b64(&tone(1.0)))]);
    wait_for(&r, "text", |e| e.contains(&Event::Text("made up text".into())));
    assert_eq!(owner(&r, "stt.ptt", vec![json!("jump")])["error"], "stt_bad_args");
}

#[test]
fn audio_nobody_asked_for_is_refused_and_oversize_or_broken_audio_is_one_code_word() {
    let r = rig("svc-audio");
    assert_eq!(owner(&r, "stt.set", vec![local_settings(&r)])["ok"], true);
    assert_eq!(owner(&r, "stt.audio", vec![json!(b64(&tone(1.0)))]), json!({"ok": false, "error": "stt_not_waiting"}), "no recording is waiting for it");

    r.port.press();
    wait_for(&r, "start", |e| e.contains(&Event::Start));
    r.port.release();
    wait_for(&r, "stop", |e| e.contains(&Event::Stop));
    assert_eq!(owner(&r, "stt.audio", vec![json!("!!! not base64 !!!")])["error"], "stt_audio_bad");
    // The clip was refused; the flow ends with a notice, never text.
    wait_for(&r, "notice", |e| e.iter().any(|x| matches!(x, Event::Notice(_))));
    assert!(!r.events.lock().unwrap().iter().any(|x| matches!(x, Event::Text(_))));

    let huge = "A".repeat(20 * 1024 * 1024);
    assert_eq!(owner(&r, "stt.audio", vec![json!(huge)])["error"], "stt_audio_too_large");
}

#[test]
fn a_page_that_never_answers_ends_with_a_notice_not_a_hang() {
    let dir = temp_dir("svc-silent");
    let bin = dir.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::copy(FAKE, bin.join("whisper-cli.exe")).unwrap();
    std::fs::write(dir.join("ggml-fake.bin"), b"x").unwrap();
    let port = Arc::new(FakePort::default());
    let events = Arc::new(Mutex::new(Vec::new()));
    let e2 = events.clone();
    let svc = Service::start(Config {
        data_dir: dir.join("data"),
        policy: Policy { exe_dirs: vec![bin.clone()] },
        env: Arc::new(|_| None),
        audit: Arc::new(|_| {}),
        emit: Arc::new(move |ev| e2.lock().unwrap().push(ev)),
        hotkeys: port.clone(),
        max_listen: Duration::from_secs(60),
        audio_wait: Duration::from_millis(300),
        install: Manifest::default(),
        redirect_ok: Arc::new(|_| false),
    });
    let set = json!({"engine": "local", "whisperExe": bin.join("whisper-cli.exe"), "whisperModel": dir.join("ggml-fake.bin")});
    assert_eq!(svc.handle(Caller::OwnerUi, "stt.set", &[set])["ok"], true);
    port.press();
    std::thread::sleep(Duration::from_millis(100));
    port.release();
    let t0 = Instant::now();
    while t0.elapsed() < Duration::from_secs(5) && !events.lock().unwrap().iter().any(|x| matches!(x, Event::Notice(_))) {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(events.lock().unwrap().contains(&Event::Notice("stt_audio_missing")), "{:?}", events.lock().unwrap());
}

// ------------------------------------------------------------------------------------------- the program that passed is the program that runs

/// A directory junction `link` -> `target` (no privilege needed, unlike a symlink).
fn junction(link: &std::path::Path, target: &std::path::Path) {
    let out = std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(link).arg(target).output().unwrap();
    assert!(out.status.success(), "mklink: {}", String::from_utf8_lossy(&out.stdout));
}

fn drop_junction(link: &std::path::Path) {
    // `rmdir` on a junction removes the link only, never what it points at.
    let out = std::process::Command::new("cmd").args(["/C", "rmdir"]).arg(link).output().unwrap();
    assert!(out.status.success());
}

#[test]
fn the_program_started_is_the_file_that_passed_the_check_even_if_the_path_is_pointed_elsewhere_afterwards() {
    // GATE-OPUS-R4B should-fix 1: the check canonicalised the path, but the run started the raw setting. A junction that passed
    // the check (it led into the known folder) could be re-pointed to another folder between the check and the run.
    let r = rig("svc-toctou");
    let log = r.dir.join("log.txt");
    let config = r.dir.join("ggml-fake.bin.fake");
    let mut text = std::fs::read_to_string(&config).unwrap();
    text.push_str(&format!("log={}\n", log.display()));
    std::fs::write(&config, text).unwrap();
    let decoy = r.dir.join("decoy");
    std::fs::create_dir_all(&decoy).unwrap();
    std::fs::copy(FAKE, decoy.join("whisper-cli.exe")).unwrap();
    let link = r.dir.join("link");
    junction(&link, &r.dir.join("bin"));

    let mut s = local_settings(&r);
    s["whisperExe"] = json!(link.join("whisper-cli.exe"));
    assert_eq!(owner(&r, "stt.set", vec![s])["ok"], true, "the junction leads into the known folder: allowed");
    // After the check, the link is pointed at a folder that is not on the list.
    drop_junction(&link);
    junction(&link, &decoy);

    r.port.press();
    wait_for(&r, "start", |e| e.contains(&Event::Start));
    r.port.release();
    wait_for(&r, "stop", |e| e.contains(&Event::Stop));
    owner(&r, "stt.audio", vec![json!(b64(&tone(1.0)))]);
    wait_for(&r, "text", |e| e.contains(&Event::Text("made up text".into())));
    let ran = std::fs::read_to_string(&log).unwrap();
    drop_junction(&link);
    assert!(!ran.contains("link"), "the program that ran was not started through the link: {ran}");
    assert!(ran.contains(r"\bin\whisper-cli.exe"), "it is the file that passed the check: {ran}");
}

// ------------------------------------------------------------------------------------------------------------ first-use install

/// An install rig: a model (300 kB) and a program zip (the fake CLI) on local servers, `<dir>/data/whisper` on the policy's list.
struct Hosted {
    r: Rig,
    model: Vec<u8>,
    _servers: Vec<Server>,
    seen: Vec<Seen>,
}

fn item_model(url: String, data: &[u8]) -> Item {
    Item { id: "model", file: "ggml-test.bin".into(), url, sha256: sha256_hex(data), bytes: data.len() as u64, disk: data.len() as u64, place: Place::File }
}

fn hosted(tag: &str, extra: &[(&str, &[u8])], with_program: bool) -> Hosted {
    let dir = temp_dir(tag);
    let model = blob(300_000, 21);
    let (m, ms) = serve(model.clone());
    let mut items = vec![item_model(format!("{}/m", m.origin()), &model)];
    let (mut servers, mut seen) = (vec![m], vec![ms]);
    if with_program {
        let zip = make_zip(&dir, FAKE, extra);
        let (z, zs) = serve(zip.clone());
        let mut files = vec!["whisper-cli.exe", "ggml.dll"];
        if !extra.is_empty() {
            files.push("runtime-missing.flag");
        }
        items.push(Item { id: "program", file: "prog.zip".into(), url: format!("{}/p", z.origin()), sha256: sha256_hex(&zip), bytes: zip.len() as u64, disk: 80_000, place: Place::Zip(files) });
        servers.push(z);
        seen.push(zs);
    }
    let policy = Policy { exe_dirs: vec![dir.join("data").join("whisper")] };
    Hosted { r: rig_full(dir, policy, Manifest { items, ..Manifest::default() }), model, _servers: servers, seen }
}

fn requests(h: &Hosted) -> usize {
    h.seen.iter().map(|s| s.lock().unwrap().len()).sum()
}

fn install_done(e: &[Event]) -> bool {
    e.iter().any(|x| matches!(x, Event::Install { phase: "done", .. }))
}

#[test]
fn the_state_shows_the_size_before_anything_is_downloaded() {
    let h = hosted("svc-inst-size", &[], true);
    let state = owner(&h.r, "stt.state", vec![]);
    let i = &state["install"];
    assert_eq!(i["state"], "idle");
    assert_eq!(i["installed"], false);
    assert_eq!(i["unpublished"], json!([]));
    assert_eq!(i["items"][0]["id"], "model");
    assert_eq!(i["items"][0]["bytes"], 300_000);
    assert_eq!(i["items"][1]["id"], "program");
    assert_eq!(i["downloadBytes"].as_u64().unwrap(), 300_000 + i["items"][1]["bytes"].as_u64().unwrap());
    assert_eq!(i["diskBytes"], 300_000 + 80_000);
    assert_eq!(requests(&h), 0, "looking at the card downloads nothing");
}

#[test]
fn only_the_owner_can_start_the_install_and_a_refused_caller_causes_no_request() {
    let h = hosted("svc-inst-acl", &[], true);
    for who in [Caller::Model, Caller::Sidecar, Caller::Hands] {
        assert_eq!(h.r.svc.handle(who, "stt.install", &[json!("start")]), json!({"ok": false, "error": "stt_not_owner"}), "{who:?}");
    }
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(requests(&h), 0, "nothing was requested");
    assert!(h.r.events.lock().unwrap().is_empty());
    assert!(!h.r.dir.join("data").join("whisper").exists());
    assert_eq!(owner(&h.r, "stt.install", vec![json!("jump")])["error"], "stt_bad_args");
    assert_eq!(owner(&h.r, "stt.install", vec![])["error"], "stt_bad_args");
}

#[test]
fn the_owner_installs_the_engine_sees_progress_and_can_then_choose_it() {
    let h = hosted("svc-inst-ok", &[], true);
    assert_eq!(owner(&h.r, "stt.install", vec![json!("start")])["ok"], true);
    wait_for(&h.r, "done", install_done);
    let events = h.r.events.lock().unwrap().clone();
    assert!(events.iter().any(|e| matches!(e, Event::Install { phase: "download", item: "model", done, total: 300_000, .. } if *done > 0)), "progress reached the page: {events:?}");
    assert!(events.iter().any(|e| matches!(e, Event::Install { phase: "unpack", item: "program", .. })));
    assert!(events.contains(&Event::Install { phase: "done", item: "", done: 0, total: 0, code: None }), "{events:?}");
    let state = owner(&h.r, "stt.state", vec![]);
    assert_eq!(state["install"]["state"], "done");
    assert_eq!(state["install"]["installed"], true);
    assert_eq!(state["localRuntime"], Value::Null);
    let w = h.r.dir.join("data").join("whisper");
    assert_eq!(std::fs::read(w.join("ggml-test.bin")).unwrap(), h.model);
    // The installed files are the ones the policy already allows.
    let chosen = owner(&h.r, "stt.set", vec![json!({"engine": "local", "whisperExe": w.join("whisper-cli.exe"), "whisperModel": w.join("ggml-test.bin")})]);
    assert_eq!(chosen["ok"], true, "{chosen}");
    assert_eq!(chosen["ready"], true);
    assert!(h.r.audit.lock().unwrap().iter().all(|l| l.starts_with("egress http://127.0.0.1:")), "only the fake servers were contacted");
}

#[test]
fn a_second_start_is_busy_and_cancel_stops_the_download_without_a_partial_file_in_the_program_folder() {
    let dir = temp_dir("svc-inst-cancel");
    let model = blob(400_000, 22);
    let data = model.clone();
    let slow = Server::start(move |_| FixtureResp::Chunked { status: 200, headers: Vec::new(), chunks: data.chunks(100_000).enumerate().map(|(n, c)| (if n == 0 { 0 } else { 600 }, c.to_vec())).collect() });
    let mut manifest = Manifest { items: vec![item_model(format!("{}/m", slow.origin()), &model)], ..Manifest::default() };
    manifest.items.push(Item { id: "program", file: "prog.zip".into(), url: format!("{}/p", slow.origin()), sha256: "00".repeat(32), bytes: 10, disk: 10, place: Place::Zip(vec!["whisper-cli.exe"]) });
    let r = rig_full(dir.clone(), Policy { exe_dirs: vec![dir.join("data").join("whisper")] }, manifest);
    assert_eq!(owner(&r, "stt.install", vec![json!("start")])["ok"], true);
    wait_for(&r, "first progress", |e| e.iter().any(|x| matches!(x, Event::Install { phase: "download", done, .. } if *done > 0)));
    assert_eq!(owner(&r, "stt.install", vec![json!("start")]), json!({"ok": false, "error": "stt_install_busy"}));
    assert_eq!(owner(&r, "stt.state", vec![])["install"]["state"], "running");
    assert_eq!(owner(&r, "stt.install", vec![json!("cancel")])["ok"], true);
    wait_for(&r, "failed", |e| e.iter().any(|x| matches!(x, Event::Install { phase: "failed", code: Some("stt_cancelled"), .. })));
    let state = owner(&r, "stt.state", vec![]);
    assert_eq!(state["install"]["state"], "failed");
    assert_eq!(state["install"]["code"], "stt_cancelled");
    assert_eq!(state["install"]["installed"], false);
    assert!(!dir.join("data").join("whisper").exists() || std::fs::read_dir(dir.join("data").join("whisper")).unwrap().next().is_none(), "nothing in the allow-listed folder");
    let left: Vec<_> = std::fs::read_dir(dir.join("data").join("whisper-dl")).map(|d| d.flatten().map(|e| e.file_name()).collect()).unwrap_or_default();
    assert!(left.is_empty(), "the owner's cancel leaves no download on disk: {left:?}");
    assert_eq!(owner(&r, "stt.install", vec![json!("cancel")])["ok"], true, "cancel with nothing running is harmless");
}

#[test]
fn nothing_is_installed_while_the_program_has_no_published_address() {
    // The app's own manifest has the model only (no public URL serves the Vulkan build): the install refuses as a whole instead
    // of downloading 574 MB for an engine that cannot run.
    let h = hosted("svc-inst-unpub", &[], false);
    let state = owner(&h.r, "stt.state", vec![]);
    assert_eq!(state["install"]["unpublished"], json!(["program"]));
    assert_eq!(owner(&h.r, "stt.install", vec![json!("start")]), json!({"ok": false, "error": "stt_install_unpublished"}));
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(requests(&h), 0);
}

#[test]
fn a_program_that_cannot_start_after_the_install_is_said_so_and_leaves_the_api_engines_open() {
    let h = hosted("svc-inst-runtime", &[("runtime-missing.flag", b"x")], true);
    assert_eq!(owner(&h.r, "stt.install", vec![json!("start")])["ok"], true);
    wait_for(&h.r, "done", install_done);
    assert!(h.r.events.lock().unwrap().contains(&Event::Install { phase: "done", item: "", done: 0, total: 0, code: Some("stt_local_runtime_missing") }));
    let state = owner(&h.r, "stt.state", vec![]);
    assert_eq!(state["localRuntime"], "missing");
    assert_eq!(state["install"]["installed"], true, "the files are there; the runtime is the person's to install");
    // An API engine can still be chosen and saved.
    assert_eq!(owner(&h.r, "stt.set", vec![json!({"engine": "openai", "keyEnv": "OPENAI_API_KEY"})])["ok"], true);
    assert_eq!(owner(&h.r, "stt.state", vec![])["localRuntime"], Value::Null, "a new choice starts clean");
}

#[test]
fn a_program_the_loader_refuses_at_dictation_time_raises_the_same_notice_and_state() {
    let r = rig("svc-runtime-dictate");
    std::fs::write(r.dir.join("bin").join("runtime-missing.flag"), b"x").unwrap();
    assert_eq!(owner(&r, "stt.set", vec![local_settings(&r)])["ok"], true);
    r.port.press();
    wait_for(&r, "start", |e| e.contains(&Event::Start));
    r.port.release();
    wait_for(&r, "stop", |e| e.contains(&Event::Stop));
    owner(&r, "stt.audio", vec![json!(b64(&tone(1.0)))]);
    wait_for(&r, "notice", |e| e.contains(&Event::Notice("stt_local_runtime_missing")));
    assert_eq!(owner(&r, "stt.state", vec![])["localRuntime"], "missing");
}

// -------------------------------------------------------------------------------------------------------------------------- hotkey

#[test]
fn changing_the_chord_replaces_the_registration_and_a_taken_chord_still_leaves_the_button() {
    let r = rig("svc-chord");
    let mut s = local_settings(&r);
    assert_eq!(owner(&r, "stt.set", vec![s.clone()])["hotkey"], "on");
    s["chord"] = json!("ctrl-shift-space");
    assert_eq!(owner(&r, "stt.set", vec![s.clone()])["ok"], true);
    assert_eq!(r.port.live.lock().unwrap().as_slice(), ["ctrl-shift-space"], "the old chord was released");
    // Another program holds the chord.
    *r.port.taken.lock().unwrap() = true;
    s["chord"] = json!("opt-shift-space");
    let state = owner(&r, "stt.set", vec![s]);
    assert_eq!(state["ok"], true, "saved");
    assert_eq!(state["hotkey"], "stt_hotkey_taken");
    assert_eq!(state["ready"], true, "the mic button still works");
    assert_eq!(owner(&r, "stt.ptt", vec![json!("press")])["ok"], true);
    wait_for(&r, "start", |e| e.contains(&Event::Start));
}

#[test]
fn turning_voice_off_releases_the_chord_and_forgets_the_engine() {
    let r = rig("svc-off");
    owner(&r, "stt.set", vec![local_settings(&r)]);
    assert_eq!(r.port.live.lock().unwrap().len(), 1);
    let state = owner(&r, "stt.set", vec![json!({})]);
    assert_eq!(state["ok"], true);
    assert_eq!(state["engine"], Value::Null);
    assert!(r.port.live.lock().unwrap().is_empty(), "no chord is held while voice is off");
    assert_eq!(owner(&r, "stt.ptt", vec![json!("press")])["error"], "stt_not_configured");
}

// -------------------------------------------------------------------------------------------------------------------------- crash

#[test]
fn starting_the_service_sweeps_the_audio_a_crashed_run_left() {
    let dir = temp_dir("svc-sweep");
    let work = dir.join("data").join("stt");
    std::fs::create_dir_all(&work).unwrap();
    let mut child = std::process::Command::new(FAKE).env("FAKE_WHISPER_MODE", "sleep0").spawn().unwrap();
    let dead = child.id();
    child.wait().unwrap();
    let stale = work.join(format!("stt-{dead}-ff-0.wav"));
    std::fs::write(&stale, b"audio of a crashed run").unwrap();
    let _r = rig_in(dir, Policy { exe_dirs: vec![] });
    assert!(!stale.exists(), "swept at start");
}

// ------------------------------------------------------------------------------------------------------------ R4d: the optional model

/// A rig whose manifest has a default model (`ggml-test.bin`, 300 kB), an optional larger one (`ggml-big.bin`, 200 kB here) and a program.
fn hosted_with_optional(tag: &str) -> (Rig, Vec<u8>, Vec<Server>) {
    let dir = temp_dir(tag);
    let (small, big) = (blob(300_000, 31), blob(200_000, 32));
    let ((s, _), (b, _)) = (serve(small.clone()), serve(big.clone()));
    let zip = make_zip(&dir, FAKE, &[]);
    let (z, _) = serve(zip.clone());
    let mut optional = item_model(format!("{}/m", b.origin()), &big);
    optional.file = "ggml-big.bin".into();
    let items = vec![
        item_model(format!("{}/m", s.origin()), &small),
        Item { id: "program", file: "prog.zip".into(), url: format!("{}/p", z.origin()), sha256: sha256_hex(&zip), bytes: zip.len() as u64, disk: 80_000, place: Place::Zip(vec!["whisper-cli.exe", "ggml.dll"]) },
    ];
    let policy = Policy { exe_dirs: vec![dir.join("data").join("whisper")] };
    (rig_full(dir, policy, Manifest { items, optional_model: Some(optional) }), big, vec![s, b, z])
}

#[test]
fn the_state_shows_both_model_sizes_before_any_download() {
    let (r, _, _servers) = hosted_with_optional("svc-opt-size");
    let i = owner(&r, "stt.state", vec![])["install"].clone();
    assert_eq!(i["items"][0]["bytes"], 300_000, "the default model is the one in items");
    let o = &i["optionalModel"];
    assert_eq!((o["file"].as_str(), o["bytes"].as_u64()), (Some("ggml-big.bin"), Some(200_000)), "{i}");
    assert_eq!(o["slowWithoutGpu"], true);
    assert_eq!(i["optionalDownloadBytes"].as_u64().unwrap(), 200_000 + i["items"][1]["bytes"].as_u64().unwrap());
    assert_eq!(i["optionalInstalled"], false);
}

#[test]
fn the_owner_can_install_the_optional_model_instead_of_the_default_one() {
    let (r, big, _servers) = hosted_with_optional("svc-opt-install");
    assert_eq!(owner(&r, "stt.install", vec![json!("start"), json!("bogus")])["error"], "stt_bad_args");
    assert_eq!(owner(&r, "stt.install", vec![json!("start"), json!("large")])["ok"], true);
    wait_for(&r, "done", install_done);
    let w = r.dir.join("data").join("whisper");
    assert_eq!(std::fs::read(w.join("ggml-big.bin")).unwrap(), big);
    assert!(!w.join("ggml-test.bin").exists(), "the default model was not downloaded as well");
    let i = owner(&r, "stt.state", vec![])["install"].clone();
    assert_eq!(i["installed"], true, "an installed optional model counts as installed");
    assert_eq!(i["optionalInstalled"], true);
    assert!(i["paths"]["model"].as_str().unwrap().ends_with("ggml-big.bin"), "the form is filled with the model that is there: {i}");
}

#[test]
fn a_manifest_without_an_optional_model_refuses_the_optional_choice() {
    let h = hosted("svc-opt-none", &[], true);
    assert_eq!(owner(&h.r, "stt.install", vec![json!("start"), json!("large")])["error"], "stt_bad_args");
    assert_eq!(owner(&h.r, "stt.state", vec![])["install"]["optionalModel"], Value::Null);
    assert_eq!(requests(&h), 0);
}
