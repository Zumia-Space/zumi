// minisign-format signatures for the Marketplace store index (ADR 2026-11-11-pack-system). Same scheme as the app updater
// (ed25519; "ED" = signature over the BLAKE2b-512 of the file, plus a global signature over sig || trusted comment), so a stock
// `minisign -V -P <key>` and the Rust `minisign-verify` crate accept the files this writes. Node built-ins only.
// Signing is used by the publish tool only; the app only verifies. A private key never passes through a log line here.
import crypto from 'node:crypto';

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
// minisign prints the 8-byte key number as a little-endian u64 in upper-case hex.
const keyIdHex = (keyNum) => Buffer.from(keyNum).reverse().toString('hex').toUpperCase();

/** A new key pair: { keyNum (8 bytes), publicRaw (32 bytes), privatePem (PKCS8) }. */
export function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    keyNum: crypto.randomBytes(8),
    publicRaw: fromB64url(publicKey.export({ format: 'jwk' }).x),
    privatePem: privateKey.export({ format: 'pem', type: 'pkcs8' }),
  };
}

export const keyIdOf = (pair) => keyIdHex(pair.keyNum);

/** The minisign public key file text for a pair. */
export function publicKeyText(pair) {
  const body = Buffer.concat([Buffer.from('Ed'), pair.keyNum, pair.publicRaw]).toString('base64');
  return `untrusted comment: minisign public key ${keyIdOf(pair)}\n${body}\n`;
}

/** Parse a minisign public key (file text or the bare base64 line). Throws on a malformed key: keys are compiled in. */
export function parsePublicKey(text) {
  const line = String(text).trim().split(/\r?\n/).filter((l) => !l.startsWith('untrusted comment:')).pop() || '';
  const raw = Buffer.from(line, 'base64');
  if (raw.length !== 42 || raw.toString('latin1', 0, 2) !== 'Ed') throw new Error('not a minisign ed25519 public key');
  const keyNum = raw.subarray(2, 10);
  const key = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: b64url(raw.subarray(10)) }, format: 'jwk' });
  return { keyId: keyIdHex(keyNum), keyNum: Buffer.from(keyNum), key };
}

/** Sign `message` with a pair (or { keyNum, privatePem }). Returns the four-line .minisig text. */
export function signMinisign(message, pair, { trusted = `timestamp:${Math.floor(Date.now() / 1000)}`, untrusted = 'signature from zumi-market secret key' } = {}) {
  if (/[\r\n]/.test(trusted) || /[\r\n]/.test(untrusted)) throw new Error('comments are one line');
  const key = crypto.createPrivateKey(pair.privatePem);
  const digest = crypto.createHash('blake2b512').update(message).digest();
  const sig = crypto.sign(null, digest, key);
  const global = crypto.sign(null, Buffer.concat([sig, Buffer.from(trusted, 'utf8')]), key);
  const line1 = Buffer.concat([Buffer.from('ED'), pair.keyNum, sig]).toString('base64');
  return `untrusted comment: ${untrusted}\n${line1}\ntrusted comment: ${trusted}\n${global.toString('base64')}\n`;
}

/**
 * Verify a .minisig text against trusted public keys (parsePublicKey results). Never throws.
 * @returns {{ ok: true, keyId: string, trusted: string } | { ok: false, code: string, message: string }}
 * Codes: sig_format, sig_key_unknown, sig_mismatch, sig_comment.
 */
export function verifyMinisign(message, sigText, publicKeys) {
  const no = (code, message) => ({ ok: false, code, message });
  const lines = String(sigText).replace(/\r\n/g, '\n').split('\n');
  if (lines.length < 4 || !lines[0].startsWith('untrusted comment:') || !lines[2].startsWith('trusted comment: ')) return no('sig_format', 'the signature is not a minisign signature');
  const raw = Buffer.from(lines[1], 'base64');
  const global = Buffer.from(lines[3], 'base64');
  const alg = raw.toString('latin1', 0, 2);
  if (raw.length !== 74 || global.length !== 64 || (alg !== 'ED' && alg !== 'Ed')) return no('sig_format', 'the signature is not a minisign ed25519 signature');
  const keyNum = raw.subarray(2, 10);
  const sig = raw.subarray(10);
  const pub = publicKeys.find((k) => k.keyNum.equals(keyNum));
  if (!pub) return no('sig_key_unknown', `signed by key ${keyIdHex(keyNum)}, which this app does not trust`);
  const signed = alg === 'ED' ? crypto.createHash('blake2b512').update(message).digest() : message;
  if (!crypto.verify(null, signed, pub.key, sig)) return no('sig_mismatch', 'the file does not match its signature');
  const trusted = lines[2].slice('trusted comment: '.length);
  if (!crypto.verify(null, Buffer.concat([sig, Buffer.from(trusted, 'utf8')]), pub.key, global)) return no('sig_comment', 'the trusted comment does not match its signature');
  return { ok: true, keyId: pub.keyId, trusted };
}
