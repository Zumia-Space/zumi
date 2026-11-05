// check:voice-pack (T-31 Marketplace, voice plan). Plain Node, no network, no key, no paid call.
//   1. own Google key: header only, a free check before saving, no key in a url or a log;
//   2. where Kokoro is found: the installer's copy wins (the owner's voice never changes), else the Marketplace pack, else nothing;
//   3. no Kokoro on this PC: the Windows voice speaks, on the Tauri route too;
//   4. the staged public bundle carries no voice modules and the owner stage still does (source rules, the real stage is check:public-payload).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(repo, 'package.json'));
let pass = 0, fail = 0;
const ok = (c, name, detail = '') => { if (c) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`); } };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zumi-voice-pack-'));

// ---------- 1. Google ----------
const { createLedaTts } = req('./src/main/leda-tts.js');
const KEY = `AIza${'A1b2'.repeat(8)}abc`;
const safeStorage = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() };
function google(respond) {
  const calls = []; const logs = [];
  const a = createLedaTts({ safeStorage, dir: fs.mkdtempSync(path.join(tmp, 'g-')), log: (m) => logs.push(String(m)), fetchImpl: async (url, init) => { calls.push({ url, init }); return respond(); } });
  return { a, calls, logs };
}
const res = (status, body = {}) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
{
  const { a, calls } = google(() => res(200, { audioContent: Buffer.from('wav').toString('base64') }));
  ok(a.setKey(KEY), 'a pasted key is stored');
  const r = await a.synthesize('Xin chào', 'vi');
  ok(r.ok, 'the direct call speaks through a stubbed Google', r);
  ok(calls[0].url === 'https://texttospeech.googleapis.com/v1/text:synthesize', 'synthesize: the url holds no key', calls[0].url);
  ok(calls[0].init.headers['x-goog-api-key'] === KEY, 'synthesize: the key goes in the header');
}
for (const [status, want] of [[200, 'works'], [400, 'rejected'], [401, 'rejected'], [403, 'rejected'], [429, 'unreachable'], [500, 'unreachable']]) {
  const { a, calls, logs } = google(() => res(status));
  const v = await a.checkKey(KEY);
  ok(v === want, `key check: Google answers ${status} -> ${want}`, v);
  ok(calls[0].init.method === 'GET' && /\/v1\/voices\?/.test(calls[0].url) && !calls[0].url.includes(KEY) && calls[0].init.headers['x-goog-api-key'] === KEY, `key check ${status}: free list call, key in the header only`, calls[0].url);
  ok(!a.hasKey() && !logs.join().includes(KEY), `key check ${status}: nothing stored, nothing logged`);
}
{
  const { a, calls } = google(() => res(200));
  ok(await a.checkKey('not-a-key') === 'bad_format' && calls.length === 0, 'key check: a wrong shape costs no call');
  const off = createLedaTts({ safeStorage, dir: fs.mkdtempSync(path.join(tmp, 'g-')), fetchImpl: async () => { throw new Error('offline'); } });
  ok(await off.checkKey(KEY) === 'unreachable', 'key check: offline says unreachable');
}

// ---------- 2. where Kokoro is found ----------
const { createKokoroTts } = req('./src/main/kokoro-tts.js');
const kokoroJs = (dir) => { const p = path.join(dir, 'node_modules', 'kokoro-js', 'dist'); fs.mkdirSync(p, { recursive: true }); fs.writeFileSync(path.join(p, 'kokoro.js'), '//'); };
const noWorker = () => ({ on() {}, once() {}, postMessage(m) { noWorker.last = m; }, terminate() { return Promise.resolve(); } });
{
  const saved = process.resourcesPath;
  const resources = fs.mkdtempSync(path.join(tmp, 'res-'));
  const data = fs.mkdtempSync(path.join(tmp, 'data-'));
  process.resourcesPath = resources;
  const k = createKokoroTts({ userDataDir: data, workerFactory: noWorker });
  ok(k.available() === false, 'installed, no Kokoro anywhere: unavailable, no node_modules fallback');
  const pack = path.join(data, 'packs', 'voice.kokoro-82m', 'voice-modules');
  kokoroJs(pack);
  ok(k.available() === true, 'a pack installed while the app runs counts at once, no restart');
  k.prefetch(); await new Promise((r) => setTimeout(r, 20));
  ok(noWorker.last && noWorker.last.vmDir === pack, 'the worker loads from the pack', noWorker.last);
  k.unload();
  fs.writeFileSync(path.join(data, 'packs', 'voice.kokoro-82m.remove-pending'), '');
  ok(k.available() === false, 'a remove waiting for a restart counts as gone');
  fs.rmSync(path.join(data, 'packs', 'voice.kokoro-82m.remove-pending'));
  const bundled = path.join(resources, 'voice-modules');
  kokoroJs(bundled);
  noWorker.last = null;
  const k2 = createKokoroTts({ userDataDir: data, workerFactory: noWorker });
  k2.prefetch(); await new Promise((r) => setTimeout(r, 20));
  ok(k2.available() && noWorker.last.vmDir === bundled, 'the installer copy wins over a pack: the owner build never changes voice', noWorker.last);
  k2.unload();
  process.resourcesPath = saved;
}

// ---------- 3. no Kokoro: the Windows voice speaks ----------
const { createEnTtsRouter } = req('./src/main/tts-router.js');
{
  const spoken = [];
  const router = createEnTtsRouter({ kokoro: { available: () => false }, sapi: { available: () => true, speak: async (p) => { spoken.push(p.text); return { mime: 'audio/wav', audios: [Buffer.from('w')], voice: 'sapi' }; } }, kokoroOnly: true, onMore() {}, onProgress() {}, log() {} });
  const r = await router.speak({ turnId: 'a'.repeat(32), text: 'Hello there' });
  ok(r.ok && r.voice === 'sapi' && spoken[0] === 'Hello there', 'kokoroOnly route, no Kokoro: the Windows voice speaks', r);
  const none = createEnTtsRouter({ kokoro: { available: () => false }, sapi: { available: () => false }, kokoroOnly: true, onMore() {}, onProgress() {}, log() {} });
  const n = await none.speak({ turnId: 'b'.repeat(32), text: 'Hello' });
  ok(!n.ok && n.error.code === 'talk_off', 'no Windows voice either (a Mac build): a typed error', n);
}

{
  // Test voice with no Kokoro: the Windows voice refuses any turn id but 128-bit hex (local-tts.js).
  const { createTalkVoiceCore } = await import('../src/main/talk-voice-core.mjs');
  const seen = [];
  const router = createEnTtsRouter({ kokoro: { available: () => false }, sapi: { available: () => true, speak: async (p) => { seen.push(p.turnId); return { mime: 'audio/wav', audios: [Buffer.from('w')], voice: 'sapi' }; } }, kokoroOnly: true, onMore() {}, onProgress() {}, log() {} });
  const core = createTalkVoiceCore({ settings: () => ({}), saveSettings() {}, ownerFlag: () => false, talkPrefs: () => ({}), adapters: () => ({}), enTts: () => router, kokoro: () => ({ available: () => false }), cloud: () => null, isLiveSay: () => false, takeLiveReply: () => null, forceTtsFail: () => null, realTts: () => false, log() {} });
  const r = await core.testVoice({ lang: 'en', text: 'Hello there' });
  ok(r.ok && /^[0-9a-f]{32}$/.test(seen[0] || ''), 'Test voice with no Kokoro sends a real 128-bit turn id', { r, seen });
}

// ---------- 4. the stage rule ----------
const stage = fs.readFileSync(path.join(repo, 'tauri', 'stage-bundle.mjs'), 'utf8');
ok(/if \(flavour !== 'public' && flavour !== 'official'\) for \(const entry of voiceEntries\)/.test(stage), 'source: a public or official stage skips the voice modules, any other flavour copies them');
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`check:voice-pack: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
