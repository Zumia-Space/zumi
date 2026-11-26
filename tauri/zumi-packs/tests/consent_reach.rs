//! R7 K0a, source level: the consent window and the record it signs are reachable from the host's own pack manager only. The broker
//! (what a helper's requests reach), the scope check, the manifest reader, the audit and the job object never name the dialog, the signing
//! or the consent file. (HB-2 does the same for the agent loop: tests/hb2_reach.rs in zumi-agent-loop.)
use std::path::{Path, PathBuf};

/// Names that make or answer a consent. Each is allowed in the files listed after it and nowhere else under src/.
const RULES: [(&str, &[&str]); 8] = [
    ("request_consent", &["consent.rs", "packs.rs"]),
    ("ConsentDialog", &["consent.rs", "packs.rs"]),
    ("NativeConsent", &["consent.rs"]),
    // audit.rs signs the audit HEAD (R7b M2) under its OWN key (DPAPI-sealed, `audit::KEY_FILE`); it is never given the host key.
    ("mac_hex", &["consent.rs", "audit.rs"]),
    ("CONSENT_FILE", &["consent.rs"]),
    ("consent.jsonl", &["consent.rs"]),
    ("verify_consent", &["consent.rs", "packs.rs"]),
    ("revoke_consent", &["consent.rs", "packs.rs"]),
];

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

/// The names a file uses outside comments.
fn code_of(text: &str) -> String {
    text.lines().filter(|l| !l.trim_start().starts_with("//")).collect::<Vec<_>>().join("\n")
}

fn violations(files: &[(String, String)]) -> Vec<String> {
    let mut out = Vec::new();
    for (name, text) in files {
        let code = code_of(text);
        for (needle, allowed) in RULES {
            if code.contains(needle) && !allowed.contains(&name.as_str()) {
                out.push(format!("{name} names {needle}"));
            }
        }
    }
    out
}

fn sources() -> Vec<(String, String)> {
    let mut paths = Vec::new();
    rust_files(&Path::new(env!("CARGO_MANIFEST_DIR")).join("src"), &mut paths);
    paths.iter().map(|p| (p.file_name().unwrap().to_string_lossy().into_owned(), std::fs::read_to_string(p).unwrap())).collect()
}

#[test]
fn only_the_consent_module_and_the_pack_manager_name_the_dialog_or_sign_a_record() {
    let files = sources();
    assert!(files.len() >= 8, "the walk found only {} files", files.len());
    assert_eq!(violations(&files), Vec::<String>::new());
}

#[test]
fn bite_the_check_sees_the_modules_that_are_allowed_and_a_planted_leak() {
    let files = sources();
    let consent = &files.iter().find(|(n, _)| n == "consent.rs").unwrap().1;
    for (needle, _) in RULES {
        assert!(consent.contains(needle) || files.iter().any(|(_, t)| t.contains(needle)), "{needle} is named nowhere: the rule checks nothing");
    }
    // a broker that answered the window would be caught
    let planted = vec![("broker.rs".to_string(), "fn answer() { crate::consent::request_consent(d, b, a, s, k); }".to_string())];
    assert_eq!(violations(&planted), vec!["broker.rs names request_consent".to_string()]);
    let signs = vec![("scope.rs".to_string(), "let m = mac_hex(key, &f);".to_string())];
    assert_eq!(violations(&signs), vec!["scope.rs names mac_hex".to_string()]);
}
