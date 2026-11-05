// T-31-TAURI R1: Kokoro loads on demand (first spoken reply, or a pre-warm), and unloads after an idle period.
// Evidence: R0a measured Kokoro ~385 MB of the sidecar's ~407 MB at 60 s, loaded at start though nobody spoke.
// No Electron, no real worker, no network: a fake worker speaks kokoro-worker.mjs's message protocol.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
// T-31 T1: L1 is the default load mode; these checks pin the start-time (eager) behaviour, so select it explicitly.
process.env.ZUMI_KOKORO_LOAD = 'eager';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, n, d = '') => { if (c) { pass++; console.log(`PASS ${n}`); } else { fail++; console.log(`FAIL ${n} ${d}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { createKokoroTts } = require('../src/main/kokoro-tts.js');
const { createEnTtsRouter } = require('../src/main/tts-router.js');
const { createVoiceHost, VOICE_IDLE_UNLOAD_MS } = await import('../tauri/sidecar/voice-host.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-lazy-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

// Fake worker: ensure -> ready after loadMs; speak -> one sentence + done. Counts spawns, terminations.
function fakeFactory(ctl, loadMs = 5) {
  return () => {
    ctl.spawns++;
    const w = new EventEmitter();
    (ctl.workers = ctl.workers || []).push(w);
    let dead = false;
    w.postMessage = (msg) => setTimeout(() => {
      if (dead) return;
      if (msg.cmd === 'ensure') { ctl.ensures++; setTimeout(() => !dead && w.emit('message', { type: 'ready' }), loadMs); }
      else if (msg.cmd === 'speak') {
        ctl.speaks.push(msg.turnId);
        w.emit('message', { type: 'sentence', turnId: msg.turnId, index: 0, text: msg.text, wav: new ArrayBuffer(44), synthEndedAt: Date.now() });
        w.emit('message', { type: 'done', turnId: msg.turnId });
      }
    }, 1);
    w.terminate = () => { dead = true; ctl.terminated++; };
    return w;
  };
}
const newCtl = () => ({ spawns: 0, ensures: 0, speaks: [], terminated: 0, logs: [] });
const mk = (ctl, extra = {}) => createKokoroTts({ userDataDir: tmp, log: (m) => ctl.logs.push(m), workerFactory: fakeFactory(ctl), ...extra });
const hostWith = (fake, settings = {}, extra = {}) => createVoiceHost({ ...extra, dataDir: tmp, settings: () => settings, saveSettings: () => {}, secretStores: async () => ({}), flavour: { values: {} }, ttsFetchFor: () => null, emit: () => true, kokoroFactory: () => fake, localTtsFactory: () => ({ available: () => false }), log: () => {} });

// 1. nothing loads at start; typing pre-warms.
{
  const calls = { prefetch: 0 };
  const fake = { available: () => true, isReady: () => false, status: () => ({ state: 'idle' }), info: () => ({}), speed: () => 1, setSpeed() {}, prefetch() { calls.prefetch++; return Promise.resolve(true); }, abandon() {}, dispose() {} };
  const host = hostWith(fake);
  ok(calls.prefetch === 1, 'voice on (default settings): prefetch at host construction, like before R1');
  ok(typeof host.prewarm === 'function', 'host exposes prewarm() for the typing trigger');
  if (typeof host.prewarm === 'function') host.prewarm('typing');
  ok(calls.prefetch >= 1, 'prewarm after the start load is idempotent / never double-loads here (fake stays idle, debounced)');
  const offCalls = { n: 0 };
  const offHost = hostWith({ ...fake, prefetch() { offCalls.n++; return Promise.resolve(true); } }, { voiceEnabled: false });
  if (typeof offHost.prewarm === 'function') offHost.prewarm('typing');
  ok(offCalls.n === 0, 'voice off in settings: typing does not pre-warm');
  // talk.voiceWarm: no args, idempotent, debounced (one warm per idle period).
  const wc = { n: 0, ready: false };
  const warmFake = { ...fake, isReady: () => wc.ready, status: () => ({ state: wc.n > 0 ? 'loading' : 'idle' }), prefetch() { wc.n++; return Promise.resolve(true); } };
  const wh = hostWith(warmFake, {}, { prefetch: false });
  ok(typeof wh.handlers['talk.voiceWarm'] === 'function', 'handler talk.voiceWarm exists');
  if (wh.handlers['talk.voiceWarm']) { wh.handlers['talk.voiceWarm'](); wh.handlers['talk.voiceWarm'](); wh.handlers['talk.voiceWarm'](); }
  ok(wc.n === 1, 'talk.voiceWarm x3 = one warm (debounced)', String(wc.n));
  wc.ready = true;
  if (wh.handlers['talk.voiceWarm']) wh.handlers['talk.voiceWarm']();
  ok(wc.n === 1, 'talk.voiceWarm when already ready is a no-op');
  const inv = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/migration/api-inventory.json'), 'utf8'));
  const e = inv.apis.find((a) => a.name === 'talk.voiceWarm');
  ok(e && e.kind === 'invoke' && e.args.length <= 1 && !e.guestOnly, 'inventory lists talk.voiceWarm: invoke, no args, not guest-only');
  ok(/talk\.voiceWarm/.test(fs.readFileSync(path.join(ROOT, 'tauri/src-tauri/src/rpc_allow_list.rs'), 'utf8')), 'generated allow-list contains talk.voiceWarm');
  const appJs = fs.readFileSync(path.join(ROOT, 'src/renderer/app.js'), 'utf8');
  ok(/\$\('msg'\)\.addEventListener\('input'.*voiceWarm/.test(appJs), 'renderer calls voiceWarm on the chat input (first keystroke after idle)');
  ok(VOICE_IDLE_UNLOAD_MS === 10 * 60 * 1000, 'idle-unload default is the named constant, 10 min', String(VOICE_IDLE_UNLOAD_MS));
}

// 1b. voice ON loads at start; voice OFF never loads; toggling.
{
  const mkFake = () => { const c = { prefetch: 0, unload: 0 }; let ready = false; return { c, k: { available: () => true, isReady: () => ready, status: () => ({ state: ready ? 'ready' : 'idle' }), info: () => ({}), speed: () => 1, setSpeed() {}, prefetch() { c.prefetch++; ready = true; return Promise.resolve(true); }, unload() { c.unload++; ready = false; }, abandon() {}, dispose() {} } }; };
  const a = mkFake();
  hostWith(a.k, { voiceEnabled: true });
  ok(a.c.prefetch === 1, 'voice ON: Kokoro prefetches at sidecar start (as before R1)');
  const off = mkFake(); const sOff = { voiceEnabled: false };
  const ho = hostWith(off.k, sOff);
  ho.handlers['talk.voiceWarm'](); ho.handlers['talk.voiceWarm']('typing'); ho.prewarm('x');
  ok(off.c.prefetch === 0, 'voice OFF: no load at start, no typing pre-warm, nothing');
  sOff.voiceEnabled = true; ho.onVoiceEnabled(true);
  ok(off.c.prefetch === 1, 'turning voice ON later loads at once');
  sOff.voiceEnabled = false; ho.onVoiceEnabled(false);
  ok(off.c.unload === 1, 'turning voice OFF while loaded unloads');
  // typing pre-warm after an unload (the idle unload path)
  const idle = mkFake();
  const hi = hostWith(idle.k, { voiceEnabled: true });
  idle.k.unload(); // what the idle timer does
  hi.handlers['talk.voiceWarm']('typing');
  ok(idle.c.prefetch === 2, 'typing pre-warm reloads after an unload');
  const mainSrc = fs.readFileSync(path.join(ROOT, 'tauri/sidecar/main.mjs'), 'utf8');
  ok(/'talk\.setVoiceEnabled'.*onVoiceEnabled/.test(mainSrc), 'sidecar wires setVoiceEnabled to onVoiceEnabled');
  const appJs2 = fs.readFileSync(path.join(ROOT, 'src/renderer/app.js'), 'utf8');
  ok(!/first-frame/.test(appJs2) && !/VOICE_DEFERRED_LOAD_MS/.test(fs.readFileSync(path.join(ROOT, 'tauri/sidecar/voice-host.mjs'), 'utf8')), 'the first-frame deferred load is removed');
}
// 1c. an unspoken load still unloads after the idle window (timer armed at load-end)
{
  const ctl = newCtl();
  const kk = mk(ctl, { idleUnloadMs: 50 });
  await kk.ensureReady();
  await sleep(120);
  ok(ctl.terminated === 1 && kk.status().state === 'idle', 'an unspoken load unloads after the idle window');
  kk.dispose();
}

// 2-4. first speak loads; reply not lost while loading; idle unloads; speak after unload reloads.
{
  const ctl = newCtl();
  const kk = mk(ctl, { idleUnloadMs: 60 });
  ok(ctl.spawns === 0 && kk.status().state === 'idle', 'constructor: no worker, state idle');
  const sapiCalls = [];
  const sapi = { available: () => true, speak: async (p) => { sapiCalls.push(p.text); return { mime: 'audio/wav', audios: [Buffer.alloc(44)], voice: 'sapi' }; } };
  const router = createEnTtsRouter({ kokoro: kk, sapi, log: () => {}, kokoroOnly: true });
  const r1 = await router.speak({ turnId: '1'.repeat(32), text: 'Hello there.' });
  ok(r1.ok === true && r1.voice === 'af_heart' && sapiCalls.length === 0, 'first reply waits for the load and plays with Kokoro (same voice), no SAPI call');
  ok(ctl.logs.findIndex((l) => /event=first-audio/.test(l)) > ctl.logs.findIndex((l) => /event=load-end/.test(l)) && ctl.logs.some((l) => /event=load-end/.test(l)), 'the reply audio arrives after load-end (queued, not dropped)');
  await sleep(10);
  ok(ctl.spawns === 1 && ctl.ensures === 1, 'the first spoken reply triggered the load');
  ok(kk.isReady(), 'Kokoro is ready after the load');
  const r2 = await router.speak({ turnId: '2'.repeat(32), text: 'Again.' });
  ok(r2.ok === true && r2.voice === 'af_heart', 'reply after load uses Kokoro');
  ok(ctl.logs.some((l) => /\[voice-measure\] event=load-start ts=\d{4}-/.test(l)) && ctl.logs.some((l) => /\[voice-measure\] event=load-end ts=\d{4}-.* loadMs=\d+/.test(l)), 'measurement: load-start / load-end lines with timestamps');
  ok(ctl.logs.some((l) => /\[voice-measure\] event=first-audio ts=\d{4}-.* sinceRequestMs=\d+/.test(l)), 'measurement: first-audio line with latency');

  await sleep(120);
  ok(ctl.terminated === 1 && kk.status().state === 'idle' && !kk.isReady(), 'idle past the threshold unloads (worker terminated, state idle)');
  ok(ctl.logs.some((l) => /\[voice-measure\] event=unload /.test(l)), 'measurement: unload line');

  const r3 = await router.speak({ turnId: '3'.repeat(32), text: 'After unload.' });
  ok(r3.ok === true && r3.voice === 'af_heart' && sapiCalls.length === 0, 'speech after unload waits for the reload and plays with Kokoro (not lost, no SAPI)');
  await sleep(10);
  ok(ctl.spawns === 2 && ctl.ensures === 2, 'speaking after unload reloads Kokoro');
  ok(kk.isReady(), 'ready again after the reload');
  kk.dispose();
}

// 5. activity keeps it loaded; 0 disables.
{
  const ctl = newCtl();
  const kk = mk(ctl, { idleUnloadMs: 80 });
  await kk.ensureReady();
  for (let i = 0; i < 4; i++) { await sleep(40); await kk.speakStream(`t${i}`, 'Hi there.', () => {}); }
  ok(ctl.terminated === 0, 'speech every 40 ms keeps an 80 ms idle window from unloading');
  kk.dispose();
  const ctl2 = newCtl();
  const kk2 = mk(ctl2, { idleUnloadMs: 0 });
  await kk2.ensureReady(); await sleep(60);
  ok(ctl2.terminated === 0, 'idleUnloadMs=0 (Electron default) never unloads');
  kk2.dispose();
}

// 7. B1: voice OFF (unload) mid-load settles a waiting reply at once with voice_off; no hang, no audio.
{
  const ctl = newCtl();
  const kk = createKokoroTts({ userDataDir: tmp, log: () => {}, workerFactory: fakeFactory(ctl, 300) });
  const router = createEnTtsRouter({ kokoro: kk, sapi: null, log: () => {}, kokoroOnly: true });
  const t0 = Date.now();
  const p = router.speak({ turnId: 'b'.repeat(32), text: 'Waiting reply.' });
  await sleep(30);
  kk.unload();
  const r = await Promise.race([p, sleep(1000).then(() => 'HANG')]);
  ok(r !== 'HANG' && r.ok === false && r.error && r.error.code === 'voice_off' && Date.now() - t0 < 500, 'B1: unload mid-load ends the waiting reply at once with voice_off', JSON.stringify(r));
  ok(ctl.speaks.length === 0, 'B1: no audio was synthesized for it');
  kk.dispose();
}

// 8. B2: a worker crash clears the cached state so the next prefetch reloads; reloads are throttled after a crash.
{
  const ctl = newCtl();
  const kk = createKokoroTts({ userDataDir: tmp, log: () => {}, workerFactory: fakeFactory(ctl, 5), reloadThrottleMs: 250 });
  ok(await kk.prefetch() === true && ctl.spawns === 1, 'B2: initial load');
  ctl.workers[0].emit('error', new Error('boom'));
  ok(kk.status().state === 'error' && !kk.isReady(), 'B2: crash puts state in error');
  ok(await kk.prefetch() === true && ctl.spawns === 2 && kk.isReady(), 'B2: the next prefetch reloads after a crash (cached promise cleared)');
  ctl.workers[1].emit('error', new Error('boom2'));
  ok(await kk.prefetch() === false && ctl.spawns === 2, 'B2: a second reload attempt inside the throttle window is refused', String(ctl.spawns));
  await sleep(280);
  ok(await kk.prefetch() === true && ctl.spawns === 3, 'B2: after the window one reload attempt is allowed again');
  kk.dispose();
}

// 9. S1: the wait for a load is capped; explicit kokoro_loading, the load continues in the background.
{
  const ctl = newCtl();
  const kk = createKokoroTts({ userDataDir: tmp, log: () => {}, workerFactory: fakeFactory(ctl, 300) });
  const router = createEnTtsRouter({ kokoro: kk, sapi: null, log: () => {}, kokoroOnly: true, loadWaitMs: 60 });
  const t0 = Date.now();
  const r = await router.speak({ turnId: 'c'.repeat(32), text: 'Slow load.' });
  ok(r.ok === false && r.error.code === 'kokoro_loading' && r.error.retryable === true && Date.now() - t0 < 250, 'S1: capped wait answers kokoro_loading (retryable) before the load ends', JSON.stringify(r));
  await sleep(320);
  ok(kk.isReady(), 'S1: the load kept going in the background');
  kk.dispose();
  const hostSrc = fs.readFileSync(path.join(ROOT, 'tauri/sidecar/voice-host.mjs'), 'utf8');
  ok(/VOICE_LOAD_WAIT_MS = 60 \* 1000/.test(hostSrc), 'S1: the host cap is the named constant, 60 s');
  const rs = fs.readFileSync(path.join(ROOT, 'tauri/src-tauri/src/lib.rs'), 'utf8');
  ok(/"talk\.tts" => TALK_TTS_TIMEOUT/.test(rs), 'S1: the host rpc timeout for talk.tts outlives the 60 s cap');
}

// 10. S2: voice OFF: scheduled lines (live sayId) and Test voice never load Kokoro.
{
  const c = { prefetch: 0 };
  const fake = { available: () => true, isReady: () => false, status: () => ({ state: 'idle' }), info: () => ({}), speed: () => 1, setSpeed() {}, prefetch() { c.prefetch++; return Promise.resolve(true); }, unload() {}, speakStream: () => Promise.resolve(), abandon() {}, dispose() {} };
  const host = createVoiceHost({ dataDir: tmp, settings: () => ({ voiceEnabled: false }), saveSettings: () => {}, secretStores: async () => ({}), flavour: { values: {} }, ttsFetchFor: () => null, emit: () => true, isLiveSay: () => true, prefetch: false, kokoroFactory: () => fake, localTtsFactory: () => ({ available: () => false }), log: () => {} });
  const r = await host.handlers['talk.tts']({ text: 'A scheduled line', sayId: 'live-1', turnId: 'd'.repeat(32) });
  ok(c.prefetch === 0 && r.ok === true && r.reason === 'voice-off', 'S2: voice off: a scheduled line stays text-only, Kokoro not loaded', JSON.stringify(r));
  const t = await host.handlers['talk.testVoice']({ lang: 'en', text: 'Hello' });
  ok(c.prefetch === 0 && t.ok === false && t.reason === 'voice-off', 'S2: voice off: Test voice answers voice-off, Kokoro not loaded', JSON.stringify(t));
  const vp = fs.readFileSync(path.join(ROOT, 'src/renderer/voice-providers.js'), 'utf8');
  const i18n = fs.readFileSync(path.join(ROOT, 'src/renderer/i18n.js'), 'utf8');
  ok(/'voice-off': 'settings\.testErr\.voiceOff'/.test(vp) && (i18n.match(/'settings\.testErr\.voiceOff':/g) || []).length === 3, 'S2: the voice-off message exists in en, vi and zh');
}

// 11. B3: Electron main/preload carry no voiceWarm; the inventory entry is tauriOnly.
{
  const electronSrc = fs.readFileSync(path.join(ROOT, 'src/main/main.js'), 'utf8') + fs.readFileSync(path.join(ROOT, 'src/main/preload.js'), 'utf8');
  ok(!/voiceWarm/.test(electronSrc), 'B3: Electron main.js/preload.js have no voiceWarm (frozen)');
  const inv = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/migration/api-inventory.json'), 'utf8'));
  const e = inv.apis.find((a) => a.name === 'talk.voiceWarm');
  ok(e && e.tauriOnly === true && /^tauri\/sidecar\/main\.mjs/.test(e.handler), 'B3: inventory marks talk.voiceWarm tauriOnly with a sidecar handler');
}

// 12. no SAPI on a failure path either (mutation guard): a failed load answers an error and never calls the Windows voice.
{
  let sapiCalls = 0;
  const failing = { available: () => true, isReady: () => false, status: () => ({ state: 'error' }), prefetch: () => Promise.resolve(false), abandon() {} };
  const router = createEnTtsRouter({ kokoro: failing, sapi: { available: () => true, speak: async () => { sapiCalls++; return {}; } }, log: () => {}, kokoroOnly: true });
  const r = await router.speak({ turnId: 'e'.repeat(32), text: 'Fail.' });
  ok(r.ok === false && r.error.code === 'kokoro_load_failed' && sapiCalls === 0, 'no SAPI on a failed load (explicit error)', JSON.stringify(r));
  const host = fs.readFileSync(path.join(ROOT, 'tauri/sidecar/voice-host.mjs'), 'utf8');
  ok(/kokoroOnly: true/.test(host), 'the sidecar router runs kokoroOnly');
}

// 13. a failed load does not arm the idle timer, so a retry still loading past the idle window is not killed.
{
  let n = 0; let term = 0; let ens = 0;
  const factory = () => {
    const w = new EventEmitter(); const mine = ++n;
    w.postMessage = (msg) => setTimeout(() => {
      if (msg.cmd === 'speak') { w.emit('message', { type: 'done', turnId: msg.turnId }); return; } // the warm-up synthesis
      if (msg.cmd !== 'ensure') return;
      if (++ens === 1) w.emit('message', { type: 'ensureError', message: 'download failed', retryable: true });
      else setTimeout(() => w.emit('message', { type: 'ready' }), 250); // slow retry, longer than the idle window
    }, 1);
    w.terminate = () => { term++; };
    return w;
  };
  const kk = createKokoroTts({ userDataDir: tmp, log: () => {}, workerFactory: factory, idleUnloadMs: 60 });
  ok(await kk.prefetch() === false && kk.status().state === 'error', 'failed load: state error');
  const retry = kk.prefetch();
  await sleep(150); // past the idle window while the retry is still loading
  ok(term === 0 && kk.status().state !== 'idle', 'retry still loading past the idle window is not killed', `term=${term} state=${kk.status().state}`);
  { const rv = await Promise.race([retry, sleep(1500).then(() => 'HANG')]); ok(rv === true && kk.isReady(), 'the retry completes and Kokoro is ready', String(rv) + ' ' + kk.status().state); }
  kk.dispose();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
