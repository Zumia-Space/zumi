// T-31 alpha.3 R3 gate (REVIEW-OPUS B1, pure Node): the holo panel's smallest text is >= 11 px ON SCREEN in the float panel (wide and close framing) at
// 1366x768 and 1920x1080, in the compact layout's line set, and the layout switch (320/340 px) is exact. The seated half is scripts/check-holo-seated-rect.mjs.
//   node scripts/check-holo-legible.mjs   (npm run check:holo-legible)
// New file by CoS rule A (alpha.3): this used to be section 13 of scripts/check-float-holo.mjs, which stays frozen.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { coverCropRect, FLOAT_WIDE, FLOAT_CLOSE } from '../src/renderer/room/camera-director.js';
import { FLOAT } from '../src/renderer/room/float-mode.js';
import { HoloScreen, faceCamera } from '../src/renderer/room/holo-screen.js';
import { measureHolo, MIN_ON_SCREEN_PX, STAGE_CANVAS, LEGIBLE_FIXTURE } from './lib/holo-legible.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (cond, msg, detail) => { if (cond) pass++; else fail++; console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}${!cond && detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`); };

// Nominal body proportions and the float camera, as scripts/check-float-holo.mjs places them (no VRM here).
const STATURE = 1.55, HIP_FRAC = 0.53, HEAD_BELOW_TOP = 0.12;
const roomJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'resources-pinned', 'room-v2', 'room.json'), 'utf8'));
const talk = roomJson.views.talk;
const t3 = talk.camera.three;
const [plateW, plateH] = talk.plateSize;
const seat = talk.zumi_seat;
function cameraAt(canvasW, canvasH, preset) {
  const c = new THREE.PerspectiveCamera(t3.fov, t3.aspect, 0.05, 50);
  c.position.set(talk.camera.pos[0], talk.camera.pos[1], talk.camera.pos[2]);
  c.lookAt(new THREE.Vector3(talk.camera.target[0], talk.camera.target[1], talk.camera.target[2]));
  const plate = coverCropRect(plateW, plateH, canvasW, canvasH, preset.zoom, preset.biasUp || 0, preset.biasRight || 0, preset.anchor || null);
  const vo = t3.viewOffset, s = vo.width / plateW;
  c.setViewOffset(vo.fullWidth, vo.fullHeight, vo.x + plate.x * s, vo.y + plate.y * s, plate.w * s, plate.h * s);
  c.updateProjectionMatrix(); c.updateMatrixWorld(true);
  return { camera: c, plate };
}
const ndc = (c, x, y, z) => new THREE.Vector3(x, y, z).project(c);

// ---------- 13. T-31 alpha.3 R3 round 2: the panel's text is >= 11 px ON SCREEN (float, wide and close framing, both window sizes) ----------
// REVIEW-OPUS: the 512 px canvas lands on a panel that is only 164 px wide in the float wide view at 1366x768, so 20-34 px canvas text came out as 6-11 px.
// The panel's on-screen width comes from the same projection as section 3/9 (nominal body, the stage canvas of each window); the real HoloScreen draws into a
// recording context (scripts/lib/holo-legible.mjs) and every drawn line must come out >= MIN_ON_SCREEN_PX. The seated half is in check-work-seated.mjs.
{
  const x = seat.pos[0], z = seat.pos[2] + FLOAT.z, s = FLOAT.scale;
  const hipsY = FLOAT.soleY + HIP_FRAC * STATURE * s, headY = FLOAT.soleY + (STATURE - HEAD_BELOW_TOP) * s;
  const centre = new THREE.Vector3(x + -0.42 * s, hipsY + 0.45 * s, z + 0.30 * s);
  const pw = 0.42 * s, ph = 0.26 * s;
  const widthNdc = (camera) => {
    const obj = new THREE.Object3D(); obj.position.copy(centre);
    faceCamera(obj, camera); obj.updateMatrixWorld(true); // update()'s orientation since alpha.10
    const xs = [[-pw / 2, -ph / 2], [pw / 2, -ph / 2], [pw / 2, ph / 2], [-pw / 2, ph / 2]].map(([dx, dy]) => ndc(camera, ...obj.localToWorld(new THREE.Vector3(dx, dy, 0)).toArray()).x);
    return Math.max(...xs) - Math.min(...xs);
  };
  const seen = [];
  for (const [win, [cw, ch]] of Object.entries(STAGE_CANVAS)) {
    for (const [name, preset] of [['wide', FLOAT_WIDE], ['close', FLOAT_CLOSE]]) {
      const cssW = widthNdc(cameraAt(cw, ch, preset).camera) / 2 * cw;
      const m = measureHolo(HoloScreen, FLOAT, cssW);
      seen.push({ win, name, cssW: m.cssW, layout: m.layout, livePx: m.livePx, onScreen: +m.liveOnScreen.toFixed(1), idleOnScreen: +m.idleOnScreen.toFixed(1) });
      ok(m.liveOnScreen >= MIN_ON_SCREEN_PX, `R3 legible: float ${name} ${win}: the smallest task text is >= ${MIN_ON_SCREEN_PX} px on screen (panel ${m.cssW} px wide, ${m.liveOnScreen.toFixed(1)} px)`, m.live.map((t) => `${t.px}:${t.s}`));
      ok(m.idleOnScreen >= MIN_ON_SCREEN_PX, `R3 legible: float ${name} ${win}: NO LIVE TASK is >= ${MIN_ON_SCREEN_PX} px on screen (${m.idleOnScreen.toFixed(1)} px)`, m.idle.map((t) => `${t.px}:${t.s}`));
    }
  }
  // alpha.12 (owner 01-11): one layout in the HUD's type at every card size. A small card drops rows from the bottom, never shrinks or enlarges text.
  const small = measureHolo(HoloScreen, FLOAT, 165), big = measureHolo(HoloScreen, FLOAT, 400);
  const sTexts = (m) => m.live.map((t) => t.s);
  ok(sTexts(small).some((t) => t.startsWith('Render the float')) && sTexts(small).includes('STEP 19/37 \u00b7 51% DONE') && sTexts(small).includes('WAITING FOR OWNER') && sTexts(small).some((t) => t.startsWith('Check the')), 'small card (165 px): title, progress, state and step label are all there', sTexts(small));
  ok(sTexts(big).filter((t) => t.startsWith('DONE \u00b7')).length === 3, 'big card (400 px): the 3 finished steps fit too', sTexts(big));
  for (const [stepState, word] of [['active', 'WORKING'], ['waiting', 'WAITING FOR OWNER'], ['blocked', 'BLOCKED'], ['todo', 'QUEUED']]) {
    const m = measureHolo(HoloScreen, FLOAT, 165, { ...LEGIBLE_FIXTURE, stepState });
    const stateText = m.live.find((t) => t.s === word), label = m.live.find((t) => t.s.startsWith('Chec'));
    const shown = label ? label.s.replace(/\u2026$/, '').length : 0;
    ok(Boolean(stateText) && Boolean(label) && label.y > stateText.y && shown >= 18, `small card ${word}: the step label is on its own line below the state word with >= 18 visible characters (${shown})`, { stateText, label });
  }
  {
    const p = Object.create(HoloScreen.prototype); let draws = 0; p.cssW = 300; p.draw = () => { draws++; };
    p.setScreenWidth(305); const still = draws === 0 && p.cssW === 300; p.setScreenWidth(320); const moved = draws === 1 && p.cssW === 320;
    ok(still && moved, 'the card redraws only when its on-screen width moved by 4 % (the hover bob never redraws)', { draws, cssW: p.cssW });
  }
  console.log(`  R3 legible (float, model): ${JSON.stringify(seen)}`);
}

console.log(`\ncheck:holo-legible ${pass}/${pass + fail} passed`);
process.exitCode = fail ? 1 : 0;
