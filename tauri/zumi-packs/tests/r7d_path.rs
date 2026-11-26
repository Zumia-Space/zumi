//! R7d (gate R7c should-fix 2): a reviewed program is the one in the system folder, not whatever the user's PATH finds first. This file holds ONE
//! test on purpose: it edits PATH, which is the whole process's, so no other test may run beside it.
mod common;
use common::*;
use serde_json::json;
use std::path::PathBuf;
use zumi_packs::manifest::Manifest;
use zumi_packs::scope::{decide, Action, Allowed, Env, Grants};

#[test]
fn a_reviewed_program_is_the_system_one_even_with_a_same_named_decoy_first_on_path() {
    let root = unique("r7d-path");
    let (decoys, data, ws) = (root.join("decoys"), root.join("data"), root.join("ws"));
    let pack_data = data.join("packs-state").join(ID).join("data");
    for d in [&decoys, &ws, &pack_data] {
        std::fs::create_dir_all(d).unwrap();
    }
    for n in ["ping.exe", "hostname.exe", "whoami.exe"] {
        std::fs::write(decoys.join(n), b"MZ decoy").unwrap();
    }
    let old = std::env::var_os("PATH").unwrap();
    let mut dirs = vec![decoys.clone()];
    dirs.extend(std::env::split_paths(&old));
    // SAFETY-by-construction: this is the only test in this binary, so nothing else reads PATH while it is changed.
    std::env::set_var("PATH", std::env::join_paths(dirs).unwrap());

    let caps = json!([{ "id": "proc.spawn", "scope": { "programs": ["ping", "hostname", "whoami"], "cwd": "workspace", "shell": false } }]);
    let manifest = Manifest::parse(&manifest_text(caps)).unwrap();
    let grants = Grants { workspace: Some(ws.clone()), ..Default::default() };
    let env = Env { pack_data, protected: vec![data] };
    let system32 = PathBuf::from(std::env::var("SystemRoot").unwrap()).join("System32");
    let mut got = Vec::new();
    for name in ["ping", "hostname", "whoami", "PING.EXE"] {
        let r = decide(&manifest, &grants, &env, &Action::Spawn { program: name, cwd: None, args: &[] });
        got.push((name, r));
    }
    std::env::set_var("PATH", old);
    let _ = std::fs::remove_dir_all(&root);
    for (name, r) in got {
        let Ok(Allowed::Spawn { exe, .. }) = r else { panic!("{name}: {r:?}") };
        let want = system32.join(format!("{}.exe", name.to_lowercase().trim_end_matches(".exe")));
        assert_eq!(exe.to_string_lossy().to_lowercase(), want.to_string_lossy().to_lowercase(), "{name}: resolved off PATH to a decoy");
    }
}
