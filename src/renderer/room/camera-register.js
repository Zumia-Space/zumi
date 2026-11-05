// Camera registration tool (T-31 camera modes, coordinator ruling 03-10: "Code waits for anh's concept pick;
// build registration as a tunable tool"). Dev-only (gated behind the existing Developer-tools toggle, same as
// the board-message simulator) -- shows the zumi_seat/desk/chair proxy wireframes already in the room's
// proxiesGroup (room-loader-v2.js), lets a keyboard nudge the ACTIVE view's camera pos/target/fov live, and
// writes the result back into room.json through a narrow IPC call. Never touches engine.trigger()/the render
// loop's reflex path -- purely a camera + HUD-text concern, same posture as CameraDirector itself.
const STEP_POS = 0.02; // metres per keypress (Shift = x5, PLAN: "live nudges ... (keyboard)")
const STEP_DEG = 1; // degrees per keypress, applied to the look-at target around the camera (yaw/pitch feel)
const STEP_FOV = 0.5;

export class CameraRegister {
  /** @param director the live CameraDirector (reads/writes its current view's camera in place).
   *  @param overlayCanvas the #cam-register-overlay 2D canvas (HUD text only -- the wireframes are real 3D
   *    geometry in room.proxiesGroup, drawn by the normal WebGL pass).
   *  @param zumiRoomsV2 { saveView(id, view, camera) => Promise } -- the dev-only IPC surface (preload.js). */
  constructor({ director, overlayCanvas, zumiRoomsV2, t }) {
    this.director = director;
    this.canvas = overlayCanvas;
    this.ctx = overlayCanvas ? overlayCanvas.getContext('2d') : null;
    this.zumiRoomsV2 = zumiRoomsV2;
    this.t = t || ((k) => k);
    this.active = false;
    this.roomId = null;
    this.status = '';
    this.onKey = this.onKey.bind(this);
  }

  setRoom(roomId) { this.roomId = roomId; }

  toggle(on) {
    this.active = on != null ? Boolean(on) : !this.active;
    if (this.canvas) this.canvas.hidden = !this.active;
    if (this.director.room) this.director.room.proxiesGroup.visible = this.active;
    if (this.active) { this.director.jumpToView(this.director.view); window.addEventListener('keydown', this.onKey); }
    else window.removeEventListener('keydown', this.onKey);
    this.draw();
    return this.active;
  }

  // ---------- keyboard nudges: arrows = pos XZ, Q/E = pos Y, I/K/J/L = target pitch/yaw, -/+ = fov, Tab = cycle view, S = save ----------
  onKey(e) {
    if (!this.active || !this.director.room) return;
    const cam = this.director.room.views[this.director.view].camera;
    const mul = e.shiftKey ? 5 : 1;
    const dp = STEP_POS * mul, dd = STEP_DEG * mul, df = STEP_FOV * mul;
    let handled = true;
    switch (e.key) {
      case 'ArrowUp': cam.position.z -= dp; break;
      case 'ArrowDown': cam.position.z += dp; break;
      case 'ArrowLeft': cam.position.x -= dp; break;
      case 'ArrowRight': cam.position.x += dp; break;
      case 'q': case 'Q': cam.position.y -= dp; break;
      case 'e': case 'E': cam.position.y += dp; break;
      case 'j': case 'J': cam.target.x -= dp; break;
      case 'l': case 'L': cam.target.x += dp; break;
      case 'i': case 'I': cam.target.y += dp; break;
      case 'k': case 'K': cam.target.y -= dp; break;
      case '-': case '_': cam.fov = Math.max(4, cam.fov - df); break;
      case '=': case '+': cam.fov = Math.min(120, cam.fov + df); break;
      case 'Tab': { const order = ['talk', 'work', 'room']; const next = order[(order.indexOf(this.director.view) + 1) % order.length]; this.director.jumpToView(next); break; }
      case 's': case 'S': this.save(); break;
      default: handled = false;
    }
    if (handled) { if (e.key !== 'Tab' && e.key !== 's' && e.key !== 'S') this.director.jumpToView(this.director.view); e.preventDefault(); this.draw(); }
  }

  async save() {
    if (!this.zumiRoomsV2 || !this.roomId) { this.status = 'no save path (not a saved v2 room)'; this.draw(); return; }
    const cam = this.director.room.views[this.director.view].camera;
    const payload = { pos: [cam.position.x, cam.position.y, cam.position.z], target: [cam.target.x, cam.target.y, cam.target.z], fov: cam.fov };
    try {
      await this.zumiRoomsV2.saveView(this.roomId, this.director.view, payload);
      this.status = this.t('camReg.saved');
    } catch (e) {
      this.status = this.t('camReg.saveFailed', { error: String((e && e.message) || e) });
    }
    this.draw();
  }

  draw() {
    if (!this.ctx || !this.active) return;
    const w = this.canvas.width, h = this.canvas.height;
    this.ctx.clearRect(0, 0, w, h);
    if (!this.director.room) return;
    const cam = this.director.room.views[this.director.view].camera;
    const lines = [
      `[registration] view=${this.director.view}  (Tab=cycle, S=save)`,
      `pos  x=${cam.position.x.toFixed(3)} y=${cam.position.y.toFixed(3)} z=${cam.position.z.toFixed(3)}  (arrows, Q/E)`,
      `target x=${cam.target.x.toFixed(3)} y=${cam.target.y.toFixed(3)} z=${cam.target.z.toFixed(3)}  (I/K/J/L)`,
      `fov  ${cam.fov.toFixed(1)}  (-/+)`,
      this.status,
    ];
    this.ctx.font = '13px monospace';
    this.ctx.textBaseline = 'top';
    // Design tokens, not hardcoded colours (check:palette): resolved from the page's own CSS custom properties at
    // draw time, same source every other panel in this app reads its colours from (vendor/laneboard tokens.css).
    const root = getComputedStyle(document.documentElement);
    const bg = root.getPropertyValue('--foreground').trim();
    const fg = root.getPropertyValue('--success').trim();
    lines.forEach((line, i) => {
      if (!line) return;
      const y = 10 + i * 18;
      this.ctx.fillStyle = bg;
      this.ctx.globalAlpha = 0.72;
      this.ctx.fillRect(8, y - 2, this.ctx.measureText(line).width + 12, 16);
      this.ctx.globalAlpha = 1;
      this.ctx.fillStyle = fg;
      this.ctx.fillText(line, 14, y);
    });
  }
}
