// check:installer-exclude (T-31-YOKI, plan M4 / step 4.1 note): the filler CANDIDATES are audition material, never shipped.
// build.files must exclude assets/voice-fillers/**/candidates/** while the rest of assets/** (and a future shipped
// assets/voice-fillers/<voiceKey>/manifest.json + chosen clips) stays in. Reads the EFFECTIVE file list: every tracked file under assets/
// run through build.files with the same order-based include/exclude as scripts/check-third-party.mjs (its globToRe/applyPatterns, copied
// verbatim: that script deletes and rebuilds a scratch folder, so it is not imported). Both configs are read: package.json "build"
// (Electron, the release payload) and scripts/builder-public.cjs (the public payload, base.files + Zumi-only exclusions).
// No build, no packaging, no network.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
let pass = 0, fail = 0;
const ok = (c, name, detail = '') => { if (c) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); } };

const globToRe = (g) => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '\u0001').replace(/\*\*/g, '\u0002').replace(/\*/g, '[^/]*').replace(/\u0001/g, '(?:.*/)?').replace(/\u0002/g, '.*') + '$');
function applyPatterns(patterns, paths) {
  const pats = (patterns && patterns.length ? patterns : ['**/*']).map((p) => ({ neg: p.startsWith('!'), re: globToRe(p.replace(/^!/, '')) }));
  return paths.filter((f) => { let inc = false; for (const p of pats) if (p.re.test(f)) inc = !p.neg; return inc; });
}

const tracked = execFileSync('git', ['ls-files', 'assets'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
// What the tree holds now, plus the files step 4.2/4.3 will add (so the rule is proven for them before they exist).
const FUTURE_SHIPPED = ['assets/voice-fillers/kokoro-af_heart/manifest.json', 'assets/voice-fillers/kokoro-af_heart/hum-1.wav', 'assets/voice-fillers/vi-voice/manifest.json'];
const FUTURE_CANDIDATES = ['assets/voice-fillers/vi-voice/candidates/oh-1.wav', 'assets/voice-fillers/kokoro-af_heart/candidates/deeper/take.wav', 'assets/voice-fillers/candidates/x.wav'];
const paths = [...tracked, ...FUTURE_SHIPPED, ...FUTURE_CANDIDATES];
const isCandidate = (f) => /^assets\/voice-fillers\/(?:.*\/)?candidates\//.test(f);

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const configs = { 'package.json build.files': pkg.build.files };
try { configs['builder-public.cjs files'] = require('./builder-public.cjs').files; } catch (e) { ok(false, 'builder-public.cjs loads', String(e.message).slice(0, 160)); }

const candidatesTracked = tracked.filter(isCandidate);
ok(candidatesTracked.length >= 13, 'the tree holds the 4.1 candidates to be excluded (12 wav + manifest.json)', String(candidatesTracked.length));
for (const [name, files] of Object.entries(configs)) {
  const shipped = new Set(applyPatterns(files, paths));
  ok(candidatesTracked.every((f) => !shipped.has(f)), `${name}: no tracked candidate ships`, candidatesTracked.filter((f) => shipped.has(f)).join(','));
  ok(FUTURE_CANDIDATES.every((f) => !shipped.has(f)), `${name}: a candidates/ folder at any depth under voice-fillers never ships`);
  ok(FUTURE_SHIPPED.every((f) => shipped.has(f)), `${name}: the chosen clips and manifest.json beside the candidates folder still ship`);
  // The exclude is the ONLY difference: shipped(with) equals shipped(without the pattern) minus the candidates. (The public payload drops
  // Zumi-only assets on its own; that is not this step's business, so it is compared against itself.)
  const without = applyPatterns(files.filter((p) => p !== '!assets/voice-fillers/**/candidates/**'), paths).filter((f) => !isCandidate(f));
  ok(without.length > 0 && without.length === shipped.size && without.every((f) => shipped.has(f)), `${name}: the rest of assets/** is untouched (${shipped.size} files in the shipped list, all non-candidates)`, `${without.length} vs ${shipped.size}`);
}
// the release payload keeps ALL of the rest, exactly
{
  const shipped = new Set(applyPatterns(pkg.build.files, tracked));
  const rest = tracked.filter((f) => !isCandidate(f));
  ok(shipped.size === rest.length && rest.every((f) => shipped.has(f)), 'package.json build.files: shipped assets = tracked assets minus the candidates, nothing more, nothing less', `${shipped.size} vs ${rest.length}`);
}
// negative control: without the new pattern the candidates ship (so the checks above prove the pattern, not the data)
{
  const without = pkg.build.files.filter((p) => p !== '!assets/voice-fillers/**/candidates/**');
  ok(without.length === pkg.build.files.length - 1, 'control: the exclude pattern is in build.files');
  const shipped = new Set(applyPatterns(without, tracked));
  ok(candidatesTracked.every((f) => shipped.has(f)), 'control: without the pattern every candidate ships (assets/** takes them)');
}
// order matters for this filter: the exclude must come after assets/**
{
  const i = pkg.build.files.indexOf('assets/**'), j = pkg.build.files.indexOf('!assets/voice-fillers/**/candidates/**');
  ok(i >= 0 && j > i, 'the exclude comes after assets/** (order-based filter)');
}
console.log(`\ncheck:installer-exclude ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
