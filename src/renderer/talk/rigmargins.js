// Margins of a RigProbe result against its cut-offs, and the margin guard (coordinator 01-10): the cut-offs stay
// where they are (through-body 1.0, elbow 155 deg, twist 75 deg/frame, head 0.97, feet 1 cm), but a gesture that passes
// with less than 5 % to spare is WARNED, not failed — so a model change (the F-04 lock) or a rig change that pushes the
// approved gestures towards a limit surfaces before anything breaks.
//   margin = how far the measured value is inside its cut-off, as a ratio (1.0 = exactly on the line, 1.3 = 30 % room).
export const CUTOFFS = { headF: 0.97, bodyF: 1.0, flexDeg: 155, twistDeg: 75, feetM: 0.01 };
export const WARN_BELOW = 1.05;

const ratio = (num, den) => (den > 0 ? +(num / den).toFixed(3) : null); // null = nothing measured (no contact, no feet motion)

// rules: RigProbe.check(...).rules -> { margins: {head, body, elbow, twist, feet}, warnings: [{rule, margin, value, cutoff}] }
export function rigMargins(rules) {
  const m = {
    head: rules.R1 && Number.isFinite(rules.R1.minF) ? ratio(rules.R1.minF, CUTOFFS.headF) : null,
    body: rules.R2 && rules.R2.deepest ? ratio(rules.R2.deepest.f, CUTOFFS.bodyF) : null,
    elbow: rules.R3 && rules.R3.maxFlexDeg > 0 ? ratio(CUTOFFS.flexDeg, rules.R3.maxFlexDeg) : null,
    twist: rules.R3 && rules.R3.maxTwistDeg > 0 ? ratio(CUTOFFS.twistDeg, rules.R3.maxTwistDeg) : null,
    feet: rules.R4 && rules.R4.maxDriftM > 0 ? ratio(CUTOFFS.feetM, rules.R4.maxDriftM) : null,
  };
  const value = { head: rules.R1 && rules.R1.minF, body: rules.R2 && rules.R2.deepest && rules.R2.deepest.f, elbow: rules.R3 && rules.R3.maxFlexDeg, twist: rules.R3 && rules.R3.maxTwistDeg, feet: rules.R4 && rules.R4.maxDriftM };
  const cutoff = { head: CUTOFFS.headF, body: CUTOFFS.bodyF, elbow: CUTOFFS.flexDeg, twist: CUTOFFS.twistDeg, feet: CUTOFFS.feetM };
  // only rules that PASS can warn: a failing rule is already a failure
  const passing = { head: rules.R1 && rules.R1.ok, body: rules.R2 && rules.R2.ok, elbow: rules.R3 && rules.R3.maxFlexDeg <= CUTOFFS.flexDeg, twist: rules.R3 && rules.R3.maxTwistDeg <= CUTOFFS.twistDeg, feet: rules.R4 && rules.R4.ok };
  const warnings = Object.keys(m).filter((k) => passing[k] && m[k] != null && m[k] < WARN_BELOW).map((k) => ({ rule: k, margin: m[k], value: value[k], cutoff: cutoff[k] }));
  return { margins: m, warnings };
}
