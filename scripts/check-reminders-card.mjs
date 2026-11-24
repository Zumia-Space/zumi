// check:reminders-card (R6c B): the Reminders card shows the real schedule kind (not "Once" for everything), shows "Missed N" from
// routines.history, and its form can create monthly, yearly and interval reminders. Plain Node, no DOM, no host.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scheduleLabel, rowText, historyText, formFor } from '../src/renderer/reminders-model.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
const ok = (cond, name, extra = '') => { if (cond) pass += 1; else { fail += 1; console.log(`FAIL ${name}${extra ? ` ${extra}` : ''}`); } };
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

// A translator that shows the key and the numbers, so the test pins which words are asked for and with what.
const t = (k, p) => (p ? `${k}${JSON.stringify(p)}` : k);

// ---- the label is the real kind ----
eq(scheduleLabel({ repeat: 'none' }, t), 'reminders.repeatNone', 'once');
eq(scheduleLabel({ repeat: 'daily' }, t), 'reminders.repeatDaily', 'daily');
eq(scheduleLabel({ repeat: 'monthly', day: 5 }, t), 'reminders.monthlyOn{"day":5}', 'monthly on a day');
eq(scheduleLabel({ repeat: 'monthly', day: 'last' }, t), 'reminders.monthlyLast', 'monthly on the last day');
eq(scheduleLabel({ repeat: 'yearly', month: 3, day: 5 }, t), 'reminders.yearlyOn{"day":5,"month":3}', 'yearly');
eq(scheduleLabel({ repeat: 'interval', everyMin: 30 }, t), 'reminders.everyMin{"min":30}', 'interval');
eq(scheduleLabel({ repeat: 'interval', everyMin: 90, window: { start: '09:00', end: '18:00' }, weekdays: [1, 2, 3, 4, 5] }, t),
  'reminders.everyMin{"min":90} · reminders.window{"start":"09:00","end":"18:00"} · reminders.weekdays{"days":"reminders.wd.1, reminders.wd.2, reminders.wd.3, reminders.wd.4, reminders.wd.5"}', 'interval with a window and weekdays (Sunday is 0)');
ok(!['monthly', 'yearly', 'interval'].some((r) => scheduleLabel({ repeat: r, day: 1, month: 1, everyMin: 5 }, t).includes('repeatNone')), 'a repeating kind is never labelled Once');
const unknown = scheduleLabel({ repeat: 'weekly-from-the-future' }, t);
ok(unknown !== 'reminders.repeatNone' && unknown !== '', 'an unknown kind is shown as itself, not as Once');
eq(rowText({ time: '07:00', repeat: 'monthly', day: 5, done: false, text: 'pay rent' }, t), '07:00 · reminders.monthlyOn{"day":5} — pay rent', 'a row');
eq(rowText({ time: '07:00', repeat: 'none', done: true, text: 'x' }, t), '07:00 · reminders.repeatNone · reminders.done — x', 'a finished one-shot');

// ---- history: Missed N ----
eq(historyText({ status: 'missed', missed: 3, text: 'stretch' }, t), 'reminders.hist.missed{"n":3} — stretch', 'Missed 3');
eq(historyText({ status: 'missed', missed: 1, text: 'stretch' }, t), 'reminders.hist.missed{"n":1} — stretch', 'Missed 1');
eq(historyText({ status: 'fired', missed: 0, text: 'stretch' }, t), 'reminders.hist.fired — stretch', 'fired');
eq(historyText({ status: 'refused', missed: 0, text: 'stretch' }, t), 'reminders.hist.refused — stretch', 'refused');

// ---- the form creates every kind the host accepts ----
const base = { text: 'water', time: '10:00' };
eq(formFor({ ...base, repeat: 'none' }), { form: { text: 'water', time: '10:00', repeat: 'none' } }, 'form: once');
eq(formFor({ ...base, repeat: 'daily' }), { form: { text: 'water', time: '10:00', repeat: 'daily' } }, 'form: daily');
eq(formFor({ ...base, repeat: 'monthly', day: '5' }), { form: { text: 'water', time: '10:00', repeat: 'monthly', day: 5 } }, 'form: monthly');
eq(formFor({ ...base, repeat: 'monthly', day: 'last' }), { form: { text: 'water', time: '10:00', repeat: 'monthly', day: 'last' } }, 'form: monthly last day');
eq(formFor({ ...base, repeat: 'yearly', month: '3', day: '5' }), { form: { text: 'water', time: '10:00', repeat: 'yearly', month: 3, day: 5 } }, 'form: yearly');
eq(formFor({ ...base, repeat: 'interval', everyMin: '30' }), { form: { text: 'water', time: '10:00', repeat: 'interval', everyMin: 30 } }, 'form: interval');
eq(formFor({ ...base, repeat: 'interval', everyMin: '30', windowStart: '09:00', windowEnd: '18:00', weekdays: ['1', '2'] }),
  { form: { text: 'water', time: '10:00', repeat: 'interval', everyMin: 30, window: { start: '09:00', end: '18:00' }, weekdays: [1, 2] } }, 'form: interval with window and weekdays');
eq(formFor({ ...base, repeat: 'daily', day: '5', everyMin: '30' }), { form: { text: 'water', time: '10:00', repeat: 'daily' } }, 'fields of another kind are not sent');
for (const [bad, inputs] of [['monthly without a day', { repeat: 'monthly' }], ['monthly day not a number', { repeat: 'monthly', day: 'x' }], ['yearly without a month', { repeat: 'yearly', day: '5' }], ['interval without minutes', { repeat: 'interval' }], ['interval minutes not a number', { repeat: 'interval', everyMin: 'soon' }], ['a kind that is not one', { repeat: 'weekly' }]]) {
  const r = formFor({ ...base, ...inputs });
  ok(r.error === 'bad_rule' || r.error === 'bad_repeat', `form: ${bad} is an error, not a different schedule`, JSON.stringify(r));
}

// ---- the card wires it, the words exist in three languages ----
const card = readFileSync(join(root, 'src/renderer/reminders-card.js'), 'utf8');
for (const kind of ['monthly', 'yearly', 'interval']) ok(card.includes(`value="${kind}"`), `the repeat list offers ${kind}`);
ok(card.includes('history(') && card.includes('historyText'), 'the card reads routines.history and words it');
ok(card.includes('rowText') && !card.includes("it.repeat === 'daily' ?"), 'a row is worded by the model, not by a daily-or-once guess');
const { TABLES } = await import('../src/renderer/i18n.js');
const KEYS = ['reminders.monthlyOn', 'reminders.monthlyLast', 'reminders.yearlyOn', 'reminders.everyMin', 'reminders.window', 'reminders.weekdays', 'reminders.hist.title', 'reminders.hist.fired', 'reminders.hist.missed', 'reminders.hist.refused', 'reminders.repeatMonthly', 'reminders.repeatYearly', 'reminders.repeatInterval', 'reminders.day', 'reminders.month', 'reminders.everyMinLabel', 'reminders.dayLast', 'reminders.err.bad_rule', ...[0, 1, 2, 3, 4, 5, 6].map((d) => `reminders.wd.${d}`)];
for (const lang of ['en', 'vi', 'zh']) for (const k of KEYS) ok(typeof TABLES[lang][k] === 'string' && TABLES[lang][k].length > 0, `${lang}: ${k}`);
ok(/\{n\}/.test(TABLES.en['reminders.hist.missed'] || ''), 'the Missed words carry the number');

console.log(`${fail ? 'FAIL' : 'PASS'} check-reminders-card — ${pass}/${pass + fail} assertions passed`);
process.exit(fail ? 1 : 0);
