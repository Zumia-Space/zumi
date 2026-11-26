// Reminders card, the logic that has no DOM (T-31-MAUS R6c B): how a schedule is worded, how a history row is worded, and how the form
// becomes a `routines.add` argument. The Rust routines crate is the one reader of schedules; nothing here computes a next fire.
// `t` is the card's translator: t(key, params).

/** A schedule in words: Once, Every day, Monthly on day 5 / the last day, Yearly on 5 March, Every 30 min (09:00-18:00, Mon-Fri). */
export function scheduleLabel(item, t) {
  const it = item || {};
  switch (it.repeat) {
    case 'none': return t('reminders.repeatNone');
    case 'daily': return t('reminders.repeatDaily');
    case 'monthly': return it.day === 'last' ? t('reminders.monthlyLast') : t('reminders.monthlyOn', { day: it.day });
    case 'yearly': return t('reminders.yearlyOn', { day: it.day, month: it.month });
    case 'interval': {
      const parts = [t('reminders.everyMin', { min: it.everyMin })];
      if (it.window) parts.push(t('reminders.window', { start: it.window.start, end: it.window.end }));
      if (Array.isArray(it.weekdays) && it.weekdays.length) parts.push(t('reminders.weekdays', { days: it.weekdays.map((d) => t(`reminders.wd.${d}`)).join(', ') }));
      return parts.join(' · ');
    }
    // A kind this card does not know is shown as itself, never as "Once".
    default: return String(it.repeat || '?');
  }
}

/** One list row: `07:00 · Monthly on day 5 · done — text`. */
export function rowText(item, t) {
  const it = item || {};
  return `${it.time} · ${scheduleLabel(it, t)}${it.done ? ` · ${t('reminders.done')}` : ''} — ${it.text}`;
}

/** One history row from `routines.history`: Fired, Missed N, Refused. */
export function historyText(h, t) {
  const row = h || {};
  const what = row.status === 'missed' ? t('reminders.hist.missed', { n: row.missed }) : row.status === 'refused' ? t('reminders.hist.refused') : t('reminders.hist.fired');
  return `${what} — ${row.text}`;
}

const int = (v) => (typeof v === 'string' ? (/^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN) : Number(v));

/**
 * The inputs of the form as `routines.add` wants them, or `{ error }` with the card's own error code. Only the fields of the chosen
 * kind are sent: the host refuses a form that carries another kind's field, so a form is never quietly read as a different schedule.
 * inputs: { text, time, repeat, day, month, everyMin, windowStart, windowEnd, weekdays }
 */
export function formFor(inputs) {
  const i = inputs || {};
  const form = { text: i.text, time: i.time, repeat: i.repeat };
  switch (i.repeat) {
    case 'none':
    case 'daily':
      return { form };
    case 'monthly': {
      if (i.day === 'last') return { form: { ...form, day: 'last' } };
      const day = int(i.day);
      return Number.isInteger(day) ? { form: { ...form, day } } : { error: 'bad_rule' };
    }
    case 'yearly': {
      const [month, day] = [int(i.month), int(i.day)];
      return Number.isInteger(month) && Number.isInteger(day) ? { form: { ...form, month, day } } : { error: 'bad_rule' };
    }
    case 'interval': {
      const everyMin = int(i.everyMin);
      if (!Number.isInteger(everyMin)) return { error: 'bad_rule' };
      const out = { ...form, everyMin };
      if (i.windowStart || i.windowEnd) {
        if (!i.windowStart || !i.windowEnd) return { error: 'bad_rule' };
        out.window = { start: i.windowStart, end: i.windowEnd };
      }
      if (Array.isArray(i.weekdays) && i.weekdays.length) {
        const days = i.weekdays.map(int);
        if (days.some((d) => !Number.isInteger(d))) return { error: 'bad_rule' };
        out.weekdays = days;
      }
      return { form: out };
    }
    default:
      return { error: 'bad_repeat' };
  }
}
