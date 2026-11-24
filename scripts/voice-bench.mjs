// voice-bench (T-31-YOKI step 5.1, plan M5): blind compare of candidate models on our own 12 moments.
//   node scripts/voice-bench.mjs --models a,b[,c] [--seed 7] [--votes A,B,tie,skip,...] [--json]
// Phase 1 prints each moment with options labelled A, B, ...; nothing printed before "=== REVEAL ===" names a model.
// Votes come from --votes (one entry per moment, in order) or are asked on the terminal. Phase 2 prints votes, average
// latency, cost and lint numbers per candidate.
// This build is OFFLINE: the model call is a built-in stub. Real calls wait for the sidecar handlers (alpha.11), which
// will pass the active provider's postChat to the same core (src/main/voice-blind.mjs); --live is refused until then.
import fs from 'node:fs';
import readline from 'node:readline/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { blindRun } from '../src/main/voice-blind.mjs';

const require = createRequire(import.meta.url);
const { buildMessages } = require('../src/main/chat-brain.js'); // the production prompt: soulSystemPrompt via the default soul
const { estimateCostUsd } = require('../src/main/usage-cost.js');

const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def; };
const flag = (name) => process.argv.includes(`--${name}`);

if (flag('live')) { console.error('voice-bench: --live is not wired in this build (waits for the sidecar handlers); stub only.'); process.exit(2); }

const fixture = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'voice-blind', 'moments.json'), 'utf8'));
const models = arg('models', 'stub/alpha,stub/beta').split(',').map((s) => s.trim()).filter(Boolean);
const seed = arg('seed', '1');

// Stub model: a fixed reply per (candidate position, moment), 40 + 25 ms per position, small usage. No model name in the text.
const callModel = async (messages, candidate) => {
  const pos = models.indexOf(candidate.model);
  const last = messages[messages.length - 1].content;
  return { ok: true, text: `Stub reply ${pos + 1} to: ${String(last).slice(0, 40)}`, ms: 40 + 25 * pos, usage: { in: 120, out: 18 + 6 * pos } };
};

const run = await blindRun({
  moments: fixture.moments,
  candidates: models.map((model) => ({ model })),
  seed,
  buildMessages: (m) => buildMessages(m.message, m.history || [], null, null, {}),
  callModel,
  costOf: (model, i, o) => { const c = estimateCostUsd(model, i, o); return c.priced ? c.usd : null; }, // unpriced model: cost unknown, never 0
});

console.log('=== BLIND ===');
const view = run.view();
for (const m of view.moments) {
  console.log(`\n[${m.id}] user: ${m.message}`);
  for (const o of m.options) console.log(`  ${o.label}: ${o.text}`);
}

const scripted = arg('votes', '');
const choices = scripted ? scripted.split(',').map((s) => s.trim()) : [];
if (scripted && choices.length !== view.moments.length) { console.error(`voice-bench: --votes needs ${view.moments.length} entries, got ${choices.length}`); process.exit(2); }
const rl = scripted ? null : readline.createInterface({ input: process.stdin, output: process.stdout });
for (let i = 0; i < view.moments.length; i++) {
  const id = view.moments[i].id;
  for (;;) {
    const choice = scripted ? choices[i] : await rl.question(`vote ${id} (A.. / tie / skip): `);
    try { run.vote(id, choice); break; } catch (e) { if (scripted) { console.error(e.message); process.exit(2); } console.log(e.message); }
  }
}
if (rl) rl.close();

const result = run.reveal();
console.log('\n=== REVEAL ===');
if (flag('json')) console.log(JSON.stringify(result, null, 2));
else {
  console.log(`seed ${result.seed}, ${result.voted} of ${result.moments} voted, ${result.ties} ties, ${result.skips} skipped`);
  console.log('\n| Model | Wins | Score | Avg ms | Cost USD | Errors | Lint flags |\n|---|---|---|---|---|---|---|');
  for (const c of result.candidates) console.log(`| ${c.model} | ${c.wins} | ${c.score} | ${c.avgMs ?? '-'} | ${c.costUsd ?? 'n/a'} | ${c.errors} | ${JSON.stringify(c.lintFlags)} |`);
  console.log(`\nwinner: ${result.winner ?? 'none (tie at the top or no votes)'}`);
}
