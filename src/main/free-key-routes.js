'use strict';
// T-31 first-run key step (owner 05-11): three routes to a key, shown as cards. The table only POINTS at providers.js (the
// one provider table): the provider id, the model Zumi sends for chat, and the sign-up URL all come from it, so a card can
// never recommend a model the app does not send or a provider it cannot call (scripts/check-free-key-guide.mjs pins this).
// Cost labels are checked against the official docs on 2026-11-05 (see RESULT-FREEKEY-0511.md):
//   nvidia     FREE TRIAL. https://build.nvidia.com/deepseek-ai/deepseek-v4.1-flash sample code: base_url https://integrate.api.nvidia.com/v1,
//              model "deepseek-ai/deepseek-v4.1-flash", "governed by the NVIDIA API Trial Terms of Service". No official RPM page found.
//   groq       FREE PLAN (key page console.groq.com/keys; limits https://console.groq.com/docs/rate-limits, model openai/gpt-oss-120b listed).
//   cerebras   FREE TIER. https://inference-docs.cerebras.ai/support/rate-limits lists gpt-oss-120b on the free table.
//   opencode   PAID. docs https://opencode.ai/docs/zen/ lists "DeepSeek V4.1 Flash" as a paid id and "Free-tier chat models
//              require OpenCode; use paid models or Go from other clients" -- the *-free id is refused outside the OpenCode app.
//   openrouter FREE (":free" ids, rate limited). https://openrouter.ai/api/v1/models lists google/gemma-4-31b-it:free.
//   google     FREE TIER. https://aistudio.google.com/docs/pricing: gemini-3.5-flash-lite "Free of charge" on the Free Tier.
// No prices or limit numbers are written into the UI copy: they change, the docs are the source.
// Owner-visible words live in the i18n tables (freeKey.*); this file holds only ids, flags and key names. Never a key here.
const { PROVIDERS } = require('./providers.js');

// Order = display order inside each group. recommended = the one truly free route we point a new user at (single); bestValue = the
// paid route the owner prefers for its model. limitsUrl = the official page that states the limits/terms (no numbers in the UI).
const ROUTES = Object.freeze([
  { id: 'google', providerId: 'gemini', mode: 'free', cost: 'free', recommended: true, bestValue: false, limitsUrl: 'https://ai.google.dev/gemini-api/docs/rate-limits' },
  { id: 'nvidia', providerId: 'nvidia', mode: 'free', cost: 'free', recommended: false, bestValue: false, limitsUrl: 'https://build.nvidia.com/' },
  { id: 'groq', providerId: 'groq', mode: 'free', cost: 'free', recommended: false, bestValue: false, limitsUrl: 'https://console.groq.com/docs/rate-limits' },
  { id: 'cerebras', providerId: 'cerebras', mode: 'free', cost: 'free', recommended: false, bestValue: false, limitsUrl: 'https://inference-docs.cerebras.ai/support/rate-limits' },
  { id: 'openrouter', providerId: 'openrouter', mode: 'free', cost: 'free', recommended: false, bestValue: false, limitsUrl: 'https://openrouter.ai/docs/api-reference/limits' },
  { id: 'opencode', providerId: 'opencode', mode: 'byok', cost: 'paid', recommended: false, bestValue: true, limitsUrl: 'https://opencode.ai/docs/zen/' },
].map((r) => Object.freeze({ ...r, model: PROVIDERS[r.providerId].models.do, signupUrl: PROVIDERS[r.providerId].keyPageURL })));

const STEP_COUNT = 4;
/** i18n keys one route's card reads: name, what, note and STEP_COUNT numbered steps. */
const routeKeys = (r) => [`freeKey.${r.id}.name`, `freeKey.${r.id}.what`, `freeKey.${r.id}.note`, ...Array.from({ length: STEP_COUNT }, (_, i) => `freeKey.${r.id}.s${i + 1}`)];
const routeById = (id) => ROUTES.find((r) => r.id === id) || null;

/** Selecting a card: the two-choice mode first (OpenCode lives under "own key"), then the provider. The provider's table models
 *  are what is sent, so this also pre-selects the card's model. Uses only the two existing zumi.ai calls. */
async function chooseRoute(zumi, id) {
  const r = routeById(id);
  if (!r) return { ok: false, error: 'bad_route' };
  const m = await zumi.ai.setMode(r.mode);
  if (!m || m.ok === false) return { ok: false, error: (m && m.error) || 'mode_failed' };
  const p = await zumi.ai.setProvider(r.providerId);
  if (!p || p.ok === false) return { ok: false, error: (p && p.error) || 'provider_failed' };
  return { ok: true, route: r };
}

/** Paste -> brainKey.save: the host shape-checks, then the provider's list-models call validates the key (no generation, no
 *  charge). Returns only a line code the UI turns into words; never the key. */
async function saveRouteKey(zumi, raw) {
  const key = typeof raw === 'string' ? raw.trim() : '';
  if (!key) return { ok: false, line: 'bad_format' };
  let r;
  try { r = await zumi.brainKey.save(key, false); } catch { return { ok: false, line: 'unreachable' }; }
  if (r && r.ok) return { ok: true, line: r.check === 'works' ? 'works' : 'unverified' };
  const e = r && r.error;
  return { ok: false, line: e === 'rejected' || e === 'bad_format' || e === 'no_encryption' ? e : 'unreachable' };
}

module.exports = { ROUTES, STEP_COUNT, routeKeys, routeById, chooseRoute, saveRouteKey };
