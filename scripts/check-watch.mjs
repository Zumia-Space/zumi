// check:watch (T-31 alpha.12, PLAN-ZUMI-WATCH v2 F rows 3-4). Plain Node, fixtures only: no board, no network, no model.
//   1. fixture board with one stale row -> exactly one inbox.submit + one spoken line; the same state again -> nothing
//   2. W1 / W3b / W4 thresholds; a cleared finding is dropped, never announced
//   3. inbox once per key (2xx only, retry, cap, one at a time); rhythm-driven batchMs (one "N things" turn), nudgeBudgetToday cap
//   4. watchLevel off -> no relay, no line, empty card; the dedupe memo survives a restart
//   5. the real speech scheduler: a `watch` line at Normal, dropped at Quiet; rhythm check-in hours + the W6 count
//   6. said.jsonl: 10 lines kept, the 11th drops the oldest; written from the scheduler ack through agent-core
//   7. hud-host carries `watch` in 'hud:feed' and hands every good read to onState
import fs from 'node:fs';
import path from 'node:path';
import { checkOutDir } from './lib/check-out-dir.mjs';
import { runRules, inboxLine, ownerSignals, W1_LAG_MS } from '../src/main/watch-rules.mjs';
import { createWatchHost } from '../src/main/watch-host.mjs';
import { createSaidLog, RING_MAX } from '../src/main/said-log.mjs';
import { createSpeechScheduler } from '../src/main/speech-scheduler.mjs';
import { createAgentCore } from '../src/main/agent-core.mjs';
import { createHudHost } from '../src/main/hud-host.mjs';

let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`); } };
const MIN = 60_000, HOUR = 60 * MIN;
const T0 = new Date(2026, 10, 1, 11, 0, 0).getTime(); // Sun 01-11 11:00 local
const iso = (t) => new Date(t).toISOString();
const root = checkOutDir('check-watch');

/** A board with T-31 (8 active steps, Now fresh) and F-04 (one active step, fresh): exactly one stale row (W3b).
 *  Board stamps are fixed (relative to T0), as on a real board; `at` is only the read time a caller passes along. */
function board({ activeT31 = 8, w1 = false, w4Age = null, w4Role = 'owner', waiting = [] } = {}) {
  const at = T0;
  const steps = Array.from({ length: 10 }, (_, i) => ({ id: `T-31/s${i}`, label: `step ${i}`, state: i < activeT31 ? 'active' : 'todo' }));
  const times = { 'T-31/s0': { transitions: [{ at: iso(at - 3 * HOUR), from: 'todo', to: 'active' }] } };
  if (w1) times['T-31/s9'] = { transitions: [{ at: iso(at - 40 * MIN), from: 'todo', to: 'active' }] };
  const messages = w4Age == null ? [] : [{ id: 'fb-77', task_id: 'T-31', author: { name: 'owner', role: w4Role }, ts: iso(at - w4Age), needs_receipt: true, status: 'open' }];
  return {
    tasks: [
      { id: 'T-31', title: 'Zumi desktop app', status: 'active', text_at: iso(at - (w1 ? 2 * HOUR : 2 * HOUR)), steps },
      { id: 'F-04', title: 'Wardrobe', status: 'active', text_at: iso(at - HOUR), steps: [{ id: 'F-04/a', state: 'active' }] },
      { id: 'X-01', title: 'Closed one', status: 'closed', text_at: iso(at - 99 * HOUR), steps: Array.from({ length: 9 }, (_, i) => ({ id: `X-01/s${i}`, state: 'active' })) },
    ],
    times, messages, asks: [], attention: { waiting },
  };
}

function harness({ cad = {}, settings = {}, memo = null, clock = { t: T0 }, status = () => 200 } = {}) {
  const relays = []; const says = [];
  const host = createWatchHost({
    relay: async (body) => { relays.push({ op: 'inbox.submit', body }); return { status: status() }; },
    say: (kind, payload) => { says.push({ kind, payload }); return { action: 'speak' }; },
    rhythm: () => ({ batchMs: 30 * MIN, repeatMs: 2 * HOUR, receiptMs: HOUR, nudgeBudgetToday: 6, ...cad }),
    settings: () => settings, memo, now: () => clock.t,
  });
  return { host, relays, says, clock };
}

// ---------- 1. the plan's verify line ----------
{
  const h = harness();
  await h.host.onState(board());
  ok(h.relays.length === 1 && h.relays[0].op === 'inbox.submit', 'fixture board -> exactly one inbox.submit', h.relays);
  ok(h.relays[0].body.target_id === 'T-31' && h.relays[0].body.data.kind === 'report' && h.relays[0].body.data.text.startsWith('[zumi-watch W3b] T-31: 8 steps active'), 'inbox item: target T-31, kind report, plain [zumi-watch W3b] line', h.relays[0].body);
  ok(h.says.length === 1 && h.says[0].kind === 'watch' && h.says[0].payload.rule === 'W3b' && h.says[0].payload.c === 8, 'fixture board -> exactly one spoken watch line (W3b, 8 active)', h.says);
  h.clock.t += 20_000;
  await h.host.onState(board({ at: h.clock.t }));
  ok(h.relays.length === 1 && h.says.length === 1, 'same state 20 s later -> nothing new (no relay, no line)', { relays: h.relays.length, says: h.says.length });
  ok(h.host.feed().length === 1 && h.host.feed()[0].rule === 'W3b' && h.host.count() === 1, 'HUD card: one open finding');
  ok(!JSON.stringify(h.relays).includes('Zumi desktop app'), 'the inbox line carries codes and counts, not the task title');
}

// ---------- 2. rule thresholds ----------
{
  const w1 = runRules(board({ activeT31: 1, w1: true }), { at: T0 }).findings;
  ok(w1.length === 1 && w1[0].rule === 'W1' && w1[0].step === 's9', 'W1: a step change 80 min after the Now text -> finding', w1);
  const lag = board({ activeT31: 1 });
  lag.times['T-31/s9'] = { transitions: [{ at: iso(Date.parse(lag.tasks[0].text_at) + W1_LAG_MS - MIN), to: 'active' }] };
  ok(runRules(lag, { at: T0 }).findings.length === 0, 'W1: a step change 29 min after the Now text -> no finding');
  const noText = board({ activeT31: 1, w1: true }); delete noText.tasks[0].text_at;
  ok(runRules(noText, { at: T0 }).findings.length === 0, 'W1: no text_at on the row -> no finding (never guessed)');
  ok(runRules(board({ activeT31: 3 }), { at: T0 }).findings.length === 0, 'W3b: 3 active steps -> no finding');
  ok(runRules(board({ activeT31: 4 }), { at: T0 }).findings[0].c === 4, 'W3b: 4 active steps -> finding');
  ok(!runRules(board(), { at: T0 }).findings.some((f) => f.task === 'X-01'), 'a closed task is never checked');
  const w4 = runRules(board({ activeT31: 1, w4Age: 2 * HOUR }), { at: T0, receiptMs: HOUR }).findings;
  ok(w4.length === 1 && w4[0].rule === 'W4' && w4[0].key === 'W4:T-31:fb-77', 'W4: owner answer 2 h old, receipt threshold 1 h -> finding', w4);
  ok(runRules(board({ activeT31: 1, w4Age: 30 * MIN }), { at: T0, receiptMs: HOUR }).findings.length === 0, 'W4: 30 min old -> no finding');
  ok(runRules(board({ activeT31: 1, w4Age: 2 * HOUR }), { at: T0, receiptMs: 3 * HOUR }).findings.length === 0, 'W4: the threshold comes from the caller (rhythm receiptMs 3 h)');
  ok(runRules(board({ activeT31: 1, w4Age: 2 * HOUR, w4Role: 'coordinator' }), { at: T0 }).findings.length === 0, 'W4: a coordinator message never counts');
  ok(runRules(board({ waiting: [{ id: 'a' }, { id: 'b' }] }), { at: T0 }).waitingCount === 2, 'W6: the waiting count for the check-in line');
  ok(inboxLine(w4[0]).startsWith('[zumi-watch W4] T-31: owner answer fb-77'), 'W4 inbox line names the message id, no owner text');
  const h = harness();
  await h.host.onState(board());
  await h.host.onState(board({ activeT31: 2 }));
  ok(h.host.feed().length === 0 && h.relays.length === 1 && h.says.length === 1, 'a finding that clears is dropped, never announced');
}

// ---------- 3. cadence from the rhythm core ----------
{
  // REVIEW F1: every inbox write resets the task's board activity, so a repeat would hide the board's stall signal.
  const h = harness({ cad: { repeatMs: HOUR } });
  await h.host.onState(board());
  await new Promise((r) => setImmediate(r));
  h.clock.t += 48 * HOUR; await h.host.onState(board({ at: h.clock.t }));
  ok(h.relays.length === 1 && h.says.length === 1, 'one inbox item per key, ever: 48 h later the open finding is not re-sent', { r: h.relays.length, s: h.says.length });
  let code = 401;
  const f = harness({ status: () => code });
  await f.host.onState(board());
  await new Promise((r) => setImmediate(r));
  f.clock.t += 9 * MIN; await f.host.onState(board());
  ok(f.relays.length === 1, 'a refused relay (locked board) is not retried before 10 min', String(f.relays.length));
  f.clock.t += 2 * MIN; code = 200; await f.host.onState(board());
  await new Promise((r) => setImmediate(r));
  ok(f.relays.length === 2, 'a refused relay is retried after 10 min', String(f.relays.length));
  f.clock.t += 60 * MIN; await f.host.onState(board());
  ok(f.relays.length === 2, 'once it got a 2xx it is never sent again', String(f.relays.length));
  const many = board();
  for (let i = 0; i < 8; i++) many.tasks.push({ id: `M-${i}`, title: `m${i}`, status: 'active', text_at: iso(T0), steps: Array.from({ length: 4 }, (_, k) => ({ id: `M-${i}/s${k}`, state: 'active' })) });
  const cap = harness();
  await cap.host.onState(many);
  await new Promise((r) => setImmediate(r));
  ok(cap.relays.length === 5, 'at most 5 inbox items per poll', String(cap.relays.length));
  await cap.host.onState(many);
  await new Promise((r) => setImmediate(r));
  ok(cap.relays.length === 9, 'the rest go on the next poll', String(cap.relays.length));
  // one send at a time (the bridge's request_id is the millisecond clock)
  let cur = 0, peak = 0, sent = 0;
  const ser = createWatchHost({ relay: async () => { cur++; peak = Math.max(peak, cur); await new Promise((r) => setTimeout(r, 2)); cur--; sent++; return { status: 200 }; }, say: () => ({ action: 'speak' }), rhythm: () => ({}), settings: () => ({}), now: () => T0 });
  await ser.onState(many);
  for (let i = 0; i < 100 && sent < 5; i++) await new Promise((r) => setTimeout(r, 20));
  ok(sent === 5 && peak === 1, 'relays go one at a time', { sent, peak });
  const none = createWatchHost({ say: () => ({ action: 'speak' }), rhythm: () => ({}), settings: () => ({}), now: () => T0 });
  const nr = await none.onState(board());
  ok(nr.relayed.length === 0 && none.feed().length === 1, 'no relay handed (public build): no inbox attempt, the card still works');
  const own = board({ activeT31: 1 });
  own.messages = [{ id: 'fb-9', task_id: 'T-31', body: '[zumi-watch W3b] T-31: 8 steps active', author: { role: 'owner' }, ts: iso(T0 - 2 * HOUR), needs_receipt: true }];
  ok(runRules(own, { at: T0 }).findings.length === 0, 'the watcher\'s own merged line never becomes a W4 finding');
  const sigA = ownerSignals(null, { attention: { waiting: [] }, asks: [], messages: [] });
  ok(ownerSignals(sigA.snapshot, own).writes.length === 0, 'the watcher\'s own merged line is not an owner board write');

  const b = harness({ cad: { batchMs: 30 * MIN } });
  await b.host.onState(board());                                 // W3b spoken at T0
  b.clock.t += 5 * MIN; await b.host.onState(board({ at: b.clock.t, w1: true, w4Age: 2 * HOUR }));
  ok(b.says.length === 1 && b.host.count() === 3, 'batchMs: two new findings 5 min after a turn wait for the batch window', b.says.length);
  b.clock.t += 25 * MIN; await b.host.onState(board({ at: b.clock.t, w1: true, w4Age: 2 * HOUR }));
  ok(b.says.length === 2 && b.says[1].payload.n === 2, 'batchMs: at 30 min they go out as ONE turn ("2 things")', b.says[1]);
  await new Promise((r) => setImmediate(r));
  ok(b.relays.length === 3, 'the inbox side is not batched: one item per finding at once', String(b.relays.length));

  const c = harness({ cad: { nudgeBudgetToday: 1, batchMs: 15 * MIN } });
  await c.host.onState(board());
  c.clock.t += 20 * MIN; await c.host.onState(board({ at: c.clock.t, w1: true }));
  ok(c.says.length === 1 && c.relays.length === 2, 'nudgeBudgetToday 1: the second turn is not spoken; the inbox item still goes', { s: c.says.length, r: c.relays.length });
}

// ---------- 4. off switch + restart memo ----------
{
  const off = harness({ settings: { watchLevel: 'off' } });
  const r = await off.host.onState(board());
  ok(r.off === true && off.relays.length === 0 && off.says.length === 0 && off.host.feed().length === 0 && off.host.count() === 0, 'watchLevel off: no relay, no line, empty card');
  let store = null;
  const memo = { load: () => store, save: (m) => { store = JSON.parse(JSON.stringify(m)); } };
  const a = harness({ memo });
  await a.host.onState(board());
  await new Promise((r) => setImmediate(r)); // the 2xx is what records the key
  const b = harness({ memo, clock: { t: T0 + 5 * MIN } });
  await b.host.onState(board({ at: T0 + 5 * MIN }));
  ok(a.relays.length === 1 && b.relays.length === 0 && b.says.length === 0, 'restart: the memo keeps a relayed/spoken key from being repeated', { a: a.relays.length, b: b.relays.length, s: b.says.length });
}

// ---------- 5. the real scheduler ----------
{
  const mk = (level, extra = {}) => {
    const st = { t: new Date(2026, 10, 2, 10, 0, 0).getTime() };
    const emitted = [];
    const sched = createSpeechScheduler({
      prefs: () => ({ talkLevel: level, talkQuietHours: { on: false, start: '22:30', end: '07:30' } }),
      signals: () => ({ idleSec: 10, windowVisible: true, waitingCount: 1, watchCount: 2 }),
      now: () => st.t, emit: (l) => emitted.push(l), ...extra,
    });
    return { st, emitted, sched };
  };
  const n = mk('normal');
  const r = n.sched.enqueue('watch', { rule: 'W3b', title: 'Zumi desktop app', c: 8 });
  ok(r.action === 'speak' && n.emitted[0].kind === 'watch' && n.emitted[0].text === 'Zumi desktop app has 8 steps active at once. Which one is current?', 'Normal: a watch finding becomes one spoken line', n.emitted[0]);
  const q = mk('quiet');
  ok(q.sched.enqueue('watch', { rule: 'W3b', title: 'x', c: 8 }).reason === 'class_not_allowed', 'Quiet: watch lines are not in the class list (P3)');
  // rhythm check-in hours: 08:10 with checkinHours [8] -> one check-in naming the open findings (W6)
  const ci = mk('normal', { checkinHours: () => [8, 20] });
  ci.st.t = new Date(2026, 10, 2, 8, 10, 0).getTime();
  ci.sched.tick(); // 08:10: the morning line goes first
  ci.st.t += 4 * MIN; ci.sched.tick(); // 08:14: past the 3-min gap, the 08:00 check-in
  const line = ci.emitted.find((e) => e.kind === 'checkin');
  ok(line && line.text === "It's 8 AM. 1 things need your answer and 2 need a second look.", 'rhythm check-in at 08:00 with the waiting + watch counts (W6)', line);
  const dflt = mk('normal');
  dflt.st.t = new Date(2026, 10, 2, 8, 10, 0).getTime();
  dflt.sched.tick();
  ok(!dflt.emitted.some((e) => e.kind === 'checkin'), 'without checkinHours the 08:00 tick says nothing (12:00/16:00 default unchanged)');
  dflt.st.t = new Date(2026, 10, 2, 12, 5, 0).getTime(); dflt.sched.tick();
  ok(dflt.emitted.some((e) => e.kind === 'checkin'), 'without checkinHours 12:00 still checks in');
  const saidSeen = [];
  const s = mk('normal', { onSaid: (x) => saidSeen.push(x) });
  s.sched.enqueue('watch', { rule: 'W3b', title: 'Zumi desktop app', c: 8 });
  s.sched.ack(s.emitted[0].sayId, { spoken: true });
  ok(saidSeen.length === 1 && saidSeen[0].kind === 'watch' && saidSeen[0].text.startsWith('Zumi desktop app has 8'), 'scheduler ack (spoken) -> onSaid with kind + shown text', saidSeen);
  s.st.t += 10 * MIN;
  s.sched.enqueue('watch', { rule: 'W1', title: 'Zumi desktop app', step: 's9' });
  s.sched.ack(s.emitted[1].sayId, { spoken: false });
  ok(saidSeen.length === 1, 'an unspoken ack is not a said line');
}

// ---------- 6. said.jsonl ring ----------
{
  const dir = path.join(root, 'said'); fs.mkdirSync(dir, { recursive: true });
  const log = createSaidLog({ dataDir: dir });
  for (let i = 1; i <= 11; i++) log.append({ t: T0 + i, kind: 'watch', text: `line ${i}` });
  const lines = fs.readFileSync(path.join(dir, 'said.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  ok(RING_MAX === 10 && lines.length === 10, 'said.jsonl: 10 lines kept', String(lines.length));
  ok(lines[0].text === 'line 2' && lines[9].text === 'line 11', 'said.jsonl: the 11th line dropped the oldest (line 1)', `${lines[0].text}..${lines[9].text}`);
  ok(lines.every((l) => Object.keys(l).join(',') === 't,kind,text'), 'said.jsonl: {t, kind, text} only');
  // through agent-core + the scheduler, as the hosts wire it
  const cdir = path.join(root, 'core'); fs.mkdirSync(cdir, { recursive: true });
  let settings = { talkLevel: 'normal', talkQuietHours: { on: false, start: '22:30', end: '07:30' } };
  const clock = { t: new Date(2026, 10, 2, 10, 0, 0).getTime() };
  const emitted = [];
  let sched = null;
  const relays = [];
  const core = createAgentCore({
    dataDir: cdir, settings: () => settings, saveSettings: (p) => { settings = { ...settings, ...p }; return settings; },
    idleSeconds: () => 5, now: () => clock.t, say: (k, p) => sched.enqueue(k, p),
    relay: async (op, body) => { relays.push({ op, body }); return { status: 200 }; },
  });
  sched = createSpeechScheduler({ prefs: () => settings, signals: () => ({ idleSec: 10, windowVisible: true, watchCount: core.watchCount() }), now: () => clock.t, emit: (l) => emitted.push(l), onSaid: core.onSaid, checkinHours: core.checkinHours });
  await core.onBoardState(board({ at: clock.t }));
  ok(relays.length === 1 && relays[0].op === 'inbox.submit' && emitted.length === 1 && emitted[0].kind === 'watch', 'agent-core: one board read -> one relay (op fixed to inbox.submit by agent-core) + one watch line', { r: relays.length, e: emitted.length });
  sched.ack(emitted[0].sayId, { spoken: true });
  const saidFile = path.join(cdir, 'said.jsonl');
  ok(fs.existsSync(saidFile) && JSON.parse(fs.readFileSync(saidFile, 'utf8').trim()).kind === 'watch', 'agent-core: the ack wrote said.jsonl');
  ok(core._test.rhythm._test.events().some((e) => e.k === 'nudge.said' && e.kind === 'watch'), 'agent-core: the ack logged nudge.said in the rhythm');
  ok(JSON.stringify(core.checkinHours()) === '[12,16]', 'agent-core: check-in hours are the v1 [12, 16] while the rhythm is learning');
  core._test.sample();
  ok(core._test.rhythm._test.events().some((e) => e.k === 'active'), 'agent-core: an idle sample under 60 s logs `active`');
  // owner signals: an ask leaves waiting answered -> ask.answered with its created time
  const s1 = ownerSignals(null, { attention: { waiting: [{ kind: 'ask', id: 'ask-1' }] }, asks: [{ id: 'ask-1', status: 'open' }], messages: [] });
  const s2 = ownerSignals(s1.snapshot, { attention: { waiting: [] }, asks: [{ id: 'ask-1', status: 'answered', attribution: { created_at: iso(T0) } }], messages: [{ author: { role: 'owner' }, ts: iso(T0 + MIN), task_id: 'T-31' }] });
  ok(s1.answered.length === 0 && s2.answered.length === 1 && s2.answered[0].askCreatedAt === T0, 'ownerSignals: baseline silent, then one answered ask with its created time');
  ok(s2.writes.length === 1 && s2.writes[0].task === 'T-31', 'ownerSignals: a new owner message is one board.write');
  const off = core.handlers['watch.setLevel']('off');
  ok(off.watchLevel === 'off' && settings.watchLevel === 'off', 'watch.setLevel off persists watchLevel');
  const before = relays.length;
  clock.t += 3 * HOUR;
  await core.onBoardState(board({ at: clock.t }));
  ok(relays.length === before && core.watchFeed().length === 0, 'agent-core with watchLevel off: no relay, empty card');
  ok(core.handlers['watch.setLevel']('loud').watchLevel === 'off', 'watch.setLevel refuses an unknown level');
}

// ---------- 7. hud-host carries the watch list ----------
{
  const sent = []; const seen = [];
  const hud = createHudHost({
    getState: async () => ({ ok: true, state: board() }), idleSeconds: () => 0,
    settings: { get: () => ({ hudStyle: 'a' }), set: () => {} }, send: (p) => sent.push(p),
    decide: () => ({ action: 'refuse' }), open: async () => {},
    onState: (s) => { seen.push(s); }, watchFeed: () => [{ rule: 'W3b', task: 'T-31' }],
  });
  await hud.poll({ maxAgeMs: 0 });
  ok(seen.length === 1 && Array.isArray(seen[0].tasks), 'hud-host: a good read is handed to onState');
  ok(sent.length === 1 && Array.isArray(sent[0].watch) && sent[0].watch[0].rule === 'W3b', "hud-host: 'hud:feed' carries `watch`");
  const plain = []; const hud2 = createHudHost({ getState: async () => ({ ok: true, state: board() }), idleSeconds: () => 0, settings: { get: () => ({ hudStyle: 'a' }), set: () => {} }, send: (p) => plain.push(p), decide: () => ({}), open: async () => {} });
  await hud2.poll({ maxAgeMs: 0 });
  ok(plain.length === 1 && !('watch' in plain[0]), 'hud-host without a watcher: payload unchanged (no watch key)');
}

// ---------- 8. the real board code (vendored Laneboard, scratch folder, in process): the body is accepted, the view drives the rules ----------
{
  const { createBoard } = await import(new URL('../vendor/laneboard/src/board.mjs', import.meta.url).href);
  const dataDir = path.join(root, 'scratch-board'); fs.mkdirSync(dataDir, { recursive: true });
  const b = createBoard({ dataDir });
  const owner = b.ownerCredential;
  let n = 0;
  const w = (op, target_id, data, extra = {}) => b.write(owner, { version: 1, request_id: `check-watch-${++n}`, op, target_id, data, ...extra });
  w('task.create', 'T-31', { title: 'Zumi desktop app', status: 'doing', lane: 'Pi', steps: Array.from({ length: 5 }, (_, i) => ({ id: `s${i}`, label: `step ${i}`, zone: 'build', state: 'active' })) });
  const results = [];
  const core = createAgentCore({
    dataDir: path.join(root, 'scratch-core'), settings: () => ({ talkLevel: 'normal' }), saveSettings: (p) => p,
    say: () => ({ action: 'speak' }), now: () => Date.now(),
    relay: async (op, body) => { const r = b.write(owner, { version: 1, request_id: `zumi-relay-check-${++n}`, op, ...body }); results.push({ op, r }); return { status: r && r.ok === false ? 400 : 200 }; },
  });
  await core.onBoardState(b.view(owner));
  await new Promise((r) => setImmediate(r));
  const items = Object.values(b.state.inbox);
  ok(results.length === 1 && results[0].op === 'inbox.submit' && items.length === 1, 'real board: the relay body is accepted as one inbox item', JSON.stringify(results.map((x) => x.r)));
  ok(items[0] && items[0].task_id === 'T-31' && items[0].kind === 'report' && items[0].text.startsWith('[zumi-watch W3b] T-31: 5 steps active'), 'real board: kind report, plain line, on the task', JSON.stringify(items[0]));
  await core.onBoardState(b.view(owner));
  await new Promise((r) => setImmediate(r));
  ok(Object.values(b.state.inbox).length === 1, 'real board: the same state again adds nothing');
  ok(core.watchFeed()[0] && core.watchFeed()[0].rule === 'W3b' && core.watchFeed()[0].c === 5, 'real board: the HUD card shows the finding from the real view');
  w('step.update', 'T-31/s0', { state: 'done' }, { expected_revision: b.state.steps['T-31/s0'].rev });
  const t = b.state.times['T-31/s0'];
  ok(t && Array.isArray(t.transitions) && t.transitions.length > 0 && typeof t.transitions[t.transitions.length - 1].at === 'string', 'real board: a step change is recorded as times[...].transitions[].at (the W1 input)', JSON.stringify(t));
  ok(typeof b.view(owner).tasks[0].text_at === 'string', 'real board: the view carries text_at (the W1 input)');
}

console.log(`\ncheck-watch: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
