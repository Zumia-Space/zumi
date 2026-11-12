// Store key tool (ADR 2026-11-11-pack-system). Prints key ids, paths and verdicts only; never key material.
//   node scripts/market-key.mjs new --role store|spare --out <dir outside every repo>   -> <dir>/zumi-market-<role>.key + .pub
//   node scripts/market-key.mjs sign --key <file.key> <file> [--trusted "<one line>"]   -> <file>.minisig
//   node scripts/market-key.mjs verify --pub <file.pub>[,<file.pub>] <file>            -> exit 0 ok, 1 refused
//   node scripts/market-key.mjs check-key --key <file.key> --pub <file.pub>            -> the key signs what the pub verifies
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { generateKeyPair, keyIdOf, parsePublicKey, publicKeyText, signMinisign, verifyMinisign } from '../tauri/sidecar/market-sign.mjs';

const [cmd, ...rest] = process.argv.slice(2);
const opt = (name) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };
const positional = rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1].startsWith('--')));
const die = (msg, code = 2) => { console.error(`market-key: ${msg}`); process.exit(code); };

function insideGitRepo(dir) {
  try { execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { stdio: 'pipe' }); } catch { return false; }
  try { execFileSync('git', ['-C', dir, 'check-ignore', '-q', path.join(dir, 'probe.key')], { stdio: 'pipe' }); return false; } catch { return true; }
}

function readKey(file) {
  const k = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (k.format !== 'zumi-market-key/1') die(`${file} is not a zumi-market key`);
  return { keyNum: Buffer.from(k.keyNum, 'hex'), privatePem: k.privatePem, keyId: k.keyId, role: k.role };
}

if (cmd === 'new') {
  const role = opt('role'); const out = opt('out');
  if (!['store', 'spare'].includes(role) || !out) die('usage: new --role store|spare --out <dir>');
  fs.mkdirSync(out, { recursive: true });
  if (insideGitRepo(out)) die(`${out} is inside a git work tree and not ignored; a store key lives outside every repo`);
  const keyFile = path.join(out, `zumi-market-${role}.key`);
  if (fs.existsSync(keyFile)) die(`${keyFile} exists; refusing to overwrite a key`);
  const pair = generateKeyPair();
  const body = { format: 'zumi-market-key/1', role, keyId: keyIdOf(pair), created: new Date().toISOString(), keyNum: pair.keyNum.toString('hex'), privatePem: pair.privatePem };
  fs.writeFileSync(keyFile, JSON.stringify(body, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  fs.writeFileSync(path.join(out, `zumi-market-${role}.pub`), publicKeyText(pair), { flag: 'wx' });
  console.log(`new ${role} key ${keyIdOf(pair)}: ${keyFile} (+ .pub)`);
} else if (cmd === 'sign') {
  const keyFile = opt('key'); const file = positional[0];
  if (!keyFile || !file) die('usage: sign --key <file.key> <file>');
  const key = readKey(keyFile);
  const sig = signMinisign(fs.readFileSync(file), key, opt('trusted') ? { trusted: opt('trusted') } : {});
  fs.writeFileSync(`${file}.minisig`, sig);
  console.log(`signed ${path.basename(file)} with key ${key.keyId} -> ${path.basename(file)}.minisig`);
} else if (cmd === 'verify') {
  const pubs = (opt('pub') || '').split(',').filter(Boolean).map((p) => parsePublicKey(fs.readFileSync(p, 'utf8')));
  const file = positional[0];
  if (!pubs.length || !file) die('usage: verify --pub <file.pub>[,...] <file>');
  const v = verifyMinisign(fs.readFileSync(file), fs.readFileSync(`${file}.minisig`, 'utf8'), pubs);
  console.log(v.ok ? `OK ${path.basename(file)} signed by ${v.keyId} (trusted: ${v.trusted})` : `REFUSED ${path.basename(file)} [${v.code}] ${v.message}`);
  process.exit(v.ok ? 0 : 1);
} else if (cmd === 'check-key') {
  const key = readKey(opt('key')); const pub = parsePublicKey(fs.readFileSync(opt('pub'), 'utf8'));
  const probe = Buffer.from(`key check ${Date.now()}`);
  const v = verifyMinisign(probe, signMinisign(probe, key), [pub]);
  console.log(v.ok ? `OK key ${key.keyId} (${key.role}) signs what ${path.basename(opt('pub'))} verifies` : `MISMATCH [${v.code}]`);
  process.exit(v.ok ? 0 : 1);
} else {
  die('commands: new, sign, verify, check-key');
}
