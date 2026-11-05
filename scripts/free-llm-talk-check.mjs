// T-31 free LLM talk-panel check, run in its OWN process by scripts/check-tauri-free-llm.mjs.
//
// Why a child process: the talk path is renderer-only (no sidecar import), so this process imports the REAL
// talk/director.js + talk/index.js (talkUi) + talk/age-confirm.js and drives them with a stub DOM and a stub cloud.
// It covers the S1 `age_confirm_required` path end to end: director -> ui.confirm box -> stored confirm / provider
// switch, plus the pure "next usable default preset" choice.
//
// Input: argv[2] = a JSON file { presets }. Output: one JSON array of { ok, name, detail }.
import fs from 'node:fs';

import { TalkDirector } from '../src/renderer/talk/director.js';
import { talkUi } from '../src/renderer/talk/index.js';
import { chooseNextProvider, createAgeConfirm, SWITCH_ORDER } from '../src/renderer/talk/age-confirm.js';
import { setLocale } from '../src/renderer/i18n.js';

const payload = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const results = [];
const ok = (cond, name, detail = '') => results.push({ ok: Boolean(cond), name, detail: String(detail || '') });

function makeDom() {
  const byIdMap = new Map();
  const created = [];
  const makeEl = (tag) => {
    const classes = new Set();
    const e = {
      tag: String(tag || 'div').toLowerCase(), id: '', className: '', value: '', hidden: false, disabled: false,
      checked: false, placeholder: '', type: '', children: [], childNodes: [], attrs: {}, handlers: {}, parentNode: null,
      parentElement: null, previousElementSibling: null, onclick: null,
      classList: {
        add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c),
        toggle: (c, on) => { const v = on === undefined ? !classes.has(c) : Boolean(on); if (v) classes.add(c); else classes.delete(c); return v; },
      },
    };
    Object.defineProperty(e, 'tagName', { get() { return e.tag.toUpperCase(); } });
    let text = '';
    Object.defineProperty(e, 'textContent', {
      get() { return text; },
      set(v) { text = String(v); if (text === '') { e.children = []; e.childNodes = []; } },
    });
    e.appendChild = (c) => { c.parentNode = e; c.parentElement = e; e.children.push(c); e.childNodes.push(c); syncSiblings(e); return c; };
    e.insertBefore = (c, ref) => {
      c.parentNode = e; c.parentElement = e;
      const i = ref ? e.children.indexOf(ref) : -1;
      if (i < 0) { e.children.push(c); e.childNodes.push(c); } else { e.children.splice(i, 0, c); e.childNodes.splice(i, 0, c); }
      syncSiblings(e);
      return c;
    };
    e.setAttribute = (k, v) => { e.attrs[k] = v; };
    e.getAttribute = (k) => (Object.prototype.hasOwnProperty.call(e.attrs, k) ? e.attrs[k] : null);
    e.addEventListener = (ev, fn) => { (e.handlers[ev] = e.handlers[ev] || []).push(fn); };
    e.focus = () => {};
    created.push(e);
    return e;
  };
  const syncSiblings = (parent) => { parent.children.forEach((c, i) => { c.previousElementSibling = parent.children[i - 1] || null; }); };
  const root = makeEl('div');
  const $ = (id) => {
    if (!byIdMap.has(id)) {
      const el = makeEl('div');
      el.id = id;
      root.appendChild(el);
      byIdMap.set(id, el);
    }
    return byIdMap.get(id);
  };
  return { root, $, byId: (id) => byIdMap.get(id) || created.find((e) => e.id === id) || null, makeEl };
}
const CLICK = async (e) => { for (const fn of e.handlers.click || []) await fn({ preventDefault() {} }); };

try {
  setLocale('en');

  // ---- the pure choice: approved order, Gemini skipped, only usable presets, picker when none ----
  {
    const order = ['gemini', 'groq', 'openrouter', 'cloudflare'];
    ok(chooseNextProvider({ currentId: 'gemini', order, hasKey: () => true }) === 'groq', 'choice: after Gemini, Groq is the first candidate');
    ok(chooseNextProvider({ currentId: 'groq', order, hasKey: () => true }) === 'openrouter', 'choice: after Groq, OpenRouter :free is next');
    ok(chooseNextProvider({ currentId: 'openrouter', order, hasKey: () => true }) === 'cloudflare', 'choice: after OpenRouter, Cloudflare is next');
    ok(chooseNextProvider({ currentId: 'cloudflare', order, hasKey: () => true }) === 'groq', 'choice: the order wraps without ever returning Gemini');
    ok(chooseNextProvider({ currentId: 'gemini', order, hasKey: (id) => id === 'openrouter' }) === 'openrouter', 'choice: an unusable Groq is skipped for a keyed provider');
    ok(chooseNextProvider({ currentId: 'gemini', order, hasKey: () => false }) === null, 'choice: no usable provider answers null (the caller opens the picker)');
    ok(chooseNextProvider({ currentId: 'gemini', order, hasKey: () => false, freeDefault: 'groq' }) === 'groq', 'choice: the free default is usable even without a key');
    ok(chooseNextProvider({ currentId: 'gemini', order, hasKey: () => true, freeDefault: 'gemini' }) !== 'gemini', 'choice: the free default Gemini is never offered (it is the blocked provider)');
    ok(JSON.stringify(SWITCH_ORDER) === JSON.stringify(['groq', 'openrouter', 'cloudflare']), 'choice: the approved order is Groq, OpenRouter :free, Cloudflare');
  }

  // ---- app wiring: createAgeConfirm reads the real preset order + key booleans and opens the picker on no key ----
  {
    const run = async ({ provider = 'gemini', keys = {}, order = ['gemini', 'groq', 'openrouter', 'cloudflare'], listFails = false }) => {
      const calls = { setProvider: [], confirm: [], opened: 0, switchedCb: 0 };
      let current = provider;
      const zumi = {
        ai: {
          provider: async () => ({ id: current }),
          presetList: async () => { if (listFails) throw new Error('rpc failed'); return { free: order.map((id) => ({ id })), keys }; },
          setProvider: async (id) => { calls.setProvider.push(id); current = id; return { ok: true, id }; },
          setPresetSettings: async (patch) => { calls.confirm.push(patch); return { ok: true, settings: { age18Confirmed: patch.age18Confirmed === true } }; },
        },
      };
      const wiring = createAgeConfirm({ zumi, openPicker: () => { calls.opened++; }, onSwitched: () => { calls.switchedCb++; } });
      const switched = await wiring.switchProvider();
      const confirmed = await wiring.confirm();
      return { calls, switched, confirmed };
    };
    const a = await run({ keys: { gemini: true, openrouter: true } });
    ok(a.calls.setProvider.length === 1 && a.calls.setProvider[0] === 'openrouter' && a.calls.opened === 0, 'wiring: a keyed OpenRouter is offered, not a hard-coded Groq', JSON.stringify(a.calls));
    ok(a.calls.switchedCb === 1, 'wiring: a successful switch refreshes the open settings card');
    const b = await run({ keys: { groq: true } });
    ok(b.calls.setProvider[0] === 'groq', 'wiring: a keyed Groq is the first choice');
    const c = await run({ keys: {} });
    ok(c.calls.setProvider.length === 0 && c.calls.opened === 1 && c.switched && c.switched.reason === 'no_usable_provider', 'wiring: with no usable provider the picker opens and nothing is switched', JSON.stringify(c.calls));
    const d = await run({ keys: {}, listFails: true });
    ok(d.calls.setProvider.length === 0 && d.calls.opened === 1 && d.calls.switchedCb === 0, 'wiring: if the preset list rpc fails the picker opens (no guessed Groq)', JSON.stringify(d.calls));
    ok(a.calls.confirm.length === 1 && a.calls.confirm[0].age18Confirmed === true && a.confirmed.ok === true, 'wiring: the confirm writes age18Confirmed through the sidecar setter');
  }

  // ---- the real talk UI + director: age_confirm_required -> box -> confirm / switch ----
  {
    const dom = makeDom();
    globalThis.document = { createElement: (tag) => dom.makeEl(tag), addEventListener() {}, dispatchEvent() {} };
    let confirmed = 0;
    let switched = 0;
    const ageConfirm = { confirm: async () => { confirmed++; return { ok: true, settings: { age18Confirmed: true } }; }, switchProvider: async () => { switched++; } };
    const ui = talkUi(dom.$, { ageConfirm });
    const director = new TalkDirector({
      engine: { player: { stop() {} }, playCommand: () => ({ ok: false }), waitLatency: async () => null },
      catalog: { get: () => null },
      cloud: { turn: async () => ({ ok: false, error: { code: 'age_confirm_required' } }) },
      speech: { stop() {}, speaking: () => false, append() {} },
      library: { pick: () => null },
      cache: { pick: () => null },
      saveCache: () => {},
      probe: () => null,
      rigVersion: () => 'test',
      ui,
      log: () => {},
    });
    await director.send('hello');
    const box = dom.byId('talk-age-confirm');
    ok(Boolean(box) && box.hidden === false, 'talk: the age_confirm_required turn shows the confirm box');
    ok(dom.byId('talk-age-confirm-reason').textContent === "Google's terms require users of the Gemini API to be 18 or older.", 'talk: the box carries the one-line 18+ reason');
    ok(/Confirm you are 18 or older/.test(dom.byId('talk-reply').textContent), 'talk: the reply explains the 18+ requirement instead of the generic failure line');
    ok(confirmed === 0 && switched === 0, 'talk: nothing is confirmed or switched without a click');

    await CLICK(dom.byId('talk-age-confirm-yes'));
    ok(confirmed === 1 && box.hidden === true, 'talk: the confirm button writes the answer and hides the box');
    ok(dom.byId('talk-note').textContent === 'Confirmed. Send your message again.', 'talk: a confirmed answer tells the user to send again');

    ui.ageConfirm(); // the next refused turn shows the box again
    ok(box.hidden === false, 'talk: a later refused turn shows the confirm again');
    await CLICK(dom.byId('talk-age-confirm-switch'));
    ok(switched === 1 && box.hidden === true, 'talk: the switch button calls the provider switch and hides the box');
  }
} finally {
  // nothing global to restore: this process exits after printing.
}

process.stdout.write(JSON.stringify(results));
