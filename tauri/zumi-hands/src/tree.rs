//! The plain-Rust shape of one UI Automation element as the walk saw it. No COM types here, so pruning and ids
//! (prune.rs) are testable without a live window.
use serde_json::{json, Value};

#[derive(Debug, Clone, Default)]
pub struct Node {
    /// UIA control type id (UIA_*ControlTypeId, 50000..50040).
    pub control_type: i32,
    pub name: String,
    pub automation_id: String,
    pub class_name: String,
    /// Screen pixels, physical: [left, top, right, bottom]. All zero when UIA reports no rectangle.
    pub rect: [i32; 4],
    pub offscreen: bool,
    pub enabled: bool,
    pub focusable: bool,
    pub password: bool,
    /// The text an Edit or Document holds (UIA Value pattern), read with the tree: what the model needs to see what the window
    /// says. Empty for every other role and for a password field (never read), and capped when read (uia.rs `VALUE_READ_CHARS`).
    pub value: String,
    /// UIA RuntimeId: unique among live elements, valid for the element's lifetime. Empty when unknown. Used only
    /// to find an element of the cache again when an event names it; never as the model-facing id.
    pub runtime_id: Vec<i32>,
    /// Control-pattern state where the element has the pattern (toggle, expand/collapse, selected, a fingerprint of
    /// the value), as one comparable string (pattern_state). Not shown to the model; rule (b) compares it.
    pub state: String,
    pub children: Vec<Node>,
}

/// The pattern state of one element as a string: only the parts the element supports, the value as a 64-bit FNV
/// fingerprint (the text itself is never kept: it can be what the user typed).
pub fn pattern_state(toggle: Option<i32>, expand: Option<i32>, selected: Option<bool>, value: Option<&str>) -> String {
    let mut parts = Vec::new();
    if let Some(t) = toggle {
        parts.push(format!("toggle={t}"));
    }
    if let Some(x) = expand {
        parts.push(format!("expand={x}"));
    }
    if let Some(b) = selected {
        parts.push(format!("selected={}", u8::from(b)));
    }
    if let Some(v) = value {
        let h = v.bytes().fold(0xcbf2_9ce4_8422_2325u64, |h, b| (h ^ b as u64).wrapping_mul(0x0100_0000_01b3));
        parts.push(format!("value#{h:016x}"));
    }
    parts.join(";")
}

impl Node {
    pub fn role(&self) -> &'static str {
        role_name(self.control_type)
    }

    /// Replaces the node whose runtime id equals `fresh`'s (the node and its whole subtree). False if `fresh` has no
    /// runtime id or no node has it.
    pub fn replace_subtree(&mut self, fresh: Node) -> bool {
        if fresh.runtime_id.is_empty() {
            return false;
        }
        match self.find_mut(&fresh.runtime_id) {
            Some(n) => {
                *n = fresh;
                true
            }
            None => false,
        }
    }

    /// The node with this runtime id, if any.
    pub fn find(&self, rid: &[i32]) -> Option<&Node> {
        if self.runtime_id == rid {
            return Some(self);
        }
        self.children.iter().find_map(|c| c.find(rid))
    }

    fn find_mut(&mut self, rid: &[i32]) -> Option<&mut Node> {
        if self.runtime_id == rid {
            return Some(self);
        }
        self.children.iter_mut().find_map(|c| c.find_mut(rid))
    }

    /// Copies `fresh`'s own properties (not its children) onto the node with the same runtime id. False if none.
    pub fn update_own(&mut self, fresh: &Node) -> bool {
        if fresh.runtime_id.is_empty() {
            return false;
        }
        match self.find_mut(&fresh.runtime_id) {
            Some(n) => {
                let children = std::mem::take(&mut n.children);
                *n = Node { children, ..fresh.clone() };
                true
            }
            None => false,
        }
    }

    /// Removes the node (and its subtree) with this runtime id; never the root itself. False if none.
    pub fn remove(&mut self, rid: &[i32]) -> bool {
        if rid.is_empty() {
            return false;
        }
        if let Some(i) = self.children.iter().position(|c| c.runtime_id == rid) {
            self.children.remove(i);
            return true;
        }
        self.children.iter_mut().any(|c| c.remove(rid))
    }

    /// True if some node of the tree has this runtime id.
    pub fn contains(&self, rid: &[i32]) -> bool {
        self.runtime_id == rid || self.children.iter().any(|c| c.contains(rid))
    }

    pub fn count(&self) -> usize {
        1 + self.children.iter().map(Node::count).sum::<usize>()
    }

    /// Full tree as JSON (the `raw` snapshot form, used for measuring; not what the model sees).
    pub fn to_json(&self) -> Value {
        json!({
            "role": self.role(),
            "name": self.name,
            "aid": self.automation_id,
            "class": self.class_name,
            "rect": self.rect,
            "offscreen": self.offscreen,
            "enabled": self.enabled,
            "focusable": self.focusable,
            "password": self.password,
            "children": self.children.iter().map(Node::to_json).collect::<Vec<_>>(),
        })
    }
}

/// UIA control type id -> short role word. Ids from UIAutomationClient.h (stable since Windows 7).
pub fn role_name(id: i32) -> &'static str {
    const NAMES: [&str; 41] = [
        "Button", "Calendar", "CheckBox", "ComboBox", "Edit", "Hyperlink", "Image", "ListItem", "List", "Menu",
        "MenuBar", "MenuItem", "ProgressBar", "RadioButton", "ScrollBar", "Slider", "Spinner", "StatusBar", "Tab",
        "TabItem", "Text", "ToolBar", "ToolTip", "Tree", "TreeItem", "Custom", "Group", "Thumb", "DataGrid",
        "DataItem", "Document", "SplitButton", "Window", "Pane", "Header", "HeaderItem", "Table", "TitleBar",
        "Separator", "SemanticZoom", "AppBar",
    ];
    usize::try_from(id - 50000).ok().and_then(|i| NAMES.get(i)).copied().unwrap_or("Unknown")
}

/// The name the hands show and compare for an element. Win32 menus (Windows 10 Notepad) give a menu item the accelerator after a
/// tab as part of its UIA name ("Delete\tDel", "Paste\tCtrl+V"), Windows 11's do not: a model that asks for "Delete", and the app's
/// allowlist, name the item without it. Only a menu item, and only what follows its first tab (a tab with nothing before it is
/// not an accelerator and the name stays whole).
pub fn display_name(role: &str, raw: &str) -> String {
    match raw.split_once('\t') {
        Some((name, _accelerator)) if role == "MenuItem" && !name.is_empty() => name.to_string(),
        _ => raw.to_string(),
    }
}

/// Upstream's `SENSITIVE_FIELD` (server/browser/cdp/sensitive.ts), pattern for pattern. `.` is JS's (anything but a line terminator) and the
/// `i` flag is ASCII-only case folding, as in JS without the `u` flag.
const SENSITIVE_FIELD: &str = "(password|passwd|passcode|client.?secret|api.?key|secret.?key|private.?key|signing.?key|webhook.?secret|secret.?access.?key|access.?token|auth.?token|refresh.?token|bearer.?token|one.?time|otp|verification.?code|recovery.?code|seed.?phrase|mnemonic|recovery.?phrase|security.?answer|cc-.+|card.?(number|security|cvv|cvc)|cvv|cvc|bank.?(account|routing)|routing.?(number|code)|account.?(number|no)|social.?(security|insurance)|ssn|tax.?id)";

struct SensitiveRules {
    field: regex::Regex,
    camel: regex::Regex,
    not_alnum: regex::Regex,
    pin_words: regex::Regex,
}

fn sensitive_rules() -> &'static SensitiveRules {
    static CELL: std::sync::OnceLock<SensitiveRules> = std::sync::OnceLock::new();
    CELL.get_or_init(|| {
        let dot = r"[^\n\r\x{2028}\x{2029}]";
        // ASCII case folding first (every letter becomes `[xX]`), then the JS `.`.
        let folded: String = SENSITIVE_FIELD.chars().map(|c| if c.is_ascii_alphabetic() { format!("[{}{}]", c.to_ascii_lowercase(), c.to_ascii_uppercase()) } else { c.to_string() }).collect();
        let pattern = folded.replace(".?", &format!("{dot}?")).replace(".+", &format!("{dot}+"));
        SensitiveRules {
            field: regex::Regex::new(&pattern).expect("sensitive field pattern"),
            camel: regex::Regex::new("([a-z0-9])([A-Z])").expect("camel"),
            not_alnum: regex::Regex::new("[^A-Za-z0-9]+").expect("not alnum"),
            pin_words: regex::Regex::new("(?:^| )(pin|security code)(?: |$)").expect("pin words"),
        }
    })
}

/// Does a field's own name or AutomationId say it holds a secret (a password, a code, a card or account number)? Upstream's browser
/// snapshot (`isSensitiveInput`) never shows the value of such a field; the hands apply the same function to an Edit's text. Same steps
/// in the same order: the hints (the non-empty ones) joined by a space; the field pattern on that text; then the text with camelCase
/// split on ASCII, every other character turned into a space, trimmed and lower-cased, tested for `pin` / `security code` as words.
pub fn sensitive_field(name: &str, automation_id: &str) -> bool {
    let rules = sensitive_rules();
    let raw = [name, automation_id].into_iter().filter(|h| !h.is_empty()).collect::<Vec<_>>().join(" ");
    if rules.field.is_match(&raw) {
        return true;
    }
    let split = rules.camel.replace_all(&raw, "$1 $2");
    let words = rules.not_alnum.replace_all(&split, " ").trim_matches(' ').to_ascii_lowercase();
    rules.pin_words.is_match(&words)
}

/// Is this field a password? An answer is believed. No answer (a provider that does not implement IsPassword) fails closed for a
/// role that holds text: such a field is treated as a password and its text is not read (GATE-OPUS-R4D should-fix 3).
pub fn password_flag(answer: Option<bool>, role: &str) -> bool {
    answer.unwrap_or(matches!(role, "Edit" | "Document"))
}

/// A field whose text is only bullets or asterisks (a masked password box: upstream shows no value for it either).
pub fn only_bullets(text: &str) -> bool {
    let mut seen = false;
    for c in text.chars().filter(|c| !c.is_whitespace()) {
        if !matches!(c, '\u{2022}' | '\u{25cf}' | '*') {
            return false;
        }
        seen = true;
    }
    seen
}

#[cfg(test)]
mod tests {
    use super::*;

    /// R4e: copy of upstream's `isSensitiveInput` (server/browser/cdp/sensitive.ts): a field is named by what it is called.
    #[test]
    fn a_field_named_like_a_secret_is_sensitive_and_an_ordinary_one_is_not() {
        for (name, id) in [
            ("API key", ""), ("", "apiKey"), ("Password", ""), ("Confirm passcode", ""), ("One-time code", ""), ("", "otp_field"), ("Card number", ""),
            ("", "cc-number"), ("CVV", ""), ("Security code", ""), ("PIN", ""), ("Bank account", ""), ("", "routing_number"), ("Social security number", ""),
            ("SSN", ""), ("Client secret", ""), ("Recovery phrase", ""), ("", "accessToken"), ("", "seed_phrase"), ("Tax ID", ""),
        ] {
            assert!(sensitive_field(name, id), "{name:?} / {id:?} must be sensitive");
        }
        for (name, id) in [("Text Editor", ""), ("Search", "search"), ("Business name", ""), ("Pinterest board", ""), ("Spinner", ""), ("Address", "addr"), ("", ""), ("Body", "body")] {
            assert!(!sensitive_field(name, id), "{name:?} / {id:?} is an ordinary field");
        }
    }

    /// R4e (gate should-fix 3): IsPassword that gets no answer fails closed for a field that holds text, and an answer is believed.
    #[test]
    fn an_unanswered_password_flag_counts_as_a_password_for_a_text_field_only() {
        assert!(password_flag(None, "Edit"), "no answer on an Edit: a password");
        assert!(password_flag(None, "Document"), "no answer on a Document: a password");
        assert!(!password_flag(None, "Button"), "a role that never carries a value is not marked");
        assert!(password_flag(Some(true), "Edit"));
        assert!(!password_flag(Some(false), "Edit"), "an answered no is believed");
    }

    #[test]
    fn a_value_that_is_only_bullets_is_a_masked_box() {
        for t in ["\u{2022}\u{2022}\u{2022}\u{2022}", "\u{25cf}\u{25cf}\u{25cf}", "****", "\u{2022} \u{2022} \u{2022}"] {
            assert!(only_bullets(t), "{t:?}");
        }
        for t in ["", "hello", "\u{2022} item one", "*bold*", "a****"] {
            assert!(!only_bullets(t), "{t:?}");
        }
    }

    /// The Edit menu of Windows 10 Notepad (build 10.0.19041, read 19-11 from its menu with GetMenuString): UIA names carry the
    /// accelerator after a tab (the P2 audit of the spare shows `the MenuItem "Paste\tCtrl+V"`).
    const WIN10_EDIT: [(&str, &str); 6] = [("Undo\tCtrl+Z", "Undo"), ("Delete\tDel", "Delete"), ("Find Next\tF3", "Find Next"), ("Select All\tCtrl+A", "Select All"), ("Time/Date\tF5", "Time/Date"), ("Paste\tCtrl+V", "Paste")];

    #[test]
    fn a_menu_item_is_named_without_its_accelerator_so_win10_and_win11_notepad_agree() {
        // T42 (R5 desktop, spare, Windows 10): 0/10, "no Delete in the Edit menu": the item was there, named "Delete\tDel".
        for (raw, shown) in WIN10_EDIT {
            assert_eq!(display_name("MenuItem", raw), shown, "{raw}");
        }
        assert_eq!(display_name("MenuItem", "Delete"), "Delete", "Windows 11 names are as they were");
        assert_eq!(display_name("MenuItem", "Edit"), "Edit");
    }

    #[test]
    fn only_a_menu_item_loses_its_tail_and_only_the_tail_after_the_first_tab() {
        assert_eq!(display_name("Button", "Delete\tDel"), "Delete\tDel", "another control keeps its name whole");
        assert_eq!(display_name("Edit", "a\tb"), "a\tb");
        assert_eq!(display_name("MenuItem", "\tCtrl+Z"), "\tCtrl+Z", "nothing before the tab: not an accelerator, kept");
        assert_eq!(display_name("MenuItem", "Zoom\tCtrl+Plus\tx"), "Zoom", "the first tab ends the name");
        assert_eq!(display_name("MenuItem", ""), "");
    }

    #[test]
    fn pattern_state_names_only_supported_parts_and_never_the_value_text() {
        assert_eq!(pattern_state(None, None, None, None), "");
        assert_eq!(pattern_state(Some(1), None, None, None), "toggle=1");
        assert_eq!(pattern_state(Some(0), Some(2), Some(true), None), "toggle=0;expand=2;selected=1");
        let a = pattern_state(None, None, None, Some("secret text"));
        assert!(a.starts_with("value#") && !a.contains("secret"), "{a}");
        assert_ne!(a, pattern_state(None, None, None, Some("secret texT")), "a different value, a different fingerprint");
    }

    fn leaf(rid: i32, name: &str) -> Node {
        Node { control_type: 50000, name: name.into(), runtime_id: vec![42, rid], ..Default::default() }
    }

    fn tree() -> Node {
        let mut list = leaf(2, "list");
        list.children = vec![leaf(3, "a"), leaf(4, "b")];
        let mut root = leaf(1, "root");
        root.children = vec![list, leaf(5, "ok")];
        root
    }

    fn names(n: &Node) -> Vec<String> {
        let mut v = vec![n.name.clone()];
        for c in &n.children {
            v.extend(names(c));
        }
        v
    }

    #[test]
    fn replace_subtree_swaps_the_matching_branch_only() {
        let mut t = tree();
        let mut fresh = leaf(2, "list");
        fresh.children = vec![leaf(3, "a"), leaf(6, "new"), leaf(4, "b")];
        assert!(t.replace_subtree(fresh));
        assert_eq!(names(&t), ["root", "list", "a", "new", "b", "ok"]);
    }

    #[test]
    fn replace_subtree_refuses_unknown_or_missing_runtime_id() {
        let mut t = tree();
        assert!(!t.replace_subtree(leaf(99, "x")), "unknown id");
        assert!(!t.replace_subtree(Node { name: "no id".into(), ..Default::default() }), "empty id");
        assert_eq!(names(&t), ["root", "list", "a", "b", "ok"], "tree unchanged");
    }

    #[test]
    fn replace_subtree_can_replace_the_root() {
        let mut t = tree();
        assert!(t.replace_subtree(leaf(1, "root2")));
        assert_eq!(names(&t), ["root2"]);
    }

    #[test]
    fn update_own_keeps_children_and_refuses_unknown() {
        let mut t = tree();
        let mut renamed = leaf(2, "renamed list");
        renamed.offscreen = true;
        assert!(t.update_own(&renamed));
        assert_eq!(names(&t), ["root", "renamed list", "a", "b", "ok"]);
        assert!(t.children[0].offscreen);
        assert!(!t.update_own(&leaf(77, "ghost")));
    }

    #[test]
    fn remove_drops_the_matching_branch_and_refuses_root_or_unknown() {
        let mut t = tree();
        assert!(t.remove(&[42, 3]));
        assert_eq!(names(&t), ["root", "list", "b", "ok"]);
        assert!(!t.remove(&[42, 3]), "already gone");
        assert!(!t.remove(&[42, 1]), "the root is never removed");
        assert!(!t.remove(&[]), "empty id");
        assert_eq!(names(&t), ["root", "list", "b", "ok"]);
    }

    #[test]
    fn role_names_cover_the_documented_range() {
        assert_eq!(role_name(50000), "Button");
        assert_eq!(role_name(50004), "Edit");
        assert_eq!(role_name(50037), "TitleBar");
        assert_eq!(role_name(50040), "AppBar");
        assert_eq!(role_name(49999), "Unknown");
        assert_eq!(role_name(50041), "Unknown");
    }

    // R4g: `sensitive_field` is upstream's `isSensitiveInput` ported wholesale (server/browser/cdp/sensitive.ts), not a hand-made
    // approximation. Two gaps of the old one: `secret access` matched without the `key` that upstream's `secret.?access.?key` needs,
    // and the field name was joined with an empty AutomationId by a trailing space (`cc-` plus a space matched `cc-.+`).
    #[test]
    fn r4g_the_two_gaps_of_the_hand_made_port_are_closed() {
        assert!(!sensitive_field("Secret access", ""), "upstream needs `secret.?access.?key`");
        assert!(sensitive_field("Secret access key", ""));
        assert!(!sensitive_field("cc-", ""), "upstream: `cc-.+` needs a character after the dash, and no trailing space is added for an empty id");
        assert!(sensitive_field("cc-x", ""));
        assert!(sensitive_field("", "cc-number"));
        // `isSensitiveInput` splits camelCase on ASCII only and turns every other character into a space: a non-ASCII letter before PIN is a word break.
        assert!(sensitive_field("\u{e9}PIN", ""));
    }

    #[test]
    fn r4g_the_answers_equal_upstreams_over_the_parity_corpus() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!("../tests/data/sensitive-parity.json")).unwrap();
        let cases = fixture["cases"].as_array().unwrap();
        assert!(cases.len() > 1500, "{}", cases.len());
        let (mut yes, mut no) = (0, 0);
        for c in cases {
            let (name, id, want) = (c["n"].as_str().unwrap(), c["id"].as_str().unwrap(), c["s"].as_bool().unwrap());
            assert_eq!(sensitive_field(name, id), want, "{name:?} / {id:?}: upstream says {want}");
            if want {
                yes += 1;
            } else {
                no += 1;
            }
        }
        assert!(yes > 300 && no > 300, "the corpus must have both answers: {yes} / {no}");
    }
}
