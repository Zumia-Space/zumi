// T-31 P1a — generate tauri/shim/zumi-shim.js from docs/migration/api-inventory.json.
//
// The shim installs the frozen `window.zumi` surface BEFORE the renderer bundle runs, replacing the
// Electron preload. Every method becomes a Tauri call:
//   invoke-kind -> invoke('rpc', { method, args })            (Promise, like ipcRenderer.invoke)
//   send-kind   -> invoke('rpc', { method, args })            (fire-and-forget, like ipcRenderer.send)
//   event-kind  -> listen(<channel>) wrapped as subscribe()    (sync unsubscribe fn, like ipcRenderer.on)
//
// The inventory is the SINGLE source of truth, so the surface cannot drift by hand: this file is the
// generator, the output is committed for review, and scripts/check-tauri-shim.mjs fails if they differ
// or if any inventory name is missing from the generated shim.
//
// Usage: node tauri/shim/generate-shim.mjs [--out tauri/shim/zumi-shim.js]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const INVENTORY = path.join(root, 'docs', 'migration', 'api-inventory.json');

const RESERVED = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else',
  'export', 'extends', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'return',
  'super', 'switch', 'this', 'throw', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'let',
  'static', 'enum', 'await', 'null', 'true', 'false',
]);

const IDENT = /^[A-Za-z_$][\w$]*$/;
const param = (name, i) => (typeof name === 'string' && IDENT.test(name) && !RESERVED.has(name) ? name : `a${i}`);
const params = (args) => (args || []).map(param);

/** Which world object an inventory entry is exposed on. */
function worldOf(api) {
  if (api.exposedBy && /zumiHost/.test(api.exposedBy)) return 'zumiHost';
  if (typeof api.name === 'string' && api.name.startsWith('zumiHost.')) return 'zumiHost';
  return 'zumi';
}

/** The dotted path inside its world ('zumiHost.apply' -> 'apply' under window.zumiHost). */
function localPath(api) {
  const name = api.name;
  return worldOf(api) === 'zumiHost' && name.startsWith('zumiHost.') ? name.slice('zumiHost.'.length) : name;
}

/** Build a nested { name: api | { namespace } } tree for one world. */
function buildTree(apis, world) {
  const tree = {};
  for (const api of apis) {
    if (worldOf(api) !== world) continue;
    const parts = localPath(api).split('.');
    let node = tree;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node[parts[i]]) node[parts[i]] = {};
      node = node[parts[i]];
    }
    node[parts[parts.length - 1]] = api;
  }
  return tree;
}

/** Emit the object literal for one world's tree. Keys are sorted for a deterministic diff. */function emitTree(node, indent) {
  const pad = '  '.repeat(indent);
  const inner = '  '.repeat(indent + 1);
  const keys = Object.keys(node).sort();
  const lines = keys.map((key) => `${inner}${JSON.stringify(key)}: ${emitValue(node[key], indent + 1)}`);
  return `{\n${lines.join(',\n')}\n${pad}}`;
}

function emitValue(value, indent) {
  if (value && value.kind) return emitLeaf(value);
  return emitTree(value, indent);
}

// Per-event payload shaping, copied from src/main/preload.js. The Electron preload reshaped the raw
// IPC payload before invoking the renderer callback; the shim must do the same so the renderer is
// unchanged. `ps` are the shim's parameter names, `cb` is the callback (the last parameter).
//   update.onState    -> cb(payload) only when payload.phase is a string
//   talk.onReplyMore  -> cb(payload.text) only for the subscribed turnId and a string text
//   talk.onReplyDone  -> cb({ ok, reply, error, sources: cleanSources(...) })                     (preload.js:96)
//   talk.onCheckDone  -> cb({ verdict, text }) only for its turnId and verdict ok|fix             (preload.js:99)
//   talk.onTtsMore    -> cb(payload.audio) only for the subscribed turnId
//   talk.onSay        -> cb(line) only when line.sayId is a string                                  (preload.js:145)
//   onGesture         -> handler(payload.command), then its JSON-safe result is sent back on
//                        gesture:result (fire-and-forget), like preload.js:82-86
// Events not listed here are forwarded as the whole payload, exactly as preload.js does (hud:feed,
// talk:kokoroProgress, model:changed, reflex:event, window:focus, window:visible).
const EVENT_SHAPES = {
  'update.onState': (_ps, cb) => `function (p) { if (p && typeof p.phase === 'string') ${cb}(p); }`,
  'talk.onReplyMore': (ps, cb) => `function (p) { if (p && p.turnId === ${ps[0]} && typeof p.text === 'string') ${cb}(p.text); }`,
  'talk.onReplyDone': (ps, cb) => `function (p) { if (p && p.turnId === ${ps[0]}) { ${cb}({ ok: p.ok === true, reply: typeof p.reply === 'string' ? p.reply : '', error: p.error || null, sources: cleanSources(p.sources) }); return true; } }`,
  'talk.onCheckDone': (ps, cb) => `function (p) { if (p && p.turnId === ${ps[0]} && (p.verdict === 'ok' || p.verdict === 'fix')) ${cb}({ verdict: p.verdict, text: typeof p.text === 'string' ? p.text : '' }); }`,
  'talk.onSay': (_ps, cb) => `function (p) { if (p && typeof p.sayId === 'string') ${cb}(p); }`,
  // talk.onTtsMore  -> cb(audio bytes), reassembled when one sentence was split over the event cap (see joinTtsParts)
  'talk.onTtsMore': (ps, cb) => `(function () { var held = {}; return function (p) { if (p && p.turnId === ${ps[0]}) { var audio = joinTtsParts(held, p, decodeBinary(p.audio)); if (audio !== undefined) ${cb}(audio); } }; })()`,
  // The reply half of preload.js:82-86: await the handler, turn a throw into { ok:false, errors:[msg] },
  // JSON-safe the result (undefined -> null) and send it back on gesture:result. Fire-and-forget, and
  // the trailing catch keeps a failing reply from leaking an unhandled rejection into the webview.
  'onGesture': (_ps, cb) => `function (p) { var reqId = p && p.reqId; Promise.resolve().then(function () { return ${cb}(p && p.command); }).then(null, function (e) { return { ok: false, errors: [String((e && e.message) || e)] }; }).then(function (result) { return $invoke("gesture:result", [reqId, JSON.parse(JSON.stringify(result || null))]); }).catch(function () {}); }`,
};

// Sidecar death while a streamed reply is open. Electron has no such case (main dying takes the renderer
// with it), so the nearest existing renderer path is the one a failed stream already uses: the reply's
// final event with ok:false and an error code (src/renderer/talk/director.js onReplyDone: !fin.ok ->
// streamError, bubble keeps the text so far). Without it the turn would wait forever for a talk:replyDone
// that can no longer come. Only subscriptions that are still open when `sidecar:error` arrives get it, once;
// a reply that already delivered its final event (deliver returns true) is finished and is left alone.
const EVENT_DEATH = {
  'talk.onReplyDone': (_ps, cb) => `function () { ${cb}({ ok: false, reply: '', error: 'sidecar_exited', sources: [] }); }`,
};

// T-31 parity 13a / GATE-10b condition 2 (P3-B: now real in the OWNER flavour). The renderer's openLiveBoard() only
// handles a RESOLVED { error } -- a rejection skips boardHint and leaves the Board tab on its opening spinner for
// ever, caching the rejected promise. So board.liveOpen is invoked for real, and every rejection settles as a
// resolved { error }: a sidecar that does not carry the name (older than P3-B) answers `not_implemented:board.liveOpen`,
// which becomes the distinct { error: "live_board_later" } (the Board tab names the Electron app, nothing is faked, and the
// renderer never blames the network); any other failure carries its own message. Every current flavour answers for real.
const SETTLED_ERRORS = {
  'board.liveOpen': { notImplemented: 'live_board_later' },
};

/** The deliver body for one event leaf: an explicit shape if known, else a turnId filter or passthrough. */
function eventDeliver(api, ps, cb) {
  const shape = EVENT_SHAPES[api.name];
  if (shape) return shape(ps, cb);
  const filterTurn = (api.args || [])[0] === 'turnId';
  return filterTurn
    ? `function (p) { if (p && p.turnId === ${ps[0]}) ${cb}(p); }`
    : `function (p) { ${cb}(p); }`;
}

function emitLeaf(api) {
  const name = JSON.stringify(api.name);
  const ps = params(api.args);
  if (api.kind === 'invoke') {
    const settled = SETTLED_ERRORS[api.name];
    if (settled) {
      const code = JSON.stringify(`not_implemented:${api.name}`);
      return `function (${ps.join(', ')}) { return $invoke(${name}, [${ps.join(', ')}]).catch(function (e) { var m = String((e && e.message) || e); return { error: m === ${code} ? ${JSON.stringify(settled.notImplemented)} : m }; }); }`;
    }
    return `function (${ps.join(', ')}) { return $invoke(${name}, [${ps.join(', ')}]); }`;
  }
  if (api.kind === 'send') {
    // Fire-and-forget, like ipcRenderer.send: the reply/error is intentionally not surfaced, and a
    // rejected promise must not become an unhandled rejection in the webview.
    return `function (${ps.join(', ')}) { $invoke(${name}, [${ps.join(', ')}]).catch(function () {}); }`;
  }
  if (api.kind === 'event') {
    const channel = JSON.stringify(api.channel);
    const cb = ps.length ? ps[ps.length - 1] : 'a0';
    const all = ps.length ? ps : ['a0'];
    const deliver = eventDeliver(api, ps, cb);
    const death = EVENT_DEATH[api.name];
    const tail = death ? `, ${death(ps, cb)}` : '';
    return `function (${all.join(', ')}) { return $subscribe(${channel}, ${deliver}${tail}); }`;
  }
  throw new Error(`unknown kind for ${api.name}: ${api.kind}`);
}

/** Generate the shim source from a parsed inventory object. */
export function generateShim(inventory) {
  const apis = inventory.apis || [];
  const zumi = emitTree(buildTree(apis, 'zumi'), 1);
  const version = inventory.appVersion || 'unknown';

  return `// GENERATED by tauri/shim/generate-shim.mjs from docs/migration/api-inventory.json — do not edit by hand.
// Zumi P1a compatibility shim (api-inventory schema v${inventory.schemaVersion}, app ${version}).
//
// Installed BEFORE the renderer bundle (tauri/prep-ui.mjs injects this <script> above app.js). It
// presents the same window.zumi surface the Electron preload exposed, so the renderer runs
// unchanged; each call is routed to the Tauri host:
//   invoke-kind -> $invoke(name, args)          => Tauri invoke('rpc', { method, args })
//   send-kind   -> $invoke(name, args)          => fire-and-forget (reply dropped)
//   event-kind  -> $subscribe(channel, cb)      => Tauri event.listen(channel)
//
// Push events come from the sidecar through the host (events.rs: inventory allow-list, size limit, main
// webview only) and arrive here as ordinary Tauri events on the inventory's channel names.
//
// Binary fields arrive as {"$bin":"<base64>"} and are decoded to a Uint8Array before a call resolves or an
// event dispatches (step 8b); a talk:ttsMore sentence split over the 512 KB event cap is re-assembled first.
//
// Unimplemented methods are rejected by the sidecar with a clear \`not_implemented:<name>\` error; the
// shim never fabricates a success value. board.liveOpen is the one honest exception: its renderer consumer
// only handles a resolved { error }, so the shim settles a rejection as { error } (a public flavour's
// not_implemented becomes "live_board_later"; GATE-10b condition 2). The seven events the Electron
// preload reshaped (update.onState, talk.onReplyMore, talk.onReplyDone, talk.onCheckDone, talk.onTtsMore,
// talk.onSay, onGesture) are reshaped here identically; the other six are forwarded as-is, as the preload does.
//
// window.zumiHost is NOT defined here: no guest page loads this shim, and since 0.3.0-alpha.11 (wardrobe removed)
// the inventory has no zumiHost name at all.
(function () {
  'use strict';

  function tauriCore() {
    var t = window.__TAURI__;
    if (!t) return null;
    if (t.core && typeof t.core.invoke === 'function') return t.core;
    return typeof t.invoke === 'function' ? t : null;
  }
  function tauriEvent() {
    var t = window.__TAURI__;
    return t && t.event && typeof t.event.listen === 'function' ? t.event : null;
  }

  // Payload cleaner copied from src/main/preload.js:5 (cleanSources): keep at most five entries that
  // carry a string url, each reduced to { url, title }. Used by talk.onReplyDone's \`sources\`.
  function cleanSources(list) {
    return Array.isArray(list)
      ? list.filter(function (s) { return s && typeof s.url === 'string'; }).slice(0, 5).map(function (s) { return { url: s.url, title: typeof s.title === 'string' ? s.title : '' }; })
      : [];
  }

  // T-31 parity step 8b (G-a): binary fields cross the JSON wire as {"$bin":"<base64>"} (sidecar protocol.mjs).
  // Decode them back to a Uint8Array before the renderer sees them: under Electron's ipcRenderer a Buffer arrived as
  // a Uint8Array, so talk.tts audios and talk:ttsMore audio keep the same type and bytes here. atob when the webview has it
  // (fast path); otherwise the pure-JS decoder below, since neither Buffer nor atob is guaranteed.
  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function base64ToBytes(text) {
    if (typeof atob === 'function') {
      try {
        var bin = atob(String(text)), fast = new Uint8Array(bin.length);
        for (var n = 0; n < bin.length; n++) fast[n] = bin.charCodeAt(n);
        return fast;
      } catch (e) { /* malformed input: fall through to the tolerant decoder below */ }
    }
    var clean = String(text).replace(/[^A-Za-z0-9+/=]/g, '');
    var len = clean.indexOf('=') >= 0 ? clean.indexOf('=') : clean.length;
    var out = new Uint8Array(Math.floor(len * 3 / 4));
    var o = 0;
    for (var i = 0; i < clean.length; i += 4) {
      var a = B64.indexOf(clean.charAt(i)), b = B64.indexOf(clean.charAt(i + 1));
      var c = B64.indexOf(clean.charAt(i + 2)), d = B64.indexOf(clean.charAt(i + 3));
      if (a < 0 || b < 0) break;
      out[o++] = (a << 2) | (b >> 4);
      if (c >= 0 && o < out.length) out[o++] = ((b & 15) << 4) | (c >> 2);
      if (d >= 0 && o < out.length) out[o++] = ((c & 3) << 6) | d;
    }
    return out;
  }
  function decodeBinary(value) {
    if (Array.isArray(value)) return value.map(decodeBinary);
    if (typeof Uint8Array !== 'undefined' && value instanceof Uint8Array) return value;
    if (value && typeof value === 'object') {
      var keys = Object.keys(value);
      if (keys.length === 1 && keys[0] === '$bin' && typeof value.$bin === 'string') return base64ToBytes(value.$bin);
      var out = {};
      for (var i = 0; i < keys.length; i++) out[keys[i]] = decodeBinary(value[keys[i]]);
      return out;
    }
    return value;
  }
  // A talk:ttsMore payload over the 512 KB event cap arrives as parts of one logical sentence (same turnId + chunk,
  // part/parts); hold them until the set is complete, then hand the renderer ONE Uint8Array, byte-equal to the
  // original. A payload that fits (the ordinary case) has no parts field and is delivered as-is.
  // \`held\` belongs to ONE onTtsMore subscription (its listener closure), so a second listener on the same turn
  // reassembles the same sentence on its own, and everything held dies with that listener. A newer chunk of the
  // turn also drops older unfinished chunks of it (an abandoned sentence is never completed).
  function joinTtsParts(held, p, audio) {
    if (!(p.parts > 1)) return audio === undefined ? null : audio;
    var key = String(p.chunk);
    if (!held[key]) {
      for (var old in held) if (Number(old) < Number(key)) delete held[old];
    }
    var slot = held[key] || (held[key] = { got: [], parts: p.parts });
    slot.got[p.part - 1] = audio;
    for (var i = 0; i < slot.parts; i++) if (!slot.got[i]) return undefined;
    var total = 0;
    for (var j = 0; j < slot.got.length; j++) total += slot.got[j].length;
    var joined = new Uint8Array(total), at = 0;
    for (var k = 0; k < slot.got.length; k++) { joined.set(slot.got[k], at); at += slot.got[k].length; }
    delete held[key];
    return joined;
  }

  // T-31 boot race (real build, 19-10): the renderer starts issuing rpc before the sidecar's versioned handshake
  // has passed, and the host refuses each such call with \`sidecar_not_ready\` (lib.rs gates every call on the
  // handshake). On the first load that refusal reached the chat area and left the provider picker empty; only a
  // page reload raced the other way. A call refused this way is HELD, never retried blindly: it waits for the
  // host's \`sidecar:ready\` event and is then sent exactly once. Every call made while the gate is closed waits
  // the same way. If ready never arrives inside READY_TIMEOUT_MS (the host's own HANDSHAKE_TIMEOUT), every held
  // call rejects with the same typed \`sidecar_not_ready\`, so a dead sidecar fails visibly instead of hanging
  // boot. Electron never loads this shim, so its behaviour is unchanged.
  // First start on a PC without Node (N3): provisioning (consent, download, extract) has no upper bound, so while
  // the host reports it with periodic \`sidecar:provisioning\` events every event re-arms the bound; once the events
  // stop (provisioning over, or the host gone) the normal READY_TIMEOUT_MS handshake deadline applies again.
  var READY_TIMEOUT_MS = (typeof window.__ZUMI_READY_TIMEOUT_MS === 'number' && window.__ZUMI_READY_TIMEOUT_MS > 0)
    ? window.__ZUMI_READY_TIMEOUT_MS : 10000;
  var ready = { open: true, epoch: 0, held: [], timer: null };
  var sidecarNotReady = function () { return new Error('sidecar_not_ready'); };
  function holdUntilReady(core, method, args) {
    return new Promise(function (resolve, reject) {
      ready.held.push({ core: core, method: method, args: args, resolve: resolve, reject: reject });
      if (ready.timer === null && typeof setTimeout === 'function') {
        ready.timer = setTimeout(function () { ready.timer = null; failHeld(); }, READY_TIMEOUT_MS);
      }
    });
  }
  function rearmHeld() {
    if (ready.timer === null || typeof clearTimeout !== 'function') return; // nothing is held
    clearTimeout(ready.timer);
    ready.timer = setTimeout(function () { ready.timer = null; failHeld(); }, READY_TIMEOUT_MS);
  }
  function releaseHeld() {
    if (ready.timer !== null && typeof clearTimeout === 'function') clearTimeout(ready.timer);
    ready.timer = null;
    var held = ready.held.splice(0);
    for (var i = 0; i < held.length; i++) {
      (function (h) { runRpc(h.core, h.method, h.args, false).then(h.resolve, h.reject); })(held[i]);
    }
  }
  function failHeld() {
    if (ready.timer !== null && typeof clearTimeout === 'function') clearTimeout(ready.timer);
    ready.timer = null;
    var held = ready.held.splice(0);
    for (var i = 0; i < held.length; i++) held[i].reject(sidecarNotReady());
    ready.open = true; // the next call reports the host's own state at once instead of queueing again
  }

  function errorMessage(err) {
    // Electron's ipcRenderer.invoke rejects with an Error. Tauri rejects with whatever the Rust command
    // returned (here, a string), so normalize to an Error so renderer handlers that read err.message keep
    // working unchanged.
    return err instanceof Error ? err.message : ((err && typeof err === 'object' && typeof err.message === 'string') ? err.message : String(err));
  }
  function runRpc(core, method, args, allowHold) {
    var epochAtSend = ready.epoch;
    return core.invoke('rpc', { method: method, args: args }).then(function (res) { return decodeBinary(res); }, function (err) {
      var message = errorMessage(err);
      // The host's typed "not yet" signal: hold this call until the ready event, then send it once.
      if (allowHold && message === 'sidecar_not_ready') {
        // The ready event can reach the page before the rejection of a call sent just before it. That is not a
        // sidecar that is still down: the epoch moved, so send the call once more instead of waiting for a
        // ready event that already happened.
        if (ready.epoch !== epochAtSend) return runRpc(core, method, args, false);
        ready.open = false;
        return holdUntilReady(core, method, args);
      }
      throw new Error(message);
    });
  }
  function $invoke(method, args) {
    var core = tauriCore();
    if (!core) return Promise.reject(new Error('not_implemented:' + method + ' (no Tauri bridge)'));
    if (!ready.open) return holdUntilReady(core, method, args);
    return runRpc(core, method, args, true);
  }

  // Same shape as ipcRenderer.on: a SYNCHRONOUS unsubscribe function. listen() resolves async, so a
  // call to unsubscribe before it resolves is remembered and applied on arrival. \`onDeath\` (optional) is
  // run once if the sidecar dies while the subscription is still open (see $onSidecarError).
  var deathHooks = [];
  function $subscribe(channel, deliver, onDeath) {
    var api = tauriEvent();
    if (!api) return function () {};
    var unlisten = null;
    var cancelled = false;
    var hook = onDeath ? function () { if (!cancelled) onDeath(); } : null;
    if (hook) deathHooks.push(hook);
    function dropHook() { if (hook) { var at = deathHooks.indexOf(hook); if (at >= 0) deathHooks.splice(at, 1); } }
    var live = api.listen(channel, function (e) {
      if (cancelled) return;
      // A deliver that returns true has handed over the stream's final event: nothing left to fail.
      if (deliver(e && decodeBinary(e.payload)) === true) dropHook();
    })
      .then(function (u) { if (cancelled) u(); else unlisten = u; })
      .catch(function () {});
    var off = function () {
      cancelled = true;
      dropHook();
      if (unlisten) unlisten();
    };
    // Resolves (never rejects) once the listener is live. A caller that must not miss an event awaits it before it starts
    // what emits: talk/director.js listens for a turn's reply events before sending the turn.
    off.ready = live;
    return off;
  }

  // Host-level sidecar failures (spawn / handshake / exit) arrive as the host's \`sidecar:error\` event.
  // Surface them: console.error, a \`zumi:sidecar-error\` DOM event on window (detail = the payload), and
  // an optional window.zumiOnError(payload) hook if the page defines one. The renderer has no built-in
  // toast yet, so a page can show one with:
  //   window.addEventListener('zumi:sidecar-error', (e) => showToast(e.detail.message));
  function $onSidecarError(payload) {
    // A fatal error means no ready event can follow (the host never restarts that sidecar): fail every held
    // call now. A recoverable error means a restart is in progress, so new calls wait for its ready event.
    if (payload && payload.fatal === true) failHeld(); else ready.open = false;
    // End every stream that can no longer finish (once each), before the page is told: a renderer handler
    // that reacts to zumi:sidecar-error then sees the turn already failed.
    var hooks = deathHooks.splice(0);
    for (var i = 0; i < hooks.length; i++) { try { hooks[i](); } catch (e) {} }
    try { if (window.console && window.console.error) window.console.error('[zumi] sidecar:error', payload); } catch (e) {}
    try { if (typeof window.zumiOnError === 'function') window.zumiOnError(payload); } catch (e) {}
    try {
      var Ctor = window.CustomEvent || window.Event;
      if (typeof Ctor === 'function' && typeof window.dispatchEvent === 'function') {
        window.dispatchEvent(new Ctor('zumi:sidecar-error', { detail: payload }));
      }
    } catch (e) {}
  }
  (function () {
    var api = tauriEvent();
    if (api && typeof api.listen === 'function') {
      // Registered at shim load, before the renderer bundle runs, so a ready event that arrives while calls are
      // queued is never missed: it opens the gate and releases them. It also tells the page the restart answered,
      // as a \`zumi:sidecar-ready\` window event, so a visible sidecar error can clear itself.
      try {
        api.listen('sidecar:ready', function () {
          ready.epoch += 1; ready.open = true; releaseHeld();
          try {
            var Ctor = window.CustomEvent || window.Event;
            if (typeof Ctor === 'function' && typeof window.dispatchEvent === 'function') window.dispatchEvent(new Ctor('zumi:sidecar-ready', { detail: null }));
          } catch (e) {}
        }).catch(function () {});
      } catch (e) {}
      try {
        api.listen('sidecar:provisioning', function (e) {
          rearmHeld();
          try {
            var Ctor = window.CustomEvent || window.Event;
            if (typeof Ctor === 'function' && typeof window.dispatchEvent === 'function') window.dispatchEvent(new Ctor('zumi:sidecar-provisioning', { detail: e && e.payload }));
          } catch (e2) {}
        }).catch(function () {});
      } catch (e) {}
      try { api.listen('sidecar:error', function (e) { $onSidecarError(e && e.payload); }).catch(function () {}); } catch (e) {}
    }
  })();

  window.zumi = ${zumi};
})();
`;
}

function main() {
  const args = process.argv.slice(2);
  const at = args.indexOf('--out');
  const out = at >= 0 ? path.resolve(args[at + 1]) : path.join(here, 'zumi-shim.js');
  const inventory = JSON.parse(fs.readFileSync(INVENTORY, 'utf8'));
  const code = generateShim(inventory);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, code);
  console.log(`generate-shim: wrote ${path.relative(root, out)} (${(inventory.apis || []).length} names, schema v${inventory.schemaVersion})`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
