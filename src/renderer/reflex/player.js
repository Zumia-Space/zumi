// GesturePlayer — the ONE player for every GestureCommand.
// Each frame it evaluates all live instances into a channel accumulator (bones / expressions / gaze /
// IK reach / clip requests). It knows nothing about triggers; the engine maps triggers -> commands.
import { validateGesture, LOOK_TARGETS } from './schema.js';

const DEG = Math.PI / 180;
const FADE_MS = 180; // interrupt fade-out
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const easeOut = (x) => 1 - (1 - x) * (1 - x);
const smooth = (x) => x * x * (3 - 2 * x);

const swapSide = (name) => (name.startsWith('left') ? 'right' + name.slice(4) : name.startsWith('right') ? 'left' + name.slice(5) : name);
const swapBlink = (name) => (name === 'blinkLeft' ? 'blinkRight' : name === 'blinkRight' ? 'blinkLeft' : name);

// True when a command drives the face (expressions) and nothing else -- no body, gaze, reach, root, hands, clip
// or follow. That shape is the held-emotion layer the talk director plays under a spoken reply (T-31 0.2.3 B2
// item 1): unlike every other sustained layer it must NOT be ducked by a one-shot body gesture, or the face would
// sag while Zumi gestures and only recover afterwards -- the whole point is that the face holds throughout. Works
// on a raw command (absent channels are undefined) and on a normalized one (absent channels are empty / null).
export function isFaceOnly(cmd) {
  if (cmd === null || typeof cmd !== 'object' || Array.isArray(cmd)) return false;
  const on = (v) => (Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null);
  if (on(cmd.clip) || on(cmd.follow) || on(cmd.moves) || on(cmd.bones) || on(cmd.lookAt) || on(cmd.reach) || on(cmd.root) || on(cmd.hands)) return false;
  return on(cmd.expressions);
}

function wave(o, tMs) {
  const p = (o.hz * tMs) / 1000 + o.phase;
  switch (o.wave) {
    case 'saw': return p - Math.floor(p);
    case 'pulse': return Math.max(0, Math.sin(2 * Math.PI * p));
    case 'square': return Math.sin(2 * Math.PI * p) >= 0 ? 1 : -1;
    case 'triangle': { const f = p - Math.floor(p); return f < 0.5 ? 4 * f - 1 : 3 - 4 * f; }
    default: return Math.sin(2 * Math.PI * p);
  }
}

// Envelope of one element at instance-local time t (ms). releaseRel = ms at which a sustained
// instance was released (null while still held).
function envelope(el, t, releaseRel) {
  const u = t - el.delayMs;
  if (u < 0) return 0;
  const attack = (x) => (el.inMs <= 0 ? 1 : x < el.inMs ? easeOut(x / el.inMs) : 1);
  let outStart = el.holdMs < 0 ? Infinity : el.inMs + el.holdMs;
  if (releaseRel != null) outStart = Math.min(outStart, Math.max(0, releaseRel - el.delayMs));
  if (u < outStart) return attack(u);
  const v0 = attack(outStart);
  const k = el.outMs <= 0 ? 1 : (u - outStart) / el.outMs;
  return k >= 1 ? 0 : v0 * (1 - smooth(k));
}

// PCHIP (Fritsch-Carlson) tangent for component c at every key of a keyed element. The interior harmonic mean of
// the two secants -- zero at a sign change or a flat side -- is shape-preserving: the Hermite curve built from it
// never leaves the [min,max] of the two keys it spans, so a flat-then-rise key set no longer dips below its own
// keys (T-31 0.2.3 B2 item 3). Ends stay flat, exactly as before, so the authored ease-in/out feel is untouched;
// only the interior slope rule changed (Catmull-Rom's central difference -> harmonic mean).
export function pchipTangents(keys, c) {
  const n = keys.length;
  const h = [], d = [];
  for (let k = 0; k < n - 1; k++) { const dt = keys[k + 1].t - keys[k].t; h.push(dt); d.push((keys[k + 1].v[c] - keys[k].v[c]) / dt); }
  const m = new Array(n).fill(0); // flat at both ends
  for (let k = 1; k < n - 1; k++) {
    const a = d[k - 1], b = d[k];
    if (a === 0 || b === 0 || Math.sign(a) !== Math.sign(b)) continue;
    const w1 = 2 * h[k] + h[k - 1], w2 = h[k] + 2 * h[k - 1];
    m[k] = (w1 + w2) / (w1 / a + w2 / b);
  }
  return m;
}

// Keyed elements: cubic Hermite through the keys (PCHIP interior slopes, flat at both ends), held at the last
// key; the envelope (1 across the keys) fades that held value out. The tangents are computed once per key set and
// cached on it (a keyed command's `keys` array is built once by the validator and never mutated).
function sampleKeys(keys, u, out) {
  const n = keys.length;
  if (u <= keys[0].t || n === 1) { out[0] = keys[0].v[0]; out[1] = keys[0].v[1]; out[2] = keys[0].v[2]; return out; }
  if (u >= keys[n - 1].t) { const v = keys[n - 1].v; out[0] = v[0]; out[1] = v[1]; out[2] = v[2]; return out; }
  let i = 0;
  while (keys[i + 1].t < u) i++;
  const k0 = keys[i], k1 = keys[i + 1], h = k1.t - k0.t, s = (u - k0.t) / h;
  const s2 = s * s, s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1, h10 = s3 - 2 * s2 + s, h01 = -2 * s3 + 3 * s2, h11 = s3 - s2;
  const m = keys._pchip || (keys._pchip = [pchipTangents(keys, 0), pchipTangents(keys, 1), pchipTangents(keys, 2)]);
  for (let c = 0; c < 3; c++) out[c] = h00 * k0.v[c] + h10 * h * m[c][i] + h01 * k1.v[c] + h11 * h * m[c][i + 1];
  return out;
}

// Static value of a bone/root element at time t, already multiplied by its envelope e.
const _kv = [0, 0, 0];
function baseVec(el, field, t, e) {
  const v = el.keys ? sampleKeys(el.keys, t - el.delayMs, _kv) : el[field];
  return [v[0] * e, v[1] * e, v[2] * e];
}

function elementEnd(el, releaseRel) {
  let outStart = el.holdMs < 0 ? Infinity : el.inMs + el.holdMs;
  if (releaseRel != null) outStart = Math.min(outStart, Math.max(0, releaseRel - el.delayMs));
  return el.delayMs + outStart + el.outMs;
}

export class ChannelAcc {
  constructor() { this.bones = {}; this.expr = {}; this.reach = []; this.clips = []; this.root = [0, 0, 0]; this.hands = { left: {}, right: {} }; this.reset(); }
  reset() {
    for (const k in this.bones) { const v = this.bones[k]; v[0] = v[1] = v[2] = 0; }
    for (const k in this.expr) this.expr[k] = 0;
    this.reach.length = 0;
    this.clips.length = 0;
    this.root[0] = this.root[1] = this.root[2] = 0;
    this.rootActive = false; // any root element live this frame -> leg IK keeps the feet planted
    for (const side of ['left', 'right']) for (const k in this.hands[side]) this.hands[side][k] = 0;
    this.gx = 0; this.gy = 0; this.gw = 0; this.gCursorW = 0;
    this.mag = 0; // running magnitude of everything written (used to detect "reaction has started")
  }
  bone(name, x, y, z) {
    const v = this.bones[name] || (this.bones[name] = [0, 0, 0]);
    v[0] += x; v[1] += y; v[2] += z;
    this.mag += Math.abs(x) + Math.abs(y) + Math.abs(z);
  }
  expression(name, v) { this.expr[name] = (this.expr[name] || 0) + v; this.mag += Math.abs(v); }
  rootPos(x, y, z) {
    this.root[0] += x; this.root[1] += y; this.root[2] += z;
    this.rootActive = true;
    this.mag += Math.abs(x) + Math.abs(y) + Math.abs(z);
  }
  hand(side, shape, w) { const h = this.hands[side]; h[shape] = (h[shape] || 0) + w; this.mag += w * 0.05; }
  gaze(x, y, w) { this.gx += x * w; this.gy += y * w; this.gw += w; this.mag += w * 0.05; }
  gazeCursor(w) { this.gCursorW += w; this.gw += w; this.mag += w * 0.05; }
}

export class GesturePlayer {
  constructor({ random = Math.random, now = () => performance.now(), clipAvailable = () => false } = {}) {
    this.random = random;
    this.now = now;
    this.clipAvailable = clipAvailable;
    this.instances = [];
    this.seq = 0;
    this.onFollow = null; // set by engine
  }

  // opts: { side?: 1|-1 (mirror override), meta?: any, noJitter?: bool }
  play(command, opts = {}) {
    const v = validateGesture(command);
    if (!v.ok) return { ok: false, errors: v.errors, warnings: v.warnings };
    const cmd = v.command;
    const warnings = [...v.warnings];
    if (cmd.clip && !this.clipAvailable(cmd.clip.name)) warnings.push(`clip '${cmd.clip.name}' not found in clips folder; other channels still play`);
    const now = this.now();
    let side = 1;
    if (cmd.mirror === 'random') side = opts.side != null ? (opts.side < 0 ? -1 : 1) : this.random() < 0.5 ? -1 : 1;
    const j = opts.noJitter ? 0 : cmd.jitter;
    const inst = {
      id: ++this.seq,
      cmd,
      side,
      amp: 1 + (this.random() * 2 - 1) * j,
      speed: 1 + (this.random() * 2 - 1) * j * 0.5,
      start: now,
      releaseAt: null,
      fadeStart: null,
      // one-shot gaze point for a 'dynamic' lookAt target (T-31 0.2.3 A1); null = the target is skipped this play
      look: opts.look && Number.isFinite(opts.look.x) && Number.isFinite(opts.look.y) ? { x: opts.look.x, y: opts.look.y } : null,
      meta: opts.meta || null,
      priority: cmd.priority,
      lastMag: 0,
    };
    if (cmd.interrupt) {
      for (const other of this.instances) {
        if (other.fadeStart == null && !other.cmd.sustain && other.priority <= cmd.priority) other.fadeStart = now;
      }
    }
    if (cmd.follow && this.onFollow) this.onFollow(cmd.follow, side);
    this.instances.push(inst);
    return { ok: true, id: inst.id, warnings, side, startedAt: now };
  }

  release(id) { const i = this.find(id); if (i && i.releaseAt == null) i.releaseAt = this.now(); }
  stop(id) { const i = this.find(id); if (i && i.fadeStart == null) i.fadeStart = this.now(); }
  stopAll(hard = false) {
    if (hard) { this.instances.length = 0; return; }
    const now = this.now();
    for (const i of this.instances) if (i.fadeStart == null) i.fadeStart = now;
  }
  find(id) { return this.instances.find((i) => i.id === id) || null; }
  /** Drop matching live instances immediately (no fade). The float-holo panel appearing under a reach already in
   *  flight must not let that reach finish through the panel (T-31 0.2.6); the dispatch gate only sees new commands. */
  cancelWhere(pred) {
    const before = this.instances.length;
    this.instances = this.instances.filter((i) => !pred(i.cmd));
    return before - this.instances.length;
  }
  isActive(id) { return Boolean(this.find(id)); }

  localTime(inst, now) { return (now - inst.start) * inst.speed; }

  // Rough 0..1 "how present is this one-shot right now" used to duck sustained layers under it.
  presence(inst, now) {
    const t = this.localTime(inst, now);
    const end = this.duration(inst);
    const fade = inst.fadeStart == null ? 1 : 1 - clamp01((now - inst.fadeStart) / FADE_MS);
    return clamp01(t / 150) * clamp01((end - t) / 250) * fade;
  }

  duration(inst) {
    const rel = inst.releaseAt == null ? null : (inst.releaseAt - inst.start) * inst.speed;
    const c = inst.cmd;
    let end = 0;
    for (const list of [c.expressions, c.bones, c.lookAt, c.reach, c.root, c.hands]) for (const el of list) end = Math.max(end, elementEnd(el, rel));
    if (c.clip) end = Math.max(end, elementEnd(c.clip, rel));
    return end;
  }

  evaluate(acc, now = this.now()) {
    // ducking: sustained layers yield to live one-shots of equal/higher priority
    let duckByPriority = [];
    for (const i of this.instances) if (!i.cmd.sustain && i.cmd.interrupt) duckByPriority.push([i.priority, this.presence(i, now)]);

    for (let n = this.instances.length - 1; n >= 0; n--) {
      const inst = this.instances[n];
      const t = this.localTime(inst, now);
      const end = this.duration(inst);
      let w = 1;
      if (inst.fadeStart != null) {
        w = 1 - clamp01((now - inst.fadeStart) / FADE_MS);
        if (w <= 0) { this.instances.splice(n, 1); continue; }
      }
      if (t > end) { this.instances.splice(n, 1); continue; }
      if (inst.cmd.sustain) {
        // a held face-only emotion is not a body layer: a live body gesture must not duck it (B2 item 1)
        if (!isFaceOnly(inst.cmd)) {
          let duck = 0;
          for (const [p, pres] of duckByPriority) if (p >= inst.priority) duck = Math.max(duck, pres);
          w *= 1 - 0.75 * duck;
        }
      }
      const before = acc.mag;
      this.evalInstance(inst, t, w, acc);
      inst.lastMag = acc.mag - before;
    }
  }

  evalInstance(inst, t, w, acc) {
    const c = inst.cmd;
    const rel = inst.releaseAt == null ? null : (inst.releaseAt - inst.start) * inst.speed;
    const m = inst.side;
    const a = inst.amp * w;

    for (const el of c.expressions) {
      const e = envelope(el, t, rel);
      if (e <= 0) continue;
      let v = el.weight * e;
      if (el.osc) v += el.osc.amp * wave(el.osc, t - el.delayMs) * e;
      acc.expression(m < 0 ? swapBlink(el.name) : el.name, Math.max(0, v) * a);
    }
    for (const el of c.bones) {
      const e = envelope(el, t, rel);
      if (e <= 0) continue;
      let [x, y, z] = baseVec(el, 'rot', t, e);
      if (el.osc) {
        const s = wave(el.osc, t - el.delayMs) * e;
        x += el.osc.amp[0] * s; y += el.osc.amp[1] * s; z += el.osc.amp[2] * s;
      }
      const name = m < 0 ? swapSide(el.bone) : el.bone;
      acc.bone(name, x * DEG * a, y * DEG * a * m, z * DEG * a * m);
    }
    for (const el of c.lookAt) {
      const e = envelope(el, t, rel);
      if (e <= 0) continue;
      let gw = el.weight * e;
      if (el.osc) gw += el.osc.amp * wave(el.osc, t - el.delayMs) * e;
      gw = clamp01(gw) * w;
      if (gw <= 0) continue;
      if (el.target === 'cursor') { acc.gazeCursor(gw); continue; }
      let xy;
      if (el.target === 'dynamic') { if (!inst.look) continue; xy = [inst.look.x, inst.look.y]; } // one-shot point (A1); skipped when none was passed
      else xy = typeof el.target === 'string' ? LOOK_TARGETS[el.target] : [el.target.x, el.target.y];
      acc.gaze(xy[0] * m, xy[1], gw);
    }
    for (const el of c.reach) {
      const e = envelope(el, t, rel);
      if (e <= 0) continue;
      let off = null;
      if (el.osc) { const s = wave(el.osc, t - el.delayMs); off = [el.osc.amp[0] * s, el.osc.amp[1] * s, el.osc.amp[2] * s]; }
      const hand = m < 0 ? (el.hand === 'left' ? 'right' : 'left') : el.hand;
      const rw = el.weight * e * w;
      acc.reach.push({ hand, target: el.target, weight: rw, offset: off, mirror: m });
      acc.mag += rw * 0.3;
    }
    for (const el of c.root) {
      const e = envelope(el, t, rel);
      if (e <= 0) continue;
      let [x, y, z] = baseVec(el, 'pos', t, e);
      if (el.osc) {
        const s = wave(el.osc, t - el.delayMs) * e;
        x += el.osc.amp[0] * s; y += el.osc.amp[1] * s; z += el.osc.amp[2] * s;
      }
      acc.rootPos(x * a * m, y * a, z * a);
    }
    for (const el of c.hands) {
      const e = envelope(el, t, rel);
      if (e <= 0) continue;
      acc.hand(m < 0 ? (el.hand === 'left' ? 'right' : 'left') : el.hand, el.shape, el.weight * e * w);
    }
    if (c.clip) {
      const e = envelope(c.clip, t, rel);
      if (e > 0) {
        acc.clips.push({ name: c.clip.name, weight: c.clip.weight * e * w, timeSec: (Math.max(0, t - c.clip.delayMs) / 1000) * c.clip.speed, loop: c.clip.loop });
        acc.mag += c.clip.weight * e * w * 0.3;
      }
    }
  }
}
