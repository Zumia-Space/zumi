// T-31 free LLM renderer check, run in its OWN process by scripts/check-tauri-free-llm.mjs.
//
// Why a child process: the sidecar preset layer extends the shared CJS `PROVIDERS` table at import time. A check that
// imported both would let the renderer see Cloudflare/Mistral through that mutation -- the exact false instrument the
// Opus gate (R2) found. This process imports the REAL card and never the sidecar layer, so the Tauri list can only come
// from the `ai.presetList` rpc stub fed by the parent (the sidecar's actual answer).
//
// Input: argv[2] = a JSON file { presets, settings, labels }. Output: one JSON array of { ok, name, detail }.
import fs from 'node:fs';

import { initBrainKey, FREE_LLM_UI } from '../src/renderer/brain-key-card.js';
import { setLocale } from '../src/renderer/i18n.js';

const payload = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const results = [];
const ok = (cond, name, detail = '') => results.push({ ok: Boolean(cond), name, detail: String(detail || '') });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function makeDom() {
  const created = [];
  const makeEl = (tag) => {
    const e = {
      tag: String(tag || 'div').toLowerCase(), id: '', className: '', value: '', hidden: false, disabled: false,
      checked: false, placeholder: '', type: '', children: [], attrs: {}, handlers: {}, parentNode: null,
    };
    let text = '';
    Object.defineProperty(e, 'textContent', { get() { return text; }, set(v) { text = String(v); if (text === '') e.children = []; } });
    Object.defineProperty(e, 'nextSibling', { get() { const p = e.parentNode; if (!p) return null; const i = p.children.indexOf(e); return i < 0 ? null : (p.children[i + 1] || null); } });
    e.appendChild = (c) => { c.parentNode = e; e.children.push(c); return c; };
    e.insertBefore = (c, ref) => { c.parentNode = e; const i = ref ? e.children.indexOf(ref) : -1; if (i < 0) e.children.push(c); else e.children.splice(i, 0, c); return c; };
    e.setAttribute = (k, v) => { e.attrs[k] = v; };
    e.getAttribute = (k) => (Object.prototype.hasOwnProperty.call(e.attrs, k) ? e.attrs[k] : null);
    e.addEventListener = (ev, fn) => { (e.handlers[ev] = e.handlers[ev] || []).push(fn); };
    e.focus = () => {};
    created.push(e);
    return e;
  };
  const root = makeEl('div');
  const byId = (id) => created.find((e) => e.id === id) || null;
  const $ = (id) => byId(id) || (() => { const el = makeEl('div'); el.id = id; root.appendChild(el); return el; })();
  return { created, root, byId, $, makeEl };
}
const SNAP = (e) => ({ id: e.id, tag: e.tag, cls: e.className, hidden: e.hidden === true, text: e.textContent, checked: e.checked === true, type: e.type, value: e.value, placeholder: e.placeholder, children: e.children.map(SNAP) });
const CLICK = async (e) => { for (const fn of e.handlers.click || []) await fn(); };
const CHANGE = async (e) => { for (const fn of e.handlers.change || []) await fn(); };
const optionsOf = (select) => {
  const out = [];
  const walk = (node, group) => { for (const c of node.children || []) { if (c.tag === 'option') out.push({ value: c.value, text: c.textContent, group }); else if (c.tag === 'optgroup') walk(c, c.getAttribute('label')); } };
  walk(select, null);
  return out;
};

const globals = { window: globalThis.window, document: globalThis.document, CustomEvent: globalThis.CustomEvent };
async function runCard({ tauri, provider, locale = 'en', settings, mode = 'free' }) {
  const dom = makeDom();
  globalThis.window = tauri ? { __TAURI__: {} } : {};
  globalThis.document = { createElement: (tag) => dom.makeEl(tag), dispatchEvent: () => true };
  globalThis.CustomEvent = class { constructor(type) { this.type = type; } };
  const state = { provider, mode, saves: [], settings, setCalls: [], opened: [] };
  const settingsView = () => ({ cloudflareAccountId: typeof state.settings.cloudflareAccountId === 'string' ? state.settings.cloudflareAccountId : null, age18Confirmed: state.settings.age18Confirmed === true });
  const ai = {
    provider: async () => ({ id: state.provider, label: (payload.labels && payload.labels[state.provider]) || state.provider, mode: state.mode }),
    setProvider: async (id) => { state.provider = id; return { ok: true, id, label: (payload.labels && payload.labels[id]) || id }; },
    setMode: async (m) => { state.mode = m; return { ok: true, mode: m }; },
    setPresetSettings: async (patch) => {
      state.setCalls.push(patch);
      const keys = Object.keys(patch || {});
      if (!keys.length) return { ok: false, error: 'bad_settings' };
      for (const k of keys) if (k !== 'cloudflareAccountId' && k !== 'age18Confirmed') return { ok: false, error: 'bad_field', field: k };
      if ('cloudflareAccountId' in patch && patch.cloudflareAccountId !== '' && patch.cloudflareAccountId !== null && !/^[0-9a-f]{32}$/i.test(patch.cloudflareAccountId)) return { ok: false, error: 'bad_cloudflare_account_id' };
      if ('age18Confirmed' in patch && typeof patch.age18Confirmed !== 'boolean') return { ok: false, error: 'bad_age18' };
      const next = { ...patch };
      if ('cloudflareAccountId' in next && (next.cloudflareAccountId === '' || next.cloudflareAccountId === null)) next.cloudflareAccountId = null;
      Object.assign(state.settings, next);
      return { ok: true, settings: settingsView() };
    },
  };
  if (tauri) ai.presetList = async () => ({ ...payload.presets, settings: settingsView() });
  const zumi = {
    ai,
    brainKey: {
      status: async () => ({ provider: state.provider, saved: false, last4: null, checked: null }),
      save: async (raw, confirm) => { state.saves.push({ length: String(raw).length, confirm: confirm === true }); return { ok: true, saved: true, last4: 'zzzz', checked: 'works' }; },
      test: async () => ({ ok: true, checked: 'works' }),
      clear: async () => ({ ok: true }),
    },
    talk: { openGuide: async (id) => { state.opened.push(id); return false; } },
  };
  setLocale(locale);
  const card = initBrainKey(zumi, dom.$);
  await card.refresh();
  return { card, dom, state };
}

try {
  const fresh = () => ({ age18Confirmed: false, cloudflareAccountId: null });

  // ---- R1: Tauri picker carries the full sidecar list; Electron's does not ----
  {
    const t = await runCard({ tauri: true, provider: 'gemini', settings: fresh() });
    const opts = optionsOf(t.dom.byId('brain-provider'));
    const values = opts.map((o) => o.value);
    ok(values.slice(0, 4).join(',') === 'gemini,groq,openrouter,cloudflare', 'Tauri: the picker offers Gemini, Groq, OpenRouter, Cloudflare in the fixed order', JSON.stringify(values));
    ok(values.includes('cloudflare') && values.includes('mistral'), 'Tauri: the picker contains cloudflare and mistral (advanced)', JSON.stringify(values));
    const mistral = opts.find((o) => o.value === 'mistral');
    ok(Boolean(mistral) && /Advanced/.test(String(mistral.group || '')), 'Tauri: Mistral sits under the Advanced group', JSON.stringify(mistral));
    ok(opts.some((o) => o.value === 'cloudflare' && /Cloudflare Workers AI/.test(o.text)), 'Tauri: Cloudflare is labelled from the sidecar answer');
    const e = await runCard({ tauri: false, provider: 'gemini', settings: fresh() });
    const evals = optionsOf(e.dom.byId('brain-provider')).map((o) => o.value);
    ok(!evals.includes('cloudflare') && !evals.includes('mistral'), 'Electron: the picker list is unchanged (no cloudflare/mistral)', JSON.stringify(evals));
  }

  // ---- R1: the Account ID input appears only for Cloudflare ----
  {
    const cf = await runCard({ tauri: true, provider: 'cloudflare', settings: fresh() });
    ok(cf.dom.byId('brain-free-cf-row').hidden === false && Boolean(cf.dom.byId('brain-free-cf-account')), 'Cloudflare: the Account ID input is shown');
    const gem = await runCard({ tauri: true, provider: 'gemini', settings: fresh() });
    ok(gem.dom.byId('brain-free-cf-row').hidden === true, 'Gemini: the Account ID input is hidden');
    const el = await runCard({ tauri: false, provider: 'gemini', settings: fresh() });
    ok(!el.dom.created.some((c) => /^brain-free-cf/.test(c.id)), 'Electron: no Account ID DOM exists at all');
    cf.dom.byId('brain-free-cf-account').value = '0123456789abcdef0123456789abcdef';
    await CLICK(cf.dom.byId('brain-free-cf-save'));
    ok(cf.state.setCalls.some((p) => p && p.cloudflareAccountId === '0123456789abcdef0123456789abcdef'), 'Cloudflare: Save writes the Account ID through the setter');
    ok(/saved/i.test(cf.dom.byId('brain-free-cf-note').textContent), 'Cloudflare: a successful save is acknowledged');
    cf.dom.byId('brain-free-cf-account').value = '../bad';
    await CLICK(cf.dom.byId('brain-free-cf-save'));
    ok(/32/.test(cf.dom.byId('brain-free-cf-note').textContent), 'Cloudflare: a bad Account ID is refused with the 32-hex hint');
    cf.dom.byId('brain-free-cf-account').value = '';
    await CLICK(cf.dom.byId('brain-free-cf-save'));
    ok(cf.state.setCalls.some((p) => p && p.cloudflareAccountId === '') && cf.state.settings.cloudflareAccountId === null, 'Cloudflare: an empty field clears the Account ID through the setter');
    ok(/saved/i.test(cf.dom.byId('brain-free-cf-note').textContent) && cf.dom.byId('brain-free-cf-account').value === '', 'Cloudflare: a clear is acknowledged and leaves the field empty');
  }

  // ---- S2/C: the 18+ answer goes through the setter, not localStorage ----
  {
    const settings = fresh();
    const t = await runCard({ tauri: true, provider: 'gemini', settings });
    const age = t.dom.byId('brain-free-age18');
    ok(Boolean(age) && t.dom.byId('brain-key-save').disabled === true, 'Gemini: Save is disabled until the 18+ box is ticked');
    ok(t.dom.byId('brain-free-age18-reason').hidden === false && /18 or older/.test(t.dom.byId('brain-free-age18-reason').textContent), 'the confirm shows the one-line Gemini reason');
    // The row must lay out like the other Settings checkboxes: the box and its label are siblings in one row, and the
    // box uses the settings checkbox class (flex:none) instead of the `.line input` stretch that split them apart.
    const ageRow = t.dom.byId('brain-free-age-row');
    const ageLabel = ageRow && ageRow.children.find((c) => c.tag === 'label' && c.getAttribute('for') === 'brain-free-age18');
    ok(Boolean(ageRow) && ageRow.children.includes(age) && Boolean(ageLabel) && ageLabel.parentNode === ageRow,
      'the 18+ checkbox and its label are in the same row', JSON.stringify(ageRow && ageRow.children.map((c) => c.tag)));
    ok(/\bsw\b/.test(String(age && age.className)), 'the 18+ checkbox reuses the settings checkbox class', String(age && age.className));
    const switchBtn = t.dom.byId('brain-free-switch-provider');
    ok(switchBtn.hidden === false, 'the confirm offers a one-click provider switch');
    ok(switchBtn.parentNode && switchBtn.parentNode.className === 'line',
      'the provider switch sits in an inline row (not a full-width grid item)', String(switchBtn.parentNode && switchBtn.parentNode.className));
    await CLICK(switchBtn);
    ok(t.state.provider === 'groq' && t.state.setCalls.length === 0, 'the switch button moves to another provider without confirming');
    // A fresh card (the provider switch above redirected the first one) gives the confirm.
    const again = await runCard({ tauri: true, provider: 'gemini', settings });
    again.dom.byId('brain-key-input').value = 'fake-value-for-dom-test';
    await CLICK(again.dom.byId('brain-key-save'));
    ok(again.state.saves.length === 0, 'a Save click is refused while the 18+ box is unchecked (brainKey.save is never called)');
    ok(again.dom.byId('brain-key-input').value === '', 'T-31 security: a key that cannot be saved (18+ gate closed) does not linger in the field');
    // Typing or pasting while the gate is closed is dropped at once (the Save button is disabled, so nothing else would clear it).
    again.dom.byId('brain-key-input').value = 'fake-typed-while-blocked';
    for (const fn of again.dom.byId('brain-key-input').handlers.input || []) await fn();
    ok(again.dom.byId('brain-key-input').value === '', 'T-31 security: input while the 18+ gate is closed is dropped');
    again.dom.byId('brain-free-age18').checked = true;
    await CHANGE(again.dom.byId('brain-free-age18'));
    ok(again.state.setCalls.some((p) => p && p.age18Confirmed === true), 'ticking the box writes age18Confirmed through the setter');
    ok(again.dom.byId('brain-free-switch-provider').hidden === true, 'ticking the 18+ box hides the provider switch');
    ok(settings.age18Confirmed === true && again.dom.byId('brain-key-save').disabled === false, 'the setting is stored and Save is enabled');
    again.dom.byId('brain-key-input').value = 'fake-value-for-dom-test';
    await CLICK(again.dom.byId('brain-key-save'));
    ok(again.state.saves.length === 1 && again.state.saves[0].length === 'fake-value-for-dom-test'.length, 'after the confirmation the key save goes through');
    const rebuilt = await runCard({ tauri: true, provider: 'gemini', settings });
    ok(rebuilt.dom.byId('brain-free-age18').checked === true && rebuilt.dom.byId('brain-key-save').disabled === false, 'a stored age18Confirmed is applied on the next run');
  }

  // ---- other presets: gates and notes stay per preset ----
  {
    const groq = await runCard({ tauri: true, provider: 'groq', settings: fresh() });
    ok(groq.dom.byId('brain-free-gemini-eea').hidden === true && groq.dom.byId('brain-free-gemini-free').hidden === true, 'Groq renders (A) only, never the Gemini notes');
    ok(groq.dom.byId('brain-free-age-row').hidden === false && groq.dom.byId('brain-key-save').disabled === true, 'Groq keeps the 18+ gate');
    ok(groq.dom.byId('brain-free-switch-provider').hidden === true, 'Groq: no Gemini-only provider switch (the box is unticked)');
    const mistral = await runCard({ tauri: true, provider: 'mistral', settings: fresh() });
    ok(mistral.dom.byId('brain-free-age-row').hidden === true && mistral.dom.byId('brain-notice').hidden === false, 'Mistral is selectable, needs no 18+ confirm, and keeps its own training notice');
    ok(mistral.dom.byId('brain-free-switch-provider').hidden === true, 'Mistral: no provider switch');
  }

  // ---- R3: Gemini shows exactly ONE training line (the qualified one) in BOTH free and BYOK modes ----
  {
    const t = await runCard({ tauri: true, provider: 'gemini', settings: fresh() });
    const notice = t.dom.byId('brain-notice');
    const freeTier = t.dom.byId('brain-free-gemini-free');
    ok(notice.hidden === true && notice.textContent === '', 'Tauri Gemini free: the frozen unqualified training line is hidden');
    ok(freeTier.hidden === false && /^Outside the EEA/.test(freeTier.textContent), 'Tauri Gemini free: the qualified (D) line is the one shown');
    ok([notice, freeTier].filter((e) => e && e.hidden === false).length === 1, 'Tauri Gemini free: exactly one training line is visible');
    const b = await runCard({ tauri: true, provider: 'gemini', settings: fresh(), mode: 'byok' });
    const bNotice = b.dom.byId('brain-notice');
    const bFreeTier = b.dom.byId('brain-free-gemini-free');
    ok(bNotice.hidden === true && bNotice.textContent === '', 'Tauri Gemini byok: the frozen unqualified training line is hidden too');
    ok(bFreeTier.hidden === false && /^Outside the EEA/.test(bFreeTier.textContent), 'Tauri Gemini byok: the qualified (D) line is the one shown');
    ok([bNotice, bFreeTier].filter((e) => e && e.hidden === false).length === 1, 'Tauri Gemini byok: exactly one training line is visible');
    const e = await runCard({ tauri: false, provider: 'gemini', settings: fresh() });
    ok(e.dom.byId('brain-notice').hidden === false && /Free tier/.test(e.dom.byId('brain-notice').textContent), 'Electron Gemini: the frozen notice is unchanged');
    const eByok = await runCard({ tauri: false, provider: 'gemini', settings: fresh(), mode: 'byok' });
    ok(eByok.dom.byId('brain-notice').hidden === false && !eByok.dom.created.some((c) => c.id === 'brain-free-gemini-free'), 'Electron Gemini byok: unchanged (frozen notice only, no free-tier DOM)');
  }

  // ---- the approved slow-tier note is Tauri Gemini only, in the active language ----
  {
    const en = await runCard({ tauri: true, provider: 'gemini', settings: fresh() });
    ok(en.dom.byId('brain-free-gemini-slow').hidden === false && en.dom.byId('brain-free-gemini-slow').textContent === "Gemini's free tier can be slow at busy times; Groq is usually faster.", 'Tauri Gemini: the approved EN slow-tier note is shown verbatim');
    const vi = await runCard({ tauri: true, provider: 'gemini', settings: fresh(), locale: 'vi' });
    ok(vi.dom.byId('brain-free-gemini-slow').textContent === 'Gemini miễn phí có thể chậm vào giờ đông người; Groq thường nhanh hơn.', 'Tauri Gemini: the approved VI slow-tier note is shown verbatim');
    const zh = await runCard({ tauri: true, provider: 'gemini', settings: fresh(), locale: 'zh' });
    ok(zh.dom.byId('brain-free-gemini-slow').textContent === 'Gemini 免费版在高峰时段可能较慢；Groq 通常更快。', 'Tauri Gemini: the approved ZH slow-tier note is shown verbatim');
    const groq = await runCard({ tauri: true, provider: 'groq', settings: fresh() });
    ok(groq.dom.byId('brain-free-gemini-slow').hidden === true && groq.dom.byId('brain-free-gemini-slow').textContent === '', 'Tauri Groq: the Gemini slow-tier note is hidden');
    const electron = await runCard({ tauri: false, provider: 'gemini', settings: fresh() });
    ok(!electron.dom.created.some((c) => c.id === 'brain-free-gemini-slow'), 'Electron: no slow-tier DOM exists at all');
  }

  // ---- the limits line is a link through the fixed-id guide mechanism ----
  {
    const t = await runCard({ tauri: true, provider: 'gemini', settings: fresh() });
    const p = t.dom.byId('brain-free-limits');
    const a = p.children.find((c) => c.tag === 'a');
    ok(Boolean(a) && a.href === FREE_LLM_UI.gemini.limitsUrl && a.textContent.includes(FREE_LLM_UI.gemini.limitsUrl), 'the limits line is a link to the official page', JSON.stringify(a && { href: a.href }));
    if (a) { for (const fn of a.handlers.click || []) await fn({ preventDefault() {} }); }
    ok(t.state.opened.includes('preset-limits-gemini'), 'the link opens through talk.openGuide with a fixed preset-limits id', JSON.stringify(t.state.opened));
  }

  // ---- T-31 security: the key is nowhere on the page after Save (box re-probe 2ef16d1, finding 0) ----
  // Sweep every element of the real card: value (hidden/password included), every attribute (data-* too), text, title.
  {
    const SENTINEL = ['sk-or', 'v1', 'SENTINELkeyMATERIAL', '9'.repeat(16)].join('-');
    const pageHolds = (r) => r.dom.created.flatMap((e) => {
      const fields = { value: e.value, text: e.textContent, placeholder: e.placeholder, id: e.id, cls: e.className, ...Object.fromEntries(Object.entries(e.attrs).map(([k, v]) => ['attr:' + k, v])) };
      return Object.entries(fields).filter(([, v]) => typeof v === 'string' && v.includes(SENTINEL)).map(([k]) => (e.id || e.tag) + '.' + k);
    });
    // (a) Tauri, 18+ gate closed (openrouter needs it): the Save click must not leave the key in the page.
    const closed = await runCard({ tauri: true, provider: 'openrouter', settings: fresh() });
    closed.dom.byId('brain-key-input').value = SENTINEL;
    await CLICK(closed.dom.byId('brain-key-save'));
    ok(pageHolds(closed).length === 0, 'T-31 security: Tauri OpenRouter, gate closed -> the key is in no value/attribute/text of the page after Save', pageHolds(closed).join(','));
    // (b) Tauri, gate open: typed, saved, then absent everywhere.
    const open = await runCard({ tauri: true, provider: 'openrouter', settings: { age18Confirmed: true, cloudflareAccountId: null } });
    open.dom.byId('brain-key-input').value = SENTINEL;
    await CLICK(open.dom.byId('brain-key-save'));
    ok(open.state.saves.length === 1 && pageHolds(open).length === 0, 'T-31 security: Tauri OpenRouter, gate open -> saved, and the key is in no value/attribute/text of the page', pageHolds(open).join(','));
    // (c) Electron: same outcome.
    const el = await runCard({ tauri: false, provider: 'openrouter', settings: fresh() });
    el.dom.byId('brain-key-input').value = SENTINEL;
    await CLICK(el.dom.byId('brain-key-save'));
    ok(el.state.saves.length === 1 && pageHolds(el).length === 0, 'T-31 security: Electron -> saved, and the key is in no value/attribute/text of the page', pageHolds(el).join(','));
  }

  // ---- UX: while the 18+ box is unticked the key field is disabled with a hint (no silent wipe) ----
  {
    const SENT = ['sk-or', 'v1', 'SENTINELkeyUX', '7'.repeat(16)].join('-');
    const g = await runCard({ tauri: true, provider: 'openrouter', settings: fresh() });
    const input = g.dom.byId('brain-key-input');
    const hint = g.dom.byId('brain-free-key-hint');
    ok(input.disabled === true && hint && hint.hidden === false && hint.textContent === 'Tick the 18+ confirmation above to enter a key.', 'blocked: the key input is disabled and the hint is shown', JSON.stringify({ d: input.disabled, h: hint && hint.textContent }));
    const box = g.dom.byId('brain-free-age18');
    box.checked = true;
    for (const fn of box.handlers.change || []) await fn();
    ok(input.disabled === false && hint.hidden === true, 'ticking the box enables the input and hides the hint');
    ok(g.dom.byId('brain-key-save').disabled === false && input.disabled === false, 'gap 3: once 18+ is accepted the key input and Save are both enabled');
    { const src = fs.readFileSync(new URL('../src/renderer/brain-key-card.js', import.meta.url), 'utf8'); ok(src.includes('el.edit.parentNode.insertBefore(keyHint, el.edit.nextSibling)') && !src.includes('el.input.parentNode.insertBefore(keyHint'), 'gap 3: the key hint is placed after the flex row, never inside it (it squashed the input)'); }
    input.value = SENT;
    box.checked = false;
    for (const fn of box.handlers.change || []) await fn();
    ok(input.disabled === true && input.value === '' && hint.hidden === false, 'unticking clears the field, disables it and shows the hint again', JSON.stringify({ d: input.disabled, v: input.value.length }));
    const vi = await runCard({ tauri: true, provider: 'openrouter', settings: fresh(), locale: 'vi' });
    ok(vi.dom.byId('brain-free-key-hint').textContent === 'Tick ô xác nhận 18+ ở trên rồi mới nhập khoá.', 'VI hint text');
    const zh = await runCard({ tauri: true, provider: 'openrouter', settings: fresh(), locale: 'zh' });
    ok(zh.dom.byId('brain-free-key-hint').textContent === '请先勾选上方的 18+ 确认，再输入密钥。', 'ZH hint text');
    const e = await runCard({ tauri: false, provider: 'openrouter', settings: fresh() });
    ok(e.dom.byId('brain-key-input').disabled !== true && !e.dom.created.some((c) => c.id === 'brain-free-key-hint'), 'Electron: input stays enabled, no hint DOM');
  }

  // ---- Electron identity: the DOM it rendered before FL-2/FL-3, ignoring the Tauri-only `disabled` gate ----
  {
    const electron = await runCard({ tauri: false, provider: 'gemini', settings: fresh() });
    const tauri = await runCard({ tauri: true, provider: 'gemini', settings: fresh() });
    const CARD_IDS = ['brain-key-chip', 'brain-key-desc', 'brain-key-view', 'brain-key-mask', 'brain-key-check', 'brain-key-change', 'brain-key-clear', 'brain-key-edit', 'brain-key-input', 'brain-key-save', 'brain-key-cancel', 'brain-key-note', 'brain-key-test', 'brain-key-save-anyway', 'brain-provider', 'brain-guide', 'brain-guide-open', 'brain-notice', 'brain-mode-free', 'brain-mode-byok'];
    const idsOf = (r) => [...new Set(r.dom.created.map((e) => e.id).filter(Boolean))];
    ok(same(idsOf(electron).sort(), CARD_IDS.slice().sort()), 'Electron: the card touches exactly its pre-FL-2 element ids', JSON.stringify(idsOf(electron)));
    ok(!electron.dom.created.some((e) => /^brain-free/.test(e.id)), 'Electron: FL-2/FL-3 create no DOM node at all');
    // The picker list and the frozen Gemini notice are INTENTIONALLY different under Tauri (R1/R3); `disabled` is
    // ignored by SNAP. Everything else must stay identical.
    const FL3_DIFFERS = ['brain-provider', 'brain-notice'];
    const diffs = CARD_IDS.filter((id) => !FL3_DIFFERS.includes(id)).filter((id) => !same(SNAP(electron.dom.byId(id)), SNAP(tauri.dom.byId(id))));
    ok(diffs.length === 0, 'identity: Electron and Tauri render the same pre-FL-2 elements (ignores `disabled`, the Tauri picker list and the hidden frozen notice)', diffs.join(', '));
  }
} finally {
  Object.assign(globalThis, globals);
}

process.stdout.write(JSON.stringify(results));
