// The product-structure diagram of a task (J-05, anh 24-10): what the PRODUCT is made of -- its features/modules, the user
// flow, its integrations (MCP, APIs) -- as opposed to the task's plan steps. Stored on the task as `architecture`:
//   { format: 'graph', groups: [{ id, label }], nodes: [{ id, label, sub?, group? }], edges: [{ from, to, label?, dashed? }] }
// Plain data, not Mermaid (measured 24-10): Mermaid is ~120 MB unpacked on npm (~3 MB as one bundle), writes inline <style> and
// style="" the board's CSP (`style-src 'self'; script-src 'self'`) refuses, and takes its text as source to parse. A node/edge
// spec is validated here once and drawn by the page as escaped SVG text only (public/diagram.js lays it out, app.js draws it).
// Pure: no I/O. The CoS CLI keeps a verbatim copy (cos-board's architecture.mjs, same sha, checked by its test).

export const ARCH_FORMAT = 'graph';
export const ARCH_LIMITS = Object.freeze({ groups: 8, nodes: 40, edges: 80, label: 60, sub: 100, edgeLabel: 40, bytes: 12000 });
const ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
// C0, DEL, C1 and the Unicode line/paragraph separators: a label is one line of text.
const CONTROL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const KEYS = { root: ['format', 'groups', 'nodes', 'edges'], group: ['id', 'label'], node: ['id', 'label', 'sub', 'group'], edge: ['from', 'to', 'label', 'dashed'] };

/** Errors for one text field: '' when fine. Text only: no markup characters, no control character, a length cap. */
function textError(at, v, max, { required = false } = {}) {
  if (typeof v !== 'string') return `${at} must be a string`;
  const s = v.trim();
  if (required && !s) return `${at} must not be empty`;
  if ([...s].length > max) return `${at} is longer than ${max} chars`;
  if (CONTROL.test(v)) return `${at} must be one line of text (no control character)`;
  if (/[<>]/.test(v)) return `${at} must be plain text (no < or >)`;
  return '';
}

function unknownKeys(at, o, allowed) {
  return Object.keys(o).filter(k => !allowed.includes(k)).map(k => `${at}: unknown key "${k}"`);
}

/**
 * All the problems of an architecture value, as strings; [] means valid. Never throws. The value is JSON read from a row
 * or a request, so it can be anything: every type is checked before it is used.
 */
export function validateArchitecture(a) {
  const errors = [];
  if (!isObj(a)) return ['architecture must be an object'];
  errors.push(...unknownKeys('architecture', a, KEYS.root));
  if (a.format === 'mermaid') errors.push('architecture.format "mermaid" is not supported: use "graph" (groups, nodes, edges)');
  else if (a.format !== ARCH_FORMAT) errors.push(`architecture.format must be "${ARCH_FORMAT}"`);
  let bytes = 0;
  try { bytes = Buffer.byteLength(JSON.stringify(a)); } catch { errors.push('architecture is not plain JSON'); }
  if (bytes > ARCH_LIMITS.bytes) errors.push(`architecture is larger than ${ARCH_LIMITS.bytes} bytes`);

  const groups = a.groups === undefined ? [] : a.groups, nodes = a.nodes, edges = a.edges === undefined ? [] : a.edges;
  if (!Array.isArray(groups)) errors.push('architecture.groups must be an array');
  if (!Array.isArray(nodes)) errors.push('architecture.nodes must be an array');
  if (!Array.isArray(edges)) errors.push('architecture.edges must be an array');
  if (errors.length) return errors;
  if (groups.length > ARCH_LIMITS.groups) errors.push(`architecture.groups has more than ${ARCH_LIMITS.groups} items`);
  if (!nodes.length) errors.push('architecture.nodes needs at least one node');
  if (nodes.length > ARCH_LIMITS.nodes) errors.push(`architecture.nodes has more than ${ARCH_LIMITS.nodes} items`);
  if (edges.length > ARCH_LIMITS.edges) errors.push(`architecture.edges has more than ${ARCH_LIMITS.edges} items`);
  if (errors.length) return errors; // do not walk an oversized value

  const groupIds = new Set(), nodeIds = new Set();
  groups.forEach((g, i) => {
    const at = `groups[${i}]`;
    if (!isObj(g)) return errors.push(`${at} must be an object`);
    errors.push(...unknownKeys(at, g, KEYS.group));
    if (typeof g.id !== 'string' || !ID.test(g.id)) errors.push(`${at}.id must match ${ID}`);
    else if (groupIds.has(g.id)) errors.push(`${at}.id "${g.id}" is used twice`);
    else groupIds.add(g.id);
    const e = textError(`${at}.label`, g.label, ARCH_LIMITS.label, { required: true });
    if (e) errors.push(e);
  });
  nodes.forEach((n, i) => {
    const at = `nodes[${i}]`;
    if (!isObj(n)) return errors.push(`${at} must be an object`);
    errors.push(...unknownKeys(at, n, KEYS.node));
    if (typeof n.id !== 'string' || !ID.test(n.id)) errors.push(`${at}.id must match ${ID}`);
    else if (nodeIds.has(n.id)) errors.push(`${at}.id "${n.id}" is used twice`);
    else nodeIds.add(n.id);
    const e = textError(`${at}.label`, n.label, ARCH_LIMITS.label, { required: true });
    if (e) errors.push(e);
    if (n.sub !== undefined) { const s = textError(`${at}.sub`, n.sub, ARCH_LIMITS.sub); if (s) errors.push(s); }
    if (n.group !== undefined && (typeof n.group !== 'string' || !groupIds.has(n.group))) errors.push(`${at}.group "${String(n.group).slice(0, 40)}" is not a declared group`);
  });
  edges.forEach((x, i) => {
    const at = `edges[${i}]`;
    if (!isObj(x)) return errors.push(`${at} must be an object`);
    errors.push(...unknownKeys(at, x, KEYS.edge));
    for (const end of ['from', 'to']) if (typeof x[end] !== 'string' || !nodeIds.has(x[end])) errors.push(`${at}.${end} "${String(x[end]).slice(0, 40)}" is not a node id`);
    if (x.from === x.to && typeof x.from === 'string') errors.push(`${at} joins a node to itself`);
    if (x.label !== undefined) { const s = textError(`${at}.label`, x.label, ARCH_LIMITS.edgeLabel); if (s) errors.push(s); }
    if (x.dashed !== undefined && typeof x.dashed !== 'boolean') errors.push(`${at}.dashed must be true or false`);
  });
  return errors;
}

/** The value a row carries -> what the board stores: validated, labels trimmed, same shape. Throws nothing; returns { ok, value|errors }. */
export function normalizeArchitecture(a) {
  const errors = validateArchitecture(a);
  if (errors.length) return { ok: false, errors };
  const t = s => s.trim();
  const value = { format: ARCH_FORMAT };
  if (a.groups?.length) value.groups = a.groups.map(g => ({ id: g.id, label: t(g.label) }));
  value.nodes = a.nodes.map(n => ({ id: n.id, label: t(n.label), ...(n.sub !== undefined && t(n.sub) ? { sub: t(n.sub) } : {}), ...(n.group !== undefined ? { group: n.group } : {}) }));
  if (a.edges?.length) value.edges = a.edges.map(e => ({ from: e.from, to: e.to, ...(e.label !== undefined && t(e.label) ? { label: t(e.label) } : {}), ...(e.dashed ? { dashed: true } : {}) }));
  return { ok: true, value };
}
