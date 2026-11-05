// Regression test for the T-31 voice P1 packaged-app bug: Kokoro TTS never ran because ensureReady()'s download
// threw "Invalid URL" on every turn, logged by main.js as `[kokoro-tts] EN speak failed, falling back to local
// voice: Invalid URL`, SAPI every time, fp16 model never cached.
//
// Root cause: huggingface.co's /resolve/main/<file> endpoint redirects LFS-tracked files (the big .onnx weights)
// to an ABSOLUTE CDN URL, but redirects small git-blob files (config.json, tokenizer*.json) to a RELATIVE
// Location header (e.g. "/api/resolve-cache/..."). kokoro-worker.mjs's download() used to hand that Location
// straight to https.get()/http.get(), which calls `new URL(location)` with no base -- a relative input throws
// `TypeError [ERR_INVALID_URL]: Invalid URL`, and nothing about which file or URL failed was ever logged (only
// `.message` crosses the worker_thread postMessage boundary, so even the stack was lost). Confirmed against the
// real huggingface.co redirect behavior while root-causing this bug (2026-10-08):
//   config.json -> 307, Location: /api/resolve-cache/models/onnx-community/Kokoro-82M-v1.0-ONNX/<rev>/config.json?...
// This test reproduces that exact shape (absolute request -> relative-Location redirect -> 200) against a local,
// offline HTTP server, so it never depends on huggingface.co being reachable or behaving the same way later.
//
// Before the fix: FAILS with "Invalid URL" (relative Location handed straight to http.get()).
// After the fix: PASSES (`new URL(location, url)` resolves the relative Location against the request's own
// origin before following it, exactly like a browser or curl would).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { download } from '../src/main/kokoro-worker.mjs';

let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); } };

const BODY = 'pretend this is config.json content\n';

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/resolve/main/config.json') {
        // Relative Location -- no scheme, no host. This is the exact shape huggingface.co sends for small files.
        res.writeHead(307, { Location: '/api/resolve-cache/config.json?etag=%22abc%22' });
        res.end();
        return;
      }
      if (req.url === '/api/resolve-cache/config.json?etag=%22abc%22') {
        res.writeHead(200, { 'Content-Length': String(Buffer.byteLength(BODY)) });
        res.end(BODY);
        return;
      }
      if (req.url === '/to-ftp') {
        // Default (Electron) mode has no host allow-list: this reaches the transport, which rejects ftp:// itself.
        res.writeHead(302, { Location: 'ftp://example.invalid/model.onnx' });
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function main() {
  const server = await startServer();
  const port = server.address().port;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zumi-kokoro-redirect-check-'));
  const dest = path.join(tmp, 'config.json');

  try {
    await download(`http://127.0.0.1:${port}/resolve/main/config.json`, dest, () => {});
    ok(true, 'download() follows a relative redirect Location without throwing');
    const got = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : null;
    ok(got === BODY, 'the file at the resolved (absolute) redirect target was written to disk', JSON.stringify(got));
  } catch (e) {
    ok(false, 'download() follows a relative redirect Location without throwing', `threw: ${(e && e.message) || e}`);
    ok(false, 'the file at the resolved (absolute) redirect target was written to disk', 'skipped: download threw');
  }

  // A redirect to something that isn't a URL at all (not even resolvable against a base) must still fail loudly,
  // with the bad Location value and the request URL in the message -- never a bare, contextless "Invalid URL".
  try {
    await download(`http://127.0.0.1:${port}/missing-location-handling-not-under-test`, path.join(tmp, 'x'), () => {});
    ok(false, 'a 404 (no redirect) rejects with the request URL in the message', 'resolved instead of rejecting');
  } catch (e) {
    const msg = String((e && e.message) || e);
    ok(/http_404/.test(msg) && msg.includes(String(port)), 'a 404 (no redirect) rejects with the request URL in the message', msg);
  }

  // Regression (T-31 8b part 2 fix round): in DEFAULT mode (workerData has no egress rule, i.e. Electron) a
  // redirect to a scheme the transport rejects (ftp://) must REJECT and settle, not become an unhandled rejection.
  // Before the fix, mod.get() threw synchronously inside `.then(onMod, onErr)`'s success handler, which the
  // rejection handler could not catch, so the download promise never settled.
  let timer;
  const outcome = await Promise.race([
    download(`http://127.0.0.1:${port}/to-ftp`, path.join(tmp, 'ftp'), () => {})
      .then(() => ({ resolved: true }), (error) => ({ error })),
    new Promise((r) => { timer = setTimeout(() => r({ hung: true }), 2000); }),
  ]);
  clearTimeout(timer);
  ok(!outcome.hung && outcome.error && /ERR_INVALID_PROTOCOL|ftp/i.test(String(outcome.error.message)),
    'default mode: a redirect to ftp:// rejects (settles within 2 s), not an unhandled rejection',
    outcome.hung ? 'did not settle within 2 s' : String(outcome.error && outcome.error.message));

  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(`check:kokoro-download-redirect ${fail === 0 ? 'PASS' : 'FAIL'} — ${pass}/${pass + fail} assertions passed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(2); });
