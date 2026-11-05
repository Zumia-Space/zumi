// Contributor docs (open-core ADR 2026-10-28, worklist B6): CONTRIBUTING.md points outside contributors at the CLA, and CLA.md
// stays a placeholder until a lawyer writes the text: it is marked DRAFT on its first line, states only that outside
// contributions need a signed CLA because of the dual licensing, and carries no legal clause.
//   node scripts/check-contributing.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`); };
const read = (rel) => { try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return null; } };

const contributing = read('CONTRIBUTING.md');
const cla = read('CLA.md');
check('1 CONTRIBUTING.md exists', contributing !== null);
check('2 CONTRIBUTING.md links the CLA and says outside contributions need it signed', !!contributing && /\]\(CLA\.md\)/.test(contributing) && /signed Contributor License Agreement/i.test(contributing));
check('3 CLA.md exists', cla !== null);
check('4 CLA.md first line is "DRAFT: pending lawyer review"', !!cla && cla.split(/\r?\n/)[0] === 'DRAFT: pending lawyer review', cla && cla.split(/\r?\n/)[0]);
check('5 CLA.md states the signed-CLA requirement and the dual-licensing reason', !!cla && /need a signed Contributor License Agreement/.test(cla) && /dual licensed/i.test(cla));
// a placeholder holds no clauses: no grant / warranty / liability language and no numbered sections
const LEGAL = /\b(hereby|herein|grants?|granted|warrant(y|ies|s)?|irrevocable|perpetual|royalty|indemnif\w*|liabilit\w*|sublicens\w*|patent|assigns?)\b|^\s*\d+\.\s/im;
check('6 CLA.md carries no legal clause (placeholder only)', !!cla && !LEGAL.test(cla), cla && (cla.match(LEGAL) || [])[0]);
check('7 CLA.md stays short (placeholder, not an agreement)', !!cla && cla.split(/\s+/).filter(Boolean).length <= 120, cla && cla.split(/\s+/).filter(Boolean).length);
// fix round 1 S1: while package.json says UNLICENSED and there is no LICENSE file, nothing may say the code IS open source / IS
// published under AGPL-3.0 (future or conditional wording only)
const unlicensed = JSON.parse(read('package.json')).license === 'UNLICENSED' && read('LICENSE') === null;
const PRESENT = /\b(?:is|are) (?:open[- ]source|dual[- ]licen[cs]ed|published under|licen[cs]ed under)\b/i;
check('8 CONTRIBUTING.md and CLA.md claim no licence the repo does not have yet (UNLICENSED, no LICENSE file)', !unlicensed || (!PRESENT.test(contributing || '') && !PRESENT.test(cla || '')), [(contributing || '').match(PRESENT), (cla || '').match(PRESENT)].filter(Boolean).map((m) => m[0]));
// ASSETS-LICENSE.md claims nothing beyond the text it reuses: every numbered section is a verbatim copy of a section of the avatar
// notice, and the room videos stay out of it
const assets = read('ASSETS-LICENSE.md');
const notice = read('resources-pinned/default-model/LICENSE-zumi-default.txt');
const norm = (t) => t.replace(/\s+/g, ' ').trim();
const sections = (t) => (t || '').split(/\r?\n(?=\d+\.\s)/).filter((s) => /^\d+\.\s/.test(s)).map((s) => norm(s.split(/\r?\n\s*\r?\n/)[0]));
// The export has neither file: the terms ship with the official installer.
if (assets) check('9 ASSETS-LICENSE.md keeps the one neutral line and points to the model notice', !!assets && /^Room backgrounds are AI-generated images\./m.test(assets) && /see LICENSE-zumi-default\.txt/.test(assets) && /official Zumi installer only/.test(assets) && !/DRAFT|owner build/i.test(assets));
if (assets) check('10 ASSETS-LICENSE.md says nothing about room videos: the official installer has none', !!assets && !/\.mp4|video/i.test(assets));
if (notice) check('10b the model notice carries the pixiv conduct list and the reworded metadata line', !!notice && /3a\. Conduct\./.test(notice) && /for anything else pixiv Inc\. deems inappropriate/.test(notice) && /Inside the Zumi app, this notice is your permission\./.test(notice) && /pixiv Inc\. may change those conditions/.test(notice) && !/The VRM metadata inside the file says the/.test(notice));
const noticeFile = read('NOTICE');
check('10c NOTICE separates pixiv\'s rule from ours and reserves the trademarks', !!noticeFile && /pixiv's conditions forbid CC0 release and character-creation use\./.test(noticeFile) && /3K FOREST CO\.,LTD separately does not allow redistribution/.test(noticeFile) && /no trademark rights/.test(noticeFile));

// B7, owner Q6. The docs announce plain "AGPL-3.0" and never "or later", so the licence is AGPL-3.0-only.
const licence = read('LICENSE');
check('11 LICENSE is the full AGPL-3.0 text', !!licence && /^\s*GNU AFFERO GENERAL PUBLIC LICENSE\s+Version 3, 19 November 2007/.test(licence) && /END OF TERMS AND CONDITIONS/.test(licence) && licence.length > 30000);
check('12 package.json, package-lock.json and Cargo.toml say AGPL-3.0-only', JSON.parse(read('package.json')).license === 'AGPL-3.0-only' && JSON.parse(read('package-lock.json')).packages[''].license === 'AGPL-3.0-only' && /^license = "AGPL-3\.0-only"$/m.test(read('tauri/src-tauri/Cargo.toml')));
check('13 CONTRIBUTING.md says the code is under AGPL-3.0-only and that the assets are not', !!contributing && /AGPL-3\.0-only/.test(contributing) && /see `LICENSE`/.test(contributing) && !/there is no LICENSE file/.test(contributing));

console.log(`\ncheck:contributing ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
