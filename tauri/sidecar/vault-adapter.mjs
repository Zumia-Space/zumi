// T-31 parity step 5: Electron `safeStorage` stand-in for the sidecar, backed by the zumi-vault.exe helper (DPAPI).
//
// Why a helper process and not an async host request: every key-store module calls safeStorage SYNCHRONOUSLY inside
// synchronous code (reflex-jev.js createKeyStore, cloud.js, leda-tts.js, board-secrets.mjs), and the freeze rule
// forbids rewriting them. So the three methods here are synchronous too: execFileSync on the helper, data on
// stdin/stdout only. Decision record: docs/decisions/2026-10-20-preview-secret-backend.md (gate: GATE-step5.md).
//
// Rules this file enforces (scripts/check-tauri-vault.mjs + check-tauri-vault-leaks.mjs prove them):
//  - The helper path is accepted only if it is absolute, its file name is EXACTLY `zumi-vault.exe`, and its real parent
//    dir equals the host exe's dir (the host passes both: `--vault-exe`, `--host-dir`). Otherwise isEncryptionAvailable()
//    is false and one fixed code word is logged. No PATH lookup, ever.
//  - argv is exactly [verb]. Secrets travel on stdin/stdout; there are no temp files and no shell.
//  - A failure rethrows a FRESH Error with a fixed message. The original error carries .stdout (possibly plaintext),
//    .stderr, .cmd and .cause, and sidecar dispatch() returns `e.message` to the renderer, so none of it may escape
//    (ETIMEDOUT and maxBuffer errors included: both carry partial stdout).
//  - The only text this file ever logs is a fixed code word.
import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const VAULT_EXE_NAME = 'zumi-vault.exe';
export const ENCRYPT_FAILED = 'vault_encrypt_failed';
export const DECRYPT_FAILED = 'vault_decrypt_failed';
const SPAWN_TIMEOUT_MS = 5000;
const MAX_BUFFER = 256 * 1024;
const ENV_KEYS = ['SystemRoot', 'USERPROFILE', 'APPDATA'];

// Real-path comparison. Windows paths are case-insensitive, so fold case there only.
function samePath(a, b) {
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  return norm(a) === norm(b);
}

/**
 * Validate the helper location. Returns `{ ok: true, exe }` or `{ ok: false, code }` (code is a fixed word).
 * `exe` is the resolved absolute path to execute.
 */
export function validateVaultExe(vaultExe, hostDir, fsImpl = fs) {
  if (typeof vaultExe !== 'string' || typeof hostDir !== 'string' || !vaultExe || !hostDir) return { ok: false, code: 'vault_exe_missing' };
  if (!path.isAbsolute(vaultExe) || !path.isAbsolute(hostDir)) return { ok: false, code: 'vault_exe_rejected' };
  if (path.basename(vaultExe) !== VAULT_EXE_NAME) return { ok: false, code: 'vault_exe_rejected' };
  try {
    if (!fsImpl.statSync(vaultExe).isFile()) return { ok: false, code: 'vault_exe_rejected' };
    const realDir = fsImpl.realpathSync(path.dirname(vaultExe));
    const realHost = fsImpl.realpathSync(hostDir);
    if (!samePath(realDir, realHost)) return { ok: false, code: 'vault_exe_rejected' };
    return { ok: true, exe: path.join(realDir, VAULT_EXE_NAME) };
  } catch {
    return { ok: false, code: 'vault_exe_missing' };
  }
}

// Exported so the check can assert the exact options: no shell, hidden window, bounded time and output, tiny env.
export function spawnOptions(input) {
  const env = {};
  for (const k of ENV_KEYS) if (process.env[k] !== undefined) env[k] = process.env[k];
  const opts = { windowsHide: true, timeout: SPAWN_TIMEOUT_MS, maxBuffer: MAX_BUFFER, stdio: ['pipe', 'pipe', 'pipe'], env, shell: false };
  if (input !== undefined) opts.input = input;
  return opts;
}

/**
 * `{ isEncryptionAvailable, encryptString, decryptString }` with Electron's exact synchronous signatures.
 * `execFileSync` and `fsImpl` are injectable for the unit checks only.
 */
export function createVaultSafeStorage({ vaultExe, hostDir, log = () => {}, execFileSync = childProcess.execFileSync, fsImpl = fs } = {}) {
  const v = validateVaultExe(vaultExe, hostDir, fsImpl);
  if (!v.ok) log(v.code); // leak-ok: v.code is one of the fixed words returned by validateVaultExe
  const run = (verb, input) => execFileSync(v.exe, [verb], spawnOptions(input));

  // The `available` verb runs once at creation; the verdict is cached (PLAN §6).
  let available = false;
  if (v.ok) {
    try {
      run('available');
      available = true;
      log('vault_ready');
    } catch {
      log('vault_probe_failed');
    }
  }

  return {
    isEncryptionAvailable: () => available,
    encryptString(plainText) {
      try {
        if (!available || typeof plainText !== 'string') throw 0;
        const out = run('protect', Buffer.from(plainText, 'utf8'));
        if (!Buffer.isBuffer(out) || out.length === 0) throw 0;
        return out;
      } catch {
        throw new Error(ENCRYPT_FAILED);
      }
    },
    decryptString(blob) {
      try {
        if (!available || !(blob instanceof Uint8Array)) throw 0;
        const out = run('unprotect', Buffer.from(blob));
        if (!Buffer.isBuffer(out)) throw 0;
        const text = out.toString('utf8');
        out.fill(0);
        return text;
      } catch {
        throw new Error(DECRYPT_FAILED);
      }
    },
  };
}
