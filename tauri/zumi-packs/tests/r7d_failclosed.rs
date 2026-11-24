//! R7d (gate R7c should-fix 5): a helper that cannot be contained does not start, and the audit does not say it was allowed. The gate measured
//! `Err("contain_failed")` with a junction in place of the pack's data folder; this keeps that as a test, and adds what the gate called a nit:
//! the `helper-start allowed` row was written BEFORE the containment was made, so a refused start left an "allowed" row and no refusal row.
#![cfg(all(windows, feature = "canary"))]
mod common;
use common::*;
use serde_json::json;
use std::path::Path;

fn junction(link: &Path, target: &Path) {
    let s = std::process::Command::new("cmd").args(["/c", "mklink", "/J"]).arg(link).arg(target).output().unwrap();
    assert!(s.status.success(), "mklink: {}", String::from_utf8_lossy(&s.stdout));
}

#[test]
fn a_helper_that_cannot_be_contained_does_not_start_and_is_not_logged_as_allowed() {
    // a contained helper: no desktop, no device
    let caps = json!([{ "id": "fs.write", "scope": { "roots": ["pack-data"] } }]);
    let h = canary_host("r7d-failclosed", caps);
    h.packs.install(&h.src).unwrap();
    h.packs.accept(ID, &Says::yes()).unwrap();
    h.packs.enable(ID).unwrap();
    let data = h.packs.state_dir(ID).join("data");
    let elsewhere = h.root.join("elsewhere");
    std::fs::create_dir_all(&elsewhere).unwrap();
    // the pack's own data folder is swapped for a link to somewhere else, as the gate did
    std::fs::remove_dir(&data).unwrap();
    junction(&data, &elsewhere);
    let rows = |event: &str| -> Vec<serde_json::Value> { h.packs.audit().rows(ID).unwrap().into_iter().filter(|r| r["event"] == event).collect() };
    assert_eq!(h.packs.start_helper(ID, &[]), Err("contain_failed".to_string()));
    let started = rows("helper-start");
    assert!(started.iter().all(|r| r["decision"] != "allowed"), "a refused start must not leave an allowed row: {started:?}");
    assert!(started.iter().any(|r| r["decision"] == "refused-scope" && r["code"] == "contain_failed"), "and it must leave the refusal: {started:?}");
    // nothing is half started: put the folder back and the same pack starts (the control: the failure above was the containment, not the pack)
    std::fs::remove_dir(&data).unwrap();
    std::fs::create_dir_all(&data).unwrap();
    h.packs.start_helper(ID, &[]).expect("the control starts once the folder is real again");
    let started = rows("helper-start");
    assert_eq!(started.iter().filter(|r| r["decision"] == "allowed").count(), 1, "one allowed row, for the start that happened: {started:?}");
}

/// R7d (found by the 3-run check: `uninstall` failed once in 12 runs with `box_profile ... 0x80070003`): making a container's profile while
/// the same profile is being deleted (an uninstall and a start of the same pack id) must wait, not fail. The sid is the one thing a start needs
/// from the system; `forget_container` runs beside it every quarter second.
#[test]
fn making_a_container_profile_while_it_is_being_deleted_does_not_fail() {
    let name = format!("zumi-pack-r7d-race-{}", std::process::id());
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let s2 = stop.clone();
    let n2 = name.clone();
    let deleter = std::thread::spawn(move || {
        while !s2.load(std::sync::atomic::Ordering::SeqCst) {
            zumi_packs::proc::forget_container(&n2);
            std::thread::sleep(std::time::Duration::from_millis(250)); // one delete at a time, as an uninstall is; not a flood
        }
    });
    let failures: Vec<String> = (0..60).filter_map(|_| zumi_packs::proc::container_sid(&name).err()).collect();
    stop.store(true, std::sync::atomic::Ordering::SeqCst);
    deleter.join().unwrap();
    zumi_packs::proc::forget_container(&name);
    assert!(failures.is_empty(), "{} of 60 failed, first: {:?}", failures.len(), failures.first());
}
