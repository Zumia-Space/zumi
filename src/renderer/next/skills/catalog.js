// T-31 slice 2: the Skills catalog (SPEC-skills.md "First slice", PLAN-NEXT §3.2). Static data only: which nodes
// exist, where they hang, and which signal each one reads. Labels are i18n keys (en/vi/zh live in i18n.js).
//
// A signal is a COUNT the page can rebuild from existing operations only: `usage.summary` (calls per kind per day),
// `roles.get` (on/off), the renderer's touch events and the gesture-cache size, all kept as high-water counts in the
// progress store (store.js), because the live sources can go down (30-day window, cache cleared on avatar change,
// a role switched off). `thresholds[i]` is the count that reaches level i+1; a base node starts at 0 so it is lit on
// a fresh profile. Thresholds follow PLAN-NEXT §3.2 where it names them; the rest are placeholders like the pace in
// constants.js and are fixed after G-VIS together with the final node list.

export const MAX_LVL = 3;

// Mind is listed so the capability check has one place to look: it shows only where `window.zumi.memory` exists
// (Tauri after memory M3). Its nodes land with skills slice 2 of the plan; until then the branch has none.
export const BRANCHES = Object.freeze([
  { id: 'talk', label: 'skills.branch.talk' },
  { id: 'crew', label: 'skills.branch.crew' },
  { id: 'body', label: 'skills.branch.body' },
  { id: 'mind', label: 'skills.branch.mind', requires: 'memory' },
]);

export const NODES = Object.freeze([
  { id: 'talk.chat', branch: 'talk', parent: null, kind: 'base', signal: 'days', thresholds: [0, 7, 30] },
  { id: 'talk.conversation', branch: 'talk', parent: 'talk.chat', kind: 'learned', signal: 'turns', thresholds: [10, 100, 1000] },
  { id: 'crew.orchestrator', branch: 'crew', parent: null, kind: 'learned', signal: 'crewCalls', thresholds: [1, 50, 500] },
  { id: 'crew.plan', branch: 'crew', parent: 'crew.orchestrator', kind: 'learned', signal: 'calls.plan', role: 'plan', thresholds: [1, 20, 200] },
  { id: 'crew.check', branch: 'crew', parent: 'crew.orchestrator', kind: 'learned', signal: 'calls.check', role: 'check', thresholds: [1, 20, 200] },
  { id: 'crew.lookup', branch: 'crew', parent: 'crew.orchestrator', kind: 'learned', signal: 'calls.lookup', role: 'lookup', thresholds: [1, 20, 200] },
  { id: 'body.touch', branch: 'body', parent: null, kind: 'learned', signal: 'touches', thresholds: [1, 20, 100] },
  { id: 'body.gesture', branch: 'body', parent: null, kind: 'learned', signal: 'gestures', thresholds: [1, 5, 15] },
].map((n) => Object.freeze({ ...n, label: `skills.node.${n.id}`, how: `skills.how.${n.id}`, thresholds: Object.freeze(n.thresholds) })));

// signal name -> count, read from a signals object (see derive.js for its shape). Missing numbers read as 0.
const num = (x) => (Number.isFinite(x) && x > 0 ? Math.floor(x) : 0);
export const SIGNALS = Object.freeze({
  days: (s) => num(s.days),
  turns: (s) => num(s.turns),
  crewCalls: (s) => num(s.calls && s.calls.plan) + num(s.calls && s.calls.check) + num(s.calls && s.calls.lookup),
  'calls.plan': (s) => num(s.calls && s.calls.plan),
  'calls.check': (s) => num(s.calls && s.calls.check),
  'calls.lookup': (s) => num(s.calls && s.calls.lookup),
  touches: (s) => num(s.touches),
  gestures: (s) => num(s.gestures),
});
