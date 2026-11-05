// Rig rules for speech gestures, headless in Node (no Electron, no window): loads the VRM with three + three-vrm, runs
// the same RigProbe the app runs before any composed gesture plays, over every speech-library variant (and its mirror
// when it points to a side) plus the self-test fixture commands that must be refused.
//   npm run check:rig -- --model <file.vrm>        (or ZUMI_TEST_MODEL; default: the shipped default avatar)
// Exit 0 only when every library variant passes R1-R6 and every "must fail" fixture fails the expected rule.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
// no --model / ZUMI_TEST_MODEL: the shipped default avatar (resources-pinned/default-model/PIN-MANIFEST.json)
const defaultVrmPath = () => createRequire(import.meta.url)('./lib/default-vrm.cjs').resolveSource();

// three's GLTFLoader decodes embedded textures with createImageBitmap; geometry and skeleton are all the probe needs.
globalThis.self = globalThis;
globalThis.window = globalThis;
globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });

const THREE = await import('three');
const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
const { VRMLoaderPlugin } = await import('@pixiv/three-vrm');
const { prepareVrm } = await import('../src/renderer/model-facing.js');
const { RigProbe } = await import('../src/renderer/talk/rigprobe.js');
const { SpeechLibrary } = await import('../src/renderer/talk/library.js');
const { checkSpeechGesture } = await import('../src/renderer/talk/validate.js');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const argAt = process.argv.indexOf('--model');
const modelPath = argAt >= 0 ? process.argv[argAt + 1] : (process.env.ZUMI_TEST_MODEL || defaultVrmPath());
if (!fs.existsSync(modelPath)) { console.error(`model not found: ${modelPath} (usage: npm run check:rig -- --model <file.vrm>)`); process.exit(2); }
const verbose = process.argv.includes('--verbose');

const buf = fs.readFileSync(modelPath);
const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const loader = new GLTFLoader();
loader.register((p) => new VRMLoaderPlugin(p));
// The app's own load path (src/renderer/app.js), not an inline copy: prepareVrm() also captures the model's base
// orientation, which Rig's body-frame IK rest frames need -- an inline clean-up skips the capture, so a VRM 0.x
// model would silently exercise the pre-round-3 (rolled) math here.
const prepare = prepareVrm;
const camera = new THREE.PerspectiveCamera(28, 1280 / 742, 0.05, 50);
const probe = await RigProbe.create({ loader, bytes, stageCamera: camera, catalog: null, prepare });
// the app's waist-up framing (src/renderer/app.js frameCamera), so gaze targets match what the user sees
{
  const rig = probe.rig, cam = probe.engine.camera;
  const s = rig.shoulderWidth, head = rig.headPos, hips = rig.hipsPos;
  const box = new THREE.Box3().setFromObject(probe.vrm.scene);
  const bottom = hips.y - 0.05 * s;
  const rawTop = Math.max(box.max.y, rig.shoulderY + 0.8 * rig.armLength, head.y + 0.6 * s);
  const top = rawTop + 0.04 * (rawTop - bottom);
  const cy = (top + bottom) / 2;
  const dist = ((top - bottom) / 2) / Math.tan((cam.fov / 2) * (Math.PI / 180)) * 1.03;
  cam.position.set(0, cy + 0.03 * (top - bottom), head.z + dist);
  cam.lookAt(0, cy, head.z);
  cam.updateMatrixWorld();
}

const lib = await SpeechLibrary.load(async (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'reflex', 'speech', f), 'utf8')));
const fx = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'main', 'cloud-fixtures.json'), 'utf8'));
const MUST_FAIL = { 'Thử một cử chỉ xuyên người nhé.': 'R2' };

let bad = 0;
const fmt = (r) => `R1 ${r.rules.R1.minF} · R2 ${r.rules.R2.hits.length} · flex ${r.rules.R3.maxFlexDeg} · twist ${r.rules.R3.maxTwistDeg} · feet ${r.rules.R4.maxDriftM} · back ${r.rules.R5.delta} · ${r.durationMs} ms · ${r.ms} ms check`;
let warned = 0;
const fmtMargins = (m) => Object.entries(m).map(([k, v]) => `${k} ${v == null ? '—' : v}`).join(' · ');
const show = (label, r, expect) => {
  const pass = expect ? r.fails.includes(expect) : r.ok;
  if (!pass) bad++;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label}${expect ? ` (must fail ${expect})` : ''}: ${r.ok ? 'rules ok' : `fails ${r.fails}`} · ${fmt(r)}`);
  console.log(`       margins (x cut-off, warn < 1.05): ${fmtMargins(r.margins)}`);
  if (!expect) for (const w of r.warnings) { warned++; console.log(`WARN ${label}: ${w.rule} margin ${w.margin} (value ${w.value}, cut-off ${w.cutoff}) — passes, but with less than 5 % to spare`); }
  if (verbose || !pass) for (const h of r.rules.R2.hits) console.log(`       R2 hit ${JSON.stringify(h)}`);
  if (verbose && r.rules.R2.deepest) console.log(`       R2 deepest ${JSON.stringify(r.rules.R2.deepest)}`);
};
console.log(`model ${path.basename(modelPath)} · torso core ${JSON.stringify(probe.core)} · head surfaces ${Boolean(probe.rig.surf)}`);
for (const [intent, def] of lib.byIntent) {
  for (const v of def.variants) {
    show(`${intent}/${v.id}`, probe.check(v.command));
    if (v.faces) show(`${intent}/${v.id} mirrored`, probe.check(v.command, { flip: true }));
  }
}
// --candidates <dir>: composed library candidates ({ intent, command } JSON files, e.g. the P5 compose output) —
// every one must pass the speech gate and R1-R6 before it may be imported into reflex/speech/<intent>.json
const candAt = process.argv.indexOf('--candidates');
if (candAt >= 0) {
  const dir = process.argv[candAt + 1];
  const verdicts = [];
  for (const f of fs.readdirSync(dir).filter((x) => /^[a-z-]+-\d+\.json$/.test(x)).sort()) {
    const rec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (!rec.command) { console.log(`SKIP candidate ${f}: no command (${(rec.errors || []).slice(0, 2).join('; ')})`); verdicts.push({ file: f, ok: false, why: 'no command' }); continue; }
    const gate = checkSpeechGesture(rec.command);
    if (!gate.ok) { bad++; console.log(`FAIL candidate ${f}: speech gate (${gate.errors[0]})`); verdicts.push({ file: f, ok: false, why: gate.errors[0] }); continue; }
    const r = probe.check(gate.command);
    show(`candidate ${rec.intent}/${f}`, r);
    verdicts.push({ file: f, intent: rec.intent, ok: r.ok, fails: r.fails, margins: r.margins, warnings: r.warnings });
  }
  fs.writeFileSync(path.join(dir, 'rig-verdicts.json'), JSON.stringify(verdicts, null, 1) + '\n');
}

for (const [line, g] of Object.entries(fx.gestures)) {
  if (!g.command) continue;
  const gate = checkSpeechGesture(g.command);
  if (!gate.ok) { console.log(`skip fixture "${line}": refused by the schema gate (${gate.errors[0]})`); continue; }
  show(`fixture "${line}"`, probe.check(gate.command), MUST_FAIL[line]);
}
console.log(`check:rig ${bad ? `${bad} FAILED` : 'all passed'}${warned ? ` · ${warned} margin warning(s)` : ''}`);
process.exit(bad ? 1 : 0);
