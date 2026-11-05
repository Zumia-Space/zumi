//! T-31 parity step 5: the secrets vault (Electron `safeStorage` -> Windows DPAPI, CurrentUser).
//!
//! Decision record: docs/decisions/2026-10-20-preview-secret-backend.md. Plan + gate: PLAN-step5-vault.md /
//! GATE-step5.md (owner records). This file is compiled twice, on purpose: as `zumi_preview_lib::vault` (the host links
//! it directly when P2 moves key logic into Rust) and, through `#[path]`, into the small console helper
//! `zumi-vault.exe` (src/bin/zumi-vault.rs) the Node sidecar spawns synchronously. It therefore has no `crate::`
//! references and pulls in no Tauri code.
//!
//! Rules that are enforced here, not by convention:
//! - No new crate: only `windows-sys` (feature `Win32_Security_Cryptography`) and `serde_json` (already present).
//! - DPAPI CurrentUser scope, `CRYPTPROTECT_UI_FORBIDDEN`, NO description, NO optional entropy (gate Q4).
//! - A buffer that held plaintext or a master key is wiped before it is freed.
//! - Nothing in this file prints. The helper's stderr carries only the fixed words from `VaultError::code`.
//! - The Electron importer reads ONLY `Local State` and the fixed names below, through `SourceReader`, and writes
//!   only under the destination directory. A glob, a `.import` file or a browser path cannot be named.

use std::path::{Path, PathBuf};

pub const MAX_PLAINTEXT: usize = 64 * 1024;
pub const MAX_BLOB: usize = 128 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VaultError {
    TooLarge,
    NotUtf8,
    ProtectFailed,
    DecryptFailed,
    /// A Chromium `v10`/`v11`/`v20` blob: never decrypted in daily mode, only by the explicit import verb.
    ForeignFormat,
    Unavailable,
}

impl VaultError {
    /// The only text that may ever reach the helper's stderr.
    pub fn code(self) -> &'static str {
        match self {
            VaultError::TooLarge => "err:too_large",
            VaultError::NotUtf8 => "err:not_utf8",
            VaultError::ProtectFailed => "err:protect_failed",
            VaultError::DecryptFailed => "err:decrypt_failed",
            VaultError::ForeignFormat => "err:foreign_format",
            VaultError::Unavailable => "err:unavailable",
        }
    }
    /// Helper exit code (PLAN §4): 2 = too large / not UTF-8, 3 = DPAPI failed, 4 = foreign format.
    pub fn exit_code(self) -> i32 {
        match self {
            VaultError::TooLarge | VaultError::NotUtf8 => 2,
            VaultError::ProtectFailed | VaultError::DecryptFailed | VaultError::Unavailable => 3,
            VaultError::ForeignFormat => 4,
        }
    }
}

// ---------------------------------------------------------------------------------------------------------
// Hygiene
// ---------------------------------------------------------------------------------------------------------

/// Overwrite `buf` with zeros in a way the optimizer may not drop (no `zeroize` crate).
pub fn wipe(buf: &mut [u8]) {
    for b in buf.iter_mut() {
        // SAFETY: `b` is a valid, aligned &mut u8.
        unsafe { std::ptr::write_volatile(b, 0) };
    }
    std::sync::atomic::compiler_fence(std::sync::atomic::Ordering::SeqCst);
}

/// Bytes that are wiped when dropped (plaintext, master key).
pub struct Secret(Vec<u8>);

impl Secret {
    pub fn new(v: Vec<u8>) -> Secret {
        Secret(v)
    }
    pub fn as_slice(&self) -> &[u8] {
        &self.0
    }
    pub fn into_inner_unwiped(mut self) -> Vec<u8> {
        std::mem::take(&mut self.0)
    }
}

impl Drop for Secret {
    fn drop(&mut self) {
        wipe(&mut self.0);
    }
}

// ---------------------------------------------------------------------------------------------------------
// Blob classification
// ---------------------------------------------------------------------------------------------------------

/// The 20-byte header every raw DPAPI blob starts with (dwVersion 1 + the DPAPI provider GUID).
const DPAPI_HEADER: [u8; 20] = [
    0x01, 0x00, 0x00, 0x00, 0xD0, 0x8C, 0x9D, 0xDF, 0x01, 0x15, 0xD1, 0x11, 0x8C, 0x7A, 0x00, 0xC0, 0x4F, 0xC2, 0x97, 0xEB,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlobFormat {
    /// Raw DPAPI blob (this vault's format, and Chromium's legacy one).
    Dpapi,
    /// Chromium `v10` (AES-256-GCM under the `Local State` master key).
    V10,
    /// `v11`, `v20` and any other `v<digit><digit>` prefix: not decryptable here.
    OtherVersioned,
    Unknown,
}

pub fn classify(blob: &[u8]) -> BlobFormat {
    if blob.starts_with(&DPAPI_HEADER) {
        BlobFormat::Dpapi
    } else if blob.starts_with(b"v10") {
        BlobFormat::V10
    } else if blob.len() >= 3 && blob[0] == b'v' && blob[1].is_ascii_digit() && blob[2].is_ascii_digit() {
        BlobFormat::OtherVersioned
    } else {
        BlobFormat::Unknown
    }
}

// ---------------------------------------------------------------------------------------------------------
// OS primitives (Windows). Non-Windows builds compile to "unavailable".
// ---------------------------------------------------------------------------------------------------------

#[cfg(windows)]
mod os {
    use super::{wipe, VaultError};
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        BCryptCloseAlgorithmProvider, BCryptDecrypt, BCryptDestroyKey, BCryptGenerateSymmetricKey,
        BCryptOpenAlgorithmProvider, BCryptSetProperty, CryptProtectData, CryptUnprotectData,
        BCRYPT_AES_ALGORITHM, BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO, BCRYPT_CHAINING_MODE, CRYPTPROTECT_UI_FORBIDDEN,
        CRYPT_INTEGER_BLOB,
    };

    fn blob_of(data: &[u8]) -> CRYPT_INTEGER_BLOB {
        CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 }
    }

    /// Copy a DPAPI-allocated output buffer, wipe it, free it.
    unsafe fn take_output(out: &CRYPT_INTEGER_BLOB) -> Vec<u8> {
        let copy = if out.pbData.is_null() { Vec::new() } else { std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec() };
        if !out.pbData.is_null() {
            wipe(std::slice::from_raw_parts_mut(out.pbData, out.cbData as usize));
            LocalFree(out.pbData as *mut core::ffi::c_void);
        }
        copy
    }

    pub fn dpapi_protect(plain: &[u8]) -> Result<Vec<u8>, VaultError> {
        let input = blob_of(plain);
        let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: null_mut() };
        // SAFETY: `input` points at `plain` for the call; `out` is written by the OS and freed in take_output.
        let ok = unsafe { CryptProtectData(&input, null(), null(), null(), null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out) };
        if ok == 0 {
            return Err(VaultError::ProtectFailed);
        }
        Ok(unsafe { take_output(&out) })
    }

    pub fn dpapi_unprotect(blob: &[u8]) -> Result<Vec<u8>, VaultError> {
        let input = blob_of(blob);
        let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: null_mut() };
        // SAFETY: as above; the description out-pointer is null (we ask for none).
        let ok = unsafe { CryptUnprotectData(&input, null_mut(), null(), null(), null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out) };
        if ok == 0 {
            return Err(VaultError::DecryptFailed);
        }
        Ok(unsafe { take_output(&out) })
    }

    /// Open AES, switch to GCM, derive a key object. Returns (provider, key) handles; the caller closes both.
    unsafe fn gcm_key(key: &[u8; 32]) -> Option<(*mut core::ffi::c_void, *mut core::ffi::c_void)> {
        let mut alg: *mut core::ffi::c_void = null_mut();
        if BCryptOpenAlgorithmProvider(&mut alg, BCRYPT_AES_ALGORITHM, null(), 0) != 0 {
            return None;
        }
        let mode: Vec<u16> = "ChainingModeGCM".encode_utf16().chain(std::iter::once(0)).collect();
        let st = BCryptSetProperty(alg, BCRYPT_CHAINING_MODE, mode.as_ptr() as *const u8, (mode.len() * 2) as u32, 0);
        if st != 0 {
            BCryptCloseAlgorithmProvider(alg, 0);
            return None;
        }
        let mut hkey: *mut core::ffi::c_void = null_mut();
        if BCryptGenerateSymmetricKey(alg, &mut hkey, null_mut(), 0, key.as_ptr(), 32, 0) != 0 {
            BCryptCloseAlgorithmProvider(alg, 0);
            return None;
        }
        Some((alg, hkey))
    }

    fn auth_info(nonce: &[u8; 12], tag: &mut [u8; 16]) -> BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO {
        let mut info = BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO::default();
        info.cbSize = std::mem::size_of::<BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO>() as u32;
        info.dwInfoVersion = 1; // BCRYPT_INIT_AUTH_MODE_INFO_VERSION
        info.pbNonce = nonce.as_ptr() as *mut u8;
        info.cbNonce = 12;
        info.pbTag = tag.as_mut_ptr();
        info.cbTag = 16;
        info
    }

    /// AES-256-GCM decrypt, tag checked. Any failure (bad tag included) is `DecryptFailed`.
    pub fn gcm_decrypt(key: &[u8; 32], nonce: &[u8; 12], ct: &[u8], tag: &[u8; 16]) -> Result<Vec<u8>, VaultError> {
        let mut tag_buf = *tag;
        let info = auth_info(nonce, &mut tag_buf);
        let mut out = vec![0u8; ct.len()];
        let mut written: u32 = 0;
        // SAFETY: every pointer refers to a live local buffer for the duration of the call.
        let status = unsafe {
            let (alg, hkey) = gcm_key(key).ok_or(VaultError::Unavailable)?;
            let st = BCryptDecrypt(
                hkey, ct.as_ptr(), ct.len() as u32, &info as *const _ as *const core::ffi::c_void, null_mut(), 0,
                out.as_mut_ptr(), out.len() as u32, &mut written, 0,
            );
            BCryptDestroyKey(hkey);
            BCryptCloseAlgorithmProvider(alg, 0);
            st
        };
        if status != 0 {
            wipe(&mut out);
            return Err(VaultError::DecryptFailed);
        }
        out.truncate(written as usize);
        Ok(out)
    }

    /// Test-only: AES-256-GCM encrypt, returns ciphertext and tag. Builds the synthetic `v10` vectors.
    #[cfg(test)]
    pub fn gcm_encrypt(key: &[u8; 32], nonce: &[u8; 12], plain: &[u8]) -> (Vec<u8>, [u8; 16]) {
        use windows_sys::Win32::Security::Cryptography::BCryptEncrypt;
        let mut tag = [0u8; 16];
        let info = auth_info(nonce, &mut tag);
        let mut out = vec![0u8; plain.len()];
        let mut written: u32 = 0;
        unsafe {
            let (alg, hkey) = gcm_key(key).expect("aes gcm provider");
            let st = BCryptEncrypt(
                hkey, plain.as_ptr(), plain.len() as u32, &info as *const _ as *const core::ffi::c_void, null_mut(), 0,
                out.as_mut_ptr(), out.len() as u32, &mut written, 0,
            );
            BCryptDestroyKey(hkey);
            BCryptCloseAlgorithmProvider(alg, 0);
            assert_eq!(st, 0, "BCryptEncrypt failed");
        }
        out.truncate(written as usize);
        (out, tag)
    }
}

#[cfg(not(windows))]
mod os {
    use super::VaultError;
    pub fn dpapi_protect(_: &[u8]) -> Result<Vec<u8>, VaultError> {
        Err(VaultError::Unavailable)
    }
    pub fn dpapi_unprotect(_: &[u8]) -> Result<Vec<u8>, VaultError> {
        Err(VaultError::Unavailable)
    }
    pub fn gcm_decrypt(_: &[u8; 32], _: &[u8; 12], _: &[u8], _: &[u8; 16]) -> Result<Vec<u8>, VaultError> {
        Err(VaultError::Unavailable)
    }
}

// ---------------------------------------------------------------------------------------------------------
// Public vault operations (what the helper verbs call)
// ---------------------------------------------------------------------------------------------------------

/// `available` verb: a DPAPI round trip of a constant. False on non-Windows or when DPAPI is broken.
pub fn available() -> bool {
    const PROBE: &[u8] = b"zumi-vault-probe";
    match os::dpapi_protect(PROBE).and_then(|b| os::dpapi_unprotect(&b)) {
        Ok(back) => back == PROBE,
        Err(_) => false,
    }
}

/// `protect` verb. The input must be UTF-8 (Electron's `encryptString` takes a string) and at most 64 KiB.
pub fn protect(plain: &[u8]) -> Result<Vec<u8>, VaultError> {
    if plain.len() > MAX_PLAINTEXT {
        return Err(VaultError::TooLarge);
    }
    if std::str::from_utf8(plain).is_err() {
        return Err(VaultError::NotUtf8);
    }
    os::dpapi_protect(plain)
}

/// `unprotect` verb. Only this vault's raw DPAPI blobs are decrypted; Chromium `v10`/`v20` is `ForeignFormat`
/// (exit 4) and anything else that is not a DPAPI blob is a corrupt blob (exit 3).
pub fn unprotect(blob: &[u8]) -> Result<Secret, VaultError> {
    if blob.len() > MAX_BLOB {
        return Err(VaultError::TooLarge);
    }
    match classify(blob) {
        BlobFormat::Dpapi => {
            let plain = Secret::new(os::dpapi_unprotect(blob)?);
            if plain.as_slice().len() > MAX_PLAINTEXT {
                return Err(VaultError::TooLarge);
            }
            Ok(plain)
        }
        BlobFormat::V10 | BlobFormat::OtherVersioned => Err(VaultError::ForeignFormat),
        BlobFormat::Unknown => Err(VaultError::DecryptFailed),
    }
}

// ---------------------------------------------------------------------------------------------------------
// Chromium `v10` + `Local State` master key
// ---------------------------------------------------------------------------------------------------------

/// Split `"v10" + nonce(12) + ciphertext + tag(16)`. None when the blob is too short to hold the three parts.
pub fn parse_v10(blob: &[u8]) -> Option<([u8; 12], &[u8], [u8; 16])> {
    if blob.len() < 3 + 12 + 16 || !blob.starts_with(b"v10") {
        return None;
    }
    let mut nonce = [0u8; 12];
    nonce.copy_from_slice(&blob[3..15]);
    let tag_at = blob.len() - 16;
    let mut tag = [0u8; 16];
    tag.copy_from_slice(&blob[tag_at..]);
    Some((nonce, &blob[15..tag_at], tag))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocalStateError {
    BadJson,
    MissingKey,
    BadBase64,
    WrongPrefix,
}

/// `Local State` -> `os_crypt.encrypted_key` -> base64 -> strip `"DPAPI"` -> the DPAPI blob around the master key.
pub fn encrypted_key_blob(local_state_json: &[u8]) -> Result<Vec<u8>, LocalStateError> {
    let v: serde_json::Value = serde_json::from_slice(local_state_json).map_err(|_| LocalStateError::BadJson)?;
    let b64 = v
        .get("os_crypt")
        .and_then(|o| o.get("encrypted_key"))
        .and_then(|k| k.as_str())
        .ok_or(LocalStateError::MissingKey)?;
    let raw = base64_decode(b64).ok_or(LocalStateError::BadBase64)?;
    raw.strip_prefix(b"DPAPI").map(|b| b.to_vec()).ok_or(LocalStateError::WrongPrefix)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MasterKeyError {
    /// No usable `Local State` key: the file, the field, the base64 or the `DPAPI` prefix is missing or wrong.
    NoMasterKey,
    /// The key blob is there but DPAPI refused it (another Windows user or machine), or it is not 32 bytes.
    DecryptFailed,
}

pub fn master_key(local_state_json: &[u8]) -> Result<Secret, MasterKeyError> {
    let blob = encrypted_key_blob(local_state_json).map_err(|_| MasterKeyError::NoMasterKey)?;
    let key = Secret::new(os::dpapi_unprotect(&blob).map_err(|_| MasterKeyError::DecryptFailed)?);
    if key.as_slice().len() != 32 {
        return Err(MasterKeyError::DecryptFailed);
    }
    Ok(key)
}

/// Decrypt a `v10` blob with the master key. Too short is `corrupt` for the importer, a bad tag is a failure.
pub fn v10_decrypt(blob: &[u8], key: &Secret) -> Result<Secret, VaultError> {
    let (nonce, ct, tag) = parse_v10(blob).ok_or(VaultError::DecryptFailed)?;
    let mut k = [0u8; 32];
    k.copy_from_slice(key.as_slice());
    let r = os::gcm_decrypt(&k, &nonce, ct, &tag);
    wipe(&mut k);
    r.map(Secret::new)
}

/// Standard-alphabet base64 with optional padding. None on any invalid character or length.
pub fn base64_decode(s: &str) -> Option<Vec<u8>> {
    let bytes = s.trim_end_matches('=').as_bytes();
    if bytes.len() % 4 == 1 || s.len() - bytes.len() > 2 {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0u32);
    for &c in bytes {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        } as u32;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Some(out)
}

// ---------------------------------------------------------------------------------------------------------
// SHA-256 (receipt `from_hash`, and the tests' directory hashes). No crate.
// ---------------------------------------------------------------------------------------------------------

pub fn sha256_hex(data: &[u8]) -> String {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
        0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
        0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
        0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
        0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
        0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ];
    let mut h: [u32; 8] = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    let mut msg = data.to_vec();
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&((data.len() as u64) * 8).to_be_bytes());
    for chunk in msg.chunks(64) {
        let mut w = [0u32; 64];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([chunk[4 * i], chunk[4 * i + 1], chunk[4 * i + 2], chunk[4 * i + 3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16].wrapping_add(s0).wrapping_add(w[i - 7]).wrapping_add(s1);
        }
        let mut v = h;
        for i in 0..64 {
            let s1 = v[4].rotate_right(6) ^ v[4].rotate_right(11) ^ v[4].rotate_right(25);
            let ch = (v[4] & v[5]) ^ (!v[4] & v[6]);
            let t1 = v[7].wrapping_add(s1).wrapping_add(ch).wrapping_add(K[i]).wrapping_add(w[i]);
            let s0 = v[0].rotate_right(2) ^ v[0].rotate_right(13) ^ v[0].rotate_right(22);
            let maj = (v[0] & v[1]) ^ (v[0] & v[2]) ^ (v[1] & v[2]);
            let t2 = s0.wrapping_add(maj);
            v = [t1.wrapping_add(t2), v[0], v[1], v[2], v[3].wrapping_add(t1), v[4], v[5], v[6]];
        }
        for i in 0..8 {
            h[i] = h[i].wrapping_add(v[i]);
        }
    }
    h.iter().map(|x| format!("{x:08x}")).collect()
}

/// `YYYY-MM-DDTHH:MM:SSZ` for the receipt's `at`. Civil-from-days (Hinnant), no time crate.
pub fn utc_now_iso() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, (rem % 3600) / 60, rem % 60)
}

// ---------------------------------------------------------------------------------------------------------
// One-time Electron import (copy-only)
// ---------------------------------------------------------------------------------------------------------

pub const LOCAL_STATE: &str = "Local State";

/// The 11 secret files, in the PLAN §1 order (rows 1-9, 11, 12). Never a glob. Row 10 (`custom-tts-key.bin`) is
/// deliberately absent: Electron's own start migrates it.
pub const SECRET_NAMES: [&str; 11] = [
    "jev-key.bin",
    "gemini-key.bin",
    "groq-key.bin",
    "opencode-key.bin",
    "leda-key.bin",
    "gemini-tts-key.bin",
    "elevenlabs-key.bin",
    "custom-openai-tts-key.bin",
    "custom-zumia-tts-key.bin",
    "cloud-token.bin",
    "board-secrets.bin",
];

/// Plaintext companions that hold no secret, copied only after their `.bin` imported. `.import` files are not here.
pub const COMPANIONS: [(&str, &[&str]); 5] = [
    ("jev-key.bin", &["jev-key.last4", "brain-key-check.json"]),
    ("gemini-key.bin", &["gemini-key.last4", "brain-key-check-gemini.json"]),
    ("groq-key.bin", &["groq-key.last4", "brain-key-check-groq.json"]),
    ("opencode-key.bin", &["opencode-key.last4", "brain-key-check-opencode.json"]),
    ("board-secrets.bin", &["board-secrets.meta.json"]),
];

pub const RECEIPT_NAME: &str = "vault-import.json";

/// Everything the importer may open in Electron's directory.
pub fn is_allowed_source(name: &str) -> bool {
    name == LOCAL_STATE || SECRET_NAMES.contains(&name) || COMPANIONS.iter().any(|(_, cs)| cs.contains(&name))
}

/// Read access to Electron's userData. The seam lets a test spy on every name the importer asks for.
pub trait SourceReader {
    fn read(&self, name: &str) -> std::io::Result<Vec<u8>>;
}

/// The real reader: `<from>/<name>` for an allowed name only. Anything else is refused before the filesystem.
pub struct DirReader(pub PathBuf);

impl SourceReader for DirReader {
    fn read(&self, name: &str) -> std::io::Result<Vec<u8>> {
        if !is_allowed_source(name) {
            return Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied));
        }
        std::fs::read(self.0.join(name))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Receipt {
    pub at: String,
    pub from_hash: String,
    pub files: Vec<(String, String)>,
}

impl Receipt {
    pub fn to_json(&self) -> String {
        let files: Vec<serde_json::Value> =
            self.files.iter().map(|(n, s)| serde_json::json!({ "name": n, "status": s })).collect();
        serde_json::to_string_pretty(&serde_json::json!({ "at": self.at, "from_hash": self.from_hash, "files": files }))
            .unwrap_or_default()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImportError {
    BadArgs,
    WriteFailed,
}

/// Statuses that stay in the receipt on a rerun (the target exists now because THIS import made it).
fn is_sticky(status: &str) -> bool {
    status == "imported" || status == "copied"
}

fn prior_statuses(to: &Path) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    if let Ok(bytes) = std::fs::read(to.join(RECEIPT_NAME)) {
        if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&bytes) {
            for f in v.get("files").and_then(|f| f.as_array()).into_iter().flatten() {
                if let (Some(n), Some(s)) = (f.get("name").and_then(|n| n.as_str()), f.get("status").and_then(|s| s.as_str())) {
                    map.insert(n.to_string(), s.to_string());
                }
            }
        }
    }
    map
}

/// Write `bytes` to `<dir>/<name>` through `<name>.tmp` + rename. Any stale `.tmp` is overwritten (and was deleted
/// earlier by the caller).
fn write_atomic(dir: &Path, name: &str, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = dir.join(format!("{name}.tmp"));
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, dir.join(name)).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

/// Import into `to` through `reader`. `from_hash` is the sha256 of the Electron path (no plain path in the receipt).
/// `dry_run` reads and decrypts in memory but writes and deletes nothing, and reports `would_import`/`would_copy`.
pub fn import_with(reader: &dyn SourceReader, from_hash: &str, to: &Path, dry_run: bool) -> Result<Receipt, ImportError> {
    if !dry_run {
        std::fs::create_dir_all(to).map_err(|_| ImportError::WriteFailed)?;
    }
    let prior = prior_statuses(to);
    let sticky_or = |name: &str, fresh: &str| -> String {
        match prior.get(name) {
            Some(p) if fresh == "skipped_exists" && is_sticky(p) => p.clone(),
            _ => fresh.to_string(),
        }
    };
    // Lazy master key: read Local State at most once, and only when a v10 file needs it.
    let mut master: Option<Result<Secret, MasterKeyError>> = None;
    let mut files: Vec<(String, String)> = Vec::new();

    let drop_stale_tmp = |name: &str| {
        if !dry_run {
            let _ = std::fs::remove_file(to.join(format!("{name}.tmp")));
        }
    };

    for name in SECRET_NAMES {
        drop_stale_tmp(name);
        let status = if to.join(name).exists() {
            sticky_or(name, "skipped_exists")
        } else {
            match reader.read(name) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => "no_source".to_string(),
                Err(_) => "read_failed".to_string(),
                Ok(blob) => {
                    let plain: Result<Secret, &'static str> = match classify(&blob) {
                        BlobFormat::Dpapi => os::dpapi_unprotect(&blob).map(Secret::new).map_err(|_| "decrypt_failed"),
                        BlobFormat::V10 => {
                            if blob.len() < 3 + 12 + 16 {
                                Err("corrupt")
                            } else {
                                let mk = master.get_or_insert_with(|| match reader.read(LOCAL_STATE) {
                                    Ok(json) => master_key(&json),
                                    Err(_) => Err(MasterKeyError::NoMasterKey),
                                });
                                match mk {
                                    Err(MasterKeyError::NoMasterKey) => Err("no_master_key"),
                                    Err(MasterKeyError::DecryptFailed) => Err("decrypt_failed"),
                                    Ok(k) => v10_decrypt(&blob, k).map_err(|_| "decrypt_failed"),
                                }
                            }
                        }
                        BlobFormat::OtherVersioned | BlobFormat::Unknown => Err("unsupported_format"),
                    };
                    match plain {
                        Err(code) => code.to_string(),
                        Ok(secret) => match protect(secret.as_slice()) {
                            Err(_) => "corrupt".to_string(),
                            Ok(out) if dry_run => {
                                drop(out);
                                "would_import".to_string()
                            }
                            Ok(out) => match write_atomic(to, name, &out) {
                                Ok(()) => "imported".to_string(),
                                Err(_) => "write_failed".to_string(),
                            },
                        },
                    }
                }
            }
        };
        let imported_now = is_sticky(&status) || status == "would_import";
        files.push((name.to_string(), status));

        // Companions follow their .bin, and only when that .bin is (now or earlier) imported by this tool.
        if let Some((_, companions)) = COMPANIONS.iter().find(|(b, _)| *b == name) {
            for comp in *companions {
                drop_stale_tmp(comp);
                let cstatus = if !imported_now {
                    "not_imported".to_string()
                } else if to.join(comp).exists() {
                    sticky_or(comp, "skipped_exists")
                } else {
                    match reader.read(comp) {
                        Err(e) if e.kind() == std::io::ErrorKind::NotFound => "no_source".to_string(),
                        Err(_) => "read_failed".to_string(),
                        Ok(bytes) if bytes.len() > MAX_PLAINTEXT => "corrupt".to_string(),
                        Ok(_) if dry_run => "would_copy".to_string(),
                        Ok(bytes) => match write_atomic(to, comp, &bytes) {
                            Ok(()) => "copied".to_string(),
                            Err(_) => "write_failed".to_string(),
                        },
                    }
                };
                files.push((comp.to_string(), cstatus));
            }
        }
    }

    let receipt = Receipt { at: utc_now_iso(), from_hash: from_hash.to_string(), files };
    if !dry_run {
        drop_stale_tmp(RECEIPT_NAME);
        write_atomic(to, RECEIPT_NAME, receipt.to_json().as_bytes()).map_err(|_| ImportError::WriteFailed)?;
    }
    Ok(receipt)
}

fn plain_path_string(p: &Path) -> String {
    p.to_string_lossy().trim_start_matches(r"\\?\").to_string()
}

/// The CLI entry: validate the two directories, then run `import_with` through the real reader.
pub fn import_electron(from: &Path, to: &Path, dry_run: bool) -> Result<Receipt, ImportError> {
    let from_c = std::fs::canonicalize(from).map_err(|_| ImportError::BadArgs)?;
    if !from_c.is_dir() {
        return Err(ImportError::BadArgs);
    }
    // The destination may not exist yet; its nearest existing ancestor decides where it really is.
    let mut probe = to.to_path_buf();
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    while !probe.exists() {
        match (probe.file_name().map(|n| n.to_os_string()), probe.parent().map(|p| p.to_path_buf())) {
            (Some(n), Some(p)) => {
                tail.push(n);
                probe = p;
            }
            _ => return Err(ImportError::BadArgs),
        }
    }
    let mut to_c = std::fs::canonicalize(&probe).map_err(|_| ImportError::BadArgs)?;
    for n in tail.iter().rev() {
        to_c.push(n);
    }
    // Never write into (or under) Electron's directory.
    if to_c.starts_with(&from_c) {
        return Err(ImportError::BadArgs);
    }
    let from_hash = sha256_hex(plain_path_string(&from_c).to_lowercase().as_bytes());
    import_with(&DirReader(from_c), &from_hash, &to_c, dry_run)
}

#[cfg(test)]
#[path = "vault_tests.rs"]
mod tests;
