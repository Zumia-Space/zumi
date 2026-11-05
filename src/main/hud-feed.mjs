// HUD feed (T-31 hud-react, 13-10; ASTRA-PLAN v8 steps 5-6): the board state -> what the talk-camera HUD shows, which
// updates are new, when Zumi may speak, and the one-shot consent to open an acceptance file. Pure decisions only (no
// Electron, no I/O but the injected `decide`/`open`), so scripts/check-hud.mjs tests every gate under plain Node;
// hud-host.mjs wires them to the board reader, powerMonitor, settings and shell.
//
// State shape: GET /api/v1/state as the owner sees it (vendor/laneboard/src/views.mjs boardView): tasks[] with
// steps[], current_step {id,label,state}, last_activity_at, rev; attention.waiting[] {kind,id,task_id,text,rev,since}.

import quickSpeech from './quick-speech.js';
const { quickSpeechText, stepLabelOf } = quickSpeech;

const INACTIVE_STATUS = new Set(['paused', 'closed']);
export const MAX_UPDATES = 5;
export const MAX_WAITING = 4;
// Panel caps (T-31 hud-panels, PLAN section 2). The T1/T2/T3 panels render these per-task fields; each one is bounded so
// one long-lived task can never grow a 'hud:feed' message without limit. The true totals travel beside the caps
// (stepTotal / askCount), so the panel never has to guess.
export const MAX_STEPS = 40; // the step list a panel reads (stepTotal keeps the real count)
export const MAX_LOG = 12; // the step-log tail a panel shows, newest last
export const MAX_DONE = 100; // ISO times of finished steps, newest first (the 7-day chart)
const SNIPPET = 140;
const PANEL_SNIPPET = 240; // goal / now: the board's own 2000-char notes, cut for one panel line
const HEALTH = new Set(['green', 'yellow', 'red', 'grey']);

/** A board text line that is only a ref (a link or a local path), the rule waitOut.text already used. */
const REF_LINE = /^\s*(\[[^\]]+\]\(https?:|`[A-Za-z]:)/;
/** Board text -> the same text with its ref lines dropped. The board appends a ref line under a step's detail, now/next;
 *  the panels show the sentence, never a path or a raw url. */
export function dropRefLines(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n').split('\n').filter((l) => !REF_LINE.test(l)).join('\n');
}
/** One line of at most `n` chars. Default 140, so every pre-existing caller is unchanged; the panel fields pass 240. */
export function snippet(s, n = SNIPPET) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
}

/** The board's server-measured time record for one step (vendor/laneboard/src/ops.mjs initTime/transitionTime): the key
 *  is `${taskId}/${stepId}`. CONFIRMED on the fixture board (scripts/fixtures/hud-board.mjs, step 2): boardView steps
 *  carry the full key in their own id (`T-31/hud`) and state.times is keyed `T-31/hud` -- so a full id is used as it is,
 *  and a bare step id (the hand-written fixtures in check-hud.mjs) gets the task prefix. */
const timeKeyOf = (taskId, stepId) => (String(stepId).includes('/') ? String(stepId) : `${taskId}/${stepId}`);
const healthOf = (task) => (HEALTH.has(task.health) ? task.health : '');

// ---------- refs: the links/files an ask or step carries (Laneboard public/markdown.js splitRefs format) ----------
// A trailing line of " · "-separated refs: [label](https://…) or `D:/path` (optionally "label `D:/path`"). Inline
// [label](http…) links and `D:/…` code spans anywhere in the text count too (stepRefs in Laneboard public/app.js).
// Board media (![](media/x.png)) are left out: they live on the board server, not on this PC or an allowlisted host.
const REF_LINK = /^\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)$/;
const REF_LOCAL = /^(?:([^`\n]*?) )?`([A-Za-z]:[\\/][^`\n]*)`$/;
const MEDIA_URL = /\/media\/[\w.-]+\.(?:png|jpe?g|webp|gif)$/i;
const INLINE_LINK = /(?<!!)\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g;
const INLINE_LOCAL = /`([A-Za-z]:[\\/][^`\n]*)`/g;
const baseName = (p) => { const parts = p.replace(/\\/g, '/').split('/').filter(Boolean); return parts.pop() || p; };
/** A local target with no glob or placeholder char (* ? [ ] { } < >): a glob names no one file or folder to open, so it is never
 *  cited (T-31 alpha.3 B3). Folders and extensionless files stay cited: both hosts open them. */
const isCitableLocal = (p) => !/[*?[\]{}<>]/.test(p);

/** text -> [{ kind: 'local' | 'url', label, target }], de-duplicated, in text order. */
export function extractRefs(text) {
  const out = [];
  const seen = new Set();
  const add = (kind, label, target) => {
    const key = `${kind}:${target}`;
    if (seen.has(key) || (kind === 'url' && MEDIA_URL.test(target)) || (kind === 'local' && !isCitableLocal(target))) return;
    seen.add(key);
    out.push({ kind, label: String(label || '').trim() || (kind === 'local' ? baseName(target) : target), target });
  };
  const src = String(text ?? '').replace(/\r\n?/g, '\n');
  for (const line of src.split('\n')) { // ref-line tokens first: they carry the author's own label
    const toks = line.split(' · ').map((s) => s.trim()).filter(Boolean);
    for (const tk of toks) {
      const l = REF_LOCAL.exec(tk);
      if (l) add('local', l[1] || baseName(l[2]), l[2].replace(/\\/g, '/'));
      const u = REF_LINK.exec(tk);
      if (u) add('url', u[1], u[2]);
    }
  }
  for (const m of src.matchAll(INLINE_LINK)) add('url', m[1], m[2]);
  for (const m of src.matchAll(INLINE_LOCAL)) add('local', baseName(m[1]), m[1].replace(/\\/g, '/'));
  return out;
}

const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;
/** The acceptance item to offer from a list of refs: a local image first, then any local file/folder, then a
 *  loopback preview, then any web link. Only refs `isOpenable(ref)` accepts (the open allowlist) are ever offered. */
export function pickAcceptanceRef(refs, isOpenable) {
  const rank = (r) => (r.kind === 'local' && IMAGE_EXT.test(r.target) ? 0 : r.kind === 'local' ? 1 : /^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(r.target) ? 2 : 3);
  return [...refs].sort((a, b) => rank(a) - rank(b)).find((r) => isOpenable(r)) || null;
}

// ---------- the feed ----------
/**
 * @returns {{ updates: object[], waiting: object[], taskKeys: Record<string,string>, waitKeys: Record<string,string>, doneCounts: Record<string,number> }}
 *   updates: the MAX_UPDATES most recently active open tasks; waiting: the first MAX_WAITING owner asks (oldest first,
 *   as the board lists them). taskKeys/waitKeys: every task's / ask's dedupe key (id + revision), for the tracker.
 *   doneCounts: per task, the number of done steps (the tracker uses it to spot a step completion).
 */
export function buildHudFeed(state) {
  const tasks = (Array.isArray(state?.tasks) ? state.tasks : []).filter((t) => t && typeof t.id === 'string' && !INACTIVE_STATUS.has(t.status));
  const waiting = Array.isArray(state?.attention?.waiting) ? state.attention.waiting.filter((w) => w && typeof w.id === 'string') : [];
  const byId = new Map(tasks.map((t) => [t.id, t]));
  // A task's number of DONE steps. The board's current_step never reports 'done' (rules.mjs currentStep: first
  // active/waiting/blocked/todo), so a just-finished step is invisible in stepState; the tracker watches this count
  // instead, so a completion can still drive the 'done' reaction (T-31 0.2.3 A2).
  const doneCountOf = (t) => (Array.isArray(t.steps) ? t.steps.filter((s) => s && s.state === 'done').length : 0);
  const taskKey = (t) => `${t.id}@${t.last_activity_at || ''}#${t.rev ?? ''}`;
  const waitKey = (w) => `${w.kind}:${w.id}@${w.rev ?? ''}`;
  const taskKeys = Object.fromEntries(tasks.map((t) => [t.id, taskKey(t)]));
  const waitKeys = Object.fromEntries(waiting.map((w) => [`${w.kind}:${w.id}`, waitKey(w)]));
  const at = (t) => Date.parse(t.last_activity_at || '') || 0;
  const updates = [...tasks].sort((a, b) => at(b) - at(a) || a.id.localeCompare(b.id)).slice(0, MAX_UPDATES).map((t) => {
    const cur = t.current_step || null;
    const full = cur && Array.isArray(t.steps) ? t.steps.find((s) => s && s.id === cur.id) : null;
    // ---- panel fields (T-31 hud-panels, PLAN section 2): everything the T1/T2/T3 panels need, so the renderer never
    // reaches the board itself. Data only -- no behaviour change, and taskKey (the dedupe key) stays as it was.
    const steps = Array.isArray(t.steps) ? t.steps : [];
    const labelOf = new Map(steps.map((s) => [String((s && s.id) ?? ''), snippet(s && s.label)]));
    const times = state && state.times && typeof state.times === 'object' ? state.times : null;
    const transitions = [];
    if (times) for (const s of steps) { // every step of THIS task, in board order
      const rec = times[timeKeyOf(t.id, (s && s.id) ?? '')];
      for (const tr of Array.isArray(rec && rec.transitions) ? rec.transitions : []) {
        if (!tr || !tr.at) continue;
        const stepId = String((s && s.id) ?? '');
        transitions.push({ at: tr.at, stepId, label: labelOf.get(stepId) || '', from: tr.from || '', to: tr.to || '' });
      }
    }
    transitions.sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0));
    return {
      id: t.id, title: snippet(t.title), status: t.status || '', at: t.last_activity_at || null,
      step: cur ? snippet(cur.label) : '', stepId: cur ? String(cur.id) : '', stepState: cur ? cur.state : '', doneCount: doneCountOf(t),
      refs: extractRefs(full && full.detail),
      goal: snippet(dropRefLines(t.goal), PANEL_SNIPPET), now: snippet(dropRefLines(t.now), PANEL_SNIPPET),
      health: healthOf(t), lane: snippet(t.lane, 40),
      roles: { code: (t.roles && t.roles.code && t.roles.code.model) || '', review: (t.roles && t.roles.review && t.roles.review.model) || '' },
      steps: steps.slice(0, MAX_STEPS).map((s) => ({
        id: String((s && s.id) ?? ''), label: snippet(s && s.label), sub: snippet(s && s.sub), state: (s && s.state) || '',
      })),
      stepTotal: steps.length,
      askCount: waiting.filter((w) => w.task_id === t.id).length, // exact, though waiting[] keeps only MAX_WAITING
      log: transitions.slice(-MAX_LOG), // oldest first, newest last: a static tail, never a scroll
      doneAts: transitions.filter((x) => x.to === 'done').map((x) => x.at).reverse().slice(0, MAX_DONE), // newest first
    };
  });
  const waitOut = waiting.slice(0, MAX_WAITING).map((w) => {
    const task = byId.get(w.task_id) || null;
    const title = snippet(task?.title || w.task_id);
    // quick.speech (T-31 0.2.3 B1 item 3): the spoken line is the task title + the ask's step label, sanitised --
    // never the raw ask `text` (often truncated/mangled, and it can carry urls, paths and markup).
    const step = stepLabelOf(task, w.step_id);
    return {
      key: `${w.kind}:${w.id}`, kind: w.kind, taskId: w.task_id, title, step,
      text: snippet(dropRefLines(w.text)),
      since: w.since || null, refs: extractRefs(w.text),
      // The task title alone (T-31 talk-mode, plan F5): no fallback to the raw task code, so a code can never be
      // spoken; the scheduler's line pool speaks the title + step, and a title-less ask uses the generic line.
      speak: quickSpeechText({ title: task?.title || '', step }),
      // Inline answers (T-31 0.2.3 batch C): the record id and revision an answer must name, and the options an
      // ask offers (key + label only). Local display, never sent to a model. Only kind:'ask' waits are answerable
      // (hud-answer.mjs); the renderer offers a choice per option, else approve/reject.
      id: w.id, rev: Number.isInteger(w.rev) ? w.rev : null,
      options: Array.isArray(w.options) ? w.options.map((o) => ({ key: o.key, label: o.label })).filter((o) => o.key != null) : [],
    };
  });
  return { updates, waiting: waitOut, waitingCount: waiting.length, taskKeys, waitKeys, doneCounts: Object.fromEntries(tasks.map((t) => [t.id, doneCountOf(t)])) };
}

// ---------- dedupe: which tasks changed since the last read ----------
/** First ingest = baseline (nothing is "new" on launch, or when the HUD is switched on). After that a task is new when
 *  its key (activity time + revision) changed or it appeared, and an ask is new when its key was never seen. The same
 *  read twice reports nothing the second time. -> { baseline, taskIds: string[], doneIds: string[] } (unique, stable
 *  order). doneIds: the reported tasks whose done-step count went UP, i.e. a step just finished (drives the 'done'
 *  reaction -- current_step never reports 'done'). */
export function createUpdateTracker() {
  let tasks = null;
  let waits = null;
  let counts = null;
  return {
    reset() { tasks = null; waits = null; counts = null; },
    ingest(feed) {
      const doneCounts = feed.doneCounts || {};
      if (!tasks) { tasks = { ...feed.taskKeys }; waits = { ...feed.waitKeys }; counts = { ...doneCounts }; return { baseline: true, taskIds: [], doneIds: [] }; }
      const ids = [];
      const doneIds = [];
      const note = (id) => { if (id && !ids.includes(id)) ids.push(id); };
      const noteDone = (id) => { if (id && !doneIds.includes(id)) doneIds.push(id); };
      for (const [id, key] of Object.entries(feed.taskKeys)) if (tasks[id] !== key) {
        note(id);
        // A brand-new task starts from its current done count: only a task already seen can have finished a step, so a
        // new task that already carries done steps (e.g. added mid-project) is an update, never a false 'done' (nit 16-10).
        const before = (counts || {})[id];
        if (before !== undefined && (doneCounts[id] || 0) > before) noteDone(id);
      }
      for (const [wid, key] of Object.entries(feed.waitKeys)) if (waits[wid] !== key) note(feed.waiting.find((w) => w.key === wid)?.taskId || wid.split(':')[1]);
      tasks = { ...feed.taskKeys };
      waits = { ...waits, ...feed.waitKeys }; // an ask that closes and comes back with the same revision stays seen
      counts = { ...counts, ...doneCounts };
      return { baseline: false, taskIds: ids, doneIds };
    },
  };
}

// ---------- batching: a burst of updates is one reaction ----------
/** At most one reaction per `cooldownMs`. push() during a cooldown queues the ids (merged, de-duplicated) and due()
 *  hands the merged batch out once the cooldown is over. -> string[] (task ids, newest push last) | null. */
export function createBurstBatcher({ cooldownMs = 30000 } = {}) {
  let lastAt = -Infinity;
  let queued = [];
  const merge = (ids) => { for (const id of ids) { const i = queued.indexOf(id); if (i >= 0) queued.splice(i, 1); queued.push(id); } };
  const flush = (now) => { const out = queued; queued = []; lastAt = now; return out; };
  return {
    push(ids, now) {
      if (ids.length) merge(ids);
      if (!queued.length || now - lastAt < cooldownMs) return null;
      return flush(now);
    },
    due(now) { return queued.length && now - lastAt >= cooldownMs ? flush(now) : null; },
    pending: () => [...queued],
  };
}

// ---------- consent to open ----------
export const CONSENT_TTL_MS = 2 * 60 * 1000;
/** One pending offer per acceptance item. Nothing is opened unless answer(id, true) arrives for a live offer: a "no",
 *  an unknown or expired id, or an allowlist refusal at open time opens nothing. An offer is used up by any answer.
 *  decide(ref) -> board-open.mjs decision ({action:'openPath'|'openExternal'|'refuse',…}); open(decision) performs it.
 *  The renderer only ever sees { id, kind, label, target } -- the id is what it answers with; the ref stays here. */
export function createConsentGate({ decide, open, now = Date.now, ttlMs = CONSENT_TTL_MS }) {
  const offers = new Map();
  let seq = 0;
  const sweep = () => { const t = now(); for (const [id, o] of offers) if (t - o.at > ttlMs) offers.delete(id); };
  return {
    isOpenable: (ref) => { const d = decide(ref); return d.action === 'openPath' || d.action === 'openExternal'; },
    offer(ref, { taskId = null } = {}) {
      sweep();
      const id = `c${++seq}-${now().toString(36)}`;
      offers.set(id, { ref, at: now(), taskId });
      return { id, kind: ref.kind, label: ref.label, target: ref.kind === 'local' ? baseName(ref.target) : (() => { try { return new URL(ref.target).host; } catch { return ref.target; } })(), taskId, ttlMs };
    },
    async answer(id, yes) {
      const o = offers.get(id);
      offers.delete(id);
      if (!o) return { opened: false, reason: 'unknown_or_used' };
      if (now() - o.at > ttlMs) return { opened: false, reason: 'expired' };
      if (yes !== true) return { opened: false, reason: 'declined' };
      const d = decide(o.ref);
      if (d.action !== 'openPath' && d.action !== 'openExternal') return { opened: false, reason: d.reason || 'refused', decision: d };
      await open(d);
      return { opened: true, action: d.action };
    },
    pendingCount: () => { sweep(); return offers.size; },
  };
}

// ---------- prefs ----------
export const HUD_STYLES = ['off', 'a', 'b'];
/** settings.json -> { style }. Default (nothing stored, or anything unknown): style 'off'. The old `hudVoiceMuted`
 *  switch is gone (T-31 talk-mode, plan section 1): "how much Zumi talks" is owned by the talk scheduler, and the
 *  migration folds the old value into `talkLevel`. */
export function hudPrefs(settings) {
  const s = settings || {};
  return { style: HUD_STYLES.includes(s.hudStyle) ? s.hudStyle : 'off' };
}
