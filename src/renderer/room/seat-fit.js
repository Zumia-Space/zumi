// SeatFit (T-31 chair fix): a per-frame post-pass, run after engine.update() and the
// CameraDirector, before render. It makes the seated body agree with the PAINTED chair and desk of the active view:
//   1. hips: the thigh underside rests on the painted seat top (seat_top occluder height), never below it;
//   2. legs: two-bone IK from the hip joints -- thigh along the seat, knee just past the seat's front edge, shin
//      down to a flat foot ON the floor, in front of the seat (not under it, not through its front);
//   3. hands (views with a painted keyboard): the torso leans just enough, the arms reach, and the fingertips land
//      on the painted key tops (keyboard corners authored in plate pixels, unprojected with the view's own camera);
//   4. an optional right-hand reach toward a world point (the hologram "touch" gesture), blended over (3).
// Why a post-pass and not a new clip: the chair height, seat depth and keyboard distance differ per painted view
// (views are separate paintings, room.json coordinateSystem) and per model scale (work 1.08, room 1.15) -- one
// baked clip cannot fit all three; measured before this existed: thighs 8 cm into the cushion (work), shins under
// the seat over the chair base (room), hands 20+ cm short of the keys (work).
// Never awaits I/O, never calls engine.trigger()/play() (same latency contract as CameraDirector).
import * as THREE from 'three';
import { bodyOrientation } from '../model-facing.js';
import { rootedBasis } from '../reflex/rig.js';

const DEG = Math.PI / 180;
const V = () => new THREE.Vector3();
const Q = () => new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);

// Painted keyboard corners per plate, in that plate's own pixels (1920x1200), read off the plates by hand
// (concept data -- would become room.json views.<v>.keyboard). Key tops sit KEY_TOP_Y above the floor.
const KEYBOARD_PX = {
  'B-work-plate.png': { farL: [1320.8, 580], nearL: [1310.8, 604.6], farR: [1576.2, 635.4], nearR: [1570.8, 667.7] },
  'B-room-plate.png': { farL: [1588, 495.2], nearL: [1572, 506], farR: [1731.2, 507.2], nearR: [1726, 524.8] },
};
const KEY_TOP_Y = 0.76;
const CHAIR = {
  halfWidth: 0.25, // seat half width (m) -- the painted seat_top polygons are inflated toward the camera by the cushion's side face, so only height + front extent are read from them
  backFwd: -0.20, // backrest front surface, m along the seat facing from the column (room view backrest occluder: -0.16..-0.26)
  cushion: 0.09, // cushion + pan thickness below the seat top (m)
};
// Per-view fit to the PAINTED chair (T-31 work-chair fix, 09-10; numbers measured on the skinned mesh, harness in
// the 09-10 chair work notes). hipFwd: hip-joint midpoint along the seat facing from the column
// (absent = room.json's authored spot). typing: default hands-on-keys weight (the lean that makes the keys
// reachable is capped at 30 deg). keyRow: fingertip row in keyboard depths from its centre (- = toward her). armExt: max wrist reach as a fraction of
// the arm (unset = full extension).
// talk: +0.06 m puts the hip over the painted seat (its silhouette starts 0.04 m ahead of the column; at 0 the
//   buttocks sat in the painted backrest). The front camera sees this as a 3 % size change; the head row stays.
// work: she sits IN the painted chair -- buttocks against the backrest (rearmost pelvis vertex -0.17 m vs the painted
//   backrest front -0.16), lower back on it -- and leans 30 deg toward the painted keyboard, which sits 0.69 m ahead
//   of the column. At +0.12 m (5aa6b41) her hands were on the keys but the painted chair stood empty behind her. From
//   the backrest her fingertips stop 2-9 cm short of the keys' front edge: armExt keeps a soft ~150 deg elbow there
//   instead of locked 175 deg arms.
// room: the desk edge is 0.066 m ahead of the column (the painted chair is tucked under the desk), so hands in the lap
//   put both forearms through the desktop slab; her hands rest on the painted keys instead (reachable with no lean).
//   -0.04 m is as far back as the painted seat silhouette allows (hip2D); her belly still meets the desk edge there.
const VIEW_FIT = {
  talk: { hipFwd: 0.06 },
  work: { hipFwd: -0.05, typing: 1, keyRow: -0.4, armExt: 0.97 },
  room: { hipFwd: -0.04, typing: 1, keyRow: -0.4, armExt: 0.97 },
};
const FOOT_CLEAR = 0.02; // toe tip to the nearest floor-standing desk part ahead of the seat (pc tower, drawer pedestal, kneehole panel), m
const TYPE_CURL = { index: [28, 34, 22], middle: [30, 36, 22], ring: [32, 38, 22], little: [34, 40, 22] };
const POINT_CURL = { index: [4, 4, 2], middle: [70, 80, 40], ring: [74, 84, 40], little: [78, 86, 40] };
const FINGERS = { index: ['IndexProximal', 'IndexIntermediate', 'IndexDistal'], middle: ['MiddleProximal', 'MiddleIntermediate', 'MiddleDistal'], ring: ['RingProximal', 'RingIntermediate', 'RingDistal'], little: ['LittleProximal', 'LittleIntermediate', 'LittleDistal'] };
const smooth = (cur, target, dt, tau) => cur + (target - cur) * (1 - Math.exp(-Math.max(dt, 0) / tau));
const ease = (k) => (k <= 0 ? 0 : k >= 1 ? 1 : k * k * (3 - 2 * k));

function unproject(cam, u, v, y) {
  const p = new THREE.Vector3(...cam.pos), t = new THREE.Vector3(...cam.target);
  const F = t.clone().sub(p).normalize();
  const R = new THREE.Vector3().crossVectors(F, UP).normalize();
  const U = new THREE.Vector3().crossVectors(R, F);
  const d = R.multiplyScalar((u - cam.principalPointPx[0]) / cam.focalPx).add(U.multiplyScalar(-(v - cam.principalPointPx[1]) / cam.focalPx)).add(F);
  return p.addScaledVector(d, (y - p.y) / d.y);
}

export { CHAIR, VIEW_FIT };

export class SeatFit {
  constructor({ engine }) {
    this.engine = engine;
    this.views = {}; // name -> { seatTopY, frontFwd, keys }
    this.chairFit = {}; // name -> setChairFit() data: a real 3D chair replaces that view's painted seat numbers
    this.model = null; // measureModel() result for the bound model
    // hands-on-keys weight per view (VIEW_FIT.typing; 0 = the engine's own seated hands-in-lap rest, see setTyping())
    this.typing = Object.fromEntries(Object.entries(VIEW_FIT).map(([v, f]) => [v, f.typing || 0]));
    this.reach = null; // { point: Vector3, weight } -- right hand
    this.lean = 0;
    this.last = null; // diagnostics of the last frame (read by the harness checks)
  }

  /** @param json the raw room.json (v2). Reads each view's seat_top height/front extent and the keyboard corners. */
  setRoomJson(json) {
    this.views = {};
    if (!json || !json.views) return;
    for (const [name, v] of Object.entries(json.views)) {
      if (!v || !v.zumi_seat) continue;
      const seatOcc = (v.occluders || []).find((o) => o.name === 'seat_top' && o.geometry && o.geometry.points);
      const th = v.zumi_seat.rotYDeg * DEG, fx = Math.sin(th), fz = Math.cos(th);
      const seatTopY = seatOcc ? Math.max(...seatOcc.geometry.points.map((p) => p[1])) : 0.45;
      const frontFwd = seatOcc ? Math.max(...seatOcc.geometry.points.map((p) => p[0] * fx + p[2] * fz)) : 0.25;
      const px = KEYBOARD_PX[v.plate];
      let keys = null;
      if (px && v.camera && v.camera.focalPx) {
        const c = {}; for (const k of Object.keys(px)) c[k] = unproject(v.camera, px[k][0], px[k][1], KEY_TOP_Y);
        const center = V().add(c.farL).add(c.nearL).add(c.farR).add(c.nearR).multiplyScalar(0.25);
        const lr = V().addVectors(c.farR, c.nearR).sub(V().addVectors(c.farL, c.nearL)).multiplyScalar(0.5);
        const depth = V().addVectors(c.farL, c.farR).sub(V().addVectors(c.nearL, c.nearR)).multiplyScalar(0.5);
        keys = { corners: c, center, lr: lr.clone().normalize(), depth: depth.clone().normalize(), lenLR: lr.length(), lenDepth: depth.length(), y: KEY_TOP_Y };
      }
      // floor-standing desk parts ahead of the seat (box/quad occluders reaching the floor), as fwd/lat extents in the
      // seat frame: the feet stop FOOT_CLEAR short of them (work: the PC tower is 0.66 m ahead, across her left foot)
      const obstacles = [];
      for (const o of v.occluders || []) {
        const g = o.geometry, pts = g && (g.vertices || g.corners);
        if (!pts || !pts.length || Math.min(...pts.map((p) => p[1])) > 0.05) continue;
        const fw = pts.map((p) => p[0] * fx + p[2] * fz), la = pts.map((p) => p[0] * fz - p[2] * fx);
        if (Math.max(...fw) <= frontFwd) continue;
        obstacles.push({ name: o.name, fwd: Math.min(...fw), lat: [Math.min(...la), Math.max(...la)] });
      }
      this.views[name] = { seatTopY, frontFwd, keys, obstacles, facing: new THREE.Vector3(fx, 0, fz) };
    }
  }

  /** 3D chair (T-31 chair3d concept, chair3d.js): `fit` replaces the painted seat of `view`, or null restores it.
   *  fit = { chairFwd (the chair's own z = its backrest front, along the facing from the column), profile: [[fwd, topY]]
   *  (seat top along the centre line, in the chair's frame), frontFwd, reclineDeg }. The hip spot (VIEW_FIT.hipFwd)
   *  does not move -- the chair is slid to her (framing unchanged); only the height and the leg/back fit follow it. */
  setChairFit(view, fit) { if (fit) this.chairFit[view] = fit; else delete this.chairFit[view]; }

  /** Seat top under the hips (max over +-4 cm of `hipFwd`) and the thigh pitch (deg, + = knees down) that keeps the
   *  thigh underside on/above the chair's seat surface out to the knee. null when `view` has no chair fit. */
  chairSeat(view, hipFwd, undersideY, thighLen) {
    const cf = this.chairFit[view];
    if (!cf) return null;
    const pts = cf.profile.map(([z, y]) => [cf.chairFwd + z, y]);
    const under = pts.filter(([f]) => Math.abs(f - hipFwd) <= 0.04).map(([, y]) => y);
    const seatTopY = under.length ? Math.max(...under) : Math.max(...pts.map(([, y]) => y));
    if (undersideY == null) return { seatTopY, thighDeg: 3 };
    let up = -3 * DEG; // the painted chair's default: 3 deg down along the seat
    for (const [f, y] of pts) { const d = f - hipFwd; if (d > 0.04 && d <= thighLen) up = Math.max(up, Math.atan2(y + 0.004 - undersideY, d)); } // +4 mm over the seat surface
    return { seatTopY, thighDeg: -up / DEG };
  }

  /** Once per model bind, with vrm.scene at its "no anchor" placement (origin + the model's own base orientation,
   *  i.e. +Z-forward world for VRM 1.0 AND VRM 0.x after prepareVrm) and scale 1, normalized pose at rest. The
   *  caller is engine.bind() + measureHipOffsetXZ(), which restores exactly that placement after its identity
   *  probe (seat.js). The measurements below read world positions, so they must stay in that +Z-forward frame.
   *  Restores the rest pose afterwards. */
  measureModel(vrm) {
    const nb = (n) => vrm.humanoid.getNormalizedBoneNode(n);
    const wp = (n) => nb(n).getWorldPosition(V());
    const savedScale = vrm.scene.scale.x;
    vrm.scene.scale.setScalar(1); // a re-bind can arrive with the previous view's seat scale still applied
    vrm.scene.updateMatrixWorld(true);
    const hipL = wp('leftUpperLeg'), hipR = wp('rightUpperLeg');
    const knee = wp('leftLowerLeg'), ankle = wp('leftFoot');
    const L1 = hipL.distanceTo(knee), L2 = knee.distanceTo(ankle);
    const hipJointY = (hipL.y + hipR.y) / 2;
    // thigh underside with the thighs horizontal (the seated contact): skinned vertices of hips/upper legs
    const legs = [nb('leftUpperLeg'), nb('rightUpperLeg')];
    const qFwd = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -90 * DEG);
    for (const n of legs) n.quaternion.copy(qFwd);
    vrm.humanoid.update(); vrm.scene.updateMatrixWorld(true);
    const raw = new Set(['hips', 'leftUpperLeg', 'rightUpperLeg'].map((n) => vrm.humanoid.getRawBoneNode(n)).filter(Boolean));
    let minY = Infinity, minZ = Infinity;
    const p = V();
    vrm.scene.traverse((o) => {
      if (!o.isSkinnedMesh || !o.geometry.attributes.skinIndex) return;
      const idx = new Set(o.skeleton.bones.map((b, i) => (raw.has(b) ? i : -1)).filter((i) => i >= 0));
      if (!idx.size) return;
      const g = o.geometry, sI = g.attributes.skinIndex, sW = g.attributes.skinWeight;
      for (let i = 0; i < g.attributes.position.count; i++) {
        let b = 0; for (let k = 1; k < 4; k++) if (sW.getComponent(i, k) > sW.getComponent(i, b)) b = k;
        if (sW.getComponent(i, b) < 0.5 || !idx.has(sI.getComponent(i, b))) continue;
        o.getVertexPosition(i, p).applyMatrix4(o.matrixWorld);
        if (p.y < minY) minY = p.y;
        if (p.z < minZ) minZ = p.z;
      }
    });
    for (const n of legs) n.quaternion.identity();
    vrm.humanoid.update(); vrm.scene.updateMatrixWorld(true);
    // ankle joint -> toe tip along the foot (rest pose faces +Z): the feet stop this far short of a desk part
    const footRaw = new Set(['leftFoot', 'leftToes'].map((n) => vrm.humanoid.getRawBoneNode(n)).filter(Boolean));
    let toeZ = -Infinity;
    vrm.scene.traverse((o) => {
      if (!o.isSkinnedMesh || !o.geometry.attributes.skinIndex) return;
      const idx = new Set(o.skeleton.bones.map((b, i) => (footRaw.has(b) ? i : -1)).filter((i) => i >= 0));
      if (!idx.size) return;
      const g = o.geometry, sI = g.attributes.skinIndex, sW = g.attributes.skinWeight;
      for (let i = 0; i < g.attributes.position.count; i++) {
        let b = 0; for (let k = 1; k < 4; k++) if (sW.getComponent(i, k) > sW.getComponent(i, b)) b = k;
        if (sW.getComponent(i, b) < 0.5 || !idx.has(sI.getComponent(i, b))) continue;
        o.getVertexPosition(i, p).applyMatrix4(o.matrixWorld);
        if (p.z > toeZ) toeZ = p.z;
      }
    });
    // head + hair (every bone under the head, spring hair included): how far behind the hip joint and how high above it
    // they reach -- a 3D chair's headrest must stay behind this (seated torso = rest torso; sit-idle bends only legs/arms)
    const headRoot = vrm.humanoid.getRawBoneNode('head');
    const under = new Set(); if (headRoot) headRoot.traverse((b) => under.add(b));
    let hzMin = Infinity, hyMin = Infinity, hyMax = -Infinity;
    vrm.scene.traverse((o) => {
      if (!o.isSkinnedMesh || !o.geometry.attributes.skinIndex) return;
      const idx = new Set(o.skeleton.bones.map((b, i) => (under.has(b) ? i : -1)).filter((i) => i >= 0));
      if (!idx.size) return;
      const g = o.geometry, sI = g.attributes.skinIndex, sW = g.attributes.skinWeight;
      for (let i = 0; i < g.attributes.position.count; i++) {
        let b = 0; for (let k = 1; k < 4; k++) if (sW.getComponent(i, k) > sW.getComponent(i, b)) b = k;
        if (sW.getComponent(i, b) < 0.5 || !idx.has(sI.getComponent(i, b))) continue;
        o.getVertexPosition(i, p).applyMatrix4(o.matrixWorld);
        hzMin = Math.min(hzMin, p.z); hyMin = Math.min(hyMin, p.y); hyMax = Math.max(hyMax, p.y);
      }
    });
    const handLen = (side) => {
      const h = wp(`${side}Hand`), md = nb(`${side}MiddleDistal`), mi = nb(`${side}MiddleIntermediate`);
      if (!md || !mi) return 0.17;
      const d = md.getWorldPosition(V()), i = mi.getWorldPosition(V());
      return h.distanceTo(d) + d.distanceTo(i) * 0.75; // wrist -> fingertip (distal bone + ~3/4 of a phalanx)
    };
    vrm.scene.scale.setScalar(savedScale); vrm.scene.updateMatrixWorld(true);
    this.model = {
      L1, L2, hipJointY, ankleY: ankle.y,
      clearance: Number.isFinite(minY) ? hipJointY - minY : 0.08, // hip joint height above the thigh underside (m, scale 1)
      rearDepth: Number.isFinite(minZ) ? ((hipL.z + hipR.z) / 2) - minZ : 0.12, // hip joint ahead of the rearmost buttock (m, scale 1; a 3D chair's backrest goes there)
      head: Number.isFinite(hzMin) ? { rear: (hipL.z + hipR.z) / 2 - hzMin, low: hyMin - hipJointY, high: hyMax - hipJointY } : null, // head+hair box vs the hip joint (m, scale 1)
      toeLen: Number.isFinite(toeZ) ? toeZ - ankle.z : 0.16, // ankle joint -> toe tip (m, scale 1)
      handLen: { left: handLen('left'), right: handLen('right') },
    };
    return this.model;
  }

  /** Seat placement for placeSeated(): returns a copy of `seat` whose offset puts the thigh underside on this
   *  view's painted seat top and the hip joints VIEW_FIT.hipFwd along the facing from the column. */
  adjustSeat(seat, viewName, dropM) {
    const fit = this.views[viewName], m = this.model;
    if (!fit || !m || !seat) return seat;
    const vf = VIEW_FIT[viewName] || {};
    const s = seat.scale || 1;
    const th = seat.rotYDeg * DEG, f = [Math.sin(th), Math.cos(th)];
    const authoredFwd = seat.pos[0] * f[0] + seat.pos[2] * f[1];
    const shift = (vf.hipFwd != null ? vf.hipFwd : authoredFwd) - authoredFwd; // along the facing
    const naturalHipY = -(dropM || 0) * s + m.hipJointY * s; // where placeSeated alone puts the hip joint (no authored offset)
    const chair = this.chairSeat(viewName, vf.hipFwd != null ? vf.hipFwd : authoredFwd);
    const seatTopY = chair ? chair.seatTopY : fit.seatTopY;
    const contact = naturalHipY - m.clearance * s - seatTopY; // thigh underside above the (painted or 3D) seat top (m)
    // keep the authored height when the thighs already sit on the cushion (talk: +2 cm, its head row is registered
    // to the plate); otherwise put the underside 4 mm into the cushion (room floated +10 cm at scale 1.15; work's
    // authored -0.15 m offset sank it 8 cm into the seat)
    // a 3D chair: thigh underside 3 mm above its real seat (its depth occludes her, so any sink would show as clipping)
    const dy = chair ? 0.003 - contact : contact >= -0.005 && contact <= 0.03 ? 0 : -contact - 0.004;
    return { ...seat, offset: [f[0] * shift, dy, f[1] * shift] };
  }

  setTyping(view, w) { this.typing[view] = w; }
  setReach(point, weight) { this.reach = point && weight > 0 ? { point: point.clone(), weight } : null; }

  /** Per frame. `view` = the director's active view name. */
  update(dt, vrm, view) {
    const rig = this.engine.rig, fit = this.views[view], m = this.model;
    if (!rig || !vrm || !fit || !m || !rig.seated) { this.last = null; return; }
    const s = vrm.scene.scale.x;
    // Body frame, not the raw scene orientation: a VRM 0.x scene carries the 180-degree base flip (model-facing.js),
    // so its raw world quaternion maps +Z to her BACK -- using it here mirrored the seated knees/feet/lean (and the
    // foot yaw) for every imported VRM 0.x model. bodyOrientation() removes that base flip, VRM 1.0 is unchanged.
    const yaw = bodyOrientation(vrm.scene);
    const F = new THREE.Vector3(0, 0, 1).applyQuaternion(yaw).setY(0).normalize();
    const left = new THREE.Vector3(1, 0, 0).applyQuaternion(yaw).setY(0).normalize();
    const nb = (n) => vrm.humanoid.getNormalizedBoneNode(n);
    vrm.scene.updateMatrixWorld(true);

    // 1. hips never below the cushion contact (the idle root channel may dip them a little)
    const hl = nb('leftUpperLeg').getWorldPosition(V()), hr = nb('rightUpperLeg').getWorldPosition(V());
    const hipFwdNow = ((hl.x + hr.x) / 2) * fit.facing.x + ((hl.z + hr.z) / 2) * fit.facing.z;
    const chair = this.chairSeat(view, hipFwdNow);
    const hipY = (hl.y + hr.y) / 2, minHipY = (chair ? chair.seatTopY : fit.seatTopY) + m.clearance * s;
    if (hipY < minHipY && rig.hipsNode) {
      const hp = rig.hipsNode.getWorldPosition(V()); hp.y += minHipY - hipY;
      rig.hipsNode.position.copy(rig.hipsNode.parent.worldToLocal(hp));
      vrm.scene.updateMatrixWorld(true);
    }

    // 2. legs
    const legInfo = {};
    for (const side of ['left', 'right']) {
      const leg = rig.legs[side];
      if (!leg) continue;
      const H = leg.upper.getWorldPosition(V());
      const L1 = m.L1 * s, L2 = m.L2 * s, ankleY = m.ankleY * s;
      const out = side === 'left' ? left.clone() : left.clone().negate();
      // 3D chair: the thigh follows the real seat surface (a lounge seat rises to its front lip) and the feet may hang
      // free when the seat is higher than her shin can reach -- never the thigh pushed down through the cushion
      const cs = this.chairFit[view] ? this.chairSeat(view, H.dot(F), H.y - m.clearance * s, L1) : null;
      let a = (cs ? cs.thighDeg : 3) * DEG; // thigh slope down along the seat
      if (!cs && H.y - L1 * Math.sin(a) - ankleY > L2 * Math.cos(8 * DEG)) a = Math.asin(Math.min(0.9, (H.y - ankleY - L2 * Math.cos(8 * DEG)) / L1));
      const K = H.clone().addScaledVector(F, L1 * Math.cos(a)).addScaledVector(UP, -L1 * Math.sin(a)).addScaledVector(out, 0.012 * s);
      const dy = K.y - ankleY;
      let A, hang = false;
      if (cs) {
        // shin pitch below horizontal: down to the floor when it reaches, else hanging; then raised just enough that the
        // calf clears the seat surface ahead of the knee (a deep seat: her knees stop short of its front edge)
        const cf = this.chairFit[view], kFwd = K.dot(F), calf = 0.085 * s; // knee/calf half-depth incl. the boot top, +1 cm margin
        let th = dy <= L2 * 0.995 ? Math.asin(Math.min(1, dy / L2)) : 75 * DEG; // soles on the floor whenever the shin reaches
        // each seat point (d ahead of the knee, e below it) must stay `calf` behind/below the shin line: with the shin at
        // pitch th, that distance is -d*sin(th) - e*cos(th) = R*cos(th + phi) >= calf  =>  th <= acos(calf / R) - phi
        for (const [z, y] of cf.profile) {
          const d = cf.chairFwd + z - kFwd, e = y - K.y, R = Math.hypot(d, e);
          if (d > -0.02 && e < 0 && R > calf) th = Math.min(th, Math.acos(calf / R) - Math.atan2(d, -e));
        }
        th = Math.max(th, -10 * DEG);
        A = K.clone().addScaledVector(F, L2 * Math.cos(th)).addScaledVector(UP, -L2 * Math.sin(th)).addScaledVector(out, 0.018 * s);
        hang = A.y > ankleY + 0.01;
      } else {
        const fwd = Math.sqrt(Math.max(0, L2 * L2 - dy * dy));
        A = K.clone().addScaledVector(F, fwd).setY(ankleY).addScaledVector(out, 0.03 * s);
      }
      // toes FOOT_CLEAR short of any floor-standing desk part across this foot's line (the knee rises to suit)
      const aFwd = A.dot(F), aLat = A.x * fit.facing.z - A.z * fit.facing.x;
      let stop = Infinity;
      for (const ob of fit.obstacles) if (aLat + 0.07 > ob.lat[0] && aLat - 0.07 < ob.lat[1]) stop = Math.min(stop, ob.fwd);
      const over = aFwd + m.toeLen * s + FOOT_CLEAR - stop;
      if (over > 0) A.addScaledVector(F, -over);
      solveTwoBone(leg.upper, leg.lower, L1, L2, leg.restInvUpper, leg.restInvLower, A, F.clone().add(UP.clone().multiplyScalar(0.2)), rig.restBody, rig.restBodyInv, rig.restBase);
      leg.upper.updateMatrixWorld(true);
      // Flat, toes forward. The FOOT's rest orientation is the model root's raw world orientation (the VRM 0.x base
      // flip included), NOT the body frame used for F/left: `yaw` had the flip removed, so on VRM 0.x this turned
      // both feet 180 degrees backwards in every seated view (T-31 review round 2).
      leg.foot.quaternion.copy(leg.lower.getWorldQuaternion(Q()).invert().multiply(vrm.scene.getWorldQuaternion(Q())));
      const toes = nb(`${side}Toes`); if (toes) toes.quaternion.identity();
      legInfo[side] = { H, K, A, thighDeg: a / DEG, hang: Boolean(hang) };
    }

    // 3. hands on the keys (+ the lean that makes them reachable)
    const tw = (this.typing[view] || 0) * (fit.keys ? 1 : 0);
    const rw = this.reach ? this.reach.weight : 0;
    let leanTarget = 0;
    let typeTargets = null;
    if (tw > 0) {
      const k = fit.keys, vf = VIEW_FIT[view] || {};
      const row = vf.keyRow != null ? vf.keyRow : -0.1;
      const home = (sgn) => k.center.clone().addScaledVector(k.lr, sgn * 0.085 - 0.02).addScaledVector(k.depth, row * k.lenDepth);
      typeTargets = { left: home(-1), right: home(1) };
      const reachL = (rig.arms.left.L1 + rig.arms.left.L2) * s;
      const pivot = nb('spine').getWorldPosition(V());
      for (let deg = 0; deg <= 30; deg += 1.5) {
        let ok = true;
        for (const side of ['left', 'right']) {
          const S0 = rig.arms[side].upper.getWorldPosition(V()).sub(pivot).applyAxisAngle(left, deg * DEG).add(pivot);
          const wrist = typeTargets[side].clone().addScaledVector(k.depth, -m.handLen[side] * s * 0.7).addScaledVector(UP, 0.03);
          if (S0.distanceTo(wrist) > reachL * 0.93) ok = false;
        }
        leanTarget = deg;
        if (ok) break;
      }
      leanTarget *= tw;
    }
    if (tw <= 0 && this.chairFit[view]) leanTarget = -(this.chairFit[view].reclineDeg || 0); // lean back onto a raked 3D backrest
    this.lean = smooth(this.lean, leanTarget, dt, 0.25);
    if (Math.abs(this.lean) > 0.05) {
      const sp = nb('spine'), ch = nb('chest') || nb('upperChest'), nk = nb('neck');
      sp.quaternion.multiply(Q().setFromAxisAngle(new THREE.Vector3(1, 0, 0), this.lean * 0.6 * DEG));
      if (ch) ch.quaternion.multiply(Q().setFromAxisAngle(new THREE.Vector3(1, 0, 0), this.lean * 0.4 * DEG));
      if (nk) nk.quaternion.multiply(Q().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -this.lean * 0.45 * DEG)); // keep her eyes on the monitor
      vrm.scene.updateMatrixWorld(true);
    }
    const handInfo = {};
    for (const side of ['left', 'right']) {
      const arm = rig.arms[side];
      if (!arm) continue;
      const isReach = side === 'right' && rw > 0;
      if (tw <= 0 && !isReach) continue;
      const out = side === 'left' ? left.clone() : left.clone().negate();
      const L1 = arm.L1 * s, L2 = arm.L2 * s, hl2 = m.handLen[side] * s;
      // typing pose
      let wristT = null, dirT = null, curlT = null;
      if (tw > 0) {
        const k = fit.keys;
        dirT = k.depth.clone().addScaledVector(k.lr, side === 'left' ? 0.22 : -0.22).addScaledVector(UP, -0.25).normalize();
        wristT = typeTargets[side].clone().addScaledVector(dirT, -hl2 * 0.82).addScaledVector(UP, 0.012);
        curlT = TYPE_CURL;
        // keep a soft elbow: a keyboard beyond armExt of the arm's length is met short, at the keys' front edge,
        // instead of with a locked straight arm (work: 175 deg elbows from the painted chair)
        const ext = (VIEW_FIT[view] || {}).armExt, S = arm.upper.getWorldPosition(V());
        if (ext && wristT.distanceTo(S) > ext * (L1 + L2)) wristT.sub(S).setLength(ext * (L1 + L2)).add(S);
      }
      let wrist = wristT, dir = dirT, curl = curlT, cw = 1;
      if (isReach) {
        const S = arm.upper.getWorldPosition(V());
        const P = this.reach.point;
        const dirR = P.clone().sub(S).normalize();
        const wristR = P.clone().addScaledVector(dirR, -hl2 * 0.92);
        const e = ease(rw);
        if (wristT) {
          wrist = wristT.clone().lerp(wristR, e).addScaledVector(UP, 0.07 * Math.sin(Math.PI * e)); // lift off the keys, then out
          dir = dirT.clone().lerp(dirR, e).normalize();
          curl = null; cw = e; // blend curls below
        } else { wrist = wristR; dir = dirR; curl = POINT_CURL; }
      }
      // elbows out more than down: a near keyboard (room) otherwise drops the elbow below the desk top and the forearm
      // rises through the desk edge (measured 1.1 cm into the room desktop slab with the pole (-1 up, 0.7 out))
      const pole = UP.clone().multiplyScalar(-0.5).addScaledVector(out, 1).addScaledVector(F, -0.35).normalize();
      solveTwoBone(arm.upper, arm.lower, L1, L2, arm.restInvUpper, arm.restInvLower, wrist, pole, rig.restBody, rig.restBodyInv, rig.restBase);
      arm.upper.updateMatrixWorld(true);
      setHandWorld(arm.hand, side, dir, UP);
      const fingers = {};
      for (const f of Object.keys(FINGERS)) {
        const a = curl ? curl[f] : TYPE_CURL[f].map((x, i) => x + (POINT_CURL[f][i] - x) * cw);
        fingers[f] = a;
        FINGERS[f].forEach((b, i) => { const n = nb(`${side}${b}`); if (n) n.rotation.set(0, 0, (side === 'left' ? -1 : 1) * a[i] * DEG); });
      }
      arm.hand.updateMatrixWorld(true);
      // fingertips onto the key tops: one vertical correction pass (typing only, not mid-reach)
      if (tw > 0 && !(isReach && rw > 0.02)) {
        const tips = fingertips(vrm, side);
        const meanY = tips.reduce((acc, t) => acc + t.y, 0) / tips.length;
        const dyTip = fit.keys.y + 0.006 - meanY;
        if (Math.abs(dyTip) > 0.002) {
          wrist.addScaledVector(UP, dyTip);
          solveTwoBone(arm.upper, arm.lower, L1, L2, arm.restInvUpper, arm.restInvLower, wrist, pole, rig.restBody, rig.restBodyInv, rig.restBase);
          arm.upper.updateMatrixWorld(true);
          setHandWorld(arm.hand, side, dir, UP);
          arm.hand.updateMatrixWorld(true);
        }
      }
      handInfo[side] = { wrist: wrist.clone() };
    }
    vrm.humanoid.update();
    vrm.scene.updateMatrixWorld(true);
    this.last = { view, lean: this.lean, legs: legInfo, hands: handInfo, typing: tw, reach: rw };
  }
}

/** World positions of the four fingertips of one hand (distal bone + 3/4 of the previous phalanx along it). */
export function fingertips(vrm, side) {
  const out = [];
  for (const f of Object.keys(FINGERS)) {
    const mi = vrm.humanoid.getNormalizedBoneNode(`${side}${FINGERS[f][1]}`), di = vrm.humanoid.getNormalizedBoneNode(`${side}${FINGERS[f][2]}`);
    if (!mi || !di) continue;
    const a = mi.getWorldPosition(V()), b = di.getWorldPosition(V());
    out.push(b.clone().addScaledVector(b.clone().sub(a), 0.75));
  }
  return out;
}

// Two-bone IK with an explicit bend pole (same construction as rig.js solveArm, but with the CURRENT world
// lengths -- rig.js measures L1/L2 once at bind time at scale 1, while the seated views scale the model 1.08-1.15).
export function solveTwoBone(upper, lower, L1, L2, restInvUpper, restInvLower, target, pole, bodyQ, bodyInv, base) {
  const S = upper.getWorldPosition(V());
  const d = V().subVectors(target, S);
  const dist = Math.min(Math.max(d.length(), Math.abs(L1 - L2) + 1e-4), (L1 + L2) * 0.999);
  const u = d.normalize();
  const cosA = (L1 * L1 + dist * dist - L2 * L2) / (2 * L1 * dist), sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
  const v = pole.clone().addScaledVector(u, -pole.dot(u)).normalize();
  const elbow = S.clone().addScaledVector(u, L1 * cosA).addScaledVector(v, L1 * sinA);
  const wrist = S.clone().addScaledVector(u, dist);
  const a1 = V().subVectors(elbow, S).normalize(), a2 = V().subVectors(wrist, elbow).normalize();
  const c1 = a2.clone().addScaledVector(a1, -a2.dot(a1));
  if (c1.lengthSq() < 1e-8) c1.copy(v).negate().addScaledVector(a1, v.dot(a1));
  c1.normalize();
  const n1 = V().crossVectors(a1, c1), c2 = V().crossVectors(n1, a2);
  // Rest frames are captured in the BODY frame (rig.js rootedBasis), so solve there and rotate back with the
  // bind-time body orientation, right-appending the model's base flip (identity for VRM 1.0): VRM 0.x no longer
  // comes out rolled 180 degrees about each bone's own axis (T-31 review round 3).
  const qU = rootedBasis(a1, c1, n1, restInvUpper, bodyInv, base);
  const qL = rootedBasis(a2, c2, n1, restInvLower, bodyInv, base);
  const pq = upper.parent.getWorldQuaternion(Q());
  upper.quaternion.copy(pq.invert().multiply(bodyQ).multiply(qU));
  lower.quaternion.copy(qU.clone().invert().multiply(qL));
}

// Normalized hands: fingers along +X (left) / -X (right), back of the hand +Y (palm -Y).
function setHandWorld(hand, side, fingerDir, up) {
  const x = side === 'left' ? fingerDir.clone() : fingerDir.clone().negate();
  const y = up.clone().addScaledVector(fingerDir, -up.dot(fingerDir)).normalize();
  const z = V().crossVectors(x, y);
  const qW = Q().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
  hand.quaternion.copy(hand.parent.getWorldQuaternion(Q()).invert().multiply(qW));
}
