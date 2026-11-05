// The Memory tab on the Electron build (SPEC-memory "Clients + capability"): memory runs in the Tauri host only, so Electron shows this
// card and makes no memory.* call (AC-M8). The second line is the promise the owner answered on 26-10: nothing carries over.
import { t } from '../../i18n.js';
import { el } from './dom.js';

export function renderMemoryCard(host) {
  host.textContent = '';
  const card = el('div', 'nb-note');
  card.dataset.memory = 'tauri-card';
  card.append(el('h3', 'nb-note-h', t('brain.mem.tauriTitle')), el('p', 'nb-text', t('brain.mem.tauriBody')));
  host.appendChild(card);
}
