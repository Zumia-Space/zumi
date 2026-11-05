// T-31-TAURI: a PIN-sealed Board store can only be replaced or downgraded with the CURRENT PIN (Opus Re-review 3, PRE-1/PRE-2).
//   A. board-secrets.mjs: configureOs / configure (= Change sign-in) on a PIN store without / with a wrong / with the right PIN.
//   B. the Tauri sidecar handlers board.setSecretsOs / board.setSecrets (+ requireBoardPin stays put on a refusal).
//   C. Settings "Change sign-in" asks for the current PIN, shows the wrong-PIN / backoff messages, vi/en/zh strings.
//   node scripts/check-board-pin-required.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSecretsController } from '../src/main/board-secrets.mjs';
import { createBoardHost } from '../tauri/sidecar/board-host.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
process.on('unhandledRejection', () => {});
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`); };
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const OLD = { token: 'lb_FAKEtoken_old_11', user: 'old-user', pass: 'old-pass-aaa' };
const NEW = { token: 'lb_FAKEtoken_new_22', user: 'new-user', pass: 'new-pass-bbb' };
const ATK_OS = { user: 'attacker', pass: 'attacker-pass' };
const PIN = '482913', WRONG = '000000', NEWPIN = '135790';
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from([...Buffer.from(s, 'utf8')].map((b) => b ^ 0x5a)),
  decryptString: (b) => Buffer.from([...b].map((x) => x ^ 0x5a)).toString('utf8'),
};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zumi-pinreq-'));
const bin = (d) => fs.readFileSync(path.join(d, 'board-secrets.bin'));
const same = (a, b) => Buffer.compare(a, b) === 0;
const dirs = [];
const mkPinStore = (now) => { const dir = tmp(); dirs.push(dir); const c = createSecretsController({ safeStorage, dir, ...(now ? { now } : {}) }); c.configure({ ...OLD, pin: PIN }); return { dir, c }; };

// ---------- A. controller ----------
{
  const { dir, c } = mkPinStore();
  const before = bin(dir);
  const r1 = c.configureOs(NEW);
  check('A1 configureOs on a PIN store with no PIN: refused, store bytes and PIN type kept', r1.ok === false && same(bin(dir), before) && c.status().pinRequired === true, r1);
  const r2 = c.configureOs({ ...NEW, currentPin: WRONG });
  check('A2 configureOs with a wrong PIN: wrong_pin, store kept, backoff counter incremented', r2.ok === false && r2.error === 'wrong_pin' && same(bin(dir), before) && c._test.readMeta().failedAttempts >= 1, { r2, m: c._test.readMeta() });
  const r3 = c.configureOs({ ...NEW, currentPin: PIN });
  check('A3 configureOs with the right PIN: ok, now OS-sealed with the new credential', r3.ok === true && c.status().pinRequired === false && c.getSecrets().user === NEW.user, r3);
  check('A3b the new store survives a relaunch as OS type', createSecretsController({ safeStorage, dir }).getSecrets()?.user === NEW.user);
}
{
  const { dir, c } = mkPinStore();
  const before = bin(dir);
  const r1 = c.configure({ ...NEW, pin: NEWPIN });
  check('A4 configure (change sign-in) on a PIN store with no current PIN: refused, store kept', r1.ok === false && same(bin(dir), before), r1);
  const r2 = c.configure({ ...NEW, pin: NEWPIN, currentPin: WRONG });
  check('A5 configure with a wrong current PIN: wrong_pin, store kept, counter incremented', r2.ok === false && r2.error === 'wrong_pin' && same(bin(dir), before) && c._test.readMeta().failedAttempts >= 1, { r2 });
  c.lock();
  check('A5b old PIN still unlocks afterwards (nothing replaced)', c.unlock(PIN).ok === true && c.getSecrets().user === OLD.user);
  const r3 = c.configure({ ...NEW, pin: NEWPIN, currentPin: PIN });
  c.lock();
  check('A6 configure with the right current PIN: ok, new PIN + new credential', r3.ok === true && c.unlock(PIN).ok === false && c.unlock(NEWPIN).ok === true && c.getSecrets().user === NEW.user, r3);
}
{
  // shared backoff: refusals from replace attempts and unlock attempts feed ONE counter; inside backoff the right PIN is refused
  let clock = 1_700_000_000_000;
  const { dir, c } = mkPinStore(() => clock);
  const before = bin(dir);
  for (let i = 0; i < 3; i++) c.configureOs({ ...NEW, currentPin: WRONG });
  for (let i = 0; i < 3; i++) c.unlock(WRONG);
  const locked = c.configureOs({ ...NEW, currentPin: PIN });
  check('A7 wrong replace + wrong unlock attempts share one counter: right PIN inside backoff is refused', locked.ok === false && locked.error === 'backoff' && same(bin(dir), before) && c._test.readMeta().failedAttempts === 6, { locked, m: c._test.readMeta() });
  clock += 120_000;
  check('A7b after the backoff the right PIN works', c.configureOs({ ...NEW, currentPin: PIN }).ok === true);
}
{
  // no PIN store: behaviour unchanged
  const dir = tmp(); dirs.push(dir);
  const c = createSecretsController({ safeStorage, dir });
  check('A8 fresh install: configureOs and configure need no current PIN', c.configureOs(OLD).ok === true && c.configure({ ...NEW, pin: PIN }).ok === true);
  const dirO = tmp(); dirs.push(dirO);
  const o = createSecretsController({ safeStorage, dir: dirO });
  o.configureOs(OLD);
  check('A9 OS store: changing the sign-in (either way) needs no PIN', o.configureOs(NEW).ok === true && o.configure({ ...OLD, pin: PIN }).ok === true);
  // review NO-GO: ANY decrypt failure on a PIN store is refused (never replaced, never a downgrade), files and backoff kept
  const { dir: dirC } = mkPinStore();
  fs.writeFileSync(path.join(dirC, 'board-secrets.bin'), Buffer.from('not-a-vault-blob'));
  const cc = createSecretsController({ safeStorage, dir: dirC });
  const badBlob = bin(dirC);
  const rc = cc.configure({ ...NEW, pin: NEWPIN });
  check('A10 corrupt (undecryptable) store: Change sign-in is refused with corrupt, file kept', rc.ok === false && rc.error === 'corrupt' && same(bin(dirC), badBlob), rc);
  {
    // transient unprotect failure on a readable PIN store with an ACTIVE backoff: refused, bytes + backoff kept
    let failNext = 0;
    const flaky = { ...safeStorage, decryptString: (b) => { if (failNext > 0) { failNext--; throw new Error('transient'); } return safeStorage.decryptString(b); } };
    let clock = 1_700_000_000_000;
    const dir = tmp(); dirs.push(dir);
    const ct = createSecretsController({ safeStorage: flaky, dir, now: () => clock });
    ct.configure({ ...OLD, pin: PIN });
    for (let i = 0; i < 8; i++) ct.unlock(WRONG);
    const meta0 = ct._test.readMeta(), bytes0 = bin(dir);
    failNext = 1;
    const t1 = ct.configureOs(ATK_OS);
    check('A12 one transient decrypt failure: configureOs refused (corrupt), store bytes and backoff kept', t1.ok === false && t1.error === 'corrupt' && same(bin(dir), bytes0) && JSON.stringify(ct._test.readMeta()) === JSON.stringify(meta0), { t1, meta0, m: ct._test.readMeta() });
    failNext = 1;
    const t2 = ct.configure({ ...ATK_OS, pin: NEWPIN });
    check('A12b same for configure (change sign-in)', t2.ok === false && t2.error === 'corrupt' && same(bin(dir), bytes0) && JSON.stringify(ct._test.readMeta()) === JSON.stringify(meta0), t2);
  }
  {
    // S1: an OS store whose startup read failed must not ask for a PIN that does not exist
    let failNext = 1;
    const flaky = { ...safeStorage, decryptString: (b) => { if (failNext > 0) { failNext--; throw new Error('transient'); } return safeStorage.decryptString(b); } };
    const dir = tmp(); dirs.push(dir);
    createSecretsController({ safeStorage, dir }).configureOs(OLD);
    const co = createSecretsController({ safeStorage: flaky, dir });
    const ro = co.configureOs(NEW);
    check('A13 OS store, startup read failed: replace needs no PIN (a successful decrypt proves type os) and no backoff counted', ro.ok === true && co._test.readMeta().failedAttempts === 0 && co.status().pinRequired === false, { ro, m: co._test.readMeta() });
  }
  {
    // S3: no single-instance lock. A second controller flips an OS store to a PIN store; the first one's cached 'os' is stale
    const dir = tmp(); dirs.push(dir);
    const c1 = createSecretsController({ safeStorage, dir });
    c1.configureOs(OLD);
    const c2 = createSecretsController({ safeStorage, dir });
    c2.configure({ ...NEW, pin: PIN, currentPin: undefined });
    const before = bin(dir);
    const stale = c1.configureOs(ATK_OS);
    check('A14 stale instance (cached os, disk now PIN): configureOs without the PIN is refused, store kept', stale.ok === false && same(bin(dir), before), stale);
    const stale2 = c1.signOut();
    check('A14b stale instance: signOut without the PIN is refused, store kept', stale2.ok === false && same(bin(dir), before), stale2);
  }
  {
    // S4: status tells the truth when the startup read failed
    let fail = 1;
    const flaky = { ...safeStorage, decryptString: (b) => { if (fail > 0) { fail--; throw new Error('transient'); } return safeStorage.decryptString(b); } };
    const dir = tmp(); dirs.push(dir);
    createSecretsController({ safeStorage, dir }).configureOs(OLD);
    const co = createSecretsController({ safeStorage: flaky, dir });
    const st = co.status();
    check('A15 OS store, one transient startup failure: status re-reads and reports pinRequired:false, not unreadable', st.configured === true && st.pinRequired === false && !st.unreadable && st.locked === false, st);
    const dirB = tmp(); dirs.push(dirB);
    createSecretsController({ safeStorage, dir: dirB }).configure({ ...OLD, pin: PIN });
    fs.writeFileSync(path.join(dirB, 'board-secrets.bin'), Buffer.from('not-a-vault-blob'));
    const sb = createSecretsController({ safeStorage, dir: dirB }).status();
    check('A16 unreadable store: status reports unreadable:true and no PIN requirement', sb.configured === true && sb.unreadable === true && sb.pinRequired === false, sb);
    const sp = (() => { const d = tmp(); dirs.push(d); const x = createSecretsController({ safeStorage, dir: d }); x.configure({ ...OLD, pin: PIN }); return x.status(); })();
    check('A17 readable PIN store: pinRequired:true, no unreadable flag', sp.pinRequired === true && !sp.unreadable, sp);
  }
  const { dir: dirI, c: ci } = mkPinStore();
  const realRead = fs.readFileSync;
  fs.readFileSync = (f, ...a) => { if (String(f).endsWith('board-secrets.bin')) { const e = new Error('EBUSY'); e.code = 'EBUSY'; throw e; } return realRead(f, ...a); };
  let rio; try { rio = ci.configureOs(NEW); } finally { fs.readFileSync = realRead; }
  check('A11 transient read error on a PIN store: refused (io), never replaced', rio.ok === false && rio.error === 'io' && fs.existsSync(path.join(dirI, 'board-secrets.bin')), rio);
}

// ---------- B. sidecar ----------
{
  const dir = tmp(); dirs.push(dir);
  let st = { requireBoardPin: true };
  const host = createBoardHost({ safeStorage, dataDir: dir, flavour: { values: {} }, settings: () => st, saveSettings: (p) => { st = { ...st, ...p }; return st; }, signals: null, idleLock: false });
  const h = host.handlers;
  h['board.setSecrets']({ ...OLD, pin: PIN });
  const before = bin(dir);
  const r1 = h['board.setSecretsOs']({ user: NEW.user, pass: NEW.pass });
  check('B1 board.setSecretsOs on a PIN store, no PIN: refused, files and requireBoardPin:true kept', r1.ok === false && same(bin(dir), before) && st.requireBoardPin === true && h['board.status']().pinRequired === true, { r1, st });
  const n0 = host.liveBoard.secrets._test.readMeta().failedAttempts;
  const r2 = h['board.setSecretsOs']({ user: NEW.user, pass: NEW.pass, currentPin: WRONG });
  check('B2 wrong PIN: wrong_pin, backoff counter incremented, files and requireBoardPin kept', r2.ok === false && r2.error === 'wrong_pin' && host.liveBoard.secrets._test.readMeta().failedAttempts === n0 + 1 && same(bin(dir), before) && st.requireBoardPin === true, { r2, st });
  check('B3 non-string currentPin is bad_request', h['board.setSecretsOs']({ user: NEW.user, pass: NEW.pass, currentPin: 5 }).error === 'bad_request' && h['board.setSecrets']({ ...NEW, pin: NEWPIN, currentPin: 5 }).error === 'bad_request');
  const s1 = h['board.setSecrets']({ ...NEW, pin: NEWPIN });
  check('B4 board.setSecrets (Change sign-in) without the current PIN: refused, files kept', s1.ok === false && same(bin(dir), before), s1);
  const s2 = h['board.setSecrets']({ ...NEW, pin: NEWPIN, currentPin: PIN });
  check('B5 board.setSecrets with the right current PIN: ok, new PIN works', s2.ok === true && h['board.status']().pinRequired === true && host.liveBoard.secrets.getSecrets().user === NEW.user, s2);
  const r3 = h['board.setSecretsOs']({ user: OLD.user, pass: OLD.pass, currentPin: NEWPIN });
  check('B6 board.setSecretsOs with the right PIN: ok, requireBoardPin:false, OS-sealed', r3.ok === true && st.requireBoardPin === false && h['board.status']().pinRequired === false, { r3, st });
  await host.dispose();
  const dir2 = tmp(); dirs.push(dir2);
  let st2 = { requireBoardPin: false };
  const host2 = createBoardHost({ safeStorage, dataDir: dir2, flavour: { values: {} }, settings: () => st2, saveSettings: (p) => { st2 = { ...st2, ...p }; return st2; }, signals: null, idleLock: false });
  check('B7 fresh install, no PIN store: setSecretsOs unchanged (no currentPin needed)', host2.handlers['board.setSecretsOs']({ user: OLD.user, pass: OLD.pass }).ok === true && st2.requireBoardPin === false);
  await host2.dispose();
}

// ---------- C. Settings ----------
{
  const { TABLES } = await import(pathToFileURL(path.join(root, 'src/renderer/i18n.js')).href);
  check('C1 every locale carries settings.changeSigninNeedPin', Object.values(TABLES).every((tb) => tb['settings.changeSigninNeedPin']), Object.keys(TABLES));
  const mkEl = () => {
    const e = { hidden: false, disabled: false, textContent: '', value: '', className: '', checked: false, innerHTML: '', style: { setProperty() {} }, dataset: {}, listeners: {},
      classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
      addEventListener(ev, fn) { (e.listeners[ev] ||= []).push(fn); }, removeEventListener() {}, setAttribute() {}, getAttribute: () => null, appendChild() {}, focus() {}, querySelector: () => mkEl(), querySelectorAll: () => [] };
    return e;
  };
  const els = new Map();
  const $ = (id) => { if (!els.has(id)) els.set(id, mkEl()); return els.get(id); };
  globalThis.document = { createElement: mkEl, querySelector: () => null, querySelectorAll: () => [], documentElement: {}, dispatchEvent() { return true; }, addEventListener() {}, getElementById: $ };
  const quiet = new Proxy(() => Promise.resolve({}), { get: (t, p) => (p === 'then' ? undefined : quiet), apply: () => Promise.resolve({}) });
  const sent = [];
  let reply = { ok: true };
  const mkZumi = (pinRequired) => new Proxy({
    board: { status: async () => ({ configured: true, locked: false, mode: 'live', pinRequired }), lock: async () => true, unlock: async () => ({ ok: true }),
      setSecrets: async (p) => { sent.push(['setSecrets', p]); return reply; }, setMode: async () => ({ ok: true }), setPinRequired: async () => ({ ok: true }) },
    onWindowFocus: () => {},
  }, { get: (t, p) => (p in t ? t[p] : quiet) });
  const settle = () => new Promise((r) => setTimeout(r, 30));
  const mod = await import(pathToFileURL(path.join(root, 'src/renderer/settings.js')).href);
  const fill = (pin) => { $('board-user').value = NEW.user; $('board-pass').value = NEW.pass; $('board-pin').value = NEWPIN; $('board-pin-confirm').value = NEWPIN; $('board-unlock-pin').value = pin; };
  const clickSave = async () => { for (const fn of $('board-save').listeners.click || []) await fn(); await settle(); };
  mod.initSettings(mkZumi(true), $, {});
  await settle();
  fill('');
  await clickSave();
  check('C2 PIN store, current PIN field empty: nothing sent, the need-PIN message is shown', sent.length === 0 && $('board-note').textContent === TABLES.en['settings.changeSigninNeedPin'] && !!TABLES.en['settings.changeSigninNeedPin'], { sent: sent.length, note: $('board-note').textContent });
  fill(PIN);
  reply = { ok: false, error: 'wrong_pin', retryAfterMs: 0 };
  await clickSave();
  check('C3 wrong current PIN: the request carried currentPin, the wrong-PIN message is shown', sent.length === 1 && sent[0][1].currentPin === PIN && $('board-note').textContent === TABLES.en['settings.wrongPin'], { sent: sent.length, note: $('board-note').textContent });
  fill(PIN);
  reply = { ok: false, error: 'backoff', retryAfterMs: 5000 };
  await clickSave();
  check('C4 backoff: the wrong-PIN message and a retry countdown are shown', $('board-note').textContent === TABLES.en['settings.wrongPin'] && $('board-unlock-pin').disabled === true, { note: $('board-note').textContent, dis: $('board-unlock-pin').disabled });
  els.clear(); sent.length = 0; reply = { ok: true };
  mod.initSettings(mkZumi(false), $, {});
  await settle();
  fill('');
  await clickSave();
  check('C5 OS store (pinRequired:false): saves without asking for a current PIN, none sent', sent.length === 1 && sent[0][1].currentPin === undefined, { sent: sent.length });
  for (const [label, err, key] of [['corrupt', 'corrupt', 'settings.changeSigninCorrupt'], ['io', 'io', 'settings.changeSigninIo']]) {
    els.clear(); sent.length = 0; reply = { ok: false, error: err };
    mod.initSettings(mkZumi(true), $, {});
    await settle();
    fill(PIN);
    await clickSave();
    check(`C7 ${label} refusal shows its own message in every locale`, Object.values(TABLES).every((tb) => tb[key]) && $('board-note').textContent === TABLES.en[key], { note: $('board-note').textContent });
  }
  check('C8 the corrupt messages tell the owner to delete board-secrets.bin by hand', Object.values(TABLES).every((tb) => tb['settings.changeSigninCorrupt'].includes('board-secrets.bin') && tb['settings.signOutCorrupt'].includes('board-secrets.bin')));
  check('C6 the first-run form (board-signin.js) is unchanged: it only runs while unconfigured', !/currentPin/.test(read('src/renderer/board-signin.js')));
}

for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
