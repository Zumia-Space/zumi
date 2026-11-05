// Adapter from the legacy row format (one JSON file per task, as used by the predecessor board) to v1
// write requests. It is a client of POST /api/v1/write like every other writer — it never touches files.
//
// Mapping:
//   code -> task id · title/lane/health/goal/now/next/context/order/loops/dossier/architecture -> same fields
//   draftOutput/draftOutcome (CoS's draft before the owner locks a goal) -> draft_output/draft_outcome
//   steps[].zone 'anh' -> 'owner' (the predecessor used the owner's name for the owner zone)
//   steps[].options (decision cards on any step) -> the step's options
//   worker {model, effort, reason} -> task.worker (coordinator default; owner routing stays separate)
//   needsAnh (free text on the task) -> ask.raise, attached to the task's waiting owner step if any
//   step.options on a waiting owner step -> the options of that ask
//   health 'grey' (the predecessor's "paused" dot) -> health grey, display only; liveness came from the
//   predecessor's registry, so `status` is passed in by the caller because rows do not carry it
//   a step id repeated inside one row (the predecessor accepted it) -> later copies become <id>-2, <id>-3 …
//   step state 'doing' (the predecessor's task/registry word for "in progress", written on steps by its early
//   writers before its own rules refused it on 30-09) -> 'active', on rows and in timing history alike
// Dropped on purpose: `updated`/`askAt` (client-written times; v1 only trusts the server clock: the importer
// carries their ages through times.import instead).

const ZONE = { anh: 'owner', owner: 'owner', plan: 'plan', build: 'build', test: 'test', ship: 'ship' };
const clip = (s, n) => (s == null ? undefined : String(s).slice(0, n));
// Legacy step-state spellings with a v1 equivalent. Only the label changes: the predecessor's clock never started
// on 'doing' (its updateTimes set startedAt on 'active' only), and the imported started_at stays as it measured.
const STEP_STATE = { doing: 'active' };
export const legacyStepState = s => (Object.hasOwn(STEP_STATE, s) ? STEP_STATE[s] : s);
const clean = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== ''));

/** Step ids made unique within a row: first occurrence keeps its id (and its timing history). */
export function uniqueStepIds(row) {
  const seen = new Map();
  return (row.steps || []).map(s => {
    const n = (seen.get(s.id) || 0) + 1; seen.set(s.id, n);
    return n === 1 ? s.id : `${s.id}-${n}`;
  });
}

const legacyOptions = opts => opts.slice(0, 8).map(o => clean({ key: String(o.key), label: clip(o.label, 300) || String(o.key), desc: clip(o.desc, 1000) }));
/** A step the owner answers: an ask may be tied to it and only to it. */
const isWaitingOwner = s => s.state === 'waiting' && ZONE[s.zone] === 'owner';

/** Index in row.steps of the step the row says its ask waits on (askStep), or -1 when it names none that is a waiting owner step. */
export const askStepIndex = row => (row.askStep ? (row.steps || []).findIndex(s => s.id === row.askStep && isWaitingOwner(s)) : -1);
/** True for a row that carries asks per step (`asks` map: { "<step>": "<text>" }) rather than the one legacy needsAnh. */
export const hasAskMap = row => !!row.asks && typeof row.asks === 'object' && !Array.isArray(row.asks);

/**
 * The asks a row carries, one entry per step, in the v1 ask shape (options already mapped):
 *  - a row with an `asks` map ({ "<step>": "<text>" }) says one ask per named step: the step is explicit, so nothing is ever
 *    guessed onto another step. An empty text says "no ask on this step" (it clears the ask an earlier push raised there);
 *  - an older row carries one needsAnh, on its askStep when that is a waiting owner step, else on its first waiting owner step
 *    when it asks at all (askStep exists but names something else: no ask, never re-aimed -- badAskStep refuses it).
 * `step` is the row's own step id (undefined for a step-less ask), `text` is trimmed and clipped like needsAnh.
 */
export function rowAsks(row) {
  const text = s => clip(s == null ? '' : String(s).trim(), 2000);
  const steps = row.steps || [];
  const at = id => steps.findIndex(s => s.id === id);
  const optionsOf = idx => (idx >= 0 && steps[idx].options?.length ? legacyOptions(steps[idx].options) : undefined);
  if (hasAskMap(row)) {
    // In the row's own step order (a JSON map's key order is the writer's, not the board's): the asks are raised and the legacy
    // needsAnh is joined in the order the steps read on the page.
    return Object.keys(row.asks).sort((a, b) => at(a) - at(b)).map(step => ({ step, text: text(row.asks[step]), options: optionsOf(at(step)) }));
  }
  const want = text(row.needsAnh), named = askStepIndex(row);
  const idx = named >= 0 ? named : (row.askStep ? -1 : steps.findIndex(isWaitingOwner));
  // A row that names no step and asks nothing has nothing to say: a guess never clears another step's ask (review B1). One that
  // NAMES its step speaks for it even when blank, so the client's clear still lands (review S2, the ce850a7 golden).
  if (!want && named < 0) return [];
  return [{ step: idx >= 0 ? steps[idx].id : undefined, text: want, options: optionsOf(idx) }];
}
/** A row that CARRIES an ask and NAMES an ask step (askStep, or an entry of its `asks` map) the board cannot tie it to: the named
 *  step is a step of the row, and it is not a waiting owner step there. Returns that step id, or false. A row with no askStep (an
 *  older client, a hand-made row) is not bad -- the board may still tie its ask to the first waiting owner step. A row that asks
 *  nothing (empty needsAnh, an empty map entry) is not bad either: its stale askStep is ignored, never refused (J-05 fix round 2: one
 *  row whose askStep pointed at a done step blocked a lane's whole push, though it raised no ask). A map entry naming a step the row
 *  does not carry (another lane's step in a shared rows dir, a step this lane does not push) is not bad either -- the row never
 *  spoke for that step; only an entry the row DOES carry, on a step the owner cannot answer, is refused (the H-03 failure: an ask
 *  that lands nowhere is as bad as a misplaced one). */
export const badAskStep = row => {
  if (hasAskMap(row)) {
    const steps = row.steps || [];
    return Object.entries(row.asks).find(([id, t]) => {
      const s = steps.find(x => x.id === id);
      return String(t ?? '').trim() && !!s && !isWaitingOwner(s);
    })?.[0] || false;
  }
  return !!String(row.needsAnh || '').trim() && !!row.askStep && askStepIndex(row) < 0 ? row.askStep : false;
};

export function legacyRowToRequests(row, { prefix = 'legacy', status } = {}) {
  const id = row.code;
  const ids = uniqueStepIds(row);
  const steps = (row.steps || []).map((s, i) => clean({
    id: ids[i], label: clip(s.label, 200), sub: clip(s.sub, 200), zone: ZONE[s.zone] || 'build',
    state: legacyStepState(s.state), detail: clip(s.detail, 16000), recommend: clip(s.recommend, 2000),
    options: s.options?.length ? legacyOptions(s.options) : undefined
  }));
  const reqs = [{
    version: 1, request_id: `${prefix}-${id}-task`, op: 'task.create', target_id: id,
    data: clean({
      title: clip(row.title, 200), lane: clip(row.lane, 64), health: row.health, status, goal: clip(row.goal, 2000),
      now: clip(row.now, 2000), next: clip(row.next, 2000), context: clip(row.context, 8000), dossier: clip(row.dossier, 500),
      draft_output: clip(row.draftOutput, 2000), draft_outcome: clip(row.draftOutcome, 2000),
      order: Number.isInteger(row.order) ? row.order : undefined,
      architecture: row.architecture, // passed whole (null clears it): the board validates it (src/architecture.mjs), never clips it
      worker: row.worker ? clean({ model: row.worker.model, effort: row.worker.effort, reason: clip(row.worker.reason, 300) }) : undefined,
      loops: row.loops?.length ? row.loops.map(l => clean({ from: l.from, to: l.to, label: clip(l.label, 120) })) : undefined,
      steps
    })
  }];
  // One ask.raise per ask the row carries (the legacy single needsAnh is the one-entry case, and keeps its request id so a
  // replayed import dedupes as before). The ask waits on the step the row names; a row without an askStep (an older client, a
  // hand-made row) gets its first waiting owner step. A row that NAMES a step the board cannot tie an ask to is never guessed
  // onto another step (J-05 16-10: `ask --step B` on a build step made the ask land on the lane's owner step A and replace its
  // open ask there): pushRows refuses it when the row asks (badAskStep) and rowAsks emits no entry for it.
  const asks = rowAsks(row);
  // The predecessor's oldest convention: a blank needsAnh and a waiting OWNER step carrying options is a decision card -- the step's
  // label IS the question. Only the import does this: a push of a blank row is a clear, never a new ask on a guessed step (review
  // B1), so the fallback cannot live in rowAsks.
  if (!asks.length && !hasAskMap(row) && !row.askStep) {
    const idx = (row.steps || []).findIndex(s => isWaitingOwner(s) && s.options?.length);
    if (idx >= 0) asks.push({ step: row.steps[idx].id, text: '', options: legacyOptions(row.steps[idx].options) });
  }
  for (const [i, a] of asks.entries()) {
    const idx = a.step === undefined ? -1 : (row.steps || []).findIndex(s => s.id === a.step);
    if (a.step !== undefined && idx < 0) continue; // an entry naming a step the row does not have is never re-aimed: step-less is a different ask
    const ownerStep = idx >= 0 ? { ...row.steps[idx], id: ids[idx] } : undefined;
    // A blank needsAnh on a waiting options step meant "take the step's label as the question" (the predecessor's own default); a
    // blank MAP entry means "no ask on this step" and raises nothing.
    const askText = hasAskMap(row) ? a.text : (a.text || (ownerStep?.options?.length ? ownerStep.label : ''));
    if (!askText) continue;
    reqs.push({
      version: 1, request_id: (i === 0 ? `${prefix}-${id}-ask` : `${prefix}-${id}-ask-${ownerStep?.id || ''}`).slice(0, 128), op: 'ask.raise', target_id: id,
      data: clean({
        text: clip(askText, 2000), step_id: ownerStep?.id,
        options: a.options?.length ? a.options : undefined
      })
    });
  }
  return reqs;
}

// Predecessor timing history (times.json: { tasks: { CODE: { firstSeenAt, startedAt, doneAt, steps: { id: {...} } } } })
// -> one times.import request per task. Field-for-field rename; `null` and `untracked: false` are the
// predecessor's spelling of "absent", so they are omitted. Nothing is recomputed or rounded; states go through
// legacyStepState like the rows do.
const stepTime = r => clean({
  first_seen_at: r.firstSeenAt, started_at: r.startedAt ?? undefined, done_at: r.doneAt ?? undefined,
  waiting_since: r.waitingSince ?? undefined, waiting_total_ms: r.waitingTotalMs || 0,
  untracked: r.untracked ? true : undefined, last_state: legacyStepState(r.lastState),
  transitions: (r.transitions || []).map(x => ({ at: x.t, from: legacyStepState(x.from), to: legacyStepState(x.to) }))
});
/** One predecessor registry row (+ its status override, if any) as a v1 registry entry; empty fields dropped. */
export function legacyRegistryEntry(r, o = {}) {
  return clean({ id: r.id, code: r.code, title: r.title || r.file || r.id, file: r.file, owner: r.owner, note: r.note, updated: r.updated, on_board: !!r.onBoard, status: o.status || r.status || 'open', status_by: o.statusBy, status_at: o.statusAt });
}

export function legacyTimesToRequests(times, { prefix = 'legacy' } = {}) {
  return Object.entries(times?.tasks || {}).map(([code, rec]) => ({
    version: 1, request_id: `${prefix}-${code}-times`, op: 'times.import', target_id: code,
    data: {
      task: clean({ first_seen_at: rec.firstSeenAt, started_at: rec.startedAt ?? undefined, done_at: rec.doneAt ?? undefined }),
      steps: Object.fromEntries(Object.entries(rec.steps || {}).map(([id, r]) => [id, stepTime(r)]))
    }
  }));
}
