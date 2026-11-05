// Agent core (T-31 alpha.12, PLAN-ZUMI-WATCH v2 F alpha.12 rows): the one place both hosts (Electron main.js and the
// Tauri sidecar main.mjs) build the soul store, the rhythm core, the said.jsonl ring buffer and the board watcher, and
// the RPC handlers the renderer calls. Each host only supplies its own seams (settings I/O, idle seconds, the speech
// scheduler, the board RELAY channel); every decision stays in the modules below, so the two hosts cannot drift.
//
//   soul-prefs.js   soul.get / soul.save / soul.undo, and getSoul() for createChatBrain (read every turn)
//   rhythm.mjs      rhythm.get / rhythm.pause / rhythm.reset; `active` sampled once a minute from system idle;
//                   chat / mute / nudge / owner-board events from the hooks below; checkinHours() for the scheduler
//   said-log.mjs    <dataDir>/said.jsonl, written from the scheduler ack (onSaid)
//   watch-host.mjs  onBoardState(state) on every HUD poll; watchFeed() for 'hud:feed'; watch.setLevel
//
// Files it owns: <dataDir>/rhythm/*, <dataDir>/said.jsonl, <dataDir>/soul-history.json, <dataDir>/watch-state.json.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createRhythm } from './rhythm.mjs';
import { createSaidLog } from './said-log.mjs';
import { createWatchHost, watchLevelOf, WATCH_LEVELS } from './watch-host.mjs';
import { ownerSignals } from './watch-rules.mjs';
import { LEVELS, talkPrefs } from './speech-scheduler.mjs';

const require = createRequire(import.meta.url);
const { createSoulStore } = require('./soul-prefs.js');

const ACTIVE_SAMPLE_MS = 60_000;   // how often system idle is sampled into the rhythm's 5-min `active` buckets
const ACTIVE_IDLE_SEC = 60;        // idle under 60 s = the owner is at the PC (plan v2 A.2)
// Proactive line kinds that count as a nudge for the rhythm's reacted/ignored rate (an `event` is a reply to a poke/pat).
const NUDGE_KINDS = new Set(['ask', 'step', 'progress', 'morning', 'welcome', 'checkin', 'idle', 'watch']);

/**
 * @param {object} o
 * @param {string} o.dataDir
 * @param {() => object} o.settings
 * @param {(patch: object) => object} o.saveSettings
 * @param {() => number} [o.idleSeconds]  system idle seconds (powerMonitor / __host.idle)
 * @param {(kind: string, payload: object) => object} [o.say]  the speech scheduler's enqueue (bound lazily by the host)
 * @param {(op: string, body: object) => Promise<{status:number}>} [o.relay]  the board RELAY channel (liveBoard.relay)
 * @param {boolean} [o.ownerBuild]  the build's default address words (soul-prefs.js createSoulStore)
 * @param {() => number} [o.now]
 * @param {(m: string) => void} [o.log]
 */
export function createAgentCore({ dataDir, settings, saveSettings, idleSeconds = () => null, say = () => ({ action: 'drop' }), relay = null, now = Date.now, log = () => {}, ownerBuild = false }) {
  const soul = createSoulStore({ settings, saveSettings, dataDir, now, ownerBuild });
  const rhythm = createRhythm({
    dataDir, now, log: (m) => log(`[rhythm] ${m}`),
    levelCap: () => (LEVELS[talkPrefs(settings(), now()).talkLevel] || LEVELS.off).cap,
  });
  const said = createSaidLog({ dataDir });
  const memoFile = path.join(dataDir, 'watch-state.json');
  const watch = createWatchHost({
    // The watcher's one board write, with the op fixed HERE: it receives no function that can name another op.
    relay: typeof relay === 'function' ? (body) => relay('inbox.submit', body) : null,
    say: (kind, payload) => say(kind, payload), rhythm: () => rhythm.get(), settings, now,
    memo: {
      load: () => { try { return JSON.parse(fs.readFileSync(memoFile, 'utf8')); } catch { return null; } },
      save: (m) => { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(`${memoFile}.tmp`, JSON.stringify(m)); fs.renameSync(`${memoFile}.tmp`, memoFile); },
    },
    log: (m) => log(`[watch] ${m}`),
  });
  let boardSnap = null;
  let timer = null;

  const safe = (name, fn) => { try { return fn(); } catch (e) { log(`[agent-core] ${name} failed: ${(e && e.message) || e}`); return null; } };

  function sample() {
    const idle = safe('idleSeconds', idleSeconds);
    if (typeof idle === 'number' && Number.isFinite(idle) && idle < ACTIVE_IDLE_SEC) safe('record active', () => rhythm.record('active'));
    safe('rhythm tick', () => rhythm.tick());
  }

  const rhythmView = () => ({ ...rhythm.get(), watchLevel: watchLevelOf(settings()) });

  const handlers = {
    'soul.get': () => soul.get(),
    // `onboarding: true` (the first-run cards): after a good save she says one line in the new name, so the change is heard.
    'soul.save': (input) => {
      const p = input && typeof input === 'object' ? input : {};
      const { onboarding, ...patch } = p;
      const r = soul.save(patch);
      if (r.ok && onboarding === true) safe('soul line', () => say('event', { event: 'soul', name: r.soul.name }));
      return r;
    },
    'soul.undo': () => soul.undo(),
    'rhythm.get': () => rhythmView(),
    'rhythm.pause': (on) => { rhythm.pause(on === true); return rhythmView(); },
    'rhythm.reset': () => { rhythm.reset(); return rhythmView(); },
    'watch.setLevel': (lv) => {
      if (!WATCH_LEVELS.includes(lv)) return rhythmView();
      saveSettings({ watchLevel: lv });
      return rhythmView();
    },
  };

  return {
    handlers,
    getSoul: () => soul.current(),
    address: () => soul.current(),
    checkinHours: () => rhythm.get().checkinHours,
    /** speech-scheduler onSaid: said.jsonl + the rhythm's nudge.said. */
    onSaid: (s) => {
      safe('said.jsonl', () => said.append({ t: s.t, kind: s.kind, text: s.text }));
      if (NUDGE_KINDS.has(s.kind)) safe('nudge.said', () => rhythm.record('nudge.said', { key: `${s.kind}:${s.key || ''}`, kind: s.kind }));
    },
    onChat: () => safe('chat', () => rhythm.record('chat')),
    onMute: (untilMs) => safe('mute', () => rhythm.record('mute', { untilMs })),
    /** hud-host onState: rhythm owner signals, then the watcher rule pass. */
    onBoardState: async (state) => {
      const sig = safe('ownerSignals', () => ownerSignals(boardSnap, state));
      if (sig) {
        boardSnap = sig.snapshot;
        for (const a of sig.answered) safe('ask.answered', () => rhythm.record('ask.answered', a));
        for (const w of sig.writes) safe('board.write', () => rhythm.record('board.write', w));
      }
      try { return await watch.onState(state); } catch (e) { log(`[watch] onState failed: ${(e && e.message) || e}`); return null; }
    },
    watchFeed: () => watch.feed(),
    watchCount: () => watch.count(),
    start: () => { if (timer) return; timer = setInterval(sample, ACTIVE_SAMPLE_MS); if (typeof timer.unref === 'function') timer.unref(); sample(); },
    dispose: () => { if (timer) clearInterval(timer); timer = null; },
    _test: { rhythm, watch, said, soul, sample },
  };
}
