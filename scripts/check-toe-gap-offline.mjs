// Offline re-run of the toe-gap gate on SAVED float-holo sweep stills (plain node: reads PNGs, no Electron, no window).
//   node scripts/check-toe-gap-offline.mjs <raw-dir>... [--colour cyan]
// <raw-dir> is a sweep output dir holding result.json (sweep.rows[].samples.{toe,core}) and
// sweep-<tag>-<colour>-full.png. Prints one line per cell + the grouped (centerBackM, soleY) summary the gate's
// calibration comment quotes. Exit 1 when a cell cannot be measured.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const PX = require('./lib/float-holo-pixels.cjs');
const { readPng } = require('./lib/png-read.cjs');

const args = process.argv.slice(2);
const ci = args.indexOf('--colour');
const colour = ci >= 0 ? args.splice(ci, 2)[1] : 'cyan';
if (!args.length) { console.error('usage: check-toe-gap-offline.mjs <raw-dir>... [--colour cyan]'); process.exit(2); }

const groups = new Map();
let broken = 0, n = 0;
for (const dir of args) {
  const rows = JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8')).sweep.rows;
  for (const r of rows) {
    const file = path.join(dir, `sweep-${r.tag}-${colour}-full.png`);
    const bm = readPng(file);
    // the harness's viewport was 1280x800 CSS px at device scale 1: the bitmap IS the CSS frame
    const g = PX.toeGapGate({ bm, toe: r.samples.toe, core: r.samples.core, cssW: bm.width, cssH: bm.height });
    n++;
    if (g.gapPx == null) broken++;
    const key = `centerBackM ${r.centerBackM} soleY ${r.soleY}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(g);
    console.log(`${r.tag.padEnd(22)} gap ${g.gapPx == null ? 'n/a' : g.gapPx.toFixed(1).padStart(5)} px  sole ${g.soleY} shadow ${g.shadowY}  ${g.pass ? 'PASS' : 'FAIL'}  (old toe-strip delta ${r.toeStripDelta == null ? '?' : Number(r.toeStripDelta).toFixed(1)})`);
  }
}
console.log('\nby (centerBackM, soleY):');
for (const [k, gs] of [...groups].sort()) {
  const v = gs.map((g) => g.gapPx).filter((x) => x != null);
  console.log(`  ${k.padEnd(28)} gap ${Math.min(...v).toFixed(1)}..${Math.max(...v).toFixed(1)}  ${gs.filter((g) => g.pass).length}/${gs.length} PASS`);
}
console.log(`\n${n} cells, ${broken} unmeasurable`);
process.exitCode = broken ? 1 : 0;
