// Watcher rules v1, board only (T-31 alpha.12, PLAN-ZUMI-WATCH v1 2.1 rules W1, W3b, W4, W6; v2 F alpha.12 row).
// Pure: board state in, findings out. No I/O of any kind, no imports (scripts/check-watch-readonly.mjs fails on any
// fs / process / network word in this file). The host (watch-host.mjs) decides what to say and relay.
//
// State shape: GET /api/v1/state as the owner reads it (vendor/laneboard/src/views.mjs boardView): tasks[] with
// text_at (when Now/Next last changed), steps[] {id, state}; times[`${task}/${step}`].transitions[] {at, from, to};
// messages[] {id, task_id, author{role}, ts, needs_receipt}; attention.waiting[].
//
// Every finding: { rule, task, key, title, step?, c?, since } -- `key` is a stable fingerprint (rule + task + the stamp
// that made it stale), so one stale thing is one finding until it changes. Codes, step ids, counts and times only.

const MIN = 60_000;
export const W1_LAG_MS = 30 * MIN;        // a step transition newer than Now/Next by more than this (v1 2.1)
export const W3B_MAX_ACTIVE = 3;          // more than this many `active` steps on one task (v1 2.1)
export const RULES = Object.freeze(['W1', 'W3b', 'W4']); // W6 is the check-in count, not a finding (v1 2.1)
const INACTIVE = new Set(['paused', 'closed', 'done']);
const TITLE_MAX = 60;

/** A board message that is the watcher's own relayed line. The bridge writes with the owner's credential, so a merged item
 *  can carry the owner as author; it must not count as the owner acting. */
const isWatchLine = (m) => /^\[zumi-watch /.test(String((m && m.body) || ''));
const ms = (iso) => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? t : null; };
const title = (t) => String((t && t.title) || '').replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX);
const stepKey = (taskId, stepId) => (String(stepId).includes('/') ? String(stepId) : `${taskId}/${stepId}`);
const bareStep = (stepId) => String(stepId).split('/').pop();

/**
 * @param {object} state board state
 * @param {{at: number, receiptMs?: number}} o  at = now; receiptMs = the W4 threshold (rhythm.get().receiptMs, default 1 h)
 * @returns {{findings: object[], waitingCount: number}}
 */
export function runRules(state, { at, receiptMs = 60 * MIN } = {}) {
  const tasks = (Array.isArray(state && state.tasks) ? state.tasks : []).filter((t) => t && typeof t.id === 'string' && !INACTIVE.has(t.status));
  const live = new Map(tasks.map((t) => [t.id, t]));
  const times = state && state.times && typeof state.times === 'object' ? state.times : {};
  const out = [];

  for (const t of tasks) {
    const steps = Array.isArray(t.steps) ? t.steps.filter((s) => s && s.id != null) : [];
    // W1: the newest step transition is more than 30 min newer than the Now/Next text.
    const textAt = ms(t.text_at);
    if (textAt != null) {
      let last = null;
      for (const s of steps) {
        const rec = times[stepKey(t.id, s.id)];
        for (const tr of Array.isArray(rec && rec.transitions) ? rec.transitions : []) {
          const a = ms(tr && tr.at);
          if (a != null && (!last || a > last.at)) last = { at: a, step: bareStep(s.id) };
        }
      }
      if (last && last.at - textAt > W1_LAG_MS && last.at <= at) {
        out.push({ rule: 'W1', task: t.id, key: `W1:${t.id}:${new Date(last.at).toISOString()}`, title: title(t), step: last.step, since: new Date(last.at).toISOString(), textAt: new Date(textAt).toISOString() });
      }
    }
    // W3b: too many active steps at once.
    const active = steps.filter((s) => s.state === 'active').map((s) => bareStep(s.id)).sort();
    if (active.length > W3B_MAX_ACTIVE) {
      out.push({ rule: 'W3b', task: t.id, key: `W3b:${t.id}:${active.length}:${active.join(',')}`.slice(0, 200), title: title(t), c: active.length, since: null });
    }
  }

  // W4: an owner answer the coordinator owes a receipt for (the board's own needs_receipt), older than receiptMs.
  for (const m of Array.isArray(state && state.messages) ? state.messages : []) {
    if (!m || m.needs_receipt !== true || !m.author || m.author.role !== 'owner' || !live.has(m.task_id) || isWatchLine(m)) continue;
    const ts = ms(m.ts);
    if (ts == null || at - ts < receiptMs) continue;
    out.push({ rule: 'W4', task: m.task_id, key: `W4:${m.task_id}:${m.id}`, title: title(live.get(m.task_id)), since: new Date(ts).toISOString() });
  }

  const waiting = state && state.attention && Array.isArray(state.attention.waiting) ? state.attention.waiting.length : 0;
  return { findings: out, waitingCount: waiting };
}

/** One finding -> the plain inbox line for the coordinator (v1 2.3): rule, task, step/count, stamp. No owner text. */
export function inboxLine(f) {
  if (f.rule === 'W1') return `[zumi-watch W1] ${f.task}: step ${f.step} changed ${f.since}, Now/Next text is from ${f.textAt}`;
  if (f.rule === 'W3b') return `[zumi-watch W3b] ${f.task}: ${f.c} steps active at once (${f.key.split(':').slice(3).join(':')})`;
  if (f.rule === 'W4') return `[zumi-watch W4] ${f.task}: owner answer ${f.key.split(':')[2]} from ${f.since} has no receipt`;
  return `[zumi-watch ${f.rule}] ${f.task}`;
}

/**
 * Owner signals for the rhythm core (v2 A.2), from two consecutive board reads: asks that left `attention.waiting`
 * answered (with their created time, for the answer latency) and new owner-authored board messages (an owner board
 * write). The first read is a baseline and reports nothing.
 * @param {object|null} prev the previous return's `snapshot` (null on the first read)
 * @param {object} state
 */
export function ownerSignals(prev, state) {
  const waitingAsks = new Set((state && state.attention && Array.isArray(state.attention.waiting) ? state.attention.waiting : []).filter((w) => w && w.kind === 'ask').map((w) => w.id));
  const asks = Array.isArray(state && state.asks) ? state.asks : [];
  const msgs = (Array.isArray(state && state.messages) ? state.messages : []).filter((m) => m && m.author && m.author.role === 'owner' && ms(m.ts) != null && !isWatchLine(m));
  const lastOwnerTs = msgs.reduce((a, m) => Math.max(a, ms(m.ts)), 0);
  const snapshot = { waitingAsks: [...waitingAsks], lastOwnerTs };
  if (!prev) return { answered: [], writes: [], snapshot };
  const answered = [];
  for (const id of prev.waitingAsks || []) {
    if (waitingAsks.has(id)) continue;
    const a = asks.find((x) => x && x.id === id);
    if (a && a.status === 'answered') {
      const created = ms(a.attribution && a.attribution.created_at);
      if (created != null) answered.push({ askCreatedAt: created });
    }
  }
  const writes = msgs.filter((m) => ms(m.ts) > (prev.lastOwnerTs || 0)).map((m) => ({ task: m.task_id }));
  return { answered, writes, snapshot: { ...snapshot, lastOwnerTs: Math.max(lastOwnerTs, prev.lastOwnerTs || 0) } };
}
