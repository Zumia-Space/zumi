// The owner installer carries the Room pack (plugin.room-preview) so a clean install and an upgrade show the room with no store
// and no hidden step (T-31-ROOM alpha.4; alpha.3 shipped no pack: the Phòng tab never appeared unless the pack was installed by hand).
//   node scripts/check-room-pack-seed.mjs   exit 0 = every row passes
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stageRoomPackSeed, stageInstallManifest, verifyStagedFlavour } from '../tauri/flavour-stage.mjs';

let pass = 0, fail = 0;
const ok = (c, name, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'} ${name}${d ? `  ${d}` : ''}`); c ? pass++ : fail++; };
const tmp = fs.mkdtempSync(path.join(process.env.CHECK_TMP || os.tmpdir(), 'room-seed-'));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function makePack(id = 'plugin.room-preview', tamper = false) {
  const dir = fs.mkdtempSync(path.join(tmp, 'pack-'));
  fs.mkdirSync(path.join(dir, 'ui'), { recursive: true });
  const html = Buffer.from('<!doctype html><title>room</title>');
  fs.writeFileSync(path.join(dir, 'ui', 'index.html'), html);
  const manifest = { format: 'zumi-pack/1', id, kind: 'plugin', version: '0.1.3', files: [{ path: 'ui/index.html', bytes: html.length, sha256: tamper ? '0'.repeat(64) : sha(html) }] };
  fs.writeFileSync(path.join(dir, 'zumi-pack.json'), JSON.stringify(manifest));
  return dir;
}
const mkStage = () => fs.mkdtempSync(path.join(tmp, 'stage-'));
const seeded = (stage) => path.join(stage, 'packs-seed', 'plugin.room-preview');

try {
  const src = makePack();
  for (const flavour of ['owner', 'selftest']) {
    const stage = mkStage();
    const r = stageRoomPackSeed(stage, flavour, { srcDir: src });
    ok(r.count === 2 && fs.existsSync(path.join(seeded(stage), 'zumi-pack.json')) && fs.readFileSync(path.join(seeded(stage), 'ui', 'index.html')).equals(fs.readFileSync(path.join(src, 'ui', 'index.html'))), `${flavour}: the pack is staged byte-for-byte under packs-seed/plugin.room-preview`);
    stageInstallManifest(stage);
    const m = JSON.parse(fs.readFileSync(path.join(stage, 'install-manifest.json'), 'utf8')).files;
    ok(Boolean(m['packs-seed/plugin.room-preview/ui/index.html']), `${flavour}: the install manifest lists the staged pack files`);
  }
  for (const flavour of ['public', 'official']) {
    const stage = mkStage();
    const r = stageRoomPackSeed(stage, flavour, { srcDir: src });
    ok(r.count === 0 && !fs.existsSync(path.join(stage, 'packs-seed')), `${flavour}: never stages the pack even when a source is given`);
    fs.mkdirSync(seeded(stage), { recursive: true });
    ok(verifyStagedFlavour(stage, flavour).some((p) => /packs-seed/.test(p)), `${flavour}: a stage holding packs-seed fails verifyStagedFlavour`);
  }
  { const stage = mkStage(); const r = stageRoomPackSeed(stage, 'owner', { srcDir: undefined, env: {} }); ok(r.count === 0 && !fs.existsSync(path.join(stage, 'packs-seed')), 'owner with no source set: nothing staged, no error (other owner builds stay as they were)'); }
  { let msg = ''; try { stageRoomPackSeed(mkStage(), 'owner', { srcDir: makePack('plugin.other') }); } catch (e) { msg = e.message; } ok(/plugin\.room-preview/.test(msg), 'a pack with another id is refused', msg); }
  { let msg = ''; try { stageRoomPackSeed(mkStage(), 'owner', { srcDir: makePack('plugin.room-preview', true) }); } catch (e) { msg = e.message; } ok(/sha/.test(msg), 'a file that does not match its listed sha256 is refused', msg); }
  { let msg = ''; try { stageRoomPackSeed(mkStage(), 'owner', { srcDir: path.join(tmp, 'nope') }); } catch (e) { msg = e.message; } ok(msg !== '', 'a source folder that does not exist is refused, not skipped', msg); }
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
console.log(`${pass}/${pass + fail} pass`);
process.exit(fail ? 1 : 0);
