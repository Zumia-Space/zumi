// Memory list (T-31 slice 3b, SPEC-memory slice 1 without "+ Note"): what Zumi remembers on this computer, newest first, 50 per page, a
// Notes / Conversations filter, search, forget one, forget all (with a confirm), export marked "not encrypted", the on/off switch and the
// one-line privacy sentence. It exists only where the host offers `window.zumi.memory` (the Tauri build, M3); the Electron build never
// gets here and shows the SPEC card instead (memory-card.js), so nothing in this file runs there.
//
// Host API (PLAN-MEMORY section 4, renderer side): status() -> { enabled, count, reset? }, setEnabled(on), list({ search?, beforeId?, limit })
// -> items[] | { items[], more? }, delete(id), deleteAll(), exportFile() -> { ok, path } (the save dialog and the file name
// zumi-memory-<date>.json belong to the host). Inferred, to confirm at the Sol gate: the `kind` argument of list ('note' | 'turn') for the
// filter, the item fields { id, kind, text, createdAt }, and `more` (without it a full page means there may be another one).
// Searching (Vietnamese with or without diacritics) is the host's: the query is passed on as typed.
// Launch-scope memory (notes only): a host with add(text) -> { ok, item } | { ok:false, error } gets the "+ Note" composer;
// a host whose status says kinds: ['note'] stores no conversations, so the Notes / Conversations filter is hidden and the switch
// reads "Use my notes when chatting". A host without either keeps the slice 3b list exactly as before.
import { t, getLocale } from '../../i18n.js';
import { el, whenText } from './dom.js';

export const PAGE = 50;
const SEARCH_DELAY_MS = 200;
const KINDS = ['all', 'note', 'turn'];

/** True where the host has the memory API. Checked, never assumed: on Electron `window.zumi.memory` does not exist. */
export function memoryAvailable() {
  const m = typeof window !== 'undefined' && window.zumi && window.zumi.memory;
  return Boolean(m && typeof m.status === 'function' && typeof m.list === 'function');
}

/** The header's count: "1 memory", "{n} memories" (alpha.14 F5 read "1 memories"). */
export function memoryCountText(n) { return n === 1 ? t('brain.mem.countOne') : t('brain.mem.count', { n }); }

/** Fills `host`. `onCount(n)` tells the card header the count the host reports. */
export function renderMemoryList(host, { onCount = () => {} } = {}) {
  const mem = window.zumi.memory;
  const ui = { kind: 'all', query: '', items: [], more: false, enabled: true, count: 0, confirm: false, note: '', error: '', loaded: false, notesOnly: false, reset: false, unavailable: false };
  let seq = 0, timer = 0;
  host.textContent = '';

  const privacy = el('p', 'nb-mute nb-mem-privacy', t('brain.mem.privacy'));
  const sw = el('label', 'nb-switch');
  const swBox = el('input'); swBox.type = 'checkbox';
  const swText = el('span', null, t('brain.mem.enabled'));
  sw.append(swBox, swText);
  // "+ Note": only where the host can store one.
  const canAdd = typeof mem.add === 'function';
  const composer = el('div', 'nb-mem-add');
  const draft = el('textarea', 'nb-filter nb-mem-draft'); draft.rows = 2; draft.placeholder = t('brain.mem.addPlaceholder'); draft.setAttribute('aria-label', t('brain.mem.addPlaceholder'));
  const addBtn = el('button', 'nb-toggle', t('brain.mem.add')); addBtn.type = 'button'; addBtn.dataset.act = 'add';
  composer.append(draft, addBtn);
  composer.hidden = !canAdd;
  const bar = el('div', 'nb-bar');
  const search = el('input', 'nb-filter'); search.type = 'search'; search.placeholder = t('brain.mem.search'); search.setAttribute('aria-label', t('brain.mem.search'));
  const kinds = el('div', 'nb-kinds');
  const kindBtn = {};
  for (const k of KINDS) {
    const b = el('button', 'nb-toggle', t(`brain.mem.filter.${k}`)); b.type = 'button'; b.dataset.kind = k;
    b.addEventListener('click', () => { ui.kind = k; load(true); });
    kindBtn[k] = b; kinds.appendChild(b);
  }
  bar.append(search, kinds);
  const list = el('div', 'nb-list'); list.setAttribute('role', 'list');
  const more = el('button', 'nb-toggle nb-more', t('brain.mem.more')); more.type = 'button';
  more.addEventListener('click', () => load(false));
  const foot = el('div', 'nb-mem-foot');
  const exportBtn = el('button', 'nb-toggle', t('brain.mem.export')); exportBtn.type = 'button';
  const allBtn = el('button', 'nb-toggle danger', t('brain.mem.deleteAll')); allBtn.type = 'button';
  const confirmBox = el('div', 'nb-confirm'); confirmBox.hidden = true;
  const status = el('p', 'nb-mute nb-mem-status'); status.setAttribute('aria-live', 'polite');
  foot.append(exportBtn, allBtn);
  host.append(privacy, sw, composer, bar, list, more, foot, confirmBox, status);

  const arr = (v) => (Array.isArray(v) ? v : []);
  const fail = (e) => { ui.error = t('brain.mem.error', { error: (e && e.message) || String(e) }); paint(); };

  function paint() {
    swBox.checked = ui.enabled;
    swText.textContent = t(ui.notesOnly ? 'brain.mem.enabledNotes' : 'brain.mem.enabled');
    // A host whose Node cannot hold memory (status.unavailable): say so; nothing to switch, add or export.
    sw.hidden = ui.unavailable; foot.hidden = ui.unavailable; composer.hidden = !canAdd || ui.unavailable;
    kinds.hidden = ui.notesOnly;
    for (const k of KINDS) { kindBtn[k].setAttribute('aria-pressed', String(ui.kind === k)); }
    list.textContent = '';
    if (ui.error) list.appendChild(el('p', 'nb-empty', ui.error));
    else if (ui.loaded && !ui.items.length) list.appendChild(el('p', 'nb-empty', t(ui.query.trim() || ui.kind !== 'all' ? 'brain.mem.emptyQuery' : 'brain.mem.empty')));
    else if (!ui.loaded) list.appendChild(el('p', 'nb-empty', t('brain.mem.loading')));
    for (const it of ui.items) list.appendChild(row(it));
    more.hidden = !ui.more;
    allBtn.hidden = ui.confirm || ui.count === 0;
    confirmBox.hidden = !ui.confirm;
    status.textContent = ui.unavailable ? t('brain.mem.unavailable') : ui.note || (ui.reset ? t('brain.mem.reset') : '');
  }
  function row(it) {
    const r = el('div', 'nb-mem'); r.dataset.memory = String(it.id); r.setAttribute('role', 'listitem');
    const top = el('div', 'nb-step-top');
    top.append(el('span', 'nb-chip', t(`brain.mem.kind.${it.kind === 'note' ? 'note' : 'turn'}`)));
    const when = whenText(it.createdAt, getLocale());
    if (when) top.appendChild(el('span', 'nb-when', when));
    top.appendChild(el('span', 'nb-sp'));
    const del = el('button', 'nb-toggle danger', t('brain.mem.delete')); del.type = 'button'; del.setAttribute('aria-label', t('brain.mem.deleteAria'));
    del.addEventListener('click', () => forget(it.id));
    top.appendChild(del);
    r.append(top, el('p', 'nb-text', typeof it.text === 'string' ? it.text : ''));
    return r;
  }
  function buildConfirm() {
    confirmBox.textContent = '';
    const yes = el('button', 'nb-toggle danger', t('brain.mem.confirmYes')); yes.type = 'button';
    const no = el('button', 'nb-toggle', t('brain.mem.cancel')); no.type = 'button';
    yes.addEventListener('click', forgetAll);
    no.addEventListener('click', () => { ui.confirm = false; paint(); });
    confirmBox.append(el('p', 'nb-text', (ui.count === 1 ? t('brain.mem.confirmOne') : t('brain.mem.confirmAll', { n: ui.count }))), el('div', 'nb-bar', null));
    confirmBox.lastChild.append(yes, no);
  }

  async function readStatus() {
    const s = await mem.status();
    ui.enabled = Boolean(s && s.enabled);
    ui.count = Number.isFinite(s && s.count) ? s.count : 0;
    ui.notesOnly = Boolean(s && Array.isArray(s.kinds) && s.kinds.length === 1 && s.kinds[0] === 'note');
    ui.reset = Boolean(s && s.reset);
    ui.unavailable = Boolean(s && s.unavailable);
    onCount(ui.count);
  }
  async function load(reset) {
    const mine = ++seq;
    const args = { limit: PAGE };
    if (ui.query.trim()) args.search = ui.query.trim();
    if (ui.kind !== 'all') args.kind = ui.kind;
    if (!reset && ui.items.length) args.beforeId = ui.items[ui.items.length - 1].id;
    try {
      if (reset) await readStatus();
      const res = await mem.list(args);
      if (mine !== seq) return; // a newer search or filter already answered
      const items = Array.isArray(res) ? res : arr(res && res.items);
      ui.items = reset ? items : ui.items.concat(items);
      ui.more = res && !Array.isArray(res) && typeof res.more === 'boolean' ? res.more : items.length >= PAGE;
      ui.error = ''; ui.loaded = true;
    } catch (e) { return fail(e); }
    paint();
  }
  async function forget(id) {
    try { await mem.delete(id); await readStatus(); } catch (e) { return fail(e); }
    ui.items = ui.items.filter((x) => x.id !== id);
    ui.note = '';
    paint();
  }
  async function forgetAll() {
    try { await mem.deleteAll(); } catch (e) { return fail(e); }
    ui.confirm = false; ui.note = '';
    await load(true);
  }
  async function exportAll() {
    try {
      const r = await mem.exportFile();
      ui.note = r && r.ok ? t('brain.mem.exported', { path: r.path }) : (r && r.canceled ? '' : t('brain.mem.exportFail', { error: (r && r.error) || 'unknown' }));
    } catch (e) { ui.note = t('brain.mem.exportFail', { error: (e && e.message) || String(e) }); }
    paint();
  }

  async function addNote() {
    const text = draft.value;
    if (!text.trim()) { ui.note = t('brain.mem.addEmpty'); return paint(); }
    let r;
    try { r = await mem.add(text); } catch (e) { return fail(e); }
    if (!r || !r.ok) { ui.note = t('brain.mem.addEmpty'); return paint(); } // the host's only refusal is an empty note
    draft.value = '';
    ui.note = t('brain.mem.added');
    await load(true);
  }

  addBtn.addEventListener('click', addNote);
  swBox.addEventListener('change', async () => {
    try { await mem.setEnabled(swBox.checked); await readStatus(); } catch (e) { return fail(e); }
    paint();
  });
  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { ui.query = search.value; load(true); }, SEARCH_DELAY_MS); });
  exportBtn.addEventListener('click', exportAll);
  allBtn.addEventListener('click', () => { ui.confirm = true; buildConfirm(); paint(); });

  paint();
  load(true);
}
