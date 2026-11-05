// Settings A2 page shots (T-31 settings-a2): the whole Settings column, driven through its real controls, in the
// installed-build view, against main's --settings-shots fixtures (provider, voice-model state, sample usage ledger).
// Captures every viewport page of the scroll (named by scrollTop, so a stitcher can rebuild the full column) at the
// default 1280x800 content size and at the narrowest window, in English and Vietnamese, and checks the A2 contract
// on each: one card width, three type sizes, no clipped/wrapped/outside-card control, no internal id on screen.
// Called from settings-roles.js (same --settings-shots run) before the Models-by-role sequence.
import { t } from '../i18n.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CARD_ORDER = ['account-card', 'brain-card', 'roles-card', 'voice-card', 'privacy-card', 'usage-card', 'room-card', 'developer-card'];
// Text that must never reach the screen: provider/model ids, raw voice ids, task codes, file names of the app's own data.
const ID_PATTERNS = [/\b[a-z0-9][\w.-]+\/[a-z0-9][\w.:-]+/i, /\baf_[a-z]+/i, /\bjev-\d/i, /\b[A-Z]-\d{2}\b/, /\.(json|jsonl|mjs|bin|import)\b/i];

export async function runSettingsPageShots({ zumi, $, check, capture, log, minWindow }) {
  const root = $('tab-settings');
  const col = root.querySelector('.settings');
  const visible = (n) => n.getClientRects().length > 0;
  const name = (n) => `${n.id ? `#${n.id}` : n.className || n.tagName}:${(n.textContent || n.value || '').trim().slice(0, 24)}`;

  function measure() {
    const cards = [...col.children].filter((c) => c.classList.contains('card') && visible(c));
    const widths = [...new Set(cards.map((c) => Math.round(c.getBoundingClientRect().width)))];
    const sizes = new Set();
    for (const n of root.querySelectorAll('*')) {
      if (!visible(n)) continue;
      if ([...n.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim()) || n.matches('input[type="text"], input[type="password"], select')) sizes.add(getComputedStyle(n).fontSize);
    }
    const problems = [];
    for (const n of root.querySelectorAll('button, .pill, select, th, td, .val, input[type="text"], input[type="password"]')) {
      if (!visible(n)) continue;
      const isText = n.tagName === 'BUTTON' || n.classList.contains('pill') || n.classList.contains('val') || n.tagName === 'TH';
      if (isText && n.scrollWidth > n.clientWidth + 1) problems.push(`clipped ${name(n)} ${n.scrollWidth}>${n.clientWidth}`);
      const card = n.closest('.card');
      if (card) {
        const r = n.getBoundingClientRect();
        const c = card.getBoundingClientRect();
        if (r.right > c.right + 0.5 || r.left < c.left - 0.5) problems.push(`outside-card ${name(n)}`);
      }
      if ((n.matches('button.ghost, button.primary, .lang-switch button') || n.classList.contains('pill')) && n.getBoundingClientRect().height > 31) problems.push(`two-line ${name(n)}`);
    }
    // A key field and its buttons, and every row's control group, sit on ONE line.
    for (const l of root.querySelectorAll('.line, .srow .ctl')) {
      if (!visible(l)) continue;
      const mids = new Set([...l.children].filter(visible).map((c) => { const r = c.getBoundingClientRect(); return Math.round(r.top + r.height / 2); }));
      if (mids.size > 1) problems.push(`line-wrap ${name(l)}`);
    }
    const texts = [];
    for (const n of root.querySelectorAll('*')) {
      if (!visible(n)) continue;
      for (const c of n.childNodes) if (c.nodeType === 3 && c.textContent.trim()) texts.push(c.textContent.trim());
      if (n.tagName === 'SELECT' && n.selectedOptions[0]) texts.push(n.selectedOptions[0].textContent);
      if (n.placeholder) texts.push(n.placeholder);
    }
    const ids = texts.filter((x) => ID_PATTERNS.some((re) => re.test(x)));
    const pin = $('board-pin-toggle-prompt');
    return {
      window: [innerWidth, innerHeight], widths, fonts: [...sizes].sort(), problems, ids,
      order: [...col.children].filter((c) => c.classList.contains('card') && visible(c)).map((c) => c.id),
      sideScroll: col.scrollWidth > col.clientWidth || document.documentElement.scrollWidth > innerWidth,
      langs: [...root.querySelectorAll('.toolbar #lang-switch button')].map((b) => b.textContent).join('/'),
      pinApply: getComputedStyle(pin).display,
      noWardrobe: !$('wardrobe-row') && !document.querySelector('.tab[data-tab="wardrobe"]') && !$('tab-wardrobe'),
      devButtons: ['sim-board', 'cam-register', 'look-tuning-toggle'].every((id) => $(id).hidden),
    };
  }

  // The A2 contract, checked on every state that gets captured.
  function contract(tag) {
    const m = measure();
    log(`${tag} ${JSON.stringify({ window: m.window, widths: m.widths, fonts: m.fonts, order: m.order.length })}`);
    check(m.widths.length === 1 && m.widths[0] === 520, `${tag}: every card is 520px`, JSON.stringify(m.widths));
    check(m.fonts.length <= 3 && m.fonts.every((f) => ['12px', '13px', '15px'].includes(f)), `${tag}: three type sizes only (15 / 13 / 12)`, JSON.stringify(m.fonts));
    check(!m.problems.length, `${tag}: no clipped, wrapped or outside-card control`, JSON.stringify(m.problems));
    check(!m.ids.length, `${tag}: no internal id / file name on screen`, JSON.stringify(m.ids));
    check(JSON.stringify(m.order) === JSON.stringify(CARD_ORDER), `${tag}: card order follows the A2 mock (Models by role right after AI brain)`, JSON.stringify(m.order));
    check(!m.sideScroll, `${tag}: no sideways scroll`);
    check(m.langs === 'EN/VI/中文', `${tag}: language switch EN / VI / 中文 in the header`, m.langs);
    check(m.pinApply === 'none', `${tag}: the PIN-apply row stays hidden (display:none)`, m.pinApply);
    check(m.noWardrobe && m.devButtons, `${tag}: no Wardrobe tab / panel / check row anywhere, dev buttons hidden (installed-build view)`);
    return m;
  }

  // Every viewport page of the column, top to bottom; the file name carries the scrollTop for the stitcher.
  async function capturePages(prefix) {
    const top = Math.round(col.getBoundingClientRect().top);
    const files = [];
    let y = 0;
    for (;;) {
      col.scrollTop = y;
      await sleep(150);
      const at = Math.round(col.scrollTop);
      files.push(await capture(`${prefix}-top${top}-s${String(at).padStart(4, '0')}.png`));
      if (at + col.clientHeight >= col.scrollHeight - 1) break;
      y = at + col.clientHeight - 60; // 60px overlap between pages
    }
    col.scrollTop = 0;
    return files;
  }
  // shots:resize sets the CONTENT size, but on the off-screen window the first call can land one window frame larger
  // (measured: 916x639 for a 900x600 request), so correct by the measured difference until the content size matches.
  async function resizeContent(w, h) {
    let rw = w;
    let rh = h;
    for (let i = 0; i < 4; i++) {
      await zumi.shots.resize(rw, rh);
      await sleep(600);
      if (innerWidth === w && innerHeight === h) return true;
      rw += w - innerWidth;
      rh += h - innerHeight;
    }
    return innerWidth === w && innerHeight === h;
  }
  const lang = async (code) => { document.querySelector(`#lang-switch button[data-lang="${code}"]`).click(); await sleep(450); };
  const setDetails = async (open) => { if ((($('usage-details-toggle').getAttribute('aria-expanded')) === 'true') !== open) $('usage-details-toggle').click(); await sleep(150); };

  // ---------- fixtures through the real UI ----------
  await zumi.shots.seedUsage();
  $('usage-refresh').click();
  await zumi.shots.voiceState('downloading');
  await sleep(1300); // the voice row polls main once a second

  // Account: a first sign-in through the real form ("Save and lock with PIN"), then Unlock in Privacy & PIN.
  check(!$('board-form').hidden && $('board-form-toggle').hidden && /Not set up/.test($('board-chip').textContent), 'account: before sign-in the form is open, pill "Not set up"', $('board-chip').textContent);
  contract('EN 1280x800 first run (sign-in form open)');
  await capture('a2-en-1280-00-first-run-account.png');
  $('board-user').value = 'shots-user'; $('board-pass').value = 'shots-pass'; $('board-pin').value = '246810'; $('board-pin-confirm').value = '246810';
  $('board-save').click(); await sleep(900);
  check($('board-form').hidden && !$('board-form-toggle').hidden && $('board-form-toggle').textContent === 'Change sign-in' && /Locked/.test($('board-chip').textContent),
    'account: after "Save and lock with PIN" the form folds behind "Change sign-in", pill "Locked"', `${$('board-chip').textContent} / ${$('board-note').textContent}`);
  check(['board-user', 'board-pass', 'board-pin', 'board-pin-confirm'].every((id) => $(id).value === ''), 'account: the credentials are cleared from the DOM after saving');
  $('board-form-toggle').click(); await sleep(150);
  check(!$('board-form').hidden && $('board-form-toggle').textContent === 'Cancel', 'account: "Change sign-in" opens the form again');
  $('board-form-toggle').click(); await sleep(150);
  check($('board-form').hidden && $('board-note').textContent === '', 'account: Cancel folds it and clears the line');
  $('board-unlock-pin').value = '246810'; $('board-unlock').click(); await sleep(700);
  check(/Signed in/.test($('board-chip').textContent) && /Unlocked/.test($('board-session-desc').textContent) && $('board-session-note').textContent === '',
    'privacy: Unlock in the Board session row -> pill "Signed in", the row itself reads "Unlocked"', `${$('board-chip').textContent} / ${$('board-session-desc').textContent}`);
  $('board-unlock-pin').value = '000000'; $('board-unlock').click(); await sleep(700);
  check(/Wrong PIN/.test($('board-session-note').textContent) && $('board-session-note').classList.contains('bad'), 'privacy: a wrong PIN shows its message under the Board session row', $('board-session-note').textContent);
  // Let the wrong-PIN backoff run out, then unlock again so the page shots show the settled state.
  for (let i = 0; i < 40 && $('board-unlock').disabled; i++) await sleep(250);
  $('board-unlock-pin').value = '246810'; $('board-unlock').click(); await sleep(700);
  check(/Signed in/.test($('board-chip').textContent) && $('board-session-note').textContent === '', 'privacy: the right PIN after that unlocks and clears the message', $('board-session-note').textContent);

  // ---------- AI brain: the real key flow, against main's shots-only fake provider endpoint ----------
  // Fake keys in OpenRouter's shape, built here (never a real key); the fake endpoint accepts only "shots-good".
  const SHOTS_GOOD = ['sk-or', 'v1', 'shots-good', '0'.repeat(24)].join('-');
  const SHOTS_BAD = ['sk-or', 'v1', 'shots-bad', '0'.repeat(24)].join('-');
  const showCard = async (id) => { $(id).scrollIntoView({ block: 'start' }); col.scrollTop -= 22; await sleep(200); };
  const keyNote = () => $('brain-key-note').textContent;
  const keyChip = () => $('brain-key-chip').textContent;
  const typeKey = async (v) => { $('brain-key-input').value = v; $('brain-key-save').click(); await sleep(700); };
  const noKeyOnPage = () => !document.body.innerText.includes(SHOTS_GOOD) && !document.body.innerText.includes(SHOTS_BAD) && $('brain-key-input').value === '';
  const opts = [...$('brain-provider').options].map((o) => `${o.textContent}${o.disabled ? ' (disabled)' : ''}${o.selected ? ' (selected)' : ''}`);
  check(JSON.stringify(opts) === JSON.stringify(['OpenRouter (selected)', 'More coming soon (disabled)']), 'AI brain: provider dropdown = OpenRouter selected + disabled "More coming soon"', JSON.stringify(opts));
  check(keyChip() === 'No key' && !$('brain-key-edit').hidden && $('brain-key-view').hidden && $('roles-grid').hidden, 'AI brain: fresh install -> "No key", the key field, and Models by role has no provider yet');
  // Tauri only: the preset's 18+ confirm gates Save (the card drops a key typed while it is closed), so tick it first like a user would.
  const ageBox = document.getElementById('brain-free-age18');
  if (ageBox && !ageBox.checked) { ageBox.checked = true; ageBox.dispatchEvent(new Event('change')); await sleep(300); }
  await showCard('brain-card');
  await capture('ai-brain-en-1-no-key.png');
  await typeKey('hello');
  check(/does not look like an OpenRouter key/.test(keyNote()) && $('brain-key-note').classList.contains('bad') && noKeyOnPage(), 'AI brain: a wrong-shape key -> a clear error, the field is emptied', keyNote());
  await typeKey(SHOTS_BAD);
  check(/refused this key/.test(keyNote()) && keyChip() === 'No key' && noKeyOnPage(), 'AI brain: a key the provider refuses (fake endpoint 401) -> error, nothing saved', keyNote());
  await capture('ai-brain-en-2-refused.png');
  // Provider unreachable (fake endpoint: network error): saved anyway, "Not checked" + Check again (Sol ruling b/c).
  const SHOTS_OFFLINE = ['sk-or', 'v1', 'shots-offline', '1'.repeat(24)].join('-');
  await typeKey(SHOTS_OFFLINE);
  check(keyChip() === 'Not checked' && !$('brain-key-check').hidden && /could not be reached/.test(keyNote()) && /ending 1111/.test($('brain-key-desc').textContent),
    'AI brain: provider unreachable -> saved, pill "Not checked", "Check again" shown', `${keyChip()} / ${keyNote()}`);
  await capture('ai-brain-en-2b-saved-not-checked.png');
  $('brain-key-check').click(); await sleep(700);
  check(keyNote() === t('settings.keyCheckUnreachable') && !$('brain-key-check').hidden && keyChip() === 'Not checked', 'AI brain: Check again while still offline -> says so, the button stays', keyNote());
  $('brain-key-change').click(); await sleep(150);
  await typeKey(SHOTS_GOOD);
  await sleep(600); // Models by role re-reads the provider on zumi:brain-key-changed
  check(/Key works/.test(keyNote()) && keyChip() === 'Saved' && /ending 0000/.test($('brain-key-desc').textContent) && !$('brain-key-view').hidden && $('brain-key-edit').hidden && /0000$/.test($('brain-key-mask').textContent),
    'AI brain: a working key -> "Key works", pill "Saved", only the last 4 shown (masked line)', `${keyNote()} / ${$('brain-key-desc').textContent}`);
  check($('brain-key-check').hidden, 'AI brain: a key known to work -> no "Check again" button');
  check(noKeyOnPage() && !document.body.innerText.includes(SHOTS_OFFLINE), 'AI brain: the key itself is nowhere on the page after saving (field emptied, only last 4)');
  check(!$('roles-grid').hidden && /OpenRouter/.test($('roles-status').textContent), 'AI brain -> Models by role: the provider appears at once (no restart)');
  await capture('ai-brain-en-3-key-works.png');
  $('brain-key-change').click(); await sleep(150);
  check(!$('brain-key-edit').hidden && !$('brain-key-cancel').hidden && $('brain-key-view').hidden, 'AI brain: Change -> an empty field with Save + Cancel');
  await capture('ai-brain-en-4-change.png');
  $('brain-key-cancel').click(); await sleep(150);
  check(!$('brain-key-view').hidden && keyChip() === 'Saved', 'AI brain: Cancel keeps the saved key');

  // ---------- Voice: Speed + Volume sliders, Play sample ----------
  const slide = (id, v) => { const r = $(id); r.value = String(v); r.dispatchEvent(new Event('input')); r.dispatchEvent(new Event('change')); };
  slide('voice-speed', 1.25); slide('voice-volume', 80); await sleep(500);
  const prefs = await zumi.talk.getVoicePrefs();
  check(prefs.speed === 1.25 && prefs.volume === 0.8 && $('voice-speed-val').textContent === '1.25×' && $('voice-volume-val').textContent === '80%', 'voice: Speed 1.25x + Volume 80% saved to settings.json and shown', JSON.stringify(prefs));
  // Play sample with the voice switched off: the real path answers "voice-off" (a shots run never downloads the model).
  $('voice-enabled').click(); await sleep(300);
  $('voice-sample').click(); await sleep(900);
  check(/Speak replies aloud/.test($('voice-sample-note').textContent) && !$('voice-sample').disabled, 'voice: Play sample with the voice off -> says how to turn it on', $('voice-sample-note').textContent);
  await showCard('voice-card');
  await capture('voice-en-1-sliders-sample-voice-off.png');
  $('voice-enabled').click(); await sleep(300);
  check($('voice-sample-note').textContent === '', 'voice: turning the voice back on clears that hint');
  await capture('voice-en-2-sliders.png');

  // ---------- the same two cards in Vietnamese ----------
  await lang('vi');
  await showCard('brain-card');
  check(keyChip() === t('settings.chipSaved') && t('settings.chipSaved') !== 'Saved' && $('brain-key-desc').textContent === t('settings.ownKeyEndingD', { provider: 'OpenRouter', last4: '0000' }), 'VI: AI brain repaints its state in Vietnamese', $('brain-key-desc').textContent);
  await capture('ai-brain-vi-1-saved.png');
  $('brain-key-change').click(); await sleep(150);
  await typeKey(SHOTS_BAD);
  check(keyNote() === t('settings.keyRejected') && keyChip() === t('settings.chipSaved'), 'VI: a refused key while changing -> Vietnamese error, the saved key stays', keyNote());
  await capture('ai-brain-vi-2-refused-while-changing.png');
  $('brain-key-cancel').click(); await sleep(150);
  await showCard('voice-card');
  await capture('voice-vi-1-sliders.png');
  await lang('en');

  // ---------- content checks ----------
  check($('brain-provider').selectedOptions[0].textContent === 'OpenRouter' && keyChip() === 'Saved' && /OpenRouter key ending 0000/.test($('brain-key-desc').textContent), 'AI brain: provider OpenRouter, key "Saved"', `${keyChip()} / ${$('brain-key-desc').textContent}`);
  check(!$('voice-en-name').hidden ? $('voice-en-name').selectedOptions[0].textContent === 'Heart' : /Windows|not ready/i.test($('voice-status').textContent), 'voice: English voice by its user-facing name ("Heart", never af_heart)', $('voice-en-name').hidden ? $('voice-status').textContent : $('voice-en-name').selectedOptions[0].textContent);
  check(!$('voice-kokoro-row').hidden && !$('voice-kokoro-bar').hidden && $('voice-kokoro-progress').textContent === '64%', 'voice: the English voice model row shows a bar + 64% while downloading');
  check(/No key/.test($('voice-leda-chip').textContent), 'voice: Vietnamese voice pill "No key" on a fresh install');
  const sum = [...$('usage-summary-body').rows].map((r) => [...r.cells].map((c) => c.textContent));
  check(sum.length === 3 && sum[0][0] === 'Today' && sum[0][1] === '85' && sum[1][1] === '411' && sum[2][1] === '411', 'usage: summary Today 85 / 7 days 411 / 30 days 411 calls (the seeded ledger)', JSON.stringify(sum));
  check($('usage-detail').hidden && $('usage-details-toggle').textContent.trim() === 'Details', 'usage: details start folded');
  await setDetails(true);
  const models = [...new Set([...$('usage-tbody').rows].map((r) => r.cells[1].textContent))];
  check(!$('usage-detail').hidden && $('usage-tbody').rows.length === 10 && JSON.stringify(models) === JSON.stringify(['DeepSeek V4 Flash', 'Jev 1.13']), 'usage: Details opens the day x model table with model NAMES (no ids)', JSON.stringify(models));

  // ---------- 1280x800, English ----------
  contract('EN 1280x800');
  await capturePages('a2-en-1280');

  // ---------- 1280x800, Vietnamese ----------
  await lang('vi');
  contract('VI 1280x800');
  await capturePages('a2-vi-1280');

  // ---------- narrowest window ----------
  await zumi.shots.resize(minWindow.width / 2, minWindow.height / 2); // below the minimum: the OS clamps it
  await sleep(600);
  log(`below-minimum request -> content ${innerWidth}x${innerHeight}`);
  check(await resizeContent(minWindow.width, minWindow.height), `narrowest window: content ${minWindow.width}x${minWindow.height}`, `${innerWidth}x${innerHeight}`);
  contract(`VI narrowest ${innerWidth}x${innerHeight}`);
  await capturePages('a2-vi-min');
  await lang('en');
  contract(`EN narrowest ${innerWidth}x${innerHeight}`);
  await capturePages('a2-en-min');

  // ---------- back to the default size; details folded; voice model ready ----------
  check(await resizeContent(1280, 800), 'back to the default 1280x800 content size', `${innerWidth}x${innerHeight}`);
  await setDetails(false);
  await zumi.shots.voiceState('ready'); await sleep(1300);
  check(!$('voice-kokoro-row').hidden && $('voice-kokoro-bar').hidden && /Ready/.test($('voice-kokoro-chip').textContent), 'voice: once ready, the row shows a "Ready" pill instead of the bar');
  contract('EN 1280x800 (details folded, voice ready)');
  col.scrollTop = 0; await sleep(150);
  await capture('a2-en-1280-01-top.png');
  $('voice-card').scrollIntoView({ block: 'start' }); col.scrollTop -= 22; await sleep(150);
  await capture('a2-en-1280-02-voice-privacy.png');
  $('usage-card').scrollIntoView({ block: 'start' }); col.scrollTop -= 22; await sleep(150);
  await capture('a2-en-1280-03-usage-room-developer.png');

  // The developer flag still reveals the dev-only controls (sidebar dev buttons); the Wardrobe is gone even with it on.
  $('dev-tools').click(); await sleep(400);
  check(!$('sim-board').hidden && !$('wardrobe-row') && !document.querySelector('.tab[data-tab="wardrobe"]'), 'developer flag on: dev buttons appear, still no Wardrobe tab or check row');
  col.scrollTop = col.scrollHeight; await sleep(150);
  await capture('a2-en-1280-04-dev-flag-on.png');
  $('dev-tools').click(); await sleep(400);
  check($('sim-board').hidden, 'developer flag off again: all hidden');
  col.scrollTop = 0;
}
