// Pure model of the board state for the Brain views: no DOM, no I/O. Input is the `state` of GET /api/v1/state (boardView body,
// vendor/laneboard/src/views.mjs): tasks[] (each with steps[] and current_step), asks[], attachments[], plans{taskId:[...]},
// times{"task/step":{transitions[]}}, attention.waiting[]. Everything a task detail shows is selected by that task's id here, and
// nowhere else, so one scripted check (scripts/check-brain.mjs, AC-B2) covers the whole scoping rule.
const arr = (v) => (Array.isArray(v) ? v : []);
const text = (v) => (typeof v === 'string' ? v : '');
const shortId = (id) => String(id ?? '').split('/').pop();

export const CLOSED_STATUSES = new Set(['closed', 'paused']);
export const isLive = (task) => !CLOSED_STATUSES.has(task.status);

/** Ids of the tasks that wait on the owner (the board's own attention list). */
export function waitingTaskIds(state) {
  return new Set(arr(state && state.attention && state.attention.waiting).map((w) => w && w.task_id).filter(Boolean));
}

/** Library rows in the board's own order. Live tasks by default; `showClosed` adds paused and closed. `query` is a case-insensitive
 *  substring over id, title, lane and the Now line (client-side only: no index, no host call). */
export function libraryRows(state, { showClosed = false, query = '' } = {}) {
  const waiting = waitingTaskIds(state);
  const q = String(query).trim().toLowerCase();
  return arr(state && state.tasks)
    .filter((t) => t && typeof t.id === 'string' && (showClosed || isLive(t)))
    .filter((t) => !q || [t.id, t.title, t.lane, t.now].some((f) => text(f).toLowerCase().includes(q)))
    .map((t) => ({
      id: t.id, title: text(t.title) || t.id, status: t.status, lane: text(t.lane), health: t.health || 'grey',
      needsOwner: waiting.has(t.id), lastActivity: t.last_activity_at || null, stepCount: arr(t.steps).length,
    }));
}

/** { live, total } for the header count. */
export function libraryCounts(state) {
  const tasks = arr(state && state.tasks).filter((t) => t && typeof t.id === 'string');
  return { live: tasks.filter(isLive).length, total: tasks.length };
}

/** One task's whole detail, or null when the task is not on the board. Open asks first, then answered ones; plans newest first. */
export function taskDetail(state, id) {
  const task = arr(state && state.tasks).find((t) => t && t.id === id);
  if (!task) return null;
  const mine = (list) => arr(list).filter((r) => r && r.task_id === id);
  const currentId = task.current_step && task.current_step.id;
  const steps = arr(task.steps).map((s) => ({
    id: s.id, short: shortId(s.id), label: text(s.label) || shortId(s.id), sub: text(s.sub), detail: text(s.detail),
    state: s.state || 'todo', zone: s.zone || 'build', current: Boolean(currentId) && shortId(currentId) === shortId(s.id),
    history: arr(state.times && state.times[s.id] && state.times[s.id].transitions).map((x) => ({ at: x.at, from: x.from, to: x.to })),
  }));
  const asks = mine(state.asks);
  return {
    task, id: task.id, title: text(task.title) || task.id, status: task.status, lane: text(task.lane), health: task.health || 'grey',
    goal: text(task.goal), now: text(task.now), next: text(task.next), context: text(task.context), dossier: text(task.dossier),
    needsOwner: waitingTaskIds(state).has(id), lastActivity: task.last_activity_at || null,
    steps,
    asks: [...asks.filter((a) => a.status === 'open'), ...asks.filter((a) => a.status !== 'open')],
    plans: arr(state.plans && state.plans[id]).slice().reverse(),
    media: mine(state.attachments),
  };
}
