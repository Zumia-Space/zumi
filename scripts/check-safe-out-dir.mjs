// Headless guard (no Electron): prepareOutDir() must only ever wipe a dir that a check run created (marker file),
// and must refuse a non-empty foreign dir or a path with a `..` segment. Run: node scripts/check-safe-out-dir.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareOutDir, RUN_MARKER } from './lib/safe-out-dir.mjs';
import { checkOutDir } from './lib/check-out-dir.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = path.join(ROOT, 'out', `safe-out-test-${process.pid}`); // under gitignored out/ (never C:)
fs.rmSync(base, { recursive: true, force: true });
fs.mkdirSync(base, { recursive: true });

let fails = 0;
const check = (name, ok, detail) => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : '  ' + JSON.stringify(detail)}`); };

// 1. non-empty foreign dir -> refused, content untouched
const foreign = path.join(base, 'foreign'); fs.mkdirSync(foreign); fs.writeFileSync(path.join(foreign, 'precious.txt'), 'keep');
let r = prepareOutDir(foreign);
check('non-empty foreign dir is refused', r.ok === false && /not created by|refus/i.test(r.reason || ''), r);
check('  ...and its files survive', fs.existsSync(path.join(foreign, 'precious.txt')), r);

// 2. empty existing dir -> allowed, marker written
const empty = path.join(base, 'empty'); fs.mkdirSync(empty);
r = prepareOutDir(empty);
check('empty existing dir is allowed', r.ok === true, r);
check('  ...and gets the marker', fs.existsSync(path.join(empty, RUN_MARKER)), r);

// 3. marked dir (a previous run of ours) -> allowed, stale content wiped, marker kept
const marked = path.join(base, 'marked'); fs.mkdirSync(marked); fs.writeFileSync(path.join(marked, RUN_MARKER), 'x'); fs.writeFileSync(path.join(marked, 'old.json'), '{}');
r = prepareOutDir(marked);
check('marked dir is allowed', r.ok === true, r);
check('  ...stale file wiped, marker present', !fs.existsSync(path.join(marked, 'old.json')) && fs.existsSync(path.join(marked, RUN_MARKER)), r);

// 4. path traversal -> refused, even when it lands on a marked dir
r = prepareOutDir(marked + '/../foreign');
check('`..` traversal to a foreign dir is refused', r.ok === false, r);
check('  ...foreign file still there', fs.existsSync(path.join(foreign, 'precious.txt')), r);
r = prepareOutDir(marked + '/sub/..');
check('`..` traversal onto a marked dir is refused too', r.ok === false, r);

// 5. nonexistent dir -> created with marker
const fresh = path.join(base, 'a', 'b');
r = prepareOutDir(fresh);
check('nonexistent dir is created + marked', r.ok === true && fs.existsSync(path.join(fresh, RUN_MARKER)), r);

// 6. a plain file given as --out -> refused
const file = path.join(base, 'afile'); fs.writeFileSync(file, 'x');
r = prepareOutDir(file);
check('a file path is refused and survives', r.ok === false && fs.existsSync(file), r);

// ---- review round 2 (Opus NO-GO on d93b9be3) ----
const junction = (target, at) => fs.symlinkSync(target, at, 'junction'); // junction on Windows (= mklink /J), symlink elsewhere
const mkForeign = (n, withMarker) => { const d = path.join(base, n); fs.mkdirSync(d); fs.writeFileSync(path.join(d, 'precious.txt'), 'keep'); if (withMarker) fs.writeFileSync(path.join(d, RUN_MARKER), 'planted'); return d; };

const BS = String.fromCharCode(92); // written this way so no editor/shell layer can swallow the backslash
// 7. backslash `..` segments are refused (a regex that only splits on "/" misses them)
r = prepareOutDir(marked + BS + 'sub' + BS + '..'); // BS = backslash
check('backslash `<marked>BS sub BS ..` onto a marked dir is refused', r.ok === false, r);
r = prepareOutDir(marked + BS + '..' + BS + 'foreign');
check('backslash `<marked>BS .. BS foreign` is refused', r.ok === false && fs.existsSync(path.join(foreign, 'precious.txt')), r);

// 8. a junction/symlink --out is refused, even onto a dir that carries a planted marker
const f2 = mkForeign('foreign2', true); const j2 = path.join(base, 'junc2'); junction(f2, j2);
r = prepareOutDir(j2);
check('junction to a foreign dir with a planted marker is refused', r.ok === false, r);
check('  ...target content survives', fs.existsSync(path.join(f2, 'precious.txt')), r);

// 9. a junction to an EMPTY dir is refused and the target is not marked (a marker would make it wipeable next run)
const f3 = path.join(base, 'foreign3'); fs.mkdirSync(f3); const j3 = path.join(base, 'junc3'); junction(f3, j3);
r = prepareOutDir(j3);
check('junction to an empty dir is refused', r.ok === false, r);
check('  ...target gets no marker', !fs.existsSync(path.join(f3, RUN_MARKER)), r);

// 10. a junction in a PARENT segment is refused too
const f4 = mkForeign('foreign4', false); fs.mkdirSync(path.join(f4, 'child')); fs.writeFileSync(path.join(f4, 'child', RUN_MARKER), 'planted'); fs.writeFileSync(path.join(f4, 'child', 'precious2.txt'), 'keep');
const j4 = path.join(base, 'junc4'); junction(f4, j4);
r = prepareOutDir(path.join(j4, 'child'));
check('junction in a parent segment is refused', r.ok === false, r);
check('  ...target content survives', fs.existsSync(path.join(f4, 'child', 'precious2.txt')), r);

// 11. a junction INSIDE a marked run dir is unlinked, never followed
const f5 = mkForeign('foreign5', false); const m5 = path.join(base, 'marked5'); fs.mkdirSync(m5); fs.writeFileSync(path.join(m5, RUN_MARKER), 'x'); junction(f5, path.join(m5, 'inner'));
r = prepareOutDir(m5);
check('marked dir holding a junction: allowed, junction target untouched', r.ok === true && fs.existsSync(path.join(f5, 'precious.txt')), r);

// 12. ZUMI_CHECK_OUT is a ROOT: each run gets its own <script>-<ts>-<pid> dir under it (never reused)
const envRoot = path.join(base, 'env-root'); process.env.ZUMI_CHECK_OUT = envRoot;
const run1 = checkOutDir('check-x');
check('ZUMI_CHECK_OUT is a root, run dir is a fresh child', path.dirname(run1) === path.resolve(envRoot) && /^check-x-\d{8}T\d{6}Z-\d+$/.test(path.basename(run1)), { run1 });
fs.writeFileSync(path.join(run1, 'evidence.json'), '{}');
const run2 = checkOutDir('check-y');
check('  ...a second run does not reuse/overwrite the first', run2 !== run1 && fs.existsSync(path.join(run1, 'evidence.json')), { run1, run2 });
delete process.env.ZUMI_CHECK_OUT;

fs.rmSync(base, { recursive: true, force: true }); // only the test's own scratch root
console.log(fails ? `check:safe-out-dir FAILED (${fails})` : 'check:safe-out-dir all clear');
process.exit(fails ? 1 : 0);
