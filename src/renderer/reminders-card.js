// Settings > Agent & Soul > Reminders (T-31-MAUS A2, R6c B): a form to add, list and delete a reminder (time, text, and one of five repeat
// kinds: once, every day, monthly, yearly, every few minutes), plus the recent history (spoken, missed N, not spoken). Everything shown is
// what zumi.routines.list() and zumi.routines.history() return (the Rust routines crate is the one reader); this file computes no
// next-fire time. The wording and the form-to-argument rules are in reminders-model.js (pure, tested by scripts/check-reminders-card.mjs).
// Built here, not in index.html, like rhythm-card.js, so a host without the routines API shows no control that does nothing. The text is
// set with textContent only, never as markup.
import { t, apply } from './i18n.js';
import { rowText, historyText, formFor } from './reminders-model.js';

/** True where the host has the routines API. */
export const remindersAvailable = (zumi) => Boolean(zumi && zumi.routines && typeof zumi.routines.list === 'function');

const node = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

/** The words for an error code from routines.add / routines.delete; an unknown code is shown as-is after a generic line. */
export function errorText(code) {
  const key = `reminders.err.${code}`;
  const known = ['bad_text', 'bad_time', 'bad_repeat', 'bad_rule', 'bad_args', 'too_many', 'not_found'].includes(code);
  return known ? t(key) : `${t('reminders.err.other')} (${String(code || '')})`;
}

const WEEK = [1, 2, 3, 4, 5, 6, 0]; // Monday first on screen; the host counts Sunday as 0

/** Adds the card to #stabpanel-agent after the rhythm card and keeps it current. Returns { refresh } or null without the API. */
export function initRemindersCard(zumi, $) {
  const panel = $('stabpanel-agent');
  if (!panel || !remindersAvailable(zumi) || $('reminders-card')) return null;
  const card = node('section', 'card');
  card.id = 'reminders-card';
  card.innerHTML = `
    <div class="ghead"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9a6 6 0 0 1 12 0c0 6 2 7 2 7H4s2-1 2-7"/><path d="M10 20a2 2 0 0 0 4 0"/></svg><h2 data-i18n="reminders.title">Reminders</h2></div>
    <div class="srow stack"><div class="lbl"><div class="d" data-i18n="reminders.hint"></div></div>
      <div class="line">
        <input id="rem-time" type="time" required aria-label="Time" data-i18n-aria="reminders.time">
        <input id="rem-text" type="text" maxlength="200" autocomplete="off" spellcheck="false" placeholder="What should I say?" data-i18n-placeholder="reminders.text" aria-label="Reminder" data-i18n-aria="reminders.text">
      </div>
      <div class="line">
        <select id="rem-repeat" aria-label="Repeat" data-i18n-aria="reminders.repeat">
          <option value="none" data-i18n="reminders.repeatNone">Once</option>
          <option value="daily" data-i18n="reminders.repeatDaily">Every day</option>
          <option value="monthly" data-i18n="reminders.repeatMonthly">Every month</option>
          <option value="yearly" data-i18n="reminders.repeatYearly">Every year</option>
          <option value="interval" data-i18n="reminders.repeatInterval">Every few minutes</option>
        </select>
        <button id="rem-add" class="primary" type="button" data-i18n="reminders.add">Add</button>
      </div>
      <div class="line" id="rem-monthly" hidden>
        <select id="rem-day-m" aria-label="Day" data-i18n-aria="reminders.day"></select>
      </div>
      <div class="line" id="rem-yearly" hidden>
        <select id="rem-month" aria-label="Month" data-i18n-aria="reminders.month"></select>
        <select id="rem-day-y" aria-label="Day" data-i18n-aria="reminders.day"></select>
      </div>
      <div class="line" id="rem-interval" hidden>
        <input id="rem-every" type="number" min="5" max="1440" step="1" value="60" aria-label="Every (minutes)" data-i18n-aria="reminders.everyMinLabel">
        <input id="rem-win-start" type="time" aria-label="From" data-i18n-aria="reminders.windowStart">
        <input id="rem-win-end" type="time" aria-label="Until" data-i18n-aria="reminders.windowEnd">
        <span id="rem-week"></span>
      </div>
      <div class="d" id="rem-status" aria-live="polite"></div>
    </div>
    <div class="srow"><ul class="rem-list" id="rem-list"></ul></div>
    <div class="srow stack"><div class="lbl"><div class="d" data-i18n="reminders.hist.title">Recent</div></div><ul class="rem-list" id="rem-hist"></ul></div>`;
  const rhythm = $('rhythm-card');
  if (rhythm && rhythm.nextSibling) panel.insertBefore(card, rhythm.nextSibling); else panel.appendChild(card);
  apply(card);
  const q = (id) => card.querySelector(`#${id}`);

  const fillDays = (sel) => {
    sel.textContent = '';
    for (let d = 1; d <= 31; d += 1) { const o = node('option', null, String(d)); o.value = String(d); sel.appendChild(o); }
  };
  fillDays(q('rem-day-y'));
  fillDays(q('rem-day-m'));
  const last = node('option', null, t('reminders.dayLast'));
  last.value = 'last';
  q('rem-day-m').appendChild(last);
  for (let m = 1; m <= 12; m += 1) { const o = node('option', null, String(m)); o.value = String(m); q('rem-month').appendChild(o); }
  for (const d of WEEK) {
    const label = node('label', null, t(`reminders.wd.${d}`));
    const box = node('input');
    box.type = 'checkbox';
    box.value = String(d);
    label.prepend(box);
    q('rem-week').appendChild(label);
  }
  const showKind = () => {
    const kind = q('rem-repeat').value;
    q('rem-monthly').hidden = kind !== 'monthly';
    q('rem-yearly').hidden = kind !== 'yearly';
    q('rem-interval').hidden = kind !== 'interval';
  };
  q('rem-repeat').addEventListener('change', showKind);
  showKind();

  const status = (text) => { q('rem-status').textContent = text || ''; };

  function paint(items) {
    const list = q('rem-list');
    list.textContent = '';
    if (!items.length) { list.appendChild(node('li', null, t('reminders.empty'))); return; }
    for (const it of items) {
      const li = node('li', 'rem-row');
      li.appendChild(node('span', null, rowText(it, t)));
      const del = node('button', 'ghost', t('reminders.delete'));
      del.type = 'button';
      del.dataset.id = it.id;
      del.addEventListener('click', async () => {
        let r = null;
        try { r = await zumi.routines.delete(it.id); } catch { r = null; }
        status(r && r.ok ? '' : errorText(r && r.error ? r.error : 'other'));
        refresh();
      });
      li.appendChild(del);
      list.appendChild(li);
    }
  }

  async function paintHistory() {
    const list = q('rem-hist');
    if (typeof zumi.routines.history !== 'function') { list.textContent = ''; return; }
    let r = null;
    try { r = await zumi.routines.history({ limit: 20 }); } catch { r = null; }
    list.textContent = '';
    if (!(r && r.ok && Array.isArray(r.items))) return;
    for (const h of r.items) {
      const when = new Date(h.atMs);
      const stamp = Number.isFinite(when.getTime()) ? `${when.toLocaleDateString()} ${when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ` : '';
      list.appendChild(node('li', null, `${stamp}${historyText(h, t)}`));
    }
  }

  async function refresh() {
    let r = null;
    try { r = await zumi.routines.list(); } catch { r = null; }
    if (r && r.ok && Array.isArray(r.items)) paint(r.items);
    else status(errorText(r && r.error ? r.error : 'other'));
    paintHistory();
    return r;
  }

  q('rem-add').addEventListener('click', async () => {
    const kind = q('rem-repeat').value;
    const inputs = {
      text: q('rem-text').value, time: q('rem-time').value, repeat: kind,
      day: kind === 'yearly' ? q('rem-day-y').value : q('rem-day-m').value, month: q('rem-month').value,
      everyMin: q('rem-every').value, windowStart: q('rem-win-start').value, windowEnd: q('rem-win-end').value,
      weekdays: [...q('rem-week').querySelectorAll('input:checked')].map((b) => b.value),
    };
    const made = formFor(inputs);
    if (made.error) { status(errorText(made.error)); return; }
    let r = null;
    try { r = await zumi.routines.add(made.form); } catch { r = null; }
    if (r && r.ok) {
      q('rem-text').value = '';
      status(t('reminders.added', { time: r.item.time }));
    } else {
      status(errorText(r && r.error ? r.error : 'other'));
    }
    refresh();
  });
  q('rem-text').addEventListener('keydown', (e) => { if (e.key === 'Enter') q('rem-add').click(); });
  // The agent tab is shown later; keep the list current whenever its tab opens.
  const tab = $('stab-agent');
  if (tab) tab.addEventListener('click', () => { refresh(); });
  refresh();
  return { refresh };
}
