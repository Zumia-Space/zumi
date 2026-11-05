// Palette gate (T-31 one-palette): the whole app shell must read its colours ONLY from the shared design tokens
// (vendor/laneboard/public/tokens.css, served at app://zumi/tokens.css — see src/main/main.js resolveAppPath), the
// same sheet the embedded board uses, so the shell and the board can never drift into two palettes again. Fails on:
//   1. index.html not linking tokens.css before styles.css, or not carrying class="dark" on <html>;
//   2. a hex / rgb(a) / hsl(a) / standalone-named colour literal in src/renderer/**/*.{css,html,js}, outside the
//      allowlist below (reasons required — see ALLOW_LINE);
//   3. a three.js 0x-hex colour (Light/Color/Material/setClearColor) in src/renderer/**/*.js, outside ALLOW_LINE.
// The SVG brand mark is out of scope entirely (brand colours are intentional, not system chrome) and so is the
// vendored tokens.css itself (it IS the source of truth, not a consumer of it).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const RENDERER = path.join(ROOT, 'src', 'renderer');
let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); } };
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

// Whole-directory exclusions: not app chrome, out of scope for this gate.
const EXCLUDE_PREFIX = ['src/renderer/brand/'];

// Single-line allowances, each with a reason — the only way a colour literal may survive this gate.
const ALLOW_LINE = [
  { file: 'src/renderer/app.js', match: 'setClearColor(0x000000', reason: 'three.js canvas clear colour; alpha is 0 (fully transparent), so the CSS --background set on #stage shows through — not UI chrome' },
  { file: 'src/renderer/app.js', match: 'DirectionalLight(0xffffff, Math.PI * 0.95)', reason: 'three.js scene lighting colour (key light) that illuminates the 3D VRM model, not CSS/DOM chrome' },
  { file: 'src/renderer/app.js', match: 'DirectionalLight(0xbcc8ff, 1.1)', reason: 'three.js scene lighting colour (rim light tint) that illuminates the 3D VRM model, not CSS/DOM chrome' },
  { file: 'src/renderer/app.js', match: 'AmbientLight(0xffffff, 0.55)', reason: 'three.js scene lighting colour (ambient fill) that illuminates the 3D VRM model, not CSS/DOM chrome' },
  { file: 'src/renderer/room/look-tuning.js', match: "'#6f7fe0' : '#000000'", reason: "the look-tuning panel's default grading tint (talk view only -- owner-requested default toward blue/violet to match the night plate) and its 0-strength neutral for the other views; a 3D-scene grading default, not UI chrome, and user-adjustable (colour picker) from the first frame" },
  { file: 'src/renderer/room/chair3d.js', match: "sky.addColorStop(0, '#1a1f45')", reason: 'the 3D chair: equirect environment map (plateEnvCanvas): night-room sky gradient that lights the chair PBR material to match the talk plate; a 3D-scene light colour, not UI chrome' },
  { file: 'src/renderer/room/chair3d.js', match: "warm.addColorStop(0, 'rgba(255,184,120,0.85)')", reason: 'the 3D chair: environment map: warm lamp bounce (room.json talk warm_fill) that lights the chair material; a 3D-scene light colour, not UI chrome' },
  { file: 'src/renderer/room/chair3d.js', match: "r.addColorStop(0, 'rgba(0,0,0,0.75)')", reason: 'the 3D chair: contact-shadow texture under the chair (black alpha falloff); a 3D-scene shadow, not UI chrome' },
  // T-31 float-holo (0.2.6): the hologram panel and her float shadow are 3D/canvas art, not DOM chrome. The Settings
  // "Màu viền" picker is a plain text <select> (index.html), so no colour literal reaches the app shell from here.
  { file: 'src/renderer/app.js', match: 'PointLight(0xffffff, 0, 0.85, 2)', reason: 'the float-holo panel light: a three.js PointLight that lights the VRM model from the panel (intensity 0 until float mode; holo-screen.js sets colour/falloff per frame) — a 3D scene light, not UI chrome' },
  { file: 'src/renderer/room/float-holo-prefs.js', match: "HOLO_COLOURS = Object.freeze({ cyan: '#39d0ff', amber: '#ffb347' })", reason: 'the two rim accents the r6 sweep measured (holo-screen PAGES[0]/[1]): they tint the 3D rim and the panel canvas texture, and are the values the owner judged; the Settings picker itself is a text <select> — not UI chrome' },
  { file: 'src/renderer/room/float-shadow.js', match: 'r.addColorStop(0, `rgba(0,0,0,${SHADOW_CORE_ALPHA})`)', reason: 'her float-mode contact shadow: dark core of the canvas radial-gradient texture on the floor (black alpha falloff), same class as the chair contact shadow — a 3D-scene shadow, not UI chrome' },
  { file: 'src/renderer/room/float-shadow.js', match: "r.addColorStop(0.30, 'rgba(0,0,0,0.28)')", reason: 'her float-mode contact shadow: mid stop of the same canvas gradient (alpha falloff only) — a 3D-scene shadow, not UI chrome' },
  { file: 'src/renderer/room/float-shadow.js', match: "r.addColorStop(1, 'rgba(0,0,0,0)')", reason: 'her float-mode contact shadow: fully transparent rim of the same canvas gradient — a 3D-scene shadow, not UI chrome' },
];

function walk(dir, exts, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, exts, out);
    else if (exts.includes(path.extname(e.name))) out.push(p);
  }
  return out;
}

const isComment = (line) => /^\s*(\/\/|\/\*|\*)/.test(line.trim());
const files = walk(RENDERER, ['.css', '.html', '.js']).filter((f) => !EXCLUDE_PREFIX.some((p) => rel(f).startsWith(p)));

// ---------- 1. index.html: token order + dark class ----------
const indexHtml = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');
const tokensAt = indexHtml.indexOf('href="tokens.css"');
const stylesAt = indexHtml.indexOf('href="styles.css"');
ok(tokensAt !== -1 && stylesAt !== -1 && tokensAt < stylesAt, 'index.html links tokens.css before styles.css', { tokensAt, stylesAt });
const htmlTag = (/<html\b[^>]*>/.exec(indexHtml) || [''])[0];
ok(/\bclass="[^"]*\bdark\b[^"]*"/.test(htmlTag), 'index.html <html> carries class="dark"', htmlTag);

// ---------- 2. colour literals: hex / rgb(a) / hsl(a) / standalone named colours ----------
const HEX = /#[0-9a-fA-F]{3,8}\b/g;
const FUNC = /\b(?:rgba?|hsla?)\(/g;
// Standalone CSS named colours: only counted as a value (preceded by : , or ( and followed by ; ) , or whitespace+one
// of those) so "white-space" (a property name) is never mistaken for the colour "white".
const NAMED = ['black', 'white', 'red', 'blue', 'green', 'yellow', 'orange', 'purple', 'gray', 'grey', 'navy', 'aqua', 'teal', 'lime', 'maroon', 'olive', 'silver', 'fuchsia', 'pink', 'brown', 'cyan', 'magenta'];
const NAMED_RE = new RegExp(`(?::|,|\\()\\s*(${NAMED.join('|')})\\s*(?:;|\\)|,|$)`, 'gi');
// three.js colour literal: 0x-hex argument to a Light/Color/Material constructor or setClearColor.
const THREE_HEX = /0x[0-9a-fA-F]{6,8}\b/g;
const THREE_CTX = /(Light\(|new\s+THREE\.Color\(|Material\(|setClearColor\()/;

let scanned = 0, usedAllow = new Set(), violations = 0;
for (const file of files) {
  scanned++;
  const relFile = rel(file);
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const isJs = file.endsWith('.js');
  lines.forEach((line, i) => {
    if (isComment(line)) return;
    const hits = [];
    for (const m of line.matchAll(HEX)) hits.push(m[0]);
    for (const m of line.matchAll(FUNC)) hits.push(m[0]);
    for (const m of line.matchAll(NAMED_RE)) hits.push(m[1]);
    if (isJs && THREE_CTX.test(line)) for (const m of line.matchAll(THREE_HEX)) hits.push(m[0]);
    if (!hits.length) return;
    const allowed = ALLOW_LINE.find((a) => a.file === relFile && line.includes(a.match));
    if (allowed) { usedAllow.add(allowed); return; }
    violations++;
    console.log(`FAIL ${relFile}:${i + 1} colour literal outside tokens (${hits.join(', ')}): ${line.trim().slice(0, 160)}`);
  });
}
ok(violations === 0, `no colour literals outside the tokens file in ${scanned} renderer css/html/js files`, { violations });
console.log(`  scanned ${scanned} files under src/renderer (css/html/js, excluding ${EXCLUDE_PREFIX.join(', ')})`);
console.log(`  allowlist: ${ALLOW_LINE.length} line(s)`);
for (const a of ALLOW_LINE) console.log(`    ${usedAllow.has(a) ? 'used  ' : 'UNUSED'} ${a.file} "${a.match}" — ${a.reason}`);
const staleAllow = ALLOW_LINE.filter((a) => !usedAllow.has(a));
ok(staleAllow.length === 0, 'every allowlist entry matched a real line (no stale allowances)', staleAllow.map((a) => a.match));

console.log(`\ncheck:palette ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
