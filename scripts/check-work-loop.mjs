// Work-loop gate (T-31 C1 steps 8-10): plain Node, no Electron, no window, no network, no VRM. Proves the renderer's
// per-frame work beat scheduler (talk/work-loop.js) on a FAKE clock (milliseconds, no sleeps):
//   1. read panel        every target across a beat stays INSIDE the panel NDC rect, within SCAN_SPAN of its centre
//                        (small offsets), moves through SCAN_LINES lines over a 3-4 s beat
//   2. weighted pick     no immediate repeat (Catalog.pick's rule) and the counts follow the weights
//   3. the loop          read beat (read-only table): working on -> primaryGaze target inside the rect; a beat
//                        restarts; speech, typing and a talk turn in flight yield (gaze handed back); the beat
//                        resumes; panel off and working off -> no beat, normal gaze. The SHIPPED table alternates
//                        read-panel and panel-touch and both keep the gaze inside the rect (the touch beat's own
//                        contact is proven against the real rig in check-panel-touch.mjs)
//   3c. look at anh      over 10 simulated minutes the look-at-anh beat fires on a 20-40 s gap, holds the camera for
//                        0.8-1.5 s with the shipped small smile, and work is back on the panel right after
//   3d. hover rule       a synthetic pointer resting on her for 400 ms looks up within 500 ms, holds at the camera
//                        while hovered, never longer than 4 s, and work resumes after the pointer leaves
//   3e. reaction resume  a live poke/pat releases the stage and work resumes exactly 1.5 s after it ends
//   3f. task events      step done -> the HUD's nod-smile at the panel; blocked -> concerned at the panel, then a
//                        look at the camera, then work; both ignored when she is not working
//   4. cursor reflex     the REAL ReflexEngine suppresses trigger('cursor') while working (CONCEPTS §5) and fires it
//                        again when work ends; the suppressed call never reaches the player
//   5. gaze slot         the REAL engine's setWorkGaze writes primaryGaze (the slot gazeLayer reads) and restores the
//                        active view's own primary look_target when a beat ends
//   6. holo rect         HoloScreen.screenRect() projects the real panel mesh to a sane NDC rectangle around screenNdc()
//   7. wiring guard      app.js / engine.js / input.js / hud.js / holo-screen.js / work-loop.js / package.json carry
//                        the real wiring
//   npm run check:work-loop   (exit 1 on any failure)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import {
  createWorkLoop, pickBeat, readPanelGaze, BEATS, PANEL_TOUCH_BEAT, SCAN_SPAN, SCAN_LINES, READ_PANEL_MIN_MS, READ_PANEL_MAX_MS,
  PANEL_TOUCH_MIN_MS, PANEL_TOUCH_MAX_MS, LOOK_AT_ANH_MIN_MS, LOOK_AT_ANH_MAX_MS, LOOK_AT_ANH_MIN_DURATION_MS,
  LOOK_AT_ANH_MAX_DURATION_MS, LOOK_AT_ANH_DEFER_MAX_MS, CAMERA_NDC, WORK_SMILE, WORK_EVENT_VARIANTS, HOVER_DELAY_MS,
  HOVER_MAX_MS, REACTION_RESUME_MS, SPEECH_RESUME_MS, TASK_CAMERA_MS,
} from '../src/renderer/talk/work-loop.js';
import { REACTION_VARIANTS } from '../src/renderer/hud/hud-logic.js';
import { PANEL_TOUCH_WEIGHT } from '../src/renderer/talk/panel-touch.js';
import { ReflexEngine } from '../src/renderer/reflex/index.js';
import { Catalog } from '../src/renderer/reflex/catalog.js';
import { HoloScreen } from '../src/renderer/room/holo-screen.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
let pass = 0, fail = 0;
const ok = (cond, name, detail) => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`); } };

// Deterministic LCG, never Math.random (the repo's check convention).
function makeRandom(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 0x100000000);
}

// A camera-left, chest-height panel rect as HoloScreen.screenRect() projects it in the talk/float framing.
const RECT = Object.freeze({ x0: -0.72, x1: -0.48, y0: 0.18, y1: 0.33 });
const inside = (g, r) => Boolean(g) && g.x > r.x0 && g.x < r.x1 && g.y > r.y0 && g.y < r.y1;

// ---------- 1. the read-panel scan (pure) ----------
{
  ok(READ_PANEL_MIN_MS === 3000 && READ_PANEL_MAX_MS === 4000, 'beat: the read-panel beat lasts 3-4 s (inside the 3-5 s brief)', [READ_PANEL_MIN_MS, READ_PANEL_MAX_MS]);
  // alpha.10 (owner 31-10): the hologram is a flat screen beside her, never touched -- the shipped table is read-panel only.
  ok(BEATS.length === 1 && BEATS[0].id === 'read-panel' && BEATS[0].gaze === readPanelGaze && !BEATS.some((b) => b.touch),
    'beats: alpha.10 ships read-panel only (no beat touches the panel)', BEATS.map((b) => b.id));
  ok(PANEL_TOUCH_BEAT.id === 'panel-touch' && PANEL_TOUCH_BEAT.touch === true && PANEL_TOUCH_BEAT.weight === PANEL_TOUCH_WEIGHT
    && PANEL_TOUCH_BEAT.minMs === PANEL_TOUCH_MIN_MS && PANEL_TOUCH_BEAT.maxMs === PANEL_TOUCH_MAX_MS,
    'beats: the unshipped touch beat keeps its duration + weight (check-panel-touch drives it)', PANEL_TOUCH_BEAT);
  ok(BEATS[0].minMs === 3000 && BEATS[0].maxMs === 4000 && BEATS[0].weight === 1,
  'beats: the table carries its duration + weight', [BEATS[0]]);
  ok(Object.isFrozen(BEATS) && Object.isFrozen(BEATS[0]) && Object.isFrozen(PANEL_TOUCH_BEAT), 'beats: the table AND every beat are frozen (a stray write cannot change the schedule)', Object.isFrozen(BEATS[0]));
  ok(!BEATS.some((b) => b.id === 'look-at-anh'), 'beats: look-at-anh is NOT in the weighted table (its own 20-40 s clock, not a draw)', BEATS.map((b) => b.id));

  // ---------- 1b. step 10 constants: the brief's numbers, and the HUD variants reused ----------
  ok(LOOK_AT_ANH_MIN_MS === 20_000 && LOOK_AT_ANH_MAX_MS === 40_000, 'look: scheduled every 20-40 s (brief)', [LOOK_AT_ANH_MIN_MS, LOOK_AT_ANH_MAX_MS]);
  ok(LOOK_AT_ANH_MIN_DURATION_MS === 800 && LOOK_AT_ANH_MAX_DURATION_MS === 1500, 'look: held 0.8-1.5 s (brief)', [LOOK_AT_ANH_MIN_DURATION_MS, LOOK_AT_ANH_MAX_DURATION_MS]);
  ok(LOOK_AT_ANH_DEFER_MAX_MS === PANEL_TOUCH_MAX_MS + 50 && LOOK_AT_ANH_MIN_MS + (LOOK_AT_ANH_MAX_MS - LOOK_AT_ANH_MIN_MS - LOOK_AT_ANH_DEFER_MAX_MS) + LOOK_AT_ANH_DEFER_MAX_MS === LOOK_AT_ANH_MAX_MS,
    'look: the draw reserves the touch-beat deferral, so the ACTUAL interval still tops out at 40 s', { deferMax: LOOK_AT_ANH_DEFER_MAX_MS });
  ok(CAMERA_NDC.x === 0 && CAMERA_NDC.y === 0 && Object.isFrozen(CAMERA_NDC), 'look: the camera is stage-NDC centre (gazeLayer yaw/pitch 0)', CAMERA_NDC);
  ok(WORK_SMILE.name === 'happy' && WORK_SMILE.weight > 0 && WORK_SMILE.weight <= 0.5 && Object.isFrozen(WORK_SMILE),
    'look: the small smile is a shipped expression, held softly (happy <= 0.5)', WORK_SMILE);
  ok(WORK_EVENT_VARIANTS.done === REACTION_VARIANTS.done && WORK_EVENT_VARIANTS.blocked === REACTION_VARIANTS.blocked && WORK_EVENT_VARIANTS.failed === REACTION_VARIANTS.failed,
    'task events: done / blocked / failed reuse the HUD shipped variants (hud-logic REACTION_VARIANTS)', { work: WORK_EVENT_VARIANTS, hud: REACTION_VARIANTS });
  ok(SPEECH_RESUME_MS === 1000, 'speech resume: work resumes 1 s after the mouth closes (CONCEPTS §5, review S5)', SPEECH_RESUME_MS);
  ok(HOVER_DELAY_MS === 400 && HOVER_MAX_MS === 4000 && REACTION_RESUME_MS === 1500,
    'mouse rule: 400 ms hover, 4 s max hold, 1.5 s resume after a click/poke/pat (CONCEPTS §5)', { HOVER_DELAY_MS, HOVER_MAX_MS, REACTION_RESUME_MS });

  const cx = (RECT.x0 + RECT.x1) / 2, cy = (RECT.y0 + RECT.y1) / 2;
  const hw = (RECT.x1 - RECT.x0) / 2, hh = (RECT.y1 - RECT.y0) / 2;
  let allInside = true, allSmall = true, widest = 0;
  const ys = new Set(), seen = new Set();
  for (let i = 0; i <= 1000; i++) {
    const g = readPanelGaze(RECT, i / 1000);
    if (!inside(g, RECT)) allInside = false;
    if (Math.abs(g.x - cx) > hw * SCAN_SPAN + 1e-9 || Math.abs(g.y - cy) > hh * SCAN_SPAN + 1e-9) allSmall = false;
    widest = Math.max(widest, Math.abs(g.x - cx)), widest = Math.max(widest, Math.abs(g.y - cy));
    seen.add(`${g.x.toFixed(4)},${g.y.toFixed(4)}`);
    ys.add(g.y.toFixed(4));
  }
  ok(allInside, 'scan: every target across the beat is inside the panel NDC rect', RECT);
  ok(allSmall, 'scan: every target stays within SCAN_SPAN of the panel centre (small offsets, not a frozen centre)', { widest, hw, hh });
  ok(seen.size > 50, 'scan: the target actually moves across the beat (>= 50 distinct positions)', seen.size);
  ok(ys.size === SCAN_LINES, `scan: the beat reads ${SCAN_LINES} lines (top -> bottom saccades)`, [...ys]);
  ok(readPanelGaze(RECT, 0).x < cx && readPanelGaze(RECT, 1).x > cx, 'scan: starts on the left of the first line and ends on the right of the last', [readPanelGaze(RECT, 0), readPanelGaze(RECT, 1)]);
}

// ---------- 2. weighted pick, no immediate repeat ----------
{
  const table = [{ id: 'a', weight: 3 }, { id: 'b', weight: 1 }, { id: 'c', weight: 1 }];
  // (a) no previous beat: the draw follows the weights exactly (3 of 5 -> ~60 / 20 / 20).
  const free = { a: 0, b: 0, c: 0 };
  const randFree = makeRandom(7);
  for (let i = 0; i < 3000; i++) free[pickBeat(table, null, randFree).id]++;
  ok(Math.abs(free.a / 3000 - 0.6) < 0.04 && Math.abs(free.b / 3000 - 0.2) < 0.04 && Math.abs(free.c / 3000 - 0.2) < 0.04,
    'pick: an unconstrained draw follows the 3:1:1 weights', free);
  // (b) the real anti-repeat: no immediate repeat, and 'a' drops to its exclusion-adjusted share 3/7 (the previous
  // beat is out of the pool, so after 'a' the draw is b/c 50-50; stationary: a=3/7, b=c=2/7).
  const rand = makeRandom(7);
  const counts = { a: 0, b: 0, c: 0 };
  let last = null, repeats = 0;
  for (let i = 0; i < 3000; i++) {
    const b = pickBeat(table, last, rand);
    if (b.id === last) repeats++;
    counts[b.id]++; last = b.id;
  }
  ok(repeats === 0, 'pick: never the same beat twice in a row (Catalog.pick anti-repeat)', repeats);
  ok(Math.abs(counts.a / 3000 - 3 / 7) < 0.03 && Math.abs(counts.b / 3000 - 2 / 7) < 0.03 && Math.abs(counts.c / 3000 - 2 / 7) < 0.03,
    'pick: with anti-repeat the counts settle at 3/7 : 2/7 : 2/7 (exclusion still respects the weights)', counts);
  ok(pickBeat([], null) === null, 'pick: no beats -> null');
  ok(pickBeat([{ id: 'only', weight: 1 }], 'only', () => 0.5).id === 'only', 'pick: a single beat is allowed to repeat (nothing else to choose)');
  ok(pickBeat([{ id: 'zero', weight: 0 }], null) === null, 'pick: zero-weight beats are never eligible');
}

// ---------- 3. the loop on a fake clock ----------
// The READ beat's own contract, on a read-only table (since alpha.10 that is also the shipped table). The two-beat C1
// table (read + touch) is still driven below so the dormant touch mechanism stays proven (check-panel-touch.mjs too).
const READ_ONLY = Object.freeze([BEATS[0]]);
const C1_BEATS = Object.freeze([BEATS[0], PANEL_TOUCH_BEAT]);
const FAKE_FRAME = Object.freeze({ c: [0, 1, 0], n: [0, 0, 1], r: [1, 0, 0], u: [0, 1, 0], hw: 0.18, hh: 0.11, toward: 1, hand: 'right' });
{
  const clock = { t: 1_000_000 };
  const engine = { working: false, speechMouth: null, states: new Set(), gaze: undefined, isState(n) { return this.states.has(n); }, setWorkGaze(p) { this.gaze = p; } };
  const panel = { on: true };
  let talkBusy = false;
  const holo = { get on() { return panel.on; }, screenRect: () => ({ ...RECT }), screenNdc: () => ({ x: -0.6, y: 0.25 }), touchFrame: () => ({ ...FAKE_FRAME }) };
  const loop = createWorkLoop({ engine, holo, beats: READ_ONLY, busy: () => talkBusy, now: () => clock.t, random: makeRandom(11) });

  ok(loop.update() === null && !loop.state.owning && !engine.gaze, 'start: working off -> no beat, the gaze was never touched');
  ok(loop.update() === null && loop.state.beat === null, 'start: working off -> no beat is scheduled');

  engine.working = true;
  const g0 = loop.update();
  ok(inside(g0, RECT) && inside(engine.gaze, RECT), 'working on: the gaze target is inside the panel NDC rect', [g0, engine.gaze]);
  ok(loop.state.owning && loop.state.beat === 'read-panel', 'working on: the read-panel beat owns the gaze', loop.state);
  const start = loop.state.startedAt, duration = loop.state.durationMs;
  ok(duration >= READ_PANEL_MIN_MS && duration <= READ_PANEL_MAX_MS, 'working on: the beat is 3-4 s long', duration);

  let everyFrameInside = true, frames = 0;
  for (clock.t = start; clock.t < start + duration; clock.t += 16) { const g = loop.update(); if (!inside(g, RECT)) everyFrameInside = false; frames++; }
  ok(frames > 150 && everyFrameInside, 'working on: every frame of the beat keeps the target inside the rect', { frames, everyFrameInside });

  clock.t = start + duration; // the beat ends exactly here -> a fresh one starts at the first line
  const gRestart = loop.update();
  ok(loop.state.startedAt === clock.t && loop.state.durationMs >= READ_PANEL_MIN_MS && loop.state.durationMs <= READ_PANEL_MAX_MS,
    'working on: a new 3-4 s beat starts when the previous one ends', loop.state);
  ok(gRestart.x === readPanelGaze(RECT, 0).x && gRestart.y === readPanelGaze(RECT, 0).y, 'working on: the new beat restarts the scan at the first line', gRestart);

  // speech / typing / talk turn in flight: all three yield the gaze back to normal, then the beat resumes. Speech has
  // its own 1 s resume clock (review S5 / spec §5: "work resumes 1 s after the speech ends").
  engine.speechMouth = { aa: 0.4, ih: 0, ou: 0, ee: 0, oh: 0 };
  ok(loop.update() === null && engine.gaze === null && !loop.state.owning, 'yield: Zumi speaking (engine.speechMouth) hands the gaze back', loop.state);
  engine.speechMouth = null;
  const speechEnd = clock.t;
  ok(loop.update() === null && !loop.state.owning, 'speech: work does NOT resume on the frame the mouth closes', loop.state);
  clock.t = speechEnd + SPEECH_RESUME_MS - 16;
  ok(loop.update() === null && !loop.state.owning, 'speech: still held one frame before 1 s', clock.t - speechEnd);
  clock.t = speechEnd + SPEECH_RESUME_MS;
  ok(inside(loop.update(), RECT) && loop.state.owning, 'speech: work resumes exactly 1 s after the mouth closes (spec §5)', clock.t - speechEnd);

  engine.states.add('typing');
  ok(loop.update() === null && engine.gaze === null && !loop.state.owning, 'yield: the typing state (anh at the text box) hands the gaze back', loop.state);
  engine.states.delete('typing');
  ok(inside(loop.update(), RECT) && loop.state.owning, 'yield: typing stops -> the beat resumes');

  talkBusy = true;
  ok(loop.update() === null && engine.gaze === null && !loop.state.owning, 'yield: a talk turn in flight hands the gaze back', loop.state);
  talkBusy = false;
  ok(inside(loop.update(), RECT) && loop.state.owning, 'yield: the turn ends -> the beat resumes');

  // no panel (seated) / signal off: no beat, gaze restored.
  panel.on = false;
  ok(loop.update() === null && engine.gaze === null && !loop.state.owning, 'panel off: no holo panel (seated) -> no read beat', loop.state);
  panel.on = true;
  ok(inside(loop.update(), RECT), 'panel on: the read beat comes back');
  engine.working = false;
  ok(loop.update() === null && engine.gaze === null && !loop.state.owning && loop.state.beat === null, 'working off: the loop stops and hands the gaze back', loop.state);
  engine.working = true;
  ok(inside(loop.update(), RECT), 'working on again: the loop restarts on its own');
}

// ---------- 3b. the SHIPPED table: the two beats alternate, both keep the gaze inside the rect ----------
{
  const clock = { t: 2_000_000 };
  let reach = null, touchReach = null;
  const engine = {
    working: true, speechMouth: null, states: new Set(), gaze: undefined,
    isState() { return false; }, isBusy() { return 0; },
    setWorkGaze(p) { this.gaze = p; }, setWorkReach(r) { reach = r; },
  };
  const holo = { on: true, screenRect: () => ({ ...RECT }), screenNdc: () => ({ x: -0.6, y: 0.25 }), touchFrame: () => ({ ...FAKE_FRAME }) };
  const loop = createWorkLoop({ engine, holo, now: () => clock.t, random: makeRandom(11), beats: C1_BEATS });
  const ids = [];
  let everyGaze = true, touchFrames = 0;
  for (let i = 0; i < 700; i++) {
    clock.t += 16;
    const g = loop.update();
    if (!inside(g, RECT)) everyGaze = false;
    const id = loop.state.beat;
    if (ids[ids.length - 1] !== id) ids.push(id);
    if (id === 'panel-touch') {
      touchFrames++;
      if (reach && reach.weight > 0) touchReach = reach;
    } else if (reach !== null) everyGaze = false; // a read beat must never leave a contact armed
  }
  ok(ids.length >= 3 && ids.every((id, i) => i === 0 || id !== ids[i - 1]), 'C1 beats: read-panel and panel-touch alternate, never the same twice in a row', ids.slice(0, 6));
  ok(ids.includes('read-panel') && ids.includes('panel-touch'), 'C1 beats: both beats actually run over 11 s', ids.slice(0, 6));
  ok(everyGaze && touchFrames > 0, 'C1 beats: every beat keeps the gaze inside the panel rect, a read beat clears the contact', { everyGaze, touchFrames });
  ok(Boolean(touchReach) && touchReach.hand === 'right' && Number.isFinite(touchReach.point[0])
    && touchReach.weight > 0 && touchReach.weight <= 1, 'C1 beats: the touch beat hands the engine a world contact on the panel hand', touchReach);
}
// alpha.10: the SHIPPED table (default beats) over the same 11 s never arms a contact -- the hand stays off the panel.
{
  const clock = { t: 3_000_000 };
  let reachWrites = 0, armed = 0;
  const engine = {
    working: true, speechMouth: null, states: new Set(), gaze: undefined,
    isState() { return false; }, isBusy() { return 0; },
    setWorkGaze(p) { this.gaze = p; }, setWorkReach(r) { reachWrites++; if (r) armed++; },
  };
  const holo = { on: true, screenRect: () => ({ ...RECT }), screenNdc: () => ({ x: -0.6, y: 0.25 }), touchFrame: () => ({ ...FAKE_FRAME }) };
  const loop = createWorkLoop({ engine, holo, now: () => clock.t, random: makeRandom(11) });
  const ids = new Set();
  for (let i = 0; i < 700; i++) { clock.t += 16; loop.update(); ids.add(loop.state.beat); }
  ok(armed === 0 && !ids.has('panel-touch') && ids.has('read-panel'), 'shipped beats (alpha.10): only read-panel plays, no contact is ever armed on the panel', { beats: [...ids].filter(Boolean), armed, reachWrites });
}

// ---------- 3b. the idle ladder yields while working (it would break a beat) -- the REAL engine ----------
{
  const engine = new ReflexEngine({ catalog: new Catalog(() => 0.5), clips: { has: () => false }, random: () => 0.5 });
  engine.autoIdle = true;
  engine.lastInputAt = 0;
  engine.nextBoredAt = 0;
  engine.nextVarietyAt = 10_000_000; // isolate the bored/sleepy ladder from the 15-40 s variety layer
  const fired = [];
  engine.trigger = (name) => { fired.push(name); return null; };
  engine.setWorking(true);
  engine.idleTimers(500_000); // 8+ minutes of no mouse/keyboard, but she is working
  ok(fired.length === 0, 'idle: no bored/sleepy gesture interrupts a working beat', fired);
  ok(engine.lastInputAt === 500_000 && engine.nextBoredAt === 500_000 + 60_000, 'idle: the ladder clock stays fresh while working', { lastInputAt: engine.lastInputAt, nextBoredAt: engine.nextBoredAt });
  engine.setWorking(false);
  engine.idleTimers(500_000);
  ok(fired.length === 0, 'idle: work ending does not instantly bore/sleep her -- normal idle starts from the last working frame', fired);
  engine.idleTimers(500_000 + 180_001);
  ok(fired.includes('sleepy'), 'idle: the normal ladder resumes once work has ended', fired);
}

// ---------- 3g. working wakes her: work never starts while she is asleep (review S3) ----------
{
  // The real state machine + the real sleepy command. No VRM: trigger()'s model guard and the state map are all this
  // needs. idleTimers() returns early while working, so without a wake on the signal edge nothing would ever clear
  // 'sleepy' and she would reach for the panel asleep.
  const def = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'reflex', 'gestures', 'sleepy.json'), 'utf8'));
  const catalog = new Catalog(() => 0.5);
  catalog.triggers.set('sleepy', { name: 'sleepy', labelVi: def.labelVi, state: Boolean(def.state), variants: def.variants });
  const engine = new ReflexEngine({ catalog, clips: { has: () => false }, random: () => 0.5 });
  engine.vrm = {}; // trigger()'s model guard only; nothing here evaluates the player
  engine.autoIdle = false;
  engine.trigger('sleepy');
  ok(engine.isState('sleepy'), 'wake: the real engine is asleep before the working signal arrives', [...engine.states.keys()]);
  engine.setWorking(true);
  engine.idleTimers(performance.now() + 400_000); // the next ladder tick, while working
  ok(!engine.isState('sleepy'),
    'wake: a false->true working edge exits sleepy and the next tick keeps her awake (review S3)', [...engine.states.keys()]);
}

// ---------- 3c. the look-at-anh beat: every 20-40 s for 0.8-1.5 s, at the camera, with the small smile ----------
{
  const clock = { t: 3_000_000 };
  const engine = {
    working: true, speechMouth: null, states: new Set(), expr: null,
    isState() { return false; }, isBusy() { return 0; },
    setWorkGaze(p) { this.gaze = p; }, setWorkReach() {}, setWorkExpression(e) { this.expr = e; },
  };
  const holo = { on: true, screenRect: () => ({ ...RECT }), screenNdc: () => ({ x: -0.6, y: 0.25 }), touchFrame: () => ({ ...FAKE_FRAME }) };
  const loop = createWorkLoop({ engine, holo, now: () => clock.t, random: makeRandom(5) });
  const looks = [];
  let lastAt = null, prevLook = false, cameraOk = true, smileOk = true, smileCleared = true, backOk = true, panelFrames = 0, frames = 0;
  for (const end = clock.t + 600_000; clock.t < end; clock.t += 16) {
    const g = loop.update();
    frames++;
    const lk = loop.state.lookAt;
    if (lk && lk.at !== lastAt) { lastAt = lk.at; looks.push({ at: lk.at, durationMs: lk.durationMs }); }
    if (lk) {
      if (!(g && g.x === CAMERA_NDC.x && g.y === CAMERA_NDC.y)) cameraOk = false;
      if (!(engine.expr && engine.expr.name === WORK_SMILE.name && engine.expr.weight === WORK_SMILE.weight)) smileOk = false;
    } else {
      if (engine.expr !== null) smileCleared = false;
      if (prevLook && !inside(g, RECT)) backOk = false; // the frame right after a look is back on the panel
      if (inside(g, RECT)) panelFrames++;
    }
    prevLook = Boolean(lk);
  }
  const gaps = looks.slice(1).map((l, i) => l.at - looks[i].at);
  const firstGap = looks.length ? looks[0].at - 3_000_000 : null;
  ok(looks.length >= 15 && looks.length <= 30, 'look 10 min: 15-30 looks at a 20-40 s cadence', { looks: looks.length });
  ok(firstGap != null && firstGap >= LOOK_AT_ANH_MIN_MS && firstGap <= LOOK_AT_ANH_MAX_MS, 'look 10 min: the first look comes 20-40 s into the work', firstGap);
  ok(gaps.length > 10 && gaps.every((d) => d >= LOOK_AT_ANH_MIN_MS && d <= LOOK_AT_ANH_MAX_MS),
    'look 10 min: EVERY gap between two looks is inside 20-40 s', { n: gaps.length, min: Math.min(...gaps), max: Math.max(...gaps) });
  ok(looks.every((l) => l.durationMs >= LOOK_AT_ANH_MIN_DURATION_MS && l.durationMs <= LOOK_AT_ANH_MAX_DURATION_MS),
    'look 10 min: every look holds 0.8-1.5 s', { min: Math.min(...looks.map((l) => l.durationMs)), max: Math.max(...looks.map((l) => l.durationMs)) });
  ok(cameraOk && smileOk, 'look 10 min: every look frame is AT the camera with the small smile', { cameraOk, smileOk });
  ok(smileCleared && backOk, 'look 10 min: the smile is cleared and the gaze is back on the panel the moment a look ends', { smileCleared, backOk });
  ok(panelFrames / frames > 0.85, 'look 10 min: the panel still owns the vast majority of the working frames', +(panelFrames / frames).toFixed(3));
}

// ---------- 3d. the hover rule: 400 ms -> look up, hold <= 4 s, work resumes when the pointer leaves ----------
{
  const engine = { working: true, speechMouth: null, states: new Set(), expr: null, isState() { return false; }, isBusy() { return 0; }, setWorkGaze(p) { this.gaze = p; }, setWorkReach() {}, setWorkExpression(e) { this.expr = e; } };
  const holo = { on: true, screenRect: () => ({ ...RECT }), screenNdc: () => ({ x: -0.6, y: 0.25 }), touchFrame: () => ({ ...FAKE_FRAME }) };
  const clock = { t: 4_000_000 };
  let hovered = false;
  const loop = createWorkLoop({ engine, holo, hover: () => hovered, now: () => clock.t, random: makeRandom(13) });
  ok(inside(loop.update(), RECT) && loop.state.owning, 'hover: work is running before the pointer arrives', loop.state.beat);
  hovered = true;
  const hoverStart = clock.t;
  let lookUpAt = null;
  for (const end = hoverStart + 500; clock.t < end; clock.t += 16) {
    const g = loop.update();
    if (lookUpAt == null && g && g.x === CAMERA_NDC.x && g.y === CAMERA_NDC.y) lookUpAt = clock.t;
  }
  ok(lookUpAt != null && lookUpAt - hoverStart <= 500, 'hover: look-up within 500 ms of the pointer resting on her (400 ms rule)', lookUpAt - hoverStart);
  ok(lookUpAt - hoverStart >= HOVER_DELAY_MS, 'hover: a shorter visit does not break the work (the 400 ms debounce)', lookUpAt - hoverStart);
  ok(loop.state.hover && engine.gaze.x === CAMERA_NDC.x && engine.gaze.y === CAMERA_NDC.y, 'hover: the look-up holds at the camera while hovered', engine.gaze);
  ok(engine.expr === null, 'hover: the look-up carries no forced expression (the smile belongs to the scheduled beat)', engine.expr);
  for (; clock.t <= lookUpAt + HOVER_MAX_MS - 16; clock.t += 16) loop.update();
  ok(loop.state.hover, 'hover: still looking up one frame before the 4 s cap', { at: clock.t - lookUpAt });
  clock.t = lookUpAt + HOVER_MAX_MS;
  const afterCap = loop.update();
  ok(!loop.state.hover && loop.state.hoverLatched && inside(afterCap, RECT),
    'hover: the 4 s cap ends the look even if the pointer never leaves -- work resumes', { elapsed: HOVER_MAX_MS, gaze: afterCap });
  hovered = false;
  const resumed = loop.update();
  ok(inside(resumed, RECT) && loop.state.owning && !loop.state.hoverLatched, 'hover: work carries on once the pointer leaves', resumed);

  // A shorter hover: the pointer leaves mid-look-up -> work resumes well within 1.5 s.
  const clock2 = { t: 4_500_000 };
  let hovered2 = false;
  const engine2 = { ...engine, gaze: undefined, expr: null };
  const loop2 = createWorkLoop({ engine: engine2, holo, hover: () => hovered2, now: () => clock2.t, random: makeRandom(29) });
  loop2.update();
  hovered2 = true;
  const h2 = clock2.t;
  for (const end = h2 + 1200; clock2.t < end; clock2.t += 16) loop2.update();
  ok(loop2.state.hover, 'hover: the look-up is active after 1.2 s of hovering');
  hovered2 = false;
  const releaseAt = clock2.t;
  let resumeAt = null;
  for (let i = 0; i < 120 && resumeAt == null; i++) { clock2.t += 16; if (inside(loop2.update(), RECT)) resumeAt = clock2.t; }
  ok(resumeAt != null && resumeAt - releaseAt <= 1500, 'hover: work resumes <= 1.5 s after the hover ends', { ms: resumeAt == null ? null : resumeAt - releaseAt });
}

// ---------- 3e. a click/poke/pat reaction: the stage is released, work resumes 1.5 s after it ends ----------
{
  const clock = { t: 5_000_000 };
  let busyUntil = -Infinity;
  const engine = {
    working: true, speechMouth: null, states: new Set(),
    isState() { return false; }, isBusy(t) { return t < busyUntil ? 0.5 : 0; },
    setWorkGaze(p) { this.gaze = p; }, setWorkReach() {}, setWorkExpression() {},
  };
  const holo = { on: true, screenRect: () => ({ ...RECT }), screenNdc: () => ({ x: -0.6, y: 0.25 }), touchFrame: () => ({ ...FAKE_FRAME }) };
  const loop = createWorkLoop({ engine, holo, now: () => clock.t, random: makeRandom(23) });
  loop.update();
  const t0 = clock.t;
  busyUntil = t0 + 500; // a poke reaction plays for 500 ms
  ok(loop.update() === null && !loop.state.owning && engine.gaze === null, 'reaction: a live poke takes the stage -- the work gaze is handed back', loop.state);
  let early = false, resumedAt = null;
  for (clock.t = t0 + 16; clock.t <= t0 + 2100 && resumedAt == null; clock.t += 16) {
    const g = loop.update();
    if (inside(g, RECT)) { resumedAt = clock.t; if (clock.t < busyUntil + REACTION_RESUME_MS) early = true; }
  }
  const endAt = busyUntil;
  ok(!early, 'reaction: work does NOT resume during the 1.5 s after the reaction', { early });
  // The loop observes the end on its first frame after it (<= one 16 ms frame late), then waits the full 1.5 s.
  ok(resumedAt != null && resumedAt - endAt >= REACTION_RESUME_MS && resumedAt - endAt <= REACTION_RESUME_MS + 16,
    'reaction: work resumes 1.5 s after the poke ends (CONCEPTS §5)', { ms: resumedAt == null ? null : resumedAt - endAt });

  // A pat is a STATE, not a one-shot instance: it must release the stage too, and the clock runs from its end.
  const clock2 = { t: 5_500_000 };
  let pat = false;
  const engine2 = { ...engine, isState(n) { return n === 'pat' && pat; }, isBusy() { return 0; }, gaze: undefined };
  const loop2 = createWorkLoop({ engine: engine2, holo, now: () => clock2.t, random: makeRandom(31) });
  loop2.update();
  pat = true;
  ok(loop2.update() === null && !loop2.state.owning, 'reaction: a pat (a sustained state) releases the stage as well');
  const patEnd = clock2.t + 32;
  for (; clock2.t < patEnd; clock2.t += 16) loop2.update();
  pat = false;
  let back = null;
  for (let i = 0; i < 120 && back == null; i++) { clock2.t += 16; if (inside(loop2.update(), RECT)) back = clock2.t; }
  ok(back != null && back - patEnd >= REACTION_RESUME_MS && back - patEnd <= REACTION_RESUME_MS + 32,
    'reaction: a pat also resumes 1.5 s after it ends', { ms: back == null ? null : back - patEnd });
}

// ---------- 3f. task events while working: done -> nod-smile at the panel; blocked -> concerned, then the camera --
{
  const calls = [];
  const react = (variant, look) => { calls.push({ variant, look: { ...look } }); return variant === 'concerned' ? 1720 : 1470; };
  const engine = { working: true, speechMouth: null, states: new Set(), expr: 'x', isState() { return false; }, isBusy() { return 0; }, setWorkGaze(p) { this.gaze = p; }, setWorkReach() {}, setWorkExpression(e) { this.expr = e; } };
  const PANEL_NDC = { x: -0.6, y: 0.25 };
  const holo = { on: true, screenRect: () => ({ ...RECT }), screenNdc: () => ({ ...PANEL_NDC }), touchFrame: () => ({ ...FAKE_FRAME }) };
  const clock = { t: 6_000_000 };
  const loop = createWorkLoop({ engine, holo, react, now: () => clock.t, random: makeRandom(17) });
  loop.update();
  const t0 = clock.t;
  ok(loop.taskEvent({ state: 'done' }) === true, 'task done: the working loop takes the event');
  ok(calls.length === 1 && calls[0].variant === 'nod-smile' && calls[0].look.x === PANEL_NDC.x && calls[0].look.y === PANEL_NDC.y,
    'task done: plays the HUD nod-smile variant aimed at the PANEL centre (not the card)', calls[0]);
  ok(engine.expr === null, 'task done: the work smile/contact are dropped before the reaction gesture plays', engine.expr);
  ok(loop.state.task && loop.state.task.phase === 'panel' && inside(loop.update(), RECT), 'task done: the gaze holds on the panel while the nod-smile plays', loop.state.task);
  clock.t = t0 + 1470;
  const afterDone = loop.update();
  ok(!loop.state.task && inside(afterDone, RECT) && loop.state.beat === 'read-panel', 'task done: a fresh read beat resumes after the reaction', { gaze: afterDone, state: loop.state });

  const t1 = clock.t;
  ok(loop.taskEvent({ state: 'blocked' }) === true, 'task blocked: the working loop takes the event');
  ok(calls.length === 2 && calls[1].variant === 'concerned' && calls[1].look.x === PANEL_NDC.x && calls[1].look.y === PANEL_NDC.y,
    'task blocked: plays the HUD concerned variant aimed at the panel', calls[1]);
  clock.t = t1 + 1720 - 16;
  ok(inside(loop.update(), RECT), 'task blocked: concerned AT the panel first', loop.state.task);
  clock.t = t1 + 1720;
  const gc = loop.update();
  ok(gc && gc.x === CAMERA_NDC.x && gc.y === CAMERA_NDC.y && loop.state.task && loop.state.task.phase === 'camera', 'task blocked: THEN a look at the camera', { gaze: gc, task: loop.state.task });
  clock.t = t1 + 1720 + TASK_CAMERA_MS - 16;
  ok(loop.update() && loop.state.task && loop.state.task.phase === 'camera', 'task blocked: the camera look holds');
  clock.t = t1 + 1720 + TASK_CAMERA_MS;
  const afterBlocked = loop.update();
  ok(!loop.state.task && inside(afterBlocked, RECT), 'task blocked: work resumes after the camera look', afterBlocked);

  ok(loop.taskEvent({ state: 'active' }) === false, 'task event: a running/active step is not a work event (the HUD keeps its glance)');
  engine.working = false;
  const idle = createWorkLoop({ engine, holo, react, now: () => clock.t, random: makeRandom(19) });
  ok(idle.taskEvent({ state: 'done' }) === false, 'task event: ignored when she is not working -> the HUD card reaction plays', idle.state);
  ok(calls.length === 2, 'task event: no gesture was triggered by a rejected event', calls.length);
}

// ---------- 4. cursor reflex suppression -- the REAL engine's dispatch gate ----------
{
  const gestures = path.join(ROOT, 'src', 'renderer', 'reflex', 'gestures');
  const def = JSON.parse(fs.readFileSync(path.join(gestures, 'cursor.json'), 'utf8'));
  const catalog = new Catalog(() => 0.5);
  catalog.triggers.set('cursor', { name: 'cursor', labelVi: def.labelVi, state: Boolean(def.state), variants: def.variants });
  const engine = new ReflexEngine({ catalog, clips: { has: () => false }, random: () => 0.5 });
  engine.vrm = {}; // trigger()'s model guard only; the real player validates the real command, no bind needed here
  const reactions = [];
  engine.on('reaction', (r) => reactions.push(r.trigger));

  const before = engine.trigger('cursor');
  ok(Boolean(before) && before.trigger === 'cursor' && reactions.length === 1 && engine.player.instances.length === 1,
    'cursor: fires normally when not working', { reactions, instances: engine.player.instances.length });

  engine.setWorking(true);
  const during = engine.trigger('cursor');
  ok(during === null, 'cursor: trigger() returns null while working (CONCEPTS §5 mouse rule)', during);
  ok(reactions.length === 1 && engine.player.instances.length === 1, 'cursor: the suppressed call reaches neither the reaction listeners nor the player');

  engine.setWorking(false);
  const after = engine.trigger('cursor');
  ok(Boolean(after) && reactions.length === 2 && engine.player.instances.length === 2, 'cursor: fires again once work ends (working off -> normal)', { reactions, instances: engine.player.instances.length });
}

// ---------- 5. the gaze slot: setWorkGaze writes primaryGaze and restores the view's own target ----------
{
  const engine = new ReflexEngine({ catalog: new Catalog(() => 0.5), clips: { has: () => false }, random: () => 0.5 });
  engine.setLookTargets([{ name: 'monitor', x: 0.6, y: 0.1, primary: true }, { name: 'side', x: -0.5, y: 0 }]);
  ok(engine.primaryGaze && engine.primaryGaze.name === 'monitor' && engine.viewPrimaryGaze === engine.primaryGaze,
    'gaze: setLookTargets still sets the view primary target (unchanged)', engine.primaryGaze);
  engine.setWorkGaze({ x: -0.6, y: 0.25 });
  ok(engine.primaryGaze.x === -0.6 && engine.primaryGaze.y === 0.25, 'gaze: the beat target becomes primaryGaze -- the slot gazeLayer reads', engine.primaryGaze);
  engine.setWorkGaze(null);
  ok(engine.primaryGaze && engine.primaryGaze.name === 'monitor', 'gaze: a beat ending hands the view its own primary target back', engine.primaryGaze);
  engine.setWorkGaze({ x: NaN, y: 0.2 });
  ok(engine.primaryGaze && engine.primaryGaze.name === 'monitor', 'gaze: an invalid point never replaces the view target', engine.primaryGaze);
}

// ---------- 6. HoloScreen.screenRect(): the real mesh projection (no document needed) ----------
{
  const camera = new THREE.PerspectiveCamera(28, 1280 / 742, 0.05, 50);
  camera.position.set(0, 1.4, 3);
  camera.lookAt(0, 1.3, 0);
  camera.updateMatrixWorld();
  const scene = new THREE.Scene();
  const proto = Object.create(HoloScreen.prototype); // prototype-only: the projection math needs no canvas/DOM
  proto.camera = camera; proto._v = new THREE.Vector3();
  proto.group = new THREE.Group();
  scene.add(proto.group);
  proto.mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.42 * 0.85, 0.26 * 0.85), new THREE.MeshBasicMaterial());
  proto.group.add(proto.mesh);
  proto.group.position.set(-0.42 * 0.85, 1.4, 0); // camera-left, chest height (float panel)
  proto.group.updateMatrixWorld(true);

  const r = HoloScreen.prototype.screenRect.call(proto);
  const c = proto.group.getWorldPosition(new THREE.Vector3()).project(camera);
  ok(Boolean(r) && r.x1 > r.x0 && r.y1 > r.y0, 'holo.screenRect: returns a non-empty NDC rectangle', r);
  // The camera looks slightly down at the panel, so the projected quad is not symmetric (its bounding-box centre is
  // ~2e-4 off the projected centre); a 1e-3 tolerance still proves they are the same point on screen.
  ok(Math.abs((r.x0 + r.x1) / 2 - c.x) < 1e-3 && Math.abs((r.y0 + r.y1) / 2 - c.y) < 1e-3,
    'holo.screenRect: centred on screenNdc() (one source of truth)', { rectCentre: [(r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2], ndc: [c.x, c.y] });
  ok(r.x1 < 0, 'holo.screenRect: the camera-left panel projects left of centre', r);
  ok(r.x1 - r.x0 > 0.2 && r.x1 - r.x0 < 0.5 && r.y1 - r.y0 > 0.2 && r.y1 - r.y0 < 0.5,
    'holo.screenRect: the panel is a readable box, not a sliver (0.2-0.5 NDC per side)', { w: r.x1 - r.x0, h: r.y1 - r.y0 });

  // project() happily mirrors points BEHIND the camera into a plausible box -- screenRect must reject that, or the
  // work loop would chase a panel that is not on screen.
  proto.group.position.set(0, 1.4, 6); // the camera sits at z=3 looking toward -z: this panel is behind it
  proto.group.updateMatrixWorld(true);
  ok(HoloScreen.prototype.screenRect.call(proto) === null, 'holo.screenRect: a panel behind the camera returns null (no mirrored rect)');
  proto.group.position.set(20, 1.4, 0); // in front, but far outside the frame
  proto.group.updateMatrixWorld(true);
  ok(HoloScreen.prototype.screenRect.call(proto) === null, 'holo.screenRect: a panel fully off-frame returns null');
  proto.group.position.set(-0.42 * 0.85, 1.4, 0);
  proto.group.updateMatrixWorld(true);
}

// ---------- 7. wiring source guard (the modules the app actually ships) ----------
{
  const app = read('src/renderer/app.js');
  ok(app.includes("import { createWorkLoop } from './talk/work-loop.js';"), 'app.js: imports the work loop');
  ok(/const workLoop = createWorkLoop\(\{\n\s+engine, holo,/.test(app), 'app.js: builds it from the real engine and holo panel (no camera director: spec §5 keeps the talk view)');
  ok(/busy: \(\) => Boolean\(talk\.director && talk\.director\.turn && !talk\.director\.turn\.done\)/.test(app), 'app.js: a talk turn in flight is the busy gate');
  ok(/workLoop\.update\(now\);/.test(app), 'app.js: the render loop calls update(now) every frame');
  ok(app.indexOf('workLoop.update(now);') > app.indexOf('holo.update(now / 1000);') && app.indexOf('workLoop.update(now);') < app.indexOf('engine.update(dt);'),
    'app.js: the beat updates after the panel moved (screenRect is current) and before the gaze is applied');
  ok(!app.includes('setPanelFrame') && !app.includes('touchFrame()'),
    'app.js: no per-frame panel-plane copy (the work loop reads the live plane itself; review N2)');

  const engine = read('src/renderer/reflex/engine.js');
  ok(/if \(name === 'cursor' && this\.working\) return null;/.test(engine), 'engine.js: the ONE dispatch gate suppresses the cursor reflex while working');
  ok(/setWorkGaze\(point\) \{/.test(engine) && /this\.primaryGaze = valid \? \{ x: point\.x, y: point\.y \} : this\.viewPrimaryGaze;/.test(engine),
    'engine.js: setWorkGaze writes primaryGaze / restores the view target');
  ok(/this\.viewPrimaryGaze = list\.find\(\(p\) => p\.primary\) \|\| null;/.test(engine), 'engine.js: setLookTargets remembers the view primary target');
  ok(/const base = this\.primaryGaze \|\| p;/.test(engine), 'engine.js: gazeLayer actually READS primaryGaze as its baseline (the slot the beat writes)');
  ok(/!this\.speechMouth && !this\.working;/.test(engine), 'engine.js: idle glances yield while working (they would steal the panel gaze)');
  ok(/if \(this\.working\) \{ this\.lastInputAt = now; this\.nextBoredAt = now \+ IDLE_BORED_MS; return; \}/.test(engine),
    'engine.js: the bored/sleepy ladder yields (and stays fresh) while working');
  ok(/if \(!rising\) return;\n\s+this\.noteActivity\(\);\n\s+if \(this\.states\.has\('sleepy'\)\) this\.exitState\('sleepy'\);/.test(engine),
    'engine.js: a false->true working edge wakes her from sleepy (review S3)');
  ok(!/HOLO_CONTACT_REACH/.test(engine) && /export function clampForHoloPanel\(command, unsafe = HOLO_UNSAFE_REACH, raised = HOLO_RAISED_REACH\) \{/.test(engine),
    'engine.js: the panel clamp has no dead panel-touch exception (the contact is injected after it; review N1/N2)');
  ok(/setWorkReach\(reach\) \{/.test(engine) && !/setPanelFrame/.test(engine) && !/panelFrame/.test(engine),
    'engine.js: carries the work contact and no copy of the live panel plane (review N2)');
  ok(/if \(this\.workReach\) \{\n\s+acc\.reach\.push\(\{ hand: this\.workReach\.hand, target: 'panel-touch'/.test(engine)
      && !/acc\.reach\.some\(\(r\) => r\.hand === this\.workReach\.hand\)/.test(engine),
    'engine.js: the work contact ALWAYS joins the frame -- a gesture on the same hand shares it (review R1: the rig hands over, never a drop)');
  const rigSrc = read('src/renderer/reflex/rig.js');
  ok(/this\.handover = new Map\(\)/.test(rigSrc) && /handover = Math\.min\(1, Math\.max\(0, 1 - hit\.weight \/ w0\)\)/.test(rigSrc)
      && /CONTACT_MAX_WRIST_SPEED/.test(rigSrc),
    'rig.js: a real gesture takes the contact hand over through the contact\'s own leave, paced by a wrist rail (review R1)');

  const holo = read('src/renderer/room/holo-screen.js');
  ok(/screenRect\(\) \{/.test(holo) && /\.project\(this\.camera\)/.test(holo), 'holo-screen.js: screenRect() projects the panel corners through the live camera');
  ok(/touchFrame\(\) \{/.test(holo) && /transformDirection\(m\)/.test(holo) && /panelHandSide\(/.test(holo),
    'holo-screen.js: touchFrame() reports the live panel plane + the hand on its side');

  const loop = read('src/renderer/talk/work-loop.js');
  ok(loop.includes('engine.speechMouth') && loop.includes("isState('typing')") && loop.includes('busy()'), 'work-loop.js: yields to speech, typing and a talk turn');
  ok(loop.includes('engine.working') && !loop.includes('director.working') && loop.includes('setWorkGaze(null)'),
    'work-loop.js: starts/stops on engine.working (never the camera director) and hands the gaze back');
  ok(/from '\.\/panel-touch\.js'/.test(loop) && /holo\.touchFrame\(\)/.test(loop) && /engine\.setWorkReach\(/.test(loop),
    'work-loop.js: the touch beat plans on panel-touch.js, reads the live plane and writes the contact');
  ok(/function beginLeave/.test(loop) && /TOUCH_OUT_MS \* from/.test(loop) && /smoothstep/.test(loop) && /leaving/.test(loop),
    'work-loop.js: an interrupted contact eases out through TOUCH_OUT_MS (scaled by its weight) and the shared smoothstep (review B2)');
  // T-31 C1 step 10: the mouse rule + the task events, wired in the shipped module (the behaviour above drives it).
  ok(/hover && hover\(\)/.test(loop) && /HOVER_DELAY_MS/.test(loop) && /HOVER_MAX_MS/.test(loop) && /hoverLatched/.test(loop),
    'work-loop.js: the hover rule reads the injected probe and keeps the 4 s latch');
  ok(/isState\('pat'\)/.test(loop) && /isBusy\(t\) > 0\.05/.test(loop) && /REACTION_RESUME_MS/.test(loop),
    'work-loop.js: a poke/pat reaction releases the stage and the 1.5 s resume clock runs from its end');
  ok(/lookGap\(\)/.test(loop) && /LOOK_AT_ANH_MIN_DURATION_MS \+ random\(\)/.test(loop) && /write\(CAMERA_NDC, WORK_SMILE\)/.test(loop),
    'work-loop.js: the look-at-anh beat is scheduled by its own clock and writes the camera + the shipped smile');
  ok(/typeof react === 'function' \? Number\(react\(variant, panel\)\) : 0/.test(loop) && /cameraMs: state === 'done' \? 0 : TASK_CAMERA_MS/.test(loop),
    'work-loop.js: task events play the shipped variant at the panel and only blocked/failed add the camera look');

  const inp = read('src/renderer/reflex/input.js');
  ok(/function pointerOver\(stageRect = rect\(\)\)/.test(inp) && /pointerOver,/.test(inp) && /engine\.hitRegions\(stageRect\)/.test(inp),
    'input.js: pointerOver reads the real pointer + hit regions and is exported (the loop\'s hover probe)');
  ok(/hoverOnHer = \(\) => input\.pointerOver\(\);/.test(app), 'app.js: hover is the real pointerOver probe');
  ok(/hover: \(\) => hoverOnHer\(\)/.test(app) && /react: workReact/.test(app), 'app.js: the loop gets the hover probe and the real board player');
  ok(/const workReact = \(variant, look\) => \{/.test(app) && /engine\.player\.duration\(inst\)/.test(app) && /catalog\.forceNext\('board', variant\)/.test(app),
    'app.js: workReact forces the shipped variant, aims it at the panel and reports the real command length');
  ok(/onWorkEvent: \(\{ state \}\) => workLoop\.taskEvent\(\{ state \}\)/.test(app), 'app.js: HUD step events reach the work loop');

  ok(/setWorkExpression\(expr\) \{/.test(engine) && /DRIVEN_EXPR\.includes\(expr\.name\)/.test(engine)
    && /if \(this\.workExpression\) acc\.expression\(this\.workExpression\.name, this\.workExpression\.weight\);/.test(engine),
  'engine.js: setWorkExpression holds one shipped expression, added after the player each frame');

  const hud = read('src/renderer/hud/hud.js');
  ok(/onWorkFeed, onWorkEvent \}/.test(hud) && /onWorkEvent\(\{ state: reaction\.state \}\)/.test(hud) && /if \(!workHandled\)/.test(hud),
    'hud.js: a done/blocked/failed event goes to the work loop first, and the card reaction is the fallback');

  const pkg = JSON.parse(read('package.json'));
  ok(pkg.scripts['check:work-loop'] === 'node scripts/check-work-loop.mjs', 'package.json: check:work-loop runs this script', pkg.scripts['check:work-loop']);
  ok(pkg.scripts['check:panel-touch'] === 'node scripts/check-panel-touch.mjs', 'package.json: check:panel-touch runs the new step-9 gate', pkg.scripts['check:panel-touch']);
}

console.log(`\ncheck:work-loop ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
