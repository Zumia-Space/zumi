// T-31 chair3d: static checks of the 3D chair manifest and its main-process module (no browser, no Electron).
//   - assets/chair3d/chairs.json passes checkChairsManifest; every GLB and the no-chair plate match size + sha256
//   - every GLB is under 3 MB; DEFAULT_CHAIR is 'painted' or a listed chair id; no/unknown/stale picks fall back to
//     DEFAULT_CHAIR (or to 'painted' when that chair is not listed); an explicit 'painted' pick stays painted
//   - createChairs lists every chair, persists a valid pick, ignores an unknown one, and serves exact names only
//   - Settings > Room > Chair: a #chair-picker select in #room-card, an en/vi/zh label for 'painted' and every chair, and
//     app.js writes the pick through zumi.chairs.select then re-applies the chair (the click itself: box, --rooms-chair)
//   node scripts/check-chair3d.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { checkChairsManifest, resolveSelectedChair, createChairs, DEFAULT_CHAIR, PAINTED } from '../src/main/chair3d.mjs';
import { TABLES } from '../src/renderer/i18n.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'assets', 'chair3d');
const MANIFEST = path.join(DIR, 'chairs.json');
let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`); if (!cond) fails++; };
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const c = checkChairsManifest(m);
ok(c.ok, `chairs.json schema ${c.errors.join('; ')}`);
ok(sha(path.join(DIR, m.noChairPlate.file)) === m.noChairPlate.sha256, 'no-chair plate sha256 matches');
for (const ch of m.chairs) {
  const f = path.join(DIR, ch.file);
  ok(fs.statSync(f).size === ch.bytes && sha(f) === ch.sha256, `${ch.id}: GLB size + sha256 match`);
  ok(ch.bytes < 3 * 1024 * 1024, `${ch.id}: GLB ${(ch.bytes / 1048576).toFixed(2)} MB < 3 MB`);
  ok(/^CC0|^CC-BY/.test(ch.source.license), `${ch.id}: licence ${ch.source.license}`);
}
ok(!checkChairsManifest({ ...m, chairs: [{ ...m.chairs[0], id: 'painted' }] }).ok, "an id of 'painted' is refused");
ok(DEFAULT_CHAIR === PAINTED || m.chairs.some((ch) => ch.id === DEFAULT_CHAIR), `DEFAULT_CHAIR '${DEFAULT_CHAIR}' is 'painted' or a chairs.json id`);
const ids = m.chairs.map((ch) => ch.id);
ok(resolveSelectedChair(undefined, ids) === DEFAULT_CHAIR && resolveSelectedChair('gone', ids) === DEFAULT_CHAIR && resolveSelectedChair(42, ids) === DEFAULT_CHAIR, `no/unknown pick -> DEFAULT_CHAIR (${DEFAULT_CHAIR})`);
ok(resolveSelectedChair(PAINTED, ids) === PAINTED && resolveSelectedChair(ids[0], ids) === ids[0], "an explicit 'painted' or listed pick is kept");
ok(resolveSelectedChair(undefined, ['other']) === PAINTED && resolveSelectedChair(undefined, []) === PAINTED, "DEFAULT_CHAIR not listed (GLB missing) -> 'painted'");

let store = {};
const chairs = createChairs({ manifestPath: MANIFEST, settings: { get: () => store, set: (p) => { store = { ...store, ...p }; } } });
let l = chairs.list();
ok(l.selected === DEFAULT_CHAIR && l.chairs.length === m.chairs.length && !l.error, `list: ${l.chairs.length} chairs, no chair3d key -> ${DEFAULT_CHAIR}`);
l = chairs.select(m.chairs[0].id);
ok(l.selected === m.chairs[0].id && store.chair3d === m.chairs[0].id, 'select persists a listed chair');
l = chairs.select('../evil');
ok(l.selected === m.chairs[0].id, 'select ignores an unknown id');
l = chairs.select(PAINTED);
ok(l.selected === PAINTED && store.chair3d === PAINTED, "select persists 'painted' and it stays painted");
ok(chairs.resolvePath(`${m.chairs[0].id}.glb`) === path.join(DIR, m.chairs[0].file), 'serves a listed GLB');
ok(chairs.resolvePath('plate-nochair.png') === path.join(DIR, m.noChairPlate.file), 'serves the no-chair plate');
ok(chairs.resolvePath('../chairs.json') === null && chairs.resolvePath('chairs.json') === null, 'no other path is served');

const html = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');
const roomCard = /<section class="card" id="room-card">([\s\S]*?)<\/section>/.exec(html);
ok(roomCard && /<select id="chair-picker"[^>]*data-i18n-aria="settings.chair"/.test(roomCard[1]), 'Settings: #chair-picker select sits in the Room card');
for (const [lang, table] of Object.entries(TABLES)) {
  const missing = ['settings.chair', 'settings.chairD', ...[PAINTED, ...ids].map((id) => `chair.${id}`)].filter((k) => typeof table[k] !== 'string' || !table[k].trim());
  ok(missing.length === 0, `i18n ${lang}: chair picker labels for 'painted' + every chair`, missing.join(', '));
}
const appJs = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
ok(/chairPicker\.addEventListener\('change', async \(\) => \{\s*chairList = await zumi\.chairs\.select\(chairPicker\.value\);\s*paintChairPicker\(\);\s*await applyChair\(\);/.test(appJs), 'app.js: a chair pick is stored via zumi.chairs.select, then repainted and applied');
ok(/\['painted', \.\.\.chairList\.chairs\.map\(\(c\) => c\.id\)\]/.test(appJs) && /chairPicker\.value = chairList\.selected;/.test(appJs), "app.js: the select offers 'painted' + every listed chair and shows the stored pick");

console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
