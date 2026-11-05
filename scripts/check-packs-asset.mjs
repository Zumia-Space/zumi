// Every catalog item that installs from a GitHub Release asset is really there, byte for byte: the release is found by its tag
// (draft or published), the asset by its name, then downloaded through the GitHub API with the caller's token and checked
// against the catalog's pinned size and sha256. Runs in the release workflow with the job token (contents: write sees drafts),
// so it holds while the repo is private and the pack is a draft. Whether a stranger can download it is a separate question,
// asked once the repo is public and before the pack is published: scripts/check-packs-public.mjs.
//   node scripts/check-packs-asset.mjs                          needs gh (GH_TOKEN in CI, the gh login locally)
//   --pin <id>=<sha256>                                         check against this sha256 instead of the catalog's (bite test)
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { CATALOG } from '../tauri/sidecar/market-host.mjs';

const REPO = 'Zumia-Space/zumi';
const args = process.argv.slice(2);
const pins = new Map(args.flatMap((a, i) => (a === '--pin' ? [args[i + 1].split('=')] : [])));
let fail = 0, pass = 0;
const ok = (c, name, detail = '') => { if (c) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${detail ? ` -- ${detail}` : ''}`); } };
const gh = (ghArgs, binary = false) => spawnSync('gh', ghArgs, { encoding: binary ? 'buffer' : 'utf8', maxBuffer: 1 << 30 });

const listed = gh(['api', `repos/${REPO}/releases?per_page=100`]);
const releases = listed.status === 0 ? JSON.parse(listed.stdout) : null;
ok(Array.isArray(releases), `the releases of ${REPO} can be listed with this token`, (listed.stderr || '').trim());

for (const c of CATALOG.filter((x) => x.download && x.download.releaseAsset)) {
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\/download\/([^/]+)\/([^/]+)$/.exec(c.download.url);
  ok(Boolean(m) && m[1] === REPO, `${c.id}: the URL names a release asset of ${REPO}`, c.download.url);
  if (!m || !releases) continue;
  const [, , tag, name] = m;
  const rel = releases.find((r) => r.tag_name === tag);
  const asset = rel && rel.assets.find((a) => a.name === name);
  ok(Boolean(asset), `${c.id}: release ${tag} carries ${name}`, rel ? `assets: ${rel.assets.map((a) => a.name).join(', ') || 'none'}` : 'no such release');
  if (!asset) continue;
  const dl = gh(['api', '-H', 'Accept: application/octet-stream', `repos/${REPO}/releases/assets/${asset.id}`], true);
  const bytes = dl.status === 0 ? dl.stdout : Buffer.alloc(0);
  ok(dl.status === 0, `${c.id}: the asset downloads with this token`, String(dl.stderr || '').trim());
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  const want = pins.get(c.id) || c.download.sha256;
  ok(bytes.length === c.download.bytes, `${c.id}: ${bytes.length} bytes, the catalog pins ${c.download.bytes}`);
  ok(sha === want, `${c.id}: sha256 equals the pin`, `got ${sha}, pinned ${want}`);
}

console.log(`\ncheck-packs-asset: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
