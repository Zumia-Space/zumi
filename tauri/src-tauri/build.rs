// Tauri build script: generates the context (icons, capabilities, config) consumed by
// `tauri::generate_context!()` in src/lib.rs.
//
// It also makes `cargo build` self-sufficient before the renderer bundle is assembled: Tauri v2
// embeds `frontendDist` (`tauri/ui`) into the binary at compile time, so a missing directory fails
// the build. If `tauri/ui/index.html` is absent we drop a tiny placeholder page and warn; the real
// bundle is produced by `node tauri/prep-ui.mjs` (which replaces `tauri/ui` wholesale). This keeps a
// clean checkout — and CI — buildable without running the esbuild renderer step.
fn main() {
    ensure_ui_placeholder();
    owner_open_roots();
    // Declare the app commands so tauri-build autogenerates `allow-rpc` / `allow-guest-*` permissions.
    // Without this manifest the ACL is inert for the (local) main webview; with it, capabilities/default.json
    // is what grants the main webview each command. No guest webview matches any capability (the wardrobe's
    // one bridge command and its capability were removed in 0.3.0-alpha.11).
    let attributes = tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "rpc",
            "guest_open",
            "guest_navigate",
            "guest_bounds",
            "guest_close",
            // MKT: the tab bar's list of installed web-app packs (pack_host.rs). Main webview only.
            "pack_list",
            // Parity 12-2: the CDP self-test command. Its permission is never in the shipped capabilities; lib.rs
            // adds capabilities-selftest/selftest.json at runtime ONLY when the host was launched with a self-test
            // CLI flag, so a normal launch cannot reach it (Q5).
            "guest_cdp",
        ]),
    );
    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}

fn ensure_ui_placeholder() {
    use std::path::Path;
    let ui = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("ui");
    let index = ui.join("index.html");
    if index.exists() {
        return;
    }
    let _ = std::fs::create_dir_all(&ui);
    let html = "<!doctype html>\n<html><head><meta charset=\"utf-8\"><title>Zumi Preview</title></head>\n\
<body><p>Renderer bundle not assembled. Run <code>npm run build:renderer</code> then \
<code>node tauri/prep-ui.mjs</code>.</p></body></html>\n";
    match std::fs::write(&index, html) {
        Ok(()) => println!("cargo:warning=tauri/ui was empty; wrote a placeholder index.html (run tauri/prep-ui.mjs for the real renderer)"),
        Err(e) => println!("cargo:warning=could not write tauri/ui placeholder: {e}"),
    }
}

// The owner flavour's open-path roots (src/main/owner-values.json `openRoots`, the same key src/main/board-open.mjs reads) are
// compiled in as ZUMI_OWNER_OPEN_ROOTS, `|`-separated (open_path.rs owner_open_roots). The file is owner-only (ZUMI_ONLY,
// scripts/lib/zumi-only.cjs): a public source tree has none, so its owner flavour has no root at all (open-path off). A file
// that is present but malformed fails the build: an owner build must never silently lose its roots.
fn owner_open_roots() {
    use std::path::Path;
    let file = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("src").join("main").join("owner-values.json");
    println!("cargo:rerun-if-changed={}", file.display());
    let roots: Vec<String> = match std::fs::read_to_string(&file) {
        Ok(text) => {
            let doc: serde_json::Value = serde_json::from_str(&text).expect("src/main/owner-values.json is not valid JSON");
            let list = doc.get("openRoots").and_then(|v| v.as_array()).expect("src/main/owner-values.json has no openRoots array");
            list.iter().map(|r| r.as_str().expect("openRoots holds a non-string").to_string()).collect()
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(e) => panic!("cannot read src/main/owner-values.json: {e}"),
    };
    assert!(roots.iter().all(|r| !r.is_empty() && !r.contains('|')), "openRoots: an empty root or one holding '|'");
    println!("cargo:rustc-env=ZUMI_OWNER_OPEN_ROOTS={}", roots.join("|"));
}
