// T-31 slice 2: the renderer-local progress store, one localStorage key `zumi.progress` (SPEC-skills.md "Store",
// PLAN-NEXT §2 sketch A). Counts only, never message text. Every number only grows (high-water), so the level can
// never drop when a live source does (30-day usage window, gesture cache cleared on avatar change, a role off).
//
// Shape (v1):
//   { v: 1, since: 'YYYY-MM-DD'|null, foldedThrough: 'YYYY-MM-DD'|null,
//     days:   { 'YYYY-MM-DD': { turns, plan, check, lookup, touches } },     recent dates, max-merged
//     folded: { turns, plan, check, lookup, touches, days, points },        dates that left the window, summed
//     gestures: n, skills: { [nodeId]: { lvl, at } }, level: n }
// Per-date counts are MAX-merged from usage.summary (the ledger only grows within a day), so a missed or repeated sync
// can neither lose nor double a turn. A date at or before `foldedThrough` is never counted again, and a day's
// closeness cap is computed per date key: with the clock set back, "today" is just a DIFFERENT key (or an already
// folded one, which earns nothing), so a day's cap cannot be earned twice (AC-L2).
//
// Writes: at most once per WRITE_EVERY_MS, plus at once on a level-up. A read-only store (self-test, demo, shots and
// probe runs: AC-S7) keeps everything in memory and never calls storage.setItem. Gameable by hand through DevTools,
// and that is fine: single-player, display-only, never in the prompt.
import { PROGRESS_KEY, PROGRESS_VERSION, WRITE_EVERY_MS, KEEP_DAYS } from './constants.js';
import { dailyPoints, xpOf, levelOf } from './derive.js';

const COUNT_KINDS = ['turns', 'plan', 'check', 'lookup', 'touches'];
const KIND_OF_ROW = { chat: 'turns', plan: 'plan', check: 'check', lookup: 'lookup' }; // jev calls are not turns
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const n0 = (x) => (Number.isFinite(x) && x > 0 ? Math.floor(x) : 0);
const pad = (x) => String(x).padStart(2, '0');
export const localDate = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
export function dayMinus(dateStr, k) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return localDate(new Date(y, m - 1, d - k).getTime());
}

const emptyDay = () => ({ turns: 0, plan: 0, check: 0, lookup: 0, touches: 0 });
export function freshState() {
  return { v: PROGRESS_VERSION, since: null, foldedThrough: null, days: {}, folded: { ...emptyDay(), days: 0, points: 0 }, gestures: 0, skills: {}, level: 1 };
}

// Stored text -> { state, writable }. Missing or corrupt -> a fresh state (counts only, nothing private is lost).
// A version NEWER than this build (an older app opened a newer profile) is read as fresh and never overwritten.
// Each future version adds one step here: `if (raw.v === 1) raw = v1to2(raw);` (the JSON counterpart of a migration).
export function upgrade(text) {
  let raw = null;
  try { raw = text ? JSON.parse(text) : null; } catch { raw = null; }
  if (!raw || typeof raw !== 'object' || !Number.isInteger(raw.v) || raw.v < 1) return { state: freshState(), writable: true };
  if (raw.v > PROGRESS_VERSION) return { state: freshState(), writable: false };
  const s = freshState();
  s.since = typeof raw.since === 'string' && DATE.test(raw.since) ? raw.since : null;
  s.foldedThrough = typeof raw.foldedThrough === 'string' && DATE.test(raw.foldedThrough) ? raw.foldedThrough : null;
  for (const [d, c] of Object.entries(raw.days && typeof raw.days === 'object' ? raw.days : {})) {
    if (!DATE.test(d) || !c || typeof c !== 'object') continue;
    s.days[d] = Object.fromEntries(COUNT_KINDS.map((k) => [k, n0(c[k])]));
  }
  const f = raw.folded && typeof raw.folded === 'object' ? raw.folded : {};
  for (const k of [...COUNT_KINDS, 'days']) s.folded[k] = n0(f[k]);
  s.folded.points = Number.isFinite(f.points) && f.points > 0 ? f.points : 0;
  s.gestures = n0(raw.gestures);
  for (const [id, v] of Object.entries(raw.skills && typeof raw.skills === 'object' ? raw.skills : {})) {
    if (/^[a-z]+\.[a-z]+$/.test(id) && v && typeof v === 'object') s.skills[id] = { lvl: n0(v.lvl), at: n0(v.at) };
  }
  s.level = Math.max(1, n0(raw.level));
  return { state: s, writable: true };
}

export function createProgressStore({ storage, now = () => Date.now(), readOnly = false, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let text = null;
  try { text = storage ? storage.getItem(PROGRESS_KEY) : null; } catch { text = null; }
  const loaded = upgrade(text);
  const s = loaded.state;
  const canWrite = Boolean(storage) && !readOnly && loaded.writable;
  let lastWrite = -Infinity, timer = null, dirty = false;

  function write() {
    if (timer) { clearTimer(timer); timer = null; }
    if (!canWrite || !dirty) return false;
    try { storage.setItem(PROGRESS_KEY, JSON.stringify(s)); } catch { return false; } // quota/private mode: keep in memory
    lastWrite = now(); dirty = false;
    return true;
  }
  // Throttled save: now if a minute has passed (or `force`, i.e. a level-up), else once when the minute is up.
  function save(force = false) {
    dirty = true;
    if (!canWrite) return;
    const wait = lastWrite + WRITE_EVERY_MS - now();
    if (force || wait <= 0) write();
    else if (!timer) timer = setTimer(write, wait);
  }

  function fold(d) {
    const c = s.days[d];
    for (const k of COUNT_KINDS) s.folded[k] += c[k];
    if (c.turns >= 1) s.folded.days += 1;
    s.folded.points += dailyPoints(c.turns, c.touches);
    if (!s.foldedThrough || d > s.foldedThrough) s.foldedThrough = d;
    delete s.days[d];
  }
  // Dates older than the 30-day window of `ref` never come back in usage.summary: fold them. Dates AFTER ref (clock
  // set back) stay as they are. The map is also capped at KEEP_DAYS entries, oldest folded first.
  function foldOld(ref) {
    const start = dayMinus(ref, 29);
    for (const d of Object.keys(s.days).sort()) if (d < start) fold(d);
    const keys = Object.keys(s.days).sort();
    for (let i = 0; i < keys.length - KEEP_DAYS; i++) fold(keys[i]);
  }
  const counted = (d) => !s.foldedThrough || d > s.foldedThrough;
  const dayOf = (d) => (s.days[d] ||= emptyDay());

  return {
    writable: canWrite,
    // usage.summary -> { today, rows: [{ date, kind, calls }] }: max-merge each date's calls per kind.
    mergeUsage(summary) {
      if (!summary || typeof summary.today !== 'string' || !DATE.test(summary.today) || !Array.isArray(summary.rows)) return;
      const sums = new Map();
      for (const r of summary.rows) {
        const k = r && KIND_OF_ROW[r.kind || 'chat'];
        if (!k || typeof r.date !== 'string' || !DATE.test(r.date) || !counted(r.date)) continue;
        const c = sums.get(r.date) || emptyDay();
        c[k] += n0(r.calls);
        sums.set(r.date, c);
      }
      let changed = false;
      for (const [d, c] of sums) {
        const day = dayOf(d);
        for (const k of ['turns', 'plan', 'check', 'lookup']) if (c[k] > day[k]) { day[k] = c[k]; changed = true; }
        if (c.turns > 0 && (!s.since || d < s.since)) { s.since = d; changed = true; }
      }
      const before = s.foldedThrough;
      foldOld(summary.today);
      if (changed || before !== s.foldedThrough) save();
    },
    // One poke or the start of one pat (renderer touch events). A folded date (clock set far back) earns nothing.
    addTouch() {
      const d = localDate(now());
      if (!counted(d)) return;
      dayOf(d).touches += 1;
      if (!s.since) s.since = d;
      save();
    },
    // Gesture-cache size: high-water, so clearing the cache (avatar change) never lowers it (AC-S4).
    setGestures(n) { if (n0(n) > s.gestures) { s.gestures = n0(n); save(); } },
    totals() {
      const t = { ...s.folded, gestures: s.gestures };
      for (const c of Object.values(s.days)) {
        for (const k of COUNT_KINDS) t[k] += c[k];
        if (c.turns >= 1) t.days += 1;
        t.points += dailyPoints(c.turns, c.touches);
      }
      return { days: t.days, turns: t.turns, touches: t.touches, gestures: t.gestures, points: t.points, calls: { plan: t.plan, check: t.check, lookup: t.lookup } };
    },
    held() { return Object.fromEntries(Object.entries(s.skills).map(([id, v]) => [id, v.lvl])); },
    // Fold a derived view back in: node levels and the level are high-water. Returns { level, xp, from, to, levelUp }.
    recordView(view) {
      let changed = false;
      for (const node of view.nodes) {
        const had = s.skills[node.id] ? s.skills[node.id].lvl : 0;
        if (node.lvl > had) { s.skills[node.id] = { lvl: node.lvl, at: now() }; changed = true; }
      }
      const lvlSum = Object.values(s.skills).reduce((a, v) => a + v.lvl, 0);
      const xp = xpOf(this.totals().days, lvlSum);
      const L = levelOf(xp);
      const levelUp = L.lvl > s.level;
      if (levelUp) s.level = L.lvl;
      if (levelUp) save(true); else if (changed) save();
      return { level: s.level, xp, from: L.from, to: L.to, levelUp };
    },
    since() { return s.since; },
    flush() { return write(); }, // window closing: write what is pending now (still never in a read-only run)
    snapshot() { return JSON.parse(JSON.stringify(s)); },
  };
}

// The run modes that must leave `zumi.progress` untouched (AC-S7): the fields of main's app:info that mark a
// self-test, a demo, or one of the screenshot / probe / stress harnesses. check-skills.mjs reads the app:info block
// of src/main/main.js and fails if a new harness flag of this shape appears that is not listed here.
export const RUN_MODE_FLAGS = Object.freeze(['selftest', 'demo', 'roomShots', 'boardStress', 'settingsShots', 'settingsProbe']);
export const isReadOnlyRun = (info) => !info || RUN_MODE_FLAGS.some((k) => Boolean(info[k]));
