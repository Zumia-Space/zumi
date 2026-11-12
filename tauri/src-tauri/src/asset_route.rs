// T-31 parity step 4b-1 — the asset route for imported / external files.
//
// The main webview fetches a handful of files that are NOT in the bundled `frontendDist`: the user-picked avatar
// (`external/user.vrm`, Electron's `externalPaths().user`), an imported room's own files
// (`rooms/<12-hex>/(room.glb|check.json|room.json)`), and the optional video room (`scenes/<id>.mp4`, `scenes/chair`).
// Electron answers these from `src/main/main.js`'s `app://` protocol handler; here the Rust host answers them through
// `on_web_resource_request`, which Tauri runs on the built asset response for every `tauri.localhost` request.
//
// Two halves, on purpose:
//   1. The SIDECAR owns the settings that decide what exists (`__host.resolveAsset(rel)` -> `{ path, root }` | null,
//      boot-reads.mjs: models-core externalPaths, settings.importedRooms, sceneRooms.resolvePath). The renderer never
//      names a path: it names one of the four fixed route shapes.
//   2. RUST re-checks the answer, independently of what the sidecar said:
//        * `external/user.vrm` must equal settings.json's `userModelPath`, be a plain local absolute path, and be a
//          regular file (lstat: a symlink or junction named `*.vrm` is NOT one);
//        * `rooms/<id>/<name>` must be `<app data>/rooms/<id>/<name>` after realpath, with `<id>` listed in
//          settings.json's `importedRooms` — a file planted in the store for an unlisted id is never served;
//        * `scenes/*` must be a direct child of a root RUST derives itself — `<resources>/assets/rooms-video` for the
//          chair plate, `ZUMI_ROOMS_VIDEO_DIR` or the packaged `<resources>/rooms-video` (derived here, not taken from the answer) for a video — after realpath, and be
//          a regular file. A sidecar answer naming a foreign root therefore never widens what is served.
//      A refused or failed answer is a bare 404: it never falls through to Tauri's SPA fallback (index.html, 200).
//
// Closed by default: only the exact shapes below are touched; every other path is left to Tauri. Percent-encoding is
// never decoded here, so `%2e%2e` / `%2f` are refused by the route check instead of being resolved. UNC (`\\host`) and
// verbatim (`\\?\`) answers are refused before the filesystem is touched. A request is answered only for the main
// webview: guests install `guest_guard::deny_app_asset` instead (guest.rs) and never reach this module — parity 4b-2
// makes a guest's request for one of these namespaces a bare 404 (`guest_guard::deny_guest_asset`), the same shape as a
// refusal here, so a guest cannot even learn that a path is special.
//
// Ranges (RFC 7233, one range only): no `Range` header = 200 with the WHOLE file; `bytes=a-b`, `bytes=a-`,
// `bytes=-N` = 206 with `Content-Range`; an unsatisfiable start = 416 with `Content-Range: bytes */len`. A MULTI-RANGE
// request (`bytes=0-1,3-4`) is REFUSED with 416 — this route never concatenates parts. A malformed `Range` value is
// ignored (200), which is RFC 7233's own rule for a value the server cannot parse. A RANGE body is capped at MAX_BODY
// (8 MiB) and `Content-Range` names the served end, so a video's `bytes=0-` still gets the next slice; a FULL body is
// never truncated — a file above MAX_FULL_BODY (256 MiB) is refused with 413 and a log line. HEAD never reads the file.

use std::borrow::Cow;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::Value;
use tauri::http::{header, HeaderValue, Method, Request, Response, StatusCode};
use tauri::{AppHandle, Manager};

use crate::Rpc;

/// How long the sidecar has to answer `__host.resolveAsset`. It only stats files, so a sidecar that needs longer is
/// wedged: the route answers 404 (fail closed) instead of holding the request.
const RESOLVE_TIMEOUT: Duration = Duration::from_secs(2);
/// Bounds the relative path the host asks about (the longest real one is 20 chars).
const MAX_REL: usize = 256;
/// The three files an imported room's folder may serve (see boot-reads.mjs resolveAsset).
const ROOM_FILES: [&str; 3] = ["room.glb", "check.json", "room.json"];
/// Largest body one RANGE response buffers (8 MiB). A video element's first request is `bytes=0-`, i.e. "the whole rest of
/// the file": without a cap that reads a multi-GB scene into RAM. The `Content-Range` reports the shortened end, so the
/// client sees exactly what it got and asks for the next slice. A full (no Range) request is NOT capped this way, and HEAD
/// reads nothing at all.
const MAX_BODY: u64 = 8 * 1024 * 1024;
/// Largest file served whole by a non-range (200) response (256 MiB). A non-range request promises the whole file, so it
/// is never shortened: VRMs are tens of MB and must arrive complete (a truncated body fails the renderer's typed-array
/// decode). Above this ceiling the route answers 413 instead of a short 200; scenes are videos and use Range.
const MAX_FULL_BODY: u64 = 256 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Class {
    External,
    Room,
    Scene,
    /// T-31-ROOM-slim: a file a slim build no longer embeds in `frontendDist`, answered from disk (`fallback_file`).
    Fallback,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Route {
    pub class: Class,
    /// The relative path without its leading `/` (exactly what the sidecar is asked about).
    pub rel: String,
}

/// What a request path means to this module.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Routed {
    /// Not one of the asset namespaces: leave Tauri's own asset answer alone.
    Untouched,
    /// In a namespace but not a valid route: answer 404.
    Refuse,
    Serve(Route),
}

fn is_room_id(id: &str) -> bool {
    id.len() == 12 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// `scenes/<id>.mp4`: the slug scene-rooms.mjs accepts (lowercase alnum start, then lowercase alnum / `-`, <= 41).
fn is_scene_video(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".mp4") else { return false };
    let bytes = stem.as_bytes();
    let Some(first) = bytes.first() else { return false };
    bytes.len() <= 41
        && (first.is_ascii_lowercase() || first.is_ascii_digit())
        && bytes.iter().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

/// Classify one request path. Percent-decoding is NOT performed: any `%` is refused outright, as are `\`, control
/// bytes, empty / `.` / `..` segments and anything non-ASCII. A path outside the three namespaces is untouched.
pub(crate) fn route(path: &str) -> Routed {
    let Some(rel) = path.strip_prefix('/') else { return Routed::Untouched };
    let ns = rel.split('/').next().unwrap_or("");
    if !matches!(ns, "external" | "rooms" | "scenes") {
        return Routed::Untouched;
    }
    if rel.len() > MAX_REL {
        return Routed::Refuse;
    }
    if rel.bytes().any(|b| b >= 0x80 || b == b'%' || b == b'\\' || b < 0x20 || b == 0x7f) {
        return Routed::Refuse;
    }
    let segs: Vec<&str> = rel.split('/').collect();
    if segs.iter().any(|s| s.is_empty() || *s == "." || *s == "..") {
        return Routed::Refuse;
    }
    match ns {
        "external" => {
            if segs.len() == 2 && segs[1] == "user.vrm" {
                Routed::Serve(Route { class: Class::External, rel: rel.to_string() })
            } else {
                Routed::Refuse
            }
        }
        "rooms" => {
            // `rooms/default-v2/...` is the pinned room copied into `frontendDist` (tauri/prep-ui.mjs): a bundled
            // asset, so Tauri's own answer must stand. Everything else under rooms/ is this route's namespace.
            if segs.get(1) == Some(&"default-v2") {
                return Routed::Untouched;
            }
            // rooms/default/* (room v1 "Zumi's Office") is removed (owner, 2026-10-26): not a room id, so refused below.
            if segs.len() == 3 && is_room_id(segs[1]) && ROOM_FILES.contains(&segs[2]) {
                Routed::Serve(Route { class: Class::Room, rel: rel.to_string() })
            } else {
                Routed::Refuse
            }
        }
        _ => {
            if segs.len() == 2 && (segs[1] == "chair" || is_scene_video(segs[1])) {
                Routed::Serve(Route { class: Class::Scene, rel: rel.to_string() })
            } else {
                Routed::Refuse
            }
        }
    }
}

/// True when `path` belongs to one of the asset namespaces — served shape or refused shape. A guest webview asks the
/// same question and answers every such path with a bare 404 (guest_guard::deny_guest_asset): the route is main's
/// alone, and a guest learns nothing about whether an imported file exists.
pub(crate) fn is_asset_path(path: &str) -> bool {
    !matches!(route(path), Routed::Untouched)
}

/// The HTTP content type for a route. Only the four file kinds this route can ever carry (plus the chair plate).
pub(crate) fn mime_for(route: &Route) -> &'static str {
    if route.class == Class::Scene && route.rel == "scenes/chair" {
        return "image/png";
    }
    match route.rel.rsplit('.').next() {
        Some(ext) if ext.eq_ignore_ascii_case("png") => "image/png",
        Some(ext) if ext.eq_ignore_ascii_case("vrm") || ext.eq_ignore_ascii_case("glb") => "model/gltf-binary",
        Some(ext) if ext.eq_ignore_ascii_case("json") => "application/json",
        Some(ext) if ext.eq_ignore_ascii_case("mp4") => "video/mp4",
        _ => "application/octet-stream",
    }
}

/// A byte range resolved against a known file length.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Range {
    Full,
    Partial { start: u64, end: u64 },
    Unsatisfiable,
}

/// Parse one `Range` header value against `len`. Syntax the server cannot parse is ignored (Full, RFC 7233); a
/// syntactically valid range that cannot be satisfied is `Unsatisfiable`; more than one range is refused as
/// `Unsatisfiable` (this route serves a single contiguous slice only). `bytes=9-3` (end before start) is treated as
/// `Unsatisfiable` (416) rather than ignored as a malformed value (200): that is a DELIBERATE choice, recorded here as
/// the step 4b gate asks, because a renderer that sends a backwards range is buggy and a 416 is the honest answer.
pub(crate) fn range_for(value: Option<&str>, len: u64) -> Range {
    let Some(raw) = value else { return Range::Full };
    let Some(spec) = raw.trim().strip_prefix("bytes=") else { return Range::Full };
    let spec = spec.trim();
    if spec.contains(',') {
        return Range::Unsatisfiable;
    }
    let Some((first, second)) = spec.split_once('-') else { return Range::Full };
    let (first, second) = (first.trim(), second.trim());
    if first.is_empty() {
        let Ok(suffix) = second.parse::<u64>() else { return Range::Full };
        if suffix == 0 || len == 0 {
            return Range::Unsatisfiable;
        }
        let suffix = suffix.min(len);
        return Range::Partial { start: len - suffix, end: len - 1 };
    }
    let Ok(start) = first.parse::<u64>() else { return Range::Full };
    if start >= len {
        return Range::Unsatisfiable;
    }
    let end = if second.is_empty() {
        len - 1
    } else {
        match second.parse::<u64>() {
            Ok(end) => end.min(len - 1),
            Err(_) => return Range::Full,
        }
    };
    if end < start {
        return Range::Unsatisfiable;
    }
    Range::Partial { start, end }
}

/// The sidecar's answer: an absolute file path, plus the directory it must be a direct child of (None for the
/// external slot, which is checked against settings.userModelPath instead).
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Answer {
    pub path: String,
    pub root: Option<String>,
}

fn parse_answer(value: &Value) -> Option<Answer> {
    let path = value.get("path")?.as_str()?.to_string();
    let root = match value.get("root") {
        None | Some(Value::Null) => None,
        Some(root) => Some(root.as_str()?.to_string()),
    };
    Some(Answer { path, root })
}

/// A plain, local, absolute path. Refuses UNC (`\\host\share`) and verbatim (`\\?\C:`) prefixes, `..` segments and
/// NUL bytes before the filesystem sees them.
pub(crate) fn plain_absolute(raw: &str) -> Option<PathBuf> {
    if raw.is_empty() || raw.len() > 32_767 || raw.contains('\0') {
        return None;
    }
    if raw.starts_with("\\\\") || raw.starts_with("//") {
        return None;
    }
    let path = PathBuf::from(raw);
    if !path.is_absolute() {
        return None;
    }
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};
        match path.components().next() {
            Some(Component::Prefix(prefix)) => match prefix.kind() {
                Prefix::Disk(_) => {}
                _ => return None,
            },
            _ => return None,
        }
        if path.components().any(|c| matches!(c, Component::ParentDir)) {
            return None;
        }
    }
    Some(path)
}

/// A regular file as `lstat` sees it: a symlink or junction at this exact path is NOT one (the link itself is not a
/// regular file, and this check never follows it).
fn is_regular_file(path: &Path) -> bool {
    std::fs::symlink_metadata(path).map(|m| m.file_type().is_file()).unwrap_or(false)
}

/// True when `file`'s realpath is exactly `root`'s realpath joined with `expect` — one extra segment is refused. This
/// is what catches a junction at `<store>/<id>` (realpath leaves the store) and any link chain inside it.
fn real_child(root: &Path, file: &Path, expect: &Path) -> bool {
    let (Ok(root), Ok(file)) = (std::fs::canonicalize(root), std::fs::canonicalize(file)) else { return false };
    file.strip_prefix(root).map(|rel| rel == expect).unwrap_or(false)
}

/// The scenes manifest Electron's main process reads (`assets/rooms-video/rooms.json`, scene-rooms.mjs). It is the ONE
/// mapping from a route id to the file on disk, whose name is `NN-id.mp4`, not `<id>.mp4`. Rust reads it itself so an
/// id the manifest does not list can never be served, whatever the sidecar answered.
const SCENES_MANIFEST: &str = "rooms.json";

fn read_scenes_manifest(manifest_dir: &Path) -> Option<Value> {
    let bytes = std::fs::read(manifest_dir.join(SCENES_MANIFEST)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// A plain file name, the shape Electron's `/^[\w.-]+\.mp4$/i` (or `.png` for the chair) accepts and `path.join` can
/// only append as one segment: no separators, no `..`, no drive prefix, no NUL. The name still has to survive
/// `real_child`, so this is a shape check, not the containment check.
fn plain_manifest_name(name: &str, ext: &str) -> bool {
    if name.is_empty() || name.len() > 255 || name.contains('\0') {
        return false;
    }
    let Some((stem, got_ext)) = name.rsplit_once('.') else { return false };
    !stem.is_empty()
        && got_ext.eq_ignore_ascii_case(ext)
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
}

/// The file `manifest` names for room `id`, or the chair plate when `id` is None. Only a listed id gets an answer.
fn manifest_file(manifest: &Value, id: Option<&str>, ext: &str) -> Option<String> {
    let file = match id {
        Some(id) => manifest
            .get("rooms")?
            .as_array()?
            .iter()
            .find(|room| room.get("id").and_then(Value::as_str) == Some(id))?
            .get("file")?
            .as_str()?,
        None => manifest.get("chair")?.get("file")?.as_str()?,
    };
    plain_manifest_name(file, ext).then(|| file.to_string())
}

/// The two scene roots Rust derives itself (parity step 4b gate item 1). The sidecar's `answer.root` is ignored: a wrong
/// or compromised answer naming `{root: X, path: X/<slug>.mp4}` must not make any `.mp4` under `X` servable.
#[derive(Debug, Clone)]
pub(crate) struct SceneRoots {
    /// The scenes manifest's own folder (`<assets>/rooms-video`): the chair plate lives beside the manifest.
    pub chair_dir: PathBuf,
    /// The video folder: `ZUMI_ROOMS_VIDEO_DIR` (dev override) or the packaged `<resources>/rooms-video` an owner build ships
    /// (derived by Rust from its own resource dir, never from the sidecar). `None` = no video folder on this machine.
    pub video_dir: Option<PathBuf>,
}

/// The folder an owner build stages the room videos into (rooms.json `packagedDir`; pinned by a test).
const PACKAGED_VIDEO_DIR: &str = "rooms-video";

/// `env` (`ZUMI_ROOMS_VIDEO_DIR`) wins; else `<resource_dir>/rooms-video` when that folder exists (a public build stages none).
/// Which files inside it are servable is decided later, by the manifest mapping in `recheck`: only the names rooms.json lists.
fn video_dir_from(env: Option<std::ffi::OsString>, resource_dir: Option<&Path>) -> Option<PathBuf> {
    if let Some(dir) = env.filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(dir));
    }
    let packaged = resource_dir?.join(PACKAGED_VIDEO_DIR);
    packaged.is_dir().then_some(packaged)
}

/// The bundled assets root: the resource dir in a packaged app, the repo's `assets/` in a dev tree.
fn assets_root(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(dir) = app.path().resource_dir() {
        let packaged = dir.join("assets");
        if packaged.is_dir() {
            return Some(packaged);
        }
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("assets");
    dev.is_dir().then_some(dev)
}

/// Derive the scene roots from the host's own resource path and environment (never from the sidecar's answer).
pub(crate) fn scene_roots(app: &AppHandle) -> Option<SceneRoots> {
    let chair_dir = assets_root(app)?.join("rooms-video");
    let video_dir = video_dir_from(std::env::var_os("ZUMI_ROOMS_VIDEO_DIR"), app.path().resource_dir().ok().as_deref());
    Some(SceneRoots { chair_dir, video_dir })
}

fn read_settings(data_dir: &Path) -> Option<Value> {
    let bytes = std::fs::read(data_dir.join("settings.json")).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Rust's own read of the setting the external slot must match (never the sidecar's answer).
fn selected_user_model(data_dir: &Path) -> Option<PathBuf> {
    let settings = read_settings(data_dir)?;
    plain_absolute(settings.get("userModelPath")?.as_str()?)
}

/// Rust's own read of the room ids settings lists.
fn imported_room_ids(data_dir: &Path) -> Option<Vec<String>> {
    let settings = read_settings(data_dir)?;
    let rooms = settings.get("importedRooms")?.as_array()?;
    Some(rooms.iter().filter_map(|r| Some(r.get("id")?.as_str()?.to_string())).collect())
}

/// Re-check one sidecar answer against Rust's own view of the settings, the derived roots and the filesystem.
pub(crate) fn recheck(route: &Route, answer: &Answer, data_dir: &Path, roots: Option<&SceneRoots>) -> Option<PathBuf> {
    match route.class {
        Class::External => {
            if route.rel != "external/user.vrm" {
                return None;
            }
            let path = plain_absolute(&answer.path)?;
            if !path.extension().is_some_and(|e| e.eq_ignore_ascii_case("vrm")) {
                return None;
            }
            let selected = selected_user_model(data_dir)?;
            if path != selected || !is_regular_file(&path) {
                return None;
            }
            Some(path)
        }
        Class::Room => {
            let segs: Vec<&str> = route.rel.split('/').collect();
            if segs.len() != 3 {
                return None;
            }
            let (id, name) = (segs[1], segs[2]);
            if !ROOM_FILES.contains(&name) || !imported_room_ids(data_dir)?.iter().any(|listed| listed == id) {
                return None;
            }
            let path = plain_absolute(&answer.path)?;
            if !is_regular_file(&path) {
                return None;
            }
            let store = data_dir.join("rooms");
            if !real_child(&store, &path, &Path::new(id).join(name)) {
                return None;
            }
            Some(path)
        }
        Class::Scene => {
            let roots = roots?;
            let path = plain_absolute(&answer.path)?;
            if !is_regular_file(&path) {
                return None;
            }
            let name = route.rel.strip_prefix("scenes/")?;
            // Parity with src/main/scene-rooms.mjs resolvePath(): `chair` is the manifest's chair file, and a video is
            // the manifest entry whose ID equals the route stem. Electron joins `videoDir` with the ENTRY's file name
            // (`NN-id.mp4`); Rust does the same and then pins the answer to that exact child of its own root. The
            // sidecar's `answer.root` is deliberately not consulted.
            let manifest = read_scenes_manifest(&roots.chair_dir)?;
            if name == "chair" {
                let file = manifest_file(&manifest, None, "png")?;
                if !real_child(&roots.chair_dir, &path, Path::new(&file)) {
                    return None;
                }
            } else {
                let id = name.strip_suffix(".mp4")?;
                let file = manifest_file(&manifest, Some(id), "mp4")?;
                // The build's own folder, or (T-31-ROOM-slim) the room's installed pack `<data>/packs/room.<id>`: the same
                // manifest file name, pinned to one of two roots Rust derives itself. The sha256 pin is the sidecar's.
                let in_build = roots.video_dir.as_deref().is_some_and(|dir| real_child(dir, &path, Path::new(&file)));
                let in_pack = installed_pack_dir(data_dir, &format!("room.{id}"))
                    .is_some_and(|dir| real_child(&dir, &path, Path::new(&file)));
                if !in_build && !in_pack {
                    return None;
                }
            }
            Some(path)
        }
        Class::Fallback => None,
    }
}

/// `<data>/packs/<id>` when that pack is installed (its manifest is there) and no remove is pending. Same rule as
/// tauri/sidecar/room-packs.mjs `installedPackDir`.
fn installed_pack_dir(data_dir: &Path, id: &str) -> Option<PathBuf> {
    let packs = data_dir.join("packs");
    if packs.join(format!("{id}.remove-pending")).exists() {
        return None;
    }
    let dir = packs.join(id);
    is_regular_file(&dir.join("zumi-pack.json")).then_some(dir)
}

/// The painted default room's pack (room.night-city) and the one plate of it that room.json does not name.
const NIGHT_CITY_PACK: &str = "room.night-city";
const NO_CHAIR_PLATE: &str = "talk-plate-nochair.png";

/// A plain file name a room folder may serve: one segment, ASCII word characters, and a room file's extension.
fn plain_room_file(name: &str) -> bool {
    ["png", "json", "glb"].iter().any(|ext| plain_manifest_name(name, ext))
}

/// T-31-ROOM-slim: where a file the official build no longer embeds lives on disk, or None (the request stays Tauri's).
///   * `/rooms/default-v2/<file>`: the validated copy of the default room, `<data>/rooms/default-v2/<sha>/<file>`, with
///     `<sha>` read by Rust from settings.json `defaultRoomV2GoodSha` (written by room-default-v2.mjs after room-check);
///   * `/chair3d/plate-nochair.png`: an older install's own `<resources>/assets/chair3d/talk-plate-nochair.png` (the updater
///     overwrites in place and leaves it), else the default room pack's copy.
/// Every answer is a regular file pinned under its root by `real_child`.
pub(crate) fn fallback_file(path: &str, data_dir: &Path, resource_dir: Option<&Path>) -> Option<PathBuf> {
    if let Some(name) = path.strip_prefix("/rooms/default-v2/") {
        if !plain_room_file(name) {
            return None;
        }
        let sha = read_settings(data_dir)?.get("defaultRoomV2GoodSha")?.as_str()?.to_string();
        if !is_room_id(&sha) {
            return None;
        }
        let root = data_dir.join("rooms").join("default-v2").join(&sha);
        let file = root.join(name);
        return (is_regular_file(&file) && real_child(&root, &file, Path::new(name))).then_some(file);
    }
    if path == "/chair3d/plate-nochair.png" {
        let mut roots: Vec<PathBuf> = Vec::new();
        if let Some(res) = resource_dir {
            roots.push(res.join("assets").join("chair3d"));
        }
        if let Some(pack) = installed_pack_dir(data_dir, NIGHT_CITY_PACK) {
            roots.push(pack);
        }
        return roots.into_iter().map(|root| (root.join(NO_CHAIR_PLATE), root)).find_map(|(file, root)| {
            (is_regular_file(&file) && real_child(&root, &file, Path::new(NO_CHAIR_PLATE))).then_some(file)
        });
    }
    None
}

/// Did Tauri answer with its SPA fallback (index.html) instead of the file? Its asset lookup never says "absent": a missing
/// `x.png` comes back as `x.png.html`, `x.png/index.html` or `index.html` (tauri manager `get_asset`), always as HTML. The paths
/// `is_fallback_path` covers are never HTML, so HTML here means the build does not embed the file.
fn spa_fallback(response: &Response<Cow<'static, [u8]>>) -> bool {
    response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.to_ascii_lowercase().starts_with("text/html"))
}

/// The paths `fallback_file` may answer. Tauri's own embedded asset always wins: the fallback runs only when it is absent.
fn is_fallback_path(path: &str) -> bool {
    path.starts_with("/rooms/default-v2/") || path == "/chair3d/plate-nochair.png"
}

/// Ask the sidecar which file an exact app path maps to. `None` while the sidecar is down, slow, or answers null.
fn ask_sidecar(app: &AppHandle, rel: &str) -> Option<Answer> {
    let rpc = app.try_state::<Rpc>()?;
    let value = rpc
        .call("__host.resolveAsset", vec![Value::String(rel.to_string())], RESOLVE_TIMEOUT)
        .ok()?;
    parse_answer(&value)
}

/// Replace whatever Tauri built (an asset, or the SPA fallback at 200) with a bare 404.
pub(crate) fn not_found(response: &mut Response<Cow<'static, [u8]>>) {
    let headers = response.headers_mut();
    headers.clear();
    headers.insert(header::CONTENT_LENGTH, HeaderValue::from_static("0"));
    *response.status_mut() = StatusCode::NOT_FOUND;
    *response.body_mut() = Cow::Borrowed(&[]);
}

fn header_value(value: &str) -> HeaderValue {
    HeaderValue::from_str(value).unwrap_or_else(|_| HeaderValue::from_static(""))
}

/// Answer one request from `file`, with the single byte range it asked for. The length and the "regular file" check
/// come from the OPEN handle, so a path swapped after `recheck` cannot turn this into a directory read.
fn respond_file(path: &Path, route: &Route, request: &Request<Vec<u8>>, response: &mut Response<Cow<'static, [u8]>>) {
    let Ok(mut file) = File::open(path) else { return not_found(response) };
    let Ok(meta) = file.metadata() else { return not_found(response) };
    if !meta.is_file() {
        return not_found(response);
    }
    let total = meta.len();
    let mime = mime_for(route);
    let head = request.method() == Method::HEAD;
    match range_for(request.headers().get(header::RANGE).and_then(|v| v.to_str().ok()), total) {
        Range::Unsatisfiable => {
            let headers = response.headers_mut();
            headers.clear();
            headers.insert(header::CONTENT_LENGTH, HeaderValue::from_static("0"));
            headers.insert(header::CONTENT_RANGE, header_value(&format!("bytes */{total}")));
            headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
            *response.status_mut() = StatusCode::RANGE_NOT_SATISFIABLE;
            *response.body_mut() = Cow::Borrowed(&[]);
        }
        Range::Full => {
            if total > MAX_FULL_BODY {
                eprintln!(
                    "asset-route: refusing to serve {} whole: {total} bytes over the {MAX_FULL_BODY} byte ceiling",
                    route.rel
                );
                let headers = response.headers_mut();
                headers.clear();
                headers.insert(header::CONTENT_LENGTH, HeaderValue::from_static("0"));
                *response.status_mut() = StatusCode::PAYLOAD_TOO_LARGE;
                *response.body_mut() = Cow::Borrowed(&[]);
                return;
            }
            let headers = response.headers_mut();
            headers.clear();
            headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(mime));
            headers.insert(header::CONTENT_LENGTH, header_value(&total.to_string()));
            headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
            *response.status_mut() = StatusCode::OK;
            *response.body_mut() = if head {
                Cow::Borrowed(&[])
            } else {
                let Ok(bytes) = serve_bytes(&mut file, 0, total, response) else { return };
                Cow::Owned(bytes)
            };
        }
        Range::Partial { start, end } => {
            // Cap the slice: `bytes=0-` on a long video asks for everything to EOF.
            let served_end = end.min(start.saturating_add(MAX_BODY - 1));
            let want = served_end - start + 1;
            if !head {
                let Ok(bytes) = serve_bytes(&mut file, start, want, response) else { return };
                let headers = response.headers_mut();
                headers.clear();
                headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(mime));
                headers.insert(header::CONTENT_LENGTH, header_value(&want.to_string()));
                headers.insert(header::CONTENT_RANGE, header_value(&format!("bytes {start}-{served_end}/{total}")));
                headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
                *response.status_mut() = StatusCode::PARTIAL_CONTENT;
                *response.body_mut() = Cow::Owned(bytes);
            } else {
                let headers = response.headers_mut();
                headers.clear();
                headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(mime));
                headers.insert(header::CONTENT_LENGTH, header_value(&want.to_string()));
                headers.insert(header::CONTENT_RANGE, header_value(&format!("bytes {start}-{served_end}/{total}")));
                headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
                *response.status_mut() = StatusCode::PARTIAL_CONTENT;
                *response.body_mut() = Cow::Borrowed(&[]);
            }
        }
    }
}

/// Read exactly `len` bytes at `start` into a bounded buffer. HEAD never calls this (it reads nothing).
fn serve_bytes(
    file: &mut File,
    start: u64,
    len: u64,
    response: &mut Response<Cow<'static, [u8]>>,
) -> Result<Vec<u8>, ()> {
    let mut bytes = vec![0u8; len as usize];
    let read = file.seek(SeekFrom::Start(start)).and_then(|_| file.read_exact(&mut bytes));
    if read.is_err() {
        not_found(response);
        return Err(());
    }
    Ok(bytes)
}

/// One request, end to end, with the resolver and the data dir injected. `serve` supplies the sidecar and the app's own
/// data dir; the tests supply a fake resolver and a fixture dir, so the whole pipeline (classify -> ask -> re-check ->
/// stream) runs headless. A `None` answer, an unreadable data dir, or a failed re-check is the same bare 404.
pub(crate) fn serve_with(
    request: &Request<Vec<u8>>,
    response: &mut Response<Cow<'static, [u8]>>,
    data_dir: Option<&Path>,
    roots: Option<&SceneRoots>,
    resolve: &dyn Fn(&str) -> Option<Answer>,
) {
    let route = match route(request.uri().path()) {
        Routed::Serve(route) => route,
        Routed::Untouched => return,
        Routed::Refuse => return not_found(response),
    };
    if request.method() != Method::GET && request.method() != Method::HEAD {
        return not_found(response);
    }
    let Some(answer) = resolve(&route.rel) else { return not_found(response) };
    let Some(data_dir) = data_dir else { return not_found(response) };
    let Some(path) = recheck(&route, &answer, data_dir, roots) else { return not_found(response) };
    respond_file(&path, &route, request, response);
}

/// The data dir one route answers from: a self-test launch's `<runDir>/ud` (the dir the sidecar and the renderer
/// write), otherwise the app's real data dir. The decision lives here so `serve` and its test run the same code.
fn route_data_dir(
    self_test: Option<&crate::guest_cdp::SelfTest>,
    app_data_dir: Option<&Path>,
) -> Option<PathBuf> {
    match self_test {
        Some(mode) => mode.data_dir_or(app_data_dir),
        None => app_data_dir.map(Path::to_path_buf),
    }
}

/// T-31-ROOM-slim: the default room and the no-chair plate are embedded only in builds that carry them. When this build's
/// frontendDist has no such file (Tauri answered with its SPA page), answer it from disk (`fallback_file`) or with a 404.
fn serve_fallback(app: &AppHandle, request: &Request<Vec<u8>>, response: &mut Response<Cow<'static, [u8]>>) {
    let path = request.uri().path();
    if !spa_fallback(response) {
        return;
    }
    let data_dir = route_data_dir(
        app.try_state::<crate::guest_cdp::SelfTest>().as_deref(),
        app.path().app_data_dir().ok().as_deref(),
    );
    let file = data_dir
        .as_deref()
        .and_then(|dir| fallback_file(path, dir, app.path().resource_dir().ok().as_deref()));
    let Some(file) = file else { return not_found(response) };
    if request.method() != Method::GET && request.method() != Method::HEAD {
        return not_found(response);
    }
    let route = Route { class: Class::Fallback, rel: path.trim_start_matches('/').to_string() };
    respond_file(&file, &route, request, response);
}

/// Answer one `tauri.localhost` request for the main webview. Anything outside the asset namespaces is left exactly
/// as Tauri built it (the app's own assets and the SPA fallback keep working).
pub fn serve(app: &AppHandle, request: &Request<Vec<u8>>, response: &mut Response<Cow<'static, [u8]>>) {
    // The test model (Electron's --model / ZUMI_TEST_MODEL, test_model.rs) answers this one extra avatar before this
    // handler; leave its response alone.
    if request.uri().path() == "/external/test.vrm" {
        return;
    }
    // T-31-ROOM-slim: the default room and the no-chair plate, when this build does not embed them (a cheap string test first).
    if is_fallback_path(request.uri().path()) {
        return serve_fallback(app, request, response);
    }
    // Perf (T-31 diag): the page makes ~100 small requests that are not this route's (app json, gestures, speech).
    // Classify first so those pay no data-dir / resource-dir / is_dir() work; only a namespace hit resolves them.
    if matches!(route(request.uri().path()), Routed::Untouched) {
        return;
    }
    // 12-runtime finding 2: a self-test launch resolves external/user.vrm against ITS OWN <runDir>/ud settings, the same
    // dir the sidecar and the renderer write. The real app_data_dir() is used only by a normal launch.
    let data_dir = route_data_dir(
        app.try_state::<crate::guest_cdp::SelfTest>().as_deref(),
        app.path().app_data_dir().ok().as_deref(),
    );
    let roots = scene_roots(app);
    serve_with(request, response, data_dir.as_deref(), roots.as_ref(), &|rel| ask_sidecar(app, rel));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!("zumi-asset-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn put(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
        std::fs::create_dir_all(dir).unwrap();
        let p = dir.join(name);
        std::fs::write(&p, bytes).unwrap();
        p
    }

    fn settings(dir: &Path, value: Value) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join("settings.json"), value.to_string()).unwrap();
    }

    /// The scenes manifest in the shape Electron's checkScenesManifest accepts: only the fields the Rust mapping reads.
    fn scenes_manifest(dir: &Path, chair: &str, rooms: &[(&str, &str)]) {
        let rooms: Vec<Value> =
            rooms.iter().map(|(id, file)| serde_json::json!({ "id": id, "file": file })).collect();
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(
            dir.join(SCENES_MANIFEST),
            serde_json::json!({ "chair": { "file": chair }, "rooms": rooms }).to_string(),
        )
        .unwrap();
    }

    fn room_route(id: &str, name: &str) -> Route {
        Route { class: Class::Room, rel: format!("rooms/{id}/{name}") }
    }

    fn room_answer(path: &Path, store: &Path) -> Answer {
        Answer { path: path.to_string_lossy().into_owned(), root: Some(store.to_string_lossy().into_owned()) }
    }

    // ---- routing: every malformed shape is a 404 (Routed::Refuse), never a resolved path ----

    #[test]
    fn traversal_and_encoding_shapes_are_refused_not_resolved() {
        for path in [
            "/external/../user.vrm",
            "/external/%2e%2e%2fuser.vrm",
            "/external/%2e%2e/user.vrm",
            "/rooms/0123456789ab/../../user.vrm",
            "/rooms/%2e%2e/room.glb",
            "/rooms/0123456789ab/room%2eglb",
            "/external/..%5Cuser.vrm",
            "/external/\\\\server\\share\\user.vrm",
            "/external/\\\\?\\C:\\x\\user.vrm",
            "/external//user.vrm",
            "/external/user.vrm/",
            "/rooms/0123456789abc/room.glb",
            "/rooms/0123456789zz/room.glb",
            "/rooms/0123456789AB/room.glb",
            "/rooms/0123456789ab/room.exe",
            "/rooms/0123456789ab/room.glb.bak",
            "/external/user.mp4",
            "/scenes/chair.png",
            "/scenes/../chair",
            "/scenes/%2e%2e%2fchair",
            "/scenes/a/b.mp4",
            "/scenes/Bad.mp4",
        ] {
            assert_eq!(route(path), Routed::Refuse, "{path} must be refused");
        }
    }

    #[test]
    fn only_the_four_fixed_shapes_are_served_and_everything_else_is_untouched() {
        assert_eq!(
            route("/external/user.vrm"),
            Routed::Serve(Route { class: Class::External, rel: "external/user.vrm".into() })
        );
        for name in ["room.glb", "check.json", "room.json"] {
            assert_eq!(
                route(&format!("/rooms/0123456789ab/{name}")),
                Routed::Serve(room_route("0123456789ab", name))
            );
        }
        assert_eq!(
            route("/scenes/loft-2.mp4"),
            Routed::Serve(Route { class: Class::Scene, rel: "scenes/loft-2.mp4".into() })
        );
        assert_eq!(
            route("/scenes/chair"),
            Routed::Serve(Route { class: Class::Scene, rel: "scenes/chair".into() })
        );
        // Not an asset namespace: Tauri's own answer (app assets, the pinned v2 room, SPA fallback) is left alone.
        for path in ["/", "/index.html", "/models/a.vrm", "/clips/a.vrma", "/rooms/default-v2/room.json", "/rooms/default-v2/plates/talk.png"] {
            assert_eq!(route(path), Routed::Untouched, "{path}");
        }
        // The namespace roots are not files.
        for path in ["/external", "/rooms", "/scenes"] {
            assert_eq!(route(path), Routed::Refuse, "{path}");
        }
    }

    // ---- re-check: the sidecar's answer is checked again against settings and the filesystem ----

    #[test]
    fn the_external_slot_must_equal_the_settings_value_and_be_a_regular_file() {
        let dir = tmp("external");
        let data = dir.join("data");
        let vrm = put(&dir.join("outside"), "user.vrm", b"glTF");
        settings(&data, serde_json::json!({ "userModelPath": vrm.to_string_lossy() }));
        let route = Route { class: Class::External, rel: "external/user.vrm".into() };
        let answer = Answer { path: vrm.to_string_lossy().into_owned(), root: None };
        assert_eq!(recheck(&route, &answer, &data, None), Some(vrm.clone()));

        // A different .vrm than the one settings selects (the old pick, or a file the sidecar found some other way).
        let other = put(&dir.join("outside"), "other.vrm", b"x");
        let answer = Answer { path: other.to_string_lossy().into_owned(), root: None };
        assert_eq!(recheck(&route, &answer, &data, None), None, "a path that ignores settings");
        // Settings pointing at a directory, a UNC share or a verbatim path is refused.
        let answer = Answer { path: dir.to_string_lossy().into_owned(), root: None };
        assert_eq!(recheck(&route, &answer, &data, None), None, "a directory");
        for bad in ["\\\\server\\share\\user.vrm", "\\\\?\\C:\\user.vrm", "relative/user.vrm", ""] {
            let answer = Answer { path: bad.to_string(), root: None };
            assert_eq!(recheck(&route, &answer, &data, None), None, "{bad}");
            settings(&data, serde_json::json!({ "userModelPath": bad }));
            let answer = Answer { path: bad.to_string(), root: None };
            assert_eq!(recheck(&route, &answer, &data, None), None, "settings value {bad}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_room_is_served_only_for_a_listed_id_inside_the_store() {
        let dir = tmp("rooms");
        let data = dir.join("data");
        let store = data.join("rooms");
        let id = "0123456789ab";
        let glb = put(&store.join(id), "room.glb", b"glTF");
        settings(&data, serde_json::json!({ "importedRooms": [{ "id": id }] }));
        let served = room_route(id, "room.glb");
        assert_eq!(recheck(&served, &room_answer(&glb, &store), &data, None), Some(glb.clone()));

        // Settings is the source of truth: a file planted for an id settings does not list is not served, even though
        // it sits exactly where the route expects it.
        let planted = put(&store.join("ba9876543210"), "room.glb", b"planted");
        let route2 = room_route("ba9876543210", "room.glb");
        assert_eq!(recheck(&route2, &room_answer(&planted, &store), &data, None), None, "an unknown id");
        // An extension outside the list never even reaches here (route() refuses it), and a listed id with a file
        // outside its own folder is refused too.
        assert_eq!(route("/rooms/0123456789ab/evil.exe"), Routed::Refuse);
        let escaped = put(&store.join("elsewhere"), "room.glb", b"x");
        assert_eq!(recheck(&room_route(id, "room.glb"), &room_answer(&escaped, &store), &data, None), None, "a sibling folder");
        // A file name that is a link is not a regular file (lstat), and a junction AT the id leaves the store.
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_removed_v1_default_room_is_never_served() {
        // Room v1 "Zumi's Office" was removed (owner rejected it, 2026-10-26): rooms/default/* is refused by the route,
        // and a planted copy with a good sha in settings is still not served.
        let dir = tmp("default-room-gone");
        let data = dir.join("data");
        let store = data.join("rooms");
        let sha = "0123456789ab";
        let glb = put(&store.join("default").join(sha), "room.glb", b"glTF");
        assert_eq!(route("/rooms/default/room.glb"), Routed::Refuse);
        assert_eq!(route("/rooms/default/room.json"), Routed::Refuse);
        assert_eq!(route("/rooms/default/check.json"), Routed::Refuse);
        settings(&data, serde_json::json!({ "defaultRoomGoodSha": sha }));
        assert_eq!(recheck(&room_route("default", "room.glb"), &room_answer(&glb, &store), &data, None), None, "v1 copy with a good sha");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn a_junction_or_symlink_answer_is_refused() {
        let dir = tmp("links");
        let data = dir.join("data");
        let store = data.join("rooms");
        let id = "0123456789ab";
        let outside = dir.join("outside");
        let target = put(&outside, "room.glb", b"outside bytes");
        // A junction AT the store entry: the real file is outside the store, so the realpath check refuses it.
        std::fs::create_dir_all(&store).unwrap();
        let junction = store.join(id);
        let made = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&junction)
            .arg(&outside)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if made {
            settings(&data, serde_json::json!({ "importedRooms": [{ "id": id }] }));
            let target = junction.join("room.glb");
            assert!(target.is_file());
            assert_eq!(
                recheck(&room_route(id, "room.glb"), &room_answer(&target, &store), &data, None),
                None,
                "a junction at the room id must not escape the store"
            );
            let _ = std::fs::remove_dir_all(&junction).or_else(|_| std::fs::remove_dir(&junction));
        } else {
            eprintln!("SKIP junction case (mklink /J unavailable)");
        }
        // A link named exactly like the served file is not a regular file: lstat never follows it.
        let id2 = "ba9876543210";
        let room = store.join(id2);
        std::fs::create_dir_all(&room).unwrap();
        let link = room.join("room.glb");
        let linked = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(&outside)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if linked {
            settings(&data, serde_json::json!({ "importedRooms": [{ "id": id2 }] }));
            assert_eq!(
                recheck(&room_route(id2, "room.glb"), &room_answer(&link, &store), &data, None),
                None,
                "a junction named room.glb is not a regular file"
            );
            let _ = std::fs::remove_dir(&link);
        } else {
            eprintln!("SKIP file-link case (mklink /J unavailable)");
        }
        // A real file symlink when this account may create one (usually needs Developer Mode / admin).
        let id3 = "cba987654321";
        let room3 = store.join(id3);
        std::fs::create_dir_all(&room3).unwrap();
        let sym = room3.join("check.json");
        match std::os::windows::fs::symlink_file(&target, &sym) {
            Ok(()) => {
                settings(&data, serde_json::json!({ "importedRooms": [{ "id": id3 }] }));
                assert_eq!(
                    recheck(&room_route(id3, "check.json"), &room_answer(&sym, &store), &data, None),
                    None,
                    "a symlink is not a regular file"
                );
            }
            Err(_) if std::env::var("ZUMI_REQUIRE_LINKS").map(|v| v == "1").unwrap_or(false) => {
                panic!("ZUMI_REQUIRE_LINKS=1 but this account cannot create a file symlink (enable Developer Mode)")
            }
            Err(_) => eprintln!("SKIP symlink-file case (no symlink privilege on this account)"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_scene_is_served_through_the_manifest_mapping_not_by_its_route_name() {
        let dir = tmp("scenes");
        let data = dir.join("data");
        let root = dir.join("videos");
        let roots = SceneRoots { chair_dir: root.clone(), video_dir: Some(root.clone()) };
        // The manifest names the files `NN-id.mp4`; the route names the id (`scenes/loft.mp4`).
        scenes_manifest(&root, "chair-talk.png", &[("loft", "01-loft.mp4")]);
        let mp4 = put(&root, "01-loft.mp4", b"mp4!");
        let route = Route { class: Class::Scene, rel: "scenes/loft.mp4".into() };
        let answer = Answer {
            path: mp4.to_string_lossy().into_owned(),
            root: Some(root.to_string_lossy().into_owned()),
        };
        assert_eq!(recheck(&route, &answer, &data, Some(&roots)), Some(mp4.clone()));
        // An id the manifest does not list is refused, even when the sidecar answered a real file in the root.
        let route = Route { class: Class::Scene, rel: "scenes/ghost.mp4".into() };
        assert_eq!(recheck(&route, &answer, &data, Some(&roots)), None, "an id off the manifest");
        // A file in the root that the manifest does not name for THIS id is refused too.
        let other = put(&root, "02-other.mp4", b"mp4!");
        let answer = Answer { path: other.to_string_lossy().into_owned(), root: Some(root.to_string_lossy().into_owned()) };
        let route = Route { class: Class::Scene, rel: "scenes/loft.mp4".into() };
        assert_eq!(recheck(&route, &answer, &data, Some(&roots)), None, "a file the manifest does not name for this id");
        // A file one level below the root is refused.
        let nested = put(&root.join("sub"), "01-loft.mp4", b"x");
        let answer = Answer { path: nested.to_string_lossy().into_owned(), root: Some(root.to_string_lossy().into_owned()) };
        assert_eq!(recheck(&route, &answer, &data, Some(&roots)), None, "nested below the root");
        // No video folder on this machine (ZUMI_ROOMS_VIDEO_DIR unset) -> nothing to serve.
        let no_video = SceneRoots { chair_dir: root.clone(), video_dir: None };
        assert_eq!(recheck(&route, &answer, &data, Some(&no_video)), None, "no derived video root");
        // THE GATE CASE: the sidecar names a FOREIGN root holding a real .mp4. Rust ignores that root and 404s.
        let foreign = dir.join("foreign");
        let foreign_mp4 = put(&foreign, "01-loft.mp4", b"mp4!");
        let answer = Answer {
            path: foreign_mp4.to_string_lossy().into_owned(),
            root: Some(foreign.to_string_lossy().into_owned()),
        };
        assert_eq!(recheck(&route, &answer, &data, Some(&roots)), None, "a sidecar-named foreign root is not a root");

        // `scenes/chair` is the manifest's own chair file, at the manifest folder (the sidecar's answer.root is ignored).
        let plate = put(&root, "chair-talk.png", b"png!");
        let route = Route { class: Class::Scene, rel: "scenes/chair".into() };
        let answer = Answer { path: plate.to_string_lossy().into_owned(), root: Some(root.to_string_lossy().into_owned()) };
        assert_eq!(recheck(&route, &answer, &data, Some(&roots)), Some(plate.clone()));
        let nested_plate = put(&root.join("sub"), "chair-talk.png", b"x");
        let answer = Answer { path: nested_plate.to_string_lossy().into_owned(), root: Some(root.to_string_lossy().into_owned()) };
        assert_eq!(recheck(&route, &answer, &data, Some(&roots)), None, "a nested plate");
        // The plate in the video folder is not in the manifest folder: the two roots are distinct.
        let roots_distinct = SceneRoots { chair_dir: dir.join("manifest"), video_dir: Some(root.clone()) };
        let answer = Answer { path: plate.to_string_lossy().into_owned(), root: Some(root.to_string_lossy().into_owned()) };
        assert_eq!(recheck(&route, &answer, &data, Some(&roots_distinct)), None, "a plate outside the manifest folder");
        // No manifest: fail closed for every scene (the video root alone is not a mapping).
        let no_manifest = SceneRoots { chair_dir: dir.join("empty"), video_dir: Some(root.clone()) };
        let route = Route { class: Class::Scene, rel: "scenes/loft.mp4".into() };
        let answer = Answer { path: mp4.to_string_lossy().into_owned(), root: Some(root.to_string_lossy().into_owned()) };
        assert_eq!(recheck(&route, &answer, &data, Some(&no_manifest)), None, "no scenes manifest");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_video_folder_is_the_packaged_rooms_video_unless_the_dev_env_overrides_it() {
        let dir = tmp("videodir");
        let res = dir.join("res");
        std::fs::create_dir_all(&res).unwrap();
        // public build: nothing staged -> no folder
        assert_eq!(video_dir_from(None, Some(&res)), None, "no rooms-video in the resources");
        assert_eq!(video_dir_from(None, None), None, "no resource dir");
        // owner build: <resources>/rooms-video
        std::fs::create_dir_all(res.join("rooms-video")).unwrap();
        assert_eq!(video_dir_from(None, Some(&res)), Some(res.join("rooms-video")));
        assert_eq!(video_dir_from(Some("".into()), Some(&res)), Some(res.join("rooms-video")), "an empty env is unset");
        // dev override wins
        let dev = dir.join("dev");
        assert_eq!(video_dir_from(Some(dev.clone().into_os_string()), Some(&res)), Some(dev));
        // the constant is the manifest's own packagedDir
        let manifest: Value = serde_json::from_str(include_str!("../../../assets/rooms-video/rooms.json")).unwrap();
        assert_eq!(manifest["packagedDir"].as_str(), Some(PACKAGED_VIDEO_DIR));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_the_files_rooms_json_lists_are_served_from_the_packaged_folder() {
        let dir = tmp("packaged-allow");
        let data = dir.join("data");
        let res = dir.join("res");
        let videos = res.join("rooms-video");
        // the REAL manifest: the 7 owner rooms, at <resources>/assets/rooms-video/rooms.json
        let manifest_dir = res.join("assets").join("rooms-video");
        std::fs::create_dir_all(&manifest_dir).unwrap();
        let text = include_str!("../../../assets/rooms-video/rooms.json");
        std::fs::write(manifest_dir.join(SCENES_MANIFEST), text).unwrap();
        let manifest: Value = serde_json::from_str(text).unwrap();
        let rooms = manifest["rooms"].as_array().unwrap();
        assert_eq!(rooms.len(), 7);
        let roots = SceneRoots { chair_dir: manifest_dir.clone(), video_dir: video_dir_from(None, Some(&res)).or(Some(videos.clone())) };
        for room in rooms {
            let (id, file) = (room["id"].as_str().unwrap(), room["file"].as_str().unwrap());
            let mp4 = put(&videos, file, b"mp4!");
            let route = Route { class: Class::Scene, rel: format!("scenes/{id}.mp4") };
            let answer = Answer { path: mp4.to_string_lossy().into_owned(), root: None };
            assert_eq!(recheck(&route, &answer, &data, Some(&roots)), Some(mp4), "{id} is served");
        }
        // an unlisted file in the folder, and an unlisted id, are refused
        let stray = put(&videos, "99-stray.mp4", b"mp4!");
        let answer = Answer { path: stray.to_string_lossy().into_owned(), root: None };
        for rel in ["scenes/cozy-study.mp4", "scenes/stray.mp4", "scenes/99-stray.mp4"] {
            let route = Route { class: Class::Scene, rel: rel.into() };
            assert_eq!(recheck(&route, &answer, &data, Some(&roots)), None, "{rel} must not serve 99-stray.mp4");
        }
        // traversal: a route that climbs, and an answer outside the folder, never resolve
        for path in ["/scenes/../rooms.json", "/scenes/%2e%2e/x.mp4", "/scenes/..%5Cx.mp4", "/scenes/cozy-study.mp4/../../x"] {
            assert!(!matches!(route(path), Routed::Serve(_)), "{path} is not a scene route");
        }
        let outside = put(&dir.join("outside"), "01-cozy-study.mp4", b"mp4!");
        let route = Route { class: Class::Scene, rel: "scenes/cozy-study.mp4".into() };
        let answer = Answer { path: outside.to_string_lossy().into_owned(), root: Some(dir.join("outside").to_string_lossy().into_owned()) };
        assert_eq!(recheck(&route, &answer, &data, Some(&roots)), None, "a file outside the packaged folder");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- range math ----

    #[test]
    fn range_math_covers_the_whole_rfc_subset_this_route_serves() {
        let len = 100;
        assert_eq!(range_for(None, len), Range::Full, "no header");
        assert_eq!(range_for(Some("bytes=0-"), len), Range::Partial { start: 0, end: 99 }, "the whole file as a range");
        assert_eq!(range_for(Some("bytes=-10"), len), Range::Partial { start: 90, end: 99 }, "a suffix range");
        assert_eq!(range_for(Some("bytes=-500"), len), Range::Partial { start: 0, end: 99 }, "a suffix longer than the file");
        assert_eq!(range_for(Some("bytes=50-59"), len), Range::Partial { start: 50, end: 59 }, "a mid range");
        assert_eq!(range_for(Some("bytes=50-"), len), Range::Partial { start: 50, end: 99 }, "an open-ended range");
        assert_eq!(range_for(Some("bytes=90-500"), len), Range::Partial { start: 90, end: 99 }, "an end past EOF is clamped");
        assert_eq!(range_for(Some("bytes=100-"), len), Range::Unsatisfiable, "a start at EOF");
        assert_eq!(range_for(Some("bytes=150-160"), len), Range::Unsatisfiable, "a start past EOF");
        assert_eq!(range_for(Some("bytes=9-3"), len), Range::Unsatisfiable, "backwards");
        assert_eq!(range_for(Some("bytes=-0"), len), Range::Unsatisfiable, "an empty suffix");
        assert_eq!(range_for(Some("bytes=0-"), 0), Range::Unsatisfiable, "an empty file has no range");
        assert_eq!(range_for(Some("bytes=0-1,3-4"), len), Range::Unsatisfiable, "multi-range is REFUSED, not merged");
        assert_eq!(range_for(Some("bytes=abc"), len), Range::Full, "unparsable is ignored");
        assert_eq!(range_for(Some("items=0-1"), len), Range::Full, "another unit is ignored");
    }

    // ---- MIME ----

    #[test]
    fn each_file_kind_gets_its_own_content_type() {
        let m = |path: &str| match route(path) {
            Routed::Serve(route) => mime_for(&route),
            other => panic!("{path} is not a route: {other:?}"),
        };
        assert_eq!(m("/external/user.vrm"), "model/gltf-binary");
        assert_eq!(m("/rooms/0123456789ab/room.glb"), "model/gltf-binary");
        assert_eq!(m("/rooms/0123456789ab/check.json"), "application/json");
        assert_eq!(m("/scenes/loft.mp4"), "video/mp4");
        assert_eq!(m("/scenes/chair"), "image/png");
    }

    // ---- the response itself ----

    fn page_response() -> Response<Cow<'static, [u8]>> {
        Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "text/html")
            .header(header::CONTENT_SECURITY_POLICY, "default-src 'self'")
            .body(Cow::Borrowed(&b"<html></html>"[..]))
            .unwrap()
    }

    #[test]
    fn a_full_response_is_200_and_a_range_is_206_with_its_content_range() {
        let dir = tmp("respond");
        let file = put(&dir, "room.glb", b"0123456789");
        let route = room_route("0123456789ab", "room.glb");

        let request = Request::get("http://tauri.localhost/rooms/0123456789ab/room.glb").body(Vec::new()).unwrap();
        let mut response = page_response();
        respond_file(&file, &route, &request, &mut response);
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "model/gltf-binary");
        assert_eq!(response.headers()[header::CONTENT_LENGTH], "10");
        assert_eq!(response.headers()[header::ACCEPT_RANGES], "bytes");
        assert!(response.headers().get(header::CONTENT_SECURITY_POLICY).is_none());
        assert_eq!(&response.body()[..], b"0123456789");

        for (range, start, end, bytes) in [
            ("bytes=0-3", "0", "3", &b"0123"[..]),
            ("bytes=-2", "8", "9", b"89"),
            ("bytes=4-", "4", "9", b"456789"),
        ] {
            let request = Request::builder()
                .uri("http://tauri.localhost/rooms/0123456789ab/room.glb")
                .header(header::RANGE, range)
                .body(Vec::new())
                .unwrap();
            let mut response = page_response();
            respond_file(&file, &route, &request, &mut response);
            assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT, "{range}");
            assert_eq!(response.headers()[header::CONTENT_RANGE], format!("bytes {start}-{end}/10"));
            assert_eq!(&response.body()[..], bytes, "{range}");
        }

        let request = Request::builder()
            .uri("http://tauri.localhost/rooms/0123456789ab/room.glb")
            .header(header::RANGE, "bytes=50-60")
            .body(Vec::new())
            .unwrap();
        let mut response = page_response();
        respond_file(&file, &route, &request, &mut response);
        assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes */10");
        assert!(response.body().is_empty());

        let request = Request::builder()
            .uri("http://tauri.localhost/rooms/0123456789ab/room.glb")
            .header(header::RANGE, "bytes=0-1,4-5")
            .body(Vec::new())
            .unwrap();
        let mut response = page_response();
        respond_file(&file, &route, &request, &mut response);
        assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE, "a multi-range request is refused");
        assert!(response.body().is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_large_range_is_capped_and_head_reads_no_body() {
        let dir = tmp("respond-large");
        let total = MAX_BODY as usize + 4096;
        let file = put(&dir, "loft.mp4", &vec![b'z'; total]);
        let route = Route { class: Class::Scene, rel: "scenes/loft.mp4".into() };
        let request = Request::builder()
            .uri("http://tauri.localhost/scenes/loft.mp4")
            .header(header::RANGE, "bytes=0-")
            .body(Vec::new())
            .unwrap();
        let mut response = page_response();
        respond_file(&file, &route, &request, &mut response);
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.headers()[header::CONTENT_LENGTH], MAX_BODY.to_string());
        assert_eq!(response.headers()[header::CONTENT_RANGE], format!("bytes 0-{}/{total}", MAX_BODY - 1));
        assert_eq!(response.body().len() as u64, MAX_BODY, "the first video request buffers at most the cap");
        assert_eq!(response.body()[..4], [b'z'; 4]);

        // A full request (no Range) is NOT capped: it promises the whole file, so it gets the whole file.
        let request = Request::get("http://tauri.localhost/scenes/loft.mp4").body(Vec::new()).unwrap();
        let mut response = page_response();
        respond_file(&file, &route, &request, &mut response);
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CONTENT_LENGTH], total.to_string());
        assert_eq!(response.body().len(), total);

        // HEAD answers the same headers and NO body (it never reads the file).
        let mut request = Request::builder()
            .uri("http://tauri.localhost/scenes/loft.mp4")
            .header(header::RANGE, "bytes=0-")
            .body(Vec::new())
            .unwrap();
        *request.method_mut() = Method::HEAD;
        let mut response = page_response();
        respond_file(&file, &route, &request, &mut response);
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.headers()[header::CONTENT_LENGTH], MAX_BODY.to_string());
        assert!(response.body().is_empty(), "HEAD carries no body");

        // A slice that starts inside the cap but asks for more is capped from that start, end reported honestly.
        let start = MAX_BODY - 10;
        let request = Request::builder()
            .uri("http://tauri.localhost/scenes/loft.mp4")
            .header(header::RANGE, format!("bytes={start}-"))
            .body(Vec::new())
            .unwrap();
        let mut response = page_response();
        respond_file(&file, &route, &request, &mut response);
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        let served_end = (total as u64 - 1).min(start + MAX_BODY - 1);
        assert_eq!(response.headers()[header::CONTENT_RANGE], format!("bytes {start}-{served_end}/{total}"));
        assert_eq!(response.body().len() as u64, served_end - start + 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_full_response_serves_a_file_larger_than_the_range_cap_whole() {
        // A 9 MiB VRM is what broke the renderer: a short 200 gave it a truncated typed array ("Invalid typed array
        // length"). A non-range request is not a Range slice, so it must be complete.
        let dir = tmp("respond-full-large");
        let len = 9 * 1024 * 1024;
        let file = put(&dir, "user.vrm", &vec![b'v'; len]);
        let route = Route { class: Class::External, rel: "external/user.vrm".into() };

        let request = Request::get("http://tauri.localhost/external/user.vrm").body(Vec::new()).unwrap();
        let mut response = page_response();
        respond_file(&file, &route, &request, &mut response);
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CONTENT_LENGTH], len.to_string());
        assert_eq!(response.headers()[header::CONTENT_TYPE], "model/gltf-binary");
        assert_eq!(response.body().len(), len, "the whole file, never a short 200");
        assert_eq!(response.body()[len - 1], b'v');

        // HEAD makes the same promise in its length and reads nothing.
        let mut request = Request::get("http://tauri.localhost/external/user.vrm").body(Vec::new()).unwrap();
        *request.method_mut() = Method::HEAD;
        let mut response = page_response();
        respond_file(&file, &route, &request, &mut response);
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CONTENT_LENGTH], len.to_string());
        assert!(response.body().is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_full_request_above_the_whole_body_ceiling_is_an_explicit_413() {
        // The ceiling guards memory; it is not a truncation point. Above it the answer is an honest error, never a short
        // 200. The file is sparse, so only its metadata carries the size.
        let dir = tmp("respond-full-ceiling");
        let file = dir.join("user.vrm");
        let f = File::create(&file).unwrap();
        f.set_len(MAX_FULL_BODY + 1).unwrap();
        drop(f);
        let route = Route { class: Class::External, rel: "external/user.vrm".into() };

        for method in [Method::GET, Method::HEAD] {
            let mut request = Request::get("http://tauri.localhost/external/user.vrm").body(Vec::new()).unwrap();
            *request.method_mut() = method.clone();
            let mut response = page_response();
            respond_file(&file, &route, &request, &mut response);
            assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE, "{method}");
            assert_eq!(response.headers()[header::CONTENT_LENGTH], "0", "{method}");
            assert!(response.body().is_empty(), "{method}");
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_path_swapped_to_a_directory_after_the_recheck_is_refused() {
        // Gate item 4b-5 (mutant A12): the is_file check uses the OPEN handle's metadata. Swap the path between recheck and
        // open, as an attacker with write access to the store would: the route must 404, never read a directory.
        let dir = tmp("respond-swap");
        let file = put(&dir, "room.glb", b"0123456789");
        let route = room_route("0123456789ab", "room.glb");
        std::fs::remove_file(&file).unwrap();
        std::fs::create_dir(&file).unwrap();
        let request = Request::get("http://tauri.localhost/rooms/0123456789ab/room.glb").body(Vec::new()).unwrap();
        let mut response = page_response();
        respond_file(&file, &route, &request, &mut response);
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert!(response.body().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_refusal_replaces_the_spa_fallback_with_a_bare_404() {
        let mut response = page_response();
        not_found(&mut response);
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert!(response.body().is_empty());
        assert!(response.headers().get(header::CONTENT_SECURITY_POLICY).is_none());
        assert_eq!(response.headers()[header::CONTENT_LENGTH], "0");
    }

    #[test]
    fn an_answer_must_be_an_object_with_an_absolute_looking_path() {
        assert_eq!(
            parse_answer(&serde_json::json!({ "path": "C:/x/user.vrm", "root": null })),
            Some(Answer { path: "C:/x/user.vrm".into(), root: None })
        );
        assert_eq!(
            parse_answer(&serde_json::json!({ "path": "C:/x/a.mp4", "root": "C:/videos" })),
            Some(Answer { path: "C:/x/a.mp4".into(), root: Some("C:/videos".into()) })
        );
        assert_eq!(parse_answer(&Value::Null), None);
        assert_eq!(parse_answer(&serde_json::json!({ "path": 7 })), None);
        assert_eq!(parse_answer(&serde_json::json!({ "root": "C:/videos" })), None);
        assert_eq!(parse_answer(&serde_json::json!({ "path": "C:/x", "root": 7 })), None);
    }

    // ---- the handler itself, with a fake resolver: the real pipeline, headless ----

    struct Fixture {
        dir: PathBuf,
        data: PathBuf,
        store: PathBuf,
        vrm: PathBuf,
        glb: PathBuf,
        videos: PathBuf,
        mp4: PathBuf,
        chair: PathBuf,
    }

    const FIXTURE_ID: &str = "0123456789ab";

    fn fixture(tag: &str) -> Fixture {
        let dir = tmp(tag);
        let data = dir.join("data");
        let store = data.join("rooms");
        let glb = put(&store.join(FIXTURE_ID), "room.glb", b"0123456789");
        let vrm = put(&dir.join("picked"), "user.vrm", b"glTF-avatar");
        let videos = dir.join("videos");
        // The scenes manifest names the file `01-loft.mp4`; the renderer asks for `scenes/loft.mp4`.
        scenes_manifest(&videos, "chair.png", &[("loft", "01-loft.mp4")]);
        let mp4 = put(&videos, "01-loft.mp4", b"mp4-bytes");
        let chair = put(&videos, "chair.png", b"png-bytes");
        settings(&data, serde_json::json!({ "userModelPath": vrm.to_string_lossy(), "importedRooms": [{ "id": FIXTURE_ID }] }));
        Fixture { dir, data, store, vrm, glb, videos, mp4, chair }
    }

    /// What the sidecar would answer for this fixture, and nothing else.
    fn fixture_answer(f: &Fixture, rel: &str) -> Option<Answer> {
        match rel {
            "external/user.vrm" => Some(Answer { path: f.vrm.to_string_lossy().into_owned(), root: None }),
            "rooms/0123456789ab/room.glb" => Some(room_answer(&f.glb, &f.store)),
            "scenes/loft.mp4" => {
                Some(Answer { path: f.mp4.to_string_lossy().into_owned(), root: Some(f.videos.to_string_lossy().into_owned()) })
            }
            "scenes/chair" => {
                Some(Answer { path: f.chair.to_string_lossy().into_owned(), root: Some(f.videos.to_string_lossy().into_owned()) })
            }
            _ => None,
        }
    }

    /// The roots Rust derives for this fixture: its video folder, which also stands in for the manifest folder.
    fn fixture_roots(f: &Fixture) -> SceneRoots {
        SceneRoots { chair_dir: f.videos.clone(), video_dir: Some(f.videos.clone()) }
    }

    fn get(uri: &str) -> Request<Vec<u8>> {
        Request::get(uri).body(Vec::new()).unwrap()
    }

    #[test]
    fn the_handler_serves_every_route_shape_the_resolver_and_settings_agree_on() {
        let f = fixture("handler-serve");
        let resolve = |rel: &str| fixture_answer(&f, rel);

        for (uri, mime, body) in [
            ("http://tauri.localhost/external/user.vrm", "model/gltf-binary", &b"glTF-avatar"[..]),
            ("http://tauri.localhost/rooms/0123456789ab/room.glb", "model/gltf-binary", b"0123456789"),
            ("http://tauri.localhost/scenes/loft.mp4", "video/mp4", b"mp4-bytes"),
            ("http://tauri.localhost/scenes/chair", "image/png", b"png-bytes"),
        ] {
            let mut response = page_response();
            serve_with(&get(uri), &mut response, Some(&f.data), Some(&fixture_roots(&f)), &resolve);
            assert_eq!(response.status(), StatusCode::OK, "{uri}");
            assert_eq!(response.headers()[header::CONTENT_TYPE], mime, "{uri}");
            assert_eq!(&response.body()[..], body, "{uri}");
            assert!(response.headers().get(header::CONTENT_SECURITY_POLICY).is_none(), "{uri}");
        }

        // A range goes straight through the same pipeline (the renderer seeks a video this way).
        let request = Request::builder()
            .uri("http://tauri.localhost/scenes/loft.mp4")
            .header(header::RANGE, "bytes=4-")
            .body(Vec::new())
            .unwrap();
        let mut response = page_response();
        serve_with(&request, &mut response, Some(&f.data), Some(&fixture_roots(&f)), &resolve);
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes 4-8/9");
        assert_eq!(&response.body()[..], b"bytes");

        // HEAD carries the length and no body.
        let mut request = get("http://tauri.localhost/rooms/0123456789ab/room.glb");
        *request.method_mut() = Method::HEAD;
        let mut response = page_response();
        serve_with(&request, &mut response, Some(&f.data), Some(&fixture_roots(&f)), &resolve);
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CONTENT_LENGTH], "10");
        assert!(response.body().is_empty());

        let _ = std::fs::remove_dir_all(&f.dir);
    }

    #[test]
    fn the_handler_answers_404_for_every_refusal_and_never_the_spa_fallback() {
        use std::cell::Cell;

        let f = fixture("handler-refuse");
        let calls = Cell::new(0);
        let resolve = |rel: &str| {
            calls.set(calls.get() + 1);
            fixture_answer(&f, rel)
        };
        // Every refusal below replaces Tauri's fallback page, so the body and the CSP must be gone.
        let refused = |response: &Response<Cow<'static, [u8]>>, what: &str| {
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "{what}");
            assert!(response.body().is_empty(), "{what}");
            assert!(response.headers().get(header::CONTENT_SECURITY_POLICY).is_none(), "{what}");
        };

        // A file planted in the store for an id settings does not list.
        let planted = put(&f.store.join("ba9876543210"), "room.glb", b"planted");
        let mut response = page_response();
        serve_with(&get("http://tauri.localhost/rooms/ba9876543210/room.glb"), &mut response, Some(&f.data), Some(&fixture_roots(&f)), &|_| {
            Some(room_answer(&planted, &f.store))
        });
        refused(&response, "an unknown id");

        // A .vrm the settings do not select (the sidecar answered, the re-check says no).
        let other = put(&f.dir.join("picked"), "other.vrm", b"x");
        let mut response = page_response();
        serve_with(&get("http://tauri.localhost/external/user.vrm"), &mut response, Some(&f.data), Some(&fixture_roots(&f)), &|_| {
            Some(Answer { path: other.to_string_lossy().into_owned(), root: None })
        });
        refused(&response, "a path that ignores settings");

        // A scene file one level below the root the sidecar named.
        let nested = put(&f.videos.join("sub"), "01-loft.mp4", b"x");
        let mut response = page_response();
        serve_with(&get("http://tauri.localhost/scenes/loft.mp4"), &mut response, Some(&f.data), Some(&fixture_roots(&f)), &|_| {
            Some(Answer { path: nested.to_string_lossy().into_owned(), root: Some(f.videos.to_string_lossy().into_owned()) })
        });
        refused(&response, "a scene outside the named root");

        // An id the manifest does not list: the sidecar answered a real file, Rust still refuses it.
        let mut response = page_response();
        serve_with(&get("http://tauri.localhost/scenes/ghost.mp4"), &mut response, Some(&f.data), Some(&fixture_roots(&f)), &|_| {
            Some(Answer { path: f.mp4.to_string_lossy().into_owned(), root: Some(f.videos.to_string_lossy().into_owned()) })
        });
        refused(&response, "a scene id off the manifest");

        // Null from the sidecar (it does not know this path, or is down).
        let mut response = page_response();
        serve_with(&get("http://tauri.localhost/scenes/ghost.mp4"), &mut response, Some(&f.data), Some(&fixture_roots(&f)), &|_| None);
        refused(&response, "a null answer");

        // No data dir (the re-check cannot run): fail closed.
        let mut response = page_response();
        serve_with(&get("http://tauri.localhost/external/user.vrm"), &mut response, None, Some(&fixture_roots(&f)), &resolve);
        refused(&response, "no data dir");

        // Traversal and a method that is not GET/HEAD are refused before the sidecar is asked.
        let before = calls.get();
        for (method, uri) in [
            (Method::GET, "http://tauri.localhost/external/../user.vrm"),
            (Method::GET, "http://tauri.localhost/rooms/%2e%2e/room.glb"),
            (Method::GET, "http://tauri.localhost/rooms/0123456789ab/../../user.vrm"),
            (Method::GET, "http://tauri.localhost/scenes/%2e%2e%2fchair"),
            (Method::POST, "http://tauri.localhost/external/user.vrm"),
        ] {
            let mut request = get(uri);
            *request.method_mut() = method.clone();
            let mut response = page_response();
            serve_with(&request, &mut response, Some(&f.data), Some(&fixture_roots(&f)), &resolve);
            refused(&response, uri);
        }
        assert_eq!(calls.get(), before, "a refused shape never reaches the resolver");

        // Outside the asset namespaces the response is left exactly as Tauri built it.
        let mut response = page_response();
        serve_with(&get("http://tauri.localhost/index.html"), &mut response, Some(&f.data), Some(&fixture_roots(&f)), &resolve);
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(&response.body()[..], b"<html></html>");
        assert!(response.headers().get(header::CONTENT_SECURITY_POLICY).is_some());
        assert_eq!(calls.get(), before, "an untouched path never reaches the resolver");

        let _ = std::fs::remove_dir_all(&f.dir);
    }

    #[test]
    fn a_selftest_launch_resolves_the_external_avatar_against_its_own_ud() {
        // 12-runtime finding 2: a self-test keeps userModelPath in <runDir>/ud, so the route must re-check that dir,
        // never the real app_data_dir() (which selects another file -> the box's 404).
        use crate::guest_cdp::SelfTest;
        let dir = tmp("selftest-ud");
        let app_data = dir.join("app-data");
        let run = dir.join("run");
        let normal_vrm = put(&dir.join("normal"), "user.vrm", b"normal-avatar");
        let test_vrm = put(&dir.join("test"), "user.vrm", b"selftest-avatar");
        settings(&app_data, serde_json::json!({ "userModelPath": normal_vrm.to_string_lossy() }));
        settings(&run.join("ud"), serde_json::json!({ "userModelPath": test_vrm.to_string_lossy() }));
        let mode = SelfTest::from_args(&["--selftest".to_string(), run.to_string_lossy().into_owned()]);
        let data_dir = route_data_dir(Some(&mode), Some(&app_data)).expect("a self-test data dir");
        assert_eq!(data_dir, run.join("ud"));

        let resolve = |_rel: &str| Some(Answer { path: test_vrm.to_string_lossy().into_owned(), root: None });
        let mut response = page_response();
        serve_with(&get("http://tauri.localhost/external/user.vrm"), &mut response, Some(&data_dir), None, &resolve);
        assert_eq!(response.status(), StatusCode::OK, "the self-test model must be served from <runDir>/ud");
        assert_eq!(&response.body()[..], b"selftest-avatar");

        // The same answer against the real app data dir is a bare 404: that settings selects another file.
        let mut response = page_response();
        serve_with(&get("http://tauri.localhost/external/user.vrm"), &mut response, Some(&app_data), None, &resolve);
        assert_eq!(response.status(), StatusCode::NOT_FOUND);

        // A normal launch keeps the real app data dir (and an absent state never invents a run dir).
        let normal = SelfTest::from_args(&[]);
        assert_eq!(route_data_dir(Some(&normal), Some(&app_data)), Some(app_data.clone()));
        assert_eq!(route_data_dir(None, Some(&app_data)), Some(app_data.clone()));
        assert_eq!(route_data_dir(None, None), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_the_asset_namespaces_are_this_handlers() {
        // The guest hook uses this to answer 404 for exactly the paths the route owns (guest_guard::deny_guest_asset).
        for path in [
            "/external/user.vrm",
            "/external/test.vrm",
            "/external/../user.vrm",
            "/rooms/0123456789ab/room.glb",
            "/rooms",
            "/scenes/loft.mp4",
            "/scenes/chair",
        ] {
            assert!(is_asset_path(path), "{path}");
        }
        for path in ["/", "/index.html", "/models/a.vrm", "/clips/a.vrma", "/rooms/default-v2/room.json"] {
            assert!(!is_asset_path(path), "{path}");
        }
    }

    // ---------- T-31-ROOM-slim: rooms from packs, and the files a slim build no longer embeds ----------

    #[test]
    fn a_video_from_its_room_pack_is_served_and_only_under_that_pack() {
        let data = tmp("slim-pack-video");
        let res = tmp("slim-pack-video-res");
        put(&res.join("assets").join("rooms-video"), "rooms.json", include_bytes!("../../../assets/rooms-video/rooms.json"));
        let roots = SceneRoots { chair_dir: res.join("assets").join("rooms-video"), video_dir: None };
        let pack = data.join("packs").join("room.beach-cabin");
        put(&pack, "zumi-pack.json", b"{}");
        let video = put(&pack, "06-beach-cabin-studio-2710.mp4", b"v");
        let route = Route { class: Class::Scene, rel: "scenes/beach-cabin.mp4".into() };
        let answer = Answer { path: video.to_string_lossy().into_owned(), root: None };
        assert_eq!(recheck(&route, &answer, &data, Some(&roots)), Some(video.clone()));
        // the same file under ANOTHER room's pack id is not this room's video
        let other = Route { class: Class::Scene, rel: "scenes/cozy-study.mp4".into() };
        assert_eq!(recheck(&other, &answer, &data, Some(&roots)), None);
        // a pack waiting for removal serves nothing
        put(&data.join("packs"), "room.beach-cabin.remove-pending", b"");
        assert_eq!(recheck(&route, &answer, &data, Some(&roots)), None);
        std::fs::remove_file(data.join("packs").join("room.beach-cabin.remove-pending")).unwrap();
        // a folder without a manifest is not an installed pack
        std::fs::remove_file(pack.join("zumi-pack.json")).unwrap();
        assert_eq!(recheck(&route, &answer, &data, Some(&roots)), None);
    }

    #[test]
    fn the_default_room_is_served_from_its_validated_copy_named_in_settings() {
        let data = tmp("slim-default-room");
        let copy = data.join("rooms").join("default-v2").join("0123456789ab");
        let plate = put(&copy, "B-talk-plate.png", b"png");
        put(&copy, "room.json", b"{}");
        assert_eq!(fallback_file("/rooms/default-v2/B-talk-plate.png", &data, None), None, "no settings: nothing");
        settings(&data, serde_json::json!({ "defaultRoomV2GoodSha": "0123456789ab" }));
        assert_eq!(fallback_file("/rooms/default-v2/B-talk-plate.png", &data, None), Some(plate));
        assert!(fallback_file("/rooms/default-v2/room.json", &data, None).is_some());
        for bad in ["/rooms/default-v2/../x.png", "/rooms/default-v2/a/b.png", "/rooms/default-v2/x.exe", "/rooms/default-v2/missing.png", "/rooms/default-v2/"] {
            assert_eq!(fallback_file(bad, &data, None), None, "{bad}");
        }
        settings(&data, serde_json::json!({ "defaultRoomV2GoodSha": "../../etc" }));
        assert_eq!(fallback_file("/rooms/default-v2/B-talk-plate.png", &data, None), None, "a sha that is not 12 hex is refused");
    }

    #[test]
    fn the_no_chair_plate_comes_from_the_old_install_first_then_the_room_pack() {
        let data = tmp("slim-nochair");
        let res = tmp("slim-nochair-res");
        assert_eq!(fallback_file("/chair3d/plate-nochair.png", &data, Some(&res)), None);
        let pack = data.join("packs").join("room.night-city");
        put(&pack, "zumi-pack.json", b"{}");
        let in_pack = put(&pack, "talk-plate-nochair.png", b"p");
        assert_eq!(fallback_file("/chair3d/plate-nochair.png", &data, Some(&res)), Some(in_pack));
        let in_install = put(&res.join("assets").join("chair3d"), "talk-plate-nochair.png", b"i");
        assert_eq!(fallback_file("/chair3d/plate-nochair.png", &data, Some(&res)), Some(in_install));
        assert_eq!(fallback_file("/chair3d/other.png", &data, Some(&res)), None);
        assert!(is_fallback_path("/rooms/default-v2/room.json") && is_fallback_path("/chair3d/plate-nochair.png"));
        assert!(!is_fallback_path("/rooms/0123456789ab/room.glb") && !is_fallback_path("/index.html"));
    }

    #[test]
    fn only_tauris_html_fallback_counts_as_a_missing_embedded_file() {
        let mut html = Response::new(Cow::Borrowed(&b"<!doctype html>"[..]));
        html.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("text/html; charset=utf-8"));
        assert!(spa_fallback(&html));
        let mut png = Response::new(Cow::Borrowed(&b"png"[..]));
        png.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("image/png"));
        assert!(!spa_fallback(&png));
        assert!(!spa_fallback(&Response::new(Cow::Borrowed(&b""[..]))), "no content type: leave Tauri's answer alone");
    }
}
