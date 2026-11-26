//! What the settings may name (R4b, GATE-OPUS-R4 should-fix 3). The settings are written by the owner's settings screen only
//! (`service.rs`), but a value there still reaches three dangerous places, so each is narrowed to what the product needs:
//!   - `whisperExe` is a program the host starts. It must be a file named `whisper-cli.exe` that sits directly in one of the
//!     known folders (beside the app, or the app's own data folder): never "any program";
//!   - `keyEnv` names an environment variable whose VALUE is sent as the API key. Only key variables of the five providers, plus
//!     the one dedicated variable (`ZUMI_STT_API_KEY`), can be named: `PATH`, a token of another product, anything else is refused;
//!   - `baseUrl` is where that key is sent. A provider's own key goes only to that provider's origin. A different origin (a
//!     gateway, a server on this PC) is one the user added: it takes only the dedicated variable, and zumi-egress's rules apply
//!     (https, no private address, no userinfo; plain http only for a loopback address).
//! A refusal is one code word: `stt_policy_exe`, `stt_policy_model`, `stt_policy_key`, `stt_policy_origin`, or the egress word.
use crate::api::ApiKind;
use crate::settings::{Engine, Settings};
use crate::SttError;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use zumi_egress::Egress;

/// The variable a user-added origin takes. Nothing else in the environment is a key for such an origin.
pub const USER_KEY_ENV: &str = "ZUMI_STT_API_KEY";

/// The program's file name: the one program this feature starts.
pub const WHISPER_EXE_NAME: &str = "whisper-cli.exe";

/// The key variables each provider's own documentation names.
pub fn provider_key_envs(engine: Engine) -> &'static [&'static str] {
    match engine {
        Engine::Local => &[],
        Engine::Fish => &["FISH_API_KEY", "FISH_AUDIO_API_KEY"],
        Engine::ElevenLabs => &["ELEVENLABS_API_KEY", "XI_API_KEY"],
        Engine::DeepSeek => &["DEEPSEEK_API_KEY"],
        Engine::OpenAi => &["OPENAI_API_KEY"],
        Engine::Groq => &["GROQ_API_KEY"],
    }
}

/// True for a name any engine may read: the host never looks up a variable that is not on this list.
pub fn is_key_env(name: &str) -> bool {
    name == USER_KEY_ENV
        || [Engine::Fish, Engine::ElevenLabs, Engine::DeepSeek, Engine::OpenAi, Engine::Groq].iter().any(|e| provider_key_envs(*e).contains(&name))
}

#[derive(Debug, Clone, Default)]
pub struct Policy {
    /// The folders `whisper-cli.exe` may sit in (the program must be a direct child). Empty: the local engine may not run.
    pub exe_dirs: Vec<PathBuf>,
}

fn same_path(a: &Path, b: &Path) -> bool {
    a.to_string_lossy().eq_ignore_ascii_case(&b.to_string_lossy())
}

/// `base` is `origin` or a path under it: the next character after the origin is the end or `/`.
/// (`https://api.x.com@evil`, `https://api.x.com.evil`, `https://api.x.com:8443` are all different places.)
fn under_origin(base: &str, origin: &str) -> bool {
    let (b, o) = (base.to_ascii_lowercase(), origin.to_ascii_lowercase());
    b.strip_prefix(&o).is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
}

fn model_name_ok(m: &str) -> bool {
    (1..=64).contains(&m.len()) && m.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ':'))
}

impl Policy {
    /// The real file of `exe` when it is `whisper-cli.exe` in a known folder. The caller must START this path, not the one it
    /// was given: a junction or link that passed here can be re-pointed afterwards (GATE-OPUS-R4B should-fix 1).
    fn check_exe(&self, exe: &Path) -> Result<PathBuf, SttError> {
        const BAD: SttError = SttError("stt_policy_exe");
        if !exe.file_name().is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case(WHISPER_EXE_NAME)) {
            return Err(BAD);
        }
        // The real location: `..`, a junction or a link cannot make another folder look like a known one.
        let real = exe.canonicalize().map_err(|_| BAD)?;
        // The real file's own name is checked too: a link named `whisper-cli.exe` to another program in the folder is refused.
        if !real.file_name().is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case(WHISPER_EXE_NAME)) {
            return Err(BAD);
        }
        let parent = real.parent().ok_or(BAD)?;
        if self.exe_dirs.iter().filter_map(|d| d.canonicalize().ok()).any(|d| same_path(&d, parent)) {
            Ok(real)
        } else {
            Err(BAD)
        }
    }

    /// The settings to run: `s` checked, with the program replaced by the one canonical path that passed the check (the
    /// path is resolved once, so the file checked is the file started).
    pub fn resolve(&self, s: &Settings) -> Result<Settings, SttError> {
        if let Some(m) = &s.model {
            if !model_name_ok(m) {
                return Err(SttError("stt_settings_bad"));
            }
        }
        let mut run = s.clone();
        match s.engine {
            Engine::Local => {
                run.whisper_exe = Some(self.check_exe(s.whisper_exe.as_deref().ok_or(SttError("stt_policy_exe"))?)?);
                let model = s.whisper_model.as_deref().ok_or(SttError("stt_policy_model"))?;
                if !model.extension().is_some_and(|e| e.to_string_lossy().eq_ignore_ascii_case("bin")) {
                    return Err(SttError("stt_policy_model"));
                }
            }
            api => {
                if let Some(k) = s.key_env.as_deref() {
                    if k != USER_KEY_ENV && !provider_key_envs(api).contains(&k) {
                        return Err(SttError("stt_policy_key"));
                    }
                }
                if let Some(base) = s.base_url.as_deref() {
                    // The egress's own rules first (scheme, userinfo, private address): their code words are the answer.
                    Egress::new(Arc::new(|_| {})).add_user_origin(base)?;
                    let known = api.api_kind().is_some_and(|k: ApiKind| under_origin(base, k.origin()));
                    if !known && s.key_env.as_deref() != Some(USER_KEY_ENV) {
                        return Err(SttError("stt_policy_origin"));
                    }
                }
            }
        }
        Ok(run)
    }

    /// Whether `s` may run at all (the same answer as `resolve`, without the settings).
    pub fn check(&self, s: &Settings) -> Result<(), SttError> {
        self.resolve(s).map(|_| ())
    }
}
