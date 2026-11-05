// T-31 parity step 8a: the talk-mode scheduler, hosted in the sidecar.
//
// This wraps src/main/speech-scheduler.mjs UNCHANGED (the pure module main.js loads inside app.whenReady). The
// module owns the prefs, the level matrix, the hold queue and every clock; this host only supplies what Electron
// supplies there and nothing more:
//   - migrateTalkLevel() once at start, before anything reads prefs                     (main.js:2012)
//   - one settings read shared for 500 ms; a write through setTalkPrefs drops it       (main.js:2016-2019)
//   - signals(): the cached __host.idle / __host.windowVisible (step 6-pre) and waitingCount (step 9's hudHost)
//   - one 1 s scheduler.tick(), started by sayReady                                    (main.js:2030-2039)
//   - before sayReady, an emitted line is acked busy instead of vanishing              (main.js:2025)
//   - the "updated" line carries the app version the host reports (package.json)       (main.js:2034-2038)
//   - boardReaction/boardStatus/talkActive: the three seams step 9's HUD host calls   (main.js:1285/1946-1948)
//
// Known gaps, closed by later steps (PLAN-steps6plus section 8a; written here, not hidden):
//   - setTalkPrefs -> hudHost.start() is wired in main.mjs's handler (there is a hudHost from step 9 on).
//
// The preview has no self-test/demo run (info.selftest and info.demo are always false), so Electron's
// "no clock lines in self-test/demo" branch has no counterpart: sayReady is the only thing that starts the clock.
//
// Security: no secrets and no egress. sayEvent() accepts exactly poke | pat | look (main.js:1289).
import { createSpeechScheduler, lineFromReaction, migrateTalkLevel, setTalkPrefs, talkPrefs } from '../../src/main/speech-scheduler.mjs';

const SAY_EVENTS = ['poke', 'pat', 'look'];
const SETTINGS_CACHE_MS = 500;

/**
 * @param {{ settings: () => object, saveSettings: (patch: object) => object,
 *           signals: { idleSeconds: () => number, windowVisible: () => boolean },
 *           emit: (channel: string, payload: unknown) => boolean, version: string,
 *           now?: () => number, intervalMs?: number, log?: (m: string) => void,
 *           agent?: { checkinHours: () => number[], onSaid: Function, onMute: Function, watchCount: () => number } }} o
 *   agent: T-31 alpha.12 agent-core seams (rhythm check-in hours, said.jsonl + nudge log, mute event, W6 count), the
 *   same ones main.js hands its scheduler. Absent = the alpha.10 behaviour.
 */
export function createSpeechHost({
  settings, saveSettings, signals, emit, version,
  now = Date.now, intervalMs = 1000, log = () => {}, agent = null,
}) {
  let sayReady = false;
  let tick = null;
  let cache = { at: 0, v: {} };
  let waitingCount = 0; // Electron's boardWaitingCount; step 9's hudHost.onWaiting will own it
  let scheduler = null;

  // Electron main.js:2012: the one-time hudVoiceMuted -> talkLevel migration, before any prefs read.
  const migration = migrateTalkLevel(settings());
  if (migration) saveSettings(migration);

  // main.js:2016-2017: settings.json is read a few times per scheduler decision, so one read is shared for half a
  // second. A write through setTalkPrefsNow drops the cache, so a Settings change is seen by the very next decision.
  const settingsNow = () => {
    const n = now();
    if (n - cache.at > SETTINGS_CACHE_MS) cache = { at: n, v: settings() };
    return cache.v;
  };
  const setTalkPrefsNow = (patch) => setTalkPrefs(patch, {
    settings: settings(), now: now(),
    save: (next) => { saveSettings(next); cache = { at: 0, v: {} }; },
  });

  scheduler = createSpeechScheduler({
    prefs: settingsNow,
    signals: () => ({ idleSec: signals.idleSeconds(), windowVisible: signals.windowVisible(), waitingCount, watchCount: agent ? agent.watchCount() : 0 }),
    now,
    ...(agent ? { checkinHours: agent.checkinHours, onSaid: agent.onSaid, address: agent.address } : {}),
    // main.js:2025: a line with no listener yet is handed back as busy (a P1 ask is re-held, the rest dropped)
    // rather than vanishing silently.
    emit: (line) => {
      if (sayReady) emit('speech:say', line);
      else queueMicrotask(() => scheduler.ack(line.sayId, { spoken: false, reason: 'busy' }));
    },
    log: (m) => log(`[speech] ${m}`),
  });

  // main.js:2030-2039. Started by talk:sayReady, so no line is emitted before the renderer can show it.
  function startClock() {
    if (tick) return;
    tick = setInterval(() => {
      try { scheduler.tick(); } catch (e) { log(`[speech] tick failed: ${(e && e.message) || e}`); }
    }, intervalMs);
    if (typeof tick.unref === 'function') tick.unref();
    // The "new version" line: only when a previous version was recorded (not on the very first run).
    const prior = talkPrefs(settings(), now()).talkLastVersion;
    if (prior !== version) {
      setTalkPrefsNow({ talkLastVersion: version });
      if (prior) scheduler.enqueue('event', { event: 'updated', version });
    }
  }

  const handlers = {
    // main.js:1258-1265. The scheduler owns the prefs; the renderer never writes a file.
    'talk.getTalkPrefs': () => talkPrefs(settings(), now()),
    'talk.setTalkPrefs': (p) => {
      if (!p || typeof p !== 'object') return null;
      // Electron also runs `if (hudHost) hudHost.start()` here (main.js:1252); main.mjs wires that next to this call,
      // so the preview's hudHost (step 9) is started by the same settings change.
      return setTalkPrefsNow(p);
    },

    // main.js:1181-1188. The three voice switches are plain settings writes and always answer true.
    'talk.setVoiceEnabled': (on) => { saveSettings({ voiceEnabled: on === true }); return true; },
    'talk.setThinkSound': (on) => { saveSettings({ thinkSound: on === true }); return true; },
    'talk.setSpeakTypedWhenMicOff': (on) => { saveSettings({ speakTypedWhenMicOff: on === true }); return true; },

    // main.js:1281-1285. Idempotent: a renderer reload calls sayReady again.
    'talk.sayReady': () => { sayReady = true; startClock(); return true; },
    // Electron's preload wraps the page's three arguments into one { sayId, spoken, reason } object; the Tauri shim
    // sends them positionally (tauri/shim/zumi-shim.js:236). Accept both so the page contract is identical.
    'talk.sayAck': (sayId, spoken, reason) => {
      const p = sayId && typeof sayId === 'object' ? sayId : { sayId, spoken, reason };
      return scheduler.ack(p.sayId, { spoken: p.spoken !== false, reason: p.reason || null });
    },
    // main.js:1288-1292. A whitelisted owner-triggered line only; never arbitrary text.
    'talk.sayEvent': (name) => {
      if (!SAY_EVENTS.includes(name)) return false;
      scheduler.enqueue('event', { event: name });
      return true;
    },
    'talk.sayStatus': () => scheduler.status(),

    // main.js:1268-1279. The stage mute is a PREF (talkMute), so it survives a restart; untilMs null = until unmuted.
    'talk.mute': (untilMs) => {
      const until = untilMs == null ? null : Number(untilMs);
      if (until !== null && !Number.isFinite(until)) return scheduler.status();
      setTalkPrefsNow({ talkMute: { until } });
      if (agent) agent.onMute(until);
      return scheduler.status();
    },
    'talk.unmute': () => { setTalkPrefsNow({ talkMute: null }); return scheduler.status(); },
  };

  // stdin closed (the host is quitting): stop the one interval. The scheduler holds no other OS resource.
  const dispose = () => { if (tick) { clearInterval(tick); tick = null; } };

  return {
    handlers,
    dispose,
    scheduler,
    setWaitingCount: (n) => { waitingCount = Number(n) || 0; },
    // main.js:1285 boardReactionToSay: a HUD reaction -> one scheduler line (a plain activity ping maps to nothing).
    boardReaction: (r) => { const line = lineFromReaction(r); if (line) scheduler.enqueue(line.kind, line.payload); },
    // main.js:1948 onBoardStatus: 3 failed reads -> board-lost, the first good read after -> board-back.
    boardStatus: (ok) => { scheduler.enqueue('event', { event: ok ? 'boardBack' : 'boardLost' }); },
    // main.js:1945 talkActive: the HUD poll runs while a talk level is on, even with the HUD hidden.
    talkActive: () => talkPrefs(settings(), now()).talkLevel !== 'off',
  };
}
