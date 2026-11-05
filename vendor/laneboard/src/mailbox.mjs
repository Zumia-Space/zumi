// The lane mailbox (J-05): cross-account messages between lanes, kept OUT of the journal on purpose.
//
// Every board record is an event in events.ndjson, and the reducer refuses an unknown op (src/ops.mjs reduce),
// so a journaled `msg.*` event would make a rollback to an older board fail to start. Messages are therefore a
// separate append-only file, <data>/messages.ndjson, exactly like stats.json is kept outside the journal: the
// journal and the reducer stay untouched, an older board replays this journal and starts, and messages simply
// disappear if the feature is rolled back. The cost is an honest one: messages are not board events, so the
// audit trail is this file (who, when, to whom, body), and only for 30 days.
//
// Release 1 (this file's store half) wires no route: it creates/loads the store, prunes it on start and daily.
import fs from 'node:fs';
import path from 'node:path';

export const MAILBOX = Object.freeze({
  retentionMs: 30 * 24 * 60 * 60 * 1000, // 30 days: bodies older than this are dropped by prune()
  bodyBytes: 8 * 1024,
  links: 5,
  // A link is a pointer, not a payload (review R2 re-check A): one is capped at 2 KB and the five together at 8 KB,
  // so the largest accepted line is ~16 KB of content and one token's worst day (200 messages) stays a few MB
  // against the 64 MB ceiling. Bytes, not characters. Checked before the append, like every other cap.
  linkBytes: 2048,
  linksBytes: 8192,
  perMinute: 30,
  // Hard caps, because a leaked lane token must not be able to grow the file without bound (review R2-2). One
  // sender lane ("from", the stamp the board writes) may append this many messages in a rolling 24 h; the whole
  // file may not pass maxBytes (which is also what the in-memory projection is loaded from). Both are checked
  // BEFORE the write, so a refused message is never half-appended.
  dailyPerLane: 200,
  maxBytes: 64 * 1024 * 1024,
  maxWaitMs: 25000, // under nginx's default proxy_read_timeout (60 s) and Node's requestTimeout (300 s)
  page: 200
});

// A reporter token may never act as one of these: `anh` and `cos` are the human and the coordinator, and `all`
// is the broadcast pseudo-lane. Matched case-insensitively because lane names are (turns.mjs sameLane). A name
// that merely STARTS with one plus a space or a parenthesis is refused too: the owner posts as `anh (<label>)`,
// so a lane called `anh (zumi-app)` would read as the human.
export const RESERVED_LANES = Object.freeze(['anh', 'cos', 'all']);
const RESERVED_SHAPE = new RegExp(`^(?:${RESERVED_LANES.join('|')})(?:[\\s(].*)?$`, 'i');
export const isReservedLane = name => RESERVED_SHAPE.test(String(name ?? '').trim());

// ---- addressing and the inbox rule (release 2) ----
const laneLower = name => String(name ?? '').trim().toLowerCase();

/** Every lane a message may be addressed to: task lanes, active token lanes, lanes that reported, and cos. */
export function messageLanes(state) {
  const seen = new Set(), out = [];
  for (const lane of [
    ...Object.values(state.tasks || {}).map(t => t.lane),
    ...Object.values(state.tokens || {}).filter(t => !t.revoked_at).map(t => t.lane),
    ...Object.keys(state.turn_history || {}),
    'cos'
  ]) {
    if (!lane || seen.has(laneLower(lane))) continue;
    seen.add(laneLower(lane));
    out.push(lane);
  }
  return out;
}
/** The board's spelling of a send target, 'all' for the broadcast pseudo-lane, or null when it is not a lane. */
export function resolveMessageTarget(state, name) {
  const want = laneLower(name);
  if (!want) return null;
  if (want === 'all') return 'all';
  return messageLanes(state).find(l => laneLower(l) === want) ?? null;
}
/** The board's spelling of a lane named in a read; an unknown lane stays as typed (the owner may read nothing there). */
export function mailboxLane(state, name) {
  return resolveMessageTarget(state, name) ?? String(name ?? '').trim();
}

/**
 * Who a message is from, stamped by the server and never by the body. The owner speaks as "anh (<token label>)"
 * so a post from the app is distinguishable from the owner's own token; the coordinator speaks as its lane
 * (cos on the live board); a lane reporter speaks as its lane.
 */
export function messageSender(actor) {
  if (!actor) return '';
  if (actor.role === 'owner') return `anh (${actor.label || actor.name || 'owner'})`;
  if (actor.role === 'coordinator') return actor.lane || 'cos';
  return actor.lane || '';
}

/**
 * The mailbox is its own permission surface, independent of mayUseLane (turns.mjs): an owner or coordinator
 * reads and writes any lane; a reporter only its own lane, the broadcast lane and what it sent itself. A caller
 * that fails this is refused 403, never 404, so the answer never reveals which lanes exist.
 */
export function mayUseInbox(actor, lane) {
  if (!actor || !String(lane ?? '').trim()) return false;
  if (actor.role === 'owner' || actor.role === 'coordinator') return true;
  if (actor.role !== 'reporter' || !actor.lane) return false;
  return laneLower(lane) === 'all' || laneLower(actor.lane) === laneLower(lane);
}

// Obvious credential shapes, checked on the body and on every link. The list is deliberately the shape of
// keys, not prose: a message must not become a covert channel for a secret. The refusal names the field and
// never echoes the match.
export const SECRET_SHAPES = Object.freeze([
  ['laneboard_token', /\blb_[A-Za-z0-9_-]{20,}\b/],
  ['webhook_secret', /\bwhsec_[A-Za-z0-9+/=_-]{16,}\b/],
  ['openai_key', /\bsk-(?:proj-|ant-|live-|test-)?[A-Za-z0-9_-]{16,}\b/],
  ['github_token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/],
  ['gitlab_token', /\bglpat-[A-Za-z0-9_-]{20,}\b/],
  ['slack_token', /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/],
  ['aws_access_key', /\bAKIA[0-9A-Z]{16}\b/],
  ['google_api_key', /\bAIza[0-9A-Za-z_-]{30,}\b/],
  ['stripe_key', /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/],
  ['npm_token', /\bnpm_[A-Za-z0-9]{30,}\b/],
  ['digitalocean_token', /\bdop_v1_[a-f0-9]{64}\b/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/],
  ['private_key', /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/],
  ['bearer_header', /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/],
  ['assigned_secret', /\b(?:api[_-]?key|secret|token|passwd|password)\s*[:=]\s*["']?[A-Za-z0-9_\-]{16,}/i]
]);
/** Names of the credential shapes found in `text` (empty = clean). Never returns the match itself. */
export function findSecretShapes(text) {
  const s = String(text ?? '');
  return SECRET_SHAPES.filter(([, re]) => re.test(s)).map(([name]) => name);
}

const isMessage = m => m && Number.isInteger(m.seq) && typeof m.id === 'string' && typeof m.at === 'string'
  && typeof m.from === 'string' && typeof m.to === 'string' && typeof m.body === 'string';

const DAY_MS = 24 * 60 * 60 * 1000;
const senderKey = name => String(name ?? '').trim().toLowerCase();
/** A refusal from the store with a code the board maps to a status: lane_daily_limit -> 429, store_full -> 507. */
const refuse = (code, extra) => Object.assign(new Error(code), { code }, extra);

/**
 * Open <dir>/messages.ndjson. Records are { seq, id: 'msg-N', at, from, to, body, reply_to?, links? }.
 * `now` is injectable for tests. `daily` schedules the 30-day prune (unref'd, so it never holds a process open);
 * board.close() stops it. A torn final line is truncated like the journal; a corrupt middle line is skipped with
 * a warning, because a message file must never stop the board from starting (unlike the journal).
 */
export function openMessageStore(dir, { now = Date.now, retentionMs = MAILBOX.retentionMs, daily = true,
  dailyPerLane = MAILBOX.dailyPerLane, maxBytes = MAILBOX.maxBytes } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'messages.ndjson');
  let messages = [];
  let lastSeq = 0;
  let fd = null;
  let appending = false;
  let bytes = 0; // on-disk size of `file`, kept in step with every append and rewrite
  let oversize = false; // the file was over maxBytes at startup: it was not loaded and is never appended to
  let laneSends = new Map(); // sender (lower-cased `from`) -> append timestamps inside the rolling 24 h window

  // The daily count is seeded from the records themselves, so a restart neither forgets nor doubles it.
  const seedLaneSends = () => {
    laneSends = new Map();
    const cut = now() - DAY_MS;
    for (const m of messages) {
      const t = Date.parse(m.at);
      if (!(t >= cut)) continue;
      const key = senderKey(m.from);
      const list = laneSends.get(key) ?? [];
      list.push(t);
      laneSends.set(key, list);
    }
  };

  const read = () => {
    let size = 0;
    try { size = fs.statSync(file).size; } catch (e) { if (e.code !== 'ENOENT') throw e; }
    bytes = size;
    // A file over the ceiling is NOT parsed: loading it is the read that OOMs and then crash-loops the board. It is
    // left exactly as it is on disk (nothing is lost), the store serves nothing, and append() refuses 507 until an
    // operator rotates it. A board that serves its tasks beats a board that will not start.
    if (size > maxBytes) {
      oversize = true;
      console.error(`messages.ndjson is ${size} bytes, over the ${maxBytes}-byte cap: not loading it; lane sends are refused (store_full) until the file is rotated`);
      return;
    }
    let raw = '';
    try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (raw && !raw.endsWith('\n')) {
      const keep = raw.lastIndexOf('\n') + 1;
      fs.truncateSync(file, Buffer.byteLength(raw.slice(0, keep)));
      raw = raw.slice(0, keep);
      bytes = Buffer.byteLength(raw);
    }
    for (const [i, line] of raw.split('\n').entries()) {
      if (!line) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { console.warn(`messages.ndjson line ${i + 1} is not JSON, skipping`); continue; }
      if (rec && rec.meta) { lastSeq = Math.max(lastSeq, Number(rec.last_seq) || 0); continue; }
      if (!isMessage(rec)) { console.warn(`messages.ndjson line ${i + 1} is not a message, skipping`); continue; }
      messages.push(rec);
      lastSeq = Math.max(lastSeq, rec.seq);
    }
    messages.sort((a, b) => a.seq - b.seq);
    seedLaneSends();
  };

  // Rewrites the file atomically (temp + rename). The first line is the sequence high-water mark, so pruning
  // every body still never reuses a msg-N id (a waiter's cursor stays meaningful).
  const rewrite = () => {
    if (fd !== null) { fs.closeSync(fd); fd = null; }
    const tmp = file + '.tmp';
    const lines = [JSON.stringify({ meta: 1, last_seq: lastSeq }), ...messages.map(m => JSON.stringify(m))];
    fs.writeFileSync(tmp, lines.join('\n') + '\n');
    fs.renameSync(tmp, file);
    bytes = fs.statSync(file).size;
    seedLaneSends();
    if (appending) fd = fs.openSync(file, 'a');
  };

  const prune = () => {
    if (oversize) return 0; // never rewrite a file that was not loaded: that would throw its contents away
    const cut = now() - retentionMs;
    const kept = messages.filter(m => Date.parse(m.at) >= cut);
    const removed = messages.length - kept.length;
    if (!removed) return 0;
    messages = kept;
    rewrite();
    return removed;
  };

  read();
  prune(); // startup: never serve a body older than the retention window
  fd = fs.openSync(file, 'a');
  appending = true;

  const listeners = new Set();
  const timer = daily ? setInterval(() => {
    try { prune(); } catch (e) { console.error('message prune failed', e); }
  }, 24 * 60 * 60 * 1000) : null;
  timer?.unref();

  return {
    file,
    get messages() { return messages; },
    get lastSeq() { return lastSeq; },
    get bytes() { return bytes; },
    get oversize() { return oversize; },
    /** Appends one message (fsynced) and wakes the long-poll listeners. `from` is stamped by the board.
     *  Throws code `lane_daily_limit` or `store_full` BEFORE writing, so a refusal leaves the file untouched. */
    append({ from, to, body = '', links = [], reply_to }) {
      if (fd === null) throw new Error('message store is closed');
      if (oversize) throw refuse('store_full', { maxBytes });
      const t = now();
      const key = senderKey(from);
      const recent = (laneSends.get(key) ?? []).filter(x => t - x < DAY_MS);
      laneSends.set(key, recent);
      if (recent.length >= dailyPerLane) throw refuse('lane_daily_limit', { limit: dailyPerLane, retryAfterMs: recent[0] + DAY_MS - t });
      const seq = lastSeq + 1;
      const rec = {
        seq, id: `msg-${seq}`, at: new Date(t).toISOString(), from, to,
        ...(reply_to ? { reply_to } : {}), body, ...(links && links.length ? { links } : {})
      };
      const line = JSON.stringify(rec) + '\n';
      const size = Buffer.byteLength(line);
      if (bytes + size > maxBytes) throw refuse('store_full', { maxBytes });
      fs.writeSync(fd, line);
      fs.fsyncSync(fd);
      bytes += size;
      lastSeq = seq;
      messages.push(rec);
      recent.push(t);
      for (const l of [...listeners]) { try { l(rec); } catch (e) { console.error('message listener failed', e); } }
      return rec;
    },
    /** Messages in one lane's inbox: addressed to it, broadcast to all, or sent by it. `after` is a msg seq.
     *  Lane names are case-insensitive, like mayUseInbox, so a token lane spelled `Pi` still sees its own. */
    list(lane, after = 0) {
      const key = laneLower(lane);
      return messages.filter(m => m.seq > after && (laneLower(m.to) === key || laneLower(m.to) === 'all' || laneLower(m.from) === key));
    },
    get(id) { return messages.find(m => m.id === id); },
    prune,
    /** In-process listener for new messages; returns an unsubscribe function. */
    onMessage(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    close() {
      if (timer) clearInterval(timer);
      if (fd !== null) { fs.closeSync(fd); fd = null; }
      appending = false;
    }
  };
}
