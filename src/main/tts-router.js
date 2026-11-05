'use strict';
// EN speech routing (T-31 QC-cuoi fix d, 09-10), lifted out of main.js's talk:tts handler so it is testable without
// Electron. Rule: a reply NEVER waits on a Kokoro download or pipeline build. Kokoro is used only once it is ready;
// until then (prefetch still downloading, still loading, or failed) the reply is spoken with the Windows voice
// (SAPI) right away, a prefetch is (re)started in the background, and the choice is logged:
//   [talk:tts] turn=<8 hex> engine=kokoro|sapi|none reason=<why>
// Before this, the first EN reply of a fresh install awaited the whole ~163 MB download (10+ s of silence).
//
// deps: { kokoro: createKokoroTts() result | null, sapi: createLocalTts() result | null, log(line),
//         onProgress(msg) (Kokoro download/pipeline progress for Settings > Voice), onMore({turnId, audio}) }
// speak(p) -> the same result shape every TTS transport returns ({ ok, mime, audios, voice } | { ok:false, error }).
const { stripMarkup } = require('./speech-chunker.js'); // T-31 0.2.3 B1: the Windows voice never reads markup either
// kokoroOnly (Tauri sidecar, T-31-TAURI R1): the Windows voice is never used. A reply that arrives while Kokoro is
// still loading WAITS for the load (the text is already on screen; only the audio waits), then plays with Kokoro; a
// failed load or synth is an explicit error, never a different voice. Electron keeps the SAPI fallback (default false).
// sapiWhileLoading (Tauri, OSS v1 row 15; kokoroOnly only): while Kokoro is NOT ready and still has a load ahead of it
// (idle = fresh start or after the idle unload, downloading, loading) a Windows voice that is installed speaks the reply
// at once and Kokoro keeps loading in the background; once ready the next replies use Kokoro. A FAILED load (state
// error) and a build with no Windows voice keep the explicit-error / wait behaviour above.
function createEnTtsRouter({ kokoro, sapi, log = () => {}, onProgress = null, onMore = () => {}, kokoroOnly = false, loadWaitMs = 0, sapiWhileLoading = false }) {
  const tag = (turnId) => String(turnId).slice(0, 8);
  const NOTHING_TO_SAY = { ok: true, mime: 'audio/wav', audios: [], voice: 'none', reason: 'nothing-to-say' };
  let sapiBusy = false; // sapiWhileLoading: at most one Windows-voice synth in flight

  // live (round 6): a streamed reply still arriving from chat-brain -- Kokoro starts on its first clause instead of
  // waiting for the whole text (kokoro-tts.js speakLive). Without it, the whole text is chunked at once as before.
  function speakKokoro(turnId, text, tEntry, live) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const run = live ? kokoro.speakLive.bind(null, turnId, live) : kokoro.speakStream.bind(null, turnId, text);
      run(({ mime, audio }) => {
        if (!settled) {
          settled = true;
          log(`[talk:tts] turn=${tag(turnId)} handlerEntry->resolve=${Date.now() - tEntry}ms`); // live-E2E fix 1 per-stage timing
          resolve({ ok: true, mime, audios: [audio], voice: 'af_heart' });
        } else onMore({ turnId, audio });
      }).then(() => { if (!settled) { settled = true; resolve(NOTHING_TO_SAY); } }).catch((err) => { if (!settled) { settled = true; reject(err); } });
    });
  }

  async function speakSapi(p, reason) {
    if (!sapi || !sapi.available()) {
      log(`[talk:tts] turn=${tag(p.turnId)} engine=none reason=${reason}+no-windows-voice`);
      return { ok: false, error: { code: 'talk_off', message: 'no voice available on this build', retryable: false } };
    }
    if (!stripMarkup(p.text)) return NOTHING_TO_SAY;
    log(`[talk:tts] turn=${tag(p.turnId)} engine=sapi reason=${reason}`);
    try { return { ok: true, ...(await sapi.speak({ ...p, text: stripMarkup(p.text) })) }; }
    catch (err) { return { ok: false, error: { code: (err && err.code) || 'internal', message: String((err && err.message) || err).slice(0, 200), retryable: false } }; }
  }

  const kokoroError = (code, message) => ({ ok: false, error: { code, message, retryable: code !== 'talk_off' && code !== 'voice_off' } });
  async function speakKokoroOnly(turnId, text, tEntry, live, whole) {
    const deadline = Date.now() + loadWaitMs; // one deadline from the reply start: a failed SAPI attempt counts against it
    if (!kokoro || !kokoro.available()) return speakSapi(await whole(), 'kokoro-unavailable'); // no Kokoro on this PC (not installed): the Windows voice speaks
    if (!kokoro.isReady() && sapiWhileLoading && !sapiBusy && sapi && sapi.available() && kokoro.status().state !== 'error') {
      const s = kokoro.status();
      Promise.resolve(kokoro.prefetch(onProgress)).catch(() => {}); // idempotent: joins the running load or restarts it after an idle unload
      // One SAPI process at a time: an overlapping reply skips SAPI and waits for Kokoro below. Whenever SAPI cannot speak
      // (no voice yet known, declined, failed) the reply falls through to that same Kokoro wait, as before the fallback.
      sapiBusy = true;
      try {
        const r = await speakSapi(await whole(), `kokoro-${s.state}`);
        if (r.ok && r.audios && r.audios.length) return r;
        log(`[talk:tts] turn=${tag(turnId)} engine=sapi reason=declined-${r.ok ? 'no-audio' : (r.error && r.error.code)} -> waiting-for-kokoro`);
      } finally { sapiBusy = false; }
    }
    if (!kokoro.isReady()) {
      log(`[talk:tts] turn=${tag(turnId)} engine=kokoro reason=waiting-for-load state=${kokoro.status().state}`);
      // The wait is capped (loadWaitMs; 0 = none): past it the reply gets an explicit retryable error, the text reply is
      // unaffected and the load keeps going in the background. An unload (voice turned off) mid-load ends it at once.
      let timer = null;
      const left = deadline - Date.now();
      if (loadWaitMs > 0 && left <= 0) return kokoroError('kokoro_loading', 'voice not ready');
      const cap = loadWaitMs > 0 ? new Promise((r) => { timer = setTimeout(() => r('cap'), left); }) : null;
      const res = await (cap ? Promise.race([kokoro.prefetch(onProgress), cap]) : kokoro.prefetch(onProgress));
      if (timer) clearTimeout(timer);
      if (res === 'cap') return kokoroError('kokoro_loading', 'voice not ready');
      if (!res || !kokoro.isReady()) return kokoro.status().state === 'idle' ? kokoroError('voice_off', 'voice is off') : kokoroError('kokoro_load_failed', 'voice failed to load');
    }
    try {
      log(`[talk:tts] turn=${tag(turnId)} engine=kokoro reason=ready${live ? ' stream=1' : ''}`);
      return await speakKokoro(turnId, text, tEntry, live);
    } catch (err) {
      return kokoroError((err && err.message === 'unloaded') ? 'kokoro_unloaded' : 'kokoro_failed', String((err && err.message) || err).slice(0, 200));
    }
  }

  // Filtered to nothing (only a link, code, emoji or dots): settle at once, whichever engine is busy or still loading. The screen keeps the text.
  function speak(p, tEntry = Date.now()) {
    const live = p && p.live;
    if (!live) return stripMarkup(p && p.text) ? speakOn(p, tEntry) : Promise.resolve(NOTHING_TO_SAY);
    const engines = speakOn(p, tEntry);
    const quiet = live.final.then((f) => (stripMarkup((f && f.reply) || live.text() || p.text) ? new Promise(() => {}) : NOTHING_TO_SAY));
    return Promise.race([engines, quiet]);
  }

  async function speakOn(p, tEntry) {
    const turnId = p && p.turnId;
    const text = p && p.text;
    const live = p && p.live;
    // The Windows voice speaks one whole text: a streamed reply is awaited to its end first.
    const whole = async () => ({ turnId, text: live ? ((await live.final).reply || live.text() || text) : text });
    log(`[voice-measure] event=reply-request ts=${new Date().toISOString()} turn=${tag(turnId)} kokoroReady=${Boolean(kokoro && kokoro.available() && kokoro.isReady())}`);
    if (kokoroOnly) return speakKokoroOnly(turnId, text, tEntry, live, whole);
    if (!kokoro || !kokoro.available()) return speakSapi(await whole(), 'kokoro-unavailable');
    if (!kokoro.isReady()) {
      const s = kokoro.status();
      kokoro.prefetch(onProgress); // idempotent: joins the running prefetch, or retries after a failure
      const pct = s.total ? ` ${Math.floor((s.loaded / s.total) * 100)}%` : '';
      return speakSapi(await whole(), `kokoro-${s.state}${pct}`);
    }
    try {
      log(`[talk:tts] turn=${tag(turnId)} engine=kokoro reason=ready${live ? ' stream=1' : ''}`);
      return await speakKokoro(turnId, text, tEntry, live);
    } catch (err) {
      log(`[kokoro-tts] EN speak failed, falling back to local voice: ${String((err && err.message) || err)}`);
      return speakSapi(await whole(), 'kokoro-error');
    }
  }

  return { speak };
}

module.exports = { createEnTtsRouter };
