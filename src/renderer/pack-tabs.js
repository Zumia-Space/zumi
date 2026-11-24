// MKT phase 2 (ADR 2026-11-11-pack-system): one sidebar tab per installed web-app pack. The Rust host lists them
// (`pack_list`: installed, listed in the signed store index, or the owner's --pack-dir); the tab's page runs in its own
// locked guest webview (partition `pack:<id>`), opened only when the tab is first shown. A pack that is removed loses its
// tab at the next refresh. Electron and builds without the Tauri host have no packs: nothing is added.
import { t as tr, getLocale, onLocaleChange } from './i18n.js';
import { createRoomChoice, roomQuery } from './room3d.js';

const REFRESH_MS = 5000;
const ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3h6v3a2 2 0 1 0 4 0h2v6h-3a2 2 0 1 0 0 4h3v5H3V9h3a2 2 0 1 0 0-4H3V3h6z"/></svg>';

// The pack's label in the app's language (i18n locale: en/vi/zh), English when the pack has none for it.
const labelFor = (label, lang) => (label && typeof label === 'object' ? (label[lang] || label.en || '') : String(label || ''));

/** @param {{ openZumiTab: () => void }} o */
export function initPackTabs({ openZumiTab }) {
  const core = window.__TAURI__ && window.__TAURI__.core;
  if (!core || typeof core.invoke !== 'function') return { refresh: async () => [] };
  const nav = document.getElementById('sidebar');
  const spacer = nav && nav.querySelector('.spacer');
  const main = document.querySelector('main');
  if (!nav || !spacer || !main) return { refresh: async () => [] };
  const shown = new Map(); // id -> { button, panel, host, webview }
  // Room 1 / Room 2 of a stage pack (room3d.js): the host owns the pick, in the main webview's storage (read lazily: a blocked storage is a run-only pick).
  const roomChoice = createRoomChoice({ getItem: (k) => window.localStorage.getItem(k), setItem: (k, v) => window.localStorage.setItem(k, v), removeItem: (k) => window.localStorage.removeItem(k) });

  // Room live B F1 (ADR D8): the host closed the 3D guest (bench, crash, lost polls, ...) and says why. The app shows the video room (the Zumi
  // tab, whose renderer runs again) and ONE line with the reason; the code rides on the element so a test can read it.
  const REASONS = new Set(['bench', 'no_ready', 'guest_gone', 'no_poll', 'contract', 'violations', 'perf', 'queue_full']);
  function showFallback(payload) {
    const reason = payload && typeof payload.reason === 'string' && REASONS.has(payload.reason) ? payload.reason : 'other';
    openZumiTab();
    for (const holder of [document.getElementById('stage-reason-slot'), main]) {
      if (holder) for (const old of [...holder.children].filter((c) => c.className === 'stage-reason')) old.remove();
    }
    const line = document.createElement('p');
    line.className = 'stage-reason';
    line.dataset.reason = reason;
    line.textContent = tr(`stage.reason.${reason}`);
    // The way back (the manual override of ask-11130717, ADR A11; Opus gate must-fix 3): "Test again" forgets the saved bench verdict so
    // the bench runs again; "Try the 3D
    // room anyway" is one guarded attempt (F1 still applies to it). Both then ask the Zumi tab to show the 3D room.
    const packId = payload && typeof payload.pack === 'string' ? payload.pack : null;
    const button = (cls, key, op) => {
      const b = document.createElement('button');
      b.className = cls;
      b.textContent = tr(key);
      b.addEventListener('click', async () => {
        await zumi.stage.produce(op, {});
        line.remove();
        document.dispatchEvent(new CustomEvent('zumi:room3d-enter', { detail: { pack: packId } }));
      });
      return b;
    };
    if (packId && zumi && zumi.stage && typeof zumi.stage.produce === 'function') {
      line.appendChild(button('stage-retry', 'stage.tryAnyway', 'tryAnyway'));
      line.appendChild(button('stage-again', 'stage.testAgain', 'testAgain'));
    }
    const dismiss = document.createElement('button');
    dismiss.className = 'stage-dismiss';
    dismiss.textContent = tr('stage.dismiss');
    dismiss.setAttribute('aria-label', tr('stage.dismiss'));
    dismiss.addEventListener('click', () => line.remove());
    line.appendChild(dismiss);
    (document.getElementById('stage-reason-slot') || main).appendChild(line);
  }
  // One guest per pack: while the Zumi tab shows the 3D room (room3d.js), the Room tab's viewer stays closed.
  document.addEventListener('zumi:room3d', (e) => {
    if (!(e && e.detail && e.detail.active)) return;
    for (const entry of shown.values()) if (entry.stage && entry.webview) { entry.webview.remove(); entry.webview = null; }
  });
  const zumi = window.zumi;
  if (zumi && zumi.stage && typeof zumi.stage.onFallback === 'function') zumi.stage.onFallback(showFallback);

  function open(entry, t) {
    if (entry.webview) return;
    if (t.stage && globalThis.__zumiRoom3dActive) { entry.note.textContent = tr('stage.inZumiTab'); entry.note.hidden = false; return; }
    const webview = document.createElement('webview');
    webview.setAttribute('partition', t.partition);
    webview.setAttribute('src', t.src + (t.stage ? roomQuery(roomChoice.get()) : ''));
    webview.addEventListener('did-fail-load', () => { entry.note.hidden = false; });
    entry.host.appendChild(webview);
    entry.webview = webview;
  }

  // Called on add and on every app language switch (like the built-in tabs' data-i18n repaint).
  function paintLabel(entry) {
    const name = labelFor(entry.label, getLocale());
    entry.button.title = name;
    entry.name.textContent = name;
    entry.title.textContent = name;
    entry.note.textContent = tr('pack.failed');
  }

  // The switch in the Room tab header: two buttons, the pick is the one on. A pick reopens the tab's guest on that room (one guest, never two).
  function paintSwitch(entry) {
    if (!entry.switchBtns) return;
    const room = roomChoice.get();
    entry.painted = room;
    entry.switchBtns.forEach((b, i) => { b.setAttribute('aria-pressed', String(room === i + 1)); b.className = `room-switch-btn${room === i + 1 ? ' on' : ''}`; b.textContent = tr(`room.switch.${i + 1}`); });
  }
  function reopen(entry, t) { if (entry.webview) { entry.webview.remove(); entry.webview = null; open(entry, t); } }
  function pickRoom(entry, t, n) {
    roomChoice.set(n);
    paintSwitch(entry);
    reopen(entry, t);
    document.dispatchEvent(new CustomEvent('zumi:room-choice', { detail: { room: n } })); // the Zumi tab's 3D room follows
  }

  function add(t) {
    const button = document.createElement('button');
    button.className = 'tab pack-tab';
    button.dataset.tab = `pack-${t.id}`;
    button.innerHTML = ICON;
    const span = document.createElement('span');
    button.appendChild(span);
    nav.insertBefore(button, spacer);
    const panel = document.createElement('section');
    panel.id = `tab-pack-${t.id}`;
    panel.className = 'panel pack-panel';
    const header = document.createElement('header');
    header.className = 'toolbar';
    const title = document.createElement('span');
    title.className = 'title';
    const ver = document.createElement('span');
    ver.className = 'muted';
    ver.textContent = `${t.id} ${t.version}${t.bundled ? ' (bundled)' : t.dev ? ' (dev folder)' : ''}`;
    // Where the pack came from is for developers: shown only for a --pack-dir dev folder. A bundled or store pack keeps the line in the
    // DOM (probes read it) and as the title's tooltip, but the owner never sees the id string (Fable visual pass alpha.11 A).
    ver.hidden = Boolean(t.bundled) || !t.dev; // an owner build loads its bundled pack with dev set too: bundled wins, as in the text above
    title.title = ver.textContent;
    header.append(title, ver);
    let switchBtns = null;
    if (t.stage) {
      const box = document.createElement('span');
      box.className = 'room-switch';
      box.setAttribute('role', 'group');
      switchBtns = [1, 2].map((n) => { const b = document.createElement('button'); b.type = 'button'; b.dataset.room = String(n); b.addEventListener('click', () => pickRoom(entry, t, n)); box.appendChild(b); return b; });
      header.appendChild(box);
    }
    const host = document.createElement('div');
    host.className = 'pack-host';
    const note = document.createElement('p');
    note.className = 'pack-note';
    note.hidden = true;
    host.appendChild(note);
    panel.append(header, host);
    if (t.stage) {
      // Room live B (ADR D2): the guest gets numbers, never text, so the reply caption lives here in the host UI, under the stage.
      const caption = document.createElement('p');
      caption.className = 'pack-caption';
      panel.appendChild(caption);
      document.addEventListener('zumi:caption', (e) => { caption.textContent = String((e && e.detail) || ''); });
    }
    main.appendChild(panel);
    const entry = { button, panel, host, note, webview: null, version: t.version, label: t.label, name: span, title, stage: Boolean(t.stage), switchBtns, painted: 0 };
    paintLabel(entry);
    paintSwitch(entry);
    document.addEventListener('zumi:room-choice', () => { if (shown.get(t.id) === entry && entry.painted !== roomChoice.get()) { paintSwitch(entry); reopen(entry, t); } });
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

  onLocaleChange(() => { for (const entry of shown.values()) { paintLabel(entry); paintSwitch(entry); } });
  refresh();
  setInterval(refresh, REFRESH_MS);
  window.addEventListener('focus', refresh);
  return { refresh };
}
