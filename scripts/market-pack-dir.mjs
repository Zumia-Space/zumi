// Build a pack zip from an unpacked folder: reads <dir>/zumi-pack.json, lists every other file with sha256 + bytes (the
// standard's `files`), and writes a deterministic zip (same input, same bytes). Build tool only.
//   node scripts/market-pack-dir.mjs <dir> <out.zip>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { packZip } from './lib/zip-write.mjs';

function walk(dir, base = '') {
  const out = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const rel = base ? `${base}/${d.name}` : d.name;
    if (d.isDirectory()) out.push(...walk(path.join(dir, d.name), rel));
    else if (d.isFile()) out.push(rel);
    else throw new Error(`not a regular file: ${rel}`);
  }
  return out;
}

/** @returns {Buffer} the pack zip */
export function packDirZip(dir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'zumi-pack.json'), 'utf8'));
  delete manifest.files; // always recomputed
  const files = {};
  for (const rel of walk(dir)) if (rel !== 'zumi-pack.json') files[rel] = fs.readFileSync(path.join(dir, ...rel.split('/')));
  return packZip(manifest, files);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [dir, out] = process.argv.slice(2);
  if (!dir || !out) { console.error('usage: market-pack-dir.mjs <dir> <out.zip>'); process.exit(2); }
  const zip = packDirZip(dir);
  fs.writeFileSync(out, zip);
  console.log(`${out}: ${zip.length} bytes`);
}
