//! A local MCP server over Streamable HTTP for the R3 goal harness (scripts/maus-r3-mcp.mjs): the same fixture the tests use
//! (tests/common/mcp_fixture.rs), on 127.0.0.1 with an ephemeral port. Built only with `--features fixture`; never part of the app.
//!
//!   zumi-mcp-fixture [--secret WORD] [--log FILE]
//! Prints `{"ev":"ready","origin":..,"url":..}`, serves until its stdin closes, then writes every request it received to FILE
//! (one JSON object per line: method, tool, args, header names; never header values) and exits.
use serde_json::json;
use std::io::{Read, Write};

#[path = "../../tests/common/mcp_fixture.rs"]
mod mcp_fixture;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let value = |k: &str| args.iter().position(|a| a == k).and_then(|i| args.get(i + 1)).cloned();
    let fixture = mcp_fixture::McpFixture::start();
    if let Some(s) = value("--secret") {
        *fixture.knobs.secret.lock().unwrap() = s;
    }
    println!("{}", json!({ "ev": "ready", "origin": fixture.server.origin(), "url": fixture.url() }));
    let _ = std::io::stdout().flush();
    let mut sink = Vec::new();
    let _ = std::io::stdin().read_to_end(&mut sink);
    if let Some(file) = value("--log") {
        let lines: Vec<String> = fixture
            .log
            .lock()
            .unwrap()
            .iter()
            .map(|l| json!({ "http": l.http, "method": l.method, "tool": l.tool, "args": l.args, "headers": l.headers.iter().map(|h| h.0.clone()).collect::<Vec<_>>() }).to_string())
            .collect();
        let _ = std::fs::write(file, lines.join("\n") + "\n");
    }
}
