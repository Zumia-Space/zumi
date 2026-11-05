'use strict';
// Owner token-usage ledger (T-31 owner-admin + usage, Fable ruling 05-10 -- anh: "ko gioi han nhe coi anh nhu admin
// di thong ke giup anh token chi la duoc"). One JSONL line per REAL model call (chat-brain.js's callChat, reflex-
// jev.js's callJev), success AND failure, appended by the caller's own onUsage hook -- this module never calls out
// to those modules itself (deep module: it only knows how to persist and summarise a {model, kind, in, out, total,
// ms, ok} record, nothing about chat or Jev).
//   File: <dir>/usage/YYYY-MM-DD.jsonl, keyed by the OWNER's local calendar date (his wall clock, not UTC --
//   unlike chat-brain's own chat-turn-cap.json, which this module does not touch or share a file with).
//   Never the prompt/reply text, never the key, never a header -- just the six numeric/string fields above plus ts.
//   appendUsage() must never throw or block the call path: any fs error is swallowed to `log()` only.
const fs = require('node:fs');
const path = require('node:path');

function localDate(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function usageDir(dir) { return path.join(dir, 'usage'); }
function usageFile(dir, dateStr) { return path.join(usageDir(dir), `${dateStr}.jsonl`); }

// The kinds of call a line can record: the chat reply (Do), the Plan / Check / Look up roles (T-31 zumi-roles), Jev.
// Anything else is recorded as 'chat' (the only kind before the roles existed).
const KINDS = ['chat', 'plan', 'check', 'lookup', 'jev'];
const kindOf = (k) => (KINDS.includes(k) ? k : 'chat');

// rec: { model, kind: KINDS, in, out, total, ms, ok }. Silent on any failure (bad dir, disk full, ...) --
// `log` is a caller-supplied sink, same pattern as every other module here; never thrown back at the caller.
function appendUsage(dir, rec, log = () => {}) {
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      model: String((rec && rec.model) || 'unknown'),
      kind: kindOf(rec && rec.kind),
      in: Number(rec && rec.in) || 0,
      out: Number(rec && rec.out) || 0,
      total: Number(rec && rec.total) || 0,
      ms: Number(rec && rec.ms) || 0,
      ok: Boolean(rec && rec.ok),
      ...(rec && typeof rec.web === 'boolean' ? { web: rec.web } : {}), // Look up: did this call really send the web search (OpenRouter only)
    });
    fs.mkdirSync(usageDir(dir), { recursive: true });
    fs.appendFileSync(usageFile(dir, localDate()), `${line}\n`);
    return true;
  } catch (e) {
    log(`usage-ledger: append failed: ${(e && e.message) || e}`);
    return false;
  }
}

// Tolerant line parse: a malformed/truncated line (a crash mid-write, a hand-edited file) is skipped, never thrown
// -- same defensiveness this repo already applies to check-skips.mjs's malformed <testcase> lines.
function readDay(dir, dateStr) {
  let text;
  try { text = fs.readFileSync(usageFile(dir, dateStr), 'utf8'); } catch { return []; }
  const out = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const rec = JSON.parse(line);
      if (rec && typeof rec === 'object') out.push(rec);
    } catch { /* skip malformed line */ }
  }
  return out;
}

function pastDates(n, from = new Date()) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(localDate(new Date(from.getTime() - i * 86400000)));
  return out;
}

// Pure aggregation: day x model x kind -> {date, model, kind, calls, ok, in, out, total}. `days` includes today
// (days=30 -> today + the previous 29). Rows are sorted newest-date-first, then by model name, then kind, within a
// day, so the Settings table repaints in a stable order every refresh. A day with no ledger file contributes no rows.
// The same model used for two roles is two rows (e.g. "Gemini 3.7 Pro" and "Gemini 3.7 Pro · Check").
function aggregateUsage(dir, { days = 30 } = {}) {
  const today = localDate();
  const rows = [];
  for (const date of pastDates(Math.max(1, days))) {
    const byModel = new Map();
    for (const rec of readDay(dir, date)) {
      const model = rec.model || 'unknown';
      const kind = kindOf(rec.kind);
      const id = `${model}\n${kind}`;
      const m = byModel.get(id) || { date, model, kind, calls: 0, ok: 0, in: 0, out: 0, total: 0, searches: 0 };
      m.calls += 1;
      // A line from before the flag: only OpenRouter ever searched, and its ids are vendor/model.
      if (kind === 'lookup' && (typeof rec.web === 'boolean' ? rec.web : String(model).includes('/'))) m.searches += 1;
      if (rec.ok) m.ok += 1;
      m.in += Number(rec.in) || 0;
      m.out += Number(rec.out) || 0;
      m.total += Number(rec.total) || 0;
      byModel.set(id, m);
    }
    for (const m of [...byModel.values()].sort((a, b) => a.model.localeCompare(b.model) || KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind))) rows.push(m);
  }
  return { today, rows };
}

module.exports = { appendUsage, readDay, aggregateUsage, localDate, usageDir, usageFile, KINDS };
