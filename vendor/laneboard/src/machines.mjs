// Server side of the machine registry: public/machines.js is the one copy (shared with the page), this only re-exports it.
import '../public/machines.js';

export const { MACHINES, MACHINE_IDS, DEFAULT_COORDINATOR, DEFAULT_WORKERS, isMachine, resolveMachines, slotMachine, machineText } = globalThis.LaneMachines;

/** The role slots with `machine` on each (slotMachine). */
export const withSlotMachines = (roles, entry) => Object.fromEntries(Object.entries(roles).map(([r, s]) => [r, { ...s, machine: slotMachine(entry, r) }]));
