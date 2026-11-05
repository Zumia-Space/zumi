'use strict';
// Pure planning helpers for the T-31 float-holo talk-framing clips (scripts/fh-clips.mjs drives them on the render
// box; scripts/electron-float-holo.cjs FH_TALK_CLIP=1 records one clip). NO Electron, NO ffmpeg here: everything that
// can be checked on a machine without a window is checked by scripts/check-fh-clips.mjs.
//
// What the clips are for: anh could not SEE the rim / reflection in the r6 stills (frozen rest pose, arms down).
// Each clip is the REAL talk view (the default `wide` float crop -- the camera/zoom a user sees while talking, not the
// harness's head-to-knees `close` crop) with a short talk loop (mouth + nod) and scripted arm gestures that cross the
// panel and the jacket, so the edge light on sleeves/collar/hair and the arm-vs-panel overlap can be judged in motion.
//
// Fair comparison: every clip replays the SAME timeline. Nothing in it is random: the gesture commands carry
// jitter 0 / mirror none, blinks + glances + idle variety are held off (holdNeutral), the page is pinned to one
// accent, Math.random is seeded, and the virtual clock starts at a value aligned to the hover periods
// (alignedClockStart) so the bob phase is identical in every run.

/** The three candidates anh picks from (TOP3.md of the r6 sweep). */
const CLIP_COMBOS = Object.freeze([
  Object.freeze({ id: 'T1', rimMul: 3, fresnelPower: 2, centerBackM: 0.10, soleY: 0.24 }),
  Object.freeze({ id: 'T2', rimMul: 6, fresnelPower: 3, centerBackM: 0.10, soleY: 0.21 }),
  Object.freeze({ id: 'T3', rimMul: 4, fresnelPower: 2, centerBackM: 0.16, soleY: 0.24 }),
]);
/** colour -> holo-screen PAGES index (0 = cyan '#39d0ff', 1 = amber '#ffb347'). */
const COLOUR_PAGE = Object.freeze({ cyan: 0, amber: 1 });
const COLOURS = Object.freeze(['cyan', 'amber']);

const f2 = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(2));
/** Corner label: the params and the colour, e.g. `T1  rim 3  fres 2  back 0.10  sole 0.24  CYAN`. */
function labelText(entry) {
  const c = entry.combo;
  return `${c.id}  rim ${c.rimMul}  fres ${c.fresnelPower}  back ${c.centerBackM.toFixed(2)}  sole ${c.soleY.toFixed(2)}  ${entry.colour.toUpperCase()}`;
}

/** The 6 clips: combo x colour, in contact-sheet order (rows = colour, columns = T1..T3 in `gridOrder`). */
function clipMatrix() {
  const out = [];
  for (const colour of COLOURS) for (const combo of CLIP_COMBOS) {
    const entry = { id: `${combo.id}-${colour}`, combo, colour, page: COLOUR_PAGE[colour], params: { rimMul: combo.rimMul, fresnelPower: combo.fresnelPower, centerBackM: combo.centerBackM, soleY: combo.soleY } };
    entry.label = labelText(entry);
    out.push(entry);
  }
  return out;
}

// ---------- deterministic time ----------
// The float hover (float-mode.js update) is phase-locked to the ABSOLUTE render time t: periods 3.6 s, 1.7 s, 7 s
// and 5.3 s (bob, ripple, yaw sway, roll sway). The harness's virtual clock used to start at the page's real
// performance.now(), so two runs had different bob phases and the shadow sat at a different height in the same frame.
const HOVER_PERIODS_MS = Object.freeze([3600, 1700, 7000, 5300]);
const gcd = (a, b) => (b ? gcd(b, a % b) : a);
const lcm = (a, b) => (a / gcd(a, b)) * b;
const HOVER_LCM_MS = HOVER_PERIODS_MS.reduce(lcm, 1); // 113 526 000 ms: every hover term is back at phase 0

/** The first multiple of the hover LCM at least `minLeadMs` after `nowMs`: a virtual-clock start that is the same
 *  hover phase in every run and never earlier than anything the page stamped with its real clock. */
function alignedClockStart(nowMs, minLeadMs = 20000) {
  return Math.ceil((nowMs + minLeadMs) / HOVER_LCM_MS) * HOVER_LCM_MS;
}

/** Small seeded PRNG (mulberry32). Serialised into the page (`.toString()`), so it stays dependency-free. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- the talk + gesture timeline (recorded-time ms) ----------
// Every command is deterministic (jitter 0, mirror none) and layered (interrupt false), so the talk loop and an arm
// gesture can play together and none of them fades the float legs clip.
const BASE = { priority: 3, interrupt: false, jitter: 0, mirror: 'none' };

/** One spoken phrase: mouth (aa + a little oh) wobbling at syllable rate, two small nods, eyes on camera. */
function talkPhrase(n, durMs) {
  const hold = durMs - 240;
  return {
    ...BASE, id: `fh-talk-${n}`, label: 'talk',
    expressions: [
      { name: 'aa', weight: 0.45, osc: { hz: 4.5, amp: 0.3, wave: 'sine' }, inMs: 120, holdMs: hold, outMs: 120 },
      { name: 'oh', weight: 0.12, osc: { hz: 2.2, amp: 0.1, wave: 'sine', phase: 0.25 }, inMs: 120, holdMs: hold, outMs: 120 },
    ],
    moves: [{ move: 'nod', beats: 2, deg: 5, beatMs: 650, delayMs: 100 }],
    lookAt: { target: 'camera', ms: durMs },
  };
}

/** An arm gesture from reach targets (rig.js REACH): [{hand, target}] held for `holdMs`. */
const arms = (id, reach, holdMs) => ({
  ...BASE, id, label: id,
  reach: reach.map(([hand, target]) => ({ hand, target, inMs: 500, holdMs, outMs: 500 })),
});

/** The timeline as [{ atMs, command }] sorted by time for a clip of `totalMs`. The camera-left panel sits at her
 *  right shoulder side, so: the right hand sweeps toward it (arm in front of the panel), both hands clasp in front
 *  of the jacket, then the LEFT arm crosses her body toward the panel while the right hand rests on the chest, and a
 *  small wave closes. Talk phrases run the whole time (1.7 s speech, 0.3 s pause). */
function talkTimeline(totalMs = 8000) {
  const items = [];
  for (let n = 0, t = 0; t + 1700 <= totalMs; n++, t += 2000) items.push({ atMs: t, command: talkPhrase(n, 1700) });
  const gestures = [
    [700, arms('fh-arm-right-to-panel', [['right', 'point-screen-left']], 1300)],
    [2900, arms('fh-arm-clasp', [['right', 'clasp'], ['left', 'clasp']], 1200)],
    [4900, arms('fh-arm-left-across', [['left', 'point-screen-left'], ['right', 'chest']], 1200)],
    [6900, arms('fh-arm-wave-small', [['right', 'wave-small']], 500)],
  ];
  for (const [atMs, command] of gestures) if (atMs + 1000 <= totalMs) items.push({ atMs, command });
  return items.sort((a, b) => a.atMs - b.atMs || a.command.id.localeCompare(b.command.id));
}

/** Commands to fire at recorded frame `i` (frame i starts at i*1000/fps ms; a command fires on the first frame at or
 *  after its time, so the same ms -> the same frame at any fps). */
function commandsAtFrame(timeline, i, fps) {
  const t0 = (i * 1000) / fps, t1 = ((i + 1) * 1000) / fps;
  return timeline.filter((it) => it.atMs >= t0 - 1e-9 && it.atMs < t1 - 1e-9).map((it) => it.command);
}

// ---------- arm-vs-panel overlap (measured from the recorded frames) ----------
const ARM_PROBE_POINTS = Object.freeze(['rightHand', 'leftHand', 'rightLowerArm', 'leftLowerArm']);
const PANEL_MARGIN_NDC = 0.04;
const MIN_OVERLAP_FRAME_SHARE = 0.1; // the arm/hand must be over the panel rect in >= 10 % of the frames
const MIN_ARM_TRAVEL_NDC = 0.15; // a hand must travel at least this far (NDC) or the gestures did not play

/** @param samples [{ pts: {rightHand:{x,y}|null,...}, panel: {x0,x1,y0,y1}|null, aa: number|null }] one per frame */
function armStats(samples) {
  const inside = (p, r) => p && r && p.x >= r.x0 - PANEL_MARGIN_NDC && p.x <= r.x1 + PANEL_MARGIN_NDC && p.y >= r.y0 - PANEL_MARGIN_NDC && p.y <= r.y1 + PANEL_MARGIN_NDC;
  let overlap = 0, measurable = 0;
  const range = {};
  for (const name of ARM_PROBE_POINTS) range[name] = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  let aaMin = Infinity, aaMax = -Infinity;
  for (const s of samples) {
    if (!s || !s.pts || !s.panel) continue;
    measurable++;
    if (ARM_PROBE_POINTS.some((n) => inside(s.pts[n], s.panel))) overlap++;
    for (const n of ARM_PROBE_POINTS) {
      const p = s.pts[n];
      if (!p) continue;
      const r = range[n];
      r.minX = Math.min(r.minX, p.x); r.maxX = Math.max(r.maxX, p.x); r.minY = Math.min(r.minY, p.y); r.maxY = Math.max(r.maxY, p.y);
    }
    if (typeof s.aa === 'number') { aaMin = Math.min(aaMin, s.aa); aaMax = Math.max(aaMax, s.aa); }
  }
  const travel = (n) => (range[n].minX === Infinity ? 0 : Math.max(range[n].maxX - range[n].minX, range[n].maxY - range[n].minY));
  const maxTravel = Math.max(...ARM_PROBE_POINTS.map(travel));
  const overlapShare = measurable ? overlap / measurable : 0;
  return {
    frames: samples.length, measurable, overlapFrames: overlap, overlapShare, maxTravelNdc: maxTravel,
    mouthAaMin: aaMin === Infinity ? null : aaMin, mouthAaMax: aaMax === -Infinity ? null : aaMax,
    armsMoved: maxTravel >= MIN_ARM_TRAVEL_NDC, overlapOk: overlapShare >= MIN_OVERLAP_FRAME_SHARE,
    mouthMoved: aaMax !== -Infinity && aaMax - aaMin >= 0.15,
  };
}

// ---------- ffmpeg (runs ONLY on the spare PC; these just build argv arrays) ----------
/** drawtext escapes: inside a filtergraph option value, `:` and `\` need a backslash (the quoted-path idiom). */
const ffEscape = (p) => String(p).replace(/\\/g, '/').replace(/:/g, '\\:');

/** frames/f_%04d.png -> one H.264 mp4 at <=1920 wide with the label burned top-left from a text file (no quoting of
 *  the label itself: it lives in labelFile). */
function ffmpegClipArgs({ framesDir, fps, out, labelFile = null, font = 'C:/Windows/Fonts/consola.ttf', maxWidth = 1920 }) {
  const vf = [`scale='min(${maxWidth},iw)':-2`];
  if (labelFile) vf.push(`drawtext=fontfile='${ffEscape(font)}':textfile='${ffEscape(labelFile)}':fontsize=30:fontcolor=white:box=1:boxcolor=black@0.65:boxborderw=10:x=18:y=18`);
  vf.push('format=yuv420p');
  return ['-y', '-framerate', String(fps), '-i', `${framesDir}/f_%04d.png`, '-vf', vf.join(','), '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-r', String(fps), '-movflags', '+faststart', out];
}

/** 3 columns (T1..T3) x 2 rows (cyan, amber) of `cellW`x`cellH` cells, from the clips in clipMatrix() order. */
function ffmpegGridArgs({ clips, out, cellW = 960, cellH = 540, fps = 30 }) {
  if (clips.length !== 6) throw new Error(`grid needs 6 clips, got ${clips.length}`);
  const inputs = clips.flatMap((c) => ['-i', c]);
  const scale = clips.map((_, i) => `[${i}:v]scale=${cellW}:${cellH}:force_original_aspect_ratio=decrease,pad=${cellW}:${cellH}:(ow-iw)/2:(oh-ih)/2,setsar=1[v${i}]`);
  const fc = [...scale, '[v0][v1][v2]hstack=inputs=3[r0]', '[v3][v4][v5]hstack=inputs=3[r1]', '[r0][r1]vstack=inputs=2,format=yuv420p[g]'].join(';');
  return ['-y', ...inputs, '-filter_complex', fc, '-map', '[g]', '-c:v', 'libx264', '-preset', 'slow', '-crf', '19', '-r', String(fps), '-movflags', '+faststart', out];
}

module.exports = {
  CLIP_COMBOS, COLOURS, COLOUR_PAGE, labelText, clipMatrix,
  HOVER_PERIODS_MS, HOVER_LCM_MS, alignedClockStart, mulberry32,
  talkTimeline, commandsAtFrame, armStats, ARM_PROBE_POINTS, PANEL_MARGIN_NDC, MIN_OVERLAP_FRAME_SHARE, MIN_ARM_TRAVEL_NDC,
  ffEscape, ffmpegClipArgs, ffmpegGridArgs,
};
