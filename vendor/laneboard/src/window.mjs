// The state window: which ask and feedback records GET /api/v1/state carries.
//
// Cause of the 8.9 MB state (live 11-11, +0.6 MB a day): the view listed every ask and every feedback record the board ever stored,
// and feedback a second time as `messages`. 1900 asks, 23 of them open; 2542 feedback records, 1248 "open" only because a coordinator
// reply or receipt is never resolved. Nothing was inlined media; it is plain history that nobody reads on every poll.
//
// Rule: a record is LIVE (always served) or RECENT (touched inside `days`); everything else is archived and served per task by
// GET /api/v1/history. Archiving is a view rule only: nothing is stored differently, so a rollback to an older release reads
// the same data and serves the old full view.
import { messagesView } from './views.mjs';

export const DAY_MS = 86400000;
const ms = iso => Date.parse(iso) || 0;
const seqOf = id => Number(/-(\d+)$/.exec(id)?.[1] ?? 0);

/** Last time anything happened to an ask: raised, updated, cleared or answered. */
const askTouched = a => Math.max(ms(a.attribution?.created_at), ms(a.attribution?.updated_at), ms(a.cleared?.at), ms(a.answer?.at));

/** Every record id the default view serves, as { asks:Set, feedback:Set }. `messages` is messagesView(state) (its pickup links are followed). */
export function liveSets(state, messages, nowMs, days) {
  const cutoff = nowMs - days * DAY_MS;
  const asks = new Set(), feedback = new Set();
  // The newest re-brief of a task is the task's "plan requested" state (the page shows it until a plan is posted after it).
  const newestRebrief = {};
  for (const f of Object.values(state.feedback)) if (f.kind === 'rebrief' && f.mode !== 'status') {
    const cur = state.feedback[newestRebrief[f.task_id]];
    if (!cur || f.attribution.created_at > cur.attribution.created_at) newestRebrief[f.task_id] = f.id;
  }
  for (const a of Object.values(state.asks)) if (a.status === 'open' || askTouched(a) >= cutoff) asks.add(a.id);
  for (const f of Object.values(state.feedback)) {
    const lane = f.attribution.created_by.role === 'coordinator'; // its replies and receipts keep status open for ever; they are history once old
    if (ms(f.attribution.created_at) >= cutoff || (f.status === 'open' && !lane) || f.plan_id || newestRebrief[f.task_id] === f.id) feedback.add(f.id);
  }
  // Records a served record points at come along, so a thread keeps its shape: the parent of a reply, the pickup of a message,
  // the ask a message is scoped to or answers, the message that answered an ask.
  const byId = new Map(messages.map(m => [m.id, m]));
  for (let grew = true; grew;) {
    grew = false;
    const add = (set, id, exists) => { if (id && exists && !set.has(id)) { set.add(id); grew = true; } };
    for (const id of [...feedback]) {
      const f = state.feedback[id], m = byId.get(id);
      add(feedback, f.reply_to, state.feedback[f.reply_to]);
      add(feedback, m?.received?.receipt_id || m?.received?.reply_id, state.feedback[m?.received?.receipt_id || m?.received?.reply_id]);
      add(asks, f.ask_id || f.scope_ask_id || m?.answers_ask_id, state.asks[f.ask_id || f.scope_ask_id || m?.answers_ask_id]);
    }
    for (const id of [...asks]) add(feedback, state.asks[id].answer?.feedback_id, state.feedback[state.asks[id].answer?.feedback_id]);
  }
  return { asks, feedback };
}

/** What a task's archive holds: a `block` for the view ({ days, cutoff, trimmed }) from the counts. */
export function windowBlock(state, live, nowMs, days) {
  const by_task = {};
  let asks = 0, fb = 0;
  for (const a of Object.values(state.asks)) if (!live.asks.has(a.id)) { asks++; by_task[a.task_id] = (by_task[a.task_id] || 0) + 1; }
  for (const f of Object.values(state.feedback)) if (!live.feedback.has(f.id)) { fb++; by_task[f.task_id] = (by_task[f.task_id] || 0) + 1; }
  return { days, cutoff: new Date(nowMs - days * DAY_MS).toISOString(), trimmed: { asks, feedback: fb, by_task } };
}

/** Newest-first order of archived records: raise time, then id (numeric part), so a cursor is exact even for equal times. */
const key = r => [r.attribution.created_at, seqOf(r.id), r.id];
const newer = (a, b) => { const x = key(a), y = key(b); return x[0] < y[0] ? 1 : x[0] > y[0] ? -1 : y[1] - x[1] || (x[2] === y[2] ? 0 : x[2] < y[2] ? 1 : -1); };
const cursorOf = r => `${r.attribution.created_at}|${r.id}`;

/**
 * One page of a task's archived records. `limit` counts asks and feedback together; `before` is the previous page's `next_before`.
 * Returns { asks, feedback, messages, has_more, next_before }, each list in the shape the state view serves it.
 */
export function historyPage(state, taskId, live, { before = '', limit = 200 } = {}) {
  const cur = before ? (() => { const i = before.lastIndexOf('|'); return { attribution: { created_at: before.slice(0, i) }, id: before.slice(i + 1) }; })() : null;
  const items = [
    ...Object.values(state.asks).filter(a => a.task_id === taskId && !live.asks.has(a.id)).map(r => ({ k: 'asks', r })),
    ...Object.values(state.feedback).filter(f => f.task_id === taskId && !live.feedback.has(f.id)).map(r => ({ k: 'feedback', r }))
  ].sort((x, y) => newer(x.r, y.r)).filter(x => !cur || newer(cur, x.r) < 0);
  const page = items.slice(0, limit);
  const fbIds = new Set(page.filter(x => x.k === 'feedback').map(x => x.r.id));
  return {
    asks: page.filter(x => x.k === 'asks').map(x => x.r),
    feedback: page.filter(x => x.k === 'feedback').map(x => x.r),
    messages: messagesView(state).filter(m => fbIds.has(m.id)).reverse(), // newest first, like the page of records
    has_more: items.length > page.length,
    next_before: page.length ? cursorOf(page.at(-1).r) : ''
  };
}
