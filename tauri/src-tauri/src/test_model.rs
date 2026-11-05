// T-31 box-probe support — an avatar source with Electron's own switch. The preview ships no .vrm
// (assets/models/models.json lists none, same as Electron 0.2.4), so the boot trace could not render an avatar.
// Electron's answer is `--model <file>` / ZUMI_TEST_MODEL (src/main/main.js:147-148): a listed, selected,
// never-persisted slot served at `external/test.vrm`. This module gives Tauri the SAME path in EVERY build (no cargo
// feature: Electron has no such build switch either):
//   * the host reads `--model <absolute .vrm>` first, then ZUMI_TEST_MODEL, once at process start (`init`), and hands
//     the sidecar `--test-model <path>` (it lists the slot; the sidecar never reads the environment), and
//   * the main webview's `/external/test.vrm` is answered from that file (`serve`), through
//     `on_web_resource_request`, which Tauri calls after its asset lookup for every `tauri.localhost` request.
// Only that one fixed route reads that one path; the renderer never names a path. No model file is committed.

use std::borrow::Cow;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use tauri::http::{header, Request, Response, StatusCode};

/// The only route served, identical to the URL models-core.js builds for the `test` slot.
const ROUTE: &str = "/external/test.vrm";

/// Environment variable naming the model. Read once, by the host, in a build that has this module.
const ENV_VAR: &str = "ZUMI_TEST_MODEL";

/// `Some(path)` when `raw` is an absolute path to an existing regular `.vrm` file.
fn validate(raw: &str) -> Option<PathBuf> {
    let path = PathBuf::from(raw);
    let is_vrm = path.extension().is_some_and(|e| e.eq_ignore_ascii_case("vrm"));
    (path.is_absolute() && is_vrm && path.is_file()).then_some(path)
}

/// The value of `--model <path>` in `argv` (Electron's first choice), if present.
fn from_args(argv: &[String]) -> Option<String> {
    let i = argv.iter().position(|a| a == "--model")?;
    argv.get(i + 1).cloned()
}

/// Resolve the model once, with Electron's precedence: `--model <file>` then ZUMI_TEST_MODEL.
fn resolve(argv: &[String]) -> Option<PathBuf> {
    let (raw, source) = match from_args(argv) {
        Some(value) => (value, "--model"),
        None => (std::env::var(ENV_VAR).ok()?, ENV_VAR),
    };
    let found = validate(&raw);
    match &found {
        Some(_) => eprintln!("test-model: serving {ROUTE}"),
        None => eprintln!("test-model: {source} ignored (not an absolute path to an existing .vrm file)"),
    }
    found
}

/// Read the switch once, at process start. `--model` (Electron's flag) wins over the environment; the first call wins,
/// so the host, the sidecar spawn and the asset route all see the same path.
pub fn init(argv: &[String]) {
    let _ = MODEL.set(resolve(argv));
}

static MODEL: OnceLock<Option<PathBuf>> = OnceLock::new();

/// The configured test model, resolved once. `None` when neither switch names a valid path (a warning names the
/// reason, never the path).
pub fn configured() -> Option<&'static PathBuf> {
    MODEL.get_or_init(|| resolve(&[])).as_ref()
}

/// Answer `GET /external/test.vrm` from the configured file; every other request is left untouched.
pub fn serve(request: &Request<Vec<u8>>, response: &mut Response<Cow<'static, [u8]>>) {
    if let Some(path) = configured() {
        serve_file(path, request, response);
    }
}

fn serve_file(path: &Path, request: &Request<Vec<u8>>, response: &mut Response<Cow<'static, [u8]>>) {
    if request.uri().path() == ROUTE {
        fill(response, std::fs::read(path).ok());
    }
}

/// Replace `response` with the file's bytes (200), or an empty 404 when it cannot be read.
fn fill(response: &mut Response<Cow<'static, [u8]>>, bytes: Option<Vec<u8>>) {
    let headers = response.headers_mut();
    headers.remove(header::CONTENT_SECURITY_POLICY);
    headers.insert(header::CONTENT_TYPE, header::HeaderValue::from_static("model/gltf-binary"));
    match bytes {
        Some(bytes) => {
            headers.insert(header::CONTENT_LENGTH, header::HeaderValue::from(bytes.len()));
            *response.status_mut() = StatusCode::OK;
            *response.body_mut() = Cow::Owned(bytes);
        }
        None => {
            headers.insert(header::CONTENT_LENGTH, header::HeaderValue::from_static("0"));
            *response.status_mut() = StatusCode::NOT_FOUND;
            *response.body_mut() = Cow::Borrowed(&[]);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page_response() -> Response<Cow<'static, [u8]>> {
        // What Tauri's SPA fallback hands the handler for an unknown path: index.html with a CSP header.
        Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "text/html")
            .header(header::CONTENT_SECURITY_POLICY, "default-src 'self'")
            .body(Cow::Borrowed(&b"<html></html>"[..]))
            .unwrap()
    }

    #[test]
    fn only_an_absolute_existing_vrm_file_is_accepted() {
        let dir = std::env::temp_dir().join(format!("zumi-test-model-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let vrm = dir.join("a.VRM");
        let txt = dir.join("a.txt");
        std::fs::write(&vrm, b"glTF").unwrap();
        std::fs::write(&txt, b"x").unwrap();
        assert_eq!(validate(vrm.to_str().unwrap()), Some(vrm.clone()));
        assert_eq!(validate(txt.to_str().unwrap()), None, "wrong extension");
        assert_eq!(validate(dir.to_str().unwrap()), None, "a directory");
        assert_eq!(validate(dir.join("missing.vrm").to_str().unwrap()), None, "missing file");
        assert_eq!(validate("relative/a.vrm"), None, "relative path");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_model_flag_is_electrons_flag_argv_only() {
        let argv = |items: &[&str]| items.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(from_args(&argv(&["--selftest", "D:/run", "--model", "D:/avatar.vrm"])), Some("D:/avatar.vrm".to_string()));
        assert_eq!(from_args(&argv(&["--model", "D:/a.vrm", "--model", "D:/b.vrm"])), Some("D:/a.vrm".to_string()));
        assert_eq!(from_args(&argv(&["--model"])), None, "a missing value is not a model");
        assert_eq!(from_args(&argv(&["--data-dir", "D:/data"])), None);
    }

    #[test]
    fn the_file_replaces_the_asset_fallback() {
        let mut response = page_response();
        fill(&mut response, Some(b"glTF-bytes".to_vec()));
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "model/gltf-binary");
        assert!(response.headers().get(header::CONTENT_SECURITY_POLICY).is_none());
        assert_eq!(&response.body()[..], b"glTF-bytes");
        assert_eq!(response.headers()[header::CONTENT_LENGTH], "10", "box re-probe 2ef16d1: /external sent no Content-Length");
    }

    #[test]
    fn an_unreadable_file_is_a_404_not_the_html_page() {
        let mut response = page_response();
        fill(&mut response, None);
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert!(response.body().is_empty());
        assert_eq!(response.headers()[header::CONTENT_LENGTH], "0");
    }

    #[test]
    fn only_the_fixed_route_reads_the_file() {
        let dir = std::env::temp_dir().join(format!("zumi-test-model-route-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let vrm = dir.join("m.vrm");
        std::fs::write(&vrm, b"glTF-route").unwrap();
        // The URL models-core.js builds for the `test` slot, re-homed onto tauri.localhost (query ignored).
        let hit = Request::get("http://tauri.localhost/external/test.vrm?v=1a-2b").body(Vec::new()).unwrap();
        let mut served = page_response();
        serve_file(&vrm, &hit, &mut served);
        assert_eq!(&served.body()[..], b"glTF-route");
        for other in ["http://tauri.localhost/external/user.vrm", "http://tauri.localhost/index.html", "http://tauri.localhost/external/../m.vrm"] {
            let miss = Request::get(other).body(Vec::new()).unwrap();
            let mut untouched = page_response();
            serve_file(&vrm, &miss, &mut untouched);
            assert_eq!(&untouched.body()[..], b"<html></html>", "{other} must not be answered");
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
