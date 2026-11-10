// T-31 alpha.3 R5: the Pricing card (src/renderer/next/pricing.js) over the stage, opened by a rail item before Settings.
// A NEW check, not an extension of check-links / check-ui-lang / check-public-payload / check-next-ui-boots-without-next: the
// existing check scripts are frozen (check:brain-host BH-11e, CoS decision A). Plain Node: no Electron, no window, no network,
// nothing opened. The renderer is built into scratch dirs under out/check-runs.
//
//   node scripts/check-pricing.mjs
//
//   a. the card: two plan cards (Free (On your PC), Cloud memory with the "Coming soon" badge), no VND tier; with links.list()
//      stubbed all-false it renders no [data-link] button, stubbed {upgrade:true, donate:true} exactly two, each a type=button
//      with no href, and a click calls links.open(<its id>) and nothing else.
//   b. no payment surface: the built bundle, index.html and pricing.css carry no stripe / paypal / checkout / ko-fi /
//      buymeacoffee literal; pricing.js has no fetch(, no XMLHttpRequest, no window.open, no href, no URL.
//   c. i18n: en / vi / zh carry every pricing key, none empty (check:ui-lang pins the equal key sets), the owner's prices.
//   d. links.mjs: upgrade === '' and donate === '' in this build; every value is '' or an https:// URL with no query, no
//      fragment, no userinfo, no IP / localhost host and no owner or staging host (the P0 list, scripts/lib/public-p0.cjs).
//   e. the rail: boot.js adds the Pricing item before Settings only when zumi.links exists; the ZUMI_NEXT_UI=0 build carries
//      no Pricing card, the default (on) build does, with next/pricing.css.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkOutDir } from './lib/check-out-dir.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${detail ? '  ' + detail : ''}`); } };
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const exists = (...p) => fs.existsSync(path.join(ROOT, ...p));
const stable = (v) => JSON.stringify(v);
const OUT = checkOutDir('check-pricing');
const PRICING_JS = path.join(ROOT, 'src', 'renderer', 'next', 'pricing.js');
const KEYS = ['nav.pricing', 'pricing.free.name', 'pricing.free.b1', 'pricing.free.b2', 'pricing.free.b3',
  'pricing.cloud.name', 'pricing.cloud.badge', 'pricing.cloud.price', 'pricing.cloud.trial',
  'pricing.cloud.b1', 'pricing.cloud.b2', 'pricing.cloud.b3', 'pricing.upgrade', 'pricing.donate', 'links.comingSoon'];
const PAYMENT = /stripe|paypal|checkout|ko-fi|buymeacoffee/i;

// ---------------------------------------------------------------- a. the card
let mod = null;
try { mod = await import(pathToFileURL(PRICING_JS).href); } catch (e) { console.log(`  pricing.js: ${e.code || e.message}`); }
ok(Boolean(mod && typeof mod.pricingHtml === 'function' && typeof mod.wireLinks === 'function' && typeof mod.initPricing === 'function'),
  'a. src/renderer/next/pricing.js exports pricingHtml, wireLinks and initPricing');
const buttonsOf = (html) => html.match(/<button\b[^>]*>/g) || [];
const linkButtonsOf = (html) => buttonsOf(html).filter((b) => /\bdata-link=/.test(b));
if (mod && typeof mod.pricingHtml === 'function') {
  const { pricingHtml, wireLinks } = mod;
  const none = pricingHtml({ upgrade: false, donate: false });
  const both = pricingHtml({ upgrade: true, donate: true });
  ok(stable(mod.PRICING_LINK_IDS) === stable(['upgrade', 'donate', 'discord']), 'a. the card names only the upgrade, donate and discord link ids', stable(mod.PRICING_LINK_IDS));
  ok((none.match(/class="np-plan\b/g) || []).length === 2 && (both.match(/class="np-plan\b/g) || []).length === 2, 'a. exactly two plan cards');
  ok(/data-i18n="pricing\.free\.name"/.test(none) && /data-i18n="pricing\.cloud\.name"/.test(none), 'a. the plans are Free (On your PC) and Cloud memory');
  ok(/class="dchip soon"[^>]*data-i18n="pricing\.cloud\.badge"/.test(none), 'a. Cloud memory carries the "Coming soon" badge');
  ok(['b1', 'b2', 'b3'].every((b) => none.includes(`data-i18n="pricing.free.${b}"`) && none.includes(`data-i18n="pricing.cloud.${b}"`)), 'a. three bullets on each plan');
  ok(none.includes('data-i18n="pricing.cloud.price"') && none.includes('data-i18n="pricing.cloud.trial"'), 'a. Cloud memory shows its price and trial lines');
  ok(!/VND|₫|\bđ\b/i.test(both), 'a. no VND tier');
  // alpha.4 scope change (anh 30-10 05:10Z): Donate is always shown; while its link is empty it is disabled and reads "Coming soon".
  // Upgrade stays absent until its link is set. One Ko-fi donate link only (Ko-fi takes PayPal inside it): no second donate id.
  const disabledOnly = (html) => { const b = linkButtonsOf(html); return b.length === 1 && /data-link="donate"/.test(b[0]) && /\bdisabled\b/.test(b[0]) && /data-i18n="links\.comingSoon"/.test(html); };
  ok(disabledOnly(none), 'a. links.list() all-false -> one [data-link] button: Donate, disabled, "Coming soon" (links.comingSoon); no Upgrade', stable(linkButtonsOf(none)));
  ok(disabledOnly(pricingHtml({})) && disabledOnly(pricingHtml(null)), 'a. no list answer (empty or null) -> the same disabled Donate, no Upgrade');
  ok(disabledOnly(pricingHtml({ upgrade: 'yes', donate: 1 })), 'a. only a boolean true enables a button (a truthy non-boolean keeps Donate disabled, Upgrade absent)');
  const two = linkButtonsOf(both);
  ok(two.length === 2 && two.every((b) => !/\bdisabled\b/.test(b)) && !/links\.comingSoon/.test(both), 'a. links.list() {upgrade:true, donate:true} -> exactly two enabled [data-link] buttons, no "Coming soon"', stable(two));
  ok(stable(two.map((b) => (b.match(/data-link="([^"]*)"/) || [])[1]).sort()) === stable(['donate', 'upgrade']), 'a. the two buttons are upgrade and donate');
  ok(two.every((b) => /type="button"/.test(b) && !/\bhref\s*=/i.test(b)) && !/<a\b/i.test(both) && !/\bhref\s*=/i.test(both), 'a. each is a type=button with no href, and the card has no <a> / href at all');
  const upOnly = linkButtonsOf(pricingHtml({ upgrade: true, donate: false })), donOnly = linkButtonsOf(pricingHtml({ upgrade: false, donate: true }));
  ok(upOnly.length === 2 && upOnly.filter((b) => !/\bdisabled\b/.test(b)).length === 1 && donOnly.length === 1 && !/\bdisabled\b/.test(donOnly[0]), 'a. upgrade set -> Upgrade enabled + Donate disabled; donate set -> one enabled Donate', stable([upOnly, donOnly]));
  // J-05 (anh 09-11): Join Discord sits beside Donate in the hero, same row, and only when links.list() says discord === true.
  const heroBtns = (html) => (/<div class="np-hero-btns">([\s\S]*?)<\/div>/.exec(html) || [])[1] || '';
  const withDiscord = pricingHtml({ upgrade: false, donate: true, discord: true });
  const ids = (html) => linkButtonsOf(html).map((b) => (b.match(/data-link="([^"]*)"/) || [])[1]);
  ok(stable(ids(heroBtns(withDiscord))) === stable(['donate', 'discord']) && linkButtonsOf(heroBtns(withDiscord)).every((b) => !/disabled/.test(b)) && /data-i18n="settings\.joinDiscord"/.test(heroBtns(withDiscord)),
    'a. discord === true -> an enabled Join Discord button in the same .np-hero-btns row, right after Donate', stable(ids(heroBtns(withDiscord))));
  ok(!ids(none).includes('discord') && !ids(both).includes('discord') && stable(ids(heroBtns(pricingHtml({ donate: false, discord: false })))) === stable(['donate']) && stable(ids(heroBtns(pricingHtml({ donate: false, discord: 'yes' })))) === stable(['donate']),
    'a. discord unset / false / a truthy non-boolean -> no Join Discord button (Donate stays alone)');
  // wiring: a stub root with the two buttons; a click must call links.open(<id>) and only that
  const opened = [];
  const listeners = new Map();
  const fakeBtn = (id) => ({ dataset: { link: id }, addEventListener: (ev, fn) => listeners.set(id, { ev, fn }) });
  const root = { querySelectorAll: (sel) => (sel === '[data-link]' ? [fakeBtn('upgrade'), fakeBtn('donate')] : []) };
  const links = { open: (id) => { opened.push(id); return Promise.resolve(true); }, list: () => Promise.resolve({}) };
  try { wireLinks(root, links); } catch (e) { console.log(`  wireLinks: ${e.message}`); }
  ok([...listeners.values()].every((l) => l.ev === 'click') && listeners.size === 2, 'a. both buttons get a click listener');
  for (const [, l] of listeners) l.fn();
  ok(stable(opened) === stable(['upgrade', 'donate']), 'a. a click calls zumi.links.open(<its id>) with the id only', stable(opened));
}
const pricingSrc = exists('src', 'renderer', 'next', 'pricing.js') ? read('src', 'renderer', 'next', 'pricing.js') : '';
ok(/links\.list\(\)/.test(pricingSrc) && /pricingHtml\(set\)/.test(pricingSrc) && /wireLinks\(card, links\)/.test(pricingSrc), 'a. initPricing paints from links.list() and wires the buttons it painted');

// ---------------------------------------------------------------- b. no payment surface
ok(pricingSrc !== '' && !/\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|window\.open|location\s*[.=]|\bhref\b(?!=)|https?:\/\//.test(pricingSrc.replace(/sheet\.href = 'next\/pricing\.css'/, '')),
  'b. pricing.js: no fetch(, no XMLHttpRequest / WebSocket / sendBeacon, no window.open, no navigation, no href but its stylesheet, no URL');
ok(pricingSrc !== '' && !PAYMENT.test(pricingSrc), 'b. pricing.js: no stripe / paypal / checkout / ko-fi / buymeacoffee literal');
const build = (dir, nextUi) => {
  try {
    const env = { ...process.env, ZUMI_RENDERER_OUT: dir };
    if (nextUi === null) delete env.ZUMI_NEXT_UI; else env.ZUMI_NEXT_UI = nextUi;
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-renderer.mjs')], { cwd: ROOT, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return true;
  } catch (e) { console.log(`  build-renderer (${nextUi}): ${(e && e.message) || e}`); return false; }
};
const onDir = path.join(OUT, 'renderer-on');
const offDir = path.join(OUT, 'renderer-off');
const builtOn = build(onDir, null);
ok(builtOn, 'b. the renderer builds (default, next UI on) into the scratch dir');
if (builtOn) {
  const js = fs.readFileSync(path.join(onDir, 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(onDir, 'index.html'), 'utf8');
  const css = fs.existsSync(path.join(onDir, 'next', 'pricing.css')) ? fs.readFileSync(path.join(onDir, 'next', 'pricing.css'), 'utf8') : null;
  ok(!PAYMENT.test(js), 'b. the built app.js carries no stripe / paypal / checkout / ko-fi / buymeacoffee literal', (js.match(PAYMENT) || [''])[0]);
  ok(!PAYMENT.test(html), 'b. the built index.html carries none either');
  ok(css !== null && !PAYMENT.test(css), 'b. next/pricing.css is built and carries none either');
  // ---------------------------------------------------------------- e. the default build carries the card
  ok(/next-pricing/.test(js) && css !== null, 'e. the default (next UI on) build carries the Pricing card and next/pricing.css');
}
const builtOff = build(offDir, '0');
ok(builtOff, 'e. the renderer builds with ZUMI_NEXT_UI=0');
if (builtOff) {
  const js = fs.readFileSync(path.join(offDir, 'app.js'), 'utf8');
  ok(!/next-pricing|np-plan|data-link|pricing\.css/.test(js) && !fs.existsSync(path.join(offDir, 'next')), 'e. the ZUMI_NEXT_UI=0 build has no Pricing card, no link buttons and no next/ dir');
}

// ---------------------------------------------------------------- c. i18n
let i18n = null;
try { i18n = await import(pathToFileURL(path.join(ROOT, 'src', 'renderer', 'i18n.js')).href); } catch (e) { console.log(`  i18n.js: ${e.message}`); }
if (i18n) {
  for (const lang of ['en', 'vi', 'zh']) {
    const table = i18n.TABLES[lang] || {};
    const missing = KEYS.filter((k) => typeof table[k] !== 'string' || table[k].trim() === '');
    ok(missing.length === 0, `c. ${lang} carries every pricing key, none empty`, stable(missing));
    ok(/\b5 USD\b/.test(table['pricing.cloud.price'] || '') && /\b36 USD\b/.test(table['pricing.cloud.price'] || '') && /14/.test(table['pricing.cloud.trial'] || ''),
      `c. ${lang}: Cloud memory is 5 USD / month or 36 USD / year, 14-day trial`, stable([table['pricing.cloud.price'], table['pricing.cloud.trial']]));
    ok(!KEYS.some((k) => PAYMENT.test(table[k] || '') || /https?:\/\/|VND|₫/i.test(table[k] || '')), `c. ${lang}: no payment brand, URL or VND in the pricing strings`);
  }
  ok(!/\banh\b/i.test(KEYS.map((k) => i18n.TABLES.en[k] || '').join(' ')), 'c. no "anh" in the en pricing strings');
} else ok(false, 'c. i18n.js loads');

// ---------------------------------------------------------------- d. links.mjs values
let links = null;
try { links = await import(pathToFileURL(path.join(ROOT, 'tauri', 'sidecar', 'links.mjs')).href); } catch (e) { console.log(`  links.mjs: ${e.message}`); }
ok(Boolean(links && links.LINKS), 'd. tauri/sidecar/links.mjs exports LINKS');
if (links && links.LINKS) {
  const { LINKS } = links;
  ok(LINKS.upgrade === '' && LINKS.donate === 'https://ko-fi.com/zumi3k', 'd. this build ships an empty upgrade (hidden) and donate = the owner Ko-fi page (anh 30-10 06:38Z)', stable({ upgrade: LINKS.upgrade, donate: LINKS.donate }));
  ok(typeof links.linkList === 'function' && links.linkList().upgrade === false && links.linkList().donate === true, 'd. links.list() answers upgrade:false, donate:true');
  // The P0 list (owner and staging hosts) is owner-only (ZUMI_ONLY): the owner tree must have it, the public source has neither
  // it nor the owner values file, and its own export guard (check:public-payload X5-X6) scans links.mjs there.
  let p0 = null;
  try { p0 = createRequire(import.meta.url)('./lib/public-p0.cjs').P0_PATTERNS; } catch { p0 = null; }
  const ownerTree = exists('src', 'main', 'owner-values.json');
  ok(Boolean(p0) || !ownerTree, 'd. the P0 host list loads (owner tree)');
  const bad = [];
  for (const [id, v] of Object.entries(LINKS)) {
    if (v === '') continue;
    let u = null;
    try { u = new URL(v); } catch { bad.push(`${id}: not a URL`); continue; }
    if (u.protocol !== 'https:') bad.push(`${id}: not https`);
    if (u.search || v.includes('?')) bad.push(`${id}: has a query`);
    if (u.hash || v.includes('#')) bad.push(`${id}: has a fragment`);
    if (u.username || u.password || v.includes('@')) bad.push(`${id}: has userinfo`);
    if (/^(localhost|\d+\.\d+\.\d+\.\d+|\[.*\])$/i.test(u.hostname) || /\.local(host)?$/i.test(u.hostname)) bad.push(`${id}: local / IP host`);
    for (const [label, re] of p0 || []) if (re.test(v)) bad.push(`${id}: ${label}`);
  }
  ok(bad.length === 0 && Object.values(LINKS).every((v) => typeof v === 'string'), 'd. every links.mjs value is \'\' or https:// with no query, fragment, userinfo, local/IP, owner or staging host', stable(bad));
  // the rule itself bites: a staging-host URL, a query and userinfo must be caught by the same tests
  const probe = (v) => { const u = new URL(v); return u.protocol !== 'https:' || Boolean(u.search) || Boolean(u.username) || (p0 || []).some(([, re]) => re.test(v)); };
  ok(probe('https://x.example/?ref=1') && probe('https://u:p@x.example/') && probe('http://x.example/') && (!p0 || probe(`https://dev.${'zumia'}.space/pricing`)), 'd. negative control: a query, userinfo, http and a staging-host URL are each refused by the rule');
}

// ---------------------------------------------------------------- e. the rail item
const boot = read('src', 'renderer', 'next', 'boot.js');
ok(/import \{ initPricing \} from '\.\/pricing\.js';/.test(boot), 'e. boot.js imports initPricing');
const addFn = boot.slice(boot.indexOf('function addPricing'), boot.indexOf('function addPricing') + 1800);
ok(boot.includes('function addPricing') && /dataset\.next = 'pricing'/.test(addFn) && /\.tab\[data-tab="settings"\]'\)\.before\(btn\)/.test(addFn), 'e. the Pricing item (data-next="pricing") goes before the Settings tab');
ok(/if \(!\(zumi\.links && typeof zumi\.links\.list === 'function' && typeof zumi\.links\.open === 'function'\)\) return null;/.test(addFn), 'e. no zumi.links (Electron) -> no Pricing item');
ok(/addPricing\(\{/.test(boot.slice(boot.indexOf('export function initNextUi'))), 'e. initNextUi adds the Pricing item');
// alpha.4 item 1 (anh 30-10): a full page over the whole Zumi panel, not a card over the stage.
ok(/const panel = stage\.parentElement;/.test(addFn) && /panel\.appendChild\(card\)/.test(addFn) && /panel\.classList\.toggle\('nx-pricing-open', on\)/.test(addFn) && !/watch\(card/.test(addFn) && !/\bnx-card\b/.test(addFn),
  'e. alpha.4: the Pricing page is a child of the Zumi panel (not #stage, not an nx-card under the arm-yield loop) and toggles nx-pricing-open on the panel');
// T-31 alpha.12 (owner 01-11 09:38Z): Donate is its own hero section above the plans, with Zumi's image; same link id, same disabled state.
if (mod && typeof mod.pricingHtml === 'function') {
  const on = mod.pricingHtml({ donate: true }), off = mod.pricingHtml({});
  ok(/class="np-hero"/.test(on) && on.indexOf('np-hero') < on.indexOf('np-plans'), 'alpha.12: the hero section comes before the plans');
  ok(!/np-foot/.test(on) && (on.match(/data-link="donate"/g) || []).length === 1 && /class="np-link np-hero-btn" data-link="donate"/.test(on), 'alpha.12: one Donate button, in the hero, with the same link id');
  ok(/<img class="np-hero-img" src="next\/pricing-zumi\.webp"/.test(on), 'alpha.12: the hero carries the Zumi image');
  ok(/class="np-link np-hero-btn" data-link="donate" disabled/.test(off), 'alpha.12: with no donate link the hero button is disabled ("Coming soon"), as before');
}
ok(exists('assets', 'pricing', 'pricing-zumi.webp') && fs.statSync(path.join(ROOT, 'assets', 'pricing', 'pricing-zumi.webp')).size < 200 * 1024, 'alpha.12: the hero image exists and is under 200 KB');
ok(/\*\*\/pricing-zumi\.webp/.test(read('scripts', 'lib', 'zumi-only.cjs')) && /publicFlavour\) fs\.rmSync\(path\.join\(uiDir, 'next', 'pricing-zumi\.webp'\)/.test(read('tauri', 'prep-ui.mjs')), 'alpha.12: the hero image is Zumi-only: left out of a public frontendDist');
const pcss = exists('src', 'renderer', 'next', 'pricing.css') ? read('src', 'renderer', 'next', 'pricing.css') : '';
ok(/#tab-zumi\.nx-pricing-open > :not\(#next-pricing\) \{ visibility: hidden; \}/.test(pcss), 'e. alpha.4: pricing.css hides everything else in the Zumi panel (stage, toolbar, composer) by visibility only, so the stage keeps its layout');
ok(/\.nx-pricing \{[^}]*position: absolute; inset: 0;[^}]*background: var\(--background\);/.test(pcss), 'e. alpha.4: the page covers the panel (inset 0) on the theme background token');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
