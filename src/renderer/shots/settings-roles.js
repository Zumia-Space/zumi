// Settings QC shots (T-31 board-roles): the "Models by role" card, driven through its real controls (chip click ->
// popover -> model row / effort button), against main's FIXTURE provider (--settings-shots only), in the
// installed-build view (no dev controls). Runs only when the app was started with --settings-shots (main.js), the
// same way room.js drives itself.
// T-31 zumi-roles: all four roles live with the Plan / Check / Look up switches (light + dark), then real chat turns
// through main's FIXTURE chat endpoint (shotsChatFetch: no real call) showing the "Planned" chip, the Check
// correction row and the Sources row, and the Usage card's per-role rows. The chat part needs a model on stage
// (start the run with --model <file.vrm>); voice is switched off first, so a shots run never plays audio.
import { runSettingsPageShots } from './settings-page.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runSettingsRolesShots({ zumi, $, roleModels, openSettingsTab, openZumiTab, talk, minWindow }) {
  const log = (m) => { console.log(`[settings-shots] ${m}`); zumi.shots.log(m); };
  const capture = (name) => zumi.shots.capture(name);
  const report = { ok: true, checks: [] };
  const check = (cond, name, detail = '') => { report.checks.push({ name, ok: Boolean(cond), detail }); if (!cond) report.ok = false; log(`${cond ? 'PASS' : 'FAIL'} ${name} ${detail}`); };
  const settingsCol = () => document.querySelector('#tab-settings .settings');
  const chipOf = (role) => document.querySelector(`#roles-grid .role-chip[data-role="${role}"]`);
  const clickModel = (short) => {
    const b = [...document.querySelectorAll('.role-pop .pop-list button')].find((x) => x.querySelector('.n').textContent === short);
    if (!b) throw new Error(`model row not found: ${short}`);
    b.click();
  };
  const clickEffort = (label) => {
    const b = [...document.querySelectorAll('.role-pop .lang-switch button')].find((x) => x.textContent === label);
    if (!b) throw new Error(`effort button not found: ${label}`);
    b.click();
  };
  const showCard = async () => {
    $('roles-card').scrollIntoView({ block: 'start' });
    settingsCol().scrollTop -= 12;
    await sleep(200);
  };
  const noSideScroll = () => {
    const s = settingsCol();
    const card = $('roles-card');
    return { window: [window.innerWidth, window.innerHeight], settings: [s.scrollWidth, s.clientWidth], card: [card.scrollWidth, card.clientWidth], page: [document.documentElement.scrollWidth, window.innerWidth] };
  };
  const fits = (w) => w.settings[0] <= w.settings[1] && w.card[0] <= w.card[1] && w.page[0] <= w.page[1];
  // Every text-bearing element in the card except its h2 (the shared card heading): body 13px, meta 12px only.
  const cardFontSizes = () => {
    const sizes = new Set();
    for (const n of $('roles-card').querySelectorAll('*')) {
      if (n.tagName === 'H2' || n.closest('[hidden]') || !n.childNodes.length) continue;
      if (![...n.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim())) continue;
      sizes.add(getComputedStyle(n).fontSize);
    }
    return [...sizes].sort();
  };

  try {
    openSettingsTab();
    await roleModels.refresh();
    await sleep(600);
    // ---- Settings A2: the whole page (EN/VI, 1280x800 + narrowest window), then this card's own sequence ----
    await runSettingsPageShots({ zumi, $, check, capture, log, minWindow });
    await showCard();

    // ---- installed-build view (CoS QC 09-10 item 4) ----
    check(['sim-board', 'cam-register', 'look-tuning-toggle'].every((id) => $(id).hidden), 'user build: Simulate / Camera registration / Look tuning hidden');
    check(!document.querySelector('.tab[data-tab="wardrobe"]') && !$('wardrobe-row'), 'user build: no Wardrobe tab, no Wardrobe check row');
    const head = [...document.querySelectorAll('#tab-settings .toolbar > *')].map((n) => n.id || n.className);
    check(JSON.stringify(head) === JSON.stringify(['title', 'sub', 'lang-switch']), 'Settings header: title, one line, language switch (no board line)', JSON.stringify(head));
    check(!/af_heart/.test($('voice-status').textContent), 'Voice line has no raw voice id', JSON.stringify($('voice-status').textContent));

    // ---- one card system ----
    const widths = [...document.querySelectorAll('#tab-settings .settings > .card')].filter((c) => c.offsetParent !== null).map((c) => Math.round(c.getBoundingClientRect().width));
    check(widths.length > 6 && widths.every((x) => x === widths[0]) && widths[0] === 520, 'Models by role is the same 520px width as every other card, Usage included', JSON.stringify(widths));
    const voice = document.querySelector('#voice-enabled').closest('.card');
    const pad = (c) => getComputedStyle(c.querySelector('.ghead')).padding;
    check(pad($('roles-card')) === pad(voice) && getComputedStyle($('roles-card').querySelector('h2')).fontSize === getComputedStyle(voice.querySelector('h2')).fontSize, 'same header padding + heading size as the Voice card', `${pad($('roles-card'))} / ${pad(voice)}`);
    const fs = cardFontSizes();
    check(fs.every((x) => x === '12px' || x === '13px'), 'card text uses 13px body + 12px meta only', JSON.stringify(fs));

    // ---- defaults: all four roles live, switches on ----
    const w = noSideScroll();
    log(`widths ${JSON.stringify(w)}`);
    check(fits(w), 'no horizontal scroll at the default window size', JSON.stringify(w));
    const v0 = await zumi.roles.get();
    check(v0.defaults.check.model !== v0.defaults.do.model && !v0.warnSameCheck, 'defaults: Check uses a different model than Do, no warning out of the box', `${v0.defaults.do.model} / ${v0.defaults.check.model}`);
    check(!document.querySelector('#roles-grid .warn'), 'defaults: no amber "!" anywhere');
    check(['plan', 'do', 'check', 'lookup'].every((r) => chipOf(r).tagName === 'BUTTON' && getComputedStyle(chipOf(r)).cursor === 'pointer' && chipOf(r).classList.contains('same')), 'all four roles live: Plan / Do / Check / Look up chips are buttons, each dimmed at its default');
    check(!/Coming soon/i.test($('roles-card').textContent) && !document.querySelector('#roles-grid .soon-tag'), 'no "Coming soon" anywhere in the card');
    const sws = [...document.querySelectorAll('#roles-grid .role-sw')];
    check(sws.map((x) => x.dataset.role).join() === 'plan,check,lookup' && sws.every((x) => x.checked && x.getAttribute('aria-label')), 'one on/off switch each for Plan / Check / Look up, all on by default; Do has none', sws.map((x) => `${x.dataset.role}:${x.checked}`).join());
    check(v0.defaults.plan.effort === 'low' && v0.roles.plan.effort === 'low', 'Plan defaults to effort Low', JSON.stringify(v0.defaults.plan));
    chipOf('check').click(); await sleep(250);
    const hint = document.querySelector('.role-pop .pop-hint');
    check(Boolean(document.querySelector('.role-pop')) && hint && /^Reviews long replies/.test(hint.textContent), 'the Check chip opens its picker, saying what Check is used for', hint && hint.textContent);
    await capture('03b-check-popover.png');
    document.body.click(); await sleep(200);
    const setCheck = await zumi.roles.set('check', { model: v0.defaults.check.model, effort: 'medium' });
    const unset = await zumi.roles.reset('check');
    check(setCheck && setCheck.ok && setCheck.roles.check.by === 'user' && unset && unset.ok && unset.roles.check.by === 'default', 'main accepts a Check change (wired) and "Use default" puts it back', JSON.stringify(setCheck && setCheck.roles.check));
    await roleModels.refresh(); await sleep(200);
    // Owner build only (T-31 role-ui-port step 7): one line pointing to the Board tab, where the lane models live.
    const appInfo = await zumi.info();
    check($('roles-board-link').hidden === !appInfo.ownerAdmin && (!appInfo.ownerAdmin || $('roles-board-link').getBoundingClientRect().height > 0), `owner line "Lane models per task -> Board": ${appInfo.ownerAdmin ? 'shown (owner build)' : 'hidden (release build)'}`);
    // Fable/Sol bridge gate condition 3: the PIN-off residual risk, next to the PIN toggle, owner build only.
    if (appInfo.ownerAdmin) {
      $('privacy-card').scrollIntoView({ block: 'start' }); settingsCol().scrollTop -= 12; await sleep(200);
    }
    check($('pin-off-risk').hidden === !appInfo.ownerAdmin && (!appInfo.ownerAdmin || $('pin-off-risk').getBoundingClientRect().height > 0), `owner line "PIN off: any app on this PC can change lane models...": ${appInfo.ownerAdmin ? 'shown (owner build)' : 'hidden (release build)'}`, $('pin-off-risk').textContent);
    if (appInfo.ownerAdmin) { await capture('privacy-pin-off-line.png'); await showCard(); }
    await capture('01-defaults.png');

    log('Do -> Gemini 3.8 Flash · Low, through the popover');
    chipOf('do').click(); await sleep(250);
    clickModel('Gemini 3.8 Flash'); await sleep(250);
    clickEffort('Low'); await sleep(250);
    document.body.click(); await sleep(200);
    check(!document.querySelector('.role-pop'), 'outside click closes the popover');
    check(Boolean(chipOf('do').querySelector('.dot')) && !chipOf('do').classList.contains('same') && /Default: DeepSeek V4 Flash · Fast/.test(chipOf('do').closest('.role-cell').textContent), 'Do changed: dot, not dimmed, default shown underneath');
    const v1 = await zumi.roles.get();
    check(v1.roles.do.model === 'google/gemini-3.8-flash' && v1.roles.do.effort === 'low' && v1.roles.do.by === 'user', 'Do choice persisted by main', JSON.stringify(v1.roles.do));
    await capture('02-do-changed.png');

    log('Do popover open');
    chipOf('do').click(); await sleep(300);
    await capture('03-do-popover.png');
    // Product rule (step 7): the fixture provider list carries 2 anthropic models, like OpenRouter's real catalog;
    // neither the picker rows nor roles:models may show one.
    const rows = [...document.querySelectorAll('.role-pop .pop-list button')].map((b) => b.textContent);
    const served = await zumi.roles.models();
    check(rows.length > 0 && !rows.some((x) => /claude|anthropic/i.test(x)) && served.ok && served.models.length > 0 && !served.models.some((m) => /claude|anthropic/i.test(`${m.id} ${m.name}`)), 'product rule: no Claude model in the picker or in roles:models', `${rows.length} rows, ${served.models.length} served`);
    const pop = document.querySelector('.role-pop').getBoundingClientRect();
    check(pop.left >= 0 && pop.right <= innerWidth && pop.top >= 0 && pop.bottom <= innerHeight, 'popover stays inside the window', JSON.stringify({ pop: [pop.left, pop.right, pop.top, pop.bottom] }));

    log('Do -> DeepSeek V4 (the model Check defaults to): the amber "!" appears on Check');
    clickModel('DeepSeek V4'); await sleep(300);
    document.body.click(); await sleep(200);
    check(Boolean(chipOf('check').querySelector('.warn')) && Boolean(document.querySelector('#roles-legend .warn')), 'same model on Do and Check (2+ models available): "!" on Check + legend line');
    await capture('04-same-model-warning.png');

    log('Vietnamese UI');
    document.querySelector('#lang-switch button[data-lang="vi"]').click(); await sleep(400);
    await showCard();
    check(fits(noSideScroll()), 'no horizontal scroll in Vietnamese either', JSON.stringify(noSideScroll()));
    chipOf('do').click(); await sleep(300);
    await capture('05-vi-do-popover.png');
    document.body.click(); await sleep(200);
    document.querySelector('#lang-switch button[data-lang="en"]').click(); await sleep(300);

    log('Use default on Do');
    chipOf('do').click(); await sleep(250);
    [...document.querySelectorAll('.role-pop .pop-foot button')].find((b) => b.textContent === 'Use default').click(); await sleep(300);
    const v2 = await zumi.roles.get();
    check(v2.roles.do.by === 'default' && chipOf('do').classList.contains('same') && !document.querySelector('#roles-grid .warn'), 'Use default: Do back to default, "!" gone');

    // ---- the card with all four roles live + the switches, dark and light (T-31 zumi-roles) ----
    const theme = async (light) => { document.documentElement.classList.toggle('dark', !light); document.documentElement.style.colorScheme = light ? 'light' : ''; await sleep(300); };
    await showCard();
    await capture('roles-card-dark.png');
    const darkBg = getComputedStyle(document.body).backgroundColor;
    await theme(true);
    check(getComputedStyle(document.body).backgroundColor !== darkBg, 'light theme applied for the light shot (the page background changed)', `${darkBg} -> ${getComputedStyle(document.body).backgroundColor}`);
    await capture('roles-card-light.png');
    await theme(false);
    log('Look up switched off, then on again');
    const lsw = () => document.querySelector('#roles-grid .role-sw[data-role="lookup"]');
    lsw().click(); await sleep(500);
    const vOff = await zumi.roles.get();
    check(vOff.roles.lookup.on === false && vOff.roles.plan.on && vOff.roles.check.on && !lsw().checked && lsw().closest('.role-cell').classList.contains('paused') && !document.querySelector('.role-pop'), 'Look up switch off: saved by main, the cell dimmed, no popover opened', JSON.stringify(vOff.roles.lookup));
    await capture('roles-card-lookup-off-dark.png');
    await theme(true);
    await capture('roles-card-lookup-off-light.png');
    await theme(false);
    lsw().click(); await sleep(500);
    check((await zumi.roles.get()).roles.lookup.on === true && lsw().checked, 'Look up switch back on');

    // ---- real chat turns through the fixture provider: Planned chip, Check row, Sources row ----
    log('chat turns (fixture chat endpoint, voice off)');
    await zumi.talk.setVoiceEnabled(false); // a shots run never plays audio
    openZumiTab(); await sleep(500);
    for (let i = 0; i < 240 && !(talk && talk.enabled); i++) await sleep(250);
    check(Boolean(talk && talk.enabled), 'chat: Zumi can talk in this run (fixture key saved + a model on stage; start with --model)');
    if (talk && talk.enabled) {
      const row = () => $('talk-roles');
      const checkRow = () => $('talk-check').parentElement;
      // chat-brain never asks for an explanation (explains:false), so no turn may show "Zumi could not explain this turn."
      const noMissingLine = () => $('analysis').hidden || $('an-missing').hidden;
      // Send, wait for the turn's own sign (chip / row), then until the streamed reply stops growing for 600 ms.
      const say = async (text, until) => {
        await talk.send(text);
        for (let i = 0; i < 60 && !until(); i++) await sleep(100);
        let last = null;
        for (let i = 0, still = 0; i < 60 && still < 6; i++) { const now = $('talk-reply').textContent; still = now === last ? still + 1 : 0; last = now; await sleep(100); }
      };
      await say('Hi Zumi, how are you?', () => /working on today/.test($('talk-reply').textContent));
      check(/working on today/.test($('talk-reply').textContent) && row().hidden && checkRow().hidden, 'chat: a simple turn shows no role chips', row().textContent);
      check(noMissingLine(), 'chat: a simple turn shows no "could not explain this turn" line', $('an-missing').textContent);
      await capture('chat-0-simple.png');
      await say('Plan the launch of our new app next week: what are the steps?', () => !row().hidden);
      const planned = row().querySelector('.rchip.plan');
      check(planned && planned.textContent === 'Outlined' && /store page/.test(planned.title) && checkRow().hidden && !row().querySelector('.src'), 'chat: "Planned" chip under the reply, the outline in its tooltip, nothing else', planned && planned.title);
      await capture('chat-1-planned.png');
      await say('Check this for me: 2+2=5, right?', () => !checkRow().hidden);
      const fix = row().querySelector('.rchip.fix');
      check(fix && fix.textContent === 'Double-check' && $('talk-check').textContent === '2 + 2 equals 4, not 5.' && checkRow().querySelector('.who').textContent === 'Double-check', 'chat: Check correction row under the reply (text only) + "Check" chip', $('talk-check').textContent);
      check(talk.director.history.some((h) => h.role === 'assistant' && /\(Correction: 2 \+ 2 equals 4, not 5\.\)$/.test(h.text)), 'chat: the correction is in the history for the next turn');
      await capture('chat-2-check-correction.png');
      await say('What is the gold price today?', () => Boolean(row().querySelector('.src')));
      const links = [...row().querySelectorAll('.src a')].map((a) => a.textContent);
      check(JSON.stringify(links) === '["kitco.com","reuters.com","bbc.com"]' && !/https?:/.test($('talk-reply').textContent), 'chat: Sources row with the cited sites as links; no URL in the reply text', JSON.stringify(links));
      check(noMissingLine(), 'chat: a Look up turn shows no "could not explain this turn" line', $('an-missing').textContent);
      await capture('chat-3-sources.png');
      const sum = await zumi.usage.summary();
      const kinds = [...new Set(sum.rows.filter((r) => r.date === sum.today).map((r) => r.kind))].sort();
      check(['chat', 'plan', 'check', 'lookup'].every((k) => kinds.includes(k)), 'usage: the turns wrote plan / check / lookup lines next to chat', JSON.stringify(kinds));
      const look = sum.rows.find((r) => r.date === sum.today && r.kind === 'lookup');
      check(look && Math.abs(look.webSearchUsd - 0.007 * look.calls) < 1e-9, 'usage: the lookup row carries the $0.007 web-search fee', JSON.stringify(look));
    }
    openSettingsTab(); await sleep(400);
    $('usage-refresh').click(); await sleep(600);
    if ($('usage-details-toggle').getAttribute('aria-expanded') !== 'true') { $('usage-details-toggle').click(); await sleep(200); }
    const cells = [...$('usage-tbody').rows].map((r) => r.cells[1].textContent);
    check(['DeepSeek V4 · Plan', 'DeepSeek V4 · Check', 'DeepSeek V4 Flash · Look up'].every((x) => cells.includes(x)), 'usage card: role rows read "<model> · <role>" (e.g. "DeepSeek V4 · Check")', JSON.stringify([...new Set(cells)]));
    $('usage-card').scrollIntoView({ block: 'start' }); settingsCol().scrollTop -= 12; await sleep(200);
    await capture('usage-role-rows.png');
    $('usage-details-toggle').click(); await sleep(150);

    log('no provider configured');
    await zumi.shots.rolesProvider('off');
    await roleModels.refresh(); await sleep(300);
    await showCard();
    check($('roles-grid').hidden && /No AI provider/.test($('roles-status').textContent), 'no provider: grid hidden, plain line shown');
    await capture('06-no-provider.png');

    log('narrowest supported window');
    await zumi.shots.rolesProvider('on');
    await roleModels.refresh();
    // Ask for less than the minimum: the OS clamps the window to its real narrowest size (minWidth/minHeight).
    const size = await zumi.shots.resize(minWindow.width / 2, minWindow.height / 2);
    await sleep(700);
    await showCard();
    const wn = noSideScroll();
    check(window.innerWidth < 1000 && fits(wn), `no horizontal scroll at the narrowest window (min ${minWindow.width}x${minWindow.height}; content ${window.innerWidth}x${window.innerHeight})`, JSON.stringify({ size, ...wn }));
    await capture('07-min-window.png');

    log('one-model provider');
    await zumi.shots.rolesProvider('one');
    await roleModels.refresh(); await sleep(300);
    await showCard();
    check(!document.querySelector('#roles-grid .warn') && /one model/.test($('roles-legend').textContent), 'one model: no warning, soft note instead');
    await capture('08-one-model-note.png');
  } catch (e) {
    report.ok = false;
    report.error = String((e && e.stack) || e);
    log(`ERROR ${report.error}`);
  }
  log(`checks ${report.checks.filter((c) => c.ok).length}/${report.checks.length} passed`);
  await zumi.shots.finish(report);
}
