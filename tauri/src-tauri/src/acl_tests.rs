// Gate 11 changes 1 and 6: tests on the RESOLVED ACL of the real compiled context (tauri-build resolved capabilities/*.json
// + permissions into it). They assert what tauri's RuntimeAuthority actually answers, not the literal permission strings
// in the JSON, so a grant smuggled in through a permission set (mutant N3) or a window match (change 6) is caught.
// No webview and no mock runtime: `resolve_access` is a pure lookup on the context's authority.
use tauri::ipc::Origin;
use tauri::Url;

fn remote() -> Origin {
    Origin::Remote { url: "http://127.0.0.1:4212/".parse::<Url>().unwrap() }
}

#[test]
fn the_removed_wardrobe_bridge_resolves_for_no_webview_at_any_origin() {
    // 0.3.0-alpha.11: capabilities/wardrobe.json and the zumi_host_apply command are gone. The resolved ACL must answer
    // None for it everywhere, the old wardrobe guest label on its old loopback origin included; that label also gets
    // none of the app's commands.
    let mut ctx = crate::app_context();
    let auth = ctx.runtime_authority_mut();
    let off_loopback = || Origin::Remote { url: "https://example.org/".parse::<Url>().unwrap() };
    for label in ["main", "guest-board-0", "guest-wardrobe-0"] {
        for origin in [Origin::Local, remote(), off_loopback()] {
            assert!(auth.resolve_access("zumi_host_apply", "main", label, &origin).is_none(), "{label} must not resolve the removed bridge");
        }
    }
    for other in ["rpc", "guest_open", "guest_navigate", "guest_bounds", "guest_close"] {
        assert!(auth.resolve_access(other, "main", "guest-wardrobe-0", &remote()).is_none(), "the old wardrobe label must not resolve {other}");
    }
}

#[test]
fn the_main_webview_keeps_its_commands_and_no_guest_inherits_them() {
    let mut ctx = crate::app_context();
    let auth = ctx.runtime_authority_mut();
    // Parity 12-2: the shipped context is a NORMAL launch. It must hold no grant for the CDP self-test command; the
    // grant is added at runtime only for a self-test launch (capabilities-selftest/selftest.json).
    assert!(crate::guest_cdp::selftest_capability(&crate::guest_cdp::SelfTest::default()).is_none(),
        "a normal launch must not produce the self-test capability document");
    assert!(auth.resolve_access("guest_cdp", "main", "main", &Origin::Local).is_none(),
        "a normal launch must not resolve the CDP self-test command");
    assert!(auth.resolve_access("guest_cdp", "main", "guest-board-0", &Origin::Local).is_none());
    assert!(auth.resolve_access("guest_cdp", "main", "guest-wardrobe-0", &remote()).is_none());
    // Positive controls first: a None below must mean "denied", not "the lookup is broken".
    for cmd in ["rpc", "guest_open", "guest_navigate", "guest_bounds", "guest_close", "plugin:event|listen", "plugin:event|emit"] {
        assert!(auth.resolve_access(cmd, "main", "main", &Origin::Local).is_some(), "main must resolve {cmd}");
    }
    // Every guest is a child webview of window `main`: a window-label match would hand them main's grants, core:default's
    // event emit/listen included, on a local URL (gate 11 change 6).
    for guest in ["guest-board-0", "guest-board-7", "guest-wardrobe-0", "guest-wardrobe-9"] {
        for origin in [Origin::Local, remote()] {
            for cmd in ["rpc", "guest_open", "guest_navigate", "guest_bounds", "guest_close", "plugin:event|listen", "plugin:event|emit", "plugin:event|emit_to", "plugin:event|unlisten"] {
                assert!(auth.resolve_access(cmd, "main", guest, &origin).is_none(), "{guest} ({origin}) must not resolve {cmd}");
            }
        }
    }
}

/// The self-test capability exactly as `setup` adds it, resolved by the real RuntimeAuthority.
#[test]
fn the_selftest_capability_grants_guest_cdp_only_to_the_local_main_webview() {
    let mode = crate::guest_cdp::SelfTest::from_args(&[
        "--selftest".to_string(),
        "D:/run".to_string(),
    ]);
    let capability = crate::guest_cdp::selftest_capability(&mode).expect("a self-test launch must hand over the capability");
    let mut ctx = crate::app_context();
    ctx.runtime_authority_mut().add_capability(capability).expect("the capability document must resolve");
    let auth = ctx.runtime_authority_mut();
    // The one grant: main, local origin.
    assert!(auth.resolve_access("guest_cdp", "main", "main", &Origin::Local).is_some(),
        "the main webview at a local origin must resolve guest_cdp in a self-test launch");
    // Same webview on a remote origin gets nothing.
    assert!(auth.resolve_access("guest_cdp", "main", "main", &remote()).is_none(),
        "a remote origin on main must not resolve guest_cdp");
    // No guest inherits it, local or remote (catches a `windows:[main]` or `webviews:[*]` scope).
    for guest in ["guest-board-0", "guest-board-7", "guest-wardrobe-0", "guest-wardrobe-9"] {
        for origin in [Origin::Local, remote()] {
            assert!(auth.resolve_access("guest_cdp", "main", guest, &origin).is_none(),
                "{guest} ({origin}) must not resolve guest_cdp");
        }
    }
    // The grant is exactly the one command; it does not widen any guest's existing surface.
    for guest in ["guest-board-0", "guest-wardrobe-0"] {
        for cmd in ["rpc", "guest_open", "guest_navigate", "guest_bounds", "guest_close"] {
            assert!(auth.resolve_access(cmd, "main", guest, &Origin::Local).is_none(),
                "{guest} must still not resolve {cmd}");
        }
    }
}

// Parity (25-10, Electron ab66e9b/05bf103): "Về model mặc định" is the rpc method `restoreDefaultModel` (models:restore-default).
// It is served through `rpc`, which only the MAIN webview resolves; no guest (board or wardrobe) may call rpc, so none may restore.
#[test]
fn restore_default_model_is_main_webview_only() {
    use crate::rpc_allow_list::{ALLOWED_METHODS, GUEST_ONLY_METHODS};
    assert!(ALLOWED_METHODS.contains(&"restoreDefaultModel"), "the main renderer's allow-list must serve restoreDefaultModel");
    assert!(!GUEST_ONLY_METHODS.contains(&"restoreDefaultModel"), "it is not a guest bridge name");
    let mut ctx = crate::app_context();
    let auth = ctx.runtime_authority_mut();
    // positive control: main resolves rpc, so a None below means denied, not a broken lookup
    assert!(auth.resolve_access("rpc", "main", "main", &Origin::Local).is_some(), "main must resolve rpc (restoreDefaultModel rides on it)");
    for guest in ["guest-board-0", "guest-board-7", "guest-wardrobe-0"] {
        for origin in [Origin::Local, remote()] {
            assert!(auth.resolve_access("rpc", "main", guest, &origin).is_none(), "{guest} must not reach rpc, so it cannot call restoreDefaultModel");
        }
    }
}

// P3-B (owner live board): the board guest loads the loopback bridge page at an EPHEMERAL port. Its capability set stays empty:
// `rpc` is the only door to board.liveOpen / board.signOut / restoreDefaultModel / talk.voiceWarm, and no guest label resolves
// it at any origin, local or the live bridge's. The host-only sidecar methods the open path uses are not rpc names at all.
#[test]
fn the_live_board_guest_resolves_no_command_so_it_cannot_call_any_rpc_method() {
    use crate::rpc_allow_list::{ALLOWED_METHODS, GUEST_ONLY_METHODS};
    let live_bridge = || Origin::Remote { url: "http://127.0.0.1:50321/".parse::<Url>().unwrap() };
    let mut ctx = crate::app_context();
    let auth = ctx.runtime_authority_mut();
    // Positive controls: these methods exist on the main renderer's allow-list and main resolves the command that carries them.
    for method in ["board.liveOpen", "restoreDefaultModel", "board.signOut", "talk.voiceWarm"] {
        assert!(ALLOWED_METHODS.contains(&method), "{method} is a main-renderer rpc method");
        assert!(!GUEST_ONLY_METHODS.contains(&method), "{method} is not a guest bridge name");
    }
    assert!(auth.resolve_access("rpc", "main", "main", &Origin::Local).is_some(), "main resolves rpc (positive control)");
    // No command at all for any board guest (the first guest and a later one), at any origin the bridge can serve from.
    let commands = [
        "rpc", "guest_open", "guest_navigate", "guest_bounds", "guest_close", "zumi_host_apply", "guest_cdp",
        "plugin:event|listen", "plugin:event|emit", "plugin:event|emit_to", "plugin:event|unlisten",
        "plugin:webview|webview_close", "plugin:window|close", "plugin:app|version",
    ];
    for guest in ["guest-board-0", "guest-board-1", "guest-board-42"] {
        for origin in [Origin::Local, remote(), live_bridge()] {
            for cmd in commands {
                assert!(auth.resolve_access(cmd, "main", guest, &origin).is_none(), "{guest} ({origin}) must not resolve {cmd}");
            }
        }
    }
}

fn the_open_path_host_methods_are_not_rpc_names() {
    use crate::rpc_allow_list::{ALLOWED_METHODS, GUEST_ONLY_METHODS};
    for name in ["__host.boardOpenVerdict", "__host.decideExternalUrl", "__host.guestDecide", "__host.logRefusal"] {
        assert!(!ALLOWED_METHODS.contains(&name), "{name} must not be callable through the renderer's rpc");
        assert!(!GUEST_ONLY_METHODS.contains(&name), "{name} must not be a guest bridge name");
    }
}

// P3-C (CoS-approved 4 methods): the one-time "Import from Zumi 0.2.9". Each method is served through `rpc`, which only the
// MAIN webview resolves; the board and wardrobe guests hold no `rpc` grant at any origin, so none of them can call it. One
// test per method (each also checks the generated allow-list serves it to main and does not name it as a guest bridge).
fn import_method_is_main_webview_only(method: &str) {
    use crate::rpc_allow_list::{ALLOWED_METHODS, GUEST_ONLY_METHODS};
    assert!(ALLOWED_METHODS.contains(&method), "{method}: the main renderer's allow-list must serve it");
    assert!(!GUEST_ONLY_METHODS.contains(&method), "{method}: not a guest bridge name");
    let mut ctx = crate::app_context();
    let auth = ctx.runtime_authority_mut();
    assert!(auth.resolve_access("rpc", "main", "main", &Origin::Local).is_some(), "positive control: main resolves rpc ({method} rides on it)");
    for guest in ["guest-board-0", "guest-board-7", "guest-wardrobe-0", "guest-wardrobe-9"] {
        for origin in [Origin::Local, remote()] {
            assert!(auth.resolve_access("rpc", "main", guest, &origin).is_none(), "{guest} ({origin}) must not reach rpc, so it cannot call {method}");
        }
    }
}

#[test]
#[allow(non_snake_case)] // named after the rpc method, as scripts/check-tauri-profile-import.mjs expects
fn settings_importDetect_is_main_webview_only() { import_method_is_main_webview_only("settings.importDetect"); }

#[test]
#[allow(non_snake_case)] // named after the rpc method, as scripts/check-tauri-profile-import.mjs expects
fn settings_importPlan_is_main_webview_only() { import_method_is_main_webview_only("settings.importPlan"); }

#[test]
#[allow(non_snake_case)] // named after the rpc method, as scripts/check-tauri-profile-import.mjs expects
fn settings_importApply_is_main_webview_only() { import_method_is_main_webview_only("settings.importApply"); }

#[test]
#[allow(non_snake_case)] // named after the rpc method, as scripts/check-tauri-profile-import.mjs expects
fn settings_importDismiss_is_main_webview_only() { import_method_is_main_webview_only("settings.importDismiss"); }
