// Duplicate-id guard for the renderer (R4h). The Voice in Settings card never mounted because index.html already
// used id="voice-card" for the TTS card and initVoiceCard bails when that id exists. Two checks:
//   1. no id appears twice in src/renderer/index.html;
//   2. no id a script gives an element with a literal `.id = '...'` / `id: '...'` is also an id in index.html
//      (the ids card builders pass through helpers are covered at run time by check-voice-in.mjs against the real page).
//   node scripts/check-duplicate-ids.mjs     (exit 1 on any failure)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const RENDERER = path.join(ROOT, 'src', 'renderer');

export const htmlIds = (html) => [...html.replace(/<!--[\s\S]*?-->/g, '').matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
export const duplicates = (ids) => [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
// Every way a renderer script gives an element an id: `.id = '..'`, setAttribute('id', '..'), id="..." inside an
// innerHTML / template string, and the local `node(tag, cls, text, 'id')` helper the voice files use (id = 4th argument).
export const scriptIds = (js) => {
  const src = js.replace(/\/\/.*$/gm, '');
  const out = [];
  for (const re of [/\.id\s*=\s*['"]([\w-]+)['"]/g, /setAttribute\(\s*['"]id['"]\s*,\s*['"]([\w-]+)['"]/g, /\sid=\\?["']([\w-]+)\\?["']/g, /\bnode\(\s*'[^']*'\s*,\s*'[^']*'\s*,[^,()]*(?:\([^)]*\))?[^,()]*,\s*['"]([\w-]+)['"]\s*\)/g]) {
    for (const m of src.matchAll(re)) out.push(m[1]);
  }
  return [...new Set(out)];
};

let pass = 0;
let fail = 0;
const ok = (cond, name, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${detail ? '  ' + detail : ''}`); }
};

// The detector must bite: a page with a repeated id is caught, a clean one passes.
ok(duplicates(htmlIds('<div id="a"></div><section id="b"></section><p id="a"></p>')).join() === 'a', 'detector: a repeated id is found');
ok(duplicates(htmlIds('<div id="a"></div><section id="b"></section>')).length === 0, 'detector: distinct ids pass');
ok(scriptIds("x.id = 'voice-card'; y.id=\"k\"; // z.id = 'no'").join() === 'voice-card,k', 'detector: literal id assignments are found, comments skipped');
ok(scriptIds("el.innerHTML = '<span id=\"a1\"></span>' + `<b id='b1'></b>`; q.setAttribute('id', 'c1'); node('span', 'cls', '', 'd1'); node('p', 'cls', t('k.x'), 'e1');").sort().join() === 'a1,b1,c1,d1,e1', 'detector: innerHTML, template strings, setAttribute and the node() helper are found');

const html = htmlIds(fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8'));
ok(html.length > 100, `index.html has ${html.length} ids`);
const dup = duplicates(html);
ok(dup.length === 0, 'index.html: no id is used twice', dup.join(', '));

const files = [];
const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.js')) files.push(p); } };
walk(RENDERER);
const taken = new Set(html);
for (const f of files) {
  const clash = scriptIds(fs.readFileSync(f, 'utf8')).filter((id) => taken.has(id));
  ok(clash.length === 0, `${path.relative(ROOT, f).split(path.sep).join('/')}: no script id collides with index.html`, clash.join(', '));
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
