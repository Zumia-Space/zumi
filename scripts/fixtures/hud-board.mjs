// FIXTURE board for the HUD harness (scripts/electron-hud.cjs): a scratch Laneboard (the vendored server code,
// vendor/laneboard) in its own data folder, seeded with a few tasks and owner asks through real board writes, and served
// the way the owner's local mirror serves it: GET /api/v1/state as the owner sees it, on 127.0.0.1 only. The app reads
// it through ZUMI_TEST_BOARD_MIRROR, so a harness run never touches the owner's real board or mirror.
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** -> { origin, update(taskId, stepId, patch), addTask(taskId, data), raise(taskId, text), close() } */
export async function startHudBoard({ dataDir, port: wantPort = 0 }) {
  const { createBoard } = await import(pathToFileURL(path.join(ROOT, 'vendor', 'laneboard', 'src', 'board.mjs')).href);
  const board = createBoard({ dataDir });
  const owner = board.ownerCredential;
  let n = 0;
  const w = (op, target_id, data, extra = {}) => {
    const r = board.write(owner, { version: 1, request_id: `hud-${String(++n).padStart(4, '0')}`, op, target_id, data, ...extra });
    if (!r || r.ok === false) throw new Error(`fixture write ${op} ${target_id} failed: ${JSON.stringify(r)}`);
    return r;
  };
  const stepRev = (taskId, stepId) => board.state.steps[`${taskId}/${stepId}`].rev;
  w('task.create', 'T-31', {
    title: 'Zumi agent: HUD hologram + task reactions', status: 'doing', lane: 'Pi CoS', health: 'yellow',
    // Panel fields (T-31 hud-panels, PLAN section 2): a goal and a now with a trailing ref line each, so the harness
    // proves the feed drops the ref lines and keeps the sentence.
    goal: 'Ship the three HUD panel designs so anh picks the look and where it sits in the talk view.\n`C:/data/hud-build/PLAN.md` · [plan](https://example.invalid/plan)',
    now: '23-10 16:40: T1 card and T2 step list built, wiring the panel into the left group.\n`C:/data/hud-build/LOG.md`',
    steps: [
      { id: 'chair', label: '3D chair in the talk view', zone: 'build', state: 'done' },
      { id: 'hud', label: 'HUD panels at the talk camera', sub: 'T1 card, T2 steps, T3 log (50,4%)', zone: 'build', state: 'active', detail: 'Styles A and B behind a setting, default off.' },
      { id: 'chart', label: 'Steps-finished chart', sub: 'last 7 days from the board times', zone: 'build', state: 'active' },
      { id: 'qc', label: 'Owner QC in the app', zone: 'owner', state: 'todo' },
    ],
  });
  w('task.create', 'F-04', { title: 'Wardrobe: outfit round 4', status: 'waiting', lane: 'Vesta', steps: [
    { id: 'r4', label: 'Round 4 looks ready for review', zone: 'owner', state: 'waiting' },
  ] });
  w('task.create', 'C-52', { title: 'Content factory: crawl + classify', status: 'doing', lane: 'Pi', steps: [
    { id: 'gate', label: 'Quality gate on 40 drafts', zone: 'test', state: 'active' },
  ] });
  w('task.create', 'H-03', { title: 'Hunter: job review board', status: 'doing', lane: 'Pi', steps: [
    { id: 'scan', label: 'Link scanner pass', zone: 'build', state: 'blocked' },
  ] });
  w('ask.raise', 'F-04', { text: 'Pick the look for round 4 (A, B or C)', step_id: 'r4', options: [{ key: 'A', label: 'Night blue' }, { key: 'B', label: 'White' }, { key: 'C', label: 'Both' }] });
  w('ask.raise', 'C-52', { text: 'Publish the 12 drafts that passed the gate?' });
  w('ask.raise', 'T-31', { text: 'Task card, step list or log as the default panel?', step_id: 'qc', options: [{ key: 'T1', label: 'Task card' }, { key: 'T2', label: 'Step list' }, { key: 'T3', label: 'Log and chart' }] });
  // Three real step state changes: they are what fills state.times[`TASK/STEP`].transitions, i.e. the T3 step log and the
  // steps-finished chart. The board writes them itself (server clock), so the panel never invents a row or a time.
  w('step.update', 'T-31/hud', { state: 'waiting' }, { expected_revision: stepRev('T-31', 'hud') });
  w('step.update', 'T-31/hud', { state: 'active' }, { expected_revision: stepRev('T-31', 'hud') });
  w('step.update', 'T-31/qc', { state: 'done' }, { expected_revision: stepRev('T-31', 'qc') });

  const server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    if (req.method !== 'GET' || p !== '/api/v1/state') { res.writeHead(404); return res.end('{"error":"not_found"}'); }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(board.view(owner)));
  });
  const port = await new Promise((r) => server.listen(wantPort, '127.0.0.1', () => r(server.address().port)));

  return {
    origin: `http://127.0.0.1:${port}`,
    /** A new board update on one task: a step changes (and may carry an acceptance file as its trailing ref line). */
    update(taskId, stepId, patch) { return w('step.update', `${taskId}/${stepId}`, patch, { expected_revision: stepRev(taskId, stepId) }); },
    /** A whole new open task (crowds the "Task updates" list: the feed keeps the 5 most recently active). */
    addTask(taskId, data) { return w('task.create', taskId, data); },
    raise(taskId, text, stepId) { return w('ask.raise', taskId, { text, ...(stepId ? { step_id: stepId } : {}) }); },
    close: () => new Promise((r) => server.close(() => r())),
  };
}
