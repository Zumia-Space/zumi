// MKT phase 2 (ADR 2026-11-11-pack-system): one sidebar tab per installed web-app pack. The Rust host lists them
// (`pack_list`: installed, listed in the signed store index, or the owner's --pack-dir); the tab's page runs in its own
// locked guest webview (partition `pack:<id>`), opened only when the tab is first shown. A pack that is removed loses its
// tab at the next refresh. Electron and builds without the Tauri host have no packs: nothing is added.
import { t as tr } from './i18n.js';

const REFRESH_MS = 5000;
const ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3h6v3a2 2 0 1 0 4 0h2v6h-3a2 2 0 1 0 0 4h3v5H3V9h3a2 2 0 1 0 0-4H3V3h6z"/></svg>';

const labelFor = (label, lang) => (label && typeof label === 'object' ? (label[lang] || label.en || '') : String(label || ''));

/** @param {{ lang: () => string, openZumiTab: () => void }} o */
export function initPackTabs({ lang, openZumiTab }) {
  const core = window.__TAURI__ && window.__TAURI__.core;
  if (!core || typeof core.invoke !== 'function') return { refresh: async () => [] };
  const nav = document.getElementById('sidebar');
  const spacer = nav && nav.querySelector('.spacer');
  const main = document.querySelector('main');
  if (!nav || !spacer || !main) return { refresh: async () => [] };
  const shown = new Map(); // id -> { button, panel, host, webview }

  function open(entry, t) {
    if (entry.webview) return;
    const webview = document.createElement('webview');
    webview.setAttribute('partition', t.partition);
    webview.setAttribute('src', t.src);
    webview.addEventListener('did-fail-load', () => { entry.note.hidden = false; });
    entry.host.appendChild(webview);
    entry.webview = webview;
  }

  function add(t) {
    const name = labelFor(t.label, lang());
    const button = document.createElement('button');
    button.className = 'tab pack-tab';
    button.dataset.tab = `pack-${t.id}`;
    button.title = name;
    button.innerHTML = ICON;
    const span = document.createElement('span');
    span.textContent = name;
    button.appendChild(span);
    nav.insertBefore(button, spacer);
    const panel = document.createElement('section');
    panel.id = `tab-pack-${t.id}`;
    panel.className = 'panel pack-panel';
    const header = document.createElement('header');
    header.className = 'toolbar';
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = name;
    const ver = document.createElement('span');
    ver.className = 'muted';
    ver.textContent = `${t.id} ${t.version}${t.dev ? ' (dev folder)' : ''}`;
    header.append(title, ver);
    const host = document.createElement('div');
    host.className = 'pack-host';
    const note = document.createElement('p');
    note.className = 'pack-note';
    note.hidden = true;
    note.textContent = tr('pack.failed');
    host.appendChild(note);
    panel.append(header, host);
    main.appendChild(panel);
    const entry = { button, panel, host, note, webview: null, version: t.version };
    shown.set(t.id, entry);
    if (button.classList.contains('active')) open(entry, t);
    document.addEventListener('zumi:tab', (e) => { if (e.detail === `pack-${t.id}` && shown.get(t.id) === entry) open(entry, t); });
  }

  function remove(id) {
    const entry = shown.get(id);
    if (!entry) return;
    const wasActive = entry.button.classList.contains('active');
    shown.delete(id);
    entry.button.remove();
    entry.panel.remove(); // detaching the <webview> closes its guest (webview-element.js)
    if (wasActive) openZumiTab();
  }

  async function refresh() {
    let tabs;
    try { tabs = await core.invoke('pack_list'); } catch { return []; }
    if (!Array.isArray(tabs)) return [];
    const ids = new Set(tabs.map((t) => t.id));
    for (const id of [...shown.keys()]) if (!ids.has(id)) remove(id);
    for (const t of tabs) {
      const entry = shown.get(t.id);
      if (entry && entry.version !== t.version) remove(t.id); // a new version: reopen from scratch
      if (!shown.has(t.id)) add(t);
    }
    return tabs;
  }

  refresh();
  setInterval(refresh, REFRESH_MS);
  window.addEventListener('focus', refresh);
  return { refresh };
}
