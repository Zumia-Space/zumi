// T-31 parity 8b part 2: the Kokoro download's egress rule is ENFORCED per hop. Runs the real createKokoroTts and the
// real kokoro-worker.mjs (workerData.egress = 'hf-only', exactly what the sidecar passes) against a stubbed transport:
// no network, no model weights (the download fails or is refused before kokoro-js is ever loaded).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { createKokoroTts } = require('../src/main/kokoro-tts.js');
const WORKER = path.join(here, '..', 'src', 'main', 'kokoro-worker.mjs');

let pass = 0, fail = 0;
const ok = (c, n, d = '') => { if (c) { pass++; console.log(`PASS ${n}`); } else { fail++; console.log(`FAIL ${n} ${d}`); } };

// Stub transport module: scripted responses keyed by URL. Each hop is recorded to a log file the test reads back.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zumi-kokoro-egress-'));
const logFile = path.join(tmp, 'hops.log');
const stub = path.join(tmp, 'stub-transport.mjs');
fs.writeFileSync(stub, `
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
const MAP = JSON.parse(process.env.KOKORO_STUB_MAP || '{}');
export function get(url, _opts, cb) {
  fs.appendFileSync(${JSON.stringify(logFile)}, url + String.fromCharCode(10));
  const r = MAP[url] || { status: 404 };
  const res = Readable.from([Buffer.from('not-the-pinned-bytes')]);
  res.statusCode = r.status; res.headers = r.location ? { location: r.location } : { 'content-length': '20' };
  const req = new EventEmitter();
  setImmediate(() => cb(res));
  return req;
}
`);

async function run(map) {
  fs.writeFileSync(logFile, '');
  process.env.KOKORO_STUB_MAP = JSON.stringify(map); // worker threads inherit the env at spawn
  const k = createKokoroTts({
    userDataDir: fs.mkdtempSync(path.join(tmp, 'ud-')),
    workerFactory: () => new Worker(WORKER, { workerData: { egress: 'hf-only', egressTransportModule: pathToFileURL(stub).href } }),
  });
  const timeout = new Promise((r) => setTimeout(() => r({ hung: true }), 15000));
  const res = await Promise.race([k.ensureReady().then(() => ({ resolved: true }), (e) => ({ error: e })), timeout]);
  k.dispose && k.dispose();
  return { res, hops: fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean) };
}

const FIRST = 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model_fp16.onnx';

{ // 1. allowed chain: huggingface.co -> us.aws.cdn.hf.co; followed, ends at the sha256 pin (stub bytes), not at egress
  const cdn = 'https://us.aws.cdn.hf.co/xet-bridge-us/abc/model_fp16.onnx';
  const { res, hops } = await run({ [FIRST]: { status: 302, location: cdn }, [cdn]: { status: 200 } });
  ok(hops.length === 2 && hops[1] === cdn, 'an allowed redirect chain (huggingface.co -> us.aws.cdn.hf.co) is followed', hops.join(' | '));
  ok(res.error && /sha256_mismatch/.test(res.error.message) && !/egress_refused/.test(res.error.message), 'the followed chain reaches the sha256 pin check (not an egress refusal)', res.error && res.error.message);
}
{ // 2. off-list host
  const evil = 'https://evil.example.com/model_fp16.onnx';
  const { res, hops } = await run({ [FIRST]: { status: 302, location: evil }, [evil]: { status: 200 } });
  ok(!res.hung && res.error && /egress_refused/.test(res.error.message), 'a redirect to an off-list host is refused with a typed egress_refused error', res.error && res.error.message);
  ok(!hops.includes(evil), 'the off-list host is never requested', hops.join(' | '));
  const lookalike = 'https://huggingface.co.evil.example/x';
  const r2 = await run({ [FIRST]: { status: 302, location: lookalike } });
  ok(r2.res.error && /egress_refused/.test(r2.res.error.message) && r2.hops.length === 1, 'a look-alike host (huggingface.co.evil.example) is refused', r2.hops.join(' | '));
}
{ // 3. https -> http downgrade
  const down = 'http://us.aws.cdn.hf.co/model_fp16.onnx';
  const { res, hops } = await run({ [FIRST]: { status: 302, location: down }, [down]: { status: 200 } });
  ok(res.error && /egress_refused/.test(res.error.message) && /non-https/.test(res.error.message) && !hops.includes(down), 'an https -> http downgrade is refused and never requested', res.error && res.error.message);
}
{ // 4. typed error, not a hang (checked on every refusal above via res.hung; asserted explicitly here)
  const { res } = await run({ [FIRST]: { status: 302, location: 'http://huggingface.co/x' } });
  ok(!res.hung && res.error instanceof Error && res.error.retryable === true, 'the refusal surfaces as a typed Error (retryable flag set), not a hang');
  ok(res.error && /egress_refused/.test(res.error.message), 'the refusal is the typed egress_refused, not a different failure (hop check really ran)', res.error && res.error.message);
}

if (!process.env.KEEP) fs.rmSync(tmp, { recursive: true, force: true }); else console.log(tmp);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
