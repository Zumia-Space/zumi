// Pure panel logic (T-31 hud-panels, PLAN section 6): which task the panel follows, whether Zumi is working on it, the
// counters, the two text fixes (a static log tail and a NOW line cut on a word boundary), the 7-day chart buckets and the
// segmented-ring paths. No DOM, no clock of its own (the caller passes `nowMs`/`fits`), no import from main, so
// scripts/check-hud-panels.mjs runs it under plain Node. src/renderer/hud/panels.js only paints what these return.
import { WORK_IDLE_MS } from './work-signal.js';

export const ELLIPSIS = '…';

/**
 * The task the panel follows: the update the last reaction was about, else the first one with a running step, else the
 * first row, else null (the panel hides). `updates` is a hud:feed row list (src/main/hud-feed.mjs).
 */
export function focusTask(updates, lastPrimary) {
  const list = Array.isArray(updates) ? updates.filter((u) => u && typeof u === 'object') : [];
  if (!list.length) return null;
  if (lastPrimary) {
    const hit = list.find((u) => u.id === lastPrimary);
    if (hit) return hit;
  }
  return list.find((u) => u.stepState === 'active') || list[0];
}

/**
 * Is Zumi working on this task right now? True when her board step is running and the task saw activity within the work
 * loop's own 10 minutes (WORK_IDLE_MS, imported so the two can never drift), or when the task is inside the 8 s reaction
 * window (hotIds). In the `inplace` place this is what expands the compact strip; the below places are always open.
 * `<= idleMs` keeps it working through the whole 10th minute, the same edge deriveWorking uses.
 */
export function isWorkingOn(task, nowMs, hotIds) {
  if (!task) return false;
  if (hotIds && typeof hotIds.has === 'function' && hotIds.has(task.id)) return true;
  if (task.stepState !== 'active') return false;
  const at = Date.parse(task.at || '');
  return Number.isFinite(at) && nowMs - at <= WORK_IDLE_MS;
}

const STEP_STATES = ['done', 'active', 'todo', 'waiting', 'blocked'];

/** Step counts for the T2 header and compact strip. An unknown state counts in the total only (never invented). */
export function stepCounts(steps) {
  const out = { done: 0, active: 0, todo: 0, waiting: 0, blocked: 0, total: 0 };
  for (const s of Array.isArray(steps) ? steps : []) {
    if (!s) continue;
    if (STEP_STATES.includes(s.state)) out[s.state] += 1;
    out.total += 1;
  }
  return out;
}

/** The progress hint a board step carries in its `sub`: "(50,4%)" (decimal comma) or "(75%)". null when there is none --
 *  the panel then shows the scan bar and hud.t2.measuring, never a made-up number. */
export function stepPercent(sub) {
  const m = /\((\d+(?:[.,]\d+)?)\s*%\)/.exec(String(sub ?? ''));
  if (!m) return null;
  const n = Number(m[1].replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/** The board's leading "22-10 15:55:" stamp, as it appeared on `now` (the mock stripped it too). A lone date is not a
 *  stamp: the time part is required. */
export function stripNowStamp(text) {
  return String(text ?? '').replace(/^\d{1,2}-\d{1,2} \d{1,2}:\d{2}:\s*/, '');
}

/** The word-end offsets of `text` (exclusive): real word edges from Intl.Segmenter, so Chinese is cut between words and
 *  never inside a character; a space-scan when the engine has no Segmenter. */
function wordEnds(text, locale) {
  const ends = [];
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    try {
      for (const s of new Intl.Segmenter(locale, { granularity: 'word' }).segment(text)) if (s.isWordLike) ends.push(s.index + s.segment.length);
      if (ends.length) return ends;
    } catch { /* an unusual locale tag: fall through to spaces */ }
  }
  for (const m of text.matchAll(/\S+/g)) ends.push(m.index + m[0].length);
  return ends;
}

/**
 * T1's NOW line, cut at a word boundary instead of the mock's scrolling ticker (fix 2: it cut mid-word). Returns the whole
 * text when it fits; otherwise the longest word-aligned prefix for which `fits(prefix + '…')` is true; otherwise just the
 * ellipsis (a single over-long word is never shown half). `fits` is injected -- a canvas measureText in the app, a char
 * count in the checks. The caller puts the full text in the element's title.
 */
export function wordFit(text, fits, locale = 'en') {
  const src = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!src || typeof fits !== 'function') return '';
  if (fits(src)) return src;
  const ends = wordEnds(src, locale);
  for (let i = ends.length - 1; i >= 0; i--) {
    const cut = src.slice(0, ends[i]).trimEnd();
    if (!cut) continue;
    if (fits(cut + ELLIPSIS)) return cut + ELLIPSIS;
  }
  return ELLIPSIS;
}

/** The T3 log tail (fix 1): the last `rows` entries, oldest first so the newest sits at the bottom of a static window with
 *  no scroll and no bottom mask -- the mock's scrolling copy always clipped its last line. */
export function logTail(log, rows = 6) {
  const list = Array.isArray(log) ? log : [];
  const n = Math.max(0, Math.trunc(Number(rows) || 0));
  return n ? list.slice(-n) : [];
}

const localDay = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };

/** `days` local-day buckets (oldest first, today last) of the ISO times a step finished: the T3 steps-finished chart.
 *  Anything outside the window and every unparseable time is dropped, never bucketed into today. */
export function doneByDay(doneAts, nowMs, days = 7) {
  const n = Math.max(1, Math.trunc(Number(days) || 7));
  const out = new Array(n).fill(0);
  const today = localDay(nowMs);
  for (const iso of Array.isArray(doneAts) ? doneAts : []) {
    const ms = Date.parse(iso || '');
    if (!Number.isFinite(ms)) continue;
    const back = Math.round((today - localDay(ms)) / 86_400_000); // whole local days between the two midnights (DST-safe)
    const i = n - 1 - back;
    if (i >= 0 && i < n) out[i] += 1;
  }
  return out;
}

/**
 * The segmented ring's arc paths on a 100x100 viewBox, ported from the mock's hud-lib.js ring(): `n` segments clockwise
 * from 12 o'clock, each inset by `gap` degrees at both ends. Returns the `d` strings only; `w` is accepted because the
 * mock's ring() takes the stroke width there, and the caller sets it from the same value.
 */
export function ringPaths(n = 30, r = 42, w = 8, gap = 3) {
  const count = Math.max(1, Math.trunc(Number(n) || 0));
  const step = 360 / count;
  const round = (v) => Math.round(v * 100) / 100;
  const p = (a) => [50 + r * Math.cos((a * Math.PI) / 180), 50 + r * Math.sin((a * Math.PI) / 180)];
  return Array.from({ length: count }, (_, i) => {
    const [x0, y0] = p(-90 + i * step + gap / 2);
    const [x1, y1] = p(-90 + (i + 1) * step - gap / 2);
    return `M${round(x0)},${round(y0)} A${r},${r} 0 0 1 ${round(x1)},${round(y1)}`;
  });
}
