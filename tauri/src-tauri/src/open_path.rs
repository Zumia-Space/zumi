// T-31 parity step 9-2 — the owner-only `shell.openPath` primitive.
//
// The HUD's consent answer (`hud-host.mjs` -> `hud-feed.mjs` createConsentGate -> `board-open.mjs`
// decideOpenRef) decides in the sidecar. This module is the second, independent check before
// ShellExecuteW: the sidecar's decision and the open are separated by a process boundary and time, so the
// path is re-validated here against the SAME roots and extension list (the time-of-check/time-of-use gap).
//
// Rules (a port of `decideLocalPath` + the SOL-BRIEF-openpath probe cases):
//   - owner build only (`not_owner_build` otherwise);
//   - an absolute drive path (no UNC, no `\\?\`, no relative path, no NUL);
//   - no `:` past the drive letter (an alternate data stream: `run.cmd:x.md` would read as `.md`);
//   - no path part ending in a dot or a space ("run.cmd." is run.cmd to Win32);
//   - the REAL path (junctions, 8.3 names, `..` resolved) under this flavour's roots (`open_roots`);
//   - the resolved path is checked for the same name tricks again, then a folder or OPEN_EXT file.
//
// Tests inject both the filesystem answer and the ShellExecute call, so every branch is asserted without
// opening anything and without depending on this PC's folders.

use std::path::Path;
use std::time::Duration;

use serde_json::{json, Value};

/// The OWNER flavour's roots: the owner's own folders, compiled in from the owner-only values file (`openRoots` of
/// src/main/owner-values.json, build.rs); the same key `src/main/board-open.mjs` OPEN_ROOTS reads. A tree without that file
/// has none. Each keeps its trailing slash: it makes the prefix check a real folder boundary (a sibling `<root>-evil/` must
/// never match).
pub fn owner_open_roots() -> Vec<String> {
    env!("ZUMI_OWNER_OPEN_ROOTS").split('|').filter(|r| !r.is_empty()).map(str::to_string).collect()
}

/// The roots of this build's flavour (the host's own flavour answer, `read_owner_admin`). Owner: exactly owner_open_roots.
/// Public: only the app's own data dir (none when it is unknown). `decide_local_path` still refuses a public build
/// first (`not_owner_build`); this only decides which folders a flavour could ever name.
pub fn open_roots(owner: bool, app_data_dir: Option<&Path>) -> Vec<String> {
    if owner {
        return owner_open_roots();
    }
    app_data_dir
        .map(|d| format!("{}/", forward_slashes(&d.to_string_lossy()).trim_end_matches('/')))
        .into_iter()
        .collect()
}

/// Same list as `src/main/board-open.mjs` OPEN_EXT (lower-case, with the dot).
pub const OPEN_EXT: [&str; 10] = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".html", ".md", ".webm", ".mp4", ".pdf"];

/// The host methods the sidecar may call; everything else is refused before it can do anything.
pub const HOST_OPEN_PATH: &str = "__sidecarHost.shell.openPath";
pub const HOST_OPEN_EXTERNAL: &str = "__sidecarHost.shell.openExternal";

/// A shell open should be immediate; a queued main-thread job that never runs is cancelled, not retried.
pub const OPEN_TIMEOUT: Duration = Duration::from_secs(10);

/// Why the primitive refused. `reason()` is the fixed word the log/reply carries.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Refusal {
    NotOwner,
    NotAbsoluteDrivePath,
    NameTrick,
    NotFound,
    OutsideAllowedFolders,
    TypeNotAllowed,
}

impl Refusal {
    pub fn reason(self) -> &'static str {
        match self {
            Refusal::NotOwner => "not_owner_build",
            Refusal::NotAbsoluteDrivePath => "not_an_absolute_drive_path",
            Refusal::NameTrick => "name_trick",
            Refusal::NotFound => "not_found",
            Refusal::OutsideAllowedFolders => "outside_allowed_folders",
            Refusal::TypeNotAllowed => "type_not_allowed",
        }
    }
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Kind {
    File,
    Folder,
}

#[derive(Debug, PartialEq, Eq, Clone)]
pub struct Decision {
    /// The canonical path to hand to ShellExecuteW (no `\\?\` prefix; native separators).
    pub path: String,
    pub kind: Kind,
}

/// `:` past the drive letter (an ADS) or a part ending in a dot/space (Win32 trims both). `.` and `..`
/// parts are left to the resolver and the root check, exactly like board-open.mjs `nameTrick`.
fn has_name_trick(p: &str) -> bool {
    if p.char_indices().any(|(i, c)| c == ':' && i >= 2) {
        return true;
    }
    p.split(['\\', '/'])
        .any(|part| part != "." && part != ".." && (part.ends_with('.') || part.ends_with(' ')))
}

/// An absolute drive path, but not a doubled separator (`D:\\foo`) and not a UNC/verbatim form.
fn is_absolute_drive_path(p: &str) -> bool {
    let b = p.as_bytes();
    if b.len() < 3 || !b[0].is_ascii_alphabetic() || b[1] != b':' || (b[2] != b'\\' && b[2] != b'/') {
        return false;
    }
    !(b.len() > 3 && (b[3] == b'\\' || b[3] == b'/'))
}

fn strip_verbatim(p: &str) -> &str {
    p.strip_prefix("\\\\?\\").unwrap_or(p)
}

fn forward_slashes(p: &str) -> String {
    strip_verbatim(p).replace('\\', "/")
}

fn under_roots(fwd: &str, roots: &[&str]) -> bool {
    let lower = fwd.to_lowercase();
    roots.iter().any(|root| lower.starts_with(&root.to_lowercase()))
}

fn win_ext(fwd: &str) -> String {
    let base = fwd.rsplit('/').next().unwrap_or("");
    match base.rfind('.') {
        Some(i) if i > 0 => base[i..].to_ascii_lowercase(),
        _ => String::new(),
    }
}

/// Re-validate one sidecar-supplied path. No shell call. `realpath` returns the resolved path (it may be a
/// verbatim `\\?\` path); `stat` says what the resolved path is.
pub fn decide_local_path(
    p: &str,
    owner: bool,
    roots: &[&str],
    realpath: impl Fn(&str) -> Result<String, ()>,
    stat: impl Fn(&str) -> Result<Kind, ()>,
) -> Result<Decision, Refusal> {
    if !owner {
        return Err(Refusal::NotOwner);
    }
    if p.is_empty() || p.contains('\0') || !is_absolute_drive_path(p) {
        return Err(Refusal::NotAbsoluteDrivePath);
    }
    // Check the asked path before resolving, then the resolved path again: a junction target could carry
    // the trick the asked path did not.
    if has_name_trick(p) {
        return Err(Refusal::NameTrick);
    }
    let real = realpath(p).map_err(|_| Refusal::NotFound)?;
    let fwd = forward_slashes(&real);
    if !is_absolute_drive_path(&fwd) || has_name_trick(&fwd) {
        return Err(Refusal::NameTrick);
    }
    if !under_roots(&fwd, roots) {
        return Err(Refusal::OutsideAllowedFolders);
    }
    match stat(&real).map_err(|_| Refusal::NotFound)? {
        Kind::Folder => Ok(Decision { path: strip_verbatim(&real).to_string(), kind: Kind::Folder }),
        Kind::File => {
            let ext = win_ext(&fwd);
            if OPEN_EXT.contains(&ext.as_str()) {
                Ok(Decision { path: strip_verbatim(&real).to_string(), kind: Kind::File })
            } else {
                Err(Refusal::TypeNotAllowed)
            }
        }
    }
}

/// Re-validate, then hand the resolved path to `shell`. The shell closure is injected so tests never open; the
/// production app uses `open_path_on_main_with_timeout` (same decision, then the main-thread scheduler).
#[cfg(test)]
pub fn open_path_with(
    p: &str,
    owner: bool,
    roots: &[&str],
    realpath: impl Fn(&str) -> Result<String, ()>,
    stat: impl Fn(&str) -> Result<Kind, ()>,
    shell: impl FnOnce(&str) -> Result<(), String>,
) -> Result<Decision, String> {
    let decision = decide_local_path(p, owner, roots, realpath, stat).map_err(|r| r.reason().to_string())?;
    shell(&decision.path)?;
    Ok(decision)
}

/// The production filesystem answers.
pub fn realpath_native(p: &str) -> Result<String, ()> {
    std::fs::canonicalize(Path::new(p))
        .map(|pb| pb.to_string_lossy().to_string())
        .map_err(|_| ())
}

pub fn stat_native(p: &str) -> Result<Kind, ()> {
    let md = std::fs::metadata(Path::new(p)).map_err(|_| ())?;
    if md.is_dir() {
        Ok(Kind::Folder)
    } else if md.is_file() {
        Ok(Kind::File)
    } else {
        Err(())
    }
}

/// The production decision: this build's roots, the real filesystem, owner required.
pub fn decide_production(p: &str, owner: bool, app_data_dir: Option<&Path>) -> Result<Decision, Refusal> {
    decide_with_roots(p, owner, &open_roots(owner, app_data_dir))
}

/// `decide_local_path` on the real filesystem (canonicalize + metadata) against `roots`.
pub fn decide_with_roots(p: &str, owner: bool, roots: &[String]) -> Result<Decision, Refusal> {
    let refs: Vec<&str> = roots.iter().map(String::as_str).collect();
    decide_local_path(p, owner, &refs, &realpath_native, &stat_native)
}

/// Run a validated decision's path on the main thread. `schedule` is injected (`AppHandle::run_on_main_thread`
/// in production) for the same reason shell_ops takes it: a test owns no window.
pub fn open_checked_on_main_with_timeout(
    decision: &Decision,
    timeout: Duration,
    schedule: impl FnOnce(Box<dyn FnOnce() + Send + 'static>) -> Result<(), String>,
    shell: impl FnOnce(&str) -> Result<(), String> + Send + 'static,
) -> Result<(), String> {
    crate::shell_ops::open_on_main_with_timeout(&decision.path, timeout, schedule, shell)
}

/// Re-validate and run the open on the main thread (production: `shell_ops::shell_execute`).
pub fn open_path_on_main_with_timeout(
    p: &str,
    owner: bool,
    app_data_dir: Option<&Path>,
    timeout: Duration,
    schedule: impl FnOnce(Box<dyn FnOnce() + Send + 'static>) -> Result<(), String>,
    shell: impl FnOnce(&str) -> Result<(), String> + Send + 'static,
) -> Result<Decision, String> {
    let decision = decide_production(p, owner, app_data_dir).map_err(|r| r.reason().to_string())?;
    open_checked_on_main_with_timeout(&decision, timeout, schedule, shell)?;
    Ok(decision)
}

/// Dispatch one sidecar -> host request. `owner` is the host's own flavour answer (never the sidecar's
/// claim). Both openers run the independent re-validation they are wired to; this function only routes.
pub fn dispatch_host_request(
    method: &str,
    args: &[Value],
    owner: bool,
    open_path: impl FnOnce(&str) -> Result<(), String>,
    open_external: impl FnOnce(&str) -> Result<(), String>,
) -> Result<Value, String> {
    let arg = |args: &[Value]| args.first().and_then(Value::as_str).map(str::to_string);
    match method {
        HOST_OPEN_PATH if owner => {
            let p = arg(args).ok_or_else(|| "bad_request".to_string())?;
            open_path(&p)?;
            Ok(json!({ "action": "openPath" }))
        }
        HOST_OPEN_EXTERNAL if owner => {
            let url = arg(args).ok_or_else(|| "bad_request".to_string())?;
            open_external(&url)?;
            Ok(json!({ "action": "openExternal" }))
        }
        HOST_OPEN_PATH | HOST_OPEN_EXTERNAL => Err("not_owner_build".to_string()),
        _ => Err(format!("unknown_host_method:{method}")),
    }
}

/// Owner flag from a flavour file's text. Fail closed: any malformed document, wrong version or non-true
/// value is the public flavour. The full schema is flavour.mjs's job; this only refuses to read "owner" out
/// of anything doubtful.
pub fn owner_admin_from_flavour_text(text: &str) -> bool {
    if text.len() > 4096 {
        return false;
    }
    let Ok(doc) = serde_json::from_str::<Value>(text) else { return false };
    doc.get("v").and_then(Value::as_u64) == Some(1)
        && doc.get("ownerAdmin").and_then(Value::as_bool) == Some(true)
}

/// Read the flavour file the host already found beside its exe.
pub fn read_owner_admin(path: &Path) -> bool {
    if path.file_name().and_then(|n| n.to_str()) != Some("flavour.json") {
        return false;
    }
    std::fs::read_to_string(path).map(|t| owner_admin_from_flavour_text(&t)).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    // The probe table ported here is the openpath review's Evidence list: junctions, `..`, script/shortcut types,
    // look-alike roots, relative/UNC/NUL, ADS and trailing dot/space, plus the resolved-path checks the code itself adds.
    // Paths sit under the OS temp dir (`root()`); the string cases inject the resolver, so nothing there is touched.
    use std::cell::RefCell;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    use super::*;

    /// The test root: `<temp>/zumi-open-root/`, forward slashes and a trailing slash, like an owner root.
    fn root() -> String {
        format!("{}/zumi-open-root/", forward_slashes(&std::env::temp_dir().to_string_lossy()).trim_end_matches('/'))
    }

    /// A path under the test root, as asked (forward slashes).
    fn at(rel: &str) -> String {
        format!("{}{rel}", root())
    }

    /// A path beside the test root (same parent), as asked.
    fn beside(rel: &str) -> String {
        format!("{}/{rel}", root().trim_end_matches('/').rsplit_once('/').unwrap().0)
    }

    /// The resolver's answer for an asked path: native separators.
    fn native(p: &str) -> String {
        p.replace('/', "\\")
    }

    fn lookup_real(real: &[(String, String)], p: &str) -> Result<String, ()> {
        real.iter().find(|(asked, _)| asked == p).map(|(_, r)| r.clone()).ok_or(())
    }

    fn run(p: &str, owner: bool, real: &[(String, String)], kind: Kind) -> Result<Decision, Refusal> {
        let realpath = |q: &str| lookup_real(real, q);
        let stat = |_q: &str| Ok(kind);
        let r = root();
        decide_local_path(p, owner, &[r.as_str()], &realpath, &stat)
    }

    fn run_real(p: &str, real: &[(String, String)]) -> Result<Decision, Refusal> {
        run(p, true, real, Kind::File)
    }

    /// The asked path resolves to itself.
    fn same(p: &str) -> Vec<(String, String)> {
        vec![(p.to_string(), native(p))]
    }

    // ---- roots by flavour ----

    /// The owner values file's `openRoots` as this test reads it NOW (none when the tree has no such file).
    fn owner_values_open_roots() -> Vec<String> {
        let file = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src/main/owner-values.json");
        match std::fs::read_to_string(&file) {
            Ok(text) => serde_json::from_str::<Value>(&text).unwrap()["openRoots"].as_array().unwrap().iter().map(|r| r.as_str().unwrap().to_string()).collect(),
            Err(_) => Vec::new(),
        }
    }

    #[test]
    fn the_compiled_owner_roots_are_the_owner_values_file_open_roots() {
        assert_eq!(owner_open_roots(), owner_values_open_roots());
        for r in owner_open_roots() {
            assert!(r.ends_with('/'), "{r}: an owner root keeps its trailing slash (a real folder boundary)");
        }
    }

    #[test]
    fn the_owner_flavour_keeps_exactly_the_owner_roots() {
        let app_data = std::env::temp_dir().join("zumi-app-data");
        assert_eq!(open_roots(true, Some(&app_data)), owner_open_roots());
        assert_eq!(open_roots(true, None), owner_open_roots());
        // owner open-path still allows a file under each owner root (resolver injected: no owner folder is read)
        let roots = open_roots(true, Some(&app_data));
        let refs: Vec<&str> = roots.iter().map(String::as_str).collect();
        let asks = owner_open_roots().iter().flat_map(|r| [(format!("{r}t/a.md"), Kind::File), (format!("{r}F/clip.webm"), Kind::File), (format!("{r}t/pack"), Kind::Folder)]).collect::<Vec<_>>();
        for (asked, kind) in asks {
            let real = native(&asked);
            let d = decide_local_path(&asked, true, &refs, |q: &str| if q == asked { Ok(real.clone()) } else { Err(()) }, |_q: &str| Ok(kind));
            assert_eq!(d, Ok(Decision { path: real.clone(), kind }), "{asked}");
        }
        // ...and the app data dir is not an owner root
        let in_app_data = format!("{}/a.md", forward_slashes(&app_data.to_string_lossy()));
        let real = native(&in_app_data);
        assert_eq!(decide_local_path(&in_app_data, true, &refs, |_q: &str| Ok(real.clone()), |_q: &str| Ok(Kind::File)), Err(Refusal::OutsideAllowedFolders));
    }

    #[test]
    fn the_public_flavour_has_only_the_app_data_dir() {
        let app_data = std::env::temp_dir().join("zumi-app-data");
        let fwd = format!("{}/", forward_slashes(&app_data.to_string_lossy()).trim_end_matches('/'));
        let public = open_roots(false, Some(&app_data));
        assert_eq!(public, vec![fwd.clone()]);
        let refs: Vec<&str> = public.iter().map(String::as_str).collect();
        for owner_root in owner_open_roots() {
            assert!(!under_roots(&format!("{owner_root}t/a.md"), &refs), "public must not reach {owner_root}");
        }
        assert!(under_roots(&format!("{fwd}notes/a.md"), &refs), "public reaches its app data dir");
        assert!(!under_roots(&format!("{}-evil/a.md", fwd.trim_end_matches('/')), &refs), "a sibling -evil dir is not the app data dir");
        assert!(open_roots(false, None).is_empty(), "no app data dir known: no root at all");
        // the production decision of a public build is still refused before any root is consulted
        assert_eq!(decide_production(&format!("{fwd}a.md"), false, Some(&app_data)), Err(Refusal::NotOwner));
        for owner_root in owner_open_roots() {
            assert_eq!(decide_production(&format!("{owner_root}t/a.md"), false, Some(&app_data)), Err(Refusal::NotOwner));
        }
    }

    // ---- opened ----

    #[test]
    fn an_allowed_markdown_file_opens_at_its_real_path() {
        let p = at("t/notes.md");
        let d = run_real(&p, &same(&p)).unwrap();
        assert_eq!(d.kind, Kind::File);
        assert_eq!(d.path, native(&p));
    }

    #[test]
    fn every_allowed_extension_is_accepted_case_insensitively() {
        for rel in ["a.png", "a.JPG", "a.jpeg", "a.webp", "a.gif", "a.html", "a.MD", "a.webm", "a.mp4", "a.pdf", "F/clip.webm"] {
            let p = at(rel);
            assert_eq!(run_real(&p, &same(&p)).map(|d| d.kind), Ok(Kind::File), "{p}");
        }
    }

    #[test]
    fn a_folder_opens_without_an_extension() {
        let p = at("c/MORNING-PACK");
        let d = run(&p, true, &same(&p), Kind::Folder).unwrap();
        assert_eq!(d.kind, Kind::Folder);
        assert_eq!(d.path, native(&p));
    }

    // ---- refused: owner, absolute form, name tricks ----

    #[test]
    fn the_release_flavour_is_refused_before_any_filesystem_work() {
        let called = RefCell::new(0);
        let real = native(&at("a.md"));
        let realpath = |_q: &str| { *called.borrow_mut() += 1; Ok(real.clone()) };
        let stat = |_q: &str| Ok(Kind::File);
        let r = root();
        assert_eq!(decide_local_path(&at("a.md"), false, &[r.as_str()], &realpath, &stat), Err(Refusal::NotOwner));
        assert_eq!(*called.borrow(), 0, "the resolver is not asked in a release build");
    }

    #[test]
    fn relative_unc_verbatim_and_nul_paths_are_not_absolute_drive_paths() {
        let verbatim = format!(r"\\?\{}", native(&at("a.md")));
        let device = format!(r"\\.\{}", native(&at("a.md")));
        let device_cmd = format!(r"\\.\{}", native(&at("x/run.cmd")));
        let nul = format!("{}\0.exe", at("a.md"));
        for p in [
            "notes/t/a.md",
            "",
            "C:relative.md",
            r"\\server\share\a.md",
            "//server/share/a.md",
            r"\\?\C:\data\a.md",
            verbatim.as_str(),
            device.as_str(),
            device_cmd.as_str(),
            nul.as_str(),
        ] {
            assert_eq!(run_real(p, &[]), Err(Refusal::NotAbsoluteDrivePath), "{p:?}");
        }
    }

    #[test]
    fn a_doubled_separator_after_the_drive_is_refused() {
        let r = root();
        let (drive, rest) = r.split_at(2);
        assert_eq!(run_real(&format!(r"{drive}\\{}a.md", native(&rest[1..])), &[]), Err(Refusal::NotAbsoluteDrivePath));
        assert_eq!(run_real(&format!("{drive}//{}a.md", &rest[1..]), &[]), Err(Refusal::NotAbsoluteDrivePath));
    }

    #[test]
    fn an_alternate_data_stream_is_a_name_trick() {
        for p in [
            at("x/run.cmd:x.md"),
            at("x/run.cmd:x.md:$DATA"),
            at("t/notes.md::$DATA"),
            at("x/notes.md:evil.cmd"),
            at("x/notes.md:$DATA"),
            at("C:/x.md"),
            native(&at("x/run.cmd:x.md")),
        ] {
            assert_eq!(run_real(&p, &[]), Err(Refusal::NameTrick), "{p}");
        }
    }

    #[test]
    fn a_part_ending_in_a_dot_or_a_space_is_a_name_trick() {
        let r = root();
        let bare = r.trim_end_matches('/');
        for p in [
            at("x/run.cmd."),
            at("x/run.cmd "),
            at("x/run.cmd ."),
            at("t/notes.md."),
            at("t/notes.md "),
            format!("{bare}./t/notes.md"),
            at("t /notes.md"),
            native(&at("x/run.cmd.")),
        ] {
            assert_eq!(run_real(&p, &[]), Err(Refusal::NameTrick), "{p:?}");
        }
    }

    #[test]
    fn the_resolved_path_is_checked_for_the_same_tricks() {
        // The resolver (a junction, an 8.3 name, a server) answers with a stream or a trailing-dot part.
        for (asked, real) in [
            (at("x/short.md"), native(&at("x/run.cmd:x.md"))),
            (at("x/short2.md"), native(&at("x./a.md"))),
            (at("x/short3.md"), native(&at("x/a.md "))),
        ] {
            assert_eq!(run_real(&asked, &[(asked.clone(), real)]), Err(Refusal::NameTrick), "{asked}");
        }
    }

    // ---- refused: roots and types ----

    #[test]
    fn a_junction_out_of_the_roots_is_refused_after_resolution() {
        let asked = at("f/homepage/index.html");
        assert_eq!(run_real(&asked, &[(asked.clone(), native(&beside("wt/homepage/index.html")))]), Err(Refusal::OutsideAllowedFolders));
    }

    #[test]
    fn dotdot_out_of_the_roots_is_refused_after_resolution() {
        let asked = at("../TOOL/x.md");
        assert_eq!(run_real(&asked, &[(asked.clone(), native(&beside("TOOL/x.md")))]), Err(Refusal::OutsideAllowedFolders));
    }

    #[test]
    fn a_look_alike_root_is_not_under_a_root() {
        let r = root();
        let bare = r.trim_end_matches('/');
        for asked in [format!("{bare}-evil/a.md"), format!("{bare}_evil/a.md"), format!("{bare}s/a.md")] {
            assert_eq!(run_real(&asked, &same(&asked)), Err(Refusal::OutsideAllowedFolders), "{asked}");
        }
    }

    #[test]
    fn the_folders_that_are_not_allowed_are_refused() {
        for asked in [beside("TOOL/secret.md"), beside("_secrets/staging.env"), "C:/Windows/System32/calc.exe".to_string()] {
            assert_eq!(run_real(&asked, &same(&asked)), Err(Refusal::OutsideAllowedFolders), "{asked}");
        }
    }

    #[test]
    fn script_and_shortcut_types_are_refused() {
        for rel in ["board/board-cli.mjs", "x/run.cmd", "x/run.exe", "x/a.md.lnk", "x/a.ps1", "x/a.bat"] {
            let asked = at(rel);
            assert_eq!(run_real(&asked, &same(&asked)), Err(Refusal::TypeNotAllowed), "{asked}");
        }
    }

    #[test]
    fn a_missing_path_is_not_found() {
        assert_eq!(run_real(&at("nope.md"), &[]), Err(Refusal::NotFound));
    }

    // ---- 8.3 short names and junctions on the real filesystem ----

    #[test]
    fn an_8_3_short_name_is_judged_by_its_resolved_long_path() {
        // 8.3 generation may be disabled on the volume, so the resolver's answer is injected: the point is that the
        // LONG path from the resolver is what the root/extension/name checks see.
        let short = beside("ZUMI-O~1/a.md");
        assert_eq!(run_real(&short, &[(short.clone(), native(&at("a.md")))]).map(|d| d.kind), Ok(Kind::File));
        assert_eq!(run_real(&short, &[(short.clone(), native(&beside("TOOL/a.md")))]), Err(Refusal::OutsideAllowedFolders));
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("target").join("open-path-tests").join(format!("{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_real_junction_out_of_the_root_is_refused_and_one_inside_is_allowed() {
        let base = scratch("junction");
        let root = base.join("root");
        let outside = base.join("outside");
        let real = root.join("real");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::create_dir_all(&real).unwrap();
        std::fs::write(outside.join("a.md"), "# outside\n").unwrap();
        std::fs::write(real.join("b.md"), "# inside\n").unwrap();
        let link_out = root.join("link-out");
        let link_in = root.join("link-in");
        let made = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link_out)
            .arg(&outside)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        let made_in = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link_in)
            .arg(&real)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        assert!(made && made_in, "this PC must allow a test junction (the probe case)");
        let roots = [root.to_string_lossy().replace('\\', "/") + "/"];
        let root_refs: Vec<&str> = roots.iter().map(String::as_str).collect();
        let out = link_out.join("a.md").to_string_lossy().to_string();
        let inside = link_in.join("b.md").to_string_lossy().to_string();
        let realpath = |p: &str| realpath_native(p);
        let stat = |p: &str| stat_native(p);
        assert_eq!(decide_local_path(&out, true, &root_refs, &realpath, &stat), Err(Refusal::OutsideAllowedFolders));
        assert_eq!(decide_local_path(&inside, true, &root_refs, &realpath, &stat).map(|d| d.kind), Ok(Kind::File));
        std::fs::remove_dir_all(&base).unwrap();
    }

    /// P3-B gate C2 (mutant R11): the PRODUCTION composition (`decide_with_roots`, which `decide_production` calls: real
    /// canonicalize + metadata) against a real junction under a scratch root. A composition that skipped canonicalize
    /// would judge the junction's own path (inside the root) and open a file outside it.
    #[test]
    fn the_production_decision_resolves_a_real_junction_out_of_the_root() {
        let base = scratch("prod-root");
        let outside = scratch("prod-outside");
        std::fs::write(outside.join("secret.md"), "# outside\n").unwrap();
        std::fs::write(base.join("note.md"), "# inside\n").unwrap();
        std::fs::write(base.join("tool.exe"), "MZ").unwrap();
        let link = base.join("jn");
        let made = std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(link.to_string_lossy().replace('/', "\\")).arg(&outside).output().map(|o| o.status.success()).unwrap_or(false);
        let roots = vec![format!("{}/", forward_slashes(&base.to_string_lossy()).trim_end_matches('/'))];
        let note = base.join("note.md").to_string_lossy().to_string();
        let exe = base.join("tool.exe").to_string_lossy().to_string();
        let escaped = link.join("secret.md").to_string_lossy().to_string();
        let traversal = format!("{}/../prod-outside-{}/secret.md", base.to_string_lossy().replace('\\', "/"), std::process::id());
        let results = (
            decide_with_roots(&note, true, &roots).map(|d| d.kind),
            decide_with_roots(&note, false, &roots),
            decide_with_roots(&exe, true, &roots),
            if made { Some(decide_with_roots(&escaped, true, &roots)) } else { None },
            decide_with_roots(&traversal, true, &roots),
        );
        let _ = std::fs::remove_dir(&link); // a junction: removes the link only, never the target
        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::remove_dir_all(&outside);
        assert_eq!(results.0, Ok(Kind::File), "a valid md under the root opens");
        assert_eq!(results.1, Err(Refusal::NotOwner), "the public flavour is refused");
        assert_eq!(results.2, Err(Refusal::TypeNotAllowed), ".exe is refused");
        assert!(made, "this PC must allow a test junction");
        assert_eq!(results.3, Some(Err(Refusal::OutsideAllowedFolders)), "a junction inside the root pointing outside is refused by the real path");
        assert!(matches!(results.4, Err(Refusal::OutsideAllowedFolders) | Err(Refusal::NotFound)), "a .. traversal out of the root is refused: {:?}", results.4);
    }

    /// A hard failure instead of a silent SKIP when the gate run asks for the link cases (`ZUMI_REQUIRE_LINKS=1`).
    fn require_links() -> bool {
        std::env::var("ZUMI_REQUIRE_LINKS").map(|v| v == "1").unwrap_or(false)
    }

    #[test]
    fn a_file_symlink_inside_the_root_is_judged_by_its_resolved_cmd_target() {
        let base = scratch("symlink-cmd");
        let root = base.join("root");
        let target = root.join("run.cmd");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(&target, b"@echo off\n").unwrap();
        let link = root.join("harmless.md");
        match std::os::windows::fs::symlink_file(&target, &link) {
            Ok(()) => {
                let roots = [root.to_string_lossy().replace('\\', "/") + "/"];
                let root_refs: Vec<&str> = roots.iter().map(String::as_str).collect();
                let asked = link.to_string_lossy().to_string();
                assert_eq!(
                    decide_local_path(&asked, true, &root_refs, realpath_native, stat_native),
                    Err(Refusal::TypeNotAllowed),
                    "the realpath is a .cmd, so the resolved-path extension check refuses it"
                );
                let _ = std::fs::remove_file(&link);
            }
            Err(_) if require_links() => {
                panic!("ZUMI_REQUIRE_LINKS=1 but this account cannot create a file symlink (enable Developer Mode)")
            }
            Err(_) => eprintln!("SKIP symlink-to-.cmd case (no symlink privilege on this account)"),
        }
        std::fs::remove_dir_all(&base).ok();
    }

    // ---- the shell seam ----

    #[test]
    fn the_production_opener_validates_before_it_schedules_or_shells() {
        // Gate item 9-1 / mutant O9: the PRODUCTION composition must call decide_production. If it hands the raw path to
        // the scheduler/shell, a refused path reaches ShellExecuteW. Every case below is refused by the decision itself.
        let schedule_calls = Arc::new(AtomicUsize::new(0));
        let shell_calls = Arc::new(AtomicUsize::new(0));
        let outside = Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml").to_string_lossy().to_string();
        // under an owner root, so only the name tricks refuse them (a tree without owner roots: the test root, still refused)
        let owner_root = owner_open_roots().into_iter().next().unwrap_or_else(root);
        let stream = format!("{owner_root}x/run.cmd:x.md");
        let device = format!(r"\\.\{}", native(&format!("{owner_root}a.md")));
        for p in [outside.as_str(), stream.as_str(), "relative/a.md", device.as_str()] {
            let scheduled = schedule_calls.clone();
            let shelled = shell_calls.clone();
            let result = open_path_on_main_with_timeout(
                p,
                true,
                None,
                OPEN_TIMEOUT,
                move |_job| {
                    scheduled.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                },
                move |_| {
                    shelled.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                },
            );
            assert!(result.is_err(), "{p:?} must be refused by the production opener");
        }
        assert_eq!(schedule_calls.load(Ordering::SeqCst), 0, "a refused path is never queued on the main thread");
        assert_eq!(shell_calls.load(Ordering::SeqCst), 0, "a refused path never reaches the shell");
    }

    #[test]
    fn the_shell_is_called_only_after_a_positive_decision() {
        let seen = RefCell::new(Vec::<String>::new());
        let (md, mjs) = (native(&at("a.md")), native(&at("a.mjs")));
        let realpath = |q: &str| Ok(if q.ends_with(".mjs") { mjs.clone() } else { md.clone() });
        let stat = |_q: &str| Ok(Kind::File);
        let r = root();
        let ok = open_path_with(&at("a.md"), true, &[r.as_str()], &realpath, &stat, |p| {
            seen.borrow_mut().push(p.to_string());
            Ok(())
        })
        .unwrap();
        assert_eq!(ok.kind, Kind::File);
        assert_eq!(*seen.borrow(), vec![md.clone()]);

        let refused = open_path_with(&at("a.mjs"), true, &[r.as_str()], &realpath, &stat, |p| {
            seen.borrow_mut().push(p.to_string());
            Ok(())
        });
        assert_eq!(refused.unwrap_err(), "type_not_allowed");
        assert_eq!(seen.borrow().len(), 1, "a refused path never reaches the shell");
    }

    #[test]
    fn a_timed_out_open_never_fires_late() {
        let opened = Arc::new(AtomicUsize::new(0));
        let queued: Arc<std::sync::Mutex<Option<Box<dyn FnOnce() + Send>>>> = Arc::new(std::sync::Mutex::new(None));
        let slot = queued.clone();
        let shell_opened = opened.clone();
        let decision = Decision { path: native(&at("a.md")), kind: Kind::File };
        let result = open_checked_on_main_with_timeout(
            &decision,
            Duration::from_millis(20),
            move |job| { *slot.lock().unwrap() = Some(job); Ok(()) },
            move |_| { shell_opened.fetch_add(1, Ordering::SeqCst); Ok(()) },
        );
        assert_eq!(result.unwrap_err(), "shell_timeout");
        let job = queued.lock().unwrap().take().expect("the job was queued");
        job();
        assert_eq!(opened.load(Ordering::SeqCst), 0, "a timed-out open must not fire later");
    }

    // ---- the reverse-channel dispatch ----

    #[test]
    fn a_release_build_refuses_both_openers_without_running_them() {
        for method in [HOST_OPEN_PATH, HOST_OPEN_EXTERNAL] {
            let res = dispatch_host_request(method, &[json!(at("a.md"))], false, |_| panic!("no openPath"), |_| panic!("no openExternal"));
            assert_eq!(res.unwrap_err(), "not_owner_build");
        }
    }

    #[test]
    fn only_the_two_fixed_host_methods_are_served() {
        for method in ["__sidecarHost.shell.open", "__sidecarHost.shell.openPath ", "__host.decideExternalUrl", "hud.answer", ""] {
            let res = dispatch_host_request(method, &[json!("x")], true, |_| panic!("no openPath"), |_| panic!("no openExternal"));
            assert_eq!(res.unwrap_err(), format!("unknown_host_method:{method}"));
        }
    }

    #[test]
    fn the_owner_open_path_and_open_external_routes_hand_over_one_string() {
        let seen = RefCell::new(Vec::<(String, String)>::new());
        let res = dispatch_host_request(HOST_OPEN_PATH, &[json!(at("a.md"))], true, |p| {
            seen.borrow_mut().push(("path".to_string(), p.to_string()));
            Ok(())
        }, |_| panic!("no openExternal"));
        assert_eq!(res.unwrap(), json!({ "action": "openPath" }));
        let res = dispatch_host_request(HOST_OPEN_EXTERNAL, &[json!("http://127.0.0.1:4320/")], true, |_| panic!("no openPath"), |u| {
            seen.borrow_mut().push(("url".to_string(), u.to_string()));
            Ok(())
        });
        assert_eq!(res.unwrap(), json!({ "action": "openExternal" }));
        assert_eq!(*seen.borrow(), vec![("path".to_string(), at("a.md")), ("url".to_string(), "http://127.0.0.1:4320/".to_string())]);
    }

    #[test]
    fn a_missing_argument_is_bad_request() {
        for method in [HOST_OPEN_PATH, HOST_OPEN_EXTERNAL] {
            let res = dispatch_host_request(method, &[], true, |_| panic!("no openPath"), |_| panic!("no openExternal"));
            assert_eq!(res.unwrap_err(), "bad_request");
            let res = dispatch_host_request(method, &[json!(42)], true, |_| panic!("no openPath"), |_| panic!("no openExternal"));
            assert_eq!(res.unwrap_err(), "bad_request");
        }
    }

    // ---- owner flag ----

    #[test]
    fn the_owner_flag_reads_only_a_versioned_owner_flavour() {
        let owner = r#"{"v":1,"cloudBase":null,"test":true,"reflexEgress":true,"ownerAdmin":true,"boardMirror":null}"#;
        assert!(owner_admin_from_flavour_text(owner));
        assert!(!owner_admin_from_flavour_text(&owner.replace("true,\"boardMirror\"", "false,\"boardMirror\"")));
        assert!(!owner_admin_from_flavour_text(r#"{"v":2,"ownerAdmin":true}"#));
        assert!(!owner_admin_from_flavour_text(r#"{"ownerAdmin":true}"#));
        assert!(!owner_admin_from_flavour_text(r#"{"v":1,"ownerAdmin":"true"}"#));
        assert!(!owner_admin_from_flavour_text("not json"));
        assert!(!owner_admin_from_flavour_text(""));
    }
}
