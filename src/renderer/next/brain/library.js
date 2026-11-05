// Task library (T-31 slice 3a-1): one row per task of the board state, live tasks by default, a "show paused and closed" toggle and
// a client-side text filter. Read-only: a row only opens the detail view.
import { t, getLocale } from '../../i18n.js';
import { el, whenText } from './dom.js';
import { libraryRows } from './board-model.js';

/** Fills `host`. `ui` = { query, showClosed } is kept by the caller across repaints; `onOpen(id)` opens a task; `onRefresh()` re-reads the board. */
export function renderLibrary(host, { state, ui, onOpen, onRefresh }) {
  host.textContent = '';
  const bar = el('div', 'nb-bar');
  const input = el('input', 'nb-filter');
  input.type = 'search'; input.value = ui.query; input.placeholder = t('brain.lib.filter'); input.setAttribute('aria-label', t('brain.lib.filter'));
  const toggle = el('button', 'nb-toggle', t('brain.lib.showClosed'));
  toggle.type = 'button'; toggle.setAttribute('aria-pressed', String(ui.showClosed));
  const refresh = el('button', 'nb-toggle nb-refresh', '↻'); // a refresh glyph: the filter, the toggle and this fit one row of the narrow card
  refresh.type = 'button'; refresh.title = t('brain.refresh'); refresh.setAttribute('aria-label', t('brain.refresh'));
  bar.append(input, toggle, refresh);
  const list = el('div', 'nb-list');
  list.setAttribute('role', 'list');
  host.append(bar, list);

  const paint = () => {
    list.textContent = '';
    const rows = libraryRows(state, ui);
    if (!rows.length) list.appendChild(el('p', 'nb-empty', t(ui.query.trim() ? 'brain.lib.emptyFilter' : 'brain.lib.empty')));
    for (const r of rows) list.appendChild(row(r));
  };
  const row = (r) => {
    const b = el('button', 'nb-row');
    b.type = 'button'; b.dataset.task = r.id; b.setAttribute('role', 'listitem');
    const top = el('div', 'nb-row-top');
    top.append(el('span', 'nb-id', r.id), el('span', 'nb-title', r.title));
    if (r.needsOwner) top.appendChild(el('span', 'nb-chip q', t('brain.lib.needsYou')));
    const sub = el('div', 'nb-row-sub');
    const dot = el('i', `nb-health ${r.health}`);
    dot.setAttribute('role', 'img'); dot.setAttribute('aria-label', t(`brain.health.${r.health}`)); dot.title = t(`brain.health.${r.health}`);
    sub.append(dot, el('span', `nb-chip st-${r.status}`, t(`brain.status.${r.status}`)));
    if (r.lane) sub.appendChild(el('span', 'nb-lane', r.lane));
    sub.appendChild(el('span', 'nb-sp'));
    const when = whenText(r.lastActivity, getLocale());
    if (when) sub.appendChild(el('span', 'nb-when', when));
    b.append(top, sub);
    b.addEventListener('click', () => onOpen(r.id));
    return b;
  };

  input.addEventListener('input', () => { ui.query = input.value; paint(); });
  toggle.addEventListener('click', () => { ui.showClosed = !ui.showClosed; toggle.setAttribute('aria-pressed', String(ui.showClosed)); paint(); });
  refresh.addEventListener('click', () => onRefresh());
  paint();
}
