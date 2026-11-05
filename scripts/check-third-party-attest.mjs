// RED/GREEN tests for the OWNER-ATTESTED rule of scripts/check-third-party.mjs (T-31 0.2.11).
// Rule: an "attested" entry is verified ONLY when status is OWNER-ATTESTED and attestation.{source,date} are
// non-empty; anything else is ATTESTATION-INCOMPLETE, a hard fail in BOTH flavours. Runs the real gate against scratch manifests
// (--manifest-file). No Electron window.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, '_third-party-attest-test'); // gitignored, removed at the end
const real = JSON.parse(fs.readFileSync(path.join(root, 'third-party-manifest.json'), 'utf8'));
const PLATE = 'resources-pinned/room-v2/B-room-plate.png';
const FIELDS = ['source', 'date'];
fs.mkdirSync(dir, { recursive: true });

function gate(name, mutate, flavour) {
  const m = JSON.parse(JSON.stringify(real));
  mutate(m);
  const f = path.join(dir, `${name}.json`);
  fs.writeFileSync(f, JSON.stringify(m));
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'check-third-party.mjs'), '--flavour', flavour, '--manifest-file', f], { cwd: root, encoding: 'utf8', timeout: 300000 });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}
const results = [];
// the committed manifest pins the real sha256 of every attested file (computed here independently of the gate)
for (const [p, e] of Object.entries(real.attested)) {
  const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, p))).digest('hex');
  results.push(e.sha256 === actual);
  console.log(`${e.sha256 === actual ? 'PASS' : 'FAIL'}  manifest pins sha256 of ${p}`);
}
const check = (label, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : ` ${extra}`}`); };

try {
  for (const fl of ['release', 'owner']) {
    // GREEN: the committed manifest. Plates are verified; release has 0 unverified, owner warns only about the 7 room videos.
    const g = gate('green', () => {}, fl);
    check(`[${fl}] GREEN committed manifest exits 0`, g.code === 0, g.out.slice(-400));
    check(`[${fl}] GREEN the 5 plates are OWNER-ATTESTED`, /"OWNER-ATTESTED":5/.test(g.out), g.out.slice(0, 500));
    if (fl === 'release') check('[release] GREEN 0 UNVERIFIED', !/UNVERIFIED/.test(g.out.replace(/by status:.*/, '')), g.out.slice(-400));
    else check('[owner] GREEN WARN lists exactly the 7 room mp4s', (g.out.match(/^  UNVERIFIED +rooms-video\/\d\d-[^ ]+\.mp4 /gm) || []).length === 7 && (g.out.match(/^  UNVERIFIED /gm) || []).length === 7, g.out.slice(-1500));

    // RED: each missing / empty / blank field, wrong status, conflict with "unverified"
    for (const f of FIELDS) {
      for (const [how, mut] of [['missing', (a) => { delete a[f]; }], ['empty', (a) => { a[f] = ''; }], ['blank', (a) => { a[f] = '   '; }]]) {
        const r = gate(`red-${f}-${how}`, (m) => mut(m.attested[PLATE].attestation), fl);
        check(`[${fl}] RED ${how} attestation.${f} -> FAIL`, r.code !== 0 && r.out.includes('ATTESTATION-INCOMPLETE') && r.out.includes(f), `exit ${r.code}`);
      }
    }
    let r = gate('red-no-attestation', (m) => { delete m.attested[PLATE].attestation; }, fl);
    check(`[${fl}] RED no attestation object -> FAIL`, r.code !== 0 && r.out.includes('ATTESTATION-INCOMPLETE'), `exit ${r.code}`);
    r = gate('red-bad-status', (m) => { m.attested[PLATE].status = 'VERIFIED'; }, fl);
    check(`[${fl}] RED status other than OWNER-ATTESTED -> FAIL`, r.code !== 0 && r.out.includes('ATTESTATION-INCOMPLETE'), `exit ${r.code}`);
    // ATTESTATION-STALE: every attested entry pins sha256 of the attested file; the gate recomputes it
    for (const [how, mut] of [['missing', (e) => { delete e.sha256; }], ['empty', (e) => { e.sha256 = ''; }], ['wrong', (e) => { e.sha256 = '0'.repeat(64); }], ['not hex', (e) => { e.sha256 = 'zz'; }]]) {
      r = gate(`red-sha-${how}`, (m) => mut(m.attested[PLATE]), fl);
      check(`[${fl}] RED ${how} sha256 -> ATTESTATION-STALE`, r.code !== 0 && r.out.includes('ATTESTATION-STALE'), `exit ${r.code}`);
    }
    r = gate('red-conflict', (m) => { m.unverified[PLATE] = 'x'; }, fl);
    check(`[${fl}] RED path in both attested and unverified -> FAIL`, r.code !== 0 && r.out.includes('ATTEST-CONFLICT'), `exit ${r.code}`);
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
const bad = results.filter((x) => !x).length;
console.log(bad ? `\nRED: ${bad} of ${results.length} attestation checks failed` : `\nGREEN: ${results.length} attestation checks passed`);
process.exit(bad ? 1 : 0);
