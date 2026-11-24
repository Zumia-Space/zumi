// Goal-QC text: the ONE formatter for a goalCheck, shared by the board server (legacy row ingest, src/adapt-legacy.mjs) and the
// CoS CLI (verify.mjs). Standalone on purpose (no imports), so a client copies or imports this file as is and never re-implements it.
//
// Contract (guards.mjs GOAL_QC_MESSAGE: "command or URL + expected result"):
//   string                      -> unchanged (callers clip it)
//   number / boolean            -> String(v)
//   { <check>, <expect> }       -> "<check> -> <expect>" (or "<check>" alone); check = cmd | command | url | check | text
//                                  (first readable), expect = expect | expected; parts are trimmed, numbers/booleans kept as
//                                  text. No readable check part (an expected result alone) -> undefined: it checks nothing.
//   [ ...goalChecks ]           -> each formatted, the readable ones joined with "; "
//   anything else               -> undefined (no goal check); never "[object Object]", never a JSON dump

export const GOAL_ARROW = ' -> ';
const CHECK_KEYS = ['cmd', 'command', 'url', 'check', 'text'];
const EXPECT_KEYS = ['expect', 'expected'];

const scalarText = v => (typeof v === 'string' ? v : (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean' ? String(v) : undefined);
/** A value as text: a string unchanged, a finite number or a boolean via String(), an array as its non-empty scalar items joined
 *  with "; " (objects, nested arrays, null and NaN items dropped); anything else (object, NaN, empty result) undefined. */
export const textOf = v => (Array.isArray(v) ? v.map(scalarText).filter(Boolean).join('; ') || undefined : scalarText(v));

const part = (o, keys) => {
  for (const k of keys) { const t = textOf(o[k])?.trim(); if (t) return t; }
  return undefined;
};

/** The goalCheck as one line of text, or undefined when it holds nothing readable (see the contract above). */
export function goalCheckText(g) {
  if (Array.isArray(g)) return g.map(goalCheckText).filter(Boolean).join('; ') || undefined;
  if (g === null || typeof g !== 'object') return textOf(g);
  const check = part(g, CHECK_KEYS), expect = part(g, EXPECT_KEYS);
  return check ? (expect ? check + GOAL_ARROW + expect : check) : undefined; // an expected result alone checks nothing
}
