// T-31 parity step 5: static leak grep over the vault files (GATE-step5 conditions 3 and 6, PLAN §7 check 10).
// Plain Node, reads source only. No helper binary needed.
//
// Proves, from the source text:
//  A. vault.rs, src/bin/zumi-vault.rs, vault-adapter.mjs, secret-stores.mjs: every print/log sink (println!/eprintln!/dbg!,
//     console.*, process.stdout/stderr.write, the adapter's log()) takes only a fixed string literal. The two sinks that take
//     a variable are tagged `leak-ok` and are checked structurally (a `&'static str` code word / a fixed `code:` table).
//  B. the helper and the adapter never touch files or temp dirs; vault.rs's DPAPI/protect/unprotect half has no fs at all
//     (only the explicit import half, which writes under the destination dir, uses fs).
//  C. the adapter's argv is a literal verb, shell:false, windowsHide:true, and every thrown Error is a bare fixed constant:
//     no `cause`, no .stdout/.stderr/.cmd access.
//  D. no unwrap/expect/panic in the helper path (a panic message can print an Err's payload).
//  E. the host (lib.rs and the other Rust modules), the shim and the sidecar never print rpc params/args/bodies or secrets.
//
//   node scripts/check-tauri-vault-leaks.mjs     (exit 1 on any failure)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const RS = path.join(ROOT, 'tauri', 'src-tauri', 'src');
const SIDE = path.join(ROOT, 'tauri', 'sidecar');
let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${detail ? '  ' + detail : ''}`); } };
const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

/** Blank out comments (keeping line structure) while leaving string/char literals intact. */
export function stripComments(src, lang) {
  let out = '', i = 0, str = null;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (str) {
      out += c;
      if (c === '\\') { out += src[i + 1] ?? ''; i += 2; continue; }
      if (c === str) str = null;
      i++;
      continue;
    }
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') out += '\n'; i++; } i += 2; continue; }
    if (c === '"' || (lang === 'js' && (c === "'" || c === '`'))) { str = c; out += c; i++; continue; }
    // Rust lifetimes ('static, 'a) and char literals ('x', '\n'): skip a char literal, leave a lifetime alone.
    if (lang === 'rs' && c === "'") {
      const m = /^'(\\.|[^\\'])'/.exec(src.slice(i, i + 6));
      if (m) { out += m[0]; i += m[0].length; continue; }
    }
    out += c; i++;
  }
  return out;
}

/** Text of a balanced (...) group starting at the '(' at `open`. */
function groupAt(src, open) {
  let depth = 0, str = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (str) { if (c === '\\') i++; else if (c === str) str = null; continue; }
    if (c === '"' || c === "'" || c === '`') { str = c; continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return src.slice(open + 1, i); }
  }
  return src.slice(open + 1);
}

const lineOf = (src, idx) => src.slice(0, idx).split('\n').length;
const tagged = (raw, line) => (raw.split('\n')[line - 1] || '').includes('leak-ok') || (raw.split('\n')[line - 2] || '').includes('leak-ok');
const isRsLiteral = (a) => /^"(?:[^"\\{}]|\\.)*"$/.test(a.trim());
const isJsLiteral = (a) => /^(["'`])(?:(?!\1)[^\\$]|\\.)*\1$/.test(a.trim()) && !/\$\{/.test(a);

function sinks(raw, lang) {
  const code = stripComments(raw, lang);
  const re = lang === 'rs' ? /\b(?:e?print(?:ln)?|dbg)!\s*\(/g : /\b(?:console\.\w+|process\.std(?:out|err)\.write|log)\s*\(/g;
  const found = [];
  for (const m of code.matchAll(re)) {
    // skip `function log(`/`const log =` style declarations and the adapter's own `log = () => {}` default
    if (lang === 'js' && /(?:function|=>)\s*$/.test(code.slice(Math.max(0, m.index - 12), m.index))) continue;
    const open = m.index + m[0].length - 1;
    found.push({ call: m[0], arg: groupAt(code, open), line: lineOf(code, m.index) });
  }
  return { code, found };
}

const FILES = {
  'vault.rs': { p: path.join(RS, 'vault.rs'), lang: 'rs' },
  'bin/zumi-vault.rs': { p: path.join(RS, 'bin', 'zumi-vault.rs'), lang: 'rs' },
  'vault-adapter.mjs': { p: path.join(SIDE, 'vault-adapter.mjs'), lang: 'js' },
  'secret-stores.mjs': { p: path.join(SIDE, 'secret-stores.mjs'), lang: 'js' },
};
for (const f of Object.values(FILES)) ok(fs.existsSync(f.p), `${path.relative(ROOT, f.p)} exists`);
const RAW = Object.fromEntries(Object.entries(FILES).map(([k, f]) => [k, read(f.p)]));
// vault.rs has its unit tests in vault_tests.rs; the non-test half is what ships.
const vaultRs = RAW['vault.rs'];

// ---- A. sinks take only fixed literals (or a tagged, structurally checked variable) ----
for (const [name, f] of Object.entries(FILES)) {
  const { found } = sinks(RAW[name], f.lang);
  const bad = found.filter((s) => !(f.lang === 'rs' ? isRsLiteral(s.arg) : isJsLiteral(s.arg)) && !tagged(RAW[name], s.line));
  ok(bad.length === 0, `A: ${name}: every print/log sink takes a fixed literal or a tagged fixed code word (${found.length} sinks)`, bad.map((s) => `${s.call}${s.arg.slice(0, 40)} @${s.line}`).join(' | '));
  const tags = found.filter((s) => tagged(RAW[name], s.line) && !(f.lang === 'rs' ? isRsLiteral(s.arg) : isJsLiteral(s.arg)));
  console.log(`  (${name}: ${tags.length} tagged variable sink(s))`);
}
{
  const bin = RAW['bin/zumi-vault.rs'];
  ok(/fn fail\(code_word: &'static str, exit: u8\)/.test(bin), "A: the helper's only stderr sink is fail(code_word: &'static str, ..)");
  const stripped = stripComments(bin, 'rs');
  const calls = [...stripped.matchAll(/\bfail\(\s*([^,)]*(?:\([^)]*\))?[^,)]*)\s*,/g)].map((m) => m[1].trim()).filter((a) => a && !a.startsWith('code_word'));
  ok(calls.length >= 8 && calls.every((a) => /^"err:[a-z_0-9]+"$/.test(a) || /^e\.code\(\)$/.test(a)), 'A: every fail(..) call passes an "err:<word>" literal or e.code()', calls.filter((a) => !/^"err:[a-z_0-9]+"$/.test(a) && a !== 'e.code()').join(' | '));
  const words = [...vaultRs.matchAll(/=> "(err:[a-z_0-9]+)"/g)].map((m) => m[1]);
  ok(words.length === 6 && new Set(words).size === 6, 'A: VaultError::code() is a closed table of 6 fixed "err:" words', words.join());
  const adapter = stripComments(RAW['vault-adapter.mjs'], 'js');
  const codes = [...adapter.matchAll(/code:\s*([^}]+?)\s*}/g)].map((m) => m[1].trim());
  ok(codes.length >= 5 && codes.every((c) => /^'vault_[a-z_]+'$/.test(c)), "A: the adapter's log words come from a fixed 'vault_*' table", codes.join(' | '));
  const logged = [...adapter.matchAll(/\blog\(\s*'([a-z_]+)'\s*\)/g)].map((m) => m[1]);
  ok(logged.includes('vault_ready') && logged.includes('vault_probe_failed'), 'A: the adapter logs vault_ready / vault_probe_failed as literals');
}

// ---- B. no files or temp dirs ----
{
  const bin = stripComments(RAW['bin/zumi-vault.rs'], 'rs');
  ok(!/\bfs::|\bFile\b|temp_dir|OpenOptions|create_dir/.test(bin), 'B: zumi-vault.rs touches no file API (stdin/stdout only; import goes through vault.rs)');
  for (const n of ['vault-adapter.mjs', 'secret-stores.mjs']) {
    const js = stripComments(RAW[n], 'js');
    ok(!/writeFile|appendFile|mkdtemp|tmpdir|createWriteStream|\.rename\(|copyFile|openSync/.test(js), `B: ${n} writes no file and makes no temp dir`);
  }
  const code = stripComments(vaultRs, 'rs');
  const cut = code.indexOf('Chromium `v10`') >= 0 ? code.indexOf('Chromium `v10`') : code.indexOf('pub fn parse_v10');
  const head = code.slice(0, code.indexOf('pub fn parse_v10'));
  ok(cut > 0 && !/\bfs::|\bFile\b|temp_dir/.test(head), 'B: vault.rs before the v10/import half (blob format, DPAPI, protect, unprotect) has no fs API');
  const fsUses = [...code.matchAll(/\bfs::(\w+)/g)].map((m) => m[1]);
  ok(fsUses.every((u) => ['write', 'rename', 'remove_file', 'read', 'create_dir_all', 'canonicalize', 'read_dir'].includes(u)), 'B: the import half uses only read/write/rename/remove_file/create_dir_all/canonicalize', [...new Set(fsUses)].join());
  ok(!/\bglob\b|\bread_dir\b|\bwalkdir\b/i.test(code), 'B: the importer never lists a directory (fixed names only, no glob)');
  ok(!/Chrome|Edge|Brave|User Data/i.test(code), 'B: no Chrome/Edge/Brave path appears in vault.rs');
}

// ---- C. adapter argv, options, rethrow ----
{
  const js = stripComments(RAW['vault-adapter.mjs'], 'js');
  const runs = [...js.matchAll(/\brun\(\s*([^,)]+)/g)].map((m) => m[1].trim());
  ok(runs.length === 3 && runs.every((a) => /^'(available|protect|unprotect)'$/.test(a)), "C: every run(..) call passes a literal verb ('available' | 'protect' | 'unprotect')", runs.join());
  ok(/execFileSync\(v\.exe,\s*\[verb\]/.test(js), 'C: execFileSync is called with argv exactly [verb]');
  ok(/shell:\s*false/.test(js) && /windowsHide:\s*true/.test(js) && /timeout:\s*SPAWN_TIMEOUT_MS/.test(js) && /maxBuffer:\s*MAX_BUFFER/.test(js), 'C: shell:false, windowsHide:true, bounded timeout and maxBuffer');
  ok(!/\b(?:exec|execSync|spawn|spawnSync|fork)\s*\(/.test(js), 'C: no exec/spawn/fork anywhere (only execFileSync)');
  const throws = [...js.matchAll(/throw new Error\(([^)]*)\)/g)].map((m) => m[1].trim());
  ok(throws.length === 2 && throws.every((a) => /^(ENCRYPT_FAILED|DECRYPT_FAILED)$/.test(a)), 'C: the only thrown Errors are the two fixed constants (no options, no cause)', throws.join());
  ok(!/\bcause\b|\.stdout|\.stderr|\.cmd\b|\.status\b|\.signal\b/.test(js), 'C: no .cause/.stdout/.stderr/.cmd/.status/.signal is read or attached');
  ok(!/catch\s*\(\s*\w+\s*\)/.test(js), 'C: every catch is binding-less (the original error is unreachable)');
  ok(/ENV_KEYS = \['SystemRoot', 'USERPROFILE', 'APPDATA'\]/.test(js), 'C: env allow-list is exactly SystemRoot, USERPROFILE, APPDATA');
  ok(/basename\(vaultExe\) !== VAULT_EXE_NAME/.test(js) && /VAULT_EXE_NAME = 'zumi-vault\.exe'/.test(js) && /isAbsolute\(vaultExe\)/.test(js) && /samePath\(realDir, realHost\)/.test(js), 'C: --vault-exe must be absolute, exactly zumi-vault.exe, in the host dir');
}

// ---- D. no panic path in the helper ----
{
  for (const n of ['bin/zumi-vault.rs', 'vault.rs']) {
    let code = stripComments(RAW[n], 'rs');
    const t = code.indexOf('#[cfg(test)]');
    if (t >= 0) code = code.slice(0, t);
    const bad = [...code.matchAll(/\.unwrap\(\)|\.expect\(|\bpanic!|\bunreachable!|\btodo!|\bunimplemented!|\bassert!?(?:_eq|_ne)?!/g)].map((m) => m[0]);
    ok(bad.length === 0, `D: ${n}: no unwrap/expect/panic/assert in shipping code`, bad.join());
  }
}

// ---- E. the host, the shim and the sidecar never print rpc args or secrets ----
{
  const DENY = /\b(?:params|args|argv|request|req|body|secret|secrets|plain|plaintext|key|token|password|pass|pin|payload_text|value|data)\b/;
  const rsFiles = fs.readdirSync(RS).filter((n) => n.endsWith('.rs') && !/^vault/.test(n)).map((n) => path.join(RS, n));
  const hits = [];
  for (const f of rsFiles) {
    const raw = read(f);
    const cut = raw.indexOf('#[cfg(test)]');
    const { found } = sinks(cut >= 0 ? raw.slice(0, cut) : raw, 'rs');
    for (const s of found) {
      // names interpolated or passed: inline {ident} captures and trailing ident args; text inside the literal is prose
      const interp = [...s.arg.matchAll(/\{([A-Za-z_][\w.]*)(?::[^}]*)?\}/g)].map((m) => m[1].split('.')[0]);
      const rest = s.arg.replace(/"(?:[^"\\]|\\.)*"/g, '').split(/[^A-Za-z_0-9.]+/).filter(Boolean).map((x) => x.split('.')[0]);
      for (const id of [...interp, ...rest]) if (DENY.test(id)) hits.push(`${path.basename(f)}:${s.line} prints \`${id}\``);
    }
  }
  ok(hits.length === 0, 'E: no Rust host print macro names params/args/request/body/secret/key/token/plain/pin', hits.join(' | '));
  const lib = read(path.join(RS, 'lib.rs'));
  ok(!/\bsidecar_args\b|log::|tracing::/.test(lib) && !/eprintln!\([^;]*\b(?:params|args)\b/.test(lib), 'E: lib.rs never logs the rpc params it writes to the sidecar stdin');

  const shim = read(path.join(ROOT, 'tauri', 'shim', 'zumi-shim.js'));
  const shimLogs = [...stripComments(shim, 'js').matchAll(/console\.\w+\s*\(([^)]*)\)/g)].map((m) => m[1]);
  ok(shimLogs.every((a) => !/\b(?:args|params|arguments)\b/.test(a)), 'E: the shim logs only host sidecar:error payloads, never rpc args', shimLogs.join(' | ').slice(0, 120));
  ok(!/console\.\w+\s*\([^)]*\bargs\b/.test(stripComments(read(path.join(ROOT, 'tauri', 'shim', 'generate-shim.mjs')), 'js').split('const shim')[0] || ''), 'E: generate-shim.mjs does not template a console call on rpc args');

  const main = stripComments(read(path.join(SIDE, 'main.mjs')), 'js');
  const mainSinks = sinks(read(path.join(SIDE, 'main.mjs')), 'js').found.filter((s) => /stderr|stdout/.test(s.call));
  const bad = mainSinks.filter((s) => /\$\{\s*(?:params|args|msg|text|line|handler|result)\b/.test(s.arg));
  ok(bad.length === 0, 'E: sidecar main.mjs stderr/stdout writes never interpolate request params, the raw line or a handler result', bad.map((s) => `@${s.line}`).join());
  ok(/String\(\(e && e\.message\) \|\| e\)/.test(main), "E: dispatch returns only e.message (which the vault adapter makes a fixed string)");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
