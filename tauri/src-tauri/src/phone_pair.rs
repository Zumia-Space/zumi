// T-31-MOBILE M3: "Ghép điện thoại" on the desktop (M3-DESIGN.md §3.3, GATE-M3.md fix 8).
//
// The renderer asks with `phone.pairStart` / `phone.pairEnd` / `phone.unpair`; the `rpc` command hands those three names
// here BEFORE the sidecar, dropping any page arguments. For a pairing:
//   1. owner build only: the sidecar's `phone.status` must exist (else `owner_only`, no dialog);
//   2. never during a self-test/shots run (they capture the window), never twice at once;
//   3. a NATIVE confirm (the renderer shows LLM text, so no script may start an export of the board password silently);
//   4. window capture protection ON (WDA_EXCLUDEFROMCAPTURE: screenshots, screen share and RDP show black);
//   5. the sidecar's host-only `__host.phonePairBundle` mints the device token and returns the bundle text;
//   6. the bundle is encoded HERE as an SVG QR and the text dropped; the page gets the picture, which ENCODES the login;
//   7. after 60 s this module removes the QR from the page and turns protection off on its own, whatever the page does.
// "One-time" is rotation: every pairing revokes the token minted last time (sidecar), so an older QR stops working.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

pub const QR_SECONDS: u64 = 60;
/// The element the renderer shows the QR in; the host removes it by id when the 60 s are up.
pub const QR_ELEMENT_ID: &str = "phone-qr";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Op {
    Start,
    End,
    Unpair,
}

impl Op {
    pub fn from_method(method: &str) -> Option<Op> {
        match method {
            "phone.pairStart" => Some(Op::Start),
            "phone.pairEnd" => Some(Op::End),
            "phone.unpair" => Some(Op::Unpair),
            _ => None,
        }
    }
}

/// One QR on screen at most. `generation` lets a late 60 s timer from an earlier QR do nothing.
#[derive(Default, Clone)]
pub struct QrState {
    showing: Arc<AtomicBool>,
    generation: Arc<AtomicU64>,
}

/// Everything with a side effect, so the flow is unit-tested without a window, a dialog or a sidecar.
pub trait Host {
    fn self_test_active(&self) -> bool;
    fn confirm(&self) -> bool;
    fn protect(&self, on: bool);
    fn remove_qr(&self);
    fn call(&self, method: &str) -> Result<Value, String>;
}

pub fn qr_svg(text: &str) -> Result<String, String> {
    let code = qrcode::QrCode::with_error_correction_level(text.as_bytes(), qrcode::EcLevel::M).map_err(|_| "qr_encode".to_string())?;
    Ok(code.render::<qrcode::render::svg::Color>().min_dimensions(320, 320).quiet_zone(true).build())
}

fn end(state: &QrState, host: &dyn Host) -> bool {
    state.generation.fetch_add(1, Ordering::SeqCst);
    let was = state.showing.swap(false, Ordering::SeqCst);
    if was {
        host.remove_qr();
        host.protect(false);
    }
    was
}

/// Runs one intercepted call. `schedule_end(gen)` must call `expire(gen)` after QR_SECONDS (the real host spawns a thread).
pub fn run(op: Op, state: &QrState, host: &dyn Host, schedule_end: &dyn Fn(u64)) -> Result<Value, String> {
    match op {
        Op::End => Ok(Value::Bool(end(state, host))),
        Op::Unpair => {
            if host.call("phone.status").is_err() { return Ok(json!({ "ok": false, "error": "owner_only" })); }
            host.call("__host.phoneUnpair")
        }
        Op::Start => {
            if host.call("phone.status").is_err() { return Ok(json!({ "ok": false, "error": "owner_only" })); }
            if host.self_test_active() { return Ok(json!({ "ok": false, "error": "busy_selftest" })); }
            if state.showing.swap(true, Ordering::SeqCst) { return Ok(json!({ "ok": false, "error": "busy" })); }
            let release = |state: &QrState| state.showing.store(false, Ordering::SeqCst);
            if !host.confirm() { release(state); return Ok(json!({ "ok": false, "error": "cancelled" })); }
            host.protect(true);
            let answer = match host.call("__host.phonePairBundle") {
                Ok(v) => v,
                Err(e) => { host.protect(false); release(state); return Err(e); }
            };
            let bundle = answer.get("bundle").and_then(Value::as_str);
            let (Some(true), Some(bundle)) = (answer.get("ok").and_then(Value::as_bool), bundle) else {
                host.protect(false);
                release(state);
                let error = answer.get("error").and_then(Value::as_str).unwrap_or("pair_failed");
                return Ok(json!({ "ok": false, "error": error }));
            };
            let svg = match qr_svg(bundle) {
                Ok(s) => s,
                Err(e) => { host.protect(false); release(state); return Ok(json!({ "ok": false, "error": e })); }
            };
            let gen = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
            schedule_end(gen);
            let expires_at = std::time::SystemTime::now()
                .checked_add(Duration::from_secs(QR_SECONDS))
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            Ok(json!({ "ok": true, "svg": svg, "name": answer.get("name").cloned().unwrap_or(Value::Null), "expiresAt": expires_at }))
        }
    }
}

/// The 60 s timer's body: only the QR it was started for.
pub fn expire(state: &QrState, host: &dyn Host, gen: u64) {
    if state.generation.load(Ordering::SeqCst) == gen {
        end(state, host);
    }
}

/// Native OK/Cancel box owned by the main window (default button: Cancel).
#[cfg(windows)]
pub fn native_confirm(owner: isize) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, IDOK, MB_DEFBUTTON2, MB_ICONWARNING, MB_OKCANCEL};
    let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let text = wide("Hiện mã ghép điện thoại?\n\nMã chứa đăng nhập bảng task của anh và một mã thiết bị mới. Chỉ quét bằng app Zumi trên điện thoại. Mã tự ẩn sau 60 giây; ảnh chụp màn hình sẽ ra màu đen.\n\nShow the phone pairing code? It holds your board login.");
    let title = wide("Zumi - Ghép điện thoại");
    // SAFETY: both buffers are NUL-terminated and live across the call; the owner is the main window or null.
    unsafe { MessageBoxW(owner as _, text.as_ptr(), title.as_ptr(), MB_OKCANCEL | MB_ICONWARNING | MB_DEFBUTTON2) == IDOK }
}
#[cfg(not(windows))]
pub fn native_confirm(_owner: isize) -> bool {
    false // no native dialog here: refuse rather than export without a confirm
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    struct Fake {
        log: RefCell<Vec<String>>,
        confirm: bool,
        self_test: bool,
        owner: bool,
        bundle: Result<Value, String>,
    }
    impl Fake {
        fn new() -> Self {
            Fake { log: RefCell::new(vec![]), confirm: true, self_test: false, owner: true, bundle: Ok(json!({ "ok": true, "bundle": "{\"v\":1,\"kind\":\"zumi-phone-pair\",\"pass\":\"SECRET-pw\"}", "name": "phone-20261101-ab12" })) }
        }
        fn calls(&self) -> Vec<String> { self.log.borrow().clone() }
    }
    impl Host for Fake {
        fn self_test_active(&self) -> bool { self.self_test }
        fn confirm(&self) -> bool { self.log.borrow_mut().push("confirm".into()); self.confirm }
        fn protect(&self, on: bool) { self.log.borrow_mut().push(format!("protect:{on}")); }
        fn remove_qr(&self) { self.log.borrow_mut().push("remove_qr".into()); }
        fn call(&self, method: &str) -> Result<Value, String> {
            self.log.borrow_mut().push(format!("call:{method}"));
            match method {
                "phone.status" => if self.owner { Ok(json!({ "paired": false })) } else { Err("not_implemented:phone.status".into()) },
                "__host.phonePairBundle" => self.bundle.clone(),
                _ => Ok(json!({ "ok": true })),
            }
        }
    }
    fn no_timer(_: u64) {}

    // ---- negative first: nothing is minted without the owner build, a confirm, and no test run ----
    #[test]
    fn refusals_mint_nothing() {
        let state = QrState::default();
        let mut f = Fake::new();
        f.owner = false;
        assert_eq!(run(Op::Start, &state, &f, &no_timer).unwrap()["error"], "owner_only");
        assert!(!f.calls().iter().any(|c| c == "confirm" || c.contains("Bundle")));

        let mut f = Fake::new();
        f.self_test = true;
        assert_eq!(run(Op::Start, &state, &f, &no_timer).unwrap()["error"], "busy_selftest");
        assert!(!f.calls().iter().any(|c| c == "confirm" || c.contains("Bundle")));

        let mut f = Fake::new();
        f.confirm = false;
        assert_eq!(run(Op::Start, &state, &f, &no_timer).unwrap()["error"], "cancelled");
        assert_eq!(f.calls(), vec!["call:phone.status", "confirm"], "cancel must not protect or mint");

        let mut f = Fake::new();
        f.bundle = Ok(json!({ "ok": false, "error": "locked_or_unconfigured" }));
        assert_eq!(run(Op::Start, &state, &f, &no_timer).unwrap()["error"], "locked_or_unconfigured");
        assert_eq!(f.calls().last().unwrap(), "protect:false", "a failed mint turns protection back off");
        assert!(!state.showing.load(Ordering::SeqCst));
    }

    #[test]
    fn one_qr_at_a_time_and_only_the_svg_leaves() {
        let state = QrState::default();
        let f = Fake::new();
        let out = run(Op::Start, &state, &f, &no_timer).unwrap();
        assert_eq!(out["ok"], true);
        let svg = out["svg"].as_str().unwrap();
        assert!(svg.starts_with("<?xml") || svg.starts_with("<svg"));
        assert!(!out.to_string().contains("SECRET-pw"), "the bundle text left the host");
        assert_eq!(f.calls(), vec!["call:phone.status", "confirm", "protect:true", "call:__host.phonePairBundle"]);
        assert_eq!(run(Op::Start, &state, &Fake::new(), &no_timer).unwrap()["error"], "busy");
    }

    #[test]
    fn the_host_timer_ends_it_and_a_stale_timer_does_nothing() {
        let state = QrState::default();
        let f = Fake::new();
        let gens = RefCell::new(vec![]);
        run(Op::Start, &state, &f, &|g| gens.borrow_mut().push(g)).unwrap();
        let g1 = gens.borrow()[0];
        expire(&state, &f, g1);
        assert!(f.calls().ends_with(&["remove_qr".to_string(), "protect:false".to_string()]));
        assert!(!state.showing.load(Ordering::SeqCst));
        // a second QR; the first QR's timer fires late: nothing happens to the second one
        let f2 = Fake::new();
        run(Op::Start, &state, &f2, &|g| gens.borrow_mut().push(g)).unwrap();
        expire(&state, &f2, g1);
        assert!(state.showing.load(Ordering::SeqCst));
        assert!(!f2.calls().contains(&"remove_qr".to_string()));
        // the page ends it early
        assert_eq!(run(Op::End, &state, &f2, &no_timer).unwrap(), Value::Bool(true));
        assert_eq!(run(Op::End, &state, &f2, &no_timer).unwrap(), Value::Bool(false));
    }

    #[test]
    fn qr_round_trips() {
        let text = r#"{"v":1,"kind":"zumi-phone-pair","iat":1793000000,"user":"u","pass":"p","token":"lb_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","name":"phone-20261101-ab12"}"#;
        let svg = qr_svg(text).unwrap();
        assert!(svg.contains("<svg") && svg.len() > 1000);
    }
}
