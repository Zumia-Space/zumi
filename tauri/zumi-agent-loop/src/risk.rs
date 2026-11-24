//! R5: which labels on a screen call for a person's yes before the hands touch them.
//!
//! The word tables are the reference app's own (`risk_words.rs`, generated from its saved-steps screen-words, 16 interface
//! languages): a label, an ancestor's label or a window title that names a final, can't-undo action (send, delete, buy, pay,
//! post, submit, transfer, publish and their like) is a *final action*; a field labelled password, PIN, code or card number
//! is a *secret field*. Screen text is untrusted data: this module only ever reads it, it never follows it.
use crate::risk_words::{Table, FINAL_ACTIONS, SECRET_FIELDS};
use std::sync::OnceLock;

/// Case, dashes, curly apostrophes, zero-width characters and spacing evened out, the same way for words and labels.
/// (The reference app also folds Unicode compatibility forms (NFKC); screen text from Windows arrives composed, like the tables.)
pub fn fold(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars().flat_map(char::to_lowercase) {
        match c {
            '\u{200b}'..='\u{200d}' | '\u{2060}' | '\u{feff}' | '\u{ad}' | '\u{307}' => {}
            '\u{2018}' | '\u{2019}' | '\u{2b9}' | '\u{2bc}' | '`' | '\u{b4}' => out.push('\''),
            '\u{2010}'..='\u{2015}' | '\u{2212}' | '\u{fe58}' | '\u{fe63}' | '\u{ff0d}' => out.push('-'),
            '\u{131}' => out.push('i'),
            c if c.is_whitespace() => {
                if !out.ends_with(' ') {
                    out.push(' ');
                }
            }
            c => out.push(c),
        }
    }
    out.trim().to_string()
}

/// A letter, digit or combining mark: a word does not continue past one of these on either side.
fn is_edge(c: char) -> bool {
    c.is_alphanumeric() || matches!(c as u32, 0x300..=0x36f | 0x1ab0..=0x1aff | 0x1dc0..=0x1dff | 0x20d0..=0x20ff | 0xfe20..=0xfe2f)
}

/// One table, folded once: exact labels, whole words, word prefixes, and (languages written without spaces) text found anywhere.
struct Compiled {
    exact: Vec<String>,
    whole: Vec<String>,
    starts: Vec<String>,
    inside: Vec<String>,
}

fn compile(table: Table) -> Compiled {
    let mut c = Compiled { exact: vec![], whole: vec![], starts: vec![], inside: vec![] };
    for (_, unspaced, words) in table {
        for w in *words {
            if let Some(e) = w.strip_prefix('=') {
                c.exact.push(fold(e));
            } else if *unspaced {
                c.inside.push(fold(w));
            } else if let Some(p) = w.strip_suffix('*') {
                c.starts.push(fold(p));
            } else {
                c.whole.push(fold(w));
            }
        }
    }
    c
}

fn names(table: &Compiled, text: &str) -> bool {
    let t = fold(text);
    if t.is_empty() {
        return false;
    }
    if table.exact.iter().any(|e| *e == t) || table.inside.iter().any(|w| !w.is_empty() && t.contains(w.as_str())) {
        return true;
    }
    let at_word = |w: &str, prefix: bool| {
        !w.is_empty()
            && t.match_indices(w).any(|(i, m)| {
                let before = t[..i].chars().next_back().is_none_or(|c| !is_edge(c));
                let after = prefix || t[i + m.len()..].chars().next().is_none_or(|c| !is_edge(c));
                before && after
            })
    };
    table.whole.iter().any(|w| at_word(w, false)) || table.starts.iter().any(|w| at_word(w, true))
}

/// True when a label or title names a final, can't-undo action in any language the tables hold.
pub fn names_final_action(text: &str) -> bool {
    static T: OnceLock<Compiled> = OnceLock::new();
    names(T.get_or_init(|| compile(FINAL_ACTIONS)), text)
}

/// True when a field's label says it holds a password, PIN, code or card number in any language the tables hold.
pub fn names_secret(text: &str) -> bool {
    static T: OnceLock<Compiled> = OnceLock::new();
    names(T.get_or_init(|| compile(SECRET_FIELDS)), text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn final_actions_are_named_in_english_vietnamese_and_other_shipped_languages() {
        for label in ["Delete", "delete", "Send", "Send message", "Buy now", "Pay", "Place your order", "Submit", "Publish", "Move to bin", "Uninstall", "Restart", "Transfer"] {
            assert!(names_final_action(label), "{label}");
        }
        for label in ["Xóa", "Gửi", "Gửi tin nhắn", "Thanh toán", "Đặt hàng", "Xác nhận", "Chuyển tiền", "Không lưu", "Khởi động lại", "Đăng bài"] {
            assert!(names_final_action(label), "{label}");
        }
        for label in ["Löschen", "Enviar", "Supprimer", "Eliminar", "Удалить", "删除", "削除", "삭제", "वो भेजें"] {
            assert!(names_final_action(label), "{label}");
        }
    }

    #[test]
    fn bite_ordinary_labels_are_not_final_actions_and_a_word_inside_another_word_does_not_count() {
        for label in ["File", "Edit", "Save", "Save As", "Open", "Undo", "Select All", "Word Wrap", "Pencil", "Text Editor", "Lưu", "Mở", "Chỉnh sửa", "Sender info", "Postscript", "Deleted items", "Resent", ""] {
            assert!(!names_final_action(label), "{label:?} is not a final action");
        }
    }

    #[test]
    fn a_title_or_label_is_read_case_and_punctuation_insensitively_and_an_exact_marker_matches_only_the_whole_label() {
        assert!(names_final_action("  DELETE\u{a0}file? "));
        assert!(names_final_action("Don\u{2019}t save"), "a curly apostrophe is a plain one");
        assert!(names_final_action("Do not save"));
        // `=đăng` is the exact word (the label is only that): "Đăng nhập" (sign in) must not count as "post".
        assert!(names_final_action("Đăng"));
        assert!(!names_final_action("Đăng nhập"));
        assert!(names_final_action("Đăng bài"));
    }

    #[test]
    fn secret_fields_are_named_by_their_label() {
        for label in ["Password", "Enter your PIN", "Security code", "Card number", "API key", "Mật khẩu", "Số thẻ", "Passwort", "密码"] {
            assert!(names_secret(label), "{label}");
        }
        for label in ["Text Editor", "Name", "Search", "Tên", "Pinned", "Spinner"] {
            assert!(!names_secret(label), "{label:?} is not a secret field");
        }
    }

    #[test]
    fn fold_evens_out_case_dashes_quotes_and_spacing() {
        assert_eq!(fold("  Don\u{2019}t \u{2013} SAVE\t now "), "don't - save now");
    }
}
