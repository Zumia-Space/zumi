//! zumi-routines: form-based reminders for Zumi (T-31-MAUS A2). No `tauri` dependency: the host wires it with a thin call.
pub mod api;
pub mod clock;
pub mod engine;
pub mod gate;
pub mod history;
pub mod lock;
pub mod runner;
pub mod store;

pub use engine::{Fire, Quiet};
pub use runner::{Config, Routines, DEFAULT_PERIOD};
