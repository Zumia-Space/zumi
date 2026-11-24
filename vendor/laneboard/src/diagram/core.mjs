// diagram/1 documents, pure (W-42 5A contract sections 1.2, 2.5, 6): stamps, the 16 edit ops, the hard/soft lint split and the
// agent Markdown export. No fs and no schema loading: the board validates against schema/v1/diagram/*.json itself.
// Ported from the work-system's lib/diagram-doc.mjs + diagram-ops.mjs (P4), which keep a copy until the 5A.5 cutover.
import { createHash } from 'node:crypto';

export const sha256 = text => createHash('sha256').update(text).digest('hex');
/** The VI/EN pair a node was last declared in sync at. */
export const syncHash = n => sha256(JSON.stringify([n.vi.title, n.vi.body, n.en.title, n.en.body])).slice(0, 12);
const content = ({ x, y, w, h, ...rest }) => rest;
/** Document stamp: every content field (layout excluded). The server is its only writer; a hand edit no longer matches. */
export const stampHash = d => sha256(JSON.stringify([d.task, d.contentRev, d.title, d.subtitle ?? null,
  d.regions.map(content), d.nodes.map(content), d.edges])).slice(0, 12);
/** The stored form of a revision: JSON, indent 1, trailing newline (byte-identical to the P4 file). */
export const serialize = doc => `${JSON.stringify(doc, null, 1)}\n`;

export const LAYOUT_OPS = new Set(['node.move', 'node.resize', 'region.move', 'region.resize', 'canvas.resize']);
export const CONTENT_OPS = new Set(['node.add', 'node.remove', 'node.set', 'node.text', 'edge.add', 'edge.remove', 'edge.set', 'region.add', 'region.remove', 'region.text', 'title.text']);
export const REMOVE_OPS = new Set(['node.remove', 'edge.remove', 'region.remove']);
const SETTABLE = new Set(['kind', 'region', 'tag', 'state', 'src', 'core', 'cos', 'doc', 'order', 'enforcedBy', 'tracks', 'verified']);
const STATUS = { not_found: 404, conflict: 409, id_retired: 409, region_not_empty: 409, bad_op: 400 };

export class DiagramOpError extends Error {
  constructor(code, detail) { super(`${code}: ${detail}`); this.code = code; this.status = STATUS[code] || 400; this.detail = detail; }
}
const fail = (code, detail) => { throw new DiagramOpError(code, detail); };

/**
 * Applies `ops` in order to a copy of `doc0` (all or nothing: any fault throws and the caller writes nothing).
 * `retired` = ids removed earlier in this diagram's history (contract 6.4): adding one is 409 id_retired.
 * Returns the new document with rev +1, contentRev +1 when a content op is in it, VI/EN stamps (B2.7) and a new stamp.
 */
export function applyOps(doc0, ops, { retired = new Set() } = {}) {
  if (!Array.isArray(ops) || !ops.length) fail('bad_op', 'ops must be a non-empty array');
  const doc = structuredClone(doc0);
  const find = (list, id, what) => list.find(x => x.id === id) || fail('not_found', `${what} ${id}`);
  const fresh = (list, id, what) => {
    if (list.some(x => x.id === id)) fail('conflict', `${what} ${id} exists`);
    if (retired.has(id)) fail('id_retired', `${what} ${id} was used earlier in this diagram's history`);
  };
  const isContent = ops.some(o => CONTENT_OPS.has(o.op));
  doc.rev += 1;
  if (isContent) doc.contentRev += 1;
  const c = doc.contentRev;
  const touched = new Map(); // node id -> { vi, en, syncs }
  for (const o of ops) {
    switch (o.op) {
      case 'node.move': Object.assign(find(doc.nodes, o.id, 'node'), { x: o.x, y: o.y }); break;
      case 'node.resize': Object.assign(find(doc.nodes, o.id, 'node'), { w: o.w, h: o.h }); break;
      case 'region.move': {
        const r = find(doc.regions, o.id, 'region'), dx = o.x - r.x, dy = o.y - r.y;
        Object.assign(r, { x: o.x, y: o.y });
        for (const n of doc.nodes) if (n.region === r.id) { n.x += dx; n.y += dy; }
        break;
      }
      case 'region.resize': Object.assign(find(doc.regions, o.id, 'region'), { w: o.w, h: o.h }); break;
      case 'canvas.resize': doc.canvas = { w: o.w, h: o.h }; break;
      case 'node.text': {
        const n = find(doc.nodes, o.id, 'node'), t = touched.get(o.id) || { vi: false, en: false, syncs: false };
        if (o.lang === undefined && !o.syncs) fail('bad_op', `node.text ${o.id}: lang is required (vi or en)`);
        if (o.lang !== undefined && o.title === undefined && o.body === undefined) fail('bad_op', `node.text ${o.id}: title or body is required with lang`);
        if (o.lang === undefined && (o.title !== undefined || o.body !== undefined)) fail('bad_op', `node.text ${o.id}: text needs lang`);
        if (o.lang) {
          if (o.title !== undefined) n[o.lang].title = o.title;
          if (o.body !== undefined) n[o.lang].body = o.body;
          t[o.lang] = true;
        }
        if (o.syncs) t.syncs = true;
        touched.set(o.id, t);
        break;
      }
      case 'node.set': {
        const n = find(doc.nodes, o.id, 'node'), fields = Object.entries(o.fields || {});
        if (!fields.length) fail('bad_op', `node.set ${o.id}: fields is empty`);
        for (const [k, v] of fields) {
          if (!SETTABLE.has(k)) fail('bad_op', `node.set ${o.id}: field ${k} is not settable`);
          if (v === null && (k === 'kind' || k === 'region')) fail('bad_op', `node.set ${o.id}: ${k} cannot be null`);
          if (v === null) delete n[k]; else n[k] = structuredClone(v);
        }
        break;
      }
      case 'node.add': {
        fresh(doc.nodes, o.node.id, 'node');
        const n = { ...structuredClone(o.node), viAt: c, enAt: c };
        n.syncSha = syncHash(n);
        doc.nodes.push(n);
        break;
      }
      case 'node.remove':
        find(doc.nodes, o.id, 'node');
        doc.nodes = doc.nodes.filter(n => n.id !== o.id);
        doc.edges = doc.edges.filter(e => e.from !== o.id && e.to !== o.id);
        break;
      case 'edge.add': fresh(doc.edges, o.edge.id, 'edge'); doc.edges.push(structuredClone(o.edge)); break;
      case 'edge.remove': find(doc.edges, o.id, 'edge'); doc.edges = doc.edges.filter(e => e.id !== o.id); break;
      case 'edge.set': {
        const e = find(doc.edges, o.id, 'edge');
        if (o.dashed === undefined && o.vi === undefined && o.en === undefined) fail('bad_op', `edge.set ${o.id}: nothing to set`);
        if (o.dashed !== undefined) { if (o.dashed) e.dashed = true; else delete e.dashed; }
        for (const k of ['vi', 'en']) if (o[k] !== undefined) { if (o[k] === '') delete e[k]; else e[k] = o[k]; }
        break;
      }
      case 'region.add': fresh(doc.regions, o.region.id, 'region'); doc.regions.push(structuredClone(o.region)); break;
      case 'region.remove':
        find(doc.regions, o.id, 'region');
        if (doc.nodes.some(n => n.region === o.id)) fail('region_not_empty', `region ${o.id} still holds nodes`);
        doc.regions = doc.regions.filter(r => r.id !== o.id);
        break;
      case 'region.text': {
        const r = find(doc.regions, o.id, 'region');
        if (o.kind === undefined && o.vi === undefined && o.en === undefined && o.viLead === undefined) fail('bad_op', `region.text ${o.id}: nothing to set`);
        for (const k of ['kind', 'vi', 'en', 'viLead']) if (o[k] !== undefined) r[k] = o[k];
        break;
      }
      case 'title.text':
        if (o.title === undefined && o.subtitle === undefined) fail('bad_op', 'title.text: title or subtitle is required');
        if (o.title) doc.title = structuredClone(o.title);
        if (o.subtitle) doc.subtitle = structuredClone(o.subtitle);
        break;
      default: fail('bad_op', `unknown op ${o.op}`);
    }
  }
  for (const [id, t] of touched) {
    const n = doc.nodes.find(x => x.id === id);
    if (!n) continue; // touched, then removed in the same request
    if (t.vi) n.viAt = c;
    if (t.en) n.enAt = c;
    if (t.syncs || (t.vi && t.en)) { n.viAt = c; n.enAt = c; n.syncSha = syncHash(n); }
  }
  doc.stamp = stampHash(doc);
  return doc;
}

/** Stale nodes: VI and EN out of sync (stamps differ, or the text no longer matches its sync hash). */
export const staleIds = doc => doc.nodes.filter(n => n.viAt !== n.enAt || n.syncSha !== syncHash(n)).map(n => n.id);
/** The side of a stale node that is older: the language CoS may re-write on a pinned diagram (contract 3.2). Null when in sync. */
export function staleSide(n) {
  if (n.viAt < n.enAt) return 'vi';
  if (n.enAt < n.viAt) return 'en';
  return null;
}

const boxesOverlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (a, b) => a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;
export const HARD_LINT = new Set(['duplicate-id', 'unknown-region', 'dangling-edge', 'self-edge', 'stamp-ahead', 'hand-edit']);

/**
 * The server lint (contract 2.5): `errors` are the hard faults (refused), `warnings` the soft ones (returned, never refused).
 * The worksystem MAP build keeps its own full lint (check.mjs), which fails on every finding.
 */
export function lint(doc) {
  const errors = [], warnings = [];
  const add = (code, msg) => (HARD_LINT.has(code) ? errors : warnings).push({ code, msg });
  const ids = (list, what) => { const s = new Set(); for (const x of list) { if (s.has(x.id)) add('duplicate-id', `${what} ${x.id}`); s.add(x.id); } return s; };
  const regionIds = ids(doc.regions, 'region'), nodeIds = ids(doc.nodes, 'node');
  ids(doc.edges, 'edge');
  const regions = new Map(doc.regions.map(r => [r.id, r]));
  const canvas = { x: 0, y: 0, w: doc.canvas.w, h: doc.canvas.h };
  for (const r of doc.regions) if (!inside(r, canvas)) add('outside-canvas', `region ${r.id}`);
  for (const n of doc.nodes) {
    if (!regionIds.has(n.region)) add('unknown-region', `node ${n.id} -> ${n.region}`);
    else if (!inside(n, regions.get(n.region))) add('outside-region', `node ${n.id} not inside ${n.region}`);
    if (n.viAt > doc.contentRev || n.enAt > doc.contentRev) add('stamp-ahead', `node ${n.id} stamped after contentRev`);
    if (n.viAt !== n.enAt || n.syncSha !== syncHash(n)) add('stale-vi-en', `node ${n.id}: vi@${n.viAt} en@${n.enAt}`);
    if (n.core && n.cos) add('core-and-cos', `node ${n.id}`);
  }
  if (doc.stamp !== stampHash(doc)) add('hand-edit', `document stamp ${doc.stamp} does not match its content (${stampHash(doc)})`);
  for (let i = 0; i < doc.nodes.length; i++)
    for (let j = i + 1; j < doc.nodes.length; j++)
      if (boxesOverlap(doc.nodes[i], doc.nodes[j])) add('node-overlap', `${doc.nodes[i].id} / ${doc.nodes[j].id}`);
  for (const e of doc.edges) {
    if (!nodeIds.has(e.from) || !nodeIds.has(e.to)) add('dangling-edge', `edge ${e.id}: ${e.from} -> ${e.to}`);
    if (e.from === e.to) add('self-edge', `edge ${e.id}`);
  }
  return { errors, warnings };
}

/** Ids of `before` that are absent from `after`: { nodes, edges, regions } (the bulk counter, contract 3.4). */
export function removedIds(before, after) {
  const gone = (a, b) => { const keep = new Set(b.map(x => x.id)); return a.filter(x => !keep.has(x.id)).map(x => x.id); };
  return { nodes: gone(before.nodes, after.nodes), edges: gone(before.edges, after.edges), regions: gone(before.regions, after.regions) };
}
/** Node ids whose content (anything but layout) differs between two revisions, added ones included. */
export function changedIds(before, after) {
  const prev = new Map(before.nodes.map(n => [n.id, JSON.stringify(content(n))]));
  return after.nodes.filter(n => prev.get(n.id) !== JSON.stringify(content(n))).map(n => n.id);
}

const UNSOURCED_VI = 'chưa có nguồn';
/**
 * Agent export (contract 5.1): a board header, the P4 body (no layout, no tracks), then open owner comments and open proposals.
 * `head` = { rev, contentRev, sha256, pinned: {at}|null }, `comments` = [{node_id, id, text}], `proposals` = [{id, by, base_rev, summary, why}].
 */
export function exportMarkdown(doc, { rev, contentRev, sha256: hash, pinned }, comments = [], proposals = []) {
  const L = [`# Diagram ${doc.task} — ${doc.title.en}`,
    `rev ${rev} · contentRev ${contentRev} · ${pinned ? `source of truth, pinned by owner ${pinned.at}` : 'agent draft'} · sha256 ${hash}`, ''];
  for (const r of doc.regions) {
    L.push(`## Region ${r.id} — ${r.en}`, '');
    for (const n of doc.nodes.filter(x => x.region === r.id)) {
      const flags = [n.core && 'core', n.state && n.state !== 'live' && n.state, n.src === UNSOURCED_VI && 'unsourced'].filter(Boolean);
      L.push(`### ${n.id} — ${n.en.title}${flags.length ? `  [${flags.join(', ')}]` : ''}`, n.en.body);
      if (n.enforcedBy) L.push(`enforced by: ${n.enforcedBy}`);
      if (n.src) L.push(`source: ${n.src === UNSOURCED_VI ? 'none found' : n.src}`);
      for (const e of doc.edges.filter(x => x.to === n.id)) L.push(`in:  ${e.from}${e.en ? ` — ${e.en}` : ''}`);
      for (const e of doc.edges.filter(x => x.from === n.id)) L.push(`out: ${e.to}${e.en ? ` — ${e.en}` : ''}`);
      L.push('');
    }
  }
  L.push('## Open owner comments', ...comments.map(c => `- on ${c.node_id} (${c.id}): "${c.text}"`), '');
  L.push('## Open proposals', ...proposals.map(p => `- ${p.id} by ${p.by}, base rev ${p.base_rev}: ${p.summary} — why: ${p.why}`), '');
  return L.join('\n');
}
