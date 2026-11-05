// T-31 OSS parity row 10 (Electron side of the Tauri check of the same name): Settings > Board "Sign out of Board"
// (Dang xuat Bang). Clears the stored board user/pass/token and reloads the board signed out. Node only, no Electron,
// no window. Sections:
//   A. board-secrets.mjs signOut(): clears the keystore, idempotent, PIN rule mirrors disablePin (never weakened).
//   B. the Electron main.js handler board:signOut (lifted by text, run in a vm with the real controller): same, plus
//      the live board drops to local; and preload.js exposes board.signOut on the channel board:signOut.
//   C. the renderer: Settings renders the action, click -> zumi.board.signOut -> signed-out state; hidden on a bridge
//      without zumi.board.signOut; a relaunch on an empty keystore shows the sign-in form.
//   node scripts/check-board-signout.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSecretsController } from '../src/main/board-secrets.mjs';
import vm from 'node:vm';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
process.on('unhandledRejection', () => {}); // unrelated Settings cards run on stubs here
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`); };
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const SECRET = { token: 'lb_FAKEtoken_signout_77', user: 'kei-signout-user', pass: 'fake-pass-signout-55' };
const PIN = '482913', WRONG = '000000';
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from([...Buffer.from(s, 'utf8')].map((b) => b ^ 0x5a)),
  decryptString: (b) => Buffer.from([...b].map((x) => x ^ 0x5a)).toString('utf8'),
};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zumi-signout-'));
const files = (d) => fs.readdirSync(d).filter((f) => f.startsWith('board-secrets'));
const binExists = (d) => fs.existsSync(path.join(d, 'board-secrets.bin'));

// ---------- A. controller ----------
{
  const dir = tmp();
  const c = createSecretsController({ safeStorage, dir });
  check('A0 signOut exists on the controller', typeof c.signOut === 'function');
  if (typeof c.signOut === 'function') {
    c.configure({ ...SECRET, pin: PIN });
    check('A1 PIN mode: no PIN -> refused, keystore untouched', c.signOut().ok === false && c.status().configured === true && binExists(dir));
    const w = c.signOut(WRONG);
    check('A2 PIN mode: wrong PIN -> wrong_pin, keystore untouched', w.ok === false && w.error === 'wrong_pin' && c.status().configured === true);
    const r = c.signOut(PIN);
    check('A3 PIN mode: right PIN -> ok, no secrets file left, status unconfigured, nothing in memory', r.ok === true && !binExists(dir) && c.status().configured === false && c.getSecrets() === null, { r, f: files(dir) });
    check('A4 idempotent: second signOut is ok (no PIN needed, nothing stored)', c.signOut().ok === true && c.signOut(WRONG).ok === true);
    const c2 = createSecretsController({ safeStorage, dir });
    check('A5 relaunch on the emptied keystore reads none', c2.status().configured === false && c2.getSecrets() === null);
    const dir2 = tmp();
    const o = createSecretsController({ safeStorage, dir: dir2 });
    o.configureOs(SECRET);
    check('A6 OS mode: signOut needs no PIN, clears the keystore', o.signOut().ok === true && !binExists(dir2) && o.status().configured === false && o.getSecrets() === null);
    check('A7 OS mode relaunch reads none', createSecretsController({ safeStorage, dir: dir2 }).status().configured === false);
    const dir3 = tmp();
    const clock = 1_700_000_000_000;
    const b = createSecretsController({ safeStorage, dir: dir3, now: () => clock });
    b.configure({ ...SECRET, pin: PIN });
    for (let i = 0; i < 6; i++) b.signOut(WRONG);
    const locked = b.signOut(PIN);
    check('A8 inside the wrong-PIN backoff even the right PIN is refused, keystore kept', locked.ok === false && locked.error === 'backoff' && b.status().configured === true, locked);
    // A8b: wrong sign-out attempts and wrong unlock attempts share ONE counter (the same meta file)
    const dir3b = tmp();
    const mx = createSecretsController({ safeStorage, dir: dir3b });
    mx.configure({ ...SECRET, pin: PIN });
    mx.signOut(WRONG); mx.signOut(WRONG); mx.unlock(WRONG);
    check('A8b wrong sign-outs and wrong unlocks count on one shared counter', mx._test.readMeta().failedAttempts === 3, mx._test.readMeta());
    // ---- fault injection (S1): a failed delete must fail closed ----
    const realRm = fs.rmSync;
    const failOn = (re) => { fs.rmSync = (f, o) => { if (re.test(String(f))) { const e = new Error('EPERM'); e.code = 'EPERM'; throw e; } return realRm(f, o); }; };
    const dir4 = tmp();
    const f1 = createSecretsController({ safeStorage, dir: dir4 });
    f1.configureOs(SECRET);
    failOn(/\.meta\.json$/);
    let r4, threw4 = null;
    try { r4 = f1.signOut(); } catch (e) { threw4 = e; } finally { fs.rmSync = realRm; }
    check('A9 meta delete fails: no throw, explicit io error naming the leftover file, never ok', !threw4 && r4 && r4.ok === false && r4.error === 'io' && Array.isArray(r4.leftover) && r4.leftover.some((n) => /meta\.json$/.test(n)) && !JSON.stringify(r4).includes(SECRET.pass), { threw4: threw4 && threw4.code, r4 });
    check('A9b ...and no live auth stays in memory', f1.getSecrets() === null);
    const dir5 = tmp();
    const f2 = createSecretsController({ safeStorage, dir: dir5 });
    f2.configureOs(SECRET);
    failOn(/\.bin$/);
    let r5, threw5 = null;
    try { r5 = f2.signOut(); } catch (e) { threw5 = e; } finally { fs.rmSync = realRm; }
    check('A10 bin delete fails: io error naming board-secrets.bin, memory dropped, status configured+locked (consistent with disk)', !threw5 && r5 && r5.ok === false && r5.error === 'io' && r5.leftover.includes('board-secrets.bin') && f2.getSecrets() === null && f2.status().configured === true && f2.status().locked === true, { threw5: threw5 && threw5.code, r5, st: f2.status() });
    // Tauri parity (row 10 should-fix): after a failed delete on an OS-sealed store the leftover file is not proven PIN-sealed,
    // so status must not claim a PIN requirement (and must not re-adopt the dropped sign-in from the leftover file).
    const stA10 = f2.status();
    check('A10b OS store, failed bin delete: status pinRequired:false (Tauri parity), flagged unreadable, secrets still not re-adopted', stA10.pinRequired === false && stA10.unreadable === true && f2.getSecrets() === null, stA10);
    const dir6 = tmp();
    const t6 = createSecretsController({ safeStorage, dir: dir6 });
    t6.configureOs(SECRET);
    fs.copyFileSync(path.join(dir6, 'board-secrets.bin'), path.join(dir6, 'board-secrets.bin.tmp'));
    fs.writeFileSync(path.join(dir6, 'board-secrets.meta.json.tmp'), '{}');
    check('A11 stale .tmp copies of the sealed file and meta are removed too', t6.signOut().ok === true && files(dir6).length === 0, files(dir6));
    const dir7 = tmp();
    fs.writeFileSync(path.join(dir7, 'board-secrets.bin.tmp'), 'stale');
    check('A12 no bin but a leftover .tmp: sign-out still cleans it', createSecretsController({ safeStorage, dir: dir7 }).signOut().ok === true && files(dir7).length === 0, files(dir7));
    // corrupt keystore (nothing usable to protect) is signable-out without a PIN; a readable PIN store still needs it
    const dir8 = tmp();
    createSecretsController({ safeStorage, dir: dir8 }).configure({ ...SECRET, pin: PIN });
    fs.writeFileSync(path.join(dir8, 'board-secrets.bin'), 'garbage');
    const t8b = createSecretsController({ safeStorage, dir: dir8 });
    const r13 = t8b.signOut(undefined), r13p = t8b.signOut(PIN);
    check('A13 corrupt PIN keystore: sign-out refused with corrupt (with or without a PIN), files kept', r13.ok === false && r13.error === 'corrupt' && r13p.ok === false && r13p.error === 'corrupt' && files(dir8).length === 2, { r13, r13p, f: files(dir8) });
    const dir9 = tmp();
    createSecretsController({ safeStorage, dir: dir9 }).configure({ ...SECRET, pin: PIN });
    check('A14 readable PIN-sealed store still refuses a sign-out without the PIN', createSecretsController({ safeStorage, dir: dir9 }).signOut().ok === false && binExists(dir9));
    // ---- S3: a transient read/decrypt failure on a READABLE PIN store must never turn into a no-PIN wipe ----
    const flaky = () => { const st = { fail: false }; return { st, ss: { isEncryptionAvailable: () => true, encryptString: (x) => Buffer.from(x), decryptString: (b) => { if (st.fail) throw new Error('vault'); return b.toString(); } } }; };
    const dirP1 = tmp(); const p1 = flaky();
    const cP1 = createSecretsController({ safeStorage: p1.ss, dir: dirP1 }); cP1.configure({ ...SECRET, pin: PIN });
    p1.st.fail = true;
    const rP1 = cP1.signOut(undefined);
    check('A15 (P1) vault decrypt fails transiently, no PIN: refused, files kept', rP1.ok === false && binExists(dirP1), rP1);
    const dirP1b = tmp(); const p1b = flaky();
    const cP1b = createSecretsController({ safeStorage: p1b.ss, dir: dirP1b }); cP1b.configure({ ...SECRET, pin: PIN });
    for (let i = 0; i < 7; i++) cP1b.signOut(WRONG);
    p1b.st.fail = true;
    const rP1b = cP1b.signOut(WRONG);
    check('A16 (P1b) inside the backoff + vault failure: refused, files kept', rP1b.ok === false && binExists(dirP1b), rP1b);
    const dirP2 = tmp(); const p2 = flaky();
    const cP2 = createSecretsController({ safeStorage: p2.ss, dir: dirP2 }); cP2.configure({ ...SECRET, pin: PIN });
    const realRead = fs.readFileSync;
    fs.readFileSync = (f, o) => { if (String(f).endsWith('board-secrets.bin')) { const e = new Error('EBUSY'); e.code = 'EBUSY'; throw e; } return realRead(f, o); };
    let rP2; try { rP2 = cP2.signOut(undefined); } finally { fs.readFileSync = realRead; }
    check('A17 (P2) fs read error on the bin, no PIN: refused, files kept', rP2.ok === false && binExists(dirP2), rP2);
    const dirP3 = tmp(); const p3 = flaky();
    createSecretsController({ safeStorage: p3.ss, dir: dirP3 }).configure({ ...SECRET, pin: PIN });
    p3.st.fail = true; // a fresh controller whose bootstrap decrypt fails because the vault is down: never proved readable, and the vault is unhealthy
    const rP3 = createSecretsController({ safeStorage: p3.ss, dir: dirP3 }).signOut(undefined);
    check('A18 vault down at bootstrap (decrypt AND round-trip fail): refused, files kept', rP3.ok === false && binExists(dirP3), rP3);
    // vault healthy but this blob does not decrypt (a corrupt DPAPI blob under the real vault): provably data-only, wipe allowed
    const dirP4 = tmp();
    const bad = { isEncryptionAvailable: () => true, encryptString: (x) => Buffer.from(x), decryptString: (b) => { if (b.toString() === 'garbage') throw new Error('vault'); return b.toString(); } };
    createSecretsController({ safeStorage: bad, dir: dirP4 }).configure({ ...SECRET, pin: PIN });
    fs.writeFileSync(path.join(dirP4, 'board-secrets.bin'), 'garbage');
    const r19 = createSecretsController({ safeStorage: bad, dir: dirP4 }).signOut(undefined);
    check('A19 healthy vault + undecryptable blob: still refused (a PIN store needs the PIN, always), files kept', r19.ok === false && r19.error === 'corrupt' && files(dirP4).length === 2, { r19, f: files(dirP4) });
    // ---- re-review 2 (pinbypass2): every route that made a readable PIN store look corrupt must refuse ----
    const flaky2 = () => { let failBlob = 0, failAll = 0; return { ss: { isEncryptionAvailable: () => true, encryptString: (x) => Buffer.from(x), decryptString: (b) => { const t = b.toString(); if (failAll > 0) { failAll--; throw new Error('vault'); } if (t !== 'probe' && failBlob > 0) { failBlob--; throw new Error('vault'); } return t; } }, failBlob: (k) => { failBlob = k; }, failAll: (k) => { failAll = k; } }; };
    const seed2 = (d) => createSecretsController({ safeStorage: flaky2().ss, dir: d }).configure({ ...SECRET, pin: PIN });
    const dN1 = tmp(); seed2(dN1); const fN1 = flaky2(); fN1.failAll(1);
    const cN1 = createSecretsController({ safeStorage: fN1.ss, dir: dN1 }); fN1.failBlob(1);
    check('A20 (N1) bootstrap fail + decrypt fail + vault back for a probe: refused, files kept', cN1.signOut(undefined).ok === false && files(dN1).length === 2);
    const dN2 = tmp(); seed2(dN2); const fN2 = flaky2(); fN2.failAll(1);
    const cN2 = createSecretsController({ safeStorage: fN2.ss, dir: dN2 }); cN2.unlock(PIN); cN2.lock(); fN2.failBlob(1);
    check('A21 (N2) unlock proved it readable, then lock + transient failure: refused, files kept', cN2.signOut(undefined).ok === false && files(dN2).length === 2);
    const dN2b = tmp(); seed2(dN2b); const fN2b = flaky2(); fN2b.failAll(1);
    const cN2b = createSecretsController({ safeStorage: fN2b.ss, dir: dN2b });
    for (let i = 0; i < 7; i++) cN2b.signOut(WRONG);
    fN2b.failBlob(1);
    const rN2b = cN2b.signOut(undefined);
    check('A22 (N2b) inside the backoff + transient failure: refused, files kept', rN2b.ok === false && files(dN2b).length === 2, rN2b);
    const dN3 = tmp(); seed2(dN3);
    const emptyVault = { isEncryptionAvailable: () => true, encryptString: (x) => Buffer.from(x), decryptString: () => '' };
    check('A23 (N3) vault returns empty text: refused, files kept', createSecretsController({ safeStorage: emptyVault, dir: dN3 }).signOut(undefined).ok === false && files(dN3).length === 2);
    const dN4 = tmp(); const cN4 = createSecretsController({ safeStorage: flaky2().ss, dir: dN4 }); cN4.configure({ ...SECRET, pin: PIN });
    fs.writeFileSync(path.join(dN4, 'board-secrets.bin'), 'null');
    check('A24 (N4) blob that decrypts to JSON null: refused, files kept', cN4.signOut(undefined).ok === false && files(dN4).length === 2);
    for (const d of [dir, dir2, dir3, dir3b, dN1, dN2, dN2b, dN3, dN4, dir4, dir5, dir6, dir7, dir8, dir9, dirP1, dirP1b, dirP2, dirP3, dirP4]) fs.rmSync(d, { recursive: true, force: true });
  }
}

// ---------- B. main.js handler + preload ----------
{
  const mainSrc = read('src/main/main.js');
  const at = mainSrc.indexOf("ipcMain.handle('board:signOut'");
  let handler = null;
  if (at >= 0) {
    // the handler statement ends at the first line that is exactly '});' after its start
    const end = mainSrc.indexOf('\n});', at);
    handler = mainSrc.slice(at, end + 4);
  }
  check('B0 main.js registers ipcMain.handle(board:signOut)', !!handler);
  const preloadSrc = read('src/main/preload.js');
  const invoked = [];
  const ipcRenderer = { invoke: (...a) => { invoked.push(a); return Promise.resolve({ ok: true }); }, on() {}, removeListener() {}, send() {} };
  let exposed = null;
  try {
    const req = (m) => (m === 'electron' ? { contextBridge: { exposeInMainWorld: (_n, api) => { exposed = api; } }, ipcRenderer, webFrame: {}, webUtils: {} } : {});
    vm.runInNewContext('(function (require, module, process, console) {\n' + preloadSrc + '\n})', { Buffer }, { timeout: 2000 })(req, { exports: {} }, process, console);
  } catch (e) { /* reported by B1 */ }
  let b1 = false;
  if (exposed && exposed.board && typeof exposed.board.signOut === 'function') { await exposed.board.signOut('123456'); b1 = invoked.some((a) => a[0] === 'board:signOut' && a[1] === '123456'); }
  check('B1 preload exposes board.signOut(pin) on channel board:signOut', b1, { exposed: !!exposed, hasFn: !!(exposed && exposed.board && exposed.board.signOut) });
  if (handler) {
    const dir = tmp();
    let settingsStore = { requireBoardPin: true };
    const secrets = createSecretsController({ safeStorage, dir });
    let mode = 'live';
    const liveBoard = { secrets, status: () => ({ ...secrets.status(), mode }), setMode: async (m) => { mode = m; return { ok: true }; } };
    const h = new Map();
    const ctx = vm.createContext({ ipcMain: { handle: (c, f) => h.set(c, f) }, fromAppPage: () => true, liveBoard, liveBridgeOrigin: 'http://127.0.0.1:1', loadSettings: () => settingsStore, saveSettings: (p) => { settingsStore = { ...settingsStore, ...p }; } });
    vm.runInContext(handler, ctx, { timeout: 1000 });
    const call = (...a) => h.get('board:signOut')({ sender: {} }, ...a);
    secrets.configure({ ...SECRET, pin: PIN });
    check('B2 non-string PIN is bad_request, keystore kept', (await call(5)).error === 'bad_request' && secrets.status().configured === true);
    check('B3 wrong PIN refused, keystore kept, still live', (await call(WRONG)).ok === false && secrets.status().configured === true && mode === 'live');
    const r = await call(PIN);
    check('B4 right PIN signs out: unconfigured, back to local, no keystore file', r.ok === true && secrets.status().configured === false && mode === 'local' && !binExists(dir), { r, mode });
    check('B4b no live auth in memory and the live bridge origin is forgotten', secrets.getSecrets() === null && vm.runInContext('liveBridgeOrigin', ctx) === null);
    check('B5 idempotent', (await call()).ok === true);
    check('B6 relaunch: status unconfigured', createSecretsController({ safeStorage, dir }).status().configured === false);
    const noBoard = vm.createContext({ ipcMain: { handle: (c, f) => h.set('x' + c, f) }, fromAppPage: () => true, liveBoard: null, liveBridgeOrigin: null });
    vm.runInContext(handler, noBoard, { timeout: 1000 });
    check('B6b before the live board exists: not_ready, no throw', (await h.get('xboard:signOut')({ sender: {} }, PIN)).error === 'not_ready');
    const foreign = vm.createContext({ ipcMain: { handle: (c, f) => h.set('y' + c, f) }, fromAppPage: () => false, liveBoard, liveBridgeOrigin: null });
    vm.runInContext(handler, foreign, { timeout: 1000 });
    secrets.configureOs(SECRET);
    check('B6c a sender that is not the app page is refused and nothing is removed', (await h.get('yboard:signOut')({ sender: {} })).ok === false && secrets.status().configured === true);
    fs.rmSync(dir, { recursive: true, force: true });
    // B7/B8: fault probe: a delete fails -> explicit io error, board STILL dropped to local with no live auth
    const dirF = tmp();
    const secF = createSecretsController({ safeStorage, dir: dirF });
    let modeF = 'live';
    const liveF = { secrets: secF, status: () => ({ ...secF.status(), mode: modeF }), setMode: async (m) => { modeF = m; return { ok: true }; } };
    const hF = new Map();
    const ctxF = vm.createContext({ ipcMain: { handle: (c, f) => hF.set(c, f) }, fromAppPage: () => true, liveBoard: liveF, liveBridgeOrigin: 'http://127.0.0.1:1' });
    vm.runInContext(handler, ctxF, { timeout: 1000 });
    secF.configureOs(SECRET);
    const realRm = fs.rmSync;
    fs.rmSync = (p, o) => { if (String(p).endsWith('.meta.json')) { const e = new Error('EPERM'); e.code = 'EPERM'; throw e; } return realRm(p, o); };
    let rF, thrF = null;
    try { rF = await hF.get('board:signOut')({ sender: {} }); } catch (e) { thrF = e; } finally { fs.rmSync = realRm; }
    check('B7 fault probe: explicit io error (not ok, not a throw) naming the leftover file', !thrF && rF && rF.ok === false && rF.error === 'io' && rF.leftover.some((n) => /meta\.json$/.test(n)), { thrF: thrF && thrF.code, rF });
    check('B8 fault probe: no live auth in memory, mode back to local, bridge origin forgotten', secF.getSecrets() === null && modeF === 'local' && vm.runInContext('liveBridgeOrigin', ctxF) === null, { modeF });
    fs.rmSync(dirF, { recursive: true, force: true });
  }
}


// ---------- C. renderer / wiring ----------
{
  const html = read('src/renderer/index.html');
  const settings = read('src/renderer/settings.js');
  const preload = read('src/main/preload.js');
  check('C1 Settings board section renders the action (button #board-signout, data-i18n settings.signOut)', /<button[^>]*id="board-signout"[^>]*data-i18n="settings\.signOut"/.test(html));
  const { TABLES } = await import(pathToFileURL(path.join(root, 'src/renderer/i18n.js')).href);
  check('C2 every locale carries settings.signOut and settings.signedOut', Object.values(TABLES).every((tb) => tb['settings.signOut'] && tb['settings.signedOut']), Object.keys(TABLES));
  check('C3 Vietnamese label is "Đăng xuất Bảng"', TABLES.vi['settings.signOut'] === 'Đăng xuất Bảng');
  check('C5 the renderer shows the button only where the bridge has zumi.board.signOut', /typeof zumi\.board\.signOut !== 'function'/.test(settings));

  // behaviour: run initSettings against a recording fake DOM + fake zumi
  const mkEl = () => {
    const e = { hidden: false, disabled: false, textContent: '', value: '', className: '', checked: false, innerHTML: '', style: { setProperty() {} }, dataset: {}, listeners: {},
      classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
      addEventListener(ev, fn) { (e.listeners[ev] ||= []).push(fn); }, removeEventListener() {}, setAttribute() {}, getAttribute: () => null, appendChild() {}, focus() {}, querySelector: () => mkEl(), querySelectorAll: () => [] };
    return e;
  };
  const els = new Map();
  const $ = (id) => { if (!els.has(id)) els.set(id, mkEl()); return els.get(id); };
  globalThis.document = { createElement: mkEl, querySelector: () => null, querySelectorAll: () => [], documentElement: {}, addEventListener() {}, dispatchEvent() { return true; }, getElementById: $ };
  let keystore = { configured: true, locked: false, mode: 'live', pinRequired: true };
  const calls = [];
  const quiet = new Proxy(() => Promise.resolve({}), { get: (t, p) => (p === 'then' ? undefined : quiet), apply: () => Promise.resolve({}) });
  const mkZumi = (withSignOut) => new Proxy({
    board: {
      status: async () => ({ ...keystore }),
      lock: async () => true, unlock: async () => ({ ok: true }), setSecrets: async () => ({ ok: true }), setMode: async () => ({ ok: true }), setPinRequired: async () => ({ ok: true }),
      ...(withSignOut ? { signOut: async (pin) => { calls.push(pin); keystore = { configured: false, locked: true, mode: 'local', pinRequired: true }; return { ok: true }; } } : {}),
    },
    onWindowFocus: () => {},
  }, { get: (t, p) => (p in t ? t[p] : quiet) });
  const settle = () => new Promise((r) => setTimeout(r, 30));
  const seen = [];
  const mod = await import(pathToFileURL(path.join(root, 'src/renderer/settings.js')).href).catch((e) => ({ err: e }));
  check('C6 settings.js loads in node', !!mod.initSettings, mod.err && String(mod.err.message));
  if (mod.initSettings) {
    let initErr = null;
    try { mod.initSettings(mkZumi(true), $, { onBoardChange: (s) => seen.push(s) }); } catch (e) { initErr = e; }
    check('C7 initSettings runs on the fake DOM', !initErr, initErr && String(initErr.stack || initErr).split('\n').slice(0, 3));
    await settle();
    const btn = $('board-signout');
    check('C8 the action is wired and visible with a configured board on a bridge that has signOut', (btn.listeners.click || []).length === 1 && btn.hidden === false, { listeners: (btn.listeners.click || []).length, hidden: btn.hidden });
    check('C9 chip reads Signed in before', $('board-chip').textContent === 'Signed in' || $('board-chip').textContent === 'Connected', $('board-chip').textContent);
    for (const fn of btn.listeners.click || []) await fn();
    await settle();
    check('C9b PIN-sealed install: clicking with no PIN typed calls nothing and keeps the sign-in', calls.length === 0 && keystore.configured === true && $('board-session-note').textContent !== '');
    $('board-unlock-pin').value = PIN;
    for (const fn of btn.listeners.click || []) await fn();
    await settle();
    check('C9c first click only asks to confirm: nothing called, sign-in kept, confirm text shown', calls.length === 0 && keystore.configured === true && $('board-session-note').textContent === TABLES.en['settings.signOutConfirm'] && !!TABLES.en['settings.signOutConfirm'], { calls: calls.length, note: $('board-session-note').textContent });
    for (const fn of btn.listeners.click || []) await fn();
    await settle();
    check('C10 second click (confirmed) calls zumi.board.signOut once', calls.length === 1, calls);
    check('C11 afterwards the chip is not "Signed in" and the sign-in form is open', $('board-chip').textContent === 'Not set up' && $('board-form').hidden === false, { chip: $('board-chip').textContent, formHidden: $('board-form').hidden });
    check('C12 the Board tab hook got the signed-out status', seen.length > 0 && seen[seen.length - 1].configured === false);
    els.clear();
    mod.initSettings(mkZumi(true), $, {});
    await settle();
    check('C13 relaunch on an empty keystore shows the sign-in form and no Signed in chip', $('board-form').hidden === false && $('board-chip').textContent !== 'Signed in', { chip: $('board-chip').textContent });
    check('C14 sign-out button is hidden when nothing is configured', $('board-signout').hidden === true);
    // S2: a rejected / failed sign-out shows a message instead of failing silently
    for (const [label, impl, want] of [
      ['rejects', async () => { throw new Error('boom'); }, () => TABLES.en['settings.signOutFailed']],
      ['returns corrupt', async () => ({ ok: false, error: 'corrupt' }), () => TABLES.en['settings.signOutCorrupt']],
      ['returns io + leftover', async () => ({ ok: false, error: 'io', leftover: ['board-secrets.bin'] }), () => TABLES.en['settings.signOutIo']],
    ]) {
      els.clear();
      keystore = { configured: true, locked: false, mode: 'live', pinRequired: false };
      const z = mkZumi(true); z.board.signOut = impl;
      mod.initSettings(z, $, {});
      await settle();
      const b = $('board-signout');
      for (const fn of b.listeners.click || []) await fn();
      for (const fn of b.listeners.click || []) await fn();
      await settle();
      const txt = $('board-session-note').textContent;
      check(`C16 sign-out ${label}: a message is shown, no unhandled state`, !!want() && txt.startsWith(want().split('{')[0]) && (!label.includes('io') || txt.includes('board-secrets.bin')), txt);
    }
    for (const k of ['settings.signOutConfirm', 'settings.signOutIo', 'settings.signOutCorrupt']) check(`C17 every locale carries ${k}`, Object.values(TABLES).every((tb) => tb[k]));
    els.clear();
    keystore = { configured: true, locked: false, mode: 'live', pinRequired: true };
    mod.initSettings(mkZumi(false), $, {});
    await settle();
    check('C15 a bridge without zumi.board.signOut: button hidden even when configured', $('board-signout').hidden === true);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
