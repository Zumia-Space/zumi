// T-31 settings-a2: the --settings-shots sample data (fake provider + model list, fake key check, voice-model state,
// seeded usage ledger) can never reach a user build.
//   1. static: every fixture in main.js sits behind `settingsShotsDir`, and `settingsShotsDir` is null whenever the
//      app is packaged (an installed build ignores --settings-shots outright);
//   2. runtime: a NORMAL launch (--settings-probe: no fixture, a fresh userData, window off-screen, never on the
//      owner's screen) shows real or empty values in every Settings card -- no sample provider, no sample usage,
//      no fake 64% download.
// Voice is turned off in the probe's fresh settings.json so the launch does not download the 160 MB voice model.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertElectronHost } from './lib/electron-guard.cjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); } };

// ---------- 1. static ----------
const main = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.js'), 'utf8');
ok(/const settingsShotsDir = \(app\.isPackaged \|\|/.test(main), 'main: settingsShotsDir is null in a packaged build (app.isPackaged first)');
ok(/const settingsProbeDir = \(app\.isPackaged \|\|/.test(main), 'main: the probe mode is source-tree only too');
// Ranges of every `if (settingsShotsDir) {` block (brace-matched).
const guarded = [];
for (const m of main.matchAll(/if \(settingsShotsDir\) \{/g)) {
  let depth = 0, i = m.index + m[0].length - 1;
  for (; i < main.length; i++) { if (main[i] === '{') depth++; else if (main[i] === '}' && --depth === 0) break; }
  guarded.push([m.index, i]);
}
const FIXTURES = [/shotsVoiceState/g, /shotsRoleFixtures/g, /role-models-fixtures\.json/g, /shotsProviderFetch/g, /shotsChatFetch/g, /shotsRoleModels\(/g, /shots:seed-usage/g, /shots:voice-state/g, /shots:roles-provider/g];
const DECLARATIONS = [/^let shotsVoiceState = /, /^let shotsRoleFixtures = /, /^function shotsProviderFetch\(/, /^function shotsChatFetch\(/, /^function shotsRoleModels\(/];
const stray = [];
for (const re of FIXTURES) {
  for (const m of main.matchAll(re)) {
    const lineStart = main.lastIndexOf('\n', m.index) + 1;
    const line = main.slice(lineStart, main.indexOf('\n', m.index));
    if (/^\s*\/\//.test(line)) continue; // a comment
    if (DECLARATIONS.some((d) => d.test(line))) continue;
    if (/settingsShotsDir \?|if \(settingsShotsDir\)/.test(line)) continue;
    if (guarded.some(([a, b]) => m.index > a && m.index < b)) continue;
    stray.push(`${m[0]} @ ${line.trim().slice(0, 80)}`);
  }
}
ok(guarded.length >= 2 && stray.length === 0, `main: every fixture use is behind settingsShotsDir (${guarded.length} guarded blocks)`, JSON.stringify(stray));
ok(/if \(roomShotsDir \|\| boardStressDir \|\| settingsShotsDir\) registerShotsIpc\(\);/.test(main), 'main: the shots IPC (seed usage, voice state, provider switch) is registered only in a shots run');

// ---------- 2. runtime: a normal launch ----------
// Starts electron.exe: render box only (scripts/lib/electron-guard.cjs). On anh's main PC part 1 above still runs, then this throws.
assertElectronHost('check-settings-normal-launch.mjs part 2 (electron . --settings-probe)');
const electron = path.join(ROOT, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
if (!fs.existsSync(electron)) {
  ok(false, 'electron binary present for the runtime probe', electron);
} else {
  const build = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build-renderer.mjs')], { cwd: ROOT, encoding: 'utf8' });
  ok(build.status === 0, 'renderer built for the probe', (build.stderr || '').slice(0, 200));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-probe-'));
  fs.mkdirSync(path.join(dir, 'ud'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'ud', 'settings.json'), JSON.stringify({ voiceEnabled: false }));
  const run = spawnSync(electron, ['.', '--settings-probe', dir], { cwd: ROOT, encoding: 'utf8', timeout: 120000, env: { ...process.env, ELECTRON_ENABLE_LOGGING: '' } });
  const file = path.join(dir, 'probe.json');
  const r = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  ok(run.status === 0 && r && r.ok, 'probe: the app launched normally, opened Settings and reported', `exit=${run.status} ${r ? r.error || '' : 'no probe.json'}`);
  if (r && r.ok) {
    ok(r.settingsShots === false && r.packaged === false, 'probe: not a shots run (no fixture active)');
    ok(r.brain.chip === 'No key' && r.brain.editShown && !r.brain.viewShown && /No key yet/.test(r.brain.desc), 'probe: AI brain shows the real state of a fresh install: "No key" + the key field', JSON.stringify(r.brain));
    ok(JSON.stringify(r.brain.provider) === JSON.stringify([{ text: 'OpenRouter', disabled: false, selected: true }, { text: 'More coming soon', disabled: true, selected: false }]), 'probe: provider dropdown = OpenRouter selected + disabled "More coming soon", nothing else', JSON.stringify(r.brain.provider));
    ok(!r.roles.gridShown && /No AI provider/.test(r.roles.status), 'probe: Models by role says no provider (the sample model list is NOT shown)', r.roles.status);
    const sum = r.usage.summary;
    ok(sum.length === 3 && sum.every((row) => row[1] === '0' && row[2] === '0' && row[3] === '$0.0000') && r.usage.detailRows === 0 && r.usage.emptyShown, 'probe: Usage is empty (zeros, no rows, "No usage recorded yet") -- not the sample ledger', JSON.stringify(sum));
    ok(!r.voice.modelRowShown && r.voice.progress === '', 'probe: no fake "64%" voice-model download row', JSON.stringify(r.voice));
    ok(r.voice.ledaChip === 'No key' && r.voice.speed === '1' && r.voice.volume === '100', 'probe: Vietnamese voice "No key", speed 1x, volume 100% (defaults)', JSON.stringify(r.voice));
    ok(r.account.chip === 'Not set up' && r.account.formShown, 'probe: Account shows the real first-run sign-in form');
    const sample = ['Gemini 3.8 Flash', 'Kimi K3', 'DeepSeek V4 Flash', 'Jev 1.13', '64%', 'shots'];
    ok(!sample.some((s) => r.settingsText.includes(s)), 'probe: no sample-data string anywhere in Settings', sample.filter((s) => r.settingsText.includes(s)).join(','));
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
console.log(fail ? `FAIL check-settings-normal-launch — ${fail} failed` : `PASS check-settings-normal-launch — ${pass}/${pass} assertions passed`);
process.exitCode = fail ? 1 : 0;
