//! A stand-in for the `zumi-hands` helper for the offline R5 tests (tests/r5_runner.rs, tests/injection_set.rs). It speaks the
//! helper's stdio protocol (`serve`, one JSON request per line, one response line each) and touches NO window: nothing here
//! calls UI Automation, SendInput or a launch. Never part of the app.
//!
//! It finds its own directory from the `arm` request's `policy` path (the runner writes the policy into the task's control
//! dir), appends every request to `<dir>/fake-hands.log` and reads two optional files there:
//!   snapshot.json     what `snapshot` answers (`{ "text": .., "elements": [..] }`); default: an empty window
//!   window-title.txt  the title `windows` reports; default `p3-out.txt - Notepad`
//!   refuse.json       `{ "<cmd>": "<error code>" }`: that verb answers a refusal
//! `type` also appends its text to `<dir>/typed.txt`, so a test can see what would have been typed.
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::path::PathBuf;

fn main() {
    if std::env::args().nth(1).as_deref() != Some("serve") {
        eprintln!("zumi-hands-fake serve");
        std::process::exit(2);
    }
    let mut dir: Option<PathBuf> = None;
    let stdin = std::io::stdin();
    let mut out = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let Ok(req) = serde_json::from_str::<Value>(&line) else { continue };
        let cmd = req["cmd"].as_str().unwrap_or("").to_string();
        if cmd == "arm" {
            dir = req["policy"].as_str().and_then(|p| std::path::Path::new(p).parent().map(PathBuf::from));
        }
        if let Some(d) = &dir {
            if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(d.join("fake-hands.log")) {
                let _ = writeln!(f, "{}", req);
            }
        }
        let read = |name: &str| dir.as_ref().and_then(|d| std::fs::read_to_string(d.join(name)).ok());
        let refused = read("refuse.json").and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| v.get(&cmd).and_then(Value::as_str).map(str::to_string));
        let answer = if let Some(code) = refused {
            json!({ "ok": false, "error": code, "detail": "refused by the test" })
        } else {
            let result = match cmd.as_str() {
                "launch" => json!({ "pid": 4242 }),
                "windows" => json!([{ "hwnd": "0x1A", "class": "Notepad", "title": read("window-title.txt").unwrap_or_else(|| "p3-out.txt - Notepad".to_string()), "rect": [0, 0, 800, 600] }]),
                "focus" => json!({ "is_foreground": true }),
                "status" => json!({ "killed": false }),
                "snapshot" => read("snapshot.json").and_then(|t| serde_json::from_str::<Value>(&t).ok()).unwrap_or_else(|| json!({ "text": "", "elements": [] })),
                "type" => {
                    if let (Some(d), Some(t)) = (&dir, req["text"].as_str()) {
                        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(d.join("typed.txt")) {
                            let _ = write!(f, "{t}");
                        }
                    }
                    json!({})
                }
                _ => json!({}),
            };
            json!({ "ok": true, "result": result })
        };
        let mut answer = answer;
        answer["id"] = req["id"].clone();
        let _ = writeln!(out, "{answer}");
        let _ = out.flush();
    }
}
