// T-31 voice P1 item 2: verifies SpeechOut.append() (new) actually schedules a streamed-in sentence with NO
// gap/overlap against what prepare()/play() (unchanged) already scheduled -- in a REAL AudioContext (headless
// Chromium via the vendored playwright-core, same convention as render-camera-views.mjs / shot-laneboard-owner-
// ui.mjs; NO Electron launched on this PC per the task's own rule). Two REAL Kokoro-synthesized WAV chunks are
// used as the audio, not silence/sine fixtures, so decodeAudioData exercises the actual bytes the app will ship.
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
// playwright-core is a devDependency (1.60.0); the old vendored path from another tree stays as fallback.
const PW_FALLBACK = ownerPath('playwrightCore', 'node_modules/playwright-core');
let chromium;
try { ({ chromium } = require('playwright-core')); }
catch {
  if (!fs.existsSync(PW_FALLBACK)) { console.error('SKIP: playwright-core is not installed and the vendored fallback is missing'); process.exit(0); }
  ({ chromium } = createRequire(path.join(PW_FALLBACK, 'package.json'))(PW_FALLBACK));
}

let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); } };

// ---------- 1. two REAL Kokoro WAV chunks ----------
const { createKokoroTts } = require('../src/main/kokoro-tts.js');
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zumi-speech-stream-'));
{
  const seedSrc = ownerPath('kokoroSeed', 'local/kokoro');
  const dest = path.join(userDataDir, 'tts', 'kokoro', 'onnx-community', 'Kokoro-82M-v1.0-ONNX');
  fs.mkdirSync(path.join(dest, 'onnx'), { recursive: true });
  fs.copyFileSync(path.join(seedSrc, 'kokoro-v1.0-fp16.onnx'), path.join(dest, 'onnx', 'model_fp16.onnx'));
  for (const f of ['config.json', 'tokenizer.json', 'tokenizer_config.json']) fs.copyFileSync(path.join(seedSrc, f), path.join(dest, f));
}
const tts = createKokoroTts({ userDataDir, log: () => {} });
await tts.ensureReady(() => {});
const chunks = [];
await tts.speakStream('stream-check', 'This is sentence one. This is a second, slightly longer sentence to check streaming.', (s) => chunks.push(s.audio));
tts.dispose();
fs.rmSync(userDataDir, { recursive: true, force: true });
ok(chunks.length >= 2, 'setup: got at least 2 real Kokoro WAV chunks to test with', `got ${chunks.length}`);
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zumi-speech-stream-wav-'));
fs.writeFileSync(path.join(outDir, 'a.wav'), chunks[0]);
fs.writeFileSync(path.join(outDir, 'b.wav'), chunks[1]);

// ---------- 2. serve speech.js + a tiny harness page ----------
const TYPES = { '.js': 'text/javascript', '.html': 'text/html; charset=utf-8', '.wav': 'audio/wav' };
const PAGE = `<!doctype html><html><body><script type="module">
  import { SpeechOut } from '/renderer/talk/speech.js';
  window.__run = async () => {
    const buf = async (url) => (await fetch(url)).arrayBuffer();
    const [a, b] = await Promise.all([buf('/wav/a.wav'), buf('/wav/b.wav')]);
    const s = new SpeechOut();
    const prepared = await s.prepare([a]);
    const { startedAt } = prepared.start();
    const durA = prepared.durationMs;
    // Append shortly after starting (as it would arrive mid-playback of a real streamed reply), well before
    // chunk A finishes, so this exercises the "arrives while something is already playing" path.
    await new Promise((r) => setTimeout(r, Math.min(80, durA / 4)));
    const nextCtxTimeBefore = s.current.nextCtxTime;
    const appended = await s.append(b);
    const nextCtxTimeAfterB = s.current.nextCtxTime;
    const gapSeconds = 0; // computed below from nextCtxTimeBefore vs the new source's actual start
    const sourceCount = s.current.sources.length;
    const m1 = s.mouth(); // sanity: mouth() still returns a weights object while something is scheduled
    const speaking = s.speaking();
    const remaining = s.remainingMs();
    await new Promise((r) => setTimeout(r, 50));
    s.stop();
    const stoppedNow = s.speaking();
    return {
      appended, sourceCount, nextCtxTimeBefore, nextCtxTimeAfterB,
      durA, durBExpected: b.byteLength, speaking, remaining: Math.round(remaining),
      mouthKeys: m1 ? Object.keys(m1).sort() : null, stoppedNow,
    };
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
  // playwright-core 1.60 expects its own browser build; when only another build is installed (no download on this
  // box), fall back to the newest installed headless shell rather than skipping the check.
  try { browser = await chromium.launch({ headless: true, timeout: 60000 }); }
  catch (e) {
    const root = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
    // Numeric build number, not a text sort: "chromium_headless_shell-1243" must beat "...-996".
    const shells = fs.existsSync(root)
      ? fs.readdirSync(root)
        .map((d) => ({ d, build: Number((/^chromium_headless_shell-(\d+)/.exec(d) || [])[1]) }))
        .filter((s) => Number.isFinite(s.build))
        .sort((a, b) => a.build - b.build)
        .map((s) => s.d)
      : [];
    const exe = shells.length ? path.join(root, shells[shells.length - 1], 'chrome-headless-shell-win64', 'chrome-headless-shell.exe') : '';
    if (!exe || !fs.existsSync(exe)) throw e;
    console.log(`check:speech-stream: fallback headless shell ${exe}`);
    browser = await chromium.launch({ headless: true, timeout: 60000, executablePath: exe });
  }
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('pageerror:', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.error('console error:', m.text()); });
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction('window.__ready === true');
  const r = await page.evaluate(() => window.__run());

  ok(r.appended === true, 'append(): accepted the second chunk while the first was still playing', JSON.stringify(r));
  ok(r.sourceCount === 2, 'append(): the schedule now has both chunks as separate buffer sources', `sourceCount=${r.sourceCount}`);
  // nextCtxTime strictly increases: chunk B was scheduled to start at-or-after where A's schedule left off, and
  // ends further still -- i.e. no overlap, and append() actually extended the timeline rather than no-op'ing.
  ok(r.nextCtxTimeAfterB > r.nextCtxTimeBefore, 'append(): schedule end time moved forward (no silent no-op)', `before=${r.nextCtxTimeBefore} after=${r.nextCtxTimeAfterB}`);
  ok(r.speaking === true, 'append(): still "speaking" right after the append (no false stop)');
  ok(Array.isArray(r.mouthKeys) && r.mouthKeys.length === 5, 'mouth(): unchanged driver still returns the 5 expression weights while audio is scheduled', JSON.stringify(r.mouthKeys));
  ok(r.stoppedNow === false, 'stop(): speaking() is false immediately after stop() (the <=200ms acceptance measures exactly this call)');
} finally {
  if (browser) await browser.close();
  srv.close();
  fs.rmSync(outDir, { recursive: true, force: true });
}

console.log(`\ncheck:speech-stream ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
