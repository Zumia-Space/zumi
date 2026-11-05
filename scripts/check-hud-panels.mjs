// Panel gates (T-31 hud-panels, PLAN sections 3 and 6): the pure modules the new T1 / T2 / T3 panels stand on, plain
// Node, no DOM, no Electron, no clock of its own. Fails on a wrong default, a cut inside a word, a wrong day bucket, a
// wrong ring segment count or a preference that survives a broken store. One line per gate; exit 1 on any failure.
//   node scripts/check-hud-panels.mjs
import { PANEL_DESIGNS, PANEL_PLACES, DEFAULT_PANEL, PANEL_PREF_KEY, resolvePanel, readPanelPrefs, savePanelPrefs } from '../src/renderer/hud/panel-prefs.js';
import { focusTask, isWorkingOn, stepCounts, stepPercent, wordFit, stripNowStamp, logTail, doneByDay, ringPaths } from '../src/renderer/hud/panel-logic.js';
import { TABLES } from '../src/renderer/i18n.js';
import { readFileSync } from 'node:fs';
import { WORK_IDLE_MS } from '../src/renderer/hud/work-signal.js';

let pass = 0, fail = 0;
const ok = (cond, name, detail) => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`); } };

// ---------- panel prefs ----------
{
  ok(JSON.stringify(PANEL_DESIGNS) === '["none","t1","t2","t3"]' && JSON.stringify(PANEL_PLACES) === '["inplace","below-left","below-right"]',
    'prefs: the three designs (plus none) and the three places, in the plan\'s order', { PANEL_DESIGNS, PANEL_PLACES });
  ok(DEFAULT_PANEL.design === 't1' && DEFAULT_PANEL.place === 'inplace',
    'prefs: the default is T1, in place (Pi decision, PLAN section 10)', DEFAULT_PANEL);
  ok(PANEL_PREF_KEY === 'zumi.hud.panel', 'prefs: the localStorage key is the one the plan/Tauri note names', PANEL_PREF_KEY);

  const def = resolvePanel(null);
  ok(def.design === 't1' && def.place === 'inplace' && def !== DEFAULT_PANEL,
    'prefs: nothing stored -> the default, as a copy (a caller can never mutate the shipped default)', def);
  ok(resolvePanel({ design: 't3', place: 'inplace' }).design === 't3' && resolvePanel({ design: 't3', place: 'inplace' }).place === 'inplace',
    'prefs: a valid pair is kept');
  ok(resolvePanel({ design: 't3', place: 'below-right' }).design === 't3' && resolvePanel({ design: 't3', place: 'below-right' }).place === 'inplace'
    && resolvePanel({ design: 't2', place: 'below-left' }).place === 'inplace',
    'prefs: a saved below-left/below-right (not offered since the 0.2.8 review) migrates to in place, the design is kept');
  ok(resolvePanel({ design: 't9', place: 'above' }).design === 't1' && resolvePanel({ design: 't9', place: 'above' }).place === 'inplace',
    'prefs: an unknown design AND an unknown place both fall back to the default');
  ok(resolvePanel({ design: 'none', place: 'below-left' }).design === 'none' && resolvePanel({ design: 'none' }).place === 'inplace',
    'prefs: none is a real choice (the panel hides), missing halves fall back one by one');
  ok(resolvePanel('t2').design === 't1' && resolvePanel({ design: '__proto__' }).design === 't1',
    'prefs: a non-object or a prototype key is not a valid design');

  const store = (initial) => { const map = new Map(Object.entries(initial || {})); return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, v), map }; };
  const s1 = store({ [PANEL_PREF_KEY]: JSON.stringify({ design: 't2', place: 'below-left' }) });
  const read1 = readPanelPrefs(s1);
  ok(read1.design === 't2' && read1.place === 'inplace', 'prefs: a stored below value is read back as in place', read1);

  let threw = false;
  let bad;
  try { bad = readPanelPrefs(store({ [PANEL_PREF_KEY]: '{not json' })); } catch { threw = true; }
  ok(!threw && bad.design === 't1' && bad.place === 'inplace', 'prefs: bad JSON does not throw and gives the default', bad);

  ok(readPanelPrefs(null).design === 't1' && readPanelPrefs(undefined).design === 't1', 'prefs: a disabled (null/undefined) storage gives the default');
  let threw2 = false;
  let broken;
  try { broken = readPanelPrefs({ getItem: () => { throw new Error('denied'); } }); } catch { threw2 = true; }
  ok(!threw2 && broken.design === 't1', 'prefs: a storage that throws on read gives the default', broken);

  const s2 = store();
  const saved = savePanelPrefs({ design: 't3', place: 'below-right' }, s2);
  const raw = JSON.parse(s2.map.get(PANEL_PREF_KEY));
  ok(saved.design === 't3' && raw.design === 't3' && raw.place === 'inplace' && Object.keys(raw).length === 2,
    'prefs: save writes only the two ids and returns what the next launch will read', raw);
  const s3 = store();
  savePanelPrefs({ design: 'bogus', place: 'inplace' }, s3);
  ok(JSON.parse(s3.map.get(PANEL_PREF_KEY)).design === 't1', 'prefs: saving an invalid value stores the resolved default, never the bad one', JSON.parse(s3.map.get(PANEL_PREF_KEY)));
  let threw3 = false;
  try { savePanelPrefs({ design: 't2', place: 'inplace' }, { setItem: () => { throw new Error('quota'); } }); } catch { threw3 = true; }
  ok(!threw3, 'prefs: a storage that throws on write just does not remember (no crash)');
}

// ---------- wordFit ----------
{
  const count = (n) => (s) => s.length <= n;
  const endsOf = (text, locale = 'en') => {
    const ends = [];
    for (const s of new Intl.Segmenter(locale, { granularity: 'word' }).segment(text)) if (s.isWordLike) ends.push(s.index + s.segment.length);
    return ends;
  };
  /** A whole-word cut: the result is the whole text, or `…` alone, or a source prefix ending exactly on a segment edge. */
  const wholeWord = (src, out, locale = 'en') => {
    if (out === src) return true;
    if (out === '…') return true;
    if (!out.endsWith('…')) return false;
    const cut = out.slice(0, -1);
    return cut.length > 0 && endsOf(src, locale).includes(cut.length) && src.slice(0, cut.length) === cut;
  };

  const en = 'Wiring the panels into the left group, then the settings row';
  ok(wordFit(en, () => true) === en, 'wordFit: text that fits is returned whole (no ellipsis)', wordFit(en, () => true));
  ok(wordFit('', () => true) === '' && wordFit(null, () => true) === '', 'wordFit: empty / null text gives an empty string');

  const enOut = wordFit(en, count(18));
  ok(wholeWord(en, enOut) && enOut.length <= 19 && enOut.length > 1, 'wordFit (en): the cut lands on a word boundary and fits with the ellipsis', enOut);
  let allWhole = true;
  const samples = [];
  for (let n = 2; n <= en.length + 3; n++) { const out = wordFit(en, count(n)); samples.push(out); if (!wholeWord(en, out) || out.length > n + 1) allWhole = false; }
  ok(allWhole, 'wordFit (en): every width from 2..n cuts on a whole word and fits', samples.filter((s) => s.endsWith('…')).slice(0, 4));

  const vi = 'Bảng task mở rộng tại chỗ khi Zumi đang làm việc trên bước đó';
  const viOut = wordFit(vi, count(24), 'vi');
  ok(wholeWord(vi, viOut, 'vi') && viOut.length <= 25, 'wordFit (vi, diacritics): a whole word, never a split syllable', viOut);

  const zh = '现在正在把面板放进左侧那一组里面';
  const zhOut = wordFit(zh, count(8), 'zh');
  ok(wholeWord(zh, zhOut, 'zh') && zhOut !== '…', 'wordFit (zh): cut on a real segmenter boundary, never inside a character', zhOut);
  ok([...zhOut].length <= 9, 'wordFit (zh): counts characters, not UTF-16 units', [...zhOut].length);

  ok(wordFit('Supercalifragilisticexpialidocious', count(6)) === '…',
    'wordFit: one over-long word becomes the ellipsis only (no half word)', wordFit('Supercalifragilisticexpialidocious', count(6)));
  ok(wordFit('a bb', count(1)) === '…', 'wordFit: no prefix fits -> the ellipsis only', wordFit('a bb', count(1)));

  const Original = Intl.Segmenter;
  let fallback = null;
  try {
    Intl.Segmenter = undefined;
    fallback = wordFit(en, count(18));
  } finally { Intl.Segmenter = Original; }
  ok(fallback === enOut || wholeWord(en, fallback), 'wordFit: without Intl.Segmenter it falls back to space boundaries', fallback);
}

// ---------- stripNowStamp + stepPercent ----------
{
  ok(stripNowStamp('22-10 15:55: bản Tauri đã lưu khoá') === 'bản Tauri đã lưu khoá', 'stripNowStamp: the board stamp is removed', stripNowStamp('22-10 15:55: x'));
  ok(stripNowStamp('22-10 15:55:') === '' && stripNowStamp('1-2 3:04:y') === 'y', 'stripNowStamp: the stamp alone leaves an empty line; a bare time is kept');
  ok(stripNowStamp('no stamp here') === 'no stamp here' && stripNowStamp(null) === '' && stripNowStamp('23-10: not a time') === '23-10: not a time',
    'stripNowStamp: anything that is not a stamp is untouched (a lone date is not a stamp)');

  ok(stepPercent('bước 6 AI + chat gần xong (50,4%)') === 50.4, 'stepPercent: the board\'s decimal-comma hint is read', stepPercent('(50,4%)'));
  ok(stepPercent('half (75%)') === 75 && stepPercent('(8.5 %)') === 8.5, 'stepPercent: a whole percent and a decimal point both read');
  ok(stepPercent('no number here') === null && stepPercent('') === null && stepPercent(null) === null,
    'stepPercent: no hint -> null (the panel shows the scan bar + "in progress", never an invented number)');
}

// ---------- focusTask ----------
{
  const up = (id, stepState, at = '2026-10-23T09:00:00.000Z') => ({ id, stepState, at });
  const list = [up('A-1', 'todo'), up('B-2', 'waiting'), up('C-3', 'active')];
  ok(focusTask(list, 'A-1').id === 'A-1', 'focusTask: the last primary task wins, even when it is not first or active');
  ok(focusTask(list, 'ZZ').id === 'C-3', 'focusTask: an unknown primary -> the first active task');
  ok(focusTask([up('A-1', 'todo'), up('B-2', 'blocked')], null).id === 'A-1', 'focusTask: no active task -> the first update');
  ok(focusTask([], 'A-1') === null && focusTask(null, null) === null && focusTask(undefined) === null,
    'focusTask: no updates -> null (the panel hides)');
}

// ---------- isWorkingOn ----------
{
  const at = '2026-10-23T09:00:00.000Z';
  const t0 = Date.parse(at);
  const task = { id: 'T-31', stepState: 'active', at };
  const none = new Set();
  ok(isWorkingOn(task, t0, none) === true, 'isWorkingOn: an active step, just now -> working');
  ok(isWorkingOn(task, t0 + WORK_IDLE_MS, none) === true, 'isWorkingOn: still working through the whole 10th minute (<=)', { idle: WORK_IDLE_MS });
  ok(isWorkingOn(task, t0 + WORK_IDLE_MS + 1, none) === false, 'isWorkingOn: silent past 10 min -> not working');
  ok(isWorkingOn({ id: 'T-31', stepState: 'todo', at }, t0, none) === false, 'isWorkingOn: a non-active step is not working');
  ok(isWorkingOn({ id: 'T-31', stepState: 'active', at: 'nonsense' }, t0, none) === false, 'isWorkingOn: an unparseable activity time never counts');
  ok(isWorkingOn({ id: 'T-31', stepState: 'todo', at: '2020-01-01T00:00:00.000Z' }, t0, new Set(['T-31'])) === true,
    'isWorkingOn: the 8 s reaction window (hotIds) makes even an old, non-active task "being worked on"');
  ok(isWorkingOn(null, t0, none) === false, 'isWorkingOn: no task -> false');
}

// ---------- stepCounts ----------
{
  const c = stepCounts([{ state: 'done' }, { state: 'done' }, { state: 'active' }, { state: 'todo' }, { state: 'waiting' }, { state: 'blocked' }, { state: 'mystery' }, null]);
  ok(c.done === 2 && c.active === 1 && c.todo === 1 && c.waiting === 1 && c.blocked === 1 && c.total === 7,
    'stepCounts: one count per board state, an unknown state only counts in the total, a null row is skipped', c);
  const z = stepCounts(null);
  ok(z.done === 0 && z.total === 0, 'stepCounts: a missing list gives zeroes', z);
}

// ---------- logTail ----------
{
  const log = Array.from({ length: 10 }, (_, i) => ({ at: `t${i}` }));
  const tail = logTail(log, 6);
  ok(tail.length === 6 && tail[0].at === 't4' && tail[5].at === 't9', 'logTail: the LAST rows, oldest first, newest at the bottom (a static tail)', tail.map((x) => x.at));
  ok(logTail(log, 99).length === 10 && logTail(log, 0).length === 0 && logTail(null, 6).length === 0,
    'logTail: more rows than entries keeps all; 0 rows keeps none; a missing log is empty');
}

// ---------- doneByDay ----------
{
  const days = (d) => Array.from({ length: d }, () => 0);
  ok(JSON.stringify(doneByDay([], Date.now())) === JSON.stringify(days(7)), 'doneByDay: no times -> 7 empty buckets');
  const now = new Date(2026, 9, 14, 0, 30).getTime(); // 00:30 local on 14-10
  const at = (y, m, d, h, mi) => new Date(y, m, d, h, mi).toISOString();
  const b = doneByDay([at(2026, 9, 13, 23, 50), at(2026, 9, 14, 0, 10), at(2026, 9, 14, 0, 20), at(2026, 9, 8, 12, 0), at(2026, 9, 7, 12, 0), at(2026, 9, 1, 12, 0)], now);
  ok(b.length === 7 && b[5] === 1 && b[6] === 2 && b[0] === 1,
    'doneByDay: 7 local-day buckets oldest first -- a 23:50 finish lands on yesterday after midnight, today\'s on today, the oldest bucket is 6 days back', b);
  ok(doneByDay([at(2026, 9, 7, 12, 0)], now).every((v) => v === 0), 'doneByDay: a finish 7 days back falls outside the window (never into today)');
  ok(JSON.stringify(doneByDay(['nonsense', null], now)) === JSON.stringify(days(7)), 'doneByDay: an unparseable time never invents a bar');
  ok(doneByDay([at(2026, 9, 14, 0, 10)], now, 3).length === 3, 'doneByDay: the window length is a parameter');
}

// ---------- ringPaths ----------
{
  const paths = ringPaths(30, 41, 8, 3.2);
  ok(paths.length === 30, 'ringPaths: one arc path per segment (the T1/T2 segmented ring)', paths.length);
  ok(paths.every((d) => typeof d === 'string' && d.startsWith('M') && / A41,41 0 0 1 /.test(d)),
    'ringPaths: every path is an arc of the given radius, drawn clockwise from 12 o\'clock', paths[0]);
  ok(ringPaths(12).length === 12 && ringPaths(4).length === 4 && ringPaths(0).length === 1,
    'ringPaths: the count follows n (0 is clamped to a single segment, never an empty/NaN path)');
}

// ---------- state column width (0.2.8 nit a) ----------
{
  const css = readFileSync(new URL('../src/renderer/hud/hud.css', import.meta.url), 'utf8');
  const rule = /\.hud-task-panel \.hp-ln \{[^}]*grid-template-columns:\s*var\(--at,\s*[\d.]+ch\)\s+var\(--tg,\s*([\d.]+)ch\)/.exec(css);
  const tg = rule ? Number(rule[1]) : 0;
  // the log is mono: a Latin letter is 1ch, a CJK glyph about 1.7ch
  const cells = (str) => [...str].reduce((n, ch) => n + (/[\u2e80-\u9fff]/.test(ch) ? 1.7 : 1), 0);
  const labels = Object.entries(TABLES).flatMap(([loc, tbl]) => ['active', 'waiting', 'blocked', 'todo', 'done'].map((k) => [loc, tbl[`hud.state.${k}`]]));
  const longest = Math.max(...labels.map(([, v]) => cells(String(v))));
  ok(labels.every(([, v]) => typeof v === 'string' && v) && longest >= 8, 'state column: the longest label is measured from the real EN/VI/ZH tables ("đang làm" = 8)', longest);
  ok(tg >= longest, 'state column: the log state column is at least as wide as the longest state label (no "wait…" / "đang…")', { tg, longest });
  ok(!/\.hp-strip \.hp-ln \{[^}]*grid-template-columns/.test(css), 'state column: the compact strip uses the same width, not a narrower override');
}

console.log(`\ncheck:hud-panels ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
