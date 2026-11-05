// The room videos inside an unpacked installer (scripts/check-tauri-installer-payload.mjs --out <dir>) against its flavour, for the
// release workflow. official: exactly the files assets/rooms-video/rooms.json pins, each with its size and sha256, and no other .mp4.
// public: no .mp4 at all.
//   node scripts/installer-room-videos.mjs <payload dir> official|public
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Problems with the .mp4 files under `dir` for `flavour`; empty = as expected. */
export function roomVideoProblems(dir, flavour, manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets', 'rooms-video', 'rooms.json'), 'utf8'))) {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const found = walk(dir).filter((f) => /\.mp4$/i.test(f));
  const want = flavour === 'official' ? manifest.rooms : [];
  const problems = [];
  for (const f of found) {
    const r = want.find((x) => x.file === path.basename(f));
    if (!r) { problems.push(`unexpected video: ${path.relative(dir, f)}`); continue; }
    const b = fs.readFileSync(f);
    if (b.length !== r.bytes || crypto.createHash('sha256').update(b).digest('hex') !== r.sha256) problems.push(`differs from its rooms.json pin: ${path.relative(dir, f)}`);
  }
  for (const r of want) if (!found.some((f) => path.basename(f) === r.file)) problems.push(`missing room video: ${r.file}`);
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [dir, flavour] = process.argv.slice(2);
  if (!dir || !['official', 'public'].includes(flavour)) { console.error('usage: node scripts/installer-room-videos.mjs <payload dir> official|public'); process.exit(2); }
  const problems = roomVideoProblems(dir, flavour);
  if (problems.length) { console.error(`installer room videos (${flavour}): ${problems.join('; ')}`); process.exit(1); }
  console.log(`installer room videos (${flavour}): ${flavour === 'official' ? 'the 7 pinned rooms, nothing else' : 'none'}`);
}
