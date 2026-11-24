// J-05 delivery states (PLAN-DELIVERY rev 2 §4, §6.2): did an owner message reach the agent's live session?
//   sent        the board stored it (feedback.add, the journal)
//   delivered   a connector handed it to a live session and the transport reported success   (connector mark)
//   read        the session's transcript shows the model took it in, then an assistant entry (connector mark)
//   answered    a receipt or a coordinator reply on it (pickups, derived, exists)
//   undelivered no delivered within DELIVER_MS, at once when no connector serves the lane, or the connector reported failed{reason}
// States only move forward; answered implies the earlier ones. No state is set by a timer except undelivered, which is the
// absence of proof. Nothing here is set by a model.
//
// Marks are kept OUT of the journal on purpose, like the lane mailbox (src/mailbox.mjs): the reducer refuses an unknown op, so a
// journaled delivery op would make a rollback to an older board fail to start. They are an append-only side file,
// <data>/delivery.ndjson; rolled back, the marks simply stop showing. Connector presence is in memory only (like watcher_at).
import fs from 'node:fs';
import path from 'node:path';
import { sameLane } from './turns.mjs';
import { BoardError } from './ops.mjs';
import { checkRuns } from './work.mjs';

/** An owner message with no `delivered` proof this long after it was sent is undelivered (the red alarm). */
export const DELIVER_MS = 2 * 60000;
/** A connector beats every 30 s; three missed beats and its machine counts as offline. Also the boot grace (see deliveryOf). */
export const PRESENCE_STALE_MS = 90000;
/** How often the server's watchdog persists newly undelivered messages as alarms (well under DELIVER_MS). */
export const DELIVERY_SWEEP_MS = 10000;
export const STAGES = Object.freeze(['delivered', 'read', 'failed']);
/** failed.reason is a closed list (plan §4). */
export const REASONS = Object.freeze(['no_connector', 'machine_offline', 'session_closed', 'session_not_found', 'transport_error']);
export const SESSION_STATUSES = Object.freeze(['idle', 'busy', 'waiting', 'closed', 'none']);
/** The coordinator's lane: a connector serving it covers every owner message (the CoS reads all feedback today). */
const COORDINATOR_LANE = 'CoS';
const RANK = { failed: 0, delivered: 1, read: 2 };
const LIMITS = { session_id: 80, machine: 60, via: 40, lane: 64, lanes: 20 };
/** Machines the in-memory presence map holds at most: a new name past this answers 429 too_many_machines. */
export const PRESENCE_MACHINES_MAX = 20;

/** An owner message that delivery is tracked for: the owner's own word (not the board's), not informational, not migrated, sent at or after `sinceMs`. */
export function tracked(f, sinceMs) {
  const by = f?.attribution?.created_by;
  if (!by || by.role !== 'owner' || by.token_id === 'system' || f.info || f.auto || /^legacy /.test(by.origin || '')) return false;
  return Date.parse(f.attribution.created_at) >= sinceMs;
}

/** The lane a message is for: its step's lane, else its task's lane, else '' (only the coordinator's connector covers it). */
export function laneOf(state, f) {
  const st = f.step_id ? state.steps[`${f.task_id}/${f.step_id}`] : null;
  return st?.lane || state.tasks[f.task_id]?.lane || '';
}

const bad = (code, extra) => { throw new BoardError(400, code, extra); };
const str = (v, max) => v === undefined || (typeof v === 'string' && v.length <= max);

/** Validates a mark body; returns the clean mark fields. */
export function checkMark(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) bad('invalid_request');
  const extra = Object.keys(body).filter(k => !['feedback_id', 'stage', 'session_id', 'machine', 'via', 'reason'].includes(k));
  if (extra.length) bad('invalid_field', { fields: extra });
  if (typeof body.feedback_id !== 'string' || !/^fb-\d{1,12}$/.test(body.feedback_id)) bad('invalid_feedback_id');
  if (!STAGES.includes(body.stage)) bad('invalid_stage', { allowed: STAGES });
  if (body.stage === 'failed' ? !REASONS.includes(body.reason) : body.reason !== undefined) bad('invalid_reason', { allowed: REASONS });
  for (const k of ['session_id', 'machine', 'via']) if (!str(body[k], LIMITS[k])) bad('invalid_field', { field: k, max: LIMITS[k] });
  return body;
}

/** Validates a presence beat: { machine, lanes: [{ lane, session_id?, status }], runs?, runs_error? } (runs: src/work.mjs). */
export function checkPresence(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) bad('invalid_request');
  if (typeof body.machine !== 'string' || !body.machine || body.machine.length > LIMITS.machine) bad('invalid_field', { field: 'machine' });
  if (!Array.isArray(body.lanes) || body.lanes.length > LIMITS.lanes) bad('invalid_field', { field: 'lanes', max: LIMITS.lanes });
  const lanes = body.lanes.map(l => {
    if (!l || typeof l.lane !== 'string' || !l.lane || l.lane.length > LIMITS.lane) bad('invalid_field', { field: 'lanes[].lane' });
    if (!SESSION_STATUSES.includes(l.status)) bad('invalid_field', { field: 'lanes[].status', allowed: SESSION_STATUSES });
    if (!str(l.session_id, LIMITS.session_id)) bad('invalid_field', { field: 'lanes[].session_id' });
    return { lane: l.lane, status: l.status, ...(l.session_id ? { session_id: l.session_id } : {}) };
  });
  return { machine: body.machine, lanes, ...checkRuns(body) };
}

/**
 * The side store: <data>/delivery.ndjson, one mark per line { at, fb, stage, by, session_id?, machine?, via?, reason? }.
 * marks[fb] = { delivered?, read?, failed? }, each { at, ... }. A torn last line (crash mid-write) is cut off, as the journal's is.
 */
export function openDeliveryStore(dataDir) {
  const file = path.join(dataDir, 'delivery.ndjson');
  const marks = {};
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (raw && !raw.endsWith('\n')) { raw = raw.slice(0, raw.lastIndexOf('\n') + 1); fs.writeFileSync(file, raw); }
  const fold = m => {
    const cur = marks[m.fb] ??= {};
    const top = cur.read ? RANK.read : cur.delivered ? RANK.delivered : cur.failed ? RANK.failed : -1;
    if (RANK[m.stage] <= top) return false; // forward-only: a stage at or behind the current one changes nothing
    const rec = { at: m.at, ...(m.session_id ? { session_id: m.session_id } : {}), ...(m.machine ? { machine: m.machine } : {}), ...(m.via ? { via: m.via } : {}), ...(m.by ? { by: m.by } : {}) };
    if (m.stage === 'failed') cur.failed = { ...rec, reason: m.reason };
    if (m.stage === 'delivered') cur.delivered = rec;
    if (m.stage === 'read') { cur.read = rec; cur.delivered ??= rec; } // proof of read is proof of delivery
    return true;
  };
  for (const line of raw.split('\n').filter(Boolean)) { try { fold(JSON.parse(line)); } catch { /* a line that is not JSON is skipped; the rest still count */ } }
  return {
    marks,
    /** Folds and appends one mark; false (nothing written) when it does not move the message forward. */
    add(m) {
      if (!fold(m)) return false;
      fs.appendFileSync(file, JSON.stringify(m) + '\n');
      return true;
    }
  };
}

/** Connectors whose presence lists a lane that covers `lane`, split by freshness. */
function coverage(presence, lane, nowMs) {
  const fresh = [], stale = [];
  for (const p of Object.values(presence)) {
    const lanes = p.lanes.filter(l => sameLane(l.lane, COORDINATOR_LANE) || (lane && sameLane(l.lane, lane)));
    if (!lanes.length) continue;
    (nowMs - p.atMs < PRESENCE_STALE_MS ? fresh : stale).push({ ...p, lanes });
  }
  return { fresh, stale };
}

/** Why a message is undelivered when no connector reported a failure: what the presence says about its lane. */
function silentReason(cov) {
  if (!cov.fresh.length) return cov.stale.length ? 'machine_offline' : 'no_connector';
  const st = cov.fresh.flatMap(p => p.lanes.map(l => l.status));
  if (st.some(x => ['idle', 'busy', 'waiting'].includes(x))) return 'transport_error';
  return st.includes('closed') ? 'session_closed' : 'session_not_found';
}

/**
 * The delivery of one tracked message, derived on every read: { state, lane, sent_at, delivered_at?, read_at?, answered_at?,
 * session_id?, via?, reason? }. `picked` = views.pickups (receipt or coordinator reply). `bootMs` = when this board process
 * started: presence is in memory, so for PRESENCE_STALE_MS after a start "no connector" only counts once DELIVER_MS has passed.
 */
export function deliveryOf(state, f, { marks, presence, nowMs, picked, bootMs }) {
  const m = marks[f.id] || {}, sent = f.attribution.created_at, lane = laneOf(state, f);
  const proof = m.read || m.delivered;
  const out = {
    lane, sent_at: sent,
    ...(m.delivered ? { delivered_at: m.delivered.at } : {}), ...(m.read ? { read_at: m.read.at } : {}),
    ...(proof?.session_id ? { session_id: proof.session_id } : {}), ...(proof?.via ? { via: proof.via } : {})
  };
  if (picked[f.id]) return { state: 'answered', ...out, answered_at: picked[f.id].at };
  if (m.read) return { state: 'read', ...out };
  if (m.delivered) return { state: 'delivered', ...out };
  if (m.failed) return { state: 'undelivered', ...out, reason: m.failed.reason, failed_at: m.failed.at };
  const cov = coverage(presence, lane, nowMs);
  const nobody = !cov.fresh.length && !cov.stale.length && nowMs - bootMs >= PRESENCE_STALE_MS;
  if (nobody || nowMs - Date.parse(sent) >= DELIVER_MS) return { state: 'undelivered', ...out, reason: silentReason(cov) };
  return { state: 'sent', ...out };
}

/** The presence map as readers see it. */
export function connectorsView(presence, nowMs) {
  return Object.values(presence).map(p => ({ machine: p.machine, at: new Date(p.atMs).toISOString(), age_ms: nowMs - p.atMs, online: nowMs - p.atMs < PRESENCE_STALE_MS, lanes: p.lanes }))
    .sort((a, b) => a.machine.localeCompare(b.machine));
}

