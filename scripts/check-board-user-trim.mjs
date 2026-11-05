// T-31-TAURI: a board username typed with a leading/trailing space must never be stored. The bridge sends Basic auth
// from the stored user/pass verbatim (board-bridge.mjs buildAuthHeaders), so "alice " vs htpasswd "alice" is a 401 on
// every request and the page falls back to the web token screen. Node only, no Electron, no window.
//   A. board-secrets.mjs configure()/configureOs(): refuse a username with surrounding whitespace (explicit error,
//      nothing written); the password is stored byte-for-byte (spaces are legal password characters, never trimmed)
//   B. Board-tab sign-in card (board-signin.js): trims the username before setSecrets / setSecretsOs
//   C. Settings sign-in form (settings.js): trims the username before setSecrets
//   node scripts/check-board-user-trim.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSecretsController } from '../src/main/board-secrets.mjs';
import { createBoardHost } from '../tauri/sidecar/board-host.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
process.on('unhandledRejection', () => {}); // unrelated Settings cards run on stubs here
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`); };

const USER = 'alice', PASS = 'fake pass ', PIN = '482913';
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from([...Buffer.from(s, 'utf8')].map((b) => b ^ 0x5a)),
  decryptString: (b) => Buffer.from([...b].map((x) => x ^ 0x5a)).toString('utf8'),
};
const dirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'zumi-user-trim-')); dirs.push(d); return d; };
const settle = () => new Promise((r) => setTimeout(r, 30));

// ---------- A. controller ----------
{
  for (const [label, user] of [['trailing space', `${USER} `], ['leading space', ` ${USER}`], ['trailing tab', `${USER}\t`], ['trailing NBSP', `${USER} `]]) {
    const dir = tmp();
    const c = createSecretsController({ safeStorage, dir });
    const r = c.configure({ token: '', user, pass: PASS, pin: PIN });
    check(`A1 configure refuses a username with a ${label}: bad_user_whitespace, nothing stored`, r.ok === false && r.error === 'bad_user_whitespace' && c.status().configured === false && c.getSecrets() === null, { r, st: c.status() });
    const dirOs = tmp();
    const cOs = createSecretsController({ safeStorage, dir: dirOs });
    const rOs = cOs.configureOs({ token: '', user, pass: PASS });
    check(`A2 configureOs refuses a username with a ${label}: bad_user_whitespace, nothing stored`, rOs.ok === false && rOs.error === 'bad_user_whitespace' && cOs.status().configured === false, { rOs });
  }
  const c = createSecretsController({ safeStorage, dir: tmp() });
  const ok = c.configure({ token: '', user: 'alice admin', pass: PASS, pin: PIN });
  check('A3 an inner space is not refused (only surrounding whitespace)', ok.ok === true && c.getSecrets().user === 'alice admin', ok);
  check('A4 the password is stored byte-for-byte, its trailing space kept', ok.ok === true && c.getSecrets().pass === PASS, c.getSecrets() && c.getSecrets().pass.length);
  const empty = createSecretsController({ safeStorage, dir: tmp() }).configure({ token: '', user: '', pass: PASS, pin: PIN });
  check('A5 an empty username is still bad_secrets_shape (unchanged)', empty.ok === false && empty.error === 'bad_secrets_shape', empty);
}

// ---------- fake DOM + sidecar-backed zumi ----------
const hosts = [];
function freshHost(requireBoardPin = true) {
  let st = { requireBoardPin };
  const host = createBoardHost({ safeStorage, dataDir: tmp(), flavour: { values: { ownerAdmin: true } }, settings: () => st, saveSettings: (p) => { st = { ...st, ...p }; return st; }, signals: null, idleLock: false });
  hosts.push(host);
  return host;
}
const zumiFor = (host) => {
  const board = {};
  for (const k of ['status', 'setSecrets', 'setSecretsOs', 'unlock', 'lock', 'setMode', 'signOut', 'setPinRequired', 'enablePin', 'disablePin', 'liveOpen']) board[k] = async (...a) => host.handlers[`board.${k}`](...a);
  const quiet = new Proxy(() => Promise.resolve({}), { get: (t, p) => (p === 'then' ? undefined : quiet), apply: () => Promise.resolve({}) });
  return new Proxy({ board, onWindowFocus: () => {} }, { get: (t, p) => (p in t ? t[p] : quiet) });
};
const mkEl = () => {
  const e = { hidden: false, disabled: false, textContent: '', value: '', className: '', checked: false, innerHTML: '', style: { setProperty() {} }, dataset: {}, listeners: {},
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    addEventListener(ev, fn) { (e.listeners[ev] ||= []).push(fn); }, removeEventListener() {}, setAttribute() {}, getAttribute: () => null, appendChild() {}, focus() {}, querySelector: () => mkEl(), querySelectorAll: () => [] };
  return e;
};
const els = new Map();
const $ = (id) => {
  if (!els.has(id)) { const e = mkEl(); if (id === 'signin-user' || id === 'signin-pass') { e.previousElementSibling = mkEl(); e.nextElementSibling = mkEl(); } els.set(id, e); }
  return els.get(id);
};
globalThis.document = { createElement: mkEl, querySelector: () => null, querySelectorAll: () => [], documentElement: {}, addEventListener() {}, dispatchEvent() { return true; }, getElementById: $ };
const click = async (id) => { for (const fn of $(id).listeners.click || []) await fn(); await settle(); };
const stored = (host) => host.liveBoard.secrets.getSecrets();

const { initBoardSignin } = await import(pathToFileURL(path.join(root, 'src/renderer/board-signin.js')).href);
const { initSettings } = await import(pathToFileURL(path.join(root, 'src/renderer/settings.js')).href);

// ---------- B. Board-tab sign-in card ----------
for (const pinRequired of [true, false]) {
  const host = freshHost(pinRequired);
  els.clear();
  const card = initBoardSignin(zumiFor(host), $, {});
  card.render(host.handlers['board.status']());
  $('signin-user').value = `  ${USER} `; $('signin-pass').value = PASS; $('signin-pin').value = PIN;
  await click('signin-button');
  const s = stored(host);
  check(`B1 card (${pinRequired ? 'PIN' : 'no PIN'}) stores the username trimmed`, !!s && s.user === USER, s && { user: JSON.stringify(s.user) });
  check(`B2 card (${pinRequired ? 'PIN' : 'no PIN'}) keeps the password untrimmed`, !!s && s.pass === PASS, s && s.pass.length);
}

// ---------- C. Settings sign-in form ----------
{
  const host = freshHost(true);
  els.clear();
  initSettings(zumiFor(host), $, { ownerAdmin: true });
  await settle();
  $('board-user').value = `${USER} `; $('board-pass').value = PASS; $('board-pin').value = PIN; $('board-pin-confirm').value = PIN;
  await click('board-save');
  const s = stored(host) || (host.handlers['board.unlock'](PIN), stored(host)); // Settings re-locks after saving
  check('C1 Settings form stores the username trimmed', !!s && s.user === USER, s ? { user: JSON.stringify(s.user) } : host.handlers['board.status']());
  check('C2 Settings form keeps the password untrimmed', !!s && s.pass === PASS, s && s.pass.length);
}

for (const h of hosts) await h.dispose();
for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
