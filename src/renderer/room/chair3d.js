// Real 3D chair (T-31 chair3d, concept round 13-10): a GLB chair that Zumi actually sits in, replacing the talk view's
// painted chair (settings.json chair3d; 'painted' = off, default = chair3d.mjs DEFAULT_CHAIR); main's chair3d.mjs owns the manifest
// (assets/chair3d/chairs.json) and the pick, this module only draws what it is given.
// While a chair is attached to the v2 room (the painted room or under a video room):
//   - the talk plate is swapped for noChairPlate (the same painting with the chair inpainted out),
//   - the painted chair's depth occluders (armrests, seat) are switched off -- the desk/keyboard ones stay,
//   - the GLB sits in the talk view's own frame (origin = floor under the old chair column, facing +Z), slid along +Z
//     so its backrest meets her pelvis: her hip spot (and so the approved framing) does not move,
//   - it is lit by the talk view's own light rig plus an environment map built from the plate (night window behind,
//     warm lamp bounce in front), and a soft contact shadow sits under it.
// It is parented to the talk view's occluder group, so CameraDirector's per-view visibility hides it in work/room.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const gltfLoader = new GLTFLoader();
const GAP_M = 0.005; // pelvis to backrest front: touching, not inside
const KNEE_MARGIN_M = 0.08; // seat front edge this far behind the knee joint: the calf (~6-8 cm deep) clears the edge
const SHIN_TILT_DEG = 6; // shin forward of vertical with the soles flat (a relaxed sit, not a 90-degree knee)
const SCALE_LIMITS = { y: [0.75, 1.2], z: [0.6, 1.2] };
const HIP_HALF_M = 0.13; // her pelvis half-width (~0.10 m at scale 1) + margin, in the chair's unscaled frame (x scale 0.85-1.2)

/** Equirect environment (three.js equirect layout: -Z at u=0.25, +X at u=0.5, +Z at u=0.75, up at the top row) made
 *  from the no-chair plate: the plate's window wall fills the -Z quarter, a dim night room the rest, warm lamp bounce
 *  low in front-right (room.json talk lights: warm_fill from the front right, cool window key from behind). */
function plateEnvCanvas(plateImage) {
  const W = 512, H = 256;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  const sky = g.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, '#1a1f45'); sky.addColorStop(0.45, '#3b3a78'); sky.addColorStop(0.55, '#4a3f62'); sky.addColorStop(1, '#2a2230');
  g.fillStyle = sky; g.fillRect(0, 0, W, H);
  if (plateImage) g.drawImage(plateImage, 0, 0, plateImage.width, plateImage.height * 0.75, W * 0.08, H * 0.12, W * 0.34, H * 0.5);
  const warm = g.createRadialGradient(W * 0.64, H * 0.55, 0, W * 0.64, H * 0.55, W * 0.14);
  warm.addColorStop(0, 'rgba(255,184,120,0.85)'); warm.addColorStop(1, 'rgba(255,184,120,0)');
  g.fillStyle = warm; g.fillRect(0, 0, W, H);
  return c;
}

function contactShadow(bbox) {
  const c = document.createElement('canvas'); c.width = 128; c.height = 128;
  const g = c.getContext('2d');
  const r = g.createRadialGradient(64, 64, 6, 64, 64, 64);
  r.addColorStop(0, 'rgba(0,0,0,0.75)'); r.addColorStop(0.6, 'rgba(0,0,0,0.35)'); r.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = r; g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const w = (bbox.max.x - bbox.min.x) * 1.25, d = (bbox.max.z - bbox.min.z) * 1.25;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0.6 }));
  m.rotation.x = -Math.PI / 2;
  m.position.set((bbox.max.x + bbox.min.x) / 2, 0.002, (bbox.max.z + bbox.min.z) / 2);
  m.name = 'chair3d-contact-shadow';
  return m;
}

export class Chair3D {
  constructor({ renderer }) {
    this.renderer = renderer;
    this.entry = null; // the listed chair ({id, url, seat, look, ...}) currently loaded, or null
    this.group = null; // chair mesh + contact shadow
    this.noChairPlate = null; // THREE.Texture (ImageBitmap) of the no-chair plate
    this.envTarget = null;
    this.attached = null; // { room, hidden: [meshes], savedPlate }
    this.token = 0;
  }

  get active() { return Boolean(this.attached); }

  /** Loads `entry` (null = back to the painted chair) and the shared no-chair plate. Never throws. */
  async load(entry, noChairPlateUrl) {
    const token = ++this.token;
    this.unload();
    if (!entry) return false;
    try {
      if (!this.noChairPlate || this.noChairPlateUrl !== noChairPlateUrl) {
        const bmp = await createImageBitmap(await (await fetch(noChairPlateUrl)).blob());
        this.noChairPlate = new THREE.Texture(bmp);
        this.noChairPlateUrl = noChairPlateUrl;
      }
      const gltf = await gltfLoader.loadAsync(entry.url);
      if (token !== this.token) return false;
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      const envTex = new THREE.CanvasTexture(plateEnvCanvas(this.noChairPlate.image));
      envTex.mapping = THREE.EquirectangularReflectionMapping; envTex.colorSpace = THREE.SRGBColorSpace;
      this.envTarget = pmrem.fromEquirectangular(envTex);
      envTex.dispose(); pmrem.dispose();
      const chair = gltf.scene;
      chair.name = `chair3d-${entry.id}`;
      chair.traverse((o) => {
        if (!o.isMesh) return;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        const look = entry.look || {};
        for (const m of mats) {
          m.envMap = this.envTarget.texture; m.envMapIntensity = look.envIntensity || 1;
          // light match (chairs.json look.tint, measured against the painted chair by scripts/chair3d-lightmatch.mjs):
          // the room is a night plate, so the base colour is pulled toward what the plate's light makes of it
          if (look.tint && m.color) m.color.multiply(new THREE.Color(look.tint));
          m.needsUpdate = true;
        }
      });
      const group = new THREE.Group();
      group.name = 'chair3d';
      group.add(chair);
      this.chairNode = chair;
      this.shadow = contactShadow(new THREE.Box3().setFromObject(chair));
      group.add(this.shadow);
      this.group = group;
      this.entry = entry;
      return true;
    } catch (e) {
      console.error('chair3d: load failed', entry && entry.id, e);
      if (token === this.token) this.unload();
      return false;
    }
  }

  /** Frontmost backrest point (chair frame z, unscaled) within |x| <= halfX, 0.03-0.2 m above the seat top (the band the
   *  centre-line lumbar uses), seat cushion excluded (z > 0.15). -Infinity when the manifest has no seat.topY. */
  backFrontAcrossHips(halfX) {
    const seat = this.entry.seat;
    if (seat.topY == null) return -Infinity;
    this.chairNode.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(this.chairNode.matrixWorld).invert(), local = new THREE.Matrix4(), p = new THREE.Vector3();
    let front = -Infinity;
    this.chairNode.traverse((o) => {
      if (!o.isMesh) return;
      local.multiplyMatrices(inv, o.matrixWorld);
      const pos = o.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        p.fromBufferAttribute(pos, i).applyMatrix4(local);
        const dz = p.y - seat.topY;
        if (Math.abs(p.x) <= halfX && dz >= 0.03 && dz <= 0.2 && p.z <= 0.15 && p.z > front) front = p.z;
      }
    });
    return front;
  }

  /** Fits the loaded chair to the bound model (seat-fit.js measureModel numbers `m`, seat scale `s`) and returns the
   *  seat data for SeatFit.setChairFit. Real chairs are built for adults: their seats are deeper than her thighs and
   *  can be higher than her shins, so the chair is scaled per axis (x/y together, z alone) to her proportions --
   *    height: the highest seat point under her thighs = knee-to-sole height (soles flat, shin SHIN_TILT_DEG forward)
   *            minus the thigh's own thickness, so her knees bend and her soles rest on the floor;
   *    depth:  backrest (lumbar) to seat front = pelvis depth + thigh length - KNEE_MARGIN_M, so her back is on the
   *            backrest and her knees are past the front edge.
   *  Then the chair slides along +Z until its backrest meets her pelvis; her hip spot (the approved framing) stays. */
  fit(m, s, hipFwd, seatFit, view) {
    const seat = this.entry.seat;
    const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));
    // lumbar = the backrest's frontmost point at hip height: the centre-line profile, and also the mesh itself across her
    // hip width -- a wrap-around mesh back comes forward at its sides (r2e: mesh-office's side frame was 6.6 cm into
    // her hips while its centre line was clear)
    const lumbar = Math.max(0, ...seat.backProfile.filter(([dz]) => dz <= 0.2).map(([, z]) => z), this.backFrontAcrossHips(HIP_HALF_M * s));
    const wantDepth = m.rearDepth * s + m.L1 * s - KNEE_MARGIN_M + GAP_M;
    const sz = clamp(wantDepth / (seat.frontFwd - lumbar), SCALE_LIMITS.z);
    let chairFwd = hipFwd - m.rearDepth * s - lumbar * sz - GAP_M;
    const dataFor = (sy) => ({ chairFwd, profile: seat.profile.map(([z, y]) => [z * sz, y * sy]), frontFwd: chairFwd + seat.frontFwd * sz, reclineDeg: this.entry.reclineDeg, scale: [sy, sy, sz] });
    // height: the tallest chair (<= 1.2) whose seat lets her knee sit low enough for flat soles -- solved with the same
    // seat/thigh rules SeatFit applies per frame (hips on the seat under them, thigh over the seat surface ahead)
    const reach = m.L2 * s * Math.cos(SHIN_TILT_DEG * Math.PI / 180);
    const kneeLift = (sy) => {
      seatFit.setChairFit(view, dataFor(sy));
      const under = seatFit.chairSeat(view, hipFwd).seatTopY + 0.003;
      const thighDeg = seatFit.chairSeat(view, hipFwd, under, m.L1 * s).thighDeg;
      return under + m.clearance * s - m.L1 * s * Math.sin(thighDeg * Math.PI / 180) - m.ankleY * s; // knee joint above the ankle joint
    };
    let lo = SCALE_LIMITS.y[0], hi = SCALE_LIMITS.y[1];
    if (kneeLift(hi) <= reach) lo = hi;
    else for (let i = 0; i < 30; i++) { const mid = (lo + hi) / 2; if (kneeLift(mid) <= reach) lo = mid; else hi = mid; }
    const sy = lo;
    // headrest: a backrest that comes forward up high (gaming/high-back chairs) would meet her head and hair before her
    // pelvis meets the lumbar -- slide the chair back until every backrest point at head height clears them by 1 cm
    if (m.head && seat.topY != null) {
      seatFit.setChairFit(view, dataFor(sy));
      const hipY = seatFit.chairSeat(view, hipFwd).seatTopY + 0.003 + m.clearance * s;
      const headRearZ = hipFwd - m.head.rear * s - 0.01;
      for (const [dz, z] of seat.backProfile) {
        const y = (seat.topY + dz) * sy;
        if (y >= hipY + m.head.low * s - 0.03 && y <= hipY + m.head.high * s) chairFwd = Math.min(chairFwd, headRearZ - z * sz);
      }
    }
    const data = dataFor(sy);
    seatFit.setChairFit(view, data);
    this.chairNode.scale.set(sy, sy, sz);
    this.group.position.set(0, 0, chairFwd);
    this.group.updateMatrixWorld(true);
    const bb = new THREE.Box3().setFromObject(this.chairNode);
    this.shadow.scale.set(sy, sz, 1);
    this.shadow.position.set((bb.max.x + bb.min.x) / 2, 0.002, (bb.max.z + bb.min.z) / 2 - chairFwd);
    this.scale = [sy, sy, sz];
    return data;
  }

  /** Puts the loaded chair into `room` (loadRoomV2 result) at `chairFwd`; idempotent. */
  attach(room, hideOccluders) {
    if (!this.group || !room || !room.views.talk) return false;
    if (this.attached && this.attached.room !== room) this.detach();
    const talk = room.views.talk;
    if (!this.attached) {
      const hidden = [];
      talk.occludersGroup.traverse((o) => { if (o.isMesh && hideOccluders.some((n) => o.name === `occ_talk_${n}`) && o.visible) { o.visible = false; hidden.push(o); } });
      this.attached = { room, hidden, savedPlate: talk.plateTexture };
      if (this.noChairPlate) talk.plateTexture = this.noChairPlate;
      talk.occludersGroup.add(this.group);
    }
    return true;
  }

  detach() {
    if (!this.attached) return;
    const { room, hidden, savedPlate } = this.attached;
    for (const o of hidden) o.visible = true;
    room.views.talk.plateTexture = savedPlate;
    if (this.group && this.group.parent) this.group.parent.remove(this.group);
    this.attached = null;
  }

  unload() {
    this.detach();
    if (this.group) this.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap']) if (m[k]) m[k].dispose(); m.dispose(); }); });
    if (this.envTarget) this.envTarget.dispose();
    this.group = null; this.envTarget = null; this.entry = null;
  }
}
