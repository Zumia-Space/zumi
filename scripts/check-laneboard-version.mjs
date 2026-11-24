// T-31-MOBILE B2 (gate SF-b): the vendored Laneboard must be e866f5b or later. Older vendors (c13ba7b on the phone, ce780d8 on the
// desktop 9.7) lack the B2 news kinds and labels and the nudge hiding, and a rollback target older than e866f5b breaks the live board's
// tombstones. Two ways to prove it, both run when they can:
//   ancestry  vendor/laneboard/VERSION descends from e866f5b in a Laneboard repo that holds both commits (LANEBOARD_REPO, else the
//             owner path laneboardRepo); NOT-RUN (said so) when no such repo is on this machine
//   content   what the vendored tree must carry from that line: public/news.js (LaneNews), the cos-report / cos-event feedback kinds,
//             the feedback.kind.cos-report / cos-event labels in en/vi/zh, nudge.clear, and the owner feed's supervisor-noise filter
//   node scripts/check-laneboard-version.mjs [--vendor <vendor/laneboard dir>]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ownerPath } from './lib/owner-paths.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const at = process.argv.indexOf('--vendor');
const LB = path.resolve(at >= 0 ? process.argv[at + 1] : path.join(ROOT, 'vendor', 'laneboard'));
const MIN = 'e866f5b7052e81fbc8fb9724b4afd7a1c0fd8924';
let pass = 0, fail = 0;
const ok = (cond, name, detail) => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 300) : ''}`); } };
const read = (rel) => { try { return fs.readFileSync(path.join(LB, rel), 'utf8'); } catch { return ''; } };

const version = read('VERSION').trim();
ok(/^[0-9a-f]{40}$/.test(version), 'VERSION names one full commit sha', version);
ok(read('RELEASE').trim() === version.slice(0, 7), 'RELEASE is its short sha', read('RELEASE').trim());

const repo = process.env.LANEBOARD_REPO || ownerPath('laneboardRepo', '');
const git = (...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
if (repo && git('cat-file', '-e', `${MIN}^{commit}`).status === 0 && git('cat-file', '-e', `${version}^{commit}`).status === 0) {
  ok(git('merge-base', '--is-ancestor', MIN, version).status === 0, `ancestry: ${version.slice(0, 7)} is e866f5b or a descendant of it (${repo})`);
} else console.log(`NOT-RUN ancestry: no Laneboard repo here holds both e866f5b and ${version.slice(0, 7)} (set LANEBOARD_REPO); the content rows below still run`);

const news = read('public/news.js');
ok(/root\.LaneNews\s*=/.test(news), 'content: public/news.js defines LaneNews (the one news reader)');
ok(/isSupervisorNoise\s*=\s*m\s*=>\s*m\.kind === 'nudge'/.test(news) && news.includes("m.kind === 'idle'"), 'content: the owner feed drops supervisor noise (nudge, legacy msgKind nudge, idle)');
ok(read('public/index.html').includes('<script src="news.js"'), 'content: the page loads news.js');
const kinds = (() => { try { return JSON.parse(read('schema/v1/ops/feedback.add.json')).properties.kind.enum; } catch { return []; } })();
ok(kinds.includes('cos-report') && kinds.includes('cos-event'), 'content: feedback.add takes the cos-report / cos-event news kinds', kinds);
for (const l of ['en', 'vi', 'zh']) {
  const loc = (() => { try { return JSON.parse(read(`public/locales/${l}.json`)); } catch { return {}; } })();
  ok(loc['feedback.kind.cos-report'] && loc['feedback.kind.cos-event'] && !Object.keys(loc).some((k) => k.startsWith('news.kind.')), `content: ${l} labels the news kinds under feedback.kind.* (no news.kind.* left)`);
}
ok(fs.existsSync(path.join(LB, 'schema', 'v1', 'ops', 'nudge.clear.json')), 'content: nudge.clear is in the vendored schema (c13ba7b has none)');
ok(read('src/server.mjs').includes('/api/admin/news') || read('src/legacy-compat.mjs').includes('/api/admin/news'), 'content: the board answers POST /api/admin/news (B2 write path, b6d8417)');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
