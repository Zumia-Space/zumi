#!/usr/bin/env node
// Rewrites src/main/usage-prices.json from OpenRouter's public model list (no key sent), for every model id the app can
// list or default to for the four roles: the same list the Settings picker gets (chat-brain.js fetchModelList, then
// role-models.js withoutClaude). Entries that are not such an id (_webSearch, the Jev model, a delisted model a ledger
// row may still name) are kept as they are.
//   npm run update:usage-prices
// Price rules, recorded in the file's `_source`:
//   - a time-of-day override (utc_days / utc_start..utc_end, e.g. a weekday peak) -> the HIGHEST rate. The ledger keeps no
//     time of day, and a higher rate never under-counts; for the owner (Vietnam, UTC+7) the deepseek peak windows are
//     his working hours anyway.
//   - a prompt-size override (min_prompt_tokens) -> the base rate. A Zumi request stays far below the lowest such tier
//     (32k tokens): history 6 x 2000 chars + digest 6000 chars + prompts; the 10-10 smoke used ~2.4k per chat call.
//   - output = max(completion, internal_reasoning): reasoning tokens bill as output.
//   - a negative price ("-1", what a router lists) -> unverified, null.
// Fails, and writes nothing, if any Claude model is free: openrouter/free (allowed by isClaudeModel) could then pick it.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'src', 'main', 'usage-prices.json');
const URL_MODELS = 'https://openrouter.ai/api/v1/models';
const require = createRequire(import.meta.url);
const { fetchModelList, isClaudeModel } = require('../src/main/chat-brain.js');
const { withoutClaude } = require('../src/main/role-models.js');

const res = await fetch(URL_MODELS, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
if (!res.ok) { console.error(`refresh-usage-prices: ${URL_MODELS} -> HTTP ${res.status}`); process.exit(1); }
const readAt = new Date(res.headers.get('date') || Date.now()).toISOString().replace(/\.\d+Z$/, 'Z');
const { data } = await res.json();

const appList = await fetchModelList(async () => ({ ok: true, status: 200, json: async () => ({ data }) }));
const listed = new Set(withoutClaude(appList.models).map((m) => m.id));

const freeClaude = data.filter((m) => isClaudeModel(m) && (/:free$/i.test(m.id) || (Number(m.pricing.prompt) === 0 && Number(m.pricing.completion) === 0)));
if (freeClaude.length) { console.error(`refresh-usage-prices: free Claude model(s) ${freeClaude.map((m) => m.id).join(', ')} -- openrouter/free could pick one; block it in chat-brain.js isClaudeModel first`); process.exit(1); }

const perMtok = (perToken) => Number((Number(perToken) * 1e6).toPrecision(10));
const isTimed = (o) => 'utc_days' in o || 'utc_start' in o || 'utc_end' in o;
const day = readAt.slice(0, 10);
const time = readAt.slice(11, 16);

const prev = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const next = {
  _source: {
    url: URL_MODELS,
    readAt,
    rules: 'pricing.prompt / pricing.completion per token x 1e6. Time-of-day overrides (peak vs base): the highest rate, since the ledger keeps no time of day and a higher rate never under-counts. Prompt-size overrides (min_prompt_tokens >= 32k): the base rate, a Zumi request stays far below. Output = max(completion, internal_reasoning). Price -1: unverified. Written by scripts/refresh-usage-prices.mjs.',
  },
};
for (const [id, v] of Object.entries(prev)) if (id.startsWith('_') && id !== '_source') next[id] = v; // _webSearch
for (const m of data) {
  if (!listed.has(m.id)) continue;
  const p = m.pricing || {};
  const base = { in: Number(p.prompt), out: Math.max(Number(p.completion), Number(p.internal_reasoning) || 0) };
  let source = `OpenRouter public /api/v1/models, read ${day} ${time} UTC`;
  if (!(base.in >= 0 && base.out >= 0)) {
    next[m.id] = { inputPerMtok: null, outputPerMtok: null, unverified: true, source: `${source}: no fixed price` };
    continue;
  }
  let inTok = base.in;
  let outTok = base.out;
  const timed = (p.overrides || []).filter(isTimed);
  if (timed.length) {
    for (const o of timed) { inTok = Math.max(inTok, Number(o.prompt) || 0); outTok = Math.max(outTok, Number(o.completion) || 0); }
    source += `: pricing.overrides by UTC time, highest rate kept ($${perMtok(inTok)} / $${perMtok(outTok)} per Mtok; base $${perMtok(base.in)} / $${perMtok(base.out)})`;
  } else if ((p.overrides || []).length) {
    source += `: base rate; pricing.overrides above ${Math.min(...p.overrides.map((o) => o.min_prompt_tokens || Infinity))} prompt tokens not used`;
  }
  next[m.id] = { inputPerMtok: perMtok(inTok), outputPerMtok: perMtok(outTok), unverified: false, source };
}
for (const [id, v] of Object.entries(prev)) if (!id.startsWith('_') && !listed.has(id)) next[id] = v; // Jev, delisted ids

fs.writeFileSync(FILE, `${JSON.stringify(next, null, 2)}\n`);
console.log(`refresh-usage-prices: ${listed.size} listed models priced from ${URL_MODELS} (${readAt}); kept ${Object.keys(next).length - 1 - listed.size} other entries (${Object.keys(next).filter((id) => id !== '_source' && !listed.has(id)).join(', ')})`);
