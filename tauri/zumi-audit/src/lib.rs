//! zumi-audit: the hands audit log. One JSON line per decision the hands make: every acting verb, allowed or refused,
//! with the refusal code. Append-only; a write failure is returned to the caller, which must then refuse to act
//! (an action that cannot be logged does not happen).
pub mod hostmac;
pub mod inherit;
pub mod keepawake;
use serde_json::{json, Value};
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub struct Audit {
    path: PathBuf,
    file: Mutex<File>,
}

/// One decision. `code` is the refusal word (None when allowed).
pub struct Entry<'a> {
    pub verb: &'a str,
    pub pid: Option<u32>,
    pub exe: Option<&'a str>,
    pub hwnd: Option<u64>,
    pub code: Option<&'a str>,
    pub detail: &'a str,
}

pub fn unix_ms() -> u128 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

impl Audit {
    pub fn open(path: &Path) -> std::io::Result<Audit> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let file = OpenOptions::new().create(true).append(true).open(path)?;
        Ok(Audit { path: path.to_path_buf(), file: Mutex::new(file) })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Appends one line and flushes it. Returns the line written.
    pub fn record(&self, e: &Entry) -> std::io::Result<Value> {
        let line = json!({
            "t_unix_ms": unix_ms() as u64,
            "verb": e.verb,
            "decision": if e.code.is_some() { "refused" } else { "allowed" },
            "code": e.code,
            "pid": e.pid,
            "exe": e.exe,
            "hwnd": e.hwnd.map(|h| format!("0x{h:X}")),
            "detail": e.detail,
        });
        let mut f = self.file.lock().unwrap_or_else(|p| p.into_inner());
        writeln!(f, "{line}")?;
        f.flush()?;
        Ok(line)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("zumi-audit-test-{}-{name}", std::process::id()));
        let _ = std::fs::remove_file(&d);
        d
    }

    #[test]
    fn one_line_per_decision_allowed_and_refused() {
        let p = tmp("lines.jsonl");
        let a = Audit::open(&p).unwrap();
        a.record(&Entry { verb: "type", pid: Some(7), exe: Some("notepad.exe"), hwnd: Some(0x10), code: None, detail: "8 chars" }).unwrap();
        a.record(&Entry { verb: "type", pid: Some(7), exe: None, hwnd: None, code: Some("password_field"), detail: "refused" }).unwrap();
        let text = std::fs::read_to_string(&p).unwrap();
        let lines: Vec<Value> = text.lines().map(|l| serde_json::from_str(l).unwrap()).collect();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0]["decision"], "allowed");
        assert_eq!(lines[0]["pid"], 7);
        assert_eq!(lines[1]["decision"], "refused");
        assert_eq!(lines[1]["code"], "password_field");
        assert!(lines[1]["t_unix_ms"].as_u64().unwrap() >= lines[0]["t_unix_ms"].as_u64().unwrap());
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn appends_across_reopen() {
        let p = tmp("append.jsonl");
        Audit::open(&p).unwrap().record(&Entry { verb: "arm", pid: None, exe: None, hwnd: None, code: None, detail: "" }).unwrap();
        Audit::open(&p).unwrap().record(&Entry { verb: "disarm", pid: None, exe: None, hwnd: None, code: None, detail: "" }).unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap().lines().count(), 2);
        let _ = std::fs::remove_file(&p);
    }
}
