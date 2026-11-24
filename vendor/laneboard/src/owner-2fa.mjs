// Owner second factor (W-42 5A contract rev 3, section 3.7; ADR w42/decisions/2026-11-20-owner-2fa.md).
// A TOTP code is entered once per owner device; the device then satisfies the owner-only acts for 30 days, sliding, until revoked.
// State: <data>/owner-2fa.json (0600, temp then rename; never the journal, so a rollback starts and an old release ignores it).
// The seed is AES-256-GCM encrypted with the key in BOARD_OWNER_2FA_KEY_FILE; backup codes are scrypt hashes; device secrets sha256.
// Audit: <data>/owner-audit.ndjson, one fsynced line per step-up, failed code, enrolment, owner-only act and revoke. No code value
// and no secret is ever written to either file or to the console.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BoardError } from './ops.mjs';
import { base32Encode, verifyTotp, otpauthUri } from './totp.mjs';

const DEVICE_TTL_MS = 30 * 24 * 3600000;
const LOCK = { fails: 5, windowMs: 15 * 60000, lockMs: 15 * 60000 };
const SLIDE_SAVE_MS = 3600000; // a sliding expiry is persisted at most once per hour per device
const BACKUP_CODES = 10;
const SCRYPT = { N: 16384, r: 8, p: 1 };
export const COOKIE = 'lb_owner_dev';

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
/** The key file holds 32 bytes as 64 hex characters or base64 (e.g. `openssl rand -base64 32`). */
export function readKeyFile(file) {
  const text = fs.readFileSync(file, 'utf8').trim();
  const key = /^[0-9a-f]{64}$/i.test(text) ? Buffer.from(text, 'hex') : Buffer.from(text, 'base64');
  if (key.length !== 32) throw new Error('BOARD_OWNER_2FA_KEY_FILE must hold 32 bytes (64 hex characters or base64)');
  return key;
}
function seal(key, plain) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64') };
}
function unseal(key, box) {
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
    d.setAuthTag(Buffer.from(box.tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(box.ct, 'base64')), d.final()]);
  } catch { return null; } // wrong key or a tampered file: no seed, every code is refused (fail closed)
}
const normBackup = s => String(s).toUpperCase().replace(/[^A-Z2-7]/g, '');
const hashBackup = (code, salt) => crypto.scryptSync(normBackup(code), Buffer.from(salt, 'base64'), 32, SCRYPT).toString('base64');
const newBackupCodes = () => Array.from({ length: BACKUP_CODES }, () => { const c = base32Encode(crypto.randomBytes(7)).slice(0, 10); return `${c.slice(0, 5)}-${c.slice(5)}`; });

/**
 * @param {string} dataDir
 * @param {object} o
 * @param {() => number} o.now
 * @param {Buffer|null} o.key        32-byte seed key; null = 2FA off (every owner-only act 503 owner_2fa_off)
 * @param {string} [o.enrolUntil]    ISO time: the first enrolment is open until then (BOARD_OWNER_2FA_ENROL_UNTIL)
 */
export function openOwner2fa(dataDir, { now = Date.now, key = null, enrolUntil = '' } = {}) {
  const file = path.join(dataDir, 'owner-2fa.json'), auditFile = path.join(dataDir, 'owner-audit.ndjson');
  let st = { enrolled_at: null, seed: null, pending: null, backup: [], last_step: -1, fails: [], locked_until: null, next_device: 1, devices: [] };
  try { st = { ...st, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch (e) { if (e.code !== 'ENOENT') throw new Error(`owner-2fa.json unreadable: ${e.message}`); }
  const iso = (ms = now()) => new Date(ms).toISOString();
  const save = () => { const staged = file + '.tmp'; fs.writeFileSync(staged, JSON.stringify(st), { mode: 0o600 }); fs.renameSync(staged, file); };
  let auditFd = null;
  function audit(entry) {
    auditFd ??= fs.openSync(auditFile, 'a', 0o600);
    fs.writeSync(auditFd, JSON.stringify({ at: iso(), ...entry }) + '\n');
    fs.fsyncSync(auditFd);
  }
  // The view + comment release runs with 2FA off: every owner-only act (pin, archive, restore, bulk removal, device revoke,
  // enrolment and step-up) is refused here, in the owner's words, until the 2FA release turns it on.
  const needKey = () => { if (!key) throw new BoardError(503, 'owner_2fa_off', { message: 'BLOCKED owner-only act / WHY chưa bật mã 2 lớp: the owner second factor is off on this board (BOARD_OWNER_2FA=off or no BOARD_OWNER_2FA_KEY_FILE) / DO wait for the 2FA release; viewing, comments and small edits still work' }); };
  const enrolOpen = () => !!enrolUntil && now() < Date.parse(enrolUntil);
  const lockedMs = () => (st.locked_until && Date.parse(st.locked_until) > now() ? Date.parse(st.locked_until) - now() : 0);
  function checkLock() {
    const ms = lockedMs();
    if (ms) throw new BoardError(429, 'totp_locked', { retry_after_s: Math.ceil(ms / 1000), message: 'BLOCKED owner code / WHY five wrong codes in 15 minutes / DO wait, then enter a fresh code' });
  }
  function failed(reason, extra = {}) {
    const t = now();
    st.fails = [...st.fails.filter(x => t - x < LOCK.windowMs), t];
    if (st.fails.length >= LOCK.fails) { st.locked_until = iso(t + LOCK.lockMs); st.fails = []; }
    save();
    audit({ event: 'code_failed', ok: false, reason, ...extra });
    throw new BoardError(400, 'totp_invalid', { message: 'BLOCKED owner code / WHY the code is wrong or was already used / DO enter the current code from the authenticator app' });
  }
  /** Verifies a TOTP code against a sealed seed; returns the step it used (and stores it: each step is accepted once). */
  function useCode(box, code, extra) {
    const seed = box && unseal(key, box);
    if (!seed) return failed('seed_unreadable', extra);
    const step = verifyTotp(seed, code, now(), { afterStep: st.last_step });
    if (step === null) return failed('wrong_or_used', extra);
    st.last_step = step; st.fails = [];
    return step;
  }
  function useBackup(code, extra) {
    const hit = st.backup.find(b => !b.used_at && crypto.timingSafeEqual(Buffer.from(hashBackup(code, b.salt)), Buffer.from(b.hash)));
    if (!hit) return failed('backup_wrong_or_used', extra);
    hit.used_at = iso(); st.fails = [];
    return null;
  }
  function newDevice({ kind, label, tokenId }, step, via) {
    const id = `dv-${st.next_device++}`, t = now();
    const secret = kind === 'browser' ? crypto.randomBytes(32).toString('base64url') : null;
    st.devices.push({ id, kind, label: label || (kind === 'browser' ? 'browser' : 'app'), ...(tokenId ? { token_id: tokenId } : {}), ...(secret ? { secret_sha256: sha(secret) } : {}),
      created_at: iso(t), last_used_at: iso(t), expires_at: iso(t + DEVICE_TTL_MS), revoked_at: null, via_step: step, via });
    return { id, cookie: secret ? `${id}.${secret}` : null };
  }
  const live = d => d && !d.revoked_at && Date.parse(d.expires_at) > now();
  function slide(d) {
    const t = now(), prev = Date.parse(d.last_used_at);
    d.last_used_at = iso(t); d.expires_at = iso(t + DEVICE_TTL_MS);
    if (t - prev >= SLIDE_SAVE_MS) save();
  }

  return {
    get configured() { return !!key; },
    get enrolled() { return !!st.enrolled_at; },
    audit,
    needKey,
    view(currentId) {
      return { twofa: key ? 'on' : 'off', enrolled: !!st.enrolled_at, enrolled_at: st.enrolled_at, enrol_open: !st.enrolled_at && enrolOpen(), key_configured: !!key, locked_until: lockedMs() ? st.locked_until : null,
        devices: st.devices.map(d => ({ id: d.id, kind: d.kind, label: d.label, ...(d.token_id ? { token_id: d.token_id } : {}), created_at: d.created_at, last_used_at: d.last_used_at, expires_at: d.expires_at, revoked_at: d.revoked_at, current: d.id === currentId })) };
    },
    /** A pending seed + backup codes, returned once. `reenrol` = the caller is an owner device (needed once enrolled). */
    enrol({ reenrol = false } = {}) {
      needKey();
      if (st.enrolled_at && !reenrol) throw new BoardError(409, 'already_enrolled', { message: 'BLOCKED enrolment / WHY the owner is already enrolled / DO re-enrol from an owner device (step up first)' });
      if (!st.enrolled_at && !enrolOpen()) throw new BoardError(409, 'enrol_closed', { message: 'BLOCKED enrolment / WHY the enrol window is closed / DO open BOARD_OWNER_2FA_ENROL_UNTIL for a short window at deploy, while the owner is present' });
      const seed = crypto.randomBytes(20), codes = newBackupCodes();
      st.pending = { seed: seal(key, seed), backup: codes.map(c => { const salt = crypto.randomBytes(16).toString('base64'); return { salt, hash: hashBackup(c, salt), used_at: null }; }), created_at: iso() };
      save();
      audit({ event: reenrol ? 'reenrol_started' : 'enrol_started', ok: true });
      const b32 = base32Encode(seed);
      return { seed_base32: b32, otpauth_uri: otpauthUri(b32), backup_codes: codes };
    },
    /** Confirms the pending seed with a code from it; the confirming client becomes an owner device. */
    confirm(code, device) {
      needKey(); checkLock();
      if (!st.pending) throw new BoardError(409, 'not_enrolled', { message: 'BLOCKED confirm / WHY no enrolment is pending / DO start the enrolment first' });
      const step = useCode(st.pending.seed, code, { stage: 'confirm' });
      const reenrol = !!st.enrolled_at;
      st.seed = st.pending.seed; st.backup = st.pending.backup; st.pending = null; st.enrolled_at = iso();
      const dev = newDevice(device, step, 'totp');
      save();
      audit({ event: reenrol ? 'reenrolled' : 'enrolled', ok: true, device_id: dev.id, step });
      return dev;
    },
    /** A TOTP code or a backup code makes this client an owner device. */
    stepUp({ code, backup_code }, device) {
      needKey(); checkLock();
      if (!st.enrolled_at) throw new BoardError(409, 'not_enrolled', { message: 'BLOCKED step-up / WHY the owner has not enrolled a second factor / DO enrol first' });
      const step = code ? useCode(st.seed, code, { stage: 'step_up' }) : useBackup(backup_code, { stage: 'step_up' });
      const dev = newDevice(device, step, code ? 'totp' : 'backup');
      save();
      audit({ event: 'step_up', ok: true, device_id: dev.id, ...(step !== null ? { step } : { backup: true }) });
      return dev;
    },
    /** The live browser device a cookie names, or null. Slides its expiry. */
    browserDevice(cookie) {
      const m = /^(dv-[0-9]+)\.([A-Za-z0-9_-]{20,})$/.exec(cookie || '');
      if (!m || !key) return null;
      const d = st.devices.find(x => x.id === m[1] && x.kind === 'browser');
      if (!live(d) || !crypto.timingSafeEqual(Buffer.from(sha(m[2])), Buffer.from(d.secret_sha256))) return null;
      slide(d); return d.id;
    },
    /** The live token device bound to an app token id, or null. Slides its expiry. */
    tokenDevice(tokenId) {
      if (!key) return null;
      const d = st.devices.find(x => x.kind === 'token' && x.token_id === tokenId && live(x));
      if (!d) return null;
      slide(d); return d.id;
    },
    revoke(deviceId) {
      const d = st.devices.find(x => x.id === deviceId);
      if (!d) throw new BoardError(404, 'device_not_found', { device_id: deviceId });
      if (!d.revoked_at) { d.revoked_at = iso(); save(); }
      return { id: d.id, revoked_at: d.revoked_at };
    },
    close() { if (auditFd !== null) fs.closeSync(auditFd); auditFd = null; }
  };
}

/** The value of one cookie in a Cookie header, or ''. */
export function cookieValue(header, name) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}
export const setCookieHeader = value => `${COOKIE}=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${DEVICE_TTL_MS / 1000}`;
