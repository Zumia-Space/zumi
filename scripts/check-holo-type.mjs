// check:holo-type (T-31 alpha.12, owner 01-11 09:20Z). Plain Node, no window.
// The holo card's text must land on screen at the HUD panel's size. For each window width the owner's card width (CARD_CSS_W, measured in the real renderer:
// shots-holo.mjs, alpha12-0111/shots/holo/*-holo-result.json) goes into the real HoloScreen on a recording context; every drawn line's font is converted to on-screen px
//   on-screen px = drawn font px x (card on-screen width / the width the card was laid out at)   (a pre-alpha.12 build has a fixed 512 px canvas)
// and compared with the HUD's own number, parsed from hud.css (never copied here). Tolerance: TOL_PX, the most a 4 % stale layout can drift on the 14 px title.
//   node scripts/check-holo-type.mjs [--tree <another worktree>]   (--tree alpha.10 = the RED run: alpha12-0111/logs/holo-type-red-alpha10.log)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const at = process.argv.indexOf('--tree');
const TREE = at > 0 ? path.resolve(process.argv[at + 1]) : path.join(HERE, '..');
const { HoloScreen } = await import(pathToFileURL(path.join(TREE, 'src/renderer/room/holo-screen.js')).href);
const { FLOAT } = await import(pathToFileURL(path.join(TREE, 'src/renderer/room/float-mode.js')).href);
const { measureHolo, LEGIBLE_FIXTURE } = await import('./lib/holo-legible.mjs');

let pass = 0, fail = 0;
const ok = (c, m, d) => { if (c) pass++; else fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${m}${!c && d !== undefined ? '  ' + JSON.stringify(d) : ''}`); };

export const TOL_PX = 0.6;
const CARD_CSS_W = { 1366: 289, 1680: 360 };

const css = fs.readFileSync(path.join(TREE, 'src/renderer/hud/hud.css'), 'utf8');
const hudPx = (cls) => { const m = new RegExp(`\\.hud-task-panel \\.${cls} \\{[^}]*?font-size: ([\\d.]+)px`).exec(css); return m ? Number(m[1]) : NaN; };
const hudWeight = (cls) => { const m = new RegExp(`\\.hud-task-panel \\.${cls} \\{[^}]*?font-weight: (\\d+)`).exec(css); return m ? m[1] : '400'; };
const HUD = { title: hudPx('hp-title'), step: hudPx('hp-cur'), state: hudPx('hp-state'), sub: hudPx('hp-sub') };
ok(Object.values(HUD).every((v) => v > 0), 'the HUD sizes are read from hud.css', HUD);

for (const [win, cssW] of Object.entries(CARD_CSS_W)) {
  const m = measureHolo(HoloScreen, FLOAT, cssW);
  const scale = m.liveOnScreen / m.livePx; // on-screen px per drawn px, as measureHolo derives it
  const line = (pred) => m.live.find((t) => pred(t.s));
  const rows = {
    title: line((s) => s.startsWith('Render the float')),
    step: line((s) => s.startsWith('Check the')),
    state: line((s) => s === 'WAITING FOR OWNER'),
    sub: line((s) => s.startsWith('DONE')),
  };
  for (const [role, want] of Object.entries(HUD)) {
    const got = rows[role] ? rows[role].px * scale : NaN;
    ok(Math.abs(got - want) <= TOL_PX, `${win} wide (card ${cssW} px): holo ${role} text is ${Number.isFinite(got) ? got.toFixed(1) : 'absent'} px on screen, HUD ${want} px (+-${TOL_PX})`, { got, want });
  }
}

// The font itself: the HUD's weights, no heavy bold, no fixed oversize font left in the source.
const src = fs.readFileSync(path.join(TREE, 'src/renderer/room/holo-screen.js'), 'utf8');
ok(!/\bbold \$\{|`bold /.test(src), 'the card draws no "bold" font (the HUD uses weight 600 for title and step, 400 for labels)');
ok(/hudType\(/.test(src) && /'hp-title'/.test(src) && /'hp-cur'/.test(src) && /'hp-sub'/.test(src) && /'hp-state'/.test(src), 'the card reads its type from the HUD panel classes (a live probe), not a private copy');
const dflt = (await import(pathToFileURL(path.join(TREE, 'src/renderer/room/holo-screen.js')).href)).HUD_TYPE_DEFAULT;
ok(dflt && dflt.title.px === HUD.title && dflt.step.px === HUD.step && dflt.state.px === HUD.state && dflt.sub.px === HUD.sub && dflt.title.weight === hudWeight('hp-title') && dflt.step.weight === hudWeight('hp-cur'), 'the no-DOM fallback table equals hud.css', dflt);
ok(/\.hud-panel \{[^}]*border: 1px solid/.test(css) && /g\.lineWidth = 1; g\.beginPath\(\); g\.roundRect\(0\.5, 0\.5, w - 1, h - 1, r\); g\.stroke\(\)/.test(src), 'the card border is 1 CSS px, as .hud-panel');
ok(/generateMipmaps = false/.test(src) && /minFilter = THREE\.LinearFilter/.test(src) && /premultiplyAlpha = true/.test(src), 'crisp text: no mip blur, premultiplied upload');
const legibleFixtureUsed = LEGIBLE_FIXTURE.stepState === 'waiting';
ok(legibleFixtureUsed, 'the fixture is the worst case (the longest state word)');

console.log(`\ncheck:holo-type ${pass}/${pass + fail} passed`);
process.exitCode = fail ? 1 : 0;
