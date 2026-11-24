// Read models derived from structured records on every read. Nothing here is typed by a person or an
// agent as a summary: the owner-attention block is built from open asks, open ask proposals in the
// inbox and steps waiting in the 'owner' zone; the stalled block is built from server timestamps only.
import { currentStep } from './rules.mjs';
import { resolveRoles } from './roles.mjs';
import { resolveMachines, withSlotMachines } from './machines.mjs';
import { latestTurns } from './turns.mjs';
import { progressOf, unansweredOnBoard } from './guards.mjs';
import '../public/measure.js'; // sets globalThis.LaneMeasure (one copy for the server and the page)
import { liveSets, windowBlock } from './window.mjs';
import { OWNER_TZ, stepStamps, stampsLocal, ownerWaiting, waitIndex, formatLocal } from './times.mjs';

const { measuredTimes: measure, askSince } = globalThis.LaneMeasure;

const INACTIVE = new Set(['paused', 'closed']);
/** An owner answer the coordinator has not acknowledged with a receipt ("Nhận") comes back to the owner after this. */
export const RECEIPT_MS = 3 * 3600000;
const ANSWER_KINDS = new Set(['note', 'approve', 'reject', 'choice', 'redirect']);
/** The ask an owner message answers: the one it was scoped to (unless it asked back), the one an ask.answer linked, or
 *  the first one its write closed. Owner messages only: a supervisor nudge carries the ask it is ABOUT in ask_id and answers
 *  nothing (13-11; the same rule as legacy-compat `answered`). */
const answeredAskOf = f => (f.attribution.created_by.role !== 'owner' ? ''
  : f.answers_asks?.[0] || (f.kind !== 'askback' ? f.ask_id || f.scope_ask_id : '') || '');
/** An owner message the coordinator owes a receipt for: it answered an ask, or it is a change of direction. */
const needsReceipt = f => f.attribution.created_by.role === 'owner' && ANSWER_KINDS.has(f.kind) && (!!answeredAskOf(f) || f.kind === 'redirect');

/**
 * The coordinator's pickup of each owner message: its receipt ("Nhận", stored on the message), else the first coordinator
 * reply or note in that message's thread (`reply <id>` with or without --keep, a `say` scoped to it). J-05 10-11: CoS answered
 * the owner in the thread and the board still said "CoS chưa nhận". Derived on every read, so it holds for replies written
 * before this rule and a board one release older reads the same data. { [ownerFeedbackId]: { at, by, receipt_id? | reply_id? } }
 */
export function pickups(state) {
  const out = {};
  for (const f of Object.values(state.feedback)) {
    const by = f.attribution.created_by;
    if (by.role !== 'owner' || by.token_id === 'system' || f.info) continue;
    if (f.received) out[f.id] = { at: f.received.at, by: f.received.by, receipt_id: f.received.receipt_id };
  }
  for (const r of Object.values(state.feedback)) {
    const by = r.attribution.created_by, m = r.reply_to && state.feedback[r.reply_to];
    if (!m || by.role !== 'coordinator' || by.token_id === 'system' || r.info || !['reply', 'note'].includes(r.kind)) continue;
    if (m.task_id !== r.task_id || m.attribution.created_by.role !== 'owner' || m.attribution.created_by.token_id === 'system' || m.info) continue;
    const at = r.attribution.created_at;
    if (!out[m.id] || (out[m.id].reply_id && at < out[m.id].at)) out[m.id] = { at, by, reply_id: r.id };
  }
  return out;
}

/**
 * Who a message is from, as every surface groups it (J-05 17-11, ADR 2026-11-17): 'progress' = CoS's progress post (kind
 * cos-report); 'system' = the board's own word (a nudge, an idle notice, any auto record such as the freshness sweep's status
 * request, or anything the board's own token wrote); 'receipt'; 'owner'; 'cos' = every other coordinator or lane message.
 * Decided here once; a page, the desktop app and the phone read it and never re-derive it.
 */
export function messageClass(f) {
  const by = f.attribution.created_by;
  if (f.kind === 'cos-report') return 'progress';
  if (f.kind === 'nudge' || f.kind === 'idle' || f.auto || by.token_id === 'system') return 'system';
  if (f.kind === 'receipt') return 'receipt';
  return by.role === 'owner' ? 'owner' : 'cos';
}

/** Every feedback record as one message: task, scope (step / ask), kind, author, body, time, the ask it answers, the
 *  message it replies to, and the coordinator's pickup (receipt or reply). Derived on every read from the stored records, so
 *  nothing was migrated or rewritten (and a board one release older reads the same data dir). `deliveryOf` (J-05, src/delivery.mjs):
 *  f -> its delivery state or undefined, passed only while the board tracks delivery; else no message carries a delivery field. */
export function messagesView(state, picked = pickups(state), deliveryOf = null) {
  return Object.values(state.feedback).map(f => ({
    id: f.id, task_id: f.task_id, scope: { ...(f.step_id ? { step_id: f.step_id } : {}), ...(f.scope_ask_id || f.ask_id ? { ask_id: f.scope_ask_id || f.ask_id } : {}), ...(f.plan_id ? { plan_id: f.plan_id } : {}) },
    kind: f.kind, class: messageClass(f), author: who(f.attribution.created_by), body: f.text || '', ts: f.attribution.created_at, ...(f.info ? { info: true } : {}),
    ...(f.tasks ? { tasks: f.tasks } : {}), // a news item's related rows (already scoped for a reporter: scopedState / history)
    answers_ask_id: answeredAskOf(f) || null, ...(f.reply_to ? { reply_to: f.reply_to } : {}), ...(f.receipt ? { receipt: f.receipt } : {}),
    // pasted images: served behind the board's own auth (owner, coordinator), never a public URL
    ...(f.attachments?.length ? { attachments: f.attachments.map(id => ({ id, name: state.attachments[id]?.name || id, mime: state.attachments[id]?.mime || '', url: `api/v1/media/${id}` })) } : {}),
    status: f.status, ...(picked[f.id] ? { received: { at: picked[f.id].at, by: picked[f.id].by.name, ...(picked[f.id].receipt_id ? { receipt_id: picked[f.id].receipt_id } : { reply_id: picked[f.id].reply_id }) } } : {}),
    needs_receipt: needsReceipt(f) && !picked[f.id] && f.status === 'open',
    ...(deliveryOf ? (d => (d ? { delivery: d } : {}))(deliveryOf(f)) : {})
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

/** Owner attention: every open, owner-actionable item across all lanes, oldest first. Every item carries `since_local` (dd-mm HH:mm in the
 *  owner's zone), so a reader (the page, the Zumi agent's digest) prints the time as the board states it. The steps that wait with no ask
 *  come from waitIndex, the same list as each task's waiting_on_owner and the CLI's waiting. */
export function ownerAttention(state, nowMs, deliveryOf = null, { tz = OWNER_TZ, idx = waitIndex(state) } = {}) {
  const picked = pickups(state);
  const live = id => state.tasks[id] && !INACTIVE.has(state.tasks[id].status);
  const waiting = [];
  for (const a of Object.values(state.asks)) {
    if (a.status !== 'open' || !live(a.task_id)) continue;
    waiting.push({ kind: 'ask', id: a.id, task_id: a.task_id, step_id: a.step_id, ...(a.lane ? { lane: a.lane } : {}), text: a.text, options: a.options || [], rev: a.rev, from: who(a.attribution.created_by), since: askSince(a), ...(a.asked_back ? { asked_back_at: a.asked_back.at } : {}) });
  }
  for (const i of Object.values(state.inbox)) {
    if (i.kind !== 'ask' || i.resolution || !live(i.task_id)) continue;
    waiting.push({ kind: 'proposal', id: i.id, task_id: i.task_id, step_id: i.step_id, text: i.text, options: i.options || [], rev: i.rev, from: who(i.attribution.created_by), since: i.attribution.created_at });
  }
  for (const list of idx.stepsWithoutAsk.values()) for (const { step: s, since } of list) {
    waiting.push({ kind: 'step', id: s.id, task_id: s.task_id, step_id: s.id.split('/')[1], text: s.label, options: [], rev: s.rev, from: who(s.attribution.updated_by), since });
  }
  // The owner answered, the coordinator has not picked it up (no receipt, not resolved) for RECEIPT_MS: back to the owner,
  // so an answer or a change of direction cannot vanish unread.
  for (const f of Object.values(state.feedback)) {
    if (!needsReceipt(f) || picked[f.id] || f.status !== 'open' || !live(f.task_id)) continue;
    if (nowMs - Date.parse(f.attribution.created_at) < RECEIPT_MS) continue;
    waiting.push({ kind: 'unreceived', id: f.id, task_id: f.task_id, step_id: f.step_id, text: f.text || '', options: [], rev: f.rev, from: who(f.attribution.created_by), since: f.attribution.created_at, message_kind: f.kind, ...(answeredAskOf(f) ? { ask_id: answeredAskOf(f) } : {}) });
  }
  // J-05 delivery alarm: an open owner message no agent session has received (src/delivery.mjs); the owner may wake or re-send.
  if (deliveryOf) for (const f of Object.values(state.feedback)) {
    if (f.status !== 'open' || !live(f.task_id)) continue;
    const d = deliveryOf(f);
    if (d?.state !== 'undelivered') continue;
    waiting.push({ kind: 'undelivered', id: f.id, task_id: f.task_id, step_id: f.step_id, text: f.text || '', options: [], rev: f.rev, from: who(f.attribution.created_by), since: f.attribution.created_at, message_kind: f.kind, reason: d.reason });
  }
  waiting.sort((a, b) => a.since.localeCompare(b.since));
  for (const w of waiting) { w.age_ms = Math.max(0, nowMs - Date.parse(w.since)); w.since_local = formatLocal(w.since, tz); }
  const dayAgo = nowMs - 86400000;
  const answered = Object.values(state.asks)
    .filter(a => a.status === 'answered' && Date.parse(a.answer.at) >= dayAgo)
    .map(a => {
      const f = a.answer.feedback_id ? state.feedback[a.answer.feedback_id] : Object.values(state.feedback).find(x => x.ask_id === a.id);
      return { id: a.id, task_id: a.task_id, text: a.text, choice: a.answer.choice, answer_text: a.answer.text, at: a.answer.at, ...(a.answer.kind ? { kind: a.answer.kind } : {}),
        ...(f ? { feedback_id: f.id } : {}), ...(f && picked[f.id] ? { received_at: picked[f.id].at, next: state.feedback[picked[f.id].receipt_id]?.receipt?.next || '', ...(picked[f.id].reply_id ? { replied: true } : {}) } : f && f.status !== 'open' ? { handled_at: f.resolved?.at || '' } : {}) };
    })
    .sort((a, b) => b.at.localeCompare(a.at));
  return { waiting, answered };
}

/** Board-wide status freshness (op freshness.set): stale_h 0 = the age rule is off; auto_request = the hourly sweep files status requests. */
export const FRESHNESS_DEFAULTS = { stale_h: 24, auto_request: true };
/**
 * The sweep's quiet rules (they only withhold the board's own request; the stale badge is unaffected):
 * no request while a lane or the coordinator wrote to the task in the last SWEEP_QUIET_MS, none between
 * 23:00 and 07:00 Asia/Ho_Chi_Minh (UTC+7, no DST), and (T-31 15-11) never one for a row whose only open item waits on the
 * owner while no worker runs on it: only the owner's answer can move such a row, so asking its lane for a status only
 * produced "không đổi" receipts that buried the news (the 24 h "chase" re-ask is gone). A request due in a quiet window
 * is dropped, not queued.
 */
export const SWEEP_QUIET_MS = 3600000;
export const sweepNight = ms => { const h = Math.floor(ms / 3600000 + 7) % 24; return h >= 23 || h < 7; };
/** A step the owner must move: it waits in the owner zone, or an open ask sits on it. (Legacy pushes spell the owner
 *  zone 'anh'; adapt-legacy maps it to 'owner' before it is stored.) */
const ownerPending = (state, s) => (s.state === 'waiting' && s.zone === 'owner')
  || Object.values(state.asks || {}).some(a => a.status === 'open' && a.task_id === s.task_id && a.step_id === s.id.split('/')[1]);
/** True when the task's only open item waits on the owner and no worker runs on it: it has an open owner item (a waiting
 *  owner step or an open ask, on a step or on the task) and every step that is not done either waits on the owner or has
 *  not started (todo). An active step without an owner ask, a blocked step or a step waiting on a lane is other open work,
 *  and the sweep still asks such a row. A row with no owner item is not owner-only (unchanged). */
export const ownerOnlyIdle = (state, task) => {
  const open = task.step_ids.map(id => state.steps[`${task.id}/${id}`]).filter(s => s && s.state !== 'done');
  const pending = open.filter(s => ownerPending(state, s));
  const taskAsk = Object.values(state.asks || {}).some(a => a.status === 'open' && a.task_id === task.id);
  return (pending.length > 0 || taskAsk) && open.every(s => s.state === 'todo' || ownerPending(state, s));
};
/** True when the sweep should leave this task alone: parked/finished, grey, written to a moment ago, or (T-31 15-11)
 *  only waiting on the owner with no worker running. */
export const sweepSkips = (state, task, nowMs) => {
  if (INACTIVE.has(task.status) || task.health === 'grey') return true;
  const idleMs = nowMs - Date.parse(state.activity[task.id] || '1970-01-01T00:00:00Z');
  return idleMs < SWEEP_QUIET_MS || ownerOnlyIdle(state, task);
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
    // What the text must keep up with (J-05 phase-view-0911 R5): on a task with phases, its phases (progress = phases; a step
    // moving inside a phase does not make "đang làm chặng 2" wrong; no phases_at yet = nothing to be behind); on a task
    // without, its steps -- never the board's own `lich-su` fold, which is housekeeping, not a step moving.
    const step_at = t.phases?.length ? t.phases_at
      : steps.filter(s => !s.id.endsWith('/lich-su')).map(s => s.state_at ?? s.attribution.updated_at).sort().at(-1);
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
export const STREAM_TYPES = [...SIGNAL_TYPES, 'turn', 'delivery']; // delivery: J-05, only while the board tracks it (src/delivery.mjs)
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
    // feedback_id: the owner message the answer is stored as (ops ask.answer: fb-<seq>, or the row a migration linked), so a
    // reader that tracks owner messages (the J-05 delivery connector) can follow an answer given with the ask buttons.
    return { ...base, type: 'answer', id: ev.target_id, task_id: a?.task_id, ...step(a?.step_id), question: a?.text, ...pick(ev.data, ['choice', 'text']), feedback_id: ev.data.feedback_id || `fb-${ev.seq}` };
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
/** A news item's related rows (`tasks`) as a scoped reader may see them: only the codes `ok` accepts; no list when none is left. */
export function scopedRelated(f, ok) {
  if (!f.tasks) return f;
  const tasks = f.tasks.filter(ok);
  if (tasks.length) return { ...f, tasks };
  const { tasks: _all, ...rest } = f;
  return rest;
}
function scopedState(state, actor) {
  const ok = id => inScope(actor, id);
  const byTask = rec => Object.fromEntries(Object.entries(rec || {}).filter(([k]) => ok(k)));
  const byTaskField = rec => Object.fromEntries(Object.entries(rec || {}).filter(([, v]) => ok(v.task_id)));
  const byKeyPrefix = rec => Object.fromEntries(Object.entries(rec || {}).filter(([k]) => ok(k.split('/')[0])));
  const registry = state.docs?.registry;
  return {
    ...state,
    tasks: byTask(state.tasks), steps: byKeyPrefix(state.steps), archive: byTask(state.archive), times: byKeyPrefix(state.times), task_times: byTask(state.task_times),
    asks: byTaskField(state.asks), inbox: byTaskField(state.inbox), attachments: byTaskField(state.attachments),
    feedback: Object.fromEntries(Object.entries(byTaskField(state.feedback)).map(([k, f]) => [k, scopedRelated(f, ok)])),
    routing: byTask(state.routing), roles: byTask(state.roles), route_override: byTask(state.route_override), machines: byTask(state.machines), pins: byTask(state.pins), gate_fails: byTask(state.gate_fails), activity: byTask(state.activity),
    goals: byTask(state.goals), plans: byTask(state.plans),
    pings: (state.pings || []).filter(p => p.task_id && ok(p.task_id)),
    docs: registry ? { registry: { ...registry, entries: (registry.entries || []).filter(e => e.code && ok(e.code)) } } : {}
  };
}

/** The newest cos-report of each task, { [taskId]: { id, ts, body } }, from the full records (the state window never hides it). */
function progressLatest(state) {
  const out = {};
  for (const f of Object.values(state.feedback)) {
    if (f.kind !== 'cos-report') continue;
    const ts = f.attribution.created_at, cur = out[f.task_id];
    if (!cur || ts > cur.ts || (ts === cur.ts && Number(f.id.slice(3)) > Number(cur.id.slice(3)))) out[f.task_id] = { id: f.id, ts, body: f.text };
  }
  return out;
}

/** A reporter sees a message's delivery state and times, not which session or transport took it (that is the coordinator's). */
const reporterDelivery = of => f => { const d = of(f); if (!d) return d; const { session_id, via, ...rest } = d; return rest; };

/** Full board view for authenticated readers; anonymous readers get only records marked public. A scoped reporter reads only its own tasks. */
export function boardView(fullState, { actor, nowMs, stallMs, config, webhookStatus, watcherAt = '', roleSlots = true, turns = false, archived = false, guards = false, phaseRulesSince = '', r4PerMessageSince = '', windowDays = 0, window: windowMode = '', delivery, workOf }) {
  const state = actor?.role === 'reporter' && !actor.scope_tasks.includes('*') ? scopedState(fullState, actor) : fullState;
  // R4: owner messages CoS handled with no CoS answer in the thread after them (only while the phase rules are on).
  const waitIdx = actor ? waitIndex(state) : null; // one pass for every step stamp and waiting list of this read
  const unanswered = phaseRulesSince ? unansweredOnBoard(state, Date.parse(phaseRulesSince), r4PerMessageSince ? Date.parse(r4PerMessageSince) : undefined) : {};
  const progress = actor ? progressLatest(state) : {}; // messages are never public: an anonymous reader gets no report text
  const tasksAll = Object.values(state.tasks).sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || a.id.localeCompare(b.id));
  const tz = config?.owner_tz || OWNER_TZ;
  const withSteps = t => {
    const rec = t.step_ids.map(id => state.steps[`${t.id}/${id}`]);
    // J-05 times-waiting: an owner or lane reader gets each step's server-set moments (ISO UTC + dd-mm HH:mm in the owner's zone);
    // the public view stays as it was.
    const steps = actor ? rec.map(s => { const stamps = stepStamps(state, s.id, waitIdx); return { ...s, stamps, stamps_local: stampsLocal(stamps, tz) }; }) : rec;
    return {
      ...t,
      steps,
      ...(actor ? { waiting_on_owner: ownerWaiting(state, t.id, nowMs, tz, waitIdx) } : {}),
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
      ...(t.phases?.length ? { progress: progressOf(t.phases) } : {}), // done phases / phases (J-05 W-42 B3); no phases, no field
      ...(unanswered[t.id] ? { unanswered_on_board: unanswered[t.id] } : {}), // R4: only while flagged; older views stay byte-identical
      ...(progress[t.id] ? { progress_latest: progress[t.id] } : {}), // newest Cập nhật tiến độ (cos-report); none, no field
      ...(guards && state.idle?.[t.id] ? { idle: { since: state.idle[t.id].since, steps: state.idle[t.id].steps } } : {}), // B4: only while idle, and only while the guards are on
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
  // The default view serves the live and recent ask/feedback records only (src/window.mjs); every derived block above and below is
  // built from the FULL state, so attention, stalled, stale_text and the task rows do not depend on the window.
  let asks = Object.values(state.asks), feedback = Object.values(state.feedback), messages = messagesView(state, undefined, delivery && (actor.role === 'reporter' ? reporterDelivery(delivery.of) : delivery.of)), win;
  if (windowDays > 0 && windowMode !== 'all') {
    const live = liveSets(state, messages, nowMs, windowDays);
    win = windowBlock(state, live, nowMs, windowDays);
    if (!win.trimmed.asks && !win.trimmed.feedback) win = undefined; // nothing left out: the view stays byte-identical to the full one
    asks = asks.filter(a => live.asks.has(a.id)); feedback = feedback.filter(f => live.feedback.has(f.id)); messages = messages.filter(m => live.feedback.has(m.id));
  }
  return {
    ...base,
    me: { token_id: actor.token_id, name: actor.name, role: actor.role, label: actor.label, lane: actor.lane, model: actor.model, scope_tasks: actor.scope_tasks, prefs: prefsOf(state, actor.token_id), ...(actor.via ? { via: actor.via } : {}) },
    tasks: tasksAll.map(t => ({ ...withSteps(t), status_request: openStatusRequest(state, t.id) })),
    asks,
    inbox: Object.values(state.inbox),
    feedback,
    messages,
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
    attention: ownerAttention(state, nowMs, delivery?.of, { tz, ...(waitIdx ? { idx: waitIdx } : {}) }),
    ...(delivery && actor.role !== 'reporter' ? { connectors: delivery.connectors } : {}), // J-05 delivery: connector presence per machine; off, no field
    ...(workOf ? { work: workOf(actor) } : {}), // J-05 working status (src/work.mjs): live agent runs per task; delivery off, no field
    stalled: stalled(state, nowMs, stallMs),
    freshness: { ...FRESHNESS_DEFAULTS, ...state.freshness },
    stale_text: staleText(state, nowMs, state.freshness),
    notify: notifyView(state, actor, webhookStatus),
    ...(turns ? { turns: latestTurns(fullState, actor) } : {}),
    ...(win ? { window: win } : {})
  };
}
