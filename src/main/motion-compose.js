'use strict';
// Live compose (T-31-ROOM motion P5, FABLE-MOTION-1911 §2 approach A level 2): the agent gives a short brief ("rub your eyes, then
// stretch") and ONE model call writes a NEW seated motion as data: a GestureCommand restricted to the seated room
// (src/renderer/reflex/seated-motion.js validateSeated). Nothing is picked from a library. The answer is returned as text; the renderer's
// motion route parses and validates it, and the room's gate (room/src/motion-player.js) checks it on her pose before it plays.
// Never on the speech-critical path (measured too slow on 01-10): the route calls it after the reply, while she works.
const COMPOSE_TIMEOUT_MS = 15000;
const BRIEF_MAX_CHARS = 200;
const ANSWER_MAX_CHARS = 6000;

// Families cut at the composer (owner ruling 20-11: filter error-prone motions from the start, keep the ones that look right). Measured on
// the frozen 20 (P5c C2 runs, look4, 3 phases): desk 0/6, hair 0/3, neck 0/3, behind the head 0/6 passed the gate; the face family 19/24 with
// 2 guard aborts, front space 13/15, hands before the chest 3/3. The gate still refuses anything; the agent is no longer offered these.
// P5c-2: fingers on the eyes, mouth and brow cut too (H1 measuring the fingers). The route refuses an answer that uses any cut family
// (seated-motion.js cutFamily), so the prompt is not the only filter.
// lean-r2 Addendum R2 (CoS 21-11, Fable look review): the hand to the chin cut too (it landed on her throat), and both hands meeting at one
// point in front (the heart shape clumped them at her belt).
// Fable HOLD (22-11): moves too small to read on the webcam (shoulder roll, a 20 deg turn) and a hand held in front of her face: the prompt asks
// for readable amplitudes and a hand beside the face.
// Fable r3 (22-11): the surprised moves kept the idle soft smile; a move may carry its face (one emotion preset, seated-motion.js FACE_NAMES).
// Fable r3: the surprised point aimed up beside the shoulder: a point at the screen is forward at chest height, the wrist bent to the monitor.
const COMPOSE_PROMPT = [
  'You write one short upper-body motion for Zumi, an anime girl SEATED at a desk with her hands on a keyboard, facing a webcam on her monitor.',
  'Answer with ONE JSON object and nothing else. It starts at her typing pose and must end back there: every element fades in, holds, fades out.',
  'Fields (all optional except that at least one channel is present):',
  '- "reach": [{ "hand": "left"|"right", "target": T, "delayMs", "inMs", "holdMs", "outMs", "weight": 0..1, "osc": { "hz": 0..12, "amp": [x, y, z] (metres, <= 0.05), "wave": "sine" } }]',
  '  T is a named point: rest, face, chest, clasp (one hand), overhead, wave, wave-small, point-up, point-out, point-viewer,',
  '  point-screen-left, point-screen-right, point-sidebar; or { "frame": "shoulder", "pos": [out, up, forward] } in arm lengths (-1.5..1.5) from',
  '  that shoulder; or { "frame": "head", "pos": [out, up, forward] } in shoulder widths from her head; or a contact { "contact": C } that ends',
  '  the hand ON her cheek or (a still hand on the heart, never moving there) her chest. The arms move ONLY by reach.',
  'Never: a hand behind or beside her head, on her hair or neck, or down on the desk; both hands meeting in front of her (low, or a heart shape); fingers on',
  'her eyes, mouth or brow; a hand to her chin. Prefer moves in the space in front of her, a hand on the cheek. Match the speed to the mood:',
  'tired and calm slow, surprised and happy quick. The viewer sees her chest-up through a webcam: make each move big enough to read there (a head',
  'turn or tilt of 25-40 deg, a shoulder lift near its limit, a hand clearly in view beside her face, never in front of it); a 10 deg move looks like idle.',
  'A point at the screen goes forward at chest height, the wrist bent so the finger aims at the monitor, never up past her shoulder.',
  '- "bones": [{ "bone": B, "rot": [x, y, z] degrees, "delayMs", "inMs", "holdMs", "outMs" }] or { "bone": B, "keys": [{ "t": ms, "rot": [x, y, z] }], "outMs" }.',
  '  B and its limits in degrees: spine/chest 12, upperChest 10, neck 25, head 30 (pitch, x+ = nod down), 45 (yaw, y+ = turn to screen right), 25 (tilt),',
  '  leftShoulder/rightShoulder 10-15, leftHand/rightHand 50. Never arm bones, never hips.',
  '- "hands": [{ "hand", "shape": open|open-flat|loose|relaxed|fist|point|thumbsUp, "delayMs", "inMs", "holdMs", "outMs" }]',
  '- "lookAt": [{ "target": camera|down|up|away-left|away-right|sidebar, "delayMs", "inMs", "holdMs", "outMs" }]',
  '- "moves": [{ "move": "nod", "beats": 1..4, "deg": 5..30 }] or [{ "move": "turn", "deg": -45..45, "inMs", "holdMs", "outMs" }]',
  '- "expressions": [{ "name": surprised|happy|sad|relaxed|angry, "weight": 0..1, "delayMs", "inMs", "holdMs", "outMs" }] at most one: her face for the',
  '  move, in step with it (surprised: brows up, mouth open, no smile). Without it she keeps her calm idle face.',
  'Rules: the whole motion lasts at most 8000 ms; hands never go through her body, her head or the desk; arms move at a calm human pace',
  '(reaches take 500-1200 ms); no mouth shapes or blinks, no clips, no root, no sustain. Do not explain.',
].join('\n');

/**
 * @param {object} o
 * @param {(messages: {role: string, content: string}[], opts: {timeoutMs: number}) => Promise<{ok: boolean, text?: string, error?: string}>} o.callModel
 *   one non-streamed chat call on the owner's own model and key (chat-brain's transport); never logs the brief or the answer
 */
function createMotionComposer({ callModel }) {
  return {
    /** brief -> { ok, text } (the model's raw answer, capped) or { ok: false, error }. */
    async compose(brief) {
      const b = String(brief || '').trim();
      if (!b || b.length > BRIEF_MAX_CHARS) return { ok: false, error: 'bad_brief' };
      const r = await callModel([{ role: 'system', content: COMPOSE_PROMPT }, { role: 'user', content: b }], { timeoutMs: COMPOSE_TIMEOUT_MS });
      if (!r || !r.ok || typeof r.text !== 'string') return { ok: false, error: (r && r.error) || 'upstream' };
      return { ok: true, text: r.text.slice(0, ANSWER_MAX_CHARS) };
    },
  };
}

module.exports = { createMotionComposer, COMPOSE_PROMPT };
