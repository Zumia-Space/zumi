// Auto-update UI (T-31 auto-update; main side: src/main/updater.mjs). Two pieces only:
//   - a quiet status line while a new version downloads (non-modal), or a short note when a download failed (the
//     next scheduled check retries; nothing to click);
//   - one dialog when the update is ready: version, changelog (plain text, textContent only), Restart now / Later.
//     It never opens while Zumi is speaking or a reply is still streaming (`isBusy`); it waits and tries again.
// Later = main records it (not offered again this session) and the update installs on the next normal quit.
import { t, getLocale } from './i18n.js';

const RETRY_BUSY_MS = 2000;
const ERROR_SHOW_MS = 8000;

/** The changelog for the UI language. A feed's notes hold `## vi` and `## en` sections (release-notes/<version>.md); Electron's
 *  main process already picked one, and plain notes have no heading, so both pass through unchanged. */
export function pickNotes(notes, lang) {
  const text = String(notes ?? '').replace(/\r\n?/g, '\n');
  const heads = [...text.matchAll(/^##[ \t]*(vi|en)[ \t]*$/gim)];
  if (!heads.length) return text.trim();
  const section = (want) => {
    const i = heads.findIndex((h) => h[1].toLowerCase() === want);
    return i < 0 ? '' : text.slice(heads[i].index + heads[i][0].length, i + 1 < heads.length ? heads[i + 1].index : text.length).trim();
  };
  return (lang === 'vi' && section('vi')) || section('en');
}

const CHECK_RESULT_TEXT = { none: 'update.upToDate', error: 'update.checkFailed', available: 'update.checkFound' };

export function initUpdateUi({ zumi, $, isBusy = () => false }) {
  if (!zumi.update) return;
  const pill = $('update-pill'), dlg = $('update-dialog'), notesEl = $('update-notes'), notesHead = dlg.querySelector('.update-notes-h');
  let offer = null, waitTimer = null, errorTimer = null, installing = false;

  function showPill(text, bad = false) {
    pill.textContent = text;
    pill.classList.toggle('bad', bad);
    pill.hidden = false;
  }
  function tryOffer() {
    waitTimer = null;
    if (!offer || dlg.open) return;
    if (isBusy()) { waitTimer = setTimeout(tryOffer, RETRY_BUSY_MS); return; }
    $('update-title').textContent = t('update.readyTitle', { version: offer.version });
    const notes = pickNotes(offer.notes, getLocale());
    notesEl.textContent = notes;
    notesHead.hidden = !notes;
    dlg.showModal();
  }
  function onState(s) {
    clearTimeout(errorTimer);
    if (s.phase === 'downloading') showPill(t('update.downloading', { percent: s.percent || 0 }));
    else if (s.phase === 'error') { showPill(t('update.failed'), true); errorTimer = setTimeout(() => { pill.hidden = true; }, ERROR_SHOW_MS); }
    else if (s.repair) showPill(t('update.repair'), true); // files on disk differ from what this version installed
    else pill.hidden = true;
    if (s.phase === 'downloading' || s.phase === 'error') return; // an offer already open stays as it is
    const next = s.phase === 'ready' && s.ready ? s.ready : null;
    if (!next) { offer = null; if (dlg.open) dlg.close(); return; } // withdrawn, or put off
    if (offer && offer.version === next.version) return;
    offer = next;
    if (!waitTimer) tryOffer();
  }

  $('update-restart').addEventListener('click', async () => {
    // The host answers false to a second click because one install is already running: that is not a failure to report.
    if (!offer || installing) return;
    installing = true;
    const started = await zumi.update.install().catch(() => false);
    installing = false;
    if (!started) { dlg.close(); showPill(t('update.failed'), true); }
  });
  $('update-later').addEventListener('click', async () => {
    const v = offer && offer.version;
    offer = null;
    dlg.close();
    if (v) await zumi.update.later(v);
  });
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); $('update-later').click(); }); // Esc = Later
  $('update-check').addEventListener('click', async () => {
    const button = $('update-check'), note = $('update-check-note');
    button.disabled = true;
    note.textContent = t('update.checking');
    const answer = await zumi.update.check().catch(() => ({ result: 'error' }));
    const key = CHECK_RESULT_TEXT[answer && answer.result];
    note.textContent = key ? t(key) : ''; // busy: a check or a download is already running, and the pill shows the download
    button.disabled = false;
  });
  zumi.update.onState(onState);
  zumi.update.status().then((s) => {
    if (!s || s.phase === 'off') return;
    $('update-check-row').hidden = false;
    onState(s);
  }).catch(() => { /* updates simply stay quiet */ });
}
