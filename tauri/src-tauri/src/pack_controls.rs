//! The host's pack controls (T-31-MAUS R7, K0a; `pack_host.rs` on the Maus line, renamed in the alpha.11 merge because the
//! MKT web-app pack host of the room line owns that name): turn a power pack on (the native consent window, then the broker's door), turn it off,
//! kill it, remove it, list. Served by the `pack_op` Tauri command of the MAIN webview only, like `agent_accept_pack` (HB-2). Not an rpc
//! method: `rpc_allow_list` has no pack name, the sidecar never sees these calls, and no tool of the agent loop names them. The page can
//! ask for the window; it cannot click it. Install is not offered here: no power pack ships in this build (the compiled catalog is
//! empty), so there is nothing a person could install.
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use zumi_packs::consent::ConsentDialog;
use zumi_packs::packs::{Catalog, Packs};

static PACKS: OnceLock<Result<Packs, String>> = OnceLock::new();

/// The pack manager of this run of the app: the data dir, the HB-2 host key (the same one the hands acceptance is signed with) and the
/// catalog compiled into this build. `app_dirs` are the app's own folders (install, local data, config): with the data dir, no pack scope
/// ever reaches them (R7b M1).
pub fn packs(data_dir: &Path, app_dirs: &[PathBuf]) -> Result<&'static Packs, String> {
    PACKS
        .get_or_init(|| {
            let mut p = Packs::new(data_dir, crate::agent_wiring::host_accept_key(), Catalog::compiled())?;
            for d in app_dirs {
                p.protect(d);
            }
            Ok(p)
        })
        .as_ref()
        .map_err(Clone::clone)
}

/// One control. `dialog` is the window the person answers; only `enable` shows it.
pub fn serve_with(packs: &Packs, dialog: &dyn ConsentDialog, op: &str, id: Option<&str>) -> Result<Value, String> {
    let pack_id = || id.filter(|i| zumi_packs::audit::id_is_dirname(i)).ok_or_else(|| "bad_id".to_string());
    match op {
        "list" => {
            let mut installed = packs.installed_ids()?;
            installed.sort();
            let enabled: Vec<&String> = installed.iter().filter(|i| packs.is_enabled(i)).collect();
            // R7b M2: why a pack will not run, as the word the UI shows ("ok", "audit_missing", "audit_tampered: ...").
            let audit: serde_json::Map<String, Value> = installed.iter().map(|i| (i.clone(), json!(packs.audit_state(i).err().unwrap_or_else(|| "ok".to_string())))).collect();
            Ok(json!({ "ok": true, "installed": installed, "enabled": enabled, "audit": audit }))
        }
        // The window comes first and is asked every time: consent is the person's act, so a refusal here, an unknown pack or a pack that
        // changed all stop before anything is opened.
        "enable" => {
            let id = pack_id()?;
            if !packs.accept(id, dialog)? {
                return Ok(json!({ "ok": true, "accepted": false, "enabled": false }));
            }
            packs.enable(id)?;
            Ok(json!({ "ok": true, "accepted": true, "enabled": true }))
        }
        "disable" => packs.disable(pack_id()?).map(|_| json!({ "ok": true })),
        "kill" => packs.kill(pack_id()?).map(|_| json!({ "ok": true })),
        "kill_all" => packs.kill_all().map(|_| json!({ "ok": true })),
        "uninstall" => packs.uninstall(pack_id()?, None).map(|_| json!({ "ok": true })),
        _ => Err("unknown_op".to_string()),
    }
}

/// `serve_with` with the real window.
#[cfg(windows)]
pub fn serve(packs: &Packs, op: &str, id: Option<&str>) -> Result<Value, String> {
    serve_with(packs, &zumi_packs::consent::NativeConsent, op, id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use crate::vault::sha256_hex;
    use zumi_packs::packs::CatalogEntry;

    struct Says(bool, RefCell<usize>);
    impl ConsentDialog for Says {
        fn ask(&self, _title: &str, _text: &str) -> bool {
            *self.1.borrow_mut() += 1;
            self.0
        }
    }

    /// A catalog pack on disk, installed.
    fn installed(name: &str) -> (std::path::PathBuf, Packs) {
        let root = std::env::temp_dir().join(format!("zumi-pack-host-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let src = root.join("src");
        std::fs::create_dir_all(src.join("bin")).unwrap();
        let files = [("bin/h.exe", b"MZ-host-test".to_vec()), ("RISK.en.md", b"A worst case.".to_vec()), ("RISK.vi.md", b"Mot truong hop.".to_vec())];
        let mut listed = Vec::new();
        for (p, b) in &files {
            std::fs::write(src.join(p), b).unwrap();
            listed.push(json!({ "path": p, "sha256": sha256_hex(b), "bytes": b.len() }));
        }
        let manifest = json!({ "format": "zumi-pack/1", "kind": "power", "id": "power.hosttest", "version": "1.0.0", "files": listed,
            "power": { "protocol": "zumi-power/1", "helper": "bin/h.exe", "risk": { "level": "high", "revision": 1, "text": { "en": "RISK.en.md", "vi": "RISK.vi.md" } },
                "capabilities": [{ "id": "fs.read", "scope": { "roots": ["pack-data"] } }] } })
        .to_string();
        std::fs::write(src.join("zumi-pack.json"), &manifest).unwrap();
        let entry = CatalogEntry { id: "power.hosttest".into(), version: "1.0.0".into(), manifest_sha256: sha256_hex(manifest.as_bytes()) };
        let packs = Packs::with_sid(&root.join("data"), &[3u8; 32], Catalog(vec![entry]), "S-1-5-21-1-2-3-1001".into()).unwrap();
        packs.install(&src).unwrap();
        (root, packs)
    }

    #[test]
    fn enable_shows_the_window_and_a_no_leaves_the_pack_off_a_yes_turns_it_on_and_kill_turns_it_off() {
        let (root, packs) = installed("ops");
        let id = Some("power.hosttest");
        let no = Says(false, RefCell::new(0));
        let declined = serve_with(&packs, &no, "enable", id).unwrap();
        assert_eq!((declined["enabled"].clone(), *no.1.borrow()), (json!(false), 1), "one window, answered no");
        assert!(!packs.is_enabled("power.hosttest"));
        let yes = Says(true, RefCell::new(0));
        assert_eq!(serve_with(&packs, &yes, "enable", id).unwrap()["enabled"], true);
        assert!(packs.is_enabled("power.hosttest"));
        let listed = serve_with(&packs, &yes, "list", None).unwrap();
        assert_eq!((listed["installed"].clone(), listed["enabled"].clone()), (json!(["power.hosttest"]), json!(["power.hosttest"])));
        assert_eq!(listed["audit"], json!({ "power.hosttest": "ok" }), "the list says why a pack would not run");
        assert_eq!(*yes.1.borrow(), 1, "list asks nobody");
        assert_eq!(serve_with(&packs, &yes, "kill", id).unwrap()["ok"], true);
        assert!(!packs.is_enabled("power.hosttest"));
        assert_eq!(serve_with(&packs, &yes, "enable", id).unwrap()["enabled"], true, "turned on again by asking again");
        assert_eq!(*yes.1.borrow(), 2, "a kill revoked the consent, so the window came back");
        assert_eq!(serve_with(&packs, &yes, "kill_all", None).unwrap()["ok"], true);
        assert!(!packs.is_enabled("power.hosttest"));
        assert_eq!(serve_with(&packs, &yes, "uninstall", id).unwrap()["ok"], true);
        assert_eq!(serve_with(&packs, &yes, "list", None).unwrap()["installed"], json!([]));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn bite_an_unknown_op_install_and_a_bad_id_are_refused_and_never_show_a_window() {
        let (root, packs) = installed("refuse");
        let dlg = Says(true, RefCell::new(0));
        for (op, id) in [("install", Some("power.hosttest")), ("accept", Some("power.hosttest")), ("consent", Some("power.hosttest")), ("set_grants", Some("power.hosttest")), ("", None), ("enable", None), ("enable", Some("../x")), ("enable", Some("power.nope"))] {
            assert!(serve_with(&packs, &dlg, op, id).is_err(), "{op:?} {id:?}");
        }
        assert_eq!(*dlg.1.borrow(), 0, "no window for any of them");
        assert!(!packs.is_enabled("power.hosttest"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_catalog_compiled_into_this_build_is_empty_so_nothing_can_be_installed() {
        assert!(Catalog::compiled().0.is_empty());
    }

    #[test]
    fn the_pack_controls_are_not_an_rpc_method_and_the_rpc_path_never_names_them() {
        for guess in ["packs.enable", "packs.accept", "packs.consent", "packs.install", "packs.kill", "power.accept", "power.enable", "pack.enable", "pack_op", "agent.acceptPack", "agent.enablePack", "skills.install", "packs.list", "packs.uninstall"] {
            assert!(crate::renderer_method_allowed(guess).is_err(), "{guess} must not be an rpc method");
        }
        for name in crate::rpc_allow_list::ALLOWED_METHODS {
            let n = name.to_lowercase();
            assert!(!(n.contains("pack") && (n.contains("accept") || n.contains("consent") || n.contains("enable") || n.contains("kill"))), "{name}");
        }
        let lib = include_str!("lib.rs");
        let rpc_start = lib.find("async fn rpc(").expect("the rpc command");
        let rpc_body = &lib[rpc_start..rpc_start + lib[rpc_start..].find("\n}\n").expect("its end")];
        for needle in ["pack_controls", "zumi_packs", "NativeConsent", "request_consent"] {
            assert!(!rpc_body.contains(needle), "the rpc command names {needle}");
        }
        // the one command that serves the controls refuses every webview but the main one
        let cmd_start = lib.find("async fn pack_op(").expect("the pack_op command");
        let cmd_body = &lib[cmd_start..cmd_start + lib[cmd_start..].find("\n}\n").expect("its end")];
        assert!(cmd_body.contains("if !guest::is_main(&caller) {"), "pack_op refuses non-main callers");
        assert!(cmd_body.contains("pack_controls::serve"), "and serves through pack_controls");
        // the sidecar and the agent loop never name this module
        for (what, text) in [("sidecar bridge", include_str!("agent_host.rs")), ("agent wiring", include_str!("agent_wiring.rs"))] {
            assert!(!text.contains("pack_controls") && !text.contains("NativeConsent"), "{what} names the pack controls");
        }
    }
}
