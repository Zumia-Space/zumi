// Quota panel logic (J-05 quota-view): pure functions that read ONE document (GET /api/v1/quota) and decide what each
// account card shows. The page never recomputes the numbers; it only decides, from as_of / resets_at against the clock,
// whether a value is live, stale or already reset (an unknown % is shown as unknown, never as 0).
// Loaded as a classic script in the browser (sets window.LaneQuota) and importable in Node (sets globalThis.LaneQuota).
(function (root) {
  'use strict';

  /** A value reported less than this long ago is "live". */
  const LIVE_MS = 15 * 60000;
  /** From this share of the 5-hour window the card says HIGH and the ring turns amber. */
  const HOT_PCT = 80;
  const SEGMENTS = 10;

  const ms = iso => { const n = Date.parse(iso); return Number.isFinite(n) ? n : null; };
  const p2 = n => String(n).padStart(2, '0');
  /** "HH:MM dd-mm" in the viewer's local time (the owner's rule: real clock times). '—' for a missing or bad time. */
  function clock(iso) {
    const n = ms(iso);
    if (n == null) return '—';
    const d = new Date(n);
    return `${p2(d.getHours())}:${p2(d.getMinutes())} ${p2(d.getDate())}-${p2(d.getMonth() + 1)}`;
  }
  /** 18.4 M · 212 M · 96.1 M · 4.2 K · 950: three significant figures at most, one decimal under 100. */
  function fmtTokens(n) {
    if (!Number.isFinite(n) || n < 0) return '—';
    const [div, unit] = n >= 1e9 ? [1e9, ' B'] : n >= 1e6 ? [1e6, ' M'] : n >= 1e3 ? [1e3, ' K'] : [1, ''];
    const v = n / div, tenth = Math.round(v * 10) / 10;
    return (div === 1 || tenth >= 100 ? String(Math.round(v)) : tenth.toFixed(1)) + unit;
  }
  /** Filled segments of the 10-cell weekly bar, and the index of the partly-filled one (-1 when none). 41% -> 4 on + cell 4 active. */
  function segments(pct) {
    const p = Math.min(100, Math.max(0, pct));
    const on = Math.floor(p / (100 / SEGMENTS));
    return { on, act: p / (100 / SEGMENTS) > on && on < SEGMENTS ? on : -1 };
  }

  /** missing: no window reported · passed: now is after resets_at (the % is unknown) · stale: older than 15 min · live. */
  function windowState(w, nowMs) {
    if (!w) return 'missing';
    const reset = ms(w.resets_at), asOf = ms(w.seen_at ?? w.as_of); // seen_at = freshness; as_of = the date of the value
    if (reset != null && nowMs > reset) return 'passed';
    if (asOf == null || nowMs - asOf >= LIVE_MS) return 'stale';
    return 'live';
  }

  /**
   * Everything one card shows, decided from the account record and the clock. `status` is the badge:
   * offline (machine unreachable) > never (no snapshot at all) > passed > unverified (snap: fallback) > stale > high (live, >= 80 %) > live.
   * Raw ISO times and numbers are passed through; formatting and words belong to the page (i18n).
   */
  function cardModel(a, nowMs) {
    const five = windowState(a.window5h, nowMs), week = windowState(a.week, nowMs);
    const tokens = a.tokens || null;
    const reach = a.reach?.status || 'ok';
    const asOfs = [a.window5h?.seen_at ?? a.window5h?.as_of, a.week?.seen_at ?? a.week?.as_of, tokens?.as_of].map(ms).filter(x => x != null);
    const lastSeen = asOfs.length ? new Date(Math.max(...asOfs)).toISOString() : null;
    const limitAsOfs = [a.window5h?.seen_at ?? a.window5h?.as_of, a.week?.seen_at ?? a.week?.as_of].map(ms).filter(x => x != null);
    const limitSeen = limitAsOfs.length ? new Date(Math.max(...limitAsOfs)).toISOString() : null;
    // never = the collector has not reported on this machine: the publisher says so (snap: never_seen), or there is nothing at all.
    // Tokens counted on the machine do not make it "live": they say nothing about the plan's rate_limits.
    const never = (a.snap === 'never_seen' && !a.window5h && !a.week) || (!a.window5h && !a.week && !tokens);
    // Freshness follows the 5-hour window when there is one, else the newest value of any kind.
    const fresh = five === 'live' || (five === 'missing' && lastSeen != null && nowMs - Date.parse(lastSeen) < LIVE_MS);
    const pct5 = a.window5h?.pct ?? null;
    const status = reach !== 'ok' ? 'offline' : never ? 'never' : five === 'passed' ? 'passed' : a.snap === 'fallback' ? 'unverified' : !fresh ? 'stale' : five === 'live' && pct5 >= HOT_PCT ? 'high' : 'live';
    return {
      id: a.id, label: a.label, machine: a.machine || '',
      status,
      dot: status === 'offline' ? 'red' : status === 'never' ? 'grey' : status === 'live' ? 'green' : 'yellow',
      blink: status === 'stale' || status === 'passed',
      dim: status !== 'live' && status !== 'high' && status !== 'never',
      reach: { status: reach, since: a.reach?.since || a.reach?.checked_at || null, checkedAt: a.reach?.checked_at || null, msg: a.reach?.msg || '' },
      five: { state: five, pct: pct5, hot: five !== 'passed' && pct5 != null && pct5 >= HOT_PCT, resetsAt: a.window5h?.resets_at || null, asOf: a.window5h?.as_of || null },
      week: { state: week, pct: a.week?.pct ?? null, resetsAt: a.week?.resets_at || null, asOf: a.week?.as_of || null, seg: week === 'missing' || week === 'passed' ? { on: 0, act: -1 } : segments(a.week.pct) },
      tokens: tokens && {
        today: tokens.today, d7: tokens.d7, todayCache: tokens.today_cache_read ?? null, d7Cache: tokens.d7_cache_read ?? null,
        lastActivity: tokens.last_activity || null, asOf: tokens.as_of, idle: tokens.today === 0
      },
      warnings: Array.isArray(a.warnings) ? a.warnings.filter(w => typeof w === 'string' && w) : [],
      lastSeen,
      // "No new data since": the last rate_limits report from Claude Code. The token scan time is not that: it is fresh whenever the machine answers.
      noNewSince: status === 'stale' || status === 'passed' ? limitSeen || lastSeen : null
    };
  }

  /** The panel as a whole: how to read the document the page holds. `gen` turns amber when the publisher has gone quiet. */
  function docModel(doc, nowMs) {
    const gen = ms(doc?.generated_at);
    return { empty: !doc || !doc.accounts?.length, generatedAt: doc?.generated_at || null, quiet: gen != null && nowMs - gen >= LIVE_MS, cards: (doc?.accounts || []).map(a => cardModel(a, nowMs)) };
  }

  root.LaneQuota = { LIVE_MS, HOT_PCT, SEGMENTS, clock, fmtTokens, segments, windowState, cardModel, docModel };
})(typeof window !== 'undefined' ? window : globalThis);
