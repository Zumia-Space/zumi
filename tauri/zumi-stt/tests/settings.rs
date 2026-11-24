//! The user's choice of engine: parsing, and the engine built from it. No key is ever in settings, only the name of the
//! environment variable that holds it (the same rule as the custom model endpoint).
mod common;
use common::*;
use serde_json::json;
use std::sync::{Arc, Mutex};
use zumi_egress::fixture::{FixtureResp, Server};
use zumi_stt::settings::{build, Engine, Settings};

fn parse(v: serde_json::Value) -> Result<Settings, zumi_stt::SttError> {
    Settings::from_json(&v, std::env::temp_dir())
}
fn quiet() -> Arc<dyn Fn(&str) + Send + Sync> {
    Arc::new(|_| {})
}

#[test]
fn every_engine_name_is_known_and_an_unknown_or_missing_one_is_refused() {
    for (name, want) in [("fish", Engine::Fish), ("elevenlabs", Engine::ElevenLabs), ("deepseek", Engine::DeepSeek), ("openai", Engine::OpenAi), ("groq", Engine::Groq)] {
        let s = parse(json!({"engine": name, "keyEnv": "SOME_KEY"})).unwrap();
        assert_eq!(s.engine, want);
        assert_eq!(s.threads, 4, "whisper.cpp's own default when the user did not set one");
    }
    let local = parse(json!({"engine": "local", "whisperExe": "C:/w/whisper-cli.exe", "whisperModel": "C:/w/ggml-large-v3-turbo.bin"})).unwrap();
    assert_eq!(local.engine, Engine::Local);
    assert_eq!(parse(json!({"engine": "nope"})).unwrap_err().code(), "stt_settings_bad");
    assert_eq!(parse(json!({})).unwrap_err().code(), "stt_not_configured", "no choice made yet: voice is off");
    assert_eq!(parse(json!({"engine": "local"})).unwrap_err().code(), "stt_settings_bad", "the local engine needs the program and the model");
}

#[test]
fn the_language_is_a_code_or_auto_and_nothing_else() {
    let lang = |v: serde_json::Value| parse(json!({"engine": "fish", "keyEnv": "K", "language": v})).map(|s| s.language);
    assert_eq!(lang(json!("vi")).unwrap(), Some("vi".into()));
    assert_eq!(lang(json!("pt-BR")).unwrap(), Some("pt-BR".into()));
    assert_eq!(lang(json!("auto")).unwrap(), None);
    assert_eq!(lang(json!("")).unwrap(), None);
    for bad in ["-m evil.bin", "vi; calc", "../x", "x".repeat(40).as_str()] {
        assert_eq!(lang(json!(bad)).unwrap_err().code(), "stt_settings_bad", "{bad}");
    }
}

#[test]
fn an_api_engine_reads_its_key_from_the_environment_variable_the_settings_name() {
    let s = parse(json!({"engine": "openai", "keyEnv": "MY_STT_KEY"})).unwrap();
    assert!(!format!("{s:?}").contains("secret-value"));
    let env = |name: &str| (name == "MY_STT_KEY").then(|| "secret-value".to_string());
    assert_eq!(build(&s, &env, quiet()).map(|x| x.engine()), Ok("openai"));
    let none = |_: &str| None;
    assert_eq!(build(&s, &none, quiet()).err().map(|e| e.code()), Some("stt_key_missing"), "a named variable that is not set is an error, never a silent no-key call");
    let unnamed = parse(json!({"engine": "openai"})).unwrap();
    assert_eq!(build(&unnamed, &env, quiet()).err().map(|e| e.code()), Some("stt_key_missing"));
}

#[test]
fn the_local_engine_needs_no_key_and_opens_no_connection() {
    let seen: Arc<Mutex<usize>> = Arc::default();
    let s2 = seen.clone();
    let server = Server::start(move |_| {
        *s2.lock().unwrap() += 1;
        FixtureResp::json(200, r#"{"text":"x"}"#)
    });
    let dir = temp_dir("settings-local");
    let s = Settings::from_json(&json!({"engine": "local", "whisperExe": dir.join("no-cli.exe"), "whisperModel": dir.join("no-model.bin"), "baseUrl": server.origin()}), dir).unwrap();
    let lines: Arc<Mutex<Vec<String>>> = Arc::default();
    let l = lines.clone();
    let stt = build(&s, &|_| None, Arc::new(move |x: &str| l.lock().unwrap().push(x.to_string()))).unwrap();
    assert_eq!(stt.engine(), "local");
    // The program and model do not exist here: the call fails, and no network line and no request exists.
    assert_eq!(stt.transcribe(&tone(1.0), &never).unwrap_err().code(), "stt_local_missing");
    assert!(lines.lock().unwrap().is_empty());
    assert_eq!(*seen.lock().unwrap(), 0);
}
