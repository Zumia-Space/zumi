// T-31 alpha.3 R5 / alpha.4: the Pricing page (a rail item before Settings, next/boot.js addPricing): a full page over the Zumi panel
// since alpha.4 (anh 30-10: no model behind it). Static text from i18n plus at most two link buttons. The page never holds a URL: a
// button names a link id and zumi.links.open(id) asks the host, which opens tauri/sidecar/links.mjs's URL for that id in the default
// browser (R4 seam). Upgrade exists only while zumi.links.list() says its id is set. Donate is always shown (anh 30-10 05:10Z): disabled
// and reading "Coming soon" until its one donate link is set. No payment SDK, no payment flow, no account or plan state, no network.
import { t } from '../i18n.js';

export const PRICING_LINK_IDS = Object.freeze(['upgrade', 'donate']);

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** One element carrying both the translated text (first paint) and its data-i18n key (repainted by the app's apply on a language change). */
const txt = (tag, cls, key) => `<${tag} class="${cls}" data-i18n="${key}">${esc(t(key))}</${tag}>`;
const bullets = (plan) => `<ul class="np-list">${['b1', 'b2', 'b3'].map((b) => txt('li', 'np-li', `pricing.${plan}.${b}`)).join('')}</ul>`;
const linkButton = (id, key) => `<button type="button" class="np-link" data-link="${id}" data-i18n="${key}">${esc(t(key))}</button>`;
/** A link button whose URL is not set yet: shown, disabled, its name then "Coming soon". */
const soonButton = (id, key) => `<button type="button" class="np-link np-hero-btn" data-link="${id}" disabled aria-disabled="true">${txt('span', 'np-link-name', key)} · ${txt('span', 'np-soon', 'links.comingSoon')}</button>`;

/** The page's markup for one links.list() answer: Upgrade only for upgrade === true; Donate always, enabled only for donate === true. */
export function pricingHtml(set) {
  const on = (id) => Boolean(set) && set[id] === true;
  return `
  <div class="head">${txt('span', 'tag', 'nav.pricing')}</div>
  <section class="np-hero">
    <div class="np-hero-copy">
      ${txt('p', 'np-hero-kicker', 'pricing.hero.kicker')}
      ${txt('h2', 'np-hero-title', 'pricing.hero.title')}
      ${txt('p', 'np-hero-body', 'pricing.hero.body')}
      ${on('donate') ? linkButton('donate', 'pricing.donate').replace('class="np-link"', 'class="np-link np-hero-btn"') : soonButton('donate', 'pricing.donate')}
    </div>
    <figure class="np-hero-art"><img class="np-hero-img" src="next/pricing-zumi.webp" width="720" height="720" alt="Zumi" draggable="false" loading="lazy"></figure>
  </section>
  <div class="np-plans">
    <section class="np-plan np-free">
      ${txt('h3', 'np-name', 'pricing.free.name')}
      ${bullets('free')}
    </section>
    <section class="np-plan np-cloud">
      <div class="np-top">${txt('h3', 'np-name', 'pricing.cloud.name')}<span class="dchip soon" data-i18n="pricing.cloud.badge">${esc(t('pricing.cloud.badge'))}</span></div>
      ${txt('p', 'np-price', 'pricing.cloud.price')}
      ${txt('p', 'np-trial', 'pricing.cloud.trial')}
      ${bullets('cloud')}
      ${on('upgrade') ? linkButton('upgrade', 'pricing.upgrade') : ''}
    </section>
  </div>
`;
}

/** Each [data-link] button asks the host to open its id; the page never sees the URL. */
export function wireLinks(root, links) {
  for (const btn of root.querySelectorAll('[data-link]')) {
    const id = btn.dataset.link;
    btn.addEventListener('click', () => { Promise.resolve(links.open(id)).catch((e) => console.error('pricing: open failed', id, e)); });
  }
}

/** Paints the card with no buttons, then again once links.list() answers. */
export function initPricing({ card, links }) {
  const sheet = document.createElement('link'); // build-renderer.mjs copies next/*.css with the rest of next/
  sheet.rel = 'stylesheet'; sheet.href = 'next/pricing.css';
  document.head.appendChild(sheet);
  const paint = (set) => {
    card.innerHTML = `<div class="frame np-sheet">${pricingHtml(set)}</div>`; wireLinks(card, links);
    // The image is a Zumi-only asset (scripts/lib/zumi-only.cjs): a public build has none, and the section stands on its copy and button.
    const img = card.querySelector('.np-hero-img');
    if (img) img.addEventListener('error', () => { img.closest('.np-hero').classList.add('np-hero-noart'); img.parentElement.remove(); });
  };
  paint({});
  Promise.resolve(links.list()).then((set) => paint(set)).catch((e) => console.error('pricing: links.list failed', e));
}
