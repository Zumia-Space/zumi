//! M4 end to end in the crate: the loop on the real `SidecarTransport` against a sidecar stub whose model call hangs.
//! A kill (or any cancel) ends the whole task within 200 ms and the in-flight model call is aborted, not left to finish.
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use zumi_agent_loop::loop_run::{run, LoopConfig, NullMeter, StopReason};
use zumi_agent_loop::tool_gate::{AuditSink, GateConfig, ToolGate};
use zumi_agent_loop::transport::{RpcCall, SidecarTransport, TransportError, MODEL_TURN_CANCEL_METHOD};
use zumi_agent_loop::Cancel;

#[derive(Clone, Default)]
struct HangingSidecar {
    aborted: Arc<AtomicBool>,
    cancels: Arc<Mutex<u32>>,
}
impl RpcCall for HangingSidecar {
    fn call(&mut self, method: &str, _p: Value, _c: &Cancel) -> Result<Value, TransportError> {
        if method == MODEL_TURN_CANCEL_METHOD {
            *self.cancels.lock().unwrap() += 1;
            self.aborted.store(true, Ordering::SeqCst);
            return Ok(json!({ "ok": true }));
        }
        let end = Instant::now() + Duration::from_secs(3);
        while Instant::now() < end {
            if self.aborted.load(Ordering::SeqCst) {
                return Ok(json!({ "ok": false, "error": "cancelled" }));
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        Ok(json!({ "ok": true, "text": "late", "toolCalls": [], "usage": { "in": 1, "out": 1 }, "model": "m", "ms": 3000 }))
    }
}
struct Null;
impl AuditSink for Null {
    fn record(&self, _v: &str, _c: Option<&str>, _d: &str) -> std::io::Result<()> {
        Ok(())
    }
}

fn task(cancel_after: Option<u64>) -> (StopReason, u128, u32) {
    let sidecar = HangingSidecar::default();
    let cancels = sidecar.cancels.clone();
    let mut t = SidecarTransport { rpc: sidecar, model: Some("m".into()) };
    let mut gate = ToolGate::new(GateConfig::new("c", vec![], vec!["hi".into()]), vec![], Box::new(Null));
    let c = Cancel::new();
    if let Some(ms) = cancel_after {
        let c2 = c.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(ms));
            c2.set("killed");
        });
    }
    let t0 = Instant::now();
    let o = run(&LoopConfig { system: "s".into(), user: "hi".into(), max_turns: 5 }, &mut t, &mut gate, &mut NullMeter, &c, &mut |_| {});
    let ms = t0.elapsed().as_millis();
    std::thread::sleep(Duration::from_millis(60));
    let n = *cancels.lock().unwrap();
    (o.stop, ms, n)
}

#[test]
fn bite_a_kill_during_the_real_transports_model_call_ends_the_task_within_200_ms_and_aborts_the_call() {
    for kill_ms in [30u64, 120, 400] {
        let (stop, ms, aborts) = task(Some(kill_ms));
        assert_eq!(stop, StopReason::Killed, "kill at {kill_ms} ms");
        assert!(ms <= u128::from(kill_ms) + 200, "kill at {kill_ms} ms: the task ended at {ms} ms");
        assert_eq!(aborts, 1, "the sidecar was told to abort the in-flight call (kill at {kill_ms} ms)");
    }
}

#[test]
fn pass_twin_without_a_kill_the_slow_call_completes_and_is_not_aborted() {
    let (stop, ms, aborts) = task(None);
    assert_eq!(stop, StopReason::Done);
    assert!(ms >= 2900, "{ms}");
    assert_eq!(aborts, 0);
}
