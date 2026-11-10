// T-31 Tauri parity step 8b, part 1 check: the voice routing core + the cloud TTS providers in the sidecar.
// Plain Node, no Electron, no window, and NO real network: every adapter gets the production per-provider egress
// guard wrapped around a RECORDING base fetch, so a call that reached a socket would fail the run instead.
//
//   node scripts/check-tauri-voice.mjs
//
//   1. the freeze-exception extraction: the routing lives in src/main/talk-voice-core.mjs, main.js only delegates
//      (no second copy of the route/table), and voicePrefsOf is the same clamping/validation as before;
//   2. the core route: provider by language / say line, voice off, no_provider, a typed adapter error returned as-is,
//      EXACTLY ONE adapter call per click and no silent cross-provider fallback, testVoice once per click;
//   3. the sidecar rpc: voiceInfo/voiceState/voiceProviders/setProviderKey/clearProviderKey/setVoicePrefs/testVoice/
//      openGuide/tts answer Electron's shapes;
//   4. the owner voice flag: file, not flavour -- owner-voice.json in the data dir only; ownerAdmin does not turn it on (0.2.9 parity);
//   5. security: setProviderKey returns a boolean, voiceProviders returns hasKey only, and the sentinel keys of all
//      talk-mode key files + Leda appear in no reply, no log and no file but their own encrypted blob;
//   6. part 2: Kokoro prefetch/progress, the Windows voice, ttsAbandon, talk:ttsMore split over 512 KB reassembled
//      byte-equal by the shim, and `$bin` audio over the real stdio protocol.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import { createTalkVoiceCore, VOICE_GUIDES, VOICE_SPEED, voicePrefsOf } from '../src/main/talk-voice-core.mjs';
import { createSecretStores } from '../tauri/sidecar/secret-stores.mjs';
import { ttsFetch } from '../tauri/sidecar/egress.mjs';
import { encodeBinary, decodeBinary, payloadBytes, MAX_EVENT_PAYLOAD_BYTES } from '../tauri/sidecar/protocol.mjs';
import { sidecarHandlerNames } from './check-tauri-coverage.mjs';
// T-31 T1: L1 is the default load mode; these checks pin the start-time (eager) behaviour, so select it explicitly.
process.env.ZUMI_KOKORO_LOAD = 'eager';

// The sidecar's DEFAULT kokoro factory constructs its Worker with workerData.egress = 'hf-only'. Spy on the Worker
// constructor BEFORE voice-host.mjs is evaluated (its `import { Worker } from 'node:worker_threads'` snapshots the
// current export), so the default factory can be observed without spawning a real worker thread or any model work.
const require = createRequire(import.meta.url);
const workerThreads = require('node:worker_threads');
const RealWorker = workerThreads.Worker;
const workerSpawns = [];
class SpyWorker {
  constructor(file, opts) {
    const rec = { file, opts, stdoutListeners: [] };
    workerSpawns.push(rec);
    // stdout:true makes Node expose worker.stdout; the sidecar must forward it to stderr, never its RPC stdout.
    this.stdout = opts && opts.stdout ? { on: (ev, fn) => rec.stdoutListeners.push({ ev, fn }) } : null;
  }
  on() {} off() {} postMessage() {} terminate() { return Promise.resolve(0); }
}
workerThreads.Worker = SpyWorker;
const { createVoiceHost } = await import('../tauri/sidecar/voice-host.mjs');
workerThreads.Worker = RealWorker;

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIDECAR = path.join(ROOT, 'tauri', 'sidecar', 'main.mjs');
let pass = 0;
let fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${detail ? '  ' + detail : ''}`); } };
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const stable = (v) => JSON.stringify(v);

const GOOGLE_KEY = `AIza${'G'.repeat(35)}`;
const GEMINI_KEY = `AIza${'M'.repeat(35)}`;
const ELEVEN_KEY = `sk_${'e1'.repeat(16)}`;
const OPENAI_KEY = 'openai-bearer-123456789';
const ZUMIA_KEY = 'zumia-bearer-123456789';
const VOICE_ID = 'JBFqnCBsd6RMkjVDRZzb';
const fakeSafe = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(`enc:${s}`, 'utf8'), decryptString: (b) => b.toString('utf8').replace(/^enc:/, '') };

const TMP_ROOT = path.join(ROOT, '.tauri-check-tmp');
fs.mkdirSync(TMP_ROOT, { recursive: true });
const work = fs.mkdtempSync(path.join(TMP_ROOT, 'voice-'));

function fileStore(dir) {
  const file = path.join(dir, 'settings.json');
  const get = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
  const set = (patch) => { fs.mkdirSync(dir, { recursive: true }); const next = { ...get(), ...patch }; fs.writeFileSync(file, JSON.stringify(next, null, 2)); return next; };
  return { get, set };
}
const freshDir = (name, initial = null, ownerFlag = null) => {
  const d = path.join(work, name);
  fs.mkdirSync(d, { recursive: true });
  if (initial) fs.writeFileSync(path.join(d, 'settings.json'), JSON.stringify(initial));
  if (ownerFlag) fs.writeFileSync(path.join(d, 'owner-voice.json'), JSON.stringify(ownerFlag));
  return d;
};

// A base fetch that records every call and answers per URL. It is the ONLY fetch the adapters can reach: the
// production guard sits in front of it, so a wrong host is refused before this recorder sees it.
function recorder(routes = {}) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init });
    const route = routes[url.split('?')[0]] || routes.default;
    if (typeof route === 'function') return route(url, init);
    if (route) return route;
    return smartResponse(url);
  };
  f.calls = calls;
  return f;
}
const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const b64 = Buffer.from('wav').toString('base64');
// The response shape each endpoint really returns (an interaction for gemini, audioContent for Google, audios[] for
// the Zumia shape, raw bytes for ElevenLabs / OpenAI). Never a network call: this is the recorded answer.
function smartResponse(url) {
  if (url.includes('generativelanguage.googleapis.com')) return jsonResponse({ steps: [{ type: 'model_output', content: [{ type: 'audio', data: b64 }] }] });
  if (url.includes('texttospeech.googleapis.com')) return jsonResponse({ audioContent: b64 });
  if (url.includes('zumia.space')) return jsonResponse({ audios: [b64] });
  return okResponse('audio', 'audio/mpeg');
}
function jsonResponse(body) {
  const txt = JSON.stringify(body);
  return { ok: true, status: 200, headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'application/json' : null) }, text: async () => txt, arrayBuffer: async () => ab(Buffer.from(txt)) };
}
function okResponse(kind = 'audio', ctype = 'audio/wav') {
  if (kind === 'json-audio') return { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify({ audioContent: Buffer.from('wav').toString('base64') }), arrayBuffer: async () => ab(Buffer.from(JSON.stringify({ audioContent: Buffer.from('wav').toString('base64') }))) };
  return { ok: true, status: 200, headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? ctype : null) }, text: async () => 'audio', arrayBuffer: async () => ab(Buffer.from('wav')) };
}

// Step 8b part 2: the local engines are injected in every host-level check so no check can ever start a real
// ~163 MB Kokoro download or spawn PowerShell. The production defaults (createKokoroTts / createLocalTts) are what
// the real sidecar builds; the real-stdio section below runs those, with --no-voice-prefetch.
function fakeKokoro({ available = true, ready = false, sentences = [], ensureError = false } = {}) {
  const calls = { abandon: [], prefetch: 0, speed: [] };
  let isUp = ready;
  let failed = false;
  const k = {
    calls,
    available: () => available,
    isReady: () => isUp,
    status: () => ({ state: isUp ? 'ready' : failed ? 'error' : 'idle', phase: null, loaded: 0, total: 0, error: null }),
    info: () => ({ mode: 'kokoro', voice: 'af_heart' }),
    speed: () => 1,
    setSpeed(v) { calls.speed.push(v); return v; },
    prefetch(onProgress) {
      calls.prefetch++;
      if (onProgress) onProgress({ phase: 'onnx/model_fp16.onnx', loaded: 40, total: 160 });
      if (ensureError) { failed = true; return Promise.resolve(false); }
      isUp = true;
      return Promise.resolve(true);
    },
    speakStream(turnId, text, onSentence) {
      sentences.forEach((audio, i) => onSentence({ index: i, text: String(i), mime: 'audio/wav', audio }));
      return Promise.resolve();
    },
    speakLive(turnId, live, onSentence) { return this.speakStream(turnId, '', onSentence); },
    abandon(turnId) { calls.abandon.push(turnId); },
    dispose() {},
  };
  return k;
}
function fakeSapi({ available = true } = {}) {
  const s = {
    calls: 0,
    available: () => available,
    voices: () => (available ? ['Microsoft Zira Desktop'] : []),
    ready: () => Promise.resolve(),
    info: async () => (available ? { mode: 'windows', voice: 'Microsoft Zira Desktop' } : { mode: 'off', voice: null }),
    async speak() { s.calls++; return { mime: 'audio/wav', audios: [Buffer.from('wav')], voice: 'Microsoft Zira Desktop' }; },
  };
  return s;
}
function makeHost(dir, { initials, routes, flavour, ownerFlag = false, log = () => {}, emit, kokoro, sapi, prefetch = true } = {}) {
  if (initials) fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(initials));
  const st = fileStore(dir);
  const base = recorder(routes);
  const k = kokoro || fakeKokoro();
  const s = sapi || fakeSapi({ available: false });
  const events = [];
  const host = createVoiceHost({
    dataDir: dir,
    settings: st.get, saveSettings: st.set,
    secretStores: async () => createSecretStores({ safeStorage: fakeSafe, dataDir: dir }),
    flavour: { values: flavour || { ownerAdmin: false } },
    ttsFetchFor: (id) => ttsFetch(base, id, log),
    isLiveSay: (sayId) => sayId === 'live-1',
    takeLiveReply: () => null,
    emit: emit || ((channel, payload) => { events.push({ channel, payload }); return true; }),
    prefetch,
    kokoroFactory: () => k,
    localTtsFactory: () => s,
    log,
  });
  return { host, st, base, events, kokoro: k, sapi: s };
}

// ---------------------------------------------------------------- 1. the extraction is a move, not a copy
{
  const main = read('src', 'main', 'main.js');
  const core = read('src', 'main', 'talk-voice-core.mjs');
  ok(/function providerFor\(id\)/.test(core) && !/function providerFor\(id\)/.test(main), 'providerFor lives in the core only (main.js has no second copy)');
  ok(/export const VOICE_GUIDES = \{/.test(core) && !/const VOICE_GUIDES = \{/.test(main), 'the VOICE_GUIDES table lives in the core only');
  ok(/ipcMain\.handle\('talk:tts', \(e, p\) => \(fromAppPage\(e\) \? talkVoice\.tts\(p\) : refused\)\)/.test(main), 'main.js talk:tts keeps the sender check and delegates to the core');
  ok(/const talkVoice = createTalkVoiceCore\(/.test(main), 'main.js builds the shared core with its live adapters');
  ok(/createTalkVoiceCore[\s\S]*?adapters: \(\) => \(\{[\s\S]*?google: ledaTts/.test(main), 'the core gets the same Electron adapters (getters, created in whenReady)');
  ok(!/replyOutcome\(|resolveVoice\(|voiceProviderPrefs\(/.test(main), 'main.js no longer re-implements any routing rule');

  const p = voicePrefsOf({ voiceSpeed: 9, voiceVolume: -1 }, false);
  ok(p.speed === VOICE_SPEED.max && p.volume === 0 && p.voiceProviderEn === 'kokoro' && p.voiceProviderVi === 'google', 'voicePrefsOf clamps speed/volume and defaults the providers', stable(p));
  ok(voicePrefsOf({ voiceProviderVi: 'zumia-owner' }, false).voiceProviderVi === 'google', 'without the owner flag a saved zumia-owner reads as google');
  ok(voicePrefsOf({ voiceProviderVi: 'zumia-owner' }, true).voiceProviderVi === 'zumia-owner', 'with the owner flag a saved zumia-owner stands');
}

// ---------------------------------------------------------------- 2. the core route: one provider, one call, no fallback
{
  const dir = freshDir('core-route', { voiceProviderEn: 'gemini', voiceProviderVi: 'elevenlabs', voiceEleven: { voiceId: VOICE_ID } });
  const { host, base } = makeHost(dir, {});
  await host.handlers['talk.setProviderKey']('gemini', GEMINI_KEY);
  await host.handlers['talk.setProviderKey']('elevenlabs', ELEVEN_KEY);
  base.calls.length = 0;

  const vi = await host.handlers['talk.tts']({ text: 'Xin chào anh', turnId: 'a' });
  ok(vi.ok === true && vi.audios.length === 1 && base.calls.length === 1 && base.calls[0].url.startsWith('https://api.elevenlabs.io/'), 'a VI reply calls elevenlabs exactly once', `${stable(vi)} calls=${base.calls.map((c) => c.url)}`);
  base.calls.length = 0;
  const en = await host.handlers['talk.tts']({ text: 'Hello there', turnId: 'b' });
  ok(en.ok === true && base.calls.length === 1 && base.calls[0].url.startsWith('https://generativelanguage.googleapis.com/'), 'an EN reply calls gemini exactly once', `calls=${base.calls.map((c) => c.url)}`);

  // a typed failure is returned as-is: no second provider, no retry
  base.calls.length = 0;
  const failing = makeHost(freshDir('core-fail', { voiceProviderEn: 'gemini' }), { routes: { default: () => ({ ok: false, status: 500, headers: { get: () => null }, text: async () => '{"error":{"message":"boom"}}', arrayBuffer: async () => ab(Buffer.from('x')) }) } });
  await failing.host.handlers['talk.setProviderKey']('gemini', GEMINI_KEY);
  await failing.host.handlers['talk.setProviderKey']('google', GOOGLE_KEY);
  await failing.host.handlers['talk.setProviderKey']('elevenlabs', ELEVEN_KEY);
  failing.base.calls.length = 0;
  const bad = await failing.host.handlers['talk.tts']({ text: 'Hello', turnId: 'c' });
  ok(bad.ok === false && bad.error && bad.error.code === 'http_500', 'a failing paid provider returns its typed error', stable(bad));
  ok(failing.base.calls.length === 1 && failing.base.calls[0].url.startsWith('https://generativelanguage.googleapis.com/'), 'no silent cross-provider fallback: the other keyed providers are never called', failing.base.calls.map((c) => c.url).join(','));

  // voice off / off-language / kokoro with no usable local engine
  const off = makeHost(freshDir('core-off', { voiceEnabled: false }), {});
  ok((await off.host.handlers['talk.tts']({ text: 'hi' })).reason === 'voice-off' && off.base.calls.length === 0, 'voice off answers the silent result with no call');
  const offLang = makeHost(freshDir('core-offlang', { voiceReplyLang: 'vi', voiceProviderVi: 'off' }), {});
  ok((await offLang.host.handlers['talk.tts']({ text: 'Xin chào' })).reason === 'voice-off-lang' && offLang.base.calls.length === 0, 'the off provider answers voice-off-lang with no call');
  // Kokoro present but its load fails: the Tauri router never falls back to another voice; an explicit error, no cloud call.
  const kokoro = makeHost(freshDir('core-kokoro', {}), { kokoro: fakeKokoro({ ensureError: true }) });
  const k = await kokoro.host.handlers['talk.tts']({ text: 'Hello' });
  ok(k.ok === false && k.error && k.error.code === 'kokoro_load_failed' && kokoro.base.calls.length === 0, 'kokoro load failure answers an explicit error, no other voice, no cloud call', stable(k));
  const kokoroTest = await kokoro.host.handlers['talk.testVoice']({ lang: 'en', text: 'Hello' });
  ok(kokoroTest.ok === false && kokoroTest.reason === 'kokoro_load_failed' && kokoro.base.calls.length === 0, 'testVoice on kokoro with no local engine answers its typed reason, no cloud call', stable(kokoroTest));

  // testVoice: one paid call per click, through the language's provider only
  base.calls.length = 0;
  const t = await host.handlers['talk.testVoice']({ lang: 'vi', text: 'Xin chào' });
  ok(t.ok === true && base.calls.length === 1 && base.calls[0].url.startsWith('https://api.elevenlabs.io/'), 'testVoice(vi) calls elevenlabs exactly once', base.calls.map((c) => c.url).join(','));
  ok((await host.handlers['talk.testVoice']({ lang: 'vi', text: '   ' })).reason === 'bad_request' && base.calls.length === 1, 'an empty test line is bad_request with no call');
  ok((await host.handlers['talk.testVoice']({ lang: 'vi', text: 'X' })).ok === true && base.calls.length === 2, 'a second click makes exactly one more call', `calls=${base.calls.length}`);

  // openGuide table
  let opened = [];
  const core = createTalkVoiceCore({ settings: () => ({}), saveSettings: () => {}, openExternal: (u) => opened.push(u) });
  ok(core.openGuide('google') === true && opened[0] === VOICE_GUIDES.google, 'openGuide opens the fixed table URL for a known id');
  ok(core.openGuide('https://evil.example') === false && core.openGuide('constructor') === false && core.openGuide(42) === false && opened.length === 1, 'openGuide refuses a URL, an inherited name and a non-string');
  ok(VOICE_GUIDES.google.startsWith('https://cloud.google.com/') && VOICE_GUIDES.gemini.startsWith('https://aistudio.google.com/') && VOICE_GUIDES.elevenlabs.startsWith('https://elevenlabs.io/'), 'the guide table holds the four fixed https URLs');
}

// ---------------------------------------------------------------- 2b. the Electron E2E env hooks stay Electron-only
{
  const dir = freshDir('env-off', { voiceProviderEn: 'gemini' });
  const { host, base } = makeHost(dir, {});
  await host.handlers['talk.setProviderKey']('gemini', GEMINI_KEY);
  base.calls.length = 0;
  process.env.ZUMI_E2E_FORCE_TTS_FAIL = 'Hello';
  try {
    const r = await host.handlers['talk.tts']({ text: 'Hello there', turnId: 'env' });
    ok(!(r.ok === false && r.error && r.error.code === 'e2e_forced'), 'the sidecar does not honour an inherited ZUMI_E2E_FORCE_TTS_FAIL (test hooks stay in Electron)');
    ok(base.calls.length === 1, 'the sidecar still makes the one real provider call while that env var is set');
  } finally { delete process.env.ZUMI_E2E_FORCE_TTS_FAIL; }
  // The core's DEFAULT (Electron) still honours it, so the extraction kept the hook.
  process.env.ZUMI_E2E_FORCE_TTS_FAIL = 'Hello';
  try {
    const electronCore = createTalkVoiceCore({ settings: () => ({ voiceProviderEn: 'gemini' }), saveSettings: () => {} });
    const r = await electronCore.tts({ text: 'Hello there', turnId: 'env-e' });
    ok(r.ok === false && r.error && r.error.code === 'e2e_forced', 'the core default (Electron) still honours ZUMI_E2E_FORCE_TTS_FAIL');
  } finally { delete process.env.ZUMI_E2E_FORCE_TTS_FAIL; }
  /* c8 ignore next */
  ok(/forceTtsFail: \(\) => null/.test(read('tauri', 'sidecar', 'voice-host.mjs')), 'voice-host passes the E2E hooks off explicitly (source guard)');
}

// ---------------------------------------------------------------- 3. the owner voice flag: file, not flavour
{
  { // Owner key (owner 02-11): the path under --data-dir, through the real voice host and secret stores.
    const d = freshDir('owner-key', {}, { v: 1, zumiaVoice: true });
    const imp = path.join(d, 'zumia-owner-tts-key.import');
    fs.writeFileSync(imp, 'owner-key-fixture-0123456789');
    const h = makeHost(d, {});
    ok(fs.existsSync(imp), 'owner key: not read before the first voice call (the adapters are lazy)');
    await h.host.handlers['talk.voiceProviders']();
    ok(!fs.existsSync(imp) && fs.existsSync(path.join(d, 'custom-zumia-owner-tts-key.bin')), 'owner key: <data-dir>/zumia-owner-tts-key.import becomes <data-dir>/custom-zumia-owner-tts-key.bin on the first voice call', fs.readdirSync(d).join());
    const none = freshDir('owner-key-noflag', {});
    const imp2 = path.join(none, 'zumia-owner-tts-key.import');
    fs.writeFileSync(imp2, 'owner-key-fixture-0123456789');
    await makeHost(none, {}).host.handlers['talk.voiceProviders']();
    ok(fs.existsSync(imp2), 'owner key: without owner-voice.json the import file is left alone');
  }
  const viaFile = makeHost(freshDir('owner-file', {}, { v: 1, zumiaVoice: true }), {});
  const providers = await viaFile.host.handlers['talk.voiceProviders']();
  ok(providers.some((p) => p.id === 'zumia-owner' && p.langs.join() === 'vi'), 'owner-voice.json in the preview data dir adds zumia-owner to the card');
  ok(viaFile.host.handlers['talk.getVoicePrefs']().voiceProviderVi === 'zumia-owner', 'ownerVoice prefs default VI to zumia-owner');
  viaFile.base.calls.length = 0;
  const r = await viaFile.host.handlers['talk.testVoice']({ lang: 'vi', text: 'Xin chào anh' });
  ok(r.ok === true && viaFile.base.calls.length === 1 && viaFile.base.calls[0].url === 'https://zumia.space/api/zumi/tts' && !('authorization' in viaFile.base.calls[0].init.headers), 'the owner route calls zumia.space once and never sends a bearer', viaFile.base.calls[0] && viaFile.base.calls[0].url);

  const viaFlavour = makeHost(freshDir('owner-flavour', {}), { flavour: { ownerAdmin: true }, ownerFlag: false });
  ok(!(await viaFlavour.host.handlers['talk.voiceProviders']()).some((p) => p.id === 'zumia-owner') && viaFlavour.host.handlers['talk.getVoicePrefs']().voiceProviderVi === 'google', 'gap 2: the build flavour ownerAdmin does NOT turn the owner voice on; VI defaults to google as in 0.2.9');

  const bad = freshDir('owner-bad');
  fs.writeFileSync(path.join(bad, 'owner-voice.json'), JSON.stringify({ v: 1, zumiaVoice: true, extra: 1 }));
  const badHost = makeHost(bad, {});
  ok(!(await badHost.host.handlers['talk.voiceProviders']()).some((p) => p.id === 'zumia-owner'), 'a malformed owner-voice.json (an extra key) is ignored');
}

// ---------------------------------------------------------------- 4. security: booleans, hasKey only, no sentinel leak
{
  const dir = freshDir('security', { voiceProviderEn: 'gemini', voiceProviderVi: 'elevenlabs', voiceEleven: { voiceId: VOICE_ID } });
  const logs = [];
  const { host } = makeHost(dir, { log: (m) => logs.push(m) });

  ok((await host.handlers['talk.setProviderKey']('gemini', 'not-a-key')) === false, 'setProviderKey answers a boolean (false for a bad shape)');
  ok((await host.handlers['talk.setProviderKey']('gemini', GEMINI_KEY)) === true, 'setProviderKey answers true for a stored key');
  ok((await host.handlers['talk.setProviderKey']('nope', GEMINI_KEY)) === false, 'an unknown provider id answers false');
  ok((await host.handlers['talk.clearProviderKey']('gemini')) === true && (await host.handlers['talk.setProviderKey']('gemini', GEMINI_KEY)) === true, 'clearProviderKey answers true and the key can be set again');

  const SENTINELS = {
    'leda-key.bin': `AIza${'L'.repeat(35)}`,
    'gemini-tts-key.bin': GEMINI_KEY,
    'elevenlabs-key.bin': ELEVEN_KEY,
    'custom-openai-tts-key.bin': OPENAI_KEY,
    'custom-zumia-tts-key.bin': ZUMIA_KEY,
  };
  for (const [file, key] of Object.entries(SENTINELS)) {
    const id = file.startsWith('leda') ? 'google' : file.startsWith('gemini') ? 'gemini' : file.startsWith('eleven') ? 'elevenlabs' : file.includes('openai') ? 'http-openai' : 'http-zumia';
    const okWrite = await host.handlers['talk.setProviderKey'](id, key);
    ok(okWrite === true && fs.existsSync(path.join(dir, file)), `fixture: ${id}'s key is stored in ${file}`);
  }
  const replies = [
    await host.handlers['talk.voiceProviders'](),
    host.handlers['talk.getVoicePrefs'](),
    host.handlers['talk.voiceState'](),
    await host.handlers['talk.voiceInfo'](),
    host.handlers['talk.setVoicePrefs']({ speed: 1.1 }),
    host.handlers['talk.openGuide'](),
  ];
  const replyText = JSON.stringify(replies);
  ok(Object.values(SENTINELS).every((k) => !replyText.includes(k)), 'no sentinel key appears in any rpc-shaped reply');
  ok(!logs.join('\n').includes(SENTINELS['gemini-tts-key.bin']) && !logs.join('\n').includes(SENTINELS['elevenlabs-key.bin']), 'no sentinel key appears in the sidecar log lines');
  const files = fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile());
  const leaks = files.filter((f) => !Object.prototype.hasOwnProperty.call(SENTINELS, f) && Object.values(SENTINELS).some((k) => fs.readFileSync(path.join(dir, f)).includes(Buffer.from(k))));
  ok(leaks.length === 0, 'a sentinel key is in no data-dir file but its own encrypted blob', leaks.join(','));
  ok(files.length >= Object.keys(SENTINELS).length, 'all five key files exist (Leda + the three talk-mode files, incl. both custom bearers)');

  const list = await host.handlers['talk.voiceProviders']();
  ok(list.every((p) => Object.keys(p).every((k) => ['id', 'langs', 'paid', 'needsKey', 'keyOptional', 'hasKey'].includes(k))), 'voiceProviders carries hasKey only (no key field)', stable(list[0]));
  ok(list.find((p) => p.id === 'gemini').hasKey === true && list.find((p) => p.id === 'google').hasKey === true, 'hasKey reflects the stored keys');
  ok(list.some((p) => p.id === 'kokoro' && p.hasKey === true), 'kokoro is advertised (this tree resolves kokoro-js) with hasKey only');
  // ... and it is NOT advertised when the build cannot run it (kokoro-js absent).
  const noKokoro = makeHost(freshDir('no-kokoro', {}), { kokoro: fakeKokoro({ available: false }) });
  ok(!(await noKokoro.host.handlers['talk.voiceProviders']()).some((p) => p.id === 'kokoro'), 'a build with no kokoro-js does not advertise a Kokoro voice it cannot run');
}

// ---------------------------------------------------------------- 3b. part 2: Kokoro, the Windows voice, ttsMore, ttsAbandon
{
  // Prefetch at start, in the background, unless voice is off (main.js:2039) -- including the progress push.
  const on = makeHost(freshDir('p2-prefetch', {}), {});
  ok(on.kokoro.calls.prefetch === 1, 'voice on: Kokoro prefetches at sidecar start (as before R1)');
  ok(on.events.some((e) => e.channel === 'talk:kokoroProgress' && e.payload.phase === 'onnx/model_fp16.onnx' && e.payload.total === 160), 'prefetch progress crosses on talk:kokoroProgress', JSON.stringify(on.events));
  const off = makeHost(freshDir('p2-prefetch-off', { voiceEnabled: false }), {});
  off.host.prewarm('typing');
  ok(off.kokoro.calls.prefetch === 0, 'voice off: no prefetch at start, no pre-warm');
  const skipped = makeHost(freshDir('p2-prefetch-arg', {}), { prefetch: false });
  ok(skipped.kokoro.calls.prefetch === 0, '--no-voice-prefetch (the fixture skip): no prefetch');
  ok(on.kokoro.calls.speed[0] === 1, 'the saved voiceSpeed is pushed to Kokoro at start');

  // T-31-TAURI R1: Kokoro not ready means the reply WAITS for the load (never the Windows voice), then plays with Kokoro.
  const sapiHost = makeHost(freshDir('p2-sapi', {}), { kokoro: fakeKokoro({ ready: false, sentences: [Buffer.from('RIFF-wait')] }), sapi: fakeSapi() });
  const spoken = await sapiHost.host.handlers['talk.tts']({ text: 'Hello there', turnId: 'p2-sapi' });
  ok(spoken.ok === true && spoken.voice === 'af_heart' && sapiHost.sapi.calls === 0, 'kokoro not ready: the reply waits for the load and plays with Kokoro, never the Windows voice', stable(spoken));
  ok(sapiHost.base.calls.length === 0, 'the local voice route makes no network call');

  // Kokoro ready: sentence 1 is the reply, sentence 2+ arrive on talk:ttsMore. A sentence over the 512 KB event cap
  // is split into parts that each fit, reassembled byte-equal by the shim.
  const first = Buffer.from('RIFF-first');
  const big = crypto.randomBytes(600 * 1024 + 13); // random + odd length over 512 KB: padding and part boundaries are exercised
  const readyHost = makeHost(freshDir('p2-kokoro', {}), { kokoro: fakeKokoro({ ready: true, sentences: [first, big] }) });
  const r = await readyHost.host.handlers['talk.tts']({ text: 'Two sentences here.', turnId: 'p2-kokoro' });
  ok(r.ok === true && r.voice === 'af_heart' && r.audios.length === 1 && Buffer.compare(r.audios[0], first) === 0, 'kokoro ready: talk.tts resolves with sentence 1', stable({ ok: r.ok, voice: r.voice, n: r.audios && r.audios.length }));
  ok(readyHost.sapi.calls === 0, 'kokoro ready: the Windows voice is not touched');

  const more = readyHost.events.filter((e) => e.channel === 'talk:ttsMore').map((e) => e.payload);
  ok(more.length >= 2, 'sentence 2 arrives on talk:ttsMore as one or more events', `${more.length}`);
  ok(more.every((p) => payloadBytes(p) <= MAX_EVENT_PAYLOAD_BYTES), 'every talk:ttsMore frame fits the 512 KB event cap', more.map(payloadBytes).join(','));
  const parts = more.filter((p) => p.parts > 1);
  ok(parts.length >= 2 && parts.every((p) => p.chunk === more[0].chunk), 'a sentence over 512 KB is split into parts of one chunk (not dropped)');
  const joined = Buffer.concat(more.map((p) => decodeBinary(p.audio)));
  ok(joined.length === big.length && joined.equals(big), 'the split parts re-assemble byte-equal', `${joined.length}/${big.length}`);

  // The shim side: the renderer receives ONE Uint8Array for the logical sentence, byte-equal to the original.
  const listeners = new Map();
  const win = { __TAURI__: { core: { invoke: () => new Promise(() => {}) }, event: { listen: (ch, h) => { listeners.set(ch, [...(listeners.get(ch) || []), h]); return Promise.resolve(() => {}); } } }, console };
  vm.runInNewContext(read('tauri', 'shim', 'zumi-shim.js'), { window: win, Promise, URL, console });
  const got = [];
  win.zumi.talk.onTtsMore('p2-kokoro', (a) => got.push(a));
  const got2 = [];
  win.zumi.talk.onTtsMore('p2-kokoro', (a) => got2.push(a)); // a second listener on the same turn
  await new Promise((res) => setTimeout(res, 10));
  for (const p of [...more].reverse()) for (const h of listeners.get('talk:ttsMore')) h({ payload: encodeBinary(p) }); // parts arrive out of order
  ok(got.length === 1 && Object.prototype.toString.call(got[0]) === '[object Uint8Array]' && Buffer.from(got[0]).equals(big), 'the shim delivers one Uint8Array, byte-equal (one append per sentence)', `${got.length} ${got[0] && got[0].length}`);

  ok(got2.length === 1 && Buffer.from(got2[0]).equals(big), 'a second listener on the same turn also gets the sentence', `${got2.length}`);

  // ttsAbandon: barge-in stops the turn's later sentences (both the Electron object and the shim's string).
  ok(readyHost.host.handlers['talk.ttsAbandon']({ turnId: 'p2-kokoro' }) === true && readyHost.kokoro.calls.abandon.includes('p2-kokoro'), 'ttsAbandon abandons the turn ({ turnId })');
  ok(readyHost.host.handlers['talk.ttsAbandon']('p2-other') === true && readyHost.kokoro.calls.abandon.includes('p2-other'), 'ttsAbandon accepts the shim\'s string turnId');
  ok(readyHost.host.handlers['talk.ttsAbandon']({}) === true && readyHost.host.handlers['talk.ttsAbandon'](null) === true, 'ttsAbandon with no turnId is a no-op that still answers true');

  // voiceInfo / voiceState are the engines' own answers, not a constant.
  ok(stable(await readyHost.host.handlers['talk.voiceInfo']()) === stable({ mode: 'kokoro', voice: 'af_heart' }), 'voiceInfo reports Kokoro when it is available');
  ok(stable(readyHost.host.handlers['talk.voiceState']()) === stable({ state: 'ready', phase: null, loaded: 0, total: 0, error: null }), 'voiceState reports the prefetch state');
  const sapiOnly = makeHost(freshDir('p2-sapi-info', {}), { kokoro: fakeKokoro({ available: false }), sapi: fakeSapi() });
  ok(stable(await sapiOnly.host.handlers['talk.voiceInfo']()) === stable({ mode: 'windows', voice: 'Microsoft Zira Desktop' }), 'without Kokoro voiceInfo reports the Windows voice');
  ok(stable(sapiOnly.host.handlers['talk.voiceState']()) === stable({ state: 'off', phase: null, loaded: 0, total: 0, error: null }), 'without Kokoro voiceState is the off shape');
}

// ---------------------------------------------------------------- 3c. the sidecar's default kokoro factory carries the egress rule
{
  workerSpawns.length = 0;
  const dir = freshDir('default-kokoro-egress', {});
  const st = fileStore(dir);
  // No kokoroFactory override: this is the DEFAULT the sidecar itself builds.
  const host = createVoiceHost({
    dataDir: dir,
    settings: st.get, saveSettings: st.set,
    secretStores: async () => createSecretStores({ safeStorage: fakeSafe, dataDir: dir }),
    flavour: { values: {} },
    ttsFetchFor: (id) => ttsFetch(recorder(), id, () => {}),
    prefetch: false, // no model work -- ensureReady() below only reaches the spy Worker constructor
  });
  host.kokoro.ensureReady().catch(() => {}); // the spy never answers 'ready'; the spawn itself is what is asserted
  ok(workerSpawns.length === 1, 'the default kokoro factory spawns exactly one Worker', `${workerSpawns.length}`);
  const wd = workerSpawns[0] && workerSpawns[0].opts && workerSpawns[0].opts.workerData;
  ok(wd && wd.egress === 'hf-only', 'the sidecar\'s DEFAULT kokoro factory builds its Worker with workerData.egress === "hf-only"', stable(wd));
  // Probe P4 logged "unparseable line" once per Kokoro turn: kokoro-worker.mjs writes "[kokoro-worker] ..." to
  // process.stdout, which in the sidecar is the JSON-RPC wire. stdout:true + a stderr forward keeps it off the wire.
  const rec = workerSpawns[0];
  ok(rec && rec.opts && rec.opts.stdout === true, 'the default Worker is created with stdout:true (no automatic pipe to the sidecar RPC stdout)', stable(rec && rec.opts && rec.opts.stdout));
  const listener = rec && rec.stdoutListeners.find((x) => x.ev === 'data');
  ok(Boolean(listener), 'the worker stdout is forwarded explicitly (worker.stdout data listener)', stable(rec && rec.stdoutListeners));
  if (listener) {
    const writes = [];
    const orig = process.stderr.write;
    process.stderr.write = (chunk) => { writes.push(String(chunk)); return true; };
    try { listener.fn(Buffer.from('[kokoro-worker] turn=abc chunk0 synthMs=5\n')); } finally { process.stderr.write = orig; }
    ok(writes.join('').includes('[kokoro-worker] turn=abc'), 'worker log lines go to stderr, never the sidecar\'s stdout', writes.join('|'));
  }
  host.dispose();
}

// ---------------------------------------------------------------- 5. over the real stdio protocol
function startSidecar(dataDir) {
  // --no-voice-prefetch: this check must never download the ~163 MB Kokoro model (the sidecar's equivalent of
  // Electron's --settings-shots skip). Every other part-2 path (worker, SAPI, ttsMore) is covered by the host section.
  const child = spawn(process.execPath, [SIDECAR, '--data-dir', dataDir, '--no-voice-prefetch'], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
  const rl = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  const events = [];
  let stderr = '';
  let nextId = 1;
  let readyResolve;
  const ready = new Promise((r) => { readyResolve = r; });
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  child.once('exit', (code) => { for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error(`sidecar exited (${code})`)); } pending.clear(); });
  rl.on('line', (line) => {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m.method === 'ready') readyResolve();
    else if (m.method === 'event') events.push(m.params);
    else if (m.id != null && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); clearTimeout(p.timer); p.resolve(m); }
  });
  return {
    child, events, stderrText: () => stderr, ready,
    request(method, params = []) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout waiting for ${method}`)); }, 30000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
    close() { child.stdin.end(); return new Promise((r) => child.on('close', r)); },
  };
}

{
  const dir = freshDir('rpc-plain', {});
  const c = startSidecar(dir);
  await c.ready;

  const info = (await c.request('talk.voiceInfo')).result;
  ok(info && info.mode === 'kokoro' && info.voice === 'af_heart', 'talk.voiceInfo: Kokoro when this build can run it', stable(info));
  const state = (await c.request('talk.voiceState')).result;
  ok(stable(state) === stable({ state: 'idle', phase: null, loaded: 0, total: 0, error: null }), 'talk.voiceState: idle before any prefetch (--no-voice-prefetch), Electron\'s own shape', stable(state));
  const providers = (await c.request('talk.voiceProviders')).result;
  ok(Array.isArray(providers) && providers.length === 6 && providers[0].id === 'kokoro' && providers.slice(1).every((p) => p.hasKey === false), 'talk.voiceProviders: Kokoro + the five BYO cloud providers, no key stored yet', stable(providers));
  ok((await c.request('talk.setProviderKey', ['gemini', 'not-a-key'])).result === false, 'talk.setProviderKey answers false for a bad shape');
  ok((await c.request('talk.clearProviderKey', ['gemini'])).result === true, 'talk.clearProviderKey answers true');

  const set = (await c.request('talk.setVoicePrefs', [{ providerEn: 'gemini', providerVi: 'elevenlabs', voiceReplyLang: 'vi', speed: 9, volume: -2, voiceEleven: { voiceId: VOICE_ID } }])).result;
  ok(set.voiceProviderEn === 'gemini' && set.voiceProviderVi === 'elevenlabs' && set.voiceReplyLang === 'vi' && set.speed === 1.5 && set.volume === 0 && set.voiceEleven.voiceId === VOICE_ID, 'talk.setVoicePrefs clamps, validates and persists the prefs', stable(set));
  ok((await c.request('talk.setVoicePrefs', ['bad'])).result.speed >= 0.75, 'talk.setVoicePrefs answers the current prefs for a non-object patch');
  ok((await c.request('talk.setVoicePrefs', [{ providerVi: 'zumia-owner' }])).result.voiceProviderVi === 'elevenlabs', 'without the owner flag zumia-owner is refused by the setter');

  // No keys, so these are the no-key paths: the adapters answer before any fetch (the sidecar has a real fetch).
  const noKey = (await c.request('talk.testVoice', [{ lang: 'en', text: 'Hello' }])).result;
  ok(noKey && noKey.ok === false && noKey.reason === 'no_key', 'talk.testVoice with no key answers no_key, never a network call', stable(noKey));
  const noKeyTts = (await c.request('talk.tts', [{ text: 'Hello', turnId: 'rpc-1' }])).result;
  ok(noKeyTts && noKeyTts.ok === false && noKeyTts.error && noKeyTts.error.code === 'no_key', 'talk.tts with no key answers the typed no_key (no fallback)', stable(noKeyTts));

  ok((await c.request('talk.openGuide', ['google'])).result === false, 'a talk.openGuide call that reaches the sidecar opens nothing (Rust intercepts it)');
  const verdict = (await c.request('__host.voiceGuideVerdict', ['gemini'])).result;
  ok(verdict && verdict.action === 'openExternal' && verdict.url === VOICE_GUIDES.gemini, '__host.voiceGuideVerdict resolves a known guide id from the fixed table', stable(verdict));
  const refused = (await c.request('__host.voiceGuideVerdict', ['https://evil.example'])).result;
  ok(refused && refused.action === 'refuse', '__host.voiceGuideVerdict refuses a non-id (a URL from the page never opens)');
  const abandon = await c.request('talk.ttsAbandon', [{ turnId: 'rpc-abandon' }]);
  ok(abandon.result === true, 'talk.ttsAbandon answers true over the real rpc (part 2)');
  ok((await c.request('talk.ttsAbandon', ['rpc-abandon'])).result === true, 'talk.ttsAbandon accepts the shim\'s string turnId');

  const names = new Set(sidecarHandlerNames(read('tauri', 'sidecar', 'main.mjs')));
  const part2 = ['talk.tts', 'talk.ttsAbandon', 'talk.voiceInfo', 'talk.voiceState', 'talk.voiceProviders', 'talk.setProviderKey', 'talk.clearProviderKey', 'talk.setVoicePrefs', 'talk.testVoice', 'talk.openGuide'];
  ok(part2.every((n) => names.has(n)), 'all 10 step-8b names are in the sidecar handler table', part2.filter((n) => !names.has(n)).join(','));
  ok(!/AIza|sk_|bearer/.test(c.stderrText()), 'the sidecar stderr carries no key material');
  await c.close();
}

// ---- 6. `$bin`: audio from a real provider crosses the stdio frame as base64, never as a Buffer JSON blob ----
{
  const wav = Buffer.from('RIFF-sidecar-bin-test');
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ audios: [wav.toString('base64')], voice: 'loopback' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const dir = freshDir('rpc-bin', { voiceProviderEn: 'http-zumia', voiceCustomZumia: { url: `http://127.0.0.1:${port}/tts` } });
  const c = startSidecar(dir);
  try {
    await c.ready;
    const r = await c.request('talk.tts', [{ text: 'Hello bytes', turnId: 'rpc-bin' }]);
    const result = r.result;
    ok(result && result.ok === true && Array.isArray(result.audios) && result.audios.length === 1, 'a loopback custom provider synthesizes over the real sidecar', stable(result).slice(0, 160));
    const row = result.audios[0];
    ok(row && typeof row.$bin === 'string' && !('type' in row) && !('data' in row), 'the response frame carries {"$bin": base64}, not a Buffer JSON blob', JSON.stringify(row).slice(0, 80));
    const decoded = decodeBinary(row);
    ok(Buffer.isBuffer(decoded) && decoded.equals(wav), '$bin decodes byte-equal to the provider\'s audio', `${decoded.length}/${wav.length}`);
    // The shim's own decoder (the renderer side) turns it into a Uint8Array, byte-equal.
    const listeners = new Map();
    const win = { __TAURI__: { core: { invoke: () => Promise.resolve(r.result) }, event: { listen: () => Promise.resolve(() => {}) } }, console };
    vm.runInNewContext(read('tauri', 'shim', 'zumi-shim.js'), { window: win, Promise, URL, console });
    const back = await win.zumi.talk.tts({ text: 'Hello bytes', turnId: 'rpc-bin' });
    // Cross-realm: the shim's Uint8Array is a vm intrinsic, so check the tag + bytes, not host `instanceof`.
    const tag = back.audios[0] && Object.prototype.toString.call(back.audios[0]);
    ok(tag === '[object Uint8Array]' && Buffer.from(back.audios[0]).equals(wav), 'the shim resolves talk.tts with a Uint8Array, byte-equal (renderer unchanged)', `${tag}`);
    // The vm context above has no `atob`, so it only ever exercises the pure-JS fallback. A webview has atob: run
    // the same call with it present and prove the declared fast path is taken and still byte-equal.
    let atobCalls = 0;
    const atob = (s) => { atobCalls++; return Buffer.from(String(s), 'base64').toString('latin1'); };
    const winFast = { __TAURI__: { core: { invoke: () => Promise.resolve(r.result) }, event: { listen: () => Promise.resolve(() => {}) } }, console };
    vm.runInNewContext(read('tauri', 'shim', 'zumi-shim.js'), { window: winFast, Promise, URL, console, atob });
    const fast = await winFast.zumi.talk.tts({ text: 'Hello bytes', turnId: 'rpc-bin-fast' });
    const fastTag = fast.audios[0] && Object.prototype.toString.call(fast.audios[0]);
    ok(atobCalls === 1 && fastTag === '[object Uint8Array]' && Buffer.from(fast.audios[0]).equals(wav), 'with atob present the shim takes the base64 fast path and decodes byte-equal', `atobCalls=${atobCalls} ${fastTag}`);
  } finally {
    server.close();
    await c.close();
  }
}

{
  // The owner flag from owner-voice.json, read by the real sidecar.
  const dir = freshDir('rpc-owner', { voiceProviderVi: 'off' }, { v: 1, zumiaVoice: true });
  const c = startSidecar(dir);
  await c.ready;
  const prefs = (await c.request('talk.getVoicePrefs')).result;
  ok(prefs.voiceProviderVi === 'off', 'an explicit saved VI choice still wins with the owner flag on');
  ok((await c.request('talk.setVoicePrefs', [{ providerVi: 'zumia-owner' }])).result.voiceProviderVi === 'zumia-owner', 'with the owner flag the setter accepts zumia-owner');
  const providers = (await c.request('talk.voiceProviders')).result;
  ok(providers.some((p) => p.id === 'zumia-owner'), 'the owner flag adds zumia-owner over the real rpc');
  await c.close();
}

fs.rmSync(work, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
