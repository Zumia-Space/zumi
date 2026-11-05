// T-31 parity fix: paths handed to the Node sidecar.
//
// Tauri's `resource_dir()` is built from `std::env::current_exe().canonicalize()`, which on Windows returns a
// VERBATIM path (`\\?\D:\...`). Rust and Win32 accept that form, but Node 24 does not: given `\\?\D:\...\main.mjs`
// as argv[1] it resolves the drive root, lstat()s `D:` and dies with EISDIR before the sidecar starts.
//
// So every path the host passes to Node goes through `node_path()` first. It strips the verbatim prefix the way
// `dunce::simplified` does, but inline (no new dependency):
//   `\\?\C:\x`              -> `C:\x`
//   `\\?\UNC\server\share`  -> `\\server\share`
// A device path (`\\?\Volume{...}`, `\\.\...`) has no plain spelling; it is returned unchanged, so the spawn fails
// loudly instead of being rewritten to a different path. Non-Windows paths are already plain.

#[cfg(windows)]
use std::path::{Path, PathBuf};

/// The path to hand to Node: the same path without a Windows verbatim prefix.
#[cfg(windows)]
pub(crate) fn node_path(path: &Path) -> PathBuf {
    simplify_verbatim(path).unwrap_or_else(|| path.to_path_buf())
}

/// Non-Windows has no verbatim prefix.
#[cfg(not(windows))]
pub(crate) fn node_path(path: &std::path::Path) -> std::path::PathBuf {
    path.to_path_buf()
}

/// Strip `\\?\` from a verbatim drive or UNC path. `None` means the path uses a device prefix that has no plain
/// filesystem spelling (the caller keeps the original and lets the spawn fail).
#[cfg(windows)]
fn simplify_verbatim(path: &Path) -> Option<PathBuf> {
    use std::path::{Component, Prefix};

    let mut components = path.components();
    let prefix = match components.next()? {
        Component::Prefix(prefix) => prefix.kind(),
        _ => return Some(path.to_path_buf()),
    };
    let tail: Vec<Component> = components.filter(|c| !matches!(c, Component::RootDir)).collect();
    let mut out = match prefix {
        Prefix::VerbatimDisk(letter) => PathBuf::from(format!("{}:\\", letter as char)),
        Prefix::VerbatimUNC(server, share) => {
            let mut out = PathBuf::from("\\\\");
            out.push(server);
            out.push(share);
            out
        }
        // Plain paths are already usable; device namespaces are not, and are left alone.
        Prefix::Disk(_) | Prefix::UNC(_, _) => return Some(path.to_path_buf()),
        _ => return None,
    };
    for component in tail {
        out.push(component.as_os_str());
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    fn shown(path: &std::path::Path) -> String {
        path.to_string_lossy().replace('/', "\\")
    }

    #[test]
    #[cfg(windows)]
    fn a_verbatim_drive_path_becomes_a_usable_plain_path() {
        let got = node_path(std::path::Path::new(r"\\?\C:\x\node.exe"));
        assert_eq!(shown(&got), r"C:\x\node.exe");
        assert!(!shown(&got).starts_with(r"\\?\"), "the verbatim prefix must be gone");
    }

    #[test]
    #[cfg(windows)]
    fn a_verbatim_unc_path_becomes_a_plain_unc_path() {
        let got = node_path(std::path::Path::new(r"\\?\UNC\server\share\sidecar\main.mjs"));
        assert_eq!(shown(&got), r"\\server\share\sidecar\main.mjs");
    }

    #[test]
    #[cfg(windows)]
    fn a_device_path_is_refused_explicitly_not_rewritten() {
        let raw = std::path::Path::new(r"\\?\Volume{01234567-89ab-cdef-0123-456789abcdef}\x");
        assert_eq!(node_path(raw), raw, "a device path has no plain spelling: keep it, fail the spawn loudly");
        assert_eq!(node_path(std::path::Path::new(r"\\.\pipe\zumi")), std::path::Path::new(r"\\.\pipe\zumi"));
    }

    #[test]
    #[cfg(windows)]
    fn a_plain_path_is_unchanged() {
        let raw = std::path::Path::new(r"C:\work\zumi\tauri\sidecar\main.mjs");
        assert_eq!(node_path(raw), raw);
    }

    #[test]
    #[cfg(not(windows))]
    fn a_unix_path_is_unchanged() {
        let raw = std::path::Path::new("/opt/zumi/tauri/sidecar/main.mjs");
        assert_eq!(node_path(raw), raw);
    }
}
