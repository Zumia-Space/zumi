//! R7c: the audit log cannot be rolled back, emptied or re-chained ACROSS A RESTART. "Restart" is a fresh process: this test binary
//! again, running only `child_verify` / `child_append` (the in-process anchor of R7b cannot help there).
mod common;
use common::*;
use std::path::{Path, PathBuf};
use zumi_packs::audit::{PackAudit, Row};

fn chain(rows: usize, name: &str) -> (PathBuf, PackAudit) {
    let root = unique(name);
    let a = PackAudit::new(&root.join("audit"));
    for i in 0..rows {
        a.append(&Row::event(ID, "1.0.0", "install", "n/a", None, &format!("row {i}"))).unwrap();
    }
    (root, a)
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for e in std::fs::read_dir(from).unwrap().flatten() {
        std::fs::copy(e.path(), to.join(e.file_name())).unwrap();
    }
}

fn empty_dir(d: &Path) {
    for e in std::fs::read_dir(d).unwrap().flatten() {
        std::fs::remove_file(e.path()).unwrap();
    }
}

fn in_new_process(test: &str, audit: &Path) -> String {
    let out = std::process::Command::new(std::env::current_exe().unwrap()).args(["--ignored", "--exact", test, "--nocapture", "--test-threads=1"]).env("R7C_AUDIT", audit).output().unwrap();
    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    text.lines().find_map(|l| l.find("CHILD ").map(|i| l[i..].to_string())).unwrap_or_else(|| format!("CHILD <no line> {text}"))
}

#[test]
#[ignore]
fn child_verify() {
    if let Ok(d) = std::env::var("R7C_AUDIT") {
        println!("CHILD verify={:?}", PackAudit::new(Path::new(&d)).verify(ID));
    }
}

#[test]
#[ignore]
fn child_append() {
    if let Ok(d) = std::env::var("R7C_AUDIT") {
        println!("CHILD append={:?}", PackAudit::new(Path::new(&d)).append(&Row::event(ID, "1.0.0", "action", "allowed", None, "after restart")));
    }
}

/// Old lines and the old (validly signed) HEAD copied back: the log looks like it never had the last rows. The refusal row is the evidence.
#[test]
fn a_rollback_to_an_older_valid_state_is_caught_after_a_restart() {
    let (root, a) = chain(4, "r7c-rollback");
    let (dir, snap) = (a.pack_dir(ID), root.join("snap"));
    copy_dir(&dir, &snap);
    a.append(&Row::event(ID, "1.0.0", "action", "refused-scope", Some("path_protected"), "evidence")).unwrap();
    a.append(&Row::event(ID, "1.0.0", "action", "allowed", None, "more")).unwrap();
    empty_dir(&dir);
    copy_dir(&snap, &dir);
    let v = in_new_process("child_verify", &root.join("audit"));
    assert!(v.contains("Err(") && v.contains("audit_rolled_back"), "verify after restart: {v}");
    let w = in_new_process("child_append", &root.join("audit"));
    assert!(w.contains("Err(") && w.contains("audit_rolled_back"), "no new line is written onto a rolled-back chain: {w}");
}

/// Every file of the pack's chain deleted while the app is closed.
#[test]
fn a_chain_removed_while_closed_is_caught_after_a_restart() {
    let (root, a) = chain(3, "r7c-removed");
    empty_dir(&a.pack_dir(ID));
    std::fs::remove_dir(a.pack_dir(ID)).unwrap();
    let v = in_new_process("child_verify", &root.join("audit"));
    assert!(v.contains("Err(") && v.contains("audit_removed"), "verify after restart: {v}");
}

/// An uninstall removes the chain ON PURPOSE: afterwards the pack id starts a fresh chain, also after a restart.
#[test]
fn an_uninstalled_chain_is_not_expected_back() {
    let (root, a) = chain(3, "r7c-uninstall");
    empty_dir(&a.pack_dir(ID));
    std::fs::remove_dir(a.pack_dir(ID)).unwrap();
    a.forget(ID).unwrap();
    assert_eq!(in_new_process("child_verify", &root.join("audit")), "CHILD verify=Ok(0)");
    assert!(in_new_process("child_append", &root.join("audit")).starts_with("CHILD append=Ok("));
}
