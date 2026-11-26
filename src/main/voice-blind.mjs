// Blind model compare core (T-31-YOKI step 5.1, plan M5). Pure: no file, network, clock or key. The caller injects the
// model call and the message builder, so the same core serves scripts/voice-bench.mjs now and the sidecar handlers
// (voiceLab.blindRun / blindReveal) later, and writes one result shape for both.
//
// Flow:  const run = await blindRun({moments, candidates, seed, buildMessages, callModel, costOf?})
//        run.view()                  -> what the voter may see: per moment the prompt and options labelled A, B, ...
//        run.vote(momentId, 'A'|'tie'|'skip')   (re-voting replaces the earlier vote)
//        run.reveal()                -> the only place model names, latency, cost and lint numbers appear
//
// Seal: the label->candidate key lives in a closure. run, view() and vote() carry no model name, candidate index,
// latency or cost, so neither the object nor anything printed from it before reveal() says which side is which.
// The order of candidates per moment is a seeded shuffle (same seed, same order), different per moment, so the
// position of a model carries no signal.
import { lint } from './voice-lint.mjs';

const LABELS = 'ABCDEFGH';
const NO_ANSWER = '(no answer)';

// 32-bit string hash (FNV-1a) feeding mulberry32; deterministic across Node versions, no Math.random.
const hash32 = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; };
const rng = (seed) => () => { seed = (seed + 0x6d2b79f5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

/** Order of candidate indices for one moment: seeded Fisher-Yates, a pure function of (seed, momentId, n). */
export function shuffleOrder(seed, momentId, n) {
  const next = rng(hash32(`${seed}|${momentId}`));
  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  return order;
}

/**
 * @param {object} p
 * @param {{id: string, message: string, history?: {role: string, text: string}[], kind?: string, lang?: string}[]} p.moments
 * @param {{model: string, temperature?: number}[]} p.candidates  2 to 8
 * @param {string|number} p.seed
 * @param {(moment: object) => object[]} p.buildMessages  the production prompt builder, bound by the caller
 * @param {(messages: object[], candidate: object) => Promise<{ok: boolean, text?: string, ms?: number, usage?: {in: number, out: number}, error?: string}>} p.callModel
 * @param {(model: string, inTok: number, outTok: number) => number|null} [p.costOf]
 */
export async function blindRun({ moments, candidates, seed, buildMessages, callModel, costOf = () => null }) {
  if (!Array.isArray(moments) || !moments.length) throw new Error('blindRun: no moments');
  if (!Array.isArray(candidates) || candidates.length < 2 || candidates.length > LABELS.length) throw new Error(`blindRun: need 2 to ${LABELS.length} candidates`);
  if (new Set(moments.map((m) => m.id)).size !== moments.length) throw new Error('blindRun: moment ids must be unique');
  if (seed === undefined || seed === null || seed === '') throw new Error('blindRun: a seed is required (determinism)');

  // Sequential calls, one at a time: keeps provider rate limits and the stub's order simple.
  const answers = new Map(); // momentId -> candidate index -> {text, ms, usage, ok}
  for (const m of moments) {
    const messages = buildMessages(m);
    const row = [];
    for (const c of candidates) {
      const r = await callModel(messages, c);
      row.push(r && r.ok && typeof r.text === 'string' && r.text ? { ok: true, text: r.text, ms: r.ms ?? null, usage: r.usage || null } : { ok: false, text: NO_ANSWER, ms: r && r.ms != null ? r.ms : null, usage: null });
    }
    answers.set(m.id, row);
  }

  // The key: moment -> labels in presented order -> candidate index. Never leaves this closure before reveal().
  const key = new Map(moments.map((m) => [m.id, shuffleOrder(seed, m.id, candidates.length)]));
  const votes = new Map(); // momentId -> 'A'.. | 'tie' | 'skip'
  const ids = new Set(moments.map((m) => m.id));
  let revealed = null;

  const view = () => ({
    moments: moments.map((m) => ({
      id: m.id,
      message: m.message,
      options: key.get(m.id).map((ci, pos) => ({ label: LABELS[pos], text: answers.get(m.id)[ci].text })),
    })),
    voted: votes.size,
    total: moments.length,
  });

  const vote = (momentId, choice) => {
    if (revealed) throw new Error('vote: already revealed');
    if (!ids.has(momentId)) throw new Error(`vote: unknown moment ${momentId}`);
    const c = typeof choice === 'string' ? choice.trim() : '';
    const lower = c.toLowerCase();
    const norm = lower === 'tie' || lower === 'skip' ? lower : c.toUpperCase();
    if (norm !== 'tie' && norm !== 'skip' && !(norm.length === 1 && LABELS.indexOf(norm) >= 0 && LABELS.indexOf(norm) < candidates.length)) throw new Error(`vote: bad choice ${JSON.stringify(choice)}`);
    votes.set(momentId, norm);
    return { voted: votes.size, remaining: moments.length - votes.size };
  };

  const reveal = () => {
    if (revealed) return revealed;
    if (votes.size < moments.length) throw new Error(`reveal: ${moments.length - votes.size} moment(s) not voted (vote or skip each one)`);
    const stats = candidates.map((c) => ({ model: c.model, temperature: c.temperature ?? null, wins: 0, ties: 0, answered: 0, errors: 0, ms: [], costUsd: 0, costKnown: true, rows: [] }));
    let ties = 0, skips = 0;
    for (const m of moments) {
      const order = key.get(m.id), row = answers.get(m.id);
      order.forEach((ci) => {
        const a = row[ci], s = stats[ci];
        if (!a.ok) { s.errors++; return; }
        s.answered++;
        if (a.ms != null) s.ms.push(a.ms);
        if (a.usage) { const cost = costOf(candidates[ci].model, a.usage.in, a.usage.out); if (cost == null) s.costKnown = false; else s.costUsd += cost; } else s.costKnown = false;
        s.rows.push({ user: m.message, reply: a.text });
      });
      const v = votes.get(m.id);
      if (v === 'skip') skips++;
      else if (v === 'tie') ties++;
      else stats[order[LABELS.indexOf(v)]].wins++;
    }
    const voted = moments.length - skips;
    revealed = {
      seed, moments: moments.length, voted, ties, skips,
      candidates: stats.map((s) => ({
        model: s.model, temperature: s.temperature, wins: s.wins, ties, score: s.wins + ties / candidates.length,
        answered: s.answered, errors: s.errors,
        avgMs: s.ms.length ? Math.round(s.ms.reduce((a, b) => a + b, 0) / s.ms.length) : null,
        costUsd: s.costKnown ? +s.costUsd.toFixed(6) : null,
        lintFlags: Object.fromEntries(lint(s.rows).flags.map((f) => [f.code, f.count])),
      })),
      // Winner only when strictly ahead on wins; a tie at the top is reported as null, never picked at random.
      winner: (() => { const top = Math.max(...stats.map((s) => s.wins)); const lead = stats.filter((s) => s.wins === top); return top > 0 && lead.length === 1 ? lead[0].model : null; })(),
      key: moments.map((m) => ({ id: m.id, order: key.get(m.id).map((ci, pos) => ({ label: LABELS[pos], model: candidates[ci].model })) })),
    };
    return revealed;
  };

  return Object.freeze({ view, vote, reveal });
}
