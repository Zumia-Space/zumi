// TEST ONLY (scripts/check-tauri-local-board-heal.mjs): loaded into the REAL sidecar with `node --import`, never shipped.
// Records every http server src/main/laneboard-host.mjs creates (the public LOCAL Board tab server) and, when the
// harness writes the trigger file (ZUMI_TEST_LOCALBOARD_KILL_FILE), takes the newest listening one down:
//   close -> server.close() + closeAllConnections();
//   error -> emit the Windows accept error Node raises when libuv stops accepting, then close the handle.
// Ack file <trigger>.done holds the port taken down (written BEFORE the kill, so a crash still leaves the ack).
import fs from 'node:fs';
import http from 'node:http';

const TRIGGER = process.env.ZUMI_TEST_LOCALBOARD_KILL_FILE;
// ZUMI_TEST_LOCALBOARD_KILL_ON_FIRST_REQUEST=error: the first request a local board server gets (the first-run seed's own
// HTTP write, while openLocalBoard has not returned yet) takes that server down the same way (0.3.7 gate S1).
const ON_FIRST_REQUEST = process.env.ZUMI_TEST_LOCALBOARD_KILL_ON_FIRST_REQUEST;
const takeDown = (server, how) => {
  if (how === 'error') server.emit('error', Object.assign(new Error('accept ENOTSOCK'), { code: 'ENOTSOCK', errno: -4050, syscall: 'accept' }));
  if (server.listening) { server.close(); server.closeAllConnections(); }
};
if (TRIGGER) {
  const servers = [];
  const realCreate = http.createServer;
  let firstDone = false;
  http.createServer = function (...args) {
    const server = realCreate.apply(this, args);
    if (/laneboard-host\.mjs/.test(new Error().stack || '')) {
      servers.push(server);
      if (ON_FIRST_REQUEST && !firstDone) server.once('request', () => { if (firstDone) return; firstDone = true; setImmediate(() => takeDown(server, ON_FIRST_REQUEST)); });
    }
    return server;
  };
  const timer = setInterval(() => {
    let how;
    try { how = fs.readFileSync(TRIGGER, 'utf8').trim(); } catch { return; }
    fs.rmSync(TRIGGER, { force: true });
    const server = servers.filter((s) => s.listening).at(-1);
    const port = server ? server.address().port : null;
    fs.writeFileSync(`${TRIGGER}.done`, String(port));
    if (server) takeDown(server, how);
  }, 100);
  timer.unref();
}
