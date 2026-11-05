// T-31 settings P1: the Settings re-layout into six tabs + the "Đọc to câu trả lời khi tắt mic" switch.
// T-31 settings P1b: the "Developer mode" switch hides the dev chrome (3 debug buttons + version tag) by default,
// persisted under the NEW `developerMode` key (the old `devTools` key is ignored); the composer placeholder keeps
// its original accurate text.
// Plain Node, no Electron (like every check:*): the requirement is that the SHIPPED markup still carries every
// control and that the new behaviours are wired and gated correctly.
//   node scripts/check-settings-tabs.mjs
//   1. re-layout: every pre-existing settings control id still exists, exactly once
//   2. the six tabs: one tablist, 6 role=tab in order, 6 role=tabpanel with matching aria wiring, cards grouped
//   3. the switch: default ON, main/preload/settings wiring, the gate truth table, and the director gate
//   4. Developer mode (P1b): default OFF hides the 3 debug buttons + the version tag; ON shows them; persisted under
//      `developerMode` (old `devTools` ignored); the board's "Unlock in Settings" opens the Account tab
//   5. the composer placeholder (P1b): the original accurate text in every language and in the markup
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shouldSpeakReply } from '../src/renderer/talk/reply-speech.js';
import { devChromeVisible } from '../src/renderer/settings.js';
import { TABLES } from '../src/renderer/i18n.js';
import { PANELS, TEST_ERROR_KEY, testErrorKey } from '../src/renderer/voice-providers.js';
import { HOLO_PREF_KEY, HOLO_STYLES, DEFAULT_HOLO } from '../src/renderer/room/float-holo-prefs.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); } };
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const html = read('src', 'renderer', 'index.html');
const main = read('src', 'main', 'main.js');
const preload = read('src', 'main', 'preload.js');
const settings = read('src', 'renderer', 'settings.js');
const director = read('src', 'renderer', 'talk', 'director.js');
const app = read('src', 'renderer', 'app.js');

// ---------- extract the settings section (brace-match <section>/</section>) ----------
const START = '<section id="tab-settings" class="panel">';
const s = html.indexOf(START);
ok(s >= 0, 'index.html still has the #tab-settings section');
let depth = 0, close = -1;
const rx = /<\/?section\b[^>]*>/g; rx.lastIndex = s;
for (let m; (m = rx.exec(html));) { if (m[0].startsWith('</')) { depth--; if (depth === 0) { close = m.index; break; } } else depth++; }
const sec = html.slice(s, close + '</section>'.length);

// ---------- 1. every pre-existing settings control id survives (base a6273cb) ----------
const BASE_IDS = ['tab-settings', 'lang-switch', 'account-card', 'board-status', 'board-chip', 'board-form-toggle',
  'board-mode-switch', 'mode-local', 'mode-live', 'board-form', 'board-user', 'board-pass', 'board-pin',
  'board-pin-confirm', 'board-token', 'board-save', 'board-note', 'brain-card', 'brain-provider', 'brain-key-row',
  'brain-key-desc', 'brain-key-chip', 'brain-key-view', 'brain-key-mask', 'brain-key-check', 'brain-key-change',
  'brain-key-clear', 'brain-key-edit', 'brain-key-input', 'brain-key-save', 'brain-key-cancel', 'brain-key-note',
  'roles-card', 'roles-status', 'roles-grid', 'roles-legend', 'roles-note', 'roles-board-link', 'roles-board-open',
  'voice-card', 'voice-enabled', 'think-sound', 'voice-status', 'voice-en-name', 'voice-kokoro-row', 'voice-kokoro-desc',
  'voice-kokoro-bar', 'voice-kokoro-progress', 'voice-kokoro-chip', 'voice-leda-chip', 'voice-leda-key', 'voice-leda-save',
  'voice-leda-clear', 'voice-leda-status', 'voice-speed', 'voice-speed-val', 'voice-volume', 'voice-volume-val',
  'voice-sample', 'voice-sample-note', 'privacy-card', 'board-pin-required', 'pin-off-risk', 'board-pin-toggle-prompt',
  'board-pin-toggle-pin', 'board-pin-toggle-confirm', 'board-pin-toggle-apply', 'board-pin-toggle-cancel',
  'board-pin-toggle-note', 'board-unlock-row', 'board-session-desc', 'board-unlock-pin', 'board-unlock', 'board-lock',
  'board-retry', 'board-session-note', 'send-client-names', 'usage-card', 'usage-refresh', 'usage-summary',
  'usage-summary-body', 'usage-partial', 'usage-details-toggle', 'usage-details-label', 'usage-detail', 'usage-table',
  'usage-tbody', 'usage-empty', 'room-card', 'room-picker', 'chair-picker', 'room-delete', 'room-open', 'room-note',
  // T-31 talk-mode: `hud-voice` is gone — the HUD voice-notice switch was replaced by the talk-level rows in the
  // Voice card (Settings > Agent & Soul), so it is no longer a pre-existing control id.
  // 0.3.0-alpha.11: the Developer card's wardrobe check row (wardrobe-row / -verify / -verify-status) left with the wardrobe.
  'hud-card', 'hud-style', 'developer-card', 'dev-tools'];
const ids = [...sec.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
const missing = BASE_IDS.filter((id) => !ids.includes(id));
const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
ok(missing.length === 0, `every pre-existing settings control id still exists (${BASE_IDS.length} checked)`, JSON.stringify(missing));
ok(dupes.length === 0, 'no duplicate ids inside the settings section', JSON.stringify(dupes));

// ---------- 2. the six tabs ----------
const TABS = ['account', 'ai', 'workflow', 'agent', 'room', 'app'];
ok((html.match(/role="tablist"/g) || []).length === 1, 'exactly one tablist in the whole document (no nested tabs)');
ok((sec.match(/role="tab"/g) || []).length === 6, 'six role=tab buttons', String((sec.match(/role="tab"/g) || []).length));
ok((sec.match(/role="tabpanel"/g) || []).length === 6, 'six role=tabpanel panels', String((sec.match(/role="tabpanel"/g) || []).length));
ok(!/type="search"/.test(sec) && !/settings\.search/.test(html), 'no search control in Settings and no search i18n key');

const tabIdx = TABS.map((t) => sec.indexOf(`id="stab-${t}"`));
ok(tabIdx.every((v) => v >= 0), 'all six tab ids exist', JSON.stringify(tabIdx));
ok(tabIdx.every((v, i) => i === 0 || v > tabIdx[i - 1]), 'tabs are in the approved order (Tài khoản & Riêng tư → Ứng dụng)');

const TLABELS = ['settings.tab.account', 'settings.tab.ai', 'settings.tab.workflow', 'settings.tab.agent', 'settings.tab.room', 'settings.tab.app'];
ok(TLABELS.every((k) => sec.includes(`data-i18n="${k}"`)), 'each tab carries its i18n label key', TLABELS.filter((k) => !sec.includes(`data-i18n="${k}"`)).join(','));
ok(/role="tablist"[^>]*data-i18n-aria="settings\.tabs"/.test(sec), 'the tablist has an aria label key');
for (const t of TABS) {
  ok(new RegExp(`id="stab-${t}"[\\s\\S]{0,200}?aria-controls="stabpanel-${t}"`).test(sec), `tab ${t} -> aria-controls stabpanel-${t}`);
  ok(new RegExp(`id="stabpanel-${t}"[^>]*aria-labelledby="stab-${t}"`).test(sec), `panel ${t} -> aria-labelledby stab-${t}`);
}
ok(/id="stab-account"[^>]*aria-selected="true"[^>]*tabindex="0"/.test(sec), 'the first tab is selected on load (roving tabindex 0)');
ok(/id="stabpanel-account"[^>]*>/.test(sec) && !/id="stabpanel-account"[^>]*\bhidden\b/.test(sec), 'the first panel is visible on load');
ok(TABS.slice(1).every((t) => new RegExp(`id="stabpanel-${t}"[^>]*\\bhidden\\b`).test(sec)), 'the other five panels start hidden');

// card -> panel grouping (each card id sits between its panel's start and the next panel's start)
const panelStarts = TABS.map((t) => sec.indexOf(`id="stabpanel-${t}"`));
const GROUPS = {
  account: ['account-card', 'privacy-card'],
  ai: ['brain-card', 'roles-card', 'usage-card'],
  workflow: ['workflow-card', 'typed-reply-speech'],
  // T-31 talk-mode (PLAN 5.1 / 10.3): the "how much Zumi talks" rows + the per-language voice provider selects all
  // live inside the Voice card in the Agent & Soul panel.
  agent: ['voice-card', 'talk-level', 'talk-lang', 'talk-lang-note', 'talk-quiet', 'talk-quiet-start', 'talk-quiet-end', 'voice-provider-en', 'voice-provider-vi',
    // inc 3 (PLAN 10.3): the BYO provider sub-panels, the per-language Test voice buttons and the reply language row.
    'vp-google', 'voice-panels', 'voice-test-en', 'voice-test-vi', 'voice-test-note', 'voice-reply-lang',
    // T-31 float-holo QC: the hologram style + rim colour pickers live beside the talk-mode settings.
    'holo-card', 'holo-style', 'holo-colour'],
  room: ['room-card', 'hud-card'],
  app: ['about-card', 'developer-card'],
};
for (const [tab, cards] of Object.entries(GROUPS)) {
  const i = TABS.indexOf(tab);
  const from = panelStarts[i], to = i + 1 < TABS.length ? panelStarts[i + 1] : sec.length;
  for (const c of cards) {
    const at = sec.indexOf(`id="${c}"`);
    ok(at > from && at < to, `#${c} is inside the ${tab} panel`);
  }
}

// The board's "Unlock in Settings" button must land on the Account inner tab (where the PIN unlock row lives), not
// on whatever inner tab was last remembered (settings-tabs.js persists the last tab in localStorage).
ok(/board-locked-settings'\)\.addEventListener\('click'[\s\S]{0,300}stab-account[\s\S]{0,160}settings[\s\S]{0,60}click/.test(app), 'the "Unlock in Settings" button selects the Account tab before opening Settings');

// ---------- 3. the typed-reply speech switch ----------
ok(/id="typed-reply-speech"[^>]*\bchecked\b/.test(sec), 'the switch markup defaults to ON (checked)');
ok(main.includes("ipcMain.handle('talk:getSpeakTypedWhenMicOff'") && /talk:getSpeakTypedWhenMicOff'[\s\S]{0,120}speakTypedWhenMicOff !== false/.test(main), 'main: getter default ON (!== false)');
ok(/ipcMain\.handle\('talk:setSpeakTypedWhenMicOff', \(e, on\) =>[\s\S]{0,120}saveSettings\(\{ speakTypedWhenMicOff: on === true \}\)/.test(main), 'main: setter persists the boolean');
ok(/getSpeakTypedWhenMicOff: \(\) => ipcRenderer\.invoke\('talk:getSpeakTypedWhenMicOff'\)/.test(preload) && /setSpeakTypedWhenMicOff: \(on_\) => ipcRenderer\.invoke\('talk:setSpeakTypedWhenMicOff', on_\)/.test(preload), 'preload exposes get/set');
ok(settings.includes("typedReplySpeech: $('typed-reply-speech')") && /getSpeakTypedWhenMicOff\(\)[\s\S]{0,120}on !== false/.test(settings) && settings.includes('setSpeakTypedWhenMicOff(el.typedReplySpeech.checked)'), 'settings.js wires the checkbox to main (default ON)');

// the gate's own truth table
ok(shouldSpeakReply({ speakTypedWhenMicOff: true }) === true, 'gate: switch ON (mic off) -> typed reply is spoken');
ok(shouldSpeakReply({ speakTypedWhenMicOff: false }) === false, 'gate: switch OFF (mic off) -> typed reply is NOT spoken');
ok(shouldSpeakReply({ micOn: true, speakTypedWhenMicOff: false }) === true, 'gate: mic on -> spoken regardless (never mutes a conversation)');
ok(shouldSpeakReply({}) === true && shouldSpeakReply() === true, 'gate: unset defaults to spoken');

// the director gates the typed TTS call
ok(/import \{ shouldSpeakReply \} from '\.\/reply-speech\.js'/.test(director), 'director imports the gate');
ok(/const speakTyped = shouldSpeakReply\(\{ speakTypedWhenMicOff: await speakTypedP \}\)/.test(director), 'director evaluates the gate per turn');
// The TTS call goes through ttsCall() (b44b626: a rejection is handled as a TTS failure), which is what calls cloud.tts.
ok(/const ttsP = speakTyped\s*\?\s*this\.ttsCall\(/.test(director) && /\n  ttsCall\(turnId, text\) \{[\s\S]{0,120}?this\.cloud\.tts\(/.test(director), 'director requests TTS only when the gate allows');
ok(!/const ttsP = this\.cloud\.tts\(/.test(director), 'the old unconditional TTS call is gone');

// ---------- 4. Developer mode hides the dev chrome (T-31 settings P1b) ----------
// The switch is the existing #dev-tools control in #developer-card, relabelled to "Developer mode".
ok(/data-i18n="settings\.developerMode"/.test(sec) && /data-i18n="settings\.developerModeD"/.test(sec), 'the Developer card switch uses the new "Developer mode" i18n keys');
ok(/id="developer-card"[\s\S]*?id="dev-tools"/.test(sec), 'the switch (#dev-tools) sits inside #developer-card in the App tab');
ok(!sec.includes('settings.devTools'), 'the old settings.devTools key is no longer referenced in the markup');
// default OFF: the shipped markup hides the three debug buttons and the version tag.
for (const id of ['sim-board', 'cam-register', 'look-tuning-toggle']) ok(new RegExp(`id="${id}"[^>]*\\bhidden\\b`).test(html), `#${id} is hidden in the shipped markup`);
ok(/id="app-version"[^>]*\bhidden\b/.test(html), '#app-version is hidden in the shipped markup');
// About > Version (0.2.6): a read-only row that is NOT developer chrome -- always visible, localised, filled from app:info.version.
ok(/id="about-card"[\s\S]*?data-i18n="settings\.version"[\s\S]*?id="about-version"/.test(sec) && /id="about-card"[\s\S]*?<\/section>/.test(sec) && !/id="about-card"[^>]*\bhidden\b/.test(sec) && !/id="about-version(-row)?"[^>]*\bhidden\b/.test(sec), 'About card has a Version row (label key + #about-version), not hidden in the shipped markup');
ok(sec.indexOf('id="about-version"') < sec.indexOf('id="developer-card"'), '#about-version is outside the Developer card (not developer chrome)');
ok(/\$\('about-version'\)\.textContent = info\.version/.test(app), 'app.js fills #about-version from app:info.version');
ok(!/about-version|aboutVersion/.test(settings), 'settings.js never toggles the About version row (it ignores Developer mode)');
ok(/\$\('app-version'\)\.textContent = `v\$\{info\.version\}`/.test(app), 'sidebar tag still filled as before (and stays hidden unless Developer mode)');
for (const l of ['en', 'vi', 'zh']) ok(typeof TABLES[l]['settings.version'] === 'string' && TABLES[l]['settings.version'].length > 0 && typeof TABLES[l]['settings.about'] === 'string', `i18n: ${l} has settings.version + settings.about`);
ok(TABLES.en['settings.version'] === 'Version' && TABLES.vi['settings.version'] === 'Phiên bản' && TABLES.zh['settings.version'] === '版本', 'i18n: Version label is Version / Phiên bản / 版本');
// settings.js derives visibility from the one persisted switch and hides all four nodes.
ok(settings.includes("devTools: $('dev-tools'), version: $('app-version')"), 'settings.js reads the version-tag node');
ok(/const on = devChromeVisible\(\{ storedOn, devRun: devBuild \}\)/.test(settings), 'settings.js derives visibility from the persisted switch');
for (const id of ['simBoard', 'camRegister', 'lookTuning', 'version']) ok(new RegExp(`el\\.${id}\\.hidden = !on`).test(settings), `settings.js hides ${id} when the switch is OFF`);
// the gate truth table: default OFF hides, ON shows; an unpackaged dev run keeps the controls (documented).
ok(devChromeVisible({}) === false && devChromeVisible({ storedOn: false }) === false, 'gate: default / switch OFF -> dev chrome hidden');
ok(devChromeVisible({ storedOn: true }) === true, 'gate: developerMode true (switch ON) -> dev chrome shown');
ok(devChromeVisible({ storedOn: false, devRun: true }) === true, 'gate: an unpackaged dev run keeps the controls (devBuild)');
// The switch persists through the same main/preload/settings pattern as the other switches, but under the NEW key
// `developerMode`. The pre-update `devTools` key is ignored entirely (no migration): an install whose settings.json
// still says devTools:true must come up with the chrome HIDDEN, because nothing reads that key any more.
ok(main.includes("ipcMain.handle('ui:get-dev-tools'") && /loadSettings\(\)\.developerMode === true/.test(main), 'main: getter reads the persisted developerMode flag (default OFF)');
ok(!/loadSettings\(\)\.devTools/.test(main), 'main: the old devTools key is read nowhere (ignored entirely)');
ok(!/saveSettings\(\{ devTools:/.test(main), 'main: nothing writes the old devTools key');
ok((main.match(/loadSettings\(\)\.developerMode === true/g) || []).length === 4, 'all four dev gates read developerMode (rooms:v2:save-view, getter, look-tuning, liveReloadRoomV2)');
ok(/ipcMain\.handle\('ui:set-dev-tools', \(e, on\) =>[\s\S]{0,120}saveSettings\(\{ developerMode: v \}\)/.test(main), 'main: setter persists the boolean under developerMode');
// stored devTools:true (old key) + no developerMode -> hidden; developerMode:true -> shown.
ok(!/loadSettings\(\)\.devTools/.test(main) && devChromeVisible({ storedOn: false }) === false, 'an install whose only stored key is the old devTools:true shows no dev chrome (old key ignored, developerMode unset)');
ok(/setDevTools: \(on_?\) => ipcRenderer\.invoke\('ui:set-dev-tools'/.test(preload), 'preload exposes setDevTools');
ok(settings.includes('zumi.ui.setDevTools(on)') && /getDevTools\(\)\.then\(applyDevTools\)/.test(settings), 'settings.js wires the checkbox to main (applies live, no restart)');

// ---------- 4b. talk-mode inc 3: the stage mute + the BYO provider panels (PLAN 5.2, 10.3) ----------
{
  const zumiTab = html.slice(html.indexOf('<section id="tab-zumi"'), html.indexOf('</header>', html.indexOf('<section id="tab-zumi"')));
  ok(zumiTab.includes('id="talk-mute"') && zumiTab.includes('id="talk-mute-menu"'), 'talk-mute and its menu are in the Zumi tab toolbar');
  ok(!sec.includes('id="talk-mute"'), 'the stage mute is not in the Settings section');
  const en = TABLES.en;
  const usedKeys = [];
  for (const [id, spec] of Object.entries(PANELS)) {
    usedKeys.push(`settings.provider.${id}`, `settings.vp.desc.${id}`);
    for (const g of spec.guides) usedKeys.push(`settings.vp.guide.${g}`);
    for (const f of spec.fields) { usedKeys.push(f.label); if (f.placeholder) usedKeys.push(f.placeholder); }
  }
  usedKeys.push(...Object.values(TEST_ERROR_KEY), 'settings.testErr.server', 'settings.testErr.failed', 'settings.testVoice', 'settings.testVoicePaid', 'settings.testVoicePaidNote', 'settings.testPlayed', 'settings.testLine.en', 'settings.testLine.vi', 'settings.vp.keyPh', 'settings.vp.keyBad', 'settings.vp.fieldSaved', 'settings.vp.fieldBad', 'settings.vp.guide.google', 'settings.replyLang.auto', 'settings.replyLang.en', 'settings.replyLang.vi', 'stage.mute.title', 'stage.mute.levelOff', 'stage.mute.mutedUntil', 'stage.mute.muted', 'stage.mute.hour', 'stage.mute.tomorrow', 'stage.mute.level');
  const missingKeys = usedKeys.filter((k) => en[k] == null);
  ok(missingKeys.length === 0, `every i18n key the voice panels and the mute use exists (${usedKeys.length} checked)`, JSON.stringify(missingKeys));
  ok(['gemini', 'elevenlabs', 'http-openai', 'http-zumia'].every((id) => PANELS[id]), 'a sub-panel exists for gemini, elevenlabs, http-openai and http-zumia');
  ok(testErrorKey('http_503') === 'settings.testErr.server' && testErrorKey('rate_limited') === 'settings.testErr.rate_limited' && testErrorKey('zzz') === 'settings.testErr.failed', 'a typed error code maps to a plain sentence; unknown codes read as "failed"');
  ok(settings.includes("import { initVoiceProviders } from './voice-providers.js'") && settings.includes('vp.paint(providerList, voiceSaved)'), 'settings.js hands the provider list and saved prefs to the panels');
  ok(app.includes('playTest: (lang, text) => talk.playTest(lang, text)'), 'app.js gives Settings the playTest hook for Test voice');
  const core = fs.readFileSync(new URL('../src/main/talk-voice-core.mjs', import.meta.url), 'utf8');
  ok(main.includes("ipcMain.handle('talk:openGuide'") && core.includes('Object.prototype.hasOwnProperty.call(VOICE_GUIDES, id)'), 'openGuide takes a guide NAME from a fixed table (talk-voice-core VOICE_GUIDES), never a URL from the page');
  ok(!/talk:getKey|readKey|getProviderKey/.test(main + preload), 'no IPC reads a provider key back to the renderer');
}

// ---------- 4c. the Hologram QC switch (T-31 float-holo, owner QC on the real app) ----------
// Two renderer-only pickers in the Agent & Soul tab: "Kiểu hologram" (the r6 TOP3 parameter sets) and "Màu viền"
// (the two sweep colours). They apply LIVE and persist in the renderer's own localStorage store (Electron main is
// frozen), so this checks the markup, the i18n copy, the defaults and app.js's wiring -- the numbers themselves are
// proven by scripts/check-float-holo-prefs.mjs (6 combos).
{
  ok(/id="holo-card"[\s\S]*?id="holo-style"[\s\S]*?id="holo-colour"/.test(sec), 'the Hologram card carries the style + rim-colour pickers');
  ok((sec.match(/id="holo-style"/g) || []).length === 1 && (sec.match(/id="holo-colour"/g) || []).length === 1, 'each Hologram picker exists exactly once');
  const styleSel = /<select id="holo-style"[\s\S]*?<\/select>/.exec(sec);
  const colourSel = /<select id="holo-colour"[\s\S]*?<\/select>/.exec(sec);
  const styleVals = styleSel ? [...styleSel[0].matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]) : [];
  const colourVals = colourSel ? [...colourSel[0].matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]) : [];
  ok(JSON.stringify(styleVals) === JSON.stringify(['T1', 'T2', 'T3']), 'the style picker offers T1 / T2 / T3 in TOP3 order', styleVals);
  ok(JSON.stringify(colourVals) === JSON.stringify(['cyan', 'amber']), 'the rim-colour picker offers cyan / amber', colourVals);
  ok(/data-i18n="holo\.cyan"/.test(colourSel ? colourSel[0] : '') && /data-i18n="holo\.amber"/.test(colourSel ? colourSel[0] : ''), 'both colour options carry an i18n key');
  ok(/data-i18n="settings\.holoStyle"/.test(sec) && /data-i18n="settings\.holoStyleD"/.test(sec) && /data-i18n="settings\.holoColour"/.test(sec), 'the pickers carry their label + hint keys');
  // The hint must not pretend a look was chosen: the default is a starting point, in the owner's own words (VI).
  ok(TABLES.vi['settings.holoStyleD'] === 'Mặc định để bắt đầu — anh chọn kiểu mình thích', 'i18n: the VI hint is the owner\'s wording verbatim', TABLES.vi['settings.holoStyleD']);
  ok(TABLES.en['settings.holoStyleD'] === 'Starting default — pick the one you like', 'i18n: the EN hint matches the brief', TABLES.en['settings.holoStyleD']);
  ok(TABLES.vi['settings.holoStyle'] === 'Kiểu hologram' && TABLES.vi['settings.holoColour'] === 'Màu viền', 'i18n: the VI labels are "Kiểu hologram" / "Màu viền"');
  ok(TABLES.vi['holo.cyan'] === 'Xanh' && TABLES.vi['holo.amber'] === 'Cam', 'i18n: the VI colour names are Xanh / Cam');
  const holoKeys = ['settings.holoSection', 'settings.holoStyle', 'settings.holoStyleD', 'settings.holoColour', 'settings.holoColourD', 'holo.cyan', 'holo.amber'];
  for (const l of ['en', 'vi', 'zh']) ok(holoKeys.every((k) => typeof TABLES[l][k] === 'string' && TABLES[l][k].length > 0), `i18n: ${l} carries all ${holoKeys.length} Hologram keys`, holoKeys.filter((k) => !TABLES[l][k]));
  // Defaults: the shipped markup shows T1 + cyan (the first option) and the module agrees.
  ok(DEFAULT_HOLO.style === 'T1' && DEFAULT_HOLO.colour === 'cyan' && styleVals[0] === DEFAULT_HOLO.style && colourVals[0] === DEFAULT_HOLO.colour, 'default T1 + cyan, both in the module and in the markup');
  ok(HOLO_STYLES.T1.rimMul === 3 && HOLO_STYLES.T1.fresnelPower === 2 && HOLO_STYLES.T1.centerBackM === 0.10 && HOLO_STYLES.T1.soleY === 0.24, 'T1 is the TOP3 quadruple (3, 2, 0.10, 0.24)');
  ok(HOLO_PREF_KEY === 'zumi.pilot.floatHolo', 'the pick persists in the renderer-only localStorage store', HOLO_PREF_KEY);
  // app.js wiring: live apply via the same r6 overrides the harness uses, then the accent.
  ok(/import \{ readHoloPrefs, saveHoloPrefs, resolveHolo \} from '\.\/room\/float-holo-prefs\.js'/.test(app), 'app.js imports the prefs module');
  ok(/const holoStyleSelect = \$?\('holo-style'\)/.test(app) && /const holoColourSelect = \$?\('holo-colour'\)/.test(app), 'app.js reads both pickers');
  ok(/const applyHoloPrefs = \(prefs\) => \{[\s\S]{0,220}?applyFloatOverrides\(r\.params\)[\s\S]{0,120}?holo\.setAccent\(r\.accent\)/.test(app), 'app.js applies the style to the FH params and the colour to the panel/light/rim');
  ok(/holoStyleSelect\.addEventListener\('change'[\s\S]{0,220}?saveHoloPrefs\(\{ \.\.\.holoPrefs, style: holoStyleSelect\.value \}\)/.test(app), 'changing the style saves it (live, no restart)');
  ok(/holoColourSelect\.addEventListener\('change'[\s\S]{0,220}?saveHoloPrefs\(\{ \.\.\.holoPrefs, colour: holoColourSelect\.value \}\)/.test(app), 'changing the colour saves it (live, no restart)');
  ok(/let holoPrefs = readHoloPrefs\(\)/.test(app) && /applyHoloPrefs\(holoPrefs\);\n/.test(app), 'app.js applies the saved pick at boot');
  const holoHtml = sec.slice(sec.indexOf('id="holo-card"'));
  ok(!/<input type="checkbox"/.test(holoHtml.slice(0, holoHtml.indexOf('</section>'))), 'the Hologram card adds no other control (no visual side effects)');
}

// ---------- 5. composer placeholder (T-31 settings P1b; the 803d1dd rename was reverted) ----------
// The "off" placeholder shows only while chat is disabled, and then Zumi really only gestures -- so the original
// accurate wording stays in every language and in the markup.
ok(/id="msg"[\s\S]{0,240}?placeholder="Message Zumi… \(Zumi only reacts with gestures, not replies yet\)"/.test(html), 'composer markup carries the original accurate English placeholder');
ok(TABLES.en['msg.placeholderOff'] === 'Message Zumi… (Zumi only reacts with gestures, not replies yet)'
  && TABLES.vi['msg.placeholderOff'] === 'Nhắn cho Zumi… (Zumi chỉ phản xạ bằng cử chỉ, chưa trả lời)'
  && TABLES.zh['msg.placeholderOff'] === '给 Zumi 发消息…（Zumi 只用动作回应，暂不回答）',
  'i18n: the off placeholder is the original accurate text in all three languages');
ok(TABLES.en['msg.placeholderOn'] === 'Message Zumi… (Enter to send)', 'i18n: the (Enter to send) placeholder is unchanged');


// ---------- release 0.3.0 N2: Settings > Voice provider panels render (initSettings on a small fake DOM) ----------
// renderProviders destructured the voice prefs as `vp`, shadowing the panels module `vp`: vp.paint threw, the catch emptied the
// provider list, and every later paint hid the panels, so Gemini / ElevenLabs / Custom voices could not be set up.
{
  const els = new Map();
  const mkEl = (tag = 'div', id = '') => ({
    tag, id, hidden: false, value: '', checked: false, disabled: false, textContent: '', className: '', dataset: {}, attrs: {}, children: [], options: [], listeners: {},
    style: { setProperty() {}, removeProperty() {} }, classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    set innerHTML(v) { this.children = []; this.options = []; }, get innerHTML() { return ''; },
    appendChild(c) { this.children.push(c); if (c.tag === 'option') this.options.push(c); return c; }, prepend(c) { this.children.unshift(c); }, append(...cs) { for (const c of cs) this.appendChild(c); },
    setAttribute(k, v) { this.attrs[k] = v; if (k === 'hidden') this.hidden = true; if (k === 'id') { this.id = v; els.set(v, this); } },
    getAttribute(k) { return this.attrs[k] ?? null; }, removeAttribute(k) { delete this.attrs[k]; if (k === 'hidden') this.hidden = false; },
    addEventListener(k, f) { (this.listeners[k] ||= []).push(f); }, removeEventListener() {},
    querySelector: () => null, querySelectorAll: () => [], closest: () => null, focus() {}, blur() {}, remove() {}, replaceChildren(...cs) { this.children = cs; },
    getBoundingClientRect: () => ({ width: 0, height: 0 }),
  });
  const $ = (id) => { if (!els.has(id)) els.set(id, mkEl('div', id)); return els.get(id); };
  const saved = { document: globalThis.document, window: globalThis.window, localStorage: globalThis.localStorage };
  const docListeners = {}; // recorded only; this harness fires them by hand (fireDoc), document.dispatchEvent stays a no-op
  const fireDoc = async (name) => { for (const f of docListeners[name] || []) await f(); };
  globalThis.document = { dispatchEvent: () => true, createElement: (tg) => mkEl(tg), createElementNS: (_, tg) => mkEl(tg), createTextNode: (x) => ({ textContent: x }), addEventListener(k, f) { (docListeners[k] ||= []).push(f); }, removeEventListener() {}, querySelectorAll: () => [], querySelector: () => null, getElementById: (id) => $(id), documentElement: mkEl('html'), body: mkEl('body'), activeElement: null };
  globalThis.window = globalThis;
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  const LIST = [{ id: 'kokoro', langs: ['en'], hasKey: false }, { id: 'google', langs: ['en', 'vi'], hasKey: false }, { id: 'http-openai', langs: ['en', 'vi'], hasKey: false, keyOptional: true }, { id: 'elevenlabs', langs: ['en', 'vi'], hasKey: false, paid: true }];
  const PREFS = { voiceProviderEn: 'http-openai', voiceProviderVi: 'off' };
  // Every host call answers null, except the voice list and prefs (the shape main / the sidecar return) and the read-aloud switch.
  let typedOn = true; // settings.json speakTypedWhenMicOff as the host reads it
  const host = (where) => new Proxy(function () {}, {
    get: (_, k) => (k === 'then' ? undefined : host(`${where}.${String(k)}`)),
    apply: () => Promise.resolve(where === 'talk.voiceProviders' ? LIST : (where === 'talk.getVoicePrefs' || where === 'talk.setVoicePrefs') ? PREFS : where === 'talk.getSpeakTypedWhenMicOff' ? typedOn : null),
  });
  const zumi = new Proxy({}, { get: (_, k) => host(String(k)) });
  const { initSettings } = await import('../src/renderer/settings.js');
  // Cards this test does not model (board, usage, ...) get null from the fake host and may reject; record, do not crash.
  const rejections = [];
  const onRejection = (e) => rejections.push(String((e && e.message) || e));
  process.on('unhandledRejection', onRejection);
  let threw = null;
  try { initSettings(zumi, $, {}); } catch (e) { threw = e; }
  await new Promise((r) => setTimeout(r, 100));
  const panel = els.get('vp-http-openai');
  ok(!threw && panel && panel.hidden === false, 'N2: Settings > Voice: with "Custom OpenAI-compatible" saved, its panel shows after the provider list renders', JSON.stringify({ threw: threw && threw.message, hidden: panel && panel.hidden }));
  const sel = $('voice-provider-en');
  ok(JSON.stringify(sel.options.map((o) => o.value)) === JSON.stringify(['kokoro', 'google', 'http-openai', 'elevenlabs']), 'N2: the EN voice select lists the providers main reports', JSON.stringify(sel.options.map((o) => o.value)));
  sel.value = 'http-openai';
  for (const f of sel.listeners.change || []) await f();
  await new Promise((r) => setTimeout(r, 50));
  ok(panel && panel.hidden === false && els.get('vp-elevenlabs') && els.get('vp-elevenlabs').hidden === true, 'N2: after a provider change the chosen panel still shows (the list was not emptied) and the others stay hidden', JSON.stringify({ openai: panel && panel.hidden, eleven: els.get('vp-elevenlabs') && els.get('vp-elevenlabs').hidden }));
  // R8-F1 (installer re-check of 4e436d30): the first-run card saved "read aloud" off, but Settings > Workflow kept the boot-time
  // paint (checked) until a restart. The card announces the save with the existing zumi:talk-changed event; Settings re-reads the host.
  const sw = $('typed-reply-speech');
  ok(sw.checked === true, 'R8-F1: Settings > Workflow "Read the reply aloud" paints the saved value at start (on)', JSON.stringify(sw.checked));
  typedOn = false; // saved elsewhere (the first-run card) through talk.setSpeakTypedWhenMicOff
  await fireDoc('zumi:talk-changed');
  await new Promise((r) => setTimeout(r, 30));
  ok(sw.checked === false, 'R8-F1: after zumi:talk-changed the switch shows the newly saved value (off) in the same session', JSON.stringify(sw.checked));
  typedOn = true; await fireDoc('zumi:talk-changed'); await new Promise((r) => setTimeout(r, 30));
  ok(sw.checked === true, 'R8-F1: and back on', JSON.stringify(sw.checked));
  process.off('unhandledRejection', onRejection);
  Object.assign(globalThis, saved);
}

console.log(`\ncheck:settings-tabs ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
