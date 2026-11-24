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
import { supervisorConfig, sweepPlan, openHeads, supervisorMetrics, rootOf } from './supervisor.mjs';
import { ownerWaitWithoutAsk, goalQcMissing, GOAL_QC_MESSAGE, GUARDS_OFF_MESSAGE, idleOf, phaseViolations, isNewEra } from './guards.mjs';
import { boardView, inScope, publicToken, ownerSignal, staleText, openStatusRequest, sweepNight, sweepSkips, FRESHNESS_DEFAULTS, SIGNAL_TYPES, NOTIFY_DEFAULTS, messagesView, pickups, scopedRelated } from './views.mjs';
import { liveSets, historyPage } from './window.mjs';
import { OWNER_TZ, validTimeZone } from './times.mjs';
import { openConnectorTokens } from './connector-tokens.mjs';
import { openDiagrams } from './diagrams.mjs';
import { openOwner2fa, readKeyFile } from './owner-2fa.mjs';
import { workView, knownRuns, cappedRuns, RUN_FRESH_MS } from './work.mjs';
import { openDeliveryStore, checkMark, checkPresence, tracked, deliveryOf, connectorsView, PRESENCE_STALE_MS, PRESENCE_MACHINES_MAX } from './delivery.mjs';

/** GET /api/v1/history: records per page. */
const HISTORY_PAGE = { default: 200, max: 500 };

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
  if (op === 'feedback.resolve' || op === 'nudge.clear') return state.feedback[t]?.task_id ?? null;
  if (op.startsWith('token.') || op.startsWith('ping') || ['prefs.set', 'notify.set', 'freshness.set', 'summary.set', 'registry.set', 'turn.report'].includes(op)) return null;
  return t;
}
const canonical = v => Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',')}}` : JSON.stringify(v);

/** An image pasted or dropped into a message (upload purpose=message): these types only, and a hard cap. */
export const MESSAGE_IMAGE = { mimes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], maxBytes: 5 * 1024 * 1024 };
// maxVideoBytes / mediaBudgetBytes (J-05 10-11, gate S1/S2): clips became routine (`say --img`) on a box at 96 % disk. A video is
// capped on its own, and a new one is refused once the stored media would pass the budget; images are never refused by it.
export const DEFAULTS = { stateWindowDays: 7, stallMs: 3 * 3600000, maxAttachmentBytes: 256 * 1024, maxUploadBytes: 64 * 1024 * 1024, maxVideoBytes: 25 * 1024 * 1024, mediaBudgetBytes: 2 * 1024 * 1024 * 1024, mediaLinkMs: 3600000, reporterWritesPerMin: 30, models: ['opus', 'sonnet', 'haiku', 'deepseek', 'gpt', 'gemini'] };

/**
 * @param {object} o
 * @param {string} o.dataDir       private data directory (journal, projection, media)
 * @param {() => number} [o.now]   clock in ms; injectable for tests only
 * @param {string} [o.ownerToken]  bootstrap owner secret; generated and saved to <dataDir>/owner.token when absent
 * @param {number[]} [o.webhookRetryMs] delays between webhook attempts; injectable for tests only
 * @param {number} [o.maxUploadBytes] cap for streamed uploads (POST /api/v1/upload); base64 attachment.add keeps maxAttachmentBytes
 * @param {number} [o.maxVideoBytes]  cap for one streamed video/* upload
 * @param {number} [o.mediaBudgetBytes] a new video/* upload is refused (507) when the stored media would pass this
 * @param {number} [o.reporterWritesPerMin] most write attempts per rolling minute for one reporter token; the next is refused 429 rate_limited
 * @param {object} [o.mailboxLimits] { dailyPerLane, maxBytes } lane-mailbox caps; the production values live in MAILBOX, tests only override them
 * @param {boolean} [o.roleSlots]  default true: every task carries its plan/code/review/scout slots (ADR 2026-10-09). An embedder
 *   whose users must not see lane model names (the Zumi desktop app's local board) passes false: the view then has no
 *   `roles`, so the page draws no "Workers by task" table. The journal and the ops are unchanged either way.
 * @param {string} [o.ownerTz]  IANA zone the owner reads times in (env BOARD_OWNER_TZ, default Asia/Ho_Chi_Minh): every reader shows dd-mm HH:mm there and keeps the ISO UTC value
 * @param {string} [o.guardsSince]  ISO time (env BOARD_GUARDS_SINCE): from then on the "drive to goal" guards hold (src/guards.mjs:
 *   an owner wait needs an ask, goal QC at task open, the idle detector). Tasks created before it are grandfathered. Unset = off,
 *   and the board writes and reads exactly as it did without them.
 * @param {string} [o.r4PerMessageSince]  ISO time (env BOARD_R4_PER_MESSAGE_SINCE): owner messages older than this keep R4's old "any later CoS reply clears"; unset = every message is per message
 * @param {string} [o.phaseRulesSince]  ISO time (env BOARD_PHASE_RULES_SINCE): from then on the phase rules hold (src/guards.mjs
 *   R1 a new step names its phase / a busy task gets phases, R2 a new phase plan folds the old era, R4 an owner message CoS
 *   handled needs a CoS answer in the thread). A switch of its own: unset = off, the board writes and reads as without them.
 */
export function createBoard({ dataDir, now = Date.now, ownerToken, stallMs = DEFAULTS.stallMs, maxAttachmentBytes = DEFAULTS.maxAttachmentBytes, maxUploadBytes = DEFAULTS.maxUploadBytes, maxVideoBytes = DEFAULTS.maxVideoBytes, mediaBudgetBytes = DEFAULTS.mediaBudgetBytes, models = DEFAULTS.models, modelLabels = {}, webhookRetryMs = [1000, 5000], roleSlots = true, reporterWritesPerMin = DEFAULTS.reporterWritesPerMin, mailboxLimits = {}, guardsSince = '', phaseRulesSince = '', r4PerMessageSince = '', stateWindowDays = DEFAULTS.stateWindowDays, supervisorSince = '', runFreshMs = RUN_FRESH_MS, supervisorConfig: supervisorOverrides = {}, deliverySince = '', ownerTz = OWNER_TZ, owner2faKey = null, owner2faKeyFile = '', owner2faEnrolUntil = '', owner2faOff = false, diagramLimits = {} } = {}) {
  const store = openStore(dataDir);
  // The lane mailbox lives in its own append file, never in the journal (see src/mailbox.mjs for the rollback
  // reason). Opening it here prunes bodies older than 30 days on startup; a daily timer keeps pruning.
  const mailbox = openMessageStore(dataDir, { now, ...mailboxLimits });
  // models: suggestions for the owner's worker picker only; any id matching the schema pattern is accepted.
  // modelLabels: display names for those ids (e.g. sonnet -> "Sonnet 5.5"), shown wherever a worker is.
  if (!validTimeZone(ownerTz)) throw new Error(`ownerTz is not a time zone: ${ownerTz}`);
  const config = { version: VERSION, owner_tz: ownerTz, stall_ms: stallMs, max_attachment_bytes: maxAttachmentBytes, max_upload_bytes: maxUploadBytes, models, model_labels: modelLabels, ...(guardsSince ? { guards_since: guardsSince } : {}), ...(phaseRulesSince ? { phase_rules_since: phaseRulesSince } : {}) };
  if (guardsSince && !Number.isFinite(Date.parse(guardsSince))) throw new Error(`guardsSince is not an ISO time: ${guardsSince}`);
  if (phaseRulesSince && !Number.isFinite(Date.parse(phaseRulesSince))) throw new Error(`phaseRulesSince is not an ISO time: ${phaseRulesSince}`);
  if (r4PerMessageSince && !Number.isFinite(Date.parse(r4PerMessageSince))) throw new Error(`r4PerMessageSince is not an ISO time: ${r4PerMessageSince}`);
  /** True once the phase rules hold (src/guards.mjs R1, R2, R4). */
  const phaseRulesOn = () => !!phaseRulesSince && now() >= Date.parse(phaseRulesSince);
  // J-05 supervisor (src/supervisor.mjs): off unless supervisorSince (env BOARD_SUPERVISOR_SINCE); thresholds from supervisorConfig.
  if (supervisorSince && !Number.isFinite(Date.parse(supervisorSince))) throw new Error(`supervisorSince is not an ISO time: ${supervisorSince}`);
  const supervisorOn = () => !!supervisorSince && now() >= Date.parse(supervisorSince);
  const svConfig = supervisorConfig(supervisorOverrides);
  /** True once the guards hold (src/guards.mjs). */
  const guardsOn = () => !!guardsSince && now() >= Date.parse(guardsSince);
  const iso = () => new Date(now()).toISOString();
  // J-05 delivery states (src/delivery.mjs): off unless deliverySince (env BOARD_DELIVERY_SINCE). Off = the two routes answer
  // 409 delivery_off, no view carries a delivery field, no side file is written: the board behaves as the release before it.
  if (deliverySince && !Number.isFinite(Date.parse(deliverySince))) throw new Error(`deliverySince is not an ISO time: ${deliverySince}`);
  const deliveryOn = () => !!deliverySince;
  const deliveryStore = deliverySince ? openDeliveryStore(dataDir) : null;
  const presence = {}; // machine -> { machine, atMs, lanes, runs?, runs_error? }: in memory only, like watcherAt
  const lastRunMs = {}; // task -> last time a run of it was in a beat (J-05 working status: when "nobody" began); in memory only
  const bootMs = now();
  const deliveryListeners = new Set();
  // J-05 connector tokens (src/connector-tokens.mjs): the connector's own credential, never a board token. Opened whether delivery is
  // on or off, so the owner can issue one before switching delivery on; the file is written only when the owner issues or revokes.
  const connTokens = openConnectorTokens(dataDir, { now });
  const publishDelivery = sig => { for (const l of deliveryListeners) queueMicrotask(() => { try { l(sig); } catch (e) { console.error('delivery listener failed', e); } }); };

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
  // W-42 5A rev 3: the owner second factor (src/owner-2fa.mjs). Off (the switch, or no key): every owner-only act is 503 owner_2fa_off.
  // With the switch the key file is not even read, so the view + comment release needs no key on the server.
  const twofa = openOwner2fa(dataDir, { now, key: owner2faOff ? null : owner2faKey || (owner2faKeyFile ? readKeyFile(owner2faKeyFile) : null), enrolUntil: owner2faEnrolUntil });
  /** Bearer secret -> actor, or null. Revoked tokens resolve to null. */
  function authenticate(secret) {
    if (!secret) return null;
    if (secret === ownerCredential) {
      // Never a device token (J-05 D3): the login is the owner's own, and a phone token must not become its identity.
      const o = Object.values(store.state.tokens).find(x => x.role === 'owner' && !x.revoked_at && !x.device && !x.ui); // W-42 5A: nor a ui token
      return o ? { token_id: o.id, name: o.name, role: 'owner', ...(o.label ? { label: o.label } : {}), scope_tasks: o.scope_tasks, via: 'proxy' } : null;
    }
    if (typeof secret !== 'string') return null;
    const h = sha256(secret);
    const t = Object.values(store.state.tokens).find(x => x.sha256 === h && !x.revoked_at);
    if (!t) return null;
    return { token_id: t.id, name: t.name, role: t.role, ...(t.label ? { label: t.label } : {}), ...(t.lane ? { lane: t.lane } : {}), ...(t.model ? { model: t.model } : {}), ...(t.device ? { device: true } : {}), ...(t.ui ? { ui: true } : {}), scope_tasks: t.scope_tasks };
  }
  /**
   * W-42 5A contract 3.5: which owner UI credential an actor is ('proxy' | 'device' | 'ui'), or false. A raw owner bearer is never
   * one, and nor is a device or ui token minted with a raw bearer before 5A (it carries parent, gate rev-2 should-fix).
   */
  function ownerUi(actor) {
    if (!actor || actor.role !== 'owner') return false;
    if (actor.via === 'proxy') return 'proxy';
    const t = store.state.tokens[actor.token_id];
    if (!t || t.revoked_at || t.parent) return false;
    return t.ui ? 'ui' : t.device ? 'device' : false;
  }
  /** Rev 3 (3.7.3): the owner device this request comes from ('dv-N'), or null. The cookie counts only on top of the owner login. */
  function ownerDeviceOf(actor, cookie) {
    const ui = ownerUi(actor);
    if (!ui) return null;
    return ui === 'proxy' ? twofa.browserDevice(cookie) : twofa.tokenDevice(actor.token_id);
  }
  /** The actor as the journal records it. via, owner_device and relay are server-set, never read from request data. */
  function journalActor(actor, body) {
    return { token_id: actor.token_id, name: actor.name, role: actor.role, ...(actor.label ? { label: actor.label } : {}), ...(actor.lane ? { lane: actor.lane } : {}), ...(actor.model ? { model: actor.model } : {}), ...(body.origin ? { origin: body.origin } : {}),
      ...(actor.via ? { via: actor.via } : {}), ...(actor.owner_device ? { owner_device: actor.owner_device } : {}), ...(/^zumi-relay-/.test(body.request_id || '') ? { relay: true } : {}) };
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
  let boardClosed = false;

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

  /** `ownerAskChecked`: in-process callers only (the legacy row push), never reachable over HTTP: the caller already checked
   *  guard B1 for its whole push, asks raised later in the same push included, so the per-op check is not repeated. */
  function write(secret, body, { crashAfterJournal = false, ownerAskChecked = false, phaseChecked = false, deferEra = false, internalActor = null, ownerDeviceCookie = '' } = {}) {
    // internalActor: the diagram route's pointer message (contract 4.1). No HTTP caller can set it (server.mjs passes only the cookie).
    const actor = internalActor || authenticate(secret);
    if (!actor) throw new BoardError(401, 'unauthorized');
    if (actor.role === 'reporter') limitReporter(actor);
    if (!internalActor) {
      if (typeof body?.request_id === 'string' && body.request_id.startsWith('diagram-')) throw new BoardError(400, 'reserved_request_id', { message: 'BLOCKED write / WHY request ids starting diagram- belong to the diagram messages of the board / DO pick another request id' });
      if (body?.op === 'feedback.add' && body.data?.kind === 'diagram') throw new BoardError(403, 'server_only_kind', { message: 'BLOCKED feedback kind diagram / WHY only the diagram route writes it / DO save the diagram through POST /api/v1/diagram' });
      const dev = actor.role === 'owner' ? ownerDeviceOf(actor, ownerDeviceCookie) : null;
      if (dev) actor.owner_device = dev;
    }
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
    // Open questions mint asks with ids ask-<seq>-<n>, which a build older than the guards cannot take: a guard write, refused while off.
    if (!guardsOn() && body.op === 'task.create' && body.data?.open_questions?.length) throw new BoardError(400, 'guards_off', { task: body.target_id, message: GUARDS_OFF_MESSAGE });
    // Guard B2: a task opens with its goal QC (tasks created before guardsSince are grandfathered: only a create is checked).
    const qcMissing = guardsOn() && body.op === 'task.create' ? goalQcMissing(body.data) : [];
    if (qcMissing.length) throw new BoardError(400, 'goal_qc_required', { task: body.target_id, missing: qcMissing, message: GOAL_QC_MESSAGE });
    // Guard B1: a step enters an owner wait only with an open ask on it (or one the same write raises).
    const ownerWaits = guardsOn() && !ownerAskChecked ? ownerWaitWithoutAsk(store.state, body) : [];
    if (ownerWaits.length) { const { error, ...first } = ownerWaits[0]; throw new BoardError(400, error, { ...first, violations: ownerWaits }); }
    // Phase rule R1: a new step names its phase; a task with no phases takes no new goal and no open step past the limit.
    const phaseErrs = phaseRulesOn() && !phaseChecked ? phaseViolations(store.state, body) : [];
    if (phaseErrs.length) { const { error, ...first } = phaseErrs[0]; throw new BoardError(400, error, { ...first, violations: phaseErrs }); }
    // Phase rule R2 (gate finding 6): an era fold archives every done step naming no phase of the plan, the last ones too, and
    // archived ids are retired. The board folds only on a new plan with the rules on (foldEra); a caller's era fold is held to
    // the same two conditions, or a phase-less task (empty plan) would lose its whole done history in one write.
    if (body.op === 'steps.compact' && body.data?.era === true) {
      if (!phaseRulesOn()) throw new BoardError(400, 'phase_rules_off', { task: body.target_id, message: 'an era fold (steps.compact era) runs only with the phase rules on' });
      if (!store.state.tasks[body.target_id]?.phases?.length) throw new BoardError(400, 'era_needs_phases', { task: body.target_id, message: 'an era fold needs the task\'s phases: a task without phases would fold every done step' });
    }
    const targetErrors = validate(schemas, 'common.json', body.target_id, { $ref: `#/$defs/${rule.target}` });
    if (targetErrors.length) throw new BoardError(400, 'invalid_target_id', { errors: targetErrors });
    if (!rule.roles.includes(actor.role)) throw new BoardError(403, 'forbidden_for_role', { role: actor.role, allowed: rule.roles });
    if (rule.revision === 'create' && body.expected_revision) throw new BoardError(409, 'revision_conflict', { current_revision: 0 });

    const state = store.state;
    const task = taskOf(state, body.op, body.target_id);
    if (task && !inScope(actor, task)) {
      throw new BoardError(403, 'out_of_scope', { task_id: task });
    }

    // W-42 5A: a node comment's checks run after the schema and before the op's own check (asksAnsweredBy), contract 1.3.
    const anchorOn = body.op === 'feedback.add' ? diagrams.checkNodeComment(actor, body) : null;
    if (body.op === 'task.delete') { const D = diagrams.attached(body.target_id); if (D) throw new BoardError(409, 'diagram_attached', { diagram_id: D.id, rev: D.rev, pinned: D.pinned, message: 'BLOCKED task.delete / WHY the task has a diagram attached / DO the owner archives it first (diagram.archive)' }); }
    if (body.op === 'feedback.resolve' && store.state.feedback[body.target_id]?.kind === 'diagram' && !store.state.feedback[body.target_id].received) throw new BoardError(409, 'needs_receipt', { message: 'BLOCKED resolve / WHY a diagram change is closed by a receipt (it is the replan gate) / DO reply with a receipt (Đổi:, Lịch:, Bước tiếp:)' });
    const eraBefore = body.op === 'task.update' && body.data?.phases !== undefined ? store.state.tasks[body.target_id]?.phases : undefined;
    const out = commit(internalActor ? { ...internalActor, internal: true } : actor, body, bodyHash, (seq, at) => OPS[body.op].check({ state, req: body, seq, at, actor, config: { maxAttachmentBytes, supervisorOn: supervisorOn() }, storeBlob: store.storeBlob, webhookSecret, readEvent: n => store.readEvents(n - 1, 1)[0] }), { crashAfterJournal });
    // Phase rule R2: a new phase plan is a new era. The legacy push defers it to after its last row (deferEra) and calls foldEra.
    if (!deferEra && body.op === 'task.update' && body.data?.phases !== undefined && isNewEra(eraBefore, body.data.phases)) foldEra(body.target_id);
    if (anchorOn && out.event_id) diagrams.anchor(anchorOn, { result: { id: out.id }, target_id: body.target_id, request_id: body.request_id, body_sha256: bodyHash, actor: lastActor, seq: out.seq, data: body.data });
    const touched = eventTask(store.state, body); // guard B4: the task this write touched may have stopped (or started) standing still
    if (touched) checkIdle(touched);
    if (deliveryOn() && body.op === 'feedback.add' && actor.role === 'owner') sweepDelivery(); // no connector: the alarm goes out now
    return out;
  }

  // ---------- J-05 delivery (src/delivery.mjs) ----------
  const deliveryCtx = () => ({ marks: deliveryStore.marks, presence, nowMs: now(), picked: pickups(store.state), bootMs });
  const sinceMs = () => Date.parse(deliverySince);
  /** The view's hook: the delivery of one message (undefined when it is not tracked) and the connector list; undefined when off. */
  function deliveryFor() {
    if (!deliveryOn()) return undefined;
    const ctx = deliveryCtx(), since = sinceMs();
    return { of: f => (tracked(f, since) ? deliveryOf(store.state, f, ctx) : undefined), connectors: connectorsView(presence, ctx.nowMs) };
  }
  /** J-05 working status (src/work.mjs) for one reader: a reporter sees its scope's tasks and runs, no sessions. */
  const workFor = actor => workView(store.state, presence, now(), { bootMs, freshMs: runFreshMs, lastRunMs, ...(actor.role === 'reporter' ? { scopeTasks: actor.scope_tasks } : {}) });
  /** The delivery routes take a connector token and nothing else: no owner, coordinator or lane token (so no model session can set a
   *  state with its own token), 401 for no token. Returns the connector's public record. */
  const connectorOnly = secret => {
    const c = connTokens.authenticate(secret);
    if (!c) {
      const a = authenticate(secret);
      if (a) throw new BoardError(403, 'forbidden_for_role', { role: a.role, allowed: ['connector'] });
      throw new BoardError(401, 'unauthorized');
    }
    if (!deliveryOn()) throw new BoardError(409, 'delivery_off');
    return c;
  };
  const ownerOnly = secret => {
    const a = authenticate(secret);
    if (!a) throw new BoardError(401, 'unauthorized');
    if (a.role !== 'owner') throw new BoardError(403, 'forbidden_for_role', { role: a.role, allowed: ['owner'] });
    // a phone (device token) may not mint credentials, as it may not token.issue (x-device false); the owner's login or full token can
    if (a.device) throw new BoardError(403, 'forbidden_for_device', { op: 'connector-tokens' });
    return a;
  };
  const signalOf = (f, mark) => ({ type: 'delivery', id: f.id, task_id: f.task_id, stage: mark.stage, at: mark.at, ...(mark.reason ? { reason: mark.reason } : {}), ...(mark.session_id ? { session_id: mark.session_id } : {}) });
  /**
   * The watchdog (plan §6.3): every tracked open message whose derived state is undelivered and that carries no mark yet gets
   * one failed mark, written by the board itself with the derived reason, and one `delivery` signal. Run after every owner
   * message and on the server's timer. The state never waits for it: deliveryOf derives undelivered on every read.
   */
  function sweepDelivery() {
    if (!deliveryOn()) return 0;
    const ctx = deliveryCtx(), since = sinceMs();
    let n = 0;
    for (const f of Object.values(store.state.feedback)) {
      if (f.status !== 'open' || !tracked(f, since) || deliveryStore.marks[f.id]) continue;
      const d = deliveryOf(store.state, f, ctx);
      if (d.state !== 'undelivered') continue;
      const mark = { at: iso(), fb: f.id, stage: 'failed', reason: d.reason, by: { token_id: 'system', name: 'board' } };
      if (deliveryStore.add(mark)) { publishDelivery(signalOf(f, mark)); n++; }
    }
    return n;
  }

  // Guard B4, the idle detector (src/guards.mjs idleOf): when a task turns idle, or stops being idle, the board writes ONE
  // idle.mark as itself -- an idle episode, so the lane gets one feedback per episode, never one per check. Run after every
  // accepted write on the task it touched, and by the server's timer (a run stamp ages out with no write). With the guards
  // off it writes NOTHING, not even the close of an episode an earlier run left open: rolling stage 2 back is "unset
  // BOARD_GUARDS_SINCE, restart the same build", and that must add no guard event to the journal (the view hides the mark).
  // The board's own process, not the owner: its notice must never read as anh's word (legacy by 'board', not 'anh').
  const BOARD_ACTOR = { token_id: 'system', name: 'board', role: 'coordinator' };
  function checkIdle(taskId) {
    const state = store.state, t = state.tasks[taskId], was = !!state.idle?.[taskId];
    if (!t || !guardsOn()) return 0;
    const idle = idleOf(state, t, now());
    if (!!idle === was) return 0;
    const body = { request_id: `idle-${taskId}-${idle ? 'on' : 'off'}-${now()}`, op: 'idle.mark', target_id: taskId, data: idle ? { idle: true, steps: idle.steps } : { idle: false } };
    commit(BOARD_ACTOR, body, sha256(canonical(body)), seq => OPS[body.op].check({ state, req: body, seq, actor: BOARD_ACTOR }));
    return 1;
  }

  /**
   * Phase rule R2: folds the done steps of an older phase plan into `lich-su` as the board itself (one steps.compact with
   * era: true). Returns how many moved; 0 (and no event) when the rules are off or nothing is eligible.
   */
  function foldEra(taskId) {
    const state = store.state, t = state.tasks[taskId];
    if (!t || !phaseRulesOn() || !t.phases?.length) return 0;
    const moved = compactPlan(state, taskId, 0, { era: true }).moved.length;
    if (!moved) return 0;
    const body = { request_id: `era-${taskId}-${now()}`, op: 'steps.compact', target_id: taskId, expected_revision: t.rev, data: { era: true } };
    commit(BOARD_ACTOR, body, sha256(canonical(body)), seq => OPS[body.op].check({ state, req: body, seq, actor: BOARD_ACTOR }));
    return moved;
  }

  /** Journal one accepted event. `prepare(seq, at)` runs the op's checks and returns { data, result, reveal? }. */
  let lastActor = null;
  function commit(actor, body, bodyHash, prepare, { crashAfterJournal = false } = {}) {
    const seq = store.state.seq + 1;
    const { internal, ...rest } = actor;
    const fullActor = internal ? rest : journalActor(actor, body);
    lastActor = fullActor;
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

  /** Bytes of media the board stores: every attachment blob once (blobs are content-addressed, so the same bytes count once). */
  function mediaUsedBytes() {
    const seen = new Set(); let n = 0;
    for (const a of Object.values(store.state.attachments)) if (a.sha256 && !seen.has(a.sha256)) { seen.add(a.sha256); n += a.size || 0; }
    return n;
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
    const forMessage = meta.purpose === 'message', video = /^video\//.test(meta.mime);
    const cap = forMessage ? Math.min(maxUploadBytes, MESSAGE_IMAGE.maxBytes) : video ? Math.min(maxUploadBytes, maxVideoBytes) : maxUploadBytes;
    if (forMessage && !MESSAGE_IMAGE.mimes.includes(meta.mime)) return refuse(new BoardError(400, 'image_type_not_allowed', { allowed: MESSAGE_IMAGE.mimes }));
    if (forMessage && contentLength > cap) return refuse(new BoardError(413, 'image_too_large', { max_bytes: cap }));
    if (video && contentLength > cap) return refuse(new BoardError(413, 'video_too_large', { max_bytes: cap }));
    // the media budget, for a video only: what the board stores now plus this body (checked again as the bytes arrive)
    const room = video ? mediaBudgetBytes - mediaUsedBytes() : Infinity;
    const overBudget = () => new BoardError(507, 'media_budget_full', { used_bytes: mediaBudgetBytes - room, budget_bytes: mediaBudgetBytes });
    if (contentLength > room) return refuse(overBudget());
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
          if (size > cap) { failure = new BoardError(413, forMessage ? 'image_too_large' : video ? 'video_too_large' : 'attachment_too_large', { max_bytes: cap }); out.destroy(); return; }
          if (size > room) { failure = overBudget(); out.destroy(); return; }
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
  // W-42 5A: the diagram side store (src/diagrams.mjs). Opened last: its start reconcile writes through write().
  const diagrams = openDiagrams({ dataDir, now, schemas, validate, state: () => store.state, authenticate, inScope, ownerUi, ownerDeviceOf, twofa, journalActor,
    limits: diagramLimits, readJournal: () => store.readEvents(0, Number.MAX_SAFE_INTEGER),
    pointerWrite: ({ actor, task, request_id, note, block }) => write(null, { version: 1, request_id, op: 'feedback.add', target_id: task, data: { kind: 'diagram', text: note, diagram: block } }, { internalActor: actor, ownerAskChecked: true, phaseChecked: true }) });
  diagrams.reconcile();
  /** GET /api/v1/state joins: the pointer on each task with a diagram, node_id and the diagram block on feedback (rev 2 M3: never stored). */
  function joinDiagrams(v) {
    if (!v.me) return v;
    for (const t of v.tasks || []) { const D = diagrams.attached(t.id); if (D) t.diagram = diagrams.pointer(D); }
    const ridOf = new Map();
    for (const [k, r] of Object.entries(store.state.requests)) if (k.startsWith('diagram-')) ridOf.set(r.id, k);
    const join = (rec, id) => {
      const a = diagrams.anchorOf(id); if (a) rec.node_id = a.node_id;
      const b = ridOf.has(id) && diagrams.blockOf(ridOf.get(id)); if (b) rec.diagram = b;
    };
    for (const f of v.feedback || []) join(f, f.id);
    for (const m of v.messages || []) join(m, m.id);
    return v;
  }
  /** Owner 2FA routes (contract 3.7.4). Every one needs the owner UI; enrol and confirm need the web login itself. */
  function ownerActor(secret) {
    const a = authenticate(secret);
    if (!a) throw new BoardError(401, 'unauthorized');
    if (a.role !== 'owner') throw new BoardError(403, 'forbidden_for_role', { role: a.role, allowed: ['owner'] });
    const ui = ownerUi(a);
    if (!ui) throw new BoardError(403, 'owner_ui_only', { message: 'BLOCKED owner 2FA / WHY it is set up only from the owner UI / DO open the board page from your own browser or phone app' });
    return { a, ui };
  }
  const owner2fa = {
    view(secret, cookie) { const { a } = ownerActor(secret); return twofa.view(ownerDeviceOf(a, cookie)); },
    enrol(secret, cookie) {
      const { a, ui } = ownerActor(secret);
      if (ui !== 'proxy') throw new BoardError(403, 'owner_ui_only', { message: 'BLOCKED enrolment / WHY the owner code is enrolled from the web login / DO open the board page in your browser' });
      return twofa.enrol({ reenrol: twofa.enrolled && !!ownerDeviceOf(a, cookie) });
    },
    confirm(secret, body) {
      const { ui } = ownerActor(secret);
      if (ui !== 'proxy') throw new BoardError(403, 'owner_ui_only');
      const errs = validate(schemas, 'owner/confirm.json', body);
      if (errs.length) throw new BoardError(400, 'invalid_data', { errors: errs });
      return twofa.confirm(body.code, { kind: 'browser', label: body.label });
    },
    stepUp(secret, body) {
      const { a, ui } = ownerActor(secret);
      const errs = validate(schemas, 'owner/step-up.json', body);
      if (errs.length) throw new BoardError(400, 'invalid_data', { errors: errs });
      return twofa.stepUp(body, ui === 'proxy' ? { kind: 'browser', label: body.label } : { kind: 'token', tokenId: a.token_id, label: body.label || a.name });
    },
    revoke(secret, body, cookie) {
      const { a } = ownerActor(secret);
      const errs = validate(schemas, 'owner/device-revoke.json', body);
      if (errs.length) throw new BoardError(400, 'invalid_data', { errors: errs });
      const dev = ownerDeviceOf(a, cookie);
      if (!dev) { if (!twofa.configured) twofa.needKey(); twofa.audit({ event: 'owner_only_refused', ok: false, op: 'owner.device.revoke', reason: 'no_owner_device' }); throw new BoardError(403, 'owner_device_required', { op: 'owner.device.revoke' }); }
      const out = twofa.revoke(body.device_id);
      twofa.audit({ event: 'owner_only', ok: true, op: 'owner.device.revoke', target: body.device_id, device_id: dev });
      return { ok: true, ...out };
    }
  };

  return {
    bootstrapTokenFile,
    ownerCredential,
    diagramWrite: (secret, body, opts) => diagrams.write(secret, body, opts),
    diagramView: (secret, task, q) => diagrams.view(secret, task, q),
    diagramHistory: (secret, task, q) => diagrams.history(secret, task, q),
    owner2fa,
    noteWatcher() { watcherAt = iso(); },
    /** POST /api/v1/delivery: a connector's proof for one owner message (stage delivered | read | failed{reason}). Forward-only:
     *  a stage at or behind the current one answers ok with noop and writes nothing. Connector tokens only. */
    deliveryMark(secret, body) {
      const c = connectorOnly(secret);
      const b = checkMark(body);
      const f = store.state.feedback[b.feedback_id];
      if (!f) throw new BoardError(404, 'feedback_not_found', { target_id: b.feedback_id });
      if (!tracked(f, sinceMs())) throw new BoardError(400, 'not_tracked', { target_id: f.id });
      const mark = { at: iso(), fb: f.id, stage: b.stage, by: { token_id: c.id, name: c.label } };
      for (const k of ['session_id', 'machine', 'via', 'reason']) if (b[k]) mark[k] = b[k];
      if (!deliveryStore.add(mark)) return { ok: true, noop: true, id: f.id };
      publishDelivery(signalOf(f, mark));
      return { ok: true, id: f.id, state: deliveryOf(store.state, f, deliveryCtx()).state };
    },
    /** POST /api/v1/presence: a connector's beat (machine, lanes served, session status per lane). In memory only, never journaled. */
    presenceBeat(secret, body) {
      connectorOnly(secret);
      const p = checkPresence(body);
      // the map is in memory and keyed by a caller-chosen name: capped, so a typo loop cannot grow it without bound
      if (!presence[p.machine] && Object.keys(presence).length >= PRESENCE_MACHINES_MAX) throw new BoardError(429, 'too_many_machines', { max: PRESENCE_MACHINES_MAX });
      const { runs_dropped: dropped, ...rec } = p;
      if (rec.runs) rec.runs = knownRuns(store.state, rec.runs); // only codes of board tasks are kept (lastRunMs too)
      presence[p.machine] = { ...rec, atMs: now() };
      for (const r of cappedRuns(rec.runs, now())) if (r.task) lastRunMs[r.task] = Math.max(lastRunMs[r.task] || 0, now()); // a killed run past the cap never moves it
      return { ok: true, stale_after_ms: PRESENCE_STALE_MS, ...(dropped ? { runs_dropped: dropped } : {}) };
    },
    sweepDelivery,
    /** GET /api/v1/delivery/open: what a connector must still deliver: open tracked owner messages still sent or undelivered,
     *  as pointers only (id, task, lane, state, sent_at), never their text. Connector tokens only. */
    deliveryOpen(secret) {
      connectorOnly(secret);
      const ctx = deliveryCtx(), since = sinceMs(), messages = [];
      for (const f of Object.values(store.state.feedback)) {
        if (f.status !== 'open' || !tracked(f, since)) continue;
        const d = deliveryOf(store.state, f, ctx);
        if (d.state === 'sent' || d.state === 'undelivered') messages.push({ id: f.id, task_id: f.task_id, lane: d.lane, state: d.state, sent_at: d.sent_at });
      }
      return { messages };
    },
    /** GET /api/v1/delivery/me: the connector token itself (id, label, lane). */
    deliveryMe(secret) { return connectorOnly(secret); },
    /**
     * The connector's pointer stream: { id, task_id } of each new tracked owner message, never its text. Live only. Ends with
     * onEnd('revoked') once the token stops being valid. "New owner message" is read off the state, not off a list of ops: every op
     * that adds a feedback record names it fb-<seq> (ops addFeedback / feedback.add), so an owner feedback.add, an ask-button answer,
     * a goal lock and an owner re-brief request are all streamed, and a later op that adds one is too (gate must-fix: goal locks and
     * re-briefs used to wait for a reconnect). tracked() keeps out the board's own records (auto, system) and info notes.
     */
    deliveryWatch(secret, { onMessage, onEnd }) {
      connectorOnly(secret);
      const follow = ev => {
        if (!connTokens.authenticate(secret)) { listeners.delete(follow); return onEnd?.('revoked'); }
        const f = store.state.feedback[`fb-${ev.seq}`];
        // W-42 5A rev 3: a node comment's pointer names its node, so the lane opens the right place
        if (f && tracked(f, sinceMs())) { const a = diagrams.anchorOf(f.id); onMessage({ id: f.id, task_id: f.task_id, ...(a ? { node_id: a.node_id } : {}) }); }
      };
      listeners.add(follow);
      return () => listeners.delete(follow);
    },
    /** Owner-only connector token administration (POST/GET /api/v1/connector-tokens, POST .../revoke). Never journaled. */
    connectorTokenIssue(secret, body) { ownerOnly(secret); return { ok: true, ...connTokens.issue(body || {}) }; },
    connectorTokenList(secret) { ownerOnly(secret); return { tokens: connTokens.list() }; },
    connectorTokenRevoke(secret, body) { ownerOnly(secret); return { ok: true, ...connTokens.revoke(body?.id) }; },
    get state() { return store.state; },
    get replayed() { return store.replayed; },
    authenticate,
    write,
    guardsOn,
    phaseRulesOn,
    foldEra,
    /** `turns` (GET /api/v1/state?v=2) adds the latest turn report of each lane the token may read; `archived` (?archived=1)
     *  adds each task's archived step metadata. Without either the view is the v1 one. */
    view(secret, { turns = false, archived = false, window = '' } = {}) { return joinDiagrams(boardView(store.state, { actor: authenticate(secret), nowMs: now(), stallMs, config, webhookStatus, watcherAt, roleSlots, turns, archived, window, windowDays: stateWindowDays, guards: guardsOn(), phaseRulesSince: phaseRulesOn() ? phaseRulesSince : '', r4PerMessageSince, delivery: deliveryFor(), workOf: deliveryOn() ? workFor : undefined })); },
    /** GET /api/v1/work: which task has a live agent run, on which session and machine (src/work.mjs). Any signed-in token. */
    work(secret) {
      const a = authenticate(secret);
      if (!a) throw new BoardError(401, 'unauthorized');
      return workFor(a);
    },
    /**
     * The archived ask and feedback records of one task that GET /api/v1/state leaves out (src/window.mjs), newest first, one page per call:
     * `limit` 1..500 (default 200) counts asks and feedback together, `before` is the previous page's next_before. Same audience as the state:
     * every role, a reporter only for its scope_tasks. messages are the view's own shape of the feedback records returned.
     */
    history(secret, { task, before = '', limit } = {}) {
      const actor = authenticate(secret);
      if (!actor) throw new BoardError(401, 'unauthorized');
      if (!task) throw new BoardError(400, 'task_required');
      const n = limit == null || limit === '' ? HISTORY_PAGE.default : Number(limit);
      if (!Number.isInteger(n) || n < 1) throw new BoardError(400, 'invalid_limit', { min: 1, max: HISTORY_PAGE.max });
      if (!inScope(actor, task)) throw new BoardError(403, 'forbidden_task', { task });
      const st = store.state;
      if (!st.tasks[task] && !Object.values(st.asks).some(a => a.task_id === task) && !Object.values(st.feedback).some(f => f.task_id === task)) throw new BoardError(404, 'task_not_found', { task });
      const live = liveSets(st, messagesView(st), now(), stateWindowDays > 0 ? stateWindowDays : Infinity);
      const page = historyPage(st, task, live, { before, limit: Math.min(n, HISTORY_PAGE.max) });
      // A scoped reporter reads a news item's related rows only within its scope (the same rule as the state view).
      if (actor.role === 'reporter' && !actor.scope_tasks.includes('*')) {
        const ok = id => inScope(actor, id);
        page.feedback = page.feedback.map(f => scopedRelated(f, ok));
        page.messages = page.messages.map(m => scopedRelated(m, ok));
      }
      return { task, days: stateWindowDays, ...page };
    },
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
      // Delivery signals are not journal events: live only, without an id (they never move a client's resume cursor).
      if (!types.includes('delivery')) return stop;
      const onDelivery = sig => { if (!authenticate(secret)) { stopAll(); return onEnd?.('revoked'); } onSignal(sig); };
      const stopAll = () => { stop(); deliveryListeners.delete(onDelivery); };
      deliveryListeners.add(onDelivery);
      return stopAll;
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
    /** GET /api/v1/media/usage (owner, coordinator): what the board stores against its media budget and the video cap. */
    mediaUsage(secret) {
      const actor = authenticate(secret);
      if (!actor) throw new BoardError(401, 'unauthorized');
      if (!['owner', 'coordinator'].includes(actor.role)) throw new BoardError(403, 'forbidden_for_role', { role: actor.role, allowed: ['owner', 'coordinator'] });
      return { used_bytes: mediaUsedBytes(), budget_bytes: mediaBudgetBytes, max_video_bytes: maxVideoBytes, max_upload_bytes: maxUploadBytes };
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
     * task written to in the last 60 min, none 23:00-07:00 ICT, and (T-31 15-11) never one for a row whose only open item waits
     * on the owner while no worker runs (views.mjs ownerOnlyIdle). Returns how many it filed. server.mjs runs it hourly.
     */
    /** Guard B4 on the timer: re-checks every task (and every open episode); returns how many idle.mark events it wrote. */
    /**
     * J-05 supervisor on the timer: files the nudges, escalations and daily digests src/supervisor.mjs finds, each as one
     * nudge.raise written by the board itself (a key filed once is never filed again). Off: nothing, not even an escalation.
     * Returns how many it filed.
     */
    sweepSupervisor() {
      if (!supervisorOn()) return 0;
      const state = store.state, t = now(), plan = sweepPlan(state, t, svConfig, Date.parse(supervisorSince));
      const bodies = [
        ...plan.clears.map(c => ({ op: 'nudge.clear', target_id: c.head, data: { ids: c.ids, reason: c.reason || 'condition_cleared' }, key: c.key })),
        ...[...plan.raise, ...plan.digests].map(({ task_id, ...data }) => ({ op: 'nudge.raise', target_id: task_id, data, key: data.key })),
      ];
      let n = 0;
      for (const { key, ...b } of bodies) { // one bad candidate is logged and skipped; the rest of the sweep still lands
        const body = { request_id: `nudge-${sha256(key).slice(0, 16)}-${t}`, ...b }; // the key itself carries / and @
        try { commit(BOARD_ACTOR, body, sha256(canonical(body)), seq => OPS[body.op].check({ state, req: body, seq, actor: BOARD_ACTOR })); n++; }
        catch (e) { console.error(`supervisor: ${body.op} ${key} skipped: ${e.code || e.message}`); }
      }
      return n;
    },
    /** GET /api/v1/supervisor: on/off, thresholds, the open nudges (oldest first) and the metrics, derived from the records. */
    supervisorView(secret) {
      const actor = authenticate(secret);
      if (!actor) throw new BoardError(401, 'unauthorized');
      if (actor.role === 'reporter') throw new BoardError(403, 'forbidden_for_role', { role: actor.role, allowed: ['owner', 'coordinator'] });
      const state = store.state;
      const open = openHeads(state) // one line per issue: the head of each open chain, owner level first, then oldest
        .map(f => ({ id: f.id, task_id: f.task_id, rule: f.kind === 'idle' ? 'R4' : f.rule, level: f.kind === 'idle' ? 1 : f.level, lane: f.kind === 'idle' ? state.tasks[f.task_id]?.lane || '' : f.lane,
          text: f.text, at: f.attribution.created_at, since: rootOf(state, f).attribution.created_at, ...(f.escalated_to ? { escalated_to: f.escalated_to } : {}) }));
      return { on: supervisorOn(), since: supervisorSince || null, config: svConfig, open, metrics: supervisorMetrics(state, Date.parse(supervisorSince) || 0) };
    },
    sweepIdle() {
      let n = 0;
      for (const id of new Set([...Object.keys(store.state.tasks), ...Object.keys(store.state.idle || {})])) n += checkIdle(id);
      return n;
    },
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
      if (boardClosed) return; // a signal handler and a test teardown may both close: the second call does nothing
      boardClosed = true;
      for (const w of inboxWaiters.values()) w.close();
      inboxWaiters.clear();
      store.close(); mailbox.close(); diagrams.close(); twofa.close();
    }
  };
}
