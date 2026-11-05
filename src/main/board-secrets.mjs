// Live-board secrets store + PIN unlock (PLAN-live-board.md Coordinator QC 02-10 note 4; PLAN-user-decision-relay.md
// §7/§11). Main-process only: no Electron import, so Node can test it directly (mirrors board-bridge.mjs and
// cloud.js's createTokenStore).
//
// Two secrets travel together — the zumi-desktop owner bearer token and the nginx basic-auth credential the live
// board's front door requires. The token is OPTIONAL (coordinator decision, auth-approved): a live board reached
// only through the nginx Basic credential attributes writes to the proxy owner, same as the web board's own UI —
// board-bridge.mjs omits X-Laneboard-Token entirely whenever the stored token is empty/absent. user/pass stay
// required; without them there is no way to reach the live board's front door at all.
//
// Settings > "Require PIN for Board" toggle (T-31 voice-P1 follow-up, owner request 08-10): the envelope carries an
// explicit `type` flag deciding HOW the secrets are sealed on disk. Either way they are encrypted at least once:
//   - type 'pin' (default, current behaviour): {token, user, pass} -> JSON -> AES-256-GCM, key = scrypt(pin, salt,
//     N/r/p below). A wrong PIN derives the wrong key, so GCM's own tag check fails closed — there is no separate
//     "is this PIN right" check to get wrong. The resulting envelope {type, v, salt, n, r, p, iv, tag, ct} is then
//     itself run through safeStorage.encryptString() (OS key, DPAPI on Windows) before it ever touches disk.
//   - type 'os': the scrypt+AES-GCM layer is skipped — {type, token, user, pass} goes straight into
//     safeStorage.encryptString(). Protection is then ONLY the OS key (tied to the Windows user session, same as
//     every other DPAPI-sealed app secret) — no PIN exists to ask for, so there is nothing to unlock: `secrets` is
//     populated straight from disk as soon as the controller can read it (construction time, or lazily on first
//     access), and `lock()`/idle-lock are no-ops in this mode (locking would have nothing a PIN re-opens).
// Switching between the two re-seals the SAME secrets under the new scheme (`disablePin`/`enablePin` below); it
// never re-asks for the board username/password. A legacy envelope with no `type` field (written before this flag
// existed) is read as 'pin' — that was the only shape on disk before.
// In EITHER mode the PIN itself (when one exists) is never written anywhere, in any form.
// Backoff state lives in <dir>/board-secrets.meta.json, plaintext (it holds no secret, only counters) and OUTSIDE
// the PIN-wrapped blob on purpose: restarting the app must not reset a brute-force counter. ('os' mode has no PIN
// to brute-force, but the same meta file is reused so a later `enablePin` starts from a clean counter.)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// scrypt params: RFC 7914's interactive minimum is N=2^14; this is 4x that (N=2^16, r=8, p=1 -> ~300ms/derivation on
// a normal desktop CPU, 64 MiB), a deliberately "strong but still a PIN unlock, not a login page" budget.
export const SCRYPT = { N: 2 ** 16, r: 8, p: 1, keylen: 32, maxmem: 256 * 1024 * 1024 };
const SALT_LEN = 16;
const IV_LEN = 12; // AES-GCM standard nonce size
const PIN_SHAPE = /^\d{6}$/; // default and only unlock method today (relay plan §11); pluggable point is `method` below

const BACKOFF_FREE_TRIES = 5;      // this many wrong PINs cost nothing
const BACKOFF_BASE_MS = 1000;      // the 6th wrong PIN costs this much
const BACKOFF_MAX_MS = 30_000;
export const IDLE_LOCK_MS = 15 * 60 * 1000;

// token is optional: empty string or absent both pass (Basic-only / proxy-owner path). user/pass are always required.
const isSecretShape = (s) => Boolean(s) && typeof s === 'object'
  && (s.token === undefined || typeof s.token === 'string')
  && typeof s.user === 'string' && s.user.length > 0
  && typeof s.pass === 'string' && s.pass.length > 0;
// Basic auth sends the stored username verbatim, so "alice " never matches the htpasswd user "alice" (401 on every
// request). Refused at write time with its own error; the UI trims before sending. Passwords are never checked or
// trimmed: a space is a legal password character. Read paths keep isSecretShape only (an old store stays readable).
const hasEdgeWhitespace = (user) => typeof user === 'string' && user.trim() !== user;

function deriveKey(pin, salt, params = SCRYPT) {
  return crypto.scryptSync(pin, salt, SCRYPT.keylen, { N: params.N, r: params.r, p: params.p, maxmem: SCRYPT.maxmem });
}

/** Encrypts `plainObj` under `pin`. Returns the envelope (no secret outside the ct/tag ciphertext). */
function seal(pin, plainObj) {
  const salt = crypto.randomBytes(SALT_LEN);
  const key = deriveKey(pin, salt);
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(plainObj), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { v: 1, n: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: tag.toString('base64'), ct: ct.toString('base64') };
}

/** Decrypts an envelope under `pin`. Throws (wrong PIN or corrupt data — indistinguishable, both fail closed). */
function unseal(pin, envelope) {
  const salt = Buffer.from(envelope.salt, 'base64');
  const key = deriveKey(pin, salt, { N: envelope.n, r: envelope.r, p: envelope.p });
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const pt = Buffer.concat([decipher.update(Buffer.from(envelope.ct, 'base64')), decipher.final()]);
  return JSON.parse(pt.toString('utf8'));
}

/**
 * @param {object} o
 * @param {{isEncryptionAvailable():boolean, encryptString(s:string):Buffer, decryptString(b:Buffer):string}} o.safeStorage
 * @param {string} o.dir          userData-style directory for board-secrets.bin / .meta.json
 * @param {() => number} [o.now]  injectable clock (tests)
 * @param {(msg:string) => void} [o.log]  never passed a secret
 */
export function createSecretsController({ safeStorage, dir, now = Date.now, log = () => {} }) {
  const binFile = path.join(dir, 'board-secrets.bin');
  const metaFile = path.join(dir, 'board-secrets.meta.json');
  let secrets = null;        // decrypted {token,user,pass} while unlocked; null while locked. In memory ONLY.
  let lastActivityAt = now();
  // 'pin' | 'os' | null (nothing configured yet). This controller is the only writer of binFile, so it is kept in
  // sync on every write below rather than re-read from disk on every call — the one disk read happens at
  // construction (below), which for an 'os' envelope also doubles as the no-PIN bootstrap unlock.
  let envelopeType = null;
  let signedOutPending = false; // a failed sign-out delete left files behind: memory stays dropped, status must not re-adopt them

  const available = () => { try { return safeStorage.isEncryptionAvailable(); } catch { return false; } };
  const configured = () => fs.existsSync(binFile);

  /** Reads the on-disk envelope once (construction only) to learn its type — and, for 'os', its plaintext secrets. */
  function bootstrapFromDisk() {
    if (!configured() || !available()) return;
    let raw;
    try { raw = JSON.parse(safeStorage.decryptString(fs.readFileSync(binFile))); } catch { return; }
    if (raw && raw.type === 'os') {
      envelopeType = 'os';
      if (isSecretShape(raw)) { secrets = { token: typeof raw.token === 'string' ? raw.token : '', user: raw.user, pass: raw.pass }; lastActivityAt = now(); }
    } else {
      envelopeType = 'pin'; // legacy envelopes (no `type` field) predate this flag and were always PIN-sealed
    }
  }
  bootstrapFromDisk();

  function readMeta() {
    try { const m = JSON.parse(fs.readFileSync(metaFile, 'utf8')); return { failedAttempts: Number(m.failedAttempts) || 0, lockoutUntil: Number(m.lockoutUntil) || 0 }; }
    catch { return { failedAttempts: 0, lockoutUntil: 0 }; }
  }
  function writeMeta(m) {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${metaFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(m));
    fs.renameSync(tmp, metaFile);
  }
  function backoffRemainingMs() { return Math.max(0, readMeta().lockoutUntil - now()); }

  /**
   * The one PIN gate for every path that REMOVES or REPLACES a store (signOut, configure, configureOs). An unconfigured
   * store has no PIN. Otherwise the file is ALWAYS re-read and re-decrypted here (never the cached type: there is no
   * single-instance lock, so another instance may have changed the store since). A successful decrypt must prove the type: 'os' -> no PIN (and the type is adopted, so an OS store
   * whose startup read failed stops asking for a PIN that does not exist); PIN-sealed -> the CURRENT PIN is required,
   * same unseal and the same wrong-PIN backoff counter (shared meta file) as unlock/disablePin. ANY read or decrypt
   * failure is refused, files and backoff untouched: `io` (read) or `corrupt` (decrypt/parse) can be transient, so it
   * never proves the store holds nothing. Recovery of a truly corrupt or forgotten-PIN store is outside the app
   * (delete board-secrets.bin by hand). Returns null when allowed, else the error object. `what` only labels the log.
   */
  function requirePinForReplace(pin, what) {
    if (!configured()) return null;
    if (!available()) return { ok: false, error: 'no_encryption' };
    let blob;
    try { blob = fs.readFileSync(binFile); } catch { return { ok: false, error: 'io', leftover: [path.basename(binFile)] }; }
    let envelope;
    try { envelope = JSON.parse(safeStorage.decryptString(blob)); } catch { return { ok: false, error: 'corrupt' }; }
    if (!envelope || typeof envelope !== 'object') return { ok: false, error: 'corrupt' };
    if (envelope.type === 'os') {
      envelopeType = 'os';
      if (isSecretShape(envelope)) { secrets = { token: typeof envelope.token === 'string' ? envelope.token : '', user: envelope.user, pass: envelope.pass }; lastActivityAt = now(); }
      return null;
    }
    const remaining = backoffRemainingMs();
    if (remaining > 0) return { ok: false, error: 'backoff', retryAfterMs: remaining };
    if (!PIN_SHAPE.test(String(pin))) return { ok: false, error: 'bad_pin_shape' };
    try {
      if (!isSecretShape(unseal(String(pin), envelope))) throw new Error('bad shape after decrypt');
    } catch {
      const m = readMeta();
      const failedAttempts = m.failedAttempts + 1;
      const over = failedAttempts - BACKOFF_FREE_TRIES;
      const lockoutUntil = over > 0 ? now() + Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (over - 1)) : 0;
      writeMeta({ failedAttempts, lockoutUntil });
      log(`board ${what} refused: wrong PIN (attempt ${failedAttempts})`);
      return { ok: false, error: 'wrong_pin', retryAfterMs: Math.max(0, lockoutUntil - now()) };
    }
    return null;
  }

  /**
   * Stores the two live-board secrets, wrapped under `pin`. Re-entering the PIN here doubles as the "fresh user act"
   * the relay plan (§5) requires for credential changes — there is no separate re-confirm step. Also unlocks the
   * session (the owner just typed the PIN to set it).
   */
  function configure({ token, user, pass, pin, currentPin }) {
    if (!PIN_SHAPE.test(String(pin))) return { ok: false, error: 'bad_pin_shape' };
    if (!isSecretShape({ token, user, pass })) return { ok: false, error: 'bad_secrets_shape' };
    if (hasEdgeWhitespace(user)) return { ok: false, error: 'bad_user_whitespace' };
    if (!available()) return { ok: false, error: 'no_encryption' };
    const gate = requirePinForReplace(currentPin, 'sign-in change');
    if (gate) return gate;
    const tok = typeof token === 'string' ? token : ''; // absent -> '', same as an explicitly empty token
    const envelope = { type: 'pin', ...seal(String(pin), { token: tok, user, pass }) };
    const blob = safeStorage.encryptString(JSON.stringify(envelope));
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${binFile}.tmp`;
    fs.writeFileSync(tmp, blob);
    fs.renameSync(tmp, binFile);
    writeMeta({ failedAttempts: 0, lockoutUntil: 0 });
    secrets = { token: tok, user, pass };
    envelopeType = 'pin';
    signedOutPending = false;
    lastActivityAt = now();
    log('board secrets configured (scrypt+AES-GCM under the PIN, then OS-key encrypted)');
    return { ok: true };
  }

  /**
   * Same as `configure`, but for the "Require PIN for Board" toggle turned OFF: no PIN at all, protection is
   * safeStorage (the OS key) only. Used for a FRESH setup made while the toggle is off (main.js's board-signin
   * first-run form skips the PIN field entirely in that case) — switching an ALREADY-configured install is
   * `disablePin`/`enablePin` below, which re-seal the existing secrets instead of asking for them again.
   */
  function configureOs({ token, user, pass, currentPin }) {
    if (!isSecretShape({ token, user, pass })) return { ok: false, error: 'bad_secrets_shape' };
    if (hasEdgeWhitespace(user)) return { ok: false, error: 'bad_user_whitespace' };
    if (!available()) return { ok: false, error: 'no_encryption' };
    const gate = requirePinForReplace(currentPin, 'sign-in change');
    if (gate) return gate;
    const tok = typeof token === 'string' ? token : '';
    const envelope = { type: 'os', token: tok, user, pass }; // no scrypt/AES-GCM layer -- safeStorage is the only seal
    const blob = safeStorage.encryptString(JSON.stringify(envelope));
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${binFile}.tmp`;
    fs.writeFileSync(tmp, blob);
    fs.renameSync(tmp, binFile);
    writeMeta({ failedAttempts: 0, lockoutUntil: 0 });
    secrets = { token: tok, user, pass };
    envelopeType = 'os';
    signedOutPending = false;
    lastActivityAt = now();
    log('board secrets configured (OS key only, no PIN)');
    return { ok: true };
  }

  function unlock(pin) {
    if (!configured()) return { ok: false, error: 'not_configured' };
    if (envelopeType === 'os') return { ok: true }; // nothing to unlock: bootstrapFromDisk already loaded it, no PIN exists
    const remaining = backoffRemainingMs();
    if (remaining > 0) return { ok: false, error: 'backoff', retryAfterMs: remaining };
    if (!PIN_SHAPE.test(String(pin))) return { ok: false, error: 'bad_pin_shape' };
    if (!available()) return { ok: false, error: 'no_encryption' };
    let envelope;
    try { envelope = JSON.parse(safeStorage.decryptString(fs.readFileSync(binFile))); } catch { return { ok: false, error: 'corrupt' }; }
    try {
      const plain = unseal(String(pin), envelope);
      if (!isSecretShape(plain)) throw new Error('bad shape after decrypt');
      secrets = plain;
      lastActivityAt = now();
      writeMeta({ failedAttempts: 0, lockoutUntil: 0 });
      log('board unlocked');
      return { ok: true };
    } catch {
      const m = readMeta();
      const failedAttempts = m.failedAttempts + 1;
      const over = failedAttempts - BACKOFF_FREE_TRIES;
      const lockoutUntil = over > 0 ? now() + Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (over - 1)) : 0;
      writeMeta({ failedAttempts, lockoutUntil });
      log(`board unlock refused: wrong PIN (attempt ${failedAttempts})`);
      return { ok: false, error: 'wrong_pin', retryAfterMs: Math.max(0, lockoutUntil - now()) };
    }
  }

  /**
   * Turns the PIN requirement OFF: verifies `pin` against the current 'pin' envelope (same unseal + backoff as
   * `unlock`, so a wrong PIN costs the same and changes nothing on disk), then re-seals the SAME secrets as type
   * 'os'. Leaves the session unlocked (the owner just proved the PIN — the same "fresh auth tap" `configure` relies
   * on) and, from here on, `lock()`/idle-lock are no-ops (see their comments).
   */
  function disablePin(pin) {
    if (!configured()) return { ok: false, error: 'not_configured' };
    if (envelopeType === 'os') return { ok: false, error: 'already_os' };
    const remaining = backoffRemainingMs();
    if (remaining > 0) return { ok: false, error: 'backoff', retryAfterMs: remaining };
    if (!PIN_SHAPE.test(String(pin))) return { ok: false, error: 'bad_pin_shape' };
    if (!available()) return { ok: false, error: 'no_encryption' };
    let envelope;
    try { envelope = JSON.parse(safeStorage.decryptString(fs.readFileSync(binFile))); } catch { return { ok: false, error: 'corrupt' }; }
    let plain;
    try {
      plain = unseal(String(pin), envelope);
      if (!isSecretShape(plain)) throw new Error('bad shape after decrypt');
    } catch {
      const m = readMeta();
      const failedAttempts = m.failedAttempts + 1;
      const over = failedAttempts - BACKOFF_FREE_TRIES;
      const lockoutUntil = over > 0 ? now() + Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (over - 1)) : 0;
      writeMeta({ failedAttempts, lockoutUntil });
      log(`board PIN-off refused: wrong PIN (attempt ${failedAttempts})`);
      return { ok: false, error: 'wrong_pin', retryAfterMs: Math.max(0, lockoutUntil - now()) };
    }
    const tok = typeof plain.token === 'string' ? plain.token : '';
    const envelopeOs = { type: 'os', token: tok, user: plain.user, pass: plain.pass };
    const blob = safeStorage.encryptString(JSON.stringify(envelopeOs));
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${binFile}.tmp`;
    fs.writeFileSync(tmp, blob);
    fs.renameSync(tmp, binFile);
    writeMeta({ failedAttempts: 0, lockoutUntil: 0 });
    secrets = { token: tok, user: plain.user, pass: plain.pass };
    envelopeType = 'os';
    lastActivityAt = now();
    log('board PIN requirement turned off (re-sealed under the OS key only)');
    return { ok: true };
  }

  /**
   * Turns the PIN requirement back ON: re-seals the current secrets (already in memory in 'os' mode -- no disk
   * read needed) under a freshly-chosen `newPin`, same scrypt+AES-GCM envelope `configure` writes. No "current
   * PIN" exists to check first (there was none); `newPin`'s only validation is its own shape.
   */
  function enablePin(newPin) {
    if (!configured()) return { ok: false, error: 'not_configured' };
    if (envelopeType === 'pin') return { ok: false, error: 'already_pin' };
    if (!PIN_SHAPE.test(String(newPin))) return { ok: false, error: 'bad_pin_shape' };
    if (!available()) return { ok: false, error: 'no_encryption' };
    if (!secrets) return { ok: false, error: 'corrupt' }; // 'os' mode always loads secrets at bootstrap; defensive only
    const envelope = { type: 'pin', ...seal(String(newPin), secrets) };
    const blob = safeStorage.encryptString(JSON.stringify(envelope));
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${binFile}.tmp`;
    fs.writeFileSync(tmp, blob);
    fs.renameSync(tmp, binFile);
    writeMeta({ failedAttempts: 0, lockoutUntil: 0 });
    envelopeType = 'pin';
    lastActivityAt = now();
    log('board PIN requirement turned on (re-sealed under a new PIN)');
    return { ok: true };
  }

  /**
   * Sign out of Board (T-31-TAURI, Settings > "Sign out of Board"): forgets the stored user/pass/token for good —
   * removes the sealed envelope, its `.tmp` leftovers and the backoff meta, AND the memory copy, so the next launch
   * reads "none". Idempotent: nothing stored -> ok. The PIN rule mirrors `disablePin` and is not weaker: an 'os'
   * install has no PIN, so none is asked; a PIN-sealed one needs the CURRENT PIN (same unseal, same wrong-PIN
   * backoff), so someone at an unlocked desk cannot wipe the credential without it. A wrong PIN changes nothing but
   * the secret-free backoff counter. Fails closed: once the PIN rule passes, the memory copy is dropped BEFORE any
   * disk delete, so a failed delete can never leave a live in-memory sign-in; it returns `{ok:false, error:'io',
   * leftover:[file names]}` (names only) instead of throwing or claiming success.
   */
  function signOut(pin) {
    const gate = requirePinForReplace(pin, 'sign-out');
    if (gate) return gate;
    secrets = null;
    envelopeType = null;
    signedOutPending = true;
    const leftover = [];
    for (const f of [binFile, `${binFile}.tmp`, metaFile, `${metaFile}.tmp`]) {
      try { fs.rmSync(f, { force: true }); } catch { /* reported below via leftover */ }
      if (fs.existsSync(f)) leftover.push(path.basename(f));
    }
    if (leftover.length) {
      log(`board sign-out incomplete: memory cleared, files left: ${leftover.join(', ')}`);
      return { ok: false, error: 'io', leftover };
    }
    signedOutPending = false;
    log('board signed out (stored credentials removed)');
    return { ok: true };
  }

  /** 'os' mode has no PIN to re-enter, so "locking" would just strand the owner with no way back in -- a no-op. */
  function lock(reason = 'manual') {
    if (envelopeType === 'os') return;
    if (secrets) log(`board locked (${reason})`);
    secrets = null;
  }

  /**
   * pinRequired is only true for a store a decrypt proved PIN-sealed (ported from the Tauri tree). A configured store whose
   * type is unknown (startup read failed, or a sign-out delete left the file behind) is retried here once, except right
   * after a failed sign-out (the leftover must not re-adopt the dropped sign-in); if still unknown it reports
   * `unreadable:true` and no PIN requirement, because nothing proves a PIN exists. Unconfigured keeps pinRequired:true.
   */
  function status() {
    const isConfigured = configured();
    if (isConfigured && envelopeType === null && !signedOutPending) bootstrapFromDisk();
    const unreadable = isConfigured && envelopeType === null;
    return { configured: isConfigured, locked: secrets === null, pinRequired: unreadable ? false : envelopeType !== 'os', ...(unreadable ? { unreadable: true } : {}) };
  }
  /** Main-only accessor. Never handed to IPC / the renderer. */
  function getSecrets() { return secrets; }

  function noteActivity() { lastActivityAt = now(); }
  function idleMsSinceActivity() { return now() - lastActivityAt; }
  /** Called from a periodic OS-idle poll (powerMonitor.getSystemIdleTime() * 1000) or the internal activity clock. */
  function checkIdle(idleMs) { if (secrets && idleMs >= IDLE_LOCK_MS) lock('idle'); }

  return {
    configure, configureOs, unlock, lock, disablePin, enablePin, signOut, status, getSecrets, noteActivity, idleMsSinceActivity, checkIdle,
    _test: { backoffRemainingMs, readMeta, envelopeType: () => envelopeType },
  };
}
