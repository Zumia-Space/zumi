// Talk-mode core gates (T-31 talk-mode, 19-10), plain Node, no Electron, no TTS, no network:
//   1. talkPrefs / setTalkPrefs / migrateTalkLevel / inQuietHours (plan section 1)
//   2. levels x classes matrix (section 2)
//   3. gaps: Quiet 10 min / P1 2 min, Normal 3 min / P1 60 s, Chatty 60 s
//   4. daily caps 15 / 60 / 150, P1 -> subtitle after the cap
//   5. quiet hours across midnight and its edges, asks-may-wake
//   6. away hold -> welcome after >= 15 min with the digest; short away flushes P1 only
//   7. typing hold, 45 s drop for P3-P6, P1 survives, P2 10 min deadline
//   8. minimized -> P1 only
//   9. mute / mute-until expiry / unmute, Off drops all
//  10. ack busy re-holds P1 and drops P2-P6; isLive only for issued ids
//  11. day rollover resets the cap; P6 never repeats within a day
//  12. the line pool: en/vi parity, the 90-char cap, no task codes, the EN + Vietnamese-title rule
//  13. the Fable line-pool review (19-10): the 10 items — exact new texts, step.done gated on outcome, the
//      12:00/16:00 check-in clock (once per window per day, Normal+Chatty, `talkCheckins` pref), no variant arrays,
//      the 35/30 caps, and the one event input convention
//   node scripts/check-talk-mode.mjs   (exit 1 on any failure)
import fs from 'node:fs';
import { talkPrefs, setTalkPrefs, migrateTalkLevel, inQuietHours, createSpeechScheduler, lineFromReaction, LEVELS, TALK_LEVELS } from '../src/main/speech-scheduler.mjs';
import { renderLine, KINDS, LINE_KEYS, MOODS } from '../src/main/speech-lines.mjs';

let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); } };

const MIN = 60_000;
// Local-time constructors so quiet hours / morning / day rollover exercise the real local clock (never UTC parsing).
const T = (h, m, s = 0, day = 19) => new Date(2026, 9, day, h, m, s).getTime();
const T0 = T(12, 0);

function make({ level = 'normal', lang = 'en', quietOn = false, asksBreak = false, idle = 5, visible = true, waitingCount = 0, t = T0, extra = {} } = {}) {
  const settings = {
    talkLevel: level,
    talkVoiceLang: lang,
    talkQuietHours: { on: quietOn, start: '22:30', end: '07:30' },
    talkAsksBreakQuiet: asksBreak,
    ...extra,
  };
  const sig = { idleSec: idle, windowVisible: visible, waitingCount };
  const state = { t };
  const emitted = [];
  const sched = createSpeechScheduler({
    prefs: () => settings,
    signals: () => sig,
    now: () => state.t,
    emit: (line) => emitted.push(line),
    log: () => {},
  });
  return { sched, emitted, sig, state, settings };
}

const ask = (key = 'ask-1', title = 'Task', step = 'Step') => ({ key, title, step });
const step = (title = 'Task', s = 'Step', outcome = 'done') => ({ title, step: s, outcome });

// ---------- 1. prefs ----------
{
  const d = talkPrefs({});
  ok(d.talkLevel === 'normal' && d.talkVoiceLang === 'en' && d.talkQuietHours.on === true && d.talkQuietHours.start === '22:30' && d.talkQuietHours.end === '07:30' && d.talkAsksBreakQuiet === false && d.talkCheckins === true && d.talkMute === null, 'prefs: defaults are Normal / EN / quiet hours on 22:30-07:30 / check-ins on', d);

  const bad = talkPrefs({ talkLevel: 'loud', talkVoiceLang: 'fr', talkQuietHours: { on: 'yes', start: '25:00', end: '00:00' }, talkAsksBreakQuiet: 'yes', talkCheckins: 'yes', talkMute: { until: 'soon' }, talkLastVersion: 3 });
  ok(bad.talkLevel === 'normal' && bad.talkVoiceLang === 'en' && bad.talkQuietHours.start === '22:30' && bad.talkAsksBreakQuiet === false && bad.talkCheckins === true && bad.talkMute === null && bad.talkLastVersion === '', 'prefs: every invalid field falls back to its default', bad);

  const same = talkPrefs({ talkQuietHours: { on: true, start: '08:00', end: '08:00' } });
  ok(same.talkQuietHours.start === '22:30' && same.talkQuietHours.end === '07:30', 'prefs: start === end is rejected (default quiet hours)', same.talkQuietHours);

  const now = T0;
  ok(talkPrefs({ talkMute: { until: now - 1 } }, now).talkMute === null, 'prefs: an expired talkMute.until reads as null');
  ok(JSON.stringify(talkPrefs({ talkMute: { until: now + 1000 } }, now).talkMute) === JSON.stringify({ until: now + 1000 }), 'prefs: a live talkMute.until is kept');
  ok(JSON.stringify(talkPrefs({ talkMute: { until: null } }, now).talkMute) === JSON.stringify({ until: null }), 'prefs: talkMute {until:null} = until unmuted');

  ok(JSON.stringify(migrateTalkLevel({})) === JSON.stringify({ talkLevel: 'normal', hudVoiceMuted: undefined }), 'migration: no talkLevel -> normal, old key removed (undefined drops from JSON)');
  ok(migrateTalkLevel({ hudVoiceMuted: true }).talkLevel === 'off', 'migration: hudVoiceMuted true -> Off');
  ok(migrateTalkLevel({ hudVoiceMuted: false }).talkLevel === 'normal', 'migration: hudVoiceMuted false -> Normal');
  ok(migrateTalkLevel({ talkLevel: 'chatty' }) === null, 'migration: already migrated -> null (one time)');

  const saved = [];
  const next = setTalkPrefs({ talkLevel: 'chatty', talkVoiceLang: 'fr' }, { settings: { talkLevel: 'quiet', talkVoiceLang: 'en' }, now, save: (p) => saved.push(p) });
  ok(next.talkLevel === 'chatty' && next.talkVoiceLang === 'en', 'setTalkPrefs: a good field applies, a bad field keeps the current value', next);
  ok(saved.length === 1 && saved[0].talkLevel === 'chatty', 'setTalkPrefs: save() receives the normalised result');
  const unchanged = setTalkPrefs({ talkQuietHours: { on: true, start: '08:00', end: '08:00' } }, { settings: { talkQuietHours: { on: true, start: '22:30', end: '07:30' } }, now });
  ok(unchanged.talkQuietHours.start === '22:30', 'setTalkPrefs: start === end is rejected, the current window stays');
  const muted = setTalkPrefs({ talkMute: { until: null } }, { settings: {}, now });
  ok(JSON.stringify(muted.talkMute) === JSON.stringify({ until: null }), 'setTalkPrefs: talkMute {until:null} applies');
  ok(setTalkPrefs({ talkCheckins: false }, { settings: {}, now }).talkCheckins === false, 'setTalkPrefs: talkCheckins false applies');
  ok(setTalkPrefs({ talkMute: { until: now - 1 } }, { settings: { talkMute: { until: null } }, now }).talkMute === null, 'setTalkPrefs: an expired mute clears');

  const q = { on: true, start: '22:30', end: '07:30' };
  ok(inQuietHours(q, T(22, 29)) === false && inQuietHours(q, T(22, 30)) === true, 'quiet hours: 22:30 is the inclusive start');
  ok(inQuietHours(q, T(23, 59)) === true && inQuietHours(q, T(0, 0, 0, 20)) === true && inQuietHours(q, T(3, 0)) === true, 'quiet hours: the window wraps midnight');
  ok(inQuietHours(q, T(7, 29)) === true && inQuietHours(q, T(7, 30)) === false, 'quiet hours: 07:30 is the exclusive end');
  ok(inQuietHours({ on: false, start: '22:30', end: '07:30' }, T(23, 0)) === false, 'quiet hours: switch off -> never quiet');
  ok(inQuietHours({ on: true, start: '12:00', end: '13:00' }, T(12, 0)) === true && inQuietHours({ on: true, start: '12:00', end: '13:00' }, T(13, 0)) === false, 'quiet hours: a same-day window works too');
}

// ---------- 2. levels x classes matrix ----------
{
  const cases = [
    ['ask', ask('a1')],
    ['step', step()],
    ['progress', { title: 'Task', step: 'Step' }],
    ['morning', { n: 2 }],
    ['welcome', { u: 1, a: 1 }],
    ['checkin', { n: 1, time: '12:00' }],
    ['event', { event: 'poke' }],
    ['idle', { title: 'Task', step: 'Step' }],
  ];
  const allowed = {
    off: [],
    quiet: ['ask', 'step'],
    normal: ['ask', 'step', 'progress', 'morning', 'welcome', 'checkin', 'event'],
    chatty: ['ask', 'step', 'progress', 'morning', 'welcome', 'checkin', 'event', 'idle'],
  };
  for (const level of TALK_LEVELS) {
    for (const [kind, payload] of cases) {
      const h = make({ level });
      const r = h.sched.enqueue(kind, payload);
      const want = allowed[level].includes(kind) ? 'speak' : 'drop';
      ok(r.action === want, `matrix ${level}: ${kind} -> ${want}`, r);
      if (want === 'drop') ok(r.reason === (level === 'off' ? 'level_off' : 'class_not_allowed'), `matrix ${level}: ${kind} drop reason is ${level === 'off' ? 'level_off' : 'class_not_allowed'}`, r.reason);
    }
  }
}

// ---------- 3. gaps ----------
{
  {
    const h = make({ level: 'quiet' });
    ok(h.sched.enqueue('ask', ask('a1')).action === 'speak', 'gap quiet: the first P1 speaks');
    h.state.t = T0 + 2 * MIN - 1;
    ok(h.sched.enqueue('ask', ask('a2')).action === 'hold', 'gap quiet: a second P1 1 ms before 2 min is held');
    h.state.t = T0 + 2 * MIN;
    h.sched.tick();
    ok(h.emitted.filter((e) => e.kind === 'ask').length === 2, 'gap quiet: the held P1 speaks at exactly 2 min', h.emitted.map((e) => e.kind));
  }
  {
    const h = make({ level: 'quiet' });
    ok(h.sched.enqueue('step', step()).action === 'speak', 'gap quiet: the first P2 speaks');
    h.state.t = T0 + 10 * MIN - 1;
    const r = h.sched.enqueue('step', step());
    ok(r.action === 'drop' && r.reason === 'gap', 'gap quiet: a P2 1 ms before 10 min is dropped', r);
    h.state.t = T0 + 10 * MIN;
    ok(h.sched.enqueue('step', step()).action === 'speak', 'gap quiet: a P2 at 10 min speaks');
  }
  {
    const h = make({ level: 'normal' });
    ok(h.sched.enqueue('ask', ask('a1')).action === 'speak', 'gap normal: the first P1 speaks');
    h.state.t = T0 + 60_000 - 1;
    ok(h.sched.enqueue('ask', ask('a2')).action === 'hold', 'gap normal: a P1 1 ms before 60 s is held');
    h.state.t = T0 + 60_000;
    h.sched.tick();
    ok(h.emitted.filter((e) => e.kind === 'ask').length === 2, 'gap normal: the held P1 speaks at 60 s');
  }
  {
    const h = make({ level: 'normal' });
    ok(h.sched.enqueue('step', step()).action === 'speak', 'gap normal: the first P2 speaks');
    h.state.t = T0 + 3 * MIN - 1;
    const r = h.sched.enqueue('step', step());
    ok(r.action === 'drop' && r.reason === 'gap', 'gap normal: a P2 1 ms before 3 min is dropped', r);
    h.state.t = T0 + 3 * MIN;
    ok(h.sched.enqueue('step', step()).action === 'speak', 'gap normal: a P2 at 3 min speaks');
  }
  {
    const h = make({ level: 'chatty' });
    ok(h.sched.enqueue('ask', ask('a1')).action === 'speak', 'gap chatty: the first P1 speaks');
    h.state.t = T0 + 59_999;
    ok(h.sched.enqueue('ask', ask('a2')).action === 'hold', 'gap chatty: a P1 before 60 s is held');
    h.state.t = T0 + 60_000;
    h.sched.tick();
    ok(h.emitted.filter((e) => e.kind === 'ask').length === 2, 'gap chatty: the held P1 speaks at 60 s');
  }
}

// ---------- 4. daily caps ----------
{
  const capCase = (level, cap, gapMs) => {
    const h = make({ level });
    let last = null;
    for (let i = 0; i < cap; i++) {
      h.state.t = T0 + i * gapMs;
      last = h.sched.enqueue('ask', ask(`a${i}`));
    }
    ok(last.action === 'speak', `cap ${level}: ask #${cap} still speaks`, last);
    h.state.t = T0 + cap * gapMs;
    const over = h.sched.enqueue('ask', ask('over'));
    ok(over.action === 'subtitle', `cap ${level}: ask #${cap + 1} becomes a subtitle`, over);
    ok(h.emitted[h.emitted.length - 1].voice === false, `cap ${level}: the over-cap P1 is not voiced`);
  };
  capCase('quiet', LEVELS.quiet.cap, 2 * MIN);
  capCase('normal', LEVELS.normal.cap, 60_000);
  capCase('chatty', LEVELS.chatty.cap, 60_000);
  ok(LEVELS.quiet.cap === 15 && LEVELS.normal.cap === 60 && LEVELS.chatty.cap === 150, 'caps: 15 / 60 / 150', [LEVELS.quiet.cap, LEVELS.normal.cap, LEVELS.chatty.cap]);
}

// ---------- 4b. hold queue: latest revision, merge, 8-item cap; subtitles count toward the cap ----------
{
  const h = make({ level: 'normal', idle: 1, t: T0 });
  h.sched.enqueue('ask', ask('a1', 'Old'));
  h.sched.enqueue('ask', ask('a1', 'New')); // same ask key: the latest revision wins
  h.sched.enqueue('ask', ask('a2', 'Second'));
  h.sched.enqueue('ask', ask('a3', 'Third'));
  ok(h.sched.status().held === 3, 'hold: the same ask key is one queue item (latest revision)', h.sched.status());
  h.state.t = T0 + 10_000; h.sig.idleSec = 3; h.sched.tick();
  const asks = h.emitted.filter((e) => e.kind === 'ask');
  ok(asks.length === 1 && asks[0].show.includes('New') && !asks[0].show.includes('Old'), 'hold: the latest revision is the one released', asks);
  ok(asks[0].show.includes('3 things') || asks[0].text.includes('3 things'), 'hold: several released asks merge into one "N things" line', asks[0]);

  const cap = make({ level: 'normal', idle: 1, t: T0 });
  for (let i = 0; i < 9; i++) cap.sched.enqueue('ask', ask(`a${i}`, `Task ${i}`));
  const st = cap.sched.status();
  ok(st.held === 8 && !st.heldKeys.includes('a0') && st.heldKeys.includes('a8'), 'hold: the queue caps at 8, oldest evicted', st);

  const sub = make({ level: 'quiet', t: T0 });
  for (let i = 0; i < LEVELS.quiet.cap; i++) { sub.state.t = T0 + i * 2 * MIN; sub.sched.enqueue('ask', ask(`a${i}`)); }
  sub.state.t = T0 + LEVELS.quiet.cap * 2 * MIN;
  ok(sub.sched.enqueue('ask', ask('over')).action === 'subtitle', 'cap: the over-cap P1 is a subtitle');
  ok(sub.sched.status().dayCount === LEVELS.quiet.cap + 1, 'cap: a subtitle counts toward the daily cap', sub.sched.status());
  sub.state.t += 2 * MIN;
  const blocked = sub.sched.enqueue('step', step());
  ok(blocked.action === 'drop' && blocked.reason === 'daily_cap', 'cap: once reached, P2 is dropped (subtitles counted too)', blocked);
}

// ---------- 5. quiet hours in the scheduler ----------
{
  const h = make({ level: 'normal', quietOn: true, t: T(23, 0) });
  ok(h.sched.enqueue('ask', ask('a1')).action === 'subtitle', 'quiet hours: a P1 is a subtitle by default');
  const stepR = h.sched.enqueue('step', step());
  ok(stepR.action === 'subtitle', 'quiet hours: a P2 is a subtitle', stepR);
  const progressR = h.sched.enqueue('progress', { title: 'Task', step: 'Step' });
  ok(progressR.action === 'drop' && progressR.reason === 'quiet_hours', 'quiet hours: P3-P6 are dropped', progressR);

  const wake = make({ level: 'normal', quietOn: true, asksBreak: true, t: T(23, 0) });
  ok(wake.sched.enqueue('ask', ask('a1')).action === 'speak', 'quiet hours: asks-may-wake lets the P1 speak');

  const edgeIn = make({ level: 'normal', quietOn: true, t: T(22, 30) });
  ok(edgeIn.sched.enqueue('ask', ask('a1')).action === 'subtitle', 'quiet hours: 22:30 is inside');
  const edgeOut = make({ level: 'normal', quietOn: true, t: T(7, 30) });
  ok(edgeOut.sched.enqueue('ask', ask('a1')).action === 'speak', 'quiet hours: 07:30 is outside');
}

// ---------- 6. away ----------
{
  const h = make({ level: 'normal', t: T0 });
  ok(h.sched.enqueue('ask', ask('a1')).action === 'speak', 'away: the pre-away P1 speaks');
  h.state.t = T0 + MIN; h.sig.idleSec = 600;
  const holdR = h.sched.enqueue('ask', ask('a2'));
  ok(holdR.action === 'hold' && h.sched.status().away, 'away: a P1 is held, not spoken', holdR);
  h.sched.enqueue('ask', ask('a2')); // same ask key: deduped
  ok(h.sched.status().digest.asks === 1, 'away: held P1 asks are deduped by key in the digest', h.sched.status().digest);
  const dropR = h.sched.enqueue('step', step());
  ok(dropR.action === 'drop' && dropR.reason === 'away' && h.sched.status().digest.updates === 1, 'away: everything else is dropped and counted', { dropR, digest: h.sched.status().digest });

  h.state.t = T0 + 16 * MIN; h.sig.idleSec = 5;
  h.sched.tick();
  const welcome = h.emitted.find((e) => e.kind === 'welcome');
  ok(Boolean(welcome) && welcome.show.includes('1') && welcome.show.includes('updates'), 'away: >= 15 min -> a welcome line with the digest', welcome);
  ok(h.emitted.filter((e) => e.kind === 'ask').length === 2, 'away: the held P1 is flushed after the welcome', h.emitted.map((e) => e.kind));

  const short = make({ level: 'normal', t: T0 });
  short.sched.enqueue('ask', ask('a1'));
  short.state.t = T0 + MIN; short.sig.idleSec = 600;
  short.sched.enqueue('ask', ask('a2'));
  short.state.t = T0 + 5 * MIN; short.sig.idleSec = 5;
  short.sched.tick();
  ok(!short.emitted.some((e) => e.kind === 'welcome') && short.emitted.filter((e) => e.kind === 'ask').length === 2, 'away: a short away flushes P1 only, no welcome', short.emitted.map((e) => e.kind));

  const typingThenAway = make({ level: 'normal', idle: 1, t: T0 });
  typingThenAway.sched.enqueue('step', step()); // typing-held P2
  typingThenAway.state.t = T0 + 10_000; typingThenAway.sig.idleSec = 600;
  typingThenAway.sched.tick(); // away starts
  typingThenAway.state.t = T0 + 5 * MIN; typingThenAway.sig.idleSec = 5;
  typingThenAway.sched.tick(); // short away return
  ok(typingThenAway.emitted.length === 0 && typingThenAway.sched.status().held === 0, 'away: a short return drops typing-held P2-P6 (P1 only)', typingThenAway.sched.status());
}

// ---------- 7. typing ----------
{
  const h = make({ level: 'normal', idle: 1, t: T0 });
  ok(h.sched.enqueue('ask', ask('a1')).action === 'hold', 'typing: a P1 is held');
  ok(h.sched.enqueue('step', step()).action === 'hold', 'typing: a P2 is held');
  ok(h.sched.enqueue('progress', { title: 'Task', step: 'Step' }).action === 'hold', 'typing: a P3 is held');
  ok(h.sched.enqueue('event', { event: 'poke' }).action === 'hold', 'typing: a P5 is held');
  ok(h.sched.status().held === 4, 'typing: four lines wait for the pause', h.sched.status().held);

  h.state.t = T0 + 46_000; h.sched.tick();
  ok(h.sched.status().held === 2 && h.sched.status().heldKeys.includes('a1'), 'typing: at 46 s P3-P6 are dropped, P1 and P2 survive', h.sched.status());

  h.state.t = T0 + 50_000; h.sig.idleSec = 3; h.sched.tick();
  ok(h.emitted.filter((e) => e.kind === 'ask').length === 1 && h.emitted.some((e) => e.kind === 'step'), 'typing: a >= 3 s pause releases the ask and the step', h.emitted.map((e) => e.kind));

  const p2 = make({ level: 'normal', idle: 1, t: T0 });
  p2.sched.enqueue('step', step());
  p2.state.t = T0 + 10 * MIN + 1; p2.sched.tick();
  ok(p2.sched.status().held === 0, 'typing: a held P2 is dropped after its 10 min deadline', p2.sched.status());
}

// ---------- 8. minimized ----------
{
  const h = make({ level: 'normal', visible: false });
  ok(h.sched.enqueue('ask', ask('a1')).action === 'speak', 'minimized: P1 still speaks');
  const s = h.sched.enqueue('step', step());
  ok(s.action === 'drop' && s.reason === 'window_hidden', 'minimized: P2 is dropped', s);
  const p = h.sched.enqueue('progress', { title: 'Task', step: 'Step' });
  ok(p.action === 'drop' && p.reason === 'window_hidden', 'minimized: P3 is dropped', p);
}

// ---------- 9. mute + Off ----------
{
  const h = make({ level: 'normal', t: T0 });
  h.sched.mute();
  ok(h.sched.status().muted === true, 'mute: status reports muted');
  const mutedAsk = h.sched.enqueue('ask', ask('a1'));
  ok(mutedAsk.action === 'subtitle', 'mute: P1 becomes a subtitle');
  ok(h.sched.isLive(mutedAsk.sayId) === false, 'mute: a subtitle sayId is NOT live for the voice-off bypass');
  const s = h.sched.enqueue('step', step());
  ok(s.action === 'drop' && s.reason === 'muted', 'mute: P2 is dropped', s);
  h.sched.unmute();
  h.state.t = T0 + 61_000;
  ok(h.sched.enqueue('ask', ask('a2')).action === 'speak', 'mute: unmute restores speech');

  const timed = make({ level: 'normal', t: T0 });
  timed.sched.mute(T0 + 1000);
  ok(timed.sched.enqueue('ask', ask('a1')).action === 'subtitle', 'mute until: a timed mute subtitles P1');
  timed.state.t = T0 + 61_000;
  ok(timed.sched.status().muted === false, 'mute until: the mute expires');
  ok(timed.sched.enqueue('ask', ask('a2')).action === 'speak', 'mute until: speech returns after expiry');

  const off = make({ level: 'off' });
  for (const [kind, payload] of [['ask', ask('a1')], ['step', step()], ['progress', { title: 'T', step: 'S' }], ['event', { event: 'poke' }]]) {
    const r = off.sched.enqueue(kind, payload);
    ok(r.action === 'drop' && r.reason === 'level_off', `Off: ${kind} is dropped`, r);
  }
}

// ---------- 9b. the morning line is not burned while a gate refuses it ----------
{
  const h = make({ level: 'normal', t: T(8, 0) });
  h.sched.mute();
  h.sched.tick(); // the morning line is refused by mute; it must not mark the day done
  ok(!h.emitted.some((e) => e.kind === 'morning'), 'morning: a muted tick does not emit');
  h.sched.unmute();
  h.state.t = T(8, 0, 1);
  h.sched.tick();
  ok(h.emitted.some((e) => e.kind === 'morning'), 'morning: after unmute the first successful tick still emits it');
}

// ---------- 10. ack + isLive ----------
{
  const h = make({ level: 'normal', t: T0 });
  const r = h.sched.enqueue('ask', ask('a1'));
  ok(r.action === 'speak' && h.sched.isLive(r.sayId), 'ack: an issued ask is live');
  ok(h.sched.isLive('not-a-say-id') === false, 'isLive: only issued ids are live');
  const a = h.sched.ack(r.sayId, { reason: 'busy' });
  ok(a.action === 'hold' && h.sched.isLive(r.sayId) === false && h.sched.status().held === 1, 'ack busy: a P1 is re-held and no longer live', a);
  h.state.t = T0 + 61_000; h.sched.tick();
  ok(h.emitted.filter((e) => e.kind === 'ask').length === 2, 'ack busy: the re-held P1 speaks later');

  const h2 = make({ level: 'normal', t: T0 });
  const r2 = h2.sched.enqueue('step', step());
  ok(h2.sched.ack(r2.sayId, { reason: 'busy' }).action === 'drop' && h2.sched.status().held === 0, 'ack busy: a P2 is dropped, never re-held');

  const h3 = make({ level: 'normal', t: T0 });
  const r3 = h3.sched.enqueue('ask', ask('a1'));
  ok(h3.sched.ack(r3.sayId, { spoken: true }).action === 'done' && h3.sched.isLive(r3.sayId) === false, 'ack: a spoken line is done and no longer live');
  ok(h3.sched.ack('ghost', {}).action === 'unknown', 'ack: an unknown sayId is ignored');
}

// ---------- 11. day rollover + P6 pool ----------
{
  const h = make({ level: 'quiet', t: T(23, 0) });
  for (let i = 0; i < LEVELS.quiet.cap; i++) {
    h.state.t = T(23, 0) + i * 2 * MIN;
    h.sched.enqueue('ask', ask(`a${i}`));
  }
  h.state.t = T(23, 30);
  ok(h.sched.enqueue('ask', ask('over')).action === 'subtitle', 'rollover: the cap is reached on day 1');
  h.state.t = T(0, 1, 0, 20);
  const r = h.sched.enqueue('ask', ask('newday'));
  ok(r.action === 'speak' && h.sched.status().dayCount === 1, 'rollover: the local-day cap resets at 00:00', { r, status: h.sched.status() });

  // P6: chatty, no line and no board change for the required time; the pool never repeats within the local day.
  const idleSched = make({ level: 'chatty', t: T(4, 0) });
  idleSched.state.t = T(4, 31);
  idleSched.sched.tick();
  ok(idleSched.emitted.filter((e) => e.kind === 'idle').length === 1, 'idle: chatty emits one P6 after 30 min of no board change', idleSched.emitted.map((e) => e.kind));
  idleSched.state.t = T(4, 32);
  idleSched.sched.tick();
  ok(idleSched.emitted.filter((e) => e.kind === 'idle').length === 1, 'idle: the same idle template is not repeated within the day');
  idleSched.state.t = T(4, 31, 0, 20);
  idleSched.sched.tick();
  ok(idleSched.emitted.filter((e) => e.kind === 'idle').length === 2, 'idle: the pool resets on the next local day');

  const stillSched = make({ level: 'chatty', t: T(4, 0) });
  stillSched.sched.enqueue('step', step('Avatar', 'Rig'));
  stillSched.state.t = T(4, 31);
  stillSched.sched.tick();
  const still = stillSched.emitted.find((e) => e.kind === 'idle');
  ok(Boolean(still) && still.show.includes('Avatar'), 'idle: with a recent board item the still-on-step template is used', still);
}

// ---------- 12. line pool ----------
{
  const data = JSON.parse(fs.readFileSync(new URL('../src/main/speech-lines.json', import.meta.url), 'utf8'));
  const enKeys = Object.keys(data.en).sort();
  const viKeys = Object.keys(data.vi).sort();
  ok(JSON.stringify(enKeys) === JSON.stringify(viKeys), 'pool: en/vi key parity', { en: enKeys.length, vi: viKeys.length });
  const EXPECTED_KEYS = [
    'ask.generic', 'ask.many', 'ask.plain', 'ask.step', 'checkin.none', 'checkin.some', 'event.boardBack',
    'event.boardLost', 'event.look', 'event.pat', 'event.poke', 'event.updated', 'idle.quiet', 'idle.still',
    'morning.none', 'morning.one', 'morning.some', 'progress.many', 'progress.one', 'step.blocked', 'step.done',
    'step.done.plain', 'welcome.none', 'welcome.some',
    // T-31 alpha.12 (PLAN-ZUMI-WATCH): watcher findings, the W6 check-in variants and the soul-change line.
    'watch.W1', 'watch.W3b', 'watch.W4', 'watch.many', 'watch.generic', 'checkin.review', 'checkin.reviewOnly', 'event.soul',
  ].sort();
  ok(JSON.stringify(enKeys) === JSON.stringify(EXPECTED_KEYS), 'pool: the table is exactly the plan 3.2 key set + check-ins + alpha.12 watch/soul', enKeys);
  ok(JSON.stringify([...LINE_KEYS].sort()) === JSON.stringify(EXPECTED_KEYS), 'pool: LINE_KEYS exposes the same explicit key set');
  ok(KINDS.join(',') === 'ask,step,progress,morning,welcome,checkin,event,idle,watch', 'pool: KINDS is the scheduler vocabulary (+ watch, alpha.12)', KINDS);
  ok(linePoolShape(data.en) && linePoolShape(data.vi), 'pool: every entry has a plain string text and a valid mood');
  ok(MOODS['event.look'] === 'greet' && MOODS['step.blocked'] === 'think' && MOODS['ask.step'] === 'point-screen' && MOODS['checkin.some'] === 'greet', 'pool: moods are pinned to the plan (not just self-compared)', MOODS);
  const emptyProgress = renderLine('progress', {}, 'en');
  ok(emptyProgress.speak === '' && emptyProgress.show === '', 'pool: an empty progress payload renders nothing (never " moved on to .")', emptyProgress);
  const codeOnlyMany = renderLine('ask', { n: 2, title: 'T-31' }, 'en');
  ok(codeOnlyMany.key === 'ask.generic' && codeOnlyMany.speak === 'A task needs your answer.', 'pool: a code-only title never renders "First ."', codeOnlyMany);

  const WORST_TITLE = 'T'.repeat(50);
  const WORST_STEP = 'S'.repeat(40);
  const scenarios = [
    ['ask.step', 'ask', { title: WORST_TITLE, step: WORST_STEP }],
    ['ask.plain', 'ask', { title: WORST_TITLE }],
    ['ask.generic', 'ask', {}],
    ['ask.many', 'ask', { n: 3, title: WORST_TITLE }],
    ['step.done', 'step', { title: WORST_TITLE, step: WORST_STEP, outcome: 'done' }],
    ['step.done.plain', 'step', { title: WORST_TITLE, outcome: 'done' }],
    ['step.blocked', 'step', { title: WORST_TITLE, step: WORST_STEP, outcome: 'blocked' }],
    ['progress.one', 'progress', { title: WORST_TITLE, step: WORST_STEP }],
    ['progress.many', 'progress', { n: 3 }],
    ['morning.some', 'morning', { n: 3 }],
    ['morning.one', 'morning', { n: 1 }],
    ['morning.none', 'morning', { n: 0 }],
    ['welcome.some', 'welcome', { u: 2, a: 1 }],
    ['welcome.none', 'welcome', { u: 0, a: 0 }],
    ['checkin.some', 'checkin', { n: 3, time: '12:00' }],
    ['checkin.none', 'checkin', { n: 0, time: '16:00' }],
    ['event.poke', 'event', { event: 'poke' }],
    ['event.pat', 'event', { event: 'pat' }],
    ['event.updated', 'event', { event: 'updated', version: '0.2.5' }],
    ['event.boardLost', 'event', { event: 'boardLost' }],
    ['event.boardBack', 'event', { event: 'boardBack' }],
    ['event.look', 'event', { event: 'look' }],
    ['idle.quiet', 'idle', { key: 'idle.quiet' }],
    ['idle.still', 'idle', { key: 'idle.still', title: WORST_TITLE, step: WORST_STEP }],
  ];
  const CODE = /\b[A-Z]{1,3}\d{0,3}-(?:\d{1,3}[A-Za-z]?|[A-Za-z])\b/;
  for (const [key, kind, payload] of scenarios) {
    for (const lang of ['en', 'vi']) {
      const line = renderLine(kind, payload, lang);
      ok(line.key === key, `pool ${lang}: ${kind} picks ${key}`, line.key);
      ok(line.speak.length > 0 && line.show.length > 0 && line.speak.length <= 90 && line.show.length <= 90, `pool ${lang}: ${key} is non-empty and <= 90 chars`, { speak: line.speak.length, show: line.show.length });
      if (payload.title && payload.step) {
        // Under the Fable caps (35/30) every EN template fits both vars; the long VI ask.step / step.blocked
        // cannot (no fillFitted any more), so only EN is required to keep the step; both must keep the title.
        ok(line.show.includes(WORST_TITLE.slice(0, 4)), `pool ${lang}: ${key} keeps the title inside 90 chars`, line.show);
        if (lang === 'en') ok(line.show.includes(WORST_STEP.slice(0, 4)), `pool ${lang}: ${key} keeps title + step inside 90 chars`, line.show);
      }
      ok(!/[{}]/.test(line.speak) && !/[{}]/.test(line.show), `pool ${lang}: ${key} has no leftover template brace`, line);
      ok(!/[:/\\]/.test(line.speak), `pool ${lang}: ${key} speak has no colon/slash/backslash`, line.speak);
      ok(!CODE.test(line.speak), `pool ${lang}: ${key} speak carries no task code`, line.speak);
      ok(line.mood === MOODS[key], `pool ${lang}: ${key} keeps its mood`, { got: line.mood, want: MOODS[key] });
    }
  }

  const codeLine = renderLine('ask', { title: 'T-31 Zumi avatar', step: 'HUD' }, 'en');
  ok(!codeLine.speak.includes('T-31') && !codeLine.show.includes('T-31') && codeLine.speak.includes('Zumi avatar'), 'pool: a "T-31 Zumi avatar" title is spoken without the code', codeLine);

  const f4 = renderLine('ask', { title: 'Việc nhà', step: 'Bước một' }, 'en');
  ok(f4.key === 'ask.generic' && f4.speak === 'A task needs your answer.' && f4.show.includes('Việc nhà'), 'pool (F4): EN voice + Vietnamese title -> no-title spoken variant, full subtitle', f4);
  const VI_TEXT = /[\u00C0-\u1EF9]/;
  const f4Step = renderLine('step', { title: 'Task', step: 'Bước một', outcome: 'done' }, 'en');
  ok(f4Step.key === 'step.done.plain' && !VI_TEXT.test(f4Step.speak) && f4Step.show.includes('Bước một'), 'pool (F4): a Vietnamese step -> the no-step spoken variant', f4Step);
  const f4Idle = renderLine('idle', { key: 'idle.still', title: 'Việc nhà', step: 'Bước một' }, 'en');
  ok(f4Idle.key === 'idle.quiet' && !VI_TEXT.test(f4Idle.speak), 'pool (F4): a Vietnamese idle.still -> idle.quiet', f4Idle);
  const f4NoVariant = renderLine('step', { title: 'Task', step: 'Bước một', outcome: 'blocked' }, 'en');
  ok(f4NoVariant.speak === '' && f4NoVariant.show.includes('Bước một'), 'pool (F4): no safe variant -> subtitle only, never VI text to the EN voice', f4NoVariant);
  const f4ViTitle = renderLine('step', { title: 'Việc nhà', step: 'Bước một', outcome: 'done' }, 'en');
  ok(f4ViTitle.speak === '' && f4ViTitle.show.includes('Việc nhà'), 'pool (F4): a VI title with no no-title step line stays a subtitle', f4ViTitle);
  const vi = renderLine('ask', { title: 'Việc nhà', step: 'Bước một' }, 'vi');
  ok(vi.key === 'ask.step' && vi.speak.includes('Việc nhà') && vi.speak.includes('Bước một'), 'pool: the VI voice keeps the full title/step line', vi);

  // ---------- 12b. the Fable line-pool review (19-10): items 1-10 ----------
  // Item 1: ask.many EN.
  const it1 = renderLine('ask', { n: 3, title: 'Task' }, 'en');
  ok(it1.speak === '3 things need your answer. The first is Task.', 'item 1: ask.many EN text', it1.speak);
  // Item 2: ask.step VI.
  const it2 = renderLine('ask', { title: 'Task', step: 'Step' }, 'vi', { selfWord: 'em', userWord: 'anh' });
  ok(it2.key === 'ask.step' && it2.speak === 'Anh ơi, việc Task cần anh trả lời ở bước Step.', 'item 2: ask.step VI text', it2.speak);
  // Item 3: morning.some EN, welcome.some EN + VI.
  const it3a = renderLine('morning', { n: 2 }, 'en');
  ok(it3a.speak === 'Good morning. 2 things need your answer.', 'item 3: morning.some EN text', it3a.speak);
  const it3b = renderLine('welcome', { u: 2, a: 1 }, 'en');
  ok(it3b.speak === 'Welcome back. 2 updates and 1 asks while you were away.', 'item 3: welcome.some EN text', it3b.speak);
  const it3c = renderLine('welcome', { u: 2, a: 1 }, 'vi', { selfWord: 'em', userWord: 'anh' });
  ok(it3c.speak === 'Anh về rồi à. Lúc anh vắng có 2 cập nhật, 1 việc chờ anh.', 'item 3: welcome.some VI text', it3c.speak);
  // Item 4: event.boardLost EN + VI.
  const it4a = renderLine('event', { event: 'boardLost' }, 'en');
  ok(it4a.speak === "I can't reach the board right now. I'll keep trying.", 'item 4: boardLost EN text', it4a.speak);
  const it4b = renderLine('event', { event: 'boardLost' }, 'vi', { selfWord: 'em', userWord: 'anh' });
  ok(it4b.speak === 'Em mất kết nối bảng việc rồi, để em thử lại.', 'item 4: boardLost VI text', it4b.speak);
  // Item 5: step.done.plain EN (the fallback only).
  const it5 = renderLine('step', { title: 'Task', outcome: 'done' }, 'en');
  ok(it5.key === 'step.done.plain' && it5.speak === 'Task just finished a step.', 'item 5: step.done.plain EN text', it5.speak);
  // Item 6: step.done only when outcome === 'done'; anything else is progress (regression guard).
  const it6a = renderLine('step', { title: 'Task', step: 'Step' }, 'en');
  ok(it6a.key === 'progress.one', 'item 6: a step event without outcome=done is progress, never "done"', it6a);
  const it6b = renderLine('step', { title: 'Task', step: 'Step', outcome: 'started' }, 'en');
  ok(it6b.key === 'progress.one' && !it6b.speak.includes('done'), 'item 6: any non-done outcome is progress', it6b);
  const it6c = renderLine('step', { title: 'Task', step: 'Step', outcome: 'done' }, 'en');
  ok(it6c.key === 'step.done', 'item 6: outcome=done is the step.done line', it6c);
  // Item 7: the check-in lines (the clock itself is section 13).
  const it7a = renderLine('checkin', { n: 2, time: '12:00' }, 'en');
  ok(it7a.key === 'checkin.some' && it7a.speak === "It's 12 PM. 2 things need your answer.", 'item 7: checkin.some EN text', it7a.speak);
  const it7b = renderLine('checkin', { n: 0, time: '16:00' }, 'vi', { selfWord: 'em', userWord: 'anh' });
  ok(it7b.key === 'checkin.none' && it7b.speak === '4 giờ chiều rồi anh. Chưa có việc gì chờ anh.', 'item 7: checkin.none VI text', it7b.speak);
  // Item 8: no variant arrays; one poke line per language.
  const anyArray = ['en', 'vi'].some((l) => Object.values(data[l]).some((e) => Array.isArray(e.text)));
  ok(!anyArray, 'item 8: no entry carries a variant array (one line per key)');
  const it8en = renderLine('event', { event: 'poke' }, 'en');
  const it8vi = renderLine('event', { event: 'poke' }, 'vi');
  ok(it8en.speak === 'Mm?' && it8vi.speak === 'Dạ?', 'item 8: one poke line per language', { en: it8en.speak, vi: it8vi.speak });
  // Item 9: fillFitted / shrinkVar / textOf deleted; title capped at 35, step at 30.
  const linesSrc = fs.readFileSync(new URL('../src/main/speech-lines.mjs', import.meta.url), 'utf8');
  ok(!/fillFitted|shrinkVar|textOf/.test(linesSrc), 'item 8-9: fillFitted / shrinkVar / textOf are deleted from speech-lines.mjs');
  const capTitle = renderLine('ask', { title: 'T'.repeat(50) }, 'en');
  ok(capTitle.show === `${'T'.repeat(35)} is waiting for your answer.`, 'item 9: the title is capped at 35 chars', capTitle.show);
  const capStep = renderLine('progress', { title: 'Task', step: 'S'.repeat(50) }, 'en');
  ok(capStep.show.includes('S'.repeat(30)) && !capStep.show.includes('S'.repeat(31)), 'item 9: the step is capped at 30 chars', capStep.show);
  // Item 10: one input convention only, kind='event' + payload.event='boardLost'.
  const it10a = renderLine('event', { event: 'boardLost' }, 'en');
  ok(it10a.key === 'event.boardLost' && it10a.speak.includes('board'), 'item 10: kind=event + payload.event=boardLost is the one convention', it10a);
  const it10b = renderLine('event', { name: 'boardLost' }, 'en');
  ok(it10b.key === 'event.poke', 'item 10: the old payload.name / payload.type aliases are gone', it10b);
  const it10c = renderLine('event', { event: 'board-lost' }, 'en');
  ok(it10c.key === 'event.board-lost' && it10c.speak === '', 'item 10: the dash/space normaliser is gone (a non-conforming event renders nothing)', it10c);
}

// ---------- 13. the 12:00/16:00 check-in clock (Fable review item 7) ----------
{
  // A morning tick first, so the daily greeting is spent and does not eat the gap the check-in needs.
  const h = make({ level: 'normal', quietOn: true, t: T(8, 0) });
  h.sched.tick();
  ok(h.emitted.filter((e) => e.kind === 'morning').length === 1, 'checkin: morning fired first (test setup)');
  h.state.t = T(12, 0, 5);
  h.sched.tick();
  ok(h.emitted.filter((e) => e.kind === 'checkin').length === 1, 'checkin: the 12:00 window fires once');
  h.state.t = T(12, 30);
  h.sched.tick();
  ok(h.emitted.filter((e) => e.kind === 'checkin').length === 1, 'checkin: it does not repeat inside the same window');
  h.state.t = T(16, 0, 5);
  h.sched.tick();
  ok(h.emitted.filter((e) => e.kind === 'checkin').length === 2, 'checkin: the 16:00 window fires too');
  h.state.t = T(13, 0); // exactly one hour after 12:00: the window has closed, so nothing is caught up
  h.sched.tick();
  ok(h.emitted.filter((e) => e.kind === 'checkin').length === 2, 'checkin: no late 12:00 catch-up after its hour');
  h.state.t = T(8, 0, 0, 20); // next local day
  h.sched.tick();
  h.state.t = T(12, 0, 5, 20);
  h.sched.tick();
  ok(h.emitted.filter((e) => e.kind === 'checkin').length === 3, 'checkin: the next day resets both windows');

  // The class list: Normal + Chatty only.
  const quiet = make({ level: 'quiet', quietOn: true, t: T(12, 0, 5) });
  quiet.sched.tick();
  ok(!quiet.emitted.some((e) => e.kind === 'checkin'), 'checkin: Quiet has no check-ins');
  const chatty = make({ level: 'chatty', quietOn: true, t: T(8, 0) });
  chatty.sched.tick(); // spend the morning line
  chatty.state.t = T(12, 0, 5);
  chatty.sched.tick();
  ok(chatty.emitted.filter((e) => e.kind === 'checkin').length === 1, 'checkin: Chatty has check-ins');

  // The pref.
  const prefOff = make({ level: 'normal', quietOn: true, t: T(8, 0), extra: { talkCheckins: false } });
  prefOff.sched.tick();
  prefOff.state.t = T(12, 0, 5);
  prefOff.sched.tick();
  ok(!prefOff.emitted.some((e) => e.kind === 'checkin'), 'checkin: the talkCheckins pref off suppresses it');

  // waitingCount picks the line; the window id gives the spoken time.
  const some = make({ level: 'normal', quietOn: true, t: T(8, 0), waitingCount: 2 });
  some.sched.tick();
  some.state.t = T(12, 0, 5);
  some.sched.tick();
  const lineSome = some.emitted.find((e) => e.kind === 'checkin');
  ok(Boolean(lineSome) && lineSome.show === "It's 12 PM. 2 things need your answer.", 'checkin: 2 waiting -> checkin.some with the 12:00 label', lineSome);
  const none = make({ level: 'normal', quietOn: true, t: T(8, 0), waitingCount: 0 });
  none.sched.tick();
  none.state.t = T(16, 0, 5);
  none.sched.tick();
  const lineNone = none.emitted.find((e) => e.kind === 'checkin');
  ok(Boolean(lineNone) && lineNone.show === "It's 4 PM. Nothing is waiting for you.", 'checkin: nothing waiting -> checkin.none with the 16:00 label', lineNone);
}

// ---------- inc 3: the board adapter (hud reaction -> scheduler line) and the P5 app-event lines ----------
{
  const r = (o) => ({ source: 'updates', state: '', title: 'Avatar', step: 'Rig', doneStep: '', stepChanged: false, batchCount: 1, askKey: null, ...o });
  const a = lineFromReaction(r({ source: 'waiting', state: 'waiting', askKey: 'ask:7', step: 'Pick a level' }));
  ok(a && a.kind === 'ask' && a.payload.key === 'ask:7' && a.payload.title === 'Avatar' && a.payload.step === 'Pick a level', 'adapter: a waiting ask -> ask {key, title, step}', a);
  const d = lineFromReaction(r({ state: 'done', doneStep: 'Rig', step: 'Skin' }));
  ok(d && d.kind === 'step' && d.payload.outcome === 'done' && d.payload.step === 'Rig', 'adapter: a finished step -> step(done) with the PREVIOUS step label', d);
  const b = lineFromReaction(r({ state: 'blocked', step: 'Skin' }));
  ok(b && b.kind === 'step' && b.payload.outcome === 'blocked' && b.payload.step === 'Skin', 'adapter: blocked -> step(blocked)', b);
  const p1 = lineFromReaction(r({ stepChanged: true }));
  const pn = lineFromReaction(r({ stepChanged: true, batchCount: 3 }));
  ok(p1 && p1.kind === 'progress' && p1.payload.title === 'Avatar' && pn && pn.payload.n === 3 && !('title' in pn.payload), 'adapter: a step change -> progress; a batch of several -> {n}', { p1, pn });
  ok(lineFromReaction(r({})) === null && lineFromReaction(null) === null && lineFromReaction('x') === null, 'adapter: plain activity with no step change maps to nothing (the old "has an update" line is gone)');

  // every P5 event has a line in both languages, and the whole path (event -> emitted text) works at Normal, not Quiet
  const wanted = { poke: ['Mm?', 'Dạ?'], pat: ['Mm, thanks.', 'Hihi, cảm ơn bạn.'], look: ['New look?', 'Trông em mới không bạn?'], boardLost: ["I can't reach the board right now. I'll keep trying.", 'Em mất kết nối bảng việc rồi, để em thử lại.'], boardBack: ['The board is back.', 'Bảng việc kết nối lại rồi.'] };
  for (const [event, [en, vi]] of Object.entries(wanted)) {
    const he = make({ level: 'normal', lang: 'en' }); he.sched.enqueue('event', { event });
    const hv = make({ level: 'normal', lang: 'vi' }); hv.sched.enqueue('event', { event });
    ok(he.emitted.length === 1 && he.emitted[0].show === en && hv.emitted.length === 1 && hv.emitted[0].show === vi, `P5: event ${event} speaks its line in EN and VI at Normal`, { en: he.emitted.map((e) => e.show), vi: hv.emitted.map((e) => e.show) });
  }
  const quietPoke = make({ level: 'quiet' }); quietPoke.sched.enqueue('event', { event: 'poke' });
  ok(quietPoke.emitted.length === 0, 'P5: Quiet never speaks an app-event line');
  const upd = make({ level: 'normal', lang: 'en' }); upd.sched.enqueue('event', { event: 'updated', version: '0.2.5' });
  ok(upd.emitted.length === 1 && upd.emitted[0].show === "I'm on version 0.2.5 now.", 'P5: the updated line carries the version', upd.emitted.map((e) => e.show));
  // a poke followed at once by a pat: the 3-minute Normal gap keeps her from chattering at every click
  const burst = make({ level: 'normal' }); burst.sched.enqueue('event', { event: 'poke' }); burst.sched.enqueue('event', { event: 'pat' });
  ok(burst.emitted.length === 1, 'P5: two reactions inside the gap speak once (the second is dropped, not queued)');
  // P5 never uses the reply path's voice gate: a subtitle-only line while muted
  const mutedPoke = make({ level: 'normal' }); mutedPoke.sched.mute(null); mutedPoke.sched.enqueue('event', { event: 'poke' });
  ok(mutedPoke.emitted.length === 0, 'P5: muted -> an app-event line is dropped (only a P1 ask survives a mute, as a subtitle)');
}

function linePoolShape(table) {
  for (const key of Object.keys(table)) {
    const e = table[key];
    if (!e || typeof e !== 'object') return false;
    // Fable review item 8: one plain string per key, never a variant array.
    if (typeof e.text !== 'string' || !e.text.length) return false;
    if (!(e.mood === null || typeof e.mood === 'string')) return false;
  }
  return true;
}

console.log(`\ncheck:talk-mode ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
