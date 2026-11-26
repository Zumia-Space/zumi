// Role-based model routing (ADR 2026-10-09-role-routing). Pure functions, no I/O: used by the reducer, the read
// models, the legacy /api/state and tested on their own.
// for the local self-test (apply-role-routing.mjs pins both hashes so the copies cannot drift).
//
// Four slots per task: plan, code, review, scout. Each slot is { model, effort, by } with by = owner | coordinator | auto (the legacy API shows anh | cos | auto).
//   code    = anh's routing override > auto-escalation bump > the coordinator's seed (task.worker) > default
//   plan, review, scout = anh's override (roles.set) > default
// Invariants:
//   (a) review.model != code.model; when equal, review moves to the next tier above the coder, else to opus
//   (b) scout is never used for a verdict (flag can_verdict:false on the slot, repeated in the agent file)
//   (c) a coder that fails the same gate twice moves one tier up deepseek -> sonnet -> opus, unless anh set the slot;
//       gemini-3.8-flash -> gemini-4-argon (high) -> opus (high) on the side map GEMINI_NEXT

export const ROLES = ['plan', 'code', 'review', 'scout'];
export const DEFAULTS = {
  plan: { model: 'opus', effort: 'high' },
  code: { model: 'sonnet', effort: 'high' },
  review: { model: 'opus', effort: 'high' },
  scout: { model: 'haiku', effort: 'low' }
};
/** Tier order used by the review rule (a): low to high. */
export const TIERS = ['haiku', 'deepseek', 'sonnet', 'opus'];
/** Auto-escalation ladder (c): the coder moves one step up this list. */
export const LADDER = ['deepseek', 'sonnet', 'opus'];
export const ESCALATE_AFTER = 2;
// Gemini (run through the Antigravity CLI `agy`): flash = coder tier, peer of sonnet/deepseek; argon = plan/review tier, peer of opus.
// They are NOT inserted into TIERS/LADDER (that would reorder sonnet -> opus); the ladder uses GEMINI_NEXT. The review rule needs no entry:
// an unknown model falls through to 'opus' as the reviewer above it.
export const GEMINI_EFFORTS = ['low', 'medium', 'high']; // agy rejects xhigh and max
export const isGemini = model => /^gemini-/.test(model || '');
// Antigravity worker group (J-05 agy-models-1911): every model agy runs, with the efforts it accepts. xhigh exists only on Gemini 4 Neon and
// Hydrogen, GPT-OSS only has medium, agy rejects max everywhere. Mirrors the dispatcher's agy route table (dispatch-agy.mjs MODELS) and public/app.js AGY_EFFORTS.
// A board route {model, effort} on one of these ids is run by supervise-worker.mjs through agy-worker.mjs.
// No agy-run Claude ids (claude-opus-5-5 ...): they would equal a Claude seat's model string (review rule a compares strings; stats key by model), Opus gate M1 19-11.
const AGY_LMH = ['low', 'medium', 'high'];
export const AGY_MODEL_EFFORTS = {
  'gemini-3.8-flash': AGY_LMH, 'gemini-4-argon': AGY_LMH, 'gemini-4-carbon': AGY_LMH, 'gemini-4-hydrogen': [...AGY_LMH, 'xhigh'], 'gemini-4-neon': [...AGY_LMH, 'xhigh'],
  'gpt-oss-120b': ['medium']
};
export const isAgyModel = model => Object.hasOwn(AGY_MODEL_EFFORTS, model);
/** The efforts agy accepts for a model, or null when agy does not run it. Unlisted gemini-* ids keep the old low/medium/high rule. */
const agyEfforts = model => AGY_MODEL_EFFORTS[model] || (isGemini(model) ? GEMINI_EFFORTS : null);
const GEMINI_NEXT = { 'gemini-3.8-flash': 'gemini-4-argon', 'gemini-4-argon': 'opus' };
/** Refusal text when an agy-run model is paired with an effort agy cannot run; null when the pair is fine. */
export const effortError = (model, effort) => { const ok = agyEfforts(model); return ok && !ok.includes(effort) ? `${model} accepts only ${ok.join(', ')} (agy rejects ${effort})` : null; };
const EFFORT_RANK = ['low', 'medium', 'high', 'xhigh', 'max'];

const slot = (s, by, extra = {}) => ({ model: s.model, effort: s.effort, by, ...extra });

/** Code slot only: anh's override, then an auto bump, then the coordinator's seed, then the default. */
export function resolveCode(task, routing, roles) {
  const o = routing?.[task.id], auto = roles?.[task.id]?.code;
  if (o) return slot(o, 'owner', { at: o.set_at });
  if (auto) return slot(auto, 'auto', { reason: auto.reason, at: auto.at });
  if (task.worker) return slot(task.worker, 'coordinator', task.worker.reason ? { reason: task.worker.reason } : {});
  return slot(DEFAULTS.code, 'coordinator', { default: true });
}

/** Rule (a). Returns the review slot as it will be dispatched, with `adjusted_from` when it was moved and `conflict`
 *  when no tier above the coder exists (coder already on opus), so the rule cannot be met by model alone. */
export function applyReviewRule(review, code) {
  if (review.model !== code.model) return review;
  const rank = TIERS.indexOf(code.model);
  const up = rank >= 0 && rank < TIERS.length - 1 ? TIERS[rank + 1] : 'opus';
  if (up === code.model) return { ...review, conflict: true, note: 'same model as the coder: no higher tier; review in a fresh session' };
  return { ...review, model: up, adjusted_from: { model: review.model, effort: review.effort }, note: 'bumped: reviewer must differ from the coder' };
}

/** All four effective slots of one task. `roles` is state.roles (overrides keyed by task id). */
export function resolveRoles(task, routing, roles) {
  const mine = roles?.[task.id] || {};
  const own = r => (mine[r] ? slot(mine[r], 'owner', { at: mine[r].at }) : slot(DEFAULTS[r], 'coordinator', { default: true }));
  const code = resolveCode(task, routing, roles);
  return {
    plan: own('plan'),
    code,
    review: applyReviewRule(own('review'), code),
    scout: { ...own('scout'), can_verdict: false }
  };
}

/** Decision for one gate failure, journaled with the event so replay never recomputes it from newer state.
 *  gateFails = state.gate_fails[task] ({ [gate]: { count } }). */
export function escalateDecision(task, routing, roles, gateFails, gate) {
  const count = (gateFails?.[gate]?.count || 0) + 1;
  const code = resolveCode(task, routing, roles);
  const out = { gate, count, code_before: { model: code.model, effort: code.effort, by: code.by }, bump: null };
  if (count < ESCALATE_AFTER) return out;
  if (code.by === 'owner') return { ...out, blocked: 'code slot is set by the owner (anh)' };
  const i = LADDER.indexOf(code.model), next = GEMINI_NEXT[code.model] || (i >= 0 ? LADDER[i + 1] : undefined);
  if (!next) return { ...out, blocked: i < 0 ? `model ${code.model} is not on the ladder` : 'already on the top tier' };
  const effort = EFFORT_RANK.indexOf(code.effort) >= EFFORT_RANK.indexOf('high') ? code.effort : 'high';
  return { ...out, bump: { model: next, effort, reason: `gate "${gate}" failed ${count}x: ${code.model} -> ${next}` } };
}
