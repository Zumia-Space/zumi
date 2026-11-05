// BYO voice providers, plain Node, no Electron, no network, NO paid call (T-31 talk-mode, PLAN section 10.5).
// Covers the shared key store, every adapter (Google leda-tts.js, Gemini tts-gemini.js, ElevenLabs tts-elevenlabs.js,
// the custom HTTP shapes + owner Zumia route in tts-http.js), the URL rules and config patching, the owner flag parser,
// the resolveVoice table, and scripts/owner-voice.mjs. Each adapter: exact request shape, response parsing, error
// mapping, and "the key never leaks" (error strings, thrown messages, logs, URLs).
// Isolation: the global fetch is replaced by a stub that throws, so any adapter that forgets to use its injected
// fetchImpl fails the run instead of reaching the network.
//   node scripts/check-tts-providers.mjs   (exit 1 on any failure)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createKeyStore } = require('../src/main/tts-keys.js');
const { createLedaTts, KEY_SHAPE } = require('../src/main/leda-tts.js');
const { createHttpTts, ZUMIA_OWNER_URL, CUSTOM_KEY_FILES, LEGACY_CUSTOM_KEY_FILE, migrateLegacyCustomKey } = require('../src/main/tts-http.js');
const { createGeminiTts } = require('../src/main/tts-gemini.js');
const { createElevenTts } = require('../src/main/tts-elevenlabs.js');
const { validateCustomUrl } = require('../src/main/tts-common.js');
const { resolveVoice, voiceProviderPrefs, readOwnerVoiceFlag, voiceConfig, patchVoiceConfig, OWNER_PROVIDER } = require('../src/main/tts-select.js');
const { runOwnerVoice, FLAG_NAME } = await import('./owner-voice.mjs');

let pass = 0, fail = 0;
const ok = (cond, name, detail) => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Every un-injected fetch throws: a missing fetchImpl is a failed run, never a network call.
globalThis.fetch = () => { throw new Error('un-injected global fetch was called'); };

const KEY = 'AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ0123456'; // well-shaped Google key
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zumi-tts-prov-'));
const fakeSafe = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(`enc:${s}`, 'utf8'), decryptString: (b) => b.toString('utf8').replace(/^enc:/, '') };

// A fake fetch Response: text() for the legacy adapter, arrayBuffer() for the shared reader (tts-common.readCapped).
const toAb = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const jsonRes = (status, body, headers = {}) => {
  const txt = typeof body === 'string' ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, headers: { get: (k) => headers[String(k).toLowerCase()] || null }, text: async () => txt, arrayBuffer: async () => toAb(Buffer.from(txt)) };
};
const binRes = (status, bytes, contentType) => ({ ok: status >= 200 && status < 300, status, headers: { get: (k) => ({ 'content-type': contentType }[String(k).toLowerCase()] || null) }, text: async () => Buffer.from(bytes).toString('utf8'), arrayBuffer: async () => toAb(Buffer.from(bytes)) });
const timeoutErr = () => { const e = new Error('timed out'); e.name = 'TimeoutError'; return e; };

// ---------- 1. the shared key store ----------
{
  const dir = fs.mkdtempSync(path.join(tmp, 'keys-'));
  const ks = createKeyStore({ safeStorage: fakeSafe, dir, file: 'x-key.bin', importFile: 'x-key.import', shape: KEY_SHAPE, log: () => {} });
  ok(ks.read() === null, 'keys: no file -> no key');
  ok(ks.write('not-a-key') === false, 'keys: a bad shape is refused before disk');
  ok(ks.write(KEY) === true && ks.read() === KEY, 'keys: a good key round-trips through the OS encryption');
  ks.clear();
  ok(ks.read() === null, 'keys: clear() removes it');

  // one-time import: written once, read back, the plaintext import destroyed
  fs.writeFileSync(path.join(dir, 'y-key.import'), KEY);
  const ks2 = createKeyStore({ safeStorage: fakeSafe, dir, file: 'y-key.bin', importFile: 'y-key.import', shape: KEY_SHAPE, log: () => {} });
  ok(ks2.importIfPresent() === 'imported' && ks2.read() === KEY && !fs.existsSync(path.join(dir, 'y-key.import')), 'keys: an import file is encrypted into the bin and destroyed');

  // no OS encryption -> no plaintext fallback (write refuses, read is null)
  const noEnc = { isEncryptionAvailable: () => false, encryptString: () => Buffer.from(''), decryptString: () => '' };
  const ks3 = createKeyStore({ safeStorage: noEnc, dir, file: 'z-key.bin', shape: KEY_SHAPE, log: () => {} });
  ok(ks3.write(KEY) === false && ks3.read() === null && !fs.existsSync(path.join(dir, 'z-key.bin')), 'keys: no OS encryption -> write refused, nothing written (no plaintext fallback)');

  // a pre-existing leda-key.bin is read by the google provider (no key migration needed)
  const google = createLedaTts({ safeStorage: fakeSafe, dir, fetchImpl: async () => { throw new Error('no call'); } });
  ok(google.hasKey() === false, 'migration: a fresh google provider has no key');
  fs.writeFileSync(path.join(dir, 'leda-key.bin'), fakeSafe.encryptString(KEY));
  const google2 = createLedaTts({ safeStorage: fakeSafe, dir, fetchImpl: async () => { throw new Error('no call'); } });
  ok(google2.hasKey() === true, 'migration: an existing leda-key.bin is picked up by the google provider (same file name, no migration)');
}

// ---------- 2. Google (leda-tts.js) ----------
{
  const dir = fs.mkdtempSync(path.join(tmp, 'google-'));
  const made = [];
  const mk = (res, key = KEY) => {
    const calls = [];
    const a = createLedaTts({ safeStorage: fakeSafe, dir, fetchImpl: async (url, init) => { calls.push({ url, init }); return typeof res === 'function' ? res() : res; }, log: () => {} });
    a.setKey(key);
    return { a, calls };
  };

  // no key -> no_key, zero network
  {
    const a = createLedaTts({ safeStorage: fakeSafe, dir, fetchImpl: async () => { throw new Error('must not call'); }, log: () => {} });
    const r = await a.synthesize('Xin chào');
    ok(r.ok === false && r.error.code === 'no_key', 'google: no key -> no_key, no call', r);
  }

  // the vi request
  {
    const { a, calls } = mk(jsonRes(200, { audioContent: Buffer.from('wav').toString('base64') }));
    const r = await a.synthesize('Zumi dùng AI để trả lời', 'vi');
    ok(r.ok === true && r.mime === 'audio/wav' && r.voice === 'vi-VN-Chirp3-HD-Leda', 'google: vi -> WAV, vi-VN Chirp3-HD Leda', r);
    const c = calls[0];
    ok(c.url === 'https://texttospeech.googleapis.com/v1/text:synthesize' && !c.url.includes(KEY) && c.init.headers['x-goog-api-key'] === KEY && c.init.method === 'POST' && c.init.redirect === 'error' && c.init.headers['content-type'] === 'application/json' && Boolean(c.init.signal), 'google: POST to the endpoint with the key in ?key=, redirect:error and a timeout signal', c.init && { method: c.init.method, redirect: c.init.redirect, headers: c.init.headers });
    const body = JSON.parse(c.init.body);
    ok(body.input.text === 'Zumi dùng Ây Ai để trả lời' && body.voice.languageCode === 'vi-VN' && body.voice.name === 'vi-VN-Chirp3-HD-Leda', 'google: vi body carries viTtsText and the vi voice', body);
  }
  // the en request: NO viTtsText substitution, the en voice
  {
    const { a, calls } = mk(jsonRes(200, { audioContent: Buffer.from('wav').toString('base64') }));
    const r = await a.synthesize('AI is here', 'en');
    const body = JSON.parse(calls[0].init.body);
    ok(r.voice === 'en-US-Chirp3-HD-Leda' && body.input.text === 'AI is here' && body.voice.languageCode === 'en-US', 'google: en -> en-US voice, text NOT run through viTtsText', { voice: r.voice, text: body.input.text });
  }
  // a custom voice name from settings.json
  {
    const calls = [];
    const a = createLedaTts({ safeStorage: fakeSafe, dir, getConfig: () => ({ voiceGoogle: { vi: 'vi-VN-Wavenet-A' } }), fetchImpl: async (u, i) => { calls.push(i); return jsonRes(200, { audioContent: '' }); } });
    a.setKey(KEY);
    await a.synthesize('xin chào', 'vi');
    ok(JSON.parse(calls[0].body).voice.name === 'vi-VN-Wavenet-A', 'google: the voice name comes from settings.json voiceGoogle when set');
  }
  // error mapping
  for (const [status, code, retryable] of [[401, 'auth_failed', false], [403, 'auth_failed', false], [429, 'rate_limited', true], [502, 'http_502', true]]) {
    const { a } = mk(jsonRes(status, 'nope'));
    const r = await a.synthesize('x', 'vi');
    ok(r.ok === false && r.error.code === code && r.error.retryable === retryable, `google: HTTP ${status} -> ${code} (retryable=${retryable})`, r.error);
  }
  // the key is scrubbed from an error body
  {
    const { a } = mk(jsonRes(500, `boom key=${KEY}`));
    const r = await a.synthesize('x', 'vi');
    ok(r.ok === false && !r.error.message.includes(KEY) && r.error.message.includes('***'), 'google: the key is scrubbed from an error string', r.error);
  }
  // abort -> timeout; oversized -> too_large; missing audioContent -> bad_response
  {
    const { a } = mk(async () => { throw timeoutErr(); });
    const r = await a.synthesize('x', 'vi');
    ok(r.ok === false && r.error.code === 'timeout', 'google: an aborted request -> timeout', r.error);
  }
  {
    const big = `{"audioContent":"${'A'.repeat(10 * 1024 * 1024 + 8)}"}`;
    const { a } = mk(jsonRes(200, big));
    const r = await a.synthesize('x', 'vi');
    ok(r.ok === false && r.error.code === 'too_large', 'google: a response over 10 MB -> too_large', r.error);
  }
  {
    const { a } = mk(jsonRes(200, { nope: 1 }));
    const r = await a.synthesize('x', 'vi');
    ok(r.ok === false && r.error.code === 'bad_response', 'google: no audioContent -> bad_response', r.error);
  }
  // short text -> bad_request before any call
  {
    const { a, calls } = mk(jsonRes(200, { audioContent: '' }));
    const r = await a.synthesize('   ', 'vi');
    ok(r.ok === false && r.error.code === 'bad_request' && calls.length === 0, 'google: empty text -> bad_request, no call', r.error);
  }
}

// ---------- 3. Zumia (tts-http.js, shape 'zumia') ----------
{
  const mk = (res, opts = {}) => {
    const calls = [];
    const a = createHttpTts({ id: 'zumia-owner', url: ZUMIA_OWNER_URL, langs: ['vi'], paid: false, needsKey: false, shape: 'zumia', fetchImpl: async (url, init) => { calls.push({ url, init }); return typeof res === 'function' ? res() : res; }, log: () => {}, ...opts });
    return { a, calls };
  };
  {
    const { a, calls } = mk(jsonRes(200, { audios: [Buffer.from('mp3').toString('base64')] }));
    const r = await a.synthesize('Xin chào anh', 'vi');
    ok(r.ok === true && r.mime === 'audio/mpeg' && r.audios[0].toString() === 'mp3', 'zumia: audios[] -> MP3', r);
    const c = calls[0];
    ok(c.url === ZUMIA_OWNER_URL && c.init.method === 'POST' && c.init.redirect === 'error' && JSON.parse(c.init.body).text === 'Xin chào anh' && Boolean(c.init.signal), 'zumia: POST {text} (20 s budget, redirect:error, timeout signal)', c.init && { url: c.url, body: JSON.parse(c.init.body) });
    ok(!('authorization' in c.init.headers), 'zumia: no bearer is ever sent to zumia.space');
  }
  // the audio-only fallback
  {
    const { a } = mk(jsonRes(200, { audio: Buffer.from('mp3').toString('base64') }));
    const r = await a.synthesize('x', 'vi');
    ok(r.ok === true && r.audios.length === 1, 'zumia: the {audio} fallback works (cloud.js parse rule)');
  }
  // unsupported language -> no call
  {
    const { a, calls } = mk(jsonRes(200, {}));
    const r = await a.synthesize('hello', 'en');
    ok(r.ok === false && r.error.code === 'unsupported_lang' && calls.length === 0, 'zumia: en is not served -> unsupported_lang, no call', r.error);
  }
  // missing audio -> bad_response; 429 -> rate_limited; abort -> timeout
  {
    const { a } = mk(jsonRes(200, { nope: 1 }));
    ok((await a.synthesize('x', 'vi')).error.code === 'bad_response', 'zumia: no audio -> bad_response');
  }
  {
    const { a } = mk(jsonRes(429, { error: 'slow down' }));
    const r = await a.synthesize('x', 'vi');
    ok(r.ok === false && r.error.code === 'rate_limited' && r.error.retryable === true, 'zumia: 429 -> rate_limited (retryable)', r.error);
  }
  {
    const { a } = mk(async () => { throw timeoutErr(); });
    ok((await a.synthesize('x', 'vi')).error.code === 'timeout', 'zumia: an abort -> timeout');
  }
  // the owner instance's own key does go to the owner constant (owner 02-11: the route becomes owner-only; section 3c)
  {
    const { a, calls } = mk(jsonRes(200, { audio: '' }), { needsKey: true, keyFile: 'z.bin', safeStorage: fakeSafe, dir: tmp, keyShape: /^[A-Za-z0-9_-]{20,200}$/ });
    a.setKey('zzzzzzzzzzzzzzzzzzzzzzzz'); // 24 chars, matches the loose shape
    await a.synthesize('x', 'vi');
    ok(calls[0].init.headers.authorization === 'Bearer zzzzzzzzzzzzzzzzzzzzzzzz', 'zumia-owner: its own key goes to the owner constant');
  }
}

// ---------- 3b. Gemini (tts-gemini.js, Interactions API) ----------
const GEMINI_KEY = `AIza${'Q'.repeat(35)}`;
{
  const dir = fs.mkdtempSync(path.join(tmp, 'gemini-'));
  const logs = [];
  const mk = (res, cfg) => {
    const calls = [];
    const a = createGeminiTts({ safeStorage: fakeSafe, dir, getConfig: cfg ? () => cfg : undefined, log: (m) => logs.push(m), fetchImpl: async (url, init) => { calls.push({ url, init }); return typeof res === 'function' ? res() : res; } });
    a.setKey(GEMINI_KEY);
    return { a, calls };
  };
  const wav = Buffer.from('RIFFxxxxWAVE');
  const interaction = (data = wav.toString('base64')) => ({ steps: [{ type: 'user_input', content: [{ type: 'text', text: 'x' }] }, { type: 'model_output', content: [{ type: 'text', text: 'ok' }, { type: 'audio', data }] }] });

  {
    const a = createGeminiTts({ safeStorage: fakeSafe, dir: fs.mkdtempSync(path.join(tmp, 'gemini-nokey-')), fetchImpl: async () => { throw new Error('must not call'); } });
    const r = await a.synthesize('hello', 'en');
    ok(r.ok === false && r.error.code === 'no_key' && a.hasKey() === false, 'gemini: no key -> no_key, no call', r);
  }
  {
    const { a, calls } = mk(jsonRes(200, interaction()));
    const r = await a.synthesize('Xin chào anh', 'vi');
    ok(r.ok === true && r.mime === 'audio/wav' && r.audios[0].equals(wav) && r.voice === 'gemini-3.8-flash-tts/Kore', 'gemini: steps[model_output].content[audio].data -> WAV (24 kHz mono s16le per the docs)', r);
    const c = calls[0];
    ok(c.url === 'https://generativelanguage.googleapis.com/v1beta/interactions' && c.init.method === 'POST', 'gemini: POST to the Interactions endpoint (not generateContent)', c.url);
    ok(c.init.headers['x-goog-api-key'] === GEMINI_KEY && !c.url.includes(GEMINI_KEY) && !c.url.includes('key='), 'gemini: the key travels in x-goog-api-key only, never in the URL');
    ok(c.init.redirect === 'error' && Boolean(c.init.signal), 'gemini: redirect:error and a timeout signal are set');
    const body = JSON.parse(c.init.body);
    ok(body.model === 'gemini-3.8-flash-tts' && body.input[0].type === 'user_input' && body.input[0].content[0].text === 'Xin chào anh' && body.response_format.type === 'audio' && body.generation_config.speech_config[0].voice === 'Kore', 'gemini: body = model + user_input text + response_format audio + speech_config voice', body);
  }
  {
    const { a, calls } = mk(jsonRes(200, interaction()), { voiceGemini: { model: 'gemini-3.8-flash-lite-tts', voice: 'Puck' } });
    const r = await a.synthesize('hi', 'en');
    const body = JSON.parse(calls[0].init.body);
    ok(body.model === 'gemini-3.8-flash-lite-tts' && body.generation_config.speech_config[0].voice === 'Puck' && r.voice === 'gemini-3.8-flash-lite-tts/Puck', 'gemini: the model and voice come from settings.json voiceGemini');
  }
  for (const [status, code, retryable] of [[400, 'http_400', false], [401, 'auth_failed', false], [403, 'auth_failed', false], [429, 'rate_limited', true], [502, 'http_502', true]]) {
    const { a } = mk(jsonRes(status, { error: { message: 'nope' } }));
    const r = await a.synthesize('x', 'en');
    ok(r.ok === false && r.error.code === code && r.error.retryable === retryable, `gemini: HTTP ${status} -> ${code} (retryable=${retryable})`, r.error);
  }
  {
    const { a } = mk(async () => { throw timeoutErr(); });
    ok((await a.synthesize('x', 'en')).error.code === 'timeout', 'gemini: an abort -> timeout');
  }
  {
    const { a } = mk(jsonRes(200, { steps: [{ type: 'model_output', content: [{ type: 'text', text: 'no audio here' }] }] }));
    ok((await a.synthesize('x', 'en')).error.code === 'bad_response', 'gemini: no audio part -> bad_response');
  }
  {
    const { a } = mk(jsonRes(200, 'not json'));
    ok((await a.synthesize('x', 'en')).error.code === 'bad_response', 'gemini: a non-JSON body -> bad_response');
  }
  {
    const { a } = mk(jsonRes(200, `{"steps":[{"type":"model_output","content":[{"type":"audio","data":"${'A'.repeat(10 * 1024 * 1024 + 8)}"}]}]}`));
    ok((await a.synthesize('x', 'en')).error.code === 'too_large', 'gemini: a response over 10 MB -> too_large');
  }
  {
    const { a } = mk(jsonRes(200, { x: 1 }, { 'content-length': String(20 * 1024 * 1024) }));
    ok((await a.synthesize('x', 'en')).error.code === 'too_large', 'gemini: a declared content-length over 10 MB is refused before reading');
  }
  {
    const { a, calls } = mk(jsonRes(200, interaction()));
    ok((await a.synthesize('x', 'fr')).error.code === 'unsupported_lang' && (await a.synthesize('   ', 'en')).error.code === 'bad_request' && (await a.synthesize('y'.repeat(2001), 'en')).error.code === 'bad_request' && calls.length === 0, 'gemini: unsupported lang / empty / over 2000 chars are refused with no call');
  }
  // no key leak: an error body that echoes the key, a thrown error carrying it, and the logs
  {
    const { a } = mk(jsonRes(500, `boom ${GEMINI_KEY}`));
    const r1 = await a.synthesize('x', 'en');
    const { a: b } = mk(async () => { throw new Error(`socket ${GEMINI_KEY} reset`); });
    const r2 = await b.synthesize('x', 'en');
    ok(!JSON.stringify(r1).includes(GEMINI_KEY) && !JSON.stringify(r2).includes(GEMINI_KEY) && r1.error.message.includes('***') && r2.error.message.includes('***'), 'gemini: the key is scrubbed from error bodies and thrown messages');
    ok(!logs.join('\n').includes(GEMINI_KEY), 'gemini: the key never reaches the log');
  }
  ok(fs.existsSync(path.join(dir, 'gemini-tts-key.bin')), 'gemini: the key file is gemini-tts-key.bin');
}

// ---------- 3c. ElevenLabs (tts-elevenlabs.js) ----------
const ELEVEN_KEY = `sk_${'a1'.repeat(16)}`;
const VOICE_ID = 'JBFqnCBsd6RMkjVDRZzb';
{
  const dir = fs.mkdtempSync(path.join(tmp, 'eleven-'));
  const logs = [];
  const mp3 = Buffer.from('ID3mp3bytes');
  const mk = (res, cfg = { voiceEleven: { voiceId: VOICE_ID } }) => {
    const calls = [];
    const a = createElevenTts({ safeStorage: fakeSafe, dir, getConfig: () => cfg, log: (m) => logs.push(m), fetchImpl: async (url, init) => { calls.push({ url, init }); return typeof res === 'function' ? res() : res; } });
    a.setKey(ELEVEN_KEY);
    return { a, calls };
  };
  {
    const { a, calls } = mk(binRes(200, mp3, 'audio/mpeg'));
    const r = await a.synthesize('Xin chào anh', 'vi');
    ok(r.ok === true && r.mime === 'audio/mpeg' && r.audios[0].equals(mp3), 'elevenlabs: bytes -> audio/mpeg', r);
    const c = calls[0];
    ok(c.url === `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}` && c.init.method === 'POST', 'elevenlabs: POST /v1/text-to-speech/{voice_id}', c.url);
    ok(c.init.headers['xi-api-key'] === ELEVEN_KEY && !c.url.includes(ELEVEN_KEY), 'elevenlabs: the key travels in xi-api-key only, never in the URL');
    ok(c.init.redirect === 'error' && Boolean(c.init.signal), 'elevenlabs: redirect:error and a timeout signal are set');
    const body = JSON.parse(c.init.body);
    ok(body.text === 'Xin chào anh' && body.model_id === 'eleven_flash_v2_5' && Object.keys(body).length === 2, 'elevenlabs: body = { text, model_id } and the default model is eleven_flash_v2_5 (Vietnamese-capable)', body);
  }
  // Vietnamese with a model that has none -> unsupported_lang WITHOUT calling fetch (PLAN 10.5)
  {
    const { a, calls } = mk(binRes(200, mp3, 'audio/mpeg'), { voiceEleven: { voiceId: VOICE_ID, model: 'eleven_multilingual_v2' } });
    const r = await a.synthesize('Xin chào', 'vi');
    ok(r.ok === false && r.error.code === 'unsupported_lang' && calls.length === 0, 'elevenlabs: vi + eleven_multilingual_v2 -> unsupported_lang, fetch NOT called', r.error);
    const en = await a.synthesize('hello', 'en');
    ok(en.ok === true && calls.length === 1, 'elevenlabs: the same model still speaks English');
  }
  for (const m of ['eleven_flash_v2_5', 'eleven_v3', 'eleven_v4', 'eleven_v4_turbo']) {
    const { a, calls } = mk(binRes(200, mp3, 'audio/mpeg'), { voiceEleven: { voiceId: VOICE_ID, model: m } });
    const r = await a.synthesize('Xin chào', 'vi');
    ok(r.ok === true && JSON.parse(calls[0].init.body).model_id === m, `elevenlabs: ${m} speaks Vietnamese`);
  }
  {
    const { a, calls } = mk(binRes(200, mp3, 'audio/mpeg'), {});
    const r = await a.synthesize('hello', 'en');
    ok(r.ok === false && r.error.code === 'no_config' && calls.length === 0, 'elevenlabs: no voice id -> no_config, no call', r.error);
  }
  {
    const { a, calls } = mk(binRes(200, mp3, 'audio/mpeg'), { voiceEleven: { voiceId: '../v1/user' } });
    const r = await a.synthesize('hello', 'en');
    ok(r.ok === false && r.error.code === 'no_config' && calls.length === 0, 'elevenlabs: a voice id with path characters is refused (it goes into the URL path)', r.error);
  }
  {
    const a = createElevenTts({ safeStorage: fakeSafe, dir: fs.mkdtempSync(path.join(tmp, 'eleven-nokey-')), getConfig: () => ({ voiceEleven: { voiceId: VOICE_ID } }), fetchImpl: async () => { throw new Error('must not call'); } });
    ok((await a.synthesize('hi', 'en')).error.code === 'no_key', 'elevenlabs: no key -> no_key, no call');
  }
  for (const [status, code, retryable] of [[401, 'auth_failed', false], [403, 'auth_failed', false], [422, 'http_422', false], [429, 'rate_limited', true], [503, 'http_503', true]]) {
    const { a } = mk(jsonRes(status, { detail: { message: 'no' } }));
    const r = await a.synthesize('x', 'en');
    ok(r.ok === false && r.error.code === code && r.error.retryable === retryable, `elevenlabs: HTTP ${status} -> ${code} (retryable=${retryable})`, r.error);
  }
  {
    const { a } = mk(async () => { throw timeoutErr(); });
    ok((await a.synthesize('x', 'en')).error.code === 'timeout', 'elevenlabs: an abort -> timeout');
  }
  {
    const { a } = mk(binRes(200, mp3, 'text/html'));
    ok((await a.synthesize('x', 'en')).error.code === 'bad_response', 'elevenlabs: a non-audio content-type -> bad_response');
  }
  {
    const { a } = mk(binRes(200, Buffer.alloc(10 * 1024 * 1024 + 8), 'audio/mpeg'));
    ok((await a.synthesize('x', 'en')).error.code === 'too_large', 'elevenlabs: a response over 10 MB -> too_large');
  }
  {
    const { a } = mk(jsonRes(500, `kaboom ${ELEVEN_KEY}`));
    const r1 = await a.synthesize('x', 'en');
    const { a: b } = mk(async () => { throw new Error(`dns ${ELEVEN_KEY}`); });
    const r2 = await b.synthesize('x', 'en');
    ok(!JSON.stringify(r1).includes(ELEVEN_KEY) && !JSON.stringify(r2).includes(ELEVEN_KEY), 'elevenlabs: the key is scrubbed from error bodies and thrown messages');
    ok(!logs.join('\n').includes(ELEVEN_KEY), 'elevenlabs: the key never reaches the log');
  }
}

// ---------- 3d. custom HTTP user shapes (tts-http.js: openai + zumia) + the URL rules ----------
const CUSTOM_KEY = 'custom-bearer-token-123456';
{
  const dir = fs.mkdtempSync(path.join(tmp, 'custom-'));
  const logs = [];
  const mp3 = Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x80, 0xfe, 0x00, 0x01]); // binary on purpose: text() would corrupt it
  const mkOpenai = (res, cfg = { voiceCustom: { base: 'https://tts.example.com/v1', model: 'tts-1', voice: 'alloy' } }, withKey = true) => {
    const calls = [];
    const a = createHttpTts({ id: 'http-openai', shape: 'openai', langs: ['en', 'vi'], keyOptional: true, getConfig: () => cfg, safeStorage: fakeSafe, dir, log: (m) => logs.push(m), fetchImpl: async (url, init) => { calls.push({ url, init }); return typeof res === 'function' ? res() : res; } });
    if (withKey) a.setKey(CUSTOM_KEY); else a.clearKey();
    return { a, calls };
  };
  {
    const { a, calls } = mkOpenai(binRes(200, mp3, 'audio/mpeg'));
    const r = await a.synthesize('Hello there', 'en');
    ok(r.ok === true && r.mime === 'audio/mpeg' && r.audios[0].equals(mp3), 'http-openai: the response bytes are returned intact (read as bytes, not text)', r);
    const c = calls[0];
    ok(c.url === 'https://tts.example.com/v1/audio/speech' && c.init.method === 'POST' && c.init.redirect === 'error' && Boolean(c.init.signal), 'http-openai: POST {base}/audio/speech, redirect:error, timeout signal', c.url);
    ok(c.init.headers.authorization === `Bearer ${CUSTOM_KEY}`, 'http-openai: the optional bearer is sent to the saved URL');
    const body = JSON.parse(c.init.body);
    ok(body.model === 'tts-1' && body.input === 'Hello there' && body.voice === 'alloy' && body.response_format === 'mp3', 'http-openai: body = { model, input, voice, response_format: mp3 }', body);
  }
  {
    const { a, calls } = mkOpenai(binRes(200, mp3, 'audio/mpeg'), undefined, false);
    await a.synthesize('Hello', 'en');
    ok(!('authorization' in calls[0].init.headers), 'http-openai: with no key stored no Authorization header is sent');
    ok(a.hasKey() === false, 'http-openai: hasKey() reports the optional bearer honestly');
  }
  {
    const { a, calls } = mkOpenai(binRes(200, mp3, 'audio/mpeg'), { voiceCustom: { base: 'http://localhost:8880/v1', model: 'kokoro', voice: 'af_bella' } });
    const r = await a.synthesize('Hello', 'en');
    ok(r.ok === true && calls[0].url === 'http://localhost:8880/v1/audio/speech', 'http-openai: a local http://localhost server is allowed (Kokoro-FastAPI)');
  }
  for (const [name, base] of [['plain http on a real host', 'http://example.com/v1'], ['userinfo', 'https://u:p@host.example/v1'], ['no base', ''], ['not a url', 'banana']]) {
    const { a, calls } = mkOpenai(binRes(200, mp3, 'audio/mpeg'), { voiceCustom: { base, model: 'm', voice: 'v' } });
    const r = await a.synthesize('Hello', 'en');
    ok(r.ok === false && r.error.code === 'no_config' && calls.length === 0, `http-openai: ${name} is refused at call time, no call`, r.error);
  }
  {
    const { a } = mkOpenai(binRes(200, mp3, 'text/html'));
    ok((await a.synthesize('x', 'en')).error.code === 'bad_response', 'http-openai: a content-type that is not audio/* -> bad_response');
  }
  {
    const { a } = mkOpenai(binRes(200, Buffer.alloc(10 * 1024 * 1024 + 8), 'audio/mpeg'));
    ok((await a.synthesize('x', 'en')).error.code === 'too_large', 'http-openai: a response over 10 MB -> too_large');
  }
  for (const [status, code] of [[401, 'auth_failed'], [429, 'rate_limited'], [500, 'http_500']]) {
    const { a } = mkOpenai(jsonRes(status, { error: { message: 'x' } }));
    ok((await a.synthesize('x', 'en')).error.code === code, `http-openai: HTTP ${status} -> ${code}`);
  }
  {
    const { a } = mkOpenai(async () => { throw timeoutErr(); });
    ok((await a.synthesize('x', 'en')).error.code === 'timeout', 'http-openai: an abort -> timeout');
  }
  {
    const { a } = mkOpenai(jsonRes(500, `echo ${CUSTOM_KEY}`));
    const r1 = await a.synthesize('x', 'en');
    const { a: b } = mkOpenai(async () => { throw new Error(`boom ${CUSTOM_KEY}`); });
    const r2 = await b.synthesize('x', 'en');
    ok(!JSON.stringify(r1).includes(CUSTOM_KEY) && !JSON.stringify(r2).includes(CUSTOM_KEY), 'http-openai: the bearer is scrubbed from error bodies and thrown messages');
    ok(!logs.join('\n').includes(CUSTOM_KEY), 'http-openai: the bearer never reaches the log');
  }

  // the zumia shape against a USER url
  const mkZ = (res, cfg) => {
    const calls = [];
    const a = createHttpTts({ id: 'http-zumia', shape: 'zumia', langs: ['en', 'vi'], keyOptional: true, getConfig: () => cfg, safeStorage: fakeSafe, dir, log: () => {}, fetchImpl: async (url, init) => { calls.push({ url, init }); return typeof res === 'function' ? res() : res; } });
    a.setKey(CUSTOM_KEY);
    return { a, calls };
  };
  {
    const { a, calls } = mkZ(jsonRes(200, { audios: [mp3.toString('base64')] }), { voiceCustomZumia: { url: 'https://my.example.org/tts' } });
    const r = await a.synthesize('Hello', 'en');
    ok(r.ok === true && r.audios[0].equals(mp3) && calls[0].url === 'https://my.example.org/tts' && calls[0].init.headers.authorization === `Bearer ${CUSTOM_KEY}`, 'http-zumia: a user URL gets { text } and the optional bearer; audios[] -> MP3', r);
  }
  {
    // a user who points the custom URL at zumia.space still never sends the bearer there
    const { a, calls } = mkZ(jsonRes(200, { audio: mp3.toString('base64') }), { voiceCustomZumia: { url: 'https://zumia.space/api/zumi/tts' } });
    await a.synthesize('Xin chào', 'vi');
    ok(!('authorization' in calls[0].init.headers), 'http-zumia: a bearer is never sent to zumia.space, whoever saved the URL');
  }
  {
    const { a, calls } = mkZ(jsonRes(200, {}), { voiceCustomZumia: { url: 'http://example.com/tts' } });
    const r = await a.synthesize('Hello', 'en');
    ok(r.ok === false && r.error.code === 'no_config' && calls.length === 0, 'http-zumia: a plain-http URL on a real host is refused, no call', r.error);
  }

  // URL rules + config patch (pure)
  const U = (u) => validateCustomUrl(u).ok;
  ok(U('https://tts.example.com/v1') && U('http://localhost:8880') && U('http://127.0.0.1:8880/v1'), 'url rules: https and http://localhost / 127.0.0.1 are accepted');
  ok(!U('http://example.com') && !U('https://u:p@host.example') && !U('ftp://host.example') && !U('https://host.example/x?key=1') && !U('') && !U('javascript:alert(1)') && !U('http://localhost.evil.com'), 'url rules: http on a real host, userinfo, other schemes, a query, empty and look-alike hosts are rejected');
  ok(validateCustomUrl('https://tts.example.com/v1/').url === 'https://tts.example.com/v1', 'url rules: the trailing slash is normalised away');
  const cur = voiceConfig({});
  const patched = patchVoiceConfig(cur, { voiceCustom: { base: 'http://evil.example', model: 'kokoro', voice: 'af_bella+af_sky' }, voiceEleven: { voiceId: 'JBFqnCBsd6RMkjVDRZzb', model: 'eleven v3' }, voiceGemini: { voice: '../x' } });
  ok(patched.config.voiceCustom.base === '' && patched.rejected.includes('voiceCustom.base') && patched.config.voiceCustom.model === 'kokoro' && patched.config.voiceCustom.voice === 'af_bella+af_sky', 'config: a bad URL is refused (and named in rejected); a good model/voice is kept', patched);
  ok(patched.config.voiceEleven.voiceId === 'JBFqnCBsd6RMkjVDRZzb' && patched.config.voiceEleven.model === 'eleven_flash_v2_5' && patched.rejected.includes('voiceEleven.model') && patched.rejected.includes('voiceGemini.voice'), 'config: a bad model / voice shape keeps the old value', patched);
  ok(patchVoiceConfig(patched.config, { voiceEleven: { voiceId: '' } }).config.voiceEleven.voiceId === '' && patchVoiceConfig(patched.config, { voiceCustom: { base: '' } }).config.voiceCustom.base === '', 'config: an empty voice id / URL clears it');
  ok(voiceConfig({ voiceCustom: { base: 'http://example.com' } }).voiceCustom.base === '' && voiceConfig({ voiceCustomZumia: { url: 'https://u:p@h.example' } }).voiceCustomZumia.url === '', 'config: a bad saved URL reads as empty (the URL rules also run when settings.json is hand-edited)');
}

// ---------- 3d2. one bearer file per custom provider (T-31 review fix 6) ----------
{
  const dir = fs.mkdtempSync(path.join(tmp, 'split-'));
  const mp3 = Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x80, 0xfe, 0x00, 0x01]);
  const cfg = { voiceCustom: { base: 'https://openai.example.com/v1', model: 'tts-1', voice: 'alloy' }, voiceCustomZumia: { url: 'https://zumia.example.org/tts' } };
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push({ url, auth: init.headers.authorization || null }); return url.endsWith('/audio/speech') ? { ok: true, status: 200, headers: new Map([['content-type', 'audio/mpeg']]), arrayBuffer: async () => mp3, body: null } : { ok: true, status: 200, headers: new Map([['content-type', 'application/json']]), text: async () => JSON.stringify({ audio: mp3.toString('base64') }), arrayBuffer: async () => Buffer.from(JSON.stringify({ audio: mp3.toString('base64') })), body: null }; };
  const mk = (id, shape) => createHttpTts({ id, shape, langs: ['en', 'vi'], keyOptional: true, getConfig: () => cfg, safeStorage: fakeSafe, dir, log: () => {}, fetchImpl });
  const o = mk('http-openai', 'openai'); const z = mk('http-zumia', 'zumia');
  ok(o.setKey('openai-bearer-token-1') && !z.hasKey(), 'custom keys: a bearer saved for http-openai is not visible to http-zumia');
  ok(z.setKey('zumia-bearer-token-22') && o.hasKey(), 'custom keys: http-zumia keeps its own bearer');
  ok(fs.existsSync(path.join(dir, CUSTOM_KEY_FILES['http-openai'])) && fs.existsSync(path.join(dir, CUSTOM_KEY_FILES['http-zumia'])) && CUSTOM_KEY_FILES['http-openai'] !== CUSTOM_KEY_FILES['http-zumia'] && !fs.existsSync(path.join(dir, LEGACY_CUSTOM_KEY_FILE)), 'custom keys: two different files, the shared legacy file is not written');
  o.clearKey();
  ok(!o.hasKey() && z.hasKey(), 'custom keys: clearing one leaves the other');
  o.setKey('openai-bearer-token-1');
  await o.synthesize('Hello', 'en'); await z.synthesize('Hello', 'en');
  const oc = seen.find((c) => c.url.startsWith('https://openai.example.com')); const zc = seen.find((c) => c.url.startsWith('https://zumia.example.org'));
  ok(oc && oc.auth === 'Bearer openai-bearer-token-1' && zc && zc.auth === 'Bearer zumia-bearer-token-22', 'custom keys: each provider sends only its own bearer to its own host', seen);

  // migration of the old shared file
  const legacyBlob = () => fakeSafe.encryptString('legacy-bearer-token-333');
  const mig = (config, pre = {}) => {
    const d = fs.mkdtempSync(path.join(tmp, 'mig-'));
    fs.writeFileSync(path.join(d, LEGACY_CUSTOM_KEY_FILE), legacyBlob());
    for (const [f, v] of Object.entries(pre)) fs.writeFileSync(path.join(d, f), fakeSafe.encryptString(v));
    const res = migrateLegacyCustomKey({ dir: d, config, log: () => {} });
    return { d, res, has: (f) => fs.existsSync(path.join(d, f)) };
  };
  let m = mig({ voiceCustom: cfg.voiceCustom });
  ok(m.res === 'http-openai' && m.has(CUSTOM_KEY_FILES['http-openai']) && !m.has(LEGACY_CUSTOM_KEY_FILE) && !m.has(CUSTOM_KEY_FILES['http-zumia']), 'migrate: only the OpenAI-compatible URL is configured -> the old bearer moves to http-openai');
  m = mig({ voiceCustomZumia: cfg.voiceCustomZumia });
  ok(m.res === 'http-zumia' && m.has(CUSTOM_KEY_FILES['http-zumia']) && !m.has(LEGACY_CUSTOM_KEY_FILE), 'migrate: only the Zumia JSON URL is configured -> the old bearer moves to http-zumia');
  m = mig(cfg);
  ok(m.res === 'cleared' && !m.has(LEGACY_CUSTOM_KEY_FILE) && !m.has(CUSTOM_KEY_FILES['http-openai']) && !m.has(CUSTOM_KEY_FILES['http-zumia']), 'migrate: both providers configured -> not determinable: cleared, entered again (no silent cross-send)');
  m = mig({});
  ok(m.res === 'cleared' && !m.has(LEGACY_CUSTOM_KEY_FILE), 'migrate: neither configured -> cleared');
  m = mig({ voiceCustom: cfg.voiceCustom }, { [CUSTOM_KEY_FILES['http-openai']]: 'already-saved-token-9' });
  ok(m.res === 'cleared' && !m.has(LEGACY_CUSTOM_KEY_FILE) && mk2(m.d).hasKey(), 'migrate: a key already saved in the new file is never overwritten');
  ok(migrateLegacyCustomKey({ dir: fs.mkdtempSync(path.join(tmp, 'mig0-')), config: cfg }) === 'none', 'migrate: no legacy file -> nothing to do');
  function mk2(d) { return createHttpTts({ id: 'http-openai', shape: 'openai', keyOptional: true, getConfig: () => cfg, safeStorage: fakeSafe, dir: d, log: () => {} }); }
  const mainSrc = fs.readFileSync(new URL('../src/main/main.js', import.meta.url), 'utf8');
  ok(/migrateLegacyCustomKey\(\{ dir: voiceDir/.test(mainSrc) && !/keyFile: CUSTOM_KEY_FILE/.test(mainSrc), 'main.js: the legacy bearer is migrated before the adapters are created, and no adapter is given the shared file');
}

// ---------- 3e. key stores: one file per provider, switching never deletes another provider's key ----------
{
  const dir = fs.mkdtempSync(path.join(tmp, 'files-'));
  const g = createGeminiTts({ safeStorage: fakeSafe, dir });
  const e = createElevenTts({ safeStorage: fakeSafe, dir });
  const gg = createLedaTts({ safeStorage: fakeSafe, dir });
  g.setKey(GEMINI_KEY); e.setKey(ELEVEN_KEY); gg.setKey(KEY);
  ok(g.hasKey() && e.hasKey() && gg.hasKey(), 'keys: google, gemini and elevenlabs each keep their own key');
  g.clearKey();
  ok(!g.hasKey() && e.hasKey() && gg.hasKey(), 'keys: clearing one provider key leaves the others');
  ok(['leda-key.bin', 'elevenlabs-key.bin'].every((f) => fs.existsSync(path.join(dir, f))) && !fs.existsSync(path.join(dir, 'gemini-tts-key.bin')), 'keys: files are leda-key.bin / gemini-tts-key.bin / elevenlabs-key.bin / one custom key file per HTTP provider');
  const noEnc = { isEncryptionAvailable: () => false, encryptString: () => Buffer.from(''), decryptString: () => '' };
  const g2 = createGeminiTts({ safeStorage: noEnc, dir: fs.mkdtempSync(path.join(tmp, 'noenc-')) });
  ok(g2.setKey(GEMINI_KEY) === false && g2.hasKey() === false, 'keys: with no OS encryption a provider refuses to store a key (no plaintext fallback)');
  ok(g.setKey('nope') === false && e.setKey('short') === false, 'keys: the shape gate runs per provider');
}

// ---------- 4. owner flag parser + provider prefs ----------
{
  const dir = fs.mkdtempSync(path.join(tmp, 'flag-'));
  ok(readOwnerVoiceFlag(dir) === false, 'owner flag: no file -> false');
  fs.writeFileSync(path.join(dir, 'owner-voice.json'), '{ bad json');
  ok(readOwnerVoiceFlag(dir) === false, 'owner flag: bad JSON -> false');
  fs.writeFileSync(path.join(dir, 'owner-voice.json'), JSON.stringify({ v: 1, zumiaVoice: true, extra: 1 }));
  ok(readOwnerVoiceFlag(dir) === false, 'owner flag: an extra key -> false (exact-keys check)');
  fs.writeFileSync(path.join(dir, 'owner-voice.json'), JSON.stringify({ v: 1, zumiaVoice: false }));
  ok(readOwnerVoiceFlag(dir) === false, 'owner flag: zumiaVoice false -> false');
  fs.writeFileSync(path.join(dir, 'owner-voice.json'), JSON.stringify({ v: 1, zumiaVoice: true }));
  ok(readOwnerVoiceFlag(dir) === true, 'owner flag: the exact two-key file -> true');

  const noFlag = voiceProviderPrefs({});
  ok(noFlag.voiceProviderEn === 'kokoro' && noFlag.voiceProviderVi === 'google' && noFlag.voiceReplyLang === 'auto', 'prefs: defaults are kokoro / google / auto', noFlag);
  const bad = voiceProviderPrefs({ voiceProviderEn: 'zzz', voiceProviderVi: 'nope', voiceReplyLang: 'fr' });
  ok(bad.voiceProviderEn === 'kokoro' && bad.voiceProviderVi === 'google' && bad.voiceReplyLang === 'auto', 'prefs: every invalid value falls back to its default', bad);
  ok(voiceProviderPrefs({}, { ownerFlag: true }).voiceProviderVi === OWNER_PROVIDER, 'prefs: with the flag and no saved choice -> zumia-owner (vi default only)');
  ok(voiceProviderPrefs({ voiceProviderVi: 'gemini' }, { ownerFlag: true }).voiceProviderVi === 'gemini', 'prefs: with the flag a saved choice wins over the default');
  ok(voiceProviderPrefs({ voiceProviderVi: 'zumia-owner' }, { ownerFlag: false }).voiceProviderVi === 'google', 'prefs: a saved zumia-owner without the flag falls back to google');
  ok(['gemini', 'elevenlabs', 'http-openai', 'http-zumia'].every((p) => voiceProviderPrefs({ voiceProviderEn: p, voiceProviderVi: p }).voiceProviderEn === p && voiceProviderPrefs({ voiceProviderVi: p }).voiceProviderVi === p), 'prefs: gemini, elevenlabs, http-openai and http-zumia are all valid choices for both languages');
  ok(resolveVoice({ prefs: { voiceReplyLang: 'vi', voiceProviderVi: 'elevenlabs' } }).off === false && resolveVoice({ prefs: { voiceReplyLang: 'en', voiceProviderEn: 'gemini' } }).providerId === 'gemini', 'resolve: the BYO providers speak both languages');
}

// ---------- 5. resolveVoice ----------
{
  ok(JSON.stringify(resolveVoice({ prefs: { talkVoiceLang: 'vi' }, isSay: true, text: 'English text' })) === JSON.stringify({ lang: 'vi', providerId: 'google', off: false }),
    'resolve: a say line routes by talkVoiceLang, NOT by text detection (an EN line with the VI voice stays VI)', resolveVoice({ prefs: { talkVoiceLang: 'vi' }, isSay: true, text: 'English text' }));
  ok(resolveVoice({ prefs: { talkVoiceLang: 'en' }, isSay: true, text: 'Xin chào' }).lang === 'en', 'resolve: an EN say line stays EN even with Vietnamese text (the title is dropped, F4)');
  ok(resolveVoice({ prefs: { voiceReplyLang: 'auto' }, text: 'Xin chào anh' }).lang === 'vi' && resolveVoice({ prefs: { voiceReplyLang: 'auto' }, text: 'hello there' }).lang === 'en', 'resolve: a reply in auto detects the language');
  ok(resolveVoice({ prefs: { voiceReplyLang: 'en' }, text: 'Xin chào' }).lang === 'en', 'resolve: a reply fixed to en ignores the detected Vietnamese');
  ok(resolveVoice({ prefs: { voiceReplyLang: 'vi', voiceProviderVi: 'kokoro' } }).off === true, 'resolve: a provider that does not speak the language -> off (voice-off-lang)', resolveVoice({ prefs: { voiceReplyLang: 'vi', voiceProviderVi: 'kokoro' } }));
  ok(resolveVoice({ prefs: { voiceReplyLang: 'vi', voiceProviderVi: 'off' } }).off === true, 'resolve: the off option -> off');
  ok(resolveVoice({ prefs: { voiceReplyLang: 'vi', voiceProviderVi: 'zumia-owner' }, ownerFlag: false }).providerId === 'google', 'resolve: zumia-owner without the flag -> google');
  ok(resolveVoice({ prefs: { voiceReplyLang: 'vi', voiceProviderVi: 'zumia-owner' }, ownerFlag: true }).providerId === 'zumia-owner', 'resolve: zumia-owner with the flag -> zumia-owner');
  ok(resolveVoice({ prefs: { voiceProviderEn: 'kokoro' }, text: 'hi' }).providerId === 'kokoro', 'resolve: an EN reply -> the EN provider');
}

// ---------- 6. scripts/owner-voice.mjs ----------
{
  const dir = fs.mkdtempSync(path.join(tmp, 'owner-'));
  const backupRoot = fs.mkdtempSync(path.join(tmp, 'backup-'));
  const quiet = () => { const w = process.stdout.write; process.stdout.write = () => true; return () => { process.stdout.write = w; }; };

  let restore = quiet();
  const on1 = runOwnerVoice({ dir, action: 'on', backupRoot });
  const on2 = runOwnerVoice({ dir, action: 'on', backupRoot });
  restore();
  ok(on1.ok === true && on2.ok === true && on2.idempotent === true, 'owner-voice: --on writes the flag; a second --on is idempotent', { on1, on2 });
  ok(fs.existsSync(path.join(dir, FLAG_NAME)) && JSON.parse(fs.readFileSync(path.join(dir, FLAG_NAME), 'utf8')).zumiaVoice === true, 'owner-voice: the file is the owner flag shape');

  restore = quiet();
  const off = runOwnerVoice({ dir, action: 'off', backupRoot });
  restore();
  ok(off.ok === true && !fs.existsSync(path.join(dir, FLAG_NAME)) && off.backup && fs.existsSync(path.join(off.backup, FLAG_NAME)), 'owner-voice: --off deletes the flag and leaves a backup', off);

  // the rollback path: the read-back sees the file still there -> restore the backup
  restore = quiet();
  runOwnerVoice({ dir, action: 'on', backupRoot });
  const rolled = runOwnerVoice({ dir, action: 'off', backupRoot, readBack: () => Buffer.from('still here') });
  restore();
  ok(rolled.ok === false && rolled.reason === 'readback' && fs.existsSync(path.join(dir, FLAG_NAME)), 'owner-voice: a failed read-back rolls back (the flag is restored)', rolled);

  // the --on read-back failure deletes the new file
  const dir2 = fs.mkdtempSync(path.join(tmp, 'owner2-'));
  restore = quiet();
  const failedOn = runOwnerVoice({ dir: dir2, action: 'on', backupRoot, readBack: () => Buffer.from('corrupt') });
  restore();
  ok(failedOn.ok === false && failedOn.reason === 'readback' && !fs.existsSync(path.join(dir2, FLAG_NAME)), 'owner-voice: a corrupt --on read-back deletes the file (no half-written flag)', failedOn);

  // -status
  restore = quiet();
  const st = runOwnerVoice({ dir: dir2, action: 'status', backupRoot });
  restore();
  ok(st.ok === true && st.on === false, 'owner-voice: --status reports off for a missing file', st);
}

await sleep(1);

// ---------- 3c. the owner key on zumia.space (owner 02-11) ----------
{
  const OWNER_KEY = 'owner-key-fixture-0123456789';
  const IMPORT = 'zumia-owner-tts-key.import';
  const fresh = () => fs.mkdtempSync(path.join(tmp, 'owner-'));
  const mkOwner = (dir, res = jsonRes(200, { audio: Buffer.from('mp3').toString('base64') })) => {
    const calls = [];
    const a = createHttpTts({ id: 'zumia-owner', url: ZUMIA_OWNER_URL, langs: ['vi'], shape: 'zumia', keyOptional: true, keyImportFile: IMPORT, safeStorage: fakeSafe, dir, fetchImpl: async (url, init) => { calls.push({ url, init }); return res; } });
    return { a, calls };
  };
  {
    const dir = fresh();
    const { a, calls } = mkOwner(dir);
    ok(!a.hasKey() && (await a.synthesize('x', 'vi')).ok === true && !('authorization' in calls[0].init.headers), 'owner key: no key -> no header, the call works as before');
  }
  {
    const dir = fresh();
    fs.writeFileSync(path.join(dir, IMPORT), OWNER_KEY);
    const { a, calls } = mkOwner(dir);
    ok(!fs.existsSync(path.join(dir, IMPORT)), 'owner key: the import file is destroyed when the adapter is built');
    const bin = path.join(dir, 'custom-zumia-owner-tts-key.bin');
    ok(fs.existsSync(bin) && fs.readFileSync(bin).toString().startsWith('enc:'), 'owner key: stored encrypted through safeStorage, in the given dir', fs.readdirSync(dir).join());
    const r = await a.synthesize('x', 'vi');
    ok(r.ok === true && calls[0].url === ZUMIA_OWNER_URL && calls[0].init.headers.authorization === `Bearer ${OWNER_KEY}`, 'owner key: with a key the header is sent to the owner constant');
  }
  {
    const dir = fresh();
    fs.writeFileSync(path.join(dir, IMPORT), 'bad key with spaces');
    const { a } = mkOwner(dir);
    ok(!fs.existsSync(path.join(dir, IMPORT)) && !a.hasKey(), 'owner key: a malformed import is refused and destroyed');
  }
  { // A user instance can never send to zumia.space.
    for (const [id, cfg, shape] of [['http-zumia', { voiceCustomZumia: { url: 'https://zumia.space/api/zumi/tts' } }, 'zumia'], ['http-zumia', { voiceCustomZumia: { url: 'https://x.zumia.space/tts' } }, 'zumia'], ['http-openai', { voiceCustom: { base: 'https://zumia.space/v1', model: 'm', voice: 'v' } }, 'openai']]) {
      const calls = [];
      const a = createHttpTts({ id, shape, langs: ['vi'], keyOptional: true, getConfig: () => cfg, safeStorage: fakeSafe, dir: fresh(), fetchImpl: async (url, init) => { calls.push({ url, init }); return jsonRes(401, {}); } });
      a.setKey(OWNER_KEY);
      const r = await a.synthesize('x', 'vi');
      ok(calls.length === 1 && !('authorization' in calls[0].init.headers), `owner key: ${id} never sends a user bearer to ${new URL(calls[0].url).host}`);
      ok(r.error.code === 'auth_failed', `owner key: a 401 on ${id} stays auth_failed`, r.error);
    }
  }
  { // The owner id with any other URL is not the owner route.
    const calls = [];
    const a = createHttpTts({ id: 'zumia-owner', url: 'https://other.zumia.space/tts', langs: ['vi'], shape: 'zumia', keyOptional: true, safeStorage: fakeSafe, dir: fresh(), fetchImpl: async (url, init) => { calls.push({ url, init }); return jsonRes(200, {}); } });
    a.setKey(OWNER_KEY);
    await a.synthesize('x', 'vi');
    ok(!('authorization' in calls[0].init.headers), 'owner key: only the exact owner constant receives it');
  }
  { // 401 -> typed no_key, message free of the key; talk-voice-core takes the route a missing flag takes.
    const dir = fresh();
    fs.writeFileSync(path.join(dir, IMPORT), OWNER_KEY);
    const { a } = mkOwner(dir, jsonRes(401, { error: `refused ${OWNER_KEY}` }));
    const r = await a.synthesize('x', 'vi');
    ok(r.ok === false && r.error.code === 'no_key' && !JSON.stringify(r.error).includes(OWNER_KEY), 'owner key: a 401 is typed no_key, the key is in no error text', r.error);
    const { createTalkVoiceCore } = await import('../src/main/talk-voice-core.mjs');
    const settings = () => ({ voiceReplyLang: 'vi', voiceProviderVi: 'zumia-owner' });
    const mkCore = (google) => createTalkVoiceCore({ settings, saveSettings: () => {}, ownerFlag: () => true, adapters: () => ({ 'zumia-owner': a, google }), forceTtsFail: () => null, realTts: () => false });
    let googleCalls = 0;
    const withGoogle = await mkCore({ synthesize: async () => { googleCalls++; return { ok: true, mime: 'audio/mpeg', audios: [Buffer.from('g')], voice: 'g' }; } }).tts({ turnId: 't1', text: 'Xin chào anh nhé' });
    ok(withGoogle.ok === true && withGoogle.voice === 'g' && googleCalls === 1, 'owner key: a 401 on a reply falls back to the Google route', withGoogle);
    const noKey = await mkCore({ synthesize: async () => ({ ok: false, error: { code: 'no_key', message: 'k', retryable: false } }) }).tts({ turnId: 't2', text: 'Xin chào anh nhé' });
    ok(noKey.ok === true && noKey.reason === 'no-google-key', 'owner key: no Google key either -> the usual note, same as a missing flag', noKey);
    const core = mkCore(null);
    ok(core.setProviderKey('zumia-owner', OWNER_KEY) === false && core.clearProviderKey('zumia-owner') === false && a.hasKey(), 'owner key: the page cannot set or clear it');
    ok(core.providerList().find((p) => p.id === 'zumia-owner') && !JSON.stringify(core.providerList()).includes(OWNER_KEY), 'owner key: never in the provider list');
  }
  { // A 500 on the owner route still does not change route (PLAN 10.4).
    const { a } = mkOwner(fresh(), jsonRes(500, { error: 'x' }));
    const { createTalkVoiceCore } = await import('../src/main/talk-voice-core.mjs');
    let googleCalls = 0;
    const r = await createTalkVoiceCore({ settings: () => ({ voiceReplyLang: 'vi', voiceProviderVi: 'zumia-owner' }), saveSettings: () => {}, ownerFlag: () => true, forceTtsFail: () => null, realTts: () => false, adapters: () => ({ 'zumia-owner': a, google: { synthesize: async () => { googleCalls++; return { ok: true, audios: [] }; } } }) }).tts({ turnId: 't3', text: 'Xin chào anh nhé' });
    ok(r.ok === false && googleCalls === 0, 'owner key: other failures keep "no silent fallback"', r);
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\ncheck:tts-providers ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);

