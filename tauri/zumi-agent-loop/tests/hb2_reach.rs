//! HB-2, source-level: nothing a model call or the stdio driver reaches may name the acceptance dialog or sign an
//! acceptance. The gate's own deny-list test (tool_gate), the helper's MAC check and the live refusals
//! (scripts/maus-p3-goals.mjs hb2) cover behaviour; this pins the wiring. It walks every file under src/ (so a module added
//! later is covered) and excludes only dialog.rs, the one module that may name these.
use std::path::{Path, PathBuf};

const NEEDLES: [&str; 6] = ["dialog::", "request_acceptance", "WarningDialog", "NativeDialog", "accepted.jsonl", "mac_hex"];

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for e in std::fs::read_dir(dir).unwrap().flatten() {
        let p = e.path();
        if p.is_dir() {
            rust_files(&p, out);
        } else if p.extension().is_some_and(|x| x == "rs") {
            out.push(p);
        }
    }
}

#[test]
fn only_the_dialog_module_names_the_acceptance_dialog_or_signs_a_record() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    rust_files(&src, &mut files);
    let mut checked = 0;
    for f in &files {
        if f.file_name().is_some_and(|n| n == "dialog.rs") {
            continue;
        }
        let text = std::fs::read_to_string(f).unwrap();
        for needle in NEEDLES {
            assert!(!text.contains(needle), "{} names {needle:?}: a tool or the loop could reach the acceptance dialog", f.display());
        }
        checked += 1;
    }
    assert!(checked >= 12, "the walk found only {checked} files");
}

#[test]
fn bite_the_check_does_see_the_dialog_module() {
    // A guard counts only if it has refused a real positive: the dialog module itself names every needle.
    let text = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/dialog.rs")).unwrap();
    for needle in NEEDLES.iter().filter(|n| **n != "dialog::") {
        assert!(text.contains(needle), "{needle}");
    }
}

#[test]
fn bite_a_planted_module_naming_the_dialog_is_caught() {
    // The walk is real: a file that names the dialog is flagged by the same predicate.
    let planted = "fn x() { crate::dialog::request_acceptance(); }";
    assert!(NEEDLES.iter().any(|n| planted.contains(n)));
}
