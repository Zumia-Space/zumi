// Generates scripts/fixtures/brain-board-state.json: a REAL boardView body (GET /api/v1/state as the owner sees it) from the vendored
// Laneboard server code, seeded only through real board writes (task.create, step.update, ask.raise, ask.answer, plan.add,
// attachment.add) on a fake clock, so the file is the same on every run. Used by scripts/check-brain.mjs and the Electron shots
// (T-31 slice 3 Brain). It is read by tests and shots only; no shipped code imports it.
//   node scripts/fixtures/make-brain-state.mjs [--out <file>]
// Tasks: T-31 (rich: 6 steps over 5 lanes, structure diagram, 2 plans, 2 attachments, an open and an answered ask), F-04 (a second
// task with its own steps/asks/plans/attachments: the AC-B2 negative control), C-52, H-03, P-02 (paused), Z-09 (closed).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ownerPath } from '../lib/owner-paths.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const out = args.includes('--out') ? path.resolve(args[args.indexOf('--out') + 1]) : path.join(ROOT, 'scripts', 'fixtures', 'brain-board-state.json');
const SCRATCH_ROOT = ownerPath('scratchRoot', os.tmpdir());
const dataDir = `${SCRATCH_ROOT}/brain-fixture-${process.pid}`;
if (!dataDir.startsWith(`${SCRATCH_ROOT}/`)) throw new Error('refusing a data dir outside the scratch root');
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });

const { createBoard } = await import(pathToFileURL(path.join(ROOT, 'vendor', 'laneboard', 'src', 'board.mjs')).href);
let clock = Date.parse('2026-10-27T08:00:00Z');
const now = () => (clock += 7 * 60 * 1000); // every board call is 7 minutes after the last: stable times, real ordering
const board = createBoard({ dataDir, now });
const owner = board.ownerCredential;
let n = 0;
const w = (op, target_id, data, extra = {}) => {
  const r = board.write(owner, { version: 1, request_id: `brain-${String(++n).padStart(4, '0')}`, op, target_id, data, ...extra });
  if (!r || r.ok === false) throw new Error(`fixture write ${op} ${target_id} failed: ${JSON.stringify(r)}`);
  return r;
};
const rev = (taskId, stepId) => board.state.steps[`${taskId}/${stepId}`].rev;
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

w('task.create', 'T-31', {
  title: 'Zumi agent: Brain panel (memory + task library)', status: 'doing', lane: 'Pi CoS', health: 'yellow', order: 1,
  goal: 'Let anh read every task and its dossier inside the app, with plan, diagram and media, and manage memory in the same panel.',
  now: '27-10 18:20: library and detail built against the board state; diagrams next.',
  next: 'Memory list against the fixture, then the three read-only host calls behind the CoS gate.',
  context: 'Two stores, one panel: the board stays the task database, Brain only reads it.',
  dossier: 'D:/data/notes/t31/next/PLAN-SLICE3-BRAIN.md',
  steps: [
    { id: 'plan', label: 'Slice 3 plan', zone: 'plan', state: 'done' },
    { id: 'library', label: 'Task library and detail', sub: 'AC-B1..B6', zone: 'build', state: 'done' },
    { id: 'diagrams', label: 'Step-flow and structure diagrams', sub: 'vendored layout, read-only', zone: 'build', state: 'active', detail: 'Boxes from layoutTask, SVG drawn in the panel.' },
    { id: 'memory', label: 'Memory list against a fixture', zone: 'test', state: 'todo' },
    { id: 'gate', label: 'Owner look at the Brain card', zone: 'owner', state: 'waiting' },
    { id: 'ship', label: 'Merge behind ZUMI_NEXT_UI', zone: 'ship', state: 'todo' },
  ],
  architecture: {
    format: 'graph',
    groups: [{ id: 'host', label: 'Host' }, { id: 'ui', label: 'Brain panel' }, { id: 'store', label: 'Stores' }],
    nodes: [
      { id: 'reader', label: 'Board reader', sub: 'cached 60 s', group: 'host' },
      { id: 'state', label: 'board.state', sub: 'read-only host call', group: 'host' },
      { id: 'library', label: 'Task library', group: 'ui' },
      { id: 'detail', label: 'Task detail', sub: 'steps, asks, plans, media', group: 'ui' },
      { id: 'board', label: 'Board (tasks)', group: 'store' },
      { id: 'memory', label: 'Memory (notes)', group: 'store' },
    ],
    edges: [
      { from: 'board', to: 'reader' }, { from: 'reader', to: 'state' }, { from: 'state', to: 'library' },
      { from: 'library', to: 'detail', label: 'open' }, { from: 'memory', to: 'library', dashed: true },
    ],
  },
});
w('task.create', 'F-04', {
  title: 'Wardrobe: outfit round 4', status: 'waiting', lane: 'Vesta', health: 'green', order: 2,
  goal: 'Pick the final look for outfit round 4.', now: 'Round 4 looks are ready; waiting for anh.',
  dossier: 'D:/data/notes/f04/round4/DOSSIER.md',
  steps: [
    { id: 'r4-render', label: 'Round 4 renders', zone: 'build', state: 'done' },
    { id: 'r4-pick', label: 'Round 4 looks ready for review', zone: 'owner', state: 'waiting' },
  ],
});
w('task.create', 'C-52', { title: 'Content factory: crawl + classify', status: 'doing', lane: 'Pi', health: 'green', order: 3, steps: [{ id: 'gate', label: 'Quality gate on 40 drafts', zone: 'test', state: 'active' }] });
w('task.create', 'H-03', { title: 'Hunter: job review board', status: 'doing', lane: 'Pi', health: 'red', order: 4, steps: [{ id: 'scan', label: 'Link scanner pass', zone: 'build', state: 'blocked' }] });
w('task.create', 'P-02', { title: 'Tidewell Tours: schedule page', status: 'paused', lane: 'Pi', health: 'grey', order: 5, steps: [{ id: 'page', label: 'Schedule page', zone: 'build', state: 'todo' }] });
w('task.create', 'Z-09', { title: 'Old: release 0.2.10 notes', status: 'closed', lane: 'Pi', health: 'green', order: 6, steps: [{ id: 'notes', label: 'Release notes', zone: 'ship', state: 'done' }] });

w('step.update', 'T-31/diagrams', { state: 'waiting' }, { expected_revision: rev('T-31', 'diagrams') });
w('step.update', 'T-31/diagrams', { state: 'active' }, { expected_revision: rev('T-31', 'diagrams') });
const open = w('ask.raise', 'T-31', { text: 'Name the sidebar item "Brain" or keep "Memory"?', step_id: 'gate', options: [{ key: 'A', label: 'Brain' }, { key: 'B', label: 'Memory' }] });
const done = w('ask.raise', 'T-31', { text: 'Should Brain edit tasks or only read them?', step_id: 'library' });
w('ask.answer', done.id ?? done.result?.id ?? Object.keys(board.state.asks).find((k) => board.state.asks[k].text.startsWith('Should Brain')), { text: 'Read only, edits go through Open on board.' }, { expected_revision: 1 });
w('ask.raise', 'F-04', { text: 'Pick the look for round 4 (A, B or C)', step_id: 'r4-pick', options: [{ key: 'A', label: 'Night blue' }, { key: 'B', label: 'White' }, { key: 'C', label: 'Both' }] });
w('plan.add', 'T-31', { reviewer: 'Fable', verdict: 'on-track', eta: 'after the gate', body: 'VERDICT: on-track\nETA: after the gate\n\nRead-only first: build the panel on the existing state, add the host calls only after the CoS gate.' });
w('plan.add', 'T-31', { reviewer: 'Sol', verdict: 'on-track', body: 'Keep the three host calls behind one gate; no new route, no write.' });
w('plan.add', 'F-04', { reviewer: 'Fable', verdict: 'on-track', body: 'Show A and B side by side at 1296 wide.' });
w('attachment.add', 'T-31', { name: 'brain-concept-a1.png', mime: 'image/png', data_base64: PNG, step_id: 'library', caption: 'Concept A-1' });
w('attachment.add', 'T-31', { name: 'brain-notes.md', mime: 'text/markdown', data_base64: Buffer.from('# Brain notes\n- read only\n').toString('base64') });
w('attachment.add', 'F-04', { name: 'f04-round4-looks.png', mime: 'image/png', data_base64: PNG, step_id: 'r4-pick' });

const view = JSON.parse(JSON.stringify(board.view(owner)));
// Stable file: nothing here is a credential (the view carries token ids/names only, no secret); the data dir is scratch.
fs.writeFileSync(out, JSON.stringify(view, null, 1) + '\n');
console.log(`wrote ${path.relative(ROOT, out)}: ${view.tasks.length} tasks, ${view.asks.length} asks, ${Object.values(view.plans).flat().length} plans, ${view.attachments.length} attachments`);
fs.rmSync(dataDir, { recursive: true, force: true });
