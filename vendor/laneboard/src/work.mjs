// J-05 "Đang làm" (working status, PLAN working-status §1, §3): which task has an agent run right now, on which session and
// machine, and how long it has been silent. Owner 21-11: "Board anh cần update thêm 1 trạng thái đang làm working để anh biết
// được em đang điều phối task nào và kỹ hơn nữa phiên nào đang nhận".
//
// Source: each connector's presence beat carries runs[] (the subagent runs of the sessions it serves, read off the harness files
// on its own machine). Runs live in the in-memory presence map only, replaced per machine on every beat, never journaled: an older
// board drops the field (free rollback). Nothing here is set by a model, and nobody recomputes it: /api/v1/work and the `work`
// field of /api/v1/state are this one function's output.
//
// Privacy: a run is whitelisted to the fields below; the task code is parsed out of the dispatch description ON the machine and
// only the code travels. A run with an unknown key is dropped whole, so a prompt or description can never be stored by mistake.
import { resolveMachines } from './machines.mjs';
import { needsWorker } from './guards.mjs';

/** A run whose transcript moved less than this long ago is live work (working); older, it is stale (amber, "Im N phút"). */
export const RUN_FRESH_MS = 15 * 60000;
/** A task with open work and no run for this long reads red (nobody); shorter, the same state without the alarm. */
export const NOBODY_RED_MS = 30 * 60000;
/** Runs one beat may carry (the connector sends the newest this many). */
export const RUNS_MAX = 20;
/** Same freshness as delivery (src/delivery.mjs PRESENCE_STALE_MS): three missed 30 s beats and a machine is offline. */
const PRESENCE_STALE_MS = 90000;
const RUN_FIELDS = Object.freeze(['id', 'task', 'step', 'lane', 'session_id', 'kind', 'model', 'started_at', 'last_seen', 'source']);
const RUN_SOURCES = Object.freeze(['subagent', 'supervisor']);
const RUNS_ERRORS = Object.freeze(['home_unreadable', 'scan_failed']);
const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const RULES = {
  id: v => /^[A-Za-z0-9_-]{1,64}$/.test(v),
  task: v => CODE_RE.test(v),
  step: v => CODE_RE.test(v),
  lane: v => v.length >= 1 && v.length <= 64,
  session_id: v => v.length >= 1 && v.length <= 80,
  kind: v => /^[a-z][a-z0-9-]{0,39}$/.test(v),
  model: v => /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/.test(v),
  started_at: v => v.length <= 40 && Number.isFinite(Date.parse(v)),
  last_seen: v => v.length <= 40 && Number.isFinite(Date.parse(v)),
  source: v => RUN_SOURCES.includes(v)
};
const REQUIRED = ['id', 'lane', 'session_id', 'last_seen', 'source'];
/** One run, whitelisted: the clean run, or null when any key is unknown, a required field is missing or a value breaks its rule. */
function cleanRun(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r) || Object.keys(r).some(k => !RUN_FIELDS.includes(k))) return null;
  const run = {};
  for (const k of RUN_FIELDS) {
    if (r[k] === undefined || r[k] === null) { if (REQUIRED.includes(k)) return null; continue; }
    if (typeof r[k] !== 'string' || !RULES[k](r[k])) return null;
    run[k] = r[k];
  }
  return run;
}

/**
 * The runs part of a presence beat: { runs?, runs_error?, runs_dropped? } ({} when the beat carries none). Never throws (Opus gate
 * S1): a bad run is dropped (never stored) and counted, so one bad run cannot reject the beat and take the machine offline for
 * delivery. Runs past RUNS_MAX are dropped the same way; runs that are not a list read as runs_error scan_failed (unmeasured).
 */
export function checkRuns(body) {
  const out = {};
  if (RUNS_ERRORS.includes(body.runs_error)) out.runs_error = body.runs_error;
  if (body.runs === undefined) return out;
  if (!Array.isArray(body.runs)) return { runs_error: 'scan_failed' };
  const clean = body.runs.map(cleanRun).filter(Boolean);
  out.runs = clean.slice(0, RUNS_MAX);
  const dropped = body.runs.length - out.runs.length;
  return dropped ? { ...out, runs_dropped: dropped } : out;
}

const online = (p, nowMs) => nowMs - p.atMs < PRESENCE_STALE_MS;
const measuredBy = p => Array.isArray(p.runs) && !p.runs_error;
/** Opus gate N2: the board's own age cap, whatever the connector's runs_max_age_ms: a run silent over RUN_MAX_AGE_MS (a kill never
 *  sets finished) or seen more than CLOCK_SKEW_MS in the future is no run. */
export const RUN_MAX_AGE_MS = 3 * 3600000;
const CLOCK_SKEW_MS = 5 * 60000;
/** The runs inside the board's cap (the same filter for the views and for "nobody since", Opus re-gate R2-N1). */
export const cappedRuns = (runs, nowMs) => (runs || []).filter(r => { const age = nowMs - Date.parse(r.last_seen); return age <= RUN_MAX_AGE_MS && age >= -CLOCK_SKEW_MS; });
const runsOf = (p, nowMs) => cappedRuns(p.runs, nowMs);
const ageOf = (r, nowMs) => nowMs - Date.parse(r.last_seen);
const iso = ms => new Date(ms).toISOString();
/** Opus gate nit: keeps a run's task (and step) only when they name a board task (step); any other leading word of a description is
 *  dropped at the beat, never held in memory, and the run reads "chưa gắn task". */
export function knownRuns(state, runs) {
  return runs.map(({ task, step, ...r }) => {
    const known = task && state.tasks[task];
    return { ...r, ...(known ? { task } : {}), ...(known && step && state.steps[`${task}/${step}`] ? { step } : {}) };
  });
}
/** The time the task last moved: its creation or a step state change, as guard B4 counts it (src/guards.mjs idleOf). */
function movedAt(state, task) {
  const steps = task.step_ids.map(id => state.steps[`${task.id}/${id}`]).filter(Boolean);
  return Math.max(Date.parse(task.attribution?.created_at) || 0, ...steps.map(s => Date.parse(s.state_at || s.attribution?.created_at) || 0));
}

/**
 * The working state of one task at `nowMs`, or null when it has none to show (closed or paused, or no open step that needs a
 * worker and no run). `presence` = the board's in-memory map (machine -> { machine, atMs, lanes, runs?, runs_error? }).
 *   working     a run on an online machine moved under freshMs ago           { since: first start, lane, machine, model, runs }
 *   stale       runs on an online machine, none fresh                         { since: last move, lane, machine, model, runs }
 *   nobody      no run, an open step that is neither an owner wait nor a park { since: last run or step move, alarm after NOBODY_RED_MS }
 *   unmeasured  a worker machine of the task has no online connector reporting runs, or the board booted under 90 s ago (never red)
 * opts: { bootMs, freshMs = RUN_FRESH_MS, lastRunMs (task -> last time a run of it was seen, in memory) }
 */
export function workOf(state, task, presence, nowMs, { bootMs = 0, freshMs = RUN_FRESH_MS, lastRunMs = {} } = {}) {
  const live = Object.values(presence).filter(p => online(p, nowMs));
  const runs = live.flatMap(p => runsOf(p, nowMs).filter(r => r.task === task.id).map(r => ({ ...r, machine: p.machine })));
  const pick = list => list.reduce((a, b) => (Date.parse(b.last_seen) > Date.parse(a.last_seen) ? b : a));
  const who = r => ({ lane: r.lane, machine: r.machine, ...(r.model ? { model: r.model } : {}), ...(r.step ? { step: r.step } : {}) });
  const fresh = runs.filter(r => ageOf(r, nowMs) < freshMs);
  if (fresh.length) {
    const first = Math.min(...fresh.map(r => Date.parse(r.started_at || r.last_seen)));
    return { state: 'working', since: iso(first), ...who(pick(fresh)), runs: fresh.length };
  }
  if (runs.length) { const r = pick(runs); return { state: 'stale', since: r.last_seen, ...who(r), runs: runs.length }; }
  if (['paused', 'closed'].includes(task.status) || task.health === 'grey' || !needsWorker(state, task)) return null;
  // Opus gate B1: EVERY machine the task's work runs on must report runs; the coordinator's machine (main, nearly always) reporting
  // alone says nothing about a worker on spare or the laptop, and would paint that task red.
  const workers = resolveMachines(state.machines?.[task.id]).worker_machines;
  const measured = nowMs - bootMs >= PRESENCE_STALE_MS && workers.every(id => live.some(p => p.machine === id && measuredBy(p)));
  if (!measured) return { state: 'unmeasured', since: null };
  const since = Math.max(movedAt(state, task), lastRunMs[task.id] || 0);
  return { state: 'nobody', since: iso(since), ...(nowMs - since >= NOBODY_RED_MS ? { alarm: true } : {}) };
}

/**
 * GET /api/v1/work (and `work` in /api/v1/state): { at, fresh_ms, sessions[], runs[], tasks{CODE: state} }.
 * sessions: one per lane a connector serves (machine, lane, session_id, status, online, measured, runs = its run count);
 * runs: every run on an online machine, newest first, with its machine, age_ms and state; a code that names no board task reads
 * as task null (untagged). `scopeTasks` (a reporter's scope) limits tasks and runs; sessions are left out for such a reader.
 */
export function workView(state, presence, nowMs, opts = {}) {
  const freshMs = opts.freshMs ?? RUN_FRESH_MS, scoped = !!opts.scopeTasks && !opts.scopeTasks.includes('*');
  const inScope = code => !scoped || opts.scopeTasks.includes(code);
  const sessions = [], runs = [];
  for (const p of Object.values(presence).sort((a, b) => a.machine.localeCompare(b.machine))) {
    const on = online(p, nowMs);
    for (const l of p.lanes) {
      const mine = runsOf(p, nowMs).filter(r => r.session_id === l.session_id);
      sessions.push({ machine: p.machine, lane: l.lane, ...(l.session_id ? { session_id: l.session_id } : {}), status: l.status, online: on, measured: on && measuredBy(p), runs: on ? mine.length : 0 });
    }
    if (!on) continue;
    for (const { step, session_id, ...r } of runsOf(p, nowMs)) {
      const task = r.task && state.tasks[r.task] ? r.task : null, age = ageOf(r, nowMs);
      if (!inScope(task)) continue;
      const known = task && step && state.steps[`${task}/${step}`];
      // a scoped reader (reporter) sees the run, not the session it belongs to (as delivery hides session_id from it)
      runs.push({ ...r, task, ...(known ? { step } : {}), ...(scoped ? {} : { session_id }), machine: p.machine, age_ms: age, state: age < freshMs ? 'working' : 'stale' });
    }
  }
  runs.sort((a, b) => a.age_ms - b.age_ms);
  const tasks = {};
  for (const t of Object.values(state.tasks)) {
    if (!inScope(t.id)) continue;
    const w = workOf(state, t, presence, nowMs, { ...opts, freshMs });
    if (w) tasks[t.id] = w;
  }
  return { at: iso(nowMs), fresh_ms: freshMs, ...(scoped ? {} : { sessions }), runs, tasks };
}
