// T-31 liveboard-p2 safety fix (SAFETY.md Q3 cond 3 + Q2 cond 2): the guest Board HTML must carry a CSP with
// connect-src 'self' on EVERY host path. The Tauri sidecar builds the live board with src/main/board-live.mjs ->
// board-bridge.mjs createBridge over laneboard's public dir (tauri/sidecar/board-host.mjs), so the Tauri guest HTML comes
// from the same serveStatic as Electron's. Plain Node, loopback only, no window.
//   node scripts/check-tauri-board-csp.mjs
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { createBridge as rawCreateBridge, GUEST_HTML_CSP } from '../src/main/board-bridge.mjs';
// Caller-auth (board-bridge.mjs): every request must carry the per-launch secret. The wrapper records each bridge's
// header by port so the helpers send it like the app's own webview/reader would; a test drops it with `undefined`.
const bridgeTokens = new Map();
const createBridge = (o) => { const b = rawCreateBridge(o); b.port().then((p) => bridgeTokens.set(p, b.callerHeaders())); return b; };
const tokenFor = (port) => bridgeTokens.get(port) || {};

import { laneboardDir } from '../tauri/sidecar/adapters.mjs';

const ROOT = path.join(import.meta.dirname, '..');
let pass = 0, fail = 0;
const ok = (c, n, d = '') => { if (c) { pass++; console.log(`PASS ${n}`); } else { fail++; console.log(`FAIL ${n}${d ? '  ' + d : ''}`); } };
const get = (port, p) => new Promise((res, rej) => { http.get({ host: '127.0.0.1', port, path: p, headers: { connection: 'close', ...tokenFor(port) } }, (r) => { const c = []; r.on('data', (x) => c.push(x)); r.on('end', () => res({ status: r.statusCode, headers: r.headers, text: Buffer.concat(c).toString() })); }).on('error', rej); });
// Raw ws handshake to the bridge: a guest page's `new WebSocket('ws://127.0.0.1:<bridge>/')`. Must never get 101.
const wsHandshake = (port) => new Promise((res) => {
  const s = net.connect(port, '127.0.0.1', () => s.write(`GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`));
  let buf = ''; const done = () => { s.destroy(); res(buf.split('\r\n')[0]); };
  s.on('data', (d) => { buf += d; if (buf.includes('\r\n')) done(); }); s.on('close', done); s.on('error', done); setTimeout(done, 3000);
});

const publicDir = path.join(laneboardDir(), 'public');
const bridge = createBridge({ upstreamOrigin: 'http://127.0.0.1:1', getToken: () => 'x', publicDir });
try {
  const port = await bridge.port();
  const html = await get(port, '/');
  ok(html.status === 200 && /text\/html/.test(html.headers['content-type']), 'sidecar publicDir: GET / is the guest HTML (200)');
  const csp = html.headers['content-security-policy'] || '';
  ok(csp === GUEST_HTML_CSP, 'sidecar guest HTML carries the pinned CSP', csp);
  const connect = (csp.split(';').map((s) => s.trim()).find((d) => d.startsWith('connect-src ')) || '').split(/\s+/).slice(1);
  ok(connect.length === 1 && connect[0] === "'self'", "connect-src is exactly 'self' (no ws:, wss:, *, http:)", JSON.stringify(connect));
  ok(Boolean((await get(port, '/index.html')).headers['content-security-policy']), 'GET /index.html carries it too');
  const js = await get(port, '/app.js');
  ok(js.status === 200 && !('content-security-policy' in js.headers), 'non-HTML (app.js) is unchanged: no CSP needed');
  const line = await wsHandshake(port);
  ok(!/101/.test(line), 'same-origin ws handshake to the bridge is not upgraded (no ws endpoint, so connect-src self leaves nothing to reach)', line);
  const vendor = fs.readFileSync(path.join(laneboardDir(), 'src', 'server.mjs'), 'utf8');
  ok(vendor.includes(GUEST_HTML_CSP), 'policy equals the vendored Laneboard server policy');
  const host = fs.readFileSync(path.join(ROOT, 'tauri/sidecar/board-host.mjs'), 'utf8');
  const live = fs.readFileSync(path.join(ROOT, 'src/main/board-live.mjs'), 'utf8');
  ok(/createLiveBoard\(/.test(host) && /publicDir:\s*path\.join\(laneboardDir\(\)/.test(host) && /createBridgeImpl = createBridge/.test(live), 'source pin: Tauri guest HTML is only ever served by board-bridge createBridge (no second HTML server)');
  const rs = fs.readFileSync(path.join(ROOT, 'tauri/src-tauri/src/guest_guard.rs'), 'utf8');
  ok(/connect-src 'self'/.test(rs) && /GUEST_HTML_CSP/.test(rs), 'guest_guard.rs documents the CSP reliance for ws (WebView2 raises no WebResourceRequested for ws)');
} finally { await bridge.close(); }
console.log(`\n${fail ? 'FAIL' : 'PASS'} check-tauri-board-csp — ${pass}/${pass + fail}`);
process.exitCode = fail ? 1 : 0;
