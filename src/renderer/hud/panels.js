// T1 / T2 / T3 panel renderer (T-31 hud-panels, PLAN sections 6-7). DOM only: hud.js decides WHICH task the panel
// follows and whether it is compact or expanded (panel-logic.js), this module paints the chosen design.
//
// Rules this file keeps:
//   - board text (title, goal, now, step + log labels) is written with textContent exactly as the board sent it; nothing
//     here builds markup from a string, so a board value can never become HTML (the plan's literal-token grep gate);
//   - every chrome string comes from the injected `t` (src/renderer/i18n.js) -- no literal UI text in this file;
//   - colours are CSS classes only, never an attribute with a colour value (check:palette);
//   - no frame loop: the only timer is a single requestAnimationFrame that fits the NOW line once it has a width.
import { doneByDay, logTail, ringPaths, stepCounts, stepPercent, stripNowStamp, wordFit } from './panel-logic.js';

const LOG_ROWS_FULL = 6; // the plan's --rows for the full T3 (hud.css --hp-ln = 17 px -> 102 px)
const LOG_ROWS_COMPACT = 1; // the newest line only
const T2_ROWS = 4; // the full T2 fits the 38% below group at the harness stage (hud.css size budget)
const RING_SEGS = 30; // the mock's segmented ring

// ---------- tiny DOM helpers (textContent only) ----------
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null && text !== '') e.textContent = String(text);
  return e;
};
const svgEl = (tag, attrs = {}) => {
  const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
};

// ---------- formatting (locale-aware, never a hand-rolled number) ----------
const num = (locale, n) => new Intl.NumberFormat(locale).format(n);
const pct = (locale, frac) => `${num(locale, Math.round(frac * 100))}%`;
const clock = (locale, iso) => {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(d) : '';
};
const weekday = (locale, date) => new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(date);

/** The segmented ring, painted by fraction lit (the mock's paintRing: lit segments, one shimmering frontier). `outer`
 *  adds the fine rotating tick ring, `guide` the faint inner circle; the compact strip asks for neither. */
function ringSvg(cls, { n = RING_SEGS, r = 41, w = 8, gap = 3.2, frac = 0, outer = false, guide = false } = {}) {
  const s = svgEl('svg', { viewBox: '0 0 100 100', 'aria-hidden': 'true', ...(cls ? { class: cls } : {}) });
  if (outer) s.appendChild(svgEl('circle', { cx: 50, cy: 50, r: 48.5 }));
  if (guide) s.appendChild(svgEl('circle', { cx: 50, cy: 50, r: 30, class: 'guide' }));
  const lit = Math.floor(Math.max(0, Math.min(1, frac)) * n + 1e-6);
  ringPaths(n, r, w, gap).forEach((d, i) => {
    const p = svgEl('path', { d, 'stroke-width': w });
    p.setAttribute('class', `hp-seg${i < lit ? ' on' : i === lit ? ' hot' : ''}`);
    s.appendChild(p);
  });
  return s;
}

/** The T2 segmented step bar: one cell per step in board order. */
function segbar(steps) {
  const bar = el('div', 'hp-segbar');
  bar.setAttribute('aria-hidden', 'true');
  for (const s of steps) {
    const i = el('i');
    i.className = s.state === 'done' ? 'on' : s.state === 'active' ? 'act' : s.state === 'waiting' ? 'wait' : '';
    bar.appendChild(i);
  }
  return bar;
}

/** A translated counter with its number in bold: "{n} done" -> <b>2</b> done, in every locale. */
const countSpan = (cls, t, key, n, locale) => {
  const span = el('span', cls);
  span.append(el('b', '', num(locale, n)), ` ${t(key, { n: '' }).trim()}`);
  return span;
};

const healthDot = (t, health, extra = '') => {
  const d = el('span', `hp-dot${extra ? ` ${extra}` : ''}`);
  d.dataset.health = health || '';
  if (health) d.title = t(`hud.health.${health}`);
  return d;
};

/** The NOW line: a static single line cut at a word boundary (fix 2), full text in the title. The cut needs a laid-out
 *  width, so the fit runs once on the next frame; until then the full text is shown (CSS ellipsis is only the fallback
 *  for a hidden panel, which is re-fitted the moment the stage comes back). Returns null when there is nothing left after
 *  the board stamp is stripped (a stamp-only note), so the caller drops the whole row instead of printing the label
 *  twice. */
function nowLine(cls, text) {
  const body = stripNowStamp(String(text || '').replace(/\s+/g, ' ').trim());
  if (!body) return null;
  const node = el('span', cls, body);
  node.dataset.full = body;
  node.title = body;
  return node;
}

function fitNowLines(panel, locale) {
  const nodes = [...panel.querySelectorAll('[data-full]')];
  if (!nodes.length) return;
  const run = () => {
    for (const n of nodes) {
      const full = n.dataset.full || '';
      const width = n.clientWidth;
      if (!full || !(width > 0)) continue;
      const style = getComputedStyle(n);
      const ctx = fitNowLines.canvas || (fitNowLines.canvas = document.createElement('canvas').getContext('2d'));
      ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      n.textContent = wordFit(full, (s) => ctx.measureText(s).width <= width, locale);
    }
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
  else run();
}

// ---------- T1: the task card ----------
function t1Head(c) {
  const { task, t, age } = c;
  const head = el('div', 'hp-head');
  head.append(el('span', 'hp-tag', t('hud.t1.tag')), el('span', 'hp-code', task.id), el('span', 'hp-sp'));
  head.append(healthDot(t, task.health));
  const meta = [task.lane, task.at ? t('hud.t1.updated', { age: age(task.at) }) : ''].filter(Boolean).join(' · ');
  head.append(el('span', 'hp-meta', meta));
  return head;
}

function t1Full(c) {
  const { task, asks, t, locale } = c;
  const steps = Array.isArray(task.steps) ? task.steps : [];
  const total = task.stepTotal || steps.length;
  const counts = stepCounts(steps);
  const frac = total ? counts.done / total : 0;
  const cur = steps.find((s) => s.id === task.stepId) || null;
  const percent = cur ? stepPercent(cur.sub) : null;
  const nodes = [t1Head(c), el('div', 'hp-title hp-clamp2', task.title || task.id)];

  const ask = asks[0] || null;
  // One hr, then either the goal (2 lines, or 1 when an ask also needs the room) or straight to the mid block.
  const goal = el('div', `hp-goal ${ask ? 'hp-clamp1' : 'hp-clamp2'}`, task.goal || '');
  if (task.goal) nodes.push(goal);
  nodes.push(el('div', 'hp-hr'));

  const mid = el('div', 'hp-mid');
  const ringBox = el('div', 'hp-ring');
  ringBox.append(ringSvg('hp-ring-out', { outer: true }), ringSvg('hp-ring-in', { frac, guide: true }));
  const centre = el('div', 'hp-ring-c');
  centre.append(el('b', '', pct(locale, frac)), el('span', '', t('hud.t1.steps', { done: num(locale, counts.done), total: num(locale, total) })));
  ringBox.append(centre);
  const col = el('div');
  const state = el('div', 'hp-state');
  state.append(healthDot(t, task.health), el('span', '', t(`hud.state.${task.stepState || 'todo'}`)));
  col.append(state);
  col.append(el('div', 'hp-cur hp-clamp2', task.step || task.title || ''));
  if (cur && cur.sub) col.append(el('div', 'hp-sub hp-clamp2', cur.sub));
  if (percent != null) {
    const bar = el('div', 'hp-bar');
    const fill = el('i');
    fill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    bar.append(fill);
    const row = el('div', 'hp-pgrow');
    row.append(bar, el('span', '', `${num(locale, percent)}%`));
    col.append(row);
  } else {
    const scan = el('div', 'hp-scan');
    scan.append(el('i'));
    col.append(scan);
  }
  const roles = el('div', 'hp-roles');
  if (task.roles && task.roles.code) roles.append(el('span', 'hp-chip', t('hud.t1.roleCode', { model: task.roles.code })));
  if (task.roles && task.roles.review) roles.append(el('span', 'hp-chip', t('hud.t1.roleReview', { model: task.roles.review })));
  if (roles.children.length) col.append(roles);
  mid.append(ringBox, col);
  nodes.push(mid);

  // The ask block: only real asks (feed.waiting rows for this task) are shown, and both buttons are real actions --
  // Answer expands the shipped ask card in the right group (where the answer controls live), Open calls the board opener.
  const n = task.askCount || asks.length;
  if (ask) {
    nodes.push(el('div', 'hp-hr'));
    const sec = el('div', 'hp-sec hp-amber');
    sec.append(healthDot(t, 'yellow'), el('span', '', t('hud.t1.asks', { n: num(locale, n) })));
    nodes.push(sec);
    const box = el('div', 'hp-ask');
    box.append(el('div', 'hp-q hp-clamp2', ask.text || ask.title || ''));
    const btns = el('div', 'hp-btns');
    const answer = el('button', 'hp-btn hp-amber', t('hud.t1.answer'));
    answer.type = 'button';
    answer.addEventListener('click', () => { if (c.onAnswer) c.onAnswer(task.id); });
    const open = el('button', 'hp-btn', t('hud.open'));
    open.type = 'button';
    open.addEventListener('click', () => { if (c.onOpen) c.onOpen(task.id); });
    btns.append(answer, open);
    box.append(btns);
    nodes.push(box);
  }

  // NOW: the board's own `now`, ref lines already dropped by the feed, cut on a word boundary.
  const now = nowLine('hp-nowline', task.now);
  if (now) {
    const row = el('div', 'hp-ticker');
    row.append(el('span', 'hp-lbl', t('hud.t1.now')), now);
    nodes.push(row);
  }
  return nodes;
}

function t1Compact(c) {
  const { task, t, locale } = c;
  const steps = Array.isArray(task.steps) ? task.steps : [];
  const total = task.stepTotal || steps.length;
  const counts = stepCounts(steps);
  const frac = total ? counts.done / total : 0;
  const strip = el('div', 'hp-strip');
  const mini = el('span', 'hp-mini');
  mini.append(ringSvg('', { n: 16, r: 41, w: 13, gap: 8, frac }));
  strip.append(healthDot(t, task.health), el('span', 'hp-code', task.id), mini);
  const now = nowLine('hp-txt', task.step || task.title || '');
  if (now) strip.append(now);
  strip.append(el('span', 'hp-pct', pct(locale, frac)));
  return [strip];
}

// ---------- T2: the step list ----------
function t2Head(c) {
  const { task, t, age } = c;
  const head = el('div', 'hp-head');
  head.append(el('span', 'hp-tag', t('hud.t2.tag')), el('span', 'hp-code', task.id), el('span', 'hp-sp'));
  head.append(el('span', 'hp-meta', task.at ? t('hud.t1.updated', { age: age(task.at) }) : ''));
  return head;
}

/** The rows the full T2 shows: the latest finished step, every running step, the ones waiting on anh, then the next
 *  todo steps -- board order inside each group, capped to what the panel box holds. */
function pickRows(steps, max) {
  const lastDone = [...steps].reverse().find((s) => s.state === 'done');
  const groups = [[lastDone], steps.filter((s) => s.state === 'active'), steps.filter((s) => s.state === 'waiting'), steps.filter((s) => s.state === 'blocked'), steps.filter((s) => s.state === 'todo')];
  const out = [];
  for (const g of groups) for (const s of g) if (s && !out.includes(s) && out.length < max) out.push(s);
  return out;
}

function stepRow(c, s) {
  const { t, locale } = c;
  const row = el('li', `hp-row ${s.state === 'done' ? 'done' : s.state === 'active' ? 'act' : s.state === 'waiting' ? 'wait' : s.state === 'blocked' ? 'blocked' : 'todo'}`);
  const mark = el('span', 'hp-m');
  const text = el('div');
  text.append(el('div', 'hp-lb', s.label || s.id), el('div', 'hp-sb', s.sub || ''));
  row.append(mark, text, el('span', 'hp-st', t(`hud.state.${s.state || 'todo'}`)));
  if (s.state === 'active') {
    const percent = stepPercent(s.sub);
    const pg = el('div', 'hp-pg');
    const prow = el('div', 'hp-pgrow');
    if (percent != null) {
      const bar = el('div', 'hp-bar');
      const fill = el('i');
      fill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
      bar.append(fill);
      prow.append(bar, el('span', '', `${num(locale, percent)}%`));
    } else {
      const scan = el('div', 'hp-scan');
      scan.append(el('i'));
      prow.append(scan, el('span', '', t('hud.t2.measuring')));
    }
    pg.append(prow);
    row.append(pg);
  }
  return row;
}

function t2Full(c) {
  const { task, t, locale } = c;
  const steps = Array.isArray(task.steps) ? task.steps : [];
  const total = task.stepTotal || steps.length;
  const counts = stepCounts(steps);
  const frac = total ? counts.done / total : 0;
  const top = el('div', 'hp-t2top');
  const ringBox = el('div', 'hp-ring');
  ringBox.append(ringSvg('hp-ring-in', { frac, guide: true }));
  const centre = el('div', 'hp-ring-c');
  centre.append(el('b', '', pct(locale, frac)), el('span', '', `${num(locale, counts.done)}/${num(locale, total)}`));
  ringBox.append(centre);
  const right = el('div');
  right.append(el('div', 'hp-title hp-one', task.title || task.id));
  const countsRow = el('div', 'hp-counts');
  countsRow.append(countSpan('d', t, 'hud.t2.done', counts.done, locale), countSpan('a', t, 'hud.t2.doing', counts.active, locale),
    countSpan('n', t, 'hud.t2.next', counts.todo, locale), countSpan('w', t, 'hud.t2.waiting', counts.waiting, locale));
  right.append(countsRow, segbar(steps));
  top.append(ringBox, right);
  const list = el('ul', 'hp-list');
  for (const s of pickRows(steps, T2_ROWS)) list.append(stepRow(c, s));
  return [t2Head(c), top, list];
}

function t2Compact(c) {
  const { task, t, locale } = c;
  const steps = Array.isArray(task.steps) ? task.steps : [];
  const counts = stepCounts(steps);
  const strip = el('div', 'hp-strip');
  strip.append(el('span', 'hp-code', task.id), segbar(steps));
  const done = countSpan('hp-pct', t, 'hud.t2.done', counts.done, locale);
  const wait = countSpan('hp-pct', t, 'hud.t2.waiting', counts.waiting, locale);
  const tail = el('span', 'hp-txt hp-mono');
  tail.append(done, el('span', '', ' · '), wait);
  strip.append(tail);
  return [strip];
}

// ---------- T3: the step log + the steps-finished chart ----------
function logClass(to) {
  return to === 'done' ? 'ok' : to === 'waiting' || to === 'blocked' ? 'warn' : 'dim';
}

/** Width of the log's time column in `ch` (the log is monospace), sized to the widest localized time it will show: EN is a
 *  12 h clock ("04:31 PM", 8 ch), VI a 24 h one ("16:31", 5 ch). A fixed 33 px column let the EN time run into the state. */
function atColumn(c, entries) {
  const widest = entries.reduce((m, e) => Math.max(m, clock(c.locale, e.at).length), 5);
  return `${widest}ch`;
}

function logLine(c, entry) {
  const { t, locale } = c;
  const line = el('div', `hp-ln ${logClass(entry.to)}`);
  line.append(el('span', 'at', clock(locale, entry.at)), el('span', 'tg', t(`hud.state.${entry.to || 'todo'}`)), el('span', 'tx', entry.label || entry.stepId || ''));
  return line;
}

/** The 7-day chart: one bar per local day, oldest first, today last (doneByDay). Pure SVG built here, coloured by CSS
 *  classes only. */
function chart(c, values) {
  const { t, locale, now } = c;
  const W = 300, H = 70, pad = { l: 18, r: 6, t: 6, b: 13 };
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  const max = Math.max(1, ...values);
  const s = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'hp-chart', 'aria-label': t('hud.t3.chart'), role: 'img' });
  for (let g = 0; g <= 2; g++) {
    const y = pad.t + ih - (ih * g) / 2;
    s.appendChild(svgEl('line', { x1: pad.l, x2: W - pad.r, y1: y, y2: y, class: 'grid' }));
  }
  const bw = (iw / values.length) * 0.58;
  values.forEach((v, i) => {
    const slot = iw / values.length;
    const x = pad.l + i * slot + (slot - bw) / 2;
    const h = (ih * v) / max;
    const bar = svgEl('rect', { x, y: pad.t + ih - h, width: bw, height: h, class: `bar${i === values.length - 1 ? ' today' : ''}` });
    s.appendChild(bar);
    const day = new Date(now);
    day.setDate(day.getDate() - (values.length - 1 - i));
    const label = svgEl('text', { x: x + bw / 2, y: H - 3, class: 'axis', 'text-anchor': 'middle' });
    label.textContent = weekday(locale, day);
    s.appendChild(label);
    if (v > 0) {
      const count = svgEl('text', { x: x + bw / 2, y: pad.t + ih - h - 2, class: 'axis', 'text-anchor': 'middle' });
      count.textContent = num(locale, v);
      s.appendChild(count);
    }
  });
  return s;
}

function t3Head(c, lines) {
  const { task, t } = c;
  const head = el('div', 'hp-head');
  head.append(el('span', 'hp-tag', t('hud.t3.tag')), el('span', 'hp-meta hp-one', t('hud.t3.title', { code: task.id })), el('span', 'hp-sp'));
  head.append(healthDot(t, task.health), el('span', 'hp-meta', t('hud.t3.lines', { n: num(c.locale, lines) })));
  return head;
}

function t3Full(c) {
  const { task, t, locale, now } = c;
  const log = Array.isArray(task.log) ? task.log : [];
  const tail = logTail(log, LOG_ROWS_FULL);
  const nodes = [t3Head(c, tail.length)];
  if (tail.length) {
    const win = el('div', 'hp-log');
    win.style.setProperty('--rows', String(tail.length));
    for (const entry of tail) win.append(logLine(c, entry));
    win.style.setProperty('--at', atColumn(c, tail));
    nodes.push(win);
  } else {
    nodes.push(el('div', 'hp-empty', t('hud.t3.empty')));
  }
  nodes.push(el('div', 'hp-hr'));
  nodes.push(el('div', 'hp-sec', t('hud.t3.chart')));
  const values = doneByDay(task.doneAts || [], now, 7);
  nodes.push(chart(c, values));
  const total = values.reduce((a, b) => a + b, 0);
  nodes.push(el('div', 'hp-stats', t('hud.t3.total', { n: num(locale, total) })));
  return nodes;
}

function t3Compact(c) {
  const { task, t } = c;
  const strip = el('div', 'hp-strip');
  strip.append(el('span', 'hp-code', task.id));
  const tail = logTail(Array.isArray(task.log) ? task.log : [], LOG_ROWS_COMPACT);
  if (tail.length) { const line = logLine(c, tail[0]); line.style.setProperty('--at', atColumn(c, tail)); strip.append(line); }
  else strip.append(el('span', 'hp-txt', t('hud.t3.empty')));
  return [strip];
}

/**
 * Paints one design into the panel node. `task` is a hud:feed row (src/main/hud-feed.mjs); `expanded` false renders the
 * compact strip the `inplace` place shows at rest; `asks` are this task's waiting rows; `t` is the i18n lookup and
 * `locale` drives every Intl format. Optional: `age(iso)` (the HUD's existing age formatter), `now`, and the two real
 * actions `onAnswer(taskId)` / `onOpen(taskId)`. A missing task or design 'none' hides the panel.
 */
export function renderPanel(panel, { design = 't1', expanded = false, task = null, asks = [], t = (k) => k, locale = 'en', age = () => '', now = Date.now(), onAnswer = null, onOpen = null } = {}) {
  if (!panel) return;
  panel.replaceChildren();
  const shown = Boolean(task) && design !== 'none';
  panel.hidden = !shown;
  if (!shown) return;
  panel.dataset.design = design;
  panel.dataset.size = expanded ? 'full' : 'compact';
  panel.dataset.health = task.health || '';
  const tr = el('i', 'hp-tick tr'); tr.setAttribute('aria-hidden', 'true');
  const bl = el('i', 'hp-tick bl'); bl.setAttribute('aria-hidden', 'true');
  panel.append(tr, bl);
  if (expanded) { const sweep = el('i', 'hp-sweep'); sweep.setAttribute('aria-hidden', 'true'); panel.append(sweep); }
  const ctx = { task, asks: Array.isArray(asks) ? asks : [], t, locale, age, now, onAnswer, onOpen };
  const body = design === 't2' ? (expanded ? t2Full(ctx) : t2Compact(ctx))
    : design === 't3' ? (expanded ? t3Full(ctx) : t3Compact(ctx))
      : (expanded ? t1Full(ctx) : t1Compact(ctx));
  for (const node of body) panel.append(node);
  fitNowLines(panel, locale); // needs a laid-out width: one frame after the nodes are live
}
