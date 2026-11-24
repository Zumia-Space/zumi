// W-42 5A diagrams: a side store beside the journal (contract sections 2, 3, 4, 5.1; rev 3 section 3.7).
//   <data>/diagrams.ndjson  append-only side log, one line per accepted diagram write (schema/v1/diagram/revision.json)
//   <data>/media/<sha256>   one blob per distinct revision (content-addressed, re-hashed on every read)
// Never in the journal or state.json: an older release ignores both files and starts (rollback row 3), and the in-memory
// projection here (pointers, proposals, request index, retired ids, used evidence, anchors, counters) is rebuilt from the
// side log on start, never from state.json. The write path is one synchronous section: no await between read and append.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BoardError } from './ops.mjs';
import { applyOps, lint, serialize, stampHash, staleIds, staleSide, removedIds, changedIds, exportMarkdown, DiagramOpError, REMOVE_OPS } from './diagram/core.mjs';

export const DIAGRAM_LIMITS = { docBytes: 524288, logBytes: 64 * 1024 * 1024, blobBytes: 256 * 1024 * 1024, writesPerMin: 30, openProposals: 20, bulkNodes: 10, bulkEdges: 20, windowMs: 24 * 3600000, anchorReserve: 1024 };
const DIAGRAM_OPS = ['diagram.create', 'diagram.apply', 'diagram.propose', 'diagram.decide', 'diagram.pin', 'diagram.restore', 'diagram.archive'];
const NODE_COMMENT_KINDS = new Set(['note', 'reply', 'receipt']);
const EVIDENCE_A_KINDS = new Set(['note', 'approve', 'choice', 'redirect']);
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
const canonical = v => Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',')}}` : JSON.stringify(v);
const lintCode = c => c.replace(/-/g, '_');
const blocked = (what, why, todo) => `BLOCKED ${what} / WHY ${why} / DO ${todo}`;
const fbSeq = id => Number(/^fb-([0-9]+)$/.exec(id || '')?.[1] ?? NaN);

/**
 * @param {object} ctx  board internals: dataDir, now, schemas, validate, state() (the journal projection), authenticate(secret),
 *   inScope(actor, task), ownerUi(actor) -> 'proxy'|'device'|'ui'|false, ownerDeviceOf(actor, cookie) -> 'dv-N'|null, twofa,
 *   journalActor(actor) (the journaled shape), pointerWrite({actor, task, request_id, note, block}) (internal feedback.add),
 *   readJournal() (every journal event), limits (tests only)
 */
export function openDiagrams(ctx) {
  const L = { ...DIAGRAM_LIMITS, ...(ctx.limits || {}) };
  const logPath = path.join(ctx.dataDir, 'diagrams.ndjson');
  const mediaDir = path.join(ctx.dataDir, 'media');
  fs.mkdirSync(mediaDir, { recursive: true });
  const RULES = Object.fromEntries(DIAGRAM_OPS.map(op => {
    const s = ctx.schemas.get(`diagram/${op.slice('diagram.'.length)}.json`);
    if (!s) throw new Error(`missing schema diagram/${op}`);
    return [op, { roles: s['x-roles'], revision: s['x-revision'], ownerOnly: s['x-owner-only'] }];
  }));

  // ---------- side log and projection ----------
  let raw = '';
  try { raw = fs.readFileSync(logPath, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (raw && !raw.endsWith('\n')) { // torn last line (crash mid-write): cut, as the journal's
    const keep = raw.lastIndexOf('\n') + 1;
    fs.truncateSync(logPath, Buffer.byteLength(raw.slice(0, keep)));
    raw = raw.slice(0, keep);
  }
  let logBytes = Buffer.byteLength(raw);
  const P = { seq: 0, diagrams: new Map(), proposals: new Map(), requests: new Map(), anchors: new Map(), blocks: new Map(), blobs: new Map(), lines: [] };
  const fd = fs.openSync(logPath, 'a');

  function project(line) {
    P.lines.push(line);
    P.seq = Math.max(P.seq, Number(line.id.slice(3)));
    if (line.request_id && line.op !== 'feedback.anchor') P.requests.set(line.request_id, { body_sha256: line.body_sha256, line });
    if (line.sha256 && line.bytes) P.blobs.set(line.sha256, line.bytes);
    if (line.op === 'feedback.anchor') { P.anchors.set(line.feedback_id, { diagram_id: line.diagram_id, node_id: line.node_id, anchor_rev: line.anchor_rev }); return; }
    let D = P.diagrams.get(line.diagram_id);
    if (line.op === 'diagram.create') {
      D = { id: line.diagram_id, task: line.task, task_created_at: line.task_created_at, create_seq: line.journal_seq, archived: false, revs: new Map(), retired: new Set(), used: new Set(),
        pinned: null, owner_at: null, owner_seq: line.journal_seq, removals: [], content_rev: 0 };
      P.diagrams.set(D.id, D);
    }
    if (!D) return;
    const owner = line.actor.role === 'owner';
    if (line.rev) {
      const contentBumped = line.content_rev > D.content_rev;
      Object.assign(D, { rev: line.rev, content_rev: line.content_rev, sha256: line.sha256, bytes: line.bytes, nodes: line.counts?.nodes ?? D.nodes, edges: line.counts?.edges ?? D.edges, regions: line.counts?.regions ?? D.regions, stale: line.stale ?? D.stale, updated_at: line.at, updated_by: line.actor });
      D.revs.set(line.rev, line.sha256);
      for (const id of line.removed_ids || []) D.retired.add(id);
      if (owner && contentBumped) D.blocks = true, P.blocks.set(`diagram-${D.id}-r${line.rev}`, { rev: line.rev, content_rev: line.content_rev, sha256: line.sha256, changed_ids: line.changed_ids || [], removed_ids: line.removed_ids || [] });
    }
    if (line.evidence && line.op !== 'diagram.propose') D.used.add(line.evidence);
    if (owner) { D.owner_at = line.at; D.owner_seq = line.journal_seq; }
    if (line.pinned === true) D.pinned = { by: line.actor, at: line.at, rev: line.rev || D.rev };
    if (line.pinned === false) D.pinned = null;
    // The removal window (3.4, gate MF-A): removals by every line made without an owner device (coordinator, Basic login,
    // un-stepped device/ui token, a class-B accept whose ask was not answered from an owner device). An owner-device line clears it.
    if (line.actor.owner_device || line.answer_owner_device) D.removals = [];
    else if (line.rev && (line.removed_nodes || line.removed_edges)) D.removals.push({ t: Date.parse(line.at), nodes: line.removed_nodes || 0, edges: line.removed_edges || 0 });
    if (line.op === 'diagram.archive') D.archived = true;
    if (line.op === 'diagram.propose') {
      P.proposals.set(line.proposal_id, { id: line.proposal_id, task: line.task, diagram_id: D.id, base_rev: line.base_rev, ...(line.ops ? { ops: line.ops } : {}), ...(line.to_rev ? { restore_to: line.to_rev } : {}),
        why: line.note, ...(line.evidence ? { ask_id: line.evidence } : {}), removes: { nodes: line.removed_nodes || 0, edges: line.removed_edges || 0 }, state: 'open', by: line.actor, at: line.at });
    }
    if (line.op === 'diagram.decide') {
      const pr = P.proposals.get(line.proposal_id);
      if (pr) { pr.state = line.decision === 'accept' ? 'accepted' : 'rejected'; pr.decided = { by: line.actor, at: line.at, ...(line.rev ? { rev: line.rev } : {}), ...(line.note ? { note: line.note } : {}), ...(line.evidence ? { evidence: line.evidence } : {}) }; }
    }
  }
  for (const [i, l] of raw.split('\n').filter(Boolean).entries()) {
    try { project(JSON.parse(l)); } catch (e) { throw new Error(`diagrams.ndjson line ${i + 1} unreadable; refusing to start: ${e.message}`); }
  }
  const blobBytes = () => { let n = 0; for (const b of P.blobs.values()) n += b; return n; };

  const logFull = () => new BoardError(507, 'diagram_log_full', { max_bytes: L.logBytes, message: blocked('diagram write', 'the diagram side log is at its cap', 'archive old diagrams or raise the cap') });
  /**
   * `force`: a line that records something already true (a journaled comment's anchor, a start-reconcile line) is written past the
   * cap with a warning, never refused: refusing it would lose the anchor or stop the board from starting (gate MF-B).
   */
  function append(fields, { force = false } = {}) {
    const line = { id: `dw-${P.seq + 1}`, at: new Date(ctx.now()).toISOString(), ...fields };
    const text = JSON.stringify(line) + '\n';
    if (logBytes + Buffer.byteLength(text) > L.logBytes) {
      if (!force) throw logFull();
      console.warn(`diagram side log over its cap (${logBytes} of ${L.logBytes} bytes): ${line.op} ${line.id} written anyway; archive old diagrams or raise the cap`);
    }
    fs.writeSync(fd, text); fs.fsyncSync(fd);
    logBytes += Buffer.byteLength(text);
    project(line);
    return line;
  }
  const blobFile = h => path.join(mediaDir, h);
  /** Bytes of a blob, re-hashed on every read: a blob edited on disk is 500 blob_corrupt, never served (rule 2.5.3). */
  function readBlob(h) {
    let bytes;
    try { bytes = fs.readFileSync(blobFile(h)); } catch { throw new BoardError(500, 'blob_corrupt', { sha256: h, message: blocked('diagram read', 'the revision blob is missing', 'restore the data dir from a backup') }); }
    if (sha256(bytes) !== h) throw new BoardError(500, 'blob_corrupt', { sha256: h, message: blocked('diagram read', 'the revision blob no longer hashes to its address', 'restore an earlier revision (restore reads only that blob)') });
    return bytes;
  }
  const readDoc = h => JSON.parse(readBlob(h).toString('utf8'));
  /** Writes a blob temp-then-rename; an existing address is re-hashed and rewritten on mismatch (gate S5). */
  function writeBlob(h, bytes) {
    const f = blobFile(h);
    if (fs.existsSync(f) && sha256(fs.readFileSync(f)) === h) return;
    fs.writeFileSync(f + '.tmp', bytes); fs.renameSync(f + '.tmp', f);
  }

  // ---------- attachment, pointer, reads ----------
  /** The task's attached diagram (contract 2.1 M2): created for this task row (same created_at) and not archived. */
  function attached(taskId) {
    const t = ctx.state().tasks[taskId];
    if (!t) return null;
    for (const D of P.diagrams.values()) if (D.task === taskId && !D.archived && D.task_created_at === t.attribution?.created_at) return D;
    return null;
  }
  function unreviewed(taskId) {
    const ids = Object.values(ctx.state().feedback).filter(f => f.task_id === taskId && f.kind === 'diagram' && !f.received).map(f => f.id).sort((a, b) => fbSeq(a) - fbSeq(b));
    return { unreviewed: ids.slice(0, 50), unreviewed_count: ids.length };
  }
  function pointer(D) {
    const open = [...P.proposals.values()].filter(p => p.diagram_id === D.id && p.state === 'open').length;
    return { diagram_id: D.id, rev: D.rev, content_rev: D.content_rev, sha256: D.sha256, bytes: D.bytes, nodes: D.nodes, edges: D.edges, regions: D.regions, updated_at: D.updated_at, updated_by: D.updated_by,
      ...(D.owner_at ? { owner_at: D.owner_at } : {}), owner_seq: D.owner_seq, pinned: D.pinned, coord_removed: removedInWindow(D), open_proposals: open, stale: D.stale || 0, ...unreviewed(D.task) };
  }
  const message = f => ({ id: f.id, kind: f.kind, text: f.text || '', by: { role: f.attribution.created_by.role, name: f.attribution.created_by.name }, at: f.attribution.created_at, status: f.status === 'open' ? 'open' : 'resolved', received: !!f.received });
  function threads(D, doc) {
    const fb = ctx.state().feedback, nodeIds = new Set(doc.nodes.map(n => n.id));
    const rootOf = f => { let x = f, hops = 0; while (x?.reply_to && fb[x.reply_to] && hops++ < 50) x = fb[x.reply_to]; return x; };
    const byRoot = new Map();
    // A root is an anchored message whose reply chain reaches no other anchored message (a coordinator reply that also names the node
    // threads under the owner's comment, it does not open a thread of its own).
    const anchoredHere = id => P.anchors.get(id)?.diagram_id === D.id && !!fb[id];
    const anchoredAncestor = f => { let x = f, hops = 0; while (x?.reply_to && fb[x.reply_to] && hops++ < 50) { x = fb[x.reply_to]; if (anchoredHere(x.id)) return true; } return false; };
    for (const [id, a] of P.anchors) if (anchoredHere(id) && !anchoredAncestor(fb[id])) byRoot.set(id, { node_id: a.node_id, root: message(fb[id]), replies: [] });
    for (const f of Object.values(fb)) {
      if (!f.reply_to || byRoot.has(f.id)) continue;
      const r = rootOf(f);
      if (r && byRoot.has(r.id)) byRoot.get(r.id).replies.push(message(f));
    }
    const all = [...byRoot.values()].sort((a, b) => fbSeq(b.root.id) - fbSeq(a.root.id));
    for (const t of all) t.replies.sort((a, b) => fbSeq(a.id) - fbSeq(b.id));
    return { comments: all.filter(t => nodeIds.has(t.node_id)), removed_comments: all.filter(t => !nodeIds.has(t.node_id)) };
  }
  const openProposals = D => [...P.proposals.values()].filter(p => p.diagram_id === D.id && p.state === 'open');

  function reader(secret, taskId) {
    const actor = ctx.authenticate(secret);
    if (!actor) throw new BoardError(401, 'unauthorized');
    if (!ctx.inScope(actor, taskId)) throw new BoardError(403, 'out_of_scope', { task_id: taskId });
    return actor;
  }
  function pick(actor, taskId, diagramId) {
    if (diagramId) {
      if (!['owner', 'coordinator'].includes(actor.role)) throw new BoardError(403, 'forbidden_for_role', { role: actor.role, allowed: ['owner', 'coordinator'] });
      const D = P.diagrams.get(diagramId);
      if (!D || D.task !== taskId) throw new BoardError(404, 'no_diagram', { task: taskId, diagram_id: diagramId });
      return D;
    }
    const D = attached(taskId);
    if (!D) throw new BoardError(404, 'no_diagram', { task: taskId, message: blocked('diagram read', `task ${taskId} has no diagram`, 'create one with cos-board diagram create') });
    return D;
  }
  /** GET /api/v1/diagram/:task: { type, body } where body is the view JSON or the Markdown export. */
  function view(secret, taskId, { rev, format, diagramId } = {}) {
    const actor = reader(secret, taskId), D = pick(actor, taskId, diagramId);
    let h = D.sha256;
    if (rev !== undefined && rev !== null && rev !== '') { h = D.revs.get(Number(rev)); if (!h) throw new BoardError(404, 'rev_not_found', { rev: Number(rev), current_revision: D.rev }); }
    const doc = readDoc(h), th = threads(D, doc), proposals = openProposals(D), ptr = pointer(D);
    if (format === 'md') {
      const fb = ctx.state().feedback;
      const owner = th.comments.filter(t => t.root.by.role === 'owner' && t.root.status === 'open').map(t => ({ node_id: t.node_id, id: t.root.id, text: fb[t.root.id]?.text || '' }));
      const props = proposals.map(p => ({ id: p.id, by: p.by.name, base_rev: p.base_rev, why: p.why, summary: p.restore_to ? `restore to rev ${p.restore_to}` : p.ops.map(o => `${o.op} ${o.id || o.node?.id || o.edge?.id || o.region?.id || ''}`.trim()).slice(0, 8).join(', ') }));
      return { type: 'text/markdown; charset=utf-8', body: exportMarkdown(doc, { rev: doc.rev, contentRev: doc.contentRev, sha256: h, pinned: ptr.pinned }, owner, props), immutable: h !== D.sha256 };
    }
    return { type: 'application/json; charset=utf-8', body: JSON.stringify({ format: 'diagram-view/1', task: taskId, pointer: ptr, document: doc, ...th, proposals }), immutable: h !== D.sha256 };
  }
  function history(secret, taskId, { before = '', limit = 50, ops = false, diagramId } = {}) {
    const actor = reader(secret, taskId);
    if (!['owner', 'coordinator'].includes(actor.role)) throw new BoardError(403, 'forbidden_for_role', { role: actor.role, allowed: ['owner', 'coordinator'] });
    const D = pick(actor, taskId, diagramId), n = Math.min(Math.max(Number(limit) || 50, 1), 200), cut = before ? Number(before.slice(3)) : Infinity;
    const lines = P.lines.filter(l => l.diagram_id === D.id && l.op !== 'feedback.anchor' && Number(l.id.slice(3)) < cut).reverse().slice(0, n).map(l => (ops ? l : (({ ops: _o, ...rest }) => rest)(l)));
    return { task: taskId, diagram_id: D.id, lines, next_before: lines.length === n ? lines.at(-1).id : null };
  }

  // ---------- the write path ----------
  const hits = new Map();
  function limitWrites(actor) {
    const t = ctx.now(), h = (hits.get(actor.token_id) || []).filter(x => t - x < 60000);
    if (h.length >= L.writesPerMin) { hits.set(actor.token_id, h); throw new BoardError(429, 'rate_limited', { limit_per_minute: L.writesPerMin, retry_after_s: Math.ceil((h[0] + 60000 - t) / 1000) }); }
    h.push(t); hits.set(actor.token_id, h);
  }
  const isBulk = r => r.nodes > L.bulkNodes || r.edges > L.bulkEdges;
  /** Removals without an owner device in the last 24 h (since the latest owner-device line): the window every such write meets. */
  function removedInWindow(D) {
    const since = ctx.now() - L.windowMs, sum = { nodes: 0, edges: 0 };
    for (const x of D.removals) if (x.t > since) { sum.nodes += x.nodes; sum.edges += x.edges; }
    return sum;
  }
  /**
   * MF-A: a write made without an owner device that removes `r` must stay inside the window (10 nodes, 20 edges). Over it, the owner
   * needs an owner device (403, or 503 owner_2fa_off while 2FA is off) and the coordinator a proposal answered from one (409).
   */
  function checkWindow(D, r, actor, dev, body) {
    if (dev || (!r.nodes && !r.edges)) return;
    const w = removedInWindow(D);
    if (w.nodes + r.nodes <= L.bulkNodes && w.edges + r.edges <= L.bulkEdges) return;
    if (actor.role === 'owner') needDevice(actor, null, body.op, body.target_id);
    throw new BoardError(409, 'needs_owner_act', { removes: r, coord_removed: w, message: blocked('diagram write', `this would pass the removal limit for writes without an owner device (${L.bulkNodes} nodes, ${L.bulkEdges} edges in 24 h)`, 'diagram.propose with a bound ask the owner answers from an owner device (after the 2FA release), or wait for the window') });
  }
  const countOf = r => ({ nodes: r.nodes.length, edges: r.edges.length });
  function needDevice(actor, dev, op, target) {
    if (dev) return;
    if (!ctx.twofa.configured) ctx.twofa.needKey();
    ctx.twofa.audit({ event: 'owner_only_refused', ok: false, op, target, reason: 'no_owner_device' });
    throw new BoardError(403, 'owner_device_required', { op, message: blocked(`${op} on ${target}`, 'this is an owner-only act (pin, archive, restore, bulk removal, device revoke) and this browser or app has not confirmed the owner code', 'enter the 6-digit code from the authenticator app once on this device, then retry') });
  }
  function pinnedError(D) { return new BoardError(409, 'diagram_pinned', { pinned: D.pinned, message: blocked('diagram write', 'the owner pinned this diagram as his source of truth', 'use diagram.propose (cos-board diagram propose), or pass an owner note as --evidence for a non-removing edit') }); }
  /** 3.2: every op is upkeep (re-write the stale language with syncs, or bookkeeping fields). */
  function upkeepOnly(doc, ops) {
    return ops.every(o => {
      if (o.op === 'node.set') { const k = Object.keys(o.fields || {}); return k.length > 0 && k.every(x => x === 'verified' || x === 'tracks'); }
      if (o.op === 'node.text') { const n = doc.nodes.find(x => x.id === o.id); return !!n && o.syncs === true && !!o.lang && o.lang === staleSide(n) && (o.title !== undefined || o.body !== undefined); }
      return false;
    });
  }
  /** Class A (3.3): an owner note fb-N backs a non-removing coordinator apply. */
  function evidenceA(D, target, ev, ops, bulk) {
    const st = ctx.state(), F = st.feedback[ev], n = fbSeq(ev);
    const bad = why => new BoardError(400, 'evidence_invalid', { evidence: ev, message: blocked('evidence', why, 'cite a note the owner wrote from the board page or the app after his latest act on this diagram') });
    if (!F || F.task_id !== target) throw bad('the note is not on this task');
    if (!EVIDENCE_A_KINDS.has(F.kind)) throw bad(`kind ${F.kind} is not an owner note`);
    if (F.attribution.created_by.role !== 'owner' || !ctx.ownerUi(F.attribution.created_by)) throw bad('the note was not written by the owner from an owner UI');
    if (!(n > D.owner_seq)) throw bad('the note is older than the owner\'s latest act on this diagram');
    if (D.used.has(ev)) throw new BoardError(409, 'evidence_used', { evidence: ev });
    if (bulk || ops.some(o => REMOVE_OPS.has(o.op))) throw new BoardError(409, 'evidence_too_weak', { evidence: ev, message: blocked('diagram write', 'an owner note backs only add, text, set and layout ops', 'diagram.propose with a bound ask (cos-board diagram propose --ask)') });
  }
  /** Class B (3.3 clauses 1-9): the coordinator decides a proposal only with its own bound ask, answered by the owner. */
  function evidenceB(D, target, Pr, ev, decision) {
    const st = ctx.state();
    const bad = why => new BoardError(400, 'evidence_invalid', { evidence: ev, message: blocked('evidence', why, 'have the owner answer the proposal\'s own ask from the board page or the app') });
    if (!Pr.ask_id || ev !== Pr.ask_id) throw new BoardError(409, 'evidence_too_weak', { evidence: ev, message: blocked('diagram decide', 'only the proposal\'s own bound ask decides it', 'propose with --ask, then cite that ask') });
    const A = st.asks[ev];
    if (!A || A.task_id !== target) throw bad('the ask is not on this task');
    if (A.status !== 'answered' || !A.answer) throw bad('the ask is not answered');
    const F = A.answer.feedback_id ? st.feedback[A.answer.feedback_id] : Object.values(st.feedback).filter(f => f.ask_id === A.id).sort((a, b) => fbSeq(b.id) - fbSeq(a.id))[0];
    if (!F || (F.scope_ask_id !== A.id && F.ask_id !== A.id)) throw bad('the ask was swept by an unscoped verdict, not answered on its own');
    const by = A.answer.by;
    if (by?.role !== 'owner' || !ctx.ownerUi(by)) throw bad('the answer did not come from the owner UI');
    if (by.relay) throw bad('a Zumi relay answer never counts as an owner approval');
    if (F.kind !== (decision === 'accept' ? 'approve' : 'reject')) throw bad(`the answer is ${F.kind}, not ${decision === 'accept' ? 'approve' : 'reject'}`);
    if (D.used.has(ev)) throw new BoardError(409, 'evidence_used', { evidence: ev });
    return by.owner_device || null;
  }
  /** A whole-document restore of `old` as the revision after `cur`: content as old, rev +1, contentRev +1 only if content changed. */
  function restoredDoc(cur, old) {
    const next = { ...structuredClone(old), rev: cur.rev + 1, contentRev: cur.contentRev, task: cur.task };
    next.stamp = stampHash(next);
    const same = stampHash({ ...cur, contentRev: cur.contentRev }) === next.stamp;
    if (!same) { next.contentRev = cur.contentRev + 1; next.stamp = stampHash(next); }
    return next;
  }
  function checkResult(doc) {
    const errs = ctx.validate(ctx.schemas, 'diagram/document.json', doc);
    if (errs.length) throw new BoardError(400, 'invalid_data', { errors: errs.slice(0, 20) });
    const { errors, warnings } = lint(doc);
    if (errors.length) { const e = errors[0]; throw new BoardError(e.code === 'hand-edit' ? 400 : 400, lintCode(e.code), { errors, message: blocked('diagram write', e.msg, 'fix the ops; nothing was written') }); }
    const bytes = Buffer.from(serialize(doc));
    if (bytes.length > L.docBytes) throw new BoardError(413, 'diagram_too_large', { bytes: bytes.length, max_bytes: L.docBytes });
    const h = sha256(bytes);
    if (!P.blobs.has(h) && blobBytes() + bytes.length > L.blobBytes) throw new BoardError(507, 'diagram_blobs_full', { max_bytes: L.blobBytes });
    return { bytes, h, warnings };
  }
  const opsApply = (doc, ops, D) => { try { return applyOps(doc, ops, { retired: D.retired }); } catch (e) { if (e instanceof DiagramOpError) throw new BoardError(e.status, e.code, { detail: e.detail }); throw e; } };

  /**
   * POST /api/v1/diagram. `opts.ownerDeviceCookie` is the server's raw lb_owner_dev cookie; `opts.crashAfterSideLine` is a test hook
   * (a crash after the side-log fsync, before the pointer message is journaled).
   */
  function write(secret, body, { ownerDeviceCookie = '', crashAfterSideLine = false } = {}) {
    const actor = ctx.authenticate(secret);
    if (!actor) throw new BoardError(401, 'unauthorized');
    const env = ctx.validate(ctx.schemas, 'diagram/request.json', body);
    if (env.length) throw new BoardError(400, 'invalid_request', { errors: env });
    const rule = RULES[body.op];
    const bodyHash = sha256(actor.token_id + '\n' + canonical({ op: body.op, target_id: body.target_id, expected_revision: body.expected_revision ?? null, data: body.data, origin: body.origin ?? null }));
    const seen = P.requests.get(body.request_id);
    if (seen) {
      if (seen.body_sha256 !== bodyHash) throw new BoardError(409, 'request_id_reused');
      return { ok: true, deduped: true, ...resultOf(seen.line) };
    }
    limitWrites(actor);
    // Role, owner UI and scope before data is read (3.5 check 1): a refused caller learns nothing from validation.
    if (!rule.roles.includes(actor.role)) throw new BoardError(403, 'forbidden_for_role', { role: actor.role, allowed: rule.roles });
    const ui = actor.role === 'owner' ? ctx.ownerUi(actor) : false;
    if (actor.role === 'owner' && !ui) throw new BoardError(403, 'owner_ui_only', { message: blocked('owner write', 'owner diagram acts come only from the owner UI', 'open the Diagram app or the board page') });
    if (!ctx.inScope(actor, body.target_id)) throw new BoardError(403, 'out_of_scope', { task_id: body.target_id });
    const dataErr = ctx.validate(ctx.schemas, `diagram/${body.op.slice(8)}.json`, body.data);
    if (dataErr.length) throw new BoardError(400, 'invalid_data', { errors: dataErr.slice(0, 20) });
    const st = ctx.state(), task = st.tasks[body.target_id];
    if (!task) throw new BoardError(404, 'task_not_found', { task: body.target_id });
    const dev = actor.role === 'owner' ? ctx.ownerDeviceOf(actor, ownerDeviceCookie) : null;
    const jActor = ctx.journalActor({ ...actor, ...(dev ? { owner_device: dev } : {}) }, body);
    const base = { task: body.target_id, request_id: body.request_id, body_sha256: bodyHash, actor: jActor, ...(ui ? { actor_ui: ui } : {}), journal_seq: st.seq };
    const d = body.data;
    if (body.op === 'diagram.create') return create(body, d, task, base, actor, crashAfterSideLine);
    const D = attached(body.target_id);
    if (!D) throw new BoardError(404, 'no_diagram', { task: body.target_id });
    if (rule.revision === 'required') {
      if (body.expected_revision === undefined) throw new BoardError(400, 'revision_required', { current_revision: D.rev });
      if (body.expected_revision !== D.rev) throw new BoardError(409, 'revision_conflict', { current_revision: D.rev });
    }
    const owner = actor.role === 'owner', coord = actor.role === 'coordinator';
    const audit = extra => ctx.twofa.audit({ event: 'owner_only', ok: true, op: body.op, target: body.target_id, device_id: dev, ...extra });

    if (body.op === 'diagram.pin') {
      needDevice(actor, dev, body.op, body.target_id);
      const line = append({ ...base, diagram_id: D.id, op: body.op, pinned: d.pinned, ...(d.note ? { note: d.note } : {}) });
      audit({ pinned: d.pinned });
      return { ok: true, ...resultOf(line) };
    }
    if (body.op === 'diagram.archive') {
      needDevice(actor, dev, body.op, body.target_id);
      if (d.confirm !== `${body.target_id}@r${D.rev}`) throw new BoardError(400, 'confirm_mismatch', { expected: `${body.target_id}@r${D.rev}` });
      const line = append({ ...base, diagram_id: D.id, op: body.op, note: d.note });
      audit({});
      return { ok: true, archived: D.id, ...resultOf(line) };
    }
    if (body.op === 'diagram.restore') {
      needDevice(actor, dev, body.op, body.target_id);
      const h = D.revs.get(d.to_rev);
      if (!h) throw new BoardError(404, 'rev_not_found', { rev: d.to_rev });
      const old = readDoc(h); // S5: only the to_rev blob is read
      const curMeta = { rev: D.rev, contentRev: D.content_rev, task: D.task };
      const cur = D.sha256 === h ? old : (() => { try { return readDoc(D.sha256); } catch { return null; } })();
      const next = cur ? restoredDoc(cur, old) : (n => (n.stamp = stampHash(n), n))({ ...structuredClone(old), rev: curMeta.rev + 1, contentRev: curMeta.contentRev + 1 });
      return commitRevision(D, cur || old, next, base, { op: body.op, note: d.note, to_rev: d.to_rev }, actor, dev, crashAfterSideLine, () => audit({ to_rev: d.to_rev }));
    }
    const cur = readDoc(D.sha256);
    if (body.op === 'diagram.apply') {
      const next = opsApply(cur, d.ops, D);
      const rem = removedIds(cur, next), r = countOf(rem);
      if (coord) {
        if (d.evidence) evidenceA(D, body.target_id, d.evidence, d.ops, isBulk(r));
        else if (D.pinned && !upkeepOnly(cur, d.ops)) throw pinnedError(D);
      }
      checkWindow(D, r, actor, dev, body);
      const pinNow = owner && dev && !D.pinned;
      return commitRevision(D, cur, next, base, { op: body.op, ops: d.ops, note: d.note, ...(d.evidence ? { evidence: d.evidence } : {}), ...(pinNow ? { pinned: true } : {}) }, actor, dev, crashAfterSideLine, owner && isBulk(r) ? () => audit({ removes: r }) : null);
    }
    if (body.op === 'diagram.propose') {
      if (openProposals(D).length >= L.openProposals) throw new BoardError(429, 'too_many_proposals', { max: L.openProposals });
      let target;
      if (d.restore_to) { const h = D.revs.get(d.restore_to); if (!h) throw new BoardError(404, 'rev_not_found', { rev: d.restore_to }); target = restoredDoc(cur, readDoc(h)); }
      else { try { target = applyOps(cur, d.ops, { retired: D.retired }); } catch (e) { if (e instanceof DiagramOpError) throw new BoardError(400, 'proposal_invalid', { code: e.code, detail: e.detail }); throw e; } }
      if (d.ask_id) {
        const A = st.asks[d.ask_id];
        if (!A || A.task_id !== body.target_id) throw new BoardError(404, 'ask_not_found', { ask_id: d.ask_id });
        if (A.status !== 'open') throw new BoardError(409, 'ask_not_open', { ask_id: d.ask_id });
        const holder = openProposals(D).find(p => p.ask_id === d.ask_id);
        if (holder) throw new BoardError(409, 'ask_bound', { proposal_id: holder.id });
      }
      const r = countOf(removedIds(cur, target));
      const id = `dp-${P.seq + 1}`;
      const line = append({ ...base, diagram_id: D.id, op: body.op, proposal_id: id, base_rev: D.rev, ...(d.ops ? { ops: d.ops } : {}), ...(d.restore_to ? { to_rev: d.restore_to } : {}), note: d.why, ...(d.ask_id ? { evidence: d.ask_id } : {}), removed_nodes: r.nodes, removed_edges: r.edges });
      return { ok: true, proposal_id: id, removes: r, ...resultOf(line) };
    }
    if (body.op === 'diagram.decide') {
      const Pr = P.proposals.get(d.proposal_id);
      if (!Pr || Pr.diagram_id !== D.id) throw new BoardError(404, 'proposal_not_found', { proposal_id: d.proposal_id });
      if (Pr.state !== 'open') throw new BoardError(409, 'proposal_closed', { proposal_id: Pr.id, state: Pr.state });
      if (coord && !d.evidence) throw new BoardError(403, 'owner_or_evidence', { message: blocked('diagram decide', 'only the owner, or the proposal\'s bound ask answered by the owner, decides a proposal', 'cite the bound ask with --evidence') });
      const answerDev = coord ? evidenceB(D, body.target_id, Pr, d.evidence, d.decision) : null;
      const extra = { op: body.op, proposal_id: Pr.id, decision: d.decision, ...(d.note ? { note: d.note } : {}), ...(coord ? { evidence: d.evidence } : {}) };
      if (d.decision === 'reject') { const line = append({ ...base, diagram_id: D.id, ...extra }); return { ok: true, ...resultOf(line) }; }
      const next = acceptedDoc(D, cur, Pr);
      // Gate MF-A (A4): bulk is judged on what this accept removes now, not on the proposal's count at propose time.
      const r = countOf(removedIds(cur, next)), ownerOnlyAccept = !!Pr.restore_to || isBulk(r);
      if (owner && ownerOnlyAccept) needDevice(actor, dev, body.op, body.target_id);
      if (coord && ownerOnlyAccept && !answerDev) throw new BoardError(409, 'owner_device_required', { evidence: d.evidence, message: blocked('diagram decide', 'a bulk removal or a restore needs the owner\'s answer from an owner device', 'ask the owner to answer from a browser or phone where he entered the owner code') });
      checkWindow(D, r, actor, dev || answerDev, body);
      return commitRevision(D, cur, next, base, { ...extra, ...(answerDev ? { answer_owner_device: answerDev } : {}) }, actor, dev, crashAfterSideLine, owner && ownerOnlyAccept ? () => audit({ proposal_id: Pr.id, removes: r }) : null);
    }
    throw new BoardError(400, 'unknown_op');
  }
  /** The document a proposal's accept would make on top of `cur`; a proposal that no longer applies is 409 proposal_stale. */
  function acceptedDoc(D, cur, Pr) {
    let next;
    if (Pr.restore_to) next = restoredDoc(cur, readDoc(D.revs.get(Pr.restore_to)));
    else {
      try { next = applyOps(cur, Pr.ops, { retired: D.retired }); } catch (e) {
        if (!(e instanceof DiagramOpError)) throw e;
        const failed = Pr.ops.map((o, i) => { try { applyOps(cur, [o], { retired: D.retired }); return -1; } catch { return i; } }).filter(i => i >= 0);
        throw new BoardError(409, 'proposal_stale', { failed_ops: failed.length ? failed : [0], message: blocked('diagram decide', 'the proposal no longer applies to the current revision', 'propose again on the current revision') });
      }
    }
    return next;
  }
  function create(body, d, task, base, actor, crash) {
    if (attached(body.target_id)) throw new BoardError(409, 'diagram_exists', { task: body.target_id, message: blocked('diagram create', 'this task already has a diagram', 'change it with diagram.apply') });
    if (body.expected_revision) throw new BoardError(409, 'revision_conflict', { current_revision: 0 });
    const doc = d.document;
    if (doc.task !== body.target_id) throw new BoardError(400, 'task_mismatch', { document_task: doc.task, target_id: body.target_id });
    if (doc.stamp !== stampHash(doc)) throw new BoardError(400, 'hand_edit', { message: blocked('diagram create', 'the document stamp does not match its content: a field was edited by hand', 'revert the hand edit, then make the change with ops') });
    const { bytes, h, warnings } = checkResult(doc);
    writeBlob(h, bytes);
    const id = `dg-${P.seq + 1}`;
    const line = append({ ...base, diagram_id: id, task_created_at: task.attribution.created_at, op: 'diagram.create', base_rev: 0, rev: doc.rev, content_rev: doc.contentRev, sha256: h, bytes: bytes.length,
      note: d.note, counts: undefined, changed_ids: doc.nodes.map(n => n.id), ...meta(doc) });
    afterRevision(P.diagrams.get(id), line, actor, crash);
    return { ok: true, diagram_id: id, ...resultOf(line), warnings: warnings.map(w => w.code) };
  }
  const meta = doc => ({ counts: { nodes: doc.nodes.length, edges: doc.edges.length, regions: doc.regions.length }, stale: staleIds(doc).length });
  function commitRevision(D, cur, next, base, extra, actor, dev, crash, onDone) {
    const { bytes, h, warnings } = checkResult(next);
    const rem = removedIds(cur, next), ids = [...rem.nodes, ...rem.edges, ...rem.regions];
    writeBlob(h, bytes);
    const line = append({ ...base, diagram_id: D.id, base_rev: D.rev, ...extra, rev: next.rev, content_rev: next.contentRev, sha256: h, bytes: bytes.length,
      ...(ids.length ? { removed_ids: ids } : {}), removed_nodes: rem.nodes.length, removed_edges: rem.edges.length, changed_ids: changedIds(cur, next), ...meta(next) });
    if (onDone) onDone();
    afterRevision(D, line, actor, crash);
    return { ok: true, ...resultOf(line), stale_ids: staleIds(next), warnings: warnings.map(w => w.code) };
  }
  /** Step 6: an owner revision that bumped contentRev writes the pointer message (section 4), through an internal board write. */
  function afterRevision(D, line, actor, crash) {
    if (crash) throw new Error('simulated crash after the side-log fsync');
    if (line.actor.role === 'owner' && P.blocks.has(`diagram-${D.id}-r${line.rev}`)) pointerMessage(D, line);
  }
  function pointerMessage(D, line) {
    const rid = `diagram-${D.id}-r${line.rev}`;
    if (ctx.state().requests[rid]) return;
    ctx.pointerWrite({ actor: line.actor, task: line.task, request_id: rid, note: line.note || `rev ${line.rev}`, block: P.blocks.get(rid) });
  }
  function resultOf(line) {
    const D = P.diagrams.get(line.diagram_id);
    return { diagram_id: line.diagram_id, rev: D?.rev, content_rev: D?.content_rev, sha256: D?.sha256, bytes: D?.bytes, pinned: D?.pinned ?? null, stale: D?.stale ?? 0, line_id: line.id };
  }

  // ---------- comments (feedback.add with node_id) ----------
  /** Checks a feedback.add's node_id before the op runs (1.3, rev 3). Returns the diagram it anchors on, or null. */
  function checkNodeComment(actor, body) {
    const d = body.data || {};
    if (!d.node_id) return null;
    if (actor.role === 'reporter') throw new BoardError(403, 'forbidden_for_role', { role: actor.role, message: blocked('node comment', 'lanes do not comment on diagram nodes', 'report through your inbox') });
    if (actor.role === 'owner' && !ctx.ownerUi(actor)) throw new BoardError(403, 'owner_ui_only', { message: blocked('node comment', 'an owner node comment comes from the board page or the app', 'comment from the Diagram tab') });
    if (!NODE_COMMENT_KINDS.has(d.kind) || d.ask_id) throw new BoardError(400, 'node_id_kind', { kind: d.kind, message: blocked('node comment', 'a node comment answers no ask: kinds note, reply, receipt only, never with ask_id', 'send the verdict on the ask itself, without node_id') });
    const D = attached(body.target_id);
    if (!D) throw new BoardError(404, 'no_diagram', { task: body.target_id });
    if (!readDoc(D.sha256).nodes.some(n => n.id === d.node_id)) throw new BoardError(404, 'node_not_found', { node_id: d.node_id });
    if (logBytes + L.anchorReserve > L.logBytes) throw logFull(); // MF-B: refused before the journal append, so nothing is written
    return D;
  }
  function anchor(D, ev) {
    if (P.anchors.has(ev.result.id)) return;
    append({ task: ev.target_id, diagram_id: D.id, op: 'feedback.anchor', request_id: ev.request_id, body_sha256: ev.body_sha256, actor: ev.actor, journal_seq: ev.seq, feedback_id: ev.result.id, node_id: ev.data.node_id, anchor_rev: D.rev }, { force: true });
  }

  // ---------- start reconcile (2.2, both directions) ----------
  function reconcile() {
    for (const D of P.diagrams.values()) { // pointer messages whose side line landed but whose journal write did not
      for (const l of P.lines) if (l.diagram_id === D.id && l.rev && l.actor.role === 'owner' && P.blocks.has(`diagram-${D.id}-r${l.rev}`)) pointerMessage(D, l);
    }
    const st = ctx.state();
    for (const D of P.diagrams.values()) { // detached by a task deleted or re-created (also on an older release): one audit line
      const t = st.tasks[D.task];
      if (!D.archived && (!t || t.attribution?.created_at !== D.task_created_at)) append({ task: D.task, diagram_id: D.id, op: 'diagram.archive', request_id: `system-detach-${D.id}`, body_sha256: sha256(D.id), actor: { token_id: 'system', name: 'system', role: 'coordinator' }, journal_seq: st.seq, note: 'task gone' }, { force: true });
    }
    let events = null;
    for (const ev of (events ??= ctx.readJournal())) { // anchors whose journal append landed but whose side line did not (M3)
      if (ev.op !== 'feedback.add' || !ev.data?.node_id || P.anchors.has(ev.result.id)) continue;
      const D = [...P.diagrams.values()].filter(x => x.task === ev.target_id && x.create_seq <= ev.seq).at(-1);
      if (!D) continue;
      const revAt = P.lines.filter(l => l.diagram_id === D.id && l.rev && l.journal_seq <= ev.seq).at(-1)?.rev ?? D.rev;
      append({ task: ev.target_id, diagram_id: D.id, op: 'feedback.anchor', request_id: ev.request_id, body_sha256: ev.body_sha256, actor: ev.actor, journal_seq: ev.seq, feedback_id: ev.result.id, node_id: ev.data.node_id, anchor_rev: revAt }, { force: true });
    }
  }

  return {
    write, view, history, attached, pointer, checkNodeComment, anchor, reconcile,
    anchorOf: fbId => P.anchors.get(fbId) || null,
    blockOf: requestId => P.blocks.get(requestId) || null,
    stats: () => ({ log_bytes: logBytes, blob_bytes: blobBytes(), diagrams: P.diagrams.size }),
    close() { fs.closeSync(fd); }
  };
}
