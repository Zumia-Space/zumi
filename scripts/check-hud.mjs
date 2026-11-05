// Talk-camera HUD gates (T-31 hud-react, 13-10; talk-mode rewiring 19-10), plain Node, no Electron, nothing opened,
// no network:
//   1. dedupe + batch      the same board read twice reports nothing; one read with several changes is one reaction;
//                          a burst during the cooldown is merged into the next reaction
//   2. consent gate        nothing opens without OK; No / unknown / used / expired ids open nothing; the open
//                          allowlist (board-open.mjs) is enforced again at open time; user activity is never consent
//   3. default HUD = Off   no stored setting -> off: no board read, no feed, no reaction; index.html ships it hidden
//   4. interaction logic   rect -> NDC (A1), state -> variant (A2), click throttle (B5)
//   5. A2 end to end       a finished step reaches the renderer as reaction.state 'done'
//   6. inline answers      the ask.answer body shape, owner-only gating, the locked state and double-answer handling
//   7. RELAY loop path     a real loopback bridge: the upstream body + the zumi-relay- request_id; gates stop it early
//   8. renderer wiring     the controls exist only for kind:'ask' in the owner build and stay reachable (source guard)
//   9. talk-mode rewiring  the poll runs on HUD style != Off OR talkActive(); 'hud:feed' is sent only with a style on;
//                          onReaction/onBoardStatus fire; lastStepLabel carries the done step (PLAN sections 2, 6, 7)
//   node scripts/check-hud.mjs   (exit 1 on any failure)
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { extractRefs, buildHudFeed, createUpdateTracker, createBurstBatcher, createConsentGate, hudPrefs, pickAcceptanceRef, MAX_STEPS, MAX_LOG, MAX_WAITING } from '../src/main/hud-feed.mjs';
import { createHudHost } from '../src/main/hud-host.mjs';
import { decideOpenRef, OPEN_ROOTS } from '../src/main/board-open.mjs';

// Every test path derives from the owner roots, so this file names no folder of its own.
const [R0, R1] = OPEN_ROOTS;
const RK = R0.slice(0, R0.slice(0, -1).lastIndexOf('/') + 1); // the roots' common parent
const win = (p) => p.split('/').join(String.fromCharCode(92));
const [W0, W1, WK] = [R0, R1, RK].map(win);
import { rectToNdc, lookTarget, reactionLook, stateToVariant, REACTION_VARIANTS, CARD_ARM_VARIANTS, CARD_ARM_LEFT_VARIANTS, CARD_FLOAT_LEFT_VARIANTS, CARD_ARM_VARIANT_IDS, hudCardRect, createClickThrottle } from '../src/renderer/hud/hud-logic.js';
import * as hudLogic from '../src/renderer/hud/hud-logic.js'; // namespace: the answer-draft helpers (T-31 fix round 1610 r3)
import { LOOK_TARGETS } from '../src/renderer/reflex/schema.js';
import { askAnswerData, buildAskAnswer, answerOutcome, createAskAnswerer, ASK_ANSWER_VERDICTS, ASK_ANSWER_TEXT_MAX } from '../src/main/hud-answer.mjs';
import { createBridge } from '../src/main/board-bridge.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (cond, name, detail) => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`); } };

// ---------- fixture board state (boardView shape, owner view) ----------
const iso = (m) => new Date(Date.UTC(2026, 9, 13, 8, m)).toISOString();
function state({ t31At = iso(10), f04At = iso(5), asks = [] } = {}) {
  return {
    tasks: [
      { id: 'T-31', title: 'Zumi agent', status: 'active', rev: 4, last_activity_at: t31At, current_step: { id: 'hud', label: 'HUD hologram', state: 'active' },
        steps: [{ id: 'hud', label: 'HUD hologram', state: 'active', detail: `Shots ready\n\`${R0}t31/hud-react-1310/hud-a.png\` · [preview](http://127.0.0.1:4320/)` }] },
      { id: 'F-04', title: 'Wardrobe', status: 'active', rev: 2, last_activity_at: f04At, current_step: { id: 's1', label: 'Round 4', state: 'waiting' }, steps: [] },
      { id: 'OLD-1', title: 'Closed one', status: 'closed', rev: 9, last_activity_at: iso(30), current_step: null, steps: [] },
    ],
    attention: { waiting: asks },
  };
}
const ask = (id, rev = 1, task = 'F-04', text = `Pick a look\n[sheet](https://evil.example/x.png) · \`${R1}F-04/sheet.png\``) => ({ kind: 'ask', id, task_id: task, text, rev, since: iso(1) });

// The panel fields (T-31 hud-panels, PLAN section 2): one task in the REAL board shape -- step ids carry the
// `TASK/STEP` key the projection stores (vendor/laneboard/src/ops.mjs), roles come from resolveRoles.
function panelState({ stepCount = 3, times, goal, now, health = 'yellow', lane = 'Pi CoS', asks = [] } = {}) {
  const steps = Array.from({ length: stepCount }, (_, i) => ({
    id: `T-31/s${i}`, label: `Step ${i}`, sub: i === 1 ? 'half (50,4%)' : '', state: i === 0 ? 'done' : i === 1 ? 'active' : 'todo',
  }));
  const task = {
    id: 'T-31', title: 'Panel task', status: 'doing', rev: 7, lane, health,
    goal: goal ?? 'Ship the panels', now: now ?? '22-10 15:55: wiring', last_activity_at: iso(10),
    current_step: { id: 'T-31/s1', label: 'Step 1', state: 'active' },
    roles: {
      plan: { model: 'opus', effort: 'high', by: 'coordinator' }, code: { model: 'deepseek', effort: 'high', by: 'owner' },
      review: { model: 'opus', effort: 'high', by: 'default' }, scout: { model: 'haiku', effort: 'low', by: 'coordinator' },
    },
    steps,
  };
  const state = { tasks: [task], attention: { waiting: asks } };
  if (times !== false) state.times = times ?? {};
  return state;
}

// ---------- refs ----------
{
  const r = extractRefs(`Body\n[preview](http://127.0.0.1:4320/) · \`${R0}a.png\` · notes \`${W1}b.md\`\n![x](media/m.png)`);
  ok(r.length === 3 && r.some((x) => x.kind === 'url') && r[1].kind === 'local' && r[1].target === `${R0}a.png` && r[2].label === 'notes' && r[2].target === `${R1}b.md`, 'refs: trailing ref line parsed (url, local, labelled local), board media left out', r);
  const feed = buildHudFeed(state());
  ok(feed.updates.length === 2 && feed.updates[0].id === 'T-31' && !feed.updates.some((u) => u.id === 'OLD-1'), 'feed: open tasks only, most recent first', feed.updates.map((u) => u.id));
  ok(feed.updates[0].refs.length === 2 && feed.updates[0].step === 'HUD hologram' && feed.updates[0].stepState === 'active', 'feed: step + state + the current step\'s refs', feed.updates[0]);
}

// ---------- 1c. panel fields (T-31 hud-panels, PLAN section 2) ----------
// The extra row fields the new T1/T2/T3 panels render, all derived from GET /api/v1/state inside the pure buildHudFeed
// (the one freeze exception: no IPC, no main/board change). Board text is BOARD text -- these fields are never edited.
{
  const row = (s) => buildHudFeed(s).updates[0];
  const base = row(panelState());
  const types = { goal: 'string', now: 'string', health: 'string', lane: 'string', roles: 'object', steps: 'object', stepTotal: 'number', askCount: 'number', log: 'object', doneAts: 'object' };
  ok(Object.entries(types).every(([k, ty]) => typeof base[k] === ty) && Array.isArray(base.steps) && Array.isArray(base.log) && Array.isArray(base.doneAts),
    'panel: every section-2 row field exists with the right type', Object.fromEntries(Object.entries(types).map(([k]) => [k, typeof base[k]])));

  ok(base.goal === 'Ship the panels' && base.now === '22-10 15:55: wiring' && base.health === 'yellow' && base.lane === 'Pi CoS',
    'panel: goal / now / health / lane come from the task row', { goal: base.goal, now: base.now, health: base.health, lane: base.lane });
  ok(base.roles.code === 'deepseek' && base.roles.review === 'opus' && Object.keys(base.roles).length === 2,
    'panel: roles carry exactly the code and review model names', base.roles);
  ok(row(panelState({ health: 'purple' })).health === '' && row(panelState({ health: null })).health === '',
    'panel: a health outside green/yellow/red/grey is "" (never shown raw)');
  ok(row(panelState({ lane: 'x'.repeat(60) })).lane.length === 40, 'panel: lane is capped at 40 chars');

  ok(base.steps.length === 3 && base.steps[0].label === 'Step 0' && base.steps[0].state === 'done'
    && base.steps[1].state === 'active' && base.steps[1].sub === 'half (50,4%)' && base.steps[2].sub === '' && base.stepTotal === 3,
    'panel: steps carry id/label/sub/state in board order (sub "" when the board has none), stepTotal the true total', base.steps);
  const many = row(panelState({ stepCount: 45 }));
  ok(MAX_STEPS === 40 && many.steps.length === MAX_STEPS && many.stepTotal === 45,
    'panel: steps capped at 40 while stepTotal keeps the true count', { shown: many.steps.length, total: many.stepTotal });

  const six = Array.from({ length: 6 }, (_, i) => ask(`ask-${i}`, 1, 'T-31'));
  const asked = buildHudFeed(panelState({ asks: six }));
  ok(asked.waiting.length === MAX_WAITING && asked.waitingCount === 6 && asked.updates[0].askCount === 6,
    'panel: askCount is the exact per-task ask count, past the 4-row waiting cap', { rows: asked.waiting.length, count: asked.waitingCount, askCount: asked.updates[0].askCount });
  const sixState = panelState({ asks: six });
  const other = buildHudFeed({ ...sixState, tasks: [...sixState.tasks, { id: 'F-04', title: 'Other', status: 'doing', rev: 1, last_activity_at: iso(9), current_step: null, steps: [] }] });
  ok(other.updates.find((u) => u.id === 'F-04').askCount === 0 && other.updates.find((u) => u.id === 'T-31').askCount === 6,
    'panel: askCount is filtered by task id', other.updates.map((u) => [u.id, u.askCount]));

  // log: every step transition of the task, oldest first, the last MAX_LOG; the label comes from the task's own steps.
  const at = (m, s = 0) => new Date(Date.UTC(2026, 9, 13, 9, m, s)).toISOString();
  const trans = Array.from({ length: 14 }, (_, i) => ({ at: at(i + 1), from: i % 2 ? 'active' : 'waiting', to: i % 2 ? 'waiting' : 'active' }));
  const withLog = row(panelState({ times: { 'T-31/s1': { transitions: trans }, 'T-31/s2': { transitions: [{ at: at(30), from: 'todo', to: 'done' }] } } }));
  ok(withLog.log.length === MAX_LOG && MAX_LOG === 12, 'panel: log capped at the last 12 transitions', withLog.log.length);
  const stamps = withLog.log.map((l) => Date.parse(l.at));
  ok(stamps.every((v, i) => i === 0 || v >= stamps[i - 1]) && withLog.log[withLog.log.length - 1].at === at(30),
    'panel: log is sorted oldest-first from every step of the task, newest last', withLog.log.map((l) => l.at));
  ok(withLog.log.every((l) => l.stepId === 'T-31/s1' || l.stepId === 'T-31/s2') && withLog.log.some((l) => l.label === 'Step 2' && l.to === 'done') && withLog.log.some((l) => l.label === 'Step 1' && l.from === 'waiting'),
    'panel: a log line takes its label from the task step and keeps from/to/stepId', withLog.log.slice(-2));
  ok(JSON.stringify(withLog.doneAts) === JSON.stringify([at(30)]), 'panel: doneAts holds the ISO time of every transition to done', withLog.doneAts);

  // A synthetic bare step id (the shape the other fixtures use) still finds its `${task}/${step}` times record.
  const bare = buildHudFeed({
    tasks: [{ id: 'B-1', title: 'Bare', status: 'doing', rev: 1, last_activity_at: iso(10), current_step: { id: 's1', label: 'One', state: 'active' }, steps: [{ id: 's1', label: 'One', state: 'active' }] }],
    attention: { waiting: [] }, times: { 'B-1/s1': { transitions: [{ at: at(5), from: 'todo', to: 'done' }] } },
  });
  ok(bare.updates[0].log.length === 1 && bare.updates[0].log[0].label === 'One', 'panel: times lookup uses `${task}/${step}` when the step id is bare', bare.updates[0].log);

  const noTimes = row(panelState({ times: false }));
  ok(noTimes.log.length === 0 && noTimes.doneAts.length === 0, 'panel: a state without times (public/anonymous view) gives empty log + doneAts', { log: noTimes.log, doneAts: noTimes.doneAts });

  const refGoal = `Ship it\n[${RK}a.png](https://x.example/a.png) dropped line\n\`${RK}b.png\` dropped line\nGoal tail`;
  const refNow = `${'n'.repeat(300)}\n[${RK}c.png](https://x.example/c.png) dropped`;
  const refsGone = row(panelState({ goal: refGoal, now: refNow }));
  ok(refsGone.goal === 'Ship it Goal tail', 'panel: goal drops ref lines (the waitOut.text filter, now one helper)', refsGone.goal);
  ok(refsGone.now.length === 240 && !refsGone.now.includes('dropped'), 'panel: now drops ref lines and is capped at 240 chars', { len: refsGone.now.length });

  // The dedupe key is untouched by the new fields: the same two reads still report nothing the second time.
  const tr = createUpdateTracker();
  tr.ingest(buildHudFeed(panelState({ times: { 'T-31/s1': { transitions: trans } } })));
  const again = tr.ingest(buildHudFeed(panelState({ times: { 'T-31/s1': { transitions: trans } } })));
  ok(!again.baseline && again.taskIds.length === 0 && again.doneIds.length === 0,
    'panel: the taskKey dedupe result is unchanged (same read twice reports nothing new)', again);
}

// ---------- 1. dedupe + batch ----------
{
  const tr = createUpdateTracker();
  const s0 = buildHudFeed(state());
  const a = tr.ingest(s0);
  ok(a.baseline && a.taskIds.length === 0, 'dedupe: the first read is the baseline (no reaction on launch / switch-on)', a);
  const b = tr.ingest(buildHudFeed(state()));
  ok(!b.baseline && b.taskIds.length === 0, 'dedupe: the same board read again reports nothing', b);
  const c = tr.ingest(buildHudFeed(state({ t31At: iso(20) })));
  ok(c.taskIds.length === 1 && c.taskIds[0] === 'T-31', 'dedupe: a task whose activity/revision changed is new', c);
  const d = tr.ingest(buildHudFeed(state({ t31At: iso(20) })));
  ok(d.taskIds.length === 0, 'dedupe: that same update read again is not reported twice', d);
  const e = tr.ingest(buildHudFeed(state({ t31At: iso(25), f04At: iso(26), asks: [ask('ask-7')] })));
  ok(e.taskIds.length === 2 && e.taskIds.includes('T-31') && e.taskIds.includes('F-04'), 'batch: several changes in one read are ONE reaction, task ids unique (F-04 activity + its new ask = one id)', e);
  const f = tr.ingest(buildHudFeed(state({ t31At: iso(25), f04At: iso(26), asks: [ask('ask-7', 2)] })));
  ok(f.taskIds.length === 1 && f.taskIds[0] === 'F-04', 'dedupe: a new revision of an ask is new', f);
  tr.reset();
  ok(tr.ingest(buildHudFeed(state({ t31At: iso(40) }))).baseline, 'dedupe: reset (HUD switched off and on) starts from a new baseline');

  // A2: the board's current_step never reports 'done' (it moves to the next step), so a completion is spotted by the
  // per-task done-step count, reported as doneIds.
  const dstate = (stepA) => ({ tasks: [
    { id: 'X-1', title: 'X', status: 'doing', rev: stepA === 'done' ? 2 : 1, last_activity_at: stepA === 'done' ? iso(20) : iso(10),
      current_step: stepA === 'done' ? { id: 'b', label: 'B', state: 'todo' } : { id: 'a', label: 'A', state: 'active' },
      steps: [{ id: 'a', label: 'A', state: stepA }, { id: 'b', label: 'B', state: 'todo' }] },
  ], attention: { waiting: [] } });
  const td = createUpdateTracker();
  td.ingest(buildHudFeed(dstate('active')));
  const rdone = td.ingest(buildHudFeed(dstate('done')));
  ok(rdone.taskIds.includes('X-1') && rdone.doneIds.includes('X-1'), 'dedupe: a step marked done is reported as a done update (doneIds), though current_step shows the next step', rdone);

  // A brand-new task that already carries done steps is an update, not a completion: its first sighting seeds the count
  // (nit 16-10); only a finish on a task already seen is a 'done'.
  const ntask = (rev, done) => ({ tasks: [
    { id: 'N-9', title: 'New', status: 'doing', rev, last_activity_at: iso(40 + rev),
      current_step: { id: 'n2', label: 'N2', state: 'active' },
      steps: [...Array.from({ length: done }, (_, i) => ({ id: `n${i}`, label: `N${i}`, state: 'done' })), { id: 'n2', label: 'N2', state: 'active' }] },
  ], attention: { waiting: [] } });
  const tn = createUpdateTracker();
  tn.ingest(buildHudFeed(state())); // baseline: T-31, F-04 (N-9 unknown)
  const first9 = tn.ingest(buildHudFeed(ntask(1, 2)));
  ok(first9.taskIds.includes('N-9') && !first9.doneIds.includes('N-9'), 'dedupe: a brand-new task with already-done steps is an update, not a completion (starts from its current count)', first9);
  const grew = tn.ingest(buildHudFeed(ntask(2, 3)));
  ok(grew.doneIds.includes('N-9'), 'dedupe: after its first sighting, a real finish on that task is a done update', grew);

  const bt = createBurstBatcher({ cooldownMs: 30000 });
  const first = bt.push(['T-31'], 1000);
  ok(JSON.stringify(first) === '["T-31"]', 'batch: the first update reacts at once', first);
  ok(bt.push(['F-04'], 5000) === null && bt.push(['T-31', 'F-04'], 9000) === null, 'batch: updates inside the cooldown are queued, not a second reaction');
  ok(bt.due(20000) === null, 'batch: nothing goes out before the cooldown ends');
  const merged = bt.due(31000);
  ok(JSON.stringify(merged) === '["T-31","F-04"]', 'batch: the burst goes out as one merged, de-duplicated reaction', merged);
  ok(bt.due(70000) === null && bt.push([], 80000) === null, 'batch: nothing pending -> nothing sent');
}

// ---------- 1b. inline answers (T-31 0.2.3 batch C): the feed carries id/rev/options, the host carries the state ----------
{
  const feedA = buildHudFeed(state({ asks: [ask('ask-7', 3)] }));
  ok(feedA.waiting[0].id === 'ask-7' && feedA.waiting[0].rev === 3 && feedA.waiting[0].options.length === 0, 'feed: a wait carries its record id + revision (an answer must name both) and its options', feedA.waiting[0]);
  const withOpts = buildHudFeed(state({ asks: [{ ...ask('ask-8', 2), options: [{ key: 'A', label: 'Friendly', desc: 'internal' }, { key: 'B', label: 'Formal' }] }] }));
  ok(withOpts.waiting[0].options.length === 2 && withOpts.waiting[0].options[0].key === 'A' && withOpts.waiting[0].options[0].label === 'Friendly' && !('desc' in withOpts.waiting[0].options[0]), 'feed: ask options carry key + label only', withOpts.waiting[0].options);

  let stA = {};
  const sentA = [];
  const hA = createHudHost({ getState: async () => ({ ok: true, state: state({ asks: [ask('ask-7', 3)] }) }), idleSeconds: () => 2, settings: { get: () => stA, set: (p) => { stA = { ...stA, ...p }; } }, send: (p) => sentA.push(p), decide: () => ({ action: 'refuse' }), open: async () => {}, pollMs: 3_600_000, cooldownMs: 0, getAnswerState: () => ({ owner: true, live: false }) });
  hA.setPrefs({ style: 'a' });
  await hA.poll();
  ok(sentA[sentA.length - 1].answer && sentA[sentA.length - 1].answer.owner === true && sentA[sentA.length - 1].answer.live === false, 'host: the feed carries the answer state (owner build, board locked -> the "enter the PIN" state)', sentA[sentA.length - 1].answer);
  hA.stop();
  const sentB = [];
  let stB = {};
  const hB = createHudHost({ getState: async () => ({ ok: true, state: state({ asks: [ask('ask-7', 3)] }) }), idleSeconds: () => 2, settings: { get: () => stB, set: (p) => { stB = { ...stB, ...p }; } }, send: (p) => sentB.push(p), decide: () => ({ action: 'refuse' }), open: async () => {}, pollMs: 3_600_000, cooldownMs: 0 });
  hB.setPrefs({ style: 'a' });
  await hB.poll();
  ok(sentB.length > 0 && sentB[sentB.length - 1].answer.owner === false, 'host: a host with no answer state defaults release-shaped (owner:false -> no controls)', sentB[sentB.length - 1] && sentB[sentB.length - 1].answer);
  hB.stop();
}

// ---------- 2. consent gate ----------
{
  const stubFs = { realpath: (p) => p.replace(/\//g, '\\'), stat: () => ({ isDirectory: () => false, isFile: () => true }) };
  const owner = (ref) => decideOpenRef(ref, { ownerAdmin: true, ...stubFs });
  let t = 0;
  const opened = [];
  const gate = createConsentGate({ decide: owner, open: async (d) => { opened.push(d); }, now: () => t, ttlMs: 120000 });
  const img = { kind: 'local', label: 'hud-a.png', target: `${R0}t31/hud-react-1310/hud-a.png` };
  const o1 = gate.offer(img, { taskId: 'T-31' });
  ok(!JSON.stringify(o1).includes(R0) && !JSON.stringify(o1).includes('hud-react-1310') && o1.target === 'hud-a.png', 'consent: the renderer gets an id + a display name, never the path', o1);
  ok(opened.length === 0, 'consent: an offer alone opens nothing');
  const no = await gate.answer(o1.id, false);
  ok(!no.opened && no.reason === 'declined' && opened.length === 0, 'consent: "No" opens nothing', no);
  const again = await gate.answer(o1.id, true);
  ok(!again.opened && again.reason === 'unknown_or_used' && opened.length === 0, 'consent: an answered offer cannot be re-used for OK', again);
  const ghost = await gate.answer('c999-x', true);
  ok(!ghost.opened && opened.length === 0, 'consent: an unknown id opens nothing', ghost);
  const o2 = gate.offer(img);
  t += 121000;
  const late = await gate.answer(o2.id, true);
  ok(!late.opened && late.reason === 'expired' && opened.length === 0, 'consent: OK after the offer expired opens nothing', late);
  const o3 = gate.offer(img);
  const yes = await gate.answer(o3.id, true);
  ok(yes.opened && opened.length === 1 && opened[0].action === 'openPath', 'consent: OK on a live offer opens it once, through the allowlist decision', { yes, opened });
  const nonBool = gate.offer(img);
  const truthy = await gate.answer(nonBool.id, 'yes');
  ok(!truthy.opened && opened.length === 1, 'consent: only a literal true is an OK', truthy);
  // the allowlist is re-checked at open time (a file outside the allowed folders, a refused host, a .exe, a release build)
  for (const [ref, why] of [
    [{ kind: 'local', target: 'C:/Windows/notepad.png' }, 'outside_allowed_folders'],
    [{ kind: 'local', target: `${R0}run.cmd` }, 'type_not_allowed'],
    [{ kind: 'local', target: `${R0}x.cmd:a.png` }, 'name_trick'],
    [{ kind: 'url', target: 'ftp://evil.example/x.png' }, 'url_not_allowed'],
    [{ kind: 'url', target: `file:///${R0}a.png` }, 'url_not_allowed'],
  ]) {
    const g = createConsentGate({ decide: (r) => (r === ref ? owner(r) : { action: 'openPath' }), open: async (d) => { opened.push(d); }, now: () => t });
    const o = g.offer(ref);
    const r = await g.answer(o.id, true);
    ok(!r.opened && r.reason === why && opened.length === 1, `consent: allowlist still enforced on OK -> ${why}`, r);
  }
  const release = decideOpenRef(img, { ownerAdmin: false, ...stubFs });
  ok(release.action === 'refuse' && release.reason === 'not_owner_build', 'consent: a release build never opens a local file', release);
  ok(owner({ kind: 'url', target: 'http://localhost:4320/' }).action === 'openExternal', 'consent: a loopback preview is openable (same rule as the board chips)');
  const pick = pickAcceptanceRef([{ kind: 'url', target: 'ftp://evil.example/' }, { kind: 'local', target: `${R0}a.md` }, { kind: 'local', target: `${R0}a.png` }], (r) => owner(r).action !== 'refuse');
  ok(pick && pick.target === `${R0}a.png`, 'consent: the offered item is the openable image first', pick);
  ok(pickAcceptanceRef([{ kind: 'url', target: 'ftp://evil.example/' }], (r) => owner(r).action !== 'refuse') === null, 'consent: nothing openable -> no prompt at all');
}

// ---------- 5. default HUD = Off + the host end to end ----------
{
  ok(hudPrefs({}).style === 'off' && hudPrefs(null).style === 'off' && hudPrefs({ hudStyle: 'zz' }).style === 'off', 'default: no / unknown setting -> style off', hudPrefs({}));
  ok(!('voiceMuted' in hudPrefs({})), 'default: hudPrefs no longer carries voiceMuted (the talk scheduler owns voice now)');
  const html = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');
  ok(/<div id="hud" class="hud" hidden data-style="off">/.test(html), 'default: index.html ships the HUD hidden, style off');
  ok(/<select id="hud-style"[^>]*>\s*<option value="off"/.test(html), 'default: the Settings dropdown lists Off first');
  ok(!/id="hud-voice"/.test(html), 'default: the HUD voice-notice switch is gone from Settings (talk level replaces it)');

  let stored = {};
  let reads = 0;
  let board = state();
  let idle = 2;
  const sent = [];
  const opened = [];
  const reactions = [];
  const stubFs = { realpath: (p) => p.replace(/\//g, '\\'), stat: () => ({ isDirectory: () => false, isFile: () => true }) };
  const host = createHudHost({
    getState: async () => { reads++; return { ok: true, state: board }; },
    idleSeconds: () => idle,
    settings: { get: () => stored, set: (p) => { stored = { ...stored, ...p }; } },
    send: (p) => sent.push(p),
    decide: (ref) => decideOpenRef(ref, { ownerAdmin: true, ...stubFs }),
    open: async (d) => { opened.push(d); },
    onReaction: (rr) => reactions.push(rr),
    pollMs: 3_600_000, cooldownMs: 0,
  });
  host.start();
  await host.poll();
  ok(reads === 0 && sent.length === 0, 'default: HUD off -> the board is never read and nothing is sent', { reads, sent: sent.length });
  host.setPrefs({ style: 'a' });
  await host.poll();
  ok(reads >= 1 && sent.length >= 1 && sent.every((p) => p.reaction === null) && sent[sent.length - 1].feed.updates.length === 2, 'host: switched on -> feed painted, the first read is a baseline (no reaction)', sent.map((p) => p.reaction));
  board = state({ t31At: iso(50) });
  await host.poll();
  const r = sent[sent.length - 1].reaction;
  ok(r && JSON.stringify(r.taskIds) === '["T-31"]' && !('voice' in r), 'host: a new update -> one reaction (no voice field; the scheduler speaks)', r);
  ok(r && r.primary === 'T-31' && r.source === 'updates' && r.state === 'active' && r.title === 'Zumi agent' && r.step === 'HUD hologram', 'host: the reaction names the focus card, its list, state, title and step (A1/A2 + talk-mode)', r && { primary: r.primary, source: r.source, state: r.state, title: r.title, step: r.step });
  ok(r && r.consent && r.consent.kind === 'local' && r.consent.target === 'hud-a.png', 'host: the update carries an openable image -> a consent offer (name only)', r && r.consent);
  ok(reactions.length >= 1 && reactions[reactions.length - 1].primary === 'T-31', 'host: the reaction is handed to main via onReaction', reactions.map((x) => x.primary));
  ok(opened.length === 0, 'host: user active + reaction + offer, still nothing opened (activity is never consent)');
  await host.poll();
  ok(sent[sent.length - 1].reaction === null, 'host: the same board polled again -> no second reaction');
  idle = 1;
  board = state({ t31At: iso(51) });
  await host.poll();
  ok(Boolean(sent[sent.length - 1].reaction) && sent[sent.length - 1].reaction.primary === 'T-31', 'host: a second update -> a reaction (the 2-minute voice gap is the scheduler\'s now, not the host\'s)', sent[sent.length - 1].reaction);
  const res = await host.answer(r.consent.id, true);
  ok(res.opened && opened.length === 1 && opened[0].path === `${W0}t31\\hud-react-1310\\hud-a.png`, 'host: OK on the offer opens exactly that file', { res, opened });
  host.setPrefs({ style: 'off' });
  const n = reads;
  await host.poll();
  ok(reads === n && sent[sent.length - 1].style === 'off', 'host: switched off -> stops reading the board, tells the renderer to hide');
  ok(stored.hudStyle === 'off' && !('hudVoiceMuted' in stored), 'host: prefs persisted in settings (no hudVoiceMuted key)', stored);
  host.stop();
}

// ---------- 5b. talk-mode rewiring (PLAN sections 2, 6, 7): decouple the poll, onReaction/onBoardStatus, lastStepLabel ----------
{
  // (1) HUD style Off + talk level Normal (talkActive) -> the host STILL polls and hands each reaction to main, but
  // sends NO 'hud:feed' (the HUD is hidden).
  {
    let st = {};
    let reads = 0;
    let cur = state();
    const sent = [];
    const reactions = [];
    const waiting = []; // the board's waiting count after each good read (talk-mode morning / check-in lines)
    const host = createHudHost({
      getState: async () => { reads++; return { ok: true, state: cur }; },
      idleSeconds: () => 2,
      settings: { get: () => st, set: (p) => { st = { ...st, ...p }; } },
      send: (p) => sent.push(p), decide: () => ({ action: 'refuse' }), open: async () => {},
      talkActive: () => true, onReaction: (rr) => reactions.push(rr), onWaiting: (n) => waiting.push(n),
      pollMs: 3_600_000, cooldownMs: 0,
    });
    await host.poll(); // baseline (style off, talkActive true)
    ok(reads === 1 && sent.length === 0, 'talk-mode: HUD off + talk level on -> the host polls, sends no hud:feed', { reads, sent: sent.length });
    cur = state({ t31At: iso(50) });
    await host.poll();
    ok(sent.length === 0 && reactions.length === 1 && reactions[0].primary === 'T-31', 'talk-mode: HUD off + talk level on -> onReaction fires for a board change, still no hud:feed', { sent: sent.length, reactions: reactions.map((x) => x.primary) });
    ok(waiting.length === 2 && waiting.every((n) => Number.isInteger(n) && n >= 0), 'talk-mode: onWaiting reports the waiting count after every good read', waiting);
    host.stop();
  }
  // (2) both off -> no poll at all.
  {
    let st = {};
    let reads = 0;
    const host = createHudHost({
      getState: async () => { reads++; return { ok: true, state: state() }; },
      idleSeconds: () => 2,
      settings: { get: () => st, set: (p) => { st = { ...st, ...p }; } },
      send: () => {}, decide: () => ({ action: 'refuse' }), open: async () => {},
      talkActive: () => false, pollMs: 3_600_000, cooldownMs: 0,
    });
    await host.poll();
    ok(reads === 0, 'talk-mode: HUD off + talk level off -> the board is never read', { reads });
    host.stop();
  }
  // (3) lastStepLabel gives the label of the step that just finished (current_step never reports 'done').
  {
    const tasks = (stepA, rev, at) => ({ tasks: [
      { id: 'X-1', title: 'X', status: 'doing', rev, last_activity_at: at,
        current_step: stepA === 'done' ? { id: 'b', label: 'B', state: 'todo' } : { id: 'a', label: 'A', state: 'active' },
        steps: [{ id: 'a', label: 'A', state: stepA }, { id: 'b', label: 'B', state: 'todo' }] },
    ], attention: { waiting: [] } });
    let st = {};
    let cur = tasks('active', 1, iso(10));
    const reactions = [];
    const host = createHudHost({
      getState: async () => ({ ok: true, state: cur }), idleSeconds: () => 2,
      settings: { get: () => st, set: (p) => { st = { ...st, ...p }; } },
      send: () => {}, decide: () => ({ action: 'refuse' }), open: async () => {},
      talkActive: () => true, onReaction: (rr) => reactions.push(rr),
      pollMs: 3_600_000, cooldownMs: 0,
    });
    await host.poll(); // baseline: X-1 on step A
    cur = tasks('done', 2, iso(20));
    await host.poll(); // X-1 finished A, now on B
    const r = reactions[reactions.length - 1];
    ok(r && r.primary === 'X-1' && r.state === 'done' && r.doneStep === 'A' && r.step === 'B', 'talk-mode: on a finished step the reaction carries doneStep = the previous label (A) and step = the next (B)', r && { primary: r.primary, state: r.state, doneStep: r.doneStep, step: r.step });
    ok(host._test.lastStepLabel()['X-1'] === 'A', 'talk-mode: lastStepLabel[task] holds the previous poll\'s label (the done step)', host._test.lastStepLabel());
    host.stop();
  }
  // (4) 3 failed reads -> board-lost, the first good read after -> board-back.
  {
    let st = {};
    let okRead = true;
    let failReason = 'offline';
    const status = [];
    const host = createHudHost({
      getState: async () => (okRead ? { ok: true, state: state() } : { ok: false, reason: failReason }),
      idleSeconds: () => 2,
      settings: { get: () => st, set: (p) => { st = { ...st, ...p }; } },
      send: () => {}, decide: () => ({ action: 'refuse' }), open: async () => {},
      talkActive: () => true, onBoardStatus: (ok2) => status.push(ok2),
      pollMs: 3_600_000, cooldownMs: 0,
    });
    await host.poll(); // a board that answered once: only then can it be lost
    okRead = false;
    await host.poll(); await host.poll();
    ok(status.length === 0, 'talk-mode: two failed reads in a row -> no board-lost yet', status);
    await host.poll();
    ok(status.length === 1 && status[0] === false, 'talk-mode: the third failed read -> board-lost', status);
    okRead = true;
    await host.poll();
    ok(status.length === 2 && status[1] === true, 'talk-mode: the first good read after a board-lost -> board-back', status);
    host.stop();
  }
  // (4b) T-31 fix: a board that is not configured / locked / not live is absent, never "lost" (no false "can't reach the board").
  for (const reason of ['unconfigured', 'locked', 'not_live']) {
    let st = {};
    const status = [];
    const host = createHudHost({
      getState: async () => ({ ok: false, reason }),
      idleSeconds: () => 2,
      settings: { get: () => st, set: (p) => { st = { ...st, ...p }; } },
      send: () => {}, decide: () => ({ action: 'refuse' }), open: async () => {},
      talkActive: () => true, onBoardStatus: (ok2) => status.push(ok2),
      pollMs: 3_600_000, cooldownMs: 0,
    });
    for (let i = 0; i < 6; i++) await host.poll();
    ok(status.length === 0 && host._test.boardFails() === 0, `talk-mode: ${reason} board over 6 reads -> never board-lost`, { status, fails: host._test.boardFails() });
    host.stop();
  }
  // (4c) a board that never answered (offline from launch) is not announced as lost either; a locked read in the middle resets the strikes.
  {
    let st = {};
    const status = [];
    let reason = 'offline';
    let good = false;
    const host = createHudHost({
      getState: async () => (good ? { ok: true, state: state() } : { ok: false, reason }),
      idleSeconds: () => 2,
      settings: { get: () => st, set: (p) => { st = { ...st, ...p }; } },
      send: () => {}, decide: () => ({ action: 'refuse' }), open: async () => {},
      talkActive: () => true, onBoardStatus: (ok2) => status.push(ok2),
      pollMs: 3_600_000, cooldownMs: 0,
    });
    for (let i = 0; i < 5; i++) await host.poll();
    ok(status.length === 0, 'talk-mode: offline since launch (never reachable) -> no board-lost', status);
    good = true; await host.poll(); good = false;
    await host.poll(); await host.poll(); reason = 'locked'; await host.poll(); reason = 'timeout'; await host.poll(); await host.poll();
    ok(status.length === 0, 'talk-mode: a locked read between transport failures resets the strike count', status);
    await host.poll();
    ok(status.length === 1 && status[0] === false, 'talk-mode: 3 transport failures in a row after a good read -> board-lost', status);
    host.stop();
  }
}

// ---------- 6. HUD interaction logic (T-31 0.2.3 batch A): rect -> NDC (A1), state -> variant (A2), click throttle (B5) ----------
{
  const vp = { left: 0, top: 0, width: 1000, height: 500 };
  const c = rectToNdc({ left: 480, top: 240, width: 40, height: 20 }, vp);
  ok(Math.abs(c.x) < 1e-9 && Math.abs(c.y) < 1e-9, 'ndc: a card centred in the stage maps to (0, 0)', c);
  const tl = rectToNdc({ left: 0, top: 0, width: 0, height: 0 }, vp);
  ok(tl.x === -1 && tl.y === 1, 'ndc: the top-left corner maps to (-1, +1)', tl);
  const br = rectToNdc({ left: 1000, top: 500, width: 0, height: 0 }, vp);
  ok(br.x === 1 && br.y === -1, 'ndc: the bottom-right corner maps to (+1, -1)', br);
  ok(rectToNdc({ left: 1200, top: 250, width: 0, height: 0 }, vp).x > 1, 'ndc: a point past the right edge is > 1');

  ok(lookTarget({ left: 820, top: 100, width: 120, height: 40 }, vp).x > 0, 'look: an on-screen card returns a stage-NDC point');
  ok(lookTarget({ left: 8000, top: 100, width: 120, height: 40 }, vp) === null, 'look: an offstage card is skipped');
  ok(lookTarget({ left: 820, top: 100, width: 0, height: 0 }, vp) === null, 'look: a zero-size card is skipped');
  ok(lookTarget({ left: 820, top: 100, width: 120, height: 40 }, vp, { hidden: true }) === null, 'look: a hidden card is skipped');
  ok(lookTarget({ left: 820, top: 100, width: 120, height: 40 }, vp, { faded: true }) === null, 'look: a faded (arm-yielded) card is skipped');
  ok(lookTarget({ left: -60, top: 100, width: 120, height: 40 }, vp).x === -1, 'look: a card half off the left edge clamps to x=-1');
  // T-31 fix round 1610 (left-card head turn, confirm): a card left of centre gives a negative NDC x and a card right of
  // centre a positive one. The engine turns the head by atan(x * tanX * GAZE_GAIN) (reflex/engine.js gazeLayer), which
  // is monotonic in x, so sign(x) is sign(yaw): a left card turns her head LEFT, toward the card. The QC harness read a
  // rightward move for 3 of 4 left cards -- that is its peak-displacement sampler catching the double-take's two-pulse
  // "away" gap, not a sign error (see REPORT.md section 3).
  ok(lookTarget({ left: 100, top: 100, width: 100, height: 40 }, vp).x < 0 && lookTarget({ left: 900, top: 100, width: 100, height: 40 }, vp).x > 0, 'look: a card left of centre looks left (NDC x < 0), a card right of centre looks right (x > 0)');

  ok(stateToVariant('done') === 'nod-smile', 'state: done -> nod-smile', stateToVariant('done'));
  ok(stateToVariant('blocked') === 'concerned' && stateToVariant('failed') === 'concerned', 'state: blocked / failed -> concerned');
  for (const s of ['active', 'waiting', 'todo', '', undefined]) ok(stateToVariant(s) === 'double-take', `state: '${s}' -> double-take`, stateToVariant(s));
  const boardDef = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'reflex', 'gestures', 'board.json'), 'utf8'));
  const ids = new Set(boardDef.variants.map((v) => v.id));
  const byId = Object.fromEntries(boardDef.variants.map((v) => [v.id, v]));
  ok(boardDef.variants.length >= 3 && [...Object.values(REACTION_VARIANTS), 'double-take', ...CARD_ARM_VARIANT_IDS].every((id) => ids.has(id)), 'state: every mapped variant exists in board.json (>= 3 variants)');

  // T-31 0.2.7 step 5 re-measure (DIAG 21-10 row 5): the HUD step-update cards are the LEFT group (.hud-left), the
  // ask cards the RIGHT one (.hud-right). These rects are the layout hud.css declares; the check ties them to the CSS
  // text so a test can never place a card on the right and call a dead left-card path green.
  const css = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'hud', 'hud.css'), 'utf8');
  ok(/\.hud-left\s*\{[^}]*left:\s*14px;[^}]*top:\s*14px;[^}]*width:\s*clamp\(210px,\s*25%,\s*330px\);[^}]*max-height:\s*calc\(46%\s*-\s*14px\)/.test(css)
    && /\.hud-right\s*\{[^}]*right:\s*14px;[^}]*top:\s*24%;[^}]*width:\s*clamp\(200px,\s*22%,\s*290px\);[^}]*max-height:\s*24%/.test(css),
    'layout: hud.css places the updates (hud-left) at 14px/top 14px and the asks (hud-right) at right 14px/top 24%');
  ok(/\.hud\[data-style="b"\]\s*\.hud-left\s*\{[^}]*left:\s*2\.5%;[^}]*top:\s*4%;[^}]*width:\s*clamp\(200px,\s*23%,\s*300px\);[^}]*max-height:\s*42%/.test(css)
    && /\.hud\[data-style="b"\]\s*\.hud-right\s*\{[^}]*right:\s*2\.5%;[^}]*top:\s*24%/.test(css),
    'layout: style B keeps the updates on the left (2.5%/4%) and the asks on the right (2.5%/24%)');
  const stage = { left: 0, top: 0, width: 1204, height: 689 }; // the harness stage viewport
  for (const style of ['a', 'b']) {
    const left = rectToNdc(hudCardRect('left', stage, style), stage);
    const right = rectToNdc(hudCardRect('right', stage, style), stage);
    ok(left.x < 0 && right.x > 0, `layout ${style}: the real updates card is left of centre (x=${left.x.toFixed(3)}), the asks card right (x=${right.x.toFixed(3)})`, { left, right });
  }

  // The variant follows the REAL card side, both sides (DIAG 21-10 finding 1): seated left card -> the right-hand
  // point; float left card -> the other hand small wave (the right hand is the panel hand); right card -> the
  // left-hand point. The state expression travels with every arm variant (finding 2: blocked must keep 'concerned').
  const leftCard = rectToNdc(hudCardRect('left', stage), stage);
  const rightCard = rectToNdc(hudCardRect('right', stage), stage);
  ok(stateToVariant('done', rightCard) === CARD_ARM_VARIANTS.done && stateToVariant('blocked', rightCard) === CARD_ARM_VARIANTS.blocked && stateToVariant('running', rightCard) === CARD_ARM_VARIANTS.focused,
    'state: a real screen-right card plays the left-hand arm variants per state', { done: stateToVariant('done', rightCard), blocked: stateToVariant('blocked', rightCard), running: stateToVariant('running', rightCard) });
  ok(stateToVariant('done', leftCard) === CARD_ARM_LEFT_VARIANTS.done && stateToVariant('blocked', leftCard) === CARD_ARM_LEFT_VARIANTS.blocked && stateToVariant('running', leftCard) === CARD_ARM_LEFT_VARIANTS.focused,
    'state: a real screen-left card seated plays the right-hand arm variants per state (no longer head-only)', { done: stateToVariant('done', leftCard), blocked: stateToVariant('blocked', leftCard), running: stateToVariant('running', leftCard) });
  ok(stateToVariant('done', leftCard, { float: true }) === CARD_FLOAT_LEFT_VARIANTS.done && stateToVariant('blocked', leftCard, { float: true }) === CARD_FLOAT_LEFT_VARIANTS.blocked && stateToVariant('running', leftCard, { float: true }) === CARD_FLOAT_LEFT_VARIANTS.focused,
    'state: a real screen-left card in float plays the panel-far hand small-wave variants (her right hand is the panel hand)', { done: stateToVariant('done', leftCard, { float: true }), blocked: stateToVariant('blocked', leftCard, { float: true }), running: stateToVariant('running', leftCard, { float: true }) });
  ok(stateToVariant('active', leftCard) === 'double-take' && stateToVariant('active', rightCard) === 'double-take' && stateToVariant('waiting', leftCard, { float: true }) === 'double-take',
    'state: an unknown / non-step state keeps the head-only double-take on both sides');
  ok(stateToVariant('done', { x: 0, y: 0.1 }) === 'nod-smile' && stateToVariant('done', { x: NaN, y: 0 }) === 'nod-smile' && stateToVariant('done', null) === 'nod-smile',
    'state: a centred / non-finite / missing card point never picks an arm variant');
  const exprOf = (id) => (byId[id].command.expressions || []).map((e) => e.name);
  ok(exprOf(CARD_ARM_VARIANTS.done).includes('happy') && exprOf(CARD_ARM_VARIANTS.blocked).includes('sad') && !exprOf(CARD_ARM_VARIANTS.blocked).includes('happy') && !exprOf(CARD_ARM_VARIANTS.focused).some((n) => ['happy', 'sad', 'surprised'].includes(n)),
    'state: right card keeps done -> happy, blocked -> sad (concerned), running -> neutral/relaxed', { done: exprOf(CARD_ARM_VARIANTS.done), blocked: exprOf(CARD_ARM_VARIANTS.blocked), running: exprOf(CARD_ARM_VARIANTS.focused) });
  ok(exprOf(CARD_ARM_LEFT_VARIANTS.done).includes('happy') && exprOf(CARD_ARM_LEFT_VARIANTS.blocked).includes('sad') && exprOf(CARD_FLOAT_LEFT_VARIANTS.blocked).includes('sad'),
    'state: the left-card paths keep the status expression on both modes (blocked -> sad/concerned)');
  const handsOf = (id) => (byId[id].command.reach || []).map((r) => `${r.hand}:${r.target}`);
  ok(handsOf(CARD_ARM_VARIANTS.blocked).join() === 'left:point-up' && handsOf(CARD_ARM_LEFT_VARIANTS.blocked).join() === 'right:point-up' && handsOf(CARD_FLOAT_LEFT_VARIANTS.blocked).join() === 'left:wave-small',
    'state: each side points with the hand on the card side; the float left card uses the panel-far hand small wave', { right: handsOf(CARD_ARM_VARIANTS.blocked), left: handsOf(CARD_ARM_LEFT_VARIANTS.blocked), floatLeft: handsOf(CARD_FLOAT_LEFT_VARIANTS.blocked) });

  const th = createClickThrottle(800);
  ok(th(0) === true, 'throttle: the first click passes');
  ok(th(799) === false, 'throttle: a second click inside 800 ms is refused');
  ok(th(800) === true, 'throttle: allowed again at exactly 800 ms');
  ok(th(1200) === false && th(1600) === true, 'throttle: the window restarts from the last allowed click');
}

// ---------- 6d. a reaction never loses its gaze to a passing yield (T-31 fix round 4, DIAG r3 #3) ----------
// The arm-yield fades the group for ~0.2 s (hud.css .yield). The card's rect does not move and the gaze never enters
// the panel, so a reaction that lands during the fade must still look at its card. `lookTarget`'s shared `faded` skip
// made about 1 reaction in 7 log look:null, so the double-take played with no target. `reactionLook` is the reaction
// path: it takes no `faded` flag, skips only a hidden or off-stage card, and react() uses it. ----------
{
  const vp = { left: 0, top: 0, width: 1000, height: 500 };
  const rightCard = { left: 848.5, top: 180.5, width: 60, height: 40 }; // centre (878.5, 200.5) -> NDC (0.757, 0.198)
  const n = reactionLook(rightCard, vp, {});
  ok(n && Math.abs(n.x - 0.757) < 1e-9 && Math.abs(n.y - 0.198) < 1e-9,
    'reactionLook: a faded (arm-yielded) right ask card still gives its stage NDC (~0.757, 0.198)', n);
  const nf = reactionLook(rightCard, vp, { faded: true });
  ok(nf && Math.abs(nf.x - 0.757) < 1e-9 && Math.abs(nf.y - 0.198) < 1e-9,
    'reactionLook: a `faded` flag never skips the gaze (it is not part of the reaction contract)', nf);
  ok(reactionLook(rightCard, vp, { hidden: true }) === null, 'reactionLook: a hidden card is still skipped');
  ok(reactionLook({ left: 8000, top: 100, width: 120, height: 40 }, vp) === null && reactionLook({ left: 0, top: 0, width: 0, height: 0 }, vp) === null,
    'reactionLook: an off-stage / zero-size card is still skipped');
  ok(lookTarget(rightCard, vp, { faded: true }) === null && reactionLook(rightCard, vp) !== null,
    'reactionLook: the same faded card a click glance skips (lookTarget) is looked at by a reaction');

  // static guards (hud.js is a renderer file, not importable here): react() looks through the reaction path and the
  // reaction note records lookSkip.
  const hudJs = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'hud', 'hud.js'), 'utf8');
  const imp = /import\s*\{([^}]*)\}\s*from\s*'\.\/hud-logic\.js'/.exec(hudJs);
  ok(Boolean(imp) && /\breactionLook\b/.test(imp[1]), 'hud.js: imports reactionLook from hud-logic.js');
  const cb = (/function cardLookOf\(el,([\s\S]*?)\n  \}/.exec(hudJs) || [])[1] || '';
  ok(/reactionLook\(/.test(cb) && /skip:\s*look\s*\?\s*null\s*:\s*hidden\s*\?\s*'hidden'\s*:\s*'offstage'/.test(cb) && /'faded'/.test(cb),
    'hud.js: cardLookOf takes the reaction path via reactionLook (faded never skips; skip is reason-tagged), while a click glance keeps lookTarget/lookTarget\'s faded skip', cb.trim().slice(0, 140));
  const rb = (/async function react\(reaction\)\s*\{([\s\S]*?)\n  \}/.exec(hudJs) || [])[1] || '';
  ok(/cardLook\([^;]*\{\s*reaction:\s*true\s*\}/.test(rb) && !/\blookTarget\(/.test(rb),
    'hud.js: react() resolves its gaze through cardLook({ reaction: true }) -- the reactionLook path, never lookTarget\'s faded skip', rb.trim().slice(0, 140));
  ok(/note\(\{\s*kind:\s*'reaction'[^}]*\blookSkip\b/.test(rb), 'hud.js: the reaction note carries lookSkip (the next box run proves why a look was skipped)');
  // T-31 fix r4 (review 4): the reaction note also records lookFaded next to lookSkip. reactionLook never skips on a
  // fade, so lookSkip alone cannot prove the yield cause -- lookFaded says whether the card's group was arm-yielded.
  ok(cb.indexOf('const faded') > -1 && cb.indexOf('const faded') < cb.indexOf('if (reaction)'),
    'hud.js: cardLookOf reads the group fade for the reaction path too (const faded is resolved before the reaction branch)');
  // Anchor to the reaction branch body (the lazy [\s\S] would otherwise skip past its closing brace and match the
  // click-glance return's faded, passing even on the pre-fix code).
  const reactionBranch = (/if\s*\(reaction\)\s*\{([\s\S]*?)\n    \}/.exec(cb) || [])[1] || '';
  ok(/\breturn\s*\{[^}]*\bfaded\b/.test(reactionBranch),
    'hud.js: the reaction look result carries faded (the reaction path reports the yield instead of dropping it)');
  ok(/faded:\s*lookFaded\b/.test(rb) && /note\(\{\s*kind:\s*'reaction'[^}]*\blookSkip\b[^}]*\blookFaded\b/.test(rb),
    'hud.js: react() records lookFaded next to lookSkip on the reaction note (the box run proves the yield cause)', rb.trim().slice(0, 140));
  // T-31 0.2.7 step 5: the arm variant is chosen from the card's own side, so the card look is resolved BEFORE the
  // variant (stateToVariant's second argument is the stage-NDC point).
  ok(rb.indexOf('stateToVariant(reaction.state, target, { float: Boolean(engine.holoPanel) })') > rb.indexOf('cardLook('),
    'hud.js: react() resolves the card look before choosing the variant, and passes the live float (panel) mode', rb.slice(rb.indexOf('const variant'), rb.indexOf('const variant') + 90));
}

// ---------- 6b. generic board event wiring (T-31 0.2.3 A1 fix, app.js onBoardEvent) ----------
// A board message the camera cannot pin to a HUD card must force the 'double-take' variant and gaze the sidebar NDC --
// not a bare trigger('board'), which lost the glance (4 of the 5 variants gaze only the per-play 'dynamic' target,
// skipped when no look is passed) and could pick nod-smile/concerned at random. app.js is a renderer file (DOM, not
// importable here): a static source check, the same shape as section 10's hud.js guard.
{
  const appJs = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
  const m = /const onBoardEvent = \(\) => \{([\s\S]*?)\n  \};/.exec(appJs);
  const body = m ? m[1] : '';
  const [sx, sy] = LOOK_TARGETS.sidebar;
  const lookCall = new RegExp(`engine\\.trigger\\('board',\\s*\\{\\s*look:\\s*\\{\\s*x:\\s*${sx},\\s*y:\\s*${sy}\\s*\\}\\s*\\}\\)`);
  ok(Boolean(m) && /catalog\.forceNext\('board',\s*'double-take'\)/.test(body) && lookCall.test(body) && !/engine\.trigger\('board'\)/.test(body),
    'board event: onBoardEvent forces double-take and passes the sidebar NDC (never a bare trigger)', body.trim().slice(0, 160));
}

// ---------- 6c. open-on-board wiring (T-31 0.2.3 A1 fix, app.js openBoardTask) ----------
// The HUD "Open on the board" must wait for the guest view's dom-ready (dataset.domReady === '1'), not dataset.home --
// which is set before the <webview> attaches, so a cold-tab loadURL ran too early (GUEST_VIEW) -- and must handle a
// rejected loadURL. Same static source check as 6b (app.js is a renderer file).
{
  const appJs = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
  const m = /const openBoardTask = \(taskId\) => \{([\s\S]*?)\n  \};/.exec(appJs);
  const body = m ? m[1] : '';
  ok(Boolean(m) && /webview\.dataset\.domReady !== '1'/.test(body) && /\.loadURL\(u\.href\)\.catch\(/.test(body) && !/!webview\.dataset\.home/.test(body),
    'open on board: waits for dataset.domReady and catches a failed loadURL (never gates on dataset.home)', body.trim().slice(0, 160));
}

// ---------- 7. A2 end to end: a finished step reaches the renderer as reaction.state 'done' ----------
{
  let st = {};
  const tasks = (stepA, rev, at) => ({ tasks: [
    { id: 'X-1', title: 'X', status: 'doing', rev, last_activity_at: at,
      current_step: stepA === 'done' ? { id: 'b', label: 'B', state: 'todo' } : { id: 'a', label: 'A', state: 'active' },
      steps: [{ id: 'a', label: 'A', state: stepA }, { id: 'b', label: 'B', state: 'todo' }] },
  ], attention: { waiting: [] } });
  let cur = tasks('active', 1, iso(10));
  const sent2 = [];
  const h2 = createHudHost({
    getState: async () => ({ ok: true, state: cur }),
    idleSeconds: () => 2,
    settings: { get: () => st, set: (p) => { st = { ...st, ...p }; } },
    send: (p) => sent2.push(p),
    decide: () => ({ action: 'refuse' }), open: async () => {},
    pollMs: 3_600_000, cooldownMs: 0,
  });
  h2.setPrefs({ style: 'a' });
  await h2.poll(); // baseline
  cur = tasks('done', 2, iso(20));
  await h2.poll();
  const rr = sent2[sent2.length - 1].reaction;
  ok(rr && rr.primary === 'X-1' && rr.state === 'done', 'host: a finished step -> reaction.state done (nod/smile), not the next step\'s todo', rr && { primary: rr.primary, state: rr.state });
  h2.stop();

  // A completion in a burst that also carries a NEWER unrelated change must still win the focus (its nod/smile is the
  // notable event, and the gaze lands on the card that finished), not be swallowed by the newer item.
  {
    const two = (xD, yRev, yAt) => ({ tasks: [
      { id: 'X-1', title: 'X', status: 'doing', rev: xD ? 2 : 1, last_activity_at: xD ? iso(20) : iso(10),
        current_step: xD ? { id: 'b', label: 'B', state: 'todo' } : { id: 'a', label: 'A', state: 'active' },
        steps: [{ id: 'a', label: 'A', state: xD ? 'done' : 'active' }, { id: 'b', label: 'B', state: 'todo' }] },
      { id: 'Y-2', title: 'Y', status: 'doing', rev: yRev, last_activity_at: yAt,
        current_step: { id: 'c', label: 'C', state: 'active' }, steps: [{ id: 'c', label: 'C', state: 'active' }] },
    ], attention: { waiting: [] } });
    let st3 = {};
    let cur3 = two(false, 1, iso(10));
    const sent3 = [];
    const h3 = createHudHost({ getState: async () => ({ ok: true, state: cur3 }), idleSeconds: () => 2, settings: { get: () => st3, set: (p) => { st3 = { ...st3, ...p }; } }, send: (p) => sent3.push(p), decide: () => ({ action: 'refuse' }), open: async () => {}, pollMs: 3_600_000, cooldownMs: 0 });
    h3.setPrefs({ style: 'a' });
    await h3.poll(); // baseline
    cur3 = two(true, 2, iso(30)); // X-1 finished a step; Y-2 is newer but only active
    await h3.poll();
    const r3 = sent3[sent3.length - 1].reaction;
    ok(r3 && r3.primary === 'X-1' && r3.state === 'done' && r3.taskIds.includes('Y-2'), 'host: a completion wins the focus in a burst even when a newer task is also new', r3 && { primary: r3.primary, state: r3.state, taskIds: r3.taskIds });
    h3.stop();
  }
}

// ---------- 7b. the ask wins the focus tie (T-31 fix round 1610): ask.raise bumps the task's update `at` to the ask's
// `since`, so a task's update and its new ask carry the SAME timestamp. The ask is the notable event, so the reaction
// must name source 'waiting' -- then hud.js cardLook scopes to #hud-asks and the gaze lands on the RIGHT ask card,
// never the LEFT update card. The tie-break must be explicit, never left to sort stability. ----------
{
  let st7 = {};
  const sent7 = [];
  const tieAt = iso(20);
  let cur7 = state({ f04At: iso(5), asks: [] });
  const h7 = createHudHost({ getState: async () => ({ ok: true, state: cur7 }), idleSeconds: () => 2, settings: { get: () => st7, set: (p) => { st7 = { ...st7, ...p }; } }, send: (p) => sent7.push(p), decide: () => ({ action: 'refuse' }), open: async () => {}, pollMs: 3_600_000, cooldownMs: 0 });
  h7.setPrefs({ style: 'a' });
  await h7.poll(); // baseline: F-04 open, no ask
  cur7 = state({ f04At: tieAt, asks: [{ kind: 'ask', id: 'ask-tie', task_id: 'F-04', text: 'Pick a look', rev: 1, since: tieAt }] });
  await h7.poll();
  const r7 = sent7[sent7.length - 1].reaction;
  ok(r7 && r7.primary === 'F-04' && r7.source === 'waiting', 'tie: an ask ties its task update on `at` and wins the focus (source waiting -> the right ask card, never the left update card)', r7 && { primary: r7.primary, source: r7.source, state: r7.state });
  h7.stop();
}

// ---------- 7c. the ask wins the focus tie within a ~1 s window (T-31 fix round 1610 r3, DIAG #3) ----------
// Port of the v0.2.3 fix round's diag-r3-tie-skew.mjs against this tree's createHudHost. ask.raise bumps the
// task's update `at` to the ask's `since`, but the two clock reads can straddle a millisecond, so the update may be
// stamped a few ms AFTER its ask. fb544cb's exact-equality tie-break then missed and the gaze went to the LEFT update
// card instead of the RIGHT ask card. The fix makes the tie a window: an ask within TIE_MS of the newest change wins.
// `skew` = the update's timestamp minus the ask's `since` (ms); >0 means the update was stamped after its ask. ----------
{
  const baseMs = Date.UTC(2026, 9, 13, 8, 20);
  const isoMs = (ms) => new Date(ms).toISOString();
  const skewState = (f04At, asks) => ({ tasks: [
    { id: 'T-31', title: 'Zumi agent', status: 'active', rev: 4, last_activity_at: isoMs(baseMs - 600000), current_step: { id: 'hud', label: 'HUD', state: 'active' }, steps: [] },
    { id: 'F-04', title: 'Wardrobe', status: 'active', rev: 2, last_activity_at: f04At, current_step: { id: 's1', label: 'Round 4', state: 'waiting' }, steps: [] },
  ], attention: { waiting: asks } });
  for (const skew of [-5, -1, 0, 1, 5, 300]) {
    let st = {};
    const sentSk = [];
    let cur = skewState(isoMs(baseMs - 900000), []);
    const h = createHudHost({ getState: async () => ({ ok: true, state: cur }), idleSeconds: () => 2, settings: { get: () => st, set: (p) => { st = { ...st, ...p }; } }, send: (p) => sentSk.push(p), decide: () => ({ action: 'refuse' }), open: async () => {}, pollMs: 3_600_000, cooldownMs: 0 });
    h.setPrefs({ style: 'a' });
    await h.poll(); // baseline: F-04 open, no ask
    cur = skewState(isoMs(baseMs + skew), [{ kind: 'ask', id: 'ask-x', task_id: 'F-04', text: 'Pick a look', rev: 1, since: isoMs(baseMs) }]);
    await h.poll();
    const r = sentSk[sentSk.length - 1].reaction;
    h.stop();
    ok(r && r.primary === 'F-04' && r.source === 'waiting', `tie window: an ask still wins when its update is stamped ${skew >= 0 ? skew + ' ms after' : -skew + ' ms before'} it (source waiting -> the right ask card)`, r && { skew, primary: r.primary, source: r.source });
  }
  // guard: an OLD ask (its `since` 10 min before the update) is OUTSIDE the window and must still lose to the fresh update
  {
    let st = {};
    const sentG = [];
    let cur = skewState(isoMs(baseMs - 900000), []);
    const h = createHudHost({ getState: async () => ({ ok: true, state: cur }), idleSeconds: () => 2, settings: { get: () => st, set: (p) => { st = { ...st, ...p }; } }, send: (p) => sentG.push(p), decide: () => ({ action: 'refuse' }), open: async () => {}, pollMs: 3_600_000, cooldownMs: 0 });
    h.setPrefs({ style: 'a' });
    await h.poll();
    cur = skewState(isoMs(baseMs), [{ kind: 'ask', id: 'ask-old', task_id: 'F-04', text: 'Pick a look', rev: 1, since: isoMs(baseMs - 600000) }]);
    await h.poll();
    const r = sentG[sentG.length - 1].reaction;
    h.stop();
    ok(r && r.primary === 'F-04' && r.source === 'updates', 'tie window: an ask 10 min older than a fresh update does NOT win the window (source updates)', r && { primary: r.primary, source: r.source });
  }
}

// ---------- 7d. the tie window is scoped to the SAME task (T-31 fix round 1610 r3, review fix) ----------
// The 1 s window exists only so a task's own ask can beat its update when the two clock reads straddle a millisecond. It
// must NOT let an ask on task A win over a NEWER update on task B: the window compares a candidate to the newest change,
// so it must also require `c.id === cand[0].id`. Reference: Opus's repro cross.mjs case A -- an F-04 ask raised at t0 and
// an H-03 step update 300 / 900 ms later, same poll. Without the same-task guard the F-04 ask won the window (source
// waiting); the newer H-03 update must win. (+1500 ms is outside the window either way.) ----------
{
  const baseMs = Date.UTC(2026, 9, 13, 8, 20);
  const isoMs = (ms) => new Date(ms).toISOString();
  const cross = (f04At, h03At, asks) => ({ tasks: [
    { id: 'F-04', title: 'Wardrobe', status: 'active', rev: 2, last_activity_at: f04At, current_step: { id: 's1', label: 'Round 4', state: 'waiting' }, steps: [] },
    { id: 'H-03', title: 'Hair', status: 'active', rev: 2, last_activity_at: h03At, current_step: { id: 'h1', label: 'Cut', state: 'active' }, steps: [] },
  ], attention: { waiting: asks } });
  for (const d of [300, 900, 1500]) {
    let st = {};
    const sent = [];
    let cur = cross(isoMs(baseMs - 900000), isoMs(baseMs - 900000), []);
    const h = createHudHost({ getState: async () => ({ ok: true, state: cur }), idleSeconds: () => 2, settings: { get: () => st, set: (p) => { st = { ...st, ...p }; } }, send: (p) => sent.push(p), decide: () => ({ action: 'refuse' }), open: async () => {}, pollMs: 3_600_000, cooldownMs: 0 });
    h.setPrefs({ style: 'a' });
    await h.poll(); // baseline: F-04 and H-03 open, no ask
    cur = cross(isoMs(baseMs), isoMs(baseMs + d), [{ kind: 'ask', id: 'a1', task_id: 'F-04', text: 'q', rev: 1, since: isoMs(baseMs) }]);
    await h.poll();
    const r = sent[sent.length - 1].reaction;
    h.stop();
    ok(r && r.primary === 'H-03' && r.source === 'updates', `cross-task: a NEWER update on H-03 (+${d} ms) beats an ask on F-04 -- the tie window never crosses tasks`, r && { d, primary: r.primary, source: r.source });
  }
}

// ---------- 8. inline ask answers (T-31 0.2.3 batch C): the write payload, the gates, the double answer ----------
{
  // payload shape: the same `data` the board's own page sends (app.js answer() -> ops.mjs 'ask.answer')
  ok(JSON.stringify(askAnswerData({ choice: 'A' })) === '{"choice":"A"}', 'answer: an option pick -> { choice }', askAnswerData({ choice: 'A' }));
  ok(JSON.stringify(askAnswerData({ verdict: 'approve' })) === '{"verdict":"approve"}', 'answer: approve/reject with no options -> { verdict }', askAnswerData({ verdict: 'approve' }));
  ok(JSON.stringify(askAnswerData({ text: 'looks good' })) === '{"text":"looks good"}', 'answer: a free-text answer -> { text }', askAnswerData({ text: 'looks good' }));
  ok(JSON.stringify(askAnswerData({ choice: 'B', text: '  note  ' })) === '{"choice":"B","text":"note"}', 'answer: a pick plus a trimmed note rides together', askAnswerData({ choice: 'B', text: '  note  ' }));
  ok(JSON.stringify(askAnswerData({ choice: 'B', verdict: 'reject' })) === '{"choice":"B"}', 'answer: a pick wins over a verdict (an ask with options is answered by choosing)', askAnswerData({ choice: 'B', verdict: 'reject' }));
  ok(askAnswerData({ verdict: 'maybe' }) === null, 'answer: an unknown verdict is not an answer', askAnswerData({ verdict: 'maybe' }));
  ok(askAnswerData({ text: '   ' }) === null && askAnswerData({}) === null && askAnswerData() === null, 'answer: nothing picked and no text -> null (ops.mjs choice_or_text_required)');

  const body = buildAskAnswer('ask-7', 3, { choice: 'A' });
  ok(body && body.target_id === 'ask-7' && body.expected_revision === 3 && JSON.stringify(body.data) === '{"choice":"A"}' && !('op' in body) && !('version' in body), 'answer: body is { target_id, expected_revision, data }, the bridge adds op/version (renderer never names the op)', body);
  ok(buildAskAnswer('ask-7', '3', { choice: 'A' }).expected_revision === 3, 'answer: a numeric-string revision is coerced');
  ok(buildAskAnswer('', 3, { choice: 'A' }) === null && buildAskAnswer('ask-7', undefined, { choice: 'A' }) === null && buildAskAnswer('ask-7', -1, { choice: 'A' }) === null && buildAskAnswer('ask-7', 3, {}) === null, 'answer: a missing id / revision / answer -> null (no write)');
  // rev null/undefined must be refused, not coerced to 0 (T-31 0.2.3 C nit): 0 is a real revision the board needs kept
  ok(buildAskAnswer('ask-7', null, { choice: 'A' }) === null && buildAskAnswer('ask-7', '', { choice: 'A' }) === null && buildAskAnswer('ask-7', false, { choice: 'A' }) === null && buildAskAnswer('ask-7', '  ', { choice: 'A' }) === null, 'answer: rev null / empty / non-number -> null (never coerced to 0)');
  ok(buildAskAnswer('ask-7', 0, { choice: 'A' }).expected_revision === 0, 'answer: rev 0 is a real revision and is kept');
  // the answer text is capped at ASK_ANSWER_TEXT_MAX with a clear error, never silently truncated
  ok(buildAskAnswer('ask-7', 3, { text: 'x'.repeat(ASK_ANSWER_TEXT_MAX) }) !== null && buildAskAnswer('ask-7', 3, { text: 'x'.repeat(ASK_ANSWER_TEXT_MAX + 1) }) === null, 'answer: text at the cap is accepted, one over is refused', ASK_ANSWER_TEXT_MAX);
  ok(ASK_ANSWER_TEXT_MAX === 2000, 'answer: the text cap is 2000 chars', ASK_ANSWER_TEXT_MAX);

  // bridge relay result -> HUD reason
  ok(answerOutcome({ status: 200, text: '{"ok":true,"result":{"id":"ask-7"}}' }).ok === true, 'outcome: 200 ok -> ok');
  ok(answerOutcome({ status: 200, text: '' }).ok === true, 'outcome: 200 with an empty body -> ok');
  ok(answerOutcome({ status: 401, text: '{"error":"locked"}' }).reason === 'locked', 'outcome: 401 locked -> locked');
  ok(answerOutcome({ status: 403, text: '{"error":"forbidden_op"}' }).reason === 'forbidden_op', 'outcome: 403 -> forbidden_op');
  ok(answerOutcome({ status: 409, text: '{"error":"ask_not_open"}' }).reason === 'already_answered', 'outcome: the board already rejected a second answer (409 ask_not_open, ops.mjs:363) -> already_answered');
  ok(answerOutcome({ status: 409, text: '{"error":"revision_conflict"}' }).reason === 'already_answered', 'outcome: a stale revision (409 revision_conflict) -> already_answered');
  ok(answerOutcome({ status: 500, text: 'boom' }).reason === 'failed' && answerOutcome({ status: 400, text: '{"error":"unknown_choice"}' }).reason === 'failed', 'outcome: 5xx / bad json / bad choice -> failed (retryable, controls stay)');

  // owner-only gating: a release build never relays, whatever the board says
  {
    let calls = 0;
    const release = createAskAnswerer({ relay: async () => { calls++; return { status: 200, text: '{}' }; }, ownerAdmin: false, boardStatus: () => ({ mode: 'live', configured: true, locked: false }) });
    const r = await release.answer({ id: 'ask-7', rev: 1, choice: 'A' });
    ok(r.ok === false && r.reason === 'not_owner_build' && calls === 0, 'gate: a release build (ownerAdmin=false) refuses and never relays', r);
  }
  // locked state: live+unlocked is required; unconfigured / locked / not-live / mirror all refuse before relaying
  {
    let calls = 0;
    const relay = async () => { calls++; return { status: 200, text: '{}' }; };
    for (const [label, st] of [
      ['unconfigured', { mode: 'live', configured: false, locked: true }],
      ['locked', { mode: 'live', configured: true, locked: true }],
      ['not live (mirror/local)', { mode: 'local', configured: true, locked: false }],
      ['no status', null],
    ]) {
      const a = createAskAnswerer({ relay, ownerAdmin: true, boardStatus: () => st });
      const r = await a.answer({ id: 'ask-9', rev: 1, choice: 'A' });
      ok(r.ok === false && r.reason === 'locked', `gate: ${label} -> locked (the read-only mirror shows "enter the PIN"), never relayed`, r);
    }
    ok(calls === 0, 'gate: a locked/unconfigured board never reaches the bridge', calls);
  }
  // double answer: one write per ask; the answered set and the board both block a second one
  {
    let calls = 0;
    const a = createAskAnswerer({ relay: async () => { calls++; return { status: 200, text: '{"ok":true}' }; }, ownerAdmin: true, boardStatus: () => ({ mode: 'live', configured: true, locked: false }) });
    const first = await a.answer({ id: 'ask-3', rev: 2, choice: 'ok' });
    const second = await a.answer({ id: 'ask-3', rev: 2, choice: 'ok' });
    ok(first.ok === true && second.ok === false && second.reason === 'already_answered' && calls === 1, 'double: a second answer to the same ask@rev is refused locally, exactly one write', { calls, second });
    const stale = await a.answer({ id: 'ask-3', rev: 3, choice: 'ok' }); // a new revision is a different ask record -> allowed (board decides)
    ok(stale.ok === true && calls === 2, 'double: a different revision is not the same answer (allowed through)', { calls });
  }
  {
    // the board's own refusal of a second answer surfaces as already_answered and is remembered locally
    let calls = 0;
    const a = createAskAnswerer({ relay: async () => { calls++; return { status: 409, text: '{"error":"ask_not_open"}' }; }, ownerAdmin: true, boardStatus: () => ({ mode: 'live', configured: true, locked: false }) });
    const r1 = await a.answer({ id: 'ask-4', rev: 1, verdict: 'approve' });
    const r2 = await a.answer({ id: 'ask-4', rev: 1, verdict: 'approve' });
    ok(r1.ok === false && r1.reason === 'already_answered' && r2.reason === 'already_answered' && calls === 1, 'double: the board\'s 409 ask_not_open -> already_answered, and the retry never re-writes', { calls, r1, r2 });
  }
  {
    // two clicks race: the in-flight guard lets exactly one write through
    let calls = 0;
    let release;
    const gate = new Promise((res) => { release = res; });
    const a = createAskAnswerer({ relay: async () => { calls++; await gate; return { status: 200, text: '{"ok":true}' }; }, ownerAdmin: true, boardStatus: () => ({ mode: 'live', configured: true, locked: false }) });
    const p1 = a.answer({ id: 'ask-5', rev: 1, choice: 'A' });
    const r2 = await a.answer({ id: 'ask-5', rev: 1, choice: 'A' }); // second click while the first is in flight
    release();
    const r1 = await p1;
    ok(r1.ok === true && r2.ok === false && r2.reason === 'in_flight' && calls === 1, 'double: an in-flight answer blocks the second click (one write at a time)', { calls, r1, r2 });
  }

  // a text-only ask: text alone is a valid answer (ops.mjs), an empty one is not
  {
    let calls = 0;
    const a = createAskAnswerer({ relay: async () => { calls++; return { status: 200, text: '{"ok":true}' }; }, ownerAdmin: true, boardStatus: () => ({ mode: 'live', configured: true, locked: false }) });
    const empty = await a.answer({ id: 'ask-6', rev: 1, text: '   ' });
    const answer = await a.answer({ id: 'ask-6', rev: 1, text: 'Ship it' });
    ok(empty.ok === false && empty.reason === 'bad_request' && answer.ok === true && calls === 1, 'answer: a text ask needs non-empty text; a real reply goes through', { empty, answer, calls });
  }
  // the answer text cap surfaces as a clear reason, and a null revision is refused (T-31 0.2.3 C nit)
  {
    let calls = 0;
    const a = createAskAnswerer({ relay: async () => { calls++; return { status: 200, text: '{"ok":true}' }; }, ownerAdmin: true, boardStatus: () => ({ mode: 'live', configured: true, locked: false }) });
    const tooLong = await a.answer({ id: 'ask-8', rev: 1, text: 'x'.repeat(ASK_ANSWER_TEXT_MAX + 1) });
    const okLen = await a.answer({ id: 'ask-8', rev: 1, text: 'x'.repeat(ASK_ANSWER_TEXT_MAX) });
    ok(tooLong.ok === false && tooLong.reason === 'text_too_long' && calls === 1, 'answer: an over-long text is refused with a clear reason (no write), the valid one writes once', { tooLong, calls });
    const badRev = await a.answer({ id: 'ask-8', rev: null, choice: 'A' });
    ok(badRev.ok === false && badRev.reason === 'bad_request' && calls === 1, 'answer: a null revision is refused (bad_request), never a write', badRev);
  }
  ok(ASK_ANSWER_VERDICTS.join(',') === 'approve,reject', 'answer: verdicts are exactly approve / reject (ops.mjs)');
}

// ---------- 9. the real loopback RELAY path (T-31 0.2.3 batch C): an answer reaches the bridge's upstream as the
// board envelope with the `zumi-relay-` request_id; the gates stop it before any network call ----------
{
  const hits = [];
  const upstream = http.createServer((r, res) => {
    let body = ''; r.on('data', (c) => body += c);
    r.on('end', () => { hits.push({ url: r.url, method: r.method, body }); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true,"result":{"id":"ask-7","revision":4}}'); });
  });
  await new Promise((res) => upstream.listen(0, '127.0.0.1', res));
  const upstreamOrigin = `http://127.0.0.1:${upstream.address().port}`;
  const publicDir = path.join(ROOT, 'vendor', 'laneboard', 'public');
  const bridge = createBridge({ upstreamOrigin, getToken: () => 'lb_fake_token', getBasicAuth: () => null, publicDir });
  const live = () => ({ mode: 'live', configured: true, locked: false });
  const relay = (op, b) => bridge.relay(op, b);
  try {
    // owner gating and locked gating both hold BEFORE the bridge is reached
    const rel = createAskAnswerer({ relay, ownerAdmin: false, boardStatus: live });
    const lock = createAskAnswerer({ relay, ownerAdmin: true, boardStatus: () => ({ mode: 'local', configured: true, locked: false }) });
    const relR = await rel.answer({ id: 'ask-7', rev: 3, choice: 'A' });
    const lockR = await lock.answer({ id: 'ask-7', rev: 3, choice: 'A' });
    ok(relR.reason === 'not_owner_build' && lockR.reason === 'locked' && hits.length === 0, 'relay: owner build + live+unlocked gate both hold before the bridge is reached', { relR, lockR, hits: hits.length });

    const a = createAskAnswerer({ relay, ownerAdmin: true, boardStatus: live });
    const r = await a.answer({ id: 'ask-7', rev: 3, choice: 'A', text: 'ship' });
    ok(r.ok === true && hits.length === 1 && hits[0].url === '/api/v1/write' && hits[0].method === 'POST', 'relay: one live answer -> exactly one POST /api/v1/write', { r, hits });
    const sent = JSON.parse(hits[0].body);
    ok(sent.op === 'ask.answer' && sent.version === 1 && sent.target_id === 'ask-7' && sent.expected_revision === 3 && JSON.stringify(sent.data) === '{"choice":"A","text":"ship"}', 'relay: the upstream body is the board envelope (op, version, target_id, expected_revision, data)', sent);
    ok(typeof sent.request_id === 'string' && sent.request_id.startsWith('zumi-relay-'), 'relay: request_id carries the zumi-relay- prefix (the bridge marks Zumi as the channel)', sent.request_id);

    const again = await a.answer({ id: 'ask-7', rev: 3, choice: 'A', text: 'ship' });
    ok(again.reason === 'already_answered' && hits.length === 1, 'relay: the answered-set blocks a second send (still one write)', { again, hits: hits.length });
  } finally {
    await bridge.close();
    await new Promise((res) => upstream.close(res));
  }
}

// ---------- 10. renderer wiring for inline answers (T-31 0.2.3 batch C): the controls exist and stay reachable ----------
{
  const hudJs = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'hud', 'hud.js'), 'utf8');
  const hudCss = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'hud', 'hud.css'), 'utf8');
  ok(/ask\.kind === 'ask'/.test(hudJs) && /last\.answer\.owner/.test(hudJs) && /answerAsk\(/.test(hudJs), 'hud.js: controls render only for kind:\'ask\' in the owner build and send through zumi.hud.answerAsk');
  ok(/hud\.answer\.locked/.test(hudJs) && /hud\.answer\.done/.test(hudJs) && /already_answered/.test(hudJs), 'hud.js: the locked state and the answered state are surfaced (never a silent failure)');
  ok(/\.hud-item\s*\{\s*pointer-events:\s*auto/.test(hudCss) && /\.hud-answer\s*\{[^}]*pointer-events:\s*auto/.test(hudCss), 'hud.css: the card and the answer controls are clickable (root stays pointer-events:none)');
  ok(/\.hud-group\.yield[^{]*\.hud-answer[^{]*\{[^}]*pointer-events:\s*none/.test(hudCss), 'hud.css: the answer controls yield with their group (an arm-swept group can never take a stray click)');
}

// ---------- 10b. the asks panel scrolls (T-31 fix round 1610): an expanded ask must not push the other asks out of the
// panel or clip its Send. The header stays, the list scrolls under the group's max-height; fitRows must leave the
// scrolling list alone, and expanding an ask must scroll the CARD itself (its title/question) into view -- aligning the
// answer controls instead is what pushed the question off the top (r2 nit). Static checks (both are renderer files). ----------
{
  const hudJs = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'hud', 'hud.js'), 'utf8');
  const hudCss = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'hud', 'hud.css'), 'utf8');
  ok(/\.hud-asks\s*>\s*\.hud-list\s*\{[^}]*overflow-y:\s*auto/.test(hudCss), 'hud.css: the asks list scrolls (overflow-y:auto) so an expanded ask cannot clip Send');
  ok(/getComputedStyle\(ol\)\.overflowY\s*===\s*['"]auto['"]/.test(hudJs), 'hud.js: fitRows leaves a scrolling list alone (never hides a reachable ask)');
  const m = /function onCardClick\([^)]*\)\s*\{([\s\S]*?)\n  \}/.exec(hudJs);
  const body = m ? m[1] : '';
  ok(Boolean(m) && /scrollIntoView/.test(body) && /el\.closest\('#hud-asks'\)/.test(body) && /\$\('hud-asks'\)\.querySelector/.test(body) && !/root\.querySelector\(`\.hud-item/.test(body),
    'hud.js: expanding an ask scrolls its card into view, scoped to #hud-asks (a task in both lists must scroll the RIGHT card, never the left)', body.trim().slice(0, 140));
  ok(/const taller = fresh\.getBoundingClientRect\(\)\.height\s*>\s*\$\('hud-asks'\)\.clientHeight/.test(body) && /fresh\.scrollIntoView\(\{\s*block:\s*taller\s*\?\s*'start'\s*:\s*'nearest'\s*\}\)/.test(body) && !/querySelector\(\s*'\.hud-answer'\s*\)/.test(body),
    'hud.js: the expand-scroll aligns the CARD top (block:start when it is taller than the list), never the answer controls, so the ask title stays visible', body.trim().slice(0, 140));
}

// ---------- 10c. the answer draft survives a repaint (T-31 fix round 1610 r3, DIAG #1: the C-52 lost answer) ----------
// Every hud:feed poll repaints the HUD (hud-host.mjs sends a feed on every read: 2 s in the harness, 20 s in prod) and
// paint() rebuilds the open ask card. Before this fix the pick/verdict, the note text and the send-enabled state lived
// only in the answerControls closure, so a pick made just before a poll was wiped, Send went back to disabled and doSend
// returned early (hud.js) -- the answer never reached the board. The fix keeps a per-ask draft (like the `answered` set
// already does) that survives the repaint. No Electron: a pure test of the draft + a static guard on hud.js. ----------
{
  const m = /function answerControls\(ask\)\s*\{([\s\S]*?)\n  \}/.exec(fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'hud', 'hud.js'), 'utf8'));
  const body = m ? m[1] : '';
  ok(Boolean(m) && /drafts\.get\(answerKey\(ask\)\)/.test(body), 'hud.js: the answer controls read the per-ask draft (drafts.get(answerKey(ask))) -- a repaint keeps the pick', body.trim().slice(0, 120));
  ok(Boolean(m) && !/const chosen = \{\s*choice:\s*null,\s*verdict:\s*null\s*\}/.test(body), 'hud.js: the answer controls no longer start from a fresh closure (the lost-answer bug)');
  ok(Boolean(m) && !/updateSend[^}]*chosen\.choice \|\| chosen\.verdict \|\| noteIn/.test(body), 'hud.js: updateSend reads the draft (canSendDraft), never the raw DOM note');

  // the pure draft: one mutable object per key, prune / drop / clear, and the can-send predicate
  const { createAnswerDrafts, canSendDraft } = hudLogic;
  ok(typeof createAnswerDrafts === 'function' && typeof canSendDraft === 'function', 'draft: hud-logic exports createAnswerDrafts + canSendDraft', { createAnswerDrafts: typeof createAnswerDrafts, canSendDraft: typeof canSendDraft });
  if (typeof createAnswerDrafts === 'function') {
    const d = createAnswerDrafts();
    const a = d.get('ask:ask-7@1'); a.verdict = 'approve';
    const b = d.get('ask:ask-7@1'); // a "repaint": the same key hands back the same mutable draft
    ok(b.verdict === 'approve' && canSendDraft(b), 'draft: a verdict picked before a repaint survives it (same object per key, Send stays enabled)', b);
    d.prune(new Set());
    ok(!canSendDraft(d.get('ask:ask-7@1')), 'draft: prune drops a key no longer in the feed (a fresh draft starts empty)');
    const t2 = d.get('ask:t@1'); t2.text = '  hi  ';
    ok(canSendDraft(t2) && canSendDraft({ choice: 'A' }) && canSendDraft({ verdict: 'reject' }) && !canSendDraft({ choice: null, verdict: null, text: '   ' }) && !canSendDraft(null) && !canSendDraft(undefined), 'draft: canSendDraft is true for a pick / verdict / non-blank note, false for a blank or missing draft');
    d.drop('ask:t@1');
    ok(!canSendDraft(d.get('ask:t@1')), 'draft: drop forgets one ask (an answered ask)');
    d.get('ask:x@1').choice = 'A';
    d.clear();
    ok(!canSendDraft(d.get('ask:x@1')), 'draft: clear drops every draft (the HUD switched off)');
  }

  // the cadence that triggers it: an UNCHANGED board still repaints on every poll
  {
    let stC = {};
    const sentC = [];
    const hC = createHudHost({ getState: async () => ({ ok: true, state: state() }), idleSeconds: () => 2, settings: { get: () => stC, set: (p) => { stC = { ...stC, ...p }; } }, send: (p) => sentC.push(p), decide: () => ({ action: 'refuse' }), open: async () => {}, pollMs: 3_600_000, cooldownMs: 0 });
    hC.setPrefs({ style: 'a' });
    await hC.poll();
    await hC.poll();
    ok(sentC.filter((p) => p.feed).length === 2, 'cadence: two polls of an UNCHANGED board still send two feeds (each repaints the HUD) -- the renderer must survive a repaint', sentC.map((p) => Boolean(p.feed)));
    hC.stop();
  }
}

// ---------- 10d. the expanded ask grows the asks panel up to the arm-safe line (T-31 fix round 1610 r3, DIAG #2) ----------
// The right group rests at top 24% / max-height 24% (hud.css). At 1280x800 that leaves a list viewport of about 125 px,
// less than an expanded ask card (~201 px), so the title and Send never fit together. One rule lifts the group's top to
// 14px and caps it at calc(48% - 14px): the BOTTOM edge stays at 48% (the arm-safe line, hud.css's 06-10 rule), so the
// group only grows UP into the top-right corner the left group already occupies, never down into the sideways-swing
// band. Specificity (0,4,0) also beats style B's `.hud[data-style="b"] .hud-right` (0,3,0). Static checks (hud.css). ----------
{
  const hudCss = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'hud', 'hud.css'), 'utf8');
  const rule = /\.hud-right:has\([^{]*\.hud-item\.open[^{]*\)\s*\{([^}]*)\}/.exec(hudCss);
  const body = rule ? rule[1] : '';
  const topM = /(?:^|;)\s*top:\s*([0-9.]+)px/.exec(body);
  const mhM = /(?:^|;)\s*max-height:\s*calc\(\s*([0-9.]+)%\s*-\s*([0-9.]+)px\s*\)/.exec(body);
  const topN = topM ? Number(topM[1]) : NaN;
  const pct = mhM ? Number(mhM[1]) : NaN;
  const subN = mhM ? Number(mhM[2]) : NaN;
  ok(Boolean(rule) && Number.isFinite(topN) && Boolean(mhM), 'hud.css: an expanded ask lifts the right group with .hud-right:has(... .hud-item.open) { top: …px; max-height: calc(…% - …px) }', body.trim());
  // bottom edge = top + (pct% of the stage) - sub; it must sit at or above 48% (the arm-safe line) for every stage height
  const bottomsAt48 = [692, 972].every((H) => topN + (pct / 100) * H - subN <= 0.48 * H + 1e-9);
  ok(Number.isFinite(topN) && Math.abs(pct - 48) < 1e-9 && Math.abs(subN - topN) < 1e-9 && bottomsAt48,
    'hud.css: the lifted group bottoms out at 48% (top 14px, max-height calc(48% - 14px)) -- never into the sideways-swing band', { topN, pct, subN });
  ok(/\.hud-right\s*\{[^}]*top:\s*24%[^}]*max-height:\s*24%/.test(hudCss), 'hud.css: the base .hud-right stays top:24%; max-height:24% (the resting look is unchanged)');
  // fit model: at 1280x800 (stage H≈692) and 1920x1080 (H≈972) the list viewport must hold the largest expanded ask
  const PANEL_CHROME_PX = 41, EXPANDED_ASK_MAX_PX = 201;
  const listPx = (H) => (topN + (pct / 100) * H - subN) - PANEL_CHROME_PX;
  ok(Number.isFinite(topN) && [692, 972].every((H) => listPx(H) >= EXPANDED_ASK_MAX_PX),
    'hud.css: the panel then fits the largest expanded ask (title + Send together) at 1280x800 and 1920x1080', Number.isFinite(topN) ? [692, 972].map((H) => Math.round(listPx(H))) : null);
}

// ---------- 10e. a failed send reaches the CURRENT ask card (T-31 fix round 1610 r3, review fix) ----------
// A poll can repaint the HUD while a send is in flight (hud-host.mjs sends a feed on every read). The repaint replaces
// the answer controls' DOM, so the old doSend's `status` / `send` refs point at the replaced card and the error was lost
// (the new card stayed on "Sending…" until the next poll). The send result must ride the per-ask draft (keyed by ask
// revision), so the CURRENT card shows Sending… / the error / done. Static guards (hud.js is a renderer file, not
// importable here), same shape as 10c. ----------
{
  const hudJs = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'hud', 'hud.js'), 'utf8');
  const dm = /async function doSend\(\)\s*\{([\s\S]*?)\n    \}/.exec(hudJs);
  const db = dm ? dm[1] : '';
  ok(Boolean(dm) && /chosen\.error\s*=/.test(db) && /paint\(\)/.test(db) && !/status\.textContent/.test(db) && !/send\.disabled\s*=\s*false/.test(db),
    'hud.js: doSend routes the send result through the draft (chosen.error) and repaints -- never writes the error to the captured (replaced) card elements', db.trim().slice(0, 160));
  const am = /function answerControls\(ask\)\s*\{([\s\S]*?)\n  \}/.exec(hudJs);
  const ab = am ? am[1] : '';
  ok(Boolean(am) && /status\.textContent\s*=\s*t\(answerReasonKey\(chosen\.error\)\)/.test(ab),
    'hud.js: answerControls renders a failed send from the draft (chosen.error -> the reason line on the CURRENT card)');
}

// ---------- 10f. the HUD always paints above the analysis box (T-31 fix r3 review + r4 defect 1) ----------
// styles.css puts .analysis (#analysis) and .analysis-off (#an-off) at right:16px / top:56px. The HUD precedes them in
// index.html's DOM, so without a lift that box paints over the HUD. r3 lifted the HUD only while an ask was open
// (.hud:has(... .hud-item.open)), which fixed the raised panel but left the RESTING asks panel covered: hit-tests on
// its title rows landed on ANALYSIS and 2 of 3 ask cards could not be clicked (QC round 4). The lift is unconditional
// now. z-index, never a top shift -- a shift would move the group's arm-safe 48% bottom edge (hud.css). ----------
{
  const hudCss = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'hud', 'hud.css'), 'utf8');
  const stylesCss = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'styles.css'), 'utf8');
  const an = /\.analysis\s*\{[^}]*\}/.exec(stylesCss);
  const anOff = /\.analysis-off\s*\{[^}]*\}/.exec(stylesCss);
  ok(Boolean(an) && Boolean(anOff) && !/z-index/.test(an[0]) && !/z-index/.test(anOff[0]),
    'styles.css: the analysis box and #an-off declare no z-index (the HUD, earlier in the DOM, must lift itself above them)');
  const bareHud = [...hudCss.matchAll(/(?:^|\n)\s*\.hud\s*\{([^}]*)\}/g)].map((m) => m[1]);
  const lift = bareHud.find((b) => /(?:^|;)\s*z-index:\s*\d+/.test(b));
  const zM = lift ? /(?:^|;)\s*z-index:\s*(\d+)\s*(?:;|$)/.exec(lift) : null;
  ok(Boolean(lift) && Number(zM[1]) >= 1 && !/\.hud:has\([^{}]*\.hud-item\.open[^{}]*\)\s*\{[^}]*z-index/.test(hudCss),
    'hud.css: the HUD stacks above the analysis box unconditionally (bare .hud z-index; the lift is NOT conditional on .hud-item.open) -- the resting asks panel stays clickable', lift ? lift.trim() : null);
}

// ---------- 10g. the panel backing: 58% at rest, 93% for the asks panel only (T-31 fix round 4, defect 2 + review 2) ----------
// At r3 the panel background was 58% opaque, so with the analysis box visible its text read straight through a raised
// ask card (QC round 4 r4-2). r4 defect 2 then made EVERY panel 93%: the whole HUD read as opaque blocks. r4 review 2
// splits it: the base --holo-bg stays 58% and only the asks panel (.hud-right) lifts to 93%. The lift is a plain
// `.hud-right` class, so it holds for both styles (style B overrides only the panel radius / padding). ----------
{
  const hudCss = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'hud', 'hud.css'), 'utf8');
  const alpha = (s) => { const m = /(\d+(?:\.\d+)?)%,\s*transparent\s*\)\s*$/.exec(String(s).trim()); return m ? Number(m[1]) / 100 : NaN; };
  const baseBg = (/--holo-bg:\s*([^;]+);/.exec(hudCss) || [])[1] || '';
  ok(Math.abs(alpha(baseBg) - 0.58) < 1e-9, 'hud.css: the base --holo-bg is 58% opaque (all panels but the asks stay translucent -- the r4 defect-2 regression is reverted)', { alpha: alpha(baseBg) });
  const rightBlock = [...hudCss.matchAll(/\.hud-right[^{]*\{([^}]*)\}/g)].map((m) => m[1]).find((b) => /--holo-bg/.test(b)) || '';
  const rightBg = (/--holo-bg:\s*([^;]+);/.exec(rightBlock) || [])[1] || '';
  ok(Math.abs(alpha(rightBg) - 0.93) < 1e-9, 'hud.css: only the asks panel (.hud-right) lifts --holo-bg to 93%, so a raised ask still hides the analysis text behind it (r4-2 holds)', { alpha: alpha(rightBg) });
  ok(/\.hud-panel\s*\{[^}]*var\(--holo-bg\)/.test(hudCss), 'hud.css: .hud-panel paints on var(--holo-bg) (the backing is the panel base, not a passing layer)');
  const styleBRules = [...hudCss.matchAll(/\.hud\[data-style="b"\][^{}]*\{[^}]*\}/g)].map((m) => m[0]);
  ok(styleBRules.length > 0 && !styleBRules.some((r) => /--holo-bg|background/.test(r)),
    'hud.css: style B overrides neither --holo-bg nor the .hud-panel background, so the plain .hud-right 93% lift holds for both styles');
}

// ---------- 10h. the transcript strips stay above the HUD (T-31 fix r4, review 1) ----------
// hud.css rests the HUD at z-index:1, which lifts it above the two bottom strips (.talk / #heard), both absolute with
// no z-index and earlier in the DOM -- a long reply / the heard pill would sit under the left panel. Both are lifted
// to z-index:2 (> the HUD's 1). Both are already position:absolute, so the z-index applies. ----------
{
  const hudCss = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'hud', 'hud.css'), 'utf8');
  const stylesCss = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'styles.css'), 'utf8');
  const bareHud = [...hudCss.matchAll(/(?:^|\n)\s*\.hud\s*\{([^}]*)\}/g)].map((m) => m[1]);
  const hudZM = bareHud.map((b) => (/(?:^|;)\s*z-index:\s*(\d+)/.exec(b) || [])[1]).find(Boolean);
  const strip = /(?:^|\n)\s*\.talk\s*,\s*\.heard\s*\{([^}]*)\}/.exec(stylesCss);
  const stripZ = strip ? (/(?:^|;)\s*z-index:\s*(\d+)/.exec(strip[1]) || [])[1] : null;
  ok(/\.talk\s*\{[^}]*position:\s*absolute/.test(stylesCss) && /\.heard\s*\{[^}]*position:\s*absolute/.test(stylesCss),
    'styles.css: .talk and .heard are position:absolute, so a z-index on them takes effect');
  ok(Boolean(strip) && Boolean(stripZ) && Boolean(hudZM) && Number(stripZ) > Number(hudZM),
    'styles.css: .talk / .heard lift to a z-index above the HUD (.hud), so a long reply / the heard pill is never hidden under a HUD panel', { hudZ: hudZM, stripZ });
}

// ---------- 10i. the analysis box / #an-off sit below the right asks group while the HUD is on (T-31 fix r4, review 3) ----------
// The right asks group can bottom out at 48% of the stage (hud.css). With the HUD visible the analysis box / #an-off
// (base top:56px, right:16px) fall inside that range and the two boxes cover each other, so a :has() rule scoped to
// the HUD-visible case pushes both below 48% and caps their height (scroll). With the HUD off (hidden / data-style
// "off") the base top:56px is untouched -- the layout is unchanged. ----------
{
  const stylesCss = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'styles.css'), 'utf8');
  const baseAn = /(?:^|\n)\s*\.analysis\s*\{([^}]*)\}/.exec(stylesCss);
  const baseOff = /(?:^|\n)\s*\.analysis-off\s*\{([^}]*)\}/.exec(stylesCss);
  ok(Boolean(baseAn) && /top:\s*56px/.test(baseAn[1]) && Boolean(baseOff) && /top:\s*56px/.test(baseOff[1]),
    'styles.css: the base .analysis / .analysis-off keep top:56px (the HUD-off layout is unchanged)');
  const hudOn = ':has(> #hud:not([hidden]):not([data-style="off"]))';
  const sel = `#stage${hudOn}`;
  const idx = stylesCss.indexOf(sel);
  const body = idx >= 0 ? stylesCss.slice(idx, stylesCss.indexOf('}', idx)) : '';
  ok(stylesCss.includes(`${sel} .analysis`) && stylesCss.includes(`${sel} .analysis-off`),
    'styles.css: the offset rule is scoped to the HUD-visible case (#hud not hidden and data-style != off) and covers both .analysis and .analysis-off');
  ok(idx >= 0 && /top:\s*calc\(48%\s*\+\s*8px\)/.test(body) && /max-height:/.test(body) && /overflow(-y)?:\s*auto/.test(body),
    'styles.css: while the HUD is on the box drops below the asks group 48% bottom (top: calc(48% + 8px)) and caps/scrolls its height so it stays on the stage', body.trim().slice(0, 120));
}

// ---------- age labels: the board rail's rule, fixed clock (T-31 alpha.10, owner 31-10) ----------
// The live board's attention.waiting `since` values read at 2026-10-31T17:05:35Z. The rail
// (vendor/laneboard/public/app.js shortDur) floors whole days; the HUD rounded, so the same item read a day older there.
{
  const { ageLabel } = hudLogic;
  ok(typeof ageLabel === 'function', 'age: hud-logic exports ageLabel');
  if (typeof ageLabel === 'function') {
    const NOW = Date.parse('2026-10-31T17:05:35.055Z');
    const cases = [
      ['GW step revoke-9router (11.6 days)', '2026-10-20T02:13:49.560Z', '11d'],
      ['V-02 ask-8440 (12.7 days)', '2026-10-18T23:33:19.477Z', '12d'],
      ['H-03 proposal inb-2628 (16.5 days)', '2026-10-15T06:10:24.380Z', '16d'],
      ['47.9 h stays hours', new Date(NOW - 47.9 * 3600000).toISOString(), '47h'],
      ['exactly 48 h is 2d', new Date(NOW - 48 * 3600000).toISOString(), '2d'],
      ['90 min is 1h (floored)', new Date(NOW - 90 * 60000).toISOString(), '1h'],
      ['59 min', new Date(NOW - 59 * 60000).toISOString(), '59m'],
      ['10 s is now', new Date(NOW - 10000).toISOString(), 'now'],
      ['a future time is blank', new Date(NOW + 60000).toISOString(), ''],
      ['a missing time is blank', null, ''],
    ];
    for (const [name, since, want] of cases) { const got = ageLabel(since, NOW, 'now'); ok(got === want, `age: ${name} -> ${want}`, { got }); }
    // The rail's own formula on the same inputs, so the two surfaces cannot drift apart again.
    const shortDur = (ms) => (ms >= 172800000 ? Math.floor(ms / 86400000) + 'd' : ms >= 3600000 ? Math.floor(ms / 3600000) + 'h' : Math.max(1, Math.round(ms / 60000)) + 'm');
    const railSrc = fs.readFileSync(path.join(ROOT, 'vendor', 'laneboard', 'public', 'app.js'), 'utf8');
    ok(railSrc.includes("const shortDur = ms => (ms >= 172800000 ? Math.floor(ms / 86400000) + 'd' : ms >= 3600000 ? Math.floor(ms / 3600000) + 'h'"), 'age: the rail formula this check mirrors is still the vendored one');
    for (const [, since] of cases.slice(0, 7)) { const ms = NOW - Date.parse(since); ok(ageLabel(since, NOW) === shortDur(ms), `age: HUD and rail agree at ${since}`, { hud: ageLabel(since, NOW), rail: shortDur(ms) }); }
  }
  const hudJs = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'hud', 'hud.js'), 'utf8');
  ok(/const age = \(iso\) => ageLabel\(iso, Date\.now\(\), t\('hud\.now'\)\);/.test(hudJs) && !/Math\.round\(h \/ 24\)/.test(hudJs), 'age: hud.js formats every age through ageLabel (no local rounding)');
}

console.log(`\ncheck:hud ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);