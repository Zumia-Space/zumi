//! R7c (re-gate R7b section 6): the HB-2 acceptance for the hands pack (proc.spawn, input.inject) is asked on the private desktop
//! (`zumi_packs::consent::secure_ask`), never by a plain message box on the person's desktop. A process of a pack that may start programs
//! or inject input finds a plain box with FindWindow and presses Yes with BM_CLICK (reviewer n8, n10c); nothing can do that on the private
//! desktop. The live check of the window itself is the unit test `the_acceptance_is_not_a_window_of_the_persons_desktop` in dialog.rs.
use std::path::Path;

#[test]
fn the_hb2_dialog_is_asked_on_the_private_desktop_and_never_by_a_plain_message_box() {
    let text = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("dialog.rs")).unwrap();
    let production = text.split("#[cfg(test)]").next().unwrap();
    assert!(!production.contains("MessageBoxW"), "dialog.rs must not show a plain message box on the person's desktop");
    assert!(production.contains("secure_ask"), "dialog.rs must ask through the private desktop");
}
