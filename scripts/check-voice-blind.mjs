// check:voice-blind (T-31-YOKI step 5.1). Plain Node, no network, no model call, no key: the model is a stub.
//   1. fixture: 12 moments, EN and VI, at least 10 kinds, unique ids;
//   2. sealed: before reveal, the run object, view(), vote() results and the CLI's blind output name no model,
//      latency or cost; reveal() before every moment is voted refuses; votes after reveal refuse;
//   3. shuffle: same seed gives the same order, another seed another order, position carries no signal
//      (neither side is always first), and the order does not come from the candidate list order alone;
//   4. tally: votes cast by reading the options' TEXT (never the key) give the expected wins, ties, skips;
//      a re-vote replaces the earlier one; an unanswered call counts as an error and never as a win;
//   5. three candidates, reveal result shape, cost unknown stays null, winner null on a tie at the top.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { blindRun, shuffleOrder } from '../src/main/voice-blind.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { moments } = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'fixtures', 'voice-blind', 'moments.json'), 'utf8'));
let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); } };
const throws = (fn, re = null) => { try { fn(); return false; } catch (e) { return re ? re.test(e.message) : true; } };

// Stub model: the reply text carries a neutral code Qn (n = 1 for the first candidate) that the test, not the core, maps
// back to a model. Latency and usage are fixed per candidate. `failOn` makes one (model, moment) pair fail.
const MODELS = ['model-red/x1', 'model-green/x2', 'model-blue/x3'];
const stub = (failOn = null) => async (messages, c) => {
  const n = MODELS.indexOf(c.model) + 1;
  const last = String(messages[messages.length - 1].content);
  if (failOn && failOn.model === c.model && last === failOn.message) return { ok: false, error: 'upstream', ms: 7 };
  return { ok: true, text: `Q${n} answer to "${last}"`, ms: 100 * n, usage: { in: 50, out: 10 * n } };
};
const build = (m) => [{ role: 'system', content: 'sys' }, ...(m.history || []).map((h) => ({ role: h.role, content: h.text })), { role: 'user', content: m.message }];
const costOf = (model, i, o) => (model === MODELS[2] ? null : (i + o) / 1000); // blue is unpriced
const start = (candidates, seed, failOn) => blindRun({ moments, candidates: candidates.map((model) => ({ model })), seed, buildMessages: build, callModel: stub(failOn), costOf });
const codeOf = (text) => Number(/^Q(\d)/.exec(text)[1]);
// vote for the option that carries code `want` in every moment listed in `ids`
const voteFor = (run, want, ids) => { for (const m of run.view().moments) if (ids.includes(m.id)) run.vote(m.id, m.options.find((o) => codeOf(o.text) === want).label); };
const ids = moments.map((m) => m.id);

// 1. fixture
const kinds = new Set(moments.map((m) => m.kind)), langs = new Set(moments.map((m) => m.lang));
ok(moments.length === 12 && new Set(ids).size === 12, 'fixture: 12 moments with unique ids');
ok(langs.has('en') && langs.has('vi') && moments.filter((m) => m.lang === 'vi').length >= 5 && moments.filter((m) => m.lang === 'en').length >= 5, 'fixture: at least 5 moments each in EN and VI');
ok(kinds.size >= 10 && ['greeting', 'thanks', 'bad news', 'joke', 'are you an AI', 'how-to', 'one-word reply', 'venting', 'language switch', 'repeated question'].every((k) => kinds.has(k)), 'fixture: the 10 kinds of plan M5 are all present');

// 2. sealed
const run = await start(MODELS.slice(0, 2), 42);
const NAMES = /model-red|model-green|model-blue|x1|x2|x3/i;
const before = JSON.stringify(run) + JSON.stringify(run.view()) + JSON.stringify(run.vote(ids[0], 'A'));
ok(!NAMES.test(before), 'sealed: run object, view() and vote() result carry no model name');
ok(!/"ms"|latency|costUsd|usage|temperature|"key"|"order"|candidate/i.test(before), 'sealed: no latency, cost, usage, key or candidate field before reveal');
ok(Object.keys(run).sort().join() === 'reveal,view,vote' && Object.isFrozen(run), 'sealed: the run exposes only view, vote, reveal and is frozen');
ok(run.view().moments.every((m) => m.options.every((o) => /^[AB]$/.test(o.label)) && Object.keys(m).sort().join() === 'id,message,options'), 'sealed: options are plain labels A and B');
ok(throws(() => run.reveal(), /not voted/), 'sealed: reveal refuses while moments are unvoted (its own message, not a crash)');
ok(throws(() => run.vote('nope', 'A')) && throws(() => run.vote(ids[1], 'C')) && throws(() => run.vote(ids[1], '')), 'vote: unknown moment, label out of range and empty choice are refused');
ok(run.vote(ids[1], 'skip').voted === 2, 'vote: skip counts as voted');
for (const id of ids.slice(2)) run.vote(id, 'tie');
const rev = run.reveal();
ok(rev.key.length === 12 && rev.candidates.every((c) => NAMES.test(c.model)), 'reveal: the key and the names appear only now');
ok(throws(() => run.vote(ids[0], 'B')), 'vote: refused after reveal');
ok(run.reveal() === rev, 'reveal: asking twice gives the same result');

// CLI: nothing before "=== REVEAL ===" names a model, latency or cost
const cli = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'voice-bench.mjs'), '--models', 'zz-secret/alpha,yy-secret/beta', '--seed', '9', '--votes', 'A,B,tie,skip,A,A,B,B,A,tie,B,A'], { encoding: 'utf8', timeout: 60000 });
const [blindPart, revealPart = ''] = String(cli.stdout).split('=== REVEAL ===');
ok(cli.status === 0 && revealPart.length > 0, 'cli: runs offline and prints a reveal section', `${cli.status} ${String(cli.stderr).slice(0, 200)}`);
ok(!/secret|alpha|beta|\bms\b|cost|\bUSD\b/i.test(blindPart) && /\[greeting-en\]/.test(blindPart) && /\bA: /.test(blindPart), 'cli: the output before reveal names no model, latency or cost');
ok(/zz-secret\/alpha/.test(revealPart) && /yy-secret\/beta/.test(revealPart), 'cli: names appear after reveal');

// 3. shuffle
const orderOf = async (seed) => { const r = await start(MODELS.slice(0, 2), seed); for (const id of ids) r.vote(id, 'A'); return r.reveal().key.map((k) => k.order.map((o) => o.model).join('>')).join('|'); };
const [o1, o1b, o2] = [await orderOf(5), await orderOf(5), await orderOf(6)];
ok(o1 === o1b, 'shuffle: the same seed gives the same order');
ok(o1 !== o2, 'shuffle: another seed gives another order');
ok(JSON.stringify(shuffleOrder(5, 'greeting-en', 4)) === JSON.stringify(shuffleOrder(5, 'greeting-en', 4)) && [...shuffleOrder(5, 'x', 6)].sort().join() === '0,1,2,3,4,5', 'shuffle: pure and a true permutation');
let firstA = 0, total = 0;
for (let seed = 1; seed <= 40; seed++) for (const id of ids) { total++; if (shuffleOrder(seed, id, 2)[0] === 0) firstA++; }
ok(firstA / total > 0.4 && firstA / total < 0.6, `shuffle: position carries no signal (first candidate on top ${(100 * firstA / total).toFixed(1)}% of ${total})`);
ok(new Set(ids.map((id) => shuffleOrder(5, id, 2)[0])).size === 2, 'shuffle: within one run neither side is always first');

// 4. tally (votes read from the text, expected counts known to the test alone)
const t = await start(MODELS.slice(0, 2), 11);
voteFor(t, 1, ids.slice(0, 5));                // model 1 wins 5
voteFor(t, 2, ids.slice(5, 8));                // model 2 wins 3
for (const id of ids.slice(8, 10)) t.vote(id, 'tie');   // 2 ties
for (const id of ids.slice(10)) t.vote(id, 'skip');     // 2 skips
const tr = t.reveal();
const [c1, c2] = tr.candidates;
ok(c1.model === MODELS[0] && c1.wins === 5 && c2.wins === 3 && tr.ties === 2 && tr.skips === 2 && tr.voted === 10, 'tally: wins 5 and 3, 2 ties, 2 skips, 10 voted', JSON.stringify([c1.wins, c2.wins, tr.ties, tr.skips, tr.voted]));
ok(c1.score === 6 && c2.score === 4, 'tally: a tie is worth 1/2 to each of two candidates', `${c1.score} ${c2.score}`);
ok(tr.winner === MODELS[0], 'tally: the winner is the one strictly ahead');
ok(c1.avgMs === 100 && c2.avgMs === 200 && c1.costUsd === 12 * 0.06 && c2.costUsd === +(12 * 0.07).toFixed(6), 'tally: average latency and cost per candidate', JSON.stringify([c1.avgMs, c2.avgMs, c1.costUsd, c2.costUsd]));
const re = await start(MODELS.slice(0, 2), 11);
voteFor(re, 2, ids); voteFor(re, 1, ids.slice(0, 4)); // re-vote 4 moments
const rr = re.reveal();
ok(rr.candidates[0].wins === 4 && rr.candidates[1].wins === 8, 'tally: a re-vote replaces the earlier vote', JSON.stringify(rr.candidates.map((c) => c.wins)));
const tie = await start(MODELS.slice(0, 2), 3);
voteFor(tie, 1, ids.slice(0, 6)); voteFor(tie, 2, ids.slice(6));
ok(tie.reveal().winner === null && tie.reveal().candidates[0].wins === 6, 'tally: a tie at the top gives no winner (never a random pick)');
const none = await start(MODELS.slice(0, 2), 3);
for (const id of ids) none.vote(id, 'skip');
ok(none.reveal().winner === null && none.reveal().voted === 0 && none.reveal().candidates.every((c) => c.wins === 0 && c.score === 0), 'tally: all skipped gives zero votes and no winner');
const bad = await start(MODELS.slice(0, 2), 11, { model: MODELS[1], message: moments[0].message });
const failedMoment = bad.view().moments.find((m) => m.id === moments[0].id);
ok(failedMoment.options.some((o) => o.text === '(no answer)') && failedMoment.options.filter((o) => o.text !== '(no answer)').length === 1, 'error: a failed call shows as "(no answer)", the other answer stays');
voteFor(bad, 1, ids.slice(1)); bad.vote(moments[0].id, failedMoment.options.find((o) => o.text === '(no answer)').label);
const br = bad.reveal();
ok(br.candidates[1].errors === 1 && br.candidates[1].wins === 1 && br.candidates[1].answered === 11 && br.candidates[0].errors === 0, 'error: counted as an error, answered count is 11, a vote for "(no answer)" is still just a vote');

// 5. three candidates and shape
const three = await start(MODELS, 21);
voteFor(three, 3, ids.slice(0, 7)); voteFor(three, 1, ids.slice(7, 9)); for (const id of ids.slice(9)) three.vote(id, 'tie');
const r3 = three.reveal();
ok(r3.candidates.map((c) => c.wins).join() === '2,0,7' && r3.ties === 3, 'three candidates: wins 2, 0, 7 and 3 ties', JSON.stringify(r3.candidates.map((c) => c.wins)));
ok(r3.candidates[2].costUsd === null && r3.candidates[0].costUsd !== null, 'cost: an unpriced model stays null, never 0');
ok(r3.winner === MODELS[2] && Math.abs(r3.candidates[2].score - 8) < 1e-9, 'three candidates: score = wins + ties / 3');
ok(['seed', 'moments', 'voted', 'ties', 'skips', 'candidates', 'winner', 'key'].every((k) => k in r3) && ['model', 'wins', 'score', 'answered', 'errors', 'avgMs', 'costUsd', 'lintFlags'].every((k) => k in r3.candidates[0]), 'result shape: the fields the CLI and the card share');
ok(await blindRun({ moments, candidates: [{ model: 'a' }], seed: 1, buildMessages: build, callModel: stub() }).then(() => false, () => true), 'input: one candidate is refused');
ok(await blindRun({ moments, candidates: [{ model: 'a' }, { model: 'b' }], buildMessages: build, callModel: stub() }).then(() => false, () => true), 'input: a missing seed is refused (no hidden randomness)');

console.log(`\ncheck:voice-blind ${fail === 0 ? 'PASS' : 'FAIL'} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
