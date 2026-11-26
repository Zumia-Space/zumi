// Task timing and ask ages from the board's own timestamps. One copy, used by the server (src/views.mjs: the view's
// `measured` and the owner-attention `since`) and by the page (public/app.js), which recomputes both from the view's
// raw records (times, task_times, steps, asks). So a page newer than the server it reads shows the current rules: the
// Zumi app pins this page and reads the live board's view (10-10: F-04 "worked 1 s / waited 18 d", and a re-asked
// question that restarted at "1m").
//
// Loaded as a classic script in the browser (sets window.LaneMeasure) and importable in Node (sets globalThis.LaneMeasure).
(function (root) {
  'use strict';

  /** Waiting intervals [fromMs, toMs] of one step record, rebuilt from its transitions; a wait still open runs to now.
   *  A closed wait whose start is not in the kept history (the server keeps the last 100 transitions; an imported
   *  total may have none) is known only by length (waiting_total_ms): it is placed to end where the kept history starts. */
  function waitIntervals(r, nowMs) {
    const out = [], tr = r.transitions || [];
    let since = null, closed = 0, headEnd = null;
    tr.forEach((x, i) => {
      const at = Date.parse(x.at);
      if (x.from === 'waiting') { if (since != null) { out.push([since, at]); closed += at - since; } else if (i === 0) headEnd = at; since = null; }
      if (x.to === 'waiting') since = at;
    });
    if (r.waiting_since) out.push([Date.parse(r.waiting_since), nowMs]);
    const rest = (r.waiting_total_ms || 0) - closed;
    if (rest > 0) { const end = headEnd ?? (tr.length ? Date.parse(tr[0].at) : Date.parse(r.first_seen_at) + rest); out.push([end - rest, end]); }
    return out;
  }

  /** Length of the union of intervals, clipped to [lo, hi]: two steps waiting on the owner at once are one wait. */
  function unionMs(intervals, lo, hi) {
    const xs = intervals.map(([a, b]) => [Math.max(a, lo), Math.min(b, hi)]).filter(([a, b]) => b > a).sort((p, q) => p[0] - q[0]);
    let total = 0, a0 = null, b0 = null;
    for (const [a, b] of xs) {
      if (b0 == null || a > b0) { if (b0 != null) total += b0 - a0; a0 = a; b0 = b; } else if (b > b0) b0 = b;
    }
    return b0 == null ? total : total + b0 - a0;
  }

  /**
   * Measured time of one task: work = end - start - waiting on the owner, where end is the moment every current step
   * was done (now while any step is open, so a task reopened with new steps keeps counting) and waiting on the owner
   * is the time at least one step in zone 'owner' waited, inside [start, end]. The predecessor board summed the waits
   * of every step of any zone, so parallel waits counted twice and a build step parked in 'waiting' counted as the
   * owner's. A step no longer on the board has no zone; its waits are not counted. null until some step has started.
   * @param {object} o
   * @param {object} o.times      step time records keyed '<task>/<step>' (state.times / view.times)
   * @param {object} o.taskTimes  task time records keyed by task id (state.task_times / view.task_times)
   * @param {Array<{id:string, zone?:string, state?:string}>} o.steps  the task's current steps, ids '<task>/<step>'
   * @param {string} o.taskId
   * @param {number} o.nowMs
   */
  function measuredTimes({ times, taskTimes, steps, taskId, nowMs }) {
    const prefix = taskId + '/';
    const own = Object.entries(times || {}).filter(([k]) => k.startsWith(prefix));
    const zone = new Map((steps || []).map(s => [s.id, s.zone]));
    const tt = taskTimes?.[taskId];
    const started = tt?.started_at || own.map(([, r]) => r.started_at).filter(Boolean).sort()[0];
    if (!started) return null;
    const open = (steps || []).some(s => s.state !== 'done');
    let doneAt = open ? undefined : tt?.done_at; // done_at is never cleared: a task reopened with new steps is not done
    if (!tt && (steps || []).length && !open) { // records from before task-level times: derive from the current steps
      const done = steps.map(s => times[s.id]?.done_at);
      if (done.every(Boolean)) doneAt = done.sort().at(-1);
    }
    const start = Date.parse(started), end = doneAt ? Date.parse(doneAt) : nowMs;
    const wait = unionMs(own.filter(([k]) => zone.get(k) === 'owner').flatMap(([, r]) => waitIntervals(r, nowMs)), start, end);
    return { started_at: started, ...(doneAt ? { done_at: doneAt } : {}), work_ms: Math.max(0, end - start - wait), wait_ms: wait };
  }

  /** An ask's own time: its waiting_since, else the time the predecessor board recorded for an imported ask (origin "legacy <lane> <time>"), else when it was raised. */
  function askOwnAt(a) {
    const legacy = (/^legacy \S+ (\S+)$/.exec(a.attribution?.created_by?.origin || '') || [])[1];
    return a.waiting_since || legacy || a.attribution.created_at;
  }

  /**
   * Since when the owner has been asked this question: the ask's OWN time (askOwnAt). A re-ask (a lane rewrote the text, added a
   * link, or the CLI cleared and raised again) is a new ask and starts again at its own raise time (owner 11-11: GW read 22 d for
   * an ask raised 10 days ago, T-31-STREAM 12.7 d for 9.5). The 10-11 chain rule, which walked a re-ask back to the first cleared
   * ask on the same step, is gone: it made every refreshed question inherit the age of the first one. An imported ask keeps the
   * earlier time its source recorded (waiting_since, or the legacy origin time), because that IS when it was raised.
   * @param {object} ask an ask record (attribution.created_at, waiting_since)
   * @returns {string} ISO time
   */
  function askSince(ask) { return askOwnAt(ask); }

  /** The items of one task that are a wait on the owner: everything but a wait about one owner message (an answer the coordinator
   *  has not picked up, kind 'unreceived'; a message no agent session received, kind 'undelivered', J-05 delivery). */
  function rowWaits(items) { return (items || []).filter(w => w.kind !== 'unreceived' && w.kind !== 'undelivered'); }

  /**
   * THE age rule of a task's wait on the owner, used by every surface (the rail and Home, the page's task header, and the
   * board's /state askAt that the reminder hook reads), so they cannot drift:
   *  - an open ask counts from its own raise time (askSince = askOwnAt; a re-ask restarts it);
   *  - a waiting owner step with NO ask on it counts from its waiting_since;
   *  - a step an open ask sits on is skipped: its old waiting_since does not count (owner 10-11: a new question filed on an
   *    old reused step, W-41, read 4.8 days);
   *  - the row's age is the oldest OPEN one of those items (the rail and Home add the count as xN). An item the owner already answered (kind 'unreceived') is the
   *    coordinator's move, not a wait, and is left out unless nothing else waits.
   * The server builds the items (src/views.mjs ownerAttention: asks, proposals, uncovered steps, each with `since`).
   * @param {{task_id?: string, kind: string, since: string}[]} items the view's attention.waiting items of ONE task
   * @returns {string} ISO time of the oldest item, '' when there is none
   */
  function rowWaitSince(items) {
    const waits = rowWaits(items), pool = waits.length ? waits : items || [];
    return pool.reduce((old, w) => (!old || Date.parse(w.since) < Date.parse(old) ? w.since : old), '');
  }

  /**
   * The Needs-you rail: one entry per task, however many things wait on the owner there (owner 10-11: F-04, L-01 and C-54
   * each showed twice). The entry is the task's OLDEST item by rowWaitSince, so its age is the row's age and the link opens
   * that ask; `count` is how many items the task has. Longest wait first.
   * @param {{task_id: string, kind: string, since: string, age_ms: number}[]} waiting the view's attention.waiting items
   * @returns {object[]} the oldest item of each task plus { count, items }
   */
  function needRows(waiting) {
    const byTask = new Map();
    for (const w of waiting || []) { const g = byTask.get(w.task_id); if (g) g.push(w); else byTask.set(w.task_id, [w]); }
    return [...byTask.values()].map(items => {
      const since = rowWaitSince(items);
      items.sort((x, y) => (x.kind === 'unreceived') - (y.kind === 'unreceived') || y.age_ms - x.age_ms);
      return { ...(items.find(w => w.since === since) || items[0]), count: items.length, items };
    }).sort((x, y) => y.age_ms - x.age_ms);
  }

  /** A step the CLI minted for an ask (`cos-board ask`: id ask-<MMDDHHmm>, label = the ask's first line, or "Anh quyết"): its label says nothing the ask text does not. */
  const AUTO_STEP = /^ask-/;
  const clipText = (s, n) => { const c = String(s || '').replace(/\s+/g, ' ').trim(); return c.length > n ? c.slice(0, n - 1).trimEnd() + '…' : c; };

  /**
   * Home's Needs-you list: one group per task (owner 10-15: T-31 showed the same task title three times), each with its items.
   * Groups are oldest-first by rowWaitSince (the age rule of the rail), items oldest-first inside a group. Every item gets a
   * `label`: its step's title when the step is a real one, else the first 60 characters of the ask text with whitespace
   * collapsed. A step title shared by several items of the task would repeat the very duplicate this removes, so those use the text.
   * @param {object[]} waiting the view's attention.waiting items (with since / age_ms)
   * @param {{id: string, steps: {id: string, label: string}[]}[]} tasks the view's tasks
   * @returns {{task_id: string, since: string, age_ms: number, count: number, items: object[]}[]}
   */
  function needGroups(waiting, tasks) {
    const stepLabel = new Map();
    for (const t of tasks || []) for (const s of t.steps || []) stepLabel.set(s.id, String(s.label || '').trim());
    const byTask = new Map();
    for (const w of waiting || []) { const g = byTask.get(w.task_id); if (g) g.push(w); else byTask.set(w.task_id, [w]); }
    return [...byTask.entries()].map(([task_id, list]) => {
      const items = [...list].sort((a, b) => a.since.localeCompare(b.since) || a.id.localeCompare(b.id));
      const real = w => (w.kind === 'step' ? w.text : w.step_id && !AUTO_STEP.test(w.step_id) ? stepLabel.get(`${task_id}/${w.step_id}`) : '') || '';
      const stepTitles = items.map(real);
      const labelled = items.map((w, i) => ({ ...w, label: stepTitles[i] && stepTitles.filter(x => x === stepTitles[i]).length === 1 ? stepTitles[i] : clipText(w.text, 60) || stepTitles[i] || w.id }));
      const since = rowWaitSince(items);
      return { task_id, since, age_ms: (items.find(w => w.since === since) || items[0]).age_ms, count: items.length, items: labelled };
    }).sort((a, b) => a.since.localeCompare(b.since) || a.task_id.localeCompare(b.task_id));
  }

  /** A report is "fresh" for this long after its step went done (owner 10-15: he could not find the T-31 report). */
  const FRESH_REPORT_MS = 48 * 3600000;

  /** When a step last went done: its newest transition into done, else the record's done_at. '' if it never did. */
  function stepDoneAt(rec) {
    const last = (rec?.transitions || []).filter(x => x.to === 'done').map(x => x.at).sort().at(-1);
    return last || rec?.done_at || '';
  }

  /** A done step that has a report (a non-blank detail) and went done within the last 48 h starts expanded. */
  function freshReport(step, rec, nowMs) {
    if (!step || step.state !== 'done' || !String(step.detail || '').trim()) return false;
    const at = Date.parse(stepDoneAt(rec));
    return Number.isFinite(at) && nowMs - at >= 0 && nowMs - at <= FRESH_REPORT_MS;
  }

  var DEFAULT_TZ = 'Asia/Ho_Chi_Minh', fmtCache = {};
  /** "dd-mm HH:mm" in the owner's zone (config.owner_tz, default Asia/Ho_Chi_Minh) for an ISO time; null for nothing or a non-time.
   *  The one formatter: the server (src/times.mjs), the CLI's readers and the page all show a moment the same way. */
  function formatLocal(iso, tz) {
    if (!iso) return null;
    var ms = Date.parse(iso);
    if (!isFinite(ms)) return null;
    var zone = tz || DEFAULT_TZ, f = fmtCache[zone];
    if (!f) {
      try { f = new Intl.DateTimeFormat('en-GB', { timeZone: zone, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); }
      catch (e) { zone = DEFAULT_TZ; f = fmtCache[zone] || new Intl.DateTimeFormat('en-GB', { timeZone: zone, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); }
      fmtCache[zone] = fmtCache[tz || DEFAULT_TZ] = f;
    }
    var p = {};
    f.formatToParts(new Date(ms)).forEach(function (x) { p[x.type] = x.value; });
    return p.day + '-' + p.month + ' ' + p.hour + ':' + p.minute;
  }

  /** Steps of one phase in time order: earliest stamps.created_at first, a step with no known time last, the board's order breaks
   *  ties. A copy; the input order is the board's. */
  function timeOrder(steps) {
    return steps.map(function (s, i) { return { s: s, i: i, at: (s.stamps && s.stamps.created_at) || '' }; })
      .sort(function (a, b) { return (a.at && b.at ? (a.at < b.at ? -1 : a.at > b.at ? 1 : 0) : a.at ? -1 : b.at ? 1 : 0) || a.i - b.i; })
      .map(function (x) { return x.s; });
  }

  root.LaneMeasure = { formatLocal, timeOrder, waitIntervals, unionMs, measuredTimes, askSince, askOwnAt, rowWaits, rowWaitSince, needRows, needGroups, stepDoneAt, freshReport };
})(typeof window !== 'undefined' ? window : globalThis);
