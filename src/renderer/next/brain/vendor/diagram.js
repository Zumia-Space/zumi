// Layout for the two board diagrams: the per-task step flow (swimlanes by zone) and the Home task map.
// Pure functions only: no DOM, no fetch, no UI text (app.js turns the geometry into markup and translates labels).
// Loaded as a classic script in the browser (sets window.LaneDiagram) and importable in Node (sets globalThis.LaneDiagram).
//
// The flow rule is the predecessor board's (its board.html, taskFlow): walk the steps in board order and
// advance one column, unless the next step sits in a LOWER lane — then it stacks under the previous one, reading as a
// hand-down between phases. The merged `lich-su` step is not part of the flow: it is one collapsed box (a history chip)
// that shows its lines only when opened, so an archive of old steps can never push the live steps off screen.
(function (root) {
  'use strict';

  const ZONES = ['plan', 'build', 'test', 'owner', 'ship'];
  const HISTORY_ID = 'lich-su';
  const BOX_W = 152, BOX_H = 62, COL_GAP = 34, LANE_H = 98, PAD = 10;
  // The zone labels live in a fixed column OUTSIDE the scroller (app.js draws it), so they stay put while the flow
  // scrolls: a lane whose label scrolled away tells the reader nothing.
  const LANE_TAG_W = 92;
  const HEALTH = ['green', 'yellow', 'red', 'grey'];

  const shortId = id => String(id ?? '').split('/').pop();
  const zoneOf = s => (s && ZONES.includes(s.zone) ? s.zone : 'build');
  const isHistory = s => shortId(s && s.id) === HISTORY_ID;
  const sameStep = (a, b) => !!a && !!b && (String(a) === String(b) || shortId(a) === shortId(b));

  /** The lines of a merged history step: one archived step per line, already "dd/mm · label · result" from the server. */
  function historyLines(step) {
    return String((step && step.detail) || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  }

  /** Greedy word wrap capped at `maxLines`; a cut last line ends with "…" instead of hiding the rest silently. */
  function wrapLabel(text, max = 17, maxLines = 2) {
    const words = String(text ?? '').trim().split(/\s+/).filter(Boolean);
    if (!words.length) return [''];
    const lines = [];
    let cur = '', i = 0;
    while (i < words.length) {
      const next = cur ? cur + ' ' + words[i] : words[i];
      if (cur && next.length > max) {
        lines.push(cur);
        cur = '';
        if (lines.length === maxLines) break;
        continue; // re-try the same word on the new line
      }
      cur = next;
      i++;
    }
    if (cur && lines.length < maxLines) lines.push(cur);
    if (lines.length === maxLines && i < words.length) {
      const last = lines[maxLines - 1];
      lines[maxLines - 1] = last.replace(/\s+\S*$/, '') + '…';
    }
    return lines;
  }

  /**
   * Geometry of one task's step flow.
   * Returns { empty, width, height, lanes, boxes, edges, history }:
   *   lanes  [{ key, y, h, x, w, count }] — only the zones the live steps use, in phase order
   *   boxes  [{ id, short, index, x, y, w, h, zone, state, current, owner, waitingOwner, done, label, labelLines }]
   *   edges  [{ d, dir }] — one arrow between each consecutive pair of live steps
   *   history { id, short, lines, count, collapsed, label } | null
   */
  function layoutTask(task, opts = {}) {
    const all = Array.isArray(task && task.steps) ? task.steps : [];
    const hist = all.find(isHistory) || null;
    const flow = all.filter(s => !isHistory(s));
    const lanesUsed = ZONES.filter(z => flow.some(s => zoneOf(s) === z));
    const currentId = task && task.current_step ? task.current_step.id : null;

    const col = [];
    flow.forEach((s, i) => {
      if (!i) { col[i] = 0; return; }
      const lower = lanesUsed.indexOf(zoneOf(s)) > lanesUsed.indexOf(zoneOf(flow[i - 1]));
      col[i] = col[i - 1] + (lower ? 0 : 1);
    });
    const ncol = flow.length ? Math.max(...col) + 1 : 0;
    // no left gutter: the lane labels are a fixed column beside the scroller, so the flow starts at the first box
    const width = PAD * 2 + Math.max(1, ncol) * BOX_W + Math.max(0, ncol - 1) * COL_GAP;
    const laneCount = Math.max(1, lanesUsed.length);
    const height = PAD + laneCount * LANE_H + PAD;

    const laneIndex = s => lanesUsed.indexOf(zoneOf(s));
    const xOf = i => PAD + col[i] * (BOX_W + COL_GAP);
    const yOf = i => PAD + laneIndex(flow[i]) * LANE_H + (LANE_H - BOX_H) / 2;

    const lanes = lanesUsed.map((key, i) => ({
      key, y: PAD + i * LANE_H, h: LANE_H - 8, x: 4, w: Math.max(1, width - 8),
      count: flow.filter(s => zoneOf(s) === key).length
    }));

    const boxes = flow.map((s, i) => ({
      id: s.id,
      short: shortId(s.id),
      index: all.indexOf(s) + 1, // the number the Steps list shows, even when the history step sits first
      x: xOf(i), y: yOf(i), w: BOX_W, h: BOX_H,
      zone: zoneOf(s),
      state: s.state || 'todo',
      current: sameStep(s.id, currentId),
      owner: zoneOf(s) === 'owner',
      waitingOwner: zoneOf(s) === 'owner' && s.state === 'waiting',
      done: s.state === 'done',
      label: s.label || shortId(s.id), // the whole title: the box clamps to two lines, the hover tooltip must not
      labelLines: wrapLabel(s.label || shortId(s.id), 17, 2)
    }));

    const edges = [];
    for (let i = 1; i < boxes.length; i++) {
      const a = boxes[i - 1], b = boxes[i];
      let d, dir;
      if (a.x === b.x) { // the next step is in a lower lane, stacked under this one
        d = `M${a.x + a.w / 2},${a.y + a.h} L${b.x + b.w / 2},${b.y}`; dir = 'down';
      } else if (a.y === b.y) {
        d = `M${a.x + a.w},${a.y + a.h / 2} L${b.x},${b.y + b.h / 2}`; dir = 'right';
      } else { // a new column and a new lane: out, across the gutter, in
        const mx = a.x + a.w + COL_GAP / 2;
        d = `M${a.x + a.w},${a.y + a.h / 2} L${mx},${a.y + a.h / 2} L${mx},${b.y + b.h / 2} L${b.x},${b.y + b.h / 2}`; dir = 'elbow';
      }
      edges.push({ d, dir, from: a.id, to: b.id });
    }

    const lines = hist ? historyLines(hist) : [];
    const history = hist ? {
      id: hist.id, short: shortId(hist.id), label: hist.label || '',
      lines, count: lines.length, collapsed: !opts.historyOpen
    } : null;

    return { empty: boxes.length === 0, width, height, lanes, boxes, edges, history };
  }

  /**
   * The scrollLeft that brings a box (its left edge is `x`) into view with its predecessor whole: one column of
   * context to the left, and the viewport's left edge in a gutter, never through a box — a sliced box reads as a bug.
   * When the pane is too narrow for both, the wanted box wins and the edge fade marks the cut. `max` is the
   * scroller's scrollWidth - clientWidth, `client` its width. Pure: the app applies the number, the check script and
   * the tests measure the result.
   */
  function scrollLeftFor(x, max, client) {
    const start = Number(x) || 0, limit = Math.max(0, Math.floor(Number(max) || 0)), view = Math.max(0, Number(client) || 0);
    if (start <= PAD) return 0; // the first column already sits at the left edge: nothing to scroll
    const target = Math.min(limit, Math.max(0, start - (BOX_W + COL_GAP)));
    const k = Math.floor((target - PAD) / (BOX_W + COL_GAP));
    const rem = target - PAD - k * (BOX_W + COL_GAP);
    const fits = t => view > 0 && t + view >= start + BOX_W; // the wanted box whole, not sliced at the right
    if (k < 0 || rem >= BOX_W) return fits(target) || view <= 0 ? target : limit; // already a gutter
    const before = Math.max(0, PAD + k * (BOX_W + COL_GAP) - COL_GAP); // gutters either side of the box the edge crosses
    const after = PAD + k * (BOX_W + COL_GAP) + BOX_W;
    if (view <= 0) return before;
    if (fits(before)) return before;                  // one whole column of context: the wanted box too
    if (after <= limit && fits(after)) return after;   // that gutter shows it whole: still no slice
    return limit;                                      // no room for both: the wanted box whole, fade on the left cut
  }

  // ---- the product-structure diagram (task.architecture, src/architecture.mjs): groups = swimlanes, nodes in columns by
  // how far they sit from the start of the flow, edges as curves. Defensive: the page may be handed a stale or odd value. ----
  const A_W = 168, A_H = 62, A_GAP_X = 56, A_GAP_Y = 14, A_PAD = 12, A_LANE_PAD = 14, A_TAG_W = 118;

  /**
   * Geometry of one architecture. Returns { empty, width, height, lanes, nodes, edges }:
   *   lanes [{ id, label, y, h, x, w }] — one per declared group that has a node, then '' (no group) when a node has none
   *   nodes [{ id, label, sub, lines, x, y, w, h, lane }]
   *   edges [{ from, to, d, lx, ly, label, dashed, back }] — forward edges leave right and enter left; a back edge (a cycle)
   *         arcs over the top and is drawn dashed
   * Columns: longest path from a node with no incoming forward edge; a back edge is any edge found closing a cycle in a
   * depth-first walk in declaration order, so the result is the same for the same input.
   */
  function layoutArchitecture(arch, opts) {
    const compact = !!(opts && opts.compact);
    const nodesIn = arch && Array.isArray(arch.nodes) ? arch.nodes.filter(n => n && typeof n.id === 'string') : [];
    const groupsIn = arch && Array.isArray(arch.groups) ? arch.groups.filter(g => g && typeof g.id === 'string') : [];
    if (!nodesIn.length) return { empty: true, width: 0, height: 0, lanes: [], nodes: [], edges: [] };
    const byId = new Map(nodesIn.map(n => [n.id, n]));
    const edgesIn = (Array.isArray(arch.edges) ? arch.edges : []).filter(e => e && byId.has(e.from) && byId.has(e.to) && e.from !== e.to);

    // back edges: DFS colouring
    const out = new Map(nodesIn.map(n => [n.id, []]));
    edgesIn.forEach((e, i) => out.get(e.from).push(i));
    const state = new Map(), back = new Set();
    const visit = id => { state.set(id, 1); for (const i of out.get(id)) { const to = edgesIn[i].to; if (state.get(to) === 1) back.add(i); else if (!state.has(to)) visit(to); } state.set(id, 2); };
    for (const n of nodesIn) if (!state.has(n.id)) visit(n.id);

    // columns: longest path over the forward edges (a DAG now), by repeated relaxation
    const col = new Map(nodesIn.map(n => [n.id, 0]));
    for (let pass = 0; pass < nodesIn.length; pass++) {
      let moved = false;
      edgesIn.forEach((e, i) => { if (!back.has(i) && col.get(e.to) < col.get(e.from) + 1) { col.set(e.to, col.get(e.from) + 1); moved = true; } });
      if (!moved) break;
    }
    const ncol = Math.max(...col.values()) + 1;

    // lanes: declared groups that hold a node, in declaration order; nodes with no (or an unknown) group go last
    const gid = n => (groupsIn.some(g => g.id === n.group) ? n.group : '');
    const laneIds = groupsIn.map(g => g.id).filter(id => nodesIn.some(n => gid(n) === id));
    if (nodesIn.some(n => gid(n) === '')) laneIds.push('');
    const labelOf = id => { const g = groupsIn.find(x => x.id === id); return g ? String(g.label ?? id) : ''; };

    // slot of a node inside its lane+column cell, and the lane height from its tallest column
    const slot = new Map(), depth = new Map();
    for (const n of nodesIn) { const key = gid(n) + '|' + col.get(n.id); slot.set(n.id, depth.get(key) || 0); depth.set(key, (depth.get(key) || 0) + 1); }
    const laneRows = laneIds.map(id => Math.max(1, ...nodesIn.filter(n => gid(n) === id).map(n => slot.get(n.id) + 1)));
    const laneH = laneRows.map(r => A_LANE_PAD * 2 + r * A_H + (r - 1) * A_GAP_Y);
    if (compact) return layoutCompact({ nodesIn, edgesIn, back, col, ncol, laneIds, gid, labelOf, slot });
    const arcRoom = back.size ? 32 : 0; // a back edge arcs above the top lane: leave it room inside the canvas
    const laneY = []; laneH.reduce((y, h, i) => { laneY[i] = y; return y + h + 8; }, A_PAD + arcRoom);

    const width = A_TAG_W + A_PAD * 2 + ncol * A_W + (ncol - 1) * A_GAP_X;
    const height = laneY[laneY.length - 1] + laneH[laneH.length - 1] + A_PAD;
    const lanes = laneIds.map((id, i) => ({ id, label: labelOf(id), x: 4, y: laneY[i], w: width - 8, h: laneH[i] }));
    const nodes = nodesIn.map(n => {
      const li = laneIds.indexOf(gid(n));
      return { id: n.id, label: String(n.label ?? n.id), sub: n.sub ? String(n.sub) : '', lines: wrapLabel(String(n.label ?? n.id), 20, 2), subLines: n.sub ? wrapLabel(String(n.sub), 24, 1) : [], lane: laneIds[li],
        x: A_TAG_W + A_PAD + col.get(n.id) * (A_W + A_GAP_X), y: laneY[li] + A_LANE_PAD + slot.get(n.id) * (A_H + A_GAP_Y), w: A_W, h: A_H };
    });
    const at = new Map(nodes.map(n => [n.id, n]));
    const edges = edgesIn.map((e, i) => {
      const a = at.get(e.from), b = at.get(e.to), isBack = back.has(i);
      let d, lx, ly;
      if (isBack) { // arc over the top of both, dashed
        const x1 = a.x + a.w / 2, y1 = a.y, x2 = b.x + b.w / 2, y2 = b.y, top = Math.min(y1, y2) - 22 - (i % 3) * 6;
        d = `M${x1},${y1} C${x1},${top} ${x2},${top} ${x2},${y2}`; lx = (x1 + x2) / 2; ly = top + 4;
      } else if (b.x > a.x) { // forward: right edge -> left edge
        const x1 = a.x + a.w, y1 = a.y + a.h / 2, x2 = b.x, y2 = b.y + b.h / 2, k = Math.max(24, (x2 - x1) / 2);
        d = `M${x1},${y1} C${x1 + k},${y1} ${x2 - k},${y2} ${x2},${y2}`; lx = (x1 + x2) / 2; ly = (y1 + y2) / 2 - 4;
      } else { // same column: bottom -> top (or top -> bottom)
        const down = b.y > a.y, x1 = a.x + a.w / 2, y1 = down ? a.y + a.h : a.y, x2 = b.x + b.w / 2, y2 = down ? b.y : b.y + b.h;
        d = `M${x1},${y1} L${x2},${y2}`; lx = x1 + 6; ly = (y1 + y2) / 2;
      }
      return { from: e.from, to: e.to, d, lx, ly, label: e.label ? String(e.label) : '', dashed: !!e.dashed || isBack, back: isBack };
    });
    return { empty: false, width, height, lanes, nodes, edges };
  }

  // ---- compact (top-down) layout for the inline preview: lanes are vertical bands side by side, the flow runs DOWN the
  // columns. The width is (lanes x band), not (columns x box), so the whole graph fits a ~300 px tab column at a scale the
  // page can keep readable; the height grows instead and the page scrolls it like any other section.
  // EDGES NEVER PASS UNDER A BOX (the preview must show parallel branches as parallel). Every box sits in its own row slot, and an
  // edge only travels in free channels: the full-width gaps between rows, and the gutter strip at each side of a lane band. A
  // vertical run beside a lane's boxes uses that gutter; a horizontal run uses the gap just above its target (or below its source).
  // Edges are polylines (e.pts): the tests and shot-architecture.mjs check that no segment crosses a box. ----
  const C_W = 128, C_H = 62, C_PAD = 8, C_GUTTER = 11, C_LANE_GAP = 4, C_HEAD = 26, C_GAP = 28, C_BACK_ROOM = 20, C_TRACK = 3;
  const labelW = s => Math.ceil(String(s).length * 6.9); // ~13 px text in the compact unit, only used to keep a label inside the canvas
  function layoutCompact({ nodesIn, edgesIn, back, col, ncol, laneIds, gid, labelOf, slot }) {
    const laneW = C_W + C_GUTTER * 2, nl = laneIds.length;
    const rowsIn = Array.from({ length: ncol }, () => 1);
    for (const n of nodesIn) rowsIn[col.get(n.id)] = Math.max(rowsIn[col.get(n.id)], slot.get(n.id) + 1);
    const rowY = []; rowsIn.reduce((y, r, c) => { rowY[c] = y; return y + r * C_H + (r - 1) * C_GAP + C_GAP; }, C_PAD + C_HEAD + C_GAP / 2); // the first gap sits under the lane labels
    const bodyEnd = rowY[ncol - 1] + rowsIn[ncol - 1] * C_H + (rowsIn[ncol - 1] - 1) * C_GAP;
    const roomR = back.size ? C_BACK_ROOM : 0;
    const width = C_PAD * 2 + nl * laneW + (nl - 1) * C_LANE_GAP + roomR, height = bodyEnd + C_GAP / 2 + C_PAD;
    const lanes = laneIds.map((id, i) => ({ id, label: labelOf(id), x: C_PAD + i * (laneW + C_LANE_GAP), y: C_PAD, w: laneW, h: height - C_PAD * 2 }));
    const nodes = nodesIn.map(n => {
      const li = laneIds.indexOf(gid(n));
      return { id: n.id, label: String(n.label ?? n.id), sub: n.sub ? String(n.sub) : '', lines: wrapLabel(String(n.label ?? n.id), 12, 2), subLines: n.sub ? wrapLabel(String(n.sub), 16, 1) : [], lane: laneIds[li], li,
        x: lanes[li].x + C_GUTTER, y: rowY[col.get(n.id)] + slot.get(n.id) * (C_H + C_GAP), w: C_W, h: C_H };
    });
    const at = new Map(nodes.map(n => [n.id, n]));
    // gutter tracks: a vertical run takes the first track of the lane's gutter that is free over its y range
    const used = new Map();
    const track = (li, side, y1, y2) => {
      const key = li + side, list = used.get(key) || []; used.set(key, list);
      let k = 0; while (list.some(t => t.k === k && t.y1 < y2 + 2 && y1 < t.y2 + 2)) k++;
      list.push({ k, y1, y2 });
      const off = C_TRACK + (k % 3) * C_TRACK, ln = lanes[li];
      return side === 'r' ? ln.x + ln.w - off : ln.x + off;
    };
    const backUsed = [];
    const edges = edgesIn.map((e, i) => {
      const a = at.get(e.from), b = at.get(e.to), acx = a.x + a.w / 2, bcx = b.x + b.w / 2, acy = a.y + a.h / 2, bcy = b.y + b.h / 2;
      const forward = b.y > a.y + a.h && !back.has(i);
      const blocked = forward && nodes.some(n => n.li === a.li && n !== a && n !== b && n.y > a.y && n.y < b.y); // a box of a's lane sits between source and target
      let pts, lx, ly, anchor = 'middle';
      if (forward && a.li === b.li && !blocked) { // straight down the lane
        pts = [[acx, a.y + a.h], [bcx, b.y]];
        lx = acx + 6; ly = (a.y + a.h + b.y) / 2 + 4; anchor = 'start';
      } else if (forward && a.li === b.li) { // a box sits between: out of a's right side, down the gutter, into b's right side
        const xg = track(a.li, 'r', acy, bcy);
        pts = [[a.x + a.w, acy], [xg, acy], [xg, bcy], [b.x + b.w, bcy]];
        lx = xg - 3; ly = b.y - C_GAP / 2 + 4; anchor = 'end';
      } else if (forward) { // another lane: leave a (bottom, or its side when a box is below it), cross in the gap above b, drop into b's top
        const yc = b.y - C_GAP / 2, right = b.li > a.li;
        if (!blocked) pts = [[acx, a.y + a.h], [acx, yc]];
        else { const xg = track(a.li, right ? 'r' : 'l', acy, yc); pts = [[right ? a.x + a.w : a.x, acy], [xg, acy], [xg, yc]]; }
        pts.push([bcx, yc], [bcx, b.y]);
        const x1 = pts[pts.length - 3][0]; lx = (x1 + bcx) / 2; ly = yc + 4; // centred on the line (halo), inside the gap
      } else { // a cycle (back edge): below a into its gap, out to the right margin, up to the gap above b, over to b, down into its top
        let k = 0; const y1 = Math.min(a.y, b.y), y2 = Math.max(a.y, b.y); while (backUsed.some(t => t.k === k && t.y1 < y2 && y1 < t.y2)) k++; backUsed.push({ k, y1, y2 });
        const xm = width - C_PAD - 5 - (k % 3) * 5, ya = a.y + a.h + C_GAP / 2, yb = b.y - C_GAP / 2;
        pts = [[acx, a.y + a.h], [acx, ya], [xm, ya], [xm, yb], [bcx, yb], [bcx, b.y]];
        lx = (bcx + xm) / 2; ly = yb + 4;
      }
      const label = e.label ? String(e.label) : '';
      if (label) { // keep the whole label inside the canvas
        const w = labelW(label), left = anchor === 'middle' ? lx - w / 2 : anchor === 'end' ? lx - w : lx;
        if (left < 2) lx += 2 - left; else if (left + w > width - 2) lx -= left + w - (width - 2);
      }
      const d = 'M' + pts.map(p => p[0] + ',' + p[1]).join(' L');
      return { from: e.from, to: e.to, d, pts, lx, ly, anchor, label, dashed: !!e.dashed || back.has(i), back: back.has(i) };
    });
    return { empty: false, compact: true, width, height, lanes, nodes, edges };
  }

  // The inline preview is scaled to the column but never below this fraction of its natural size (the smallest text, the
  // 12 px sub-labels at natural size, stays at least ~7 px): a diagram with more lanes than that fits scrolls sideways instead.
  const FIT_MIN_SCALE = 0.55;
  /** The width the inline preview is drawn at: the column's, never wider than natural, never below FIT_MIN_SCALE. */
  function fitWidth(natural, available) {
    const nat = Number(natural) || 0, avail = Number(available);
    if (!(nat > 0)) return 0;
    if (!(avail > 0)) return nat;
    return Math.round(Math.max(nat * FIT_MIN_SCALE, Math.min(nat, avail)));
  }

  // The full view's zoom range: below 25% the 12px labels stop being readable, above 400% one box fills the pane.
  const ZOOM_MIN = 0.25, ZOOM_MAX = 4;
  /** A zoom factor inside the full view's range; a missing or nonsense value falls back to 100%. */
  function clampZoom(z) {
    const n = Number(z);
    return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, isFinite(n) && n > 0 ? n : 1));
  }
  /** Zoom about a point of the viewport: the diagram point under (cx, cy) stays there, so a wheel or pinch grows
   *  where the owner is looking instead of pulling the diagram under the corner. Pure; the app writes x/y back. */
  function zoomAbout(view, next, cx, cy) {
    const zoom = clampZoom(next), k = zoom / ((view && view.zoom) || 1);
    return { zoom, x: cx - (cx - ((view && view.x) || 0)) * k, y: cy - (cy - ((view && view.y) || 0)) * k };
  }

  /** The colour a task's box carries: its health, with a paused/closed task always grey (the predecessor's grey dot). */
  function healthClass(task) {
    if (!task) return 'grey';
    if (task.status === 'paused' || task.status === 'closed') return 'grey';
    return HEALTH.includes(task.health) ? task.health : 'grey';
  }

  /** Counts for the map's summary row; `waiting` is the owner-attention item count the Home header already uses. */
  function healthCounts(tasks, waiting = 0) {
    const out = { green: 0, yellow: 0, red: 0, grey: 0, waiting: Math.max(0, Math.floor(Number(waiting) || 0)), total: 0 };
    for (const t of Array.isArray(tasks) ? tasks : []) { out[healthClass(t)]++; out.total++; }
    return out;
  }

  /** The map's columns: one per lane, in the task order the server sent (already by `order` then id). */
  function mapGroups(tasks) {
    const order = [], by = new Map();
    for (const t of Array.isArray(tasks) ? tasks : []) {
      const key = t.lane || '';
      if (!by.has(key)) { by.set(key, []); order.push(key); }
      by.get(key).push(t);
    }
    return order.map(lane => ({ lane, tasks: by.get(lane) }));
  }

  root.LaneDiagram = { ZONES, HISTORY_ID, BOX_W, BOX_H, LANE_H, LANE_TAG_W, ZOOM_MIN, ZOOM_MAX, layoutTask, layoutArchitecture, fitWidth, FIT_MIN_SCALE, scrollLeftFor, clampZoom, zoomAbout, historyLines, wrapLabel, healthClass, healthCounts, mapGroups, shortId };
})(typeof window !== 'undefined' ? window : globalThis);
