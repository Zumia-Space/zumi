// Skills page gates (T-31 slice 2, SPEC-skills.md): plain Node, no DOM, no Electron. One line per gate, exit 1 on any
// failure. Covers AC-S1 (every node rebuilt from a signal fixture, table test) and the progress store: AC-L2, AC-A2,
// AC-A3, AC-A6, AC-S7. GOLDEN formula tests (AC-A1 / AC-L1) are deliberately absent: their constants are placeholders
// until owner item (3). AC-A2 / AC-A3 read the two cap numbers from constants.js (PLACEHOLDER.CLOSE_DAY_CAP, CLOSE_TOUCH_CAP), so they follow
// the owner's answer instead of freezing 30 and 5.
//   node scripts/check-skills.mjs
import { derive, lvlOf, closenessOf } from '../src/renderer/next/skills/derive.js';
import { NODES, BRANCHES, MAX_LVL } from '../src/renderer/next/skills/catalog.js';
import { createProgressStore, upgrade, freshState, isReadOnlyRun, RUN_MODE_FLAGS, localDate, dayMinus } from '../src/renderer/next/skills/store.js';
import { PROGRESS_KEY, WRITE_EVERY_MS, PLACEHOLDER as P } from '../src/renderer/next/skills/constants.js';
import { rolesOf, gestureCount, modelLine, levelPct, ringLit, xpSegments } from '../src/renderer/next/skills/page.js';
import { t, TABLES } from '../src/renderer/i18n.js';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (cond, name, detail) => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`); } };

// ---------- catalog shape ----------
ok(NODES.length === 8, 'catalog: 8 nodes in the first cut (Talk 2, Crew 4, Body 2)', NODES.map((n) => n.id));
ok(JSON.stringify(BRANCHES.map((b) => b.id)) === '["talk","crew","body","mind"]' && BRANCHES.find((b) => b.id === 'mind').requires === 'memory',
  'catalog: branches talk/crew/body + mind behind the memory capability');
ok(NODES.every((n) => n.thresholds.length === MAX_LVL && n.thresholds.every((x, i) => i === 0 || x > n.thresholds[i - 1])),
  'catalog: every node has MAX_LVL strictly rising thresholds');
ok(NODES.every((n) => !n.parent || NODES.some((p) => p.id === n.parent && p.branch === n.branch)), 'catalog: every parent exists in the same branch');
ok(NODES.filter((n) => n.kind === 'base').map((n) => n.id).join() === 'talk.chat' && NODES.find((n) => n.kind === 'base').thresholds[0] === 0,
  'catalog: Chat is the only base node and starts lit (threshold 0)');
ok(lvlOf(0, [1, 5, 15]) === 0 && lvlOf(5, [1, 5, 15]) === 2 && lvlOf(999, [1, 5, 15]) === 3, 'lvlOf: thresholds reached, capped at MAX_LVL');

// ---------- AC-S1: table test, signal fixture -> every node ----------
// Each row: fixture, then the expected "status:lvl" (+ "~" when resting) for all 8 nodes in catalog order:
// chat, conversation, orchestrator, plan, check, lookup, touch, gesture.
const on = { plan: { on: true }, check: { on: true }, lookup: { on: true } };
const TABLE = [
  ['fresh profile (AC-S2: only the base node lit)', {}, 'learned:1 available:0 available:0 locked:0 locked:0 locked:0 available:0 available:0'],
  ['a week of chat, 10 turns', { days: 7, turns: 10 }, 'learned:2 learned:1 available:0 locked:0 locked:0 locked:0 available:0 available:0'],
  ['30 days, 1000 turns', { days: 30, turns: 1000 }, 'learned:3 learned:3 available:0 locked:0 locked:0 locked:0 available:0 available:0'],
  ['first Plan call opens the crew', { days: 1, turns: 1, calls: { plan: 1 }, roles: on }, 'learned:1 available:0 learned:1 learned:1 available:0 available:0 available:0 available:0'],
  ['crew of 50 calls, Look up only', { days: 1, calls: { lookup: 50 }, roles: on }, 'learned:1 available:0 learned:2 available:0 available:0 learned:2 available:0 available:0'],
  ['AC-S3: Check off after 25 calls -> resting, level kept', { days: 2, calls: { check: 25 }, roles: { ...on, check: { on: false } } }, 'learned:1 available:0 learned:1 available:0 learned:2~ available:0 available:0 available:0'],
  ['Check off before it was ever used: not resting, just available', { days: 2, calls: { plan: 1 }, roles: { ...on, check: { on: false } } }, 'learned:1 available:0 learned:1 learned:1 available:0 available:0 available:0 available:0'],
  ['no provider yet (roles null): never resting', { calls: { check: 25 }, roles: null }, 'learned:1 available:0 learned:1 available:0 learned:2 available:0 available:0 available:0'],
  ['100 touches, 15 gestures', { touches: 100, gestures: 15 }, 'learned:1 available:0 available:0 locked:0 locked:0 locked:0 learned:3 learned:3'],
  ['AC-S4: gesture cache cleared, held level 2 kept', { gestures: 0, held: { 'body.gesture': 2 } }, 'learned:1 available:0 available:0 locked:0 locked:0 locked:0 available:0 learned:2'],
  ['held levels never exceed MAX_LVL', { held: { 'body.touch': 9 } }, 'learned:1 available:0 available:0 locked:0 locked:0 locked:0 learned:3 available:0'],
  ['garbage counts read as 0', { days: -3, turns: NaN, touches: '7', calls: null }, 'learned:1 available:0 available:0 locked:0 locked:0 locked:0 available:0 available:0'],
];
for (const [name, fixture, want] of TABLE) {
  const got = derive(fixture).nodes.map((n) => `${n.status}:${n.lvl}${n.resting ? '~' : ''}`).join(' ');
  ok(got === want, `AC-S1 ${name}`, { got, want });
}

// ---------- closeness: the shown distance to the next tier is the CLOSE_TIERS distance (constants read, no literals) ----------
{
  const T = P.CLOSE_TIERS;
  const probes = [0, 1, T[1] - 1, T[1], T[2] - 0.5, T[T.length - 1] - 1, T[T.length - 1], T[T.length - 1] + 500];
  const bad = probes.filter((pt) => { const c = closenessOf(pt); const top = pt >= T[T.length - 1]; const want = top ? null : Math.ceil(T[c.tier] - pt); return c.toNext !== want || (!top && !(pt >= T[c.tier - 1] && pt < T[c.tier])); });
  ok(bad.length === 0, 'closeness: tier and toNext come from CLOSE_TIERS points alone (null at the top tier)', bad.map((pt) => [pt, closenessOf(pt)]));
  ok(closenessOf(T[1] - 1).toNext === 1 && closenessOf(T[1]).tier === 2, 'closeness: one point short shows "1 more", the threshold itself is the next tier');
  const i18n = ['en', 'vi', 'zh'].map((l) => TABLES[l]['skills.nextTierPts']);
  ok(i18n.every((x) => /{n}/.test(x)) && !i18n.some((x) => /Lv|[Cc]ấp|等级|level/.test(x)), 'closeness: the next-tier line names points, never a level (en / vi / zh)', i18n);
}

// ---------- node fields ----------
{
  const v = derive({ days: 7, turns: 10, touches: 3 });
  const conv = v.nodes.find((n) => n.id === 'talk.conversation');
  ok(conv.count === 10 && conv.next === 100 && conv.maxLvl === MAX_LVL, 'node: count and next threshold', conv);
  const max = derive({ touches: 100 }).nodes.find((n) => n.id === 'body.touch');
  ok(max.next === null && max.lvl === MAX_LVL, 'node: next is null at the top level', max);
  ok(v.learned === 3 && v.total === 8, 'view: learned / total counts', { learned: v.learned, total: v.total });
  ok(v.nodes.every((n) => n.label === `skills.node.${n.id}` && n.how === `skills.how.${n.id}`), 'node: labels are i18n keys only (no text in the catalog)');
  ok(JSON.stringify(derive({}).nodes) === JSON.stringify(derive({}).nodes), 'derive: pure (same fixture, same output)');
}

// ---------- AC-S6 (capability): Mind hidden without window.zumi.memory ----------
ok(!derive({ memory: false }).branches.some((b) => b.id === 'mind') && derive({}).branches.length === 3, 'AC-S6: no memory API -> Mind branch hidden');
ok(derive({ memory: true }).branches.some((b) => b.id === 'mind'), 'AC-S6: memory API present -> Mind branch listed');


// ---------- progress store (step 1): fake storage, fake clock ----------
const at = (date, h = 12) => { const [y, m, d] = date.split('-').map(Number); return new Date(y, m - 1, d, h).getTime(); };
function fakeStorage(seed) {
  const m = new Map(seed ? [[PROGRESS_KEY, seed]] : []);
  const st = { sets: 0, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { st.sets++; m.set(k, String(v)); }, raw: () => m.get(PROGRESS_KEY) ?? null };
  return st;
}
const clock = (date) => { const c = { ms: at(date), now: () => c.ms, set(d) { c.ms = at(d); }, adv(ms) { c.ms += ms; } }; return c; };
const timers = () => { const t = { fns: [], set: (fn) => { t.fns.push(fn); return t.fns.length; }, clear: (id) => { t.fns[id - 1] = null; }, run() { const f = t.fns.filter(Boolean); t.fns = []; f.forEach((fn) => fn()); } }; return t; };
const rows = (date, n, kind) => ({ date, kind, calls: n });
const usage = (today, ...r) => ({ today, rows: r });
const ROLES_ON = { plan: { on: true }, check: { on: true }, lookup: { on: true } };
// the page's path: store totals -> derive (with held + live roles) -> recordView
const view = (st, extra = {}) => derive({ ...st.totals(), held: st.held(), ...extra });
const snap = (st, extra) => { const v = view(st, extra); return { v, r: st.recordView(v) }; };
const node = (v, id) => v.nodes.find((n) => n.id === id);

{
  // AC-A2: more turns than the daily cap in one day give exactly the cap; AC-A3: far more pokes than the touch cap give at most the touch cap.
  const TURNS = P.CLOSE_DAY_CAP + 10, POKES = Math.ceil(P.CLOSE_TOUCH_CAP / P.CLOSE_TOUCH_WEIGHT) + 20;
  const st = createProgressStore({ storage: fakeStorage(), now: clock('2026-10-27').now });
  st.mergeUsage(usage('2026-10-27', rows('2026-10-27', TURNS, 'chat')));
  ok(st.totals().points === P.CLOSE_DAY_CAP && st.totals().turns === TURNS && st.totals().days === 1, 'AC-A2: more turns than the daily cap in one day = the cap', st.totals());
  const st2 = createProgressStore({ storage: fakeStorage(), now: clock('2026-10-27').now });
  for (let i = 0; i < POKES; i++) st2.addTouch();
  ok(st2.totals().points <= P.CLOSE_TOUCH_CAP && st2.totals().touches === POKES && st2.totals().days === 0, 'AC-A3: many pokes = at most the touch cap (and no day counted without a turn)', st2.totals());
  const st3 = createProgressStore({ storage: fakeStorage(), now: clock('2026-10-27').now });
  st3.mergeUsage(usage('2026-10-27', rows('2026-10-27', TURNS, 'chat')));
  for (let i = 0; i < POKES; i++) st3.addTouch();
  ok(st3.totals().points === P.CLOSE_DAY_CAP, 'AC-A2: touches on top of a full day add nothing (the daily cap holds)', st3.totals());
  st3.mergeUsage(usage('2026-10-27', rows('2026-10-27', 80, 'chat')));
  const once = st3.totals().turns;
  st3.mergeUsage(usage('2026-10-27', rows('2026-10-27', 80, 'chat')));
  ok(once === 80 && st3.totals().turns === 80, 'a repeated usage sync never double counts (max-merge per date)', { once });
  st3.mergeUsage(usage('2026-10-27', rows('2026-10-27', 50, 'chat')));
  ok(st3.totals().turns === 80, 'a smaller later sync (ledger trimmed, clock skew) never lowers a count (max-merge per date)', st3.totals());
  const sj = createProgressStore({ storage: fakeStorage(), now: clock('2026-10-27').now });
  sj.mergeUsage(usage('2026-10-27', rows('2026-10-27', 9, 'jev'), rows('2026-10-27', 2, 'plan')));
  ok(sj.totals().turns === 0 && sj.totals().calls.plan === 2 && sj.totals().days === 0, 'jev reflex calls are not turns; plan rows feed the crew count', sj.totals());
}

// AC-L2: the level is monotone under every signal drop and under a clock set backwards.
{
  const c = clock('2026-10-01');
  const st = createProgressStore({ storage: fakeStorage(), now: c.now });
  st.mergeUsage(usage('2026-10-01', rows('2026-10-01', 40, 'chat'), rows('2026-10-01', 25, 'check'), rows('2026-10-01', 3, 'plan')));
  st.setGestures(15);
  for (let i = 0; i < 100; i++) st.addTouch();
  const first = snap(st, { roles: ROLES_ON });
  ok(first.v.learned >= 5 && node(first.v, 'crew.check').lvl === 2 && node(first.v, 'body.gesture').lvl === 3, 'L2 setup: a used profile reads as expected', first.v.nodes.map((n) => `${n.id}:${n.lvl}`));
  const off = snap(st, { roles: { ...ROLES_ON, check: { on: false } } });
  const ck = node(off.v, 'crew.check');
  ok(ck.resting && ck.lvl === 2 && ck.status === 'learned' && off.r.level === first.r.level && off.v.learned === first.v.learned,
    'AC-S3 / AC-L2: role off -> node resting, still learned, level and header count unchanged', { off: off.r, first: first.r });
  st.setGestures(0); // avatar change: the live gesture cache is empty again
  const av = snap(st, { roles: ROLES_ON });
  ok(node(av.v, 'body.gesture').lvl === 3 && av.r.level === first.r.level, 'AC-S4 / AC-L2: gesture cache cleared -> Gesture composer level unchanged', node(av.v, 'body.gesture'));
  c.set('2026-11-01'); // 31 days later: the old day has left the 30-day window of usage.summary
  st.mergeUsage(usage('2026-11-01', rows('2026-11-01', 1, 'chat')));
  const gap = snap(st, { roles: ROLES_ON });
  ok(gap.r.level >= first.r.level && gap.v.learned >= first.v.learned && st.totals().days === 2 && st.totals().turns === 41 && node(gap.v, 'crew.check').lvl === 2,
    'AC-L2: a 31-day gap (old day left the 30-day window) loses nothing', { totals: st.totals(), level: gap.r.level });
  const pointsBefore = st.totals().points;
  c.set('2026-10-10'); // clock set backwards
  st.mergeUsage(usage('2026-10-10', rows('2026-11-01', 1, 'chat')));
  for (let i = 0; i < 20; i++) st.addTouch();
  const back = snap(st, { roles: ROLES_ON });
  ok(back.r.level >= gap.r.level && st.totals().days === 2 && st.totals().turns === 41, 'AC-L2: clock set backwards keeps the level, days and turns', st.totals());
  ok(st.totals().points - pointsBefore <= P.CLOSE_TOUCH_CAP, 'AC-L2: touches on the earlier (new) date key earn that date at most the touch cap', { pointsBefore, after: st.totals().points });
  c.set('2026-11-02'); // forward again, the same rows come back
  st.mergeUsage(usage('2026-11-02', rows('2026-11-01', 1, 'chat')));
  ok(st.totals().turns === 41 && st.totals().days === 2, 'AC-L2: clock forward again and the rows come back -> no double count', st.totals());
}
{
  // a day that already folded can never earn again, even when the clock returns to it
  const c = clock('2026-10-01');
  const st = createProgressStore({ storage: fakeStorage(), now: c.now });
  st.mergeUsage(usage('2026-10-01', rows('2026-10-01', 40, 'chat')));
  c.set('2026-11-15');
  st.mergeUsage(usage('2026-11-15', rows('2026-11-15', 2, 'chat')));
  const t1 = st.totals();
  ok(st.snapshot().foldedThrough === '2026-10-01' && t1.points === P.CLOSE_DAY_CAP + 2 && t1.days === 2, 'fold: an old day folds into the running total and keeps its points', { t1, ft: st.snapshot().foldedThrough });
  c.set('2026-10-01');
  st.mergeUsage(usage('2026-10-01', rows('2026-10-01', 90, 'chat')));
  for (let i = 0; i < 50; i++) st.addTouch();
  const t2 = st.totals();
  ok(t2.points === t1.points && t2.turns === t1.turns && t2.touches === t1.touches && t2.days === t1.days, 'AC-L2: clock back onto a folded day earns nothing (the day cap is not earned twice)', { t1, t2 });
  const lv = [];
  const c2 = clock('2026-01-01');
  const s2 = createProgressStore({ storage: fakeStorage(), now: c2.now });
  let last = 0, dropped = false;
  for (const d of ['2026-01-01', '2026-01-02', '2026-03-01', '2026-02-01', '2026-05-01', '2026-01-02', '2026-06-01']) {
    c2.set(d);
    s2.mergeUsage(usage(d, rows(d, 30, 'chat')));
    const { r } = snap(s2);
    lv.push(r.level);
    if (r.level < last) dropped = true;
    last = r.level;
  }
  ok(!dropped, 'AC-L2: player level is monotone over a scrambled clock', lv);
}

// AC-A6: values survive a reload (a new store on the same storage); counts only; upgrade hook.
{
  const c = clock('2026-10-27');
  const storage = fakeStorage();
  const st = createProgressStore({ storage, now: c.now });
  st.mergeUsage(usage('2026-10-27', rows('2026-10-27', 12, 'chat'), rows('2026-10-27', 3, 'lookup')));
  for (let i = 0; i < 4; i++) st.addTouch();
  st.setGestures(6);
  const a = snap(st, { roles: ROLES_ON });
  st.flush();
  const st2 = createProgressStore({ storage, now: c.now });
  const b = snap(st2, { roles: ROLES_ON });
  ok(JSON.stringify(st2.totals()) === JSON.stringify(st.totals()) && JSON.stringify(st2.held()) === JSON.stringify(st.held()) && st2.since() === st.since() && a.r.level === b.r.level,
    'AC-A6: totals, node levels, since and level survive a reload', { before: st.totals(), after: st2.totals() });
  ok(storage.raw() !== null && JSON.parse(storage.raw()).v === 1, 'store: one key, v:1');
  const strings = [];
  const walk = (x) => { if (typeof x === 'string') strings.push(x); else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) { strings.push(k); walk(v); } };
  walk(JSON.parse(storage.raw()));
  const allowed = new Set(['v', 'since', 'foldedThrough', 'days', 'folded', 'gestures', 'skills', 'level', 'turns', 'plan', 'check', 'lookup', 'touches', 'points', 'lvl', 'at']);
  const bad = strings.filter((x) => !allowed.has(x) && !/^\d{4}-\d{2}-\d{2}$/.test(x) && !NODES.some((n) => n.id === x));
  ok(bad.length === 0, 'store: counts only (every string is a key name, a date or a node id)', bad);
  ok(JSON.stringify(upgrade(null).state) === JSON.stringify(freshState()) && upgrade('{bad').writable && upgrade('{"v":0}').writable, 'upgrade: missing / corrupt / v0 -> fresh state, writable');
  const newer = upgrade('{"v":2,"level":9}');
  ok(!newer.writable && newer.state.level === 1, 'upgrade: a NEWER version reads as fresh and is never written back');
  const keepNewer = fakeStorage('{"v":2,"level":9}');
  const sn = createProgressStore({ storage: keepNewer, now: c.now });
  sn.mergeUsage(usage('2026-10-27', rows('2026-10-27', 5, 'chat')));
  sn.flush();
  ok(keepNewer.sets === 0 && keepNewer.raw() === '{"v":2,"level":9}', 'upgrade: a newer-version profile is left byte for byte as it was');
  const junk = upgrade(JSON.stringify({ v: 1, level: -4, days: { x: { turns: 5 }, '2026-01-01': { turns: 'a', plan: -1 } }, skills: { 'a b': { lvl: 3 }, 'talk.chat': { lvl: 2.7 } }, folded: { turns: 'z' } })).state;
  ok(junk.level === 1 && Object.keys(junk.days).join() === '2026-01-01' && junk.days['2026-01-01'].turns === 0 && Object.keys(junk.skills).join() === 'talk.chat' && junk.skills['talk.chat'].lvl === 2 && junk.folded.turns === 0,
    'upgrade: a damaged v1 record is cleaned, never trusted', junk);
}

// write throttle: at most once a minute, at once on a level-up
{
  const c = clock('2026-10-27');
  const storage = fakeStorage();
  const tm = timers();
  const st = createProgressStore({ storage, now: c.now, setTimer: tm.set, clearTimer: tm.clear });
  st.mergeUsage(usage('2026-10-27', rows('2026-10-27', 1, 'chat')));
  ok(storage.sets === 1, 'throttle: the first change writes at once', storage.sets);
  for (let i = 0; i < 30; i++) { c.adv(1000); st.addTouch(); }
  ok(storage.sets === 1 && tm.fns.filter(Boolean).length === 1, 'throttle: 30 changes inside a minute write nothing more and queue exactly one write', { sets: storage.sets, queued: tm.fns.filter(Boolean).length });
  c.adv(WRITE_EVERY_MS);
  tm.run();
  ok(storage.sets === 2, 'throttle: the queued write lands when the minute is up', storage.sets);
  c.adv(1000);
  st.addTouch();
  const sets0 = storage.sets;
  st.mergeUsage(usage('2026-10-27', rows('2026-10-27', 500, 'chat'), rows('2026-10-27', 300, 'plan'), rows('2026-10-27', 300, 'check'), rows('2026-10-27', 300, 'lookup')));
  const r = st.recordView(view(st, { roles: ROLES_ON }));
  ok(r.levelUp && r.level > 1 && storage.sets === sets0 + 1, 'throttle: a level-up writes at once, inside the minute', { r, sets0, sets: storage.sets });
}

// AC-S7: self-test, demo, shots, probe and stress runs write NOTHING.
{
  const c = clock('2026-10-27');
  const storage = fakeStorage('{"v":1,"level":3}');
  const before = storage.raw();
  const st = createProgressStore({ storage, now: c.now, readOnly: true });
  st.mergeUsage(usage('2026-10-27', rows('2026-10-27', 500, 'chat'), rows('2026-10-27', 300, 'plan')));
  for (let i = 0; i < 10; i++) st.addTouch();
  st.setGestures(9);
  st.recordView(view(st));
  st.flush();
  c.adv(5 * WRITE_EVERY_MS);
  ok(storage.sets === 0 && storage.raw() === before && !st.writable, 'AC-S7: a read-only store never calls setItem, even on a level-up and flush', { sets: storage.sets });
  ok(RUN_MODE_FLAGS.every((k) => isReadOnlyRun({ [k]: true })) && !isReadOnlyRun({ version: '1', packaged: true, demoFixture: 'x', demoReflexOnly: false, wardrobeShotsProgressOnly: false }) && isReadOnlyRun(null),
    'AC-S7: every run-mode flag makes the page read-only; a normal run does not; no info = read-only');
  // the list covers every harness flag main.js exposes in app:info (a new --x-shots flag that is not listed fails here)
  const main = readFileSync(new URL('../src/main/main.js', import.meta.url), 'utf8');
  const block = main.slice(main.indexOf("ipcMain.handle('app:info'"), main.indexOf("ipcMain.handle('models:list'"));
  const flags = [...block.matchAll(/^\s{2}(\w+): Boolean\(/gm)].map((m) => m[1]).filter((k) => /^(selftest|demo|\w*Shots|\w*Probe|\w*Stress)$/.test(k));
  ok(flags.length >= 6 && flags.every((k) => RUN_MODE_FLAGS.includes(k)) && RUN_MODE_FLAGS.every((k) => flags.includes(k)), 'AC-S7: RUN_MODE_FLAGS matches the harness flags in main.js app:info', { flags });
  const mem = createProgressStore({ now: c.now });
  mem.mergeUsage(usage('2026-10-27', rows('2026-10-27', 1, 'chat')));
  mem.flush();
  ok(mem.totals().turns === 1 && !mem.writable, 'store: no storage object -> in-memory only, no throw');
}
ok(localDate(at('2026-03-01')) === '2026-03-01' && dayMinus('2026-03-01', 1) === '2026-02-28' && dayMinus('2026-01-01', 1) === '2025-12-31', 'dates: local day keys and dayMinus cross month and year edges');


// ---------- page helpers (step 3): signals in, text out; no DOM ----------
{
  ok(rolesOf(null) === null && rolesOf({ provider: null, roles: {} }) === null, 'signals: roles.get without a provider -> null (nothing can be resting)');
  const r = rolesOf({ provider: { label: 'x' }, roles: { plan: { model: 'a/b', on: true }, check: { model: 'c/d', on: false }, lookup: { model: 'e/f' } } });
  ok(r.plan.on && !r.check.on && r.lookup.on && r.check.model === 'c/d', 'signals: roles.get -> on/off per helper (a missing flag means on)', r);
  ok(gestureCount(JSON.stringify({ entries: [1, 2, 3] })) === 3 && gestureCount('x') === 0 && gestureCount(null) === 0 && gestureCount('{}') === 0, 'signals: gesture-cache text -> entry count, anything unreadable -> 0');
  // AC-S5: model NAMES only. The line is built from the provider's name for the id, and falls back to a readable name.
  const view = derive({ calls: { check: 3 }, roles: { plan: { on: true }, check: { on: true }, lookup: { on: true } } });
  const check = view.nodes.find((n) => n.id === 'crew.check');
  const line = modelLine(check, { check: { on: true, model: 'deepseek/deepseek-v4-flash' } });
  ok(line === 'Runs on Deepseek V4 Flash.' && !/[/:]|deepseek-v4/.test(line), 'AC-S5: the crew line shows a model name, never the id', line);
  ok(modelLine(check, { check: { on: true, model: 'x/y' } }, () => 'Gemini 3.7 Pro') === 'Runs on Gemini 3.7 Pro.', 'AC-S5: the provider\'s own model name wins when given');
  ok(modelLine(view.nodes.find((n) => n.id === 'talk.chat'), { check: { model: 'x/y' } }) === '' && modelLine(check, null) === '', 'AC-S5: non-crew nodes and no provider show no model line');
  // header count = nodes with level >= 1, in every fixture (the concept board said "5 learned" for 6 such nodes)
  const fixtures = [{}, { days: 7, turns: 10 }, { days: 30, turns: 1000, touches: 100, gestures: 15, calls: { plan: 1, check: 25, lookup: 50 } }, { held: { 'body.touch': 2, 'crew.plan': 3 } }, { turns: 9, touches: 1 }];
  ok(fixtures.every((f) => { const v = derive(f); return v.learned === v.nodes.filter((n) => n.lvl >= 1).length && v.learned === v.nodes.filter((n) => n.status === 'learned').length; }), 'header: "learned" is exactly nodes with level >= 1');
  ok(levelPct({ xp: 350, from: 300, to: 600 }) === 17 && levelPct({ xp: 0, from: 0, to: 100 }) === 0 && levelPct({ xp: 5, from: 5, to: 5 }) === 0, 'header: xp bar share');
  ok(xpSegments(0).join() === ',,,,,,,,,' && xpSegments(100).every((x) => x === 'on') && xpSegments(65).join() === 'on,on,on,on,on,on,half,,,' && xpSegments(36).filter((x) => x === 'on').length === 3 && xpSegments(36).filter((x) => x === 'half').length === 1 && xpSegments(250).length === 10, 'header: ten xp segments, on / half / off at the nearest half segment');
  ok(ringLit(0) === 0 && ringLit(62) === 19 && ringLit(100) === 30 && ringLit(250) === 30, 'header: the ring lights whole segments out of 30');
  // i18n: every key the page can ask for exists in all three tables, and no key text is the key itself
  const need = ['nav.skills', 'skills.tag', 'skills.count', 'skills.lv', 'skills.xp', 'skills.closeness', 'skills.since', 'skills.sinceNone', 'skills.daysUsed', 'skills.nextTierPts', 'skills.topTier', 'skills.lvOf', 'skills.detail.model',
    ...BRANCHES.map((b) => b.label), ...NODES.flatMap((n) => [n.label, n.how]), ...['locked', 'available', 'resting'].map((x) => 'skills.status.' + x), ...[1, 2, 3, 4, 5].map((i) => 'skills.tier.' + i)];
  const missing = need.filter((k) => !['en', 'vi', 'zh'].every((l) => typeof TABLES[l][k] === 'string' && TABLES[l][k].length > 0));
  ok(missing.length === 0, 'i18n: en / vi / zh carry every Skills key (nav, branches, nodes, how-lines, status, tiers)', missing);
  ok(t('nav.skills') === 'Skills' && TABLES.vi['nav.skills'] === 'Kỹ năng' && TABLES.zh['nav.skills'] === '技能', 'i18n: Skills / Kỹ năng / 技能');
  ok(Object.keys(TABLES.en).filter((k) => /^skills\.(node|how)\./.test(k) && /[A-Za-z0-9-]+\/[A-Za-z0-9-]/.test(TABLES.en[k])).length === 0, 'AC-S5: no model id shape in any en node text');
}

// ---------- ADR 2026-10-27 (path flag): every Skills hook lives in next/boot.js; app.js and index.html carry none ----------
{
  const read = (f) => readFileSync(new URL(f, import.meta.url), 'utf8');
  const app = read('../src/renderer/app.js'), html = read('../src/renderer/index.html'), boot = read('../src/renderer/next/boot.js'), page = read('../src/renderer/next/skills/page.js');
  ok(!/skills/i.test(app) && !/skills/i.test(html), 'next/ guard: app.js and index.html hold no Skills import, hook, tab or section (the only next/ hook is the guarded boot.js loader)');
  ok(/import \{ initSkills \} from '\.\/skills\/page\.js'/.test(boot) && /btn\.dataset\.next = 'skills'/.test(boot) && /next-skills-head/.test(boot) && /next-skills-tree/.test(boot), 'next/ guard: boot.js imports the page and creates the Skills item (data-next) and its two cards over the stage');
  ok(/if \(!skills\) return;\s*engine\.on\('reaction'/.test(boot), 'next/ guard: the touch hook in boot.js runs only when initSkills returned a handle');
  ok(/\[data-next="skills"\]/.test(page) && !/\.hidden = false/.test(page), 'next/ guard: page.js finds the boot-made item and no longer un-hides a shipped tab');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
