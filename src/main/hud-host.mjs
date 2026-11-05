// HUD host (T-31 hud-react, 13-10; talk-mode rewiring 19-10): main-process glue for the talk-camera HUD. Polls the
// board through the SAME board reader chat uses (bridge, else the owner build's loopback mirror; never a new
// connection), turns it into the HUD feed (hud-feed.mjs), and sends the renderer one 'hud:feed' message per read:
//   { style, feed: {updates, waiting, waitingCount}, reaction: null | { taskIds, primary, source, state, title, step,
//     doneStep, stepChanged, batchCount, askKey, consent }, answer }
//
// talk-mode rewiring (PLAN sections 2, 6, 7): the host no longer owns the voice decision (the old createVoiceGate is
// gone -- "how much Zumi talks" is the speech-scheduler's job, main.js). It now does exactly two extra things:
//   - the poll runs while HUD style != Off OR talkActive() (a talk level is on), so the scheduler still sees board
//     changes when the HUD is hidden; 'hud:feed' is only sent when a style is on (one poll, one reader);
//   - each reaction is handed to main via onReaction(r); a board read failure is reported via onBoardStatus(ok)
//     (3 failed reads in a row = board-lost, the first good read after that = board-back).
// The host keeps lastStepLabel[taskId] (the PREVIOUS poll's current-step label), because the board's current_step
// never reports 'done' -- the scheduler's step.done line needs the label of the step that just finished.
import { buildHudFeed, createUpdateTracker, createBurstBatcher, createConsentGate, hudPrefs, pickAcceptanceRef, HUD_STYLES } from './hud-feed.mjs';

export const POLL_MS = 20_000;
const BOARD_LOST_STRIKES = 3; // 3 failed reads in a row (60 s at 20 s polling) -> board-lost

/**
 * @param {object} o
 * @param {() => Promise<{ok:boolean, state?:object, reason?:string}>} o.getState   board-reader.mjs getState
 * @param {() => number} o.idleSeconds      powerMonitor.getSystemIdleTime
 * @param {{ get(): object, set(patch: object): void }} o.settings
 * @param {(payload: object) => void} o.send  -> renderer 'hud:feed'
 * @param {(ref: object) => object} o.decide  board-open.mjs decideOpenRef bound to this build's ownerAdmin flag
 * @param {(decision: object) => Promise<void>|void} o.open  shell.openPath / shell.openExternal
 * @param {() => { owner: boolean, live: boolean }} [o.getAnswerState]
 * @param {() => boolean} [o.talkActive]    true while the talk level != Off (main.js): poll even with the HUD hidden
 * @param {(r: object) => void} [o.onReaction]  a reaction to speak/subtitle (main maps it into the scheduler)
 * @param {(ok: boolean) => void} [o.onBoardStatus]  3-strike board-lost / board-back
 * @param {(n: number) => void} [o.onWaiting]  the board's waiting-ask count after every good read (the scheduler's morning/check-in lines)
 * @param {(state: object) => Promise<unknown>|unknown} [o.onState]  T-31 alpha.12: every good read's raw state, before the
 *   feed goes out (agent-core.mjs: rhythm owner signals + the read-only watcher rule pass)
 * @param {() => object[]} [o.watchFeed]  T-31 alpha.12: the watcher's open findings, sent as 'hud:feed' `watch`
 */
export function createHudHost({ getState, idleSeconds, settings, send: sendRaw, decide, open, now = Date.now, log = () => {}, pollMs = POLL_MS, cooldownMs = 30_000, getAnswerState = () => ({ owner: false, live: false }), talkActive = () => false, onReaction = null, onBoardStatus = null, onWaiting = null, onState = null, watchFeed = null }) {
  // Every 'hud:feed' carries the watcher's card list when a watcher is wired (alpha.12); without one the payload is unchanged.
  const send = (payload) => {
    if (typeof watchFeed !== 'function') return sendRaw(payload);
    let watch = [];
    try { watch = watchFeed() || []; } catch (e) { log(`watchFeed failed: ${(e && e.message) || e}`); }
    return sendRaw({ ...payload, watch });
  };
  const tracker = createUpdateTracker();
  const batcher = createBurstBatcher({ cooldownMs });
  const consent = createConsentGate({ decide, open, now });
  let timer = null;
  let lastFeed = null;
  let busy = null;
  let doneSince = new Set(); // tasks whose done-step count rose since the last reaction (consumed by it)
  const stepSeen = Object.create(null); // taskId -> { id, label } from the PREVIOUS poll (done-step label + progress)
  let lastStepLabel = Object.create(null); // taskId -> the previous current-step label (exposed to tests)
  let lastStepId = Object.create(null); // taskId -> the previous current-step id
  let boardFails = 0;
  let boardSeenOk = false; // a good read has happened: only then can the board be "lost"

  const prefs = () => hudPrefs(settings.get());
  const answerState = () => { try { return getAnswerState() || { owner: false, live: false }; } catch { return { owner: false, live: false }; } };
  const active = () => prefs().style !== 'off' || (() => { try { return talkActive() === true; } catch { return false; } })();

  // Only a transport failure (offline / timeout / http_*) of a board that answered before is a lost board. A board that
  // was never configured, is locked, or is not live (board-reader.mjs fetchFromBridge) is simply absent: no strike,
  // and Zumi must never claim she "can't reach" a board the user does not have.
  const isTransportFailure = (reason) => reason === 'offline' || reason === 'timeout' || /^http_/.test(String(reason || ''));
  function boardStrike(reason) {
    if (!isTransportFailure(reason) || !boardSeenOk) { if (boardFails < BOARD_LOST_STRIKES) boardFails = 0; return; }
    boardFails++;
    if (boardFails === BOARD_LOST_STRIKES && onBoardStatus) { try { onBoardStatus(false); } catch (e) { log(`onBoardStatus failed: ${(e && e.message) || e}`); } }
  }
  function boardOk() {
    boardSeenOk = true;
    if (boardFails >= BOARD_LOST_STRIKES && onBoardStatus) { try { onBoardStatus(true); } catch (e) { log(`onBoardStatus failed: ${(e && e.message) || e}`); } }
    boardFails = 0;
  }

  function reactionFor(taskIds, allowConsent) {
    const items = [...lastFeed.waiting.filter((w) => taskIds.includes(w.taskId)), ...lastFeed.updates.filter((u) => taskIds.includes(u.id))];
    let offer = null;
    if (allowConsent) for (const it of items) {
      const ref = pickAcceptanceRef(it.refs || [], consent.isOpenable);
      if (ref) { offer = consent.offer(ref, { taskId: it.taskId || it.id }); break; }
    }
    // The reaction's focus: the most recently active changed item; a task that just finished a step wins outright.
    // The same-task tie window as before (T-31 fix round 1610 r3) is kept unchanged.
    const TIE_MS = 1000;
    const cand = [
      ...lastFeed.updates.filter((u) => taskIds.includes(u.id)).map((u) => ({ id: u.id, source: 'updates', state: u.stepState || '', at: Date.parse(u.at || '') || 0, step: u.step || '', stepId: u.stepId || '', title: u.title || '' })),
      ...lastFeed.waiting.filter((w) => taskIds.includes(w.taskId)).map((w) => ({ id: w.taskId, source: 'waiting', state: 'waiting', at: Date.parse(w.since || '') || 0, step: w.step || '', stepId: '', title: w.title || '' })),
    ].sort((a, b) => b.at - a.at);
    const doneHit = cand.find((c) => doneSince.has(c.id)) || null;
    const top = cand.length ? cand[0].at : -Infinity;
    const near = cand.filter((c) => top - c.at <= TIE_MS && c.id === cand[0].id);
    const focus = doneHit || near.find((c) => c.source === 'waiting') || cand[0] || null;
    doneSince = new Set(); // consumed by this reaction
    const primary = focus ? focus.id : null;
    const source = focus ? focus.source : null;
    const state = doneHit ? 'done' : (focus ? focus.state : '');
    const wait = focus && focus.source === 'waiting' ? lastFeed.waiting.find((w) => w.taskId === focus.id) : null;
    const detail = `reaction tasks=${taskIds.join(',')} primary=${primary || '-'} source=${source || '-'} state=${state || '-'} offer=${offer ? offer.kind : 'none'}`;
    log(detail);
    return {
      taskIds, primary, source, state,
      title: focus ? focus.title : '',
      step: focus ? focus.step : '',
      // The PREVIOUS poll's label for this task: the label of the step that just finished (T-31 talk-mode plan 2).
      doneStep: focus && focus.source === 'updates' ? (lastStepLabel[focus.id] || '') : '',
      stepChanged: Boolean(focus && focus.source === 'updates' && lastStepId[focus.id] && lastStepId[focus.id] !== focus.stepId),
      batchCount: taskIds.length,
      askKey: wait ? wait.key : null,
      consent: offer,
    };
  }

  async function poll(opts = {}) {
    if (busy) return busy;
    busy = (async () => {
      if (!active()) return;
      const r = await getState({ maxAgeMs: opts.maxAgeMs ?? (pollMs - 1000) });
      const style = prefs().style; // read AFTER the await: a HUD switched on during this read must get its feed from it (T-31 0.2.11)
      if (!r.ok) {
        boardStrike(r.reason);
        if (style !== 'off') send({ style, feed: null, unavailable: r.reason, reaction: null, answer: answerState() });
        return;
      }
      boardOk();
      if (onState) { try { await onState(r.state); } catch (e) { log(`onState failed: ${(e && e.message) || e}`); } }
      lastFeed = buildHudFeed(r.state);
      if (onWaiting) { try { onWaiting(lastFeed.waitingCount); } catch (e) { log(`onWaiting failed: ${(e && e.message) || e}`); } }
      const { taskIds, doneIds } = tracker.ingest(lastFeed);
      for (const d of doneIds) doneSince.add(d);
      // Snapshot the PREVIOUS poll's step per task, then refresh (done-step label + progress detection).
      const prevLabel = Object.create(null);
      const prevId = Object.create(null);
      for (const u of lastFeed.updates) { const s = stepSeen[u.id]; prevLabel[u.id] = s ? s.label : ''; prevId[u.id] = s ? s.id : ''; }
      lastStepLabel = prevLabel;
      lastStepId = prevId;
      for (const u of lastFeed.updates) stepSeen[u.id] = { id: u.stepId, label: u.step };
      const batch = batcher.push(taskIds, now());
      if (batch && batch.length) {
        const reaction = reactionFor(batch, style !== 'off');
        if (onReaction) { try { onReaction(reaction); } catch (e) { log(`onReaction failed: ${(e && e.message) || e}`); } }
        if (style !== 'off') send({ style, feed: { updates: lastFeed.updates, waiting: lastFeed.waiting, waitingCount: lastFeed.waitingCount }, reaction, answer: answerState() });
      } else if (style !== 'off') {
        send({ style, feed: { updates: lastFeed.updates, waiting: lastFeed.waiting, waitingCount: lastFeed.waitingCount }, reaction: null, answer: answerState() });
      }
    })().catch((e) => log(`poll failed: ${(e && e.message) || e}`)).finally(() => { busy = null; });
    return busy;
  }

  // A queued burst whose cooldown ended between two polls goes out on its own tick.
  function tick() {
    if (!active() || !lastFeed) return;
    const batch = batcher.due(now());
    if (batch && batch.length) {
      const style = prefs().style;
      const reaction = reactionFor(batch, style !== 'off');
      if (onReaction) { try { onReaction(reaction); } catch (e) { log(`onReaction failed: ${(e && e.message) || e}`); } }
      if (style !== 'off') send({ style, feed: { updates: lastFeed.updates, waiting: lastFeed.waiting, waitingCount: lastFeed.waitingCount }, reaction, answer: answerState() });
    }
  }

  function start() {
    if (timer) return;
    // one 5 s timer: a board read every pollMs, a batch-due check on the ticks in between
    let n = 0;
    const every = Math.max(1, Math.round(pollMs / 5000));
    timer = setInterval(() => { if (++n % every === 0) poll(); else tick(); }, Math.min(pollMs, 5000));
    poll();
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }

  return {
    prefs,
    setPrefs(p) {
      const cur = prefs();
      const next = { hudStyle: p && HUD_STYLES.includes(p.style) ? p.style : cur.style };
      settings.set(next);
      if (next.hudStyle === 'off' && !active()) { stop(); tracker.reset(); doneSince = new Set(); lastFeed = null; send({ style: 'off', feed: null, reaction: null, answer: answerState() }); }
      else if (cur.style === 'off') { tracker.reset(); doneSince = new Set(); if (timer) poll(); else start(); } // switched on: the first read is the baseline, no reaction; start() is a no-op while the timer runs (a talk level), so poll now (T-31 0.2.11)
      else poll(); // style A <-> B: repaint now
      return prefs();
    },
    answer: (id, yes) => consent.answer(String(id || ''), yes === true),
    start: () => { if (active()) start(); },
    stop,
    poll,
    _test: { tracker, batcher, consent, lastStepLabel: () => lastStepLabel, boardFails: () => boardFails },
  };
}
