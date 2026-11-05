// Settings > Agent & Soul > Voice card: the BYO provider sub-panels, the per-language "Test voice" buttons and the reply
// language row (T-31 talk-mode inc 3, PLAN section 10.3). settings.js owns the card's other rows and the two provider
// selects; it hands this module the provider list and the saved prefs (both free of secrets) after every change.
//
// Secrets: a key is typed into a password field, sent to main through talk:setProviderKey and the field is wiped at
// once; nothing here ever reads a key back (only `hasKey` returns). Panels are built with createElement/textContent,
// never innerHTML, and text uses data-i18n so a language switch repaints them.
import { t, onLocaleChange } from './i18n.js';

// One panel per provider that needs a key or non-secret config. Google keeps its static markup in index.html (its ids
// are part of the settings-tabs contract); it is only shown/hidden here.
export const PANELS = {
  gemini: {
    key: 'required', guides: ['gemini', 'geminiDocs'],
    fields: [{ group: 'voiceGemini', field: 'model', label: 'settings.vp.model' }, { group: 'voiceGemini', field: 'voice', label: 'settings.vp.voice' }],
  },
  elevenlabs: {
    key: 'required', guides: ['elevenlabs'],
    fields: [
      { group: 'voiceEleven', field: 'voiceId', label: 'settings.vp.voiceId', placeholder: 'settings.vp.voiceIdPh' },
      // flash_v2_5 is the default: the API default (multilingual_v2) has no Vietnamese. The last option is English only.
      { group: 'voiceEleven', field: 'model', label: 'settings.vp.model', options: ['eleven_flash_v2_5', 'eleven_v3', 'eleven_v4', 'eleven_v4_turbo', 'eleven_multilingual_v2'] },
    ],
  },
  'http-openai': {
    key: 'optional', guides: [],
    fields: [
      { group: 'voiceCustom', field: 'base', label: 'settings.vp.base', placeholder: 'settings.vp.basePh' },
      { group: 'voiceCustom', field: 'model', label: 'settings.vp.model' },
      { group: 'voiceCustom', field: 'voice', label: 'settings.vp.voice' },
    ],
  },
  'http-zumia': {
    key: 'optional', guides: [],
    fields: [{ group: 'voiceCustomZumia', field: 'url', label: 'settings.vp.url', placeholder: 'settings.vp.urlPh' }],
  },
};

// Main's typed error code -> the i18n key of a plain sentence (PLAN 10.3 item 6). Unknown codes read as "failed".
export const TEST_ERROR_KEY = {
  no_key: 'settings.testErr.no_key', no_config: 'settings.testErr.no_config', auth_failed: 'settings.testErr.auth_failed',
  rate_limited: 'settings.testErr.rate_limited', timeout: 'settings.testErr.timeout', unsupported_lang: 'settings.testErr.unsupported_lang',
  'voice-off': 'settings.testErr.voiceOff', 'voice-off-lang': 'settings.testErr.off', bad_response: 'settings.testErr.bad_response', too_large: 'settings.testErr.bad_response',
  no_provider: 'settings.testErr.no_provider',
};
export const testErrorKey = (reason) => TEST_ERROR_KEY[reason] || (/^http_5\d\d$/.test(String(reason)) ? 'settings.testErr.server' : 'settings.testErr.failed');

const mk = (tag, props = {}, kids = []) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else if (k === 'i18n') { n.setAttribute('data-i18n', v); n.textContent = t(v); } else n.setAttribute(k, v);
  }
  for (const c of kids) n.appendChild(c);
  return n;
};

export function initVoiceProviders({ zumi, $, voice = null }) {
  const host = $('voice-panels');
  const googlePanel = $('vp-google');
  const replyLang = $('voice-reply-lang');
  const test = { en: $('voice-test-en'), vi: $('voice-test-vi') };
  const testNote = $('voice-test-note');
  let list = [];
  let prefs = {};
  const panels = {};

  const changed = () => document.dispatchEvent(new CustomEvent('zumi:voice-changed'));
  const provider = (id) => list.find((p) => p.id === id) || null;

  // ---------- one panel ----------
  function build(id, spec) {
    const chip = mk('span', { class: 'pill', id: `vp-${id}-chip` });
    const status = mk('p', { class: 'note', id: `vp-${id}-status`, 'aria-live': 'polite' });
    const root = mk('div', { class: 'vp', id: `vp-${id}`, hidden: '' });
    const head = mk('div', { class: 'top' }, [
      mk('div', { class: 'lbl' }, [mk('div', { class: 'k', i18n: `settings.provider.${id}` }), mk('div', { class: 'd', i18n: `settings.vp.desc.${id}` })]),
      chip,
    ]);
    const stack = mk('div', { class: 'srow stack' }, [head]);
    let keyInput = null;
    if (spec.key) {
      keyInput = mk('input', { id: `vp-${id}-key`, type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: t('settings.vp.keyPh'), 'data-i18n-placeholder': 'settings.vp.keyPh' });
      const save = mk('button', { class: 'ghost', type: 'button', id: `vp-${id}-save`, i18n: 'settings.voiceApiKeySave' });
      const clear = mk('button', { class: 'ghost', type: 'button', id: `vp-${id}-clear`, i18n: 'settings.voiceApiKeyClear' });
      stack.appendChild(mk('div', { class: 'line' }, [keyInput, save, clear]));
      save.addEventListener('click', async () => {
        const raw = keyInput.value;
        keyInput.value = ''; // never let the key linger in the DOM, success or not
        let saved = false;
        try { saved = await zumi.talk.setProviderKey(id, raw); } catch { saved = false; }
        say(id, saved ? 'settings.voiceKeySaved' : 'settings.vp.keyBad', !saved);
        if (saved) { changed(); refreshList(); }
      });
      clear.addEventListener('click', async () => {
        try { await zumi.talk.clearProviderKey(id); } catch { /* best effort */ }
        say(id, 'settings.voiceKeyCleared', false);
        changed(); refreshList();
      });
    }
    root.appendChild(stack);
    const inputs = {};
    for (const f of spec.fields) {
      const inputId = `vp-${id}-${f.field}`;
      let input;
      if (f.options) {
        input = mk('select', { id: inputId, 'aria-label': t(f.label), 'data-i18n-aria': f.label });
        for (const o of f.options) input.appendChild(mk('option', { value: o, text: o }));
      } else {
        input = mk('input', { id: inputId, type: 'text', autocomplete: 'off', spellcheck: 'false', maxlength: '300', 'aria-label': t(f.label), 'data-i18n-aria': f.label });
        if (f.placeholder) { input.setAttribute('placeholder', t(f.placeholder)); input.setAttribute('data-i18n-placeholder', f.placeholder); }
      }
      input.addEventListener('change', () => saveField(id, f, input));
      inputs[f.field] = { input, spec: f };
      root.appendChild(mk('div', { class: 'srow' }, [
        mk('div', { class: 'lbl' }, [mk('div', { class: 'k' }, [mk('label', { for: inputId, i18n: f.label })])]),
        mk('div', { class: 'ctl' }, [input]),
      ]));
    }
    root.appendChild(status);
    if (spec.key === 'optional') root.appendChild(mk('p', { class: 'note', i18n: 'settings.vp.keyOptionalNote' }));
    if (id === 'elevenlabs') root.appendChild(mk('p', { class: 'note', i18n: 'settings.vp.elevenViNote' }));
    for (const g of spec.guides) {
      const b = mk('button', { class: 'ghost slim', type: 'button', id: `vp-${id}-guide-${g}`, i18n: `settings.vp.guide.${g}` });
      b.addEventListener('click', () => { try { zumi.talk.openGuide(g); } catch { /* no browser: nothing to do */ } });
      root.appendChild(mk('p', { class: 'note' }, [b]));
    }
    host.appendChild(root);
    return { root, chip, status, keyInput, inputs, spec };
  }

  function say(id, key, bad) {
    const p = panels[id];
    if (!p) return;
    p.status.textContent = t(key);
    p.status.classList.toggle('bad', Boolean(bad));
  }

  async function saveField(id, f, input) {
    let r;
    try { r = await zumi.talk.setVoicePrefs({ [f.group]: { [f.field]: input.value } }); } catch { r = null; }
    if (r) prefs = r;
    const refused = Boolean(r && Array.isArray(r.rejected) && r.rejected.includes(`${f.group}.${f.field}`));
    say(id, refused ? 'settings.vp.fieldBad' : 'settings.vp.fieldSaved', refused);
    paintFields(id);
    changed();
  }

  function paintFields(id) {
    const p = panels[id];
    if (!p) return;
    for (const { input, spec } of Object.values(p.inputs)) {
      const v = prefs[spec.group] && prefs[spec.group][spec.field];
      if (typeof v === 'string' && document.activeElement !== input) input.value = v;
    }
  }

  // ---------- paint everything from the provider list + saved prefs ----------
  const chosen = () => ({ en: prefs.voiceProviderEn, vi: prefs.voiceProviderVi });

  function paintPanels() {
    const sel = chosen();
    for (const [id, p] of Object.entries(panels)) {
      const a = provider(id);
      const used = sel.en === id || sel.vi === id;
      p.root.hidden = !used || !a;
      if (a) {
        const has = a.hasKey;
        p.chip.textContent = t(has ? 'settings.chipKeySaved' : (a.keyOptional ? 'settings.vp.chipNoKeyOptional' : 'settings.chipNoKey'));
        p.chip.className = has ? 'pill ok' : 'pill';
      }
      paintFields(id);
    }
    if (googlePanel) googlePanel.hidden = !(sel.en === 'google' || sel.vi === 'google');
  }

  function paintTests() {
    const sel = chosen();
    for (const lang of ['en', 'vi']) {
      const btn = test[lang];
      if (!btn) continue;
      const a = provider(sel[lang]);
      const off = sel[lang] === 'off' || !sel[lang];
      btn.disabled = off;
      btn.textContent = t('settings.testVoice') + (a && a.paid ? ` ${t('settings.testVoicePaid')}` : '');
    }
  }

  function paint(nextList, nextPrefs) {
    if (Array.isArray(nextList)) list = nextList;
    if (nextPrefs) prefs = nextPrefs;
    if (replyLang && prefs.voiceReplyLang) replyLang.value = prefs.voiceReplyLang;
    paintPanels();
    paintTests();
  }

  async function refreshList() {
    try { list = (await zumi.talk.voiceProviders()) || list; } catch { /* keep the last list */ }
    paint();
  }

  // ---------- Test voice ----------
  async function runTest(lang) {
    const btn = test[lang];
    const a = provider(chosen()[lang]);
    if (!btn || !voice || !voice.playTest) return;
    btn.disabled = true;
    testNote.classList.remove('bad');
    if (a && a.paid) testNote.textContent = t('settings.testVoicePaidNote', { provider: t(`settings.provider.${a.id}`), n: String(t(`settings.testLine.${lang}`).length) });
    let r;
    try { r = await voice.playTest(lang, t(`settings.testLine.${lang}`)); } catch { r = { ok: false, reason: 'failed' }; }
    btn.disabled = false;
    if (r && r.ok) { testNote.textContent = t('settings.testPlayed'); return; }
    testNote.textContent = t(testErrorKey(r && r.reason));
    testNote.classList.add('bad');
  }

  if (host) for (const [id, spec] of Object.entries(PANELS)) panels[id] = build(id, spec);
  for (const lang of ['en', 'vi']) if (test[lang]) test[lang].addEventListener('click', () => runTest(lang));
  if (replyLang) replyLang.addEventListener('change', () => { zumi.talk.setVoicePrefs({ voiceReplyLang: replyLang.value }).then((r) => { if (r) prefs = r; changed(); }).catch(() => {}); });
  onLocaleChange(() => paint());
  return { paint, refreshList };
}
