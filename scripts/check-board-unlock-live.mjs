// T-31-TAURI owner build: a SUCCESSFUL PIN unlock must open the live board, not loop back to the PIN card.
// board-live.mjs only starts in mode 'live' when credentials already exist at launch; a sign-in saved during this
// session through Settings ("Save and lock with PIN") leaves the mode 'local' (owner builds hide the mode switch).
// app.js renderOwnerBoardTab shows the sign-in card while `mode !== 'live' || locked`, so both unlock paths must
// flip the mode to 'live' after an ok unlock, and a FAILED unlock must not. Node only, no Electron, no window:
// the renderer modules run on a fake DOM, zumi.board is the real Tauri sidecar handler set (board-host.mjs).
//   A. Board-tab sign-in card PIN unlock (board-signin.js)
//   B. Settings > Account "Unlock" (settings.js), owner build; non-owner keeps its own mode choice
//   node scripts/check-board-unlock-live.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createBoardHost } from '../tauri/sidecar/board-host.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
process.on('unhandledRejection', () => {}); // unrelated Settings cards run on stubs here
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`); };

const SECRET = { token: '', user: 'fake-unlock-user', pass: 'fake-unlock-pass' };
const PIN = '482913', WRONG = '000000';
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from([...Buffer.from(s, 'utf8')].map((b) => b ^ 0x5a)),
  decryptString: (b) => Buffer.from([...b].map((x) => x ^ 0x5a)).toString('utf8'),
};
const dirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'zumi-unlock-live-')); dirs.push(d); return d; };
const settle = () => new Promise((r) => setTimeout(r, 30));
// What the owner Board tab decides from a status (app.js renderOwnerBoardTab): true = sign-in card again.
const showsCard = (s) => s.mode !== 'live' || s.locked;
const pick = (s) => ({ mode: s.mode, configured: s.configured, locked: s.locked });

// A fresh sidecar host in the state the bug needs: signed in THIS session through Settings' "Save and lock with PIN"
// (setSecrets + lock), so mode is still 'local' and the keystore is locked.
const hosts = [];
function signedInThenLocked() {
  let st = { requireBoardPin: true };
  const host = createBoardHost({ safeStorage, dataDir: tmp(), flavour: { values: { ownerAdmin: true } }, settings: () => st, saveSettings: (p) => { st = { ...st, ...p }; return st; }, signals: null, idleLock: false });
  hosts.push(host);
  const r = host.handlers['board.setSecrets']({ ...SECRET, pin: PIN });
  host.handlers['board.lock']();
  return { host, configured: r && r.ok };
}
const zumiFor = (host) => {
  const h = host.handlers;
  const board = {};
  for (const k of ['status', 'setSecrets', 'setSecretsOs', 'unlock', 'lock', 'setMode', 'signOut', 'setPinRequired', 'enablePin', 'disablePin', 'liveOpen']) board[k] = async (...a) => h[`board.${k}`](...a);
  const quiet = new Proxy(() => Promise.resolve({}), { get: (t, p) => (p === 'then' ? undefined : quiet), apply: () => Promise.resolve({}) });
  return new Proxy({ board, onWindowFocus: () => {} }, { get: (t, p) => (p in t ? t[p] : quiet) });
};

// Fake DOM (same shape as check-board-signout.mjs), plus the sibling links board-signin.js reads.
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

const { initBoardSignin } = await import(pathToFileURL(path.join(root, 'src/renderer/board-signin.js')).href);
const { initSettings } = await import(pathToFileURL(path.join(root, 'src/renderer/settings.js')).href);

// ---------- A. Board-tab sign-in card (board-signin.js) ----------
{
  const { host, configured } = signedInThenLocked();
  const before = host.handlers['board.status']();
  check('A0 precondition: signed in this session, locked, mode local -> owner tab shows the card', configured && before.configured && before.locked && before.mode === 'local' && showsCard(before), pick(before));
  els.clear();
  let done = 0;
  const card = initBoardSignin(zumiFor(host), $, { onDone: () => { done++; } });
  card.render(before);
  $('signin-pin').value = PIN;
  await click('signin-button');
  const after = host.handlers['board.status']();
  check('A1 card PIN unlock ok -> unlocked AND mode live (tab opens the live board, no card loop)', !after.locked && after.mode === 'live' && !showsCard(after), pick(after));
  check('A2 card PIN unlock ok -> onDone fired once (Board tab re-renders)', done === 1, done);
}
{
  const { host } = signedInThenLocked();
  els.clear();
  let done = 0;
  const card = initBoardSignin(zumiFor(host), $, { onDone: () => { done++; } });
  card.render(host.handlers['board.status']());
  $('signin-pin').value = WRONG;
  await click('signin-button');
  const after = host.handlers['board.status']();
  check('A3 card wrong PIN -> still locked, mode stays local, no onDone', after.locked && after.mode === 'local' && done === 0, { ...pick(after), done });
  check('A4 card wrong PIN -> an error note is shown', $('signin-note').textContent !== '', $('signin-note').textContent);
}

// ---------- B. Settings > Account Unlock (settings.js) ----------
async function settingsUnlock({ ownerAdmin, pin }) {
  const { host } = signedInThenLocked();
  els.clear();
  const seen = [];
  initSettings(zumiFor(host), $, { ownerAdmin, onBoardChange: (s) => seen.push(s) });
  await settle();
  $('board-unlock-pin').value = pin;
  await click('board-unlock');
  return { after: host.handlers['board.status'](), last: seen[seen.length - 1] };
}
{
  const { after, last } = await settingsUnlock({ ownerAdmin: true, pin: PIN });
  check('B1 owner Settings unlock ok -> unlocked AND mode live', !after.locked && after.mode === 'live' && !showsCard(after), pick(after));
  check('B2 owner Settings unlock ok -> the Board tab hook got the live+unlocked status', !!last && last.mode === 'live' && !last.locked, last && pick(last));
}
{
  const { after, last } = await settingsUnlock({ ownerAdmin: true, pin: WRONG });
  check('B3 owner Settings wrong PIN -> still locked, mode stays local', after.locked && after.mode === 'local', pick(after));
  check('B4 owner Settings wrong PIN -> the Board tab hook never saw live', !last || last.mode !== 'live', last && pick(last));
}
{
  const { after } = await settingsUnlock({ ownerAdmin: false, pin: PIN });
  check('B5 non-owner Settings unlock ok -> unlocked, mode left as the user chose it (local; the switch is visible there)', !after.locked && after.mode === 'local', pick(after));
}

for (const h of hosts) await h.dispose();
for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
