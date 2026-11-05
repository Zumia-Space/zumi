// T-31 parity step 9-1: the talk-camera HUD, hosted in the sidecar.
//
// This wraps src/main/hud-host.mjs UNCHANGED (the module main.js builds in app.whenReady) and adds exactly what
// Electron adds around it:
//   - getState from the SAME boardReader chat uses (built in chat-host.mjs over step 10a's liveBoard; no second
//     connection, no new egress);
//   - idleSeconds from the step-6-pre cache (`__host.idle`), passed as main.js passes powerMonitor's idle time (the
//     19-10 rewiring leaves it unused inside hud-host.mjs: the scheduler owns idle now);
//   - decide = board-open.mjs decideOpenRef with this build's ownerAdmin flag (the frozen module, not a copy);
//   - getAnswerState = the owner flag + the board's own live/unlocked state, exactly main.js:1955;
//   - `hud:feed` = one emit per read, carrying Electron's payload shape ({style, feed, reaction, answer}) so a future
//     renderer template plugs in without sidecar changes.
//
// The ask answerer (hud-answer.mjs, frozen) exists ONLY in the owner flavour: elsewhere `hud.answerAsk` refuses
// `not_owner_build` and no relay is built. In the owner flavour it relays through liveBoard.relay (op = ask.answer,
// fixed by the frozen module) and only while the board is configured, unlocked and live.
//
// Opening an acceptance item (hud.answer -> consent gate -> decide -> open) is step 9-2's Rust primitive. main.mjs
// supplies createHostOpen() in the owner flavour; without an opener (a release build) the seam fails closed and the
// answer reports {opened:false, reason:'open_unavailable'} instead of claiming a file or URL was opened.
//
// Security: no secrets, no egress, no new dependency. scripts/check-tauri-hud.mjs drives the real sidecar against a
// loopback upstream only.
import { createHudHost as createElectronHudHost } from '../../src/main/hud-host.mjs';
import { decideOpenRef } from '../../src/main/board-open.mjs';
import { createAskAnswerer } from '../../src/main/hud-answer.mjs';

/** Electron's test-only fast poll (main.js:1934). Only a test flavour may read it; a public build is 20 s always. */
export const HUD_POLL_ENV = 'ZUMI_TEST_HUD_POLL_MS';

/**
 * @param {{flavour?: {values?: object}, env?: object}} o
 * @returns {number|undefined} the poll/cooldown interval for a test flavour, else undefined (hud-host.mjs's 20 s)
 */
export function hudPollMs({ flavour, env = process.env } = {}) {
  const fv = (flavour && flavour.values) || {};
  const n = Number(env[HUD_POLL_ENV]);
  return fv.test === true && Number.isFinite(n) && n >= 1000 ? n : undefined;
}

/**
 * The step-9-2 opener seam: a consent decision becomes exactly one host request. Rust re-validates before
 * ShellExecuteW (the decision above is the sidecar's policy answer, not the authority). A refused or unknown
 * action throws, so the frozen hud-host reports `open_unavailable` instead of a success it did not perform.
 * @param {(method: string, params?: unknown[]) => Promise<unknown>} call  createHostCalls().call
 */
export function createHostOpen(call) {
  if (typeof call !== 'function') throw new TypeError('createHostOpen needs a host call function');
  return async (decision) => {
    if (decision && decision.action === 'openPath' && typeof decision.path === 'string') {
      await call('__sidecarHost.shell.openPath', [decision.path]);
      return;
    }
    if (decision && decision.action === 'openExternal' && typeof decision.url === 'string') {
      await call('__sidecarHost.shell.openExternal', [decision.url]);
      return;
    }
    throw new Error('open_unavailable');
  };
}

/**
 * @param {object} o
 * @param {(opts: object) => Promise<{ok: boolean, state?: object, reason?: string}>} o.getState  board-reader.mjs getState
 * @param {() => number} [o.idleSeconds]  the cached `__host.idle` (host-signals.mjs)
 * @param {() => object} o.settings      readSettings(dataDir)
 * @param {(patch: object) => object} o.saveSettings
 * @param {(channel: string, payload: object) => boolean} o.emit  the sidecar's one push path
 * @param {boolean} [o.ownerAdmin]       the resolved flavour's ownerAdmin flag
 * @param {{status: () => object, relay?: Function}} o.liveBoard  step 10a's live board (status + relay)
 * @param {() => boolean} [o.talkActive]  talkLevel != off (hud-host.mjs polls while a level is on)
 * @param {(r: object) => void} [o.onReaction]  mapped to the 8a scheduler by main.mjs
 * @param {(n: number) => void} [o.onWaiting]   the 8a scheduler's waitingCount
 * @param {(ok: boolean) => void} [o.onBoardStatus]  3-strike board-lost / board-back -> scheduler events
 * @param {(decision: object) => Promise<void>} [o.open]  the step-9-2 host opener; absent = fail closed
 * @param {(decision: object) => void} [o.logRefusal]  Electron's refusal log for a TOCTOU refusal at open time
 * @param {() => number} [o.now]
 * @param {number} [o.pollMs]            hudPollMs() for a test flavour only
 * @param {(m: string) => void} [o.log]
 */
export function createHudHost({
  getState, idleSeconds = () => 0, settings, saveSettings, emit, ownerAdmin = false, liveBoard,
  talkActive = () => false, onReaction = null, onWaiting = null, onBoardStatus = null,
  open = null, logRefusal = null, now = Date.now, pollMs = undefined, log = () => {},
}) {
  const owner = ownerAdmin === true;
  const answerState = () => {
    const st = liveBoard.status();
    return { owner, live: st.mode === 'live' && st.configured === true && st.locked === false };
  };
  // Without a host opener (a release build, or a caller that did not wire one) a "yes" must never report success it
  // did not perform.
  const openHost = typeof open === 'function'
    ? open
    : async () => { throw new Error('open_unavailable'); };

  const host = createElectronHudHost({
    getState,
    idleSeconds,
    settings: { get: settings, set: saveSettings },
    send: (payload) => { emit('hud:feed', payload); },
    decide: (ref) => decideOpenRef(ref, { ownerAdmin: owner }),
    open: (decision) => openHost(decision),
    getAnswerState: answerState,
    talkActive,
    onReaction,
    onWaiting,
    onBoardStatus,
    now,
    log: (m) => log(`[hud] ${m}`),
    ...(pollMs ? { pollMs, cooldownMs: pollMs } : {}),
  });

  const answerer = owner && liveBoard && typeof liveBoard.relay === 'function'
    ? createAskAnswerer({
      relay: (op, body) => liveBoard.relay(op, body),
      ownerAdmin: true,
      boardStatus: () => liveBoard.status(),
      log: (m) => log(`[hud] ${m}`),
    })
    : null;

  const handlers = {
    // main.js:1436/1437. The preview always has a host, so Electron's "not ready" defaults never apply.
    'hud.getPrefs': () => host.prefs(),
    'hud.setPrefs': (p) => host.setPrefs(p),
    // main.js:1438: the renderer's "I am listening" signal starts the poll (only when a style is on or a talk level).
    'hud.ready': () => { host.start(); return true; },
    // main.js:1489-1497: an offer id, never a path/URL. A refusal at answer time is logged like Electron's.
    'hud.answer': async (id, yes) => {
      try {
        const r = await host.answer(id, yes);
        if (r.decision && r.decision.action === 'refuse') {
          log(`[hud] open refused ${r.decision.reason || 'refused'}`);
          if (typeof logRefusal === 'function') { try { logRefusal(r.decision); } catch { /* logging never changes the verdict */ } }
        }
        return { opened: r.opened === true, reason: r.reason || null };
      } catch (e) {
        log(`[hud] answer ${String(id)} could not open: ${(e && e.message) || e}`);
        return { opened: false, reason: 'open_unavailable' };
      }
    },
    // main.js:1499-1505: owner-only inline answer, then one forced fresh read so the feed shows server truth.
    'hud.answerAsk': async (payload) => {
      if (!answerer) return { ok: false, reason: 'not_owner_build' };
      const r = await answerer.answer(payload || {});
      if (r.ok) { try { await host.poll({ maxAgeMs: 0 }); } catch { /* the periodic poll will catch up */ } }
      return r;
    },
  };

  return {
    handlers,
    start: () => host.start(),
    stop: () => host.stop(),
    poll: (o) => host.poll(o),
    prefs: () => host.prefs(),
    answerState,
    dispose: () => { try { host.stop(); } catch { /* best effort */ } },
    _host: host,
  };
}
