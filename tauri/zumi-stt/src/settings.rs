//! The user's choice of engine (Settings), and the engine built from it.
//!
//! ```json
//! { "engine": "local" | "fish" | "elevenlabs" | "deepseek" | "openai" | "groq",
//!   "language": "vi" | "auto",                 // optional
//!   "keyEnv": "NAME_OF_AN_ENV_VARIABLE",       // API engines: where the key is read from (never the key itself)
//!   "baseUrl": "...", "model": "...",          // API engines, optional (a gateway or a server on this PC; another model)
//!   "whisperExe": "...", "whisperModel": "...", "threads": 4 }   // the local engine
//! ```
//! No engine chosen = voice is off (`stt_not_configured`), as upstream: without a key the buttons say so.
use crate::api::{ApiKind, ApiProvider};
use crate::local::LocalWhisper;
use crate::{Stt, SttError};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Engine {
    Local,
    Fish,
    ElevenLabs,
    DeepSeek,
    OpenAi,
    Groq,
}

impl Engine {
    pub fn id(self) -> &'static str {
        match self {
            Engine::Local => "local",
            Engine::Fish => "fish",
            Engine::ElevenLabs => "elevenlabs",
            Engine::DeepSeek => "deepseek",
            Engine::OpenAi => "openai",
            Engine::Groq => "groq",
        }
    }
    pub fn api_kind(self) -> Option<ApiKind> {
        match self {
            Engine::Local => None,
            Engine::Fish => Some(ApiKind::Fish),
            Engine::ElevenLabs => Some(ApiKind::ElevenLabs),
            Engine::DeepSeek => Some(ApiKind::DeepSeek),
            Engine::OpenAi => Some(ApiKind::OpenAi),
            Engine::Groq => Some(ApiKind::Groq),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Settings {
    pub engine: Engine,
    pub language: Option<String>,
    /// The NAME of the environment variable that holds the key.
    pub key_env: Option<String>,
    pub base_url: Option<String>,
    pub model: Option<String>,
    pub whisper_exe: Option<PathBuf>,
    pub whisper_model: Option<PathBuf>,
    pub threads: u32,
    /// Where the local engine puts its temp audio (the app data dir).
    pub work_dir: PathBuf,
}

/// A hard stop for one local run (whisper on a CPU can take several times the clip's length).
const LOCAL_TIMEOUT: Duration = Duration::from_secs(180);
const BAD: SttError = SttError("stt_settings_bad");

fn text<'a>(v: &'a Value, key: &str) -> Result<Option<&'a str>, SttError> {
    match v.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if s.is_empty() => Ok(None),
        Some(Value::String(s)) => Ok(Some(s)),
        Some(_) => Err(BAD),
    }
}

/// A language code goes onto a command line and into a form: letters, then letters/digits/hyphen, short.
fn language(v: &Value) -> Result<Option<String>, SttError> {
    match text(v, "language")? {
        None => Ok(None),
        Some(l) if l.eq_ignore_ascii_case("auto") => Ok(None),
        Some(l) if (2..=10).contains(&l.len()) && l.starts_with(|c: char| c.is_ascii_alphabetic()) && l.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') => Ok(Some(l.to_string())),
        Some(_) => Err(BAD),
    }
}

impl Settings {
    pub fn from_json(v: &Value, work_dir: PathBuf) -> Result<Settings, SttError> {
        let engine = match text(v, "engine")? {
            None => return Err(SttError("stt_not_configured")),
            Some("local") => Engine::Local,
            Some("fish") => Engine::Fish,
            Some("elevenlabs") => Engine::ElevenLabs,
            Some("deepseek") => Engine::DeepSeek,
            Some("openai") => Engine::OpenAi,
            Some("groq") => Engine::Groq,
            Some(_) => return Err(BAD),
        };
        let key_env = text(v, "keyEnv")?.map(str::to_string);
        if key_env.as_deref().is_some_and(|n| !n.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')) {
            return Err(BAD);
        }
        let (whisper_exe, whisper_model) = (text(v, "whisperExe")?.map(PathBuf::from), text(v, "whisperModel")?.map(PathBuf::from));
        if engine == Engine::Local && (whisper_exe.is_none() || whisper_model.is_none()) {
            return Err(BAD);
        }
        let threads = match v.get("threads") {
            None | Some(Value::Null) => 4,
            Some(t) => t.as_u64().filter(|t| *t <= 1024).ok_or(BAD)? as u32,
        };
        Ok(Settings {
            engine,
            language: language(v)?,
            key_env,
            base_url: text(v, "baseUrl")?.map(str::to_string),
            model: text(v, "model")?.map(str::to_string),
            whisper_exe,
            whisper_model,
            threads,
            work_dir,
        })
    }
}

/// The engine the settings name. `env` looks an environment variable up (the host passes `std::env::var`); `audit` gets one
/// line per network request (`egress <origin> <status | code word>`), which the local engine never makes.
pub fn build(s: &Settings, env: &dyn Fn(&str) -> Option<String>, audit: Arc<dyn Fn(&str) + Send + Sync>) -> Result<Stt, SttError> {
    let kind = match s.engine {
        Engine::Local => {
            let (Some(exe), Some(model)) = (s.whisper_exe.clone(), s.whisper_model.clone()) else { return Err(BAD) };
            return Ok(Stt::new(Box::new(LocalWhisper { exe, model, threads: s.threads, language: s.language.clone(), work_dir: s.work_dir.clone(), timeout: LOCAL_TIMEOUT })));
        }
        Engine::Fish => ApiKind::Fish,
        Engine::ElevenLabs => ApiKind::ElevenLabs,
        Engine::DeepSeek => ApiKind::DeepSeek,
        Engine::OpenAi => ApiKind::OpenAi,
        Engine::Groq => ApiKind::Groq,
    };
    // A named variable that is not set is an error, never a silent call without a key.
    let key = s.key_env.as_deref().and_then(env).filter(|k| !k.is_empty()).ok_or(SttError("stt_key_missing"))?;
    let api = ApiProvider::new(kind, s.base_url.as_deref(), &key, s.language.as_deref(), s.model.as_deref(), audit)?;
    Ok(Stt::new(Box::new(api)))
}
