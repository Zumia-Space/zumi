// Brain (T-31 slice 3): the card over the room with two tabs, Memory and Tasks (concept A-1, owner 27-10: read and manage tasks and memory
// in one place). Read-only on the board: the task library and detail read the board state (board-data.js), and every edit is "Open on
// board". No Graph view here (slice 4: the toggle is absent, not disabled).
// boot.js creates the sidebar item and the card element (like Devices / Skills) and calls initBrain with the card.
import { t, getLocale, onLocaleChange } from '../../i18n.js';
import { el } from './dom.js';
import { getBoardState, reasonKey } from './board-data.js';
import { libraryCounts, taskDetail } from './board-model.js';
import { renderLibrary } from './library.js';
import { renderDetail, releaseMedia } from './detail.js';
import { closeDiagramFullscreen } from './diagram.js';
import { renderMemoryCard } from './memory-card.js';
import { memoryAvailable, memoryCountText, renderMemoryList } from './memory-list.js';
import { openTaskOnBoard } from './open-board.js';
import { renderSoulTab } from './soul.js';

// T-31 alpha.12: Soul is the third tab (PLAN-ZUMI-WATCH v2 C.2): who Zumi is, edited with a warning, history and undo.
const TABS = ['memory', 'tasks', 'soul'];

function reasonCard(host, reason) {
  host.textContent = '';
  const { key, vars } = reasonKey(reason);
  const card = el('div', 'nb-note nb-reason');
  card.dataset.reason = reason;
  card.append(el('h3', 'nb-note-h', t('brain.reason.title')), el('p', 'nb-text', t(key, vars)), el('p', 'nb-mute nb-mono', t('brain.reason.label', { reason })));
  host.appendChild(card);
  // No board on this computer (the normal state of a public build): say how to connect one, under the card.
  if (reason === 'unconfigured') host.appendChild(el('p', 'nb-empty', t('brain.reason.unconfiguredHint')));
}

/** Fills the card. `isOwner()` only decides the `local` flag of the board URL. Returns { opened } for boot.js to call when the card is shown. */
export function initBrain({ card, isOwner = () => false, openBoard = openTaskOnBoard, tabIds = TABS }) {
  const sheet = document.createElement('link'); // the Brain stylesheet (build-renderer.mjs copies next/brain/*.css with the rest of next/)
  sheet.rel = 'stylesheet'; sheet.href = 'next/brain/brain.css';
  document.head.appendChild(sheet);
  const ui = { tab: tabIds[0], task: null, query: '', showClosed: false };
  let res = null, loading = false, seq = 0, memCount = null;

  card.setAttribute('aria-label', t('nav.brain'));
  const head = el('div', 'head');
  const tag = el('span', 'tag', t('brain.tag'));
  const tabs = el('div', 'nb-tabs');
  tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', t('brain.tabs.aria'));
  const tabBtn = {};
  for (const id of tabIds) {
    const b = el('button', 'nb-tab', t(`brain.tab.${id}`));
    b.type = 'button'; b.setAttribute('role', 'tab'); b.dataset.tab = id;
    b.addEventListener('click', () => { ui.tab = id; if (id === 'tasks') refresh(); paint(); });
    tabBtn[id] = b; tabs.appendChild(b);
  }
  const meta = el('span', 'meta');
  head.append(tag, tabs, el('span', 'sp'), meta);
  const body = el('div', 'nb-body');
  card.append(head, el('div', 'gline'), body);

  const paintHead = () => {
    tag.textContent = t('brain.tag');
    for (const id of tabIds) { tabBtn[id].textContent = t(`brain.tab.${id}`); tabBtn[id].setAttribute('aria-selected', String(ui.tab === id)); tabBtn[id].classList.toggle('on', ui.tab === id); }
    meta.textContent = ui.tab === 'soul' ? '' : ui.tab === 'tasks' ? (res && res.ok ? t('brain.lib.count', libraryCounts(res.state)) : '') : (memCount != null ? memoryCountText(memCount) : '');
  };

  function paint() {
    paintHead();
    card.classList.remove('nx-brain-full'); // set again below only while a task detail is shown (Back, the Memory tab, a reason card: the narrow card)
    if (ui.tab !== 'tasks' || !ui.task) { releaseMedia(); closeDiagramFullscreen(); } // thumbnails, the lightbox and a fullscreen diagram belong to the open detail only
    body.scrollTop = 0;
    if (ui.tab === 'soul') return renderSoulTab(body);
    if (ui.tab === 'memory') {
      // Feature-detected: only a host with window.zumi.memory (Tauri) gets the list; Electron gets the card and makes no memory.* call.
      if (!memoryAvailable()) { memCount = null; paintHead(); return renderMemoryCard(body); }
      return renderMemoryList(body, { onCount: (n) => { memCount = n; paintHead(); } });
    }
    if (!res) { body.textContent = ''; return body.appendChild(el('p', 'nb-empty', t('brain.lib.loading'))); }
    if (!res.ok) return reasonCard(body, res.reason);
    const model = ui.task ? taskDetail(res.state, ui.task) : null;
    if (ui.task && !model) ui.task = null; // the task left the board between two reads
    if (model) {
      // R2 (owner 29-10): an open task fills the stage edge to edge so the whole detail, plan and diagrams are readable; the avatar stays behind.
      card.classList.add('nx-brain-full');
      return renderDetail(body, model, {
        onBack: () => { ui.task = null; paint(); },
        onOpenBoard: (id) => openBoard(id, { locale: getLocale(), ownerAdmin: isOwner() }),
        owner: isOwner(), // Open buttons for the dossier and cited refs: owner build only
      });
    }
    renderLibrary(body, { state: res.state, ui, onOpen: (id) => { ui.task = id; paint(); }, onRefresh: refresh });
  }

  // One read at a time; a late answer from an older read never overwrites a newer one.
  async function refresh() {
    const mine = ++seq;
    loading = true;
    const r = await getBoardState();
    if (mine !== seq) return;
    loading = false; res = r;
    if (ui.tab === 'tasks') paint(); else paintHead();
  }

  // A repaint in place keeps the view: a saved word comes through here while the person is scrolled down at Save, and the status line is there.
  onLocaleChange(() => { const y = body.scrollTop; paint(); body.scrollTop = y; });
  paint();
  return { opened: () => { paint(); refresh(); }, isLoading: () => loading };
}
