import fs from 'node:fs';
import path from 'node:path';

// A check run may only ever wipe a dir it created itself: each run dir carries this marker. A public user who passes
// --out <their own folder> must never lose it (BP-3 follow-up, T-31 0.2.11).
export const RUN_MARKER = '.zumi-check-run';
const BS = String.fromCharCode(92); // backslash, spelled out so no editor/shell layer can swallow it

// Real path of the nearest existing ancestor (or of dir itself) must equal its lexical path: a junction/symlink anywhere on
// the way (--out itself or a parent) would let a planted marker redirect the wipe or the marker write into a foreign dir.
function viaLink(dir) {
  let probe = dir;
  while (!fs.existsSync(probe)) probe = path.dirname(probe);
  const same = (x, y) => (process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y);
  return !same(fs.realpathSync.native(probe), probe) || fs.lstatSync(probe).isSymbolicLink();
}

// Returns { ok: true, dir } with the dir ready (empty, marked), or { ok: false, reason } and touches nothing.
export function prepareOutDir(raw) {
  if (typeof raw !== 'string' || !raw) return { ok: false, reason: 'no output dir given' };
  if (raw.replaceAll(BS, '/').split('/').includes('..')) return { ok: false, reason: `refusing --out "${raw}": a ".." path segment could point at a folder this script did not create` };
  const dir = path.resolve(raw);
  if (viaLink(dir)) return { ok: false, reason: `refusing --out "${dir}": it is, or sits under, a junction/symlink (its real path differs), so it is not a dir this script created` };
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  } else {
    if (!fs.statSync(dir).isDirectory()) return { ok: false, reason: `refusing --out "${dir}": it is a file` };
    const entries = fs.readdirSync(dir);
    if (entries.length && !entries.includes(RUN_MARKER)) {
      return { ok: false, reason: `refusing --out "${dir}": it is not empty and was not created by a check run (no ${RUN_MARKER} marker), so it will not be wiped. Pass an empty or new dir.` };
    }
    for (const name of entries) fs.rmSync(path.join(dir, name), { recursive: true, force: true }); // only the contents of our own marked run dir
  }
  fs.writeFileSync(path.join(dir, RUN_MARKER), `${new Date().toISOString()} pid ${process.pid}\n`);
  return { ok: true, dir };
}
