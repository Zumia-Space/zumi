// Adjustable panes for the board page (T-31 liveboard B2): Tasks (the rail) | Task detail (centre column, or the docked reader)
// | Inspector (the right pane). Thin splitters: drag, double-click or Home to reset, arrows nudge, a button collapses a side pane
// to a 36px strip. Layout only: nothing here reads or renders board content.
// Self-mounting classic script (no app.js hook needed). Sizes reach the CSS as custom properties on <html> through CSSOM
// (style.setProperty), which the page CSP (style-src 'self') allows; this file never writes a style="" attribute.
// The pure rules (LaneSplit) are also importable in Node, where they are tested directly.
(function (root) {
  'use strict';

  const KEY = 'lbp2:B2';
  const PANES = { tasks: { min: 150, max: 760, def: 256 }, inspector: { min: 180, max: 520, def: 340 } };
  const DETAIL_MIN = 320, STRIP = 36, NUDGE = 24, MIN_VIEWPORT = 900;
  const DEFAULTS = Object.freeze({ tasksW: PANES.tasks.def, tasksC: false, inspectorW: PANES.inspector.def, inspectorC: false });

  /** The widest a side pane may be: its own max, and never so wide that Detail falls under DETAIL_MIN (floor: its own min). */
  function maxWidth(id, total, otherPx, otherVisible = true) {
    const room = total - (otherVisible ? otherPx : 0) - DETAIL_MIN;
    return Math.max(PANES[id].min, Math.min(PANES[id].max, room));
  }
  const clampWidth = (id, w, total, otherPx, otherVisible = true) =>
    Math.round(Math.min(maxWidth(id, total, otherPx, otherVisible), Math.max(PANES[id].min, Number.isFinite(w) ? w : PANES[id].def)));

  /** Stored value -> a complete, valid state. Anything unreadable falls back to the defaults, field by field. */
  function sanitize(raw) {
    let o = raw;
    if (typeof raw === 'string') { try { o = JSON.parse(raw); } catch { o = null; } }
    if (!o || typeof o !== 'object' || Array.isArray(o)) return { ...DEFAULTS };
    const w = (v, id) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.min(PANES[id].max, Math.max(PANES[id].min, v))) : PANES[id].def);
    return { tasksW: w(o.tasksW, 'tasks'), tasksC: o.tasksC === true, inspectorW: w(o.inspectorW, 'inspector'), inspectorC: o.inspectorC === true };
  }

  /** The reader's width presets (app.js keeps the choice in laneboard.readerWidth, so nothing to migrate) act on the panes while
   *  the reader is open: m = the docked width as it is, w = Inspector folded, f = Tasks and Inspector folded. Transient: the saved
   *  sizes are untouched, so Close, Esc or switching back restores them. */
  const presetFolds = preset => ({ tasks: preset === 'f', inspector: preset === 'w' || preset === 'f' });

  /** Pixel widths to lay out. A collapsed pane is a STRIP; an open one is clamped so Detail keeps DETAIL_MIN.
   *  hasInspector=false (a page with no right pane): the Inspector takes no room. */
  function layout(state, total, hasInspector = true) {
    const s = sanitize(state);
    const inspPx = !hasInspector ? 0 : s.inspectorC ? STRIP : s.inspectorW;
    const tasksPx = s.tasksC ? STRIP : clampWidth('tasks', s.tasksW, total, inspPx, hasInspector);
    const inspFinal = !hasInspector ? 0 : s.inspectorC ? STRIP : clampWidth('inspector', s.inspectorW, total, tasksPx);
    return { tasks: tasksPx, inspector: inspFinal, detail: total - tasksPx - inspFinal };
  }

  const api = { KEY, PANES, DETAIL_MIN, STRIP, NUDGE, MIN_VIEWPORT, DEFAULTS, maxWidth, clampWidth, sanitize, presetFolds, layout };
  root.LaneSplit = api;

  // ---------------------------------------------------------------- DOM
  if (typeof document === 'undefined' || !document.documentElement) return;
  const doc = document, html = doc.documentElement;

  const LABELS = {
    en: { tasks: 'Resize the Tasks pane', inspector: 'Resize the Inspector pane', collapse: 'Collapse pane', expand: 'Expand pane' },
    vi: { tasks: 'Đổi độ rộng khung Công việc', inspector: 'Đổi độ rộng khung bên phải', collapse: 'Thu gọn khung', expand: 'Mở rộng khung' },
    zh: { tasks: '调整任务窗格宽度', inspector: '调整右侧窗格宽度', collapse: '折叠窗格', expand: '展开窗格' }
  };
  const label = k => (LABELS[(html.lang || 'en').slice(0, 2)] || LABELS.en)[k];

  // localStorage can throw (private window, blocked site data) or hold junk: every access is guarded, memory is the fallback.
  let memory = null;
  const readStorage = k => { try { return localStorage.getItem(k); } catch { return null; } };
  function load() {
    const raw = readStorage(KEY);
    if (raw != null) return sanitize(raw);
    if (memory) return sanitize(memory);
    return { ...DEFAULTS };
  }
  function save() {
    memory = { ...state };
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* storage blocked: memory only */ }
  }

  let state = load(), dragging = false;
  const total = () => html.clientWidth;
  const hasInspector = () => !!doc.querySelector('.tv .ctx');
  const active = () => total() >= MIN_VIEWPORT;

  const splits = {}; // id -> element
  function build(id) {
    const el = doc.createElement('div');
    el.className = 'split split-' + id; el.tabIndex = 0;
    el.setAttribute('role', 'separator'); el.setAttribute('aria-orientation', 'vertical');
    const btn = doc.createElement('button');
    btn.type = 'button'; btn.className = 'split-btn'; btn.tabIndex = -1;
    el.append(btn);
    doc.body.append(el);
    splits[id] = el;
    wire(id, el, btn);
  }

  const keys = id => (id === 'tasks' ? { w: 'tasksW', c: 'tasksC' } : { w: 'inspectorW', c: 'inspectorC' });
  // The reader's preset folds panes on top of the saved state (never written back); a pane the user opens by hand stays open.
  let readerEl = null, readerObs = null; const opened = { tasks: false, inspector: false };
  const preset = () => (doc.getElementById('reader') ? doc.getElementById('reader').dataset.width || '' : '');
  const folded = id => presetFolds(preset())[id] && !opened[id];
  // The Diagram tab needs ~520px to show a plan step whole beside its predecessor. While it is open the panes show a TRANSIENT layer
  // over the saved state: the Inspector at lendW and, if the window cannot spare it, Tasks folded to its strip. Nothing here is
  // saved. The user's own actions win: dragging the Inspector changes lendW (still transient); opening Tasks ends the fold
  // (the Inspector then shrinks to what is left); leaving the tab drops the layer and the saved sizes show again unchanged.
  const DIAGRAM_W = 520, wantsDiagram = () => !!doc.querySelector('.tv .ctx .diag-card');
  let dirty = false, wasDiagram = false, lendW = DIAGRAM_W, lendFoldOff = false;
  const syncLend = () => { const d = wantsDiagram(); if (d !== wasDiagram) { wasDiagram = d; lendW = DIAGRAM_W; lendFoldOff = false; } return d; };
  const lendFold = () => syncLend() && !lendFoldOff && total() - state.tasksW - lendW < DETAIL_MIN;
  // With Tasks open the Inspector gives way (down to its own minimum), never the other way round.
  const lendInspector = () => Math.max(PANES.inspector.min, Math.min(lendW, isCollapsed('tasks') ? lendW : total() - state.tasksW - DETAIL_MIN));
  const isCollapsed = id => state[keys(id).c] || folded(id) || (id === 'tasks' && lendFold());
  const effective = () => ({ ...state, inspectorW: syncLend() ? lendInspector() : state.inspectorW, tasksC: isCollapsed('tasks'), inspectorC: isCollapsed('inspector') });
  const sizes = () => layout(effective(), total(), hasInspector());
  const currentPx = id => { const L = sizes(); return id === 'tasks' ? L.tasks : L.inspector; };

  function apply() {
    const on = active();
    html.classList.toggle('b2', on);
    if (!on) {
      html.style.removeProperty('--b2-tasks'); html.style.removeProperty('--b2-insp');
      html.classList.remove('b2-ctx', 'b2-tasks-c', 'b2-insp-c');
      return;
    }
    const ctx = hasInspector(), eff = effective(), L = layout(eff, total(), ctx);
    html.classList.toggle('b2-ctx', ctx);
    html.classList.toggle('b2-tasks-c', eff.tasksC);
    html.classList.toggle('b2-insp-c', ctx && eff.inspectorC);
    html.style.setProperty('--b2-tasks', L.tasks + 'px');
    html.style.setProperty('--b2-insp', L.inspector + 'px');
    for (const id of ['tasks', 'inspector']) {
      const el = splits[id], px = id === 'tasks' ? L.tasks : L.inspector, collapsed = isCollapsed(id);
      const max = id === 'tasks' ? maxWidth('tasks', total(), ctx ? L.inspector : 0, ctx) : maxWidth('inspector', total(), L.tasks);
      el.setAttribute('aria-label', label(id));
      el.setAttribute('aria-valuenow', String(px));
      el.setAttribute('aria-valuemin', String(collapsed ? STRIP : PANES[id].min));
      el.setAttribute('aria-valuemax', String(collapsed ? STRIP : max));
      el.dataset.collapsed = String(collapsed);
      const btn = el.firstElementChild;
      btn.textContent = (id === 'tasks') !== collapsed ? '‹' : '›';
      btn.setAttribute('aria-label', label(collapsed ? 'expand' : 'collapse'));
      btn.setAttribute('aria-expanded', String(!collapsed));
    }
  }

  function setWidth(id, w, persist) {
    const k = keys(id), L = sizes();
    if (id === 'inspector' && syncLend() && !state.inspectorC && !folded(id)) { lendW = clampWidth('inspector', w, total(), L.tasks); apply(); return; } // transient: the saved width is not the one on screen
    if (id === 'tasks' && syncLend()) lendFoldOff = true;
    dirty = true;
    state[k.w] = id === 'tasks' ? clampWidth('tasks', w, total(), L.inspector, hasInspector()) : clampWidth('inspector', w, total(), L.tasks);
    state[k.c] = false; opened[id] = true;
    apply(); if (persist) save();
  }
  // A pane the reader preset folds opens and re-folds without touching the saved state; any other pane saves its choice.
  function toggle(id) {
    const k = keys(id), byPreset = presetFolds(preset())[id];
    if (isCollapsed(id)) {
      if (id === 'tasks' && !state.tasksC && !byPreset && lendFold()) { lendFoldOff = true; apply(); return; } // only the Diagram's fold: nothing saved
      state[k.c] = false; if (byPreset) opened[id] = true; if (id === 'tasks') lendFoldOff = true;
    }
    else if (byPreset) opened[id] = false;
    else state[k.c] = true;
    apply(); save();
  }

  function wire(id, el, btn) {
    const dir = id === 'tasks' ? 1 : -1; // dragging right grows Tasks and shrinks the Inspector
    btn.addEventListener('click', e => { e.stopPropagation(); toggle(id); });
    btn.addEventListener('pointerdown', e => e.stopPropagation());
    btn.addEventListener('dblclick', e => e.stopPropagation());
    el.addEventListener('pointerdown', e => {
      if (e.button !== 0 || e.target === btn) return;
      e.preventDefault();
      if (isCollapsed(id)) return; // a strip opens with its button, double-click or Enter, not by a drag
      const x0 = e.clientX, w0 = currentPx(id);
      dragging = true; el.classList.add('drag'); html.classList.add('b2-drag');
      try { el.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
      const move = ev => setWidth(id, w0 + dir * (ev.clientX - x0), false);
      const done = () => {
        dragging = false; el.classList.remove('drag'); html.classList.remove('b2-drag');
        el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', done); el.removeEventListener('pointercancel', done);
        if (dirty) { save(); dirty = false; } // a transient (Diagram) drag changed nothing worth saving
      };
      el.addEventListener('pointermove', move); el.addEventListener('pointerup', done); el.addEventListener('pointercancel', done);
    });
    el.addEventListener('dblclick', () => setWidth(id, PANES[id].def, true));
    el.addEventListener('keydown', e => {
      if (e.target !== el) return;
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        if (isCollapsed(id)) return;
        setWidth(id, currentPx(id) + dir * (e.key === 'ArrowRight' ? NUDGE : -NUDGE), true);
      } else if (e.key === 'Home') setWidth(id, PANES[id].def, true);
      else if (e.key === 'Enter') toggle(id);
      else return;
      e.preventDefault();
    });
  }

  /** The reader appears and goes (body child) and changes preset (its data-width): fold or restore the panes. */
  function syncReader() {
    const el = doc.getElementById('reader');
    if (el !== readerEl) {
      readerObs && readerObs.disconnect(); readerEl = el;
      if (!el) { opened.tasks = opened.inspector = false; } else { readerObs = new MutationObserver(() => { opened.tasks = opened.inspector = false; apply(); }); readerObs.observe(el, { attributes: true, attributeFilter: ['data-width'] }); }
    }
    apply();
  }

  function mount() {
    build('tasks'); build('inspector');
    apply();
    window.addEventListener('resize', () => { if (!dragging) apply(); });
    const main = doc.getElementById('main');
    new MutationObserver(syncReader).observe(doc.body, { childList: true });
    if (main) new MutationObserver(apply).observe(main, { childList: true }); // a view change adds or drops the right pane
  }
  if (doc.body) mount(); else doc.addEventListener('DOMContentLoaded', mount);
})(typeof globalThis !== 'undefined' ? globalThis : this);
