// Static check of the built-in gesture data: schema-valid, no clamping needed, >= 3 variants per trigger,
// and every variant produces visible output within the first 150 ms (frames at 60 fps).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateGesture, LOOK_TARGETS } from '../src/renderer/reflex/schema.js';
import { GesturePlayer, ChannelAcc, isFaceOnly, pchipTangents } from '../src/renderer/reflex/player.js';
import { Catalog } from '../src/renderer/reflex/catalog.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer', 'reflex', 'gestures');
const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
let failures = 0, count = 0;
for (const trig of index.triggers) {
  const def = JSON.parse(fs.readFileSync(path.join(dir, `${trig}.json`), 'utf8'));
  if (def.variants.length < 3) { console.log(`FAIL ${trig}: only ${def.variants.length} variants`); failures++; }
  for (const v of def.variants) {
    count++;
    const res = validateGesture(v.command);
    if (!res.ok || res.warnings.length) { console.log(`FAIL ${trig}/${v.id}:`, res.errors, res.warnings); failures++; continue; }
    let clock = 0;
    const player = new GesturePlayer({ now: () => clock, random: () => 0.5 });
    player.play(v.command, { noJitter: true });
    let onset = null;
    for (let f = 1; f <= 9 && onset == null; f++) {
      clock = f * 16.7;
      const acc = new ChannelAcc();
      player.evaluate(acc, clock);
      if (player.instances[0] && player.instances[0].lastMag > 0.01) onset = clock;
    }
    const ok = onset != null && onset <= 150;
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${trig}/${v.id} onset=${onset == null ? 'none' : onset.toFixed(0) + 'ms'}`);
  }
}
// Dynamic one-shot look target (T-31 0.2.3 A1): a 'dynamic' lookAt uses the point passed to play() and is skipped
// (no gaze written) when none was passed -- the board reaction hands it the exact card's stage-NDC.
{
  const cmd = { id: 'x', lookAt: [{ target: 'dynamic', weight: 1, inMs: 0, holdMs: 400, outMs: 100 }] };
  const withLook = new GesturePlayer({ now: () => 0, random: () => 0.5 });
  withLook.play(cmd, { noJitter: true, look: { x: 0.7, y: 0.2 } });
  const a1 = new ChannelAcc(); withLook.evaluate(a1, 100);
  const noLook = new GesturePlayer({ now: () => 0, random: () => 0.5 });
  noLook.play(cmd, { noJitter: true });
  const a2 = new ChannelAcc(); noLook.evaluate(a2, 100);
  const okd = Math.abs(a1.gx - 0.7) < 1e-6 && Math.abs(a1.gy - 0.2) < 1e-6 && a1.gw > 0 && a2.gw === 0;
  console.log(`${okd ? 'ok  ' : 'FAIL'} dynamic look target: used when passed (gx=${a1.gx}), skipped when not (gw=${a2.gw})`);
  if (!okd) failures++;
}

// Generic board event (T-31 0.2.3 A1 fix): app.js onBoardEvent forces the 'double-take' variant and hands it the
// sidebar NDC, so a board message the camera cannot pin to a card still glances the sidebar. Before the fix a bare
// trigger('board') picked a random variant with no look: 4 of the 5 variants gaze only 'dynamic' (skipped without a
// look), so the glance was lost and nod-smile (done) / concerned (blocked) could fire by chance. app.js is a renderer
// file (DOM, not importable under plain Node), so check-hud.mjs guards its wiring; this guards the gesture itself.
{
  const boardDef = JSON.parse(fs.readFileSync(path.join(dir, 'board.json'), 'utf8'));
  const byId = Object.fromEntries(boardDef.variants.map((v) => [v.id, v]));
  const [sx, sy] = LOOK_TARGETS.sidebar;
  const cat = new Catalog(() => 0); // deterministic: without forceNext this would take the first variant
  cat.triggers.set('board', { name: 'board', labelVi: boardDef.labelVi, state: false, variants: boardDef.variants });
  cat.forceNext('board', 'double-take');
  const picked = cat.pick('board');
  const p = new GesturePlayer({ now: () => 0, random: () => 0.5 });
  p.play(picked.command, { noJitter: true, look: { x: sx, y: sy } });
  const acc = new ChannelAcc();
  p.evaluate(acc, 100);
  const gx = acc.gw > 0 ? acc.gx / acc.gw : NaN, gy = acc.gw > 0 ? acc.gy / acc.gw : NaN;
  const okb = picked.id === 'double-take' && acc.gw > 0 && Math.abs(gx - sx) < 1e-6 && Math.abs(gy - sy) < 1e-6;
  console.log(`${okb ? 'ok  ' : 'FAIL'} board generic event: forced double-take gazes the sidebar (variant=${picked.id}, gx=${gx}, gy=${gy})`);
  if (!okb) failures++;
  // the regression the old bare trigger left: a dynamic-only variant writes no gaze when no look is passed.
  const bare = new GesturePlayer({ now: () => 0, random: () => 0.5 });
  bare.play(byId['quick-glance'].command, { noJitter: true });
  const noLook = new ChannelAcc();
  bare.evaluate(noLook, 100);
  const okc = noLook.gw === 0;
  console.log(`${okc ? 'ok  ' : 'FAIL'} board variant, no look: no gaze written (gw=${noLook.gw})`);
  if (!okc) failures++;
}

// Held face-only emotion (T-31 0.2.3 B2 item 1): a face-only sustained layer is NOT ducked by a live one-shot body
// gesture, so the face holds at full weight through the reply instead of sagging to 25% under every gesture.
{
  let clock = 0;
  const p = new GesturePlayer({ now: () => clock, random: () => 0.5 });
  p.play({ id: 'speech-emotion', sustain: true, priority: 4, interrupt: false, expressions: [{ name: 'happy', weight: 0.8 }] }, { noJitter: true });
  clock = 200; // the emotion is fully in
  p.play({ id: 'nod', priority: 6, bones: [{ bone: 'head', rot: [10, 0, 0], inMs: 50, holdMs: 2000, outMs: 200 }] }, { noJitter: true });
  clock = 600; // the body gesture is at full presence here (would duck a non-face sustained layer)
  const acc = new ChannelAcc();
  p.evaluate(acc, clock);
  const heldOk = Math.abs((acc.expr.happy || 0) - 0.8) < 1e-6;
  console.log(`${heldOk ? 'ok  ' : 'FAIL'} held face emotion: not ducked by a body gesture (happy=${(acc.expr.happy || 0).toFixed(3)}, want 0.800)`);
  if (!heldOk) failures++;
  const shapeOk = isFaceOnly({ expressions: [{ name: 'happy' }] }) && !isFaceOnly({ expressions: [{ name: 'happy' }], bones: [{ bone: 'head' }] })
    && !isFaceOnly({ expressions: [{ name: 'happy' }], clip: { name: 'x' } }) && !isFaceOnly({ bones: [{ bone: 'head' }] });
  console.log(`${shapeOk ? 'ok  ' : 'FAIL'} face-only shape: expressions only accepted, any body channel / clip rejected`);
  if (!shapeOk) failures++;
}

// PCHIP key tangents never overshoot (T-31 0.2.3 B2 item 3): sample a keyed bone over its whole span and check the
// value stays inside the key range. Catmull-Rom's central difference dipped below the keys on a flat-then-rise set.
{
  const cases = [
    [{ t: 0, v: 0 }, { t: 10, v: 0 }, { t: 100, v: 40 }], // flat then a quick rise
    [{ t: 0, v: 0 }, { t: 30, v: 5 }, { t: 60, v: 40 }],  // monotone, non-uniform steps
    [{ t: 0, v: 40 }, { t: 40, v: 35 }, { t: 90, v: 0 }], // monotone down
  ];
  let worst = 0;
  for (const ks of cases) {
    const lo = Math.min(...ks.map((k) => k.v)), hi = Math.max(...ks.map((k) => k.v));
    let clock = 0;
    const p = new GesturePlayer({ now: () => clock, random: () => 0.5 });
    p.play({ id: 'k', bones: [{ bone: 'head', keys: ks.map((k) => ({ t: k.t, rot: [k.v, 0, 0] })) }] }, { noJitter: true });
    for (let t = 0; t <= ks[ks.length - 1].t; t += 1) {
      clock = t;
      const a = new ChannelAcc();
      p.evaluate(a, clock);
      const x = (a.bones.head ? a.bones.head[0] : 0) / (Math.PI / 180);
      worst = Math.max(worst, lo - x, x - hi); // how far the curve strayed outside [lo, hi]
    }
  }
  const okp = worst <= 1e-6;
  console.log(`${okp ? 'ok  ' : 'FAIL'} pchip keys: no overshoot past the keys (worst excess=${worst.toExponential(2)} deg)`);
  if (!okp) failures++;
  // the tangent rule itself: flat at both ends (the authored ease-in/out contract) and the PCHIP interior harmonic
  // mean of the two secants -- never Catmull-Rom's central difference (which overshoots).
  {
    const ms = pchipTangents([{ t: 0, v: [0, 0, 0] }, { t: 10, v: [40, 0, 0] }, { t: 60, v: [42, 0, 0] }], 0);
    // interior: w1 = 2h1 + h0 = 110, w2 = h1 + 2h0 = 70; secants d0 = 4, d1 = 0.04 deg/ms.
    const want = (110 + 70) / ((110 / 4) + (70 / 0.04));
    const tok = ms[0] === 0 && ms[2] === 0 && Math.abs(ms[1] - want) < 1e-9;
    console.log(`${tok ? 'ok  ' : 'FAIL'} pchip tangents: ends flat, interior = harmonic mean (m=[${ms.map((v) => v.toFixed(4)).join(', ')}])`);
    if (!tok) failures++;
  }
}

console.log(`${count} variants, ${failures} failures`);
process.exit(failures ? 1 : 0);
