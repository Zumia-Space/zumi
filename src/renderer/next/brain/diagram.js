// The two task diagrams of the Brain detail view (T-31 slice 3a-2): the step flow (swimlanes by zone) and the product structure
// (task.architecture). The LAYOUT is the board's own engine (vendor/laneboard/public/diagram.js, pure geometry, never edited: a classic
// script that sets LaneDiagram on window, or on globalThis in Node). It is imported from ./vendor/diagram.js, a BYTE-EXACT copy kept next to
// this file because scripts/check-next-ui-boots-without-next.mjs builds a scratch copy of src/renderer only (no vendor/ tree), so a relative
// import of the vendored path cannot resolve there. scripts/check-brain.mjs fails if the copy differs from the vendored file by one byte. This file only
// draws that geometry as SVG: fit to the card's width, no pan, no zoom. A diagram that is wider than the card at its smallest
// readable scale (the engine's own FIT_MIN_SCALE) scrolls sideways inside its box, as on the board page.
// alpha.7 (owner QC 30-10: the text is too small): a Fullscreen button above each diagram opens the same drawing, rebuilt, in an overlay
// that fills the app window and scales it to fit (labels grow with it). The panel underneath is never touched, so closing restores it as it was.
// Fullscreen also drops the engine's clamp (2 lines of ~17 characters, cut with "…"): the whole label and sub-text are re-wrapped to the box width
// and the geometry is stretched (fitFull) so every box is tall enough. The vendored engine is not edited; the panel keeps its clamp.
// alpha.8 (owner QC 30-10: many steps are still hard to read at fit): the fullscreen drawing zooms (wheel at the cursor, + / - / Fit buttons, keys + - 0)
// and pans by dragging. The SVG content sits in one <g> whose transform changes, so text stays vector-sharp; zoom 1 = the alpha.7 fit.
import './vendor/diagram.js';
import { svg, el } from './dom.js';
import { t } from '../../i18n.js';

const LD = () => globalThis.LaneDiagram;
const STATE_CLASS = { todo: 'todo', active: 'active', waiting: 'waiting', blocked: 'blocked', done: 'done' };

let markerN = 0; // one arrow marker per drawing: ids stay unique when the flow and the structure sit in one page
function wrap(natural, height, content, label, full = false) {
  const box = el('div', full ? 'bd-scroll bd-scroll-full' : 'bd-scroll'), mid = `bd-arrow-${++markerN}`;
  // Fit to the card's width in CSS (no resize code): 100% of the box, never wider than natural, never below the engine's own smallest readable scale.
  const minW = Math.round(natural * LD().FIT_MIN_SCALE);
  // Fullscreen: the box is the whole overlay stage and the viewBox (preserveAspectRatio meet) scales the drawing up to fit it.
  const s = svg('svg', { class: 'bd', viewBox: `0 0 ${natural} ${height}`, role: 'img', 'aria-label': label, style: full ? 'width:100%;height:100%' : `width:100%;max-width:${natural}px;min-width:${minW}px;height:auto` });
  const defs = svg('defs');
  const mk = svg('marker', { id: mid, viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
  mk.appendChild(svg('path', { d: 'M0,0 L8,4 L0,8 z', class: 'bd-head' }));
  defs.appendChild(mk);
  for (const c of content) if (c.getAttribute('marker-end')) c.setAttribute('marker-end', `url(#${mid})`); // edges were built with a placeholder
  if (full) {
    const g = svg('g', { class: 'bd-pan' });
    g.append(...content);
    s.append(defs, g);
    box.zoomApi = attachZoom(box, s, g, natural, height);
  } else s.append(defs, ...content);
  box.appendChild(s);
  return box;
}

const ZOOM_MAX = 4; // zoom 1 = fit to the window (the alpha.7 look); 4 = 400 %
/** Wheel zoom at the cursor and drag-to-pan for the fullscreen drawing. State lives on the svg (data-zoom/-tx/-ty, viewBox units) so checks can read it. */
function attachZoom(box, svgEl, g, natural, height) {
  let k = 1, tx = 0, ty = 0;
  const apply = () => {
    // keep at least a fifth of the drawing in view: a drag can never lose it
    tx = Math.min(natural * 0.8, Math.max(natural * 0.2 - k * natural, tx));
    ty = Math.min(height * 0.8, Math.max(height * 0.2 - k * height, ty));
    g.setAttribute('transform', `translate(${tx} ${ty}) scale(${k})`);
    svgEl.dataset.zoom = k.toFixed(3); svgEl.dataset.tx = tx.toFixed(1); svgEl.dataset.ty = ty.toFixed(1);
    box.dispatchEvent(new CustomEvent('bd-zoom', { detail: k }));
  };
  const toView = (cx, cy) => { const m = svgEl.getScreenCTM(); return m ? new DOMPoint(cx, cy).matrixTransform(m.inverse()) : { x: 0, y: 0 }; };
  const zoomAt = (factor, cx, cy) => {
    const nk = Math.min(ZOOM_MAX, Math.max(1, k * factor));
    if (nk === k) return;
    const p = toView(cx, cy);
    tx = p.x - (p.x - tx) * (nk / k); ty = p.y - (p.y - ty) * (nk / k); k = nk; // the point under the cursor stays under it
    apply();
  };
  apply(); // publish the initial state
  const centre = () => { const r = svgEl.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
  box.addEventListener('wheel', (e) => { e.preventDefault(); zoomAt(Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015)), e.clientX, e.clientY); }, { passive: false });
  let drag = null;
  box.addEventListener('pointerdown', (e) => { if (e.button === 0) drag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false }; });
  box.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.moved) {
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 4) return; // a click without drag stays a click
      drag.moved = true; box.setPointerCapture(e.pointerId); box.classList.add('dragging');
    }
    const a = toView(drag.x, drag.y), b = toView(e.clientX, e.clientY);
    tx += b.x - a.x; ty += b.y - a.y; drag.x = e.clientX; drag.y = e.clientY;
    apply();
  });
  const end = (e) => { if (drag && e.pointerId === drag.id) { drag = null; box.classList.remove('dragging'); } };
  box.addEventListener('pointerup', end); box.addEventListener('pointercancel', end);
  return { zoomBy: (f) => zoomAt(f, ...centre()), fit: () => { k = 1; tx = 0; ty = 0; apply(); }, get zoom() { return k; } };
}

const lines = (x, y, list, cls, step = 14) => list.map((txt, i) => svg('text', { x, y: y + i * step, class: cls }, txt));

let fullscreen = null; // the one open overlay: { node, onKey, opener }
/** Closes the fullscreen diagram, if any. brain.js calls it when the task detail is left. */
export function closeDiagramFullscreen() {
  if (!fullscreen) return;
  const { node, onKey, opener } = fullscreen;
  document.removeEventListener('keydown', onKey, true);
  node.remove();
  fullscreen = null;
  if (opener && opener.isConnected) opener.focus({ preventScroll: true });
}

function openDiagramFullscreen(label, make, opener) {
  closeDiagramFullscreen();
  const node = el('div', 'bd-full');
  node.setAttribute('role', 'dialog'); node.setAttribute('aria-modal', 'true'); node.setAttribute('aria-label', label);
  const bar = el('div', 'bd-full-bar');
  const close = el('button', 'nb-back bd-full-close', t('brain.media.close'));
  close.type = 'button';
  close.addEventListener('click', closeDiagramFullscreen);
  const drawing = make(), zoom = drawing.zoomApi;
  const tool = (cls, txt, title, fn) => { const b = el('button', `nb-back bd-full-tool ${cls}`, txt); b.type = 'button'; b.title = title; b.setAttribute('aria-label', title); b.addEventListener('click', fn); return b; };
  const pct = el('span', 'nb-sec-h bd-full-pct', '100%');
  drawing.addEventListener('bd-zoom', (e) => { pct.textContent = `${Math.round(e.detail * 100)}%`; });
  bar.append(el('span', 'nb-sec-h bd-full-title', label), el('span', 'nb-sp'), pct,
    tool('bd-zoom-out', '−', t('brain.diagram.zoomOut'), () => zoom.zoomBy(1 / 1.4)), tool('bd-zoom-fit', t('brain.diagram.fit'), t('brain.diagram.fit'), () => zoom.fit()),
    tool('bd-zoom-in', '+', t('brain.diagram.zoomIn'), () => zoom.zoomBy(1.4)), close);
  const stage = el('div', 'bd-full-stage');
  stage.appendChild(drawing);
  node.append(bar, stage);
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeDiagramFullscreen(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === '0') { e.preventDefault(); zoom.fit(); } else if (e.key === '+' || e.key === '=') { e.preventDefault(); zoom.zoomBy(1.4); } else if (e.key === '-') { e.preventDefault(); zoom.zoomBy(1 / 1.4); }
  };
  fullscreen = { node, onKey, opener };
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(node); // body, not the card: it fills the app window whatever the card's size or transforms
  close.focus();
}

/** The diagram box with its Fullscreen button above it. `make(true)` must draw the same diagram again, fitted to the overlay. */
function withFullscreen(label, make) {
  const host = el('div', 'bd-wrap'), bar = el('div', 'bd-bar');
  const btn = el('button', 'nb-back bd-full-btn', t('brain.diagram.full'));
  btn.type = 'button'; btn.title = `${t('brain.diagram.full')}: ${label}`; btn.setAttribute('aria-label', btn.title);
  btn.addEventListener('click', () => openDiagramFullscreen(label, () => make(true), btn));
  bar.append(el('span', 'nb-sp'), btn);
  host.append(bar, make(false));
  return host;
}

// ---- fullscreen text fit ----
let measureCtx = null; // a canvas 2d context, made on first use (this module is also imported in Node, which has no document)
function textWidth(txt, px, weight) {
  if (measureCtx === null) measureCtx = document.createElement('canvas').getContext('2d') || false;
  if (!measureCtx) return txt.length * px * 0.62;
  measureCtx.font = `${weight} ${px}px ${getComputedStyle(document.body).fontFamily}`;
  return measureCtx.measureText(txt).width;
}

/** Greedy word wrap to `maxW` px; a word wider than a line is cut by characters. Never drops text. */
function wrapPx(text, maxW, px, weight) {
  const fits = (str) => textWidth(str, px, weight) * 1.04 <= maxW; // 4 % margin for the rendering difference
  const out = [];
  let cur = '';
  for (const word of String(text ?? '').split(/\s+/).filter(Boolean)) {
    const joined = cur ? `${cur} ${word}` : word;
    if (fits(joined)) { cur = joined; continue; }
    if (cur) { out.push(cur); cur = ''; }
    let w = word;
    while (!fits(w) && w.length > 1) { let k = w.length - 1; while (k > 1 && !fits(w.slice(0, k))) k--; out.push(w.slice(0, k)); w = w.slice(k); }
    cur = w;
  }
  if (cur) out.push(cur);
  return out.length ? out : [''];
}

/** Scales the engine geometry (x by fx, y by fy): boxes, lanes, edge paths and edge labels. Fonts are not scaled, so boxes gain room for text. */
function stretch(g, fx, fy, key) {
  const box = (b) => ({ ...b, x: b.x * fx, y: b.y * fy, w: b.w * fx, h: b.h * fy });
  const edge = (e) => ({ ...e, d: e.d.replace(/(-?[\d.]+),(-?[\d.]+)/g, (_, x, y) => `${x * fx},${y * fy}`), ...(e.lx != null ? { lx: e.lx * fx, ly: e.ly * fy } : {}) });
  return { ...g, width: g.width * fx, height: g.height * fy, lanes: g.lanes.map(box), edges: g.edges.map(edge), [key]: g[key].map(box) };
}

/**
 * Fullscreen geometry with the whole text: for each candidate box width factor, wrap every label (and sub-text) to the box, take the box
 * height factor the tallest text needs, and keep the pair whose drawing fits the window at the largest scale. `lay(item, innerW)` returns
 * { patch, need }: the item's new text lines and the box height they need (px in the engine's units; fonts are drawn 1:1 in those units).
 */
function fitFull(g, key, lay) {
  const W = innerWidth - 28, H = innerHeight - 28 - 44; // overlay padding and its title bar
  let best = null;
  for (const fx of [1, 1.25, 1.5, 1.75, 2, 2.5]) {
    const rows = g[key].map((b) => lay(b, b.w * fx - 16));
    const fy = Math.max(1, ...g[key].map((b, i) => rows[i].need / b.h));
    const fit = Math.min(W / (g.width * fx), H / (g.height * fy));
    if (!best || fit > best.fit * 1.01) best = { fx, fy, rows, fit };
  }
  const out = stretch(g, best.fx, best.fy, key);
  out[key] = out[key].map((b, i) => ({ ...b, ...best.rows[i].patch }));
  return out;
}

/** The step flow of one task as an SVG box, or null when the task has no live step. */
export function renderFlow(task) {
  const g = LD().layoutTask(task);
  if (g.empty) return null;
  return withFullscreen(t('brain.detail.flow'), (full) => drawFlow(g, full));
}

function drawFlow(g0, full) {
  // box text: 12 px label from y+30 down in 14 px steps, the state line 7 px above the bottom edge
  const g = full ? fitFull(g0, 'boxes', (b, w) => { const labelLines = wrapPx(b.label, w, 12, 600); return { patch: { labelLines }, need: 48 + (labelLines.length - 1) * 14 }; }) : g0;
  const out = [];
  for (const ln of g.lanes) {
    out.push(svg('rect', { class: 'bd-lane', x: ln.x, y: ln.y, width: ln.w, height: ln.h }));
    out.push(svg('text', { class: 'bd-lane-tag', x: ln.x + 6, y: ln.y + 12 }, `${t(`brain.zone.${ln.key}`)} · ${ln.count}`));
  }
  for (const e of g.edges) out.push(svg('path', { class: `bd-edge ${e.dir}`, d: e.d, 'marker-end': 'url(#MID)' }));
  for (const b of g.boxes) {
    const grp = svg('g', { class: `bd-box ${STATE_CLASS[b.state] || 'todo'}${b.current ? ' current' : ''}${b.waitingOwner ? ' owner-wait' : ''}`, 'data-step': b.id });
    grp.appendChild(svg('title', {}, `${b.index}. ${b.label} (${t(`brain.step.${b.state}`)})`));
    grp.appendChild(svg('rect', { x: b.x, y: b.y, width: b.w, height: b.h }));
    grp.appendChild(svg('text', { x: b.x + 8, y: b.y + 14, class: 'bd-idx' }, `${b.index}`));
    for (const tx of lines(b.x + 8, b.y + 30, b.labelLines, 'bd-label')) grp.appendChild(tx);
    grp.appendChild(svg('text', { x: b.x + 8, y: b.y + b.h - 7, class: 'bd-state' }, t(`brain.step.${b.state}`)));
    out.push(grp);
  }
  return wrap(g.width, g.height, out, t('brain.detail.flow'), full);
}

/** The structure diagram of one task, or null when it has none (a missing or empty `architecture`). */
export function renderStructure(architecture) {
  // compact = the engine's top-down layout (lanes as vertical bands) made for a narrow column: the card is ~350-600 px wide, so the
  // wide left-to-right layout would fall below the readable scale; here the height grows instead.
  const g = LD().layoutArchitecture(architecture, { compact: true });
  if (g.empty) return null;
  return withFullscreen(t('brain.detail.structure'), (full) => drawStructure(g, full));
}

function drawStructure(g0, full) {
  // node text: label from y+22 (y+28 without a sub-text) in 14 px steps; sub-text lines end 8 px above the bottom edge
  const g = full ? fitFull(g0, 'nodes', (n, w) => {
    const lines = wrapPx(n.label, w, 12, 600), subLines = n.sub ? wrapPx(n.sub, w, 10.5, 400) : [];
    return { patch: { lines, subLines }, need: subLines.length ? 45 + (lines.length - 1) * 14 + (subLines.length - 1) * 14 : 40 + (lines.length - 1) * 14 };
  }) : g0;
  const out = [];
  for (const ln of g.lanes) {
    out.push(svg('rect', { class: 'bd-lane', x: ln.x, y: ln.y, width: ln.w, height: ln.h }));
    if (ln.label) out.push(svg('text', { class: 'bd-lane-tag', x: ln.x + 8, y: ln.y + 15 }, ln.label));
  }
  for (const e of g.edges) {
    out.push(svg('path', { class: `bd-edge${e.dashed ? ' dashed' : ''}`, d: e.d, 'marker-end': 'url(#MID)' }));
    if (e.label) out.push(svg('text', { class: 'bd-edge-label', x: e.lx, y: e.ly, 'text-anchor': e.anchor || 'middle' }, e.label));
  }
  for (const n of g.nodes) {
    const grp = svg('g', { class: 'bd-box node', 'data-node': n.id });
    grp.appendChild(svg('title', {}, n.sub ? `${n.label}: ${n.sub}` : n.label));
    grp.appendChild(svg('rect', { x: n.x, y: n.y, width: n.w, height: n.h }));
    const top = n.y + (n.subLines.length ? 22 : 28);
    for (const tx of lines(n.x + 8, top, n.lines, 'bd-label')) grp.appendChild(tx);
    for (const tx of lines(n.x + 8, n.y + n.h - 8 - (n.subLines.length - 1) * 14, n.subLines, 'bd-sub')) grp.appendChild(tx); // one line in the panel: same place
    out.push(grp);
  }
  return wrap(g.width, g.height, out, t('brain.detail.structure'), full);
}
