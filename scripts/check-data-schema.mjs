// T-31 P0 data-schema guard. Plain Node, no Electron, nothing opened, no network.
//
// Freezes the app's persisted surface so the Electron -> Tauri migration cannot silently miss it (the P0 review
// found DATA-SCHEMA.md had drifted: settings keys `chair3d`, `sceneRoom`, `defaultRoomGoodSha`,
// `defaultRoomV2GoodSha`, `hudStyle`, `hudVoiceMuted` and the file `userData/redact-names.json` were all absent).
//
// It greps src/main/**/*.{js,mjs,cjs} and FAILS if a source construct is not documented in
// docs/migration/data-schema.json:
//   1. settings keys, extracted from the settings accessors:
//        loadSettings().KEY / settings.get().KEY
//        saveSettings({ KEY: ... }) / settings.set({ KEY: ... })
//        settings.set(IDENT)  -> the top-level keys of `const IDENT = { ... }` in the same file
//   2. userData files/dirs, extracted from path.join(<userData base>, ...) calls, where <userData base> is one of
//        app.getPath('userData') | userDataDir | secretsDir | the identifier `dir`.
//      The top-level literal segments of the call are joined ('tts','kokoro' -> 'tts/kokoro'; a template literal
//      keeps its `${...}` text). Non-literal/other-base joins are ignored; unknown bases are a documented limit.
//   3. reverse (WARN only): settings keys documented but no longer referenced (stale doc).
//
//   node scripts/check-data-schema.mjs   (exit 1 on any failure)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src', 'main');
const SCHEMA_PATH = path.join(ROOT, 'docs', 'migration', 'data-schema.json');

let pass = 0, fail = 0, warn = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${detail ? '  ' + detail : ''}`); } };
const warnFn = (name, detail = '') => { warn++; console.log(`WARN ${name}${detail ? '  ' + detail : ''}`); };

// ---------- load the schema ----------
ok(fs.existsSync(SCHEMA_PATH), 'schema file exists (docs/migration/data-schema.json)');
if (!fs.existsSync(SCHEMA_PATH)) { console.log(`\n${pass} passed, ${fail} failed (fatal: no schema)`); process.exit(1); }
const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
const documentedKeys = new Set((schema.settingsKeys || []).map((k) => k.key));
const fileMatchers = (schema.userDataFiles || []).map((e) => ({ name: e.name, re: new RegExp(e.match) }));
ok(documentedKeys.size > 0, 'schema lists settings keys');
ok(fileMatchers.length > 0, 'schema lists userData files');

// ---------- read all source files ----------
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(js|mjs|cjs)$/.test(e.name)) files.push(p);
  }
})(SRC);
const source = files.map((f) => ({ file: path.relative(ROOT, f).split(path.sep).join('/'), text: fs.readFileSync(f, 'utf8') }));
ok(files.length > 0, `scanned ${files.length} source file(s) under src/main`);

// ---------- helpers ----------
/** Top-level keys of the object literal whose '{' is at src[openIdx]. Nested objects and string/template bodies are skipped. */
function topLevelObjectKeys(src, openIdx) {
  const keys = [];
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') {
      const q = c; i++;
      while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++; }
      continue;
    }
    if (c === '{') { depth++; continue; }
    if (c === '}') { depth--; if (depth === 0) break; continue; }
    if (depth === 1 && /[A-Za-z_$]/.test(c)) {
      let j = i; while (j < src.length && /[\w$]/.test(src[j])) j++;
      const id = src.slice(i, j);
      let k = j; while (k < src.length && /\s/.test(src[k])) k++;
      // a real property key is preceded (ignoring whitespace) by '{' or ','; this rejects `p.style :` (ternary) values
      let p = i - 1; while (p >= 0 && /\s/.test(src[p])) p--;
      if (src[k] === ':' && (src[p] === '{' || src[p] === ',')) keys.push(id);
      i = j - 1; continue;
    }
  }
  return keys;
}

function extractSettingsKeys(src) {
  const keys = new Set();
  for (const m of src.matchAll(/\b(?:loadSettings\(\)|settings\.get\(\))\s*\.\s*([A-Za-z_$][\w$]*)/g)) keys.add(m[1]);
  for (const m of src.matchAll(/\b(?:saveSettings|settings\.set)\(\s*\{/g)) {
    const open = m.index + m[0].length - 1;
    for (const k of topLevelObjectKeys(src, open)) keys.add(k);
  }
  for (const m of src.matchAll(/\b(?:saveSettings|settings\.set)\(\s*([A-Za-z_$][\w$]*)\s*\)/g)) {
    const id = m[1];
    const re = new RegExp('(?:const|let|var)\\s+' + id + '\\s*=\\s*\\{', 'g');
    // the object variable is the LAST `const IDENT = { ... }` before the call (identifiers like `next` are reused)
    let bestOpen = -1, bestAt = -1, a;
    while ((a = re.exec(src))) { if (a.index < m.index && a.index > bestAt) { bestAt = a.index; bestOpen = a.index + a[0].length - 1; } }
    if (bestOpen >= 0) for (const k of topLevelObjectKeys(src, bestOpen)) keys.add(k);
  }
  return keys;
}

/** path.join(<userData base>, 'a', 'b') -> 'a/b'. Literal segments only; string/template bodies handled. */
function extractUserDataFiles(src) {
  const out = new Set();
  const baseRe = /(userData|userDataDir|secretsDir|\bdir\b)/;
  let idx = 0;
  while ((idx = src.indexOf('path.join(', idx)) !== -1) {
    const start = idx + 'path.join('.length;
    // first top-level comma splits the base argument from the rest
    let depth = 0, i = start, baseEnd = -1;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === "'" || c === '"' || c === '`') { const q = c; i++; while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++; } continue; }
      if (c === '(') { depth++; continue; }
      if (c === ')') { depth--; if (depth < 0) break; continue; }
      if (c === ',' && depth === 0) { baseEnd = i; break; }
    }
    const base = src.slice(start, baseEnd === -1 ? i : baseEnd);
    if (baseRe.test(base)) {
      const segs = [];
      let d = 0;
      for (let j = start; j < src.length; j++) {
        const c = src[j];
        if (c === "'" || c === '"' || c === '`') {
          const q = c; let k = j + 1, val = '';
          while (k < src.length && src[k] !== q) { if (src[k] === '\\') { val += src[k + 1] || ''; k += 2; continue; } val += src[k]; k++; }
          if (d === 0) segs.push(val);
          j = k; continue;
        }
        if (c === '(') { d++; continue; }
        if (c === ')') { d--; if (d < 0) break; continue; }
      }
      const joined = segs.join('/');
      if (joined) out.add(joined);
    }
    idx = start;
  }
  return out;
}

// ---------- settings keys: forward (hard) + reverse (warn) ----------
const foundKeys = new Set();
for (const s of source) for (const k of extractSettingsKeys(s.text)) foundKeys.add(k);
const undocumentedKeys = [...foundKeys].filter((k) => !documentedKeys.has(k)).sort();
ok(undocumentedKeys.length === 0, `every settings key in source is documented (${documentedKeys.size} documented, ${foundKeys.size} found)`,
  undocumentedKeys.length ? `undocumented: ${undocumentedKeys.join(', ')}` : '');
const staleKeys = [...documentedKeys].filter((k) => !foundKeys.has(k)).sort();
if (staleKeys.length) warnFn(`${staleKeys.length} documented settings key(s) not found in source (stale doc?)`, staleKeys.join(', '));

// ---------- userData files: forward (hard) ----------
const candidates = new Set();
for (const s of source) for (const c of extractUserDataFiles(s.text)) candidates.add(c);
const undocumentedFiles = [...candidates].filter((c) => !fileMatchers.some((m) => m.re.test(c))).sort();
ok(undocumentedFiles.length === 0, `every userData file/path in source is documented (${fileMatchers.length} documented, ${candidates.size} found)`,
  undocumentedFiles.length ? `undocumented: ${undocumentedFiles.join(', ')}` : '');

// ---------- anchors: the exact gaps this check was added to catch ----------
for (const k of ['chair3d', 'sceneRoom', 'defaultRoomV2GoodSha', 'hudStyle']) { // hudVoiceMuted is legacy from talk-mode 0.2.5 (folded into talkLevel); defaultRoomGoodSha is legacy since room v1 was removed (2026-10-26): neither is an anchor any more
  ok(foundKeys.has(k), `sanity: settings key '${k}' is captured from source`);
}
ok(candidates.has('redact-names.json'), 'sanity: userData file redact-names.json is captured from source');

console.log(`\n${pass} passed, ${fail} failed, ${warn} warning(s)`);
process.exit(fail ? 1 : 0);
