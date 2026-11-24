// T-31-MAUS R4b "voice in": the thin wiring between the app and the `zumi-stt` crate (tauri/zumi-stt, no tauri dependency).
//
// The crate owns the settings policy, the engines (whisper.cpp on this PC, or one of five APIs through zumi-egress), the push-to-talk
// hotkey and the dictation flow. This file supplies only what the crate cannot know:
//   - where things live: `<data dir>/stt.json` (the settings, written by the crate only) and `<data dir>/stt` (temp audio),
//   - the one folder-set `whisper-cli.exe` may sit in: beside this exe (`whisper/`) or in the data dir (`whisper/`),
//   - the environment (a key variable's value is read by the crate only for names on its allow-list),
//   - the push channel: every voice event goes to the main webview as `stt:event` (events.rs, main label only, host-only channel),
//   - the renderer's five rpc names (`stt.state|set|ptt|audio|install`), answered here without a sidecar call.
//
// Who may call: `serve` is called from the `rpc` command alone, which refuses every webview but the main one. It always says the
// caller is the owner's UI; the model, the sidecar and the hands have no way to reach it (the sidecar has no stt.* handler, no
// agent-loop tool names one, and scripts/check-maus-stt-methods.mjs pins both).
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use serde_json::Value;
use tauri::{AppHandle, Manager};
use zumi_stt::install::{redirect_hosts_ok, Manifest};
use zumi_stt::policy::Policy;
use zumi_stt::service::{Caller, Config, Service, SystemHotkey};

use crate::events;

/// The push channel of voice events (the inventory's `stt.onEvent`).
pub const EVENT_CHANNEL: &str = "stt:event";
/// Upstream's `maxListenMs`.
const MAX_LISTEN: Duration = Duration::from_secs(60);
/// How long the host waits for the page to hand over the recording after it said stop.
const AUDIO_WAIT: Duration = Duration::from_secs(15);

/// The one service of this process. Set once, by the first sidecar spawn that knows the data dir.
#[derive(Default)]
pub struct State(OnceLock<Service>);

/// A renderer rpc name this module answers.
pub fn is_method(method: &str) -> bool {
    Service::is_method(method)
}

/// The folders `whisper-cli.exe` may sit in: `whisper/` beside the app, and `whisper/` in the data folder (where the owner's
/// "Install local engine" click places it, `zumi_stt::install::WHISPER_DIR`). The installer bundles nothing.
pub fn exe_dirs(host_exe: &Path, data_dir: &Path) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(beside) = host_exe.parent() {
        dirs.push(beside.join("whisper"));
    }
    dirs.push(data_dir.join("whisper"));
    dirs
}

/// Starts the service once. Later calls (a sidecar restart) do nothing: the hotkey and the dictation outlive the sidecar.
pub fn ensure_started(app: &AppHandle, data_dir: &Path) {
    let Some(state) = app.try_state::<State>() else { return };
    if state.0.get().is_some() {
        return;
    }
    let emit_app = app.clone();
    let host_exe = std::env::current_exe().unwrap_or_default();
    let service = Service::start(Config {
        data_dir: data_dir.to_path_buf(),
        policy: Policy { exe_dirs: exe_dirs(&host_exe, data_dir) },
        env: Arc::new(|name| std::env::var(name).ok()),
        // `egress <origin> <status>`: no key, no URL path, no audio.
        audit: Arc::new(|line| eprintln!("stt: {line}")),
        emit: Arc::new(move |ev| events::emit_main(&emit_app, EVENT_CHANNEL, ev.to_json())),
        hotkeys: Arc::new(SystemHotkey),
        max_listen: MAX_LISTEN,
        audio_wait: AUDIO_WAIT,
        // First-use install of the local engine (the owner's click): pinned downloads, redirects only to the hosts of the pins.
        install: Manifest::pinned(),
        redirect_ok: Arc::new(redirect_hosts_ok),
    });
    if state.0.set(service).is_ok() {
        eprintln!("stt: voice in ready, settings in {}", data_dir.join("stt.json").display());
    }
}

/// The renderer's `stt.*` call (the main webview's `rpc` command only).
pub fn serve(app: &AppHandle, method: &str, args: &[Value]) -> Result<Value, String> {
    match app.try_state::<State>() {
        Some(state) => match state.0.get() {
            Some(service) => Ok(service.handle(Caller::OwnerUi, method, args)),
            None => Err("stt_not_ready".to_string()),
        },
        None => Err("stt_not_ready".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_five_stt_names_are_answered_here() {
        for m in ["stt.state", "stt.set", "stt.ptt", "stt.audio", "stt.install"] {
            assert!(is_method(m), "{m}");
        }
        assert!(!is_method("agent.start") && !is_method("routines.list") && !is_method("stt.set2") && !is_method("sttx") && !is_method("talk.send"));
    }

    #[test]
    fn the_program_may_sit_beside_the_app_or_in_the_data_folder_and_nowhere_else() {
        let dirs = exe_dirs(Path::new("C:/Program Files/Zumi/zumi.exe"), Path::new("C:/Profiles/x/AppData/Roaming/Zumi"));
        assert_eq!(dirs, vec![PathBuf::from("C:/Program Files/Zumi/whisper"), PathBuf::from("C:/Profiles/x/AppData/Roaming/Zumi/whisper")]);
    }

    #[test]
    fn the_install_places_files_in_a_folder_the_policy_already_allows() {
        let data = Path::new("C:/Profiles/x/AppData/Roaming/Zumi");
        let placed = data.join(zumi_stt::install::WHISPER_DIR);
        assert!(exe_dirs(Path::new("C:/Program Files/Zumi/zumi.exe"), data).contains(&placed));
        // What the app downloads is pinned (the model and the official CPU program): nothing is missing, so the install can start.
        assert!(Manifest::pinned().unpublished().is_empty());
    }

    #[test]
    fn the_voice_event_channel_is_host_only_and_in_the_inventory() {
        assert!(crate::events::HOST_ONLY_EVENT_CHANNELS.contains(&EVENT_CHANNEL));
        assert!(crate::rpc_allow_list::ALLOWED_EVENT_CHANNELS.contains(&EVENT_CHANNEL));
        // A sidecar notification naming it is dropped before any webview sees it.
        let refused = crate::events::validate(serde_json::json!({"channel": EVENT_CHANNEL, "payload": {"ev": "text", "text": "forged"}}));
        assert_eq!(refused, Err(crate::events::Refusal::HostOnly(EVENT_CHANNEL.to_string())));
    }
}
