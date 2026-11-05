// RED/GREEN tests for the openLegal rule of scripts/check-third-party.mjs (T-31 0.2.11).
// Rule: manifest "openLegal" lists legal items still open. Each item is closed ONLY when closure.{closed,evidence,note} are all
// non-empty strings. Flavour "public" (strict, the build that goes to other people): an open item is a hard FAIL.
// Flavours "release" (npm run dist, the owner's own installer) and "owner" (dist:selftest): an open item is only a WARN, so the
// owner build is never blocked by it. Runs the real gate (scratch manifests via --manifest-file). No Electron window.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const dir = path.join(root, '_third-party-openlegal-test'); // gitignored, removed at the end
const real = JSON.parse(fs.readFileSync(path.join(root, 'third-party-manifest.json'), 'utf8'));
const SEED_IDS = ['directml-licence-text', 'espeak-gpl-notice-and-offer'];
fs.mkdirSync(dir, { recursive: true });

function gate(name, mutate, flavour) {
  const m = JSON.parse(JSON.stringify(real));
  mutate(m);
  const f = path.join(dir, `${name}.json`);
  fs.writeFileSync(f, JSON.stringify(m));
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'check-third-party.mjs'), '--flavour', flavour, '--manifest-file', f], { cwd: root, encoding: 'utf8', timeout: 300000 });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}
const openLines = (out) => (out.match(/^  OPEN-LEGAL +\S+/gm) || []).map((l) => l.trim().split(/\s+/)[1]);
const results = [];
const check = (label, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : ` ${extra}`}`); };
const CLOSURE = { closed: '2026-10-26', evidence: 'release-0211/licenses/example.txt', note: 'closed by test' };

try {
  // the seed: exactly these two items, both still open, no closure
  check('manifest seeds exactly the 2 open items', Array.isArray(real.openLegal) && real.openLegal.length === 2 && SEED_IDS.every((id) => real.openLegal.some((i) => i.id === id && !i.closure)), JSON.stringify((real.openLegal || []).map((i) => i.id)));

  // public: hard FAIL listing exactly the 2 open items, nothing else red
  let r = gate('public-real', () => {}, 'public');
  check('[public] committed manifest -> exit 1', r.code === 1, `exit ${r.code} ${r.out.slice(-300)}`);
  check('[public] FAIL lists exactly the 2 openLegal items', JSON.stringify(openLines(r.out).sort()) === JSON.stringify([...SEED_IDS].sort()), r.out.slice(-800));
  check('[public] RED says 2 blocking problems', /RED \(public\): 2 blocking problem/.test(r.out), r.out.slice(-300));

  // release (npm run dist) and owner: WARN only, exit 0
  r = gate('release-real', () => {}, 'release');
  check('[release] committed manifest -> exit 0 (not blocked)', r.code === 0, `exit ${r.code} ${r.out.slice(-400)}`);
  check('[release] WARN lists the 2 openLegal items', JSON.stringify(openLines(r.out).sort()) === JSON.stringify([...SEED_IDS].sort()) && /^WARN 2 open legal item/m.test(r.out), r.out.slice(-800));
  check('[release] 0 UNVERIFIED', !/^  UNVERIFIED /m.test(r.out), r.out.slice(-400));
  r = gate('owner-real', () => {}, 'owner');
  check('[owner] committed manifest -> exit 0', r.code === 0, `exit ${r.code} ${r.out.slice(-400)}`);
  check('[owner] WARN lists the 2 openLegal items', JSON.stringify(openLines(r.out).sort()) === JSON.stringify([...SEED_IDS].sort()) && /^WARN 2 open legal item/m.test(r.out), r.out.slice(-800));
  check('[owner] WARN lists exactly the 7 room mp4s as UNVERIFIED', (r.out.match(/^  UNVERIFIED +rooms-video\/\d\d-[^ ]+\.mp4 /gm) || []).length === 7 && (r.out.match(/^  UNVERIFIED /gm) || []).length === 7, r.out.slice(-1500));

  // closure evidence: all three fields, non-empty strings
  r = gate('public-closed', (m) => { for (const i of m.openLegal) i.closure = { ...CLOSURE }; }, 'public');
  check('[public] every item closed with evidence -> exit 0 GREEN', r.code === 0 && /GREEN \(public\)/.test(r.out) && openLines(r.out).length === 0, `exit ${r.code} ${r.out.slice(-400)}`);
  r = gate('public-one-open', (m) => { m.openLegal[0].closure = { ...CLOSURE }; }, 'public');
  check('[public] one closed, one open -> FAIL listing only the open one', r.code === 1 && JSON.stringify(openLines(r.out)) === JSON.stringify([SEED_IDS[1]]), `exit ${r.code} ${r.out.slice(-500)}`);
  for (const f of ['closed', 'evidence', 'note']) {
    for (const [how, mut] of [['missing', (c) => { delete c[f]; }], ['empty', (c) => { c[f] = ''; }], ['blank', (c) => { c[f] = '  '; }]]) {
      r = gate(`public-closure-${f}-${how}`, (m) => { m.openLegal[0].closure = { ...CLOSURE }; mut(m.openLegal[0].closure); }, 'public');
      check(`[public] closure.${f} ${how} -> item still OPEN, FAIL`, r.code === 1 && openLines(r.out).includes(SEED_IDS[0]), `exit ${r.code} ${r.out.slice(-400)}`);
    }
  }
  r = gate('release-closed', (m) => { for (const i of m.openLegal) i.closure = { ...CLOSURE }; }, 'release');
  check('[release] every item closed -> exit 0, no openLegal warning', r.code === 0 && openLines(r.out).length === 0, `exit ${r.code} ${r.out.slice(-400)}`);

  // the owner dist path: package.json beforePack (scripts/before-pack-release.cjs, runs the "release" gate) and the
  // dist:selftest beforePack (runLicenceGate('owner')) must NOT throw with the 2 open items; a public gate run must.
  const quiet = { print: () => {} };
  const { runLicenceGate } = require('./lib/licence-gate.cjs');
  const outDir = path.join(dir, 'beforepack-out');
  let threw = null;
  try { await require('./before-pack-release.cjs')({ outDir }); } catch (e) { threw = e; }
  check('npm run dist beforePack (release gate) passes with the 2 open items', threw === null, String(threw && threw.message));
  const relLog = fs.existsSync(path.join(outDir, 'third-party-gate-release.log')) ? fs.readFileSync(path.join(outDir, 'third-party-gate-release.log'), 'utf8') : '';
  check('npm run dist beforePack log shows the 2 items as WARN', /^WARN 2 open legal item/m.test(relLog), relLog.slice(-300));
  threw = null;
  try { runLicenceGate('owner', outDir, quiet); } catch (e) { threw = e; }
  check('dist:selftest beforePack (owner gate) passes with the 2 open items', threw === null, String(threw && threw.message));
  threw = null;
  try { runLicenceGate('public', outDir, quiet); } catch (e) { threw = e; }
  check('public gate run throws (build blocked) with the 2 open items', threw !== null && /licence gate failed \(public\)/.test(threw.message), String(threw && threw.message));
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
const bad = results.filter((x) => !x).length;
console.log(bad ? `\nRED: ${bad} of ${results.length} openLegal checks failed` : `\nGREEN: ${results.length} openLegal checks passed`);
process.exit(bad ? 1 : 0);
