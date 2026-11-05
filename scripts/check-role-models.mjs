// Models by role (T-31 board-roles): no network, no real key, mocked fetch (same conventions as check-chat-stream.mjs).
//   1. role-models.js: defaults per role, junk ignored, by=user only for a saved choice, sameCheckModel;
//      set refuses a bad role/model/effort, keeps the other roles; reset removes the entry (back to the default);
//   2. chat-brain: the Do role picks the model of each turn (no restart), its effort reaches the request as
//      `reasoning: {effort}` ('off' keeps `{enabled:false}`), a model switch drops the provider pin, a model that
//      refuses the effort is retried once without it; status() follows the Do model;
//   3. fetchModelList / listModels: text models only, names + reasoning flag kept, NO key sent, a failure is a typed
//      result (not cached), a success is cached;
//   4. UI shell: the Settings card exists, every roles.* key is in en/vi/zh, no model id is hardcoded in the renderer;
//   5. product rule (T-31 role-ui-port step 7): no Claude model in any list main hands out (an anthropic fixture is
//      absent from the picker and the defaults), a stored Claude choice falls back to the default, set refuses one;
//      the owner-only "Lane models per task -> Board" line is hidden unless ownerAdmin;
//   6. T-31 zumi-roles: all four roles wired (no "Coming soon"), Plan effort defaults to low, Plan / Check / Look up
//      on-off switches (default on, Do has none) persist in roleModels.off and survive set/reset; main wires
//      roles:setOn and the per-turn getRoles. The turn behaviour itself is check-chat-stream.mjs section 9.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { TABLES } from '../src/renderer/i18n.js';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { ROLES, DEFAULT_EFFORT, WIRED_ROLES, SWITCH_ROLES, pickStronger, resolveRoles, setRoleChoice, resetRoleChoice, setRoleOn, isClaudeModel, withoutClaude } = require('../src/main/role-models.js');
const { createChatBrain, fetchModelList, MODELS_PATH, ALLOWED_ORIGIN } = require('../src/main/chat-brain.js');
const { createKeyStore } = require('../src/main/reflex-jev.js');

let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); } };

// ---------- 1. role-models.js ----------
const DEF = 'vendor/default-model';
{
  const v = resolveRoles(undefined, DEF);
  ok(ROLES.join() === 'plan,do,check,lookup', 'roles: plan, do, check, lookup');
  ok(ROLES.every((r) => v.roles[r].by === 'default' && v.roles[r].model === DEF && v.roles[r].effort === DEFAULT_EFFORT[r]), 'resolve: nothing saved -> every role is the default', JSON.stringify(v.roles));
  ok(v.roles.do.effort === 'off', 'resolve: Do defaults to effort off (keeps the chat latency hygiene)');
  ok(v.sameCheckModel === true && v.warnSameCheck === false && v.onlyOneModel === false, 'resolve: model list unknown -> Check falls back to the Do model, but no warning and no note');
  // Defaults from the provider's list: Check/Plan get a model DIFFERENT from Do's (same vendor, not a fast tier first).
  const FLASH = 'vendor/model-flash';
  const list = [{ id: FLASH, reasoning: true }, { id: 'vendor/model-mini', reasoning: true }, { id: 'vendor/model-pro', reasoning: true }, { id: 'other/big', reasoning: true }, { id: 'vendor/model-pro:free', reasoning: true }];
  const d = resolveRoles(undefined, FLASH, list);
  ok(d.defaults.do.model === FLASH && d.defaults.check.model === 'vendor/model-pro' && d.defaults.plan.model === 'vendor/model-pro' && d.defaults.lookup.model === FLASH, 'defaults: Do/Look up = the provider default, Check/Plan = a stronger same-vendor model', JSON.stringify(d.defaults));
  ok(!d.sameCheckModel && !d.warnSameCheck && !d.onlyOneModel && d.modelCount === 5, 'defaults: no warning out of the box when 2+ models exist');
  ok(pickStronger(FLASH, [{ id: FLASH }, { id: 'other/big', reasoning: true }]) === 'other/big', 'pickStronger: no same-vendor option -> another vendor');
  ok(pickStronger(FLASH, [{ id: FLASH }, { id: 'other/tiny-mini' }]) === 'other/tiny-mini', 'pickStronger: only fast tiers left -> still a DIFFERENT model');
  const one = resolveRoles(undefined, FLASH, [{ id: FLASH }]);
  ok(one.sameCheckModel && !one.warnSameCheck && one.onlyOneModel, 'one model: Check = Do, no warning, soft note flag');
  const clash = resolveRoles({ do: { model: 'vendor/model-pro', effort: 'off' } }, FLASH, list);
  ok(clash.warnSameCheck === true, 'warning: the user moves Do onto the Check model while other models exist');
  const junk = resolveRoles({ plan: { model: 'not an id', effort: 'high' }, do: { model: 'a/b', effort: 'extreme' }, check: 'x', lookup: null, extra: { model: 'a/b', effort: 'low' } }, DEF);
  ok(ROLES.every((r) => junk.roles[r].by === 'default'), 'resolve: junk entries are ignored (bad id, bad effort, wrong shape)', JSON.stringify(junk.roles));
  const mine = resolveRoles({ check: { model: 'other/reviewer', effort: 'high' } }, DEF);
  ok(mine.roles.check.by === 'user' && mine.roles.check.model === 'other/reviewer' && mine.sameCheckModel === false, 'resolve: a saved Check on another model -> by user, no same-model flag');
  ok(JSON.stringify(WIRED_ROLES) === '{"plan":"plan","do":"chat","check":"check","lookup":"lookup"}', 'wired: all four roles drive a real step (plan outline, chat reply, check review, web look-up)', JSON.stringify(WIRED_ROLES));

  ok(setRoleChoice({}, 'boss', { model: 'a/b', effort: 'low' }).error === 'bad_role', 'set: unknown role refused');
  ok(setRoleChoice({}, 'do', { model: 'https://evil.example/x', effort: 'low' }).error === 'bad_choice', 'set: a URL is not a model id');
  ok(setRoleChoice({}, 'do', { model: 'a/b', effort: 'max' }).error === 'bad_choice', 'set: unknown effort refused');
  const s1 = setRoleChoice({ plan: { model: 'p/q', effort: 'high' }, junk: 1 }, 'do', { model: 'a/b', effort: 'medium', by: 'cos' });
  ok(s1.ok && JSON.stringify(s1.next) === '{"plan":{"model":"p/q","effort":"high"},"do":{"model":"a/b","effort":"medium"}}', 'set: keeps the other roles, drops junk and extra fields', JSON.stringify(s1.next));
  const r1 = resetRoleChoice(s1.next, 'do');
  ok(r1.ok && !('do' in r1.next) && r1.next.plan, 'reset: removes the role entry (it follows the default again)');
  ok(resolveRoles(r1.next, 'vendor/new-default').roles.do.model === 'vendor/new-default', 'reset: a later change of the provider default reaches a reset role');
}

// ---------- 2. chat-brain applies the Do role per turn ----------
const tmp = path.join(ROOT, '.role-models-check-tmp');
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });
process.on('exit', () => { fs.rmSync(tmp, { recursive: true, force: true }); });
const FAKE_KEY = 'sk-or-TESTFAKEKEY1234567890ABCDEFGHIJ'; // shape-valid, never a real secret
const safeStorage = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(`ENC:${s}`, 'utf8'), decryptString: (b) => b.toString('utf8').slice(4) };
fs.writeFileSync(path.join(tmp, 'jev-key.import'), FAKE_KEY);
createKeyStore({ safeStorage, dir: tmp }).importIfPresent();

const calls = [];
let script = [];
const fetchImpl = async (url, opts) => {
  calls.push({ url, opts, body: opts.body ? JSON.parse(opts.body) : null });
  const next = script.shift();
  if (!next) throw new Error('test: no scripted response left');
  return next();
};
const reply = (provider = 'Fast') => () => ({ ok: true, status: 200, json: async () => ({ provider, choices: [{ message: { content: '[agree] Sure.' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) });
{
  let stored = {};
  const logs = [];
  const brain = createChatBrain({
    safeStorage, dir: tmp, fetchImpl, ownerAdmin: true, model: DEF, log: (m) => logs.push(m),
    getRoute: (defaultModel) => resolveRoles(stored, defaultModel).roles.do,
  });
  script = [reply()];
  await brain.turn({ message: 'hi', history: [] });
  ok(calls[0].body.model === DEF && calls[0].body.reasoning && calls[0].body.reasoning.enabled === false, 'turn: no Do choice -> the default model, reasoning off', JSON.stringify({ m: calls[0].body.model, r: calls[0].body.reasoning }));

  stored = setRoleChoice(stored, 'do', { model: 'other/thinker', effort: 'high' }).next;
  ok(brain.status().model === 'other/thinker', 'status: follows the Do model (Settings "AI brain" line)');
  script = [reply()];
  const r2 = await brain.turn({ message: 'hi', history: [] });
  ok(calls[1].body.model === 'other/thinker' && JSON.stringify(calls[1].body.reasoning) === '{"effort":"high"}' && r2.model === 'other/thinker', 'turn: Do = other model + High -> next turn uses it, reasoning {effort:"high"}, no restart', JSON.stringify({ m: calls[1].body.model, r: calls[1].body.reasoning }));
  ok(logs.some((l) => /Do role model switched \(vendor\/default-model -> other\/thinker\)/.test(l)), 'log: the model switch is logged (ids only, no text)');

  // A refused effort: one retry without the reasoning field, then the model's default while this model is in use.
  script = [() => ({ ok: false, status: 400, text: async () => 'reasoning effort not supported' }), reply()];
  const r3 = await brain.turn({ message: 'hi', history: [] });
  ok(r3.ok && calls.length === 4 && calls[2].body.reasoning && !calls[3].body.reasoning, 'turn: a model that refuses the effort is retried once without it', JSON.stringify(calls.slice(2).map((c) => c.body.reasoning || null)));
  script = [reply()];
  await brain.turn({ message: 'hi', history: [] });
  ok(!calls[4].body.reasoning && brain.routing().effortOk === false, 'turn: the refusal sticks while the same model is in use');

  stored = resetRoleChoice(stored, 'do').next;
  script = [reply()];
  await brain.turn({ message: 'hi', history: [] });
  ok(calls[5].body.model === DEF && calls[5].body.reasoning && calls[5].body.reasoning.enabled === false && brain.routing().effortOk === true, 'reset: back to the default model, reasoning off again, refusal forgotten', JSON.stringify(calls[5].body.reasoning));

  // Provider pin is per model: a pinned provider is dropped when the Do model changes.
  const sseFast = () => {
    const enc = new TextEncoder();
    return {
      ok: true, status: 200,
      body: (async function* () {
        yield enc.encode(`data: ${JSON.stringify({ provider: 'Pinned', choices: [{ delta: { content: '[agree] Sure, I can do that for you right away.' } }] })}\n\n`);
        yield enc.encode(`data: ${JSON.stringify({ provider: 'Pinned', choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
        yield enc.encode('data: [DONE]\n\n');
      })(),
    };
  };
  script = [sseFast];
  const { live } = await brain.turnStream({ turnId: 'b'.repeat(32), message: 'hi', history: [] });
  if (live) await live.final;
  ok(brain.routing().provider === 'Pinned', 'pin: a fast streamed call pins its provider (unchanged behaviour)');
  stored = setRoleChoice(stored, 'do', { model: 'other/thinker', effort: 'off' }).next;
  script = [reply()];
  await brain.turn({ message: 'hi', history: [] });
  const last = calls[calls.length - 1].body;
  ok(last.model === 'other/thinker' && !last.provider && last.reasoning && last.reasoning.enabled === false, 'pin: a Do model switch drops the provider pin (never pins model B to model A\'s host)', JSON.stringify({ m: last.model, p: last.provider }));
}

// ---------- 3. model list ----------
{
  const listCalls = [];
  const listFetch = (resp) => async (url, opts) => { listCalls.push({ url, opts }); return resp(); };
  const data = { data: [
    { id: 'vendor/text-model', name: 'Vendor: Text Model', supported_parameters: ['tools', 'reasoning'], architecture: { output_modalities: ['text'] } },
    { id: 'vendor/plain', name: 'Vendor: Plain', supported_parameters: ['tools'] },
    { id: 'vendor/image-only', name: 'Vendor: Image', architecture: { output_modalities: ['image'] } },
    { id: 'no-slash', name: 'Bad id' },
    { id: 'vendor/no-name' },
    { id: 'someone/router', name: 'Someone: Router', architecture: { output_modalities: ['text'], tokenizer: 'Router' } },
  ] };
  const r = await fetchModelList(listFetch(() => ({ ok: true, status: 200, json: async () => data })));
  ok(r.ok && r.models.map((m) => m.id).join() === 'vendor/text-model,vendor/plain,vendor/no-name,someone/router', 'list: text models with a valid id only', JSON.stringify(r.models));
  ok(r.models[3].router === true && r.models.slice(0, 3).every((m) => m.router === false) && withoutClaude(r.models).every((m) => m.id !== 'someone/router'), 'list: a catalog router (tokenizer "Router") is flagged, and the Claude filter drops it', JSON.stringify(r.models));
  ok(r.models[0].reasoning === true && r.models[1].reasoning === false && r.models[2].reasoning === null && r.models[2].name === 'vendor/no-name', 'list: reasoning flag + name kept (id as the name when the host gives none)');
  const sent = listCalls[0];
  ok(sent.url === `${ALLOWED_ORIGIN}${MODELS_PATH}` && sent.opts.redirect === 'error' && !(sent.opts.headers && (sent.opts.headers.authorization || sent.opts.headers.Authorization)), 'list: allowlisted origin, redirect:error, NO key sent', JSON.stringify(sent.opts.headers));
  const bad = await fetchModelList(listFetch(() => ({ ok: false, status: 503 })));
  ok(!bad.ok && bad.error === 'http_503' && Array.isArray(bad.models) && bad.models.length === 0, 'list: an HTTP failure is a typed result', JSON.stringify(bad));
  const net = await fetchModelList(async () => { throw new TypeError('fetch failed'); });
  ok(!net.ok && net.error === 'network', 'list: a network failure is a typed result');

  let n = 0;
  let failNext = true;
  const brain = createChatBrain({ safeStorage, dir: tmp, model: DEF, log: () => {}, fetchImpl: async () => { n++; if (failNext) return { ok: false, status: 500 }; return { ok: true, status: 200, json: async () => data }; } });
  const a = await brain.listModels();
  failNext = false;
  const b = await brain.listModels();
  const c = await brain.listModels();
  ok(!a.ok && b.ok && c.ok && n === 2, 'listModels: a failure is not cached, a success is (2 fetches for 3 calls)', `n=${n}`);
}

// ---------- 4. UI shell ----------
{
  const html = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');
  ok(/id="roles-card"/.test(html) && /data-i18n="roles\.title"/.test(html), 'settings: the Models by role card is in the Settings tab');
  { // Owner 01-11: these models only shape a chat reply; the board's work stays with the code sessions.
    const i18nSrc = fs.readFileSync(path.join(ROOT, 'src/renderer/i18n.js'), 'utf8');
    const EXPECT = { 'roles.title': "Zumi's chat models", 'roles.plan': 'Think first', 'roles.plan.desc': 'Outlines the reply before answering', 'roles.do': 'Reply', 'roles.do.desc': 'Writes what Zumi says', 'roles.check': 'Double-check', 'roles.check.desc': 'Checks the reply for mistakes', 'roles.lookup': 'Look up', 'roles.lookup.desc': 'Searches the web for a reply', 'roles.boardLink': 'Models for task lanes (code sessions)' };
    for (const [k, v] of Object.entries(EXPECT)) ok(i18nSrc.includes(`'${k}': ${v.includes("'") ? JSON.stringify(v) : `'${v}'`},`), `label: ${k} is "${v}"`);
    ok(i18nSrc.includes('Work on the board stays with your code sessions.'), 'label: the status line says board work stays with the code sessions');
    const OLD = ['hands work to her helpers', 'giao việc cho đội phụ', '把工作交给她的助手', 'Đội phụ', 'Orchestrator', 'Models by role', 'kind of work', 'Does the work', 'Thinks and plans', 'Lane models per task', 'Mô hình theo vai trò', 'từng loại việc', 'Làm phần việc chính', '按角色选择模型', '每类工作', '完成主要工作'];
    const stale = OLD.filter((x) => i18nSrc.split('\n').some((l) => !/^\s*\/\//.test(l) && l.includes(x)) || new RegExp(`>${x}<`).test(html));
    ok(stale.length === 0, 'label: no visible string keeps an old name, in EN, VI or ZH', stale.join(','));
  }
  const keys = Object.keys(TABLES.en).filter((k) => k.startsWith('roles.'));
  ok(keys.length >= 30 && ['vi', 'zh'].every((l) => keys.every((k) => typeof TABLES[l][k] === 'string' && TABLES[l][k].length > 0)), `i18n: ${keys.length} roles.* keys in en, vi and zh`);
  const ui = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'role-models.js'), 'utf8').split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join('\n');
  ok(!/['"`][a-z0-9-]+\/[a-z0-9.-]+['"`]/i.test(ui), 'renderer: no model id hardcoded (BYOK: the list comes from the provider)');
}

// ---------- 5. product rule: no Claude model in Zumi's own Settings / chat ----------
{
  // OpenRouter's public catalog shape, with the anthropic entries it really carries
  const catalog = [
    { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek: DeepSeek V4 Flash', reasoning: true },
    { id: 'anthropic/claude-opus-5.5', name: 'Anthropic: Claude Opus 5.5', reasoning: true },
    { id: 'anthropic/claude-haiku-5.5', name: 'Anthropic: Claude Haiku 5.5', reasoning: false },
    { id: 'someone/claude-distill-8b', name: 'Someone: Distill 8B', reasoning: true },
    { id: 'other/reviewer', name: 'Other: Claude-style Reviewer', reasoning: true },
    { id: 'google/gemini-3.7-pro', name: 'Google: Gemini 3.7 Pro', reasoning: true },
  ];
  const kept = withoutClaude(catalog).map((m) => m.id);
  ok(kept.join() === 'deepseek/deepseek-v4-flash,google/gemini-3.7-pro', 'filter: anthropic/* ids, ids with "claude" and names with "Claude" are dropped; the rest kept in order', kept.join());
  ok(isClaudeModel('anthropic/anything') && isClaudeModel({ id: 'x/y', name: 'CLAUDE z' }) && !isClaudeModel('google/gemini-3.7-pro'), 'filter: ids and names, case-insensitive');
  // routers pick the model per request, so they can pick a Claude model (review of b4d6d75: openrouter/auto slipped through)
  const routers = [{ id: 'openrouter/auto', name: 'Auto Router' }, { id: 'OpenRouter/auto-beta', name: 'Auto Router (Beta)' }, catalog[0]];
  ok(isClaudeModel('openrouter/auto') && withoutClaude(routers).map((m) => m.id).join() === 'deepseek/deepseek-v4-flash', 'filter: openrouter/auto and other openrouter/ routers are dropped', JSON.stringify(withoutClaude(routers)));
  const auto = resolveRoles({ do: { model: 'openrouter/auto', effort: 'off' }, lookup: { model: 'openrouter/auto', effort: 'low' } }, 'deepseek/deepseek-v4-flash', catalog);
  ok(auto.roles.do.by === 'default' && auto.roles.do.model === 'deepseek/deepseek-v4-flash' && auto.roles.lookup.by === 'default' && setRoleChoice({}, 'lookup', { model: 'openrouter/auto', effort: 'low' }).error === 'bad_choice',
    'stored/set: an openrouter/auto choice falls back to the default and is refused on save', JSON.stringify(auto.roles));
  // third-party routers in the catalog whose pools hold Claude (docs jev-router, switchyard-router, read 10-10)
  ok(['typesafe/jev-router', 'nvidia/switchyard', 'openrouter/fusion', 'openrouter/pareto-code'].every((id) => isClaudeModel(id)) && setRoleChoice({}, 'check', { model: 'nvidia/switchyard', effort: 'high' }).error === 'bad_choice',
    'filter: typesafe/jev-router, nvidia/switchyard and every other openrouter/ router are dropped by id too (a stored or hand-set one never runs)');
  // openrouter/free picks only free models and no Claude model is free (docs free-router, catalog read 10-10)
  const free = { id: 'openrouter/free', name: 'Free Models Router', reasoning: true, router: true };
  ok(!isClaudeModel('openrouter/free') && !isClaudeModel(free) && withoutClaude([free, catalog[0]]).length === 2 && setRoleChoice({}, 'lookup', { model: 'openrouter/free', effort: 'low' }).ok,
    'filter: openrouter/free is the one router kept (listed, can be chosen)', JSON.stringify(withoutClaude([free])));
  const fd = resolveRoles(undefined, 'deepseek/deepseek-v4-flash', [catalog[0], free, catalog[5]]);
  ok(fd.defaults.check.model === 'google/gemini-3.7-pro' && fd.defaults.plan.model === 'google/gemini-3.7-pro', 'defaults: openrouter/free (a random free model) is never the stronger Check/Plan default', JSON.stringify(fd.defaults));
  const v = resolveRoles(undefined, 'deepseek/deepseek-v4-flash', [catalog[0], catalog[1]]);
  ok(v.defaults.check.model !== 'anthropic/claude-opus-5.5' && v.defaults.plan.model !== 'anthropic/claude-opus-5.5' && v.modelCount === 1 && v.onlyOneModel, 'defaults: a Claude model is never picked as the stronger Check/Plan default (and is not counted)', JSON.stringify(v.defaults));
  const stored = resolveRoles({ do: { model: 'anthropic/claude-opus-5.5', effort: 'high' }, check: { model: 'someone/claude-distill-8b', effort: 'high' } }, 'deepseek/deepseek-v4-flash', catalog);
  ok(stored.roles.do.by === 'default' && stored.roles.do.model === 'deepseek/deepseek-v4-flash' && stored.roles.check.by === 'default', 'stored: a saved Claude choice falls back to the default (the chat never runs it)', JSON.stringify(stored.roles));
  ok(setRoleChoice({}, 'do', { model: 'anthropic/claude-sonnet-5.5', effort: 'low' }).error === 'bad_choice', 'set: a Claude model is refused');
  // the --settings-shots fixture carries anthropic entries on purpose; what roleProvider hands out has none
  const fx = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'main', 'role-models-fixtures.json'), 'utf8'));
  const fxOut = withoutClaude(fx.models);
  ok(fx.models.some((m) => /^anthropic\//.test(m.id)) && !fxOut.some((m) => isClaudeModel(m)) && fxOut.length === fx.models.length - 2 && !isClaudeModel(fx.defaultModel), 'fixture: anthropic models present in the provider list, absent after the filter; the default is not Claude');
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.js'), 'utf8');
  const prov = main.slice(main.indexOf('function roleProvider()'), main.indexOf('async function rolesView()'));
  ok((prov.match(/listModels: noClaude\(/g) || []).length === 2 && !/listModels: (?!noClaude\()/.test(prov), 'main: both roleProvider branches (real + shots fixture) hand out the filtered list');
  ok(/ipcMain\.handle\('roles:models'[\s\S]{0,300}p\.listModels\(\)/.test(main) && /async function rolesView\(\)[\s\S]{0,200}p\.listModels\(\)/.test(main), 'main: roles:models and rolesView read the list only through roleProvider');
  const getRoute = /getRoute: \(defaultModel\) => resolveRoles\(/.test(main);
  ok(getRoute, 'main: the chat turn (getRoute) resolves the Do role through resolveRoles, so a stored Claude Do never runs');
  const html = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
  ok(/<p id="roles-board-link"[^>]*\bhidden\b/.test(html) && /if \(info\.ownerAdmin\) \{\s*\$\('roles-board-link'\)\.hidden = false;/.test(app) && (app.match(/roles-board-link/g) || []).length === 1, 'owner line: "Lane models per task -> Board" starts hidden and is shown only when ownerAdmin');
}

// ---------- 6. T-31 zumi-roles: every role live, Plan effort low, on/off switches ----------
{
  ok(DEFAULT_EFFORT.plan === 'low' && DEFAULT_EFFORT.check === 'high' && DEFAULT_EFFORT.do === 'off', 'defaults: Plan effort low (runs before the reply, 8 s budget), Check high, Do off', JSON.stringify(DEFAULT_EFFORT));
  ok(SWITCH_ROLES.join() === 'plan,check,lookup', 'switches: Plan, Check and Look up have one; Do has none');
  const v = resolveRoles(undefined, DEF);
  ok(ROLES.every((r) => v.roles[r].on === true), 'switches: every role is on by default', JSON.stringify(v.roles));
  const off = setRoleOn({}, 'lookup', false);
  ok(off.ok && JSON.stringify(off.next) === '{"off":["lookup"]}' && resolveRoles(off.next, DEF).roles.lookup.on === false && resolveRoles(off.next, DEF).roles.plan.on === true, 'switches: Look up off is stored as roleModels.off and read back', JSON.stringify(off.next));
  ok(setRoleOn({}, 'do', false).error === 'bad_role' && setRoleOn({}, 'boss', false).error === 'bad_role', 'switches: Do (and an unknown role) cannot be switched');
  const kept = setRoleChoice(setRoleOn(off.next, 'check', false).next, 'check', { model: 'other/reviewer', effort: 'high' });
  ok(kept.ok && JSON.stringify(kept.next.off) === '["check","lookup"]' && kept.next.check.model === 'other/reviewer', 'switches: changing a model keeps the switches', JSON.stringify(kept.next));
  const reset = resetRoleChoice(kept.next, 'check');
  ok(reset.ok && !reset.next.check && JSON.stringify(reset.next.off) === '["check","lookup"]', 'switches: "Use default" on a model keeps the switch (model and switch are separate)', JSON.stringify(reset.next));
  const back = setRoleOn(setRoleOn(reset.next, 'check', true).next, 'lookup', true);
  ok(back.ok && !('off' in back.next), 'switches: back on -> the off list goes away', JSON.stringify(back.next));
  const junk = resolveRoles({ off: ['do', 'boss', 7, 'plan'] }, DEF);
  ok(junk.roles.do.on && junk.roles.plan.on === false && junk.roles.check.on, 'switches: junk in the off list is ignored (Do can never be switched off)', JSON.stringify(junk.roles));
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.js'), 'utf8');
  ok(/ipcMain\.handle\('roles:setOn'[\s\S]{0,400}typeof on !== 'boolean'[\s\S]{0,200}setRoleOn\(loadSettings\(\)\.roleModels, role, on\)/.test(main), 'main: roles:setOn (app page only, boolean only) writes through setRoleOn');
  ok(/getRoles: \(defaultModel, models\) => resolveRoles\(loadSettings\(\)\.roleModels, defaultModel, settingsShotsDir \? shotsRoleModels\(\) : models\)\.roles/.test(main), 'main: the chat turn reads Plan / Check / Look up per turn through resolveRoles (Claude filter + defaults + switches)');
  const preload = fs.readFileSync(path.join(ROOT, 'src', 'main', 'preload.js'), 'utf8');
  ok(/setOn: \(role, on_\) => ipcRenderer\.invoke\('roles:setOn', role, on_\)/.test(preload), 'preload: roles.setOn');
  const ui = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'role-models.js'), 'utf8');
  ok(!/comingSoon|soon-tag/.test(ui) && /SWITCH_ROLES\.includes\(role\)\) head\.appendChild\(roleSwitch\(role\)\)/.test(ui) && /zumi\.roles\.setOn\(role, sw\.checked\)/.test(ui), 'renderer: no "Coming soon"; a switch in the Plan / Check / Look up cells, saved through roles.setOn');
  ok(/memory/i.test(TABLES.en['roles.lookup.descNoWeb']) && /trí nhớ/.test(TABLES.vi['roles.lookup.descNoWeb']) && /记忆/.test(TABLES.zh['roles.lookup.descNoWeb']), 'off OpenRouter: the Look up line says model memory, no fresh facts', TABLES.vi['roles.lookup.descNoWeb']);
  ok(/OpenRouter/.test(TABLES.en['skills.how.crew.lookup']) && /OpenRouter/.test(TABLES.vi['skills.how.crew.lookup']) && /OpenRouter/.test(TABLES.zh['skills.how.crew.lookup']), 'the Skills line says web search is OpenRouter only', TABLES.vi['skills.how.crew.lookup']);
  ok(['plan', 'check', 'lookup'].every((k) => ['en', 'vi', 'zh'].every((l) => typeof TABLES[l][`roles.usedFor.${k}`] === 'string')) && !('roles.comingSoon' in TABLES.en), 'i18n: roles.usedFor.plan|check|lookup in en/vi/zh; the "Coming soon" keys are gone');
}

console.log(`\n${pass} passed, ${fail} failed`);
console.log(fail ? `FAIL check-role-models — ${fail} failed` : `PASS check-role-models — ${pass}/${pass} assertions passed`);
process.exit(fail ? 1 : 0);
