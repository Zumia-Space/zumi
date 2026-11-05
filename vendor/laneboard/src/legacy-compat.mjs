// Compatibility layer for the predecessor board's JSON API (the J-05 board, port 3096), so the clients written
// against it keep working unchanged after a cutover: the CoS CLI (state/open/reply/ask/clear/push/watch/route/
// goals/plans), the Fable watcher (open feedback, pings) and the T-31 coordinator (GET /api/state + POST /api/admin/reply).
//
//   GET  /api/state               the predecessor's state shape, built from the board on every read
//   GET  /api/state?v=2           the same, for lane-aware clients (s21): every task also has asks[] {id, lane, text, step_id,
//                                 refs, at}, steps[].lane, refs {now, next}; now / next / ask text come without their refs line;
//                                 feedback[].answersAsks lists the ask ids an owner message answered. There is no joined
//                                 needsAnh in v2: nothing a client could push back as if it were one ask.
//   GET  /api/times              its timing history shape (times.json)
//   GET  /api/media               its media-folder listing [{name, size, mtime, type}]
//   GET  /media/<name>            a file of the predecessor's media folder (read-only), byte ranges honoured;
//   GET  /media/_w|_t/<name>.webp its size-reduced copies: answered with a redirect to the original, as the
//                                 predecessor did whenever a copy could not be made
//   POST /api/admin/reply         {task, step, text, kind:'ask'|'note'|'receipt', replyTo, close}  -> feedback.add / ask.raise
//                                 ('receipt' = the coordinator's "Nhận" on owner message replyTo: Đổi:/Lịch:/Bước tiếp: lines)
//   POST /api/admin/asks          {code, text, by, lane?, step?} -> one open ask per (task, lane, step) (s21); without lane and
//                                 step the task's one ask is replaced, like asks.json did (428 lane_required on a shared task) + a ping
//   POST /api/admin/asks/clear    {id} | {code, lane, step} -> clears exactly that ask; anything less is 400 scope_required
//   POST /api/admin/asks/clear-all {code, confirm:"ALL"}    -> clears every open ask of the task (the only "all")
//   POST /api/admin/pings/seen    marks every ping seen (ping.seen)
//   POST /api/admin/plans         {task, reviewer, body, verdict, at} -> plan.add
//   PUT  /api/admin/tasks         {tasks:[rows], summary, lane?, replaceLane?}  -> the board's own writes (see pushRows); never deletes
//                                 a task. `lane` = the pusher's lane: it writes only its own steps and ask (s21); 428 without it on a shared task
//                                 With BOARD_AUTO_COMPACT=1 (default off, see server.mjs) a row that leaves its task at AUTO_COMPACT_AT
//                                 live steps (ops.mjs) compacts its older done steps right after the push, as the compat
//                                 coordinator with origin `auto-compact lane=<lane>`, and the reply lists `compacted`. OFF = no change.
//   POST /api/admin/close         {code}             -> closes that task (the only way a coordinator removes one)
//   PUT  /api/admin/registry      {registry:[rows]}  -> registry.set; status the owner set is kept
//   PUT  /api/admin/stats         {doc} | {generated_at,attributed_pct,tasks,top} -> the board's task-statistics document (shape validated, ≤512 KiB) written to <data>/stats.json, never the journal
//   POST /api/admin/turn          {lane, turn_id, detail} -> turn.report (a lane finished a turn); {ok, seq, quick}, or 409 duplicate_turn with the original seq and quick
//
// The predecessor's page-only POST routes (/api/feedback, /api/ping, /api/goal, /api/rebrief, /api/routing,
// /api/registry/status, /api/feedback/:id/done) are NOT answered: the owner's page is Laneboard's own UI, which
// writes the same records through POST /api/v1/write as an authenticated owner.
//
// Trust model = the predecessor's, on purpose: GET routes answer whoever reaches the server (the reverse proxy's
// basic auth is the gate); /api/admin/* answers only a loopback peer that sent NO X-Forwarded-For (a proxy always
// adds one), else 404. Every write goes through board.write with one coordinator token read from a file, so the
// board's roles, schemas, revisions and honesty rules hold exactly as for any other client.
// Off unless server.mjs is given a token file (BOARD_LEGACY_COMPAT_TOKEN_FILE).
//
// Ids: records imported by scripts/migrate-from-legacy.mjs keep their predecessor ids on this API (feedback and
// asks from <data>/migration-report.json, plans and pings from their own legacy_id), so stored references (replyTo,
// a client's handled-id list) stay valid; new records use board ids. Times: an imported record shows its original
// time (its `origin`), not the import's. Pings are board records (ping.send, and the pings routing changes, owner
// registry status changes, goal locks and re-brief requests write themselves); their notes are rendered here in the
// predecessor's words.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BoardError, REQUESTS_THREAD, BOARD_TARGET, resolveLane, askLane, openAskAt, HISTORY_STEP, compactPlan, COMPACT_DEFAULT_KEEP, STEP_CAP, AUTO_COMPACT_AT } from './ops.mjs';
import { validateTasks } from './rules.mjs';
import { normalizeGate } from './gates.mjs';
import { normalizeRefs, splitRefs } from './refs.mjs';
import '../public/measure.js'; // globalThis.LaneMeasure: rowWaitSince, the one age rule shared with the page
import { validateArchitecture } from './architecture.mjs';
import { legacyRowToRequests, legacyRegistryEntry, uniqueStepIds, badAskStep, rowAsks, hasAskMap } from './adapt-legacy.mjs';

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', mp3: 'audio/mpeg', mp4: 'video/mp4' };
const MEDIA_REF = /media\/([\w.-]+\.(?:png|jpe?g|webp|gif|mp3|mp4))/gi;
const STEP_FIELDS = ['label', 'sub', 'zone', 'state', 'detail', 'recommend', 'options'];
// The task's lane is not a pushable field: it belongs to the server's record and never changes (s21, 409 lane_immutable).
const TASK_FIELDS = ['title', 'health', 'goal', 'now', 'next', 'context', 'order', 'dossier', 'draft_output', 'draft_outcome'];
const REF_FIELDS = ['now', 'next', 'needsAnh'];
const PUSH_ORIGIN = 'compat push needsAnh';
const MAX_BODY = 2 * 1024 * 1024;
// The predecessor's display names for worker models (its WORKER_MODELS), used in routing ping notes.
const WORKER_MODELS = { sonnet: 'Sonnet 5.5', opus: 'Opus 5.5', fable: 'Fable 5.1', deepseek: 'DeepSeek V4.1 Flash · OpenCode', luna: 'GPT-5.6 Luna · OpenCode' };
const RB_LABEL = { qc: 'Chỉ QC: tiếp tục hay đổi hướng', strategy: 'QC + chiến lược mới nếu cần' };
const readJson = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
// Rows drop empty fields ('' and [] are the predecessor's "absent"), so a field compares equal to its absence.
const blank = v => v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);
const eq = (a, b) => (blank(a) && blank(b)) || same(a, b);
const stepShort = key => key.slice(key.indexOf('/') + 1);

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0, tooLarge = false; const chunks = [];
    req.on('data', c => { size += c.length; if (size > MAX_BODY) tooLarge = true; else chunks.push(c); });
    req.on('end', () => { if (tooLarge) return reject(new BoardError(413, 'too_large')); try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new BoardError(400, 'bad_json')); } });
    req.on('error', reject);
  });
}

/** Pixel size from the file header (PNG / JPEG / GIF / WebP), as the predecessor read it. null when unknown. */
export function imageSize(f) {
  let fd;
  try {
    fd = fs.openSync(f, 'r');
    const b = Buffer.alloc(256 * 1024);
    const n = fs.readSync(fd, b, 0, b.length, 0);
    if (b.readUInt32BE(0) === 0x89504e47) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
    if (b.toString('ascii', 0, 3) === 'GIF') return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
    if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
      const kind = b.toString('ascii', 12, 16);
      if (kind === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
      if (kind === 'VP8L') { const x = b.readUInt32LE(21); return { w: (x & 0x3fff) + 1, h: ((x >> 14) & 0x3fff) + 1 }; }
      if (kind === 'VP8X') return { w: b.readUIntLE(24, 3) + 1, h: b.readUIntLE(27, 3) + 1 };
    }
    if (b[0] === 0xff && b[1] === 0xd8) {
      let i = 2;
      while (i + 9 < n) {
        if (b[i] !== 0xff) { i++; continue; }
        const m = b[i + 1];
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
        if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7) || m === 0xff) { i += m === 0xff ? 1 : 2; continue; }
        i += 2 + b.readUInt16BE(i + 2);
      }
    }
  } catch { /* unreadable -> unknown size */ } finally { if (fd !== undefined) fs.closeSync(fd); }
  return null;
}

/** One file with byte ranges (iOS Safari plays <video> only with 206) and a long cache (URLs carry ?v=mtime). */
function sendFile(req, res, file, type) {
  const size = fs.statSync(file).size;
  const head = { 'Content-Type': type, 'Cache-Control': 'public, max-age=31536000, immutable', 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff' };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range && (range[1] || range[2])) {
    const start = range[1] === '' ? Math.max(0, size - Number(range[2])) : Number(range[1]);
    const end = range[1] !== '' && range[2] !== '' ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
    res.writeHead(206, { ...head, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...head, 'Content-Length': size });
  return fs.createReadStream(file).pipe(res);
}

/** The predecessor's media folder, read only: GET /api/media (list), /media/<file> (byte ranges) and the
 *  /media/_w|_t/<file>.webp derivatives (a redirect to the original). Used by the compat layer, and alone by a board
 *  that has no coordinator token (a read-only preview). handle() returns false for anything else. */
export function createLegacyMedia(mediaDir) {
  const mediaFiles = () => { try { return fs.readdirSync(mediaDir).filter(n => /\.(png|jpe?g|webp|gif|mp3|mp4)$/i.test(n)); } catch { return []; } };
  async function handle(req, res, p, send) {
    if (req.method !== 'GET' || !mediaDir) return false;
    if (p === '/api/media') {
      send(res, 200, mediaFiles().map(n => { const st = fs.statSync(path.join(mediaDir, n)); return { name: n, size: st.size, mtime: st.mtimeMs, type: /\.mp4$/i.test(n) ? 'video' : /\.mp3$/i.test(n) ? 'audio' : 'image' }; }));
      return true;
    }
    const deriv = /^\/media\/(?:_w|_t)\/([\w.-]+\.(?:png|jpe?g|webp))\.webp$/i.exec(p);
    if (deriv) {
      if (!fs.existsSync(path.join(mediaDir, deriv[1]))) { send(res, 404, { error: 'not_found' }); return true; }
      res.writeHead(302, { Location: '../' + deriv[1] + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''), 'Cache-Control': 'no-store' });
      res.end(); return true;
    }
    const media = /^\/media\/([\w.-]+\.(png|jpe?g|webp|gif|mp3|mp4))$/i.exec(p);
    if (media) {
      const file = path.join(mediaDir, media[1]);
      if (!fs.existsSync(file)) { send(res, 404, { error: 'not_found' }); return true; }
      sendFile(req, res, file, MIME[media[2].toLowerCase()]);
      return true;
    }
    return false;
  }
  return { handle, mediaFiles };
}

export function createLegacyCompat(board, { tokenFile, dataDir, mediaDir, autoCompact = false }) {
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  const actor = board.authenticate(token);
  if (!actor || actor.role !== 'coordinator') throw new Error('legacy compat: the token file must hold a valid coordinator token');
  const report = readJson(path.join(dataDir, 'migration-report.json')) || { ids: {}, seq: 0 };
  const toLegacy = new Map(), toBoard = new Map();
  for (const kind of ['feedback', 'asks']) for (const [old, id] of Object.entries(report.ids?.[kind] || {})) { toLegacy.set(id, old); toBoard.set(old, id); }
  // Records made after the import get an id in the predecessor's shape too (36 chars of [0-9a-f-], what its clients
  // match on: wait-feedback.sh takes ^[0-9a-f-]{36}), derived from the board id and reversible: fb-419 ->
  // f0000000-0000-4000-8000-000000000419. A v4 UUID from the import cannot collide (its 13th hex digit is 4, ours 0).
  const PREFIX = { fb: 'f0000000-0000-4000-8000-', ask: 'a0000000-0000-4000-8000-' };
  const legacyId = id => { if (toLegacy.has(id)) return toLegacy.get(id); const m = /^(fb|ask)-(\d{1,12})$/.exec(id); return m ? PREFIX[m[1]] + m[2].padStart(12, '0') : id; };
  const boardId = id => { if (toBoard.has(id)) return toBoard.get(id); const m = /^([fa])0000000-0000-4000-8000-(\d{12})$/.exec(id); return m ? `${m[1] === 'f' ? 'fb' : 'ask'}-${Number(m[2])}` : id; };

  const state = () => board.state;
  const w = (op, target_id, data, extra = {}) => board.write(token, { version: 1, request_id: `compat-${op}-${crypto.randomUUID()}`, op, target_id, data, ...extra });
  /** Who asked, as the predecessor named it: a lane ask's lane, an imported record's original author, else the token. */
  const originAt = rec => (/^legacy \S+ (\S+)$/.exec(rec.attribution?.created_by?.origin || '') || [])[1];
  // askedBy existed only for a lane's ask (asks.json); an ask a row's needsAnh raised had none ('cos' on import).
  const laneOf = a => { const by = (/^(?:lane-ask|legacy) (\S+)/.exec(a.attribution.created_by.origin || '') || [])[1]; return by && by !== 'cos' ? by : ''; };
  // Oldest first; equal times by id, so every projection of "the asks" is the same on every read.
  const byAskTime = (a, b) => a.attribution.created_at.localeCompare(b.attribution.created_at) || a.id.localeCompare(b.id, 'en', { numeric: true });
  const openAsks = taskId => Object.values(state().asks).filter(a => a.task_id === taskId && a.status === 'open').sort(byAskTime);
  const clearAsk = (a, note) => w('ask.clear', a.id, note ? { note } : {}, { expected_revision: a.rev });

  // ---------- lanes (s21) ----------
  const taskLane = code => state().tasks[code]?.lane || '';
  /** The lane a step belongs to: its own, else its task's. */
  const stepLane = (code, id) => state().steps[`${code}/${id}`]?.lane || taskLane(code);
  /** A task is shared when more than one lane has a step or an open ask on it, or more than one ask is open: a push or an ask
   *  that does not say which lane it speaks for cannot be told apart from another lane's, so it is refused (428). A row push asks
   *  `lanesOnly`: several asks of ONE lane are that lane's (they are on different steps), and a push only touches the ask on its own step. */
  function isShared(code, { lanesOnly = false } = {}) {
    const t = state().tasks[code]; if (!t) return false;
    const asks = openAsks(code);
    const lanes = new Set([...t.step_ids.map(id => stepLane(code, id)), ...asks.map(a => askLane(state(), a))]);
    return lanes.size > 1 || (!lanesOnly && asks.length > 1);
  }
  const laneRequired = codes => new BoardError(428, 'lane_required', { tasks: codes });
  /** The lane named in a request, as the board spells it ('' when none was named); an unknown name is 400 unknown_lane. */
  const namedLane = v => (v === undefined || v === null || String(v).trim() === '' ? '' : resolveLane(state(), v));
  /**
   * Raises an ask at (task, lane, step) and clears the open ask that held that identity: one open ask per identity, checked and
   * raised in this one synchronous call. The lane is stored only when it is not the task's own.
   */
  function upsertAsk(code, lane, stepId, text, { origin, options } = {}) {
    const replaced = [], held = openAskAt(state(), code, lane, stepId);
    if (held) { clearAsk(held, 'replaced by a newer ask'); replaced.push(held.id); }
    const r = w('ask.raise', code, { text, ...(stepId ? { step_id: stepId } : {}), ...(options?.length ? { options } : {}), ...(lane && lane !== taskLane(code) ? { lane } : {}) }, origin ? { origin } : {});
    return { id: r.id, replaced };
  }

  // ---------- reads ----------
  const goalVersion = (code, v) => { const g = state().goals?.[code]; return g && (g.version === v ? g : (g.history || []).find(h => h.version === v)); };
  // Message kinds the predecessor never had travel as its 'note' (its readers know no other), with the kind kept in an
  // extra `msgKind` field and, for the owner's two, a word in front of the text so a reader of the text alone knows.
  const NEW_KIND_PREFIX = { redirect: 'Đổi hướng: ', askback: 'Hỏi lại: ' };
  const LEGACY_NOTE_KINDS = new Set(['reply', 'report', 'redirect', 'askback', 'receipt']);
  /** A board feedback record in the predecessor's words. */
  function legacyText(f) {
    if (f.kind === 'goal-lock') { const g = goalVersion(f.task_id, f.goal_version); return g ? `Anh chốt mục tiêu v${f.goal_version}\nMục tiêu: ${g.goal}\nOutput mong muốn: ${g.output}\nOutcome mong muốn: ${g.outcome}` : f.text; }
    if (f.kind === 'rebrief' && f.mode === 'status') return `${f.auto ? 'Bảng tự yêu cầu' : 'Anh yêu cầu'} cập nhật trạng thái${f.note ? '\n' + f.note : ''}`;
    if (f.kind === 'rebrief') return `Anh yêu cầu rà lại (${RB_LABEL[f.mode] || RB_LABEL.strategy})${f.note ? '\n' + f.note : ''}`;
    if (f.ask_id && f.kind === 'choice' && f.choice) return 'Chọn ' + f.text;
    if (f.ask_id && (f.kind === 'approve' || f.kind === 'reject')) return f.text.replace(/^(approve|reject): /, m => (m.startsWith('approve') ? 'Duyệt: ' : 'Chưa đạt: '));
    if (NEW_KIND_PREFIX[f.kind]) return NEW_KIND_PREFIX[f.kind] + f.text;
    return f.text;
  }
  function pingNote(p) {
    const d = p.detail || {}, code = p.task_id || '';
    if (p.kind === 'routing' && d.role) return d.reset ? `anh trả slot ${d.role} của ${code} về mặc định` : `anh đổi slot ${d.role} của ${code}: ${WORKER_MODELS[d.model] || d.model} · ${d.effort}`;
    if (p.kind === 'routing') return d.reset ? `anh trả thợ ${code} về CoS chọn: ${WORKER_MODELS[d.model] || d.model || '?'} · ${d.effort || '?'}` : `anh đổi thợ ${code}: ${WORKER_MODELS[d.model] || d.model} · ${d.effort}`;
    if (p.kind === 'status') return `${code || d.title}: trạng thái -> ${d.status}`;
    if (p.kind === 'goal-lock' && d.version) return `${code}: anh chốt mục tiêu v${d.version}`;
    if (p.kind === 'rebrief' && d.mode === 'status') return `${code}: ${d.auto ? 'bảng tự yêu cầu' : 'anh yêu cầu'} cập nhật trạng thái`;
    if (p.kind === 'rebrief' && d.mode) return `${code}: anh yêu cầu rà lại (${d.mode})`;
    return p.note || '';
  }
  const LEGACY_BY = { owner: 'anh', coordinator: 'cos', auto: 'auto' };
  const LEGACY_PING_KINDS = new Set(['routing', 'ask', 'goal-lock', 'rebrief']);
  const legacyPing = p => ({ id: p.legacy_id || p.id, note: pingNote(p), task: p.task_id || '', open: p.open, at: p.at, seenAt: p.seen_at || '', ...(LEGACY_PING_KINDS.has(p.kind) ? { kind: p.kind } : {}) });

  function legacyTimes(st) {
    const tasks = {};
    const iso = v => v ?? null;
    for (const [code, tt] of Object.entries(st.task_times || {})) tasks[code] = { firstSeenAt: tt.first_seen_at, startedAt: iso(tt.started_at), doneAt: iso(tt.done_at), steps: {} };
    for (const [key, r] of Object.entries(st.times)) {
      const i = key.indexOf('/'), code = key.slice(0, i);
      (tasks[code] ??= { firstSeenAt: r.first_seen_at, startedAt: null, doneAt: null, steps: {} }).steps[key.slice(i + 1)] = {
        firstSeenAt: r.first_seen_at, startedAt: iso(r.started_at), doneAt: iso(r.done_at), waitingSince: iso(r.waiting_since), waitingTotalMs: r.waiting_total_ms,
        lastState: r.last_state, untracked: !!r.untracked, transitions: r.transitions.map(x => ({ t: x.at, from: x.from, to: x.to }))
      };
    }
    return { tasks };
  }

  const legacyMedia = createLegacyMedia(mediaDir), mediaFiles = legacyMedia.mediaFiles;
  const sizeMemo = new Map();
  /** {name: {v, w, h}}: v = the original's mtime (base 36), w/h for images; the predecessor's mediaInfo. */
  function mediaInfo() {
    const out = {};
    if (!mediaDir) return out;
    for (const n of mediaFiles()) {
      const st = fs.statSync(path.join(mediaDir, n)), v = Math.floor(st.mtimeMs).toString(36);
      let size = null;
      if (/\.(png|jpe?g|webp|gif)$/i.test(n)) { const key = n + '@' + v; if (!sizeMemo.has(key)) sizeMemo.set(key, imageSize(path.join(mediaDir, n))); size = sizeMemo.get(key); }
      out[n] = size ? { v, w: size.w, h: size.h } : { v };
    }
    return out;
  }

  /** The asks an owner message answered, as ids (answersAsks) and with their lane and step (answers): a note scoped to asks or sent
   *  on a step journals answers_asks; the page's answer button (ask.answer) links the feedback it writes through ask_id. */
  const answered = f => {
    const ids = f.answers_asks?.length ? f.answers_asks : f.ask_id && f.kind !== 'askback' ? [f.ask_id] : [];
    return { answersAsks: ids, answers: ids.map(id => { const a = state().asks[id]; return { id, lane: a ? askLane(state(), a) : '', step_id: a?.step_id || '' }; }) };
  };
  /** `withStatus` (?v=2&status=1, opt-in so every pinned wire stays byte-identical) adds each row's task status: the `sweep` CLI skips paused and closed rows. */
  function legacyState(req, v2 = false, archived = false, withStatus = false) {
    if (isLoopbackDirect(req)) board.noteWatcher();
    const view = board.view(token, { archived }), st = state(), staleBy = new Map(view.stale_text.map(s => [s.task_id, s.reason]));
    // The row's askAt is the board's one age rule (public/measure.js rowWaitSince): the oldest of the task's open asks (askSince,
    // same-step re-asks chained) and its waiting owner steps with no ask on them, worked out on each read and never stored. The rail,
    // Home and the reminder hook (which reads this field) therefore show the same number. The ask's own time is only the fallback
    // for a task the attention list does not hold (paused, closed).
    const rowAge = (taskId, fallback) => globalThis.LaneMeasure.rowWaitSince(view.attention.waiting.filter(w => w.task_id === taskId)) || fallback;
    // The CoS allowance for a row (op roles.override), with `expired` derived on this read: the record stays stored.
    const routeOverrideOf = code => { const o = st.route_override?.[code]; return o ? { ...o, expired: !(Date.parse(o.expires) > Date.parse(view.now)) } : null; };
    const tasks = view.tasks.map(t => {
      const asks = openAsks(t.id), ask = asks.at(-1);
      const steps = t.steps.map(s => {
        const sid = stepShort(s.id), stepAsk = asks.filter(a => a.step_id === sid).at(-1);
        const options = s.options?.length ? s.options : stepAsk?.options;
        return { id: sid, label: s.label, sub: s.sub ?? '', state: s.state, zone: s.zone === 'owner' ? 'anh' : s.zone, ...(s.detail !== undefined ? { detail: s.detail } : {}),
          ...(s.recommend !== undefined ? { recommend: s.recommend } : {}), ...(options?.length ? { options } : {}) };
      });
      const cur = t.current_step;
      // v2 (s21): the text and its refs line come apart (per field), every open ask is listed with its id and lane, and there is
      // no joined needsAnh. The unversioned reply below is unchanged except that needsAnh joins the open asks (see the header).
      const refsOf = Object.fromEntries(['now', 'next'].map(f => [f, splitRefs(t[f] ?? '')]));
      const v2Fields = v2 ? {
        now: refsOf.now.text, next: refsOf.next.text, refs: { now: refsOf.now.refs, next: refsOf.next.refs },
        asks: asks.map(a => { const r = splitRefs(a.text); return { id: a.id, lane: askLane(state(), a), text: r.text, step_id: a.step_id || '', refs: r.refs, at: a.attribution.created_at }; }),
        steps: steps.map(s => ({ ...s, lane: stepLane(t.id, s.id) })),
        routeOverride: routeOverrideOf(t.id)
      } : {};
      return {
        code: t.id, title: t.title, lane: t.lane, health: t.status === 'paused' ? 'grey' : t.health, goal: t.goal ?? '', now: t.now ?? '', next: t.next ?? '',
        ...(v2 ? {} : { needsAnh: asks.map(a => a.text).join('\n\n') }), askAt: ask ? rowAge(t.id, globalThis.LaneMeasure.askOwnAt(ask)) : '', ...(!v2 && ask && laneOf(ask) ? { askedBy: laneOf(ask) } : {}),
        dossier: t.dossier ?? '', ...(t.draft_output ? { draftOutput: t.draft_output } : {}), ...(t.draft_outcome ? { draftOutcome: t.draft_outcome } : {}),
        steps, worker: t.worker ? { model: t.worker.model, effort: t.worker.effort, reason: t.worker.reason || '', by: LEGACY_BY[t.worker.by] || 'cos', ...(t.worker.at ? { at: t.worker.at } : {}) } : null,
        ...(t.roles ? { roles: Object.fromEntries(Object.entries(t.roles).map(([r, s]) => [r, { ...s, by: LEGACY_BY[s.by] || 'cos' }])), gateFails: t.gate_fails } : {}),
        workerCos: t.worker_default ? { ...t.worker_default, by: 'cos' } : null, loops: t.loops || [], context: t.context ?? '', ...(t.architecture ? { architecture: t.architecture } : {}), order: t.order,
        updated: t.last_activity_at, textAt: t.text_at ?? t.attribution.updated_at, ...(staleBy.has(t.id) ? { staleText: staleBy.get(t.id) } : {}), currentStep: cur ? { id: stepShort(cur.id), label: cur.label, state: cur.state } : null,
        ...(archived ? { archived_steps: t.archived_steps || [] } : {}), // ?archived=1 only: the default row is unchanged
        ...(v2 && withStatus ? { status: t.status } : {}),
        ...v2Fields
      };
    });
    const feedback = Object.values(st.feedback).sort((a, b) => Number(a.id.slice(3)) - Number(b.id.slice(3))).map(f => {
      const owner = f.attribution.created_by.role === 'owner';
      // A plan choice sat on the pseudo-step 'plan'; a coordinator reply carries its parent's step, as `reply` sent it.
      const planStep = f.plan_id || (f.reply_to && st.feedback[f.reply_to]?.plan_id);
      return { id: legacyId(f.id), task: f.task_id, step: planStep ? 'plan' : f.step_id || '', text: legacyText(f), kind: LEGACY_NOTE_KINDS.has(f.kind) ? 'note' : f.kind, by: owner ? 'anh' : 'cos',
        // An informational note (the CoS allowance) reads as done: it is never an item to handle (J-05 round 2).
        status: f.status === 'open' && !f.info ? 'open' : 'done', at: originAt(f) || f.attribution.created_at, ...(f.reply_to ? { replyTo: legacyId(f.reply_to) } : {}),
        ...(f.kind === 'rebrief' ? { mode: f.mode || 'strategy', note: f.note || '' } : {}), ...(f.resolved ? { doneAt: f.resolved.at } : {}),
        ...(['redirect', 'askback', 'receipt'].includes(f.kind) ? { msgKind: f.kind } : {}),
        // v2: the asks an owner message answered, by id (closed asks leave asks[], so lane and step come along for a receipt)
        ...(v2 ? answered(f) : {}),
        ...(f.attachments?.length ? { attachments: f.attachments.map(id => `api/v1/media/${id}`) } : {}) };
    });
    const sum = st.docs?.summary, lastPush = Object.values(st.activity).sort().at(-1);
    const goals = Object.fromEntries(Object.values(st.goals || {}).map(g => [g.task_id, {
      goal: g.goal, output: g.output, outcome: g.outcome, lockedAt: g.locked_at, lockedBy: 'anh', version: g.version,
      history: (g.history || []).map(h => ({ goal: h.goal, output: h.output, outcome: h.outcome, lockedAt: h.locked_at || null, lockedBy: 'anh', version: h.version }))
    }]));
    const plans = Object.fromEntries(Object.entries(st.plans || {}).map(([code, list]) => [code, list.map(p => ({
      id: p.legacy_id || p.id, reviewer: p.reviewer, verdict: p.verdict || '', eta: p.eta || '', body: p.body, at: p.written_at || p.posted_at, postedAt: p.posted_at, goalVersion: p.goal_version || 0 }))]));
    return {
      tasks, feedback, meta: { ...(sum ? { summary: sum.items } : {}), updatedAt: lastPush || '' },
      pings: (st.pings || []).slice(-20).map(legacyPing),
      registry: (st.docs?.registry?.entries || []).map(e => ({ id: e.id, code: e.code || '', title: e.title, file: e.file || '', owner: e.owner || '', note: e.note || '', updated: e.updated || '',
        onBoard: !!e.on_board, status: e.status, ...(e.status_by ? { statusBy: e.status_by } : {}), ...(e.status_at ? { statusAt: e.status_at } : {}) })),
      watcherAt: view.watcher_at, times: legacyTimes(st), goals, plans, mediaInfo: mediaInfo()
    };
  }

  // ---------- writes ----------
  function needTask(code) { if (!state().tasks[code] && code !== REQUESTS_THREAD && code !== BOARD_TARGET) throw new BoardError(400, 'task_not_found', { task: code }); }
  const stepIdIf = (code, step) => (step && state().steps[`${code}/${step}`] ? { step_id: step } : {});

  function reply(b) {
    const task = String(b.task ?? '').slice(0, 40), text = String(b.text ?? '').trim();
    needTask(task);
    if (!text) throw new BoardError(400, 'empty');
    if (b.kind === 'ask') {
      if (!state().tasks[task]) throw new BoardError(400, 'task_not_found', { task });
      const lane = namedLane(b.lane) || (isShared(task) ? (() => { throw laneRequired([task]); })() : taskLane(task));
      const r = upsertAsk(task, lane, stepIdIf(task, b.step).step_id || '', text.slice(0, 2000));
      return { id: legacyId(r.id), task, step: b.step || '', text, kind: 'ask', by: 'cos', status: 'open', replyTo: '', at: new Date().toISOString() };
    }
    const parent = b.replyTo ? state().feedback[boardId(String(b.replyTo))] : null;
    // kind 'receipt' (or 'nhan'): the coordinator's "Nhận" on an owner message — text with Đổi: / Lịch: / Bước tiếp:
    // lines; it closes that message (the board checks the lines and that the parent is the owner's).
    const receipt = b.kind === 'receipt' || b.kind === 'nhan';
    if (receipt && !parent) throw new BoardError(400, 'receipt_needs_owner_message', { replyTo: String(b.replyTo || '') });
    const r = w('feedback.add', task, { kind: receipt ? 'receipt' : parent ? 'reply' : 'note', text: text.slice(0, 8000), ...stepIdIf(task, b.step),
      ...(parent ? { reply_to: parent.id, ...(b.close && !receipt ? { resolve_reply_to: true } : {}) } : {}) });
    const f = state().feedback[r.id];
    // A receipt answers as the predecessor's 'note' and says what it really is (msgKind, reply_to), so a caller does not
    // mistake it for a plain note.
    return { id: legacyId(r.id), task, step: b.step || '', text: f.text, kind: 'note', by: 'cos', status: 'open', replyTo: String(b.replyTo || ''), at: f.attribution.created_at,
      ...(receipt ? { msgKind: 'receipt', reply_to: String(b.replyTo || '') } : {}) };
  }

  /** POST /api/admin/close {code}: the one way a coordinator removes a task — it is closed (task.update status closed),
   *  never deleted, and the owner_set_status guard applies as to any coordinator write. */
  function closeTask(b) {
    const code = String(b.code ?? '').slice(0, 40), t = state().tasks[code];
    if (!t) throw new BoardError(400, 'task_not_found', { task: code });
    if (t.status === 'closed') return { ok: true, code, status: 'closed', writes: 0 };
    w('task.update', code, { status: 'closed' }, { expected_revision: t.rev });
    return { ok: true, code, status: 'closed', writes: 1 };
  }

  /**
   * POST /api/admin/asks. With a lane (and optionally a step) the ask holds the identity (task, lane, step): a new one replaces
   * only the open ask of that identity, other lanes' asks stay (s21). Without a lane or a step it is the predecessor's call: the
   * task's one ask is replaced, whichever step it sat on, as asks.json did; on a shared task that call could replace another
   * lane's ask, so it is refused 428.
   */
  function setAsk(b) {
    const code = String(b.code ?? '').slice(0, 40), text = String(b.text ?? '').trim().slice(0, 2000);
    if (!code || !text) throw new BoardError(400, 'empty');
    if (!state().tasks[code]) throw new BoardError(400, 'task_not_found', { task: code });
    const named = namedLane(b.lane), stepGiven = 'step' in b || 'step_id' in b, stepId = String(b.step ?? b.step_id ?? '');
    if (!named && isShared(code)) throw laneRequired([code]);
    if (stepId && !state().steps[`${code}/${stepId}`]) throw new BoardError(400, 'step_not_found', { task: code, step: stepId });
    const lane = named || taskLane(code), by = String(b.by || 'Pi CoS').slice(0, 40), origin = `lane-ask ${by}`;
    let id, replaced = [];
    if (!named && !stepGiven) {
      for (const a of openAsks(code)) { clearAsk(a, 'replaced by a newer ask'); replaced.push(a.id); }
      id = upsertAsk(code, lane, '', text, { origin }).id;
    } else ({ id, replaced } = upsertAsk(code, lane, stepId, text, { origin }));
    w('ping.send', 'board', { kind: 'ask', task_id: code, note: `${by} hỏi ${code}: ${text.slice(0, 80)}` });
    return named || stepGiven ? { ok: true, id, lane, replaced } : { ok: true };
  }

  /** POST /api/admin/asks/clear {id} | {code, lane, step}: exactly one ask. No scope is 400 (it used to clear the whole task). */
  function clearAsks(b) {
    let target;
    if (b.id) {
      const a = state().asks[boardId(String(b.id))];
      target = a && (!b.code || a.task_id === String(b.code)) ? a : null;
    } else if (b.code && String(b.lane ?? '').trim() && ('step' in b || 'step_id' in b)) {
      const code = String(b.code).slice(0, 40);
      target = state().tasks[code] ? openAskAt(state(), code, namedLane(b.lane), String(b.step ?? b.step_id ?? '')) : null;
    } else throw new BoardError(400, 'scope_required', { need: 'id, or code + lane + step' });
    if (!target || target.status !== 'open') return { ok: true, cleared: [] };
    clearAsk(target);
    return { ok: true, cleared: [target.id] };
  }

  /** POST /api/admin/asks/clear-all {code, confirm:"ALL"}: the one way to clear every open ask of a task, never by omission. */
  function clearAllAsks(b) {
    const code = String(b.code ?? '').slice(0, 40);
    if (b.confirm !== 'ALL') throw new BoardError(400, 'confirm_required', { need: 'confirm: "ALL"' });
    if (!state().tasks[code]) throw new BoardError(400, 'task_not_found', { task: code });
    const cleared = [];
    for (const a of openAsks(code)) { clearAsk(a, 'cleared all'); cleared.push(a.id); }
    return { ok: true, cleared };
  }

  /** POST /api/admin/turn {lane, turn_id, detail}: `cos-board.mjs turn`. A lane finished a turn; the coordinator token writes it for that lane.
   *  Answers {ok, seq, quick}; a turn_id the lane already reported is the board's 409 duplicate_turn, which carries the original seq and quick. */
  function turnReport(b) {
    const lane = String(b.lane ?? '').trim();
    if (!lane) throw new BoardError(400, 'lane_required');
    const r = w('turn.report', lane, { turn_id: String(b.turn_id ?? ''), detail: String(b.detail ?? '') });
    return { ok: true, seq: r.seq, quick: r.quick };
  }

  /** `cos-board.mjs escalate <CODE> --gate <id> ["note"] | escalate <CODE> "<gate>" [reason]`: one failed gate.
   *  The gate is normalised to a stable key (`normalizeGate`), so two attempts of the same gate add up; the raw text
   *  stays in the journal. At the second fail on that key the code slot moves up one tier. CoS-only: the caller's lane
   *  goes to the op as it came. A caller that names no lane is refused there, never blessed as CoS here. */
  function escalate(b) {
    const code = String(b.code ?? '').slice(0, 40), gate = String(b.gate ?? '').trim().slice(0, 120), reason = String(b.reason ?? '').trim().slice(0, 400);
    if (!gate) throw new BoardError(400, 'empty_gate');
    if (!state().tasks[code]) throw new BoardError(400, 'task_not_found', { task: code });
    w('roles.escalate', code, { gate, ...(reason ? { reason } : {}), ...(b.lane ? { lane: String(b.lane) } : {}) });
    const id = normalizeGate(gate), g = state().gate_fails?.[code]?.[id], auto = state().roles?.[code]?.code;
    const bumped = !!auto && auto.gate === id && g?.last_at === auto.at;
    return { ok: true, code, gate: id, count: g ? g.total : 0, fails: g ? g.total : 0, since_bump: g ? g.count : 0, bumped, ...(g?.blocked ? { blocked: g.blocked } : {}), ...(bumped ? { code_slot: { model: auto.model, effort: auto.effort, by: 'auto', reason: auto.reason } } : {}) };
  }

  /** `cos-board.mjs override <CODE> "<reason>" [--hours N] | override <CODE> --clear ["reason"]`: the CoS allowance
   *  (op roles.override). CoS-only; the CLI refuses locally unless its lane is CoS, and the server re-checks the lane. */
  function setOverride(b) {
    const code = String(b.code ?? '').slice(0, 40), reason = String(b.reason ?? '').trim(), clear = b.clear === true;
    const hours = b.hours === undefined ? undefined : Number(b.hours);
    if (!state().tasks[code]) throw new BoardError(400, 'task_not_found', { task: code });
    const written = w('roles.override', code, { ...(clear ? { clear: true } : {}), ...(reason ? { reason } : {}), ...(hours !== undefined ? { hours } : {}), lane: String(b.lane ?? 'CoS') });
    const entry = state().route_override?.[code];
    // A clear with nothing to clear writes nothing; the CLI prints "nothing to clear" from this flag.
    return { ok: true, code, ...(written.noop ? { noop: true } : {}), route_override: entry ? { ...entry, expired: !(Date.parse(entry.expires) > Date.now()) } : null };
  }

  function markSeen() {
    const n = (state().pings || []).filter(p => !p.seen_at).length;
    if (n) w('ping.seen', 'board', {});
    return { ok: true, marked: n };
  }

  /** PUT /api/admin/stats: the board's task-statistics document (J-05). It is DERIVED data, not a board op: board.putStats
   *  validates it against schema/v1/stats.json (400 invalid_data), enforces the 512 KiB cap (413 too_large) and writes it
   *  atomically to <data>/stats.json — never to the journal, so an older board (one with no stats op) can replay this
   *  journal and start. Body = { doc } or the document itself. */
  function setStats(b) {
    const doc = b && typeof b === 'object' && b.doc && typeof b.doc === 'object' ? b.doc : b;
    return board.putStats(doc);
  }

  function addPlan(b) {
    const code = String(b.task ?? '').slice(0, 40), reviewer = String(b.reviewer ?? '').slice(0, 40).trim(), body = String(b.body ?? '').slice(0, 60000).trim();
    if (!code || !reviewer || !body) throw new BoardError(400, 'empty');
    if (!state().tasks[code]) throw new BoardError(400, 'unknown_task');
    const at = !isNaN(Date.parse(b.at)) ? new Date(b.at).toISOString() : undefined;
    const VERDICTS = ['on-track', 'adjust', 'pivot', 'drifting', 'wrong-goal', 'unavailable'];
    const r = w('plan.add', code, { reviewer, body, ...(VERDICTS.includes(b.verdict) ? { verdict: b.verdict } : {}), ...(b.eta ? { eta: String(b.eta).slice(0, 200) } : {}), ...(at ? { written_at: at } : {}) });
    const p = state().plans[code].find(x => x.id === r.id);
    return { id: p.id, reviewer: p.reviewer, verdict: p.verdict, eta: p.eta || '', body: p.body, at: p.written_at || p.posted_at, postedAt: p.posted_at, goalVersion: p.goal_version };
  }

  function setRegistry(b) {
    if (!Array.isArray(b.registry)) throw new BoardError(400, 'registry_array_required');
    const doc = state().docs?.registry, cur = new Map((doc?.entries || []).map(e => [e.id, e]));
    // The predecessor kept the owner's status as an override a re-push never erased: a current entry that carries
    // status_by (owner, import override) keeps its status.
    const entries = b.registry.map(r => {
      const e = legacyRegistryEntry(r), c = cur.get(e.id);
      if (c?.status_by) { e.status = c.status; e.status_by = c.status_by; if (c.status_at) e.status_at = c.status_at; else delete e.status_at; }
      return e;
    });
    if (!same(entries, doc?.entries)) w('registry.set', 'board', { entries }, { expected_revision: doc?.rev || 0 });
    return { ok: true, count: entries.length };
  }

  /**
   * Step writes that take a task from its current steps to the row's, never leaving it in a state the board rules
   * refuse: each pending write (state/content change, new step, step delete, reorder) is tried in turn on a
   * simulated copy and the first one that keeps the task valid is sent. If none does, a step that must enter
   * 'waiting' or 'done' first moves to 'todo' (always valid) and is retried later. The row itself is valid
   * (checked up front), so this ends with exactly the row.
   */
  function syncSteps(code, ids, byId, { lane = '', replace = true } = {}) {
    const sim = () => state().tasks[code].step_ids.map(id => ({ id, state: state().steps[`${code}/${id}`].state, lane: stepLane(code, id) }));
    const valid = steps => !validateTasks([{ id: code, steps }]).length;
    const pending = [];
    for (const id of ids) {
      const s = state().steps[`${code}/${id}`], to = byId[id];
      if (!s) { pending.push({ kind: 'create', id }); continue; }
      if (STEP_FIELDS.some(k => !eq(to[k], s[k]))) pending.push({ kind: 'update', id });
    }
    // A lane's push removes only that lane's steps (and only with replace); a push that names no lane is the whole row's.
    // `lich-su` is never any lane's: a replace push cannot delete it (J-05 compaction).
    const isOwn = id => id !== HISTORY_STEP && (!lane || stepLane(code, id) === lane);
    if (replace) for (const id of state().tasks[code].step_ids) if (!ids.includes(id) && isOwn(id)) pending.push({ kind: 'delete', id });
    pending.push({ kind: 'order' });
    let writes = 0;
    const parked = new Set();
    /**
     * The order the task takes (Sol's rule): steps of other lanes keep their places; the pusher's own steps, the ones it sent, take
     * its own places in the order it sent them (the places of own steps it did not send stay theirs); new own steps were appended
     * by step.create, so they simply join the own places. null while a step it sent is not on the board yet.
     */
    const orderFor = cur => {
      if (!ids.every(id => cur.includes(id))) return null;
      const ownIds = ids.filter(isOwn);
      const places = cur.flatMap((id, i) => (isOwn(id) ? [i] : [])), keep = new Set(places.filter(i => !ids.includes(cur[i])));
      const out = [...cur];
      places.filter(i => !keep.has(i)).forEach((place, k) => { out[place] = ownIds[k]; });
      return out;
    };
    const tryOp = (op, dry) => {
      const cur = sim(), t = state().tasks[code];
      if (op.kind === 'order') {
        const order = orderFor(t.step_ids);
        if (!order || same(order, t.step_ids)) return dry ? !pending.some(p => p.kind !== 'order') : 'skip';
        const byKey = new Map(cur.map(s => [s.id, s]));
        if (!valid(order.map(id => byKey.get(id)))) return false;
        if (dry) return true;
        w('task.update', code, { step_order: order }, { expected_revision: t.rev }); writes++; return true;
      }
      if (op.kind === 'delete') {
        if (dry) return true; // removing a step never breaks the rules
        const s = state().steps[`${code}/${op.id}`];
        w('step.delete', s.id, {}, { expected_revision: s.rev }); writes++; return true;
      }
      const to = byId[op.id], state0 = op.via || to.state;
      if (op.kind === 'create') {
        if (!valid([...cur, { id: op.id, state: state0, lane: byId[op.id].lane || lane || taskLane(code) }])) return false;
        if (dry) return true;
        const { id: _id, ...d } = to;
        w('step.create', `${code}/${op.id}`, { ...d, state: state0 }); writes++; return true;
      }
      const s = state().steps[`${code}/${op.id}`];
      if (!valid(cur.map(x => (x.id === op.id ? { ...x, state: state0 } : x)))) return false;
      if (dry) return true;
      const patch = Object.fromEntries(STEP_FIELDS.filter(k => !eq(to[k], s[k])).map(k => [k, to[k] ?? (k === 'options' ? [] : '')]));
      if (op.via) patch.state = op.via;
      if (Object.keys(patch).length) { w('step.update', s.id, patch, { expected_revision: s.rev }); writes++; }
      return true;
    };
    while (pending.length) {
      // The reorder goes last among what is possible; any other write that is valid now goes first.
      let i = pending.findIndex(op => op.kind !== 'order' && tryOp(op, true));
      if (i < 0) i = pending.findIndex(op => op.kind === 'order' && tryOp(op, true));
      if (i >= 0) {
        const op = pending.splice(i, 1)[0];
        if (tryOp(op, false) === 'skip') continue;
        if (op.via) { delete op.via; pending.push({ kind: 'update', id: op.id }); }
        continue;
      }
      // Stuck: park one step that has to enter waiting/done in 'todo', then retry its real state later. A step parked once and
      // stuck again will not get out by parking (the order it needs is not ours to give): refuse instead of looping.
      const park = pending.find(op => (op.kind === 'update' || op.kind === 'create') && !op.via && !parked.has(op.id) && ['waiting', 'done'].includes(byId[op.id].state));
      if (!park) throw new BoardError(409, 'push_not_applicable', { task: code });
      parked.add(park.id);
      park.via = 'todo';
    }
    return writes;
  }

  /**
   * The steps of a task as they will be once a lane's push is applied -- creates appended, deletes (replace only, own lane only)
   * dropped, the pusher's steps in their places by Sol's rule, states from the row -- as [{id, state}] for the board rules.
   */
  function finalSteps(code, ids, byId, lane, replace) {
    const cur = state().tasks[code].step_ids;
    const isOwn = id => id !== HISTORY_STEP && (!lane || stepLane(code, id) === lane); // `lich-su` is never any lane's
    const kept = cur.filter(id => ids.includes(id) || !(replace && isOwn(id))), list = [...kept, ...ids.filter(id => !cur.includes(id))];
    const ownIds = ids.filter(isOwn);
    const places = list.flatMap((id, i) => (isOwn(id) ? [i] : [])), keep = new Set(places.filter(i => !ids.includes(list[i])));
    const out = [...list];
    places.filter(i => !keep.has(i)).forEach((place, k) => { out[place] = ownIds[k]; });
    return out.map(id => ({ id, state: ids.includes(id) ? byId[id].state : state().steps[`${code}/${id}`].state, lane: cur.includes(id) ? stepLane(code, id) : lane || taskLane(code) }));
  }

  /**
   * A push of predecessor rows, as the board's own writes. A task missing from the push is left untouched — never
   * deleted or closed (`untouched` lists them); removing one is an explicit POST /api/admin/close. Refused whole (nothing
   * written) when any row breaks the board rules or the lane rules below. The text fields lose duplicated refs lines first
   * (src/refs.mjs normalizeRefs), so a client that pushes back what /state returned cannot multiply them.
   *
   * Without `lane` (the predecessor's push): the row is the whole task as before -- steps missing from it are deleted, steps take
   * its order, task fields follow it. Allowed only on a task one lane owns; on a shared task it is 428 lane_required, because a
   * row built by one lane cannot speak for the others. With `lane` (the pusher's lane, resolved against the board's lanes):
   *  - only that lane's steps are written; a step id that belongs to another lane is 409 lane_mismatch; new steps carry the
   *    lane (unless it is the task's own); steps the row omits stay unless `replaceLane` is true, and then only that lane's go;
   *  - other lanes' steps keep their places, the pusher's take their own places in the row's order (syncSteps orderFor);
   *  - task-level fields (title, health, goal, now, next, ... ) belong to the task's lane: another lane that sends one
   *    different from the board's has it IGNORED -- a field it leaves out is ignored too -- and the push returns the
   *    ignored fields under `ignored` (never a whole-push refusal; a lane must be able to close its step on the row, J-05);
   *  - needsAnh is that lane's ask, at (task, lane, the row's waiting owner step): other lanes' asks are never touched.
   * The task's lane never changes (409 lane_immutable). needsAnh (both forms): raised as an ask when the identity has no open ask
   * (without lane: when the task has none); an ask an earlier push raised follows the row (re-raised on new text, cleared when
   * the row drops it; not re-raised when the owner answered it); asks from `ask`/the owner/the import are never touched by a
   * push (only `clear` removes them), as asks.json was. `kept` lists what could not be applied.
   */
  async function pushRows(b) {
    if (!Array.isArray(b.tasks)) throw new BoardError(400, 'tasks_array_required');
    const declared = namedLane(b.lane), replace = !declared || b.replaceLane === true;
    if (b.replaceLane === true && !declared) throw new BoardError(400, 'replace_lane_needs_lane');
    // Refs lines the renderer wrote are collapsed and deduplicated before anything is compared or stored. Archived step
    // ids a stale row still names are stripped here, BEFORE ids/byId/order are built: they are never re-created, never
    // re-ordered, and never make a push fail (they are reported back under `ignored`). `lich-su` is the board's own
    // history step (J-05): it is stripped the same way, so a row cannot create it, rename it, move it, reopen it or
    // blank its detail -- `isOwn` keeps it out of deletes and ordering, this keeps it out of updates and creates.
    const archivedNames = new Map();
    const rows = b.tasks.map(({ currentStep: _ignored, ...row }) => {
      for (const f of REF_FIELDS) if (typeof row[f] === 'string') row[f] = normalizeRefs(row[f]);
      row.steps = (row.steps || []).filter(s => s.id !== HISTORY_STEP);
      if (row.askStep === HISTORY_STEP) delete row.askStep;
      // The map's entries are refs-bearing ask texts like needsAnh: normalised the same way (review S1), and copied so the
      // keys are cleaned below without mutating the caller's row.
      if (hasAskMap(row)) row.asks = Object.fromEntries(Object.entries(row.asks).map(([k, v]) => [k, typeof v === 'string' ? normalizeRefs(v) : v]));
      const arch = new Set(state().archive?.[row.code]?.order || []);
      if (arch.size) {
        // A map key names a step like askStep does, so an archived id is reported and dropped the same way (it never fails the push).
        const gone = [...(row.steps || []).map(s => s.id), ...(hasAskMap(row) ? Object.keys(row.asks) : [])].filter(id => arch.has(id));
        if (gone.length) {
          archivedNames.set(row.code, [...new Set(gone)]);
          row.steps = (row.steps || []).filter(s => !arch.has(s.id));
          if (arch.has(row.askStep)) delete row.askStep;
        }
      }
      // A map entry for a step the board will not take an ask on (its own history step, an archived id) is dropped here, not refused:
      // a stale row must never stall a lane (the same rule askStep and steps follow above).
      if (hasAskMap(row)) for (const k of Object.keys(row.asks)) if (k === HISTORY_STEP || arch.has(k)) delete row.asks[k];
      return row;
    });
    const plan = rows.map(row => {
      const create = legacyRowToRequests(row, { prefix: 'compat' })[0];
      const ids = uniqueStepIds(row);
      const byId = Object.fromEntries((create.data.steps || []).map(s => [s.id, s]));
      return { row, create, ids, byId };
    });
    const violations = validateTasks(plan.map(p => ({ id: p.row.code, steps: p.ids.map(id => p.byId[id]) })));
    if (violations.length) { const { error, ...first } = violations[0]; throw new BoardError(400, error, { ...first, violations }); }
    // A bad product-structure diagram refuses the whole push before the first write (task.create/update check it again at write time).
    const badArch = plan.filter(p => p.create.data.architecture != null).map(p => ({ task: p.row.code, errors: validateArchitecture(p.create.data.architecture) })).filter(x => x.errors.length);
    if (badArch.length) throw new BoardError(400, 'bad_architecture', { task: badArch[0].task, message: badArch[0].errors[0], violations: badArch.flatMap(x => x.errors.map(e => ({ task: x.task, error: e }))) });

    // The lane rules, all checked before the first write. Order of the refusals: lane, owner, step, board rules. A
    // non-owner lane's changed row field is NOT a refusal (J-05 step-owner): the field is ignored and named in `ignored`
    // below, while that lane's own step writes still apply -- so a lane can close its step on another lane's row.
    const needLane = [], immutable = [], mismatch = [], conflict = [], badStep = [], overCap = [];
    const ignored = [...archivedNames].map(([task, steps]) => ({ task, archived: steps })); // reported, never a refusal
    for (const { row, create, ids, byId } of plan) {
      // A row that NAMES an ask step the board cannot tie an ask to is refused whole (J-05 16-10): guessing the first waiting
      // owner step moved the ask onto another step and replaced the lane's open ask there. Checked for new rows too.
      const bad = badAskStep(row);
      if (bad) badStep.push({ task: row.code, ask_step: bad });
      const t = state().tasks[row.code];
      // The cap is decided before the first write, for a new row as well as an existing one (`task.create` carries a
      // schema cap of its own, but it is checked at write time, after earlier rows have landed). `ids` is exactly what a
      // create makes; `finalSteps` is the row as an existing task will hold it. Until J-05 auto-compact a row that grew
      // a task past the cap failed MID-push (the 50th landed, the 51st step.create answered 400 too_many_steps).
      const after = t ? finalSteps(row.code, ids, byId, declared, replace) : ids.map(id => ({ id }));
      if (after.length > STEP_CAP) overCap.push({ task: row.code, steps: after.length, cap: STEP_CAP });
      if (!t) continue;
      if (!declared && isShared(row.code, { lanesOnly: true })) needLane.push(row.code);
      if (!blank(row.lane) && row.lane !== t.lane) immutable.push({ task: row.code, lane: t.lane, row_lane: row.lane });
      if (!declared) continue;
      const foreign = ids.filter((id, i) => {
        if (id === HISTORY_STEP) return false; // never any lane's step: a lane's row may name it without owning it
        const named = (row.steps || [])[i]?.lane;
        return (state().steps[`${row.code}/${id}`] && stepLane(row.code, id) !== declared) || (!blank(named) && resolveLane(state(), named) !== declared);
      });
      if (foreign.length) mismatch.push({ task: row.code, steps: foreign });
      if (declared !== t.lane) {
        const fields = TASK_FIELDS.filter(k => create.data[k] !== undefined && !eq(create.data[k], t[k]));
        if (create.data.worker !== undefined && !same(create.data.worker, t.worker || null)) fields.push('worker');
        if (!blank(create.data.loops) && !eq(create.data.loops, t.loops)) fields.push('loops');
        if (create.data.architecture !== undefined && !same(create.data.architecture, t.architecture ?? null)) fields.push('architecture');
        if (fields.length) ignored.push({ task: row.code, fields }); // row-level fields stay the row owner's; this lane's steps still apply
      }
      for (const id of ids) if (!state().steps[`${row.code}/${id}`] && declared !== t.lane) byId[id].lane = declared; // a new step of another lane carries it
      // The rows are valid alone; with the other lanes' steps kept in their places the task may not be (a Vesta step done behind a
      // step of Pi that waits). The board's rules decide before anything is written, with the steps named.
      const broken = validateTasks([{ id: row.code, steps: after }]);
      if (broken.length) conflict.push({ task: row.code, violations: broken });
    }
    if (needLane.length) throw laneRequired(needLane);
    if (immutable.length) throw new BoardError(409, 'lane_immutable', { ...immutable[0], violations: immutable });
    if (mismatch.length) throw new BoardError(409, 'lane_mismatch', { ...mismatch[0], violations: mismatch });
    if (conflict.length) { const { error, ...first } = conflict[0].violations[0]; throw new BoardError(409, error, { ...first, reason: "with the other lanes' steps in their places", violations: conflict.flatMap(c => c.violations) }); }
    if (badStep.length) throw new BoardError(400, 'ask_step_not_waiting_owner', { ...badStep[0], reason: "the row's askStep names a step that is not a waiting owner step: the ask cannot be tied to it, and the board must not guess another step", violations: badStep });
    // The gate's message for an over-cap row. It is exact when nothing older is left to fold; when old done steps do
    // exist, folding mid-push is what condition 1 forbids -- the lane pushes the same row WITHOUT its new steps first
    // (that push folds at >= AUTO_COMPACT_AT and says so in `compacted`), then pushes the row with them.
    if (overCap.length) throw new BoardError(400, 'too_many_steps', { ...overCap[0], message: 'không còn bước cũ đã xong để gộp; hãy đóng hoặc gộp tay', violations: overCap });

    let writes = 0;
    const kept = [], compacted = [], touched = new Set();
    const one = (...a) => { writes++; return w(...a); };
    const untouched = Object.keys(state().tasks).filter(id => !rows.some(r => r.code === id));
    for (const { row, create, ids, byId } of plan) {
      const code = row.code;
      if (!state().tasks[code]) { one('task.create', code, declared && !create.data.lane ? { ...create.data, lane: declared } : create.data); }
      else {
        const t = state().tasks[code], patch = {}, ownerPush = !declared || declared === t.lane;
        for (const k of TASK_FIELDS) {
          const want = create.data[k];
          if (eq(want, t[k]) || (blank(want) && ['order', 'title', 'health'].includes(k))) continue; // kept when the row has none
          if (!ownerPush) continue; // another lane's row sends no task field that differs (refused above); a blank one is not a clear
          patch[k] = want ?? '';
        }
        if (ownerPush && !same(create.data.worker || null, t.worker || null)) patch.worker = create.data.worker || null;
        // architecture: a row WITHOUT the field keeps the board's (rows written before it existed must not wipe it); `null` clears.
        if (ownerPush && create.data.architecture !== undefined && !same(create.data.architecture, t.architecture ?? null)) patch.architecture = create.data.architecture;
        if (Object.keys(patch).length) one('task.update', code, patch, { expected_revision: t.rev });
        writes += syncSteps(code, ids, byId, { lane: declared, replace });
        const t2 = state().tasks[code];
        if (ownerPush && !eq(create.data.loops, t2.loops)) one('task.update', code, { loops: create.data.loops || [] }, { expected_revision: t2.rev });
        // The predecessor's "Cập nhật" / stale / idle clocks read the row's own `updated`: a push that only bumps it
        // (the coordinator saying "still moving") reset them. Same here: a row whose `updated` is newer than the
        // task's last accepted change records one (server clock); a re-push of the same row writes nothing.
        const rowAt = Date.parse(row.updated || ''), t3 = state().tasks[code];
        if (ownerPush && rowAt > Date.parse(state().activity[code] || 0)) one('task.update', code, {}, { expected_revision: t3.rev });
      }
      // Asks: one per (task, lane, step) -- the ask of the pushing lane (the task's lane when none is named). A row with an `asks` map
      // says, for every step it names, the ask of this lane on that step; the legacy needsAnh+askStep form is the map's one-entry case
      // (rowAsks decides its step: askStep when that waits for the owner, else the first waiting owner step when the row asks at all).
      // Each entry is reconciled on its OWN step: a reword replaces there, the same text on another step is a new ask, and an ask on a
      // step the row does not speak for is not the row's to replace or drop -- it ends when its step stops waiting. Nothing is compared
      // across steps, so five waiting owner steps are five asks. Step-less asks (a row that asks with no owner step) follow the row.
      const lane = declared || taskLane(code);
      // The row's own step ids in order; a duplicated id (the predecessor accepted it) is the FIRST occurrence, as askStepIndex reads it.
      const stepIds = new Map();
      for (const [i, s] of (row.steps || []).entries()) if (!stepIds.has(s.id)) stepIds.set(s.id, ids[i]);
      const desired = rowAsks(row)
        .map(a => ({ ...a, step_id: a.step === undefined ? undefined : stepIds.get(a.step) }))
        .filter(a => a.step === undefined || a.step_id);
      const wants = new Map(desired.map(a => [a.step_id || '', a.text]));
      const speaks = new Set(wants.keys());
      if (!hasAskMap(row)) speaks.add(''); // the one legacy ask is the row's whether it names a step or not
      const waiting = id => state().steps[`${code}/${id}`]?.state === 'waiting';
      const waitingOwner = id => { const st = state().steps[`${code}/${id}`]; return !!st && st.state === 'waiting' && st.zone === 'owner'; };
      const mine = openAsks(code).filter(a => a.attribution.created_by.origin === PUSH_ORIGIN && askLane(state(), a) === lane);
      // Only a map that is THIS pusher's own speaks with the whole row: its lane is the pusher's, or every key names a step the pusher
      // owns. A lane in a shared rows dir pushes a row built by the row owner, and that map must never clear the pusher's own asks;
      // such a row clears a key explicitly ({"<step>": ""}) instead, which says "no ask here" without claiming the rest of the row.
      const ownMap = hasAskMap(row) && (!declared || row.lane === declared ||
        (Object.keys(row.asks).length > 0 && Object.keys(row.asks).every(k => stepIds.has(k) && stepLane(code, stepIds.get(k)) === declared)));
      const toClear = a => {
        const id = a.step_id || '';
        if (id && !waiting(id)) return true; // its step stopped waiting: the ask ends
        // Still waiting: this row's own map is its whole answer for its own steps, so an entry it leaves out is that step's clear
        // (`clear --step A` removes the key). A legacy row speaks only for the step it names (or the step-less ask it carries): a
        // step it leaves out keeps its ask (S1/B1). A blank text on a named step clears, as it always was. A step-less ask left by
        // an older client has no key in any map, so the lane's own map clears it too (review S2), as a legacy row's changed text did.
        if (!speaks.has(id)) return ownMap && (!id || stepLane(code, id) === lane);
        return a.text !== (wants.get(id) ?? '');
      };
      for (const a of mine.filter(toClear)) { writes++; clearAsk(a, 'row needsAnh changed'); }
      // A non-owner lane may only RAISE an ask on a step it owns (J-05 step-owner): a full-row push from a shared rows dir
      // carries the row owner's asks, which must not be re-raised as this lane's ask. A new step in this lane's row is this
      // lane's (syncSteps stamps it); an ask the lane already raised stays updateable/clearable via `mine` above.
      const mayAsk = step => !declared || declared === taskLane(code) || (!!step && (stepLane(code, step) === declared || !state().steps[`${code}/${step}`]));
      // A legacy row WITHOUT askStep cannot name its ask step: the board guesses it from the row's order, so the same question still
      // open anywhere on the lane (or already answered there) is not asked a second time -- a reorder must not multiply it (review
      // S1, and ce850a7's answer dedupe). A map, or a row that names its askStep, is reconciled per step only: there, the same text
      // on another step is a different question.
      const loose = !hasAskMap(row) && !row.askStep;
      // Another writer's open ask on that identity already answers for it (the board's one-open-ask rule), and a legacy row that
      // cannot name its step never raises a second ask where its guess points: for a no-lane push on a single-lane task any open ask
      // on that step counts (an open lane ask wins over the row, as asks.json did); a named-ask row and a map are per step.
      const heldAt = step => !!openAskAt(state(), code, lane, step) ||
        (!declared && !hasAskMap(row) && openAsks(code).some(x => !x.step_id || !step || x.step_id === step));
      for (const a of desired) {
        const step = a.step_id || '', text = a.text;
        if (!text || !mayAsk(step)) continue;
        if (step && !waitingOwner(step)) continue; // a map naming a step the owner does not answer is refused above (badAskStep), never guessed
        // The same question is still open on this very step: nothing to write. Another step's ask never blocks it (per-step identity),
        // except for the guess above.
        if (heldAt(step)) continue;
        if (loose && mine.some(x => x.status === 'open' && x.text === text && (x.step_id || '') !== step)) continue;
        // The owner already answered this very ask on this step (button or a note): the row does not raise it again. A changed
        // text is a new question and is raised.
        const ofLane = Object.values(state().asks).filter(x => x.task_id === code && askLane(state(), x) === lane);
        const latest = (loose ? ofLane : ofLane.filter(x => (x.step_id || '') === step)).sort(byAskTime).at(-1);
        if (latest?.status === 'answered' && latest.text === text) continue;
        one('ask.raise', code, {
          text, ...(a.step_id ? { step_id: a.step_id } : {}), ...(a.options?.length ? { options: a.options } : {}),
          ...(lane !== taskLane(code) ? { lane } : {})
        }, { origin: PUSH_ORIGIN });
      }
      touched.add(code); // a candidate for J-05 auto-compact, decided once EVERY row of this push has been written
    }
    if (Array.isArray(b.summary)) {
      const items = b.summary.map(x => String(x).slice(0, 2000)).filter(Boolean).slice(0, 50), doc = state().docs?.summary;
      if (!same(items, doc?.items)) one('summary.set', 'board', { items }, { expected_revision: doc?.rev || 0 });
    }
    // J-05 auto-compact, AFTER every row of the push has been written -- a later row that fails (409 push_not_applicable,
    // an invalid create) must leave no compact behind (GATE-auto Q1) -- and still inside the same synchronous section
    // (the first await is attachMedia), so two lane pushes cannot interleave. The row is applied, so a step it reopened
    // or edited is no longer done and cannot be archived; a step it edited but left done may be folded, its record kept
    // whole in state.archive. Nothing is re-planned for the next push. A plan with nothing eligible writes NOTHING: a
    // retried push never journals an empty compact (the manual op does). The compat coordinator the push already writes
    // as does the compact, marked by origin; it is reported in `compacted`, never counted in `writes` (the row's own).
    if (autoCompact) for (const code of touched) {
      if (state().tasks[code].step_ids.length < AUTO_COMPACT_AT) continue;
      const t4 = state().tasks[code], auto = compactPlan(state(), code, COMPACT_DEFAULT_KEEP);
      if (!auto.moved.length) continue;
      w('steps.compact', code, { keep_last: COMPACT_DEFAULT_KEEP }, { expected_revision: t4.rev, origin: `auto-compact lane=${declared || taskLane(code)}` });
      compacted.push({ task: code, moved: auto.moved.length });
    }
    const attached = await attachMedia(rows);
    // `ignored` names, per row, the row-level fields this lane sent but does not own (applied: its steps; ignored: these);
    // the push is never refused for them, so a lane can always close its own step (J-05 step-owner).
    return { ok: true, count: rows.length, writes, attached, kept, untouched, ...(declared ? { lane: declared } : {}), ...(ignored.length ? { ignored } : {}), ...(compacted.length ? { compacted } : {}) };
  }

  /** Files of the predecessor media folder a row references and the task does not carry yet become attachments. */
  async function attachMedia(rows) {
    if (!mediaDir) return 0;
    let n = 0;
    for (const row of rows) {
      const names = new Set([...JSON.stringify(row).matchAll(MEDIA_REF)].map(m => m[1]));
      const have = new Set(Object.values(state().attachments).filter(a => a.task_id === row.code).map(a => a.name));
      for (const name of names) {
        const file = path.join(mediaDir, name);
        if (have.has(name) || !fs.existsSync(file)) continue;
        const size = fs.statSync(file).size;
        await board.upload(token, { request_id: `compat-media-${row.code}-${name}-${size}`.slice(0, 120), task_id: row.code, name, mime: MIME[name.split('.').pop().toLowerCase()] },
          fs.createReadStream(file), { contentLength: size });
        n++;
      }
    }
    return n;
  }

  // ---------- routing ----------
  // A direct loopback call: the predecessor's admin check (nginx always adds X-Forwarded-For).
  function isLoopbackDirect(req) { return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) && !req.headers['x-forwarded-for']; }
  const ADMIN = {
    'POST /api/admin/reply': [201, reply], 'POST /api/admin/asks': [200, setAsk], 'POST /api/admin/asks/clear': [200, clearAsks], 'POST /api/admin/asks/clear-all': [200, clearAllAsks],
    'POST /api/admin/pings/seen': [200, markSeen], 'POST /api/admin/escalate': [200, escalate], 'POST /api/admin/override': [200, setOverride], 'POST /api/admin/plans': [201, addPlan],
    'PUT /api/admin/tasks': [200, pushRows], 'POST /api/admin/close': [200, closeTask], 'PUT /api/admin/registry': [200, setRegistry],
    'PUT /api/admin/stats': [200, setStats],
    'POST /api/admin/turn': [200, turnReport]
  };

  /** Answers the predecessor's routes; returns false for any other request (the caller handles it). */
  async function handle(req, res, p, send) {
    if (req.method === 'GET' && p === '/api/state') {
      const q = new URL(req.url, 'http://local').searchParams;
      send(res, 200, legacyState(req, q.get('v') === '2', q.get('archived') === '1', q.get('status') === '1')); return true;
    }
    if (req.method === 'GET' && p === '/api/times') { send(res, 200, legacyTimes(state())); return true; }
    if (req.method === 'GET' && p === '/api/media' && !mediaDir) { send(res, 200, []); return true; }
    if (await legacyMedia.handle(req, res, p, send)) return true;
    if (!p.startsWith('/api/admin/')) return false;
    const route = ADMIN[`${req.method} ${p}`];
    if (!isLoopbackDirect(req) || !route) { req.resume(); send(res, 404, { error: 'not_found' }); return true; }
    send(res, route[0], await route[1](await readBody(req)));
    return true;
  }
  return { handle, mediaInfo };
}
