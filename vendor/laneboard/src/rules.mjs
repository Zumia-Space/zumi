// Board honesty rules. Pure functions, no I/O. Ported from the J-05 board (board-rules.mjs, live 30-09) with the
// same behaviour; only the record shape is Laneboard's (task `id` instead of `code`, step keys `TASK/STEP`).
//
//   1. invalid_step_state   every step state is one of STEP_STATES; missing or unknown -> violation.
//   2. waiting_before_done  a 'waiting' step (an open ask) sitting before a later 'done' step in the same task is a
//                           violation: the ask was overtaken by newer work, so showing it as current would lie.
//                           s21: "in the same task" means of the same lane -- steps carry a `lane` (the effective one: the
//                           step's own, else the task's). A done step of Vesta does not overtake Pi's ask on the same task;
//                           without lanes (every step the same lane) the rule is exactly what it was.
//   3. waiting_status_without_ask  a task may carry status 'waiting' (waiting on the owner) only while the owner has
//                           something to answer on it: an open ask, an unresolved ask proposal in the inbox, or a
//                           step waiting in zone 'owner'. Otherwise the label would claim a wait the owner block
//                           cannot show. Checked when a write sets that status (task.create, task.update).
//   4. Any violation rejects the whole write (board.write), nothing is journaled, and the error lists them all.
//   5. currentStep is derived here, on every read; no client computes it and no write can set it.
//
// board.write() calls violationsForWrite() on EVERY write that can change step states or their order (task.create,
// step.create, step.update, step.delete, task.update with step_order, inbox.merge accepting a step proposal) or set a
// task status, before the op's own checks. Importers and scripts write
// through board.write too, so they get the same guarantees; the journal replay does not re-check history.

/** Same set, same order as the J-05 board. Kept equal to schema/v1/common.json#/$defs/stepState (test/rules.test.mjs). */
export const STEP_STATES = ['done', 'active', 'waiting', 'todo', 'blocked'];

/**
 * Every violation in `tasks` ([{ id, steps: [{ id, state }] }], steps in board order); [] = valid.
 * Each violation is { error, task, step } (+ `state` for invalid_step_state); `step` is the short step id, or
 * `#<n>` when the step has none. Tolerant of malformed input: it never throws.
 */
export function validateTasks(tasks) {
  const violations = [];
  for (const t of Array.isArray(tasks) ? tasks : []) {
    const task = t && t.id != null ? String(t.id) : '';
    const steps = Array.isArray(t && t.steps) ? t.steps : [];
    const stepName = (s, i) => (s && s.id != null ? String(s.id) : `#${i + 1}`);
    steps.forEach((s, i) => {
      if (!s || !STEP_STATES.includes(s.state)) violations.push({ error: 'invalid_step_state', task, step: stepName(s, i), state: s ? s.state ?? null : null });
    });
    const laneOf = s => (s && s.lane) || '', lastDone = new Map();
    steps.forEach((s, i) => { if (s && s.state === 'done') lastDone.set(laneOf(s), i); });
    steps.forEach((s, i) => {
      if (s && s.state === 'waiting' && i < (lastDone.get(laneOf(s)) ?? -1)) violations.push({ error: 'waiting_before_done', task, step: stepName(s, i) });
    });
  }
  return violations;
}

/**
 * The one step the board calls "current": first active, else first waiting, else first blocked, else first todo;
 * all done (or no steps) -> null. `steps` are step records in board order; returns { id, label, state } with the
 * record's own id (the `TASK/STEP` key in a view).
 */
export function currentStep(steps) {
  const list = Array.isArray(steps) ? steps : [];
  for (const state of ['active', 'waiting', 'blocked', 'todo']) {
    const s = list.find(x => x && x.state === state);
    if (s) return { id: s.id, label: s.label, state: s.state };
  }
  return null;
}

const shortId = key => key.slice(key.indexOf('/') + 1);
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

/** The task's steps as they would be after `req` is applied, or null when `req` cannot change a step state. */
function stepsAfter(state, req) {
  const d = isObj(req.data) ? req.data : {};
  const target = typeof req.target_id === 'string' ? req.target_id : '';
  const lane = (taskId, step) => step?.lane || state.tasks[taskId]?.lane || '';
  const current = taskId => (state.tasks[taskId]?.step_ids || []).map(id => ({ id, state: state.steps[`${taskId}/${id}`]?.state, lane: lane(taskId, state.steps[`${taskId}/${id}`]) }));
  const withState = (taskId, stepId, to) => current(taskId).map(s => (s.id === stepId ? { ...s, state: to } : s));
  switch (req.op) {
    case 'task.create':
      return { id: target, steps: Array.isArray(d.steps) ? d.steps.map(s => (isObj(s) ? { id: s.id, state: s.state, lane: s.lane || d.lane || '' } : s)) : [] };
    case 'step.create': {
      const taskId = target.split('/')[0];
      if (!state.tasks[taskId] || state.steps[target]) return null; // the op's own check answers 404 / 409
      return { id: taskId, steps: [...current(taskId), { id: shortId(target), state: d.state, lane: d.lane || state.tasks[taskId].lane || '' }] };
    }
    case 'step.update': {
      if (!('state' in d) || !state.steps[target]) return null; // no state change, or 404 from the op's check
      const taskId = target.split('/')[0];
      return { id: taskId, steps: withState(taskId, shortId(target), d.state) };
    }
    case 'step.delete': {
      if (!state.steps[target]) return null; // 404 from the op's check
      const taskId = target.split('/')[0];
      return { id: taskId, steps: current(taskId).filter(s => s.id !== shortId(target)) };
    }
    case 'task.update': {
      const order = d.step_order, t = state.tasks[target];
      if (!Array.isArray(order) || !t) return null; // not a reorder (a bad order is the op's own 400)
      const byId = new Map(current(target).map(s => [s.id, s]));
      if (order.length !== byId.size || order.some(id => !byId.has(id))) return null;
      return { id: target, steps: order.map(id => byId.get(id)) };
    }
    case 'inbox.merge': {
      const item = state.inbox[target];
      if (d.action !== 'accept' || !item || item.kind !== 'step' || item.resolution || !state.steps[`${item.task_id}/${item.step_id}`]) return null;
      return { id: item.task_id, steps: withState(item.task_id, item.step_id, item.state) };
    }
    default:
      return null;
  }
}

/** Rule 3 for a write that sets status 'waiting'; `steps` = the task's steps after the write (with zone), or null. */
function statusViolations(state, req) {
  const d = isObj(req.data) ? req.data : {};
  if (d.status !== 'waiting' || (req.op !== 'task.create' && req.op !== 'task.update')) return [];
  const taskId = typeof req.target_id === 'string' ? req.target_id : '';
  const steps = req.op === 'task.create'
    ? (Array.isArray(d.steps) ? d.steps.filter(isObj) : [])
    : (state.tasks[taskId]?.step_ids || []).map(id => state.steps[`${taskId}/${id}`]).filter(Boolean);
  const ownerStep = steps.some(s => s.state === 'waiting' && s.zone === 'owner');
  const openAsk = Object.values(state.asks || {}).some(a => a.task_id === taskId && a.status === 'open');
  const proposal = Object.values(state.inbox || {}).some(i => i.task_id === taskId && i.kind === 'ask' && !i.resolution);
  return ownerStep || openAsk || proposal ? [] : [{ error: 'waiting_status_without_ask', task: taskId }];
}

/** Violations a write would leave on the task it touches ([] for writes that cannot change step states or set a status). */
export function violationsForWrite(state, req) {
  const task = stepsAfter(state, req);
  return [...(task ? validateTasks([task]) : []), ...statusViolations(state, req)];
}
