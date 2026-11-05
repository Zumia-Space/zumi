#!/usr/bin/env node
// T-31 baseline M: deterministic fake OpenAI-compatible chat provider, for timing "user sends -> first reply text
// painted" on the Electron AND the Tauri build without any paid key (docs/migration/REPLY-FIXTURE.md).
// Loopback only (127.0.0.1 / ::1; any other bind host is refused). No app code is touched.
//   POST <anything>/chat/completions  stream:true  -> SSE: headers at once, FIRST content chunk `firstMs` after the
//                                       request arrived, then one chunk every `intervalMs` (absolute schedule, so
//                                       timer lateness does not accumulate), then a stop+usage chunk and [DONE].
//   POST <anything>/chat/completions  stream:false -> one JSON completion with the whole text, after `firstMs`
//                                       (Plan / Check / Look up roles use this shape).
//   GET  <anything>/models | /key                  -> 200 JSON (so a key test passes with any fake key).
// Every request is logged as one JSON line on stderr at the moment it arrives ("request"), when the first content
// chunk goes out ("first"), and when the stream ends ("done"). Timestamps are epoch ms with sub-ms precision
// (performance.timeOrigin + performance.now()), the same clock as Date.now() / performance.timeOrigin in a page.
//   node scripts/fake-llm-sse.mjs --port 18787 --first-ms 400 --interval-ms 60 [--text "..."] [--chunk-chars 8]
import http from 'node:http';
import { fileURLToPath } from 'node:url';

export const DEFAULT_TEXT = 'Sure, I can help with that. This fixed reply streams at a steady pace so the first words can be timed.';
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

export const epochNowMs = () => performance.timeOrigin + performance.now();

// The deterministic chunk list: `text` cut into pieces of `chunkChars` characters, in order.
export function splitText(text, chunkChars) {
  const n = Math.max(1, Math.floor(chunkChars));
  const out = [];
  for (let i = 0; i < text.length; i += n) out.push(text.slice(i, i + n));
  return out;
}

const sseLine = (o) => `data: ${JSON.stringify(o)}\n\n`;

export async function startFakeLlm({ host = '127.0.0.1', port = 0, firstMs = 400, intervalMs = 60, text = DEFAULT_TEXT, chunkChars = 8, log = (o) => process.stderr.write(`${JSON.stringify(o)}\n`) } = {}) {
  if (!LOOPBACK.has(host)) throw new Error(`fake-llm-sse: refusing to bind ${host} (loopback only)`);
  if (!(firstMs >= 0) || !(intervalMs >= 0)) throw new Error('fake-llm-sse: firstMs and intervalMs must be >= 0');
  const pieces = splitText(String(text), chunkChars);
  const requests = [];
  let seq = 0;

  const server = http.createServer((req, res) => {
    const arrivedAt = epochNowMs();
    const rec = { seq: ++seq, method: req.method, path: req.url, arrivedAtMs: arrivedAt, stream: null, firstChunkAtMs: null, doneAtMs: null, chunks: 0 };
    requests.push(rec);
    log({ ev: 'request', seq: rec.seq, method: rec.method, path: rec.path, atMs: arrivedAt });
    const timers = [];
    res.on('close', () => { for (const t of timers) clearTimeout(t); });
    const at = (targetMs, fn) => timers.push(setTimeout(fn, Math.max(0, targetMs - epochNowMs())));
    const path = String(req.url || '').split('?')[0];

    if (req.method === 'GET' && (path.endsWith('/models') || path.endsWith('/key'))) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'fixture-model', object: 'model' }] }));
      return;
    }
    if (req.method !== 'POST' || !path.endsWith('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"fake-llm-sse: not found"}}');
      return;
    }
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { /* an unparsable body is answered as non-stream */ }
      const model = typeof body.model === 'string' ? body.model : 'fixture-model';
      rec.stream = body.stream === true;
      rec.model = model;
      if (!rec.stream) {
        // The schedule is anchored on the request's ARRIVAL, not on the body being read.
        at(arrivedAt + firstMs, () => {
          const now = epochNowMs();
          rec.firstChunkAtMs = rec.doneAtMs = now;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 'fixture', object: 'chat.completion', model, provider: 'Fixture', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: pieces.length, total_tokens: 20 + pieces.length } }));
          log({ ev: 'done', seq: rec.seq, atMs: now, stream: false });
        });
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.flushHeaders();
      pieces.forEach((piece, i) => {
        at(arrivedAt + firstMs + i * intervalMs, () => {
          const now = epochNowMs();
          if (i === 0) { rec.firstChunkAtMs = now; log({ ev: 'first', seq: rec.seq, atMs: now, sinceArrivalMs: now - arrivedAt }); }
          rec.chunks += 1;
          res.write(sseLine({ id: 'fixture', object: 'chat.completion.chunk', model, provider: 'Fixture', choices: [{ index: 0, delta: i === 0 ? { role: 'assistant', content: piece } : { content: piece }, finish_reason: null }] }));
        });
      });
      at(arrivedAt + firstMs + pieces.length * intervalMs, () => {
        const now = epochNowMs();
        rec.doneAtMs = now;
        res.write(sseLine({ id: 'fixture', object: 'chat.completion.chunk', model, provider: 'Fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: pieces.length, total_tokens: 20 + pieces.length } }));
        res.end('data: [DONE]\n\n');
        log({ ev: 'done', seq: rec.seq, atMs: now, stream: true, chunks: rec.chunks });
      });
    });
  });

  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  const addr = server.address();
  const boundHost = addr.family === 'IPv6' ? `[${addr.address}]` : addr.address;
  return {
    host, port: addr.port, url: `http://${boundHost}:${addr.port}`, requests, pieces,
    close: () => new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
}

function argValue(argv, name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2);
  const f = await startFakeLlm({
    host: argValue(argv, '--host', '127.0.0.1'),
    port: Number(argValue(argv, '--port', 0)),
    firstMs: Number(argValue(argv, '--first-ms', 400)),
    intervalMs: Number(argValue(argv, '--interval-ms', 60)),
    chunkChars: Number(argValue(argv, '--chunk-chars', 8)),
    text: argValue(argv, '--text', DEFAULT_TEXT),
  });
  process.stdout.write(`READY ${JSON.stringify({ url: f.url, port: f.port, chunks: f.pieces.length })}\n`);
  const stop = () => f.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
