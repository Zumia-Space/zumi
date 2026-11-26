// Settings > App > Advanced: the Memory switch (T-31-MAUS R6c C item 1). Memory is part of the product and is ON until the person
// turns it off here (the host answers `enabled: true` when nothing was ever saved; the choice is saved by the click, nowhere else).
// The switch used to sit on the Memory tab; the owner's ruling of 19-11 moved it here. The card exists in index.html, hidden, and is
// shown only where the host has the memory API (the Tauri build); Electron keeps it hidden. Text is set with textContent only.
import { t, onLocaleChange } from './i18n.js';

/** True where the host has the memory API. */
export const memorySettingsAvailable = (zumi) => Boolean(zumi && zumi.memory && typeof zumi.memory.status === 'function' && typeof zumi.memory.setEnabled === 'function');

/** Wires #memory-card / #mem-enabled / #mem-note. Returns { refresh } or null without the API (the card stays hidden). */
export function initMemorySettings(zumi, $) {
  const card = $('memory-card');
  const box = $('mem-enabled');
  const note = $('mem-note');
  const where = $('mem-where'); // the folder, in words (filled from status.dir; absent from an older page: skipped)
  if (!card || !box || !note || !memorySettingsAvailable(zumi)) return null;

  const say = (text) => { note.textContent = text; };
  let dir = '';
  const paintWhere = () => { if (where) where.textContent = dir ? t('settings.mem.where', { dir }) : ''; };

  async function refresh() {
    let s = null;
    try { s = await zumi.memory.status(); } catch { s = null; }
    if (!s) { card.hidden = true; return null; }
    card.hidden = false;
    box.checked = Boolean(s.enabled);
    box.disabled = Boolean(s.unavailable);
    dir = typeof s.dir === 'string' ? s.dir : '';
    paintWhere();
    say(s.unavailable ? t('brain.mem.unavailable') : '');
    return s;
  }

  box.addEventListener('change', async () => {
    const want = Boolean(box.checked);
    say('');
    try {
      const r = await zumi.memory.setEnabled(want);
      if (r && r.ok === false) throw new Error(r.error || 'failed');
    } catch (e) {
      box.checked = !want; // the host did not take it: show what is true
      say(t('settings.mem.saveFail', { error: (e && e.message) || String(e) }));
      return;
    }
    await refresh();
  });

  if (typeof onLocaleChange === 'function') onLocaleChange(paintWhere); // the folder line is filled here, not by data-i18n: follow the language
  refresh();
  return { refresh };
}
