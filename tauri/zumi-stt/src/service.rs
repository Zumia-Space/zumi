//! The host-side service of voice in (R4b): what makes dictated text reach the chat input, and who may configure it.
//!
//! No tauri here (the host passes an event emitter and the data folder); the host answers four renderer rpc names with it:
//!   `stt.state`          what is set (never a key), whether voice is ready, whether the hotkey is held
//!   `stt.set`            the owner's settings screen saves the engine, key variable NAME, address, program, model, chord
//!   `stt.ptt`            "press" | "release" | "dismiss": the mic button, the same flow as the hotkey
//!   `stt.audio`          the page hands in the WAV it recorded (base64), when the host asked it to stop
//!   `stt.install`        "start" | "cancel": download and place the local engine (the owner's click; see `install.rs`)
//! and pushes `Event`s to the page: `Start` (record), `Stop` (finish and send the WAV), `Cancel` (throw it away), then the
//! `Text` heard or a `Notice` with a fixed code word.
//!
//! Who may call: only `Caller::OwnerUi`, which the host passes for the main webview's `rpc` command (and for nothing else). The
//! model, the sidecar and the hands helper get `stt_not_owner` for every name, so none of them can change the engine, the program
//! it starts, the variable whose value is sent as a key, or start the microphone. The settings file is only ever written here,
//! and every value is checked (`Policy`) both before it is saved and each time it is loaded.
use crate::dictation::{Dictation, Recorder, Sink};
use crate::hotkey::{self, Chord, Hotkey, HotkeyEvent};
use crate::install::{Installer, Manifest, Progress, RedirectOk};
use crate::local;
use crate::policy::{self, Policy};
use crate::settings::{self, Engine, Settings};
use crate::{SttError, MAX_WAV_BYTES};
use serde_json::{json, Map, Value};
use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Who is asking. Only the owner's settings screen is trusted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Caller {
    OwnerUi,
    Model,
    Sidecar,
    Hands,
}

/// What the host pushes to the page.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    Start,
    Stop,
    Cancel,
    Text(String),
    Notice(&'static str),
    /// The first-use install of the local engine: `phase` is download | verify | unpack | check | done | failed; `code` is the
    /// reason of a failure, or `stt_local_runtime_missing` on a `done` whose program cannot start here.
    Install { phase: &'static str, item: &'static str, done: u64, total: u64, code: Option<&'static str> },
}

impl Event {
    pub fn to_json(&self) -> Value {
        match self {
            Event::Start => json!({"ev": "start"}),
            Event::Stop => json!({"ev": "stop"}),
            Event::Cancel => json!({"ev": "cancel"}),
            Event::Text(t) => json!({"ev": "text", "text": t}),
            Event::Notice(code) => json!({"ev": "notice", "code": code}),
            Event::Install { phase, item, done, total, code } => json!({"ev": "install", "phase": phase, "item": item, "done": done, "total": total, "code": code}),
        }
    }
}

/// Registers the global hotkey. The system implementation is `SystemHotkey`; tests pass one that hands them the callback.
pub trait HotkeyPort: Send + Sync {
    fn register(&self, chord: Chord, on: Arc<dyn Fn(HotkeyEvent) + Send + Sync>) -> Result<Box<dyn Send>, SttError>;
}

pub struct SystemHotkey;

impl HotkeyPort for SystemHotkey {
    fn register(&self, chord: Chord, on: Arc<dyn Fn(HotkeyEvent) + Send + Sync>) -> Result<Box<dyn Send>, SttError> {
        Ok(Box::new(Hotkey::register(chord, move |e| on(e))?))
    }
}

pub struct Config {
    /// `stt.json` lives here, and the local engine's temp audio in `<data_dir>/stt`.
    pub data_dir: PathBuf,
    pub policy: Policy,
    /// Looks an environment variable up. Only names on the policy's key list are ever asked for.
    pub env: Arc<dyn Fn(&str) -> Option<String> + Send + Sync>,
    /// One line per network request (`egress <origin> <status>`).
    pub audit: Arc<dyn Fn(&str) + Send + Sync>,
    pub emit: Arc<dyn Fn(Event) + Send + Sync>,
    pub hotkeys: Arc<dyn HotkeyPort>,
    /// Upstream's `maxListenMs`: 60 s.
    pub max_listen: Duration,
    /// How long the host waits for the page to hand over the WAV after `Stop`.
    pub audio_wait: Duration,
    /// What the owner may install on first use (`Manifest::pinned()` in the app).
    pub install: Manifest,
    /// Where a download may be redirected to (`install::redirect_hosts_ok` in the app).
    pub redirect_ok: RedirectOk,
}

type Slot = Arc<Mutex<Option<mpsc::Sender<Result<Vec<u8>, SttError>>>>>;

/// The page records (the webview owns the microphone): `start` and `cancel` are events, `finish` asks for the WAV and waits for
/// the page's `stt.audio`.
struct PageRecorder {
    emit: Arc<dyn Fn(Event) + Send + Sync>,
    slot: Slot,
    wait: Duration,
}

impl Recorder for PageRecorder {
    fn start(&self) -> Result<(), SttError> {
        (self.emit)(Event::Start);
        Ok(())
    }
    fn finish(&self) -> Result<Vec<u8>, SttError> {
        let (tx, rx) = mpsc::channel();
        // The slot is set before `Stop` goes out: an immediate answer cannot arrive first.
        *self.slot.lock().unwrap_or_else(|e| e.into_inner()) = Some(tx);
        (self.emit)(Event::Stop);
        match rx.recv_timeout(self.wait) {
            Ok(answer) => answer,
            Err(_) => {
                self.slot.lock().unwrap_or_else(|e| e.into_inner()).take();
                Err(SttError("stt_audio_missing"))
            }
        }
    }
    fn cancel(&self) {
        self.slot.lock().unwrap_or_else(|e| e.into_inner()).take();
        (self.emit)(Event::Cancel);
    }
}

struct PageSink {
    emit: Arc<dyn Fn(Event) + Send + Sync>,
    /// Set when the local program could not start (a runtime is missing): the settings card says what to do.
    runtime_missing: Arc<AtomicBool>,
}
impl Sink for PageSink {
    fn text(&self, text: &str) {
        (self.emit)(Event::Text(text.to_string()));
    }
    fn notice(&self, code: &'static str) {
        if code == "stt_local_runtime_missing" {
            self.runtime_missing.store(true, Ordering::SeqCst);
        }
        (self.emit)(Event::Notice(code));
    }
}

/// Where the first-use install stands. One install at a time; `cancel` ends it, the bytes received so far are kept.
#[derive(Clone, Copy, Default)]
struct InstallState {
    state: &'static str,
    phase: &'static str,
    item: &'static str,
    done: u64,
    total: u64,
    code: Option<&'static str>,
}

struct InstallShared {
    state: Mutex<InstallState>,
    cancel: AtomicBool,
}

/// What is set now, and what was made from it.
struct Active {
    raw: Value,
    chord: &'static str,
    /// Why voice is not ready (a refused setting, a missing key); None when ready or not configured.
    error: Option<&'static str>,
    dictation: Option<Arc<Dictation>>,
    hotkey: Option<Box<dyn Send>>,
    /// "on" | "off" | a code word (`stt_hotkey_taken`).
    hotkey_state: &'static str,
}

const KEYS: [&str; 9] = ["engine", "language", "keyEnv", "baseUrl", "model", "whisperExe", "whisperModel", "threads", "chord"];
/// Larger than base64 of the biggest WAV the front door takes.
const MAX_B64: usize = MAX_WAV_BYTES / 3 * 4 + 16;

pub struct Service {
    cfg: Config,
    active: Mutex<Active>,
    slot: Slot,
    install: Arc<InstallShared>,
    runtime_missing: Arc<AtomicBool>,
}

fn fail(code: &str) -> Value {
    json!({"ok": false, "error": code})
}

/// Strict base64 (standard alphabet, padded): anything else is not audio.
fn b64_decode(text: &str) -> Option<Vec<u8>> {
    let bytes = text.as_bytes();
    if bytes.len() % 4 != 0 {
        return None;
    }
    let val = |c: u8| -> Option<u32> {
        match c {
            b'A'..=b'Z' => Some((c - b'A') as u32),
            b'a'..=b'z' => Some((c - b'a') as u32 + 26),
            b'0'..=b'9' => Some((c - b'0') as u32 + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    };
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    let last = bytes.len() / 4;
    for (i, quad) in bytes.chunks(4).enumerate() {
        let pad = quad.iter().rev().take_while(|c| **c == b'=').count();
        if pad > 2 || (pad > 0 && i + 1 != last) {
            return None;
        }
        let mut n = 0u32;
        for (j, c) in quad.iter().enumerate() {
            n <<= 6;
            if j < 4 - pad {
                n |= val(*c)?;
            }
        }
        out.push((n >> 16) as u8);
        if pad < 2 {
            out.push((n >> 8) as u8);
        }
        if pad < 1 {
            out.push(n as u8);
        }
    }
    Some(out)
}

impl Service {
    pub fn is_method(method: &str) -> bool {
        matches!(method, "stt.state" | "stt.set" | "stt.ptt" | "stt.audio" | "stt.install")
    }

    /// Sweeps the audio a crashed run left, then loads `<data dir>/stt.json` (checked like a new setting).
    pub fn start(cfg: Config) -> Service {
        local::sweep_stale(&cfg.data_dir.join("stt"));
        let saved = std::fs::read_to_string(cfg.data_dir.join("stt.json")).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).unwrap_or_else(|| json!({}));
        let svc = Service { cfg, active: Mutex::new(Active { raw: json!({}), chord: hotkey::DEFAULT_KEY, error: None, dictation: None, hotkey: None, hotkey_state: "off" }),
            slot: Arc::new(Mutex::new(None)),
            install: Arc::new(InstallShared { state: Mutex::new(InstallState { state: "idle", ..InstallState::default() }), cancel: AtomicBool::new(false) }),
            runtime_missing: Arc::new(AtomicBool::new(false)),
        };
        let made = svc.make(saved.clone()).unwrap_or_else(|(code, chord)| Active { raw: saved, chord, error: Some(code), dictation: None, hotkey: None, hotkey_state: "off" });
        *svc.lock() = made;
        svc
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Active> {
        self.active.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn lookup(&self, name: &str) -> Option<String> {
        // A variable that is not a key name is never read, whatever the settings say.
        if policy::is_key_env(name) {
            (self.cfg.env)(name)
        } else {
            None
        }
    }

    /// Checks `raw` and builds what it names. `Err((code, chord))`: refused (shape, chord or policy). A missing key is not a
    /// refusal: the setting is valid, voice is just not ready (`error`).
    fn make(&self, raw: Value) -> Result<Active, (&'static str, &'static str)> {
        let bad = |code: &'static str| (code, hotkey::DEFAULT_KEY);
        let Some(obj) = raw.as_object() else { return Err(bad("stt_settings_bad")) };
        if obj.keys().any(|k| !KEYS.contains(&k.as_str())) {
            return Err(bad("stt_settings_bad"));
        }
        let chord_id = match obj.get("chord") {
            None | Some(Value::Null) => hotkey::DEFAULT_KEY,
            Some(Value::String(id)) => hotkey::chord(id).ok_or(bad("stt_settings_bad"))?.id,
            Some(_) => return Err(bad("stt_settings_bad")),
        };
        let none = |error| Active { raw: raw.clone(), chord: chord_id, error, dictation: None, hotkey: None, hotkey_state: "off" };
        let work_dir = self.cfg.data_dir.join("stt");
        let parsed = match Settings::from_json(&raw, work_dir) {
            Ok(s) => s,
            Err(e) if e.code() == "stt_not_configured" => return Ok(none(None)),
            Err(e) => return Err((e.code(), chord_id)),
        };
        // The engine is built from the settings the policy returns: the program is the canonical path that passed the check.
        let parsed = self.cfg.policy.resolve(&parsed).map_err(|e| (e.code(), chord_id))?;
        let env = |name: &str| self.lookup(name);
        let stt = match settings::build(&parsed, &env, self.cfg.audit.clone()) {
            Ok(stt) => Arc::new(stt),
            Err(e) => return Ok(none(Some(e.code()))),
        };
        let recorder = Arc::new(PageRecorder { emit: self.cfg.emit.clone(), slot: self.slot.clone(), wait: self.cfg.audio_wait });
        let dictation = Arc::new(Dictation::new(stt, recorder, Arc::new(PageSink { emit: self.cfg.emit.clone(), runtime_missing: self.runtime_missing.clone() }), self.cfg.max_listen));
        let chord = hotkey::chord(chord_id).expect("checked above");
        let on = dictation.clone();
        let (hotkey, hotkey_state) = match self.cfg.hotkeys.register(chord, Arc::new(move |e| on.on_hotkey(e))) {
            Ok(h) => (Some(h), "on"),
            // The chord is held elsewhere: voice still works from the mic button.
            Err(e) => (None, e.code()),
        };
        Ok(Active { raw, chord: chord_id, error: None, dictation: Some(dictation), hotkey, hotkey_state })
    }

    fn state(&self) -> Value {
        let a = self.lock();
        let field = |k: &str| a.raw.get(k).cloned().unwrap_or(Value::Null);
        let key_env = a.raw.get("keyEnv").and_then(Value::as_str);
        let names: Map<String, Value> = [Engine::Fish, Engine::ElevenLabs, Engine::DeepSeek, Engine::OpenAi, Engine::Groq]
            .iter()
            .map(|e| (e.id().to_string(), json!(policy::provider_key_envs(*e))))
            .collect();
        json!({
            "ok": true,
            "engine": field("engine"), "language": field("language"), "keyEnv": field("keyEnv"), "baseUrl": field("baseUrl"),
            "model": field("model"), "whisperExe": field("whisperExe"), "whisperModel": field("whisperModel"), "threads": field("threads"),
            "chord": a.chord,
            // Whether the named variable has a value: never the value.
            "keySet": key_env.is_some_and(|k| self.lookup(k).is_some_and(|v| !v.is_empty())),
            "ready": a.dictation.is_some(),
            "error": a.error,
            "hotkey": a.hotkey_state,
            "busy": a.dictation.as_ref().is_some_and(|d| d.busy()),
            "engines": ["local", "fish", "elevenlabs", "deepseek", "openai", "groq"],
            "chords": hotkey::chords().iter().map(|c| json!({"id": c.id, "label": c.label})).collect::<Vec<_>>(),
            "keyEnvNames": {"providers": names, "user": policy::USER_KEY_ENV},
            // "missing": the local program could not start on this PC (Visual C++ runtime or a Vulkan driver); null until it is seen.
            "localRuntime": if self.runtime_missing.load(Ordering::SeqCst) { json!("missing") } else { Value::Null },
            "install": self.install_state(),
            "exeName": policy::WHISPER_EXE_NAME,
            "exeDirs": self.cfg.policy.exe_dirs.iter().map(|d| d.display().to_string()).collect::<Vec<_>>(),
        })
    }

    fn set(&self, args: &[Value]) -> Value {
        let Some(raw) = args.first().filter(|v| v.is_object()) else { return fail("stt_bad_args") };
        // Let go of the old registration first: the same chord would otherwise be "taken" by ourselves.
        let previous = {
            let mut a = self.lock();
            let old = (a.dictation.take(), a.hotkey.take());
            a.hotkey_state = "off";
            old
        };
        drop(previous);
        match self.make(raw.clone()) {
            Ok(active) => {
                if self.write(raw).is_err() {
                    return fail("stt_save_failed");
                }
                *self.lock() = active;
                self.runtime_missing.store(false, Ordering::SeqCst);
                self.state()
            }
            // Refused: nothing is saved and the last good setting is rebuilt.
            Err((code, _)) => {
                let old = self.lock().raw.clone();
                if let Ok(back) = self.make(old) {
                    *self.lock() = back;
                }
                fail(code)
            }
        }
    }

    /// Whole file or nothing: write beside it, then rename over.
    fn write(&self, raw: &Value) -> std::io::Result<()> {
        std::fs::create_dir_all(&self.cfg.data_dir)?;
        let (tmp, dest) = (self.cfg.data_dir.join("stt.json.tmp"), self.cfg.data_dir.join("stt.json"));
        std::fs::write(&tmp, serde_json::to_vec_pretty(raw).unwrap_or_default())?;
        std::fs::rename(&tmp, &dest)
    }

    fn installer(&self) -> Installer {
        self.installer_for(self.cfg.install.clone())
    }

    fn installer_for(&self, manifest: Manifest) -> Installer {
        Installer { data_dir: self.cfg.data_dir.clone(), manifest, audit: self.cfg.audit.clone(), redirect_ok: self.cfg.redirect_ok.clone(), attempts: 3 }
    }

    /// What the settings card shows about the install: the size first (before any click), then the progress.
    fn install_state(&self) -> Value {
        let now = *self.install.state.lock().unwrap_or_else(|e| e.into_inner());
        let inst = self.installer();
        let manifest = &self.cfg.install;
        let dir = inst.whisper_dir();
        let big = manifest.with_optional_model();
        let big_installed = big.clone().is_some_and(|m| self.installer_for(m).installed());
        // The form is filled with the larger model when it is there (the owner chose it), else with the default one.
        let model_file = match (&manifest.optional_model, big_installed) {
            (Some(o), true) => Some(&o.file),
            _ => manifest.items.iter().find(|i| i.id == "model").map(|i| &i.file),
        };
        let model = model_file.map(|f| dir.join(f).display().to_string());
        let optional = manifest.optional_model.as_ref().zip(big.as_ref());
        json!({
            "state": now.state, "phase": now.phase, "item": now.item, "done": now.done, "total": now.total, "code": now.code,
            "installed": inst.installed() || big_installed,
            // The larger model (large-v3-turbo): its size is shown before any click, with the warning that it is slow without a GPU.
            "optionalModel": optional.map(|(o, _)| json!({"id": o.id, "file": o.file, "bytes": o.bytes, "disk": o.disk, "slowWithoutGpu": true})),
            "optionalDownloadBytes": optional.map(|(_, m)| m.download_bytes()),
            "optionalDiskBytes": optional.map(|(_, m)| m.disk_bytes()),
            "optionalInstalled": big_installed,
            // What is not published (no address to download it from): while any, the install does not start.
            "unpublished": manifest.unpublished(),
            "items": manifest.items.iter().map(|i| json!({"id": i.id, "file": i.file, "bytes": i.bytes, "disk": i.disk})).collect::<Vec<_>>(),
            "downloadBytes": manifest.download_bytes(),
            "diskBytes": manifest.disk_bytes(),
            "paths": {"exe": dir.join(policy::WHISPER_EXE_NAME).display().to_string(), "model": model},
        })
    }

    /// `stt.install`: "start" downloads, checks and places the engine (one at a time, in a thread; the page follows it by events),
    /// "cancel" stops it. Only reached for `Caller::OwnerUi`: an agent or a tool cannot cause a download.
    fn install(&self, args: &[Value]) -> Value {
        match args.first().and_then(Value::as_str) {
            Some("cancel") => {
                self.install.cancel.store(true, Ordering::SeqCst);
                json!({"ok": true})
            }
            Some("start") => {
                // Second argument: absent = the default model; "large" = the optional larger model, if the manifest has one.
                let manifest = match args.get(1).and_then(Value::as_str) {
                    None if args.len() < 2 => self.cfg.install.clone(),
                    Some("large") => match self.cfg.install.with_optional_model() {
                        Some(m) => m,
                        None => return fail("stt_bad_args"),
                    },
                    _ => return fail("stt_bad_args"),
                };
                if !manifest.unpublished().is_empty() {
                    return fail("stt_install_unpublished");
                }
                {
                    let mut st = self.install.state.lock().unwrap_or_else(|e| e.into_inner());
                    if st.state == "running" {
                        return fail("stt_install_busy");
                    }
                    *st = InstallState { state: "running", ..InstallState::default() };
                }
                self.install.cancel.store(false, Ordering::SeqCst);
                let (installer, shared, emit, runtime) = (self.installer_for(manifest), self.install.clone(), self.cfg.emit.clone(), self.runtime_missing.clone());
                std::thread::spawn(move || {
                    let report = |p: Progress| {
                        let (phase, item) = (p.phase.id(), p.item);
                        *shared.state.lock().unwrap_or_else(|e| e.into_inner()) = InstallState { state: "running", phase, item, done: p.done, total: p.total, code: None };
                        emit(Event::Install { phase, item, done: p.done, total: p.total, code: None });
                    };
                    let (state, code) = match installer.run(&report, &|| shared.cancel.load(Ordering::SeqCst)) {
                        Ok(outcome) => {
                            runtime.store(outcome.runtime_missing, Ordering::SeqCst);
                            ("done", outcome.runtime_missing.then_some("stt_local_runtime_missing"))
                        }
                        Err(e) => ("failed", Some(e.code())),
                    };
                    *shared.state.lock().unwrap_or_else(|e| e.into_inner()) = InstallState { state, code, ..InstallState::default() };
                    emit(Event::Install { phase: state, item: "", done: 0, total: 0, code });
                });
                json!({"ok": true})
            }
            _ => fail("stt_bad_args"),
        }
    }

    fn ptt(&self, args: &[Value]) -> Value {
        let phase = args.first().and_then(Value::as_str);
        if !matches!(phase, Some("press" | "release" | "dismiss")) {
            return fail("stt_bad_args");
        }
        let (dictation, error) = {
            let a = self.lock();
            (a.dictation.clone(), a.error)
        };
        let Some(d) = dictation else { return fail(error.unwrap_or("stt_not_configured")) };
        match phase {
            Some("press") => d.on_hotkey(HotkeyEvent::Press),
            Some("release") => d.on_hotkey(HotkeyEvent::Release),
            _ => d.dismiss(),
        }
        json!({"ok": true})
    }

    fn audio(&self, args: &[Value]) -> Value {
        let Some(text) = args.first().and_then(Value::as_str) else { return fail("stt_bad_args") };
        let waiter = self.slot.lock().unwrap_or_else(|e| e.into_inner()).take();
        let answer = if text.len() > MAX_B64 { Err(SttError("stt_audio_too_large")) } else { b64_decode(text).ok_or(SttError("stt_audio_bad")) };
        match (waiter, answer) {
            // The recording that asked gets the audio, or the reason it will never get any.
            (Some(w), answer) => {
                let reply = match &answer {
                    Ok(_) => json!({"ok": true}),
                    Err(e) => fail(e.code()),
                };
                let _ = w.send(answer);
                reply
            }
            // Nobody is waiting for a recording.
            (None, Err(e)) => fail(e.code()),
            (None, Ok(_)) => fail("stt_not_waiting"),
        }
    }

    /// The renderer's `stt.*` call.
    pub fn handle(&self, who: Caller, method: &str, args: &[Value]) -> Value {
        if who != Caller::OwnerUi {
            return fail("stt_not_owner");
        }
        match method {
            "stt.state" => self.state(),
            "stt.set" => self.set(args),
            "stt.ptt" => self.ptt(args),
            "stt.audio" => self.audio(args),
            "stt.install" => self.install(args),
            _ => fail("unknown_method"),
        }
    }
}
