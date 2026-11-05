// Node checks for Jev reaction variety (T-31 PLAN-variety.md §2.2/§3, no model, no Electron, no network): pool
// construction (every base + derived body motion and face phrase passes its own gate before it can play), the
// selector's anti-repeat rules (global ring-4 across intents, per-intent memory, motion-family rule, face-phrase
// window-3), per-label distinctness over a fixed-seed 50-reaction run, correctness (a label can only ever surface
// a motion/face from its own allowed families/presets), and pick-time (target <= 5 ms, no gating on the hot path).
import { JEV_LABELS, JEV_BODY, JEV_FACE, FACE_ALLOWED_PRESETS } from '../src/renderer/talk/jevlabels.js';
import { JevSelector } from '../src/renderer/talk/jevSelector.js';
import { GesturePlayer } from '../src/renderer/reflex/player.js';

let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); } };

// Deterministic LCG, never Math.random -- "fixed seed" per the task.
function makeRandom(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 0x100000000);
}

// Coordinator QC on sheet-v1: a viewer does not see "13 eligible variants", they see however many DISTINCT
// FAMILIES are in the pool -- derived (mirror/amp/time/gaze) variants share their base's family and silhouette,
// so only base-motion families count as genuinely different movements. 4 per label, 3 for 'neutral' (coordinator
// explicitly allowed it to "stay subtle").
const minFamilies = (label) => (label === 'neutral' ? 3 : 4);

// ---------- pool construction: every variant is gated, every label clears the minimums ----------
const poolThin = [];
const probe = new JevSelector({ random: makeRandom(1), log: (m) => poolThin.push(m) });
probe.warm('check-variety-rig');
for (const label of JEV_LABELS) {
  const pool = probe.bodyPool.get(label);
  ok(pool.length >= 4, `pool: "${label}" has >= 4 eligible body motions (base + derived)`, String(pool.length));
  const bases = pool.filter((v) => v.kind === 'base').length;
  const derived = pool.length - bases;
  const families = new Set(JEV_BODY[label].map((b) => b.family));
  console.log(`  ${label}: ${bases} base (${[...families].join(', ')}), ${derived} derived, ${pool.length} total`);
  ok(families.size >= minFamilies(label), `pool: "${label}" has >= ${minFamilies(label)} distinct BASE FAMILIES (genuinely different movements, not amp/time copies)`, String(families.size));
  ok(bases === families.size, `pool: "${label}" every base motion has its own family (no two bases share one)`, `${bases} bases, ${families.size} families`);
  const facePool = probe.facePool.get(label);
  ok(facePool.length >= 3, `pool: "${label}" has >= 3 face phrases`, String(facePool.length));
}
ok(poolThin.length === 0, 'pool: no label needed pool-thin relaxation while building (every gate is a real pass, not padding)', JSON.stringify(poolThin));

// ---------- every pool entry, and every merged (body, face) pick, actually PLAYS through the real GesturePlayer ----------
// (reflex/player.js re-validates on every play() -- "the ONE contract every reaction goes through" -- so a
// stored command that merely passed gateJevVariant() once is not proven playable until this also passes; this
// is the exact path that caught jevVariety.js's follow/clip/osc null round-trip bug during development.)
{
  const gp = new GesturePlayer({ now: () => 0, random: () => 0.5 });
  let playFails = 0;
  for (const label of JEV_LABELS) {
    for (const v of probe.bodyPool.get(label)) {
      const res = gp.play(v.side === -1 ? { ...v.command, mirror: 'random' } : v.command, { side: v.side, noJitter: true });
      if (!res.ok) { playFails++; console.log(`  FAIL play ${label}/${v.id}: ${res.errors.join('; ')}`); }
    }
    for (const face of probe.facePool.get(label)) {
      const merged = { ...probe.bodyPool.get(label)[0].command, expressions: face.expressions };
      const res = gp.play(merged, { noJitter: true });
      if (!res.ok) { playFails++; console.log(`  FAIL play ${label}/face:${face.id}: ${res.errors.join('; ')}`); }
    }
  }
  ok(playFails === 0, 'play: every pool entry and merged (body, face) pick re-validates and plays through GesturePlayer', String(playFails));
}
{
  const gp = new GesturePlayer({ now: () => 0, random: () => 0.5 });
  const sel = new JevSelector({ random: makeRandom(3), log: () => {} });
  sel.warm('play-rig');
  let playFails = 0;
  for (let i = 0; i < 200; i++) {
    const label = JEV_LABELS[i % JEV_LABELS.length];
    const p = sel.pick(label);
    const res = gp.play(p.side === -1 ? { ...p.command, mirror: 'random' } : p.command, { side: p.side, noJitter: true });
    if (!res.ok) { playFails++; console.log(`  FAIL play pick ${label}: ${res.errors.join('; ')}`); }
  }
  ok(playFails === 0, 'play: 200 JevSelector.pick() results all play through GesturePlayer (same call app.js makes)', String(playFails));
}

// ---------- correctness: a label can never surface another label's motion family or face preset ----------
// (PLAN-variety.md item 5: "the intent -> motion meaning must stay right, e.g. sad never gets a celebratory
// variant" -- every variant's family must belong to its OWN label's allowed families, never another label's.)
for (const label of JEV_LABELS) {
  const allowedFamilies = new Set(JEV_BODY[label].map((b) => b.family));
  const poolFamilies = new Set(probe.bodyPool.get(label).map((v) => v.family));
  ok([...poolFamilies].every((f) => allowedFamilies.has(f)), `correctness: every "${label}" variant's family is one of its own allowed families`, JSON.stringify({ allowed: [...allowedFamilies], seen: [...poolFamilies] }));
  // no two labels share a family string (so a future bug that mixed pools together would be instantly visible)
  for (const other of JEV_LABELS) if (other !== label) ok(![...allowedFamilies].some((f) => JEV_BODY[other].some((b) => b.family === f)), `correctness: "${label}"'s families never collide with "${other}"'s`);
  for (const phrase of JEV_FACE[label]) {
    for (const e of phrase.expressions) ok(FACE_ALLOWED_PRESETS[label].includes(e.name), `correctness: face "${label}/${phrase.id}" expression "${e.name}" is in FACE_ALLOWED_PRESETS[${label}]`, JSON.stringify(FACE_ALLOWED_PRESETS[label]));
  }
}
// the concrete owner example: concern (sad/worried) must never be able to surface a happy/surprised/celebratory face
ok(!FACE_ALLOWED_PRESETS.concern.some((p) => ['happy', 'surprised'].includes(p)), 'correctness: "concern" can never get a happy/surprised face preset');
ok(!FACE_ALLOWED_PRESETS.happy.some((p) => ['sad'].includes(p)), 'correctness: "happy" can never get a sad face preset');

// ---------- per-intent isolation: 50 reactions of the SAME label, fixed seed ----------
for (const label of JEV_LABELS) {
  const sel = new JevSelector({ random: makeRandom(100), log: () => {} });
  sel.warm('check-variety-rig');
  const bodyIds = [], faceIds = [], families = [];
  let lastBody = null, immediateRepeats = 0;
  const ring = [];
  let ringViolations = 0;
  for (let i = 0; i < 50; i++) {
    const p = sel.pick(label);
    if (p.bodyId === lastBody) immediateRepeats++;
    if (ring.includes(p.bodyId)) ringViolations++;
    ring.push(p.bodyId); if (ring.length > 4) ring.shift();
    lastBody = p.bodyId;
    bodyIds.push(p.bodyId); faceIds.push(p.faceId); families.push(p.family);
  }
  ok(immediateRepeats === 0, `selector: "${label}" x50 -- no immediate repeats`, String(immediateRepeats));
  ok(ringViolations === 0, `selector: "${label}" x50 -- ring-4 respected (no hash repeats within the last 4)`, String(ringViolations));
  ok(new Set(bodyIds).size >= 4, `selector: "${label}" x50 -- >= 4 distinct motions appear`, String(new Set(bodyIds).size));
  ok(new Set(families).size >= minFamilies(label), `selector: "${label}" x50 -- >= ${minFamilies(label)} distinct FAMILIES appear (not just hashes)`, `${new Set(families).size}: ${[...new Set(families)].join(', ')}`);
  ok(new Set(faceIds).size >= 3, `selector: "${label}" x50 -- >= 3 distinct face phrases appear`, String(new Set(faceIds).size));
}

// ---------- mixed-intent: the global ring and family rule hold ACROSS labels (realistic usage) ----------
{
  const random = makeRandom(7);
  const sel = new JevSelector({ random, log: () => {} });
  sel.warm('check-variety-rig');
  const picks = [];
  for (let i = 0; i < 400; i++) picks.push(sel.pick(JEV_LABELS[Math.floor(random() * JEV_LABELS.length)]));
  let ringViol = 0, famViol = 0;
  for (let i = 0; i < picks.length; i++) {
    for (let j = Math.max(0, i - 4); j < i; j++) if (picks[j].bodyId === picks[i].bodyId) ringViol++;
    if (i > 0 && picks[i].family === picks[i - 1].family) famViol++;
  }
  ok(ringViol === 0, 'selector: 400 mixed-intent reactions -- global ring-4 holds across intents', String(ringViol));
  ok(famViol === 0, 'selector: 400 mixed-intent reactions -- never two consecutive from the same motion family', String(famViol));
}

// ---------- rig-gating actually filters the pool (fake RigProbe, since this check loads no model) ----------
{
  const calls = [];
  const rigCheck = (cmd, opts) => { calls.push(opts); return { ok: !(opts && opts.flip) }; }; // reject every mirrored variant
  const sel = new JevSelector({ log: () => {} });
  sel.warm('rig-gate-rig', rigCheck);
  ok(calls.length > 0, 'rig-gate: warm() with a rigCheck calls it for every schema-gated candidate', String(calls.length));
  const anyMirror = JEV_LABELS.some((l) => sel.bodyPool.get(l).some((v) => v.side === -1));
  ok(!anyMirror, 'rig-gate: a rigCheck that fails flip=true removes every mirrored variant from every pool');
  for (const label of JEV_LABELS) ok(sel.bodyPool.get(label).length >= 4, `rig-gate: "${label}" still has >= 4 eligible motions with mirror rig-rejected`, String(sel.bodyPool.get(label).length));
}

// ---------- warmAsync: the same pools, one rig check per slice (0.2.2: the sync warm held the renderer ~27 s at launch) ----------
{
  const rigCheck = (cmd, opts) => ({ ok: !(opts && opts.flip) });
  const ref = new JevSelector({ log: () => {} });
  ref.warm('async-rig', rigCheck);
  const ids = (pool) => JEV_LABELS.map((l) => pool.get(l).map((v) => v.id).join(',')).join('|');
  let checks = 0, yields = 0;
  const counted = (cmd, opts) => { checks++; return rigCheck(cmd, opts); };
  const sel = new JevSelector({ log: () => {} });
  const p = sel.warmAsync('async-rig', counted, () => { yields++; return Promise.resolve(); });
  ok(sel.bodyPool === null && checks <= 1, 'warmAsync: returns before the pool is built (no synchronous bulk work)', `checks ${checks}`);
  ok(sel.warmAsync('async-rig', counted, () => Promise.resolve()) === p, 'warmAsync: a repeat call for the same rigVersion while warming returns the same job');
  await p;
  ok(sel.rigVersion === 'async-rig' && ids(sel.bodyPool) === ids(ref.bodyPool), 'warmAsync: the finished pools equal warm()\'s, label by label');
  ok(yields === checks && checks > 100, 'warmAsync: the main thread is handed back after every rig check', `checks ${checks}, yields ${yields}`);

  // A reaction while warming: the label is gated on demand (same gate, nothing un-checked plays), and not checked twice.
  let c2 = 0; const later = [];
  const sel2 = new JevSelector({ log: () => {} });
  const p2 = sel2.warmAsync('async-rig', (cmd, opts) => { c2++; return rigCheck(cmd, opts); }, () => new Promise((r) => later.push(r)));
  const label = JEV_LABELS[JEV_LABELS.length - 1];
  const picked = sel2.pickBody(label);
  ok(picked.side !== -1 && ref.bodyPool.get(label).some((v) => v.id === picked.id), `warmAsync: a pick on still-pending "${label}" comes from its rig-gated pool (gated on demand)`, picked.id);
  while (later.length) { later.shift()(); await new Promise((r) => setImmediate(r)); }
  await p2;
  ok(c2 === checks, 'warmAsync: the on-demand label is not checked again by the background warm', `checks ${c2} vs ${checks}`);
  ok(ids(sel2.bodyPool) === ids(ref.bodyPool), 'warmAsync: pools after an on-demand pick still equal warm()\'s');

  // Cold first reaction (T-31 first-answer): a pick on a label the warm has not reached must not gate the whole label
  // (~30 RigProbe checks of ~145 ms = the ~4.3 s freeze). It rig-checks only candidates it is about to play.
  {
    let c3 = 0; const slow = (cmd, opts) => { c3++; return rigCheck(cmd, opts); };
    const sel4 = new JevSelector({ random: makeRandom(11), log: () => {} });
    const p4 = sel4.warmAsync('async-rig', slow, () => new Promise(() => {}));
    const first = sel4.pick(JEV_LABELS[0]);
    ok(c3 <= 3, `cold pick: first pick on a pending label runs <= 3 rig checks (was a whole label)`, `checks ${c3}`);
    ok(first.side !== -1 && ref.bodyPool.get(JEV_LABELS[0]).some((v) => v.id === first.bodyId), 'cold pick: the played variant is one the rig gate accepts', first.bodyId);
    void p4;
  }
  // Cold-path safety, deterministic (30 seeds): a rig-failing variant is never played, and the retry is bounded.
  {
    const keyOf = (cmd, flip) => JSON.stringify(cmd) + (flip ? -1 : 1);
    const label = JEV_LABELS[1], gated = ref.bodyPool.get(label), keep = gated[gated.length >> 1];
    const keepKey = keyOf(keep.command, keep.side === -1);
    let poolSize = 0; // every variant failing probes the whole schema pool once, then throws
    const all = new JevSelector({ random: makeRandom(5), log: () => {} });
    all.warmAsync('none-ok', () => { poolSize++; return { ok: false }; }, () => new Promise(() => {}));
    let threw = false; try { all.pickBody(label); } catch (e) { threw = /empty/.test(e.message); }
    let badPlayed = 0, overBudget = 0, maxProbes = 0;
    for (let seed = 1; seed <= 30; seed++) {
      let n = 0; const onlyKeep = (cmd, opts) => { n++; return { ok: keyOf(cmd, opts && opts.flip) === keepKey }; };
      const sel = new JevSelector({ random: makeRandom(seed), log: () => {} });
      sel.warmAsync('only-one', onlyKeep, () => new Promise(() => {}));
      const got = sel.pickBody(label);
      if (got.id !== keep.id) badPlayed++;
      maxProbes = Math.max(maxProbes, n);
      if (n !== sel.warming.checked.size) overBudget++; // never probes a variant twice
    }
    ok(badPlayed === 0, 'cold safety: with every variant but one rig-failing, only that one ever plays (30 seeds)', `bad ${badPlayed}`);
    ok(overBudget === 0 && maxProbes <= poolSize, 'cold safety: retry is bounded by the label schema pool, no variant probed twice', `max ${maxProbes}`);
    ok(threw && poolSize > 1, 'cold safety: every variant failing throws, never plays one', `probed ${poolSize}`);
  }

  // Before the background warm starts (launch not settled), a pick still goes through the single-probe path, not schema-only.
  {
    let c = 0; const probe = (cmd, opts) => { c++; return rigCheck(cmd, opts); };
    let open; const gate = new Promise((r) => { open = r; });
    const selW = new JevSelector({ random: makeRandom(21), log: () => {} });
    const pw = selW.warmAsync('pre-start', probe, () => Promise.resolve(), gate);
    ok(c === 0, 'pre-start: no probe runs before the launch gate opens', `checks ${c}`);
    const got = selW.pick(JEV_LABELS[2]);
    ok(c >= 1 && c <= 3 && got.side !== -1 && ref.bodyPool.get(JEV_LABELS[2]).some((v) => v.id === got.bodyId), 'pre-start: a pick before the gate is rig-checked (single-probe path), not played schema-only', `checks ${c}`);
    open(); await pw;
    ok(selW.rigVersion === 'pre-start' && ids(selW.bodyPool) === ids(ref.bodyPool), 'pre-start: after the gate the warm finishes with the same pools as warm()');
  }

  // Model switch + no-probe window: reset() drops model A's pool, running warm and verdicts; until B's probe exists a
  // pick plays only rig-verified-on-default base poses, never a derived variant.
  {
    const A = new JevSelector({ random: makeRandom(31), log: () => {} });
    A.warm('model-A', rigCheck);
    ok(typeof A.reset === 'function', 'switch: JevSelector.reset() exists');
    A.reset();
    ok(A.bodyPool === null && A.rigVersion === null && A.warming === null, 'switch: reset() drops the previous model pool, version and running warm');
    const kinds = new Set(); for (let i = 0; i < 60; i++) kinds.add(A.pick(JEV_LABELS[i % JEV_LABELS.length]).kind);
    ok(kinds.size === 1 && kinds.has('base'), 'no-probe window: a pick before the rig probe exists returns a base pose only', [...kinds].join(','));
    ok(A.bodyPool === null, 'no-probe window: the base-only fallback is not cached as a model pool');
    // A running warm for model A must not install after the switch; B starts with an empty verdict cache.
    const S = new JevSelector({ random: makeRandom(32), log: () => {} });
    const pa = S.warmAsync('model-A', rigCheck, () => Promise.resolve());
    const jobA = S.warming; S.reset();
    let cB = 0; const pb = S.warmAsync('model-B', (cmd, opts) => { cB++; return rigCheck(cmd, opts); }, () => Promise.resolve());
    await Promise.all([pa, pb]);
    ok(S.rigVersion === 'model-B' && jobA !== S.warming && cB === checks, 'switch: model B re-probes everything, no verdict from A is reused', `B ${cB} vs ${checks}`);
  }

  // A newer model supersedes a running warm: the old job never installs its pool.
  const sel3 = new JevSelector({ log: () => {} });
  const old = sel3.warmAsync('old-rig', rigCheck, () => new Promise((r) => setImmediate(r)));
  const cur = sel3.warmAsync('new-rig', rigCheck, () => Promise.resolve());
  await Promise.all([old, cur]);
  ok(sel3.rigVersion === 'new-rig', 'warmAsync: a newer rigVersion supersedes a running warm (the old one never installs)', sel3.rigVersion);
}

// ---------- pick time: target <= 5 ms, no gating on the hot path after warm-up ----------
{
  const sel = new JevSelector({ log: () => {} });
  sel.warm('timing-rig');
  const times = [];
  for (let i = 0; i < 4000; i++) {
    const label = JEV_LABELS[i % JEV_LABELS.length];
    const t0 = process.hrtime.bigint();
    sel.pick(label);
    const t1 = process.hrtime.bigint();
    times.push(Number(t1 - t0) / 1e6);
  }
  times.sort((a, b) => a - b);
  const p50 = times[Math.floor(times.length * 0.5)];
  const p95 = times[Math.floor(times.length * 0.95)];
  const max = times[times.length - 1];
  console.log(`pick-time over ${times.length} picks: p50 ${p50.toFixed(4)} ms, p95 ${p95.toFixed(4)} ms, max ${max.toFixed(4)} ms`);
  ok(p50 <= 5, 'timing: p50 pick time <= 5 ms', p50.toFixed(4));
  ok(p95 <= 5, 'timing: p95 pick time <= 5 ms', p95.toFixed(4));
}

console.log(`\ncheck:variety ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
