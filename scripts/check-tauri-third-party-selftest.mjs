// Selftest of the Tauri third-party gate (scripts/check-tauri-third-party.mjs): it must FAIL for an unknown bundled file,
// for a missing full licence text, and for UNVERIFIED assets on the public flavour (owner = warn only). Uses the gate's
// test seams (ZUMI_TP_MANIFEST / ZUMI_TP_CREDITS / ZUMI_TP_EXTRA_FILES), never the real files.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const gate = path.join(root, 'scripts', 'check-tauri-third-party.mjs');
const tmp = fs.mkdtempSync(path.join(process.env.CHECK_TMP || os.tmpdir(), 'tp-selftest-'));
let pass = 0, fail = 0;
const ok = (c, n, d = '') => { if (c) { pass++; console.log(`PASS ${n}`); } else { fail++; console.log(`FAIL ${n} ${d}`); } };
const run = (args, env = {}) => { const r = spawnSync(process.execPath, [gate, ...args], { encoding: 'utf8', env: { ...process.env, ...env } }); return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }; };

try {
  const base = run(['--flavour', 'owner']);
  ok(base.code === 0 && (base.out.match(/^[ 	]+UNVERIFIED[ 	]+\S/gm) || []).length === 7 && (base.out.match(/UNVERIFIED\s+rooms-video\//g) || []).length === 7, 'owner flavour: green, only the 7 room mp4s listed as UNVERIFIED warnings', base.out.slice(-300));
  const pub = run(['--flavour', 'public']);
  ok(!/UNVERIFIED\s+\S/.test(pub.out) && (pub.out.match(/"OWNER-ATTESTED":(\d+)/) || [])[1] === '9', 'public flavour: the 9 owner-attested plates/copies pass (no UNVERIFIED left)', pub.out.slice(-300));

  // public: any unverified asset HARD FAILS (inject one through the manifest + extra-file seams)
  const mfU = JSON.parse(fs.readFileSync(path.join(root, 'tauri', 'third-party-manifest.json'), 'utf8'));
  mfU.unverified['assets/chair3d/unknown-art.png'] = 'selftest unverified';
  const unvFile = path.join(tmp, 'unverified.json'); fs.writeFileSync(unvFile, JSON.stringify(mfU));
  const pubUnv = run(['--flavour', 'public'], { ZUMI_TP_MANIFEST: unvFile, ZUMI_TP_EXTRA_FILES: JSON.stringify(['assets/chair3d/unknown-art.png']) });
  ok(pubUnv.code === 1 && /UNVERIFIED\s+assets\/chair3d\/unknown-art\.png/.test(pubUnv.out), 'public flavour: an UNVERIFIED asset HARD FAILS', pubUnv.out.slice(-200));

  // ---- OWNER-ATTESTED: verified only with source + verbatim quote + event id + note id + date + sha256 pin of the shipped file.
  // ---- the plates carry the neutral source line only; the record stays private (owner Q8).
  const PLATES = ['resources-pinned/room-v2/B-room-plate.png', 'resources-pinned/room-v2/B-talk-plate.png', 'resources-pinned/room-v2/B-work-plate.png', 'assets/chair3d/talk-plate-nochair.png', 'assets/rooms-video/chair-talk.png', 'tauri/ui/chair3d/plate-nochair.png', 'tauri/ui/rooms/default-v2/B-room-plate.png', 'tauri/ui/rooms/default-v2/B-talk-plate.png', 'tauri/ui/rooms/default-v2/B-work-plate.png'];
  const mfA = JSON.parse(fs.readFileSync(path.join(root, 'tauri', 'third-party-manifest.json'), 'utf8'));
  const realAtt = mfA.attested || {};
  ok(PLATES.every((k) => realAtt[k]) && Object.keys(realAtt).length === 9 && PLATES.every((k) => !(k in (mfA.unverified || {}))), 'OWNER-ATTESTED: exactly the 5 B plates + 4 tauri/ui copies are attested (none left unverified)', Object.keys(realAtt).join(','));
  // No generator is named anywhere public.
  const SOURCE = 'AI-generated image (owner-produced)';
  ok(PLATES.every((k) => realAtt[k] && realAtt[k].source === SOURCE && realAtt[k].date === '2026-10-26' && /^[0-9a-f]{64}$/.test(realAtt[k].sha256 || '') && !('quote' in realAtt[k]) && !('eventId' in realAtt[k])), 'OWNER-ATTESTED: every plate has the neutral source, the date and a sha256, and no quote or event id', JSON.stringify(realAtt[PLATES[0]]));
  ok(!Object.keys(realAtt).some((k) => /\.mp4$/i.test(k)), 'OWNER-ATTESTED: no room mp4 is attested');
  { const lic = fs.readFileSync(path.join(root, 'THIRD_PARTY_LICENSES.md'), 'utf8');
    ok(/AI-generated images/.test(lic), 'THIRD_PARTY_LICENSES.md says the room backgrounds are AI-generated images'); }
  { // sha256 pin: a changed byte in the shipped file breaks the attestation (copy of tauri/ui with one byte flipped)
    const uiCopy = path.join(tmp, 'ui'); fs.cpSync(path.join(root, 'tauri', 'ui'), uiCopy, { recursive: true });
    const plate = path.join(uiCopy, 'rooms', 'default-v2', 'B-room-plate.png'); const buf = fs.readFileSync(plate); buf[buf.length - 1] ^= 0xff; fs.writeFileSync(plate, buf);
    for (const fl of ['owner', 'public']) {
      const r = run(['--flavour', fl], { ZUMI_TP_UI_DIR: uiCopy });
      ok(r.code === 1 && /ATTESTATION-STALE\s+tauri\/ui\/rooms\/default-v2\/B-room-plate\.png/.test(r.out), `sha256 pin: one changed byte in an attested file FAILS the attestation (${fl})`, r.out.slice(-300));
    }
    const m = JSON.parse(JSON.stringify(mfA)); m.attested = m.attested || {}; m.attested['resources-pinned/room-v2/B-room-plate.png'] = { ...(m.attested['resources-pinned/room-v2/B-room-plate.png'] || {}) }; delete m.attested['resources-pinned/room-v2/B-room-plate.png'].sha256;
    const f = path.join(tmp, 'att-nosha.json'); fs.writeFileSync(f, JSON.stringify(m));
    const r = run(['--flavour', 'owner'], { ZUMI_TP_MANIFEST: f });
    ok(r.code === 1 && /ATTESTATION-STALE\s+resources-pinned\/room-v2\/B-room-plate\.png/.test(r.out), 'sha256 pin: an attested entry without a sha256 FAILS', r.out.slice(-300));
  }
  const attKeys = Object.keys(realAtt);
  ok(attKeys.length > 0, 'OWNER-ATTESTED: the field checks run against a real attested entry');
  if (attKeys.length) for (const field of ['source', 'date']) {
    for (const mode of ['missing', 'empty']) {
      const m = JSON.parse(JSON.stringify(mfA));
      if (mode === 'missing') delete m.attested[attKeys[0]][field]; else m.attested[attKeys[0]][field] = '  ';
      const f = path.join(tmp, `att-${field}-${mode}.json`); fs.writeFileSync(f, JSON.stringify(m));
      for (const fl of ['owner', 'public']) {
        const r = run(['--flavour', fl], { ZUMI_TP_MANIFEST: f });
        ok(r.code === 1 && /ATTEST-INCOMPLETE/.test(r.out) && r.out.includes(field), `OWNER-ATTESTED: ${mode} ${field} FAILS (${fl})`, r.out.slice(-200));
      }
    }
  }
  { // the real attested entries are reported with their status
    const okAtt = run(['--flavour', 'owner']);
    ok(okAtt.code === 0 && (okAtt.out.match(/"OWNER-ATTESTED":(\d+)/) || [])[1] === '9', 'OWNER-ATTESTED: the valid entries are verified and reported with their status', okAtt.out.slice(-200));
  }
  // public bundle must NOT contain the room videos
  const mp4Pub = run(['--flavour', 'public'], { ZUMI_TP_EXTRA_FILES: JSON.stringify(['rooms-video/01-cozy-study.mp4']) });
  ok(mp4Pub.code === 1 && /VIDEO-IN-PUBLIC\s+rooms-video\/01-cozy-study\.mp4/.test(mp4Pub.out), 'public: an mp4 present in the public bundle FAILS', mp4Pub.out.slice(-200));

  const unknown = run(['--flavour', 'owner'], { ZUMI_TP_EXTRA_FILES: JSON.stringify(['assets/chair3d/surprise.glb']) });
  ok(unknown.code === 1 && /UNMAPPED\s+assets\/chair3d\/surprise\.glb/.test(unknown.out), 'a file in the bundle but not in the manifest FAILS', unknown.out.slice(-200));

  const credits = fs.readFileSync(path.join(root, 'THIRD_PARTY_LICENSES.md'), 'utf8');
  const noText = path.join(tmp, 'credits-no-mit.md');
  fs.writeFileSync(noText, credits.replace(/Permission is hereby granted, free of charge/g, 'REMOVED'));
  const missing = run(['--flavour', 'owner'], { ZUMI_TP_CREDITS: noText });
  ok(missing.code === 1 && /NO-LICENCE-TEXT/.test(missing.out), 'a missing full MIT licence text FAILS', missing.out.slice(-200));

  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'tauri', 'third-party-manifest.json'), 'utf8'));
  manifest.map['assets/chair3d/*.glb'] = 'cc0-polyhaven-armchair-01';
  const wide = path.join(tmp, 'wide.json');
  fs.writeFileSync(wide, JSON.stringify(manifest));
  const glob = run(['--flavour', 'owner'], { ZUMI_TP_MANIFEST: wide });
  ok(glob.code === 1 && /WIDE-GLOB/.test(glob.out), 'a wide glob in the manifest FAILS (exact file lists only)', glob.out.slice(-200));

  // ---- gate NO-GO fixes (B1/B2, S1) ----
  const withStray = (rel, fn) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'stray'); try { return fn(); } finally { fs.rmSync(f, { force: true }); } };
  const voice = withStray('node_modules/kokoro-js/dist/stray-extra.js', () => run(['--flavour', 'owner']));
  ok(voice.code === 1 && /UNMAPPED\s+voice-modules\/node_modules\/kokoro-js\/dist\/stray-extra\.js/.test(voice.out), 'B1: an extra file inside a voice-module package FAILS (per-file manifest)', voice.out.slice(-200));

  const mf = JSON.parse(fs.readFileSync(path.join(root, 'tauri', 'third-party-manifest.json'), 'utf8'));
  const dml = Object.keys(mf.map).find((k) => k.endsWith('DirectML.dll'));
  ok(Boolean(dml) && mf.map[dml] === 'ms-directml-redistributable', 'B1: DirectML.dll is credited under the Microsoft redistributable terms, not MIT', String(mf.map[dml]));
  if (dml) {
    mf.map[dml] = 'mit-onnxruntime-nested';
    const wrong = path.join(tmp, 'dml-mit.json'); fs.writeFileSync(wrong, JSON.stringify(mf));
    const r = run(['--flavour', 'owner'], { ZUMI_TP_MANIFEST: wrong });
    ok(r.code === 1 && /LICENCE-MISMATCH/.test(r.out), 'B1: DirectML.dll mapped to MIT FAILS (licence id pinned per binary)', r.out.slice(-200));
  }

  const conf = JSON.parse(fs.readFileSync(path.join(root, 'tauri', 'src-tauri', 'tauri.conf.json'), 'utf8'));
  conf.bundle.resources['../../extra/'] = 'extra/';
  const confFile = path.join(tmp, 'tauri.conf.json'); fs.writeFileSync(confFile, JSON.stringify(conf));
  const extraRes = run(['--flavour', 'owner'], { ZUMI_TP_TAURI_CONF: confFile });
  ok(extraRes.code === 1 && /resources/.test(extraRes.out), 'B2: an extra tauri.conf bundle.resources entry FAILS', extraRes.out.slice(-200));

  const stageSrc = fs.readFileSync(path.join(root, 'tauri', 'stage-bundle.mjs'), 'utf8') + "\nfs.cpSync(path.join(repo, 'extra'), path.join(stage, 'extra'), { recursive: true });\n";
  const stageFile = path.join(tmp, 'stage-bundle.mjs'); fs.writeFileSync(stageFile, stageSrc);
  const cp = run(['--flavour', 'owner'], { ZUMI_TP_STAGE_SRC: stageFile });
  ok(cp.code === 1 && /COPY-PATH/.test(cp.out), 'B2: a stage copy path that is not copyTracked FAILS', cp.out.slice(-200));

  const ui = withStray('tauri/ui/stray-untracked.png', () => run(['--flavour', 'owner']));
  ok(ui.code === 1 && /UNMAPPED\s+tauri\/ui\/stray-untracked\.png/.test(ui.out), 'B2: an untracked file in frontendDist (tauri/ui) FAILS', ui.out.slice(-200));
  const room = withStray('resources-pinned/room-v2/stray-untracked.png', () => run(['--flavour', 'owner']));
  ok(room.code === 1 && /UNTRACKED/.test(room.out), 'B2: an untracked file in a staged asset tree FAILS', room.out.slice(-200));

  const body = credits.replace(/(Permission is hereby granted, free of charge[^`]*?)(?=\n\n|\n```)/, '$1').split('The above copyright notice and this permission notice shall be').join('CUT. ');
  const cut = path.join(tmp, 'credits-cut.md'); fs.writeFileSync(cut, body);
  const trunc = run(['--flavour', 'owner'], { ZUMI_TP_CREDITS: cut });
  ok(trunc.code === 1 && /NO-LICENCE-TEXT/.test(trunc.out), 'S1: a truncated MIT text FAILS (full text compared, not a substring)', trunc.out.slice(-200));

  const noGpl = path.join(tmp, 'credits-nogpl.md'); fs.writeFileSync(noGpl, credits.split('### GNU General Public License v3 (full text, for eSpeak NG)').join('REMOVED'));
  const gpl = run(['--flavour', 'owner'], { ZUMI_TP_CREDITS: noGpl });
  ok(gpl.code === 1 && /eSpeak/i.test(gpl.out), 'S4: eSpeak NG (GPL-3.0) without its shipped GPL text reference FAILS', gpl.out.slice(-200));

  const ps = fs.readFileSync(process.env.ZUMI_TP_BUILD_PS1 || path.join(root, 'tauri', 'build.ps1'), 'utf8');
  ok(/check-tauri-third-party\.mjs'\) --flavour \$Flavour/.test(ps) && /if \(-not \$NoBundle -and -not \$MeasureStub\) \{[^]*?check-tauri-third-party/.test(ps), 'S2: build.ps1 runs the third-party gate with the build flavour (public = hard fail) before the installer is made');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
