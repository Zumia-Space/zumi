// Video rooms (T-31 room picker, 13-10): a looping room video that stands in for the talk view's painted plate.
// Drawn by CameraDirector.drawPlate() into #stage-plate -- the SAME canvas the plate uses, which sits under
// #stage-canvas (the WebGL avatar) -- with the SAME crop window as the plate, so the camera, seat, occluders and
// chest-up framing all stay exactly as approved; only the pixels behind her change. The videos were made with the
// chair removed: the plate's painted chair is drawn back over the video only while `drawChair` is set (app.js clears
// it whenever a 3D chair is attached, so the cut-out never shows next to, or instead of, the real chair).
// Geometry lives in assets/rooms-video/rooms.json (see its _comment); this module never touches the DOM layout.

/** The video frame's rectangle in the talk plate's pixel space: placed at `identity`, scaled by framing.scale
 *  about `pivot` (the camera's horizon row), then shifted by framing.offsetX/offsetY. Pure (unit-tested). */
export function sceneVideoRect(geometry, framing) {
  const [vw, vh] = geometry.videoSize, [ix, iy] = geometry.identity, [px, py] = geometry.pivot;
  const s = framing.scale;
  return { x: px + (ix - px) * s + framing.offsetX, y: py + (iy - py) * s + framing.offsetY, w: vw * s, h: vh * s };
}

/** A plate-space rectangle mapped into the canvas through the plate's crop window `crop` ({x,y,w,h}, plate px). */
export function plateRectToCanvas(rect, crop, canvasW, canvasH) {
  const kx = canvasW / crop.w, ky = canvasH / crop.h;
  return { x: (rect.x - crop.x) * kx, y: (rect.y - crop.y) * ky, w: rect.w * kx, h: rect.h * ky };
}

/** True when `outer` fully contains `inner` (both {x,y,w,h}) -- i.e. no edge of the video shows in the window. */
export function rectCovers(outer, inner, eps = 1e-6) {
  return outer.x <= inner.x + eps && outer.y <= inner.y + eps
    && outer.x + outer.w >= inner.x + inner.w - eps && outer.y + outer.h >= inner.y + inner.h - eps;
}

/** How long a new room video may take to decode its first frame (after its file is already in memory as a Blob) before the
 *  load is abandoned and treated like a load error. Local decode of the 1.5-4.6 MB rooms took <= 12 render frames (~0.5 s) at
 *  worst in the 0.2.9 captures (C05c) and the room-picker harness waits 3 s for a first frame; 10 s is 20x that, so a slow disk
 *  or a cold decoder never trips it, yet a video that neither loads nor errors cannot pin the old room up forever. */
export const VIDEO_LOAD_TIMEOUT_MS = 10_000;

/** How long a PLAYING room video may go without any progress (currentTime or decoded-frame count unchanged) before it is
 *  declared frozen and falls back like a load error. A loop restart seek costs 1-3 render frames (~50 ms) and a first decode
 *  <= 0.5 s (0.2.9 captures), and the clock of a healthy video advances every poll, so 5 s is 10x the worst legitimate gap
 *  while still half the load timeout: a frozen frame is gone in ~5-6 s instead of staying up forever. */
export const VIDEO_STALL_MS = 5_000;
const STALL_POLL_MS = 1_000; // watchdog period: detection lands within VIDEO_STALL_MS + one poll

/** A progress stamp: the video clock plus the decoder's frame counter where the browser exposes one (Chromium does). The
 *  frame counter also covers a loop shorter than the poll period, where currentTime could alias to the same value. */
const progressOf = (v) => ({ time: v.currentTime, frames: typeof v.getVideoPlaybackQuality === 'function' ? v.getVideoPlaybackQuality().totalVideoFrames : -1 });

export class SceneVideo {
  constructor() {
    this.room = null;      // the listed room ({id, url, framing}) currently loaded, or null
    this.geometry = null;  // rooms.json geometry from scenes:list
    this.video = null;
    this.objectUrl = null;
    this.chair = null;     // ImageBitmap of the plate's chair cut-out
    this.visible = true;   // window visible (main's window:visible + document visibility)
    this.drawChair = true; // draw the painted chair cut-out (false while a 3D chair is attached, app.js applyChair)
    this.token = 0;
    this.drawn = false;    // a real video frame has been painted into the plate canvas (so there is a frame to hold)
    this.onStall = null;   // () => void, called after a frozen video was released: the owner switches the stage back to the plate
    this.stallMs = VIDEO_STALL_MS;
    this.stallTimer = null;
    this.progress = null;  // { time, frames, at } the last time the video was seen advancing (or the last time nothing was owed)
  }

  get active() { return Boolean(this.room); }
  /** Ready to draw a real frame (until then CameraDirector keeps drawing the plate, so nothing flashes empty). */
  get ready() { return Boolean(this.room && this.chair && this.video && this.video.readyState >= 2); }

  /** The video has no current frame for a moment (loop restart: the seek back to 0 drops readyState below 2 for 1-3 frames)
   *  but its last frame is still on the plate canvas. CameraDirector then leaves the canvas untouched instead of
   *  falling back to the painted B plate (0.2.9 captures C02-E f00075; T-31 0.2.11). */
  get holding() { return Boolean(this.room && this.video && this.drawn && this.video.readyState < 2); }

  /** Loads `room` (null = back to the painted room). Whole file fetched once into a Blob: the app:// handler serves
   *  whole files, and a Blob URL gives the <video> element free seeking for its loop. Never throws. */
  async load(room, geometry) {
    const token = ++this.token;
    if (!room || !geometry) { this.unload(); return false; }
    // The OLD room keeps playing (and drawing) until the new video's first frame is decoded: unload() only runs at the
    // swap below, so a room switch never exposes the painted B plate while the next file loads (captures C05a/C05c).
    let video = null, objectUrl = null;
    try {
      if (!this.chairUrl || this.chairUrl !== geometry.chair.url) {
        this.chair = await createImageBitmap(await (await fetch(geometry.chair.url)).blob());
        this.chairUrl = geometry.chair.url;
      }
      const blob = await (await fetch(room.url)).blob();
      if (token !== this.token) return false;
      video = document.createElement('video');
      video.muted = true; video.loop = true; video.playsInline = true; video.preload = 'auto';
      video.setAttribute('aria-hidden', 'true');
      objectUrl = URL.createObjectURL(blob);
      video.src = objectUrl;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no first frame after ${VIDEO_LOAD_TIMEOUT_MS} ms`)), VIDEO_LOAD_TIMEOUT_MS);
        video.addEventListener('loadeddata', () => { clearTimeout(timer); resolve(); }, { once: true });
        video.addEventListener('error', () => { clearTimeout(timer); reject(video.error); }, { once: true });
      });
      if (token !== this.token) { SceneVideo.discard(video, objectUrl); return false; }
      this.unload();
      this.video = video; this.objectUrl = objectUrl; this.room = room; this.geometry = geometry;
      this.syncPlayback();
      return true;
    } catch (e) {
      console.error('video room: load failed', room && room.id, e);
      if (video) SceneVideo.discard(video, objectUrl);
      if (token === this.token) this.unload();
      return false;
    }
  }

  static discard(video, objectUrl) {
    video.pause(); video.removeAttribute('src'); video.load();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }

  unload() {
    if (this.video) SceneVideo.discard(this.video, this.objectUrl);
    this.disarmWatchdog();
    this.video = null; this.objectUrl = null; this.room = null; this.drawn = false;
  }

  setVisible(on) { this.visible = Boolean(on); this.syncPlayback(); }

  syncPlayback() {
    if (!this.video) return;
    if (this.visible) this.play(this.video, 1);
    else this.video.pause();
    this.armWatchdog(); // pause/resume are on purpose: the stall clock restarts from here, hidden time is never counted
  }

  /** play() with one retry. Only a hidden window pauses on purpose, so a play() the browser refuses while visible would leave the
   *  last frame frozen forever: after the retry is refused too, fall back at once (same path as a stall). A rejection that lands
   *  after the window was hidden or the video was swapped (AbortError from our own pause()) is not a failure. */
  play(video, retries) {
    const p = video.play();
    if (!p || !p.catch) return;
    p.catch((e) => {
      if (video !== this.video || !this.visible) return;
      if (retries > 0) { console.warn('video room: play() rejected, retrying', e); this.play(video, retries - 1); return; }
      console.error('video room: play() rejected while visible', this.room && this.room.id, e);
      this.release();
    });
  }

  /** Frozen or refused video: unload() frees the video + blob, the owner (`onStall`) puts the painted plate back. */
  release() {
    this.unload();
    if (this.onStall) this.onStall();
  }

  // Stall watchdog: a video that is supposed to be playing but shows no progress for `stallMs` has frozen on its last frame
  // (no error, no 'ended'), which neither the load timeout nor the load-error path can see. It is released and handed to the
  // owner (`onStall`) exactly like a failed load: unload() frees the video + blob, the owner puts the painted plate back.
  armWatchdog() {
    this.disarmWatchdog();
    if (!this.video) return;
    this.markProgress();
    this.stallTimer = setInterval(() => this.checkStall(), STALL_POLL_MS);
  }
  disarmWatchdog() { if (this.stallTimer !== null) { clearInterval(this.stallTimer); this.stallTimer = null; } }
  markProgress() { this.progress = { ...progressOf(this.video), at: performance.now() }; }
  checkStall() {
    const v = this.video;
    if (!v) return;
    if (!this.visible) { this.markProgress(); return; } // hidden window pauses on purpose: nothing is owed. Paused while visible is NOT on purpose (play() refused): judged like a frozen frame
    const now = progressOf(v);
    if (now.time !== this.progress.time || now.frames !== this.progress.frames) { this.progress = { ...now, at: performance.now() }; return; }
    if (performance.now() - this.progress.at < this.stallMs) return;
    console.error('video room: stalled, no frame for', this.stallMs, 'ms', this.room && this.room.id);
    this.release();
  }

  /** Draws the current video frame (+ the painted chair when `drawChair`) into `ctx` through the plate's crop window
   *  `crop` (plate px). */
  draw(ctx, crop, canvasW, canvasH) {
    const v = plateRectToCanvas(sceneVideoRect(this.geometry, this.room.framing), crop, canvasW, canvasH);
    ctx.drawImage(this.video, v.x, v.y, v.w, v.h);
    this.drawn = true;
    if (!this.drawChair) return;
    const c = plateRectToCanvas({ x: this.geometry.chair.x, y: this.geometry.chair.y, w: this.chair.width, h: this.chair.height }, crop, canvasW, canvasH);
    ctx.drawImage(this.chair, c.x, c.y, c.w, c.h);
  }
}
