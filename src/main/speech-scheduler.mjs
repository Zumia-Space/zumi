// Speech scheduler (T-31 talk-mode, 19-10): "how much Zumi talks" (PLAN.md sections 1-2). One deep module that owns the
// talk prefs, the level/class matrix, the gap + daily cap, quiet hours, away/typing/window do-not-disturb gates, the P1
// hold queue and the away/morning/idle/check-in clocks. Pure: no Electron, clock and signals injected, in the same
// style as hud-feed.mjs, so scripts/check-talk-mode.mjs drives every branch under plain Node.
//
// CQRS: the renderer only receives `emit({sayId, kind, text, show, voice, lang, mood})` (planned 'speech:say') and
// answers with ack(sayId, {spoken, reason}); main never speaks on its own. `lines` is injectable for tests, defaulting
// to the real pool renderer.
import { renderLine } from './speech-lines.mjs';

export const TALK_LEVELS = ['off', 'quiet', 'normal', 'chatty'];
export const TALK_LANGS = ['en', 'vi'];

const MIN = 60_000;
const AWAY_SEC = 60;        // system idle that means "away" (same value as today's voice gate)
const TYPING_SEC = 2;       // input within 2 s = typing/working right now
const TYPING_RESUME_SEC = 3; // wait for a >= 3 s pause before speaking
const HOLD_MAX = 8;         // hold queue cap (plan section 2)
const AWAY_WELCOME_MS = 15 * MIN;
const IDLE_LINE_MS = 20 * MIN;   // P6: no line for this long
const IDLE_BOARD_MS = 30 * MIN;  // P6: no board change for this long

/** One row per level (plan section 2): allowed kinds, the P2-P6 gap, the P1 gap and the daily cap. */
export const LEVELS = {
  off: { classes: [], gapMs: Infinity, p1GapMs: Infinity, cap: 0 },
  quiet: { classes: ['ask', 'step'], gapMs: 10 * MIN, p1GapMs: 2 * MIN, cap: 15 },
  // 'watch' (T-31 alpha.12): a read-only watcher finding, class P3 like progress (PLAN-ZUMI-WATCH v1 2.2): Normal + Chatty.
  normal: { classes: ['ask', 'step', 'progress', 'morning', 'welcome', 'checkin', 'event', 'watch'], gapMs: 3 * MIN, p1GapMs: 60_000, cap: 60 },
  chatty: { classes: ['ask', 'step', 'progress', 'morning', 'welcome', 'checkin', 'event', 'idle', 'watch'], gapMs: 60_000, p1GapMs: 60_000, cap: 150 },
};

// Fable review item 7: spoken 12:00/16:00 summaries, Normal + Chatty only, on by default. 24-hour window ids; the
// line pool spells each one out per language (the sanitiser strips the ':' from a literal 12:00).
// T-31 alpha.12: these are the default only. With a `checkinHours` getter (the rhythm core's rhythm.get().checkinHours,
// PLAN-ZUMI-WATCH v2 A.3) the windows are the learned hours; the getter returns the v1 [12, 16] while it is learning.
const CHECKIN_WINDOWS = ['12:00', '16:00'];
const hourWindow = (h) => `${String(h).padStart(2, '0')}:00`;
const CHECKIN_WINDOW_MIN = 60; // fire anywhere in the hour after the window, so a tick that lands late still says it

const DEFAULT_QUIET = Object.freeze({ on: true, start: '22:30', end: '07:30' });
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Defaults from PLAN.md section 1 (owner ruling: Normal + EN + quiet hours on). */
export const DEFAULT_TALK_PREFS = Object.freeze({
  talkLevel: 'normal',
  talkVoiceLang: 'en',
  talkQuietHours: DEFAULT_QUIET,
  talkAsksBreakQuiet: false,
  talkCheckins: true,
  talkMute: null,
  talkLastVersion: '',
});

const validQuiet = (q) => !!q && typeof q === 'object' && typeof q.on === 'boolean'
  && HHMM.test(q.start) && HHMM.test(q.end) && q.start !== q.end;

/** `talkMute` normalisation: null = not muted, {until:null} = until unmuted, {until:ms} = timed; an expired one is null. */
function normalizeMute(v, now) {
  if (v == null) return null;
  if (typeof v === 'object' && (v.until === null || (typeof v.until === 'number' && Number.isFinite(v.until)))) {
    if (v.until !== null && v.until <= now) return null;
    return { until: v.until };
  }
  return null;
}

/**
 * settings.json -> normalised talk prefs. Pure. Any unknown or invalid value becomes its default (plan section 1).
 * @param {object} settings flat settings.json
 * @param {number} now epoch ms, so an expired talkMute.until reads as null
 */
export function talkPrefs(settings, now = Date.now()) {
  const s = settings || {};
  return {
    talkLevel: TALK_LEVELS.includes(s.talkLevel) ? s.talkLevel : DEFAULT_TALK_PREFS.talkLevel,
    talkVoiceLang: TALK_LANGS.includes(s.talkVoiceLang) ? s.talkVoiceLang : DEFAULT_TALK_PREFS.talkVoiceLang,
    talkQuietHours: validQuiet(s.talkQuietHours) ? { on: s.talkQuietHours.on, start: s.talkQuietHours.start, end: s.talkQuietHours.end } : { ...DEFAULT_QUIET },
    talkAsksBreakQuiet: typeof s.talkAsksBreakQuiet === 'boolean' ? s.talkAsksBreakQuiet : DEFAULT_TALK_PREFS.talkAsksBreakQuiet,
    talkCheckins: typeof s.talkCheckins === 'boolean' ? s.talkCheckins : DEFAULT_TALK_PREFS.talkCheckins,
    talkMute: normalizeMute(s.talkMute, now),
    talkLastVersion: typeof s.talkLastVersion === 'string' ? s.talkLastVersion : DEFAULT_TALK_PREFS.talkLastVersion,
  };
}

/**
 * Apply a partial patch on top of `settings`, keeping the current value for any bad field (plan section 1). Pure:
 * returns the normalised prefs. `save(prefs)` (optional) is handed the result, so the caller can persist it.
 * @param {object} patch partial {talkLevel, talkVoiceLang, talkQuietHours, talkAsksBreakQuiet, talkCheckins, talkMute, talkLastVersion}
 * @param {{settings?: object, now?: number, save?: (prefs: object) => void}} [opts]
 */
export function setTalkPrefs(patch, { settings = {}, now = Date.now(), save = null } = {}) {
  const p = patch || {};
  const cur = talkPrefs(settings, now);
  const next = { ...cur };
  if (Object.prototype.hasOwnProperty.call(p, 'talkLevel') && TALK_LEVELS.includes(p.talkLevel)) next.talkLevel = p.talkLevel;
  if (Object.prototype.hasOwnProperty.call(p, 'talkVoiceLang') && TALK_LANGS.includes(p.talkVoiceLang)) next.talkVoiceLang = p.talkVoiceLang;
  if (Object.prototype.hasOwnProperty.call(p, 'talkQuietHours') && validQuiet(p.talkQuietHours)) {
    next.talkQuietHours = { on: p.talkQuietHours.on, start: p.talkQuietHours.start, end: p.talkQuietHours.end };
  }
  if (Object.prototype.hasOwnProperty.call(p, 'talkAsksBreakQuiet') && typeof p.talkAsksBreakQuiet === 'boolean') next.talkAsksBreakQuiet = p.talkAsksBreakQuiet;
  if (Object.prototype.hasOwnProperty.call(p, 'talkCheckins') && typeof p.talkCheckins === 'boolean') next.talkCheckins = p.talkCheckins;
  if (Object.prototype.hasOwnProperty.call(p, 'talkMute')) {
    const v = p.talkMute;
    const ok = v === null || (typeof v === 'object' && (v.until === null || (typeof v.until === 'number' && Number.isFinite(v.until))));
    if (ok) next.talkMute = normalizeMute(v, now);
  }
  if (Object.prototype.hasOwnProperty.call(p, 'talkLastVersion') && typeof p.talkLastVersion === 'string') next.talkLastVersion = p.talkLastVersion;
  if (typeof save === 'function') save(next);
  return next;
}

/**
 * One-time migration (plan section 1): if talkLevel is absent, fold the old HUD voice switch in.
 * `hudVoiceMuted: true` -> 'off', otherwise 'normal'. Returns the flat patch to save, or null when already migrated.
 * `hudVoiceMuted: undefined` is dropped by JSON.stringify, so saving the patch removes the old key.
 */
export function migrateTalkLevel(settings) {
  const s = settings || {};
  if (s.talkLevel !== undefined) return null;
  return { talkLevel: s.hudVoiceMuted === true ? 'off' : 'normal', hudVoiceMuted: undefined };
}

/**
 * The board adapter (plan section 2): one hud-host reaction -> the scheduler line it should become, or null.
 *   a waiting ask -> ask | a finished step -> step(done, with the PREVIOUS step label) | blocked -> step(blocked)
 *   | a step change -> progress (a batch of several -> {n}) | plain activity with no step change -> null.
 * Pure, so scripts/check-talk-mode.mjs pins the mapping; main.js only enqueues the result.
 * @param {object} r a hud-host reaction ({source, state, title, step, doneStep, stepChanged, batchCount, askKey})
 * @returns {{kind: 'ask'|'step'|'progress', payload: object}|null}
 */
export function lineFromReaction(r) {
  if (!r || typeof r !== 'object') return null;
  if (r.source === 'waiting') return { kind: 'ask', payload: { key: r.askKey, title: r.title, step: r.step } };
  if (r.state === 'done') return { kind: 'step', payload: { outcome: 'done', title: r.title, step: r.doneStep } };
  if (r.state === 'blocked') return { kind: 'step', payload: { outcome: 'blocked', title: r.title, step: r.step } };
  if (r.stepChanged) return { kind: 'progress', payload: r.batchCount > 1 ? { n: r.batchCount } : { title: r.title, step: r.step } };
  return null;
}

const toMin = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; };

/** Is `at` inside the quiet-hours window? Window wraps midnight; start inclusive, end exclusive (plan section 2 step 5). */
export function inQuietHours(q, at = Date.now()) {
  if (!q || q.on !== true) return false;
  const a = toMin(q.start); const b = toMin(q.end);
  if (a === b) return false;
  const d = at instanceof Date ? at : new Date(at);
  const m = d.getHours() * 60 + d.getMinutes();
  return a < b ? m >= a && m < b : m >= a || m < b;
}

const localDay = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const idleOf = (sig) => (typeof sig?.idleSec === 'number' && Number.isFinite(sig.idleSec) ? sig.idleSec : null);
const askKeyOf = (payload) => payload?.key || payload?.id || `ask:${payload?.title || ''}`;

/**
 * The scheduler.
 * @param {object} o
 * @param {() => object|object} o.prefs  flat settings (or a getter); normalised with talkPrefs each read
 * @param {() => {idleSec?:number, windowVisible?:boolean, waitingCount?:number}} o.signals
 * @param {() => number} o.now
 * @param {(line: object) => void} o.emit  called with { sayId, kind, text, show, voice, lang, mood }
 * @param {(m: string) => void} [o.log]
 * @param {typeof renderLine} [o.lines]
 * @param {() => {selfWord:string,userWord:string}} [o.address]  T-31 alpha.13: the soul's Vietnamese address words, read per line
 * @param {() => number[]} [o.checkinHours]  T-31 alpha.12: the rhythm core's check-in hours (0-23); absent = 12:00/16:00
 * @param {(said: {t: number, sayId: string, kind: string, key: string, text: string}) => void} [o.onSaid]
 *   T-31 alpha.12: called once per line the renderer acked as shown/spoken (said.jsonl + the rhythm's nudge.said)
 */
export function createSpeechScheduler({ prefs = () => ({}), signals = () => ({}), now = Date.now, emit = () => {}, log = () => {}, lines = renderLine, checkinHours = null, onSaid = null, address = null } = {}) {
  const prefsOf = typeof prefs === 'function' ? prefs : () => prefs || {};
  const pNow = () => talkPrefs(prefsOf(), now());
  const sigOf = () => { try { return signals() || {}; } catch { return {}; } };

  let seq = 0;
  let muteState = null;
  let muteSource = null; // the prefs.talkMute value muteState was last synced from
  let lastEmitAt = -Infinity;
  let lastBoardAt = now();
  let dayKey = localDay(now());
  let dayCount = 0;
  let held = [];          // { key, kind, payload, at, deadline|null, typing }
  const live = new Map(); // sayId -> { kind, payload, prevEmitAt, prevDayCount }
  let awaySince = null;
  let awayDigest = { updates: 0, asks: 0 };
  let awayAskKeys = new Set();
  let morningDay = null;
  const idleUsed = new Set();
  const checkinDone = new Set(); // `${dayKey}|${window}` for each 12:00/16:00 window already spoken today
  let lastBoard = null;

  const rollover = () => {
    const k = localDay(now());
    if (k === dayKey) return;
    dayKey = k; dayCount = 0; morningDay = null; idleUsed.clear(); checkinDone.clear();
  };

  // Prefs are the single writer: if talkMute changed in settings (setTalkPrefs), pick it up. mute()/unmute() set the
  // source to the current prefs value, so an explicit stage mute is not undone by the next read.
  function syncMute() {
    const pm = pNow().talkMute;
    const source = JSON.stringify(pm);
    if (source !== muteSource) { muteSource = source; muteState = pm ? { ...pm } : null; }
  }

  const isMuted = () => {
    syncMute();
    if (!muteState) return false;
    if (muteState.until != null && now() >= muteState.until) { muteState = null; return false; }
    return true;
  };

  const levelsOf = () => LEVELS[pNow().talkLevel] || LEVELS.off;

  function emitLine(kind, payload, voice) {
    const p = pNow();
    const line = lines(kind, payload, p.talkVoiceLang, address ? address() : undefined);
    if (!line || (!line.speak && !line.show)) return null;
    const sayId = `say-${++seq}-${now().toString(36)}`;
    const canVoice = !!(voice && line.speak);
    const item = {
      sayId, kind,
      // text is what TTS may speak; an empty text means "subtitle only" (see the F4 no-safe-variant case).
      text: line.speak,
      show: line.show || line.speak,
      voice: canVoice,
      lang: p.talkVoiceLang,
      mood: line.mood ?? null,
    };
    // A renderer reload/crash may leave ids un-acked; keep the live set bounded so an old id cannot stay voice-authorized.
    if (live.size >= 32) live.delete(live.keys().next().value);
    live.set(sayId, { kind, payload, key: line.key, voice: canVoice, text: item.show, prevEmitAt: lastEmitAt, prevDayCount: dayCount });
    dayCount++;
    lastEmitAt = now();
    emit(item);
    return { sayId, key: line.key, voice: canVoice, text: item.text };
  }

  const issue = (kind, payload, voice, reason) => {
    const out = emitLine(kind, payload, voice);
    if (!out) return { action: 'drop', reason: 'no_line' };
    return { action: out.voice ? 'speak' : 'subtitle', reason, sayId: out.sayId, key: out.key };
  };

  function hold(kind, payload, { typing = false, deadline = null } = {}) {
    const key = kind === 'ask' ? askKeyOf(payload) : `${kind}:${payload?.title || payload?.event || ''}`;
    const at = now();
    const existing = held.findIndex((h) => h.kind === 'ask' && kind === 'ask' && h.key === key);
    if (existing >= 0) { held[existing] = { key, kind, payload, at, deadline, typing }; return { action: 'hold', reason: 'deduped', key }; }
    if (held.length >= HOLD_MAX) held.shift(); // cap: drop the oldest held line
    held.push({ key, kind, payload, at, deadline, typing });
    return { action: 'hold', reason: 'held', key };
  }

  function noteAway(sig, t) {
    const idle = idleOf(sig);
    if (idle != null && idle >= AWAY_SEC) {
      if (awaySince == null) { awaySince = t; awayDigest = { updates: 0, asks: 0 }; awayAskKeys = new Set(); }
      return { away: true, returned: false, awayMs: 0, digest: null };
    }
    if (awaySince != null) {
      const awayMs = t - awaySince;
      const digest = { ...awayDigest };
      awaySince = null; awayDigest = { updates: 0, asks: 0 }; awayAskKeys = new Set();
      return { away: false, returned: true, awayMs, digest };
    }
    return { away: false, returned: false, awayMs: 0, digest: null };
  }

  /** Several P1 lines released together merge into one "N things are waiting" line (plan section 2). */
  function emitAskGroup(list, voice, reason) {
    if (!list.length) return;
    if (list.length === 1) { issue('ask', list[0].payload, voice, reason); return; }
    // A code-only title sanitises to ''; fall back to the generic line instead of rendering "First ." .
    const first = list.find((h) => h.payload?.title);
    issue('ask', first ? { n: list.length, title: first.payload.title } : {}, voice, reason);
  }

  function flushHeld(sig, t, { ignoreGap = false } = {}) {
    const p = pNow();
    const lv = LEVELS[p.talkLevel] || LEVELS.off;
    const idle = idleOf(sig);
    const quiet = inQuietHours(p.talkQuietHours, t);
    const hidden = sig.windowVisible === false;
    const askVoice = [];
    const askSub = [];
    const keep = [];
    for (const h of held) {
      if (p.talkLevel === 'off') continue;                          // 1 level off -> drop
      if (isMuted()) {                                              // 2 mute -> P1 subtitle, rest drop
        if (h.kind === 'ask') askSub.push(h);
        continue;
      }
      if (!lv.classes.includes(h.kind)) continue;                   // 3 class
      if (dayCount >= lv.cap) {                                     // 4 cap -> P1 subtitle, rest drop
        if (h.kind === 'ask') askSub.push(h);
        continue;
      }
      if (quiet) {                                                  // 5 quiet hours
        if (h.kind === 'ask') { if (!p.talkAsksBreakQuiet) { askSub.push(h); continue; } }
        else if (h.kind === 'step') { issue('step', h.payload, false, 'quiet_hours'); continue; }
        else continue;
      }
      if (hidden && h.kind !== 'ask') continue;                     // 6 window hidden -> P1 only
      if (h.typing && idle != null && idle < TYPING_RESUME_SEC) { keep.push(h); continue; } // 8 typing pause
      const gap = h.kind === 'ask' ? lv.p1GapMs : lv.gapMs;         // 9 gap
      if (!ignoreGap && t - lastEmitAt < gap) { if (h.kind === 'ask') { keep.push(h); continue; } continue; }
      if (h.kind === 'ask') askVoice.push(h);
      else issue(h.kind, h.payload, true, 'released');
    }
    emitAskGroup(askSub, false, 'held_subtitle');
    emitAskGroup(askVoice, true, 'released');
    held = keep;
  }

  function expireHeld(t) {
    held = held.filter((h) => !(h.deadline != null && t >= h.deadline));
  }

  function handleAwayReturn(ret, sig, t) {
    // On return, only P1 survives (plan section 2): typing-held P2-P6 are dropped.
    held = held.filter((h) => h.kind === 'ask');
    if (ret.awayMs >= AWAY_WELCOME_MS) gate('welcome', { u: ret.digest.updates, a: ret.digest.asks }, sig, t);
    flushHeld(sig, t, { ignoreGap: true });
  }

  function maybeMorning(sig, t) {
    const p = pNow();
    if (!(LEVELS[p.talkLevel] || LEVELS.off).classes.includes('morning')) return;
    if (morningDay === dayKey) return;
    const idle = idleOf(sig);
    if (idle == null || idle >= AWAY_SEC) return; // active only
    if (idle < TYPING_SEC) return;                // wait for the typing pause rather than holding the morning line
    const d = new Date(t);
    const mins = d.getHours() * 60 + d.getMinutes();
    const cutoff = p.talkQuietHours.on ? toMin(p.talkQuietHours.end) : 5 * 60;
    if (mins < cutoff || inQuietHours(p.talkQuietHours, t)) return;
    // Mark the day only once the line actually went out: a mute/window/gap refusal retries on a later tick.
    const r = gate('morning', { n: Number(sig.waitingCount) || 0 }, sig, t);
    if (r.action === 'speak' || r.action === 'subtitle') morningDay = dayKey;
  }

  function maybeIdle(sig, t) {
    const p = pNow();
    if (p.talkLevel !== 'chatty') return;
    const idle = idleOf(sig);
    if (idle == null || idle >= AWAY_SEC || idle < TYPING_RESUME_SEC) return;
    if (t - lastEmitAt < IDLE_LINE_MS) return;
    if (t - lastBoardAt < IDLE_BOARD_MS) return;
    const payload = lastBoard ? { title: lastBoard.title, step: lastBoard.step } : {};
    const candidates = [];
    if (payload.title && payload.step) candidates.push('idle.still');
    candidates.push('idle.quiet');
    const key = candidates.find((k) => !idleUsed.has(k));
    if (!key) return; // pool exhausted for this local day
    const r = gate('idle', { ...payload, key }, sig, t);
    if (r.action === 'speak' || r.action === 'subtitle') idleUsed.add(key);
  }

  /**
   * The 12:00/16:00 check-in (Fable review item 7). Once per window per local day, only while active (a returned
   * away/typing state holds it back), and only at Normal/Chatty (the class list) and while `talkCheckins` is on.
   * Like the morning line, the window is marked only once the line actually went out, so a mute/gap refusal retries.
   */
  function maybeCheckin(sig, t) {
    const p = pNow();
    if (p.talkCheckins === false) return;
    if (!(LEVELS[p.talkLevel] || LEVELS.off).classes.includes('checkin')) return;
    const idle = idleOf(sig);
    if (idle == null || idle >= AWAY_SEC) return; // active only
    if (idle < TYPING_SEC) return;                // wait for the typing pause, like the morning line
    const d = new Date(t);
    const mins = d.getHours() * 60 + d.getMinutes();
    let windows = CHECKIN_WINDOWS;
    if (typeof checkinHours === 'function') {
      let hours = null;
      try { hours = checkinHours(); } catch (e) { log(`checkinHours failed: ${(e && e.message) || e}`); }
      if (Array.isArray(hours)) windows = hours.filter((h) => Number.isInteger(h) && h >= 0 && h <= 23).slice(0, 4).map(hourWindow);
    }
    for (const hm of windows) {
      const at = toMin(hm);
      if (mins < at || mins >= at + CHECKIN_WINDOW_MIN) continue; // outside this window's hour
      const mark = `${dayKey}|${hm}`;
      if (checkinDone.has(mark)) continue;
      const r = gate('checkin', { n: Number(sig.waitingCount) || 0, w: Number(sig.watchCount) || 0, time: hm }, sig, t);
      if (r.action === 'speak' || r.action === 'subtitle') checkinDone.add(mark);
      return;
    }
  }

  /** The decision order of plan section 2, first match wins. */
  function gate(kind, payload, sig, t) {
    const p = pNow();
    rollover();
    if (kind === 'ask' || kind === 'step' || kind === 'progress') {
      lastBoardAt = t;
      if (payload?.title || payload?.step) lastBoard = { title: payload.title || '', step: payload.step || '' };
    }
    const lv = LEVELS[p.talkLevel] || LEVELS.off;
    if (p.talkLevel === 'off') return { action: 'drop', reason: 'level_off' };
    if (isMuted()) return kind === 'ask' ? issue('ask', payload, false, 'muted') : { action: 'drop', reason: 'muted' };
    if (!lv.classes.includes(kind)) return { action: 'drop', reason: 'class_not_allowed' };
    if (dayCount >= lv.cap) return kind === 'ask' ? issue('ask', payload, false, 'daily_cap') : { action: 'drop', reason: 'daily_cap' };
    if (inQuietHours(p.talkQuietHours, t)) {
      if (kind === 'ask') { if (!p.talkAsksBreakQuiet) return issue('ask', payload, false, 'quiet_hours'); }
      else if (kind === 'step') return issue('step', payload, false, 'quiet_hours');
      else return { action: 'drop', reason: 'quiet_hours' };
    }
    if (sig.windowVisible === false && kind !== 'ask') return { action: 'drop', reason: 'window_hidden' };
    const idle = idleOf(sig);
    if (idle != null && idle >= AWAY_SEC) {
      if (kind === 'ask') { awayAskKeys.add(askKeyOf(payload)); awayDigest.asks = awayAskKeys.size; return hold('ask', payload); }
      awayDigest.updates++;
      return { action: 'drop', reason: 'away' };
    }
    if (idle != null && idle < TYPING_SEC) {
      const deadline = kind === 'ask' ? null : kind === 'step' ? t + 10 * MIN : t + 45_000;
      return hold(kind, payload, { typing: true, deadline });
    }
    const gap = kind === 'ask' ? lv.p1GapMs : lv.gapMs;
    if (t - lastEmitAt < gap) return kind === 'ask' ? hold('ask', payload) : { action: 'drop', reason: 'gap' };
    return issue(kind, payload, true, 'ok');
  }

  function enqueue(kind, payload = {}) {
    rollover();
    const t = now();
    const sig = sigOf();
    const ret = noteAway(sig, t);
    if (ret.returned) handleAwayReturn(ret, sig, t);
    return gate(kind, payload, sig, t);
  }

  function tick() {
    rollover();
    const t = now();
    const sig = sigOf();
    const ret = noteAway(sig, t);
    if (ret.away) { expireHeld(t); return status(); }
    if (ret.returned) { handleAwayReturn(ret, sig, t); return status(); }
    expireHeld(t);
    flushHeld(sig, t);
    maybeMorning(sig, t);
    maybeCheckin(sig, t); // before idle: a scheduled check-in takes priority over the P6 filler
    maybeIdle(sig, t);
    return status();
  }

  function ack(sayId, { spoken = true, reason = null } = {}) {
    const id = String(sayId);
    const rec = live.get(id);
    if (!rec) return { action: 'unknown', reason: 'unknown_say' };
    live.delete(id);
    if (reason === 'busy') {
      if (rec.kind === 'ask') {
        dayCount = rec.prevDayCount; lastEmitAt = rec.prevEmitAt; // not spoken: give the slot back
        hold('ask', rec.payload);
        return { action: 'hold', reason: 'busy', key: askKeyOf(rec.payload) };
      }
      return { action: 'drop', reason: 'busy' };
    }
    if (spoken !== false && typeof onSaid === 'function') {
      try { onSaid({ t: now(), sayId: id, kind: rec.kind, key: rec.key, text: rec.text || '' }); } catch (e) { log(`onSaid failed: ${(e && e.message) || e}`); }
    }
    return { action: spoken === false ? 'drop' : 'done', reason: reason || (spoken === false ? 'unspoken' : 'spoken') };
  }

  function status() {
    const p = pNow();
    return {
      level: p.talkLevel,
      voiceLang: p.talkVoiceLang,
      muted: isMuted(),
      muteUntil: muteState ? muteState.until : null,
      day: dayKey,
      dayCount,
      cap: (LEVELS[p.talkLevel] || LEVELS.off).cap,
      held: held.length,
      heldKeys: held.map((h) => h.key),
      live: live.size,
      away: awaySince != null,
      digest: { ...awayDigest },
    };
  }

  return {
    enqueue,
    tick,
    ack,
    // Only a voice-authorized id may skip the reply-side voice gate (plan F3); subtitle-only ids must never pass it.
    isLive: (sayId) => { const rec = live.get(String(sayId)); return !!rec && rec.voice === true; },
    mute: (untilMs = null) => {
      const n = untilMs == null ? null : Number(untilMs);
      muteState = { until: n == null || Number.isFinite(n) ? n : null };
      muteSource = JSON.stringify(pNow().talkMute);
      return status();
    },
    unmute: () => { muteState = null; muteSource = JSON.stringify(pNow().talkMute); return status(); },
    status,
    _test: { held: () => held, live: () => live },
  };
}
