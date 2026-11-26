//! P2 hands policy: which apps the hands may act on, and the per-action rules that refuse regardless of the app.
//! Pure decisions (no Win32), each with a bite test and a pass twin.
//!
//!   * app allowlist: the target process's executable must be on the policy file's list (P2 default: Notepad)
//!   * own window: never act on a window of this helper's own process (overlay, test windows)
//!   * password field: never type into or set the value of a password field
//!   * freshness (CoS rule): never act while the cached snapshot is still updating, or when the cache has not been
//!     updated since our last action on that window; the caller waits up to FRESH_WAIT_MS, then fails closed
use crate::rails::Refusal;
use serde_json::Value;
use std::path::Path;
use std::time::{Duration, Instant};

/// Longest a hands action waits for the cache to become current before it refuses (`stale_cache`).
pub const FRESH_WAIT_MS: u64 = 2000;

#[derive(Debug, Clone, PartialEq)]
pub struct Policy {
    /// Full executable paths, compared case-insensitively.
    pub apps: Vec<String>,
    /// Per executable (lower case), the arguments `launch` may pass. No rule: no arguments at all (review R2 B1:
    /// an allowlisted app given free arguments can start anything, e.g. Explorer opening an .exe).
    pub args: Vec<(String, ArgRule)>,
    /// Which policy this is: an FNV-64 of the policy file's text ("default" without a file). A pack acceptance holds
    /// only for the version it was given for.
    pub version: String,
    /// Per executable (lower case), what the hands may do in its UI (CoS R5 root change: an allowlist, not a set of
    /// denials). No rule for an app: nothing acts in it.
    pub ui: Vec<(String, UiRule)>,
}

/// The action allowlist for one app: the window classes the hands may act in (its main window and any owned window
/// meant to be used), per control type the verbs allowed on it (each verb is one UIA pattern call, or `type` / `key`
/// for keystrokes into a focused element of that type), and the whitespace `type` may send besides printable text.
#[derive(Debug, Clone, PartialEq)]
pub struct UiRule {
    pub windows: Vec<String>,
    /// (control type, verbs, element names): with names, only those elements of the type (review R6 B2: a type-wide
    /// rule admitted Paint's Help and Edit with Paint 3D); without, every element of the type.
    pub controls: Vec<(String, Vec<String>, Option<Vec<String>>)>,
    pub whitespace: Vec<char>,
}

/// Opt-in skill packs (CoS E1 = (a)): apps that stay refused, even when the policy lists them, until the user has
/// accepted the pack's risk warning for this policy version. (pack, executable, warning.)
pub const PACKS: [(&str, &str, &str); 1] = [(
    "explorer",
    r"C:\Windows\explorer.exe",
    "Explorer skill pack: through Explorer the hands can start any program on this PC, not only the apps on the \
     allowlist (opening a file runs the program it belongs to). Turn it on only if you accept that risk.",
)];

/// The same warning in Vietnamese, shown with the English one (roadmap 1.5 rule 1).
pub const EXPLORER_WARNING_VI: &str = "Gói Explorer: qua Explorer, tay của Zumi có thể chạy bất kỳ chương trình nào trên máy này, \
     không chỉ các ứng dụng trong danh sách cho phép (mở một tệp sẽ chạy chương trình của tệp đó). Chỉ bật nếu bạn chấp nhận rủi ro này.";

/// The host's acceptance key, read once from the environment and removed from it at once, so a program the helper starts
/// does not inherit it. None when the host passed none (then no acceptance counts).
pub fn host_key() -> Option<&'static [u8]> {
    static KEY: std::sync::OnceLock<Option<Vec<u8>>> = std::sync::OnceLock::new();
    KEY.get_or_init(|| {
        let k = zumi_audit::hostmac::key_from_env();
        std::env::remove_var(zumi_audit::hostmac::KEY_ENV);
        k
    })
    .as_deref()
}

/// Where the acceptances for a policy file are kept: next to it, `<policy file>.accepted.jsonl`. Only the host's own
/// warning dialog writes it (P3 HB-2, zumi-agent-loop `dialog.rs`); the helper only reads it.
pub fn store_path(policy: &Path) -> std::path::PathBuf {
    let mut p = policy.as_os_str().to_owned();
    p.push(".accepted.jsonl");
    p.into()
}

/// One store line, as the host's warning dialog appends it after a person clicked Accept (the dialog is in another
/// crate; this keeps the format under test here).
#[cfg(test)]
pub fn store_line(pack: &str, version: &str, warning_fnv: &str, t_unix_ms: u128, key: &[u8]) -> String {
    let t = (t_unix_ms as u64).to_string();
    let mac = zumi_audit::hostmac::mac_hex(key, &[pack, version, warning_fnv, &t]);
    serde_json::json!({ "pack": pack, "policy_version": version, "warning_fnv": warning_fnv, "t_unix_ms": t_unix_ms as u64, "mac": mac }).to_string()
}

/// The acceptances recorded in a store file (one JSON line per acceptance, written by the CLI) that hold for this
/// policy: a known pack whose app the policy lists, this policy version, the current warning. Other lines are ignored.
pub fn acceptances_from_store(text: &str, policy: &Policy, key: Option<&[u8]>) -> Vec<Acceptance> {
    let mut out: Vec<Acceptance> = Vec::new();
    // P3 M3: no key, no acceptance. A line counts only with a MAC the host made after a person clicked its dialog.
    let Some(key) = key else { return out };
    for line in text.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        let field = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
        let (pack, version, fnv, mac) = (field("pack"), field("policy_version"), field("warning_fnv"), field("mac"));
        let t = v.get("t_unix_ms").and_then(Value::as_u64).map(|t| t.to_string()).unwrap_or_default();
        if !zumi_audit::hostmac::verify(key, &[&pack, &version, &fnv, &t], &mac) {
            continue;
        }
        let Some((_, exe, warning)) = PACKS.iter().find(|(p, _, _)| *p == pack) else { continue };
        if version == policy.version && fnv == fnv_hex(warning) && policy.allow_app(exe).is_ok() && !out.iter().any(|a| a.pack == pack) {
            out.push(Acceptance { pack, version });
        }
    }
    out
}

/// E2 (1): the Explorer surface. An Explorer window, or a common file dialog (a #32770 dialog that hosts a shell
/// view: SHELLDLL_DefView, or the item dialog's DUIViewWndClassName). Acting in one is acting through Explorer.
pub fn is_shell_surface(class: &str, child_classes: &[String]) -> bool {
    class == "CabinetWClass" || (class == "#32770" && child_classes.iter().any(|c| c == "SHELLDLL_DefView" || c == "DUIViewWndClassName"))
}

/// Acting on the Explorer surface needs the Explorer pack (CoS E2 (1)).
pub fn shell_surface_ok(is_surface: bool, explorer_accepted: bool) -> Result<(), Refusal> {
    if is_surface && !explorer_accepted {
        Err(("explorer_surface", "a file dialog or Explorer window is the Explorer surface: refused without the Explorer pack".into()))
    } else {
        Ok(())
    }
}

/// E2 (2), refused before the action: an element whose name says it starts something outside the app (a browser
/// search, online help, feedback). Checked on invoke, toggle, select and expand.
pub fn launches_outside(name: &str) -> bool {
    let n = name.to_lowercase();
    ["bing", "view help", "get help", "feedback", "browser", "online", "learn more", "search the web", "web search"].iter().any(|w| n.contains(w))
}

/// Review R5 M2, session-long: every process whose parent chain leads to one of ours (`own`: the processes `launch`
/// started or adopted) and that is not itself ours. A descendant with the same image as the own ancestor it leads to
/// (Chromium and Electron helpers, an app reopening itself) is the app, not another program, and is not reported;
/// a different image anywhere below is, whenever it appears. Each entry is (pid, parent pid).
pub fn spawned_descendants(procs: &[(u32, u32)], own: &[u32], same_image: impl Fn(u32, u32) -> bool) -> Vec<u32> {
    let parent = |p: u32| procs.iter().find(|(c, _)| *c == p).map(|(_, pp)| *pp);
    procs
        .iter()
        .map(|(p, _)| *p)
        .filter(|p| !own.contains(p))
        .filter(|&p| {
            // Up the parent chain (bounded: pids can point at each other) to the first process of ours.
            let mut cur = p;
            for _ in 0..32 {
                match parent(cur) {
                    Some(pp) if own.contains(&pp) => return !same_image(p, pp),
                    Some(pp) if pp != cur => cur = pp,
                    _ => return false,
                }
            }
            false
        })
        .collect()
}

/// E2 (3): the Startup folders, from %APPDATA% and %ProgramData%.
pub fn startup_dirs(appdata: &str, programdata: &str) -> Vec<String> {
    vec![format!(r"{appdata}\Microsoft\Windows\Start Menu\Programs\Startup"), format!(r"{programdata}\Microsoft\Windows\Start Menu\Programs\StartUp")]
}

/// E2 (3): the first protected place (policy or audit directory, a Startup folder) that `text` names: as a path in any
/// case or slash style, through %APPDATA% / %ProgramData%, or as a shell: startup name. None: names none.
/// The file system calls the path check may make (review R6 B1: a test hook, so a test can show that no call is
/// made for a URL or a UNC path). The real one touches local fixed drives only.
pub trait PathFs {
    /// Whether `letter:` is a local fixed drive (never a network, removable or optical drive).
    fn is_local_drive(&self, letter: char) -> bool;
    /// The final path of an existing local path (junctions, 8.3 names, case), or None.
    fn canonicalize(&self, path: &str) -> Option<String>;
}

/// The real file system for the path check.
pub struct LocalFs;

impl PathFs for LocalFs {
    fn is_local_drive(&self, letter: char) -> bool {
        local_fixed_drive(letter)
    }
    fn canonicalize(&self, path: &str) -> Option<String> {
        std::fs::canonicalize(path).ok().map(|p| p.to_string_lossy().to_string())
    }
}

#[cfg(windows)]
fn local_fixed_drive(letter: char) -> bool {
    // SAFETY: asks the drive type of a root path; reads no file, opens no handle.
    let root: Vec<u16> = format!("{letter}:\\").encode_utf16().chain([0]).collect();
    let t = unsafe { windows::Win32::Storage::FileSystem::GetDriveTypeW(windows::core::PCWSTR(root.as_ptr())) };
    t == 3 || t == 6 // DRIVE_FIXED, DRIVE_RAMDISK
}

#[cfg(not(windows))]
fn local_fixed_drive(_letter: char) -> bool {
    false
}

pub fn protected_hit(text: &str, protected: &[String], appdata: &str, programdata: &str) -> Option<String> {
    protected_hit_with(text, protected, appdata, programdata, &LocalFs)
}

/// protected_hit with the file system calls going to `fs`. No call is made unless the text holds a local drive path,
/// and then only for that local path (review R6 B1: a UNC name in typed text went to the network, 27 s).
pub fn protected_hit_with(text: &str, protected: &[String], appdata: &str, programdata: &str, fs: &dyn PathFs) -> Option<String> {
    // Every shell: name (shell:startup, shell:::{CLSID} and the rest) can name a protected folder: none is typed.
    if text.to_lowercase().contains("shell:") {
        return Some("a shell: name".into());
    }
    let expanded = expand_env(text, appdata, programdata);
    // A UNC, admin-share, \\?\ or device path is refused as it is, never resolved: resolving it would reach the
    // network (SMB, WebDAV) or a device.
    if has_unc(&expanded) {
        return Some("a UNC, admin-share or device path".into());
    }
    // Each local drive path in the text, resolved the way Windows resolves it (environment variables, separators,
    // doubled separators, `.` and `..`, trailing dots and spaces), then through its final path on disk when the drive
    // is a local fixed drive (junctions, 8.3 names, case). Compared with each place, resolved the same way.
    let candidates = path_candidates(&expanded);
    if candidates.is_empty() {
        return None;
    }
    let places: Vec<(&String, String)> = protected.iter().map(|p| (p, resolved_lower(p, fs))).filter(|(_, r)| !r.is_empty()).collect();
    for cand in candidates {
        let c = resolved_lower(&cand, fs);
        if let Some((orig, _)) = places.iter().find(|(_, place)| c == *place || c.starts_with(&format!("{place}\\"))) {
            return Some((*orig).clone());
        }
    }
    None
}

/// %NAME% replaced for the five folder variables only (review R6 B1: any other variable could put a value of the
/// helper's environment into the text). Others stay as typed.
fn expand_env(text: &str, appdata: &str, programdata: &str) -> String {
    let var = |name: &str| -> Option<String> {
        match name.to_ascii_lowercase().as_str() {
            "appdata" => Some(appdata.to_string()),
            "programdata" => Some(programdata.to_string()),
            "userprofile" | "localappdata" | "allusersprofile" => std::env::var(name).ok(),
            _ => None,
        }
    };
    let mut out = String::new();
    let mut rest = text;
    while let Some(i) = rest.find('%') {
        out.push_str(&rest[..i]);
        let after = &rest[i + 1..];
        match after.find('%') {
            Some(j) if j > 0 => match var(&after[..j]) {
                Some(v) => {
                    out.push_str(&v);
                    rest = &after[j + 1..];
                }
                None => {
                    out.push('%');
                    rest = after;
                }
            },
            _ => {
                out.push('%');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Two separators that start a path (at the start, or after a space, quote or punctuation, not after a drive colon
/// or a name: "https://" and "C:\\x" are not), or a file:// URL with a host.
fn has_unc(text: &str) -> bool {
    let b = text.as_bytes();
    let sep = |c: u8| c == b'\\' || c == b'/';
    let starts_path = |i: usize| i == 0 || matches!(b[i - 1], b' ' | b'\t' | b'\n' | b'"' | b'\'' | b'=' | b'(' | b',' | b';' | b'<' | b'[');
    let unc = (0..b.len().saturating_sub(1)).any(|i| sep(b[i]) && sep(b[i + 1]) && starts_path(i) && b.get(i + 2).is_some_and(|c| !c.is_ascii_whitespace()));
    let lower = text.to_lowercase();
    let file_host = lower.match_indices("file://").any(|(i, _)| lower[i + 7..].chars().next().is_some_and(|c| c != '/'));
    unc || file_host
}

/// The text from every place where a local drive path starts (a drive letter, a colon and a separator).
fn path_candidates(text: &str) -> Vec<String> {
    let b = text.as_bytes();
    let sep = |c: u8| c == b'\\' || c == b'/';
    (0..b.len())
        .filter(|&i| i + 2 < b.len() && b[i].is_ascii_alphabetic() && b[i + 1] == b':' && sep(b[i + 2]) && (i == 0 || !b[i - 1].is_ascii_alphanumeric()))
        .map(|i| text[i..].to_string())
        .collect()
}

/// A local drive path resolved and lower-cased: separators, `.`/`..` and trailing dots and spaces lexically; then,
/// on a local fixed drive only, the longest part that exists through its final path (junctions, 8.3 names). A path
/// on any other drive (network, removable) is compared as written. Empty when it is not a drive path.
fn resolved_lower(path: &str, fs: &dyn PathFs) -> String {
    let s = path.replace('/', "\\");
    let s = s.strip_prefix(r"\\?\").unwrap_or(&s).to_string();
    let bytes = s.as_bytes();
    if !(bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':') {
        return String::new();
    }
    let letter = (bytes[0] as char).to_ascii_uppercase();
    let prefix = format!("{letter}:");
    let mut segs: Vec<String> = Vec::new();
    for seg in s[2..].split('\\') {
        if seg == ".." {
            segs.pop();
            continue;
        }
        // Windows drops trailing dots and spaces of a name ("Startup." is "Startup"); "." and "" name nothing.
        let seg = seg.trim_end_matches(['.', ' ']);
        if !seg.is_empty() {
            segs.push(seg.to_string());
        }
    }
    let mut out = format!(r"{prefix}\{}", segs.join("\\"));
    if fs.is_local_drive(letter) {
        for k in (0..=segs.len()).rev() {
            let head = format!(r"{prefix}\{}", segs[..k].join("\\"));
            if let Some(canon) = fs.canonicalize(&head) {
                let c = canon.trim_start_matches(r"\\?\").to_string();
                let tail = segs[k..].join("\\");
                out = if tail.is_empty() { c } else { format!("{}\\{tail}", c.trim_end_matches('\\')) };
                break;
            }
        }
    }
    out.trim_end_matches('\\').to_lowercase()
}

/// A recorded acceptance of one pack's warning, for one policy version.
#[derive(Debug, Clone, PartialEq)]
pub struct Acceptance {
    pub pack: String,
    pub version: String,
}

/// FNV-64 of a text, as 16 hex digits (policy versions, warning fingerprints).
pub fn fnv_hex(text: &str) -> String {
    let h = text.bytes().fold(0xcbf2_9ce4_8422_2325u64, |h, b| (h ^ b as u64).wrapping_mul(0x0100_0000_01b3));
    format!("{h:016x}")
}

/// What `launch` may pass to one executable.
#[derive(Debug, Clone, PartialEq)]
pub enum ArgRule {
    /// Exactly one existing directory (Explorer). The helper itself adds `/separate,` and adopts the folder window's
    /// process (handoff). No file, no `shell:`, URI or `::{CLSID}` form, no flag, no second argument.
    Directory,
    /// One of these argument vectors, exactly.
    OneOf(Vec<Vec<String>>),
}

/// What `launch` runs: the argument vector, and for a handoff the window titles the adopted process must show.
#[derive(Debug, Clone, PartialEq)]
pub struct LaunchPlan {
    pub argv: Vec<String>,
    pub handoff_titles: Option<Vec<String>>,
}

impl Default for Policy {
    /// Without a policy file: Notepad only, no arguments.
    fn default() -> Self {
        type Ctl<'a> = (&'a str, &'a [&'a str], Option<&'a [&'a str]>);
        let ui = |windows: &[&str], controls: &[Ctl], whitespace: &[char]| UiRule {
            windows: windows.iter().map(|w| w.to_string()).collect(),
            controls: controls
                .iter()
                .map(|(r, v, n)| (r.to_string(), v.iter().map(|x| x.to_string()).collect(), n.map(|n| n.iter().map(|x| x.to_string()).collect())))
                .collect(),
            whitespace: whitespace.to_vec(),
        };
        // Element names for menus and buttons: normal editing only. Nothing that opens another app, a browser or
        // help (review R6 B2), and no clipboard route: no Paste, Cut or Copy (review R6 B3, R4 S1).
        const NOTEPAD_MENU: &[&str] = &[
            "File", "Edit", "Format", "View", "Zoom", "New", "Undo", "Delete", "Find Next", "Find Previous",
            "Select All", "Time/Date", "Word Wrap", "Status Bar", "Zoom In", "Zoom Out", "Restore Default Zoom",
        ];
        const PAINT_BUTTONS: &[&str] = &["Pencil", "Fill with color", "Text", "Eraser", "Color picker", "Magnifier", "Undo", "Redo", "Crop", "Zoom in", "Zoom out", "100%"];
        const PAINT_SPLIT: &[&str] = &["Select", "Rotate", "Brushes"];
        const PAINT_MENU: &[&str] = &["Rotate right 90°", "Rotate left 90°", "Rotate 180°", "Flip vertical", "Flip horizontal", "Rectangular selection", "Free-form selection", "Select all", "Invert selection"];
        const CALC_BUTTONS: &[&str] = &[
            "Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Plus", "Minus", "Multiply by", "Divide by", "Equals",
            "Clear", "Clear entry", "Backspace", "Decimal separator", "Positive negative",
        ];
        let (np, paint, calc) = (r"C:\Windows\System32\notepad.exe", r"C:\Windows\System32\mspaint.exe", r"C:\Windows\System32\calc.exe");
        Policy {
            apps: vec![np.to_string(), paint.to_string(), calc.to_string()],
            args: Vec::new(),
            version: "default".into(),
            // Normal editing only. #32768 is a popup menu window. No file dialog (#32770): that is the Explorer pack.
            ui: vec![
                (np.to_ascii_lowercase(), ui(&["Notepad", "#32768"], &[("Edit", &["type", "key", "set_value"], None), ("MenuItem", &["expand", "collapse", "invoke"], Some(NOTEPAD_MENU))], &['\t', '\n'])),
                (
                    paint.to_ascii_lowercase(),
                    ui(
                        &["MSPaintApp", "#32768"],
                        &[
                            ("Button", &["invoke"], Some(PAINT_BUTTONS)),
                            ("SplitButton", &["invoke", "expand", "collapse"], Some(PAINT_SPLIT)),
                            ("TabItem", &["select"], Some(&["Home", "View"])),
                            ("MenuItem", &["invoke"], Some(PAINT_MENU)),
                            ("CheckBox", &["toggle"], Some(&["Rulers", "Gridlines", "Status bar"])),
                            // R5 pixel fallback: the drawing surface (the helper refuses a point on any named control).
                            ("Pointer", &["click", "drag"], None),
                        ],
                        &[],
                    ),
                ),
                (calc.to_ascii_lowercase(), ui(&["ApplicationFrameWindow"], &[("Button", &["invoke"], Some(CALC_BUTTONS))], &[])),
            ],
        }
    }
}

impl Policy {
    /// Policy file: `{"apps": ["C:\\Windows\\System32\\notepad.exe", ...], "args": {"<app>": RULE, ...}}` with RULE
    /// `{"directory": true}` or `{"one_of": [["arg", ...], ...]}`. Apps are absolute paths; a rule names an app on the
    /// list. Anything else is an error.
    pub fn parse(text: &str) -> Result<Policy, Refusal> {
        let bad = |why: &str| ("bad_policy", format!("policy file: {why}"));
        let v: Value = serde_json::from_str(text).map_err(|e| bad(&e.to_string()))?;
        let apps = v.get("apps").and_then(Value::as_array).ok_or_else(|| bad("needs an \"apps\" array"))?;
        let apps = apps
            .iter()
            .map(|a| a.as_str().map(str::to_string).filter(|s| !s.is_empty()).ok_or_else(|| bad("apps must be non-empty strings")))
            .collect::<Result<Vec<_>, _>>()?;
        if let Some(a) = apps.iter().find(|a| !Path::new(a.as_str()).is_absolute()) {
            return Err(bad(&format!("{a:?} is not an absolute path")));
        }
        let mut args = Vec::new();
        if let Some(rules) = v.get("args") {
            let rules = rules.as_object().ok_or_else(|| bad("\"args\" must be an object"))?;
            for (exe, rule) in rules {
                if !apps.iter().any(|a| a.eq_ignore_ascii_case(exe)) {
                    return Err(bad(&format!("argument rule for {exe:?}, which is not in \"apps\"")));
                }
                let r = if rule == &serde_json::json!({ "directory": true }) {
                    ArgRule::Directory
                } else if let Some(list) = rule.as_object().filter(|o| o.len() == 1).and_then(|o| o.get("one_of")).and_then(Value::as_array) {
                    let vecs = list
                        .iter()
                        .map(|x| x.as_array().and_then(|xs| xs.iter().map(|y| y.as_str().map(str::to_string)).collect::<Option<Vec<_>>>()))
                        .collect::<Option<Vec<_>>>()
                        .ok_or_else(|| bad("one_of must be a list of string lists"))?;
                    ArgRule::OneOf(vecs)
                } else {
                    return Err(bad(&format!("unknown argument rule for {exe:?}")));
                };
                args.push((exe.to_ascii_lowercase(), r));
            }
        }
        let mut ui = Vec::new();
        if let Some(rules) = v.get("ui") {
            const VERBS: [&str; 10] = ["set_value", "invoke", "toggle", "select", "expand", "collapse", "type", "key", "click", "drag"];
            let rules = rules.as_object().ok_or_else(|| bad("\"ui\" must be an object"))?;
            for (exe, rule) in rules {
                if !apps.iter().any(|a| a.eq_ignore_ascii_case(exe)) {
                    return Err(bad(&format!("ui rule for {exe:?}, which is not in \"apps\"")));
                }
                let strs = |x: Option<&Value>, what: &str| -> Result<Vec<String>, Refusal> {
                    match x {
                        None => Ok(Vec::new()),
                        Some(x) => x.as_array().and_then(|a| a.iter().map(|y| y.as_str().map(str::to_string)).collect::<Option<Vec<_>>>()).ok_or_else(|| bad(&format!("{what} must be a list of strings"))),
                    }
                };
                let windows = strs(rule.get("windows"), "windows")?;
                let mut controls = Vec::new();
                if let Some(c) = rule.get("controls") {
                    for (role, entry) in c.as_object().ok_or_else(|| bad("controls must be an object"))? {
                        // ["verb", ...] for every element of the type, or {"verbs": [...], "names": [...]} for those.
                        let (verbs, names) = if entry.is_array() {
                            (strs(Some(entry), "a control's verbs")?, None)
                        } else {
                            (strs(entry.get("verbs"), "a control's verbs")?, Some(strs(entry.get("names"), "a control's names")?))
                        };
                        if let Some(v) = verbs.iter().find(|v| !VERBS.contains(&v.as_str())) {
                            return Err(bad(&format!("unknown verb {v:?}")));
                        }
                        controls.push((role.clone(), verbs, names));
                    }
                }
                let whitespace = strs(rule.get("whitespace"), "whitespace")?
                    .iter()
                    .map(|w| match w.as_str() { "tab" => Ok('\t'), "newline" => Ok('\n'), other => Err(bad(&format!("unknown whitespace {other:?}"))) })
                    .collect::<Result<Vec<_>, _>>()?;
                ui.push((exe.to_ascii_lowercase(), UiRule { windows, controls, whitespace }));
            }
        }
        Ok(Policy { apps, args, version: fnv_hex(text), ui })
    }

    /// The arguments `launch` may pass to `exe` (already allowlisted), as a plan; anything else is `bad_args`.
    pub fn launch_plan(&self, exe: &str, args: &[String]) -> Result<LaunchPlan, Refusal> {
        if args.is_empty() {
            return Ok(LaunchPlan { argv: Vec::new(), handoff_titles: None });
        }
        let refuse = |why: String| Err(("bad_args", format!("launch {exe:?}: {why}")));
        let lower = exe.to_ascii_lowercase();
        match self.args.iter().find(|(e, _)| *e == lower).map(|(_, r)| r) {
            None => refuse("the policy allows no arguments for this app".into()),
            Some(ArgRule::OneOf(vecs)) => {
                if vecs.iter().any(|v| v.as_slice() == args) {
                    Ok(LaunchPlan { argv: args.to_vec(), handoff_titles: None })
                } else {
                    refuse("these arguments are not one of the policy's argument lists".into())
                }
            }
            Some(ArgRule::Directory) => {
                let [a] = args else { return refuse("exactly one argument (a directory)".into()) };
                let shaped = a.starts_with('/') || a.starts_with('-') || a.contains(',') || a.contains("::") || a.contains("//") || a.starts_with(r"\\")
                    || a.to_ascii_lowercase().starts_with("shell:") || a.char_indices().any(|(i, c)| c == ':' && i != 1);
                if shaped || !Path::new(a).is_absolute() {
                    return refuse(format!("{a:?} is not a plain absolute directory path"));
                }
                let canon = std::fs::canonicalize(a).map_err(|e| ("bad_args", format!("{a:?}: {e}")))?;
                if !std::fs::metadata(&canon).map(|m| m.is_dir()).unwrap_or(false) {
                    return refuse(format!("{a:?} is not an existing directory"));
                }
                let full = canon.to_string_lossy().to_string();
                let Some(plain) = full.strip_prefix(r"\\?\").filter(|p| !p.starts_with("UNC")) else {
                    return refuse(format!("{a:?} is not a local directory"));
                };
                if plain.contains(',') {
                    return refuse(format!("{a:?} resolves to a path with a comma"));
                }
                let name = canon.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                Ok(LaunchPlan { argv: vec![format!("/separate,{plain}")], handoff_titles: Some(vec![name, plain.to_string()]) })
            }
        }
    }

    pub fn load(path: &Path) -> Result<Policy, Refusal> {
        let text = std::fs::read_to_string(path).map_err(|e| ("bad_policy", format!("{}: {e}", path.display())))?;
        Policy::parse(&text)
    }

    /// allow_app, and for an opt-in pack's executable also a recorded acceptance of its warning for this version.
    pub fn allow_app_with(&self, exe: &str, accepted: &[Acceptance]) -> Result<(), Refusal> {
        self.allow_app(exe)?;
        match PACKS.iter().find(|(_, e, _)| e.eq_ignore_ascii_case(exe)) {
            None => Ok(()),
            Some((pack, _, _)) if accepted.iter().any(|a| a.pack == *pack && a.version == self.version) => Ok(()),
            Some((pack, _, _)) => Err(("pack_not_accepted", format!("{exe:?} belongs to the opt-in pack {pack:?}: its risk warning has not been accepted for policy {}", self.version))),
        }
    }

    /// The allowlist decision for one action: in app `exe`, in a window of class `window_class`, on an element of
    /// control type `role` (prune role names), verb `verb`. Anything not listed is `ui_not_allowed`.
    pub fn ui_allows(&self, exe: &str, window_class: &str, role: &str, name: &str, verb: &str) -> Result<(), Refusal> {
        let rule = self.ui_window(exe, window_class)?;
        match rule.controls.iter().find(|(r, _, _)| r == role) {
            Some((_, verbs, _)) if !verbs.iter().any(|v| v == verb) => Err(("ui_not_allowed", format!("{verb} on a {role} is not on {exe:?}'s allowlist"))),
            Some((_, _, Some(names))) if !names.iter().any(|n| n == name) => Err(("ui_not_allowed", format!("the {role} {name:?} is not on {exe:?}'s allowlist"))),
            Some(_) => Ok(()),
            None => Err(("ui_not_allowed", format!("a {role} is not a control type on {exe:?}'s allowlist"))),
        }
    }

    fn ui_window(&self, exe: &str, window_class: &str) -> Result<&UiRule, Refusal> {
        let lower = exe.to_ascii_lowercase();
        let rule = self.ui.iter().find(|(e, _)| *e == lower).map(|(_, r)| r).ok_or(("ui_not_allowed", format!("{exe:?} has no UI allowlist: nothing acts in it")))?;
        if rule.windows.iter().any(|w| w == window_class) {
            Ok(rule)
        } else {
            Err(("ui_not_allowed", format!("a window of class {window_class:?} is not on {exe:?}'s allowlist")))
        }
    }

    /// The window-level allowlist: the app's rule lists this window class.
    pub fn ui_window_allowed(&self, exe: &str, window_class: &str) -> Result<(), Refusal> {
        self.ui_window(exe, window_class).map(|_| ())
    }

    /// `type` text under the app's rule: printable characters plus its listed whitespace only (review R5 M3).
    pub fn ui_text_allowed(&self, exe: &str, text: &str) -> Result<(), Refusal> {
        let lower = exe.to_ascii_lowercase();
        let rule = self.ui.iter().find(|(e, _)| *e == lower).map(|(_, r)| r).ok_or(("ui_not_allowed", format!("{exe:?} has no UI allowlist")))?;
        match text.chars().find(|c| c.is_control() && !rule.whitespace.contains(c)) {
            Some(c) => Err(("bad_text", format!("control character U+{:04X} in typed text: only printable text and the listed whitespace", c as u32))),
            None => Ok(()),
        }
    }

    pub fn allow_app(&self, exe: &str) -> Result<(), Refusal> {
        if !exe.is_empty() && self.apps.iter().any(|a| a.eq_ignore_ascii_case(exe)) {
            Ok(())
        } else {
            Err(("app_not_allowed", format!("{exe:?} is not on the hands allowlist")))
        }
    }
}

pub fn not_own_window(target_pid: u32, self_pid: u32) -> Result<(), Refusal> {
    if target_pid == self_pid {
        Err(("own_window", "the hands never act on the helper's own windows".into()))
    } else {
        Ok(())
    }
}

pub fn not_password(is_password: bool) -> Result<(), Refusal> {
    if is_password {
        Err(("password_field", "the hands never type into or set a password field".into()))
    } else {
        Ok(())
    }
}

/// `pending`: the watch says it is still updating. `cache_as_of`: when the cached tree last changed.
/// `last_action`: when this helper last acted on that window. No watch: the caller reads fresh, so it is current.
pub fn fresh(pending: bool, cache_as_of: Option<Instant>, last_action: Option<Instant>) -> Result<(), Refusal> {
    if pending {
        return Err(("stale_cache", "the cached snapshot is still updating".into()));
    }
    match (last_action, cache_as_of) {
        (None, _) => Ok(()),
        (Some(a), Some(c)) if c > a => Ok(()),
        _ => Err(("stale_cache", "the cache has not changed since the last action on this window".into())),
    }
}

/// The cache time an action on one element is judged by (review R4 M1). `window_as_of`: when the event-fed cache
/// last changed (the whole window). `element_refreshed`: when the hands last re-read this element after acting on it
/// (None for any other element). The re-read vouches for that element only, never for the rest of the window.
pub fn as_of_for_element(window_as_of: Option<Instant>, element_refreshed: Option<Instant>) -> Option<Instant> {
    window_as_of.max(element_refreshed)
}

/// Whether an action on an element must first match the live element against the cache (rule (b)). R4 live run
/// (fix-r4/stale.jsonl): an event on one element (a button renaming itself) made the window current while another
/// element had changed with no event, and the action on it skipped the check. So on a watched window the check runs
/// every time, current or stale; an unwatched window is read fresh by the action itself.
pub fn live_check_needed(watched: bool, _waited: Waited) -> bool {
    watched
}

/// Review R5 M1: an element is acted on only through the window it sits in. `root`: the top-level window that
/// holds the element (an owned dialog is a top-level window of its own); it must be the window the verb addressed.
pub fn same_root(target: u64, root: u64) -> Result<(), Refusal> {
    if root == target {
        Ok(())
    } else {
        Err(("owned_window", format!("the element sits in window 0x{root:X}, not in the addressed 0x{target:X}: address that window itself")))
    }
}

/// R5d: `same_root`, but a popup menu (window class `#32768`) of the addressed window's own process also counts. On Windows 10
/// Notepad the Edit menu is a top-level window of its own, so its items sit in a root that is not the addressed window and the
/// T42 control "yes -> Delete" was refused as `owned_window`. Only menus, and only the same process: an owned dialog (`#32770`),
/// another top-level window, or a menu of another process is still refused. The element's own process is checked as well
/// (`rails::element_owner`), and the menu's items still need their own allowlist entry (class `#32768`, control type, verb, name).
pub fn same_root_or_menu(target: u64, root: u64, root_class: &str, root_pid: u32, target_pid: u32) -> Result<(), Refusal> {
    if root_class == POPUP_MENU_CLASS && root_pid == target_pid {
        return Ok(());
    }
    same_root(target, root)
}

/// The window class of a popup menu (the one the system creates for every menu).
pub const POPUP_MENU_CLASS: &str = "#32768";

/// GetGUIThreadInfo flags of the target's GUI thread (review R7 B1-R7).
pub const GUI_INMOVESIZE: u32 = 0x2;
pub const GUI_INMENUMODE: u32 = 0x4;
pub const GUI_SYSTEMMENUMODE: u32 = 0x8;
pub const GUI_POPUPMENUMODE: u32 = 0x10;

/// Review R7 B1-R7: before every keystroke and chord, the state of the target's GUI thread decides where the keys go,
/// not only the element UIA calls focused. Refused: the query failed (fail closed); a menu, popup menu or system
/// menu is open (keys pick menu items by mnemonic); a move/size loop or a mouse capture is on; the keyboard focus
/// window is missing, outside the addressed window, or not the focused element's own window (`element_native`, 0
/// when the element has no window of its own).
pub fn thread_state_ok(query_ok: bool, flags: u32, capture: u64, focus: u64, focus_root: u64, target: u64, element_native: u64) -> Result<(), Refusal> {
    if !query_ok {
        return Err(("thread_state_unknown", "the target window's thread state could not be read: no keys".into()));
    }
    if flags & (GUI_INMENUMODE | GUI_POPUPMENUMODE | GUI_SYSTEMMENUMODE) != 0 {
        return Err(("menu_mode", format!("a menu is open in the target (flags {flags:#x}): keys would pick menu items")));
    }
    if flags & GUI_INMOVESIZE != 0 || capture != 0 {
        return Err(("capture_mode", format!("the target is in a move/size loop or holds the mouse capture (flags {flags:#x})")));
    }
    if focus == 0 || focus_root != target {
        return Err(("focus_elsewhere", format!("the keyboard focus window 0x{focus:X} is not inside the addressed window 0x{target:X}")));
    }
    if element_native != 0 && element_native != focus {
        return Err(("focus_elsewhere", format!("the keyboard focus window 0x{focus:X} is not the focused element's window 0x{element_native:X}")));
    }
    Ok(())
}

/// Review R8 S3: keys go to the foreground window's thread. That thread must be the addressed window's thread (the
/// one whose state was just read); 0 means the thread could not be read.
pub fn same_input_thread(target_tid: u32, foreground_tid: u32) -> Result<(), Refusal> {
    if target_tid == 0 || foreground_tid == 0 {
        Err(("thread_state_unknown", "the addressed or the foreground window's thread could not be read: no keys".into()))
    } else if target_tid != foreground_tid {
        Err(("focus_elsewhere", format!("the foreground window belongs to thread {foreground_tid}, not the addressed window's {target_tid}")))
    } else {
        Ok(())
    }
}

/// Characters per SendInput batch when typing: one, so the focused field (owner, password flag) is re-checked before
/// every keystroke. A focus move inside a batch (a Tab, a field that auto-advances) cannot leak characters.
pub const TYPE_BATCH_CHARS: usize = 1;

/// How the bounded freshness wait ended, with the milliseconds it waited.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Waited {
    Current(u64),
    Stale(u64),
}

/// The bounded freshness wait. `probe` returns (pending, cache_as_of) now. `gate` (armed, not killed, dead-man) runs on
/// every poll, so a kill during the wait ends it with the gate's refusal and the action never reaches its side effect.
pub fn wait_fresh(probe: impl Fn() -> (bool, Option<Instant>), last_action: Option<Instant>, gate: impl Fn() -> Result<(), Refusal>, bound: Duration) -> Result<Waited, Refusal> {
    let t0 = Instant::now();
    loop {
        gate()?;
        let (pending, as_of) = probe();
        let ms = t0.elapsed().as_millis() as u64;
        if fresh(pending, as_of, last_action).is_ok() {
            return Ok(Waited::Current(ms));
        }
        if t0.elapsed() >= bound {
            return Ok(Waited::Stale(ms));
        }
        std::thread::sleep(Duration::from_millis(POLL_MS));
    }
}

/// Poll interval of the freshness wait (and so the longest a kill waits to end it).
const POLL_MS: u64 = 20;

/// A wait that ended stale refuses (fail closed); a current one gives the milliseconds waited.
pub fn require_current(w: Waited) -> Result<u64, Refusal> {
    match w {
        Waited::Current(ms) => Ok(ms),
        Waited::Stale(ms) => Err(("stale_cache", format!("the cache did not become current within the {FRESH_WAIT_MS} ms bound (waited_ms={ms})"))),
    }
}

/// A side effect runs only if the gate still passes immediately before it.
pub fn guarded<T>(gate: impl Fn() -> Result<(), Refusal>, effect: impl FnOnce() -> Result<T, Refusal>) -> Result<T, Refusal> {
    gate()?;
    effect()
}

/// One level of an element's path in a tree: the window (first), each ancestor, the element (last).
#[derive(Debug, Clone, PartialEq)]
pub struct Level {
    pub control_type: i32,
    pub name: String,
    pub class_name: String,
    pub enabled: bool,
    /// tree::pattern_state of the node: compared at the element level only.
    pub state: String,
}

/// The levels from the root (the window) down to the node at `path` (child indices); None if the path leads nowhere.
pub fn chain(root: &crate::tree::Node, path: &[usize]) -> Option<Vec<Level>> {
    let level = |n: &crate::tree::Node| Level { control_type: n.control_type, name: n.name.clone(), class_name: n.class_name.clone(), enabled: n.enabled, state: n.state.clone() };
    let mut out = vec![level(root)];
    let mut cur = root;
    for &i in path {
        cur = cur.children.get(i)?;
        out.push(level(cur));
    }
    Some(out)
}

/// Rule (b) (CoS e1dd56282f2f): when the cache stayed stale through the bounded wait, an action on an element goes on
/// only if a live read of the window shows the same element as the cache: the same id, and at every level from the
/// window down to the element the same control type, name and enabled state. The window level (the owning window)
/// is compared by control type and class, not by title: a title follows the document state ("*Untitled"). The
/// owning window handle is the same by construction (the cache is keyed by it and the live read is made from it).
/// `live`: the element's id and levels in the live read, None when no element has that id any more.
pub fn same_as_cache(id: &str, cached: &[Level], live: Option<(&str, &[Level])>) -> Result<(), Refusal> {
    let mismatch = |why: String| Err(("stale_mismatch", format!("the live element differs from the cache the model saw: {why}")));
    let Some((live_id, live)) = live else {
        return Err(("stale_gone", format!("element {id} of the cache is not in the window any more")));
    };
    if live_id != id {
        return mismatch(format!("id {live_id} is not {id}"));
    }
    if live.len() != cached.len() {
        return mismatch(format!("depth {} is not {}", live.len(), cached.len()));
    }
    for (depth, (c, l)) in cached.iter().zip(live).enumerate() {
        let what = if depth == 0 { "window" } else if depth + 1 == cached.len() { "element" } else { "ancestor" };
        if c.control_type != l.control_type {
            return mismatch(format!("{what} control type {} is not {}", l.control_type, c.control_type));
        }
        if depth == 0 {
            if c.class_name != l.class_name {
                return mismatch(format!("window class {:?} is not {:?}", l.class_name, c.class_name));
            }
            continue;
        }
        if c.name != l.name {
            return mismatch(format!("{what} name {:?} is not {:?}", l.name, c.name));
        }
        if c.enabled != l.enabled {
            return mismatch(format!("{what} enabled {} is not {}", l.enabled, c.enabled));
        }
        // The element's own pattern state (review R2 S4): a toggle or expand decided on a stale snapshot would go the
        // wrong way if the state moved since.
        if depth + 1 == cached.len() && c.state != l.state {
            return mismatch(format!("element state {:?} is not {:?}", l.state, c.state));
        }
    }
    Ok(())
}

/// The window class of an Explorer folder window: what a handoff must show.
pub const HANDOFF_CLASS: &str = "CabinetWClass";

/// A process that may have taken over a handoff: its pid and its visible top-level windows (class, title).
#[derive(Debug, Clone)]
pub struct Candidate {
    pub pid: u32,
    pub windows: Vec<(String, String)>,
}

/// Which process to adopt after a handoff start (review R2 S1). Only once the process we started has exited; only a
/// process that did not exist before the start (so its windows appeared after it), and only one that shows a folder
/// window (HANDOFF_CLASS) titled with the requested directory (`titles`: its name or full path). Ok(None): keep
/// waiting. Two such processes: refused, adopt none.
pub fn pick_handoff(started: u32, started_exited: bool, before: &[u32], now: &[Candidate], titles: &[String]) -> Result<Option<u32>, Refusal> {
    if !started_exited {
        return Ok(None);
    }
    let shows_folder = |c: &Candidate| c.windows.iter().any(|(class, title)| class == HANDOFF_CLASS && titles.iter().any(|t| t.eq_ignore_ascii_case(title)));
    let matching: Vec<u32> = now.iter().filter(|c| c.pid != started && !before.contains(&c.pid) && shows_folder(c)).map(|c| c.pid).collect();
    match matching.as_slice() {
        [] => Ok(None),
        [one] => Ok(Some(*one)),
        many => Err(("handoff_ambiguous", format!("{} new processes show the requested folder; adopting none", many.len()))),
    }
}

/// Polls `poll` every `every` until it gives a value or `bound` passes (Ok(None)). The gate runs before every poll,
/// so a kill ends the wait with the gate's refusal (review R2 S2: the launch handoff wait).
pub fn poll_until<T>(mut poll: impl FnMut() -> Result<Option<T>, Refusal>, gate: impl Fn() -> Result<(), Refusal>, bound: Duration, every: Duration) -> Result<Option<T>, Refusal> {
    let t0 = Instant::now();
    loop {
        gate()?;
        if let Some(v) = poll()? {
            return Ok(Some(v));
        }
        if t0.elapsed() >= bound {
            return Ok(None);
        }
        std::thread::sleep(every);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    /// Review R2 S4, bites: the element's toggle state or value fingerprint differs between cache and live. Pass
    /// twins: the same state; an ancestor's state differs (not compared). The levels carry the node state.
    #[test]
    fn stale_cache_compares_the_element_pattern_state() {
        let mut cached = levels();
        cached[2].state = "toggle=0".into();
        let mut live = cached.clone();
        live[2].state = "toggle=1".into();
        assert_eq!(same_as_cache("e1", &cached, Some(("e1", &live))).unwrap_err().0, "stale_mismatch", "toggled since the snapshot");
        live[2].state = "toggle=0".into();
        assert!(same_as_cache("e1", &cached, Some(("e1", &live))).is_ok(), "pass: same state");
        live[1].state = "expand=1".into();
        assert!(same_as_cache("e1", &cached, Some(("e1", &live))).is_ok(), "pass: an ancestor's state is not compared");
        cached[2].state = "value#00000000000000ab".into();
        live[2].state = "value#00000000000000ac".into();
        assert_eq!(same_as_cache("e1", &cached, Some(("e1", &live))).unwrap_err().0, "stale_mismatch", "value changed");

        use crate::tree::Node;
        let leaf = Node { control_type: 50002, state: "toggle=1".into(), ..Default::default() };
        let root = Node { control_type: 50032, children: vec![leaf], ..Default::default() };
        assert_eq!(chain(&root, &[0]).unwrap()[1].state, "toggle=1");
    }

    /// Review R2 S2, bites: a kill before the wait refuses without polling; a kill during it ends it within one
    /// period. Pass twins: a value on the third poll is returned; nothing within the bound gives None at the bound.
    #[test]
    fn the_handoff_wait_is_gated() {
        let every = Duration::from_millis(20);
        let killed = Arc::new(AtomicBool::new(true));
        let mut polls = 0;
        let r = poll_until(|| { polls += 1; Ok(None::<u32>) }, gate_of(&killed), Duration::from_secs(2), every);
        assert_eq!(r.unwrap_err().0, "killed");
        assert_eq!(polls, 0, "killed before: no poll");

        let late = Arc::new(AtomicBool::new(false));
        let k = late.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            k.store(true, Ordering::SeqCst);
        });
        let t0 = Instant::now();
        let r = poll_until(|| Ok(None::<u32>), gate_of(&late), Duration::from_secs(2), every);
        assert_eq!(r.unwrap_err().0, "killed");
        assert!(t0.elapsed() < Duration::from_millis(400), "{:?}", t0.elapsed());

        let open = Arc::new(AtomicBool::new(false));
        let mut n = 0;
        assert_eq!(poll_until(|| { n += 1; Ok((n == 3).then_some(42)) }, gate_of(&open), Duration::from_secs(2), every).unwrap(), Some(42));
        let t0 = Instant::now();
        assert_eq!(poll_until(|| Ok(None::<u32>), gate_of(&open), Duration::from_millis(200), every).unwrap(), None);
        assert!(t0.elapsed() >= Duration::from_millis(200));
    }

    fn cand(pid: u32, windows: &[(&str, &str)]) -> Candidate {
        Candidate { pid, windows: windows.iter().map(|(c, t)| (c.to_string(), t.to_string())).collect() }
    }

    /// Review R2 S1, bites: before the launcher exits; a process that existed before the start (the shell, even with
    /// a matching window); a new process with no window yet, a wrong class (the taskbar) or another folder's title;
    /// two matching new processes (refused). Pass twins: the one new process showing the folder, by name or full path.
    #[test]
    fn handoff_adopts_only_the_new_process_showing_the_requested_folder() {
        let titles = vec!["explorer-fixture".to_string(), r"D:\w\explorer-fixture".to_string()];
        let folder = [(HANDOFF_CLASS, "explorer-fixture")];
        let before = [10, 11];
        assert_eq!(pick_handoff(5, false, &before, &[cand(20, &folder)], &titles).unwrap(), None, "launcher still running");
        assert_eq!(pick_handoff(5, true, &before, &[cand(10, &folder)], &titles).unwrap(), None, "existed before the start");
        assert_eq!(pick_handoff(5, true, &before, &[cand(20, &[])], &titles).unwrap(), None, "no window yet");
        assert_eq!(pick_handoff(5, true, &before, &[cand(20, &[("Shell_TrayWnd", "")])], &titles).unwrap(), None, "wrong class");
        assert_eq!(pick_handoff(5, true, &before, &[cand(20, &[(HANDOFF_CLASS, "Downloads")])], &titles).unwrap(), None, "another folder");
        assert_eq!(pick_handoff(5, true, &before, &[cand(5, &folder)], &titles).unwrap(), None, "the launcher itself");
        assert_eq!(pick_handoff(5, true, &before, &[cand(20, &folder), cand(21, &folder)], &titles).unwrap_err().0, "handoff_ambiguous");

        assert_eq!(pick_handoff(5, true, &before, &[cand(10, &[]), cand(20, &folder), cand(22, &[("X", "y")])], &titles).unwrap(), Some(20), "pass: by name");
        assert_eq!(pick_handoff(5, true, &before, &[cand(20, &[(HANDOFF_CLASS, r"d:\w\EXPLORER-FIXTURE")])], &titles).unwrap(), Some(20), "pass: full path, any case");
    }

    fn strs(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    /// Review R2 B1, bites: Explorer given an .exe, a `shell:` or `::{CLSID}` form, a URI, a .lnk, a file, a flag, a
    /// relative or missing path, a comma, or a second argument is refused; Notepad (exact rule) refuses anything else;
    /// an app without a rule refuses every argument; a relative app entry is a bad policy. Pass twins: a real folder
    /// (handed to `/separate,` with a handoff), no arguments, Notepad's exact vector.
    #[test]
    fn launch_arguments_are_policy_not_free_text() {
        let ex = r"C:\Windows\explorer.exe";
        let np = r"C:\Windows\System32\notepad.exe";
        let p = Policy::parse(r#"{"apps":["C:\\Windows\\explorer.exe","C:\\Windows\\System32\\notepad.exe"],
            "args":{"C:\\Windows\\explorer.exe":{"directory":true},"C:\\Windows\\System32\\notepad.exe":{"one_of":[["D:\\x\\a.txt"]]}}}"#).unwrap();
        let dir = std::env::temp_dir().join(format!("zumi-hands-argtest-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("note.txt");
        std::fs::write(&file, b"x").unwrap();
        let lnk = dir.join("folder.lnk");
        std::fs::write(&lnk, b"not a real shortcut").unwrap();
        let d = dir.to_string_lossy().to_string();
        let refused = |exe: &str, a: &[&str]| p.launch_plan(exe, &strs(a)).map(|_| "allowed").unwrap_or_else(|e| e.0);
        for bad in [
            vec![r"C:\Windows\System32\charmap.exe"],
            vec!["shell:startup"],
            vec!["shell:::{20D04FE0-3AEA-1069-A2D8-08002B30309D}"],
            vec!["::{20D04FE0-3AEA-1069-A2D8-08002B30309D}"],
            vec!["file:///C:/Windows"],
            vec![lnk.to_str().unwrap()],
            vec![file.to_str().unwrap()],
            vec!["/select,C:\\Windows"],
            vec!["/separate,C:\\Windows"],
            vec!["."],
            vec![r"C:\no\such\dir"],
            vec![d.as_str(), "/e"],
        ] {
            assert_eq!(refused(ex, &bad), "bad_args", "explorer {bad:?}");
        }
        let comma = format!("{d},/select");
        assert_eq!(refused(ex, &[comma.as_str()]), "bad_args", "comma");

        let plan = p.launch_plan(ex, &strs(&[d.as_str()])).expect("pass: a real folder");
        assert_eq!(plan.argv.len(), 1);
        assert!(plan.argv[0].starts_with("/separate,") && !plan.argv[0].contains(r"\\?\"), "{:?}", plan.argv);
        assert!(plan.handoff_titles.as_ref().is_some_and(|t| t.iter().any(|x| x.starts_with("zumi-hands-argtest-"))), "{plan:?}");
        assert_eq!(p.launch_plan(ex, &[]).unwrap(), LaunchPlan { argv: vec![], handoff_titles: None }, "pass: no arguments");

        assert_eq!(p.launch_plan(np, &strs(&[r"D:\x\a.txt"])).unwrap().handoff_titles, None, "pass: exact vector, never a handoff");
        assert_eq!(refused(np, &[r"D:\x\b.txt"]), "bad_args");
        assert_eq!(refused(np, &[d.as_str()]), "bad_args");
        let def = Policy::default();
        assert_eq!(def.launch_plan(np, &strs(&["x"])).unwrap_err().0, "bad_args", "no rule: no arguments");
        assert!(def.launch_plan(np, &[]).is_ok());

        assert_eq!(Policy::parse(r#"{"apps":["notepad.exe"]}"#).unwrap_err().0, "bad_policy", "relative app path");
        assert_eq!(Policy::parse(r#"{"apps":["C:\\a.exe"],"args":{"C:\\b.exe":{"directory":true}}}"#).unwrap_err().0, "bad_policy", "rule for an app not on the list");
        assert_eq!(Policy::parse(r#"{"apps":["C:\\a.exe"],"args":{"C:\\a.exe":{"anything":1}}}"#).unwrap_err().0, "bad_policy", "unknown rule");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// CoS E1 = (a), bites: the default policy refuses Explorer; a policy that lists Explorer still refuses it (launch
    /// and acting go through allow_app_with) without an acceptance, or with one for another policy version; an
    /// acceptance of a wrong warning fingerprint, unknown pack or other version is refused. Pass twin: after an
    /// acceptance for this version, Explorer is allowed; Notepad never needs one.
    #[test]
    fn explorer_is_an_opt_in_pack() {
        let ex = r"C:\Windows\explorer.exe";
        let np = r"C:\Windows\System32\notepad.exe";
        assert_eq!(Policy::default().allow_app_with(ex, &[]).unwrap_err().0, "app_not_allowed", "default: no Explorer");
        let text = r#"{"apps":["C:\\Windows\\explorer.exe","C:\\Windows\\System32\\notepad.exe"]}"#;
        let p = Policy::parse(text).unwrap();
        assert_eq!(p.version, fnv_hex(text), "the version is the policy text's fingerprint");
        assert_eq!(p.allow_app_with(ex, &[]).unwrap_err().0, "pack_not_accepted", "listed but not accepted");
        assert_eq!(p.allow_app_with(&ex.to_uppercase(), &[]).unwrap_err().0, "pack_not_accepted", "any case");
        assert!(p.allow_app_with(np, &[]).is_ok(), "not a pack");
        let old = Acceptance { pack: "explorer".into(), version: "0123456789abcdef".into() };
        assert_eq!(p.allow_app_with(ex, &[old]).unwrap_err().0, "pack_not_accepted", "accepted for another policy");

        // The acceptance checks (warning, version, pack, app in the policy) are in acceptances_from_store (its test).
        let warn = fnv_hex(PACKS[0].2);
        let ok = acceptances_from_store(&store_line("explorer", &p.version, &warn, 0, &KEY), &p, Some(&KEY)).pop().expect("pass: current warning and policy");
        assert!(p.allow_app_with(ex, &[ok]).is_ok(), "pass: accepted for this version");
    }

    /// Review R4 M1, bite: after an action, a re-read of element A does not make element B current: B's cache time is
    /// still the window's, older than the action, so B is stale (and goes to rule (b)). Pass twins: A itself is
    /// current after its re-read; a real cache change after the action makes every element current.
    #[test]
    fn a_self_refresh_vouches_for_its_element_only() {
        let t0 = Instant::now();
        let action = t0 + Duration::from_millis(10);
        let refresh_a = t0 + Duration::from_millis(20);
        assert_eq!(fresh(false, as_of_for_element(Some(t0), None), Some(action)).unwrap_err().0, "stale_cache", "element B");
        assert!(fresh(false, as_of_for_element(Some(t0), Some(refresh_a)), Some(action)).is_ok(), "pass: element A");
        assert_eq!(fresh(false, as_of_for_element(Some(t0), Some(t0)), Some(action)).unwrap_err().0, "stale_cache", "A re-read before the action");
        assert_eq!(fresh(true, as_of_for_element(Some(t0), Some(refresh_a)), Some(action)).unwrap_err().0, "stale_cache", "still updating");
        assert!(fresh(false, as_of_for_element(Some(refresh_a), None), Some(action)).is_ok(), "pass: the window changed after the action");
    }

    const KEY: [u8; 32] = [9u8; 32];

    /// P3 M3 (HB-2), bite: a record anyone could write (the old plain line, a line signed with another key, a signed line
    /// with a changed field, any line when the helper holds no key) counts for nothing. Pass twin: the host-signed line.
    #[test]
    fn m3_only_a_record_signed_with_the_hosts_key_counts() {
        let p = Policy::parse(r#"{"apps":["C:\\Windows\\explorer.exe"]}"#).unwrap();
        let warn = fnv_hex(PACKS[0].2);
        let plain = serde_json::json!({ "pack": "explorer", "policy_version": p.version, "warning_fnv": warn }).to_string();
        let plain_t = serde_json::json!({ "pack": "explorer", "policy_version": p.version, "warning_fnv": warn, "t_unix_ms": 5 }).to_string();
        assert!(acceptances_from_store(&plain, &p, Some(&KEY)).is_empty(), "a hand-written line (everything pack_warning gives) is refused");
        assert!(acceptances_from_store(&plain_t, &p, Some(&KEY)).is_empty(), "with a time and no mac: refused");
        let other = store_line("explorer", &p.version, &warn, 5, &[1u8; 32]);
        assert!(acceptances_from_store(&other, &p, Some(&KEY)).is_empty(), "signed with another key: refused");
        let good = store_line("explorer", &p.version, &warn, 5, &KEY);
        assert!(acceptances_from_store(&good, &p, None).is_empty(), "no key in the helper: nothing is accepted");
        let tampered = good.replace("\"t_unix_ms\":5", "\"t_unix_ms\":6");
        assert!(acceptances_from_store(&tampered, &p, Some(&KEY)).is_empty(), "a changed field breaks the mac");
        assert_eq!(acceptances_from_store(&good, &p, Some(&KEY)).len(), 1, "pass twin: the host-signed line");
    }

    /// Store: lines for another policy version, another warning, an unknown pack or garbage count for nothing; a
    /// matching line counts. (P3 HB-2: the console route is gone; only the host dialog writes the record.)
    #[test]
    fn acceptance_is_a_store_record() {
        let text = r#"{"apps":["C:\\Windows\\explorer.exe"]}"#;
        let p = Policy::parse(text).unwrap();
        let warn = fnv_hex(PACKS[0].2);
        let line = |pack: &str, version: &str, w: &str| serde_json::json!({ "pack": pack, "policy_version": version, "warning_fnv": w }).to_string();
        let store = [line("explorer", "0000000000000000", &warn), line("explorer", &p.version, "0000000000000000"), line("terminal", &p.version, &warn), "not json".into()].join("\n");
        assert!(acceptances_from_store(&store, &p, Some(&KEY)).is_empty(), "nothing in the store holds");
        let store = format!("{store}\n{}", store_line("explorer", &p.version, &warn, 1, &KEY));
        assert_eq!(acceptances_from_store(&store, &p, Some(&KEY)), vec![Acceptance { pack: "explorer".into(), version: p.version.clone() }]);
        assert!(acceptances_from_store(&store, &Policy::default(), Some(&KEY)).is_empty(), "the default policy lists no pack app");
    }

    /// CoS E2 (1), bites: a file dialog (shell view or item dialog view) and an Explorer window are the Explorer
    /// surface, refused without the pack. Pass twins: a message box and an app window are not; with the pack the
    /// surface is allowed.
    #[test]
    fn file_dialogs_are_the_explorer_surface() {
        let c = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(is_shell_surface("#32770", &c(&["DUIViewWndClassName", "DirectUIHWND", "SHELLDLL_DefView"])), "Open/Save dialog");
        assert!(is_shell_surface("#32770", &c(&["DUIViewWndClassName"])), "item dialog host");
        assert!(is_shell_surface("CabinetWClass", &[]), "an Explorer window");
        assert!(!is_shell_surface("#32770", &c(&["Button", "Static"])), "a message box");
        assert!(!is_shell_surface("Notepad", &c(&["Edit", "msctls_statusbar32"])), "an app window");
        assert_eq!(shell_surface_ok(true, false).unwrap_err().0, "explorer_surface");
        assert!(shell_surface_ok(true, true).is_ok(), "pass: the pack is accepted");
        assert!(shell_surface_ok(false, false).is_ok(), "pass: not the surface");
    }

    /// CoS E2 (2), bites: elements that start a browser, online help or feedback; a new child of one of our
    /// processes. Pass twins: ordinary menu items and buttons; a new process of another parent; a child that existed.
    #[test]
    fn launches_outside_the_app_are_refused_or_caught() {
        for n in ["Search with Bing...", "Search with Bing...\tCtrl+E", "View Help", "Send Feedback", "Get help online", "Open in browser", "Learn more online"] {
            assert!(launches_outside(n), "{n}");
        }
        for n in ["Save", "Word Wrap", "Format", "Help", "Font...", "Select all", "Remember me", "Flip"] {
            assert!(!launches_outside(n), "{n}");
        }
    }

    /// CoS E2 (3), bites: the Startup folder by path (any case, forward slashes), through %APPDATA%, as shell:startup or
    /// shell:common startup; the policy and audit directories. Pass twins: an ordinary path and plain text.
    #[test]
    fn protected_places_are_refused_targets() {
        let (ad, pd) = (r"C:\Profiles\u\AppData\Roaming", r"C:\ProgramData");
        let mut protected = startup_dirs(ad, pd);
        protected.push(r"D:\w\tmp\maus\p2fix".into());
        let hit = |t: &str| protected_hit(t, &protected, ad, pd);
        assert!(hit(r"C:\Profiles\u\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\run.cmd").is_some());
        assert!(hit("c:/profiles/u/appdata/roaming/microsoft/windows/start menu/programs/startup").is_some(), "case and slashes");
        assert!(hit(r"%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\x.cmd").is_some(), "env form");
        assert!(hit(r"%programdata%\Microsoft\Windows\Start Menu\Programs\StartUp").is_some(), "common startup, env form");
        assert!(hit("shell:startup").is_some() && hit("SHELL:Common Startup").is_some(), "shell names");
        assert!(hit(r"D:\w\tmp\maus\p2fix\policy.json").is_some(), "policy directory");
        assert!(hit(r"d:/W/tmp/maus/P2FIX").is_some(), "policy directory itself, any case");
        assert!(hit(r"D:\w\tmp\maus\p2fixed\a.txt").is_none(), "pass: a sibling with a longer name");
        assert!(hit(r"D:\work\note.txt").is_none(), "pass: an ordinary path");
        assert!(hit("hello world").is_none(), "pass: plain text");
    }

    /// Review R4 M1 (live finding), bite: a watched window whose cache counts as current still gets the live check.
    /// Pass twins: stale gets it too; an unwatched window (no cache to compare) does not.
    #[test]
    fn the_live_check_runs_on_every_watched_action() {
        assert!(live_check_needed(true, Waited::Current(0)), "current by an unrelated event");
        assert!(live_check_needed(true, Waited::Stale(2000)));
        assert!(!live_check_needed(false, Waited::Current(0)));
    }

    fn ui_policy() -> Policy {
        Policy::parse(r#"{"apps":["C:\\Windows\\System32\\notepad.exe","C:\\Windows\\System32\\mspaint.exe","C:\\Windows\\System32\\calc.exe"],
            "ui":{"C:\\Windows\\System32\\notepad.exe":{"windows":["Notepad"],"controls":{"Edit":["type","key","set_value"],"MenuItem":["expand","collapse","invoke"]},"whitespace":["tab","newline"]},
                  "C:\\Windows\\System32\\mspaint.exe":{"windows":["MSPaintApp"],"controls":{"Button":["invoke"],"TabItem":["select"]}},
                  "C:\\Windows\\System32\\calc.exe":{"windows":["ApplicationFrameWindow"],"controls":{"Button":["invoke"]}}}}"#).unwrap()
    }

    /// CoS R5 root change, bites: an unlisted control type; an unlisted verb on a listed type; an element in an owned
    /// window the rule does not list (Notepad's Save dialog); an app with no rule; a window class not listed.
    /// Pass twins: Notepad typing and the Edit menu, a Calculator button, a Paint tool button and ribbon tab.
    #[test]
    fn the_action_gate_is_an_allowlist() {
        let p = ui_policy();
        let np = r"C:\Windows\System32\notepad.exe";
        let paint = r"C:\Windows\System32\mspaint.exe";
        let calc = r"C:\Windows\System32\calc.exe";
        let no = |exe: &str, w: &str, role: &str, verb: &str| p.ui_allows(exe, w, role, "x", verb).unwrap_err().0;
        assert_eq!(no(np, "Notepad", "Hyperlink", "invoke"), "ui_not_allowed", "unlisted control type");
        assert_eq!(no(np, "Notepad", "Edit", "toggle"), "ui_not_allowed", "unlisted verb on a listed type");
        assert_eq!(no(np, "Notepad", "MenuItem", "set_value"), "ui_not_allowed", "unlisted pattern on a menu item");
        assert_eq!(no(np, "#32770", "Button", "invoke"), "ui_not_allowed", "element in an unlisted owned window");
        assert_eq!(no(np, "#32770", "Edit", "set_value"), "ui_not_allowed", "the Save dialog's file name");
        assert_eq!(no(r"C:\x\other.exe", "Other", "Button", "invoke"), "ui_not_allowed", "no rule for the app");
        assert_eq!(p.ui_window_allowed(np, "#32770").unwrap_err().0, "ui_not_allowed", "window not listed");
        assert_eq!(Policy::default().ui_allows(r"C:\x\other.exe", "W", "Button", "OK", "invoke").unwrap_err().0, "ui_not_allowed");

        assert!(p.ui_allows(np, "Notepad", "Edit", "Text Editor", "type").is_ok(), "pass: Notepad typing");
        assert!(p.ui_allows(np, "Notepad", "MenuItem", "Edit", "expand").is_ok(), "pass: Notepad menu Edit");
        // Windows 10 Notepad names its menu items with the accelerator ("Delete\tDel"); the allowlist is on the name without it.
        let d = Policy::default(); // the shipped allowlist (names listed), not this test policy
        let win10 = |raw: &str| d.ui_allows(np, "#32768", "MenuItem", &crate::tree::display_name("MenuItem", raw), "invoke");
        assert!(win10("Delete\tDel").is_ok(), "pass: Windows 10 Notepad Edit > Delete");
        assert!(win10("Select All\tCtrl+A").is_ok() && win10("Time/Date\tF5").is_ok() && win10("Undo\tCtrl+Z").is_ok());
        assert_eq!(win10("Paste\tCtrl+V").unwrap_err().0, "ui_not_allowed", "bite: no clipboard route, with or without the accelerator");
        assert_eq!(win10("Cut\tCtrl+X").unwrap_err().0, "ui_not_allowed");
        assert_eq!(win10("Search with Bing...\tCtrl+E").unwrap_err().0, "ui_not_allowed", "an item that opens a browser stays refused");
        assert!(p.ui_allows(&np.to_uppercase(), "Notepad", "MenuItem", "Undo", "invoke").is_ok(), "pass: any case of the path");
        assert!(p.ui_allows(calc, "ApplicationFrameWindow", "Button", "One", "invoke").is_ok(), "pass: a Calculator button");
        assert!(p.ui_allows(paint, "MSPaintApp", "Button", "Pencil", "invoke").is_ok(), "pass: a Paint tool button");
        assert!(p.ui_allows(paint, "MSPaintApp", "TabItem", "View", "select").is_ok(), "pass: a Paint ribbon tab");
        assert!(p.ui_window_allowed(np, "Notepad").is_ok());

        // The default policy carries the rules for Notepad, Calculator and Paint (normal editing only).
        let d = Policy::default();
        assert!(d.ui_allows(np, "Notepad", "Edit", "Text Editor", "type").is_ok(), "default: Notepad typing");
        assert!(d.ui_allows(paint, "MSPaintApp", "Button", "Pencil", "invoke").is_ok(), "default: Paint tool button");
        assert!(d.ui_allows(calc, "ApplicationFrameWindow", "Button", "One", "invoke").is_ok(), "default: Calculator button");
        assert_eq!(d.ui_allows(np, "#32770", "Button", "Save", "invoke").unwrap_err().0, "ui_not_allowed", "default: no file dialog");
        assert_eq!(d.ui_allows(r"C:\Windows\explorer.exe", "CabinetWClass", "Button", "Select all", "invoke").unwrap_err().0, "ui_not_allowed", "default: no Explorer");
    }

    /// R5 pixel fallback, policy side: `Pointer` is a control type of its own with the verbs click and drag. Only an app whose
    /// rule lists it may be pointed at (Paint's drawing surface); Notepad and Calculator are not, in the default policy or a file.
    #[test]
    fn r5_pointer_is_an_allowlisted_control_type_only_for_paint() {
        let (np, paint, calc) = (r"C:\Windows\System32\notepad.exe", r"C:\Windows\System32\mspaint.exe", r"C:\Windows\System32\calc.exe");
        let d = Policy::default();
        assert!(d.ui_allows(paint, "MSPaintApp", "Pointer", "", "click").is_ok(), "default: Paint click");
        assert!(d.ui_allows(paint, "MSPaintApp", "Pointer", "", "drag").is_ok(), "default: Paint drag");
        assert_eq!(d.ui_allows(np, "Notepad", "Pointer", "", "click").unwrap_err().0, "ui_not_allowed", "default: not Notepad");
        assert_eq!(d.ui_allows(calc, "ApplicationFrameWindow", "Pointer", "", "drag").unwrap_err().0, "ui_not_allowed", "default: not Calculator");
        assert_eq!(d.ui_allows(paint, "#32770", "Pointer", "", "click").unwrap_err().0, "ui_not_allowed", "default: not a dialog");
        let from_file = Policy::parse(r#"{"apps":["C:\\Windows\\System32\\mspaint.exe"],"ui":{"C:\\Windows\\System32\\mspaint.exe":{"windows":["MSPaintApp"],"controls":{"Pointer":["click","drag"],"Button":["invoke"]}}}}"#)
            .expect("a policy file may list the Pointer control type with click and drag");
        assert!(from_file.ui_allows(paint, "MSPaintApp", "Pointer", "", "drag").is_ok());
        assert_eq!(from_file.ui_allows(paint, "MSPaintApp", "Button", "Pencil", "click").unwrap_err().0, "ui_not_allowed", "click is not a verb of Button");
    }

    /// Review R5 M1, bite: an element whose top-level window is an owned dialog, addressed through the main window.
    /// Pass twin: the element's top-level window is the addressed one.
    #[test]
    fn an_element_is_acted_on_only_through_its_own_window() {
        assert_eq!(same_root(0x100, 0x200).unwrap_err().0, "owned_window");
        assert!(same_root(0x100, 0x100).is_ok());
    }

    /// R5d (spare R5c rerun): on Windows 10 Notepad the Edit-menu popup is a separate window, so the T42 control "yes -> Delete"
    /// was refused as `owned_window`. A popup menu of the same process now counts; control is not widened past that.
    #[test]
    fn a_popup_menu_of_the_addressed_process_is_acted_on_and_nothing_else_is_widened() {
        const MENU: &str = "#32768";
        assert!(same_root_or_menu(0x100, 0x200, MENU, 42, 42).is_ok(), "the Edit menu popup of the same process");
        assert!(same_root_or_menu(0x100, 0x100, "Notepad", 42, 42).is_ok(), "the addressed window itself, as before");
        // Bites: another process's popup menu (a menu of some other app that is open at the same time) is refused.
        assert_eq!(same_root_or_menu(0x100, 0x200, MENU, 99, 42).unwrap_err().0, "owned_window", "another process's popup");
        // Not widened to other windows of the same process: an owned dialog and another top-level window are still refused.
        assert_eq!(same_root_or_menu(0x100, 0x200, "#32770", 42, 42).unwrap_err().0, "owned_window", "an owned dialog (R5 M1)");
        assert_eq!(same_root_or_menu(0x100, 0x200, "Notepad", 42, 42).unwrap_err().0, "owned_window", "a second Notepad window");
        assert_eq!(same_root_or_menu(0x100, 0x200, "#32768 ", 42, 42).unwrap_err().0, "owned_window", "the class is compared whole");
        assert_eq!(same_root_or_menu(0x100, 0x200, "", 42, 42).unwrap_err().0, "owned_window", "an unreadable class is not a menu");
    }

    /// Review R5 M3, bites: U+0016 (paste), U+0003 (copy), U+0018 (cut), U+001A (undo), ESC, NUL, CR, DEL, C1 NEL;
    /// a tab where the rule lists none. Pass twins: printable text in any script with the listed tab and newline.
    #[test]
    fn type_sends_printable_text_and_listed_whitespace_only() {
        let p = ui_policy();
        let np = r"C:\Windows\System32\notepad.exe";
        for c in ['\u{16}', '\u{3}', '\u{18}', '\u{1a}', '\u{1b}', '\u{0}', '\r', '\u{7f}', '\u{85}'] {
            assert_eq!(p.ui_text_allowed(np, &format!("ab{c}cd")).unwrap_err().0, "bad_text", "U+{:04X}", c as u32);
        }
        assert_eq!(p.ui_text_allowed(r"C:\Windows\System32\mspaint.exe", "a\tb").unwrap_err().0, "bad_text", "no whitespace listed");
        assert!(p.ui_text_allowed(np, "plain text, a tab\there, a new line\nend").is_ok());
        assert!(p.ui_text_allowed(np, "Tiếng Việt và 日本語").is_ok(), "pass: any printable script");
    }

    /// Review R5 M2, bites: a child that appeared at any time (no baseline window), a grandchild below a same-image
    /// helper, a grandchild below a different child. Pass twins: same-image helpers; unrelated processes; our own
    /// processes; a parent loop ends.
    #[test]
    fn descendants_of_ours_are_caught_whenever_they_appear() {
        // 100 = ours (Code.exe); 110 = Code.exe helper; 120 = git.exe under the helper; 130 = ping.exe child of 100;
        // 140 = conhost.exe under 130; 900 = unrelated; 50 and 51 point at each other.
        let procs = [(100, 4), (110, 100), (120, 110), (130, 100), (140, 130), (900, 4), (50, 51), (51, 50)];
        let image = |p: u32| match p { 100 | 110 => "code.exe", 120 => "git.exe", 130 => "ping.exe", 140 => "conhost.exe", _ => "other.exe" };
        let same = |a: u32, b: u32| image(a) == image(b);
        let mut got = spawned_descendants(&procs, &[100], same);
        got.sort();
        assert_eq!(got, vec![120, 130, 140]);
        assert!(spawned_descendants(&procs, &[900], same).is_empty(), "nothing below 900");
        assert!(spawned_descendants(&[(100, 4), (110, 100)], &[100], same).is_empty(), "pass: a same-image helper");
        assert!(spawned_descendants(&procs, &[], same).is_empty(), "pass: nothing is ours");
    }

    /// Review R5 S1 path tricks, each a bite against the real folders of this machine: doubled backslashes, a trailing
    /// dot, `..` segments, other environment variables, 8.3 short names, the old-profile junctions, `\\?\` and the
    /// admin share `\\localhost\C$`, `shell:::{CLSID}`. Pass twins: an ordinary folder, the same tricks pointing
    /// elsewhere.
    #[test]
    fn protected_place_path_tricks_are_resolved() {
        let env = |k: &str| std::env::var(k).unwrap_or_default();
        let (ad, pd, up) = (env("APPDATA"), env("ProgramData"), env("USERPROFILE"));
        let protected = startup_dirs(&ad, &pd);
        let startup = protected[0].clone();
        assert!(Path::new(&startup).is_dir(), "this machine has {startup}");
        let hit = |t: &str| protected_hit(t, &protected, &ad, &pd);
        let tricks = [
            ("doubled backslashes", startup.replace('\\', "\\\\") + "\\\\run.cmd"),
            ("trailing dot", format!("{startup}.\\run.cmd")),
            ("dot-dot", format!("{ad}\\Microsoft\\Windows\\Start Menu\\Programs\\..\\Programs\\Startup\\run.cmd")),
            ("%USERPROFILE%", "%USERPROFILE%\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\run.cmd".into()),
            ("%LOCALAPPDATA%\\..", "%LOCALAPPDATA%\\..\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup".into()),
            ("%ALLUSERSPROFILE%", "%ALLUSERSPROFILE%\\Microsoft\\Windows\\Start Menu\\Programs\\StartUp\\x.cmd".into()),
            ("8.3 name", format!("{ad}\\Microsoft\\Windows\\STARTM~1\\Programs\\Startup\\run.cmd")),
            ("Application Data junction", format!("{up}\\Application Data\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\run.cmd")),
            ("Documents and Settings junction", format!("C:\\Documents and Settings\\{}\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup", Path::new(&up).file_name().unwrap().to_string_lossy())),
            ("\\\\?\\ prefix", format!("\\\\?\\{startup}\\run.cmd")),
            ("admin share", format!("\\\\localhost\\C$\\{}\\run.cmd", &startup[3..])),
            ("shell CLSID", "shell:::{B97D20BB-F46A-4C97-BA10-5E3608430854}".into()),
        ];
        for (what, t) in &tricks {
            assert!(hit(t).is_some(), "{what}: {t}");
        }
        assert!(hit(&format!("{ad}\\Microsoft\\Windows\\Start Menu\\Programs\\Accessories\\x.lnk")).is_none(), "pass: a sibling folder");
        assert!(hit(&format!("{up}\\Application Data\\Microsoft\\Windows\\Templates")).is_none(), "pass: the junction to another folder");
        assert!(hit("%LOCALAPPDATA%\\Temp\\notes.txt").is_none(), "pass: an ordinary folder");
    }

    /// A file system hook that records every call and answers like the real one.
    struct Recording(std::cell::RefCell<Vec<String>>);
    impl PathFs for Recording {
        fn is_local_drive(&self, letter: char) -> bool {
            self.0.borrow_mut().push(format!("drive {letter}"));
            LocalFs.is_local_drive(letter)
        }
        fn canonicalize(&self, path: &str) -> Option<String> {
            self.0.borrow_mut().push(format!("canonicalize {path}"));
            LocalFs.canonicalize(path)
        }
    }

    /// Review R6 B1, bites: typed text with a URL makes no file system call at all (so none can reach the network)
    /// and returns at once; a UNC path, an admin share, \\?\UNC and \\.\ forms are refused with no call; a mapped
    /// network drive letter is never resolved. Pass twin: a local path still resolves (the calls go to a local drive).
    #[test]
    fn the_path_check_never_reaches_the_network() {
        let protected = vec![r"C:\ProgramData\Microsoft\Windows\Start Menu\Programs\StartUp".to_string()];
        let check = |t: &str| {
            let fs = Recording(Default::default());
            let t0 = std::time::Instant::now();
            let hit = protected_hit_with(t, &protected, r"C:\x", r"C:\ProgramData", &fs);
            (hit, fs.0.into_inner(), t0.elapsed())
        };
        for url in ["see https://192.0.2.1/page for details", "http://example.invalid/a/b", "mail me at a@b.example, see https://x.example//y"] {
            let (hit, calls, took) = check(url);
            assert!(hit.is_none(), "{url}: not a protected place");
            assert!(calls.is_empty(), "{url}: no file system call, got {calls:?}");
            assert!(took < std::time::Duration::from_millis(50), "{url}: {took:?}");
        }
        for unc in [r"\\192.0.2.1\share\x", r"save to \\host.example\c$\Users", r"\\?\UNC\192.0.2.1\s\x", r"\\localhost\C$\Windows", r"\\.\pipe\x", "//192.0.2.1/share/x", "open file://192.0.2.1/x"] {
            let (hit, calls, took) = check(unc);
            assert!(hit.is_some(), "{unc}: a UNC or device path is refused");
            assert!(calls.is_empty(), "{unc}: refused with no file system call, got {calls:?}");
            assert!(took < std::time::Duration::from_millis(50), "{unc}: {took:?}");
        }
        let (_, calls, _) = check(r"C:\Windows\notes.txt");
        assert!(calls.iter().any(|c| c.starts_with("canonicalize C:")), "pass: a local path is resolved: {calls:?}");
        assert!(calls.iter().all(|c| !c.contains(r"\\")), "only local paths reach the file system: {calls:?}");
    }

    /// Review R6 B2, bites (default rules): Paint's "Help" (opens a browser) and "Edit with Paint 3D" (activates another
    /// app); Notepad's Help menu items. Pass twins: Paint's Pencil and Eraser, Notepad's Edit menu and Undo.
    #[test]
    fn default_rules_list_no_element_that_opens_another_app() {
        let d = Policy::default();
        let (np, paint) = (r"C:\Windows\System32\notepad.exe", r"C:\Windows\System32\mspaint.exe");
        let no = |exe: &str, w: &str, role: &str, name: &str, verb: &str| d.ui_allows(exe, w, role, name, verb).unwrap_err().0;
        assert_eq!(no(paint, "MSPaintApp", "Button", "Help", "invoke"), "ui_not_allowed", "Paint Help");
        assert_eq!(no(paint, "MSPaintApp", "Button", "Edit with Paint 3D", "invoke"), "ui_not_allowed", "Paint 3D");
        assert_eq!(no(np, "Notepad", "MenuItem", "Help", "expand"), "ui_not_allowed", "Notepad Help menu");
        assert_eq!(no(np, "#32768", "MenuItem", "View Help", "invoke"), "ui_not_allowed", "Notepad View Help");
        assert_eq!(no(np, "#32768", "MenuItem", "Search with Bing...", "invoke"), "ui_not_allowed", "Notepad Bing");
        assert!(d.ui_allows(paint, "MSPaintApp", "Button", "Pencil", "invoke").is_ok(), "pass: Paint Pencil");
        assert!(d.ui_allows(paint, "MSPaintApp", "Button", "Eraser", "invoke").is_ok(), "pass: Paint Eraser");
        assert!(d.ui_allows(np, "Notepad", "MenuItem", "Edit", "expand").is_ok(), "pass: Notepad Edit menu");
        assert!(d.ui_allows(np, "#32768", "MenuItem", "Undo", "invoke").is_ok(), "pass: Notepad Edit > Undo");
    }

    /// Review R6 B3, bites (default rules): every paste route of the owner's clipboard: Notepad Edit > Paste, Paint's
    /// Paste split button and its Paste / Paste from menu items; also Cut and Copy (they overwrite it). Pass twin:
    /// Notepad Edit > Undo and Select All, Paint Select.
    #[test]
    fn default_rules_list_no_clipboard_route() {
        let d = Policy::default();
        let (np, paint) = (r"C:\Windows\System32\notepad.exe", r"C:\Windows\System32\mspaint.exe");
        let no = |exe: &str, w: &str, role: &str, name: &str, verb: &str| d.ui_allows(exe, w, role, name, verb).unwrap_err().0;
        assert_eq!(no(np, "#32768", "MenuItem", "Paste", "invoke"), "ui_not_allowed", "Notepad Edit > Paste");
        assert_eq!(no(np, "#32768", "MenuItem", "Cut", "invoke"), "ui_not_allowed", "Notepad Edit > Cut");
        assert_eq!(no(np, "#32768", "MenuItem", "Copy", "invoke"), "ui_not_allowed", "Notepad Edit > Copy");
        assert_eq!(no(paint, "MSPaintApp", "SplitButton", "Paste", "invoke"), "ui_not_allowed", "Paint Paste");
        assert_eq!(no(paint, "#32768", "MenuItem", "Paste", "invoke"), "ui_not_allowed", "Paint Paste menu item");
        assert_eq!(no(paint, "#32768", "MenuItem", "Paste from", "invoke"), "ui_not_allowed", "Paint Paste from");
        assert!(d.ui_allows(np, "#32768", "MenuItem", "Undo", "invoke").is_ok());
        assert!(d.ui_allows(np, "#32768", "MenuItem", "Select All", "invoke").is_ok());
        assert!(d.ui_allows(paint, "MSPaintApp", "SplitButton", "Select", "invoke").is_ok());
    }

    /// Review R7 B1-R7, bites: the thread query failed; each menu mode; move/size; a mouse capture; no focus window;
    /// the focus window outside the addressed window; the focus window not the focused element's own window. Pass
    /// twins: typing into Notepad's edit with no menu open; an element without a window of its own.
    #[test]
    fn keys_go_only_where_the_thread_state_says() {
        let (main, edit) = (0x100u64, 0x101u64);
        let ok = |flags: u32, capture: u64, focus: u64, root: u64, native: u64| thread_state_ok(true, flags, capture, focus, root, main, native);
        assert_eq!(thread_state_ok(false, 0, 0, edit, main, main, edit).unwrap_err().0, "thread_state_unknown");
        for f in [GUI_INMENUMODE, GUI_POPUPMENUMODE, GUI_SYSTEMMENUMODE, GUI_INMENUMODE | GUI_POPUPMENUMODE] {
            assert_eq!(ok(f, 0, edit, main, edit).unwrap_err().0, "menu_mode", "flags {f:#x}");
        }
        assert_eq!(ok(GUI_INMOVESIZE, 0, edit, main, edit).unwrap_err().0, "capture_mode");
        assert_eq!(ok(0, 0x555, edit, main, edit).unwrap_err().0, "capture_mode");
        assert_eq!(ok(0, 0, 0, 0, edit).unwrap_err().0, "focus_elsewhere", "no focus window");
        assert_eq!(ok(0, 0, 0x200, 0x200, 0).unwrap_err().0, "focus_elsewhere", "focus in another window");
        assert_eq!(ok(0, 0, 0x102, main, edit).unwrap_err().0, "focus_elsewhere", "focus window is not the element's");
        assert!(ok(0, 0, edit, main, edit).is_ok(), "pass: Notepad's edit, no menu");
        assert!(ok(0x1, 0, edit, main, 0).is_ok(), "pass: caret blinking, element without its own window");
    }

    /// Review R8 S3, bites: the foreground window belongs to another thread; either thread unknown. Pass twin: the same
    /// thread.
    #[test]
    fn keys_go_only_to_the_addressed_windows_thread() {
        assert_eq!(same_input_thread(10, 11).unwrap_err().0, "focus_elsewhere");
        assert_eq!(same_input_thread(0, 0).unwrap_err().0, "thread_state_unknown");
        assert_eq!(same_input_thread(10, 0).unwrap_err().0, "thread_state_unknown");
        assert!(same_input_thread(10, 10).is_ok());
    }

    fn lv(ct: i32, name: &str, class: &str, enabled: bool) -> Level {
        Level { control_type: ct, name: name.into(), class_name: class.into(), enabled, state: String::new() }
    }

    fn levels() -> Vec<Level> {
        vec![lv(50032, "*Untitled - Notepad", "Notepad", true), lv(50033, "", "", true), lv(50000, "Select none", "", true)]
    }

    /// The levels follow the path from the window down; a path that leads nowhere gives None.
    #[test]
    fn chain_walks_from_the_window_to_the_element() {
        use crate::tree::Node;
        let leaf = Node { control_type: 50000, name: "OK".into(), enabled: true, ..Default::default() };
        let pane = Node { control_type: 50033, name: "pane".into(), enabled: true, children: vec![Node::default(), leaf], ..Default::default() };
        let root = Node { control_type: 50032, name: "Win".into(), class_name: "Cls".into(), enabled: true, children: vec![pane], ..Default::default() };
        let c = chain(&root, &[0, 1]).expect("path exists");
        assert_eq!(c.iter().map(|l| l.name.as_str()).collect::<Vec<_>>(), ["Win", "pane", "OK"]);
        assert_eq!(c[0].class_name, "Cls");
        assert!(chain(&root, &[0, 5]).is_none(), "no such child");
        assert_eq!(chain(&root, &[]).unwrap().len(), 1, "the window itself");
    }

    /// Rule (b) bites: a different name, enabled state, control type or ancestor, a different window class, a
    /// different depth or id, or the element gone, each refuse. Pass twins: identical; the window title changed only.
    #[test]
    fn stale_cache_acts_only_when_the_live_element_matches() {
        let cached = levels();
        assert!(same_as_cache("e1", &cached, Some(("e1", &cached))).is_ok(), "pass: identical");
        let mut t = cached.clone();
        t[0].name = "Untitled - Notepad".into();
        assert!(same_as_cache("e1", &cached, Some(("e1", &t))).is_ok(), "pass: only the window title differs");

        let bite = |f: &dyn Fn(&mut Vec<Level>)| {
            let mut l = cached.clone();
            f(&mut l);
            same_as_cache("e1", &cached, Some(("e1", &l))).unwrap_err().0
        };
        assert_eq!(bite(&|l| l[2].name = "Select all".into()), "stale_mismatch", "element name");
        assert_eq!(bite(&|l| l[2].enabled = false), "stale_mismatch", "element enabled");
        assert_eq!(bite(&|l| l[2].control_type = 50002), "stale_mismatch", "element control type");
        assert_eq!(bite(&|l| l[1].name = "other pane".into()), "stale_mismatch", "ancestor name");
        assert_eq!(bite(&|l| l[0].class_name = "Other".into()), "stale_mismatch", "owning window class");
        assert_eq!(bite(&|l| { l.insert(1, lv(50033, "", "", true)); }), "stale_mismatch", "depth");
        assert_eq!(same_as_cache("e1", &cached, Some(("e2", &cached))).unwrap_err().0, "stale_mismatch", "id");
        assert_eq!(same_as_cache("e1", &cached, None).unwrap_err().0, "stale_gone", "element gone");
    }

    fn gate_of(flag: &Arc<AtomicBool>) -> impl Fn() -> Result<(), Refusal> + '_ {
        move || if flag.load(Ordering::SeqCst) { Err(("killed", "stop hotkey".into())) } else { Ok(()) }
    }

    /// Bite (review B1): a kill during the freshness wait ends the wait within one poll and no side effect runs; a
    /// kill after the wait but before the side effect also stops it. Pass twin: no kill, the side effect runs.
    #[test]
    fn kill_during_the_wait_or_before_the_effect_stops_the_action() {
        let killed = Arc::new(AtomicBool::new(false));
        let k = killed.clone();
        let t0 = Instant::now();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            k.store(true, Ordering::SeqCst);
        });
        let mut effects = 0;
        let r = wait_fresh(|| (true, None), Some(t0), gate_of(&killed), Duration::from_millis(FRESH_WAIT_MS))
            .and_then(|_| guarded(gate_of(&killed), || { effects += 1; Ok(()) }));
        assert_eq!(r.unwrap_err().0, "killed", "a kill during the wait refuses");
        assert!(t0.elapsed() < Duration::from_millis(400), "the wait ended at the kill, not at the bound: {:?}", t0.elapsed());
        assert_eq!(effects, 0, "no side effect after a kill during the wait");

        let late = Arc::new(AtomicBool::new(false));
        let w = wait_fresh(|| (false, Some(Instant::now())), Some(t0), gate_of(&late), Duration::from_millis(FRESH_WAIT_MS));
        assert!(matches!(w, Ok(Waited::Current(_))));
        late.store(true, Ordering::SeqCst);
        let r = guarded(gate_of(&late), || { effects += 1; Ok(()) });
        assert_eq!(r.unwrap_err().0, "killed", "a kill between the wait and the side effect refuses");
        assert_eq!(effects, 0);

        let open = Arc::new(AtomicBool::new(false));
        assert!(guarded(gate_of(&open), || { effects += 1; Ok(()) }).is_ok());
        assert_eq!(effects, 1, "pass twin: not killed, the side effect runs");
    }

    /// Bite (review S1): a cache that never becomes current ends the wait at the 2 s bound and the action is refused
    /// (stale_cache). Pass twin: a cache that becomes current after 100 ms ends the wait then, and the wait is reported.
    #[test]
    fn a_cache_that_never_becomes_current_is_refused_at_the_bound() {
        let open = Arc::new(AtomicBool::new(false));
        let t0 = Instant::now();
        let w = wait_fresh(|| (false, None), Some(t0), gate_of(&open), Duration::from_millis(FRESH_WAIT_MS)).unwrap();
        let took = t0.elapsed();
        assert!(matches!(w, Waited::Stale(_)), "{w:?}");
        assert!(took >= Duration::from_millis(FRESH_WAIT_MS) && took < Duration::from_millis(FRESH_WAIT_MS + 400), "{took:?}");
        assert_eq!(require_current(w).unwrap_err().0, "stale_cache");

        let start = Instant::now();
        let w = wait_fresh(|| (false, (start.elapsed() > Duration::from_millis(100)).then(Instant::now)), Some(start), gate_of(&open), Duration::from_millis(FRESH_WAIT_MS)).unwrap();
        let ms = require_current(w).expect("current after 100 ms");
        assert!((100..400).contains(&ms), "waited {ms} ms");
    }

    /// Bite (review S3): typing goes one keystroke per batch, so the focused field is checked before every key.
    #[test]
    fn typing_batches_are_single_keystrokes() {
        let b = crate::rails::batches("ab\tcdefghij", TYPE_BATCH_CHARS);
        assert_eq!(b.len(), 11);
        assert!(b.iter().all(|x| x.chars().count() == 1), "{b:?}");
    }

    #[test]
    fn policy_file_parses_and_rejects_bad_shapes() {
        let p = Policy::parse(r#"{"apps":["C:\\Windows\\System32\\notepad.exe","D:\\x\\fixture.exe"]}"#).unwrap();
        assert_eq!(p.apps.len(), 2);
        assert_eq!(Policy::parse("{}").unwrap_err().0, "bad_policy");
        assert_eq!(Policy::parse(r#"{"apps":"notepad"}"#).unwrap_err().0, "bad_policy");
        assert_eq!(Policy::parse(r#"{"apps":[1]}"#).unwrap_err().0, "bad_policy");
        assert_eq!(Policy::parse("not json").unwrap_err().0, "bad_policy");
    }

    #[test]
    fn app_allowlist_bites_and_passes() {
        let p = Policy::default();
        assert_eq!(p.allow_app(r"C:\Windows\System32\charmap.exe").unwrap_err().0, "app_not_allowed");
        assert_eq!(p.allow_app(r"C:\Windows\System32\notepad.exe.evil").unwrap_err().0, "app_not_allowed");
        assert_eq!(p.allow_app("").unwrap_err().0, "app_not_allowed");
        assert!(p.allow_app(r"c:\windows\system32\NOTEPAD.EXE").is_ok());
    }

    #[test]
    fn own_window_is_refused() {
        assert_eq!(not_own_window(42, 42).unwrap_err().0, "own_window");
        assert!(not_own_window(43, 42).is_ok());
    }

    #[test]
    fn password_field_is_refused() {
        assert_eq!(not_password(true).unwrap_err().0, "password_field");
        assert!(not_password(false).is_ok());
    }

    #[test]
    fn stale_or_updating_cache_is_refused_fresh_passes() {
        let t0 = Instant::now();
        let later = t0 + Duration::from_millis(10);
        assert_eq!(fresh(true, Some(later), Some(t0)).unwrap_err().0, "stale_cache", "still updating");
        assert_eq!(fresh(false, Some(t0), Some(later)).unwrap_err().0, "stale_cache", "cache older than our last action");
        assert_eq!(fresh(false, None, Some(t0)).unwrap_err().0, "stale_cache", "acted, cache never updated");
        assert!(fresh(false, Some(later), Some(t0)).is_ok(), "updated after our action");
        assert!(fresh(false, Some(t0), None).is_ok(), "no action yet");
    }
}
