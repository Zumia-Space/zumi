// MKT phase 2: the web-app pack host's pure parts (ADR 2026-11-11-pack-system). Written before pack_host.rs (red first).
// Fixtures: tests-fixtures/pack/ from scripts/gen-pack-rust-fixtures.mjs (plugin.canary unpacked + an index Node signed).
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::pack_host::*;

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests-fixtures").join("pack")
}

/// A scratch dir under the crate's own target dir (never the system temp on C:).
fn scratch(name: &str) -> PathBuf {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("target").join("pack-tests").join(name);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for e in std::fs::read_dir(from).unwrap() {
        let e = e.unwrap();
        let dest = to.join(e.file_name());
        if e.file_type().unwrap().is_dir() { copy_dir(&e.path(), &dest) } else { std::fs::copy(e.path(), dest).unwrap(); }
    }
}

fn test_key() -> String {
    std::fs::read_to_string(fixtures().join("test.pub")).unwrap()
}

#[test]
fn the_compiled_store_keys_parse_and_differ() {
    let keys = compiled_store_keys();
    assert_eq!(keys.len(), 2, "active + offline spare");
    assert!(keys.iter().all(|k| minisign_verify::PublicKey::from_base64(k.trim().lines().last().unwrap()).is_ok()));
    assert_ne!(keys[0], keys[1]);
}

#[test]
fn an_index_node_signed_verifies_in_rust_and_a_changed_byte_does_not() {
    let index = std::fs::read(fixtures().join("index.json")).unwrap();
    let sig = std::fs::read_to_string(fixtures().join("index.json.minisig")).unwrap();
    let key = test_key();
    assert!(verify_index_sig(&index, &sig, &[key.as_str()]).is_ok());
    let mut changed = index.clone();
    changed[10] ^= 1;
    assert_eq!(verify_index_sig(&changed, &sig, &[key.as_str()]), Err("index_signature"));
    let compiled = compiled_store_keys();
    let refs: Vec<&str> = compiled.iter().map(String::as_str).collect();
    assert_eq!(verify_index_sig(&index, &sig, &refs), Err("index_signature"), "a key the app does not hold");
}

#[test]
fn the_store_verdict_lists_withdraws_and_pins_the_manifest() {
    let index: Value = serde_json::from_slice(&std::fs::read(fixtures().join("index.json")).unwrap()).unwrap();
    let manifest = std::fs::read(fixtures().join("plugin.canary").join("zumi-pack.json")).unwrap();
    let sha = sha256_hex(&manifest);
    assert_eq!(store_verdict(&index, "plugin.canary", "1.0.0", &sha), Ok(()));
    assert_eq!(store_verdict(&index, "plugin.canary", "0.9.0", &sha), Err("pack_withdrawn"));
    assert_eq!(store_verdict(&index, "plugin.other", "1.0.0", &sha), Err("pack_not_listed"));
    assert_eq!(store_verdict(&index, "plugin.canary", "1.0.0", &"0".repeat(64)), Err("manifest_mismatch"));
    assert_eq!(store_verdict(&index, "plugin.canary", "2.0.0", &sha), Err("pack_not_listed"));
}

#[test]
fn the_canary_loads_with_its_permissions() {
    let pack = load_pack_dir(&fixtures().join("plugin.canary"), Some("plugin.canary")).expect("canary loads");
    assert_eq!(pack.id, "plugin.canary");
    assert_eq!(pack.version, "1.0.0");
    assert_eq!(pack.ui, "ui/index.html");
    assert_eq!(pack.tab_label_en, "Canary");
    assert!(pack.storage);
    assert!(!pack.avatar);
    assert_eq!(pack.links.get("docs").map(String::as_str), Some("https://zumia.space/"));
    assert!(pack.files.contains_key("ui/canary.js"));
}

#[test]
fn one_changed_byte_or_an_unlisted_file_and_the_pack_does_not_load() {
    let dir = scratch("changed-byte").join("plugin.canary");
    copy_dir(&fixtures().join("plugin.canary"), &dir);
    let js = dir.join("ui").join("canary.js");
    let mut bytes = std::fs::read(&js).unwrap();
    bytes[3] ^= 1;
    std::fs::write(&js, bytes).unwrap();
    assert_eq!(load_pack_dir(&dir, Some("plugin.canary")).err().as_deref(), Some("files_sha"));

    let dir = scratch("unlisted").join("plugin.canary");
    copy_dir(&fixtures().join("plugin.canary"), &dir);
    std::fs::write(dir.join("ui").join("extra.js"), "x").unwrap();
    assert_eq!(load_pack_dir(&dir, Some("plugin.canary")).err().as_deref(), Some("files_unlisted"));

    let dir = scratch("wrong-id").join("plugin.other");
    copy_dir(&fixtures().join("plugin.canary"), &dir);
    assert_eq!(load_pack_dir(&dir, Some("plugin.other")).err().as_deref(), Some("manifest_id"));
}

#[test]
fn a_pack_with_a_native_file_or_a_newer_api_does_not_load() {
    let dir = scratch("api").join("plugin.canary");
    copy_dir(&fixtures().join("plugin.canary"), &dir);
    let m = dir.join("zumi-pack.json");
    let mut manifest: Value = serde_json::from_slice(&std::fs::read(&m).unwrap()).unwrap();
    manifest["plugin"]["api"] = json!(2);
    std::fs::write(&m, serde_json::to_vec(&manifest).unwrap()).unwrap();
    assert_eq!(load_pack_dir(&dir, Some("plugin.canary")).err().as_deref(), Some("pack_needs_newer_host"));
}

#[test]
fn storage_paths_stay_inside_the_pack_folder() {
    assert_eq!(safe_rel("notes/a.txt"), Ok(vec!["notes".to_string(), "a.txt".to_string()]));
    for bad in ["", "../x", "a/../../x", "./a", "C:/x", "/x", "a\\b", "CON.txt", "a//b", "a/", "nul", "x:y"] {
        assert_eq!(safe_rel(bad), Err("path_escape"), "{bad:?}");
    }
    assert_eq!(safe_rel(&"a".repeat(300)), Err("path_escape"));
}

#[test]
fn pack_paths_split_into_id_and_file() {
    assert_eq!(split_pack_path("/plugin.canary/ui/index.html"), Some(("plugin.canary", "ui/index.html")));
    assert_eq!(split_pack_path("/plugin.canary/"), Some(("plugin.canary", "")));
    assert_eq!(split_pack_path("/plugin.canary"), Some(("plugin.canary", "")));
    assert_eq!(split_pack_path("/"), None);
    assert_eq!(split_pack_path(""), None);
}

#[test]
fn a_pack_guest_reaches_only_its_own_files() {
    let prefix = pack_origin_prefix("plugin.canary");
    assert_eq!(prefix, "http://zumipack.localhost/plugin.canary/");
    assert!(!pack_request_blocks("http://zumipack.localhost/plugin.canary/ui/index.html", &prefix));
    assert!(!pack_request_blocks("data:image/png;base64,AAAA", &prefix));
    assert!(!pack_request_blocks("blob:http://zumipack.localhost/1234", &prefix));
    for blocked in [
        "http://zumipack.localhost/plugin.other/zumi-pack.json",
        "http://zumipack.localhost/plugin.canary.evil/x",
        "https://example.com/",
        "http://127.0.0.1:4212/",
        "http://localhost/",
        "http://ipc.localhost/rpc",
        "http://tauri.localhost/index.html",
        "ws://127.0.0.1:1/",
        "not a url",
    ] {
        assert!(pack_request_blocks(blocked, &prefix), "{blocked}");
    }
}

#[test]
fn a_pack_partition_names_one_pack() {
    assert_eq!(partition_pack_id("pack:plugin.canary"), Some("plugin.canary"));
    assert_eq!(partition_pack_id("pack:plugin.room-preview"), Some("plugin.room-preview"));
    for bad in ["pack:../x", "pack:", "pack:voice.kokoro-82m", "preview-board", "pack:plugin.A"] {
        assert_eq!(partition_pack_id(bad), None, "{bad}");
    }
}

fn call(pack: &LoadedPack, data: &Path, method: &str, args: Value, opened: &mut Vec<String>) -> (u16, Value) {
    let body = serde_json::to_vec(&json!({ "method": method, "args": args })).unwrap();
    bridge_call(pack, data, &body, &mut |url: &str| { opened.push(url.to_string()); Ok(()) })
}

#[test]
fn the_bridge_answers_in_scope_calls_and_refuses_the_rest() {
    let pack = load_pack_dir(&fixtures().join("plugin.canary"), Some("plugin.canary")).unwrap();
    let data = scratch("bridge");
    let mut opened = Vec::new();
    let (s, v) = call(&pack, &data, "host.info", json!({}), &mut opened);
    assert_eq!((s, v["ok"].clone(), v["result"]["api"].clone(), v["result"]["pack"].clone()), (200, json!(true), json!(1), json!("plugin.canary")));
    assert_eq!(call(&pack, &data, "storage.write", json!({ "path": "notes/a.txt", "text": "hi" }), &mut opened).0, 200);
    assert_eq!(call(&pack, &data, "storage.append", json!({ "path": "notes/a.txt", "text": "+1" }), &mut opened).0, 200);
    let (_, v) = call(&pack, &data, "storage.read", json!({ "path": "notes/a.txt" }), &mut opened);
    assert_eq!(v["result"]["text"], json!("hi+1"));
    assert!(data.join("plugin-data").join("plugin.canary").join("notes").join("a.txt").is_file(), "under <data>/plugin-data/<id>/");
    let (_, v) = call(&pack, &data, "storage.stat", json!({ "path": "notes/a.txt" }), &mut opened);
    assert_eq!(v["result"]["bytes"], json!(4));
    let (_, v) = call(&pack, &data, "storage.list", json!({ "path": "notes" }), &mut opened);
    assert_eq!(v["result"]["entries"][0]["name"], json!("a.txt"));
    assert_eq!(call(&pack, &data, "storage.remove", json!({ "path": "notes/a.txt" }), &mut opened).0, 200);
    let (s, v) = call(&pack, &data, "storage.read", json!({ "path": "../plugin.other/x" }), &mut opened);
    assert_eq!((s, v["code"].clone()), (400, json!("path_escape")));
    let (s, v) = call(&pack, &data, "links.open", json!({ "key": "docs" }), &mut opened);
    assert_eq!(s, 200, "{v}");
    assert_eq!(opened, vec!["https://zumia.space/".to_string()]);
    let (s, v) = call(&pack, &data, "links.open", json!({ "key": "evil" }), &mut opened);
    assert_eq!((s, v["code"].clone()), (403, json!("link_unlisted")));
    let (s, v) = call(&pack, &data, "settings.get", json!({ "key": "aiKey" }), &mut opened);
    assert_eq!((s, v["code"].clone()), (404, json!("method_unknown")));
    let (s, v) = bridge_call(&pack, &data, b"{oops", &mut |_| Ok(()));
    assert_eq!((s, v["code"].clone()), (400, json!("bad_request")));
    assert_eq!(opened.len(), 1, "a refused link opens nothing");
}

#[test]
fn storage_needs_its_permission() {
    let dir = scratch("no-storage").join("plugin.canary");
    copy_dir(&fixtures().join("plugin.canary"), &dir);
    let mut pack = load_pack_dir(&dir, Some("plugin.canary")).unwrap();
    pack.storage = false;
    let data = scratch("no-storage-data");
    let (s, v) = call(&pack, &data, "storage.write", json!({ "path": "a.txt", "text": "x" }), &mut Vec::new());
    assert_eq!((s, v["code"].clone()), (403, json!("permission_denied")));
    assert!(!data.join("plugin-data").exists());
}

#[test]
fn the_avatar_is_served_only_with_the_permission() {
    let mut pack = load_pack_dir(&fixtures().join("plugin.canary"), Some("plugin.canary")).unwrap();
    let vrm = scratch("avatar").join("a.vrm");
    std::fs::write(&vrm, b"glTF").unwrap();
    assert_eq!(avatar_for(&pack, Some(&vrm)), None, "no avatar permission: 404");
    pack.avatar = true;
    assert_eq!(avatar_for(&pack, Some(&vrm)), Some(vrm.clone()));
    assert_eq!(avatar_for(&pack, None), None);
}

#[test]
fn file_responses_carry_the_pack_csp_and_a_mime_type() {
    assert!(PACK_CSP.contains("default-src 'self'") && PACK_CSP.contains("connect-src 'self'") && PACK_CSP.contains("frame-ancestors 'none'"));
    assert!(!PACK_CSP.contains("unsafe-eval"));
    assert_eq!(mime_for_path("ui/index.html"), "text/html; charset=utf-8");
    assert_eq!(mime_for_path("app.js"), "text/javascript; charset=utf-8");
    assert_eq!(mime_for_path("a/b.gltf"), "model/gltf+json");
    assert_eq!(mime_for_path("a/b.bin"), "application/octet-stream");
    assert_eq!(mime_for_path("t.jpg"), "image/jpeg");
}

#[test]
fn a_csp_violation_report_becomes_one_log_line_with_the_origin_only() {
    assert!(pack_csp("plugin.canary").ends_with("; report-uri /plugin.canary/__zumi/csp-report"));
    let body = br#"{"csp-report":{"blocked-uri":"https://example.com/a?token=x","effective-directive":"connect-src","document-uri":"http://zumipack.localhost/plugin.canary/ui/index.html"}}"#;
    assert_eq!(csp_report_line("plugin.canary", body), "refused csp connect-src pack=plugin.canary origin=https://example.com");
    assert_eq!(csp_report_line("plugin.canary", b"{oops"), "refused csp ? pack=plugin.canary origin=inline");
}
