//! Authentication of host-made records (P3 M3, HB-2). The host makes a random key when it starts, hands it only to the
//! helper process it spawns (environment `ZUMI_HANDS_ACCEPT_KEY`, hex), and signs a pack acceptance with HMAC-SHA256 after a
//! person clicked the host's own dialog. The helper accepts a record only if its MAC verifies under that key. Whoever
//! writes the record file without the key (the stdio driver, the model, the sidecar, a bench script) cannot make one
//! that counts: the key never travels through stdio, the model's context, the sidecar or a file.
use sha2::{Digest, Sha256};

pub const KEY_ENV: &str = "ZUMI_HANDS_ACCEPT_KEY";
const BLOCK: usize = 64;

fn hmac_sha256(key: &[u8], msg: &[u8]) -> [u8; 32] {
    let mut k = [0u8; BLOCK];
    if key.len() > BLOCK {
        k[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        k[..key.len()].copy_from_slice(key);
    }
    let (mut ipad, mut opad) = ([0x36u8; BLOCK], [0x5cu8; BLOCK]);
    for i in 0..BLOCK {
        ipad[i] ^= k[i];
        opad[i] ^= k[i];
    }
    let inner = Sha256::new().chain_update(ipad).chain_update(msg).finalize();
    Sha256::new().chain_update(opad).chain_update(inner).finalize().into()
}

/// The sha256 of `data`, hex: what an audit line keeps to prove a text without storing it.
pub fn sha256_hex(data: &[u8]) -> String {
    to_hex(&Sha256::digest(data))
}

pub fn to_hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

pub fn from_hex(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 || !s.is_ascii() {
        return None;
    }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok()).collect()
}

/// The MAC of a record's fields, hex. Fields are joined with 0x1f, which no field contains.
pub fn mac_hex(key: &[u8], fields: &[&str]) -> String {
    to_hex(&hmac_sha256(key, fields.join("\u{1f}").as_bytes()))
}

/// Constant-time check of a hex MAC. An empty key never verifies.
pub fn verify(key: &[u8], fields: &[&str], mac: &str) -> bool {
    if key.len() < 16 {
        return false;
    }
    let want = mac_hex(key, fields);
    want.len() == mac.len() && want.bytes().zip(mac.bytes()).fold(0u8, |d, (a, b)| d | (a ^ b)) == 0
}

/// The key from the environment (hex, at least 16 bytes), if the host passed one.
pub fn key_from_env() -> Option<Vec<u8>> {
    from_hex(std::env::var(KEY_ENV).ok()?.trim()).filter(|k| k.len() >= 16)
}

/// 32 random bytes from the OS.
#[cfg(windows)]
pub fn new_key() -> Result<Vec<u8>, String> {
    use windows::Win32::Security::Cryptography::{BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG};
    let mut k = vec![0u8; 32];
    // SAFETY: a valid buffer of the stated length; the system RNG needs no algorithm handle.
    let status = unsafe { BCryptGenRandom(None, &mut k, BCRYPT_USE_SYSTEM_PREFERRED_RNG) };
    if status.0 == 0 { Ok(k) } else { Err(format!("BCryptGenRandom: 0x{:X}", status.0)) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hmac_matches_rfc_4231_case_2() {
        let mac = to_hex(&hmac_sha256(b"Jefe", b"what do ya want for nothing?"));
        assert_eq!(mac, "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
    }

    #[test]
    fn hmac_with_a_key_longer_than_a_block_matches_rfc_4231_case_6() {
        let key = [0xaau8; 131];
        let mac = to_hex(&hmac_sha256(&key, b"Test Using Larger Than Block-Size Key - Hash Key First"));
        assert_eq!(mac, "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54");
    }

    #[test]
    fn verify_bites_a_wrong_key_a_changed_field_a_missing_mac_and_a_short_key_and_passes_the_real_one() {
        let key = [7u8; 32];
        let fields = ["explorer", "v1", "abc", "123"];
        let mac = mac_hex(&key, &fields);
        assert!(verify(&key, &fields, &mac));
        assert!(!verify(&[8u8; 32], &fields, &mac), "another key");
        assert!(!verify(&key, &["explorer", "v2", "abc", "123"], &mac), "a changed field");
        assert!(!verify(&key, &fields, ""), "no mac");
        assert!(!verify(&key, &fields, &mac[..63]), "a truncated mac");
        assert!(!verify(&[1u8; 4], &fields, &mac_hex(&[1u8; 4], &fields)), "a short key never verifies");
        // Fields cannot be shifted across the separator to forge another record.
        assert_ne!(mac_hex(&key, &["a", "bc"]), mac_hex(&key, &["ab", "c"]));
    }

    #[cfg(windows)]
    #[test]
    fn new_keys_are_32_bytes_and_differ() {
        let (a, b) = (new_key().unwrap(), new_key().unwrap());
        assert_eq!((a.len(), a == b), (32, false));
        assert_eq!(from_hex(&to_hex(&a)).unwrap(), a);
        assert!(from_hex("abc").is_none() && from_hex("zz").is_none());
    }
}
