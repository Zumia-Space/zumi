//! `power.canary`'s helper (test only, feature `canary`): a helper that tries everything. It speaks the helper protocol (`zumi-power/1`)
//! over stdio, exactly as a real pack helper does: one JSON request per line on stdout, one JSON answer per line on stdin. It has no
//! file, process or socket call of its own; it only asks the broker, which is the point of the canary.
//!
//!   zumi-pack-canary <script.json>
//!     { "attempts": [ { "op": "spawn", "program": "whoami" }, { "op": "__env" }, ... ], "report": "<path>", "hold": true }
//!   Each attempt is sent in order and its answer is kept. `{"op":"__env"}` is answered by the canary itself with the names of the
//!   environment variables it was started with (a helper must not inherit the host's keys). At the end the answers are written
//!   through the broker's own `write` op to `report`, and the canary then waits for ever (`hold`) so a kill has something to end.
use serde_json::{json, Value};
use std::io::{BufRead, Write};

fn ask(out: &mut impl Write, input: &mut impl BufRead, req: &Value) -> Value {
    if writeln!(out, "{req}").and_then(|_| out.flush()).is_err() {
        return json!({ "ok": false, "code": "pipe_closed" });
    }
    let mut line = String::new();
    match input.read_line(&mut line) {
        Ok(n) if n > 0 => serde_json::from_str(line.trim()).unwrap_or_else(|_| json!({ "ok": false, "code": "bad_answer" })),
        _ => json!({ "ok": false, "code": "pipe_closed" }),
    }
}

fn main() {
    let Some(script_path) = std::env::args().nth(1) else {
        eprintln!("usage: zumi-pack-canary <script.json>");
        std::process::exit(2);
    };
    let script: Value = match std::fs::read_to_string(&script_path).ok().and_then(|t| serde_json::from_str(&t).ok()) {
        Some(v) => v,
        None => {
            eprintln!("script unreadable");
            std::process::exit(2);
        }
    };
    let stdin = std::io::stdin();
    let mut input = stdin.lock();
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    let mut answers = Vec::new();
    for attempt in script["attempts"].as_array().cloned().unwrap_or_default() {
        let answer = if attempt["op"] == "__env" {
            let mut names: Vec<String> = std::env::vars().map(|(k, _)| k).collect();
            names.sort();
            json!({ "ok": true, "env": names })
        } else {
            ask(&mut out, &mut input, &attempt)
        };
        answers.push(json!({ "attempt": attempt, "answer": answer }));
    }
    if let Some(report) = script["report"].as_str() {
        let text = Value::Array(answers).to_string();
        let _ = ask(&mut out, &mut input, &json!({ "op": "write", "path": report, "text": text }));
    }
    if script["hold"].as_bool().unwrap_or(false) {
        loop {
            std::thread::sleep(std::time::Duration::from_secs(60));
        }
    }
}
