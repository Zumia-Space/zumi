// J-05 app-side task supervisor (owner 12-11: "app phải có trách nhiệm rà soát task và thúc giục ai agent đang xử lý").
// Pure functions, no I/O: the board's timer (board.sweepSupervisor, server.mjs every SUPERVISOR_SWEEP_MS) turns what they return into
// nudge.raise / nudge.clear events. A nudge is a feedback record (kind nudge) the owning lane receipts with the existing receipt; an
// unreceipted one escalates lane -> CoS -> owner after `escalateMs` AWAKE minutes (23:00-07:00 ICT does not count, and nothing is
// raised then). A receipt on any link closes the whole chain; the sweep closes a chain whose condition no longer holds.
//   R1 run gone quiet   an active step carries a run stamp, and no work was written on the task for runQuietMs since the stamp
//   R2 owner ask aging  open asks older than ownerAskMs: ALL of a sweep's hits are ONE owner nudge (one ping); each ask once per ownerAskMs
//   R3 already answered an open ask repeats the owner's own answer words on its task: ratio >= 0.5 when it was still open
//                       at ruling time, >= 0.8 when raised after the ruling (raisedAfter). Flagged to CoS, never blocked, never
//                       escalated to the owner nor listed in his digest, never re-armed after a receipt (a word matcher can be
//                       wrong). Board vocabulary (a fixed list) does not count.
//   R4 idle             guard B4's idle notice (feedback kind idle) is the level-1 message; only its escalation is added here
//   R5 dossier stale    no dossier proof (dossier.mark) since the task's last work, and that work is older than dossierStaleMs
// Every age counts from max(created, supervisorSince): turning the supervisor on starts a backlog at zero. At most maxOwnerPerSweep
// owner-level nudges per sweep (the rest come on later sweeps; the digest lists every open head). Quiet for grey/paused/closed tasks.
import { sweepNight } from './views.mjs';

const H = 3600000, MIN = 60000;
export const SUPERVISOR_DEFAULTS = Object.freeze({
  runQuietMs: 4 * H, ownerAskMs: 24 * H, dossierStaleMs: 2 * H, dossierSlackMs: 10 * MIN, escalateMs: 60 * MIN, digestHourIct: 8,
  similarity: 0.5, postAnswerSimilarity: 0.8, minShared: 5, maxOwnerPerSweep: 3, ownerBatchMs: 60 * MIN,
});
/** How often the server re-checks (well under every threshold). */
export const SUPERVISOR_SWEEP_MS = 10 * MIN;
const INACTIVE = new Set(['paused', 'closed']);
const ICT = 7 * H;
const RUN_STAMP = /\brun:([^\s@]+)@(\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:?\d\d))/g;
const short = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
/** A chain's age for the owner (digest): days once it is two days old, else age(). */
const ageLong = ms => (ms >= 48 * H ? `${Math.floor(ms / (24 * H))}d` : age(ms));
const age = ms => { const m = Math.max(0, Math.floor(ms / MIN)), h = Math.floor(m / 60); return h ? `${h}h${m % 60 ? `${m % 60}m` : ''}` : `${m}m`; };
const ictDate = ms => new Date(ms + ICT).toISOString().slice(0, 10);

/** Config: the defaults with the board's overrides (non-negative numbers only, unknown keys dropped). similarity and
 *  postAnswerSimilarity are ratios in (0, 1] with postAnswerSimilarity >= similarity (0 flags everything, > 1 nothing, a lower
 *  post-answer bar inverts option (iii)); anything else keeps both defaults, with one log line. */
export function supervisorConfig(over = {}, log = console.error) {
  const out = { ...SUPERVISOR_DEFAULTS };
  for (const k of Object.keys(out)) if (Number.isFinite(over?.[k]) && over[k] >= 0) out[k] = over[k];
  // the two R3 bars: ratios in (0, 1], and the post-answer bar at least the open one; else both defaults, one log line
  const isRatio = v => Number.isFinite(v) && v > 0 && v <= 1, keys = ['similarity', 'postAnswerSimilarity'];
  const bad = keys.filter(k => over && typeof over === 'object' && k in over && !isRatio(over[k]));
  const why = bad.length ? `${bad.map(k => `${k}=${JSON.stringify(over[k])}`).join(', ')} is not a ratio in (0, 1]`
    : out.postAnswerSimilarity < out.similarity ? `postAnswerSimilarity=${out.postAnswerSimilarity} is below similarity=${out.similarity}` : '';
  if (why) {
    log(`BOARD_SUPERVISOR ${why}: kept similarity ${SUPERVISOR_DEFAULTS.similarity}, postAnswerSimilarity ${SUPERVISOR_DEFAULTS.postAnswerSimilarity}`);
    for (const k of keys) out[k] = SUPERVISOR_DEFAULTS[k];
  }
  return out;
}
/** BOARD_SUPERVISOR (JSON) -> overrides; bad JSON is logged and the defaults hold (a typo never stops the board from booting). */
export function configFromEnv(text, log = console.error) {
  if (!text) return supervisorConfig({});
  try { return supervisorConfig(JSON.parse(text), log); } catch (e) { log(`BOARD_SUPERVISOR is not JSON (${e.message}): the supervisor keeps its defaults`); return supervisorConfig({}); }
}

/** BOARD_SUPERVISOR_SINCE -> the since value; an invalid one is OFF with a loud line (CoS: never a crash, never a PM2 restart loop). */
export function sinceFromEnv(text, log = console.error) {
  const v = String(text ?? '').trim();
  if (!v) return '';
  if (Number.isFinite(Date.parse(v))) return v;
  log(`SUPERVISOR OFF: BOARD_SUPERVISOR_SINCE="${v}" is not an ISO time (e.g. 2026-11-13T02:00:00.000Z); the board runs without the supervisor`);
  return '';
}
/** Milliseconds between `from` and `to` that fall outside the night 23:00-07:00 ICT. */
export function awakeMs(from, to) {
  let n = 0;
  for (let t = from; t < to;) {
    const dayStart = Math.floor((t + ICT) / (24 * H)) * 24 * H - ICT; // 00:00 ICT of t's day
    const a = Math.max(t, dayStart + 7 * H), b = Math.min(to, dayStart + 23 * H);
    if (b > a) n += b - a;
    t = dayStart + 24 * H;
  }
  return n;
}

// ---------- R3 matcher ----------
// STOP is matched on the ACCENTED lower-case word, before accents are folded: Vietnamese folds many words onto one spelling
// ("trả lời" is filler, "lỗi" is a fault; "tại" filler, "tải" a download; "cái"/"cài", "dùng"/"dừng"/"dựng", "chỉ"/"chi",
// "bằng"/"bảng", "đang"/"đăng"), and a folded list dropped the topic words of real re-asks (Opus review 13-11 round 2).
const STOP = new Set([
  'anh', 'em', 'cho', 'của', 'và', 'là', 'có', 'thể', 'thế', 'the', 'thì', 'này', 'khi', 'nếu', 'các', 'những', 'nhưng', 'một', 'hay',
  'hoặc', 'với', 'để', 'được', 'trong', 'không', 'chưa', 'rồi', 'gì', 'nào', 'làm', 'cần', 'tiếp', 'việc', 'nhé', 'xong', 'luôn',
  'nữa', 'mới', 'mọi', 'mỗi', 'phần', 'đi', 'trên', 'thêm', 'theo', 'sau', 'trước', 'vào', 'ra', 'lên', 'xuống', 'cũng', 'vẫn',
  'đang', 'sẽ', 'nên', 'phải', 'vậy', 'bạn', 'bản', 'task', 'and', 'for', 'with', 'not', 'are', 'you', 'this', 'that',
  // Board vocabulary (13-11, frozen): shared by any two long asks. C-54 fired on "trả lời, hiện tại, mình, dùng, thôi, sao,
  // lại"; the rest are the function syllables above 15% of the 12-11 replay corpus, as the words the board uses them in
  // ("máy" left out: "máy phụ" is topical, the T-31-ROOM true repeat needs it). Fixed: nothing drifts with the board's size or
  // with one busy task's nouns (REV-3 / REV-4).
  'trả', 'lời', 'hiện', 'tại', 'mình', 'dùng', 'thôi', 'sao', 'lại', 'giữ', 'báo', 'nói', 'thử', 'sửa', 'đầu', 'đâu', 'bằng',
  'đồng', 'dòng', 'cái', 'đặt', 'đạt', 'câu', 'chỉ', 'duyệt',
].map(w => w.normalize('NFC')));
/** Accents folded (a lane may type without them): NFD, combining marks dropped, đ -> d. */
const fold = w => w.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd');
/** Folds that are ALSO topic words (lỗi, tải, cài, dừng/dựng, chi, bảng, đăng, and the plain ban (ban nhạc, ban đầu) and thu
 *  (thu tiền)): typed without accents they stay words. */
const TOPIC_FOLDS = new Set(['loi', 'tai', 'cai', 'dung', 'chi', 'bang', 'dang', 'ban', 'thu']);
/** STOP as a lane types it without accents ("tra loi hien tai minh thoi"), minus TOPIC_FOLDS: applied to unaccented tokens only. */
const FOLDED_STOP = new Set([...STOP].map(fold).filter(w => !TOPIC_FOLDS.has(w)));
/** A text's words for R3: lower-case NFC tokens off STOP (accented), then folded; a token typed without accents is also checked
 *  against FOLDED_STOP; 3+ letters or digits. */
const words = s => {
  const out = new Set();
  for (const t of String(s ?? '').normalize('NFC').toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (STOP.has(t)) continue;
    const f = fold(t);
    if (/^[a-z0-9]{3,}$/.test(f) && !(f === t && FOLDED_STOP.has(f))) out.add(f);
  }
  return out;
};
const RULING = /\banh\s*:\s*(.+)$/is;
/** How much of the owner's answer an ask repeats: { shared, ratio }, ratio = shared words / the smaller word set. */
export function similarAsk(askText, rulingText) {
  const { shared, exact } = overlap(askText, rulingText);
  return { shared, ratio: Math.round(exact * 100) / 100 };
}
/** The unrounded overlap: { shared, exact }. The bars compare `exact` (35/44 = 0.7955 is below 0.8); `ratio` is for display. */
function overlap(askText, rulingText) {
  const a = words(askText), r = words(rulingText);
  const shared = [...r].filter(w => a.has(w)).length, base = Math.min(a.size, r.size);
  return { shared, exact: base ? shared / base : 0 };
}
/** A question back ("C-54 hay C-56 ??") rules nothing. */
const isQuestion = s => /\?\s*["”']?\s*$/.test(String(s ?? '').trim()) || /\?\?/.test(String(s ?? ''));
/** True when the ask repeats the owner's answer words (R3): ratio >= `similarity` (default cfg.similarity) and minShared words. */
export function repeatsRuling(askText, answerText, cfg = SUPERVISOR_DEFAULTS, similarity = cfg.similarity) {
  if (isQuestion(answerText)) return false;
  const m = overlap(askText, answerText);
  return m.exact >= similarity && m.shared >= cfg.minShared;
}
/**
 * R3 bar by timing (CoS 13-11, option (iii)). An ask still open when the owner ruled (answered elsewhere, or a duplicate of the
 * question he answered: T-31-ROOM 11-11) repeats the ruling at ratio >= `similarity` (0.5). An ask raised AFTER the ruling must
 * reach `postAnswerSimilarity` (0.8): the ask record names no earlier ask, so a lane building on the answer and a lane asking
 * the owner twice differ only in how much of his answer comes back. The 13-11 live false pairs (L-01-BAND / L-01-COURT present
 * the work the answer asked for; C-54 / V-04 moved on) sit at <= 0.59; a near word-for-word re-ask sits above 0.8 (REV-1 0.91,
 * REV-2 0.83). minShared applies to both.
 */
export function raisedAfter(ask, ruling) {
  return (Date.parse(ask.attribution?.created_at) || 0) > (Date.parse(ruling.at) || 0);
}
/** The ruling an open ask repeats (the closest one) as { r, m }, or null. */
export function repeatedRuling(state, ask, cfg = SUPERVISOR_DEFAULTS) {
  const bar = r => (raisedAfter(ask, r) ? cfg.postAnswerSimilarity : cfg.similarity);
  return rulingsOf(state, ask.task_id).filter(r => r.id !== ask.id && repeatsRuling(ask.text, r.text, cfg, bar(r)))
    .map(r => ({ r, m: similarAsk(ask.text, r.text) })).sort((x, y) => y.m.ratio - x.m.ratio)[0] || null;
}
/** The owner's rulings on a task, the OWNER'S WORDS only: answered asks (the answer text, not the question; never an asked-back
 *  ask) and done owner steps whose sub records "anh: …" (the part after it). */
export function rulingsOf(state, taskId) {
  const out = [];
  for (const a of Object.values(state.asks || {})) if (a.task_id === taskId && a.status === 'answered' && a.answer?.text && !a.asked_back)
    out.push({ kind: 'ask', id: a.id, at: a.answer.at, text: a.answer.text });
  for (const id of state.tasks[taskId]?.step_ids || []) {
    const s = state.steps[`${taskId}/${id}`], m = RULING.exec(s?.sub || '');
    if (s && s.state === 'done' && s.zone === 'owner' && m) out.push({ kind: 'step', id, at: s.state_at, text: m[1] });
  }
  return out.filter(r => !isQuestion(r.text));
}

// ---------- shared ----------
const live = t => t && !INACTIVE.has(t.status) && t.health !== 'grey';
const stepsOf = (state, t) => (t.step_ids || []).map(id => state.steps[`${t.id}/${id}`]).filter(Boolean);
const seen = (state, key) => !!state.supervisor?.keys?.[key];
const createdMs = f => Date.parse(f.attribution?.created_at) || 0;
const isNotice = f => (f.kind === 'nudge' && f.rule !== 'digest' && !f.info) || f.kind === 'idle';
const ruleOf = f => (f.kind === 'idle' ? 'R4' : f.rule);
const levelOf = f => (f.kind === 'idle' ? 1 : f.level);
/** The first link of an escalation chain. */
export function rootOf(state, f) { let r = f; for (let i = 0; i < 5 && r?.escalated_from; i++) r = state.feedback[r.escalated_from] || r; return r; }
/** Every link of f's chain, root first. */
export function chainOf(state, f) {
  const out = []; let r = rootOf(state, f);
  for (let i = 0; i < 5 && r; i++) { out.push(r); r = r.escalated_to ? state.feedback[r.escalated_to] : null; }
  return out;
}
/** Open notice keys (task|rule|step|ask), indexed once per sweep. */
const openIndex = state => new Set(Object.values(state.feedback || {}).filter(f => f.kind === 'nudge' && f.status === 'open')
  .map(f => `${f.task_id}|${f.rule}|${f.step_id || ''}|${f.ask_id || ''}`));
const latestStamp = s => [...String(s?.sub || '').matchAll(RUN_STAMP)].map(m => ({ at: Date.parse(m[2]), raw: m[0] })).filter(x => x.at).sort((x, y) => y.at - x.at)[0];

/**
 * Still true? For a chain's root: R1 the stamped step still active with no newer work or stamp; R2 one of its asks still open;
 * R3 the ask still open and still repeating a ruling (the rule as it reads now); R4 the idle notice still open; R5 no dossier proof since the task's last work.
 */
export function stillHolds(state, f, cfg = SUPERVISOR_DEFAULTS) {
  const root = rootOf(state, f), t = state.tasks[root.task_id], rule = ruleOf(root);
  if (rule === 'R2') return (root.ask_ids || []).some(id => state.asks[id]?.status === 'open');
  if (!t || !live(t)) return false;
  const work = Date.parse(state.activity?.[t.id]) || 0, opened = createdMs(root);
  if (rule === 'R1') { const s = state.steps[`${t.id}/${root.step_id}`], st = latestStamp(s); return !!s && s.state === 'active' && work <= opened && (!st || st.at <= opened); }
  if (rule === 'R3') { const a = state.asks[root.ask_id]; return a?.status === 'open' && !!repeatedRuling(state, a, cfg); }
  if (rule === 'R4') return root.status === 'open';
  if (rule === 'R5') return !((Date.parse(t.dossier_at) || 0) >= work - cfg.dossierSlackMs);
  return true;
}
/** Chains to close now: every open chain whose condition no longer holds. Each: { key, head, ids }. */
export function clearCandidates(state, cfg = SUPERVISOR_DEFAULTS) {
  const out = [], done = new Set();
  for (const f of Object.values(state.feedback || {})) {
    if (f.kind !== 'nudge' || f.status !== 'open' || f.info || f.rule === 'digest') continue;
    const chain = chainOf(state, f), head = chain.at(-1);
    if (done.has(head.id)) continue;
    done.add(head.id);
    if (stillHolds(state, f, cfg)) continue;
    const ids = chain.filter(x => x.kind === 'nudge' && x.status === 'open').map(x => x.id);
    if (ids.length) out.push({ key: `clear:${head.id}`, head: head.id, task_id: chain[0].task_id, ids });
  }
  return out;
}

/** New nudges at nowMs (night: none). Each: { key, task_id, rule, level, lane, text, step_id?, ask_id?, ask_ids?, also_keys? }. */
export function nudgeCandidates(state, nowMs, cfg = SUPERVISOR_DEFAULTS, sinceMs = 0) {
  if (sweepNight(nowMs)) return [];
  const open = openIndex(state), out = [];
  // CoS K = BATCH: at most one owner R2 list per ownerBatchMs; an ask overdue meanwhile waits for the next list
  const lastList = Math.max(0, ...Object.values(state.feedback || {}).filter(f => f.kind === 'nudge' && f.rule === 'R2').map(createdMs));
  const batchOpen = nowMs - lastList >= cfg.ownerBatchMs;
  const add = n => { const k = `${n.task_id}|${n.rule}|${n.step_id || ''}|${n.ask_id || ''}`; if (!seen(state, n.key) && !open.has(k)) { open.add(k); out.push(n); } };
  const r2 = [];
  for (const t of Object.values(state.tasks || {})) {
    if (!live(t)) continue;
    const steps = stepsOf(state, t), lastWork = Date.parse(state.activity?.[t.id]) || 0;
    // R1
    for (const s of steps.filter(x => x.state === 'active')) {
      const run = latestStamp(s);
      if (!run) continue;
      const quiet = nowMs - Math.max(run.at, lastWork, sinceMs);
      if (quiet < cfg.runQuietMs) continue;
      const sid = s.id.slice(t.id.length + 1);
      add({ key: `R1:${s.id}:${run.raw}`, task_id: t.id, step_id: sid, rule: 'R1', level: 1, lane: s.lane || t.lane || 'CoS',
        text: `[R1] ${t.id}/${sid}: ${run.raw}, no report for ${age(nowMs - Math.max(run.at, lastWork))}. Report or park now (receipt: Đổi / Lịch / Bước tiếp).` });
    }
    const asks = Object.values(state.asks || {}).filter(a => a.task_id === t.id && a.status === 'open');
    // R2 (collected; one nudge below)
    for (const a of asks) {
      const opened = createdMs(a); if (!opened) continue;
      const open2 = nowMs - Math.max(opened, sinceMs);
      if (open2 < cfg.ownerAskMs) continue;
      const k = `R2a:${a.id}:${Math.floor(open2 / cfg.ownerAskMs)}`;
      if (batchOpen && !seen(state, k)) // each ask once per ownerAskMs: still open a day later = listed again
        r2.push({ k, a, t, age: nowMs - opened });
    }
    // R3
    for (const a of asks) {
      const hit = repeatedRuling(state, a, cfg);
      if (!hit) continue;
      add({ key: `R3:${a.id}`, task_id: t.id, ask_id: a.id, rule: 'R3', level: 2, lane: 'CoS',
        text: `[R3] Đã trả lời? ${t.id} ask ${a.id} lặp lại quyết định ${hit.r.kind} ${hit.r.id} (${String(hit.r.at || '').slice(0, 10)}, ${hit.m.shared} từ trùng): "${short(hit.r.text, 160)}". Kiểm trước khi chờ anh.` });
    }
    // R5
    const dossierAt = Date.parse(t.dossier_at) || 0;
    if (dossierAt && lastWork - dossierAt > cfg.dossierSlackMs && nowMs - Math.max(lastWork, sinceMs) >= cfg.dossierStaleMs)
      add({ key: `R5:${t.id}:${state.activity[t.id]}`, task_id: t.id, rule: 'R5', level: 1, lane: t.lane || 'CoS',
        text: `[R5] ${t.id}: dossier last ${t.dossier_at}, task changed ${state.activity[t.id]}. Write the dossier log / push its STATUS.` });
  }
  if (r2.length) {
    r2.sort((x, y) => y.age - x.age);
    const list = r2.map(x => `${x.t.id} · ${age(x.age)} · ${short(x.a.text, 90)}`);
    out.push({ key: `R2:${nowMs}`, task_id: '*', rule: 'R2', level: 3, lane: 'owner', ask_ids: r2.map(x => x.a.id), also_keys: r2.map(x => x.k),
      text: short(`[R2] ${r2.length} câu chờ anh >${age(cfg.ownerAskMs)}: ${list.join(' | ')}`, 7900) });
  }
  return out;
}

const LEVEL_LANE = { 2: 'CoS', 3: 'owner' };
/** The level f escalated to is still open: that level speaks for the chain. Once it is closed (the owner's Đã nhận on L3, a CoS
 *  receipt on L2) while f stays open (J = BLOCK), f is the chain's head again: shown and digested (it never escalates again;
 *  rearmCandidates re-nudges the lane instead). */
const upOpen = (state, f) => !!f.escalated_to && state.feedback[f.escalated_to]?.status === 'open';
/** The ids the board filed as a re-nudge (key rearm:…): a chain holding one is capped at CoS (L2) and never pings the owner. */
const rearmIds = state => new Set(Object.entries(state.supervisor?.keys || {}).filter(([k]) => k.startsWith('rearm:')).map(([, id]) => id));
/** Escalations: the head of an open, unreceipted chain below its cap (R3 and a re-armed chain stop at 2, the rest at 3) whose
 *  condition still holds and whose awake age since max(created, SINCE) reached escalateMs. */
export function escalationCandidates(state, nowMs, cfg = SUPERVISOR_DEFAULTS, sinceMs = 0) {
  if (sweepNight(nowMs)) return [];
  const out = [], rearmed = rearmIds(state);
  for (const f of Object.values(state.feedback || {})) {
    if (!isNotice(f) || f.status !== 'open' || f.received || f.escalated_to || f.task_id === '*') continue;
    const level = levelOf(f), rule = ruleOf(f), cap = rule === 'R3' || chainOf(state, f).some(x => rearmed.has(x.id)) ? 2 : 3;
    if (level >= cap || !live(state.tasks[f.task_id]) || !stillHolds(state, f, cfg)) continue;
    const awake = awakeMs(Math.max(createdMs(f), sinceMs), nowMs);
    if (awake < cfg.escalateMs || seen(state, `esc:${f.id}`)) continue;
    const next = level + 1;
    out.push({ key: `esc:${f.id}`, task_id: f.task_id, rule, level: next, lane: LEVEL_LANE[next], escalated_from: f.id,
      ...(f.step_id ? { step_id: f.step_id } : {}), ...(f.ask_id ? { ask_id: f.ask_id } : {}),
      text: `[${rule}→L${next}] Chưa nhận sau ${age(awake)}: ${short(f.text, 300)}` });
  }
  return out.sort((x, y) => x.key.localeCompare(y.key));
}

/** Grace before a closed chain is re-armed: the interval that files the rule's first level (R1 runQuietMs, R5 dossierStaleMs);
 *  escalateMs for R4 (R2 and R3 are never re-armed). No knob of its own. */
const rearmGraceMs = (rule, cfg) => ({ R1: cfg.runQuietMs, R5: cfg.dossierStaleMs })[rule] ?? cfg.escalateMs;
/**
 * Re-nudges DOWNWARD (Opus R2 option b): a chain whose last link was closed by a person (a receipt, or the owner's Đã nhận)
 * while its condition still holds, with no work since, gets a fresh nudge at its first level to the lane that owns it once the
 * grace has passed (awake time from that close). Lịch is free text, so nothing else would wake it. The re-nudge is linked to
 * the chain's FIRST nudge (one chain per issue, never longer than root + L1 + L2) and the open links of the round before it are
 * closed as superseded (`supersede`, bookkeeping, no activity): at most one open nudge per level. It climbs to CoS on the
 * normal timer and stops there: no owner level, no owner ping; the owner hears about the chain through the digest, with the
 * chain's age. One re-nudge per close (key rearm:<root>:<closed link>).
 * Never re-armed: R2 (the owner's own list) and R3 (Opus R4 13-11): R3 asks CoS to check an ask before anyone waits on the
 * owner; once CoS receipted it the check is done and the ask text cannot change by itself, so a re-nudge would only nag (a
 * report quoting the ruling, the known cost of option (iii), re-armed every hour). A NEW ask (another id) is a new R3 key.
 */
const NO_REARM = new Set(['R2', 'R3']);
export function rearmCandidates(state, nowMs, cfg = SUPERVISOR_DEFAULTS, sinceMs = 0) {
  if (sweepNight(nowMs)) return [];
  const out = [], issue = f => `${f.task_id}|${ruleOf(f)}|${f.step_id || ''}|${f.ask_id || ''}`;
  const openNudges = Object.values(state.feedback || {}).filter(f => f.kind === 'nudge' && f.status === 'open');
  for (const root of Object.values(state.feedback || {})) {
    if (!isNotice(root) || root.escalated_from || root.task_id === '*' || NO_REARM.has(ruleOf(root))) continue;
    const chain = chainOf(state, root), tail = chain.at(-1);
    if (tail.status === 'open' || tail.cleared || !tail.resolved || !live(state.tasks[root.task_id]) || !stillHolds(state, root, cfg)) continue;
    const ids = new Set(chain.map(x => x.id)); // a newer chain on the same issue already speaks for it
    if (openNudges.some(f => !ids.has(f.id) && issue(f) === issue(root))) continue;
    const key = `rearm:${root.id}:${tail.id}`, rule = ruleOf(root);
    const awake = awakeMs(Math.max(Date.parse(tail.resolved.at) || 0, sinceMs), nowMs);
    if (awake < rearmGraceMs(rule, cfg) || seen(state, key)) continue;
    const level = levelOf(root), supersede = chain.filter(x => x.kind === 'nudge' && x.status === 'open').map(x => x.id);
    out.push({ key, task_id: root.task_id, rule, level, lane: root.kind === 'idle' ? state.tasks[root.task_id]?.lane || 'CoS' : root.lane, escalated_from: root.id,
      ...(supersede.length ? { supersede } : {}),
      ...(root.step_id ? { step_id: root.step_id } : {}), ...(root.ask_id ? { ask_id: root.ask_id } : {}),
      text: `[${rule}↻L${level}] Vẫn chưa có tiến triển ${age(awake)} sau khi đã nhận: ${short(root.text, 300)}` });
  }
  return out.sort((x, y) => x.key.localeCompare(y.key));
}

/** Open chain heads (one line per issue): what the strip and the digest show. */
export function openHeads(state) {
  return Object.values(state.feedback || {}).filter(f => isNotice(f) && f.status === 'open' && !upOpen(state, f))
    .sort((a, b) => levelOf(b) - levelOf(a) || createdMs(a) - createdMs(b));
}

/** Daily digests at digestHourIct (ICT): one per lane with open chain heads, one for the owner; a notice (info), never an item.
 *  A head goes to its own lane, to the lane that owns its chain (the root's: the agent doing the work, e.g. while a re-armed
 *  chain waits at CoS) and to the owner, each line with the chain's age. R3 is CoS-only: never in the owner's digest. */
export function digestCandidates(state, nowMs, cfg = SUPERVISOR_DEFAULTS) {
  if (sweepNight(nowMs) || new Date(nowMs + ICT).getUTCHours() < cfg.digestHourIct) return [];
  const day = ictDate(nowMs), lanes = new Map();
  for (const f of openHeads(state)) {
    const laneOf = x => (x.kind === 'idle' ? state.tasks[x.task_id]?.lane || 'CoS' : x.lane);
    for (const l of new Set([laneOf(f), laneOf(rootOf(state, f)), ...(ruleOf(f) === 'R3' ? [] : ['owner'])])) lanes.set(l, [...(lanes.get(l) || []), f]);
  }
  const out = [];
  for (const [lane, list] of lanes) {
    const key = `digest:${lane}:${day}`;
    if (seen(state, key)) continue;
    const lines = list.map(f => `${f.task_id} · ${ruleOf(f)} · level ${levelOf(f)} · ${ageLong(nowMs - createdMs(rootOf(state, f)))}`); // the chain's age, not the latest re-nudge's
    out.push({ key, task_id: '*', rule: 'digest', level: 1, lane, info: true, text: short(`[digest] ${day} ${lane}: ${list.length} open · ${lines.join(' | ')}`, 7900) });
  }
  return out;
}

/** One sweep's work, in order: closes, then new nudges and escalations (owner level capped at maxOwnerPerSweep), then digests. */
export function sweepPlan(state, nowMs, cfg = SUPERVISOR_DEFAULTS, sinceMs = 0) {
  const clears = clearCandidates(state, cfg);
  // what the closes are about to resolve must not escalate in the same sweep
  const closing = new Set(clears.flatMap(c => c.ids));
  let owner = 0;
  const fresh = nudgeCandidates(state, nowMs, cfg, sinceMs), issue = n => `${n.task_id}|${n.rule}|${n.step_id || ''}|${n.ask_id || ''}`, freshKeys = new Set(fresh.map(issue));
  const rearm = rearmCandidates(state, nowMs, cfg, sinceMs).filter(r => !freshKeys.has(issue(r)) && !r.supersede?.some(id => closing.has(id))); // a new nudge or a close on the same issue wins
  // a re-nudge first closes the open links it supersedes (same sweep, before it is raised); they do not escalate either
  for (const { key, task_id, supersede } of rearm) if (supersede) { clears.push({ key: `supersede:${key}`, head: supersede.at(-1), task_id, ids: supersede, reason: 'superseded' }); for (const id of supersede) closing.add(id); }
  const raise = [...fresh, ...escalationCandidates(state, nowMs, cfg, sinceMs).filter(e => !closing.has(e.escalated_from)), ...rearm.map(({ supersede, ...r }) => r)]
    .filter(n => n.level < 3 || ++owner <= cfg.maxOwnerPerSweep);
  return { clears, raise, digests: digestCandidates(state, nowMs, cfg) };
}

/** Metrics derived from the feedback records (replayable): per rule and per lane sent / receipted / escalated, totals, time to receipt.
 *  Only what was filed from sinceMs on: idle notices from before the supervisor was on are history, not its work. */
export function supervisorMetrics(state, sinceMs = 0) {
  const by_rule = {}, by_lane = {}, total = { sent: 0, receipted: 0, escalated: 0 }, ttr = [];
  for (const f of Object.values(state.feedback || {})) {
    if (!isNotice(f) || createdMs(f) < sinceMs) continue; // an idle notice is R4's level-1 nudge
    const rule = ruleOf(f), lane = f.kind === 'idle' ? state.tasks[f.task_id]?.lane || '-' : f.lane;
    for (const m of [by_rule[rule] ??= { sent: 0, receipted: 0, escalated: 0 }, by_lane[lane] ??= { sent: 0, receipted: 0, escalated: 0 }, total]) {
      m.sent++; if (f.received) m.receipted++; if (f.escalated_to) m.escalated++;
    }
    if (f.received) ttr.push(Date.parse(f.received.at) - createdMs(f));
  }
  ttr.sort((a, b) => a - b);
  return { by_rule, by_lane, total, time_to_receipt_ms: { n: ttr.length, p50: ttr.length ? ttr[Math.floor((ttr.length - 1) / 2)] : null, max: ttr.length ? ttr.at(-1) : null } };
}
