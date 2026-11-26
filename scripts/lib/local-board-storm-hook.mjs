// TEST ONLY (scripts/check-tauri-local-board-backoff.mjs): loaded into the REAL sidecar with `node --import`, never shipped.
// A persistent fault: every http server src/main/laneboard-host.mjs creates gets the Windows accept error STORM_FAULT_MS after
// it starts listening, so the local board can never stay up. One JSON line per listen and per fault goes to
// ZUMI_TEST_LOCALBOARD_STORM_LOG, with the server's listener counts at the fault, so a handler leak shows.
import fs from 'node:fs';
import http from 'node:http';

export const STORM_FAULT_MS = 300;
const LOG = process.env.ZUMI_TEST_LOCALBOARD_STORM_LOG;
if (LOG) {
  const realCreate = http.createServer;
  let n = 0;
  http.createServer = function (...args) {
    const server = realCreate.apply(this, args);
    if (!/laneboard-host\.mjs/.test(new Error().stack || '')) return server;
    const id = ++n;
    server.once('listening', () => {
      fs.appendFileSync(LOG, JSON.stringify({ ev: 'listen', id, at: Date.now() }) + '\n');
      setTimeout(() => {
        fs.appendFileSync(LOG, JSON.stringify({ ev: 'fault', id, at: Date.now(), errL: server.listenerCount('error'), closeL: server.listenerCount('close') }) + '\n');
        server.emit('error', Object.assign(new Error('accept ENOTSOCK'), { code: 'ENOTSOCK', errno: -4050, syscall: 'accept' }));
      }, STORM_FAULT_MS);
    });
    return server;
  };
}
