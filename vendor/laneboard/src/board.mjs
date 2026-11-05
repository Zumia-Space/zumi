// The board: authentication, the single write path, and read views. Transport-agnostic; server.mjs is
// a thin HTTP wrapper around it. Writes are synchronous from validation to projection, so the Node
// event loop serialises them without extra locking.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSchemas, validate } from './validate.mjs';
import { openStore } from './store.mjs';
import { openMessageStore, MAILBOX, RESERVED_LANES, isReservedLane, mayUseInbox, messageSender, resolveMessageTarget, mailboxLane, findSecretShapes } from './mailbox.mjs';
import { readQuota } from './quota.mjs';
import { OPS, BoardError, taskOf, MAGIC, TEXT_MIMES, createTextCheck, turnLane, STATS_MAX_BYTES, compactPlan, COMPACT_DEFAULT_KEEP } from './ops.mjs';
import { TURN, mayUseLane, latestTurns, turnList } from './turns.mjs';
import { violationsForWrite } from './rules.mjs';
import { boardView, inScope, publicToken, ownerSignal, staleText, openStatusRequest, sweepNight, sweepSkips, FRESHNESS_DEFAULTS, SIGNAL_TYPES, NOTIFY_DEFAULTS } from './views.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SCHEMA_DIR = path.join(ROOT, 'schema', 'v1');
const schemas = loadSchemas(SCHEMA_DIR);
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
export const OP_RULES = Object.fromEntries(Object.keys(OPS).map(op => {
  const s = schemas.get(`ops/${op}.json`);
  if (!s) throw new Error(`missing schema for op ${op}`);
  return [op, { roles: s['x-roles'], target: s['x-target'], revision: s['x-revision'], device: s['x-device'] !== false }];
}));

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
/** Task an accepted event touched, or null (token, prefs and board-level ops). Never throws, unlike taskOf. */
function eventTask(state, ev) {
  const { op, target_id: t } = ev;
  if (op.startsWith('step.')) return t.slice(0, t.indexOf('/'));
  if (op === 'ask.clear' || op === 'ask.answer' || op === 'ask.update') return state.asks[t]?.task_id ?? null;
  if (op === 'inbox.merge') return state.inbox[t]?.task_id ?? null;
  if (op === 'feedback.resolve') return state.feedback[t]?.task_id ?? null;
  if (op.startsWith('token.') || op.startsWith('ping') || ['prefs.set', 'notify.set', 'freshness.set', 'summary.set', 'registry.set', 'turn.report'].includes(op)) return null;
  return t;
}
const canonical = v => Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',')}}` : JSON.stringify(v);

/** An image pasted or dropped into a message (upload purpose=message): these types only, and a hard cap. */
export const MESSAGE_IMAGE = { mimes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], maxBytes: 5 * 1024 * 1024 };
export const DEFAULTS = { stallMs: 3 * 3600000, maxAttachmentBytes: 256 * 1024, maxUploadBytes: 64 * 1024 * 1024, mediaLinkMs: 3600000, reporterWritesPerMin: 30, models: ['opus', 'sonnet', 'haiku', 'deepseek', 'gpt', 'gemini'] };

/**
 * @param {object} o
 * @param {string} o.dataDir       private data directory (journal, projection, media)
 * @param {() => number} [o.now]   clock in ms; injectable for tests only
 * @param {string} [o.ownerToken]  bootstrap owner secret; generated and saved to <dataDir>/owner.token when absent
 * @param {number[]} [o.webhookRetryMs] delays between webhook attempts; injectable for tests only
 * @param {number} [o.maxUploadBytes] cap for streamed uploads (POST /api/v1/upload); base64 attachment.add keeps maxAttachmentBytes
 * @param {number} [o.reporterWritesPerMin] most write attempts per rolling minute for one reporter token; the next is refused 429 rate_limited
 * @param {object} [o.mailboxLimits] { dailyPerLane, maxBytes } lane-mailbox caps; the production values live in MAILBOX, tests only override them
 * @param {boolean} [o.roleSlots]  default true: every task carries its plan/code/review/scout slots (ADR 2026-10-09). An embedder
 *   whose users must not see lane model names (the Zumi desktop app's local board) passes false: the view then has no
 *   `roles`, so the page draws no "Workers by task" table. The journal and the ops are unchanged either way.
 */
export function createBoard({ dataDir, now = Date.now, ownerToken, stallMs = DEFAULTS.stallMs, maxAttachmentBytes = DEFAULTS.maxAttachmentBytes, maxUploadBytes = DEFAULTS.maxUploadBytes, models = DEFAULTS.models, modelLabels = {}, webhookRetryMs = [1000, 5000], roleSlots = true, reporterWritesPerMin = DEFAULTS.reporterWritesPerMin, mailboxLimits = {} } = {}) {
  const store = openStore(dataDir);
  // The lane mailbox lives in its own append file, never in the journal (see src/mailbox.mjs for the rollback
  // reason). Opening it here prunes bodies older than 30 days on startup; a daily timer keeps pruning.
  const mailbox = openMessageStore(dataDir, { now, ...mailboxLimits });
  // models: suggestions for the owner's worker picker only; any id matching the schema pattern is accepted.
  // modelLabels: display names for those ids (e.g. sonnet -> "Sonnet 5.5"), shown wherever a worker is.
  const config = { version: VERSION, stall_ms: stallMs, max_attachment_bytes: maxAttachmentBytes, max_upload_bytes: maxUploadBytes, models, model_labels: modelLabels };
  const iso = () => new Date(now()).toISOString();

  // The board's task-statistics document (J-05): derived data the CoS `stats` command regenerates on every push.
  // It is kept in its own file and NEVER in the journal, so an older board that knows no stats op can replay this
  // journal and start — rollback is safe. A missing file is the normal case (no stats pushed yet); an unreadable or
  // schema-invalid file is ignored (null) with one warning, never a crash.
  const statsPath = path.join(dataDir, 'stats.json');
  function loadStats() {
    let raw;
    try { raw = fs.readFileSync(statsPath, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') console.warn('stats.json unreadable, ignoring it:', e.message); return null; }
    let doc;
    try { doc = JSON.parse(raw); } catch { console.warn('stats.json is not valid JSON, ignoring it'); return null; }
    const errors = validate(schemas, 'stats.json', doc);
    if (errors.length) { console.warn(`stats.json does not match its schema, ignoring it: ${errors[0].path} ${errors[0].message}`); return null; }
    return doc;
  }
  let statsDoc = loadStats();
  let statsRev = 0; // per-process: the document is derived, its revision is not persisted (nothing journaled)

  // Accepted events fan out to stream subscribers and the webhook after the write has committed.
  const listeners = new Set();
  const publish = ev => { for (const l of listeners) queueMicrotask(() => { try { l(ev); } catch (e) { console.error('event listener failed', e); } }); };

  const secretFile = path.join(dataDir, 'webhook.secret');
  const webhookSecret = {
    exists: () => fs.existsSync(secretFile),
    create() { const v = 'whsec_' + crypto.randomBytes(32).toString('base64url'); fs.writeFileSync(secretFile, v + '\n', { mode: 0o600 }); return v; },
    read: () => { try { return fs.readFileSync(secretFile, 'utf8').trim(); } catch { return ''; } }
  };
  let webhookStatus = null;
  /** POST one signal, signed: X-Laneboard-Signature = sha256=HMAC(secret, "<timestamp>.<body>"). Retries, then records the outcome. */
  async function deliver(url, signal) {
    const secret = webhookSecret.read();
    if (!secret) { webhookStatus = { at: iso(), ok: false, error: 'no_secret', event_id: signal.event_id }; return; }
    const body = JSON.stringify({ version: 1, signal });
    let last = {};
    for (let attempt = 0; attempt <= webhookRetryMs.length; attempt++) {
      if (attempt) await new Promise(r => setTimeout(r, webhookRetryMs[attempt - 1]));
      const ts = String(Math.floor(now() / 1000));
      const sig = crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
      try {
        const res = await fetch(url, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(5000), body,
          headers: { 'Content-Type': 'application/json', 'User-Agent': 'laneboard-webhook', 'X-Laneboard-Event': signal.type, 'X-Laneboard-Delivery': signal.event_id, 'X-Laneboard-Timestamp': ts, 'X-Laneboard-Signature': `sha256=${sig}` } });
        last = { status: res.status };
        if (res.ok) break;
      } catch (e) { last = { error: e.name === 'TimeoutError' ? 'timeout' : 'unreachable' }; }
    }
    webhookStatus = { at: iso(), ok: last.status >= 200 && last.status < 300, event_id: signal.event_id, ...last };
  }
  listeners.add(ev => {
    const n = { ...NOTIFY_DEFAULTS, ...store.state.notify };
    if (!n.coordinator_feedback || n.delivery !== 'webhook' || !n.webhook_url) return;
    const signal = ownerSignal(store.state, ev);
    if (signal && (signal.type === 'feedback' || signal.type === 'answer')) deliver(n.webhook_url, signal);
  });

  // Bootstrap: the very first event issues the owner credential. Only its sha256 is journaled.
  let bootstrapTokenFile = null;
  if (store.state.seq === 0) {
    const secret = ownerToken || 'lb_' + crypto.randomBytes(32).toString('base64url');
    if (!ownerToken) {
      bootstrapTokenFile = path.join(dataDir, 'owner.token');
      fs.writeFileSync(bootstrapTokenFile, secret + '\n', { mode: 0o600 });
    }
    store.append({ seq: 1, id: 'evt-1', at: iso(), request_id: 'bootstrap-owner', body_sha256: sha256('bootstrap'),
      actor: { token_id: 'system', name: 'system', role: 'owner' }, op: 'token.issue', target_id: 'owner',
      data: { role: 'owner', label: 'owner', token_sha256: sha256(secret) }, result: { id: 'tok-1', revision: 1 } });
  }

  // The owner credential a trusted front end vouches for (server.mjs: a request that arrives through the reverse
  // proxy's owner route carrying the proxy's secret header). An object, never a string: no bearer value equals it.
  const ownerCredential = Object.freeze({ trustedOwnerProxy: true });
  /** Bearer secret -> actor, or null. Revoked tokens resolve to null. */
  function authenticate(secret) {
    if (!secret) return null;
    if (secret === ownerCredential) {
      // Never a device token (J-05 D3): the login is the owner's own, and a phone token must not become its identity.
      const o = Object.values(store.state.tokens).find(x => x.role === 'owner' && !x.revoked_at && !x.device);
      return o ? { token_id: o.id, name: o.name, role: 'owner', ...(o.label ? { label: o.label } : {}), scope_tasks: o.scope_tasks, via: 'proxy' } : null;
    }
    if (typeof secret !== 'string') return null;
    const h = sha256(secret);
    const t = Object.values(store.state.tokens).find(x => x.sha256 === h && !x.revoked_at);
    if (!t) return null;
    return { token_id: t.id, name: t.name, role: t.role, ...(t.label ? { label: t.label } : {}), ...(t.lane ? { lane: t.lane } : {}), ...(t.model ? { model: t.model } : {}), ...(t.device ? { device: true } : {}), scope_tasks: t.scope_tasks };
  }

  // Reporter tokens are handed to outside parties (a lane on another host), so each is capped: attempts in the last
  // minute, valid or not, so a failing flood costs as much as a working one. In memory; a restart resets the window.
  const reporterHits = new Map();
  function limitReporter(actor) {
    const t = now(), hits = (reporterHits.get(actor.token_id) || []).filter(x => t - x < 60000);
    if (hits.length >= reporterWritesPerMin) {
      reporterHits.set(actor.token_id, hits);
      throw new BoardError(429, 'rate_limited', { limit_per_minute: reporterWritesPerMin, retry_after_s: Math.ceil((hits[0] + 60000 - t) / 1000) });
    }
    hits.push(t); reporterHits.set(actor.token_id, hits);
  }

  // ---- lane mailbox (J-05, release 2) ----
  // Messages have their own rate bucket: a lane's 30 writes/min for board rows (limitReporter) stays separate,
  // because a waiter/chatty lane must not consume the budget its task writes need. In memory; a restart resets it.
  const messageHits = new Map();
  function limitMessages(actor) {
    const t = now(), hits = (messageHits.get(actor.token_id) || []).filter(x => t - x < 60000);
    if (hits.length >= MAILBOX.perMinute) {
      messageHits.set(actor.token_id, hits);
      throw new BoardError(429, 'rate_limited', { limit_per_minute: MAILBOX.perMinute, retry_after_s: Math.ceil((hits[0] + 60000 - t) / 1000) });
    }
    hits.push(t); messageHits.set(actor.token_id, hits);
  }
  // At most one open long poll per token (Opus review, change 7): a new poll closes the previous one, so a
  // re-arming waiter or a second tab can never park two requests on the same credential.
  const inboxWaiters = new Map();

  /** POST /api/v1/msg: `from` comes from the token; the body may only name a target and content. */
  function sendMessage(secret, input) {
    const actor = authenticate(secret);
    if (!actor) throw new BoardError(401, 'unauthorized');
    // A token minted before the reserved-name rule may carry cos/all/anh; `from` is stamped from it, so such a token
    // must not send at all (review R2-4). The mint check (ops.mjs token.issue) is the first line of defence.
    if (actor.role === 'reporter' && isReservedLane(actor.lane)) throw new BoardError(403, 'reserved_lane', { lane: actor.lane, reserved: [...RESERVED_LANES] });
    if (actor.role === 'reporter' && !actor.lane) throw new BoardError(403, 'lane_required', { message: 'a reporter token needs a lane to send' });
    limitMessages(actor);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BoardError(400, 'invalid_msg', { errors: [{ path: '$', message: 'expected an object' }] });

    const errors = [];
    const err = (path, message) => errors.push({ path, message });
    for (const k of Object.keys(input)) if (!['to', 'body', 'links', 'reply_to'].includes(k)) err(`$.${k}`, 'is not allowed');
    if (typeof input.to !== 'string' || !input.to.trim()) err('$.to', 'must be a non-empty string');
    if (typeof input.body !== 'string') err('$.body', 'must be a string');
    if (input.links !== undefined && !Array.isArray(input.links)) err('$.links', 'must be an array');
    if (input.reply_to !== undefined && (typeof input.reply_to !== 'string' || !/^msg-[0-9]+$/.test(input.reply_to))) err('$.reply_to', 'must be a message id');
    if (errors.length) throw new BoardError(400, 'invalid_msg', { errors });

    if (input.body.includes('\u0000')) throw new BoardError(400, 'body_not_text');
    if (Buffer.byteLength(input.body, 'utf8') > MAILBOX.bodyBytes) throw new BoardError(413, 'body_too_long', { max_bytes: MAILBOX.bodyBytes });
    const links = input.links || [];
    if (links.length > MAILBOX.links) throw new BoardError(400, 'too_many_links', { max: MAILBOX.links });
    // Length first, before any URL parsing: a 1.8 MB "link" must cost nothing and reach no store (review R2 re-check A).
    let linkTotal = 0;
    links.forEach((link, index) => {
      if (typeof link !== 'string') return;
      const size = Buffer.byteLength(link, 'utf8');
      linkTotal += size;
      if (size > MAILBOX.linkBytes) throw new BoardError(413, 'link_too_long', { index, max_bytes: MAILBOX.linkBytes });
    });
    if (linkTotal > MAILBOX.linksBytes) throw new BoardError(413, 'links_too_long', { max_bytes: MAILBOX.linksBytes });
    links.forEach((link, index) => {
      let code = 'link_not_https';
      if (typeof link === 'string' && !/\s/.test(link)) {
        try {
          const u = new URL(link);
          // A link must not smuggle a credential: https://user:pass@host is the shape basic auth takes, and the
          // secret scanner does not see it (review R2-3). The refusal names the index, never the value.
          if (u.protocol === 'https:' && u.host) code = u.username || u.password ? 'link_credentials' : null;
        } catch { /* not a URL */ }
      }
      if (code) throw new BoardError(400, code, { index });
    });
    // The secret scan covers the body and every link; the reply names the field only, never the match.
    const fields = [];
    if (findSecretShapes(input.body).length) fields.push('body');
    links.forEach((link, index) => { if (findSecretShapes(link).length) fields.push(`links[${index}]`); });
    if (fields.length) throw new BoardError(400, 'secret_shape', { fields });

    const to = resolveMessageTarget(store.state, input.to);
    // An unknown name gets the same refusal an inbox read gives a forbidden lane, never 400 unknown_lane: a send
    // must not tell a lane which names exist (review R2-8; "a reply to anh is impossible" is acceptable for v1).
    if (!to) throw new BoardError(403, 'forbidden_lane', { lane: input.to });
    if (input.reply_to) {
      const target = mailbox.get(input.reply_to);
      if (!target) throw new BoardError(404, 'message_not_found', { target_id: input.reply_to });
      const seen = actor.role === 'owner' || actor.role === 'coordinator'
        || (!!actor.lane && (target.from === actor.lane || target.to === actor.lane || target.to === 'all'));
      if (!seen) throw new BoardError(403, 'not_your_message', { target_id: input.reply_to });
    }
    let rec;
    try {
      rec = mailbox.append({ from: messageSender(actor), to, body: input.body, links, ...(input.reply_to ? { reply_to: input.reply_to } : {}) });
    } catch (e) {
      // The store refuses before writing, so a capped message is never half-appended (review R2-2).
      if (e.code === 'lane_daily_limit') throw new BoardError(429, 'lane_daily_limit', { limit_per_day: e.limit, retry_after_s: Math.max(1, Math.ceil(e.retryAfterMs / 1000)) });
      if (e.code === 'store_full') throw new BoardError(507, 'store_full', { max_bytes: e.maxBytes, ...(mailbox.oversize ? { oversize: true } : {}) });
      throw e;
    }
    return { ok: true, id: rec.id, seq: rec.seq, at: rec.at, from: rec.from, to: rec.to };
  }

  /**
   * GET /api/v1/inbox: messages addressed to `lane`, broadcast to all, or sent by that lane, after a msg seq.
   * `waitMs` (0..25000) parks the request on the in-process message listener; the check runs on the projection,
   * never on the journal file. A second poll for the same token closes the first with {closed: true}.
   */
  async function inboxFor(secret, { lane, after, waitMs, signal } = {}) {
    const actor = authenticate(secret);
    if (!actor) throw new BoardError(401, 'unauthorized');
    // Same rule as a send: a legacy token with a reserved lane may read nothing, because "its own lane" would be cos/all/anh.
    if (actor.role === 'reporter' && isReservedLane(actor.lane)) throw new BoardError(403, 'reserved_lane', { lane: actor.lane, reserved: [...RESERVED_LANES] });
    const raw = lane == null || lane === '' ? (actor.lane || '') : String(lane).trim();
    if (!raw) throw new BoardError(actor.role === 'reporter' ? 403 : 400, 'lane_required', actor.role === 'reporter' ? { message: 'a reporter token needs a lane' } : {});
    if (!mayUseInbox(actor, raw)) throw new BoardError(403, 'forbidden_lane', { lane: raw });
    const want = mailboxLane(store.state, raw);
    // Resolving a case variant must never widen access (it cannot today, but keep the permission keyed on the result).
    if (!mayUseInbox(actor, want)) throw new BoardError(403, 'forbidden_lane', { lane: raw });

    const afterSeq = after == null || after === '' ? 0 : Number(after);
    if (!Number.isInteger(afterSeq) || afterSeq < 0) throw new BoardError(400, 'invalid_after', { min: 0 });
    const wait = waitMs == null || waitMs === '' ? 0 : Number(waitMs);
    if (!Number.isFinite(wait) || wait < 0 || wait > MAILBOX.maxWaitMs / 1000) throw new BoardError(400, 'invalid_wait', { min_s: 0, max_s: MAILBOX.maxWaitMs / 1000 });

    const page = () => {
      const all = mailbox.list(want, afterSeq);
      const messages = all.slice(0, MAILBOX.page);
      return { lane: want, messages, next: messages.length ? messages.at(-1).seq : afterSeq, more: all.length > messages.length };
    };
    const first = page();
    if (first.messages.length || wait <= 0) return first;
    if (signal?.aborted) return { ...first, closed: true };

    const closed = await new Promise(resolve => {
      let done = false;
      const finish = value => {
        if (done) return;
        done = true;
        off(); clearTimeout(timer); signal?.removeEventListener?.('abort', onAbort);
        if (inboxWaiters.get(actor.token_id) === waiter) inboxWaiters.delete(actor.token_id);
        resolve(value);
      };
      const check = () => { if (mailbox.list(want, afterSeq).length) finish(false); };
      const onAbort = () => finish(true);
      const off = mailbox.onMessage(check);
      const timer = setTimeout(() => finish(false), wait * 1000);
      const waiter = { close: () => finish(true) };
      const prev = inboxWaiters.get(actor.token_id);
      inboxWaiters.set(actor.token_id, waiter);
      signal?.addEventListener?.('abort', onAbort, { once: true });
      check(); // a message that landed between page() and the listener is not lost
      if (prev && prev !== waiter) prev.close();
    });
    const out = page();
    return closed ? { ...out, closed: true } : out;
  }

  function write(secret, body, { crashAfterJournal = false } = {}) {
    const actor = authenticate(secret);
    if (!actor) throw new BoardError(401, 'unauthorized');
    if (actor.role === 'reporter') limitReporter(actor);
    const envErrors = validate(schemas, 'write-request.json', body);
    if (envErrors.length) throw new BoardError(400, 'invalid_request', { errors: envErrors });
    const rule = OP_RULES[body.op];
    const bodyHash = sha256(actor.token_id + '\n' + canonical({ op: body.op, target_id: body.target_id, expected_revision: body.expected_revision ?? null, data: body.data, origin: body.origin ?? null }));

    const seen = store.state.requests[body.request_id];
    if (seen) {
      if (seen.body_sha256 !== bodyHash) throw new BoardError(409, 'request_id_reused');
      return { ok: true, deduped: true, event_id: seen.event_id, seq: seen.seq, id: seen.id, revision: seen.revision };
    }

    // A reporter is checked for its role and scope BEFORE anything reads the body's data or the board's rules, so no
    // validation message or honesty-rule answer can describe a task outside its scope (the same 403 whether the task exists or not).
    if (actor.role === 'reporter') {
      if (!rule.roles.includes('reporter')) throw new BoardError(403, 'forbidden_for_role', { role: actor.role, allowed: rule.roles });
      if (validate(schemas, 'common.json', body.target_id, { $ref: `#/$defs/${rule.target}` }).length) throw new BoardError(400, 'invalid_target_id');
      const t = taskOf(store.state, body.op, body.target_id);
      if (t && !inScope(actor, t)) throw new BoardError(403, 'out_of_scope', { task_id: t });
    }

    // A device token (a phone, J-05 D3) is refused the ops marked x-device:false before its data is read, whatever its role.
    if (actor.device && !rule.device) throw new BoardError(403, 'forbidden_for_device', { op: body.op });

    const dataErrors = validate(schemas, `ops/${body.op}.json`, body.data);
    // Board honesty rules (src/rules.mjs) on the task as it would be after this write. Any violation rejects the
    // whole write and the response lists every violation in `violations`. When the data also fails its schema
    // (an unknown state does), the error stays `invalid_data` with `errors`; otherwise the first violation is
    // mirrored at top level, as the J-05 board answers.
    const violations = violationsForWrite(store.state, body);
    const withViolations = violations.length ? { violations } : {};
    if (dataErrors.length) throw new BoardError(400, 'invalid_data', { errors: dataErrors, ...withViolations });
    if (violations.length) { const { error, ...first } = violations[0]; throw new BoardError(400, error, { ...first, violations }); }
    const targetErrors = validate(schemas, 'common.json', body.target_id, { $ref: `#/$defs/${rule.target}` });
    if (targetErrors.length) throw new BoardError(400, 'invalid_target_id', { errors: targetErrors });
    if (!rule.roles.includes(actor.role)) throw new BoardError(403, 'forbidden_for_role', { role: actor.role, allowed: rule.roles });
    if (rule.revision === 'create' && body.expected_revision) throw new BoardError(409, 'revision_conflict', { current_revision: 0 });

    const state = store.state;
    const task = taskOf(state, body.op, body.target_id);
    if (task && !inScope(actor, task)) {
      throw new BoardError(403, 'out_of_scope', { task_id: task });
    }

    return commit(actor, body, bodyHash, (seq, at) => OPS[body.op].check({ state, req: body, seq, at, actor, config: { maxAttachmentBytes }, storeBlob: store.storeBlob, webhookSecret, readEvent: n => store.readEvents(n - 1, 1)[0] }), { crashAfterJournal });
  }

  /** Journal one accepted event. `prepare(seq, at)` runs the op's checks and returns { data, result, reveal? }. */
  function commit(actor, body, bodyHash, prepare, { crashAfterJournal = false } = {}) {
    const seq = store.state.seq + 1;
    const fullActor = { token_id: actor.token_id, name: actor.name, role: actor.role, ...(actor.label ? { label: actor.label } : {}), ...(actor.lane ? { lane: actor.lane } : {}), ...(actor.model ? { model: actor.model } : {}), ...(body.origin ? { origin: body.origin } : {}) };
    const at = iso(); // taken before the checks: an op that words its result with the time (turn.report) uses the event's own
    const prepared = prepare(seq, at);
    // An op may decide the write changes nothing (e.g. clearing a route override that is already absent): answer
    // success without a journal line, so a retry cannot add a second note and history stays truthful.
    if (prepared.noop) return { ok: true, noop: true, event_id: null, seq: store.state.seq, id: prepared.result?.id ?? body.target_id, revision: prepared.result?.revision ?? 0 };
    const ev = { seq, id: `evt-${seq}`, at, request_id: body.request_id, body_sha256: bodyHash, actor: fullActor, op: body.op, target_id: body.target_id, data: prepared.data, result: prepared.result };
    store.append(ev, { crashAfterJournal });
    publish(ev);
    return { ok: true, event_id: ev.id, seq, id: ev.result.id, revision: ev.result.revision, ...(prepared.reveal || {}) };
  }

  /**
   * Streamed upload for files too large for base64 JSON (video, audio, big images). Owner and coordinator only.
   * The body is written to a temp file while it is hashed and counted, type-checked on its first bytes, then
   * moved to its content address and journaled as an ordinary attachment.add event (bytes never in the journal).
   * `meta` = { request_id, task_id, name, mime, step_id?, caption?, visibility?, origin? } (see schema/v1/upload.json).
   */
  async function upload(secret, meta, body, { contentLength } = {}) {
    const drain = () => new Promise(r => { if (body.readableEnded) return r(); body.on('end', r); body.on('error', r); body.resume(); });
    const refuse = async e => { await drain(); throw e; };
    const actor = authenticate(secret);
    if (!actor) return refuse(new BoardError(401, 'unauthorized'));
    const errors = validate(schemas, 'upload.json', meta);
    if (errors.length) return refuse(new BoardError(400, 'invalid_request', { errors }));
    if (!['owner', 'coordinator'].includes(actor.role)) return refuse(new BoardError(403, 'forbidden_for_role', { role: actor.role, allowed: ['owner', 'coordinator'] }));
    if (contentLength > maxUploadBytes) return refuse(new BoardError(413, 'attachment_too_large', { max_bytes: maxUploadBytes }));
    const forMessage = meta.purpose === 'message', cap = forMessage ? Math.min(maxUploadBytes, MESSAGE_IMAGE.maxBytes) : maxUploadBytes;
    if (forMessage && !MESSAGE_IMAGE.mimes.includes(meta.mime)) return refuse(new BoardError(400, 'image_type_not_allowed', { allowed: MESSAGE_IMAGE.mimes }));
    if (forMessage && contentLength > cap) return refuse(new BoardError(413, 'image_too_large', { max_bytes: cap }));
    const checkTarget = () => {
      if (!store.state.tasks[meta.task_id]) throw new BoardError(404, 'task_not_found', { target_id: meta.task_id });
      if (meta.step_id && !store.state.steps[`${meta.task_id}/${meta.step_id}`]) throw new BoardError(404, 'step_not_found', { target_id: `${meta.task_id}/${meta.step_id}` });
    };
    try { checkTarget(); } catch (e) { return refuse(e); }

    const tmp = store.uploadTempPath();
    const out = fs.createWriteStream(tmp, { flags: 'wx', mode: 0o600 });
    const hash = crypto.createHash('sha256');
    let size = 0, head = Buffer.alloc(0), failure = null;
    const text = TEXT_MIMES.has(meta.mime) ? createTextCheck() : null; // text is checked on the whole stream, every other mime on its 16-byte head
    try {
      await new Promise((resolve, reject) => {
        body.on('data', chunk => {
          if (failure) return; // keep draining so the client receives the error response instead of a reset
          size += chunk.length;
          if (size > cap) { failure = new BoardError(413, forMessage ? 'image_too_large' : 'attachment_too_large', { max_bytes: cap }); out.destroy(); return; }
          if (head.length < 16) head = Buffer.concat([head, chunk.subarray(0, 16 - head.length)]);
          if (text) text.push(chunk);
          hash.update(chunk);
          if (!out.write(chunk)) { body.pause(); out.once('drain', () => body.resume()); }
        });
        body.on('end', () => (failure ? resolve() : out.end(resolve)));
        body.on('error', reject);
        out.on('error', e => { if (!failure) reject(e); });
      });
      if (failure) throw failure;
      if (!size) throw new BoardError(400, 'empty_attachment');
      if (!(text ? text.end() : MAGIC[meta.mime](head))) throw new BoardError(400, 'content_does_not_match_mime');
      const blobSha = hash.digest('hex');
      const { request_id, task_id, origin, purpose: _purpose, ...fields } = meta;
      const req = { request_id, op: 'attachment.add', target_id: task_id, data: { ...fields, sha256: blobSha }, ...(origin ? { origin } : {}) };
      const bodyHash = sha256(actor.token_id + '\n' + canonical({ op: req.op, target_id: task_id, expected_revision: null, data: req.data, origin: origin ?? null }));
      const seen = store.state.requests[request_id];
      if (seen) {
        if (seen.body_sha256 !== bodyHash) throw new BoardError(409, 'request_id_reused');
        return { ok: true, deduped: true, event_id: seen.event_id, seq: seen.seq, id: seen.id, revision: seen.revision };
      }
      checkTarget(); // the board may have changed while the body streamed in
      store.adoptBlob(tmp, blobSha);
      return commit(actor, req, bodyHash, seq => ({ data: { ...fields, size, sha256: blobSha }, result: { id: `att-${seq}`, revision: 1 } }));
    } finally {
      fs.rmSync(tmp, { force: true }); // no-op once adopted
    }
  }

  // Short-lived capability links so <video>/<audio> can stream with Range requests: the bearer token never goes
  // into a URL; a link names one attachment and expires. Key lives in <data>/media.secret, never journaled.
  const mediaKeyFile = path.join(dataDir, 'media.secret');
  let mediaKey = null;
  const getMediaKey = () => {
    if (mediaKey) return mediaKey;
    try { mediaKey = fs.readFileSync(mediaKeyFile, 'utf8').trim(); } catch { mediaKey = crypto.randomBytes(32).toString('base64url'); fs.writeFileSync(mediaKeyFile, mediaKey + '\n', { mode: 0o600 }); }
    return mediaKey;
  };
  const mediaSig = (id, exp) => crypto.createHmac('sha256', getMediaKey()).update(`${id}.${exp}`).digest('hex');
  const canRead = (secret, a) => (a.visibility === 'public' && store.state.tasks[a.task_id]?.visibility === 'public') || (actor => !!actor && inScope(actor, a.task_id))(authenticate(secret));

  // Last time the coordinator's watcher read the board (the predecessor's watcherAt: shown to the owner as
  // "the coordinator is on duty"). In memory only; noted by the compatibility layer's direct loopback read.
  let watcherAt = '';
  return {
    bootstrapTokenFile,
    ownerCredential,
    noteWatcher() { watcherAt = iso(); },
    get state() { return store.state; },
    get replayed() { return store.replayed; },
    authenticate,
    write,
    /** `turns` (GET /api/v1/state?v=2) adds the latest turn report of each lane the token may read; `archived` (?archived=1)
     *  adds each task's archived step metadata. Without either the view is the v1 one. */
    view(secret, { turns = false, archived = false } = {}) { return boardView(store.state, { actor: authenticate(secret), nowMs: now(), stallMs, config, webhookStatus, watcherAt, roleSlots, turns, archived }); },
    /**
     * Dry run of steps.compact, shared with the op's own eligibility function (compactPlan): a GET route, never board.write,
     * so it can write nothing and does not enter the request-id/replay bookkeeping. Owner and coordinator only.
     */
    compactPreview(secret, { task, keep_last } = {}) {
      const actor = authenticate(secret);
      if (!actor) throw new BoardError(401, 'unauthorized');
      if (!['owner', 'coordinator'].includes(actor.role)) throw new BoardError(403, 'forbidden_for_role', { role: actor.role, allowed: ['owner', 'coordinator'] });
      if (!task) throw new BoardError(400, 'task_required');
      const n = keep_last == null || keep_last === '' ? COMPACT_DEFAULT_KEEP : Number(keep_last);
      if (!Number.isInteger(n) || n < 1 || n > 45) throw new BoardError(400, 'invalid_keep_last', { min: 1, max: 45 });
      const t = store.state.tasks[task] || (() => { throw new BoardError(404, 'task_not_found', { target_id: task }); })();
      const plan = compactPlan(store.state, task, n);
      return { task_id: task, revision: t.rev, keep_last: n, ...plan };
    },
    /** The board's task-statistics document (J-05), as PUT /api/admin/stats stored it, or null. Read by GET /api/stats.
     *  Derived data loaded from <data>/stats.json at startup, never journaled (see the loader above). */
    stats() { return statsDoc; },
    /** GET /api/v1/quota: the quota side file <data>/quota.json (src/quota.mjs). Any signed-in token reads it (owner, coordinator, reporter):
     *  it carries account usage only, no task or person data, and the external edge never reaches the route. */
    quota(secret) {
      if (!authenticate(secret)) throw new BoardError(401, 'unauthorized');
      return readQuota(dataDir, doc => validate(schemas, 'quota.json', doc));
    },
    /**
     * Replace the board's task-statistics document. Validated against schema/v1/stats.json (400 invalid_data), capped
     * at STATS_MAX_BYTES (413 too_large) and written atomically (temp + rename) to <data>/stats.json, the same data dir
     * as the journal and the projection; the in-memory copy follows. Nothing is written to the journal.
     * Answers { ok, revision, generated_at }, as the predecessor PUT /api/admin/stats did.
     */
    putStats(doc) {
      const errors = validate(schemas, 'stats.json', doc);
      if (errors.length) throw new BoardError(400, 'invalid_data', { errors });
      const bytes = Buffer.byteLength(JSON.stringify(doc));
      if (bytes > STATS_MAX_BYTES) throw new BoardError(413, 'too_large', { max_bytes: STATS_MAX_BYTES, bytes });
      const tmp = statsPath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(doc));
      fs.renameSync(tmp, statsPath);
      statsDoc = doc; statsRev += 1;
      return { ok: true, revision: statsRev, generated_at: doc.generated_at };
    },
    /**
     * One lane's turn reports with their detail, newest first (GET /api/v1/turns). Owner and coordinator read any lane, a lane token
     * its own; anyone else is refused, the quick report quotes asks and is as private as the detail. `limit` 1..50, default 20.
     */
    turns(secret, lane, limit) {
      const actor = authenticate(secret);
      if (!actor) throw new BoardError(401, 'unauthorized');
      if (!lane) throw new BoardError(400, 'lane_required');
      const n = limit == null || limit === '' ? TURN.readDefault : Number(limit);
      if (!Number.isInteger(n) || n < 1) throw new BoardError(400, 'invalid_limit', { min: 1, max: TURN.history });
      if (!mayUseLane(actor, lane)) throw new BoardError(403, 'forbidden_lane', { lane });
      const known = turnLane(store.state, lane);
      if (!known) throw new BoardError(404, 'unknown_lane', { lane });
      return { lane: known, turns: turnList(store.state, known, Math.min(n, TURN.history)) };
    },
    /**
     * Owner signals for owner and coordinator tokens. Replays journal events after `afterSeq` (null: live only),
     * then follows new ones. Sends a cursor ({ cursor: seq }) after the replay so a client can resume without gaps.
     * Ends with onEnd('revoked') if the token stops being valid. Returns an unsubscribe function.
     */
    watch(secret, { afterSeq = null, types = SIGNAL_TYPES } = {}, { onSignal, onCursor, onEnd }) {
      const actor = authenticate(secret);
      if (!actor) throw new BoardError(401, 'unauthorized');
      if (actor.role === 'reporter') throw new BoardError(403, 'forbidden_for_role');
      let last = afterSeq ?? store.state.seq;
      const stop = () => listeners.delete(follow);
      function follow(ev) {
        if (ev.seq <= last) return;
        if (!authenticate(secret)) { stop(); return onEnd?.('revoked'); }
        last = ev.seq;
        const signal = ownerSignal(store.state, ev);
        if (signal && types.includes(signal.type)) onSignal(signal);
      }
      listeners.add(follow);
      if (afterSeq != null) for (const ev of store.readEvents(afterSeq, Infinity)) follow(ev);
      onCursor?.(last);
      return stop;
    },
    /** Audit journal after `after`, oldest first, at most `limit`; with `task`, only events on that task (a task's history). */
    events(secret, after = 0, limit = 200, { task } = {}) {
      const actor = authenticate(secret);
      if (!actor) throw new BoardError(401, 'unauthorized');
      if (actor.role === 'reporter') throw new BoardError(403, 'forbidden_for_role');
      const max = Math.min(limit, 1000);
      if (!task) return store.readEvents(after, max);
      return store.readEvents(after, Infinity).filter(ev => eventTask(store.state, ev) === task).slice(0, max);
    },
    tokens(secret) {
      const actor = authenticate(secret);
      if (!actor) throw new BoardError(401, 'unauthorized');
      if (actor.role !== 'owner') throw new BoardError(403, 'forbidden_for_role');
      return Object.values(store.state.tokens).map(publicToken);
    },
    /**
     * Attachment bytes: public attachments on public tasks are anonymous-readable, everything else needs a token
     * or an unexpired link from mediaLink().
     */
    media(secret, id, { exp, sig } = {}) {
      const a = store.state.attachments[id];
      if (!a) throw new BoardError(404, 'not_found');
      let linked = false;
      if (exp && sig && /^[0-9]{1,12}$/.test(exp) && /^[a-f0-9]{64}$/.test(sig) && Number(exp) * 1000 > now()) {
        linked = crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(mediaSig(id, exp), 'hex'));
      }
      if (!linked && !canRead(secret, a)) throw new BoardError(404, 'not_found');
      return { mime: a.mime, file: store.blobPath(a.sha256), size: a.size };
    },
    /** A relative URL that streams one attachment without a bearer header, until it expires. */
    mediaLink(secret, id) {
      const a = store.state.attachments[id];
      if (!a || !canRead(secret, a)) throw new BoardError(404, 'not_found');
      const exp = String(Math.floor((now() + DEFAULTS.mediaLinkMs) / 1000));
      return { url: `api/v1/media/${id}?exp=${exp}&sig=${mediaSig(id, exp)}`, expires_at: new Date(Number(exp) * 1000).toISOString() };
    },
    /**
     * Files one status request (rebrief.request, mode status) for every stale task that has none open, when the owner
     * left auto_request on. A task.update that changes Now/Next closes the request, so a second sweep on the same
     * task files nothing. Quiet rules (views.mjs sweepSkips/sweepNight): none for a grey, paused or closed task, none for a
     * task written to in the last 60 min, none 23:00-07:00 ICT, and (J-05) none for a row whose every open step waits on the
     * owner (a waiting owner step or an open ask) after a push in the last 24 h. Returns how many it filed. server.mjs runs it hourly.
     */
    sweepFreshness() {
      const state = store.state, fr = { ...FRESHNESS_DEFAULTS, ...state.freshness };
      if (!fr.auto_request || sweepNight(now())) return 0;
      const actor = { token_id: 'system', name: 'system', role: 'owner' };
      let filed = 0;
      for (const s of staleText(state, now(), fr)) {
        if (openStatusRequest(state, s.task_id) || sweepSkips(state, state.tasks[s.task_id], now())) continue;
        const body = { request_id: `sweep-${s.task_id}-${now()}`, op: 'rebrief.request', target_id: s.task_id, data: { mode: 'status', auto: true } };
        commit(actor, body, sha256(canonical(body)), seq => OPS[body.op].check({ state, req: body, seq, actor }));
        filed++;
      }
      return filed;
    },
    upload,
    sendMessage,
    inbox: inboxFor,
    close: () => {
      for (const w of inboxWaiters.values()) w.close();
      inboxWaiters.clear();
      store.close(); mailbox.close();
    }
  };
}
