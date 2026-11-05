'use strict';
// Shared DPAPI key store for the BYO voice providers (T-31 talk-mode, PLAN section 10.1). Lifted from leda-tts.js's
// own store so every provider is stored with the SAME rules: <userData>/<file> encrypted with the OS key through
// safeStorage, imported once from <userData>/<importFile> then destroyed, shape-gated, and with NO plaintext fallback
// when the OS cannot encrypt (same as cloud.js). The key never reaches the renderer, logs, error strings or argv.
//
// One instance per provider file, so switching providers never deletes another provider's key.
const fs = require('node:fs');
const path = require('node:path');

/**
 * @param {object} o
 * @param {{isEncryptionAvailable():boolean, encryptString(s:string):Buffer, decryptString(b:Buffer):string}} o.safeStorage
 * @param {string} o.dir          userData
 * @param {string} o.file         encrypted key file name (e.g. 'google-tts-key.bin')
 * @param {string} [o.importFile] one-time plaintext import file name; imported then destroyed
 * @param {RegExp} o.shape        the key's shape gate (a shape check, never a secret check)
 * @param {(m:string)=>void} [o.log]
 * @param {string} [o.label]      log prefix (e.g. 'google')
 */
function createKeyStore({ safeStorage, dir, file, importFile = null, shape, log = () => {}, label = 'tts' } = {}) {
  const bin = path.join(dir, file);
  const imp = importFile ? path.join(dir, importFile) : null;
  const available = () => { try { return safeStorage.isEncryptionAvailable(); } catch { return false; } };
  const okShape = (v) => typeof v === 'string' && shape.test(v);
  function importIfPresent() {
    if (!imp || !fs.existsSync(imp)) return 'none';
    if (!available()) { log(`${label} key import skipped: OS encryption unavailable`); return 'no-encryption'; }
    const raw = fs.readFileSync(imp, 'utf8').trim();
    try {
      if (!okShape(raw)) { log(`${label} key import refused: unexpected format`); return 'bad-format'; }
      const tmp = `${bin}.tmp`;
      fs.writeFileSync(tmp, safeStorage.encryptString(raw));
      fs.renameSync(tmp, bin);
      log(`${label} key imported (encrypted with the OS key)`);
      return 'imported';
    } finally {
      try { fs.writeFileSync(imp, Buffer.alloc(Math.max(64, raw.length), 0)); fs.unlinkSync(imp); } catch { /* best effort */ }
    }
  }
  function read() {
    if (!available() || !fs.existsSync(bin)) return null;
    try { const k = safeStorage.decryptString(fs.readFileSync(bin)); return okShape(k) ? k : null; } catch { return null; }
  }
  // Settings panel "set/replace key" -- validated here too so a bad paste never reaches disk.
  function write(raw) {
    const k = String(raw || '').trim();
    if (!okShape(k)) return false;
    if (!available()) return false;
    fs.writeFileSync(bin, safeStorage.encryptString(k));
    return true;
  }
  function clear() { try { fs.unlinkSync(bin); } catch { /* already gone */ } }
  return { importIfPresent, read, write, clear, available, file: bin };
}

module.exports = { createKeyStore };
