//! The host's pack manager: install from a pinned catalog entry, accept through the native consent window, enable (open the broker's door),
//! disable. Called by the host only (a Tauri command of the main webview); no rpc method, tool, sidecar call or helper request reaches it.
//!
//! States: not installed -> installed (files on disk, cannot run) -> accepted (a signed consent record for exactly what the manifest
//! declares now) -> enabled (the broker has a door for it). `accepted` is not stored: it is the consent record, checked again at every
//! enable, so a changed pack or a different run of the app is simply "installed" again.
//!
//! Files: `<data>/packs/<id>/` the pack as shipped; `<data>/packs-state/<id>/` consent, grants and the pack's own `data/` folder (the
//! only place a scope can name inside it is `data/`); `<data>/audit/<id>/` the audit chain.
use crate::audit::{PackAudit, Row};
use crate::broker::Broker;
use crate::consent::{request_consent, verify_consent, Binding, ConsentDialog};
use crate::manifest::{Kind, Manifest, MANIFEST_FILE};
use crate::scope::{Env, Grants};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use zumi_audit::hostmac::sha256_hex;

/// A pack the app ships or the Zumia catalog lists: its id, version and the sha256 of its `zumi-pack.json` (which pins every other file
/// by hash). An id or hash that is not here cannot be installed, enabled or accepted: "withdrawn" is simply a missing entry.
#[derive(Debug, Clone, PartialEq)]
pub struct CatalogEntry {
    pub id: String,
    pub version: String,
    pub manifest_sha256: String,
}

#[derive(Debug, Clone, Default)]
pub struct Catalog(pub Vec<CatalogEntry>);

impl Catalog {
    /// The catalog compiled into this build. No power pack ships yet, so it is empty: nothing can be installed (fail closed).
    pub fn compiled() -> Catalog {
        Catalog(Vec::new())
    }

    fn pins(&self, id: &str, version: &str, sha: &str) -> bool {
        self.0.iter().any(|e| e.id == id && e.version == version && e.manifest_sha256 == sha)
    }
}

const SKILL_FILE: &str = "SKILL.md";
/// A marker in a skill pack's state folder: the skill is off.
const SKILL_OFF: &str = "skill-off";

pub struct Packs {
    data: PathBuf,
    /// Folders no pack scope ever reaches: the data dir itself, plus the app's own folders the host names (`protect`).
    protected: Vec<PathBuf>,
    key: Vec<u8>,
    sid: String,
    catalog: Catalog,
    audit: Arc<PackAudit>,
    broker: Arc<Broker>,
}

/// Every file under `dir` as relative `/` paths. A link (symlink or junction) anywhere is refused: a pack is plain files.
fn tree(dir: &Path, prefix: &str, out: &mut Vec<String>) -> Result<(), String> {
    for e in std::fs::read_dir(dir).map_err(|e| format!("pack_unreadable: {e}"))?.flatten() {
        let meta = std::fs::symlink_metadata(e.path()).map_err(|e| format!("pack_unreadable: {e}"))?;
        let name = e.file_name().to_string_lossy().into_owned();
        let rel = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
        if meta.file_type().is_symlink() || is_reparse(&meta) {
            return Err("pack_link".to_string());
        }
        if meta.is_dir() {
            tree(&e.path(), &rel, out)?;
        } else if meta.is_file() {
            out.push(rel);
        } else {
            return Err("pack_file_kind".to_string());
        }
    }
    Ok(())
}

#[cfg(windows)]
fn is_reparse(m: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    m.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
fn is_reparse(_: &std::fs::Metadata) -> bool {
    false
}

/// Reads and checks a pack folder against its manifest: every listed file is there with its size and sha256, nothing else is.
fn check_dir(dir: &Path) -> Result<(Manifest, String), String> {
    let bytes = std::fs::read(dir.join(MANIFEST_FILE)).map_err(|_| "manifest_missing".to_string())?;
    if bytes.len() > 64 * 1024 {
        return Err("manifest_json".to_string());
    }
    let manifest = Manifest::parse(std::str::from_utf8(&bytes).map_err(|_| "manifest_json")?).map_err(str::to_string)?;
    let mut found = Vec::new();
    tree(dir, "", &mut found)?;
    found.retain(|f| f != MANIFEST_FILE);
    for f in &found {
        if !manifest.files.iter().any(|m| &m.path == f) {
            return Err("files_unlisted".to_string());
        }
    }
    for f in &manifest.files {
        let data = std::fs::read(dir.join(&f.path)).map_err(|_| "files_absent".to_string())?;
        if data.len() as u64 != f.bytes {
            return Err("files_bytes".to_string());
        }
        if sha256_hex(&data) != f.sha256 {
            return Err("files_sha".to_string());
        }
    }
    Ok((manifest, sha256_hex(&bytes)))
}

fn copy_tree(from: &Path, to: &Path) -> Result<(), String> {
    std::fs::create_dir_all(to).map_err(|e| format!("copy: {e}"))?;
    for e in std::fs::read_dir(from).map_err(|e| format!("copy: {e}"))?.flatten() {
        let (src, dst) = (e.path(), to.join(e.file_name()));
        if e.file_type().map_err(|e| format!("copy: {e}"))?.is_dir() {
            copy_tree(&src, &dst)?;
        } else {
            std::fs::copy(&src, &dst).map_err(|e| format!("copy: {e}"))?;
        }
    }
    Ok(())
}

/// Deletes a file or folder. A link (symlink, junction, any reparse point) is unlinked and never entered, so what it points at is
/// untouched. A read-only file is made writable first.
fn remove_tree(path: &Path) -> Result<(), String> {
    let meta = match std::fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("remove: {e}")),
    };
    let err = |e: std::io::Error| format!("remove {}: {e}", path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default());
    if meta.file_type().is_symlink() || is_reparse(&meta) {
        return if is_dir_attr(&meta) { std::fs::remove_dir(path) } else { std::fs::remove_file(path) }.map_err(err);
    }
    if meta.is_dir() {
        for e in std::fs::read_dir(path).map_err(err)?.flatten() {
            remove_tree(&e.path())?;
        }
        return std::fs::remove_dir(path).map_err(err);
    }
    if std::fs::remove_file(path).is_err() {
        let mut perm = meta.permissions();
        perm.set_readonly(false);
        let _ = std::fs::set_permissions(path, perm);
        std::fs::remove_file(path).map_err(err)?;
    }
    Ok(())
}

#[cfg(windows)]
fn is_dir_attr(m: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    m.file_attributes() & 0x10 != 0
}

#[cfg(not(windows))]
fn is_dir_attr(m: &std::fs::Metadata) -> bool {
    m.is_dir()
}

fn grants_from_json(v: &Value) -> Grants {
    let list = |k: &str| -> Vec<String> { v.get(k).and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default() };
    Grants {
        workspace: v.get("workspace").and_then(Value::as_str).map(PathBuf::from),
        paths: list("paths").into_iter().map(PathBuf::from).collect(),
        origins: list("origins"),
        programs: list("programs").into_iter().map(PathBuf::from).collect(),
        lan: v.get("lan").and_then(Value::as_bool).unwrap_or(false),
    }
}

pub fn grants_to_json(g: &Grants) -> Value {
    json!({
        "workspace": g.workspace.as_ref().map(|p| p.to_string_lossy().into_owned()),
        "paths": g.paths.iter().map(|p| p.to_string_lossy().into_owned()).collect::<Vec<_>>(),
        "origins": g.origins, "programs": g.programs.iter().map(|p| p.to_string_lossy().into_owned()).collect::<Vec<_>>(), "lan": g.lan,
    })
}

impl Packs {
    pub fn new(data_dir: &Path, key: &[u8], catalog: Catalog) -> Result<Packs, String> {
        Packs::with_sid(data_dir, key, catalog, crate::consent::current_user_sid()?)
    }

    /// As `new`, with the user's SID given (tests, and a host that already has it).
    pub fn with_sid(data_dir: &Path, key: &[u8], catalog: Catalog, sid: String) -> Result<Packs, String> {
        if key.len() < 16 {
            return Err("host_key_missing".to_string());
        }
        let audit = Arc::new(PackAudit::new(&data_dir.join("audit")));
        let broker = Arc::new(Broker::new(audit.clone()));
        Ok(Packs { data: data_dir.to_path_buf(), protected: vec![data_dir.to_path_buf()], key: key.to_vec(), sid, catalog, audit, broker })
    }

    /// Adds a folder of the app's own (install folder, local data, config) that no pack scope may reach. Call before any enable.
    pub fn protect(&mut self, dir: &Path) {
        self.protected.push(dir.to_path_buf());
    }

    /// The grants of a pack, refused when one names a folder or program inside a protected folder.
    fn usable_grants(&self, id: &str) -> Result<Grants, String> {
        let grants = self.grants(id)?;
        if crate::scope::grants_protected(&grants, &self.protected) {
            return Err("grant_protected".to_string());
        }
        Ok(grants)
    }

    pub fn audit(&self) -> &Arc<PackAudit> {
        &self.audit
    }

    pub fn broker(&self) -> &Arc<Broker> {
        &self.broker
    }

    pub fn pack_dir(&self, id: &str) -> PathBuf {
        self.data.join("packs").join(id)
    }

    pub fn state_dir(&self, id: &str) -> PathBuf {
        self.data.join("packs-state").join(id)
    }

    fn note(&self, id: &str, version: &str, event: &str, decision: &str, code: Option<&str>, detail: &str) -> Result<(), String> {
        self.audit.append(&Row::event(id, version, event, decision, code, detail)).map(|_| ())
    }

    /// Copies a pack folder in. Only a pack the catalog pins (id, version, manifest hash) is installed, and every file is hashed again
    /// after the copy, so what runs is what was pinned. The pack is `installed`: its files are on disk and nothing can run yet.
    pub fn install(&self, src: &Path) -> Result<Manifest, String> {
        let (manifest, manifest_sha) = check_dir(src)?;
        let refuse = |code: &str| {
            let _ = self.note(&manifest.id, &manifest.version, "install", "refused-scope", Some(code), "");
            code.to_string()
        };
        if !self.catalog.pins(&manifest.id, &manifest.version, &manifest_sha) {
            return Err(refuse("not_in_catalog"));
        }
        let mut flagged = false;
        if manifest.kind == Kind::Skill {
            // One SKILL.md at the root that parses, named like the pack. A flagged skill arrives switched off.
            let text = std::fs::read_to_string(src.join(SKILL_FILE)).map_err(|_| refuse("skill_invalid"))?;
            let skill = crate::skills::parse(&text).map_err(|code| refuse(code))?;
            if manifest.id.strip_prefix("skill.") != Some(skill.name.as_str()) || !manifest.files.iter().any(|f| f.path == SKILL_FILE) {
                return Err(refuse("skill_name"));
            }
            flagged = !skill.warnings.is_empty();
        }
        let dest = self.pack_dir(&manifest.id);
        if dest.exists() {
            return Err(refuse("already_installed"));
        }
        let tmp = self.data.join("packs").join(format!("{}.installing", manifest.id));
        let _ = std::fs::remove_dir_all(&tmp);
        let stage = || -> Result<(), String> {
            copy_tree(src, &tmp)?;
            let (again, sha) = check_dir(&tmp)?;
            if again != manifest || sha != manifest_sha {
                return Err("changed_while_copying".to_string());
            }
            std::fs::create_dir_all(self.state_dir(&manifest.id).join("data")).map_err(|e| format!("state: {e}"))?;
            std::fs::rename(&tmp, &dest).map_err(|e| format!("install: {e}"))
        };
        if let Err(e) = stage() {
            let _ = std::fs::remove_dir_all(&tmp);
            return Err(refuse(&e));
        }
        if flagged {
            if let Err(e) = std::fs::write(self.state_dir(&manifest.id).join(SKILL_OFF), "the scan flagged this skill: it stays off until a person switches it on") {
                let _ = std::fs::remove_dir_all(&dest);
                return Err(format!("skill_off: {e}"));
            }
        }
        if let Err(e) = self.note(&manifest.id, &manifest.version, "install", "allowed", None, &format!("kind {:?}", manifest.kind)) {
            // An install that cannot be logged is undone.
            let _ = std::fs::remove_dir_all(&dest);
            return Err(format!("audit: {e}"));
        }
        Ok(manifest)
    }

    /// The installed pack, checked again against the catalog and its own hashes.
    fn load(&self, id: &str) -> Result<Manifest, String> {
        let dir = self.pack_dir(id);
        if !dir.is_dir() {
            return Err("not_installed".to_string());
        }
        let (manifest, sha) = check_dir(&dir)?;
        if manifest.id != id {
            return Err("manifest_id".to_string());
        }
        if !self.catalog.pins(&manifest.id, &manifest.version, &sha) {
            return Err("withdrawn".to_string());
        }
        Ok(manifest)
    }

    fn risk_texts(&self, manifest: &Manifest) -> Result<(String, String), String> {
        let read = |lang: &str| -> Result<String, String> {
            let file = manifest.risk_text.iter().find(|(l, _)| l == lang).map(|(_, f)| f.clone()).ok_or("risk_text")?;
            std::fs::read_to_string(self.pack_dir(&manifest.id).join(file)).map_err(|_| "risk_text".to_string())
        };
        Ok((read("en")?, read("vi")?))
    }

    /// Shows the native consent window. `true` only if a person clicked Accept.
    pub fn accept(&self, id: &str, dialog: &dyn ConsentDialog) -> Result<bool, String> {
        let manifest = self.load(id)?;
        if manifest.kind != Kind::Power {
            return Err("not_a_power_pack".to_string());
        }
        self.audit_state(id)?;
        let (en, vi) = self.risk_texts(&manifest)?;
        let grants = self.usable_grants(id)?;
        let b = Binding { manifest: &manifest, risk_en: &en, risk_vi: &vi, sid: &self.sid, grants: &grants };
        request_consent(dialog, &b, &self.audit, &self.state_dir(id), &self.key)
    }

    /// Opens the broker's door. Needs a consent record for exactly what the manifest declares now, signed by this run's host key.
    pub fn enable(&self, id: &str) -> Result<(), String> {
        let manifest = self.load(id)?;
        if manifest.kind != Kind::Power {
            return Err("not_a_power_pack".to_string());
        }
        // A tampered or missing audit: the pack does not run (and nothing is noted onto that chain).
        self.audit_state(id)?;
        let (en, vi) = self.risk_texts(&manifest)?;
        // The grants are part of what the person accepted: the record covers them, so a grants file changed since is `consent_stale`.
        let grants = self.usable_grants(id)?;
        let b = Binding { manifest: &manifest, risk_en: &en, risk_vi: &vi, sid: &self.sid, grants: &grants };
        if let Err(code) = verify_consent(&b, &self.state_dir(id), &self.key) {
            let _ = self.note(id, &manifest.version, "enable", "refused-user", Some(code), "");
            return Err(code.to_string());
        }
        let env = Env { pack_data: self.state_dir(id).join("data"), protected: self.protected.clone() };
        self.broker.register(manifest.clone(), grants, env)?;
        if let Err(e) = self.note(id, &manifest.version, "enable", "allowed", None, "") {
            self.broker.kill(id);
            return Err(format!("audit: {e}"));
        }
        Ok(())
    }

    /// Closes the door and ends whatever the pack holds.
    pub fn disable(&self, id: &str) -> Result<(), String> {
        let version = self.load(id).map(|m| m.version).unwrap_or_else(|_| "-".to_string());
        self.broker.kill(id);
        self.note(id, &version, "disable", "n/a", None, "")
    }

    /// R7b M2: the pack's audit chain is whole and is the one this run last saw. An installed pack always has one (its install line), so
    /// no chain is `audit_missing`; a chain that does not verify is `audit_tampered: <why>`. A pack in either state does not run, and the
    /// pack list shows the word.
    pub fn audit_state(&self, id: &str) -> Result<(), String> {
        if !self.audit.exists(id) {
            return Err("audit_missing".to_string());
        }
        match self.audit.verify(id) {
            Ok(0) => Err("audit_missing".to_string()),
            Ok(_) => Ok(()),
            Err(e) => Err(format!("audit_tampered: {e}")),
        }
    }

    pub fn is_enabled(&self, id: &str) -> bool {
        self.broker.is_registered(id)
    }

    pub fn grants(&self, id: &str) -> Result<Grants, String> {
        match std::fs::read_to_string(self.state_dir(id).join("grants.json")) {
            Ok(t) => serde_json::from_str::<Value>(&t).map(|v| grants_from_json(&v)).map_err(|_| "grants_corrupt".to_string()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Grants::default()),
            Err(e) => Err(format!("grants: {e}")),
        }
    }

    /// The user's choices (a folder, added origins, a program, the LAN switch). Only while the pack is off, so a door never changes shape
    /// under a running helper.
    pub fn set_grants(&self, id: &str, g: &Grants) -> Result<(), String> {
        if self.is_enabled(id) {
            return Err("pack_enabled".to_string());
        }
        let manifest = self.load(id)?;
        if crate::scope::grants_protected(g, &self.protected) {
            let _ = self.note(id, &manifest.version, "grants", "refused-scope", Some("grant_protected"), "");
            return Err("grant_protected".to_string());
        }
        std::fs::create_dir_all(self.state_dir(id)).map_err(|e| format!("state: {e}"))?;
        std::fs::write(self.state_dir(id).join("grants.json"), grants_to_json(g).to_string()).map_err(|e| format!("grants: {e}"))?;
        self.note(id, &manifest.version, "grants", "n/a", None, "")
    }

    /// Starts the installed helper of an enabled pack (its hashes are checked again first). It speaks the helper protocol over stdio.
    pub fn start_helper(&self, id: &str, args: &[String]) -> Result<u32, String> {
        if !self.is_enabled(id) {
            return Err("not_enabled".to_string());
        }
        let manifest = self.load(id)?;
        self.audit_state(id)?;
        let helper = manifest.helper.as_deref().ok_or("not_a_power_pack")?;
        self.broker.start_helper(id, &self.pack_dir(id).join(helper), args).map_err(str::to_string)
    }

    /// The kill switch: ends the pack's helper, its processes and its listeners now, and closes its door. Consent is revoked first, so the
    /// pack stays off, across a restart too, until the user accepts and enables it again.
    pub fn kill(&self, id: &str) -> Result<(), String> {
        let revoked = crate::consent::revoke_consent(&self.state_dir(id));
        // The door closes first, even when the consent could not be taken away or the audit line cannot be written (a tampered chain):
        // nothing slow (re-hashing the pack) and nothing that can fail comes before it. The errors are still returned.
        self.broker.kill(id);
        let noted = if matches!(revoked, Ok(true)) { self.note(id, &self.version_of(id), "consent-revoked", "n/a", None, "kill") } else { Ok(()) };
        revoked.map(|_| ())?;
        noted
    }

    /// The installed manifest's version, read leniently (the pack may be withdrawn or damaged), for an audit line.
    fn version_of(&self, id: &str) -> String {
        std::fs::read_to_string(self.pack_dir(id).join(MANIFEST_FILE)).ok().and_then(|t| Manifest::parse(&t).ok()).map(|m| m.version).unwrap_or_else(|| "-".to_string())
    }

    /// Kills every pack (one press of the stop-all control). Every door closes FIRST, then each consent is revoked; a pack whose consent
    /// cannot be taken away never stops the others (R7b, gate should-fix 4). Every failure is returned.
    pub fn kill_all(&self) -> Result<(), String> {
        self.broker.kill_all();
        let mut failures = Vec::new();
        for id in self.installed_ids()? {
            if let Err(e) = self.kill(&id) {
                failures.push(format!("{id}: {e}"));
            }
        }
        if failures.is_empty() { Ok(()) } else { Err(format!("kill_all_incomplete: {}", failures.join("; "))) }
    }

    /// The ids of every installed pack.
    pub fn installed_ids(&self) -> Result<Vec<String>, String> {
        match std::fs::read_dir(self.data.join("packs")) {
            Ok(rd) => Ok(rd.flatten().filter(|e| e.path().is_dir()).filter_map(|e| e.file_name().into_string().ok()).filter(|n| !n.ends_with(".installing")).collect()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(e) => Err(format!("packs_dir: {e}")),
        }
    }

    /// Removes the pack and everything it left: kill first, then its folder, its state (consent, grants, its own data) and its audit chain
    /// (copied to `export_to` first when the user asked). One line stays in the host's own log (`host-packs`): which pack and version were
    /// removed. A reparse point is unlinked, never entered. Run it again after a failure: it removes what is left.
    pub fn uninstall(&self, id: &str, export_to: Option<&Path>) -> Result<(), String> {
        if !crate::audit::id_is_dirname(id) {
            return Err("not_installed".to_string());
        }
        let (pack_dir, state_dir, audit_dir) = (self.pack_dir(id), self.state_dir(id), self.audit.pack_dir(id));
        if !pack_dir.exists() && !state_dir.exists() {
            return Err("not_installed".to_string());
        }
        // The version for the one host line: read leniently, the pack may be withdrawn or damaged.
        let version = self.version_of(id);
        // Kill first. A consent that cannot be revoked here is deleted with the state folder below, and any failure there is reported.
        let _ = self.kill(id);
        if let Some(out) = export_to {
            if audit_dir.exists() {
                copy_tree(&audit_dir, &out.join(id)).map_err(|e| format!("export_failed: {e}"))?;
                self.audit.copy_anchor_to(id, out).map_err(|e| format!("export_failed: {e}"))?;
                // The export verifies for this Windows user only: its HEAD is signed by the audit key, sealed to this user (DPAPI).
                let key = self.data.join("audit").join(crate::audit::KEY_FILE);
                if !out.join(crate::audit::KEY_FILE).exists() {
                    std::fs::copy(&key, out.join(crate::audit::KEY_FILE)).map_err(|e| format!("export_failed: {e}"))?;
                }
            }
        }
        let mut failures: Vec<String> = [&pack_dir, &state_dir, &audit_dir].into_iter().filter_map(|p| remove_tree(p).err()).collect();
        failures.extend(self.audit.forget(id).err());
        crate::proc::forget_container(&crate::proc::container_name(id));
        if !failures.is_empty() {
            return Err(format!("uninstall_incomplete: {}", failures.join("; ")));
        }
        self.note("host-packs", "-", "uninstall", "n/a", None, &format!("{id} {version}"))
    }

    /// The skills that are on, in pack id order: every skill pack that is switched on, and the `SKILL.md` of every ENABLED power pack.
    /// A pack whose files no longer match the catalog is skipped (fail closed), never loaded.
    pub fn skills(&self) -> Vec<(String, crate::skills::Skill)> {
        let mut ids = self.installed_ids().unwrap_or_default();
        ids.sort();
        let mut out = Vec::new();
        for id in ids {
            let Ok(manifest) = self.load(&id) else { continue };
            let file = match manifest.kind {
                Kind::Skill if !self.state_dir(&id).join(SKILL_OFF).exists() => Some(SKILL_FILE.to_string()),
                Kind::Power if self.is_enabled(&id) => manifest.skill.clone(),
                _ => None,
            };
            let Some(file) = file else { continue };
            if let Some(skill) = std::fs::read_to_string(self.pack_dir(&id).join(file)).ok().and_then(|t| crate::skills::parse(&t).ok()) {
                out.push((id, skill));
            }
        }
        out
    }

    /// The prompt block for `skills()` (see `skills::prompt_block`), or "" for none.
    pub fn skills_prompt(&self) -> String {
        let all: Vec<crate::skills::Skill> = self.skills().into_iter().map(|(_, s)| s).collect();
        crate::skills::prompt_block(&all)
    }

    /// Switches an installed skill pack on or off (a person's act: the scan flags a skill off until then).
    pub fn switch_skill(&self, id: &str, on: bool) -> Result<(), String> {
        let manifest = self.load(id)?;
        if manifest.kind != Kind::Skill {
            return Err("not_a_skill".to_string());
        }
        let marker = self.state_dir(id).join(SKILL_OFF);
        if on {
            match std::fs::remove_file(&marker) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(format!("skill_switch: {e}")),
            }
        } else {
            std::fs::write(&marker, "switched off").map_err(|e| format!("skill_switch: {e}"))?;
        }
        self.note(id, &manifest.version, if on { "skill-on" } else { "skill-off" }, "n/a", None, "")
    }
}

