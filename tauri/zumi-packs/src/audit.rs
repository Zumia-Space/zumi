//! The pack audit log (roadmap 1.8): `<data>/audit/<packId>/<date>.jsonl`, append-only, written by the host broker and never by the
//! helper, so a helper cannot forge or skip a line. Each line carries the sha256 of the line before it (`prev`).
//!
//! R7b M2 (gate R7): the chain alone has no key, so whoever can write the files can delete them all or re-chain them. The head is
//! therefore ANCHORED: `HEAD` holds the line count and the newest line's hash under an HMAC of the audit key, and the key is kept outside
//! every pack scope (`<audit>/KEY.dpapi`, sealed by Windows DPAPI to this Windows user; the data dir is a protected folder, M1). So:
//! - an edited, removed, inserted or re-chained line, a cut tail, an emptied log, a missing or rewritten HEAD all fail `verify`;
//! - a rollback of HEAD and lines together to an EARLIER valid state is caught ACROSS A RESTART too (R7c): every append also writes the
//!   head it made to an ANCHOR file in a sibling folder (`<audit>-anchor/<pack>.json`, MACed under the same key, outside every pack scope),
//!   and a HEAD that is older than the anchor, or whose line at the anchor's count is not the anchor's line, or a chain that is gone while
//!   the anchor says it had lines, fails. What stays open: whoever can write BOTH folders and unseal the key (any medium-integrity process
//!   of the same Windows user, such as the helper of an `input.inject` pack, which runs at the user's integrity) can rewrite the anchor as
//!   well. The programs a `proc.spawn` pack starts (Low) and a helper contained in an AppContainer cannot write either folder. There is no monotonic counter the user's own processes cannot also set.
//! - a missing key while chains exist is a failure, never a fresh key over old chains.
//! A crash between the line write and the HEAD write also reads as tampered (fail closed: the pack stops, removing it clears it).
//!
//! A write that fails is returned to the caller, which must then refuse to act: an action that cannot be logged does not happen.
//! Content (typed text, message bodies) is never stored here, only a digest of the arguments.
use serde_json::{json, Value};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use zumi_audit::hostmac::{mac_hex, sha256_hex, verify as mac_ok};

const ZERO: &str = "0000000000000000000000000000000000000000000000000000000000000000";
/// The MAC domain of a HEAD record: `[HEAD_DOMAIN, pack, count, hash]`.
const HEAD_DOMAIN: &str = "zumi-pack-audit-head/1";
/// The audit key, sealed to this Windows user. Upper case: never a pack id (`id_is_dirname`).
pub const KEY_FILE: &str = "KEY.dpapi";
const KEY_ENTROPY: &[u8] = b"zumi-pack-audit-key/1";

/// The MAC domain of an anchor record: `[ANCHOR_DOMAIN, pack, count, hash]`.
const ANCHOR_DOMAIN: &str = "zumi-pack-audit-anchor/1";

#[cfg(windows)]
fn dpapi(data: &[u8], seal: bool) -> Result<Vec<u8>, String> {
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB};
    let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
    let entropy = CRYPT_INTEGER_BLOB { cbData: KEY_ENTROPY.len() as u32, pbData: KEY_ENTROPY.as_ptr() as *mut u8 };
    let mut out = CRYPT_INTEGER_BLOB::default();
    // SAFETY: the input blobs point at live buffers of the stated lengths; DPAPI allocates `out`, which is copied and freed with LocalFree.
    unsafe {
        let r = if seal {
            CryptProtectData(&input, windows::core::PCWSTR::null(), Some(&entropy), None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out)
        } else {
            CryptUnprotectData(&input, None, Some(&entropy), None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out)
        };
        r.map_err(|e| format!("audit_key_dpapi: {e}"))?;
        let v = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(out.pbData as *mut _)));
        Ok(v)
    }
}

#[cfg(not(windows))]
fn dpapi(_: &[u8], _: bool) -> Result<Vec<u8>, String> {
    Err("audit_key_unsupported".to_string())
}

/// Does any pack chain exist under the audit folder (a HEAD or a dated file)? Then a missing key is a failure, never a fresh start.
fn any_chain(dir: &Path) -> bool {
    std::fs::read_dir(dir).map(|rd| rd.flatten().any(|e| e.path().is_dir() && std::fs::read_dir(e.path()).map(|f| f.flatten().any(|x| x.file_name() == "HEAD" || x.path().extension().is_some_and(|y| y == "jsonl"))).unwrap_or(true))).unwrap_or(false)
}

fn load_or_make_key(dir: &Path) -> Result<Vec<u8>, String> {
    let file = dir.join(KEY_FILE);
    let open = |sealed: &[u8]| dpapi(sealed, false).and_then(|k| if k.len() >= 32 { Ok(k) } else { Err("audit_key_short".to_string()) });
    match std::fs::read(&file) {
        Ok(sealed) => return open(&sealed),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("audit_key: {e}")),
    }
    if any_chain(dir) {
        return Err("audit_key_missing: chains exist without the key that signed them".to_string());
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("audit_dir: {e}"))?;
    let key = zumi_audit::hostmac::new_key()?;
    let sealed = dpapi(&key, true)?;
    match std::fs::OpenOptions::new().write(true).create_new(true).open(&file) {
        Ok(mut f) => {
            f.write_all(&sealed).and_then(|_| f.sync_all()).map_err(|e| format!("audit_key: {e}"))?;
            Ok(key)
        }
        // Another reader of the same folder made it first: use that one.
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => open(&std::fs::read(&file).map_err(|e| format!("audit_key: {e}"))?),
        Err(e) => Err(format!("audit_key: {e}")),
    }
}

/// One decision or event. `decision` is `allowed`, `refused-scope`, `refused-user` or `n/a` (an event such as install or kill).
pub struct Row<'a> {
    pub pack: &'a str,
    pub version: &'a str,
    pub event: &'a str,
    pub capability: Option<&'a str>,
    pub target: Option<&'a str>,
    pub arg_digest: Option<String>,
    pub decision: &'a str,
    pub code: Option<&'a str>,
    pub detail: &'a str,
}

impl<'a> Row<'a> {
    /// An event with no capability (install, consent, enable, kill, uninstall).
    pub fn event(pack: &'a str, version: &'a str, event: &'a str, decision: &'a str, code: Option<&'a str>, detail: &'a str) -> Row<'a> {
        Row { pack, version, event, capability: None, target: None, arg_digest: None, decision, code, detail }
    }
}

pub struct PackAudit {
    dir: PathBuf,
    write: Mutex<()>,
    /// Loaded (or made, for an audit folder with no chain yet) on first use. A failure stays: nothing is written or verified without it.
    key: OnceLock<Result<Vec<u8>, String>>,
}

/// `YYYY-MM-DD` in UTC from unix milliseconds (civil-from-days, no time crate).
pub fn utc_date(unix_ms: u128) -> String {
    let days = (unix_ms / 86_400_000) as i64;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    format!("{:04}-{:02}-{:02}", if m <= 2 { y + 1 } else { y }, m, d)
}

/// A pack id is a directory name here: `<kind>.<name>` of lowercase letters, digits, `-` and one `.`. Anything else is not written.
pub fn id_is_dirname(id: &str) -> bool {
    !id.is_empty() && id.len() <= 80 && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'.') && !id.starts_with('.') && !id.contains("..")
}

impl PackAudit {
    pub fn new(audit_dir: &Path) -> PackAudit {
        PackAudit { dir: audit_dir.to_path_buf(), write: Mutex::new(()), key: OnceLock::new() }
    }

    fn key(&self) -> Result<&[u8], String> {
        self.key.get_or_init(|| load_or_make_key(&self.dir)).as_deref().map_err(Clone::clone)
    }

    /// The signed head `(count, newest line hash)`, or None when there is no HEAD file. A HEAD that does not verify is an error.
    fn read_head(&self, pack: &str, key: &[u8]) -> Result<Option<(u64, String)>, String> {
        let text = match std::fs::read_to_string(self.pack_dir(pack).join("HEAD")) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(format!("audit_head: {e}")),
        };
        let v: Value = serde_json::from_str(text.trim()).map_err(|_| "audit_head_forged: HEAD is not a signed head".to_string())?;
        let (Some(n), Some(hash), Some(mac)) = (v["n"].as_u64(), v["hash"].as_str(), v["mac"].as_str()) else {
            return Err("audit_head_forged: HEAD is not a signed head".to_string());
        };
        if hash.len() != 64 || !mac_ok(key, &[HEAD_DOMAIN, pack, &n.to_string(), hash], mac) {
            return Err("audit_head_forged: HEAD is not signed by this audit key".to_string());
        }
        Ok(Some((n, hash.to_string())))
    }

    /// `<audit>-anchor`: next to the audit folder, never inside it (a copy-back of the audit folder must not carry the anchor with it).
    fn anchor_dir(&self) -> PathBuf {
        let mut name = self.dir.file_name().map(|n| n.to_os_string()).unwrap_or_default();
        name.push("-anchor");
        self.dir.with_file_name(name)
    }

    /// The newest head this host wrote for the pack, from the anchor file: `Ok(None)` when there is none.
    fn read_anchor(&self, pack: &str, key: &[u8]) -> Result<Option<(u64, String)>, String> {
        let text = match std::fs::read_to_string(self.anchor_dir().join(format!("{pack}.json"))) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(format!("audit_anchor: {e}")),
        };
        let v: Value = serde_json::from_str(text.trim()).map_err(|_| "audit_anchor_forged: the anchor is not a signed record".to_string())?;
        let (Some(n), Some(hash), Some(mac)) = (v["n"].as_u64(), v["hash"].as_str(), v["mac"].as_str()) else {
            return Err("audit_anchor_forged: the anchor is not a signed record".to_string());
        };
        if hash.len() != 64 || !mac_ok(key, &[ANCHOR_DOMAIN, pack, &n.to_string(), hash], mac) {
            return Err("audit_anchor_forged: the anchor is not signed by this audit key".to_string());
        }
        Ok(Some((n, hash.to_string())))
    }

    /// Replaces the anchor whole (write aside, flush, rename over).
    fn write_anchor(&self, pack: &str, key: &[u8], n: u64, hash: &str) -> Result<(), String> {
        let dir = self.anchor_dir();
        std::fs::create_dir_all(&dir).map_err(|e| format!("audit_anchor: {e}"))?;
        let text = json!({ "n": n, "hash": hash, "mac": mac_hex(key, &[ANCHOR_DOMAIN, pack, &n.to_string(), hash]) }).to_string();
        let (tmp, file) = (dir.join(format!("{pack}.tmp")), dir.join(format!("{pack}.json")));
        let mut f = std::fs::File::create(&tmp).map_err(|e| format!("audit_anchor: {e}"))?;
        f.write_all(text.as_bytes()).and_then(|_| f.sync_all()).map_err(|e| format!("audit_anchor: {e}"))?;
        drop(f);
        std::fs::rename(&tmp, &file).map_err(|e| format!("audit_anchor: {e}"))
    }

    /// The chain on disk (`head` with the hash of every line) against the anchor. A head AHEAD of the anchor is fine (a crash between the
    /// HEAD write and the anchor write); an older one, a different line at the anchor's count, a chain that is gone or an anchor that is
    /// gone while a chain exists all fail.
    fn check_anchor(&self, pack: &str, key: &[u8], head: Option<&(u64, String)>, hashes: &[String]) -> Result<(), String> {
        match (self.read_anchor(pack, key)?, head) {
            (None, None) | (Some((0, _)), None) => Ok(()),
            (Some(_), None) => Err("audit_removed: the chain went away since this host last wrote it".to_string()),
            (None, Some(_)) => Err("audit_anchor_missing: a chain with no anchor".to_string()),
            (Some((n, hash)), Some(h)) if h.0 < n => Err(format!("audit_rolled_back: HEAD went from {n} lines to {} (last hash {})", h.0, &hash[..8])),
            (Some((n, hash)), Some(h)) if n > 0 && hashes.get(n as usize - 1) != Some(&hash) => Err(format!("audit_rolled_back: line {n} is not the line this host last wrote ({} lines now)", h.0)),
            _ => Ok(()),
        }
    }

    /// The pack's chain was removed on purpose (uninstall): the anchor goes too, so the pack id may start a new chain.
    pub fn forget(&self, pack: &str) -> Result<(), String> {
        match std::fs::remove_file(self.anchor_dir().join(format!("{pack}.json"))) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("audit_anchor: {e}")),
        }
        let _ = std::fs::remove_dir(self.anchor_dir()); // the last pack's anchor was the folder's only content
        Ok(())
    }

    /// An export of the pack's chain to `other` (an audit folder of its own) carries the anchor too, so it verifies there.
    pub fn copy_anchor_to(&self, pack: &str, other: &Path) -> Result<(), String> {
        let from = self.anchor_dir().join(format!("{pack}.json"));
        if !from.exists() {
            return Ok(());
        }
        let to = PackAudit::new(other).anchor_dir();
        std::fs::create_dir_all(&to).and_then(|_| std::fs::copy(&from, to.join(format!("{pack}.json"))).map(|_| ())).map_err(|e| format!("audit_anchor: {e}"))
    }

    /// Does the pack have any chain on disk (a HEAD or a dated file)?
    pub fn exists(&self, pack: &str) -> bool {
        let dir = self.pack_dir(pack);
        dir.join("HEAD").exists() || self.lines(pack).map(|l| !l.is_empty()).unwrap_or(true)
    }

    pub fn pack_dir(&self, pack: &str) -> PathBuf {
        self.dir.join(pack)
    }

    /// Appends one line, flushes it, moves the signed HEAD and the anchor. Returns the line's hash. Nothing is written onto a HEAD that does
    /// not verify, that is older than the anchor, or onto lines that have no HEAD.
    pub fn append(&self, row: &Row) -> Result<String, String> {
        if !id_is_dirname(row.pack) {
            return Err("audit_bad_pack_id".to_string());
        }
        let key = self.key()?;
        let _guard = self.write.lock().unwrap_or_else(|p| p.into_inner());
        let dir = self.pack_dir(row.pack);
        let (n, prev) = match self.read_head(row.pack, key)? {
            Some(head) => {
                let hashes: Vec<String> = self.lines(row.pack)?.iter().map(|(_, l)| sha256_hex(l.as_bytes())).collect();
                self.check_anchor(row.pack, key, Some(&head), &hashes)?;
                // The newest line on disk must be the one HEAD names (an emptied or cut log is not written onto).
                if hashes.last() != Some(&head.1) {
                    return Err("audit_head_mismatch: the newest line is not the one HEAD names".to_string());
                }
                head
            }
            None => {
                if !self.lines(row.pack)?.is_empty() {
                    return Err("audit_head_missing: lines without a HEAD".to_string());
                }
                self.check_anchor(row.pack, key, None, &[])?;
                // A new chain gets its anchor (count 0) BEFORE its first line, so a chain without an anchor is never a normal state.
                if self.read_anchor(row.pack, key)?.is_none() {
                    self.write_anchor(row.pack, key, 0, ZERO)?;
                }
                (0, ZERO.to_string())
            }
        };
        std::fs::create_dir_all(&dir).map_err(|e| format!("audit_dir: {e}"))?;
        let head_file = dir.join("HEAD");
        let now = zumi_audit::unix_ms();
        let line = json!({
            "t_unix_ms": now as u64, "pack": row.pack, "version": row.version, "event": row.event, "capability": row.capability,
            "target": row.target, "arg_digest": row.arg_digest, "decision": row.decision, "code": row.code, "detail": row.detail, "prev": prev,
        })
        .to_string();
        let file = dir.join(format!("{}.jsonl", utc_date(now)));
        let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&file).map_err(|e| format!("audit_open: {e}"))?;
        writeln!(f, "{line}").and_then(|_| f.flush()).and_then(|_| f.sync_data()).map_err(|e| format!("audit_write: {e}"))?;
        let hash = sha256_hex(line.as_bytes());
        let n = n + 1;
        let head = json!({ "n": n, "hash": hash, "mac": mac_hex(key, &[HEAD_DOMAIN, row.pack, &n.to_string(), &hash]) }).to_string();
        // Replaced whole (write aside, then rename over), so a HEAD is never half written.
        let tmp = dir.join("HEAD.tmp");
        std::fs::write(&tmp, &head).and_then(|_| std::fs::rename(&tmp, &head_file)).map_err(|e| format!("audit_head: {e}"))?;
        // The line and HEAD are written; an anchor that cannot be written is an error too (the caller must not act on an unanchored line).
        self.write_anchor(row.pack, key, n, &hash)?;
        Ok(hash)
    }

    /// The rows of a pack, oldest first (every dated file in name order).
    pub fn rows(&self, pack: &str) -> Result<Vec<Value>, String> {
        let mut out = Vec::new();
        for (_, text) in self.lines(pack)? {
            out.push(serde_json::from_str(&text).map_err(|_| "audit_line_not_json".to_string())?);
        }
        Ok(out)
    }

    fn lines(&self, pack: &str) -> Result<Vec<(String, String)>, String> {
        if !id_is_dirname(pack) {
            return Err("audit_bad_pack_id".to_string());
        }
        let dir = self.pack_dir(pack);
        let mut names: Vec<String> = match std::fs::read_dir(&dir) {
            Ok(rd) => rd.flatten().filter_map(|e| e.file_name().into_string().ok()).filter(|n| n.ends_with(".jsonl")).collect(),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(format!("audit_dir: {e}")),
        };
        names.sort();
        let mut out = Vec::new();
        for n in names {
            let text = std::fs::read_to_string(dir.join(&n)).map_err(|e| format!("audit_read: {e}"))?;
            out.extend(text.lines().filter(|l| !l.is_empty()).map(|l| (n.clone(), l.to_string())));
        }
        Ok(out)
    }

    /// Checks the chain: every line's `prev` is the hash of the line before it, and the signed HEAD names exactly this many lines and the
    /// last one's hash, and the chain is not older than the anchor. Returns the row count; `Ok(0)` only for no chain at all.
    pub fn verify(&self, pack: &str) -> Result<usize, String> {
        let key = self.key()?;
        let lines = self.lines(pack)?;
        let mut prev = ZERO.to_string();
        for (i, (_, text)) in lines.iter().enumerate() {
            let v: Value = serde_json::from_str(text).map_err(|_| format!("line {i} is not JSON"))?;
            if v["prev"].as_str() != Some(prev.as_str()) {
                return Err(format!("line {i} does not follow the line before it"));
            }
            prev = sha256_hex(text.as_bytes());
        }
        let head = match self.read_head(pack, key)? {
            Some(h) => h,
            None if lines.is_empty() => {
                self.check_anchor(pack, key, None, &[])?;
                return Ok(0);
            }
            None => return Err("audit_head_missing: lines without a HEAD".to_string()),
        };
        if head.0 != lines.len() as u64 {
            return Err(format!("audit_count: HEAD names {} lines, {} are there", head.0, lines.len()));
        }
        if head.1 != prev {
            return Err("audit_head_mismatch: the newest line is not the one HEAD names".to_string());
        }
        let hashes: Vec<String> = lines.iter().map(|(_, l)| sha256_hex(l.as_bytes())).collect();
        self.check_anchor(pack, key, Some(&head), &hashes)?;
        Ok(lines.len())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("zumi-packs-audit-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let _ = std::fs::remove_dir_all(PackAudit::new(&d).anchor_dir());
        d
    }

    #[test]
    fn dates_are_utc_civil_dates() {
        assert_eq!(utc_date(0), "1970-01-01");
        assert_eq!(utc_date(951_782_400_000), "2000-02-29");
        assert_eq!(utc_date(1_795_000_000_000), "2026-11-18");
    }

    #[test]
    fn lines_chain_and_an_edit_a_removal_and_a_truncated_tail_all_show() {
        let d = dir("chain");
        let a = PackAudit::new(&d);
        for i in 0..4 {
            a.append(&Row::event("power.canary", "1.0.0", "install", "n/a", None, &format!("row {i}"))).unwrap();
        }
        assert_eq!(a.verify("power.canary"), Ok(4));
        let file = std::fs::read_dir(d.join("power.canary")).unwrap().flatten().map(|e| e.path()).find(|p| p.extension().is_some_and(|x| x == "jsonl")).unwrap();
        let original = std::fs::read_to_string(&file).unwrap();
        // an edited middle line
        std::fs::write(&file, original.replace("row 1", "row X")).unwrap();
        assert!(a.verify("power.canary").is_err(), "an edited line");
        // a removed middle line
        let kept: Vec<&str> = original.lines().enumerate().filter(|(i, _)| *i != 1).map(|(_, l)| l).collect();
        std::fs::write(&file, kept.join("\n") + "\n").unwrap();
        assert!(a.verify("power.canary").is_err(), "a removed line");
        // a cut-off tail
        let head: Vec<&str> = original.lines().take(3).collect();
        std::fs::write(&file, head.join("\n") + "\n").unwrap();
        assert!(a.verify("power.canary").is_err(), "a removed last line");
        std::fs::write(&file, &original).unwrap();
        assert_eq!(a.verify("power.canary"), Ok(4), "the untouched file verifies again");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn the_anchor_is_signed_a_head_ahead_of_it_is_a_crash_gap_and_a_missing_one_fails() {
        let d = dir("anchor");
        let a = PackAudit::new(&d);
        let add = |i: usize| a.append(&Row::event("power.canary", "1.0.0", "install", "n/a", None, &format!("row {i}")));
        for i in 0..3 {
            add(i).unwrap();
        }
        let file = a.anchor_dir().join("power.canary.json");
        let at3 = std::fs::read_to_string(&file).unwrap();
        // A crash between the HEAD write and the anchor write: HEAD one ahead of the anchor is not a rollback, and the next append catches up.
        add(3).unwrap();
        std::fs::write(&file, &at3).unwrap();
        assert_eq!(a.verify("power.canary"), Ok(4));
        add(4).unwrap();
        assert_eq!(PackAudit::new(&d).verify("power.canary"), Ok(5));
        // An anchor edited to a lower count does not carry the MAC of that count.
        std::fs::write(&file, at3.replace("\"n\":3", "\"n\":1")).unwrap();
        assert!(a.verify("power.canary").unwrap_err().starts_with("audit_anchor_forged"));
        // No anchor while a chain exists is a failure, never a fresh start.
        std::fs::remove_file(&file).unwrap();
        assert!(a.verify("power.canary").unwrap_err().starts_with("audit_anchor_missing"));
        assert!(add(5).unwrap_err().starts_with("audit_anchor_missing"));
        let _ = std::fs::remove_dir_all(&d);
        let _ = std::fs::remove_dir_all(a.anchor_dir());
    }

    #[test]
    fn a_pack_id_that_is_a_path_is_never_written() {
        let d = dir("badid");
        let a = PackAudit::new(&d);
        for bad in ["", "..", "../x", "a/b", "a\\b", "C:x", ".hidden", "UPPER"] {
            assert!(a.append(&Row::event(bad, "1.0.0", "install", "n/a", None, "")).is_err(), "{bad:?}");
        }
        assert!(!d.exists() || std::fs::read_dir(&d).unwrap().next().is_none());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_write_that_cannot_happen_is_an_error_not_a_silent_skip() {
        let d = dir("blocked");
        std::fs::create_dir_all(&d).unwrap();
        // a FILE where the audit directory must go
        std::fs::write(d.join("power.canary"), "x").unwrap();
        assert!(PackAudit::new(&d).append(&Row::event("power.canary", "1.0.0", "install", "n/a", None, "")).is_err());
        let _ = std::fs::remove_dir_all(&d);
    }
}
