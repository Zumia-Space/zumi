// scripts/lib/cdp-lite.mjs against a local fake CDP server (GATE-OPUS-RELOAD SF3; the gate's probe-cdp.mjs cases C1, C3b, C6).
//   node scripts/check-cdp-lite.mjs
// C1  a target socket that drops with a call pending rejects that call at once and says why (before: it waited out its own timeout).
// C3b closing one connection does not reject a call pending on another connection to the same target.
// C6  Inspector.detached on a socket that stays open does not reject later calls.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';

import { connect } from './lib/cdp-lite.mjs';

const socks = [];
let mode = 'answer'; // 'answer': reply 42 to every call; 'silent': never reply
const frame = (op, buf) => Buffer.concat([buf.length < 126 ? Buffer.from([0x80 | op, buf.length]) : Buffer.from([0x80 | op, 126, buf.length >> 8, buf.length & 255]), buf]);
const srv = http.createServer().on('upgrade', (req, sock) => {
  const accept = crypto.createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  sock.mode = mode;
  socks.push(sock);
  sock.on('error', () => {});
  let buf = Buffer.alloc(0);
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 2) {
      const op = buf[0] & 15;
      let n = buf[1] & 127;
      let o = 2;
      if (n === 126) { n = buf.readUInt16BE(2); o = 4; }
      if (buf.length < o + 4 + n) return;
      const mask = buf.subarray(o, o + 4);
      const payload = Buffer.from(buf.subarray(o + 4, o + 4 + n)).map((b, i) => b ^ mask[i % 4]);
      buf = buf.subarray(o + 4 + n);
      if (op === 8) { sock.end(frame(8, Buffer.from([3, 232]))); return; }
      if (op === 1 && sock.mode === 'answer') {
        const m = JSON.parse(payload.toString());
        sock.write(frame(1, Buffer.from(JSON.stringify({ id: m.id, result: { result: { value: 42 } } }))));
      }
    }
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const url = `ws://127.0.0.1:${srv.address().port}/devtools/page/x`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = (p, ms) => Promise.race([p.then((v) => ({ v }), (e) => ({ e: e.message })), wait(ms).then(() => ({ hung: ms }))]);

try {
  { // C1
    mode = 'silent';
    const c = await connect(url);
    const t0 = Date.now();
    const p = c.evaluate('1', { timeoutMs: 4000 });
    await wait(100);
    socks.at(-1).destroy();
    const r = await settle(p, 5000);
    const ms = Date.now() - t0;
    assert.ok(r.e, `C1: the pending call must reject, got ${JSON.stringify(r)}`);
    assert.match(r.e, /target socket closed/, `C1: the error says the target socket closed (got "${r.e}" after ${ms} ms)`);
    assert.ok(ms < 2000, `C1: rejected at once, not at its timeout (${ms} ms)`);
    console.log(`PASS C1 an abrupt drop rejects the pending call in ${ms} ms: ${r.e}`);
  }
  { // C3b
    mode = 'silent';
    const b = await connect(url);
    const d = await connect(url);
    const sd = socks.at(-1);
    const pb = settle(b.evaluate('1', { timeoutMs: 1500 }), 3000);
    await wait(100);
    sd.destroy();
    const r = await pb;
    assert.ok(r.e && /timed out/.test(r.e), `C3b: the call on B waits out its own timeout, untouched by D's close: ${JSON.stringify(r)}`);
    b.close();
    d.close();
    console.log('PASS C3b closing one connection does not reject a call pending on another');
  }
  { // C6
    mode = 'answer';
    const c = await connect(url);
    socks.at(-1).write(frame(1, Buffer.from(JSON.stringify({ method: 'Inspector.detached', params: { reason: 'x' } }))));
    await wait(100);
    const r = await settle(c.evaluate('1', { timeoutMs: 2000 }), 3000);
    assert.equal(r.v, 42, `C6: a later call still answers: ${JSON.stringify(r)}`);
    c.close();
    console.log('PASS C6 Inspector.detached on an open socket does not reject later calls');
  }
  console.log('ALL OK');
} catch (e) {
  console.error(`FAIL ${e.message}`);
  process.exitCode = 1;
} finally {
  for (const s of socks) s.destroy();
  srv.close();
}
// evaluate's own timeout timer outlives a fast reject (pre-existing); do not wait for it.
process.exit(process.exitCode || 0);
