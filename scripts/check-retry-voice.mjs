// T-31 voice P1 live-E2E fix 3: no Electron needed (plain TalkDirector with fake deps, same convention as
// check-voice-p1.mjs's existing director test). Covers:
//   - a real TTS failure (ok:false) shows a retry control and plays NO speech-start gesture;
//   - a benign no-audio reason (no-google-key / no-vi-voice / voice-off / voice-off-lang) also plays no gesture, but shows the
//     reason note instead of a retry control (nothing to retry -- there was never a real failure);
//   - a normal success plays exactly one gesture and shows neither note nor retry control;
//   - retryVoice() re-synthesizes for the SAME turn and, once audio succeeds, plays the gesture and hides the
//     retry control.
import { createRequire } from 'node:module';
import { TalkDirector } from '../src/renderer/talk/director.js';
const { replyOutcome } = createRequire(import.meta.url)('../src/main/tts-select.js');

let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); } };

function makeDirector({ ttsImpl }) {
  const calls = { gesture: 0, voiceNote: [], voiceFailed: [] };
  const ui = {
    userLine() {}, thinking() {}, reply() {}, analysis() {},
    gesture() { calls.gesture++; },
    voiceNote(text) { calls.voiceNote.push(text); },
    voiceFailed(onRetry) { calls.voiceFailed.push(onRetry); },
  };
  const dir = new TalkDirector({
    engine: { playCommand: () => ({ ok: true, trackId: 'trk1' }), player: { stop() {} }, waitLatency: () => Promise.resolve(null) },
    catalog: { get: () => null },
    cloud: { turn: async () => ({ ok: true, reply: 'hello there', analysis: null, gesture: { intent: 'greet', energy: 'med', deixis: null, brief: 'say hi' } }), tts: ttsImpl },
    speech: {
      prepare: async (audios) => ({ durationMs: 500, start: () => ({ startedAt: 0, endsAt: 500, ended: Promise.resolve('ended') }) }),
      speaking: () => false, remainingMs: () => 0, stop() {}, append() {},
    },
    library: { pick: () => ({ command: { type: 'reflex', id: 'wave' }, faces: 'none', id: 'wave-1' }) },
    cache: { pick: () => null, variants: () => [1, 2, 3], add: () => false, toJSON: () => ({}) },
    saveCache: () => {},
    probe: () => null,
    rigVersion: () => 'v1',
    ui,
    log: () => {},
  });
  return { dir, calls, ui };
}

// ---------- 1. a real failure: no gesture, retry control shown ----------
{
  let ttsCalls = 0;
  const { dir, calls } = makeDirector({
    // first call (the real turn) fails; the retry (second call) succeeds.
    ttsImpl: async () => {
      ttsCalls++;
      if (ttsCalls === 1) return { ok: false, error: { code: 'kokoro_error', message: 'boom', retryable: true } };
      return { ok: true, mime: 'audio/wav', audios: [new ArrayBuffer(8)], voice: 'af_heart' };
    },
  });
  const rec = await dir.send('hi there');
  ok(ttsCalls === 1, 'tts failure: cloud.tts was called once for the turn');
  ok(calls.gesture === 0, 'tts failure: no speech-start gesture played (no gesture without voice)', `gesture calls=${calls.gesture}`);
  ok(calls.voiceNote.length === 0, 'tts failure: no benign voiceNote shown (this was a real failure, not a known no-voice reason)');
  ok(calls.voiceFailed.length === 1 && typeof calls.voiceFailed[0] === 'function', 'tts failure: ui.voiceFailed was called with a retry function', JSON.stringify(calls.voiceFailed.map((f) => typeof f)));
  ok(rec.ttsError && rec.ttsError.code === 'kokoro_error', 'tts failure: the turn record carries the real error', JSON.stringify(rec.ttsError));
  ok(dir.lastTurn && dir.lastTurn.ttsFailed === true, 'tts failure: t.ttsFailed is true on the finished turn');

  // ---------- retryVoice(): second call to cloud.tts succeeds -> gesture now plays, control hides ----------
  const t = dir.lastTurn;
  await dir.retryVoice(t);
  ok(ttsCalls === 2, 'retryVoice: called cloud.tts again for the same turn');
  ok(calls.gesture === 1, 'retryVoice: the speech-start gesture plays once audio succeeds', `gesture calls=${calls.gesture}`);
  ok(t.ttsFailed === false, 'retryVoice: t.ttsFailed cleared after a successful retry');
  ok(calls.voiceFailed[calls.voiceFailed.length - 1] === null, 'retryVoice: ui.voiceFailed(null) hides the control again');
}

// ---------- 2. benign no-audio reason: no gesture, note shown, NOT a retry control ----------
{
  const { dir, calls } = makeDirector({ ttsImpl: async () => ({ ok: true, mime: 'audio/wav', audios: [], voice: 'none', reason: 'no-google-key' }) });
  await dir.send('xin chao');
  ok(calls.gesture === 0, 'benign no-key: no speech-start gesture played', `gesture calls=${calls.gesture}`);
  ok(calls.voiceNote.length === 1, 'benign no-key: voiceNote shown');
  ok(calls.voiceFailed.every((f) => f === null || f === undefined), 'benign no-key: retry control never shown (nothing to retry)', JSON.stringify(calls.voiceFailed));
}

// ---------- 2b. the results main REALLY returns for a Vietnamese reply with no usable voice (T-31 review fix 2) ----------
// Google (Leda) with no key answers the typed { ok:false, error:{ code:'no_key' } }; talk:tts runs it through
// replyOutcome() (0.2.4 behaviour: the "needs a Google key" note, nothing to retry). VI source = Off answers
// { ok:true, reason:'voice-off-lang' }. Neither may show a Retry control.
{
  const ledaNoKey = { ok: false, error: { code: 'no_key', message: 'Requires a Google Cloud API key', retryable: false } };
  const mainResult = replyOutcome(ledaNoKey, { providerId: 'google', isSay: false });
  ok(mainResult.ok === true && mainResult.reason === 'no-google-key' && mainResult.audios.length === 0, 'main: a reply on Google with no key -> the benign no-google-key result', JSON.stringify(mainResult));
  const { dir, calls } = makeDirector({ ttsImpl: async () => mainResult });
  const rec = await dir.send('xin chào, hôm nay thế nào?');
  ok(calls.voiceNote.length === 1 && calls.voiceFailed.every((f) => f === null || f === undefined) && dir.lastTurn.ttsFailed === false, 'VI reply, no Google key: the note shows, NO Retry control, the turn is not marked failed', JSON.stringify({ notes: calls.voiceNote.length, failed: calls.voiceFailed.map((f) => typeof f), ttsFailed: dir.lastTurn.ttsFailed }));
  ok(rec.ttsError === 'no-google-key', 'VI reply, no Google key: the turn record keeps the reason', JSON.stringify(rec.ttsError));
}
{
  const offLang = { ok: true, mime: 'audio/wav', audios: [], voice: 'none', reason: 'voice-off-lang' };
  const { dir, calls } = makeDirector({ ttsImpl: async () => replyOutcome(offLang, { providerId: 'off' }) });
  await dir.send('xin chào');
  ok(calls.voiceFailed.every((f) => f === null || f === undefined) && dir.lastTurn.ttsFailed === false, 'VI source Off (voice-off-lang): no Retry, not marked failed', JSON.stringify(calls.voiceFailed.map((f) => typeof f)));
}
{
  const noKey = { ok: false, error: { code: 'no_key' } };
  ok(replyOutcome(noKey, { providerId: 'elevenlabs', isSay: false }) === noKey, 'replyOutcome: another provider no_key stays a typed error (no silent fallback)');
  ok(replyOutcome(noKey, { providerId: 'google', isSay: true }) === noKey, 'replyOutcome: a Zumi line (isSay) keeps the typed error -- say.js turns it into a subtitle');
  const net = { ok: false, error: { code: 'network', retryable: true } };
  ok(replyOutcome(net, { providerId: 'google', isSay: false }) === net, 'replyOutcome: a real Google failure is still a failure (Retry stays)');
  const { dir, calls } = makeDirector({ ttsImpl: async () => replyOutcome(net, { providerId: 'google' }) });
  await dir.send('xin chào');
  ok(calls.voiceFailed.some((f) => typeof f === 'function'), 'a real VI failure still shows the Retry control');
}

{
  const fs = await import('node:fs');
  const core = fs.readFileSync(new URL('../src/main/talk-voice-core.mjs', import.meta.url), 'utf8');
  ok(/return replyOutcome\(r, \{ providerId, isSay: liveSay \}\)/.test(core), 'talk-voice-core.mjs (the extracted talk:tts route): returns the adapter result through replyOutcome (source guard)');
}

// ---------- 3. normal success: exactly one gesture, no note/retry ----------
{
  const { dir, calls } = makeDirector({ ttsImpl: async () => ({ ok: true, mime: 'audio/wav', audios: [new ArrayBuffer(8)], voice: 'af_heart' }) });
  await dir.send('hello');
  ok(calls.gesture === 1, 'success: exactly one speech-start gesture played', `gesture calls=${calls.gesture}`);
  ok(calls.voiceNote.length === 0, 'success: no voiceNote');
  ok(calls.voiceFailed.every((f) => f === null || f === undefined), 'success: retry control never shown');
}

console.log(`\ncheck:retry-voice ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
