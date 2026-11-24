// TOTP, RFC 6238 over HOTP (RFC 4226), HMAC-SHA-1. No dependency: node crypto only. Tested with the RFC 6238 Appendix B vectors.
import crypto from 'node:crypto';

const STEP_S = 30;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(text) {
  const clean = String(text).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0, value = 0; const out = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('not base32');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

/** HOTP value of `counter` (a non-negative integer step) for `key` (bytes), `digits` long, zero-padded. */
export function hotp(key, counter, digits = 6) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac('sha1', key).update(msg).digest();
  const off = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}
/** The TOTP time step of a time in ms (T0 = 0, X = 30 s). */
export const stepOf = ms => Math.floor(ms / 1000 / STEP_S);
export const totp = (key, ms, digits = 6) => hotp(key, stepOf(ms), digits);

/**
 * The step `code` matches within ±`window` steps of `ms`, or null. Only steps above `afterStep` count, so a code is used once
 * (replay protection: the caller stores the returned step as its new afterStep). Constant-time compare per candidate.
 */
export function verifyTotp(key, code, ms, { window = 1, afterStep = -1 } = {}) {
  if (typeof code !== 'string' || !/^[0-9]{6}$/.test(code)) return null;
  const now = stepOf(ms);
  let hit = null;
  for (let s = now - window; s <= now + window; s++) {
    if (s <= afterStep) continue;
    if (crypto.timingSafeEqual(Buffer.from(hotp(key, s)), Buffer.from(code)) && hit === null) hit = s;
  }
  return hit;
}

export const otpauthUri = (secretB32, { label = 'owner', issuer = 'Laneboard' } = {}) =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP_S}`;
