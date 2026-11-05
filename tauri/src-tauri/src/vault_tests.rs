// Unit tests for vault.rs (included by `#[path]`). Real DPAPI on the build PC, scratch dirs under target/ (never C:).
use super::*;
use std::cell::RefCell;
use std::fs;

fn hex(s: &str) -> Vec<u8> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}

fn scratch(tag: &str) -> PathBuf {
    use std::sync::atomic::{AtomicU32, Ordering};
    static N: AtomicU32 = AtomicU32::new(0);
    let p = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("target")
        .join("vault-test-tmp")
        .join(format!("{tag}-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
    let _ = fs::remove_dir_all(&p);
    fs::create_dir_all(&p).unwrap();
    p
}

/// sha256 over every file's relative name + bytes, in sorted order.
fn dir_hash(dir: &Path) -> String {
    fn walk(d: &Path, base: &Path, out: &mut Vec<(String, Vec<u8>)>) {
        for e in fs::read_dir(d).unwrap() {
            let p = e.unwrap().path();
            if p.is_dir() {
                walk(&p, base, out);
            } else {
                out.push((p.strip_prefix(base).unwrap().to_string_lossy().to_string(), fs::read(&p).unwrap()));
            }
        }
    }
    let mut files = Vec::new();
    walk(dir, dir, &mut files);
    files.sort();
    let mut all = Vec::new();
    for (n, b) in files {
        all.extend_from_slice(n.as_bytes());
        all.push(0);
        all.extend_from_slice(&b);
    }
    sha256_hex(&all)
}

// ---- pure (no OS) -------------------------------------------------------------------------------------

#[test]
fn sha256_known_vectors() {
    assert_eq!(sha256_hex(b""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    assert_eq!(sha256_hex(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    // 56 bytes: the padding boundary that needs a second block.
    assert_eq!(
        sha256_hex(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
        "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
    );
}

#[test]
fn base64_vectors_and_rejects() {
    assert_eq!(base64_decode("").unwrap(), b"");
    assert_eq!(base64_decode("Zg==").unwrap(), b"f");
    assert_eq!(base64_decode("Zm8=").unwrap(), b"fo");
    assert_eq!(base64_decode("Zm9v").unwrap(), b"foo");
    assert_eq!(base64_decode("Zm9vYg").unwrap(), b"foob"); // padding optional
    assert!(base64_decode("Zm9v!").is_none());
    assert!(base64_decode("Z").is_none());
    assert!(base64_decode("Zm9v====").is_none());
}

#[test]
fn utc_now_iso_shape() {
    let s = utc_now_iso();
    assert_eq!(s.len(), 20);
    assert!(s.ends_with('Z') && s.as_bytes()[4] == b'-' && s.as_bytes()[10] == b'T');
}

#[test]
fn classify_formats() {
    let mut dpapi = DPAPI_HEADER.to_vec();
    dpapi.extend_from_slice(&[1, 2, 3]);
    assert_eq!(classify(&dpapi), BlobFormat::Dpapi);
    assert_eq!(classify(b"v10abcdef"), BlobFormat::V10);
    assert_eq!(classify(b"v20abcdef"), BlobFormat::OtherVersioned);
    assert_eq!(classify(b"v11"), BlobFormat::OtherVersioned);
    assert_eq!(classify(b""), BlobFormat::Unknown);
    assert_eq!(classify(&[0xde, 0xad, 0xbe, 0xef]), BlobFormat::Unknown);
}

#[test]
fn exit_codes_and_words_are_fixed() {
    assert_eq!(VaultError::TooLarge.exit_code(), 2);
    assert_eq!(VaultError::NotUtf8.exit_code(), 2);
    assert_eq!(VaultError::ProtectFailed.exit_code(), 3);
    assert_eq!(VaultError::DecryptFailed.exit_code(), 3);
    assert_eq!(VaultError::ForeignFormat.exit_code(), 4);
    for e in [VaultError::TooLarge, VaultError::NotUtf8, VaultError::ProtectFailed, VaultError::DecryptFailed, VaultError::ForeignFormat, VaultError::Unavailable] {
        assert!(e.code().starts_with("err:") && e.code().chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == ':' || c == '_'));
    }
}

#[test]
fn parse_v10_splits_and_rejects_short() {
    let mut b = b"v10".to_vec();
    b.extend_from_slice(&[7u8; 12]);
    b.extend_from_slice(b"cipher");
    b.extend_from_slice(&[9u8; 16]);
    let (n, ct, tag) = parse_v10(&b).unwrap();
    assert_eq!(n, [7u8; 12]);
    assert_eq!(ct, b"cipher");
    assert_eq!(tag, [9u8; 16]);
    assert!(parse_v10(&b[..30]).is_none());
    assert!(parse_v10(b"v20aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa").is_none());
}

#[test]
fn local_state_parser_failures() {
    assert_eq!(encrypted_key_blob(b"not json"), Err(LocalStateError::BadJson));
    assert_eq!(encrypted_key_blob(b"{}"), Err(LocalStateError::MissingKey));
    assert_eq!(encrypted_key_blob(br#"{"os_crypt":{}}"#), Err(LocalStateError::MissingKey));
    assert_eq!(encrypted_key_blob(br#"{"os_crypt":{"encrypted_key":"@@@"}}"#), Err(LocalStateError::BadBase64));
    // base64("RSTUVxxxx") has no "DPAPI" prefix
    assert_eq!(encrypted_key_blob(br#"{"os_crypt":{"encrypted_key":"UlNUVVZ4eHh4"}}"#), Err(LocalStateError::WrongPrefix));
    // base64("DPAPI\x01\x02") parses
    assert_eq!(encrypted_key_blob(br#"{"os_crypt":{"encrypted_key":"RFBBUEkBAg=="}}"#).unwrap(), vec![1, 2]);
    assert_eq!(master_key(b"{}").err(), Some(MasterKeyError::NoMasterKey));
}

#[test]
fn import_table_is_exact() {
    assert_eq!(SECRET_NAMES.len(), 11);
    let mut uniq = SECRET_NAMES.to_vec();
    uniq.sort();
    uniq.dedup();
    assert_eq!(uniq.len(), 11);
    assert!(SECRET_NAMES.iter().all(|n| n.ends_with(".bin")));
    assert!(!SECRET_NAMES.contains(&"custom-tts-key.bin"), "legacy row 10 is skipped");
    assert!(SECRET_NAMES.contains(&"opencode-key.bin"));
    assert!(SECRET_NAMES.contains(&"custom-openai-tts-key.bin") && SECRET_NAMES.contains(&"custom-zumia-tts-key.bin"));
    for (bin, comps) in COMPANIONS {
        assert!(SECRET_NAMES.contains(&bin));
        assert!(comps.iter().all(|c| !c.ends_with(".import") && !c.ends_with(".bin") && !c.contains('*')));
    }
}

#[test]
fn reader_refuses_anything_off_the_table() {
    let d = scratch("reader");
    fs::write(d.join("jev-key.import"), b"plain").unwrap();
    fs::write(d.join("jev-key.bin"), b"x").unwrap();
    let r = DirReader(d.clone());
    assert_eq!(r.read("jev-key.import").unwrap_err().kind(), std::io::ErrorKind::PermissionDenied);
    assert_eq!(r.read("../jev-key.bin").unwrap_err().kind(), std::io::ErrorKind::PermissionDenied);
    assert_eq!(r.read("custom-tts-key.bin").unwrap_err().kind(), std::io::ErrorKind::PermissionDenied);
    assert_eq!(r.read("*.bin").unwrap_err().kind(), std::io::ErrorKind::PermissionDenied);
    assert_eq!(r.read("jev-key.bin").unwrap(), b"x");
    assert_eq!(r.read("leda-key.bin").unwrap_err().kind(), std::io::ErrorKind::NotFound);
}

// ---- real DPAPI / CNG (Windows) -----------------------------------------------------------------------

#[cfg(windows)]
mod win {
    use super::*;

    const KEY32: [u8; 32] = [
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32,
    ];
    const NONCE: [u8; 12] = [0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5, 0xA6, 0xA7, 0xA8, 0xA9, 0xAA, 0xAB];

    fn rt(plain: &[u8]) {
        let blob = protect(plain).expect("protect");
        assert!(blob.starts_with(&DPAPI_HEADER), "preview blob is a raw DPAPI blob");
        assert!(!blob.windows(plain.len().max(1)).any(|w| w == plain) || plain.is_empty(), "plaintext is not in the blob");
        let back = unprotect(&blob).expect("unprotect");
        assert_eq!(back.as_slice(), plain);
    }

    #[test]
    fn available_is_true_on_this_pc() {
        assert!(available());
    }

    #[test]
    fn round_trips() {
        rt(format!("sk-or-{}-ZVTESTROUNDTRIPKEY0123456789", "v1").as_bytes()); // built at runtime: no key-shaped literal in the diff
        rt("Khóa tiếng Việt: ăâđêôơư ✓".as_bytes());
        rt(br#"{"type":"pin","v":1,"salt":"AAAA","iv":"BBBB","ct":"CCCC","tag":"DDDD"}"#);
        rt(b"");
        rt(&vec![b'a'; MAX_PLAINTEXT]);
    }

    #[test]
    fn size_and_utf8_limits() {
        assert_eq!(protect(&vec![b'a'; MAX_PLAINTEXT + 1]), Err(VaultError::TooLarge));
        assert_eq!(protect(&[0xff, 0xfe, 0xfd]), Err(VaultError::NotUtf8));
        assert_eq!(unprotect(&vec![0u8; MAX_BLOB + 1]).err(), Some(VaultError::TooLarge));
    }

    #[test]
    fn corrupt_blobs_fail_with_exit_3_and_foreign_with_4() {
        let good = protect(b"ZVCANARY-corrupt").unwrap();
        let mut flipped = good.clone();
        let last = flipped.len() - 1;
        flipped[last] ^= 0x55;
        let mut mid = good.clone();
        let m = mid.len() / 2;
        mid[m] ^= 0x01;
        let truncated = &good[..good.len() / 2];
        let random: Vec<u8> = (0..200u32).map(|i| (i.wrapping_mul(2654435761) >> 24) as u8).collect();
        for (label, blob) in [("flipped", flipped), ("mid", mid), ("truncated", truncated.to_vec()), ("random", random), ("empty", vec![])] {
            let e = unprotect(&blob).err().unwrap_or_else(|| panic!("{label} must fail"));
            assert_eq!(e, VaultError::DecryptFailed, "{label}");
            assert_eq!(e.exit_code(), 3, "{label}");
        }
        for prefix in [&b"v10"[..], b"v20", b"v11"] {
            let mut b = prefix.to_vec();
            b.extend_from_slice(&[0u8; 40]);
            let e = unprotect(&b).err().unwrap();
            assert_eq!((e, e.exit_code()), (VaultError::ForeignFormat, 4));
        }
    }

    /// "Wrong user" cannot be a second Windows account in a unit test. The closest honest simulation is a DPAPI blob
    /// whose body no longer matches this user's master-key MAC: same failure code path (exit 3, nothing returned).
    #[test]
    fn wrong_user_simulated_is_exit_3_and_never_panics() {
        let mut blob = protect(b"ZVCANARY-other-user").unwrap();
        for b in blob.iter_mut().skip(DPAPI_HEADER.len() + 4).take(24) {
            *b ^= 0xA5; // scramble the master-key GUID / flags region
        }
        assert_eq!(unprotect(&blob).err(), Some(VaultError::DecryptFailed));
    }

    #[test]
    fn gcm_known_vector_from_node_crypto() {
        let ct = hex("e3876923aee177724e3e8f1d94e654eb25fadbdae54514659ceaf88b3baf63b245");
        let tag: [u8; 16] = hex("1077fd5ced96085ad5b1023c7eb97f76").try_into().unwrap();
        let pt = os::gcm_decrypt(&KEY32, &NONCE, &ct, &tag).expect("good tag decrypts");
        assert_eq!(pt, hex("5a56544553542d7631302d766563746f722d6bc3bd2d74e1bbb12d7669e1bb8774"));
        let mut bad = tag;
        bad[0] ^= 1;
        assert_eq!(os::gcm_decrypt(&KEY32, &NONCE, &ct, &bad), Err(VaultError::DecryptFailed));
        let mut bad_ct = ct.clone();
        bad_ct[3] ^= 1;
        assert_eq!(os::gcm_decrypt(&KEY32, &NONCE, &bad_ct, &tag), Err(VaultError::DecryptFailed));
    }

    #[test]
    fn gcm_encrypt_matches_node_vector() {
        let (ct, tag) = os::gcm_encrypt(&KEY32, &NONCE, &hex("5a56544553542d7631302d766563746f722d6bc3bd2d74e1bbb12d7669e1bb8774"));
        assert_eq!(ct, hex("e3876923aee177724e3e8f1d94e654eb25fadbdae54514659ceaf88b3baf63b245"));
        assert_eq!(tag.to_vec(), hex("1077fd5ced96085ad5b1023c7eb97f76"));
    }

    // ---- synthetic Electron userData --------------------------------------------------------------------

    fn v10_blob(key: &[u8; 32], nonce_seed: u8, plain: &[u8]) -> Vec<u8> {
        let nonce = [nonce_seed; 12];
        let (ct, tag) = os::gcm_encrypt(key, &nonce, plain);
        let mut b = b"v10".to_vec();
        b.extend_from_slice(&nonce);
        b.extend_from_slice(&ct);
        b.extend_from_slice(&tag);
        b
    }

    fn b64(data: &[u8]) -> String {
        const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut s = String::new();
        for c in data.chunks(3) {
            let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
            for i in 0..4 {
                if i <= c.len() {
                    s.push(A[((n >> (18 - 6 * i)) & 63) as usize] as char);
                } else {
                    s.push('=');
                }
            }
        }
        s
    }

    fn local_state(master: &[u8; 32]) -> Vec<u8> {
        let mut raw = b"DPAPI".to_vec();
        raw.extend_from_slice(&os::dpapi_protect(master).unwrap());
        format!(r#"{{"os_crypt":{{"encrypted_key":"{}"}}}}"#, b64(&raw)).into_bytes()
    }

    fn plain_of(name: &str) -> String {
        format!("ZVCANARY-{name}-vi-\u{1ee9}ng")
    }

    /// A full 0.2.5-shaped Electron userData: Local State, 11 v10 `.bin`, companions, decoys that must never be read.
    fn electron_dir(tag: &str) -> PathBuf {
        let d = scratch(tag);
        let master = KEY32;
        fs::write(d.join(LOCAL_STATE), local_state(&master)).unwrap();
        for (i, name) in SECRET_NAMES.iter().enumerate() {
            fs::write(d.join(name), v10_blob(&master, i as u8 + 1, plain_of(name).as_bytes())).unwrap();
        }
        for (_, comps) in COMPANIONS {
            for c in comps {
                fs::write(d.join(c), format!("{{\"companion\":\"{c}\"}}")).unwrap();
            }
        }
        fs::write(d.join("jev-key.import"), b"PLAIN-IMPORT-MUST-NEVER-BE-READ").unwrap();
        fs::write(d.join("custom-tts-key.bin"), b"legacy-row-10").unwrap();
        d
    }

    fn status_of(r: &Receipt, name: &str) -> String {
        r.files.iter().find(|(n, _)| n == name).map(|(_, s)| s.clone()).unwrap_or_else(|| panic!("no row {name}"))
    }

    #[test]
    fn import_full_matrix_idempotent_and_copy_only() {
        let from = electron_dir("imp-from");
        let to = scratch("imp-to");
        let before = dir_hash(&from);
        // a stale tmp from a crashed run, and a stale tmp whose target exists
        fs::write(to.join("jev-key.bin.tmp"), b"half-written").unwrap();
        fs::write(to.join("cloud-token.bin.tmp"), b"half-written").unwrap();
        let preview_key = protect(b"ZVCANARY-entered-in-preview").unwrap();
        fs::write(to.join("cloud-token.bin"), &preview_key).unwrap();

        let r1 = import_with(&DirReader(from.clone()), "h", &to, false).unwrap();
        for name in SECRET_NAMES {
            let want = if name == "cloud-token.bin" { "skipped_exists" } else { "imported" };
            assert_eq!(status_of(&r1, name), want, "{name}");
        }
        // the preview-entered key wins, byte for byte
        assert_eq!(fs::read(to.join("cloud-token.bin")).unwrap(), preview_key);
        for name in SECRET_NAMES {
            assert!(!to.join(format!("{name}.tmp")).exists(), "stale tmp for {name} deleted");
            if name != "cloud-token.bin" {
                let back = unprotect(&fs::read(to.join(name)).unwrap()).unwrap();
                assert_eq!(back.as_slice(), plain_of(name).as_bytes(), "{name} round trips");
            }
        }
        assert_eq!(status_of(&r1, "jev-key.last4"), "copied");
        assert_eq!(status_of(&r1, "board-secrets.meta.json"), "copied");
        assert!(!to.join("jev-key.import").exists() && !to.join("custom-tts-key.bin").exists() && !to.join("Local State").exists());
        assert_eq!(dir_hash(&from), before, "Electron dir untouched");

        // rerun: identical receipt except `at`, nothing rewritten
        let snapshot = dir_hash(&to);
        let first_receipt = fs::read(to.join(RECEIPT_NAME)).unwrap();
        let r2 = import_with(&DirReader(from.clone()), "h", &to, false).unwrap();
        assert_eq!((r2.from_hash.clone(), r2.files.clone()), (r1.from_hash.clone(), r1.files.clone()));
        let mut v1: serde_json::Value = serde_json::from_slice(&first_receipt).unwrap();
        let mut v2: serde_json::Value = serde_json::from_slice(&fs::read(to.join(RECEIPT_NAME)).unwrap()).unwrap();
        v1["at"] = serde_json::Value::Null;
        v2["at"] = serde_json::Value::Null;
        assert_eq!(v1, v2);
        let _ = snapshot;
        assert_eq!(dir_hash(&from), before);
        // the receipt holds no key material and no plain path
        let text = String::from_utf8(fs::read(to.join(RECEIPT_NAME)).unwrap()).unwrap();
        assert!(!text.contains("ZVCANARY") && !text.contains("imp-from"));
    }

    #[test]
    fn import_one_corrupted_source_fails_alone() {
        let from = electron_dir("imp-corrupt-from");
        let to = scratch("imp-corrupt-to");
        let mut b = fs::read(from.join("groq-key.bin")).unwrap();
        let n = b.len();
        b[n - 1] ^= 0xFF; // tag
        fs::write(from.join("groq-key.bin"), &b).unwrap();
        fs::write(from.join("leda-key.bin"), b"v10short").unwrap();
        fs::write(from.join("gemini-tts-key.bin"), b"v20-something-else-entirely-no").unwrap();
        let before = dir_hash(&from);
        let r = import_with(&DirReader(from.clone()), "h", &to, false).unwrap();
        assert_eq!(status_of(&r, "groq-key.bin"), "decrypt_failed");
        assert_eq!(status_of(&r, "leda-key.bin"), "corrupt");
        assert_eq!(status_of(&r, "gemini-tts-key.bin"), "unsupported_format");
        assert_eq!(status_of(&r, "groq-key.last4"), "not_imported");
        assert!(!to.join("groq-key.bin").exists() && !to.join("groq-key.bin.tmp").exists() && !to.join("groq-key.last4").exists());
        for ok in ["jev-key.bin", "gemini-key.bin", "opencode-key.bin", "elevenlabs-key.bin", "board-secrets.bin"] {
            assert_eq!(status_of(&r, ok), "imported", "{ok}");
        }
        assert_eq!(dir_hash(&from), before);
    }

    #[test]
    fn import_without_local_state_reports_no_master_key_and_still_takes_legacy_dpapi() {
        let from = electron_dir("imp-nols-from");
        fs::remove_file(from.join(LOCAL_STATE)).unwrap();
        // one legacy raw-DPAPI source (Chromium legacy format) still imports without any master key
        fs::write(from.join("jev-key.bin"), os::dpapi_protect(b"ZVCANARY-legacy").unwrap()).unwrap();
        let to = scratch("imp-nols-to");
        let before = dir_hash(&from);
        let r = import_with(&DirReader(from.clone()), "h", &to, false).unwrap();
        assert_eq!(status_of(&r, "jev-key.bin"), "imported");
        assert_eq!(unprotect(&fs::read(to.join("jev-key.bin")).unwrap()).unwrap().as_slice(), b"ZVCANARY-legacy");
        for name in SECRET_NAMES.iter().filter(|n| **n != "jev-key.bin") {
            assert_eq!(status_of(&r, name), "no_master_key", "{name}");
        }
        assert_eq!(dir_hash(&from), before);
    }

    /// Gate condition 5, foreign-user case: the master key cannot be unwrapped, so every v10 file fails alone,
    /// the source hash is unchanged and no `.tmp` is left behind.
    #[test]
    fn import_foreign_master_key_is_decrypt_failed_for_every_v10_and_leaves_no_tmp() {
        let from = electron_dir("imp-foreign-from");
        let mut ls = local_state(&KEY32);
        // corrupt the base64 body in the middle (still valid base64, DPAPI blob now invalid)
        let at = ls.len() / 2;
        ls[at] = if ls[at] == b'A' { b'B' } else { b'A' };
        fs::write(from.join(LOCAL_STATE), &ls).unwrap();
        let to = scratch("imp-foreign-to");
        let before = dir_hash(&from);
        let r = import_with(&DirReader(from.clone()), "h", &to, false).unwrap();
        for name in SECRET_NAMES {
            assert_eq!(status_of(&r, name), "decrypt_failed", "{name}");
        }
        assert_eq!(dir_hash(&from), before);
        let left: Vec<String> = fs::read_dir(&to).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().to_string()).collect();
        assert_eq!(left, vec![RECEIPT_NAME.to_string()], "only the receipt exists; no .tmp, no key file");
    }

    #[test]
    fn import_dry_run_writes_and_deletes_nothing() {
        let from = electron_dir("imp-dry-from");
        let to = scratch("imp-dry-to");
        fs::write(to.join("jev-key.bin.tmp"), b"keep me").unwrap();
        let r = import_with(&DirReader(from), "h", &to, true).unwrap();
        assert_eq!(status_of(&r, "jev-key.bin"), "would_import");
        assert_eq!(status_of(&r, "jev-key.last4"), "would_copy");
        let left: Vec<String> = fs::read_dir(&to).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().to_string()).collect();
        assert_eq!(left, vec!["jev-key.bin.tmp".to_string()]);
    }

    struct Spy {
        inner: DirReader,
        asked: RefCell<Vec<String>>,
    }
    impl SourceReader for Spy {
        fn read(&self, name: &str) -> std::io::Result<Vec<u8>> {
            self.asked.borrow_mut().push(name.to_string());
            self.inner.read(name)
        }
    }

    #[test]
    fn import_opens_only_local_state_and_the_fixed_names() {
        let from = electron_dir("imp-spy-from");
        let to = scratch("imp-spy-to");
        let spy = Spy { inner: DirReader(from), asked: RefCell::new(vec![]) };
        import_with(&spy, "h", &to, false).unwrap();
        let asked = spy.asked.borrow();
        assert!(!asked.is_empty());
        for n in asked.iter() {
            assert!(is_allowed_source(n), "asked for {n}");
            assert!(!n.ends_with(".import") && n != "custom-tts-key.bin" && !n.contains('*') && !n.contains(".."), "{n}");
        }
        assert_eq!(asked.iter().filter(|n| *n == LOCAL_STATE).count(), 1, "Local State is read once");
    }

    #[test]
    fn import_refuses_a_destination_inside_electrons_dir_or_a_missing_source() {
        let from = electron_dir("imp-args-from");
        let before = dir_hash(&from);
        assert_eq!(import_electron(&from, &from, false).err(), Some(ImportError::BadArgs));
        assert_eq!(import_electron(&from, &from.join("sub").join("deeper"), false).err(), Some(ImportError::BadArgs));
        assert_eq!(import_electron(&from.join("nope"), &scratch("imp-args-to"), false).err(), Some(ImportError::BadArgs));
        assert_eq!(dir_hash(&from), before);
        assert!(!from.join("sub").exists());
        // a normal run through the CLI entry works and leaves Electron alone
        let to = scratch("imp-args-ok").join("preview-data");
        let r = import_electron(&from, &to, false).unwrap();
        assert_eq!(status_of(&r, "jev-key.bin"), "imported");
        assert_eq!(dir_hash(&from), before);
    }
}
