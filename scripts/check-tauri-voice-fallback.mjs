// T-31 OSS v1 parity row 15: Windows voice (SAPI) fallback in the Tauri sidecar, ONLY while Kokoro is not ready
// (cold load, or a reload after the 10 min idle unload) and ONLY when voice is ON. No Electron, no real worker, no
// PowerShell, no network: Kokoro and SAPI are fakes with a manually released load.
//   node scripts/check-tauri-voice-fallback.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// T-31 T1: L1 is the default load mode; these checks pin the start-time (eager) behaviour, so select it explicitly.
process.env.ZUMI_KOKORO_LOAD = 'eager';

const { createVoiceHost } = await import('../tauri/sidecar/voice-host.mjs');
const { createSecretStores } = await import('../tauri/sidecar/secret-stores.mjs');
const fakeSafe = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(`enc:${s}`, 'utf8'), decryptString: (b) => b.toString('utf8').replace(/^enc:/, '') };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-fallback-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });
let pass = 0, fail = 0;
const ok = (c, n, d = '') => { if (c) { pass++; console.log(`PASS ${n}`); } else { fail++; console.log(`FAIL ${n} ${d}`); } };
const TIMEOUT = Symbol('timeout');
const within = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(TIMEOUT), ms))]);

// Kokoro fake: state idle -> (prefetch) loading -> (release()) ready; unload() -> idle. Never loads by itself.
function fakeKokoro({ ready = false } = {}) {
  let state = ready ? 'ready' : 'idle';
  const waiters = [];
  const k = {
    prefetches: 0, speaks: 0,
    available: () => true,
    isReady: () => state === 'ready',
    status: () => ({ state, phase: null, loaded: 0, total: 0, error: null }),
    info: () => ({ mode: 'kokoro', voice: 'af_heart' }),
    speed: () => 1, setSpeed() {},
    prefetch() {
      k.prefetches++;
      if (state === 'ready') return Promise.resolve(true);
      if (state === 'idle') state = 'loading';
      return new Promise((r) => waiters.push(r));
    },
    release() { state = 'ready'; waiters.splice(0).forEach((r) => r(true)); },
    unload() { state = 'idle'; waiters.splice(0).forEach((r) => r(false)); },
    async speakStream(turnId, text, onSentence) { k.speaks++; onSentence({ index: 0, text, mime: 'audio/wav', audio: Buffer.from('kokoro-wav') }); },
    speakLive(turnId, live, onSentence) { return k.speakStream(turnId, '', onSentence); },
    abandon() {}, dispose() {},
  };
  return k;
}
function fakeSapi({ available = true } = {}) {
  const s = {
    calls: [], available: () => available, voices: () => ['Microsoft Zira Desktop'], ready: () => Promise.resolve(),
    info: async () => ({ mode: 'windows', voice: 'Microsoft Zira Desktop' }),
    async speak(p) { s.calls.push(p.text); return { mime: 'audio/wav', audios: [Buffer.from('sapi-wav')], voice: 'Microsoft Zira Desktop' }; },
  };
  return s;
}
const mkHost = ({ kokoro, sapi, voiceEnabled = true }) => createVoiceHost({
  dataDir: tmp, settings: () => ({ voiceEnabled }), saveSettings: () => {}, secretStores: async () => createSecretStores({ safeStorage: fakeSafe, dataDir: tmp }), flavour: { values: {} },
  ttsFetchFor: () => null, emit: () => true, kokoroFactory: () => kokoro, localTtsFactory: () => sapi, log: () => {},
});
const say = (host, text, n) => host.handlers['talk.tts']({ text, turnId: String(n).repeat(32).slice(0, 32) });
const audioOf = (r) => (r && r.audios && r.audios[0] ? r.audios[0].toString() : null);

// 1. voice ON, Kokoro cold-loading: the first reply is spoken at once with SAPI, Kokoro keeps loading.
{
  const kokoro = fakeKokoro(); const sapi = fakeSapi();
  const host = mkHost({ kokoro, sapi });
  ok(kokoro.status().state === 'loading', 'setup: voice ON starts the Kokoro load at host start');
  const r = await within(say(host, 'Hello there.', 1), 300);
  ok(r !== TIMEOUT && r.ok === true && audioOf(r) === 'sapi-wav' && /Zira/.test(r.voice), 'cold Kokoro + voice ON: the first reply produces audio now (SAPI)', r === TIMEOUT ? 'NO AUDIO within 300 ms (reply is stuck waiting for the Kokoro load)' : JSON.stringify(r));
  ok(sapi.calls.length === 1 && sapi.calls[0] === 'Hello there.', 'SAPI got the reply text once', JSON.stringify(sapi.calls));
  ok(kokoro.status().state === 'loading' && !kokoro.isReady(), 'Kokoro keeps loading in the background (not cancelled)');
  const r2 = await within(say(host, 'Second while loading.', 2), 300);
  ok(r2 !== TIMEOUT && audioOf(r2) === 'sapi-wav' && sapi.calls.length === 2, 'another reply while still loading also uses SAPI');
  // 2. Kokoro ready: the next replies use Kokoro, SAPI untouched from then on.
  kokoro.release();
  const r3 = await within(say(host, 'Now warm.', 3), 300);
  ok(r3 !== TIMEOUT && r3.ok === true && r3.voice === 'af_heart' && audioOf(r3) === 'kokoro-wav' && sapi.calls.length === 2, 'once Kokoro is ready the next reply uses Kokoro, no SAPI', JSON.stringify(r3));
  // 5. idle unload (10 min, unchanged): the fallback is used again while it reloads.
  const before = kokoro.prefetches;
  kokoro.unload();
  const r4 = await within(say(host, 'After the idle unload.', 4), 300);
  ok(r4 !== TIMEOUT && audioOf(r4) === 'sapi-wav' && sapi.calls.length === 3, 'after an idle unload the fallback speaks while Kokoro reloads', r4 === TIMEOUT ? 'NO AUDIO within 300 ms' : JSON.stringify(r4));
  ok(kokoro.prefetches > before && kokoro.status().state === 'loading', 'the reply restarted the Kokoro reload');
  kokoro.release();
  const r5 = await within(say(host, 'Warm again.', 5), 300);
  ok(audioOf(r5) === 'kokoro-wav' && sapi.calls.length === 3, 'after the reload Kokoro is used again, SAPI count unchanged');
}

// 3. voice OFF: nothing loads (neither engine), the reply is text-only.
{
  const kokoro = fakeKokoro(); const sapi = fakeSapi();
  const host = mkHost({ kokoro, sapi, voiceEnabled: false });
  host.prewarm('typing');
  const r = await within(say(host, 'Silent.', 6), 300);
  ok(r !== TIMEOUT && r.ok === true && r.reason === 'voice-off' && r.audios.length === 0, 'voice OFF: text-only reply', JSON.stringify(r));
  ok(kokoro.prefetches === 0 && kokoro.speaks === 0 && sapi.calls.length === 0, 'voice OFF: Kokoro not loaded, SAPI not used');
}

// 4. warm Kokoro: no SAPI at all.
{
  const kokoro = fakeKokoro({ ready: true }); const sapi = fakeSapi();
  const host = mkHost({ kokoro, sapi });
  const r = await within(say(host, 'Warm from the start.', 7), 300);
  ok(r !== TIMEOUT && audioOf(r) === 'kokoro-wav' && sapi.calls.length === 0, 'warm Kokoro: Kokoro speaks, SAPI never used');
}

// 6. no Windows voice installed: the old behaviour (wait for Kokoro) is kept, never a silent drop.
{
  const kokoro = fakeKokoro(); const sapi = fakeSapi({ available: false });
  const host = mkHost({ kokoro, sapi });
  const p = say(host, 'No windows voice.', 8);
  ok(await within(p, 100) === TIMEOUT, 'no Windows voice installed: the reply still waits for Kokoro');
  kokoro.release();
  const r = await within(p, 300);
  ok(r !== TIMEOUT && audioOf(r) === 'kokoro-wav', 'and plays with Kokoro once ready');
}

// 7. a FAILED load stays an explicit error, never a different voice (R1 rule kept for the failure path).
{
  const kokoro = fakeKokoro();
  kokoro.status = () => ({ state: 'error', error: 'x' }); kokoro.prefetch = () => Promise.resolve(false);
  const sapi = fakeSapi();
  const host = mkHost({ kokoro, sapi });
  const r = await within(say(host, 'Broken.', 9), 300);
  ok(r !== TIMEOUT && r.ok === false && r.error.code === 'kokoro_load_failed' && sapi.calls.length === 0, 'failed Kokoro load: explicit error, no SAPI', JSON.stringify(r));
}

// 8. the SAPI path stays non-resident: local-tts spawns one PowerShell per speak and holds nothing after it.
{
  const src = fs.readFileSync(new URL('../src/main/local-tts.js', import.meta.url), 'utf8');
  ok(/spawn\('powershell\.exe'/.test(src) && !/setInterval|keepAlive|persistent/i.test(src), 'local-tts: one-shot PowerShell child per call, no resident process or timer');
}

// 9. gate fixes (S1/S2/S3/cap): whenever SAPI cannot speak, the reply behaves as before the fallback: waits for Kokoro.
const waitsThenKokoro = async (name, mk) => {
  const kokoro = fakeKokoro(); const sapi = mk();
  const host = mkHost({ kokoro, sapi });
  const p = say(host, 'Sure, see you at the cafe.', 11);
  const early = await within(p, 150);
  ok(early === TIMEOUT, `${name}: no error and no silence, the reply waits for Kokoro`, early === TIMEOUT ? '' : JSON.stringify(early));
  kokoro.release();
  const r = await within(p, 300);
  ok(r !== TIMEOUT && r.ok === true && audioOf(r) === 'kokoro-wav', `${name}: plays with Kokoro once ready`, JSON.stringify(r));
};
const failingSapi = (speak) => () => { const s = fakeSapi(); s.speak = speak; return s; };
// S1: no Windows voice, but available() is still true before enumeration ends; speak() then throws no_voice.
await waitsThenKokoro('S1 no voice, available() true before enumeration', failingSapi(async () => { const e = new Error('no voices installed'); e.code = 'no_voice'; throw e; }));
// S2: SAPI declines (its own language detection finds no vi voice): ok, zero audios.
await waitsThenKokoro('S2 SAPI declines with no audio', failingSapi(async () => ({ mime: 'audio/wav', audios: [], voice: 'none', reason: 'no-vi-voice' })));
// S3: SAPI fails (text over 2000 chars, PowerShell timeout).
await waitsThenKokoro('S3 SAPI failure', failingSapi(async () => { const e = new Error('powershell timed out'); e.code = 'internal'; throw e; }));
// Cap: one SAPI process at a time; an overlapping reply skips SAPI and waits for Kokoro.
{
  const kokoro = fakeKokoro(); const sapi = fakeSapi();
  let finish; sapi.speak = (p) => { sapi.calls.push(p.text); return new Promise((r) => { finish = () => r({ mime: 'audio/wav', audios: [Buffer.from('sapi-wav')], voice: 'Zira' }); }); };
  const host = mkHost({ kokoro, sapi });
  const a = say(host, 'First.', 12);
  await new Promise((r) => setTimeout(r, 50));
  const b = say(host, 'Second, overlapping.', 13);
  await new Promise((r) => setTimeout(r, 100));
  ok(sapi.calls.length === 1, 'cap: an overlapping reply does not start a second SAPI process', JSON.stringify(sapi.calls));
  finish();
  const ra = await within(a, 300);
  ok(ra !== TIMEOUT && audioOf(ra) === 'sapi-wav', 'cap: the first reply still speaks with SAPI');
  ok(await within(b, 100) === TIMEOUT, 'cap: the overlapping reply waits for Kokoro');
  kokoro.release();
  const rb = await within(b, 300);
  ok(rb !== TIMEOUT && audioOf(rb) === 'kokoro-wav' && sapi.calls.length === 1, 'cap: the overlapping reply plays with Kokoro');
}

// R1 (re-check): one deadline from the reply start. Time spent in a failed SAPI attempt counts against loadWaitMs.
{
  const { createEnTtsRouter } = await import('../src/main/tts-router.js').then((m) => m.default || m);
  const kokoro = fakeKokoro(); const sapi = fakeSapi();
  sapi.speak = () => new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('slow fail'), { code: 'internal' })), 300));
  const router = createEnTtsRouter({ kokoro, sapi, kokoroOnly: true, sapiWhileLoading: true, loadWaitMs: 500 });
  const t0 = Date.now();
  const r = await within(router.speak({ turnId: 'r1r1r1r1', text: 'Slow SAPI failure.' }), 1500);
  const dt = Date.now() - t0;
  ok(r !== TIMEOUT && r.ok === false && r.error.code === 'kokoro_loading', 'R1: slow-failing SAPI then a never-ready Kokoro ends in kokoro_loading', r === TIMEOUT ? 'no result in 1500 ms' : JSON.stringify(r));
  ok(dt < 650, 'R1: the reply resolves within the original loadWaitMs bound (SAPI time counts)', `took ${dt} ms, loadWaitMs=500`);
}
// sapiBusy is cleared after a failed SAPI call: the next cold reply can use SAPI again.
{
  const { createEnTtsRouter } = await import('../src/main/tts-router.js').then((m) => m.default || m);
  const kokoro = fakeKokoro(); const sapi = fakeSapi();
  let n = 0;
  sapi.speak = async (p) => { sapi.calls.push(p.text); if (++n === 1) throw Object.assign(new Error('boom'), { code: 'internal' }); return { mime: 'audio/wav', audios: [Buffer.from('sapi-wav')], voice: 'Zira' }; };
  const router = createEnTtsRouter({ kokoro, sapi, kokoroOnly: true, sapiWhileLoading: true, loadWaitMs: 5000 });
  const a = router.speak({ turnId: 'b1b1b1b1', text: 'First fails.' });
  await new Promise((r) => setTimeout(r, 80));
  const b = await within(router.speak({ turnId: 'b2b2b2b2', text: 'Second cold.' }), 300);
  ok(sapi.calls.length === 2 && b !== TIMEOUT && audioOf(b) === 'sapi-wav', 'sapiBusy cleared after a failed SAPI call: the next cold reply uses SAPI', JSON.stringify(sapi.calls));
  kokoro.release(); await within(a, 300);
}


console.log(`
${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
