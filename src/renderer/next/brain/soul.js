// Soul (T-31 alpha.12, PLAN-ZUMI-WATCH v2 C.1-C.2): Brain > Soul and the first-run cards. Host API (agent-core.mjs, both hosts):
// zumi.soul.get() -> { soul, onboarded, canUndo, history, templates, defaults, limits, preview }, save(input) -> { ok, soul } |
// { ok:false, error, field }, undo() -> { ok, soul } | { ok:false, error }. Every decision (limits, key-shaped refusal, history) is the host's;
// this file only shows it. All text through textContent; template labels/previews are data from soul-templates.json.
//
// Brain > Soul opens read-only with an Edit button (an open draft stays until Save or Cancel). Save asks first (the warning modal, plan C.2): "changing her soul is like resetting
// Zumi"; Keep / Change. Undo restores the previous version without a warning. A template applied from this tab gets the same warning.
// First run (no `soul` key in settings): two cards over the room, skippable (skip = the Friendly default), then she says one line.
// R8 (owner 04-11): card 1 also sets the app language (settings.json uiLang, applied at once), card 2 the user's name (empty unless typed;
// onboard.userDefault is only its placeholder, review R8), the address word (pick list + free text) and the read-aloud switch
// (settings.json speakTypedWhenMicOff, the Settings > Workflow switch). Done saves them in those existing stores; Skip only the default soul.
import { t, getLocale, setAddress, setLocale, LOCALES, TABLES } from '../../i18n.js';
import { el } from './dom.js';

const FIELDS = ['name', 'ownerName', 'selfWord', 'userWord', 'role', 'style', 'persona'];
const LANGS = ['auto', 'en', 'vi', 'zh'];

/** True where the host has the soul API. */
export function soulAvailable() {
  const s = typeof window !== 'undefined' && window.zumi && window.zumi.soul;
  return Boolean(s && typeof s.get === 'function' && typeof s.save === 'function');
}

/** Early at launch: Zumi's fixed lines in the page use the soul's words. A host without the API keeps the public default. */
export function loadSoulAddress() {
  if (!soulAvailable()) return;
  window.zumi.soul.get().then((d) => { if (validView(d)) setAddress(d.soul); }).catch((e) => console.error('soul: address not loaded', e));
}

const loc = (o) => (o && (o[getLocale()] || o.en)) || '';
/** A soul.get answer of the right shape (an older host or a test stub answers something else). */
const validView = (d) => Boolean(d && typeof d === 'object' && d.soul && typeof d.soul === 'object' && Array.isArray(d.templates) && typeof d.onboarded === 'boolean');
const errText = (r) => t(`soul.err.${(r && r.error) || 'failed'}`, { field: r && r.field ? t(`soul.field.${r.field}`) : '' });

/** The warning modal (plan C.2). Resolves true for "Change", false for "Keep as is" / Escape. */
export function confirmSoulChange(mount) {
  return new Promise((resolve) => {
    const back = el('div', 'nb-soul-modal');
    back.setAttribute('role', 'dialog'); back.setAttribute('aria-modal', 'true'); back.setAttribute('aria-labelledby', 'nb-soul-warn-h');
    const box = el('div', 'nb-soul-modal-box');
    const h = el('h3', 'nb-note-h', t('soul.warn.title')); h.id = 'nb-soul-warn-h';
    const keep = el('button', 'nb-toggle', t('soul.warn.keep')); keep.type = 'button';
    const change = el('button', 'nb-open', t('soul.warn.change')); change.type = 'button';
    const done = (v) => { document.removeEventListener('keydown', onKey, true); back.remove(); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); done(false); } };
    keep.addEventListener('click', () => done(false));
    change.addEventListener('click', () => done(true));
    document.addEventListener('keydown', onKey, true);
    const btns = el('div', 'nb-soul-btns'); btns.append(keep, change);
    box.append(h, el('p', 'nb-text', t('soul.warn.body')), el('p', 'nb-mute', t('soul.warn.scope')), btns);
    back.appendChild(box);
    (mount || document.body).appendChild(back);
    keep.focus();
  });
}

const TAB_STATE = new WeakMap();

/** Brain > Soul. `host` is the Brain card body. */
export function renderSoulTab(host) {
  host.textContent = '';
  if (!soulAvailable()) { host.appendChild(el('p', 'nb-empty', t('soul.unavailable'))); return; }
  const api = window.zumi.soul;
  // Per host, not per call: a saved word repaints through Brain's locale listener, which re-enters here mid-save, and that must not blank the
  // status line or a draft. A re-entry with nothing in flight (the tab reopened, the language changed) starts without the old status.
  let ui = TAB_STATE.get(host);
  if (!ui) { ui = { data: null, editing: false, draft: null, status: '', busy: false }; TAB_STATE.set(host, ui); } else if (!ui.busy) ui.status = '';

  const paint = () => {
    host.textContent = '';
    const d = ui.data;
    if (!d) { host.appendChild(el('p', 'nb-empty', t('brain.lib.loading'))); return; }
    const wrap = el('div', 'nb-soul');
    wrap.appendChild(el('p', 'nb-mute', t('soul.readonly.note')));
    const s = ui.editing ? ui.draft : d.soul;
    const form = el('div', 'nb-soul-form');
    const fitLater = []; // the text boxes grow to their text once in the page, so a value is never cut
    for (const k of FIELDS) {
      const row = el('label', 'nb-soul-row');
      row.appendChild(el('span', 'nb-soul-k', t(`soul.field.${k}`)));
      const multi = k === 'persona' || k === 'style';
      const input = el(multi ? 'textarea' : 'input', 'nb-filter nb-soul-v');
      if (!multi) input.type = 'text';
      if (multi) input.rows = k === 'persona' ? 4 : 2;
      input.value = s[k] || '';
      input.maxLength = (d.limits && d.limits[k]) || 200;
      input.readOnly = !ui.editing;
      input.dataset.field = k;
      input.addEventListener('input', () => { ui.draft[k] = input.value; });
      row.appendChild(input);
      form.appendChild(row);
      if (multi) fitLater.push(input);
    }
    const langRow = el('label', 'nb-soul-row');
    langRow.appendChild(el('span', 'nb-soul-k', t('soul.field.replyLang')));
    const sel = el('select', 'nb-filter nb-soul-v'); sel.disabled = !ui.editing; sel.dataset.field = 'replyLang';
    for (const l of LANGS) { const o = el('option', null, t(`soul.lang.${l}`)); o.value = l; sel.appendChild(o); }
    sel.value = s.replyLang || 'auto';
    sel.addEventListener('change', () => { ui.draft.replyLang = sel.value; });
    langRow.appendChild(sel);
    form.appendChild(langRow);
    wrap.appendChild(form);

    const bar = el('div', 'nb-soul-btns');
    if (!ui.editing) {
      const edit = el('button', 'nb-open', t('soul.edit')); edit.type = 'button'; edit.dataset.act = 'edit';
      edit.addEventListener('click', () => { ui.editing = true; ui.draft = { ...d.soul }; ui.status = ''; paint(); });
      const undo = el('button', 'nb-toggle', t('soul.undo')); undo.type = 'button'; undo.disabled = !d.canUndo; undo.dataset.act = 'undo';
      undo.addEventListener('click', doUndo);
      bar.append(edit, undo);
    } else {
      const cancel = el('button', 'nb-toggle', t('soul.cancel')); cancel.type = 'button';
      cancel.addEventListener('click', () => { ui.editing = false; ui.draft = null; ui.status = ''; paint(); });
      const save = el('button', 'nb-open', t('soul.save')); save.type = 'button'; save.dataset.act = 'save';
      save.addEventListener('click', () => doSave(diff(d.soul, ui.draft)));
      bar.append(cancel, save);
    }
    wrap.appendChild(bar);
    const status = el('p', 'nb-mute nb-soul-status', ui.status); status.setAttribute('aria-live', 'polite');
    wrap.appendChild(status);

    wrap.appendChild(el('h3', 'nb-note-h nb-soul-sub', t('soul.templates')));
    const tl = el('div', 'nb-soul-tpls');
    for (const tp of d.templates) {
      const card = el('div', `nb-soul-tpl${d.soul.template === tp.id ? ' on' : ''}`);
      card.append(el('div', 'nb-soul-tpl-h', loc(tp.label)), el('p', 'nb-text nb-soul-tpl-p', `“${loc(tp.preview)}”`));
      const use = el('button', 'nb-toggle', t('soul.apply')); use.type = 'button'; use.disabled = d.soul.template === tp.id;
      use.addEventListener('click', () => doSave({ template: tp.id }));
      card.appendChild(use);
      tl.appendChild(card);
    }
    wrap.appendChild(tl);

    if (d.history && d.history.length) {
      wrap.appendChild(el('h3', 'nb-note-h nb-soul-sub', t('soul.history')));
      const hl = el('ol', 'nb-soul-hist');
      for (const h of d.history) {
        const tpl = d.templates.find((x) => x.id === h.template);
        hl.appendChild(el('li', 'nb-mute', `${new Date(h.t).toLocaleString(getLocale() === 'zh' ? 'zh-CN' : getLocale())} · ${h.name} · ${tpl ? loc(tpl.label) : t('soul.template.custom')}`));
      }
      wrap.appendChild(hl);
    }
    const det = el('details', 'nb-soul-preview');
    det.append(el('summary', 'nb-mute', t('soul.preview')), el('p', 'nb-text nb-mono', d.preview));
    wrap.appendChild(det);
    host.appendChild(wrap);
    for (const ta of fitLater) { ta.style.height = 'auto'; ta.style.height = `${ta.scrollHeight + 2}px`; }
  };

  const diff = (cur, draft) => {
    const out = {};
    for (const k of [...FIELDS, 'replyLang']) if ((draft[k] || '') !== (cur[k] || '')) out[k] = draft[k];
    return out;
  };

  async function load() {
    const d = await api.get();
    if (!validView(d)) { host.textContent = ''; host.appendChild(el('p', 'nb-empty', t('soul.unavailable'))); return; }
    ui.data = d; paint();
  }

  async function doSave(patch) {
    if (ui.busy) return;
    if (!Object.keys(patch).length) { ui.editing = false; ui.draft = null; paint(); return; }
    if (!(await confirmSoulChange(host.closest('.card') || document.body))) return; // Keep as is
    ui.busy = true;
    try {
      const r = await api.save(patch);
      if (r && r.ok) { ui.editing = false; ui.draft = null; ui.status = t('soul.saved'); const d = await api.get(); if (validView(d)) { ui.data = d; setAddress(d.soul); } }
      else ui.status = errText(r);
    } finally { ui.busy = false; paint(); }
  }

  async function doUndo() {
    if (ui.busy) return;
    ui.busy = true;
    try {
      const r = await api.undo();
      ui.status = r && r.ok ? t('soul.undone') : errText(r);
      const d = await api.get(); if (validView(d)) { ui.data = d; setAddress(d.soul); }
    } finally { ui.busy = false; paint(); }
  }

  paint();
  load();
}

/** First-run cards (plan C.1 cards 1-2). Shown only when the host says not onboarded. Resolves when saved or skipped. */
export async function maybeShowSoulOnboarding(mount = document.body) {
  if (!soulAvailable()) return false;
  const api = window.zumi.soul;
  const d = await api.get();
  if (validView(d)) setAddress(d.soul); // every launch: Zumi's fixed Vietnamese lines in the page use her words from here on
  if (!validView(d) || d.onboarded) return false;
  const host = window.zumi;
  let voiceWas = true; // the switch's own default (boot-reads.mjs: on unless saved off)
  if (host.talk && typeof host.talk.getSpeakTypedWhenMicOff === 'function') {
    try { voiceWas = (await host.talk.getSpeakTypedWhenMicOff()) !== false; } catch (e) { console.error('soul onboarding: voice switch not read, showing on', e); }
  }
  return new Promise((resolve) => {
    const ui = { step: 1, template: 'friendly', name: d.soul.name, ownerName: d.soul.ownerName, selfWord: d.soul.selfWord, userWord: d.soul.userWord, replyLang: d.soul.replyLang, voice: voiceWas, status: '' };
    const back = el('div', 'nb-onboard');
    back.setAttribute('role', 'dialog'); back.setAttribute('aria-modal', 'true'); back.setAttribute('aria-labelledby', 'nb-onboard-h');
    const card = el('div', 'nb-onboard-card');
    back.appendChild(card);
    mount.appendChild(back);
    const finish = async (input, { speak = true, voice = null } = {}) => {
      const r = await api.save(speak ? { ...input, onboarding: true } : input); // Skip keeps her as she is: no "I'm Zumi now" line
      if (r && r.ok) {
        setAddress(r.soul);
        if (voice !== null && voice !== voiceWas && host.talk && typeof host.talk.setSpeakTypedWhenMicOff === 'function') {
          try {
            await host.talk.setSpeakTypedWhenMicOff(voice);
            document.dispatchEvent(new CustomEvent('zumi:talk-changed')); // Settings > Workflow repaints its switch (R8-F1)
          } catch (e) { console.error('soul onboarding: voice choice not saved', e); }
        }
        back.remove(); resolve(true); return;
      }
      ui.status = errText(r); paint();
    };
    function paint() {
      card.textContent = '';
      if (ui.step === 1) { // the very first control (owner 0.3.0 review, option A): readable whatever language the card opened in
        const langRow = el('label', 'nb-soul-row');
        const langSel = el('select', 'nb-filter nb-soul-v'); langSel.dataset.field = 'uiLang';
        for (const l of LOCALES) { const o = el('option', null, t(`soul.lang.${l}`)); o.value = l; langSel.appendChild(o); }
        langSel.value = getLocale();
        langSel.addEventListener('change', async () => {
          const l = langSel.value;
          try { if (host.ui && typeof host.ui.setLang === 'function') await host.ui.setLang(l); } catch (e) { console.error('soul onboarding: language not saved', e); }
          setLocale(l); // the app repaints through its locale listeners (app.js changeLang does the same)
          paint();
        });
        langRow.append(el('span', 'nb-soul-k', LOCALES.map((l) => TABLES[l]['settings.language']).join(' / ')), langSel);
        card.appendChild(langRow);
      }
      const head = el('div', 'nb-onboard-top');
      head.append(el('span', 'nb-mute nb-mono', t('onboard.step', { n: ui.step })), el('span', 'nb-soul-sp'));
      const skip = el('button', 'nb-toggle', t('onboard.skip')); skip.type = 'button'; skip.dataset.act = 'skip';
      skip.addEventListener('click', () => finish({ template: 'friendly' }, { speak: false }));
      head.appendChild(skip);
      card.appendChild(head);
      if (ui.step === 1) {
        const h = el('h2', 'nb-onboard-h', t('onboard.pick.title')); h.id = 'nb-onboard-h';
        card.append(h, el('p', 'nb-mute', t('onboard.pick.sub')));
        const list = el('div', 'nb-soul-tpls nb-onboard-tpls');
        for (const tp of d.templates) {
          const b = el('button', `nb-soul-tpl${ui.template === tp.id ? ' on' : ''}`); b.type = 'button'; b.dataset.template = tp.id;
          b.setAttribute('aria-pressed', String(ui.template === tp.id));
          b.append(el('div', 'nb-soul-tpl-h', loc(tp.label)), el('p', 'nb-text nb-soul-tpl-p', `“${loc(tp.preview)}”`));
          b.addEventListener('click', () => { ui.template = tp.id; paint(); });
          list.appendChild(b);
        }
        card.appendChild(list);
      } else {
        const h = el('h2', 'nb-onboard-h', t('onboard.name.title')); h.id = 'nb-onboard-h';
        card.appendChild(h);
        const form = el('div', 'nb-soul-form');
        for (const k of ['name', 'ownerName', 'selfWord', 'userWord']) {
          const row = el('label', 'nb-soul-row');
          const input = el('input', 'nb-filter nb-soul-v'); input.type = 'text'; input.value = ui[k] || ''; input.maxLength = (d.limits && d.limits[k]) || 40;
          input.dataset.field = k;
          if (k === 'ownerName') input.placeholder = t('onboard.userDefault'); // a hint, never saved: an empty name stores nothing
          input.addEventListener('input', () => { ui[k] = input.value; });
          row.append(el('span', 'nb-soul-k', t(`soul.field.${k}`)), input);
          if (k === 'userWord' && Array.isArray(d.addressWords)) { // a pick list that still takes free text
            const list = el('datalist'); list.id = 'nb-onboard-address';
            for (const w of d.addressWords) { const o = el('option'); o.value = w; list.appendChild(o); }
            input.setAttribute('list', list.id);
            row.appendChild(list);
          }
          form.appendChild(row);
        }
        const langRow = el('label', 'nb-soul-row');
        const sel = el('select', 'nb-filter nb-soul-v'); sel.dataset.field = 'replyLang';
        for (const l of LANGS) { const o = el('option', null, t(`soul.lang.${l}`)); o.value = l; sel.appendChild(o); }
        sel.value = ui.replyLang || 'auto';
        sel.addEventListener('change', () => { ui.replyLang = sel.value; });
        langRow.append(el('span', 'nb-soul-k', t('soul.field.replyLang')), sel);
        form.appendChild(langRow);
        const voiceRow = el('label', 'nb-soul-row');
        const voice = el('input'); voice.type = 'checkbox'; voice.checked = ui.voice; voice.dataset.field = 'voice';
        voice.addEventListener('change', () => { ui.voice = voice.checked; });
        voiceRow.append(el('span', 'nb-soul-k', t('settings.typedReplySpeech')), voice);
        form.appendChild(voiceRow);
        card.appendChild(form);
      }
      const btns = el('div', 'nb-soul-btns');
      if (ui.step === 2) { const bk = el('button', 'nb-toggle', t('onboard.back')); bk.type = 'button'; bk.addEventListener('click', () => { ui.step = 1; paint(); }); btns.appendChild(bk); }
      const next = el('button', 'nb-open', t(ui.step === 1 ? 'onboard.next' : 'onboard.done')); next.type = 'button'; next.dataset.act = ui.step === 1 ? 'next' : 'done';
      next.addEventListener('click', () => {
        if (ui.step === 1) { ui.step = 2; paint(); return; }
        finish({ template: ui.template, name: ui.name, ownerName: ui.ownerName, selfWord: ui.selfWord, userWord: ui.userWord, replyLang: ui.replyLang }, { voice: ui.voice });
      });
      btns.appendChild(next);
      card.appendChild(btns);
      if (ui.status) card.appendChild(el('p', 'nb-mute nb-soul-status', ui.status));
    }
    paint();
  });
}
