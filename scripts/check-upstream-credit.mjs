// Apache-2.0 section 4 for the code Zumi adapts from OpenMausBot (gate RC1, legal item): the public export and every build must carry
// (a) a copy of the Apache-2.0 licence, (c)/(d) the upstream copyright and NOTICE attribution, and (b) a statement that the code was changed.
// The credit lives in the root NOTICE because that file already ships in the public export, the Electron builds and every staged Tauri
// bundle (THIRD_PARTY_LICENSES.md also goes into the Kokoro pack, whose sha is pinned in the catalog, so it is left alone). This check fails
// when the credit is missing from NOTICE or when any of those paths stops carrying NOTICE.
//   node scripts/check-upstream-credit.mjs   (npm run check:upstream-credit)
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { CREDIT_FILES } from '../tauri/stage-bundle.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { isPublicRepoExcluded } = require('./lib/zumi-only.cjs');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/** What NOTICE must hold. Returns the list of missing items (empty = credited). */
export function missingCredit(notice) {
  const miss = [];
  const need = (re, what) => { if (!re.test(notice)) miss.push(what); };
  need(/OpenMausBot/, 'names OpenMausBot');
  need(/Copyright 2026 Milind Soni and OpenMausBot contributors/, 'the upstream copyright line');
  need(/Apache License, Version 2.0/, 'names the Apache License, Version 2.0');
  need(/Changes \(Apache-2\.0 section 4\(b\)\)[\s\S]*shared\/redact\.ts/, 'a statement that the code was changed, naming what was adapted (shared/redact.ts)');
  need(/TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION/, 'the full Apache-2.0 text (section 4(a): a copy of the licence)');
  need(/END OF TERMS AND CONDITIONS/, 'the full Apache-2.0 text ends (not cut off)');
  return miss;
}

let pass = 0, fail = 0;
const ok = (c, n, d) => { if (c) pass++; else fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${!c && d !== undefined ? '  ' + JSON.stringify(d) : ''}`); };

const notice = read('NOTICE');
const miss = missingCredit(notice);
ok(miss.length === 0, 'the repo NOTICE carries the OpenMausBot Apache-2.0 credit: name, copyright, change statement, full licence text', miss);

// NOTICE reaches every path that ships.
ok(!isPublicRepoExcluded('NOTICE'), 'the public source export keeps NOTICE');
ok(CREDIT_FILES.includes('NOTICE'), 'every staged Tauri bundle copies NOTICE (CREDIT_FILES)', CREDIT_FILES);
{
  const build = JSON.parse(read('package.json')).build;
  const to = (build.extraResources || []).map((e) => (typeof e === 'string' ? e : e.to));
  ok(to.includes('NOTICE'), 'the Electron build ships NOTICE as a resource', to);
  const pub = require('./builder-public.cjs');
  const pto = (pub.extraResources || []).map((e) => (typeof e === 'string' ? e : e.to));
  ok(pto.includes('NOTICE'), 'the Electron public build ships it too', pto);
}

// Controls: the check fails when the credit is missing (it bites), and passes when it is present (it does not fail everything).
ok(missingCredit(notice.replace(/OpenMausBot/g, 'the upstream app')).length > 0, 'CONTROL: a NOTICE that does not name OpenMausBot fails');
ok(missingCredit(notice.replace(/TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION/g, '')).length > 0, 'CONTROL: a NOTICE without the licence text fails');
ok(missingCredit(notice.replace(/Milind Soni/g, 'someone')).length > 0, 'CONTROL: a NOTICE without the upstream copyright line fails');
ok(missingCredit(notice.replace(/Changes \(Apache-2\.0 section 4\(b\)\)/, 'Notes')).length > 0, 'CONTROL: a NOTICE without the change statement fails');
ok(missingCredit('').length === 6, 'CONTROL: an empty NOTICE misses all 6 items');


