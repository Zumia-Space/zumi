// check:first-run-setup (T-31 R8, owner 04-11: "bảng hỏi lần đầu ... cho người dùng tự thiết lập các phần cá nhân hóa"). The first-run
// soul cards (soul.js maybeShowSoulOnboarding) also ask the app language, the name Zumi calls the user, how she addresses them (a pick
// list + free text) and whether replies are read aloud. Runs the real soul.js + i18n.js on a stub DOM against the real soul store
// (soul-prefs.js createSoulStore) on a fresh data dir: no window, no network, no model.
//   1. a fresh data dir shows the cards once; after Done or Skip they never return;
//   2. the fields and their defaults; 3. Done saves into the existing stores (soul, settings uiLang, speakTypedWhenMicOff);
//   4. the saved values reach the public persona text (soulSystemPrompt publicBuild; check:public-text covers the chat-host turn).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSoulStore, soulSystemPrompt } = require('../src/main/soul-prefs.js');
const nap = (ms = 5) => new Promise((r) => setTimeout(r, ms));
class El {
  constructor(tag) { this.tag = tag; this.children = []; this.text = ''; this.dataset = {}; this.style = {}; this.attrs = {}; this.listeners = {}; this.parent = null; this.classList = { add() {}, remove() {}, toggle() {}, contains: () => false }; }
  set textContent(v) { for (const c of this.children) c.parent = null; this.children = []; this.text = String(v); }
  get textContent() { return this.text + this.children.map((c) => c.textContent).join(''); }
  append(...n) { for (const c of n) this.appendChild(c); }
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; }
  addEventListener(n, f) { (this.listeners[n] ||= []).push(f); }
  fire(n) { for (const f of this.listeners[n] || []) f({ preventDefault() {} }); }
  click() { this.fire('click'); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  focus() {}
  find(pred) { if (pred(this)) return this; for (const c of this.children) { const r = c.find(pred); if (r) return r; } return null; }
}
const docEvents = []; // names of the document events the cards dispatch
globalThis.document = { body: new El('body'), createElement: (t) => new El(t), createElementNS: (_, t) => new El(t), addEventListener() {}, removeEventListener() {}, querySelectorAll: () => [], dispatchEvent: (e) => { docEvents.push(e.type); return true; } };
globalThis.window = globalThis;

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zumi-first-run-'));
let n = 0;
/** A fresh data dir: settings.json in memory, the soul store on disk, the ui / talk host calls the cards use. */
function freshHost() {
  const dir = path.join(tmpRoot, `d${++n}`); fs.mkdirSync(dir);
  const host = { settings: {}, calls: [] };
  const store = createSoulStore({ settings: () => host.settings, saveSettings: (p) => { host.settings = { ...host.settings, ...p }; return host.settings; }, dataDir: dir });
  host.store = store;
  host.zumi = {
    soul: { get: async () => { await nap(1); return store.get(); }, save: async (p) => { await nap(1); const { onboarding, ...rest } = p; host.calls.push(['soul.save', p]); return store.save(rest); } },
    ui: { getLang: async () => host.settings.uiLang || 'en', setLang: async (l) => { host.calls.push(['ui.setLang', l]); host.settings = { ...host.settings, uiLang: l }; return l; } },
    talk: {
      getSpeakTypedWhenMicOff: async () => host.settings.speakTypedWhenMicOff !== false,
      setSpeakTypedWhenMicOff: async (on) => { host.calls.push(['talk.setSpeakTypedWhenMicOff', on]); host.settings = { ...host.settings, speakTypedWhenMicOff: on === true }; return true; },
    },
  };
  return host;
}

const { setLocale, getLocale, setAddress, t } = await import('../src/renderer/i18n.js');
const { maybeShowSoulOnboarding } = await import('../src/renderer/next/brain/soul.js');

let pass = 0, fail = 0;
const ok = (c, name, detail = '') => { if (c) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); } };
const dialog = (m) => m.find((x) => x.className === 'nb-onboard');
const byAct = (m, a) => m.find((x) => x.dataset && x.dataset.act === a);
const field = (m, f) => m.find((x) => x.dataset && x.dataset.field === f);
const set = (m, f, v, ev) => { const i = field(m, f); if (!i) throw new Error(`no field ${f}`); if (typeof v === 'boolean') i.checked = v; else i.value = v; i.fire(ev); };
// Words that address a person but are no name: the Vietnamese address words (soul-templates.json choices + never-list) and the
// placeholder words of the other locales. A persona line that names the user by one of them fights the address rule.
const PRONOUNS = ['bạn', 'anh', 'chị', 'em', 'cậu', 'mình', 'tôi', 'you', '你'];
/** Self-contradicting lines in a persona text (review R8 BLOCKING): the address word also forbidden, a name the address rule forbids,
 *  a pronoun posing as the name next to another address word, or "Address the user as X" next to "call the user "Y"". Empty = consistent. */
function contradictions(text) {
  const out = [];
  const call = /call the user "([^"]+)"/.exec(text);
  const never = /Never call yourself or the user ([^.]*)\./.exec(text);
  const neverWords = never ? [...never[1].matchAll(/"([^"]+)"/g)].map((x) => x[1].toLowerCase()) : [];
  if (call && neverWords.includes(call[1].toLowerCase())) out.push(`address word "${call[1]}" is also forbidden`);
  const named = /(Address the user as|The user's name is) ([^.]+)\./.exec(text);
  if (named) {
    const nm = named[2].toLowerCase();
    if (neverWords.includes(nm)) out.push(`name "${named[2]}" is forbidden by the address rule`);
    if (PRONOUNS.includes(nm)) out.push(`name "${named[2]}" is a pronoun, not a name`);
    if (named[1] === 'Address the user as' && call && call[1].toLowerCase() !== nm) out.push(`"Address the user as ${named[2]}" vs call the user "${call[1]}"`);
  }
  return out;
}
const nameLine = (text) => /(Address the user as|The user's name is) [^.]+\./.exec(text);

/** Opens the cards on `mount`; returns { done }: the pending promise (true on Done/Skip, false when not shown). Wrapped so awaiting start does not await it. */
async function start(host, mount) { window.zumi = host.zumi; const done = maybeShowSoulOnboarding(mount); await nap(15); return { done }; }

try {
  // ---- 1-3: fresh data dir, English UI, Done ----
  setLocale('en'); setAddress({ selfWord: 'em', userWord: 'bạn' });
  const h = freshHost();
  const m = new El('div');
  const { done: p } = await start(h, m);
  ok(Boolean(dialog(m)), 'fresh data dir: the first-run cards show');
  const langSel = field(m, 'uiLang');
  ok(Boolean(langSel) && langSel.tag === 'select' && langSel.children.map((o) => o.value).join() === 'en,vi,zh' && langSel.value === 'en', 'card 1: app language picker (en, vi, zh), set to the current language', langSel && JSON.stringify(langSel.children.map((o) => o.value)));
  byAct(m, 'next').click(); await nap(5);
  const owner = field(m, 'ownerName');
  ok(owner && owner.value === '' && owner.placeholder === 'you', 'card 2 (English UI): the name field is empty, "you" only as its placeholder', owner && JSON.stringify({ value: owner.value, placeholder: owner.placeholder }));
  const uw = field(m, 'userWord');
  const listId = uw && uw.getAttribute('list');
  const dl = listId && m.find((x) => x.tag === 'datalist' && x.id === listId);
  const words = dl ? dl.children.map((o) => o.value) : [];
  ok(uw && uw.tag === 'input' && dl && ['bạn', 'anh', 'chị', 'em'].every((w) => words.includes(w)), 'card 2: how she addresses them = a pick list (datalist) + free text', JSON.stringify(words));
  ok(Boolean(field(m, 'replyLang')), 'card 2: reply language picker is kept');
  const voice = field(m, 'voice');
  ok(voice && voice.type === 'checkbox' && voice.checked === true, 'card 2: optional voice switch, on by default (read the reply aloud)', voice && JSON.stringify({ type: voice.type, checked: voice.checked }));
  // Back to card 1, switch the app language to Vietnamese: applied at once and persisted; the name default follows (untouched field).
  m.find((x) => x.tag === 'button' && x.textContent === t('onboard.back')).click(); await nap(5);
  set(m, 'uiLang', 'vi', 'change'); await nap(10);
  ok(getLocale() === 'vi' && h.settings.uiLang === 'vi' && h.calls.some(([k, v]) => k === 'ui.setLang' && v === 'vi'), 'app language: applied at once and saved (settings uiLang)', JSON.stringify(h.calls));
  byAct(m, 'next').click(); await nap(5);
  ok(field(m, 'ownerName').value === '' && field(m, 'ownerName').placeholder === 'bạn', 'card 2 (Vietnamese UI): the name field is empty, "bạn" only as its placeholder', JSON.stringify({ value: field(m, 'ownerName').value, placeholder: field(m, 'ownerName').placeholder }));
  set(m, 'ownerName', 'Lan', 'input'); set(m, 'userWord', 'chị', 'input'); set(m, 'replyLang', 'vi', 'change'); set(m, 'voice', false, 'change');
  byAct(m, 'done').click();
  const r = await p; await nap(5);
  const s = h.settings.soul || {};
  ok(r === true && !dialog(m), 'Done: the cards close');
  ok(s.ownerName === 'Lan' && s.userWord === 'chị' && s.replyLang === 'vi', 'Done: name, address word and reply language saved in the soul (settings.json soul)', JSON.stringify(s));
  ok(h.settings.speakTypedWhenMicOff === false, 'Done: the voice choice saved in the existing switch (settings.json speakTypedWhenMicOff)', JSON.stringify(h.settings));
  ok(docEvents.includes('zumi:talk-changed'), 'Done: the voice save is announced (zumi:talk-changed) so Settings > Workflow repaints in the same session (R8-F1)', JSON.stringify(docEvents));
  const text = soulSystemPrompt(h.store.current(), { publicBuild: true });
  ok(text.includes("The user's name is Lan.") && text.includes('call the user "chị"') && text.includes('Always reply in Vietnamese.') && !/owner/i.test(text), 'the saved values reach the public persona text', text.slice(0, 300));
  ok(contradictions(text).length === 0, 'typed name "Lan" + address "chị": no self-contradicting line', contradictions(text).join(' | '));
  const m2 = new El('div');
  ok(await (await start(h, m2)).done === false && !dialog(m2), 'after Done: a new launch on the same data dir shows no cards');

  // ---- Skip on another fresh data dir (Chinese UI) ----
  setLocale('zh');
  const h2 = freshHost();
  const m3 = new El('div');
  const { done: p3 } = await start(h2, m3);
  byAct(m3, 'next').click(); await nap(5);
  ok(field(m3, 'ownerName') && field(m3, 'ownerName').value === '' && field(m3, 'ownerName').placeholder === '你', 'card 2 (Chinese UI): the name field is empty, "你" only as its placeholder', field(m3, 'ownerName') && JSON.stringify(field(m3, 'ownerName').placeholder));
  docEvents.length = 0;
  byAct(m3, 'skip').click();
  ok(await p3 === true && !dialog(m3), 'Skip: the cards close');
  ok(h2.store.get().onboarded === true && !h2.calls.some(([k]) => k === 'talk.setSpeakTypedWhenMicOff') && h2.settings.speakTypedWhenMicOff === undefined, 'Skip: marked done, the voice setting untouched', JSON.stringify(h2.calls));
  ok(!docEvents.includes('zumi:talk-changed'), 'Skip: no voice change announced', JSON.stringify(docEvents));
  const m4 = new El('div');
  ok(await (await start(h2, m4)).done === false && !dialog(m4), 'after Skip: a new launch shows no cards');

  // ---- (a) the untouched name, vi + en UI, every address choice: nothing stored, no name line, no contradiction ----
  for (const loc of ['vi', 'en']) {
    for (const w of ['bạn', 'anh', 'chị', 'em', 'cậu']) {
      setLocale(loc); setAddress({ selfWord: 'em', userWord: 'bạn' });
      const hx = freshHost(); const mx = new El('div');
      const { done } = await start(hx, mx);
      byAct(mx, 'next').click(); await nap(3);
      set(mx, 'userWord', w, 'input');
      byAct(mx, 'done').click(); await done; await nap(3);
      const sx = hx.settings.soul || {};
      const px = soulSystemPrompt(hx.store.current(), { publicBuild: true });
      ok(sx.ownerName === '' && sx.userWord === w && !nameLine(px) && px.includes(`call the user "${w}"`) && contradictions(px).length === 0,
        `untouched name (${loc} UI), address "${w}": no name stored, no name line, the address word rules, no contradiction`,
        JSON.stringify({ ownerName: sx.ownerName, line: nameLine(px) && nameLine(px)[0], bad: contradictions(px) }));
    }
  }
  // ---- (b) a typed name: a real name is kept as the name; a typed address word is no name and never fights the address line ----
  for (const [loc, typed, w] of [['vi', 'Lan', 'anh'], ['vi', 'bạn', 'anh'], ['vi', 'Anh', 'chị'], ['en', 'Sam', 'bạn'], ['en', 'you', 'anh'], ['zh', '你', 'em']]) {
    setLocale(loc);
    const hx = freshHost(); const mx = new El('div');
    const { done } = await start(hx, mx);
    byAct(mx, 'next').click(); await nap(3);
    set(mx, 'ownerName', typed, 'input'); set(mx, 'userWord', w, 'input');
    byAct(mx, 'done').click(); await done; await nap(3);
    const px = soulSystemPrompt(hx.store.current(), { publicBuild: true });
    const isName = !PRONOUNS.includes(typed.toLowerCase());
    ok((hx.settings.soul || {}).ownerName === typed && (isName ? px.includes(`The user's name is ${typed}.`) : !nameLine(px)) && contradictions(px).length === 0,
      `typed name "${typed}" (${loc} UI), address "${w}": ${isName ? 'named once, no contradiction' : 'an address word, so no name line, no contradiction'}`,
      JSON.stringify({ line: nameLine(px) && nameLine(px)[0], bad: contradictions(px) }));
  }
  // ---- (c) the composed public persona: every name x address word x reply language is self-consistent ----
  {
    const bad = [];
    for (const ownerName of ['', 'Lan', 'Anh', 'bạn', 'anh', 'em', 'mình', 'tôi', 'you', 'You', '你'])
      for (const userWord of ['bạn', 'anh', 'chị', 'em', 'cậu', 'mình'])
        for (const replyLang of ['auto', 'vi', 'en']) {
          const px = soulSystemPrompt({ ownerName, userWord, selfWord: 'em', replyLang }, { publicBuild: true });
          const c = contradictions(px);
          if (c.length || /owner/i.test(px)) bad.push(`${ownerName}/${userWord}/${replyLang}: ${c.join(', ') || 'owner word'}`);
        }
    ok(bad.length === 0, 'public persona, 11 names x 6 address words x 3 reply languages: no self-contradicting line, no owner word', bad.slice(0, 6).join(' | '));
  }
  // ---- Brain > Soul preview: the store's preview is the text this build's chat sends (review R8 mutation M11) ----
  {
    const mk = (ownerBuild) => { let st = {}; const dir = path.join(tmpRoot, `pv${++n}`); fs.mkdirSync(dir); return createSoulStore({ settings: () => st, saveSettings: (p) => { st = { ...st, ...p }; return st; }, dataDir: dir, ownerBuild }); };
    const pub = mk(false); pub.save({ ownerName: 'Lan', userWord: 'chị' });
    const own = mk(true); own.save({ ownerName: 'Lan', userWord: 'chị' });
    ok(pub.get().preview === soulSystemPrompt(pub.current(), { publicBuild: true }) && !/owner/i.test(pub.get().preview), 'Soul preview (public build): the public persona text, no owner word', pub.get().preview.slice(0, 120));
    ok(own.get().preview === soulSystemPrompt(own.current()) && /speaking directly with your owner/.test(own.get().preview), 'Soul preview (owner build): the owner text, unchanged', own.get().preview.slice(0, 120));
  }
} finally {
  setLocale('en');
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

fs.mkdirSync(tmpRoot, { recursive: true });
// ---- Option A (owner 0.3.0 review: "phần hỏi này mặc định phải tiếng anh chứ hoặc chọn ngôn ngữ lúc cài à ??") ----
// First run (no uiLang saved): the UI language follows the OS locale (the webview's navigator.languages); a saved uiLang always wins.
{
  const i18n = await import('../src/renderer/i18n.js');
  const { uiLangOf } = await import('../tauri/sidecar/main.mjs');
  const osUiLang = i18n.osUiLang;
  const cases = [[['en-US'], 'en'], [['vi-VN'], 'vi'], [['zh-CN'], 'zh'], [['zh-Hans-CN'], 'zh'], [['vi'], 'vi'], [['fr-FR'], 'en'], [['vi-VN', 'en-US'], 'vi'], [['en-US', 'vi-VN'], 'en'], [[], 'en'], [undefined, 'en']];
  const got = typeof osUiLang === 'function' ? cases.map(([l]) => osUiLang(l)) : [];
  ok(typeof osUiLang === 'function' && cases.every(([, want], i) => got[i] === want), 'OS locale -> UI language: en-US en, vi-VN vi, zh-CN zh, anything else en (first preferred language)', JSON.stringify(got));
  const first = typeof uiLangOf === 'function' ? ['en', 'vi', 'zh'].map((os) => uiLangOf(undefined, os)) : [];
  ok(JSON.stringify(first) === '["en","vi","zh"]', 'first run (no uiLang saved): an en-US / vi-VN / zh-CN OS opens in en / vi / zh', JSON.stringify(first));
  const saved = typeof uiLangOf === 'function' ? [uiLangOf('en', 'vi'), uiLangOf('zh', 'vi'), uiLangOf('vi', 'zh'), uiLangOf('en', 'zh')] : [];
  ok(JSON.stringify(saved) === '["en","zh","vi","en"]', 'a saved uiLang always wins over the OS locale', JSON.stringify(saved));
  const odd = typeof uiLangOf === 'function' ? [uiLangOf(undefined, undefined), uiLangOf(undefined, 'fr'), uiLangOf('xx', 'vi')] : [];
  ok(JSON.stringify(odd) === '["en","en","vi"]', 'no OS hint or an unknown one: English, as before; a corrupt saved value counts as unsaved', JSON.stringify(odd));
  const src = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  ok(/'ui\.getLang': \(fallback\) => uiLangOf\(settings\(\)\.uiLang, fallback\)/.test(src('tauri/sidecar/main.mjs')), 'sidecar ui.getLang(fallback) = uiLangOf(saved uiLang, fallback)');
  ok(/zumi\.ui\.getLang\(osUiLang\(navigator\.languages/.test(src('src/renderer/app.js')), 'app.js passes the webview\'s OS languages to ui.getLang at boot');
  ok(/getLang: \(fallback\) => ipcRenderer\.invoke\('ui:get-lang', fallback\)/.test(src('src/main/preload.js')) && /ipcMain\.handle\('ui:get-lang', \(e, fallback\)/.test(src('src/main/main.js')), 'Electron preload / main take the same fallback');
  // The picker is the first control on card 1, labelled in all three languages.
  setLocale('en');
  const hx = freshHost(); const mx = new El('div');
  const { done } = await start(hx, mx);
  const controls = [];
  const walk = (x) => { if (['select', 'button', 'input'].includes(x.tag)) controls.push(x); x.children.forEach(walk); };
  walk(mx);
  const c0 = controls[0];
  const label = mx.find((x) => x.className === 'nb-soul-k' && x.parent && x.parent.find((y) => y.dataset && y.dataset.field === 'uiLang'));
  ok(c0 && c0.dataset.field === 'uiLang', 'card 1: the language picker is the first control (before Skip and the personalities)', JSON.stringify(controls.slice(0, 3).map((x) => x.dataset.field || x.dataset.act || x.tag)));
  ok(label && label.textContent === 'Language / Ngôn ngữ / 语言', 'card 1: the picker is labelled in all three languages', label && JSON.stringify(label.textContent));
  byAct(mx, 'skip').click(); await done;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log(`\ncheck:first-run-setup ${pass}/${pass + fail} passed`);
process.exitCode = fail ? 1 : 0;
