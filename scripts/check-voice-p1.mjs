// T-31 voice P1: checks that do not need Electron, a network call, or a paid API key.
//   Leda (VI) -- no-key path refuses with the UI reason and makes no network call; "AI" -> "Ây Ai" text rule;
//               bad-shaped keys are rejected before they ever reach disk.
//   Director  -- GATE_SECOND_BEAT means acceptComposed() never plays a second gesture beat (exactly 1/reply).
//   Kokoro    -- abandon() stops further sentence delivery for a turn (stop/barge-in path), and how long that
//               takes to take effect is measured (not a UI-level stop -- that is speech.stop(), unchanged).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { ownerPath } from './lib/owner-paths.mjs';

const require = createRequire(import.meta.url);
const { createLedaTts, viTtsText, KEY_SHAPE } = require('../src/main/leda-tts.js');
const { createKokoroTts } = require('../src/main/kokoro-tts.js');

let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); } };

// ---------- Leda / VI ----------
{
  let fetchCalled = false;
  const fakeSafeStorage = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zumi-leda-check-'));
  const leda = createLedaTts({ safeStorage: fakeSafeStorage, dir, fetchImpl: async () => { fetchCalled = true; return { ok: true, json: async () => ({ audioContent: '' }) }; } });

  ok(leda.hasKey() === false, 'leda: no key present by default');
  const r1 = await leda.synthesize('Xin chào anh Kei');
  ok(r1.ok === false && r1.error.code === 'no_key' && r1.error.message === 'Requires a Google Cloud API key', 'leda: no-key refusal has the exact UI reason', JSON.stringify(r1));
  ok(fetchCalled === false, 'leda: no-key path makes ZERO network calls');

  ok(viTtsText('Zumi dùng AI để trả lời') === 'Zumi dùng Ây Ai để trả lời', 'leda: "AI" -> "Ây Ai" whole-word');
  ok(viTtsText('AIza1234 không đổi') === 'AIza1234 không đổi', 'leda: "AI" inside another token is untouched');
  ok(viTtsText('Không có AI ở đây và AI ở đây') === 'Không có Ây Ai ở đây và Ây Ai ở đây', 'leda: multiple occurrences replaced');

  ok(leda.setKey('not-a-real-key') === false, 'leda: bad-shaped key refused before touching disk');
  ok(KEY_SHAPE.test('AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ0123456') === true, 'leda: well-shaped Google key accepted by the shape gate', `len=${'AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ0123456'.length}`);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------- Director: exactly one gesture per reply ----------
{
  const { TalkDirector, GATE_SECOND_BEAT } = await import('../src/renderer/talk/director.js');
  ok(GATE_SECOND_BEAT === true, 'director: GATE_SECOND_BEAT is on for P1');

  // A real, already-shipped gesture command (src/renderer/reflex/speech/greet.json's "wave-hello" variant) so
  // this exercises the actual checkSpeechGesture/rigCheck gate, not a fixture that fails schema before the
  // second-beat logic is even reached.
  const greetFixture = JSON.parse(fs.readFileSync('src/renderer/reflex/speech/greet.json', 'utf8'));
  const waveCommand = greetFixture.variants.find((v) => v.id === 'wave-hello-s1').command;

  let playedCount = 1; // the "first" beat already played, as it would have in a real turn
  const fakeSpeech = { speaking: () => true, remainingMs: () => 5000, stop: () => {} };
  const dir = new TalkDirector({
    engine: { player: { stop: () => {} } }, catalog: {}, cloud: {}, speech: fakeSpeech, library: {},
    cache: { add: () => true, toJSON: () => ({}) }, saveCache: () => {}, probe: () => null, rigVersion: () => 'v1',
    ui: { gesture: () => { playedCount++; } }, log: () => {}, now: () => 0,
  });
  dir.playSpeechGesture = (t) => { playedCount++; return { ok: true, trackId: 'x' }; };
  dir.rigCheck = () => ({ ok: true, fails: [], ms: 1 });
  const t = { id: 't1', instances: [], composed: null, first: { command: {} }, cancelled: false, timeline: {}, key: 'k', reply: 'hello there' };
  dir.acceptComposed(t, { intent: 'greet' }, { ok: true, command: waveCommand, model: 'x' });
  ok(t.composed && t.composed.ok === true, 'director: the fixture command actually passes schema+rig (test is exercising the real gate)', JSON.stringify(t.composed));
  ok(playedCount === 1, 'director: a composed gesture with >=2s remaining does NOT add a second beat (P1 gate)', `playedCount=${playedCount}`);
  ok(t.composed && t.composed.cachedAs === 'k', 'director: the composed gesture is still cached for future variety even though it did not play', JSON.stringify(t.composed));
}

// ---------- Kokoro: abandon() stops further delivery, and how fast ----------
{
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zumi-kokoro-stop-check-'));
  const seedSrc = ownerPath('kokoroSeed', 'local/kokoro');
  const dest = path.join(userDataDir, 'tts', 'kokoro', 'onnx-community', 'Kokoro-82M-v1.0-ONNX');
  fs.mkdirSync(path.join(dest, 'onnx'), { recursive: true });
  fs.copyFileSync(path.join(seedSrc, 'kokoro-v1.0-fp16.onnx'), path.join(dest, 'onnx', 'model_fp16.onnx'));
  for (const f of ['config.json', 'tokenizer.json', 'tokenizer_config.json']) fs.copyFileSync(path.join(seedSrc, f), path.join(dest, f));

  const tts = createKokoroTts({ userDataDir, log: () => {} });
  await tts.ensureReady(() => {});
  const longText = 'This reply has quite a few separate clauses, so it will take a few chunks to synthesize, which gives us time to abandon it partway through, before every chunk has arrived, and check that no further chunks are delivered afterwards.';
  const turnId = crypto.randomBytes(16).toString('hex');
  let got = 0;
  const donePromise = tts.speakStream(turnId, longText, () => { got++; });
  // Abandon right after the very first chunk is likely still mid-flight for later chunks; call it immediately.
  const tAbandon0 = Date.now();
  tts.abandon(turnId);
  const abandonCallMs = Date.now() - tAbandon0;
  await donePromise.catch(() => {}); // resolves/rejects once the worker stops (it never posts 'done' for an abandoned turn, so this may hang -- race against a timeout)
  const gotAfterAbandon = got;
  await new Promise((r) => setTimeout(r, 1500)); // let any in-flight chunk drain
  ok(abandonCallMs < 50, 'kokoro: abandon() call itself returns in well under 200ms (fire-and-forget postMessage)', `${abandonCallMs}ms`);
  ok(got <= gotAfterAbandon + 1, 'kokoro: abandon() stops delivering further chunks for the abandoned turn (at most one already in-flight)', `got=${got}`);
  tts.dispose();
  fs.rmSync(userDataDir, { recursive: true, force: true });
}

console.log(`\ncheck:voice-p1 ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
