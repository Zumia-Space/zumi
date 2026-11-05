// Read-only host calls for the Brain panel (T-31 slice 3a-3, GATE-SEC-3a-3 C1-C10, nits N1-N3). No write, no new upstream
// route, no credential in a return value, no path or URL in a log line. Both hosts (Electron main, Tauri sidecar) import this
// file unchanged; it has no `electron` import and no default transport.
import { extractRefs } from './hud-feed.mjs';   // the HUD's own parser: H1 must not use a second one
import { safeOrigin } from './refusal-log.mjs'; // scheme://host only: the one rule for what an origin in a refusal line may hold

// C1: the only top-level keys Brain reads. Adding a key needs a CoS gate line. Never: notify, me, routing, route_override, roles,
// inbox, messages, feedback, pings, freshness, stale_text, turns, config, watcher_at, docs.
export const BRAIN_STATE_KEYS = Object.freeze(['version', 'seq', 'now', 'tasks', 'asks', 'attachments', 'times', 'task_times', 'goals', 'plans', 'attention']);
// N3: the only fields of one task / one step that Brain renders (library row, detail, the two diagrams). Never: attribution, worker,
// worker_default, roles, loops, gate_fails, measured, status_request, visibility, rev, order, step_ids, text_at.
export const BRAIN_TASK_KEYS = Object.freeze(['id', 'title', 'lane', 'health', 'status', 'goal', 'now', 'next', 'context', 'dossier', 'architecture', 'steps', 'current_step', 'last_activity_at']);
export const BRAIN_STEP_KEYS = Object.freeze(['id', 'label', 'sub', 'detail', 'state', 'zone']);
export const STATE_MAX_BYTES = 4 * 1024 * 1024;          // C2: under Tauri's 16 MB response frame
export const MEDIA_WIDTHS = Object.freeze([480, 1600]);
export const MEDIA_MAX_BYTES = 5 * 1024 * 1024;
export const MEDIA_MAX_INFLIGHT = 4;                      // C5
export const MEDIA_MAX_PER_MIN = 120;                     // C5
export const OPEN_MAX_PER_MIN = 10;                       // C6
export const OPEN_MIN_GAP_MS = 1000;                      // C6
const MAX_REF_TARGET = 2048;
const WINDOW_MS = 60_000;
const FETCH_TIMEOUT_MS = 15_000;
const ATT_ID = /^att-\d{1,12}$/;                        // never a path, never "att-1/../state"
const REASON = /^[a-z0-9_]{1,32}$/;
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);   // no svg, pdf, video, audio
const SIGNATURE = {                                       // the bytes must be what the content-type says
  'image/png': (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  'image/jpeg': (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/gif': (b) => b.subarray(0, 4).toString('latin1') === 'GIF8',
  'image/webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
};

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v : []);
const pick = (src, keys) => { const out = {}; for (const k of keys) if (has(src, k)) out[k] = src[k]; return out; };

/** One task: the BRAIN_TASK_KEYS, each value the same reference as on the board; steps and current_step are picked the same way. */
function projectTask(t) {
  if (!isObj(t)) return t;
  const out = pick(t, BRAIN_TASK_KEYS);
  if (Array.isArray(t.steps)) out.steps = t.steps.map((s) => (isObj(s) ? pick(s, BRAIN_STEP_KEYS) : s));
  if (isObj(t.current_step)) out.current_step = pick(t.current_step, ['id']);
  return out;
}

/** C1 + N3: shallow pick of the 11 top-level keys; tasks[] picked down to what Brain renders. Same value references as the cached object. */
function project(full) {
  const out = pick(full, BRAIN_STATE_KEYS);
  if (Array.isArray(out.tasks)) out.tasks = out.tasks.map(projectTask);
  return out;
}

const refKey = (kind, target) => `${kind}\u0000${target}`;

/** C9 (a)+(b): every ref the HUD's parser finds in the projected text fields, plus each dossier as kind 'local'. */
function collectCitedRefs(view) {
  const keys = new Set();
  const take = (text) => { if (typeof text === 'string' && text) for (const r of extractRefs(text)) keys.add(refKey(r.kind, r.target)); };
  for (const t of arr(view.tasks)) {
    if (!isObj(t)) continue;
    for (const f of ['goal', 'now', 'next', 'context']) take(t[f]);
    if (typeof t.dossier === 'string' && t.dossier) keys.add(refKey('local', t.dossier));
    for (const s of arr(t.steps)) if (isObj(s)) for (const f of ['label', 'sub', 'detail']) take(s[f]);
  }
  for (const a of arr(view.asks)) if (isObj(a)) take(a.text);
  for (const w of arr(isObj(view.attention) ? view.attention.waiting : null)) if (isObj(w)) take(w.text);   // same ask text, as the HUD feed reads it
  if (isObj(view.plans)) for (const list of Object.values(view.plans)) for (const p of arr(list)) if (isObj(p)) take(p.body);
  return keys;
}

/** At most `max` takes per rolling WINDOW_MS. */
function rollingWindow(max, now) {
  const hits = [];
  return { tryTake() {
    const t = now();
    while (hits.length && t - hits[0] >= WINDOW_MS) hits.shift();
    if (hits.length >= max) return false;
    hits.push(t);
    return true;
  } };
}

/**
 * @param {object} o
 * @param {{getState(): Promise<{ok:boolean,state?:object,reason?:string}>}} o.boardReader  the SAME reader chat and the HUD use
 * @param {{status(): object, bridgePort(): Promise<number|null>, bridgeHeaders(): Promise<object>}} o.liveBoard
 * @param {typeof fetch} o.fetchImpl  REQUIRED, no default (C10). Electron: global fetch. Sidecar: bridgeMediaFetch(...)
 * @param {(ref:{kind:string,target:string}) => object} o.decide  board-open.mjs decideOpenRef bound to this build's ownerAdmin
 * @param {(decision:object) => Promise<void>} o.open             host opener; Tauri public flavour passes one that throws 'open_unavailable'
 * @param {(r:{reason:string, origin?:string}) => void} [o.logRefusal]  refusal-log.mjs appendRefusal seam: reason + origin only
 * @param {(line:string) => void} [o.log]
 * @param {() => number} [o.now]
 */
export function createBoardReads({ boardReader, liveBoard, fetchImpl, decide, open, logRefusal = () => {}, log = () => {}, now = Date.now }) {
  if (typeof fetchImpl !== 'function') throw new TypeError('createBoardReads: fetchImpl is required');
  if (typeof decide !== 'function' || typeof open !== 'function') throw new TypeError('createBoardReads: decide and open are required');

  const memo = new WeakMap();   // reader's cached state object -> { view, bytes, refs }: projected + measured once per cache fill (C1, C2)

  /** One read of the shared reader. No argument ever reaches getState (C3). */
  async function snapshot() {
    let r;
    try { r = await boardReader.getState(); } catch { log('state read failed'); return { ok: false, reason: 'offline' }; }
    if (!r || !r.ok) return { ok: false, reason: REASON.test(String(r && r.reason)) ? r.reason : 'offline' };
    if (!isObj(r.state)) return { ok: false, reason: 'bad_state' };
    let e = memo.get(r.state);
    if (!e) {
      const view = project(r.state);
      e = { view, bytes: Buffer.byteLength(JSON.stringify(view)), refs: null };
      memo.set(r.state, e);
      if (e.bytes > STATE_MAX_BYTES) log(`state refused too_large ${e.bytes}`);   // once per cached object
    }
    return e.bytes > STATE_MAX_BYTES ? { ok: false, reason: 'too_large' } : { ok: true, entry: e };
  }

  /** board.state(): { ok:true, state: <11-key projection> } | { ok:false, reason }. Takes NO argument. */
  async function state() {
    const s = await snapshot();
    return s.ok ? { ok: true, state: s.entry.view } : { ok: false, reason: s.reason };
  }

  // ---------------- media ----------------
  const mediaWindow = rollingWindow(MEDIA_MAX_PER_MIN, now);
  let mediaInflight = 0;
  // C8: the reason word, plus the id only after it matched ATT_ID. Never a URL, port, header or path.
  const mediaRefuse = (reason, id) => { log(`media refused ${reason}${id ? ` ${id}` : ''}`); return { ok: false, reason }; };

  /** board.media(id, { w }): { ok:true, mime, bytes } | { ok:false, reason }. Image attachments of the cached state only. */
  async function media(id, opts) {
    if (typeof id !== 'string' || !ATT_ID.test(id)) return mediaRefuse('bad_id');
    const w = isObj(opts) && opts.w !== undefined ? opts.w : 480;
    if (!MEDIA_WIDTHS.includes(w)) return mediaRefuse('bad_width', id);
    if (!mediaWindow.tryTake()) return mediaRefuse('rate_limited', id);
    if (mediaInflight >= MEDIA_MAX_INFLIGHT) return mediaRefuse('busy', id);
    mediaInflight++;
    try { return await fetchMedia(id, w); } finally { mediaInflight--; }
  }

  async function fetchMedia(id, w) {
    const s = await snapshot();
    if (!s.ok) return mediaRefuse(s.reason, id);
    const att = arr(s.entry.view.attachments).find((a) => isObj(a) && a.id === id);
    if (!att) return mediaRefuse('unknown_attachment', id);       // refused BEFORE any request: nothing reaches the bridge
    if (!IMAGE_MIMES.has(att.mime)) return mediaRefuse('not_image', id);
    const st = liveBoard.status();                                  // same order and reasons as board-reader.mjs fetchFromBridge
    if (!st.configured) return mediaRefuse('unconfigured', id);
    if (st.locked) return mediaRefuse('locked', id);
    if (st.authRejected) return mediaRefuse('auth_rejected', id);
    if (st.mode !== 'live') return mediaRefuse('not_live', id);     // mirror mode adds no new source (gate F9)
    // C7: one controller; the 15 s timer and every refusal below abort it, which also cancels the body stream.
    const ac = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ac.abort(); }, FETCH_TIMEOUT_MS);
    const refuse = (reason) => { ac.abort(); return mediaRefuse(reason, id); };
    try {
      let res;
      try {
        const port = await liveBoard.bridgePort();
        if (!port) return refuse('not_live');
        res = await fetchImpl(`http://127.0.0.1:${port}/api/v1/media/${id}?w=${w}`, { headers: await liveBoard.bridgeHeaders(), redirect: 'manual', signal: ac.signal });
      } catch { return refuse(timedOut ? 'timeout' : 'offline'); }
      if (res.status !== 200) return refuse(`http_${Number(res.status) || 0}`);
      const mime = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (!IMAGE_MIMES.has(mime)) return refuse('not_image');
      if (Number(res.headers.get('content-length')) > MEDIA_MAX_BYTES) return refuse('too_large');
      const chunks = []; let total = 0;
      try {
        for await (const c of res.body) { total += c.length; if (total > MEDIA_MAX_BYTES) return refuse('too_large'); chunks.push(c); }
      } catch { return refuse(timedOut ? 'timeout' : 'offline'); }
      const bytes = Buffer.concat(chunks);
      if (!SIGNATURE[mime](bytes)) return refuse('bad_image');
      return { ok: true, mime, bytes };
    } finally { clearTimeout(timer); }
  }

  // ---------------- open ----------------
  const openWindow = rollingWindow(OPEN_MAX_PER_MIN, now);
  let openInflight = false;
  let lastOpenAt = -Infinity;
  // C8: the ONLY exit for a refusal. refusal-log.mjs keeps reason + scheme://host; d.path / d.ext / e.message never pass.
  const openRefuse = (reason, origin) => { logRefusal(origin ? { reason, origin: safeOrigin(origin) } : { reason }); return { opened: false, reason }; };

  /** board.openRef({kind,target}): { opened:true } | { opened:false, reason }. */
  async function openRef(ref) {
    if (!isObj(ref) || (ref.kind !== 'local' && ref.kind !== 'url') || typeof ref.target !== 'string' || !ref.target || ref.target.length > MAX_REF_TARGET) return openRefuse('bad_request');
    const origin = ref.kind === 'url' ? ref.target : undefined;
    const t = now();
    if (openInflight || t - lastOpenAt < OPEN_MIN_GAP_MS || !openWindow.tryTake()) return openRefuse('rate_limited', origin);   // C6
    lastOpenAt = t;
    openInflight = true;
    try {
      const s = await snapshot();
      if (!s.ok) return openRefuse(s.reason, origin);                                    // no board data: nothing is "on the board"
      if (!s.entry.refs) s.entry.refs = collectCitedRefs(s.entry.view);                  // once per cached state
      if (!s.entry.refs.has(refKey(ref.kind, ref.target))) return openRefuse('not_on_board', origin);   // C9 H1, exact match, BEFORE any file-system touch
      let d;
      try { d = decide({ kind: ref.kind, target: ref.target }); } catch { return openRefuse('bad_request', origin); }   // OPEN_ROOTS + OPEN_EXT + name tricks + junctions, unchanged
      if (!d || d.action === 'refuse') return openRefuse(d && /^[a-z_]{1,40}$/.test(String(d.reason)) ? d.reason : 'bad_request', d && d.origin);
      try { await open(d); } catch (e) { return openRefuse(e && e.message === 'open_unavailable' ? 'open_unavailable' : 'open_failed'); }   // fixed words only: the shell's error text can name the path
      return { opened: true };
    } finally { openInflight = false; }
  }

  return { state, media, openRef };
}
