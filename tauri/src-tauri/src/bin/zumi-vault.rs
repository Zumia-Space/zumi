//! `zumi-vault.exe`: the secrets-vault helper the Node sidecar spawns synchronously (parity step 5).
//!
//! Protocol (PLAN §4): the verb is the only argument that carries meaning; ALL data travels on stdin/stdout, never in
//! argv, never in a temp file. stderr carries only a fixed word from `VaultError::code`. This file prints nothing
//! else, and never echoes input, output, sizes or paths of secrets (gate condition 6 is checked by a static grep).
//!
//!   available                               exit 0 = DPAPI round trip OK, 1 = not
//!   protect                                 stdin UTF-8 plaintext -> stdout DPAPI blob
//!   unprotect                               stdin DPAPI blob -> stdout UTF-8 plaintext
//!   import-electron --from D --to D [--dry-run]   one-time copy import; stdout = receipt JSON (names + statuses)
//!
//! Exit codes: 0 ok; 2 too large / not UTF-8 / bad args; 3 DPAPI failed; 4 foreign format (v10/v20).
//! The vault code is shared with the host library by path, so this binary links no Tauri or WebView2 code.
#[path = "../vault.rs"]
#[allow(dead_code)]
mod vault;

use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::ExitCode;

fn fail(code_word: &'static str, exit: u8) -> ExitCode {
    eprintln!("{code_word}"); // leak-ok: code_word is a &'static str (a fixed word), never data
    ExitCode::from(exit)
}

fn read_stdin(limit: usize) -> Result<vault::Secret, vault::VaultError> {
    let mut buf = Vec::new();
    // one byte past the limit is enough to know it is too large without buffering an unbounded stream
    if std::io::stdin().lock().take(limit as u64 + 1).read_to_end(&mut buf).is_err() {
        vault::wipe(&mut buf);
        return Err(vault::VaultError::ProtectFailed);
    }
    Ok(vault::Secret::new(buf))
}

fn write_stdout(bytes: &[u8]) -> bool {
    let mut out = std::io::stdout().lock();
    out.write_all(bytes).and_then(|_| out.flush()).is_ok()
}

fn verb_error(e: vault::VaultError) -> ExitCode {
    fail(e.code(), e.exit_code() as u8)
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("available") if args.len() == 1 => {
            if vault::available() {
                ExitCode::SUCCESS
            } else {
                ExitCode::from(1)
            }
        }
        Some("protect") if args.len() == 1 => {
            let input = match read_stdin(vault::MAX_PLAINTEXT) {
                Ok(s) => s,
                Err(e) => return verb_error(e),
            };
            match vault::protect(input.as_slice()) {
                Ok(blob) if write_stdout(&blob) => ExitCode::SUCCESS,
                Ok(_) => fail("err:io", 3),
                Err(e) => verb_error(e),
            }
        }
        Some("unprotect") if args.len() == 1 => {
            let input = match read_stdin(vault::MAX_BLOB) {
                Ok(s) => s,
                Err(e) => return verb_error(e),
            };
            match vault::unprotect(input.as_slice()) {
                Ok(plain) if write_stdout(plain.as_slice()) => ExitCode::SUCCESS,
                Ok(_) => fail("err:io", 3),
                Err(e) => verb_error(e),
            }
        }
        Some("import-electron") => {
            let (mut from, mut to, mut dry) = (None::<PathBuf>, None::<PathBuf>, false);
            let mut it = args[1..].iter();
            while let Some(a) = it.next() {
                match a.as_str() {
                    "--from" => from = it.next().map(PathBuf::from),
                    "--to" => to = it.next().map(PathBuf::from),
                    "--dry-run" => dry = true,
                    _ => return fail("err:bad_args", 2),
                }
            }
            let (Some(from), Some(to)) = (from, to) else { return fail("err:bad_args", 2) };
            match vault::import_electron(&from, &to, dry) {
                Ok(r) if write_stdout(r.to_json().as_bytes()) => ExitCode::SUCCESS,
                Ok(_) => fail("err:io", 3),
                Err(vault::ImportError::BadArgs) => fail("err:bad_args", 2),
                Err(vault::ImportError::WriteFailed) => fail("err:write_failed", 3),
            }
        }
        _ => fail("err:bad_args", 2),
    }
}
