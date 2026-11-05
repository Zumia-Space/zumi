// Pre-publish check, run by hand: a stranger (no gh, no token) can download every catalog item. A private repo or an
// unpublished packs-v1 answers 404 here, as it did in 0.3.0. Run it after the repo is public and the pack release is
// published, before an app release is published; the release workflow proves the bytes with its token instead
// (scripts/check-packs-asset.mjs), so a tag can build while the repo is still private.
//   node scripts/check-packs-public.mjs
import { CATALOG } from '../tauri/sidecar/market-host.mjs';

let fail = 0, pass = 0;
const ok = (c, name, detail = '') => { if (c) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${detail ? ` -- ${detail}` : ''}`); } };
for (const c of CATALOG.filter((x) => x.download)) {
  let status = 'network';
  try { status = (await fetch(c.download.url, { method: 'HEAD', redirect: 'follow' })).status; } catch { /* stays 'network' */ }
  ok(status === 200, `${c.id}: anyone can download ${c.download.url}`, String(status));
}
console.log(`\ncheck-packs-public: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1; // not exit(): fetch sockets are still open, and exit() under them aborts libuv on Windows
