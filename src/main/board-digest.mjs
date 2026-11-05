// Board digest (T-31 board-aware, owner brief 07-10): a GET /api/v1/state body (vendor/laneboard/src/views.mjs
// boardView shape) -> a compact text block chat-brain.js injects into the system context. Pure functions, no I/O,
// no secrets — board-reader.mjs owns fetching/caching and hands the raw state in here.
//
// Shape used from the state (views.mjs): tasks[] = { id, title, status, next, current_step:{label}|null,
// last_activity_at }; attention.waiting[] = { task_id, text, since } (open asks / proposals / owner-zone steps —
// exactly "needs-owner" per PLAN-board-aware.md). Everything else in the state (messages, routing, plans, …) is
// left out on purpose: the brief asks for code/title/status/next/needs-owner/last-update only, and every extra
// field is char budget the owner's question did not ask for.
const INACTIVE_STATUS = new Set(['paused', 'closed']);
export const MAX_DIGEST_CHARS = 6000; // ~1500 tokens of mixed EN/VI text (PLAN-board-aware.md budget)
const MAX_WAITING_LINES = 20;
const MAX_TASK_LINES = 40;
const MAX_TEXT_SNIPPET = 160;

function relativeAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

const snippet = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT_SNIPPET);

function clampList(lines, max) {
  return lines.length <= max ? lines : [...lines.slice(0, max), `(+${lines.length - max} more, truncated)`];
}

/** Hard char cap on the whole digest, so one huge board never blows the token budget. */
function clampChars(text, max) {
  return text.length <= max ? text : `${text.slice(0, max - 20)}\n(…truncated)`;
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Masks every whole-word, case-insensitive occurrence of any of `names` in `text` with `mask` (CoS privacy
 * decision 07-10: by default, no client/company/person name leaves this machine toward the LLM). Pure — the
 * owner's name list itself is read from disk by board-redact.mjs, never by this module.
 * Diacritics-aware: word boundaries are `\p{L}\p{N}` (Unicode letters/numbers, incl. Vietnamese diacritics), not
 * the ASCII-only `\b`, so e.g. "Lumen" inside a Vietnamese sentence is still bounded correctly on both sides.
 * Longest names first in the alternation, so a multi-word name ("Lumen Atelier House") is masked whole before a
 * shorter name it contains ("Lumen") could eat into it and leave the rest of the client's name exposed.
 * @param {string} text
 * @param {string[]} names
 * @param {string} mask
 */
export function redactNames(text, names, mask) {
  const list = (Array.isArray(names) ? names : []).filter((n) => typeof n === 'string' && n.trim());
  if (!list.length) return text;
  const alternation = [...list].sort((a, b) => b.length - a.length).map(escapeRegex).join('|');
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternation})(?![\\p{L}\\p{N}])`, 'giu');
  return text.replace(re, mask);
}

/**
 * @param {object} state  the raw GET /api/v1/state body
 * @param {number} [nowMs]
 * @param {object} [opts]
 * @param {{names: string[], mask: string}} [opts.redact]  when present, every name in it is masked in the output
 *   text (board-reader.mjs passes this ONLY when the owner's "send client names to the AI" setting is off — the
 *   default). Absent/omitted: no redaction, unchanged from before this existed.
 * @returns {{ok: true, text: string, taskCount: number, waitingCount: number}}
 */
export function buildBoardDigest(state, nowMs = Date.now(), { redact } = {}) {
  const tasks = Array.isArray(state?.tasks) ? state.tasks : [];
  const waiting = Array.isArray(state?.attention?.waiting) ? state.attention.waiting : [];
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const needsOwner = new Set(waiting.map((w) => w.task_id));

  const waitLines = waiting.map((w) => {
    const title = byId.get(w.task_id)?.title || w.task_id;
    const age = relativeAge(nowMs - Date.parse(w.since));
    return `- [${w.task_id}] ${title}: "${snippet(w.text)}" (waiting ${age})`;
  });

  const activeTasks = tasks.filter((t) => !INACTIVE_STATUS.has(t.status));
  const taskLines = activeTasks.map((t) => {
    const next = t.next || t.current_step?.label || '-';
    const age = t.last_activity_at ? relativeAge(nowMs - Date.parse(t.last_activity_at)) : '?';
    const flag = needsOwner.has(t.id) ? ' [WAITING ON OWNER]' : '';
    return `- [${t.id}] "${t.title}" status=${t.status} next: ${snippet(next)} — last update ${age} ago${flag}`;
  });

  let text = [
    `BOARD DIGEST (Laneboard, ${tasks.length} task(s) total, ${activeTasks.length} active):`,
    '',
    `WAITING ON OWNER (${waiting.length}):`,
    ...(waitLines.length ? clampList(waitLines, MAX_WAITING_LINES) : ['(none)']),
    '',
    `ACTIVE TASKS (${activeTasks.length}):`,
    ...(taskLines.length ? clampList(taskLines, MAX_TASK_LINES) : ['(none)']),
  ].join('\n');
  // Redact BEFORE the char cap: a masked name is usually shorter than the real one, so this can only ever make
  // more real content fit, never less.
  if (redact && redact.names && redact.names.length) text = redactNames(text, redact.names, redact.mask || '[client]');

  return { ok: true, text: clampChars(text, MAX_DIGEST_CHARS), taskCount: tasks.length, waitingCount: waiting.length };
}

/** The block board-reader.mjs hands chat-brain.js instead of a digest, so "can't fetch it" is never silence
 *  (never invented either). chat-brain.js owns the bilingual system RULE that references this block; this module
 *  only ever produces the block's own text. */
export function unavailableDigestText(reason) {
  return `BOARD DIGEST: unavailable right now (${reason}). You cannot see the task board at all. If asked about `
    + 'tasks, work or status, say plainly you cannot see the board right now — never invent a task code, title, '
    + 'status or next step.';
}
