// Memory list (T-31 slice 3b, SPEC-memory slice 1 without "+ Note"): what Zumi remembers on this computer, newest first, 50 per page, a
// Notes / Conversations filter, search, edit one note in place, forget one, export marked "not encrypted" and the one-line privacy sentence. There is no
// "forget all" and no on/off switch here (owner rulings of 19-11: the switch is in Settings > App > Advanced). It exists only where the host offers `window.zumi.memory` (the Tauri build, M3); the Electron build never
// gets here and shows the SPEC card instead (memory-card.js), so nothing in this file runs there.
//
// Host API (PLAN-MEMORY section 4, renderer side): status() -> { enabled, count, reset? }, setEnabled(on), list({ search?, beforeId?, limit })
// -> items[] | { items[], more? }, delete(id), update(id, text) (edit one note in place), exportFile() -> { ok, path } (the save dialog and the file name
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
const JOURNAL_SHOWN = 30;
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
  const ui = { journal: [], kind: 'all', query: '', items: [], more: false, enabled: true, count: 0, note: '', error: '', loaded: false, notesOnly: false, reset: false, unavailable: false, editing: null, draft: '' };
  let seq = 0, timer = 0;
  host.textContent = '';

  // The sentence names the real folder once the host has said where it is (status.dir); until then, and for a host that never says, the same
  // sentence without a folder. Chats and notes stay on this computer and Zumi never uploads them; the quoted notes are the only thing that leaves, to the person's own model.
  const privacy = el('p', 'nb-mute nb-mem-privacy', t('brain.mem.privacyNoDir'));
  // The sentence is long (it filled two thirds of the panel, Fable visual pass alpha.11 C): three lines, then a toggle opens the rest.
  // The text itself is never cut: it is the full consent sentence, only clipped on screen.
  privacy.className += ' nb-clamp';
  const privacyBtn = el('button', 'nb-mem-privacy-more', t('brain.mem.privacyOpen')); privacyBtn.type = 'button';
  privacyBtn.setAttribute('aria-expanded', 'false');
  privacyBtn.addEventListener('click', () => {
    const open = privacy.className.split(' ').includes('nb-clamp');
    privacy.className = open ? privacy.className.replace(' nb-clamp', '') : `${privacy.className} nb-clamp`;
    privacyBtn.textContent = t(open ? 'brain.mem.privacyClose' : 'brain.mem.privacyOpen');
    privacyBtn.setAttribute('aria-expanded', String(open));
  });
  // "+ Note": only where the host can store one.
  const canAdd = typeof mem.add === 'function';
  const canEdit = typeof mem.update === 'function';
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
  // R6g MF2: the journal of changes, newest first: who (you / the AI in chat), when, before -> after, with Undo per entry. Only where the host has it.
  const canJournal = typeof mem.journal === 'function' && typeof mem.undo === 'function';
  const journal = el('details', 'nb-journal');
  const jhead = el('summary', 'nb-journal-head');
  const jlist = el('div', 'nb-list'); jlist.setAttribute('role', 'list');
  journal.append(jhead, jlist);
  journal.hidden = true;
  const foot = el('div', 'nb-mem-foot');
  const exportBtn = el('button', 'nb-toggle', t('brain.mem.export')); exportBtn.type = 'button';
  const status = el('p', 'nb-mute nb-mem-status'); status.setAttribute('aria-live', 'polite');
  foot.append(exportBtn);
  host.append(privacy, privacyBtn, composer, bar, list, more, journal, foot, status);

  const arr = (v) => (Array.isArray(v) ? v : []);
  const fail = (e) => { ui.error = t('brain.mem.error', { error: (e && e.message) || String(e) }); paint(); };

  function paint() {
    // A host whose Node cannot hold memory (status.unavailable): say so; nothing to add or export. The on/off switch is not here:
    // it lives in Settings > App > Advanced (memory-settings.js).
    foot.hidden = ui.unavailable; composer.hidden = !canAdd || ui.unavailable;
    kinds.hidden = ui.notesOnly;
    for (const k of KINDS) { kindBtn[k].setAttribute('aria-pressed', String(ui.kind === k)); }
    list.textContent = '';
    if (ui.error) list.appendChild(el('p', 'nb-empty', ui.error));
    else if (ui.loaded && !ui.items.length) list.appendChild(el('p', 'nb-empty', t(ui.query.trim() || ui.kind !== 'all' ? 'brain.mem.emptyQuery' : 'brain.mem.empty')));
    else if (!ui.loaded) list.appendChild(el('p', 'nb-empty', t('brain.mem.loading')));
    for (const it of ui.items) list.appendChild(row(it));
    more.hidden = !ui.more;
    paintJournal();
    status.textContent = ui.unavailable ? t('brain.mem.unavailable') : ui.note || (ui.reset ? t('brain.mem.reset') : '') || (ui.loaded && !ui.enabled ? t('brain.mem.offNote') : '');
  }
  // The latest change of each note, to mark a note the AI wrote last.
  const lastChange = (id) => ui.journal.find((j) => j.noteId === id);
  function paintJournal() {
    journal.hidden = !canJournal || ui.unavailable || !ui.journal.length;
    jlist.textContent = '';
    if (journal.hidden) return;
    jhead.textContent = t('brain.mem.j.title');
    if (!ui.jset) { journal.open = ui.journal.some((j) => j.actor === 'agent'); ui.jset = true; } // opens by itself the first time the AI has changed something
    for (const j of ui.journal) jlist.appendChild(jrow(j));
  }
  function jrow(j) {
    const r = el('div', 'nb-jrow'); r.dataset.journal = j.id; r.setAttribute('role', 'listitem');
    const top = el('div', 'nb-step-top');
    top.append(el('span', `nb-chip${j.actor === 'agent' ? ' nb-ai-chip' : ''}`, j.actor === 'agent' ? t('brain.mem.j.ai') : t(j.via === 'undo' ? 'brain.mem.j.youUndo' : 'brain.mem.j.you')));
    top.appendChild(el('span', 'nb-chip', t(`brain.mem.j.${j.kind === 'created' ? 'added' : j.kind === 'deleted' ? 'forgot' : 'changed'}`)));
    const when = whenText(j.at, getLocale());
    if (when) top.appendChild(el('span', 'nb-when', when));
    top.appendChild(el('span', 'nb-sp'));
    if (j.canRevert) {
      const undo = el('button', 'nb-toggle', t('brain.mem.j.undo')); undo.type = 'button'; undo.setAttribute('aria-label', t('brain.mem.j.undoAria'));
      undo.addEventListener('click', () => undoRow(j.id));
      top.appendChild(undo);
    }
    r.appendChild(top);
    const text = (x) => (typeof x === 'string' ? x : '');
    // an edit shows the earlier text and the new one; an added or forgotten note shows its text
    r.appendChild(el('p', 'nb-text', j.kind === 'edited' ? `${text(j.text)} → ${text(j.to)}` : text(j.text)));
    if (!j.canRevert) r.appendChild(el('p', 'nb-mute nb-text', t('brain.mem.j.cant')));
    return r;
  }
  async function undoRow(id) {
    let r;
    try { r = await mem.undo(id); } catch (e) { return fail(e); }
    ui.note = r && r.ok ? t('brain.mem.j.undone') : t(r && r.error === 'cannot_revert' ? 'brain.mem.j.cant' : 'brain.mem.j.gone');
    await load(true);
  }
  function row(it) {
    const r = el('div', 'nb-mem'); r.dataset.memory = String(it.id); r.setAttribute('role', 'listitem');
    const top = el('div', 'nb-step-top');
    top.append(el('span', 'nb-chip', t(`brain.mem.kind.${it.kind === 'note' ? 'note' : 'turn'}`)));
    const when = whenText(it.createdAt, getLocale());
    if (when) top.appendChild(el('span', 'nb-when', when));
    const last = it.kind === 'note' ? lastChange(it.id) : null;
    if (last && last.actor === 'agent' && last.kind !== 'deleted') top.appendChild(el('span', 'nb-chip nb-ai nb-ai-chip', t(last.kind === 'created' ? 'brain.mem.j.aiAdded' : 'brain.mem.j.aiMark')));
    top.appendChild(el('span', 'nb-sp'));
    // Edit in place: a note only (a chat turn is forgotten, not rewritten), and only where the host can update one.
    const editing = canEdit && it.kind === 'note' && ui.editing === it.id;
    if (canEdit && it.kind === 'note' && !editing) {
      const edit = el('button', 'nb-toggle', t('brain.mem.edit')); edit.type = 'button'; edit.setAttribute('aria-label', t('brain.mem.editAria'));
      edit.addEventListener('click', () => { ui.editing = it.id; ui.draft = typeof it.text === 'string' ? it.text : ''; ui.note = ''; paint(); });
      top.appendChild(edit);
    }
    const del = el('button', 'nb-toggle danger', t('brain.mem.delete')); del.type = 'button'; del.setAttribute('aria-label', t('brain.mem.deleteAria'));
    del.addEventListener('click', () => forget(it.id));
    top.appendChild(del);
    if (editing) {
      const box = el('textarea', 'nb-filter nb-mem-edit'); box.rows = 3; box.value = ui.draft; box.setAttribute('aria-label', t('brain.mem.editAria'));
      box.addEventListener('input', () => { ui.draft = box.value; });
      const save = el('button', 'nb-toggle', t('brain.mem.save')); save.type = 'button';
      const cancel = el('button', 'nb-toggle', t('brain.mem.cancel')); cancel.type = 'button';
      save.addEventListener('click', () => { ui.draft = box.value; saveEdit(it); });
      cancel.addEventListener('click', () => { ui.editing = null; ui.note = ''; paint(); });
      const acts = el('div', 'nb-bar'); acts.append(save, cancel);
      r.append(top, box, acts);
      return r;
    }
    r.append(top, el('p', 'nb-text', typeof it.text === 'string' ? it.text : ''));
    if (it.kind === 'turn' && typeof it.reply === 'string' && it.reply) r.appendChild(el('p', 'nb-mute nb-text', `Zumi: ${it.reply}`)); // a chat turn: what Zumi answered
    return r;
  }

  async function readStatus() {
    const s = await mem.status();
    ui.enabled = Boolean(s && s.enabled);
    ui.count = Number.isFinite(s && s.count) ? s.count : 0;
    ui.notesOnly = Boolean(s && Array.isArray(s.kinds) && s.kinds.length === 1 && s.kinds[0] === 'note');
    ui.reset = Boolean(s && s.reset);
    ui.unavailable = Boolean(s && s.unavailable);
    privacy.textContent = typeof (s && s.dir) === 'string' && s.dir ? t('brain.mem.privacy', { dir: s.dir }) : t('brain.mem.privacyNoDir');
    onCount(ui.count);
  }
  async function readJournal() {
    if (!canJournal) return;
    try { const r = await mem.journal({ limit: JOURNAL_SHOWN }); ui.journal = r && r.ok !== false ? arr(r.items) : []; } catch { ui.journal = []; } // the journal is a convenience: a failure never costs the list
  }
  async function load(reset) {
    const mine = ++seq;
    if (reset) ui.editing = null;
    const args = { limit: PAGE };
    if (ui.query.trim()) args.search = ui.query.trim();
    if (ui.kind !== 'all') args.kind = ui.kind;
    if (!reset && ui.items.length) args.beforeId = ui.items[ui.items.length - 1].id;
    try {
      if (reset) { await readStatus(); await readJournal(); }
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
  async function saveEdit(it) {
    let r;
    try { r = await mem.update(it.id, ui.draft); } catch (e) { return fail(e); }
    if (r && r.ok === false && r.error === 'not_found') { ui.editing = null; ui.note = t('brain.mem.editGone'); return load(true); } // forgotten elsewhere meanwhile
    if (!r || !r.ok) { ui.note = t('brain.mem.editEmpty'); return paint(); } // the host's refusal is an empty text; the box stays open
    ui.editing = null;
    const at = ui.items.findIndex((x) => x.id === it.id);
    if (at >= 0) ui.items[at] = { ...ui.items[at], text: r.item.text };
    ui.note = t('brain.mem.edited');
    paint();
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
  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { ui.query = search.value; load(true); }, SEARCH_DELAY_MS); });
  exportBtn.addEventListener('click', exportAll);

  paint();
  load(true);
}
