// W-42 5A.3: the read-only viewer of a task's diagram/1 document (contract section 7). Markup only, no fetch and no UI text:
// app.js passes the translated labels, fetches GET /api/v1/diagram/:task and binds pan, zoom and the node panel.
// Geometry goes into SVG attributes and colours into classes (CSP style-src 'self': no style attribute anywhere).
// Loaded as a classic script (window.LaneDiagramView) and importable in Node (globalThis.LaneDiagramView) for tests.
(function (root) {
  'use strict';

  const ZOOM_MIN = 0.03, ZOOM_MAX = 3;
  /**
   * Level of detail by zoom: far = region titles, mid = node titles, near = titles and body lines (plan B3.3). A level starts where its
   * text is readable on screen (node title 25 px x 0.34 = 8.5 px, body 19 px x 0.6 = 11.4 px); below that it is hidden, not drawn as noise.
   */
  const LOD = { mid: 0.34, near: 0.6 };
  const KINDS = ['ui', 'service', 'data', 'infra', 'guard', 'flow', 'external'];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const kindClass = k => (KINDS.includes(k) ? k : 'service');
  const clampZoom = z => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number.isFinite(z) && z > 0 ? z : 1));
  const lodOf = z => (z >= LOD.near ? 'near' : z >= LOD.mid ? 'mid' : 'far');

  /** Greedy wrap of `text` to lines of about `chars` characters, at most `max` lines; a cut last line ends with "…". */
  function wrap(text, chars, max) {
    const words = String(text || '').split(/\s+/).filter(Boolean), lines = [];
    let cur = '';
    for (const w of words) {
      if (!cur) cur = w;
      else if ((cur + ' ' + w).length <= chars) cur += ' ' + w;
      else { lines.push(cur); cur = w; if (lines.length === max) break; }
    }
    if (cur && lines.length < max) lines.push(cur);
    const used = lines.join(' ').split(/\s+/).filter(Boolean).length;
    if (used < words.length && lines.length) lines[lines.length - 1] = lines[lines.length - 1].replace(/\s*\S{0,3}$/, '') + '…';
    return lines.map(l => (l.length > chars + 2 ? l.slice(0, chars) + '…' : l));
  }
  const mid = b => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
  /** An edge between the nearest side midpoints: straight when aligned, else one elbow. */
  function edgePath(a, b) {
    const A = mid(a), B = mid(b), dx = B.x - A.x, dy = B.y - A.y;
    if (Math.abs(dx) >= Math.abs(dy)) {
      const sx = A.x + Math.sign(dx) * a.w / 2, ex = B.x - Math.sign(dx) * b.w / 2;
      if (Math.abs(dy) < 4) return { d: `M${sx},${A.y} L${ex},${B.y}`, lx: (sx + ex) / 2, ly: A.y - 6 };
      const mx = (sx + ex) / 2;
      return { d: `M${sx},${A.y} L${mx},${A.y} L${mx},${B.y} L${ex},${B.y}`, lx: mx, ly: (A.y + B.y) / 2 };
    }
    const sy = A.y + Math.sign(dy) * a.h / 2, ey = B.y - Math.sign(dy) * b.h / 2;
    if (Math.abs(dx) < 4) return { d: `M${A.x},${sy} L${B.x},${ey}`, lx: A.x + 6, ly: (sy + ey) / 2 };
    const my = (sy + ey) / 2;
    return { d: `M${A.x},${sy} L${A.x},${my} L${B.x},${my} L${B.x},${ey}`, lx: (A.x + B.x) / 2, ly: my - 6 };
  }
  /** The far-zoom region title fills most of its region width (an SVG presentation attribute, not a style). */
  /**
   * The far-zoom region title: one line, or two when that lets it be larger (a long title in a narrow region read at 9 px on a phone
   * at fit). Sized to fill about 90 % of the region width and at most 70 % of its height.
   */
  function farTitle(title, r) {
    const size = lines => Math.max(60, Math.min(320, Math.floor((r.w * 0.9) / Math.max(4, ...lines.map(l => l.length)) / 0.58), Math.floor((r.h * 0.7) / lines.length / 1.15)));
    const one = [String(title)], two = String(title).length > 14 ? wrap(title, Math.ceil(String(title).length / 2) + 2, 2) : one;
    const lines = two.length === 2 && size(two) > size(one) ? two : one, fs = size(lines), x = r.x + r.w / 2;
    const y0 = r.y + r.h / 2 - ((lines.length - 1) * fs * 1.15) / 2;
    return `<text class="dgv-region-far" data-action="dgv-region" data-region="${esc(r.id)}" x="${x}" y="${y0}" text-anchor="middle" dominant-baseline="middle" font-size="${fs}">${tspans(lines, x, y0, Math.round(fs * 1.15))}</text>`;
  }
  /** The box around every region and node: what "fit" frames (a canvas is often larger than its content). */
  function contentBox(doc) {
    const all = [...doc.regions, ...doc.nodes];
    if (!all.length) return { x: 0, y: 0, w: doc.canvas.w, h: doc.canvas.h };
    const x = Math.min(...all.map(b => b.x)), y = Math.min(...all.map(b => b.y));
    return { x, y, w: Math.max(...all.map(b => b.x + b.w)) - x, h: Math.max(...all.map(b => b.y + b.h)) - y };
  }
  const tspans = (lines, x, y0, dy) => lines.map((l, i) => `<tspan x="${x}" y="${y0 + i * dy}">${esc(l)}</tspan>`).join('');

  /**
   * The whole diagram as one SVG string. `lang` 'vi'|'en' picks titles and bodies (the other side is the fallback);
   * `counts` = { nodeId: open threads }, `selected` = node id; `aria` = the SVG's label.
   */
  function svg(doc, { lang = 'vi', counts = {}, selected = '', aria = '' } = {}) {
    const pick = (pair, side) => (pair && pair[side]) || (pair && pair[side === 'vi' ? 'en' : 'vi']) || '';
    const byId = new Map(doc.nodes.map(n => [n.id, n]));
    const regions = doc.regions.map(r => {
      const title = lang === 'en' ? (r.en || r.vi) : (r.vi || r.en);
      return `<g class="dgv-region k-${kindClass(r.kind)}"><rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="18"/>`
        + `<text class="dgv-region-t" x="${r.x + 28}" y="${r.y + 64}">${esc(title)}</text>`
        + (r.viLead && lang === 'vi' ? `<text class="dgv-region-lead" x="${r.x + 28}" y="${r.y + 104}">${tspans(wrap(r.viLead, Math.max(20, Math.floor(r.w / 15)), 2), r.x + 28, r.y + 104, 30)}</text>` : '')
        + '</g>';
    }).join('');
    // Far-zoom titles sit on their own top layer: drawn inside the region they were covered by its nodes and unreadable at fit.
    const far = doc.regions.map(r => farTitle(lang === 'en' ? (r.en || r.vi) : (r.vi || r.en), r)).join('');
    const edges = doc.edges.map(e => {
      const a = byId.get(e.from), b = byId.get(e.to);
      if (!a || !b) return '';
      const p = edgePath(a, b), label = lang === 'en' ? (e.en || e.vi) : (e.vi || e.en);
      return `<g class="dgv-edge${e.dashed ? ' dashed' : ''}"><path d="${p.d}" marker-end="url(#dgv-arrow)"/>${label ? `<text class="dgv-edge-t" x="${p.lx}" y="${p.ly}" text-anchor="middle">${esc(label)}</text>` : ''}</g>`;
    }).join('');
    const nodes = doc.nodes.map(n => {
      const t = pick({ vi: n.vi?.title, en: n.en?.title }, lang), body = pick({ vi: n.vi?.body, en: n.en?.body }, lang);
      const chars = Math.max(10, Math.floor((n.w - 28) / 11));
      const titleLines = wrap(t, Math.max(8, Math.floor((n.w - 28) / 15)), 2);
      const bodyY = n.y + 46 + titleLines.length * 31;
      const bodyLines = wrap(body, chars, Math.max(1, Math.min(3, Math.floor((n.y + n.h - bodyY) / 24))));
      const muted = n.state && n.state !== 'live' ? ' muted' : '';
      const c = counts[n.id] || 0;
      return `<g class="dgv-node k-${kindClass(n.kind)}${muted}${n.core ? ' core' : ''}${selected === n.id ? ' sel' : ''}" data-action="dgv-node" data-node="${esc(n.id)}" tabindex="0" role="button" aria-label="${esc(t)}">`
        + `<rect class="dgv-under" x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="12"/><rect class="dgv-box" x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="12"/>`
        + (n.tag ? `<text class="dgv-tag" x="${n.x + 14}" y="${n.y + 24}">${esc(n.tag)}</text>` : '')
        + `<text class="dgv-node-t" x="${n.x + 14}" y="${n.y + 56}">${tspans(titleLines, n.x + 14, n.y + 56, 31)}</text>`
        + `<text class="dgv-node-b" x="${n.x + 14}" y="${bodyY}">${tspans(bodyLines, n.x + 14, bodyY, 24)}</text>`
        + (n.core ? `<circle class="dgv-core" cx="${n.x + n.w - 18}" cy="${n.y + 18}" r="7"/>` : '')
        + (c ? `<g class="dgv-count"><circle cx="${n.x + n.w - 6}" cy="${n.y + n.h - 6}" r="16"/><text x="${n.x + n.w - 6}" y="${n.y + n.h}" text-anchor="middle">${c}</text></g>` : '')
        + '</g>';
    }).join('');
    const defs = '<defs><marker id="dgv-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="dgv-arrow" d="M0,0 L10,5 L0,10 z"/></marker></defs>';
    return `<svg class="dgv-svg" xmlns="http://www.w3.org/2000/svg" width="${doc.canvas.w}" height="${doc.canvas.h}" viewBox="0 0 ${doc.canvas.w} ${doc.canvas.h}" role="group" aria-label="${esc(aria)}">${defs}<g class="dgv-regions">${regions}</g><g class="dgv-edges">${edges}</g><g class="dgv-nodes">${nodes}</g><g class="dgv-far">${far}</g></svg>`;
  }

  /** The zoom that fits a w x h world into a stage, and the offsets that centre it. */
  function fit(box, sw, sh) {
    const zoom = clampZoom(Math.min(sw / box.w, sh / box.h) * 0.96);
    return { zoom, x: (sw - box.w * zoom) / 2 - box.x * zoom, y: (sh - box.h * zoom) / 2 - box.y * zoom };
  }
  /**
   * The SVG viewBox for a view { zoom, x, y } on a sw x sh stage (x, y = where world 0,0 sits on the stage, in px). Pan and zoom go
   * through the viewBox, not a CSS scale, so the browser draws the text as vectors at its real size at every zoom (gate MF-C: a CSS
   * scale on a will-change layer rasterised the text at the tiny fit scale and broke the glyphs).
   */
  const viewBox = (v, sw, sh) => [-v.x / v.zoom, -v.y / v.zoom, sw / v.zoom, sh / v.zoom].map(n => Math.round(n * 100) / 100).join(' ');
  /** Zoom to `next` keeping the world point under (cx, cy) still. */
  function zoomAbout(v, next, cx, cy) {
    const z = clampZoom(next), k = z / v.zoom;
    return { zoom: z, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k };
  }
  /** Open-thread count per node from the view's comments (open roots only). */
  const openCounts = comments => {
    const c = {};
    for (const th of comments || []) if (th.root.status === 'open') c[th.node_id] = (c[th.node_id] || 0) + 1;
    return c;
  };

  root.LaneDiagramView = { KINDS, svg, fit, viewBox, contentBox, zoomAbout, clampZoom, lodOf, wrap, edgePath, openCounts, ZOOM_MIN, ZOOM_MAX, LOD };
})(typeof window !== 'undefined' ? window : globalThis);
