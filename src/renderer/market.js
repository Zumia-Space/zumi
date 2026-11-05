// The Marketplace tab (owner 01-11, Q2-Q7 on 02-11; store redesign 05-11): free items packaged by Zumia, one panel beside the board and settings.
// A store grid of cards (icon, name, one line, category, one action) with a detail panel (description, permissions, version, size, source).
// Every card either has an action that works or says in words why it has none. Voice packs come from market.list (market-host.mjs).
// Rooms and models are the ones on this PC, read from the app's own pickers, so "Use" is the same switch as the stage's picker.
// DOM nodes and textContent only.
import { t, onLocaleChange } from './i18n.js';

const KINDS = ['voice', 'room', 'model'];
const CATEGORIES = ['all', ...KINDS, 'installed'];
const MB = 1024 * 1024;
const SVG = 'http://www.w3.org/2000/svg';
// One glyph per kind (24x24, stroked): a waveform, a room with a window, a bust; the Windows voice gets a speaker.
const GLYPH = {
  voice: ['M4 10v4', 'M8 7v10', 'M12 4v16', 'M16 8v8', 'M20 11v2'],
  room: ['M3 11l9-7 9 7', 'M5 9.5V20h14V9.5', 'M9 20v-6h6v6'],
  model: ['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M4 21c1.2-4 4.3-6 8-6s6.8 2 8 6'],
  os: ['M4 9h4l5-4v14l-5-4H4z', 'M17 9a4 4 0 0 1 0 6', 'M19.5 6.5a7.5 7.5 0 0 1 0 11'],
};
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const mb = (n) => `${Math.round(n / MB)} MB`;
const itemKey = (id) => id.replace(/[^a-z0-9]+/g, '_');

function icon(r, cls) {
  const box = el('span', `market-icon ${cls || ''} k-${r.kind}`.trim());
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
  for (const d of GLYPH[r.source === 'os' ? 'os' : r.kind] || GLYPH.voice) { const p = document.createElementNS(SVG, 'path'); p.setAttribute('d', d); svg.appendChild(p); }
  box.appendChild(svg);
  return box;
}

/** Rows the page shows, from the host's list and the app's two pickers. Pure, so the check can feed it directly. */
export function buildRows({ market, rooms, models, tr }) {
  const rows = [];
  for (const it of market && Array.isArray(market.items) ? market.items : []) {
    const key = itemKey(it.id);
    rows.push({ ...it, origin: 'catalog', name: tr(`market.item.${key}.name`), desc: tr(`market.item.${key}.desc`), note: tr(`market.item.${key}.note`) });
  }
  if (market && market.platform === 'win-x64') {
    rows.push({ id: 'os.voice', kind: 'voice', origin: 'os', source: 'os', state: 'os', needs: ['os-speech'], name: tr('market.os.name'), desc: tr('market.os.desc'), note: tr('market.os.note'), author: 'Microsoft', licence: null });
  }
  for (const r of rooms || []) rows.push({ id: `room.${r.id}`, kind: 'room', origin: 'room', source: 'pc', pickId: r.id, state: r.selected ? 'inuse' : 'onpc', needs: ['data-only'], name: r.label, desc: tr('market.room.desc'), note: tr('market.room.note'), author: 'Zumia', licence: 'LicenseRef-Zumia' });
  for (const m of models || []) {
    // A model he imported from this PC is not ours to credit.
    const ours = m.id !== 'user' && m.id !== 'test';
    rows.push({ id: `model.${m.id}`, kind: 'model', origin: 'model', source: 'pc', pickId: m.id, state: m.selected ? 'inuse' : 'onpc', needs: ['data-only'], name: m.label, desc: tr('market.model.desc'), note: tr('market.model.note'), author: ours ? 'Zumia' : null, licence: ours ? 'LicenseRef-Zumia' : null });
  }
  return rows;
}

const HAVE = new Set(['installed', 'update', 'bundled', 'inuse', 'onpc', 'os', 'restart']);
export function rowsFor(rows, category, query) {
  const q = String(query || '').trim().toLowerCase();
  return rows.filter((r) => (category === 'all' || r.kind === category || (category === 'installed' && HAVE.has(r.state))) && (!q || `${r.name} ${r.desc} ${r.author || ''}`.toLowerCase().includes(q)));
}

export function initMarket({ zumi, openTab, pickers }) {
  const tab = document.querySelector('.tab[data-tab="market"]');
  const panel = document.getElementById('tab-market');
  if (!tab || !panel) return null;
  if (!zumi.market) { tab.hidden = true; return null; } // Electron has no Marketplace
  const cats = document.getElementById('market-cats');
  const list = document.getElementById('market-list');
  const detail = document.getElementById('market-detail');
  const search = document.getElementById('market-search');
  let market = null;
  let loadFailed = false;
  let category = 'all';
  let selected = 'voice.kokoro-82m';
  const errors = new Map(); // id -> message from the last failed action
  const progress = new Map();

  const rows = () => buildRows({ market, rooms: pickers.rooms(), models: pickers.models(), tr: t });
  const size = (r) => (r.bytes ? (r.modelBytes ? t('market.meta.sizes', { runtime: mb(r.bytes), model: mb(r.modelBytes) }) : mb(r.bytes)) : null);

  async function act(r, fn) {
    errors.delete(r.id);
    paint();
    let res;
    try { res = await fn(); } catch { res = { ok: false, code: 'install_failed' }; }
    if (!res || !res.ok) errors.set(r.id, t(`market.err.${(res && res.code) || 'install_failed'}`));
    else if (res.restartNeeded) errors.set(r.id, t('market.err.restart_needed'));
    await refresh();
  }
  const install = (r) => act(r, () => zumi.market.install(r.id));

  /** The one action of a card (and the head of the detail panel): a button, a progress bar, or a status in words. */
  function control(r) {
    const box = el('div', 'market-ctl');
    const button = (key, cls, on) => { const b = el('button', cls, t(key)); b.type = 'button'; b.dataset.act = key.split('.').pop(); b.addEventListener('click', (e) => { e.stopPropagation(); on(); }); box.appendChild(b); return b; };
    const status = (key, cls = '') => box.appendChild(el('span', `market-status ${cls}`.trim(), t(key)));
    const p = progress.get(r.id);
    if (r.state === 'installing' || p) {
      const pct = p && p.total ? Math.floor((p.loaded / p.total) * 100) : 0;
      const bar = el('span', 'market-bar'); const fill = el('i'); fill.style.width = `${pct}%`; bar.appendChild(fill);
      bar.setAttribute('role', 'progressbar'); bar.setAttribute('aria-valuenow', String(pct)); bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', '100');
      box.append(bar, el('span', 'market-phase', `${t(`market.phase.${(p && p.phase) || 'download'}`)}${p && p.total ? `  ${pct}%` : ''}`));
    } else if (r.state === 'available') button('market.install', 'market-go', () => install(r));
    else if (r.state === 'update') button('market.update', 'market-go', () => install(r));
    else if (r.state === 'offline') { status('market.status.offline', 'warn'); button('market.retry', 'ghost', () => install(r)); }
    else if (r.state === 'installed') status('market.status.installed', 'ok');
    else if (r.state === 'inuse') status('market.status.inuse', 'ok');
    else if (r.state === 'bundled' && r.modelBytes && r.modelReady === false) button('market.getModel', 'market-go', () => install(r));
    else if (r.state === 'bundled' || r.state === 'os') status('market.status.builtin', 'ok');
    else if (r.state === 'onpc') button('market.use', 'ghost', () => { pickers.use(r.kind, r.pickId); paint(); });
    else if (r.state === 'restart') status('market.status.restart', 'warn');
    else status('market.status.unavailable'); // unpublished / unpackaged: listed, not installable yet, said in words
    return box;
  }

  function card(r) {
    const c = el('div', `market-card frame${r.id === selected ? ' sel' : ''}`); // .frame: look A's chamfered panel (next/theme-a.css)
    c.dataset.id = r.id; c.dataset.state = r.state;
    c.tabIndex = 0;
    c.setAttribute('role', 'button');
    const select = () => { selected = r.id; paint(); };
    c.addEventListener('click', select);
    c.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === c) select(); });
    const top = el('div', 'market-top');
    const head = el('div', 'market-head');
    head.append(el('div', 'k', r.name), el('div', 'market-by', r.author || t('market.by.you')));
    top.append(icon(r), head);
    const foot = el('div', 'market-foot-row');
    const chips = el('div', 'market-chips');
    chips.appendChild(el('span', 'market-chip', t(`market.cat.${r.kind}`)));
    if (r.recommended && r.state !== 'unpublished' && r.state !== 'unpackaged') chips.appendChild(el('span', 'market-chip rec', t('market.pill.recommended'))); // what cannot install is not recommended
    // While installing, the progress bar takes the whole row: the chips would sit under it.
    if (r.state === 'installing' || progress.has(r.id)) foot.append(control(r)); else foot.append(chips, control(r));
    c.append(top, el('div', 'd', r.desc), foot);
    if (errors.has(r.id)) c.appendChild(el('div', 'market-err', errors.get(r.id)));
    return c;
  }

  function paintDetail(all) {
    detail.replaceChildren();
    const r = all.find((x) => x.id === selected);
    if (!r) { detail.appendChild(el('p', 'market-why', t('market.detail.none'))); return; }
    const head = el('div', 'market-dhead');
    const title = el('div', 'market-dtitle');
    title.append(el('h3', null, r.name), el('div', 'market-by', r.author || t('market.by.you')));
    head.append(icon(r, 'big'), title);
    detail.appendChild(head);
    const actions = el('div', 'market-dact');
    actions.appendChild(control(r));
    if (r.state === 'installed' || r.state === 'update') {
      const rm = el('button', 'ghost market-rm', t('market.remove')); rm.type = 'button'; rm.dataset.act = 'remove';
      rm.addEventListener('click', () => act(r, () => zumi.market.remove(r.id)));
      actions.appendChild(rm);
    }
    detail.appendChild(actions);
    if (errors.has(r.id)) detail.appendChild(el('p', 'market-err', errors.get(r.id)));
    detail.appendChild(el('p', 'd', r.desc));
    if (r.note && r.state !== 'bundled') detail.appendChild(el('p', 'market-note', r.note)); // install words mean nothing on a build that carries it

    detail.appendChild(el('h4', null, t('market.f.permissions')));
    const perms = el('ul', 'market-perms');
    for (const n of r.needs && r.needs.length ? r.needs : ['data-only']) perms.appendChild(el('li', null, t(`market.need.${n}`)));
    detail.appendChild(perms);

    detail.appendChild(el('h4', null, t('market.f.about')));
    const facts = el('dl', 'market-facts');
    const fact = (key, value, title) => {
      if (value == null || value === '') return;
      const v = el('dd', null, value); if (title) v.title = title;
      facts.append(el('dt', null, t(key)), v);
    };
    fact('market.f.category', t(`market.cat.${r.kind}`));
    if (r.state === 'update') fact('market.f.version', t('market.f.versionUpdate', { from: r.installedVersion, to: r.version }));
    else fact('market.f.version', r.installedVersion || r.version);
    fact('market.f.size', size(r));
    fact('market.f.source', r.source === 'pc' ? t('market.source.pc') : r.source === 'os' ? t('market.source.os') : r.source);
    if (r.origin === 'catalog') fact('market.f.packaged', t('market.f.packagedZumia'));
    if (r.langs) fact('market.f.langs', r.langs.map((l) => t(`market.lang.${l}`)).join(', '));
    if (r.platforms) fact('market.f.platform', r.platforms.includes('win-x64') ? t('market.platform.win') : r.platforms.join(', '));
    fact('market.f.licence', r.licence === 'LicenseRef-Zumia' ? t('market.licence.zumia') : r.licence);
    if (r.sha256) fact('market.f.sha', `${r.sha256.slice(0, 16)}…`, r.sha256);
    fact('market.f.price', t('market.price.free'));
    detail.appendChild(facts);
  }

  function paintCats(all) {
    cats.replaceChildren();
    for (const c of CATEGORIES) {
      const b = el('button', `stab${c === category ? ' active' : ''}`, t(`market.cat.${c}`));
      b.type = 'button'; b.dataset.cat = c;
      b.setAttribute('aria-pressed', String(c === category));
      if (c !== 'all') b.appendChild(el('span', 'n', String(rowsFor(all, c, '').length)));
      b.addEventListener('click', () => { category = c; paint(); });
      cats.appendChild(b);
    }
  }

  function paint() {
    const all = rows();
    paintCats(all);
    list.replaceChildren();
    if (loadFailed) list.appendChild(el('p', 'market-err market-wide', t('market.err.list')));
    const shown = rowsFor(all, category, search.value);
    const sections = category === 'all' ? KINDS : [null];
    for (const kind of sections) {
      const group = kind ? shown.filter((r) => r.kind === kind) : shown;
      if (kind && group.length) list.appendChild(el('div', 'market-sect', t(`market.sect.${kind}`)));
      for (const r of group) list.appendChild(card(r));
    }
    if (!shown.length) list.appendChild(el('p', 'market-why market-wide', t(search.value ? 'market.none.search' : `market.none.${category}`)));
    if (!all.some((r) => r.id === selected) && all.length) selected = all[0].id;
    paintDetail(all);
  }

  async function refresh() {
    try { market = await zumi.market.list(); loadFailed = false; } catch { loadFailed = true; }
    paint();
  }

  zumi.market.onProgress((p) => {
    if (!p || !p.id) return;
    if (p.phase === 'done') { progress.delete(p.id); refresh(); return; } // a finished install, or a probe that changed what the list says
    progress.set(p.id, p);
    if (panel.classList.contains('active')) paint();
  });
  search.addEventListener('input', paint);
  tab.addEventListener('click', refresh);
  onLocaleChange(paint);
  refresh();
  /** Open on one item, from the Settings voice card. */
  return {
    open(id, cat) { category = cat || 'all'; selected = id || selected; openTab(); },
  };
}
