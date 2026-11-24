//! What the host does before a hands task: read the files the USER's sentence names, build the helper's policy from
//! them (a launch argument is policy, so the only files the helper will open are the ones the user wrote), and arm
//! the helper. The model has no part in either step.
use crate::hands_tools::{SharedLink, NOTEPAD};
use serde_json::{json, Value};
use std::path::Path;
use std::time::Duration;

/// Absolute drive-letter paths written in the sentence (`D:/work/a.txt`, `C:\x\y.txt`). A path ends at white space or a
/// quote, trailing sentence punctuation is dropped, a path with a `..` part is skipped, and so is one with a space in
/// it (the user quotes nothing the helper could not pass as one argument).
pub fn extract_paths(sentence: &str) -> Vec<String> {
    let chars: Vec<(usize, char)> = sentence.char_indices().collect();
    let mut out: Vec<String> = Vec::new();
    let mut i = 0;
    while i + 2 < chars.len() {
        let (start, c) = chars[i];
        let boundary = i == 0 || !chars[i - 1].1.is_alphanumeric();
        if boundary && c.is_ascii_alphabetic() && chars[i + 1].1 == ':' && matches!(chars[i + 2].1, '/' | '\\') {
            let mut j = i + 3;
            while j < chars.len() && !chars[j].1.is_whitespace() && !matches!(chars[j].1, '\'' | '"' | '<' | '>' | '|' | '*' | '?' | '“' | '”' | '‘' | '’' | '`') {
                j += 1;
            }
            let end = chars.get(j).map_or(sentence.len(), |x| x.0);
            let raw = sentence[start..end].trim_end_matches(['.', ',', ';', ':', ')', ']', '}', '!']);
            let clean = raw.to_string();
            let has_dotdot = clean.split(['/', '\\']).any(|p| p == "..");
            if clean.len() > 3 && !has_dotdot && !out.iter().any(|p| p.eq_ignore_ascii_case(&clean)) {
                out.push(clean);
            }
            i = j;
        } else {
            i += 1;
        }
    }
    out
}

/// The helper's policy for a Notepad task: Notepad only, launch arguments exactly the named files, normal editing in
/// its window. (The same `ui` rule the P2 goals use; file dialogs stay refused: they belong to the Explorer pack.)
pub fn notepad_policy(named_files: &[String]) -> Value {
    let one_of: Vec<Value> = named_files.iter().map(|p| json!([p.replace('/', "\\")])).collect();
    let mut p = json!({
        "apps": [NOTEPAD],
        "ui": { NOTEPAD: {
            "windows": ["Notepad", "#32768"],
            "controls": { "Edit": ["type", "key", "set_value"], "MenuItem": ["expand", "collapse", "invoke"] },
            "whitespace": ["tab", "newline"]
        } }
    });
    if !one_of.is_empty() {
        p["args"] = json!({ NOTEPAD: { "one_of": one_of } });
    }
    p
}

const PAINT: &str = r"C:\Windows\System32\mspaint.exe";
// The same names the helper's built-in Paint rule lists (zumi-hands hands_policy.rs): drawing tools and view settings only.
const PAINT_BUTTONS: &[&str] = &["Pencil", "Fill with color", "Text", "Eraser", "Color picker", "Magnifier", "Undo", "Redo", "Crop", "Zoom in", "Zoom out", "100%"];
const PAINT_SPLIT: &[&str] = &["Select", "Rotate", "Brushes"];
const PAINT_MENU: &[&str] = &["Rotate right 90°", "Rotate left 90°", "Rotate 180°", "Flip vertical", "Flip horizontal", "Rectangular selection", "Free-form selection", "Select all", "Invert selection"];

/// `paint` or `mspaint` as a word of the sentence.
fn names_paint(sentence: &str) -> bool {
    sentence.to_lowercase().split(|c: char| !c.is_alphanumeric()).any(|w| w == "paint" || w == "mspaint")
}

/// R5: the policy for a task: Notepad as before, plus Paint when the sentence names it. Paint gets drawing tools and the
/// `Pointer` control type (the pixel fallback for the drawing surface); no file or system control. Named files ride on Notepad only.
pub fn policy_for(sentence: &str, named_files: &[String]) -> Value {
    let mut p = notepad_policy(named_files);
    if names_paint(sentence) {
        p["apps"] = json!([NOTEPAD, PAINT]);
        p["ui"][PAINT] = json!({
            "windows": ["MSPaintApp", "#32768"],
            "controls": {
                "Button": { "verbs": ["invoke"], "names": PAINT_BUTTONS },
                "SplitButton": { "verbs": ["invoke", "expand", "collapse"], "names": PAINT_SPLIT },
                "TabItem": { "verbs": ["select"], "names": ["Home", "View"] },
                "MenuItem": { "verbs": ["invoke"], "names": PAINT_MENU },
                "CheckBox": { "verbs": ["toggle"], "names": ["Rulers", "Gridlines", "Status bar"] },
                "Pointer": ["click", "drag"]
            }
        });
    }
    p
}

/// Arms the helper: policy, audit file, capture root, dead-man. The host calls this; it is not a tool verb.
pub fn arm(link: &SharedLink, deadman_ms: u64, audit: &Path, policy: &Path, capture_root: &Path) -> Result<(), String> {
    let req = json!({ "cmd": "arm", "deadman-ms": deadman_ms, "audit": audit, "policy": policy, "capture-root": capture_root });
    let resp = link.lock().unwrap_or_else(|p| p.into_inner()).call(req, Duration::from_secs(20))?;
    if resp.get("ok") == Some(&json!(true)) {
        Ok(())
    } else {
        Err(format!("arm refused: {} {}", resp["error"].as_str().unwrap_or("?"), resp["detail"].as_str().unwrap_or("")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_are_read_from_the_sentence_only() {
        let s = "mở Notepad, gõ 'xin chào Zumi', lưu vào D:/work/tmp/p3-out.txt.";
        assert_eq!(extract_paths(s), vec!["D:/work/tmp/p3-out.txt"]);
        assert_eq!(extract_paths(r"save to C:\work\a.txt, then (D:\b\c.md)"), vec![r"C:\work\a.txt", r"D:\b\c.md"]);
        assert!(extract_paths("open notepad and type hello").is_empty());
    }

    #[test]
    fn bite_paths_that_are_not_plain_absolute_files_are_skipped() {
        assert!(extract_paths("save to D:/a/../secret.txt please").is_empty(), "a .. part");
        assert!(extract_paths("see http://example.com/x and file://host/y").is_empty(), "urls are not drive paths");
        assert!(extract_paths("the answer is a:b and c:d").is_empty());
        assert!(extract_paths("D:/").is_empty(), "a bare root");
        assert_eq!(extract_paths("D:/a/x.txt and D:/A/X.TXT").len(), 1, "case-insensitive duplicates collapse");
    }

    #[test]
    fn the_policy_lists_exactly_the_named_files_as_launch_arguments() {
        let p = notepad_policy(&["D:/work/tmp/p3-out.txt".to_string()]);
        assert_eq!(p["apps"], json!([NOTEPAD]));
        assert_eq!(p["args"][NOTEPAD]["one_of"], json!([[r"D:\work\tmp\p3-out.txt"]]));
        assert_eq!(p["ui"][NOTEPAD]["controls"]["Edit"], json!(["type", "key", "set_value"]));
        assert!(notepad_policy(&[]).get("args").is_none(), "no named file: no launch arguments at all");
    }
    #[test]
    fn r5_the_policy_adds_paint_with_its_pointer_rule_only_when_the_sentence_names_paint() {
        const PAINT: &str = r"C:\Windows\System32\mspaint.exe";
        let p = policy_for("mở Paint, chọn Pencil, vẽ một đường thẳng", &[]);
        assert_eq!(p["apps"], json!([NOTEPAD, PAINT]));
        let rule = &p["ui"][PAINT];
        assert_eq!(rule["windows"], json!(["MSPaintApp", "#32768"]));
        assert_eq!(rule["controls"]["Pointer"], json!(["click", "drag"]), "the drawing surface can be pointed at");
        assert_eq!(rule["controls"]["Button"]["verbs"], json!(["invoke"]));
        assert!(rule["controls"]["Button"]["names"].as_array().unwrap().contains(&json!("Pencil")));
        assert!(!rule["controls"]["Button"]["names"].as_array().unwrap().iter().any(|n| n == "Save" || n == "Delete" || n == "Open"), "normal drawing only: no file or system controls");
        assert_eq!(p["ui"][NOTEPAD], notepad_policy(&[])["ui"][NOTEPAD], "Notepad's rule is untouched");
        // Bites: the word must be Paint itself, and nothing else (Notepad's policy has no pointer at all).
        for s in ["open notepad and type hello", "write about paintings in notepad", "mở Notepad, gõ 'sơn tường'"] {
            let q = policy_for(s, &[]);
            assert_eq!(q["apps"], json!([NOTEPAD]), "{s}");
            assert!(q["ui"].get(PAINT).is_none() && !q.to_string().contains("Pointer"), "{s}");
        }
        assert_eq!(policy_for("open Paint", &["D:/a/x.txt".to_string()])["args"][NOTEPAD]["one_of"], json!([[r"D:\a\x.txt"]]), "named files still ride on Notepad only");
    }

}
