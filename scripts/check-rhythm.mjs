// check:rhythm (T-31 alpha.12, PLAN-ZUMI-WATCH v2 A.8). Plain Node, fake clock, synthetic logs, no network.
//   busy  : active 08-22 Mon-Sat, chat every 20 min, asks answered in 10 min, 80 % nudges reacted
//           -> scanMs 5 min, batchMs 30 min, budget 10, checkinHours [8, 12, 16], quiet 23:00-08:00
//   chill : active 20-22 daily, 3 chats/day, asks answered in 6 h, 20 % reacted
//           -> scanMs 60 min outside 20-22, batchMs 4 h, budget 4, one check-in at 20:00, quiet 22:00-20:00
//   fresh : 0 events -> every cadence number equals the v1 default (byte-equal JSON)
//   bounds: adversarial logs (1000 events in a minute, garbage fields, all-reacted, all-ignored, 24/7) never leave A.5
// plus: the 90-day window, pause (no logging), reset (folder gone), reacted/ignored on the clock, codes-only fields.
import fs from 'node:fs';
import path from 'node:path';
import { checkOutDir } from './lib/check-out-dir.mjs';
import { createRhythm, V1_DEFAULTS, CADENCE_KEYS, BOUNDS } from '../src/main/rhythm.mjs';

let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); } };
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const root = checkOutDir('check-rhythm');
let n = 0;
const freshDir = () => { const d = path.join(root, `p${++n}`); fs.mkdirSync(d, { recursive: true }); return d; };
const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
const writeLog = (dir, events) => {
  fs.mkdirSync(path.join(dir, 'rhythm'), { recursive: true });
  events.sort((a, b) => a.t - b.t);
  fs.writeFileSync(path.join(dir, 'rhythm', 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
};
const act = (t) => { const d = new Date(t); return { k: 'active', t, dow: d.getDay(), hour: d.getHours() }; };
const pick = (v) => Object.fromEntries(CADENCE_KEYS.map((k) => [k, v[k]]));
const inBounds = (v) => {
  const bad = [];
  for (const k of ['scanMs', 'batchMs', 'repeatMs', 'nudgeBudgetToday', 'receiptMs']) if (!(v[k] >= BOUNDS[k][0] && v[k] <= BOUNDS[k][1])) bad.push(`${k}=${v[k]}`);
  if (!Array.isArray(v.checkinHours) || v.checkinHours.length > BOUNDS.checkinsPerDay || v.checkinHours.some((h) => !Number.isInteger(h) || h < 0 || h > 23)) bad.push(`checkinHours=${JSON.stringify(v.checkinHours)}`);
  return bad;
};

// A fixed local calendar: 28 days ending on Wednesday 2026-10-28 (the fixture "today").
const END_DAY = at(2026, 10, 28);
const START_DAY = END_DAY - 28 * DAY;
const days = [];
for (let d = START_DAY; d <= END_DAY; d = new Date(new Date(d + DAY + 2 * HOUR).setHours(0, 0, 0, 0)).getTime()) days.push(d);
ok(new Date(END_DAY).getDay() === 3, 'fixture today is a Wednesday');

// ---------- busy ----------
{
  const NOW = END_DAY + 10 * HOUR + 30 * MIN; // Wed 10:30
  const ev = [];
  let nudgeI = 0;
  for (const d0 of days) {
    if (new Date(d0).getDay() === 0) continue; // Mon-Sat only
    for (let m = 8 * 60; m < 23 * 60; m += 5) { const t = d0 + m * MIN; if (t < NOW) ev.push(act(t)); }
    for (let m = 8 * 60; m < 23 * 60; m += 20) { const t = d0 + m * MIN + 2 * MIN; if (t < NOW) ev.push({ k: 'chat', t }); }
    for (const h of [9, 11, 14, 17]) { const c = d0 + h * HOUR; if (c + 10 * MIN < NOW) ev.push({ k: 'ask.answered', t: c + 10 * MIN, askCreatedAt: c }); }
    for (let h = 9; h <= 18; h++) {
      const t = d0 + h * HOUR + 31 * MIN;
      if (t + 31 * MIN >= NOW) continue;
      const key = `watch:W3b:T-${nudgeI}`;
      ev.push({ k: 'nudge.said', t, key, kind: 'watch' });
      ev.push(nudgeI % 5 === 4 ? { k: 'nudge.ignored', t: t + 30 * MIN, key } : { k: 'nudge.reacted', t: t + 3 * MIN, key, afterMs: 3 * MIN });
      nudgeI++;
    }
  }
  const dir = freshDir();
  writeLog(dir, ev);
  const r = createRhythm({ dataDir: dir, now: () => NOW });
  const v = r.get();
  ok(v.learning === false, 'busy: past the cold start (28 days, >= 200 events)', `events=${v.events}`);
  ok(v.scanMs === 5 * MIN, 'busy: scanMs = 5 min', String(v.scanMs / MIN));
  ok(v.batchMs === 30 * MIN, 'busy: batchMs = 30 min', String(v.batchMs / MIN));
  ok(v.nudgeBudgetToday === 10, 'busy: nudgeBudgetToday = 10', `${v.nudgeBudgetToday} rr=${v.reactRate}`);
  ok(JSON.stringify(v.checkinHours) === JSON.stringify([8, 12, 16]), 'busy: checkinHours = [8, two peaks] = [8, 12, 16]', JSON.stringify(v.checkinHours));
  ok(v.quietSuggested && v.quietSuggested.start === '23:00' && v.quietSuggested.end === '08:00', 'busy: quietSuggested 23:00-08:00 (~23-07)', JSON.stringify(v.quietSuggested));
  ok(v.repeatMs === 1 * HOUR && v.receiptMs === 30 * MIN, 'busy: repeatMs 1 h (clamped), receiptMs 30 min (clamped)', `${v.repeatMs / MIN} ${v.receiptMs / MIN}`);
  ok(inBounds(v).length === 0, 'busy: all numbers inside A.5 bounds', inBounds(v).join(' '));
  ok(v.distilled === null, 'busy: no distillation in alpha.12 (distilled null)');
  ok(v.nextActiveWindow && v.nextActiveWindow.start === '08:00', 'busy: next active window starts 08:00 (tomorrow)', JSON.stringify(v.nextActiveWindow));
  const capped = createRhythm({ dataDir: dir, now: () => NOW, levelCap: () => 3 }).get();
  ok(capped.nudgeBudgetToday === 3, 'busy: budget never above the talk-level cap (cap 3)');
}

// ---------- chill ----------
{
  const NOW = END_DAY + 15 * HOUR; // Wed 15:00, outside 20-22
  const ev = [];
  let i = 0;
  for (const d0 of days) {
    if (d0 >= END_DAY) continue; // today has not reached 20:00 yet
    for (let m = 20 * 60; m < 22 * 60; m += 5) ev.push(act(d0 + m * MIN));
    for (const m of [20 * 60 + 10, 20 * 60 + 50, 21 * 60 + 30]) ev.push({ k: 'chat', t: d0 + m * MIN });
    ev.push({ k: 'ask.answered', t: d0 + 20 * HOUR + 5 * MIN, askCreatedAt: d0 + 14 * HOUR + 5 * MIN });
    const t = d0 + 20 * HOUR + 30 * MIN; const key = `watch:W1:T-${i}`;
    ev.push({ k: 'nudge.said', t, key, kind: 'watch' });
    ev.push(i % 5 === 0 ? { k: 'nudge.reacted', t: t + 4 * MIN, key, afterMs: 4 * MIN } : { k: 'nudge.ignored', t: t + 30 * MIN, key });
    i++;
  }
  const dir = freshDir();
  writeLog(dir, ev);
  const v = createRhythm({ dataDir: dir, now: () => NOW }).get();
  ok(v.learning === false, 'chill: past the cold start', `events=${v.events}`);
  ok(v.scanMs === 60 * MIN, 'chill: scanMs = 60 min outside 20-22', String(v.scanMs / MIN));
  ok(v.batchMs === 4 * HOUR, 'chill: batchMs = 4 h', String(v.batchMs / MIN));
  ok(v.nudgeBudgetToday === 4, 'chill: nudgeBudgetToday = 4', `${v.nudgeBudgetToday} rr=${v.reactRate}`);
  ok(JSON.stringify(v.checkinHours) === JSON.stringify([20]), 'chill: one check-in at 20:00', JSON.stringify(v.checkinHours));
  ok(v.quietSuggested && v.quietSuggested.start === '22:00' && v.quietSuggested.end === '20:00', 'chill: quietSuggested 22:00-20:00 (~23-19)', JSON.stringify(v.quietSuggested));
  ok(v.quietNow === true, 'chill: 15:00 is inside the suggested quiet run');
  ok(inBounds(v).length === 0, 'chill: all numbers inside A.5 bounds', inBounds(v).join(' '));
  const inWin = createRhythm({ dataDir: dir, now: () => END_DAY - DAY + 20 * HOUR + 59 * MIN }).get();
  ok(inWin.scanMs === 15 * MIN, 'chill: inside 20-22 with reactRate < 0.5 -> scanMs 15 min', String(inWin.scanMs / MIN));
}

// ---------- get() cost: one derivation a minute, a new event drops it ----------
{
  const dir = freshDir();
  let t = END_DAY + 9 * HOUR;
  const r = createRhythm({ dataDir: dir, now: () => t });
  const a = r.get();
  t += 59_000;
  ok(r.get() === a, 'get(): 59 s later the same derived view (the 1 s scheduler tick does not re-derive)');
  t += 1000;
  ok(r.get() !== a, 'get(): re-derived after 60 s');
  const b = r.get();
  r.record('chat');
  ok(r.get() !== b && r.get().events === 1, 'get(): a new event is seen at once');
}

// ---------- batchMs: the board gap wins when it exists; nextActiveWindow sees tonight ----------
{
  const dir = freshDir();
  const NOW = END_DAY + 22 * HOUR + 30 * MIN;
  const ev = [];
  for (const d0 of days.filter((d) => d < END_DAY)) {
    for (let j = 0; j < 12; j++) ev.push(act(d0 + 23 * HOUR + j * 5 * MIN));
    for (const h of [9, 10, 11, 12]) ev.push({ k: 'board.write', t: d0 + h * HOUR, task: 'T-31' });
    ev.push({ k: 'ask.answered', t: d0 + 16 * HOUR, askCreatedAt: d0 + 8 * HOUR }); // slow answers: 8 h latency
  }
  writeLog(dir, ev);
  const v = createRhythm({ dataDir: dir, now: () => NOW }).get();
  ok(v.batchMs === 1 * HOUR, 'batchMs: a 1 h board gap is used even with 8 h answers (the slow latency does not override it)', String(v.batchMs / MIN));
  ok(v.nextActiveWindow && v.nextActiveWindow.start === '23:00' && new Date(v.nextActiveWindow.at).getDate() === new Date(NOW).getDate(), 'nextActiveWindow: at 22:30 a 23:00 window tonight is found', JSON.stringify(v.nextActiveWindow));
}

// ---------- fresh ----------
{
  const dir = freshDir();
  const v = createRhythm({ dataDir: dir, now: () => END_DAY + 9 * HOUR }).get();
  ok(JSON.stringify(pick(v)) === JSON.stringify(pick(V1_DEFAULTS)), 'fresh: cadence JSON byte-equal to the v1 defaults', JSON.stringify(pick(v)));
  ok(v.learning === true && v.events === 0 && v.busyNow === false && v.nextActiveWindow === null, 'fresh: learning, 0 events, not busy');
  ok(!fs.existsSync(path.join(dir, 'rhythm')), 'fresh: get() alone writes nothing');
}

// ---------- bounds ----------
{
  const T0 = END_DAY + 12 * HOUR;
  const garbage = (base) => {
    const ev = [];
    for (let k = 0; k < 1000; k++) {
      const t = base + Math.floor((k * 60_000) / 1000);
      const kinds = [
        { k: 'ask.answered', t, askCreatedAt: k % 2 ? t + 1e9 : -1e15 },
        { k: 'board.write', t, task: 'T-31' },
        { k: 'nudge.reacted', t, key: 'x', afterMs: -5 },
        act(t),
        { k: 'chat', t },
      ];
      ev.push(kinds[k % kinds.length]);
    }
    return ev;
  };
  const cases = {
    'burst-now': garbage(T0 - MIN),
    'old-log+burst': [...days.filter((d) => d < END_DAY).flatMap((d0) => [act(d0 + 9 * HOUR), { k: 'chat', t: d0 + 9 * HOUR + MIN }, ...Array.from({ length: 8 }, (_, j) => act(d0 + 10 * HOUR + j * 5 * MIN))]), ...garbage(T0 - MIN)],
    'all-reacted': days.filter((d) => d < END_DAY).flatMap((d0) => Array.from({ length: 12 }, (_, j) => ({ k: 'nudge.reacted', t: d0 + (8 + j) * HOUR, key: 'k', afterMs: 1 }))),
    'all-ignored': days.filter((d) => d < END_DAY).flatMap((d0) => Array.from({ length: 12 }, (_, j) => ({ k: 'nudge.ignored', t: d0 + (8 + j) * HOUR, key: 'k' }))),
    'always-on': days.filter((d) => d < END_DAY).flatMap((d0) => Array.from({ length: 288 }, (_, j) => act(d0 + j * 5 * MIN))),
  };
  for (const [name, ev] of Object.entries(cases)) {
    const dir = freshDir();
    writeLog(dir, ev);
    for (const h of [0, 3, 9, 12, 20, 23]) {
      const v = createRhythm({ dataDir: dir, now: () => END_DAY + h * HOUR }).get();
      const bad = inBounds(v);
      ok(bad.length === 0, `bounds ${name} @${h}:00: every number inside A.5`, bad.join(' '));
    }
  }
  const ar = createRhythm({ dataDir: path.join(root, `p${n - 2}`), now: () => END_DAY + 9 * HOUR }).get();
  ok(ar.nudgeBudgetToday === 12, 'bounds all-reacted: budget clamps at 12', String(ar.nudgeBudgetToday));
  const ai = createRhythm({ dataDir: path.join(root, `p${n - 1}`), now: () => END_DAY + 9 * HOUR }).get();
  ok(ai.nudgeBudgetToday === 2, 'bounds all-ignored: budget clamps at 2', String(ai.nudgeBudgetToday));
  const ao = createRhythm({ dataDir: path.join(root, `p${n}`), now: () => END_DAY + 9 * HOUR }).get();
  ok(ao.quietSuggested === null && ao.checkinHours.length <= 4, 'bounds always-on: no quiet suggestion, <= 4 check-ins', JSON.stringify(ao.checkinHours));
}

// ---------- the live module: record, window, pause, reset, reactions ----------
{
  const dir = freshDir();
  let t = END_DAY + 9 * HOUR;
  const clock = () => t;
  // a line older than 90 days and an unreadable line are dropped when the log is opened
  writeLog(dir, [{ k: 'chat', t: t - 91 * DAY }, { k: 'chat', t: t - 10 * DAY }]);
  fs.appendFileSync(path.join(dir, 'rhythm', 'events.jsonl'), 'not json\n');
  const r = createRhythm({ dataDir: dir, now: clock });
  ok(r._test.events().length === 1, '90-day window: the old and the unreadable line are dropped at open');
  ok(fs.readFileSync(path.join(dir, 'rhythm', 'events.jsonl'), 'utf8').trim().split('\n').length === 1, '90-day window: the file is rewritten without them');
  ok(r.record('active') && r.record('active') === null, 'active: one event per 5-min bucket');
  const c = r.record('chat', { text: 'my secret plan', title: 'T-31 something' });
  ok(c && !('text' in c) && !('title' in c), 'chat: no text or title is stored (codes and stamps only)');
  ok(r.record('board.write', { task: 'has spaces and words' }).task === undefined && r.record('board.write', { task: 'T-31' }).task === 'T-31', 'board.write: only a code-shaped task id is kept');
  ok(r.record('nope') === null, 'unknown kind refused');
  r.record('nudge.said', { key: 'watch:W3b:T-31', kind: 'watch' });
  t += 3 * MIN; r.record('chat');
  ok(r._test.events().some((e) => e.k === 'nudge.reacted' && e.afterMs === 3 * MIN), 'a chat 3 min after a nudge -> nudge.reacted (afterMs 180000)');
  r.record('nudge.said', { key: 'watch:W1:T-31', kind: 'watch' });
  t += 29 * MIN; r.tick();
  ok(!r._test.events().some((e) => e.k === 'nudge.ignored'), 'no ignore before 30 min');
  t += 1 * MIN; r.tick();
  ok(r._test.events().some((e) => e.k === 'nudge.ignored' && e.key === 'watch:W1:T-31'), '30 min with no reaction -> nudge.ignored');
  r.pause(true);
  const before = r._test.events().length;
  t += 10 * MIN; r.record('chat'); r.record('active');
  ok(r._test.events().length === before && r.get().paused === true, 'paused: nothing is logged');
  ok(createRhythm({ dataDir: dir, now: clock }).get().paused === true, 'paused survives a restart (rhythm/state.json)');
  r.pause(false);
  ok(r.record('chat') !== null, 'unpaused: logging again');
  const after = r.reset();
  ok(!fs.existsSync(path.join(dir, 'rhythm')) && after.events === 0 && after.learning === true, 'reset deletes rhythm/ and starts from zero');
  // busyNow: active bucket now + a chat in the last 10 min, outside the cold start
  const bdir = freshDir();
  const NOW = END_DAY + 10 * HOUR;
  writeLog(bdir, days.filter((d) => d < END_DAY).flatMap((d0) => Array.from({ length: 12 }, (_, j) => act(d0 + 10 * HOUR + j * 5 * MIN))));
  let bt = NOW;
  const br = createRhythm({ dataDir: bdir, now: () => bt });
  ok(br.get().busyNow === false, 'busyNow false with no recent chat');
  br.record('active'); br.record('chat');
  ok(br.get().busyNow === true, 'busyNow true: active bucket + a chat in the last 10 min');
  bt += 11 * MIN;
  ok(br.get().busyNow === false, 'busyNow false 11 min later (new bucket, no chat)');
}

console.log(`\ncheck-rhythm: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
