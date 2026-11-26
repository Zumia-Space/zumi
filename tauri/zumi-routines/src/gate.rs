//! The routine tool gate: the one door a scheduled routine passes before it does anything.
//!
//! Default deny. A routine may speak and chat; nothing else. A routine can never call a hands tool (`hands.*`, the UI
//! Automation helper) or a pack tool (`pack.*`, a power pack's helper): they act on the PC, and a routine runs while the
//! user may be away (owner ruling O7: routines speak and chat only, hands never run unattended).
//!
//! Every decision, allowed or refused, is one audit line through `zumi-audit` (verb `routine.tool`). An action that cannot
//! be logged does not happen: if the audit write fails the routine is not run.
use zumi_audit::{Audit, Entry};

/// Every tool a routine may name. Exact match; no prefix, no case folding.
pub const ALLOWED_TOOLS: [&str; 2] = ["speak", "chat.say"];
/// The audit code of a refusal.
pub const REFUSED: &str = "routine_tool_refused";

/// Where decisions are written. `zumi_audit::Audit` is the real one; tests use a failing one.
pub trait AuditSink: Send {
    fn record(&self, e: &Entry) -> std::io::Result<()>;
}

impl AuditSink for Audit {
    fn record(&self, e: &Entry) -> std::io::Result<()> {
        Audit::record(self, e).map(|_| ())
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Verdict {
    Allowed,
    /// The tool is not one a routine may use. Logged.
    Refused,
    /// The decision could not be logged, so the routine must not run.
    NotLogged,
}

/// Which kind of tool a refused name is, for the audit detail only. The decision never depends on it.
fn kind_of(tool: &str) -> &'static str {
    let t = tool.trim().to_ascii_lowercase();
    if t.starts_with("hands.") || t.starts_with("hands_") || t == "hands" {
        "hands"
    } else if t.starts_with("pack.") || t.starts_with("pack_") || t == "pack" || t.starts_with("power.") {
        "pack"
    } else {
        "other"
    }
}

pub fn authorize(audit: &dyn AuditSink, routine_id: &str, tool: &str) -> Verdict {
    let allowed = ALLOWED_TOOLS.contains(&tool);
    // Control characters would let a stored name forge a second audit field; the detail keeps the name printable.
    let shown: String = tool.chars().take(60).map(|c| if c.is_control() { '?' } else { c }).collect();
    let detail = if allowed {
        format!("routine={routine_id} tool={shown}")
    } else {
        format!("routine={routine_id} tool={shown} kind={}", kind_of(tool))
    };
    let entry = Entry { verb: "routine.tool", pid: None, exe: None, hwnd: None, code: (!allowed).then_some(REFUSED), detail: &detail };
    if audit.record(&entry).is_err() {
        return Verdict::NotLogged;
    }
    if allowed {
        Verdict::Allowed
    } else {
        Verdict::Refused
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::store::tests::tmp_dir;
    use serde_json::Value;

    pub struct FailingAudit;
    impl AuditSink for FailingAudit {
        fn record(&self, _: &Entry) -> std::io::Result<()> {
            Err(std::io::Error::new(std::io::ErrorKind::Other, "disk full"))
        }
    }

    pub fn read_lines(path: &std::path::Path) -> Vec<Value> {
        std::fs::read_to_string(path).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect()
    }

    const HANDS: [&str; 10] = [
        "hands.click", "hands.type", "hands.key", "hands.snapshot", "hands.launch", "hands.scroll", "hands.arm", "Hands.Click", " hands.type", "hands_click",
    ];
    const PACKS: [&str; 10] = [
        "pack.shell", "pack.adb", "pack.browser-hands", "pack.run", "power.browser-hands", "power.shell", "pack.x", "PACK.SHELL", "pack_adb", "pack.",
    ];

    #[test]
    fn a_routine_cannot_call_a_hands_or_pack_tool_ten_of_ten() {
        let d = tmp_dir("gate-refuse");
        let a = Audit::open(&d.join("audit.jsonl")).unwrap();
        for tool in HANDS.iter().chain(PACKS.iter()) {
            assert_eq!(authorize(&a, "r1", tool), Verdict::Refused, "{tool}");
        }
        let lines = read_lines(a.path());
        assert_eq!(lines.len(), 20, "one audit line per decision");
        assert!(lines.iter().all(|l| l["decision"] == "refused" && l["code"] == REFUSED && l["verb"] == "routine.tool"));
        assert!(lines[0]["detail"].as_str().unwrap().contains("kind=hands"));
        assert!(lines[10]["detail"].as_str().unwrap().contains("kind=pack"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn speak_and_chat_pass_and_are_logged_as_allowed() {
        let d = tmp_dir("gate-pass");
        let a = Audit::open(&d.join("audit.jsonl")).unwrap();
        for _ in 0..10 {
            assert_eq!(authorize(&a, "r1", "speak"), Verdict::Allowed);
        }
        assert_eq!(authorize(&a, "r2", "chat.say"), Verdict::Allowed);
        let lines = read_lines(a.path());
        assert_eq!(lines.len(), 11);
        assert!(lines.iter().all(|l| l["decision"] == "allowed" && l["code"].is_null()));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn anything_not_on_the_list_is_refused_not_only_hands_and_pack_names() {
        let d = tmp_dir("gate-default");
        let a = Audit::open(&d.join("audit.jsonl")).unwrap();
        for tool in ["", "shell", "exec", "note.save", "reminder.add", "Speak", "speak ", "speak\n", "chat.say.more"] {
            assert_eq!(authorize(&a, "r", tool), Verdict::Refused, "{tool:?}");
        }
        let lines = read_lines(a.path());
        assert!(lines.iter().any(|l| l["detail"].as_str().unwrap().contains("kind=other")));
        // A name with a newline cannot start a second audit field: the file still has one JSON object per line.
        assert_eq!(lines.len(), 9);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_decision_that_cannot_be_logged_does_not_run() {
        assert_eq!(authorize(&FailingAudit, "r", "speak"), Verdict::NotLogged);
        assert_eq!(authorize(&FailingAudit, "r", "hands.click"), Verdict::NotLogged);
    }
}
