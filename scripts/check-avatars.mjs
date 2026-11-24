// R6 item 7 + R6c D: the v4 avatar presets (owner approved 19-11) are the default avatar set and are SHOWN in the app. Each built-in bot gets a different preset; the user choice wins.
// The SVGs are self-drawn (the builder's own procedural code; no third-party art) and self-contained (no external reference).
//   node scripts/check-avatars.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, name, detail = '') => { if (c) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); } };
let mod = null;
try { mod = await import('../src/renderer/avatars.js'); } catch (e) { ok(false, 'src/renderer/avatars.js loads', String(e && e.message)); }
const { PRESETS, BUILT_IN, defaultPreset, avatarFor, avatarUrl } = mod || {};

ok(Array.isArray(PRESETS) && PRESETS.length === 12 && new Set(PRESETS).size === 12, 'twelve v4 presets', JSON.stringify(PRESETS));
const dir = path.join(ROOT, 'src/renderer/avatars/v4');
for (const p of PRESETS || []) {
  const file = path.join(dir, `${p}.svg`);
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { /* reported below */ }
  ok(text.startsWith('<svg') && text.length > 1000 && text.length < 120_000, `${p}.svg is there and is an svg of sane size`, String(text.length));
  ok(/zumiAvatar&quot;:4/.test(text), `${p}.svg carries the builder's v4 marker (drawn by the app's own builder)`);
  const refs = text.replace('xmlns="http://www.w3.org/2000/svg"', '');
  ok(!/https?:|href\s*=|<image|<script|<foreignObject|@import|url\(\s*['"]?(?!#)/i.test(refs), `${p}.svg is self-contained: no external reference, script, image or foreign object`);
}
ok(avatarUrl && avatarUrl('ke-toan') === 'avatars/v4/ke-toan.svg' && avatarUrl('../x') === null && avatarUrl('nope') === null, 'avatarUrl: a known preset only, relative to the renderer page; no path tricks');
const builtIn = Object.entries(BUILT_IN || {});
ok(builtIn.length >= 5 && builtIn.every(([, p]) => (PRESETS || []).includes(p)), 'every built-in bot names a known preset', JSON.stringify(BUILT_IN));
ok(new Set(builtIn.map(([, p]) => p)).size === builtIn.length, 'each built-in bot gets a DIFFERENT preset');
ok(['zumi', 'plan', 'do', 'check', 'lookup'].every((id) => id in (BUILT_IN || {})), 'Zumi and the four roles are the built-in bots');
ok(builtIn.every(([id, p]) => defaultPreset(id) === p), 'defaultPreset of a built-in bot is its own');
// A persona made later: stable, valid, and the free preset first.
const free = (PRESETS || []).filter((p) => !builtIn.some(([, b]) => b === p));
ok(free.length >= 1 && defaultPreset('persona-1') === free[0] && defaultPreset('persona-1') === defaultPreset('persona-1'), 'the first new persona gets the preset no built-in bot has, and the same one every time', JSON.stringify({ free, got: defaultPreset && defaultPreset('persona-1') }));
const many = Array.from({ length: 12 }, (_, i) => defaultPreset(`persona-${i}`));
ok(many.every((p) => (PRESETS || []).includes(p)) && new Set(many).size >= 4, 'many personas: always a valid preset, spread over the set', JSON.stringify(many));
ok(defaultPreset('') === (PRESETS || [])[0] && defaultPreset(undefined) === (PRESETS || [])[0] && defaultPreset(42) === (PRESETS || [])[0], 'an unusable id gets the first preset, never undefined');
// The user's choice wins; a bad one is ignored.
ok(avatarFor('check', { check: 'cham-soc-khach' }) === 'cham-soc-khach', 'the user can change a bot\'s avatar');
ok(avatarFor('check', { check: 'not-a-preset' }) === BUILT_IN.check && avatarFor('check', { check: '../etc' }) === BUILT_IN.check && avatarFor('check', null) === BUILT_IN.check && avatarFor('check') === BUILT_IN.check, 'a choice that is not a preset is ignored (default kept)');
ok(avatarFor('check', { zumi: 'ke-toan' }) === BUILT_IN.check, 'another bot\'s choice does not move this one');
// R6c D: the old v3 set is gone, and the avatar is in the screens where a bot is shown (the roles list, the chat panel).
ok(!fs.existsSync(path.join(ROOT, 'src/renderer/avatars/v3')), 'the v3 set is replaced, not kept beside the v4 one');
const readSrc = (f) => { try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { return ''; } };
const roles = readSrc('src/renderer/role-models.js');
ok(/from '\.\/avatars\.js'/.test(roles) && /avatarUrl\(avatarFor\(role/.test(roles) && /role-avatar/.test(roles), 'the roles list shows each role\'s avatar');
const html = readSrc('src/renderer/index.html');
const app = readSrc('src/renderer/app.js');
ok(/id="talk-avatar"/.test(html) && /avatarUrl\(avatarFor\('zumi'/.test(app) && /talk-avatar/.test(app), 'the chat panel shows Zumi\'s avatar');
const css = readSrc('src/renderer/styles.css');
ok(/\.role-avatar\s*\{/.test(css) && /\.talk-avatar\s*\{/.test(css), 'the avatar has a size in the stylesheet');
// R6d: the pictures reach the built renderer. The screens ask for avatars/v4/<preset>.svg next to index.html; the build copied none of them,
// so the shipped app and check-brain's build 404ed on every one (check-brain, R6c D). prep-ui copies the built folder as it is.
const builder = readSrc('scripts/build-renderer.mjs');
ok(/avatars/.test(builder) && /copyFileSync\(.*'avatars'/.test(builder), 'build-renderer.mjs copies the avatar SVGs into the built renderer (avatars/v4/)');

// R7b M4 (gate R7): the SVGs must be in the BUILT renderer (what prep-ui embeds), not only in the source tree. Build into a scratch folder
// (ZUMI_RENDERER_OUT, the same switch the licence gate uses) and compare every preset byte for byte.
{
  const { execFileSync } = await import('node:child_process');
  const os = await import('node:os');
  const built = fs.mkdtempSync(path.join(os.tmpdir(), 'zumi-avatars-built-'));
  let buildOk = true;
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts/build-renderer.mjs')], { cwd: ROOT, env: { ...process.env, ZUMI_RENDERER_OUT: built }, stdio: 'pipe' });
  } catch (e) { buildOk = false; ok(false, 'the renderer builds into a scratch folder', String(e && e.message).slice(0, 300)); }
  if (buildOk) {
    const builtApp = fs.readFileSync(path.join(built, 'app.js'), 'utf8');
    ok(builtApp.includes('avatars/v4/'), 'the built app.js asks for avatars/v4/<preset>.svg');
    for (const p of PRESETS || []) {
      const a = path.join(built, 'avatars', 'v4', `${p}.svg`);
      ok(fs.existsSync(a) && fs.readFileSync(a).equals(fs.readFileSync(path.join(dir, `${p}.svg`))), `the built renderer carries avatars/v4/${p}.svg, byte-identical to the source`);
    }
    const extra = fs.existsSync(path.join(built, 'avatars', 'v4')) ? fs.readdirSync(path.join(built, 'avatars', 'v4')).filter((f) => !(PRESETS || []).includes(f.replace(/\.svg$/, ''))) : [];
    ok(extra.length === 0, 'the built avatar folder holds the presets only', JSON.stringify(extra));
  }
  fs.rmSync(built, { recursive: true, force: true });
}
console.log(`\ncheck:avatars ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
