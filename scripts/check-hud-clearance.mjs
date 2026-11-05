// HUD clearance probe (T-31 0.2.7 step 5 re-measure, DIAG 21-10 nit 3): hud/clearance.js had no runnable check, so
// the row-5 "0 panel hits" was never reproduced. This drives the REAL clearance.js probe (armScreenPoints ->
// armPanelHits -> panelRects) against the HUD's own card layout (hud.css via hudCardRect), plain Node, no Electron:
//   1. layout       the step-update group is on the LEFT, the ask group on the RIGHT, both styles;
//   2. probe        a synthetic wrist inside a group's rect is reported (with the panel id), a clear one is not;
//   3. reactions    the float board reaction picks the panel-far (left) hand only: screen-right card -> left point-up,
//                   screen-left card -> left small wave; seated screen-left card -> the right point (no panel up).
// The REAL-rig wrist/forearm sweep of those two float commands against the same HUD rects is check-float-holo §11b
// ("HUD cards ... >= 0.05 NDC outside both HUD card groups").
//   node scripts/check-hud-clearance.mjs   (npm run check:hud-clearance)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { armScreenPoints, armPanelHits, panelRects } from '../src/renderer/hud/clearance.js';
import { hudCardRect, rectToNdc, stateToVariant, CARD_ARM_VARIANTS, CARD_ARM_LEFT_VARIANTS, CARD_FLOAT_LEFT_VARIANTS } from '../src/renderer/hud/hud-logic.js';
import { HOLO_RAISED_REACH } from '../src/renderer/reflex/engine.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (cond, msg, detail) => { if (cond) pass++; else fail++; console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}${!cond && detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`); };
const stage = { left: 0, top: 0, width: 1204, height: 689 }; // the harness stage viewport

// ---------- 1. the HUD layout: updates left, asks right, both styles ----------
const rects = {};
for (const style of ['a', 'b']) {
  const left = hudCardRect('left', stage, style), right = hudCardRect('right', stage, style);
  rects[style] = { left, right };
  ok(rectToNdc(left, stage).x < 0 && rectToNdc(right, stage).x > 0,
    `layout ${style}: the step-update cards are the LEFT group (x=${rectToNdc(left, stage).x.toFixed(3)}), the asks the RIGHT (x=${rectToNdc(right, stage).x.toFixed(3)})`);
}

// ---------- 2. the probe itself: a synthetic arm, real clearance.js ----------
// A minimal DOM stand-in: two panel elements placed exactly where hud.css puts the groups. panelRects() reads
// getClientRects/getBoundingClientRect/closest and the group opacity, so a yielded group can be tested too.
const makePanel = (id, r, group) => ({
  id, className: 'hud-panel', hidden: false,
  getClientRects: () => [{}],
  getBoundingClientRect: () => ({ left: r.left, top: r.top, right: r.left + r.width, bottom: r.top + r.height, width: r.width, height: r.height }),
  closest: (sel) => (sel === '.hud-group' ? group : null),
});
const groups = { left: { opacity: '1' }, right: { opacity: '1' } };
const root = {
  hidden: false,
  querySelectorAll: () => [makePanel('hud-updates', rects.a.left, groups.left), makePanel('hud-asks', rects.a.right, groups.right)],
};
globalThis.getComputedStyle = (el) => ({ opacity: el && el.opacity ? el.opacity : '1' });
ok(panelRects(root).length === 2 && panelRects(root).map((p) => p.id).join() === 'hud-updates,hud-asks', 'probe: both card groups are visible panels', panelRects(root));
groups.left.opacity = '0'; // arm-yield fade: the group is not on screen
ok(panelRects(root).length === 1 && panelRects(root)[0].id === 'hud-asks', 'probe: a yielded (opacity 0) group is not counted (clearance.js rule)');
groups.left.opacity = '1';

const camera = new THREE.PerspectiveCamera(50, stage.width / stage.height, 0.1, 10);
camera.position.set(0, 0, 3);
camera.lookAt(0, 0, 0);
camera.updateMatrixWorld(true);
const ndcVec = (x, y) => new THREE.Vector3(x, y, 0.5).unproject(camera);
const canvas = { getBoundingClientRect: () => ({ left: stage.left, top: stage.top, width: stage.width, height: stage.height }) };
const fakeEngine = (p) => {
  const bone = { getWorldPosition: (v) => v.copy(p) };
  const names = ['rightUpperArm', 'rightLowerArm', 'rightHand', 'rightMiddleIntermediate', 'rightMiddleDistal', 'leftUpperArm', 'leftLowerArm', 'leftHand', 'leftMiddleIntermediate', 'leftMiddleDistal'];
  return { camera, vrm: { scene: { updateMatrixWorld() {} }, humanoid: { getRawBoneNode: (n) => (names.includes(n) ? bone : null) } } };
};
// NDC centre of the left group: its rect centre is inside the panel, so a wrist there must be reported.
const leftCentre = rectToNdc(rects.a.left, stage);
const inside = armPanelHits(fakeEngine(ndcVec(leftCentre.x, leftCentre.y)), canvas, root, 0);
ok(inside.length > 0 && inside.every((h) => h.panel === 'hud-updates'), `probe: a wrist inside the LEFT card group is reported against hud-updates (${inside.length} samples)`, inside.slice(0, 2));
const rightCentre = rectToNdc(rects.a.right, stage);
const insideRight = armPanelHits(fakeEngine(ndcVec(rightCentre.x, rightCentre.y)), canvas, root, 0);
ok(insideRight.length > 0 && insideRight.every((h) => h.panel === 'hud-asks'), `probe: a wrist inside the RIGHT card group is reported against hud-asks (${insideRight.length} samples)`, insideRight.slice(0, 2));
// Between the groups (centre stage) is clear.
const clear = armPanelHits(fakeEngine(ndcVec(0, -0.2)), canvas, root, 0);
ok(clear.length === 0, 'probe: a wrist on the centre stage is not reported (the probe is not over-reporting everything)', clear);
ok(armScreenPoints(fakeEngine(ndcVec(0, 0)), canvas).length === 2 * (4 * 7 + 1), 'probe: armScreenPoints samples both 4-segment chains (7 points each) plus a finger tip per side');

// ---------- 3. the float board reaction uses only the panel-far hand ----------
const board = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'reflex', 'gestures', 'board.json'), 'utf8'));
const command = (id) => board.variants.find((v) => v.id === id).command;
const leftCard = rectToNdc(rects.a.left, stage), rightCard = rectToNdc(rects.a.right, stage);
const floatLeft = stateToVariant('blocked', leftCard, { float: true });
const floatLeftCmd = command(floatLeft), floatRightCmd = command(stateToVariant('blocked', rightCard, { float: true }));
const reaches = (cmd) => (cmd.reach || []).map((r) => `${r.hand}:${r.target}`);
ok(floatLeft === CARD_FLOAT_LEFT_VARIANTS.blocked && reaches(floatLeftCmd).join() === 'left:wave-small',
  'reaction: a REAL float left card plays the other hand small wave (never a reach on the panel-side right hand)', { variant: floatLeft, reach: reaches(floatLeftCmd) });
ok(reaches(floatRightCmd).join() === 'left:point-up', 'reaction: a REAL float right card points with the left (panel-far) hand', reaches(floatRightCmd));
ok(reaches(floatLeftCmd).every((r) => r.startsWith('left:')) && reaches(floatRightCmd).every((r) => r.startsWith('left:')),
  'reaction: neither float board reaction raises a hand on the panel side');
ok(reaches(floatLeftCmd).some((r) => HOLO_RAISED_REACH.includes(r.split(':')[1])) && reaches(floatRightCmd).some((r) => HOLO_RAISED_REACH.includes(r.split(':')[1])),
  'reaction: the float reaches are on the engine panel-safe raised list (HOLO_RAISED_REACH), so the clamp leaves them on the left hand');
// Seated has no panel: the same left card uses the hand on its side (her right).
const seatedLeft = stateToVariant('blocked', leftCard);
ok(seatedLeft === CARD_ARM_LEFT_VARIANTS.blocked && reaches(command(seatedLeft)).join() === 'right:point-up' && stateToVariant('blocked', rightCard) === CARD_ARM_VARIANTS.blocked,
  'reaction: seated picks the hand on the card side (left card -> right point, right card -> left point)', { seatedLeft, seatedRight: stateToVariant('blocked', rightCard) });

console.log(`\ncheck:hud-clearance ${pass}/${pass + fail} passed`);
process.exitCode = fail ? 1 : 0;
