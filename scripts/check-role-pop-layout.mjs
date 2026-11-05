#!/usr/bin/env node
// check:role-pop-layout (T-31 alpha.14). Owner 02-11. The Usage card painted over the model picker.
// Two parts:
//   1. Node, no network: what each provider really sends (stubbed fetch) must match what the card is told it can do, so the text cannot drift
//      from the request body. Wiring in main.js and chat-host.mjs is a source regex, named as such in its row.
//   2. Chromium (Playwright), the built renderer (npm run build:renderer runs first), stub bridge, real resolveRoles and the real provider table:
//      geometry and hit test at 1680x987, 1366x768, 900x600, for all four chips, with the chip high in the window and with it near the bottom:
//      elementFromPoint at each model row, the search box, each effort button and Done returns that control; the picker stays inside the window.
//   node scripts/check-role-pop-layout.mjs [--shots <dir> --label <name>]
// Not the Tauri window. No key, no model call, no paid call.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ownerPath } from './lib/owner-paths.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(ROOT, 'package.json'));
const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const shotsDir = opt('--shots') ? path.resolve(opt('--shots')) : null;
const label = opt('--label') || 'after';
const SIZES = [[1680, 987], [1366, 768], [900, 600]];
const ROLES = ['plan', 'do', 'check', 'lookup'];
let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`); } };

const { PROVIDERS } = req('./src/main/providers.js');
const { streamChat } = req('./src/main/chat-brain.js');
const { resolveRoles, setRoleChoice, resetRoleChoice, setRoleOn } = req('./src/main/role-models.js');

// ---------- part 1: the table against the request body ----------
const WEB = [{ id: 'web' }];
for (const [id, p] of Object.entries(PROVIDERS)) {
  let body = null;
  const fetchImpl = async (_u, o) => { body = JSON.parse(o.body); throw new Error('stub: stop after the request'); };
  const model = id === 'gemini' ? 'gemini-3.8-flash' : p.models.do;
  await streamChat([{ role: 'user', content: 'x' }], 'stub-not-a-key', { fetchImpl, model, provider: p, plugins: WEB, routing: { provider: null, reasoningOff: true, effort: 'high', effortOk: true } }).catch(() => {});
  ok(body && Boolean(body.plugins) === Boolean(p.webSearch), `${id}: the web plugin is sent exactly when the table says webSearch`, { plugins: body && body.plugins, webSearch: p.webSearch });
  ok(body && Boolean(body.reasoning || body.reasoning_effort) === Boolean(p.sendsEffort), `${id}: an effort field is sent exactly when the table says sendsEffort`, { keys: body && Object.keys(body), sendsEffort: p.sendsEffort });
}
for (const f of ['src/main/main.js', 'tauri/sidecar/chat-host.mjs']) {
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  ok(/caps: \{ webSearch: Boolean\(chatBrain\.provider\.webSearch\), effort: Boolean\(chatBrain\.provider\.sendsEffort\) \}/.test(src) && /provider: \{ label: p\.label, \.\.\.p\.caps \}/.test(src), `${f}: rolesView carries the live provider's capabilities (source regex)`);
}

// ---------- part 2: the page ----------
execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-renderer.mjs')], { cwd: ROOT, stdio: 'ignore', timeout: 300000 });
const { chromium } = req(process.env.ZUMI_PLAYWRIGHT_DIR || ownerPath('playwrightDir', 'node_modules/playwright'));
const EXE = process.env.ZUMI_CHROMIUM || ownerPath('chromiumExe', 'local/chrome.exe');
const sharp = req('sharp');
const BUILD = path.join(ROOT, 'build', 'renderer');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png' };
const server = http.createServer((q, s) => {
  const p = decodeURIComponent(new URL(q.url, 'http://x').pathname);
  const file = p === '/tokens.css' ? path.join(ROOT, 'vendor', 'laneboard', 'public', 'tokens.css') : path.join(BUILD, p === '/' ? 'index.html' : p);
  if (!path.resolve(file).startsWith(path.resolve(ROOT))) { s.writeHead(403); return s.end(); }
  fs.readFile(file, (e, buf) => { if (e) { s.writeHead(404); return s.end(); } s.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' }); s.end(buf); });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

const STUB = `(() => {
  const deep = () => new Proxy(function () {}, { get: (t, k) => (k === 'then' ? undefined : k === Symbol.toPrimitive ? () => '' : deep()), apply: () => Promise.resolve(deep()) });
  const withFallback = (o) => new Proxy(o, { get: (t, k) => (k in t ? t[k] : (k === 'then' || k === 'memory' ? undefined : deep())) });
  const info = { version: 'check', packaged: true, disabledViews: [], ownerAdmin: true, boardPartition: 'b', boardLivePartition: 'bl', demo: false, selftest: false, minWindow: { width: 900, height: 600 } };
  window.zumi = withFallback({ info: async () => info, listModels: async () => ({ models: [], selected: null, bundledCount: 0 }), listClips: async () => [],
    rooms: withFallback({ list: async () => ({ rooms: [], selected: null }) }), scenes: withFallback({ list: async () => ({ rooms: [], selected: null }) }),
    chairs: withFallback({ list: async () => ({ chairs: [], selected: null }) }),
    ui: withFallback({ getLang: async () => window.__uiLang, setLang: async () => {}, getDevTools: async () => false }),
    board: withFallback({ status: async () => ({ configured: false, mode: 'local' }), state: async () => ({ ok: false, reason: 'unconfigured' }) }),
    hud: withFallback({ getPrefs: async () => ({ style: 'a', voiceMuted: false }), setPrefs: async (p) => p, ready: async () => true, onFeed: () => () => {} }),
    roles: { get: () => window.__roles('get'), models: () => window.__roles('models'), set: (r, c) => window.__roles('set', r, c), reset: (r) => window.__roles('reset', r), setOn: (r, on) => window.__roles('setOn', r, on) } });
  HTMLElement.prototype.loadURL = function () { return Promise.resolve(); };
})();`;

const SCENES = {
  // His screen: OpenCode, one model. The table's own capabilities, shaped as rolesView shapes them.
  opencode: { id: 'opencode', models: [{ id: PROVIDERS.opencode.models.do, name: PROVIDERS.opencode.models.do, reasoning: null }] },
  // A long list: the rows must scroll inside the picker.
  openrouter: { id: 'openrouter', models: Array.from({ length: 40 }, (_, i) => ({ id: `vendor/model-${String(i).padStart(2, '0')}`, name: `Vendor: Model ${String(i).padStart(2, '0')}`, reasoning: true })) },
};

const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], timeout: 60000 });

async function openCard(w, h, sceneName, lang = 'en') {
  const scene = SCENES[sceneName];
  const table = PROVIDERS[scene.id];
  let stored = {};
  const sets = [];
  const view = () => ({ provider: { label: table.label, webSearch: Boolean(table.webSearch), effort: Boolean(table.sendsEffort) }, ...resolveRoles(stored, scene.models[0].id, scene.models, { ...table.models, plan: scene.models[0].id, do: scene.models[0].id, check: scene.models[0].id, lookup: scene.models[0].id }), wired: { plan: 'plan', do: 'chat', check: 'check', lookup: 'lookup' } });
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message).split('\n')[0]));
  await page.exposeFunction('__roles', (name, a, b) => {
    if (name === 'get') return view();
    if (name === 'models') return { ok: true, models: scene.models };
    const r = name === 'set' ? setRoleChoice(stored, a, b) : name === 'reset' ? resetRoleChoice(stored, a) : setRoleOn(stored, a, b);
    if (!r.ok) return r;
    stored = r.next; sets.push([name, a, b]);
    return { ok: true, ...view() };
  });
  await page.addInitScript(`window.__uiLang = ${JSON.stringify(lang)};`);
  await page.addInitScript(STUB);
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load' });
  // The app wires its tabs after its boot awaits settle: click until the panel answers.
  for (let i = 0; i < 40 && !(await page.locator('#tab-settings.active').count()); i++) { await page.click('.tab[data-tab="settings"]'); await page.waitForTimeout(250); }
  await page.click('#stab-ai');
  await page.waitForSelector('#roles-grid .role-chip', { timeout: 10000 });
  await page.evaluate(() => { document.querySelector('.update-pill')?.remove(); });
  return { page, errors, sets };
}

// Puts a chip high in the window, or near its bottom edge. Returns where it landed.
const moveChip = (page, role, where) => page.evaluate(([r, at]) => {
  const scroller = document.querySelector('#tab-settings .settings');
  const chip = document.querySelector(`#roles-grid .role-chip[data-role="${r}"]`);
  const box = scroller.getBoundingClientRect();
  const a = chip.getBoundingClientRect();
  scroller.scrollTop += at === 'high' ? a.top - box.top - 12 : a.bottom - box.bottom + 8;
  const b = chip.getBoundingClientRect();
  return { top: b.top, bottom: b.bottom, boxTop: box.top, boxBottom: box.bottom };
}, [role, where]);

// Every control in the open picker: inside the window, and the hit test at its centre lands on it. Rows are scrolled into view first.
const probe = (page) => page.evaluate(() => {
  const pop = document.querySelector('.role-pop');
  if (!pop) return { open: false };
  const inWindow = (r) => r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight && r.width > 0 && r.height > 0;
  const hit = (n) => {
    n.scrollIntoView({ block: 'nearest' });
    const r = n.getBoundingClientRect();
    const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { hit: Boolean(e) && (e === n || n.contains(e)), inside: inWindow(r), at: e ? (e.className || e.tagName) : null };
  };
  const list = pop.querySelector('.pop-list');
  const rows = [...pop.querySelectorAll('.pop-list button')].map(hit);
  const others = [pop.querySelector('input[type="search"]'), ...pop.querySelectorAll('.lang-switch button'), ...pop.querySelectorAll('.pop-foot button:not(:disabled)')].map(hit);
  list.scrollTop = 0; pop.scrollTop = 0;
  const r = pop.getBoundingClientRect();
  return { open: true, rows, others, inside: inWindow(r), rect: { top: r.top, bottom: r.bottom, left: r.left, right: r.right }, listScrolls: list.scrollHeight > list.clientHeight, hint: pop.querySelector('.pop-hint').textContent, hints: [...pop.querySelectorAll('.pop-hint')].filter((n) => !n.hidden).map((n) => n.textContent), head: pop.querySelector('.pop-head .muted').textContent, text: pop.textContent };
});
const allGood = (arr) => arr.length > 0 && arr.every((x) => x.hit && x.inside);
const bad = (arr) => arr.filter((x) => !x.hit || !x.inside).slice(0, 3);

async function shot(page, name, w) {
  if (!shotsDir) return;
  fs.mkdirSync(shotsDir, { recursive: true });
  const png = await page.screenshot();
  const file = path.join(shotsDir, `${name}-${label}.png`);
  if (w > 1600) await sharp(png).resize({ width: 1600 }).toFile(file); else fs.writeFileSync(file, png);
}

for (const [w, h] of SIZES) {
  const size = `${w}x${h}`;
  for (const sceneName of Object.keys(SCENES)) {
    const { page, errors, sets } = await openCard(w, h, sceneName);
    for (const where of ['high', 'low']) {
      for (const role of ROLES) {
        const at = await moveChip(page, role, where);
        await page.click(`#roles-grid .role-chip[data-role="${role}"]`);
        await page.waitForTimeout(120);
        const p = await probe(page);
        const tag = `${size} ${sceneName} ${role} chip ${where}`;
        ok(p.open && allGood(p.rows), `${tag}: every model row is on top and inside the window (${p.rows ? p.rows.length : 0})`, p.rows ? bad(p.rows) : p);
        ok(p.open && allGood(p.others), `${tag}: search, effort and footer controls are on top and inside the window`, p.others ? bad(p.others) : p);
        ok(p.open && p.inside, `${tag}: the picker stays inside the window`, p.rect);
        if (where === 'low' && h - at.bottom < (p.rect ? p.rect.bottom - p.rect.top : 0)) ok(p.open && p.rect.bottom <= at.top, `${tag}: no room below, so it opens above the chip`, { rect: p.rect, chip: at });
        if (role === 'lookup' && sceneName === 'opencode' && where === 'high') await shot(page, `picker-lookup-opencode-${size}`, w);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(40);
      }
    }
    if (sceneName === 'openrouter') {
      await moveChip(page, 'do', 'high');
      await page.click('#roles-grid .role-chip[data-role="do"]');
      await page.waitForTimeout(120);
      await shot(page, `picker-long-list-${size}`, w);
      // A real mouse click on a row far down the list: the owner's actual failure.
      const target = await page.evaluate(() => {
        const list = document.querySelector('.role-pop .pop-list');
        const before = list.scrollTop;
        const b = [...list.querySelectorAll('button')].find((x) => x.title === 'Vendor: Model 30');
        b.scrollIntoView({ block: 'nearest' });
        const r = b.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, scrolled: list.scrollTop > before, listScrolls: list.scrollHeight > list.clientHeight };
      });
      ok(target.listScrolls && target.scrolled, `${size}: a long list scrolls inside the picker`, target);
      await page.waitForTimeout(80);
      ok(await page.locator('.role-pop').count() === 1, `${size}: scrolling the list leaves the picker open`);
      await page.mouse.click(target.x, target.y);
      await page.waitForTimeout(120);
      ok(sets.some((s) => s[0] === 'set' && s[1] === 'do' && s[2].model === 'vendor/model-30'), `${size}: a mouse click on a row saves that model`, sets);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(40);

      // The panel scrolls under an open picker: it follows the chip, and closes once the chip has left the scroll box.
      await moveChip(page, 'do', 'high');
      await page.click('#roles-grid .role-chip[data-role="do"]');
      await page.waitForTimeout(120);
      const follow = await page.evaluate(async () => {
        const scroller = document.querySelector('#tab-settings .settings');
        const chip = document.querySelector('#roles-grid .role-chip[data-role="do"]');
        const gap = () => document.querySelector('.role-pop').getBoundingClientRect().top - chip.getBoundingClientRect().bottom;
        const g0 = gap();
        scroller.scrollTop -= 30;
        await new Promise((r) => setTimeout(r, 500)); // the scroll event comes with a frame, late on a busy machine
        const g1 = gap();
        const r1 = document.querySelector('.role-pop').getBoundingClientRect();
        const inside1 = r1.top >= 0 && r1.bottom <= innerHeight;
        scroller.scrollTop += 2000;
        await new Promise((r) => setTimeout(r, 80));
        return { g0, g1, inside1, open: Boolean(document.querySelector('.role-pop')), chipGone: chip.isConnected && chip.getBoundingClientRect().bottom < scroller.getBoundingClientRect().top };
      });
      // At 900x600 the moved chip can leave no room on either side: the picker is then pinned inside the window (the "inside" rows above), not at the gap.
      ok(h < 768 ? follow.inside1 : Math.abs(follow.g0 - follow.g1) <= 1, `${size}: the picker follows its chip when the panel scrolls`, follow);
      ok(!follow.chipGone || !follow.open, `${size}: the picker closes once its chip has scrolled away`, follow);

      // Leaving the panel without a click (keyboard view switch): nothing may stay on top of the other view.
      await moveChip(page, 'do', 'high');
      await page.click('#roles-grid .role-chip[data-role="do"]');
      await page.waitForTimeout(120);
      await page.evaluate(() => { document.getElementById('stabpanel-ai').hidden = true; });
      await page.waitForTimeout(120);
      ok(await page.locator('.role-pop').count() === 0, `${size}: the picker closes when its panel is hidden`);
    }
    ok(errors.length === 0, `${size} ${sceneName}: no page errors`, errors);
    await page.close();
  }

  // The other overlays on these screens. Not this component: audited so the same fault cannot sit there unseen.
  const { page } = await openCard(w, h, 'opencode');
  await page.click('.tab[data-next="brain"]').catch(() => {});
  await page.waitForTimeout(300);
  const modal = await page.evaluate(() => {
    const host = [...document.querySelectorAll('.frame')].find((c) => c.querySelector('.nb-tabs') && c.getClientRects().length);
    if (!host) return null;
    const m = document.createElement('div'); m.className = 'nb-soul-modal'; host.appendChild(m);
    const pts = [[8, 8], [innerWidth - 8, 8], [8, innerHeight - 8], [innerWidth - 8, innerHeight - 8], [innerWidth / 2, innerHeight / 2]];
    const hits = pts.map(([x, y]) => document.elementFromPoint(x, y) === m);
    m.remove();
    return hits;
  });
  ok(modal && modal.every(Boolean), `${size}: Brain's confirm layer, hosted in its card, covers the whole window`, modal);
  await page.close();
}

// ---------- provider truth in the rendered text, all three languages ----------
const FEE = /\$0\.007/;
for (const [lang, noWebWord] of [['en', 'OpenCode'], ['vi', 'OpenCode'], ['zh', 'OpenCode']]) {
  const a = await openCard(1366, 768, 'opencode', lang);
  await a.page.click('#roles-grid .role-chip[data-role="lookup"]');
  await a.page.waitForTimeout(120);
  const p = await probe(a.page);
  const cell = await a.page.evaluate(() => document.querySelector('.role-cell[data-role="lookup"] .desc').textContent);
  ok(p.open && !FEE.test(p.text), `${lang} OpenCode: no $0.007 anywhere in the Look up picker`, p.hint);
  ok(p.open && p.hint.includes(noWebWord), `${lang} OpenCode: the picker names the provider that has no web search`, p.hint);
  ok(cell !== { en: 'Searches the web for a reply', vi: 'Tìm trên web để trả lời', zh: '为回复搜索网络' }[lang], `${lang} OpenCode: the card does not say Look up searches the web`, cell);
  ok(p.open && p.hints.length === 2 && p.hints[1].includes(noWebWord), `${lang} OpenCode: the effort line says this provider gets no thinking setting`, p.hints);
  await a.page.close();
  const b = await openCard(1366, 768, 'openrouter', lang);
  await b.page.click('#roles-grid .role-chip[data-role="lookup"]');
  await b.page.waitForTimeout(120);
  const q = await probe(b.page);
  ok(q.open && FEE.test(q.hint), `${lang} OpenRouter: the $0.007 line stays, it is true there`, q.hint);
  await b.page.close();
}

await browser.close();
server.close();
console.log(`\ncheck:role-pop-layout: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
