// Seated motion (T-31-ROOM motion P4/P5, FABLE-MOTION-1911 §2 approach A): the agent writes motion DATA, the room's seated rig plays it.
// One module both sides import: the main webview (the agent's reply tag and the chat's /move command, one parser) and the room guest
// (the stage message). Three layers, each closed:
//   intent   {activity, tempo, energy, tone, beats[{do, at}], duration, compose}: enums and clamped numbers; free text only in `compose`,
//            which never leaves the host (ADR room-live-b D2: the guest gets numbers and enums).
//   command  a GestureCommand (reflex/schema.js, the one gesture contract) restricted to what a seated body at a desk can do: the arms by
//            `reach` only (the rig's IK keeps the elbows and the desk), torso/head/hand bones additive, hand shapes, gaze. No clip (the
//            owner rejected canned clips, 20-11), no root, nothing that holds forever. The face: one emotion preset with an envelope at
//            most (FACE_NAMES), played over the stage's held emotion only while the motion runs; the mouth and blinks stay with the voice
//            and the core.
//   wire     intent + command as one integer array (stage message `motion`, t 6): the host encodes, the guest decodes and validates again.
import { validateGesture, REACH_TARGETS, HAND_SHAPES, LOOK_TARGETS } from './schema.js';

export const ACTIVITIES = ['typing', 'reading', 'thinking', 'mouse', 'talk', 'idle'];
export const ENERGIES = ['low', 'mid', 'high'];
export const TONES = ['calm', 'warm', 'playful', 'serious', 'tense'];
// Level-1 beats: each is a parameter-driven primitive the room expands (energy, tempo and a random draw shape it), not a clip.
export const BEATS = ['lean-back', 'lean-in', 'hover', 'mouse', 'chin', 'nod', 'shake', 'glance', 'point', 'wave', 'shrug', 'stretch', 'rub-eyes', 'think'];
export const BEAT_AT = ['none', 'user', 'screen', 'board', 'keys', 'window', 'left', 'right'];
const TEMPO_RANGE = [0.5, 1.6];
const DURATION_MS = [500, 15000];
const COMPOSE_MAX_CHARS = 200;
const MAX_BEATS = 3;
const INTENT_KEYS = ['activity', 'tempo', 'energy', 'tone', 'beats', 'duration', 'compose'];

// Degrees, additive on the core's pose, per axis [x, y, z]; tighter than BONE_LIMITS_DEG (a standing body): she sits with her hands near
// the keys, the jacket rides the shoulders, and the chest leans only a little before it meets the desk (seated.js chinLeanClear).
const SEATED_BONE_LIMITS = {
  spine: [12, 15, 8], chest: [12, 15, 8], upperChest: [10, 12, 8], neck: [25, 35, 20], head: [30, 45, 25],
  leftShoulder: [10, 10, 15], rightShoulder: [10, 10, 15], leftHand: [50, 50, 50], rightHand: [50, 50, 50],
};
const SEATED_BONES = Object.keys(SEATED_BONE_LIMITS);
const COMPOSED_MAX_MS = 10000; // a composed motion ends and she is back at the keys within this

const WAVES = ['sine', 'saw', 'pulse', 'square', 'triangle'];
const LOOK_NAMES = Object.keys(LOOK_TARGETS).filter((k) => LOOK_TARGETS[k]); // named points only ('cursor'/'dynamic' mean nothing in the room)
// A composed move's face: the stage's emotion presets (stage-sink.js EMOTION_PRESET), wire order fixed. Fable r3 (22-11): the surprised moves
// kept the idle soft smile (relaxed 0.25) and read as "oh, look" rather than "whoa".
export const FACE_NAMES = ['relaxed', 'happy', 'sad', 'surprised', 'angry'];
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Intent -> { ok, intent (normalized), errors, warnings }. Unknown fields and wrong types are errors; numbers out of range are clamped. */
export function validateIntent(input) {
  const errors = [], warnings = [];
  if (!isObj(input)) return { ok: false, errors: ['intent: must be an object'], warnings };
  for (const k of Object.keys(input)) if (!INTENT_KEYS.includes(k)) errors.push(`intent.${k}: unknown field`);
  const out = { activity: null, tempo: null, energy: null, tone: null, beats: [], duration: null, compose: null };
  const oneOf = (k, list) => { if (input[k] === undefined) return; if (list.includes(input[k])) out[k] = input[k]; else errors.push(`intent.${k}: must be one of ${list.join('|')}`); };
  const num = (k, [lo, hi]) => {
    if (input[k] === undefined) return;
    const v = input[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) { errors.push(`intent.${k}: must be a finite number`); return; }
    if (v < lo || v > hi) warnings.push(`intent.${k}: clamped ${v} to [${lo}, ${hi}]`);
    out[k] = Math.min(hi, Math.max(lo, v));
  };
  oneOf('activity', ACTIVITIES); oneOf('energy', ENERGIES); oneOf('tone', TONES);
  num('tempo', TEMPO_RANGE); num('duration', DURATION_MS);
  if (input.beats !== undefined) {
    if (!Array.isArray(input.beats) || input.beats.length > MAX_BEATS) errors.push(`intent.beats: must be an array of at most ${MAX_BEATS}`);
    else input.beats.forEach((b, i) => {
      if (!isObj(b)) { errors.push(`intent.beats[${i}]: must be an object`); return; }
      for (const k of Object.keys(b)) if (k !== 'do' && k !== 'at') errors.push(`intent.beats[${i}].${k}: unknown field`);
      if (!BEATS.includes(b.do)) { errors.push(`intent.beats[${i}].do: must be one of ${BEATS.join('|')}`); return; }
      if (b.at !== undefined && !BEAT_AT.includes(b.at)) { errors.push(`intent.beats[${i}].at: must be one of ${BEAT_AT.join('|')}`); return; }
      out.beats.push({ do: b.do, at: b.at || 'none' });
    });
  }
  if (input.compose !== undefined) {
    if (typeof input.compose !== 'string' || !input.compose.trim()) errors.push('intent.compose: must be a non-empty string');
    else if (input.compose.length > COMPOSE_MAX_CHARS) errors.push(`intent.compose: at most ${COMPOSE_MAX_CHARS} characters`);
    else out.compose = input.compose.trim();
  }
  if (!errors.length && !out.activity && out.tempo === null && !out.energy && !out.tone && !out.beats.length && !out.compose) errors.push('intent: empty');
  return errors.length ? { ok: false, errors, warnings } : { ok: true, intent: out, errors, warnings };
}

/**
 * The one text grammar both routes speak: the agent's reply tag `[move: ...]` and the chat's `/move ...` command.
 *   `stretch`  `point@board`  `nod lean-back`  `reading tempo=0.7 energy=low`  `compose: rub your eyes, then stretch`  `{...intent JSON}`
 * Words are beats (with @at), activities, `energy`, `tone` or `key=value` (tempo, duration ms, energy, tone, activity). Returns the raw
 * intent object for validateIntent, or { error }.
 */
export function parseMotionText(text) {
  const s = String(text || '').trim();
  if (!s) return { error: 'empty' };
  if (s[0] === '{') { try { return JSON.parse(s); } catch { return { error: 'bad_json' }; } }
  const m = /^compose\s*:\s*([\s\S]+)$/i.exec(s);
  if (m) return { compose: m[1].trim() };
  const out = {};
  for (const word of s.split(/\s+/)) {
    const kv = /^([a-z]+)=(.+)$/i.exec(word);
    if (kv) {
      const [, k, v] = kv;
      if (k === 'tempo' || k === 'duration') out[k] = Number(v);
      else if (['energy', 'tone', 'activity'].includes(k)) out[k] = v;
      else return { error: `unknown_key:${k.slice(0, 16)}` };
      continue;
    }
    const [name, at] = word.toLowerCase().split('@');
    if (BEATS.includes(name)) { (out.beats = out.beats || []).push(at ? { do: name, at } : { do: name }); continue; }
    if (ACTIVITIES.includes(name) && !at) { out.activity = name; continue; }
    if (ENERGIES.includes(name) && !at) { out.energy = name; continue; }
    if (TONES.includes(name) && !at) { out.tone = name; continue; }
    return { error: `unknown_word:${word.slice(0, 24)}` };
  }
  return out;
}

/** Text (either route) -> validateIntent's verdict. */
export function intentFromText(text) {
  const raw = parseMotionText(text);
  if (raw && raw.error) return { ok: false, errors: [`text: ${raw.error}`], warnings: [] };
  return validateIntent(raw);
}

/**
 * A GestureCommand checked for the seated room -> { ok, command (normalized), durationMs, errors, warnings }. reflex/schema.js validates
 * and clamps first; here the channels a seated body cannot or must not use are refused, bone angles are clamped to SEATED_BONE_LIMITS
 * and the whole motion must end within COMPOSED_MAX_MS (every element fades back to 0: she always returns to the keys).
 */
// P5b contact targets: a reach may end the hand ON a surface of her own body or on the desk top (room/src/motion-player.js resolves the
// point and keeps the hand in a 0..+X mm band outside it). Written `target: { contact: name }`; the shared GestureCommand validator does
// not know it, so it is swapped for a placeholder there and put back after.
// 'chest' (owner ruling 20-11, relayed by CoS): a STATIC rest only, a hand on the heart for being moved or apologising, or during a bow.
// No rubbing, stroking, oscillation or repeated contact (chestContactRule), and never asked for by a stream viewer (the motion route).
export const CONTACTS = ['hair', 'forehead', 'back-head', 'cheek', 'chin', 'neck', 'chest', 'desk'];
/** null when the command's chest contacts are static rests, else the reason (shared by validateSeated and the room's gate). */
export function chestContactRule(reach) {
  const chest = (reach || []).filter((e) => e && e.target && e.target.contact === 'chest');
  if (chest.some((e) => e.osc)) return 'chest contact: a static rest only (no rubbing, stroking or oscillation)';
  const perHand = {}; for (const e of chest) perHand[e.hand] = (perHand[e.hand] || 0) + 1;
  if (Object.values(perHand).some((n) => n > 1)) return 'chest contact: once per hand (no repeated contact)';
  return null;
}

// Families cut from the composer's answers (owner ruling 20-11: "các động tác dễ gây lỗi thì lọc luôn từ đầu"). Measured on the frozen 20
// (look4): desk 0/6, hair 0/3, neck 0/3, behind the head 0/6 (P5c C2); fingers on the eyes, mouth and brow put the fingers in her face
// (check-motion H1 with the fingers: eye rub 8-9, cup sip 3-4, shade eyes 1-2 vertices; P5c-2). A head-frame point is [out, up, forward]
// in shoulder widths: behind or beside her head is forward < 0.2; her brow is in front of it, raised and within her face's width.
// lean-r2 Addendum R2 (Fable look review of the 43 s look4 take, CoS ruling 21-11): the hand to the chin landed on her throat after a slide
// up the chest (lap to neck in 0.35 s): cut, named or as a contact (the 'think' beat reaches the chin and meets the cut too)
const CUT_NAMED = { eye: 'fingers on the eyes', mouth: 'fingers at the mouth', 'beside-head': 'a hand beside the head', chin: 'a hand to the chin (CoS 21-11)' };
const CUT_CONTACT = { chin: 'a hand to the chin (CoS 21-11)', forehead: 'fingers on the brow', hair: 'a hand on the hair', 'back-head': 'a hand behind the head', neck: 'a hand on the neck', desk: 'a hand down on the desk' };
// lean-r2 Addendum R2 (Fable look review of the 43 s look4 take, CoS ruling 21-11): the heart shape clumped both hands at her belt, the
// clasp's pose by another name. Cut: a left and a right reach, held at the same time, to frame points that meet. Both frames mirror `out`
// per hand, so in the head frame (shoulder widths, about the head) the hands are |outL + outR| apart across her; in the shoulder frame
// (arm lengths, from each shoulder; her shoulders are about 0.7 arm lengths apart) they meet when 0.7 + outL + outR is under 0.2 (or
// cross). Up and forward within 0.25 of each other.
const HANDS_MEET = { head: (a, b) => Math.abs(a + b) < 0.25, shoulder: (a, b) => 0.7 + a + b < 0.2 };
function handsMeet(reach) {
  const framed = (h) => reach.filter((e) => e && e.hand === h && e.target && HANDS_MEET[e.target.frame] && Array.isArray(e.target.pos));
  const span = (e) => [e.delayMs || 0, (e.delayMs || 0) + (e.inMs || 0) + (e.holdMs || 0)];
  for (const l of framed('left')) for (const r of framed('right')) {
    if (l.target.frame !== r.target.frame) continue;
    const [a0, a1] = span(l), [b0, b1] = span(r);
    if (a0 > b1 || b0 > a1) continue;
    const [lo, lu, lf] = l.target.pos, [ro, ru, rf] = r.target.pos;
    if (HANDS_MEET[l.target.frame](lo, ro) && Math.abs(lu - ru) < 0.25 && Math.abs(lf - rf) < 0.25) return true;
  }
  return false;
}
const FAR_POINTS = { left: ['point-screen-left', 'point-sidebar'], right: ['point-screen-right'] }; // per hand, the screen points across her body
/** -> the first cut family a seated command uses, as an error, or null. */
export function cutFamily(command) {
  const reach = (command && command.reach) || [];
  for (const e of reach) {
    const t = e.target, why = typeof t === 'string' ? CUT_NAMED[t] : t && t.contact ? CUT_CONTACT[t.contact] : null;
    if (why) return `cut by owner ruling 20-11: ${why}`;
    if (t && t.frame === 'head' && Array.isArray(t.pos)) {
      const [out, up, fwd] = t.pos;
      if (fwd < 0.2) return 'cut by owner ruling 20-11: a hand behind or beside the head';
      if (up >= 0.1 && Math.abs(out) <= 0.35 && fwd <= 0.7) return 'cut by owner ruling 20-11: fingers on the brow';
    }
  }
  const clasp = new Set(reach.filter((e) => e.target === 'clasp').map((e) => e.hand));
  if (clasp.size === 2) return 'cut by owner ruling 20-11: both hands meeting low in front';
  if (handsMeet(reach)) return 'cut by owner ruling 21-11: both hands meeting at one point in front (heart shape)';
  return null;
}

export function validateSeated(input) {
  const contacts = [], pre = [];
  let src = input;
  if (isObj(input) && Array.isArray(input.reach)) {
    src = { ...input, reach: input.reach.map((e, i) => {
      if (!isObj(e) || !isObj(e.target) || e.target.contact === undefined) return e;
      if (Object.keys(e.target).length !== 1 || !CONTACTS.includes(e.target.contact)) { pre.push(`reach[${i}].target.contact: must be one of ${CONTACTS.join('|')}`); return e; }
      contacts[i] = e.target.contact;
      return { ...e, target: 'rest' };
    }) };
  }
  if (!pre.length && isObj(input)) { const chest = chestContactRule(input.reach); if (chest) pre.push(chest); }
  if (pre.length) return { ok: false, errors: pre, warnings: [] };
  const r = validateGesture(src);
  if (!r.ok) return { ok: false, errors: r.errors, warnings: r.warnings };
  const c = r.command, errors = [], warnings = [...r.warnings];
  c.reach.forEach((e, i) => { if (contacts[i]) e.target = { contact: contacts[i] }; }); // validateGesture keeps reach order
  if (c.clip) errors.push('clip: not in the seated room (motion is generated, never a canned clip)');
  if (c.root.length) errors.push('root: she is seated (no hip translation)');
  if (c.sustain) errors.push('sustain: a seated motion must end');
  if (c.follow) errors.push('follow: not in the seated room');
  c.expressions = c.expressions.filter((x) => {
    if (FACE_NAMES.includes(x.name) && !x.osc) return true;
    warnings.push(`expressions.${x.name}: dropped (a seated move's face is an emotion preset, ${FACE_NAMES.join('|')}, without osc)`); return false;
  });
  if (c.expressions.length > 1) { warnings.push('expressions: one face per move, the first kept'); c.expressions = c.expressions.slice(0, 1); }
  // lean-r2 (21-11): the screen points lie to one side of her (motion-player targetOf: screen-left and the sidebar on her right, screen-right on
  // her left). Pointed by the far hand, the arm crossed her body and its upper arm swept over her bust (look3 A1 5.3-6.8 mm, every play): the
  // near hand plays it, unless that hand moves in this command itself or a hand or shoulder bone is rotated (they would need mirroring)
  for (const [h, o] of [['left', 'right'], ['right', 'left']]) {
    const far = c.reach.filter((e) => e.hand === h && FAR_POINTS[h].includes(e.target));
    if (!far.length || c.reach.some((e) => e.hand === o) || c.hands.some((x) => x.hand === o) || c.bones.some((b) => /(Hand|Shoulder)$/.test(b.bone))) continue;
    for (const e of [...c.reach, ...c.hands]) if (e.hand === h) e.hand = o;
    warnings.push(`reach.${h}: ${far[0].target} is on her ${o} side: the ${o} hand points (no arm across her body)`);
  }
  for (const b of c.bones) {
    const lim = SEATED_BONE_LIMITS[b.bone];
    if (!lim) { errors.push(`bones.${b.bone}: not in the seated room (the arms move by reach)`); continue; }
    const clamp = (v, path) => v.map((x, i) => { const y = Math.min(lim[i], Math.max(-lim[i], x)); if (y !== x) warnings.push(`${path}[${i}]: clamped ${x} to ±${lim[i]}`); return y; });
    b.rot = clamp(b.rot, `bones.${b.bone}.rot`);
    if (b.keys) b.keys = b.keys.map((k, i) => ({ t: k.t, v: clamp(k.v, `bones.${b.bone}.keys[${i}]`) }));
    if (b.osc) b.osc.amp = clamp(b.osc.amp, `bones.${b.bone}.osc.amp`);
  }
  for (const l of c.lookAt) if (typeof l.target === 'string' && !LOOK_NAMES.includes(l.target)) errors.push(`lookAt.target: '${l.target}' has no point in the room`);
  const ends = [...c.bones, ...c.reach, ...c.hands, ...c.lookAt, ...c.expressions].map((e) => e.delayMs + e.inMs + e.holdMs + e.outMs);
  const durationMs = Math.max(0, ...ends);
  if (!c.bones.length && !c.reach.length && !c.hands.length && !c.lookAt.length) errors.push('command: nothing a seated body can play');
  if (durationMs > COMPOSED_MAX_MS) errors.push(`command: ${Math.round(durationMs)} ms is over ${COMPOSED_MAX_MS} ms`);
  return errors.length ? { ok: false, errors, warnings } : { ok: true, command: c, durationMs, errors, warnings };
}

// ---- wire: one integer array (ADR room-live-b D5: no string on the wire). Layout, every value an int in [-32768, 32767]:
//   [WIRE_VERSION, activity+1, tempo*100, energy+1, tone+1, duration/10, nBeats, (do, at) x nBeats, hasCommand, nElements, ...elements]
//   osc block (7): on, hz*100, ax, ay, az (scaled like the element's values), wave, phase*100
//   1 bone   bone, rx, ry, rz (deg*10), delay, in, hold, out (ms/10), osc            2 keyed bone  bone, delay, out, nKeys, (t, x, y, z) x n, osc
//   3 reach  hand, kind (0 named, 1 shoulder frame, 2 head frame, 3 dir, 4 contact), named, x, y, z (*1000), weight*100, delay, in, hold, out, osc (amp *1000)
//   4 hands  hand, shape, weight*100, delay, in, hold, out                         5 look   named (-1: point), x, y (*100), weight*100, delay, in, hold, out
//   6 face   FACE_NAMES index, weight*100, delay, in, hold, out (an additive kind: a command without a face encodes as before)
const WIRE_VERSION = 1;
export const WIRE_MAX_INTS = 640; // ~3.5 KB serialized; the host caps the message at 4096 B
const BONE_WIRE = SEATED_BONES;
const FRAME_KINDS = ['shoulder', 'head'];
const T = (ms) => Math.round(ms / 10);
const I16 = (v) => Number.isInteger(v) && v >= -32768 && v <= 32767;

/** { intent (normalized, compose ignored), command (normalized seated, optional) } -> int[] or { error }. */
export function encodeMotion({ intent = null, command = null }) {
  const p = [WIRE_VERSION];
  const ix = (list, v) => (v ? list.indexOf(v) + 1 : 0);
  const i = intent || { beats: [] };
  p.push(ix(ACTIVITIES, i.activity), i.tempo ? Math.round(i.tempo * 100) : 0, ix(ENERGIES, i.energy), ix(TONES, i.tone), i.duration ? T(i.duration) : 0, i.beats.length);
  for (const b of i.beats) p.push(BEATS.indexOf(b.do), BEAT_AT.indexOf(b.at || 'none'));
  if (!command) p.push(0);
  else {
    const osc = (o, k) => (o ? [1, Math.round(o.hz * 100), ...(Array.isArray(o.amp) ? o.amp : [o.amp, 0, 0]).map((a) => Math.round(a * k)), WAVES.indexOf(o.wave), Math.round(o.phase * 100)] : [0, 0, 0, 0, 0, 0, 0]);
    const tm = (e) => [T(e.delayMs), T(e.inMs), T(e.holdMs), T(e.outMs)];
    const els = [];
    for (const b of command.bones) {
      if (b.keys) els.push([2, BONE_WIRE.indexOf(b.bone), T(b.delayMs), T(b.outMs), b.keys.length, ...b.keys.flatMap((k) => [T(k.t), ...k.v.map((v) => Math.round(v * 10))]), ...osc(b.osc, 10)]);
      else els.push([1, BONE_WIRE.indexOf(b.bone), ...b.rot.map((v) => Math.round(v * 10)), ...tm(b), ...osc(b.osc, 10)]);
    }
    for (const r of command.reach) {
      const t = r.target, kind = typeof t === 'string' ? 0 : t.contact ? 4 : t.dir ? 3 : 1 + FRAME_KINDS.indexOf(t.frame);
      const v = typeof t === 'string' || t.contact ? [0, 0, 0] : (t.dir || t.pos);
      els.push([3, r.hand === 'right' ? 1 : 0, kind, kind === 0 ? REACH_TARGETS.indexOf(t) : kind === 4 ? CONTACTS.indexOf(t.contact) : 0, ...v.map((x) => Math.round(x * 1000)), Math.round(r.weight * 100), ...tm(r), ...osc(r.osc, 1000)]);
    }
    for (const h of command.hands) els.push([4, h.hand === 'right' ? 1 : 0, HAND_SHAPES.indexOf(h.shape), Math.round(h.weight * 100), ...tm(h)]);
    for (const l of command.lookAt) {
      const named = typeof l.target === 'string';
      els.push([5, named ? LOOK_NAMES.indexOf(l.target) : -1, named ? 0 : Math.round(l.target.x * 100), named ? 0 : Math.round(l.target.y * 100), Math.round(l.weight * 100), ...tm(l)]);
    }
    for (const x of command.expressions || []) els.push([6, FACE_NAMES.indexOf(x.name), Math.round(x.weight * 100), ...tm(x)]);
    p.push(1, els.length, ...els.flat());
  }
  if (p.length > WIRE_MAX_INTS) return { error: 'too_long' };
  if (!p.every(I16)) return { error: 'out_of_range' };
  return p;
}

/**
 * int[] -> { ok, intent, command, durationMs, errors }. Every index is bounds-checked and the result goes through validateIntent and
 * validateSeated again, so the guest never trusts the host's encoder (defence in depth, the same rule stage-client.js keeps).
 */
export function decodeMotion(p) {
  const fail = (e) => ({ ok: false, errors: [`wire: ${e}`] });
  if (!Array.isArray(p) || p.length < 8 || p.length > WIRE_MAX_INTS || !p.every(I16)) return fail('shape');
  if (p[0] !== WIRE_VERSION) return fail('version');
  let k = 1;
  const next = () => { if (k >= p.length) throw new Error('short'); return p[k++]; };
  const pick = (list, v, base = 0) => { const x = list[v - base]; if (x === undefined) throw new Error('index'); return x; };
  try {
    const raw = {};
    const act = next(), tempo = next(), en = next(), tone = next(), dur = next(), nb = next();
    if (act) raw.activity = pick(ACTIVITIES, act, 1);
    if (tempo) raw.tempo = tempo / 100;
    if (en) raw.energy = pick(ENERGIES, en, 1);
    if (tone) raw.tone = pick(TONES, tone, 1);
    if (dur) raw.duration = dur * 10;
    if (nb < 0 || nb > MAX_BEATS) throw new Error('beats');
    if (nb) raw.beats = Array.from({ length: nb }, () => ({ do: pick(BEATS, next()), at: pick(BEAT_AT, next()) }));
    let command = null;
    const has = next();
    if (has) {
      const n = next(), c = { bones: [], reach: [], hands: [], lookAt: [], expressions: [] };
      if (n < 1 || n > 24) throw new Error('elements');
      const tm = () => ({ delayMs: next() * 10, inMs: next() * 10, holdMs: next() * 10, outMs: next() * 10 });
      const osc = (scale, vec) => { const on = next(), hz = next() / 100, a = [next(), next(), next()].map((x) => x / scale), wave = next(), phase = next() / 100; return on ? { hz, amp: vec ? a : a[0], wave: pick(WAVES, wave), phase } : undefined; };
      const put = (list, el) => { for (const key of Object.keys(el)) if (el[key] === undefined) delete el[key]; list.push(el); };
      for (let e = 0; e < n; e++) {
        const kind = next();
        if (kind === 1) { const bone = pick(BONE_WIRE, next()), rot = [next(), next(), next()].map((x) => x / 10); put(c.bones, { bone, rot, ...tm(), osc: osc(10, true) }); }
        else if (kind === 2) {
          const bone = pick(BONE_WIRE, next()), delayMs = next() * 10, outMs = next() * 10, nk = next();
          if (nk < 1 || nk > 16) throw new Error('keys');
          const keys = Array.from({ length: nk }, () => ({ t: next() * 10, rot: [next(), next(), next()].map((x) => x / 10) }));
          put(c.bones, { bone, keys, delayMs, outMs, osc: osc(10, true) });
        } else if (kind === 3) {
          const hand = next() ? 'right' : 'left', tk = next(), named = next(), v = [next(), next(), next()].map((x) => x / 1000), weight = next() / 100;
          const target = tk === 0 ? pick(REACH_TARGETS, named) : tk === 4 ? { contact: pick(CONTACTS, named) } : tk === 3 ? { dir: v } : { frame: pick(FRAME_KINDS, tk, 1), pos: v };
          put(c.reach, { hand, target, weight, ...tm(), osc: osc(1000, true) });
        } else if (kind === 4) { const hand = next() ? 'right' : 'left', shape = pick(HAND_SHAPES, next()), weight = next() / 100; put(c.hands, { hand, shape, weight, ...tm() }); }
        else if (kind === 5) { const li = next(), x = next() / 100, y = next() / 100, weight = next() / 100; put(c.lookAt, { target: li === -1 ? { x, y } : pick(LOOK_NAMES, li), weight, ...tm() }); }
        else if (kind === 6) { const name = pick(FACE_NAMES, next()), weight = next() / 100; put(c.expressions, { name, weight, ...tm() }); }
        else throw new Error('kind');
      }
      command = c;
    }
    if (k !== p.length) throw new Error('trailing');
    let intent = null;
    if (Object.keys(raw).length) { const vi = validateIntent(raw); if (!vi.ok) return { ok: false, errors: vi.errors }; intent = vi.intent; }
    if (!command) return intent ? { ok: true, intent, command: null, durationMs: 0, errors: [] } : fail('empty');
    const vs = validateSeated(command);
    if (!vs.ok) return { ok: false, errors: vs.errors };
    return { ok: true, intent, command: vs.command, durationMs: vs.durationMs, errors: [] };
  } catch (e) { return fail(e.message); }
}
