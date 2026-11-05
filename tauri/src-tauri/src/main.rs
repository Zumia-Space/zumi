// Prevents an extra console window on Windows in release builds. `debug_assertions` is on for
// `cargo build`, so a dev build keeps stdout/stderr for sidecar logs.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Headless packaged-probe mode (tauri/verify/packaged-probe.mjs): spawn the sidecar through the real host path and
    // exit. It never opens a window. `--probe-data-dir` keeps the probe's settings out of the app's real data dir.
    let args: Vec<String> = std::env::args().collect();
    if args.iter().skip(1).any(|arg| arg == "--probe-sidecar-spawn") {
        let data_dir = args
            .iter()
            .position(|arg| arg == "--probe-data-dir")
            .and_then(|i| args.get(i + 1))
            .map(std::path::PathBuf::from);
        std::process::exit(zumi_preview_lib::probe_sidecar_spawn(data_dir.as_deref()));
    }
    zumi_preview_lib::run()
}
