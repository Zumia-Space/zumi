//! Keeping secrets out of text that crosses a trust boundary (window text going to the model, the audit log, the run list): a port
//! of the upstream app's `shared/redact.ts` (v0.1.169), rule for rule and in the same order. The log keeps the shape (the name, the
//! length) and loses the value.
//!
//! R4g: this replaces the word-by-word approximation of R4e/R4f, which missed one more shape at every gate (an OAuth fragment, a bare
//! `?key=AIza...`, Bearer inside compact JSON). The patterns are upstream's, translated mechanically:
//!   * JS `\b` is ASCII, so `(?-u:\b)`; JS `\s` is spelled out (`WS`: it includes U+FEFF and not U+0085); the `i` flag is ASCII-only
//!     case folding (`ci`), never Unicode folding (the Kelvin sign is not a `k`);
//!   * the regex crate has no look-ahead: `(?![class])` after a match is a check of the next character (`replace_guarded`; a match that
//!     fails it is skipped and the search resumes one character later, which is what the JS engine does);
//!   * the regex crate has no back-reference: `(["']?)value\3` is three alternatives (double-quoted, single-quoted, bare);
//!   * lengths are UTF-16 code units, as JS `String.length`.
//!
//! TWO extra rules on top of upstream. (1) `DB_CREDENTIAL`: an assignment to a database-credential name (`DB_PASS`, `MYSQL_PWD`,
//! `REDIS_PASS`, `SMTP_PASS` ...) is masked at any value length. Upstream has no `_PASS` / `_PWD` rule, so every other name ending that
//! way (`USER_PWD`, `API_PASS`, `OLD_PWD`, `ENCODER_PASS`) stays visible, as upstream leaves it. (2) `truncated_private_key`: a private-key
//! block with no END line (a clipped window text, a log cut short) is masked after its header; upstream's `PEM_BLOCK` needs the END line
//! and leaks the key body otherwise. The parity test (tests/redact_parity.rs) demands output identical to upstream's over a corpus
//! except where one of these two rules applies.
//!
//! Not a promise to catch every secret a person can type: a password has no shape. The run list and the audit say what they keep.
use regex::{Captures, Regex};
use std::sync::OnceLock;

/// JS `\s`: tab, LF, VT, FF, CR, space, NBSP, U+1680, U+2000-200A, U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF.
const WS: &str = r"\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}";

fn is_js_ws(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `mask`: `«redacted N chars»`; our own marker is returned as it is (re-masking would change its length).
pub fn mask(value: &str) -> String {
    let is_marker = value.strip_prefix("«redacted ").and_then(|r| r.strip_suffix(" chars»")).is_some_and(|d| !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit()));
    if is_marker {
        value.to_string()
    } else {
        format!("«redacted {} chars»", utf16_len(value))
    }
}

/// ASCII case-insensitive spelling of a pattern fragment: every letter becomes `[xX]` (`_ - [ ] ? |` pass through).
fn ci(fragment: &str) -> String {
    fragment.chars().map(|c| if c.is_ascii_alphabetic() { format!("[{}{}]", c.to_ascii_lowercase(), c.to_ascii_uppercase()) } else { c.to_string() }).collect()
}

/// A pattern with its placeholders filled: `<WS>` JS white space, `<B>` ASCII word boundary, `<V>` a value character,
/// `<KW>` the secret-shaped key words, `<KEY>` `key`, `<FLAGS>` the secret flag words, `<AUTH>` `Authorization`, `<BASIC>` `Basic`,
/// `<DB>` / `<PW>` the database-credential name parts.
fn build(pattern: &str) -> Regex {
    let p = pattern
        .replace("<WS>", WS)
        .replace("<B>", r"(?-u:\b)")
        .replace("<V>", r"[A-Za-z0-9._~+/=-]")
        .replace("<KW>", &ci("api[_-]?key|apikey|secret|token|password|passwd|authorization|auth[_-]?token|access[_-]?key|private[_-]?key"))
        .replace("<KEY>", &ci("key"))
        .replace("<FLAGS>", &ci("token|password|passwd|api-key|apikey|secret|access-key|auth-token"))
        .replace("<AUTH>", &ci("Authorization"))
        .replace("<BASIC>", &ci("Basic"))
        .replace("<DB>", &ci("db|database|mysql|postgres|pg|redis|mongo|mongodb|smtp"))
        .replace("<PW>", &ci("pass|pwd"));
    Regex::new(&p).unwrap_or_else(|e| panic!("redact pattern {pattern:?}: {e}"))
}

/// The character class a match must NOT be followed by (upstream's `(?![...])`).
type Guard = Option<fn(char) -> bool>;

fn id_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '-'
}
fn basic_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || "._~+/=-".contains(c)
}

/// JS `text.replace(/re(?![class])/g, f)`: a match followed by a guarded character is no match at that start; the search goes on from
/// the next character.
fn replace_guarded(text: &str, re: &Regex, guard: Guard, f: impl Fn(&Captures) -> String) -> String {
    let mut out = String::with_capacity(text.len());
    let (mut last, mut pos) = (0, 0);
    while pos <= text.len() {
        let Some(caps) = re.captures_at(text, pos) else { break };
        let m = caps.get(0).expect("group 0");
        let blocked = guard.is_some_and(|g| text[m.end()..].chars().next().is_some_and(g));
        if blocked {
            pos = m.start() + text[m.start()..].chars().next().map_or(1, char::len_utf8);
            continue;
        }
        out.push_str(&text[last..m.start()]);
        out.push_str(&f(&caps));
        last = m.end();
        pos = m.end().max(m.start() + 1);
    }
    out.push_str(&text[last..]);
    out
}

/// Does the pattern match anywhere, with its guard (JS `re.test`)?
fn matches_guarded(text: &str, re: &Regex, guard: Guard) -> bool {
    let mut pos = 0;
    while pos <= text.len() {
        let Some(m) = re.find_at(text, pos) else { return false };
        if !guard.is_some_and(|g| text[m.end()..].chars().next().is_some_and(g)) {
            return true;
        }
        pos = m.start() + text[m.start()..].chars().next().map_or(1, char::len_utf8);
    }
    false
}

/// Provider key prefixes, upstream's `KEY_PREFIXES` in its order.
fn key_prefixes() -> &'static [(Regex, Guard)] {
    static CELL: OnceLock<Vec<(Regex, Guard)>> = OnceLock::new();
    CELL.get_or_init(|| {
        let g: Guard = Some(id_char);
        [
            (r"<B>om[dg]_[A-Za-z0-9_-]{43}", g),                                       // desktop device and model-only credentials
            (r"<B>sk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}", None),            // anthropic / openai
            (r"<B>(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}", None),                    // stripe secret and restricted keys
            (r"<B>xai-[A-Za-z0-9_-]{20,}", None),                                      // xai (grok)
            (r"<B>gsk_[A-Za-z0-9]{40,}", None),                                        // groq
            (r"<B>csk-[A-Za-z0-9]{32,}", None),                                        // cerebras
            (r"<B>LLM\|[0-9]{6,}\|[A-Za-z0-9_-]{16,}", None),                          // meta model api
            (r"<B>hf_[A-Za-z0-9]{30,}", None),                                         // hugging face
            (r"<B>pypi-AgE[A-Za-z0-9_-]{82,}", None),                                  // pypi and testpypi api tokens
            (r"<B>(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}", None),                   // github classic
            (r"<B>github_pat_[A-Za-z0-9_]{20,}", None),                                // github fine-grained
            (r"<B>gl(?:pat|dt|rtr?)-[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]+)*", None),   // gitlab
            (r"<B>xox[abposr]-[A-Za-z0-9-]{20,}", None),                               // slack
            (r"<B>xapp-[0-9]-[A-Za-z0-9-]{20,}", None),                                // slack app-level
            (r"<B>(?:AKIA|ASIA)[0-9A-Z]{16}<B>", None),                                // aws access key id
            (r"<B>AIza[0-9A-Za-z_-]{30,}", None),                                      // google api key
            (r"<B>npm_[A-Za-z0-9]{20,}", None),                                        // npm
            (r"<B>ntn_[A-Za-z0-9]{46}", g),                                            // notion integration tokens
            (r"<B>pplx-[A-Za-z0-9]{48}", g),                                           // perplexity api keys
            (r"<B>whsec_[A-Za-z0-9_-]{20,}", None),                                    // webhook secrets
            (r"<B>SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}", g),                       // sendgrid api keys
            (r"<B>bak_[A-Za-z0-9_-]{20,}", None),                                      // Bot API keys
            (r"<B>eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}<B>", None), // jwt
        ]
        .into_iter()
        .map(|(p, guard)| (build(p), guard))
        .collect()
    })
}

struct Rules {
    pem_block: Regex,
    private_key_block: Regex,
    private_key_end: Regex,
    bearer: Regex,
    basic_auth: Regex,
    key_value: Regex,
    key_suffix: Regex,
    db_credential: Regex,
    secret_flag: Regex,
    url_userinfo: Regex,
}

fn rules() -> &'static Rules {
    static CELL: OnceLock<Rules> = OnceLock::new();
    CELL.get_or_init(|| {
        // The value of `key=value`, as three alternatives for upstream's `(["']?)(value)\3`: double-quoted, single-quoted, bare.
        let quoted = |v: &str| format!(r#"(?:"({v})"|'({v})'|({v}))"#);
        Rules {
            pem_block: build(r"(-----BEGIN [A-Z ]*PRIVATE KEY-----)([\s\S]*?)(-----END [A-Z ]*PRIVATE KEY-----)"),
            private_key_block: build(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
            private_key_end: build(r"-----END [A-Z ]*PRIVATE KEY-----"),
            bearer: build(r"(<B>Bearer[<WS>]+)(<V>{12,})"),
            // `Authorization: Basic dXNlcjpwYXNz`: the base64 is `user:password` in the clear. Only after an Authorization header.
            basic_auth: build(r#"(<B><AUTH>["']?[<WS>]*[:=][<WS>]*["']?<BASIC>[<WS>]+)([A-Za-z0-9+/]{4,}={0,2})"#),
            // key=value / key: value / key="value" where the key is secret-shaped; the value is one token of 8 or more characters.
            key_value: build(&format!(r#"<B>((?:[A-Za-z0-9_-]*_)?(?:<KW>)[sS]?)(["']?[<WS>]*[=:][<WS>]*){}"#, quoted("<V>{8,}"))),
            // `X_KEY=value`, `xai-key=value`: a name that ENDS in key is a credential whatever the value looks like.
            key_suffix: build(&format!(r"<B>([A-Za-z][A-Za-z0-9_-]*[_-]<KEY>)[sS]?(=){}", quoted("<V>+"))),
            // The one extra rule: a database-credential name, any value length.
            db_credential: build(&format!(r"<B>((?:[A-Za-z0-9]+[_-])*(?:<DB>)[_-](?:<PW>))(=){}", quoted("<V>+"))),
            // `--token abc`, `--password=abc`: the value is the single token after the flag, never another flag.
            secret_flag: build(&format!(r"(--(?:<FLAGS>)(?:=|[<WS>]+)){}", quoted(r"[A-Za-z0-9._~+/=][A-Za-z0-9._~+/=-]*"))),
            // `scheme://user:secret@host`: the password in a URL's userinfo.
            url_userinfo: build(r#"(<B>[A-Za-z][A-Za-z0-9+.-]*://[^<WS>/:@'"]+:)([^<WS>/@'"«»]+)(@)"#),
        }
    })
}

/// The value and its quote out of the three alternatives that start at capture group `from`.
fn quoted_value<'t>(c: &Captures<'t>, from: usize) -> (&'t str, &'static str) {
    if let Some(m) = c.get(from) {
        (m.as_str(), "\"")
    } else if let Some(m) = c.get(from + 1) {
        (m.as_str(), "'")
    } else {
        (c.get(from + 2).map_or("", |m| m.as_str()), "")
    }
}

/// `text` with credentials masked (`«redacted N chars»`): the shape stays, the value goes.
pub fn redact_secrets(text: &str) -> String {
    redact(text, true)
}

fn redact(text: &str, extra_rules: bool) -> String {
    // Upstream first runs the held-secret scrubbers (a client registers none), then returns text shorter than 8 units unchanged.
    if utf16_len(text) < 8 {
        return text.to_string();
    }
    let r = rules();
    let mut out = r
        .pem_block
        .replace_all(text, |c: &Captures| format!("{}\n{}\n{}", &c[1], mask(c[2].trim_matches(is_js_ws)), &c[3]))
        .into_owned();
    if extra_rules {
        out = truncated_private_key(&out);
    }
    for (re, guard) in key_prefixes() {
        out = replace_guarded(&out, re, *guard, |c| mask(&c[0]));
    }
    out = r.bearer.replace_all(&out, |c: &Captures| format!("{}{}", &c[1], mask(&c[2]))).into_owned();
    out = replace_guarded(&out, &r.basic_auth, Some(basic_char), |c| format!("{}{}", &c[1], mask(&c[2])));
    out = r
        .key_value
        .replace_all(&out, |c: &Captures| {
            let (value, q) = quoted_value(c, 3);
            format!("{}{}{q}{}{q}", &c[1], &c[2], mask(value))
        })
        .into_owned();
    for re in [Some(&r.key_suffix), extra_rules.then_some(&r.db_credential)].into_iter().flatten() {
        out = re
            .replace_all(&out, |c: &Captures| {
                let (value, q) = quoted_value(c, 3);
                format!("{}{}{q}{}{q}", &c[1], &c[2], mask(value))
            })
            .into_owned();
    }
    out = r
        .secret_flag
        .replace_all(&out, |c: &Captures| {
            let (value, q) = quoted_value(c, 2);
            format!("{}{q}{}{q}", &c[1], mask(value))
        })
        .into_owned();
    out = r.url_userinfo.replace_all(&out, |c: &Captures| format!("{}{}{}", &c[1], mask(&c[2]), &c[3])).into_owned();
    out
}

/// Extra rule 2: the first `-----BEGIN ... PRIVATE KEY-----` header with no END line after it keeps its header and loses everything
/// after it (when something follows). Complete blocks were already masked by upstream's rule and are left as they are.
fn truncated_private_key(text: &str) -> String {
    let r = rules();
    for m in r.private_key_block.find_iter(text) {
        let rest = &text[m.end()..];
        if r.private_key_end.is_match(rest) {
            continue;
        }
        let body = rest.trim_matches(is_js_ws);
        if body.is_empty() {
            return text.to_string();
        }
        return format!("{}
{}", &text[..m.end()], mask(body));
    }
    text.to_string()
}

/// Only shapes that are unmistakably a credential (a provider's key prefix, a private key block), never a name or a placeholder:
/// text holding one is a credential store, not instructions. Upstream's `holdsCredential`.
pub fn holds_credential(text: &str) -> bool {
    rules().private_key_block.is_match(text) || key_prefixes().iter().any(|(re, guard)| matches_guarded(text, re, *guard))
}
