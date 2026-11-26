// P1 merge fix round: mutation proofs for the renderer-side tests added in the fix round (the Rust ones are rows of check-stage-mutations.mjs).
//   node scripts/check-fix-round-mutations.mjs [--out <log dir>]
// For each mutation: the stated weakening is applied IN PLACE to one file (backed up first), the named check must exit non-zero, then the file is
// restored byte for byte (sha256 compared with the backup) and the same check must pass. A crash restores in `finally`. Light: node only.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outIdx = process.argv.indexOf('--out');
const out = outIdx >= 0 ? process.argv[outIdx + 1] : null;
if (out) fs.mkdirSync(out, { recursive: true });
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const run = (script) => spawnSync(process.execPath, [path.join(repo, 'scripts', script)], { cwd: repo, encoding: 'utf8', timeout: 300000 });

const MUTATIONS = [
  { id: 'J-TRY-produce', rows: ['the buttons arm the host'], check: 'check-pack-tabs.mjs', file: 'src/renderer/pack-tabs.js', find: 'await zumi.stage.produce(op, {});', replace: 'void 0;' },
  { id: 'J-TRY-enter', rows: ['the buttons ask the Zumi tab to show the 3D room'], check: 'check-pack-tabs.mjs', file: 'src/renderer/pack-tabs.js', find: "document.dispatchEvent(new CustomEvent('zumi:room3d-enter', { detail: { pack: packId } }));", replace: '' },
  { id: 'J-TRY-line', rows: ['the reason line goes away on retry'], check: 'check-pack-tabs.mjs', file: 'src/renderer/pack-tabs.js', find: '        line.remove();', replace: '' },
  { id: 'J-LEAD-prepare', rows: ['analysis before the start (prepare)'], check: 'check-stage-producer.mjs', file: 'src/renderer/talk/speech.js', find: 'if (this.stageOn()) this.stage.analyse(decoded);', replace: '' },
  { id: 'J-LEAD-append', rows: ['analysis before the start (append)'], check: 'check-stage-producer.mjs', file: 'src/renderer/talk/speech.js', find: 'if (this.stageOn()) this.stage.analyse([decoded]);', replace: '' },
  { id: 'J-LEAD-const', rows: ['lead near the contract minimum'], check: 'check-stage-producer.mjs', file: 'src/renderer/talk/stage-producer.js', find: 'export const START_LEAD_MS = 175;', replace: 'export const START_LEAD_MS = 300;' },
  { id: 'J-INT', rows: ['integer times on the wire'], check: 'check-stage-producer.mjs', file: 'src/renderer/talk/stage-producer.js', find: 'let at = Math.round(startAtEpochMs);', replace: 'let at = startAtEpochMs;' },
  { id: 'J-CANCEL', rows: ['barge-in sends utterance.cancel'], check: 'check-stage-producer.mjs', file: 'src/renderer/talk/director.js', find: 'if (this.stage) Promise.resolve(this.stage.cancel()).catch(() => {});', replace: '' },
  { id: 'J-R3D-persist', rows: ['the 3D pick survives a restart'], check: 'check-room3d.mjs', file: 'src/renderer/room3d.js', find: 'if (remember) store.set(true);', replace: '' },
  { id: 'J-R3D-pause', rows: ['main renderer told to pause'], check: 'check-room3d.mjs', file: 'src/renderer/room3d.js', find: 'onActive(on);', replace: '' },
  { id: 'J-R3D-guest', rows: ['one guest, from the pack list row'], check: 'check-room3d.mjs', file: 'src/renderer/room3d.js', find: "wv.setAttribute('partition', pack.partition);", replace: '' },
  { id: 'J-R3D-caption', rows: ['caption mirrored under the guest'], check: 'check-room3d.mjs', file: 'src/renderer/room3d.js', find: "doc.addEventListener('zumi:caption', onCaption);", replace: '' },
  { id: 'J-R3D-failload', rows: ['a failed guest hands the stage back'], check: 'check-room3d.mjs', file: 'src/renderer/room3d.js', find: "wv.addEventListener('did-fail-load', () => api.leave());", replace: '' },
  { id: 'J-BAR-slot', rows: ['the reason line is in the slot above the message box'], check: 'check-pack-tabs.mjs', file: 'src/renderer/pack-tabs.js', find: "(document.getElementById('stage-reason-slot') || main).appendChild(line);", replace: 'main.appendChild(line);' },
  { id: 'J-BAR-dismiss', rows: ['dismiss removes the line'], check: 'check-pack-tabs.mjs', file: 'src/renderer/pack-tabs.js', find: "dismiss.addEventListener('click', () => line.remove());", replace: '' },
  { id: 'J-BAR-again', rows: ['Test again reaches the host'], check: 'check-pack-tabs.mjs', file: 'src/renderer/pack-tabs.js', find: "line.appendChild(button('stage-again', 'stage.testAgain', 'testAgain'));", replace: '' },
  { id: 'J-ONE-GUEST', rows: ['the Room tab viewer stays closed while the Zumi tab shows the 3D room'], check: 'check-pack-tabs.mjs', file: 'src/renderer/pack-tabs.js', find: "if (t.stage && globalThis.__zumiRoom3dActive) {", replace: 'if (false) {' },
];

let bad = 0;
for (const m of MUTATIONS) {
  const file = path.join(repo, m.file);
  const original = fs.readFileSync(file);
  const text = original.toString('utf8');
  if (!text.includes(m.find)) { console.log(`ANCHOR MISSING ${m.id}`); bad++; continue; }
  let red = null, green = null, restored = false;
  try {
    fs.writeFileSync(file, text.replace(m.find, m.replace));
    const r = run(m.check);
    red = r.status !== 0;
    if (out) fs.writeFileSync(path.join(out, `${m.id}-red.log`), `${r.stdout}\n${r.stderr}`);
  } finally {
    fs.writeFileSync(file, original);
    restored = sha(fs.readFileSync(file)) === sha(original);
  }
  const g = run(m.check);
  green = g.status === 0;
  const ok = red && green && restored;
  if (!ok) bad++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${m.id} [${m.rows.join('; ')}] red=${red} restored=${restored} green=${green}`);
}
console.log(bad ? `${bad} FAILED` : `${MUTATIONS.length}/${MUTATIONS.length} mutations proven (red on the weakened file, green when restored)`);
process.exit(bad ? 1 : 0);
