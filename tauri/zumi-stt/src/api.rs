//! API engines, through `zumi-egress`. The five that the reference app reaches for speech to text:
//!   Fish Audio, ElevenLabs, DeepSeek (`server/tts/{fish,elevenlabs,deepseek}.ts`, dictation) and OpenAI / Groq
//!   `/audio/transcriptions` (`server/meetings/speech.ts`, the Whisper models).
//! The user's key is passed in by the caller (the host reads it from the environment variable the settings name), held in
//! memory for the life of the provider and sent as the provider documents. It is never written, logged or put in an error.
//! The engine's origin is the one origin added to the egress: https, no redirect, no private address behind a public name;
//! plain http only for an address on this PC that the user typed (a self-hosted server, or a test).
use crate::{Clip, Provider, SttError};
use std::sync::Arc;
use std::time::Duration;
use zumi_egress::{Egress, Request};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApiKind {
    Fish,
    ElevenLabs,
    DeepSeek,
    OpenAi,
    Groq,
}

impl ApiKind {
    /// The provider's own origin (scheme and host): the only address its key goes to unless the user added another.
    pub fn origin(self) -> &'static str {
        match self {
            ApiKind::Fish => "https://api.fish.audio",
            ApiKind::ElevenLabs => "https://api.elevenlabs.io",
            ApiKind::DeepSeek => "https://api.deepseek.com",
            ApiKind::OpenAi => "https://api.openai.com",
            ApiKind::Groq => "https://api.groq.com",
        }
    }
    /// Up to and including the version segment where the provider has one.
    fn default_base(self) -> &'static str {
        match self {
            ApiKind::Fish => "https://api.fish.audio",
            ApiKind::ElevenLabs => "https://api.elevenlabs.io/v1",
            ApiKind::DeepSeek => "https://api.deepseek.com/v1",
            ApiKind::OpenAi => "https://api.openai.com/v1",
            ApiKind::Groq => "https://api.groq.com/openai/v1",
        }
    }
    fn path(self) -> &'static str {
        match self {
            ApiKind::Fish => "/v1/asr",
            ApiKind::ElevenLabs => "/speech-to-text",
            ApiKind::DeepSeek => "/tools/asr",
            ApiKind::OpenAi | ApiKind::Groq => "/audio/transcriptions",
        }
    }
    fn default_model(self) -> &'static str {
        match self {
            ApiKind::Fish => "transcribe-1-pro",
            ApiKind::ElevenLabs => "scribe_v2",
            ApiKind::DeepSeek => "",
            ApiKind::OpenAi => "whisper-1",
            ApiKind::Groq => "whisper-large-v3-turbo",
        }
    }
}

/// Upstream `deepseek.ts`: at most 8 MiB and 120 seconds of audio.
const DEEPSEEK_MAX_BYTES: usize = 8 * 1024 * 1024;
const DEEPSEEK_MAX_SECONDS: f64 = 120.0;
/// Upstream waits 60 s for every provider.
const CALL_TIMEOUT: Duration = Duration::from_secs(60);
/// A transcript is a few lines; a reply larger than this is not one.
const MAX_REPLY: usize = 256 * 1024;

pub struct ApiProvider {
    kind: ApiKind,
    url: String,
    key: String,
    language: Option<String>,
    model: String,
    egress: Arc<Egress>,
}

// The key is never printed, not even by a derived Debug.
impl std::fmt::Debug for ApiProvider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ApiProvider").field("kind", &self.kind).field("url", &self.url).field("key", &"<set>").finish()
    }
}

impl ApiProvider {
    /// `base`: the engine's address when the user typed another one (a gateway, or a server on this PC); None = the public API.
    pub fn new(kind: ApiKind, base: Option<&str>, key: &str, language: Option<&str>, model: Option<&str>, audit: Arc<dyn Fn(&str) + Send + Sync>) -> Result<ApiProvider, SttError> {
        if key.is_empty() {
            return Err(SttError("stt_key_missing"));
        }
        let base = base.unwrap_or(kind.default_base()).trim_end_matches('/').to_string();
        let mut egress = Egress::new(audit);
        egress.add_user_origin(&base)?;
        Ok(ApiProvider {
            kind,
            url: format!("{base}{}", kind.path()),
            key: key.to_string(),
            language: language.filter(|l| !l.is_empty()).map(str::to_string),
            model: model.filter(|m| !m.is_empty()).unwrap_or(kind.default_model()).to_string(),
            egress: Arc::new(egress),
        })
    }

    /// The headers the provider takes its key and model in.
    fn headers(&self, content_type: String) -> Vec<(String, String)> {
        let mut h = vec![("content-type".to_string(), content_type), ("accept".to_string(), "application/json".to_string())];
        match self.kind {
            ApiKind::ElevenLabs => h.push(("xi-api-key".into(), self.key.clone())),
            ApiKind::Fish => {
                h.push(("authorization".into(), format!("Bearer {}", self.key)));
                h.push(("model".into(), self.model.clone()));
            }
            ApiKind::DeepSeek | ApiKind::OpenAi | ApiKind::Groq => h.push(("authorization".into(), format!("Bearer {}", self.key))),
        }
        h
    }

    /// (the name of the upload field, the other fields).
    fn form(&self) -> (&'static str, Vec<(&'static str, String)>) {
        let lang = |name: &'static str, v: &mut Vec<(&'static str, String)>| {
            if let Some(l) = &self.language {
                v.push((name, l.clone()));
            }
        };
        match self.kind {
            ApiKind::Fish => ("audio", vec![("ignore_timestamps", "true".into()), ("diarize", "false".into()), ("tag_audio_events", "false".into())]),
            ApiKind::ElevenLabs => {
                let mut v = vec![("model_id", self.model.clone()), ("tag_audio_events", "false".into())];
                lang("language_code", &mut v);
                ("file", v)
            }
            ApiKind::DeepSeek => ("file", Vec::new()),
            ApiKind::OpenAi | ApiKind::Groq => {
                let mut v = vec![("model", self.model.clone()), ("response_format", "json".into())];
                lang("language", &mut v);
                ("file", v)
            }
        }
    }
}

/// `multipart/form-data` by hand (no new crate). Returns (content type, body). The boundary is chosen so it is not in the audio.
fn multipart(fields: &[(&str, String)], file_field: &str, wav: &[u8]) -> (String, Vec<u8>) {
    let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let mut n = 0u32;
    let boundary = loop {
        let b = format!("zumi-stt-{:x}-{n}", nonce);
        if !wav.windows(b.len()).any(|w| w == b.as_bytes()) {
            break b;
        }
        n += 1;
    };
    let mut body = Vec::with_capacity(wav.len() + 512);
    for (name, value) in fields {
        body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n").as_bytes());
    }
    body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{file_field}\"; filename=\"speech.wav\"\r\nContent-Type: audio/wav\r\n\r\n").as_bytes());
    body.extend_from_slice(wav);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    (format!("multipart/form-data; boundary={boundary}"), body)
}

/// One fixed code word per kind of answer. The remote body is never read into an error: it can echo a key or the audio's words.
fn refusal(status: u16) -> SttError {
    SttError(match status {
        401 | 403 => "stt_key_rejected",
        402 => "stt_balance",
        429 => "stt_rate_limited",
        400 | 413 | 415 | 422 => "stt_audio_refused",
        500..=599 => "stt_unavailable",
        _ => "stt_failed",
    })
}

impl Provider for ApiProvider {
    fn id(&self) -> &'static str {
        match self.kind {
            ApiKind::Fish => "fish",
            ApiKind::ElevenLabs => "elevenlabs",
            ApiKind::DeepSeek => "deepseek",
            ApiKind::OpenAi => "openai",
            ApiKind::Groq => "groq",
        }
    }

    fn transcribe(&self, clip: &Clip, cancel: &dyn Fn() -> bool) -> Result<String, SttError> {
        if self.kind == ApiKind::DeepSeek {
            if clip.wav.len() > DEEPSEEK_MAX_BYTES {
                return Err(SttError("stt_audio_too_large"));
            }
            if clip.seconds > DEEPSEEK_MAX_SECONDS {
                return Err(SttError("stt_audio_too_long"));
            }
        }
        let (file_field, fields) = self.form();
        let (content_type, body) = multipart(&fields, file_field, &clip.wav);
        let headers = self.headers(content_type);
        let mut req = Request::new("POST", &self.url);
        req.headers = &headers;
        req.body = Some(body);
        req.timeout = CALL_TIMEOUT;
        req.max_body = MAX_REPLY;
        let resp = self.egress.send(&req, cancel)?;
        if !(200..300).contains(&resp.head.status) {
            return Err(refusal(resp.head.status));
        }
        let json: serde_json::Value = serde_json::from_slice(&resp.body).map_err(|_| SttError("stt_bad_reply"))?;
        json.get("text").and_then(|t| t.as_str()).map(|t| t.trim().to_string()).ok_or(SttError("stt_bad_reply"))
    }
}
