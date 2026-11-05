// Settings > "Usage" (T-31 owner-admin + usage, Fable ruling 05-10; layout: Settings design A2). Read-only: a
// compact summary (Today / Last 7 days / Last 30 days x calls, tokens, estimated USD cost) and a "Details" expander
// with the day x model table, inside the same 520px card, plus a refresh button. Mirrors settings.js/room-settings.js's
// shape (one init function, owns its own DOM + i18n). Model ids never reach the screen: `modelName` turns one into
// the provider's own model name (role-models.js), falling back to a readable name derived from the id.
import { t, onLocaleChange } from './i18n.js';
import { nameFromId } from './role-models.js';

const ROLE_KINDS = ['plan', 'check', 'lookup'];

export function initUsage(zumi, $, { modelName = nameFromId } = {}) {
  const el = {
    refresh: $('usage-refresh'), summary: $('usage-summary-body'), partial: $('usage-partial'), tbody: $('usage-tbody'), empty: $('usage-empty'),
    toggle: $('usage-details-toggle'), toggleLabel: $('usage-details-label'), detail: $('usage-detail'),
  };
  if (!el.tbody) return; // defensive: this card may be absent in a stripped-down shell (e.g. a shots build)
  let last = { today: null, rows: [] };
  let open = false;

  const fmtInt = (n) => Math.round(Number(n) || 0).toLocaleString();
  const fmtUsd = (usd) => `$${Number(usd).toFixed(4)}`;
  const fmtCost = (row) => (row.priced ? fmtUsd(row.estCostUsd) : t('usage.costNa'));
  // 152000 -> "152k", 9100 -> "9.1k", 528 -> "528": the detail table's In / Out column has to fit the 520px card.
  const fmtK = (n) => { const x = Math.round(Number(n) || 0); return x >= 1000 ? `${(x / 1000).toFixed(x >= 100000 ? 0 : 1)}k` : String(x); };
  const cell = (text, cls) => { const td = document.createElement('td'); if (cls) td.className = cls; td.textContent = text; return td; };

  // "YYYY-MM-DD" (the owner's local calendar date, usage-ledger.js) minus n days, as the same kind of string.
  function dayMinus(dateStr, n) {
    const [y, m, d] = String(dateStr).split('-').map(Number);
    const dt = new Date(y, m - 1, d - n);
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  }

  function paintSummary() {
    el.summary.innerHTML = '';
    const periods = [['usage.today', 0], ['usage.last7', 6], ['usage.last30', 29]];
    let anyPartial = false;
    for (const [key, back] of periods) {
      const from = last.today ? dayMinus(last.today, back) : null;
      const rows = from ? last.rows.filter((r) => r.date >= from && r.date <= last.today) : [];
      // estCostUsd of an unpriced row is only its web-search fee (0 for a non-lookup row), never a guessed token price.
      const sum = rows.reduce((a, r) => ({ calls: a.calls + r.calls, tokens: a.tokens + r.total, cost: a.cost + (Number(r.estCostUsd) || 0) }), { calls: 0, tokens: 0, cost: 0 });
      // One unpriced row makes the total a floor, never a silent undercount (review of b4d6d75: 31% low): "≥ $X".
      const partial = rows.some((r) => !r.priced);
      anyPartial = anyPartial || partial;
      const costCell = cell(partial ? `≥ ${fmtUsd(sum.cost)}` : fmtUsd(sum.cost), 'num');
      if (partial) costCell.title = t('usage.costPartial');
      const tr = document.createElement('tr');
      tr.append(cell(t(key)), cell(fmtInt(sum.calls), 'num'), cell(fmtInt(sum.tokens), 'num'), costCell);
      el.summary.appendChild(tr);
    }
    if (el.partial) { el.partial.textContent = t('usage.costPartial'); el.partial.hidden = !anyPartial; }
  }

  // Newest day first (aggregateUsage's order); the date shows once per day. A model with no price estimate (no public
  // per-token price, see usage-cost.js) is dimmed: it adds nothing to the cost column. A Plan / Check / Look up row
  // names its role after the model ("Gemini 3.7 Pro · Check"); the chat reply (Do) and Jev rows show the model only.
  function paintDetail() {
    el.tbody.innerHTML = '';
    let prevDate = null;
    for (const r of last.rows) {
      const tr = document.createElement('tr');
      const first = r.date !== prevDate;
      prevDate = r.date;
      const dim = r.priced ? '' : ' dim';
      const name = ROLE_KINDS.includes(r.kind) ? `${modelName(r.model)} · ${t(`roles.${r.kind}`)}` : modelName(r.model);
      const modelCell = cell(name, `model-cell${dim}`);
      modelCell.title = name;
      tr.append(cell(first ? r.date.slice(5) : ''), modelCell, cell(fmtInt(r.calls), `num${dim}`), cell(`${fmtK(r.in)} / ${fmtK(r.out)}`, `num${dim}`), cell(fmtCost(r), `num${dim}`));
      el.tbody.appendChild(tr);
    }
    if (el.empty) el.empty.hidden = last.rows.length > 0;
  }

  function paintToggle() {
    if (!el.toggle) return;
    el.toggle.setAttribute('aria-expanded', String(open));
    if (el.toggleLabel) el.toggleLabel.textContent = t(open ? 'usage.hideDetails' : 'usage.details');
    if (el.detail) el.detail.hidden = !open;
  }

  function paint() { paintSummary(); paintDetail(); paintToggle(); }

  async function refresh() {
    try { last = await zumi.usage.summary(); } catch { last = { today: null, rows: [] }; }
    if (!last || !Array.isArray(last.rows)) last = { today: last && last.today, rows: [] };
    paint();
  }

  if (el.refresh) el.refresh.addEventListener('click', refresh);
  if (el.toggle) el.toggle.addEventListener('click', () => { open = !open; paintToggle(); });
  // Period names, "n/a" costs and the Details label are words; the provider's model names can arrive after the
  // first paint (role-models.js loads the list), so both repaint the tables.
  onLocaleChange(paint);
  document.addEventListener('zumi:model-names', paintDetail);

  return refresh();
}
