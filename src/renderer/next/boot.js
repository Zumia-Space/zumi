// Next-version UI entry (T-31 Track 2; decision record 2026-10-27 "next-version path flag").
// app.js imports this file only when the build constant ZUMI_NEXT_UI is on (scripts/build-renderer.mjs); with it off,
// esbuild drops that one line and the packager drops src/renderer/next/**, so nothing of the next UI is left in the build.
// Everything the next UI adds to the shell is created HERE, so the existing files (index.html, app.js) hold no markup for it.
import { apply, t } from '../i18n.js';
import { armScreenPoints } from '../hud/clearance.js';
import { initSkills } from './skills/page.js';
import { initBrain } from './brain/brain.js';
import { setDevSource, setDevMedia } from './brain/board-data.js';
import { THEMES, readTheme, saveTheme, applyTheme } from '../theme.js';
import { initPricing } from './pricing.js';
import { maybeShowSoulOnboarding, loadSoulAddress } from './brain/soul.js';
import { isReadOnlyRun } from './skills/store.js';
import { isPublicBuild } from '../public-build.js';
import { memoryAvailable } from './brain/memory-list.js';
import { hasLearnedSkill } from './skills/derive.js';

const NAV_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="13" height="9" rx="1.3"/><path d="M7 18h5M9.5 14v4"/><rect x="18" y="8" width="3.2" height="9" rx=".8"/></svg>';
// Look A concept A-1: a card over the room, beside the stage like the HUD panels. Static: no link, no image, no network, no waitlist.
const DEVICES_CARD = `
  <div class="head"><span class="tag" data-i18n="nav.devices">Devices</span><span class="sp"></span><span class="meta">3</span></div>
  <div class="dev">
    <div class="ic"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><circle cx="9" cy="11" r="1.3" fill="currentColor"/><circle cx="15" cy="11" r="1.3" fill="currentColor"/><path d="M9.5 15c1.5 1 3.5 1 5 0"/></svg></div>
    <div class="nm" data-i18n="devices.robot">Robot</div>
    <div class="st"><span class="dchip progress" data-i18n="devices.progress">IN PROGRESS</span></div>
    <div class="scan live" aria-hidden="true"><i></i></div>
  </div>
  <div class="dev soon">
    <div class="ic"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="3" width="10" height="18" rx="2"/><path d="M11 18h2"/></svg></div>
    <div class="nm" data-i18n="devices.mobile">Mobile</div>
    <div class="st"><span class="dchip soon" data-i18n="devices.soon">COMING SOON</span></div>
  </div>
  <div class="dev soon">
    <div class="ic"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="12" rx="1.5"/><path d="M8 20h8M12 17v3"/></svg></div>
    <div class="nm" data-i18n="devices.tv">TV</div>
    <div class="st"><span class="dchip soon" data-i18n="devices.soon">COMING SOON</span></div>
  </div>`;

// Arm clearance, the same rule as the HUD panels (hud/hud.js yieldLoop, 06-10 "no body part behind or through a panel"): while the
// card is open, both arms are projected to the screen every frame (clearance.js) and the card fades out at once when an arm comes
// within YIELD_PX of it, back YIELD_HOLD_MS after the arm has left. The loop runs only while the card is open.
const YIELD_PX = 90;
const YIELD_HOLD_MS = 450;
// Skills tree card, windows up to 1000 px: the free zone right of the resting arm is only about 70 px wider than the card at 916x639, so the
// 90 px reach cannot hold there (geometry, not tuning: see the layout note in theme-a.css). Wider windows use the normal reach.
const YIELD_PX_NARROW = 24;
const NARROW = window.matchMedia('(max-width: 1000px)');

const BRAIN_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="7" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="12" cy="13" r="2.3"/><circle cx="6" cy="18" r="2"/><circle cx="19" cy="17" r="2"/><path d="M7.7 8l3 3.6M16.3 7.3l-3 4.4M10 14.4l-2.5 2.4M14 14.2l3.5 1.6"/></svg>';
const SKILLS_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5" r="2"/><circle cx="6" cy="14" r="2"/><circle cx="18" cy="14" r="2"/><circle cx="12" cy="20" r="1.6"/><path d="M12 7v4M12 11l-5 2.4M12 11l5 2.4M12 11v7"/></svg>';

/** The core "No model yet" panel (#empty-model .card, centred in the stage) must never sit under the Skills tree card. The layout keeps the
 *  tree in the right zone, so they do not meet at any window size we ship; this is the guard for the case that one day they would (a longer
 *  locale, a wider panel): the tree collapses to its head strip, which stays at the top where the panel never is. The test is on the
 *  horizontal ranges against the tree's full height, so it does not flap when the card shrinks. */
function collapseOverEmpty(tree) {
  const card = document.querySelector('#empty-model:not([hidden]) .card');
  const b = card ? card.getBoundingClientRect() : null;
  const t = tree.getBoundingClientRect();
  const meet = Boolean(b && b.width > 0 && b.right + 8 > t.left && b.left - 8 < t.right);
  tree.classList.toggle('nx-collapsed', meet);
}

/** Skills (T-31 slice 2, concept A-2): a sidebar item before Devices and two cards over the stage, like the Devices card: the header
 *  card on the left, the tree card on the right, the room visible between them. skills/page.js (initSkills) fills them and finds the item
 *  by [data-next="skills"]. The item carries data-next, not data-tab, because the app wired its own tab handlers before this ran: a click
 *  opens the Zumi stage (the app's own switch) and shows the cards on it. `watch` puts each card under the arm-clearance rule. */
function addSkills({ $, stage, zumiTab, before, watch }) {
  const btn = document.createElement('button');
  btn.className = 'tab'; btn.dataset.next = 'skills'; btn.title = 'Skills'; btn.setAttribute('data-i18n-title', 'nav.skills');
  btn.innerHTML = `${SKILLS_ICON}<span data-i18n="nav.skills">Skills</span>`;
  before.before(btn);
  const card = (id, extra, label) => {
    const c = document.createElement('aside');
    c.id = id; c.className = `frame nx-card nx-skills ${extra}`; c.hidden = true; c.setAttribute('aria-label', label);
    stage.appendChild(c);
    return c;
  };
  const head = card('next-skills-head', 'nx-skills-head', t('nav.skills'));
  const tree = card('next-skills-tree', 'nx-skills-tree', t('nav.skills'));
  apply(btn);
  const setOpen = (open) => {
    head.hidden = tree.hidden = !open;
    stage.classList.toggle('nx-skills-open', open); // theme-a.css: the HUD groups step aside so they never overlap the cards
    watch(head, open); watch(tree, open, () => (NARROW.matches ? YIELD_PX_NARROW : YIELD_PX), collapseOverEmpty);
  };
  btn.addEventListener('click', () => {
    zumiTab.click(); // the app's own switch: Zumi panel on, every .tab (this one too) inactive
    btn.classList.add('active'); zumiTab.classList.remove('active');
    setOpen(true);
  });
  // Any other tab click (the app's handler toggles .active on every .tab, ours included) closes the cards.
  $('sidebar').addEventListener('click', () => setOpen(btn.classList.contains('active')));
  return btn;
}

/** Brain (T-31 slice 3, concept A-1): the third sidebar item, right after Board (Zumi, Board, Brain, Skills, Devices, Settings) and one card over the stage,
 *  on the right like the Skills tree card. brain/brain.js (initBrain) fills it. Same click rule as the other items: the app's own
 *  switch opens the Zumi stage, the card shows on it, any other tab click closes it. `watch` puts it under the arm-clearance rule
 *  (reach by window class) and the collapse-over-the-No-model-panel guard, exactly as the Skills tree card. */
// Tasks reads the Board, which a public build does not show. Memory only where this host has it: the fallback card explains Tauri and Electron.
const publicBrainTabs = () => (memoryAvailable() ? ['memory', 'soul'] : ['soul']);

function addBrain({ $, stage, zumiTab, watch, info }) {
  const btn = document.createElement('button');
  btn.className = 'tab'; btn.dataset.next = 'brain'; btn.title = 'Brain'; btn.setAttribute('data-i18n-title', 'nav.brain');
  btn.innerHTML = `${BRAIN_ICON}<span data-i18n="nav.brain">Brain</span>`;
  document.querySelector('.tab[data-tab="board"]').after(btn); // the third item, as in concept A-1 (Zumi, Board, Brain, ...)
  const card = document.createElement('aside');
  card.id = 'next-brain'; card.className = 'frame nx-card nx-brain'; card.hidden = true;
  stage.appendChild(card);
  apply(btn);
  let ownerAdmin = false; // only decides the `local` flag of the board URL (app.js withEmbedLang)
  const brain = initBrain({ card, isOwner: () => ownerAdmin, tabIds: isPublicBuild(info) ? publicBrainTabs() : undefined });
  loadSoulAddress(); // before any line can fail: a turn's error line uses her words too
  // Dev runs only (the app is not packaged): the screenshot harness can hand Brain a board state through window.__zumiNext.brain, the same way
  // app.js exposes window.__zumiHud. A packaged build never installs it, and Brain has no other source than window.zumi.board.state.
  window.zumi.info().then((info) => {
    ownerAdmin = Boolean(info && info.ownerAdmin);
    if (info && info.packaged === false) window.__zumiNext = { brain: { setDevSource, setDevMedia } };
  }).catch((e) => console.error('next-ui: brain info failed', e));
  const setOpen = (open) => {
    const was = !card.hidden;
    card.hidden = !open;
    stage.classList.toggle('nx-brain-open', open); // brain.css: the HUD groups step aside so they never overlap the card
    watch(card, open, () => (NARROW.matches ? YIELD_PX_NARROW : YIELD_PX), collapseOverEmpty); // the same reach and guard as the Skills tree card (slice 2)
    if (open && !was) brain.opened();
  };
  btn.addEventListener('click', () => {
    zumiTab.click();
    btn.classList.add('active'); zumiTab.classList.remove('active');
    setOpen(true);
  });
  $('sidebar').addEventListener('click', () => setOpen(btn.classList.contains('active')));
  return { btn, brain };
}

const PRICING_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 12.6V4.5a1 1 0 0 1 1-1h8.1l8 8a1 1 0 0 1 0 1.4l-7.7 7.7a1 1 0 0 1-1.4 0z"/><circle cx="8" cy="8" r="1.6"/></svg>';

/** Pricing (T-31 alpha.3 R5, a full page since alpha.4): a sidebar item right before Settings and one page over the whole Zumi panel.
 *  owner 30-10: while it is open the avatar, the room, the HUD, the stage toolbar and the composer are
 *  hidden (pricing.css, visibility only: the stage keeps its size and keeps running, so closing restores it exactly as it was). The page is
 *  not an nx-card and not under the arm-yield loop: nothing moves behind it. pricing.js (initPricing) fills it. The page's only actions are
 *  the host's fixed links (zumi.links, R4), so without that surface (Electron: src/main is frozen and its preload has no links) the item is
 *  not added at all. Same click rule as the other items. */
function addPricing({ $, stage, zumiTab }) {
  const zumi = window.zumi;
  if (!(zumi.links && typeof zumi.links.list === 'function' && typeof zumi.links.open === 'function')) return null;
  const btn = document.createElement('button');
  btn.className = 'tab'; btn.dataset.next = 'pricing'; btn.title = 'Pricing'; btn.setAttribute('data-i18n-title', 'nav.pricing');
  btn.innerHTML = `${PRICING_ICON}<span data-i18n="nav.pricing">Pricing</span>`;
  document.querySelector('.tab[data-tab="settings"]').before(btn);
  const panel = stage.parentElement; // #tab-zumi: the page covers the toolbar and the composer too, not only the stage
  const card = document.createElement('aside');
  card.id = 'next-pricing'; card.className = 'nx-pricing'; card.hidden = true;
  card.setAttribute('aria-label', t('nav.pricing')); card.setAttribute('data-i18n-aria', 'nav.pricing');
  panel.appendChild(card);
  initPricing({ card, links: zumi.links });
  apply(btn); apply(card);
  const setOpen = (on) => {
    card.hidden = !on;
    panel.classList.toggle('nx-pricing-open', on); // pricing.css: everything else in the panel is hidden while the page is open
  };
  btn.addEventListener('click', () => {
    zumiTab.click();
    btn.classList.add('active'); zumiTab.classList.remove('active');
    setOpen(true);
  });
  $('sidebar').addEventListener('click', () => setOpen(btn.classList.contains('active')));
  return btn;
}

/** Adds the Devices item to the sidebar and its card over the stage. Runs after app.js has wired the existing tabs, so the item
 *  carries data-next (not data-tab); a click opens the Zumi stage (the app's own tab switch) and shows the card on it. */
export function initNextUi({ $, engine, info }) {
  document.documentElement.classList.add('zumi-next'); // the build already sets it (no flash); this keeps a non-built load right
  applyTheme(readTheme()); // app.js already did at the top of main(); this keeps a non-built load right too (same value, no event)
  const stage = $('stage');
  const zumiTab = document.querySelector('.tab[data-tab="zumi"]');
  const btn = document.createElement('button');
  btn.className = 'tab'; btn.dataset.next = 'devices'; btn.title = 'Devices'; btn.setAttribute('data-i18n-title', 'nav.devices');
  btn.innerHTML = `${NAV_ICON}<span data-i18n="nav.devices">Devices</span>`;
  document.querySelector('.tab[data-tab="settings"]').before(btn);
  if (isPublicBuild(info)) btn.hidden = true; // nothing usable yet: Robot in progress, Mobile and TV coming
  const card = document.createElement('aside');
  card.id = 'next-devices'; card.className = 'frame nx-card'; card.hidden = true;
  card.setAttribute('aria-labelledby', 'next-devices-title');
  card.innerHTML = DEVICES_CARD;
  card.querySelector('.tag').id = 'next-devices-title';
  stage.appendChild(card);
  apply(btn); apply(card);

  // One rAF loop for every open card (Devices, and the two Skills cards): each fades on its own when an arm comes near it.
  // Seated at the desk, her arm is inside the right-hand card's reach, so the fade held Brain at opacity 0 for as long as it was open. A stranger gets a
  // tab that opens; an arm behind a card is the smaller fault.
  const stayVisible = isPublicBuild(info);
  const open = new Map(); // card -> { at: time an arm was last near it, reach: px, guard?: (card) => void run every frame }
  let raf = 0;
  const yieldLoop = () => {
    if (!open.size) { raf = 0; return; }
    raf = requestAnimationFrame(yieldLoop);
    const now = performance.now();
    const arms = armScreenPoints(engine, $('stage-canvas'));
    for (const [c, st] of open) {
      // R2: the full-width Brain detail is always "near" an arm and covers the No model yet panel by design (the owner wants the agent as
      // background there), so neither the fade nor the collapse guard applies to it.
      if (c.classList.contains('nx-brain-full')) { c.classList.remove('nx-yield', 'nx-collapsed'); continue; }
      if (st.guard) st.guard(c);
      if (stayVisible) continue;
      const b = c.getBoundingClientRect(), r = typeof st.reach === 'function' ? st.reach() : st.reach;
      const near = arms.some((p) => p.x > b.left - r && p.x < b.right + r && p.y > b.top - r && p.y < b.bottom + r);
      if (near) { c.classList.add('nx-yield'); st.at = now; }
      else if (c.classList.contains('nx-yield') && now - st.at > YIELD_HOLD_MS) c.classList.remove('nx-yield');
    }
  };
  const watch = (c, on, reach = YIELD_PX, guard) => {
    if (on) { if (!open.has(c)) open.set(c, { at: 0, reach, guard }); if (!raf) raf = requestAnimationFrame(yieldLoop); } else { open.delete(c); c.classList.remove('nx-yield', 'nx-collapsed'); }
  };
  const setOpen = (on) => {
    card.hidden = !on;
    stage.classList.toggle('nx-devices-open', on); // theme-a.css: the HUD's left group steps aside so the two never overlap
    watch(card, on);
  };
  btn.addEventListener('click', () => {
    zumiTab.click(); // the app's own switch: Zumi panel on, every .tab (this one too) inactive
    btn.classList.add('active'); zumiTab.classList.remove('active');
    setOpen(true);
  });
  // Any other tab click (the app's handler toggles .active on every .tab, ours included) closes the card.
  $('sidebar').addEventListener('click', () => setOpen(btn.classList.contains('active')));
  addSkills({ $, stage, zumiTab, before: btn, watch });
  addBrain({ $, stage, zumiTab, watch, info });
  addThemeSetting($);
  if (!isPublicBuild(info)) addPricing({ $, stage, zumiTab }); // after Devices, so the rail reads ..., Devices, Pricing, Settings
  initSkillsPage({ $, engine }).catch((e) => console.error('next-ui: skills init failed', e));
  initSoulOnboarding(stage).catch((e) => console.error('next-ui: soul onboarding failed', e));
}

/** First run (T-31 alpha.12, PLAN-ZUMI-WATCH v2 C.1): the two soul cards over the room, until the user saves or skips once. Never in a
 *  self-test / demo / shots / probe run (the same run flags the Skills store honours), so measured runs and screenshots are unchanged
 *  unless a run asks for the cards (info.soulOnboarding, the shots harness only). */
async function initSoulOnboarding(stage) {
  const info = await window.zumi.info();
  if (!(isReadOnlyRun(info) && !(info && info.soulOnboarding))) await maybeShowSoulOnboarding(stage);
  document.dispatchEvent(new CustomEvent('zumi:onboarding-done'));
}

/** Settings > App > Appearance (R1): the one theme select (blue / black / white). Built here, not in index.html, so a build without next/ shows
 *  no control that does nothing. The pick is renderer-only (theme.js: localStorage zumi.theme); applyTheme re-applies the class and app.js
 *  reloads an open Board so it reads the new #theme= fragment. */
function addThemeSetting($) {
  const panel = $('stabpanel-app');
  if (!panel || $('appearance-card')) return;
  const card = document.createElement('section');
  card.className = 'card'; card.id = 'appearance-card';
  card.innerHTML = `
    <div class="ghead"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17"/><path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor"/></svg><h2 data-i18n="settings.appearance">Appearance</h2></div>
    <div class="srow">
      <div class="lbl"><div class="k"><label for="theme-select" data-i18n="settings.theme">Theme</label></div><div class="d" data-i18n="settings.themeD">Colours of the whole app, including the Board tab</div></div>
      <div class="ctl"><select id="theme-select" aria-label="Theme" data-i18n-aria="settings.theme">${THEMES.map((v) => `<option value="${v}" data-i18n="theme.${v}">${v}</option>`).join('')}</select></div>
    </div>`;
  panel.prepend(card);
  apply(card);
  const select = card.querySelector('#theme-select');
  select.value = readTheme();
  select.addEventListener('change', () => {
    select.value = applyTheme(saveTheme(select.value)); // an unknown value snaps back to the stored one
  });
}

/** Skills progress store + page (T-31 slice 2). Pokes and pat starts feed the Touch node; the store writes nothing in self-test /
 *  demo / shots / probe runs (info flags, skills/store.js isReadOnlyRun). Model names on the crew nodes come from role-models'
 *  nameFromId (the page's default); the provider's own short name would need the roleModels handle that app.js keeps. */
async function initSkillsPage({ $, engine }) {
  const zumi = window.zumi;
  const info = await zumi.info();
  const tab = document.querySelector('.tab[data-next="skills"]');
  const hideSkillsUntilEarned = (view) => { if (tab && isPublicBuild(info)) tab.hidden = !hasLearnedSkill(view); };
  const skills = initSkills({ zumi, $, info, onView: hideSkillsUntilEarned });
  if (!skills) return;
  engine.on('reaction', (r) => { if (r && r.trigger === 'poke') skills.touch(); });
  engine.on('state', (st) => { if (st && st.name === 'pat' && st.on) skills.touch(); });
}

