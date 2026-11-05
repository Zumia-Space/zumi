// T-31 3a-3 (GATE-SEC-3a-3 C4): is this bundle a next-UI build? The answer is a build artefact beside the host exe (`next-ui.json`, staged by
// tauri/next-ui-stage.mjs from build/renderer/next-ui.json, which scripts/build-renderer.mjs writes from the same resolution as __ZUMI_NEXT_UI__).
// An env var is never read here: a runtime variable must not be able to switch Brain's board calls on in a release or public build.
import fs from 'node:fs';
import path from 'node:path';

/** true only for a small `{"nextUi":true}` file beside the host exe; any doubt (no file, too big, not JSON, anything else) = off (fail-closed). */
export function readNextUiFlag(hostDir, fsImpl = fs) {
  try {
    const file = path.join(hostDir, 'next-ui.json');
    if (fsImpl.statSync(file).size > 256) return false;
    return JSON.parse(fsImpl.readFileSync(file, 'utf8')).nextUi === true;
  } catch { return false; }
}
