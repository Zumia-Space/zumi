'use strict';
// Models by role (T-31 board-roles, owner 09-10). A user feature: four
// kinds of work, each with its own model + effort picked from the user's OWN configured provider (BYOK -- no vendor
// is named here; the default model is whatever the provider module already uses).
//   plan   -- thinks and plans          do     -- executes the work
//   check  -- reviews the result        lookup -- browses and gathers
// Stored in settings.json `roleModels` as { <role>: { model, effort } } for the roles the user changed ONLY; a role
// with no entry follows the defaults (so a later change of the provider's default model still reaches it). The same
// object carries `off: [<role>...]`, the Plan / Check / Look up roles the user switched off (CoS decision 10-10: BYOK
// users pay per call, so every extra call can be turned off; on by default; Do has no switch).
// Pure functions: main.js owns the settings file and the IPC; chat-brain.js runs the roles (role-triggers.js decides
// when Plan / Check / Look up join a turn).
const { EFFORTS, isClaudeModel } = require('./chat-brain.js');
// T-31 fix r item 3: a role choice is validated against the SELECTED provider's own id shape. The two shapes the
// provider table allows ("vendor/model" for OpenRouter/Groq, a plain id for Gemini) are both accepted here, so the
// roles card can show and store exactly the ids its own provider sends; chat-brain still enforces the one shape per
// provider when it posts.
const { MODEL_ID_ANY } = require('./providers.js');

const ROLES = ['plan', 'do', 'check', 'lookup'];
// Default effort per role. Do = 'off' keeps the chat reply's measured latency (reasoning disabled per request, voice
// round 6). Plan = 'low': it runs BEFORE the reply (8 s budget), so high effort would only hit the timeout. Check runs
// after Zumi has spoken, so it gets the most thinking; looking things up the least.
const DEFAULT_EFFORT = { plan: 'low', do: 'off', check: 'high', lookup: 'low' };
// The step each role drives (chat-brain.js turnStream): plan = an outline before the reply, chat = the reply itself,
// check = a review after the reply, lookup = the reply with the provider's web search.
const WIRED_ROLES = { plan: 'plan', do: 'chat', check: 'check', lookup: 'lookup' };
// The roles with an on/off switch (each adds a call or a search to the turns it fits).
const SWITCH_ROLES = ['plan', 'check', 'lookup'];
// A model id whose name part carries one of these tokens is a fast/small tier (a heuristic over the provider's own
// ids; no vendor named). Used only to pick a STRONGER default for the thinking roles.
const FAST_TIER = /(^|[-_.:])(flash|mini|lite|nano|small|tiny|fast|turbo|instant|air)([-_.:]|$)/i;

// Product rule (T-31 role-ui-port step 7, CoS 10-10; isClaudeModel lives in chat-brain.js, which sends the ids): Zumi
// never lists or runs a Claude model. The provider's catalog (OpenRouter's public list, unfiltered) holds them, and
// router ids such as openrouter/auto that can pick one (openrouter/free picks only free models, so it stays), so they
// are dropped from every list this module or main.js hands out, and a stored choice of one is ignored (the role falls
// back to its default).
const withoutClaude = (models) => (Array.isArray(models) ? models.filter((m) => !isClaudeModel(m)) : models);

const validChoice = (c) => Boolean(c) && typeof c.model === 'string' && MODEL_ID_ANY.test(c.model) && EFFORTS.includes(c.effort) && !isClaudeModel(c.model);
const vendorOf = (id) => id.split('/')[0];

// The default for the thinking roles (Plan, Check): a model DIFFERENT from Do's, so Check is a real second opinion
// out of the box. Preference: same vendor + not a fast tier + reasoning, then same vendor + not a fast tier, then any
// vendor (reasoning first), then any other model. A free model (`:free`, or the openrouter/free router, which picks
// one at random) is never the stronger pick. null when the list is unknown or holds only Do's model.
function pickStronger(doModel, models) {
  if (!Array.isArray(models)) return null;
  const others = models.filter((m) => m && typeof m.id === 'string' && MODEL_ID_ANY.test(m.id) && m.id !== doModel);
  const strong = others.filter((m) => !/(?::free|^openrouter\/free)$/i.test(m.id) && !FAST_TIER.test(m.id.split('/')[1]));
  const sameVendor = strong.filter((m) => vendorOf(m.id) === vendorOf(doModel));
  const pick = sameVendor.find((m) => m.reasoning === true) || sameVendor[0] || strong.find((m) => m.reasoning === true) || strong[0] || others[0];
  return pick ? pick.id : null;
}

// stored: settings.json `roleModels` (any shape; junk entries are ignored). defaultModel: the provider's model id.
// models: the provider's list ([{id, reasoning}]) or null when it could not be loaded.
// providerDefaults (T-31 fix r item 2, optional): the active provider table's free per-role ids {plan,do,check,lookup}.
//   When given, an unset role defaults to the provider's OWN table id -- the same model chat-brain posts -- so the
//   roles card shows exactly what is sent for that provider. Absent -> the pickStronger defaults (legacy/OpenRouter
//   catalog behaviour, and every existing caller/test).
// -> { defaults, roles: {role:{model,effort,by:'user'|'default',on}}, modelCount, sameCheckModel, warnSameCheck, onlyOneModel }
//   on: false for a Plan / Check / Look up role the user switched off (Do is always on).
//   warnSameCheck: Check reviews with Do's model although another model exists (the amber "!").
//   onlyOneModel: the provider offers one model, so Check cannot differ -- a soft note, never a warning.
function resolveRoles(stored, defaultModel, allModels = null, providerDefaults = null) {
  const models = withoutClaude(allModels);
  const strong = pickStronger(defaultModel, models) || defaultModel;
  const pd = providerDefaults && typeof providerDefaults === 'object' ? providerDefaults : null;
  const defaults = {
    plan: { model: (pd && pd.plan) || strong, effort: DEFAULT_EFFORT.plan },
    do: { model: (pd && pd.do) || defaultModel, effort: DEFAULT_EFFORT.do },
    check: { model: (pd && pd.check) || strong, effort: DEFAULT_EFFORT.check },
    lookup: { model: (pd && pd.lookup) || defaultModel, effort: DEFAULT_EFFORT.lookup },
  };
  const roles = {};
  const off = offList(stored);
  for (const role of ROLES) {
    const own = stored && typeof stored === 'object' ? stored[role] : null;
    roles[role] = validChoice(own) ? { model: own.model, effort: own.effort, by: 'user' } : { ...defaults[role], by: 'default' };
    roles[role].on = !off.includes(role);
  }
  const modelCount = Array.isArray(models) ? models.length : null;
  const sameCheckModel = roles.check.model === roles.do.model;
  return {
    defaults, roles, modelCount, sameCheckModel,
    warnSameCheck: sameCheckModel && modelCount !== null && modelCount > 1,
    onlyOneModel: modelCount !== null && modelCount <= 1,
  };
}

// -> { ok:true, next } (the new `roleModels` object to save) | { ok:false, error:'bad_role'|'bad_choice' }.
function setRoleChoice(stored, role, choice) {
  if (!ROLES.includes(role)) return { ok: false, error: 'bad_role' };
  if (!validChoice(choice)) return { ok: false, error: 'bad_choice' };
  return { ok: true, next: { ...cleanStored(stored), [role]: { model: choice.model, effort: choice.effort } } };
}

// Back to the default: the role's entry is removed, not overwritten with today's default values.
function resetRoleChoice(stored, role) {
  if (!ROLES.includes(role)) return { ok: false, error: 'bad_role' };
  const next = cleanStored(stored);
  delete next[role];
  return { ok: true, next };
}

// The on/off switch of Plan / Check / Look up. -> { ok:true, next } | { ok:false, error:'bad_role' } (Do has no switch).
function setRoleOn(stored, role, on) {
  if (!SWITCH_ROLES.includes(role)) return { ok: false, error: 'bad_role' };
  const next = cleanStored(stored);
  const off = offList(next).filter((r) => r !== role);
  if (on === false) off.push(role);
  if (off.length) next.off = SWITCH_ROLES.filter((r) => off.includes(r)); else delete next.off;
  return { ok: true, next };
}

const offList = (stored) => (stored && Array.isArray(stored.off) ? stored.off.filter((r) => SWITCH_ROLES.includes(r)) : []);

function cleanStored(stored) {
  const out = {};
  if (!stored || typeof stored !== 'object') return out;
  for (const role of ROLES) if (validChoice(stored[role])) out[role] = { model: stored[role].model, effort: stored[role].effort };
  const off = offList(stored);
  if (off.length) out.off = SWITCH_ROLES.filter((r) => off.includes(r));
  return out;
}

module.exports = { ROLES, EFFORTS, DEFAULT_EFFORT, WIRED_ROLES, SWITCH_ROLES, pickStronger, resolveRoles, setRoleChoice, resetRoleChoice, setRoleOn, isClaudeModel, withoutClaude };
