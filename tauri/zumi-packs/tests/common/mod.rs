//! A pack world for the broker tests: a data dir, a workspace, a folder outside everything, a manifest and the grants.
#![allow(dead_code)]
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use zumi_packs::audit::PackAudit;
use zumi_packs::broker::Broker;
use zumi_packs::manifest::Manifest;
use zumi_packs::scope::{Env, Grants};

pub const ID: &str = "power.canary";

pub struct World {
    pub root: PathBuf,
    pub data: PathBuf,
    pub workspace: PathBuf,
    pub outside: PathBuf,
    pub pack_data: PathBuf,
    pub broker: Broker,
    pub audit: Arc<PackAudit>,
}

pub fn sha(c: char) -> String {
    c.to_string().repeat(64)
}

/// A free loopback port (bound and released at once).
pub fn free_port() -> u16 {
    let l = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    l.local_addr().unwrap().port()
}

pub fn manifest_text(capabilities: Value) -> String {
    json!({
        "format": "zumi-pack/1", "kind": "power", "id": ID, "version": "1.0.0",
        "files": [
            { "path": "bin/zumi-pack-canary.exe", "sha256": sha('a'), "bytes": 10 },
            { "path": "RISK.en.md", "sha256": sha('b'), "bytes": 100 },
            { "path": "RISK.vi.md", "sha256": sha('c'), "bytes": 100 }
        ],
        "power": {
            "protocol": "zumi-power/1", "helper": "bin/zumi-pack-canary.exe",
            "risk": { "level": "high", "revision": 1, "text": { "en": "RISK.en.md", "vi": "RISK.vi.md" } },
            "capabilities": capabilities
        }
    })
    .to_string()
}

/// A name no other test in this process uses.
pub fn unique(name: &str) -> PathBuf {
    static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let n = N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let d = std::env::temp_dir().join(format!("zumi-packs-{}-{name}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// Builds the folders and registers the pack.
pub fn world(name: &str, capabilities: Value, grants: impl FnOnce(&Path, &Path) -> Grants) -> World {
    let root = unique(name);
    let (data, workspace, outside) = (root.join("data"), root.join("workspace"), root.join("outside"));
    let pack_data = data.join("packs-state").join(ID).join("data");
    for d in [&workspace, &outside, &pack_data] {
        std::fs::create_dir_all(d).unwrap();
    }
    let manifest = Manifest::parse(&manifest_text(capabilities)).unwrap();
    let audit = Arc::new(PackAudit::new(&data.join("audit")));
    let broker = Broker::new(audit.clone());
    let g = grants(&workspace, &outside);
    broker.register(manifest, g, Env { pack_data: pack_data.clone(), protected: vec![data.clone()] }).unwrap();
    World { root, data, workspace, outside, pack_data, broker, audit }
}

impl World {
    /// The audit rows of the pack with this decision.
    pub fn rows(&self, decision: &str) -> Vec<Value> {
        self.audit.rows(ID).unwrap().into_iter().filter(|r| r["decision"] == decision).collect()
    }
}

impl Drop for World {
    fn drop(&mut self) {
        self.broker.kill_all();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

// ---- a whole pack folder and the host that installs it ----

use zumi_audit::hostmac::sha256_hex;
use zumi_packs::consent::ConsentDialog;
use zumi_packs::packs::{Catalog, CatalogEntry, Packs};

pub const KEY: [u8; 32] = [9u8; 32];
pub const SID: &str = "S-1-5-21-1-2-3-1001";

/// What a pack folder holds: a helper (bytes of any `.exe`), the two risk texts, the manifest. Returns the folder and its catalog entry.
pub fn make_pack(dir: &Path, version: &str, capabilities: Value, helper: &[u8], risk_en: &str) -> (PathBuf, CatalogEntry) {
    std::fs::create_dir_all(dir.join("bin")).unwrap();
    std::fs::write(dir.join("bin").join("zumi-pack-canary.exe"), helper).unwrap();
    std::fs::write(dir.join("RISK.en.md"), risk_en).unwrap();
    std::fs::write(dir.join("RISK.vi.md"), "Mot cau rui ro cu the.").unwrap();
    let entry = |p: &str| {
        let b = std::fs::read(dir.join(p)).unwrap();
        json!({ "path": p, "sha256": sha256_hex(&b), "bytes": b.len() })
    };
    let manifest = json!({
        "format": "zumi-pack/1", "kind": "power", "id": ID, "version": version,
        "files": [entry("bin/zumi-pack-canary.exe"), entry("RISK.en.md"), entry("RISK.vi.md")],
        "power": {
            "protocol": "zumi-power/1", "helper": "bin/zumi-pack-canary.exe",
            "risk": { "level": "high", "revision": 1, "text": { "en": "RISK.en.md", "vi": "RISK.vi.md" } },
            "capabilities": capabilities
        }
    })
    .to_string();
    std::fs::write(dir.join("zumi-pack.json"), &manifest).unwrap();
    (dir.to_path_buf(), CatalogEntry { id: ID.to_string(), version: version.to_string(), manifest_sha256: sha256_hex(manifest.as_bytes()) })
}

pub fn spawn_caps() -> Value {
    json!([
        { "id": "proc.spawn", "scope": { "programs": ["hostname"], "cwd": "workspace", "shell": false } },
        { "id": "fs.read", "scope": { "roots": ["pack-data"] } },
        { "id": "net.listen", "scope": { "bind": "loopback", "ports": [18800] } }
    ])
}

/// Answers every consent window the same way and remembers what it was shown.
pub struct Says(pub bool, pub std::cell::RefCell<Vec<(String, String)>>);
impl Says {
    pub fn yes() -> Says {
        Says(true, Default::default())
    }
    pub fn no() -> Says {
        Says(false, Default::default())
    }
}
impl ConsentDialog for Says {
    fn ask(&self, title: &str, text: &str) -> bool {
        self.1.borrow_mut().push((title.to_string(), text.to_string()));
        self.0
    }
}

pub struct Host {
    pub root: PathBuf,
    pub packs: Packs,
    pub src: PathBuf,
    pub entry: CatalogEntry,
}

pub fn host(name: &str, capabilities: Value) -> Host {
    let root = unique(name);
    let (src, entry) = make_pack(&root.join("src-pack"), "1.0.0", capabilities, b"MZ-not-a-real-exe", "A page the helper reads can trick it into running commands that delete or leak your files.");
    let packs = Packs::with_sid(&root.join("data"), &KEY, Catalog(vec![entry.clone()]), SID.to_string()).unwrap();
    Host { root, packs, src, entry }
}

impl Drop for Host {
    fn drop(&mut self) {
        self.packs.broker().kill_all();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

// ---- the real canary helper ----

/// A host whose pack ships the real canary exe (needs `--features canary`).
#[cfg(feature = "canary")]
pub fn canary_host(name: &str, capabilities: Value) -> Host {
    let root = unique(name);
    let exe = std::fs::read(env!("CARGO_BIN_EXE_zumi-pack-canary")).unwrap();
    let (src, entry) = make_pack(&root.join("src-pack"), "1.0.0", capabilities, &exe, "A page the helper reads can trick it into running commands that delete or leak your files.");
    let packs = Packs::with_sid(&root.join("data"), &KEY, Catalog(vec![entry.clone()]), SID.to_string()).unwrap();
    Host { root, packs, src, entry }
}

/// Is a process with this pid still running?
#[cfg(windows)]
pub fn alive(pid: u32) -> bool {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    // SAFETY: a query-only handle that is closed here.
    unsafe {
        let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else { return false };
        let mut code = 0u32;
        let ok = GetExitCodeProcess(h, &mut code).is_ok();
        let _ = CloseHandle(h);
        ok && code == 259 // STILL_ACTIVE
    }
}

/// Waits until `f` gives Some, at most `secs`.
pub fn wait_for<T>(secs: u64, mut f: impl FnMut() -> Option<T>) -> Option<T> {
    let end = std::time::Instant::now() + std::time::Duration::from_secs(secs);
    while std::time::Instant::now() < end {
        if let Some(v) = f() {
            return Some(v);
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    None
}

impl Host {
    /// The canary's report (what the broker answered to each attempt), once it has been written.
    pub fn report(&self) -> Option<Value> {
        let text = std::fs::read_to_string(self.packs.state_dir(ID).join("data").join("report.json")).ok()?;
        serde_json::from_str(&text).ok()
    }

    /// Writes a script, accepts (if needed), enables and starts the helper on it. Returns the helper pid.
    pub fn run_canary(&self, attempts: Value, hold: bool) -> u32 {
        let script = self.root.join("script.json");
        let report = self.packs.state_dir(ID).join("data").join("report.json");
        let _ = std::fs::remove_file(&report);
        std::fs::write(&script, json!({ "attempts": attempts, "report": report.to_string_lossy(), "hold": hold }).to_string()).unwrap();
        // A contained helper (R7c) reads nothing of the user's: the script is the one file the test hands it.
        let sid = zumi_packs::proc::container_sid(&zumi_packs::proc::container_name(ID)).unwrap();
        zumi_packs::proc::grant(&script, &sid, "R").unwrap();
        if self.packs.enable(ID).is_err() {
            assert_eq!(self.packs.accept(ID, &Says::yes()), Ok(true));
            self.packs.enable(ID).unwrap();
        }
        self.packs.start_helper(ID, &[script.to_string_lossy().into_owned()]).unwrap()
    }
}
