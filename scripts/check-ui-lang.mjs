// UI language gate (T-31 ui-english): the whole app defaults to English, so no Vietnamese literal may live in the
// renderer or main sources any more — every owner-visible string is a key in src/renderer/i18n.js. Fails on:
//   1. a Vietnamese-diacritic literal in src/renderer/**/*.{js,html} or src/main/*.js, except i18n.js, comment lines,
//      the Vietnamese-DETECTION regexes, and the test-only selftest scripts (explicit allowlist with reasons below);
//   2. en / vi / zh tables that do not carry exactly the same key set;
//   3. a default locale other than English.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCALES, DEFAULT_LOCALE, TABLES, getLocale, t } from '../src/renderer/i18n.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const I18N = 'src/renderer/i18n.js';
let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); } };

// Vietnamese diacritics, same class the app's own language detectors use.
const VI = /[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]/i;

// ---------- 1. no Vietnamese literals in the shipped sources ----------
// Whole-file allowances (with a reason) ...
const ALLOW_FILE = [
  { file: 'src/main/reflex-rules.js', reason: 'T-31 QC-cuoi fix b: EN/VI keyword-DETECTION regexes for the local reflex fallback (matched against what the owner typed), never rendered as app UI' },
  { file: 'src/main/role-triggers.js', reason: 'T-31 zumi-roles: EN/VI keyword-DETECTION regexes that decide when Plan / Check / Look up join a chat turn (matched against what the owner typed), never rendered as app UI' },
  { file: 'src/main/providers.js', reason: 'T-31 BYOK: the provider table carries the in-app "get your key" guide steps in EN/VI/ZH (owner decision 16-10) plus vendor labels, next to the base URLs it must stay in sync with; user-facing by design, shown by the Settings provider card' },
];
// ... whole-directory allowances ...
const ALLOW_PREFIX = [
  { prefix: 'src/renderer/selftest/', reason: 'test-only scripts (fixtures + assertions), never user-visible in the shipped app' },
];
// ... and single-line allowances.
const ALLOW_LINE = [
  { file: 'src/renderer/talk/validate.js', match: /VI_MARKS\s*=/, reason: 'Vietnamese-detection regex for the model analysis gate, not displayed text' },
  { file: 'src/renderer/talk/ownertext.js', match: /VI_MARKS\s*=/, reason: 'Vietnamese-detection regex for the owner-text audit' },
  { file: 'src/renderer/talk/ownertext.js', match: /mẫu/, reason: 'the "C mẫu" shorthand detection rule regex, not displayed text' },
  { file: 'src/renderer/talk/ownertext.js', match: /Rảnh > 60 giây/, reason: 'inline example comment on the markup rule' },
  { file: 'src/main/local-tts.js', match: /European word inside an English reply/, reason: 'comment documenting the café trade-off of the Vietnamese-accent detector' },
  { file: 'src/main/chat-brain.js', match: /Trả lời câu hỏi về task/, reason: 'bilingual LLM system-prompt instruction (BOARD_RULE, T-31 board-aware) sent to the model, never rendered as app UI' },
  { file: 'src/main/chat-brain.js', match: /là chưa có thông tin/, reason: 'continuation of the same BOARD_RULE string literal above' },
  { file: 'src/main/main.js', match: /khách hàng/, reason: 'the VI redaction mask token sent into the LLM board digest (CoS privacy decision 07-10), never rendered as app UI' },
  { file: 'src/main/chat-brain.js', match: /^\s*\['(greet|celebrate|disagree|agree)', \/|^const BOARD_WORDS = /, reason: 'T-31 QC-cuoi fix a: EN/VI DETECTION regexes that pick a speech intent from the reply text (fallback when the model omits its gesture tag), never rendered as app UI' },
  { file: 'src/main/leda-tts.js', match: /Ây Ai/, reason: 'T-31 voice P1 item 3: "AI" -> "Ây Ai" pronunciation substitution inside the VI TTS audio text, never rendered as app UI' },
];

const isComment = (line) => /^\s*(\/\/|\/\*|\*|<!--)/.test(line);
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

function walk(dir, exts, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, exts, out);
    else if (exts.includes(path.extname(e.name))) out.push(p);
  }
  return out;
}

const files = [
  ...walk(path.join(ROOT, 'src', 'renderer'), ['.js', '.html']),
  ...fs.readdirSync(path.join(ROOT, 'src', 'main')).filter((f) => f.endsWith('.js')).map((f) => path.join(ROOT, 'src', 'main', f)),
].filter((f) => rel(f) !== I18N);

let scanned = 0;
for (const file of files) {
  scanned++;
  const relFile = rel(file);
  if (ALLOW_FILE.some((a) => a.file === relFile)) continue;
  if (ALLOW_PREFIX.some((a) => relFile.startsWith(a.prefix))) continue;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    if (!VI.test(line)) return;
    if (isComment(line)) return;
    if (ALLOW_LINE.some((a) => a.file === relFile && a.match.test(line))) return;
    fail++;
    console.log(`FAIL ${relFile}:${i + 1} Vietnamese literal outside i18n.js: ${line.trim().slice(0, 160)}`);
  });
}
ok(fail === 0, `no Vietnamese literals in ${scanned} shipped renderer/main files (outside i18n.js + allowlist)`);
console.log(`  allowlist: file=${ALLOW_FILE.length}, prefix=${ALLOW_PREFIX.length}, line=${ALLOW_LINE.length}`);
for (const a of ALLOW_FILE) console.log(`    file   ${a.file} — ${a.reason}`);
for (const a of ALLOW_PREFIX) console.log(`    prefix ${a.prefix} — ${a.reason}`);
for (const a of ALLOW_LINE) console.log(`    line   ${a.file} ${a.match} — ${a.reason}`);

// ---------- 2. the three tables carry identical key sets ----------
ok(LOCALES.length === 3 && LOCALES.includes('en') && LOCALES.includes('vi') && LOCALES.includes('zh'), 'locales: en / vi / zh are all present', LOCALES.join());
const enKeys = Object.keys(TABLES.en).sort();
ok(enKeys.length > 0, `tables: the English table is not empty (${enKeys.length} keys)`);
for (const l of LOCALES) {
  const keys = Object.keys(TABLES[l] || {}).sort();
  const missing = enKeys.filter((k) => !(k in TABLES[l]));
  const extra = keys.filter((k) => !(k in TABLES.en));
  ok(missing.length === 0 && extra.length === 0, `tables: ${l} has exactly the English key set`, `missing=[${missing.join(',')}] extra=[${extra.join(',')}]`);
}

// ---------- 3. English is the default, and every key resolves in every locale ----------
ok(DEFAULT_LOCALE === 'en' && getLocale() === 'en', `default locale is English (DEFAULT_LOCALE=${DEFAULT_LOCALE}, active=${getLocale()})`);
for (const l of LOCALES) for (const k of enKeys) {
  const v = TABLES[l][k];
  if (typeof v !== 'string' || !v.trim()) { fail++; console.log(`FAIL ${l}.${k} is empty or not a string`); }
}
ok(true, 'tables: no empty values');
ok(t('nav.zumi') === 'Zumi', 't(): resolves a known key in the default locale', t('nav.zumi'));
ok(t('nope.missing') === 'nope.missing', 't(): a missing key returns the key, never blank', t('nope.missing'));

// ---------- 4. every built-in reflex chip label (gesture.<trigger>.trigger / .<variantId>) has an i18n key ----------
// The chip text for a built-in reflex (engine.js's trigger()) is composed from these two keys per trigger/variant,
// not from the gestures/*.json "labelVi" fields (English despite the name, see entrance.json) -- so a trigger or
// variant added to the data without a matching i18n key would silently fall back to the raw key string on screen.
const GESTURES_DIR = path.join(ROOT, 'src/renderer/reflex/gestures');
const gestureIndex = JSON.parse(fs.readFileSync(path.join(GESTURES_DIR, 'index.json'), 'utf8'));
let chipKeysChecked = 0;
for (const trig of gestureIndex.triggers) {
  const def = JSON.parse(fs.readFileSync(path.join(GESTURES_DIR, `${trig}.json`), 'utf8'));
  const triggerKey = `gesture.${trig}.trigger`;
  chipKeysChecked++;
  ok(triggerKey in TABLES.en, `chip key: ${triggerKey}`);
  for (const v of def.variants || []) {
    const variantKey = `gesture.${trig}.${v.id}`;
    chipKeysChecked++;
    ok(variantKey in TABLES.en, `chip key: ${variantKey}`);
  }
}
console.log(`  chip keys checked: ${chipKeysChecked} (${gestureIndex.triggers.length} triggers)`);

console.log(`\ncheck:ui-lang ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
