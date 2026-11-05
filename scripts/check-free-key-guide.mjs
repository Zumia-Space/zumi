// check:free-key-guide (T-31, owner 05-11): the first-run "add a key" step offers three routes as cards (OpenCode recommended,
// OpenRouter, Google AI Studio) with numbered steps, a cost label that matches the provider table, and a Guide panel.
//   1. the route table agrees with the real provider table (model = what is sent, key URL = the host-opened URL, cost label truthful);
//   2. the recommended default is OpenCode + deepseek-v4.1-flash, labelled paid (OpenCode docs: the free id works only in the OpenCode app);
//   3. choosing a card sets mode + provider through zumi.ai (mocked) and nothing else;
//   4. a pasted key goes through brainKey.save only (the provider's list-models test, no generation) and is never echoed;
//   5. the panel builds three cards + Guide wiring, in en / vi / zh, with no key in the DOM after Save.
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
let pass = 0, fail = 0;
const ok = (c, name, detail = '') => { if (c) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); } };

const routes = require('../src/main/free-key-routes.js');
const { PROVIDERS } = require('../src/main/providers.js');
const { TABLES } = await import('../src/renderer/i18n.js');

// 1 + 2: the table
const R = routes.ROUTES;
const byId = (id) => R.find((r) => r.id === id);
ok(R.length >= 6 && ['google', 'nvidia', 'groq', 'cerebras', 'openrouter', 'opencode'].every((id) => byId(id)), 'six routes: google, nvidia, groq, cerebras, openrouter, opencode');
const rec = R.filter((r) => r.recommended);
ok(rec.length === 1 && rec[0].id === 'google' && rec[0].cost === 'free', 'the single Recommended route is a truly free one (Google AI Studio)');
ok(R.filter((r) => r.recommended).every((r) => r.cost === 'free'), 'Recommended never sits on a paid route');
ok(byId('opencode').bestValue === true && byId('opencode').cost === 'paid' && R.filter((r) => r.bestValue).length === 1, 'OpenCode is the single "Best value" route and is labelled paid');
ok(byId('opencode').model === 'deepseek-v4.1-flash', 'OpenCode model = deepseek-v4.1-flash (paid id; the free id is app-only)');
ok(byId('nvidia').model === 'deepseek-ai/deepseek-v4.1-flash' && byId('cerebras').model === 'gpt-oss-120b' && byId('groq').model === 'openai/gpt-oss-120b', 'model ids are the ones the docs / model lists show');
ok(R.every((r) => /^https:\/\//.test(r.limitsUrl)), 'every route names the official limits / terms page');
ok(PROVIDERS.nvidia.baseURL === 'https://integrate.api.nvidia.com/v1' && PROVIDERS.cerebras.baseURL === 'https://api.cerebras.ai/v1', 'NVIDIA and Cerebras use their documented fixed base URLs');
ok(PROVIDERS.nvidia.keyShape.test('nvapi-' + 'a'.repeat(40)) && !PROVIDERS.nvidia.keyShape.test('csk-' + 'a'.repeat(40)) && PROVIDERS.cerebras.keyShape.test('csk-' + 'a'.repeat(40)) && !PROVIDERS.opencode.keyShape.test('nvapi-' + 'a'.repeat(40)), 'key shapes: each vendor accepts its own prefix, OpenCode rejects the new vendors');
for (const r of R) {
  const p = PROVIDERS[r.providerId];
  ok(Boolean(p), `${r.id}: provider ${r.providerId} exists in the provider table (the app can call it)`);
  ok(p && p.models.do === r.model, `${r.id}: recommended model ${r.model} is the model the provider sends for chat`);
  ok(p && /^https:\/\//.test(p.keyPageURL) && r.signupUrl === p.keyPageURL, `${r.id}: sign-up URL is the provider's key page`);
  ok(r.cost === 'free' || r.cost === 'paid', `${r.id}: cost label is free or paid`);
  ok(r.cost === 'paid' ? !require('../src/main/providers.js').FREE_PROVIDER_IDS.includes(r.providerId) : require('../src/main/providers.js').FREE_PROVIDER_IDS.includes(r.providerId), `${r.id}: cost label agrees with the provider's free/paid list (free routes are the ones Settings lists under free)`);
  const keys = routes.routeKeys(r);
  for (const loc of ['en', 'vi', 'zh']) ok(keys.length >= 6 && keys.every((k) => TABLES[loc][k]), `${r.id}: ${loc} has all ${keys.length} copy keys`);
}
ok(!R.some((r) => r.providerId === 'opencode-go'), 'the owner-only Go provider is not offered');

// 3: card choice -> settings
const calls = [];
const zumi = {
  ai: {
    setMode: async (m) => { calls.push(['setMode', m]); return { ok: true, mode: m }; },
    setProvider: async (id) => { calls.push(['setProvider', id]); return { ok: true, id }; },
  },
};
const chosen = await routes.chooseRoute(zumi, 'opencode');
ok(chosen.ok && JSON.stringify(calls) === JSON.stringify([['setMode', 'byok'], ['setProvider', 'opencode']]), 'choose opencode -> mode byok, provider opencode', JSON.stringify(calls));
calls.length = 0;
await routes.chooseRoute(zumi, 'openrouter');
ok(JSON.stringify(calls) === JSON.stringify([['setMode', 'free'], ['setProvider', 'openrouter']]), 'choose openrouter -> mode free, provider openrouter', JSON.stringify(calls));
calls.length = 0;
await routes.chooseRoute(zumi, 'google');
ok(JSON.stringify(calls) === JSON.stringify([['setMode', 'free'], ['setProvider', 'gemini']]), 'choose google -> mode free, provider gemini', JSON.stringify(calls));
calls.length = 0;
const bad = await routes.chooseRoute(zumi, 'nonsense');
ok(!bad.ok && calls.length === 0, 'unknown route: refused, nothing set');

// 4: key validation path (mocked brainKey): only save()
const saves = [];
const keyZumi = { brainKey: { save: async (raw, confirm) => { saves.push([raw, confirm]); return { ok: true, check: 'works', saved: true, last4: raw.slice(-4) }; } } };
const out = await routes.saveRouteKey(keyZumi, '  secret-test-key-0000  ');
ok(out.ok && out.line === 'works' && saves.length === 1 && saves[0][0] === 'secret-test-key-0000' && saves[0][1] === false, 'save goes through brainKey.save (trimmed, no unreachable override)');
ok(!JSON.stringify(out).includes('secret-test-key'), 'the result carries no key text');
const rej = await routes.saveRouteKey({ brainKey: { save: async () => ({ ok: false, error: 'rejected' }) } }, 'x'.repeat(30));
ok(!rej.ok && rej.line === 'rejected', 'a refused key -> rejected line');
const bf = await routes.saveRouteKey({ brainKey: { save: async () => ({ ok: false, error: 'bad_format' }) } }, 'short');
ok(!bf.ok && bf.line === 'bad_format', 'bad shape -> bad_format line');
const un = await routes.saveRouteKey({ brainKey: { save: async () => ({ ok: false, error: 'unreachable', needsConfirm: true }) } }, 'y'.repeat(30));
ok(!un.ok && un.line === 'unreachable', 'provider unreachable -> unreachable line (not saved)');
const empty = await routes.saveRouteKey(keyZumi, '   ');
ok(!empty.ok && empty.line === 'bad_format' && saves.length === 1, 'blank input never reaches the host');

// 5: the panel on a stub DOM
class El {
  constructor(tag) { this.tag = tag; this.children = []; this.text = ''; this.dataset = {}; this.attrs = {}; this.listeners = {}; this.parent = null; this.hidden = false; this.className = ''; this.value = ''; this.id = ''; this.disabled = false; }
  set textContent(v) { for (const c of this.children) c.parent = null; this.children = []; this.text = String(v); }
  get textContent() { return this.text + this.children.map((c) => c.textContent).join(''); }
  append(...n) { for (const c of n) this.appendChild(c); }
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  addEventListener(n, f) { (this.listeners[n] ||= []).push(f); }
  async click() { for (const f of this.listeners.click || []) await f({ preventDefault() {} }); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  focus() {}
  all(pred, out = []) { if (pred(this)) out.push(this); for (const c of this.children) c.all(pred, out); return out; }
}
const bodyEl = new El('body');
globalThis.document = { body: bodyEl, documentElement: new El('html'), createElement: (t) => new El(t), addEventListener() {}, querySelectorAll: () => [] };
globalThis.window = globalThis;
const { setLocale } = await import('../src/renderer/i18n.js');
const { initFreeKeyGuide } = await import('../src/renderer/free-key-guide.js');
const panelZumi = { ai: zumi.ai, brainKey: { save: async (raw) => ({ ok: true, check: 'works', saved: true, last4: raw.slice(-4) }) } };
calls.length = 0;
const guide = initFreeKeyGuide({ zumi: panelZumi, doc: document });
const panel = bodyEl.all((e) => e.id === 'free-key-panel')[0];
ok(Boolean(panel) && panel.hidden === true, 'panel exists and starts hidden');
guide.open();
ok(panel.hidden === false, 'open() shows the panel');
const cards = panel.all((e) => e.className.split(' ').includes('fk-card'));
ok(cards.length === 6, 'six route rows');
const groups = panel.all((e) => e.className === 'fk-group-list');
ok(groups.length === 2 && groups[0].children.length === 5 && groups[1].children.length === 1, 'grouped list: 5 free rows, 1 paid row');
const titles = panel.all((e) => e.className === 'fk-group').map((e) => e.textContent);
ok(titles.join() === 'Free,Paid', 'group titles Free / Paid', titles.join());
ok(/Recommended/.test(cards[0].textContent) && /Google AI Studio/.test(cards[0].textContent) && /Free/.test(cards[0].textContent), 'row 1: Google AI Studio, Recommended, Free');
ok(/Fast, an official free tier/.test(cards[0].textContent), 'the Recommended row states why');
const paid = cards[5];
ok(/Best value · Paid/.test(paid.textContent) && paid.textContent.includes('deepseek-v4.1-flash') && !/Recommended/.test(paid.textContent), 'OpenCode row: "Best value · Paid", model id, not Recommended');
const body = (c) => c.all((e) => e.className === 'fk-body')[0];
ok(body(cards[0]).hidden === false && cards.slice(1).every((c) => body(c).hidden === true), 'only the Recommended row starts expanded');
await cards[5].all((e) => e.dataset.act === 'toggle')[0].click();
ok(body(cards[5]).hidden === false, 'clicking a row header expands it');
await cards[5].all((e) => e.dataset.act === 'toggle')[0].click();
ok(body(cards[5]).hidden === true, 'and collapses it again');
for (const c of cards.slice(1, 5)) await c.all((e) => e.dataset.act === 'toggle')[0].click();
ok(cards.every((c) => c.all((e) => e.tag === 'ol')[0].children.length >= 4), 'each card has numbered steps (>= 4)');
ok(cards.every((c) => /https:\/\//.test(c.textContent)), 'each card shows its official sign-up URL');
await cards[5].all((e) => e.dataset.act === 'toggle')[0].click();
ok(/fast and smart enough for background work/i.test(cards[5].textContent), "owner's reason line on the Best value card");
await cards[0].all((e) => e.dataset.act === 'choose')[0].click();
ok(JSON.stringify(calls) === JSON.stringify([['setMode', 'free'], ['setProvider', 'gemini']]), 'clicking a card button selects provider + mode', JSON.stringify(calls));
const field = cards[0].all((e) => e.tag === 'input')[0];
ok(field && field.attrs.type === 'password' && field.attrs.autocomplete === 'off', 'key field is a password field, autocomplete off');
field.value = 'AIza' + 'z'.repeat(35);
await cards[0].all((e) => e.dataset.act === 'save')[0].click();
ok(field.value === '', 'field emptied after Save');
ok(!bodyEl.textContent.includes('AIzazzzz'), 'the key text appears nowhere in the DOM');
ok(/works/i.test(cards[0].all((e) => e.dataset.role === 'line')[0].textContent), 'result line says the key works');
for (const loc of ['vi', 'zh']) { setLocale(loc); guide.repaint(); ok(panel.textContent.length > 0 && !/freeKey\./.test(panel.textContent), `${loc}: no raw keys in the panel`); }
setLocale('en');
guide.close();
ok(panel.hidden === true, 'close() hides the panel');

// wiring
const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
ok(/initFreeKeyGuide\(/.test(read('src/renderer/app.js')), 'app.js starts the guide');
ok(/free-key-open/.test(read('src/renderer/index.html')), 'Settings > AI has a Guide button');
ok(/openGuide/.test(read('src/renderer/key-guide.js')), 'first-run key card has a Guide button');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
