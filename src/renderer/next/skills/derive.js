// T-31 slice 2: pure functions from counts to what the Skills page shows. No DOM, no clock, no storage, so a plain
// Node table test (scripts/check-skills.mjs) can rebuild every node from a signal fixture (AC-S1).
//
// signals = {
//   days, turns, touches, gestures,            high-water counts from the progress store
//   calls: { plan, check, lookup },            high-water Plan / Check / Look up calls
//   roles: { plan: { on }, check: { on }, lookup: { on } } | null,   live roles.get (null = no provider yet)
//   memory: boolean,                           window.zumi.memory exists (Tauri after M3)
//   held: { [nodeId]: lvl },                   high-water node levels already stored
// }
import { BRANCHES, NODES, SIGNALS, MAX_LVL } from './catalog.js';
import { PLACEHOLDER as P } from './constants.js';

// Level of a count against a node's thresholds: the number of thresholds reached, 0..MAX_LVL.
export function lvlOf(count, thresholds) {
  let lvl = 0;
  for (const need of thresholds) if (count >= need) lvl++;
  return Math.min(lvl, MAX_LVL);
}

// One rendered node: { id, branch, parent, kind, label, how, role?, status: locked|available|learned, lvl, maxLvl,
// resting, count, next }. `resting` = learned but its role is switched off now: it stays learned, its level stays.
/** Has she learned anything to show? Nothing learned, the page is one level card and a locked tree. */
export function hasLearnedSkill(view) {
  return Boolean(view && Array.isArray(view.nodes) && view.nodes.some((n) => n.kind !== 'base' && n.status === 'learned')); // a base node is lit on day one
}

export function derive(signals = {}) {
  const held = (signals && signals.held) || {};
  const roles = signals && signals.roles ? signals.roles : null;
  const lvls = new Map();
  for (const n of NODES) lvls.set(n.id, Math.max(lvlOf(SIGNALS[n.signal](signals || {}), n.thresholds), Math.min(MAX_LVL, Number(held[n.id]) || 0)));
  const nodes = NODES.map((n) => {
    const count = SIGNALS[n.signal](signals || {});
    const lvl = lvls.get(n.id);
    const status = lvl >= 1 ? 'learned' : (n.parent && lvls.get(n.parent) < 1 ? 'locked' : 'available');
    const role = n.role && roles && roles[n.role];
    return {
      id: n.id, branch: n.branch, parent: n.parent, kind: n.kind, label: n.label, how: n.how, role: n.role || null,
      status, lvl, maxLvl: MAX_LVL, resting: lvl >= 1 && Boolean(role) && role.on === false,
      count, next: lvl < MAX_LVL ? n.thresholds[lvl] : null,
    };
  });
  const memory = Boolean(signals && signals.memory);
  const branches = BRANCHES.filter((b) => b.requires !== 'memory' || memory)
    .map((b) => ({ id: b.id, label: b.label, nodes: nodes.filter((x) => x.branch === b.id) }));
  return { branches, nodes, learned: nodes.filter((x) => x.status === 'learned').length, total: nodes.length };
}

// ---------- level and closeness (shapes from SPEC-skills.md; every constant is a PLACEHOLDER, see constants.js) ----------
export const xpOf = (days, lvlSum) => P.XP_PER_DAY * Math.max(0, days | 0) + P.XP_PER_SKILL_LVL * Math.max(0, lvlSum | 0);
const need = (n) => (P.LEVEL_STEP * n * (n + 1)) / 2; // cumulative xp that completes level n

// { lvl, from, to }: Lv 1 at xp 0; Lv n+1 once xp >= need(n). `from`/`to` bound the current level for the xp bar.
export function levelOf(xp) {
  let n = 0;
  while (xp >= need(n + 1)) n++;
  return { lvl: n + 1, from: need(n), to: need(n + 1) };
}

export function dailyPoints(turns, touches) {
  return Math.min(P.CLOSE_DAY_CAP, Math.max(0, turns | 0) + Math.min(P.CLOSE_TOUCH_CAP, Math.max(0, touches | 0) * P.CLOSE_TOUCH_WEIGHT));
}

// { tier: 1..N, pct: 0..100 toward the next tier (100 at the top tier), toNext: whole closeness points still missing for the next tier
//   (null at the top tier) }. The tier comes from closeness points only; no level takes part.
export function closenessOf(points) {
  const tiers = P.CLOSE_TIERS;
  let i = 0;
  while (i + 1 < tiers.length && points >= tiers[i + 1]) i++;
  const top = i + 1 >= tiers.length;
  const pct = top ? 100 : Math.floor(((points - tiers[i]) / (tiers[i + 1] - tiers[i])) * 100);
  return { tier: i + 1, pct: Math.max(0, Math.min(100, pct)), toNext: top ? null : Math.max(1, Math.ceil(tiers[i + 1] - points)) };
}
