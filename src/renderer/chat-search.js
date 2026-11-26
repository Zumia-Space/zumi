// A search box for what was said in the chat (T-31-MAUS R6c C item 2). While Memory is on, the host keeps the person's sentence and Zumi's
// reply of each finished turn in the local memory file (kind 'turn'); this box searches them through memory.list({ kind: 'turn', search }).
// Nothing is sent anywhere by this file. It exists only where the host has the memory API (the Tauri build), so Electron shows no control
// that does nothing. Everything shown is what the host returned, set with textContent only. Built here, not in index.html, like
// agent-chat.js.
import { t as i18nT, apply as i18nApply } from './i18n.js';

const LIMIT = 20;
const SHOW_CHARS = 240;

/** True where the host has the memory API. */
export const chatSearchAvailable = (zumi) => Boolean(zumi && zumi.memory && typeof zumi.memory.list === 'function');

const cut = (s) => { const a = Array.from(String(s == null ? '' : s)); return a.length > SHOW_CHARS ? `${a.slice(0, SHOW_CHARS).join('')}…` : a.join(''); };

/** Builds the button and the (closed) panel with the box and the result list above the chat box. Returns { open, close, search } or null without the API. */
export function initChatSearch(zumi, $, { doc = typeof document === 'undefined' ? null : document, t = i18nT, apply = i18nApply, delayMs = 200 } = {}) {
  if (!doc || !chatSearchAvailable(zumi) || $('chat-search')) return null;
  const composer = doc.querySelector('footer.composer');
  const msg = $('msg');
  if (!composer || !msg) return null;
  const node = (tag, cls, text, id) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; if (id) e.id = id; return e; };

  const btn = node('button', 'ghost slim', t('chat.search.btn'), 'chat-search-btn');
  btn.type = 'button';
  btn.dataset.i18n = 'chat.search.btn';
  btn.setAttribute('aria-expanded', 'false');
  btn.setAttribute('aria-controls', 'chat-search');
  const panel = node('div', 'chat-search', null, 'chat-search');
  panel.hidden = true;
  const input = node('input', null, null, 'chat-search-input');
  input.type = 'search';
  input.placeholder = t('chat.search.ph');
  input.setAttribute('aria-label', t('chat.search.ph'));
  input.dataset.i18nPlaceholder = 'chat.search.ph'; // a language switch repaints it with the shell (i18n apply), as it does the button
  input.dataset.i18nAria = 'chat.search.ph';
  input.setAttribute('autocomplete', 'off');
  const results = node('ul', 'chat-search-results', null, 'chat-search-results');
  results.setAttribute('aria-live', 'polite');
  panel.appendChild(input);
  panel.appendChild(results);
  composer.insertBefore(btn, msg);
  composer.insertBefore(panel, msg);
  apply(btn);
  apply(panel);

  let seq = 0;
  let timer = null;

  function paint(items, error) {
    results.textContent = '';
    if (error) { results.textContent = t('chat.search.err', { error }); return; }
    if (!items) return;
    if (!items.length) { results.textContent = t('chat.search.none'); return; }
    for (const it of items) {
      const row = node('li', 'chat-search-row');
      row.appendChild(node('div', 'chat-search-you', cut(it.text)));
      row.appendChild(node('div', 'chat-search-zumi', `Zumi: ${cut(it.reply)}`));
      results.appendChild(row);
    }
  }

  async function search(q) {
    const query = String(q == null ? '' : q).trim();
    const mine = ++seq;
    if (!query) { paint(null); return null; }
    let r;
    try { r = await zumi.memory.list({ kind: 'turn', search: query, limit: LIMIT }); } catch (e) { if (mine === seq) paint(null, (e && e.message) || String(e)); return null; }
    if (mine !== seq) return null; // a newer search already answered
    const items = Array.isArray(r) ? r : (r && Array.isArray(r.items) ? r.items : []);
    paint(items);
    return items;
  }

  function open() { panel.hidden = false; btn.setAttribute('aria-expanded', 'true'); input.focus(); }
  function close() { panel.hidden = true; btn.setAttribute('aria-expanded', 'false'); }

  btn.addEventListener('click', () => { if (panel.hidden) open(); else close(); });
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => search(input.value), delayMs); });

  return { open, close, search };
}
