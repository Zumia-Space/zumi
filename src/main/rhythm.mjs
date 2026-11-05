// Rhythm core v0 (T-31 alpha.12, PLAN-ZUMI-WATCH v2 section A): the one module that learns WHEN the owner works and
// answers, and turns it into every cadence number Zumi uses. Consumers call rhythm.get() and never compute a cadence
// themselves (the "canonical reader" rule): the speech scheduler reads checkinHours, the watcher reads batchMs /
// repeatMs / receiptMs / nudgeBudgetToday, Settings shows the same object.
//
// What it stores: <dataDir>/rhythm/events.jsonl, one event per line, codes and stamps only (no text, no task titles),
// 90-day rolling window (older lines are dropped when the log is opened); <dataDir>/rhythm/state.json {paused}.
// Deterministic, 0 tokens: no distillation in alpha.12 (plan F), so `distilled` is always null here. The plan's
// snapshot()/profile.json arrive with the distiller that reads them (alpha.14); Settings reads get().
//
// Clock injected (`now`), like speech-scheduler.mjs, so scripts/check-rhythm.mjs drives synthetic weeks under plain Node.
// File access is limited to the rhythm/ folder this module owns.
import fs from 'node:fs';
import path from 'node:path';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const BUCKET_MS = 5 * MIN;          // `active` is sampled into 5-minute buckets
const KEEP_MS = 90 * DAY;           // rolling window
const LEARN_MS = 7 * DAY;           // cold start: 7 days AND ...
const LEARN_EVENTS = 200;           // ... 200 events before the learned numbers replace the v1 defaults
const HALF_LIFE_DAYS = 14;          // activeProb EWMA
const REACT_HALF_LIFE = 20;         // reactRate EWMA, in nudges
const REACT_WINDOW_MS = 10 * MIN;   // a chat / owner board write / HUD click within 10 min of a nudge = reacted
const IGNORE_AFTER_MS = 30 * MIN;   // no reaction 30 min after a nudge = ignored
const BUSY_WINDOW_MS = 10 * MIN;    // busyNow: a chat or owner board write in the last 10 min
const ACTIVE_P = 0.3;               // an hour belongs to an active window at activeProb >= 0.3
const QUIET_P = 0.1;                // quiet suggestion: the longest run of hours below 0.1 ...
const QUIET_MIN_HOURS = 6;          // ... that is at least 6 h long
const PEAK_SPACING_H = 3;           // a check-in peak is at least 3 h from every other check-in
const MAX_CHECKINS = 4;
const GET_CACHE_MS = 60_000;        // get() is read on every 1 s scheduler tick; a full 90-day derivation costs ~43 ms (measured), so at most once a minute
const DEFAULT_CHECKIN_HOURS = [12, 16]; // v1 / alpha.10 fixed check-ins (speech-scheduler.mjs CHECKIN_WINDOWS)

export const EVENT_KINDS = Object.freeze(['active', 'chat', 'ask.answered', 'board.write', 'nudge.said', 'nudge.reacted', 'nudge.ignored', 'mute']);

/** Hard bounds (plan A.5). Not settings: every learned number is clamped into these. */
export const BOUNDS = Object.freeze({
  scanMs: [5 * MIN, 60 * MIN],
  batchMs: [15 * MIN, 4 * HOUR],
  repeatMs: [1 * HOUR, 8 * HOUR],
  nudgeBudgetToday: [2, 12],
  receiptMs: [30 * MIN, 6 * HOUR],
  checkinsPerDay: MAX_CHECKINS,
});

/** The v1 cadence (plan A.5 cold start): what get() returns while learning, paused, or with no events. */
export const V1_DEFAULTS = Object.freeze({
  scanMs: 15 * MIN,
  batchMs: 30 * MIN,
  nudgeBudgetToday: 6,
  repeatMs: 2 * HOUR,
  receiptMs: 1 * HOUR,
  checkinHours: Object.freeze([...DEFAULT_CHECKIN_HOURS]),
  quietSuggested: null,
});
/** The cadence keys whose fresh value must equal V1_DEFAULTS byte for byte (check-rhythm "fresh"). */
export const CADENCE_KEYS = Object.freeze(Object.keys(V1_DEFAULTS));

const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const CODE = /^[\w:.\/@#-]{1,80}$/;
const code = (v) => (typeof v === 'string' && CODE.test(v) ? v : undefined);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const dayStart = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
const hh = (h) => `${String(((h % 24) + 24) % 24).padStart(2, '0')}:00`;

/** One raw input -> the stored event (whitelisted fields only, plan A.2), or null when the kind is unknown. */
function shapeEvent(kind, input, t) {
  const p = input && typeof input === 'object' ? input : {};
  const d = new Date(t);
  switch (kind) {
    case 'active': return { k: kind, t, dow: d.getDay(), hour: d.getHours() };
    case 'chat': return { k: kind, t };
    case 'ask.answered': return { k: kind, t, askCreatedAt: num(p.askCreatedAt) };
    case 'board.write': return { k: kind, t, task: code(p.task) };
    case 'nudge.said': return { k: kind, t, key: code(p.key), kind: code(p.kind) };
    case 'nudge.reacted': return { k: kind, t, key: code(p.key), afterMs: num(p.afterMs) };
    case 'nudge.ignored': return { k: kind, t, key: code(p.key) };
    case 'mute': return { k: kind, t, untilMs: num(p.untilMs) ?? null };
    default: return null;
  }
}

/**
 * The derived profile (plan A.3) from an event list at time `at`. Pure: same events + same clock = same numbers.
 * @param {object[]} events stored events, oldest first
 * @param {number} at epoch ms
 */
export function deriveProfile(events, at) {
  const firstT = events.length ? events[0].t : null;
  const learning = !events.length || at - firstT < LEARN_MS || events.length < LEARN_EVENTS;

  // activeProb[dow][hour]: per observed (day, hour) cell the fraction of its 12 buckets that were active, averaged over
  // the days of that weekday with an EWMA weight (half-life 14 days). A cell counts once it has fully elapsed.
  const activeProb = Array.from({ length: 7 }, () => new Array(24).fill(0));
  if (events.length) {
    const buckets = new Map(); // `${dayStart}|${hour}` -> active bucket count
    for (const e of events) if (e.k === 'active') {
      const key = `${dayStart(e.t)}|${new Date(e.t).getHours()}`;
      buckets.set(key, (buckets.get(key) || 0) + 1);
    }
    const num7 = Array.from({ length: 7 }, () => new Array(24).fill(0));
    const den7 = Array.from({ length: 7 }, () => new Array(24).fill(0));
    for (let d0 = dayStart(firstT); d0 <= at; d0 = dayStart(d0 + DAY + 2 * HOUR)) { // +2 h survives a DST day
      const dow = new Date(d0).getDay();
      const w = 0.5 ** ((at - d0) / DAY / HALF_LIFE_DAYS);
      for (let h = 0; h < 24; h++) {
        const cellStart = new Date(d0); cellStart.setHours(h, 0, 0, 0);
        if (cellStart.getTime() + HOUR > at) break;
        const frac = Math.min(1, (buckets.get(`${d0}|${h}`) || 0) / 12);
        num7[dow][h] += w * frac; den7[dow][h] += w;
      }
    }
    for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) activeProb[d][h] = den7[d][h] ? num7[d][h] / den7[d][h] : 0;
  }

  // reactRate: EWMA over nudge outcomes (reacted 1, ignored 0), newest weight 1, half-life 20 nudges.
  const outcomes = events.filter((e) => e.k === 'nudge.reacted' || e.k === 'nudge.ignored');
  let reactRate = null;
  if (outcomes.length) {
    let n = 0, d = 0;
    outcomes.forEach((e, i) => { const w = 0.5 ** ((outcomes.length - 1 - i) / REACT_HALF_LIFE); n += w * (e.k === 'nudge.reacted' ? 1 : 0); d += w; });
    reactRate = n / d;
  }
  const lat = events.filter((e) => e.k === 'ask.answered' && typeof e.askCreatedAt === 'number').map((e) => Math.max(0, e.t - e.askCreatedAt));
  const askLatencyP50 = median(lat);
  const writes = events.filter((e) => e.k === 'board.write').map((e) => e.t);
  const boardGapP50 = median(writes.slice(1).map((t, i) => t - writes[i]));

  // Quiet suggestion: hour-of-day activity averaged over the week; the longest circular run below 0.1, >= 6 h.
  const hourMean = new Array(24).fill(0).map((_, h) => activeProb.reduce((s, row) => s + row[h], 0) / 7);
  let quietSuggested = null;
  if (events.length && hourMean.some((p) => p >= QUIET_P)) {
    let best = null;
    for (let s = 0; s < 24; s++) {
      if (hourMean[s] >= QUIET_P || hourMean[(s + 23) % 24] < QUIET_P) continue; // a run starts after an active hour
      let len = 0;
      while (len < 24 && hourMean[(s + len) % 24] < QUIET_P) len++;
      if (!best || len > best.len) best = { s, len };
    }
    if (best && best.len >= QUIET_MIN_HOURS) quietSuggested = { start: hh(best.s), end: hh(best.s + best.len) };
  }

  return { learning, events: events.length, since: firstT, activeProb, reactRate, askLatencyP50, boardGapP50, quietSuggested };
}

/** Active windows of one weekday: runs of consecutive hours at activeProb >= 0.3 -> [{start, end}] (end exclusive). */
export function activeWindows(row) {
  const out = [];
  for (let h = 0; h < 24; h++) {
    if (row[h] < ACTIVE_P) continue;
    const start = h;
    while (h < 24 && row[h] >= ACTIVE_P) h++;
    out.push({ start, end: h });
  }
  return out;
}

/** Check-in hours for one weekday (plan A.3): the first hour of each active window, plus up to two activity peaks at
 *  least 3 h from every other check-in; ties go to the hour nearest the old 12:00/16:00, then the earlier hour. Max 4. */
export function checkinHoursFor(row) {
  const wins = activeWindows(row);
  const chosen = wins.map((w) => w.start).slice(0, MAX_CHECKINS);
  const dist = (h) => Math.min(...DEFAULT_CHECKIN_HOURS.map((x) => Math.abs(x - h)));
  const cands = [];
  for (let h = 0; h < 24; h++) if (row[h] >= ACTIVE_P) cands.push(h);
  cands.sort((a, b) => row[b] - row[a] || dist(a) - dist(b) || a - b);
  let peaks = 0;
  for (const h of cands) {
    if (peaks >= 2 || chosen.length >= MAX_CHECKINS) break;
    if (chosen.every((c) => Math.abs(c - h) >= PEAK_SPACING_H)) { chosen.push(h); peaks++; }
  }
  return chosen.sort((a, b) => a - b);
}

const inWindowHours = (q, hour) => {
  if (!q) return false;
  const a = Number(q.start.slice(0, 2)); const b = Number(q.end.slice(0, 2));
  return a < b ? hour >= a && hour < b : hour >= a || hour < b;
};

/**
 * The cadence numbers for a profile at time `at` (plan A.3 table + A.5 bounds). While learning: V1_DEFAULTS.
 * batchMs is the plan's clamp(boardGapP50) whenever board writes exist. Without them (the plan's own busy and chill
 * fixtures, which expect 30 min and 4 h and have no board writes) it falls back to 3 x askLatencyP50: she holds findings
 * about as long as he takes to answer.
 */
export function cadenceOf(profile, at, { levelCap = Infinity } = {}) {
  const now = new Date(at);
  const row = profile.activeProb[now.getDay()];
  const hour = now.getHours();
  const quietNow = inWindowHours(profile.quietSuggested, hour);
  if (profile.learning) {
    return { ...V1_DEFAULTS, checkinHours: [...V1_DEFAULTS.checkinHours], nudgeBudgetToday: Math.min(V1_DEFAULTS.nudgeBudgetToday, levelCap), quietNow: false, inActiveWindow: null };
  }
  const rr = profile.reactRate;
  const inActiveWindow = row[hour] >= ACTIVE_P;
  const scanMs = clamp(inActiveWindow ? (rr != null && rr >= 0.5 ? 5 * MIN : 15 * MIN) : 60 * MIN, BOUNDS.scanMs);
  const gapBase = profile.boardGapP50 ?? (profile.askLatencyP50 != null ? 3 * profile.askLatencyP50 : null);
  const batchMs = gapBase != null ? clamp(gapBase, BOUNDS.batchMs) : V1_DEFAULTS.batchMs;
  const budget = rr == null ? V1_DEFAULTS.nudgeBudgetToday : clamp(Math.round(2 + 10 * rr), BOUNDS.nudgeBudgetToday);
  const repeatMs = rr == null ? V1_DEFAULTS.repeatMs : clamp(batchMs * (2 - rr), BOUNDS.repeatMs);
  const receiptMs = profile.askLatencyP50 == null ? V1_DEFAULTS.receiptMs : clamp(profile.askLatencyP50 * 2, BOUNDS.receiptMs);
  return {
    scanMs, batchMs, nudgeBudgetToday: Math.min(budget, levelCap), repeatMs, receiptMs,
    checkinHours: checkinHoursFor(row), quietSuggested: profile.quietSuggested, quietNow, inActiveWindow,
  };
}

/**
 * @param {{dataDir: string, now?: () => number, log?: (m: string) => void, levelCap?: () => number}} o
 *   levelCap: the talk level's daily line cap (speech-scheduler.mjs LEVELS), so nudgeBudgetToday never exceeds it.
 */
export function createRhythm({ dataDir, now = Date.now, log = () => {}, levelCap = () => Infinity }) {
  const dir = path.join(dataDir, 'rhythm');
  const eventsFile = path.join(dir, 'events.jsonl');
  const stateFile = path.join(dir, 'state.json');
  let events = [];
  let paused = false;
  let cache = null;          // { at, cap, value }: dropped by any new event, pause or reset, else valid for GET_CACHE_MS
  let pending = [];          // nudges said and not yet reacted/ignored: { key, t }
  let lastBucket = null;     // the 5-min bucket the last `active` went into

  function open() {
    try { paused = JSON.parse(fs.readFileSync(stateFile, 'utf8')).paused === true; } catch { paused = false; }
    let lines = [];
    try { lines = fs.readFileSync(eventsFile, 'utf8').split('\n'); } catch { lines = []; }
    const cut = now() - KEEP_MS;
    let dropped = 0;
    for (const l of lines) {
      if (!l.trim()) continue;
      let e;
      try { e = JSON.parse(l); } catch { dropped++; continue; }
      if (!e || !EVENT_KINDS.includes(e.k) || typeof e.t !== 'number' || e.t < cut) { dropped++; continue; }
      events.push(e);
    }
    events.sort((a, b) => a.t - b.t);
    if (dropped) { writeAll(); log(`rhythm: dropped ${dropped} old or unreadable line(s)`); }
    const lastActive = [...events].reverse().find((e) => e.k === 'active');
    lastBucket = lastActive ? Math.floor(lastActive.t / BUCKET_MS) : null;
  }
  function writeAll() {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${eventsFile}.tmp`;
    fs.writeFileSync(tmp, events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''));
    fs.renameSync(tmp, eventsFile);
  }
  function append(e) {
    events.push(e);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(eventsFile, `${JSON.stringify(e)}\n`);
    cache = null;
  }

  /** Append one event (plan A.2). Returns the stored event, or null (paused, unknown kind, or a duplicate bucket). */
  function record(kind, input = {}) {
    if (paused) return null;
    const t = now();
    if (kind === 'active') {
      const b = Math.floor(t / BUCKET_MS);
      if (b === lastBucket) return null;
      lastBucket = b;
    }
    const e = shapeEvent(kind, input, t);
    if (!e) return null;
    append(e);
    if (kind === 'nudge.said' && e.key) pending.push({ key: e.key, t });
    if (kind === 'chat' || kind === 'board.write') reacted();
    return e;
  }

  /** A sign the owner reacted (a chat, an owner board write, a HUD click): resolves nudges said in the last 10 min. */
  function reacted() {
    if (paused) return;
    const t = now();
    const hit = pending.filter((p) => t - p.t <= REACT_WINDOW_MS);
    pending = pending.filter((p) => t - p.t > REACT_WINDOW_MS);
    for (const p of hit) append({ k: 'nudge.reacted', t, key: p.key, afterMs: t - p.t });
  }

  /** Called on the host's clock: nudges with no reaction for 30 min become `nudge.ignored`. */
  function tick() {
    if (paused) return;
    const t = now();
    const late = pending.filter((p) => t - p.t >= IGNORE_AFTER_MS);
    pending = pending.filter((p) => t - p.t < IGNORE_AFTER_MS);
    for (const p of late) append({ k: 'nudge.ignored', t, key: p.key });
  }

  /** The canonical reader (plan A.1). Everything Settings shows and every consumer reads comes from here. */
  function get() {
    const at = now();
    const cap = (() => { try { const c = levelCap(); return typeof c === 'number' && c >= 0 ? c : Infinity; } catch { return Infinity; } })();
    if (cache && at >= cache.at && at - cache.at < GET_CACHE_MS && cache.cap === cap) return cache.value;
    const profile = deriveProfile(events, at);
    const cad = cadenceOf(profile, at, { levelCap: cap });
    const recent = (k) => events.some((e) => e.k === k && at - e.t <= BUSY_WINDOW_MS);
    const busyNow = !profile.learning && lastBucket === Math.floor(at / BUCKET_MS) && (recent('chat') || recent('board.write'));
    const value = {
      learning: profile.learning,
      paused,
      events: profile.events,
      since: profile.since,
      days: profile.since == null ? 0 : Math.floor((at - profile.since) / DAY),
      activeProb: profile.activeProb.map((r) => r.map((p) => Math.round(p * 1000) / 1000)),
      reactRate: profile.reactRate == null ? null : Math.round(profile.reactRate * 1000) / 1000,
      askLatencyP50: profile.askLatencyP50,
      boardGapP50: profile.boardGapP50,
      busyNow,
      nextActiveWindow: nextActiveWindow(profile, at),
      ...cad,
      distilled: null, // alpha.14 (plan F): the weekly DeepSeek distillation; never set in alpha.12
    };
    cache = { at, cap, value };
    return value;
  }

  function nextActiveWindow(profile, at) {
    if (profile.learning) return null;
    for (let d = 0; d < 8; d++) {
      const day = new Date(dayStart(dayStart(at) + d * DAY + 2 * HOUR)); // +2 h survives a DST day; from local midnight, so tonight is day 0
      for (const w of activeWindows(profile.activeProb[day.getDay()])) {
        const s = new Date(day); s.setHours(w.start, 0, 0, 0);
        if (s.getTime() > at) return { at: s.getTime(), start: hh(w.start), end: hh(w.end) };
      }
    }
    return null;
  }

  /** Pause learning (Settings > Rhythm): no event is logged while paused; the learned numbers stay as they are. */
  function pause(on) {
    paused = on === true;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ paused }));
    cache = null;
    return get();
  }

  /** Reset rhythm (after the user's confirm in Settings): delete rhythm/ and start learning from zero. */
  function reset() {
    fs.rmSync(dir, { recursive: true, force: true });
    events = []; pending = []; lastBucket = null; paused = false; cache = null;
    return get();
  }

  open();
  return { record, reacted, tick, get, pause, reset, _test: { events: () => events, pending: () => pending } };
}
