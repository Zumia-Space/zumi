// TEST ONLY (scripts/check-tauri-board-bridge-heal.mjs): loaded into the REAL sidecar with `node --import`, never shipped.
// It records every http server board-bridge.mjs creates and, when the harness writes a trigger file
// (ZUMI_TEST_BRIDGE_KILL_FILE), takes the newest one down the way the field failure does:
//   close  -> server.close() + closeAllConnections(): the listener is gone, the process lives;
//   error  -> the 'error' event Node emits when libuv on Windows stops accepting (syscall 'accept'), then the
//             listening handle is closed, as when the OS tears the socket down (sleep/resume, adapter reset).
// The trigger file is deleted and an ack file (<trigger>.done) holds the port that was taken down.
import fs from 'node:fs';
import http from 'node:http';

const TRIGGER = process.env.ZUMI_TEST_BRIDGE_KILL_FILE;
if (TRIGGER) {
  const bridges = [];
  // bridge-heal2: `mid:<path>` / `early:<path>` arm a one-shot fault on the NEXT bridge request for that path, on a live
  // bridge: `mid` sends the head and part of the page, then destroys the socket; `early` destroys it before any byte.
  let armed = null;
  // gate S-b: `outage:<ms>` cuts EVERY bridge request before a byte for that long (a loopback filter aborting loads).
  let outageUntil = 0;
  const realCreate = http.createServer;
  http.createServer = function (...args) {
    const fromBridge = /board-bridge\.mjs/.test(new Error().stack || '');
    if (fromBridge) {
      const i = args.findIndex((a) => typeof a === 'function');
      const handler = args[i];
      if (i > -1) args[i] = function (req, res) {
        if (performance.now() < outageUntil) { req.socket.destroy(); return undefined; }
        const p = String(req.url || '').split('?')[0];
        if (armed && p === armed.path) {
          const how = armed.how; armed = null;
          if (how === 'early') { req.socket.destroy(); return undefined; }
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.write('<!doctype html><html><head><title>Board</title>');
          setTimeout(() => req.socket.destroy(), 30);
          return undefined;
        }
        return handler.call(this, req, res);
      };
    }
    const server = realCreate.apply(this, args);
    if (fromBridge) bridges.push(server);
    return server;
  };
  const timer = setInterval(() => {
    let how;
    try { how = fs.readFileSync(TRIGGER, 'utf8').trim(); } catch { return; }
    fs.rmSync(TRIGGER, { force: true });
    const fault = /^(mid|early):(\/\S*)$/.exec(how);
    if (fault) { armed = { how: fault[1], path: fault[2] }; fs.writeFileSync(`${TRIGGER}.done`, how); return; }
    const outage = /^outage:(\d+)$/.exec(how);
    if (outage) { outageUntil = performance.now() + Number(outage[1]); fs.writeFileSync(`${TRIGGER}.done`, how); return; }
    const server = bridges.filter((s) => s.listening).at(-1);
    const port = server ? server.address().port : null;
    if (server && how === 'error') {
      server.emit('error', Object.assign(new Error('accept ENOTSOCK'), { code: 'ENOTSOCK', errno: -4050, syscall: 'accept' }));
      if (server.listening) { server.close(); server.closeAllConnections(); }
    } else if (server) { server.close(); server.closeAllConnections(); }
    fs.writeFileSync(`${TRIGGER}.done`, String(port));
  }, 100);
  timer.unref();
}
