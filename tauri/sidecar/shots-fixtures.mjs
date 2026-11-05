// T-31 parity step 12-1: the `--settings-shots` fixtures (main.js `shotsFixtures` / `shotsRoleModels` /
// `shotsChatFetch` / `shotsProviderFetch` / `shotsVoiceState`), hosted in the sidecar.
//
// The shots run drives Settings through its real controls: it saves a fake key, reads the Models-by-role card, and
// sends chat turns. Every one of those goes through the REAL step-6 seams (brainKey, chat-brain, role-models), so the
// only thing that changes is the endpoint they call: `chatFetch` answers a chat completion, `providerFetch` answers
// the key check. The fixture file is read only when a shots mode is on; a normal launch never loads it.
//
// These values never leave a shots run: the mode comes from --settings-shots (CLI only), and `shots.rolesProvider` /
// `shots.voiceState` are refused outside it.
import fs from 'node:fs';
import path from 'node:path';

const DOWNLOADING = { state: 'downloading', phase: 'model', loaded: 64, total: 100, error: null };

export function createShotsFixtures({ repoRoot, log = () => {} }) {
  let roleMode = 'on'; // 'on' | 'one' (a one-model provider) | 'off' (none configured)
  let voiceState = { ...DOWNLOADING };
  let fixture = null;

  const load = () => {
    if (fixture) return fixture;
    try { fixture = JSON.parse(fs.readFileSync(path.join(repoRoot, 'src', 'main', 'role-models-fixtures.json'), 'utf8')); } catch (e) {
      log(`shots fixture unreadable: ${(e && e.message) || e}`);
      fixture = null;
    }
    return fixture;
  };

  // main.js shotsRoleModels: the list in the current mode, null when off / unreadable.
  const roleModels = () => {
    const f = load();
    if (!f || roleMode === 'off') return null;
    return roleMode === 'one' ? f.models.filter((m) => m.id === f.defaultModel) : f.models;
  };

  // A fake provider CHAT endpoint (role-models-fixtures.json `chat`), so the settings shots run Plan / Do / Check /
  // Look up through the real chat-brain path with no real call. Ported from main.js shotsChatFetch.
  const chatFetch = (url, opts) => {
    const f = load();
    const body = JSON.parse(String((opts && opts.body) || '{}'));
    if (!f || new URL(url).pathname !== '/api/v1/chat/completions' || !Array.isArray(body.messages)) return Promise.reject(new Error('shots fixture: not a chat call'));
    const c = f.chat;
    const system = String(body.messages[0].content);
    const user = String(body.messages[body.messages.length - 1].content);
    const usage = { prompt_tokens: 180, completion_tokens: 45, total_tokens: 225 };
    const pick = (list) => list.find((r) => user.includes(r.when)).text;
    if (!body.stream) {
      const text = system.startsWith('Write at most 5') ? c.plan : system.startsWith('You review') ? (user.includes(c.checkFix.when) ? c.checkFix.text : 'OK') : pick(c.replies);
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ provider: 'Shots', choices: [{ message: { content: text } }], usage }) });
    }
    const text = body.plugins ? c.lookupReply : pick(c.replies);
    const annotations = body.plugins ? c.sources.map((s) => ({ type: 'url_citation', url_citation: { url: s.url, title: s.title } })) : undefined;
    const sse = (o) => `data: ${JSON.stringify(o)}\n\n`;
    return Promise.resolve({
      ok: true,
      status: 200,
      body: (async function* () {
        for (const piece of text.match(/[\s\S]{1,14}/g)) { await new Promise((r) => setTimeout(r, 25)); yield sse({ provider: 'Shots', choices: [{ delta: { content: piece } }] }); }
        yield sse({ provider: 'Shots', choices: [{ delta: { annotations }, finish_reason: 'stop' }], usage });
        yield 'data: [DONE]\n\n';
      })(),
    });
  };

  // A fake provider endpoint for the key check (main.js shotsProviderFetch): "shots-good" passes, "shots-offline"
  // cannot reach the provider, anything else is refused (401). No key is ever stored or logged by this module.
  const providerFetch = (url, opts) => {
    const auth = String((opts && opts.headers && opts.headers.authorization) || '');
    if (auth.includes('shots-offline')) return Promise.reject(new Error('offline (shots fixture)'));
    const ok = new URL(url).pathname === '/api/v1/key' && auth.includes('shots-good');
    return Promise.resolve({ ok, status: ok ? 200 : 401, json: async () => (ok ? { data: { label: 'shots' } } : { error: { code: 401 } }) });
  };

  // What chat-host's roleProvider reads in a shots run. `list()` is null in 'off' mode; a saved key is still required
  // (Electron's roleProvider hasKey gate), so the "no provider yet" shot before the key is saved stays real.
  const roleFixture = {
    mode: () => roleMode,
    list: () => {
      const models = roleModels();
      if (!models) return null;
      return { provider: load().provider, defaultModel: load().defaultModel, models };
    },
    roleModels: () => roleModels(),
  };

  return {
    roleFixture,
    chatFetch,
    providerFetch,
    setRoleMode(mode) {
      roleMode = ['on', 'one', 'off'].includes(mode) ? mode : 'on';
      return roleMode;
    },
    setVoiceState(state) {
      voiceState = state === 'downloading'
        ? { ...DOWNLOADING }
        : { state: ['ready', 'error', 'off'].includes(state) ? state : 'off', phase: null, loaded: 0, total: 0, error: null };
      return voiceState.state;
    },
    voiceState: () => ({ ...voiceState }),
  };
}
