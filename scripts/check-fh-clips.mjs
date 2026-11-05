// Checks for the T-31 float-holo talk-framing clip tooling (plain node: NO Electron, NO window, NO ffmpeg).
//   node scripts/check-fh-clips.mjs   (npm run check:fh-clips)
// 1. the clip matrix is exactly the r6 TOP3 x cyan/amber; labels carry params + colour
// 2. the timeline is deterministic and valid: every command passes the real gesture validator with no warnings,
//    arms cross the body (both hands, panel-side targets), a talk loop runs throughout, and the same ms fires on the
//    same frame at any fps
// 3. the aligned clock start is a multiple of every hover period (same bob phase in every run)
// 4. armStats separates an arm over the panel from an arm that never gets there
// 5. the ffmpeg argv builders (the ffmpeg itself runs only on the box)
// 6. wiring: the harness/app/orchestrator/runner are connected (a defined-but-never-called helper cannot pass)
// 7. fh-clips.mjs --dry-run starts nothing; a real run off the box is refused before anything is spawned
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const CP = require('./lib/fh-clip-plan.cjs');
const { validateGesture } = await import(pathToFileURL(path.join(ROOT, 'src', 'renderer', 'reflex', 'schema.js')).href);
const { REACH_TARGETS } = await import(pathToFileURL(path.join(ROOT, 'src', 'renderer', 'reflex', 'schema.js')).href);
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => { if (cond) pass++; else fail++; console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}${!cond && detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`); };

// ---------- 1. matrix ----------
{
  const m = CP.clipMatrix();
  ok(m.length === 6 && m.map((e) => e.id).join() === 'T1-cyan,T2-cyan,T3-cyan,T1-amber,T2-amber,T3-amber', 'matrix: 6 clips in sheet order (columns T1 T2 T3, rows cyan / amber)', m.map((e) => e.id));
  const want = { T1: [3, 2, 0.10, 0.24], T2: [6, 3, 0.10, 0.21], T3: [4, 2, 0.16, 0.24] };
  ok(m.every((e) => { const w = want[e.combo.id]; const p = e.params; return p.rimMul === w[0] && p.fresnelPower === w[1] && p.centerBackM === w[2] && p.soleY === w[3]; }), 'matrix: the three combos are the r6 TOP3 (rimMul, fresnel, centerBackM, soleY)');
  ok(m.filter((e) => e.colour === 'cyan').length === 3 && m.filter((e) => e.colour === 'amber').length === 3 && m.every((e) => e.page === (e.colour === 'cyan' ? 0 : 1)), 'matrix: every combo in cyan (page 0) and amber (page 1)');
  ok(m[0].label === 'T1  rim 3  fres 2  back 0.10  sole 0.24  CYAN' && m[5].label === 'T3  rim 4  fres 2  back 0.16  sole 0.24  AMBER', 'matrix: the label carries the params and the colour', [m[0].label, m[5].label]);
  ok(new Set(m.map((e) => e.label)).size === 6, 'matrix: all six labels differ');
  // the harness validates FH_PARAMS: each entry's params must be accepted by the real parser
  const PX = require('./lib/float-holo-pixels.cjs');
  ok(m.every((e) => { try { return PX.parseFhParams(JSON.stringify(e.params)) !== null; } catch { return false; } }), 'matrix: every params object passes the harness\'s parseFhParams');
}

// ---------- 2. timeline ----------
{
  const tl = CP.talkTimeline(8000);
  const results = tl.map((it) => ({ id: it.command.id, v: validateGesture(it.command) }));
  ok(results.every((r) => r.v.ok && r.v.warnings.length === 0), 'timeline: every command passes the real gesture validator with no clamping warnings', results.filter((r) => !r.v.ok || r.v.warnings.length).map((r) => ({ id: r.id, e: r.v.errors, w: r.v.warnings })));
  ok(tl.every((it) => it.command.jitter === 0 && it.command.interrupt === false && it.command.mirror === 'none'), 'timeline: deterministic (jitter 0, mirror none) and layered (interrupt false -> never fades the float legs clip)');
  const talk = tl.filter((it) => /^fh-talk-/.test(it.command.id));
  ok(talk.length === 4 && talk.every((it) => it.command.expressions.some((x) => x.name === 'aa' && x.osc && x.osc.hz > 0)) && talk[talk.length - 1].atMs + 1700 <= 8000, 'timeline: a talk loop of 4 phrases (mouth oscillating) covers the clip', talk.map((t) => t.atMs));
  const armCmds = tl.filter((it) => /^fh-arm-/.test(it.command.id));
  const hands = new Set(armCmds.flatMap((it) => it.command.reach.map((r) => r.hand)));
  const targets = armCmds.flatMap((it) => it.command.reach.map((r) => r.target));
  ok(armCmds.length === 4 && hands.has('left') && hands.has('right'), 'timeline: 4 arm gestures using BOTH hands (arms cross the body/panel)', { n: armCmds.length, hands: [...hands] });
  ok(targets.every((t) => REACH_TARGETS.includes(t)) && targets.includes('point-screen-left') && targets.includes('clasp'), 'timeline: reach targets are real rig targets, incl. the panel-side point and the clasp across the jacket', targets);
  // same ms -> same frame at any fps; every command fires exactly once within one frame of its time
  for (const fps of [24, 30, 60]) {
    const total = 8 * fps, fired = new Map();
    for (let i = 0; i < total; i++) for (const c of CP.commandsAtFrame(tl, i, fps)) fired.set(c.id, (fired.get(c.id) || []).concat(i));
    ok(tl.every((it) => { const f = fired.get(it.command.id); return f && f.length === 1 && Math.abs((f[0] * 1000) / fps - it.atMs) < 1000 / fps; }), `timeline: at ${fps} fps every command fires exactly once, within one frame of its time`, [...fired]);
  }
  ok(JSON.stringify(CP.talkTimeline(8000)) === JSON.stringify(CP.talkTimeline(8000)), 'timeline: building it twice gives identical JSON (no hidden randomness)');
  ok(CP.talkTimeline(6000).every((it) => it.atMs + 1000 <= 6000), 'timeline: a shorter clip drops commands that would be cut off');
}

// ---------- 3. aligned clock ----------
{
  ok(CP.HOVER_LCM_MS === 113526000, 'clock: the LCM of the hover periods 3.6/1.7/7/5.3 s is 113 526 000 ms', CP.HOVER_LCM_MS);
  for (const now of [0, 1234.5, 86_400_000, 150_000_000]) {
    const t0 = CP.alignedClockStart(now);
    ok(t0 >= now + 20000 && CP.HOVER_PERIODS_MS.every((p) => t0 % p === 0) && t0 - now - 20000 < CP.HOVER_LCM_MS, `clock: start for real now=${now} is a multiple of every hover period and the next one up (${t0})`);
  }
  ok(CP.alignedClockStart(5) === CP.alignedClockStart(99999), 'clock: two runs started at different real times get the same virtual start (same bob phase)');
  const a = CP.mulberry32(1031), b = CP.mulberry32(1031), c = CP.mulberry32(7);
  const xs = [a(), a(), a()], ys = [b(), b(), b()];
  ok(JSON.stringify(xs) === JSON.stringify(ys) && xs.every((v) => v >= 0 && v < 1) && c() !== xs[0], 'clock: the seeded PRNG repeats for one seed and differs for another');
}

// ---------- 4. armStats ----------
{
  const panel = { x0: -0.9, x1: -0.4, y0: -0.2, y1: 0.4 };
  const frame = (hand) => ({ pts: { rightHand: hand, leftHand: { x: 0.3, y: -0.4 }, rightLowerArm: { x: 0.2, y: -0.2 }, leftLowerArm: { x: 0.35, y: -0.2 } }, panel, aa: 0.3 });
  const away = Array.from({ length: 20 }, () => frame({ x: 0.3, y: -0.5 }));
  const stats0 = CP.armStats(away);
  ok(!stats0.overlapOk && !stats0.armsMoved && stats0.overlapFrames === 0, 'armStats: hands that never leave the body fail both the overlap and the travel gate', stats0);
  const sweep = Array.from({ length: 20 }, (_, i) => frame(i >= 6 && i < 12 ? { x: -0.6, y: 0.1 } : { x: 0.3, y: -0.5 }));
  sweep.forEach((s, i) => { s.aa = i % 2 ? 0.05 : 0.5; });
  const stats1 = CP.armStats(sweep);
  ok(stats1.overlapOk && stats1.armsMoved && stats1.overlapFrames === 6 && Math.abs(stats1.overlapShare - 0.3) < 1e-9 && stats1.mouthMoved, 'armStats: a hand over the panel rect in 6 of 20 frames passes (30 %), arms moved, mouth moved', stats1);
  const near = CP.armStats([frame({ x: -0.37, y: 0.1 })]); // 0.03 outside the rect, inside the 0.04 margin
  ok(near.overlapFrames === 1, 'armStats: a hand just outside the rect but inside the margin counts as overlapping the panel');
  ok(CP.armStats([{ pts: null, panel: null }]).measurable === 0 && !CP.armStats([]).overlapOk, 'armStats: unmeasurable frames are not counted as overlap (no sample = no pass)');
  const still = CP.armStats(Array.from({ length: 20 }, () => ({ ...frame({ x: 0.3, y: -0.5 }), aa: 0.2 })));
  ok(!still.mouthMoved, 'armStats: a constant mouth value fails the mouth-moves gate');
}

// ---------- 5. ffmpeg argv ----------
{
  const a = CP.ffmpegClipArgs({ framesDir: 'D:/run/T1-cyan/frames', fps: 30, out: 'D:/run/T1-cyan.mp4', labelFile: 'D:/run/T1-cyan/label.txt', font: 'C:/Windows/Fonts/consola.ttf' });
  const vf = a[a.indexOf('-vf') + 1];
  ok(a[a.indexOf('-framerate') + 1] === '30' && a.includes('D:/run/T1-cyan/frames/f_%04d.png') && a.includes('libx264') && /format=yuv420p$/.test(vf) && a[a.length - 1] === 'D:/run/T1-cyan.mp4', 'ffmpeg clip: image sequence at the clip fps -> libx264 yuv420p mp4', a);
  ok(/drawtext=fontfile='C\\:\/Windows\/Fonts\/consola\.ttf':textfile='D\\:\/run\/T1-cyan\/label\.txt'/.test(vf) && /x=18:y=18/.test(vf), 'ffmpeg clip: the label is burned top-left from a text file, drive colons escaped for the filter', vf);
  ok(/scale='min\(1920,iw\)':-2/.test(vf), 'ffmpeg clip: never wider than 1920 (1080p when the window allows), even height');
  ok(!CP.ffmpegClipArgs({ framesDir: 'f', fps: 30, out: 'o.mp4' }).join(' ').includes('drawtext'), 'ffmpeg clip: no label file -> no drawtext (the --no-label fallback)');
  const clips = CP.clipMatrix().map((m) => `D:/run/${m.id}.mp4`);
  const g = CP.ffmpegGridArgs({ clips, out: 'D:/run/compare-3x2.mp4' });
  const fc = g[g.indexOf('-filter_complex') + 1];
  ok(g.filter((x) => x === '-i').length === 6 && g.slice(1, 13).every((x, i) => (i % 2 ? x === clips[(i - 1) / 2] : x === '-i')) && /\[v0\]\[v1\]\[v2\]hstack=inputs=3\[r0\]/.test(fc) && /\[v3\]\[v4\]\[v5\]hstack=inputs=3\[r1\]/.test(fc) && /\[r0\]\[r1\]vstack=inputs=2/.test(fc), 'ffmpeg grid: 6 inputs in sheet order, hstack x3 per row, vstack x2 rows', fc);
  ok(/scale=960:540/.test(fc) && /pad=960:540/.test(fc), 'ffmpeg grid: cells are letterboxed to 960x540 (a 2880x1080 sheet)');
  let threw = false; try { CP.ffmpegGridArgs({ clips: clips.slice(0, 5), out: 'x' }); } catch { threw = true; }
  ok(threw, 'ffmpeg grid: fewer than 6 clips throws (no half sheet)');
}

// ---------- 6. wiring ----------
{
  const H = read('scripts/electron-float-holo.cjs'), APP = read('src/renderer/app.js'), HOLO = read('src/renderer/room/holo-screen.js');
  const ORCH = read('scripts/fh-clips.mjs'), GUARD = read('scripts/check-electron-guard.mjs'), PKG = JSON.parse(read('package.json'));
  ok(/require\('\.\/lib\/fh-clip-plan\.cjs'\)/.test(H), 'wiring: the harness requires the shared clip plan (no private copy of the timeline)');
  ok(/const TALK = process\.env\.FH_TALK_CLIP === '1'/.test(H) && H.indexOf('if (TALK) {') > 0 && H.indexOf('if (TALK) {') < H.indexOf('if (SWEEP) {'), 'wiring: FH_TALK_CLIP=1 has its own branch ahead of the sweep');
  ok(/CP\.talkTimeline\(/.test(H) && /CP\.commandsAtFrame\(/.test(H) && /window\.zumi\.playGesture\(/.test(H), 'wiring: the harness CALLS the timeline and plays every command through the real gesture IPC');
  ok(/CP\.alignedClockStart\(/.test(H) && /const start = \$\{clockStart != null \? clockStart : 'performance\.now\(\)'\}/.test(H), 'wiring: the virtual clock starts at the aligned value in talk mode and at the real clock otherwise (other modes unchanged)');
  ok(/holdNeutral\(\)/.test(H) && /float\.set\(true\)/.test(H) && /mulberry32/.test(H), 'wiring: neutral life, a float restart on the aligned clock and a seeded Math.random');
  ok(/holo\.pin\(true\)/.test(H) && /pin: \(on\) => holo\.pinPage\(on\)/.test(APP), 'wiring: the accent is pinned through the dev hook (holo.pin -> pinPage); the 6 s page clock this line used to assert is gone (R3)');
  ok(/this\.pinned = false;/.test(HOLO), 'wiring: pinned defaults to false, so the shipped page rotation is unchanged');
  ok(/CP\.armStats\(/.test(H) && /stats\.overlapOk/.test(H) && /stats\.armsMoved/.test(H) && /stats\.mouthMoved/.test(H), 'wiring: arm overlap, arm travel and mouth movement are CHECKS (a failing clip exits 1), not just logged');
  ok(/'--framing close'|FH_TALK_CLIP=1 records the real talk crop/.test(H) && /--framing', 'wide'/.test(ORCH), 'wiring: talk clips are the wide (real) talk framing; the harness refuses close');
  ok(/assertElectronHost\('fh-clips/.test(ORCH) && ORCH.search(/assertElectronHost\('fh-clips/) < ORCH.search(/spawnSync\(ELECTRON, /), 'wiring: fh-clips.mjs asserts the render box before it spawns Electron');
  ok(/\['scripts\/fh-clips\.mjs'/.test(GUARD), 'wiring: check-electron-guard.mjs lists fh-clips.mjs among the guarded starters');
  ok(PKG.scripts['check:fh-clips'] === 'node scripts/check-fh-clips.mjs', 'wiring: npm run check:fh-clips exists');
  ok(/CP\.ffmpegClipArgs\(/.test(ORCH) && /CP\.ffmpegGridArgs\(/.test(ORCH) && /CP\.clipMatrix\(\)/.test(ORCH), 'wiring: the orchestrator encodes + stitches through the tested builders');
  for (const f of ['scripts/box/fh-clips.ps1', 'scripts/box/fh-clips-start.ps1']) ok(fs.existsSync(path.join(ROOT, f)), `wiring: ${f} exists`);
  const PS = read('scripts/box/fh-clips.ps1');
  ok(/ZUMI_ELECTRON_HOST = 'box'/.test(PS) && /fh-clips\.mjs/.test(PS) && /build-renderer\.mjs/.test(PS) && /\.done/.test(PS), 'wiring: the box runner sets the box env, rebuilds the renderer (the new dev hook), runs fh-clips.mjs and writes the .done marker');
}

// ---------- 7. dry run + off-box refusal (neither can start Electron) ----------
{
  const env = { ...process.env }; delete env.ZUMI_ELECTRON_HOST;
  const base = [path.join(ROOT, 'scripts', 'fh-clips.mjs'), '--out', path.join(ROOT, '.check-fh-clips-never-created'), '--model', 'x.vrm'];
  const dry = spawnSync(process.execPath, [...base, '--dry-run'], { env, encoding: 'utf8' });
  const ids = (dry.stdout.match(/^\[(T\d-(?:cyan|amber))\]/gm) || []);
  ok(dry.status === 0 && /nothing is started/.test(dry.stdout) && ids.length === 6, '--dry-run: exits 0, says nothing is started, lists all 6 clips', { status: dry.status, ids, err: dry.stderr.slice(0, 200) });
  ok(/FH_TALK_CLIP=1 FH_COLOUR=amber FH_PARAMS=\{"rimMul":4,"fresnelPower":2,"centerBackM":0\.16,"soleY":0\.24\}/.test(dry.stdout) && /--size 1920x1080/.test(dry.stdout) && /--framing wide/.test(dry.stdout) && /--clip-seconds 8 --fps 30/.test(dry.stdout), '--dry-run: each clip runs the harness in talk mode with its colour + params, 1920x1080, wide framing, 8 s at 30 fps');
  ok(/compare-3x2\.mp4/.test(dry.stdout) && /hstack/.test(dry.stdout), '--dry-run: prints the stitch command too');
  const real = spawnSync(process.execPath, base, { env, encoding: 'utf8' });
  ok(real.status !== 0 && /REFUSED: fh-clips\.mjs/.test(real.stderr), 'off the box a real run is REFUSED before anything is spawned', { status: real.status, err: real.stderr.slice(0, 200) });
  ok(!fs.existsSync(path.join(ROOT, '.check-fh-clips-never-created')), 'off the box nothing was created (no out dir)');
  const bad = spawnSync(process.execPath, [...base, '--dry-run', '--seconds', '30'], { env, encoding: 'utf8' });
  ok(bad.status === 2 && /--seconds must be 6\.\.12/.test(bad.stderr), 'bad arguments exit 2 (a 30 s clip is refused: the brief asks for 6-8 s)');
  const only = spawnSync(process.execPath, [...base, '--dry-run', '--only', 'T9-cyan'], { env, encoding: 'utf8' });
  ok(only.status === 2 && /unknown clip id T9-cyan/.test(only.stderr), 'an unknown --only id exits 2');
}

console.log(`\ncheck:fh-clips ${pass}/${pass + fail} passed`);
process.exitCode = fail ? 1 : 0;
