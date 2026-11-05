'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
// check-kokoro-live preconditions (T-31 0.2.11). The latency budget is asserted only on the idle render box, and a run
// there must never silently skip it. Pure decision, every input injected, so each branch is testable headlessly.
//
// Render-box identity comes from the environment, never from this repo: the render box's run scripts (spare tooling)
// set BOTH
//   ZUMI_ELECTRON_HOST=box                  (what electron-guard.cjs already checks)
//   ZUMI_RENDER_BOX_HOSTS=<host>[,<host>…]  the hostname(s) allowed to be the render box, e.g. <host> (the
//                                           first spare PC; example only, case-insensitive, spaces trimmed)
// and the two must agree with os.hostname():
//   env=box, hosts missing or hostname not listed -> INVALID (renamed / reinstalled / second box would otherwise fall
//                                                    back to INFO and exit 0 with the budget skipped)
//   hostname listed but env!=box                  -> INVALID (budget would be skipped)
//   neither                                       -> INFO (main PC, CI)
// Not the box lock folder either: that folder is also readable on anh's main PC.
const RENDER_BOX_HOSTS_ENV = 'ZUMI_RENDER_BOX_HOSTS';
// Render-box marker file: <git-common-dir>/zumi-render-box (`git rev-parse --git-common-dir`), one line = the box
// hostname. Inside .git, so git can never commit it, and every worktree of that clone shares it. The box runner (in
// cos-tools, NOT part of this repo) writes it once on the box. When the marker exists the check cross-checks it:
// env != box -> INVALID; env=box with ZUMI_RENDER_BOX_HOSTS missing/not listing the host -> INVALID; marker hostname
// != os.hostname() -> INVALID (case-insensitive). Marker absent -> the env/hosts logic above, unchanged.
// Box evidence is accepted ONLY when the log has "RUNINFO host=<box> mode=ASSERT ... marker=yes" plus the
// "PASS first-audio latency=<ms> budget=1650" line; an INFO line, or no RUNINFO, is not box evidence.
const MARKER_NAME = 'zumi-render-box';
// INVALID = the run could not assert what it exists to assert. Same code as box-e2e-update.mjs's "box busy, nothing
// done" refusal (scripts/ has no other non-0/1/2 convention); 1 stays "a check failed", 2 "crashed".
const EXIT_INVALID = 3;
// Box counts as idle when system CPU load over IDLE_SAMPLE_MS is below this fraction. Justification (release-0211/
// assembly/kokoro-flake/RESULTS.txt, 20 runs): chunk-0 synth time is CPU-bound and ranged 779-1349 ms with machine
// load; latency = synth + ~205 ms, so the 1650 ms budget breaks at synth ~1445 ms (1.8x the fastest run). A background
// load L leaves (1-L) of the CPU, i.e. a ~1/(1-L) synth slowdown: L=0.25 -> 1.33x (~1050 ms synth, ~1255 ms latency,
// inside budget); L=0.44 would already reach the budget, so 0.25 keeps a safety margin. The 1/(1-L) model is INFERRED,
// not measured: every run logs "cpu=<load> latency=<ms>" (formatRunLine) so the threshold can be re-derived from box data.
const IDLE_CPU_LOAD_MAX = 0.25;
const IDLE_SAMPLE_MS = 3000;
// Image names (lowercase) that mean the app is running and competing for the CPU.
const BUSY_PROCESS_RE = /^(electron|zumi)[^\\/]*\.exe$/;

/** Comma-separated host list -> upper-case names, empty entries dropped. */
function parseHosts(value) {
  return String(value || '').split(',').map((h) => h.trim().toUpperCase()).filter(Boolean);
}

/**
 * deps: { hostname, env, readMarker: () => string|null, sampleLoad: async () => 0..1, listProcesses: () => string[] }
 * Returns { mode: 'ASSERT' | 'INFO' | 'INVALID', reason, marker: boolean, load? } (load = the sampled CPU load, when
 * one was taken). readMarker returns the marker's hostname, or null when there is no marker; a throw with code ENOENT
 * counts as "no marker", any other throw is INVALID. listProcesses may throw (unreadable process table): the caller
 * treats that as INVALID, it must never read as "nothing else is running".
 */
async function evaluatePreconditions({ hostname, env, readMarker, sampleLoad, listProcesses }) {
  let marker = null;
  try { marker = readMarker(); } catch (e) {
    if (!e || e.code !== 'ENOENT') return { mode: 'INVALID', reason: `cannot read the render-box marker (${MARKER_NAME}): ${e && (e.code || e.message)}`, marker: false };
  }
  const hasMarker = marker !== null && marker !== undefined;
  const hosts = parseHosts(env[RENDER_BOX_HOSTS_ENV]);
  const upperHost = String(hostname || '').toUpperCase();
  const listed = hosts.includes(upperHost);
  const envBox = env.ZUMI_ELECTRON_HOST === 'box';
  const invalid = (reason) => ({ mode: 'INVALID', reason, marker: hasMarker });
  if (hasMarker && !envBox) return invalid(`render-box marker (${MARKER_NAME}) exists but ZUMI_ELECTRON_HOST=box is missing; the latency budget would be skipped`);
  if (envBox && !hosts.length) return invalid(`ZUMI_ELECTRON_HOST=box but ${RENDER_BOX_HOSTS_ENV} is missing; cannot tell which host the render box is`);
  if (envBox && !listed) return invalid(`ZUMI_ELECTRON_HOST=box but host ${hostname} is not in ${RENDER_BOX_HOSTS_ENV} (${hosts.join(', ')}); renamed or second box? the latency budget would be skipped`);
  if (hasMarker && String(marker).trim().toUpperCase() !== upperHost) return invalid(`render-box marker (${MARKER_NAME}) names host "${String(marker).trim()}" but this host is ${hostname}`);
  if (listed && !envBox) return invalid(`host ${hostname} is a render box but ZUMI_ELECTRON_HOST=box is missing; the latency budget would be skipped`);
  // Every run that goes on to run the check samples the load, so each run leaves one cpu+latency data point.
  if (!envBox) return { mode: 'INFO', reason: `host ${hostname} is not a render box`, marker: hasMarker, load: await sampleLoad() };
  const busy = listProcesses().filter((n) => BUSY_PROCESS_RE.test(String(n).toLowerCase()));
  if (busy.length) return invalid(`render box is not idle: ${[...new Set(busy)].join(', ')} running`);
  const load = await sampleLoad();
  // `!(x < max)` so an unreadable (NaN) sample is INVALID, not idle.
  if (!(load < IDLE_CPU_LOAD_MAX)) return { ...invalid(`render box is not idle: CPU load ${(load * 100).toFixed(0)}% over ${IDLE_SAMPLE_MS} ms, limit ${(IDLE_CPU_LOAD_MAX * 100).toFixed(0)}%`), load };
  return { mode: 'ASSERT', reason: `render box idle (CPU ${(load * 100).toFixed(0)}%)`, marker: hasMarker, load };
}

/** Reads <git-common-dir>/zumi-render-box (first line, trimmed). null = no marker: the file is absent, or this is not a
 *  git checkout at all (source archive, CI cache) so no marker can exist. Any other read error throws (-> INVALID). */
function readMarkerFile(repoRoot = path.join(__dirname, '..', '..')) {
  const r = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd: repoRoot, encoding: 'utf8' });
  if (r.error || r.status !== 0) return null;
  const file = path.resolve(repoRoot, r.stdout.trim(), MARKER_NAME);
  try { return fs.readFileSync(file, 'utf8').split('\n')[0].trim(); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

/** The one per-run data line (grep RUNINFO): host, mode, sampled CPU load, measured latency, budget. */
function formatRunLine({ hostname, mode, load, latency, budget, marker = false }) {
  return `RUNINFO host=${hostname} mode=${mode} cpu=${(load * 100).toFixed(1)}% latency=${latency}ms budget=${budget}ms marker=${marker ? 'yes' : 'no'}`;
}

/**
 * System-wide busy fraction 0..1 between two os.cpus() snapshots: every core's user+nice+sys+irq+idle ticks summed, busy
 * = 1 - idle/total. Total over ALL logical cores (not one core, not per-core max), the same quantity as Task Manager's
 * "CPU" and the Windows "\Processor(_Total)\% Processor Time" counter; checked against that counter on the main PC
 * (36 logical cores) at 4 load levels, equal to within 0.3 points. NaN when no ticks elapsed (never reads as idle).
 */
function cpuLoadBetween(cpusBefore, cpusAfter) {
  const sum = (cpus) => cpus.reduce((a, c) => ({ idle: a.idle + c.times.idle, total: a.total + Object.values(c.times).reduce((x, y) => x + y, 0) }), { idle: 0, total: 0 });
  const a = sum(cpusBefore);
  const b = sum(cpusAfter);
  const total = b.total - a.total;
  return total > 0 ? 1 - (b.idle - a.idle) / total : NaN;
}

/** Real system CPU load over `ms` (one window: snapshot, wait, snapshot). */
function sampleCpuLoad(ms = IDLE_SAMPLE_MS) {
  const os = require('node:os');
  const before = os.cpus();
  return new Promise((resolve) => setTimeout(() => resolve(cpuLoadBetween(before, os.cpus())), ms));
}

/** Image names of running processes (tasklist on Windows, ps elsewhere). Throws if the listing fails. */
function listRunningProcesses() {
  const win = process.platform === 'win32';
  const r = win ? spawnSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8' }) : spawnSync('ps', ['-A', '-o', 'comm='], { encoding: 'utf8' });
  if (r.error || r.status !== 0) throw new Error(`cannot list processes: ${r.error ? r.error.message : r.stderr}`);
  return r.stdout.split(/\r?\n/).filter(Boolean).map((l) => (win ? (l.match(/^"([^"]+)"/) || [])[1] : l.trim().split('/').pop())).filter(Boolean);
}

module.exports = { RENDER_BOX_HOSTS_ENV, MARKER_NAME, readMarkerFile, EXIT_INVALID, IDLE_CPU_LOAD_MAX, IDLE_SAMPLE_MS, evaluatePreconditions, formatRunLine, cpuLoadBetween, sampleCpuLoad, listRunningProcesses };
