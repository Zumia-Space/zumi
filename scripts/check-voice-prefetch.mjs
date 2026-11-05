// T-31 QC-cuoi fix d (09-10): the Kokoro voice prefetches at app start (background, sha-pinned download in
// kokoro-worker.mjs, unchanged), with observable state for Settings > Voice; an EN reply that arrives while the
// prefetch is still running is spoken with the Windows voice (SAPI) at once instead of waiting, and the router logs
// which engine was used. Red on 17382db: there was no prefetch()/status(), no tts-router.js, and main.js awaited
// ensureReady() (the whole download) inside talk:tts. No Electron, no real worker, no network: a fake worker drives
// the same message protocol kokoro-worker.mjs speaks.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const done = () => { console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); };

const { createKokoroTts } = require('../src/main/kokoro-tts.js');
let createEnTtsRouter = null;
try { ({ createEnTtsRouter } = require('../src/main/tts-router.js')); } catch (e) { ok(false, 'tts-router.js exists (EN routing without waiting on the download)', String(e.message).slice(0, 120)); }

// Fake worker: 'ensure' -> progress for the model file, then 'ready' only when the test releases it (or an error).
function fakeWorkerFactory(ctl) {
  return () => {
    const w = new EventEmitter();
    w.postMessage = (msg) => setImmediate(() => {
      if (msg.cmd === 'ensure') {
        ctl.ensures++;
        w.emit('message', { type: 'progress', phase: 'onnx/model_fp16.onnx', loaded: 40, total: 160 });
        ctl.release = (how = 'ready') => w.emit('message', how === 'ready' ? { type: 'ready' } : { type: 'ensureError', message: 'kokoro download failed for onnx/model_fp16.onnx (offline)', retryable: true });
      } else if (msg.cmd === 'speak') {
        ctl.speaks.push(msg.turnId);
        w.emit('message', { type: 'sentence', turnId: msg.turnId, index: 0, text: msg.text, wav: new ArrayBuffer(44), synthEndedAt: Date.now() });
        w.emit('message', { type: 'done', turnId: msg.turnId });
      }
    });
    w.terminate = () => {};
    return w;
  };
}
const fakeSapi = () => { const s = { calls: 0, available: () => true, speak: async (p) => { s.calls++; return { mime: 'audio/wav', audios: [Buffer.alloc(44)], voice: 'Microsoft Zira Desktop' }; } }; return s; };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-prefetch-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });
const TURN = (n) => String(n).repeat(32).slice(0, 32);

// ---------- 1. prefetch: state is observable while downloading, ready afterwards ----------
const ctl = { ensures: 0, speaks: [], release: null };
const logs = [];
const kk = createKokoroTts({ userDataDir: tmp, log: (m) => logs.push(m), workerFactory: fakeWorkerFactory(ctl) });
if (typeof kk.prefetch !== 'function' || typeof kk.status !== 'function' || typeof kk.isReady !== 'function') {
  ok(false, 'kokoro-tts exposes prefetch()/status()/isReady()');
  done();
}
ok(kk.available(), 'kokoro-js resolves in this tree (dev node_modules)');
const progress = [];
const pre = kk.prefetch((p) => progress.push(p));
await sleep(20);
ok(ctl.ensures === 1, 'prefetch starts the download/verify (one ensure) without any reply asking for it');
ok(kk.status().state === 'downloading' && kk.status().total === 160 && !kk.isReady(), 'status: downloading with progress while the model file is fetched', JSON.stringify(kk.status()));
ok(progress.length >= 1 && progress[0].phase === 'onnx/model_fp16.onnx', 'progress events reach the Settings callback');
ok(kk.prefetch() === pre, 'a second prefetch() joins the running one (no second download)');

// ---------- 2. a reply DURING the download: Windows voice right away, logged ----------
if (createEnTtsRouter) {
  const sapi = fakeSapi();
  const rlogs = [];
  const more = [];
  const router = createEnTtsRouter({ kokoro: kk, sapi, log: (m) => rlogs.push(m), onMore: (m) => more.push(m) });
  const t0 = Date.now();
  const r1 = await router.speak({ turnId: TURN(1), text: 'Hello there, how are you today?' });
  ok(r1.ok && r1.voice === 'Microsoft Zira Desktop' && sapi.calls === 1, 'reply during download: spoken with the Windows voice', JSON.stringify(r1).slice(0, 120));
  ok(Date.now() - t0 < 200, `reply during download: did not wait on the download (${Date.now() - t0} ms)`);
  ok(rlogs.some((l) => /engine=sapi reason=kokoro-downloading 25%/.test(l)), 'reply during download: logged engine=sapi with the reason', JSON.stringify(rlogs));
  ok(ctl.ensures === 1, 'reply during download: no second download started');

  ctl.release('ready');
  ok(await pre === true, 'prefetch resolves true once the pipeline is ready (plus its tiny warm-up synthesis)');
  ok(kk.isReady() && kk.status().state === 'ready', 'status: ready');
  ok(ctl.speaks.includes('__warmup__'), 'prefetch ran the tiny discarded warm-up synthesis');
  ok(logs.some((l) => /^prefetch done in \d+ms/.test(l)), 'prefetch logs when it is done');

  // ---------- 3. once ready: Kokoro, logged, Windows voice not touched ----------
  const r2 = await router.speak({ turnId: TURN(2), text: 'Sure, I can draft that.' });
  ok(r2.ok && r2.voice === 'af_heart' && sapi.calls === 1, 'reply after ready: spoken with Kokoro', JSON.stringify(r2).slice(0, 120));
  ok(rlogs.some((l) => new RegExp(`turn=${TURN(2).slice(0, 8)} engine=kokoro reason=ready`).test(l)), 'reply after ready: logged engine=kokoro');

  // ---------- 4. a failed prefetch: Windows voice, and the next reply retries the prefetch ----------
  const ctl2 = { ensures: 0, speaks: [], release: null };
  const kk2 = createKokoroTts({ userDataDir: tmp, log: () => {}, workerFactory: fakeWorkerFactory(ctl2) });
  const p2 = kk2.prefetch();
  await sleep(20);
  ctl2.release('error');
  ok(await p2 === false && kk2.status().state === 'error', 'a failed prefetch resolves false (never throws) and status says error', JSON.stringify(kk2.status()));
  const sapi2 = fakeSapi();
  const r2logs = [];
  const router2 = createEnTtsRouter({ kokoro: kk2, sapi: sapi2, log: (m) => r2logs.push(m) });
  const r3 = await router2.speak({ turnId: TURN(3), text: 'Hello.' });
  await sleep(20);
  ok(r3.ok && sapi2.calls === 1 && r2logs.some((l) => /engine=sapi reason=kokoro-error/.test(l)), 'after a failed prefetch: Windows voice, logged reason kokoro-error', JSON.stringify(r2logs));
  ok(ctl2.ensures === 2, 'after a failed prefetch: the reply kicked off a retry in the background', `ensures=${ctl2.ensures}`);
}

// ---------- 5. wiring: main.js prefetches at start and routes EN through the router ----------
const main = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.js'), 'utf8');
ok(/kokoroTts\.prefetch\(kokoroProgress\)/.test(main) && !/kokoroTts\.warmup\(\)/.test(main), 'main.js: prefetch at app start replaces the old warm-up-only call');
const core = fs.readFileSync(path.join(ROOT, 'src', 'main', 'talk-voice-core.mjs'), 'utf8');
ok(/e\.speak\(/.test(core) && /enTts: \(\) => enTts/.test(main) && !/await kokoroTts\.ensureReady\(/.test(main + core), 'talk-voice-core (extracted talk:tts) never awaits ensureReady() (the download) itself');
ok(/ipcMain\.handle\('talk:voiceState'/.test(main), 'main.js: talk:voiceState feeds the Settings > Voice progress row');
done();
