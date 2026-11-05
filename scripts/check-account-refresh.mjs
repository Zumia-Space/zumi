// T-31 0.2.11: Settings > Account card must read "Connected" right after a Board-tab sign-in, with NO window-focus event.
// Before the fix the sign-in path (app.js initBoardSignin onDone) only re-rendered the Board tab, so the Settings card
// kept "Not set up" until the window regained focus. Node only, no Electron, no window.
// The real board-signin.js and settings.js run on a fake DOM + fake IPC; the onDone wiring is lifted from app.js by text.
//   node scripts/check-account-refresh.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
process.on('unhandledRejection', () => {}); // unrelated Settings cards run on stubs here
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`); };

const appSrc = fs.readFileSync(path.join(root, 'src/renderer/app.js'), 'utf8');
const m = appSrc.match(/initBoardSignin\(zumi, \$, \{ onDone: ([\s\S]*?) \}\);/);
check('1 app.js wires initBoardSignin with an onDone hook', !!m);

const { TABLES } = await import(pathToFileURL(path.join(root, 'src/renderer/i18n.js')).href);
const CONNECTED = TABLES.en['settings.chipConnected'], NOT_SET = TABLES.en['settings.chipNotSet'];

const mkEl = () => {
  const e = { hidden: false, disabled: false, textContent: '', value: '', className: '', checked: false, innerHTML: '', style: { setProperty() {} }, dataset: {}, listeners: {},
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    addEventListener(ev, fn) { (e.listeners[ev] ||= []).push(fn); }, removeEventListener() {}, setAttribute() {}, getAttribute: () => null, appendChild() {}, focus() {},
    querySelector: () => mkEl(), querySelectorAll: () => [] };
  e.previousElementSibling = mkEl2(); e.nextElementSibling = mkEl2();
  return e;
};
function mkEl2() { return { hidden: false, textContent: '' }; }
const els = new Map();
const $ = (id) => { if (!els.has(id)) els.set(id, mkEl()); return els.get(id); };
// a document that really delivers events to its listeners (the real DOM does)
const docListeners = {};
globalThis.document = {
  createElement: mkEl, querySelector: () => null, querySelectorAll: () => [], documentElement: {}, getElementById: $,
  addEventListener(ev, fn) { (docListeners[ev] ||= []).push(fn); },
  dispatchEvent(ev) { for (const fn of docListeners[ev.type] || []) fn(ev); return true; },
};

let keystore = { configured: false, locked: true, mode: 'local', pinRequired: true };
const quiet = new Proxy(() => Promise.resolve({}), { get: (t, p) => (p === 'then' ? undefined : quiet), apply: () => Promise.resolve({}) });
const zumi = new Proxy({
  board: {
    status: async () => ({ ...keystore }),
    setSecrets: async () => { keystore = { configured: true, locked: false, mode: 'local', pinRequired: true }; return { ok: true }; },
    setMode: async (mode) => { keystore = { ...keystore, mode }; return { ok: true }; },
    lock: async () => true, unlock: async () => ({ ok: true }), setPinRequired: async () => ({ ok: true }),
  },
  onWindowFocus: () => {}, // never fires in this check: that is the point
}, { get: (t, p) => (p in t ? t[p] : quiet) });
const settle = () => new Promise((r) => setTimeout(r, 30));

const { initSettings } = await import(pathToFileURL(path.join(root, 'src/renderer/settings.js')).href);
const { initBoardSignin } = await import(pathToFileURL(path.join(root, 'src/renderer/board-signin.js')).href);

let boardTabRefreshes = 0;
await initSettings(zumi, $, {});
check('2 before sign-in the Account card reads "Not set up"', $('board-chip').textContent === NOT_SET, $('board-chip').textContent);

const onDone = m ? new Function('refreshBoardTab', 'document', 'CustomEvent', `return (${m[1]});`)(() => { boardTabRefreshes++; }, globalThis.document, CustomEvent) : undefined;
initBoardSignin(zumi, $, { onDone });
$('signin-user').value = 'u'; $('signin-pass').value = 'p'; $('signin-pin').value = '123456';
for (const fn of $('signin-button').listeners.click || []) await fn();
await settle();

check('3 sign-in succeeded (keystore configured, live)', keystore.configured === true && keystore.mode === 'live', keystore);
check('4 the Board tab was refreshed', boardTabRefreshes >= 1, boardTabRefreshes);
check('5 Account card reads "Connected" right after sign-in, no focus event', $('board-chip').textContent === CONNECTED, { chip: $('board-chip').textContent });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
