// T-31-MAUS R2 "usable from chat": the chat's side of the four agent.* methods and the agent:event stream.
//
//   - a "Do a task" switch beside the chat box: with it on, the next sentence is sent to agent.start instead of the chat brain
//     (a sentence that can drive the PC is never an accident of typing);
//   - one chip per tool the run calls (from the loop's tool_start / tool_end events), a status line, Stop and a yes/no card for a
//     confirm the host asks;
//   - an Activity panel: the run list (one row per run: status, cost) and the gate's audit lines of one run, as agent.status
//     returns them; the newest frame of the run when the host has one.
// Everything shown is what the host sent; this file decides nothing about a run. Model and window text is set with textContent
// only. Built here, not in index.html, like reminders-card.js, so a host without the agent API shows no control that does nothing.
import { t as i18nT, apply as i18nApply } from './i18n.js';

/** True where the host has the agent API (the Tauri host; the Electron preload has none). */
export const agentAvailable = (zumi) => Boolean(zumi && zumi.agent && typeof zumi.agent.start === 'function' && typeof zumi.agent.onEvent === 'function');

/** 'task' when the sentence must go to agent.start, else 'chat'. A blank sentence is never a task. */
export function routeSentence(text, { taskMode = false, available = false } = {}) {
  return available && taskMode && String(text == null ? '' : text).trim() ? 'task' : 'chat';
}

export const EMPTY_STATE = Object.freeze({ run: null, chips: [], phase: 'idle', status: null, reason: null, costUsd: 0, confirm: null });

const CHIP_MAX = 40;

/** The chat state after one agent:event. Pure: returns a new state. An event of a run other than the current one starts a new
 *  state only when the current run has ended (or there is none); otherwise it is a stale event and is dropped. */
export function applyEvent(state, ev) {
  if (!ev || typeof ev !== 'object' || typeof ev.ev !== 'string' || typeof ev.run !== 'string') return state;
  let s = state;
  if (s.run !== ev.run) {
    if (s.run && s.phase !== 'ended' && s.phase !== 'idle') return state;
    s = { ...EMPTY_STATE, run: ev.run, phase: 'starting' };
  }
  switch (ev.ev) {
    case 'task_start': return { ...s, phase: 'working' };
    case 'turn_start': return { ...s, phase: 'thinking' };
    case 'turn': return { ...s, costUsd: s.costUsd + (Number.isFinite(ev.cost_usd) ? ev.cost_usd : 0) };
    case 'tool_start': {
      const chip = { id: `${ev.step}:${ev.name}:${s.chips.length}`, name: String(ev.name), step: ev.step, state: 'run', error: null, ms: null };
      return { ...s, phase: 'working', chips: [...s.chips, chip].slice(-CHIP_MAX) };
    }
    case 'tool_end': {
      const at = s.chips.map((c, i) => (c.name === ev.name && c.step === ev.step && c.state === 'run' ? i : -1)).filter((i) => i >= 0).pop();
      const done = { state: ev.ok ? 'ok' : 'fail', error: ev.error || null, ms: Number.isFinite(ev.ms) ? ev.ms : null };
      if (at === undefined) return { ...s, chips: [...s.chips, { id: `${ev.step}:${ev.name}:${s.chips.length}`, name: String(ev.name), step: ev.step, ...done }].slice(-CHIP_MAX) };
      return { ...s, chips: s.chips.map((c, i) => (i === at ? { ...c, ...done } : c)) };
    }
    case 'confirm': return { ...s, confirm: { id: String(ev.id), text: String(ev.text || '') } };
    case 'confirm_end': return { ...s, confirm: s.confirm && s.confirm.id === ev.id ? null : s.confirm };
    case 'run_end': return { ...s, phase: 'ended', status: String(ev.status), reason: ev.reason || null, costUsd: Number.isFinite(ev.cost_usd) ? ev.cost_usd : s.costUsd, confirm: null, chips: s.chips.map((c) => (c.state === 'run' ? { ...c, state: 'fail', error: 'ended' } : c)) };
    default: return s; // 'stopped' carries what run_end carries; unknown events change nothing
  }
}

/** "0.0035 USD": four decimals under one cent, two above. */
export const usdText = (usd) => `${Number(usd || 0).toFixed(Number(usd || 0) < 0.01 ? 4 : 2)} USD`;

const START_ERRORS = ['bad_args', 'bad_sentence', 'busy', 'thread_failed'];
/** Words for an error code from agent.start / agent.confirm, or for a run row's reason. `chat_off: why` is the host's own text. */
export function errorText(code, t = i18nT) {
  const c = String(code || '');
  if (c.startsWith('chat_off')) return t('agent.err.chatOff');
  // R6: the host's reason carries the numbers after the code (`budget_month: monthly budget 5.00 USD (2026-11): ...`).
  if (c.startsWith('budget_month')) return `${t('agent.err.budgetMonth')} ${c.slice(c.indexOf(':') + 1).trim()}`.trim();
  if (c.startsWith('budget_unreadable')) return `${t('agent.err.budgetUnreadable')} ${c.slice(c.indexOf(':') + 1).trim()}`.trim();
  if (START_ERRORS.includes(c) || c === 'no_pending') return t(`agent.err.${c}`);
  return `${t('agent.err.other')} (${c.slice(0, 80)})`;
}

/** One line for a run row of agent.status. */
export function rowText(row, t = i18nT) {
  const label = t(`agent.status.${row.status}`);
  const why = row.status === 'error' || row.status === 'stopped' ? (row.reason ? ` (${row.reason === 'cancelled' ? t('agent.byYou') : errorText(row.reason, t)})` : '') : '';
  return `${row.sentence} - ${label}${why} - ${usdText(row.cost_usd)}`;
}

/** One line for an audit entry of agent.status. */
export function activityText(e, t = i18nT) {
  const verdict = e.decision === 'refused' ? ` - ${t('agent.refused', { code: e.code || '?' })}` : '';
  return `${e.step == null ? '' : `${e.step}. `}${e.kind === 'result' ? `${t('agent.result')} ` : ''}${e.name}${verdict}`;
}

const PNG_URL = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/;

/** Builds the strip, the confirm card and the Activity panel, and keeps them current. Returns the controller or null without the API. */
export function initAgentChat(zumi, $, { doc = typeof document === 'undefined' ? null : document, t = i18nT, apply = i18nApply } = {}) {
  if (!doc || !agentAvailable(zumi) || $('agent-strip')) return null;
  const composer = doc.querySelector('footer.composer');
  const msg = $('msg');
  if (!composer || !msg) return null;
  const node = (tag, cls, text, id) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; if (id) e.id = id; return e; };
  const button = (id, key, cls = 'ghost slim') => { const b = node('button', cls, t(key), id); b.type = 'button'; b.dataset.i18n = key; return b; };

  const strip = node('div', 'agent-strip', null, 'agent-strip');
  const mode = button('agent-mode', 'agent.mode');
  mode.setAttribute('aria-pressed', 'false');
  mode.title = t('agent.modeHint');
  const chipsEl = node('div', 'agent-chips', null, 'agent-chips');
  chipsEl.setAttribute('aria-live', 'polite');
  const statusEl = node('span', 'agent-status', '', 'agent-status');
  const stop = button('agent-stop', 'agent.stop', 'primary slim');
  stop.hidden = true;
  const openActivity = button('agent-activity-btn', 'agent.activity');
  for (const el of [mode, chipsEl, statusEl, stop, openActivity]) strip.appendChild(el);
  const card = node('div', 'agent-confirm', null, 'agent-confirm');
  card.hidden = true;
  const cardText = node('span', 'agent-confirm-text', '', 'agent-confirm-text');
  const allow = button('agent-confirm-allow', 'agent.allow', 'primary slim');
  const deny = button('agent-confirm-deny', 'agent.deny');
  for (const el of [cardText, allow, deny]) card.appendChild(el);
  composer.insertBefore(strip, msg);
  composer.insertBefore(card, msg);

  const panel = node('aside', 'agent-activity', null, 'agent-activity');
  panel.hidden = true;
  panel.setAttribute('aria-label', t('agent.activityTitle'));
  const head = node('h3', null, t('agent.activityTitle'));
  head.dataset.i18n = 'agent.activityTitle';
  const frame = node('img', 'agent-frame', null, 'agent-frame');
  frame.alt = t('agent.frame');
  frame.hidden = true;
  const actList = node('ol', 'agent-act-list', null, 'agent-act-list');
  const runsHead = node('h4', null, t('agent.runs'));
  runsHead.dataset.i18n = 'agent.runs';
  const runsList = node('ul', 'agent-run-list', null, 'agent-run-list');
  for (const el of [head, frame, actList, runsHead, runsList]) panel.appendChild(el);
  const stage = ($('analysis') && $('analysis').parentNode) || composer.parentNode;
  stage.appendChild(panel);
  apply(strip); apply(card); apply(panel);

  let state = EMPTY_STATE;
  let taskMode = false;
  let note = '';
  let refreshTimer = null;
  const defaultPlaceholder = { on: null };

  function paintMode() {
    mode.setAttribute('aria-pressed', String(taskMode));
    mode.classList.toggle('on', taskMode);
    if (taskMode) { defaultPlaceholder.on = msg.placeholder; msg.placeholder = t('agent.placeholderOn'); }
    else if (defaultPlaceholder.on != null) { msg.placeholder = defaultPlaceholder.on; defaultPlaceholder.on = null; }
  }

  function paint() {
    chipsEl.textContent = '';
    for (const c of state.chips) {
      const chip = node('span', `agent-chip ${c.state}`, c.name);
      if (c.error) chip.title = c.error;
      else if (c.ms != null) chip.title = `${c.ms} ms`;
      chipsEl.appendChild(chip);
    }
    const running = state.run && state.phase !== 'ended' && state.phase !== 'idle';
    stop.hidden = !running;
    let line = note;
    if (running) line = `${t(state.phase === 'thinking' ? 'agent.thinking' : 'agent.working')} - ${usdText(state.costUsd)}`;
    else if (state.status) line = `${t(`agent.status.${state.status}`)}${state.reason && state.status !== 'done' ? ` (${state.reason === 'cancelled' ? t('agent.byYou') : errorText(state.reason, t)})` : ''} - ${usdText(state.costUsd)}`;
    statusEl.textContent = line;
    card.hidden = !state.confirm;
    cardText.textContent = state.confirm ? state.confirm.text : '';
  }

  async function refreshPanel() {
    let r = null;
    try { r = await zumi.agent.status(state.run || undefined); } catch { r = null; }
    if (!r || !r.ok) return r;
    actList.textContent = '';
    for (const e of r.activity || []) actList.appendChild(node('li', e.decision === 'refused' ? 'refused' : null, activityText(e, t)));
    if (!(r.activity || []).length) actList.appendChild(node('li', 'muted', t('agent.noActivity')));
    runsList.textContent = '';
    for (const row of r.runs || []) runsList.appendChild(node('li', null, rowText(row, t)));
    if (!(r.runs || []).length) runsList.appendChild(node('li', 'muted', t('agent.noRuns')));
    const url = r.frame && typeof r.frame.dataUrl === 'string' && PNG_URL.test(r.frame.dataUrl) ? r.frame.dataUrl : null;
    frame.hidden = !url;
    if (url) frame.src = url;
    return r;
  }
  const refreshSoon = () => {
    if (panel.hidden || refreshTimer) return;
    refreshTimer = setTimeout(() => { refreshTimer = null; refreshPanel(); }, 150);
  };

  const off = zumi.agent.onEvent((ev) => {
    const before = state;
    state = applyEvent(state, ev);
    if (state !== before) { note = ''; paint(); }
    if (ev && (ev.ev === 'tool_end' || ev.ev === 'run_end')) refreshSoon();
  });

  async function start(text) {
    let r = null;
    try { r = await zumi.agent.start(text); } catch { r = null; }
    // The run's first events can arrive before this call resolves; they already made the state.
    if (r && r.ok) { if (state.run !== r.id) state = { ...EMPTY_STATE, run: r.id, phase: 'starting' }; note = ''; }
    else note = errorText(r && r.error ? r.error : 'other', t);
    paint();
    return r;
  }
  async function stopRun() {
    stop.disabled = true;
    try { await zumi.agent.stop(); } catch { /* the run_end event says what happened */ }
    stop.disabled = false;
  }
  async function answer(allowIt) {
    if (!state.confirm) return;
    const id = state.confirm.id;
    let r = null;
    try { r = await zumi.agent.confirm(id, allowIt); } catch { r = null; }
    if (!r || !r.ok) { note = errorText(r && r.error ? r.error : 'other', t); }
    state = { ...state, confirm: null };
    paint();
  }

  mode.addEventListener('click', () => { taskMode = !taskMode; paintMode(); if (taskMode) msg.focus(); });
  stop.addEventListener('click', stopRun);
  allow.addEventListener('click', () => answer(true));
  deny.addEventListener('click', () => answer(false));
  openActivity.addEventListener('click', () => { panel.hidden = !panel.hidden; if (!panel.hidden) refreshPanel(); });
  paint();

  return {
    start, stop: stopRun, refreshPanel,
    taskMode: () => taskMode,
    state: () => state,
    // The chat box's Enter path: true when the sentence was taken as a task (the caller then does not send it to the chat brain).
    take(text) { if (routeSentence(text, { taskMode, available: true }) !== 'task') return false; start(String(text).trim()); return true; },
    destroy() { off && off(); strip.remove(); card.remove(); panel.remove(); },
  };
}
