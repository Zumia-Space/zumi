#!/usr/bin/env node
// One-shot migration from the predecessor board (flat JSON files + a media folder) into a FRESH Laneboard data
// directory. Every record goes through the board's own write path (board.write / board.upload), so the result
// is an ordinary journal that replays like any other; nothing is written to state.json by hand.
//
//   node scripts/migrate-from-legacy.mjs --from <snapshot> --to <new data dir> [--remap NEW=C-53] [--as-of <iso>]
//                                        [--coordinator-token-out <file>] [--owner-lang vi|en|zh] [--owner-theme dark|light|system]
//
// <snapshot> holds data/{tasks,feedback,pings,meta,registry,registry-status,times,routing,asks}.json and media/.
// Writes <to>/migration-report.json and copies the source JSON verbatim to <to>/legacy/ (audit + rollback aid).
// The owner token is generated into <to>/owner.token (mode 600) and never printed. --coordinator-token-out keeps the
// importer's coordinator token (mode 600) for the predecessor-API compatibility layer (src/legacy-compat.mjs).
//
// Mapping (predecessor -> Laneboard):
//   tasks.json rows          task.create via src/adapt-legacy.mjs (coordinator); status from the registry, except a
//                            grey row whose "now" starts with "TẠM HOÃN" (the owner paused it) -> paused, registry too
//                            step states map 1:1 (done/active/waiting/todo/blocked), legacy 'doing' -> active; a
//                            snapshot where any row breaks the board rules (src/rules.mjs) or any row/times record
//                            fails its v1 schema is refused whole, before the target directory is touched
//   asks.json {CODE:{text}}  overrides the row's needsAnh (as the predecessor's page did) -> ask.raise
//   times.json               times.import (owner), field-for-field (states as rows: 'doing' -> active), incl. tasks
//                            no longer on the board; sent LAST per
//                            task and carrying the predecessor's ages, so nothing restarts at the migration:
//                            last_activity_at = max(row.updated, step transitions) (its "Đứng im" clock) and each open
//                            ask's waiting_since = the "Chờ anh" line's own since (min(askAt, waitingSince) | updated)
//   routing.json             routing.set (owner)
//   feedback.json            anh note/approve/reject/newtask/choice -> feedback.add (owner, same kind); task NEW (the
//                            "+ new task" requests) stays NEW, the board's request thread (no --remap needed);
//                            cos note -> feedback.add note|reply (coordinator, reply_to remapped); cos ask -> ask.raise;
//                            status done -> feedback.resolve
//   "answered" CHỜ ANH lines an owner choice on the asked step after the ask -> ask.answer with that choice
//   meta.json summary        summary.set (coordinator)
//   registry(+status).json   registry.set (coordinator), status overrides merged in
//   media/                   attachment.add (<= base64 cap) or board.upload (bigger), mapped to the task/step whose
//                            text references media/<name>, else to the task whose code the file name carries
//   pings.json               pings.import (owner), last 200 with their ids, times, kinds, notes and seen marks
//   goals.json               goals.import (owner) per task, version history and lock times kept; goal-lock feedback
//                            rows -> feedback.add kind goal-lock with their goal version
//   plans.json               plans.import (owner) per task, ids kept as legacy_id; an owner choice on step 'plan'
//                            -> feedback.add choice with the plan_id it names ("(<first 8 of the plan id>)")
//   rebrief feedback rows    rebrief.request (owner) with mode and note
// Writes carrying a migration origin ("legacy ...") do not ping: importing routing or goals wakes no one.
// Original author and time ride along as `origin: "legacy <by> <at>"` (unverified metadata by design).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBoard, SCHEMA_DIR } from '../src/board.mjs';
import { loadSchemas, validate } from '../src/validate.mjs';
import { legacyRowToRequests, legacyTimesToRequests, legacyRegistryEntry, uniqueStepIds } from '../src/adapt-legacy.mjs';
import { validateTasks } from '../src/rules.mjs';
import { REQUESTS_THREAD } from '../src/ops.mjs';

const FILES = ['tasks', 'feedback', 'pings', 'meta', 'registry', 'registry-status', 'times', 'routing', 'asks', 'goals', 'plans'];
const DEFAULTS = { tasks: [], feedback: [], pings: [], meta: {}, registry: [], 'registry-status': {}, times: { tasks: {} }, routing: {}, asks: {}, goals: {}, plans: {} };
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', mp3: 'audio/mpeg', mp4: 'video/mp4' };
const MEDIA_REF = /!\[([^\]]*)\]\((media\/[\w.-]+\.(?:png|jpe?g|webp|gif|mp3|mp4))\)|(media\/[\w.-]+\.(?:png|jpe?g|webp|gif|mp3|mp4))/gi;
const clip = (s, n) => String(s ?? '').slice(0, n);
const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

export function loadLegacy(dir) {
  const data = {};
  for (const f of FILES) {
    const p = path.join(dir, 'data', `${f}.json`);
    data[f] = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : structuredClone(DEFAULTS[f]);
  }
  const mediaDir = path.join(dir, 'media');
  data.media = fs.existsSync(mediaDir) ? fs.readdirSync(mediaDir).filter(n => MIME[n.split('.').pop().toLowerCase()]).sort().map(n => ({ name: n, file: path.join(mediaDir, n), size: fs.statSync(path.join(mediaDir, n)).size })) : [];
  return data;
}

/** Registry status of an on-board task, overrides applied — the predecessor's regStatus(). '' when unlisted. */
export function legacyRegStatus(data, code) {
  const r = data.registry.find(x => x.onBoard && x.code === code);
  return r ? ({ ...r, ...(data['registry-status'][r.id] || {}) }).status || '' : '';
}
/** Status the import gives an on-board task: the registry's, but a grey dot whose "now" starts with "TẠM HOÃN" is
 *  the owner's pause (L-02, 26-09) even when the registry still says doing. */
export function importStatus(data, row) {
  const st = legacyRegStatus(data, row.code);
  const paused = row.health === 'grey' && String(row.now || '').normalize('NFC').trim().toLocaleUpperCase('vi').startsWith('TẠM HOÃN');
  return paused && st !== 'closed' ? 'paused' : st;
}
/** The predecessor's last-movement clock of a row (dungImItems): max(row.updated, every step transition). 0 = none. */
export function legacyLastActivity(data, row) {
  let last = Date.parse(row.updated) || 0;
  for (const s of Object.values(data.times.tasks?.[row.code]?.steps || {})) for (const tr of s.transitions || []) { const d = Date.parse(tr.t); if (d > last) last = d; }
  return last;
}
/** The predecessor's "Đứng im > 3h" block at nowMs; statusOf lets a caller apply the import's status rules. */
export function legacyStalled(data, nowMs, statusOf = row => legacyRegStatus(data, row.code), stallMs = 3 * 3600000) {
  const out = [];
  for (const t of data.tasks) {
    if (['paused', 'closed'].includes(statusOf(t))) continue;
    const steps = t.steps || [];
    if (steps.length && steps.every(s => s.state === 'done')) continue;
    if (data.times.tasks?.[t.code]?.doneAt) continue;
    const last = legacyLastActivity(data, t);
    if (last && nowMs - last > stallMs) out.push({ code: t.code, last, idle_ms: nowMs - last });
  }
  return out.sort((a, b) => b.idle_ms - a.idle_ms);
}

/** Board-rule violations (src/rules.mjs) of every row, checked on exactly the steps its task.create would write. */
export function legacyViolations(data) {
  return validateTasks(data.tasks.map(row => {
    const req = legacyRowToRequests(row)[0];
    return { id: req.target_id, steps: req.data.steps };
  }));
}

const schemas = loadSchemas(SCHEMA_DIR);
/** v1 schema errors of the writes built purely from the snapshot (task.create per row, times.import per task),
 *  checked up front so a bad record refuses the whole import instead of failing half-way through it. */
export function legacySchemaErrors(data) {
  const reqs = [...data.tasks.map(row => legacyRowToRequests(row)[0]), ...legacyTimesToRequests(data.times)];
  return reqs.flatMap(r => validate(schemas, `ops/${r.op}.json`, r.data).map(e => ({ op: r.op, target_id: r.target_id, ...e })));
}

/** Rows as the predecessor's page saw them: asks.json wins over a row's own needsAnh. */
export function legacyRows(data) {
  return data.tasks.map(t => { const a = data.asks[t.code]; return a ? { ...t, needsAnh: a.text, askAt: a.at, askedBy: a.by } : t; });
}

/**
 * The predecessor's "Chờ anh" block (choAnhItems), same rules: one line per live task with an ask or a waiting
 * owner step, "answered" only by an owner choice on that exact step after the ask's own start; plus open CoS
 * 'ask' feedback. Returns { waiting: [{code, step, text, since}], answered: [{code, step, text, since, by}] } (since in ms).
 */
export function legacyWaitingLines(data, statusOf = row => legacyRegStatus(data, row.code)) {
  const times = data.times.tasks || {};
  const waiting = [], answered = [];
  for (const t of legacyRows(data)) {
    if (['paused', 'closed'].includes(statusOf(t))) continue;
    const anhStep = (t.steps || []).find(s => s.state === 'waiting' && s.zone === 'anh');
    if (!t.needsAnh && !anhStep) continue;
    const stepId = anhStep ? anhStep.id : '';
    const waitingSince = (anhStep && times[t.code]?.steps?.[anhStep.id]?.waitingSince) || '';
    const askRef = t.needsAnh ? (t.askAt || '') : waitingSince;
    // Display age exactly as the predecessor: oldest of askAt / waitingSince, else the row's updated (ms; 0 = none).
    const starts = [Date.parse(t.askAt || '') || null, waitingSince ? Date.parse(waitingSince) : null].filter(Boolean);
    const since = starts.length ? Math.min(...starts) : (Date.parse(t.updated) || 0);
    const by = data.feedback.filter(f => f.by === 'anh' && f.task === t.code && f.kind === 'choice' && (!stepId || f.step === stepId) && String(f.at) > String(askRef)).at(-1);
    (by ? answered : waiting).push({ code: t.code, step: stepId, text: t.needsAnh || anhStep.label, since, ...(by ? { by } : {}) });
  }
  for (const f of data.feedback.filter(f => f.by === 'cos' && f.kind === 'ask' && f.status !== 'done')) {
    if ([...waiting, ...answered].some(x => x.code === f.task)) continue;
    const by = data.feedback.find(r => r.by === 'anh' && r.task === f.task && r.replyTo === f.id);
    (by ? answered : waiting).push({ code: f.task, step: f.step || '', text: f.text, cosAsk: f.id, since: Date.parse(f.at) || 0, ...(by ? { by } : {}) });
  }
  return { waiting, answered };
}

/** The predecessor's per-task "Đã đo" numbers (taskTimeSummary) in ms at `nowMs`; null before any start. */
export function legacyTaskTotals(tt, nowMs) {
  if (!tt || !tt.startedAt) return null;
  const started = Date.parse(tt.startedAt), end = tt.doneAt ? Date.parse(tt.doneAt) : nowMs;
  let wait = 0; for (const s of Object.values(tt.steps || {})) { wait += s.waitingTotalMs || 0; if (s.waitingSince) wait += nowMs - Date.parse(s.waitingSince); }
  return { work_ms: Math.max(0, end - started - wait), wait_ms: wait };
}

/** Owner choice text "Chọn A: label\ncomment" -> ask.answer data, using the ask's options when the key is one. */
function answerFromChoice(text, options = []) {
  const m = /^Chọn ([A-Za-z0-9]+):[^\n]*\n?([\s\S]*)$/.exec(text || '');
  if (m && options.some(o => o.key === m[1])) return { choice: m[1], ...(m[2].trim() ? { text: clip(m[2].trim(), 4000) } : {}) };
  return { text: clip(text, 4000) || '(chọn)' };
}

function safeName(n) {
  let s = n.replace(/[^A-Za-z0-9_. -]/g, '-');
  if (!/^[A-Za-z0-9]/.test(s)) s = 'f' + s;
  if (s.length > 120) { const ext = path.extname(s); s = s.slice(0, 120 - ext.length) + ext; }
  return s;
}

export async function migrate({ from, to, remap = {}, now, coordinatorTokenOut, ownerLang, ownerTheme } = {}) {
  if (fs.existsSync(to) && fs.readdirSync(to).length) throw new Error(`refusing to import into a non-empty directory: ${to}`);
  const data = loadLegacy(from);
  // Board honesty rules (src/rules.mjs) hold on this path too: board.write would refuse a bad row mid-import, so
  // check every row first and refuse the whole snapshot, listing every violation, before anything is written.
  const violations = legacyViolations(data);
  if (violations.length) throw Object.assign(new Error(`snapshot breaks the board rules, nothing imported: ${violations.map(v => `${v.error} ${v.task}/${v.step}`).join(', ')}`), { violations });
  const schemaErrors = legacySchemaErrors(data);
  if (schemaErrors.length) throw Object.assign(new Error(`snapshot fails the v1 schema, nothing imported: ${schemaErrors.slice(0, 10).map(e => `${e.op} ${e.target_id} ${e.path} ${e.message}`).join('; ')}${schemaErrors.length > 10 ? ` (+${schemaErrors.length - 10} more)` : ''}`), { schemaErrors });
  const board = createBoard({ dataDir: to, ...(now ? { now } : {}) });
  const owner = fs.readFileSync(board.bootstrapTokenFile, 'utf8').trim(); // stays in memory; never printed
  const report = { from, to, at: new Date().toISOString(), source: {}, imported: {}, warnings: [], ids: { feedback: {}, asks: {}, attachments: {} }, media: [] };
  const count = k => { report.imported[k] = (report.imported[k] || 0) + 1; };
  let n = 0;
  const w = (token, op, target_id, d, extra = {}) => board.write(token, { version: 1, request_id: `mig-${op}-${++n}`, op, target_id, data: d, ...extra });
  const origin = (by, at) => clip(`legacy ${by || '?'}${at ? ' ' + at : ''}`, 120);

  for (const f of FILES) report.source[f] = Array.isArray(data[f]) ? data[f].length : Object.keys(f === 'times' ? data[f].tasks || {} : data[f]).length;
  report.source.media = data.media.length;
  report.source.media_bytes = data.media.reduce((a, m) => a + m.size, 0);

  const coord = w(owner, 'token.issue', 'coordinator', { role: 'coordinator', label: 'CoS (imported)', lane: 'coordination' }).token;
  if (coordinatorTokenOut) fs.writeFileSync(coordinatorTokenOut, coord + '\n', { mode: 0o600 });
  // The predecessor's page had one language; the owner keeps it (a display pref, changeable in Settings).
  // ownerTheme: the predecessor's page was dark only (color-scheme: dark, no light theme).
  if (ownerLang || ownerTheme) w(owner, 'prefs.set', board.authenticate(owner).token_id, { ...(ownerLang ? { lang: ownerLang } : {}), ...(ownerTheme ? { theme: ownerTheme } : {}) });

  // Tasks (+ the asks their rows carry).
  const rows = legacyRows(data);
  const onBoard = new Set(rows.map(r => r.code));
  const askByTask = {};
  for (const row of rows) {
    const ids = uniqueStepIds(row);
    ids.forEach((id, i) => { if (id !== row.steps[i].id) report.warnings.push(`${row.code}: duplicate step id ${row.steps[i].id} imported as ${id}`); });
    const reg = legacyRegStatus(data, row.code), st = importStatus(data, row);
    if (st !== reg) report.warnings.push(`${row.code}: grey dot + "TẠM HOÃN" but registry status '${reg || 'none'}' — imported as paused (task and registry entry)`);
    else if (row.health === 'grey' && !['paused', 'closed'].includes(st)) report.warnings.push(`${row.code}: grey ("paused") dot but registry status '${st || 'none'}' — imported as live, like the predecessor treated it; pause it on the board if intended`);
    for (const r of row.steps || []) if ((r.detail || '').length > 16000) report.warnings.push(`${row.code}/${r.id}: detail clipped to 16000 chars`);
    for (const req of legacyRowToRequests(row, { prefix: 'mig', status: st || undefined })) {
      const res = board.write(coord, { ...req, ...(req.op === 'ask.raise' ? { origin: origin(row.askedBy || 'cos', row.askAt) } : {}) });
      if (req.op === 'ask.raise') { askByTask[row.code] = res.id; count('asks'); } else count('tasks');
    }
  }

  // The owner's worker overrides (timing history goes last, see below).
  for (const [code, r] of Object.entries(data.routing)) {
    if (!onBoard.has(code)) { report.warnings.push(`routing for ${code}: task not on the board, skipped`); continue; }
    w(owner, 'routing.set', code, { model: r.model, effort: r.effort }, { origin: origin(r.by, r.at) }); count('routing');
  }

  // Locked goals and reviewer plans (before feedback: plan choices and goal-lock rows refer to them).
  const iso = v => (v && !isNaN(Date.parse(v)) ? new Date(v).toISOString() : undefined);
  for (const [code, g] of Object.entries(data.goals)) {
    if (!onBoard.has(code)) { report.warnings.push(`goal for ${code}: task not on the board, kept in legacy/goals.json only`); continue; }
    const hist = (g.history || []).map(h => ({ goal: clip(h.goal, 4000) || '-', output: clip(h.output, 4000) || '-', outcome: clip(h.outcome, 4000) || '-', version: h.version || 1, ...(iso(h.lockedAt) ? { locked_at: iso(h.lockedAt) } : {}) }));
    w(owner, 'goals.import', code, { goal: clip(g.goal, 4000) || '-', output: clip(g.output, 4000) || '-', outcome: clip(g.outcome, 4000) || '-', version: g.version || 1, locked_at: iso(g.lockedAt) || new Date(0).toISOString(), ...(hist.length ? { history: hist } : {}) }, { origin: origin(g.lockedBy || 'anh', g.lockedAt) });
    count('goals');
  }
  const VERDICTS = ['on-track', 'adjust', 'pivot', 'drifting', 'wrong-goal', 'unavailable'];
  for (const [code, list] of Object.entries(data.plans)) {
    if (!onBoard.has(code)) { report.warnings.push(`plans for ${code}: task not on the board, kept in legacy/plans.json only`); continue; }
    const plans = (list || []).slice(-200).map(p => ({ legacy_id: clip(p.id, 64), reviewer: clip(p.reviewer, 40) || '?', body: clip(p.body, 60000) || '-', verdict: VERDICTS.includes(p.verdict) ? p.verdict : '', ...(p.eta ? { eta: clip(p.eta, 200) } : {}),
      ...(iso(p.at) ? { written_at: iso(p.at) } : {}), posted_at: iso(p.postedAt) || iso(p.at) || new Date(0).toISOString(), goal_version: p.goalVersion || 0 }));
    if (plans.length) { w(owner, 'plans.import', code, { plans }, { origin: origin('cos') }); report.imported.plans = (report.imported.plans || 0) + plans.length; }
  }
  const planIdOf = (task, text) => (board.state.plans?.[task] || []).find(p => p.legacy_id && String(text).includes('(' + p.legacy_id.slice(0, 8) + ')'))?.id;

  // Feedback in source order; replies point at the new ids of their parents.
  const stepOk = (task, step) => step && board.state.steps[`${task}/${step}`];
  for (const f of data.feedback) {
    const task = remap[f.task] || f.task;
    if (!onBoard.has(task) && task !== REQUESTS_THREAD) { report.warnings.push(`feedback ${f.id}: task ${f.task} not on the board, skipped (use --remap)`); continue; }
    const extra = { origin: origin(f.by, f.at) };
    const text = clip(f.text, 8000) || '(trống)';
    if (f.by === 'cos' && f.kind === 'ask') {
      if (f.status === 'done') { report.warnings.push(`cos ask ${f.id} already done: kept as a note`); }
      else { const res = w(coord, 'ask.raise', task, { text: clip(f.text, 2000), ...(stepOk(task, f.step) ? { step_id: f.step } : {}) }, extra); report.ids.asks[f.id] = res.id; count('asks'); continue; }
    }
    if (f.by === 'anh' && f.kind === 'rebrief') {
      const note = f.note ?? (f.text.includes('\n') ? f.text.slice(f.text.indexOf('\n') + 1) : '');
      const res = w(owner, 'rebrief.request', task, { mode: f.mode === 'qc' ? 'qc' : 'strategy', ...(note ? { note: clip(note, 4000) } : {}) }, extra);
      report.ids.feedback[f.id] = res.id; count('feedback_anh_rebrief'); continue;
    }
    const kind = f.by === 'anh' ? (['note', 'approve', 'reject', 'newtask', 'choice', 'goal-lock'].includes(f.kind) ? f.kind : 'note') : (f.replyTo ? 'reply' : 'note');
    const replyTo = f.replyTo ? report.ids.feedback[f.replyTo] : undefined;
    if (f.replyTo && !replyTo) report.warnings.push(`feedback ${f.id}: parent ${f.replyTo} not imported, reply kept without link`);
    const goalVersion = kind === 'goal-lock' ? Number((/\bv(\d+)\b/.exec(f.text) || [])[1]) || 1 : 0;
    const planId = f.by === 'anh' && kind === 'choice' && f.step === 'plan' ? planIdOf(task, f.text) : undefined;
    if (f.step === 'plan' && kind === 'choice' && !planId) report.warnings.push(`feedback ${f.id}: names no imported plan, kept as a choice without plan link`);
    const res = w(f.by === 'anh' ? owner : coord, 'feedback.add', task, { kind: kind === 'reply' && !replyTo ? 'note' : kind, text, ...(stepOk(task, f.step) ? { step_id: f.step } : {}), ...(replyTo ? { reply_to: replyTo } : {}),
      ...(goalVersion ? { goal_version: goalVersion } : {}), ...(planId ? { plan_id: planId } : {}) }, extra);
    report.ids.feedback[f.id] = res.id; count(`feedback_${f.by}_${kind}`);
  }
  for (const f of data.feedback) {
    const id = report.ids.feedback[f.id];
    if (f.status === 'done' && id && board.state.feedback[id].status === 'open') { w(coord, 'feedback.resolve', id, {}, { expected_revision: board.state.feedback[id].rev, origin: origin('cos', f.doneAt) }); count('feedback_resolved'); }
  }

  // Lines the predecessor showed as answered: the owner's choice becomes the ask's answer.
  for (const line of legacyWaitingLines(data).answered) {
    const task = line.code;
    if (!onBoard.has(task)) continue;
    let askId = line.cosAsk ? report.ids.asks[line.cosAsk] : askByTask[task];
    if (!askId) {
      askId = w(coord, 'ask.raise', task, { text: clip(line.text, 2000), ...(stepOk(task, line.step) ? { step_id: line.step } : {}) }, { origin: origin('cos') }).id;
      count('asks');
    }
    const a = board.state.asks[askId];
    if (a.status !== 'open') continue;
    const linked = report.ids.feedback[line.by.id];
    w(owner, 'ask.answer', askId, { ...answerFromChoice(line.by.text, a.options), ...(linked ? { feedback_id: linked } : {}) }, { expected_revision: a.rev, origin: origin('anh', line.by.at) });
    count('asks_answered');
  }

  // Board documents.
  const summary = Array.isArray(data.meta.summary) ? data.meta.summary : data.meta.summary ? [String(data.meta.summary)] : [];
  if (summary.length) { w(coord, 'summary.set', 'board', { items: summary.slice(0, 50).map(x => clip(x, 2000)).filter(Boolean) }, { expected_revision: 0, origin: origin('cos', data.meta.updatedAt) }); count('summary'); }
  if (data.registry.length) {
    const entries = data.registry.map(r => {
      const e = legacyRegistryEntry(r, data['registry-status'][r.id]);
      const row = r.onBoard && rows.find(x => x.code === r.code);
      if (row && importStatus(data, row) === 'paused' && e.status !== 'paused') { Object.assign(e, { status: 'paused', status_by: 'import: grey dot + TẠM HOÃN (owner pause)' }); delete e.status_at; }
      return e;
    });
    w(coord, 'registry.set', 'board', { entries }, { expected_revision: 0, origin: origin('cos') }); count('registry_entries');
    report.imported.registry_entries = entries.length;
  }

  // Media: task/step from the first text that references media/<name> (the predecessor's gallery rule),
  // otherwise the longest task code contained in the file name.
  const refs = {};
  for (const row of rows) {
    const ids = uniqueStepIds(row);
    const scan = (text, stepId) => { for (const m of String(text || '').matchAll(MEDIA_REF)) { const name = (m[2] || m[3]).slice('media/'.length); refs[name] ??= { task: row.code, step: stepId, caption: m[1] || '' }; } };
    scan(row.context);
    (row.steps || []).forEach((s, i) => scan(s.detail, ids[i]));
  }
  const codes = [...onBoard].sort((a, b) => norm(b).length - norm(a).length);
  const cap = board.view(owner).config.max_attachment_bytes;
  for (const m of data.media) {
    const ref = refs[m.name];
    const task = ref?.task || codes.find(c => norm(m.name).includes(norm(c)));
    const entry = { name: m.name, size: m.size, task: task || null, step: ref?.step || null, how: ref ? 'referenced' : task ? 'file-name' : 'unmapped' };
    report.media.push(entry);
    if (!task) { report.warnings.push(`media ${m.name}: no task references it and its name carries no task code, skipped`); continue; }
    const mime = MIME[m.name.split('.').pop().toLowerCase()];
    const meta = { name: safeName(m.name), mime, ...(ref?.step && stepOk(task, ref.step) ? { step_id: ref.step } : {}), ...(ref?.caption ? { caption: clip(ref.caption, 500) } : {}) };
    if (meta.name !== m.name) report.warnings.push(`media ${m.name}: stored as ${meta.name}`);
    try {
      const res = m.size <= cap
        ? w(coord, 'attachment.add', task, { ...meta, data_base64: fs.readFileSync(m.file).toString('base64') })
        : await board.upload(coord, { request_id: `mig-upload-${++n}`, task_id: task, ...meta }, fs.createReadStream(m.file), { contentLength: m.size });
      entry.id = res.id; entry.via = m.size <= cap ? 'base64' : 'upload';
      report.ids.attachments[m.name] = res.id; count('media');
    } catch (e) { entry.error = e.code || e.message; report.warnings.push(`media ${m.name}: ${entry.error}`); }
  }

  // Timing history last: no later import write may move a task's activity clock. Ages ride along (see header).
  const askSince = {};
  for (const line of legacyWaitingLines(data).waiting) {
    const askId = line.cosAsk ? report.ids.asks[line.cosAsk] : askByTask[line.code];
    if (askId && line.since && board.state.asks[askId]?.status === 'open') (askSince[line.code] ??= {})[askId] = { waiting_since: new Date(line.since).toISOString() };
  }
  const timed = new Set(Object.keys(data.times.tasks || {}));
  for (const req of legacyTimesToRequests(data.times, { prefix: 'mig' })) {
    const row = rows.find(r => r.code === req.target_id);
    if (row) {
      const last = legacyLastActivity(data, row);
      if (last) req.data.last_activity_at = new Date(last).toISOString();
      if (askSince[row.code]) { req.data.asks = askSince[row.code]; report.imported.ask_ages = (report.imported.ask_ages || 0) + Object.keys(askSince[row.code]).length; }
    }
    board.write(owner, req); count('times');
  }
  for (const row of rows) if (!timed.has(row.code)) report.warnings.push(`${row.code}: no timing history in times.json — its idle and ask ages start at the import`);

  // Pings last: every earlier import write is history and pinged no one; these are the predecessor's own.
  const pings = data.pings.slice(-200).filter(p => iso(p.at)).map(p => ({ legacy_id: clip(p.id, 64), at: iso(p.at), ...(p.task ? { task_id: clip(p.task, 40) } : {}), ...(p.note ? { note: clip(p.note, 2000) } : {}),
    kind: clip(p.kind || 'send', 32), open: Number.isInteger(p.open) && p.open >= 0 ? p.open : 0, ...(iso(p.seenAt) ? { seen_at: iso(p.seenAt) } : {}) }));
  if (pings.length) { w(owner, 'pings.import', 'board', { pings }, { origin: origin('anh') }); report.imported.pings = pings.length; }

  fs.mkdirSync(path.join(to, 'legacy'), { recursive: true });
  for (const f of FILES) { const p = path.join(from, 'data', `${f}.json`); if (fs.existsSync(p)) fs.copyFileSync(p, path.join(to, 'legacy', `${f}.json`)); }
  if (data.pings.length > 200) report.warnings.push(`pings.json: ${data.pings.length - 200} oldest ping(s) beyond the last 200 kept in legacy/pings.json only`);
  report.unseen_pings = data.pings.filter(p => !p.seenAt).length;
  report.seq = board.state.seq;
  fs.writeFileSync(path.join(to, 'migration-report.json'), JSON.stringify(report, null, 2));
  board.close();
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), get = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const from = get('--from'), to = get('--to');
  if (!from || !to) { console.error('usage: migrate-from-legacy.mjs --from <snapshot> --to <new data dir> [--remap OLD=NEW ...] [--as-of <iso>]'); process.exit(2); }
  const remap = Object.fromEntries(args.flatMap((a, i) => (a === '--remap' ? [args[i + 1].split('=')] : [])));
  const asOf = get('--as-of');
  const tokOut = get('--coordinator-token-out'), ownerLang = get('--owner-lang'), ownerTheme = get('--owner-theme');
  const r = await migrate({ from: path.resolve(from), to: path.resolve(to), remap, ...(asOf ? { now: () => Date.parse(asOf) } : {}), ...(tokOut ? { coordinatorTokenOut: path.resolve(tokOut) } : {}), ...(ownerLang ? { ownerLang } : {}), ...(ownerTheme ? { ownerTheme } : {}) });
  console.log(JSON.stringify({ source: r.source, imported: r.imported, warnings: r.warnings.length, unseen_pings: r.unseen_pings, seq: r.seq, report: path.join(r.to, 'migration-report.json') }, null, 2));
  for (const x of r.warnings) console.log('warn:', x);
}
