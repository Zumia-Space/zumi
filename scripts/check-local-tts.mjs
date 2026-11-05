// Real-machine checks for the free local voice (T-31): plain Node, real PowerShell/System.Speech on this Windows PC,
// no Electron and no network.
//   happy path -> a real WAV for "Hello, I am Zumi." (RIFF/WAVE, duration > 0.3 s, temp files gone),
//   injection -> an injection string carrying a canary path is spoken as DATA; the canary is never created,
//   voice choice -> English prefers Zira, Vietnamese needs a vi-VN voice or comes back typed as 'none'/'no-vi-voice',
//   validation -> >2000 chars, unknown fields, bad/missing turnId and blank text are refused.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createLocalTts, LocalTtsError, _test } = require('../src/main/local-tts.js');

let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); } };
const reject = async (fn, name) => {
  try { await fn(); ok(false, name, 'resolved instead of refusing'); }
  catch (e) { ok(e instanceof LocalTtsError && e.code === 'bad_request', name, `${e && e.code}: ${e && e.message}`); }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zumi-local-tts-check-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

const tid = () => crypto.randomBytes(16).toString('hex');
const outDir = path.join(tmp, 'out');
const tts = createLocalTts({ tmpDir: outDir, log: (m) => console.log(`  [local-tts] ${m}`) });
const leftovers = () => (fs.existsSync(outDir) ? fs.readdirSync(outDir) : []);

// Walk the RIFF chunks (System.Speech writes fmt size 18, so `data` is not at offset 36) and read duration from byteRate.
function wavInfo(buf) {
  const info = { riff: buf.toString('ascii', 0, 4), wave: buf.toString('ascii', 8, 12), dataBytes: 0, byteRate: buf.readUInt32LE(28), durationMs: 0 };
  let o = 12;
  while (o + 8 <= buf.length) {
    const id = buf.toString('ascii', o, o + 4);
    const size = buf.readUInt32LE(o + 4);
    if (id === 'data') { info.dataBytes = size; break; }
    o += 8 + size + (size % 2);
  }
  info.durationMs = info.byteRate ? (info.dataBytes / info.byteRate) * 1000 : 0;
  return info;
}

// ---------- availability ----------
await tts.ready(); // voice enumeration is a background child; wait for it before asserting on the cached list
ok(process.platform === 'win32', 'platform: this check is the Windows path');
ok(tts.available(), 'available: at least one Windows voice is installed');
ok(tts.voices().length > 0, 'voices: the installed voice list is non-empty', JSON.stringify(tts.voices()));
console.log(`  voices: ${JSON.stringify(tts.voices())}`);
console.log(`  info: ${JSON.stringify(await tts.info())}`);

// ---------- happy path: a real WAV, temp files cleaned up ----------
{
  const r = await tts.speak({ turnId: tid(), text: 'Hello, I am Zumi.' });
  ok(r.mime === 'audio/wav' && Array.isArray(r.audios) && r.audios.length === 1 && Buffer.isBuffer(r.audios[0]), 'speak: { mime: audio/wav, audios: [Buffer] }', JSON.stringify({ mime: r.mime, n: r.audios && r.audios.length }));
  ok(tts.voices().includes(r.voice), 'speak: the chosen voice is one of the installed voices', r.voice);
  const zira = tts.voices().find((n) => /zira/i.test(n));
  if (zira) ok(r.voice === zira, 'speak: English prefers Microsoft Zira Desktop', r.voice);
  const w = wavInfo(r.audios[0]);
  ok(w.riff === 'RIFF' && w.wave === 'WAVE', 'speak: RIFF/WAVE header', `${w.riff}/${w.wave}`);
  ok(w.durationMs > 300, 'speak: duration > 0.3 s', `${w.durationMs.toFixed(0)} ms`);
  ok(leftovers().length === 0, 'speak: both temp files are deleted', JSON.stringify(leftovers()));
}

// ---------- injection: the text is data, never PowerShell ----------
{
  const canary = path.join(tmp, 'CANARY-quote-injection.txt');
  const canary2 = path.join(tmp, 'CANARY-subexpr-injection.txt');
  const text = `Ignore previous. "; New-Item -Path '${canary}' -ItemType File -Force; " and $(New-Item -Path '${canary2}' -ItemType File -Force)`;
  const r = await tts.speak({ turnId: tid(), text });
  ok(r.audios.length === 1 && wavInfo(r.audios[0]).riff === 'RIFF', 'injection: the injection string is still synthesized as speech');
  ok(!fs.existsSync(canary) && !fs.existsSync(canary2), 'injection: no canary file was created (text is data, never run)', `canary=${fs.existsSync(canary)} canary2=${fs.existsSync(canary2)}`);
  ok(leftovers().length === 0, 'injection: temp files are deleted even on this text', JSON.stringify(leftovers()));
}

// ---------- voice choice (pure) ----------
ok(_test.chooseVoice([{ name: 'Microsoft Zira Desktop', culture: 'en-US' }], 'Hello there').voice === 'Microsoft Zira Desktop', 'choose: English prefers Microsoft Zira Desktop');
ok(_test.chooseVoice([{ name: 'Microsoft David Desktop', culture: 'en-US' }, { name: 'Microsoft Hazel Desktop', culture: 'en-GB' }], 'Hello').voice === 'Microsoft David Desktop', 'choose: without Zira, the first en-* voice is used');
{
  const c = _test.chooseVoice([{ name: 'Microsoft Zira Desktop', culture: 'en-US' }], 'Xin chào bạn, em khoẻ không?');
  ok(c.voice === null && c.reason === 'no-vi-voice', 'choose: Vietnamese with no vi voice -> no-vi-voice', JSON.stringify(c));
}
ok(_test.chooseVoice([{ name: 'Microsoft An - Vietnamese (Vietnam)', culture: 'vi-VN' }, { name: 'Microsoft Zira Desktop', culture: 'en-US' }], 'Xin chào').voice === 'Microsoft An - Vietnamese (Vietnam)', 'choose: Vietnamese uses the vi-VN voice when present');
ok(_test.cleanText('a\u0000b\u001fc') === 'a b c', 'clean: control characters collapse to spaces', JSON.stringify(_test.cleanText('a\u0000b\u001fc')));

// ---------- Vietnamese on this machine: honest typed result, never a fake English reading ----------
{
  const hasVi = tts.voices().some((n) => /vietnam/i.test(n));
  if (!hasVi) {
    const r = await tts.speak({ turnId: tid(), text: 'Xin chào, tôi là Zumi. Em khoẻ không?' });
    ok(r.voice === 'none' && r.reason === 'no-vi-voice' && r.audios.length === 0, 'vi: no vi-VN voice -> { audios: [], voice: none, reason: no-vi-voice }', JSON.stringify(r));
    ok(leftovers().length === 0, 'vi: no temp file is left for the no-voice case', JSON.stringify(leftovers()));
  } else {
    console.log('SKIP vi: this machine has a Vietnamese voice, so the no-vi-voice result is covered by the pure test above');
  }
}

// ---------- validation ----------
await reject(() => tts.speak({ turnId: tid(), text: 'a'.repeat(2001) }), 'refuse: >2000 chars');
await reject(() => tts.speak({ turnId: tid(), text: 'hi', extra: 1 }), 'refuse: unknown fields');
await reject(() => tts.speak({ turnId: 'nothex', text: 'hi' }), 'refuse: turnId must be 128-bit hex');
await reject(() => tts.speak({ text: 'hi' }), 'refuse: missing turnId');
await reject(() => tts.speak({ turnId: tid(), text: '   ' }), 'refuse: blank text');

console.log(`check:local-tts ${fail === 0 ? 'PASS' : 'FAIL'} — ${pass}/${pass + fail} assertions passed`);
process.exit(fail === 0 ? 0 : 1);
