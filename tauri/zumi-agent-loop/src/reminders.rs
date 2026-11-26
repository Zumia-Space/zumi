//! `reminder.add`: one reminder in the A2 store (`zumi-routines`), through tool_gate like every other tool.
//! A reminder made here is the same as one made in the form: it speaks once at the next such local time (`repeat: none`:
//! today if the time is still ahead, tomorrow if it has passed) and its tool is always `speak`. The model cannot pick
//! another tool, a repeat or an id: the tool has two parameters, `text` and `time` (`HH:MM`).
use crate::cancel::Cancel;
use crate::tool_gate::{ArgKind, Cap, Param, Tool, ToolSpec};
use crate::types::ToolResult;
use serde_json::{json, Value};

/// Where a reminder goes. Production: the running A2 runner (the host's `Routines`); the store directory is locked by it,
/// so the loop never opens a second store on the same directory.
pub trait ReminderStore {
    /// Ok(the item as `routines.list` shows it) or (code word, detail).
    fn add(&mut self, text: &str, time: &str) -> Result<Value, (String, String)>;
}

impl<R: ReminderStore + ?Sized> ReminderStore for Box<R> {
    fn add(&mut self, text: &str, time: &str) -> Result<Value, (String, String)> {
        (**self).add(text, time)
    }
}

/// `routines.add` of a running `Routines`.
pub struct RoutinesStore(pub zumi_routines::Routines);

impl ReminderStore for RoutinesStore {
    fn add(&mut self, text: &str, time: &str) -> Result<Value, (String, String)> {
        let reply = self.0.handle("routines.add", &[json!({ "text": text, "time": time, "repeat": "none" })]).map_err(|e| ("routines_failed".to_string(), e))?;
        if reply.get("ok") == Some(&json!(true)) {
            Ok(reply["item"].clone())
        } else {
            Err((reply.get("error").and_then(Value::as_str).unwrap_or("routines_failed").to_string(), String::new()))
        }
    }
}

pub struct ReminderTool<S: ReminderStore> {
    spec: ToolSpec,
    store: S,
}

impl<S: ReminderStore> ReminderTool<S> {
    pub fn new(store: S) -> ReminderTool<S> {
        ReminderTool {
            spec: ToolSpec {
                name: "reminder.add",
                description: "Set a one-time spoken reminder. `time` is the local clock time as HH:MM (24 hour): today if it is still ahead, otherwise tomorrow. Both values must be what the user asked for.",
                cap: Cap::Reminder,
                params: vec![
                    Param { name: "text", required: true, kind: ArgKind::Text, values: None },
                    Param { name: "time", required: true, kind: ArgKind::Time, values: None },
                ],
                available: true,
                taints: false,
            },
            store,
        }
    }
}

impl<S: ReminderStore> Tool for ReminderTool<S> {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }
    fn execute(&mut self, args: &Value, _cancel: &Cancel) -> ToolResult {
        let s = |k: &str| args.get(k).and_then(Value::as_str).unwrap_or("");
        match self.store.add(s("text"), s("time")) {
            Ok(item) => ToolResult::ok(json!({ "created": true, "id": item["id"], "time": item["time"], "next_ms": item["nextMs"] })),
            Err((code, detail)) => ToolResult::err(&format!("reminder_{code}"), &detail),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct Mem(Vec<(String, String)>, Option<&'static str>);
    impl ReminderStore for Mem {
        fn add(&mut self, text: &str, time: &str) -> Result<Value, (String, String)> {
            if let Some(code) = self.1 {
                return Err((code.to_string(), String::new()));
            }
            self.0.push((text.to_string(), time.to_string()));
            Ok(json!({ "id": "r-1", "text": text, "time": time, "repeat": "none", "nextMs": 1 }))
        }
    }

    #[test]
    fn the_tool_adds_one_reminder_and_reports_its_id() {
        let mut t = ReminderTool::new(Mem::default());
        let r = t.execute(&json!({ "text": "uống nước", "time": "15:00" }), &Cancel::new());
        assert!(r.ok, "{r:?}");
        assert_eq!(r.value["id"], "r-1");
        assert_eq!(t.store.0, vec![("uống nước".to_string(), "15:00".to_string())]);
    }

    #[test]
    fn bite_a_store_refusal_is_an_error_with_its_code_not_a_success() {
        let mut t = ReminderTool::new(Mem(vec![], Some("bad_time")));
        let r = t.execute(&json!({ "text": "x y", "time": "25:99" }), &Cancel::new());
        assert_eq!((r.ok, r.error.as_deref()), (false, Some("reminder_bad_time")));
    }
}
