// T-31 P1c1 spare-PC guard probe — wardrobe stand-in.
//
// This tree is passed as ZUMI_WARDROBE_DIR, so the UNCHANGED wardrobe.open path opens it as the guest
// under test. It behaves like the F-04 wardrobe server in the only ways wardrobe-bridge.mjs needs:
//   * it listens on 127.0.0.1:$PORT (PORT is chosen by the bridge and passed in the env);
//   * it answers GET /api/wardrobe/library, which is the bridge's readiness probe.
// On top of that it is the probe instrument:
//   (a) serves the probe page at / on that loopback origin;
//   (b) opens a SECOND listener on this PC's first non-loopback IPv4 — the "remote" target — and logs
//       every http request path and every WebSocket upgrade it receives (ws handshakes go to their own
//       list, `wsHits`, so a websocket leak never decides the http-bound PASS);
//   (c) exposes GET /__results: the remote hits, the ws hits, the page-reported outcomes and the controls.
//
// It binds a non-loopback address on purpose (that listener is the whole point of the probe). Run it
// only on the spare PC, only through tauri/verify/run-guard-probe.ps1. It never touches any OS setting.
//
// Plain Node built-ins only (no dependencies). It prints nothing secret and no guest URL of its own.

import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Host check FIRST, before any listener: this probe opens a listener on a non-loopback address, so it
// refuses on anh's main PC exactly like every Electron/Zumi starter (one rule,
// scripts/lib/electron-guard.cjs). Nothing below runs unless ZUMI_ELECTRON_HOST=box.
const require = createRequire(import.meta.url);
const { exitUnlessElectronHost } = require(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'scripts', 'lib', 'electron-guard.cjs'),
);
exitUnlessElectronHost('the guard-probe server');

const PORT = Number(process.env.PORT || 0);
const HOST = '127.0.0.1';

function firstNonLoopbackIPv4() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list || []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return null;
}

const state = {
  remoteHits: [], // { path, upgrade } for every non-preflight http request the remote listener saw
  wsHits: [], // every WebSocket handshake the remote listener saw — its own line, never folded into PASS
  controls: { ok: false, ok2: false, mainOk: false }, // the requests that MUST get through to loopback (mainOk: P1c4, from the MAIN webview)
  pageOutcomes: null, // what the probe page reported (POST /__page)
  mainOutcomes: {}, // P1c4: what the MAIN webview's vectors reported, one key at a time (POST /__main_page)
  instrument: {
    remoteBase: null, // http://<non-loopback ipv4>:<port>, or null when this PC has none
    error: null,
    preflight: false, // true once Node has proved the remote listener records its own hits
  },
};

// ---- the remote ("off-box") target: any hit here is a leak ------------------

const remoteServer = http.createServer((req, res) => {
  const path = (req.url || '').split('?')[0];
  if (path === '/__preflight') {
    state.instrument.preflight = true;
  } else if (String(req.headers.upgrade || '').toLowerCase() === 'websocket') {
    state.wsHits.push({ path, upgrade: true }); // a handshake seen as a plain GET
  } else {
    state.remoteHits.push({ path, upgrade: false });
  }
  res.writeHead(204);
  res.end();
});
remoteServer.on('upgrade', (req, socket) => {
  const path = (req.url || '').split('?')[0];
  state.wsHits.push({ path, upgrade: true });
  socket.destroy();
});

// ---- the probe page and its worker scripts ---------------------------------

function probeHtml(remoteBase, loopbackOrigin) {
  const wsBase = remoteBase.replace(/^http/, 'ws');
  const port = new URL(loopbackOrigin).port;
  return `<!doctype html>
<html><head><meta charset="utf-8"><link rel="icon" href="data:,">
<title>Zumi guard probe</title>
<img id="early" src="${remoteBase}/vector-early-img" alt="">
</head><body>
<h1>Zumi guard probe</h1>
<script>
(function () {
  var REMOTE = ${JSON.stringify(remoteBase)};
  var WS = ${JSON.stringify(wsBase)};
  var LOOPBACK = ${JSON.stringify(loopbackOrigin)};
  var outcomes = {};
  function rec(k, v) { outcomes[k] = v; }
  function report() {
    try {
      fetch(LOOPBACK + '/__page', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(outcomes) }).catch(function () {});
    } catch (e) { /* ignore */ }
  }

  // control: same-origin (must get through to loopback)
  fetch(LOOPBACK + '/ok').then(function (r) { rec('control_same_origin', r.status); }).catch(function (e) { rec('control_same_origin', 'rejected:' + (e && e.name)); }).then(report);
  // control: cross-origin loopback via the localhost alias (must get through)
  fetch('http://localhost:' + ${JSON.stringify(port)} + '/ok2').then(function (r) { rec('control_cross_loopback', r.status); }).catch(function (e) { rec('control_cross_loopback', 'rejected:' + (e && e.name)); }).then(report);

  // ipc.localhost / tauri.localhost overwrite check WITHOUT CDP on the guest: the guest never appears
  // in the host's /json target list on 9333 (measured), so this page issues the two requests itself
  // and reports over the allowed loopback origin. Verdict mapping lives in drive-guard-probe.mjs.
  //   ipc.localhost: parity 11-2 re-opens this host for the WARDROBE guest only (its one bridge command).
  //   Tauri's IPC handler answers a non-POST with 405 and sets Access-Control-Allow-Origin: *
  //   (tauri 2.12.4 src/ipc/protocol.rs:45-52,173), so a CORS fetch RESOLVES (overwritten:405) when the
  //   guard lets it through. The board guest, which is not this page, keeps blocking it.
  //   tauri.localhost: a real frontendDist image loads only if wry's asset handler replaced our 403;
  //   the no-cors fetch again separates "our 403" from "no response at all" (inconclusive).
  // Cache-busters: a rerun in the same guest partition must not answer from the previous run's cache.
  try {
    fetch('http://ipc.localhost/__zumi-guard-probe?r=' + Date.now(), { mode: 'cors' })
      .then(function (r) { rec('host_ipc', 'overwritten:' + r.status); report(); })
      .catch(function () {
        return fetch('http://ipc.localhost/__zumi-guard-probe?r=' + Date.now(), { mode: 'no-cors' }).then(
          function () { rec('host_ipc', 'blocked-noncors'); report(); },
          function () { rec('host_ipc', 'n/a:no-response'); report(); },
        );
      });
  } catch (e) { rec('host_ipc', 'n/a:throw'); report(); }

  try {
    var hostImg = new Image();
    hostImg.onload = function () { rec('host_tauri', 'overwritten:asset'); report(); };
    hostImg.onerror = function () {
      fetch('http://tauri.localhost/brand/zumia-mark.svg?r=' + Date.now(), { mode: 'no-cors' }).then(
        function () { rec('host_tauri', 'blocked-noncors'); report(); },
        function () { rec('host_tauri', 'n/a:no-response'); report(); },
      );
    };
    hostImg.src = 'http://tauri.localhost/brand/zumia-mark.svg?r=' + Date.now();
  } catch (e) { rec('host_tauri', 'n/a:throw'); report(); }

  // Parity 11-2: this page IS the wardrobe guest, so it carries the wardrobe's one bridge. Reachable
  // means the bridge resolved with a sidecar answer (ok true or false): the guard re-opened the IPC host
  // for this guest and the ACL admitted the command. A rejection is an ACL/guard refusal (a FAIL).
  // bridge_other must be denied: the main rpc command is not in the wardrobe capability, so "only one
  // command" is measured, not just claimed.
  try {
    var bridge = window.zumiHost;
    rec('bridge_keys', bridge && typeof bridge === 'object' ? Object.keys(bridge).sort().join(',') : 'missing');
    if (bridge && typeof bridge.apply === 'function') {
      bridge.apply({ recipe: 'guard-probe' }).then(
        function (r) { rec('bridge_apply', r && typeof r === 'object' ? 'answered' : 'bad-shape'); report(); },
        function (e) { rec('bridge_apply', 'rejected:' + String((e && e.message) || e).slice(0, 120)); report(); });
    } else {
      rec('bridge_apply', 'n/a:no-bridge');
      report();
    }
    try {
      window.__TAURI_INTERNALS__.invoke('rpc', { method: 'info', args: [] }).then(
        function () { rec('bridge_other', 'allowed'); report(); },
        function () { rec('bridge_other', 'denied'); report(); });
    } catch (e) { rec('bridge_other', 'n/a:throw'); report(); }
  } catch (e) { rec('bridge_apply', 'n/a:throw'); report(); }

  // fetch to the remote listener
  fetch(REMOTE + '/vector-fetch', { mode: 'no-cors' }).then(function (r) { rec('fetch', 'resolved:' + (r.status || 0)); }).catch(function (e) { rec('fetch', 'rejected:' + (e && e.name)); }).then(report);

  // img
  try { var im = new Image(); im.onload = function () { rec('img', 'loaded'); report(); }; im.onerror = function () { rec('img', 'error'); report(); }; im.src = REMOTE + '/vector-img'; } catch (e) { rec('img', 'throw'); }

  // script
  try { var sc = document.createElement('script'); sc.src = REMOTE + '/vector-script'; sc.onerror = function () { rec('script', 'error'); report(); }; sc.onload = function () { rec('script', 'loaded'); report(); }; document.body.appendChild(sc); } catch (e) { rec('script', 'throw'); }

  // iframe on the loopback origin that loads a remote image
  try { var f = document.createElement('iframe'); f.src = LOOPBACK + '/iframe'; f.style.width = '1px'; f.style.height = '1px'; document.body.appendChild(f); rec('iframe-img', 'fired'); } catch (e) { rec('iframe-img', 'throw'); }

  // dedicated worker fetch
  try {
    var wsrc = 'self.onmessage=function(){fetch(' + JSON.stringify(REMOTE + '/vector-worker-fetch') + ',{mode:"no-cors"}).then(function(){postMessage("done")}).catch(function(){postMessage("fail")})};';
    var w = new Worker(URL.createObjectURL(new Blob([wsrc], { type: 'text/javascript' })));
    w.onmessage = function (e) { rec('worker-fetch', e.data); report(); };
    w.postMessage('go');
  } catch (e) { rec('worker-fetch', 'throw'); report(); }

  // shared worker fetch
  try {
    var sw = new SharedWorker(LOOPBACK + '/shared-worker.js');
    sw.port.onmessage = function (e) { rec('shared-worker-fetch', e.data); report(); };
    sw.port.postMessage('go');
  } catch (e) { rec('shared-worker-fetch', 'throw'); report(); }

  // service worker fetch
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register(LOOPBACK + '/sw.js').then(function () { return navigator.serviceWorker.ready; }).then(function (reg) {
      rec('sw-fetch', 'registered');
      if (reg.active) reg.active.postMessage('go');
      report();
    }).catch(function (e) { rec('sw-fetch', 'n/a:' + (e && e.message)); report(); });
  } else { rec('sw-fetch', 'n/a:no-serviceworker'); report(); }

  // redirect: one loopback URL that 302s to the remote listener. Electron blocks each hop; the remote
  // hit log (not the page) proves whether WebView2 raised WebResourceRequested for the hop.
  try {
    fetch(LOOPBACK + '/redirect', { mode: 'no-cors' }).then(function () { rec('redirect', 'settled'); report(); }).catch(function (e) { rec('redirect', 'rejected:' + (e && e.name)); report(); });
  } catch (e) { rec('redirect', 'throw'); report(); }

  // beacon
  try { rec('beacon', navigator.sendBeacon(REMOTE + '/vector-beacon', 'x') ? 'queued' : 'refused'); } catch (e) { rec('beacon', 'throw'); }
  report();

  // websocket
  try {
    var sock = new WebSocket(WS + '/vector-ws');
    sock.onopen = function () { rec('ws', 'open'); report(); };
    sock.onerror = function () { rec('ws', 'error'); report(); };
    sock.onclose = function () { rec('ws', outcomes.ws || 'closed'); report(); };
  } catch (e) { rec('ws', 'throw'); report(); }

  // the head img, reported once it settles
  var ei = document.getElementById('early');
  if (ei) {
    ei.addEventListener('load', function () { rec('early-img', 'loaded'); report(); });
    ei.addEventListener('error', function () { rec('early-img', 'error'); report(); });
    if (ei.complete) rec('early-img', ei.naturalWidth ? 'loaded' : 'error');
  }

  // Completion signal: after a settle window, report once with done=true. The driver waits for it (or
  // a per-vector timeout), so a slow service-worker registration is not cut off at the first report.
  setTimeout(function () {
    if (outcomes.bridge_apply === undefined) rec('bridge_apply', 'n/a:timeout');
    outcomes.done = true;
    report();
  }, 8000);
})();
</script>
</body></html>`;
}

const iframeHtml = (remoteBase) => `<!doctype html>
<html><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>probe iframe</title></head>
<body><img src="${remoteBase}/vector-iframe-img" alt=""></body></html>`;

const sharedWorkerJs = (remoteBase) => `onconnect = function (e) {
  var port = e.ports[0];
  port.onmessage = function () {
    fetch(${JSON.stringify(remoteBase + '/vector-shared-worker-fetch')}, { mode: 'no-cors' }).then(function () { port.postMessage('done'); }).catch(function () { port.postMessage('fail'); });
  };
};`;

const serviceWorkerJs = (remoteBase) => `self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('message', function () {
  fetch(${JSON.stringify(remoteBase + '/vector-sw-fetch')}, { mode: 'no-cors' }).catch(function () {});
});`;

// ---- the loopback server the wardrobe bridge expects -----------------------

const server = http.createServer((req, res) => {
  const path = (req.url || '').split('?')[0];
  const loopbackOrigin = `http://${HOST}:${server.address() ? server.address().port : PORT}`;
  const remoteBase = state.instrument.remoteBase;

  if (path === '/api/wardrobe/library') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"items":[]}');
    return;
  }
  if (path === '/ok') { state.controls.ok = true; res.writeHead(200); res.end('ok'); return; }
  if (path === '/ok2') { state.controls.ok2 = true; res.writeHead(200, { 'access-control-allow-origin': '*' }); res.end('ok2'); return; }
  if (path === '/iframe') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(iframeHtml(remoteBase || ''));
    return;
  }
  if (path === '/shared-worker.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' });
    res.end(sharedWorkerJs(remoteBase || ''));
    return;
  }
  if (path === '/sw.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' });
    res.end(serviceWorkerJs(remoteBase || ''));
    return;
  }
  // ---- P1c4: the MAIN webview's vectors (driver-injected over CDP; paths are /main-*) ----
  // The main page is http://tauri.localhost, so every loopback answer carries a permissive CORS header
  // and /__main_page is posted as a simple (no-cors, text/plain) request: no preflight is needed.
  if (path === '/main-ok') { state.controls.mainOk = true; res.writeHead(200, { 'access-control-allow-origin': '*' }); res.end('ok'); return; }
  if (path === '/main-iframe') {
    // A loopback document whose own subresource goes to the remote listener (a sub-frame request source).
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"></head><body><img src="${remoteBase || ''}/main-vector-iframe-img" alt=""></body></html>`);
    return;
  }
  if (path === '/main-redirect') {
    res.writeHead(302, { location: (remoteBase || '') + '/main-vector-redirect-remote' });
    res.end();
    return;
  }
  if (path === '/__main_page') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try {
        const { k, v } = JSON.parse(body || '{}');
        if (typeof k === 'string' && typeof v === 'string') state.mainOutcomes[k] = v;
      } catch { state.mainOutcomes.parseError = 'true'; }
      res.writeHead(204, { 'access-control-allow-origin': '*' });
      res.end();
    });
    return;
  }
  if (path === '/404') { res.writeHead(404); res.end('not found'); return; }
  if (path === '/redirect') {
    // A single hop: a loopback URL that redirects to the remote listener. If the guard fires on the
    // redirect target (as Electron does), the remote listener sees nothing.
    res.writeHead(302, { location: (remoteBase || '') + '/vector-redirect-remote' });
    res.end();
    return;
  }
  if (path === '/die') { req.socket.destroy(); return; } // drop the socket before any header
  if (path === '/__page') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try { state.pageOutcomes = JSON.parse(body || '{}'); } catch { state.pageOutcomes = { parseError: true }; }
      res.writeHead(204);
      res.end();
    });
    return;
  }
  if (path === '/__results') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(state));
    return;
  }
  if (path === '/__quit') {
    res.writeHead(200);
    res.end('bye');
    setTimeout(() => process.exit(0), 50);
    return;
  }
  if (path === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(probeHtml(remoteBase || '', loopbackOrigin));
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

// ---- boot ------------------------------------------------------------------

const ipv4 = firstNonLoopbackIPv4();
if (!ipv4) {
  state.instrument.error = 'no_non_loopback_ipv4';
} else {
  await new Promise((resolve) => {
    remoteServer.listen(0, ipv4, () => resolve());
  });
  state.instrument.remoteBase = `http://${ipv4}:${remoteServer.address().port}`;
  // Prove the instrument records its own hits: Node hits the remote listener from outside loopback.
  await new Promise((resolve) => {
    const pre = http.get(`${state.instrument.remoteBase}/__preflight`, (r) => { r.resume(); resolve(); });
    pre.on('error', () => resolve());
  });
}

server.listen(PORT, HOST, () => {
  process.stdout.write(`[guard-probe] listening on ${HOST}:${server.address().port} remote=${state.instrument.remoteBase || 'unavailable'}\n`);
});
