// Machine registry (J-05 worker-machine-0811). The ONE file that names the machines a task can run on. Used by the
// server (src/machines.mjs re-exports it: op validation, view fields) and by the page (public/app.js: the machine
// picker and the "Điều phối · Làm" line). The CoS CLI and the main-PC route hook only read the machine ids it returns.
//
// Owner 08-11: "ví dụ điều phối ở máy này nhưng woker chính ở máy số 2 và máy số 3" — the model pick says WHICH model,
// the machine pick says WHERE it runs. A task's route therefore has:
//   coordinator        the machine whose session coordinates the task (default main)
//   worker_machines    one or more machines that do the work (default [main])
//   roles.<r>.machine  the machine of one role slot (an explicit pick while it is one of the workers, else worker_machines[0])
// A task with no stored entry (every task written before this change) reads the defaults; the server then sends no
// machine fields at all, so every view written before this change stays byte-identical.
//
// Loaded as a classic script in the browser (sets window.LaneMachines) and importable in Node (sets globalThis.LaneMachines).
(function (root) {
  'use strict';
  const MACHINES = {
    main: { id: 'main', label: 'Máy 1', nick: 'main', lanes: [], reach: 'local session (Agent tool)' },
    spare: { id: 'spare', label: 'Máy 2', nick: 'spare', lanes: ['pi2', 'vesta2'], reach: 'mail lane (pi2 / vesta2)' },
    laptop: { id: 'laptop', label: 'Máy 3', nick: 'laptop', lanes: [], reach: 'ssh + worktree + claude -p (or mail cos with the brief)' }
  };
  const MACHINE_IDS = Object.keys(MACHINES);
  const DEFAULT_COORDINATOR = 'main', DEFAULT_WORKERS = ['main'];
  const isMachine = id => Object.prototype.hasOwnProperty.call(MACHINES, id);

  /** The task-level machine fields as a reader sees them: the stored entry, else the defaults (by 'default'). */
  function resolveMachines(entry) {
    if (!entry) return { coordinator: DEFAULT_COORDINATOR, worker_machines: DEFAULT_WORKERS.slice(), by: 'default' };
    const workers = entry.worker_machines && entry.worker_machines.length ? entry.worker_machines.slice() : DEFAULT_WORKERS.slice();
    return { coordinator: entry.coordinator || DEFAULT_COORDINATOR, worker_machines: workers, by: entry.by || 'default' };
  }
  /** The machine of one role slot: its own pick while that is one of the workers, else worker_machines[0]. */
  function slotMachine(entry, role) {
    const m = resolveMachines(entry), pick = entry && entry.slots ? entry.slots[role] : undefined;
    return m.worker_machines.includes(pick) ? pick : m.worker_machines[0];
  }
  /** "Máy 3 (laptop)" — the label, and the nick in brackets when asked for. */
  const machineText = (id, nick) => (isMachine(id) ? MACHINES[id].label + (nick ? ` (${MACHINES[id].nick})` : '') : String(id));

  root.LaneMachines = { MACHINES, MACHINE_IDS, DEFAULT_COORDINATOR, DEFAULT_WORKERS, isMachine, resolveMachines, slotMachine, machineText };
})(typeof window !== 'undefined' ? window : globalThis);
