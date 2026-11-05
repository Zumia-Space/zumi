// Turn reports (op turn.report): a lane says it finished a turn. Everything here is pure; ops.mjs does the checks and the
// storage. The quick report is built on the server, inside the write, from the board as it is at that moment, so it cannot
// drift from the board and a client never sends one. No model call: the Vietnamese line and the spoken line are templates.

export const TURN = { detail: 8000, askText: 80, asks: 8, changed: 10, history: 50, readDefault: 20, lineAsks: 2, labelChars: 40, speechWords: 25 };
const TZ = 'Asia/Ho_Chi_Minh';
const lower = s => String(s ?? '').trim().toLowerCase();
const words = s => String(s).split(/\s+/).filter(Boolean);
/** The first `n` Unicode characters of `s`, whitespace folded to single spaces. */
export const clip = (s, n) => Array.from(String(s ?? '').replace(/\s+/g, ' ').trim()).slice(0, n).join('');

export const sameLane = (a, b) => lower(a) === lower(b) && lower(a) !== '';
/** Key of the per-lane "written since the last report" list in the projection. */
export const laneKey = lower;

/**
 * Owner and coordinator: every lane. A lane token (a reporter token that has a lane AND reads every task, scope_tasks "*"): its own
 * lane. Anyone else: none. A scoped reporter (an outsider limited to some tasks) is refused whole: it cannot read, nor write, a report,
 * because a quick report quotes asks and names tasks outside its scope.
 */
export function mayUseLane(actor, lane) {
  if (!actor) return false;
  if (actor.role === 'owner' || actor.role === 'coordinator') return true;
  return actor.role === 'reporter' && !!actor.lane && !!actor.scope_tasks?.includes('*') && sameLane(actor.lane, lane);
}

// ---- `changed`: the tasks a lane's OWN token wrote since that lane's previous report ----
// The journal records the author of an event as its token (actor). Only a lane token (role reporter, with a lane) says which
// lane wrote; the owner and the coordinator write for every lane, so their writes count for none. The list is kept in the
// projection and filled by the reducer (reduce() calls noteLaneWrite), so it needs no journal scan and replays identically.
const TASK_WRITES = new Set(['task.create', 'task.update', 'task.delete', 'step.create', 'step.update', 'step.delete', 'ask.raise', 'ask.clear', 'inbox.submit', 'attachment.add', 'plan.add', 'feedback.add']);
/** The task an accepted write touched, read from the state BEFORE the event is applied; null when the op is not a task write. */
function writtenTask(state, ev) {
  if (!TASK_WRITES.has(ev.op)) return null;
  const t = ev.target_id;
  if (ev.op.startsWith('step.')) return t.slice(0, t.indexOf('/'));
  if (ev.op === 'ask.clear') return state.asks[t]?.task_id ?? null;
  if (ev.op === 'feedback.add') return state.tasks[t] ? t : null; // NEW (the new-task thread) is not a task
  return t;
}
export function noteLaneWrite(state, ev) {
  const a = ev.actor;
  if (a.role !== 'reporter' || !a.lane) return;
  const task = writtenTask(state, ev);
  if (!task) return;
  const list = ((state.turn_pending ??= {})[laneKey(a.lane)] ??= []);
  if (list.length < TURN.changed && !list.includes(task)) list.push(task);
}

// ---- the quick report ----
/** HH:mm on the Vietnam clock, from an ISO instant. */
export const hhmm = at => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(at));

/** What the owner is asked, in a few words: the step the ask waits on, else the ask's own text. */
const askLabel = (state, a, max) => clip(state.steps[`${a.task_id}/${a.step_id}`]?.label || a.text, max);

/**
 * Text made fit for a voice by WHITELIST: only whole words made of letters survive. Anything with a digit, a path or URL character,
 * other punctuation inside (a dash between letters is fine) is dropped as a whole token (T-31, J05, s21, 4f66d1d, D:/x/y.md, https://..., 1234), as are
 * all-caps acronyms (PR, OK), single capital letters and hash-like runs of a-f (7+). Edge punctuation is trimmed first. A conjunction
 * left at either end ("và") is cut. At most `max` words. Numbers are never spoken from text: the counts are written by `speech`.
 */
function speakable(label, max = 6) {
  const edge = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;
  const kept = words(label).map(w => w.replace(edge, ''))
    .filter(w => /^\p{L}+(-\p{L}+)*$/u.test(w) && !(w !== w.toLowerCase() && w === w.toUpperCase()) && !/^[a-f]{7,}$/i.test(w)); // the caps test only for scripts that have case
  while (kept.length && kept[0].toLowerCase() === 'và') kept.shift();
  while (kept.length && kept.at(-1).toLowerCase() === 'và') kept.pop();
  return kept.slice(0, max).join(' ');
}

/** The line the avatar speaks: the lane, how many things wait on the owner, and up to two of them by label. At most 25 words. */
function speech(state, lane, asks, total) {
  const head = `${speakable(lane, 4) || 'Agent'} vừa xong một lượt.`;
  if (!total) return words(head).slice(0, TURN.speechWords).join(' ');
  const labels = asks.slice(0, TURN.lineAsks).map(a => speakable(askLabel(state, a, 200))).filter(Boolean);
  const build = k => {
    const shown = labels.slice(0, k), more = total - shown.length;
    const list = !shown.length ? '' : more > 0 ? `: ${shown.join(', ')} và ${more} việc nữa` : shown.length > 1 ? `: ${shown.slice(0, -1).join(', ')} và ${shown.at(-1)}` : `: ${shown[0]}`;
    return `${head} Có ${total} việc chờ anh${list}.`;
  };
  let k = labels.length, out = build(k);
  while (words(out).length > TURN.speechWords && k > 0) out = build(--k);
  return words(out).slice(0, TURN.speechWords).join(' ');
}

/**
 * TurnQuick = { line, asks: [{ id, task, step_id, text }], changed: [task] }, plus `speech` (the voice line the Zumi avatar speaks).
 * `asks` = the lane's open asks, oldest first, already ordered by the caller; the count in the line is their total, the array
 * keeps the first 8. `line` is at most three lines of Vietnamese.
 */
export function buildQuick({ state, lane, at, asks, changed }) {
  const total = asks.length;
  const head = `${lane} xong 1 lượt (${hhmm(at)})${changed.length ? ` · đổi: ${changed.join(', ')}` : ''}`;
  const shown = asks.slice(0, TURN.lineAsks).map(a => `${a.task_id} ${askLabel(state, a, TURN.labelChars)} (${a.id})`);
  const waiting = total ? `Chờ anh ${total} việc: ${shown.join(' · ')}${total > shown.length ? ' · …' : ''}` : '';
  return {
    line: waiting ? `${head}\n${waiting}` : head,
    asks: asks.slice(0, TURN.asks).map(a => ({ id: a.id, task: a.task_id, step_id: a.step_id || null, text: clip(a.text, TURN.askText) })),
    changed: changed.slice(0, TURN.changed),
    speech: speech(state, lane, asks, total)
  };
}

// ---- read models ----
/** { <lane>: { seq, at, quick } }: the latest report of every lane the actor may read. */
export function latestTurns(state, actor) {
  const out = {};
  for (const [lane, history] of Object.entries(state.turn_history || {})) {
    const last = history.at(-1);
    if (last && mayUseLane(actor, lane)) out[lane] = { seq: last.seq, at: last.at, quick: last.quick };
  }
  return out;
}
/** One lane's reports, newest first. */
export const turnList = (state, lane, limit) => (state.turn_history?.[lane] || []).slice(-limit).reverse();
