// The "Guide" panel of the key step (T-31, owner 05-11): three cards -- OpenCode (recommended), OpenRouter, Google AI Studio --
// each with what it is, a Free/Paid badge, the model Zumi uses, numbered steps with the official URL, and a paste box.
// Choosing a card selects mode + provider (free-key-routes.js chooseRoute); a pasted key goes through brainKey.save, whose
// provider list-models call validates it (no generation). The key field is emptied the moment Save is pressed and no key text
// is ever put in the DOM. Opened from the first-run key card and from Settings > AI & Usage; one panel, built once, repainted on
// a language change. All words come from i18n (freeKey.*); the facts (model, URL, cost) come from the route table.
import { t, onLocaleChange } from './i18n.js';
import routes from '../main/free-key-routes.js';

const { ROUTES, STEP_COUNT, chooseRoute, saveRouteKey } = routes;

export function initFreeKeyGuide({ zumi, doc = document, $ = () => null } = {}) {
  const make = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const button = (cls, act) => { const b = make('button', cls); b.type = 'button'; b.setAttribute('type', 'button'); b.dataset.act = act; return b; };

  const panel = make('section', 'fk-panel');
  panel.id = 'free-key-panel';
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  const sheet = make('div', 'fk-sheet frame');
  const head = make('div', 'fk-head');
  const title = make('h2');
  const closeBtn = button('ghost', 'close');
  head.append(title, closeBtn);
  const intro = make('p', 'muted');
  const list = make('div', 'fk-cards');
  // Compact list in two groups (Free / Paid); each route is a row that expands to its steps, so six+ routes fit the window.
  const groupTitles = {};
  const groupBoxes = {};
  for (const g of ['free', 'paid']) {
    groupTitles[g] = make('h3', 'fk-group');
    groupBoxes[g] = make('div', 'fk-group-list');
    list.append(groupTitles[g], groupBoxes[g]);
  }
  sheet.append(head, intro, list);
  panel.appendChild(sheet);
  (doc.body || $('stage')).appendChild(panel);

  const cards = ROUTES.map((r) => buildCard(r));
  ROUTES.forEach((r, i) => groupBoxes[r.cost].appendChild(cards[i].root));

  function buildCard(r) {
    const root = make('article', `fk-card${r.recommended ? ' fk-recommended' : ''}`);
    const top = button('fk-toggle', 'toggle');
    const name = make('span', 'fk-name');
    const badges = make('span', 'fk-badges');
    const recBadge = make('span', 'fk-badge fk-badge-rec');
    const costBadge = make('span', `fk-badge fk-badge-${r.cost}`);
    if (r.recommended) badges.appendChild(recBadge);
    badges.appendChild(costBadge); // for the best-value route its text is "Best value · Paid"
    top.append(name, badges);
    const body = make('div', 'fk-body');
    const what = make('p');
    const model = make('p', 'fk-model');
    const why = r.recommended || r.bestValue ? make('p', 'fk-why') : null;
    const limits = make('p', 'fk-url');
    const note = make('p', 'note');
    const howHead = make('h4');
    const steps = make('ol', 'guide');
    const items = Array.from({ length: STEP_COUNT }, () => steps.appendChild(make('li')));
    const url = make('p', 'fk-url', r.signupUrl);
    const choose = button('primary', 'choose');
    const openPage = button('ghost', 'openPage');
    const row = make('div', 'fk-row');
    row.append(choose, openPage);
    const field = make('input', 'fk-key');
    field.setAttribute('type', 'password');
    field.setAttribute('autocomplete', 'off');
    field.setAttribute('spellcheck', 'false');
    field.dataset.field = 'key';
    const save = button('primary', 'save');
    const keyRow = make('div', 'fk-row');
    keyRow.append(field, save);
    const line = make('p', 'note');
    line.dataset.role = 'line';
    body.append(what, model);
    if (why) body.appendChild(why);
    body.append(note, limits, howHead, steps, url, row, keyRow, line);
    root.append(top, body);
    let expanded = r.recommended; // the recommended route starts open
    const showBody = () => { body.hidden = !expanded; top.setAttribute('aria-expanded', String(expanded)); };
    top.addEventListener('click', () => { expanded = !expanded; showBody(); });
    showBody();

    let state = { chosen: false, code: null }; // code: a freeKey.line.* suffix or 'chosen' | 'chooseFailed'
    const paint = () => {
      name.textContent = t(`freeKey.${r.id}.name`);
      recBadge.textContent = t('freeKey.recommended');
      costBadge.textContent = r.bestValue ? t('freeKey.badge.bestValue') : t(`freeKey.${r.cost}`);
      what.textContent = t(`freeKey.${r.id}.what`);
      model.textContent = t('freeKey.model', { model: r.model });
      if (why) why.textContent = t(r.bestValue ? 'freeKey.why' : 'freeKey.whyFree');
      limits.textContent = t('freeKey.limits', { url: r.limitsUrl });
      note.textContent = t(`freeKey.${r.id}.note`);
      howHead.textContent = t('freeKey.how');
      items.forEach((li, i) => { li.textContent = t(`freeKey.${r.id}.s${i + 1}`); });
      choose.textContent = t('freeKey.choose');
      openPage.textContent = t('freeKey.openPage');
      field.setAttribute('aria-label', t('freeKey.pasteLabel'));
      field.setAttribute('placeholder', t('freeKey.pasteLabel'));
      save.textContent = t('freeKey.save');
      line.textContent = state.code ? t(state.code === 'chosen' || state.code === 'chooseFailed' ? `freeKey.${state.code}` : `freeKey.line.${state.code}`) : '';
      line.className = `note${state.code === 'works' || state.code === 'chosen' ? ' ok' : state.code && !['unverified', 'checking'].includes(state.code) ? ' bad' : ''}`;
    };
    const busy = (on) => { choose.disabled = on; save.disabled = on; field.disabled = on; };
    choose.addEventListener('click', async () => {
      busy(true);
      let r1;
      try { r1 = await chooseRoute(zumi, r.id); } catch { r1 = { ok: false }; }
      busy(false);
      state = { chosen: r1.ok, code: r1.ok ? 'chosen' : 'chooseFailed' };
      if (r1.ok) { try { doc.dispatchEvent(new CustomEvent('zumi:brain-key-changed')); } catch { /* stub DOM / no CustomEvent */ } field.focus(); }
      paint();
    });
    openPage.addEventListener('click', async () => {
      // openKeyPage opens the ACTIVE provider's key page: select this route first so the page matches the card.
      if (!state.chosen) { await chooseRoute(zumi, r.id).then((x) => { state = { chosen: x.ok, code: x.ok ? 'chosen' : 'chooseFailed' }; paint(); }).catch(() => {}); }
      if (zumi.ai && zumi.ai.openKeyPage) zumi.ai.openKeyPage();
    });
    save.addEventListener('click', async () => {
      const raw = field.value;
      field.value = ''; // emptied before anything else, whatever the result
      if (!state.chosen) {
        const r1 = await chooseRoute(zumi, r.id).catch(() => ({ ok: false }));
        state = { chosen: r1.ok, code: r1.ok ? 'chosen' : 'chooseFailed' };
        if (!r1.ok) { paint(); return; }
      }
      state.code = 'checking';
      line.textContent = t('freeKey.line.checking');
      busy(true);
      const out = await saveRouteKey(zumi, raw);
      busy(false);
      state.code = out.line;
      if (out.ok) { try { doc.dispatchEvent(new CustomEvent('zumi:brain-key-changed')); } catch { /* stub DOM */ } }
      paint();
    });
    return { root, paint, open: () => { expanded = true; showBody(); } };
  }

  const repaint = () => {
    title.textContent = t('freeKey.title');
    intro.textContent = t('freeKey.intro');
    closeBtn.textContent = t('freeKey.close');
    for (const g of ['free', 'paid']) groupTitles[g].textContent = t(`freeKey.group.${g}`);
    for (const c of cards) c.paint();
  };
  const open = () => { repaint(); panel.hidden = false; };
  const close = () => { panel.hidden = true; };
  closeBtn.addEventListener('click', close);
  panel.addEventListener('click', (e) => { if (e && e.target === panel) close(); });
  if (doc.addEventListener) doc.addEventListener('keydown', (e) => { if (e && e.key === 'Escape' && !panel.hidden) close(); });
  onLocaleChange(() => { if (!panel.hidden) repaint(); });
  repaint();
  return { open, close, repaint, panel };
}
