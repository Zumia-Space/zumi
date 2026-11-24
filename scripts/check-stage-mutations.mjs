// Room live B, P1 part 2 (ADR docs/decisions/2026-11-13-room-live-b.md D7/D8): mutation proofs for the host-side negative tests
// (N5 N6 N8 N9 N10 N11 N12 N13 N14 N15 N16) and the F1 acceptance tests (A1-A11).
//
//   node scripts/check-stage-mutations.mjs --work <scratch dir> [--out <log dir>] [--target <cargo target dir>] [--only ID,ID] [--anchors-only]
//
// For each mutation: apply the stated weakening to a TEMPORARY COPY of the tree (the repo tree is never touched), build and run the
// named tests there (they must exit non-zero, and each named test must be among the FAILED ones), then compare the touched files
// with the pristine copy by sha256 and run the same tests on the pristine copy (they must pass). The red log of every mutation
// is stored in --out. A test with no recorded red run does not count. Needs cargo; hold the HEAVY lock while it runs.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const work = opt('work');
if (!work) { console.error('usage: check-stage-mutations.mjs --work <dir> [--out <dir>] [--target <dir>] [--only ID,ID] [--anchors-only]'); process.exit(2); }
const out = opt('out') || path.join(work, 'logs');
const target = opt('target') || path.join(work, 'target');
const only = opt('only') ? new Set(opt('only').split(',')) : null;
const anchorsOnly = args.includes('--anchors-only');

const SB = 'tauri/src-tauri/src/stage_bridge.rs';
const PH = 'tauri/src-tauri/src/pack_host.rs';
const SCHEMA = 'docs/decisions/room-live-b/stage-contract.v1.schema.json';
const ST = 'stage_tests::';
const PT = 'pack_host_stage_tests::';

// id, rows (what it proves), tests (full names that must be red), edits ({ file, find, replace, all })
const MUTATIONS = [
  { id: 'M-N5-static', rows: ['N5b'], tests: [`${ST}n5b_`], edits: [{ file: SCHEMA, find: '"vis": {\n              "type": "array",', replace: '"caption": { "type": "string" },\n            "vis": {\n              "type": "array",' }] },
  { id: 'M-N5-dynamic', rows: ['N5a', 'N5c'], tests: [`${ST}n5a_`, `${ST}n5c_`], edits: [{ file: SB, find: '"emotion": emotion, "intensity": intensity, "vis": vis,', replace: '"emotion": emotion, "intensity": intensity, "vis": vis, "caption": "ZUMI-MARKER-7f3a91 reply text",' }] },
  { id: 'M-N6-schema', rows: ['N6 schema', 'N15'], tests: [`${ST}n6_unknown_field`, `${ST}n15_`], edits: [{ file: SB, find: '#[serde(deny_unknown_fields)]', replace: '', all: true }] },
  { id: 'M-N6-cap', rows: ['N6 size'], tests: [`${ST}n6_a_body_over_the_cap`], edits: [
    { file: SB, find: 'const BODY_CAP_POLL: usize = 128;', replace: 'const BODY_CAP_POLL: usize = 1048576;' },
    { file: SB, find: 'const BODY_CAP_READY: usize = 512;', replace: 'const BODY_CAP_READY: usize = 1048576;' },
    { file: SB, find: 'const BODY_CAP_STATS: usize = 128;', replace: 'const BODY_CAP_STATS: usize = 1048576;' }] },
  { id: 'M-N6-rate', rows: ['N6 rate'], tests: [`${ST}n6_a_flood_over_the_rate_cap`], edits: [
    { file: SB, find: 'if !s.rl_poll.take(now) {', replace: 'if false {' },
    { file: SB, find: 'if !s.rl_stats.take(now) {', replace: 'if false {' }] },
  { id: 'M-N6-poll-9th', rows: ['N6 poll 8/s, 9th is 429'], tests: [`${ST}n6_poll_limit_is_8`], edits: [
    { file: SB, find: 'rl_poll: Bucket::new(POLL_LIMIT_PER_S, POLL_LIMIT_PER_S),', replace: 'rl_poll: Bucket::new(1000, 1000),' }] },
  // alpha.9.4 (ask-11130717, ADR A11): only the start-up bench verdict persists; a runtime fallback is for this launch only.
  { id: 'M-F1-runtime-save', rows: ['F1 a runtime fallback is not saved (close() saves it again)'], tests: [`${ST}f1_a_runtime_fallback_is_not_remembered`, `${ST}f1_no_runtime_fallback_reason`, `${ST}f1_try_3d_anyway`, `${ST}f2_a_reload`, `${ST}f2_test_again`, `${ST}a_sleep_or_a_forward_step`, `${ST}a_perf_guard_fallback`], edits: [
    { file: SB, find: 'self.log(&format!("fallback {reason} pack={pack_id}"));', replace: 'self.log(&format!("fallback {reason} pack={pack_id}"));\n        if let Some(key) = self.key.clone() {\n            self.bench_memory.insert(key, Remembered::Fell(reason));\n            self.persist_bench();\n        }' }] },
  { id: 'M-F1-read-old', rows: ['F1 a runtime reason saved by an older build is not applied'], tests: [`${ST}a_runtime_fallback_saved_by_an_older_build`], edits: [
    { file: SB, find: 'Value::String(_) => None,', replace: 'Value::String(s) if s == "perf" => Some(Remembered::Fell("perf")),\n        Value::String(_) => None,' }] },
  { id: 'M-F1-plan', rows: ['F1 a saved bench failure opens the video room without a bench'], tests: [`${ST}a1_a_weak`, `${ST}a_bench_that_fails_all_three_windows`], edits: [
    { file: SB, find: '(None, Some(Remembered::Fell(reason))) => OpenPlan::Video(reason),', replace: '(None, Some(Remembered::Fell(_))) => OpenPlan::Bench,' }] },
  { id: 'M-CLOCK-step', rows: ['a wall-clock step moves the queue and the parked poll, cancels nothing'], tests: [`${ST}a_clock_step_cancels_nothing`, `${ST}a_clock_step_during_a_parked_poll`], edits: [
    { file: SB, find: 'if step.abs() <= CLOCK_STEP_MS {', replace: 'if true || step.abs() <= CLOCK_STEP_MS {' }] },
  { id: 'M-TRY-r5', rows: ['Try anyway: R5 not applied to the attempt'], tests: [`${ST}f1_try_3d_anyway`], edits: [
    { file: SB, find: 'if let Some(reason) = verdict(s, now, if s.forced { Live3d::On } else { mode }) {', replace: 'if let Some(reason) = verdict(s, now, mode) {' },
    { file: SB, find: '(verdict(s, now, if s.forced { Live3d::On } else { mode }), finished, script)', replace: '(verdict(s, now, mode), finished, script)' }] },
  { id: 'M-TRY-r3', rows: ['Try anyway: a dead guest is never hidden (R3 applies)'], tests: [`${ST}f1_try_3d_anyway`], edits: [
    { file: SB, find: 'if now.saturating_sub(polled) >= NO_POLL_MS {', replace: 'if !s.forced && now.saturating_sub(polled) >= NO_POLL_MS {' }] },
  { id: 'M-TRY-once', rows: ['Try anyway: one attempt only'], tests: [`${ST}f1_try_3d_anyway`], edits: [
    { file: SB, find: 'std::mem::take(&mut self.lock().try_once)', replace: 'self.lock().try_once' }] },
  { id: 'M-TRY-off', rows: ['Try anyway: off still wins'], tests: [`${ST}f1_try_3d_anyway`], edits: [
    { file: SB, find: 'if g.mode == Live3d::Off {', replace: 'if false {' }] },
  { id: 'M-F2-end', rows: ['F2 a clean close is not a fallback'], tests: [`${ST}f2_a_clean_close`], edits: [
    { file: SB, find: 'self.lock().sessions.remove(pack_id);', replace: 'let _ = pack_id;' }] },
  { id: 'M-F2-reload', rows: ['F2 a reload is a new document'], tests: [`${ST}f2_a_reload`], edits: [
    { file: SB, find: '*s = fresh;', replace: 'return Err(Refusal::new(409, "already_ready", "stage.ready is once per session"));' }] },
  { id: 'M-F2-again', rows: ['F2 Test again forgets the verdict'], tests: [`${ST}f2_test_again`], edits: [
    { file: SB, find: 'g.bench_memory.remove(&key);', replace: 'let _ = &key;' }] },
  { id: 'M-N6-seq', rows: ['N6 seq'], tests: [`${ST}n6_an_ack_outside`], edits: [
    { file: SB, find: 'if args.ack > s.seq_next - 1 || args.ack < s.acked {', replace: 'if false {' },
    { file: SB, find: 'if s.gap_reports >= 2 {', replace: 'if false {' }] },
  { id: 'M-producer-rate', rows: ['producer rate'], tests: [`${ST}the_producer_is_rate_limited`], edits: [{ file: SB, find: 'if !(s.out_all.take(now) && kind_ok) {', replace: 'if false {' }] },
  { id: 'M-N8', rows: ['N8'], tests: [`${ST}n8_`], edits: [{ file: SB, find: 'if !pack.stage {', replace: 'if !pack.avatar {' }] },
  { id: 'M-N9-url-id', rows: ['N9 lookup by URL id'], tests: [`${ST}n9_`], edits: [{ file: PH, find: '    let Some(pack) = state.pack_for(label) else {', replace: '    let url_id = split_pack_path(request.uri().path()).map(|(id, _)| id.to_string());\n    let by_url = url_id.and_then(|id| state.by_label.lock().unwrap().values().find(|p| p.id == id).cloned());\n    let _ = label;\n    let Some(pack) = by_url else {' }] },
  { id: 'M-N9-id-check', rows: ['N9 id != pack.id'], tests: [`${ST}n9_`], edits: [{ file: PH, find: 'if id != pack.id {', replace: 'if false {' }] },
  { id: 'M-N9-storage', rows: ['N9 storage containment'], tests: [`${ST}n9_`], edits: [{ file: PH, find: 'let parts = safe_rel(rel)?;', replace: "let parts: Vec<String> = rel.split('/').map(str::to_string).collect();" }] },
  { id: 'M-N10', rows: ['N10'], tests: [`${PT}n10_`], edits: [{ file: PH, find: '("net", Value::Array(a)) if a.is_empty() => {}', replace: '("net", Value::Array(_)) => {}' }] },
  { id: 'M-N11-load', rows: ['N11 load'], tests: [`${PT}n11_a_manifest`], edits: [{ file: PH, find: 'if !links.is_empty() {', replace: 'if false {' }] },
  { id: 'M-N11-runtime', rows: ['N11 runtime'], tests: [`${PT}n11_links_open`], edits: [{ file: PH, find: 'if pack.stage {', replace: 'if pack.stage && false {' }] },
  { id: 'M-N12', rows: ['N12'], tests: [`${PT}n12_`], edits: [{ file: PH, find: 'if !stage_allowed_for(&id) {', replace: 'if false {' }] },
  { id: 'M-api2', rows: ['api-2 manifest'], tests: [`${PT}an_api_1_manifest`], edits: [{ file: PH, find: 'if api < 2 {', replace: 'if false {' }] },
  { id: 'M-N13', rows: ['N13', 'A5'], tests: [`${ST}n13_`, `${ST}a5_`], edits: [{ file: SB, find: '(lo <= hi).then_some(hi)', replace: '{ let _ = (lo, hi); Some(CONTRACT_MAX) }' }] },
  { id: 'M-N14-single-poll', rows: ['N14 single poll'], tests: [`${ST}n14_a_second_poll`], edits: [{ file: SB, find: 's.poll_gen += 1;', replace: '' }] },
  { id: 'M-N14-bound', rows: ['N14 queue bound'], tests: [`${ST}n14_the_queue_is_bounded`], edits: [{ file: SB, find: 'n > QUEUE_MSGS || b > QUEUE_BYTES', replace: 'false' }] },
  { id: 'M-N14-cancel', rows: ['N14 cancel droppable'], tests: [`${ST}n14_cancel_and_the_latest_state`], edits: [{ file: SB, find: 'let Some(ix) = self.pending.iter().position(|(m, _)| m.kind() == Kind::Schedule) else { return Err(()) };', replace: 'let Some(ix) = self.pending.iter().position(|(m, _)| matches!(m.kind(), Kind::Schedule | Kind::Cancel)) else { return Err(()) };' }] },
  { id: 'M-N14-stale', rows: ['N14 stale schedule'], tests: [`${ST}n14_a_stale_schedule`], edits: [{ file: SB, find: 'HostMsg::Schedule { start_at, .. } if *start_at < now));', replace: 'HostMsg::Schedule { start_at, .. } if false && *start_at < now));' }] },
  { id: 'M-N15', rows: ['N15'], tests: [`${ST}n15_`], edits: [
    { file: SB, find: 'struct PollArgs {\n    v: Version,\n    ack: u32,\n    max: u8,\n}', replace: 'struct PollArgs {\n    v: Version,\n    ack: u32,\n    max: u8,\n    #[serde(default)]\n    flush: bool,\n}' },
    { file: SB, find: 's.last_poll_ms = now;\n    // A new poll', replace: 's.last_poll_ms = now;\n    if args.flush {\n        s.pending.clear();\n    }\n    // A new poll' }] },
  { id: 'M-N16-flavour', rows: ['N16 flavour'], tests: [`${PT}n16_pack_dir_is_judged`], edits: [{ file: PH, find: 'if !owner_build {', replace: 'if arg.is_none() {' }] },
  { id: 'M-N16-index', rows: ['N16 index'], tests: [`${PT}n16_a_pack_not_in_the_signed_index`], edits: [{ file: PH, find: 'let mut pack = load_pack_dir(&root, Some(id))?;\n    if !dev {', replace: 'let mut pack = load_pack_dir(&root, Some(id))?;\n    if !dev && false {' }] },
  { id: 'M-A1', rows: ['A1'], tests: [`${ST}a1_a_weak`], edits: [{ file: SB, find: 'if !pass {', replace: 'if false {' }] },
  { id: 'M-A1d', rows: ['A1d one slow bench second', 'A1e slow in all 3 windows'], tests: [`${ST}a1d_`, `${ST}a1e_`], edits: [{ file: SB, find: 'if !pass && b.judged < BENCH_WINDOWS && bench_fps_ok(&b.samples) {', replace: 'if false {' }] },
  { id: 'M-A1-fps', rows: ['A1 low fps is final at once'], tests: [`${ST}a1_a_weak`], edits: [{ file: SB, find: ' && bench_fps_ok(&b.samples) {', replace: ' {' }] },
  { id: 'M-A2', rows: ['A2'], tests: [`${ST}a2_`], edits: [{ file: SB, find: '>= READY_DEADLINE_MS', replace: '>= u64::MAX' }] },
  { id: 'M-A3', rows: ['A3'], tests: [`${ST}a3_`], edits: [{ file: SB, find: 'g.close(pack_id, "guest_gone");', replace: 'let _ = pack_id;' }] },
  { id: 'M-A4', rows: ['A4'], tests: [`${ST}a4_`], edits: [{ file: SB, find: 'if now.saturating_sub(polled) >= NO_POLL_MS {', replace: 'if false {' }] },
  { id: 'M-A6', rows: ['A6'], tests: [`${ST}a6_`], edits: [{ file: SB, find: 'close = s.refusals.len() >= REFUSALS_TO_CLOSE;', replace: 'close = false;' }] },
  { id: 'M-A7', rows: ['A7'], tests: [`${ST}a7_`], edits: [{ file: SB, find: 'if mode != Live3d::On {', replace: 'if false {' }] },
  { id: 'M-A8', rows: ['A8'], tests: [`${ST}a8_`], edits: [{ file: SB, find: 'Live3d::Off => return Err("off"),', replace: 'Live3d::Off => {}' }] },
  { id: 'M-A9-bench', rows: ['A9 bench under on'], tests: [`${ST}a9_`], edits: [{ file: SB, find: 'Live3d::On => OpenPlan::Open,', replace: 'Live3d::On => match remembered { Some(Remembered::Fell(_)) => OpenPlan::Video("bench"), _ => OpenPlan::Open },' }] },
  { id: 'M-A9-perf', rows: ['A9 R5 under on'], tests: [`${ST}a9_`], edits: [{ file: SB, find: 'if mode != Live3d::On {', replace: 'if true {' }] },
  { id: 'M-A10', rows: ['A10'], tests: [`${ST}a10_`], edits: [{ file: SB, find: 'let Some(s) = self.sessions.get_mut(pack_id) else { return };', replace: 'if self.mode == Live3d::On {\n            return;\n        }\n        let Some(s) = self.sessions.get_mut(pack_id) else { return };' }] },
  { id: 'M-A11', rows: ['A11'], tests: [`${ST}a11_`], edits: [{ file: SB, find: 'return Err(reason);\n                }\n            }\n            Live3d::On => {}', replace: 'let _ = reason;\n                }\n            }\n            Live3d::On => {}' }] },
];

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const COPY = ['tauri', 'docs/decisions/room-live-b', 'assets/rooms-video', 'package.json', 'src/main/owner-values.json']; // build.rs reads the last two

function copyTree(dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  for (const rel of COPY) {
    fs.cpSync(path.join(repo, rel), path.join(dest, rel), { recursive: true, filter: (src) => !/[\\/](target|node_modules)([\\/]|$)/.test(src) });
  }
}

function applyEdit(root, e) {
  const file = path.join(root, e.file);
  let text = fs.readFileSync(file, 'utf8');
  const crlf = text.includes('\r\n');
  const find = crlf ? e.find.replace(/\n/g, '\r\n') : e.find;
  const replace = crlf ? e.replace.replace(/\n/g, '\r\n') : e.replace;
  const n = text.split(find).length - 1;
  if (n === 0 || (n > 1 && !e.all)) throw new Error(`${e.file}: anchor found ${n} times: ${e.find.slice(0, 80)}`);
  text = text.split(find).join(replace);
  fs.writeFileSync(file, text);
}

function cargoTest(root, tests) {
  const r = spawnSync('cargo', ['test', '--lib', '--', ...tests], { cwd: path.join(root, 'tauri', 'src-tauri'), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: { ...process.env, CARGO_TARGET_DIR: target } });
  return { status: r.status, text: `${r.stdout || ''}\n${r.stderr || ''}` };
}

const failedNames = (text) => [...text.matchAll(/^test (\S+) \.\.\. FAILED$/gm)].map((m) => m[1]);
const passedNames = (text) => [...text.matchAll(/^test (\S+) \.\.\. ok$/gm)].map((m) => m[1]);

fs.mkdirSync(out, { recursive: true });
const pristine = path.join(work, 'pristine');
const mut = path.join(work, 'mut');
copyTree(pristine);
copyTree(mut);

// Anchors first: every edit must apply exactly once to the pristine sources.
for (const m of MUTATIONS) {
  const probe = path.join(work, 'probe');
  fs.rmSync(probe, { recursive: true, force: true });
  for (const f of new Set(m.edits.map((e) => e.file))) { fs.mkdirSync(path.dirname(path.join(probe, f)), { recursive: true }); fs.copyFileSync(path.join(pristine, f), path.join(probe, f)); }
  for (const e of m.edits) applyEdit(probe, e);
}
console.log(`anchors ok for ${MUTATIONS.length} mutations`);
if (anchorsOnly) process.exit(0);

console.log('building the pristine copy ...');
const base = cargoTest(pristine, []);
fs.writeFileSync(path.join(out, 'pristine-full.log'), base.text);
if (base.status !== 0) { console.error('the pristine copy does not pass cargo test --lib'); process.exit(1); }
console.log(`pristine: ${/test result: (.*)/.exec(base.text)?.[1]}`);

const results = [];
for (const m of MUTATIONS) {
  if (only && !only.has(m.id)) continue;
  const files = [...new Set(m.edits.map((e) => e.file))];
  for (const f of files) fs.copyFileSync(path.join(pristine, f), path.join(mut, f));
  for (const e of m.edits) applyEdit(mut, e);
  const red = cargoTest(mut, m.tests);
  fs.writeFileSync(path.join(out, `${m.id}.red.log`), red.text);
  const failed = failedNames(red.text);
  const expectedRed = m.tests.every((t) => failed.some((f) => f.includes(t)));
  for (const f of files) fs.copyFileSync(path.join(pristine, f), path.join(mut, f));
  const restored = files.every((f) => sha(fs.readFileSync(path.join(mut, f))) === sha(fs.readFileSync(path.join(pristine, f))));
  const green = cargoTest(pristine, m.tests);
  fs.writeFileSync(path.join(out, `${m.id}.green.log`), green.text);
  const ran = passedNames(green.text);
  const greenOk = green.status === 0 && m.tests.every((t) => ran.some((f) => f.includes(t)));
  const row = { id: m.id, rows: m.rows, tests: m.tests, redExit: red.status, redFailed: failed, mutationRed: red.status !== 0 && expectedRed, restoredHashEqual: restored, restoredGreen: greenOk };
  results.push(row);
  console.log(`${row.mutationRed && row.restoredHashEqual && row.restoredGreen ? 'OK  ' : 'FAIL'} ${m.id} [${m.rows.join(', ')}] red=${row.mutationRed} restored=${row.restoredHashEqual} green=${row.restoredGreen}`);
}
fs.writeFileSync(path.join(out, 'mutation-results.json'), JSON.stringify(results, null, 1));
const bad = results.filter((r) => !(r.mutationRed && r.restoredHashEqual && r.restoredGreen));
console.log(`${results.length - bad.length}/${results.length} mutations proven (red on the weakened copy, green on the restored one)`);
process.exit(bad.length ? 1 : 0);
