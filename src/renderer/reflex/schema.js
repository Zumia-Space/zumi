// GestureCommand schema — the ONE contract every reaction goes through
// (built-in trigger variants from gestures/*.json and, later, LLM-authored commands via `gesture:play`).
//
// Unknown fields and wrong types are rejected (ok:false). Out-of-range numbers are clamped and reported
// in `warnings`. The validator returns a normalized deep copy with defaults filled in; the player only
// ever sees normalized commands.
//
// Conventions (VRM 1.0 normalized humanoid, model faces the camera):
//   rot [x,y,z] in DEGREES, additive on top of the idle pose.
//   x+ = bend forward / nod down, y+ = turn toward screen-right, z+ = tilt top toward screen-left.
//   lookAt {x,y} is in stage NDC (-1..1 = stage edges; the sidebar sits near x=-1.6, the text box near y=-1.2).
//   reach pos [out, up, fwd]: 'shoulder' frame in arm lengths, 'head' frame in shoulder widths.
//   root pos [x, y, z]: hips translation in hip heights, x+ = screen-right, y+ = up, z+ = toward the viewer.
//     Feet stay planted by leg IK while it is active: lowering the hips bends the knees, raising them
//     above standing height lifts the feet (a jump).
//   keys (bones / root): [{t, rot|pos}] keyframes, t in ms after delayMs, smooth curve through them; an
//     implicit zero key sits at t=0 when the first key is later, and after the last key the value eases
//     back to 0 over outMs. A keyed element carries its own timing, so rot/pos, inMs and holdMs are not allowed.
//   hands {hand, shape}: finger pose blended over the rest (flat) hand.

export const BONE_LIMITS_DEG = {
  hips: [20, 30, 15],
  spine: [25, 30, 20],
  chest: [25, 30, 20],
  upperChest: [20, 25, 15],
  neck: [30, 45, 25],
  head: [40, 60, 35],
  leftShoulder: [15, 20, 25],
  rightShoulder: [15, 20, 25],
  leftUpperArm: [90, 90, 120],
  rightUpperArm: [90, 90, 120],
  leftLowerArm: [40, 150, 40],
  rightLowerArm: [40, 150, 40],
  leftHand: [60, 60, 60],
  rightHand: [60, 60, 60],
};

export const EXPRESSIONS = ['happy', 'angry', 'sad', 'relaxed', 'surprised', 'aa', 'ih', 'ou', 'ee', 'oh', 'blink', 'blinkLeft', 'blinkRight'];

// Named gaze targets in stage NDC. 'cursor' = follow the pointer (counteracts other overrides).
// 'dynamic' = no fixed point: the caller supplies a one-shot {x, y} per play (player.js instance `look`), so a reaction
// can look at the exact task card that changed (T-31 0.2.3 A1). It is skipped when no point is supplied, so a variant
// that only gazes 'dynamic' still validates and still plays its other channels.
export const LOOK_TARGETS = {
  camera: [0, 0.05],
  sidebar: [-1.6, 0.35],
  down: [0, -1.2],
  up: [0, 1.2],
  'away-left': [-1.2, -0.3],
  'away-right': [1.2, -0.3],
  cursor: null,
  dynamic: null,
};

// Named IK hand targets; resolved per model in rig.js (body-relative, so they fit every VRM).
export const REACH_TARGETS = ['rest', 'wave', 'beside-head', 'wave-small', 'chin', 'mouth', 'face', 'eye', 'hip', 'chest', 'clasp', 'overhead',
  'point-screen-right', 'point-screen-left', 'point-viewer', 'point-up', 'point-sidebar', 'point-camera', 'point-out'];

// Procedural moves, expanded by the validator into ordinary bone tracks (so the player needs nothing new):
//   nod:  head + neck pitch, `beats` dips of `deg` degrees, one per `beatMs`.
//   turn: upper-body yaw of `deg` degrees (+ = toward screen-right) shared by spine, chest, neck and head.
export const MOVES = ['nod', 'turn'];

// Finger poses; curl angles per shape live in rig.js.
export const HAND_SHAPES = ['open', 'open-flat', 'loose', 'relaxed', 'fist', 'point', 'thumbsUp'];

// root pos limits [x, y, z] in hip heights.
export const ROOT_LIMITS = [0.25, 0.3, 0.25];

const WAVES = ['sine', 'saw', 'pulse', 'square', 'triangle'];
const MS_MAX = 20000;
const MAX_ELEMENTS = 24;
const MAX_KEYS = 16;

const TOP_KEYS = ['id', 'label', 'priority', 'interrupt', 'sustain', 'mirror', 'jitter', 'follow', 'moves', 'expressions', 'bones', 'lookAt', 'reach', 'root', 'hands', 'clip'];
const TIMING_KEYS = ['delayMs', 'inMs', 'holdMs', 'outMs'];
const EXPR_KEYS = ['name', 'weight', 'osc', ...TIMING_KEYS];
const BONE_KEYS = ['bone', 'rot', 'keys', 'osc', ...TIMING_KEYS];
const ROOT_KEYS = ['pos', 'keys', 'osc', ...TIMING_KEYS];
const HAND_KEYS = ['hand', 'shape', 'weight', ...TIMING_KEYS];
const MOVE_KEYS = ['move', 'beats', 'deg', 'beatMs', ...TIMING_KEYS];
const LOOK_KEYS = ['target', 'weight', 'ms', 'osc', ...TIMING_KEYS];
const REACH_KEYS = ['hand', 'target', 'weight', 'osc', ...TIMING_KEYS];
const CLIP_KEYS = ['name', 'weight', 'speed', 'loop', ...TIMING_KEYS];
const FOLLOW_KEYS = ['head', 'spine', 'rate', 'tilt'];
const OSC_KEYS = ['hz', 'amp', 'wave', 'phase'];

const DEFAULT_TIMING = { delayMs: 0, inMs: 150, holdMs: 400, outMs: 250 };

class Ctx {
  constructor() { this.errors = []; this.warnings = []; }
  err(path, msg) { this.errors.push(`${path}: ${msg}`); }
  warn(path, msg) { this.warnings.push(`${path}: ${msg}`); }
  keys(obj, allowed, path) {
    if (!isObj(obj)) { this.err(path, 'must be an object'); return false; }
    for (const k of Object.keys(obj)) if (!allowed.includes(k)) this.err(`${path}.${k}`, 'unknown field');
    return true;
  }
  num(v, path, lo, hi, def) {
    if (v === undefined) return def;
    if (typeof v !== 'number' || !Number.isFinite(v)) { this.err(path, 'must be a finite number'); return def; }
    if (v < lo || v > hi) { this.warn(path, `clamped ${v} to [${lo}, ${hi}]`); return Math.min(hi, Math.max(lo, v)); }
    return v;
  }
  bool(v, path, def) {
    if (v === undefined) return def;
    if (typeof v !== 'boolean') { this.err(path, 'must be a boolean'); return def; }
    return v;
  }
  str(v, path, def) {
    if (v === undefined) return def;
    if (typeof v !== 'string' || v.length > 80) { this.err(path, 'must be a string (<= 80 chars)'); return def; }
    return v;
  }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function timing(ctx, el, path, sustain) {
  const t = {
    delayMs: ctx.num(el.delayMs, `${path}.delayMs`, 0, MS_MAX, DEFAULT_TIMING.delayMs),
    inMs: ctx.num(el.inMs, `${path}.inMs`, 0, MS_MAX, DEFAULT_TIMING.inMs),
    holdMs: ctx.num(el.holdMs, `${path}.holdMs`, -1, MS_MAX, sustain ? -1 : DEFAULT_TIMING.holdMs),
    outMs: ctx.num(el.outMs, `${path}.outMs`, 0, MS_MAX, DEFAULT_TIMING.outMs),
  };
  if (t.holdMs < 0 && !sustain) { ctx.warn(`${path}.holdMs`, '-1 (hold until released) needs sustain:true; using 400'); t.holdMs = 400; }
  else if (t.holdMs < 0) t.holdMs = -1;
  return t;
}

function osc(ctx, o, path, ampKind, limits) {
  if (o === undefined) return null;
  if (!ctx.keys(o, OSC_KEYS, path)) return null;
  const out = {
    hz: ctx.num(o.hz, `${path}.hz`, 0, 12, 1),
    wave: o.wave === undefined ? 'sine' : WAVES.includes(o.wave) ? o.wave : (ctx.err(`${path}.wave`, `must be one of ${WAVES.join('|')}`), 'sine'),
    phase: ctx.num(o.phase, `${path}.phase`, -1, 1, 0),
  };
  if (ampKind === 'scalar') out.amp = ctx.num(o.amp, `${path}.amp`, -1, 1, 0);
  else out.amp = vec3(ctx, o.amp, `${path}.amp`, limits);
  return out;
}

function vec3(ctx, v, path, limits) {
  if (v === undefined) return [0, 0, 0];
  if (!Array.isArray(v) || v.length !== 3) { ctx.err(path, 'must be [x, y, z]'); return [0, 0, 0]; }
  return v.map((c, i) => ctx.num(c, `${path}[${i}]`, -limits[i], limits[i], 0));
}

// Keyframed element -> { keys: [{t, v}], delayMs, inMs: 0, holdMs: lastKeyT, outMs }. With inMs 0 and
// holdMs = last key, the shared envelope is 1 across the keys and fades the last value out over outMs.
function keyed(ctx, el, path, field, limits) {
  for (const k of [field, 'inMs', 'holdMs']) if (el[k] !== undefined) ctx.err(`${path}.${k}`, 'not allowed together with keys');
  if (!Array.isArray(el.keys) || el.keys.length < 1 || el.keys.length > MAX_KEYS) { ctx.err(`${path}.keys`, `must be an array of 1..${MAX_KEYS} keys`); return null; }
  const keys = [];
  let prev = -1;
  el.keys.forEach((k, i) => {
    const p = `${path}.keys[${i}]`;
    if (!ctx.keys(k, ['t', field], p)) return;
    if (typeof k.t !== 'number' || !Number.isFinite(k.t)) { ctx.err(`${p}.t`, 'must be a finite number'); return; }
    if (k[field] === undefined) { ctx.err(`${p}.${field}`, 'is required'); return; }
    const t = ctx.num(k.t, `${p}.t`, 0, MS_MAX, 0);
    if (t <= prev) { ctx.err(`${p}.t`, 'must be strictly increasing'); return; }
    prev = t;
    keys.push({ t, v: vec3(ctx, k[field], `${p}.${field}`, limits) });
  });
  if (keys.length && keys[0].t > 0) keys.unshift({ t: 0, v: [0, 0, 0] });
  return {
    keys,
    delayMs: ctx.num(el.delayMs, `${path}.delayMs`, 0, MS_MAX, DEFAULT_TIMING.delayMs),
    inMs: 0,
    holdMs: keys.length ? keys[keys.length - 1].t : 0,
    outMs: ctx.num(el.outMs, `${path}.outMs`, 0, MS_MAX, DEFAULT_TIMING.outMs),
  };
}

function list(ctx, arr, path, fn) {
  if (arr === undefined) return [];
  const items = Array.isArray(arr) ? arr : [arr];
  if (items.length > MAX_ELEMENTS) { ctx.err(path, `max ${MAX_ELEMENTS} elements`); return []; }
  return items.map((el, i) => fn(el, `${path}[${i}]`)).filter(Boolean);
}

export function validateGesture(input) {
  const ctx = new Ctx();
  if (!ctx.keys(input, TOP_KEYS, 'command')) return { ok: false, errors: ctx.errors, warnings: [] };
  const sustain = ctx.bool(input.sustain, 'sustain', false);
  const cmd = {
    id: ctx.str(input.id, 'id', 'gesture'),
    label: ctx.str(input.label, 'label', ''),
    priority: ctx.num(input.priority, 'priority', 0, 10, 5),
    interrupt: ctx.bool(input.interrupt, 'interrupt', true),
    sustain,
    mirror: input.mirror === undefined ? 'none' : ['none', 'random'].includes(input.mirror) ? input.mirror : (ctx.err('mirror', "must be 'none' | 'random'"), 'none'),
    jitter: ctx.num(input.jitter, 'jitter', 0, 0.3, 0.1),
    follow: null,
    expressions: [],
    bones: [],
    lookAt: [],
    reach: [],
    root: [],
    hands: [],
    clip: null,
  };

  if (input.follow !== undefined && ctx.keys(input.follow, FOLLOW_KEYS, 'follow')) {
    const f = input.follow;
    cmd.follow = {
      head: ctx.num(f.head, 'follow.head', 0, 1, 0.55),
      spine: ctx.num(f.spine, 'follow.spine', 0, 0.5, 0.1),
      rate: ctx.num(f.rate, 'follow.rate', 1, 30, 6),
      tilt: ctx.num(f.tilt, 'follow.tilt', -25, 25, 0),
    };
  }

  cmd.expressions = list(ctx, input.expressions, 'expressions', (el, p) => {
    if (!ctx.keys(el, EXPR_KEYS, p)) return null;
    if (!EXPRESSIONS.includes(el.name)) { ctx.err(`${p}.name`, `unknown expression '${el.name}'`); return null; }
    return { name: el.name, weight: ctx.num(el.weight, `${p}.weight`, 0, 1, 1), osc: osc(ctx, el.osc, `${p}.osc`, 'scalar'), ...timing(ctx, el, p, sustain) };
  });

  cmd.bones = list(ctx, input.bones, 'bones', (el, p) => {
    if (!ctx.keys(el, BONE_KEYS, p)) return null;
    const limits = BONE_LIMITS_DEG[el.bone];
    if (!limits) { ctx.err(`${p}.bone`, `unknown bone '${el.bone}'`); return null; }
    const o = osc(ctx, el.osc, `${p}.osc`, 'vec', limits);
    if (el.keys !== undefined) { const k = keyed(ctx, el, p, 'rot', limits); return k && { bone: el.bone, rot: [0, 0, 0], osc: o, ...k }; }
    return { bone: el.bone, rot: vec3(ctx, el.rot, `${p}.rot`, limits), osc: o, ...timing(ctx, el, p, sustain) };
  });

  cmd.root = list(ctx, input.root, 'root', (el, p) => {
    if (!ctx.keys(el, ROOT_KEYS, p)) return null;
    const o = osc(ctx, el.osc, `${p}.osc`, 'vec', ROOT_LIMITS);
    if (el.keys !== undefined) { const k = keyed(ctx, el, p, 'pos', ROOT_LIMITS); return k && { pos: [0, 0, 0], osc: o, ...k }; }
    return { pos: vec3(ctx, el.pos, `${p}.pos`, ROOT_LIMITS), osc: o, ...timing(ctx, el, p, sustain) };
  });

  cmd.hands = list(ctx, input.hands, 'hands', (el, p) => {
    if (!ctx.keys(el, HAND_KEYS, p)) return null;
    if (el.hand !== 'left' && el.hand !== 'right') { ctx.err(`${p}.hand`, "must be 'left' | 'right'"); return null; }
    if (!HAND_SHAPES.includes(el.shape)) { ctx.err(`${p}.shape`, `must be one of ${HAND_SHAPES.join('|')}`); return null; }
    return { hand: el.hand, shape: el.shape, weight: ctx.num(el.weight, `${p}.weight`, 0, 1, 1), ...timing(ctx, el, p, sustain) };
  });

  cmd.lookAt = list(ctx, input.lookAt, 'lookAt', (el, p) => {
    if (!ctx.keys(el, LOOK_KEYS, p)) return null;
    let target;
    if (typeof el.target === 'string') {
      if (!(el.target in LOOK_TARGETS)) { ctx.err(`${p}.target`, `unknown target '${el.target}'`); return null; }
      target = el.target;
    } else if (isObj(el.target) && ctx.keys(el.target, ['x', 'y'], `${p}.target`)) {
      target = { x: ctx.num(el.target.x, `${p}.target.x`, -2.5, 2.5, 0), y: ctx.num(el.target.y, `${p}.target.y`, -2.5, 2.5, 0) };
    } else { ctx.err(`${p}.target`, "must be a named target or {x, y}"); return null; }
    const t = timing(ctx, el, p, sustain);
    if (el.ms !== undefined) t.holdMs = ctx.num(el.ms, `${p}.ms`, 0, MS_MAX, t.holdMs);
    return { target, weight: ctx.num(el.weight, `${p}.weight`, 0, 1, 1), osc: osc(ctx, el.osc, `${p}.osc`, 'scalar'), ...t };
  });

  cmd.reach = list(ctx, input.reach, 'reach', (el, p) => {
    if (!ctx.keys(el, REACH_KEYS, p)) return null;
    if (el.hand !== 'left' && el.hand !== 'right') { ctx.err(`${p}.hand`, "must be 'left' | 'right'"); return null; }
    let target;
    if (typeof el.target === 'string') {
      if (!REACH_TARGETS.includes(el.target)) { ctx.err(`${p}.target`, `unknown target '${el.target}'`); return null; }
      target = el.target;
    } else if (isObj(el.target) && el.target.dir !== undefined && ctx.keys(el.target, ['dir'], `${p}.target`)) {
      target = { dir: vec3(ctx, el.target.dir, `${p}.target.dir`, [1, 1, 1]) };
      if (!target.dir.some((c) => c !== 0)) { ctx.err(`${p}.target.dir`, 'must not be [0, 0, 0]'); return null; }
    } else if (isObj(el.target) && ctx.keys(el.target, ['frame', 'pos'], `${p}.target`)) {
      if (!['shoulder', 'head'].includes(el.target.frame)) { ctx.err(`${p}.target.frame`, "must be 'shoulder' | 'head'"); return null; }
      target = { frame: el.target.frame, pos: vec3(ctx, el.target.pos, `${p}.target.pos`, [1.5, 1.5, 1.5]) };
    } else { ctx.err(`${p}.target`, 'must be a named target, {dir} or {frame, pos}'); return null; }
    return { hand: el.hand, target, weight: ctx.num(el.weight, `${p}.weight`, 0, 1, 1), osc: osc(ctx, el.osc, `${p}.osc`, 'vec', [0.5, 0.5, 0.5]), ...timing(ctx, el, p, sustain) };
  });

  if (input.clip !== undefined && ctx.keys(input.clip, CLIP_KEYS, 'clip')) {
    const c = input.clip;
    const name = ctx.str(c.name, 'clip.name', '');
    if (!/^[\w.-]{1,64}$/.test(name)) ctx.err('clip.name', 'must be a clip file name without extension');
    cmd.clip = {
      name,
      weight: ctx.num(c.weight, 'clip.weight', 0, 1, 1),
      speed: ctx.num(c.speed, 'clip.speed', 0.1, 3, 1),
      loop: ctx.bool(c.loop, 'clip.loop', false),
      ...timing(ctx, { inMs: 250, holdMs: sustain ? -1 : 2000, outMs: 350, ...c }, 'clip', sustain),
    };
  }

  list(ctx, input.moves, 'moves', (el, p) => {
    if (!ctx.keys(el, MOVE_KEYS, p)) return null;
    if (!MOVES.includes(el.move)) { ctx.err(`${p}.move`, `must be one of ${MOVES.join('|')}`); return null; }
    const delayMs = ctx.num(el.delayMs, `${p}.delayMs`, 0, MS_MAX, 0);
    if (el.move === 'nod') {
      for (const k of ['inMs', 'holdMs']) if (el[k] !== undefined) ctx.err(`${p}.${k}`, 'not used by nod (use beats/beatMs)');
      const beats = Math.round(ctx.num(el.beats, `${p}.beats`, 1, 4, 2));
      const deg = ctx.num(el.deg, `${p}.deg`, 5, 30, 22);
      const beatMs = ctx.num(el.beatMs, `${p}.beatMs`, 250, 800, 380);
      const keys = [{ t: 0, v: 0 }];
      for (let b = 0; b < beats; b++) keys.push({ t: b * beatMs + 0.45 * beatMs, v: deg }, { t: (b + 1) * beatMs, v: b === beats - 1 ? 0 : -0.12 * deg });
      const outMs = ctx.num(el.outMs, `${p}.outMs`, 0, MS_MAX, 150);
      for (const [bone, share] of [['head', 0.65], ['neck', 0.35]]) {
        cmd.bones.push({ bone, rot: [0, 0, 0], osc: null, keys: keys.map((k) => ({ t: k.t, v: [k.v * share, 0, 0] })), delayMs, inMs: 0, holdMs: keys[keys.length - 1].t, outMs });
      }
    } else {
      const deg = ctx.num(el.deg, `${p}.deg`, -45, 45, 25);
      const t = timing(ctx, el, p, sustain);
      for (const [bone, share] of [['spine', 0.2], ['chest', 0.25], ['neck', 0.2], ['head', 0.35]]) {
        cmd.bones.push({ bone, rot: [0, deg * share, 0], osc: null, ...t });
      }
    }
    return null;
  });

  const channels = cmd.expressions.length + cmd.bones.length + cmd.lookAt.length + cmd.reach.length + cmd.root.length + cmd.hands.length + (cmd.clip ? 1 : 0);
  if (channels === 0 && !cmd.follow) ctx.err('command', 'has no expressions, bones, lookAt, reach, root, hands, clip or follow');
  if (ctx.errors.length) return { ok: false, errors: ctx.errors, warnings: ctx.warnings };
  return { ok: true, command: cmd, errors: [], warnings: ctx.warnings };
}
