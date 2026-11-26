// Room live B, P1 part 2 (ADR 2026-11-13-room-live-b D4, tests N10 N11 N12 N16): the `stage` permission, the first-party id
// allow-list, the api-2 manifest, the load-time refusals, links.open closed under stage, and --pack-dir judged by the build
// flavour. Written before the host change (red first).
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::pack_host::*;
use crate::pack_host_tests::{call, copy_dir, fixtures, scratch};

/// Write a tiny unpacked plugin pack (one ui page) with the given api and permissions; returns its folder.
pub(crate) fn write_pack(scratch_name: &str, id: &str, api: i64, perms: Value) -> PathBuf {
    let dir = scratch(scratch_name).join(id);
    std::fs::create_dir_all(dir.join("ui")).unwrap();
    let html = b"<!doctype html><title>t</title>";
    std::fs::write(dir.join("ui").join("index.html"), html).unwrap();
    let manifest = json!({
        "format": "zumi-pack/1", "id": id, "kind": "plugin", "version": "1.0.0", "name": { "en": id },
        "plugin": { "api": api, "ui": "ui/index.html", "tab": { "label": { "en": "T" } }, "permissions": perms },
        "files": [{ "path": "ui/index.html", "sha256": sha256_hex(html), "bytes": html.len() }],
    });
    std::fs::write(dir.join("zumi-pack.json"), serde_json::to_vec(&manifest).unwrap()).unwrap();
    dir
}

const ROOM_IDS: [&str; 2] = ["plugin.room-preview", "plugin.zumi-room-1"];

#[test]
fn the_host_speaks_api_1_and_2_and_refuses_the_rest() {
    assert_eq!((PLUGIN_API_MIN, PLUGIN_API), (1, 2));
    let canary = load_pack_dir(&fixtures().join("plugin.canary"), Some("plugin.canary")).unwrap();
    assert_eq!(canary.api, 1, "an api-1 pack still loads");
    let two = write_pack("api2", "plugin.api-two", 2, json!({ "net": [] }));
    assert_eq!(load_pack_dir(&two, Some("plugin.api-two")).unwrap().api, 2);
    let three = write_pack("api3", "plugin.api-three", 3, json!({}));
    assert_eq!(load_pack_dir(&three, Some("plugin.api-three")).err().as_deref(), Some("pack_needs_newer_host"));
    let zero = write_pack("api0", "plugin.api-zero", 0, json!({}));
    assert_eq!(load_pack_dir(&zero, Some("plugin.api-zero")).err().as_deref(), Some("pack_api_retired"));
    let index: Value = serde_json::from_slice(&std::fs::read(fixtures().join("index.json")).unwrap()).unwrap();
    let sha = sha256_hex(&std::fs::read(fixtures().join("plugin.canary").join("zumi-pack.json")).unwrap());
    let mut api2 = index.clone();
    api2["packs"][0]["versions"][0]["api"] = json!(2);
    assert_eq!(store_verdict(&api2, "plugin.canary", "1.0.0", &sha), Ok(()), "an index entry for api 2 is allowed");
    let mut api3 = index;
    api3["packs"][0]["versions"][0]["api"] = json!(3);
    assert_eq!(store_verdict(&api3, "plugin.canary", "1.0.0", &sha), Err("pack_needs_newer_host"));
}

#[test]
fn stage_is_granted_only_to_a_first_party_api_2_pack_that_declares_it() {
    for id in ROOM_IDS {
        let dir = write_pack(&format!("stage-ok-{id}"), id, 2, json!({ "stage": "performance", "avatar": "read", "net": [] }));
        let pack = load_pack_dir(&dir, Some(id)).unwrap_or_else(|e| panic!("{id}: {e}"));
        assert!(pack.stage && pack.avatar, "{id}");
        assert!(pack.links.is_empty(), "{id}: a stage pack declares no link");
        let plain = write_pack(&format!("stage-off-{id}"), id, 2, json!({ "avatar": "read", "net": [] }));
        assert!(!load_pack_dir(&plain, Some(id)).unwrap().stage, "{id}: not declared, not granted");
    }
    let odd = write_pack("stage-odd", "plugin.room-preview", 2, json!({ "stage": "everything" }));
    assert_eq!(load_pack_dir(&odd, Some("plugin.room-preview")).err().as_deref(), Some("plugin_permission_unknown"));
    let odd = write_pack("stage-bool", "plugin.room-preview", 2, json!({ "stage": true }));
    assert_eq!(load_pack_dir(&odd, Some("plugin.room-preview")).err().as_deref(), Some("plugin_permission_unknown"));
}

#[test]
fn an_api_1_manifest_that_declares_stage_is_refused() {
    let dir = write_pack("stage-api1", "plugin.room-preview", 1, json!({ "stage": "performance", "net": [] }));
    assert_eq!(load_pack_dir(&dir, Some("plugin.room-preview")).err().as_deref(), Some("stage_needs_api2"));
}

#[test]
fn n10_a_manifest_with_stage_and_a_non_empty_net_is_refused_at_load() {
    for net in [json!(["https://example.com"]), json!(["*"]), json!([""])] {
        let dir = write_pack("n10", "plugin.room-preview", 2, json!({ "stage": "performance", "net": net }));
        assert_eq!(load_pack_dir(&dir, Some("plugin.room-preview")).err().as_deref(), Some("plugin_permission_unknown"), "{net}");
    }
    let dir = write_pack("n10-ok", "plugin.room-preview", 2, json!({ "stage": "performance", "net": [] }));
    assert!(load_pack_dir(&dir, Some("plugin.room-preview")).is_ok(), "the empty net array stays legal");
}

#[test]
fn n11_a_manifest_with_stage_and_links_is_refused_at_load() {
    let dir = write_pack("n11", "plugin.room-preview", 2, json!({ "stage": "performance", "net": [], "links": { "docs": "https://zumia.space/" } }));
    assert_eq!(load_pack_dir(&dir, Some("plugin.room-preview")).err().as_deref(), Some("stage_links_conflict"));
    let empty = write_pack("n11-empty", "plugin.room-preview", 2, json!({ "stage": "performance", "net": [], "links": {} }));
    assert!(load_pack_dir(&empty, Some("plugin.room-preview")).is_ok(), "an empty links map declares no link");
}

#[test]
fn n11_links_open_is_403_while_stage_is_granted() {
    let data = scratch("n11-runtime");
    let mut pack = load_pack_dir(&fixtures().join("plugin.canary"), Some("plugin.canary")).unwrap();
    let mut opened = Vec::new();
    assert_eq!(call(&pack, &data, "links.open", json!({ "key": "docs" }), &mut opened).0, 200, "control: the link opens without stage");
    pack.stage = true;
    let (s, v) = call(&pack, &data, "links.open", json!({ "key": "docs" }), &mut opened);
    assert_eq!((s, v["code"].clone()), (403, json!("link_disabled_with_stage")));
    let (s, v) = call(&pack, &data, "links.open", json!({ "key": "nope" }), &mut opened);
    assert_eq!((s, v["code"].clone()), (403, json!("link_disabled_with_stage")), "an unknown key gets the same answer: no selection channel");
    assert_eq!(opened.len(), 1, "nothing opened under stage");
}

#[test]
fn n12_a_pack_outside_the_first_party_list_that_declares_stage_is_refused_at_load() {
    assert!(stage_allowed_for("plugin.room-preview") && stage_allowed_for("plugin.zumi-room-1"));
    for id in ["plugin.canary", "plugin.stage-evil", "plugin.room-preview2", "plugin.room"] {
        assert!(!stage_allowed_for(id), "{id}");
        let dir = write_pack("n12", id, 2, json!({ "stage": "performance", "net": [] }));
        assert_eq!(load_pack_dir(&dir, Some(id)).err().as_deref(), Some("stage_not_allowed"), "{id}");
    }
    // The same through the owner dev-folder route (`--pack-dir`): the allow-list is the control, not the route.
    let dir = write_pack("n12-dev", "plugin.stage-evil", 2, json!({ "stage": "performance", "net": [] }));
    let state = PackState::default();
    *state.dev_dir.lock().unwrap() = Some(dir);
    assert_eq!(open_pack(&state, "plugin.stage-evil").err().as_deref(), Some("stage_not_allowed"));
}

#[test]
fn n16_pack_dir_is_judged_by_the_build_flavour_not_the_argument() {
    let dir = scratch("n16-dir").join("plugin.canary");
    copy_dir(&fixtures().join("plugin.canary"), &dir);
    assert_eq!(pack_dir_decision(false, Some(&dir)), PackDirDecision::Refused("pack_dir_public_build"), "a public build refuses it");
    assert_eq!(pack_dir_decision(false, None), PackDirDecision::Absent);
    assert_eq!(pack_dir_decision(true, None), PackDirDecision::Absent);
    assert_eq!(pack_dir_decision(true, Some(&dir)), PackDirDecision::Use(dir.clone()), "the owner flavour may use it");
    assert_eq!(pack_dir_decision(true, Some(Path::new("relative/plugin.canary"))), PackDirDecision::Refused("pack_dir_not_plain"));
}

#[test]
fn n16_a_pack_not_in_the_signed_index_never_loads_without_a_dev_folder() {
    let data = scratch("n16-data");
    copy_dir(&fixtures().join("plugin.canary"), &data.join("packs").join("plugin.canary"));
    let state = PackState::default();
    *state.data_dir.lock().unwrap() = Some(data.clone());
    assert_eq!(open_pack(&state, "plugin.canary").err().as_deref(), Some("index_missing"), "no cached index: no load");
    // An index signed by a key the app does not hold (the fixture's throwaway key) is no index either.
    let market = data.join("market");
    std::fs::create_dir_all(&market).unwrap();
    std::fs::copy(fixtures().join("index.json"), market.join("index.json")).unwrap();
    std::fs::copy(fixtures().join("index.json.minisig"), market.join("index.json.minisig")).unwrap();
    assert_eq!(open_pack(&state, "plugin.canary").err().as_deref(), Some("index_signature"));
    // The owner dev folder is the one route without an index, and it is only ever set from a flavour-approved --pack-dir.
    let dev = scratch("n16-dev").join("plugin.canary");
    copy_dir(&fixtures().join("plugin.canary"), &dev);
    *state.dev_dir.lock().unwrap() = Some(dev);
    assert!(open_pack(&state, "plugin.canary").unwrap().dev);
}
