// HUD toggle-on poll (T-31 0.2.11, Pi2 R3 "HUD S1"): switching the HUD on must show the panel within ~1 s, not on the
// next 20 s board tick (measured 14.4 s on Electron). Headless, the REAL main host (src/main/hud-host.mjs), node:test
// fake timers, a fake board reader with a read latency, and a fake IPC (host.setPrefs -> 'hud:feed' recorded).
// Two causes, both in the host: (1) setPrefs off -> on called start(), a no-op while the timer already runs (a talk level
// keeps it running), so nothing polled until the next tick; (2) poll() read prefs().style BEFORE awaiting the board, so a
// read already in flight when the HUD was switched on (poll() returns that same read) painted nothing.
//   node scripts/check-hud-toggle.mjs [host-module-path]   (exit 1 on any failure)
import { mock } from 'node:test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const hostPath = process.argv[2] ? path.resolve(process.argv[2]) : new URL('../src/main/hud-host.mjs', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
const { createHudHost, POLL_MS } = await import(pathToFileURL(hostPath).href);

let pass = 0, fail = 0;
const ok = (cond, name, detail) => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`); } };

mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 1_000_000 });
const state = { tasks: [{ id: 'T-31', title: 'Zumi', status: 'active', rev: 1, last_activity_at: new Date(1_000_000).toISOString(), current_step: { id: 's', label: 'Step', state: 'active' }, steps: [] }], attention: { waiting: [] } };
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
// Advance fake time in 100 ms steps, letting async work settle between steps (one big tick would overlap polls).
const advance = async (ms) => { for (let t = 0; t < ms; t += 100) { mock.timers.tick(100); await flush(); } };

// talk = the talk level is on (the host timer runs with the HUD off); readMs = board read latency.
async function boot({ talk, readMs }) {
  const settings = { hudStyle: 'off' };
  const feeds = [];
  let reads = 0;
  const host = createHudHost({
    getState: () => { reads++; return new Promise((r) => setTimeout(() => r({ ok: true, state }), readMs)); },
    idleSeconds: () => 0,
    settings: { get: () => ({ ...settings }), set: (p) => Object.assign(settings, p) },
    send: (p) => feeds.push({ at: Date.now(), style: p.style, hasFeed: Boolean(p.feed) }),
    decide: () => ({ allowed: false }), open: async () => {},
    talkActive: () => talk,
  });
  host.start(); // main.js: hud:ready -> start() (only while active)
  await advance(readMs + 100);
  return { host, feeds, reads: () => reads };
}
const firstPanelMs = (w, t0) => { const f = w.feeds.find((x) => x.hasFeed && x.style !== 'off' && x.at >= t0); return f ? f.at - t0 : null; };

// (a) the toggle lands at assorted moments of the 20 s tick, with the board read in flight or not.
for (const [talk, readMs, atMs] of [[true, 50, 5000], [true, 50, 0], [true, 500, 18700], [true, 800, 19300], [true, 2000, 18400], [false, 50, 5000]]) {
  const w = await boot({ talk, readMs });
  await advance(atMs);
  const t0 = Date.now();
  w.host.setPrefs({ style: 'a' });
  await advance(25_000);
  const ms = firstPanelMs(w, t0);
  ok(ms !== null && ms <= readMs + 1500, `(a) talk=${talk} read=${readMs}ms toggle at +${atMs}ms: panel after ${ms} ms (<= read + 1.5 s)`, ms);
  w.host.stop();
}

// (b) race: the toggle lands while the periodic read is in flight (read 3 s, toggle 1 s after its start).
{
  const w = await boot({ talk: true, readMs: 3000 });
  await advance(POLL_MS - 3100 - 100); // just before the tick that starts the read
  await advance(1100);                  // the read is now ~1 s in
  const t0 = Date.now();
  w.host.setPrefs({ style: 'a' });
  await advance(25_000);
  const ms = firstPanelMs(w, t0);
  ok(ms !== null && ms <= 3000, `(b) toggle during an in-flight read: panel after ${ms} ms (<= the rest of that read)`, ms);
  w.host.stop();
}

// (c) no storm, no stacked interval: off/on x3 quickly, then steady state is one read per 20 s tick.
{
  const w = await boot({ talk: true, readMs: 50 });
  const base = w.reads();
  for (const s of ['a', 'off', 'b', 'off', 'a']) { w.host.setPrefs({ style: s }); await advance(100); }
  await advance(2000);
  const burst = w.reads() - base;
  ok(burst <= 5, '(c) five quick toggles -> at most one read each (no request storm)', burst);
  const after = w.reads();
  await advance(POLL_MS * 3);
  const steady = w.reads() - after;
  ok(steady === 3, '(c) steady state: exactly one read per 20 s tick (no stacked interval)', steady);
  w.host.stop();
}

// (d) HUD off + talk off: nothing polls; switching on starts exactly one timer.
{
  const w = await boot({ talk: false, readMs: 50 });
  ok(w.reads() === 0, '(d) HUD off, talk off: no board read at boot', w.reads());
  w.host.setPrefs({ style: 'a' });
  await advance(POLL_MS * 2 + 2000);
  ok(w.reads() === 3, '(d) switched on: the start read plus one per 20 s tick', w.reads());
  w.host.stop();
}

// (e) toggle OFF while a poll's getState is in flight: nothing may be painted after the off (the style is read AFTER the await).
for (const talk of [true, false]) {
  const settings = { hudStyle: 'a' };
  const feeds = [];
  const reads = [];
  const host = createHudHost({
    getState: () => { reads.push(Date.now()); return new Promise((r) => setTimeout(() => r({ ok: true, state }), 3000)); },
    idleSeconds: () => 0,
    settings: { get: () => ({ ...settings }), set: (p) => Object.assign(settings, p) },
    send: (p) => feeds.push({ at: Date.now(), style: p.style }),
    decide: () => ({ allowed: false }), open: async () => {},
    talkActive: () => talk,
  });
  host.start();
  await advance(3100);                   // the start read has landed
  await advance(POLL_MS - 3100 + 1000);  // the periodic read is ~1 s in flight
  const inflight = Date.now() - reads[reads.length - 1] < 3000;
  const t0 = Date.now();
  host.setPrefs({ style: 'off' });
  await advance(POLL_MS * 2);
  const painted = feeds.filter((x) => x.at >= t0 && x.style !== 'off').length;
  ok(inflight && painted === 0, `(e) talk=${talk} toggle OFF mid-poll: read in flight=${inflight}, non-off sends after the off=${painted}`, { inflight, painted });
  host.stop();
}

mock.timers.reset();
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
