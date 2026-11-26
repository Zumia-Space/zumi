#!/usr/bin/env node
// check:board-slow-poll (T-31 alpha.9.5). The vendored Board page must never stop polling while document.hidden: WebView2 can report
// the page hidden while it is on screen (owner PC), and a board that paused then stayed stale until a click. Rule (CoS mail 68a61a22):
// visible polls every 15 s, hidden polls every 60 s, turning visible refreshes at once. The page's poll wiring (the top-level lines
// between the colour-scheme listener and boot()) runs in a vm with fake timers and a fake document. Gate GATE-OPUS-ALPHA95: the hidden
// cadence must survive Chromium's intensive throttling (one timer wake-up per minute after 5 min hidden), so throttle() models it.
//   node scripts/check-board-slow-poll.mjs [--public <dir>]
// --public is the negative control: the page of another Laneboard commit. No network, no window.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const pubAt = args.indexOf('--public');
const APP = fs.readFileSync(path.join(path.resolve(pubAt >= 0 ? args[pubAt + 1] : path.join(ROOT, 'vendor', 'laneboard', 'public')), 'app.js'), 'utf8');
let pass = 0, fail = 0;
const ok = (c, name, detail = '') => { if (c) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}  ${detail}`); } };

const ANCHOR = "\nmatchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyPrefs);";
const from = APP.indexOf(ANCHOR) < 0 ? -1 : APP.indexOf(ANCHOR) + ANCHOR.length;
const to = APP.indexOf('\n(async function boot()');
const WIRING = APP.slice(from, to);
ok(from > 0 && to > from && /setInterval\(/.test(WIRING), 'app.js poll wiring found between the colour-scheme listener and boot()');

/** The wiring on a fake clock: tick(ms) advances it, flip(state) fires visibilitychange; refreshes counts refresh() calls. */
function page({ hidden = false, typing = false, data = true, media = false } = {}) {
  let now = 0;
  const timers = [];
  const listeners = {};
  const doc = {
    visibilityState: hidden ? 'hidden' : 'visible',
    get hidden() { return this.visibilityState !== 'visible'; },
    activeElement: { matches: (sel) => typing && /textarea/.test(sel) },
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
  };
  const p = { refreshes: 0, at: [] };
  const ctx = vm.createContext({
    S: { data: data ? {} : null },
    document: doc,
    mediaPlaying: () => media,
    refresh: () => { p.refreshes++; p.at.push(now); },
    setInterval: (fn, ms) => { timers.push({ fn, ms, at: now + ms, every: true }); return timers.length; },
    setTimeout: (fn, ms) => { timers.push({ fn, ms, at: now + ms, every: false }); return timers.length; },
    clearInterval: (id) => { if (timers[id - 1]) timers[id - 1].at = Infinity; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].at = Infinity; },
    Date: { now: () => now },
  });
  vm.runInContext(WIRING, ctx);
  p.tick = (ms) => {
    const end = now + ms;
    for (;;) {
      const next = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      now = next.at;
      if (next.every) next.at += next.ms; else next.at = Infinity;
      next.fn();
    }
    now = end;
  };
  // Chromium's intensive throttling of a page hidden for over 5 min: a chained timer wakes at most once per `period`.
  p.throttle = (period) => { for (const t of timers) if (t.every) { t.ms = period; t.at = now + period; } };
  p.flip = (state) => { doc.visibilityState = state; for (const fn of listeners.visibilitychange || []) fn(); };
  return p;
}

{ const p = page(); p.tick(60_000); ok(p.refreshes === 4, 'visible: polls every 15 s (4 in 60 s, unchanged)', `got ${p.refreshes}`); }
{ const p = page({ hidden: true }); p.tick(60_000); ok(p.refreshes >= 1, 'hidden: still polls within 60 s', `got ${p.refreshes}`); }
{ const p = page({ hidden: true }); p.tick(240_000); ok(p.refreshes === 4, 'hidden: slows to every 60 s (4 in 240 s, not 16)', `got ${p.refreshes}`); }
{
  const p = page(); p.tick(20_000); p.flip('hidden'); const atHide = p.refreshes; p.tick(60_000);
  ok(atHide === 1 && p.refreshes >= 2, 'visible then hidden: a poll still lands within 60 s of hiding', `hide=${atHide} after=${p.refreshes}`);
}
{ const p = page({ hidden: true }); p.tick(5_000); p.flip('visible'); ok(p.refreshes === 1, 'turning visible refreshes at once (0 ms)', `got ${p.refreshes}`); }
{ const p = page(); p.tick(5_000); p.flip('hidden'); ok(p.refreshes === 0, 'turning hidden does not refresh', `got ${p.refreshes}`); }
{ const p = page({ hidden: true, typing: true }); p.tick(120_000); p.flip('visible'); ok(p.refreshes === 0, 'typing in a field: no poll and no refresh on return (draft kept)', `got ${p.refreshes}`); }
{ const p = page({ hidden: true, data: false }); p.tick(120_000); p.flip('visible'); ok(p.refreshes === 0, 'no board loaded yet: no poll (boot owns the first load)', `got ${p.refreshes}`); }
for (const period of [60_000, 59_500]) { // 59.5 s: wake-up alignment can land just short of a full minute
  const p = page(); p.tick(30_000); p.flip('hidden'); p.throttle(period); p.tick(600_000);
  const hidden = p.at.filter((t) => t > 30_000).length;
  const gap = Math.max(...p.at.slice(1).map((t, i) => t - p.at[i]));
  ok(hidden === Math.floor(600_000 / period) && gap <= 60_000, `hidden, throttled to one wake-up per ${period} ms: a poll on every wake-up, never more than 60 s apart`, `polls=${hidden} gap=${gap}`);
}
{ const a = page({ media: true }); a.tick(60_000); const b = page({ hidden: true, media: true }); b.tick(120_000); b.flip('visible'); ok(a.refreshes + b.refreshes === 0, 'media playing: no poll, hidden or visible, and no refresh on return', `visible=${a.refreshes} hidden=${b.refreshes}`); }
{
  const p = page({ hidden: true }); p.tick(52_000); p.flip('visible'); p.tick(9_000); const once = p.at.join(); p.tick(15_000);
  ok(once === '52000' && p.at.join() === '52000,75000', 'a tick just after the return refresh does not fire a second refresh', `${once} | ${p.at.join()}`);
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
