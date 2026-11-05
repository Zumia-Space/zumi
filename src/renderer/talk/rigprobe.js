// RigProbe: plays a GestureCommand on a hidden second copy of the loaded VRM (never added to the scene, never rendered)
// through the real player + pose code, frame by frame on a fake 30 Hz clock, and measures the rig rules every speech
// gesture must pass before it can play or be cached:
//   R1 no face-crossing   elbow->hand-tip stays outside the measured head ellipsoid (+5 cm for non-contact hands;
//                         face-contact hands: the forearm only, the hand may touch)
//   R2 no path through    forearm + wrist never go inside the torso core (elliptic cylinder from this model's measured
//                         chest, hips joint to chest top), and a non-face reach never passes in front of the face
//   R3 joint sanity       elbow flexion <= 155 deg; no sleeve flip: upper-arm twist about its own axis <= 75 deg per
//                         33 ms frame (a flip is a ~120-180 deg jump; the owner-approved seeds measure up to ~58)
//   R4 feet planted       foot drift <= 1 cm while the hips are not raised (a jump may lift the feet)
//   R5 returns to idle    pose signature back near idle 800 ms after the command ends
//   R6 length             1.5–3.5 s (also checked by the validator)
import * as THREE from 'three';
import { ReflexEngine, ClipLayer } from '../reflex/index.js';
import { GesturePlayer } from '../reflex/player.js';
import { rigMargins } from './rigmargins.js';

const FPS = 30;
const FACE = new Set(['chin', 'mouth', 'face', 'eye']);
const V = () => new THREE.Vector3();
// Torso core of THIS model, as two elliptic bands in the chest frame, so only a real pass THROUGH the body counts (a palm
// on the chest or hip, clasped hands in front of the belly, an elbow against the side stay outside):
//   chest band  armpit level down to the bottom of the chest box: centre + radii of the chest box the rig measures on
//               the chest-weighted vertices, shrunk (a big anime chest makes the box deep);
//   waist band  chest box bottom down to the hips joint: the chest band narrowed again (the waist is slimmer).
// Calibrated 01-10 on zumi-v3 with scripts/check-rig.mjs: every owner-approved seed stays outside, an arm cut through
// the body (the self-test fixture) is caught.
const SHRINK = { x: 0.8, z: 0.6, waist: 0.75 };
export function measureCore(rig) {
  const bx = rig.surf && rig.surf.chestBox;
  if (!bx || !rig.nodes.hips) return null;
  rig.vrm.scene.updateMatrixWorld(true);
  const inv = rig.frame(rig.chestNode).invert();
  const hipsY = rig.nodes.hips.getWorldPosition(V()).applyMatrix4(inv).y;
  const arm = rig.arms.left || rig.arms.right;
  const shoulderY = arm ? arm.upper.getWorldPosition(V()).applyMatrix4(inv).y : bx.max.y;
  const chest = { y0: bx.min.y, y1: Math.min(bx.max.y, shoulderY - 0.04), cx: (bx.min.x + bx.max.x) / 2, cz: (bx.min.z + bx.max.z) / 2,
    rx: SHRINK.x * (bx.max.x - bx.min.x) / 2, rz: SHRINK.z * (bx.max.z - bx.min.z) / 2 };
  const waist = { ...chest, y0: hipsY, y1: bx.min.y, rx: chest.rx * SHRINK.waist, rz: chest.rz * SHRINK.waist };
  return { chest, waist };
}
export const coreF = (k, lc) => {
  const b = lc.y >= k.chest.y0 && lc.y <= k.chest.y1 ? k.chest : lc.y >= k.waist.y0 && lc.y < k.waist.y1 ? k.waist : null;
  return b ? Math.hypot((lc.x - b.cx) / b.rx, (lc.z - b.cz) / b.rz) : Infinity;
};
// points checked along the arm: the upper arm from 40 % out (its root sits in the shoulder, inside by construction),
// the elbow, and the forearm to the wrist
const ARM_SAMPLES = [['upper', 0.4], ['upper', 0.6], ['upper', 0.8], ['fore', 0], ['fore', 0.25], ['fore', 0.5], ['fore', 0.75], ['fore', 1]];

export class RigProbe {
  // loader: the app's GLTFLoader with the VRM plugin; bytes: the model file; stageCamera: copied once (same framing).
  static async create({ loader, bytes, stageCamera, catalog, prepare }) {
    const gltf = await loader.parseAsync(bytes.slice(0), '');
    const vrm = gltf.userData.vrm;
    if (!vrm) throw new Error('probe: not a VRM');
    if (prepare) prepare(gltf, vrm);
    const cam = stageCamera.clone();
    return new RigProbe(vrm, cam, catalog);
  }

  constructor(vrm, camera, catalog) {
    this.vrm = vrm;
    this.clock = 1e6;
    this.engine = new ReflexEngine({ catalog, clips: new ClipLayer(), random: () => 0.5 });
    this.engine.bind(vrm, camera);
    this.engine.setLifeEnabled(false);
    this.engine.autoIdle = false;
    this.engine.player = new GesturePlayer({ now: () => this.clock, random: () => 0.5, clipAvailable: () => false });
    this.engine.player.onFollow = (f) => { this.engine.follow = { ...f }; };
    this.engine.pointer.at = this.clock;
    this.rig = this.engine.rig;
    this.idleSig = null;
    this.core = measureCore(this.rig);
  }

  step(dt) {
    const e = this.engine;
    this.clock += dt * 1000;
    e.pointer.at = this.clock; // the probe's "cursor" never wanders
    const acc = e.acc;
    acc.reset();
    e.player.evaluate(acc, this.clock);
    e.gazeLayer(acc, this.clock, dt);
    e.applyPose(acc, dt);
    this.vrm.scene.updateMatrixWorld(true);
    return acc;
  }

  settle(n = 20) { for (let i = 0; i < n; i++) this.step(1 / FPS); return this.engine.signature(); }

  // cmd: a command that already passed checkSpeechGesture. flip: play mirrored (point to the other side).
  check(cmd, { flip = false } = {}) {
    const t0 = performance.now();
    const e = this.engine, rig = this.rig, S = rig.surf;
    e.player.stopAll(true);
    rig.routes.clear();
    const idleSig = this.settle(25);
    const footRest = Object.values(rig.legs).map((l) => l.foot.getWorldPosition(V()));
    const res = e.player.play(flip ? { ...cmd, mirror: 'random' } : cmd, { noJitter: true, side: flip ? -1 : 1 });
    if (!res.ok) return { ok: false, fails: ['does not play'], errors: res.errors };
    const inst = e.player.find(res.id);
    const durationMs = e.player.duration(inst);
    const r = { R1: { ok: true, minF: Infinity }, R2: { ok: true, hits: [] }, R3: { ok: true, maxFlexDeg: 0, maxTwistDeg: 0 }, R4: { ok: true, maxDriftM: 0 }, R5: { ok: true, delta: 0 }, R6: { ok: durationMs >= 1500 && durationMs <= 3500, durationMs } };
    const prevQ = {};
    const dt = 1 / FPS;
    const headInv = new THREE.Matrix4(), chestInv = new THREE.Matrix4();
    const frames = Math.ceil((durationMs + 800) / (1000 / FPS));
    for (let f = 0; f < frames; f++) {
      const acc = this.step(dt);
      const tMs = Math.round(e.player.localTime(inst, this.clock) || (f * 1000) / FPS);
      if (S) {
        rig.frame(rig.nodes.head, headInv).invert();
        rig.frame(rig.chestNode, chestInv).invert();
      }
      for (const side of ['left', 'right']) {
        const arm = rig.arms[side];
        if (!arm) continue;
        const sh = arm.upper.getWorldPosition(V()), el = arm.lower.getWorldPosition(V()), wr = arm.hand.getWorldPosition(V());
        const reqs = acc.reach.filter((q) => q.hand === side && q.weight > 0.05);
        const contact = reqs.some((q) => typeof q.target === 'string' && FACE.has(q.target) && q.weight > 0.5);
        const faceTarget = reqs.some((q) => typeof q.target === 'string' && FACE.has(q.target));
        // R3: elbow flexion and twist flips
        const u1 = V().subVectors(el, sh).normalize(), u2 = V().subVectors(wr, el).normalize();
        const flex = (Math.acos(Math.max(-1, Math.min(1, u1.dot(u2)))) * 180) / Math.PI;
        r.R3.maxFlexDeg = Math.max(r.R3.maxFlexDeg, flex);
        // twist = rotation of the upper arm about its own axis (normalized bones: the local X axis runs along the arm)
        const q = arm.upper.quaternion.clone();
        if (prevQ[side]) {
          const d = prevQ[side].clone().invert().multiply(q);
          const tw = (2 * Math.atan2(Math.abs(d.x), Math.abs(d.w)) * 180) / Math.PI;
          if (tw > r.R3.maxTwistDeg) { r.R3.maxTwistDeg = tw; r.R3.twistAt = { side, tMs, flexDeg: +flex.toFixed(1) }; }
        }
        prevQ[side] = q;
        if (!S) continue;
        // R1: forearm (+ hand for non-contact) vs the head ellipsoid
        const { ellC: c } = S.head;
        const rad = S.head.ellR.clone().addScalar(contact ? 0 : 0.05);
        const tip = wr.clone().addScaledVector(V().subVectors(wr, el).normalize(), contact ? 0 : arm.handLen);
        const n = contact ? 5 : 8;
        for (let i = 0; i <= n; i++) {
          const p = i <= 5 ? V().lerpVectors(el, wr, i / 5) : V().lerpVectors(wr, tip, (i - 5) / 3);
          const l = p.applyMatrix4(headInv);
          const fv = Math.hypot((l.x - c.x) / rad.x, (l.y - c.y) / rad.y, (l.z - c.z) / rad.z);
          if (fv < r.R1.minF) r.R1.minF = fv;
          if (fv < 0.97 && r.R1.ok) { r.R1.ok = false; r.R1.at = { side, tMs, f: +fv.toFixed(3) }; }
        }
        // R2: upper arm, elbow, forearm or wrist inside the torso core
        const k = this.core;
        if (k) for (const [seg, t] of ARM_SAMPLES) {
          const lc = (seg === 'upper' ? V().lerpVectors(sh, el, t) : V().lerpVectors(el, wr, t)).applyMatrix4(chestInv);
          const f = coreF(k, lc);
          if (f === Infinity) continue;
          const at = seg === 'upper' ? 'upper arm' : t === 0 ? 'elbow' : t === 1 ? 'wrist' : 'forearm';
          if (!r.R2.deepest || f < r.R2.deepest.f) r.R2.deepest = { side, tMs, f: +f.toFixed(3), at, y: +lc.y.toFixed(3), z: +lc.z.toFixed(3) };
          if (f < 1) {
            if (r.R2.hits.length < 5) r.R2.hits.push({ side, tMs, zone: 'torso', at, f: +f.toFixed(3) });
            break;
          }
        }
        if (!faceTarget) {
          const lh = wr.clone().applyMatrix4(headInv), R = S.head.ellR;
          const front = Math.abs(lh.x - c.x) < R.x * 0.9 && Math.abs(lh.y - c.y) < R.y * 0.9 && lh.z > c.z + 0.3 * R.z && lh.z < c.z + R.z + 0.25;
          if (front && r.R2.hits.length < 5) r.R2.hits.push({ side, tMs, zone: 'front of face' });
        }
      }
      // R4: feet stay planted unless the hips are raised (a jump)
      if (acc.rootActive && acc.root[1] <= 0) {
        Object.values(rig.legs).forEach((l, i) => { r.R4.maxDriftM = Math.max(r.R4.maxDriftM, l.foot.getWorldPosition(V()).distanceTo(footRest[i])); });
      }
    }
    r.R2.ok = r.R2.hits.length === 0;
    r.R3.ok = r.R3.maxFlexDeg <= 155 && r.R3.maxTwistDeg <= 75;
    r.R4.ok = r.R4.maxDriftM <= 0.01;
    r.R5.delta = ReflexEngine.signatureDelta(e.signature(), idleSig);
    r.R5.ok = r.R5.delta <= 0.03;
    e.player.stopAll(true);
    rig.routes.clear();
    for (const k of Object.keys(r)) for (const f of ['minF', 'maxFlexDeg', 'maxTwistDeg', 'maxDriftM', 'delta']) if (typeof r[k][f] === 'number') r[k][f] = +r[k][f].toFixed(4);
    const fails = Object.entries(r).filter(([, v]) => !v.ok).map(([k]) => k);
    const { margins, warnings } = rigMargins(r);
    return { ok: fails.length === 0, fails, rules: r, margins, warnings, durationMs, ms: +(performance.now() - t0).toFixed(1), surfaces: Boolean(S) };
  }
}
