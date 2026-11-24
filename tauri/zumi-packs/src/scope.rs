//! The scope check (roadmap 1.4, layer 2): one pure function that answers "may this pack do this?" from the manifest scope and the
//! user's grants. Nothing here touches the OS except reading file metadata to resolve a path and the PATH to find a program.
use crate::manifest::Manifest;
use serde_json::Value;
use std::path::{Component, Path, PathBuf};

/// What the user granted this pack (`<data>/packs-state/<id>/grants.json`): a folder, added origins, programs, a LAN switch.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Grants {
    pub workspace: Option<PathBuf>,
    /// `user-chosen` folders.
    pub paths: Vec<PathBuf>,
    /// `user-added` origins (`https://host`, or an `http://127.0.0.1:port` the user typed).
    pub origins: Vec<String>,
    /// `user-chosen` programs, each an absolute path.
    pub programs: Vec<PathBuf>,
    /// The separate "other devices may knock" grant for `net.listen` with `bind: lan`.
    pub lan: bool,
}

/// Where the host keeps things for one pack.
#[derive(Debug, Clone)]
pub struct Env {
    /// `<data>/packs-state/<id>/data`: the pack's own folder (the `pack-data` root). Its parent holds grants and consent, which no
    /// scope ever includes.
    pub pack_data: PathBuf,
    /// Folders no scope ever reaches, whatever a grant says: the host's data dir (grants, consent, audit, settings) and the app's own
    /// folders. `pack_data` is the one carve-out inside them.
    pub protected: Vec<PathBuf>,
}

/// One thing a helper asks the broker to do.
#[derive(Debug, Clone, PartialEq)]
pub enum Action<'a> {
    Spawn { program: &'a str, cwd: Option<&'a Path>, args: &'a [String] },
    Read { path: &'a Path },
    Write { path: &'a Path },
    Connect { url: &'a str },
    Listen { bind: &'a str, port: u16 },
}

impl Action<'_> {
    /// The capability the action needs.
    pub fn capability(&self) -> &'static str {
        match self {
            Action::Spawn { .. } => "proc.spawn",
            Action::Read { .. } => "fs.read",
            Action::Write { .. } => "fs.write",
            Action::Connect { .. } => "net.egress",
            Action::Listen { .. } => "net.listen",
        }
    }
}

/// What the broker may do once the scope said yes.
#[derive(Debug, Clone, PartialEq)]
pub enum Allowed {
    /// The program resolved to an absolute path, and the folder it starts in.
    Spawn { exe: PathBuf, cwd: PathBuf },
    /// The path, resolved through links, inside a granted root.
    Path(PathBuf),
    /// The origins the pack's egress may reach (manifest ceiling, narrowed to the user's grants). The egress guard does the rest.
    Origins(Vec<String>),
    /// Loopback, or all interfaces when the manifest said `lan` and the user granted it.
    Listen { lan: bool },
}

/// R7c (re-gate R7b n14): under `shell: false` a pack may list only programs Zumia has REVIEWED, and a deny list cannot do that job (xcopy,
/// robocopy, curl, tar, esentutl ... all copy or fetch what the pack has no right to). A program is on this list only if it takes no file,
/// command line or address from its arguments that reaches beyond what it prints. Anything else needs `shell: true` (declared, and the
/// consent says a program it starts can do anything the user can), or a program the person chose by exact path.
const REVIEWED: &[&str] = &["hostname", "whoami", "ping"];

/// Programs that give a shell, run code they are handed, or run another command line from their arguments (R7b, gate should-fix 1:
/// `forfiles /c "cmd /c ..."` turned `shell: false` into a shell). A pack may start one only if its manifest says `shell: true`, even when
/// the name is on its list (also a program the person chose by path). Not a complete list, which is why `REVIEWED` is the real boundary.
const SHELLS: &[&str] = &[
    // shells and script hosts
    "cmd", "powershell", "powershell_ise", "pwsh", "bash", "sh", "zsh", "wsl", "wslhost", "wscript", "cscript", "mshta", "conhost", "openconsole", "wt",
    // interpreters and runtimes
    "node", "deno", "bun", "python", "python3", "pythonw", "py", "pyw", "perl", "ruby", "php", "lua", "java", "javaw", "dotnet", "csi", "fsi",
    // run a command line or code from their arguments (LOLBins)
    "forfiles", "wmic", "schtasks", "at", "certutil", "bitsadmin", "msbuild", "installutil", "regasm", "regsvcs", "cmstp", "mavinject", "odbcconf", "pcalua",
    "rundll32", "regsvr32", "msiexec", "msdt", "hh", "infdefaultinstall", "presentationhost", "control", "mmc", "explorer", "runas", "sc", "reg", "regedit",
    "winrs", "wsmprovhost", "scriptrunner", "syncappvpublishingserver", "appvlp", "ieexec", "csc", "vbc", "jsc", "ftp", "git", "ssh", "npm", "npx", "pip", "conda",
];

const DEVICE_NAMES: &[&str] = &["con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9"];

fn scope_of<'a>(manifest: &'a Manifest, capability: &str) -> Result<&'a Value, &'static str> {
    manifest.capability(capability).map(|c| &c.scope).ok_or("no_capability")
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default()
}

/// `\\?\C:\x` becomes `C:\x` (what `canonicalize` returns on Windows).
fn plain(p: PathBuf) -> PathBuf {
    let t = p.to_string_lossy();
    match t.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => PathBuf::from(rest),
        _ => p,
    }
}

/// An absolute path, resolved through links (a junction or symlink is followed to where it really goes), for a file or folder that may
/// not exist yet: the nearest existing parent is resolved and the rest is appended. The text itself is refused if it climbs (`..`), names
/// a device or a stream, is relative, UNC or a `\\?\` path.
pub fn resolve(path: &Path) -> Result<PathBuf, &'static str> {
    let raw = path.to_string_lossy();
    if raw.starts_with(r"\\") || raw.starts_with("//") || !path.is_absolute() {
        return Err("path_bad");
    }
    for c in path.components() {
        match c {
            Component::ParentDir | Component::CurDir => return Err("path_bad"),
            Component::Normal(n) => {
                let n = n.to_string_lossy();
                let stem = n.split('.').next().unwrap_or("").trim_end().to_lowercase();
                if n.is_empty() || n.contains([':', '<', '>', '"', '|', '?', '*']) || n.ends_with('.') || n.ends_with(' ') || DEVICE_NAMES.contains(&stem.as_str()) {
                    return Err("path_bad");
                }
            }
            _ => {}
        }
    }
    let mut existing = path.to_path_buf();
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    let base = loop {
        match existing.canonicalize() {
            Ok(c) => break plain(c),
            Err(_) => {
                let Some(name) = existing.file_name().map(|n| n.to_os_string()) else { return Err("path_bad") };
                tail.push(name);
                if !existing.pop() {
                    return Err("path_bad");
                }
            }
        }
    };
    Ok(tail.iter().rev().fold(base, |acc, n| acc.join(n)))
}

fn key(p: &Path) -> Vec<String> {
    p.components().map(|c| c.as_os_str().to_string_lossy().to_lowercase()).collect()
}

/// `p` is `root` or below it, compared by whole components and without regard to case (Windows).
fn inside(p: &Path, root: &Path) -> bool {
    let (a, b) = (key(p), key(root));
    a.len() >= b.len() && a[..b.len()] == b[..]
}

/// The folders a scope's `roots` word list names, resolved. A root that does not exist is simply not a root.
fn roots(words: &[String], grants: &Grants, env: &Env) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for w in words {
        match w.as_str() {
            "pack-data" => out.extend(resolve(&env.pack_data).ok()),
            "workspace" => out.extend(grants.workspace.as_deref().and_then(|p| resolve(p).ok())),
            "user-chosen" => out.extend(grants.paths.iter().filter_map(|p| resolve(p).ok())),
            _ => {}
        }
    }
    out
}

#[cfg(windows)]
fn is_link(m: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    m.file_type().is_symlink() || m.file_attributes() & 0x400 != 0 // FILE_ATTRIBUTE_REPARSE_POINT
}

#[cfg(not(windows))]
fn is_link(m: &std::fs::Metadata) -> bool {
    m.file_type().is_symlink()
}

/// The pack's own folder as the one carve-out inside the protected folders, only while it is a real folder exactly where the host put it
/// (not a junction or symlink to somewhere else, and not under a parent that is one). Otherwise there is no carve-out at all.
fn own_folder(env: &Env) -> Option<PathBuf> {
    let meta = std::fs::symlink_metadata(&env.pack_data).ok()?;
    if !meta.is_dir() || is_link(&meta) {
        return None;
    }
    let real = resolve(&env.pack_data).ok()?;
    let parent = resolve(env.pack_data.parent()?).ok()?;
    (key(&real) == key(&parent.join(env.pack_data.file_name()?))).then_some(real)
}

/// Refuses a resolved path inside any protected folder (the host's data dir with the grants, consent and audit files, the app's own
/// folders), except inside the pack's own folder. Fail closed: no protected folder named, or one that cannot be resolved, refuses.
pub fn check_unprotected(real: &Path, env: &Env) -> Result<(), &'static str> {
    if env.protected.is_empty() {
        return Err("path_protected");
    }
    let own = own_folder(env);
    for p in &env.protected {
        let guarded = resolve(p).map_err(|_| "path_protected")?;
        if inside(real, &guarded) && !own.as_deref().is_some_and(|o| inside(real, o)) {
            return Err("path_protected");
        }
    }
    Ok(())
}

/// Does a grant name a folder or program INSIDE a protected folder? Such a grant is refused when it is set, shown or used. (A granted folder
/// that merely contains the data dir, such as the user's profile, is allowed: the broker refuses the protected part of it.)
pub fn grants_protected(grants: &Grants, protected: &[PathBuf]) -> bool {
    let guarded: Vec<PathBuf> = protected.iter().filter_map(|p| resolve(p).ok()).collect();
    if guarded.len() != protected.len() || guarded.is_empty() {
        return true;
    }
    let named = grants.workspace.iter().chain(grants.paths.iter()).chain(grants.programs.iter());
    named.into_iter().any(|g| match resolve(g) {
        Ok(real) => guarded.iter().any(|p| inside(&real, p)),
        Err(_) => false, // a grant that does not resolve is not a root at all (`roots` skips it)
    })
}

fn in_roots(path: &Path, words: &[String], grants: &Grants, env: &Env) -> Result<PathBuf, &'static str> {
    let real = resolve(path)?;
    check_unprotected(&real, env)?;
    if roots(words, grants, env).iter().any(|r| inside(&real, r)) {
        Ok(real)
    } else {
        Err("path_outside")
    }
}

fn exe_stem(p: &str) -> String {
    let file = p.rsplit(['\\', '/']).next().unwrap_or(p).to_lowercase();
    file.strip_suffix(".exe").unwrap_or(&file).to_string()
}

/// The file of a reviewed program: `%SystemRoot%\System32\<file>`, never a name looked up on PATH (R7d, gate R7c should-fix 2: a `ping.exe`
/// earlier on the user's PATH would otherwise be "reviewed"). The host's own SystemRoot is not something a pack can set.
fn system_program(file: &str) -> Option<PathBuf> {
    Some(PathBuf::from(std::env::var_os("SystemRoot")?).join("System32").join(file)).filter(|p| p.is_file())
}

/// The first absolute PATH entry that holds `file`. A relative or empty entry (which would mean the current folder) is skipped.
fn find_on_path(file: &str) -> Option<PathBuf> {
    std::env::split_paths(&std::env::var_os("PATH")?).filter(|d| d.is_absolute()).map(|d| d.join(file)).find(|p| p.is_file())
}

/// One request's origin check through the egress rule itself (steps 1-4: well formed, no userinfo, scheme, origin added), so the broker
/// gives the same refusal word the egress would, before it logs an allowed row. The list is the manifest ceiling narrowed to the grants.
fn origin_decision(manifest: &Manifest, grants: &Grants, url: &str) -> Result<Vec<String>, &'static str> {
    let scope = scope_of(manifest, "net.egress")?;
    let normal = |text: &str| {
        let mut e = zumi_egress::Egress::new(std::sync::Arc::new(|_| {}));
        e.add_user_origin(text).ok()?;
        e.origins().pop()
    };
    let granted: Vec<String> = grants.origins.iter().filter_map(|o| normal(o)).collect();
    let allowed: Vec<String> = match scope.get("origins") {
        // R7b (gate should-fix 2, roadmap 1.6): an origin the person adds for a PACK is never this PC (loopback); the egress guard already
        // refuses private and link-local addresses. Only a Zumia-reviewed manifest ceiling may name a loopback service.
        Some(Value::String(w)) if w == "user-added" => granted.into_iter().filter(|o| !zumi_egress::is_loopback_origin(o)).collect(),
        Some(Value::Array(ceiling)) => {
            let ceiling: Vec<String> = ceiling.iter().filter_map(|o| o.as_str().and_then(normal)).collect();
            granted.into_iter().filter(|g| ceiling.contains(g)).collect()
        }
        _ => Vec::new(),
    };
    if allowed.is_empty() {
        return Err("origin_not_allowed");
    }
    let mut e = zumi_egress::Egress::new(std::sync::Arc::new(|_| {}));
    for o in &allowed {
        let _ = e.add_user_origin(o);
    }
    e.check_url(url).map_err(|x| x.code())?;
    Ok(allowed)
}

/// Every argument that is not a switch is a path to check (R7d, gate R7c should-fix 1). A switch is `-x` or `/x` (no second separator).
/// A drive spelling anywhere in the text (`C:\x`, `--out=C:/x`, `-iC:\x`, and the drive-relative `D:x`, which Windows reads against the
/// current folder of drive D) is taken from the drive letter on. Anything else, a plain name, `sub\x`, `j\x` through a link, is read against
/// the folder the program starts in. A rooted `\x` has no drive and is refused by `resolve` (not absolute); so is a `..`.
fn arg_path(arg: &str, cwd: &Path) -> Option<PathBuf> {
    let b = arg.as_bytes();
    if let Some(i) = (0..b.len().saturating_sub(1)).find(|&i| b[i].is_ascii_alphabetic() && b[i + 1] == b':') {
        return Some(PathBuf::from(&arg[i..]));
    }
    let switch = arg.starts_with('-') || (arg.starts_with('/') && !arg[1..].contains(['\\', '/']));
    (!switch).then(|| if arg.starts_with(['\\', '/']) { PathBuf::from(arg) } else { cwd.join(arg) })
}

/// R7c: under `shell: false` every path an argument names must be inside the pack's roots (its own data, the cwd root, the roots of its
/// fs.read / fs.write), by the same check a brokered file access gets.
fn args_inside(manifest: &Manifest, grants: &Grants, env: &Env, cwd_word: Option<&str>, cwd: &Path, args: &[String]) -> Result<(), &'static str> {
    let mut words = vec!["pack-data".to_string()];
    words.extend(cwd_word.map(str::to_string));
    for cap in ["fs.read", "fs.write"] {
        if let Ok(scope) = scope_of(manifest, cap) {
            words.extend(strings(&scope["roots"]));
        }
    }
    for p in args.iter().filter_map(|a| arg_path(a, cwd)) {
        in_roots(&p, &words, grants, env).map_err(|_| "arg_outside")?;
    }
    Ok(())
}

fn spawn_decision(manifest: &Manifest, grants: &Grants, env: &Env, program: &str, cwd: Option<&Path>, args: &[String]) -> Result<Allowed, &'static str> {
    let scope = scope_of(manifest, "proc.spawn")?;
    let programs = strings(&scope["programs"]);
    let user_chosen = programs.iter().any(|p| p == "user-chosen");
    let shell_ok = scope["shell"].as_bool() == Some(true);
    let wanted = program.trim();
    if wanted.is_empty() {
        return Err("program_not_allowed");
    }
    let exe = if wanted.contains(['\\', '/', ':']) {
        // A path names one exact file the user chose. A name that merely matches a listed program does not make a path allowed.
        if !user_chosen {
            return Err("program_not_allowed");
        }
        let real = resolve(Path::new(wanted)).map_err(|_| "program_not_allowed")?;
        if !real.is_file() || !grants.programs.iter().filter_map(|g| resolve(g).ok()).any(|g| key(&g) == key(&real)) {
            return Err("program_not_allowed");
        }
        // Only an .exe: Windows starts a .cmd/.bat through cmd.exe (a shell nobody declared), and a .ps1/.com/.vbs is not a program.
        if !real.extension().is_some_and(|x| x.eq_ignore_ascii_case("exe")) {
            return Err("program_not_allowed");
        }
        real
    } else {
        let name = exe_stem(wanted);
        if !programs.iter().any(|p| p != "user-chosen" && exe_stem(p) == name) {
            return Err("program_not_allowed");
        }
        let file = format!("{name}.exe");
        let found = if REVIEWED.contains(&name.as_str()) { system_program(&file) } else { find_on_path(&file) }.ok_or("program_not_found")?;
        resolve(&found).map_err(|_| "program_not_found")?
    };
    check_unprotected(&exe, env).map_err(|_| "program_not_allowed")?;
    let stem = exe_stem(&exe.to_string_lossy());
    if !shell_ok {
        if SHELLS.contains(&stem.as_str()) {
            return Err("shell_not_declared");
        }
        // A program named in the manifest must be reviewed; one the person chose by exact path is her own choice.
        if !wanted.contains(['\\', '/', ':']) && !REVIEWED.contains(&stem.as_str()) {
            return Err("program_not_reviewed");
        }
    }
    let mut words = vec!["pack-data".to_string()];
    match scope["cwd"].as_str() {
        Some("workspace") => words.push("workspace".to_string()),
        Some("user-chosen") => words.push("user-chosen".to_string()),
        _ => {}
    }
    let dir = match cwd {
        Some(c) => in_roots(c, &words, grants, env).map_err(|_| "cwd_outside")?,
        None => match (scope["cwd"].as_str(), grants.workspace.as_deref()) {
            (Some("workspace"), Some(ws)) => in_roots(ws, &words, grants, env).map_err(|_| "cwd_outside")?,
            _ => resolve(&env.pack_data).map_err(|_| "cwd_outside")?,
        },
    };
    if !dir.is_dir() {
        return Err("cwd_outside");
    }
    if !shell_ok {
        args_inside(manifest, grants, env, scope["cwd"].as_str().filter(|w| *w == "workspace" || *w == "user-chosen"), &dir, args)?;
    }
    Ok(Allowed::Spawn { exe, cwd: dir })
}

fn listen_decision(manifest: &Manifest, grants: &Grants, bind: &str, port: u16) -> Result<Allowed, &'static str> {
    let scope = scope_of(manifest, "net.listen")?;
    let declared = scope["bind"].as_str().unwrap_or("");
    let lan = match (bind, declared) {
        ("loopback", "loopback" | "lan") => false,
        ("lan", "lan") => true,
        _ => return Err("listen_bind"),
    };
    if lan && !grants.lan {
        return Err("listen_lan_not_granted");
    }
    let ports: Vec<u64> = scope["ports"].as_array().map(|a| a.iter().filter_map(Value::as_u64).collect()).unwrap_or_default();
    if port == 0 || !ports.contains(&(port as u64)) {
        return Err("listen_port");
    }
    Ok(Allowed::Listen { lan })
}

/// Answers one action. `Err` is ONE fixed code word, never a path or a URL. A capability the manifest never declared is `no_capability`
/// whatever another capability's scope says.
pub fn decide(manifest: &Manifest, grants: &Grants, env: &Env, action: &Action) -> Result<Allowed, &'static str> {
    match action {
        Action::Spawn { program, cwd, args } => spawn_decision(manifest, grants, env, program, *cwd, args),
        Action::Read { path } | Action::Write { path } => {
            let scope = scope_of(manifest, action.capability())?;
            in_roots(path, &strings(&scope["roots"]), grants, env).map(Allowed::Path)
        }
        Action::Connect { url } => origin_decision(manifest, grants, url).map(Allowed::Origins),
        Action::Listen { bind, port } => listen_decision(manifest, grants, bind, *port),
    }
}
