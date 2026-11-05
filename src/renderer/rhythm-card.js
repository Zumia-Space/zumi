// Settings > Agent & Soul > Rhythm (T-31 alpha.12, PLAN-ZUMI-WATCH v2 A.6): a 7x24 heat strip of when the owner is usually at the PC,
// the cadence numbers in plain words, "Learning since", Pause / Resume learning, Reset rhythm (with a confirm), and the read-only board
// watcher's on/off. Everything shown is what zumi.rhythm.get() returns (agent-core.mjs -> rhythm.mjs, the one reader); this file
// computes no cadence. Built here, not in index.html, so a host without the rhythm API shows no control that does nothing.
import { t, apply, isPublicText } from './i18n.js';

const MIN = 60_000;
const HOUR = 60 * MIN;

/** True where the host has the rhythm API. */
export const rhythmAvailable = (zumi) => Boolean(zumi && zumi.rhythm && typeof zumi.rhythm.get === 'function');

/** "15 min" / "2 h" / "1.5 h" from ms. */
export function durationText(ms) {
  if (!(ms > 0)) return '';
  if (ms < HOUR) return t('rhythm.min', { n: Math.round(ms / MIN) });
  const h = Math.round((ms / HOUR) * 10) / 10;
  return t('rhythm.hour', { n: h });
}

const hhmm = (h) => `${String(h).padStart(2, '0')}:00`;
const node = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

/** Adds the card to #stabpanel-agent and keeps it current. Returns { refresh } or null without the API. */
export function initRhythmCard(zumi, $) {
  const panel = $('stabpanel-agent');
  if (!panel || !rhythmAvailable(zumi) || $('rhythm-card')) return null;
  const card = node('section', 'card');
  card.id = 'rhythm-card';
  card.hidden = true; // shown once the host answered with a real rhythm view
  card.innerHTML = `
    <div class="ghead"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h3l2-5 4 10 2-5h7"/></svg><h2 data-i18n="rhythm.title">Rhythm</h2></div>
    <label class="srow">
      <span class="lbl"><span class="k" data-i18n="rhythm.watch">Watch the board for slips</span><span class="d" data-i18n="rhythm.watchD"></span></span>
      <input type="checkbox" class="sw" id="watch-level">
    </label>
    <div class="srow rhythm-body"><div class="lbl">
      <div class="k" id="rhythm-state"></div>
      <div class="d" data-i18n="rhythm.heat"></div>
      <div class="rhythm-heat" id="rhythm-heat" role="img"></div>
      <ul class="rhythm-lines" id="rhythm-lines"></ul>
      <div class="d" data-i18n="rhythm.local"></div>
    </div></div>
    <div class="srow"><div class="lbl"><div class="d" id="rhythm-status" aria-live="polite"></div></div>
      <div class="ctl"><button id="rhythm-pause" class="ghost" type="button"></button><button id="rhythm-reset" class="ghost" type="button" data-i18n="rhythm.reset">Reset rhythm</button></div>
    </div>`;
  // After the voice card: the talk level, then how her rhythm shapes it.
  const voice = $('voice-card');
  if (voice && voice.nextSibling) panel.insertBefore(card, voice.nextSibling); else panel.appendChild(card);
  apply(card);
  let view = null;
  let confirming = false; // Reset asks inline (a second click), not with window.confirm: the Tauri webview may suppress native dialogs

  function paint() {
    if (!view) return;
    const q = (id) => card.querySelector(`#${id}`);
    q('watch-level').checked = view.watchLevel !== 'off';
    q('rhythm-state').textContent = view.learning ? t('rhythm.learning', { days: view.days, events: view.events }) : t('rhythm.learned', { days: view.days, events: view.events });
    q('rhythm-pause').textContent = confirming ? t('soul.cancel') : t(view.paused ? 'rhythm.resume' : 'rhythm.pause');
    q('rhythm-reset').textContent = t(confirming ? 'rhythm.resetYes' : 'rhythm.reset');
    q('rhythm-status').textContent = confirming ? t('rhythm.resetConfirm') : view.paused ? t('rhythm.pausedNote') : '';
    const heat = q('rhythm-heat');
    heat.textContent = '';
    heat.setAttribute('aria-label', t('rhythm.heat'));
    const days = t('rhythm.dow').split(',');
    (view.activeProb || []).forEach((row, d) => {
      const r = node('div', 'rhythm-row');
      r.appendChild(node('span', 'rhythm-dow', days[d] || String(d)));
      row.forEach((p, h) => {
        const c = node('i', 'rhythm-cell');
        c.style.setProperty('--p', String(Math.max(0, Math.min(1, p))));
        c.title = `${days[d] || d} ${hhmm(h)} · ${Math.round(p * 100)}%`;
        r.appendChild(c);
      });
      heat.appendChild(r);
    });
    const lines = q('rhythm-lines');
    lines.textContent = '';
    const add = (key, vars) => lines.appendChild(node('li', null, t(key, vars)));
    add('rhythm.line.checkins', { v: (view.checkinHours || []).map(hhmm).join(', ') || '—' });
    add('rhythm.line.batch', { v: durationText(view.batchMs) });
    add('rhythm.line.budget', { n: view.nudgeBudgetToday });
    add('rhythm.line.receipt', { v: durationText(view.receiptMs) });
    if (view.quietSuggested) add('rhythm.line.quiet', { v: `${view.quietSuggested.start}–${view.quietSuggested.end}` });
    else add('rhythm.line.noQuiet');
  }

  // A host answer without the rhythm shape (an older host, a test stub) hides the card instead of painting garbage.
  const take = (v) => {
    const ok = Boolean(v && typeof v === 'object' && Array.isArray(v.activeProb) && Array.isArray(v.checkinHours));
    card.hidden = !ok;
    view = ok ? v : null;
    paint();
    return view;
  };
  async function refresh() { return take(await zumi.rhythm.get()); }
  if (isPublicText()) card.querySelector('#watch-level').closest('.srow').hidden = true; // it watches the Board
  card.querySelector('#watch-level').addEventListener('change', async (e) => { take(await zumi.watch.setLevel(e.target.checked ? 'on' : 'off')); });
  card.querySelector('#rhythm-pause').addEventListener('click', async () => {
    if (confirming) { confirming = false; paint(); return; }
    take(await zumi.rhythm.pause(!(view && view.paused)));
  });
  card.querySelector('#rhythm-reset').addEventListener('click', async () => {
    if (!confirming) { confirming = true; paint(); return; }
    confirming = false;
    take(await zumi.rhythm.reset());
  });
  // The agent tab is shown later; keep the card current whenever its tab opens.
  const tab = $('stab-agent');
  if (tab) tab.addEventListener('click', () => { refresh(); });
  refresh();
  return { refresh };
}
