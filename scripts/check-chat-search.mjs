// R6c C item 2: the search box in the chat (src/renderer/chat-search.js). Plain Node, no browser: the controller on a fake document over
// the real memory store (the shim's async rpc shape). What the person said and what Zumi answered are kept only on this device when
// Memory is on (memory.addTurn); the box searches them through memory.list({ kind: 'turn', search }).
//   node scripts/check-chat-search.mjs     (exit 1 on any failure)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemoryNotes } from '../tauri/sidecar/memory-notes.mjs';
import { TABLES, t } from '../src/renderer/i18n.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${detail ? '  ' + detail : ''}`); } };
const nap = (ms = 5) => new Promise((r) => setTimeout(r, ms));

function fakeDoc() {
  const byId = new Map();
  const mk = (tag) => {
    const listeners = {};
    let text = '';
    const el = {
      tag, children: [], dataset: {}, attrs: {}, hidden: false, className: '', title: '', disabled: false, value: '', placeholder: '', type: '', _id: '',
      get id() { return el._id; }, set id(v) { el._id = v; byId.set(v, el); },
      get textContent() { return text + el.children.map((c) => c.textContent).join(''); }, set textContent(v) { text = String(v); el.children = []; },
      appendChild(ch) { ch.parentNode = el; el.children.push(ch); return ch; },
      insertBefore(ch, ref) { ch.parentNode = el; const i = el.children.indexOf(ref); el.children.splice(i < 0 ? el.children.length : i, 0, ch); return ch; },
      remove() { if (el.parentNode) el.parentNode.children = el.parentNode.children.filter((x) => x !== el); if (el._id) byId.delete(el._id); },
      setAttribute(k, v) { el.attrs[k] = String(v); }, getAttribute(k) { return el.attrs[k]; },
      addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
      async fire(type) { for (const fn of listeners[type] || []) await fn({ preventDefault() {} }); },
      focus() { el.focused = true; },
      all() { return [el, ...el.children.flatMap((x) => x.all())]; },
    };
    return el;
  };
  const composer = mk('footer'); composer.className = 'composer';
  const msg = mk('input'); msg.id = 'msg'; composer.appendChild(msg);
  return { doc: { createElement: mk, querySelector: (sel) => (sel === 'footer.composer' ? composer : null) }, $: (id) => byId.get(id) || null, composer, msg };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zumi-chat-search-'));
try {
  const mod = await import('../src/renderer/chat-search.js').catch(() => null);
  ok(mod && typeof mod.initChatSearch === 'function' && typeof mod.chatSearchAvailable === 'function', 'chat-search.js exports initChatSearch and chatSearchAvailable');
  if (mod) {
    const mem = createMemoryNotes({ dataDir: tmp });
    mem.addTurn('t-1', 'Tôi thích cà phê đá', 'Noted: you like iced coffee.');
    mem.addTurn('t-2', 'What is the weather?', 'I cannot see the sky from here.');
    mem.add('A note about coffee');
    const calls = [];
    const zumi = { memory: { status: async () => mem.status(), list: async (q) => { calls.push(q); await nap(1); return mem.list(q); } } };
    ok(mod.chatSearchAvailable(zumi) && !mod.chatSearchAvailable({}) && !mod.chatSearchAvailable({ memory: {} }), 'available only where the host has memory.list (not Electron)');
    const f = fakeDoc();
    ok(mod.initChatSearch({}, f.$, { doc: f.doc, t, apply: () => {} }) === null && !f.$('chat-search'), 'a host without the memory API builds nothing');
    const ctl = mod.initChatSearch(zumi, f.$, { doc: f.doc, t, apply: () => {}, delayMs: 0 });
    ok(ctl && f.$('chat-search-btn') && f.$('chat-search') && f.$('chat-search-input') && f.$('chat-search-results'), 'a button, a panel, a search input and a result list are built');
    ok(f.composer.children.includes(f.$('chat-search')) && f.composer.children.indexOf(f.$('chat-search')) < f.composer.children.indexOf(f.msg), 'the panel sits above the chat box');
    ok(f.$('chat-search').hidden === true, 'the panel starts closed');
    ok(f.$('chat-search-input').dataset.i18nPlaceholder === 'chat.search.ph' && f.$('chat-search-input').dataset.i18nAria === 'chat.search.ph', 'the search box placeholder and label repaint on a language switch (data-i18n-placeholder / -aria, T-31-ALPHA12)');
    await f.$('chat-search-btn').fire('click');
    ok(f.$('chat-search').hidden === false && f.$('chat-search-input').focused === true && f.$('chat-search-btn').attrs['aria-expanded'] === 'true', 'the button opens the panel and focuses the box');
    const input = f.$('chat-search-input');
    input.value = 'ca phe da'; await input.fire('input'); await nap(30);
    const rows = f.$('chat-search-results').children;
    ok(calls.length === 1 && calls[0].kind === 'turn' && calls[0].search === 'ca phe da' && calls[0].limit === 20, 'typing searches kind turn only, 20 at most', JSON.stringify(calls));
    ok(rows.length === 1 && /cà phê đá/.test(rows[0].textContent) && /iced coffee/.test(rows[0].textContent) && !/A note about coffee/.test(f.$('chat-search-results').textContent), 'a hit shows what was said and Zumi\'s answer, and never a note');
    input.value = 'iced'; await input.fire('input'); await nap(30);
    ok(f.$('chat-search-results').children.length === 1 && /cà phê/.test(f.$('chat-search-results').textContent), 'it finds a turn by Zumi\'s words too');
    input.value = 'zzzz'; await input.fire('input'); await nap(30);
    ok(f.$('chat-search-results').textContent === t('chat.search.none'), 'no hit says so');
    const before = calls.length;
    input.value = '   '; await input.fire('input'); await nap(30);
    ok(calls.length === before && f.$('chat-search-results').textContent === '', 'an empty box calls nothing and clears the list');
    const bad = fakeDoc();
    const ctl2 = mod.initChatSearch({ memory: { status: async () => ({}), list: async () => { throw new Error('boom'); } } }, bad.$, { doc: bad.doc, t, apply: () => {}, delayMs: 0 });
    bad.$('chat-search-input').value = 'x'; await bad.$('chat-search-input').fire('input'); await nap(30);
    ok(ctl2 && /boom/.test(bad.$('chat-search-results').textContent), 'a failed search is shown, never swallowed');
    const html = '<b>x</b>';
    mem.addTurn('t-3', html, html);
    input.value = 'x'; await input.fire('input'); await nap(30);
    ok(f.$('chat-search-results').children.length >= 1 && f.$('chat-search-results').textContent.includes(html), 'text is set as text, never as markup');
    ok(!/innerHTML|outerHTML|insertAdjacentHTML/.test(fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'chat-search.js'), 'utf8').replace(/\/\/.*$/gm, '')), 'the module never sets markup');
    for (const lang of ['en', 'vi', 'zh']) {
      const used = [...fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'chat-search.js'), 'utf8').matchAll(/['"`](chat\.search\.[\w.]+)['"`]/g)].map((m) => m[1]);
      const missing = used.filter((k) => !(k in TABLES[lang]));
      ok(used.length >= 4 && missing.length === 0, `${lang}: every chat.search.* key the module uses is translated`, missing.join(', '));
    }
    mem.close();
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`\ncheck:chat-search ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
