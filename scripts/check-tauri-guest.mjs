// T-31 P1b guest-element check. Plain Node, no Electron, no window, no network.
//
// Runs tauri/shim/webview-element.js against a hand-rolled fake DOM (no jsdom, no new deps) and checks
// the contract the renderer's app.js relies on:
//   - only `webview` elements are decorated;
//   - attach calls guest_open with src/partition/bounds; detach calls guest_close;
//   - guest:event -> DOM dom-ready / did-finish-load / did-fail-load, in order, with the fail fields;
//   - loadURL resolves on a load, rejects on a navigation failure, and works before attach;
//   - the rAF loop reports visible:false for a zero rect and only calls guest_bounds on change;
//   - the self-test Electron methods route to the one guest_cdp command (never a local fake), and refuse before the
//     guest is open;
//   - prep-ui assembles zumi-shim -> webview-element -> app.js and adds no frame-src, writing to a
//     temp dir so the real tauri/ui is left byte-identical.
//
//   node scripts/check-tauri-guest.mjs   (exit 1 on any failure)
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
const ok = (cond, name, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${detail ? '  ' + detail : ''}`); }
};

// A content digest of a directory tree (path + bytes of every file). Used to prove the check never
// touches the real tauri/ui. 'absent' when the dir does not exist (gitignored build output may be).
const dirDigest = (dir) => {
  if (!fs.existsSync(dir)) return 'absent';
  const hash = crypto.createHash('sha256');
  const walk = (d) => {
    const entries = fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const p = path.join(d, e.name);
      const rel = path.relative(dir, p);
      if (e.isDirectory()) { hash.update(`D ${rel}\n`); walk(p); }
      else { hash.update(`F ${rel} ${fs.readFileSync(p).length}\n`); hash.update(fs.readFileSync(p)); }
    }
  };
  walk(dir);
  return hash.digest('hex');
};

const TMP_ROOT = path.join(ROOT, '.tauri-check-tmp');
fs.rmSync(TMP_ROOT, { recursive: true, force: true });
fs.mkdirSync(TMP_ROOT, { recursive: true });

// ---- the fake DOM ----
class FakeEvent {
  constructor(type) { this.type = type; }
}
class FakeNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.attributes = Object.create(null);
    this.childNodes = [];
    this.parentNode = null;
    this.isConnected = false;
    this._rect = { x: 0, y: 0, width: 0, height: 0 };
    this._listeners = Object.create(null);
    this.dispatched = [];
  }
  getAttribute(name) { return name in this.attributes ? this.attributes[name] : null; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  appendChild(child) { child.parentNode = this; this.childNodes.push(child); setConnected(child, this.isConnected); return child; }
  removeChild(child) {
    const i = this.childNodes.indexOf(child);
    if (i >= 0) this.childNodes.splice(i, 1);
    child.parentNode = null;
    setConnected(child, false);
    return child;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  getBoundingClientRect() { return this._rect; }
  querySelectorAll(selector) {
    const tag = String(selector).toUpperCase();
    const out = [];
    const walk = (n) => { for (const c of n.childNodes) { if (c.tagName === tag) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  addEventListener(type, handler) { (this._listeners[type] || (this._listeners[type] = [])).push(handler); }
  removeEventListener(type, handler) {
    const list = this._listeners[type];
    if (list) { const i = list.indexOf(handler); if (i >= 0) list.splice(i, 1); }
  }
  dispatchEvent(event) {
    event.target = this;
    this.dispatched.push(event);
    for (const handler of (this._listeners[event.type] || []).slice()) handler(event);
    return true;
  }
}
function setConnected(node, connected) {
  node.isConnected = connected;
  for (const child of node.childNodes) setConnected(child, connected);
}

// Load the shim once; each test gets its own world (document + fakes + install).
const CODE = fs.readFileSync(path.join(ROOT, 'tauri', 'shim', 'webview-element.js'), 'utf8');
const sandbox = {
  // A browser global the shim uses for capturePage's base64; a fresh vm context has no atob of its own.
  atob: (value) => Buffer.from(String(value), 'base64').toString('binary'),
};
vm.runInNewContext(CODE, sandbox, { filename: 'webview-element.js' });
const install = sandbox.installWebviewElement;

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function newWorld() {
  const observers = [];
  class FakeMutationObserver {
    constructor(cb) { this.cb = cb; observers.push(this); }
    observe() { /* the test triggers explicitly */ }
    disconnect() {}
    trigger(added, removed) {
      this.cb([{ type: 'childList', addedNodes: added || [], removedNodes: removed || [] }], this);
    }
  }
  const docProto = { createElement(tag) { return new FakeNode(tag); } };
  const body = new FakeNode('body');
  body.isConnected = true;
  const doc = Object.create(docProto);
  doc.body = body;
  doc.documentElement = body;
  doc.defaultView = { MutationObserver: FakeMutationObserver, Event: FakeEvent };

  const calls = [];
  const opened = [];
  const listeners = new Map();
  const behavior = { openReject: null, navigate: () => Promise.resolve(true), cdpReject: null };
  let nextId = 1;
  let rafCb = null;

  const invoke = (cmd, payload) => {
    calls.push({ cmd, payload });
    if (cmd === 'guest_open') {
      if (behavior.openReject) return Promise.reject(behavior.openReject);
      const id = nextId++;
      opened.push(id);
      return Promise.resolve({ id });
    }
    if (cmd === 'guest_navigate') return behavior.navigate(payload);
    if (cmd === 'guest_cdp') {
      if (behavior.cdpReject) return Promise.reject(behavior.cdpReject);
      const reply = { ok: true, width: 8, height: 4, pngBase64: 'iVBORw0KGgo=', bitmapBase64: 'AAAAAAAA' };
      return Promise.resolve(reply);
    }
    return Promise.resolve(null);
  };
  const listen = (name, handler) => { listeners.set(name, handler); return Promise.resolve(() => {}); };
  const raf = (cb) => { rafCb = cb; };

  const api = install({ document: doc, invoke, listen, raf });

  return {
    doc, body, calls, opened, listeners, behavior, api,
    fire(added, removed) { for (const observer of observers) observer.trigger(added, removed); },
    emit(payload) { const handler = listeners.get('guest:event'); if (handler) handler(payload); },
    tick() { const cb = rafCb; rafCb = null; if (cb) cb(0); },
  };
}

function addGuest(w, src = 'http://127.0.0.1:4321/', partition = 'preview-board', rect = { x: 5, y: 6, width: 800, height: 600 }) {
  const wv = w.doc.createElement('webview');
  if (src != null) wv.setAttribute('src', src);
  if (partition != null) wv.setAttribute('partition', partition);
  wv._rect = rect;
  w.body.appendChild(wv);
  w.fire([wv], []);
  return wv;
}

(async () => {
  ok(typeof install === 'function', 'webview-element.js exposes installWebviewElement');

  // ---- 1. only 'webview' (any case) is decorated ----
  {
    const w = newWorld();
    const div = w.doc.createElement('div');
    ok(div.tagName === 'DIV' && typeof div.loadURL === 'undefined' && div.__zumiWebview === undefined, 'other tags are untouched');
    const wv = w.doc.createElement('webview');
    ok(wv.tagName === 'WEBVIEW' && typeof wv.loadURL === 'function' && typeof wv.getURL === 'function', 'a webview element gets loadURL/getURL');
    const upper = w.doc.createElement('WEBVIEW');
    ok(typeof upper.loadURL === 'function', 'the tag match is case-insensitive');
  }

  // ---- 2. attach -> guest_open args ----
  {
    const w = newWorld();
    const src = 'http://127.0.0.1:4321/?embed=1&lang=en#token=abc';
    const wv = addGuest(w, src, 'preview-board', { x: 5, y: 6, width: 800, height: 600 });
    await flush();
    const open = w.calls.find((c) => c.cmd === 'guest_open');
    ok(open && open.payload.src === src && open.payload.partition === 'preview-board' &&
      open.payload.bounds.x === 5 && open.payload.bounds.y === 6 && open.payload.bounds.width === 800 && open.payload.bounds.height === 600,
      'attach calls guest_open with src, partition and bounds', JSON.stringify(open && open.payload));
    ok(w.opened.length === 1, 'exactly one guest is opened per attach');
    // A second mutation for the same node must not open it twice.
    w.fire([wv], []);
    await flush();
    ok(w.opened.length === 1, 'a repeated attach mutation does not open the guest twice');
  }

  // ---- 3. guest:event dispatch, order, and the fail fields ----
  {
    const w = newWorld();
    const wv = addGuest(w);
    await flush();
    const id = w.opened[0];
    const order = [];
    wv.addEventListener('dom-ready', () => order.push('dom-ready'));
    wv.addEventListener('did-finish-load', () => order.push('did-finish-load'));
    let failEvent = null;
    wv.addEventListener('did-fail-load', (e) => { failEvent = e; });
    w.emit({ id, type: 'dom-ready', url: 'http://127.0.0.1:4321/' });
    w.emit({ id, type: 'did-finish-load', url: 'http://127.0.0.1:4321/' });
    ok(order.join(',') === 'dom-ready,did-finish-load', 'guest:event dispatches dom-ready then did-finish-load', order.join(','));
    w.emit({ id, type: 'did-fail-load', errorCode: -102, errorDescription: 'ERR_CONNECTION_REFUSED', webErrorStatus: 12 });
    ok(failEvent && failEvent.errorCode === -102 && failEvent.errorDescription === 'ERR_CONNECTION_REFUSED' && failEvent.webErrorStatus === 12,
      'did-fail-load carries errorCode + errorDescription + the raw webErrorStatus', JSON.stringify(failEvent && { code: failEvent.errorCode, desc: failEvent.errorDescription, status: failEvent.webErrorStatus }));
  }

  // ---- 4. an event that arrives before the id is known is buffered ----
  {
    const w = newWorld();
    const wv = addGuest(w);
    let failEvent = null;
    wv.addEventListener('did-fail-load', (e) => { failEvent = e; });
    // The host can emit before the guest_open reply is delivered (a probe failure does exactly this).
    w.emit({ id: 1, type: 'did-fail-load', errorCode: -102, errorDescription: 'ERR_CONNECTION_REFUSED' });
    await flush();
    ok(failEvent && failEvent.errorCode === -102, 'an event that arrives before the id is known is delivered after it resolves');
  }

  // ---- 5. loadURL resolve / reject / getURL ----
  {
    const w = newWorld();
    const wv = addGuest(w);
    await flush();
    const id = w.opened[0];
    let resolved = false;
    const p = wv.loadURL('http://127.0.0.1:4321/#/task/7').then(() => { resolved = true; });
    const nav = w.calls.find((c) => c.cmd === 'guest_navigate');
    ok(nav && nav.payload.id === id && nav.payload.url === 'http://127.0.0.1:4321/#/task/7', 'loadURL on an open guest calls guest_navigate with the id + url', JSON.stringify(nav && nav.payload));
    await p;
    ok(resolved, 'loadURL resolves when guest_navigate resolves');
    ok(wv.getURL() === 'http://127.0.0.1:4321/#/task/7', 'getURL returns the last URL synchronously');

    w.behavior.navigate = () => Promise.reject(new Error('guest_probe_failed'));
    let rejected = null;
    try { await wv.loadURL('http://127.0.0.1:4321/again'); } catch (e) { rejected = e; }
    ok(rejected && rejected.message === 'guest_probe_failed', 'loadURL rejects when guest_navigate rejects', rejected && rejected.message);
  }

  // ---- 6. loadURL before attach ----
  {
    const w = newWorld();
    const wv = w.doc.createElement('webview');
    let resolved = false;
    const p = wv.loadURL('http://127.0.0.1:5500/').then(() => { resolved = true; });
    ok(w.calls.filter((c) => c.cmd === 'guest_open').length === 0, 'loadURL before attach does not open a guest yet');
    w.body.appendChild(wv);
    w.fire([wv], []);
    await flush();
    const open = w.calls.find((c) => c.cmd === 'guest_open');
    ok(open && open.payload.src === 'http://127.0.0.1:5500/', 'a loadURL before attach opens the guest with that URL', JSON.stringify(open && open.payload));
    const id = w.opened[0];
    w.emit({ id, type: 'did-finish-load', url: 'http://127.0.0.1:5500/' });
    await p;
    ok(resolved, 'the pre-attach loadURL resolves on that load');
  }

  // ---- 7. detach -> guest_close ----
  {
    const w = newWorld();
    const wv = addGuest(w);
    await flush();
    const id = w.opened[0];
    wv.remove();
    w.fire([], [wv]);
    await flush();
    const close = w.calls.find((c) => c.cmd === 'guest_close');
    ok(close && close.payload.id === id, 'detach calls guest_close with the guest id', JSON.stringify(close && close.payload));
  }

  // ---- 7b. removing the element while guest_open is in flight closes the guest ----
  {
    const w = newWorld();
    const wv = w.doc.createElement('webview');
    wv.setAttribute('src', 'http://127.0.0.1:4321/');
    w.body.appendChild(wv);
    w.fire([wv], []); // guest_open is invoked; its reply is still pending
    wv.remove();
    w.fire([], [wv]);
    await flush(); // the open reply resolves after the detach
    const close = w.calls.find((c) => c.cmd === 'guest_close');
    ok(close && close.payload.id === w.opened[0], 'removing the element while guest_open is in flight closes the guest', JSON.stringify(close && close.payload));
  }

  // ---- 7c. events buffered for a guest closed while opening are cleared, not held forever ----
  {
    const w = newWorld();
    const wv = w.doc.createElement('webview');
    wv.setAttribute('src', 'http://127.0.0.1:4321/');
    w.body.appendChild(wv);
    w.fire([wv], []); // guest_open is invoked; its reply is still pending
    // A probe failure the host emits before the reply is buffered against the unknown id.
    w.emit({ id: 1, type: 'did-fail-load', errorCode: -102, errorDescription: 'ERR_CONNECTION_REFUSED' });
    ok(w.api.pendingEventCount() === 1, 'an event for a guest that is still opening is buffered', String(w.api.pendingEventCount()));
    wv.remove();
    w.fire([], [wv]); // detach while opening
    await flush(); // the open reply resolves after the detach: the guest is closed
    const id = w.opened[0];
    const close = w.calls.find((c) => c.cmd === 'guest_close');
    ok(close && close.payload.id === id, 'the guest is closed when the reply lands after detach');
    ok(w.api.pendingEventCount() === 0, 'the events buffered for the closed guest are cleared', String(w.api.pendingEventCount()));
    // No open is in flight, so a late event for the closed id can never be claimed: it is dropped.
    w.emit({ id, type: 'did-finish-load', url: 'http://127.0.0.1:4321/' });
    ok(w.api.pendingEventCount() === 0, 'a late event for a closed guest is dropped, not re-buffered', String(w.api.pendingEventCount()));
  }

  // ---- 8. visibility + on-change throttling ----
  {
    const w = newWorld();
    const wv = addGuest(w, 'http://127.0.0.1:4321/', 'preview-board', { x: 0, y: 0, width: 0, height: 0 });
    await flush();
    const id = w.opened[0];
    const bounds = () => w.calls.filter((c) => c.cmd === 'guest_bounds');

    w.tick();
    await flush();
    ok(bounds().length === 1 && bounds()[0].payload.visible === false, 'a zero rect reports visible:false', JSON.stringify(bounds()[0] && bounds()[0].payload));

    w.tick();
    await flush();
    ok(bounds().length === 1, 'no guest_bounds call when nothing changed');

    wv._rect = { x: 10, y: 10, width: 100, height: 100 };
    w.emit({ id, type: 'did-finish-load', url: 'http://127.0.0.1:4321/' });
    w.tick();
    await flush();
    ok(bounds().length === 2 && bounds()[1].payload.visible === true, 'a real rect after the load reports visible:true', JSON.stringify(bounds()[1] && bounds()[1].payload));

    wv._rect = { x: 0, y: 0, width: 0, height: 0 }; // the tab panel is display:none
    w.tick();
    await flush();
    ok(bounds().length === 3 && bounds()[2].payload.visible === false, 'hiding the tab (zero rect) reports visible:false');
  }

  // ---- 9. the self-test methods route to the one guest_cdp command (and refuse before a guest exists) ----
  {
    const w = newWorld();
    const wv = w.doc.createElement('webview');
    wv.setAttribute('src', 'http://127.0.0.1:1/x');
    ok(wv.getURL() === 'http://127.0.0.1:1/x', 'getURL falls back to the src attribute before a load');
    // No guest is open: the call is refused locally, before any IPC (an id the host does not know would be worse).
    for (const name of ['focus', 'executeJavaScript', 'sendInputEvent', 'insertText', 'paste', 'capturePage']) {
      let error = null;
      try { await wv[name]('x'); } catch (e) { error = e; }
      ok(error && error.message === `not_attached:webview.${name}`, `${name} refuses before the guest is open`, error && error.message);
    }
    ok(w.calls.filter((c) => c.cmd === 'guest_cdp').length === 0, 'a call before the guest is open issues no guest_cdp');

    // Open the guest, then every method must be exactly one guest_cdp invoke carrying the element's id, the Electron
    // method name, and the caller's arguments. There is no local fallback and no per-method host command.
    w.body.appendChild(wv);
    w.fire([wv], []);
    await flush();
    const id = w.opened[0];
    const lastCdp = () => w.calls.filter((c) => c.cmd === 'guest_cdp').slice(-1)[0];
    await wv.executeJavaScript('1+1');
    ok(JSON.stringify(lastCdp().payload) === JSON.stringify({ target: id, method: 'executeJavaScript', args: ['1+1'] }),
      'executeJavaScript -> one guest_cdp call with the id, method and source', JSON.stringify(lastCdp() && lastCdp().payload));
    await wv.sendInputEvent({ type: 'mouseDown', x: 3, y: 4 });
    ok(JSON.stringify(lastCdp().payload) === JSON.stringify({ target: id, method: 'sendInputEvent', args: [{ type: 'mouseDown', x: 3, y: 4 }] }),
      'sendInputEvent -> one guest_cdp call with the event', JSON.stringify(lastCdp() && lastCdp().payload));
    await wv.insertText('hi');
    ok(JSON.stringify(lastCdp().payload) === JSON.stringify({ target: id, method: 'insertText', args: ['hi'] }),
      'insertText -> one guest_cdp call with the text', JSON.stringify(lastCdp() && lastCdp().payload));
    await wv.paste();
    ok(JSON.stringify(lastCdp().payload) === JSON.stringify({ target: id, method: 'paste', args: [] }),
      'paste -> one guest_cdp call', JSON.stringify(lastCdp() && lastCdp().payload));
    await wv.focus();
    ok(JSON.stringify(lastCdp().payload) === JSON.stringify({ target: id, method: 'focus', args: [] }),
      'focus -> one guest_cdp call', JSON.stringify(lastCdp() && lastCdp().payload));
    const image = await wv.capturePage();
    ok(JSON.stringify(lastCdp().payload) === JSON.stringify({ target: id, method: 'capturePage', args: [null] }),
      'capturePage -> one guest_cdp call', JSON.stringify(lastCdp() && lastCdp().payload));
    ok(image && typeof image.getSize === 'function' && image.getSize().width === 8 && image.getSize().height === 4,
      'capturePage resolves to a NativeImage-shaped object with its geometry', JSON.stringify(image && image.getSize && image.getSize()));
    ok(ArrayBuffer.isView(image.toPNG()) && image.toPNG().length === 8, 'toPNG decodes the host PNG base64');
    ok(ArrayBuffer.isView(image.toBitmap()) && image.toBitmap().length === 6, 'toBitmap decodes the host BGRA base64');
    ok(image.isEmpty() === false, 'a captured image is not empty');

    // A host refusal (a normal launch has no CDP grant) propagates unchanged: the shim never fakes success.
    w.behavior.cdpReject = new Error('not_selftest');
    let denied = null;
    try { await wv.executeJavaScript('1'); } catch (e) { denied = e; }
    ok(denied && denied.message === 'not_selftest', 'a host refusal propagates unchanged', denied && denied.message);
  }

  // ---- 9b. a webview nested in an added/removed subtree is attached/detached ----
  {
    const w = newWorld();
    const wrapper = w.doc.createElement('div');
    const wv = w.doc.createElement('webview');
    wv.setAttribute('src', 'http://127.0.0.1:4321/');
    wv.setAttribute('partition', 'preview-board');
    wrapper.appendChild(wv);
    w.body.appendChild(wrapper);
    w.fire([wrapper], []); // the mutation's added node is the wrapper, not the webview
    await flush();
    const open = w.calls.find((c) => c.cmd === 'guest_open');
    ok(open && open.payload.src === 'http://127.0.0.1:4321/' && w.opened.length === 1,
      'a webview inside an added subtree is attached', JSON.stringify(open && open.payload));
    const id = w.opened[0];
    wrapper.remove();
    w.fire([], [wrapper]); // the removed node is the wrapper again
    await flush();
    const close = w.calls.find((c) => c.cmd === 'guest_close');
    ok(close && close.payload.id === id, 'a webview inside a removed subtree is detached', JSON.stringify(close && close.payload));
  }

  // ---- 10. prep-ui assembly: order + no frame-src, and it never touches the real tauri/ui ----
  {
    const rendererDir = path.join(TMP_ROOT, 'renderer');
    fs.mkdirSync(rendererDir, { recursive: true });
    fs.writeFileSync(path.join(rendererDir, 'index.html'),
      '<!doctype html>\n<html><head><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; connect-src \'self\';">\n</head><body><script src="app.js"></script></body></html>\n');
    fs.writeFileSync(path.join(rendererDir, 'app.js'), '/* renderer */\n');
    // prep-ui writes to --out ONLY. The check must never rebuild the real tauri/ui from a fake
    // renderer (that would leave the embedded frontendDist holding the placeholder above).
    const uiDir = path.join(ROOT, 'tauri', 'ui');
    const outDir = path.join(TMP_ROOT, 'ui-out');
    const uiBefore = dirDigest(uiDir);
    execFileSync(process.execPath, [path.join(ROOT, 'tauri', 'prep-ui.mjs'), '--renderer', rendererDir, '--out', outDir], { cwd: ROOT, stdio: 'pipe' });
    const html = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
    const iShim = html.indexOf('zumi-shim.js');
    const iElement = html.indexOf('webview-element.js');
    const iApp = html.indexOf('app.js');
    ok(iShim >= 0 && iElement >= 0 && iApp >= 0 && iShim < iElement && iElement < iApp,
      'prep-ui injects zumi-shim -> webview-element -> app.js in that order', `${iShim},${iElement},${iApp}`);
    ok(!html.includes('frame-src'), 'the assembled index.html adds no frame-src');
    const prep = fs.readFileSync(path.join(ROOT, 'tauri', 'prep-ui.mjs'), 'utf8');
    const conf = fs.readFileSync(path.join(ROOT, 'tauri', 'src-tauri', 'tauri.conf.json'), 'utf8');
    ok(!prep.includes('frame-src') && !conf.includes('frame-src'), 'neither prep-ui nor tauri.conf.json adds frame-src');
    ok(dirDigest(uiDir) === uiBefore, 'the check leaves the real tauri/ui byte-identical (assembled to a temp dir)', `${uiBefore} -> ${dirDigest(uiDir)}`);
  }

  // ---- P1c3: off-origin guest links -> OS browser. Static checks on the Rust wiring (cargo test owns the
  // behaviour; this proves the wiring cannot drift: always-deny, re-validate first, one shell call site) ----
  {
    const rs = (f) => fs.readFileSync(path.join(ROOT, 'tauri', 'src-tauri', 'src', f), 'utf8').replace(/\r\n/g, '\n');
    const guestRs = rs('guest.rs');
    const guardRs = rs('guest_guard.rs');
    const shellRs = rs('shell_ops.rs');
    const libRs = rs('lib.rs');
    const cargo = fs.readFileSync(path.join(ROOT, 'tauri', 'src-tauri', 'Cargo.toml'), 'utf8');
    const sidecarSrc = fs.readFileSync(path.join(ROOT, 'tauri', 'sidecar', 'main.mjs'), 'utf8');
    const prod = (src) => src.split('#[cfg(test)]')[0]; // production code only (tests come last in every module)

    // Parity step 7 ruling (a): a guest must not inherit wry's SmartScreen-off default (it passes no args -> wry adds
    // msSmartScreenProtection). The exact arg string is pinned, and the builder call that applies it is pinned too.
    const guestArgs = (guestRs.match(/pub\(crate\) const GUEST_BROWSER_ARGS: &str = "([^"]+)";/) || [])[1];
    ok(guestArgs === '--disable-features=msWebOOUI,msPdfOOUI', 'guest WebView2 args disable only msWebOOUI/msPdfOOUI, so SmartScreen stays ON', String(guestArgs));
    const guestBuilder = guestRs.slice(guestRs.indexOf('fn add_guest_webview'), guestRs.indexOf('let webview = window'));
    ok(/\.additional_browser_args\(GUEST_BROWSER_ARGS\)/.test(guestBuilder), 'add_guest_webview applies GUEST_BROWSER_ARGS to every guest webview');
    ok(/\.data_directory\(profile\.data_dir\.clone\(\)\)/.test(guestBuilder), 'each guest keeps its own data directory (wry requires one for differing args)');

    // B1 (alpha.3): on Windows the Tauri drag-drop handler swallows an OS file drop before the page sees dragover/drop, so the
    // Laneboard composer never highlights or attaches a dropped image. Only the Board guest turns it off (main keeps the
    // default); the guest's own origin/navigation guards are unchanged.
    {
      const boardOnly = /let builder = if is_board_label\(label\) \{\s*builder\.disable_drag_drop_handler\(\)\s*\} else \{\s*builder\s*\};/.test(guestBuilder);
      ok(boardOnly, 'add_guest_webview turns the drag-drop handler off for the Board guest only (HTML5 drop reaches the composer)');
      const all = ['guest.rs', 'lib.rs', 'guest_guard.rs'].map(rs).join('\n');
      const tauriConf = fs.readFileSync(path.join(ROOT, 'tauri', 'src-tauri', 'tauri.conf.json'), 'utf8');
      ok((all.match(/disable_drag_drop_handler/g) || []).length === 1 && !/dragDropEnabled/.test(tauriConf), 'disable_drag_drop_handler appears once (the Board guest); tauri.conf.json leaves main on the default');
    }

    const onNew = guestRs.slice(guestRs.indexOf('.on_new_window('), guestRs.indexOf('let webview = window'));
    ok(/NewWindowResponse::<tauri::Wry>::Deny\s*\}\);/.test(onNew) && !/NewWindowResponse::<tauri::Wry>::Allow|NewWindowResponse::Create/.test(guestRs), 'on_new_window always answers Deny (no Allow/Create anywhere in guest.rs)');
    ok(/request_external_open\(&window_app, url\.as_str\(\)\.to_string\(\), opener_is_board\)/.test(onNew) && /WindowAction::External => request_external_open/.test(onNew) && /window_action\(&url, &window_origin, opener_is_board\)/.test(onNew) && /if !same_origin\(url\.as_str\(\), guest_origin\) \{\s*WindowAction::External/.test(guestRs), 'on_new_window asks the policy only for a URL off the guest origin');
    ok(/let opener_is_board = is_board_label\(label\);/.test(guestRs) && /starting_is_board = crate::guest::is_board_label\(&label\)/.test(fs.readFileSync(path.join(ROOT, 'tauri', 'src-tauri', 'src', 'guest_guard.rs'), 'utf8')), 'both link paths (new window, refused navigation) tell the policy whether the opener is the Board tab (0.2.5 opener_not_board_tab)');
    ok(!/\.recv|\.call\(|spawn_blocking|block_on/.test(onNew), 'the wry on_new_window callback itself never blocks (no RPC / recv in it)');
    ok(/spawn_blocking\(move \|\|/.test(guestRs.slice(guestRs.indexOf('fn request_external_open'))) && /"__host\.decideExternalUrl"/.test(guestRs), 'request_external_open decides in a background task via __host.decideExternalUrl');

    ok(/consults_external_policy\(cancelled, redirected, &url\)/.test(guardRs) && /fn consults_external_policy\(cancelled: bool, redirected: bool, url: &str\) -> bool \{\s*cancelled && !redirected/.test(guardRs), 'the NavigationStarting branch consults the policy only for a cancelled, non-redirect navigation');
    const startingHandler = guardRs.slice(guardRs.indexOf('add_NavigationStarting('), guardRs.indexOf('guest_guard_navstarting'));
    ok(!/IsRedirected\([^)]*\)\s*\?/.test(startingHandler) && /decide_navigation_start\(cancelled, redirected, uri\)/.test(startingHandler), 'an IsRedirected error never early-returns past the in-flight clear (it is decided in decide_navigation_start, fail closed)');
    ok(/Err\(e\) => return fail\(e\)/.test(startingHandler) && /starting_in_flight\.set\(None\);\s*Err\(e\)/.test(startingHandler), 'every COM failure in NavigationStarting clears the in-flight id before returning');
    ok(/open_on_main_with_timeout\(/.test(guestRs) && !/recv_timeout\(SHELL_TIMEOUT\)/.test(guestRs) && /compare_exchange\(QUEUED, STARTED/.test(shellRs) && /compare_exchange\(QUEUED, CANCELLED/.test(shellRs), 'a timed-out ShellExecute job is cancelled (atomic QUEUED to CANCELLED) and the queued closure checks it before opening');
    ok(!/FrameNavigationStarting/.test(prod(guardRs).replace(/\/\/.*$/gm, '')), 'iframe navigations are not hooked (FrameNavigationStarting is never added)');

    const wrapper = shellRs.slice(shellRs.indexOf('pub fn open_external_with'), shellRs.indexOf('pub fn open_external('));
    ok(wrapper.indexOf('revalidate(url)') >= 0 && wrapper.indexOf('revalidate(url)') < wrapper.indexOf('shell(&checked)'), 'open_external_with re-validates before it hands anything to the shell, and passes the re-serialised string');
    ok((prod(shellRs).match(/ShellExecuteW\(/g) || []).length === 1, 'exactly one ShellExecuteW call site exists');
    ok(!/ShellExecuteW|shell_execute\(|open_external\(/.test(shellRs.slice(shellRs.indexOf('#[cfg(test)]'))), 'no test calls ShellExecuteW, shell_execute or open_external (the shell is mocked)');
    ok(/"open"/.test(shellRs) && /SW_SHOWNORMAL/.test(shellRs) && /result > 32/.test(shellRs), 'ShellExecuteW uses the "open" verb, SW_SHOWNORMAL, and treats <= 32 as an error');
    ok(/^mod shell_ops;$/m.test(libRs), 'lib.rs declares shell_ops');
    ok(/"Win32_UI_Shell"/.test(cargo) && /"Win32_UI_WindowsAndMessaging"/.test(cargo) && !/^\s*(url|opener|shell)\b/m.test(cargo.split('[profile')[0]), 'Cargo.toml adds only windows-sys feature flags (no new crate)');
    ok(/decideExternalUrl\(url, \{ ownerAdmin: false \}\)/.test(sidecarSrc) && !/ownerAdmin: true/.test(sidecarSrc), 'the sidecar method pins ownerAdmin to false');

    // ---- parity 4b-2: the asset route is main's alone. A guest asking for any asset-route path gets a bare 404
    // (never a 403 that would mark the path as special, and never main's serve path). cargo test owns the behaviour;
    // this pins the wiring. ----
    const assetRs = rs('asset_route.rs');
    ok(/\.on_web_resource_request\(\|request, response\| \{\s*guest_guard::deny_guest_asset\(request\.uri\(\)\.path\(\), response\)\s*\}\)/.test(guestRs), 'a guest answers through deny_guest_asset(path, response)');
    ok(!/asset_route::serve/.test(prod(guestRs)), 'a guest never reaches asset_route::serve (the main-only streaming path)');
    ok(/if crate::asset_route::is_asset_path\(path\) \{\s*crate::asset_route::not_found\(response\);\s*\} else \{\s*deny_app_asset\(response\);/.test(prod(guardRs)), 'deny_guest_asset: an asset-route path is a bare 404, everything else keeps the guest 403');
    ok(/pub\(crate\) fn is_asset_path\(path: &str\) -> bool \{\s*!matches!\(route\(path\), Routed::Untouched\)/.test(prod(assetRs)), 'is_asset_path is exactly the route\'s own namespaces (served and refused shapes alike)');
  }

  // ---- 0.3.0-alpha.11: the wardrobe guest's bridge (parity 11-2) is GONE. cargo test owns the Rust behaviour
  // (acl_tests.rs: zumi_host_apply resolves for no webview); this proves the capability/command/allow-list/guard wiring
  // carries no trace of it: no wardrobe capability, no bridge command or script, no guest-only name, no ipc.localhost
  // exception, main and the board still excluded. ----
  {
    const src = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
    const capDir = path.join(ROOT, 'tauri', 'src-tauri', 'capabilities');
    const capFiles = fs.readdirSync(capDir).filter((f) => f.endsWith('.json')).sort();
    const caps = Object.fromEntries(capFiles.map((f) => [f, JSON.parse(fs.readFileSync(path.join(capDir, f), 'utf8'))]));
    const mainCap = caps['default.json'] || { permissions: [] };
    ok(JSON.stringify(capFiles) === JSON.stringify(['default.json']), 'capabilities/ holds only default.json (the wardrobe guest capability is gone)', JSON.stringify(capFiles));
    ok(!capFiles.some((f) => (caps[f].permissions || []).includes('allow-zumi-host-apply')), 'no capability grants the removed wardrobe bridge');
    ok(!capFiles.some((f) => (caps[f].webviews || []).some((w) => /wardrobe/.test(w))), 'no capability names a wardrobe webview label');
    ok(!capFiles.some((f) => (caps[f].webviews || []).some((w) => w.includes('board'))), 'no capability is scoped to a board guest label (the board is refused every app command)');

    const guestRs = src('tauri/src-tauri/src/guest.rs');
    const guestProd = guestRs.slice(0, guestRs.indexOf('#[cfg(test)]'));
    ok(!/is_wardrobe_label|WARDROBE_|ZUMI_HOST_BRIDGE_SCRIPT|zumi_host_apply|bridge_decision|GuestKind::Wardrobe|"preview-wardrobe" =>/.test(guestProd), 'guest.rs: no wardrobe guest kind, partition, bridge script, bridge command or bridge decision');
    ok(!/initialization_script/.test(guestProd), 'guest.rs: no guest gets an injected script any more');
    // Gate 11 change 6: default.json is webview-scoped. Every guest is a child of window main, so a windows match would hand main's grants
    // (core:default event emit/listen) to a guest on a local URL.
    ok(mainCap.windows === undefined && JSON.stringify(mainCap.webviews) === JSON.stringify(['main']), 'default.json matches the main WEBVIEW label only and names no window (guests are children of window main)', JSON.stringify({ windows: mainCap.windows, webviews: mainCap.webviews }));
    // Gate 11 change 1 (static): expand permission sets transitively from permissions/*.toml; NO capability may reach
    // allow-zumi-host-apply by any route now. The resolved-ACL cargo test (acl_tests.rs) is the real assertion.
    {
      const permDir = path.join(ROOT, 'tauri', 'src-tauri', 'permissions');
      const sets = new Map();
      const walkToml = (d) => { if (!fs.existsSync(d)) return; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walkToml(f); else if (e.name.endsWith('.toml')) { const t = fs.readFileSync(f, 'utf8'); for (const blk of t.split(/^\[\[(?:set|permission)\]\]/m).slice(1)) { const id = (blk.match(/^\s*identifier\s*=\s*"([^"]+)"/m) || [])[1]; const perms = (blk.match(/^\s*permissions\s*=\s*\[([\s\S]*?)\]/m) || ['', ''])[1].match(/"[^"]+"/g) || []; if (id) sets.set(id, perms.map((x) => x.slice(1, -1))); } } } };
      walkToml(permDir);
      const reaches = (perm, seen = new Set()) => perm === 'allow-zumi-host-apply' || (!seen.has(perm) && (seen.add(perm), (sets.get(perm) || []).some((q) => reaches(q, seen))));
      const holders = capFiles.filter((f) => (caps[f].permissions || []).some((q) => reaches(typeof q === 'string' ? q : q.identifier)));
      ok(holders.length === 0, 'no capability reaches allow-zumi-host-apply, through permission sets either', JSON.stringify(holders));
      const aclTests = src('tauri/src-tauri/src/acl_tests.rs');
      ok(/#\[cfg\(test\)\]\s*mod acl_tests;/.test(src('tauri/src-tauri/src/lib.rs')) && /fn the_removed_wardrobe_bridge_resolves_for_no_webview_at_any_origin\(\)/.test(aclTests) && /resolve_access\("zumi_host_apply", "main", label, &origin\)\.is_none\(\)/.test(aclTests) && /"guest-wardrobe-0"/.test(aclTests) && /plugin:event\|emit/.test(aclTests), 'the resolved-ACL cargo test (acl_tests.rs) is wired in and asserts the removed bridge resolves for main, the board and the old wardrobe label: None; and no guest event emit/listen');
    }
    const buildRs = src('tauri/src-tauri/build.rs');
    ok(!/"zumi_host_apply"/.test(buildRs), 'build.rs no longer declares zumi_host_apply (no allow-zumi-host-apply is generated)');
    const libRs = src('tauri/src-tauri/src/lib.rs');
    ok(!/guest::zumi_host_apply/.test(libRs), 'lib.rs registers no zumi_host_apply command');
    ok(!/WARDROBE_APPLY_TIMEOUT|"zumiHost\.apply" \| "wardrobe\.verifyFull"/.test(libRs.slice(0, libRs.indexOf('#[cfg(test)]'))), 'lib.rs has no wardrobe timeout');
    ok(/renderer_method_allowed\(&method\)\?;/.test(libRs), 'the main rpc command gates through the renderer allow-list');

    // Parity 12-2 (GATE-ANSWER Q5): guest_cdp is always registered, but only a self-test launch can run it. The method
    // allow-list is empty normally, the capability is outside capabilities/ (tauri-build never enables it) and is added
    // at runtime only from argv; the shipped default capability has no grant.
    {
      const cdpRs = src('tauri/src-tauri/src/guest_cdp.rs');
      ok(/pub const CDP_METHODS: \[&str; 6\] = \[[\s\S]*"executeJavaScript"[\s\S]*"sendInputEvent"[\s\S]*"insertText"[\s\S]*"paste"[\s\S]*"focus"[\s\S]*"capturePage"/.test(cdpRs),
        'guest_cdp.rs names exactly the six webview methods, in PARITY-PLAN order');
      ok(/pub fn command_table\(self_test: bool\) -> &'static \[&'static str\] \{\s*if self_test \{\s*&CDP_METHODS\s*\} else \{\s*&\[\]\s*\}\s*\}/.test(cdpRs),
        'the method allow-list: empty for a normal launch, the six methods in self-test mode (a test drives both)');
      ok(/"guest_cdp"/.test(buildRs), 'build.rs declares guest_cdp, so tauri-build generates allow-guest-cdp');
      ok(/guest_cdp::guest_cdp/.test(libRs), 'lib.rs registers the guest_cdp command');
      ok(/let argv: Vec<String> = std::env::args\(\)\.skip\(1\)\.collect\(\);/.test(libRs)
        && /guest_cdp::SelfTest::from_args\(&argv\)/.test(libRs)
        && !/std::env::var\([^)]*\)[^\n]*SelfTest|SelfTest[^\n]*std::env::var/.test(libRs),
        'the self-test mode is read from the process argv only (one argv, shared with the --model switch)');
      ok(/pub fn selftest_capability\(self_test: &SelfTest\) -> Option<&'static str> \{[\s\S]*?\.enabled\(\)[\s\S]*?\.then_some\(include_str!\("\.\.\/capabilities-selftest\/selftest\.json"\)\)/.test(cdpRs),
        'selftest_capability hands over the capability only when the CLI mode is on');
      ok(/if let Some\(capability\) = guest_cdp::selftest_capability\(&self_test\)/.test(libRs) && /app\.add_capability\(capability\)/.test(libRs),
        'lib.rs adds the self-test capability at runtime through that one decision');
      const selftestCap = path.join(ROOT, 'tauri', 'src-tauri', 'capabilities-selftest', 'selftest.json');
      ok(fs.existsSync(selftestCap), 'the self-test capability lives OUTSIDE capabilities/');
      const cap = fs.existsSync(selftestCap) ? JSON.parse(fs.readFileSync(selftestCap, 'utf8')) : {};
      ok(JSON.stringify(cap.webviews) === JSON.stringify(['main']) && JSON.stringify(cap.permissions) === JSON.stringify(['allow-guest-cdp']),
        'it grants exactly allow-guest-cdp to the main webview', JSON.stringify(cap));
      ok(!(mainCap.permissions || []).includes('allow-guest-cdp'), 'the shipped default.json does not grant allow-guest-cdp');
      ok(!fs.readdirSync(path.join(ROOT, 'tauri', 'src-tauri', 'capabilities')).some((f) => f.includes('selftest')),
        'capabilities/ holds no self-test capability (a normal launch never enables it)');
    }

    const allowRs = src('tauri/src-tauri/src/rpc_allow_list.rs');
    const allowBlock = (allowRs.match(/ALLOWED_METHODS[^=]*=\s*&\[([\s\S]*?)\];/) || ['', ''])[1];
    const guestBlock = (allowRs.match(/GUEST_ONLY_METHODS[^=]*=\s*&\[([\s\S]*?)\];/) || ['', ''])[1];
    ok(!/"zumiHost\.|"wardrobe/.test(allowBlock), 'no zumiHost / wardrobe name in the main renderer rpc allow-list');
    ok(guestBlock.trim() === '', 'GUEST_ONLY_METHODS is generated empty (the wardrobe bridge was its only name)', JSON.stringify(guestBlock));

    const guardRs = src('tauri/src-tauri/src/guest_guard.rs');
    ok(!/guest_guard_blocks|allow_ipc_host|is_ipc_host|is_wardrobe_label/.test(guardRs), 'guest_guard.rs: no wardrobe-only ipc.localhost switch is left');
    ok(/let blocks = move \|uri: &str\| \{\s*crate::guest_requests::record\(uri\);\s*guard_blocks\(uri\)\s*\};/.test(guardRs), 'every guest is guarded by the one guest rule (guard_blocks)');
  }

  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('check-tauri-guest error:', e && e.stack || e);
  try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(1);
});
