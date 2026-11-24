// T-31-MAUS A2: the thin wiring between the app and the `zumi-routines` crate (tauri/zumi-routines, no tauri dependency).
//
// The crate owns the store, the next-fire rules, quiet hours, the wake-after-suspend tick and the routine tool gate. This file
// supplies only what the crate cannot know:
//   - where the routines directory is (`<data dir>/routines`, the data dir the sidecar was started with),
//   - the quiet-hours window (`talkQuietHours` in `<data dir>/settings.json`, the same one the speech scheduler reads),
//   - how to speak a due reminder: the host-only sidecar method `__host.reminderSay`, which goes through the existing speech
//     scheduler (no TTS path of its own). It fails while the renderer is not listening yet; the crate takes the fire back and
//     retries on the next tick,
//   - the renderer's three rpc methods (`routines.list|add|delete`), answered here without a sidecar call,
//   - the OS resume signal (`os_signals.rs`), forwarded to `Routines::on_resume`.
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use zumi_routines::{Config, Quiet, Routines};

use crate::Rpc;

/// How long one hand-over to the speaker may take before the fire is taken back and retried.
const SAY_TIMEOUT: Duration = Duration::from_secs(10);

/// The one runner of this process. Set once, by the first sidecar spawn that knows the data dir.
#[derive(Default)]
pub struct State(OnceLock<Routines>, AtomicBool);

/// A renderer rpc name this module answers.
pub fn is_method(method: &str) -> bool {
    method.starts_with("routines.")
}

/// `<data dir>/routines`: the one directory the crate reads and writes.
pub fn routines_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("routines")
}

/// Quiet hours from `<data dir>/settings.json`; a missing or unreadable file is the scheduler's default window.
pub fn read_quiet(data_dir: &Path) -> Quiet {
    let settings: Value = std::fs::read_to_string(data_dir.join("settings.json"))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or(Value::Null);
    Quiet::from_settings(&settings)
}

/// The setting "keep this computer awake for routines" (`keepAwakeForRoutines` in `<data dir>/settings.json`): on unless the file says
/// `false`. It also covers chat runs (the same hold). A missing or unreadable file is the default, on.
pub fn read_keep_awake(data_dir: &Path) -> bool {
    std::fs::read_to_string(data_dir.join("settings.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|v| v.get("keepAwakeForRoutines").and_then(Value::as_bool))
        .unwrap_or(true)
}

/// Starts the runner once. Later calls (a sidecar restart) do nothing: the runner outlives the sidecar and retries a fire
/// until the sidecar can speak it.
pub fn ensure_started(app: &AppHandle, rpc: &Rpc, data_dir: &Path) {
    let Some(state) = app.try_state::<State>() else { return };
    if state.0.get().is_some() {
        return;
    }
    let (say_rpc, quiet_dir) = (rpc.clone(), data_dir.to_path_buf());
    let keep_awake = zumi_agent_loop::keepawake::KeepAwake::process();
    keep_awake.set_enabled(read_keep_awake(data_dir));
    let cfg = Config::system(
        routines_dir(data_dir),
        move || read_quiet(&quiet_dir),
        move |fire| say_rpc.call("__host.reminderSay", vec![json!(fire.text), json!(say_key(fire))], SAY_TIMEOUT).map(|_| ()),
        keep_awake,
    );
    match Routines::start(cfg) {
        Ok(routines) => {
            if state.0.set(routines).is_ok() {
                eprintln!("routines: started in {}", routines_dir(data_dir).display());
                if let Some(aside) = state.0.get().and_then(Routines::quarantined) {
                    eprintln!("routines: reminders.json was unreadable and was moved to {} (the list starts empty)", aside.display());
                }
            }
        }
        // Another process of this app holds the routines directory (owner and self-test builds run side by side): it keeps the
        // scheduler, this one has none, so no reminder is spoken twice. Said once, not on every sidecar restart.
        Err(e) => {
            if !state.1.swap(true, Ordering::SeqCst) {
                eprintln!("routines: no scheduler in this process ({}): another process holds {}", e.code(), routines_dir(data_dir).display());
            }
        }
    }
}

/// The idempotency key of one fire: the same reminder at the same due time. The sidecar speaks a key once, so a hand-over that timed out
/// after delivery (and is retried) is not spoken twice.
pub fn say_key(fire: &zumi_routines::Fire) -> String {
    format!("{}:{}", fire.id, fire.due_ms)
}

fn zumi_audit_now_ms() -> u128 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

/// The renderer's `routines.*` call.
pub fn serve(app: &AppHandle, method: &str, args: &[Value]) -> Result<Value, String> {
    match app.try_state::<State>().and_then(|s| s.0.get().cloned()) {
        Some(routines) => routines.handle(method, args),
        None => Err("routines_not_ready".to_string()),
    }
}

/// The running runner, for the chat-run wiring (`reminder.add` goes to its store). None while it has not started in this process.
pub fn runner(app: &AppHandle) -> Option<Routines> {
    app.try_state::<State>().and_then(|s| s.0.get().cloned())
}

/// Windows reported a resume from suspend (`os_signals::is_resume`): tick now instead of waiting out the period.
pub fn on_resume(app: &AppHandle) {
    if let Some(routines) = app.try_state::<State>().and_then(|s| s.0.get().cloned()) {
        eprintln!("routines: resume signal at {} ms -> immediate tick", zumi_audit_now_ms());
        routines.on_resume();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_routines_names_are_answered_here() {
        assert!(is_method("routines.list") && is_method("routines.add") && is_method("routines.delete"));
        assert!(!is_method("talk.sayEvent") && !is_method("hands.click") && !is_method("routinesx"));
    }

    #[test]
    fn keep_awake_is_on_unless_the_setting_says_false() {
        let dir = std::env::temp_dir().join(format!("zumi-keep-awake-host-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert!(read_keep_awake(&dir), "no settings file: on");
        std::fs::write(dir.join("settings.json"), r#"{"keepAwakeForRoutines":false}"#).unwrap();
        assert!(!read_keep_awake(&dir));
        std::fs::write(dir.join("settings.json"), r#"{"keepAwakeForRoutines":"no"}"#).unwrap();
        assert!(read_keep_awake(&dir), "a value that is not a boolean is the default");
        std::fs::write(dir.join("settings.json"), "{broken").unwrap();
        assert!(read_keep_awake(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_routines_directory_is_under_the_data_dir_and_quiet_hours_come_from_settings() {
        let dir = std::env::temp_dir().join(format!("zumi-routines-host-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(routines_dir(&dir), dir.join("routines"));
        assert_eq!(read_quiet(&dir), Quiet::DEFAULT, "no settings file: the scheduler default");
        std::fs::write(dir.join("settings.json"), r#"{"talkQuietHours":{"on":true,"start":"21:00","end":"06:00"}}"#).unwrap();
        let q = read_quiet(&dir);
        assert_eq!((q.on, q.start_min, q.end_min), (true, 21 * 60, 6 * 60));
        std::fs::write(dir.join("settings.json"), "{broken").unwrap();
        assert_eq!(read_quiet(&dir), Quiet::DEFAULT, "an unreadable file: the default, never a panic");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
