// T-31 batch-1 box probe, finding 3: the sidecar-death banner, run in its OWN process by
// scripts/check-tauri-sidecar-error.mjs.
//
// Why a child process: this imports the REAL renderer module (src/renderer/sidecar-status.js) and the REAL i18n
// table, with a tiny fake DOM. The parent only reads the JSON result; nothing here touches the app, Electron,
// the Tauri host or a window.
//
// Input: none. Output: one JSON line { results: [{ ok, name, detail }] } on stdout.
import { initSidecarStatus } from '../src/renderer/sidecar-status.js';
import { setLocale, t } from '../src/renderer/i18n.js';

const results = [];
const ok = (cond, name, detail = '') => results.push({ ok: Boolean(cond), name, detail: String(detail || '') });

function makeDom() {
  const created = [];
  const makeEl = (tag) => {
    const el = { tag: String(tag || 'div'), id: '', className: '', hidden: false, dataset: {}, attrs: {}, children: [], handlers: {} };
    let text = '';
    Object.defineProperty(el, 'textContent', { get() { return text; }, set(v) { text = String(v); } });
    el.appendChild = (c) => { c.parentNode = el; el.children.push(c); return c; };
    el.setAttribute = (k, v) => { el.attrs[k] = String(v); };
    el.getAttribute = (k) => (Object.prototype.hasOwnProperty.call(el.attrs, k) ? el.attrs[k] : null);
    created.push(el);
    return el;
  };
  const host = makeEl('div');
  host.id = 'stage';
  const doc = {
    body: makeEl('body'),
    getElementById: (id) => (host.id === id ? host : null),
    createElement: (tag) => makeEl(tag),
  };
  return { created, host, doc };
}

function makeWin({ tauri }) {
  const handlers = {};
  return {
    __TAURI__: tauri ? {} : undefined,
    addEventListener: (type, fn) => { (handlers[type] = handlers[type] || []).push(fn); },
    fire: (type, detail) => { for (const fn of handlers[type] || []) fn({ type, detail }); },
  };
}

setLocale('en');

// ---- Electron: no window.__TAURI__ -> no module, no DOM ----
{
  const dom = makeDom();
  const before = dom.created.length;
  const win = makeWin({ tauri: false });
  const api = initSidecarStatus({ win, doc: dom.doc, t });
  ok(api === null && dom.created.length === before, 'Electron (no __TAURI__): builds no DOM at all');
}

// ---- Tauri: error paints, ready clears ----
{
  const dom = makeDom();
  const win = makeWin({ tauri: true });
  const api = initSidecarStatus({ win, doc: dom.doc, t });
  ok(Boolean(api && api.el && api.el.id === 'sidecar-status'), 'Tauri: the banner element is created on #stage');
  ok(api && api.el.hidden === true && api.el.attrs.role === 'alert', 'Tauri: the banner starts hidden and is an alert');
  win.fire('zumi:sidecar-error', { fatal: false, reason: 'sidecar_exited', message: 'the app sidecar stopped; restarting' });
  ok(api && api.el.hidden === false && api.el.dataset.state === 'restarting', 'a recoverable sidecar:error shows the banner (state restarting)');
  ok(api && api.el.textContent === "Zumi's background service stopped — restarting…", 'en: the restart line is the owner-facing words', api && api.el.textContent);
  win.fire('zumi:sidecar-ready', null);
  ok(api && api.el.hidden === true && api.el.textContent === '' && !('state' in api.el.dataset), 'sidecar:ready (the restart answered) clears the banner');
  win.fire('zumi:sidecar-ready', null);
  ok(api && api.el.hidden === true, 'a ready with no error before it is a no-op');
}

// ---- a fatal failure says so and stays until the app restarts ----
{
  const dom = makeDom();
  const win = makeWin({ tauri: true });
  const api = initSidecarStatus({ win, doc: dom.doc, t });
  win.fire('zumi:sidecar-error', { fatal: true, message: 'protocol mismatch' });
  ok(api && api.el.hidden === false && api.el.dataset.state === 'fatal' && api.el.textContent === "Zumi's background service stopped. Restart Zumi to continue.",
    'a fatal sidecar:error uses the restart-Zumi line', api && api.el.textContent);
}

// ---- all three locales carry the two strings ----
for (const [locale, restart, failed] of [
  ['vi', 'Dịch vụ nền của Zumi đã dừng — đang khởi động lại…', 'Dịch vụ nền của Zumi đã dừng. Hãy khởi động lại Zumi để tiếp tục.'],
  ['zh', 'Zumi 的后台服务已停止 — 正在重新启动…', 'Zumi 的后台服务已停止。请重新启动 Zumi 以继续。'],
  ['en', "Zumi's background service stopped — restarting…", "Zumi's background service stopped. Restart Zumi to continue."],
]) {
  setLocale(locale);
  const dom = makeDom();
  const win = makeWin({ tauri: true });
  const api = initSidecarStatus({ win, doc: dom.doc, t });
  win.fire('zumi:sidecar-error', { fatal: false });
  const gotRestart = api && api.el.textContent;
  win.fire('zumi:sidecar-error', { fatal: true });
  const gotFailed = api && api.el.textContent;
  ok(gotRestart === restart && gotFailed === failed, `${locale}: both sidecar strings are translated`, JSON.stringify({ gotRestart, gotFailed }));
}
setLocale('en');

process.stdout.write(`${JSON.stringify({ results })}\n`);
