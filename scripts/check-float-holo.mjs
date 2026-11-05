// T-31 float-holo pilot: pure-Node checks (no browser, no Electron). Validates the placement/framing numbers
// (FLOAT + FLOAT_WIDE), the video-room coverage at the float crop, the holo panel-vs-face separation, the
// flicker envelope, the seated default, the i18n keys, and the float-idle clip's shape.
//   node scripts/check-float-holo.mjs   (npm run check:float-holo)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { coverCropRect, FLOAT_WIDE, FLOAT_CLOSE } from '../src/renderer/room/camera-director.js';
import { sceneVideoRect, rectCovers } from '../src/renderer/room/scene-video.js';
import { FLOAT, readStageMode, HOVER_AMPLITUDE_M, HOVER_PERIOD_S, HOVER_SWAY_M, FLOAT_TOE_BELOW_ANKLE_M } from '../src/renderer/room/float-mode.js';
import { shadowForHover, shadowCoreAlpha, SHADOW, SHADOW_DARK_MIN } from '../src/renderer/room/float-shadow.js';
import { flickerEnvelope, SCREEN_LIGHT_CD, SCREEN_LIGHT_DISTANCE, RIM_TINT, RIM_ONLY_TINT, parseLightMode,
  frontSurfaceDelta, edgeSurfaceDelta, rimTerm, FRONT_DELTA_LIMIT, EDGE_DELTA_MIN, EDGE_FRESNEL_LIFT, liveAccent, SCREEN_OFFSET, faceCamera } from '../src/renderer/room/holo-screen.js';
import { HOLO_STYLES } from '../src/renderer/room/float-holo-prefs.js';
import { TABLES } from '../src/renderer/i18n.js';
import { hudCardRect } from '../src/renderer/hud/hud-logic.js';
import { ownerPath } from './lib/owner-paths.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (cond, msg, detail) => { if (cond) pass++; else fail++; console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}${!cond && detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`); };

// Nominal body proportions (the pilot check has no VRM): stature 1.55 m, hip joint at 53% of it, head bone
// 0.12 m below the crown. Only used to place the nominal head/hips the panel is measured against.
const STATURE = 1.55, HIP_FRAC = 0.53, HEAD_BELOW_TOP = 0.12;
const HOVER = 0.033; // the hover's vertical amplitude
// 1204x689 is the harness's own stage viewport (a 1280x800 window minus the 76 px left rail, 47 px toolbar and the
// ~64 px bottom composer, measured off the spare-PC still). It is carried alongside 16:10/16:9 so the real window is
// covered too; 16:9 is the tightest of the three (widest aspect -> shortest cover-crop window), so it stays the
// binding case.
const ASPECTS = [[1204, 689], [1600, 1000], [1920, 1080]];

// ---------- room + camera ----------
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

// ---------- 1. framing margins + the float gap (head >= 5% below top, ankle >= 8% above bottom) ----------
// Anchors on the FOOT BONE (the ankle), because float-mode.js now places the ankle at FLOAT.soleY under the
// float pose and the harness foot gate reads that same bone. The crown (ankle + stature) is checked too.
{
  const x = seat.pos[0], z = seat.pos[2] + FLOAT.z, bodyH = STATURE * FLOAT.scale;
  const worst = { headBone: Infinity, crown: Infinity, ankle: Infinity };
  for (const [cw, ch] of ASPECTS) {
    const { camera } = cameraAt(cw, ch, FLOAT_WIDE);
    for (const hover of [-HOVER, 0, HOVER]) {
      const ankleY = FLOAT.soleY + hover;
      const headBoneY = ankleY + (STATURE - HEAD_BELOW_TOP) * FLOAT.scale;
      const crownY = ankleY + bodyH;
      const headBoneMargin = (1 - ndc(camera, x, headBoneY, z).y) / 2 * 100;
      const crownMargin = (1 - ndc(camera, x, crownY, z).y) / 2 * 100;
      const ankleMargin = (ndc(camera, x, ankleY, z).y + 1) / 2 * 100;
      worst.headBone = Math.min(worst.headBone, headBoneMargin);
      worst.crown = Math.min(worst.crown, crownMargin);
      worst.ankle = Math.min(worst.ankle, ankleMargin);
    }
  }
  ok(worst.headBone >= 5, `framing: head bone >= 5% below the frame top at ${ASPECTS.map((a) => a.join('x')).join('/')} + both hover extremes (worst ${worst.headBone.toFixed(1)}%)`, worst);
  ok(worst.crown >= 5, `framing: crown >= 5% below the frame top (worst ${worst.crown.toFixed(1)}%)`, worst);
  ok(worst.ankle >= 8, `framing: ankle/foot bone >= 8% above the frame bottom (worst ${worst.ankle.toFixed(1)}%)`, worst);
  const gapPct = FLOAT.soleY / bodyH * 100;
  ok(gapPct >= 8, `float: feet hang >= 8% of her height above the floor (ankle ${FLOAT.soleY} m = ${gapPct.toFixed(1)}% of ${bodyH.toFixed(2)} m)`, gapPct);
}

// ---------- 2. every video room covers the float crop ----------
{
  const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets', 'rooms-video', 'rooms.json'), 'utf8'));
  const [vPW, vPH] = man.plateSize;
  const cropAt = (w, h) => coverCropRect(vPW, vPH, w, h, FLOAT_WIDE.zoom, 0, FLOAT_WIDE.biasRight, FLOAT_WIDE.anchor);
  ok(man.rooms.length === 7, `rooms.json lists 7 video rooms (${man.rooms.length})`);
  for (const r of man.rooms) {
    const rect = sceneVideoRect(man, r.framing);
    const misses = ASPECTS.filter(([w, h]) => !rectCovers(rect, cropAt(w, h))).map((a) => a.join('x'));
    ok(misses.length === 0, `coverage: ${r.id} shows no video edge in the float crop at ${ASPECTS.map((a) => a.join('x')).join(', ')}`, misses);
  }
}

// ---------- 3. the panel's projected rect does not overlap the face box (head +- 0.11 m*scale) ----------
{
  const x = seat.pos[0], z = seat.pos[2] + FLOAT.z, s = FLOAT.scale;
  const hipsY = FLOAT.soleY + HIP_FRAC * STATURE * s;
  const headY = FLOAT.soleY + (STATURE - HEAD_BELOW_TOP) * s;
  const centre = new THREE.Vector3(x + -0.42 * s, hipsY + 0.45 * s, z + 0.30 * s);
  const pw = 0.42 * s, ph = 0.26 * s;
  for (const [cw, ch] of ASPECTS) {
    const { camera } = cameraAt(cw, ch, FLOAT_WIDE);
    // orient the panel the way holo-screen.update() does: square to the camera (faceCamera, alpha.10)
    const obj = new THREE.Object3D(); obj.position.copy(centre); faceCamera(obj, camera); obj.updateMatrixWorld(true);
    const corners = [[-pw / 2, -ph / 2], [pw / 2, -ph / 2], [pw / 2, ph / 2], [-pw / 2, ph / 2]]
      .map(([dx, dy]) => obj.localToWorld(new THREE.Vector3(dx, dy, 0)));
    const proj = corners.map((p) => ndc(camera, p.x, p.y, p.z));
    const panel = { x0: Math.min(...proj.map((p) => p.x)), x1: Math.max(...proj.map((p) => p.x)), y0: Math.min(...proj.map((p) => p.y)), y1: Math.max(...proj.map((p) => p.y)) };
    const hb = 0.11 * s;
    const facePts = [[-hb, -hb], [hb, -hb], [hb, hb], [-hb, hb]].map(([dx, dy]) => ndc(camera, x + dx, headY + dy, z));
    const face = { x0: Math.min(...facePts.map((p) => p.x)), x1: Math.max(...facePts.map((p) => p.x)), y0: Math.min(...facePts.map((p) => p.y)), y1: Math.max(...facePts.map((p) => p.y)) };
    const overlap = panel.x0 < face.x1 && panel.x1 > face.x0 && panel.y0 < face.y1 && panel.y1 > face.y0;
    ok(!overlap, `panel: the screen rect does not overlap the face box at ${cw}x${ch}`, { panel, face });
  }
}

// ---------- 4. flickerEnvelope ----------
{
  const want = [[0, 0.35], [50, 1.1], [100, 0.55], [180, 0.8], [220, 1], [400, 1]];
  for (const [ms, v] of want) ok(Math.abs(flickerEnvelope(ms) - v) < 1e-9, `flickerEnvelope(${ms}) = ${v}`, flickerEnvelope(ms));
  ok(flickerEnvelope(50, true) === 1 && flickerEnvelope(0, true) === 1, 'flickerEnvelope under reduced motion is flat 1');
}

// ---------- 4b. screen light: short falloff, low intensity, and the point|rim switch ----------
{
  ok(SCREEN_LIGHT_DISTANCE > 0 && SCREEN_LIGHT_DISTANCE <= 0.9, `light: short falloff cutoff (${SCREEN_LIGHT_DISTANCE} m <= 0.9)`);
  ok(SCREEN_LIGHT_CD >= 0.3 && SCREEN_LIGHT_CD <= 0.8, `light: intensity inside the measured 0.3-0.8 cd band (${SCREEN_LIGHT_CD} cd)`);
  ok(RIM_ONLY_TINT > RIM_TINT, `light: rim-only mode tints the rim harder than the point-mode garnish (${RIM_ONLY_TINT} > ${RIM_TINT})`);
  ok(parseLightMode('rim') === 'rim', "parseLightMode('rim') -> 'rim'");
  ok(parseLightMode('point') === 'point', "parseLightMode('point') -> 'point'");
  ok(parseLightMode(undefined) === 'point' && parseLightMode('') === 'point', "parseLightMode: empty/unknown defaults to 'point'");
}

// ---------- 5. the stage mode defaults to 'seated' ----------
{
  ok(readStageMode(null) === 'seated', "readStageMode: empty storage -> 'seated'");
  ok(readStageMode({ getItem: () => null }) === 'seated', "readStageMode: null value -> 'seated'");
  ok(readStageMode({ getItem: () => 'float' }) === 'float', "readStageMode: 'float' -> 'float'");
  ok(readStageMode({ getItem: () => { throw new Error('disabled'); } }) === 'seated', "readStageMode: a throwing storage -> 'seated'");
}

// ---------- 6. i18n keys exist in en/vi/zh ----------
{
  for (const [lang, table] of Object.entries(TABLES)) {
    const missing = ['settings.stageMode', 'settings.stageModeD', 'stage.seated', 'stage.float'].filter((k) => typeof table[k] !== 'string' || !table[k].trim());
    ok(missing.length === 0, `i18n ${lang}: Pose (pilot) keys present`, missing.join(', '));
  }
}

// ---------- 7. float-idle.vrma parses, holds only leg rotation tracks, and carries NON-ZERO bends ----------
// "it has channels" is not enough: the harness also asserts a live knee angle at runtime. Here we decode the
// authored quaternions and require a real rotation on every leg bone (a runaway-identity clip fails this).
{
  const LEG = ['leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot'];
  const file = path.join(ROOT, 'assets', 'clips', 'float-idle.vrma');
  let json = null; try { json = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { /* leave null */ }
  ok(json && Array.isArray(json.animations) && json.animations.length === 1, 'float-idle.vrma parses and has one animation', json && json.animations && json.animations.length);
  if (json && json.animations) {
    const anim = json.animations[0];
    const human = json.extensions && json.extensions.VRMC_vrm_animation && json.extensions.VRMC_vrm_animation.humanoid.humanBones;
    const nameOf = (nodeIndex) => Object.keys(human || {}).find((n) => human[n].node === nodeIndex);
    const targets = anim.channels.map((c) => ({ bone: nameOf(c.target.node), path: c.target.path }));
    ok(targets.every((t) => t.path === 'rotation'), 'float-idle.vrma: every channel is a rotation track', targets.map((t) => t.path));
    ok(targets.every((t) => LEG.includes(t.bone)), 'float-idle.vrma: only leg bones are animated (hips carries no channel)', targets.map((t) => t.bone));
    ok(anim.channels.length === LEG.length, `float-idle.vrma: exactly ${LEG.length} channels`, anim.channels.length);
    // Decode the authored quaternion per bone and require a non-trivial rotation (angle = 2*acos|w|).
    const buf = json.buffers && json.buffers[0] && String(json.buffers[0].uri).startsWith('data:')
      ? Buffer.from(String(json.buffers[0].uri).split(',')[1], 'base64') : null;
    const angleOf = (ch) => {
      const acc = json.accessors[anim.samplers[ch.sampler].output];
      const bv = json.bufferViews[acc.bufferView];
      const off = (bv.byteOffset || 0) + (acc.byteOffset || 0);
      const w = Math.min(1, Math.abs(buf.readFloatLE(off + 12)));
      return 2 * Math.acos(w) * 180 / Math.PI;
    };
    const quatOf = (ch) => {
      const acc = json.accessors[anim.samplers[ch.sampler].output];
      const bv = json.bufferViews[acc.bufferView];
      const off = (bv.byteOffset || 0) + (acc.byteOffset || 0);
      return new THREE.Quaternion(buf.readFloatLE(off), buf.readFloatLE(off + 4), buf.readFloatLE(off + 8), buf.readFloatLE(off + 12));
    };
    if (buf) {
      const chOf = {}; for (const c of anim.channels) chOf[nameOf(c.target.node)] = c;
      const angle = {}; for (const [b, c] of Object.entries(chOf)) angle[b] = angleOf(c);
      ok(angle.leftUpperLeg > 5 && angle.rightUpperLeg > 5, `float-idle: thighs carry a real hip flex (L ${angle.leftUpperLeg.toFixed(1)}deg, R ${angle.rightUpperLeg.toFixed(1)}deg)`, angle);
      ok(angle.leftLowerLeg > 10 && angle.rightLowerLeg > 10, `float-idle: knees carry a real bend (L ${angle.leftLowerLeg.toFixed(1)}deg, R ${angle.rightLowerLeg.toFixed(1)}deg)`, angle);
      ok(angle.leftFoot > 10 && angle.rightFoot > 10 && angle.leftFoot <= 20 && angle.rightFoot <= 20, `float-idle: feet are relaxed, not en pointe (10-20deg: L ${angle.leftFoot.toFixed(1)}deg, R ${angle.rightFoot.toFixed(1)}deg)`, angle);

      // KNEE BEND at runtime: the angle between the thigh line and the shin line, exactly how the harness reads it
      // live (SNAP.knees). Reconstructed from the clip's own quaternions + the vrma's node translations, top-down
      // (hips identity -> thigh, then the thigh's world rotation -> shin). The per-bone rotation angle above is NOT
      // the knee bend, so this is the assertion the brief asks for: >= ~25 deg on BOTH legs, one more bent.
      const nodes = json.nodes || [];
      const restDir = (bone) => { const node = nodes.find((n) => n.name === bone); const child = node && node.children && node.children[0];
        const t = (child != null && nodes[child] && nodes[child].translation) || [0, -1, 0];
        return new THREE.Vector3(t[0], t[1], t[2]).normalize(); };
      const kneeBendOf = (side) => {
        const qUp = quatOf(chOf[`${side}UpperLeg`]), qLo = quatOf(chOf[`${side}LowerLeg`]);
        const thigh = restDir(`${side}UpperLeg`).applyQuaternion(qUp).normalize();
        const shin = restDir(`${side}LowerLeg`).applyQuaternion(qLo).applyQuaternion(qUp).normalize();
        return Math.acos(Math.max(-1, Math.min(1, thigh.dot(shin)))) * 180 / Math.PI;
      };
      const knee = { left: kneeBendOf('left'), right: kneeBendOf('right') };
      ok(knee.left >= 25 && knee.right >= 25, `float-idle: runtime knee bend >= 25deg on BOTH legs (L ${knee.left.toFixed(1)}deg, R ${knee.right.toFixed(1)}deg)`, knee);
      ok(Math.abs(knee.left - knee.right) >= 8, `float-idle: the two knees are visibly asymmetric (|L-R| ${Math.abs(knee.left - knee.right).toFixed(1)}deg >= 8)`, knee);
    } else ok(false, 'float-idle.vrma: embedded buffer decodes (non-zero bends checked)');
  }
}

// ---------- 8. hover bob (cheap win 2): +-2-3 cm, period 3-4 s ----------
{
  ok(HOVER_AMPLITUDE_M >= 0.02 && HOVER_AMPLITUDE_M <= 0.03, `hover: bob amplitude inside the 2-3 cm band (${(HOVER_AMPLITUDE_M * 100).toFixed(1)} cm)`);
  ok(HOVER_PERIOD_S >= 3 && HOVER_PERIOD_S <= 4, `hover: bob period inside 3-4 s (${HOVER_PERIOD_S} s)`);
  ok(HOVER_AMPLITUDE_M + HOVER_SWAY_M <= 0.0305, `hover: the summed peak stays <= 3 cm (${((HOVER_AMPLITUDE_M + HOVER_SWAY_M) * 100).toFixed(1)} cm)`);
}

// ---------- 8b. floor shadow (cheap win 1): stronger at the low bob, fades/shrinks as she rises ----------
{
  const lo = shadowForHover(SHADOW.refGap - HOVER_AMPLITUDE_M), hi = shadowForHover(SHADOW.refGap + HOVER_AMPLITUDE_M), mid = shadowForHover(SHADOW.refGap);
  ok(hi.opacity < mid.opacity && mid.opacity <= lo.opacity && hi.scale < lo.scale, `shadow: fainter + smaller as the hover rises (opacity ${hi.opacity.toFixed(3)}..${lo.opacity.toFixed(3)}, scale ${hi.scale.toFixed(3)}..${lo.scale.toFixed(3)})`);
  const steps = [0.05, 0.10, 0.18, 0.30, 0.60, 1.2].map((g) => shadowForHover(g));
  ok(steps.every((s, i) => i === 0 || (s.opacity <= steps[i - 1].opacity && s.scale <= steps[i - 1].scale)), 'shadow: monotonic non-increasing over a range of heights', steps.map((s) => s.opacity.toFixed(2)));
  ok(steps.every((s) => s.opacity >= 0 && s.scale > 0), 'shadow: opacity/scale stay in bounds', steps);
}

// ---------- 9. close framing (cheap win 3): head-to-knees, the panel larger and fully in frame, rooms still cover ----------
{
  const x = seat.pos[0], z = seat.pos[2] + FLOAT.z, s = FLOAT.scale, bodyH = STATURE * s;
  const KNEE_LIFT = 0.34; // the float pose's knee sits ~0.34 m above the ankle (shin ~0.42 m*scale, angled)
  let worst = { head: Infinity, knee: Infinity, ankle: Infinity, panelMax: 0, area: Infinity, faceOverlap: false };
  let wideArea = 0;
  for (const [cw, ch] of ASPECTS) {
    const { camera } = cameraAt(cw, ch, FLOAT_CLOSE);
    for (const hover of [-HOVER, 0, HOVER]) {
      const ankleY = FLOAT.soleY + hover;
      worst.head = Math.min(worst.head, (1 - ndc(camera, x, ankleY + (STATURE - HEAD_BELOW_TOP) * s, z).y) / 2 * 100);
      worst.knee = Math.min(worst.knee, (ndc(camera, x, ankleY + KNEE_LIFT, z).y + 1) / 2 * 100);
      worst.ankle = Math.min(worst.ankle, (ndc(camera, x, ankleY, z).y + 1) / 2 * 100); // < 0 => feet cropped below
    }
    const hipsY = FLOAT.soleY + HIP_FRAC * STATURE * s, headY = FLOAT.soleY + (STATURE - HEAD_BELOW_TOP) * s;
    const centre = new THREE.Vector3(x + -0.42 * s, hipsY + 0.45 * s, z + 0.30 * s);
    const pww = 0.42 * s, phh = 0.26 * s;
    const obj = new THREE.Object3D(); obj.position.copy(centre); faceCamera(obj, camera); obj.updateMatrixWorld(true);
    const proj = [[-pww / 2, -phh / 2], [pww / 2, -phh / 2], [pww / 2, phh / 2], [-pww / 2, phh / 2]]
      .map(([dx, dy]) => obj.localToWorld(new THREE.Vector3(dx, dy, 0))).map((p) => ndc(camera, p.x, p.y, p.z));
    const panel = { x0: Math.min(...proj.map((p) => p.x)), x1: Math.max(...proj.map((p) => p.x)), y0: Math.min(...proj.map((p) => p.y)), y1: Math.max(...proj.map((p) => p.y)) };
    worst.panelMax = Math.max(worst.panelMax, Math.max(Math.abs(panel.x0), Math.abs(panel.x1), Math.abs(panel.y0), Math.abs(panel.y1)));
    worst.area = Math.min(worst.area, (panel.x1 - panel.x0) * (panel.y1 - panel.y0));
    const hb = 0.11 * s;
    const fp = [[-hb, -hb], [hb, -hb], [hb, hb], [-hb, hb]].map(([dx, dy]) => ndc(camera, x + dx, headY + dy, z));
    const face = { x0: Math.min(...fp.map((p) => p.x)), x1: Math.max(...fp.map((p) => p.x)), y0: Math.min(...fp.map((p) => p.y)), y1: Math.max(...fp.map((p) => p.y)) };
    if (panel.x0 < face.x1 && panel.x1 > face.x0 && panel.y0 < face.y1 && panel.y1 > face.y0) worst.faceOverlap = true;
    // the wide panel's area, for the "larger in frame" comparison
    const wideCam = cameraAt(cw, ch, FLOAT_WIDE).camera;
    const wproj = [[-pww / 2, -phh / 2], [pww / 2, -phh / 2], [pww / 2, phh / 2], [-pww / 2, phh / 2]]
      .map(([dx, dy]) => obj.localToWorld(new THREE.Vector3(dx, dy, 0))).map((p) => ndc(wideCam, p.x, p.y, p.z));
    wideArea = Math.max(wideArea, (Math.max(...wproj.map((p) => p.x)) - Math.min(...wproj.map((p) => p.x))) * (Math.max(...wproj.map((p) => p.y)) - Math.min(...wproj.map((p) => p.y))));
  }
  ok(worst.head >= 5, `close framing: the head bone stays >= 5% below the top (worst ${worst.head.toFixed(1)}%)`, worst);
  ok(worst.knee >= 0, `close framing: the knees stay in frame (worst ${worst.knee.toFixed(1)}% above the bottom)`, worst);
  ok(worst.ankle < 0, `close framing: the feet are cropped below the frame (worst ankle ${worst.ankle.toFixed(1)}% -- a head-to-knees crop)`, worst);
  ok(worst.panelMax <= 0.95 && !worst.faceOverlap, `close framing: the panel is fully in frame and clear of the face box (panel NDC max ${worst.panelMax.toFixed(2)})`, worst);
  ok(worst.area >= wideArea * 1.3, `close framing: the panel is larger than in the wide crop (close ${worst.area.toFixed(3)} vs wide ${wideArea.toFixed(3)})`, { close: worst.area, wide: wideArea });
  const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets', 'rooms-video', 'rooms.json'), 'utf8'));
  const [vPW, vPH] = man.plateSize;
  for (const r of man.rooms) {
    const rect = sceneVideoRect(man, r.framing);
    const misses = ASPECTS.filter(([w, h]) => !rectCovers(rect, coverCropRect(vPW, vPH, w, h, FLOAT_CLOSE.zoom, 0, FLOAT_CLOSE.biasRight, FLOAT_CLOSE.anchor))).map((a) => a.join('x'));
    ok(misses.length === 0, `close coverage: ${r.id} still shows no video edge in the close crop`, misses);
  }
}

// ---------- 10. r5 look: edge-only rim (parameter bound) + readable float (BRIEF-r4/r5 step C) ----------
// These are SHADER/LIGHT PARAMETER guards, NOT pixel measurements, and they say so: the render captures run on the
// spare PC and this box must never open a window. `frontSurfaceDelta` / `edgeSurfaceDelta` are pure functions of the
// forced rim shape (holo-screen's rimTerm + edgeLightColor). They model the RIM term only -- the shipped point mode
// also adds the panel's PointLight diffuse to a front facet, which these functions do not model. The REAL pixel
// checks (edge band ON-vs-OFF luminance gain >= 15%, front <= 14.4%, toe-tip floor strip) run on the box in
// scripts/electron-float-holo.cjs -- the render, not this file, is the authority for the rim being visible.
// `frontSurfaceDelta` is the fraction of the un-lit facet brightness a head-on facet gains from the rim (lift 0, so
// a front facet is ~0 for every accent); `edgeSurfaceDelta` is the modelled silhouette gain, equal across accents
// because every accent is normalised to EDGE_LUM.
{
  const CYAN = '#39d0ff', AMBER = '#ffb347'; // PAGES[0].accent / PAGES[1].accent (holo-screen.js)
  ok(EDGE_FRESNEL_LIFT === 0, 'edge light (params): the forced rim lift is 0, so a front-facing facet gets no tint');
  // ...and the gate BITES: the r3 authored shape (lift 1, power 1 -- what half the model's MToon materials shipped)
  // makes that same front-facing facet fully rim-lit (term 1 = the whole-surface amber wash r3 measured at +35.9%).
  ok(rimTerm(0.6) < 0.08 && rimTerm(0.6, 1, 1) === 1, `edge light (params): front facet term is small under the forced shape but 1 under r3's lift-1/power-1 (${rimTerm(0.6).toFixed(4)} vs ${rimTerm(0.6, 1, 1)})`);
  for (const [name, hex] of [['cyan', CYAN], ['amber', AMBER]]) {
    const front = frontSurfaceDelta(hex) * 100;
    ok(front <= FRONT_DELTA_LIMIT * 100, `edge light (params) ${name}: front-surface brightness delta <= ${(FRONT_DELTA_LIMIT * 100).toFixed(1)}% (modelled ${front.toFixed(2)}%)`, front);
  }
  for (const [name, hex] of [['cyan', CYAN], ['amber', AMBER]]) {
    const edge = edgeSurfaceDelta(hex);
    ok(edge >= EDGE_DELTA_MIN, `edge light (params) ${name}: modelled rim-edge gain >= ${EDGE_DELTA_MIN} -- the parameter bound behind the brief's +15% pixel floor, measured for real on the box (modelled ${edge.toFixed(3)})`, edge);
  }
  ok(Math.abs(edgeSurfaceDelta(CYAN) - edgeSurfaceDelta(AMBER)) < 1e-9, 'edge light (params): every accent normalises to ONE perceived edge brightness (amber adds no more than cyan)');
  // Contact shadow at the REST height: how dark the floor goes directly under her (decal opacity * its dark core).
  const restDark = shadowCoreAlpha(FLOAT.soleY);
  ok(restDark >= SHADOW_DARK_MIN, `shadow: contact-shadow darkness at rest height >= ${SHADOW_DARK_MIN} (pure-math ${restDark.toFixed(3)})`, restDark);
  // Feet clearance: r5 measures the TOE TIP (what the eye reads as the gap), not the ankle. The float-idle foot
  // plantar-flexes, so the toe tip hangs FLOAT_TOE_BELOW_ANKLE_M below the ankle bone; FLOAT.soleY is the ankle
  // height, so the visible rest gap = soleY - toeDrop. Both the rest gap (the brief's 8-12 cm band) and the lowest
  // bob point are asserted on the toe tip.
  const toeDrop = FLOAT_TOE_BELOW_ANKLE_M * FLOAT.scale;
  const toeRest = FLOAT.soleY - toeDrop;
  ok(toeRest >= 0.08 && toeRest <= 0.12, `float: the resting TOE-TIP gap is inside the 8-12 cm band (${(toeRest * 100).toFixed(1)} cm)`, toeRest);
  const lowestToeY = toeRest - (HOVER_AMPLITUDE_M + HOVER_SWAY_M);
  ok(lowestToeY > 0, `float: the TOE TIP stays clear of the floor at the lowest bob (${lowestToeY.toFixed(3)} m > 0)`, lowestToeY);
  // The close crop follows the float rest height (camera-director's FLOAT_CLOSE): lowering the hover slides the
  // crop window DOWN into the plate, so a future soleY change moves the frame with her rather than cropping knees.
  const windowYAt = (fy) => coverCropRect(plateW, plateH, 1204, 689, FLOAT_CLOSE.zoom, 0, FLOAT_CLOSE.biasRight, { plateYFrac: FLOAT_CLOSE.anchor.plateYFrac, frameYFrac: fy }).y;
  ok(windowYAt(FLOAT_CLOSE.anchor.frameYFrac) < windowYAt(0.20), `close framing: the crop follows the float rest height (raising soleY to ${FLOAT.soleY} slides the window UP: y ${windowYAt(FLOAT_CLOSE.anchor.frameYFrac).toFixed(1)} above the 0.20 anchor's ${windowYAt(0.20).toFixed(1)})`, { now: windowYAt(FLOAT_CLOSE.anchor.frameYFrac), ref: windowYAt(0.20) });
}

// ---------- Hologram QC switch: the Settings accent never reaches a pinned harness run ----------
// The box harness pins a page and measures cyan on page 0 / amber on page 1. The owner's Settings pick (a fixed
// accent) must not leak into those stills, so liveAccent() gives the PAGE colour while pinned and the pick only
// while unpinned -- the invariant that keeps the r6 sweep reproducible after this feature.
const P0 = '#39d0ff', P1 = '#ffb347', PICK = '#ff0000'; // PAGES[0] 'code' cyan / PAGES[1] 'bars' amber
ok(liveAccent(P0, PICK, true) === P0 && liveAccent(P1, PICK, true) === P1, 'accent: a pinned run follows the PAGE (cyan page 0 / amber page 1)', { p0: liveAccent(P0, PICK, true), p1: liveAccent(P1, PICK, true) });
ok(liveAccent(P0, PICK, false) === PICK, 'accent: an unpinned run uses the Settings pick');
ok(liveAccent(P0, null, false) === P0, 'accent: no pick -> the page accent (shipped behaviour)');

// ---------- 11. float-holo: NO catalog gesture aims a wrist into the panel (T-31 0.2.6) ----------
// The panel sits beside her right shoulder (SCREEN_OFFSET x < 0 in screen space). The idle 'stretch' raises BOTH
// wrists overhead, and the waves/focus gestures raise the right hand beside the head; from the talk camera those
// wrists/forearms sweep through the panel's projected rect (r2 QC: focus 'wave' put the right hand -0.126 NDC
// inside). The same rect catches the board's right-hand 'point-sidebar'. While the panel is shown, engine.js clamps
// every dispatch path through clampForHoloPanel(): 'overhead' and 'point-sidebar' are dropped, every raised side
// reach is mirrored to the LEFT hand (the 'random' mirror is pinned so a later pick cannot flip it back), and a reach
// already in flight is cancelled when the panel appears. Seated must still play the untouched command. Two layers:
//   a) the COMMAND the REAL player receives, for EVERY catalog gesture that raises or points at the panel -- float:
//      nothing dropped survives and nothing raised is left on the right (panel) hand, the greeting mirrored to the
//      left; seated: the authored command, same object. Needs no VRM and fails the instant playGuarded() is bypassed.
//   b) the POSE -- with the pilot VRM present (same convention as check:idle-life) the REAL rig is driven through
//      every such gesture, so the wrists AND forearms actually rendered are projected with SCREEN_OFFSET and must
//      stay MARGIN outside the panel rect. Seated (no panel) the untouched stretch AND wave MUST enter the rect --
//      the hazard the clamp removes -- so the geometry provably bites, and removing the mirror makes 11b fail.
{
  const { ReflexEngine, ClipLayer, Catalog } = await import('../src/renderer/reflex/index.js');
  const { GesturePlayer } = await import('../src/renderer/reflex/player.js');
  const { HOLO_UNSAFE_REACH, HOLO_RAISED_REACH, needsHoloClamp, clampForHoloPanel } = await import('../src/renderer/reflex/engine.js');
  const MARGIN = 0.05; // NDC: "outside the panel with margin" -- bigger than any projection jitter
  const MODEL = (() => { const i = process.argv.indexOf('--model'); return (i >= 0 ? process.argv[i + 1] : null) || process.env.ZUMI_TEST_MODEL || ownerPath('testModel', 'local/test-model.vrm'); })();
  const random = () => 0.5; // deterministic variant/side picks

  // The real catalog, read straight off disk (check-idle-life's pattern: no fetch() outside a window).
  const gesturesDir = path.join(ROOT, 'src', 'renderer', 'reflex', 'gestures');
  const triggerIndex = JSON.parse(fs.readFileSync(path.join(gesturesDir, 'index.json'), 'utf8'));
  const catalogDefs = new Map();
  for (const name of triggerIndex.triggers) catalogDefs.set(name, JSON.parse(fs.readFileSync(path.join(gesturesDir, `${name}.json`), 'utf8')));
  const loadCatalog = (rnd) => {
    const c = new Catalog(rnd);
    for (const [name, def] of catalogDefs) c.triggers.set(name, { name, labelVi: def.labelVi, state: Boolean(def.state), variants: def.variants });
    return c;
  };
  const raises = (target) => HOLO_UNSAFE_REACH.includes(target) || HOLO_RAISED_REACH.includes(target);
  const raisedOn = (cmd, hand) => (cmd && Array.isArray(cmd.reach) ? cmd.reach.filter((r) => r && HOLO_RAISED_REACH.includes(r.target) && r.hand === hand) : []);
  const unsafeOn = (cmd, hand) => (cmd && Array.isArray(cmd.reach) ? cmd.reach.filter((r) => r && HOLO_UNSAFE_REACH.includes(r.target) && (!hand || r.hand === hand)) : []);
  // Every catalog command with a raised reach, plus the whole 'bored' idle catalog: 0.2.7 adds panel-safe fidgets
  // (clasp / chest / chin / left hip / left beside-head) as DATA only, and they must stay outside the panel too --
  // including any future fidget on a target nobody has measured yet.
  const panelGestures = [];
  for (const [trigger, def] of catalogDefs) {
    for (const v of def.variants) {
      const reach = v.command && v.command.reach;
      if (Array.isArray(reach) && (trigger === 'bored' || reach.some((r) => r && raises(r.target)))) panelGestures.push({ trigger, variant: v.id, command: v.command });
    }
  }
  ok(panelGestures.length >= 8, `11: the inventory covers every catalog gesture with a raised/panel-side reach, plus the idle fidgets (${panelGestures.length}: ${panelGestures.map((g) => `${g.trigger}/${g.variant}`).join(', ')})`);
  ok(panelGestures.some((g) => g.command.reach.some((r) => r.target === 'wave')) && panelGestures.some((g) => g.command.reach.some((r) => r.target === 'overhead')),
    '11: the inventory includes both the right-hand waves and the overhead stretch');

  // 11a: the real engine's dispatch path, with only its `vrm` guard satisfied (the player is a recorder, so this
  // asserts exactly what production hands the player -- the same call playGuarded() makes).
  const barePlay = (g, holo) => {
    const catalog = loadCatalog(random);
    const engine = new ReflexEngine({ catalog, clips: new ClipLayer(), random });
    engine.vrm = {}; // dispatch guard only: §11a asserts the command, §11b measures the pose on a real rig
    engine.setHoloPanel(holo);
    const played = [];
    engine.player.play = (cmd) => { played.push(cmd); return { ok: true, id: played.length, warnings: [] }; };
    catalog.forceNext(g.trigger, g.variant);
    engine.trigger(g.trigger);
    return played;
  };
  for (const g of panelGestures) {
    const floatCmd = barePlay(g, true);
    ok(floatCmd.length === 1, `11a float ${g.trigger}/${g.variant}: the real engine plays exactly one command`, floatCmd.length);
    ok(unsafeOn(floatCmd[0], 'right').length === 0, `11a float ${g.trigger}/${g.variant}: no panel-unsafe reach (overhead/point-sidebar) is left on the panel side (her right hand)`, floatCmd[0] && floatCmd[0].reach);
    ok(raisedOn(floatCmd[0], 'right').length === 0, `11a float ${g.trigger}/${g.variant}: no raised reach is left on the panel side (her right hand)`, floatCmd[0] && floatCmd[0].reach);
    if (g.command.reach.some((r) => r && HOLO_RAISED_REACH.includes(r.target))) {
      ok(raisedOn(floatCmd[0], 'left').length > 0, `11a float ${g.trigger}/${g.variant}: the greeting raises only the left hand (mirrored there, or authored there)`, floatCmd[0] && floatCmd[0].reach);
      ok(Boolean(floatCmd[0] && floatCmd[0].mirror !== 'random'), `11a float ${g.trigger}/${g.variant}: the mirror side is pinned (a random pick cannot flip the wave back)`, floatCmd[0] && floatCmd[0].mirror);
      const hs = (floatCmd[0] && floatCmd[0].hands) || [];
      ok(!hs.some((h) => h && h.hand === 'right' && h.shape === 'open-flat'), `11a float ${g.trigger}/${g.variant}: the open palm follows the mirrored wave`, hs);
    }
    const seatedCmd = barePlay(g, false);
    ok(seatedCmd.length === 1 && seatedCmd[0] === g.command, `11a seated ${g.trigger}/${g.variant}: no panel -> the UNTOUCHED authored command (same object)`, seatedCmd[0] && seatedCmd[0].id);
  }
  {
    // The stretch keeps its lean-back channels (not a cancelled gesture).
    const stretch = panelGestures.find((g) => g.variant === 'stretch');
    const cmd = barePlay(stretch, true)[0];
    ok(Boolean(cmd && cmd.bones && cmd.bones.length === 3 && cmd.expressions && cmd.expressions.length === 3),
      '11a float: the stretch keeps its spine/chest/head + face channels (a lean-back stretch, not a cancelled gesture)', cmd);
    // 0.2.7 (DIAG §5 row 4): only the RIGHT overhead is dropped; the left (away-from-panel) arm still goes up.
    ok(cmd && unsafeOn(cmd, 'left').length === 1 && unsafeOn(cmd, 'left')[0].target === 'overhead' && unsafeOn(cmd, 'right').length === 0,
      '11a float: the stretch KEEPS the left overhead reach and drops only the right (panel-side) one', cmd && cmd.reach);
    ok(unsafeOn(stretch.command).length === 2, '11a seated: both authored overhead reaches survive', unsafeOn(stretch.command).length);
    // A reach already in flight when seated -> float must be cancelled at the switch (the gate only sees new commands).
    const liveEngine = (trigger, variant) => {
      const catalog = loadCatalog(random);
      const engine = new ReflexEngine({ catalog, clips: new ClipLayer(), random });
      engine.vrm = {};
      catalog.forceNext(trigger, variant);
      engine.trigger(trigger);
      return engine;
    };
    const reaching = liveEngine('focus', 'wave');
    ok(reaching.player.instances.length === 1, '11a switch: the wave is live while seated', reaching.player.instances.length);
    reaching.setHoloPanel(true);
    ok(reaching.player.instances.length === 0, '11a switch: seated -> float cancels a reach already in flight (it cannot finish through the panel)', reaching.player.instances.length);
    const safe = liveEngine('focus', 'brighten');
    safe.setHoloPanel(true);
    ok(safe.player.instances.length === 1, '11a switch: a command with no reach keeps playing across the switch', safe.player.instances.length);

    // A left-authored raised/unsafe reach with mirror:'random' must be pinned: player.js swaps hands on that flag,
    // which would put it back on the panel side. The side-aware clamp must catch this case (not just right-authored).
    const flipCmd = (hand, target) => ({ id: `flip-${hand}-${target}`, mirror: 'random', reach: [{ hand, target, inMs: 200, holdMs: 300, outMs: 200 }] });
    const leftOver = flipCmd('left', 'overhead');
    const leftOverOut = clampForHoloPanel(leftOver);
    ok(needsHoloClamp(leftOver) && leftOverOut.mirror === 'none' && leftOverOut.reach.length === 1 && leftOverOut.reach[0].hand === 'left',
      '11a mirror: a left overhead with mirror:random is pinned to the left (never flipped through the panel)', leftOverOut);
    const rightOverOut = clampForHoloPanel(flipCmd('right', 'overhead'));
    ok(rightOverOut.reach === undefined && rightOverOut.mirror === 'none', '11a mirror: a right overhead with mirror:random is dropped and the mirror pinned', rightOverOut);
    const leftWaveOut = clampForHoloPanel(flipCmd('left', 'wave'));
    ok(leftWaveOut.mirror === 'none' && leftWaveOut.reach.length === 1 && leftWaveOut.reach[0].hand === 'left',
      '11a mirror: a left wave with mirror:random is pinned (the greeting cannot flip back to the panel side)', leftWaveOut);
  }

  // 11b: the real rig. Same headless VRM load as check:idle-life (three's GLTFLoader needs the two browser stubs).
  if (!fs.existsSync(MODEL)) {
    console.log(`SKIP 11b: no pilot VRM at ${MODEL} (pass --model <file.vrm> or ZUMI_TEST_MODEL); 11a still guards the clamp`);
  } else {
    globalThis.self = globalThis;
    globalThis.window = globalThis;
    globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
    const { VRMLoaderPlugin, VRMUtils } = await import('@pixiv/three-vrm');
    const loader = new GLTFLoader();
    loader.register((p) => new VRMLoaderPlugin(p));
    const buf = fs.readFileSync(MODEL);
    const gltf = await loader.parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
    const vrm = gltf.userData.vrm;
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.combineSkeletons(gltf.scene);
    if (vrm.meta && vrm.meta.metaVersion === '0') VRMUtils.rotateVRM0(vrm);

    const clock = { t: 0 };
    performance.now = () => clock.t; // the engine + player evaluate on this clock, so 3 s of stretch runs in a loop
    const { camera } = cameraAt(1204, 689, FLOAT_WIDE); // the harness's own stage viewport (§1-3's binding case)
    const rectDist = (rect, p) => { // + outside (NDC), - inside (depth)
      const ix = p.x > rect.x0 && p.x < rect.x1, iy = p.y > rect.y0 && p.y < rect.y1;
      if (ix && iy) return -Math.min(p.x - rect.x0, rect.x1 - p.x, p.y - rect.y0, rect.y1 - p.y);
      return Math.hypot(Math.max(rect.x0 - p.x, 0, p.x - rect.x1), Math.max(rect.y0 - p.y, 0, p.y - rect.y1));
    };
    const panelRect = (engine, camera) => { // exactly holo-screen.update()'s placement/orientation, one source (SCREEN_OFFSET)
      const hips = engine.rig.hipsNode.getWorldPosition(new THREE.Vector3());
      const head = engine.rig.nodes.head.getWorldPosition(new THREE.Vector3());
      const centre = hips.clone().add(new THREE.Vector3(...SCREEN_OFFSET).multiplyScalar(FLOAT.scale).applyQuaternion(engine.vrm.scene.quaternion));
      const obj = new THREE.Object3D();
      obj.position.copy(centre); obj.lookAt(head.clone().add(camera.position).multiplyScalar(0.5)); obj.updateMatrixWorld(true);
      const pw = 0.42 * FLOAT.scale, ph = 0.26 * FLOAT.scale;
      const proj = [[-pw / 2, -ph / 2], [pw / 2, -ph / 2], [pw / 2, ph / 2], [-pw / 2, ph / 2]]
        .map(([dx, dy]) => { const p = obj.localToWorld(new THREE.Vector3(dx, dy, 0)); return ndc(camera, p.x, p.y, p.z); });
      return { x0: Math.min(...proj.map((p) => p.x)), x1: Math.max(...proj.map((p) => p.x)), y0: Math.min(...proj.map((p) => p.y)), y1: Math.max(...proj.map((p) => p.y)) };
    };
    // Drives the REAL engine + rig through one gesture on the style's own hover height, returning the worst (closest)
    // distance of either wrist and either forearm midpoint over the whole move (< 0 = that part was inside the panel)
    // and the max upperArm swing per side vs the first frame's arm-quiet pose (0.2.7: the float stretch must raise the
    // LEFT upper arm > 100 deg and leave the right at rest).
    // The HUD's own card groups (hud.css layout, via hudCardRect), as NDC boxes: the step-update cards on the LEFT
    // and the ask cards on the RIGHT, both styles. A group's bounding box over-reports (it contains the panels), so
    // this is the conservative form clearance.js uses. Measured per frame with the live wrists + forearms.
    const hudRects = ['a', 'b'].flatMap((st) => ['left', 'right'].map((side) => {
      const r = hudCardRect(side, { left: 0, top: 0, width: 1204, height: 689 }, st);
      return { id: `hud-${st}-${side}`, x0: (r.left / 1204) * 2 - 1, x1: ((r.left + r.width) / 1204) * 2 - 1, y0: 1 - ((r.top + r.height) / 689) * 2, y1: 1 - (r.top / 689) * 2 };
    }));
    const sweep = (g, style, holo) => {
      const soleY = HOLO_STYLES[style].soleY;
      vrm.scene.position.set(seat.pos[0], 0, seat.pos[2] + FLOAT.z);
      vrm.scene.quaternion.identity();
      vrm.scene.scale.setScalar(FLOAT.scale);
      vrm.scene.updateMatrixWorld(true);
      const catalog = loadCatalog(random);
      const engine = new ReflexEngine({ catalog, clips: new ClipLayer(), random });
      engine.bind(vrm, camera);
      engine.rig.seated = false; // float mode (float-mode.js's enter()): no seated base arm pose
      engine.rig.hipsPos = new THREE.Vector3(seat.pos[0], soleY + HIP_FRAC * STATURE * FLOAT.scale, seat.pos[2] + FLOAT.z);
      engine.player = new GesturePlayer({ random, clipAvailable: () => false, now: () => clock.t });
      engine.player.onFollow = (f) => { engine.follow = { ...f }; };
      engine.setHoloPanel(holo);
      catalog.forceNext(g.trigger, g.variant);
      clock.t = 0;
      engine.trigger(g.trigger);
      let worst = Infinity;
      let hudWorst = Infinity;
      const upper = { left: 0, right: 0 };
      const rest = {};
      for (let ms = 0; ms <= 3000; ms += 40) {
        clock.t = ms;
        engine.update(0.04);
        if (ms === 0) for (const side of ['left', 'right']) rest[side] = engine.rig.nodes[`${side}UpperArm`].quaternion.clone();
        for (const side of ['left', 'right']) upper[side] = Math.max(upper[side], engine.rig.nodes[`${side}UpperArm`].quaternion.angleTo(rest[side]) * 180 / Math.PI);
        const rect = panelRect(engine, camera);
        for (const side of ['left', 'right']) {
          const hand = engine.rig.nodes[`${side}Hand`].getWorldPosition(new THREE.Vector3());
          const elbow = engine.rig.nodes[`${side}LowerArm`].getWorldPosition(new THREE.Vector3());
          const forearm = hand.clone().add(elbow).multiplyScalar(0.5);
          const hp = ndc(camera, hand.x, hand.y, hand.z), fp = ndc(camera, forearm.x, forearm.y, forearm.z);
          worst = Math.min(worst, rectDist(rect, hp), rectDist(rect, fp));
          for (const r of hudRects) hudWorst = Math.min(hudWorst, rectDist(r, hp), rectDist(r, fp));
        }
      }
      engine.player.stopAll(true);
      return { worst, upper, hudWorst };
    };
    const stretch = panelGestures.find((g) => g.variant === 'stretch');
    const wave = panelGestures.find((g) => g.trigger === 'focus' && g.variant === 'wave');
    for (const style of Object.keys(HOLO_STYLES)) {
      for (const g of panelGestures) {
        const { worst } = sweep(g, style, true);
        ok(worst >= MARGIN, `11b ${style} ${g.trigger}/${g.variant}: float wrists + forearms stay >= ${MARGIN} NDC outside the panel rect (worst ${worst.toFixed(3)})`, worst);
      }
      // 0.2.7 (DIAG §5 row 4): the float stretch is not a cancelled gesture -- the left (panel-far) arm is overhead.
      const floatStretch = sweep(stretch, style, true);
      ok(floatStretch.upper.left > 100 && floatStretch.upper.right <= 5,
        `11b ${style}: float stretch -- LEFT upperArm ${floatStretch.upper.left.toFixed(1)} deg (> 100), right ${floatStretch.upper.right.toFixed(1)} deg (<= 5)`, floatStretch.upper);
      const seated = sweep(stretch, style, false); // the clamp bypassed on purpose: the untouched stretch MUST pierce the panel
      ok(seated.worst < 0, `11b ${style}: seated (no panel) the untouched stretch DOES enter the panel rect (${seated.worst.toFixed(3)} NDC) -- the hazard the float clamp removes`, seated.worst);
      const seatedWave = sweep(wave, style, false); // the right-hand wave is the r2 finding: with the mirror removed 11b fails above
      ok(seatedWave.worst < 0, `11b ${style}: seated the untouched right-hand 'wave' DOES enter the panel rect (${seatedWave.worst.toFixed(3)} NDC) -- the hazard the mirror removes`, seatedWave.worst);
      // T-31 0.2.7 step 5 re-measure (DIAG 21-10 finding 3 + nit 3): the float board reactions that the HUD can pick
      // -- a screen-right card (left point-up) and a screen-left card (the panel-far hand small wave) -- keep their
      // wrists AND forearms out of BOTH HUD card groups, i.e. the probe report's "0 panel hits" is reproducible.
      const boardRight = panelGestures.find((g) => g.variant === 'card-point-blocked');
      const boardLeft = panelGestures.find((g) => g.variant === 'card-nod-wave-blocked');
      const hudRight = sweep(boardRight, style, true), hudLeft = sweep(boardLeft, style, true);
      ok(hudRight.hudWorst >= MARGIN && hudLeft.hudWorst >= MARGIN,
        `11b ${style} HUD cards: the float board reactions (right-card left point, left-card left wave) stay >= ${MARGIN} NDC outside both HUD card groups (worst ${Math.min(hudRight.hudWorst, hudLeft.hudWorst).toFixed(3)})`,
        { right: hudRight.hudWorst, left: hudLeft.hudWorst });
    }
  }
}

console.log(`\ncheck:float-holo ${pass}/${pass + fail} passed`);
process.exitCode = fail ? 1 : 0;
