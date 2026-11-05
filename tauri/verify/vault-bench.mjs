// T-31 parity step 5 (GATE-step5 Q3 + condition 9): latency harness for the vault helper, and the V7 call loop.
// Plain Node, no window. THE GATE NUMBERS COME FROM THE SPARE PC (V6); numbers from the build PC are informational only.
//
//   node tauri/verify/vault-bench.mjs [--exe <abs zumi-vault.exe>] [--n 50] [--warmup 5] [--out <json>]
//        p50/p95 of N protect and N unprotect spawns (warm, after WARMUP discarded), plus the `talk.voiceProviders` shape:
//        5 voice keys decrypted back to back per call, N calls. Exit 1 if a frozen threshold is missed.
//   node tauri/verify/vault-bench.mjs --loop 20 [--pause 400]
//        V7: 20 spawns with a pause between them, so a screenshot burst can look for a flashing console window.
//
// Frozen thresholds (GATE-step5 Q3): p95 unprotect <= 60 ms per spawn; voiceProviders with 5 keys <= 300 ms.
// A miss returns approach B (named pipe) to the gate. No cache is added to pass it (Electron decrypts on every call too).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createVaultSafeStorage } from '../sidecar/vault-adapter.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : dflt; };
const THRESHOLD_UNPROTECT_P95_MS = 60;
const THRESHOLD_VOICE_PROVIDERS_MS = 300;

function findExe() {
  if (arg('--exe')) return path.resolve(arg('--exe'));
  if (process.env.ZUMI_VAULT_EXE) return path.resolve(process.env.ZUMI_VAULT_EXE);
  const c = ['release', 'debug'].map((p) => path.join(ROOT, 'tauri', 'src-tauri', 'target', p, 'zumi-vault.exe')).filter((p) => fs.existsSync(p));
  return c.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || null;
}

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
const stats = (xs) => { const s = [...xs].sort((a, b) => a - b); return { n: s.length, p50: +pct(s, 50).toFixed(1), p95: +pct(s, 95).toFixed(1), max: +s[s.length - 1].toFixed(1), min: +s[0].toFixed(1) }; };
const time = (fn) => { const t = process.hrtime.bigint(); fn(); return Number(process.hrtime.bigint() - t) / 1e6; };

const exe = findExe();
if (!exe) { console.log('FAIL no zumi-vault.exe found (build: cargo build --release --manifest-path tauri/src-tauri/Cargo.toml --bins)'); process.exit(1); }
const ss = createVaultSafeStorage({ vaultExe: exe, hostDir: path.dirname(exe) });
if (!ss.isEncryptionAvailable()) { console.log('FAIL the helper is not available (self-check failed)'); process.exit(1); }

const loop = Number(arg('--loop', 0));
if (loop > 0) {
  const pause = Number(arg('--pause', 400));
  const blob = ss.encryptString('ZVBENCH-loop');
  console.log(`V7 loop: ${loop} protect/unprotect pairs, ${pause} ms apart. Take the screenshot burst NOW; any console window flash is a FAIL.`);
  const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  for (let i = 0; i < loop; i++) { ss.decryptString(blob); ss.encryptString(`ZVBENCH-${i}`); sleep(pause); }
  console.log('V7 loop done');
  process.exit(0);
}

const N = Number(arg('--n', 50));
const WARM = Number(arg('--warmup', 5));
const key = `sk-or-v1-${crypto.randomBytes(24).toString('hex')}`; // a runtime fake, never printed
const blob = ss.encryptString(key);
const voiceBlobs = Array.from({ length: 5 }, (_, i) => ss.encryptString(`AIza${crypto.randomBytes(24).toString('hex').slice(0, 35)}${i}`));

for (let i = 0; i < WARM; i++) { ss.decryptString(blob); ss.encryptString(key); }
const protectMs = [], unprotectMs = [], voiceMs = [];
for (let i = 0; i < N; i++) protectMs.push(time(() => ss.encryptString(key)));
for (let i = 0; i < N; i++) unprotectMs.push(time(() => ss.decryptString(blob)));
// talk.voiceProviders: hasKey() -> read() -> decryptString once per voice provider (up to 5) per call.
for (let i = 0; i < N; i++) voiceMs.push(time(() => { for (const b of voiceBlobs) ss.decryptString(b); }));

const result = {
  at: new Date().toISOString(),
  exe: path.basename(exe),
  node: process.version,
  host: process.env.COMPUTERNAME ? 'named' : 'unnamed',
  protect: stats(protectMs),
  unprotect: stats(unprotectMs),
  voiceProviders5: stats(voiceMs),
  thresholds: { unprotectP95Ms: THRESHOLD_UNPROTECT_P95_MS, voiceProviders5Ms: THRESHOLD_VOICE_PROVIDERS_MS },
};
result.pass = result.unprotect.p95 <= THRESHOLD_UNPROTECT_P95_MS && result.voiceProviders5.p95 <= THRESHOLD_VOICE_PROVIDERS_MS;
console.log(JSON.stringify(result, null, 2));
if (arg('--out')) fs.writeFileSync(path.resolve(arg('--out')), JSON.stringify(result, null, 2));
console.log(result.pass ? 'PASS thresholds (informational unless this ran on the spare PC)' : 'FAIL a frozen threshold was missed: return approach B to the gate, add no cache');
process.exit(result.pass ? 0 : 1);
