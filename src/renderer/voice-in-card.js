// Settings > Agent & Soul > Voice in (T-31-MAUS R4b): the owner's one screen for the dictation engine. Everything shown is what
// zumi.stt.state() returns; the host (zumi-stt's service) is the one place that checks and saves a setting, and it accepts a save from
// this screen only. There is no field for a key: the key stays in a Windows environment variable and this screen names the variable.
// The "Install local engine" block (R4c) is the one place that calls zumi.stt.install: the engine is downloaded on first use, only after
// the owner clicks, with the size shown first; the host checks every download against a pinned checksum.
// Built here, not in index.html, like reminders-card.js, so a host without the stt API shows no control that does nothing. Text is set
// with textContent only.
import { t as i18nT, apply as i18nApply } from './i18n.js';
import { noticeText } from './voice-in.js';

/** True where the host has the voice settings API. */
export const cardAvailable = (zumi) => Boolean(zumi && zumi.stt && typeof zumi.stt.state === 'function' && typeof zumi.stt.set === 'function');

const LANGUAGES = ['auto', 'vi', 'en', 'zh', 'ja', 'ko', 'fr', 'de', 'es'];
const NAME_KEYS = { model: 'voice.install.name.model', program: 'voice.install.name.program' };
const PHASE_KEYS = { download: 'voice.install.phase.download', verify: 'voice.install.phase.verify', unpack: 'voice.install.phase.unpack', check: 'voice.install.phase.check' };
/** Whole megabytes (10^6 bytes), as the sizes are quoted. */
const mb = (bytes) => Math.round(Number(bytes || 0) / 1e6);

/** The object stt.set takes, from the form's values. An empty field is left out; no engine means voice off ({}). The fields of the
 *  other kind of engine are never sent (a program path with an API engine, a key variable with the local one). */
export function settingsFromForm(f) {
  const out = {};
  const engine = String(f.engine || '');
  if (!engine) return out;
  out.engine = engine;
  const language = String(f.language || '');
  if (language && language !== 'auto') out.language = language;
  const put = (key, value) => { const s = String(value == null ? '' : value).trim(); if (s) out[key] = s; };
  if (engine === 'local') {
    put('whisperExe', f.whisperExe);
    put('whisperModel', f.whisperModel);
    const threads = Number(f.threads);
    if (Number.isInteger(threads) && threads > 0) out.threads = threads;
  } else {
    put('keyEnv', f.keyEnv);
    put('baseUrl', f.baseUrl);
    put('model', f.model);
  }
  put('chord', f.chord);
  return out;
}

/** Adds the card to #stabpanel-agent and keeps it current. Resolves to { refresh } or null without the API. */
export async function initVoiceCard(zumi, $, { doc = typeof document === 'undefined' ? null : document, t = i18nT, apply = i18nApply } = {}) {
  const panel = $('stabpanel-agent');
  if (!doc || !panel || !cardAvailable(zumi) || $('stt-card')) return null;
  const node = (tag, cls, text, id) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; if (id) e.id = id; return e; };
  const label = (key) => { const l = node('div', 'lbl', t(key)); l.dataset.i18n = key; return l; };
  const row = (key, control, extra) => {
    const r = node('div', 'srow stack');
    r.appendChild(label(key));
    r.appendChild(control);
    if (extra) r.appendChild(extra);
    return r;
  };
  const option = (value, text) => { const o = node('option', null, text); o.value = value; return o; };
  const input = (id, type = 'text') => { const i = node('input', null, null, id); i.type = type; i.autocomplete = 'off'; i.spellcheck = false; return i; };

  // First-use install of the local engine. Built only where the host has it (zumi.stt.install).
  const canInstall = typeof zumi.stt.install === 'function';
  const inst = node('div', 'srow stack', null, 'voice-install');
  const instSize = node('div', 'd', '', 'voice-install-size');
  const instNote = node('div', 'd', '', 'voice-install-note');
  const instBtn = node('button', null, t('voice.install.button'), 'voice-install-btn');
  instBtn.type = 'button';
  instBtn.dataset.i18n = 'voice.install.button';
  // R4d: the larger model (large-v3-turbo) is an optional second download, never the default: its size and the slow-without-GPU
  // warning are written next to its button.
  const instLargeNote = node('div', 'd', '', 'voice-install-large-note');
  const instLargeBtn = node('button', null, t('voice.install.large.button'), 'voice-install-large-btn');
  instLargeBtn.type = 'button';
  instLargeBtn.dataset.i18n = 'voice.install.large.button';
  const instCancel = node('button', null, t('voice.install.cancel'), 'voice-install-cancel');
  instCancel.type = 'button';
  instCancel.dataset.i18n = 'voice.install.cancel';
  instCancel.hidden = true;
  const instBar = node('progress', null, null, 'voice-install-progress');
  instBar.max = 1;
  instBar.value = 0;
  instBar.hidden = true;
  const instStatus = node('div', 'd', '', 'voice-install-status');
  instStatus.setAttribute('aria-live', 'polite');
  if (canInstall) {
    inst.appendChild(label('voice.install.title'));
    const instHint = node('div', 'd', t('voice.install.hint'));
    instHint.dataset.i18n = 'voice.install.hint';
    inst.appendChild(instHint);
    inst.appendChild(instSize);
    inst.appendChild(instNote);
    const instActions = node('div', 'srow');
    instActions.appendChild(instBtn);
    instActions.appendChild(instCancel);
    inst.appendChild(instLargeNote);
    instActions.appendChild(instLargeBtn);
    inst.appendChild(instActions);
    inst.appendChild(instBar);
    inst.appendChild(instStatus);
  }

  const card = node('section', 'card', null, 'stt-card');
  const head = node('div', 'ghead');
  const title = node('h2', null, t('voice.card.title'));
  title.dataset.i18n = 'voice.card.title';
  head.appendChild(title);
  card.appendChild(head);
  const hint = node('div', 'd', t('voice.card.hint'));
  hint.dataset.i18n = 'voice.card.hint';
  card.appendChild(hint);

  const engine = node('select', null, null, 'voice-engine');
  const language = node('select', null, null, 'voice-language');
  for (const l of LANGUAGES) language.appendChild(option(l, l === 'auto' ? t('voice.card.auto') : l));
  const chord = node('select', null, null, 'voice-chord');
  const keyEnv = node('select', null, null, 'voice-keyenv');
  const keyNote = node('div', 'd', '', 'voice-key-note');
  const baseUrl = input('voice-baseurl');
  const model = input('voice-model');
  const exe = input('voice-exe');
  const wmodel = input('voice-wmodel');
  const threads = input('voice-threads', 'number');
  const exeDirs = node('div', 'd', '', 'voice-exe-dirs');
  const baseNote = node('div', 'd', t('voice.card.baseUrlHint'));
  baseNote.dataset.i18n = 'voice.card.baseUrlHint';

  card.appendChild(row('voice.card.engine', engine));
  card.appendChild(row('voice.card.language', language));
  if (canInstall) card.appendChild(inst);
  const apiRows = node('div', null, null, 'voice-api-rows');
  apiRows.appendChild(row('voice.card.keyEnv', keyEnv, keyNote));
  apiRows.appendChild(row('voice.card.baseUrl', baseUrl, baseNote));
  apiRows.appendChild(row('voice.card.model', model));
  card.appendChild(apiRows);
  const localRows = node('div', null, null, 'voice-local-rows');
  const exeHint = node('div', 'd', t('voice.card.exeHint'));
  exeHint.dataset.i18n = 'voice.card.exeHint';
  localRows.appendChild(row('voice.card.exe', exe, exeHint));
  localRows.appendChild(exeDirs);
  localRows.appendChild(row('voice.card.wmodel', wmodel));
  localRows.appendChild(row('voice.card.threads', threads));
  card.appendChild(localRows);
  card.appendChild(row('voice.card.chord', chord));
  const save = node('button', 'primary', t('voice.card.save'), 'voice-save');
  save.type = 'button';
  save.dataset.i18n = 'voice.card.save';
  const status = node('div', 'd', '', 'voice-card-status');
  status.setAttribute('aria-live', 'polite');
  const actions = node('div', 'srow');
  actions.appendChild(save);
  actions.appendChild(status);
  card.appendChild(actions);
  panel.appendChild(card);
  apply(card);

  let last = null;
  const say = (text) => { status.textContent = text || ''; };
  const fill = (select, items, current) => {
    select.textContent = '';
    for (const [value, text] of items) select.appendChild(option(value, text));
    select.value = current;
  };
  const keyNames = (state, which) => {
    const names = (state && state.keyEnvNames) || {};
    const own = (names.providers && names.providers[which]) || [];
    return [...own, ...(names.user ? [names.user] : [])];
  };
  function paintKeyEnv(state, which, current) {
    fill(keyEnv, [['', t('voice.card.keyEnvNone')], ...keyNames(state, which).map((n) => [n, n])], current || '');
  }
  function paintRows(which) {
    localRows.hidden = which !== 'local';
    apiRows.hidden = !which || which === 'local';
  }
  function paint(state) {
    last = state;
    fill(engine, [['', t('voice.card.off')], ...(state.engines || []).map((e) => [e, t(`voice.engine.${e}`)])], state.engine || '');
    language.value = state.language || 'auto';
    fill(chord, (state.chords || []).map((c) => [c.id, c.label]), state.chord || '');
    paintKeyEnv(state, state.engine, state.keyEnv);
    baseUrl.value = state.baseUrl || '';
    model.value = state.model || '';
    exe.value = state.whisperExe || '';
    wmodel.value = state.whisperModel || '';
    threads.value = state.threads == null ? '' : String(state.threads);
    exeDirs.textContent = (state.exeDirs || []).join('  |  ');
    paintRows(state.engine || '');
    keyNote.textContent = state.engine && state.engine !== 'local' && state.keyEnv ? t(state.keySet ? 'voice.card.keySet' : 'voice.card.keyUnset') : '';
    paintInstall(state);
    if (state.error) say(noticeText(state.error, t));
    else if (state.hotkey && state.hotkey !== 'on' && state.hotkey !== 'off') say(t('voice.card.hotkeyTaken'));
  }

  let running = false;
  const instSay = (text) => { if (canInstall) instStatus.textContent = text || ''; else say(text); };
  function showRunning(on) {
    running = on;
    instCancel.hidden = !on;
    instBar.hidden = !on;
  }
  function progressText(p) {
    const name = t(NAME_KEYS[p.item] || NAME_KEYS.model);
    const total = Number(p.total) || 0;
    return t(PHASE_KEYS[p.phase] || PHASE_KEYS.download, { name, done: mb(p.done), total: mb(total), pct: total > 0 ? Math.round((Number(p.done) / total) * 100) : 0 });
  }
  function showProgress(p) {
    instBar.max = Number(p.total) > 0 ? Number(p.total) : 1;
    instBar.value = Number(p.done) || 0;
    instSay(progressText(p));
  }
  /** What the install block shows for the state the host reports (the size first, then progress, then the result). */
  function paintInstall(state) {
    const i = state.install;
    if (!canInstall || !i) { inst.hidden = true; if (state.localRuntime === 'missing') say(t('voice.err.stt_local_runtime_missing')); }
    else {
      inst.hidden = false;
      const items = i.items || [];
      instSize.textContent = t('voice.install.size', { disk: mb(i.diskBytes), download: mb(i.downloadBytes), list: items.map((it) => t('voice.install.item', { name: t(NAME_KEYS[it.id] || NAME_KEYS.model), mb: mb(it.disk) })).join(', ') });
      const unpublished = (i.unpublished || []).length > 0;
      instNote.textContent = unpublished ? t('voice.install.unpublished') : '';
      showRunning(i.state === 'running');
      instBtn.disabled = unpublished || running || Boolean(i.installed);
      const big = i.optionalModel;
      instLargeBtn.hidden = !big;
      instLargeNote.hidden = !big;
      instLargeNote.textContent = big ? t('voice.install.large.note', { mb: mb(big.disk), download: mb(i.optionalDownloadBytes) }) : '';
      instLargeBtn.disabled = !big || unpublished || running || Boolean(i.optionalInstalled);
      if (running) showProgress(i);
      else if (state.localRuntime === 'missing') instSay(t('voice.err.stt_local_runtime_missing'));
      else if (i.state === 'failed' && i.code) instSay(noticeText(i.code, t));
      else instSay(i.installed ? t('voice.install.installed') : '');
    }
    // The program cannot start on this PC: the online engines are the way on. Offered in the form, never saved by itself.
    if (state.localRuntime === 'missing' && (!state.engine || state.engine === 'local')) {
      const online = (state.engines || []).find((e) => e !== 'local');
      if (online) { engine.value = online; paintKeyEnv(state, online, ''); paintRows(online); }
    }
  }
  const readForm = () => ({ engine: engine.value, language: language.value, keyEnv: keyEnv.value, baseUrl: baseUrl.value, model: model.value, whisperExe: exe.value, whisperModel: wmodel.value, threads: threads.value, chord: chord.value });

  async function refresh() {
    let r = null;
    try { r = await zumi.stt.state(); } catch { r = null; }
    if (r && r.ok) paint(r); else say(noticeText(r && r.error ? r.error : 'other', t));
    return r;
  }

  engine.addEventListener('change', () => {
    if (last) paintKeyEnv(last, engine.value, '');
    paintRows(engine.value);
    say('');
  });
  save.addEventListener('click', async () => {
    let r = null;
    try { r = await zumi.stt.set(settingsFromForm(readForm())); } catch { r = null; }
    if (r && r.ok) { paint(r); if (!r.error && (!r.hotkey || r.hotkey === 'on' || r.hotkey === 'off')) say(t('voice.card.saved')); }
    else say(noticeText(r && r.error ? r.error : 'other', t));
  });
  if (canInstall) {
    const startInstall = async (button, args) => {
      if (button.disabled) return;
      instBtn.disabled = true;
      instLargeBtn.disabled = true;
      let r = null;
      try { r = await zumi.stt.install(...args); } catch { r = null; }
      if (r && r.ok) { showRunning(true); showProgress({ item: 'model', phase: 'download', done: 0, total: 0 }); }
      else { instBtn.disabled = false; instLargeBtn.disabled = !(last && last.install && last.install.optionalModel); instSay(noticeText(r && r.error ? r.error : 'other', t)); }
    };
    instBtn.addEventListener('click', () => startInstall(instBtn, ['start']));
    instLargeBtn.addEventListener('click', () => startInstall(instLargeBtn, ['start', 'large']));
    instCancel.addEventListener('click', async () => {
      try { await zumi.stt.install('cancel'); } catch { /* the failed event tells the result */ }
    });
    // Progress and the result come as events from the host (the same channel as the dictation events).
    if (typeof zumi.stt.onEvent === 'function') {
      zumi.stt.onEvent(async (ev) => {
        if (!ev || ev.ev !== 'install') return;
        if (ev.phase === 'failed') {
          showRunning(false);
          const blocked = Boolean(last && last.install && (last.install.unpublished || []).length);
          instBtn.disabled = blocked;
          instLargeBtn.disabled = blocked || !(last && last.install && last.install.optionalModel);
          instSay(noticeText(ev.code, t));
        } else if (ev.phase === 'done') {
          showRunning(false);
          const state = await refresh();
          // Installed and it starts: the files are put in the form and Local is chosen. Saving stays the owner's click.
          if (state && state.ok && state.install && state.install.installed && state.localRuntime !== 'missing' && state.install.paths) {
            engine.value = 'local';
            paintRows('local');
            exe.value = state.install.paths.exe || '';
            wmodel.value = state.install.paths.model || '';
            instSay(t('voice.install.use'));
          }
        } else if (!running) { showRunning(true); showProgress(ev); }
        else showProgress(ev);
      });
    }
  }
  // The agent tab is shown later; keep the card current whenever its tab opens.
  const tab = $('stab-agent');
  if (tab) tab.addEventListener('click', () => { refresh(); });
  await refresh();
  return { refresh };
}
