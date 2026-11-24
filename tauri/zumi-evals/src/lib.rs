//! zumi-evals: the eval registry and runner (K1). An eval is a name and a function that returns Ok or the reason it failed. The runner never
//! hides a failure: the exit code is 0 only when every eval that ran held.
mod evals;
use serde_json::{json, Value};

pub struct Eval {
    pub name: &'static str,
    pub what: &'static str,
    pub run: fn() -> Result<(), String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct EvalResult {
    pub name: String,
    pub ok: bool,
    pub ms: u128,
    pub detail: String,
}

impl EvalResult {
    pub fn to_json(&self) -> Value {
        json!({ "eval": self.name, "ok": self.ok, "ms": self.ms as u64, "detail": self.detail })
    }
}

/// Every eval, in the order the phases landed.
pub fn all() -> Vec<Eval> {
    evals::registry()
}

/// Runs the evals (all, or only those whose name is in `only`). A panic inside an eval is a failure of that eval.
pub fn run(evals: &[Eval], only: &[String]) -> Vec<EvalResult> {
    evals
        .iter()
        .filter(|e| only.is_empty() || only.iter().any(|o| o == e.name))
        .map(|e| {
            let t = std::time::Instant::now();
            let outcome = std::panic::catch_unwind(e.run).unwrap_or_else(|p| Err(format!("panic: {}", p.downcast_ref::<String>().cloned().or_else(|| p.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default())));
            EvalResult { name: e.name.to_string(), ok: outcome.is_ok(), ms: t.elapsed().as_millis(), detail: outcome.err().unwrap_or_default() }
        })
        .collect()
}

/// 0 when at least one eval ran and every one held; 1 otherwise (running nothing is not a pass).
pub fn exit_code(results: &[EvalResult]) -> i32 {
    if !results.is_empty() && results.iter().all(|r| r.ok) {
        0
    } else {
        1
    }
}
