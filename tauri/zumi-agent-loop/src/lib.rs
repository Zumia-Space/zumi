//! zumi-agent-loop (T-31-MAUS P3): the agent loop, `tool_gate` (the one door for every tool call), the built-in tools,
//! the usage ledger and the host-owned warning dialog. No `tauri` dependency: the host calls this crate through a thin
//! wiring layer (`tauri/src-tauri/src/agent_wiring.rs`).
//!
//! The model is reached only through `transport::ModelTransport`. The real transport (`SidecarTransport`) calls ONE
//! host-only sidecar method, `__host.modelTurn`, which makes the model call and returns text, tool calls and token
//! usage; it executes no tool. Provider adapters and key stores stay in the sidecar. P3 tests run on `MockTransport`,
//! which replays fixture turns: no live model call is made by this crate's tests or its goal run.
pub mod budget;
pub mod cancel;
pub mod dialog;
pub mod hands_setup;
pub mod hands_tools;
pub mod ledger;
pub mod loop_run;
pub mod mcp_http;
pub mod notes;
pub mod openai_compat;
pub mod reminders;
pub mod redact;
pub mod risk;
mod risk_words;
pub mod runner;
pub mod runs;
pub mod saved_steps;
pub mod tool_gate;
pub mod transport;
pub mod types;

/// R6: the keep-awake the host shares between chat runs and routines (it lives in `zumi-audit`, the crate both already use).
pub use zumi_audit::keepawake;
pub use cancel::Cancel;
pub use types::{ToolCall, ToolResult, TurnRequest, TurnResponse, Usage};

/// R5 (gate item): marks this process's own std handles non-inheritable. The host calls it as the first statement of its entry
/// points, so a child started before the first hands helper (the Node sidecar) cannot inherit a pipe the host was given.
pub fn private_std_handles() {
    zumi_audit::inherit::private_std_handles();
}

/// The host's acceptance key (HB-2): 32 random bytes from the OS.
#[cfg(windows)]
pub fn hostmac_new_key() -> Result<Vec<u8>, String> {
    zumi_audit::hostmac::new_key()
}
