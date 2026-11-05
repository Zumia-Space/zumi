// T-31 0.2.7 "arms locked" step 1 gate (DIAG 20-10 §5 row 1; root cause §3.5), plain Node, no Electron:
// a board event / HUD reaction exits 'sleepy' but used to leave the idle ladder ~180 s stale, so the very next
// idleTimers() frame re-entered 'sleepy' over the board gesture (measured 8/8 events). This check drives the
// REAL ReflexEngine + REAL catalog on a fake clock:
//   1. noteActivity(): resets lastInputAt / nextBoredAt, never fires the wake startle by default, and leaves
//      nextVarietyAt alone; noteInput() still restarts the variety timer.
//   2. app.js onBoardEvent()'s sequence -> stays awake for the whole 60 s normal idle window, no sleepy trigger,
//      no wake startle; the pre-fix sequence (exitState only) is shown to re-sleep on the next frame.
//   3. hud.js react()'s sequence for done / blocked / running -> same guarantee.
//   4. Source wiring: app.js and hud.js call noteActivity() before exiting 'sleepy'.
//   node scripts/check-arms-life.mjs [--model <file.vrm>]   (npm run check:arms-life)
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, clock, modelFromArgs, loadHarness, makeFreshEngine, watchReactions, reporter } from './lib/reflex-harness.mjs';
import { stateToVariant, hudCardRect, rectToNdc, CARD_ARM_VARIANTS, CARD_ARM_LEFT_VARIANTS, CARD_FLOAT_LEFT_VARIANTS } from '../src/renderer/hud/hud-logic.js';
import { clampForHoloPanel } from '../src/renderer/reflex/engine.js';

const modelPath = modelFromArgs();
if (!fs.existsSync(modelPath)) { console.error(`usage: npm run check:arms-life -- --model <file.vrm> (missing: ${modelPath})`); process.exit(2); }
const { vrm, camera } = await loadHarness(modelPath).catch((e) => { console.error(e.message); process.exit(2); });
const { ok, finish } = reporter();
const freshEngine = (seed) => makeFreshEngine(vrm, camera, seed);

// =====================================================================================
// 1. noteActivity() vs noteInput() -- the idle-ladder semantics the board path relies on
// =====================================================================================
{
  const { engine } = freshEngine(31);
  clock.t = 1_000_000;
  engine.lastInputAt = clock.t - 200_000; // long idle: the ladder WOULD escalate
  engine.nextBoredAt = 0;
  const varietyAt = clock.t + 12_345;
  engine.nextVarietyAt = varietyAt;
  const w = watchReactions(engine);

  const woke = engine.noteActivity();
  ok(woke === false, 'noteActivity: returns false and starts no wake startle by default', String(woke));
  ok(engine.lastInputAt === clock.t, 'noteActivity: resets lastInputAt to now (the ladder sees activity)', String(engine.lastInputAt - clock.t));
  ok(engine.nextBoredAt === clock.t + 60_000, 'noteActivity: pushes nextBoredAt 60 s out', String(engine.nextBoredAt - clock.t));
  ok(engine.nextVarietyAt === varietyAt, 'noteActivity: leaves nextVarietyAt untouched (arm variety keeps its own schedule)', String(engine.nextVarietyAt - varietyAt));
  ok(w.count('wake') === 0, 'noteActivity: no wake reaction fired', String(w.count('wake')));

  engine.nextVarietyAt = varietyAt;
  const woke2 = engine.noteInput();
  const varietyGap = engine.nextVarietyAt - clock.t;
  ok(woke2 === false && varietyGap >= 15_000 && varietyGap <= 40_000, 'noteInput: still restarts the 15-40 s variety timer (keys/clicks keep the full reset)', String(varietyGap));

  // A board reaction calls noteActivity() while 'sleepy' is still set (it exits right after): no startle.
  engine.trigger('sleepy');
  ok(engine.isState('sleepy'), 'setup: engine is asleep before the board activity call', '');
  const woke3 = engine.noteActivity();
  ok(woke3 === false && engine.isState('sleepy') && w.count('wake') === 0, 'noteActivity: on a sleeping engine it does not exit/wake by itself (the caller owns the sleepy exit)', String(woke3));
}

// =====================================================================================
// 2. board event -> stays awake for the 60 s normal idle window
// =====================================================================================
// The exact sequence app.js onBoardEvent() / hud.js react() run after the fix.
function boardReaction(engine, catalog, { activity = true, look = { x: -1.6, y: 0.35 }, variant = 'double-take' } = {}) {
  if (activity) engine.noteActivity();
  if (engine.isState('sleepy')) engine.exitState('sleepy');
  catalog.forceNext('board', variant);
  return engine.trigger('board', { look });
}
// Run the idle ladder at ~4 frames/s for `ms`; returns the first instant it re-entered 'sleepy' (or -1).
function runLadder(engine, start, ms) {
  for (let dt = 0; dt <= ms; dt += 250) {
    clock.t = start + dt;
    engine.idleTimers(clock.t);
    if (engine.isState('sleepy')) return dt;
  }
  return -1;
}
{
  const { engine, catalog } = freshEngine(41);
  clock.t = 2_000_000;
  engine.lastInputAt = clock.t - 190_000; // past IDLE_SLEEPY_MS (180 s)
  engine.nextVarietyAt = clock.t + 1_000_000; // isolate the bored/sleepy ladder from the variety layer
  engine.idleTimers(clock.t);
  ok(engine.isState('sleepy'), 'board: setup -- 190 s idle puts her to sleep', '');

  const w = watchReactions(engine);
  boardReaction(engine, catalog, { activity: true });
  ok(!engine.isState('sleepy'), 'board: the reaction exits sleepy and plays the board gesture', '');
  ok(w.count('wake') === 0, 'board: no wake startle (the board gesture is the reaction)', String(w.count('wake')));

  const backAt = runLadder(engine, clock.t, 65_000);
  ok(backAt < 0 || backAt > 60_000, 'board: stays awake for the whole 60 s normal idle window (no re-sleep frame)', `re-slept at +${backAt}ms`);
  ok(w.count('sleepy') === 0, 'board: no sleepy trigger after the reaction, 0/1 (was 8/8)', String(w.count('sleepy')));
  ok(w.count('bored') >= 1, 'board: the ladder is still live -- bored fires once the 60 s window is over', String(w.count('bored')));
}
{
  // Pre-fix control: exiting 'sleepy' without resetting the ladder re-enters it on the next frame.
  const { engine, catalog } = freshEngine(42);
  clock.t = 2_200_000;
  engine.lastInputAt = clock.t - 190_000;
  engine.nextVarietyAt = clock.t + 1_000_000;
  engine.idleTimers(clock.t);
  ok(engine.isState('sleepy'), 'board control: setup asleep', '');
  const w = watchReactions(engine);
  boardReaction(engine, catalog, { activity: false }); // the 0.2.6 code: exitState + board only
  clock.t += 16;
  engine.idleTimers(clock.t);
  ok(engine.isState('sleepy') && w.count('sleepy') === 1, 'board control: without noteActivity she re-sleeps on the very next frame (the measured bug)', `sleepy=${engine.isState('sleepy')} count=${w.count('sleepy')}`);
}
{
  // The HUD path (hud.js react -> stateToVariant): same guarantee for every reaction state.
  for (const state of ['done', 'blocked', 'running']) {
    const { engine, catalog } = freshEngine(43);
    clock.t = 2_400_000 + state.length * 1000;
    engine.lastInputAt = clock.t - 190_000;
    engine.nextVarietyAt = clock.t + 1_000_000;
    engine.idleTimers(clock.t);
    const variant = stateToVariant(state);
    const w = watchReactions(engine);
    boardReaction(engine, catalog, { activity: true, variant, look: { x: 0.6, y: 0.1 } });
    const backAt = runLadder(engine, clock.t, 60_000);
    ok(!engine.isState('sleepy') && backAt < 0 && w.count('sleepy') === 0 && w.count('wake') === 0,
      `hud: '${state}' (${variant}) reaction keeps her awake 60 s with no wake startle`, `re-slept at +${backAt}ms`);
  }
}

// =====================================================================================
// 3. source wiring -- the fix is in the real call sites, not only in the engine API
// =====================================================================================
{
  const app = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
  const onBoard = app.slice(app.indexOf('const onBoardEvent'), app.indexOf('zumi.onReflexEvent'));
  ok(/engine\.noteActivity\(\)[\s\S]*engine\.isState\('sleepy'\)/.test(onBoard), 'wiring: app.js onBoardEvent() calls noteActivity() before exiting sleepy', '');

  const hud = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'hud', 'hud.js'), 'utf8');
  const react = hud.slice(hud.indexOf('async function react'), hud.indexOf('// Dev/test runs only'));
  ok(/engine\.noteActivity\(\)[\s\S]*engine\.isState\('sleepy'\)/.test(react), 'wiring: hud.js react() calls noteActivity() before exiting sleepy', '');
}

// =====================================================================================
// 4. 0.2.7 step 3 gate: the idle-variety layer moves an arm in FLOAT too (DIAG 20-10 §5 row 3)
// =====================================================================================
// The bored catalog is DATA. 0.2.6 had 3 variants, only stretch/yawn moved an arm, and the float clamp stripped the
// stretch -> 4-5 arm-moving plays per 5 min against 9-10 seated (DIAG §2). 0.2.7 adds panel-safe fidgets on existing
// targets (clasp / chest / chin / left hip / left beside-head). This runs the REAL engine + player + rig for 5
// simulated minutes of pointer activity (the variety timer stays alive, step 2) in both modes, records the command
// each play actually received (so float is the CLAMPED command), and replays it on the real rig to decide whether it
// moves an upperArm/lowerArm/hand > 15 deg. Assertions: float >= seated, float >= 8, and arm-moving is the majority.
// (The panel clearance of these same commands is §11b in check-float-holo.mjs -- the projection reuse.)
const ARM_MOVING_DEG = 15;
function armSwing(probe, cmd) {
  probe.player.stopAll(true);
  clock.t = 0;
  probe.update(0.04); // settle the arm-quiet pose in this mode
  const rest = {};
  for (const side of ['left', 'right']) for (const b of ['UpperArm', 'LowerArm', 'Hand']) rest[side + b] = probe.rig.nodes[side + b].quaternion.clone();
  probe.player.play(cmd, { noJitter: true });
  let max = 0;
  for (let ms = 40; ms <= 3000; ms += 40) {
    clock.t = ms;
    probe.update(0.04);
    for (const side of ['left', 'right']) for (const b of ['UpperArm', 'LowerArm', 'Hand']) max = Math.max(max, probe.rig.nodes[side + b].quaternion.angleTo(rest[side + b]) * 180 / Math.PI);
  }
  probe.player.stopAll(true);
  return max;
}

// 5 simulated minutes of "anh at the PC": the pointer-activity path (noteActivity) every 3 s, which keeps idle < 60 s
// so every 'bored' trigger here is the idle-variety layer, and the idle ladder every 100 ms.
function varietySession(holo) {
  const { engine } = freshEngine(71);
  engine.autoIdle = true;
  engine.setHoloPanel(holo);
  engine.rig.seated = !holo;
  clock.t = 5_000_000;
  engine.lastInputAt = clock.t;
  engine.nextBoredAt = 0;
  engine.nextVarietyAt = clock.t + 15_000;
  const played = [];
  const origPlay = engine.player.play.bind(engine.player);
  engine.player.play = (cmd, opts) => {
    const res = origPlay(cmd, opts);
    if (res.ok) played.push({ trigger: opts && opts.meta && opts.meta.trigger, variant: opts && opts.meta && opts.meta.variant, cmd });
    return res;
  };
  const start = clock.t;
  for (let ms = 0; ms <= 300_000; ms += 100) {
    clock.t = start + ms;
    if (ms % 3000 === 0) engine.noteActivity({ wake: true }); // input.js pointerMove()'s engine call
    engine.idleTimers(clock.t);
  }
  engine.player.play = origPlay;
  return { played };
}

{
  const seated = varietySession(false);
  const float = varietySession(true);
  const seatedProbe = freshEngine(72).engine;
  seatedProbe.autoIdle = false;
  seatedProbe.rig.seated = true;
  const floatProbe = freshEngine(73).engine;
  floatProbe.autoIdle = false;
  floatProbe.rig.seated = false;
  const countArm = (session, probe) => session.played.map((p) => ({ ...p, swing: armSwing(probe, p.cmd) })).filter((p) => p.swing > ARM_MOVING_DEG);
  const seatedArm = countArm(seated, seatedProbe);
  const floatArm = countArm(float, floatProbe);
  const variants = (list) => [...new Set(list.map((p) => p.variant))].sort();
  console.log(`  [variety 5 min] seated: ${seated.played.length} plays, ${seatedArm.length} arm-moving (${variants(seatedArm).join(', ')})`);
  console.log(`  [variety 5 min] float:  ${float.played.length} plays, ${floatArm.length} arm-moving (${variants(floatArm).join(', ')})`);

  ok(seated.played.length >= 8 && float.played.length >= 8, 'variety: both 5-min sessions played >= 8 idle-variety gestures', `seated ${seated.played.length}, float ${float.played.length}`);
  ok(floatArm.length >= seatedArm.length, 'variety: FLOAT arm-moving plays >= the seated count in the same simulated 5 min (the float clamp no longer costs the stretch arm)', `float ${floatArm.length}, seated ${seatedArm.length}`);
  ok(floatArm.length >= 8, 'variety: float moves an arm in >= 8 plays / 5 min (was 4-5, DIAG §5 row 3)', String(floatArm.length));
  ok(seatedArm.length / Math.max(1, seated.played.length) >= 0.7 && floatArm.length / Math.max(1, float.played.length) >= 0.7,
    'variety: an arm moves most of the time (>= 70 % of plays) in BOTH modes', `seated ${(seatedArm.length / Math.max(1, seated.played.length) * 100).toFixed(0)}%, float ${(floatArm.length / Math.max(1, float.played.length) * 100).toFixed(0)}%`);
  // Every new fidget is measured directly (not seed-luck): it must move an arm in BOTH modes, and the float command
  // is the one the clamp hands the player (its data is panel-safe, so the clamp leaves it unchanged).
  const fidgets = ['hand-clasp', 'hand-on-chest', 'chin-rest', 'hand-on-hip', 'tuck-hair'];
  const boredDef = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'reflex', 'gestures', 'bored.json'), 'utf8'));
  for (const id of fidgets) {
    const variant = boredDef.variants.find((v) => v.id === id);
    if (!variant) { ok(false, `variety: fidget '${id}' exists in bored.json`, ''); continue; }
    const floatCmd = clampForHoloPanel(variant.command);
    const sDeg = armSwing(seatedProbe, variant.command), fDeg = armSwing(floatProbe, floatCmd);
    ok(sDeg > ARM_MOVING_DEG && fDeg > ARM_MOVING_DEG, `variety: fidget '${id}' moves an arm in BOTH modes (seated ${sDeg.toFixed(1)} deg, float ${fDeg.toFixed(1)} deg)`, { seated: sDeg, float: fDeg });
  }
}

// =====================================================================================
// 5. 0.2.7 step 5 gate: a board reaction with an arm, chosen by the card's REAL side (DIAG 21-10 row 5)
// =====================================================================================
// The cards come from hud.css's own layout (hudCardRect), not a hand-placed side: the step updates are the LEFT
// group, the asks the RIGHT one. Seated left card -> the right hand points across at it; float left card -> the
// panel hand (her right) is unavailable, so the other hand's small wave plays and never enters the holo panel
// (the real-rig projection is check-float-holo §11b / check:hud-clearance). Blocked keeps its 'sad' expression on
// BOTH sides. This drives the REAL engine so the command the player receives is what production plays.
{
  const vp = { left: 0, top: 0, width: 1204, height: 689 };
  const leftCard = rectToNdc(hudCardRect('left', vp), vp);
  const rightCard = rectToNdc(hudCardRect('right', vp), vp);
  ok(leftCard.x < 0 && rightCard.x > 0, 'board: the HUD layout puts the step-update card left and the ask card right', { left: leftCard.x, right: rightCard.x });

  const { engine, catalog } = freshEngine(81);
  const played = [];
  const origPlay = engine.player.play.bind(engine.player);
  engine.player.play = (cmd, opts) => { const res = origPlay(cmd, opts); if (res.ok) played.push(cmd); return res; };
  const play = (state, look, float) => {
    catalog.forceNext('board', stateToVariant(state, look, { float }));
    engine.trigger('board', { look });
    return played[played.length - 1];
  };
  const armOn = (cmd, hand, target) => Boolean(cmd && Array.isArray(cmd.reach) && cmd.reach.some((r) => r && r.hand === hand && r.target === target));
  const expr = (cmd) => (cmd && cmd.expressions ? cmd.expressions.map((e) => e.name) : []);

  // Seated, real left card: the hand on that side (her right) points across at it, per state.
  engine.setHoloPanel(false);
  const seatedLeft = ['done', 'blocked', 'running'].map((state) => play(state, leftCard));
  ok(seatedLeft.every((cmd) => armOn(cmd, 'right', 'point-up')) && seatedLeft.every((cmd) => !cmd.reach.some((r) => r && r.hand === 'left')),
    'board: seated left card -> the right hand points toward it (a screen-left card is no longer head-only)', seatedLeft.map((c) => c.id));
  ok(expr(seatedLeft[0]).includes('happy') && expr(seatedLeft[1]).includes('sad') && !expr(seatedLeft[2]).some((n) => ['happy', 'sad', 'surprised'].includes(n)),
    'board: the left card keeps the status expression (done happy / blocked concerned / running neutral)', seatedLeft.map(expr));

  // Seated, real right card: the left hand (away from the panel) points at it, per state.
  const seatedRight = ['done', 'blocked'].map((state) => play(state, rightCard));
  ok(seatedRight.every((cmd) => armOn(cmd, 'left', 'point-up')), 'board: seated right card -> the left hand points toward it', seatedRight.map((c) => c.id));
  ok(expr(seatedRight[1]).includes('sad'), 'board: the right card also keeps blocked -> concerned (was surprised before)', expr(seatedRight[1]));

  // Float, real left card: the right hand WOULD be the panel hand, so the other hand's small wave plays instead.
  engine.setHoloPanel(true);
  const floatLeft = play('blocked', leftCard, true);
  ok(stateToVariant('blocked', leftCard, { float: true }) === CARD_FLOAT_LEFT_VARIANTS.blocked && armOn(floatLeft, 'left', 'wave-small') && !floatLeft.reach.some((r) => r && r.hand === 'right'),
    'board: float left card -> the panel-far (left) hand small wave, never the panel-side right hand', floatLeft && floatLeft.reach);
  ok(expr(floatLeft).includes('sad'), 'board: the float left-card alternative keeps blocked -> concerned', expr(floatLeft));
  ok(armOn(floatLeft, 'left', 'wave-small') && leftCard.x < 0 && stateToVariant('blocked', leftCard, { float: false }) === CARD_ARM_LEFT_VARIANTS.blocked,
    'board: the same real left card picks opposite arms per mode (seated right point, float left wave)');
  // The float command that the engine actually hands over is the untouched one: its raised left reach is panel-far.
  ok(floatLeft === catalog.get('board').variants.find((v) => v.id === CARD_FLOAT_LEFT_VARIANTS.blocked).command,
    'board: the float alternative is the authored command (no clamp needed on the panel-far hand)');
}

finish();
