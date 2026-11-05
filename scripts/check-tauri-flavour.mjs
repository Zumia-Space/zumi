// T-31 parity step 6-pre (F5) check: the build-flavour file. Gate: GATE-6pre.md item 2, conditions 1-3 and 5.
// Plain Node, no Electron, no window, no network.
//
//   1. public = no file (the writer deletes a stale one); absence is the only public form;
//   2. owner / selftest values are byte-equal to scripts/builder-selftest.cjs extraMetadata (one table, no drift);
//   3. the sidecar logs the resolved flavour once, and the reason when a file was ignored; any doubt = public;
//   5. cloudBase / boardMirror are https or loopback http, origin only; an unknown key ignores the whole file;
//   plus: a poisoned flavour.json in the DATA dir is never read.
//
//   node scripts/check-tauri-flavour.mjs   (exit 1 on any failure)
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { FLAVOUR_FILE, FLAVOURS, flavourFileText, resolveFlavour, validateFlavourDoc } from '../tauri/sidecar/flavour.mjs';
import { ownerPath } from './lib/owner-paths.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
const ok = (cond, name, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${detail ? '  ' + detail : ''}`); }
};

const TMP_ROOT = path.join(ROOT, '.tauri-check-tmp');
fs.mkdirSync(TMP_ROOT, { recursive: true });
const work = fs.mkdtempSync(path.join(TMP_ROOT, 'flavour-'));
const mk = (name) => { const d = path.join(work, name); fs.mkdirSync(d, { recursive: true }); return d; };

// ---- condition 2: the table is the builder's table ----
{
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'builder-selftest.cjs'), 'utf8');
  const at = src.indexOf('extraMetadata:');
  const open = src.indexOf('{', at);
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  // builder-selftest.cjs names the owner cloud base by OWNER_CLOUD_BASE (the owner-only values file's cloudBase)
  const meta = vm.runInNewContext(`(${src.slice(open, end)})`, { OWNER_CLOUD_BASE: ownerPath('cloudBase', null) });
  const fromBuilder = {
    v: 1,
    cloudBase: meta.zumiCloud.base,
    test: meta.zumiTest,
    reflexEgress: meta.zumiReflexJev.egress,
    ownerAdmin: meta.zumiOwnerAdmin,
    boardMirror: meta.zumiBoardMirror,
  };
  const want = JSON.stringify(fromBuilder);
  // The export has no owner values file, so nothing to compare the owner's cloud base with there.
  if (meta.zumiCloud.base !== null) ok(JSON.stringify({ v: 1, ...FLAVOURS.owner }) === want, 'owner values are byte-equal to builder-selftest.cjs extraMetadata', want);
  if (meta.zumiCloud.base !== null) ok(JSON.stringify({ v: 1, ...FLAVOURS.selftest }) === want, 'selftest values are byte-equal to builder-selftest.cjs extraMetadata');
  ok(Object.keys(meta).sort().join() === 'zumiBoardMirror,zumiCloud,zumiOwnerAdmin,zumiReflexJev,zumiTest', 'the builder sets exactly the five flags the table covers (a sixth needs a table row)', Object.keys(meta).join());
}

// ---- condition 1: public writes no file ----
{
  ok(flavourFileText('public') === null, 'public has no file text');
  ok(typeof flavourFileText('owner') === 'string' && JSON.parse(flavourFileText('owner')).ownerAdmin === true, 'owner has a file text');
  let threw = false;
  try { flavourFileText('admin'); } catch { threw = true; }
  ok(threw, 'an unknown flavour name is an error, not public');
  const out = mk('writer');
  const run = (name) => spawnSync(process.execPath, [path.join(ROOT, 'tauri', 'write-flavour.mjs'), '--flavour', name, '--out', out], { encoding: 'utf8' });
  ok(run('owner').status === 0 && fs.existsSync(path.join(out, FLAVOUR_FILE)), 'write-flavour owner writes flavour.json');
  ok(fs.readFileSync(path.join(out, FLAVOUR_FILE), 'utf8') === flavourFileText('owner'), 'the written file is exactly the table text');
  ok(run('public').status === 0 && !fs.existsSync(path.join(out, FLAVOUR_FILE)), 'write-flavour public removes a stale flavour.json and writes none');
  ok(run('nonsense').status !== 0 && !fs.existsSync(path.join(out, FLAVOUR_FILE)), 'write-flavour with an unknown name fails and writes none');
}

// ---- condition 5: strict schema ----
{
  const good = { v: 1, ...FLAVOURS.owner };
  ok(validateFlavourDoc(good).ok === true, 'the owner document validates');
  const code = (patch, drop) => {
    const d = { ...good, ...patch };
    if (drop) delete d[drop];
    return validateFlavourDoc(d).code;
  };
  ok(code({ extra: 1 }) === 'unknown_key', 'an unknown key ignores the whole file');
  ok(code({}, 'boardMirror') === 'bad_schema', 'a missing key ignores the whole file');
  ok(code({ v: 2 }) === 'bad_version', 'a wrong version is ignored');
  ok(code({ ownerAdmin: 'true' }) === 'bad_schema' && code({ test: 1 }) === 'bad_schema' && code({ reflexEgress: null }) === 'bad_schema', 'a non-boolean flag is ignored');
  for (const bad of ['http://cloud.example.org', 'http://127.0.0.1.evil.example', 'https://user:pw@cloud.example.org', 'https://cloud.example.org/path', 'https://cloud.example.org/', 'ftp://cloud.example.org', 'javascript:alert(1)', 'cloud.example.org', '', 'file:///C:/x']) {
    ok(code({ cloudBase: bad }) === 'bad_url' || code({ cloudBase: bad }) === 'bad_schema', `cloudBase ${JSON.stringify(bad)} is refused`);
    ok(code({ boardMirror: bad }) === 'bad_url' || code({ boardMirror: bad }) === 'bad_schema', `boardMirror ${JSON.stringify(bad)} is refused`);
  }
  ok(code({ cloudBase: 'http://localhost:3100' }) === undefined && code({ boardMirror: 'http://[::1]:3100' }) === undefined && code({ boardMirror: 'https://board.example' }) === undefined, 'https and loopback http origins are accepted');
  ok(validateFlavourDoc({ v: 1, ...FLAVOURS.public }).code === 'public_values_in_file', 'a file carrying only public values is ignored (absence is the only public form)');
  ok(validateFlavourDoc([]).ok === false && validateFlavourDoc(null).ok === false && validateFlavourDoc('x').ok === false, 'a non-object document is ignored');
}

// ---- condition 3 + trust: resolveFlavour is fail closed and logs ----
{
  const host = mk('host');
  const data = mk('data');
  const lines = [];
  const resolve = (flavourPath, hostDir) => { lines.length = 0; const r = resolveFlavour({ flavourPath, hostDir, log: (m) => lines.push(m) }); return r; };
  const put = (dir, text) => { const f = path.join(dir, FLAVOUR_FILE); fs.writeFileSync(f, text); return f; };

  let r = resolve(undefined, host);
  ok(r.name === 'public' && r.reason === 'no_file' && lines.length === 1 && /public \(no flavour file\)/.test(lines[0]), 'no --flavour = public, logged once', lines.join('|'));
  const hostFile = put(host, flavourFileText('owner'));
  r = resolve(hostFile, host);
  ok(r.name === 'owner' && r.reason === null && r.values.ownerAdmin === true && r.values.cloudBase === FLAVOURS.owner.cloudBase && lines.length === 1 && /^flavour: owner \(/.test(lines[0]), 'a good owner file beside the host resolves to owner, logged once', lines.join('|'));
  ok(!lines.join('').includes(new URL(FLAVOURS.owner.cloudBase).host) && !lines.join('').includes('127.0.0.1'), 'the log carries no URL');
  ok(Object.isFrozen(r.values), 'the resolved values are frozen');

  // The poisoned copy in the data dir: the only path the sidecar is ever given is --flavour, and its parent must be --host-dir.
  const poisoned = put(data, flavourFileText('owner'));
  r = resolve(poisoned, host);
  ok(r.name === 'public' && r.reason === 'wrong_parent' && /file ignored: wrong_parent/.test(lines[0]), 'a flavour.json in the data dir is refused (wrong_parent) and the reason is logged', lines.join('|'));
  r = resolve(undefined, host);
  ok(r.name === 'public', 'no --flavour never falls back to a file in the host dir or the data dir');
  r = resolve(path.join(host, 'sub', '..', FLAVOUR_FILE), host);
  ok(r.name === 'owner' || r.reason !== null, 'a dotted path is either the same real file or refused');
  r = resolve('flavour.json', host);
  ok(r.reason === 'not_absolute', 'a relative path is refused');
  const other = path.join(host, 'other.json');
  fs.writeFileSync(other, flavourFileText('owner'));
  r = resolve(other, host);
  ok(r.reason === 'bad_name', 'a file name other than flavour.json is refused');
  r = resolve(path.join(data, 'nope', FLAVOUR_FILE), host);
  ok(r.name === 'public' && r.reason !== null && lines.length === 1, 'a missing file = public with a reason');
  const empty = mk('empty-host');
  r = resolve(path.join(empty, FLAVOUR_FILE), empty);
  ok(r.reason === 'missing', 'a path whose file does not exist is reported as missing', String(r.reason));

  const bads = {
    parse_error: '{not json',
    unknown_key: JSON.stringify({ v: 1, ...FLAVOURS.owner, shell: true }),
    bad_url: JSON.stringify({ v: 1, ...FLAVOURS.owner, cloudBase: FLAVOURS.owner.cloudBase.replace('https:', 'http:') }),
    bad_schema: JSON.stringify({ v: 1, ...FLAVOURS.owner, ownerAdmin: 'yes' }),
    public_values_in_file: JSON.stringify({ v: 1, ...FLAVOURS.public }),
    too_large: JSON.stringify({ v: 1, ...FLAVOURS.owner, pad: 'x'.repeat(8000) }),
  };
  for (const [reason, text] of Object.entries(bads)) {
    const h = mk(`bad-${reason}`);
    const f = put(h, text);
    r = resolve(f, h);
    ok(r.name === 'public' && r.reason === reason && lines.length === 1 && lines[0].includes(reason), `a ${reason} file is ignored whole: public, reason logged once`, `${r.reason}|${lines.join('|')}`);
  }
}

// ---- the real sidecar: one flavour line at start; a poisoned data-dir file is never honoured ----
function runSidecar(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'tauri', 'sidecar', 'main.mjs'), ...args, '--no-voice-prefetch'], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
    let err = '';
    let out = '';
    child.stderr.on('data', (d) => { err += d; });
    child.stdout.on('data', (d) => { out += d; if (out.includes('"ready"')) child.stdin.end(); });
    child.on('close', () => resolve(err.split(/\r?\n/).filter((l) => l.includes('flavour:'))));
    setTimeout(() => child.kill(), 8000).unref();
  });
}
{
  const host = mk('sc-host');
  const data = mk('sc-data');
  fs.writeFileSync(path.join(data, FLAVOUR_FILE), flavourFileText('owner')); // poisoned: ownerAdmin true in the data dir
  let l = await runSidecar(['--data-dir', data]);
  ok(l.length === 1 && /flavour: public \(no flavour file\)/.test(l[0]), 'sidecar: a poisoned data-dir file with no --flavour = public, one log line', l.join('|'));
  l = await runSidecar(['--data-dir', data, '--flavour', path.join(data, FLAVOUR_FILE), '--host-dir', host]);
  ok(l.length === 1 && /public \(file ignored: wrong_parent\)/.test(l[0]), 'sidecar: --flavour pointing into the data dir is refused and the reason is logged', l.join('|'));
  l = await runSidecar(['--data-dir', data, '--flavour', path.join(data, FLAVOUR_FILE)]);
  ok(l.length === 1 && /public \(file ignored: bad_argument\)/.test(l[0]), 'sidecar: --flavour without --host-dir is refused', l.join('|'));
  fs.writeFileSync(path.join(host, FLAVOUR_FILE), flavourFileText('owner'));
  l = await runSidecar(['--data-dir', data, '--flavour', path.join(host, FLAVOUR_FILE), '--host-dir', host]);
  ok(l.length === 1 && /^\[sidecar\] flavour: owner \(/.test(l[0]), 'sidecar: a good owner file beside the host resolves to owner, one log line', l.join('|'));
  fs.writeFileSync(path.join(host, FLAVOUR_FILE), JSON.stringify({ v: 1, ...FLAVOURS.owner, boardMirror: 'http://evil.example' }));
  l = await runSidecar(['--data-dir', data, '--flavour', path.join(host, FLAVOUR_FILE), '--host-dir', host]);
  ok(l.length === 1 && /public \(file ignored: bad_url\)/.test(l[0]), 'sidecar: a bad mirror URL ignores the whole file', l.join('|'));
}

// ---- the resolved flag reaches the renderer: info.ownerAdmin is the flavour's own value (main.js:743) ----
function runSidecarInfo(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'tauri', 'sidecar', 'main.mjs'), ...args, '--no-voice-prefetch'], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let asked = false;
    const timer = setTimeout(() => { child.kill(); reject(new Error(`sidecar info timed out: ${err.slice(0, 200)}`)); }, 8000);
    child.stderr.on('data', (d) => { err += d; });
    child.stdout.on('data', (d) => {
      out += d;
      if (!asked && /"ready"/.test(out)) {
        asked = true;
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'info', params: [] })}\n`);
      }
      const line = out.split(/\r?\n/).find((l) => l.includes('"id":1'));
      if (!line) return;
      clearTimeout(timer);
      child.stdin.end();
      try { resolve(JSON.parse(line).result); } catch (e) { reject(e); }
    });
    child.on('close', () => clearTimeout(timer));
  });
}
{
  const host = mk('info-host');
  const data = mk('info-data');
  fs.writeFileSync(path.join(host, FLAVOUR_FILE), flavourFileText('owner'));
  const owner = await runSidecarInfo(['--data-dir', data, '--flavour', path.join(host, FLAVOUR_FILE), '--host-dir', host]);
  ok(owner && owner.ownerAdmin === true, 'sidecar info: the owner flavour answers ownerAdmin true (the renderer gates on it)', JSON.stringify(owner && owner.ownerAdmin));
  const pub = await runSidecarInfo(['--data-dir', data]);
  ok(pub && pub.ownerAdmin === false, 'sidecar info: a public build still answers ownerAdmin false', JSON.stringify(pub && pub.ownerAdmin));
}

// ---- Rust: the path comes from beside the host exe only; the data dir is never a source ----
{
  const lib = fs.readFileSync(path.join(ROOT, 'tauri', 'src-tauri', 'src', 'lib.rs'), 'utf8');
  ok(/fn flavour_beside\(host_exe: &std::path::Path\)/.test(lib) && /cmd\.arg\("--flavour"\)/.test(lib), 'lib.rs passes --flavour from flavour_beside(host exe)');
  const fn = lib.slice(lib.indexOf('fn flavour_beside'), lib.indexOf('fn sidecar_script'));
  ok(!/app_data_dir|data_dir/.test(fn), 'flavour_beside never touches the data dir');
}

fs.rmSync(work, { recursive: true, force: true });
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
