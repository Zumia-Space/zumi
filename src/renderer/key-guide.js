// A public build's card over the stage once onboarding is done: no key, no replies, and here is how. Gone as soon as a key works.
import { apply } from './i18n.js';

export function initKeyGuide({ zumi, $, doc = document, openGuide = null }) {
  const card = doc.createElement('aside');
  card.id = 'key-guide'; card.className = 'frame nx-card key-guide'; card.hidden = true; card.setAttribute('role', 'status');
  const line = (tag, key, cls) => { const e = doc.createElement(tag); e.setAttribute('data-i18n', key); if (cls) e.className = cls; return e; };
  const add = line('button', 'keyGuide.add', 'primary'), get = line('button', 'keyGuide.get', 'ghost'), guide = line('button', 'keyGuide.guide', 'ghost');
  add.type = get.type = guide.type = 'button';
  const row = doc.createElement('div'); row.className = 'key-guide-row'; row.append(add, get);
  if (openGuide) row.appendChild(guide); // the full guide: three routes (OpenCode, OpenRouter, Google) with steps and a paste box
  card.append(line('h3', 'keyGuide.title'), line('p', 'keyGuide.body', 'muted'), row);
  $('stage').appendChild(card);
  apply(card);
  let onboarded = false, enabled = !$('talk').hidden; // what talk's setEnabled last said: it ran before this card existed
  const paint = () => { card.hidden = !(onboarded && !enabled); };
  doc.addEventListener('zumi:onboarding-done', () => { onboarded = true; paint(); });
  doc.addEventListener('zumi:talk-enabled', (e) => { enabled = Boolean(e.detail); paint(); });
  add.addEventListener('click', () => {
    doc.querySelector('.tab[data-tab="settings"]').click();
    $('stab-ai').click();
    const field = $('brain-key-input');
    if (!field) return;
    field.scrollIntoView({ block: 'center' });
    const first = field.disabled ? $('brain-free-age18') : field; // the field opens once the 18+ switch is on
    if (first) first.focus();
  });
  guide.addEventListener('click', () => { if (openGuide) openGuide(); });
  get.addEventListener('click', () => { zumi.ai.openKeyPage(); });
}
