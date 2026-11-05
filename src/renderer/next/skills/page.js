// T-31 slice 2: the Skills page and header (SPEC-skills.md N4 / N6). Reflective only: it reads, it never gates a feature.
//
// Signals come from what the renderer already has, no new IPC (SPEC "Contract change"):
//   usage.summary  -> turns / Plan / Check / Look up calls per day      (zumi.usage.summary)
//   roles.get      -> which helper is switched off now (node "resting")  (zumi.roles.get)
//   gcache.load    -> gesture-cache size                                 (zumi.gcache.load)
//   touch events   -> engine 'reaction' poke and 'state' pat             (app.js forwards them to touch())
//   window.zumi.memory -> feature-detect, shows the Mind branch only where it exists (AC-S6)
// All of them fold into the progress store (store.js), which keeps high-water counts so no source going down
// (30-day window, cache cleared on an avatar change, a role off) can lower a level.
import { t, onLocaleChange, getLocale } from '../../i18n.js';
import { nameFromId } from '../../role-models.js';
import { derive, closenessOf } from './derive.js';
import { createProgressStore, isReadOnlyRun } from './store.js';
import { MAX_LVL, NODES } from './catalog.js';
import { PLACEHOLDER as P } from './constants.js';

// Padlock on a locked node (concept A-2): static markup, no data.
const LOCK_SVG = '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';
const ROLE_KEYS = ['plan', 'check', 'lookup'];

// roles.get -> { plan:{on,model}, ... } | null. null = no provider yet (nothing can be "resting").
export function rolesOf(view) {
  if (!view || !view.provider || !view.roles || typeof view.roles !== 'object') return null;
  const out = {};
  for (const k of ROLE_KEYS) { const r = view.roles[k]; out[k] = { on: !(r && r.on === false), model: r && typeof r.model === 'string' ? r.model : null }; }
  return out;
}

// gcache.load() text -> entry count. Anything unreadable is 0 (the store only ever keeps the high-water mark).
export function gestureCount(text) {
  let j = null;
  try { j = JSON.parse(text); } catch { return 0; } // not JSON = no cache yet: a missing signal, not an error to show
  return j && Array.isArray(j.entries) ? j.entries.length : 0;
}

// The "Runs on <model name>" line of a crew node. Model NAMES only, never an id (AC-S5): `modelName` is the provider's
// own name for the id (role-models.js) and falls back to a readable name derived from it.
export function modelLine(node, roles, modelName = nameFromId) {
  const r = node.role && roles ? roles[node.role] : null;
  return r && r.model ? t('skills.detail.model', { name: modelName(r.model) }) : '';
}

export const levelPct = (r) => (r.to > r.from ? Math.max(0, Math.min(100, Math.round(((r.xp - r.from) / (r.to - r.from)) * 100))) : 0);
// Lit ring segments out of 30, so the ring shows whole segments (--p is the lit share of the ring).
// Ten XP segments, each 'on', 'half' or '' (nearest half segment), as the concept A-2 bar.
export const xpSegments = (pct, n = 10) => { const r = Math.round((Math.max(0, Math.min(100, pct)) / 100) * n * 2) / 2; return Array.from({ length: n }, (_, i) => (i + 1 <= r ? 'on' : i + 0.5 === r ? 'half' : '')); };
export const ringLit = (pct, seg = 30) => Math.round((Math.max(0, Math.min(100, pct)) / 100) * seg);

// Share of the way from the previous threshold to the next one, for the detail bar.
function nodePct(n) {
  if (n.next === null) return 100;
  const prev = n.lvl > 0 ? NODES.find((x) => x.id === n.id).thresholds[n.lvl - 1] : 0;
  return Math.max(0, Math.min(100, Math.round(((n.count - prev) / Math.max(1, n.next - prev)) * 100)));
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

export function initSkills({ zumi, $, info, modelName = nameFromId, storage, onView = () => {} } = {}) {
  const headRoot = $('next-skills-head'), treeRoot = $('next-skills-tree'); // the two cards next/boot.js put over the stage
  if (!headRoot || !treeRoot || !zumi) return null;
  let ls = storage;
  if (ls === undefined) { try { ls = window.localStorage; } catch { ls = null; } } // storage blocked: the page works in memory
  const readOnly = isReadOnlyRun(info);
  const store = createProgressStore({ storage: ls, readOnly });
  const memory = Boolean(window.zumi && window.zumi.memory);
  let roles = null, view = null, hdr = null, selected = null;

  // One sync = three existing reads, folded into the store. A read that fails or is absent is just a missing signal.
  async function sync() {
    const read = async (fn) => { try { return await fn(); } catch { return null; } };
    const [rv, us, gc] = await Promise.all([
      read(() => zumi.roles && zumi.roles.get()),
      read(() => zumi.usage && zumi.usage.summary()),
      read(() => zumi.gcache && zumi.gcache.load()),
    ]);
    roles = rolesOf(rv);
    store.mergeUsage(us);
    if (gc != null) store.setGestures(gestureCount(gc));
    recompute();
    return view;
  }
  // Store only, no IPC: the cards can always paint from what is already kept, before any read answers.
  function recompute() {
    view = derive({ ...store.totals(), roles, memory, held: store.held() });
    hdr = store.recordView(view);
    onView(view);
  }

  function nodeButton(n) {
    const item = el('div', 'sk-item');
    if (n.parent) { const link = el('i', `sk-link ${n.status === 'locked' ? 'off' : 'on'}`); link.setAttribute('aria-hidden', 'true'); item.appendChild(link); }
    const b = el('button', `sk ${n.status}${n.resting ? ' rest' : ''}${n.id === selected ? ' sel' : ''}`);
    b.type = 'button';
    b.dataset.node = n.id;
    b.setAttribute('aria-pressed', String(n.id === selected));
    const name = t(n.label);
    const lv = n.status === 'locked' ? t('skills.status.locked') : (n.lvl >= 1 ? t('skills.lvOf', { lvl: n.lvl, max: MAX_LVL }) + (n.resting ? ` · ${t('skills.status.resting')}` : '') : t('skills.status.available'));
    const nm = el('div', 'n', name);
    if (n.status === 'locked') { const lock = el('span', 'sk-lock'); lock.setAttribute('aria-hidden', 'true'); lock.innerHTML = LOCK_SVG; nm.appendChild(lock); }
    b.append(nm, el('div', 'lv', lv));
    const pips = el('div', 'pips');
    for (let i = 0; i < MAX_LVL; i++) pips.appendChild(el('i', i < n.lvl ? 'on' : ''));
    b.appendChild(pips);
    b.addEventListener('click', () => { selected = n.id; paint(); });
    item.appendChild(b);
    return item;
  }

  function detail(n) {
    const box = el('div', 'sk-detail');
    const head = el('div', 'sk-dhead');
    head.append(el('span', 'dot'), el('b', null, t(n.label)));
    if (n.status === 'locked') head.appendChild(el('span', 'sk-chip dim', t('skills.status.locked')));
    else if (n.lvl >= 1) head.appendChild(el('span', 'sk-chip', t('skills.lvOf', { lvl: n.lvl, max: MAX_LVL })));
    else head.appendChild(el('span', 'sk-chip dim', t('skills.status.available')));
    if (n.resting) head.appendChild(el('span', 'sk-chip q', t('skills.status.resting')));
    box.appendChild(head);
    box.appendChild(el('div', 'sk-how', t(n.how)));
    const parent = view.nodes.find((x) => x.id === n.parent);
    if (n.status === 'locked' && parent) box.appendChild(el('div', 'sk-how', t('skills.detail.locked', { parent: t(parent.label) })));
    else box.appendChild(el('div', 'sk-how', n.next === null ? t('skills.detail.top', { count: n.count }) : t('skills.detail.progress', { count: n.count, next: n.next })));
    if (n.resting) box.appendChild(el('div', 'sk-how', t('skills.detail.resting')));
    const ml = modelLine(n, roles, modelName);
    if (ml) box.appendChild(el('div', 'sk-how mono', ml));
    const bar = el('div', 'scan'); bar.setAttribute('aria-hidden', 'true');
    const u = document.createElement('u'); u.style.width = `${nodePct(n)}%`; bar.append(u, document.createElement('i'));
    box.appendChild(bar);
    return box;
  }

  function headerFrame() {
    const f = document.createDocumentFragment(); // the card itself (.frame) is made by boot.js
    const head = el('div', 'head'); head.append(el('span', 'tag', t('skills.companion').toUpperCase()), el('span', 'sp'), el('span', 'meta', t('skills.portraitAlt')));
    f.appendChild(head);
    const top = el('div', 'sk-top');
    const portrait = el('div', 'sk-portrait');
    portrait.setAttribute('role', 'img'); portrait.setAttribute('aria-label', t('skills.portraitAlt'));
    portrait.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="10" r="6"/><path d="M5 21c1.5-3.5 4-5 7-5s5.5 1.5 7 5"/><circle cx="10" cy="9.5" r=".9" class="fill"/><circle cx="14" cy="9.5" r=".9" class="fill"/></svg>'; // static glyph, no data
    const close = closenessOf(store.totals().points);
    const tierName = t(`skills.tier.${Math.min(close.tier, P.CLOSE_TIERS.length)}`); // placeholder names until owner next-ver-q (3)
    const lvBox = el('div', 'sk-lvbox');
    lvBox.append(el('div', 'sk-lv', t('skills.lv', { n: hdr.level })), el('div', 'sk-tierline', `· ${tierName}`), el('div', 'mono mute sk-xp', t('skills.xp', { xp: hdr.xp, to: hdr.to })));
    top.append(portrait, lvBox);
    f.appendChild(top);
    const xpBar = el('div', 'sk-segbar'); xpBar.setAttribute('role', 'progressbar'); xpBar.setAttribute('aria-valuenow', String(levelPct(hdr))); xpBar.setAttribute('aria-valuemin', '0'); xpBar.setAttribute('aria-valuemax', '100');
    for (const seg of xpSegments(levelPct(hdr))) xpBar.appendChild(el('i', seg));
    f.append(xpBar, el('div', 'gline'));
    const row = el('div', 'sk-close');
    const wrap = el('div', 'ring-wrap');
    const ring = el('div', 'ring'); ring.style.setProperty('--seg', '30'); ring.style.setProperty('--p', String((ringLit(close.pct) / 30) * 100));
    ring.setAttribute('role', 'img'); ring.setAttribute('aria-label', `${t('skills.closeness')} ${close.pct}%`);
    const txt = el('div', 'ring-txt'); txt.append(el('b', null, `${close.pct}%`), el('span', null, t('skills.closeness')));
    wrap.append(ring, txt);
    const since = store.since();
    let date = t('skills.sinceNone');
    if (since) { const [y, m, d] = since.split('-').map(Number); date = new Date(y, m - 1, d).toLocaleDateString(getLocale() === 'zh' ? 'zh-CN' : getLocale(), { day: 'numeric', month: 'short', year: 'numeric' }); }
    const side = el('div', 'sk-since');
    side.append(el('div', 'mute sk-small', t('skills.since')), el('div', 'sk-date', date), el('span', 'sk-chip', t('skills.daysUsed', { n: store.totals().days })));
    row.append(wrap, side);
    f.append(row, el('div', 'gline'));
    // The line under the ring (concept A-2): only what the code knows. The tier comes from closeness points alone (derive.js), so the line
    // says how many points are missing (distance in CLOSE_TIERS, a PLACEHOLDER until next-ver-q 3); the bar is the same share.
    f.appendChild(el('div', 'mute sk-small sk-next', close.toNext === null ? t('skills.topTier') : t('skills.nextTierPts', { n: close.toNext })));
    const nb = el('div', 'scan sk-nextbar'); nb.setAttribute('aria-hidden', 'true');
    const nu = document.createElement('u'); nu.style.width = `${close.pct}%`; nb.append(nu, document.createElement('i'));
    f.appendChild(nb);
    return f;
  }

  function treeFrame() {
    const f = document.createDocumentFragment();
    const head = el('div', 'head');
    head.append(el('span', 'tag', t('nav.skills').toUpperCase()), el('span', null, t('skills.tag')), el('span', 'sp'), el('span', 'meta', t('skills.count', { total: view.total, learned: view.learned })));
    f.appendChild(head);
    const tree = el('div', 'sk-tree');
    for (const b of view.branches) {
      const col = el('div', 'sk-branch');
      col.appendChild(el('div', 'bl', t(b.label)));
      if (b.nodes.length === 0) col.appendChild(el('div', 'sk-empty mute', t('skills.mind.soon')));
      for (const n of b.nodes) col.appendChild(nodeButton(n));
      tree.appendChild(col);
    }
    // The Zumi root above the branches (concept A-2): hub, stem, a bus line over the branch centres, a stub into each branch label.
    const wrap = el('div', 'sk-treewrap');
    wrap.style.setProperty('--cols', String(view.branches.length));
    const hub = el('div', 'sk-hub', t('skills.portraitAlt'));
    wrap.append(hub, el('i', 'sk-stem'), el('div', 'sk-bus'), tree);
    f.append(wrap, el('div', 'gline'), detail(view.nodes.find((x) => x.id === selected) || view.nodes[0]));
    return f;
  }

  function paint() {
    if (!view || !hdr) return;
    if (!view.nodes.some((n) => n.id === selected)) { const orch = view.nodes.find((n) => n.id === 'crew.orchestrator'); selected = orch && orch.status === 'learned' ? orch.id : view.nodes[0].id; }
    headRoot.replaceChildren(headerFrame()); treeRoot.replaceChildren(treeFrame());
  }

  // Paint from the store first, then again once the three reads have been folded in: a slow IPC never leaves the cards empty.
  async function refresh() { recompute(); paint(); await sync(); paint(); }
  const tab = document.querySelector('.tab[data-next="skills"]'); // added by next/boot.js, which also owns the switch to the page
  if (tab) tab.addEventListener('click', refresh);
  onLocaleChange(paint);
  document.addEventListener('zumi:roles-changed', () => { if (tab && tab.classList.contains('active')) refresh(); });
  window.addEventListener('pagehide', () => store.flush());
  // A quiet sync at start-up keeps the 30-day usage window from outrunning the store when the page is not opened for
  // weeks. Read-only runs (self-test, demo, shots, probe) skip it: they touch nothing.
  recompute(); paint();
  if (!readOnly) sync().then(paint).catch((e) => console.error('skills sync', e));
  return { touch: () => store.addTouch(), refresh, flush: () => store.flush() };
}
