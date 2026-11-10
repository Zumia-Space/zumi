// T-31-TAURI 0.3.2 owner report (09-11): "a tat chuc nang pin di roi no van bat nhap pin moi vao duoc board".
// Measured on the installed app's data: board-secrets.bin is still PIN-sealed (type 'pin') and settings.json has no
// requireBoardPin key, i.e. the "Require PIN for Board" switch was flipped but the turn-off was never APPLIED.
// On a PIN-sealed store, unticking the switch only opens a "current PIN" prompt (the PIN cannot be dropped without
// proving it); settings.js painted the switch as OFF at once and kept it OFF after the owner left Settings, so it looked
// done while the Board kept asking for the PIN. Contract pinned here (real Tauri sidecar handlers, fake DOM, no Electron):
//   A. the prompt says in words that the PIN is STILL ON until Apply (and the mirror line for turning it on)
//   B. leaving the Settings tab drops the pending change: the switch repaints to the real state, the prompt closes
//   C. the happy path still works: right PIN + Apply turns it off for real and persists requireBoardPin:false
//   D. cancel / wrong PIN keep the real state and never report success
//   node scripts/check-board-pin-off-pending.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createBoardHost } from '../tauri/sidecar/board-host.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
process.on('unhandledRejection', () => {}); // unrelated Settings cards run on stubs here
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`); };

const PIN = '482913', WRONG = '000000';
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from([...Buffer.from(s, 'utf8')].map((b) => b ^ 0x5a)),
  decryptString: (b) => Buffer.from([...b].map((x) => x ^ 0x5a)).toString('utf8'),
};
const dirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'zumi-pinoff-')); dirs.push(d); return d; };
const settle = () => new Promise((r) => setTimeout(r, 30));

const mkEl = () => {
  const e = { hidden: false, disabled: false, textContent: '', value: '', className: '', checked: false, innerHTML: '', style: { setProperty() {} }, dataset: {}, listeners: {},
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    addEventListener(ev, fn) { (e.listeners[ev] ||= []).push(fn); }, removeEventListener() {}, setAttribute() {}, getAttribute: () => null, appendChild() {}, focus() {}, querySelector: () => mkEl(), querySelectorAll: () => [] };
  return e;
};
const els = new Map();
const $ = (id) => { if (!els.has(id)) els.set(id, mkEl()); return els.get(id); };
const docListeners = {};
globalThis.document = {
  createElement: mkEl, querySelector: () => null, querySelectorAll: () => [], documentElement: {}, getElementById: $,
  addEventListener(ev, fn) { (docListeners[ev] ||= []).push(fn); }, dispatchEvent() { return true; },
};
globalThis.CustomEvent ??= class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } };
const fire = async (id, ev) => { for (const fn of $(id).listeners[ev] || []) await fn(); await settle(); };
const docFire = async (type, detail) => { for (const fn of docListeners[type] || []) await fn({ type, detail }); await settle(); };

const { initSettings } = await import(pathToFileURL(path.join(root, 'src/renderer/settings.js')).href);

// A fresh owner-build host with a PIN-sealed, locked store: the state the installed app was in (measured).
const hosts = [];
function pinSealedHost() {
  let st = {};
  const host = createBoardHost({ safeStorage, dataDir: tmp(), flavour: { values: { ownerAdmin: true } }, settings: () => st, saveSettings: (p) => { st = { ...st, ...p }; return st; }, signals: null, idleLock: false });
  hosts.push(host);
  host.handlers['board.setSecrets']({ token: '', user: 'fake-pinoff-user', pass: 'fake-pinoff-pass', pin: PIN });
  host.handlers['board.lock']();
  return { host, settings: () => st };
}
const zumiFor = (host) => {
  const board = {};
  for (const k of ['status', 'setSecrets', 'setSecretsOs', 'unlock', 'lock', 'setMode', 'signOut', 'setPinRequired', 'enablePin', 'disablePin', 'liveOpen']) board[k] = async (...a) => host.handlers[`board.${k}`](...a);
  const quiet = new Proxy(() => Promise.resolve({}), { get: (t, p) => (p === 'then' ? undefined : quiet), apply: () => Promise.resolve({}) });
  return new Proxy({ board, onWindowFocus: () => {} }, { get: (t, p) => (p in t ? t[p] : quiet) });
};
async function mount(host) {
  els.clear();
  for (const k of Object.keys(docListeners)) delete docListeners[k];
  initSettings(zumiFor(host), $, { ownerAdmin: true });
  await settle();
}
const untick = async () => { $('board-pin-required').checked = false; await fire('board-pin-required', 'change'); };

// ---------- A. the prompt says the PIN is still on ----------
{
  const { host } = pinSealedHost();
  await mount(host);
  check('A0 precondition: PIN-sealed store, switch reads ON', host.handlers['board.status']().pinRequired === true && $('board-pin-required').checked === true);
  await untick();
  check('A1 unticking opens the current-PIN prompt', $('board-pin-toggle-prompt').hidden === false);
  check('A2 the prompt line says the PIN is STILL ON until Apply', /still on/i.test($('board-pin-toggle-note').textContent), $('board-pin-toggle-note').textContent);
  check('A3 nothing was applied yet: real status still PIN-required', host.handlers['board.status']().pinRequired === true);
}

// ---------- B. leaving Settings drops the pending change ----------
{
  const { host } = pinSealedHost();
  await mount(host);
  await untick();
  check('B0 precondition: switch shows OFF while the prompt is open', $('board-pin-required').checked === false && $('board-pin-toggle-prompt').hidden === false);
  await docFire('zumi:tab', 'board');
  check('B1 owner opens the Board tab: the prompt closes', $('board-pin-toggle-prompt').hidden === true);
  check('B2 ... and the switch repaints to the REAL state (ON), not a fake OFF', $('board-pin-required').checked === true, $('board-pin-required').checked);
  check('B3 coming back to Settings shows no stale prompt text', $('board-pin-toggle-note').textContent === '');
  // Moving between Settings' own inner tabs is not a tab change: a pending prompt stays.
  await untick();
  await docFire('zumi:tab', 'settings');
  check('B4 a tab event for Settings itself keeps the open prompt', $('board-pin-toggle-prompt').hidden === false && $('board-pin-required').checked === false);
}

// ---------- C. happy path ----------
{
  const { host, settings } = pinSealedHost();
  await mount(host);
  await untick();
  $('board-pin-toggle-pin').value = PIN;
  await fire('board-pin-toggle-apply', 'click');
  const s = host.handlers['board.status']();
  check('C1 right PIN + Apply: store is no longer PIN-required, unlocked', s.pinRequired === false && s.locked === false, s);
  check('C2 requireBoardPin:false persisted', settings().requireBoardPin === false);
  check('C3 prompt closed, switch OFF', $('board-pin-toggle-prompt').hidden === true && $('board-pin-required').checked === false);
}

// ---------- D. cancel / wrong PIN ----------
{
  const { host, settings } = pinSealedHost();
  await mount(host);
  await untick();
  await fire('board-pin-toggle-cancel', 'click');
  check('D1 Cancel: switch back ON, prompt closed, status unchanged', $('board-pin-required').checked === true && $('board-pin-toggle-prompt').hidden === true && host.handlers['board.status']().pinRequired === true);
  await untick();
  $('board-pin-toggle-pin').value = WRONG;
  await fire('board-pin-toggle-apply', 'click');
  check('D2 wrong PIN: still PIN-required, nothing persisted, prompt stays open with a wrong-PIN line', host.handlers['board.status']().pinRequired === true && settings().requireBoardPin === undefined && $('board-pin-toggle-prompt').hidden === false && $('board-pin-toggle-note').textContent.length > 0);
}

// ---------- E. ticking back / re-ticking never opens a prompt for the state the store is ALREADY in ----------
// 0.3.3 install report (10-11): after a turn-off the switch was clicked once more and the panel offered "choose a NEW PIN"
// while the old "PIN requirement turned off" line still sat under it. The switch toggles relative to what it DISPLAYS
// (the pending target), not relative to the real state, so a second click is "back to what is real" = cancel.
const tick = async () => { $('board-pin-required').checked = true; await fire('board-pin-required', 'change'); };
{
  const { host, settings } = pinSealedHost();
  await mount(host);
  await untick();
  await tick();
  check('E1 untick then tick again on a PIN-ON store: prompt closes, no "new PIN" prompt', $('board-pin-toggle-prompt').hidden === true, { hidden: $('board-pin-toggle-prompt').hidden, note: $('board-pin-toggle-note').textContent });
  check('E2 ... switch reads ON, nothing applied or persisted', $('board-pin-required').checked === true && host.handlers['board.status']().pinRequired === true && settings().requireBoardPin === undefined);
}
{
  const { host } = pinSealedHost();
  await mount(host);
  await untick();
  $('board-pin-toggle-pin').value = PIN;
  await fire('board-pin-toggle-apply', 'click');
  check('E3 precondition: turned off with the right PIN, the turned-off line shows', host.handlers['board.status']().pinRequired === false && $('board-session-note').textContent.length > 0);
  await tick();
  check('E4 re-ticking an OFF store opens the new-PIN prompt (a real change)', $('board-pin-toggle-prompt').hidden === false && $('board-pin-toggle-confirm').hidden === false);
  check('E5 ... and the stale "turned off" line is gone', $('board-session-note').textContent === '', $('board-session-note').textContent);
  await untick();
  check('E6 un-ticking again on an OFF store: prompt closes, switch OFF, still no PIN', $('board-pin-toggle-prompt').hidden === true && $('board-pin-required').checked === false && host.handlers['board.status']().pinRequired === false);
}
// F. an UNLOCKED session (the install report's state) gets no shortcut: nothing but Apply + the right PIN changes the store.
{
  const { host, settings } = pinSealedHost();
  host.handlers['board.unlock'](PIN);
  await mount(host);
  check('F0 precondition: unlocked, PIN-sealed', host.handlers['board.status']().locked === false && host.handlers['board.status']().pinRequired === true);
  await untick();
  check('F1 unlocked: unticking still only opens the prompt, store untouched', $('board-pin-toggle-prompt').hidden === false && host.handlers['board.status']().pinRequired === true && settings().requireBoardPin === undefined);
  await fire('board-pin-toggle-cancel', 'click');
  check('F2 unlocked: Cancel writes nothing and the switch reads ON', host.handlers['board.status']().pinRequired === true && settings().requireBoardPin === undefined && $('board-pin-required').checked === true);
  await untick();
  $('board-pin-toggle-pin').value = '';
  await fire('board-pin-toggle-apply', 'click');
  check('F3 unlocked + Apply with an empty PIN: refused, still PIN-required', host.handlers['board.status']().pinRequired === true && settings().requireBoardPin === undefined);
}

for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
console.log(`\n${fail ? 'FAIL' : 'PASS'} check-board-pin-off-pending - ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
