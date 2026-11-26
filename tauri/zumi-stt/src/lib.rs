//! zumi-stt (T-31-MAUS R4, matrix F40): voice in. The user holds a hotkey, speaks, and the words land in the chat input.
//!
//! Two kinds of engine behind one trait (owner ruling 19-11: no "voice never leaves the PC" promise; the user chooses):
//!   - `local::LocalWhisper`  whisper.cpp on this PC (`whisper-cli`), supervised here: bounded run, killed on cancel or timeout,
//!                            thread cap, below-normal priority, no window, our own std handles kept from the child.
//!   - `api::ApiProvider`     an API the user chose with their own key: Fish Audio, ElevenLabs, DeepSeek (the three upstream
//!                            dictation providers of the reference app) and OpenAI / Groq `/audio/transcriptions` (upstream meeting notes).
//! The API engines go through `zumi-egress` (https, no redirect, no private address, only the origin the user chose).
//! Audio is one 16 kHz mono 16-bit WAV, as upstream's recorder makes it. A silent clip is never sent anywhere.
//!
//! Every failure is ONE fixed code word (`SttError::code`), never a URL, header, body, key or path.
pub mod api;
pub mod dictation;
pub mod hotkey;
pub mod install;
pub mod local;
pub mod policy;
pub mod service;
pub mod settings;
pub mod wav;
pub mod wer;

use zumi_egress::EgressError;

/// A refusal or failure, one fixed code word.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SttError(pub &'static str);

impl SttError {
    pub fn code(&self) -> &'static str {
        self.0
    }
}

impl std::fmt::Display for SttError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}

impl From<EgressError> for SttError {
    fn from(e: EgressError) -> SttError {
        match e {
            EgressError::Refused(code) => SttError(code),
            EgressError::Cancelled => SttError("stt_cancelled"),
            EgressError::Timeout => SttError("stt_timeout"),
            EgressError::TooLarge => SttError("stt_bad_reply"),
            EgressError::Network => SttError("stt_network"),
        }
    }
}

/// What an engine receives: a 16 kHz mono 16-bit PCM WAV and its length.
#[derive(Debug, Clone)]
pub struct Clip {
    pub wav: Vec<u8>,
    pub seconds: f64,
}

pub trait Provider: Send + Sync {
    /// `local`, `fish`, `elevenlabs`, `deepseek`, `openai`, `groq`.
    fn id(&self) -> &'static str;
    /// `cancel` is polled while the engine works; a true answer ends the call with `stt_cancelled`.
    fn transcribe(&self, clip: &Clip, cancel: &dyn Fn() -> bool) -> Result<String, SttError>;
}

/// The most upload bytes (upstream `TRANSCRIBE_MAX_BYTES`).
pub const MAX_WAV_BYTES: usize = 12 * 1024 * 1024;
/// The longest clip (upstream manual dictation cap, 5 minutes).
pub const MAX_SECONDS: f64 = 300.0;

pub struct Stt {
    provider: Box<dyn Provider>,
}

impl Stt {
    pub fn new(provider: Box<dyn Provider>) -> Stt {
        Stt { provider }
    }

    pub fn engine(&self) -> &'static str {
        self.provider.id()
    }

    /// `wav`: what the recorder made (any rate, mono or stereo, 16-bit PCM). Returns the words, or "" when nothing was said.
    pub fn transcribe(&self, wav: &[u8], cancel: &dyn Fn() -> bool) -> Result<String, SttError> {
        if wav.len() > MAX_WAV_BYTES {
            return Err(SttError("stt_audio_too_large"));
        }
        let pcm = wav::to_16k_mono(&wav::parse(wav)?);
        let seconds = pcm.seconds();
        if seconds > MAX_SECONDS {
            return Err(SttError("stt_audio_too_long"));
        }
        // Nothing was said: no engine is started, no request is made, nothing is typed (upstream closes the box quietly).
        if wav::is_silent(&pcm) {
            return Ok(String::new());
        }
        let text = self.provider.transcribe(&Clip { wav: wav::encode(&pcm), seconds }, cancel)?;
        Ok(text.trim().to_string())
    }
}
