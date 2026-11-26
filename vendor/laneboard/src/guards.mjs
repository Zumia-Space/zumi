// "Drive to goal" guards (J-05 / W-42 design B, board/w42-GUARD-DESIGN.md sections 1, 3 and 5). Pure functions, no I/O.
// The board turns them on with createBoard({ guardsSince }) (env BOARD_GUARDS_SINCE): writes at or after that moment are
// checked (B1, B2) and the idle detector runs (B4). Off = every write and every view is what it was before this file.
// The progress of a task with phases (B3) is always derived: a task without phases has none.
//
//   B1  an owner wait needs an ask: a step may ENTER `waiting` in zone `owner` only with an open ask on it (any lane), or
//       with one raised by the same write (a task.create open question naming the step). Steps that already wait are left
//       as they are (existing data stays readable; the idle detector shows them).
//   B2  goal QC at open: a new task carries goal_check, phases[] and open_questions[]; every open question becomes an ask in
//       the same write. Changing the phases' ids or labels later needs a replan reason (state-only changes are progress).
//   B3  progress = done phases / phases.
//   B4  idle: open steps, no owner wait, no fresh run stamp on an active step, no legit park, not grey/paused/closed, and
//       nothing moved on the task for IDLE_MS.

/**
 * How long a run stamp `run:<id>@<iso>` counts as a running worker, and how long a task counts as moving after its
 * creation or its last step state change. 3 h = the board's own stall limit (board.mjs DEFAULTS.stallMs), the
 * value the board already uses for "nobody touched this task" (GUARD-DESIGN 7.3: the same value as lane activity).
 * A worker run is capped at 30 min (run-worker --timeout-ms 1800000) and a supervised retry stays well inside 3 h, so a
 * stamp older than that is not a live run; a shorter limit would flag a task between two dispatches of one turn.
 */
export const IDLE_MS = 3 * 3600000;
/** How often the server re-checks every task (a run stamp ages out with no write): 10 min, well under IDLE_MS. */
export const IDLE_SWEEP_MS = 10 * 60000;
/** A stamp a few minutes in the future (a dispatcher's clock ahead of the server's) still counts. */
const CLOCK_SKEW_MS = 5 * 60000;

const INACTIVE = new Set(['paused', 'closed']);
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const HISTORY_STEP = 'lich-su';
const shortId = key => key.slice(key.indexOf('/') + 1);

/** `run:<id>@<iso>` in a step's sub; the time must carry Z or an offset (a bare local time means nothing on a server). */
const RUN_STAMP = /\brun:[^\s@]+@(\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:?\d\d))/g;
/** True when `sub` carries a run stamp no older than IDLE_MS at `nowMs`. */
export function freshRunStamp(sub, nowMs) {
  for (const m of String(sub ?? '').matchAll(RUN_STAMP)) {
    const age = nowMs - Date.parse(m[1]);
    if (age <= IDLE_MS && age >= -CLOCK_SKEW_MS) return true;
  }
  return false;
}
// Legit park: a blocked step whose sub reads `resume when <condition>; owner <lane|anh>` (a DD-MM date before it is fine).
// Same expression as the CLI's board-delta.mjs isLegitPark: the board and the CoS tools must agree on what a park is.
const PARK_RE = /^(?:\d{2}-\d{2}\b[\s\u00b7:\-]*)?resume when\s+[^;\s].*;\s*owner\s+[^\s;.][^;]*$/i;
export const isLegitPark = s => s?.state === 'blocked' && PARK_RE.test(String(s.sub ?? '').trim());

const openAskOn = (state, taskId, stepId) => Object.values(state.asks || {}).some(a => a.status === 'open' && a.task_id === taskId && a.step_id === stepId);
const waitsOnOwner = s => !!s && s.state === 'waiting' && s.zone === 'owner';
// J-05 times-waiting (19-11): a blocked step that says "owner anh" is a wait on the owner too, written as a park. V-04 had two
// that said "owner anh, question open" while no ask was open: the owner never saw them. Same rule as a waiting owner step: the
// owner needs an open ask (a park points at the question, which may sit on another step, so any open ask of the task covers it).
// A pause anh ordered himself is the explicit step field paused_by (with his quote and the time), never a reading of the text: such a step
// is a stop, not a hidden wait, so it needs no ask and is never listed as waiting on him (Opus gate 20-11 G-PAUSE).
export const blockedOnOwner = s => !!s && s.state === 'blocked' && s.paused_by !== 'anh' && /(?<![\w-])owner\s+anh(?![\w-])/i.test(String(s.sub ?? ''));
const holdsOwner = s => waitsOnOwner(s) || blockedOnOwner(s);
const openAskOnTask = (state, taskId) => Object.values(state.asks || {}).some(a => a.status === 'open' && a.task_id === taskId);
/** True when an open ask already answers for step `s` of `taskId` (a waiting step needs its own; a blocked park, any of the task's). */
const askedFor = (state, taskId, stepId, s) => (waitsOnOwner(s) ? openAskOn(state, taskId, stepId) : openAskOnTask(state, taskId));
export const ownerWaitMessage = 'a step waiting on the owner needs an open ask on it, or the owner never sees it: post the ask in the same push (v1: raise it on the step with ask.raise first, or name the step in an open question of task.create)';

/**
 * B1 for one v1 write: [{ error, task, step, message }] for every step the write moves INTO an owner wait with no open ask.
 * task.create counts its own open_questions; step.create can never carry an ask, so it creates the step first in another state.
 */
export function ownerWaitWithoutAsk(state, req) {
  const d = isObj(req.data) ? req.data : {};
  const target = typeof req.target_id === 'string' ? req.target_id : '';
  const v = (task, step) => ({ error: 'waiting_owner_without_ask', task, step, message: ownerWaitMessage });
  switch (req.op) {
    case 'task.create': {
      const qs = Array.isArray(d.open_questions) ? d.open_questions : [], asked = new Set(qs.map(q => q?.step_id).filter(Boolean));
      return (Array.isArray(d.steps) ? d.steps : []).filter(s => (waitsOnOwner(s) && !asked.has(s.id)) || (blockedOnOwner(s) && !qs.length)).map(s => v(target, s.id));
    }
    case 'step.create':
      return holdsOwner(d) && !(blockedOnOwner(d) && openAskOnTask(state, target.split('/')[0])) ? [v(target.split('/')[0], shortId(target))] : [];
    case 'step.update': {
      const s = state.steps?.[target];
      if (!s || holdsOwner(s)) return [];
      const after = { ...s, ...('state' in d ? { state: d.state } : {}), ...('zone' in d ? { zone: d.zone } : {}), ...('sub' in d ? { sub: d.sub } : {}), ...('paused_by' in d ? { paused_by: d.paused_by } : {}) };
      return holdsOwner(after) && !askedFor(state, s.task_id, shortId(target), after) ? [v(s.task_id, shortId(target))] : [];
    }
    case 'inbox.merge': {
      const item = state.inbox?.[target];
      if (d.action !== 'accept' || !item || item.kind !== 'step' || item.resolution) return [];
      const s = state.steps?.[`${item.task_id}/${item.step_id}`];
      if (!s || holdsOwner(s)) return [];
      const after = { ...s, state: item.state };
      return holdsOwner(after) && !askedFor(state, item.task_id, item.step_id, after) ? [v(item.task_id, item.step_id)] : [];
    }
    default:
      return [];
  }
}

/** B2: the goal-QC fields a task.create lacks ([] = complete). An empty open_questions list is an answer ("nothing to ask"). */
export function goalQcMissing(d) {
  const missing = [];
  if (typeof d?.goal_check !== 'string' || !d.goal_check.trim()) missing.push('goal_check'); // an object is not a goal check: the legacy adapter formats it first (src/goal-text.mjs), and one with no command/URL formats to nothing
  if (!Array.isArray(d?.phases) || !d.phases.length) missing.push('phases');
  if (!Array.isArray(d?.open_questions)) missing.push('open_questions');
  return missing;
}
export const GUARDS_OFF_MESSAGE = 'open_questions need the board guards on (BOARD_GUARDS_SINCE): with them off a question would be dropped or written as an ask an older build cannot read; raise the asks with ask.raise instead';
export const GOAL_QC_MESSAGE = 'a new task opens with its goal QC: goal_check (command or URL + expected result), phases[] {id,label,state} and open_questions[] (each becomes an owner ask now; [] when there is none)';

/** True when `next` changes the phases' plan (ids, labels or their order), not just their states. No old phases = a first set. */
export function isReplan(prev, next) {
  if (!Array.isArray(prev) || !prev.length) return false;
  const plan = list => JSON.stringify((list || []).map(p => [p.id, p.label]));
  return plan(prev) !== plan(next);
}

/** B3: { done, total } for a task with phases, else null (no phases = no bar). */
export const progressOf = phases => (Array.isArray(phases) && phases.length ? { done: phases.filter(p => p.state === 'done').length, total: phases.length } : null);

/**
 * B4: null, or { steps } (the open step ids) when the task is idle at `nowMs`: it has open steps, nothing waits on the owner
 * (a waiting owner step with an open ask), no active step carries a fresh run stamp, no step is a legit park, it is not
 * grey/paused/closed, and neither its creation nor any step state change is younger than IDLE_MS (a task just opened or a
 * step just moved is somebody's live work; a text-only push does not count, so bumping the row cannot hide it).
 */
export function idleOf(state, task, nowMs) {
  if (!task || INACTIVE.has(task.status) || task.health === 'grey') return null;
  const steps = task.step_ids.filter(id => id !== HISTORY_STEP).map(id => state.steps[`${task.id}/${id}`]).filter(Boolean);
  const open = steps.filter(s => s.state !== 'done');
  if (!open.length) return null;
  if (steps.some(s => waitsOnOwner(s) && openAskOn(state, task.id, shortId(s.id)))) return null;
  if (steps.some(s => s.state === 'active' && freshRunStamp(s.sub, nowMs))) return null;
  if (steps.some(isLegitPark)) return null;
  const moved = Math.max(Date.parse(task.attribution?.created_at) || 0, ...steps.map(s => Date.parse(s.state_at || s.attribution?.created_at) || 0));
  if (nowMs - moved < IDLE_MS) return null;
  return { steps: open.map(s => shortId(s.id)) };
}

/** J-05 working status (src/work.mjs): true when the task has an open step a worker should be on: neither a wait on the owner
 *  (waiting zone owner, or a park naming anh), nor a legit park, nor a stop anh ordered (paused_by). */
export function needsWorker(state, task) {
  const steps = task.step_ids.filter(id => id !== HISTORY_STEP).map(id => state.steps[`${task.id}/${id}`]).filter(Boolean);
  return steps.some(s => s.state !== 'done' && !holdsOwner(s) && !isLegitPark(s) && s.paused_by !== 'anh');
}

/** The feedback text an idle episode sends to the task's lane. */
export const idleText = steps => `Đứng yên (idle): open steps ${steps.join(', ')}; nothing waits on the owner, no worker run stamp, no park. Do one now: dispatch the next step (stamp run:<id>@<iso> in its sub), ask the owner (an ask on the step), or park it (blocked, sub "resume when <condition>; owner <lane|anh>").`;

// ---- phase rules (J-05 phase-view-0911, owner 09-11: "phải sửa phía laneboard rules") ----
// On from createBoard({ phaseRulesSince }) (env BOARD_PHASE_RULES_SINCE), a switch of its own so it can go on and off
// without touching the guards above. Off = every write and view is what it was.
//   R1  a new step on a task with phases names one of them; a task with no phases takes no new open step past
//       PHASES_AT_OPEN open steps and no new goal until it has phases.
//   R2  a new phase plan (the first one, or a replan) is a new era: the done steps of the old plan fold into `lich-su`.
//   R4  an owner message CoS received or handled stays "unanswered on the board" until a CoS message replies to it (a reply, a note, or a
//       receipt with Đổi / Lịch / Bước tiếp); per message, not per task.

/** More open steps than this, with no phases, is a task nobody can follow by step: it gets phases first (V-04 had 5 open
 *  of 52 at its worst; T-31 rows run 6-8 open). A code constant on purpose, like STEP_CAP. */
export const PHASES_AT_OPEN = 8;
export const PHASE_REQUIRED_MESSAGE = 'this task has phases: a new step names one of them (step `phase`, a phase id of the task)';
export const PHASES_REQUIRED_MESSAGE = `a task with no phases takes no new goal, and no new open step past ${PHASES_AT_OPEN} open steps: set its phases first (task phases [{id,label,state}], with replanReason when it already had some)`;
const isOpen = s => s && s.state !== 'done' && shortId(s.id ?? '') !== HISTORY_STEP;

/**
 * R1 for one v1 write: [{ error, task, step?, ... }] (empty = fine). Reads the task as it stands; a task.create that
 * carries phases checks its own steps against them.
 */
export function phaseViolations(state, req) {
  const d = isObj(req.data) ? req.data : {};
  const target = typeof req.target_id === 'string' ? req.target_id : '';
  const ids = phases => (Array.isArray(phases) ? phases.map(p => p.id) : []);
  const check = (taskId, phases, stepId, phase) => {
    if (!phase) return { error: 'phase_required', task: taskId, step: stepId, phases: phases, message: PHASE_REQUIRED_MESSAGE };
    if (!phases.includes(phase)) return { error: 'phase_unknown', task: taskId, step: stepId, phase, phases, message: PHASE_REQUIRED_MESSAGE };
    return null;
  };
  switch (req.op) {
    case 'task.create': {
      const ph = ids(d.phases);
      if (!ph.length) return [];
      return (Array.isArray(d.steps) ? d.steps : []).filter(s => s.id !== HISTORY_STEP).map(s => check(target, ph, s.id, s.phase)).filter(Boolean);
    }
    case 'step.create': {
      const taskId = target.split('/')[0], t = state.tasks?.[taskId];
      if (!t) return [];
      const ph = ids(t.phases);
      if (ph.length) { const v = check(taskId, ph, shortId(target), d.phase); return v ? [v] : []; }
      if (d.phase) return [{ error: 'phase_unknown', task: taskId, step: shortId(target), phase: d.phase, phases: [], message: 'this task has no phases yet: set them on the task before a step names one' }];
      if (d.state === 'done') return [];
      const open = t.step_ids.map(id => state.steps[`${taskId}/${id}`]).filter(isOpen).length + 1;
      return open > PHASES_AT_OPEN ? [{ error: 'phases_required', task: taskId, step: shortId(target), open_steps: open, limit: PHASES_AT_OPEN, message: PHASES_REQUIRED_MESSAGE }] : [];
    }
    case 'step.update': {
      if (d.phase === undefined) return [];
      const s = state.steps?.[target], t = s && state.tasks[s.task_id];
      if (!t) return [];
      const v = check(t.id, ids(t.phases), shortId(target), d.phase);
      return v ? [v] : [];
    }
    case 'task.update': {
      const t = state.tasks?.[target];
      if (!t || d.goal === undefined || d.goal === t.goal) return [];
      return ids(d.phases ?? t.phases).length ? [] : [{ error: 'phases_required', task: target, message: PHASES_REQUIRED_MESSAGE }];
    }
    default:
      return [];
  }
}

/** R2: true when `next` starts a new era over `prev`: a first phase plan on a task, or a replan (ids, labels, order). */
export const isNewEra = (prev, next) => Array.isArray(next) && next.length > 0 && (!Array.isArray(prev) || !prev.length || isReplan(prev, next));

/** Owner message kinds that say something CoS must answer in the thread (a sweep, a pick from a plan, a goal lock do not). */
const SAYS = new Set(['note', 'approve', 'reject', 'choice', 'redirect', 'askback']);

/** A coordinator receipt ("Nhận") answers an owner message with three lines: what changed, the schedule, the next step. */
const RECEIPT_LINES = { change: /^[ 	*_-]*Đổi[ 	*_]*:[ 	]*(.+)$/im, schedule: /^[ 	*_-]*Lịch[ 	*_]*:[ 	]*(.+)$/im, next: /^[ 	*_-]*Bước tiếp[ 	*_]*:[ 	]*(.+)$/im };
export function parseReceipt(text) {
  const out = {};
  for (const [k, re] of Object.entries(RECEIPT_LINES)) { const m = re.exec(String(text || '').normalize('NFC')); if (m && m[1].trim()) out[k] = m[1].trim().slice(0, 500); }
  return Object.keys(out).length === 3 ? out : null;
}
/** A receipt with content: its three parts stored by the board, or (an imported record) three lines in its text. A bare "đã nhận" is neither. */
const isStructuredReceipt = f => f.kind === 'receipt' && (Object.keys(RECEIPT_LINES).every(k => String(f.receipt?.[k] ?? '').trim()) || !!parseReceipt(f.text));

/**
 * R4: per task, the owner messages written at/after `sinceMs` that CoS received (receipt) or handled (resolved) and nobody
 * has answered. { [taskId]: [{ feedback_id, at }] }. Pure.
 *
 * An owner message is answered by a coordinator message that replies to it (reply_to): a reply or note, or a receipt with its
 * three parts (Đổi / Lịch / Bước tiếp). A bare acknowledgement, an informational notice and the board's own writes do not
 * answer. It is per message: another CoS message in the thread names a different message, so it clears nothing here.
 * Messages older than `perMessageSinceMs` (default: `sinceMs`, so none) keep the rule they were written under: any later
 * coordinator reply, note or cos-report in the task's thread clears them (a receipt only for the message it replies to).
 */
export function unansweredOnBoard(state, sinceMs, perMessageSinceMs = sinceMs) {
  const all = Object.values(state.feedback || {});
  const cosAt = {}, answered = new Set();
  for (const f of all) {
    const by = f.attribution?.created_by;
    if (by?.role !== 'coordinator' || f.info || by.token_id === 'system') continue;
    if (f.reply_to && (isStructuredReceipt(f) || ['reply', 'note'].includes(f.kind))) answered.add(f.reply_to);
    if (f.kind === 'receipt' || !['reply', 'note', 'cos-report'].includes(f.kind)) continue;
    const at = f.attribution.created_at;
    if (!cosAt[f.task_id] || at > cosAt[f.task_id]) cosAt[f.task_id] = at;
  }
  const out = {};
  for (const f of all) {
    const by = f.attribution?.created_by, at = f.attribution?.created_at || '';
    if (by?.role !== 'owner' || by.token_id === 'system' || f.auto || !SAYS.has(f.kind) || !state.tasks?.[f.task_id]) continue;
    if (Date.parse(at) < sinceMs || !(f.received || f.status === 'resolved')) continue;
    if (answered.has(f.id)) continue;
    if (Date.parse(at) < perMessageSinceMs && cosAt[f.task_id] && cosAt[f.task_id] >= at) continue;
    (out[f.task_id] ??= []).push({ feedback_id: f.id, at });
  }
  return out;
}
