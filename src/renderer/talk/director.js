// TalkDirector: one spoken turn, end to end, with the latency hidden behind the voice.
//   send -> local ack reflex -> (1.2 s) "thinking" gesture -> turn call (reply + analysis + intent)
//        -> TTS fetch  ||  pick a gesture for speech start (cache > library > built-in fallback)
//                      ||  compose a NEW gesture when the key has < 3 cached variants (plays as a second beat only if
//                          >= 2 s of speech remain, otherwise it only fills the cache)
//        -> speech start: gesture onset aligned with the first audio sample -> speech end.
// Every gesture goes through checkSpeechGesture + the RigProbe rules before it plays or is cached.
// Model output (reply, analysis, brief) is plain text for the UI; it is never parsed as markup or code.
import { checkSpeechGesture, checkAnalysis } from './validate.js';
import { BUILTIN_FALLBACK, cacheKey, estimateSpeechMs, deixisSide } from './intents.js';
import { shouldSpeakReply } from './reply-speech.js';
import { failureLineKey } from './error-line.js';
import { t as tr, en } from '../i18n.js';

// Think ack (T-31 voice round 6; CoS decision 09-10 after the spare run): if NO AUDIO has started THINK_AFTER_MS after
// Enter, Zumi plays the think gesture until her voice starts. The soft chime (SpeechOut.chime: Web Audio, no file, no
// network, no TTS worker time) plays with it ONLY when the owner turned on Settings > Voice "Soft sound while thinking"
// (settings.json thinkSound, off by default). Keyed on audio start, not on reply text: with a streamed reply the text
// can arrive well before the first audio. (Round 6 run C briefly used 800 ms + chime always: it fired on 17/17 turns.)
export const THINK_AFTER_MS = 1200;
export const SECOND_BEAT_MIN_MS = 2000;
// T-31 voice P1 item 5 (approved): exactly ONE gesture per reply. The composed beat below still plays-and-caches
// on the FIRST time a (intent, energy, durBucket, deixis, rigVersion) key is seen -- new gesture variety is not
// lost -- it just never plays as a second beat on top of an already-played first gesture. Flip this back on only
// with a new owner decision.
export const GATE_SECOND_BEAT = true;
export const TURN_FAILED_VI = en('app.replyFailed');

// T-31 0.2.3 B2 item 1: the emotion presets the face can hold through a spoken reply. These are exactly
// chat-brain's EMOTION_PRESETS values (joy->happy, sad->sad, surprised->surprised, angry->angry,
// neutral->relaxed), all valid schema EXPRESSIONS. Anything else is ignored: the face stays neutral rather than
// guessing a preset. Held at a fixed weight so the model cannot over-drive the face.
const HELD_EMOTIONS = new Set(['happy', 'sad', 'surprised', 'angry', 'relaxed']);
const HELD_EMOTION_WEIGHT = 0.8;

// Round 6 per-turn stage log, ms from send: request start -> first token -> first clause (main) -> first clause here ->
// Kokoro chunk 0 here -> audio start. Main's stages are epoch ms (r.timing); the rest is this turn's own timeline.
function stagesOf(t) {
  const ep = (v) => (typeof v === 'number' ? v - t.wallT0 : null);
  const tm = t.timing || {};
  return {
    requestStart: ep(tm.requestAt), firstToken: ep(tm.firstTokenAt), firstClause: ep(tm.firstClauseAt),
    replyInRenderer: t.timeline.replyAt ?? null, kokoroChunk0: t.timeline.ttsResolvedAt ?? null, audioStart: t.timeline.speechStartAt ?? null,
  };
}

const hex128 = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
const clampInt = (v, a, b) => Math.round(Math.min(b, Math.max(a, v)));

export class TalkDirector {
  // deps: { engine, catalog, cloud (window.zumi.talk), speech (SpeechOut), library, cache, saveCache(json),
  //         probe() -> RigProbe|null, rigVersion() -> string, ui, log(record), now() }
  constructor(deps) {
    Object.assign(this, deps);
    this.now = deps.now || (() => performance.now());
    this.history = [];
    this.turn = null;
    this.lastTurn = null; // the most recently finished turn, for retryVoice()
    this.saveTimer = null;
    this.listeners = new Set();
  }

  onEvent(cb) { this.listeners.add(cb); return () => this.listeners.delete(cb); }
  emit(type, data) { for (const cb of this.listeners) { try { cb({ type, ...data }); } catch (e) { console.error(e); } } }

  persist() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveCache(JSON.stringify(this.cache.toJSON())), 400);
  }

  // "Đọc to câu trả lời khi tắt mic" (T-31 settings P1): the stored boolean, default ON. Read from main each turn;
  // never throws -- if the IPC is unavailable the default stands, so a turn is never silenced by accident.
  async speakTypedWhenMicOff() {
    if (!this.cloud.getSpeakTypedWhenMicOff) return true;
    try { return (await this.cloud.getSpeakTypedWhenMicOff()) !== false; } catch { return true; }
  }

  // Barge-in: the user sent something while Zumi was still thinking or speaking.
  cancel(why) {
    const t = this.turn;
    if (!t || t.done) return;
    t.cancelled = why;
    const t0 = this.now();
    this.speech.stop(); // silences playback immediately -- this is what the <=200ms stop acceptance measures
    // tell main to stop synthesizing further chunks (best-effort, no ack needed; a refusal from a dead sidecar changes nothing)
    if (this.cloud.ttsAbandon) Promise.resolve().then(() => this.cloud.ttsAbandon(t.id)).catch(() => {});
    for (const id of t.instances) this.engine.player.stop(id);
    t.timeline.cancelledAt = t0;
    this.emit('cancelled', { turnId: t.id, why, stopMs: +(this.now() - t0).toFixed(1) });
  }

  // gesture: { command, source, labelVi, flip?, entry? } -> engine track info
  playSpeechGesture(t, g) {
    const res = this.engine.playCommand(g.flip ? { ...g.command, mirror: 'random' } : g.command, 'speech', {
      side: g.flip ? -1 : 1,
      labelVi: `${g.labelVi} · ${tr('source.' + g.source)}`,
    });
    if (res && res.ok) t.instances.push(res.trackId);
    this.ui.gesture(g.labelVi, tr('source.' + g.source));
    return res;
  }

  // T-31 0.2.3 B2 item 1: hold the model's chosen emotion as a face-only sustained layer for the WHOLE spoken
  // reply. A speech gesture is a fixed 1.5-3.5 s one-shot, so on a long reply the face used to fall back to
  // neutral while the voice kept going; this layer starts with the voice and stops with it (finish()/cancel()
  // stop t.instances). Gated through checkSpeechGesture -- the face-only exemption is what lets a sustained
  // command through at all -- and played BEFORE the body gesture so the body gesture's own interrupt never
  // matters (and the player never ducks the held face: reflex/player.js isFaceOnly).
  playHeldEmotion(t, preset) {
    if (!this.engine || !this.engine.playCommand || !HELD_EMOTIONS.has(preset)) return;
    const v = checkSpeechGesture({ id: 'speech-emotion', sustain: true, expressions: [{ name: preset, weight: HELD_EMOTION_WEIGHT }] });
    if (!v.ok) return;
    const res = this.engine.playCommand(v.command, 'speech', { labelVi: tr('intent.' + (t.intent || 'none')) });
    if (res && res.ok) { t.emotionId = res.trackId; t.instances.push(res.trackId); }
  }

  // RigProbe gate. Fails closed: without a working probe no composed gesture plays or enters the cache
  // (library seeds and built-in reflexes are already vetted and keep working).
  rigCheck(command, flip) {
    const probe = this.probe();
    if (!probe) return { ok: false, fails: ['probe unavailable'], rules: null };
    return probe.check(command, { flip });
  }

  pickAtStart(t, g, key) {
    const side = deixisSide(g.deixis);
    const hit = this.cache.pick(key);
    if (hit) return { command: hit.command, source: 'cache', labelVi: tr('intent.' + g.intent) };
    const lib = this.library.pick(g.intent, g.energy);
    if (lib) {
      const faces = lib.faces === 'screen-right' ? 1 : lib.faces === 'screen-left' ? -1 : 0;
      return { command: lib.command, source: 'library', labelVi: tr('intent.' + g.intent), flip: Boolean(side && faces && side !== faces), id: lib.id };
    }
    const fb = BUILTIN_FALLBACK[g.intent];
    if (fb) {
      const def = this.catalog.get(fb[0]);
      const v = def && def.variants.find((x) => x.id === fb[1]);
      if (v) return { command: v.command, source: 'builtin', labelVi: tr('intent.' + g.intent), id: `${fb[0]}/${fb[1]}` };
    }
    return null;
  }

  async send(text) {
    if (this.turn && !this.turn.done) this.cancel('barge-in');
    // A Check verdict still pending for the previous turn never reaches this one.
    if (this.turn && this.turn.offCheck) { this.turn.offCheck(); this.turn.offCheck = null; }
    // wallT0: epoch ms at send, to line main's epoch stage times (r.timing) up with this turn's own clock.
    const t = { id: hex128(), text, t0: this.now(), wallT0: Date.now(), instances: [], timeline: {}, cancelled: null, done: false };
    this.turn = t;
    const rel = (ms) => +(ms - t.t0).toFixed(1);
    // "Đọc to câu trả lời khi tắt mic" (T-31 settings P1): read per turn, in parallel with the turn call, so a
    // change in Settings applies from the next Enter and it never delays the reply.
    const speakTypedP = this.speakTypedWhenMicOff();
    this.ui.userLine(text);
    this.ui.thinking(true);
    this.emit('sent', { turnId: t.id });

    // think ack if no audio by THINK_AFTER_MS (gesture; chime only if the owner turned it on). The setting is read
    // per turn, so a change in Settings applies from the next Enter.
    if (this.cloud.getThinkSound) this.cloud.getThinkSound().then((on) => { t.thinkSound = on === true; }).catch(() => {});
    t.thinkTimer = setTimeout(() => {
      if (t.cancelled || t.done || t.audioStarted) return;
      const v = this.library.pick('think');
      if (v) { const r = this.engine.playCommand(v.command, 'speech', { labelVi: `${tr('intent.think')} · ${tr('source.library')}` }); if (r && r.ok) { t.thinkId = r.trackId; t.instances.push(r.trackId); } }
      t.timeline.thinkAt = rel(this.now());
      if (t.thinkSound && this.speech.chime && this.speech.chime()) t.timeline.ackSoundAt = rel(this.now());
      this.emit('thinking', { turnId: t.id });
    }, THINK_AFTER_MS);

    // The rest of a streamed reply (replyMore / replyDone) is pushed as soon as the model writes it, which for a fast provider is
    // before the head comes back. So listen BEFORE the request (and, where the transport's listen is asynchronous, until it is
    // live: the Tauri shim's unsubscribe carries `ready`); what arrives before the head is handled is kept and applied after it.
    // Subscribing after the head dropped those events: the caption kept the first clause (alpha.14 launch fix N1). The Check
    // verdict (talk:checkDone) follows the final reply, so it can beat the head too: same rule.
    const early = {};
    let onMore = (more) => { early.more = more; };
    let onDone = (fin) => { early.done = fin; };
    let onCheck = (c) => { early.check = c; };
    const offMore = this.cloud.onReplyMore ? this.cloud.onReplyMore(t.id, (more) => onMore(more)) : null;
    const offDone = this.cloud.onReplyDone ? this.cloud.onReplyDone(t.id, (fin) => onDone(fin)) : null;
    const offCheck = this.cloud.onCheckDone ? this.cloud.onCheckDone(t.id, (c) => onCheck(c)) : null;
    // A newer send() drops this turn's pending Check (top of send); offReply never touches it while the turn can still get one.
    t.offCheck = offCheck;
    const offReply = () => { if (offMore) offMore(); if (offDone) offDone(); };
    const offAll = () => { offReply(); if (t.offCheck) { t.offCheck(); t.offCheck = null; } };
    await Promise.all([offMore && offMore.ready, offDone && offDone.ready, offCheck && offCheck.ready]);

    let r;
    try {
      r = await this.cloud.turn({ turnId: t.id, message: text, history: this.history.slice(-6) });
    } catch (e) {
      // A rejected call (the shim's sidecar_not_ready, a dead sidecar) ends like any failed turn below: listeners released, the
      // thinking indicator and think ack stopped (finish), the normal failure line, and send() resolves. It used to rethrow,
      // leaving the indicator on, the think gesture and chime to start, and an unhandled rejection in app.js's onSend.
      r = { ok: false, error: { code: 'turn_rejected', message: String((e && e.message) || e) } };
    }
    if (t.cancelled) { offAll(); return this.finish(t, 'cancelled'); }
    t.timeline.replyAt = rel(this.now());
    this.ui.thinking(false);
    if (!r || !r.ok) {
      t.error = r && r.error;
      // T-31 BYOK: main classifies the provider failure (auth / credit / quota / upstream), so the line says WHY:
      // a bad key, an empty provider account, a busy provider, or today's generic failure (error-line.js). A free-tier
      // 429 keeps the provider's name (main.js stamps it), so "hết lượt miễn phí hôm nay của {provider}" stays exact.
      // T-31 free LLM (S1): the Tauri sidecar fails a Gemini turn closed until the 18+ setting is stored. The card's
      // confirm is the only place to give it; offer it here too, in Tauri only (Electron never produces this code).
      const ageConfirm = Boolean(r && r.error && r.error.code === 'age_confirm_required');
      const failed = ageConfirm ? tr('app.ageConfirmRequired')
        : tr(failureLineKey(r && r.error), r && r.error && r.error.provider ? { provider: r.error.provider } : undefined);
      if (ageConfirm && this.ui.ageConfirm) this.ui.ageConfirm();
      offAll();
      this.ui.reply(null, failed);
      this.ui.analysis(null, tr('app.analysisMissing'));
      return this.finish(t, 'turn-failed');
    }
    this.ui.reply(r.reply);
    if (r.explains === false) {
      // The BYO chat brain (chat-brain.js) never asks the model for an explanation, so there is nothing that failed:
      // the panel keeps what is real (the reflex timing line) and never claims "could not explain". cloud.js's turn
      // contract does promise one, so a null analysis there still says so below.
      t.analysis = { shown: null, reason: 'this chat path does not write an explanation', raw: null };
    } else {
      const an = checkAnalysis(r.analysis);
      this.ui.analysis(an.ok ? an.lines : null, tr('app.analysisMissing'));
      t.analysis = { shown: an.ok ? an.lines : null, reason: an.ok ? null : an.reason, raw: r.analysis };
    }
    t.reply = r.reply;
    t.timing = r.timing || null;
    // Models by role (T-31 zumi-roles): a Plan outline comes with the reply's head, a Look up's sources with the final
    // reply, a Check verdict after it (only on a streamed turn). ui.roles paints the chip row; nothing here is spoken.
    t.roles = { planned: r.planned === true, outline: typeof r.outline === 'string' ? r.outline : null, sources: [], check: null };
    if (this.ui.roles) this.ui.roles(t.roles);
    const pushHistory = (reply) => {
      t.historyEntry = { role: 'assistant', text: reply }; // a Check correction is appended to it later
      this.history.push({ role: 'user', text }, t.historyEntry);
      if (this.history.length > 6) this.history.splice(0, this.history.length - 6);
    };
    if (r.streaming && offMore && offDone) {
      // Round 6: r.reply is only the first clause; the rest streams in. The bubble grows while Zumi already speaks;
      // the history gets the final reply. Updates for a turn that is no longer current never touch the UI.
      t.streaming = true;
      const live = () => this.turn === t && !t.cancelled;
      onMore = (more) => { t.reply = more; if (live()) this.ui.reply(more); };
      onDone = (fin) => {
        offReply();
        t.timeline.replyDoneAt = rel(this.now());
        if (fin.reply) t.reply = fin.reply;
        if (!fin.ok) t.streamError = fin.error || 'stream_failed';
        if (live()) this.ui.reply(t.reply);
        if (Array.isArray(fin.sources) && fin.sources.length) { t.roles.sources = fin.sources; if (live() && this.ui.roles) this.ui.roles(t.roles); }
        if (!t.cancelled) pushHistory(t.reply);
      };
      // The Check verdict arrives after the final reply (Zumi is already speaking): a chip, and a correction as text
      // under the reply + in the history, so the next turn knows. Dropped if a newer turn started meanwhile.
      onCheck = (c) => {
        if (t.offCheck) { t.offCheck(); t.offCheck = null; }
        t.roles.check = c;
        if (c.verdict === 'fix' && c.text && t.historyEntry) t.historyEntry.text += ` (Correction: ${c.text})`;
        if (live() && this.ui.roles) this.ui.roles(t.roles);
        this.emit('checked', { turnId: t.id, verdict: c.verdict });
      };
      if ('more' in early) onMore(early.more); // arrived before the head: apply in order
      if (early.done) onDone(early.done);
      if (early.check) onCheck(early.check);
    } else {
      offAll();
      pushHistory(r.reply);
    }

    const g = r.gesture;
    t.intent = g.intent;
    t.gesture = g; // kept so retryVoice() can re-pick a speech-start gesture the same way send() would
    const rigVersion = this.rigVersion();
    const estMs = estimateSpeechMs(r.reply);
    // This send() IS the typed path (the composer is the only input in this build). When the owner turns the switch
    // off, no TTS is requested at all: the turn comes out silent and benign -- the same ok:true/no-audio shape as
    // "voice off" -- so there is no retry control and no gesture without a voice (prepared stays null below).
    const speakTyped = shouldSpeakReply({ speakTypedWhenMicOff: await speakTypedP });
    t.typedSpeechGated = !speakTyped;
    t.timeline.ttsRequestedAt = rel(this.now());
    // A rejected TTS call (the shim's sidecar_not_ready) is a TTS failure like an ok:false answer: the shown reply stands,
    // the turn ends without voice and offers the retry control. Unhandled, it skipped finish() (review R4 should-fix).
    const ttsP = speakTyped
      ? this.ttsCall(t.id, r.reply)
      : Promise.resolve({ ok: true, mime: 'audio/wav', audios: [], voice: 'none', reason: 'voice-off' });
    // Sentence-chunked streaming (T-31 voice P1 item 2): the main process may still be synthesizing sentence 2+
    // of this reply after `ttsP` already resolved with sentence 1 -- feed each one into the already-playing
    // schedule as it arrives. A non-streaming transport (cloud.js fixtures, VI/Leda, SAPI fallback) never calls
    // this, so nothing changes for those paths. Unsubscribed in finish() so a late chunk for a cancelled/old
    // turn can never reach a newer one.
    const offTtsMore = this.cloud.onTtsMore ? this.cloud.onTtsMore(t.id, (buf) => { if (!t.cancelled) this.speech.append(buf); }) : null;
    t.offTtsMore = offTtsMore;

    // compose a new variant while the key is thin (cache only; library seeds do not count)
    const estKey = cacheKey(g, estMs, rigVersion);
    t.composed = null;
    let composeP = null;
    if (g.intent !== 'none' && this.cache.variants(estKey).length < 3) {
      t.timeline.composeAskedAt = rel(this.now());
      // A rejected compose is a failed compose (acceptComposed records { ok:false, reason }); the turn goes on.
      composeP = Promise.resolve().then(() => this.cloud.gesture({ turnId: t.id, intent: g.intent, brief: (g.brief || g.intent).slice(0, 120), energy: g.energy, deixis: g.deixis, targetMs: clampInt(estMs, 1500, 3500), rigVersion }))
        .catch((e) => ({ ok: false, error: { code: 'gesture_rejected', message: String((e && e.message) || e) } }))
        .then((res) => this.acceptComposed(t, g, res));
    }

    const tts = await ttsP;
    t.timeline.ttsResolvedAt = rel(this.now());
    if (t.cancelled) return this.finish(t, 'cancelled');
    let prepared = null;
    // A typed "no voice for this language" result carries ok:true with no audio: say so honestly instead of a silent,
    // unexplained turn (never hand SpeechOut an empty list — it would have nothing to play). A REAL failure
    // (ok:false, or prepare()/decode throwing) is different from those known/benign no-audio reasons: it gets a
    // visible retry control instead of (or in addition to) a note (T-31 voice P1 live-E2E fix 3).
    let ttsFailed = false;
    if (tts && tts.ok && Array.isArray(tts.audios) && tts.audios.length) {
      try { prepared = await this.speech.prepare(tts.audios); t.timeline.audioPreparedAt = rel(this.now()); }
      catch (e) { t.ttsError = String(e && e.message || e); ttsFailed = true; }
    } else {
      t.ttsError = tts && (tts.reason || tts.error);
      if (tts && tts.ok && tts.reason === 'no-vi-voice' && this.ui.voiceNote) this.ui.voiceNote(tr('app.noViVoice'));
      else if (tts && tts.ok && tts.reason === 'no-google-key' && this.ui.voiceNote) this.ui.voiceNote(tr('app.noGoogleKey'));
      else if (!(tts && tts.ok && (tts.reason === 'voice-off' || tts.reason === 'voice-off-lang' || tts.reason === 'nothing-to-say'))) ttsFailed = true; // ok:false, or an unrecognized reason -- a genuine failure, not a known by-design silence
    }
    if (t.cancelled) return this.finish(t, 'cancelled');
    t.ttsFailed = ttsFailed;
    if (this.ui.voiceFailed) this.ui.voiceFailed(ttsFailed ? () => this.retryVoice(t) : null);
    const speechMs = prepared ? prepared.durationMs : estMs;
    t.speechMs = Math.round(speechMs);
    t.key = cacheKey(g, speechMs, rigVersion);

    // gesture for speech start: a composed one that already arrived wins, then cache / library / built-in.
    // Gated on `prepared` (T-31 voice P1 live-E2E fix 3, "no gesture without voice"): the live E2E found the
    // avatar still gesturing on a turn with NO audio (failure, voice-off, or no-voice-for-language) -- to the
    // owner that looks like Zumi reacted with no voice, with no visible reason. Suppressing the gesture (rather
    // than swapping in a generic "sorry" gesture) keeps this correct without inventing a new gesture asset: the
    // voiceNote/retry control already says why there is no voice, so the avatar simply stays still instead of
    // adding a second, unexplained signal.
    let first = null;
    if (prepared && g.intent !== 'none') {
      if (t.composed && t.composed.ok) { first = { command: t.composed.command, source: 'composed', labelVi: tr('intent.' + g.intent) }; t.composed.played = true; }
      else first = this.pickAtStart(t, g, t.key);
    }
    const startNow = this.now();
    let audio = null;
    if (prepared) {
      // The voice starts: no think ack from here on, and a running one gives way to the speech gesture.
      t.audioStarted = true;
      clearTimeout(t.thinkTimer);
      if (t.thinkId) this.engine.player.stop(t.thinkId);
      audio = prepared.start();
      // The held emotion starts with the voice, before the body gesture (see playHeldEmotion).
      this.playHeldEmotion(t, g.emotion);
    }
    if (first) {
      const res = this.playSpeechGesture(t, first);
      t.first = { source: first.source, id: first.id || null, flip: Boolean(first.flip), trackId: res && res.trackId, playedAt: rel(startNow), ok: Boolean(res && res.ok) };
      if (res && res.ok) {
        this.engine.waitLatency(res.trackId, 2000).then((lat) => {
          t.first.motionAt = lat ? rel(startNow + lat.ms) : null;
          if (audio && lat) t.first.onsetVsAudioMs = +((startNow + lat.ms) - audio.startedAt).toFixed(1);
        });
      }
    } else if (prepared) {
      t.first = { source: 'none' };
      if (g.intent !== 'none') this.ui.gesture(tr('intent.' + g.intent), tr('app.noFittingGesture'));
    } else {
      t.first = { source: 'none', reason: 'no-audio' };
    }
    t.timeline.speechStartAt = audio ? rel(audio.startedAt) : null;
    this.emit('speaking', { turnId: t.id, speechMs: t.speechMs, first: t.first });

    if (audio) {
      const why = await audio.ended;
      t.timeline.speechEndAt = rel(this.now());
      if (why === 'stopped' && !t.cancelled) t.cancelled = 'stopped';
    }
    if (composeP) await Promise.race([composeP, new Promise((res) => setTimeout(res, 50))]);
    return this.finish(t, t.cancelled ? 'cancelled' : 'spoken');
  }

  // A composed result arrived: gate it, cache it, and play it as a second beat only if enough speech remains.
  acceptComposed(t, g, res) {
    t.timeline.composeAt = +(this.now() - t.t0).toFixed(1);
    if (!res || !res.ok || !res.command) {
      t.composed = { ok: false, reason: res && res.ok ? 'model returned no command' : (res && res.error && res.error.code) || 'failed' };
      if (res && !res.ok && res.error && res.error.message) t.composed.cause = String(res.error.message);
      this.emit('composed', { turnId: t.id, composed: t.composed });
      return;
    }
    const v = checkSpeechGesture(res.command);
    if (!v.ok) { t.composed = { ok: false, reason: 'schema', errors: v.errors.slice(0, 5) }; this.emit('composed', { turnId: t.id, composed: t.composed }); return; }
    const rig = this.rigCheck(v.command, false);
    if (!rig.ok) { t.composed = { ok: false, reason: 'rig', fails: rig.fails, rules: rig.rules }; this.emit('composed', { turnId: t.id, composed: t.composed }); return; }
    t.composed = { ok: true, command: v.command, rig: { fails: rig.fails, ms: rig.ms }, model: res.model, played: false };
    const key = t.key || cacheKey(g, estimateSpeechMs(t.reply || ''), this.rigVersion());
    const added = this.cache.add(key, { command: v.command, source: 'composed', model: res.model, brief: g.brief, rigReport: { fails: rig.fails, ms: rig.ms } });
    t.composed.cachedAs = added ? key : null;
    if (added) this.persist();
    // second beat: the turn is still speaking and >= 2 s remain (gated off entirely for P1, see GATE_SECOND_BEAT)
    const remaining = this.speech.remainingMs(this.now());
    if (!GATE_SECOND_BEAT && !t.cancelled && t.first && this.speech.speaking() && remaining >= SECOND_BEAT_MIN_MS && !t.composed.played) {
      const r = this.playSpeechGesture(t, { command: v.command, source: 'composed', labelVi: tr('intent.' + g.intent) });
      t.composed.played = Boolean(r && r.ok);
      t.composed.secondBeat = { remainingMs: Math.round(remaining) };
    } else if (!t.composed.played) {
      t.composed.cacheOnly = { remainingMs: Math.round(remaining), speaking: this.speech.speaking() };
    }
    this.emit('composed', { turnId: t.id, composed: { ...t.composed, command: undefined } });
  }

  // T-31 voice P1 live-E2E fix 3: re-run TTS only (the reply text/analysis/gesture pick are already known) for a
  // turn whose t.ttsFailed is true, wired to the UI's "Retry voice" button (ui.voiceFailed). Guards against a
  // stale click (a newer turn already started) by checking this is still the last-finished turn.
  // cloud.tts for a turn. A rejected call (the shim's sidecar_not_ready) is a TTS failure like an ok:false answer, so send() and
  // retryVoice() handle it on their existing failure paths instead of leaving an unhandled rejection (reviews R4, R5).
  ttsCall(turnId, text) {
    return Promise.resolve().then(() => this.cloud.tts({ turnId, text }))
      .catch((e) => ({ ok: false, error: `tts_rejected: ${String((e && e.message) || e)}` }));
  }

  async retryVoice(t) {
    if (!t || t !== this.lastTurn || (this.turn && !this.turn.done)) return; // stale click: a newer turn exists
    const tts = await this.ttsCall(t.id, t.reply);
    if (!tts || !tts.ok || !Array.isArray(tts.audios) || !tts.audios.length) {
      this.emit('retryVoice', { turnId: t.id, ok: false, ...(tts && tts.error ? { error: String(tts.error) } : {}) });
      return; // still failed -- t.ttsFailed stays true, the control stays visible for another try
    }
    let prepared;
    try { prepared = await this.speech.prepare(tts.audios); }
    catch (e) { this.emit('retryVoice', { turnId: t.id, ok: false, error: String(e && e.message || e) }); return; }
    t.ttsFailed = false;
    t.ttsError = null;
    if (this.ui.voiceFailed) this.ui.voiceFailed(null);
    const startNow = this.now();
    const audio = prepared.start();
    this.playHeldEmotion(t, t.gesture && t.gesture.emotion);
    // retryVoice runs after finish(), so nothing else ends the held emotion: stop it when this replay ends.
    if (t.emotionId && audio && audio.ended) audio.ended.then(() => this.engine.player.stop(t.emotionId));
    if (t.gesture && t.gesture.intent !== 'none') {
      const first = (t.composed && t.composed.ok && !t.composed.played)
        ? { command: t.composed.command, source: 'composed', labelVi: tr('intent.' + t.gesture.intent) }
        : this.pickAtStart(t, t.gesture, t.key);
      if (first) {
        const res = this.playSpeechGesture(t, first);
        t.first = { source: first.source, id: first.id || null, flip: Boolean(first.flip), trackId: res && res.trackId, playedAt: +(startNow - t.t0).toFixed(1), ok: Boolean(res && res.ok) };
      }
    }
    this.emit('retryVoice', { turnId: t.id, ok: true });
  }

  finish(t, outcome) {
    t.done = true;
    clearTimeout(t.thinkTimer);
    if (t.thinkId && !t.audioStarted) this.engine.player.stop(t.thinkId); // failed / silent turn: end the think ack
    if (t.emotionId) this.engine.player.stop(t.emotionId); // B2 item 1: the held emotion ends with the reply
    t.outcome = outcome;
    if (this.turn === t) this.lastTurn = t; // a stale turn settling after a newer one must not become the Retry voice target
    if (t.offTtsMore) { t.offTtsMore(); t.offTtsMore = null; }
    // Only the current turn drives the indicator: a stale turn (barged in, its call answered or rejected later) ending under
    // a newer turn must not switch that turn's "thinking" off (review R4 nit).
    if (this.turn === t) this.ui.thinking(false);
    const rec = {
      turnId: t.id, outcome, intent: t.intent || null, userText: t.text, reply: t.reply || null,
      analysis: t.analysis || null, first: t.first || null,
      composed: t.composed ? { ...t.composed, command: undefined } : null,
      speechMs: t.speechMs || null, timeline: t.timeline, error: t.error || null, ttsError: t.ttsError || null, cancelled: t.cancelled,
      streaming: Boolean(t.streaming), streamError: t.streamError || null, stages: stagesOf(t),
      planned: Boolean(t.roles && t.roles.planned),
      // T-31 settings P1b: record when the "read typed replies aloud" switch silenced THIS reply's voice (no TTS
      // requested), so the turn log tells a deliberately silent turn apart from an unexplained one.
      typedSpeechGated: Boolean(t.typedSpeechGated),
    };
    this.log(rec);
    this.emit('done', rec);
    return rec;
  }
}
