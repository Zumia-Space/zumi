// Read models derived from structured records on every read. Nothing here is typed by a person or an
// agent as a summary: the owner-attention block is built from open asks, open ask proposals in the
// inbox and steps waiting in the 'owner' zone; the stalled block is built from server timestamps only.
import { currentStep } from './rules.mjs';
import { resolveRoles } from './roles.mjs';
import { resolveMachines, withSlotMachines } from './machines.mjs';
import { latestTurns } from './turns.mjs';
import '../public/measure.js'; // sets globalThis.LaneMeasure (one copy for the server and the page)

const { measuredTimes: measure, askSince } = globalThis.LaneMeasure;

const INACTIVE = new Set(['paused', 'closed']);
/** An owner answer the coordinator has not acknowledged with a receipt ("Nhận") comes back to the owner after this. */
export const RECEIPT_MS = 3 * 3600000;
const ANSWER_KINDS = new Set(['note', 'approve', 'reject', 'choice', 'redirect']);
/** The ask an owner message answers: the one it was scoped to (unless it asked back), the one an ask.answer linked, or
 *  the first one its write closed. */
const answeredAskOf = f => f.answers_asks?.[0] || (f.kind !== 'askback' ? f.ask_id || f.scope_ask_id : '') || '';
/** An owner message the coordinator owes a receipt for: it answered an ask, or it is a change of direction. */
const needsReceipt = f => f.attribution.created_by.role === 'owner' && ANSWER_KINDS.has(f.kind) && (!!answeredAskOf(f) || f.kind === 'redirect');

/** Every feedback record as one message: task, scope (step / ask), kind, author, body, time, the ask it answers, the
 *  message it replies to, and the coordinator's receipt. Derived on every read from the stored records, so nothing was
 *  migrated or rewritten (and a board one release older reads the same data dir). */
export function messagesView(state) {
  return Object.values(state.feedback).map(f => ({
    id: f.id, task_id: f.task_id, scope: { ...(f.step_id ? { step_id: f.step_id } : {}), ...(f.scope_ask_id || f.ask_id ? { ask_id: f.scope_ask_id || f.ask_id } : {}), ...(f.plan_id ? { plan_id: f.plan_id } : {}) },
    kind: f.kind, author: who(f.attribution.created_by), body: f.text || '', ts: f.attribution.created_at, ...(f.info ? { info: true } : {}),
    answers_ask_id: answeredAskOf(f) || null, ...(f.reply_to ? { reply_to: f.reply_to } : {}), ...(f.receipt ? { receipt: f.receipt } : {}),
    // pasted images: served behind the board's own auth (owner, coordinator), never a public URL
    ...(f.attachments?.length ? { attachments: f.attachments.map(id => ({ id, name: state.attachments[id]?.name || id, mime: state.attachments[id]?.mime || '', url: `api/v1/media/${id}` })) } : {}),
    status: f.status, ...(f.received ? { received: { at: f.received.at, by: f.received.by.name, receipt_id: f.received.receipt_id } } : {}),
    needs_receipt: needsReceipt(f) && !f.received && f.status === 'open'
  })).sort((a, b) => a.ts.localeCompare(b.ts) || a.id.localeCompare(b.id, 'en', { numeric: true }));
}

/** The original time of a record imported from a predecessor board (its request origin "legacy <by> <time>"), or
 *  undefined. Display only: the server's own timestamps stay as they are. */
export function originTime(actor) {
  const m = /^legacy \S+ (\d{4}-\d\d-\d\dT[\d:.]+Z)$/.exec(actor?.origin || '');
  return m ? m[1] : undefined;
}

/** state.route_override as a reader sees it: the stored entry plus `expired`, derived from the server clock on every
 *  read. The record itself stays stored after its expiry; only a non-expired entry is permission to use Sonnet. */
export function routeOverrideView(state, nowMs) {
  const out = {};
  for (const [code, o] of Object.entries(state.route_override || {})) out[code] = { ...o, expired: !(Date.parse(o.expires) > nowMs) };
  return out;
}

/** coordinator / worker_machines / machines_by of one task, the defaults applied when nothing is stored. */
const machineFields = entry => { const m = resolveMachines(entry); return { coordinator: m.coordinator, worker_machines: m.worker_machines, machines_by: m.by }; };

export function effectiveWorker(task, routing, roles) {
  const o = routing[task.id];
  if (o) return { model: o.model, effort: o.effort, by: 'owner', at: originTime(o.set_by) || o.set_at, ...(task.worker?.reason ? { reason: task.worker.reason } : {}) };
  const auto = roles?.[task.id]?.code; // auto-escalation bump (ADR 2026-10-09): wins over the coordinator's seed, never over the owner
  if (auto) return { model: auto.model, effort: auto.effort, by: 'auto', at: auto.at, reason: auto.reason };
  return task.worker ? { ...task.worker, by: 'coordinator' } : null;
}

const who = actor => ({ name: actor.name, role: actor.role, ...(actor.lane ? { lane: actor.lane } : {}), ...(actor.model ? { model: actor.model } : {}), ...(actor.origin ? { origin: actor.origin } : {}) });

/** Every owner-zone step that is waiting on the owner right now, with the time its wait began, covered by an ask or not.
 *  A step whose ask the owner already answered during this wait — or on which the owner recorded a choice, approval or
 *  rejection — is the coordinator's move, not the owner's, and is left out. */
export function ownerStepWaits(state) {
  const answeredAt = new Map();
  const noteAnswer = (key, at) => { if (!(answeredAt.get(key) >= at)) answeredAt.set(key, at); };
  for (const a of Object.values(state.asks)) if (a.status === 'answered' && a.step_id) noteAnswer(`${a.task_id}/${a.step_id}`, a.answer.at);
  for (const f of Object.values(state.feedback)) {
    if (f.step_id && ['choice', 'approve', 'reject', 'redirect'].includes(f.kind) && f.attribution.created_by.role === 'owner') noteAnswer(`${f.task_id}/${f.step_id}`, f.attribution.created_at);
  }
  const waits = [];
  for (const s of Object.values(state.steps)) {
    if (s.state !== 'waiting' || s.zone !== 'owner') continue;
    const since = state.times[s.id]?.waiting_since || s.attribution.updated_at;
    if (!(answeredAt.get(s.id) >= since)) waits.push({ step: s, since });
  }
  return waits;
}

/** Owner attention: every open, owner-actionable item across all lanes, oldest first. */
export function ownerAttention(state, nowMs) {
  const messages = messagesView(state); // the owner's replies: a re-asked question keeps its age only until the owner replies (measure.js askSince)
  const live = id => state.tasks[id] && !INACTIVE.has(state.tasks[id].status);
  const waiting = [];
  const covered = new Set(); // task/step pairs already represented by an ask or proposal
  for (const a of Object.values(state.asks)) {
    if (a.status !== 'open' || !live(a.task_id)) continue;
    waiting.push({ kind: 'ask', id: a.id, task_id: a.task_id, step_id: a.step_id, ...(a.lane ? { lane: a.lane } : {}), text: a.text, options: a.options || [], rev: a.rev, from: who(a.attribution.created_by), since: askSince(a, Object.values(state.asks), messages, state.times), ...(a.asked_back ? { asked_back_at: a.asked_back.at } : {}) });
    if (a.step_id) covered.add(`${a.task_id}/${a.step_id}`);
  }
  for (const i of Object.values(state.inbox)) {
    if (i.kind !== 'ask' || i.resolution || !live(i.task_id)) continue;
    waiting.push({ kind: 'proposal', id: i.id, task_id: i.task_id, step_id: i.step_id, text: i.text, options: i.options || [], rev: i.rev, from: who(i.attribution.created_by), since: i.attribution.created_at });
    if (i.step_id) covered.add(`${i.task_id}/${i.step_id}`);
  }
  for (const { step: s, since } of ownerStepWaits(state)) {
    if (!live(s.task_id) || covered.has(s.id)) continue;
    waiting.push({ kind: 'step', id: s.id, task_id: s.task_id, step_id: s.id.split('/')[1], text: s.label, options: [], rev: s.rev, from: who(s.attribution.updated_by), since });
  }
  // The owner answered, the coordinator has not picked it up (no receipt, not resolved) for RECEIPT_MS: back to the owner,
  // so an answer or a change of direction cannot vanish unread.
  for (const f of Object.values(state.feedback)) {
    if (!needsReceipt(f) || f.received || f.status !== 'open' || !live(f.task_id)) continue;
    if (nowMs - Date.parse(f.attribution.created_at) < RECEIPT_MS) continue;
    waiting.push({ kind: 'unreceived', id: f.id, task_id: f.task_id, step_id: f.step_id, text: f.text || '', options: [], rev: f.rev, from: who(f.attribution.created_by), since: f.attribution.created_at, message_kind: f.kind, ...(answeredAskOf(f) ? { ask_id: answeredAskOf(f) } : {}) });
  }
  waiting.sort((a, b) => a.since.localeCompare(b.since));
  for (const w of waiting) w.age_ms = Math.max(0, nowMs - Date.parse(w.since));
  const dayAgo = nowMs - 86400000;
  const answered = Object.values(state.asks)
    .filter(a => a.status === 'answered' && Date.parse(a.answer.at) >= dayAgo)
    .map(a => {
      const f = a.answer.feedback_id ? state.feedback[a.answer.feedback_id] : Object.values(state.feedback).find(x => x.ask_id === a.id);
      return { id: a.id, task_id: a.task_id, text: a.text, choice: a.answer.choice, answer_text: a.answer.text, at: a.answer.at, ...(a.answer.kind ? { kind: a.answer.kind } : {}),
        ...(f ? { feedback_id: f.id } : {}), ...(f?.received ? { received_at: f.received.at, next: state.feedback[f.received.receipt_id]?.receipt?.next || '' } : f && f.status !== 'open' ? { handled_at: f.resolved?.at || '' } : {}) };
    })
    .sort((a, b) => b.at.localeCompare(a.at));
  return { waiting, answered };
}

/** Board-wide status freshness (op freshness.set): stale_h 0 = the age rule is off; auto_request = the hourly sweep files status requests. */
export const FRESHNESS_DEFAULTS = { stale_h: 24, auto_request: true };
/**
 * The sweep's quiet rules (they only withhold the board's own request; the stale badge is unaffected):
 * no request while a lane or the coordinator wrote to the task in the last SWEEP_QUIET_MS, none between
 * 23:00 and 07:00 Asia/Ho_Chi_Minh (UTC+7, no DST), and (J-05) none for a row whose only open work waits on the
 * owner after a push in the last SWEEP_OWNER_ONLY_MS. A request due in a quiet window is dropped, not queued.
 */
export const SWEEP_QUIET_MS = 3600000;
/** A row that only waits on the owner is left alone this long after its last push, then asked again to chase it. */
export const SWEEP_OWNER_ONLY_MS = 24 * 3600000;
export const sweepNight = ms => { const h = Math.floor(ms / 3600000 + 7) % 24; return h >= 23 || h < 7; };
/** A step the owner must move: it waits in the owner zone, or an open ask sits on it. (Legacy pushes spell the owner
 *  zone 'anh'; adapt-legacy maps it to 'owner' before it is stored.) */
const ownerPending = (state, s) => (s.state === 'waiting' && s.zone === 'owner')
  || Object.values(state.asks || {}).some(a => a.status === 'open' && a.task_id === s.task_id && a.step_id === s.id.split('/')[1]);
/** True when the task still has open work and every open step waits on the owner (a waiting owner step, or an open ask
 *  on it). A task with no open step is not owner-only: the sweep still asks it (unchanged). */
export const onlyOwnerPending = (state, task) => {
  const open = task.step_ids.map(id => state.steps[`${task.id}/${id}`]).filter(s => s && s.state !== 'done');
  return open.length > 0 && open.every(s => ownerPending(state, s));
};
/** True when the sweep should leave this task alone: parked/finished, grey, written to a moment ago, or (J-05) only
 *  waiting on the owner after a push in the last SWEEP_OWNER_ONLY_MS. */
export const sweepSkips = (state, task, nowMs) => {
  if (INACTIVE.has(task.status) || task.health === 'grey') return true;
  const idleMs = nowMs - Date.parse(state.activity[task.id] || '1970-01-01T00:00:00Z');
  return idleMs < SWEEP_QUIET_MS || (idleMs < SWEEP_OWNER_ONLY_MS && onlyOwnerPending(state, task));
};
/** A step written within this long after the Now/Next text is the same push (the compat layer writes text, then steps). */
const SAME_PUSH_MS = 60000;
/** The open "update your status" request on a task: a rebrief in mode status that no Now/Next change has closed. */
export const openStatusRequest = (state, taskId) => Object.values(state.feedback).find(f => f.task_id === taskId && f.kind === 'rebrief' && f.mode === 'status' && f.status === 'open') || null;
/**
 * Tasks whose Now/Next text is behind their steps: a step changed state after the text last changed
 * ('steps_newer'), or an open task's text is older than stale_h hours ('age'). Pure; times are server stamps.
 * Records written before the stamps existed fall back to their last touch.
 */
export function staleText(state, nowMs, freshness) {
  const { stale_h } = { ...FRESHNESS_DEFAULTS, ...freshness };
  const out = [];
  for (const t of Object.values(state.tasks)) {
    if (INACTIVE.has(t.status)) continue;
    const steps = t.step_ids.map(id => state.steps[`${t.id}/${id}`]);
    if (steps.length && steps.every(s => s.state === 'done')) continue;
    const text_at = t.text_at ?? t.attribution.updated_at;
    const step_at = steps.map(s => s.state_at ?? s.attribution.updated_at).sort().at(-1);
    if (step_at && Date.parse(step_at) - Date.parse(text_at) > SAME_PUSH_MS) out.push({ task_id: t.id, reason: 'steps_newer', text_at, step_at });
    else if (stale_h && nowMs - Date.parse(text_at) > stale_h * 3600000) out.push({ task_id: t.id, reason: 'age', text_at, step_at: step_at || null });
  }
  return out;
}

/** Stalled: live, unfinished tasks whose last accepted event is older than stallMs (server clock). */
export function stalled(state, nowMs, stallMs) {
  const out = [];
  for (const t of Object.values(state.tasks)) {
    if (INACTIVE.has(t.status)) continue;
    const steps = t.step_ids.map(id => state.steps[`${t.id}/${id}`]);
    if (steps.length && steps.every(s => s.state === 'done')) continue;
    const last = state.activity[t.id];
    const idle = nowMs - Date.parse(last);
    if (idle > stallMs) out.push({ task_id: t.id, lane: t.lane, last_at: last, idle_ms: idle });
  }
  return out.sort((a, b) => b.idle_ms - a.idle_ms);
}

/**
 * Measured time of one task from server timestamps (public/measure.js, shared with the page): work = end - start -
 * waiting on the owner, where end is the moment every current step was done (now while any step is open) and waiting
 * on the owner is the time at least one step in zone 'owner' waited, inside [start, end]. The predecessor board summed
 * the waits of every step of any zone: F-04 (10-10) showed "worked 1 s, waited on owner 18 d" over 10 days.
 * null until some step has started.
 */
/** The archived steps of one task as read metadata, oldest archived first (the archive's own order). The full records stay
 *  in the projection; `detail` is not copied here, the history step's list names each one. */
export function archivedSteps(state, taskId) {
  const ar = state.archive?.[taskId];
  if (!ar) return [];
  return ar.order.map(id => ar.steps?.[id]).filter(Boolean).map(s => ({
    id: s.id.includes('/') ? s.id.slice(s.id.indexOf('/') + 1) : s.id, label: s.label, ...(s.sub ? { sub: s.sub } : {}), zone: s.zone, state: s.state,
    done_at: state.times?.[s.id]?.done_at || s.state_at || s.attribution?.updated_at || null
  }));
}

export function measuredTimes(state, taskId, nowMs) {
  // Step order is the live steps, then the archive in its own order (GATE J-05 condition 5). The archived records keep
  // their zone, so measured work/wait is byte-identical to the same task before a compaction.
  const live = (state.tasks[taskId]?.step_ids || []).map(id => ({ ...state.steps[`${taskId}/${id}`], id: `${taskId}/${id}` }));
  const archived = (state.archive?.[taskId]?.order || []).map(id => state.archive[taskId].steps?.[id]).filter(Boolean)
    .map(s => ({ ...s, id: s.id.includes('/') ? s.id : `${taskId}/${s.id}` }));
  return measure({ times: state.times, taskTimes: state.task_times, steps: [...live, ...archived], taskId, nowMs });
}

export const SIGNAL_TYPES = ['feedback', 'answer', 'ask'];
/** Every signal type a stream may ask for; `turn` (a lane finished a turn) is opt-in, so the default stream is what it always was. */
export const STREAM_TYPES = [...SIGNAL_TYPES, 'turn'];
export const NOTIFY_DEFAULTS = { coordinator_feedback: true, delivery: 'watch', webhook_url: '' };

/** One journal event as an owner signal for coordinators, or null: owner feedback, owner answers, new asks. */
export function ownerSignal(state, ev) {
  const base = { event_id: ev.id, seq: ev.seq, at: ev.at, by: ev.actor.name };
  const step = s => (s ? { step_id: s } : {});
  if (ev.op === 'feedback.add' && ev.actor.role === 'owner') {
    return { ...base, type: 'feedback', id: ev.result.id, task_id: ev.target_id, ...step(ev.data.step_id), kind: ev.data.kind, text: ev.data.text };
  }
  if (ev.op === 'ask.answer') {
    const a = state.asks[ev.target_id];
    return { ...base, type: 'answer', id: ev.target_id, task_id: a?.task_id, ...step(a?.step_id), question: a?.text, ...pick(ev.data, ['choice', 'text']) };
  }
  if (ev.op === 'ask.raise') return { ...base, type: 'ask', id: ev.result.id, task_id: ev.target_id, ...step(ev.data.step_id), text: ev.data.text };
  // Goal locks and re-brief requests are owner feedback the coordinator must act on (they write a feedback record).
  if (ev.op === 'goal.lock') return { ...base, type: 'feedback', id: `fb-${ev.seq}`, task_id: ev.target_id, kind: 'goal-lock', text: `goal locked v${ev.result.revision}` };
  if (ev.op === 'rebrief.request') return { ...base, type: 'feedback', id: ev.result.id, task_id: ev.target_id, kind: 'rebrief', mode: ev.data.mode || 'strategy', text: ev.data.note || '' };
  if (ev.op === 'turn.report') return { ...base, type: 'turn', id: ev.result.id, lane: ev.data.lane, line: ev.data.quick.line };
  if (ev.op === 'inbox.submit' && ev.data.kind === 'ask') return { ...base, type: 'ask', proposal: true, id: ev.result.id, task_id: ev.target_id, ...step(ev.data.step_id), text: ev.data.text };
  return null;
}
const pick = (o, keys) => Object.fromEntries(keys.filter(k => o[k] !== undefined).map(k => [k, o[k]]));

/** Notification settings as a role may see them: the owner gets everything, the coordinator only the mode. */
function notifyView(state, actor, webhookStatus) {
  const n = { ...NOTIFY_DEFAULTS, ...state.notify };
  if (actor.role === 'owner') return { ...n, ...(webhookStatus ? { last_delivery: webhookStatus } : {}) };
  if (actor.role === 'coordinator') return { coordinator_feedback: n.coordinator_feedback, delivery: n.delivery };
  return undefined;
}

/** A token holder's own display prefs, without bookkeeping fields; {} when never set. */
function prefsOf(state, tokenId) {
  const { token_id, updated_at, ...p } = state.prefs?.[tokenId] || {};
  return p;
}

export function publicToken(t) {
  const { sha256, ...rest } = t;
  return rest;
}

/** True when `actor` may touch `taskId`: every role but a reporter, and a reporter whose scope_tasks names the task or '*'. */
export const inScope = (actor, taskId) => actor.role !== 'reporter' || actor.scope_tasks.includes('*') || actor.scope_tasks.includes(taskId);

/**
 * The state a scoped reporter may read: only the records of its scope_tasks. Every derived block (attention, stalled,
 * messages, stale_text) is then built from this copy by the same code as for any other role, so nothing can leak
 * through a view that forgot to filter. Board-wide notes (summary) are dropped; the registry keeps its scoped entries.
 */
function scopedState(state, actor) {
  const ok = id => inScope(actor, id);
  const byTask = rec => Object.fromEntries(Object.entries(rec || {}).filter(([k]) => ok(k)));
  const byTaskField = rec => Object.fromEntries(Object.entries(rec || {}).filter(([, v]) => ok(v.task_id)));
  const byKeyPrefix = rec => Object.fromEntries(Object.entries(rec || {}).filter(([k]) => ok(k.split('/')[0])));
  const registry = state.docs?.registry;
  return {
    ...state,
    tasks: byTask(state.tasks), steps: byKeyPrefix(state.steps), archive: byTask(state.archive), times: byKeyPrefix(state.times), task_times: byTask(state.task_times),
    asks: byTaskField(state.asks), inbox: byTaskField(state.inbox), feedback: byTaskField(state.feedback), attachments: byTaskField(state.attachments),
    routing: byTask(state.routing), roles: byTask(state.roles), route_override: byTask(state.route_override), machines: byTask(state.machines), pins: byTask(state.pins), gate_fails: byTask(state.gate_fails), activity: byTask(state.activity),
    goals: byTask(state.goals), plans: byTask(state.plans),
    pings: (state.pings || []).filter(p => p.task_id && ok(p.task_id)),
    docs: registry ? { registry: { ...registry, entries: (registry.entries || []).filter(e => e.code && ok(e.code)) } } : {}
  };
}

/** Full board view for authenticated readers; anonymous readers get only records marked public. A scoped reporter reads only its own tasks. */
export function boardView(fullState, { actor, nowMs, stallMs, config, webhookStatus, watcherAt = '', roleSlots = true, turns = false, archived = false }) {
  const state = actor?.role === 'reporter' && !actor.scope_tasks.includes('*') ? scopedState(fullState, actor) : fullState;
  const tasksAll = Object.values(state.tasks).sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || a.id.localeCompare(b.id));
  const withSteps = t => {
    const steps = t.step_ids.map(id => state.steps[`${t.id}/${id}`]);
    return {
      ...t,
      steps,
      current_step: currentStep(steps), // server-derived on every read (src/rules.mjs); clients render it as given
      last_activity_at: state.activity[t.id] || null, // last accepted event on the task, server clock
      ...(state.pins?.[t.id] ? { pinned: true, pinned_at: state.pins[t.id].pinned_at } : {}), // only once pinned: older views stay byte-identical
      worker_default: t.worker,
      worker: effectiveWorker(t, state.routing, state.roles),
      ...(roleSlots ? {
        // plan / code / review / scout, review rule applied; once a task has a machine pick each slot names its machine (J-05 worker-machine-0811)
        roles: state.machines?.[t.id] ? withSlotMachines(resolveRoles(t, state.routing, state.roles), state.machines[t.id]) : resolveRoles(t, state.routing, state.roles),
        gate_fails: state.gate_fails?.[t.id] || {},
        ...(state.machines?.[t.id] ? machineFields(state.machines[t.id]) : {}) // only once picked: older views stay byte-identical
      } : {}),
      ...(archived ? { archived_steps: archivedSteps(state, t.id) } : {}), // ?archived=1 only: default output unchanged
      measured: measuredTimes(state, t.id, nowMs)
    };
  };
  const base = { version: 1, seq: state.seq, now: new Date(nowMs).toISOString(), config };
  if (!actor) {
    const pub = tasksAll.filter(t => t.visibility === 'public');
    const ids = new Set(pub.map(t => t.id));
    return { ...base, me: null, tasks: pub.map(t => { const v = withSteps(t); delete v.attribution; v.steps = v.steps.map(({ attribution, ...s }) => s); return v; }),
      attachments: Object.values(state.attachments).filter(a => a.visibility === 'public' && ids.has(a.task_id)).map(({ attribution, ...a }) => a) };
  }
  return {
    ...base,
    me: { token_id: actor.token_id, name: actor.name, role: actor.role, label: actor.label, lane: actor.lane, model: actor.model, scope_tasks: actor.scope_tasks, prefs: prefsOf(state, actor.token_id), ...(actor.via ? { via: actor.via } : {}) },
    tasks: tasksAll.map(t => ({ ...withSteps(t), status_request: openStatusRequest(state, t.id) })),
    asks: Object.values(state.asks),
    inbox: Object.values(state.inbox),
    feedback: Object.values(state.feedback),
    messages: messagesView(state),
    attachments: Object.values(state.attachments),
    routing: state.routing,
    route_override: routeOverrideView(state, nowMs), // CoS allowance per task code, `expired` derived on this read
    ...(roleSlots ? { roles: state.roles || {} } : {}),
    times: state.times,
    task_times: state.task_times || {},
    docs: state.docs || {},
    goals: state.goals || {},
    plans: state.plans || {},
    pings: (state.pings || []).slice(-20),
    watcher_at: watcherAt,
    attention: ownerAttention(state, nowMs),
    stalled: stalled(state, nowMs, stallMs),
    freshness: { ...FRESHNESS_DEFAULTS, ...state.freshness },
    stale_text: staleText(state, nowMs, state.freshness),
    notify: notifyView(state, actor, webhookStatus),
    ...(turns ? { turns: latestTurns(fullState, actor) } : {})
  };
}
