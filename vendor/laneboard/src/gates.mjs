// A gate's stable key (J-05). CoS writes gate labels as prose — "S1 render r1 (timeout: hung ssh,
// zero diff)" then "S1 render r2 (slow)" — so counting on the exact string gave every attempt its own
// key and the two-fail fallback never fired. This turns such a label into one short key ("s1-render").
// Pure and total: any input yields '' or a string of [a-z0-9-], at most GATE_MAX characters (`max` is
// only for a caller that must tell truncation from an exact key, e.g. checking an explicit --gate).
// The same rule is inlined in cli-snapshot/cos-board.mjs (that snapshot deploys on its own); keep them equal.
export const GATE_MAX = 40;

export function normalizeGate(raw, max = GATE_MAX) {
  let s = String(raw ?? '').toLowerCase().trim();
  // Parentheticals carry the attempt's symptoms, not its identity; drop them, including an unterminated one.
  s = s.replace(/\([^)]*\)/g, ' ').replace(/\(.*$/, ' ');
  // A trailing round marker ("r1", "round 2", "#3") is the attempt number, not a different gate.
  // The marker alone ("r1") is kept: stripping it would leave no key at all.
  const stripped = s.replace(/[\s_-]+(?:round|r|#)\s*\d+\s*$/, '');
  if (stripped.trim()) s = stripped;
  s = s.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s.slice(0, max).replace(/-+$/, '');
}
