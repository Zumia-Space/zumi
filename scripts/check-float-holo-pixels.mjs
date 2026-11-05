// Unit tests for the T-31 float-holo r6 box pixel gates (plain node, NO Electron, NO window).
//   node scripts/check-float-holo-pixels.mjs   (npm run check:float-holo-pixels)
//
// Two jobs:
//   1. NUMERIC: drive scripts/lib/float-holo-pixels.cjs with SYNTHETIC BGRA bitmaps whose edge band, front band and
//      toe strip have known luminances, and assert the metrics are the helpers' output and that the PASS/FAIL
//      boundaries bite (an edge gain of +14.9% fails, +15.0% passes; a front gain of 14.4% passes, 14.5% fails).
//   2. WIRING: the r5 failure was not a wrong number -- the helpers existed and NOTHING CALLED THEM, so no gate line
//      ever printed. This file therefore parses the harness and FAILS when the gate function is defined but not
//      called, when a gate line is not printed, or when a metric is not written into result.gates. A refactor that
//      quietly unhooks the instrument cannot pass this check.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const PX = require('./lib/float-holo-pixels.cjs');
const { readPng } = require('./lib/png-read.cjs');
const HARNESS = fs.readFileSync(path.join(ROOT, 'scripts', 'electron-float-holo.cjs'), 'utf8');
const LIB = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'float-holo-pixels.cjs'), 'utf8');
const CHECK = fs.readFileSync(path.join(ROOT, 'scripts', 'check-float-holo.mjs'), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => { if (cond) pass++; else fail++; console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}${!cond && detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`); };

// ---------- synthetic bitmaps ----------
/** A `w`x`h` BGRA image filled with `bg` luma, then every listed point (page-CSS == bitmap px here, cssW=cssH=n)
 *  painted with `luma`. Points are exact pixels; patchLuma averages a 9x9 patch, so callers space points apart. */
function image(w, h, bg, points = []) {
  // Float64 storage, so a fractional luma (114.4, 114.9) is exact -- an 8-bit Buffer would round both to 114 and
  // the "a tenth of a point matters" boundary tests would silently stop testing the boundary.
  const buf = new Float64Array(w * h * 4);
  const put = (x, y, v) => { const i = (y * w + x) * 4; buf[i] = v; buf[i + 1] = v; buf[i + 2] = v; buf[i + 3] = 255; };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) put(x, y, bg);
  for (const p of points) put(Math.round(p.x), Math.round(p.y), p.v);
  return { buf, width: w, height: h };
}
const grid = (n, step, y, from = 20) => Array.from({ length: n }, (_, i) => ({ x: from + i * step, y }));

// ---------- 1. patchLuma / meanLuma ----------
{
  const bm = image(64, 64, 100, [{ x: 32, y: 32, v: 200 }]);
  const one = PX.patchLuma(bm, { x: 32, y: 32 }, 64, 64, 0);
  ok(Math.abs(one - 200) < 1e-6, 'patchLuma: a flat 1-px patch is that pixel\'s Rec.601 luma', one);
  // A 9x9 patch with one bright pixel: (80*100 + 200)/81 -- proves the patch really averages and is not a point read.
  const nine = PX.patchLuma(bm, { x: 32, y: 32 }, 64, 64, 4);
  ok(Math.abs(nine - (80 * 100 + 200) / 81) < 1e-6, 'patchLuma: a 9x9 patch averages its pixels (one bright centre)', nine);
  // Rec.601 weights, not a channel average: a pure-blue pixel must read 0.0722*255, not 85.
  const blue = { buf: Buffer.from([255, 0, 0, 255]), width: 1, height: 1 };
  ok(Math.abs(PX.patchLuma(blue, { x: 0, y: 0 }, 1, 1, 0) - 0.0722 * 255) < 1e-6, 'patchLuma: BGRA is read as B,G,R with Rec.601 weights (blue -> 0.0722*255)', PX.patchLuma(blue, { x: 0, y: 0 }, 1, 1, 0));
  // device scale: a 2x bitmap for a 1x CSS viewport samples the same point.
  const hidpi = image(128, 128, 100, [{ x: 64, y: 64, v: 200 }]);
  ok(Math.abs(PX.patchLuma(hidpi, { x: 32, y: 32 }, 64, 64, 0) - 200) < 1e-6, 'patchLuma: a 2x bitmap + CSS viewport maps the same point (devicePixelRatio handled)', PX.patchLuma(hidpi, { x: 32, y: 32 }, 64, 64, 0));
  // OFF-FRAME must be unmeasurable, never silently clamped to an edge pixel.
  ok(PX.patchLuma(bm, { x: -40, y: 10 }, 64, 64, 4) === null && PX.patchLuma(bm, { x: 300, y: 10 }, 64, 64, 4) === null, 'patchLuma: an off-frame centre returns null (a gate cannot average whatever is in range)');
  ok(PX.meanLuma(bm, [{ x: 32, y: 32 }, { x: -40, y: 10 }], 64, 64, 0) === null, 'meanLuma: one off-frame point makes the whole band unmeasurable (null)');
  ok(PX.meanLuma(bm, [], 64, 64, 0) === null, 'meanLuma: an empty band is unmeasurable (null), not 0');
  const pts = PX.offsetPts([{ x: 1, y: 2 }], 10, 20);
  ok(pts[0].x === 11 && pts[0].y === 22, 'offsetPts: canvas-relative -> page coordinates');
}

// ---------- 2. bandGain: the metric is a ratio of means ----------
{
  const pts = grid(6, 20, 40);
  const off = image(200, 80, 100, pts.map((p) => ({ ...p, v: 100 })));
  const on = image(200, 80, 100, pts.map((p) => ({ ...p, v: 120 })));
  const g = PX.bandGain(off, on, pts, 200, 80, 0);
  ok(Math.abs(g.gainPct - 20) < 1e-6, 'bandGain: +20% for 100 -> 120 luma', g);
  const black = image(200, 80, 0, pts.map((p) => ({ ...p, v: 0 })));
  ok(PX.bandGain(black, on, pts, 200, 80, 0).gainPct === null, 'bandGain: a black OFF reference is unmeasurable (null), not Infinity');
  ok(PX.bandGain(off, on, [{ x: -5, y: 5 }], 200, 80, 0).gainPct === null, 'bandGain: an off-frame band is unmeasurable (null)');
}

// ---------- 3. rimGates: the PASS/FAIL boundaries bite ----------
{
  const edgePts = grid(8, 20, 30), frontPts = grid(8, 20, 60);
  const mk = (edgeLuma, frontLuma) => {
    const pts = [...edgePts.map((p) => ({ ...p, v: edgeLuma })), ...frontPts.map((p) => ({ ...p, v: frontLuma }))];
    return image(220, 90, 60, pts);
  };
  const off = mk(100, 100);
  // +15.0% edge, +14.4% front: both must PASS (the limits are inclusive)
  const atLimit = PX.rimGates({ off, on: mk(115, 114.4), edgePts, frontPts, cssW: 220, cssH: 90, r: 0 });
  ok(atLimit.rimEdge.pass && atLimit.rimFront.pass, 'rimGates: edge +15.0% and front +14.4% both PASS (inclusive limits)', atLimit);
  // r5's measured numbers: +4.4% edge, +0.4% front -> the edge gate must FAIL (this is the instrument biting)
  const r5 = PX.rimGates({ off, on: mk(104.4, 100.4), edgePts, frontPts, cssW: 220, cssH: 90, r: 0 });
  ok(!r5.rimEdge.pass && r5.rimFront.pass, 'rimGates: r5\'s +4.4% edge FAILS while its +0.4% front passes', r5);
  // just under the edge floor, and just over the front ceiling
  const under = PX.rimGates({ off, on: mk(114.9, 114.5), edgePts, frontPts, cssW: 220, cssH: 90, r: 0 });
  ok(!under.rimEdge.pass && !under.rimFront.pass, 'rimGates: edge +14.9% and front +14.5% both FAIL (a tenth of a point matters)', under);
  // r3's amber wash: +35.9% on a front facet -> FAIL, as it did on the box
  const wash = PX.rimGates({ off, on: mk(100, 135.9), edgePts, frontPts, cssW: 220, cssH: 90, r: 0 });
  ok(!wash.rimFront.pass, 'rimGates: r3\'s +35.9% front wash FAILS the front ceiling', wash);
  // unmeasurable -> FAIL, never a PASS
  const none = PX.rimGates({ off, on: mk(100, 100), edgePts: [], frontPts, cssW: 220, cssH: 90, r: 0 });
  ok(!none.rimEdge.pass && none.rimEdge.gainPct === null, 'rimGates: an empty edge band FAILS (no sample = no PASS)', none.rimEdge);
}

// ---------- 4. toeGapGate: the contact shadow must sit BELOW the soles ----------
// Synthetic scene (bitmap == CSS frame, viewH 800 -> k = 1): a pale boot block, open floor, and a dark shadow band.
// toe = floor point under the toe midpoint (x centres the stance); the gate scans around it.
const TOE = { x: 200, y: 230 };
const BOOT_BOTTOM = 150; // last pale row of the synthetic boot
/** w x h image: floor luma 150, a pale boot (luma 235) over x 170..229 and rows 100..BOOT_BOTTOM, and (unless
 *  shadowY is null) a shadow band 90 luma, 8 rows each side of shadowY, x 180..219. `extra` = [{x,y,v}] points. */
function toeScene({ w = 400, h = 300, shadowY = 170, shadowLuma = 90, boot = true, extra = [] } = {}) {
  const bm = image(w, h, 150, extra);
  const paint = (x0, x1, y0, y1, v) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const i = (y * w + x) * 4; bm.buf[i] = v; bm.buf[i + 1] = v; bm.buf[i + 2] = v; bm.buf[i + 3] = 255; } };
  if (boot) paint(170, 229, 100, BOOT_BOTTOM, 235);
  if (shadowY != null) paint(180, 219, shadowY - 8, shadowY + 8, shadowLuma);
  return bm;
}
const gapOf = (bm, extra = {}) => PX.toeGapGate({ bm, toe: TOE, core: { x: 200, y: 200 }, cssW: bm.width, cssH: bm.height, viewH: 800, ...extra });
{
  const floating = gapOf(toeScene({ shadowY: 170 }));
  ok(floating.pass && Math.abs(floating.gapPx - 20) < 1e-6 && floating.soleY === BOOT_BOTTOM && floating.shadowY === 170, 'toeGapGate: a shadow band 20 px under the last boot row PASSES with gap 20', floating);
  const atMin = gapOf(toeScene({ shadowY: BOOT_BOTTOM + PX.TOE_GAP_MIN_PX }));
  const belowMin = gapOf(toeScene({ shadowY: BOOT_BOTTOM + PX.TOE_GAP_MIN_PX - 1 }));
  ok(atMin.pass && !belowMin.pass, `toeGapGate: gap ${PX.TOE_GAP_MIN_PX} passes (inclusive), ${PX.TOE_GAP_MIN_PX - 1} fails`, { atMin, belowMin });
  const level = gapOf(toeScene({ shadowY: BOOT_BOTTOM }));
  ok(!level.pass && Math.abs(level.gapPx) < 1e-6, 'toeGapGate: a shadow band level with the soles (r5\'s failure) FAILS at gap 0', level);
  const behind = gapOf(toeScene({ shadowY: BOOT_BOTTOM - 6 }));
  ok(!behind.pass && behind.gapPx < 0, 'toeGapGate: a shadow band behind/over the soles FAILS with a negative gap', behind);
  // the point of the redesign: the OLD gate was blind to this. Same scene as `level`, a light strip between toe and core.
  ok(gapOf(toeScene({ shadowY: BOOT_BOTTOM })).pass === false && gapOf(toeScene({ shadowY: 200 })).pass === true, 'toeGapGate: moving only the shadow flips the verdict (the gate responds to the float, not to a strip)');
  // unmeasurable -> FAIL, with a reason, never a PASS
  const noShadow = gapOf(toeScene({ shadowY: null }));
  ok(!noShadow.pass && noShadow.gapPx === null && /no shadow/.test(noShadow.reason), 'toeGapGate: no shadow band FAILS (unmeasurable)', noShadow);
  const faint = gapOf(toeScene({ shadowY: 180, shadowLuma: 145 })); // 5 luma darker than the floor: below TOE_GAP_MIN_DARKNESS
  ok(!faint.pass && /no shadow/.test(faint.reason), 'toeGapGate: a shadow only 5 luma darker than the floor is not found (FAIL)', faint);
  const noBoot = gapOf(toeScene({ boot: false }));
  ok(!noBoot.pass && /no boot/.test(noBoot.reason), 'toeGapGate: no pale boot rows FAILS (unmeasurable)', noBoot);
  ok(!gapOf(toeScene(), { toe: null }).pass && !gapOf(toeScene(), { core: null }).pass, 'toeGapGate: a missing toe or core point FAILS (instrument failure)');
  ok(!gapOf(toeScene(), { toe: { x: 20, y: 230 } }).pass && /off-frame/.test(gapOf(toeScene(), { toe: { x: 20, y: 230 } }).reason), 'toeGapGate: a window that leaves the frame FAILS');
  // a stray bright speck on the floor far below the boot must not extend the boot run
  const speck = gapOf(toeScene({ shadowY: 170, extra: [{ x: 190, y: 215, v: 255 }, { x: 191, y: 215, v: 255 }, { x: 192, y: 215, v: 255 }] }));
  ok(speck.pass && speck.soleY === BOOT_BOTTOM, 'toeGapGate: a bright floor speck below the boot does not move the sole row', speck);
  // device scale: the same scene at 2x bitmap size for the same 800-px viewport measures the same gap
  const hi = (() => { const lo = toeScene({ shadowY: 170 }); const bm = image(800, 600, 150); for (let y = 0; y < 600; y++) for (let x = 0; x < 800; x++) { const s = ((y >> 1) * 400 + (x >> 1)) * 4, d = (y * 800 + x) * 4; bm.buf[d] = lo.buf[s]; bm.buf[d + 1] = lo.buf[s + 1]; bm.buf[d + 2] = lo.buf[s + 2]; bm.buf[d + 3] = 255; } return bm; })();
  const g2 = PX.toeGapGate({ bm: hi, toe: TOE, core: { x: 200, y: 200 }, cssW: 400, cssH: 300, viewH: 800 });
  ok(Math.abs(g2.gapPx - 20) < 0.6, 'toeGapGate: a 2x bitmap for the same viewport measures the same gap in reference px', g2);
}
// Two REAL fixture crops cut from the saved r6 sweep stills (1280x800 viewport, 300x210 crop at x540 y530, so the
// viewport height is passed as 800): the stance centre is crop x 151, the floor point under the toes crop y 175.
// touching = r3/p2/centerBackM 0.22/soleY 0.24 (the shadow on the toe tips; the old gate scored it 55.3, PASS);
// floating = r3/p2/centerBackM 0.10/soleY 0.24 (TOP1, a clear floor gap; old gate 39.0, PASS).
{
  const fx = (name) => readPng(path.join(ROOT, 'scripts', 'fixtures', 'float-holo', name));
  const run = (bm) => PX.toeGapGate({ bm, toe: { x: 151, y: 175 }, core: { x: 151, y: 150 }, cssW: bm.width, cssH: bm.height, viewH: 800 });
  const touching = run(fx('toe-touching.png')), floatingFx = run(fx('toe-floating.png'));
  ok(!touching.pass && touching.gapPx != null && touching.gapPx < PX.TOE_GAP_MIN_PX, 'fixture: the shadow touching the toe tips (centerBackM 0.22) FAILS the toe-gap gate', touching);
  ok(floatingFx.pass && floatingFx.gapPx >= 20, 'fixture: the visibly floating cell (TOP1, centerBackM 0.10) PASSES the toe-gap gate', floatingFx);
  ok(floatingFx.gapPx - touching.gapPx >= 12, 'fixture: the floating crop has a clearly larger gap than the touching one (the gate separates them, not just thresholds)', { touching: touching.gapPx, floating: floatingFx.gapPx });
}

// ---------- 5. computeGates + formatGateLines: one call, the brief's three lines ----------
{
  const edgePts = grid(6, 20, 20), frontPts = grid(6, 20, 50);
  const mk = (edge, front, shadowY = 170) => toeScene({ shadowY, extra: [...edgePts.map((p) => ({ ...p, v: edge })), ...frontPts.map((p) => ({ ...p, v: front }))] });
  const off = mk(100, 100), on = mk(120, 101), full = on;
  const dims = { cssW: 400, cssH: 300, r: 0, viewH: 800 };
  const toe = TOE, core = { x: 200, y: 200 };
  const g = PX.computeGates({ off, on, full, edgePts, frontPts, toe, core, ...dims });
  ok(g.rimEdge.pass && g.rimFront.pass && g.toeGap.pass, 'computeGates: one call returns all three metrics (all PASS here)', g);
  const lines = PX.formatGateLines(g);
  ok(lines.length === 3, 'formatGateLines: exactly three lines', lines);
  ok(/^GATE rim-edge 20\.0 PASS \(>=15\)$/.test(lines[0]), 'formatGateLines: rim-edge line matches the brief\'s format', lines[0]);
  ok(/^GATE rim-front 1\.0 PASS \(<=14\.4\)$/.test(lines[1]), 'formatGateLines: rim-front line matches the brief\'s format', lines[1]);
  ok(/^GATE toe-gap \d+\.\d PASS \(>=7\)$/.test(lines[2]), 'formatGateLines: toe-gap line is `GATE toe-gap <px> PASS|FAIL (>=7)`', lines[2]);
  const touching = PX.computeGates({ off, on: mk(120, 101, 152), full: mk(120, 101, 152), edgePts, frontPts, toe, core, ...dims });
  ok(touching.rimEdge.pass && !touching.toeGap.pass && /^GATE toe-gap 2\.0 FAIL \(>=7\)$/.test(PX.formatGateLines(touching)[2]), 'computeGates: rim passes but a shadow 2 px under the soles FAILS toe-gap (the r6 blind spot)', PX.formatGateLines(touching)[2]);
  // an unmeasurable metric prints n/a and FAIL -- the brief's format is kept, never a silent skip
  const broken = PX.computeGates({ off, on, full, edgePts: [], frontPts, toe: null, core, ...dims });
  const bad = PX.formatGateLines(broken);
  ok(/^GATE rim-edge n\/a FAIL \(>=15\)$/.test(bad[0]) && /^GATE toe-gap n\/a FAIL \(>=7\)$/.test(bad[2]), 'formatGateLines: unmeasurable metrics print n/a FAIL (no silent skip)', bad);
}

// ---------- 6. sweep grid parsing ----------
{
  const d = PX.parseSweepGrid('');
  ok(d.rimMul.join() === '1,2,3,4,6' && d.fresnelPower.join() === '2,3,4' && d.centerBackM.join() === '0.1,0.16,0.22' && d.soleY.join() === '0.21,0.24', 'parseSweepGrid: empty -> the brief\'s default grid', d);
  const n = PX.sweepCombos(d).length;
  ok(n === 5 * 3 * 3 * 2, `sweepCombos: the default grid is the full cartesian product (${n} = 5*3*3*2)`, n);
  const first = PX.sweepCombos(d)[0], last = PX.sweepCombos(d)[n - 1];
  ok(first.rimMul === 1 && first.fresnelPower === 2 && first.centerBackM === 0.1 && first.soleY === 0.21, 'sweepCombos: the first cell is the lowest of every axis', first);
  ok(last.rimMul === 6 && last.fresnelPower === 4 && last.centerBackM === 0.22 && last.soleY === 0.24, 'sweepCombos: the last cell is the highest of every axis', last);
  const inline = PX.parseSweepGrid('{"rimMul":[2],"fresnelPower":[3],"centerBackM":[0.1],"soleY":[0.24]}');
  ok(PX.sweepCombos(inline).length === 1 && PX.sweepCombos(inline)[0].rimMul === 2, 'parseSweepGrid: an inline JSON grid replaces the default', inline);
  const fromFile = PX.parseSweepGrid('C:/tmp/grid.json', () => '{"rimMul":[3],"fresnelPower":[2],"centerBackM":[0.2],"soleY":[0.21]}');
  ok(PX.sweepCombos(fromFile)[0].centerBackM === 0.2, 'parseSweepGrid: a non-JSON value is read as a file path', fromFile);
  let threw = 0;
  for (const bad of ['{', '{"rimMul":[]}', '{"rimMul":[1]}', '{"rimMul":["x"],"fresnelPower":[2],"centerBackM":[0.1],"soleY":[0.21]}']) {
    try { PX.parseSweepGrid(bad); } catch { threw++; }
  }
  ok(threw === 4, 'parseSweepGrid: malformed JSON, an empty axis, a missing axis and a non-numeric value all THROW (a silently empty sweep would write a header-only CSV)', threw);
}

// ---------- 7. WIRING: the harness must CALL the gate function and print the three lines ----------
// r5 shipped RIM_BAND/TOE_FLOOR/patchLuma/meanLuma/offsetPts and called none of them. These assertions are the
// regression guard: they read the harness source, so they fail on a refactor that unhooks the instrument even when
// every numeric test above still passes.
{
  ok(/require\('\.\/lib\/float-holo-pixels\.cjs'\)/.test(HARNESS), 'wiring: the harness requires the shared pixel module (no private copy of the maths)');
  ok(!/function patchLuma\(/.test(HARNESS) && !/function meanLuma\(/.test(HARNESS) && !/const offsetPts =/.test(HARNESS), 'wiring: the harness has no local luma/band helpers (the r5 dead copy is gone)');
  ok(/PX\.computeColourGates\(/.test(HARNESS), 'wiring: the harness CALLS computeColourGates (the gate function is not merely defined)');
  const colourBody = (LIB.match(/function computeColourGates\([\s\S]*?\n\}\n/) || [''])[0];
  ok(/\bcomputeGates\(/.test(colourBody) && /\brimGates\(/.test(colourBody), 'wiring: computeColourGates still invokes computeGates (cyan + toe) and rimGates (amber), so the original gate function stays in the call path');
  ok(/PX\.formatColourGateLines\(/.test(HARNESS) && /\bformatGateLines\(/.test((LIB.match(/function formatColourGateLines\([\s\S]*?\n\}\n/) || [''])[0]), 'wiring: the harness prints the gate lines via formatColourGateLines, which reuses formatGateLines');
  ok(/const gateCheck = \(line, ok, detail\) =>/.test(HARNESS) && /result\.checks\.push\(\{ name: line/.test(HARNESS), 'wiring: every gate line is also recorded as a check, so a FAIL exits 1');
  ok(/result\.gates = await measureGates\(/.test(HARNESS), 'wiring: result.json gets `gates` from a real measurement call');
  ok(/printGates\(result\.gates\)/.test(HARNESS), 'wiring: the still run prints the gate lines');
  ok(/const g = await measureGates\(\{ saveAs: `sweep-\$\{tag\}` \}\)/.test(HARNESS), 'wiring: the sweep measures every grid cell');
  ok(/sweep\.csv/.test(HARNESS) && /result\.sweep\.rows\.push/.test(HARNESS), 'wiring: the sweep writes sweep.csv + keeps the rows in result.json');
  ok(/FH_SWEEP === '1'/.test(HARNESS), 'wiring: FH_SWEEP=1 is the sweep switch');
  ok(/const RIM_BAND = `/.test(HARNESS) && /const TOE_FLOOR = `/.test(HARNESS), 'wiring: the in-page RIM_BAND / TOE_FLOOR samplers still exist');
  ok(/await r\(RIM_BAND\)/.test(HARNESS) && /await r\(TOE_FLOOR\)/.test(HARNESS), 'wiring: both in-page samplers are EXECUTED (the r5 bug was defined-but-never-run)');
  // The r5 false claim lived in check-float-holo.mjs's comment. It must now name the real script + line, so a reader
  // can verify the claim; the check itself also asserts the harness wiring above.
  ok(/electron-float-holo\.cjs/.test(CHECK), 'wiring: check-float-holo.mjs points at the harness that really runs the gates');
}

// ---------- 8. the shipped defaults are untouched by the override machinery ----------
{
  const FLOAT_SRC = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'room', 'float-mode.js'), 'utf8');
  const SHADOW_SRC = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'room', 'float-shadow.js'), 'utf8');
  const HOLO_SRC = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'room', 'holo-screen.js'), 'utf8');
  ok(/export const FLOAT = \{ z: -1\.0, soleY: 0\.210, scale: 0\.85 \};/.test(FLOAT_SRC), 'defaults: FLOAT.soleY is still the shipped 0.210');
  ok(/centerBackM: 0\.10 \}/.test(SHADOW_SRC), 'defaults: SHADOW.centerBackM is still the shipped 0.10');
  ok(/export const EDGE_FRESNEL_POWER = 3;/.test(HOLO_SRC) && /export const RIM_ONLY_TINT = 0\.8;/.test(HOLO_SRC), 'defaults: the shipped fresnel power 3 / rim-only tint 0.8 are unchanged');
  // parseFloatOverrides: only in-range values survive, so a typo leaves the shipped value.
  const fm = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'room', 'float-mode.js'), 'utf8');
  ok(/export function parseFloatOverrides\(search\)/.test(fm), 'overrides: float-mode.js exports parseFloatOverrides (URL query -> renderer)');
  ok(/fhSoleY|fhCenterBackM|fhRimMul|fhFresnelPower/.test(fm), 'overrides: the four query params are named');
}

// ---------- 9. FH_PARAMS: a picked combo for a normal run ----------
{
  ok(PX.parseFhParams(undefined) === null && PX.parseFhParams('') === null && PX.parseFhParams('  ') === null, 'parseFhParams: unset/empty -> null (shipped defaults untouched)');
  const full = PX.parseFhParams('{"rimStrength":3,"fresnelPower":2,"centerBackM":0.16,"soleY":0.24}');
  ok(full.rimMul === 3 && full.fresnelPower === 2 && full.centerBackM === 0.16 && full.soleY === 0.24 && !('rimStrength' in full), 'parseFhParams: the four keys parse; rimStrength is canonicalised to rimMul', full);
  ok(JSON.stringify(PX.parseFhParams('{"soleY":0.24}')) === '{"soleY":0.24}', 'parseFhParams: a subset applies only the keys given');
  ok(PX.parseFhParams('{"rimMul":0}').rimMul === 0 && PX.parseFhParams('{"rimMul":10}').rimMul === 10, 'parseFhParams: range bounds are inclusive');
  const bad = ['{', '[]', 'null', '3', '{}', '{"rimStrenth":2}', '{"scale":0.5}', '{"soleY":"0.24"}', '{"soleY":null}', '{"soleY":0.04}', '{"soleY":0.61}', '{"fresnelPower":0.4}', '{"rimMul":11}', '{"rimMul":2,"rimStrength":3}'];
  const notThrown = bad.filter((b) => { try { PX.parseFhParams(b); return true; } catch { return false; } });
  ok(notThrown.length === 0, 'parseFhParams: bad JSON, non-objects, empty object, unknown keys, non-numbers, out-of-range and a duplicated alias all THROW', notThrown);
  const ranges = { soleY: [0.05, 0.6], centerBackM: [0, 0.6], rimMul: [0, 10], fresnelPower: [0.5, 10] };
  const FM = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'room', 'float-mode.js'), 'utf8');
  const m = FM.match(/const OVERRIDE_RANGES = (\{[^}]*\});/);
  const rendererRanges = m ? Function('return (' + m[1] + ')')() : null;
  ok(JSON.stringify(rendererRanges) === JSON.stringify(ranges) && JSON.stringify(PX.PARAM_RANGES) === JSON.stringify(ranges), 'parseFhParams: the accepted ranges equal the renderer\'s OVERRIDE_RANGES (an accepted value is never silently dropped there)', { rendererRanges });
  ok(/PX\.parseFhParams\(process\.env\.FH_PARAMS\)/.test(HARNESS) && /float\.setParams\(\$\{JSON\.stringify\(FH_PARAMS\)\}\)/.test(HARNESS), 'wiring: the harness parses FH_PARAMS and applies it via float.setParams for the stills/clip run');
  const setIdx = HARNESS.indexOf('float.setParams(${JSON.stringify(FH_PARAMS)})'), clipIdx = HARNESS.indexOf('// ---------- clip:');
  ok(setIdx > 0 && setIdx < clipIdx, 'wiring: FH_PARAMS is applied before the clip and the stills');
  ok(/FH_PARAMS && SWEEP/.test(HARNESS) && /process\.exit\(2\)/.test(HARNESS), 'wiring: a bad FH_PARAMS (or FH_PARAMS with FH_SWEEP=1) exits 2 before any window opens');
}

// ---------- 10. both colours: the sweep row and the cell verdict ----------
{
  const edgePts = grid(6, 20, 20), frontPts = grid(6, 20, 50);
  const toe = TOE, core = { x: 200, y: 200 };
  const mk = (edge, front) => toeScene({ extra: [...edgePts.map((p) => ({ ...p, v: edge })), ...frontPts.map((p) => ({ ...p, v: front }))] });
  const off = mk(100, 100);
  const goodOn = mk(120, 101); // edge +20%, front +1%
  const weakOn = mk(104, 100); // edge +4% -> FAILS the edge floor
  const washOn = mk(120, 140); // front +40% -> FAILS the front ceiling
  const run = (cyanOn, amberOn) => PX.computeColourGates({ cyan: { off, on: cyanOn }, amber: { off, on: amberOn }, full: goodOn, edgePts, frontPts, toe, core, cssW: 400, cssH: 300, r: 0, viewH: 800 });
  const both = run(goodOn, goodOn);
  ok(both.pass && both.rimEdge.pass && both.amber.rimEdge.pass && both.toeGap.pass, 'computeColourGates: cyan and amber both good -> the cell PASSES', both);
  const amberBad = run(goodOn, weakOn);
  ok(amberBad.rimEdge.pass && !amberBad.amber.rimEdge.pass && !amberBad.pass, 'computeColourGates: cyan good but amber edge weak -> the cell FAILS (a cyan-only sweep would have passed it)', amberBad);
  const cyanBad = run(washOn, goodOn);
  ok(!cyanBad.rimFront.pass && cyanBad.amber.rimFront.pass && !cyanBad.pass, 'computeColourGates: cyan front wash with amber good -> the cell FAILS', cyanBad);
  const amberWash = run(goodOn, washOn);
  ok(!amberWash.amber.rimFront.pass && !amberWash.pass, 'computeColourGates: an amber-only front wash FAILS the cell', amberWash);
  const lines = PX.formatColourGateLines(amberBad);
  ok(lines.length === 5 && /^GATE rim-edge 20\.0 PASS \(>=15\)$/.test(lines[0]) && /^GATE rim-edge-amber 4\.0 FAIL \(>=15\)$/.test(lines[3]) && /^GATE rim-front-amber 0\.0 PASS \(<=14\.4\)$/.test(lines[4]), 'formatColourGateLines: the three cyan lines unchanged + two amber lines', lines);

  const cell = { rimMul: 3, fresnelPower: 2, centerBackM: 0.16, soleY: 0.24 };
  const row = PX.sweepRow(cell, 't', amberBad);
  const cols = PX.SWEEP_CSV_HEADER.split(',');
  const vals = PX.sweepCsvLine(row).split(',');
  ok(cols.length === vals.length, 'sweep.csv: header and row have the same column count', { cols: cols.length, vals: vals.length });
  const at = (name) => vals[cols.indexOf(name)];
  ok(at('rimEdgeCyanGainPct') === '20.0' && at('rimEdgeAmberGainPct') === '4.0' && at('rimFrontCyanGainPct') === '1.0' && at('rimFrontAmberGainPct') === '0.0' && at('rimEdgeCyanPass') === 'true' && at('rimEdgeAmberPass') === 'false' && at('cellPass') === 'false', 'sweep.csv: the row carries BOTH colours\' gains + passes and the combined cellPass', PX.sweepCsvLine(row));
  ok(['rimEdgeCyanGainPct', 'rimFrontCyanGainPct', 'rimEdgeAmberGainPct', 'rimFrontAmberGainPct', 'toeGapPx', 'cellPass'].every((c) => cols.includes(c)) && cols.filter((c) => /toeGap/.test(c)).length === 2, 'sweep.csv: columns exist for cyan and amber edge/front, the toe gap once (px + pass), and the cell verdict');
  ok(!PX.sweepRowBroken(row), 'sweepRowBroken: a fully measured row is not broken');
  const blind = PX.computeColourGates({ cyan: { off, on: goodOn }, amber: { off, on: goodOn }, full: goodOn, edgePts, frontPts: [], toe, core, cssW: 400, cssH: 300, r: 0, viewH: 800 });
  ok(PX.sweepRowBroken(PX.sweepRow(cell, 't', blind)) && !blind.pass, 'sweepRowBroken: an unmeasurable band (empty front points) marks the row broken and the cell not passing');
  ok(/PX\.SWEEP_CSV_HEADER/.test(HARNESS) && /PX\.sweepRow\(/.test(HARNESS) && /PX\.sweepCsvLine\(/.test(HARNESS), 'wiring: the sweep builds rows + CSV through the tested helpers');
  ok(/\$\{saveAs\}-\$\{colour\}-close\.png/.test(HARNESS) && /\$\{saveAs\}-amber-full\.png/.test(HARNESS) && /\$\{saveAs\}-cyan-full\.png/.test(HARNESS), 'wiring: sweep-<tag>-{cyan,amber}-close.png and -full.png are all saved');
  ok(/const amber = await pair\('amber'\)/.test(HARNESS) && /const cyan = await pair\('cyan'\)/.test(HARNESS), 'wiring: the harness measures a rim OFF/ON pair on BOTH accent pages');
}

console.log(`\ncheck:float-holo-pixels ${pass}/${pass + fail} passed`);
process.exitCode = fail ? 1 : 0;
