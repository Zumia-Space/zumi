// Step times and "waiting on the owner", derived on every read from the journal's own records (J-05 times-waiting, 19-11).
// The writer never types a time: a step's created / state / asked / answered moments are the server clock at the event
// that made them, and what waits on the owner is the list of open asks. Every reader (the v1 view, the legacy ?v=2 state, the
// CoS CLI, the page) calls this module; none recomputes. Nothing here writes; a time the journal does not hold is null,
// never a guess.
import '../public/measure.js'; // globalThis.LaneMeasure.askOwnAt: the board's one ask-time rule
import { askLane } from './ops.mjs';
import { splitRefs } from './refs.mjs';

export const OWNER_TZ = 'Asia/Ho_Chi_Minh';

/** "dd-mm HH:mm" in `tz` for an ISO time; null for nothing or something that is not a time (public/measure.js, shared with the page). */
export const formatLocal = (iso, tz = OWNER_TZ) => globalThis.LaneMeasure.formatLocal(iso, tz);
/** True when `tz` is a zone this runtime knows (config validation). */
export const validTimeZone = tz => { try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); return true; } catch { return false; } };

const askAtOf = a => globalThis.LaneMeasure.askOwnAt(a);

const INACTIVE = new Set(['paused', 'closed']);
const byAskTime = (a, b) => askAtOf(a).localeCompare(askAtOf(b)) || a.id.localeCompare(b.id, 'en', { numeric: true });

/**
 * The one pass over asks, feedback and steps that every reader of "waiting on the owner" and of step stamps shares. A reader that
 * needs it for many steps or tasks builds it once per read and passes it in (a per-step scan was steps x asks, Opus gate G-PERF).
 *  - openByTask: task id -> its open asks, oldest first;
 *  - latestAsk: "TASK/step" -> the step's newest ask of any status (by the board's ask-time rule);
 *  - stepsWithoutAsk: task id -> [{ step, since }]: the owner steps that wait with no ask on them and no answer since the wait began,
 *    on a live (not paused, not closed) task. This is THE rule: the page queue, the task's waiting_on_owner and the CLI's waiting
 *    all list exactly these. A step the owner already answered is the coordinator's move, not a wait; a pause anh ordered
 *    (paused_by) is blocked, not waiting, so it never gets here.
 */
export function waitIndex(state) {
  const openByTask = new Map(), latestAsk = new Map(), answeredAt = new Map(), covered = new Set();
  const noteAnswer = (key, at) => { if (!(answeredAt.get(key) >= at)) answeredAt.set(key, at); };
  for (const a of Object.values(state.asks || {})) {
    const key = a.step_id ? `${a.task_id}/${a.step_id}` : '';
    if (a.status === 'open') { (openByTask.get(a.task_id) ?? openByTask.set(a.task_id, []).get(a.task_id)).push(a); if (key) covered.add(key); }
    if (!key) continue;
    const cur = latestAsk.get(key);
    if (!cur || byAskTime(cur, a) < 0) latestAsk.set(key, a);
    if (a.status === 'answered') noteAnswer(key, a.answer.at);
  }
  for (const list of openByTask.values()) list.sort(byAskTime);
  for (const i of Object.values(state.inbox || {})) if (i.kind === 'ask' && !i.resolution && i.step_id) covered.add(`${i.task_id}/${i.step_id}`); // a proposal answers for its step too
  for (const f of Object.values(state.feedback || {})) {
    if (f.step_id && ['choice', 'approve', 'reject', 'redirect'].includes(f.kind) && f.attribution.created_by.role === 'owner') noteAnswer(`${f.task_id}/${f.step_id}`, f.attribution.created_at);
  }
  const stepsWithoutAsk = new Map();
  for (const t of Object.values(state.tasks || {})) {
    if (INACTIVE.has(t.status)) continue;
    for (const id of t.step_ids || []) {
      const s = state.steps[`${t.id}/${id}`];
      if (!s || s.state !== 'waiting' || s.zone !== 'owner' || covered.has(s.id)) continue;
      const since = state.times?.[s.id]?.waiting_since || s.attribution.updated_at;
      if (answeredAt.get(s.id) >= since) continue;
      (stepsWithoutAsk.get(t.id) ?? stepsWithoutAsk.set(t.id, []).get(t.id)).push({ step: s, since });
    }
  }
  return { openByTask, latestAsk, stepsWithoutAsk };
}

/**
 * { created_at, state_at, asked_at, answered_at } of the step `key` ("TASK/step"), ISO UTC or null.
 *  - created_at: the step's first appearance (the imported timing history keeps the original; else its create event);
 *  - state_at: its last state change (the last recorded transition, else the stamp the write left);
 *  - asked_at: when its latest ask was asked (the board's ask-time rule: an imported ask keeps the time its source recorded);
 *  - answered_at: when the owner answered that ask; null while it is open or once it was only cleared.
 * `idx` = waitIndex(state), built once per read by a caller that asks for many steps.
 */
export function stepStamps(state, key, idx = waitIndex(state)) {
  const s = state.steps?.[key], rec = state.times?.[key];
  if (!s) return { created_at: null, state_at: null, asked_at: null, answered_at: null };
  const latest = idx.latestAsk.get(key);
  const sameState = rec && rec.last_state === s.state;
  return {
    created_at: rec?.first_seen_at || s.attribution?.created_at || null,
    // the timing record is the better evidence: its last transition, else the moment it was first seen in this state (an imported history
    // keeps its original times); the step's own stamp only when no record exists
    state_at: (sameState ? rec.transitions?.at(-1)?.at || rec.first_seen_at : s.state_at) || s.state_at || null,
    asked_at: latest ? askAtOf(latest) : null,
    answered_at: latest?.status === 'answered' ? latest.answer?.at || null : null
  };
}
/** The same four moments as dd-mm HH:mm in the owner's zone. */
export const stampsLocal = (stamps, tz = OWNER_TZ) => ({ created: formatLocal(stamps.created_at, tz), state: formatLocal(stamps.state_at, tz), asked: formatLocal(stamps.asked_at, tz), answered: formatLocal(stamps.answered_at, tz) });

/**
 * What waits on the owner in one task, from waitIndex: its open asks (the text is the ask's own, its age counts from asked_at), oldest
 * first, and `steps_without_ask`: the owner steps that wait with no ask on them, which the owner cannot see, so the writer must raise
 * the ask or move the step. The page queue (attention.waiting) lists the same steps, from the same index.
 */
export function ownerWaiting(state, taskId, nowMs, tz = OWNER_TZ, idx = waitIndex(state)) {
  const asks = (idx.openByTask.get(taskId) || [])
    .map(a => ({ ask_id: a.id, step_id: a.step_id || '', lane: askLane(state, a), text: splitRefs(a.text).text, asked_at: askAtOf(a) }))
    .map(a => ({ ...a, asked_local: formatLocal(a.asked_at, tz), age_min: Math.max(0, Math.floor((nowMs - Date.parse(a.asked_at)) / 60000)) }));
  return { asks, steps_without_ask: (idx.stepsWithoutAsk.get(taskId) || []).map(w => w.step.id.slice(taskId.length + 1)) };
}

/** Steps of one phase in time order: earliest created first, a step with no known time last, the board's order breaks ties. A copy. */
export const timeOrder = steps => globalThis.LaneMeasure.timeOrder(steps);

// ---- lint: a time typed into now / next / sub (the lanes' habit, "16-11 ·", "19:13Z") is a second, wrong clock ----
const RUN_STAMP = /\brun:[^\s@]+@\S+/g; // a dispatcher's own run stamp is machine data, not a typed time
const DATE_RE = /(?<![\d-])(?:0[1-9]|[12]\d|3[01])-(?:0[1-9]|1[0-2])(?![\d-])/g;
const CLOCK_RE = /(?<![\d:])(?:[01]?\d|2[0-3])[:h][0-5]\d\s?Z\b/g;
export const LINT_MESSAGE = 'step and task times are automatic (created_at, state_at, asked_at on the board): remove the date/time from the text; local time is shown for you';
/** [{ task, field, step?, found, message }] for every typed date (dd-mm) or UTC time (HH:MMZ) in the row's now, next and step subs. */
export function lintFreeTimes(row) {
  const out = [];
  const scan = (field, text, step) => {
    const plain = String(text ?? '').replace(RUN_STAMP, ' ');
    for (const re of [DATE_RE, CLOCK_RE]) for (const m of plain.matchAll(re)) out.push({ task: row.code, field, ...(step ? { step } : {}), found: m[0].replace(/\s/g, ''), message: LINT_MESSAGE });
  };
  scan('now', row.now); scan('next', row.next);
  // the date inside anh's quoted pause is the pause itself (a pause field on the step), not a time a writer typed
  for (const s of row.steps || []) if (!s.pausedBy) scan('sub', s.sub, s.id);
  return out.slice(0, 40);
}
