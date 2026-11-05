// One-time "Import from Zumi" (T-31 Tauri P3-C; sidecar side: tauri/sidecar/profile-import.mjs).
// Tauri-only: the four `settings.import*` methods exist only in the Tauri shim, so Electron (no `zumi.settings`) never
// shows any of this. The renderer never names a path: the sidecar reads the fixed 0.2.9 profile itself.
//   first run  -> a dialog with the dry-run summary: Apply / Not now / Never
//   Settings   -> App tab card that opens the same dialog again (any time)
//   after Apply-> the result and the "enter your keys / sign in to the Board again" checklist (i18n keys by id)
import { t, getLocale, setImportAppLabel, apply as applyI18n, isPublicText } from './i18n.js';

const NEUTRAL_LABEL = 'Zumi (desktop)';
/** "Zumi 0.2.10" from the sidecar's detected version; a missing or odd version gives the neutral label, never a number we do not know. */
export function sourceLabel(detect) {
  const v = detect && detect.sourceVersion;
  return typeof v === 'string' && /^\d{1,4}\.\d{1,4}\.\d{1,4}(-[0-9A-Za-z.]{1,24})?$/.test(v) ? `Zumi ${v}` : NEUTRAL_LABEL;
}

/** The first-run prompt shows only when the sidecar says a profile exists and the user has not answered yet. */
export function shouldOffer(detect) {
  return Boolean(detect && detect.found === true && detect.offer === true);
}

/**
 * Dry-run plan -> the three numbers shown to the user and the conflict keys pre-selected for "use my old value".
 * Only conflicts Tauri set by itself on first boot (autoDefault) are pre-selected; a value the user chose stays.
 */
export function summarize(plan) {
  const p = plan || {};
  const conflicts = Array.isArray(p.conflicts) ? p.conflicts : [];
  const n = (x) => (Array.isArray(x) ? x.length : 0);
  return {
    copy: n(p.copy),
    kept: n(p.same) + conflicts.length,
    skipped: n(p.skipped) + n(p.unknown),
    conflicts,
    preselect: conflicts.filter((c) => c && c.autoDefault === true).map((c) => c.key),
  };
}

/** Anything to do at all? A plan with nothing to copy and nothing to choose is not worth a dialog. */
export function hasSomethingToImport(plan) {
  const s = summarize(plan);
  return s.copy > 0 || s.conflicts.length > 0;
}

const CHECK_IDS = new Set(['api_keys', 'board_login', 'board_pin', 'ui_prefs', 'board_data', 'voice_cache', 'model_readd']);

/** Checklist rows from the sidecar's report; only ids the renderer has text for, in the sidecar's order. */
export function checklistRows(report, translate = t) {
  const ids = [...((report && report.needsReentry) || []), ...((report && report.notImported) || [])].filter((id) => CHECK_IDS.has(id));
  const providers = (report && Array.isArray(report.providers)) ? report.providers : [];
  return ids.map((id) => {
    let body = translate(`import.check.${id}.b`);
    if (id === 'api_keys' && providers.length) body += ` ${translate('import.hadKey')} ${providers.join(', ')}.`;
    return { id, title: translate(`import.check.${id}.t`), body };
  });
}

export function initProfileImport({ zumi, $ }) {
  const api = zumi && zumi.settings;
  if (!api || typeof api.importDetect !== 'function') return; // Electron: nothing to import into
  const dlg = $('import-dialog'), card = $('import-card'), run = $('import-run'), note = $('import-card-note');
  if (!dlg) return;
  const body = $('import-body'), actions = $('import-actions'), title = $('import-title');
  let busy = false;

  const el = (tag, text, cls) => { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; };
  const setButtons = (ids) => { for (const id of ['import-apply', 'import-later', 'import-never', 'import-close']) $(id).hidden = !ids.includes(id); };

  function renderPlan(plan) {
    const s = summarize(plan);
    body.replaceChildren(
      el('p', t('import.intro'), 'update-body'),
      el('p', t('import.copy', { n: s.copy })),
      el('p', t('import.keep', { n: s.kept })),
      el('p', t('import.skip', { n: s.skipped })),
    );
    if (s.conflicts.length) {
      body.append(el('h3', t('import.overwriteH'), 'update-notes-h'));
      for (const c of s.conflicts) {
        const row = el('label', null, 'import-pick');
        const cb = document.createElement('input');
        cb.type = 'checkbox'; cb.value = c.key; cb.checked = s.preselect.includes(c.key);
        row.append(cb, el('span', c.key));
        body.append(row);
      }
    }
    setButtons(['import-apply', 'import-later', 'import-never']);
  }

  function renderResult(report) {
    title.textContent = t('import.resultTitle');
    body.replaceChildren(el('p', t('import.resultBody', { n: report.copied.length, k: report.kept.length, s: report.skipped.length + report.unknown.length }), 'update-body'));
    body.append(el('h3', t('import.checklistH'), 'update-notes-h'));
    const list = el('ul', null, 'import-check');
    for (const r of checklistRows(report)) {
      const li = el('li');
      li.append(el('strong', r.title), el('div', r.body, 'd'));
      list.append(li);
    }
    body.append(list);
    setButtons(['import-close']);
  }

  function renderError(code) {
    body.replaceChildren(el('p', t('import.error', { code: String(code || 'error') }), 'update-body'));
    setButtons(['import-close']);
  }

  async function open() {
    if (busy || dlg.open) return;
    title.textContent = t('import.title');
    let plan;
    try { plan = await api.importPlan(); } catch { plan = null; }
    if (!plan || plan.ok !== true) { renderError(plan && plan.error); } else renderPlan(plan);
    if (!dlg.open) dlg.showModal();
  }

  $('import-apply').addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    const overwrite = [...body.querySelectorAll('.import-pick input:checked')].map((c) => c.value);
    let report;
    try { report = await api.importApply({ overwrite, lang: getLocale() }); } catch { report = null; }
    busy = false;
    if (report && report.ok === true) { renderResult(report); refreshCard(); } else renderError(report && report.error);
  });
  $('import-later').addEventListener('click', async () => {
    if (isPublicText()) { try { await api.importDismiss(); } catch { /* the dialog just closes */ } } // a stranger is not asked twice; Settings still has it
    dlg.close();
  }); // the owner: asked again next launch
  $('import-never').addEventListener('click', async () => { try { await api.importDismiss(); } catch { /* the dialog just closes */ } dlg.close(); refreshCard(); });
  $('import-close').addEventListener('click', () => dlg.close());

  async function refreshCard() {
    let d = null;
    try { d = await api.importDetect(); } catch { d = null; }
    setImportAppLabel(sourceLabel(d)); // every {app} in the import strings, then repaint the static ones (card title, dialog title)
    applyI18n(card || undefined);
    if (!dlg.open) title.textContent = t('import.title');
    if (card) card.hidden = false;
    if (run) run.disabled = !(d && d.found === true);
    if (note) note.textContent = d && d.found === true ? '' : t('import.none');
    return d;
  }
  if (run) run.addEventListener('click', open);

  refreshCard().then(async (d) => {
    if (!shouldOffer(d)) return;
    const plan = await api.importPlan();
    if (isPublicText() && !hasSomethingToImport(plan)) { await api.importDismiss(); return; } // answered: a later start has settings of its own and would look like conflicts
    open();
  }).catch(() => { /* never block start-up */ });
}
