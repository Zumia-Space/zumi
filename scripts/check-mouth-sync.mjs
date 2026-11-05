// T-31 voice P1 live-E2E fix 2 acceptance measurement: mouth/audio sync, reproducing the live spare-PC E2E's own
// method (tap-dump.json: rAF-sampled analyser reading vs. the audio node's own scheduled start time) headlessly,
// on REAL Kokoro-synthesized WAV bytes decoded through the actual shipped speech.js -- not a sine/silence
// fixture. The live run found 0/20 within the <=100ms gate (a consistent 110-155ms lag, traced to leading
// near-silence baked into Kokoro's rendered audio); this checks the fix (kokoro-worker.mjs's
// trimLeadingSilence(), see P1-REPORT.md "Live E2E on the spare PC" / this task's fix 2) against the SAME
// mouth() driver code the app ships, not a reimplementation of the RMS math.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { ownerPath } from './lib/owner-paths.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const PW_SOURCE = ownerPath('playwrightCore', 'node_modules/playwright-core');
if (!fs.existsSync(PW_SOURCE)) { console.error(`SKIP: no vendored playwright-core at ${PW_SOURCE}`); process.exit(0); }
const { chromium } = createRequire(path.join(PW_SOURCE, 'package.json'))(PW_SOURCE);

let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); } };

// ---------- 1. real Kokoro WAV chunks, varied short/long, mirroring the live E2E's 20-line mix ----------
const { createKokoroTts } = require('../src/main/kokoro-tts.js');
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zumi-mouth-sync-'));
{
  const seedSrc = ownerPath('kokoroSeed', 'local/kokoro');
  const dest = path.join(userDataDir, 'tts', 'kokoro', 'onnx-community', 'Kokoro-82M-v1.0-ONNX');
  fs.mkdirSync(path.join(dest, 'onnx'), { recursive: true });
  fs.copyFileSync(path.join(seedSrc, 'kokoro-v1.0-fp16.onnx'), path.join(dest, 'onnx', 'model_fp16.onnx'));
  for (const f of ['config.json', 'tokenizer.json', 'tokenizer_config.json']) fs.copyFileSync(path.join(seedSrc, f), path.join(dest, f));
}
const tts = createKokoroTts({ userDataDir, log: () => {} });
await tts.ensureReady(() => {});
const SENTENCES = [
  'Got it.', 'Done. The build is green.', 'No open blockers right now.',
  'Here is a short summary of what changed since yesterday.',
  'I found three tasks waiting on your review this afternoon.',
  'The test suite passed: forty two green, zero red, one skipped.',
  'Let me know if you want the long version or the short one.',
  'The database migration ran cleanly on staging with no locked rows.',
  'Everything is backed up and the branch is clean.',
  'Three gestures played during the last test run, as expected.',
];
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zumi-mouth-sync-wav-'));
const files = [];
for (let i = 0; i < SENTENCES.length; i++) {
  const turnId = crypto.randomBytes(8).toString('hex');
  const chunks = [];
  await tts.speakStream(turnId, SENTENCES[i], (s) => chunks.push(s.audio));
  const name = `s${i}.wav`;
  fs.writeFileSync(path.join(outDir, name), chunks[0]); // chunk 0 only: the first-audio onset is what the gate measures
  files.push(name);
}
tts.dispose();
fs.rmSync(userDataDir, { recursive: true, force: true });
ok(files.length === SENTENCES.length, 'setup: got one real Kokoro WAV chunk per sentence', `got ${files.length}`);

// ---------- 2. serve speech.js + a tiny harness page ----------
const TYPES = { '.js': 'text/javascript', '.html': 'text/html; charset=utf-8', '.wav': 'audio/wav' };
const PAGE = `<!doctype html><html><body><script type="module">
  import { SpeechOut } from '/renderer/talk/speech.js';
  // Same shape as the live E2E's tap-dump.json: for each clip, play it, rAF-sample the REAL mouth() driver
  // (not a reimplementation), and record the first frame it reports non-silent -- against the clip's own
  // scheduled start time (prepared.start().startedAt), exactly what tap-dump.json compared against.
  window.__run = async (urls) => {
    const s = new SpeechOut();
    await s.warmup(); // mirrors index.js's createTalk(), which warms the AudioContext before the first real turn
    const results = [];
    for (const url of urls) {
      const buf = await (await fetch(url)).arrayBuffer();
      const prepared = await s.prepare([buf]);
      const { startedAt } = prepared.start();
      let onsetAt = null;
      const deadline = startedAt + prepared.durationMs + 300;
      await new Promise((resolve) => {
        const frame = () => {
          const now = performance.now();
          const m = s.mouth();
          if (onsetAt === null && m && Object.values(m).some((v) => v > 0.02)) onsetAt = now;
          if (onsetAt !== null || now > deadline) return resolve();
          requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      });
      results.push({ url, startedAt, onsetAt, lagMs: onsetAt !== null ? +(onsetAt - startedAt).toFixed(1) : null, durationMs: prepared.durationMs });
      s.stop();
      await new Promise((r) => setTimeout(r, 30)); // let the analyser fully settle before the next clip
    }
    return results;
  };
  window.__ready = true;
</script></body></html>`;
const srv = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/') { res.writeHead(200, { 'content-type': TYPES['.html'] }); return res.end(PAGE); }
  if (url.startsWith('/renderer/')) {
    const file = path.join(ROOT, 'src', url);
    return fs.readFile(file, (e, data) => { if (e) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'content-type': TYPES['.js'] }); res.end(data); });
  }
  if (url.startsWith('/wav/')) {
    const file = path.join(outDir, url.slice('/wav/'.length));
    return fs.readFile(file, (e, data) => { if (e) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'content-type': TYPES['.wav'] }); res.end(data); });
  }
  res.writeHead(404); res.end();
}).listen(0, '127.0.0.1');
await new Promise((r) => srv.once('listening', r));
const port = srv.address().port;

// ---------- 3. drive it in headless Chromium ----------
let browser;
try {
  browser = await chromium.launch({ headless: true, timeout: 60000 });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('pageerror:', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.error('console error:', m.text()); });
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction('window.__ready === true');
  const urls = files.map((f) => `/wav/${f}`);
  const results = await page.evaluate((u) => window.__run(u), urls);

  for (const r of results) console.log(`  ${r.url} lagMs=${r.lagMs} durationMs=${Math.round(r.durationMs)}`);
  const withOnset = results.filter((r) => r.onsetAt !== null);
  ok(withOnset.length === results.length, 'mouth(): every clip reached a non-silent frame before its deadline', `${withOnset.length}/${results.length}`);
  const within100 = results.filter((r) => r.lagMs !== null && r.lagMs <= 100).length;
  const pct = results.length ? (100 * within100) / results.length : 0;
  console.log(`\nmouth/audio sync: ${within100}/${results.length} within 100ms (${pct.toFixed(0)}%), gate >=95%`);
  ok(pct >= 95, 'mouth/audio sync: >=95% of clips within the <=100ms onset-vs-scheduled-start gate', `${pct.toFixed(0)}%`);
} finally {
  if (browser) await browser.close();
  srv.close();
  fs.rmSync(outDir, { recursive: true, force: true });
}

console.log(`\ncheck:mouth-sync ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
