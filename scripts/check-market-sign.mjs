// check:market-sign (MKT phase 0/1). The store index is signed with minisign (ed25519, prehashed BLAKE2b-512), the same
// scheme as the app updater, so a stock `minisign -V` and the Rust `minisign-verify` crate read the same files.
// Plain Node, no network, no key on disk: every key here is generated in memory for the run.
import crypto from 'node:crypto';

import { generateKeyPair, keyIdOf, parsePublicKey, publicKeyText, signMinisign, verifyMinisign } from '../tauri/sidecar/market-sign.mjs';

let pass = 0, fail = 0;
const ok = (c, name, detail = '') => { if (c) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${detail ? `  ${detail}` : ''}`); } };

const a = generateKeyPair();
const b = generateKeyPair();
const msg = Buffer.from('{"format":"zumi-market/1","serial":1,"packs":[]}');
const sig = signMinisign(msg, a, { trusted: 'zumi-market index serial 1' });
const pubA = parsePublicKey(publicKeyText(a));
const pubB = parsePublicKey(publicKeyText(b));

ok(/^untrusted comment: .*\n[A-Za-z0-9+/=]+\ntrusted comment: zumi-market index serial 1\n[A-Za-z0-9+/=]+\n$/.test(sig), 'the signature has the minisign four-line shape', JSON.stringify(sig));
ok(Buffer.from(sig.split('\n')[1], 'base64').subarray(0, 2).toString('latin1') === 'ED', 'the signature is the prehashed (ED) kind');
ok(pubA.keyId === keyIdOf(a) && /^[0-9A-F]{16}$/.test(pubA.keyId), 'the public key text carries the key id', pubA.keyId);
let v = verifyMinisign(msg, sig, [pubA]);
ok(v.ok && v.trusted === 'zumi-market index serial 1' && v.keyId === pubA.keyId, 'a signed file verifies with its public key', JSON.stringify(v));
v = verifyMinisign(msg, sig, [pubB, pubA]);
ok(v.ok, 'it verifies when its key is one of several trusted keys (active + spare)', JSON.stringify(v));
const changed = Buffer.from(msg); changed[5] ^= 1;
v = verifyMinisign(changed, sig, [pubA]);
ok(!v.ok && v.code === 'sig_mismatch', 'one changed byte is refused (sig_mismatch)', JSON.stringify(v));
v = verifyMinisign(msg, sig, [pubB]);
ok(!v.ok && v.code === 'sig_key_unknown', 'a signature by a key the app does not hold is refused (sig_key_unknown)', JSON.stringify(v));
const lines = sig.split('\n'); lines[2] = 'trusted comment: zumi-market index serial 99';
v = verifyMinisign(msg, lines.join('\n'), [pubA]);
ok(!v.ok && v.code === 'sig_comment', 'an edited trusted comment is refused (sig_comment)', JSON.stringify(v));
v = verifyMinisign(msg, 'garbage', [pubA]);
ok(!v.ok && v.code === 'sig_format', 'a malformed signature is refused (sig_format)', JSON.stringify(v));
// Same key id, different key: the id is a label, never a credential.
const forged = parsePublicKey(publicKeyText(b)); forged.keyId = pubA.keyId; forged.keyNum = pubA.keyNum;
v = verifyMinisign(msg, sig, [forged]);
ok(!v.ok && v.code === 'sig_mismatch', 'a key that only borrows the key id does not verify', JSON.stringify(v));
// The legacy "Ed" (not prehashed) form is accepted too, as minisign -V does.
{
  const raw = Buffer.from(sig.split('\n')[1], 'base64');
  const keyObj = crypto.createPrivateKey(a.privatePem);
  const legacy = crypto.sign(null, msg, keyObj);
  const tc = 'legacy';
  const glob = crypto.sign(null, Buffer.concat([legacy, Buffer.from(tc)]), keyObj);
  const text = `untrusted comment: x\n${Buffer.concat([Buffer.from('Ed'), raw.subarray(2, 10), legacy]).toString('base64')}\ntrusted comment: ${tc}\n${glob.toString('base64')}\n`;
  v = verifyMinisign(msg, text, [pubA]);
  ok(v.ok, 'the legacy Ed form verifies', JSON.stringify(v));
}

console.log(`check:market-sign: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
