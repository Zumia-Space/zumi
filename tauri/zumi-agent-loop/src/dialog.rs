//! HB-2: the opt-in pack acceptance (Explorer) is recorded only from a host-owned native warning dialog that a
//! person clicks. Nothing the model or the stdio driver can reach calls into this module:
//!   * no tool exists for it, and the gate refuses any tool name that could (`accept_refused`, audited);
//!   * the helper refuses the `accept_pack` stdio verb (`not_on_stdio`) and its console route is retired;
//!   * `request_acceptance` is a host function (the wiring calls it from a host menu action); tool_gate, hands_tools,
//!     notes, runner, transport and loop_run never name this module (tests/hb2_reach.rs checks the source).
//! The record is what `zumi-hands arm` reads: an audit line, and a store line next to the policy file, valid for one
//! policy version and the warning text's fingerprint.
use crate::tool_gate::AuditSink;
use serde_json::json;
use std::io::Write;
use std::path::Path;

/// What the helper's `pack_warning` verb returns for a pack.
#[derive(Debug, Clone, PartialEq)]
pub struct PackWarning {
    pub pack: String,
    pub warning: String,
    pub warning_vi: String,
    pub warning_fnv: String,
    pub policy_version: String,
}

impl PackWarning {
    pub fn from_helper(v: &serde_json::Value) -> Option<PackWarning> {
        let s = |k: &str| v.get(k).and_then(serde_json::Value::as_str).map(str::to_string);
        Some(PackWarning { pack: s("pack")?, warning: s("warning")?, warning_vi: s("warning_vi")?, warning_fnv: s("warning_fnv")?, policy_version: s("policy_version")? })
    }
}

/// A modal question to a person. `true` only if the person chose Accept.
pub trait WarningDialog {
    fn ask(&self, title: &str, text: &str) -> bool;
}

/// Shows the warning (English and Vietnamese, as the helper gave it) and, only if the person accepts, writes the audit
/// line and the store line. Declining writes an audit line and nothing else. An acceptance that cannot be logged is not
/// recorded.
pub fn request_acceptance(dialog: &dyn WarningDialog, w: &PackWarning, audit: &dyn AuditSink, policy_file: &Path, key: &[u8]) -> Result<bool, String> {
    let text = format!("{}\n\n{}\n\nAccept this risk? / Chấp nhận rủi ro này?", w.warning, w.warning_vi);
    let detail = |by: &str| json!({ "by": by, "pack": w.pack, "policy_version": w.policy_version, "warning_fnv": w.warning_fnv }).to_string();
    if !dialog.ask(&format!("Zumi: {} pack", w.pack), &text) {
        audit.record("accept_pack", Some("declined"), &detail("host_dialog")).map_err(|e| format!("audit: {e}"))?;
        return Ok(false);
    }
    audit.record("accept_pack", None, &detail("host_dialog")).map_err(|e| format!("the acceptance could not be logged, so it was not recorded: {e}"))?;
    let mut store = policy_file.as_os_str().to_owned();
    store.push(".accepted.jsonl");
    // The MAC is what makes the line count: only this function, holding the host's key, can make one the helper accepts.
    let t = crate::types::unix_ms();
    let mac = zumi_audit::hostmac::mac_hex(key, &[&w.pack, &w.policy_version, &w.warning_fnv, &t.to_string()]);
    let line = json!({ "pack": w.pack, "policy_version": w.policy_version, "warning_fnv": w.warning_fnv, "t_unix_ms": t, "mac": mac }).to_string();
    std::fs::OpenOptions::new().create(true).append(true).open(&store).and_then(|mut f| writeln!(f, "{line}")).map_err(|e| format!("store: {e}"))?;
    Ok(true)
}

/// The host's own action "turn on the ${pack} pack": asks the armed helper for the pack's warning (read-only verb), then
/// shows the dialog. The acceptance applies from the helper's next `arm` (it reads the store then).
pub fn accept_pack_from_host(link: &crate::hands_tools::SharedLink, pack: &str, dialog: &dyn WarningDialog, audit: &dyn AuditSink, policy_file: &Path, key: &[u8]) -> Result<bool, String> {
    let resp = link.lock().unwrap_or_else(|p| p.into_inner()).call(json!({ "cmd": "pack_warning", "pack": pack }), std::time::Duration::from_secs(10))?;
    if resp.get("ok") != Some(&json!(true)) {
        return Err(format!("pack_warning refused: {}", resp["error"].as_str().unwrap_or("?")));
    }
    let w = PackWarning::from_helper(&resp["result"]).ok_or("the helper's pack_warning reply is incomplete")?;
    request_acceptance(dialog, &w, audit, policy_file, key)
}

/// The host action with the real dialog and the helper's audit file: what a host menu entry calls.
#[cfg(windows)]
pub fn accept_pack_native(link: &crate::hands_tools::SharedLink, pack: &str, policy_file: &Path, audit_file: &Path, key: &[u8]) -> Result<bool, String> {
    let audit = zumi_audit::Audit::open(audit_file).map_err(|e| format!("audit: {e}"))?;
    accept_pack_from_host(link, pack, &NativeDialog, &audit, policy_file, key)
}

/// The host action end to end: starts a helper of its own, arms it on the pack's policy file (so `pack_warning` names that
/// policy's version), shows the dialog, records the signed acceptance, ends the helper.
pub fn accept_pack_with_helper(helper_exe: &Path, pack: &str, policy_file: &Path, audit_file: &Path, key: &[u8], dialog: &dyn WarningDialog) -> Result<bool, String> {
    let helper = crate::hands_tools::StdioHands::spawn(helper_exe).map_err(|e| format!("helper: {e}"))?;
    let link: crate::hands_tools::SharedLink = std::sync::Arc::new(std::sync::Mutex::new(Box::new(helper)));
    crate::hands_setup::arm(&link, 60_000, audit_file, policy_file, policy_file.parent().unwrap_or(Path::new(".")))?;
    let audit = zumi_audit::Audit::open(audit_file).map_err(|e| format!("audit: {e}"))?;
    accept_pack_from_host(&link, pack, dialog, &audit, policy_file, key)
}

/// `accept_pack_with_helper` with the real dialog.
#[cfg(windows)]
pub fn accept_pack_with_helper_native(helper_exe: &Path, pack: &str, policy_file: &Path, audit_file: &Path, key: &[u8]) -> Result<bool, String> {
    accept_pack_with_helper(helper_exe, pack, policy_file, audit_file, key, &NativeDialog)
}

/// The real dialog (R7c, re-gate R7b section 6): the question on its own PRIVATE desktop, the screen switched to it, input that was
/// injected dropped, Decline (No) the default button (`zumi_packs::consent::secure_ask`, the window the pack consent uses). A plain message
/// box on the person's desktop is found by FindWindow and answered with BM_CLICK by any process of the same user that is not held out by
/// the job, which a program a `proc.spawn` pack starts through Start-Process or WMI is not. No answer in `HB2_TIMEOUT` is No, and so is
/// any error (the screen cannot be switched, the desktop cannot be made): never an acceptance. P3 is a stand-in for the full consent
/// screen of the power packs (roadmap 1.5: 5-second delay, scrolled to the end).
#[cfg(windows)]
pub struct NativeDialog;

#[cfg(windows)]
pub const HB2_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

#[cfg(windows)]
impl NativeDialog {
    /// The question with explicit options (tests ask without switching the screen of the machine they run on).
    pub fn ask_with(&self, title: &str, text: &str, opts: &zumi_packs::consent::SecureOpts) -> Result<bool, String> {
        zumi_packs::consent::secure_ask(title, text, opts)
    }
}

#[cfg(windows)]
impl WarningDialog for NativeDialog {
    fn ask(&self, title: &str, text: &str) -> bool {
        self.ask_with(title, text, &zumi_packs::consent::SecureOpts { switch: true, timeout: HB2_TIMEOUT }).unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    struct Says(bool, RefCell<Vec<(String, String)>>);
    impl WarningDialog for Says {
        fn ask(&self, title: &str, text: &str) -> bool {
            self.1.borrow_mut().push((title.to_string(), text.to_string()));
            self.0
        }
    }
    struct Mem(RefCell<Vec<(String, Option<String>, String)>>, bool);
    impl AuditSink for Mem {
        fn record(&self, verb: &str, code: Option<&str>, detail: &str) -> std::io::Result<()> {
            if self.1 {
                return Err(std::io::Error::other("disk full"));
            }
            self.0.borrow_mut().push((verb.to_string(), code.map(str::to_string), detail.to_string()));
            Ok(())
        }
    }
    const KEY: [u8; 32] = [3u8; 32];
    fn warning() -> PackWarning {
        PackWarning { pack: "explorer".into(), warning: "EN warning".into(), warning_vi: "VI warning".into(), warning_fnv: "abc123".into(), policy_version: "v9".into() }
    }
    fn policy(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("zumi-dialog-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d.join("policy.json")
    }

    #[test]
    fn a_click_on_accept_writes_the_audit_line_and_the_store_line_the_helper_reads() {
        let (dlg, audit, p) = (Says(true, Default::default()), Mem(Default::default(), false), policy("yes"));
        assert_eq!(request_acceptance(&dlg, &warning(), &audit, &p, &KEY), Ok(true));
        let shown = dlg.1.borrow()[0].1.clone();
        assert!(shown.contains("EN warning") && shown.contains("VI warning"), "both languages are shown");
        let a = audit.0.borrow();
        assert_eq!((a[0].0.as_str(), a[0].1.as_deref()), ("accept_pack", None));
        assert!(a[0].2.contains("host_dialog") && a[0].2.contains("abc123") && a[0].2.contains("v9"));
        let store = std::fs::read_to_string(format!("{}.accepted.jsonl", p.display())).unwrap();
        let v: serde_json::Value = serde_json::from_str(store.trim()).unwrap();
        assert_eq!((v["pack"].as_str(), v["policy_version"].as_str(), v["warning_fnv"].as_str()), (Some("explorer"), Some("v9"), Some("abc123")));
        // The record carries a MAC that verifies under the host's key (and under no other).
        let t = v["t_unix_ms"].as_u64().unwrap().to_string();
        let mac = v["mac"].as_str().unwrap();
        assert!(zumi_audit::hostmac::verify(&KEY, &["explorer", "v9", "abc123", &t], mac));
        assert!(!zumi_audit::hostmac::verify(&[4u8; 32], &["explorer", "v9", "abc123", &t], mac), "not under another key");
    }

    #[test]
    fn bite_declining_records_a_refusal_and_no_acceptance() {
        let (dlg, audit, p) = (Says(false, Default::default()), Mem(Default::default(), false), policy("no"));
        assert_eq!(request_acceptance(&dlg, &warning(), &audit, &p, &KEY), Ok(false));
        assert_eq!(audit.0.borrow()[0].1.as_deref(), Some("declined"));
        assert!(!std::path::Path::new(&format!("{}.accepted.jsonl", p.display())).exists(), "no store line without a click");
    }

    #[test]
    fn bite_an_acceptance_that_cannot_be_logged_is_not_recorded() {
        let (dlg, audit, p) = (Says(true, Default::default()), Mem(Default::default(), true), policy("nolog"));
        assert!(request_acceptance(&dlg, &warning(), &audit, &p, &KEY).is_err());
        assert!(!std::path::Path::new(&format!("{}.accepted.jsonl", p.display())).exists());
    }

    /// The acceptance window is on a desktop of its own: FindWindow from the person's desktop (what a pack process does) finds nothing, and
    /// nobody answering means No. (Not switched to the screen: this test must not take over the machine it runs on.)
    #[cfg(windows)]
    #[test]
    fn the_acceptance_is_not_a_window_of_the_persons_desktop() {
        use windows::core::PCWSTR;
        use windows::Win32::UI::WindowsAndMessaging::FindWindowW;
        let title = format!("Zumi: hb2-r7c-{}", std::process::id());
        let t2 = title.clone();
        let asker = std::thread::spawn(move || NativeDialog.ask_with(&t2, "probe: nobody answers", &zumi_packs::consent::SecureOpts { switch: false, timeout: std::time::Duration::from_secs(4) }));
        let (t, class): (Vec<u16>, Vec<u16>) = (title.encode_utf16().chain([0]).collect(), "#32770".encode_utf16().chain([0]).collect());
        let end = std::time::Instant::now() + std::time::Duration::from_millis(3000);
        while std::time::Instant::now() < end {
            // SAFETY: NUL-terminated buffers that outlive the call.
            let found = unsafe { FindWindowW(PCWSTR(class.as_ptr()), PCWSTR(t.as_ptr())) }.ok().filter(|h| !h.0.is_null());
            assert!(found.is_none(), "the acceptance window is visible on the person's desktop");
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert_eq!(asker.join().unwrap(), Ok(false), "no answer is No");
    }

    struct Link(serde_json::Value);
    impl crate::hands_tools::HandsLink for Link {
        fn call(&mut self, req: serde_json::Value, _t: std::time::Duration) -> Result<serde_json::Value, String> {
            assert_eq!(req["cmd"], "pack_warning", "the host asks only for the warning");
            Ok(self.0.clone())
        }
    }

    #[test]
    fn the_host_action_fetches_the_warning_from_the_helper_and_records_only_after_a_click() {
        let reply = json!({ "ok": true, "result": { "pack": "explorer", "warning": "EN", "warning_vi": "VI", "warning_fnv": "f1", "policy_version": "v1", "exe": "x" } });
        let link: crate::hands_tools::SharedLink = std::sync::Arc::new(std::sync::Mutex::new(Box::new(Link(reply.clone()))));
        let (no, p_no) = (Says(false, Default::default()), policy("hostno"));
        assert_eq!(accept_pack_from_host(&link, "explorer", &no, &Mem(Default::default(), false), &p_no, &KEY), Ok(false));
        assert!(!std::path::Path::new(&format!("{}.accepted.jsonl", p_no.display())).exists());
        let (yes, p_yes) = (Says(true, Default::default()), policy("hostyes"));
        assert_eq!(accept_pack_from_host(&link, "explorer", &yes, &Mem(Default::default(), false), &p_yes, &KEY), Ok(true));
        assert!(std::path::Path::new(&format!("{}.accepted.jsonl", p_yes.display())).exists());
        let bad: crate::hands_tools::SharedLink = std::sync::Arc::new(std::sync::Mutex::new(Box::new(Link(json!({ "ok": false, "error": "bad_args" })))));
        assert!(accept_pack_from_host(&bad, "nope", &yes, &Mem(Default::default(), false), &policy("hostbad"), &KEY).is_err(), "a pack the helper does not know cannot be accepted");
    }

    #[test]
    fn the_helper_reply_parses_into_a_warning_and_a_partial_one_does_not() {
        let v = json!({ "pack": "explorer", "warning": "a", "warning_vi": "b", "warning_fnv": "c", "policy_version": "d", "exe": "x" });
        assert_eq!(PackWarning::from_helper(&v).unwrap().policy_version, "d");
        assert!(PackWarning::from_helper(&json!({ "pack": "explorer" })).is_none());
    }
}
