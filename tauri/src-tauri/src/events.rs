// T-31 parity step 2 — sidecar -> renderer push events.
//
// The sidecar sends a JSON-RPC notification `{ method: "event", params: { channel, payload } }`
// (tauri/sidecar/protocol.mjs). This module is the only place such a message becomes a webview event:
//
//   1. `channel` must be one of the inventory's event channels (generated ALLOWED_EVENT_CHANNELS);
//   2. the serialized payload must not exceed MAX_EVENT_PAYLOAD_BYTES (matches protocol.mjs);
//   3. it is emitted to the label "main" ONLY. A guest webview (the board) is addressed by its own
//      `guest-N` label, so it is never a target; and there is deliberately no broadcast `emit` anywhere in
//      this crate (a test below scans for it), because an event is delivered by evaluating script in every
//      webview it reaches.
//
// A refused event is dropped and logged by channel name and byte size only. The payload is never logged:
// it can carry chat text or audio.

use serde_json::Value;
use tauri::{AppHandle, Emitter};

use crate::guest::MAIN_LABEL;
use crate::rpc_allow_list::ALLOWED_EVENT_CHANNELS;

/// Largest serialized payload the host forwards, in bytes. Keep equal to MAX_EVENT_PAYLOAD_BYTES in
/// tauri/sidecar/protocol.mjs. Below the 1 MB frame limit so one oversized event drops only itself.
pub const MAX_EVENT_PAYLOAD_BYTES: usize = 512 * 1024;

/// Longest channel name echoed into a log line (a refused name is sidecar-controlled text).
const LOG_NAME_CHARS: usize = 64;

/// Why an event notification was not forwarded.
#[derive(Debug, PartialEq, Eq)]
pub enum Refusal {
    /// `params` was not an object with a string `channel`.
    Malformed,
    /// The channel is not in the inventory.
    UnknownChannel(String),
    /// The serialized payload is over the limit (size in bytes).
    Oversize { channel: &'static str, bytes: usize },
}

/// A notification that passed the checks. `channel` is the allow-list's own `'static` string, not the
/// sidecar's text.
#[derive(Debug, PartialEq)]
pub struct ValidEvent {
    pub channel: &'static str,
    pub payload: Value,
}

/// Check one `event` notification's `params`.
pub fn validate(params: Value) -> Result<ValidEvent, Refusal> {
    let Value::Object(mut map) = params else {
        return Err(Refusal::Malformed);
    };
    let Some(Value::String(name)) = map.remove("channel") else {
        return Err(Refusal::Malformed);
    };
    let Some(channel) = ALLOWED_EVENT_CHANNELS.iter().copied().find(|c| *c == name) else {
        return Err(Refusal::UnknownChannel(name.chars().take(LOG_NAME_CHARS).collect()));
    };
    let payload = map.remove("payload").unwrap_or(Value::Null);
    let bytes = serde_json::to_vec(&payload).map(|b| b.len()).unwrap_or(usize::MAX);
    if bytes > MAX_EVENT_PAYLOAD_BYTES {
        return Err(Refusal::Oversize { channel, bytes });
    }
    Ok(ValidEvent { channel, payload })
}

/// Where an event ends up. The label is explicit so a test can prove which webview is addressed; the
/// real implementation is Tauri's `emit_to`, which matches a window or webview by label.
pub trait EventSink {
    fn emit_to_label(&self, label: &str, channel: &str, payload: &Value);
}

impl<T: EventSink + ?Sized> EventSink for &T {
    fn emit_to_label(&self, label: &str, channel: &str, payload: &Value) {
        (**self).emit_to_label(label, channel, payload)
    }
}

impl EventSink for AppHandle {
    fn emit_to_label(&self, label: &str, channel: &str, payload: &Value) {
        if let Err(e) = self.emit_to(label, channel, payload.clone()) {
            eprintln!("events: emit {channel} failed: {e}");
        }
    }
}

/// Validate and forward one sidecar `event` notification to the main webview. A refusal is logged
/// (name + size) and returned; nothing reaches any webview.
pub fn forward(sink: &impl EventSink, params: Value) -> Result<&'static str, Refusal> {
    match validate(params) {
        Ok(event) => {
            sink.emit_to_label(MAIN_LABEL, event.channel, &event.payload);
            Ok(event.channel)
        }
        Err(refusal) => {
            match &refusal {
                Refusal::Malformed => eprintln!("events: dropped a malformed event notification"),
                Refusal::UnknownChannel(name) => eprintln!("events: dropped unknown channel {name:?}"),
                Refusal::Oversize { channel, bytes } => {
                    eprintln!("events: dropped {channel}: payload {bytes} bytes > {MAX_EVENT_PAYLOAD_BYTES}")
                }
            }
            Err(refusal)
        }
    }
}

/// Host-originated event (`sidecar:ready`, `sidecar:error`) to the main webview only.
pub fn emit_main(sink: &impl EventSink, channel: &str, payload: Value) {
    sink.emit_to_label(MAIN_LABEL, channel, &payload);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::cell::RefCell;

    /// Models Tauri's label addressing: an event sent to a label reaches only the webviews with that label.
    struct FakeWebviews {
        labels: Vec<&'static str>,
        inbox: RefCell<Vec<(String, String, Value)>>, // (webview label, channel, payload)
    }

    impl FakeWebviews {
        fn new() -> Self {
            Self { labels: vec!["main", "guest-1", "guest-2"], inbox: RefCell::new(Vec::new()) }
        }
        fn received_by(&self, label: &str) -> Vec<(String, Value)> {
            self.inbox.borrow().iter().filter(|(l, _, _)| l == label).map(|(_, c, p)| (c.clone(), p.clone())).collect()
        }
    }

    impl EventSink for FakeWebviews {
        fn emit_to_label(&self, label: &str, channel: &str, payload: &Value) {
            for l in self.labels.iter().filter(|l| **l == label) {
                self.inbox.borrow_mut().push((l.to_string(), channel.to_string(), payload.clone()));
            }
        }
    }

    fn notification(channel: &str, payload: Value) -> Value {
        json!({ "channel": channel, "payload": payload })
    }

    #[test]
    fn an_unknown_channel_is_refused_and_nothing_is_delivered() {
        let views = FakeWebviews::new();
        let err = forward(&views, notification("evil:channel", json!({ "x": 1 }))).unwrap_err();
        assert_eq!(err, Refusal::UnknownChannel("evil:channel".to_string()));
        assert!(views.inbox.borrow().is_empty(), "a refused event reaches no webview");
    }

    #[test]
    fn a_rpc_method_name_is_not_an_event_channel() {
        // The event list and the rpc list are separate: `info` is a method, not a channel.
        assert!(matches!(validate(notification("info", Value::Null)), Err(Refusal::UnknownChannel(_))));
        assert!(matches!(validate(notification("update.onState", Value::Null)), Err(Refusal::UnknownChannel(_))));
    }

    #[test]
    fn a_malformed_notification_is_refused() {
        for params in [Value::Null, json!([]), json!("speech:say"), json!({}), json!({ "channel": 7 }), json!({ "payload": 1 })] {
            assert_eq!(validate(params.clone()), Err(Refusal::Malformed), "{params}");
        }
    }

    #[test]
    fn an_oversize_payload_is_refused_and_one_at_the_limit_is_not() {
        let views = FakeWebviews::new();
        // A JSON string is its length + 2 quotes, so this is exactly the limit.
        let at_limit = Value::String("a".repeat(MAX_EVENT_PAYLOAD_BYTES - 2));
        assert!(forward(&views, notification("talk:ttsMore", at_limit)).is_ok(), "exactly at the limit passes");
        let over = Value::String("a".repeat(MAX_EVENT_PAYLOAD_BYTES - 1));
        assert_eq!(
            forward(&views, notification("talk:ttsMore", over)).unwrap_err(),
            Refusal::Oversize { channel: "talk:ttsMore", bytes: MAX_EVENT_PAYLOAD_BYTES + 1 }
        );
        assert_eq!(views.inbox.borrow().len(), 1, "only the in-limit event was delivered");
    }

    #[test]
    fn every_inventory_channel_reaches_main_only_and_in_order() {
        let views = FakeWebviews::new();
        for (i, channel) in ALLOWED_EVENT_CHANNELS.iter().enumerate() {
            assert_eq!(forward(&views, notification(channel, json!({ "n": i }))), Ok(*channel));
        }
        // 14 since 0.3.0-alpha.14 (market:progress added; wardrobe:progress left in alpha.11).
        assert_eq!(ALLOWED_EVENT_CHANNELS.len(), 14, "the folded inventory has 14 event channels");
        assert!(!ALLOWED_EVENT_CHANNELS.iter().any(|c| c.starts_with("wardrobe:")));
        let main = views.received_by("main");
        assert_eq!(main.len(), 14);
        for (i, (channel, payload)) in main.iter().enumerate() {
            assert_eq!(channel, ALLOWED_EVENT_CHANNELS[i], "delivery order = send order");
            assert_eq!(payload, &json!({ "n": i }), "payload unchanged");
        }
        assert!(views.received_by("guest-1").is_empty(), "a guest never receives a forwarded event");
        assert!(views.received_by("guest-2").is_empty(), "a guest never receives a forwarded event");
    }

    #[test]
    fn host_events_go_to_main_only() {
        let views = FakeWebviews::new();
        emit_main(&views, "sidecar:error", json!({ "message": "m", "fatal": false }));
        assert_eq!(views.received_by("main").len(), 1);
        assert!(views.received_by("guest-1").is_empty() && views.received_by("guest-2").is_empty());
    }

    /// The exact line tauri/sidecar/protocol.mjs eventFrame() writes (scripts/check-tauri-events.mjs pins the
    /// same literal on the Node side), so the two halves cannot drift apart unnoticed.
    #[test]
    fn the_sidecars_golden_frame_is_accepted_and_forwarded_to_main() {
        let line = r#"{"jsonrpc":"2.0","method":"event","params":{"channel":"speech:say","payload":{"sayId":"s1","text":"hi"}}}"#;
        let msg: Value = serde_json::from_str(line).unwrap();
        assert_eq!(msg["method"], "event");
        let views = FakeWebviews::new();
        assert_eq!(forward(&views, msg["params"].clone()), Ok("speech:say"));
        assert_eq!(views.received_by("main"), vec![("speech:say".to_string(), json!({ "sayId": "s1", "text": "hi" }))]);
    }

    #[test]
    fn a_missing_payload_is_null() {
        let ev = validate(json!({ "channel": "model:changed" })).unwrap();
        assert_eq!(ev.payload, Value::Null);
    }

    /// The crate must not broadcast: Tauri's plain `emit` reaches every webview, guests included. All
    /// production code goes through `emit_to(label, …)` / `EventSink`.
    #[test]
    fn no_source_file_broadcasts_an_event() {
        let broadcast = [".emi", "t("].concat();
        let sources = [
            ("lib.rs", include_str!("lib.rs")),
            ("guest.rs", include_str!("guest.rs")),
            ("guest_guard.rs", include_str!("guest_guard.rs")),
            ("window_shell.rs", include_str!("window_shell.rs")),
            ("shell_ops.rs", include_str!("shell_ops.rs")),
            ("events.rs", include_str!("events.rs")),
        ];
        for (name, text) in sources {
            for (n, line) in text.lines().enumerate() {
                let code = line.split("//").next().unwrap_or("");
                assert!(!code.contains(&broadcast), "{name}:{} broadcasts an event; use emit_to or events::emit_main", n + 1);
            }
        }
    }
}
