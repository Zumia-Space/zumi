// T-31 3a-3 (GATE-SEC-3a-3 C4): stage the next-UI flag beside the host exe. Only a build whose renderer was built with the next-version UI
// (build/renderer/next-ui.json says {"nextUi":true}, written by scripts/build-renderer.mjs) gets the file; every other build stages nothing,
// so the sidecar (next-ui-flag.mjs, fail-closed) leaves Brain's three board calls out of its method table. flavour.json is not touched.
import fs from 'node:fs';
import path from 'node:path';

export const NEXT_UI_FILE = 'next-ui.json';

/** @returns {boolean} true when the flag file was staged */
export function stageNextUiFlag(stageDir, rendererDir) {
  let on = false;
  try { on = JSON.parse(fs.readFileSync(path.join(rendererDir, NEXT_UI_FILE), 'utf8')).nextUi === true; } catch { on = false; }
  const dest = path.join(stageDir, NEXT_UI_FILE);
  if (!on) { fs.rmSync(dest, { force: true }); return false; }
  fs.writeFileSync(dest, `${JSON.stringify({ nextUi: true })}\n`); // canonical content, not a copy of whatever the renderer folder holds
  return true;
}
