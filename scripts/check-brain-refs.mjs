#!/usr/bin/env node
// T-31 alpha.3 B3: the Brain showed a FILE row labelled `*` for a task that cites the glob `E:/work/hooks/*`. A glob or
// placeholder (* ? [ ] { } < >) names no one file or folder, so neither ref parser may cite it; folders and extensionless files
// stay cited (both hosts open them, check-board-open.mjs): the HUD's src/main/hud-feed.mjs and its copy src/renderer/next/brain/refs.js (BH-18 in check-brain-host.mjs
// keeps the two identical). A new file, not a BH-18 corpus edit: BH-11e freezes the existing check scripts.
// The Brain detail renders one .nb-ref row per collectRefs() ref, label as is (detail.js refRow), so the model is checked here.
//   node scripts/check-brain-refs.mjs
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const hud = await import(pathToFileURL(path.join(ROOT, 'src', 'main', 'hud-feed.mjs')).href);
const rnd = await import(pathToFileURL(path.join(ROOT, 'src', 'renderer', 'next', 'brain', 'refs.js')).href);
let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); } };
const locals = (refs) => refs.filter((r) => r.kind === 'local').map((r) => r.target);
const both = (text) => [hud.extractRefs(text), rnd.extractRefs(text)];

// not files: 0 local refs from either parser, inline and ref-line forms alike
const notFiles = ['hooks: `E:/work/hooks/*`', 'label `D:/x/a?.md`',
  '`D:/x/[ab].md` · `D:/x/{a,b}.md`', 'see `D:/x/<name>.md`', 'C:/a\n`E:/work/hooks/*`'];
for (const x of notFiles) {
  const [h, r] = both(x);
  ok(locals(h).length === 0 && locals(r).length === 0, `B3 no local ref in ${JSON.stringify(x)}`, JSON.stringify({ hud: locals(h), refs: locals(r) }));
}
// real files, folders and extensionless files still count (positive control: the filter can tell them apart)
const files = [['notes `E:/work/lane/notes/B3.md`', 'E:/work/lane/notes/B3.md'], ['label `D:/data/x y/z.md`', 'D:/data/x y/z.md'],
  ['`C:\\Windows\\win.ini`', 'C:/Windows/win.ini'], ['`D:/a.b/c.tar.gz` · [Doc](https://x.test/a)', 'D:/a.b/c.tar.gz'],
  ['folder `E:/work/lane/`', 'E:/work/lane/'], ['`E:/work/lane`', 'E:/work/lane'], ['build `E:/work/Makefile`', 'E:/work/Makefile']];
for (const [x, target] of files) {
  const [h, r] = both(x);
  ok(locals(h).join() === target && locals(r).join() === target, `B3 control: ${target} is still a local ref`, JSON.stringify({ hud: locals(h), refs: locals(r) }));
}
// the two parsers agree on every text here (the BH-18 rule, on the B3 texts)
const all = [...notFiles, ...files.map(([x]) => x)];
ok(all.every((x) => JSON.stringify(hud.extractRefs(x)) === JSON.stringify(rnd.extractRefs(x))), `B3 refs.js and hud-feed.mjs extractRefs agree on the ${all.length} B3 texts`);
// the Brain detail model of the GW task: no ref labelled `*`, the real file is still cited
const gw = { now: 'Hooks live in `E:/work/hooks/*`; notes in `E:/work/lane/notes/B3.md`.', steps: [], asks: [], plans: [] };
const cited = rnd.collectRefs(gw).map((r) => [r.kind, r.label]);
ok(!cited.some(([, l]) => l === '*') && cited.some(([k, l]) => k === 'local' && l === 'B3.md'), 'B3 the GW task detail cites no ref labelled `*` (no FILE * row) and keeps B3.md', JSON.stringify(cited));

console.log(`\ncheck:brain-refs ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
