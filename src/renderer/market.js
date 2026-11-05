// The Marketplace tab (owner 01-11, Q2-Q7 on 02-11): free items packaged by Zumia, one panel beside the board and settings.
// Everything on it either works or says why it cannot. Voice packs come from market.list (market-host.mjs). Rooms and models
// are the ones on this PC, read from the app's own pickers, so "Use" is the same switch as the stage's picker. DOM nodes and textContent only.
import { t, onLocaleChange } from './i18n.js';

const CATEGORIES = ['all', 'voice', 'room', 'model', 'skill', 'soul', 'plugin', 'agent', 'installed'];
const SOON = new Set(['skill', 'soul', 'plugin', 'agent']);
const MB = 1024 * 1024;
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const mb = (n) => `${Math.round(n / MB)} MB`;
const itemKey = (id) => id.replace(/[^a-z0-9]+/g, '_');

/** Rows the page shows, from the host's list and the app's two pickers. Pure, so the check can feed it directly. */
export function buildRows({ market, rooms, models, tr }) {
  const rows = [];
  for (const it of market && Array.isArray(market.items) ? market.items : []) {
    const key = itemKey(it.id);
    rows.push({ ...it, source: 'catalog', name: tr(`market.item.${key}.name`), desc: tr(`market.item.${key}.desc`), note: tr(`market.item.${key}.note`) });
  }
  if (market && market.platform === 'win-x64') {
    rows.push({ id: 'os.voice', kind: 'voice', source: 'os', state: 'os', name: tr('market.os.name'), desc: tr('market.os.desc'), note: tr('market.os.note'), author: 'Microsoft', licence: null });
  }
  for (const r of rooms || []) rows.push({ id: `room.${r.id}`, kind: 'room', source: 'room', pickId: r.id, state: r.selected ? 'inuse' : 'onpc', name: r.label, desc: tr('market.room.desc'), note: tr('market.room.note'), author: 'Zumia', licence: 'LicenseRef-Zumia' });
  for (const m of models || []) {
    // A model he imported from this PC is not ours to credit.
    const ours = m.id !== 'user' && m.id !== 'test';
    rows.push({ id: `model.${m.id}`, kind: 'model', source: 'model', pickId: m.id, state: m.selected ? 'inuse' : 'onpc', name: m.label, desc: tr('market.model.desc'), note: tr('market.model.note'), author: ours ? 'Zumia' : null, licence: ours ? 'LicenseRef-Zumia' : null });
  }
  return rows;
}

const HAVE = new Set(['installed', 'bundled', 'inuse', 'onpc', 'os']);
export function rowsFor(rows, category, query) {
  const q = String(query || '').trim().toLowerCase();
  return rows.filter((r) => (category === 'all' || r.kind === category || (category === 'installed' && HAVE.has(r.state))) && (!q || `${r.name} ${r.desc}`.toLowerCase().includes(q)));
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

  function pills(r) {
    const out = [];
    if (r.recommended && r.state !== 'unpublished') out.push(['rec', 'market.pill.recommended']);
    const state = {
      installed: ['ok', 'market.pill.installed'], bundled: ['os', 'market.pill.bundled'], os: ['os', 'market.pill.os'], inuse: ['ok', 'market.pill.inuse'],
      onpc: ['os', 'market.pill.onpc'], unpackaged: ['soon', 'market.pill.packaging'], unpublished: ['soon', 'market.pill.soon'], restart: ['soon', 'market.pill.restart'],
    }[r.state];
    if (state) out.push(state);
    return out;
  }

  function metaLine(r) {
    const parts = [t(`market.cat.${r.kind}`)];
    if (r.author) parts.push(r.author);
    if (r.bytes) parts.push(r.modelBytes ? t('market.meta.sizes', { runtime: mb(r.bytes), model: mb(r.modelBytes) }) : mb(r.bytes));
    if (r.licence) parts.push(r.licence === 'LicenseRef-Zumia' ? t('market.licence.zumia') : r.licence);
    return parts.join('  ·  ');
  }

  async function act(r, fn) {
    errors.delete(r.id);
    paint();
    let res;
    try { res = await fn(); } catch { res = { ok: false, code: 'install_failed' }; }
    if (!res || !res.ok) errors.set(r.id, t(`market.err.${(res && res.code) || 'install_failed'}`));
    else if (res.restartNeeded) errors.set(r.id, t('market.err.restart_needed'));
    await refresh();
  }

  function control(r) {
    const box = el('div', 'market-ctl');
    const button = (key, cls, on) => { const b = el('button', cls, t(key)); b.type = 'button'; b.addEventListener('click', (e) => { e.stopPropagation(); on(); }); box.appendChild(b); return b; };
    const p = progress.get(r.id);
    if (r.state === 'installing' || p) {
      const bar = el('span', 'bar'); const fill = el('i');
      fill.style.width = p && p.total ? `${Math.floor((p.loaded / p.total) * 100)}%` : '0%';
      bar.appendChild(fill); box.append(bar, el('span', 'market-why', t(`market.phase.${(p && p.phase) || 'download'}`)));
    } else if (r.state === 'available') button('market.install', 'market-go', () => act(r, () => zumi.market.install(r.id)));
    else if (r.state === 'installed') button('market.remove', 'ghost', () => act(r, () => zumi.market.remove(r.id)));
    else if (r.state === 'bundled' && r.modelBytes && r.modelReady === false) button('market.getModel', 'market-go', () => act(r, () => zumi.market.install(r.id)));
    else if (r.state === 'onpc') button('market.use', 'ghost', () => { pickers.use(r.kind, r.pickId); paint(); });
    else if (r.state === 'unpackaged') box.appendChild(el('span', 'market-why', t('market.why.packaging')));
    else if (r.state === 'unpublished') box.appendChild(el('span', 'market-why', t('market.why.unpublished')));
    else if (r.state === 'bundled') box.appendChild(el('span', 'market-why', t('market.why.bundled')));
    else if (r.state === 'os') box.appendChild(el('span', 'market-why', t('market.why.os')));
    else if (r.state === 'restart') box.appendChild(el('span', 'market-why', t('market.err.restart_needed')));
    if (errors.has(r.id)) box.appendChild(el('span', 'market-err', errors.get(r.id)));
    return box;
  }

  function card(r) {
    const c = el('div', `market-card${r.id === selected ? ' sel' : ''}`);
    c.dataset.id = r.id;
    c.tabIndex = 0;
    const select = () => { selected = r.id; paint(); };
    c.addEventListener('click', select);
    c.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === c) select(); });
    const lbl = el('div', 'market-lbl');
    const head = el('div', 'k', r.name);
    for (const [cls, key] of pills(r)) head.appendChild(el('span', `pill market-pill ${cls}`, t(key)));
    lbl.append(head, el('div', 'd', r.desc), el('div', 'market-meta', metaLine(r)));
    c.append(lbl, control(r));
    return c;
  }

  function soonCard(kind) {
    const c = el('div', 'market-card market-soon');
    c.dataset.soon = kind;
    const lbl = el('div', 'market-lbl');
    const head = el('div', 'k', t(`market.cat.${kind}`));
    head.appendChild(el('span', 'pill market-pill soon', t('market.pill.soon')));
    lbl.append(head, el('div', 'd', t(`market.soon.${kind}`)));
    c.appendChild(lbl);
    return c;
  }

  function paintDetail(all) {
    detail.replaceChildren();
    const r = all.find((x) => x.id === selected);
    if (!r) { detail.appendChild(el('p', 'market-why', t('market.detail.none'))); return; }
    detail.appendChild(el('h3', null, r.name));
    detail.appendChild(el('p', 'd', r.desc));
    if (r.note && r.state !== 'bundled') detail.appendChild(el('p', 'market-note', r.note)); // install words mean nothing on a build that carries it
    const rowsEl = el('dl', 'market-facts');
    const fact = (key, value, title) => {
      if (value == null || value === '') return;
      const v = el('dd', null, value); if (title) v.title = title;
      rowsEl.append(el('dt', null, t(key)), v);
    };
    fact('market.f.category', t(`market.cat.${r.kind}`));
    fact('market.f.author', r.author);
    if (r.source === 'catalog') fact('market.f.packaged', t('market.f.packagedZumia'));
    fact('market.f.version', r.installedVersion || r.version);
    if (r.bytes) fact('market.f.size', r.modelBytes ? t('market.meta.sizes', { runtime: mb(r.bytes), model: mb(r.modelBytes) }) : mb(r.bytes));
    if (r.langs) fact('market.f.langs', r.langs.map((l) => t(`market.lang.${l}`)).join(', '));
    if (r.platforms) fact('market.f.platform', r.platforms.includes('win-x64') ? t('market.platform.win') : r.platforms.join(', '));
    fact('market.f.licence', r.licence === 'LicenseRef-Zumia' ? t('market.licence.zumia') : r.licence);
    if (r.sha256) fact('market.f.sha', `${r.sha256.slice(0, 16)}…`, r.sha256);
    fact('market.f.price', t('market.price.free'));
    detail.appendChild(rowsEl);
  }

  function paintCats(all) {
    cats.replaceChildren();
    for (const c of CATEGORIES) {
      const b = el('button', `stab${c === category ? ' active' : ''}`, t(`market.cat.${c}`));
      b.type = 'button'; b.dataset.cat = c;
      const n = c === 'installed' || c === 'all' ? null : (SOON.has(c) ? t('market.cat.soon') : String(rowsFor(all, c, '').length));
      if (n) b.appendChild(el('span', 'n', n));
      b.addEventListener('click', () => { category = c; paint(); });
      cats.appendChild(b);
    }
  }

  function paint() {
    const all = rows();
    paintCats(all);
    list.replaceChildren();
    if (loadFailed) list.appendChild(el('p', 'market-err', t('market.err.list')));
    const shown = rowsFor(all, category, search.value);
    const sections = category === 'all' ? ['voice', 'room', 'model'] : [category === 'installed' ? null : category];
    for (const kind of sections) {
      const group = kind ? shown.filter((r) => r.kind === kind) : shown;
      if (category === 'all' && group.length) list.appendChild(el('div', 'market-sect', t(`market.cat.${kind}`)));
      for (const r of group) list.appendChild(card(r));
      if (kind && !SOON.has(kind) && !group.length && category !== 'all') list.appendChild(el('p', 'market-why', t(search.value ? 'market.none.search' : `market.none.${kind}`)));
    }
    if (category === 'installed' && !shown.length) list.appendChild(el('p', 'market-why', t('market.none.installed')));
    if (category === 'all') for (const kind of SOON) if (!search.value) list.appendChild(soonCard(kind));
    if (SOON.has(category)) list.appendChild(soonCard(category));
    if (category === 'all' && search.value && !shown.length) list.appendChild(el('p', 'market-why', t('market.none.search')));
    paintDetail(all);
  }

  async function refresh() {
    try { market = await zumi.market.list(); loadFailed = false; } catch { loadFailed = true; }
    paint();
  }

  zumi.market.onProgress((p) => {
    if (!p || !p.id) return;
    if (p.phase === 'done') { progress.delete(p.id); refresh(); return; } // a finished install, or a package that has just appeared
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
