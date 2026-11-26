// The motion route (T-31-ROOM motion P4/P5): the ONE function both entries call, so the agent and the owner get the same result.
//   agent  the reply's leading `[move: words]` tag (src/main/chat-brain.js) -> head.motion -> send(text)
//   owner  the chat's `/move words` command (talk/director.js) -> send(text)
// Text (or an intent object) -> validateIntent; a `compose:` brief -> the model writes a NEW seated command (src/main/motion-compose.js),
// which must pass validateSeated; then both go to the room as one integer program (stage `motion`, contract v2). The room decodes and
// validates again and its gate checks the command on her pose before anything moves (room/src/motion-player.js).
import { intentFromText, validateIntent, validateSeated, encodeMotion, cutFamily } from '../reflex/seated-motion.js';

// Chest contact asked for from the chat (a stream viewer's line, the /move command) is refused before any model call (owner ruling 20-11:
// "chặn từ bộ lọc phía người xem stream"); the agent may still choose a hand on the heart from context. The brief is matched by words,
// and a composed answer is checked again after the call.
const CHEST_WORDS = /\b(chest|breast|bust|boob|heart|cleavage)\b|ngực|ngưc|vú|trái tim|lồng ngực/i;
const touchesChest = (cmd) => (cmd.reach || []).some((e) => e.target && e.target.contact === 'chest');

/** The first JSON object in a model answer (models wrap it in prose or a code fence), or null. */
export function extractJson(text) {
  const s = String(text || ''), a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { const v = JSON.parse(s.slice(a, b + 1)); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; }
}

/**
 * @param {object} o
 * @param {(payload: {id: number, prog: number[]}) => Promise<boolean>} o.produce  the stage producer's motion() (false: no 3D room open)
 * @param {(brief: string) => Promise<{ok: boolean, text?: string, error?: string}>} [o.compose]  the host's composer, when it has one
 */
export function createMotionRoute({ produce, compose = null }) {
  let nextId = 1;
  return {
    /**
     * text | intent object -> { ok, id, warnings } or { ok: false, stage: 'intent'|'origin'|'compose'|'command'|'cut'|'wire'|'stage', errors }.
     * `origin`: 'agent' (the reply's [move: ...] tag) or 'chat' (a typed /move line: the owner or a stream viewer).
     */
    async send(input, { origin = 'chat' } = {}) {
      const v = typeof input === 'string' ? intentFromText(input) : validateIntent(input);
      if (!v.ok) return { ok: false, stage: 'intent', errors: v.errors };
      const warnings = [...v.warnings];
      let command = null;
      if (v.intent.compose && origin !== 'agent' && CHEST_WORDS.test(v.intent.compose)) return { ok: false, stage: 'origin', errors: ['origin: chest contact is not taken from the chat'] };
      if (v.intent.compose) {
        if (!compose) return { ok: false, stage: 'compose', errors: ['compose: this host has no composer'] };
        const r = await compose(v.intent.compose);
        if (!r || !r.ok) return { ok: false, stage: 'compose', errors: [`compose: ${(r && r.error) || 'failed'}`] };
        const raw = extractJson(r.text);
        if (!raw) return { ok: false, stage: 'compose', errors: ['compose: no JSON object in the answer'] };
        const s = validateSeated(raw);
        if (!s.ok) return { ok: false, stage: 'command', errors: s.errors };
        if (origin !== 'agent' && touchesChest(s.command)) return { ok: false, stage: 'origin', errors: ['origin: chest contact is not taken from the chat'] };
        const cut = cutFamily(s.command);
        if (cut) return { ok: false, stage: 'cut', errors: [cut] };
        command = s.command; warnings.push(...s.warnings);
      }
      const i = v.intent, hasIntent = Boolean(i.activity || i.tempo || i.energy || i.tone || i.beats.length || i.duration);
      const prog = encodeMotion({ intent: hasIntent ? i : null, command });
      if (prog.error) return { ok: false, stage: 'wire', errors: [`wire: ${prog.error}`] };
      const id = nextId++;
      if (!(await produce({ id, prog }))) return { ok: false, stage: 'stage', errors: ['stage: no 3D room open'] };
      return { ok: true, id, warnings, errors: [] };
    },
  };
}
