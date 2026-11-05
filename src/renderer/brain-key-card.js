// Settings > AI & Usage > "AI brain" (T-31 settings-a2; the KEY-HANDLING notes).
// T-31 BYOK (owner 16-10): the provider picker + the selected provider's "get your key" guide live here too, driven by
// the one provider table in main/providers.js (labels + numbered steps in EN/VI/ZH). One key per provider.
// Saved: a masked line (dots + the last 4 characters main reports) with Change / Clear, plus Check again while the
// saved key is not known to work (never checked, provider unreachable, or refused; brainKey:test). No key, or Change: a password
// field with Save (+ Cancel when a key exists). The field is emptied the moment Save is pressed, and nothing key-shaped
// ever comes back from main -- only { provider, saved, last4 } and a check result ('works' | 'unreachable') or an
// error code, which this module turns into words. Mirrors usage.js's shape (one init, owns its DOM + i18n).
import { t, onLocaleChange, getLocale, isPublicText } from './i18n.js';
import providers from '../main/providers.js';

const { PROVIDERS, OWNER_ONLY_PROVIDER_IDS, providerIdsForMode, optionLabel, pickerMode } = providers;

// T-31 free LLM (BRIEF-free-llm FL-2): the preset notices and the 18+ confirm are TAURI ONLY. The host signal is the
// one the shim itself uses to decide whether a Tauri bridge exists (tauri/shim/zumi-shim.js tauriCore() reads
// window.__TAURI__); Electron does not define that global, so this block builds no DOM and the card stays byte-identical
// there. scripts/check-tauri-free-llm.mjs asserts both halves against the real module.
const isTauriHost = () => typeof window !== 'undefined' && Boolean(window.__TAURI__);

// The renderer copy of the UI facts. tauri/sidecar/free-llm-presets.mjs cannot be imported here (it loads node:module),
// so the check compares this table with the sidecar's preset list field by field: same ids in the same order, the same
// requiresAge18 flag and the same official limits URL (no limit numbers anywhere).
export const FREE_LLM_UI = Object.freeze({
  gemini: { requiresAge18: true, limitsUrl: 'https://ai.google.dev/gemini-api/docs/rate-limits' },
  groq: { requiresAge18: true, limitsUrl: 'https://console.groq.com/docs/rate-limits' },
  openrouter: { requiresAge18: true, limitsUrl: 'https://openrouter.ai/docs/api-reference/limits' },
  cloudflare: { requiresAge18: false, requiresAccountId: true, limitsUrl: 'https://developers.cloudflare.com/workers-ai/platform/pricing/' },
  mistral: { requiresAge18: false, limitsUrl: 'https://docs.mistral.ai/admin/billing-usage/usage-limits' },
});
// The 18+ answer and the Cloudflare Account ID are settings.json values written through the sidecar setter
// (`ai.setPresetSettings`), never webview storage: they must survive a sidecar restart and the 18+ gate is enforced
// again in the sidecar before a Gemini turn. Absence = not confirmed, so the gate fails closed.
// result code -> [i18n key, tone]
const LINE = {
  checking: ['settings.keyChecking', ''],
  works: ['settings.keyWorks', 'ok'],
  unverified: ['settings.keyUnverified', ''],
  testOk: ['settings.testOk', 'ok'],
  unreachable: ['settings.keyUnchecked', ''],
  checkUnreachable: ['settings.keyCheckUnreachable', ''],
  storedRejected: ['settings.keyStoredRejected', 'bad'],
  unreachableNoSave: ['settings.keyUnreachableNoSave', ''],
  cleared: ['settings.keyCleared', ''],
  bad_format: ['settings.keyBadFormat', 'bad'],
  rejected: ['settings.keyRejected', 'bad'],
  no_encryption: ['settings.keyNoEncryption', 'bad'],
};

/** "a Groq key" / "an OpenRouter key": the English bad-format lines take the article from the provider's name. */
export function indefiniteArticle(name) {
  return /^[aeiou]/i.test(String(name || '')) ? 'an' : 'a';
}

export function initBrainKey(zumi, $) {
  const el = {
    chip: $('brain-key-chip'), desc: $('brain-key-desc'), view: $('brain-key-view'), mask: $('brain-key-mask'),
    check: $('brain-key-check'), change: $('brain-key-change'), clear: $('brain-key-clear'), edit: $('brain-key-edit'), input: $('brain-key-input'),
    save: $('brain-key-save'), cancel: $('brain-key-cancel'), note: $('brain-key-note'), test: $('brain-key-test'),
    saveAnyway: $('brain-key-save-anyway'),
    provider: $('brain-provider'), guide: $('brain-guide'), guideOpen: $('brain-guide-open'), notice: $('brain-notice'),
    modeFree: $('brain-mode-free'), modeByok: $('brain-mode-byok'),
  };
  if (!el.chip || !zumi.brainKey) return null;
  let view = { provider: 'OpenRouter', saved: false, last4: null, checked: null };
  let providerId = 'openrouter';
  let mode = 'free'; // T-31 OpenCode BYOK: 'free' | 'byok' (the two-choice header); read from main on refresh
  let editing = false;
  let line = null; // the last result code, kept so a language switch repaints the message
  // T-31 fix round item 1: a key whose Save came back UNREACHABLE is held here (in memory only, never logged) until the
  // user clicks "Lưu dù chưa thử được" (Save anyway) or starts over. The field itself was already emptied.
  let pendingKey = null;
  // FL-2/FL-3 (Tauri only): the extra preset block, the list + settings the sidecar returns over `ai.presetList`, the
  // Account ID field, and whether the card is busy (so paint() can re-apply the age gate without fighting busy()).
  let free = null;
  let ownerBuild = false; // app:info.ownerAdmin: ownerOnly providers are listed; the host refuses them otherwise anyway
  let tauriPresets = null; // { free: [...], advanced: [...] } | null (null in Electron and before the first read)
  let presetSettings = { cloudflareAccountId: null, age18Confirmed: false };
  let accountId = '';
  let age18 = false;
  let busyNow = false;
  // Owner build, OpenCode Go: the key can come from the OpenCode CLI login (Tauri only; the host answers a boolean and a source, never a key).
  let cli = { active: false, source: 'key-file' };
  let cliMissing = false; // his click found no login
  const cliOn = () => cli.source === 'opencode-cli';
  const cliRow = (() => {
    if (!zumi.brainKey.cliLoginSet || !el.edit || !el.edit.parentNode) return null;
    const row = document.createElement('div'); row.id = 'brain-cli-login'; row.className = 'stack'; row.hidden = true;
    const button = document.createElement('button'); button.id = 'brain-cli-login-btn'; button.type = 'button'; button.className = 'ghost';
    const source = document.createElement('p'); source.id = 'brain-cli-login-source'; source.className = 'note';
    const missing = document.createElement('p'); missing.id = 'brain-cli-login-missing'; missing.className = 'note bad';
    row.append(button, source, missing);
    el.edit.parentNode.appendChild(row);
    button.addEventListener('click', async () => {
      const on = !cliOn();
      button.disabled = true;
      try { cli = await zumi.brainKey.cliLoginSet(on); } catch { cli = { active: false, source: 'key-file' }; }
      button.disabled = false;
      cliMissing = on && !cli.active;
      editing = false;
      paint();
      changed();
    });
    return { row, button, source, missing };
  })();
  async function readCli() {
    if (!cliRow) return;
    try { cli = await zumi.brainKey.cliLoginStatus(); } catch { cli = { active: false, source: 'key-file' }; }
    cliMissing = cliOn() && !cli.active;
  }

  const take = (r) => { if (r && typeof r.saved === 'boolean') view = { provider: r.provider || view.provider, saved: r.saved, last4: r.saved ? r.last4 : null, checked: r.saved ? r.checked || null : null }; };
  const changed = () => document.dispatchEvent(new CustomEvent('zumi:brain-key-changed'));
  const keyPrefix = () => (PROVIDERS[providerId] && PROVIDERS[providerId].keyPrefix) || '';
  const busy = (on) => { busyNow = on; for (const b of [el.save, el.saveAnyway, el.cancel, el.check, el.change, el.clear, el.test]) if (b) b.disabled = on; el.input.disabled = on || ageBlocked(); };

  // ---------- FL-2: preset notices + the 18+ confirm (Tauri only) ----------
  // Built at init from plain elements, never from index.html markup, so Electron (no window.__TAURI__) renders the exact
  // DOM it rendered before this step. The limits page is shown as its official URL text: opening a URL from the page
  // needs a host-side allow-listed open, and FL-2 adds no such surface.
  function buildFreeLlm() {
    if (!isTauriHost() || !el.notice || !el.notice.parentNode) return null;
    const box = document.createElement('div');
    box.id = 'brain-free-llm';
    box.className = 'free-llm';
    const note = (id) => { const n = document.createElement('p'); n.id = id; n.className = 'note'; box.appendChild(n); return n; };
    const developer = note('brain-free-developer');
    const eea = note('brain-free-gemini-eea');
    const slow = note('brain-free-gemini-slow');
    const freeTier = note('brain-free-gemini-free');
    // Cloudflare Workers AI needs its Account ID: the one extra field in the preset list.
    const accountRow = document.createElement('div');
    accountRow.id = 'brain-free-cf-row';
    accountRow.className = 'line';
    const accountLabel = document.createElement('label');
    accountLabel.setAttribute('for', 'brain-free-cf-account');
    const accountInput = document.createElement('input');
    accountInput.id = 'brain-free-cf-account';
    accountInput.type = 'text';
    accountInput.autocomplete = 'off';
    accountInput.spellcheck = false;
    const accountSave = document.createElement('button');
    accountSave.id = 'brain-free-cf-save';
    accountSave.type = 'button';
    accountRow.appendChild(accountLabel);
    accountRow.appendChild(accountInput);
    accountRow.appendChild(accountSave);
    box.appendChild(accountRow);
    const accountNote = note('brain-free-cf-note');
    const row = document.createElement('div');
    row.id = 'brain-free-age-row';
    row.className = 'line';
    const checkbox = document.createElement('input');
    checkbox.id = 'brain-free-age18';
    checkbox.type = 'checkbox';
    checkbox.className = 'sw'; // the settings checkbox style, so flex:none keeps it beside its label
    const label = document.createElement('label');
    label.setAttribute('for', 'brain-free-age18');
    row.appendChild(checkbox);
    row.appendChild(label);
    box.appendChild(row);
    const hint = note('brain-free-age18-hint');
    const ageReason = note('brain-free-age18-reason');
    const switchProvider = document.createElement('button');
    switchProvider.id = 'brain-free-switch-provider';
    switchProvider.type = 'button';
    switchProvider.className = 'ghost slim';
    switchProvider.hidden = true;
    // Inline like "Open the key page": a full-width grid item would stretch the button across the card.
    const switchRow = document.createElement('div');
    switchRow.className = 'line';
    switchRow.appendChild(switchProvider);
    box.appendChild(switchRow);
    const limits = note('brain-free-limits');
    el.notice.parentNode.insertBefore(box, el.notice.nextSibling);
    // The key field is disabled while the 18+ box is unticked; this one-liner says why, right under the field.
    const keyHint = document.createElement('p');
    keyHint.id = 'brain-free-key-hint';
    keyHint.className = 'note';
    keyHint.hidden = true;
    // AFTER the flex row (brain-key-edit), never inside it: a p beside the input became a flex sibling and squashed the field to 'Paste your' (gap 3).
    if (el.edit && el.edit.parentNode) el.edit.parentNode.insertBefore(keyHint, el.edit.nextSibling);
    // A stranger met a blocked field with the switch that unblocks it far above: put the switch and its reason right over the field.
    if (el.edit && el.edit.parentNode) if (isPublicText()) { el.edit.parentNode.insertBefore(row, el.edit); el.edit.parentNode.insertBefore(ageReason, el.edit); el.edit.parentNode.insertBefore(hint, el.edit); }

    // Confirming writes settings.json through the sidecar setter (S2). It never trusts the checkbox alone.
    const persistAge = async (next) => {
      let r = null;
      try { r = zumi.ai && zumi.ai.setPresetSettings ? await zumi.ai.setPresetSettings({ age18Confirmed: next }) : null; } catch { r = null; }
      const accepted = Boolean(r && r.ok && r.settings && r.settings.age18Confirmed === next);
      age18 = accepted ? next : !next;
      if (r && r.ok && r.settings) presetSettings = r.settings;
      checkbox.checked = age18;
    };
    checkbox.addEventListener('change', async () => {
      await persistAge(checkbox.checked === true);
      paintFreeLlm();
      paint();
    });
    accountInput.addEventListener('input', () => { accountId = String(accountInput.value || ''); });
    accountSave.addEventListener('click', async () => {
      const value = String(accountInput.value || '').trim();
      let r = null;
      try { r = zumi.ai && zumi.ai.setPresetSettings ? await zumi.ai.setPresetSettings({ cloudflareAccountId: value }) : null; } catch { r = null; }
      if (r && r.ok && r.settings) {
        presetSettings = r.settings;
        accountId = presetSettings.cloudflareAccountId || '';
        accountInput.value = accountId;
        accountNote.className = 'note ok';
        accountNote.textContent = t('settings.presetAccountSaved');
      } else {
        accountNote.className = 'note bad';
        accountNote.textContent = r && r.error === 'bad_cloudflare_account_id' ? t('settings.presetAccountBad') : t('settings.saveFailed');
      }
    });
    // One-click path for a user blocked mid-chat: switch to a free provider that needs no age confirm.
    switchProvider.addEventListener('click', async () => {
      const target = (tauriPresets && tauriPresets.free || []).map((p) => p.id).find((id) => id !== 'gemini' && id !== 'cloudflare') || 'groq';
      await applyProvider(target);
    });
    return { box, developer, eea, slow, freeTier, accountRow, accountLabel, accountInput, accountSave, accountNote, row, checkbox, label, hint, ageReason, keyHint, switchProvider, limits };
  }

  // Re-apply the block for the selected provider. The developer-service line is on every preset; the EEA/UK/CH note and
  // the free-tier training/review warning are Gemini's, and the latter carries its own "outside EEA/UK/CH" qualifier
  // instead of guessing the user's region (Opus review, 22-10).
  function presetMeta(id) {
    if (!tauriPresets) return null;
    return (tauriPresets.free || []).concat(tauriPresets.advanced || []).find((p) => p.id === id) || null;
  }
  function paintFreeLlm() {
    if (!free) return;
    const meta = presetMeta(providerId);
    const ui = FREE_LLM_UI[providerId];
    const preset = meta ? { ...ui, ...meta } : ui;
    free.box.hidden = !preset;
    if (!preset) return;
    const label = (meta && meta.label) || (PROVIDERS[providerId] && PROVIDERS[providerId].label) || providerId;
    free.developer.hidden = false;
    free.developer.textContent = t('settings.presetDeveloperService', { provider: label });
    const gemini = providerId === 'gemini';
    free.eea.hidden = !gemini;
    free.eea.textContent = gemini ? t('settings.presetGeminiEea') : '';
    // Approved copy (cos-bc 22-10): a plain speed note, Gemini only, no numbers.
    free.slow.hidden = !gemini;
    free.slow.textContent = gemini ? t('settings.presetGeminiSlow') : '';
    free.freeTier.hidden = !gemini;
    free.freeTier.textContent = gemini ? t('settings.presetGeminiFreeTier') : '';
    // The Account ID field exists for Cloudflare only (the one preset with requiresAccountId).
    const wantsAccount = providerId === 'cloudflare' || preset.requiresAccountId === true;
    free.accountRow.hidden = !wantsAccount;
    free.accountLabel.textContent = t('settings.presetAccountLabel');
    free.accountInput.placeholder = t('settings.presetAccountPlaceholder');
    free.accountSave.textContent = t('settings.presetAccountSave');
    if (wantsAccount && accountId && free.accountInput.value !== accountId) free.accountInput.value = accountId;
    if (!wantsAccount) { free.accountNote.textContent = ''; free.accountNote.className = 'note'; }
    free.row.hidden = !preset.requiresAge18;
    free.checkbox.checked = age18;
    free.label.textContent = t('settings.presetAge18');
    free.hint.hidden = !preset.requiresAge18 || age18;
    free.hint.textContent = t('settings.presetAge18Required');
    free.ageReason.hidden = !preset.requiresAge18 || age18;
    free.ageReason.textContent = preset.requiresAge18 && !age18 ? t('settings.presetAge18Reason') : '';
    // One-click escape only where it is useful: Gemini is selected and its 18+ box is still unticked.
    free.switchProvider.hidden = !(gemini && !age18);
    free.switchProvider.textContent = t('settings.presetSwitchProvider');
    // The official limits page is a link through the existing fixed-id guide mechanism (never a page-supplied URL).
    const limitsText = `${t('settings.presetCheckLimits')}: ${preset.limitsUrl}`;
    free.limits.textContent = '';
    if (zumi.talk && typeof zumi.talk.openGuide === 'function') {
      const a = document.createElement('a');
      a.href = preset.limitsUrl;
      a.textContent = limitsText;
      a.addEventListener('click', (ev) => { if (ev && ev.preventDefault) ev.preventDefault(); try { zumi.talk.openGuide(`preset-limits-${providerId}`); } catch { /* no browser: nothing to do */ } });
      free.limits.appendChild(a);
    } else {
      free.limits.textContent = limitsText;
    }
  }
  // A preset whose provider terms require 18+ cannot be saved until the box is ticked; the save handlers also refuse
  // the call, so the gate holds even if the button state is bypassed.
  const ageBlocked = () => Boolean(free && FREE_LLM_UI[providerId] && FREE_LLM_UI[providerId].requiresAge18 && !age18);
  free = buildFreeLlm();

  // ---------- provider picker + guide (T-31 BYOK) ----------
  // The option text follows the mode: "free" names the free-model providers (freeLabel, plus a short note such as
  // "no card needed"), "byok" lists every provider by its plain label. The builder lives in providers.js so the label
  // and the model actually sent stay testable together (T-31 fix round item 3).
  // T-31 follow-up item 1: the shown mode is pickerMode(mode, providerId) -- since OpenCode is paid, a profile left on
  // "free" with OpenCode pinned shows "Tự nhập khoá" instead, so the free list never lists or selects OpenCode.
  function fillProviders() {
    if (!el.provider) return;
    const shown = pickerMode(mode, providerId); // T-31 free-click: the labels follow the SHOWN mode, so they never disagree with the pressed header button
    const baseIds = providerIdsForMode(shown);
    el.provider.textContent = '';
    // FL-3: in Tauri the list comes from the sidecar (`ai.presetList`), NOT from the frozen renderer table, which has
    // no Cloudflare/Mistral entries. The four defaults keep their fixed order and Mistral sits in an Advanced group.
    const freeIds = tauriPresets ? tauriPresets.free.map((p) => p.id) : [...baseIds];
    const advancedIds = tauriPresets ? tauriPresets.advanced.map((p) => p.id) : [];
    const ids = [...freeIds];
    if (tauriPresets && shown === 'byok' && !ids.includes('opencode')) ids.push('opencode');
    if (ownerBuild && shown === 'byok') for (const id of OWNER_ONLY_PROVIDER_IDS) if (!ids.includes(id)) ids.push(id);
    if (!ids.includes(providerId) && !advancedIds.includes(providerId)) ids.push(providerId); // never hide the pinned provider
    const addOption = (parent, id) => {
      const o = document.createElement('option');
      o.value = id;
      const meta = presetMeta(id);
      o.textContent = meta && (id === 'cloudflare' || id === 'mistral') ? meta.label : optionLabel(id, shown, t);
      parent.appendChild(o);
    };
    for (const id of ids) addOption(el.provider, id);
    if (advancedIds.length) {
      const group = document.createElement('optgroup');
      group.setAttribute('label', t('settings.presetAdvanced'));
      for (const id of advancedIds) addOption(group, id);
      el.provider.appendChild(group);
    }
    el.provider.value = providerId;
  }
  function paintMode() {
    const shown = pickerMode(mode, providerId);
    if (el.modeFree) el.modeFree.setAttribute('aria-pressed', shown === 'free' ? 'true' : 'false');
    if (el.modeByok) el.modeByok.setAttribute('aria-pressed', shown === 'byok' ? 'true' : 'false');
  }
  // The selected provider's numbered steps, in the active UI language, and its notice (Gemini's free-tier training
  // line, OpenCode's paid-credits line), when the table carries one.
  function paintGuide() {
    // Tauri-only presets (Cloudflare, Mistral) are not in the frozen renderer table; their label/guide/notice come from
    // the sidecar's `ai.presetList` answer. Electron has no tauriPresets and keeps the frozen path unchanged.
    const p = PROVIDERS[providerId] || presetMeta(providerId) || PROVIDERS[providerIdsForMode(pickerMode(mode, providerId))[0]];
    if (el.guide) {
      const steps = (p.guide && (p.guide[getLocale()] || p.guide.en)) || [];
      el.guide.textContent = '';
      for (const s of steps) { const li = document.createElement('li'); li.textContent = s; el.guide.appendChild(li); }
    }
    if (el.notice) {
      // R3: under Tauri, Gemini (in BOTH free and BYOK mode) must not show the frozen unqualified training line; the
      // qualified (D) line is the only one (it carries the EEA/UK/CH qualifier). Electron renders exactly what it did.
      const frozenGeminiFree = Boolean(free) && providerId === 'gemini' && p.notice === 'settings.trainNoticeFreeTier';
      el.notice.hidden = frozenGeminiFree || !p.notice;
      el.notice.textContent = el.notice.hidden ? '' : (p.notice ? t(p.notice) : '');
    }
    paintFreeLlm();
  }
  if (el.guideOpen) el.guideOpen.addEventListener('click', () => { if (zumi.ai) zumi.ai.openKeyPage(); });
  // Switch the active provider through main -- the steps the provider picker and the free-mode switch share. On
  // success the pinned provider, its guide and its key status are re-read, and chat + the roles card re-read via
  // changed() (main rebuilt the chat brain against the new provider). Returns whether main accepted it; a refusal
  // leaves every value untouched (T-31 free-click: extracted so the two call sites share one path).
  async function applyProvider(id) {
    let r = null;
    try { r = zumi.ai ? await zumi.ai.setProvider(id) : null; } catch { r = null; }
    if (!r || !r.ok) return false; // refused: keep the previous provider selected
    providerId = r.id;
    paintGuide();
    // A different provider means a different key file: re-read the key status for this one, and let chat + the roles
    // card re-read too (main rebuilt the chat brain against the new provider).
    try { take(await zumi.brainKey.status()); } catch { /* keep the last view */ }
    await readCli();
    editing = false;
    pendingKey = null;
    line = null;
    // The shown mode depends on the provider (OpenCode is shown in "Tự nhập khoá"), so repaint the header + the picker
    // group here too: a provider change must never leave a stale pressed button or stale option labels behind.
    paintMode();
    fillProviders();
    changed();
    paint();
    return true;
  }

  // T-31 OpenCode BYOK: switch the two-choice header. Persisted by main, which also rebuilds the chat brain (the mode
  // picks the model sent); the picker regroups and the roles card re-reads via changed().
  // T-31 free-click: the choice is compared against the SHOWN mode (pickerMode), and "Dùng miễn phí" must never stay
  // pinned to a paid provider: it switches to the free default (the first free id), exactly as the picker does.
  async function pickMode(next) {
    const shown = pickerMode(mode, providerId);
    // Nothing to do only when BOTH the SHOWN and the STORED mode already are `next`: comparing against the shown mode
    // alone would make "Tự nhập khoá" a dead no-op for a stored-free profile pinned to OpenCode (shown byok).
    if (next === shown && next === mode) return;
    const prevMode = mode;
    let r = null;
    try { r = zumi.ai ? await zumi.ai.setMode(next) : null; } catch { r = null; }
    if (!r || !r.ok) return; // refused: keep the previous mode selected
    mode = r.mode;
    // Free mode must not leave a paid provider (OpenCode) pinned. If main refuses the switch, put the previous mode
    // back; if even that fails, re-read the mode main actually has so the card never claims a mode main is not using.
    let moved = false;
    if (mode === 'free' && !providerIdsForMode('free').includes(providerId)) {
      moved = await applyProvider(providerIdsForMode('free')[0]);
      if (!moved) {
        let back = null;
        try { back = zumi.ai ? await zumi.ai.setMode(prevMode) : null; } catch { back = null; }
        if (back && back.ok) mode = back.mode;
        else { try { const p = zumi.ai ? await zumi.ai.provider() : null; if (p && p.mode) mode = p.mode; } catch { /* keep */ } }
      }
    }
    paintMode();
    fillProviders();
    // The mode decides the model sent (free -> the table's free ids, even for a legacy user), so let chat + the roles
    // card re-read (T-31 fix round item 3). applyProvider already emitted changed() when the provider moved.
    if (!moved) changed();
  }
  if (el.modeFree) el.modeFree.addEventListener('click', () => pickMode('free'));
  if (el.modeByok) el.modeByok.addEventListener('click', () => pickMode('byok'));
  if (el.provider) el.provider.addEventListener('change', async () => {
    busy(true);
    const moved = await applyProvider(el.provider.value);
    busy(false);
    if (!moved) el.provider.value = providerId; // refused: keep the previous provider selected
  });

  function paint() {
    // Saved + known to work: "Saved". Saved but never checked / provider unreachable: "Not checked". Refused: "Refused".
    const [chipKey, tone] = !view.saved ? ['settings.chipNoKey', ''] : view.checked === 'works' ? ['settings.chipSaved', 'ok']
      : view.checked === 'rejected' ? ['settings.chipRefused', 'bad'] : view.checked === 'unverified' ? ['settings.chipKeyUnverified', ''] : ['settings.chipNotChecked', ''];
    el.chip.textContent = t(chipKey);
    el.chip.className = tone ? `pill ${tone}` : 'pill';
    el.check.hidden = !view.saved || view.checked === 'works' || view.checked === 'unverified'; // unverified: there is no check to run
    el.desc.textContent = view.saved ? t('settings.ownKeyEndingD', { provider: view.provider, last4: view.last4 }) : t('settings.ownKeyNoneD');
    el.mask.textContent = view.saved ? `•••••••••••••••• ${view.last4}` : '';
    el.view.hidden = !view.saved || editing;
    el.edit.hidden = view.saved && !editing;
    el.cancel.hidden = !view.saved;
    // "Lưu dù chưa thử được" (Save anyway): only while an unreachable Save is waiting for the user's confirmation.
    if (el.saveAnyway) el.saveAnyway.hidden = !pendingKey;
    el.input.placeholder = t('settings.ownKeyPh', { provider: view.provider });
    const prefix = keyPrefix();
    // A provider with no documented key prefix (OpenCode) gets the prefix-less bad-format line instead.
    const [lineKey, lineTone] = line === 'bad_format' && !prefix ? ['settings.keyBadFormatNoPrefix', 'bad'] : ((line && LINE[line]) || [line ? 'settings.saveFailed' : '', line ? 'bad' : '']);
    // The key-status lines name the active provider (and the bad-format line its prefix), never a hardcoded vendor.
    el.note.textContent = lineKey ? t(lineKey, { provider: view.provider, prefix, a: indefiniteArticle(view.provider) }) : '';
    el.note.className = lineTone ? `note ${lineTone}` : 'note';
    // FL-2: the 18+ gate owns Save's disabled state while the card is idle; busy() reasserts it during a call.
    if (free) {
      if (el.save) el.save.disabled = busyNow || ageBlocked();
      if (el.saveAnyway) el.saveAnyway.disabled = busyNow || ageBlocked();
      // Unticking with text in the field wipes it (the key is never held while blocked); the field then stays disabled.
      const blocked = ageBlocked();
      if (blocked && el.input.value) { el.input.value = ''; pendingKey = null; }
      el.input.disabled = busyNow || blocked;
      free.keyHint.textContent = blocked ? t('settings.presetAge18KeyHint') : '';
      free.keyHint.hidden = !blocked || Boolean(el.edit.hidden);
    }
    if (cliRow) {
      cliRow.row.hidden = !(ownerBuild && providerId === 'opencode-go');
      cliRow.button.textContent = t(cliOn() ? 'settings.cliLoginStop' : 'settings.cliLoginUse');
      cliRow.source.textContent = t(cliOn() ? 'settings.cliLoginSource' : 'settings.cliLoginSourcePaste');
      cliRow.missing.textContent = cliMissing ? t('settings.cliLoginMissing') : '';
      cliRow.missing.hidden = !cliMissing;
      if (!cliRow.row.hidden && cliOn()) { // the pasted key is not in use: no field, no last four
        el.view.hidden = true;
        el.edit.hidden = true;
        el.desc.textContent = '';
        el.chip.textContent = t(cli.active ? 'settings.chipKeyUnverified' : 'settings.chipNoKey');
        el.chip.className = 'pill';
      }
    }
  }

  // save(confirm): confirm === true re-sends the key held in pendingKey with main's confirmUnreachable flag (the
  // "Lưu dù chưa thử được" button). A first Save reads the field and empties it at once; a result of 'unreachable'
  // is withheld by main and only the explicit confirmation (or a working/rejected verdict) clears pendingKey.
  async function save(confirm) {
    if (ageBlocked()) { el.input.value = ''; pendingKey = null; paint(); return; } // FL-2: the 18+ confirm is required before this preset's key can be saved; a key that cannot be saved must not linger in the field either
    const raw = confirm ? pendingKey : el.input.value;
    if (!confirm) el.input.value = ''; // never let the key linger in the DOM, success or not
    if (!raw) return;
    line = 'checking'; busy(true); paint();
    let r;
    try { r = await zumi.brainKey.save(raw, Boolean(confirm)); } catch { r = null; }
    busy(false);
    take(r);
    if (r && r.ok) { pendingKey = null; editing = false; line = r.check === 'works' ? 'works' : r.check === 'unverified' ? 'unverified' : 'unreachable'; changed(); }
    else if (r && r.error === 'unreachable') { pendingKey = raw; line = 'unreachableNoSave'; }
    else { pendingKey = null; line = (r && r.error) || 'failed'; }
    paint();
  }

  el.save.addEventListener('click', () => save(false));
  // A key typed or pasted while the 18+ gate is closed can never be saved: drop it at once instead of holding it in the page.
  el.input.addEventListener('input', () => { if (ageBlocked()) el.input.value = ''; });
  if (el.saveAnyway) el.saveAnyway.addEventListener('click', () => save(true));
  el.input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); save(false); } });
  // "Thử khoá" (T-31 BYOK): run the minimal key-test call on what is in the field, before saving it; with an empty
  // field, test the already-saved key instead. Never stored, never logged; the answer is shown in plain words.
  if (el.test) el.test.addEventListener('click', async () => {
    const raw = el.input.value.trim();
    pendingKey = null;
    line = 'checking'; busy(true); paint();
    let r;
    try { r = raw ? (zumi.ai ? await zumi.ai.testKey(raw) : null) : await zumi.brainKey.test(); } catch { r = null; }
    busy(false);
    take(r);
    line = !r ? 'failed' : r.check === 'works' ? (raw ? 'testOk' : 'works') : r.check === 'unverified' ? 'unverified' : r.check === 'rejected' ? 'rejected' : r.check === 'unreachable' ? 'checkUnreachable' : r.error || 'failed';
    paint();
  });
  el.check.addEventListener('click', async () => {
    line = 'checking'; busy(true); paint();
    let r;
    try { r = await zumi.brainKey.test(); } catch { r = null; }
    busy(false);
    take(r);
    line = !r ? 'failed' : r.check === 'works' ? 'works' : r.check === 'unverified' ? 'unverified' : r.check === 'rejected' ? 'storedRejected' : r.check === 'unreachable' ? 'checkUnreachable' : r.error || 'failed';
    if (r && r.ok) changed();
    paint();
  });
  el.change.addEventListener('click', () => { editing = true; pendingKey = null; line = null; paint(); el.input.focus(); });
  el.cancel.addEventListener('click', () => { editing = false; el.input.value = ''; pendingKey = null; line = null; paint(); });
  el.clear.addEventListener('click', async () => {
    busy(true);
    let r;
    try { r = await zumi.brainKey.clear(); } catch { r = null; }
    busy(false);
    take(r);
    editing = false;
    pendingKey = null;
    line = r && r.ok ? 'cleared' : 'failed';
    if (r && r.ok) changed();
    paint();
  });
  onLocaleChange(() => { paintGuide(); fillProviders(); paint(); });

  async function refresh() {
    if (zumi.ai) {
      try { const i = await zumi.info(); ownerBuild = Boolean(i && i.ownerAdmin); } catch { /* not listed; a public build refuses it anyway */ }
      try { const p = await zumi.ai.provider(); if (p && p.id) providerId = p.id; if (p && p.mode) mode = p.mode; } catch { /* keep the default */ }
      // FL-3: the Tauri sidecar owns the full preset list and the two non-secret settings. Absent in Electron, so this
      // branch never runs there.
      if (zumi.ai.presetList) {
        try {
          const list = await zumi.ai.presetList();
          if (list && Array.isArray(list.free)) {
            tauriPresets = { free: list.free, advanced: Array.isArray(list.advanced) ? list.advanced : [] };
            presetSettings = list.settings || presetSettings;
            accountId = typeof presetSettings.cloudflareAccountId === 'string' ? presetSettings.cloudflareAccountId : '';
            age18 = presetSettings.age18Confirmed === true;
          }
        } catch { /* keep the frozen list: the picker still works for the providers it knows */ }
      }
    }
    paintMode();
    fillProviders();
    paintGuide();
    try { take(await zumi.brainKey.status()); } catch { /* keep the last view */ }
    await readCli();
    pendingKey = null;
    paint();
    return view;
  }
  refresh();
  return { refresh };
}
