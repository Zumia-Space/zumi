// T-31 parity step 5 (GATE-step5 condition 5): drive the real zumi-vault.exe `import-electron` verb against the committed
// Electron 44.5.1 fixture (tauri/verify/fixtures/electron-userdata/, generated on the spare PC by vault-fixture-writer.cjs).
//
//   node tauri/verify/vault-fixture-check.mjs [--expect imported|foreign] [--exe <abs zumi-vault.exe>]
//
//   --expect imported  the box (same Windows user that wrote the fixture): V2, the full import matrix.
//   --expect foreign   any other PC/user: V3, every v10 file -> decrypt_failed, source hash unchanged, no .tmp left.
//   (no flag)          accepts either outcome and says which one it saw.
//
// TODO(box job): the fixture directory is empty until the box generates it. Until then this prints SKIP and exits 0, loudly,
// so the hook is wired and cannot be mistaken for a pass of V1/V2/V3 (see VAULT-BOX-RUNBOOK.md).
import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createVaultSafeStorage } from '../sidecar/vault-adapter.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const FIXTURE = path.join(HERE, 'fixtures', 'electron-userdata');
const arg = (n, d = null) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const expect = arg('--expect');
let pass = 0, fail = 0;
const ok = (c, n, d = '') => { if (c) { pass++; console.log(`PASS ${n}`); } else { fail++; console.log(`FAIL ${n}${d ? '  ' + d : ''}`); } };

const manifestPath = path.join(FIXTURE, 'manifest.json');
if (!fs.existsSync(manifestPath)) {
  console.log('SKIP the Electron fixture is not generated yet (box job: V1 via vault-fixture-writer.cjs, then commit tauri/verify/fixtures/electron-userdata/).');
  console.log('0 passed, 0 failed, 1 skipped');
  process.exit(0);
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

const exe = arg('--exe') || process.env.ZUMI_VAULT_EXE || ['release', 'debug'].map((p) => path.join(ROOT, 'tauri', 'src-tauri', 'target', p, 'zumi-vault.exe')).find((p) => fs.existsSync(p));
if (!exe) { console.log('FAIL no zumi-vault.exe (cargo build --manifest-path tauri/src-tauri/Cargo.toml --bins)'); process.exit(1); }
const ss = createVaultSafeStorage({ vaultExe: path.resolve(exe), hostDir: path.dirname(path.resolve(exe)) });

const SCRATCH = path.join(ROOT, 'tauri', 'src-tauri', 'target', 'vault-fixture-check-tmp');
fs.rmSync(SCRATCH, { recursive: true, force: true });
fs.mkdirSync(SCRATCH, { recursive: true });

const hashDir = (dir) => { const h = crypto.createHash('sha256'); for (const n of fs.readdirSync(dir).sort()) { h.update(n + '\0'); h.update(fs.readFileSync(path.join(dir, n))); } return h.digest('hex'); };
const importInto = (from, to, extra = []) => {
  const r = childProcess.spawnSync(path.resolve(exe), ['import-electron', '--from', from, '--to', to, ...extra], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  let receipt = null;
  try { receipt = JSON.parse(r.stdout); } catch { /* reported below */ }
  return { status: r.status, receipt, stderr: r.stderr };
};
const st = (rcpt, name) => (rcpt.files.find((f) => f.name === name) || {}).status;
const names = Object.keys(manifest.blobs);

ok(manifest.electron === '44.5.1', `fixture was written by Electron 44.5.1`, `manifest says ${manifest.electron}`);
ok(manifest.verdict === 'v10_and_DPAPI', 'V1: every blob starts with v10 and Local State encrypted_key starts with DPAPI', manifest.verdict);
ok(names.length === 11 && names.every((n) => manifest.blobs[n].first3 === 'v10'), 'V1: 11 blobs, first 3 bytes are "v10" for each');
for (const [n, h] of Object.entries(manifest.files)) {
  if (!fs.existsSync(path.join(FIXTURE, n))) { ok(false, `manifest file present: ${n}`); continue; }
  if (crypto.createHash('sha256').update(fs.readFileSync(path.join(FIXTURE, n))).digest('hex') !== h) ok(false, `manifest sha256 matches: ${n}`);
}
const before = hashDir(FIXTURE);

const to = path.join(SCRATCH, 'preview-data');
const run1 = importInto(FIXTURE, to);
ok(run1.status === 0 && run1.receipt, 'import-electron ran (exit 0, receipt JSON)', `${run1.status} ${run1.stderr}`);
ok(hashDir(FIXTURE) === before, 'the Electron fixture dir is byte-identical after the import (copy-only)');
const imported = run1.receipt && names.every((n) => st(run1.receipt, n) === 'imported');
const foreign = run1.receipt && names.every((n) => st(run1.receipt, n) === 'decrypt_failed');
if (expect) ok(expect === 'imported' ? imported : foreign, `expected outcome: ${expect}`, JSON.stringify(run1.receipt && run1.receipt.files.map((f) => f.status)));
else ok(imported || foreign, 'outcome is either a full import (box user) or all decrypt_failed (foreign user)');
console.log(`  (this machine/user saw: ${imported ? 'FULL IMPORT (V2)' : foreign ? 'FOREIGN USER (V3)' : 'MIXED'})`);

if (imported) {
  for (const n of names) {
    let back = null;
    try { back = ss.decryptString(fs.readFileSync(path.join(to, n))); } catch { /* reported by ok */ }
    ok(back === manifest.plain[n], `V2: ${n} unprotect returns the fixture's fake value`);
  }
  ok(!fs.readdirSync(to).some((f) => f.endsWith('.tmp')), 'V2: no .tmp left');
  const r2 = importInto(FIXTURE, to);
  const norm = (r) => JSON.stringify({ ...r, at: 0 });
  ok(r2.receipt && norm(r2.receipt) === norm(run1.receipt), 'V2: rerun is a no-op and the receipt is identical except `at`');
  // pre-seeded stale .tmp
  const to2 = path.join(SCRATCH, 'seeded');
  fs.mkdirSync(to2, { recursive: true });
  fs.writeFileSync(path.join(to2, 'jev-key.bin.tmp'), 'stale');
  const r3 = importInto(FIXTURE, to2);
  ok(r3.receipt && st(r3.receipt, 'jev-key.bin') === 'imported' && !fs.existsSync(path.join(to2, 'jev-key.bin.tmp')), 'V2: a pre-seeded .tmp is deleted and overwritten cleanly');
  // one corrupted source, on a COPY (the committed fixture is never edited)
  const copy = path.join(SCRATCH, 'copy');
  fs.cpSync(FIXTURE, copy, { recursive: true });
  const target = path.join(copy, 'groq-key.bin');
  const bytes = fs.readFileSync(target); bytes[bytes.length - 1] ^= 0xff; fs.writeFileSync(target, bytes);
  const copyBefore = hashDir(copy);
  const r4 = importInto(copy, path.join(SCRATCH, 'corrupt-to'));
  ok(r4.receipt && st(r4.receipt, 'groq-key.bin') === 'decrypt_failed' && names.filter((n) => n !== 'groq-key.bin').every((n) => st(r4.receipt, n) === 'imported'), 'V2: one corrupted source fails alone');
  ok(hashDir(copy) === copyBefore, 'V2: the corrupted source is byte-identical afterwards');
  // Local State removed
  fs.rmSync(path.join(copy, 'Local State'));
  const r5 = importInto(copy, path.join(SCRATCH, 'nols-to'));
  ok(r5.receipt && names.every((n) => st(r5.receipt, n) === 'no_master_key'), 'V2: Local State removed -> every v10 file reports no_master_key');
} else if (foreign) {
  ok(!fs.readdirSync(to).some((f) => f.endsWith('.tmp')), 'V3: no .tmp left');
  ok(names.every((n) => !fs.existsSync(path.join(to, n))), 'V3: no key file was written for a foreign blob');
}

fs.rmSync(SCRATCH, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
