// MKT phase 2 — the web-app pack host (ADR 2026-11-11-pack-system; FABLE-MARKET.md §1 "A, the smallest safe version").
//
// A `plugin` pack is static files shown in ONE locked guest webview per pack (guest.rs, partition `pack:<id>`, label
// `guest-pack-<n>`). Everything a pack can reach goes through this module, and every decision is made from the WEBVIEW
// LABEL (which pack this guest was opened for), never from anything the page sends:
//   * its own files, at `http://zumipack.localhost/<id>/<path>` (the `zumipack` custom protocol; wry maps a custom
//     scheme to `http://<scheme>.localhost` on Windows). A path must be listed in the pack's `zumi-pack.json` `files`, and
//     its bytes must still match the listed sha256 when served;
//   * the bridge, `POST /<id>/__zumi/bridge` with `{ method, args }`: host.info, storage.* (inside
//     `<data>/plugin-data/<id>/`), links.open (a key the manifest declares, opened by the OS browser). Nothing else;
//   * the avatar, `GET /<id>/__zumi/avatar.vrm`, only with `permissions.avatar: "read"` (the pack never carries one).
// Anything else a pack guest requests is refused by its request filter (`pack_request_blocks`): no network, no loopback,
// no app host, no other pack. Every refusal writes one line to `<data>/logs/pack-host.log` (code + pack id; a blocked
// request's origin only, never its path or query).
//
// Loading: a store-installed pack (`<data>/packs/<id>/`) must be listed, not withdrawn, in the cached signed store index
// (`<data>/market/index.json` + `.minisig`, verified here against the compiled store keys), with the listed manifest sha256;
// then every file is re-hashed against the manifest (`load_pack_dir`). The owner flavour's `--pack-dir <folder>` loads one
// unpacked pack without the index (the owner's dev loop); its files are still re-hashed.
use std::collections::BTreeMap;
use std::io::Write as _;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

/// The custom protocol and the origin it has inside WebView2 on Windows.
pub const SCHEME: &str = "zumipack";
pub const ORIGIN: &str = "http://zumipack.localhost";
/// The highest (and lowest) `plugin.api` this host speaks.
pub const PLUGIN_API: i64 = 1;
/// The CSP every pack HTML page is served with. `connect-src 'self'`: a page fetches its own files (a 3D room loads its
/// textures and models that way); the network wall is the request filter, CSP is the second layer.
pub const PACK_CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; \
media-src 'self' blob:; connect-src 'self' data: blob:; worker-src 'self' blob:; font-src 'self'; object-src 'none'; base-uri 'none'; \
form-action 'none'; frame-ancestors 'none'";
/// The two store public keys compiled in (active + offline spare). Copies of tauri/market-keys/*.pub.
const STORE_KEYS: [&str; 2] = [include_str!("../../market-keys/store.pub"), include_str!("../../market-keys/spare.pub")];
/// Largest single storage file a pack may write or read through the bridge.
const MAX_STORAGE_FILE: u64 = 8 * 1024 * 1024;
/// Largest bridge request body.
const MAX_BRIDGE_BODY: usize = 9 * 1024 * 1024;
/// Largest pack file served in one response (a pack is at most 50 MB, a single file far less).
const MAX_SERVED_FILE: u64 = 64 * 1024 * 1024;
const NATIVE_EXT: [&str; 8] = ["mjs", "cjs", "node", "dll", "exe", "pyd", "py", "wasm"];
const RESERVED: [&str; 22] = [
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9", "lpt1", "lpt2", "lpt3",
    "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

pub fn compiled_store_keys() -> Vec<String> {
    STORE_KEYS.iter().map(|k| k.to_string()).collect()
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// One loaded, verified pack.
#[derive(Debug, Clone)]
pub struct LoadedPack {
    pub id: String,
    pub version: String,
    pub root: PathBuf,
    pub ui: String,
    pub tab_label_en: String,
    pub storage: bool,
    pub avatar: bool,
    pub links: BTreeMap<String, String>,
    /// path -> (sha256, bytes), from the manifest.
    pub files: BTreeMap<String, (String, u64)>,
    /// Loaded from `--pack-dir` (owner dev loop), not from the store.
    pub dev: bool,
}

/// `pack:<id>` -> the pack id, when the id is a well-formed plugin pack id.
pub fn partition_pack_id(partition: &str) -> Option<&str> {
    let id = partition.strip_prefix("pack:")?;
    is_plugin_id(id).then_some(id)
}

fn is_plugin_id(id: &str) -> bool {
    let Some(name) = id.strip_prefix("plugin.") else { return false };
    (2..=49).contains(&name.len())
        && name.chars().next().is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// `/<id>/<rest>` -> (id, rest). `rest` may be empty.
pub fn split_pack_path(path: &str) -> Option<(&str, &str)> {
    let p = path.strip_prefix('/')?;
    let (id, rest) = match p.find('/') {
        Some(i) => (&p[..i], &p[i + 1..]),
        None => (p, ""),
    };
    (!id.is_empty()).then_some((id, rest))
}

/// The prefix every request of this pack's guest must start with.
pub fn pack_origin_prefix(id: &str) -> String {
    format!("{ORIGIN}/{id}/")
}

/// The pack guest's request rule: `true` = refuse. Only its own prefix and the non-network schemes (data:, blob:,
/// about:) pass. An unparsable URI is refused (unlike the board guest rule): a pack has nothing to reach but itself.
pub fn pack_request_blocks(uri: &str, own_prefix: &str) -> bool {
    let Ok(url) = tauri::Url::parse(uri) else { return true };
    if !crate::guest_guard::is_network_scheme(url.scheme()) {
        return false;
    }
    !uri.starts_with(own_prefix)
}

/// A relative path inside a pack's storage folder, as its components. Refuses anything that could leave the folder or
/// name a device: `..`, `.`, empty parts, absolute or drive paths, backslashes, colons, Windows reserved names.
pub fn safe_rel(path: &str) -> Result<Vec<String>, &'static str> {
    if path.is_empty() || path.len() > 256 || path.contains('\\') || path.contains(':') || path.contains('\0') {
        return Err("path_escape");
    }
    let mut parts = Vec::new();
    for part in path.split('/') {
        let stem = part.split('.').next().unwrap_or("").to_ascii_lowercase();
        if part.is_empty() || part == "." || part == ".." || RESERVED.contains(&stem.as_str()) || part.ends_with('.') || part.ends_with(' ') {
            return Err("path_escape");
        }
        parts.push(part.to_string());
    }
    Ok(parts)
}

/// Verify an index against trusted minisign public keys (file text). `Err("index_signature")` on any failure.
pub fn verify_index_sig(index: &[u8], sig: &str, keys: &[&str]) -> Result<(), &'static str> {
    let signature = minisign_verify::Signature::decode(sig).map_err(|_| "index_signature")?;
    for key in keys {
        let Some(line) = key.trim().lines().filter(|l| !l.starts_with("untrusted comment:")).last() else { continue };
        let Ok(pk) = minisign_verify::PublicKey::from_base64(line.trim()) else { continue };
        if pk.verify(index, &signature, false).is_ok() {
            return Ok(());
        }
    }
    Err("index_signature")
}

/// May this installed version load? Same rule as market-store.mjs `loadVerdict`.
pub fn store_verdict(index: &Value, id: &str, version: &str, manifest_sha: &str) -> Result<(), &'static str> {
    if index.get("format").and_then(Value::as_str) != Some("zumi-market/1") {
        return Err("index_format");
    }
    let pack = index
        .get("packs")
        .and_then(Value::as_array)
        .and_then(|packs| packs.iter().find(|p| p.get("id").and_then(Value::as_str) == Some(id)))
        .ok_or("pack_not_listed")?;
    let withdrawn = pack.get("withdrawn").and_then(Value::as_array).is_some_and(|w| w.iter().any(|v| v.as_str() == Some(version)));
    if withdrawn {
        return Err("pack_withdrawn");
    }
    let listed = pack
        .get("versions")
        .and_then(Value::as_array)
        .and_then(|vs| vs.iter().find(|v| v.get("version").and_then(Value::as_str) == Some(version)))
        .ok_or("pack_not_listed")?;
    if listed.get("api").and_then(Value::as_i64) != Some(PLUGIN_API) {
        return Err("pack_needs_newer_host");
    }
    if listed.get("manifestSha256").and_then(Value::as_str) != Some(manifest_sha) {
        return Err("manifest_mismatch");
    }
    Ok(())
}

fn walk(dir: &Path, base: &str, out: &mut Vec<String>) -> Result<(), &'static str> {
    let entries = std::fs::read_dir(dir).map_err(|_| "pack_unreadable")?;
    for e in entries {
        let e = e.map_err(|_| "pack_unreadable")?;
        let name = e.file_name().to_string_lossy().into_owned();
        let rel = if base.is_empty() { name.clone() } else { format!("{base}/{name}") };
        let ft = e.file_type().map_err(|_| "pack_unreadable")?;
        if ft.is_symlink() {
            return Err("pack_symlink");
        } else if ft.is_dir() {
            walk(&e.path(), &rel, out)?;
        } else if ft.is_file() {
            out.push(rel);
        } else {
            return Err("pack_symlink");
        }
    }
    Ok(())
}

fn file_at(root: &Path, rel: &str) -> PathBuf {
    rel.split('/').fold(root.to_path_buf(), |p, part| p.join(part))
}

/// Read and check an unpacked plugin pack: manifest shape, id, api, permissions, and EVERY file against its listed
/// sha256 and bytes (one changed byte = no load). Error codes match the JS standard where they overlap.
pub fn load_pack_dir(root: &Path, expect_id: Option<&str>) -> Result<LoadedPack, String> {
    let manifest_bytes = std::fs::read(root.join("zumi-pack.json")).map_err(|_| "manifest_missing".to_string())?;
    let m: Value = serde_json::from_slice(&manifest_bytes).map_err(|_| "manifest_json".to_string())?;
    let s = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
    if s(&m, "format").as_deref() != Some("zumi-pack/1") {
        return Err("manifest_format".into());
    }
    if s(&m, "kind").as_deref() != Some("plugin") {
        return Err("manifest_kind".into());
    }
    let id = s(&m, "id").ok_or("manifest_id")?;
    if !is_plugin_id(&id) || expect_id.is_some_and(|want| want != id) || root.file_name().and_then(|n| n.to_str()) != Some(id.as_str()) {
        return Err("manifest_id".into());
    }
    let version = s(&m, "version").ok_or("manifest_version")?;
    let p = m.get("plugin").ok_or("plugin_section")?;
    match p.get("api").and_then(Value::as_i64) {
        Some(api) if api > PLUGIN_API => return Err("pack_needs_newer_host".into()),
        Some(api) if api < PLUGIN_API => return Err("pack_api_retired".into()),
        Some(_) => {}
        None => return Err("manifest_api".into()),
    }
    let ui = s(p, "ui").filter(|u| u.ends_with(".html")).ok_or("plugin_ui")?;
    let label = p.get("tab").and_then(|t| t.get("label")).ok_or("plugin_tab")?;
    let tab_label_en = s(label, "en").filter(|l| !l.trim().is_empty() && l.chars().count() <= 24).ok_or("plugin_tab")?;
    let perms = p.get("permissions").cloned().unwrap_or(json!({}));
    let perms = perms.as_object().ok_or("plugin_permissions")?.clone();
    let mut storage = false;
    let mut avatar = false;
    let mut links = BTreeMap::new();
    for (k, v) in &perms {
        match (k.as_str(), v) {
            ("storage", Value::Bool(b)) => storage = *b,
            ("avatar", Value::String(r)) if r == "read" => avatar = true,
            ("net", Value::Array(a)) if a.is_empty() => {}
            ("links", Value::Object(map)) => {
                for (key, url) in map {
                    let url = url.as_str().ok_or("plugin_link")?;
                    let parsed = tauri::Url::parse(url).map_err(|_| "plugin_link")?;
                    if parsed.scheme() != "https" {
                        return Err("plugin_link".into());
                    }
                    links.insert(key.clone(), url.to_string());
                }
            }
            _ => return Err("plugin_permission_unknown".into()),
        }
    }
    let mut files = BTreeMap::new();
    for f in m.get("files").and_then(Value::as_array).ok_or("files_missing")? {
        let path = s(f, "path").ok_or("files_entry")?;
        safe_rel(&path).map_err(|_| "files_entry")?;
        let sha = s(f, "sha256").ok_or("files_entry")?;
        let bytes = f.get("bytes").and_then(Value::as_u64).ok_or("files_entry")?;
        files.insert(path, (sha, bytes));
    }
    let mut on_disk = Vec::new();
    walk(root, "", &mut on_disk).map_err(str::to_string)?;
    for rel in &on_disk {
        if rel == "zumi-pack.json" {
            continue;
        }
        if !files.contains_key(rel) {
            return Err("files_unlisted".into());
        }
        let ext = rel.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
        if NATIVE_EXT.contains(&ext.as_str()) {
            return Err("plugin_native".into());
        }
    }
    for (rel, (sha, bytes)) in &files {
        let data = std::fs::read(file_at(root, rel)).map_err(|_| "files_absent")?;
        if data.len() as u64 != *bytes {
            return Err("files_bytes".into());
        }
        if &sha256_hex(&data) != sha {
            return Err("files_sha".into());
        }
    }
    if !files.contains_key(&ui) {
        return Err("plugin_ui".into());
    }
    Ok(LoadedPack { id, version, root: root.to_path_buf(), ui, tab_label_en, storage, avatar, links, files, dev: false })
}

/// The cached store index's verdict for a store-installed pack (signature by a compiled key, then `store_verdict`).
pub fn store_check(data_dir: &Path, pack_root: &Path, id: &str, version: &str) -> Result<(), &'static str> {
    let market = data_dir.join("market");
    let index = std::fs::read(market.join("index.json")).map_err(|_| "index_missing")?;
    let sig = std::fs::read_to_string(market.join("index.json.minisig")).map_err(|_| "index_missing")?;
    let keys = compiled_store_keys();
    let refs: Vec<&str> = keys.iter().map(String::as_str).collect();
    verify_index_sig(&index, &sig, &refs)?;
    let parsed: Value = serde_json::from_slice(&index).map_err(|_| "index_format")?;
    let manifest = std::fs::read(pack_root.join("zumi-pack.json")).map_err(|_| "manifest_missing")?;
    store_verdict(&parsed, id, version, &sha256_hex(&manifest))
}

fn ok(result: Value) -> (u16, Value) {
    (200, json!({ "ok": true, "result": result }))
}

fn refuse(status: u16, code: &str, message: &str) -> (u16, Value) {
    (status, json!({ "ok": false, "code": code, "message": message }))
}

fn arg_str<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str)
}

/// Resolve a storage path under `<data>/plugin-data/<id>/`, refusing a link anywhere on the way.
fn storage_path(pack: &LoadedPack, data_dir: &Path, rel: &str) -> Result<PathBuf, &'static str> {
    let parts = safe_rel(rel)?;
    let mut p = data_dir.join("plugin-data").join(&pack.id);
    for part in parts {
        p = p.join(part);
        if let Ok(meta) = std::fs::symlink_metadata(&p) {
            if meta.file_type().is_symlink() {
                return Err("path_escape");
            }
        }
    }
    Ok(p)
}

/// One bridge call. `open_link` opens an https URL (the OS browser in the app; a recorder in tests).
pub fn bridge_call(pack: &LoadedPack, data_dir: &Path, body: &[u8], open_link: &mut dyn FnMut(&str) -> Result<(), String>) -> (u16, Value) {
    if body.len() > MAX_BRIDGE_BODY {
        return refuse(413, "too_large", "the request is too large");
    }
    let Ok(req) = serde_json::from_slice::<Value>(body) else { return refuse(400, "bad_request", "the body is not JSON") };
    let method = req.get("method").and_then(Value::as_str).unwrap_or("");
    let args = req.get("args").cloned().unwrap_or(json!({}));
    if method.starts_with("storage.") && !pack.storage {
        return refuse(403, "permission_denied", "this pack has no storage permission");
    }
    match method {
        "host.info" => ok(json!({ "api": PLUGIN_API, "pack": pack.id, "version": pack.version })),
        "links.open" => {
            let key = arg_str(&args, "key").unwrap_or("");
            match pack.links.get(key) {
                Some(url) => match open_link(url) {
                    Ok(()) => ok(json!(true)),
                    Err(_) => refuse(500, "link_failed", "the link could not be opened"),
                },
                None => refuse(403, "link_unlisted", "that link is not declared in the pack's manifest"),
            }
        }
        "storage.read" | "storage.write" | "storage.append" | "storage.stat" | "storage.list" | "storage.remove" => {
            let Some(rel) = arg_str(&args, "path") else { return refuse(400, "bad_request", "args.path is required") };
            let path = match storage_path(pack, data_dir, rel) {
                Ok(p) => p,
                Err(code) => return refuse(400, code, "the path must stay inside the pack's own folder"),
            };
            storage_op(method, &path, &args)
        }
        _ => refuse(404, "method_unknown", "not a bridge method"),
    }
}

fn storage_op(method: &str, path: &Path, args: &Value) -> (u16, Value) {
    let io = |e: std::io::Error| match e.kind() {
        std::io::ErrorKind::NotFound => refuse(404, "not_found", "no such file"),
        _ => refuse(500, "io_error", "the file could not be read or written"),
    };
    match method {
        "storage.read" => match std::fs::metadata(path) {
            Ok(meta) if meta.is_file() && meta.len() <= MAX_STORAGE_FILE => match std::fs::read(path) {
                Ok(bytes) => match String::from_utf8(bytes) {
                    Ok(text) => ok(json!({ "text": text })),
                    Err(_) => refuse(415, "not_text", "the file is not UTF-8 text"),
                },
                Err(e) => io(e),
            },
            Ok(meta) if meta.is_file() => refuse(413, "too_large", "the file is over the bridge limit"),
            Ok(_) => refuse(404, "not_found", "no such file"),
            Err(e) => io(e),
        },
        "storage.write" | "storage.append" => {
            let Some(text) = args.get("text").and_then(Value::as_str) else { return refuse(400, "bad_request", "args.text is required") };
            if text.len() as u64 > MAX_STORAGE_FILE {
                return refuse(413, "too_large", "the text is over the bridge limit");
            }
            if let Some(parent) = path.parent() {
                if let Err(e) = std::fs::create_dir_all(parent) {
                    return io(e);
                }
            }
            if method == "storage.append" {
                let current = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
                if current + text.len() as u64 > MAX_STORAGE_FILE {
                    return refuse(413, "too_large", "the file would pass the bridge limit");
                }
                let r = std::fs::OpenOptions::new().create(true).append(true).open(path).and_then(|mut f| f.write_all(text.as_bytes()));
                return match r { Ok(()) => ok(json!(true)), Err(e) => io(e) };
            }
            // Atomic write: a temp sibling, then one rename.
            let tmp = path.with_extension("zumi-tmp");
            let r = std::fs::write(&tmp, text.as_bytes()).and_then(|()| std::fs::rename(&tmp, path));
            match r { Ok(()) => ok(json!(true)), Err(e) => { let _ = std::fs::remove_file(&tmp); io(e) } }
        }
        "storage.stat" => match std::fs::metadata(path) {
            Ok(meta) => {
                let modified = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64);
                ok(json!({ "bytes": meta.len(), "dir": meta.is_dir(), "modified": modified }))
            }
            Err(e) => io(e),
        },
        "storage.list" => match std::fs::read_dir(path) {
            Ok(rd) => {
                let mut entries: Vec<Value> = rd
                    .filter_map(Result::ok)
                    .filter(|e| e.file_type().map(|t| !t.is_symlink()).unwrap_or(false))
                    .map(|e| {
                        let meta = e.metadata().ok();
                        json!({ "name": e.file_name().to_string_lossy(), "dir": meta.as_ref().is_some_and(|m| m.is_dir()), "bytes": meta.map(|m| m.len()).unwrap_or(0) })
                    })
                    .collect();
                entries.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
                ok(json!({ "entries": entries }))
            }
            Err(e) => io(e),
        },
        "storage.remove" => match std::fs::remove_file(path) {
            Ok(()) => ok(json!(true)),
            Err(e) => io(e),
        },
        _ => refuse(404, "method_unknown", "not a bridge method"),
    }
}

/// The avatar a pack may read: only with the permission, only a regular file.
pub fn avatar_for(pack: &LoadedPack, current: Option<&Path>) -> Option<PathBuf> {
    if !pack.avatar {
        return None;
    }
    let path = current?;
    let meta = std::fs::symlink_metadata(path).ok()?;
    meta.file_type().is_file().then(|| path.to_path_buf())
}

pub fn mime_for_path(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("").to_ascii_lowercase().as_str() {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "txt" | "md" => "text/plain; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "woff2" => "font/woff2",
        "gltf" => "model/gltf+json",
        "glb" | "vrm" => "model/gltf-binary",
        "ktx2" => "image/ktx2",
        _ => "application/octet-stream",
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Runtime state and the wiring (needs an AppHandle; exercised by the canary run, not by unit tests).

/// Managed state: where packs live, the owner's dev folder, and which guest label is which loaded pack.
#[derive(Default)]
pub struct PackState {
    pub data_dir: Mutex<Option<PathBuf>>,
    pub dev_dir: Mutex<Option<PathBuf>>,
    pub links_dry: std::sync::atomic::AtomicBool,
    by_label: Mutex<BTreeMap<String, Arc<LoadedPack>>>,
}

impl PackState {
    pub fn bind(&self, label: &str, pack: Arc<LoadedPack>) {
        self.by_label.lock().unwrap().insert(label.to_string(), pack);
    }
    pub fn unbind(&self, label: &str) {
        self.by_label.lock().unwrap().remove(label);
    }
    pub fn pack_for(&self, label: &str) -> Option<Arc<LoadedPack>> {
        self.by_label.lock().unwrap().get(label).cloned()
    }
    fn data_dir(&self) -> Option<PathBuf> {
        self.data_dir.lock().unwrap().clone()
    }
}

/// One line in `<data>/logs/pack-host.log` (and stderr). Never a path, query or storage content.
pub fn log_line(data_dir: Option<&Path>, line: &str) {
    // The request filter and the protocol handler log from different threads: one lock, one write per line.
    static LOG: Mutex<()> = Mutex::new(());
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let text = format!("{stamp} {line}\n");
    eprint!("pack: {text}");
    if let Some(dir) = data_dir {
        let _held = LOG.lock().unwrap_or_else(|e| e.into_inner());
        let logs = dir.join("logs");
        let _ = std::fs::create_dir_all(&logs);
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(logs.join("pack-host.log")) {
            let _ = f.write_all(text.as_bytes());
        }
    }
}

/// The CSP of one pack's pages: PACK_CSP plus a report endpoint on the pack's own path, so a request the page's CSP
/// stops before it reaches the request filter (a fetch to another origin) still leaves a line in pack-host.log.
pub fn pack_csp(id: &str) -> String {
    format!("{PACK_CSP}; report-uri /{id}/__zumi/csp-report")
}

/// One CSP violation report -> one log line: the directive and the blocked origin only (never a path or query).
pub fn csp_report_line(id: &str, body: &[u8]) -> String {
    let report = serde_json::from_slice::<Value>(body).ok();
    let r = report.as_ref().and_then(|v| v.get("csp-report"));
    let directive: String = r.and_then(|r| r.get("effective-directive").or_else(|| r.get("violated-directive"))).and_then(Value::as_str).unwrap_or("?")
        .chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(40).collect();
    let directive = if directive.is_empty() { "?".to_string() } else { directive };
    let blocked = r.and_then(|r| r.get("blocked-uri")).and_then(Value::as_str).unwrap_or("");
    let origin = tauri::Url::parse(blocked).ok().map(|u| format!("{}://{}", u.scheme(), u.host_str().unwrap_or(""))).unwrap_or_else(|| "inline".to_string());
    format!("refused csp {directive} pack={id} origin={origin}")
}

/// Where one pack id lives: the dev folder (owner `--pack-dir`) when it holds that id, else `<data>/packs/<id>`.
fn locate(state: &PackState, id: &str) -> Option<(PathBuf, bool)> {
    if let Some(dev) = state.dev_dir.lock().unwrap().clone() {
        if dev.file_name().and_then(|n| n.to_str()) == Some(id) {
            return Some((dev, true));
        }
    }
    let dir = state.data_dir()?.join("packs").join(id);
    dir.join("zumi-pack.json").is_file().then_some((dir, false))
}

/// Full load for a tab open: store verdict (store packs) + every file re-hashed.
pub fn open_pack(state: &PackState, id: &str) -> Result<Arc<LoadedPack>, String> {
    let (root, dev) = locate(state, id).ok_or("pack_not_installed")?;
    let mut pack = load_pack_dir(&root, Some(id))?;
    if !dev {
        let data = state.data_dir().ok_or("no_data_dir")?;
        store_check(&data, &root, id, &pack.version).map_err(str::to_string)?;
    }
    pack.dev = dev;
    Ok(Arc::new(pack))
}

/// The plugin packs to show as tabs: installed (manifest + store verdict, no file hashing: that is done at open).
pub fn list_tabs(state: &PackState) -> Vec<Value> {
    let mut ids: Vec<String> = Vec::new();
    if let Some(dev) = state.dev_dir.lock().unwrap().clone() {
        if let Some(name) = dev.file_name().and_then(|n| n.to_str()) {
            ids.push(name.to_string());
        }
    }
    if let Some(data) = state.data_dir() {
        if let Ok(rd) = std::fs::read_dir(data.join("packs")) {
            for e in rd.filter_map(Result::ok) {
                let name = e.file_name().to_string_lossy().into_owned();
                if is_plugin_id(&name) && !ids.contains(&name) {
                    ids.push(name);
                }
            }
        }
    }
    let mut tabs = Vec::new();
    for id in ids {
        let Some((root, dev)) = locate(state, &id) else { continue };
        let Ok(bytes) = std::fs::read(root.join("zumi-pack.json")) else { continue };
        let Ok(m) = serde_json::from_slice::<Value>(&bytes) else { continue };
        let version = m.get("version").and_then(Value::as_str).unwrap_or("").to_string();
        if !dev {
            let Some(data) = state.data_dir() else { continue };
            if let Err(code) = store_check(&data, &root, &id, &version) {
                log_line(Some(&data), &format!("refused {code} pack={id} (not listed as a tab)"));
                continue;
            }
        }
        let p = &m["plugin"];
        let ui = p.get("ui").and_then(Value::as_str).unwrap_or("");
        tabs.push(json!({
            "id": id, "version": version, "dev": dev,
            "label": p.get("tab").and_then(|t| t.get("label")).cloned().unwrap_or(json!({ "en": id })),
            "src": format!("{}{}", pack_origin_prefix(&id), ui),
            "partition": format!("pack:{id}"),
        }));
    }
    tabs
}

fn respond(status: u16, content_type: &str, body: Vec<u8>, csp: Option<&str>) -> tauri::http::Response<Vec<u8>> {
    let mut b = tauri::http::Response::builder()
        .status(status)
        .header("Content-Type", content_type)
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "no-store");
    if let Some(id) = csp {
        b = b.header("Content-Security-Policy", pack_csp(id));
    }
    b.body(body).unwrap_or_else(|_| tauri::http::Response::new(Vec::new()))
}

fn json_response((status, body): (u16, Value)) -> tauri::http::Response<Vec<u8>> {
    respond(status, "application/json", serde_json::to_vec(&body).unwrap_or_default(), None)
}

fn not_found() -> tauri::http::Response<Vec<u8>> {
    respond(404, "text/plain; charset=utf-8", Vec::new(), None)
}

/// Answer one `zumipack://` request. `label` is the requesting webview's label (from Tauri, never from the page).
/// `avatar` is the avatar the app currently shows; `open_link` opens a declared https link.
pub fn handle_request(
    state: &PackState,
    label: &str,
    request: &tauri::http::Request<Vec<u8>>,
    avatar: &dyn Fn() -> Option<PathBuf>,
    open_link: &mut dyn FnMut(&str) -> Result<(), String>,
) -> tauri::http::Response<Vec<u8>> {
    let data = state.data_dir();
    let Some(pack) = state.pack_for(label) else {
        log_line(data.as_deref(), "refused not_a_pack_webview");
        return not_found();
    };
    let path = request.uri().path().to_string();
    let Some((id, rest)) = split_pack_path(&path) else { return not_found() };
    if id != pack.id {
        log_line(data.as_deref(), &format!("refused other_pack pack={}", pack.id));
        return not_found();
    }
    match rest {
        "__zumi/bridge" => {
            if request.method() != tauri::http::Method::POST {
                return json_response(refuse(405, "bad_request", "the bridge takes POST"));
            }
            let Some(data_dir) = data.clone() else { return json_response(refuse(500, "no_data_dir", "no data folder")) };
            let method = serde_json::from_slice::<Value>(request.body()).ok().and_then(|v| v.get("method").and_then(Value::as_str).map(str::to_string)).unwrap_or_default();
            let (status, body) = bridge_call(&pack, &data_dir, request.body(), open_link);
            if status >= 400 {
                let code = body.get("code").and_then(Value::as_str).unwrap_or("?");
                // The method name is from a fixed set or refused as unknown; it is clipped so a page cannot write the log.
                let method: String = method.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '.').take(40).collect();
                log_line(data.as_deref(), &format!("refused {code} pack={} method={method}", pack.id));
            }
            json_response((status, body))
        }
        "__zumi/csp-report" => {
            log_line(data.as_deref(), &csp_report_line(&pack.id, request.body()));
            respond(204, "text/plain; charset=utf-8", Vec::new(), None)
        }
        "__zumi/avatar.vrm" => match avatar_for(&pack, avatar().as_deref()).and_then(|p| std::fs::read(p).ok()) {
            Some(bytes) => respond(200, "model/gltf-binary", bytes, None),
            None => {
                log_line(data.as_deref(), &format!("refused avatar pack={}{}", pack.id, if pack.avatar { " (no avatar file)" } else { " (no avatar permission)" }));
                not_found()
            }
        },
        rel => {
            let rel = percent_decode(rel);
            let Some((sha, bytes)) = pack.files.get(&rel) else {
                if !rel.is_empty() {
                    log_line(data.as_deref(), &format!("refused unlisted_file pack={}", pack.id));
                }
                return not_found();
            };
            if *bytes > MAX_SERVED_FILE {
                return not_found();
            }
            match std::fs::read(file_at(&pack.root, &rel)) {
                Ok(content) if &sha256_hex(&content) == sha => {
                    let mime = mime_for_path(&rel);
                    respond(200, mime, content, mime.starts_with("text/html").then_some(pack.id.as_str()))
                }
                _ => {
                    // Changed on disk after the tab opened: refuse it, and every later request, until the tab reopens.
                    log_line(data.as_deref(), &format!("refused files_sha pack={} (switched off)", pack.id));
                    state.unbind(label);
                    not_found()
                }
            }
        }
    }
}

/// `%XX` decoding for pack file paths (a pack's own file names may hold spaces). Invalid escapes stay as they are.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_default()
}

/// The avatar the app shows now: the user's own model when settings.json names a plain local file, else the bundled
/// default. Rust's own read (never a path from a page or the sidecar).
pub fn current_avatar(data_dir: Option<&Path>, resource_dir: Option<&Path>) -> Option<PathBuf> {
    let user = data_dir
        .and_then(|d| std::fs::read(d.join("settings.json")).ok())
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|s| s.get("userModelPath").and_then(Value::as_str).and_then(crate::asset_route::plain_absolute));
    if let Some(p) = user.filter(|p| p.is_file()) {
        return Some(p);
    }
    resource_dir.map(|r| r.join("assets").join("models").join("zumi-default-0910.vrm")).filter(|p| p.is_file())
}

/// `pack_list()` — the plugin packs the tab bar shows. Main webview only (the ACL grants it to main alone, and the body
/// checks again).
#[tauri::command]
pub async fn pack_list(caller: tauri::Webview, state: tauri::State<'_, PackState>) -> Result<Value, String> {
    if !crate::guest::is_main(&caller) {
        return Err("guest_not_main".to_string());
    }
    Ok(Value::Array(list_tabs(&state)))
}

/// Is `p` a plain directory path we accept for `--pack-dir` (absolute, no `..`)?
pub fn plain_dir(p: &Path) -> bool {
    p.is_absolute() && p.components().all(|c| !matches!(c, Component::ParentDir)) && p.is_dir()
}
