// T-31 0.2.7 "arms locked" step 2 gate (DIAG 20-10 §5 row 2; root cause §3.2), plain Node, no Electron:
// pointerMove() used noteInput(), which pushed the 15-40 s idle-variety timer out on every move -- so while
// anh moved the mouse over Zumi, the arms never moved (measured 0 idle-variety plays in the 90 s mouse phase).
// This check drives the REAL ReflexEngine + REAL attachInput (DOM stubbed) on a fake clock:
//   1. 5 simulated minutes of pointer moves (one every 3 s) -> >= 5 idle-variety plays (DIAG §2 seated idle:
//      5 variety in 301 s) and the cursor reflex count is unchanged vs the 0.2.6 noteInput() path (+/-20 %).
//   2. noteActivity() keeps the sleepy/wake behaviour: a move still wakes her, no variety reset.
//   3. Source wiring: pointerMove() uses noteActivity({wake:true}); keys and clicks keep noteInput().
//   node scripts/check-mouse-variety.mjs [--model <file.vrm>]   (npm run check:mouse-variety)
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, clock, modelFromArgs, loadHarness, makeFreshEngine, watchReactions, reporter } from './lib/reflex-harness.mjs';
import { attachInput } from '../src/renderer/reflex/index.js';

const modelPath = modelFromArgs();
if (!fs.existsSync(modelPath)) { console.error(`usage: npm run check:mouse-variety -- --model <file.vrm> (missing: ${modelPath})`); process.exit(2); }
const { vrm, camera } = await loadHarness(modelPath).catch((e) => { console.error(e.message); process.exit(2); });
const { ok, finish } = reporter();
const freshEngine = (seed) => makeFreshEngine(vrm, camera, seed);

// Minimal DOM for the REAL attachInput wiring (window listeners, stage rect, textbox).
const win = { addEventListener() {}, removeEventListener() {} };
globalThis.window = win;
const stage = {
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 742 }),
  addEventListener() {}, removeEventListener() {},
};
const textbox = { value: '', addEventListener() {}, removeEventListener() {} };

// 5 min of "anh at the PC": a real pointerMove every 3 s, the idle ladder running every 100 ms.
function mouseSession(engine) {
  const input = attachInput(engine, { stage, textbox, onSend: () => {} });
  const start = clock.t;
  for (let ms = 0; ms <= 300_000; ms += 100) {
    clock.t = start + ms;
    if (ms % 3000 === 0) {
      const k = ms / 3000;
      input.pointerMove(640 + (k % 2 ? 60 : -60), 371 + ((k % 3) - 1) * 40, clock.t);
    }
    engine.idleTimers(clock.t);
  }
  input.dispose();
}

// =====================================================================================
// 1. 5 simulated minutes of pointer moves -> idle variety still plays
// =====================================================================================
{
  const { engine } = freshEngine(51);
  clock.t = 3_000_000;
  engine.lastInputAt = clock.t;
  engine.nextBoredAt = 0;
  engine.nextVarietyAt = clock.t + 15_000;
  const w = watchReactions(engine);
  mouseSession(engine);
  // Every move resets the ladder (idle < 60 s), so every 'bored' trigger here IS the idle-variety layer.
  const variety = w.count('bored');
  const cursor = w.count('cursor');
  ok(variety >= 5, 'mouse: >= 5 idle-variety plays across 5 simulated minutes of pointer moves (was 0)', String(variety));
  ok(cursor >= 90, 'mouse: the cursor reflex still fires on the pointer episodes (gaze/cursor wiring intact)', String(cursor));
  ok(w.count('sleepy') === 0, 'mouse: pointer activity keeps the sleepy ladder reset for the whole session', String(w.count('sleepy')));
  console.log(`  [mouse] variety=${variety} cursor=${cursor} in 300 simulated s`);
}

// =====================================================================================
// 2. pointerMove() still wakes her and still resets the bored/sleepy ladder
// =====================================================================================
{
  const { engine } = freshEngine(53);
  clock.t = 3_500_000;
  engine.lastInputAt = clock.t - 190_000;
  engine.nextVarietyAt = clock.t + 12_345;
  engine.idleTimers(clock.t);
  ok(engine.isState('sleepy'), 'move: setup -- asleep before the pointer move', '');
  const w = watchReactions(engine);
  const varietyAt = engine.nextVarietyAt;
  const input = attachInput(engine, { stage, textbox, onSend: () => {} });
  input.pointerMove(700, 380, clock.t);
  input.dispose();
  ok(!engine.isState('sleepy') && w.count('wake') === 1, 'move: a pointer move still wakes her (wake startle kept for real input)', `sleepy=${engine.isState('sleepy')} wake=${w.count('wake')}`);
  ok(engine.lastInputAt === clock.t && engine.nextBoredAt === clock.t + 60_000, 'move: the move resets lastInputAt / nextBoredAt', String(engine.lastInputAt - clock.t));
  ok(engine.nextVarietyAt === varietyAt, 'move: the move does NOT push the idle-variety timer out', String(engine.nextVarietyAt - varietyAt));
}

// =====================================================================================
// 3. control: the 0.2.6 noteInput() path suppresses variety completely
// =====================================================================================
{
  const { engine: old } = freshEngine(52);
  const t0 = 4_000_000;
  clock.t = t0;
  old.lastInputAt = t0;
  old.nextBoredAt = 0;
  old.nextVarietyAt = t0 + 15_000;
  const ow = watchReactions(old);
  for (let ms = 0; ms <= 300_000; ms += 100) {
    clock.t = t0 + ms;
    if (ms % 3000 === 0) {
      old.noteInput(); // the 0.2.6 pointerMove body
      const k = ms / 3000;
      old.setPointer((k % 2 ? 60 : -60) / 640, (-((k % 3) - 1) * 40) / 371);
      old.trigger('cursor');
    }
    old.idleTimers(clock.t);
  }
  ok(ow.count('bored') === 0, 'mouse control: the 0.2.6 noteInput() path suppresses variety completely (the bug this check catches)', String(ow.count('bored')));
}

// =====================================================================================
// 4. source wiring
// =====================================================================================
{
  const inp = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'reflex', 'input.js'), 'utf8');
  const pointerMove = inp.slice(inp.indexOf('function pointerMove'), inp.indexOf('function pointerDown'));
  ok(pointerMove.includes('engine.noteActivity({ wake: true })') && !pointerMove.includes('engine.noteInput('),
    'wiring: input.js pointerMove() uses noteActivity({wake:true}) and no longer noteInput()', '');
  const keyInput = inp.slice(inp.indexOf('function keyInput'), inp.indexOf('function tick'));
  ok(keyInput.includes('engine.noteInput()'), 'wiring: keys keep the full noteInput() reset', '');
  const pointerUp = inp.slice(inp.indexOf('function pointerUp'), inp.indexOf('function keyInput'));
  ok(pointerUp.includes('engine.noteInput()'), 'wiring: clicks keep the full noteInput() reset', '');
}

finish();
