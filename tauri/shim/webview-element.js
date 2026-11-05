// T-31 P1b — the renderer-side `<webview>` element stand-in (DESIGN.md §5).
//
// WebView2/Tauri has no `<webview>` tag, and a custom element name must contain a hyphen, so
// `customElements.define('webview', …)` throws. This script wraps `Document.prototype.createElement`
// so `'webview'` (any case) still returns the browser's own HTMLUnknownElement — the CSS selectors in
// styles.css keep matching — with the handful of Electron `<webview>` methods the renderer uses.
//
// The element is a PLACEHOLDER with no content. A native child webview is created by Rust
// (`guest_open`) and positioned over the element's bounding rect; the shim reports the rect with
// `guest_bounds`. See tauri/src-tauri/src/guest.rs.
//
// Contract with the host:
//   invoke('guest_open', { src, partition, bounds })      -> { id }
//   invoke('guest_navigate', { id, url })                 -> resolves after the next load
//   invoke('guest_bounds', { id, bounds, visible })       -> ()
//   invoke('guest_close', { id })                         -> ()
//   listen('guest:event', { id, type, url?, errorCode?, errorDescription? })   dom-ready | did-finish-load | did-fail-load
//
// It is a classic script (prep-ui injects it after zumi-shim.js, before app.js), so it exposes the
// factory as `globalThis.installWebviewElement` and self-installs when the Tauri bridge is present.
(function (global) {
  'use strict';

  function makeEvent(doc, type, props) {
    var view = doc && doc.defaultView;
    var Ctor = (view && view.Event) || (typeof Event === 'function' ? Event : null);
    var event = null;
    if (Ctor) { try { event = new Ctor(type); } catch (e) { event = null; } }
    if (!event) event = { type: type };
    if (props) {
      for (var k in props) { if (Object.prototype.hasOwnProperty.call(props, k)) event[k] = props[k]; }
    }
    return event;
  }

  /**
   * Install the stand-in on `doc`. All four dependencies are injected so the behaviour is testable
   * with a fake DOM (scripts/check-tauri-guest.mjs) and never needs jsdom.
   */
  function installWebviewElement(opts) {
    var doc = opts.document;
    var invoke = opts.invoke;
    var listen = opts.listen;
    var raf = opts.raf;
    if (!doc || typeof invoke !== 'function' || typeof listen !== 'function' || typeof raf !== 'function') {
      throw new Error('installWebviewElement: document, invoke, listen and raf are required');
    }

    var states = new WeakMap(); // element -> state
    var active = [];            // states with a guest id (what the rAF loop iterates)
    var byId = new Map();       // guest id -> state
    var pendingEvents = new Map(); // guest id -> events that arrived before the id was known
    var opening = 0;            // guest_open calls in flight (an id may yet claim a buffered event)
    var loopRunning = false;
    var listening = false;

    function stateFor(el) {
      var s = states.get(el);
      if (!s) {
        s = {
          el: el, id: null, src: null, partition: null, url: null,
          attached: false, opening: false,
          loadedOnce: false, domReady: false, failed: false,
          visible: null, bounds: null, waiters: [],
        };
        states.set(el, s);
      }
      return s;
    }

    function rectOf(el) {
      var r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
      return { x: (r && r.x) || 0, y: (r && r.y) || 0, width: (r && r.width) || 0, height: (r && r.height) || 0 };
    }
    function sameBounds(a, b) {
      return !!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
    }
    function isConnected(el) {
      return typeof el.isConnected === 'boolean' ? el.isConnected : false;
    }
    // Every webview in `node` and its subtree. A mutation record's added/removed node is often a
    // wrapper (a tab panel), not the webview itself, so the webview must be found by selector rather
    // than by testing the node alone.
    function webviewsIn(node) {
      var found = [];
      if (!node) return found;
      if (node.__zumiWebview) found.push(node);
      if (typeof node.querySelectorAll === 'function') {
        var nested = node.querySelectorAll('webview');
        for (var i = 0; i < nested.length; i++) found.push(nested[i]);
      }
      return found;
    }
    function dispatch(el, type, props) {
      if (typeof el.dispatchEvent !== 'function') return;
      try { el.dispatchEvent(makeEvent(doc, type, props)); } catch (e) { /* a listener threw; ignore */ }
    }
    function settle(s, err) {
      var waiters = s.waiters;
      s.waiters = [];
      for (var i = 0; i < waiters.length; i++) {
        if (err) waiters[i].reject(err); else waiters[i].resolve();
      }
    }
    function removeActive(s) {
      var i = active.indexOf(s);
      if (i >= 0) active.splice(i, 1);
    }
    // Forget everything the shim holds for a guest id that has been (or is being) closed, including any
    // event buffered for it while it was still opening. Without this a probe failure buffered during an
    // open that then lost its element would sit in pendingEvents forever.
    function forgetId(id) {
      if (id == null) return;
      byId.delete(id);
      pendingEvents.delete(id);
    }

    // ---- the one guest:event listener, routing each payload to its element by id ----
    function ensureListener() {
      if (listening) return;
      listening = true;
      listen('guest:event', function (payload) {
        if (!payload) return;
        var s = byId.get(payload.id);
        if (!s) {
          // An id we do not know yet: buffer it. The host can emit before the guest_open reply is
          // delivered (a probe failure emits did-fail-load synchronously), so dropping it would lose
          // the renderer's only failure signal. Only buffer while an open is in flight: an event for an
          // id nothing can claim (a late event for a closed guest) must be dropped, not held forever.
          if (opening === 0) return;
          var queue = pendingEvents.get(payload.id);
          if (!queue) { queue = []; pendingEvents.set(payload.id, queue); }
          queue.push(payload);
          return;
        }
        deliver(s, payload);
      });
    }
    function deliver(s, payload) {
      if (payload.type === 'dom-ready') {
        s.domReady = true;
        dispatch(s.el, 'dom-ready', { url: payload.url });
      } else if (payload.type === 'did-finish-load') {
        s.domReady = true;
        s.loadedOnce = true;
        s.failed = false;
        if (payload.url) s.url = payload.url;
        dispatch(s.el, 'did-finish-load', { url: payload.url });
        settle(s, null);
      } else if (payload.type === 'did-fail-load') {
        s.failed = true;
        // webErrorStatus is the raw WebView2 enum value (probe instrumentation, additive); Electron's
        // event has no such field, so nothing in the app reads it.
        dispatch(s.el, 'did-fail-load', { errorCode: payload.errorCode, errorDescription: payload.errorDescription, webErrorStatus: payload.webErrorStatus, url: payload.url });
        settle(s, new Error('did-fail-load:' + (payload.errorDescription || payload.errorCode)));
      }
    }

    // ---- attach / detach ----
    function openGuest(s, src, partition) {
      if (s.opening || s.id != null || !src) return;
      s.opening = true;
      opening++;
      invoke('guest_open', { src: src, partition: partition, bounds: rectOf(s.el) }).then(function (res) {
        s.opening = false;
        opening--;
        var id = res && typeof res === 'object' ? res.id : res;
        if (id == null) { failOpen(s, 'guest_open returned no id'); return; }
        s.id = id;
        // The element may have been removed while the open was in flight (a fast tab switch): the
        // native child must not leak. Close it and forget the entry.
        if (!s.attached) {
          forgetId(id);
          invoke('guest_close', { id: id }).catch(function () {});
          s.id = null;
          return;
        }
        byId.set(id, s);
        active.push(s);
        var queued = pendingEvents.get(id);
        if (queued) { pendingEvents.delete(id); for (var i = 0; i < queued.length; i++) deliver(s, queued[i]); }
        ensureLoop();
        // A loadURL that arrived while the guest was still opening (or that differs from the src)
        // becomes the load: navigate to it and let its own resolution settle the waiters.
        if (s.url && s.url !== src) {
          invoke('guest_navigate', { id: id, url: s.url }).then(
            function () { settle(s, null); },
            function (e) { s.failed = true; settle(s, e); }
          );
        }
      }, function (err) {
        s.opening = false;
        opening--;
        failOpen(s, (err && err.message) || String(err));
      });
    }
    function failOpen(s, message) {
      s.failed = true;
      dispatch(s.el, 'did-fail-load', { errorCode: -2, errorDescription: message });
      settle(s, new Error(message));
    }
    function attach(el) {
      var s = stateFor(el);
      if (s.attached) return;
      s.attached = true;
      // Attributes are read ONCE, at attach. A change to `src`/`partition` after attach is ignored, by
      // design: app.js sets them before appendChild, and re-pointing a native child in place is not
      // something the renderer asks for (a mode switch removes and rebuilds the element).
      s.src = el.getAttribute('src');
      s.partition = el.getAttribute('partition');
      if (!s.url) s.url = s.src || null;
      ensureListener();
      openGuest(s, s.src || s.url, s.partition);
    }
    function detach(el) {
      var s = states.get(el);
      if (!s) return;
      s.attached = false;
      if (s.id != null) {
        forgetId(s.id);
        removeActive(s);
        invoke('guest_close', { id: s.id }).catch(function () {});
        s.id = null;
      }
      settle(s, new Error('webview detached'));
    }

    // ---- one MutationObserver (childList, subtree) for attach and detach ----
    var ObserverCtor = (doc.defaultView && doc.defaultView.MutationObserver) ||
      (typeof MutationObserver === 'function' ? MutationObserver : null);
    if (ObserverCtor) {
      var observer = new ObserverCtor(function (records) {
        for (var i = 0; i < records.length; i++) {
          var added = records[i].addedNodes || [];
          var removed = records[i].removedNodes || [];
          for (var a = 0; a < added.length; a++) {
            var addedWebviews = webviewsIn(added[a]);
            for (var j = 0; j < addedWebviews.length; j++) attach(addedWebviews[j]);
          }
          for (var r = 0; r < removed.length; r++) {
            var removedWebviews = webviewsIn(removed[r]);
            for (var k = 0; k < removedWebviews.length; k++) {
              if (!isConnected(removedWebviews[k])) detach(removedWebviews[k]); // disconnected by now
            }
          }
        }
      });
      observer.observe(doc.body || doc.documentElement || doc, { childList: true, subtree: true });
    }

    // ---- one rAF loop while any guest exists; guest_bounds only on change ----
    function ensureLoop() {
      if (loopRunning) return;
      loopRunning = true;
      raf(tick);
    }
    function tick() {
      loopRunning = false;
      var still = false;
      var copy = active.slice();
      for (var i = 0; i < copy.length; i++) {
        var s = copy[i];
        if (s.id == null) continue;
        still = true;
        var b = rectOf(s.el);
        var visible = isConnected(s.el) && b.width > 0 && b.height > 0 && s.loadedOnce && !s.failed;
        if (s.visible !== visible || !sameBounds(s.bounds, b)) {
          s.visible = visible;
          s.bounds = b;
          invoke('guest_bounds', { id: s.id, bounds: b, visible: visible }).catch(function () {});
        }
      }
      if (still) ensureLoop();
    }

    // ---- loadURL + the Electron method surface ----
    function loadURL(el, url) {
      var s = stateFor(el);
      s.url = url;
      if (s.id != null) return invoke('guest_navigate', { id: s.id, url: url });
      // Not opened yet: store the URL and resolve on that load. If the element is already attached but
      // the guest is still opening, openGuest() navigates to the stored URL when it resolves; if the
      // element is not attached yet, attach() opens with it.
      if (s.attached && !s.opening) openGuest(s, s.url, s.partition);
      return new Promise(function (resolve, reject) { s.waiters.push({ resolve: resolve, reject: reject }); });
    }
    function decorate(el) {
      if (el.__zumiWebview) return el;
      el.__zumiWebview = true;
      el.loadURL = function (url) { return loadURL(el, url); };
      el.getURL = function () { var s = stateFor(el); return s.url || el.getAttribute('src') || ''; };
      // Parity 12-2: the self-test methods route to the host's CDP command. They exist on the element always, and the
      // host dispatches them ONLY in a self-test launch (CLI args); a normal launch's ACL has no grant and the command
      // body refuses, so calling one rejects instead of running privileged code. A call before the guest is open
      // rejects locally.
      el.focus = function () { return cdpCall(el, 'focus'); };
      el.executeJavaScript = function (code) { return cdpCall(el, 'executeJavaScript', [code]); };
      el.sendInputEvent = function (event) { return cdpCall(el, 'sendInputEvent', [event]); };
      el.insertText = function (text) { return cdpCall(el, 'insertText', [text]); };
      el.paste = function () { return cdpCall(el, 'paste'); };
      // Electron's capturePage resolves to a NativeImage; the host returns the geometry plus base64 PNG/BGRA, so this
      // exposes the same small surface the selftest uses (getSize/toPNG/toBitmap/isEmpty).
      el.capturePage = function (rect) { return cdpCall(el, 'capturePage', [rect || null]).then(nativeImage); };
      return el;
    }

    function cdpCall(el, method, args) {
      var s = stateFor(el);
      if (s.id == null) return Promise.reject(new Error('not_attached:webview.' + method));
      return Promise.resolve(invoke('guest_cdp', { target: s.id, method: method, args: args || [] }));
    }

    function bytesFromBase64(b64) {
      if (typeof atob !== 'function') return new Uint8Array(0);
      var bin = atob(String(b64 || ''));
      var out = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }

    function nativeImage(reply) {
      var w = (reply && reply.width) || 0;
      var h = (reply && reply.height) || 0;
      var png = (reply && reply.pngBase64) || '';
      var bitmap = (reply && reply.bitmapBase64) || '';
      return {
        getSize: function () { return { width: w, height: h }; },
        isEmpty: function () { return !(w && h); },
        toPNG: function () { return bytesFromBase64(png); },
        toBitmap: function () { return bytesFromBase64(bitmap); },
        toDataURL: function () { return 'data:image/png;base64,' + png; },
      };
    }

    // ---- wrap Document.prototype.createElement for 'webview' only ----
    var proto = Object.getPrototypeOf(doc);
    var target = proto && typeof proto.createElement === 'function' ? proto : doc;
    var original = target.createElement;
    target.createElement = function (tag) {
      var el = original.apply(this, arguments);
      if (typeof tag === 'string' && tag.toLowerCase() === 'webview') decorate(el);
      return el;
    };

    // `pendingEventCount` is an inspection hook for scripts/check-tauri-guest.mjs (it has no other way
    // to see the event buffer); nothing in the app reads it.
    return { stateFor: stateFor, pendingEventCount: function () { return pendingEvents.size; } };
  }

  global.installWebviewElement = installWebviewElement;

  // Self-install in the app: the shim (zumi-shim.js) is loaded first; this runs as a classic script.
  if (typeof window !== 'undefined' && window.document && typeof window.document.createElement === 'function') {
    var tauri = window.__TAURI__;
    var core = tauri && (tauri.core && typeof tauri.core.invoke === 'function' ? tauri.core : (typeof tauri.invoke === 'function' ? tauri : null));
    var events = tauri && tauri.event;
    if (core && events && typeof events.listen === 'function') {
      try {
        installWebviewElement({
          document: window.document,
          invoke: function (cmd, payload) { return core.invoke(cmd, payload); },
          listen: function (name, handler) { return events.listen(name, function (e) { handler(e && e.payload); }); },
          raf: function (cb) { return window.requestAnimationFrame(cb); },
        });
      } catch (e) { /* leave the renderer without guests rather than throw while loading */ }
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
