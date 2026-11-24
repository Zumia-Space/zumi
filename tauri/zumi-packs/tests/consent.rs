//! R7 K0a: installing and enabling a pack needs a native consent that extends the HB-2 signed acceptance. The record is made only after
//! a person clicks Accept in the host's window, is bound to exactly what the manifest declares, and cannot be made, widened or answered by
//! a helper, the sidecar or the model (they have no key and no route to the function).
#![allow(dead_code)]
mod common;
use common::*;
use serde_json::json;
use zumi_packs::consent::{risk_text_sha256, verify_consent, Binding, CONSENT_FILE};
use zumi_packs::manifest::Manifest;
use zumi_packs::packs::{Catalog, Packs};

const RISK: &str = "A page the helper reads can trick it into running commands that delete or leak your files.";

fn installed(name: &str) -> Host {
    let h = host(name, spawn_caps());
    h.packs.install(&h.src).unwrap();
    h
}

fn consent_file(h: &Host) -> std::path::PathBuf {
    h.packs.state_dir(ID).join(CONSENT_FILE)
}

#[test]
fn the_window_shows_the_risk_first_and_a_list_made_from_the_manifest_in_both_languages() {
    let h = installed("text");
    let dialog = Says::yes();
    assert_eq!(h.packs.accept(ID, &dialog), Ok(true));
    let shown = dialog.1.borrow();
    assert_eq!(shown.len(), 1, "one window");
    let (title, text) = &shown[0];
    assert!(title.contains(ID), "{title}");
    assert!(text.starts_with(RISK), "line 1 is the pack's own worst case: {text}");
    for line in ["Can start programs on this PC: hostname", "Can read files in: pack-data", "ports 18800", "only programs on this PC"] {
        assert!(text.contains(line), "missing {line:?} in {text}");
    }
    for line in ["Có thể chạy chương trình trên máy này: hostname", "cổng 18800", "Anh tự chịu rủi ro"] {
        assert!(text.contains(line), "missing {line:?}");
    }
    assert!(text.contains("1.0.0") && text.contains("HIGH"));
    // no sentence says or implies that the pack is protected
    let lower = text.to_lowercase();
    for word in ["safe", "sandbox", "protected", "secure", "an toàn", "bảo vệ", "bảo đảm"] {
        assert!(!lower.contains(word), "the text must not say {word:?}");
    }
}

#[test]
fn a_capability_line_is_generated_not_typed_so_a_wider_manifest_changes_the_text() {
    let h = host("wider", json!([{ "id": "net.listen", "scope": { "bind": "lan", "ports": [8800] } }, { "id": "account.act", "scope": { "services": ["x"] } }]));
    h.packs.install(&h.src).unwrap();
    let dialog = Says::yes();
    h.packs.accept(ID, &dialog).unwrap();
    let text = dialog.1.borrow()[0].1.clone();
    assert!(text.contains("your network") && text.contains("Can send or post as you"), "{text}");
}

#[test]
fn declining_records_a_refusal_and_no_consent_and_the_pack_cannot_be_enabled() {
    let h = installed("decline");
    assert_eq!(h.packs.accept(ID, &Says::no()), Ok(false));
    assert!(!consent_file(&h).exists(), "no record without a click");
    assert_eq!(h.packs.enable(ID), Err("consent_missing".to_string()));
    assert!(!h.packs.is_enabled(ID));
    let rows = h.packs.audit().rows(ID).unwrap();
    let consent: Vec<_> = rows.iter().filter(|r| r["event"] == "consent").collect();
    assert_eq!((consent.len(), consent[0]["decision"].as_str(), consent[0]["code"].as_str()), (1, Some("refused-user"), Some("declined")));
    assert_eq!(h.packs.broker().spawn(ID, "hostname", &[], None), Err("not_enabled"), "no door");
}

#[test]
fn accepting_then_enabling_opens_the_door_and_every_step_is_in_the_audit_chain() {
    let h = installed("accept");
    assert_eq!(h.packs.enable(ID), Err("consent_missing".to_string()), "enable alone is not enough");
    assert_eq!(h.packs.accept(ID, &Says::yes()), Ok(true));
    assert!(consent_file(&h).exists());
    h.packs.enable(ID).unwrap();
    assert!(h.packs.is_enabled(ID));
    let events: Vec<(String, String)> = h.packs.audit().rows(ID).unwrap().iter().map(|r| (r["event"].as_str().unwrap().to_string(), r["decision"].as_str().unwrap().to_string())).collect();
    assert_eq!(
        events,
        vec![("install", "allowed"), ("enable", "refused-user"), ("consent", "allowed"), ("enable", "allowed")].into_iter().map(|(a, b)| (a.to_string(), b.to_string())).collect::<Vec<_>>()
    );
    assert_eq!(h.packs.audit().verify(ID), Ok(4));
    let line = std::fs::read_to_string(consent_file(&h)).unwrap();
    let v: serde_json::Value = serde_json::from_str(line.trim()).unwrap();
    assert_eq!((v["pack"].as_str(), v["version"].as_str(), v["windows_user_sid"].as_str()), (Some(ID), Some("1.0.0"), Some(SID)));
    assert_eq!(v["mac"].as_str().map(str::len), Some(64));
}

#[test]
fn bite_a_forged_record_and_a_record_signed_under_another_key_do_not_enable() {
    let h = installed("forged");
    h.packs.accept(ID, &Says::yes()).unwrap();
    let real: serde_json::Value = serde_json::from_str(std::fs::read_to_string(consent_file(&h)).unwrap().trim()).unwrap();
    // 1. the same fields with a made-up MAC (what a script that cannot hold the key can write)
    let mut forged = real.clone();
    forged["mac"] = json!("0".repeat(64));
    std::fs::write(consent_file(&h), format!("{forged}\n")).unwrap();
    assert_eq!(h.packs.enable(ID), Err("consent_invalid".to_string()), "a made-up MAC");
    // 2. an empty file and garbage lines
    std::fs::write(consent_file(&h), "\nnot json\n[]\n").unwrap();
    assert_eq!(h.packs.enable(ID), Err("consent_missing".to_string()), "garbage is no record");
    // 3. a genuine record from another run of the app (another key)
    std::fs::write(consent_file(&h), format!("{real}\n")).unwrap();
    let other = Packs::with_sid(&h.root.join("data"), &[7u8; 32], Catalog(vec![h.entry.clone()]), SID.to_string()).unwrap();
    assert_eq!(other.enable(ID), Err("consent_invalid".to_string()), "a record signed by another key is not accepted");
    // and the real record under the real key still works: the check is not simply refusing everything
    h.packs.enable(ID).unwrap();
}

#[test]
fn a_record_is_bound_to_version_capabilities_risk_words_and_user() {
    let h = installed("bound");
    h.packs.accept(ID, &Says::yes()).unwrap();
    let text = std::fs::read_to_string(h.packs.pack_dir(ID).join("zumi-pack.json")).unwrap();
    let m = Manifest::parse(&text).unwrap();
    let none = zumi_packs::scope::Grants::default();
    let ok = Binding { manifest: &m, risk_en: RISK, risk_vi: "Mot cau rui ro cu the.", sid: SID, grants: &none };
    assert_eq!(verify_consent(&ok, &h.packs.state_dir(ID), &KEY), Ok(()), "the same pack, words and user");
    let v2 = Manifest::parse(&text.replace("\"version\":\"1.0.0\"", "\"version\":\"1.0.1\"")).unwrap();
    assert_eq!(verify_consent(&Binding { manifest: &v2, ..ok_clone(&ok) }, &h.packs.state_dir(ID), &KEY), Err("consent_stale"), "a new version asks again");
    let wider = Manifest::parse(&text.replace("[18800]", "[18800,18801]")).unwrap();
    assert_eq!(verify_consent(&Binding { manifest: &wider, ..ok_clone(&ok) }, &h.packs.state_dir(ID), &KEY), Err("consent_stale"), "a wider scope asks again");
    let extra = Manifest::parse(&text.replace("\"capabilities\":[", "\"capabilities\":[{\"id\":\"screen.capture\",\"scope\":{}},")).unwrap();
    assert_eq!(verify_consent(&Binding { manifest: &extra, ..ok_clone(&ok) }, &h.packs.state_dir(ID), &KEY), Err("consent_stale"), "a new capability asks again");
    assert_eq!(verify_consent(&Binding { risk_en: "Another risk text.", ..ok_clone(&ok) }, &h.packs.state_dir(ID), &KEY), Err("consent_stale"), "other risk words ask again");
    assert_eq!(verify_consent(&Binding { sid: "S-1-5-21-9-9-9-1002", ..ok_clone(&ok) }, &h.packs.state_dir(ID), &KEY), Err("consent_stale"), "another Windows user asks again");
    let lan = zumi_packs::scope::Grants { lan: true, ..Default::default() };
    assert_eq!(verify_consent(&Binding { grants: &lan, ..ok_clone(&ok) }, &h.packs.state_dir(ID), &KEY), Err("consent_stale"), "other grants ask again");
    assert_eq!(verify_consent(&ok, &h.packs.state_dir(ID), &[]), Err("consent_invalid"), "no key never verifies");
    assert_eq!(risk_text_sha256("a", "b"), risk_text_sha256("a", "b"));
    assert_ne!(risk_text_sha256("a", "bc"), risk_text_sha256("ab", "c"));
}

fn ok_clone<'a>(b: &Binding<'a>) -> Binding<'a> {
    Binding { manifest: b.manifest, risk_en: b.risk_en, risk_vi: b.risk_vi, sid: b.sid, grants: b.grants }
}

#[test]
fn a_helper_cannot_answer_the_window_or_write_its_own_consent() {
    let h = host("helper-answer", json!([{ "id": "fs.write", "scope": { "roots": ["pack-data"] } }, { "id": "fs.read", "scope": { "roots": ["pack-data"] } }]));
    h.packs.install(&h.src).unwrap();
    h.packs.accept(ID, &Says::yes()).unwrap();
    h.packs.enable(ID).unwrap();
    let before = std::fs::read(consent_file(&h)).unwrap();
    let b = h.packs.broker();
    // there is no request that accepts, enables, installs or widens anything
    for op in ["accept", "consent", "enable", "install", "grant", "set_grants", "register", "uninstall", "kill"] {
        let reply: serde_json::Value = serde_json::from_str(&b.request(ID, &json!({ "op": op, "pack": ID }).to_string())).unwrap();
        assert_eq!((reply["ok"].clone(), reply["code"].as_str()), (json!(false), Some("bad_request")), "op {op}");
    }
    // the consent and grants files sit one level above the only folder a helper can name
    let state = h.packs.state_dir(ID);
    for target in [state.join(CONSENT_FILE), state.join("grants.json"), state.join("data").join("..").join(CONSENT_FILE)] {
        let reply: serde_json::Value = serde_json::from_str(&b.request(ID, &json!({ "op": "write", "path": target.to_string_lossy(), "text": "{}" }).to_string())).unwrap();
        assert_eq!(reply["ok"], false, "write to {target:?}");
        let reply: serde_json::Value = serde_json::from_str(&b.request(ID, &json!({ "op": "read", "path": target.to_string_lossy() }).to_string())).unwrap();
        assert_eq!(reply["ok"], false, "read of {target:?}");
    }
    assert_eq!(std::fs::read(consent_file(&h)).unwrap(), before, "the consent file is byte for byte what the window made");
    assert!(!state.join("grants.json").exists());
}

#[test]
fn install_takes_only_a_pinned_pack_whole_and_changes_nothing_on_a_refusal() {
    let root = unique("install");
    let (src, entry) = make_pack(&root.join("src"), "1.0.0", spawn_caps(), b"MZ-helper", RISK);
    let data = root.join("data");
    // a catalog that does not list it
    let empty = Packs::with_sid(&data, &KEY, Catalog::compiled(), SID.to_string()).unwrap();
    assert_eq!(empty.install(&src), Err("not_in_catalog".to_string()));
    assert!(!data.join("packs").join(ID).exists());
    let packs = Packs::with_sid(&data, &KEY, Catalog(vec![entry.clone()]), SID.to_string()).unwrap();
    // an edited helper (hash differs from the manifest)
    std::fs::write(src.join("bin").join("zumi-pack-canary.exe"), b"MZ-helpeR").unwrap();
    assert_eq!(packs.install(&src), Err("files_sha".to_string()));
    std::fs::write(src.join("bin").join("zumi-pack-canary.exe"), b"MZ-helper").unwrap();
    // an extra file that the manifest does not list
    std::fs::write(src.join("extra.dll"), b"x").unwrap();
    assert_eq!(packs.install(&src), Err("files_unlisted".to_string()));
    std::fs::remove_file(src.join("extra.dll")).unwrap();
    // a manifest that was edited after the catalog pinned it
    let text = std::fs::read_to_string(src.join("zumi-pack.json")).unwrap();
    std::fs::write(src.join("zumi-pack.json"), text.replace("loopback", "lan")).unwrap();
    assert_eq!(packs.install(&src), Err("not_in_catalog".to_string()));
    std::fs::write(src.join("zumi-pack.json"), &text).unwrap();
    assert!(!data.join("packs").join(ID).exists(), "nothing was installed by a refusal");
    packs.install(&src).unwrap();
    assert_eq!(packs.install(&src), Err("already_installed".to_string()));
    assert!(!packs.is_enabled(ID), "installed is not enabled: the helper cannot run");
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn a_withdrawn_pack_cannot_be_accepted_or_enabled() {
    let h = installed("withdrawn");
    h.packs.accept(ID, &Says::yes()).unwrap();
    let gone = Packs::with_sid(&h.root.join("data"), &KEY, Catalog::compiled(), SID.to_string()).unwrap();
    assert_eq!(gone.enable(ID), Err("withdrawn".to_string()));
    assert_eq!(gone.accept(ID, &Says::yes()), Err("withdrawn".to_string()));
}

#[test]
fn an_installed_helper_that_was_changed_on_disk_does_not_enable() {
    let h = installed("tamper");
    h.packs.accept(ID, &Says::yes()).unwrap();
    std::fs::write(h.packs.pack_dir(ID).join("bin").join("zumi-pack-canary.exe"), b"MZ-not-a-real-exE").unwrap();
    assert_eq!(h.packs.enable(ID), Err("files_sha".to_string()));
    assert!(!h.packs.is_enabled(ID));
}

/// R7c (re-gate R7b S-B): "data leaves this PC only to the places listed" is said only for a pack whose helper is CONTAINED (an
/// AppContainer: no files of the user's, no network, so the broker really is its only door). A helper that needs the user's desktop or
/// devices runs its own code outside that, and R7d says plainly what such a helper can reach (gate R7c section 7), in three languages.
#[test]
fn only_a_contained_helper_may_be_told_that_data_leaves_only_to_the_places_listed() {
    let words = |caps: serde_json::Value| {
        let m = Manifest::parse(&manifest_text(caps)).unwrap();
        (m.helper_contained(), zumi_packs::consent::consent_text(&m, "r", "r", &zumi_packs::scope::Grants::default()), zumi_packs::consent::consent_text_zh(&m, &zumi_packs::scope::Grants::default()))
    };
    let (contained, (en, vi), zh) = words(json!([{ "id": "fs.read", "scope": { "roots": ["pack-data"] } }, { "id": "net.egress", "scope": { "origins": "user-added" } }]));
    assert!(contained && en.contains("Data leaves this PC only to the places listed above.") && vi.contains("Dữ liệu chỉ rời máy này tới những nơi liệt kê ở trên."));
    assert!(zh.contains("数据只会发送到上面列出的位置。") && !zh.contains("没有被隔离"), "{zh}");
    assert!(!en.contains("not boxed in") && !vi.contains("không bị nhốt"), "a contained helper is not told it is loose");
    // the mouse-and-keyboard helper runs as the user: it reads AND changes files, uses the network, and controls the mouse and keyboard
    let (contained, (en, vi), zh) = words(json!([{ "id": "input.inject", "scope": {} }]));
    assert!(!contained);
    assert!(en.contains("not boxed in") && en.contains("read and change your files, use the network, and control the mouse and keyboard"), "{en}");
    assert!(vi.contains("không bị nhốt") && vi.contains("đọc và sửa tệp của anh, dùng mạng, và điều khiển chuột, bàn phím"), "{vi}");
    assert!(zh.contains("没有被隔离") && zh.contains("读取和修改你的文件、使用网络，并控制鼠标和键盘"), "{zh}");
    // the others run at Low: they read the user's files and use the network (measured), and do not change files or control input
    for cap in ["screen.capture", "audio.capture", "device.usb"] {
        let (contained, (en, vi), zh) = words(json!([{ "id": cap, "scope": {} }]));
        assert!(!contained, "{cap}");
        assert!(!en.contains("Data leaves this PC only to") && en.contains("not boxed in") && en.contains("read your files and use the network"), "{cap}: {en}");
        assert!(!en.contains("change your files") && !en.contains("mouse"), "{cap}: Low must not be said to change files or control input: {en}");
        assert!(!vi.contains("chỉ rời máy này") && vi.contains("đọc tệp của anh và dùng mạng") && !vi.contains("điều khiển chuột"), "{cap}: {vi}");
        assert!(zh.contains("读取你的文件并使用网络") && !zh.contains("修改你的文件") && !zh.contains("没有被隔离。它无需询问 Zumi，就可以读取和修改"), "{cap}: {zh}");
    }
    // a pack that also starts programs keeps that way out in the sentence, and the helper sentence follows it
    let (_, (en, _), zh) = words(json!([{ "id": "input.inject", "scope": {} }, { "id": "proc.spawn", "scope": { "programs": ["ping"], "cwd": "workspace", "shell": false } }]));
    assert!(en.contains("through the programs it starts, not only to the places listed above. The pack's own helper program is not boxed in."), "{en}");
    assert!(zh.contains("数据可能经由它运行的程序离开这台电脑，而不只是发送到上面列出的位置。该包自带的辅助程序没有被隔离。"), "{zh}");
}

/// RC1 gate (consent footer): "You can stop it at any time and remove it; removing deletes everything it stored" is true only when the helper is boxed in.
/// A helper that is not boxed in (it runs as the user, or at Low integrity with the user's files and the network) can escape a stop (the gate's WMI
/// example) and can write anywhere the user can, so the footer must not promise either. A contained helper keeps the plain promise.
#[test]
fn the_footer_does_not_promise_a_clean_stop_and_removal_for_a_helper_that_is_not_boxed_in() {
    let promise_en = "You can stop it at any time and remove it; removing deletes everything it stored.";
    let promise_vi = "Anh có thể dừng bất cứ lúc nào và gỡ ra; gỡ sẽ xóa mọi thứ gói đã lưu.";
    let promise_zh = "你可以随时停止并移除它；移除会删除它保存的所有内容。";
    let words = |caps: serde_json::Value| {
        let m = Manifest::parse(&manifest_text(caps)).unwrap();
        let g = zumi_packs::scope::Grants::default();
        let (en, vi) = zumi_packs::consent::consent_text(&m, "r", "r", &g);
        (m.helper_contained(), en, vi, zumi_packs::consent::consent_text_zh(&m, &g))
    };
    let (contained, en, vi, zh) = words(json!([{ "id": "fs.read", "scope": { "roots": ["pack-data"] } }]));
    assert!(contained && en.contains(promise_en) && vi.contains(promise_vi) && zh.contains(promise_zh), "a boxed-in helper keeps the plain promise: {en}");
    for cap in ["input.inject", "screen.capture", "audio.capture", "device.usb"] {
        let (contained, en, vi, zh) = words(json!([{ "id": cap, "scope": {} }]));
        assert!(!contained, "{cap}");
        assert!(!en.contains(promise_en) && !en.contains("at any time") && !en.contains("deletes everything it stored"), "{cap}: the footer still promises a clean stop and removal: {en}");
        assert!(!vi.contains(promise_vi) && !vi.contains("gỡ sẽ xóa mọi thứ gói đã lưu"), "{cap}: {vi}");
        assert!(!zh.contains(promise_zh) && !zh.contains("移除会删除它保存的所有内容"), "{cap}: {zh}");
        assert!(en.contains("You can ask Zumi to stop it and remove it.") && en.contains("cannot promise that it stops for good or that removing deletes everything it saved or wrote"), "{cap}: {en}");
        assert!(vi.contains("Anh có thể yêu cầu Zumi dừng và gỡ gói.") && vi.contains("Zumi không thể hứa rằng nó dừng hẳn"), "{cap}: {vi}");
        assert!(zh.contains("你可以让 Zumi 停止并移除它。") && zh.contains("Zumi 无法保证它会彻底停止"), "{cap}: {zh}");
    }
}

/// The window carries the Chinese text after the English and the Vietnamese, and the same facts (the list, the grants, the risk level).
#[test]
fn the_window_also_shows_the_text_in_chinese() {
    let h = installed("zh");
    let dialog = Says::yes();
    assert_eq!(h.packs.accept(ID, &dialog), Ok(true));
    let text = dialog.1.borrow()[0].1.clone();
    let zh = text.split("

---

").nth(2).unwrap_or_else(|| panic!("no third section: {text}")).to_string();
    for line in ["可以在这台电脑上运行程序：hostname", "可以读取这些位置的文件：pack-data", "端口 18800", "仅限这台电脑上的程序", "风险等级：HIGH", "风险由你自己承担"] {
        assert!(zh.contains(line), "missing {line:?} in {zh}");
    }
}

/// Live gate C1 (20-11): the same footer promise was still made to a pack that is boxed in by its helper but starts programs (`proc.spawn`: a
/// program it starts can do anything the user can, outlive a stop and write anywhere) or writes outside its own folder (`fs.write` on a
/// workspace or a folder the person picked: removing the pack does not delete those files). The plain promise is made only when the pack's
/// helper is boxed in, it starts nothing and writes only in `pack-data`; every other pack gets the sentence that says what Zumi cannot promise.
#[test]
fn the_footer_does_not_promise_a_clean_stop_and_removal_to_a_pack_that_starts_programs_or_writes_outside_its_own_folder() {
    let promise_en = "You can stop it at any time and remove it; removing deletes everything it stored.";
    let promise_vi = "Anh có thể dừng bất cứ lúc nào và gỡ ra; gỡ sẽ xóa mọi thứ gói đã lưu.";
    let promise_zh = "你可以随时停止并移除它；移除会删除它保存的所有内容。";
    let words = |caps: serde_json::Value| {
        let m = Manifest::parse(&manifest_text(caps)).unwrap();
        let g = zumi_packs::scope::Grants::default();
        let (en, vi) = zumi_packs::consent::consent_text(&m, "r", "r", &g);
        (en, vi, zumi_packs::consent::consent_text_zh(&m, &g))
    };
    // CONTROL: contained, starts nothing, writes only in its own folder: the promise is true and stays
    let (en, vi, zh) = words(json!([{ "id": "fs.write", "scope": { "roots": ["pack-data"] } }]));
    assert!(en.contains(promise_en) && vi.contains(promise_vi) && zh.contains(promise_zh), "a pack that writes only in pack-data keeps the plain promise: {en}");
    for (name, caps) in [
        ("proc.spawn", json!([{ "id": "proc.spawn", "scope": { "programs": ["ping"], "cwd": "workspace", "shell": false } }])),
        ("proc.spawn with a shell", json!([{ "id": "proc.spawn", "scope": { "programs": ["cmd"], "cwd": "workspace", "shell": true } }])),
        ("fs.write on the workspace", json!([{ "id": "fs.write", "scope": { "roots": ["workspace"] } }])),
        ("fs.write on pack-data and a user folder", json!([{ "id": "fs.write", "scope": { "roots": ["pack-data", "user-chosen"] } }])),
    ] {
        let (en, vi, zh) = words(caps);
        assert!(!en.contains(promise_en) && !en.contains("at any time") && !en.contains("deletes everything it stored"), "{name}: the footer still promises a clean stop and removal: {en}");
        assert!(!vi.contains(promise_vi) && !vi.contains("gỡ sẽ xóa mọi thứ gói đã lưu"), "{name}: {vi}");
        assert!(!zh.contains(promise_zh) && !zh.contains("移除会删除它保存的所有内容"), "{name}: {zh}");
        assert!(en.contains("You can ask Zumi to stop it and remove it.") && en.contains("cannot promise that it stops for good or that removing deletes everything it saved or wrote"), "{name}: {en}");
        assert!(vi.contains("Anh có thể yêu cầu Zumi dừng và gỡ gói.") && vi.contains("Zumi không thể hứa rằng nó dừng hẳn"), "{name}: {vi}");
        assert!(zh.contains("你可以让 Zumi 停止并移除它。") && zh.contains("Zumi 无法保证它会彻底停止"), "{name}: {zh}");
    }
}
