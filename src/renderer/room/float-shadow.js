// Soft floor shadow (T-31 float-holo pilot, cheap win 1): ONE flat plane lying on the room floor under her feet,
// painted with a blurred dark radial-gradient CanvasTexture. No shadow maps, no extra light -- just a decal. It
// shrinks and fades as the hover height grows, and follows the bob: app.js calls update() every frame right after
// float-mode's hover has moved the root, and the live ankle height above the floor is mapped through the pure
// shadowForHover(). Renderer-only, like float-mode.js / holo-screen.js.
import * as THREE from 'three';
import { FLOAT } from './float-mode.js';

export const FLOOR_Y = 0; // the room's floor plane: the seat's own pos.y is the hips Y with her soles flat on it
export const SHADOW_PLANE_SIZE = 0.9; // metres, the plane's own edge before scale (her footprint is ~0.4 m)
// r4: the decal's centre is opaque black at this alpha; baseOpacity * SHADOW_CORE_ALPHA is how dark the floor goes
// directly under her at rest (0.75 * 0.85 = 0.6375, i.e. the floor drops to ~36% brightness). r3's 0.55*0.85 =
// 0.47 read as a faint smudge from the full-body framing; this is a definite contact shadow.
export const SHADOW_CORE_ALPHA = 0.85; // the radial gradient's centre alpha (the dark core; see the texture below)
export const SHADOW_DARK_MIN = 0.45; // the contact shadow must darken the floor by at least this at the rest height
// refGap = the REST hover height (the same FLOAT.soleY the placement uses): the decal is full size/strength there
// and fades + shrinks as she rises above it. It does NOT get stronger below the rest height -- the opacity is
// clamped at baseOpacity (see shadowForHover), so the low bob sits at the same strength, only the high bob fades.
// centerBackM (r5): the decal centre is nudged this far (metres) AWAY from the toe tips, along the horizontal
// hips->toes axis, so the dark core sits under the pelvis/COM and the toe tips land on the decal's lighter skirt --
// the "lighter floor strip" that makes the float read (a shadow pooling right on the toe tips hides the gap). The
// core itself is also tightened (see the gradient below) so its radius (~0.08 m at rest) stays behind the tips.
export const SHADOW = { refGap: FLOAT.soleY, baseScale: 0.62, baseOpacity: 0.75, fadePerM: 7, shrinkPerM: 5, minScaleFrac: 0.45, centerBackM: 0.10 };

// r6 runtime override (box sweep): the decal centre offset, in metres. The SWEEP writes THIS object; the shipped
// SHADOW above stays untouched, so an unset override is byte-identical to r5. A plain mutable field (not a setter)
// because the value is read once per frame in update() and the box sets it between captures.
export const SHADOW_RUNTIME = { centerBackM: SHADOW.centerBackM };

/** Pure map from the ankle's height above the floor (metres) to the decal's { scale, opacity }. Monotonic: a
 *  taller gap -> smaller and fainter. At the reference gap (FLOAT.soleY) it is full size/strength; the hover's
 *  +-2.5 cm swing gives opacity 0.619..0.750 (+0 / -0.131: the low side is clamped) and scale 0.542..0.698, so
 *  the shadow visibly follows the bob. (Unit-tested in scripts/check-float-holo.mjs: monotonic, bounded.) */
export function shadowForHover(gapM, s = SHADOW) {
  const d = gapM - s.refGap; // + up, - down
  const opacity = Math.max(0, Math.min(s.baseOpacity, s.baseOpacity * (1 - s.fadePerM * d)));
  const scale = s.baseScale * Math.max(s.minScaleFrac, 1 - s.shrinkPerM * d);
  return { scale, opacity };
}

/** How dark the floor goes directly under her at a given ankle gap: the decal's opacity there times its dark
 *  core. 1 = a pure-black floor, 0 = unchanged. r4 gate: >= SHADOW_DARK_MIN at the rest height (FLOAT.soleY). */
export function shadowCoreAlpha(gapM, s = SHADOW) {
  return shadowForHover(gapM, s).opacity * SHADOW_CORE_ALPHA;
}

export class FloatShadow {
  /** @param parent the stage THREE.Scene (world space, same as the holo panel) @param engine the bound
   *  ReflexEngine (its vrm.scene X/Z + the leftFoot bone give the decal's place and the live hover gap). */
  constructor({ parent, engine }) {
    this.engine = engine;
    this.on = false;
    const c = document.createElement('canvas'); c.width = 128; c.height = 128;
    const g = c.getContext('2d');
    const r = g.createRadialGradient(64, 64, 4, 64, 64, 62);
    r.addColorStop(0, `rgba(0,0,0,${SHADOW_CORE_ALPHA})`); // dark core (SHADOW_CORE_ALPHA), fading to transparent at the rim = the blur
    // r5: the dark core is TIGHT (alpha >= 0.5 only out to ~0.3 of the radius, ~0.08 m at rest) so the pelvis sits
    // over the dark centre while the toe tips, ~0.14 m away after the centerBackM nudge, sit on the bright skirt.
    r.addColorStop(0.30, 'rgba(0,0,0,0.28)');
    r.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = r; g.fillRect(0, 0, 128, 128);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(SHADOW_PLANE_SIZE, SHADOW_PLANE_SIZE),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: SHADOW.baseOpacity, depthWrite: false, toneMapped: false }),
    );
    this.mesh.rotation.x = -Math.PI / 2; // lie flat, facing up
    this.mesh.name = 'float-shadow'; // the box gate (scripts/electron-float-holo.cjs) finds the decal by this name
    this.mesh.visible = false;
    parent.add(this.mesh);
    this._v = new THREE.Vector3();
    this._hips = new THREE.Vector3(); this._l = new THREE.Vector3(); this._r = new THREE.Vector3();
  }

  setOn(on) { this.on = Boolean(on); this.mesh.visible = this.on; }

  /** Per-frame: sit under the pelvis, nudged away from the toe tips (SHADOW.centerBackM), and map the live ankle
   *  gap to scale + opacity. */
  update() {
    if (!this.on) return;
    const vrm = this.engine.vrm;
    if (!vrm) return;
    const foot = vrm.humanoid && vrm.humanoid.getNormalizedBoneNode('leftFoot');
    const ankleY = foot ? foot.getWorldPosition(this._v).y : FLOOR_Y + SHADOW.refGap;
    const { scale, opacity } = shadowForHover(ankleY - FLOOR_Y);
    const rig = this.engine.rig;
    const hips = rig && rig.hipsNode ? rig.hipsNode.getWorldPosition(this._hips) : vrm.scene.getWorldPosition(this._hips);
    let cx = hips.x, cz = hips.z;
    const lb = vrm.humanoid && vrm.humanoid.getNormalizedBoneNode('leftToes');
    const rb = vrm.humanoid && vrm.humanoid.getNormalizedBoneNode('rightToes');
    if (lb && rb) {
      const a = lb.getWorldPosition(this._l), b = rb.getWorldPosition(this._r);
      const dx = (a.x + b.x) / 2 - hips.x, dz = (a.z + b.z) / 2 - hips.z;
      const len = Math.hypot(dx, dz);
      const back = SHADOW_RUNTIME.centerBackM;
      if (len > 1e-4) { cx -= (dx / len) * back; cz -= (dz / len) * back; }
    }
    this.mesh.position.set(cx, FLOOR_Y + 0.005, cz);
    this.mesh.scale.setScalar(scale);
    this.mesh.material.opacity = opacity;
  }
}
