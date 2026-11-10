// Operation semantics. Each op has:
//   check(ctx)  -> throws BoardError, or returns { data, result } to journal (never secrets / raw bytes)
//   apply(state, event) -> pure, deterministic state change used both live and on replay
// Roles, target kind and revision rule come from schema/v1/ops/<op>.json (x-roles, x-target, x-revision),
// so the published contract and the enforced one cannot drift apart.
import crypto from 'node:crypto';
import { escalateDecision, effortError } from './roles.mjs';
import { normalizeGate } from './gates.mjs';
import { currentStep } from './rules.mjs';
import { TURN, buildQuick, noteLaneWrite, mayUseLane, sameLane, laneKey } from './turns.mjs';
import { isReservedLane, RESERVED_LANES } from './mailbox.mjs';
import { validateArchitecture } from './architecture.mjs';
import { isMachine, resolveMachines } from './machines.mjs';

export class BoardError extends Error {
  constructor(status, code, extra = {}) { super(code); this.status = status; this.code = code; this.extra = extra; }
}
const fail = (status, code, extra) => { throw new BoardError(status, code, extra); };
/** The product-structure diagram (`architecture`): refused whole when it breaks src/architecture.mjs; null (update only) clears it. */
const needArchitecture = a => { if (a === undefined || a === null) return; const violations = validateArchitecture(a); if (violations.length) fail(400, 'bad_architecture', { violations, message: violations[0] }); };
/** Ceiling of the board's task-statistics document: one aggregated JSON the CoS PUTs to `/api/admin/stats`, never a dump.
 *  Derived data kept in `<data>/stats.json`, never in the journal (so an older board with no stats op replays this
 *  journal); enforced in board.putStats, so PUT /admin/stats and PUT /api/admin/stats refuse the same oversized document. */
export const STATS_MAX_BYTES = 512 * 1024;
// ---- step compaction (J-05): older done steps fold into one history step; the archive is state, never the journal ----
/** The one live step a compacted task keeps for its old steps. Reserved: it is never a lane's own step and never compacted. */
export const HISTORY_STEP = 'lich-su';
export const HISTORY_LABEL = 'Lịch sử (gộp)';
export const COMPACT_DEFAULT_KEEP = 10;
export const ARCHIVE_CAP = 2000;
/** A task's live-step ceiling: `step.create` refuses the step over it, and a compat push refuses a row whose final steps
 *  exceed it before its first write (legacy-compat), so the two paths cannot drift. */
export const STEP_CAP = 50;
/** A push that leaves a task at or above this count auto-compacts its older done steps (J-05): `STEP_CAP - 10` leaves
 *  ten steps of headroom for the next push. A code constant on purpose: there is no threshold config. */
export const AUTO_COMPACT_AT = STEP_CAP - 10;
const HISTORY_MAX = 16000;
const RESULT_MAX = 80;
const chars = s => Array.from(s);
/** dd/mm on the Vietnam clock (UTC+7, no DST), from an ISO instant; '' when unknown. */
const dayMonth = iso => { const ms = Date.parse(iso); if (!Number.isFinite(ms)) return ''; const d = new Date(ms + 7 * 3600000); return String(d.getUTCDate()).padStart(2, '0') + '/' + String(d.getUTCMonth() + 1).padStart(2, '0'); };
/** "HH:MM dd-MM" on the Vietnam clock (UTC+7, no DST), from an ISO instant; '' when unknown. */
const vnMoment = iso => { const ms = Date.parse(iso); if (!Number.isFinite(ms)) return ''; const d = new Date(ms + 7 * 3600000), p = n => String(n).padStart(2, '0'); return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())} ${p(d.getUTCDate())}-${p(d.getUTCMonth() + 1)}`; };
/**
 * One history result without markdown decoration, so a step's first line never lands raw in the list: leading block
 * markers (#, >, -, *, 1.), links/images -> their text, `code` -> code, **bold** -> bold. The marker loop repeats so
 * "> - item" loses both. Pure string work: no clock, no state.
 */
const stripMarkdown = line => {
  let s = String(line);
  for (let prev = ''; prev !== s;) { prev = s; s = s.replace(/^\s*(?:#{1,6}\s+|>\s?|[-*+]\s+|\d{1,9}[.)]\s+)/, ''); }
  // The guard keeps a line of stray "[" from scanning to its end at every "[": links are the only quadratic rule.
  if (s.includes('](') && s.includes(')')) s = s.replace(/!?\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, '$1');
  return s
    .replace(/`+([^`]*)`+/g, '$1')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .trim();
};
/** First non-blank line of a step's detail, markdown stripped, whitespace folded and clipped to 80 chars with "…". */
const resultLine = detail => {
  const first = String(detail || '').split(/\r?\n/).find(l => l.trim());
  if (!first) return '';
  const plain = stripMarkdown(first).replace(/\s+/g, ' ').trim();
  const cs = chars(plain);
  return cs.length > RESULT_MAX ? cs.slice(0, RESULT_MAX - 1).join('').trimEnd() + '…' : plain;
};
const sameText = (a, b) => a.replace(/\s+/g, ' ').trim().toLowerCase() === b.replace(/\s+/g, ' ').trim().toLowerCase();
const recordAt = (state, rec) => state.times?.[rec.id]?.done_at || rec.state_at || rec.attribution?.updated_at || '';
/**
 * The Vietnamese list shown in `lich-su`: "dd/mm · label · result", newest done step first (id tie-break), clipped at
 * 16000 characters with a pointer to `state --archived`. The result is markdown stripped and clipped at 80 chars; it is
 * dropped when it is empty or repeats the label (so a bare "label" line never says the same thing twice). Pure: every
 * input comes from the state and the record.
 */
function historyDetail(state, records) {
  const lines = [...records]
    .sort((a, b) => recordAt(state, a).localeCompare(recordAt(state, b)) || String(a.id).localeCompare(String(b.id), 'en', { numeric: true }))
    .reverse()
    .map(rec => {
      const date = dayMonth(recordAt(state, rec)), label = String(rec.label || rec.id || '').trim();
      const result = resultLine(rec.detail);
      return [date, label, result && !sameText(result, label) ? result : ''].filter(Boolean).join(' · ');
    });
  if (!lines.length) return '';
  const suffixFor = n => `\n… và ${n} bước cũ hơn (xem state --archived)`;
  const whole = lines.join('\n');
  if (chars(whole).length <= HISTORY_MAX) return whole;
  for (let keep = lines.length - 1; keep > 0; keep--) {
    const head = lines.slice(0, keep).join('\n'), suffix = suffixFor(lines.length - keep);
    if (chars(head).length + chars(suffix).length <= HISTORY_MAX) return head + suffix;
  }
  return chars(suffixFor(lines.length)).slice(0, HISTORY_MAX).join('');
}
/**
 * What a compaction would do, shared by the op's check() (which journals `moved`) and the dry-run read route.
 * Eligible = done, not among the last `keepLast` done steps (done-time order, id tie-break), with no open ask, no unresolved
 * inbox item, not an end of a loop, and (owner zone only) no unanswered owner feedback on it (coordinator receipts and notes are open by design and wait on no one): an answered owner question folds, an open one never. Pure; never reads a clock.
 */
export function compactPlan(state, taskId, keepLast = COMPACT_DEFAULT_KEEP) {
  const t = state.tasks[taskId] || fail(404, 'task_not_found', { target_id: taskId });
  const at = id => state.times?.[`${taskId}/${id}`]?.done_at || state.steps[`${taskId}/${id}`]?.state_at || state.steps[`${taskId}/${id}`]?.attribution?.updated_at || '';
  const done = t.step_ids.filter(id => id !== HISTORY_STEP && state.steps[`${taskId}/${id}`]?.state === 'done')
    .map(id => ({ id, at: at(id) }))
    .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id, 'en', { numeric: true }));
  const recent = Math.min(Math.max(0, Number(keepLast) || 0), done.length);
  const candidates = done.slice(0, done.length - recent);
  const openAsk = new Set(Object.values(state.asks || {}).filter(a => a.status === 'open' && a.task_id === taskId && a.step_id).map(a => a.step_id));
  const openInbox = new Set(Object.values(state.inbox || {}).filter(i => !i.resolution && i.task_id === taskId && i.step_id).map(i => i.step_id));
  const openFeedback = new Set(Object.values(state.feedback || {}).filter(f => f.status === 'open' && !f.info && f.attribution?.created_by?.role === 'owner' && f.task_id === taskId && f.step_id).map(f => f.step_id));
  const loopEnds = new Set((t.loops || []).flatMap(l => [l.from, l.to]));
  const moved = candidates.filter(({ id }) => {
    const s = state.steps[`${taskId}/${id}`];
    // An owner-zone step is a question for anh: it folds only once answered (done, and no open ask, inbox item or owner feedback on it).
    return s && !openAsk.has(id) && !openInbox.has(id) && !(s.zone === 'owner' && openFeedback.has(id)) && !loopEnds.has(id);
  }).map(x => x.id);
  const archive = state.archive?.[taskId];
  const archived = archive ? archive.order.map(id => archive.steps[id]).filter(Boolean) : [];
  const detail = historyDetail(state, [...archived, ...moved.map(id => state.steps[`${taskId}/${id}`]).filter(Boolean)]);
  const hasHistory = t.step_ids.includes(HISTORY_STEP);
  return {
    moved,
    steps: moved.map(id => ({ id, label: state.steps[`${taskId}/${id}`].label, done_at: at(id) || null })),
    kept: t.step_ids.length - moved.length,
    live_after: t.step_ids.length - moved.length + (moved.length && !hasHistory ? 1 : 0),
    history: { id: HISTORY_STEP, label: HISTORY_LABEL, zone: 'build', state: 'done', detail }
  };
}
/** gemini-* runs through agy, which rejects xhigh and max: refuse the pair at write time. */
const needGeminiEffort = (model, effort) => { const message = effortError(model, effort); if (message) fail(400, 'gemini_effort_not_allowed', { model, effort, message }); };

export function emptyState() {
  return { schema: 1, seq: 0, tasks: {}, steps: {}, archive: {}, asks: {}, inbox: {}, feedback: {}, attachments: {}, routing: {}, roles: {}, route_override: {}, machines: {}, pins: {}, gate_fails: {}, times: {}, task_times: {}, docs: {}, activity: {}, tokens: {}, prefs: {}, notify: null, freshness: null, goals: {}, plans: {}, pings: [], requests: {} };
}

/** Feedback target that is not a task: the board's thread of new-task requests ("+ new task"). */
export const REQUESTS_THREAD = 'NEW';
/** feedback.add target meaning the whole board (the owner's sweep request); not a task, so it never marks activity. */
export const BOARD_TARGET = '*';
const TASK_FIELDS = ['title', 'lane', 'health', 'status', 'goal', 'now', 'next', 'context', 'order', 'visibility', 'worker', 'loops', 'dossier', 'draft_output', 'draft_outcome', 'architecture'];
const STEP_FIELDS = ['label', 'sub', 'zone', 'state', 'detail', 'recommend', 'options', 'lane'];
const PING_KEEP = 200;
const pick = (obj, keys) => Object.fromEntries(keys.filter(k => obj[k] !== undefined).map(k => [k, obj[k]]));
const attribution = ev => ({ created_by: ev.actor, created_at: ev.at, updated_by: ev.actor, updated_at: ev.at });
const touch = (rec, ev) => { rec.rev += 1; rec.attribution.updated_by = ev.actor; rec.attribution.updated_at = ev.at; };
const splitStep = key => { const i = key.indexOf('/'); return [key.slice(0, i), key.slice(i + 1)]; };

// ---- server-measured time (ported from the J-05 tracker: server clock only, never client times) ----
function initTime(state, key, stepState, at) {
  const untracked = stepState === 'done';
  const rec = { first_seen_at: at, waiting_total_ms: 0, last_state: stepState, transitions: [] };
  if (untracked) rec.untracked = true; // already done when first seen: its duration is unknown, do not invent one
  if (stepState === 'active') rec.started_at = at;
  if (stepState === 'waiting') rec.waiting_since = at;
  state.times[key] = rec;
}
function transitionTime(state, key, to, at) {
  const rec = state.times[key];
  if (!rec) return initTime(state, key, to, at);
  if (rec.last_state === to) return;
  if (rec.last_state === 'waiting' && rec.waiting_since) {
    rec.waiting_total_ms += Date.parse(at) - Date.parse(rec.waiting_since);
    delete rec.waiting_since;
  }
  if (to === 'waiting') rec.waiting_since = at;
  if (to === 'active' && !rec.started_at) rec.started_at = at;
  if (to === 'done' && !rec.done_at) rec.done_at = at;
  rec.transitions.push({ at, from: rec.last_state, to });
  if (rec.transitions.length > 100) rec.transitions = rec.transitions.slice(-100);
  rec.last_state = to;
}
/** Task-level clock, same rules as the predecessor tracker: start = earliest step start, done = first moment
 *  every step is done. Never cleared, so an imported history keeps its original values. */
function refreshTaskTime(state, taskId, at) {
  state.task_times ??= {}; // projections written before task-level times existed
  const rec = state.task_times[taskId] ??= { first_seen_at: at };
  const ids = state.tasks[taskId]?.step_ids || [];
  if (!rec.started_at) {
    const starts = ids.map(id => state.times[`${taskId}/${id}`]?.started_at).filter(Boolean).sort();
    if (starts.length) rec.started_at = starts[0];
  }
  if (!rec.done_at && ids.length && ids.every(id => state.steps[`${taskId}/${id}`]?.state === 'done')) rec.done_at = at;
}
const markActivity = (state, taskId, at) => { if (taskId !== BOARD_TARGET) state.activity[taskId] = at; };
/** The owner's open sweep ("Cập nhật" button), if any: at most one exists, the server refuses a second. */
export const openSweep = state => Object.values(state.feedback).find(f => f.kind === 'sweep' && f.status === 'open');

// ---- pings: "act on this now" signals for the coordinator's watcher (the predecessor's pings.json) ----
const openOwnerFeedback = state => Object.values(state.feedback).filter(f => f.status === 'open' && !f.info && f.attribution.created_by.role === 'owner').length;
/** Appends one ping to the projection (last PING_KEEP kept). `n` numbers extra pings of the same event. */
function addPing(state, ev, { kind, task_id, note, detail }, n = 0) {
  if (/^legacy /.test(ev.actor.origin || '')) return; // a migration replays history: it must not wake anyone
  state.pings ??= []; // projections written before pings existed
  state.pings.push({ id: `ping-${ev.seq}${n ? '-' + n : ''}`, at: ev.at, kind, ...(task_id ? { task_id } : {}), ...(note ? { note } : {}), ...(detail ? { detail } : {}), open: openOwnerFeedback(state), by: ev.actor.name });
  if (state.pings.length > PING_KEEP) state.pings = state.pings.slice(-PING_KEEP);
}
/** A feedback record written by an op other than feedback.add (goal lock, re-brief, an ask's answer). */
function addFeedback(state, ev, taskId, fields) {
  const id = `fb-${ev.seq}`;
  state.feedback[id] = { id, task_id: taskId, rev: 1, attribution: attribution(ev), ...fields, status: 'open' };
  return id;
}
// VERDICT: / ETA: lines in a plan body (same reading as the predecessor board), markdown decoration tolerated.
const VERDICT_LINE = /^[ \t>*_#-]*VERDICT[ \t*_]*[:：][ \t*_]*(on-track|adjust|pivot|drifting|wrong-goal|unavailable)\b/im;
const ETA_LINE = /^[ \t>*_#-]*ETA[ \t*_]*[:：][ \t*_]*(.+?)[ \t*_]*$/im;
/** Owner message kinds that answer what the owner was asked. "Hỏi lại" (askback) is not an answer: the ask stays
 *  open and is marked as asked back; a reply, a new-task request or a receipt answers nothing. */
export const ANSWER_KINDS = new Set(['note', 'approve', 'reject', 'choice', 'redirect']);
const OWNER_ONLY_KINDS = ['approve', 'reject', 'newtask', 'choice', 'goal-lock', 'redirect', 'askback'];
/** Kinds that answer by where they are sent: a verdict or a choice on a step or the task answers the asks there. A note or a
 *  redirect answers an ask only when the owner named it (ask_id): it can be about anything (J-05 15-10, fb-2707 / fb-2709). */
const VERDICT_KINDS = new Set(['approve', 'reject', 'choice']);
/** Open asks an owner message answers. Scoped to an ask: that ask only. A verdict kind on a step: that step's asks and the
 *  task's step-less asks (an ask on the task as a whole is answered by a word on any of its steps). On the task: its
 *  step-less asks. Asks on other steps stay open. A note or a redirect with no ask_id answers nothing. */
function asksAnsweredBy(state, taskId, stepId, askId, kind) {
  if (askId) return state.asks[askId]?.status === 'open' ? [askId] : [];
  if (!VERDICT_KINDS.has(kind)) return [];
  return Object.values(state.asks).filter(a => a.task_id === taskId && a.status === 'open' && (!a.step_id || (stepId && a.step_id === stepId))).map(a => a.id);
}
/** A coordinator receipt ("Nhận") answers an owner message with three lines: what changed, the schedule, the next step. */
const RECEIPT_LINES = { change: /^[ \t*_-]*Đổi[ \t*_]*:[ \t]*(.+)$/im, schedule: /^[ \t*_-]*Lịch[ \t*_]*:[ \t]*(.+)$/im, next: /^[ \t*_-]*Bước tiếp[ \t*_]*:[ \t]*(.+)$/im };
export function parseReceipt(text) {
  const out = {};
  for (const [k, re] of Object.entries(RECEIPT_LINES)) { const m = re.exec(String(text || '').normalize('NFC')); if (m && m[1].trim()) out[k] = m[1].trim().slice(0, 500); }
  return Object.keys(out).length === 3 ? out : null;
}
/** The owner set this task's status last — paused or closed — and has not written on the task since: then only the
 *  owner changes it (a coordinator or lane write is refused 'owner_set_status'). A newer owner message on the task
 *  (any kind) hands the decision back to the coordinator. */
export function ownerHoldsStatus(state, taskId) {
  const t = state.tasks[taskId], set = t?.status_set;
  if (!t || !set || set.role !== 'owner' || !['paused', 'closed'].includes(t.status)) return false;
  return !Object.values(state.feedback).some(f => f.task_id === taskId && f.attribution.created_by.role === 'owner' && f.attribution.created_at > set.at);
}
/** A task's step order after `req`, for task.update with step_order: null when the request does not reorder. */
export function reorderedSteps(task, order) {
  if (!Array.isArray(order)) return null;
  if (order.length !== task.step_ids.length || new Set(order).size !== order.length || order.some(id => !task.step_ids.includes(id))) fail(400, 'step_order_mismatch', { expected: task.step_ids });
  return order;
}

// ---- lanes (s21): a task has one owner lane, a step or an ask may belong to another ----
/** The lanes the board knows = the distinct lane of its tasks (plus `extra`, e.g. the lane of a task being created). */
export function knownLanes(state, extra = []) {
  return [...new Set([...Object.values(state.tasks).map(t => t.lane), ...extra].filter(Boolean))];
}
/** `name` as the board spells that lane (case-insensitive match), or 400 unknown_lane: a typo never creates a lane. */
export function resolveLane(state, name, extra = []) {
  const known = knownLanes(state, extra), want = String(name ?? '').trim().toLowerCase();
  return known.find(l => l.toLowerCase() === want) ?? fail(400, 'unknown_lane', { lane: name, known });
}
/** The lane an ask belongs to: its own, else its task's. */
export const askLane = (state, a) => a.lane || state.tasks[a.task_id]?.lane || '';
/** The open ask holding the identity (task, lane, step) -- at most one may exist -- or undefined. */
export const openAskAt = (state, taskId, lane, stepId = '') =>
  Object.values(state.asks).find(a => a.status === 'open' && a.task_id === taskId && askLane(state, a) === lane && (a.step_id || '') === (stepId || ''));

/** The open asks of a lane, oldest first (an ask's id is ask-<seq of its creation>). An ask on a paused or closed task, or on one
 *  that is gone, is not waiting on the owner: the owner block does not list it, so a quick report does not count it either. */
export function openLaneAsks(state, lane) {
  return Object.values(state.asks)
    .filter(a => a.status === 'open' && state.tasks[a.task_id] && !['paused', 'closed'].includes(state.tasks[a.task_id].status) && sameLane(askLane(state, a), lane))
    .sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
}
/** `name` as the board spells that lane (a task's lane, an active token's lane, or a lane that already reported), else undefined. */
export function turnLane(state, name) {
  const known = [...Object.values(state.tasks).map(t => t.lane), ...Object.values(state.tokens).filter(t => !t.revoked_at).map(t => t.lane), ...Object.keys(state.turn_history || {})];
  return known.find(l => l && sameLane(l, name));
}

// ---- helpers used by checks ----
function needTask(state, id) { return state.tasks[id] || fail(404, 'task_not_found', { target_id: id }); }
function needStep(state, taskId, stepId) { return state.steps[`${taskId}/${stepId}`] || fail(404, 'step_not_found', { target_id: `${taskId}/${stepId}` }); }
function needRevision(rec, expected) {
  if (expected === undefined) fail(400, 'expected_revision_required');
  if (rec.rev !== expected) fail(409, 'revision_conflict', { current_revision: rec.rev });
}
export const MAGIC = {
  'image/png': b => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/gif': b => b.subarray(0, 4).toString('latin1') === 'GIF8',
  'image/webp': b => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  'application/pdf': b => b.subarray(0, 5).toString('latin1') === '%PDF-',
  'audio/mpeg': b => b.subarray(0, 3).toString('latin1') === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0), // ID3 tag or MPEG frame sync
  'video/mp4': b => b.subarray(4, 8).toString('latin1') === 'ftyp',
  'text/plain': b => !b.includes(0) && Buffer.from(b.toString('utf8'), 'utf8').equals(b),
  'text/markdown': b => !b.includes(0) && Buffer.from(b.toString('utf8'), 'utf8').equals(b)
};
// Text has no magic number: it is valid only as a WHOLE body. MAGIC above is right for a whole buffer (the base64 path), but a streamed
// upload only keeps its first 16 bytes, and a multi-byte character straddling byte 16 failed the round trip there, so a Vietnamese .md
// was refused at random (owner 02-11). A streamed text upload therefore feeds every chunk through createTextCheck().
export const TEXT_MIMES = new Set(['text/plain', 'text/markdown']);
/** Incremental "is this body UTF-8 text without NUL": push(chunk) per chunk, end() once; both answer false from the first bad byte on. */
export function createTextCheck() {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let good = true;
  return {
    push(chunk) { if (good) { try { if (chunk.includes(0)) good = false; else decoder.decode(chunk, { stream: true }); } catch { good = false; } } return good; },
    end() { if (good) { try { decoder.decode(); } catch { good = false; } } return good; } // a character cut off at the very end throws here
  };
}

/** Task a request touches, for scope checks. Returns null for token administration, prefs and board settings. */
export function taskOf(state, op, target) {
  if (op.startsWith('token.') || op.startsWith('ping') || op === 'prefs.set' || op === 'notify.set' || op === 'freshness.set' || op === 'summary.set' || op === 'registry.set' || op === 'turn.report') return null;
  if (op.startsWith('step.')) return splitStep(target)[0];
  if (op === 'ask.clear' || op === 'ask.answer' || op === 'ask.update') return state.asks[target]?.task_id ?? fail(404, 'ask_not_found', { target_id: target });
  if (op === 'inbox.merge') return state.inbox[target]?.task_id ?? fail(404, 'inbox_item_not_found', { target_id: target });
  if (op === 'feedback.resolve') return state.feedback[target]?.task_id ?? fail(404, 'feedback_not_found', { target_id: target });
  return target;
}

function boardDoc(name, field) {
  return {
    check({ state, req }) {
      const doc = state.docs?.[name];
      needRevision(doc || { rev: 0 }, req.expected_revision);
      if (field === 'entries') {
        const ids = req.data.entries.map(e => e.id);
        if (new Set(ids).size !== ids.length) fail(400, 'duplicate_entry_id');
      }
      return { data: req.data, result: { id: name, revision: (doc?.rev || 0) + 1 } };
    },
    apply(state, ev) {
      state.docs ??= {}; // projections written before board documents existed
      const doc = state.docs[name];
      if (doc) { doc[field] = ev.data[field]; touch(doc, ev); }
      else state.docs[name] = { rev: 1, attribution: attribution(ev), [field]: ev.data[field] };
    }
  };
}

export const OPS = {
  'task.create': {
    check({ state, req, actor }) {
      if (state.tasks[req.target_id]) fail(409, 'exists', { current_revision: state.tasks[req.target_id].rev });
      if (req.data.worker) needGeminiEffort(req.data.worker.model, req.data.worker.effort);
      needArchitecture(req.data.architecture);
      const ids = (req.data.steps || []).map(s => s.id);
      if (new Set(ids).size !== ids.length) fail(400, 'duplicate_step_id');
      for (const l of req.data.loops || []) if (!ids.includes(l.from) || !ids.includes(l.to)) fail(400, 'loop_step_not_found');
      const own = req.data.lane ?? actor.lane ?? '';
      const steps = (req.data.steps || []).map(s => (s.lane === undefined ? s : { ...s, lane: resolveLane(state, s.lane, [own]) }));
      return { data: steps.some((s, i) => s !== req.data.steps[i]) ? { ...req.data, steps } : req.data, result: { id: req.target_id, revision: 1 } };
    },
    apply(state, ev) {
      const d = ev.data, id = ev.target_id;
      state.tasks[id] = {
        id, rev: 1, visibility: d.visibility || 'internal', attribution: attribution(ev),
        title: d.title, lane: d.lane ?? (ev.actor.lane || ''), health: d.health || 'green', status: d.status || 'doing', text_at: ev.at,
        ...pick(d, ['goal', 'now', 'next', 'context', 'order', 'dossier', 'draft_output', 'draft_outcome', 'architecture']), worker: d.worker ?? null, loops: d.loops || [],
        step_ids: (d.steps || []).map(s => s.id)
      };
      if (state.tasks[id].architecture == null) delete state.tasks[id].architecture; // a create that sends null has none
      for (const s of d.steps || []) {
        const key = `${id}/${s.id}`;
        state.steps[key] = { id: key, task_id: id, rev: 1, attribution: attribution(ev), ...pick(s, STEP_FIELDS), state_at: ev.at };
        // A task re-created after task.delete continues its kept timing history instead of restarting it.
        if (state.times[key]) transitionTime(state, key, s.state, ev.at); else initTime(state, key, s.state, ev.at);
      }
      refreshTaskTime(state, id, ev.at);
      markActivity(state, id, ev.at);
    }
  },
  'task.update': {
    check({ state, req, actor }) {
      const t = needTask(state, req.target_id);
      needRevision(t, req.expected_revision);
      if (req.data.worker) needGeminiEffort(req.data.worker.model, req.data.worker.effort);
      needArchitecture(req.data.architecture);
      if (req.data.status !== undefined && req.data.status !== t.status && actor.role !== 'owner' && ownerHoldsStatus(state, t.id)) {
        fail(409, 'owner_set_status', { task: t.id, status: t.status, set_at: t.status_set.at });
      }
      if (req.data.lane !== undefined && req.data.lane !== t.lane) fail(409, 'lane_immutable', { task: t.id, lane: t.lane, requested: req.data.lane });
      for (const l of req.data.loops || []) if (!t.step_ids.includes(l.from) || !t.step_ids.includes(l.to)) fail(400, 'loop_step_not_found');
      reorderedSteps(t, req.data.step_order);
      return { data: req.data, result: { id: t.id, revision: t.rev + 1 } };
    },
    apply(state, ev) {
      const t = state.tasks[ev.target_id];
      // Who set the status last (a projection of the journal): the owner_set_status guard reads it.
      if (ev.data.status !== undefined && ev.data.status !== t.status) t.status_set = { role: ev.actor.role, by: ev.actor.name, at: ev.at };
      // The headline text moved: stamp it (an empty bump or a re-push of the same text does not) and close the
      // owner's open "status update" requests on the task.
      if (['now', 'next'].some(k => ev.data[k] !== undefined && ev.data[k] !== t[k])) {
        t.text_at = ev.at;
        for (const f of Object.values(state.feedback)) if (f.task_id === t.id && f.kind === 'rebrief' && f.mode === 'status' && f.status === 'open') { f.status = 'resolved'; f.resolved = { at: ev.at, by: ev.actor }; touch(f, ev); }
      }
      Object.assign(t, pick(ev.data, TASK_FIELDS));
      if (t.architecture === null) delete t.architecture; // null clears the diagram: the key is absent, as on a task that never had one
      if (ev.data.status === 'closed') delete state.pins?.[t.id]; // a closed task leaves the pinned strip (and comes back unpinned)
      if (ev.data.step_order) t.step_ids = [...ev.data.step_order];
      touch(t, ev); markActivity(state, t.id, ev.at);
    }
  },
  'task.delete': {
    check({ state, req }) {
      const t = needTask(state, req.target_id);
      needRevision(t, req.expected_revision);
      return { data: req.data, result: { id: t.id, revision: t.rev + 1 } };
    },
    apply(state, ev) {
      const t = state.tasks[ev.target_id];
      for (const id of t.step_ids) delete state.steps[`${t.id}/${id}`];
      // The step archive belongs to this task's lifetime: a lingering archive would 409 `archived` on the same step ids
      // if the id is re-created (AGENTS.md: a re-created id continues its timing history) and would leak into the new
      // task's history detail. Timing history stays in state.times, as before.
      delete state.archive?.[t.id];
      delete state.tasks[t.id];
      delete state.routing[t.id];
      delete state.route_override?.[t.id]; // a re-created id must not inherit the deleted task's CoS allowance
      delete state.machines?.[t.id]; // nor its machine pick
      delete state.pins?.[t.id]; // nor its owner pin
      markActivity(state, t.id, ev.at);
    }
  },
  'step.delete': {
    check({ state, req }) {
      const [taskId, stepId] = splitStep(req.target_id);
      const s = needStep(state, taskId, stepId);
      needRevision(s, req.expected_revision);
      return { data: req.data, result: { id: s.id, revision: s.rev + 1 } };
    },
    apply(state, ev) {
      const [taskId, stepId] = splitStep(ev.target_id);
      const t = state.tasks[taskId];
      t.step_ids = t.step_ids.filter(id => id !== stepId);
      t.loops = (t.loops || []).filter(l => l.from !== stepId && l.to !== stepId); // a loop needs both ends
      delete state.steps[ev.target_id];
      touch(t, ev); refreshTaskTime(state, taskId, ev.at); markActivity(state, taskId, ev.at);
    }
  },
  'step.create': {
    check({ state, req }) {
      const [taskId, stepId] = splitStep(req.target_id);
      needTask(state, taskId);
      if (state.steps[req.target_id]) fail(409, 'exists', { current_revision: state.steps[req.target_id].rev });
      // A compacted step id is retired: a stale row or a client naming it must not resurrect it (archived ids never count toward the cap).
      if (state.archive?.[taskId]?.steps?.[stepId]) fail(409, 'archived', { task: taskId, step: stepId });
      if (state.tasks[taskId].step_ids.length >= STEP_CAP) fail(400, 'too_many_steps');
      const data = req.data.lane === undefined ? req.data : { ...req.data, lane: resolveLane(state, req.data.lane) };
      return { data, result: { id: req.target_id, revision: 1 } };
    },
    apply(state, ev) {
      const [taskId, stepId] = splitStep(ev.target_id);
      state.steps[ev.target_id] = { id: ev.target_id, task_id: taskId, rev: 1, attribution: attribution(ev), ...pick(ev.data, STEP_FIELDS), state_at: ev.at };
      state.tasks[taskId].step_ids.push(stepId);
      initTime(state, ev.target_id, ev.data.state, ev.at);
      refreshTaskTime(state, taskId, ev.at);
      markActivity(state, taskId, ev.at);
    }
  },
  'step.update': {
    check({ state, req }) {
      const [taskId, stepId] = splitStep(req.target_id);
      const s = needStep(state, taskId, stepId);
      needRevision(s, req.expected_revision);
      let data = req.data;
      if (data.lane !== undefined) { // a step is stamped once (s21 migration, a lane's first push); it never moves to another lane
        const lane = resolveLane(state, data.lane);
        if (s.lane && s.lane !== lane) fail(409, 'lane_immutable', { step: s.id, lane: s.lane, requested: lane });
        data = { ...data, lane };
      }
      return { data, result: { id: s.id, revision: s.rev + 1 } };
    },
    apply(state, ev) {
      const s = state.steps[ev.target_id];
      if (ev.data.state && ev.data.state !== s.state) { transitionTime(state, s.id, ev.data.state, ev.at); s.state_at = ev.at; }
      Object.assign(s, pick(ev.data, STEP_FIELDS)); touch(s, ev); refreshTaskTime(state, s.task_id, ev.at); markActivity(state, s.task_id, ev.at);
    }
  },
  // Folds a task's older done steps into one history step (`lich-su`) and moves their records into state.archive.
  // check() decides eligibility once and journals the moved ids; apply() uses only `ev.data.moved`, `ev.at` and state,
  // so replay and live writes are identical. A run with nothing eligible changes no state (still a successful write).
  'steps.compact': {
    check({ state, req }) {
      const t = needTask(state, req.target_id);
      needRevision(t, req.expected_revision);
      const keepLast = req.data.keep_last ?? COMPACT_DEFAULT_KEEP;
      const plan = compactPlan(state, t.id, keepLast);
      return {
        data: { keep_last: keepLast, moved: plan.moved },
        result: { id: t.id, revision: plan.moved.length ? t.rev + 1 : t.rev },
        ...(plan.moved.length ? { reveal: { moved: plan.moved, history: plan.history } } : {})
      };
    },
    apply(state, ev) {
      const taskId = ev.target_id, t = state.tasks[taskId], moved = ev.data.moved || [];
      if (!moved.length) return; // second run with nothing eligible: a no-op, not an error
      state.archive ??= {};
      const ar = (state.archive[taskId] ??= { steps: {}, order: [] });
      ar.steps ??= {}; ar.order ??= [];
      for (const id of moved) {
        const key = `${taskId}/${id}`, rec = state.steps[key];
        if (!rec) continue; // already archived (a defensive no-op; check() never names one twice)
        ar.steps[id] = rec; // the record itself: attribution, rev and detail stay
        delete state.steps[key];
      }
      ar.order = [...new Set([...ar.order, ...moved.filter(id => ar.steps[id])])];
      if (ar.order.length > ARCHIVE_CAP) for (const id of ar.order.splice(0, ar.order.length - ARCHIVE_CAP)) delete ar.steps[id];
      t.step_ids = t.step_ids.filter(id => !moved.includes(id));
      const detail = historyDetail(state, ar.order.map(id => ar.steps[id]).filter(Boolean));
      const key = `${taskId}/${HISTORY_STEP}`, existing = state.steps[key];
      if (existing) { existing.label = HISTORY_LABEL; existing.zone = 'build'; existing.state = 'done'; existing.detail = detail; existing.rev += 1; }
      else {
        // No timing record: the folded history is not work and must leave state.times byte-identical (measured time and
        // /api/times stay exactly as they were). A later step.update on it starts its own clock then, as for any step.
        state.steps[key] = { id: key, task_id: taskId, rev: 1, attribution: attribution(ev), label: HISTORY_LABEL, zone: 'build', state: 'done', detail, state_at: ev.at };
      }
      t.step_ids = [HISTORY_STEP, ...t.step_ids.filter(id => id !== HISTORY_STEP)];
      touch(t, ev); refreshTaskTime(state, taskId, ev.at); markActivity(state, taskId, ev.at);
    }
  },
  'ask.raise': {
    check({ state, req, seq }) {
      const task = needTask(state, req.target_id);
      if (req.data.step_id) needStep(state, req.target_id, req.data.step_id);
      const migration = /^migrate-s21 /.test(req.origin || '');
      if (req.data.waiting_since && !migration) fail(400, 'waiting_since_not_allowed');
      const lane = req.data.lane === undefined ? task.lane : resolveLane(state, req.data.lane);
      // One open ask per (task, lane, step): with two, "which one does this answer or receipt close" has no answer. A migration
      // creates the parts of a composite ask before it clears the composite, so it is the one writer allowed to overlap.
      const held = openAskAt(state, req.target_id, lane, req.data.step_id);
      if (held && !migration) fail(409, 'ask_exists', { ask_id: held.id, revision: held.rev, task: req.target_id, lane, step_id: req.data.step_id || '' });
      const { lane: _lane, ...rest } = req.data;
      // The task's own lane is the absent lane: nothing is stored for it.
      return { data: lane === task.lane ? rest : { ...rest, lane }, result: { id: `ask-${seq}`, revision: 1 } };
    },
    apply(state, ev) {
      state.asks[ev.result.id] = { id: ev.result.id, task_id: ev.target_id, rev: 1, attribution: attribution(ev), ...pick(ev.data, ['step_id', 'text', 'options', 'lane', 'waiting_since']), status: 'open' };
      markActivity(state, ev.target_id, ev.at);
    }
  },
  // Fills the lane of a legacy open ask that has none -- the s21 migration's job, nothing else. The lane is part of the ask's identity, so
  // it is never replaced (not even by the same value), and only the coordinator token with a migration origin may fill it.
  'ask.update': {
    check({ state, req, actor }) {
      if (actor.role !== 'coordinator' || !/^migrate-s21 /.test(req.origin || '')) fail(403, 'migration_only', { message: 'ask.update is the s21 migration: coordinator token and origin "migrate-s21 ..."' });
      const a = state.asks[req.target_id];
      if (a.status !== 'open') fail(409, 'ask_not_open', { status: a.status });
      needRevision(a, req.expected_revision);
      const lane = resolveLane(state, req.data.lane);
      if (a.lane) fail(409, 'lane_immutable', { ask_id: a.id, lane: a.lane, requested: lane });
      const held = openAskAt(state, a.task_id, lane, a.step_id);
      if (held && held.id !== a.id) fail(409, 'ask_exists', { ask_id: held.id, task: a.task_id, lane, step_id: a.step_id || '' });
      return { data: { lane }, result: { id: a.id, revision: a.rev + 1 } };
    },
    apply(state, ev) {
      const a = state.asks[ev.target_id];
      a.lane = ev.data.lane; touch(a, ev); markActivity(state, a.task_id, ev.at);
    }
  },
  'ask.clear': {
    check({ state, req }) {
      const a = state.asks[req.target_id];
      if (a.status !== 'open') fail(409, 'ask_not_open', { status: a.status });
      needRevision(a, req.expected_revision);
      return { data: req.data, result: { id: a.id, revision: a.rev + 1 } };
    },
    apply(state, ev) {
      const a = state.asks[ev.target_id];
      a.status = 'cleared'; a.cleared = { ...pick(ev.data, ['note']), at: ev.at, by: ev.actor }; touch(a, ev); markActivity(state, a.task_id, ev.at);
    }
  },
  'ask.answer': {
    check({ state, req }) {
      const a = state.asks[req.target_id];
      if (a.status !== 'open') fail(409, 'ask_not_open', { status: a.status });
      needRevision(a, req.expected_revision);
      const { choice, text, verdict, feedback_id } = req.data;
      if (!choice && !verdict && !String(text || '').trim()) fail(400, 'choice_or_text_required');
      if (choice && !(a.options || []).some(o => o.key === choice)) fail(400, 'unknown_choice');
      if (feedback_id) {
        const f = state.feedback[feedback_id];
        if (!f || f.task_id !== a.task_id || f.attribution.created_by.role !== 'owner') fail(400, 'feedback_not_on_task', { feedback_id });
      }
      return { data: req.data, result: { id: a.id, revision: a.rev + 1 } };
    },
    apply(state, ev) {
      const a = state.asks[ev.target_id], d = ev.data;
      a.status = 'answered'; a.answer = { ...pick(d, ['choice', 'text']), at: ev.at, by: ev.actor }; touch(a, ev); markActivity(state, a.task_id, ev.at);
      // The answer is also an owner feedback on the task (the predecessor recorded a choice as feedback): it shows in
      // the thread and stays open until the coordinator handles it. A migration links the row it already imported.
      if (d.feedback_id) { const f = state.feedback[d.feedback_id]; f.ask_id = a.id; if (d.choice) f.choice = d.choice; touch(f, ev); return; }
      const label = d.choice ? (a.options || []).find(o => o.key === d.choice)?.label : '';
      const text = [d.choice ? `${d.choice}: ${label}` : d.verdict && !d.text ? `${d.verdict}: ${a.text}` : '', d.text || ''].filter(Boolean).join('\n');
      addFeedback(state, ev, a.task_id, { ...(a.step_id ? { step_id: a.step_id } : {}), kind: d.verdict || (d.choice ? 'choice' : 'note'), text: text.slice(0, 8000), ask_id: a.id, ...(d.choice ? { choice: d.choice } : {}) });
    }
  },
  'inbox.submit': {
    check({ state, req, seq }) {
      needTask(state, req.target_id);
      const d = req.data;
      if (d.step_id) needStep(state, req.target_id, d.step_id);
      if (d.kind === 'step' && (!d.step_id || !d.state)) fail(400, 'step_id_and_state_required');
      if (d.kind !== 'step' && !d.text.trim()) fail(400, 'text_required');
      return { data: d, result: { id: `inb-${seq}`, revision: 1 } };
    },
    apply(state, ev) {
      state.inbox[ev.result.id] = { id: ev.result.id, task_id: ev.target_id, rev: 1, attribution: attribution(ev), ...pick(ev.data, ['kind', 'text', 'step_id', 'state', 'options']) };
      markActivity(state, ev.target_id, ev.at);
    }
  },
  'inbox.merge': {
    check({ state, req, seq }) {
      const item = state.inbox[req.target_id];
      if (item.resolution) fail(409, 'already_resolved');
      needRevision(item, req.expected_revision);
      let resultId = '';
      if (req.data.action === 'accept') {
        if (item.kind === 'ask') resultId = `ask-${seq}`;
        if (item.kind === 'report') resultId = `fb-${seq}`;
        if (item.kind === 'step') { needStep(state, item.task_id, item.step_id); resultId = `${item.task_id}/${item.step_id}`; }
      }
      return { data: { ...req.data, ...(resultId ? { result_id: resultId } : {}) }, result: { id: item.id, revision: item.rev + 1 }, ...(resultId ? { reveal: { result_id: resultId } } : {}) };
    },
    apply(state, ev) {
      const item = state.inbox[ev.target_id];
      const submitter = item.attribution.created_by, rid = ev.data.result_id;
      if (ev.data.action === 'accept') {
        // The accepted record keeps the original submitter as creator; the merge is the update.
        const attr = { created_by: submitter, created_at: item.attribution.created_at, updated_by: ev.actor, updated_at: ev.at };
        if (item.kind === 'ask') state.asks[rid] = { id: rid, task_id: item.task_id, rev: 1, attribution: attr, ...pick(item, ['step_id', 'text', 'options']), status: 'open', via_inbox: item.id };
        if (item.kind === 'report') state.feedback[rid] = { id: rid, task_id: item.task_id, rev: 1, attribution: attr, ...pick(item, ['step_id', 'text']), kind: 'report', status: 'open' };
        if (item.kind === 'step') {
          const s = state.steps[rid];
          if (s.state !== item.state) transitionTime(state, s.id, item.state, ev.at);
          s.state = item.state; touch(s, ev); refreshTaskTime(state, s.task_id, ev.at);
        }
      }
      item.resolution = { action: ev.data.action, ...pick(ev.data, ['note', 'result_id']), at: ev.at, by: ev.actor };
      touch(item, ev); markActivity(state, item.task_id, ev.at);
    }
  },
  'feedback.add': {
    check({ state, req, seq, actor }) {
      const d = req.data;
      // A sweep is the owner's request that the coordinator re-check every task: target * (the whole board), one open at a time.
      if (d.kind === 'sweep') {
        if (actor.role !== 'owner') fail(403, 'owner_only_kind');
        if (req.target_id !== BOARD_TARGET) fail(400, 'sweep_target', { target_id: req.target_id });
        if (d.step_id || d.plan_id || d.ask_id || d.reply_to || d.attachments?.length) fail(400, 'sweep_fields');
        const open = openSweep(state);
        if (open) fail(409, 'sweep_open', { feedback_id: open.id });
      }
      if (req.target_id === BOARD_TARGET) { // the whole board takes a sweep, or the coordinator's reply to one
        const parent = d.reply_to && state.feedback[d.reply_to];
        if (d.kind !== 'sweep' && !(actor.role === 'coordinator' && ['reply', 'receipt'].includes(d.kind) && parent?.kind === 'sweep')) fail(400, 'not_a_task', { target_id: req.target_id });
      }
      else if (req.target_id !== REQUESTS_THREAD || state.tasks[req.target_id]) needTask(state, req.target_id);
      else if (d.step_id || d.plan_id) fail(400, 'not_a_task', { target_id: req.target_id });
      if (OWNER_ONLY_KINDS.includes(d.kind) && actor.role !== 'owner') fail(403, 'owner_only_kind');
      if (d.kind === 'receipt' && actor.role !== 'coordinator') fail(403, 'coordinator_only_kind');
      if (d.kind === 'goal-lock' && !d.goal_version) fail(400, 'goal_version_required');
      if (d.step_id) needStep(state, req.target_id, d.step_id);
      if (d.plan_id && !(state.plans?.[req.target_id] || []).some(p => p.id === d.plan_id)) fail(404, 'plan_not_found', { plan_id: d.plan_id });
      if (d.reply_to && !state.feedback[d.reply_to]) fail(404, 'feedback_not_found', { target_id: d.reply_to });
      if (d.ask_id) { // scope = one ask of this task (and of this step, when a step is named too)
        const a = state.asks[d.ask_id];
        if (!a || a.task_id !== req.target_id) fail(404, 'ask_not_found', { target_id: d.ask_id });
        if (d.step_id && a.step_id && a.step_id !== d.step_id) fail(400, 'ask_not_on_step', { ask_id: a.id, step_id: d.step_id });
      }
      for (const id of d.attachments || []) { // pasted images: attachments of this task, images only
        const a = state.attachments[id];
        if (!a || a.task_id !== req.target_id) fail(404, 'attachment_not_found', { target_id: id });
        if (!/^image\//.test(a.mime)) fail(400, 'attachment_not_image', { target_id: id });
      }
      let receipt;
      if (d.kind === 'receipt') {
        const parent = d.reply_to && state.feedback[d.reply_to];
        if (!parent || parent.task_id !== req.target_id || parent.attribution.created_by.role !== 'owner') fail(400, 'receipt_needs_owner_message', { reply_to: d.reply_to || null });
        receipt = parseReceipt(d.text) || fail(400, 'receipt_lines_required', { lines: ['Đổi:', 'Lịch:', 'Bước tiếp:'] });
      }
      // The owner wrote on a task, step or ask that is waiting on them: that answers the open ask(s) there (the card
      // leaves "Waiting on you"); "Hỏi lại" marks the scoped ask as asked back instead. Decided here and journaled, so
      // replaying an older journal never answers anything new. A migration's replayed history (origin "legacy …")
      // answers nothing. Step state stays the coordinator's call.
      const live = actor.role === 'owner' && state.tasks[req.target_id] && !/^legacy /.test(req.origin || '');
      const answers = live && ANSWER_KINDS.has(d.kind) ? asksAnsweredBy(state, req.target_id, d.step_id, d.ask_id, d.kind) : [];
      const askedBack = live && d.kind === 'askback' && d.ask_id && state.asks[d.ask_id].status === 'open' ? [d.ask_id] : [];
      return { data: { ...d, ...(answers.length ? { answers_asks: answers } : {}), ...(askedBack.length ? { asks_back: askedBack } : {}), ...(receipt ? { receipt } : {}) }, result: { id: `fb-${seq}`, revision: 1 } };
    },
    apply(state, ev) {
      const d = ev.data;
      state.feedback[ev.result.id] = { id: ev.result.id, task_id: ev.target_id, rev: 1, attribution: attribution(ev), ...pick(d, ['step_id', 'kind', 'text', 'reply_to', 'plan_id', 'goal_version', 'receipt', 'attachments']), ...(d.ask_id ? { scope_ask_id: d.ask_id } : {}), status: 'open' };
      // Still open feedback for the coordinator (its feed and the compat state show it as new owner feedback).
      const answered = (d.answers_asks || []).filter(id => state.asks[id]?.status === 'open');
      for (const id of answered) {
        const a = state.asks[id];
        a.status = 'answered'; a.answer = { at: ev.at, by: ev.actor, feedback_id: ev.result.id, kind: d.kind, text: d.text.slice(0, 2000) }; touch(a, ev);
      }
      if (answered.length) state.feedback[ev.result.id].answers_asks = answered;
      for (const id of d.asks_back || []) { const a = state.asks[id]; if (a?.status === 'open') { a.asked_back = { at: ev.at, by: ev.actor, feedback_id: ev.result.id }; touch(a, ev); } }
      // A receipt is the coordinator's pickup of that owner message: recorded on it, and it closes it.
      // An informational note has nothing to receive or resolve: a receipt may reply to it but never marks it handled.
      if (d.kind === 'receipt') { const m = state.feedback[d.reply_to]; if (m && !m.info) { m.received = { at: ev.at, by: ev.actor, receipt_id: ev.result.id }; touch(m, ev); } }
      const parent = d.reply_to && (d.resolve_reply_to || d.kind === 'receipt') ? state.feedback[d.reply_to] : null;
      if (parent && !parent.info && parent.status === 'open') { parent.status = 'resolved'; parent.resolved = { at: ev.at, by: ev.actor }; touch(parent, ev); }
      markActivity(state, ev.target_id, ev.at);
    }
  },
  'feedback.resolve': {
    check({ state, req }) {
      const f = state.feedback[req.target_id];
      if (f.info) fail(409, 'informational_note'); // a notice reports a change; there is nothing to handle
      if (f.status !== 'open') fail(409, 'already_resolved');
      needRevision(f, req.expected_revision);
      return { data: req.data, result: { id: f.id, revision: f.rev + 1 } };
    },
    apply(state, ev) {
      const f = state.feedback[ev.target_id];
      f.status = 'resolved'; f.resolved = { at: ev.at, by: ev.actor }; touch(f, ev); markActivity(state, f.task_id, ev.at);
    }
  },
  'times.import': {
    // History measured by a predecessor server's clock, imported once per task. Step records replace the fresh
    // ones task.create started; a step whose state moved since the history was taken gets one transition at the
    // import time. The task may be gone from the board: its history is kept as an archive, not dropped.
    check({ state, req }) {
      if (state.task_times?.[req.target_id]?.imported_at) fail(409, 'already_imported');
      const ids = Object.keys(req.data.steps);
      if (ids.length > 200) fail(400, 'too_many_steps');
      const bad = ids.find(id => !/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(id));
      if (bad) fail(400, 'invalid_step_id', { step_id: bad });
      // Ages (last activity, ask waits) only make sense for a task on the board and its own asks.
      const asks = Object.keys(req.data.asks || {});
      if ((req.data.last_activity_at || asks.length) && !state.tasks[req.target_id]) fail(404, 'task_not_found', { target_id: req.target_id });
      if (asks.length > 200) fail(400, 'too_many_asks');
      const foreign = asks.find(a => state.asks[a]?.task_id !== req.target_id);
      if (foreign) fail(400, 'ask_not_on_task', { ask_id: foreign });
      return { data: req.data, result: { id: req.target_id, revision: 0 } };
    },
    apply(state, ev) {
      const id = ev.target_id;
      state.task_times ??= {};
      state.task_times[id] = { ...ev.data.task, imported_at: ev.at };
      if (ev.data.last_activity_at) state.activity[id] = ev.data.last_activity_at;
      for (const [aid, a] of Object.entries(ev.data.asks || {})) state.asks[aid].waiting_since = a.waiting_since;
      for (const [sid, rec] of Object.entries(ev.data.steps)) {
        const key = `${id}/${sid}`;
        state.times[key] = structuredClone(rec);
        const step = state.steps[key];
        if (step && step.state !== rec.last_state) transitionTime(state, key, step.state, ev.at);
      }
    }
  },
  // Board-level documents: whole-document replace guarded by the document's own revision.
  'summary.set': boardDoc('summary', 'items'),
  'registry.set': {
    check: boardDoc('registry', 'entries').check,
    apply(state, ev) {
      // The owner changing an entry's status is a decision the coordinator must act on: one ping per changed entry.
      const before = new Map((state.docs?.registry?.entries || []).map(e => [e.id, e.status]));
      boardDoc('registry', 'entries').apply(state, ev);
      if (ev.actor.role !== 'owner') return;
      ev.data.entries.filter(e => before.has(e.id) && before.get(e.id) !== e.status)
        .forEach((e, i) => addPing(state, ev, { kind: 'status', task_id: e.code || '', detail: { entry: e.id, title: e.title, status: e.status } }, i));
    }
  },
  // The board's task-statistics document (J-05) is derived data: it is NOT an op and never enters the journal. It
  // lives in <data>/stats.json, is validated against schema/v1/stats.json and written by board.putStats, so an older
  // board (one that knows no stats op) can still replay this journal and start. See board.mjs (stats/putStats).
  'routing.set': {
    check({ state, req }) {
      needGeminiEffort(req.data.model, req.data.effort);
      const t = needTask(state, req.target_id), o = state.routing[req.target_id];
      // The worker this replaces, journaled with the change so the history reads "old → new".
      const previous = o ? { model: o.model, effort: o.effort, by: 'owner' } : t.worker ? { model: t.worker.model, effort: t.worker.effort, by: 'coordinator' } : null;
      return { data: { ...req.data, ...(previous ? { previous } : {}) }, result: { id: req.target_id, revision: 0 } };
    },
    apply(state, ev) {
      state.routing[ev.target_id] = { task_id: ev.target_id, model: ev.data.model, effort: ev.data.effort, set_by: ev.actor, set_at: ev.at };
      addPing(state, ev, { kind: 'routing', task_id: ev.target_id, detail: { model: ev.data.model, effort: ev.data.effort } });
    }
  },
  'routing.reset': {
    check({ state, req }) { needTask(state, req.target_id); return { data: req.data, result: { id: req.target_id, revision: 0 } }; },
    apply(state, ev) {
      if (!state.routing[ev.target_id]) return; // nothing to reset: no change, no ping
      delete state.routing[ev.target_id];
      const w = state.tasks[ev.target_id]?.worker;
      addPing(state, ev, { kind: 'routing', task_id: ev.target_id, detail: { reset: true, ...(w ? { model: w.model, effort: w.effort } : {}) } });
    }
  },
  // ---- role slots (ADR 2026-10-09): plan / review / scout overrides by the owner, gate failures and auto-escalation of the code slot ----
  'roles.set': {
    check({ state, req }) {
      needTask(state, req.target_id);
      needGeminiEffort(req.data.model, req.data.effort);
      // the scout (haiku) gathers facts only and never rules pass or fail, so it cannot sit in the review slot (ADR 2026-10-09 invariant b)
      if (req.data.role === 'review' && req.data.model === 'haiku') fail(400, 'review_model_not_allowed', { model: 'haiku', message: 'haiku is the scout model and never rules pass or fail; pick opus, sonnet, fable or deepseek for review' });
      const o = state.roles?.[req.target_id]?.[req.data.role];
      return { data: { ...req.data, ...(o ? { previous: { model: o.model, effort: o.effort } } : {}) }, result: { id: req.target_id, revision: 0 } };
    },
    apply(state, ev) {
      state.roles ??= {}; // projections written before role slots existed
      (state.roles[ev.target_id] ??= {})[ev.data.role] = { model: ev.data.model, effort: ev.data.effort, by: 'owner', set_by: ev.actor, at: ev.at };
      addPing(state, ev, { kind: 'routing', task_id: ev.target_id, detail: { role: ev.data.role, model: ev.data.model, effort: ev.data.effort } });
    }
  },
  'roles.reset': {
    check({ state, req }) { needTask(state, req.target_id); return { data: req.data, result: { id: req.target_id, revision: 0 } }; },
    apply(state, ev) {
      const mine = state.roles?.[ev.target_id];
      if (!mine?.[ev.data.role]) return; // nothing to reset: no change, no ping
      delete mine[ev.data.role];
      if (!Object.keys(mine).length) delete state.roles[ev.target_id];
      addPing(state, ev, { kind: 'routing', task_id: ev.target_id, detail: { role: ev.data.role, reset: true } });
    }
  },
  // ---- machine pick (J-05 worker-machine-0811): WHERE a task is coordinated and worked, next to the model pick ----
  'machines.set': {
    check({ state, req, actor }) {
      needTask(state, req.target_id);
      const d = req.data, cur = state.machines?.[req.target_id];
      if (d.coordinator === undefined && d.worker_machines === undefined && d.role === undefined && d.machine === undefined) fail(400, 'nothing_to_set', { message: 'send coordinator, worker_machines, or role + machine' });
      if (d.worker_machines && new Set(d.worker_machines).size !== d.worker_machines.length) fail(400, 'duplicate_machine', { worker_machines: d.worker_machines });
      if ((d.role === undefined) !== (d.machine === undefined)) fail(400, 'role_and_machine', { message: 'a slot pick needs both role and machine' });
      for (const m of [d.coordinator, d.machine, ...(d.worker_machines || [])]) if (m !== undefined && !isMachine(m)) fail(400, 'unknown_machine', { machine: m });
      if (cur?.by === 'owner' && actor.role !== 'owner') fail(409, 'owner_set', { message: 'the owner picked these machines; only the owner changes them' });
      const workers = d.worker_machines || resolveMachines(cur).worker_machines;
      if (d.machine !== undefined && !workers.includes(d.machine)) fail(400, 'machine_not_in_workers', { machine: d.machine, worker_machines: workers });
      // What this replaces, journaled so the history reads "old -> new".
      const previous = cur ? { coordinator: cur.coordinator, worker_machines: cur.worker_machines, slots: cur.slots } : null;
      return { data: { ...d, ...(previous ? { previous } : {}) }, result: { id: req.target_id, revision: 0 } };
    },
    apply(state, ev) {
      state.machines ??= {}; // projections written before machine picks existed
      const d = ev.data, cur = state.machines[ev.target_id], was = resolveMachines(cur);
      const workers = d.worker_machines || was.worker_machines;
      // A slot pick that is no longer one of the workers is dropped: the slot falls back to worker_machines[0].
      const slots = Object.fromEntries(Object.entries({ ...cur?.slots, ...(d.role ? { [d.role]: d.machine } : {}) }).filter(([, m]) => workers.includes(m)));
      state.machines[ev.target_id] = { coordinator: d.coordinator || was.coordinator, worker_machines: workers, slots, by: ev.actor.role === 'owner' ? 'owner' : 'coordinator', set_by: ev.actor, at: ev.at };
    }
  },
  // ---- owner pin (J-05 pin-0811): a key task stays at the top of the board for the owner ----
  'pin.set': {
    check({ state, req }) {
      const task = needTask(state, req.target_id);
      // A closed task cannot be pinned: close drops the pin, so a pin taken after close would never be removed.
      if (req.data.pinned && task.status === 'closed') fail(409, 'task_closed', { message: 'a closed task cannot be pinned' });
      return { data: req.data, result: { id: req.target_id, revision: 0 } };
    },
    apply(state, ev) {
      state.pins ??= {}; // projections written before pins existed
      if (!ev.data.pinned) { delete state.pins[ev.target_id]; return; }
      const cur = state.pins[ev.target_id];
      state.pins[ev.target_id] = { pinned_at: cur?.pinned_at || ev.at, by: ev.actor }; // re-pinning keeps the first pin time
    }
  },
  // The decision (count, bump or not) is computed once here and journaled, so replay applies exactly what was decided live.
  // The count sits on a normalised gate key, so "S1 render r1 (timeout)" and "S1 render r2 (slow)" add up. Both the
  // key and the raw text are journaled: replay reads data.gate as stored and never re-normalises an older event.
  'roles.escalate': {
    check({ state, req, actor }) {
      const t = needTask(state, req.target_id);
      // Same CoS-only rule as roles.override (J-05 round 2): a lane that is not CoS must not write a gate failure
      // (the incident: Pi's lane escalated T-31 with "--dry-run" as the reason). The coordinator token carries no
      // lane, so it says which lane it speaks for (data.lane); a token with a lane is checked on actor.lane.
      if (!(actor.role === 'owner' || sameLane(actor.lane, 'CoS') || sameLane(req.data.lane, 'CoS'))) {
        fail(403, 'cos_only', { lane: req.data.lane || null, message: 'roles.escalate is CoS-only: call it with lane "CoS" (or as the owner)' });
      }
      const raw = String(req.data.gate ?? '').trim();
      const gate = normalizeGate(raw);
      if (!gate) fail(400, 'invalid_gate', { gate: raw });
      const d = escalateDecision(t, state.routing, state.roles, state.gate_fails?.[req.target_id], gate);
      return { data: { ...req.data, ...d, gate_raw: raw }, result: { id: req.target_id, revision: 0 } };
    },
    apply(state, ev) {
      state.gate_fails ??= {}; state.roles ??= {};
      const g = ((state.gate_fails[ev.target_id] ??= {})[ev.data.gate] ??= { count: 0, total: 0 });
      g.total += 1; g.last_at = ev.at; g.last_reason = ev.data.reason || '';
      if (ev.data.blocked) g.blocked = ev.data.blocked; else delete g.blocked;
      g.count = ev.data.bump ? 0 : ev.data.count; // a bump starts the new tier with a clean count
      if (ev.data.bump) (state.roles[ev.target_id] ??= {}).code = { ...ev.data.bump, by: 'auto', at: ev.at, gate: ev.data.gate };
    }
  },
  // CoS-only allowance (J-05): Sonnet may work one task code until the journaled expiry. The expiry is computed once
  // here (from the event's own `at`) and journaled, so replay applies exactly what was decided live, never a new clock.
  // A visible note goes on the task's current step; the task row keeps the note after the allowance expires.
  'roles.override': {
    check({ state, req, at, actor }) {
      const t = needTask(state, req.target_id);
      // The server has no lane on a coordinator token: the caller says which lane it speaks for (data.lane), and it must
      // be CoS. A token that carries a lane is checked the same way as every lane-scoped write (actor.lane).
      if (!(actor.role === 'owner' || sameLane(actor.lane, 'CoS') || sameLane(req.data.lane, 'CoS'))) {
        fail(403, 'cos_only', { lane: req.data.lane || null, message: 'roles.override is CoS-only: call it with lane "CoS" (or as the owner)' });
      }
      const reason = String(req.data.reason ?? '').trim();
      if (Array.from(reason).length > 200) fail(400, 'reason_too_long', { max: 200 });
      const clear = req.data.clear === true;
      if (!clear && !reason) fail(400, 'reason_required');
      // Validate the hours before the no-op: a malformed request must not pass just because there is nothing to clear.
      const hours = req.data.hours ?? 24;
      if (!Number.isInteger(hours) || hours < 1 || hours > 72) fail(400, 'hours_out_of_range', { min: 1, max: 72 });
      // A clear with nothing to clear changes nothing: no event, no second "CoS bỏ quyền Sonnet" note (seen live).
      if (clear && !state.route_override?.[req.target_id]) return { noop: true, data: {}, result: { id: req.target_id, revision: 0 } };
      const cur = currentStep(t.step_ids.map(id => state.steps[`${req.target_id}/${id}`]));
      const step_id = cur ? cur.id.slice(cur.id.indexOf('/') + 1) : '';
      const expires = new Date(Date.parse(at) + hours * 3600000).toISOString();
      const note = clear
        ? `CoS bỏ quyền Sonnet${reason ? ': ' + reason : ''}`
        : `CoS cho Sonnet làm: ${reason}, hết hạn ${vnMoment(expires)} giờ VN`;
      return {
        data: { ...(clear ? { clear: true } : { hours, expires }), ...(reason ? { reason } : {}), ...(step_id ? { step_id } : {}), note },
        result: { id: req.target_id, revision: 0 }
      };
    },
    apply(state, ev) {
      state.route_override ??= {}; // projections written before route overrides existed
      const d = ev.data;
      if (d.clear) delete state.route_override[ev.target_id];
      else state.route_override[ev.target_id] = { model: 'sonnet', reason: d.reason, by: 'cos', at: ev.at, expires: d.expires };
      // info: a notice of what CoS changed, not a message anyone must answer or handle. It stays attributed to the
      // actor who wrote it and never counts as an open owner-feedback item (J-05 round 2).
      addFeedback(state, ev, ev.target_id, { ...(d.step_id ? { step_id: d.step_id } : {}), kind: 'note', info: true, text: d.note });
      markActivity(state, ev.target_id, ev.at);
    }
  },
  // ---- goals, re-briefs, reviewer plans: the owner sets the target, reviewers re-plan against it ----
  'goal.lock': {
    check({ state, req }) {
      needTask(state, req.target_id);
      const g = state.goals?.[req.target_id];
      return { data: req.data, result: { id: req.target_id, revision: g ? g.version + 1 : 1 } };
    },
    apply(state, ev) {
      state.goals ??= {};
      const prev = state.goals[ev.target_id], d = ev.data;
      const version = prev ? prev.version + 1 : 1;
      const history = prev ? [...prev.history, pick(prev, ['version', 'goal', 'output', 'outcome', 'locked_at', 'locked_by'])] : [];
      state.goals[ev.target_id] = { task_id: ev.target_id, version, goal: d.goal, output: d.output, outcome: d.outcome, locked_at: ev.at, locked_by: ev.actor, history };
      addFeedback(state, ev, ev.target_id, { kind: 'goal-lock', goal_version: version, text: `Goal locked v${version}\nGoal: ${d.goal}\nOutput: ${d.output}\nOutcome: ${d.outcome}`.slice(0, 8000) });
      addPing(state, ev, { kind: 'goal-lock', task_id: ev.target_id, detail: { version } });
      markActivity(state, ev.target_id, ev.at);
    }
  },
  'goals.import': {
    check({ state, req }) {
      needTask(state, req.target_id);
      if (state.goals?.[req.target_id]) fail(409, 'already_imported');
      return { data: req.data, result: { id: req.target_id, revision: req.data.version } };
    },
    apply(state, ev) {
      state.goals ??= {};
      const d = ev.data;
      state.goals[ev.target_id] = { task_id: ev.target_id, ...pick(d, ['version', 'goal', 'output', 'outcome', 'locked_at']), imported: true, history: (d.history || []).map(h => ({ ...h })) };
    }
  },
  'rebrief.request': {
    check({ state, req, seq }) { needTask(state, req.target_id); return { data: req.data, result: { id: `fb-${seq}`, revision: 1 } }; },
    apply(state, ev) {
      // auto: filed by the board's own freshness sweep (never accepted from a request: the op schema has no such field).
      // It is not the owner's word and not the lane's work, so it neither reads as written by the owner nor moves the activity clock.
      const mode = ev.data.mode || 'strategy', note = (ev.data.note || '').trim(), auto = ev.data.auto === true;
      addFeedback(state, ev, ev.target_id, { kind: 'rebrief', mode, ...(auto ? { auto } : {}), ...(note ? { note } : {}), text: note });
      addPing(state, ev, { kind: 'rebrief', task_id: ev.target_id, detail: { mode, ...(auto ? { auto } : {}) } });
      if (!auto) markActivity(state, ev.target_id, ev.at);
    }
  },
  'plan.add': {
    check({ state, req, seq }) {
      needTask(state, req.target_id);
      const d = { ...req.data };
      if (!d.verdict) { const m = VERDICT_LINE.exec(d.body); if (m) d.verdict = m[1].toLowerCase(); }
      if (d.eta === undefined) { const m = ETA_LINE.exec(d.body); if (m) d.eta = m[1].slice(0, 200); }
      return { data: d, result: { id: `plan-${seq}`, revision: 1 } };
    },
    apply(state, ev) {
      state.plans ??= {};
      const d = ev.data;
      (state.plans[ev.target_id] ??= []).push({ id: ev.result.id, task_id: ev.target_id, reviewer: d.reviewer, verdict: d.verdict || '', ...(d.eta ? { eta: d.eta } : {}), body: d.body, ...(d.written_at ? { written_at: d.written_at } : {}), posted_at: ev.at, goal_version: state.goals?.[ev.target_id]?.version || 0, by: ev.actor });
      markActivity(state, ev.target_id, ev.at);
    }
  },
  'plans.import': {
    check({ state, req }) {
      needTask(state, req.target_id);
      if (state.plans?.[req.target_id]?.length) fail(409, 'already_imported');
      return { data: req.data, result: { id: req.target_id, revision: 0 } };
    },
    apply(state, ev) {
      state.plans ??= {};
      state.plans[ev.target_id] = ev.data.plans.map((p, i) => ({ id: `plan-${ev.seq}-${i + 1}`, task_id: ev.target_id, ...pick(p, ['legacy_id', 'reviewer', 'eta', 'body', 'written_at', 'posted_at']), verdict: p.verdict || '', goal_version: p.goal_version || 0 }));
    }
  },
  'ping.send': {
    check({ state, req, seq, actor }) {
      if (req.data.kind === 'ask' && actor.role !== 'coordinator') fail(403, 'coordinator_only_kind');
      if (req.data.task_id && req.data.task_id !== REQUESTS_THREAD) needTask(state, req.data.task_id);
      return { data: req.data, result: { id: `ping-${seq}`, revision: 0 } };
    },
    apply(state, ev) { addPing(state, ev, { kind: ev.data.kind || 'send', task_id: ev.data.task_id || '', note: (ev.data.note || '').slice(0, 2000) }); }
  },
  'ping.seen': {
    check({ state, req }) {
      const n = (state.pings || []).filter(p => !p.seen_at).length;
      if (!n) fail(409, 'nothing_unseen');
      return { data: req.data, result: { id: 'board', revision: 0 } };
    },
    apply(state, ev) { for (const p of state.pings || []) if (!p.seen_at) p.seen_at = ev.at; }
  },
  'pings.import': {
    check({ state, req }) {
      if ((state.pings || []).length) fail(409, 'already_imported');
      return { data: req.data, result: { id: 'board', revision: 0 } };
    },
    apply(state, ev) {
      state.pings = ev.data.pings.slice(-PING_KEEP).map((p, i) => ({ id: `ping-${ev.seq}-${i + 1}`, ...pick(p, ['legacy_id', 'at', 'task_id', 'note', 'seen_at']), kind: p.kind || 'send', open: p.open || 0 }));
    }
  },
  // A lane finished a turn. The whole check runs inside board.write's synchronous commit (nothing else can write between the asks
  // being read and the event being appended), and the quick report is stored in the event, so replay never recomputes it.
  'turn.report': {
    check({ state, req, seq, at, actor, readEvent }) {
      if (!mayUseLane(actor, req.target_id)) fail(403, 'forbidden_lane', { lane: req.target_id, message: 'a lane token reports only its own lane' });
      const lane = turnLane(state, req.target_id) ?? fail(404, 'unknown_lane', { lane: req.target_id });
      const { turn_id, detail } = req.data;
      if (!detail.trim()) fail(400, 'detail_required');
      const first = state.turn_index?.[lane]?.[turn_id];
      if (first) { // the original quick: from the in-memory history (the usual retry); the journal only once it fell out of the last 50
        const kept = state.turn_history?.[lane]?.find(e => e.seq === first);
        fail(409, 'duplicate_turn', { seq: first, quick: (kept ?? readEvent(first)?.data)?.quick ?? null });
      }
      const quick = buildQuick({ state, lane, at, asks: openLaneAsks(state, lane), changed: state.turn_pending?.[laneKey(lane)] || [] });
      return { data: { turn_id, detail, lane, quick }, result: { id: `turn-${seq}`, revision: 1 }, reveal: { quick } };
    },
    apply(state, ev) {
      const { lane, turn_id, detail, quick } = ev.data;
      ((state.turn_index ??= {})[lane] ??= {})[turn_id] = ev.seq; // (lane, turn_id) -> seq of the first report: idempotence outlives the 50-report history
      const history = ((state.turn_history ??= {})[lane] ??= []);
      history.push({ seq: ev.seq, at: ev.at, turn_id, quick, detail });
      if (history.length > TURN.history) history.splice(0, history.length - TURN.history);
      delete state.turn_pending?.[laneKey(lane)];
    }
  },
  'attachment.add': {
    check({ state, req, seq, config, storeBlob }) {
      needTask(state, req.target_id);
      const d = req.data;
      if (d.step_id) needStep(state, req.target_id, d.step_id);
      const bytes = Buffer.from(d.data_base64, 'base64');
      if (!bytes.length) fail(400, 'empty_attachment');
      if (bytes.length > config.maxAttachmentBytes) fail(413, 'attachment_too_large', { max_bytes: config.maxAttachmentBytes });
      if (!MAGIC[d.mime](bytes)) fail(400, 'content_does_not_match_mime');
      const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      storeBlob(sha256, bytes); // content-addressed; written before the journal line, so a crash leaves at most an orphan blob
      const { data_base64, ...meta } = d;
      return { data: { ...meta, size: bytes.length, sha256 }, result: { id: `att-${seq}`, revision: 1 } };
    },
    apply(state, ev) {
      const d = ev.data;
      state.attachments[ev.result.id] = { id: ev.result.id, task_id: ev.target_id, rev: 1, visibility: d.visibility || 'internal', attribution: attribution(ev), ...pick(d, ['step_id', 'name', 'mime', 'size', 'sha256', 'caption']) };
      markActivity(state, ev.target_id, ev.at);
    }
  },
  'prefs.set': {
    check({ req, actor }) {
      if (req.target_id !== actor.token_id) fail(403, 'own_prefs_only');
      if (!Object.keys(req.data).length) fail(400, 'nothing_to_set');
      return { data: req.data, result: { id: req.target_id, revision: 0 } };
    },
    apply(state, ev) {
      state.prefs ??= {}; // projections written before prefs existed
      state.prefs[ev.target_id] = { ...state.prefs[ev.target_id], ...ev.data, token_id: ev.target_id, updated_at: ev.at };
    }
  },
  'notify.set': {
    // The webhook signing secret must stay usable for HMAC, so it cannot be hashed away like a token: it is
    // written to <data>/webhook.secret before the journal line, and only its sha256 is journaled.
    check({ state, req, webhookSecret }) {
      const { rotate_secret, ...d } = req.data;
      if (!Object.keys(req.data).length) fail(400, 'nothing_to_set');
      const url = d.webhook_url ?? state.notify?.webhook_url;
      let secret;
      if (rotate_secret || (url && !webhookSecret.exists())) secret = webhookSecret.create();
      const secret_sha256 = secret ? crypto.createHash('sha256').update(secret).digest('hex') : undefined;
      return { data: { ...d, ...(secret_sha256 ? { secret_sha256 } : {}) }, result: { id: 'board', revision: 0 }, ...(secret ? { reveal: { webhook_secret: secret } } : {}) };
    },
    apply(state, ev) {
      state.notify = { ...state.notify, ...pick(ev.data, ['coordinator_feedback', 'delivery', 'webhook_url', 'secret_sha256']), updated_at: ev.at };
    }
  },
  'freshness.set': {
    check({ req }) {
      if (!Object.keys(req.data).length) fail(400, 'nothing_to_set');
      return { data: req.data, result: { id: 'board', revision: 0 } };
    },
    apply(state, ev) { state.freshness = { ...state.freshness, ...pick(ev.data, ['stale_h', 'auto_request']), updated_at: ev.at }; }
  },
  'token.issue': {
    check({ state, req, seq, actor }) {
      const d = req.data;
      // A reporter must never hold the human's, the coordinator's or the broadcast lane name: the mailbox stamps
      // `from` from actor.lane, so a reserved lane on a reporter token would let an outsider send as `anh` or `cos`.
      if (d.role === 'reporter' && d.lane && isReservedLane(d.lane)) fail(400, 'reserved_lane', { lane: d.lane, reserved: [...RESERVED_LANES] });
      const active = Object.values(state.tokens).filter(t => !t.revoked_at);
      if (active.some(t => t.name === req.target_id)) fail(409, 'name_taken');
      let replaces;
      if (d.role === 'coordinator') {
        const current = active.find(t => t.role === 'coordinator');
        if (current && !d.replace_coordinator) fail(409, 'coordinator_exists', { coordinator: current.name });
        replaces = current?.id;
      }
      const secret = 'lb_' + crypto.randomBytes(32).toString('base64url');
      const sha256 = crypto.createHash('sha256').update(secret).digest('hex');
      const { replace_coordinator, device, ...meta } = d;
      // The minting token (J-05 D3), so its revoke cascades to what it minted. Only a bearer/app token is a parent: the
      // owner login (proxy) is the htpasswd credential, not tok-1, and must not tie every desktop-minted token to tok-1.
      const parent = actor && !actor.via && state.tokens[actor.token_id] ? actor.token_id : undefined;
      return { data: { ...meta, ...(device ? { device: true } : {}), token_sha256: sha256, ...(replaces ? { replaces } : {}), ...(parent ? { parent } : {}) }, result: { id: `tok-${seq}`, revision: 1 }, reveal: { token: secret } };
    },
    apply(state, ev) {
      const d = ev.data;
      if (d.replaces && state.tokens[d.replaces]) state.tokens[d.replaces].revoked_at = ev.at;
      state.tokens[ev.result.id] = {
        id: ev.result.id, name: ev.target_id, role: d.role, sha256: d.token_sha256, issued_at: ev.at, issued_by: ev.actor.name,
        ...pick(d, ['label', 'lane', 'model', 'device', 'parent']), scope_tasks: d.scope_tasks || ['*']
      };
    }
  },
  'token.revoke': {
    check({ state, req }) {
      const t = state.tokens[req.target_id] || fail(404, 'token_not_found');
      if (t.revoked_at) fail(409, 'already_revoked');
      // Cascade (J-05 D3): every still-active token this one minted, transitively (through revoked links too). Decided
      // once here and journaled, so replay revokes exactly this list. Tokens minted before `parent` existed have none.
      const cascade = [], seen = new Set([t.id]);
      const walk = id => { for (const c of Object.values(state.tokens)) if (c.parent === id && !seen.has(c.id)) { seen.add(c.id); if (!c.revoked_at) cascade.push(c.id); walk(c.id); } };
      walk(t.id);
      return { data: { ...req.data, ...(cascade.length ? { cascade } : {}) }, result: { id: t.id, revision: 0 } };
    },
    apply(state, ev) {
      state.tokens[ev.target_id].revoked_at = ev.at;
      for (const id of ev.data.cascade || []) if (state.tokens[id] && !state.tokens[id].revoked_at) state.tokens[id].revoked_at = ev.at;
    }
  }
};

/** Deterministic reducer: the same journal always yields the same projection. */
export function reduce(state, ev) {
  const op = OPS[ev.op];
  if (!op) throw new Error(`journal contains unknown op ${ev.op} at seq ${ev.seq}`);
  noteLaneWrite(state, ev); // before apply: ask.clear is resolved to its task while the ask is still on the state
  op.apply(state, ev);
  state.requests[ev.request_id] = { body_sha256: ev.body_sha256, event_id: ev.id, seq: ev.seq, token_id: ev.actor.token_id, id: ev.result.id, revision: ev.result.revision };
  state.seq = ev.seq;
}
