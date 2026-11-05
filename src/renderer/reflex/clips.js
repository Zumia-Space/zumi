// Optional clip fallback layer: a GestureCommand may carry `clip: {name, weight, ...}`.
// If assets/clips/<name>.vrma (or a Mixamo <name>.fbx) exists it is sampled at the command's own
// timeline and slerp-blended over the procedural pose. Only bone rotation tracks are used
// (no root motion, no expression/lookAt tracks — the command drives those itself).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { VRMAnimationLoaderPlugin, createVRMAnimationClip } from '@pixiv/three-vrm-animation';

// Mixamo -> VRM humanoid (same map as pixiv's three-vrm Mixamo example).
const MIXAMO = {
  mixamorigHips: 'hips', mixamorigSpine: 'spine', mixamorigSpine1: 'chest', mixamorigSpine2: 'upperChest',
  mixamorigNeck: 'neck', mixamorigHead: 'head',
  mixamorigLeftShoulder: 'leftShoulder', mixamorigLeftArm: 'leftUpperArm', mixamorigLeftForeArm: 'leftLowerArm', mixamorigLeftHand: 'leftHand',
  mixamorigRightShoulder: 'rightShoulder', mixamorigRightArm: 'rightUpperArm', mixamorigRightForeArm: 'rightLowerArm', mixamorigRightHand: 'rightHand',
  mixamorigLeftUpLeg: 'leftUpperLeg', mixamorigLeftLeg: 'leftLowerLeg', mixamorigLeftFoot: 'leftFoot', mixamorigLeftToeBase: 'leftToes',
  mixamorigRightUpLeg: 'rightUpperLeg', mixamorigRightLeg: 'rightLowerLeg', mixamorigRightFoot: 'rightFoot', mixamorigRightToeBase: 'rightToes',
};

function retargetMixamo(asset, vrm) {
  const src = THREE.AnimationClip.findByName(asset.animations, 'mixamo.com') || asset.animations[0];
  if (!src) throw new Error('fbx has no animation');
  const tracks = [];
  const restInv = new THREE.Quaternion(), parentRest = new THREE.Quaternion(), q = new THREE.Quaternion();
  for (const track of src.tracks) {
    const [rigName, prop] = track.name.split('.');
    const boneName = MIXAMO[rigName];
    const node = boneName && vrm.humanoid.getNormalizedBoneNode(boneName);
    const rigNode = asset.getObjectByName(rigName);
    if (!node || !rigNode || prop !== 'quaternion') continue;
    rigNode.getWorldQuaternion(restInv).invert();
    rigNode.parent.getWorldQuaternion(parentRest);
    const values = track.values.slice();
    for (let i = 0; i < values.length; i += 4) {
      q.fromArray(values, i).premultiply(parentRest).multiply(restInv).toArray(values, i);
    }
    tracks.push(new THREE.QuaternionKeyframeTrack(`${node.name}.quaternion`, track.times, values));
  }
  return new THREE.AnimationClip('fbx', src.duration, tracks);
}

export class ClipLayer {
  constructor() {
    this.available = new Map(); // name -> url
    this.cache = new Map(); // name -> Promise<{kind, data}>
    this.vrm = null;
    this.mixer = null;
    this.actions = new Map(); // name -> AnimationAction (per bound vrm)
    this.building = new Map(); // name -> in-flight Promise<AnimationAction|null> (shared by action() and warm(), see _ensureBuilt)
    this.wasActive = false;
    this.snapshot = new Map(); // node -> quaternion sampled from clips this frame
  }

  setAvailable(list) {
    this.available.clear();
    for (const c of list) this.available.set(c.name, c.url);
  }
  has(name) { return this.available.has(name); }

  bind(vrm) {
    this.vrm = vrm;
    this.mixer = new THREE.AnimationMixer(vrm.scene);
    this.actions.clear();
    // T-31 chair fix: a re-bind (model load, then room load -> placeAndFrameAny binds again)
    // must also forget in-flight/finished builds -- otherwise _ensureBuilt() hands back the PREVIOUS binding's
    // resolved promise, the action is never rebuilt on this mixer, and a sustained seat clip silently stops
    // posing the legs (measured: first switch to the work view showed dead-straight legs through the seat).
    this.building.clear();
  }
  unbind() { if (this.mixer) this.mixer.stopAllAction(); this.vrm = null; this.mixer = null; this.actions.clear(); this.building.clear(); }

  load(name) {
    if (!this.cache.has(name)) {
      const url = this.available.get(name);
      const p = url.toLowerCase().endsWith('.fbx')
        ? new FBXLoader().loadAsync(url).then((data) => ({ kind: 'fbx', data }))
        : (() => { const l = new GLTFLoader(); l.register((parser) => new VRMAnimationLoaderPlugin(parser)); return l.loadAsync(url); })()
          .then((gltf) => ({ kind: 'vrma', data: gltf.userData.vrmAnimations && gltf.userData.vrmAnimations[0] }));
      this.cache.set(name, p.catch((e) => { console.warn('[clips] load failed', name, e); return null; }));
    }
    return this.cache.get(name);
  }

  action(name) {
    if (this.actions.has(name)) return this.actions.get(name);
    this.actions.set(name, null); // pending
    this._ensureBuilt(name);
    return null;
  }

  // Builds (once) and registers `name`'s AnimationAction from load()'s cache, playing at weight 0 until a
  // caller (sample()) raises it. Shared by action()'s lazy .then() path and warm()'s eager await path via
  // `this.building`, so two callers racing on the same not-yet-built clip never construct two
  // THREE.AnimationActions for it (mixer.clipAction() does not dedupe across distinct AnimationClip
  // instances, only by clip uuid+root, and a freshly constructed clip always gets a new uuid).
  _ensureBuilt(name) {
    if (this.building.has(name)) return this.building.get(name);
    const p = this.load(name).then((res) => {
      if (!res || !res.data || !this.vrm) return null;
      let clip = res.kind === 'fbx' ? retargetMixamo(res.data, this.vrm) : createVRMAnimationClip(res.data, this.vrm);
      clip = new THREE.AnimationClip(name, clip.duration, clip.tracks.filter((t) => t.name.endsWith('.quaternion')));
      const act = this.mixer.clipAction(clip);
      act.play();
      act.setEffectiveWeight(0);
      act.animatedNodes = new Set(clip.tracks.map((t) => t.name.slice(0, t.name.lastIndexOf('.'))));
      this.actions.set(name, act);
      return act;
    });
    this.building.set(name, p);
    return p;
  }

  /** Guarantees `name`'s AnimationAction is built and registered in `this.actions` before returning --
   *  for a caller about to drive engine.update() in a TIGHT SYNCHRONOUS loop (no event-loop turns between
   *  ticks, e.g. a headless frame-settle render), where action()'s own lazy .then() would never get a
   *  chance to run until the whole loop returns (its promise microtask can only fire once the call stack
   *  unwinds) -- see src/renderer/room/seat.js's enterSeated(), the one real caller. A no-op once the
   *  action already exists. */
  async warm(name) {
    if (this.actions.has(name) && this.actions.get(name)) return;
    await this._ensureBuilt(name);
  }

  // Phase 1 (before procedural pose): sample requested clips into a snapshot. Returns true if any.
  sample(requests) {
    this.snapshot.clear();
    if (!this.mixer || !requests.length) return false;
    let any = false;
    for (const act of this.actions.values()) if (act) act.setEffectiveWeight(0);
    const weights = new Map();
    for (const r of requests) {
      if (!this.available.has(r.name)) continue;
      const act = this.action(r.name);
      if (!act) continue;
      const dur = act.getClip().duration || 1;
      act.time = r.loop ? r.timeSec % dur : Math.min(r.timeSec, dur);
      weights.set(r.name, Math.min(1, (weights.get(r.name) || 0) + r.weight));
      any = true;
    }
    if (!any) return false;
    // Sample the full clip pose (weights normalized among concurrent clips); the command weight is
    // applied later by blend() as a slerp amount.
    // Do NOT call vrm.humanoid.resetNormalizedPose() here (a previous version did, before and after
    // mixer.update() -- found 2026-10-03: a sampled clip silently decayed to identity from its 2nd frame
    // onward, regression-tested now by scripts/check-clip-hold.mjs).
    // THREE's PropertyMixer snapshots each bound property's "original" value ONCE, at the action's first
    // play()/activation, not on every update() -- an external resetNormalizedPose() call positioned
    // anywhere between two mixer.update() calls corrupts that cached binding for good (every update()
    // after it silently re-applies identity, no error, no warning). Reproduced in isolation: a bare
    // THREE.AnimationMixer survives any number of repeated `action.time = x; mixer.update(0)` calls with
    // NO reset in between; inserting one resetNormalizedPose() anywhere in that sequence breaks every
    // mixer.update() call after it. No reset is actually needed here: every bone category the procedural
    // layer owns (TORSO, legs via solveLegs, arms via solveArms, fingers via applyHands) unconditionally
    // overwrites its own bones every frame regardless of what sample() left behind, and the snapshot loop
    // below already only touches bones this frame's `animated` set actually contains -- the one case this
    // doesn't cover (a clip's own bone when ALL clips stop) is handled separately, in engine.js's
    // `if (!sampled && wasActive) resetNormalizedPose()`.
    let total = 0;
    for (const w of weights.values()) total += w;
    for (const [name, w] of weights) this.actions.get(name).setEffectiveWeight(total > 0 ? w / total : 0);
    this.mixer.update(0);
    const amount = Math.min(1, total);
    const animated = new Set();
    for (const name of weights.keys()) for (const n of this.actions.get(name).animatedNodes) animated.add(n);
    for (const n of Object.values(this.vrm.humanoid.normalizedHumanBones || {})) {
      // only bones the clip really animates; everything else keeps the procedural pose
      if (n && n.node && animated.has(n.node.name)) this.snapshot.set(n.node, { q: n.node.quaternion.clone(), w: amount });
    }
    return true;
  }

  // Phase 2 (after procedural pose + IK): blend sampled clip rotations over the procedural result.
  blend() {
    for (const [node, s] of this.snapshot) node.quaternion.slerp(s.q, s.w);
  }
}
