// T-31 voice-P1 follow-up check: the Settings "Require PIN for Board" toggle (owner request 08-10) -- the ON<->OFF
// re-seal paths added to board-secrets.mjs (configureOs/disablePin/enablePin) and the envelope's `type` flag they
// read/write. Node only, no Electron. `safeStorage` is the same reversible fake check-board-live.mjs uses: real
// enough to prove "encrypted, not plaintext", not real DPAPI.
//   node scripts/check-board-pin-toggle.mjs   (or: npm run check:board-pin-toggle)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { realSafeStorage } from './lib/real-safe-storage.mjs';
import { createSecretsController } from '../src/main/board-secrets.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: Boolean(ok) }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`); };

const TOKEN = 'lb_FAKEtoken_toggle_1a2b3c';
const USER = 'kei-toggle-user';
const PASS = 'fake-nginx-pass-toggle-9z9z';
const PIN = '482913';
const WRONG_PIN = '000000';
const NEW_PIN = '710824';
const WRONG_NEW_PIN = '111111';
const ALL_SECRETS = [TOKEN, USER, PASS, PIN, WRONG_PIN, NEW_PIN, WRONG_NEW_PIN];

// ZUMI_VAULT_EXE (GATE-step5 test 9) swaps the reversible fake for the real vault adapter; unset keeps the fake.
const fakeSafeStorage = realSafeStorage() || {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from([...Buffer.from(s, 'utf8')].map((b) => b ^ 0x5a)),
  decryptString: (b) => Buffer.from([...b].map((x) => x ^ 0x5a)).toString('utf8'),
};
const unavailableSafeStorage = { ...fakeSafeStorage, isEncryptionAvailable: () => false };

let clock = 1_700_000_000_000;
const now = () => clock;

function mkdtemp(prefix) {
  const dir = path.join(root, `.check-board-pin-toggle-${prefix}-${process.pid}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function rmrf(dir) { fs.rmSync(dir, { recursive: true, force: true }); }

// Every file under `dir`, read as utf8 text, scanned for any secret substring (mirrors check-board-live.mjs).
function scanForPlaintextSecrets(dir, secrets) {
  const hits = [];
  const walk = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, f.name);
      if (f.isDirectory()) { walk(full); continue; }
      const text = fs.readFileSync(full).toString('utf8');
      for (const s of secrets) if (text.includes(s)) hits.push({ file: full, secret: s });
    }
  };
  walk(dir);
  return hits;
}

// ====================================================================================================
// 1. ON -> OFF: a wrong PIN is rejected and changes nothing; the correct PIN re-seals under the OS key only.
// ====================================================================================================
{
  const dir = mkdtemp('on-to-off');
  const log = [];
  try {
    const ctl = createSecretsController({ safeStorage: fakeSafeStorage, dir, now, log: (m) => log.push(m) });
    ctl.configure({ token: TOKEN, user: USER, pass: PASS, pin: PIN });
    check('fresh configure: pin mode, unlocked', ctl._test.envelopeType() === 'pin' && ctl.status().pinRequired === true && ctl.status().locked === false);

    const wrong = ctl.disablePin(WRONG_PIN);
    check('disablePin with the wrong PIN is refused', wrong.ok === false && wrong.error === 'wrong_pin');
    check('a wrong PIN changes nothing: still pin mode, secrets intact', ctl._test.envelopeType() === 'pin' && ctl.getSecrets().token === TOKEN && ctl.getSecrets().pass === PASS);
    check('a failed disablePin never returns a secret', !JSON.stringify(wrong).includes(TOKEN) && !JSON.stringify(wrong).includes(PASS));

    const right = ctl.disablePin(PIN);
    check('disablePin with the correct PIN succeeds', right.ok === true);
    check('after disablePin: envelope is now OS-sealed, status reflects it, stays unlocked', ctl._test.envelopeType() === 'os' && ctl.status().pinRequired === false && ctl.status().locked === false);
    check('disablePin never changed the underlying secrets', ctl.getSecrets().token === TOKEN && ctl.getSecrets().user === USER && ctl.getSecrets().pass === PASS);

    const hits = scanForPlaintextSecrets(dir, ALL_SECRETS);
    check('nothing secret ever written to disk in plaintext across the ON->OFF switch', hits.length === 0, hits.slice(0, 3));
    check('no PIN or credential ever appears in a log line (ON->OFF)', !log.some((l) => ALL_SECRETS.some((s) => l.includes(s))), log);
  } finally { rmrf(dir); }
}

// ====================================================================================================
// 2. disablePin edge cases: not configured, already OFF, bad shape, encryption unavailable.
// ====================================================================================================
{
  const dir = mkdtemp('disable-edge');
  try {
    const ctl = createSecretsController({ safeStorage: fakeSafeStorage, dir, now, log: () => {} });
    const notConfigured = ctl.disablePin(PIN);
    check('disablePin refuses when nothing is configured yet', notConfigured.ok === false && notConfigured.error === 'not_configured');

    ctl.configure({ token: TOKEN, user: USER, pass: PASS, pin: PIN });
    const badShape = ctl.disablePin('12345');
    check('disablePin refuses a non-6-digit PIN before touching the envelope', badShape.ok === false && badShape.error === 'bad_pin_shape' && ctl._test.envelopeType() === 'pin');

    ctl.disablePin(PIN); // now in 'os' mode
    const alreadyOff = ctl.disablePin(PIN);
    check('disablePin refuses (already_os) once the requirement is already off', alreadyOff.ok === false && alreadyOff.error === 'already_os');
  } finally { rmrf(dir); }

  const dir2 = mkdtemp('disable-no-encryption');
  try {
    const ctl = createSecretsController({ safeStorage: fakeSafeStorage, dir: dir2, now, log: () => {} });
    ctl.configure({ token: TOKEN, user: USER, pass: PASS, pin: PIN });
    // Simulate encryption going unavailable between configure and the toggle (fresh controller over the same files).
    const ctl2 = createSecretsController({ safeStorage: unavailableSafeStorage, dir: dir2, now, log: () => {} });
    const refused = ctl2.disablePin(PIN);
    check('disablePin refuses OFF with a clear error when OS encryption is unavailable', refused.ok === false && refused.error === 'no_encryption');
    const ctlAfter = createSecretsController({ safeStorage: fakeSafeStorage, dir: dir2, now, log: () => {} });
    check('refusing OFF for lack of encryption left the envelope untouched (still pin mode)', ctlAfter._test.envelopeType() === 'pin');
  } finally { rmrf(dir2); }
}

// ====================================================================================================
// 3. OFF -> ON: sets a new PIN (no "current PIN" to check, there was none), then a WRONG pin fails to unlock
//    once locked, and the right new PIN unlocks.
// ====================================================================================================
{
  const dir = mkdtemp('off-to-on');
  const log = [];
  try {
    const ctl = createSecretsController({ safeStorage: fakeSafeStorage, dir, now, log: (m) => log.push(m) });
    const fresh = ctl.configureOs({ token: TOKEN, user: USER, pass: PASS });
    check('configureOs succeeds: OS-sealed, unlocked, no PIN involved', fresh.ok === true && ctl._test.envelopeType() === 'os' && ctl.status().pinRequired === false && ctl.status().locked === false);

    const badShape = ctl.enablePin('1234');
    check('enablePin refuses a non-6-digit PIN', badShape.ok === false && badShape.error === 'bad_pin_shape' && ctl._test.envelopeType() === 'os');

    const on = ctl.enablePin(NEW_PIN);
    check('enablePin with a well-shaped PIN succeeds and re-seals as pin mode', on.ok === true && ctl._test.envelopeType() === 'pin' && ctl.status().pinRequired === true);
    check('enablePin leaves the session unlocked (fresh-auth tap, same as configure())', ctl.status().locked === false && ctl.getSecrets().token === TOKEN);

    ctl.lock('test');
    check('lock() now works again once a PIN exists', ctl.status().locked === true);

    const wrongUnlock = ctl.unlock(WRONG_NEW_PIN);
    check('a WRONG PIN fails to unlock after OFF->ON', wrongUnlock.ok === false && wrongUnlock.error === 'wrong_pin' && ctl.getSecrets() === null);

    const rightUnlock = ctl.unlock(NEW_PIN);
    check('the NEW PIN set by enablePin unlocks correctly', rightUnlock.ok === true && ctl.getSecrets().token === TOKEN && ctl.getSecrets().pass === PASS);

    const hits = scanForPlaintextSecrets(dir, ALL_SECRETS);
    check('nothing secret ever written to disk in plaintext across the OFF->ON switch', hits.length === 0, hits.slice(0, 3));
    check('no PIN or credential ever appears in a log line (OFF->ON)', !log.some((l) => ALL_SECRETS.some((s) => l.includes(s))), log);
  } finally { rmrf(dir); }
}

// ====================================================================================================
// 4. enablePin edge cases: not configured, already ON, encryption unavailable.
// ====================================================================================================
{
  const dir = mkdtemp('enable-edge');
  try {
    const ctl = createSecretsController({ safeStorage: fakeSafeStorage, dir, now, log: () => {} });
    const notConfigured = ctl.enablePin(NEW_PIN);
    check('enablePin refuses when nothing is configured yet', notConfigured.ok === false && notConfigured.error === 'not_configured');

    ctl.configure({ token: TOKEN, user: USER, pass: PASS, pin: PIN }); // already 'pin' mode
    const alreadyOn = ctl.enablePin(NEW_PIN);
    check('enablePin refuses (already_pin) when the requirement is already on', alreadyOn.ok === false && alreadyOn.error === 'already_pin');
  } finally { rmrf(dir); }

  const dir2 = mkdtemp('enable-no-encryption');
  try {
    const ctl = createSecretsController({ safeStorage: fakeSafeStorage, dir: dir2, now, log: () => {} });
    ctl.configureOs({ token: TOKEN, user: USER, pass: PASS });
    const ctl2 = createSecretsController({ safeStorage: unavailableSafeStorage, dir: dir2, now, log: () => {} });
    const refused = ctl2.enablePin(NEW_PIN);
    check('enablePin refuses ON with a clear error when OS encryption is unavailable', refused.ok === false && refused.error === 'no_encryption');
  } finally { rmrf(dir2); }
}

// ====================================================================================================
// 5. OFF mode unlocks without a PIN -- both immediately after configureOs AND after a simulated app restart
//    (a fresh controller instance over the same on-disk envelope, construction only, no unlock() call anywhere).
// ====================================================================================================
{
  const dir = mkdtemp('os-no-pin-needed');
  try {
    const ctl = createSecretsController({ safeStorage: fakeSafeStorage, dir, now, log: () => {} });
    ctl.configureOs({ token: TOKEN, user: USER, pass: PASS });
    check('OFF mode: never locked after configureOs, with zero unlock() calls', ctl.status().locked === false);

    // Simulated restart: brand-new controller instance, same files, never told a PIN.
    const ctl2 = createSecretsController({ safeStorage: fakeSafeStorage, dir, now, log: () => {} });
    check('OFF mode survives a restart: a fresh controller bootstraps straight to unlocked, no PIN anywhere', ctl2.status().locked === false && ctl2.getSecrets().token === TOKEN && ctl2.getSecrets().pass === PASS);

    // unlock()/lock() in OS mode are no-ops -- calling them must not strand the owner.
    const noopUnlock = ctl2.unlock(''); // not even a real PIN -- OS mode never checks it
    check('unlock() in OS mode is a harmless no-op success (nothing to check)', noopUnlock.ok === true);
    ctl2.lock('test');
    check('lock() in OS mode is a no-op: still unlocked (there is no PIN to re-open it with)', ctl2.status().locked === false);
  } finally { rmrf(dir); }
}

// ====================================================================================================
// 6. the envelope file never contains the plain creds, in EITHER mode (direct encryptString() output check,
//    not just the recursive disk scan above -- proves the 'os' envelope is still safeStorage-sealed, never a bare
//    JSON {token,user,pass} on disk).
// ====================================================================================================
{
  const dir = mkdtemp('envelope-os-sealed');
  try {
    const ctl = createSecretsController({ safeStorage: fakeSafeStorage, dir, now, log: () => {} });
    ctl.configureOs({ token: TOKEN, user: USER, pass: PASS });
    const onDisk = fs.readFileSync(path.join(dir, 'board-secrets.bin')).toString('utf8');
    check('the raw bytes on disk for an OS-sealed envelope are not the plain JSON (safeStorage-encrypted)', !onDisk.includes(TOKEN) && !onDisk.includes(USER) && !onDisk.includes(PASS));
    // Decrypting with the SAME fake safeStorage (the only "key" in this test) recovers {type:'os', token, user, pass} --
    // proving the OS key, and nothing else, is what stands between disk and the plain creds in this mode.
    const decrypted = JSON.parse(fakeSafeStorage.decryptString(fs.readFileSync(path.join(dir, 'board-secrets.bin'))));
    check('decrypting with the OS key (and no PIN at all) recovers the exact creds -- that is the whole point of OFF mode', decrypted.type === 'os' && decrypted.token === TOKEN && decrypted.user === USER && decrypted.pass === PASS);
  } finally { rmrf(dir); }

  const dir2 = mkdtemp('envelope-pin-sealed');
  try {
    const ctl = createSecretsController({ safeStorage: fakeSafeStorage, dir: dir2, now, log: () => {} });
    ctl.configure({ token: TOKEN, user: USER, pass: PASS, pin: PIN });
    const onDisk = fs.readFileSync(path.join(dir2, 'board-secrets.bin')).toString('utf8');
    check('the raw bytes on disk for a PIN-sealed envelope are not the plain JSON either', !onDisk.includes(TOKEN) && !onDisk.includes(USER) && !onDisk.includes(PASS) && !onDisk.includes(PIN));
    const decrypted = JSON.parse(fakeSafeStorage.decryptString(fs.readFileSync(path.join(dir2, 'board-secrets.bin'))));
    check('decrypting with ONLY the OS key still leaves a pin-mode envelope sealed (ct/tag ciphertext, no plain creds)', decrypted.type === 'pin' && typeof decrypted.ct === 'string' && !JSON.stringify(decrypted).includes(TOKEN) && !JSON.stringify(decrypted).includes(PASS));
  } finally { rmrf(dir2); }
}

// ====================================================================================================
// 7. disablePin shares the SAME backoff counter the ordinary unlock() uses (board-secrets.meta.json) -- a brute
//    -forced guess against the toggle costs exactly as much as one against unlock, not a separate free budget.
// ====================================================================================================
{
  const dir = mkdtemp('shared-backoff');
  try {
    const ctl = createSecretsController({ safeStorage: fakeSafeStorage, dir, now, log: () => {} });
    ctl.configure({ token: TOKEN, user: USER, pass: PASS, pin: PIN });
    for (let i = 1; i <= 5; i++) ctl.disablePin(WRONG_PIN); // 5 free tries, shared with unlock()'s own budget
    check('5 wrong disablePin tries cost nothing yet', ctl._test.backoffRemainingMs() === 0);
    const r6 = ctl.disablePin(WRONG_PIN);
    check('the 6th wrong disablePin try carries a backoff delay, same as unlock()', r6.ok === false && r6.error === 'wrong_pin' && r6.retryAfterMs > 0);
    const blockedUnlock = ctl.unlock(PIN); // correct PIN, but the backoff counter is SHARED with disablePin's failures above
    check('unlock() itself is blocked by a backoff disablePin ran up (shared counter, not a separate budget)', blockedUnlock.ok === false && blockedUnlock.error === 'backoff');
  } finally { rmrf(dir); }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length ? 'FAIL' : 'PASS'} check-board-pin-toggle — ${results.length - failed.length}/${results.length} assertions passed`);
process.exitCode = failed.length ? 1 : 0;
