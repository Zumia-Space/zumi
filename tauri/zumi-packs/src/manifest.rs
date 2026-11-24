//! The pack manifest (`zumi-pack.json`, format `zumi-pack/1`) as the Rust host reads it: kind `power` (a Zumia helper exe plus the
//! capabilities it declares) or kind `skill` (one markdown file, data only, no capability). Every refusal is ONE fixed code word.
//!
//! The capability list is closed and compiled into the host (roadmap 1.3): a capability not on it cannot be declared, so adding one is a
//! host change with its own gate. A manifest is checked as a whole before anything is installed; any doubt refuses.
use serde_json::Value;
use zumi_audit::hostmac::sha256_hex;

pub const FORMAT: &str = "zumi-pack/1";
pub const MANIFEST_FILE: &str = "zumi-pack.json";
pub const PROTOCOL: &str = "zumi-power/1";

/// The closed list (roadmap 1.3).
pub const CAPABILITIES: &[&str] = &[
    "proc.spawn",
    "fs.read",
    "fs.write",
    "net.egress",
    "net.listen",
    "input.inject",
    "screen.capture",
    "audio.capture",
    "account.act",
    "device.usb",
    "unattended.run",
];

/// A risk text may be at most this long (roadmap 1.2).
pub const RISK_TEXT_MAX_BYTES: usize = 4 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Power,
    Skill,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Capability {
    pub id: String,
    pub scope: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FileEntry {
    pub path: String,
    pub sha256: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Tool {
    pub name: String,
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Manifest {
    pub id: String,
    pub version: String,
    pub kind: Kind,
    pub files: Vec<FileEntry>,
    /// Power packs only.
    pub helper: Option<String>,
    pub risk_level: Option<String>,
    /// language -> file name inside the pack.
    pub risk_text: Vec<(String, String)>,
    pub capabilities: Vec<Capability>,
    pub tools: Vec<Tool>,
    pub unattended: bool,
    /// A power pack's own `SKILL.md` (loaded only while the pack is enabled).
    pub skill: Option<String>,
}

fn s<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(Value::as_str)
}

/// `power.canary`, `skill.data-dashboards`: `<kind>.<lowercase-name>`.
fn id_ok(id: &str, kind: &str) -> bool {
    let Some((k, name)) = id.split_once('.') else { return false };
    k == kind && !name.is_empty() && name.len() <= 40 && name.split('-').all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()))
}

fn version_ok(v: &str) -> bool {
    let parts: Vec<&str> = v.split('.').collect();
    parts.len() == 3 && parts.iter().all(|p| !p.is_empty() && p.len() <= 9 && p.bytes().all(|b| b.is_ascii_digit()))
}

/// A path inside a pack: relative, forward slashes, no `..`, no drive, nothing hidden.
pub fn rel_path_ok(p: &str) -> bool {
    !p.is_empty()
        && p.len() <= 200
        && !p.starts_with('/')
        && !p.contains('\\')
        && !p.contains(':')
        && p.split('/').all(|c| !c.is_empty() && c != "." && c != ".." && !c.starts_with('.') && !c.ends_with(' ') && !c.ends_with('.'))
}

fn sha_ok(h: &str) -> bool {
    h.len() == 64 && h.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

impl Manifest {
    /// Parses and checks the manifest text. The rules are `checkPower` of the roadmap: the helper is a listed `.exe`; the risk level is
    /// `high` or `critical`; both risk texts are named; every capability is on the closed list and declared once; every tool names only
    /// declared capabilities; secrets are names only. A skill declares no capability and no helper.
    pub fn parse(text: &str) -> Result<Manifest, &'static str> {
        let v: Value = serde_json::from_str(text).map_err(|_| "manifest_json")?;
        if !v.is_object() {
            return Err("manifest_json");
        }
        if s(&v, "format") != Some(FORMAT) {
            return Err("manifest_format");
        }
        let kind = match s(&v, "kind") {
            Some("power") => Kind::Power,
            Some("skill") => Kind::Skill,
            _ => return Err("manifest_kind"),
        };
        let id = s(&v, "id").ok_or("manifest_id")?.to_string();
        if !id_ok(&id, if kind == Kind::Power { "power" } else { "skill" }) {
            return Err("manifest_id");
        }
        let version = s(&v, "version").filter(|x| version_ok(x)).ok_or("manifest_version")?.to_string();
        let mut files = Vec::new();
        for f in v.get("files").and_then(Value::as_array).ok_or("files_missing")? {
            let path = s(f, "path").filter(|p| rel_path_ok(p)).ok_or("files_entry")?;
            let sha = s(f, "sha256").filter(|h| sha_ok(h)).ok_or("files_entry")?;
            let bytes = f.get("bytes").and_then(Value::as_u64).ok_or("files_entry")?;
            if files.iter().any(|e: &FileEntry| e.path == path) {
                return Err("files_entry");
            }
            files.push(FileEntry { path: path.to_string(), sha256: sha.to_string(), bytes });
        }
        let mut m = Manifest { id, version, kind, files, helper: None, risk_level: None, risk_text: Vec::new(), capabilities: Vec::new(), tools: Vec::new(), unattended: false, skill: None };
        match kind {
            Kind::Skill => {
                if v.get("power").is_some() {
                    return Err("skill_has_power");
                }
                Ok(m)
            }
            Kind::Power => {
                let p = v.get("power").filter(|p| p.is_object()).ok_or("power_missing")?;
                if s(p, "protocol") != Some(PROTOCOL) {
                    return Err("power_protocol");
                }
                let helper = s(p, "helper").filter(|h| rel_path_ok(h) && h.to_ascii_lowercase().ends_with(".exe")).ok_or("power_helper")?;
                if !m.files.iter().any(|f| f.path == helper) {
                    return Err("power_helper");
                }
                m.helper = Some(helper.to_string());
                if let Some(sk) = p.get("skill") {
                    let sk = sk.as_str().filter(|f| rel_path_ok(f) && m.files.iter().any(|x| &x.path == f)).ok_or("power_skill")?;
                    m.skill = Some(sk.to_string());
                }
                let risk = p.get("risk").filter(|r| r.is_object()).ok_or("risk_missing")?;
                let level = s(risk, "level").filter(|l| matches!(*l, "high" | "critical")).ok_or("risk_level")?;
                m.risk_level = Some(level.to_string());
                let texts = risk.get("text").and_then(Value::as_object).ok_or("risk_text")?;
                for lang in ["en", "vi"] {
                    let file = texts.get(lang).and_then(Value::as_str).filter(|f| rel_path_ok(f)).ok_or("risk_text")?;
                    let entry = m.files.iter().find(|f| f.path == file).ok_or("risk_text")?;
                    if entry.bytes == 0 || entry.bytes as usize > RISK_TEXT_MAX_BYTES {
                        return Err("risk_text");
                    }
                    m.risk_text.push((lang.to_string(), file.to_string()));
                }
                for c in p.get("capabilities").and_then(Value::as_array).ok_or("capabilities_missing")? {
                    let cid = s(c, "id").ok_or("capability_unknown")?;
                    if !CAPABILITIES.contains(&cid) {
                        return Err("capability_unknown");
                    }
                    if m.capabilities.iter().any(|x| x.id == cid) {
                        return Err("capability_duplicate");
                    }
                    m.capabilities.push(Capability { id: cid.to_string(), scope: c.get("scope").cloned().unwrap_or(Value::Null) });
                }
                if let Some(tools) = p.get("tools") {
                    for t in tools.as_array().ok_or("tools_shape")? {
                        let name = s(t, "name").filter(|n| !n.is_empty() && n.len() <= 64).ok_or("tools_shape")?;
                        let mut caps = Vec::new();
                        for c in t.get("capabilities").and_then(Value::as_array).ok_or("tools_shape")? {
                            let c = c.as_str().ok_or("tools_shape")?;
                            if !m.capabilities.iter().any(|x| x.id == c) {
                                return Err("tool_capability_undeclared");
                            }
                            caps.push(c.to_string());
                        }
                        m.tools.push(Tool { name: name.to_string(), capabilities: caps });
                    }
                }
                if let Some(secrets) = p.get("secrets") {
                    // Names only: never a value (a key shape would be a leak in a manifest).
                    for n in secrets.as_array().ok_or("secrets_shape")? {
                        let n = n.as_str().ok_or("secrets_shape")?;
                        if n.is_empty() || n.len() > 64 || !n.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b'-') {
                            return Err("secrets_shape");
                        }
                    }
                }
                m.unattended = p.get("unattended").and_then(Value::as_bool).unwrap_or(false);
                if m.unattended && !m.capabilities.iter().any(|c| c.id == "unattended.run") {
                    return Err("unattended_undeclared");
                }
                Ok(m)
            }
        }
    }

    /// R7c: does the helper run in an AppContainer (it reads nothing of the user's, has no network, no user secret)? Not when the pack
    /// declares a capability that needs the user's desktop or devices: then only "Zumia wrote the helper" (layer 1) stands in for the broker.
    pub fn helper_contained(&self) -> bool {
        !["input.inject", "screen.capture", "audio.capture", "device.usb"].iter().any(|c| self.capability(c).is_some())
    }

    pub fn capability(&self, id: &str) -> Option<&Capability> {
        self.capabilities.iter().find(|c| c.id == id)
    }

    /// The sha256 of the declared capabilities (id and scope, in id order): what a consent record is bound to, so a changed scope asks again.
    pub fn capabilities_sha256(&self) -> String {
        let mut caps: Vec<String> = self.capabilities.iter().map(|c| format!("{}={}", c.id, canonical(&c.scope))).collect();
        caps.sort();
        sha256_hex(caps.join("\n").as_bytes())
    }
}

/// A JSON value written with sorted keys, so two spellings of one scope hash alike.
pub fn canonical(v: &Value) -> String {
    match v {
        Value::Object(o) => {
            let mut keys: Vec<&String> = o.keys().collect();
            keys.sort();
            format!("{{{}}}", keys.iter().map(|k| format!("{}:{}", serde_json::to_string(k).unwrap_or_default(), canonical(&o[*k]))).collect::<Vec<_>>().join(","))
        }
        Value::Array(a) => format!("[{}]", a.iter().map(canonical).collect::<Vec<_>>().join(",")),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sha(c: char) -> String {
        c.to_string().repeat(64)
    }

    fn power(extra: impl FnOnce(&mut Value)) -> String {
        let mut v = json!({
            "format": "zumi-pack/1", "kind": "power", "id": "power.canary", "version": "1.0.0",
            "files": [
                { "path": "bin/helper.exe", "sha256": sha('a'), "bytes": 10 },
                { "path": "RISK.en.md", "sha256": sha('b'), "bytes": 100 },
                { "path": "RISK.vi.md", "sha256": sha('c'), "bytes": 100 }
            ],
            "power": {
                "protocol": "zumi-power/1", "helper": "bin/helper.exe", "unattended": false,
                "risk": { "level": "high", "revision": 1, "text": { "en": "RISK.en.md", "vi": "RISK.vi.md" } },
                "capabilities": [ { "id": "net.listen", "scope": { "bind": "loopback", "ports": [8800] } } ],
                "tools": [ { "name": "serve", "capabilities": ["net.listen"] } ],
                "secrets": ["webhook.secret"]
            }
        });
        extra(&mut v);
        v.to_string()
    }

    #[test]
    fn a_complete_power_manifest_parses() {
        let m = Manifest::parse(&power(|_| {})).unwrap();
        assert_eq!((m.id.as_str(), m.kind, m.helper.as_deref(), m.risk_level.as_deref()), ("power.canary", Kind::Power, Some("bin/helper.exe"), Some("high")));
        assert_eq!(m.capabilities.len(), 1);
        assert_eq!(m.tools[0].capabilities, vec!["net.listen".to_string()]);
    }

    #[test]
    fn bite_every_broken_rule_is_refused_with_its_own_word() {
        let cases: Vec<(&str, Box<dyn Fn(&mut Value)>, &str)> = vec![
            ("format", Box::new(|v| v["format"] = json!("zumi-pack/2")), "manifest_format"),
            ("kind", Box::new(|v| v["kind"] = json!("plugin")), "manifest_kind"),
            ("id", Box::new(|v| v["id"] = json!("voice.canary")), "manifest_id"),
            ("version", Box::new(|v| v["version"] = json!("1.0")), "manifest_version"),
            ("capability not on the closed list", Box::new(|v| v["power"]["capabilities"][0]["id"] = json!("proc.exec_anything")), "capability_unknown"),
            ("risk level low", Box::new(|v| v["power"]["risk"]["level"] = json!("low")), "risk_level"),
            ("helper not listed", Box::new(|v| v["power"]["helper"] = json!("bin/other.exe")), "power_helper"),
            ("helper is a dll", Box::new(|v| { v["power"]["helper"] = json!("bin/helper.dll"); v["files"][0]["path"] = json!("bin/helper.dll"); }), "power_helper"),
            ("risk text missing", Box::new(|v| v["power"]["risk"]["text"] = json!({ "en": "RISK.en.md" })), "risk_text"),
            ("risk text over 4 KB", Box::new(|v| v["files"][1]["bytes"] = json!(5000)), "risk_text"),
            ("tool uses an undeclared capability", Box::new(|v| v["power"]["tools"][0]["capabilities"] = json!(["proc.spawn"])), "tool_capability_undeclared"),
            ("a secret with a value in it", Box::new(|v| v["power"]["secrets"] = json!(["sk-abc def"])), "secrets_shape"),
            ("unattended without the capability", Box::new(|v| v["power"]["unattended"] = json!(true)), "unattended_undeclared"),
            ("a path that climbs out", Box::new(|v| v["files"][1]["path"] = json!("../RISK.en.md")), "files_entry"),
        ];
        for (what, edit, code) in cases {
            assert_eq!(Manifest::parse(&power(edit)), Err(code), "{what}");
        }
        assert_eq!(Manifest::parse("not json"), Err("manifest_json"));
    }

    #[test]
    fn the_capabilities_hash_follows_the_scope_not_the_spelling() {
        let a = Manifest::parse(&power(|_| {})).unwrap();
        let b = Manifest::parse(&power(|v| v["power"]["capabilities"][0]["scope"] = json!({ "ports": [8800], "bind": "loopback" }))).unwrap();
        assert_eq!(a.capabilities_sha256(), b.capabilities_sha256(), "key order does not matter");
        let c = Manifest::parse(&power(|v| v["power"]["capabilities"][0]["scope"]["ports"] = json!([8800, 8801]))).unwrap();
        assert_ne!(a.capabilities_sha256(), c.capabilities_sha256(), "a wider scope is another hash");
    }

    #[test]
    fn a_skill_manifest_declares_no_power() {
        let skill = json!({ "format": "zumi-pack/1", "kind": "skill", "id": "skill.changelog-style", "version": "1.0.0",
            "files": [ { "path": "SKILL.md", "sha256": sha('d'), "bytes": 50 } ] });
        let m = Manifest::parse(&skill.to_string()).unwrap();
        assert_eq!((m.kind, m.capabilities.len(), m.helper), (Kind::Skill, 0, None));
        let mut with_power = skill.clone();
        with_power["power"] = json!({});
        assert_eq!(Manifest::parse(&with_power.to_string()), Err("skill_has_power"));
    }
}
