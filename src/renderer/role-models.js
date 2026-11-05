// Settings > "Models by role" (T-31 board-roles, owner 09-10). Zumi's chat models: four steps of one chat reply, nothing executes work -- Plan, Do, Check, Look up -- each
// with a model + effort from the user's OWN provider (BYOK; main.js `roles:*`, role-models.js). Same chip + popover
// design as the J-05 web board's role view, fitted to the 520px Settings card as a 2x2 grid (role name + chip per
// cell): a chip equal to its default is dimmed (a changed one shows its default underneath), a dot marks a role the
// user changed, an amber "!" marks Check using Do's model while another model exists. Every role drives a real step
// (main's `wired`, T-31 zumi-roles: Plan outlines, Do replies, Check reviews, Look up searches the web), so every chip
// opens a picker. Plan / Check / Look up each carry an on/off switch (CoS decision 10-10, default on: BYOK users pay
// per call); a role switched off keeps its model, dimmed. Every label is a model NAME from the provider's list, never
// an id. Mirrors usage.js's shape (one init, owns its DOM + i18n).
import { t, onLocaleChange } from './i18n.js';

const ROLES = ['plan', 'do', 'check', 'lookup'];
const SWITCH_ROLES = ['plan', 'check', 'lookup']; // Do has no switch: it is the reply itself
const EFFORTS = ['off', 'low', 'medium', 'high'];
const LIST_MAX = 60; // rows rendered in the picker at once; typing narrows a long provider list
const POP_GAP = 6; // px between the chip and the picker
const POP_MARGIN = 8; // px the picker keeps from the window's edge; styles.css .role-pop max-height is twice this

// "deepseek/deepseek-v4-flash" -> "Deepseek V4 Flash": only for a model the provider's list did not name.
export function nameFromId(id) {
  const tail = String(id).split('/').pop().replace(/:free$/i, ' (free)');
  return tail.split(/[-_]+/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}
// Provider names read "Vendor: Model"; the chip shows the model part, the picker shows both.
function splitName(name) {
  const i = name.indexOf(': ');
  return i > 0 ? { vendor: name.slice(0, i), short: name.slice(i + 2) } : { vendor: '', short: name };
}

export function initRoleModels(zumi, $) {
  const el = { card: $('roles-card'), status: $('roles-status'), grid: $('roles-grid'), legend: $('roles-legend'), note: $('roles-note') };
  if (!el.grid || !zumi.roles) return null;
  let view = { provider: null }; // roles:get result
  let models = []; // provider list [{id, name, reasoning}]
  let modelsState = 'idle'; // idle | loading | ok | failed
  let pop = null; // { role, node, query }

  const info = (id) => {
    const m = models.find((x) => x.id === id);
    const name = m ? m.name : nameFromId(id);
    return { id, name, ...splitName(name), reasoning: m ? m.reasoning : null };
  };
  const effortLabel = (e) => t(`roles.effort.${e}`);
  const sameAsDefault = (role) => view.roles[role].model === view.defaults[role].model && view.roles[role].effort === view.defaults[role].effort;
  const note = (text, bad) => { el.note.textContent = text || ''; el.note.classList.toggle('bad', Boolean(bad)); };

  const isOn = (role) => view.roles[role].on !== false;
  // Only OpenRouter takes the web plugin (chat-brain requestBody; providers.js `webSearch`). Elsewhere Look up answers without searching,
  // so the card must not say it searches or quote OpenRouter's fee. Absent (settings fixtures) means the OpenRouter body.
  const noWeb = () => view.provider.webSearch === false;
  const descOf = (role) => t(role === 'lookup' && noWeb() ? 'roles.lookup.descNoWeb' : `roles.${role}.desc`);

  function chip(role, choice) {
    const m = info(choice.model);
    const node = document.createElement('button');
    node.className = 'role-chip';
    node.dataset.role = role;
    const tips = [`${m.name} · ${effortLabel(choice.effort)}`];
    node.type = 'button';
    node.setAttribute('aria-haspopup', 'dialog');
    node.setAttribute('aria-expanded', pop && pop.role === role ? 'true' : 'false');
    if (choice.by === 'user') { const dot = document.createElement('span'); dot.className = 'dot'; dot.setAttribute('aria-hidden', 'true'); node.appendChild(dot); tips.push(t('roles.tip.chosen')); }
    if (sameAsDefault(role)) { node.classList.add('same'); tips.push(t('roles.tip.sameAsDefault')); }
    if (!isOn(role)) tips.push(t('roles.switch.off', { role: t(`roles.${role}`) }));
    const name = document.createElement('span'); name.className = 'm'; name.textContent = m.short;
    const sep = document.createElement('span'); sep.className = 'sep'; sep.textContent = '·';
    const eff = document.createElement('span'); eff.className = 'e'; eff.textContent = effortLabel(choice.effort);
    node.append(name, sep, eff);
    if (role === 'check' && view.warnSameCheck) {
      const warn = document.createElement('span'); warn.className = 'warn'; warn.textContent = '!';
      warn.title = t('roles.tip.sameCheck');
      node.appendChild(warn);
      tips.push(t('roles.tip.sameCheck'));
    }
    node.title = tips.join('\n');
    node.setAttribute('aria-label', `${t(`roles.${role}`)}: ${tips.join('. ')}`);
    node.addEventListener('click', (ev) => { ev.stopPropagation(); if (pop && pop.role === role) closePop(); else openPop(role); });
    return node;
  }

  // Plan / Check / Look up on-off switch, in the cell head where the role is named.
  function roleSwitch(role) {
    const sw = document.createElement('input');
    sw.type = 'checkbox';
    sw.className = 'sw role-sw';
    sw.dataset.role = role;
    sw.checked = isOn(role);
    const name = t(`roles.${role}`);
    sw.setAttribute('aria-label', t('roles.switch.aria', { role: name }));
    sw.title = t(sw.checked ? 'roles.switch.on' : 'roles.switch.off', { role: name });
    sw.addEventListener('click', (ev) => ev.stopPropagation());
    sw.addEventListener('change', async () => {
      sw.disabled = true;
      let r;
      try { r = await zumi.roles.setOn(role, sw.checked); } catch { r = null; }
      if (r && r.ok) { view = r; note(''); paint(); document.dispatchEvent(new CustomEvent('zumi:roles-changed')); return; }
      sw.checked = !sw.checked;
      sw.disabled = false;
      note(t('roles.saveFailed'), true);
    });
    return sw;
  }

  function paintGrid() {
    el.grid.innerHTML = '';
    for (const role of ROLES) {
      const cell = document.createElement('div');
      cell.className = isOn(role) ? 'role-cell' : 'role-cell paused';
      cell.dataset.role = role;
      const head = document.createElement('div'); head.className = 'rh';
      const b = document.createElement('b'); b.textContent = t(`roles.${role}`);
      const d = document.createElement('span'); d.className = 'desc'; d.textContent = descOf(role);
      head.appendChild(b);
      if (SWITCH_ROLES.includes(role)) head.appendChild(roleSwitch(role));
      head.appendChild(d); // own line under the name, so the switch never squeezes it
      cell.append(head, chip(role, view.roles[role]));
      // The Defaults "row" of the wide layout, per cell: shown only where the user moved away from it.
      if (!sameAsDefault(role)) {
        const def = view.defaults[role];
        const line = document.createElement('p'); line.className = 'role-default';
        line.textContent = t('roles.defaultLine', { model: info(def.model).short, effort: effortLabel(def.effort) });
        cell.appendChild(line);
      }
      el.grid.appendChild(cell);
    }
  }

  function paintLegend() {
    el.legend.innerHTML = '';
    const item = (marker, text) => { const s = document.createElement('span'); s.className = 'li'; if (marker) s.appendChild(marker); s.append(text); return s; };
    const dot = document.createElement('span'); dot.className = 'dot';
    el.legend.append(item(dot, t('roles.legend.chosen')), item(null, t('roles.legend.dimmed')));
    if (view.warnSameCheck) {
      const warn = document.createElement('span'); warn.className = 'warn'; warn.textContent = '!';
      el.legend.appendChild(item(warn, t('roles.legend.sameCheck')));
    }
    // One model only: Check cannot differ from Do -- a soft note, not a warning.
    if (view.onlyOneModel) { const n = document.createElement('span'); n.className = 'li full'; n.textContent = t('roles.oneModelNote'); el.legend.appendChild(n); }
  }

  function paint() {
    const on = Boolean(view.provider);
    el.status.textContent = on ? t('roles.status', { provider: view.provider.label }) : t('roles.noProvider');
    el.grid.hidden = !on;
    el.legend.hidden = !on;
    if (!on) { closePop(); return; }
    paintGrid();
    paintLegend();
    if (pop) paintPop();
  }

  // ---------- popover: model picker + effort ----------
  function pickerModels(role) {
    const current = view.roles[role].model;
    const known = new Set(models.map((m) => m.id));
    // Models already in use stay pickable even when the provider list could not be loaded (or dropped them).
    const extra = [current, view.defaults[role].model, ...ROLES.map((r) => view.roles[r].model)].filter((id, i, a) => !known.has(id) && a.indexOf(id) === i);
    const all = [...models.map((m) => info(m.id)), ...extra.map(info)];
    const q = (pop.query || '').trim().toLowerCase();
    const hits = q ? all.filter((m) => m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q)) : all;
    // Ranked by the choice the popover OPENED with, so a click never makes the list jump under the pointer.
    const rank = (m) => (m.id === pop.openedWith ? 0 : m.id === view.defaults[role].model ? 1 : 2);
    hits.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
    return { shown: hits.slice(0, LIST_MAX), total: hits.length };
  }

  async function choose(role, patch) {
    const cur = view.roles[role];
    const r = await zumi.roles.set(role, { model: patch.model || cur.model, effort: patch.effort || cur.effort });
    if (r && r.ok) { view = r; note(''); paint(); document.dispatchEvent(new CustomEvent('zumi:roles-changed')); return; }
    note(t('roles.saveFailed'), true);
  }

  function paintPop() {
    const role = pop.role;
    const choice = view.roles[role];
    const box = pop.node;
    box.innerHTML = '';
    box.setAttribute('aria-label', `${t(`roles.${role}`)} · ${descOf(role)}`);
    const head = document.createElement('div'); head.className = 'pop-head';
    const hb = document.createElement('b'); hb.textContent = t(`roles.${role}`);
    const hs = document.createElement('span'); hs.className = 'muted'; hs.textContent = descOf(role);
    head.append(hb, hs);
    const use = document.createElement('p'); use.className = 'pop-hint';
    use.textContent = role === 'lookup' && noWeb() ? t('roles.usedFor.lookupNoWeb', { provider: view.provider.label }) : t(`roles.usedFor.${view.wired[role]}`); // every role is wired (main's `wired`)

    const ml = document.createElement('div'); ml.className = 'pop-label'; ml.textContent = t('roles.model');
    const search = document.createElement('input');
    search.type = 'search'; search.placeholder = t('roles.search'); search.value = pop.query || '';
    search.setAttribute('aria-label', t('roles.search'));
    const list = document.createElement('div'); list.className = 'pop-list'; list.setAttribute('role', 'listbox');
    const fillList = () => {
      list.innerHTML = '';
      const { shown, total } = pickerModels(role);
      for (const m of shown) {
        const b = document.createElement('button');
        b.type = 'button'; b.setAttribute('role', 'option'); b.setAttribute('aria-selected', m.id === choice.model ? 'true' : 'false');
        const nm = document.createElement('span'); nm.className = 'n'; nm.textContent = m.short;
        b.appendChild(nm);
        if (m.vendor) { const v = document.createElement('span'); v.className = 'v'; v.textContent = m.vendor; b.appendChild(v); }
        if (m.id === view.defaults[role].model) { const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = t('roles.defaultTag'); b.appendChild(tag); }
        b.title = m.name;
        b.addEventListener('click', () => choose(role, { model: m.id }));
        list.appendChild(b);
      }
      if (!shown.length) { const p = document.createElement('p'); p.className = 'pop-empty'; p.textContent = t('roles.noMatch'); list.appendChild(p); }
      if (total > shown.length) { const p = document.createElement('p'); p.className = 'pop-empty'; p.textContent = t('roles.moreModels', { n: total - shown.length }); list.appendChild(p); }
    };
    fillList();
    search.addEventListener('input', () => { pop.query = search.value; fillList(); });
    const listHint = document.createElement('p'); listHint.className = 'pop-hint';
    listHint.textContent = modelsState === 'loading' ? t('roles.modelsLoading') : modelsState === 'failed' ? t('roles.modelsFailed', { provider: view.provider.label }) : '';
    listHint.hidden = !listHint.textContent;

    const el2 = document.createElement('div'); el2.className = 'pop-label'; el2.textContent = t('roles.effort');
    const seg = document.createElement('div'); seg.className = 'lang-switch'; seg.setAttribute('role', 'radiogroup'); seg.setAttribute('aria-label', t('roles.effort'));
    for (const e of EFFORTS) {
      const b = document.createElement('button');
      b.type = 'button'; b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', e === choice.effort ? 'true' : 'false');
      b.textContent = effortLabel(e);
      b.title = t(`roles.effort.${e}.tip`);
      b.addEventListener('click', () => choose(role, { effort: e }));
      seg.appendChild(b);
    }
    const effHint = document.createElement('p'); effHint.className = 'pop-hint';
    // chat-brain sends no effort field to a provider without `sendsEffort`, whatever the model could do.
    effHint.textContent = view.provider.effort === false ? t('roles.noEffortProvider', { provider: view.provider.label }) : info(choice.model).reasoning === false ? t('roles.noEffort') : '';
    effHint.hidden = !effHint.textContent;

    const foot = document.createElement('div'); foot.className = 'pop-foot';
    const reset = document.createElement('button'); reset.type = 'button'; reset.className = 'ghost slim'; reset.textContent = t('roles.useDefault');
    reset.disabled = choice.by !== 'user';
    reset.addEventListener('click', async () => {
      const r = await zumi.roles.reset(role);
      if (r && r.ok) { view = r; note(''); closePop(); paint(); document.dispatchEvent(new CustomEvent('zumi:roles-changed')); } else note(t('roles.saveFailed'), true);
    });
    const done = document.createElement('button'); done.type = 'button'; done.className = 'primary'; done.textContent = t('roles.done');
    done.addEventListener('click', () => closePop());
    foot.append(reset, done);

    box.append(head, use, ml, search, list, listHint, el2, seg, effHint, foot);
    place();
  }

  // Viewport coordinates: the picker is in the top layer (openPop). Under the chip when it fits, else above it, else pinned inside the window;
  // CSS caps it at the window's height and scrolls it from there.
  function place() {
    const anchor = el.grid.querySelector(`button.role-chip[data-role="${pop.role}"]`);
    if (!anchor) return;
    const a = anchor.getBoundingClientRect();
    const w = pop.node.offsetWidth;
    const h = pop.node.offsetHeight;
    const below = a.bottom + POP_GAP;
    const above = a.top - POP_GAP - h;
    const fitsBelow = below + h <= window.innerHeight - POP_MARGIN;
    const top = fitsBelow ? below : above >= POP_MARGIN ? above : Math.max(POP_MARGIN, window.innerHeight - POP_MARGIN - h);
    pop.node.style.left = `${Math.max(POP_MARGIN, Math.min(a.left, window.innerWidth - w - POP_MARGIN))}px`;
    pop.node.style.top = `${top}px`;
  }
  // The top layer does not scroll or hide with the card, so the picker follows its chip and goes when the chip does.
  function follow(ev) {
    if (!pop || pop.node.contains(ev.target)) return; // the picker's own list scrolling
    const scroller = el.card.closest('.settings');
    const anchor = el.grid.querySelector(`button.role-chip[data-role="${pop.role}"]`);
    if (scroller && anchor) {
      const box = scroller.getBoundingClientRect();
      const a = anchor.getBoundingClientRect();
      if (a.bottom < box.top || a.top > box.bottom) { closePop(); return; }
    }
    place();
  }

  function openPop(role) {
    closePop();
    const node = document.createElement('div');
    node.className = 'role-pop';
    node.setAttribute('role', 'dialog');
    node.addEventListener('click', (ev) => ev.stopPropagation());
    // Top layer: every .settings .card is its own stacking context (theme-a.css, isolation) and .settings clips, so no z-index inside a card can
    // reach above the next card. Staying in the card's DOM keeps the .settings rules. Popover "manual": our click and Escape handlers close it.
    node.popover = 'manual';
    el.card.appendChild(node);
    node.showPopover();
    // A hidden card (tab or view switch, by keyboard too) reports size 0; any other change of size moves the chip.
    const watch = new ResizeObserver(() => { if (!pop) return; if (el.card.getClientRects().length) place(); else closePop(); });
    watch.observe(el.card);
    pop = { role, node, query: '', openedWith: view.roles[role].model, watch };
    paint();
    loadModels();
    const s = node.querySelector('input[type="search"]');
    if (s) s.focus();
  }
  function closePop() {
    if (!pop) return;
    pop.watch.disconnect();
    pop.node.remove();
    const role = pop.role;
    pop = null;
    const a = el.grid.querySelector(`button.role-chip[data-role="${role}"]`);
    if (a) a.setAttribute('aria-expanded', 'false');
  }
  document.addEventListener('click', () => closePop());
  document.addEventListener('scroll', follow, true); // capture: scroll does not bubble from the .settings box
  window.addEventListener('resize', () => { if (pop) place(); });
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && pop) closePop(); });

  // The provider list is fetched once per app run (main caches it too); a failure keeps the in-use models pickable.
  async function loadModels() {
    if (modelsState === 'loading' || modelsState === 'ok') return;
    modelsState = 'loading';
    if (pop) paintPop();
    let r;
    try { r = await zumi.roles.models(); } catch { r = { ok: false, models: [] }; }
    models = r && r.ok && Array.isArray(r.models) ? r.models : [];
    modelsState = r && r.ok ? 'ok' : 'failed';
    paint(); // chip names switch from id-derived to the provider's own names
    document.dispatchEvent(new CustomEvent('zumi:model-names')); // the Usage card shows the same names
  }

  async function refresh() {
    try { view = await zumi.roles.get(); } catch { view = { provider: null }; }
    if (!view || !view.provider || !view.roles) view = { provider: null };
    paint();
    if (view.provider) loadModels();
    return view;
  }

  onLocaleChange(() => paint());
  // A key saved or cleared in Settings > AI brain makes the provider appear or go: re-read the view.
  document.addEventListener('zumi:brain-key-changed', () => { closePop(); refresh(); });
  // A model's user-facing name for other Settings cards (Usage): the provider's own name once its list is loaded.
  return { refresh, openPop: (role) => openPop(role), closePop, modelName: (id) => info(id).short };
}
