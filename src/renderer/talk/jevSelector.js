// Jev reaction variety: one selector over every eligible BODY motion + FACE phrase per label, so the same Jev
// reaction never looks identical twice in a row (T-31 PLAN-variety.md §2.2/§3, owner verbatim: "làm đa dạng lựa
// chọn cách chuyển động khác nhau với 1 loại cảm xúc ... nhưng trước mắt phải phản xạ đúng và nhanh đã").
//
// Pool building (deriving every variant from jevlabels.js's JEV_BODY/JEV_FACE and gating it) runs once per
// rigVersion via warm() and is cached on this instance; pick() after that is array filtering over small
// (<=20-item) in-memory pools plus Math.random -- no gating, no I/O, so it stays far under the 5 ms budget.
import { JEV_LABELS, JEV_BODY, JEV_FACE } from './jevlabels.js';
import { gateJevVariant, deriveVariants, mergeBodyFace } from './jevVariety.js';

const RING = 4; // rule 1: a command hash never repeats within the last 4 reactions, across intents (never relaxed)
const PER_INTENT = 3; // rule 2: per intent, never one of the last min(k-1, 3) used
const FACE_RING = 3; // PLAN §3: a face phrase never repeats within the last 3

// rigCheck?: (command, { flip }) -> { ok } (RigProbe.check-shaped; null = schema-only, used before a model/probe
// exists and by the Node checks, which never load a 3D model). log: (string) -> void.
// One label's schema-gated candidates (cheap: data + the schema gate, no rig).
function schemaEligible(label) {
  const eligible = [];
  const seen = new Set();
  const pushUnique = (entry) => { if (seen.has(entry.id)) return; seen.add(entry.id); eligible.push(entry); };
  for (const base of JEV_BODY[label]) {
    const g = gateJevVariant(base.command);
    if (!g.ok) throw new Error(`jev body ${label}/${base.id} fails its own gate: ${g.errors.join('; ')}`);
    pushUnique({ id: base.id, family: base.family, kind: 'base', side: 1, command: g.command });
    for (const d of deriveVariants({ ...base, command: g.command })) pushUnique(d);
  }
  return eligible;
}
function finishLabel(label, eligible, final, rigVersion, log) {
  if (final.length < 4) log(`pool-thin:${label} (${final.length} eligible of ${eligible.length} schema-gated)`);
  if (!final.length) throw new Error(`jev body pool for "${label}" is empty on rigVersion ${rigVersion}`);
  return final;
}
const rigPasses = (rigCheck, v) => rigCheck(v.command, { flip: v.side === -1 }).ok;
// One label, all at once (the sync path, and a pick on a label the background warm has not reached yet).
function gateLabel(label, rigVersion, rigCheck, log) {
  const eligible = schemaEligible(label);
  return finishLabel(label, eligible, rigCheck ? eligible.filter((v) => rigPasses(rigCheck, v)) : eligible, rigVersion, log);
}

// rigPasses, remembered on the warm job so the background warm and a cold pick never probe the same variant twice.
function jobPasses(job, label, v) {
  const key = `${label}/${v.id}`;
  if (!job.checked.has(key)) job.checked.set(key, rigPasses(job.rigCheck, v));
  return job.checked.get(key);
}

function buildBodyPool(rigVersion, rigCheck, log) {
  const pool = new Map();
  for (const label of JEV_LABELS) pool.set(label, gateLabel(label, rigVersion, rigCheck, log));
  return pool;
}

function buildFacePool(log) {
  const pool = new Map();
  for (const label of JEV_LABELS) {
    const eligible = [];
    for (const phrase of JEV_FACE[label]) {
      const g = gateJevVariant({ id: phrase.id, expressions: phrase.expressions });
      if (!g.ok) throw new Error(`jev face ${label}/${phrase.id} fails its own gate: ${g.errors.join('; ')}`);
      eligible.push({ id: phrase.id, expressions: g.command.expressions });
    }
    if (eligible.length < 3) log(`pool-thin:${label}:face (${eligible.length} of ${JEV_FACE[label].length})`);
    pool.set(label, eligible);
  }
  return pool;
}

export class JevSelector {
  constructor({ random = Math.random, log = () => {} } = {}) {
    this.random = random;
    this.log = log;
    this.rigVersion = null;
    this.bodyPool = null;
    this.warming = null; // a running warmAsync job: { rigVersion, rigCheck, ready: Map label -> pool, promise }
    this.facePool = buildFacePool(log); // face phrases are schema-only data, nothing to rig-gate (expressions only)
    this.globalRing = []; // body variant ids, most recent last, across every label
    this.perIntentLast = new Map(); // label -> [ids], most recent last
    this.faceLast = new Map(); // label -> [ids], most recent last
    this.lastFamily = null;
  }

  // A model switch: forget the previous model's pool, running warm and probe verdicts. Until the new model's probe exists
  // a pick plays only base poses (see pickBody), never a pool gated against the old rig.
  reset() {
    this.rigVersion = null;
    this.bodyPool = null;
    this.warming = null; // a running warm sees this and never installs its pool
  }

  // Idempotent per rigVersion: a repeat call with the same rigVersion is a no-op (the hot-path guarantee).
  warm(rigVersion, rigCheck = null) {
    if (this.rigVersion === rigVersion && this.bodyPool) return;
    this.bodyPool = buildBodyPool(rigVersion, rigCheck, this.log);
    this.rigVersion = rigVersion;
    this.warming = null;
  }

  // The same pools as warm(), built without holding the main thread (0.2.2 RC: on the render box the synchronous warm
  // was one ~27 s task at launch, 193 RigProbe checks of ~145 ms, and the video room and chair waited behind it). One
  // rig check, then `yieldFn()` (the app passes an idle callback). A label is installed as soon as its own checks are
  // done; a pick on a label not reached yet gates that label at once (pickBody), so no derived variant plays un-checked (before any probe exists only base poses play).
  // Idempotent per rigVersion; a newer rigVersion (another model) supersedes a running warm.
  // startGate?: a promise the background loop waits for. The job (so the single-probe pick path) is live at once; only
  // the bulk probing is deferred (the app passes launchSettled), so no pose plays un-checked in the meantime.
  warmAsync(rigVersion, rigCheck, yieldFn, startGate = null) {
    if (this.rigVersion === rigVersion && this.bodyPool) return Promise.resolve();
    if (this.warming && this.warming.rigVersion === rigVersion) return this.warming.promise;
    const job = { rigVersion, rigCheck, ready: new Map(), checked: new Map() }; // checked: `${label}/${id}` -> rig verdict, so no variant is ever probed twice
    this.warming = job;
    job.promise = (async () => {
      if (startGate) { await startGate; if (this.warming !== job) return; }
      for (const label of JEV_LABELS) {
        if (job.ready.has(label)) continue;
        const eligible = schemaEligible(label), final = [];
        for (const v of eligible) {
          const fresh = !job.checked.has(`${label}/${v.id}`); // a cold pick may have probed this one already
          if (!rigCheck || jobPasses(job, label, v)) final.push(v);
          if (rigCheck && fresh) await yieldFn();
          if (this.warming !== job) return; // another model took over
          if (job.ready.has(label)) break; // a pick gated this label meanwhile
        }
        if (!job.ready.has(label)) job.ready.set(label, finishLabel(label, eligible, final, rigVersion, this.log));
      }
      this.bodyPool = job.ready;
      this.rigVersion = rigVersion;
      this.warming = null;
    })();
    return job.promise;
  }

  // Selection rules over a pool. `verify` (cold pick only) rig-checks a candidate right before it is played: a failing one
  // is dropped and the choice repeats, so the first reaction costs ~1 probe (~145 ms), not a whole label (~4.3 s, the
  // cold first-answer freeze).
  pickBody(label) {
    const job = this.warming;
    let pool, verify = null;
    if (job && !job.ready.has(label) && job.rigCheck) { // first use while warming: probe only what is about to play
      pool = schemaEligible(label);
      verify = (v) => jobPasses(job, label, v);
    } else {
      if (job && !job.ready.has(label)) job.ready.set(label, gateLabel(label, job.rigVersion, job.rigCheck, this.log));
      // no probe yet (launch, or a model switch before talk.onModel finishes): base poses only, the seeds that were rig-verified
      // on the default model; derived variants wait for a real gate. Not cached as a pool.
      pool = !job && !this.bodyPool ? schemaEligible(label).filter((v) => v.kind === 'base') : (job ? job.ready : this.bodyPool).get(label) || [];
    }
    const lastIds = this.perIntentLast.get(label) || [];
    const bannedIntent = new Set(lastIds.slice(-Math.min(pool.length - 1, PER_INTENT)));
    let cand, relaxed = null, pick;
    for (;;) {
      cand = pool.filter((v) => !this.globalRing.includes(v.id) && !bannedIntent.has(v.id) && v.family !== this.lastFamily);
      relaxed = null;
      if (!cand.length) { cand = pool.filter((v) => !this.globalRing.includes(v.id) && !bannedIntent.has(v.id)); relaxed = 'family'; }
      if (!cand.length) { cand = pool.filter((v) => !this.globalRing.includes(v.id)); relaxed = 'per-intent'; }
      if (!cand.length) { cand = pool; relaxed = 'ring'; } // last resort: a reaction always plays something
      if (!cand.length) throw new Error(`jev body pool for "${label}" is empty on rigVersion ${job ? job.rigVersion : this.rigVersion}`);
      pick = cand[Math.floor(this.random() * cand.length)];
      if (!verify || verify(pick)) break;
      pool = pool.filter((v) => v !== pick);
    }
    if (relaxed) this.log(`pool-thin:${label} (relaxed ${relaxed}, pool ${pool.length})`);
    this.globalRing.push(pick.id); if (this.globalRing.length > RING) this.globalRing.shift();
    lastIds.push(pick.id); if (lastIds.length > PER_INTENT) lastIds.shift();
    this.perIntentLast.set(label, lastIds);
    this.lastFamily = pick.family;
    return pick;
  }

  pickFace(label) {
    const pool = this.facePool.get(label) || [];
    const lastIds = this.faceLast.get(label) || [];
    const banned = new Set(lastIds.slice(-Math.min(pool.length - 1, FACE_RING)));
    let cand = pool.filter((p) => !banned.has(p.id));
    if (!cand.length) { cand = pool; this.log(`pool-thin:${label}:face (pool ${pool.length})`); }
    const pick = cand[Math.floor(this.random() * cand.length)];
    lastIds.push(pick.id); if (lastIds.length > FACE_RING) lastIds.shift();
    this.faceLast.set(label, lastIds);
    return pick;
  }

  // -> { command, side, bodyId, faceId, family, kind } ready for engine.playCommand (side:-1 needs
  // { ...command, mirror: 'random' } at play time -- the same convention talk/director.js uses for g.flip).
  pick(label) {
    const body = this.pickBody(label);
    const face = this.pickFace(label);
    return { command: mergeBodyFace(body.command, face.expressions), side: body.side, bodyId: body.id, faceId: face.id, family: body.family, kind: body.kind };
  }
}
