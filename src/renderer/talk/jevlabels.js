// Jev fast-reflex label set (fixed by the spike, the intent spike's data.mjs LABELS) mapped to
// VARIETY POOLS of short, single-purpose GestureCommands (T-31 PLAN-variety.md §2.2/§3), instead of one fixed
// command per label: at least 4 (3 for 'neutral') hand-authored, GENUINELY DIFFERENT body motions and >=3 face
// phrases per label, each independently gated (jevVariety.js's gateJevVariant: schema, no clamping, 1.5-3.5 s --
// the same 1.5-3.5 s, no-clip/no-sustain rule a speech-library gesture must pass). jevSelector.js derives MORE
// body variants from each one (mirror, amplitude, time, gaze) and picks a (body, face) pair per reaction with
// anti-repeat rules; the merged pair is what actually plays (Enter -> reflex-jev classify() -> here ->
// engine.playCommand), independent of the (slower) /turn speech-gesture pipeline.
//
// Coordinator QC on sheet-v1 (2 base motions/label, head+face only -- arms never moved): a viewer sees 2 motions
// per label, not the pool's full count, because ALL the derived variants share the same silhouette (same bones,
// just scaled). Fix: every label now has >=4 (3 for neutral) DISTINCT FAMILIES, and where the meaning fits they
// use shoulders/spine/arms/hands, not just head tilt -- reach targets and timing patterns are reused from
// already rig-vetted speech-library data (reflex/speech/*.json: 'chin'+'hip' from think.json's
// think-hand-on-chin, 'hip' from disagree.json, {frame:'shoulder',pos:[...]} both-hand reaches from
// explain.json/celebrate.json, 'beside-head'/'clasp' as documented in reflex/rig.js's REACH table) rather than
// invented from scratch, and every new one is re-verified against the real model with RigProbe
// (scripts/check-jev-rig.mjs) on top of the schema/duration gate every variant already passes. Reach targets
// 'chin'/'mouth'/'face'/'eye' (rig.js REACH, kind:'face') are intentionally avoided outside think-chin, which
// reuses the exact owner-approved think.json pose -- PLAN-variety.md's guards (FACE-CLEARANCE/HAND-SHAPE) exist
// for FAST, UNPLANNED motion (a startle); a slow, deliberate chin-touch is the documented exemption in
// scripts/check-motion.mjs (startleScenario is false for anything not named 'startle').
//
// `family` groups motions that read as "the same move" for the anti-repeat rule (never two consecutive
// reactions, across any intent, from the same family) and for check-variety.mjs's "a label must offer >=4 (>=3
// for neutral) DISTINCT families" assertion -- derived (mirror/amp/time/gaze) variants inherit their base's
// family unchanged, so they never count as a new one. `mirrorable` is a per-variant author judgement call (PLAN
// §2.2: never for pointing/deixis -- none of these 8 reactions point at anything, so it is purely "does
// mirroring this read as a different, equally valid, motion").
//
// Body commands never carry `expressions` (face owns the emotion group, same split as the speech-gesture
// pipeline's FaceDirector idea) and are authored as PLAIN bone/reach/hands/lookAt elements only -- never
// `moves`/`keys` (see jevVariety.js's header for why).
//
// Face phrases are plain `{ id, expressions }`: only the 5 VRM presets + blinks (this model ships 0 custom
// expressions, PLAN §3), each list restricted to FACE_ALLOWED_PRESETS[label] so a label can never surface the
// wrong valence (sad never gets a celebratory phrase, etc. -- see scripts/check-variety.mjs's correctness test).
import { en } from '../i18n.js';

export const JEV_LABELS = ['listen', 'nod', 'surprise', 'think', 'happy', 'concern', 'shrug', 'neutral'];

// Stable English owner-facing labels (same as the active `t('jev.<label>')` in the UI); kept as a map because the
// check scripts and the QC sheet generators read it directly.
export const JEV_LABEL_VI = Object.fromEntries(JEV_LABELS.map((l) => [l, en('jev.' + l)]));

const bone = (name, rot, timing = {}) => ({ bone: name, rot, inMs: 200, holdMs: 1300, outMs: 300, ...timing });
const look = (target, timing = {}) => ({ target, weight: 0.5, inMs: 200, holdMs: 1300, outMs: 300, ...timing });
const reachEl = (hand, target, timing = {}) => ({ hand, target, weight: 0.5, inMs: 200, holdMs: 1200, outMs: 350, ...timing });
const handEl = (hand, shape, timing = {}) => ({ hand, shape, weight: 0.65, inMs: 200, holdMs: 1200, outMs: 300, ...timing });
// rig.js's named 'clasp' preset sits low (pos[1] -0.72, near/below the hips) -- out of a waist-up frame and, per
// coordinator QC on sheet-v1/early sheet-v2, not visibly different from arms-at-rest even when the viewer is
// looking right at it. Same "hands come together in front" meaning, moved up to chest height with a custom
// {frame:'shoulder', pos} target (same mechanism explain.json/celebrate.json already use, both already passing
// check:jev-rig/check:rig for that reach kind).
const CLASP_HIGH = { frame: 'shoulder', pos: [-0.2, -0.15, 0.35] };

export const JEV_BODY = {
  listen: [
    { id: 'listen-lean', family: 'listen-lean', mirrorable: false, command: { bones: [bone('head', [8, 0, 0])] } },
    { id: 'listen-tilt', family: 'listen-tilt', mirrorable: true, command: { bones: [bone('head', [5, 0, 7]), bone('neck', [0, 3, 0])] } },
    // hands loosely clasped in front: an attentive, receptive posture (CLASP_HIGH -- same target as
    // nod-clasp/happy-clasp below).
    { id: 'listen-clasp', family: 'listen-clasp', mirrorable: false, command: {
      bones: [bone('head', [4, 0, 0], { holdMs: 1200 })],
      reach: [reachEl('left', CLASP_HIGH, { weight: 0.4, holdMs: 1200 }), reachEl('right', CLASP_HIGH, { weight: 0.4, holdMs: 1200 })],
      hands: [handEl('left', 'loose', { weight: 0.8, holdMs: 1200 }), handEl('right', 'loose', { weight: 0.8, holdMs: 1200 })],
    } },
    // one hand resting at the hip (reach target 'hip', already vetted by disagree.json), relaxed lean.
    { id: 'listen-hip', family: 'listen-hip', mirrorable: true, command: {
      bones: [bone('head', [6, 0, 4], { holdMs: 1200 })],
      reach: [reachEl('right', 'hip', { weight: 0.4, delayMs: 150, holdMs: 1100 })],
      hands: [handEl('right', 'loose', { weight: 0.6, delayMs: 150, holdMs: 1100 })],
    } },
  ],
  nod: [
    // two down-dips (a short pulse, then the held nod) instead of the `moves:'nod'` shorthand -- see jevVariety.js.
    { id: 'nod-double', family: 'nod-double', mirrorable: false, command: { bones: [
      bone('head', [16, 0, 0], { delayMs: 0, inMs: 120, holdMs: 160, outMs: 140 }),
      bone('head', [16, 0, 0], { delayMs: 420, inMs: 120, holdMs: 900, outMs: 300 }),
    ] } },
    { id: 'nod-single', family: 'nod-single', mirrorable: false, command: { bones: [bone('head', [22, 0, 0], { inMs: 150, holdMs: 1300, outMs: 300 })] } },
    // lean-in + an open palm at waist height ("yes, go ahead") -- reach 'hip', open hand.
    { id: 'nod-palm', family: 'nod-palm', mirrorable: true, command: {
      bones: [bone('chest', [6, 0, 0], { holdMs: 1100 }), bone('head', [9, 0, 0], { holdMs: 1100 })],
      reach: [reachEl('right', 'hip', { weight: 0.55, delayMs: 150, holdMs: 1150 })],
      hands: [handEl('right', 'loose', { weight: 0.85, delayMs: 150, holdMs: 1150 })],
    } },
    // slow, calm nod with both hands clasped -- a quieter "understood" than the brisk single/double nod.
    { id: 'nod-clasp', family: 'nod-clasp', mirrorable: false, command: {
      bones: [bone('head', [13, 0, 0], { inMs: 220, holdMs: 1400, outMs: 350 })],
      reach: [reachEl('left', CLASP_HIGH, { weight: 0.5, delayMs: 100, holdMs: 1300 }), reachEl('right', CLASP_HIGH, { weight: 0.5, delayMs: 100, holdMs: 1300 })],
      hands: [handEl('left', 'loose', { weight: 0.8, delayMs: 100, holdMs: 1300 }), handEl('right', 'loose', { weight: 0.8, delayMs: 100, holdMs: 1300 })],
    } },
  ],
  surprise: [
    { id: 'surprise-recoil', family: 'surprise-recoil', mirrorable: false, command: { bones: [
      bone('head', [-8, 0, 0], { inMs: 100, holdMs: 1200, outMs: 310 }),
      bone('spine', [-4, 0, 0], { inMs: 100, holdMs: 1200, outMs: 310 }),
    ] } },
    // Coordinator QC round 3 (sheet-v4): even thumb-tucked, hand-near-body IK on this rig kept reading wrong --
    // clutch landed a fist at bottom-of-ribcage height ("yes!" fist-pump), hands-up read as flexing/cheering, not
    // surprise. Decision: stop fighting hand-near-body IK, replace both with head/spine/shoulder-only motions
    // (no reach, no hands -- hands stay at rest, nothing for the IK/HAND-SHAPE guards to get wrong).
    // step-back: a small weight shift back (hips + spine lean) + chin up.
    { id: 'surprise-step-back', family: 'surprise-step-back', mirrorable: false, command: {
      bones: [
        bone('hips', [-6, 0, 0], { inMs: 100, holdMs: 1150, outMs: 300 }),
        bone('spine', [-7, 0, 0], { inMs: 100, holdMs: 1150, outMs: 300 }),
        bone('head', [-9, 0, 0], { inMs: 90, holdMs: 1150, outMs: 310 }),
      ],
    } },
    // freeze-stare: a still body, a slow (slower inMs than recoil's 100) small head pull-back, held long -- the
    // "wide-eye hold" is the face pool's job (surprised/oh/blink), this is just the stillness.
    { id: 'surprise-freeze-stare', family: 'surprise-freeze-stare', mirrorable: false, command: {
      bones: [bone('head', [-5, 0, 0], { inMs: 150, holdMs: 1700, outMs: 350 }), bone('neck', [-3, 0, 0], { inMs: 150, holdMs: 1700, outMs: 350 })],
    } },
    // shoulders hitch up, head pulled back -- a startle that reads in the silhouette with no arm reach at all,
    // deliberately distinct from the lean-back (recoil) and the hand gestures above.
    { id: 'surprise-shoulders', family: 'surprise-shoulders', mirrorable: false, command: {
      bones: [bone('head', [-6, 0, 0], { holdMs: 1250 }), bone('leftShoulder', [0, 0, 9], { holdMs: 1250 }), bone('rightShoulder', [0, 0, 9], { holdMs: 1250 })],
    } },
  ],
  think: [
    { id: 'think-turn', family: 'think-turn', mirrorable: true, command: { bones: [bone('head', [0, 10, 8], { holdMs: 1500 })] } },
    { id: 'think-ponder', family: 'think-ponder', mirrorable: true, command: { bones: [bone('head', [13, 0, -5], { holdMs: 1400 }), bone('neck', [5, 0, 0], { holdMs: 1400 })] } },
    // the classic hand-on-chin pose -- numbers reused near-verbatim from the owner-approved
    // reflex/speech/think.json think-hand-on-chin-s1 (coordinator verdict 01-10), minus its expressions (face is
    // a separate pool here). 'chin' is a face-kind reach, deliberately slow (inMs 400+) and deliberate, not a
    // startle -- the exact case scripts/check-motion.mjs documents as exempt from FACE-CLEARANCE/HAND-SHAPE.
    { id: 'think-chin', family: 'think-chin', mirrorable: false, command: {
      bones: [bone('head', [10, -12, 8], { delayMs: 150, inMs: 400, holdMs: 1750, outMs: 450 }), bone('neck', [4, -8, 5], { delayMs: 100, inMs: 400, holdMs: 1800, outMs: 450 }), bone('chest', [3, -5, 2], { delayMs: 50, inMs: 450, holdMs: 1800, outMs: 450 })],
      reach: [reachEl('right', 'chin', { weight: 1, inMs: 400, holdMs: 1800, outMs: 450 }), reachEl('left', 'hip', { weight: 0.5, delayMs: 100, inMs: 400, holdMs: 1700, outMs: 400 })],
      hands: [handEl('right', 'fist', { weight: 1, inMs: 300, holdMs: 1900, outMs: 400 }), handEl('left', 'relaxed', { weight: 0.6, inMs: 350, holdMs: 1800, outMs: 350 })],
    } },
    // a pensive weight-shift lean, one hand at the hip -- no face contact, a lighter alternative to think-chin.
    { id: 'think-lean-hip', family: 'think-lean-hip', mirrorable: true, command: {
      bones: [bone('chest', [0, 8, -4], { holdMs: 1200 }), bone('head', [0, 6, 4], { holdMs: 1200 })],
      reach: [reachEl('left', 'hip', { weight: 0.5, delayMs: 100, holdMs: 1150 })],
      hands: [handEl('left', 'loose', { weight: 0.6, delayMs: 100, holdMs: 1150 })],
    } },
  ],
  happy: [
    { id: 'happy-tilt', family: 'happy-tilt', mirrorable: true, command: { bones: [bone('head', [0, 0, 9], { inMs: 150 })] } },
    { id: 'happy-shoulders', family: 'happy-shoulders', mirrorable: true, command: { bones: [bone('leftShoulder', [0, 0, 7], { inMs: 150 }), bone('rightShoulder', [0, 0, 7], { inMs: 150 })] } },
    // Coordinator QC round 3 (sheet-v4): still read as a nearly-straight arm out to the frame edge, no real 90deg
    // elbow bend -- the 'wave'/'beside-head' preset's own geometry does not bend that far no matter the reach
    // weight. Decision: stop fighting hand-near-body IK, replace with a spine/shoulder-only motion (no reach, no
    // hands -- hands stay at rest). bounce: a small up-down on the spine/shoulders (root pos, positive-y only --
    // rig.js's R4 foot-planted check explicitly exempts a raised, not lowered, root, "a jump may lift the feet").
    { id: 'happy-bounce', family: 'happy-bounce', mirrorable: false, command: {
      root: [
        { pos: [0, 0.045, 0], delayMs: 0, inMs: 90, holdMs: 110, outMs: 120 },
        { pos: [0, 0.045, 0], delayMs: 380, inMs: 90, holdMs: 900, outMs: 300 },
      ],
      bones: [
        bone('leftShoulder', [0, 0, 5], { delayMs: 0, inMs: 90, holdMs: 110, outMs: 120 }),
        bone('rightShoulder', [0, 0, 5], { delayMs: 0, inMs: 90, holdMs: 110, outMs: 120 }),
        bone('leftShoulder', [0, 0, 5], { delayMs: 380, inMs: 90, holdMs: 900, outMs: 300 }),
        bone('rightShoulder', [0, 0, 5], { delayMs: 380, inMs: 90, holdMs: 900, outMs: 300 }),
      ],
    } },
    // both hands clasp together at chest height, excited/bright -- quicker timing than nod-clasp's calm version.
    { id: 'happy-clasp', family: 'happy-clasp', mirrorable: false, command: {
      bones: [bone('head', [0, 0, 8], { inMs: 120, holdMs: 1150 })],
      reach: [reachEl('left', CLASP_HIGH, { weight: 0.55, inMs: 150, holdMs: 1100 }), reachEl('right', CLASP_HIGH, { weight: 0.55, inMs: 150, holdMs: 1100 })],
      hands: [handEl('left', 'loose', { weight: 0.8, inMs: 150, holdMs: 1100 }), handEl('right', 'loose', { weight: 0.8, inMs: 150, holdMs: 1100 })],
    } },
  ],
  concern: [
    { id: 'concern-down', family: 'concern-down', mirrorable: false, command: { bones: [bone('head', [10, 0, 0])] } },
    { id: 'concern-slouch', family: 'concern-slouch', mirrorable: true, command: { bones: [bone('chest', [4, 0, 0]), bone('head', [7, 0, -3])] } },
    // Coordinator QC round 3 (sheet-v4): a fist at bottom-of-ribcage height, held out at the side -- reads as a
    // "yes!" fist-pump, not a hug, no matter the weight/shape tuning. Decision: stop fighting hand-near-body IK,
    // replace with a shoulder/head-only motion (no reach, no hands -- hands stay at rest).
    // sigh: shoulders rise then drop (two bone pulses per shoulder, opposite sign -- same two-pulse technique as
    // nod-double), head dips as they settle. Named concern-shoulder-sigh (not concern-sigh) to avoid colliding
    // with the unrelated face phrase id JEV_FACE.concern already uses ('concern-sigh').
    { id: 'concern-shoulder-sigh', family: 'concern-shoulder-sigh', mirrorable: false, command: {
      bones: [
        bone('leftShoulder', [0, 0, 7], { delayMs: 0, inMs: 150, holdMs: 300, outMs: 250 }),
        bone('rightShoulder', [0, 0, 7], { delayMs: 0, inMs: 150, holdMs: 300, outMs: 250 }),
        bone('leftShoulder', [0, 0, -4], { delayMs: 600, inMs: 200, holdMs: 700, outMs: 300 }),
        bone('rightShoulder', [0, 0, -4], { delayMs: 600, inMs: 200, holdMs: 700, outMs: 300 }),
        bone('head', [9, 0, 0], { delayMs: 500, inMs: 300, holdMs: 900, outMs: 350 }),
      ],
    } },
    // tired weight-shift lean with a hand at the hip.
    { id: 'concern-hip-lean', family: 'concern-hip-lean', mirrorable: true, command: {
      bones: [bone('chest', [0, -6, 3], { holdMs: 1200 }), bone('head', [8, 0, 3], { holdMs: 1200 })],
      reach: [reachEl('left', 'hip', { weight: 0.45, delayMs: 150, holdMs: 1100 })],
      hands: [handEl('left', 'loose', { weight: 0.6, delayMs: 150, holdMs: 1100 })],
    } },
  ],
  shrug: [
    { id: 'shrug-one', family: 'shrug-one', mirrorable: true, command: { bones: [bone('rightShoulder', [0, 0, 10], { holdMs: 1100 })] } },
    { id: 'shrug-both', family: 'shrug-both', mirrorable: true, command: { bones: [bone('leftShoulder', [0, 0, 8], { holdMs: 1100 }), bone('rightShoulder', [0, 0, 8], { holdMs: 1100 })] } },
    // the classic "I don't know": both hands out at the sides, palms up -- {frame:'shoulder', pos} custom reach,
    // modest height, open hands.
    { id: 'shrug-palms-up', family: 'shrug-palms-up', mirrorable: false, command: {
      bones: [bone('leftShoulder', [0, 0, 6], { holdMs: 1100 }), bone('rightShoulder', [0, 0, 6], { holdMs: 1100 })],
      reach: [
        reachEl('left', { frame: 'shoulder', pos: [0.4, -0.1, 0.25] }, { weight: 0.5, delayMs: 100, holdMs: 1050 }),
        reachEl('right', { frame: 'shoulder', pos: [0.4, -0.1, 0.25] }, { weight: 0.5, delayMs: 100, holdMs: 1050 }),
      ],
      hands: [handEl('left', 'loose', { weight: 0.8, delayMs: 100, holdMs: 1050 }), handEl('right', 'loose', { weight: 0.8, delayMs: 100, holdMs: 1050 })],
    } },
    // head tilt + one hand resting on the hip, unbothered.
    { id: 'shrug-hip', family: 'shrug-hip', mirrorable: true, command: {
      bones: [bone('head', [0, 8, 6], { holdMs: 1150 })],
      reach: [reachEl('right', 'hip', { weight: 0.4, delayMs: 150, holdMs: 1050 })],
      hands: [handEl('right', 'loose', { weight: 0.6, delayMs: 150, holdMs: 1050 })],
    } },
  ],
  neutral: [
    { id: 'neutral-gaze', family: 'neutral-gaze', mirrorable: false, command: { priority: 4, lookAt: [look('camera', { weight: 0.5 })] } },
    { id: 'neutral-settle', family: 'neutral-settle', mirrorable: false, command: { priority: 4, bones: [bone('head', [2, 0, 0])], lookAt: [look('camera', { weight: 0.35 })] } },
    // kept subtle (coordinator: "neutral can stay subtle") -- a very light hand resting at the hip, barely there.
    { id: 'neutral-hip-rest', family: 'neutral-hip-rest', mirrorable: true, command: {
      priority: 4,
      reach: [reachEl('right', 'hip', { weight: 0.25, delayMs: 150, holdMs: 1100 })],
      hands: [handEl('right', 'loose', { weight: 0.3, delayMs: 150, holdMs: 1100 })],
      lookAt: [look('camera', { weight: 0.3 })],
    } },
  ],
};

const expr = (name, weight, timing = {}) => ({ name, weight, inMs: 200, holdMs: 1300, outMs: 300, ...timing });

export const FACE_ALLOWED_PRESETS = {
  listen: ['relaxed', 'blink'],
  nod: ['happy', 'ee', 'blink'],
  surprise: ['surprised', 'oh', 'blink'],
  think: ['relaxed', 'ou', 'blink'],
  happy: ['happy', 'ee', 'blink', 'blinkRight'],
  concern: ['sad', 'relaxed', 'blink'],
  shrug: ['relaxed', 'ou', 'blink'],
  neutral: ['relaxed', 'blink'],
};

export const JEV_FACE = {
  listen: [
    { id: 'listen-soft', expressions: [expr('relaxed', 0.45, { holdMs: 1300 })] },
    { id: 'listen-steady', expressions: [expr('relaxed', 0.3, { inMs: 250, holdMs: 1400 })] },
    { id: 'listen-blink', expressions: [expr('relaxed', 0.4, { holdMs: 1300 }), expr('blink', 0.7, { delayMs: 700, inMs: 60, holdMs: 80, outMs: 80 })] },
  ],
  nod: [
    { id: 'nod-glad', expressions: [expr('happy', 0.5, { inMs: 150, holdMs: 1200 })] },
    { id: 'nod-warm', expressions: [expr('happy', 0.35, { inMs: 150, holdMs: 1300 }), expr('blink', 0.7, { delayMs: 600, inMs: 50, holdMs: 70, outMs: 60 })] },
    { id: 'nod-bright', expressions: [expr('happy', 0.6, { inMs: 120, holdMs: 1250 }), expr('ee', 0.2, { inMs: 100, holdMs: 900, outMs: 250 })] },
  ],
  surprise: [
    { id: 'surprise-wide', expressions: [expr('surprised', 0.75, { inMs: 100, holdMs: 1200, outMs: 300 }), expr('oh', 0.4, { inMs: 100, holdMs: 1100, outMs: 300 })] },
    { id: 'surprise-gasp', expressions: [expr('surprised', 0.55, { inMs: 80, holdMs: 1300, outMs: 300 }), expr('oh', 0.5, { inMs: 90, holdMs: 1150, outMs: 280 })] },
    { id: 'surprise-blink', expressions: [expr('surprised', 0.65, { inMs: 100, holdMs: 1250, outMs: 300 }), expr('blink', 0.9, { delayMs: 300, inMs: 40, holdMs: 60, outMs: 60 })] },
  ],
  think: [
    { id: 'think-calm', expressions: [expr('relaxed', 0.4, { inMs: 150, holdMs: 1350 })] },
    { id: 'think-ou', expressions: [expr('relaxed', 0.3, { inMs: 150, holdMs: 1300 }), expr('ou', 0.25, { inMs: 120, holdMs: 1000, outMs: 250 })] },
    { id: 'think-blink', expressions: [expr('relaxed', 0.35, { inMs: 150, holdMs: 1300 }), expr('blink', 0.6, { delayMs: 650, inMs: 50, holdMs: 70, outMs: 70 })] },
  ],
  happy: [
    { id: 'happy-beam', expressions: [expr('happy', 0.75, { inMs: 150, holdMs: 1250 })] },
    { id: 'happy-glow', expressions: [expr('happy', 0.55, { inMs: 150, holdMs: 1300 }), expr('ee', 0.2, { inMs: 120, holdMs: 1000, outMs: 250 })] },
    { id: 'happy-wink', expressions: [expr('happy', 0.6, { inMs: 150, holdMs: 1250 }), expr('blinkRight', 0.55, { delayMs: 700, inMs: 60, holdMs: 90, outMs: 70 })] },
  ],
  concern: [
    { id: 'concern-soft', expressions: [expr('sad', 0.55, { inMs: 150, holdMs: 1300 })] },
    { id: 'concern-worry', expressions: [expr('sad', 0.4, { inMs: 150, holdMs: 1250 }), expr('relaxed', 0.25, { inMs: 150, holdMs: 1250 })] },
    { id: 'concern-sigh', expressions: [expr('sad', 0.5, { inMs: 180, holdMs: 1350, outMs: 320 }), expr('blink', 0.6, { delayMs: 500, inMs: 60, holdMs: 80, outMs: 80 })] },
  ],
  shrug: [
    { id: 'shrug-plain', expressions: [expr('relaxed', 0.3, { inMs: 150, holdMs: 1150 })] },
    { id: 'shrug-pout', expressions: [expr('relaxed', 0.25, { inMs: 150, holdMs: 1150 }), expr('ou', 0.2, { inMs: 120, holdMs: 900, outMs: 250 })] },
    { id: 'shrug-blink', expressions: [expr('relaxed', 0.35, { inMs: 150, holdMs: 1150 }), expr('blink', 0.6, { delayMs: 500, inMs: 50, holdMs: 70, outMs: 70 })] },
  ],
  neutral: [
    { id: 'neutral-calm', expressions: [expr('relaxed', 0.22, { inMs: 150, holdMs: 1200 })] },
    { id: 'neutral-still', expressions: [expr('relaxed', 0.18, { inMs: 150, holdMs: 1300 })] },
    { id: 'neutral-blink', expressions: [expr('relaxed', 0.2, { inMs: 150, holdMs: 1200 }), expr('blink', 0.5, { delayMs: 600, inMs: 50, holdMs: 70, outMs: 70 })] },
  ],
};
