// Opt-in seam for GATE-step5 test 9: the module checks (check-brain-key, check-byok, check-board-live,
// check-board-pin-toggle) ship a reversible fake safeStorage. With ZUMI_VAULT_EXE=<absolute zumi-vault.exe> they use the
// REAL vault adapter instead (tauri/sidecar/vault-adapter.mjs -> DPAPI). Unset (the default) changes nothing.
import path from 'node:path';

import { createVaultSafeStorage } from '../../tauri/sidecar/vault-adapter.mjs';

let shared = null;

/** The real adapter wrapped like the fakes (`decrypts` counter, `available` toggle), or null when not opted in. */
export function realSafeStorage({ available = true } = {}) {
  const exe = process.env.ZUMI_VAULT_EXE;
  if (!exe) return null;
  shared ??= createVaultSafeStorage({ vaultExe: exe, hostDir: path.dirname(exe) });
  if (!shared.isEncryptionAvailable()) throw new Error('ZUMI_VAULT_EXE is set but the vault helper is not available');
  const ss = {
    decrypts: 0,
    isEncryptionAvailable: () => available,
    encryptString: (s) => shared.encryptString(s),
    decryptString: (b) => { ss.decrypts++; return shared.decryptString(b); },
  };
  return ss;
}
