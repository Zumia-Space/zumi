// Laneboard web UI. Plain ES2022, no build step. Reads GET /api/v1/state, writes only POST /api/v1/write.
// The owner-attention and stalled blocks are rendered straight from the server's derived lists.
'use strict';

const LANGS = { en: 'English', zh: '中文', vi: 'Tiếng Việt' };
// Display prefs: kept in this browser, and for signed-in users also on the server (prefs.set -> me.prefs).
const PREF_DEFAULTS = { lang: '', theme: 'system', accent: 'neutral', font_size: 'default', density: 'comfortable', notify_owner_asks: false };
const CHOICES = { theme: ['system', 'dark', 'light'], accent: ['neutral', 'blue', 'violet', 'green', 'orange', 'rose'], font_size: ['default', 'large', 'larger'], density: ['comfortable', 'compact'] };
const SECTIONS = ['general', 'appearance', 'notifications', 'agents', 'zumi', 'about'];
// The name of the token the Zumi desktop app signs in with (owner-only, settings → "Create a key for the Zumi app").
const ZUMI_TOKEN = 'zumi-desktop';
const S = { token: '', lang: 'en', dict: {}, en: {}, data: null, drafts: {}, prefs: { ...PREF_DEFAULTS }, prefsFrom: '', seenAsks: null, loadedAt: 0, open: {}, errors: {}, history: {}, offline: false, compose: {}, composeFiles: {}, galleryNavs: {}, hl: null, askOpen: '', leftFilter: '', leftQuery: '', ctxTab: '', libFilter: 'all', regFilter: 'live', regQuery: '', legacyMedia: null, lightbox: null, reader: null, diagramFull: null, wkPop: '', stats: undefined, statsAt: 0, statWin: 'w7', statMWin: 'w7', quota: undefined, quotaAt: 0, quotaErr: null };
const store = {
  get: k => { try { return localStorage.getItem('laneboard.' + k) || ''; } catch { return ''; } },
  set: (k, v) => { try { v ? localStorage.setItem('laneboard.' + k, v) : localStorage.removeItem('laneboard.' + k); } catch { /* private mode */ } }
};
const $ = sel => document.querySelector(sel);
// Embedded in the Zumi desktop app (?embed=1): lang-boot.js puts `embed` on <html> before the first paint. The host
// already shows the brand, identity, language and settings, so the rail skips them.
const isEmbed = () => document.documentElement.classList.contains('embed');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function t(key, vars = {}) {
  const s = S.dict[key] ?? S.en[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ''));
}

// ---------- boot params: #token=…&lang=…&theme=… are consumed once and removed from the URL ----------
function consumeFragment() {
  const h = location.hash.slice(1);
  if (!/(^|&)(token|lang|theme)=/.test(h)) return;
  const p = new URLSearchParams(h);
  if (p.get('token')) store.set('token', p.get('token'));
  const prefs = loadLocalPrefs();
  if (LANGS[p.get('lang')]) store.set('uiLang', p.get('lang')); // an explicit pick for this browser
  if (CHOICES.theme.includes(p.get('theme'))) prefs.theme = p.get('theme');
  store.set('prefs', JSON.stringify(prefs));
  history.replaceState(null, '', location.pathname + '#/' + (p.get('view') || 'overview'));
}
function loadLocalPrefs() {
  let p = {};
  try { p = JSON.parse(store.get('prefs') || '{}'); } catch { /* corrupt entry: start from defaults */ }
  if (!p.lang && LANGS[store.get('lang')]) p.lang = store.get('lang'); // keys used before the settings view existed
  if (!p.theme && CHOICES.theme.includes(store.get('theme'))) p.theme = store.get('theme');
  return { ...PREF_DEFAULTS, ...p };
}
function applyPrefs() {
  const el = document.documentElement, p = S.prefs;
  const dark = p.theme === 'dark' || (p.theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  el.classList.toggle('dark', dark);
  el.dataset.accent = p.accent; el.dataset.fontSize = p.font_size; el.dataset.density = p.density;
}
/** Change one pref: applies at once, saves in this browser, and (signed in) saves to the user's server prefs. */
async function setPref(key, value) {
  // The UI language is this browser's own choice (kept in localStorage, never written to the server): it works the
  // same signed in, signed out and in a read-only preview.
  if (key === 'lang') { if (S.lang === value) return; store.set('uiLang', value); await loadLocale(value); applyPrefs(); return render(); }
  if (S.prefs[key] === value) return;
  S.prefs[key] = value;
  store.set('prefs', JSON.stringify(S.prefs));
  if (key === 'lang') await loadLocale(value);
  if (key === 'notify_owner_asks' && value && 'Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
  applyPrefs();
  await render();
  if (S.data?.me) await write('prefs.set', S.data.me.token_id, { [key]: value });
}
/** Server prefs win once per signed-in token (on first load); later local changes are written through. */
async function adoptServerPrefs(me) {
  if (!me || S.prefsFrom === me.token_id) return;
  S.prefsFrom = me.token_id;
  const { lang: _serverLang, ...sp } = me.prefs || {}; // a stored server language no longer picks the UI language
  if (!Object.keys(sp).length) return;
  Object.assign(S.prefs, sp);
  store.set('prefs', JSON.stringify(S.prefs));
  applyPrefs();
}
/** Browser notification for each owner ask that appears after the first load. Owner only, opt-in. */
function notifyNewAsks() {
  const waiting = S.data?.attention?.waiting || [];
  const ids = new Set(waiting.filter(w => w.kind !== 'step').map(w => w.id));
  const fresh = S.seenAsks ? waiting.filter(w => ids.has(w.id) && !S.seenAsks.has(w.id)) : [];
  S.seenAsks = ids;
  if (!isOwner() || !S.prefs.notify_owner_asks || !('Notification' in window) || Notification.permission !== 'granted') return;
  for (const w of fresh) new Notification(t('notify.newAsk', { task: w.task_id }), { body: w.text, tag: w.id });
}

async function loadLocale(lang) {
  const get = async l => (await fetch(`locales/${l}.json`)).json();
  const early = window.LaneLocale; // started by lang-boot.js before the first paint
  if (!Object.keys(S.en).length) S.en = await (early?.en || get('en')).catch(() => get('en'));
  S.dict = lang === 'en' ? S.en : await (early?.lang === lang && early.dict ? early.dict : get(lang)).catch(() => S.en);
  S.lang = lang;
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : lang;
}
/** The UI language: this browser's explicit pick (switcher, settings, #lang=), else English — the board's default.
 *  Only the UI chrome follows it; task content is shown exactly as written. */
function detectLang() {
  const chosen = store.get('uiLang');
  return LANGS[chosen] ? chosen : 'en';
}

// ---------- formatting ----------
function fmtDur(ms) {
  if (ms == null || !isFinite(ms) || ms < 0) return '';
  const min = Math.round(ms / 60000);
  if (min < 1) return t('dur.s', { n: Math.max(1, Math.round(ms / 1000)) });
  if (min < 60) return t('dur.m', { n: min });
  const h = Math.floor(min / 60);
  if (h < 48) return min % 60 ? t('dur.h', { h, m: min % 60 }) : t('dur.hr', { h });
  return t('dur.d', { d: Math.floor(h / 24), h: h % 24 });
}
const serverNow = () => (S.data ? Date.parse(S.data.now) + (Date.now() - S.loadedAt) : Date.now());
const ago = iso => fmtDur(serverNow() - Date.parse(iso));
const role = () => S.data?.me?.role || 'anonymous';
const isOwner = () => role() === 'owner';
const isLead = () => role() === 'owner' || role() === 'coordinator';
const stateChip = st => `<span class="chip ${({ done: 'ok', active: 'info', waiting: 'q', blocked: 'bad' })[st] || ''}">${esc(t('state.' + st))}</span>`;
const healthDot = h => `<span class="dot ${esc(h)}" title="${esc(t('health.' + h))}"></span>`;
// Current step comes from the server (task.current_step, src/rules.mjs); the page never derives it, so an old
// waiting step cannot win over newer work.
function currentStepText(task) {
  const c = task.current_step;
  if (!c) return t('task.allDone');
  const i = task.steps.findIndex(s => s.id === c.id);
  return t('task.currentValue', { n: i >= 0 ? i + 1 : '?', label: c.label || c.id.split('/')[1], state: t('state.' + c.state) });
}
/** A task with an active step whose last accepted change is older than this many hours gets a "stale Nh" badge. */
const STALE_HOURS = 12;
function staleHours(task) {
  if (!task.steps.some(s => s.state === 'active')) return 0;
  const u = Date.parse(task.last_activity_at || '');
  if (!u) return 0;
  const h = Math.floor((serverNow() - u) / 3600000);
  return h >= STALE_HOURS ? h : 0;
}
function staleBadge(task) {
  const h = staleHours(task);
  return h ? `<span class="chip bad stale" title="${esc(t('task.staleTitle', { h }))}">${esc(t('task.stale', { h }))}</span>` : '';
}
/** The Now/Next text is behind the steps or older than the owner's limit (the server's stale_text list): the label, or ''. */
function freshLabel(task) {
  const s = (S.data.stale_text || []).find(x => x.task_id === task.id);
  if (!s) return '';
  return s.reason === 'age' ? t('fresh.age', { h: Math.floor((serverNow() - Date.parse(s.text_at)) / 3600000) }) : t('fresh.stepsNewer');
}
function freshBadge(task) {
  const label = freshLabel(task);
  if (!label) return '';
  const req = task.status_request ? ` <span class="muted">${esc(t('fresh.requested', { when: fmtTime(task.status_request.attribution.created_at) }))}</span>` : '';
  return `<span class="chip bad stale-text">${esc(label)}</span>${req}`;
}
/** A model id as the board names it (BOARD_MODELS labels), else the id itself. */
const modelName = id => S.data?.config?.model_labels?.[id] || (id === 'haiku' ? 'Haiku 5.5' : id); // haiku joined the routing slots after the board's label list was set
function workerChip(w, taskId) {
  if (!w) return `<span class="chip">${esc(t('worker.none'))}</span>`;
  const chip = `<span class="chip ai">${esc(modelName(w.model))} · ${esc(w.effort)}</span>`;
  return `<span class="worker">${taskId ? `<a class="chip-link" href="#/task/${encodeURIComponent(taskId)}" data-worker-open="${esc(taskId)}">${chip}</a>` : chip}<span class="muted">${esc(t('worker.by.' + w.by))}</span></span>`;
}
/** Owner feedback on a task the coordinator has not handled yet. */
const openOwnerFeedback = taskId => (S.data.feedback || []).filter(f => f.task_id === taskId && f.status === 'open' && !f.info && f.attribution.created_by.role === 'owner');
const goalOf = taskId => S.data.goals?.[taskId] || null;
const fmtTime = iso => { try { return new Date(iso).toLocaleString(document.documentElement.lang, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };
/** Who raised an ask: a lane relayed through the coordinator names itself in the request origin. */
const askedBy = from => (/^(?:lane-ask|legacy) (\S+)/.exec(from.origin || '') || [])[1] || from.label || from.name;
const liveTask = task => !['paused', 'closed'].includes(task.status);

// Task status and step state, in the order the selects offer them (schema/v1/common.json taskStatus / stepState).
const TASK_STATUS = ['open', 'doing', 'waiting', 'blocked', 'paused', 'closed'];
const STEP_STATES = ['todo', 'active', 'waiting', 'blocked', 'done'];
/** Steps lists (stepsByRecency) and the history card show this many rows before their "show older" toggle. */
const STEPS_SHOWN = 6;
const stepPin = s => (s.state === 'waiting' && s.zone === 'owner' ? 0 : s.state === 'active' ? 1 : s.state === 'waiting' || s.state === 'blocked' ? 2 : 3);
/** Owner/coordinator control for a task's status (task page and overview cards); the change handler writes task.update. */
const taskStatusSelect = task => `<select class="state-select status-${esc(task.status)}" data-task-status="${esc(task.id)}" data-rev="${task.rev}" aria-label="${esc(t('task.statusLabel'))}">${TASK_STATUS.map(st => `<option value="${st}" ${task.status === st ? 'selected' : ''}>${esc(t('status.' + st))}</option>`).join('')}</select>`;
/** The owner's five task statuses: Active / Waiting on owner / Blocked / Paused / Done → doing / waiting / blocked / paused / closed. */
const OWNER_STATUSES = ['doing', 'waiting', 'blocked', 'paused', 'closed'];
/** The task status as a visible select (owner): the five statuses (+ the current one if it is another). Written with
 *  task.update through board.write, so the board rules apply; a refusal is listed under the header. */
const headStatusSelect = task => `<select class="state-select head-status status-${esc(task.status)}" data-task-status="${esc(task.id)}" data-rev="${task.rev}" aria-label="${esc(t('task.statusLabel'))}">${[...new Set([...OWNER_STATUSES, task.status])].map(st => `<option value="${st}" ${task.status === st ? 'selected' : ''}>${esc(t('status.' + st))}</option>`).join('')}</select>`;
const statusChip = st => `<span class="chip ${({ doing: 'info', waiting: 'q', blocked: 'bad', closed: 'ok' })[st] || ''}">${esc(t('status.' + st))}</span>`;

// ---------- agent-written text: safe Markdown (public/markdown.js), short link labels, show more/less ----------
const MD = window.LaneMarkdown, LR = window.LaneReading, DG = window.LaneDiagram;
/** ![..](media/name) in a task's text shows that task's attachment of the same file name. */
const mediaOf = taskId => name => (S.data?.attachments || []).find(a => a.task_id === taskId && a.name === name)?.id || null;
/** A local .md path in agent text ("Chi tiết: `D:/…/file.md`") becomes a reader button when the board holds a copy of it (cos-board md-attach); otherwise it stays text. */
const mdDocs = (html, taskId) => LR.linkDocPaths(html, p => docButton(taskId, p.split(/[\\/]/).pop(), p, 'inline-doc', ''));
const mdInline = (text, taskId) => mdDocs(MD.inline(text, { resolveMedia: mediaOf(taskId) }), taskId);
const mdHtml = (text, taskId) => mdDocs(MD.render(text, { resolveMedia: mediaOf(taskId) }), taskId);
/** Block text; long text starts as a preview with a show more / show less toggle that survives the 15 s refresh. */
function mdBlock(text, key, taskId, cls = '') {
  const html = mdHtml(text, taskId);
  if (text.length <= 600 && text.split('\n').length <= 12) return `<div class="md ${cls}">${html}</div>`;
  const open = !!S.open['md-' + key];
  return `<div class="md clamp ${cls} ${open ? 'open' : ''}">${html}</div><button type="button" class="more" data-action="more" data-key="${esc(key)}" aria-expanded="${open}">${esc(t(open ? 'common.showLess' : 'common.showMore'))}</button>`;
}
/** A text is long when mdBlock would cut it to a preview (the same 600 chars / 12 lines test). */
const isLongText = text => String(text ?? '').length > 600 || String(text ?? '').split('\n').length > 12;
/** Estimated reading time, whole minutes (about 200 words a minute; never "0 min"). */
const readMins = text => Math.max(1, Math.round(String(text ?? '').trim().split(/\s+/).filter(Boolean).length / 200));
/** Long agent text as a short preview plus a read button that opens the reader (T-31); short text shows in full.
 *  `read` names the reader's source: {kind: 'step'|'ask'|'msg'|'now', ref, step}. */
function mdRead(text, key, taskId, cls, read) {
  const html = mdHtml(text, taskId);
  if (!isLongText(text)) return `<div class="md ${cls}">${html}</div>`;
  const tag = read.step ? ` data-step="${esc(read.step)}"` : read.ref ? ` data-ref="${esc(read.ref)}"` : '';
  return `<div class="md clamp ${cls}">${html}</div><button type="button" class="btn read-open" data-action="read" data-kind="${esc(read.kind)}" data-task="${esc(taskId)}"${tag} aria-haspopup="dialog"><span>${esc(t('step.readFull'))}</span><span class="muted">${esc(t('step.readMins', { n: readMins(text) }))}</span></button>`;
}
/** An ask or answer in the activity feed: the first four lines, then an inline Xem thêm / Thu gọn (fitClamps hides the toggle when it all
 *  fits); a long one also gets the read button. Nothing in it opens a file: a local .md is a reader button or text. */
function evBody(text, key, taskId, read) {
  const open = !!S.open['md-' + key], tag = read.ref ? ` data-ref="${esc(read.ref)}"` : '';
  const readBtn = isLongText(text) ? `<button type="button" class="btn read-open" data-action="read" data-kind="${esc(read.kind)}" data-task="${esc(taskId)}"${tag} aria-haspopup="dialog"><span>${esc(t('step.readFull'))}</span><span class="muted">${esc(t('step.readMins', { n: readMins(text) }))}</span></button>` : '';
  return `<div class="md ev-body clamp4 ${open ? 'open' : ''}" data-clamp>${mdHtml(text, taskId)}</div><button type="button" class="more" data-action="more" data-key="${esc(key)}" aria-expanded="${open}">${esc(t(open ? 'common.showLess' : 'common.showMore'))}</button>${readBtn}`;
}
// ---------- refs: images and links attached to an ask or a card line (public/markdown.js splitRefs) ----------
// An image the task carries as an attachment shows as a thumbnail (click: lightbox); a link as a chip that opens in a
// new tab. A path on the owner's computer ("local") cannot open in a browser: the web shows it with a copy button; the
// Zumi owner app loads the page with ?local=open and opens it from its main process (/__zumi-open, an allowlisted path
// or loopback URL); an embed that has no local files (Zumi's user build) passes ?local=hide and gets no local links.
const LOCAL_LINKS = (m => (m === 'open' || m === 'hide' ? m : 'copy'))(new URLSearchParams(location.search).get('local'));
const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i;
const zumiOpen = q => '/__zumi-open?' + new URLSearchParams(q);
/** Text and its refs: { body, images, links } (an empty refs part for text without any). */
const refsOf = text => MD.splitRefs(text || '');
/** One local path, one key: Windows slashes and case do not make two files (reading.js sameFile's rule). */
const refsKey = p => String(p || '').replace(/\\/g, '/').toLowerCase();
/** The first of each key, in order: an ask that names the same file twice shows it once. */
const uniqBy = (xs, key) => xs.filter((x, i) => xs.findIndex(y => key(y) === key(x)) === i);
/** A step waiting on the owner, as a Needs-you item: its label, plus the images (![alt](media/name)) and web links
 *  of its detail and the detail's refs line, so the owner sees them without opening the step. */
function stepRefs(step) {
  const r = refsOf(step.detail || ''), seen = new Set();
  const images = [...[...r.body.matchAll(/!\[([^\]\n]*)\]\(media\/([\w.-]+\.(?:png|jpe?g|webp|gif))\)/gi)].map(m => ({ name: m[2], caption: m[1] || m[2], url: 'media/' + m[2] })), ...r.images];
  const links = [...[...r.body.matchAll(/(?<!!)\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g)].map(m => ({ label: /^https?:\/\//.test(m[1]) ? MD.shortUrl(m[1]) : m[1], url: m[2], local: false })), ...r.links];
  const once = (x, k) => (seen.has(k) ? false : seen.add(k));
  return { body: step.label, images: images.filter(x => once(x, 'i:' + x.name)), links: links.filter(x => once(x, 'l:' + x.url)) };
}
/** The thumbnails and link chips of one text. `nav` names its lightbox order (several strips can share a page). */
function refsHtml(taskId, refs, nav) {
  const items = refs.images.map(im => {
    const att = (S.data?.attachments || []).find(a => a.task_id === taskId && a.name === im.name);
    return { im, it: att ? { att: { id: att.id, mime: att.mime, name: att.name, caption: im.caption } } : { legacy: { name: im.name, type: 'image' } } };
  });
  S.galleryNavs[nav] = items.map(x => x.it);
  const thumbs = items.map(({ im, it }, i) => `<button type="button" class="ref-img" data-action="lightbox" data-nav="${esc(nav)}" data-i="${i}" title="${esc(im.caption)}"><img alt="${esc(im.caption)}" loading="lazy" ${it.att ? `data-att="${esc(it.att.id)}" data-w="480"` : `src="${esc('media/' + im.name)}"`}><span class="ref-cap">${esc(im.caption)}</span></button>`).join('');
  // A local file the board holds a copy of (J-05 link-attach) opens from its chip: .md in the reader, a picture in the
  // lightbox, an .mp4 in a <video controls> right here (it streams through /media/:id/link, which serves Range). The
  // copy-path chip stays as the secondary action, so a path can still be pasted into a terminal.
  const files = refs.links.map(l => (l.local ? LR.pickAttachment(S.data?.attachments, taskId, l.url) : null));
  const shots = files.filter(a => a && LR.attKind(a.mime) === 'image');
  S.galleryNavs[nav + ':open'] = shots.map(a => ({ att: a }));
  // A player belongs to one refs block: the same clip can sit on the Needs-you card and in the stream, and opening it
  // in one must not open it in the other.
  const playerKey = a => `file-${nav}-${a.id}`;
  // `own` = the board holds a copy, so the chip no longer claims a browser cannot open the file.
  const copyChip = (l, own) => `<span class="chip ref-link local" title="${esc(own ? t('refs.copy') : t('refs.localTip'))}"><span class="ref-path">${esc(l.url)}</span><button type="button" class="ref-copy" data-action="copy-path" data-path="${esc(l.url)}">${esc(t('refs.copy'))}</button></span>`;
  const chip = (l, i) => {
    if (!l.local) {
      const href = LOCAL_LINKS === 'open' && LOOPBACK.test(l.url) ? zumiOpen({ url: l.url }) : l.url;
      return `<a class="chip ref-link" href="${esc(href)}" title="${esc(l.url)}" target="_blank" rel="noopener noreferrer">↗ ${esc(l.label)}</a>`;
    }
    if (LOCAL_LINKS === 'hide') return '';
    const att = files[i], kind = att && LR.attKind(att.mime);
    // An image the board copied opens in the lightbox, where "open original" and the arrows work as for any other picture.
    if (kind === 'image') return `<button type="button" class="chip ref-link local open" data-action="lightbox" data-nav="${esc(nav + ':open')}" data-i="${shots.indexOf(att)}" title="${esc(l.url)}" aria-haspopup="dialog">▣ ${esc(l.label)}</button>${copyChip(l, true)}`;
    // An .mp4 the board copied: this chip shows the player inline (loadImages fills its src from /media/:id/link).
    if (kind === 'video') return `<button type="button" class="chip ref-link local open" data-action="file-open" data-key="${esc(playerKey(att))}" title="${esc(l.url)}" aria-expanded="${!!S.open[playerKey(att)]}">▶ ${esc(l.label)}</button>${copyChip(l, true)}`;
    // A local .md that cos-board attached to the task opens in the reader (TL;DR first), in the web and in the app alike.
    const doc = kind === 'md' ? docButton(taskId, l.label, l.url, 'chip ref-link local doc', '▤ ') : null;
    if (doc) return doc + copyChip(l, true);
    // A .md the board holds no copy of is never opened as a raw file in another app: it keeps the copy-path chip (a folder, an html page still opens).
    if (LOCAL_LINKS === 'open' && !/\.md$/i.test(l.url)) return `<a class="chip ref-link local" href="${esc(zumiOpen({ path: l.url }))}" title="${esc(l.url)}" target="_blank" rel="noopener">▤ ${esc(l.label)}</a>`;
    return copyChip(l);
  };
  const chips = refs.links.map(chip).filter(Boolean).join('');
  // A player appears once its chip is open; it keeps a row of its own below the chips. One player per chip key: a path
  // drawn twice (the old duplicate-ref rows) must not stream the clip twice.
  const players = LOCAL_LINKS === 'hide' ? '' : [...new Map(files.filter(a => a && LR.attKind(a.mime) === 'video' && S.open[playerKey(a)]).map(a => [playerKey(a), a])).values()]
    .map(a => `<video controls playsinline preload="metadata" data-media="${esc(a.id)}" data-keep="${esc(playerKey(a))}"></video>`).join('');
  return thumbs || chips ? `<div class="refs">${thumbs ? `<div class="ref-imgs">${thumbs}</div>` : ''}${chips ? `<div class="ref-links">${chips}</div>` : ''}${players ? `<div class="ref-videos">${players}</div>` : ''}</div>` : '';
}
/** The reader button for a local .md the task carries a copy of (the newest text/markdown attachment captioned with that path), or null. */
function docButton(taskId, label, filePath, cls, prefix) {
  const doc = LR.pickMdAttachment(S.data?.attachments, taskId, filePath);
  return doc ? `<button type="button" class="${cls}" data-action="read-doc" data-task="${esc(taskId)}" data-att="${esc(doc.id)}" data-label="${esc(label)}" data-path="${esc(filePath)}" title="${esc(filePath)}" aria-haspopup="dialog">${prefix}${esc(label)}</button>` : null;
}
/** Toast for a refused save: one violation is spelled out; several are counted and pointed at the inline list. */
const refusedToast = vs => (vs.length === 1 ? t('rule.refusedOne', { msg: t('rule.' + vs[0].error, vs[0]) }) : t('rule.refusedMany', { n: vs.length }));
/** A refused state change: every violation the server listed, next to the control that sent it. */
function violationsBox(key) {
  const e = S.errors[key];
  if (!e) return '';
  return `<div class="violations" role="alert"><b>${esc(t('rule.refused'))}</b><ul>${e.violations.map(v => `<li>${esc(t('rule.' + v.error, v))} <span class="mono muted">${esc(v.error)}</span></li>`).join('')}</ul><button type="button" class="more" data-action="dismiss-error" data-key="${esc(key)}">${esc(t('common.dismiss'))}</button></div>`;
}

// ---------- API ----------
const authHeaders = () => (S.token ? { Authorization: `Bearer ${S.token}` } : {});
async function api(route) {
  let res;
  try { res = await fetch(route, { headers: authHeaders(), cache: 'no-store' }); } catch { S.offline = true; return { offline: true }; }
  S.offline = false;
  if (!res.ok) {
    // Consume the error body: an unread response body keeps the request in flight in Chromium (and holds a
    // connection slot on the poll loop). The body carries nothing this caller uses.
    try { await res.text(); } catch { /* ignore */ }
    if (res.status === 401) return { unauthorized: true };
    return { failed: res.status };
  }
  return res.json();
}
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg; el.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { el.hidden = true; }, 4000);
}
/** errorKey: where a refusal with board-rule violations is shown inline (violationsBox) instead of only a toast. */
async function write(op, target_id, data, expected_revision, errorKey) {
  if (readOnly()) { toast(t('preview.refused')); return null; } // the server refuses it anyway (403 preview_readonly)
  const body = { version: 1, request_id: 'ui-' + crypto.randomUUID(), op, target_id, data, ...(expected_revision != null ? { expected_revision } : {}) };
  // X-Requested-With: a site-login (proxy) owner has no bearer token; the server requires this header on its writes (CSRF).
  let res;
  try { res = await fetch('api/v1/write', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'laneboard', ...authHeaders() }, body: JSON.stringify(body) }); }
  catch { S.offline = true; toast(t('common.offline')); render(); return null; }
  const out = await res.json().catch(() => ({}));
  if (errorKey) delete S.errors[errorKey];
  if (!res.ok) {
    if (errorKey && out.violations) { S.errors[errorKey] = { violations: out.violations }; toast(refusedToast(out.violations)); await refresh(); return null; }
    if (out.error !== 'sweep_open') toast(out.error === 'review_model_not_allowed' ? t('worker.reviewNoHaiku') : out.error === 'gemini_effort_not_allowed' ? t('worker.geminiEffort') : out.error === 'owner_set_status' ? t('status.ownerHeld', { status: t('status.' + out.status) }) : res.status === 409 && out.error === 'revision_conflict' ? t('common.conflict') : res.status === 403 ? t('common.forbidden') : t('common.error', { msg: out.error || res.status }));
    await refresh();
    return null;
  }
  return out;
}

// ---------- timing computed here from the view's raw records (public/measure.js) ----------
// The page may be newer than the server it reads (the Zumi app pins this page and reads the live board): ask ages and
// a task's measured time are recomputed from asks/times/task_times, so the current rules show without a server release.
const LM = window.LaneMeasure;
/** Since when the owner has been asked `a` (a re-asked question keeps the first ask's time: measure.js askSince). */
const askSinceOf = a => LM.askSince(a, S.data?.asks || [], S.data?.messages || [], S.data?.times || {});
/** The view with every Needs-you ask's `since`/`age_ms` from askSince, oldest first again (the server's order). */
function withAskAges(data) {
  const w = data.attention?.waiting;
  if (!w || !data.asks) return data;
  const byId = new Map(data.asks.map(a => [a.id, a])), nowMs = Date.parse(data.now);
  for (const x of w) {
    const a = x.kind === 'ask' && byId.get(x.id);
    if (a) { x.since = LM.askSince(a, data.asks, data.messages || [], data.times || {}); x.age_ms = Math.max(0, nowMs - Date.parse(x.since)); }
  }
  w.sort((a, b) => a.since.localeCompare(b.since));
  return data;
}

async function refresh() {
  const token = S.token; // the identity this reply belongs to
  const data = await api('api/v1/state?v=2'); // v=2 adds turns (the latest turn report per lane); an older board ignores it
  // A sign-out (or a sign-in with another token) while the fetch was in flight wins: applying this board would
  // silently undo it. Whoever moved the token has already rendered the screen it wants.
  if (S.token !== token) return;
  if (data.offline || data.failed) return render(); // keep the last board on screen; the banner says we are offline
  if (data.unauthorized) { S.token = ''; store.set('token', ''); S.data = null; return render(); }
  S.data = withAskAges(data); S.loadedAt = Date.now();
  await adoptServerPrefs(data.me);
  notifyNewAsks();
  render();
}

// ---------- read-only preview (server BOARD_PREVIEW_READONLY=1): a banner, and every write control off ----------
const readOnly = () => !!S.data?.config?.read_only;
/** Write controls a preview turns off; reading, tabs, filters, "show more" and the lightbox keep working. */
const WRITE_CONTROLS = ['#main textarea', '#main input:not([type=search])', '#main select', '#main form button', '#main .kchip',
  ...['answer', 'pick', 'choose-plan', 'merge', 'clear', 'resolve', 'routing-reset', 'rotate-secret', 'rebrief-toggle', 'goal-edit', 'goal-draft', 'reply-ask', 'zumi-issue', 'zumi-revoke', 'zumi-reissue'].map(a => `[data-action="${a}"]`),
  '[data-notify]', '[data-fresh]'].join(',');
function previewMode() {
  const on = readOnly();
  document.documentElement.classList.toggle('ro', on);
  let bar = document.getElementById('preview-banner');
  if (on && !bar) { bar = document.createElement('div'); bar.id = 'preview-banner'; bar.className = 'preview-banner'; bar.setAttribute('role', 'status'); document.body.prepend(bar); }
  if (bar && !on) bar.remove();
  if (!on) return;
  const main = S.data.config.main_url || '/zumia/';
  bar.innerHTML = `${esc(t('preview.banner'))} <a href="${esc(main)}">${esc(main)}</a>`;
  for (const el of document.querySelectorAll(WRITE_CONTROLS)) { el.disabled = true; el.setAttribute('aria-disabled', 'true'); }
}

// ---------- routing ----------
function route() {
  const askHash = /^#(ask-\d+)$/.exec(location.hash); // a quick report's chip or the Zumi bubble: the ask by its own id
  if (askHash) { const a = (S.data?.asks || []).find(x => x.id === askHash[1]); return a ? { view: 'task', id: a.task_id, ask: a.id, msg: '' } : { view: 'home', id: '', ask: '', msg: '' }; }
  const stepHash = /^#step-(.+)$/.exec(location.hash); // a step's report by link: step-ID, or step-TASK/ID after the hash
  if (stepHash) { const f = findStep(safeDecode(stepHash[1])); return f ? { view: 'task', id: f.task.id, ask: '', msg: '', step: f.sid } : { view: 'home', id: '', ask: '', msg: '' }; }
  const short = /^#([A-Za-z0-9][\w.-]*)$/.exec(location.hash); // #L-01 selects a task too
  if (short) return { view: 'task', id: short[1], ask: '', msg: '' };
  const [, view = 'home', raw = ''] = location.hash.match(/^#\/([a-z]+)\/?(.*)$/) || [];
  const [id, query = ''] = raw.split('?'), q = new URLSearchParams(query);
  return { view, id: decodeURIComponent(id), ask: q.get('ask') || '', msg: q.get('msg') || '', ...(q.get('step') ? { step: q.get('step') } : {}), ...(q.get('tab') ? { tab: q.get('tab') } : {}) };
}
const safeDecode = s => { try { return decodeURIComponent(s); } catch { return s; } };
/** A step by "<task>/<id>" or by its bare id (the task on screen first, else the first task that has it). */
function findStep(ref) {
  const tasks = S.data?.tasks || [], i = ref.indexOf('/');
  if (i > 0) { const task = tasks.find(x => x.id === ref.slice(0, i)); return task && task.steps.some(s => s.id === ref) ? { task, sid: ref.slice(i + 1) } : null; }
  const has = x => x.steps.some(s => s.id === `${x.id}/${ref}`);
  const task = tasks.find(x => x.id === S.paintedTask && has(x)) || tasks.find(has);
  return task ? { task, sid: ref } : null;
}
/** Put a step's report on screen at the next paint: the Steps tab, the step expanded (and not folded away), scrolled to. */
function showStepReport(taskId, sid) { setCtxTab('steps'); S.open['sd-' + taskId + '/' + sid] = true; S.open['steps-all-' + taskId] = true; S.stepFocus = sid; }
/** Is a step's detail showing: the user's choice if they made one, else expanded while it is a fresh report. */
const stepIsOpen = s => S.open['sd-' + s.id] ?? LM.freshReport(s, S.data?.times?.[s.id], serverNow());
const go = hash => { if (location.hash !== hash) location.hash = hash; else render(); };

// ---------- left pane: the persistent list — a selector, not a navigation (FABLE-UI-REVIEW §B, P1 #5) ----------
const LEFT_FILTERS = ['live', 'paused', 'all'];
/** A task's state in two words, as the left list and the task header say it. */
function taskState(task) {
  if (task.status === 'closed') return 'closed';
  if (task.status === 'paused') return 'paused';
  if ((S.data.attention?.waiting || []).some(w => w.task_id === task.id && w.kind !== 'unreceived')) return 'owner';
  if ((S.data.messages || []).some(m => m.task_id === task.id && m.needs_receipt)) return 'receipt';
  if (task.health === 'red' || task.steps.some(s => s.state === 'blocked')) return 'blocked';
  if (task.steps.length && task.steps.every(s => s.state === 'done')) return 'done';
  return 'doing';
}
/** Tooltip of the "needs you" word: how many items wait on the owner, and that the task status is unchanged. */
function needsTip(task) {
  const n = (S.data.attention?.waiting || []).filter(w => w.task_id === task.id && w.kind !== 'unreceived').length;
  return n ? t(n === 1 ? 'left.needsTip.one' : 'left.needsTip.other', { n, status: t('status.' + task.status) }) : '';
}
const STATE_TONE = { owner: 'q', receipt: 'q', blocked: 'bad', done: 'ok', paused: 'grey', closed: 'grey', doing: '' };
const stepsDone = task => `${task.steps.filter(s => s.state === 'done').length}/${task.steps.length}`;
/** A moment on the Vietnam clock (UTC+7), the clock the server's override note prints ("… giờ VN"). */
const VN_MS = 7 * 3600000;
const vnDate = iso => { const ms = Date.parse(iso); return Number.isFinite(ms) ? new Date(ms + VN_MS) : null; };
const vnHM = iso => { const d = vnDate(iso); if (!d) return ''; const p = n => String(n).padStart(2, '0'); return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`; };
const vnDay = iso => { const d = vnDate(iso); if (!d) return ''; const p = n => String(n).padStart(2, '0'); return `${p(d.getUTCDate())}-${p(d.getUTCMonth() + 1)}`; };
/** "HH:MM" while the moment is still today on the VN clock, else "HH:MM dd-MM": a next-day expiry must not read as today. */
const vnWhen = (iso, nowMs = serverNow()) => { const d = vnDate(iso), n = new Date(nowMs + VN_MS); if (!d) return ''; return d.getUTCDate() === n.getUTCDate() && d.getUTCMonth() === n.getUTCMonth() && d.getUTCFullYear() === n.getUTCFullYear() ? vnHM(iso) : `${vnHM(iso)} ${vnDay(iso)}`; };
/** The task's CoS allowance while it still holds: null when there is none, it was cleared, or it has expired.
 *  The server derives `expired` on every read; the page only decides whether to draw the badge. */
const activeOverride = taskId => { const o = S.data?.route_override?.[taskId]; return o && !o.expired ? o : null; };
/** The badge on the task header (full text) and, compact, on the left-list row: a full chip there squeezes the title
 *  to one letter at 1204 px. Both carry the whole text and the reason as tooltip and aria-label. */
function overrideBadge(task, compact = false) {
  const o = activeOverride(task.id);
  if (!o) return '';
  const full = t('override.badge', { time: vnWhen(o.expires) }), title = o.reason ? `${full} · ${o.reason}` : full;
  if (compact) return `<span class="chip info ovr ovr-c" data-override="${esc(o.model)}" role="img" aria-label="${esc(title)}" title="${esc(title)}">${esc(String(o.model || 'sonnet').slice(0, 1).toUpperCase())}</span>`;
  return `<span class="chip info ovr" data-override="${esc(o.model)}" title="${esc(title)}">${esc(full)}</span>`;
}
/** "4/6 steps done"; a one-step task reads "1/1 step done" (the locale's `.one` key — English has no other plural rule). */
function headSteps(task) {
  const total = task.steps.length, done = task.steps.filter(s => s.state === 'done').length;
  const key = total === 1 ? 'head.steps.one' : 'head.steps.other';
  return t(key, { n: `${done}/${total}` });
}
/** 43h · 3d · 25m: the wait on a left row. */
const shortDur = ms => (ms >= 172800000 ? Math.floor(ms / 86400000) + 'd' : ms >= 3600000 ? Math.floor(ms / 3600000) + 'h' : Math.max(1, Math.round(ms / 60000)) + 'm');
/** Where a "Chờ bạn" item opens: its task, with the composer scoped to the ask (or that unacknowledged answer shown). */
const askHref = w => `#/task/${encodeURIComponent(w.task_id)}${w.kind === 'ask' ? '?ask=' + encodeURIComponent(w.id) : w.kind === 'unreceived' ? '?msg=' + encodeURIComponent(w.id) : ''}`;
function renderRail() {
  const d = S.data, r = route(), here = r.view === 'task' ? r.id : '';
  const nav = (hash, label, active, extra = '') => `<button class="nav-item" data-go="${esc(hash)}" ${active ? 'aria-current="page"' : ''}><span class="label">${label}</span>${extra}</button>`;
  const waiting = d.attention?.waiting || [];
  let h = nav('#/home', esc(t('nav.home')), ['home', 'overview', 'summary'].includes(r.view), waiting.length ? `<span class="badge q">${waiting.length}</span>` : '');
  if (canReadTurns()) h += nav('#/reports', esc(t('nav.reports')), r.view === 'reports');
  if (d.me) h += nav('#/quota', esc(t('nav.quota')), r.view === 'quota');
  if (d.me) { // secondary pages behind one "…" entry; Hộp thư only when it holds something
    const openInbox = (d.inbox || []).filter(i => !i.resolution).length, sec = ['registry', 'library', 'activity', 'new', 'inbox'];
    const items = nav('#/registry', esc(t('nav.registry')), r.view === 'registry') + nav('#/library', esc(t('nav.library')), r.view === 'library')
      + (role() !== 'reporter' ? nav('#/activity', esc(t('nav.activity')), r.view === 'activity') : '') + (isOwner() ? nav('#/new', esc(t('nav.newTask')), r.view === 'new') : '')
      + ((d.inbox || []).length ? nav('#/inbox', esc(t('nav.inbox')), r.view === 'inbox', openInbox ? `<span class="badge">${openInbox}</span>` : '') : '');
    h += `<details class="more-nav" data-open="more" ${S.open.more || sec.includes(r.view) ? 'open' : ''}><summary class="nav-item"><span class="label">${esc(t('nav.more'))}</span><span class="caret" aria-hidden="true">…</span></summary>${items}</details>`;
  }
  // CẦN ANH: what waits on the owner, longest wait first; a row opens the task scoped to that ask.
  if (d.me && waiting.length) {
    const need = LM.needRows(waiting); // one row per task: its oldest ask, with a ×N count when more wait
    h += `<div class="lane-h need-h">${esc(t('left.need'))} <span class="badge q">${need.length}</span></div>` + need.map(w => {
      const task = d.tasks.find(x => x.id === w.task_id);
      return `<a class="lrow need ${here === w.task_id ? 'here' : ''}" href="${esc(askHref(w))}" title="${esc(w.items.map(x => `${x.task_id} · ${x.text}`).join(' | '))}"><span class="tid">${esc(w.task_id)}</span><span class="wait ${waitTone(w.age_ms)}">${esc(shortDur(w.age_ms))}</span><span class="ttl">${esc(w.kind === 'unreceived' ? t('left.unreceived') : task?.title || w.text)}</span>${w.count > 1 ? `<span class="n-asks">×${w.count}</span>` : ''}</a>`;
    }).join('');
  }
  // Tasks by lane: one row each — dot, code, title, done/total, the state in two words, ⏱ when stalled, ✎ with a draft.
  const f = LEFT_FILTERS.includes(S.leftFilter) ? S.leftFilter : 'live', q = String(S.leftQuery || '').toLowerCase();
  const pass = x => (f === 'all' || (f === 'paused' ? x.status === 'paused' : !['paused', 'closed'].includes(x.status))) && (!q || `${x.id} ${x.title} ${x.lane || ''}`.toLowerCase().includes(q));
  const stalled = new Map((d.stalled || []).map(s => [s.task_id, s.idle_ms]));
  const lanes = [];
  for (const task of d.tasks.filter(pass)) { let l = lanes.find(x => x.lane === (task.lane || '')); if (!l) lanes.push(l = { lane: task.lane || '', tasks: [] }); l.tasks.push(task); }
  const row = task => {
    const st = taskState(task), idle = stalled.get(task.id), n = d.me ? openOwnerFeedback(task.id).length : 0;
    // For the owner the state word is a button: a popover sets the task status (same five as the task header).
    const word = st === 'doing' ? '' : `<span class="st ${STATE_TONE[st]}"${st === 'owner' ? ` title="${esc(needsTip(task))}"` : ''}>${esc(t('left.state.' + st))}</span>`;
    const stBtn = isOwner() ? `<button type="button" class="st-btn" data-action="st-pop" data-task="${esc(task.id)}" aria-haspopup="menu" aria-expanded="${S.stPop === task.id}" title="${esc(t('task.statusLabel'))}: ${esc(t('status.' + task.status))}">${word || '<span class="st caret">▾</span>'}</button>` : word;
    const pop = isOwner() && S.stPop === task.id ? `<div class="st-pop" role="menu" aria-label="${esc(t('task.statusLabel'))}">${OWNER_STATUSES.map(x => `<button type="button" role="menuitemradio" aria-checked="${task.status === x}" data-action="set-status" data-task="${esc(task.id)}" data-status="${x}" data-rev="${task.rev}">${esc(t('status.' + x))}</button>`).join('')}</div>` : '';
    return `<div class="lrow task ${here === task.id ? 'here' : ''}"><a class="lmain" href="#/task/${esc(encodeURIComponent(task.id))}" ${here === task.id ? 'aria-current="page"' : ''} title="${esc(`${task.id} ${task.title}`)}">${healthDot(task.status === 'paused' ? 'grey' : task.health)}<span class="tid">${esc(task.id)}</span><span class="ttl">${esc(task.title)}</span>`
      + `<span class="lmeta">${hasDraft(task.id) ? `<span class="draft-mark" title="${esc(t('compose.draft'))}">✎</span>` : ''}${freshLabel(task) ? `<span class="idle" title="${esc(freshLabel(task))}">⚠</span>` : ''}${idle ? `<span class="idle" title="${esc(t('left.idle', { dur: fmtDur(idle) }))}">⏱${esc(shortDur(idle))}</span>` : ''}<span class="n">${esc(stepsDone(task))}</span></span></a>`
      + `<span class="lmeta">${stBtn}${overrideBadge(task, true)}${n ? `<span class="badge" title="${esc(t('rail.openFeedback', { n }))}">${n}</span>` : ''}</span>${pop}</div>`;
  };
  const chip = (k, label) => `<button type="button" class="chip-btn" data-action="left-filter" data-k="${k}" aria-pressed="${f === k}">${esc(label)}</button>`;
  const railOpen = !!S.open.rail; // 641–960 px: the task list folds behind one button
  h += `<button type="button" class="rail-toggle" data-action="rail" aria-expanded="${railOpen}">${esc(t('nav.tasks'))} <span class="badge">${d.tasks.filter(pass).length}</span><span class="caret">${railOpen ? '▾' : '▸'}</span></button><div class="rail-tasks ${railOpen ? 'open' : ''}">
    <div class="left-tools"><div class="tags">${chip('live', t('left.filter.live'))}${chip('paused', t('left.filter.paused'))}${chip('all', t('left.filter.all'))}</div>
    <input type="search" class="left-search" placeholder="${esc(t('left.search'))}" value="${esc(S.leftQuery || '')}" data-left-query="1" aria-label="${esc(t('left.search'))}"></div>
    ${lanes.length ? lanes.map(l => `<div class="lane-h">${esc(l.lane ? t('lane.name', { lane: l.lane }) : t('lane.none'))} <span class="muted">${l.tasks.length}</span></div>${l.tasks.map(row).join('')}`).join('') : `<p class="empty pad-s">${esc(t('left.none'))}</p>`}</div>`;
  const proxied = d.me?.via === 'proxy';
  h += railFoot(`<div class="who">${d.me ? `<b>${esc(d.me.name)}</b> · ${esc(t('role.' + d.me.role))}${d.me.lane ? ` · ${esc(d.me.lane)}` : ''}${proxied ? `<br><span class="muted">${esc(t('auth.viaProxy'))}</span>` : ''}` : esc(t('role.anonymous'))}</div>`,
    proxied ? '' : `<button class="btn" data-action="${d.me ? 'signout' : 'signin'}">${esc(t(d.me ? 'auth.signout' : 'auth.signin'))}</button>`);
  // The list keeps its scroll position when a selection or a refresh repaints it.
  const rail = $('#rail'), top = rail.scrollTop, bodyTop = $('#rail-body')?.scrollTop || 0;
  rail.innerHTML = railShell(h, waiting.length);
  rail.scrollTop = top; if ($('#rail-body')) $('#rail-body').scrollTop = bodyTop;
  placeStatusPop();
}
/** The status popover opens below its row, or above it when below would leave the window (a bottom row). */
function placeStatusPop() {
  const pop = document.querySelector('.st-pop');
  if (!pop) return;
  const r = pop.getBoundingClientRect();
  if (r.bottom > window.innerHeight - 4) pop.classList.add('up');
}
/** Brand row, then the rail body. On a phone the brand row is a top bar and the body a drawer behind its menu button
 *  (desktop: the button is hidden and the body lays out as part of the rail). `attn` badges the closed menu. */
function railShell(bodyHtml, attn = 0) {
  const open = !!S.open.menu;
  $('#rail').classList.toggle('menu-open', open);
  $('#rail').setAttribute('aria-label', t('nav.label'));
  const btn = `<button type="button" class="menu-btn" data-action="menu" aria-expanded="${open}" aria-controls="rail-body"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">${open ? '<path d="M18 6 6 18M6 6l12 12"/>' : '<path d="M4 6h16M4 12h16M4 18h16"/>'}</svg><span>${esc(t(open ? 'nav.menuClose' : 'nav.menu'))}</span>${attn && !open ? `<span class="badge q">${attn}</span>` : ''}</button>`;
  // The square ZS mark (the favicon) and the tagline beside it — the owner's pick, no wordmark (01-10).
  // Embedded: the host shows the brand, so only the phone menu button stays in the row.
  const brand = isEmbed() ? '' : `<img class="brand-mark" src="brand/zumia-mark.svg" alt="Zumia" width="30" height="30"><span class="brand-sub">${esc(t('app.tagline'))}</span>`;
  return `<div class="brand">${brand}${sweepButton()}${btn}</div><div class="rail-body" id="rail-body">${bodyHtml}</div>`;
}
// ---------- "Cập nhật" (sweep): the owner asks the CoS to re-check every task's status ----------
// A feedback record of kind sweep on the whole-board target * (src/ops.mjs). Open until the CoS replies; the state lives on
// the server, so a reload, the 15 s poll and the app's Reload all show the same button.
const SWEEP_TEXT = 'Anh yêu cầu rà lại tình trạng các task'; // the message the CoS reads, not UI text
const sweepOf = () => (S.data?.feedback || []).filter(f => f.kind === 'sweep');
/** Idle button, "sent" chip while a sweep is open or being sent, nothing for a non-owner or a read-only preview. */
function sweepButton() {
  if (!isOwner() || readOnly()) return '';
  const all = sweepOf(), open = all.find(f => f.status === 'open');
  if (open) return `<span class="sweep"><button type="button" class="btn sweep-btn" disabled title="${esc(t('sweep.title'))}">${esc(t('sweep.open', { time: vnWhen(open.attribution.created_at) }))}</button></span>`;
  if (S.sweepBusy) return `<span class="sweep"><button type="button" class="btn sweep-btn" disabled title="${esc(t('sweep.title'))}">${esc(t('sweep.button'))}</button></span>`;
  const last = all.filter(f => f.status === 'resolved').map(f => f.resolved?.at || f.attribution.updated_at).sort().at(-1);
  return `<span class="sweep"><button type="button" class="btn sweep-btn" data-action="sweep" title="${esc(t('sweep.title'))}">${esc(t('sweep.button'))}</button>${last ? `<span class="sweep-last muted">${esc(t('sweep.last', { time: vnWhen(last) }))}</span>` : ''}</span>`;
}
async function sendSweep() {
  if (S.sweepBusy) return;
  S.sweepBusy = true; renderRail();
  try { if (await write('feedback.add', '*', { kind: 'sweep', text: SWEEP_TEXT })) toast(t('sweep.sentToast')); }
  finally { S.sweepBusy = false; }
  await refresh(); // a 409 sweep_open lands here too: the open chip shows
}
// Gear icon: Lucide "settings" (ISC licence).
const GEAR = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>';
/** Sidebar footer, Orca-style: who you are, then the settings gear bottom-left with the account button beside it. */
const LANG_SHORT = { en: 'EN', vi: 'VI', zh: '中文' };
function railFoot(whoHtml, accountBtn = '') {
  if (isEmbed()) return ''; // embedded: the host provides identity, language, settings and sign in/out
  const here = route().view === 'settings';
  // EN | VI | 中文: this browser's UI language (client side only — it works signed out and in a read-only preview).
  const langs = `<div class="lang-switch" role="radiogroup" aria-label="${esc(t('common.language'))}">${Object.keys(LANG_SHORT).map(l => `<button type="button" role="radio" aria-checked="${S.lang === l}" data-action="ui-lang" data-lang="${l}" lang="${l === 'zh' ? 'zh-CN' : l}" title="${esc(LANGS[l])}">${LANG_SHORT[l]}</button>`).join('')}</div>`;
  return `<div class="rail-foot">${whoHtml}${langs}<div class="foot-row">
    <button class="nav-item gear" data-go="#/settings" ${here ? 'aria-current="page"' : ''} title="${esc(t('settings.title'))}">${GEAR}<span class="label">${esc(t('settings.title'))}</span></button>${accountBtn}</div></div>`;
}

// ---------- owner attention + stalled ----------
function attentionRow(w, home = false, label = '') {
  const task = S.data.tasks.find(x => x.id === w.task_id);
  const kind = w.kind === 'step' ? t('attention.kind.step') : t(`attention.kind.${w.kind}`, { from: askedBy(w.from) });
  let actions = '';
  if (isOwner() && w.kind !== 'step' && w.kind !== 'unreceived') {
    // Options to pick; an ask without options can be approved or rejected outright (the answer box adds a reason).
    const verdicts = w.options.length ? '' : `<button class="btn primary" data-action="answer" data-kind="${w.kind}" data-id="${esc(w.id)}" data-rev="${w.rev}" data-task="${esc(w.task_id)}" data-verdict="approve">${esc(t('answer.approve'))}</button><button class="btn" data-action="answer" data-kind="${w.kind}" data-id="${esc(w.id)}" data-rev="${w.rev}" data-task="${esc(w.task_id)}" data-verdict="reject">${esc(t('answer.reject'))}</button>`;
    actions = `<div class="actions">${w.options.map(o => `<button class="btn option" data-action="answer" data-kind="${w.kind}" data-id="${esc(w.id)}" data-rev="${w.rev}" data-task="${esc(w.task_id)}" data-choice="${esc(o.key)}" ${o.desc ? `title="${esc(o.desc)}"` : ''}><b>${esc(o.key)}</b> ${esc(o.label)}</button>`).join('')}${verdicts}</div>
`;
  } else if (isLead() && w.kind === 'proposal') {
    actions = `<div class="actions"><button class="btn" data-action="merge" data-id="${esc(w.id)}" data-rev="${w.rev}" data-merge="accept">${esc(t('inbox.accept'))}</button><button class="btn" data-action="merge" data-id="${esc(w.id)}" data-rev="${w.rev}" data-merge="dismiss">${esc(t('inbox.dismiss'))}</button></div>`;
  } else if (isLead() && w.kind === 'ask') {
    actions = `<div class="actions"><button class="btn" data-action="clear" data-id="${esc(w.id)}" data-rev="${w.rev}">${esc(t('ask.clear'))}</button></div>`;
  }
  // Code chip + task title on one line (one link to the task page), the question (3 lines, then "show more"), a muted meta row, then the actions.
  // The link opens the task with the composer scoped to this ask (or this unacknowledged answer highlighted).
  const step = w.kind === 'step' && task?.steps.find(x => x.id === w.id);
  const href = askHref(w), open = !!S.open['md-ask-' + w.id], refs = step ? stepRefs(step) : refsOf(w.text);
  const sameAsLabel = !!label && refs.body.replace(/\s+/g, ' ').trim() === label; // an auto-step ask: the label already is the whole text
  // Inside a task group (Home) the head is the ask's own label: the task and its "now" line sit once on the group.
  const head = label ? `<a class="ask-head" href="${esc(href)}"><span class="ask-title">${esc(label)}</span></a>`
    : `<a class="ask-head" href="${esc(href)}"${task ? ` title="${esc(task.title)}"` : ''}><span class="code">${esc(w.task_id)}${w.step_id ? '/' + esc(w.step_id) : ''}</span>${task ? `<span class="ask-title">${esc(task.title)}</span>` : ''}</a>`;
  return `<div class="row ask">${head}
    ${sameAsLabel ? '' : `<div class="text md-line clamp3 ${open ? 'open' : ''}" data-clamp>${mdInline(refs.body, w.task_id)}</div><button type="button" class="more" data-action="more" data-key="ask-${esc(w.id)}" aria-expanded="${open}">${esc(t(open ? 'common.showLess' : 'common.showMore'))}</button>`}
    ${refsHtml(w.task_id, refs, 'ask-' + w.id)}
    ${home && !label && task?.now && w.kind !== 'unreceived' ? `<div class="sit md-line"><span class="muted">${esc(t('situation.now'))}:</span> ${mdInline(refsOf(task.now).body.split('\n')[0].slice(0, 240), task.id)}</div>` : ''}
    <div class="sub"><span>${esc(kind)}</span>${w.asked_back_at ? `<span class="sep"></span><span class="chip info">${esc(t('attention.askedBack'))}</span>` : ''}<span class="sep"></span><span class="${waitTone(w.age_ms)}">${esc(t('attention.age', { dur: fmtDur(w.age_ms) }))}</span>${task ? `<span class="sep"></span><a href="${esc(href)}">${esc(t('attention.openTask'))}</a>` : ''}</div>
    ${w.kind === 'proposal' && isOwner() ? `<div class="sub">${esc(t('attention.proposalHint'))}</div>` : ''}
    ${actions}</div>`;
}
/** Home's Needs-you: one block per task (measure.js needGroups). A task with one item shows it open; several fold behind
 *  the task row ("3 việc", the oldest wait), and a click opens one line per ask with its own label, age and actions. */
function needGroupHtml(g) {
  const task = S.data.tasks.find(x => x.id === g.task_id);
  const head = `<span class="code">${esc(g.task_id)}</span>${task ? `<span class="ask-title">${esc(task.title)}</span>` : ''}${g.count > 1 ? `<span class="badge q">${esc(t('home.nAsks', { n: g.count }))}</span>` : ''}<span class="need-age ${waitTone(g.age_ms)}">${esc(t('attention.age', { dur: fmtDur(g.age_ms) }))}</span>`;
  const sit = task?.now && g.items.some(w => w.kind !== 'unreceived') ? `<div class="sit md-line"><span class="muted">${esc(t('situation.now'))}:</span> ${mdInline(refsOf(task.now).body.split('\n')[0].slice(0, 240), task.id)}</div>` : '';
  const body = sit + g.items.map(w => attentionRow(w, true, w.label)).join('');
  if (g.count === 1) return `<div class="need-group"><a class="need-head" href="${esc(askHref(g.items[0]))}">${head}</a>${body}</div>`;
  const key = 'need-' + g.task_id;
  return `<details class="need-group" data-open="${esc(key)}" ${S.open[key] ? 'open' : ''}><summary class="need-head">${head}</summary>${body}</details>`;
}
/** Wait colour on the owner block: under a day plain, over a day amber, over three days red. */
const waitTone = ms => ms > 72 * 3600000 ? 'late' : ms > 24 * 3600000 ? 'warn' : '';
/** A clamped text whose content fits needs no "show more": hide those toggles once the page is laid out. */
function fitClamps() {
  for (const el of document.querySelectorAll('[data-clamp]:not(.open)')) el.nextElementSibling?.classList.toggle('hidden', !LR.clampOverflows(el.scrollHeight, el.clientHeight));
}
// ---------- board documents: summary + task registry (collapsible, remembers open/closed across refreshes) ----------
const REG_STATUS = ['open', 'doing', 'paused', 'closed'];

// ---------- task page ----------
function stepTime(task, step) {
  const tr = S.data.times?.[step.id];
  if (!tr) return '';
  const now = serverNow();
  if (step.state === 'active' && tr.started_at) return t('time.running', { dur: fmtDur(now - Date.parse(tr.started_at)) });
  if (step.state === 'waiting' && tr.waiting_since) {
    const ask = (S.data.asks || []).find(a => a.status === 'open' && a.task_id === task.id && a.step_id && `${task.id}/${a.step_id}` === step.id);
    const since = ask ? askSinceOf(ask) : tr.waiting_since; // the one age rule (measure.js rowWaitSince): a step an open ask sits on reads from the ask, not from its own older wait
    return t('time.waiting', { dur: fmtDur(now - Date.parse(since)) });
  }
  if (step.state === 'done' && tr.started_at && tr.done_at && !tr.untracked) return t('time.took', { dur: fmtDur(Date.parse(tr.done_at) - Date.parse(tr.started_at)) });
  return '';
}
function measured(task) {
  // Server timestamps either way; computed here when the view carries them (same code as the server: public/measure.js).
  const m = S.data.times ? LM.measuredTimes({ times: S.data.times, taskTimes: S.data.task_times || {}, steps: task.steps, taskId: task.id, nowMs: serverNow() }) : task.measured;
  if (!m) return '';
  return t('task.measuredValue', { work: fmtDur(m.work_ms), wait: fmtDur(m.wait_ms) || '0' });
}

// ---------- task statistics (derived data in <data>/stats.json): ONE document from /api/stats, read as-is; the page never recomputes it ----------
/** The right-pane tabs a task can show: steps, goal, plans, files, worker, and the statistics tab (signed-in readers only). */
const CTX_TABS = ['steps', 'diagram', 'goal', 'plans', 'files', 'worker', 'stats'];
/** Under this share of attributed tokens the numbers stay hidden behind the "đang đo" gate (the owner's rule, both surfaces). */
const STATS_GATE_PCT = 60;
const STATS_TTL_MS = 120000;
/** Read the statistics document once per TTL. A refused or failed read keeps whatever is on screen; null = nothing written yet. */
async function ensureStats() {
  if (!isLead()) return; // the server refuses /api/stats to a reporter (403): do not ask, and log no error
  if (S.statsAt && Date.now() - S.statsAt < STATS_TTL_MS) return;
  const s = await api('api/stats');
  if (!s || s.offline || s.unauthorized || s.failed) return;
  S.stats = s; S.statsAt = Date.now();
}
const statsReady = () => !!S.stats && typeof S.stats.attributed_pct === 'number';
const statsGated = () => !statsReady() || S.stats.attributed_pct < STATS_GATE_PCT;
/** Colour class of a model (CSS --m-*): the owner's route alias, else the neutral default. */
const modelClass = id => (/gemini/.test(id) ? 'gemini' : /sonnet/.test(id) ? 'sonnet' : /opus/.test(id) ? 'opus' : /deepseek/.test(id) ? 'deepseek' : /haiku/.test(id) ? 'haiku' : /gpt|luna/.test(id) ? 'gpt' : 'other');
/** Colour class of a role (CSS --r-*): a palette of its own, deliberately unlike the model colours. */
const roleClass = id => (['code', 'review', 'plan', 'scout'].includes(id) ? id : 'other');
const STATS_MODELS = ['sonnet', 'opus', 'deepseek', 'gemini'];
const STATS_ROLES = ['code', 'review', 'plan', 'scout'];
/** Tokens as millions with the locale's decimal mark (vi "64,7 tr" · en "64.7 tr"): the magnitudes the mockups show. */
const fmtMil = n => (typeof n === 'number' && isFinite(n) ? (Math.round(n / 1e5) / 10).toLocaleString(document.documentElement.lang, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : '');
const fmtPct = n => (typeof n === 'number' && isFinite(n) ? n.toLocaleString(document.documentElement.lang, { maximumFractionDigits: 1 }) : '');
/** A day-of-month date as DD/MM, the way the mockups show it (the document carries YYYY-MM-DD). */
const fmtDM = iso => { const s = String(iso || ''); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s.slice(8, 10)}/${s.slice(5, 7)}` : s; };
/** A duration as whole hours + zero-padded minutes ("91 giờ 04 phút"): the unit the mockup uses for the active headline. */
const fmtHours = ms => { const min = Math.round((ms || 0) / 60000); return t('stats.hm', { h: Math.floor(min / 60), m: String(min % 60).padStart(2, '0') }); };
/** A stacked split bar: one <i> per part, widths from part/total (flex-grow, never a precomputed %), coloured by class.
 *  The flex-grow rides on data-grow, not an inline style: the page's CSP (style-src 'self') forbids the style attribute,
 *  and applyStatsBars() sets it through the CSSOM once the markup is in the document. */
function stackBar(parts, cls) {
  const entries = Object.entries(parts || {}).filter(([, v]) => typeof v === 'number' && v > 0).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return '';
  return `<div class="st-sbars">${entries.map(([k, v]) => `<i class="${esc(cls(k))}" data-bar-grow="${v}"></i>`).join('')}</div>`;
}
const stackLegend = parts => Object.entries(parts || {}).filter(([, v]) => typeof v === 'number' && v > 0).map(([k, v]) => `${k} ${fmtMil(v)}`).join(' · ');
/** The sparkline (one line per unbroken run of days with a token figure, plus the last point). ONE unit only: tokens.
 *  A day with no token figure is a gap, never drawn from another unit (active_ms is shown in the per-day rows, not here). */
function sparkline(values) {
  const v = (values || []).map(x => (typeof x === 'number' && isFinite(x) ? x : null));
  if (v.filter(x => x !== null).length < 2) return '';
  const W = 300, H = 60, max = Math.max(...v.filter(x => x !== null), 1);
  const px = i => (i / (v.length - 1)) * W, py = n => H - 3 - (n / max) * (H - 10);
  const runs = []; let run = [];
  v.forEach((n, i) => { if (n === null) { if (run.length) runs.push(run); run = []; } else run.push([i, n]); });
  if (run.length) runs.push(run);
  const pts = r => r.map(([i, n]) => `${px(i).toFixed(1)},${py(n).toFixed(1)}`).join(' ');
  const line = runs.map(r => `<polyline points="${pts(r)}" fill="none" stroke="var(--focus)" stroke-width="1.8" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>`).join('');
  const last = v.map((n, i) => (n === null ? null : [i, n])).filter(Boolean).at(-1);
  const dot = last ? `<circle cx="${px(last[0]).toFixed(1)}" cy="${py(last[1]).toFixed(1)}" r="2.4" fill="var(--focus)"/>` : '';
  const area = runs.length === 1 ? `<path d="M${px(runs[0][0][0]).toFixed(1)},${H} L${pts(runs[0])} L${px(runs[0].at(-1)[0]).toFixed(1)},${H} Z" fill="url(#stats-g)"/>` : '';
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(t('stats.spark'))}"><defs><linearGradient id="stats-g" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="var(--focus)" stop-opacity=".28"/><stop offset="100%" stop-color="var(--focus)" stop-opacity="0"/></linearGradient></defs>${area}${line}${dot}</svg>`;
}
const modelLegend = () => `<div class="st-legend"><strong>${esc(t('stats.legendModel'))}</strong>${STATS_MODELS.map(m => `<span><i class="st-sw ${modelClass(m)}"></i>${esc(modelName(m))}</span>`).join('')}</div>`;
const roleLegend = () => `<div class="st-legend"><strong>${esc(t('stats.legendRole'))}</strong>${STATS_ROLES.map(r => `<span><i class="st-sw r-${roleClass(r)}"></i>${esc(t('worker.role.' + r))}</span>`).join('')}</div>`;
/** The "đang đo" gate (mockup 3): shown by both surfaces while fewer than STATS_GATE_PCT of tokens are attributed. */
function statsGateHtml(doc) {
  const pct = Math.max(0, Math.min(100, Number(doc?.attributed_pct) || 0));
  const skeleton = '<div class="st-sk"><span class="st-g a"></span><span class="st-g b"></span></div><div class="st-sk"><span class="st-g b"></span><span class="st-g c"></span></div>'.repeat(2);
  return `<div class="st-gate"><span class="st-tagline">${esc(t('stats.gateBadge'))}</span>
    <p class="st-big">${esc(t('stats.gateText', { pct: fmtPct(pct) }))}</p>
    <div class="st-meter" title="${esc(t('stats.gateThreshold'))}"><i data-bar-w="${pct}"></i><span class="st-mark" data-bar-left="${STATS_GATE_PCT}"></span></div>
    <p class="st-gate-hint">${esc(t('stats.gateHint'))}</p>
    <div class="st-skeleton" aria-hidden="true">${skeleton}</div></div>`;
}
/** The per-model chips of a ranked row: every model in by_model with its share; models under 1% fold into one "other"
 *  chip. A row from before by_model (or an empty split) shows its single dominant model, as before. */
function statsModelChips(r) {
  const chip = (id, label, pct, tokens) => `<span class="st-mchip ${modelClass(id)}" title="${esc(label)} · ${fmtMil(tokens)} ${esc(t('stats.mtok'))}"><i class="st-sw ${modelClass(id)}"></i>${esc(label)}${pct === null ? '' : ` ${fmtPct(pct)}%`}</span>`;
  const parts = (Array.isArray(r.by_model) ? r.by_model : []).filter(m => m && typeof m.model === 'string' && typeof m.share === 'number' && m.share > 0);
  if (!parts.length) return r.model ? `<div class="st-models">${chip(r.model, modelName(r.model), null, r.tokens)}</div>` : '';
  const big = parts.filter(m => m.share >= 1), small = parts.filter(m => m.share < 1);
  const chips = big.map(m => chip(m.model, modelName(m.model), m.share, m.tokens));
  if (small.length) chips.push(chip('other', t('stats.modelOther'), small.reduce((s, m) => s + m.share, 0), small.reduce((s, m) => s + (m.tokens || 0), 0)));
  return `<div class="st-models">${chips.join('')}</div>`;
}
/** One row of the "Token theo task" card: code + title, trend arrow, tokens, share bar, QC hint and warn chip. */
function statsTopRow(r) {
  const arrow = r.trend === 'up' ? '▲' : r.trend === 'down' ? '▼' : '→';
  const warn = typeof r.qc_fail === 'number' && r.qc_fail >= 2;
  return `<div class="st-row" data-model="${modelClass(r.model)}"><div class="st-top"><span class="st-code">${esc(r.code)}</span>${r.title ? `<span class="st-name" title="${esc(r.title)}">${esc(r.title)}</span>` : '<span class="st-name"></span>'}<span class="st-trend ${esc(r.trend || 'flat')}">${arrow}${typeof r.trend_pct === 'number' ? ` ${fmtPct(Math.abs(r.trend_pct))}%` : ''}</span><span class="st-amt">${fmtMil(r.tokens)} <small class="st-unit">${esc(t('stats.mtok'))}</small></span></div>
    <div class="st-bar"><i data-bar-w="${Math.max(0, Math.min(100, r.share_pct))}"></i></div>
    ${statsModelChips(r)}
    <div class="st-sub"><span class="st-pct">${esc(t('stats.sharePct', { pct: fmtPct(r.share_pct) }))}</span>${typeof r.qc_per_round === 'number' ? `<span class="st-qc">· ${esc(t('stats.qcPerRound', { n: fmtMil(r.qc_per_round) }))}</span>` : ''}${warn ? `<span class="chip warn">⚠ ${esc(t('stats.qcWarn', { n: r.qc_fail }))}</span>` : ''}</div></div>`;
}
/** The "Usage by model" card on Home: every model with usage in today / 7 days / all time, split into task, unattributed
 *  and lane-overhead tokens. NOT behind the 60% gate (that covers the per-task ranking only); the numbers are doc.models,
 *  built by the producer from the collector, never recomputed here. */
function statsModelsCard() {
  if (!S.data?.me || !statsReady() || !S.stats.models) return '';
  const win = ['today', 'w7', 'all'].includes(S.statMWin) ? S.statMWin : 'w7', list = S.stats.models[win] || [];
  const winLabel = { today: t('stats.win.today'), w7: t('stats.win.w7'), all: t('stats.win.all') };
  const seg = ['today', 'w7', 'all'].map(k => `<button type="button" role="tab" aria-checked="${win === k}" data-action="stats-mwin" data-win="${k}">${esc(winLabel[k])}</button>`).join('');
  const bucketCls = k => 'b-' + k;
  const rows = list.map(m => {
    const parts = { task: m.tasks, unattr: m.unattributed, lane: m.lane_overhead };
    const cells = [['task', t('stats.bucket.task'), m.tasks], ['unattr', t('stats.bucket.unattr'), m.unattributed], ['lane', t('stats.bucket.lane'), m.lane_overhead]].map(([k, label, v]) => `<span class="st-b ${k}">${esc(label)} <b>${fmtMil(v)}</b></span>`).join('');
    return `<div class="st-mrow" data-model="${modelClass(m.model)}"><div class="st-top"><span class="st-code"><i class="st-sw ${modelClass(m.model)}"></i>${esc(modelName(m.model))}</span><span class="st-name"></span><span class="st-amt">${fmtMil(m.tokens)} <small class="st-unit">${esc(t('stats.mtok'))}</small></span></div>${stackBar(parts, bucketCls)}<div class="st-sub">${cells}</div></div>`;
  }).join('');
  return `<section class="card st-card"><div class="st-head"><h2>${esc(t('stats.modelsTitle'))}</h2><span class="st-sub">${esc(t('stats.modelsSub'))}</span>
    <div class="segmented" role="tablist" aria-label="${esc(t('stats.window'))}">${seg}</div></div>
    ${rows ? `<div class="st-rows">${rows}</div>` : `<p class="empty">${esc(t('stats.noModels'))}</p>`}</section>`;
}
/** The board card on Home: the top tasks by tokens for the chosen window, or the gate while under 60%. */
function statsCard() {
  if (!S.data?.me) return ''; // signed-in readers only, the same gate as the task tab's Thống kê panel
  if (S.stats === undefined) return ''; // not read yet
  const gated = statsGated(), win = S.statWin === 'today' ? 'today' : 'w7', rows = gated ? [] : (S.stats.top?.[win] || []);
  const seg = ['w7', 'today'].map(k => `<button type="button" role="tab" aria-checked="${win === k}" data-action="stats-win" data-win="${k}"${gated ? ' disabled' : ''}>${esc(t(k === 'today' ? 'stats.win.today' : 'stats.win.w7'))}</button>`).join('');
  const body = gated ? statsGateHtml(S.stats)
    : rows.length ? `<div class="st-rows">${rows.map(statsTopRow).join('')}</div>`
      : `<p class="empty">${esc(t('stats.noRows'))}</p>`;
  return `<section class="card st-card"><div class="st-head"><h2>${esc(t('stats.cardTitle'))}</h2><span class="st-sub">${esc(t('stats.cardSub'))}</span>
    <div class="segmented" role="tablist" aria-label="${esc(t('stats.window'))}">${seg}</div></div>
    ${body}
    <div class="st-foot"><span>${esc(t(win === 'today' ? 'stats.unit.today' : 'stats.unit.w7'))}</span>${gated ? `<span>${esc(t('stats.gateMark'))}</span>` : modelLegend()}<span class="st-right">${esc(t('stats.trendTip'))}</span></div></section>`;
}
/** The "Thống kê" tab in a task: a 14-day sparkline on top, then one row per day (active, tokens by model, by role, QC). */
function statsPanel(task) {
  if (S.stats === undefined) return `<p class="empty">${esc(t('stats.loading'))}</p>`;
  if (!statsReady()) return `<p class="empty">${esc(t('stats.empty'))}</p>`;
  if (statsGated()) return `<section class="card st-card">${statsGateHtml(S.stats)}</section>`;
  const ts = S.stats.tasks?.[task.id];
  if (!ts) return `<p class="empty">${esc(t('stats.noneForTask'))}</p>`;
  const days = (ts.days || []).slice().reverse(); // newest first, as the mockup
  const totalTok = days.reduce((s, d) => s + (d.tokens || 0), 0), totalActive = days.reduce((s, d) => s + (d.active_ms || 0), 0);
  const spark = sparkline((ts.days || []).map(d => (typeof d.tokens === 'number' ? d.tokens : null))); // tokens only; a day with no token figure is a gap
  const head = `<div class="st-sp-head"><span class="st-big">${fmtMil(totalTok)}</span><span class="st-unit">${esc(t('stats.mtok'))}</span><span class="st-unit">· ${esc(t('stats.lastDays', { n: S.stats.window_days || 14 }))}</span>${totalActive ? `<span class="st-unit">· ${esc(t('stats.activeTotal', { dur: fmtHours(totalActive) }))}</span>` : ''}</div>`;
  const axis = days.length ? `<div class="st-axis"><span>${esc(fmtDM(days[days.length - 1].date))}</span><span>${esc(fmtDM(days[0].date))}</span></div>` : '';
  const rows = days.map(d => {
    const wd = (() => { try { return new Date(`${d.date}T00:00:00`).toLocaleDateString(document.documentElement.lang, { weekday: 'short' }); } catch { return ''; } })();
    const qc = d.qc || {};
    const cell = (parts, cls) => parts ? `<div class="st-cell">${stackBar(parts, cls)}<div class="st-cellval"><span class="st-tot">${fmtMil(d.tokens)}</span><span>${esc(stackLegend(parts))}</span></div></div>` : '<div class="st-cell"></div>';
    return `<div class="st-day"><div class="st-dayline"><span class="st-date">${esc(fmtDM(d.date))} <small>${esc(wd)}</small></span><span class="st-active">${d.active_ms ? esc(fmtDur(d.active_ms)) : '—'}</span></div>
      <div class="st-cells">${cell(d.by_model, modelClass)}${cell(d.by_role, k => `r-${roleClass(k)}`)}</div>
      <div class="st-qc">${qc.pass ? `<span class="chip ok">${esc(t('stats.qcPass', { n: qc.pass }))}</span>` : ''}${qc.fail ? `<span class="chip bad">${esc(t('stats.qcFail', { n: qc.fail }))}</span>` : ''}${!qc.pass && !qc.fail ? `<span class="chip none">${esc(t('stats.qcNone'))}</span>` : ''}</div></div>`;
  }).join('');
  return `<section class="card st-card"><div class="st-spark">${head}${spark}${axis}</div><p class="st-caveat">${esc(t('stats.caveatDaily'))}</p></section>
    <section class="card st-table"><div class="st-tbl-head"><span>${esc(t('stats.col.date'))}</span><span>${esc(t('stats.col.active'))}</span><span>${esc(t('stats.col.byModel'))}</span><span>${esc(t('stats.col.byRole'))}</span><span>${esc(t('stats.col.qc'))}</span></div>${rows || `<p class="empty">${esc(t('stats.noDays'))}</p>`}
    <div class="st-foot">${modelLegend()}${roleLegend()}<span class="st-right">${esc(t('stats.mtokNote'))}</span></div></section>`;
}
/** Set the width / flex-grow of the statistics bars through the CSSOM after the markup is painted. The page's CSP
 *  (style-src 'self') blocks an inline style attribute, but a direct property write on the element is allowed. */
function applyStatsBars(root) {
  if (!root) return;
  for (const el of root.querySelectorAll('[data-bar-w]')) el.style.width = `${el.dataset.barW}%`;
  for (const el of root.querySelectorAll('[data-bar-left]')) el.style.left = `${el.dataset.barLeft}%`;
  for (const el of root.querySelectorAll('[data-bar-grow]')) el.style.flexGrow = el.dataset.barGrow;
}
// ---------- home: the CẦN ANH queue, the coordinator's note, the workers (Tổng quan + Tóm tắt nhanh in one, P1 #9) ----------
/** The stored Home overview style: 'map' (the restored board overview, the default) or the compact 'list' once the
 *  viewer picks it. Per browser, wrapped by store's try/catch. */
const homeView = () => (store.get('homeView') === 'list' ? 'list' : 'map');
/** The old board's project map, restored: one box per task coloured by health, grouped by lane, plus the health counts
 *  and the owner-wait count. A box is a link to the task. The map/list choice is remembered in this browser only. */
function overviewCard(d) {
  const tasks = (d.tasks || []).filter(t => t.status !== 'closed');
  const waiting = d.attention?.waiting || [], waitSet = new Set(waiting.filter(w => w.kind !== 'unreceived').map(w => w.task_id));
  const c = DG.healthCounts(tasks, waiting.length), view = homeView();
  const seg = ['map', 'list'].map(k => `<button type="button" role="tab" aria-checked="${view === k}" data-action="home-view" data-view="${k}">${esc(t('diagram.view.' + k))}</button>`).join('');
  const counts = `<div class="diag-counts">${['green', 'yellow', 'red', 'grey'].map(h => `<span class="diag-count"><span class="dot ${h}" aria-hidden="true"></span><b>${c[h]}</b>${esc(t('health.' + h))}</span>`).join('')}<span class="diag-count wait"><b>${c.waiting}</b>${esc(t('diagram.waiting'))}</span></div>`;
  const box = task => {
    const h = DG.healthClass(task), live = task.steps.filter(s => DG.shortId(s.id) !== DG.HISTORY_ID);
    const done = live.filter(s => s.state === 'done').length, cur = task.current_step?.label || t('task.allDone');
    return `<a class="diag-task h-${h}" href="#/task/${encodeURIComponent(task.id)}"><span class="diag-task-top"><span class="dot ${h}" aria-hidden="true"></span><span class="code">${esc(task.id)}</span><span class="muted diag-task-count">${done}/${live.length}</span></span><span class="diag-task-title" title="${esc(task.title)}">${esc(task.title)}</span><span class="diag-task-now" title="${esc(cur)}">${esc(cur)}</span>${waitSet.has(task.id) ? `<span class="chip q">${esc(t('diagram.waitingOne'))}</span>` : ''}</a>`;
  };
  const row = task => {
    const h = DG.healthClass(task), cur = task.current_step?.label || t('task.allDone');
    return `<a class="diag-row" href="#/task/${encodeURIComponent(task.id)}"><span class="dot ${h}" aria-hidden="true"></span><span class="code">${esc(task.id)}</span><span class="diag-row-title" title="${esc(task.title)}">${esc(task.title)}</span><span class="diag-row-now muted" title="${esc(cur)}">${esc(cur)}</span>${waitSet.has(task.id) ? `<span class="chip q">${esc(t('diagram.waitingOne'))}</span>` : ''}</a>`;
  };
  const body = !tasks.length ? `<p class="empty">${esc(t('diagram.emptyMap'))}</p>`
    : view === 'map'
      ? `<div class="diag-map-scroll"><div class="diag-map">${DG.mapGroups(tasks).map(g => `<div class="diag-lane"><div class="diag-lane-head"><b>${esc(g.lane || t('diagram.noLane'))}</b><span class="muted">${g.tasks.length}</span></div><div class="diag-lane-body">${g.tasks.map(box).join('')}</div></div>`).join('')}</div></div>`
      : `<div class="diag-list">${tasks.map(row).join('')}</div>`;
  return `<section class="card diag-overview"><div class="diag-overview-head"><h2>${esc(t('diagram.overviewTitle'))}</h2><div class="segmented" role="tablist" aria-label="${esc(t('diagram.overviewView'))}">${seg}</div></div>${counts}${body}</section>`;
}
function renderHome() {
  const d = S.data;
  if (!d.me) return renderPublic();
  const a = d.attention, sum = d.docs?.summary, items = sum?.items || [];
  const head = `<div class="page-head"><h1>${esc(t('home.title'))} <span class="badge q">${a.waiting.length}</span></h1><span class="meta">${esc(t('overview.updated', { ago: fmtDur(Date.now() - S.loadedAt + 1000), seq: d.seq }))}</span></div>`;
  const queue = `<section class="card attention queue">${a.waiting.length ? `<div class="rows">${LM.needGroups(a.waiting, d.tasks).map(needGroupHtml).join('')}</div>` : `<p class="empty">${esc(t('attention.empty'))}</p>`}
    ${a.answered.length ? `<h2 class="mt">${esc(t('home.answered'))}</h2><div class="rows">${a.answered.map(answeredRow).join('')}</div>` : ''}</section>`;
  const edit = isLead() ? `<details data-open="sum-edit" ${S.open['sum-edit'] ? 'open' : ''}><summary class="muted">${esc(t('docs.edit'))}</summary><form data-form="summary" data-rev="${sum?.rev || 0}"><textarea name="text" rows="6" data-draft="summary">${esc(S.drafts.summary ?? items.join('\n'))}</textarea><div class="sub muted">${esc(t('docs.summaryHint'))}</div><div class="actions"><button class="btn primary">${esc(t('docs.save'))}</button></div></form></details>` : '';
  const notes = `<section class="card"><h2>${esc(t('summary.notes'))}${sum ? ` <span class="muted">· ${esc(fmtTime(sum.attribution.updated_at))}</span>` : ''}</h2>${items.length ? `<ul class="doc-list">${items.map(i => `<li class="md-line">${mdInline(i, '')}</li>`).join('')}</ul>` : `<p class="empty">${esc(t('docs.summaryEmpty'))}</p>`}${edit}</section>`;
  return head + `<div class="stack">${queue}${overviewCard(d)}${notes}${statsModelsCard()}${statsCard()}${workersTable()}</div>`;
}
/** One owner answer on Home's "answered" list: its task, the answer, and whether the coordinator has received it. */
function answeredRow(x) {
  const state = x.received_at ? t('attention.receivedNext', { next: x.next || '—' }) : x.handled_at ? t('attention.handled') : t('attention.answeredWait');
  return `<div class="row"><a class="code" href="#/task/${encodeURIComponent(x.task_id)}${x.feedback_id ? '?msg=' + encodeURIComponent(x.feedback_id) : ''}">${esc(x.task_id)}</a><div><div class="text muted">${esc(x.text)}</div><div class="sub"><span class="chip ${x.received_at ? 'ok' : 'q'}">${esc(x.choice || (x.kind ? t('feedback.kind.' + x.kind) : '✓'))}</span>${esc(state)}</div></div></div>`;
}
/** Signed out: the tasks marked public, one row each. */
function renderPublic() {
  const d = S.data;
  return `<div class="page-head"><h1>${esc(t('tasks.title'))}</h1></div><section class="card">${d.tasks.length ? `<div class="rows">${d.tasks.map(x => `<a class="row link" href="#/task/${encodeURIComponent(x.id)}"><span class="code">${esc(x.id)}</span><div><div class="text"><b>${esc(x.title)}</b></div>${x.now ? `<div class="sub md-line">${mdInline(x.now, x.id)}</div>` : ''}</div></a>`).join('')}</div>` : `<p class="empty">${esc(t('tasks.empty'))}</p>`}</section>`;
}
/** "Thợ theo task": model and effort as selects for the owner; a change is written at once (routing.set). */
const EFFORTS = ['low', 'medium', 'high', 'xhigh'];
const GEMINI_EFFORTS = ['low', 'medium', 'high']; // mirrors src/roles.mjs: agy rejects xhigh/max
const GEMINI_DEFAULT_EFFORT = { 'gemini-3.8-flash': 'medium', 'gemini-4-argon': 'high' };
const effortsFor = (model, cur) => /^gemini-/.test(model) ? GEMINI_EFFORTS : [...new Set([...EFFORTS, cur])].filter(Boolean);
const fixEffort = (model, effort) => /^gemini-/.test(model) && !GEMINI_EFFORTS.includes(effort) ? (GEMINI_DEFAULT_EFFORT[model] || 'high') : effort;
const workerText = w => `${modelName(w.model)} · ${w.effort}`;
function workerSelects(task) {
  const w = task.worker || {}, def = task.worker_default;
  const models = [...new Set([w.model, def?.model, ...(S.data.config.models || [])].filter(Boolean))];
  const efforts = effortsFor(w.model, w.effort);
  return `<select data-route="${esc(task.id)}" data-field="model" aria-label="${esc(t('worker.model'))}">${models.map(m => `<option value="${esc(m)}" ${w.model === m ? 'selected' : ''}>${esc(modelName(m))}</option>`).join('')}</select>`
    + `<select data-route="${esc(task.id)}" data-field="effort" aria-label="${esc(t('worker.effort'))}">${efforts.map(e => `<option ${w.effort === e ? 'selected' : ''}>${esc(e)}</option>`).join('')}</select>`;
}
/** The four role slots of a task (ADR 2026-10-09). code goes through routing.set, the others through roles.set; either way the owner's pick is binding (by = owner). */
const ROLE_SLOTS = ['plan', 'code', 'review', 'scout'];
const SLOT_MODELS = ['opus', 'sonnet', 'deepseek', 'haiku', 'gemini-3.8-flash', 'gemini-4-argon'];
function slotCell(task, role, own) {
  const s = task.roles?.[role] || (role === 'code' ? task.worker : null);
  if (!s) return '<td></td>';
  const tag = role === 'code' ? `data-route="${esc(task.id)}"` : `data-role-slot="${esc(task.id)}" data-role="${role}"`;
  const models = [...new Set([...SLOT_MODELS, s.model])], efforts = effortsFor(s.model, s.effort);
  const hint = [s.reason, s.note, role === 'scout' ? t('worker.scoutNoVerdict') : '', s.adjusted_from ? t('worker.reviewAdjusted', { from: workerText(s.adjusted_from) }) : ''].filter(Boolean).join(' · ');
  const sel = own
    ? `<span class="wk-sel"><select ${tag} data-field="model" aria-label="${esc(t('worker.role.' + role))} · ${esc(t('worker.model'))}">${models.map(m => `<option value="${esc(m)}" ${s.model === m ? 'selected' : ''}>${esc(modelName(m))}</option>`).join('')}</select>`
      + `<select ${tag} data-field="effort" aria-label="${esc(t('worker.role.' + role))} · ${esc(t('worker.effort'))}">${efforts.map(e => `<option ${s.effort === e ? 'selected' : ''}>${esc(e)}</option>`).join('')}</select></span>`
    : esc(workerText(s));
  return `<td class="wk-slot" data-role-box="${role}"${hint ? ` title="${esc(hint)}"` : ''}>${sel} <span class="chip ${s.by === 'owner' ? 'info' : s.by === 'auto' ? 'warn' : ''}">${esc(t('worker.by.' + s.by))}</span>${s.conflict ? ` <span class="chip warn">${esc(t('worker.reviewConflict'))}</span>` : ''}</td>`;
}
/** "Workers by task": one row per task, four chips (plan / code / review / scout). A chip opens a small popover with the model and
 *  effort selects (owner only); the selects carry the same data-route / data-role-slot attributes as before, so a change is written
 *  by the existing handler (routing.set for code, roles.set for the rest; by = owner). Provenance is a marker, not text:
 *  a solid dot = the owner chose it, "auto" = escalated, nothing = default / coordinator. A chip equal to the default is dimmed. */
const ROLE_DEFAULTS = { plan: { model: 'opus', effort: 'high' }, code: { model: 'sonnet', effort: 'high' }, review: { model: 'opus', effort: 'high' }, scout: { model: 'haiku', effort: 'low' } }; // mirrors src/roles.mjs DEFAULTS
const REVIEW_MODELS = ['opus', 'sonnet', 'fable', 'deepseek', 'gemini-4-argon']; // review never offers haiku: the scout does not rule pass/fail (the server refuses it too)
const MODEL_SHORT = { opus: 'Opus', sonnet: 'Sonnet', deepseek: 'DeepSeek', haiku: 'Haiku', fable: 'Fable', gpt: 'GPT', gemini: 'Gemini', 'gemini-3.8-flash': 'Gemini 3.8 Flash', 'gemini-4-argon': 'Gemini 4 Argon' };
const shortModel = id => MODEL_SHORT[id] || String(id).charAt(0).toUpperCase() + String(id).slice(1);
const chipText = s => `${shortModel(s.model)} · ${s.effort}`;
function wkChip(task, role, own) {
  const s = task.roles?.[role] || (role === 'code' ? task.worker : null);
  if (!s) return `<div class="wk-cell"><span class="wk-lab">${esc(t('worker.role.' + role))}</span></div>`;
  const key = `${task.id}:${role}`, open = own && S.wkPop === key, def = ROLE_DEFAULTS[role];
  const same = !!def && s.model === def.model && s.effort === def.effort;
  const prov = s.by === 'owner' ? 'owner' : s.by === 'auto' ? 'auto' : 'coordinator';
  const tip = [`${t('worker.role.' + role)}: ${workerText(s)}`, t('worker.by.' + prov), s.reason, s.note, role === 'scout' ? t('worker.scoutNoVerdict') : '', s.adjusted_from ? t('worker.reviewAdjusted', { from: workerText(s.adjusted_from) }) : ''].filter(Boolean).join(' — ');
  const mark = prov === 'owner' ? '<i class="wk-dot" aria-hidden="true"></i>' : prov === 'auto' ? `<b class="wk-auto">${esc(t('worker.autoTag'))}</b>` : '';
  const body = `${mark}<span class="wk-txt">${esc(chipText(s))}</span>`;
  const warn = s.conflict ? `<span class="wk-warn" role="img" tabindex="0" title="${esc(t('worker.reviewConflictTip'))}" aria-label="${esc(t('worker.reviewConflictTip'))}">!</span>` : '';
  const tag = role === 'code' ? `data-route="${esc(task.id)}"` : `data-role-slot="${esc(task.id)}" data-role="${role}"`;
  const models = role === 'review' ? [...new Set([...REVIEW_MODELS, ...(s.model === 'haiku' ? [] : [s.model])])] : [...new Set([...SLOT_MODELS, s.model])], efforts = effortsFor(s.model, s.effort);
  const pop = open ? `<div class="wk-pop" role="dialog" aria-label="${esc(t('worker.role.' + role))}"><label><span>${esc(t('worker.model'))}</span><select ${tag} data-field="model">${models.map(m => `<option value="${esc(m)}" ${s.model === m ? 'selected' : ''}>${esc(modelName(m))}</option>`).join('')}</select></label>`
    + `<label><span>${esc(t('worker.effort'))}</span><select ${tag} data-field="effort">${efforts.map(e => `<option ${s.effort === e ? 'selected' : ''}>${esc(e)}</option>`).join('')}</select></label></div>` : '';
  const cls = `wk-chip${same ? ' dim' : ''}${own ? '' : ' ro'}`;
  const chip = own ? `<button type="button" class="${cls}" data-action="wk-pop" data-key="${esc(key)}" aria-haspopup="dialog" aria-expanded="${open}" title="${esc(tip)}">${body}</button>` : `<span class="${cls}" title="${esc(tip)}">${body}</span>`;
  return `<div class="wk-cell" data-role-box="${role}"><span class="wk-lab">${esc(t('worker.role.' + role))}</span>${chip}${warn}${pop}</div>`;
}
// Ported from the Zumi desktop app (its local patch on 760501b, T-31 role-ui-port step 3, 10-10).
// A worker popover opens below its chip; when the window has no room for it below but has room above (the last row on
// a short window), it opens upward instead.
function placeWkPop() {
  const pop = document.querySelector('.wk-pop');
  if (!pop) return;
  const box = pop.getBoundingClientRect(), cell = pop.parentElement.getBoundingClientRect();
  if (box.bottom > window.innerHeight && cell.top - box.height - 4 >= 0) pop.classList.add('up');
}
function workersTable() {
  const workers = S.data.tasks.filter(liveTask).filter(x => x.roles);
  if (!workers.length) return '';
  const own = isOwner();
  const defCells = ROLE_SLOTS.map(r => `<div class="wk-cell"><span class="wk-lab">${esc(t('worker.role.' + r))}</span><span class="wk-chip ro">${esc(chipText(ROLE_DEFAULTS[r]))}</span></div>`).join('');
  const rows = workers.map(x => `<div class="wk-trow" data-route-box="${esc(x.id)}"><a class="wk-code code" href="#/task/${encodeURIComponent(x.id)}" data-worker-open="${esc(x.id)}" title="${esc(x.id)}">${esc(x.id)}</a><div class="wk-chips">${ROLE_SLOTS.map(r => wkChip(x, r, own)).join('')}</div></div>${S.errors['routing:' + x.id] ? `<div class="wk-err">${violationsBox('routing:' + x.id)}</div>` : ''}`).join('');
  return `<section class="card"><h2>${esc(t('summary.workers'))}</h2><div class="wk-grid"><div class="wk-trow wk-head" aria-hidden="true"><span class="wk-code">${esc(t('worker.task'))}</span><div class="wk-chips">${ROLE_SLOTS.map(r => `<span>${esc(t('worker.role.' + r))}</span>`).join('')}</div></div>`
    + `<div class="wk-trow wk-defaults"><span class="wk-code" title="${esc(t('worker.defaultsTip'))}">${esc(t('worker.defaults'))}</span><div class="wk-chips">${defCells}</div></div>${rows}</div></section>`;
}

// ---------- task view: center = header + Tình hình + stream + composer, right = context tabs (P1 #6, #7) ----------
const STEP_ICON = { done: '✓', active: '●', waiting: '◐', blocked: '✕', todo: '○' };
function renderTask(id) {
  const d = S.data, task = d.tasks.find(x => x.id === id);
  if (!task) return `<p class="empty pad">${esc(t('task.notFound'))}</p>`;
  S.curTask = task.id;
  const st = taskState(task), w = task.worker;
  const head = `<header class="tv-head"><div class="tv-ids"><span class="code">${esc(task.id)}</span>${healthDot(task.status === 'paused' ? 'grey' : task.health)}<span class="st ${STATE_TONE[st]}"${st === 'owner' ? ` title="${esc(needsTip(task))}"` : ''}>${esc(t('left.state.' + st))}</span>${isOwner() ? headStatusSelect(task) : ''}${task.lane ? `<span class="muted">${esc(t('lane.name', { lane: task.lane }))}</span>` : ''}<span class="muted">${esc(headSteps(task))}</span>${w ? `<button type="button" class="linkish muted" data-action="ctx-tab" data-tab="worker">${esc(workerText(w))}</button>` : ''}${overrideBadge(task)}${staleBadge(task)}</div><h1>${esc(task.title)}</h1>${isOwner() ? violationsBox('task:' + task.id) : ''}</header>`;
  const center = `<section class="center">${head}${situationCard(task)}${d.me ? `<div class="stream-scroll" id="stream-scroll" aria-label="${esc(t('stream.title'))}">${streamEntries(task)}</div>` : ''}${isLead() ? composer(task) : ''}</section>`;
  return `<div class="tv">${center}<aside class="ctx" id="ctx">${ctxTabs(task)}</aside></div>`;
}
/** Tình hình: the six lines the owner reads first. Long lines are cut to two; one toggle opens them. A long "Hiện tại"
 *  line (C6) keeps a two-line preview and adds a read button that opens the reader instead of hiding the rest. */
function situationCard(task) {
  const d = S.data, open = !!S.open['md-sit-' + task.id];
  const receipt = msgsOf(task.id).filter(m => m.receipt).at(-1);
  // A line's images and links sit on their own row under it, outside the two-line fold, so they always show.
  const refRow = (r, nav) => { const h = refsHtml(task.id, r, nav); return h ? `<dd class="refs-row">${h}</dd>` : ''; };
  const line = (k, v, cls = '', nav = '') => { const r = refsOf(v ? String(v) : ''); return `<dt>${esc(t(k))}</dt><dd class="md-line ${cls}">${v ? mdInline(nav ? r.body : String(v), task.id) : '—'}</dd>${nav ? refRow(r, nav) : ''}`; };
  const nowLine = () => { // "Hiện tại": three lines, then its own Xem thêm / Thu gọn; a long one also gets the read button (outside the clamp)
    const refs = refsOf(task.now || ''), long = isLongText(task.now || ''), nowOpen = !!S.open['md-now-' + task.id];
    const btn = long ? `<dd class="now-open"><button type="button" class="btn read-open" data-action="read" data-kind="now" data-task="${esc(task.id)}" data-ref="${esc(task.id)}" aria-haspopup="dialog"><span>${esc(t('step.readFull'))}</span><span class="muted">${esc(t('step.readMins', { n: readMins(task.now) }))}</span></button></dd>` : '';
    const toggle = task.now ? `<dd class="now-more"><button type="button" class="more" data-action="more" data-key="now-${esc(task.id)}" aria-expanded="${nowOpen}">${esc(t(nowOpen ? 'common.showLess' : 'common.showMore'))}</button></dd>` : '';
    return `<dt>${esc(t('situation.now'))}</dt><dd class="md-line now-line clamp3 ${nowOpen ? 'open' : ''}" data-clamp>${task.now ? mdInline(refs.body, task.id) : '—'}</dd>${toggle}${refRow(refs, 'now-' + task.id)}${btn}`;
  };
  const textAt = task.text_at || task.last_activity_at, upd = textAt ? `${fmtTime(textAt)} · ${t('common.ago', { dur: ago(textAt) })}` : '';
  // "Cần anh": the row header keeps the count and the oldest wait; the questions themselves are one card each below
  // (askCards), so a row with eight asks no longer merges their files into this line.
  // Folded: Bước, Hiện tại, Cần anh (two lines each). Opened: all six, in full. The stream keeps the room.
  const more = open ? `${line('situation.next', task.next, '', 'next-' + task.id)}${line('situation.milestone', receipt?.receipt?.schedule || '')}${line('situation.updated', upd)}` : '';
  return `<section class="situation ${open ? 'open' : ''}" id="situation">${freshLabel(task) ? `<p class="fresh">${freshBadge(task)}</p>` : ''}<dl class="kv">${line('situation.step', currentStepText(task))}${nowLine()}${d.me ? `<dt class="needs">${esc(t('situation.needs'))}</dt><dd class="needs">${esc(needsOwnerLine(task))}</dd>` : ''}${more}</dl>
    ${d.me ? askCards(task) : ''}
    <button type="button" class="more" data-action="more" data-key="sit-${esc(task.id)}" aria-expanded="${open}">${esc(t(open ? 'common.showLess' : 'common.showMore'))}</button></section>`;
}
function ctxTabs(task) {
  const d = S.data, TABS = d.me ? ['steps', 'diagram', 'goal', 'plans', 'files', 'worker', 'stats'] : ['steps', 'diagram', 'files'];
  const tab = TABS.includes(S.ctxTab) ? S.ctxTab : 'steps';
  const count = { steps: stepsDone(task), plans: (d.plans?.[task.id] || []).length || '', files: (d.attachments || []).filter(a => a.task_id === task.id).length || '' };
  const bar = `<div class="tabs" role="tablist" aria-label="${esc(t('ctx.label'))}">${TABS.map(k => `<button type="button" role="tab" class="tab" aria-selected="${k === tab}" data-action="ctx-tab" data-tab="${k}">${esc(t('ctx.tab.' + k))}${count[k] ? ` <span class="muted">${esc(count[k])}</span>` : ''}${k === 'goal' && !goalOf(task.id) && d.me ? ' <span class="dot yellow" aria-hidden="true"></span>' : ''}</button>`).join('')}</div>`;
  const panel = tab === 'diagram' ? diagramPanel(task) : tab === 'goal' ? goalPanel(task) : tab === 'plans' ? plansCard(task) : tab === 'files' ? filesPanel(task) : tab === 'worker' ? workerPanel(task) : tab === 'stats' ? statsPanel(task) : stepsPanel(task);
  return bar + `<div class="tabpanel" role="tabpanel">${panel}</div>`;
}
/** Bước: a compact list (≤28 px a row), state as an icon; the state select shows only on a hovered/focused row. */
function stepsPanel(task) {
  const d = S.data, cur = task.current_step?.id;
  const openAskOn = s => (d.asks || []).find(a => a.task_id === task.id && a.status === 'open' && a.step_id === s.id.split('/')[1]);
  const options = s => {
    if (!s.options?.length) return '';
    const ask = openAskOn(s), can = isOwner(); // as on the predecessor board: a done step's options can be picked again
    return `<div class="opts">${s.options.map(o => `<div class="opt"><span class="muted">${esc(t('step.option', { key: o.key }))}</span><b>${esc(o.label)}</b>${o.desc ? `<p class="md-line">${mdInline(o.desc, task.id)}</p>` : ''}
      ${can ? `<button class="btn primary" data-action="pick" data-step="${esc(s.id)}" data-choice="${esc(o.key)}" data-label="${esc(o.label)}" ${ask ? `data-ask="${esc(ask.id)}" data-rev="${ask.rev}"` : ''}>${esc(t('step.pick', { key: o.key }))}</button>` : ''}</div>`).join('')}</div>`;
  };
  const stateSel = s => `<select class="state-select ${esc(s.state)}" data-step-state="${esc(s.id)}" data-rev="${s.rev}" aria-label="${esc(t('step.stateLabel', { step: s.label }))}">${STEP_STATES.map(x => `<option value="${x}" ${s.state === x ? 'selected' : ''}>${esc(t('state.' + x))}</option>`).join('')}</select>`;
  const order = stepsByRecency(task), all = !!S.open['steps-all-' + task.id];
  const shownN = Math.max(STEPS_SHOWN, order.filter(x => x.pin < 3).length), shown = all ? order : order.slice(0, shownN);
  const done = task.steps.filter(s => s.state === 'done').length, waitOwner = task.steps.filter(s => s.state === 'waiting' && s.zone === 'owner').length;
  const head = `<div class="steps-head"><span>${esc(t('steps.count', { done, total: task.steps.length }))}</span>${waitOwner ? `<span class="chip q">${esc(t('steps.waitingOwner', { n: waitOwner }))}</span>` : ''}</div>`;
  const toggle = order.length > shownN ? `<button type="button" class="more" data-action="steps-all" data-task="${esc(task.id)}" aria-expanded="${all}">${esc(all ? t('common.showLess') : t('steps.older', { n: order.length - shownN }))}</button>` : '';
  const rows = shown.map(({ s, i }) => {
    const sid = s.id.split('/')[1], open = stepIsOpen(s);
    return `<div class="srow ${esc(s.state)} ${s.id === cur ? 'cur' : ''} ${open ? 'open' : ''}" id="step-${esc(sid)}"><button type="button" class="srow-main" data-action="step-open" data-step="${esc(s.id)}" aria-expanded="${open}" title="${esc(s.label)}"><span class="si" aria-hidden="true">${STEP_ICON[s.state] || '○'}</span><span class="sn">${i + 1}</span><span class="sl">${esc(s.label)}</span>${String(s.detail || '').trim() ? `<span class="srep">📄 ${esc(t('step.report'))}</span>` : ''}<span class="sr">${esc(t('state.' + s.state))}</span></button>${isLead() ? `<span class="srow-edit">${stateSel(s)}</span>` : ''}</div>
      ${violationsBox('step:' + s.id)}
      ${open ? `<div class="sdetail"><div class="sub muted"><span class="chip">${esc(t('zone.' + s.zone))}</span>${s.sub ? ` ${esc(s.sub)}` : ''}${stepTime(task, s) ? ` · ${esc(stepTime(task, s))}` : ''}</div>${s.detail ? mdRead(s.detail, 'step-' + s.id, task.id, 'detail', { kind: 'step', ref: '', step: s.id }) : ''}${options(s)}${s.recommend ? `<div class="detail rec md-line"><b>${esc(t('step.recommend'))}</b> ${mdInline(s.recommend, task.id)}</div>` : ''}${stepHistory(task, sid)}</div>` : ''}`;
  }).join('');
  const label = sid => { const s = task.steps.find(x => x.id === `${task.id}/${sid}`); return s ? s.label : sid; };
  const loops = (task.loops || []).length ? `<ul class="loops">${task.loops.map(l => `<li>↻ ${esc(l.label || t('loop.unnamed'))} <span class="muted">· ${esc(label(l.from))} → ${esc(label(l.to))}</span></li>`).join('')}</ul>` : '';
  const statusCtl = isLead() ? `<div class="actions state-ctl"><label><span class="muted">${esc(t('task.statusLabel'))}</span><span class="hov-wrap"><span class="cur-st">${statusChip(task.status)}</span>${taskStatusSelect(task)}</span></label>${measured(task) ? `<span class="muted">${esc(t('task.measured'))}: ${esc(measured(task))}</span>` : ''}</div>${isOwner() ? '' : violationsBox('task:' + task.id)}` : '';
  return `${statusCtl}<div class="slist ${all ? 'all' : ''}">${head}${rows}</div>${toggle}${loops}${historyCard(task)}`;
}
/** The messages scoped to this step (a note, a verdict, the CoS override note): the step's own history. Every one of
 *  them already sits in the task stream; this panel showed none, so a note written on a step was invisible beside it. */
function stepHistory(task, sid) {
  const msgs = msgsOf(task.id).filter(m => m.scope.step_id === sid);
  if (!msgs.length) return '';
  return `<div class="shist"><h3>${esc(t('step.history'))} <span class="muted">· ${msgs.length}</span></h3><ul>${msgs.map(m => `<li><span class="muted">${esc(fmtTime(m.ts))}</span> · <b>${esc(m.author.name)}</b> · <span class="kind">${esc(t('feedback.kind.' + m.kind))}</span>${m.body ? ` — ${mdInline(m.body, task.id)}` : ''}</li>`).join('')}</ul></div>`;
}
// ---------- Sơ đồ: the step flow, one swimlane per zone (the predecessor board's taskFlow, rewritten) ----------
const DIAGRAM_HISTORY_SHOWN = 50;
/** One box per live step, arrows in board order, the current step highlighted, owner hand-offs tagged; the merged
 *  history step sits above the flow as ONE collapsed chip that expands to its lines. A box is a link to
 *  #/task/ID?step=…, which route() turns into showStepReport: the step opens on the Steps tab with its detail, exactly
 *  as clicking that row does. Sizes and colours come from SVG attributes and CSS classes (the CSP blocks style=""). */
function diagramPanel(task) {
  // Top: what the PRODUCT is made of (task.architecture), never the plan. Below: the plan steps. Either may be absent.
  return `<section class="card diag-card"><div class="diag-sec arch-sec"><div class="diag-sec-head"><h3>${esc(t('diagram.arch.title'))}</h3>${architectureFullButton(task)}</div>${architectureBlock(task)}</div><div class="diag-sec plan-sec"><h3>${esc(t('diagram.steps.title'))}</h3>${planFlowBlock(task)}</div></section>`;
}
/** The structure diagram (J-05 24-10): groups as swimlanes, nodes in columns, edges as arrows. Every word of it is author
 *  text and goes through esc(); geometry is SVG attributes and classes only (the CSP blocks style=""). Validated on the
 *  server (src/architecture.mjs), laid out by LaneDiagram.layoutArchitecture, which also tolerates an odd value. */
function architectureBlock(task) {
  const L = DG.layoutArchitecture(task.architecture);
  if (L.empty) return `<p class="empty arch-empty">${esc(t('diagram.arch.empty'))}</p>`;
  // The tab's column is ~300 px: the preview is the top-down compact layout, drawn at the column's width (fitArchitecture); the
  // full view keeps the left-to-right layout at natural size with pan and zoom.
  return `<div class="arch-scroll">${architectureSvg(task, DG.layoutArchitecture(task.architecture, { compact: true }), { fit: true })}</div><p class="sub muted">${esc(t('diagram.arch.hint'))}</p>`;
}
/** The same full-window view as the step flow (pan, zoom, fit), opened on the structure diagram: the tab's column is narrow. */
function architectureFullButton(task) {
  if (DG.layoutArchitecture(task.architecture).empty) return '';
  return `<button type="button" class="btn diag-full-btn" data-action="diagram-full" data-kind="arch" data-task="${esc(task.id)}" aria-haspopup="dialog">${esc(t('diagram.fullView'))}</button>`;
}
/** Draws each inline structure preview at its column's width (never above natural, never below DG.FIT_MIN_SCALE), keeping the
 *  aspect ratio, and again whenever the column resizes (rail toggled, window resized). The size is set with SVG attributes
 *  (the CSP blocks style=""). Without JS the SVG simply stays at its natural width inside the scroller. */
function fitArchitecture() {
  for (const sc of document.querySelectorAll('.arch-scroll')) {
    const svg = sc.querySelector('.arch-svg.fit');
    if (!svg) continue;
    const fitOne = () => {
      const w0 = Number(svg.dataset.w), h0 = Number(svg.dataset.h), w = DG.fitWidth(w0, sc.clientWidth);
      if (!w || !h0) return;
      svg.setAttribute('width', String(w)); svg.setAttribute('height', String(Math.round(h0 * w / w0)));
    };
    fitOne();
    if (!sc._fitObserver && typeof ResizeObserver === 'function') { sc._fitObserver = new ResizeObserver(fitOne); sc._fitObserver.observe(sc); }
  }
}
function architectureSvg(task, L, { fit = false } = {}) {
  const mid = 'arch-arr-' + String(task.id).replace(/[^\w-]/g, '');
  const defs = `<defs><marker id="${mid}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="var(--muted-foreground)"/></marker></defs>`;
  const lanes = L.lanes.map((l, i) => `<g class="alane ${i % 2 ? 'alt' : ''}"><rect x="${l.x}" y="${l.y}" width="${l.w}" height="${l.h}" rx="10"/><text class="alane-t" x="${l.x + (L.compact ? 8 : 12)}" y="${L.compact ? l.y + 17 : l.y + l.h / 2 + 4}">${esc(l.id ? l.label : t('diagram.arch.noGroup'))}</text></g>`).join('');
  const edges = L.edges.map(e => `<path class="aedge ${e.dashed ? 'dashed' : ''}" data-from="${esc(e.from)}" data-to="${esc(e.to)}" d="${e.d}" marker-end="url(#${mid})"/>`).join('');
  const labels = L.edges.filter(e => e.label).map(e => `<text class="aedge-t" x="${e.lx}" y="${e.ly}" text-anchor="${e.anchor || 'middle'}">${esc(e.label)}</text>`).join('');
  const nodes = L.nodes.map(n => {
    const tx = n.x + (L.compact ? 9 : 12), ty = n.subLines.length ? n.y + (L.compact ? (n.lines.length > 1 ? 18 : 24) : 22) : n.y + n.h / 2 - (n.lines.length - 1) * (L.compact ? 9 : 8) + 4;
    const title = n.lines.map((ln, i) => `<text class="anode-t" x="${tx}" y="${ty + i * (L.compact ? 18 : 16)}">${esc(ln)}</text>`).join('');
    const sub = n.subLines.map(ln => `<text class="anode-s" x="${tx}" y="${n.y + n.h - (L.compact ? 7 : 14)}">${esc(ln)}</text>`).join('');
    const full = n.sub ? n.label + ' — ' + n.sub : n.label;
    return `<g class="anode" data-id="${esc(n.id)}"><title>${esc(full)}</title><rect class="abox" x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="10"/>${title}${sub}</g>`;
  }).join('');
  return `<svg class="arch-svg${L.compact ? ' compact' : ''}${fit ? ' fit' : ''}" width="${L.width}" height="${L.height}" viewBox="0 0 ${L.width} ${L.height}"${fit ? ` data-w="${L.width}" data-h="${L.height}"` : ''} role="group" aria-label="${esc(t('diagram.arch.aria', { task: task.id }))}">${defs}${lanes}${edges}${labels}${nodes}</svg>`;
}
/** The plan steps' swimlane flow (the diagram this tab showed alone before 24-10). */
function planFlowBlock(task) {
  const L = DG.layoutTask(task, { historyOpen: !!S.open['dh-' + task.id] });
  if (L.empty && !L.history) return `<p class="empty">${esc(t('diagram.empty'))}</p>`;
  const legend = `<div class="diag-legend"><span><i class="diag-sw cur" aria-hidden="true"></i>${esc(t('diagram.legend.current'))}</span><span><i class="diag-sw q" aria-hidden="true"></i>${esc(t('diagram.legend.owner'))}</span><span><i class="diag-sw ok" aria-hidden="true"></i>${esc(t('diagram.legend.done'))}</span></div>`;
  // The owner reads the flow full-window when it is wider than the tab (J-05): the button only exists when there is a flow.
  const full = L.boxes.length ? `<button type="button" class="btn diag-full-btn" data-action="diagram-full" data-task="${esc(task.id)}" aria-haspopup="dialog">${esc(t('diagram.fullView'))}</button>` : '';
  const head = `<div class="diag-head">${legend}${full}</div>`;
  const hist = L.history ? diagramHistory(task, L.history) : '';
  const flow = L.boxes.length ? `<div class="diag-flow">${diagramLaneTags(L)}<div class="diag-scroll-wrap"><div class="diag-scroll">${diagramSvg(task, L)}</div><span class="diag-fade l" aria-hidden="true"></span><span class="diag-fade r" aria-hidden="true"></span></div></div>` : '';
  return `${hist}${head}${flow}${L.boxes.length ? `<p class="sub muted">${esc(t('diagram.hint'))}</p>` : `<p class="empty">${esc(t('diagram.empty'))}</p>`}`;
}
/** The lane (zone) labels as a fixed column beside the scroller, so they stay put while the flow scrolls sideways: a
 *  lane whose label is scrolled away tells the reader nothing. It is outside the scroller, so it never covers a box. */
function diagramLaneTags(L) {
  const tags = L.lanes.map(l => `<text class="dlane-t" x="2" y="${l.y + 17}">${esc(t('zone.' + l.key))}</text><text class="dlane-s" x="2" y="${l.y + 33}">${esc(t(l.count === 1 ? 'diagram.laneSteps.one' : 'diagram.laneSteps.other', { n: l.count }))}</text>`).join('');
  return `<svg class="diag-lane-tags" width="${DG.LANE_TAG_W}" height="${L.height}" viewBox="0 0 ${DG.LANE_TAG_W} ${L.height}" aria-hidden="true">${tags}</svg>`;
}
/** Centre the current step, one column in from the left so its predecessor stays whole (the geometry module picks the
 *  exact scroll offset and its tests pin it), then repaint the edge fades. */
function scrollDiagramToCurrent() {
  const sc = document.querySelector('.diag-scroll');
  if (!sc) return;
  const box = sc.querySelector('.dnode.current .dbox');
  const x = box ? Number(box.getAttribute('x')) : 0;
  sc.scrollLeft = DG.scrollLeftFor(x, sc.scrollWidth - sc.clientWidth, sc.clientWidth);
  paintDiagramEdges(sc);
}
/** A soft fade on an edge that hides something: a box crossing that edge then reads as "more this way", not as a bug.
 *  Only shown when a box really straddles the edge (the empty label gutter does not count). */
function paintDiagramEdges(sc) {
  const flow = sc && sc.closest('.diag-flow');
  if (!flow) return;
  const r = sc.getBoundingClientRect(), max = Math.max(0, sc.scrollWidth - sc.clientWidth);
  const crosses = edge => [...sc.querySelectorAll('.dnode .dbox')].some(b => { const q = b.getBoundingClientRect(); return q.left < edge - 1 && q.right > edge + 1; });
  flow.classList.toggle('can-left', sc.scrollLeft > 1 && crosses(r.left));
  flow.classList.toggle('can-right', sc.scrollLeft < max - 1 && crosses(r.right));
}
/** The merged history step as one box: collapsed it says how many old steps it holds; open it lists them (capped, so a
 *  long archive stays readable). The lines are server-written "dd/mm · label · result", shown as text, never markdown. */
function diagramHistory(task, h) {
  const open = !h.collapsed, shown = h.lines.slice(0, DIAGRAM_HISTORY_SHOWN), more = h.lines.length - shown.length;
  const lines = open ? `<ul class="diag-hist-lines">${shown.map(l => `<li>${esc(l)}</li>`).join('')}${more > 0 ? `<li class="muted">${esc(t('diagram.historyMore', { n: more }))}</li>` : ''}</ul>` : '';
  const count = t(h.count === 1 ? 'diagram.historyCount.one' : 'diagram.historyCount.other', { n: h.count });
  return `<div class="diag-hist-box"><button type="button" class="diag-hist" data-action="diag-hist" data-task="${esc(task.id)}" aria-expanded="${open}"><span class="diag-hist-t">${esc(t('diagram.history'))}</span><span class="muted">${esc(count)}</span><span class="diag-caret" aria-hidden="true">${open ? '▴' : '▾'}</span></button>${lines}</div>`;
}
/** The flow SVG. Natural pixel width (never width="100%"): the pane scrolls it sideways instead of shrinking 12px text. */
function diagramSvg(task, L) {
  const mid = 'diag-arr-' + String(task.id).replace(/[^\w-]/g, '');
  const defs = `<defs><marker id="${mid}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="var(--muted-foreground)"/></marker></defs>`;
  // the lane bands only; the zone labels are the fixed overlay above this scroller (diagramLaneTags)
  const lanes = L.lanes.map((l, i) => `<g class="dlane ${i % 2 ? 'alt' : ''}"><rect x="${l.x}" y="${l.y}" width="${l.w}" height="${l.h}" rx="10"/></g>`).join('');
  const edges = L.edges.map(e => `<path class="dedge" d="${e.d}" marker-end="url(#${mid})"/>`).join('');
  const boxes = L.boxes.map(b => {
    const cls = ['dnode', 'st-' + b.state, b.current ? 'current' : '', b.owner ? 'owner' : '', b.done ? 'done' : ''].filter(Boolean).join(' ');
    const label = b.labelLines.map((ln, i) => `<text class="dnode-t" x="${b.x + 13}" y="${b.y + 24 + i * 15}">${esc(ln)}</text>`).join('');
    // the zone travels with the box too: at a narrow pane the lane label can be scrolled out of sight
    const sub = t('zone.' + b.zone) + ' · ' + t('state.' + b.state) + (b.owner ? ` · ${t('diagram.ownerTag')}` : '');
    const tag = b.waitingOwner ? `<g class="dtag"><rect x="${b.x + 6}" y="${b.y - 9}" width="36" height="18" rx="9"/><text x="${b.x + 24}" y="${b.y + 3}" text-anchor="middle">${esc(t('diagram.ownerTag'))}</text></g>` : '';
    const halo = b.current ? `<rect class="dglow" x="${b.x - 3}" y="${b.y - 3}" width="${b.w + 6}" height="${b.h + 6}" rx="13"/>` : '';
    // the whole step title, not the two clamped lines (they end in "…"): the hover tooltip and the screen reader get
    // the full text while the box keeps its clamp
    const full = b.label + ' — ' + sub;
    return `<a class="${cls}" href="#/task/${encodeURIComponent(task.id)}?step=${encodeURIComponent(b.short)}" tabindex="0" aria-label="${esc(full)}"><title>${esc(full)}</title>${halo}<rect class="dbox" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="10"/><rect class="dbar" x="${b.x}" y="${b.y + 10}" width="3" height="${b.h - 20}" rx="2"/><text class="dnum" x="${b.x + b.w - 11}" y="${b.y + 16}" text-anchor="end">${b.index}</text>${label}<text class="dnode-s" x="${b.x + 13}" y="${b.y + b.h - 12}">${esc(sub)}</text>${tag}</a>`;
  }).join('');
  return `<svg class="diag-svg" width="${L.width}" height="${L.height}" viewBox="0 0 ${L.width} ${L.height}" role="group" aria-label="${esc(t('diagram.aria', { task: task.id }))}">${defs}${lanes}${edges}${boxes}</svg>`;
}
// ---------- the Diagram tab's full view (J-05): the same flow, whole window, panned and zoomed ----------
// A body-level dialog like the lightbox and the reader, so a board poll that repaints #main never drops it, and nothing
// opens a new window (it has to work inside the Zumi webview). The SVG comes from the tab's own renderer (diagramSvg),
// from one layout computed at open time: the full view can never disagree with the tab beside it.
/** The open full view's task, from the latest board data (a task that vanished closes the dialog). */
function diagramFullTask() {
  const id = S.diagramFull?.taskId;
  return (S.data?.tasks || []).find(x => x.id === id) || null;
}
/** The dialog's markup: the tab's lane labels and step SVG, plus the zoom / fit / close controls. */
function diagramFullHtml(task) {
  const arch = S.diagramFull?.kind === 'arch'; // the structure diagram, or (default) the plan steps
  const L = arch ? null : DG.layoutTask(task, { historyOpen: !!S.open['dh-' + task.id] }), pct = Math.round((S.diagramFull?.zoom || 1) * 100);
  return `<div class="dfv-head"><div class="dfv-title"><span class="code">${esc(task.id)}</span><h1 id="dfv-title">${esc(task.title)}</h1></div>
    <div class="dfv-actions"><span class="dfv-zoom" data-dfv-zoom aria-live="polite">${pct}%</span>
      <button type="button" class="btn" data-action="dfv-zoom" data-d="-1" aria-label="${esc(t('diagram.zoomOut'))}">−</button>
      <button type="button" class="btn" data-action="dfv-zoom" data-d="1" aria-label="${esc(t('diagram.zoomIn'))}">+</button>
      <button type="button" class="btn" data-action="dfv-fit">${esc(t('diagram.fit'))}</button>
      <button type="button" class="btn" data-action="dfv-close" aria-label="${esc(t('common.close'))}">✕</button></div></div>
    <div class="dfv-hist">${!arch && L.history ? diagramHistory(task, L.history) : ''}</div>
    <div class="dfv-stage" tabindex="-1"><div class="dfv-canvas">${arch ? architectureSvg(task, DG.layoutArchitecture(task.architecture)) : diagramLaneTags(L) + diagramSvg(task, L)}</div></div>
    <p class="dfv-hint muted">${esc(t('diagram.fullHint'))}</p>`;
}
/** What the full view draws: a board poll rebuilds it only when one of these changes (the zoom/pan state survives). */
function diagramFullSig(task) {
  if (S.diagramFull?.kind === 'arch') return ['arch', task.id, task.title, JSON.stringify(task.architecture || null)].join('|');
  const hist = S.open['dh-' + task.id] ? 1 : 0;
  return [task.id, task.title, task.current_step?.id || '', 'h' + hist, ...task.steps.map(s => [s.id, s.state, s.label, s.detail || ''])].join('|');
}
function renderDiagramFull() {
  const task = diagramFullTask(), s = S.diagramFull;
  if (!s) return;
  if (!task) return closeDiagramFull(false);
  const host = document.getElementById('diagram-full'), sig = diagramFullSig(task);
  if (host && host.dataset.sig === sig) return; // same flow: leave the open dialog (and the owner's zoom) alone
  const opening = !host, focused = !!document.activeElement?.closest?.('#diagram-full');
  host?.remove();
  const el = document.createElement('div');
  el.id = 'diagram-full'; el.className = 'dfv'; el.tabIndex = -1; el.dataset.sig = sig;
  el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-labelledby', 'dfv-title');
  el.innerHTML = diagramFullHtml(task);
  document.body.append(el);
  document.documentElement.classList.add('dfv-open');
  bindDiagramFull(el.querySelector('.dfv-stage'), s);
  if (opening) fitDiagramFull(); else applyDiagramFull();
  if (opening || focused) el.focus();
}
/** Write the view onto the canvas through the CSSOM (the CSP blocks a style="" attribute in the markup). */
function applyDiagramFull() {
  const s = S.diagramFull; if (!s) return;
  const canvas = document.querySelector('#diagram-full .dfv-canvas');
  if (canvas) canvas.style.transform = `translate(${s.x}px, ${s.y}px) scale(${s.zoom})`;
  const pct = document.querySelector('#diagram-full [data-dfv-zoom]');
  if (pct) pct.textContent = Math.round(s.zoom * 100) + '%';
}
/** Scale the whole diagram into the pane and centre it: the state every open starts in, and the "fit" button. */
function fitDiagramFull() {
  const s = S.diagramFull; if (!s) return;
  const stage = document.querySelector('#diagram-full .dfv-stage'), canvas = stage?.querySelector('.dfv-canvas');
  if (!stage || !canvas) return;
  const w = canvas.offsetWidth, h = canvas.offsetHeight;
  if (!w || !h || !stage.clientWidth || !stage.clientHeight) return applyDiagramFull();
  const fit = Math.min(stage.clientWidth / w, stage.clientHeight / h) * 0.96;
  s.zoom = DG.clampZoom(Math.min(1, fit)); // a short flow sits at 100%: fitting is for the flow that does not fit
  // Centre what fits; at the 25% floor a phone still shows a very wide flow cut, so it starts at its first step.
  s.x = w * s.zoom <= stage.clientWidth ? (stage.clientWidth - w * s.zoom) / 2 : 8;
  s.y = h * s.zoom <= stage.clientHeight ? (stage.clientHeight - h * s.zoom) / 2 : 8;
  applyDiagramFull();
}
/** Zoom while keeping the diagram point under (cx, cy) still (wheel, pinch, and the +/- buttons at the centre). */
function zoomDiagramFull(next, cx, cy) {
  const s = S.diagramFull; if (!s) return;
  Object.assign(s, DG.zoomAbout(s, next, cx, cy));
  applyDiagramFull();
}
function zoomDiagramFullBy(dir) {
  const stage = document.querySelector('#diagram-full .dfv-stage');
  if (!stage) return;
  zoomDiagramFull((S.diagramFull?.zoom || 1) * (dir > 0 ? 1.25 : 1 / 1.25), stage.clientWidth / 2, stage.clientHeight / 2);
}
/** Drag to pan, wheel / pinch to zoom. Pointer Events cover mouse, pen and touch in one path; touch-action: none.
 *  A pointer is captured only once it has really moved, so a plain click still reaches a step box (it opens that
 *  step, exactly as on the tab) while a drag keeps tracking after it leaves the stage. */
function bindDiagramFull(stage, s) {
  if (!stage) return;
  const pts = new Map(), held = new Set();
  let start = null, pinch = null, moved = 0, suppress = false;
  const at = e => { const r = stage.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  stage.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const o = at(e);
    pts.set(e.pointerId, o);
    moved = 0; suppress = false;
    if (pts.size === 1) start = { x: o.x - s.x, y: o.y - s.y };
    else if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), zoom: s.zoom }; start = null; }
  });
  stage.addEventListener('pointermove', e => {
    if (!pts.has(e.pointerId)) return;
    const prev = pts.get(e.pointerId), o = at(e);
    moved += Math.abs(o.x - prev.x) + Math.abs(o.y - prev.y);
    pts.set(e.pointerId, o);
    if (!held.has(e.pointerId) && moved > 4) {
      held.add(e.pointerId);
      try { stage.setPointerCapture(e.pointerId); } catch { /* the host already released this pointer */ }
    }
    if (pts.size === 2 && pinch) {
      const [a, b] = [...pts.values()], d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch.d > 0 && d > 0) { const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; zoomDiagramFull(pinch.zoom * d / pinch.d, c.x, c.y); }
      return;
    }
    if (start) { s.x = o.x - start.x; s.y = o.y - start.y; applyDiagramFull(); }
  });
  const end = e => {
    if (!pts.has(e.pointerId)) return; // a lostpointercapture that follows this pointerup must not reset the click guard
    if (held.delete(e.pointerId)) { try { stage.releasePointerCapture(e.pointerId); } catch { /* already released */ } }
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = null;
    if (pts.size === 1) { const [p] = [...pts.values()]; start = { x: p.x - s.x, y: p.y - s.y }; }
    else if (!pts.size) {
      start = null;
      suppress = moved > 4; moved = 0;
      if (suppress) setTimeout(() => { suppress = false; }, 0); // the click that ends this gesture is the one to swallow
    }
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
  stage.addEventListener('lostpointercapture', end);
  // A drag that ends on a step box must not navigate: swallow that one click after real movement.
  stage.addEventListener('click', e => { if (suppress) { suppress = false; e.preventDefault(); e.stopPropagation(); } }, true);
  stage.addEventListener('wheel', e => {
    e.preventDefault();
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * stage.clientHeight : e.deltaY, c = at(e);
    zoomDiagramFull(s.zoom * Math.exp(-dy * 0.0015), c.x, c.y);
  }, { passive: false });
}
function openDiagramFull(b) {
  const task = (S.data?.tasks || []).find(x => x.id === b.dataset.task);
  if (!task) return;
  const kind = b.dataset.kind === 'arch' ? 'arch' : 'steps'; // the step flow's own button carries no data-kind
  S.diagramFull = { taskId: task.id, kind, opener: b, sel: `[data-action="diagram-full"]${kind === 'arch' ? '[data-kind="arch"]' : ':not([data-kind])'}[data-task="${CSS.escape(task.id)}"]`, zoom: 1, x: 0, y: 0 };
  renderDiagramFull();
}
/** Close the dialog and put the focus back on the button that opened it (or that button after a repaint). */
function closeDiagramFull(restore = true) {
  const s = S.diagramFull; S.diagramFull = null;
  document.getElementById('diagram-full')?.remove();
  document.documentElement.classList.remove('dfv-open');
  if (!restore || !s) return;
  const live = (s.opener && document.contains(s.opener) && s.opener) || (s.sel && document.querySelector(s.sel)) || document.getElementById('main');
  live?.focus?.();
}
/** Steps newest first (owner 10-10: on a long task the latest work sank to the bottom): a step waiting on the owner,
 *  then active ones, then other waiting/blocked ones stay on top in board order; the rest follow by their last state
 *  change on the server clock (ties: later in the board first). Each row keeps its board number. The first
 *  STEPS_SHOWN show; the older ones fold behind a toggle, and the open list scrolls in its own box. */
function stepsByRecency(task) {
  const lastAt = s => { const r = S.data.times?.[s.id]; return r?.transitions?.at(-1)?.at || r?.first_seen_at || ''; };
  // A fresh report (done within 48 h, has a detail) ranks 2.5: right after the open steps and counted with them, so it never hides behind "older".
  const pinOf = s => (LM.freshReport(s, S.data.times?.[s.id], serverNow()) ? 2.5 : stepPin(s));
  return task.steps.map((s, i) => ({ s, i, pin: pinOf(s), at: lastAt(s) }))
    .sort((a, b) => a.pin - b.pin || (a.pin <= 2 ? a.i - b.i : b.at.localeCompare(a.at) || b.i - a.i));
}
/** Mục tiêu: the locked goal (or the form), Rà lại, the task's context and dossier. */
function goalPanel(task) {
  return goalCard(task) + rebriefBar(task)
    + (task.context ? `<section class="card"><h2>${esc(t('task.context'))}</h2>${mdBlock(task.context, 'ctx-' + task.id, task.id, 'detail')}</section>` : '')
    + (task.dossier ? `<p class="sub muted">${esc(t('task.dossier'))}: <span class="mono">${esc(task.dossier)}</span></p>` : '');
}
function filesPanel(task) {
  const atts = (S.data.attachments || []).filter(a => a.task_id === task.id);
  return atts.length ? galleryGrid(atts.map(a => ({ att: a }))) : `<p class="empty">${esc(t('files.empty'))}</p>`;
}
/** Thợ: model and effort as selects (owner; written at once), who chose, the coordinator's default, and the changes. */
function workerPanel(task) {
  const w = task.worker, def = task.worker_default;
  if (!w) return `<p class="empty">${esc(t('worker.none'))}</p>`;
  const changes = (S.history[task.id] || []).filter(ev => /^(routing|roles)\./.test(ev.op)).slice(-8).reverse();
  const own = isOwner(), mine = S.data.roles?.[task.id] || {};
  const row = r => task.roles?.[r] ? `<tr><th>${esc(t('worker.role.' + r))}</th>${slotCell(task, r, own)}${own && r !== 'code' && mine[r] ? `<td><button type="button" class="linkish" data-action="roles-reset" data-id="${esc(task.id)}" data-role="${r}">${esc(t('worker.resetRole'))}</button></td>` : '<td></td>'}</tr>` : '';
  const fails = Object.entries(task.gate_fails || {}).filter(([, g]) => g.total).map(([gate, g]) => `<li><span class="mono">${esc(gate)}</span> · ${esc(t('worker.gateFails', { n: g.total, since: g.count }))}${g.blocked ? ` · ${esc(g.blocked)}` : ''}</li>`).join('');
  return `<div class="stack" data-route-box="${esc(task.id)}">
    <table class="events wk-table"><tbody>${ROLE_SLOTS.map(row).join('')}</tbody></table>
    ${violationsBox('routing:' + task.id)}
    ${def ? `<p class="sub muted">${esc(t('worker.default', { worker: workerText(def) }))}${w.by === 'owner' && own ? ` · <button type="button" class="linkish" data-action="routing-reset" data-id="${esc(task.id)}">${esc(t('worker.resetTo', { model: modelName(def.model), effort: def.effort }))}</button>` : ''}</p>` : ''}
    ${w.reason ? `<p class="sub muted">${esc(t('worker.reason', { reason: w.reason }))}</p>` : ''}
    ${own ? `<p class="sub muted">${esc(t('worker.saveHint'))}</p>` : ''}
    ${fails ? `<h3 class="mt">${esc(t('worker.gates'))}</h3><ul class="history">${fails}</ul>` : ''}
    ${changes.length ? `<h3 class="mt">${esc(t('worker.history'))}</h3><ul class="history">${changes.map(ev => `<li title="${esc(ev.at)}"><span class="muted">${esc(fmtTime(ev.at))}</span> · <b>${esc(ev.actor.name)}</b> · ${esc(roleChange(ev))}</li>`).join('')}</ul>` : ''}</div>`;
}
/** One routing / role journal line, spelled out (worker history and the task's history card). */
function roleChange(ev) {
  if (ev.op === 'routing.reset') return t('op.routing.reset');
  if (ev.op === 'routing.set') return t('history.routing', { from: ev.data.previous ? workerText(ev.data.previous) : '—', to: workerText(ev.data) });
  if (ev.op === 'roles.set') return t('history.roles', { role: t('worker.role.' + ev.data.role), from: ev.data.previous ? workerText(ev.data.previous) : '—', to: workerText(ev.data) });
  if (ev.op === 'roles.reset') return t('history.rolesReset', { role: t('worker.role.' + ev.data.role) });
  return ev.data.bump ? t('history.escalateBump', { gate: ev.data.gate, reason: ev.data.bump.reason }) : t('history.escalate', { gate: ev.data.gate, n: ev.data.count });
}

// ---------- one conversation per task: the stream, the "Cần anh" line, the one composer ----------
const OWNER_KINDS = ['approve', 'reject', 'redirect', 'askback', 'note'];
const msgsOf = taskId => (S.data.messages || []).filter(m => m.task_id === taskId);
const asksOf = taskId => (S.data.asks || []).filter(a => a.task_id === taskId);
/** "Cần anh" on the Tình hình card: open asks; else the owner's last answer and whether the coordinator received it. */
function needsOwnerLine(task) {
  // The row's age by the one rule (measure.js rowWaitSince, as the rail and /state askAt): open asks and waiting owner steps with no ask on them.
  const waits = LM.rowWaits((S.data.attention?.waiting || []).filter(w => w.task_id === task.id));
  const open = asksOf(task.id).filter(a => a.status === 'open');
  const items = waits.length ? waits : open.map(a => ({ kind: 'ask', since: askSinceOf(a) })); // a paused task is not in the attention list: its asks still count
  if (items.length) return t('situation.asks', { n: items.length, dur: fmtDur(serverNow() - Date.parse(LM.rowWaitSince(items))) });
  const last = msgsOf(task.id).filter(m => m.author.role === 'owner' && (m.answers_ask_id || m.kind === 'redirect')).at(-1);
  if (last?.received) return t('situation.received', { at: fmtTime(last.received.at), next: S.data.messages.find(m => m.id === last.received.receipt_id)?.receipt?.next || '—' });
  if (last && last.status === 'open') return t('situation.unreceived', { at: fmtTime(last.ts) });
  return t('situation.none');
}
// ---------- open asks as one card each (owner 10-23: "bấm vào nội dung bên phải … nó cứ loạn hết lên") ----------
// The panel used to heap every open ask's links and images into one row under "Cần anh" and clamp every ask to a few
// lines in the stream: with eight asks on V-03 the owner got eight file chips and duplicate PLAN links to sort out and
// never the question in full. One card per open ask fixes that: the first line and the wait when closed, the whole
// question plus ITS OWN files and the step's summary when open, and the answer right there. One card is open at a time
// (S.askOpen holds its ask id, so the 15 s poll repaints it still open).
// An ask waiting longer than a week folds under "Cũ hơn (N)" instead of pushing the fresh ones down.
const ASK_OLD_MS = 7 * 24 * 3600000;
/** One open ask's card. `age` is the wait (measure.js askSince, the number the rail and the row show). */
function askCard(task, a, age) {
  const open = S.askOpen === a.id, step = a.step_id ? task.steps.find(s => s.id === `${task.id}/${a.step_id}`) : null;
  // The closed card's one line: the question's FIRST line (an ask written as a list of lines keeps its opening
  // statement), whitespace folded. The CSS ellipsis cuts it; the whole text is one click away.
  const title = (String(refsOf(a.text).body || a.text).split('\n').map(l => l.trim()).find(Boolean) || '').replace(/\s+/g, ' ');
  const stepN = step ? task.steps.indexOf(step) + 1 : 0;
  return `<article class="ask-card ${open ? 'open' : ''}" id="askcard-${esc(a.id)}" data-ask-card="${esc(a.id)}">
    <button type="button" class="ask-card-head" data-action="ask-card" data-ask="${esc(a.id)}" aria-expanded="${open}" aria-controls="askcard-body-${esc(a.id)}">
      <span class="ac-title">${esc(title)}</span><span class="ac-meta">${step ? `<span class="muted">${esc(t('feedback.stepOption', { n: stepN, label: step.label }))}</span>` : ''}<span class="need-age ${waitTone(age)}">${esc(fmtDur(age))}</span><span class="caret" aria-hidden="true">${open ? '▾' : '▸'}</span></span>
    </button>
    ${open ? askCardBody(task, a, step, stepN) : ''}
  </article>`;
}
/** The open card: the whole question, only its own files, the step's summary and the answer. Built only when the card is
 *  open — a closed card must not render eight questions' markdown and refs on every 15 s poll just to throw it away. */
function askCardBody(task, a, step, stepN) {
  const body = refsOf(a.text);
  // Its own refs, each file once: an ask that names the same path twice shows one chip (with the copy path as its
  // secondary action), and a file another ask links never lands in this card.
  const refs = { images: uniqBy(body.images, im => im.name), links: uniqBy(body.links, l => refsKey(l.url)) };
  const summary = step ? (r => r.summary || r.full)(LR.splitTldr(step.detail || '')) : '';
  const stepBlock = step ? `<div class="ac-step"><button type="button" class="linkish" data-action="step-link" data-task="${esc(task.id)}" data-step="${esc(step.id.split('/')[1])}">${esc(t('feedback.stepOption', { n: stepN, label: step.label }))}</button>${summary.trim() ? mdRead(summary, 'ac-step-' + a.id, task.id, 'ac-sum', { kind: 'step', ref: '', step: step.id }) : ''}</div>` : '';
  const answer = (attr, key, label, cls) => `<button class="btn ${cls}" data-action="answer" data-kind="ask" data-id="${esc(a.id)}" data-rev="${esc(a.rev)}" data-task="${esc(task.id)}" ${attr}="${esc(key)}">${esc(label)}</button>`;
  const options = (a.options || []).map(o => `<button class="btn option" data-action="answer" data-kind="ask" data-id="${esc(a.id)}" data-rev="${esc(a.rev)}" data-task="${esc(task.id)}" data-choice="${esc(o.key)}"${o.desc ? ` title="${esc(o.desc)}"` : ''}><b>${esc(o.key)}</b> ${esc(o.label)}</button>`).join('');
  const verdicts = (a.options || []).length ? '' : answer('data-verdict', 'approve', t('answer.approve'), 'primary') + answer('data-verdict', 'reject', t('answer.reject'), '');
  const controls = isOwner() ? `<div class="actions">${options}${verdicts}<button class="btn" data-action="reply-ask" data-task="${esc(task.id)}" data-ask="${esc(a.id)}">${esc(t('stream.reply'))}</button></div>` : '';
  return `<div class="ask-card-body" id="askcard-body-${esc(a.id)}">
      <div class="md ac-text">${mdHtml(body.body, task.id)}</div>
      ${refsHtml(task.id, refs, 'ac-' + a.id)}
      ${stepBlock}
      ${controls}
    </div>`;
}
/** The open asks of a task, newest first, each its own card; the ones waiting over a week under one folded row. */
function askCards(task) {
  const open = asksOf(task.id).filter(a => a.status === 'open').map(a => ({ a, age: Math.max(0, serverNow() - Date.parse(askSinceOf(a))) }));
  if (!open.length) return '';
  open.sort((x, y) => x.age - y.age);
  const fresh = open.filter(x => x.age <= ASK_OLD_MS), old = open.filter(x => x.age > ASK_OLD_MS);
  const key = 'ask-old-' + task.id;
  return `<div class="ask-cards" id="ask-cards">${fresh.map(x => askCard(task, x.a, x.age)).join('')}${old.length ? `<details class="ask-older" data-open="${esc(key)}" ${S.open[key] ? 'open' : ''}><summary>${esc(t('askCard.older', { n: old.length }))}</summary>${old.map(x => askCard(task, x.a, x.age)).join('')}</details>` : ''}</div>`;
}
/** The task's stream, oldest first and newest next to the composer: asks, messages (replies and receipts nested under the
 *  message they answer), steps finished and plans posted. No per-entry controls except "Trả lời" on an open ask, which
 *  only scopes the composer. Each entry carries its step (data-step) so the Bước tab can jump to it. */
function streamEntries(task) {
  const msgs = msgsOf(task.id), byId = new Map(msgs.map(m => [m.id, m]));
  const images = []; S.galleryNavs.stream = images; // every image shown in the stream, in order, for the lightbox
  const imgs = m => (m.attachments || []).length ? `<div class="ev-imgs">${m.attachments.map(a => { images.push({ att: { id: a.id, mime: a.mime, name: a.name } }); return `<button type="button" class="ev-img" data-action="lightbox" data-nav="stream" data-i="${images.length - 1}" title="${esc(a.name)}"><img data-att="${esc(a.id)}" data-w="480" alt="${esc(a.name)}"></button>`; }).join('')}</div>` : '';
  const children = {};
  for (const m of msgs) if (m.reply_to && byId.has(m.reply_to)) (children[m.reply_to] ??= []).push(m);
  const doneSteps = task.steps.flatMap((s, i) => (S.data.times?.[s.id]?.transitions || []).filter(x => x.to === 'done').slice(-1).map(x => ({ ts: x.at, sys: { kind: 'step', s, i } })));
  const plans = (S.data.plans?.[task.id] || []).map(p => ({ ts: p.posted_at, sys: { kind: 'plan', p } }));
  const top = [...msgs.filter(m => !(m.reply_to && byId.has(m.reply_to))).map(m => ({ ts: m.ts, m })), ...asksOf(task.id).map(a => ({ ts: a.attribution.created_at, a })), ...doneSteps, ...plans]
    .sort((x, y) => x.ts.localeCompare(y.ts));
  const hl = S.hl?.task === task.id ? S.hl.id : '';
  // A highlighted entry older than the newest 40 widens the window down to it: the jump needs its #ev- target, and
  // every poll after it must rebuild the same window, or the kept scroll offset lands on other entries.
  const hlAt = hl ? top.findIndex(x => (x.a || x.m)?.id === hl) : -1;
  const LIMIT = 40, all = !!S.open['stream-' + task.id], shown = all ? top : top.slice(hlAt >= 0 ? Math.min(hlAt, Math.max(0, top.length - LIMIT)) : -LIMIT);
  const meta = (who, parts) => `<div class="ev-meta"><b>${esc(who)}</b>${parts.filter(Boolean).map(x => `<span>${x}</span>`).join('')}</div>`;
  const stepName = sid => { const i = task.steps.findIndex(s => s.id === `${task.id}/${sid}`); return i >= 0 ? t('feedback.stepOption', { n: i + 1, label: task.steps[i].label }) : sid; };
  const askState = a => {
    if (a.status === 'open') return a.asked_back ? t('stream.state.askedBack') : t('stream.state.open', { dur: fmtDur(serverNow() - Date.parse(askSinceOf(a))) });
    if (a.status === 'cleared') return t('stream.state.cleared');
    const f = a.answer?.feedback_id ? byId.get(a.answer.feedback_id) : msgs.find(m => m.answers_ask_id === a.id);
    return f?.received ? t('stream.state.received', { next: byId.get(f.received.receipt_id)?.receipt?.next || '—' }) : f && f.status !== 'open' ? t('stream.state.handled') : t('stream.state.answered');
  };
  const receiptBody = r => `<dl class="rcpt"><dt>${esc(t('receipt.change'))}</dt><dd>${esc(r.change)}</dd><dt>${esc(t('receipt.schedule'))}</dt><dd>${esc(r.schedule)}</dd><dt>${esc(t('receipt.next'))}</dt><dd>${esc(r.next)}</dd></dl>`;
  const time = ts => `<time title="${esc(ts)}">${esc(fmtTime(ts))}</time>`;
  const msgEntry = (m, child = false) => {
    const f = S.data.feedback.find(x => x.id === m.id) || {}, owner = m.author.role === 'owner' && !f.auto; // f.auto: the board's own status request, not the owner's word
    const scope = m.scope.ask_id ? '→ ' + esc(m.scope.ask_id) : m.scope.step_id ? esc(stepName(m.scope.step_id)) : '';
    // A re-brief and a goal lock read in the page language, as the thread showed them before.
    const text = m.kind === 'rebrief' ? (f.mode === 'status' ? t(f.auto ? 'rebrief.sentAuto' : 'rebrief.sentStatus') : t('rebrief.sent', { mode: t('rebrief.mode.' + (f.mode || 'strategy')) })) + (f.note ? '\n' + f.note : '') : m.kind === 'goal-lock' ? goalLockText(task.id, f) : m.body;
    const body = m.receipt ? receiptBody(m.receipt) : evBody(text || t('feedback.kind.' + m.kind), 'ev-fb-' + m.id, task.id, { kind: 'msg', ref: m.id });
    // An informational note (the CoS allowance) reports a change; nobody has to handle it, so it has no "mark handled".
    const resolve = isLead() && owner && !f.info && m.status === 'open' && !m.needs_receipt ? `<button type="button" class="more" data-action="resolve" data-id="${esc(m.id)}" data-rev="${f.rev}">${esc(t('feedback.resolve'))}</button>` : '';
    return `<div class="ev msg k-${esc(m.kind)} ${owner ? 'owner' : ''} ${child ? 'child' : ''} ${hl === m.id ? 'hl' : ''}" id="ev-${esc(m.id)}" data-step="${esc(m.scope.step_id || '')}">
      ${meta(f.auto ? t('stream.board') : owner ? t('stream.owner') : m.author.name, [`<span class="kind">${esc(t('feedback.kind.' + m.kind))}</span>`, scope, time(m.ts)])}${body}${imgs(m)}
      ${m.needs_receipt ? `<div class="ev-wait">${esc(t('stream.waitReceipt', { at: fmtTime(m.ts) }))}</div>` : ''}${resolve}
      ${(children[m.id] || []).map(c => msgEntry(c, true)).join('')}</div>`;
  };
  const askEntry = a => `<div class="ev ask ${a.status === 'open' ? 'open' : ''} ${hl === a.id ? 'hl' : ''}" id="ev-${esc(a.id)}" data-step="${esc(a.step_id || '')}">
      ${meta(askedBy(a.attribution.created_by), [`<span class="kind">${esc(t('stream.ask'))}</span>`, esc(a.id), a.step_id ? `<button type="button" class="linkish" data-action="step-link" data-task="${esc(task.id)}" data-step="${esc(a.step_id)}">${esc(stepName(a.step_id))}</button>` : '', time(a.attribution.created_at), `<span class="state">${esc(askState(a))}</span>`])}
      ${(r => evBody(r.body, 'ev-ask-' + a.id, task.id, { kind: 'ask', ref: a.id }) + refsHtml(task.id, r, 'ev-' + a.id))(refsOf(a.text))}${(a.options || []).length ? `<ul class="ev-opts">${a.options.map(o => `<li><b>${esc(o.key)}</b> ${esc(o.label)}</li>`).join('')}</ul>` : ''}${a.status === 'open' && isOwner() ? `<button type="button" class="more" data-action="reply-ask" data-task="${esc(task.id)}" data-ask="${esc(a.id)}">${esc(t('stream.reply'))}</button>` : ''}</div>`;
  const sysEntry = (ts, x) => x.kind === 'step'
    ? `<div class="ev sys" data-step="${esc(x.s.id.split('/')[1])}"><div class="ev-meta"><span class="si ok" aria-hidden="true">✓</span><button type="button" class="linkish" data-action="step-link" data-task="${esc(task.id)}" data-step="${esc(x.s.id.split('/')[1])}">${esc(t('stream.stepDone', { n: x.i + 1, label: x.s.label }))}</button>${String(x.s.detail || '').trim() ? `<span class="srep">📄 ${esc(t('step.report'))}</span>` : ''}${time(ts)}</div></div>`
    : `<div class="ev sys"><div class="ev-meta"><b>${esc(x.p.reviewer)}</b><button type="button" class="linkish" data-action="ctx-tab" data-tab="plans">${esc(t('stream.plan'))}</button>${x.p.verdict ? `<span>${esc(t('verdict.' + x.p.verdict))}</span>` : ''}${x.p.eta ? `<span>${esc(t('plan.eta', { eta: x.p.eta }))}</span>` : ''}${time(ts)}</div></div>`;
  // Withdrawn asks: one folded row at the oldest one's place, its cards inside; closed until the owner opens it (S.open), or
  // while a deep link points at one of them (review S3: the target must be visible, not hidden inside a closed fold).
  const cleared = shown.flatMap(x => (x.a && x.a.status === 'cleared' ? [x.a] : []));
  const wdKey = 'wd-' + task.id;
  const withdrawn = `<details class="ev-withdrawn" data-open="${esc(wdKey)}" ${S.open[wdKey] ?? cleared.some(a => a.id === hl) ? 'open' : ''}><summary>${esc(t('stream.withdrawn', { n: cleared.length }))} <span class="muted">${cleared.map(a => `${esc(a.id)} · ${time(a.cleared?.at || a.attribution.created_at)}`).join(' · ')}</span></summary>${cleared.map(askEntry).join('')}</details>`;
  let folded = false;
  const row = x => {
    if (!(x.a && x.a.status === 'cleared')) return x.a ? askEntry(x.a) : x.m ? msgEntry(x.m) : sysEntry(x.ts, x.sys);
    if (folded) return '';
    folded = true;
    return withdrawn;
  };
  const older = top.length - shown.length;
  return `${older > 0 ? `<button type="button" class="more" data-action="stream-all" data-task="${esc(task.id)}">${esc(t('stream.older', { n: older }))}</button>` : ''}
    ${shown.length ? `<div class="evs">${shown.map(row).join('')}</div>` : `<p class="empty">${esc(t('stream.empty'))}</p>`}`;
}
/** The task's composer state: kind, scope, text — kept per task in this browser (survives reload; storage may refuse). */
function compose(taskId) {
  if (!S.compose[taskId]) { let d = {}; try { d = JSON.parse(store.get('draft.' + taskId) || '{}'); } catch { d = {}; } S.compose[taskId] = { kind: OWNER_KINDS.includes(d.kind) ? d.kind : 'note', scope: d.scope || '', text: d.text || '' }; }
  return S.compose[taskId];
}
const hasDraft = taskId => !!(S.compose[taskId] ? S.compose[taskId].text.trim() : store.get('draft.' + taskId)); // saveDraft removes an empty one
function saveDraft(taskId) {
  const c = compose(taskId);
  store.set('draft.' + taskId, c.text.trim() ? JSON.stringify(c) : ''); // store.set wraps localStorage in try/catch
}
/** One composer per task, pinned to the bottom of the page: kind chips (owner), scope (task / a step / an open ask),
 *  a 6-line box that grows, one send button; Ctrl+Enter sends; the draft autosaves per task. */
function composer(task) {
  const c = compose(task.id), owner = isOwner();
  const asks = asksOf(task.id).filter(a => a.status === 'open' || c.scope === 'ask:' + a.id);
  const opt = (v, label) => `<option value="${esc(v)}" ${c.scope === v ? 'selected' : ''}>${esc(label)}</option>`;
  const scopes = opt('', t('feedback.wholeTask')) + asks.map(a => opt('ask:' + a.id, t('compose.scopeAsk', { id: a.id, text: a.text.replace(/\s+/g, ' ').slice(0, 60) }))).join('')
    + task.steps.map((s, i) => opt('step:' + s.id.split('/')[1], t('feedback.stepOption', { n: i + 1, label: s.label }))).join('');
  const chips = owner ? `<div class="kind-chips" role="radiogroup" aria-label="${esc(t('compose.kinds'))}">${OWNER_KINDS.map(k => `<button type="button" role="radio" class="kchip k-${k}" aria-checked="${c.kind === k}" data-action="compose-kind" data-task="${esc(task.id)}" data-kind="${k}">${esc(t('compose.kind.' + k))}</button>`).join('')}</div>` : '';
  return `<form class="composer" data-form="compose" data-id="${esc(task.id)}" id="composer">
    <div class="composer-top">${chips}<label class="scope"><span class="muted">${esc(t('compose.scope'))}</span><select name="scope" data-compose-scope="${esc(task.id)}">${scopes}</select></label></div>
    <textarea name="text" rows="3" data-compose-text="${esc(task.id)}" placeholder="${esc(t(owner ? 'compose.placeholder' : 'feedback.placeholder'))}" aria-label="${esc(t('compose.label'))}">${esc(c.text)}</textarea>
    ${thumbsHtml(task.id)}
    <div class="composer-foot"><span class="muted">${esc(t('compose.hint'))}</span><button class="btn primary">${esc(t(owner ? 'compose.send' : 'feedback.send'))}</button></div></form>`;
}
/** Sends the composer: one message (kind + scope) and, from the owner, one ping so the coordinator wakes. */
async function sendCompose(taskId) {
  const c = compose(taskId), files = S.composeFiles[taskId] || [];
  const text = c.text.trim() || (files.length ? t('compose.imagesOnly', { n: files.length }) : '');
  if (!text) return toast(t('feedback.emptyText'));
  const attachments = [];
  for (const f of files) { const id = await uploadImage(taskId, f); if (!id) return; attachments.push(id); } // a failed upload keeps the draft
  const task = S.data.tasks.find(x => x.id === taskId);
  const [type, ref] = c.scope.split(':');
  const ask = type === 'ask' ? asksOf(taskId).find(a => a.id === ref) : null;
  const stepId = type === 'step' ? ref : ask?.step_id || '';
  const data = { kind: isOwner() ? c.kind : 'reply', text: text.slice(0, 8000), ...(stepId && task?.steps.some(s => s.id === `${taskId}/${stepId}`) ? { step_id: stepId } : {}), ...(ask ? { ask_id: ask.id } : {}), ...(attachments.length ? { attachments } : {}) };
  if (!await write('feedback.add', taskId, data)) return;
  if (isOwner()) await write('ping.send', 'board', { task_id: taskId, note: '' });
  S.compose[taskId] = { kind: 'note', scope: '', text: '' }; saveDraft(taskId);
  for (const f of files) URL.revokeObjectURL(f.url);
  delete S.composeFiles[taskId];
  toast(t('compose.sent'));
  await refresh();
}
// ---------- images in the composer: paste (Ctrl+V, e.g. a Win+Shift+S screenshot) or drop, like a terminal chat ----------
const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
// Re-encoding of big photos (public/image-shrink.js): the type it returns is the blob's real one.
const shrinkImage = file => LaneImage.shrink(file, LaneImage.browserIo);
/** Adds images to the task's draft (in memory only: a reload drops them, the text stays). */
async function addImages(taskId, files) {
  const list = S.composeFiles[taskId] ??= [];
  for (const file of files) {
    if (!IMAGE_MIMES.includes(file.type)) { toast(t('compose.imageType')); continue; }
    const out = await shrinkImage(file).catch(() => null);
    if (!out) { toast(t('compose.imageTooLarge')); continue; }
    const ext = out.mime.split('/')[1].replace('jpeg', 'jpg');
    list.push({ key: crypto.randomUUID(), blob: out.blob, mime: out.mime, name: `paste-${Date.now()}-${list.length + 1}.${ext}`, url: URL.createObjectURL(out.blob) });
  }
  refreshThumbs(taskId);
}
function thumbsHtml(taskId) {
  const list = S.composeFiles[taskId] || [];
  return `<div class="thumbs" data-thumbs="${esc(taskId)}">${list.map(f => `<span class="thumb"><img src="${esc(f.url)}" alt="${esc(f.name)}"><button type="button" class="thumb-x" data-action="thumb-remove" data-task="${esc(taskId)}" data-key="${esc(f.key)}" aria-label="${esc(t('compose.removeImage'))}">×</button></span>`).join('')}</div>`;
}
/** Only the strip repaints: the box keeps its focus, caret and text. */
function refreshThumbs(taskId) { const el = document.querySelector(`[data-thumbs="${CSS.escape(taskId)}"]`); if (el) el.outerHTML = thumbsHtml(taskId); }
/** One image → attachment of the task (owner/coordinator; purpose=message: images only, ≤ 5 MiB). Returns its id. */
async function uploadImage(taskId, f) {
  const q = new URLSearchParams({ request_id: 'paste-' + crypto.randomUUID(), task_id: taskId, name: f.name, mime: f.mime, purpose: 'message' });
  try {
    const res = await fetch('api/v1/upload?' + q, { method: 'POST', headers: { 'Content-Type': f.mime, 'X-Requested-With': 'laneboard', ...authHeaders() }, body: f.blob });
    const out = await res.json().catch(() => ({}));
    if (res.ok && out.id) return out.id;
    toast(t('compose.uploadFailed', { msg: out.error || res.status }));
  } catch { toast(t('common.offline')); }
  return null;
}
/** Scope the composer to an ask, highlight it in the stream, and put the cursor in the box. */
function focusAsk(taskId, askId) {
  compose(taskId).scope = 'ask:' + askId; saveDraft(taskId);
  S.hl = { task: taskId, id: askId };
}
/** Before a repaint: where the stream, the context pane and the situation panel were scrolled, if the same task stays on screen. */
function keepScroll(r) {
  const st = document.getElementById('stream-scroll'), ctx = document.getElementById('ctx'), panel = document.getElementById('situation');
  if (!st || S.paintedTask !== r.id) return null;
  return { atBottom: st.scrollHeight - st.scrollTop - st.clientHeight < 40, top: st.scrollTop, ctx: ctx?.scrollTop || 0, panel: panel?.scrollTop || 0 };
}
/** After a repaint: a highlighted entry is scrolled into view; otherwise the stream keeps its place, or shows its newest
 *  entries (bottom) when the task was just opened. A step picked in the Bước tab scrolls the stream to its first entry. */
function afterTaskPaint(keep) {
  const st = document.getElementById('stream-scroll'), ctx = document.getElementById('ctx');
  S.paintedTask = route().id;
  const el = S.hl && document.getElementById('ev-' + S.hl.id);
  // The step's first entry the stream actually shows. A withdrawn ask folded in its closed row has no box, and a step with no
  // entry among the shown ones has none: either used to win the branch below, scroll nothing and leave the repaint at the top.
  // The closed-<details> test is needed on its own: Chromium 148+ still gives a folded card client rects.
  const stepEntry = st && S.stepJump ? [...st.querySelectorAll(`.ev[data-step="${CSS.escape(S.stepJump)}"]`)].find(e => !e.closest('details:not([open])') && e.getClientRects().length) : null;
  S.stepJump = '';
  if (st) {
    // A question picked in Tình hình opens at its first line; only the stream moves (scrollIntoView would also scroll
    // the column around it). A deep link from the rail keeps centring its entry.
    if (el && S.hl.scroll === 'start') { st.scrollTop += el.getBoundingClientRect().top - st.getBoundingClientRect().top; S.hl.scroll = false; }
    else if (el && S.hl.scroll) { el.scrollIntoView({ block: 'center' }); S.hl.scroll = false; }
    else if (stepEntry) { stepEntry.scrollIntoView({ block: 'center' }); stepEntry.classList.add('flash'); }
    else if (keep && !keep.atBottom) st.scrollTop = keep.top;
    else st.scrollTop = st.scrollHeight;
  }
  if (ctx && keep) ctx.scrollTop = keep.ctx;
  // The ask panel is its own scroller (the questions must never push the composer off screen): it keeps its place across
  // the poll, and a card the owner just opened is scrolled into view inside it.
  const panel = document.getElementById('situation');
  if (panel && keep) panel.scrollTop = keep.panel;
  if (panel && S.askScroll) { document.getElementById('askcard-' + S.askOpen)?.scrollIntoView({ block: 'nearest' }); S.askScroll = false; }
  if (S.stepFocus) { const e = document.getElementById('step-' + S.stepFocus); if (e) { e.scrollIntoView({ block: 'center' }); e.classList.add('flash'); } S.stepFocus = ''; }
  if (S.hl?.focus) { document.querySelector('#composer textarea')?.focus({ preventScroll: true }); S.hl.focus = false; }
  // the diagram opens on the current step (a repaint starts at its first column otherwise); the fades follow a drag
  const dsc = document.querySelector('.diag-scroll');
  if (dsc) { dsc.addEventListener('scroll', () => paintDiagramEdges(dsc), { passive: true }); scrollDiagramToCurrent(); }
  fitArchitecture();
}


// ---------- locked goal (owner) + re-brief + reviewer plans ----------
function goalLockText(taskId, f) {
  const g = goalOf(taskId), v = f.goal_version, rec = g && (g.version === v ? g : (g.history || []).find(h => h.version === v));
  return rec ? t('goal.lockText', { v, goal: rec.goal, output: rec.output, outcome: rec.outcome }) : f.text;
}
function goalCard(task) {
  const g = goalOf(task.id), edit = isOwner() && (!g || S.open['goal-' + task.id]);
  if (!edit) {
    if (!g) return `<section class="card goal unlocked"><div class="ghead"><h2>${esc(t('goal.title'))}</h2><span class="chip warn">${esc(t('goal.unlocked'))}</span></div><p class="muted">${esc(t('goal.unlockedOther'))}</p></section>`;
    const hist = (g.history || []).slice().reverse();
    return `<section class="card goal"><div class="ghead"><h2>${esc(t('goal.locked'))}</h2><span class="chip info">v${g.version}</span><span class="muted">${esc(t('goal.lockedAt', { when: fmtTime(g.locked_at) }))}</span></div>
      <dl class="kv"><dt>${esc(t('goal.goal'))}</dt><dd class="pre">${esc(g.goal)}</dd><dt>${esc(t('goal.output'))}</dt><dd class="pre">${esc(g.output)}</dd><dt>${esc(t('goal.outcome'))}</dt><dd class="pre">${esc(g.outcome)}</dd></dl>
      ${isOwner() ? `<div class="actions"><button class="btn" data-action="goal-edit" data-id="${esc(task.id)}">${esc(t('goal.edit'))}</button></div>` : ''}
      ${hist.length ? `<details class="ghist" data-open="ghist-${esc(task.id)}" ${S.open['ghist-' + task.id] ? 'open' : ''}><summary class="muted">${esc(t('goal.history', { n: hist.length }))}</summary>${hist.map(h => `<div class="sub pre"><b>v${h.version}</b>${h.locked_at ? ` · ${esc(fmtTime(h.locked_at))}` : ''}\n${esc(t('goal.goal'))}: ${esc(h.goal)}\n${esc(t('goal.output'))}: ${esc(h.output)}\n${esc(t('goal.outcome'))}: ${esc(h.outcome)}</div>`).join('')}</details>` : ''}</section>`;
  }
  const dk = 'goal-' + task.id, draft = S.drafts[dk] || (g ? { goal: g.goal, output: g.output, outcome: g.outcome } : { goal: '', output: '', outcome: '' });
  const ph = { goal: task.goal, output: task.draft_output, outcome: task.draft_outcome };
  const field = (k, hint) => `<label for="gl-${k}">${esc(t('goal.' + k))} <span class="muted">· ${esc(t(hint))}</span></label><textarea id="gl-${k}" name="${k}" rows="3" data-goal-draft="${esc(task.id)}" placeholder="${esc(ph[k] ? t('goal.draftPlaceholder', { text: ph[k] }) : '')}">${esc(draft[k] || '')}</textarea>`;
  const hasDraft = !g && (ph.goal || ph.output || ph.outcome);
  return `<section class="card goal ${g ? '' : 'unlocked'}"><div class="ghead"><h2>${esc(g ? t('goal.relock', { v: g.version + 1 }) : t('goal.title'))}</h2>${g ? '' : `<span class="chip warn">${esc(t('goal.unlocked'))}</span>`}</div>
    ${g ? '' : `<p class="sub muted">${esc(t('goal.intro'))}</p>`}
    <form class="gform" data-form="goal" data-id="${esc(task.id)}">${field('goal', 'goal.goalHint')}${field('output', 'goal.outputHint')}${field('outcome', 'goal.outcomeHint')}
    <div class="actions"><button class="btn primary">${esc(g ? t('goal.lockV', { v: g.version + 1 }) : t('goal.lock'))}</button>${hasDraft ? `<button type="button" class="btn" data-action="goal-draft" data-id="${esc(task.id)}">${esc(t('goal.useDraft'))}</button>` : ''}${g ? `<button type="button" class="btn" data-action="goal-cancel" data-id="${esc(task.id)}">${esc(t('common.cancel'))}</button>` : ''}</div></form></section>`;
}
/** The newest re-brief request on the task that no plan has answered yet (a plan posted after it). */
function rebriefPending(taskId) {
  const r = (S.data.feedback || []).filter(f => f.task_id === taskId && f.kind === 'rebrief' && f.mode !== 'status').sort((a, b) => b.attribution.created_at.localeCompare(a.attribution.created_at))[0];
  if (!r) return null;
  return (S.data.plans?.[taskId] || []).some(p => p.posted_at > r.attribution.created_at) ? null : r;
}
function rebriefBar(task) {
  const busy = rebriefPending(task.id), open = !busy && isOwner() && S.open['rb-' + task.id];
  let h = `<div class="rebrief">${isOwner() ? `<button class="btn ${busy ? '' : 'primary'}" data-action="rebrief-toggle" data-id="${esc(task.id)}" aria-expanded="${!!open}" ${busy ? 'disabled' : ''}>${esc(t(busy ? 'rebrief.busy' : 'rebrief.button'))}</button>` : ''}${busy ? `<span class="muted">${esc(t('rebrief.busyInfo', { when: fmtTime(busy.attribution.created_at), mode: t('rebrief.mode.' + (busy.mode || 'strategy')) }))}</span>` : ''}</div>`;
  if (!open) return h;
  const dk = 'rb-' + task.id, draft = S.drafts[dk] || { note: '', mode: 'strategy' };
  const radio = k => `<label><input type="radio" name="mode" value="${k}" ${draft.mode === k ? 'checked' : ''} ${k === 'status' && task.status_request ? 'disabled' : ''} data-rb-draft="${esc(task.id)}"> ${esc(t('rebrief.mode.' + k))}${k === 'strategy' ? ` <span class="muted">${esc(t('rebrief.default'))}</span>` : ''}${k === 'status' && task.status_request ? ` <span class="muted">(${esc(t('rebrief.statusOpen', { when: fmtTime(task.status_request.attribution.created_at) }))})</span>` : ''}</label>`;
  return h + `<section class="card rbpanel"><form data-form="rebrief" data-id="${esc(task.id)}">
    ${goalOf(task.id) ? '' : `<p class="hint">${esc(t('rebrief.noGoal'))}</p>`}
    <label for="rb-note">${esc(t('rebrief.noteLabel'))} <span class="muted">· ${esc(t('common.optional'))}</span></label>
    <textarea id="rb-note" name="note" rows="3" data-rb-draft="${esc(task.id)}" placeholder="${esc(t('rebrief.notePlaceholder'))}">${esc(draft.note || '')}</textarea>
    <fieldset class="radios"><legend class="muted">${esc(t('rebrief.modeLabel'))}</legend>${radio('strategy')}${radio('qc')}${radio('status')}</fieldset>
    <div class="actions"><button class="btn primary">${esc(t('rebrief.send'))}</button><button type="button" class="btn" data-action="rebrief-toggle" data-id="${esc(task.id)}">${esc(t('common.cancel'))}</button></div></form></section>`;
}
const VERDICT_CLASS = { 'on-track': 'ok', adjust: 'warn', drifting: 'warn', pivot: 'bad', 'wrong-goal': 'bad', unavailable: '' };
const VERDICT_CHIP = { 'on-track': 'on-track', adjust: 'adjust', drifting: 'adjust', pivot: 'pivot', 'wrong-goal': 'pivot', unavailable: 'unavailable' };
function plansCard(task) {
  const all = S.data.plans?.[task.id] || [];
  const latest = {};
  for (const p of all) if (!latest[p.reviewer] || p.posted_at > latest[p.reviewer].posted_at) latest[p.reviewer] = p;
  const order = ['Astra', 'Fable', 'Opus 5.5'], rank = r => { const i = order.indexOf(r); return i < 0 ? 9 : i; };
  const list = Object.values(latest).sort((a, b) => rank(a.reviewer) - rank(b.reviewer));
  const g = goalOf(task.id);
  const chosen = (S.data.feedback || []).filter(f => f.task_id === task.id && f.kind === 'choice' && f.plan_id && f.attribution.created_by.role === 'owner').sort((a, b) => b.attribution.created_at.localeCompare(a.attribution.created_at))[0];
  const chips = list.length ? `<div class="tags">${list.map(p => `<span class="chip ${VERDICT_CLASS[p.verdict] || ''}"><b>${esc(p.reviewer)}</b>: ${esc(p.verdict ? t('verdict.chip.' + VERDICT_CHIP[p.verdict]) : t('verdict.none'))}</span>`).join('')}</div>` : '';
  const card = p => {
    // Written before the goal was locked (or for an older goal): marked "cũ"; picking a plan waits for a locked goal.
    const isChosen = chosen?.plan_id === p.id, stale = g && p.goal_version !== g.version, old = !g || (p.goal_version || 0) < g.version;
    return `<div class="plan ${isChosen ? 'chosen' : ''} ${old ? 'old' : ''}"><div class="phead"><b>${esc(p.reviewer)}</b>${old ? `<span class="chip">${esc(t('plan.old'))}</span>` : ''}${p.verdict ? `<span class="chip ${VERDICT_CLASS[p.verdict] || ''}">${esc(t('verdict.' + p.verdict))}</span>` : ''}${p.eta ? `<span class="chip">${esc(t('plan.eta', { eta: p.eta }))}</span>` : ''}<span class="muted">${esc(fmtTime(p.written_at || p.posted_at))} · ${esc(p.goal_version ? t('plan.forGoal', { v: p.goal_version }) : t('plan.noGoal'))}</span>${isChosen ? `<span class="chip ai">${esc(t('plan.chosen'))}</span>` : ''}</div>
      ${stale ? `<p class="hint">${esc(t('plan.stale', { v: g.version }))}</p>` : ''}
      <details data-open="plan-${esc(p.id)}" ${S.open['plan-' + p.id] ? 'open' : ''}><summary class="muted">${esc(t('plan.full'))}</summary>${mdBlock(p.body, 'plan-' + p.id, task.id, 'detail')}</details>
      ${isOwner() && g && p.verdict !== 'unavailable' ? `<div class="actions"><button class="btn ${isChosen ? '' : 'primary'}" data-action="choose-plan" data-task="${esc(task.id)}" data-plan="${esc(p.id)}">${esc(isChosen ? t('plan.chooseAgain') : t('plan.choose', { reviewer: p.reviewer }))}</button></div>` : ''}</div>`;
  };
  const body = list.length ? chips + (!g && isOwner() ? `<p class="hint">${esc(t('plan.chooseAfterLock'))}</p>` : '') + `<div class="plans">${list.map(card).join('')}</div>` : `<p class="empty">${esc(t(g ? 'plan.emptyLocked' : 'plan.emptyUnlocked'))}</p>`;
  return `<section class="card plans-card"><h2>${esc(t('plan.title'))}</h2>${body}${all.length > list.length ? `<p class="sub muted">${esc(t('plan.hidden', { n: all.length - list.length }))}</p>` : ''}</section>`;
}

/** Journal op -> short label in the page language; an op this build has no label for (a newer server) stays raw. */
const opLabel = op => (('op.' + op) in S.en ? t('op.' + op) : op);
/** Who changed what on this task, newest first, from the audit journal (GET /api/v1/events?task=). Owner/coordinator. */
function historyCard(task) {
  const evs = S.history[task.id];
  if (!Array.isArray(evs)) return '';
  const what = ev => {
    if (ev.op === 'task.update' && ev.data.status) return t('history.status', { to: t('status.' + ev.data.status) });
    if ((ev.op === 'step.update' || ev.op === 'step.create') && ev.data.state) return t('history.step', { step: ev.target_id.split('/')[1], to: t('state.' + ev.data.state) });
    if (/^(routing|roles)\.(set|reset|escalate)$/.test(ev.op)) return roleChange(ev);
    // Task-level events name the task itself, so only a step (or another target) is spelled out after the label.
    const target = ev.target_id === task.id ? '' : ev.target_id.startsWith(task.id + '/') ? ev.target_id.slice(task.id.length + 1) : ev.target_id;
    return t('history.op', { op: opLabel(ev.op), target }).trim();
  };
  const tip = ev => [ev.at, `${ev.actor.label || ev.actor.name} (${t('role.' + ev.actor.role)})`, ev.actor.model, ev.actor.origin].filter(Boolean).join(' · ');
  // Newest first; the first STEPS_SHOWN show, the rest of the last 30 behind a toggle (the open list scrolls).
  const list = evs.slice(-30).reverse(), all = !!S.open['hist-all-' + task.id], shown = all ? list : list.slice(0, STEPS_SHOWN);
  const rows = shown.map(ev => `<li title="${esc(tip(ev))}"><span class="muted">${esc(ago(ev.at))}</span> · <b>${esc(ev.actor.name)}</b> · ${esc(what(ev))}</li>`).join('');
  const toggle = list.length > STEPS_SHOWN ? `<button type="button" class="more" data-action="hist-all" data-task="${esc(task.id)}" aria-expanded="${all}">${esc(all ? t('common.showLess') : t('history.older', { n: list.length - STEPS_SHOWN }))}</button>` : '';
  return `<details class="card docs" data-open="hist" ${S.open.hist ? 'open' : ''}><summary><h2>${esc(t('history.title'))} <span class="badge">${evs.length}</span></h2></summary>${rows ? `<ul class="history ${all ? 'all' : ''}">${rows}</ul>${toggle}` : `<p class="empty">${esc(t('history.empty'))}</p>`}</details>`;
}

// ---------- media: thumbnails, lightbox (images and videos; arrows, Esc, swipe), library ----------
const mediaType = mime => (mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : mime.startsWith('image/') ? 'image' : 'file');
/** items: [{att}] board attachments, or [{legacy: {name, type}}] files of the predecessor's media folder. */
const inLightbox = it => ['image', 'video'].includes(itemType(it));
/** nav: the page's whole lightbox order (a page may show several grids of it); indices point into it. */
function galleryGrid(items, nav = items.filter(inLightbox)) {
  S.galleryItems = nav; S.galleryNavs.grid = nav;
  return `<div class="ggrid">${items.map(it => {
    const type = itemType(it), cap = itemCaption(it), i = nav.indexOf(it);
    const capHtml = cap ? `<span class="gcap">${esc(cap)}</span>` : '';
    if (type === 'audio') return `<div class="gitem gaudio"><audio controls preload="none" ${it.att ? `data-media="${esc(it.att.id)}"` : `src="${esc('media/' + it.legacy.name)}"`}></audio>${capHtml}</div>`;
    if (type === 'video') return `<button type="button" class="gitem" data-action="lightbox" data-nav="grid" data-i="${i}"><video muted playsinline preload="metadata" ${it.att ? `data-media="${esc(it.att.id)}"` : `src="${esc('media/' + it.legacy.name)}#t=0.1"`}></video><span class="gplay" aria-hidden="true">▶</span>${capHtml}</button>`;
    if (type === 'image') return `<button type="button" class="gitem" data-action="lightbox" data-nav="grid" data-i="${i}"><img alt="${esc(cap || 'image')}" loading="lazy" ${it.att ? `data-att="${esc(it.att.id)}" data-w="480"` : `src="${esc('media/' + it.legacy.name)}"`}>${capHtml}</button>`;
    return `<div class="gitem gfile"><span class="mono">${esc(cap)}</span></div>`;
  }).join('')}</div>`;
}
const itemType = it => (it.att ? mediaType(it.att.mime) : it.legacy.type);
const itemCaption = it => (it.att ? [it.att.caption || it.att.name, it.att.step_id].filter(Boolean).join(' · ') : it.legacy.name);
function renderLightbox() {
  revokeOriginal();
  document.getElementById('lightbox')?.remove();
  const items = S.galleryItems || [], lb = S.lightbox;
  if (!lb || !items.length) return;
  const it = items[(lb.i + items.length) % items.length];
  const type = itemType(it), src = it.att ? '' : 'media/' + it.legacy.name;
  const body = type === 'video' ? `<video controls autoplay playsinline ${it.att ? `data-media="${esc(it.att.id)}"` : `src="${esc(src)}"`}></video>`
    : `<img alt="${esc(itemCaption(it))}" ${it.att ? `data-att="${esc(it.att.id)}" data-w="1600"` : `src="${esc(src)}"`}>`;
  const el = document.createElement('div');
  el.id = 'lightbox'; el.className = 'lightbox'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true');
  el.innerHTML = `<button type="button" class="lb-close" data-action="lightbox-close" aria-label="${esc(t('common.close'))}">✕</button>
    ${items.length > 1 ? `<button type="button" class="lb-nav lb-prev" data-action="lightbox-step" data-d="-1" aria-label="${esc(t('lightbox.prev'))}">‹</button><button type="button" class="lb-nav lb-next" data-action="lightbox-step" data-d="1" aria-label="${esc(t('lightbox.next'))}">›</button>` : ''}
    <div class="lb-body">${body}</div><div class="lb-cap">${esc(itemCaption(it))}</div>
    ${type === 'image' ? `<a class="lb-orig" data-orig="${esc(it.att ? it.att.id : src)}" href="#" rel="noopener">${esc(t('lightbox.original'))}</a>` : ''}`;
  document.body.appendChild(el);
  let sx = null;
  el.addEventListener('touchstart', e => { sx = e.touches[0].clientX; }, { passive: true });
  el.addEventListener('touchend', e => { if (sx == null) return; const dx = e.changedTouches[0].clientX - sx; if (Math.abs(dx) > 40) stepLightbox(dx < 0 ? 1 : -1); sx = null; }, { passive: true });
  el.addEventListener('click', e => { if (e.target === el) closeLightbox(); });
  loadImages();
}
function stepLightbox(dir) { if (!S.lightbox) return; const n = (S.galleryItems || []).length; S.lightbox.i = (S.lightbox.i + dir + n) % n; renderLightbox(); }
function closeLightbox() { S.lightbox = null; renderLightbox(); }
// ---------- reader: one long text in full, over the board page (T-31 board-read) ----------
/** The open reader's record, resolved from the latest board data (so a poll refresh shows new text, not a stale copy). */
function readerSource() {
  const r = S.reader;
  const task = S.data?.tasks?.find(x => x.id === r?.taskId);
  if (!r || !task) return null;
  if (r.kind === 'step') {
    const step = task.steps.find(s => s.id === r.step);
    if (!step) return null;
    const n = task.steps.findIndex(s => s.id === step.id) + 1, time = stepTime(task, step);
    return { task, step, stepId: step.id.split('/')[1], title: step.label, text: step.detail || '', meta: [t('situation.step') + ' ' + n], sub: [t('zone.' + step.zone), time].filter(Boolean).join(' · ') };
  }
  if (r.kind === 'doc') return { task, step: null, stepId: '', title: r.doc.title, text: r.doc.text, meta: r.doc.meta || [], sub: r.doc.sub || '' }; // a markdown string with its own title (an attached .md)
  if (r.kind === 'now') return { task, step: null, stepId: '', title: task.title, text: task.now || '', meta: [t('situation.now')], sub: '' };
  if (r.kind === 'ask') {
    const a = asksOf(task.id).find(x => x.id === r.ref);
    return a ? { task, step: null, stepId: a.step_id || '', title: task.title, text: a.text || '', meta: [t('stream.ask'), askedBy(a.attribution.created_by)], sub: '' } : null;
  }
  const m = msgsOf(task.id).find(x => x.id === r.ref);
  return m ? { task, step: null, stepId: m.scope?.step_id || '', title: task.title, text: m.body || '', meta: [t('feedback.kind.' + m.kind), m.author.name], sub: '' } : null;
}
/** The reader's text-column width, remembered per device: m = Vừa (~74ch), w = Rộng (~100ch, default), f = Đầy khung (whole pane). */
const READER_WIDTHS = ['m', 'w', 'f'];
const readerWidth = () => { const v = store.get('readerWidth'); return READER_WIDTHS.includes(v) ? v : 'w'; };
/** Switch the column in place: no rebuild, so the scroll position and the focus on the pressed button survive. */
function setReaderWidth(v) {
  if (!READER_WIDTHS.includes(v)) return;
  store.set('readerWidth', v);
  const el = document.getElementById('reader'); if (!el) return;
  el.dataset.width = v;
  el.querySelectorAll('[data-action="reader-width"]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.w === v)));
}
/** The reader is a body-level dialog (like the lightbox), so a repaint of #main does not drop it. One scroll container:
 *  .reader-body. A poll refresh rebuilds it only when the text changed, and keeps the scroll position either way. */
function renderReader() {
  const src = readerSource();
  if (!src) { if (document.getElementById('reader')) closeReader(false); return; }
  const host = document.getElementById('reader');
  // Not src.sub: it carries the step's live timer ("running 7s"), which would rebuild the reader on every poll.
  // A text with a Tóm tắt / TL;DR section opens on that section alone, with a button for the whole text (S.reader.full).
  const tldr = LR.splitTldr(src.text).summary, summaryOnly = !!tldr && !S.reader.full, shown = summaryOnly ? tldr : src.text;
  const sig = [S.reader.kind, S.reader.ref, S.reader.step, src.title, src.step ? src.step.state : '', summaryOnly, shown].join('|');
  if (host && host.dataset.sig === sig) return; // same text: leave the open reader (and its scroll) alone
  const top = host?.querySelector('.reader-body')?.scrollTop || 0, focused = !!document.activeElement?.closest?.('#reader');
  host?.remove();
  const el = document.createElement('div');
  el.id = 'reader'; el.className = 'reader'; el.dataset.sig = sig; el.dataset.width = readerWidth();
  el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-labelledby', 'reader-title');
  const crumb = `<span class="code">${esc(src.task.id)}</span><span>${esc(src.task.title)}</span><span>·</span>${src.meta.map(x => `<span>${esc(x)}</span>`).join('')}${src.step ? stateChip(src.step.state) : ''}`;
  const reply = isLead() && src.stepId ? `<button type="button" class="btn primary" data-action="reader-reply" data-step="${esc(src.stepId)}">${esc(t('reader.reply'))}</button>` : '';
  el.innerHTML = `<div class="reader-head"><div class="crumbs">${crumb}</div><h1 id="reader-title">${esc(src.title)}</h1>
    <div class="reader-actions"><div class="segmented reader-width" role="radiogroup" aria-label="${esc(t('reader.width'))}">${READER_WIDTHS.map(v => `<button type="button" role="radio" aria-checked="${readerWidth() === v}" data-action="reader-width" data-w="${v}">${esc(t('reader.w.' + v))}</button>`).join('')}</div>${reply}<button type="button" class="btn" data-action="reader-close" aria-keyshortcuts="Escape">${esc(t('common.close'))} <span class="muted">${esc(t('reader.esc'))}</span></button></div></div>
    <div class="reader-body" tabindex="-1"><div class="reader-doc">${src.sub ? `<p class="sub muted">${esc(src.sub)}</p>` : ''}<div class="md">${mdHtml(shown, src.task.id)}</div>${summaryOnly ? `<button type="button" class="btn reader-full" data-action="reader-full">${esc(t('reader.showAll'))}</button>` : ''}</div></div>`;
  document.body.append(el);
  document.documentElement.classList.add('reading');
  const body = el.querySelector('.reader-body');
  body.scrollTop = top;
  if (!host || focused) body.focus();
  loadImages(); // the reader is a fresh subtree: its images are not loaded until this call (the bug: blank until the next poll)
}
/** Open the reader on a markdown string instead of a board record: { taskId, title, text, meta?: string[], sub? }. The text can come
 *  from anywhere (an attached .md fetched from /api/v1/media/:id); it goes through the same MD.render as every other reader text. */
function openDoc(doc, opener) {
  S.reader = { taskId: doc.taskId, kind: 'doc', ref: '', step: '', doc, opener, sel: '', full: false };
  renderReader();
}
/** "Xem toàn bộ": the reader switches from the summary to the whole text. */
function readerShowAll() {
  if (!S.reader) return;
  S.reader.full = true;
  renderReader();
  document.querySelector('#reader .reader-body')?.scrollTo?.(0, 0);
}
/** A local .md chip: fetch the attached copy (the same authenticated media route the images use) and open it in the reader. */
async function readDoc(b) {
  const res = await fetch(`api/v1/media/${encodeURIComponent(b.dataset.att)}`, { headers: authHeaders() }).catch(() => null);
  if (!res?.ok) return toast(t('reader.docFailed'));
  openDoc({ taskId: b.dataset.task, title: b.dataset.label, text: await res.text(), meta: [], sub: b.dataset.path }, b);
}
function openReader(b) {
  S.reader = { taskId: b.dataset.task, kind: b.dataset.kind || 'step', ref: b.dataset.ref || '', step: b.dataset.step || '', opener: b, sel: b.dataset.step ? `[data-action="read"][data-step="${b.dataset.step}"]` : `[data-action="read"][data-kind="${b.dataset.kind}"][data-ref="${b.dataset.ref}"]` };
  renderReader();
}
/** Close the reader and put the focus back on the button that opened it (or the step row after a repaint). */
function closeReader(restore = true) {
  const r = S.reader; S.reader = null;
  document.getElementById('reader')?.remove();
  document.documentElement.classList.remove('reading');
  if (!restore || !r) return;
  const live = (r.opener && document.contains(r.opener) && r.opener) || (r.sel && document.querySelector(r.sel)) || document.querySelector('.srow-main') || document.getElementById('main');
  live?.focus?.();
}
/** "Trả lời bước này": close the reader, scope the composer to the step and put the cursor in the box. */
async function readerReply(stepId) {
  const r = S.reader; if (!r) return;
  const taskId = r.taskId, sid = stepId || r.step || '';
  closeReader(false);
  compose(taskId).scope = 'step:' + sid; saveDraft(taskId);
  await render();
  document.querySelector('#composer textarea')?.focus();
}
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.target.dataset?.composeText) { e.preventDefault(); return e.target.form.requestSubmit(); }
  if (e.key === 'Escape' && S.diagramFull) { e.preventDefault(); return closeDiagramFull(); }
  if (e.key === 'Escape' && S.wkPop) { const k = S.wkPop; S.wkPop = ''; return render().then(() => [...document.querySelectorAll('[data-action="wk-pop"]')].find(c => c.dataset.key === k)?.focus()); }
  if (e.key === 'Escape' && S.stPop) { S.stPop = ''; return renderRail(); }
  if (e.key === 'Escape' && S.open.menu && !S.lightbox && !S.reader) { S.open.menu = false; return render(); }
  if (!S.lightbox) { if (S.reader && e.key === 'Escape') { e.preventDefault(); closeReader(); } return; } // the reader's Esc comes after the lightbox's
  if (e.key === 'Escape') closeLightbox(); else if (e.key === 'ArrowLeft') stepLightbox(-1); else if (e.key === 'ArrowRight') stepLightbox(1);
});

/** Every attachment on the board, grouped by task (most recent first), plus the predecessor's media folder files no task carries. */
async function renderLibrary() {
  const d = S.data, q = S.libFilter;
  if (S.legacyMedia == null) { const r = await api('api/media'); S.legacyMedia = Array.isArray(r) ? r : []; }
  const attached = new Set(d.attachments.map(a => a.name));
  const groups = {};
  for (const a of d.attachments) if (q === 'all' || mediaType(a.mime) === q) (groups[a.task_id] ??= []).push({ att: a });
  const other = S.legacyMedia.filter(f => !attached.has(f.name) && (q === 'all' || f.type === q)).map(f => ({ legacy: f }));
  const newest = list => Math.max(...list.map(it => Date.parse(it.att.attribution.created_at)));
  const order = Object.keys(groups).sort((a, b) => newest(groups[b]) - newest(groups[a]));
  for (const k of order) groups[k].sort((a, b) => b.att.attribution.created_at.localeCompare(a.att.attribution.created_at));
  const all = [...order.flatMap(k => groups[k]), ...other], nav = all.filter(inLightbox);
  const section = (title, list) => `<p class="lib-head">${esc(title)} <span class="badge">${list.length}</span></p><section class="card">${galleryGrid(list, nav)}</section>`;
  const chip = (k, label) => `<button type="button" class="chip-btn" data-action="lib-filter" data-k="${k}" aria-pressed="${q === k}">${esc(label)}</button>`;
  return `<div class="page-head"><h1>${esc(t('nav.library'))}</h1></div>
    <div class="tags">${chip('all', t('library.all'))}${chip('image', t('library.images'))}${chip('video', t('library.videos'))}${chip('audio', t('library.audio'))}</div>
    ${all.length ? order.map(k => { const task = d.tasks.find(x => x.id === k); return section(task ? `${k} · ${task.title}` : k, groups[k]); }).join('') + (other.length ? section(t('library.other'), other) : '') : `<p class="empty">${esc(t('library.empty'))}</p>`}`;
}


/** The task registry: every known task with its status, filterable; the owner changes a status here. */
function renderRegistry() {
  // One source of truth: a task on the board shows its own task status (read only; change it on the task). An entry
  // with no task on the board shows the registry's word for it.
  const d = S.data, reg = d.docs?.registry, entries = reg?.entries || [], f = S.regFilter, q = S.regQuery.toLowerCase();
  const taskOf = e => (e.on_board && d.tasks.find(x => x.id === e.code)) || null;
  const statusOf = e => taskOf(e)?.status || e.status;
  const ORDER = [...new Set([...TASK_STATUS, ...REG_STATUS])];
  const cnt = k => entries.filter(e => statusOf(e) === k).length;
  const match = e => (f === 'all' || (f === 'live' ? ['doing', 'open', 'waiting', 'blocked'].includes(statusOf(e)) : statusOf(e) === f)) && (!q || `${e.code} ${e.title} ${e.file} ${e.note}`.toLowerCase().includes(q));
  const chip = (k, label) => `<button type="button" class="chip-btn" data-action="reg-filter" data-k="${k}" aria-pressed="${f === k}">${esc(label)}</button>`;
  const rows = entries.filter(match);
  const groups = ORDER.map(k => [k, rows.filter(e => statusOf(e) === k)]).filter(([, l]) => l.length);
  const row = e => {
    const task = taskOf(e);
    return `<div class="regrow"><span class="code">${esc(e.code || '—')}</span><div><div class="regtitle">${task ? `<a href="#/task/${encodeURIComponent(task.id)}">${esc(e.title)}</a>` : esc(e.title)}${task && !goalOf(task.id) ? ` <span class="chip warn">${esc(t('goal.unlocked'))}</span>` : ''}</div>
      ${e.note ? `<div class="sub muted md-line">${mdInline(e.note, e.code)}</div>` : ''}${task?.worker ? `<div class="sub">${workerChip(task.worker, isOwner() ? task.id : '')}</div>` : ''}</div>
      ${task ? `<a class="reg-status" href="#/task/${encodeURIComponent(task.id)}" title="${esc(t('registry.openTask'))}">${statusChip(task.status)}</a>` : statusChip(e.status)}</div>`;
  };
  return `<div class="page-head"><h1>${esc(t('nav.registry'))}</h1><span class="meta">${esc(t('registry.hint'))}</span></div>
    <section class="card"><div class="tags">${chip('live', t('registry.live', { n: cnt('doing') + cnt('open') + cnt('waiting') + cnt('blocked') }))}${ORDER.filter(k => cnt(k)).map(k => chip(k, `${t('status.' + k)} (${cnt(k)})`)).join('')}${chip('all', t('registry.all'))}</div>
    <input type="search" class="reg-search" placeholder="${esc(t('registry.search'))}" value="${esc(S.regQuery)}" data-reg-query="1" aria-label="${esc(t('registry.search'))}"></section>
    ${groups.length ? groups.map(([k, l]) => `<section class="card mt"><h2>${esc(t('status.' + k))} <span class="badge">${l.length}</span></h2><div class="reg">${l.map(row).join('')}</div></section>`).join('') : `<p class="empty">${esc(t('registry.none'))}</p>`}`;
}

/** "+ New task": the owner describes work; it goes to the board's request thread (NEW) and pings the coordinator. */
function renderNewTask() {
  const d = S.data;
  const mine = (d.feedback || []).filter(f => f.kind === 'newtask').sort((a, b) => b.attribution.created_at.localeCompare(a.attribution.created_at));
  const replyOf = id => (d.feedback || []).find(f => f.reply_to === id);
  return `<div class="page-head"><h1>${esc(t('nav.newTask'))}</h1></div><div class="grid-2">
    <section class="card"><h2>${esc(t('newtask.title'))}</h2><form data-form="newtask"><label for="nt-title">${esc(t('newtask.name'))}</label><input id="nt-title" type="text" name="title" data-draft="nt-title" value="${esc(S.drafts['nt-title'] || '')}" placeholder="${esc(t('newtask.namePlaceholder'))}">
      <label for="nt-text">${esc(t('newtask.desc'))}</label><textarea id="nt-text" name="text" rows="6" data-draft="nt-text" placeholder="${esc(t('newtask.descPlaceholder'))}">${esc(S.drafts['nt-text'] || '')}</textarea>
      <div class="actions"><button class="btn primary">${esc(t('newtask.send'))}</button></div><p class="sub muted">${esc(t('newtask.hint'))}</p></form></section>
    <section class="card"><h2>${esc(t('newtask.sent'))}</h2>${mine.length ? `<div class="thread">${mine.map(f => { const r = replyOf(f.id); return `<div class="msg"><div class="by"><b>${esc(f.attribution.created_by.name)}</b><span>${esc(fmtTime(f.attribution.created_at))}</span><span class="chip ${f.status === 'open' ? 'q' : 'ok'}">${esc(t(f.status === 'open' ? 'newtask.waiting' : 'newtask.received'))}</span>${f.task_id !== 'NEW' ? `<a href="#/task/${encodeURIComponent(f.task_id)}">${esc(f.task_id)}</a>` : ''}</div>${mdBlock(f.text, 'nt-' + f.id, f.task_id, 'body')}</div>${r ? `<div class="msg reply"><div class="by"><b>${esc(r.attribution.created_by.name)}</b><span>${esc(fmtTime(r.attribution.created_at))}</span></div>${mdBlock(r.text, 'ntr-' + r.id, r.task_id, 'body')}</div>` : ''}`; }).join('')}</div>` : `<p class="empty">${esc(t('newtask.none'))}</p>`}</section></div>`;
}

/** Owner's "Send to the coordinator" bar: one ping for the batch, when it was picked up, whether the watcher is on duty. */

// ---------- turn reports ("Báo cáo"): what each lane said when it finished a turn ----------
// The quick report (a line and ask chips) is computed by the board; the detail is the lane's own markdown, drawn with the same
// sanitising renderer as every agent text. GET /api/v1/state?v=2 carries the latest quick per lane (S.data.turns); the detail and
// the earlier reports come from GET /api/v1/turns, once per new report.
/** Who may see reports: the owner and the coordinator (every lane), a lane token (its own). The board filters the same way. */
const canReadTurns = () => !!S.data?.me && (isLead() || (role() === 'reporter' && !!S.data.me.lane));
/** Where a quick report's ask chip goes: the ask id already starts with "ask-", so the link is #ask-2402 (route() opens it). */
const askChipHref = id => `#${encodeURIComponent(id)}`;
S.turnCache = {};
async function loadTurns(lane, seq) {
  if (S.turnCache[lane]?.seq === seq) return;
  const r = await api(`api/v1/turns?lane=${encodeURIComponent(lane)}&limit=20`);
  if (Array.isArray(r.turns)) S.turnCache[lane] = { seq, list: r.turns };
}
/** The quick report: its line (up to three), then one chip per waiting ask that opens the ask. */
function quickHtml(q) {
  const chips = (q.asks || []).map(a => `<a class="chip q chip-link" href="${esc(askChipHref(a.id))}" title="${esc(a.text)}">${esc(a.task)}${a.step_id ? '/' + esc(a.step_id) : ''} · ${esc(Array.from(a.text).slice(0, 40).join(''))}</a>`).join('');
  return `<p class="quick-line">${String(q.line || '').split('\n').map(esc).join('<br>')}</p>${chips ? `<div class="quick-asks">${chips}</div>` : ''}`;
}
function turnDetail(turn, open) {
  const body = typeof turn.detail === 'string' ? mdBlock(turn.detail, 'rep-' + turn.seq, '') : `<p class="empty">${esc(t('reports.loadFailed'))}</p>`;
  return `<details class="report-detail" data-open="rep-${turn.seq}" ${S.open['rep-' + turn.seq] ?? open ? 'open' : ''}><summary>${esc(t('reports.detail'))}</summary>${body}</details>`;
}
function laneReport(lane, last, focus) {
  const list = S.turnCache[lane]?.list || [], [latest = { ...last }, ...older] = list;
  const older_ = older.map(x => `<details class="report-old" data-open="rep-${x.seq}" ${S.open['rep-' + x.seq] ? 'open' : ''}><summary><span class="muted">${esc(fmtTime(x.at))}</span> ${esc(String(x.quick?.line || '').split('\n')[0])}</summary>${typeof x.detail === 'string' ? mdBlock(x.detail, 'rep-' + x.seq, '') : ''}</details>`).join('');
  return `<section class="card report" id="report-${esc(encodeURIComponent(lane))}"><div class="report-head"><h2>${esc(lane)}</h2><span class="muted">${esc(fmtTime(latest.at))} · ${esc(t('common.ago', { dur: ago(latest.at) }))}</span></div>${quickHtml(latest.quick)}${turnDetail(latest, focus)}${older.length ? `<details class="report-older" data-open="rep-older-${esc(lane)}" ${S.open['rep-older-' + lane] ? 'open' : ''}><summary class="muted">${esc(t('reports.older', { n: older.length }))}</summary>${older_}</details>` : ''}</section>`;
}
/** One section per lane, the lane that reported last first; `focus` (#/reports/<lane>) goes first with its detail open. */
async function renderReports(focus = '') {
  const head = `<div class="page-head"><h1>${esc(t('reports.title'))}</h1></div><p class="muted">${esc(t('reports.hint'))}</p>`;
  if (!S.data.turns) return head + `<p class="empty">${esc(t('reports.unsupported'))}</p>`;
  const lanes = Object.entries(S.data.turns).sort((a, b) => (b[0] === focus) - (a[0] === focus) || b[1].seq - a[1].seq);
  if (!lanes.length) return head + `<p class="empty">${esc(t('reports.empty'))}</p>`;
  await Promise.all(lanes.map(([lane, last]) => loadTurns(lane, last.seq)));
  return head + `<div class="stack">${lanes.map(([lane, last]) => laneReport(lane, last, lane === focus)).join('')}</div>`;
}

// ---------- inbox + activity ----------
function renderInbox() {
  const items = (S.data.inbox || []).slice().sort((a, b) => b.attribution.created_at.localeCompare(a.attribution.created_at));
  const open = items.filter(i => !i.resolution), done = items.filter(i => i.resolution).slice(0, 20);
  const kind = i => i.kind === 'step' ? t('inbox.kind.step', { step: i.step_id, state: t('state.' + i.state) }) : t('inbox.kind.' + i.kind);
  const row = i => `<div class="row"><span class="code">${esc(i.task_id)}${i.step_id ? '/' + esc(i.step_id) : ''}</span><div>
      <div class="text">${esc(i.text) || '—'}</div>
      <div class="sub"><span class="chip ${i.kind === 'ask' ? 'q' : 'ai'}">${esc(kind(i))}</span><span>${esc(i.attribution.created_by.name)}</span><span>${esc(ago(i.attribution.created_at))}</span>${i.resolution ? `<span class="chip ${i.resolution.action === 'accept' ? 'ok' : ''}">${esc(t('inbox.resolved', { action: t('inbox.action.' + i.resolution.action), by: i.resolution.by.name }))}</span>` : ''}</div>
      ${!i.resolution && isLead() ? `<div class="actions"><button class="btn" data-action="merge" data-id="${esc(i.id)}" data-rev="${i.rev}" data-merge="accept">${esc(t('inbox.accept'))}</button><button class="btn" data-action="merge" data-id="${esc(i.id)}" data-rev="${i.rev}" data-merge="dismiss">${esc(t('inbox.dismiss'))}</button></div>` : ''}
    </div></div>`;
  return `<div class="page-head"><h1>${esc(t('inbox.title'))}</h1><span class="meta">${esc(t('inbox.hint'))}</span></div>
    <section class="card">${open.length ? `<div class="rows">${open.map(row).join('')}</div>` : `<p class="empty">${esc(t('inbox.empty'))}</p>`}</section>
    ${done.length ? `<section class="card mt"><div class="rows">${done.map(row).join('')}</div></section>` : ''}`;
}
/** One audit-journal row; the operation is named with the same labels as a task's history (opLabel), the raw op only in the tooltip. */
function activityRow(e) {
  return `<tr><td>${esc(ago(e.at))}</td><td><b>${esc(e.actor.name)}</b><br><span class="muted">${esc(t('role.' + e.actor.role))}${e.actor.model ? ' · ' + esc(e.actor.model) : ''}${e.actor.origin ? ' · ' + esc(e.actor.origin) : ''}</span></td><td title="${esc(e.op)}">${esc(opLabel(e.op))}</td><td class="mono">${esc(e.target_id)}</td></tr>`;
}
async function renderActivity() {
  const head = `<div class="page-head"><h1>${esc(t('activity.title'))}</h1></div>`;
  const events = await api(`api/v1/events?after=${Math.max(0, S.data.seq - 100)}&limit=100`);
  if (!Array.isArray(events)) return head + `<p class="empty">${esc(t('activity.forbidden'))}</p>`;
  const rows = events.reverse().map(activityRow).join('');
  return head + `<section class="card table-wrap">${rows ? `<table class="events"><thead><tr><th>${esc(t('activity.when'))}</th><th>${esc(t('activity.who'))}</th><th>${esc(t('activity.what'))}</th><th>${esc(t('activity.target'))}</th></tr></thead><tbody>${rows}</tbody></table>` : `<p class="empty">${esc(t('activity.empty'))}</p>`}</section>`;
}

// ---------- quota (J-05 quota-view): ONE document from GET /api/v1/quota, rendered as-is; the page decides only live / stale / reset (public/quota.js) ----------
const LQ = window.LaneQuota;
const QUOTA_TTL_MS = 60000;
/** Read the quota document once per minute. A failed read keeps whatever is on screen; a refused file (503) is shown as a banner with its reason. */
async function ensureQuota() {
  if (S.quotaAt && Date.now() - S.quotaAt < QUOTA_TTL_MS) return;
  let res;
  try { res = await fetch('api/v1/quota', { headers: authHeaders(), cache: 'no-store' }); } catch { return; } // offline: the page-level banner says so
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) return;
  S.quotaAt = Date.now();
  if (res.ok) { S.quota = body; S.quotaErr = null; return; }
  S.quotaErr = { reason: body.reason || body.error || String(res.status) };
  if (S.quota === undefined) S.quota = null;
}
const RING_R = 52, RING_LEN = 2 * Math.PI * RING_R;
function quotaRing(c) {
  const f = c.five, kind = f.state === 'live' || f.state === 'stale' ? 'pct' : f.state === 'passed' ? 'unknown' : 'none';
  const arc = kind === 'pct' ? `<circle class="q-ring-fg" cx="62" cy="62" r="${RING_R}" stroke-dasharray="${(RING_LEN * Math.min(100, f.pct) / 100).toFixed(1)} 1000" transform="rotate(-90 62 62)"/>` : '';
  const centre = kind === 'pct' ? `<b>${Math.round(f.pct)}%</b><span>${esc(t('quota.ring.five'))}</span>`
    : `<b class="mute">—</b><span class="amber">${esc(t(kind === 'unknown' ? 'quota.ring.unknown' : 'quota.ring.none'))}</span>`;
  return `<div class="q-ring${f.hot ? ' hot' : ''}${kind !== 'pct' ? ' none' : ''}"><svg viewBox="0 0 124 124" width="124" height="124" aria-hidden="true"><circle class="q-ring-bg" cx="62" cy="62" r="${RING_R}" stroke-dasharray="6 2.17"/>${arc}<circle class="q-ring-out" cx="62" cy="62" r="60"/></svg><div class="c${kind === 'pct' ? ' val' : ''}">${centre}</div></div>`;
}
function quotaFive(c, nowMs) {
  const f = c.five;
  if (f.state === 'passed') return `<div class="kv"><div class="k">${esc(t('quota.five.window'))}</div><div class="v amber">${esc(t('quota.five.passed', { time: LQ.clock(f.resetsAt) }))}</div>
    <div class="k gap">${esc(t('quota.lastSeen'))}</div><div class="v val">${esc(t('quota.lastSeenValue', { pct: Math.round(f.pct), time: LQ.clock(f.asOf) }))}</div></div>`;
  if (f.state === 'missing') return `<div class="kv"><div class="k">${esc(t('quota.five.window'))}</div><div class="v amber">${esc(t('quota.five.missing'))}</div></div>`;
  return `<div class="kv val"><div class="k">${esc(t('quota.five.resets'))}</div><div class="v">${esc(t('quota.five.resetsValue', { time: LQ.clock(f.resetsAt), dur: fmtDur(Date.parse(f.resetsAt) - nowMs) }))}</div>
    <div class="k gap">${esc(t('quota.source'))}</div><div class="v">${esc(t('quota.sourceValue'))}</div></div>`;
}
function quotaWeek(c) {
  const w = c.week, cells = Array.from({ length: LQ.SEGMENTS }, (_, i) => `<i${i < w.seg.on ? ' class="on"' : i === w.seg.act ? ' class="act"' : ''}></i>`).join('');
  const line = w.state === 'missing' ? `<span class="k">${esc(t('quota.weekMissing'))}</span>`
    : w.state === 'passed' ? `<span class="k amber">${esc(t('quota.weekPassed', { time: LQ.clock(w.resetsAt) }))}</span>`
    : `<span class="k val">${esc(t(w.state === 'stale' ? 'quota.weekStale' : 'quota.weekLive', { pct: Math.round(w.pct), time: LQ.clock(w.state === 'stale' ? w.asOf : w.resetsAt) }))}</span>`;
  return `<div class="blk"><div class="sec">${esc(t('quota.week'))}</div><div class="q-seg${w.state === 'live' || w.state === 'stale' ? ' val' : ''}">${cells}</div><div class="kv gap-s">${line}</div></div>`;
}
function quotaTokens(c) {
  const k = c.tokens;
  if (!k) return `<div class="blk"><div class="sec">${esc(t('quota.tokens'))}</div><div class="kv"><span class="k">${esc(t('quota.tokensNone'))}</span></div></div>`;
  const sub = k.todayCache != null ? t('quota.tokensCache', { n: LQ.fmtTokens(k.todayCache) }) : t('quota.tokensBase');
  const idle = k.idle && k.lastActivity ? `<div class="kv"><span class="k">${esc(t('quota.lastUse'))}</span> <span class="v">${esc(LQ.clock(k.lastActivity))}</span></div>` : '';
  return `<div class="blk${k.idle ? '' : ' val'}"><div class="sec">${esc(t('quota.tokens'))}</div><div class="big">${esc(LQ.fmtTokens(k.today))}</div>
    <div class="kv"><span class="k">${esc(sub)}</span></div>${idle || `<div class="kv"><span class="k">${esc(t('quota.days7'))}</span> <span class="v">${esc(LQ.fmtTokens(k.d7))}</span></div>`}</div>`;
}
function quotaFoot(c, nowMs) {
  const dot = `<span class="q-dot ${c.dot}"></span>`;
  if (c.status === 'offline') return `${dot}<span class="mute">${esc(t('quota.offline', { time: LQ.clock(c.reach.since) }))}</span>${c.reach.msg ? `<span class="mute">· ${esc(c.reach.msg)}</span>` : ''}`;
  if (c.status === 'live' || c.status === 'high') return `${dot}<span class="mute">${esc(t('quota.updated', { time: LQ.clock(c.lastSeen), ago: fmtDur(nowMs - Date.parse(c.lastSeen)) || '0' }))}</span>`;
  return `${dot}<span class="mute">${esc(t('quota.checked', { time: LQ.clock(c.reach.checkedAt) }))}</span>`;
}
function quotaCard(c, nowMs) {
  const note = c.status === 'offline' ? `<div class="note red">${esc(t('quota.noteOffline', { time: LQ.clock(c.reach.since) }))}</div>`
    : c.noNewSince ? `<div class="note">${esc(t('quota.noteStale', { time: LQ.clock(c.noNewSince) }))}</div>`
    : c.status === 'unverified' ? `<div class="note">${esc(t('quota.noteUnverified'))}</div>`
    : c.status === 'never' ? `<div class="note">${esc(t('quota.noteNever'))}</div>` : '';
  const warn = c.warnings.map(w => `<div class="note">${esc(t('quota.noteWarn', { msg: w }))}</div>`).join('');
  return `<article class="q-card ${c.status}${c.dim ? ' dim' : ''}" data-account="${esc(c.id)}">
    <div class="acct"><span class="q-dot ${c.dot}${c.blink ? ' blink' : ''}"></span><b>${esc(c.label)}</b><span class="sp"></span><span class="q-chip ${c.status}">${esc(t('quota.status.' + c.status))}</span></div>
    <div class="machine mute">${esc(c.machine)}</div>
    <div class="ringrow">${quotaRing(c)}${quotaFive(c, nowMs)}</div>
    ${quotaWeek(c)}${quotaTokens(c)}${note}${warn}
    <div class="upd">${quotaFoot(c, nowMs)}</div></article>`;
}
function renderQuota() {
  const nowMs = serverNow(), m = S.quota === undefined ? null : LQ.docModel(S.quota, nowMs);
  const err = S.quotaErr ? `<div class="q-banner" role="alert">${esc(t(m && !m.empty ? 'quota.errorKept' : 'quota.error', { reason: S.quotaErr.reason }))}</div>` : '';
  const body = !m ? `<p class="q-empty">${esc(t('quota.loading'))}</p>`
    : m.empty && S.quotaErr ? '' // the banner above is the whole story: "nothing published yet" would contradict it
    : m.empty ? `<p class="q-empty">${esc(t('quota.empty'))}${S.quota?.reason ? ` <span class="mono">${esc(S.quota.reason)}</span>` : ''}</p>`
    : `<div class="q-cards">${m.cards.map(c => quotaCard(c, nowMs)).join('')}</div>`;
  const meta = m?.generatedAt ? `<span class="meta${m.quiet ? ' quiet' : ''}"${m.quiet ? ` title="${esc(t('quota.quiet'))}"` : ''}>${esc(t('quota.refreshed', { time: LQ.clock(m.generatedAt) }))}</span>` : '';
  return `<section class="q-frame" aria-label="${esc(t('quota.title'))}"><span class="q-tick tr"></span><span class="q-tick bl"></span>
    <div class="q-head"><span class="q-dot blink"></span><span>${esc(t('quota.title'))}</span><span class="tag">${esc(t('quota.tag'))}</span><span class="sp"></span>${meta}</div>
    ${err}${body}
    <div class="q-foot"><span class="st"><span class="q-dot green"></span>${esc(t('quota.footLive'))}</span><span class="st"><span class="q-dot yellow"></span>${esc(t('quota.footStale'))}</span><span class="st"><span class="q-dot red"></span>${esc(t('quota.footOffline'))}</span><span class="sp"></span><span>${esc(t('quota.footNote'))}</span></div></section>`;
}

// ---------- settings (Orca-style: section nav on the left, one row per setting, control on the right) ----------
const settingRow = (label, desc, control) => `<div class="setting"><div class="setting-text"><div class="setting-label">${esc(label)}</div>${desc ? `<div class="setting-desc">${esc(desc)}</div>` : ''}</div><div class="setting-control">${control}</div></div>`;
const group = rows => `<div class="setting-group">${rows}</div>`;
const segmented = (key, label) => `<div class="segmented" role="radiogroup" aria-label="${esc(label)}">${CHOICES[key].map(v => `<button type="button" role="radio" aria-checked="${S.prefs[key] === v}" data-pref="${key}" data-value="${v}">${esc(t(`pref.${key}.${v}`))}</button>`).join('')}</div>`;
const fmtDate = iso => iso ? new Date(iso).toLocaleDateString(document.documentElement.lang, { year: 'numeric', month: 'short', day: 'numeric' }) : '—';

async function settingsSection(id) {
  if (id === 'general') {
    const opts = Object.entries(LANGS).map(([k, v]) => `<option value="${k}" ${k === S.lang ? 'selected' : ''}>${esc(v)}</option>`).join('');
    return group(settingRow(t('common.language'), t('settings.languageDesc'), `<select data-pref-select="lang" aria-label="${esc(t('common.language'))}">${opts}</select>`));
  }
  if (id === 'appearance') {
    const swatches = `<div class="swatches" role="radiogroup" aria-label="${esc(t('settings.accent'))}">${CHOICES.accent.map(v => `<button type="button" class="swatch ${v}" role="radio" aria-checked="${S.prefs.accent === v}" data-pref="accent" data-value="${v}" title="${esc(t('pref.accent.' + v))}"><span class="sr">${esc(t('pref.accent.' + v))}</span></button>`).join('')}</div>`;
    return group(
      settingRow(t('common.theme'), t('settings.themeDesc'), segmented('theme', t('common.theme'))) +
      settingRow(t('settings.accent'), t('settings.accentDesc'), swatches) +
      settingRow(t('settings.fontSize'), t('settings.fontSizeDesc'), segmented('font_size', t('settings.fontSize'))) +
      settingRow(t('settings.density'), t('settings.densityDesc'), segmented('density', t('settings.density'))));
  }
  if (id === 'notifications') {
    const supported = 'Notification' in window;
    const perm = supported ? Notification.permission : 'unsupported';
    const on = S.prefs.notify_owner_asks && isOwner();
    const toggle = `<button type="button" class="switch" role="switch" aria-checked="${on}" aria-label="${esc(t('settings.notifyAsks'))}" data-pref="notify_owner_asks" data-value="${!on}" ${isOwner() && supported ? '' : 'disabled'}></button>`;
    const browser = `<h3 class="setting-h">${esc(t('settings.browserGroup'))}</h3>` + group(
      settingRow(t('settings.notifyAsks'), t(isOwner() ? 'settings.notifyAsksDesc' : 'settings.notifyOwnerOnly'), toggle) +
      settingRow(t('settings.permission'), t('settings.permissionDesc'), `<span class="chip ${perm === 'granted' ? 'ok' : perm === 'denied' ? 'bad' : ''}">${esc(t('settings.perm.' + perm))}</span>`));
    return browser + coordinatorNotify();
  }
  if (id === 'agents') {
    if (!isOwner()) return `<p class="empty">${esc(t('settings.agentsOwnerOnly'))}</p>`;
    const list = await api('api/v1/tokens');
    if (!Array.isArray(list)) return `<p class="empty">${esc(t('settings.agentsOwnerOnly'))}</p>`;
    const rows = list.map(k => `<tr class="${k.revoked_at ? 'muted' : ''}"><td><b>${esc(k.name)}</b>${k.label && k.label !== k.name ? `<br><span class="muted">${esc(k.label)}</span>` : ''}</td><td>${esc(t('role.' + k.role))}</td><td>${esc(k.lane || '—')}</td><td class="mono">${esc(k.model || '—')}</td><td class="mono">${esc((k.scope_tasks || ['*']).join(', '))}</td><td>${esc(fmtDate(k.issued_at))}</td><td><span class="chip ${k.revoked_at ? '' : 'ok'}">${esc(t(k.revoked_at ? 'settings.tokenRevoked' : 'settings.tokenActive'))}</span></td></tr>`).join('');
    return `<p class="setting-note">${esc(t('settings.agentsHint'))}</p>
      <div class="setting-group table-wrap"><table class="events"><thead><tr><th>${esc(t('settings.col.name'))}</th><th>${esc(t('settings.col.role'))}</th><th>${esc(t('task.lane'))}</th><th>${esc(t('worker.model'))}</th><th>${esc(t('settings.col.scope'))}</th><th>${esc(t('settings.col.issued'))}</th><th>${esc(t('settings.col.status'))}</th></tr></thead><tbody>${rows}</tbody></table></div>${statusFreshness()}`;
  }
  if (id === 'zumi') {
    // Owner-only. The server is the guard (token.issue/token.revoke carry x-roles ["owner"]); hiding the controls
    // from everyone else is only a courtesy, and an anonymous reader never reaches the token list call.
    if (!isOwner()) return `<p class="empty">${esc(t('settings.zumi.ownerOnly'))}</p>`;
    const list = await api('api/v1/tokens');
    if (!Array.isArray(list)) return `<p class="empty">${esc(t('settings.zumi.ownerOnly'))}</p>`;
    const active = list.find(k => k.name === ZUMI_TOKEN && !k.revoked_at);
    if (!active) return group(settingRow(t('settings.zumi.create'), t('settings.zumi.createDesc'), `<button type="button" class="btn primary" data-action="zumi-issue">${esc(t('settings.zumi.createBtn'))}</button>`));
    return group(settingRow(t('settings.zumi.active', { when: fmtDate(active.issued_at) }), t('settings.zumi.activeDesc'),
      `<div class="actions tight"><button type="button" class="btn" data-action="zumi-revoke" data-id="${esc(active.id)}">${esc(t('settings.zumi.revoke'))}</button><button type="button" class="btn primary" data-action="zumi-reissue" data-id="${esc(active.id)}">${esc(t('settings.zumi.reissue'))}</button></div>`));
  }
  const version = S.data?.config?.version;
  return group(
    settingRow(t('settings.version'), '', `<span class="mono">${esc(version ? 'v' + version : '—')}</span>`) +
    settingRow(t('settings.api'), t('settings.apiDesc'), `<a class="mono" href="schema/v1/index.json" target="_blank" rel="noopener">schema/v1/index.json</a>`) +
    settingRow(t('settings.licence'), t('settings.licenceDesc'), '<span class="mono">Apache-2.0</span>'));
}
/** How the coordinator hears about owner feedback (notify.set). Owner edits; the coordinator sees its mode. */
function coordinatorNotify() {
  const n = S.data?.notify;
  if (!n) return '';
  const head = `<h3 class="setting-h">${esc(t('settings.coordGroup'))}</h3>`;
  const cmd = '<code class="cmd">board watch</code>';
  if (!isOwner()) return head + group(settingRow(t('settings.coordView'), t('settings.coordViewDesc'), cmd));
  const toggle = `<button type="button" class="switch" role="switch" aria-checked="${n.coordinator_feedback}" aria-label="${esc(t('settings.notifyCoord'))}" data-notify="coordinator_feedback" data-value="${!n.coordinator_feedback}"></button>`;
  const delivery = `<div class="segmented" role="radiogroup" aria-label="${esc(t('settings.delivery'))}">${['watch', 'webhook'].map(v => `<button type="button" role="radio" aria-checked="${n.delivery === v}" data-notify="delivery" data-value="${v}">${esc(t('settings.deliveryOpt.' + v))}</button>`).join('')}</div>`;
  let rows = settingRow(t('settings.notifyCoord'), t('settings.notifyCoordDesc'), toggle) + settingRow(t('settings.delivery'), t('settings.deliveryDesc'), delivery);
  if (n.delivery === 'watch') rows += settingRow(t('settings.watchCmd'), t('settings.watchCmdDesc'), cmd);
  else {
    const fp = n.secret_sha256 ? `<span class="mono">${esc(n.secret_sha256.slice(0, 12))}…</span>` : `<span class="muted">${esc(t('settings.secretNone'))}</span>`;
    const ld = n.last_delivery;
    const sent = !ld ? `<span class="muted">${esc(t('settings.sentNone'))}</span>`
      : `<span class="chip ${ld.ok ? 'ok' : 'bad'}">${esc(t(ld.ok ? 'settings.sentOk' : 'settings.sentFail', { when: ago(ld.at), why: ld.status || ld.error || '' }))}</span>`;
    rows += `<div class="setting setting-wide"><div class="setting-text"><div class="setting-label">${esc(t('settings.webhookUrl'))}</div><div class="setting-desc">${esc(t('settings.webhookUrlDesc'))}</div></div>
        <form class="inline-form" data-form="webhook"><input type="url" name="url" placeholder="https://…" value="${esc(n.webhook_url || '')}" aria-label="${esc(t('settings.webhookUrl'))}"><button class="btn primary">${esc(t('common.save'))}</button></form></div>`;
    rows += settingRow(t('settings.secret'), t('settings.secretDesc'), `<div class="actions tight">${fp}<button type="button" class="btn" data-action="rotate-secret">${esc(t('settings.rotate'))}</button></div>`);
    if (S.revealedSecret) rows += `<div class="setting setting-wide"><div class="setting-text"><div class="setting-label">${esc(t('settings.secretOnce'))}</div></div><code class="cmd secret">${esc(S.revealedSecret)}</code></div>`;
    rows += settingRow(t('settings.lastDelivery'), '', sent);
  }
  return head + group(rows);
}
/** When a task's Now/Next counts as stale, and whether the board asks the agent by itself (freshness.set, board-wide). */
function statusFreshness() {
  const f = S.data?.freshness;
  if (!f) return '';
  const hours = `<div class="segmented" role="radiogroup" aria-label="${esc(t('settings.staleAfter'))}">${[6, 12, 24, 48, 0].map(h => `<button type="button" role="radio" aria-checked="${f.stale_h === h}" data-fresh="stale_h" data-value="${h}">${esc(h ? t('settings.staleHours', { h }) : t('settings.staleOff'))}</button>`).join('')}</div>`;
  const auto = `<button type="button" class="switch" role="switch" aria-checked="${f.auto_request}" aria-label="${esc(t('settings.autoRequest'))}" data-fresh="auto_request" data-value="${!f.auto_request}"></button>`;
  return `<h3 class="setting-h">${esc(t('settings.freshGroup'))}</h3>` + group(settingRow(t('settings.staleAfter'), t('settings.staleAfterDesc'), hours) + settingRow(t('settings.autoRequest'), t('settings.autoRequestDesc'), auto));
}
async function setFreshness(data) {
  if (await write('freshness.set', 'board', data)) toast(t('common.saved'));
  await refresh();
}
async function setNotify(data) {
  const out = await write('notify.set', 'board', data);
  if (out?.webhook_secret) S.revealedSecret = out.webhook_secret;
  if (out) toast(t('common.saved'));
  await refresh();
}
async function renderSettings(sectionId) {
  const id = SECTIONS.includes(sectionId) ? sectionId : 'general';
  const nav = SECTIONS.map(s => `<button class="nav-item" data-go="#/settings/${s}" ${s === id ? 'aria-current="page"' : ''}><span class="label">${esc(t('settings.section.' + s))}</span></button>`).join('');
  const where = t(S.data?.me ? 'settings.savedAccount' : 'settings.savedLocal');
  return `<div class="page-head"><h1>${esc(t('settings.title'))}</h1><span class="meta">${esc(where)}</span></div>
    <div class="settings"><nav class="settings-nav" aria-label="${esc(t('settings.title'))}">${nav}</nav>
    <section class="settings-body"><h2>${esc(t('settings.section.' + id))}</h2>${await settingsSection(id)}</section></div>`;
}

/** One-time key dialog. The secret lives only in this element's DOM: never in S, never in localStorage, and the
 *  server returns it in the issue response alone (GET /api/v1/tokens strips it: src/views.mjs publicToken). Closing
 *  the dialog removes the element, so the value is gone from the page and cannot be re-fetched. */
let secretDialog = null;
function closeSecretOnce() { secretDialog?.remove(); secretDialog = null; }
function showSecretOnce(secret) {
  closeSecretOnce();
  const el = document.createElement('div');
  el.className = 'secret-dialog';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', t('settings.zumi.onceTitle'));
  el.innerHTML = `<div class="secret-card">
    <h3>${esc(t('settings.zumi.onceTitle'))}</h3>
    <code class="cmd secret" data-secret>${esc(secret)}</code>
    <p class="setting-desc">${esc(t('settings.zumi.onceNote'))}</p>
    <div class="actions">
      <button type="button" class="btn primary" data-action="copy-secret">${esc(t('settings.zumi.copy'))}</button>
      <button type="button" class="btn" data-action="secret-close">${esc(t('common.close'))}</button>
    </div></div>`;
  el.addEventListener('click', e => { if (e.target === el) closeSecretOnce(); }); // click the backdrop to close
  document.body.append(el);
  secretDialog = el;
}
async function issueZumiKey() {
  const out = await write('token.issue', ZUMI_TOKEN, { role: 'owner', label: 'Zumi app' });
  if (out?.token) showSecretOnce(out.token);
  await refresh();
}
/** In-page Confirm/Cancel dialog (never window.confirm, which some embeds and all automated tests cannot see or
 *  answer). Reuses the secret dialog's chrome. Resolves true on Confirm, false on Cancel or backdrop click. */
let confirmDialog = null, confirmAnswer = null;
function closeConfirm(result) { confirmDialog?.remove(); confirmDialog = null; const r = confirmAnswer; confirmAnswer = null; r?.(result); }
function showConfirm(message) {
  closeConfirm(false);
  return new Promise(resolve => {
    confirmAnswer = resolve;
    const el = document.createElement('div');
    el.className = 'secret-dialog';
    el.setAttribute('role', 'alertdialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', message);
    el.innerHTML = `<div class="secret-card">
      <p class="setting-desc">${esc(message)}</p>
      <div class="actions">
        <button type="button" class="btn" data-action="confirm-cancel">${esc(t('common.cancel'))}</button>
        <button type="button" class="btn primary" data-action="confirm-ok">${esc(t('common.continue'))}</button>
      </div></div>`;
    el.addEventListener('click', e => { if (e.target === el) closeConfirm(false); });
    document.body.append(el);
    confirmDialog = el;
  });
}
async function revokeZumiKey(id) {
  if (!(await showConfirm(t('settings.zumi.disconnectConfirm')))) return;
  if (await write('token.revoke', id, {})) toast(t('common.saved'));
  await refresh();
}
/** Reissue = revoke then issue, so it can never hit name_taken (token.issue only refuses a name with an active token). */
async function reissueZumiKey(id) {
  if (!(await showConfirm(t('settings.zumi.disconnectConfirm')))) return;
  if (!(await write('token.revoke', id, {}))) return refresh();
  const out = await write('token.issue', ZUMI_TOKEN, { role: 'owner', label: 'Zumi app' });
  if (out?.token) showSecretOnce(out.token);
  await refresh();
}
function renderSigninRail() {
  $('#rail').innerHTML = railShell(railFoot(''));
}
function renderSignin() {
  renderSigninRail();
  $('#main').innerHTML = `<div class="signin card"><h1>${esc(t('auth.title'))}</h1><p>${esc(t('auth.body'))}</p>
    <form data-form="signin"><label class="muted" for="tok">${esc(t('auth.token'))}</label><input id="tok" name="token" type="password" autocomplete="off" required><button class="btn primary">${esc(t('auth.submit'))}</button></form>
    <p class="actions"><button class="btn" data-action="public">${esc(t('auth.public'))}</button></p></div>`;
}

// ---------- render ----------
async function render() {
  const r = route();
  if (!S.data && S.reader) closeReader(false); // a lost session (sign-in) must not leave the reader over the page
  if (!S.data && S.diagramFull) closeDiagramFull(false); // nor the full diagram
  if (!S.data && r.view !== 'settings') return renderSignin();
  if (S.data) renderRail(); else renderSigninRail();
  let html;
  if (r.view === 'settings') html = await renderSettings(r.id);
  else if (r.view === 'task') {
    if (S.data && (r.ask || r.msg)) { // opened from "Chờ bạn": scope the composer to that ask (or show that answer), once
      if (r.ask) focusAsk(r.id, r.ask); else S.hl = { task: r.id, id: r.msg };
      Object.assign(S.hl, { scroll: true, focus: !!r.ask });
      history.replaceState(null, '', '#/task/' + encodeURIComponent(r.id)); store.set('view', location.hash);
    }
    if (S.data && r.step) { // a link to a step's report: open its task on the Steps tab, expand the step, scroll to it, once
      showStepReport(r.id, r.step);
      history.replaceState(null, '', '#/task/' + encodeURIComponent(r.id)); store.set('view', location.hash);
    }
    if (S.data && r.tab) { // #/task/ID?tab=stats: deep-link one right-pane tab (the Thống kê tab is linked this way)
      if (CTX_TABS.includes(r.tab)) setCtxTab(r.tab);
      history.replaceState(null, '', '#/task/' + encodeURIComponent(r.id)); store.set('view', location.hash);
    }
    if (isLead()) { const h = await api(`api/v1/events?task=${encodeURIComponent(r.id)}&limit=1000`); if (Array.isArray(h)) S.history[r.id] = h; }
    await ensureStats();
    html = renderTask(r.id);
  }
  else if (r.view === 'inbox' && S.data.me) html = renderInbox();
  else if (r.view === 'activity' && S.data.me) html = await renderActivity();
  else if (r.view === 'reports' && canReadTurns()) html = await renderReports(r.id);
  else if (r.view === 'quota' && S.data.me) { await ensureQuota(); html = renderQuota(); }
  else if (r.view === 'registry' && S.data.me) html = renderRegistry();
  else if (r.view === 'library' && S.data.me) html = await renderLibrary();
  else if (r.view === 'new' && isOwner()) html = renderNewTask();
  else { await ensureStats(); html = renderHome(); }
  if (S.offline) html = `<div class="offline" role="alert">${esc(t('common.offline'))}</div>` + html;
  const paint = () => {
    const focus = document.activeElement?.dataset?.regQuery ? document.activeElement.selectionStart : null;
    const keep = keepScroll(r), media = mediaState(); // an open inline player keeps its place across the repaint
    $('#main').classList.toggle('tv-mode', r.view === 'task' && !!S.data);
    $('#main').innerHTML = html; applyStatsBars($('#main')); fitClamps(); if (S.reader) renderReader(); if (S.diagramFull) renderDiagramFull(); if (r.view === 'task') afterTaskPaint(keep); previewMode(); loadImages(media); placeWkPop();
    if (focus != null) { const el = document.querySelector('[data-reg-query]'); el?.focus(); el?.setSelectionRange(focus, focus); }
  };
  const taskToTask = r.view === 'task' && /^#\/task\/|^#[A-Za-z0-9]/.test(render.lastView || '');
  if (document.startViewTransition && render.lastView !== location.hash && !taskToTask) document.startViewTransition(paint); else paint();
  render.lastView = location.hash;
}
const blobCache = new Map();
/** The inline players' position before a repaint: a poll or any render() must not restart a video the owner paused.
 *  Keyed by the chip's own player key (data-keep), so a tile of the same attachment elsewhere is never touched. */
const mediaState = () => new Map([...document.querySelectorAll('#main [data-keep]')].map(el => [el.dataset.keep, { t: el.currentTime || 0, paused: el.paused }]));
async function loadImages(keep = null) {
  // Images come as size-reduced copies (?w=480 in grids, ?w=1600 in text and the lightbox); the server falls back
  // to the original when it cannot make one. The original is a click away (lightbox "open original").
  for (const img of document.querySelectorAll('img[data-att]')) {
    const id = img.dataset.att, w = img.dataset.w || '1600', key = `${id}@${w}`;
    if (!blobCache.has(key)) {
      const res = await fetch(`api/v1/media/${id}?w=${w}`, { headers: authHeaders() });
      if (!res.ok) continue;
      blobCache.set(key, URL.createObjectURL(await res.blob()));
    }
    img.src = blobCache.get(key);
  }
  // Audio/video stream with Range requests from an expiring link (a <video> cannot send the bearer header).
  for (const el of document.querySelectorAll('[data-media]')) {
    const id = el.dataset.media, cached = linkCache.get(id);
    if (!cached || Date.parse(cached.expires_at) - Date.now() < 300000) {
      const res = await fetch(`api/v1/media/${id}/link`, { headers: authHeaders() });
      if (!res.ok) continue;
      linkCache.set(id, await res.json());
    }
    el.src = linkCache.get(id).url;
    // A rebuilt inline player picks its position back up (metadata may already be there when the link was cached).
    const st = keep && el.dataset.keep ? keep.get(el.dataset.keep) : null;
    if (st && (st.t > 0 || !st.paused)) {
      const apply = () => { el.currentTime = st.t; if (!st.paused) el.play().catch(() => {}); };
      if (el.readyState >= 1) apply(); else el.addEventListener('loadedmetadata', apply, { once: true });
    }
  }
}
const linkCache = new Map();
const mediaPlaying = () => [...document.querySelectorAll('video,audio')].some(m => !m.paused);

// ---------- events ----------
document.addEventListener('input', e => {
  const ds = e.target.dataset;
  if (ds.draft) S.drafts[ds.draft] = e.target.value;
  if (ds.composeText) { compose(ds.composeText).text = e.target.value; saveDraft(ds.composeText); }
  if (ds.regQuery) { S.regQuery = e.target.value; render(); }
  if (ds.leftQuery) { // filter the left list in place; the box keeps focus and caret
    const at = e.target.selectionStart; S.leftQuery = e.target.value; renderRail();
    const box = document.querySelector('[data-left-query]'); box?.focus(); box?.setSelectionRange(at, at);
  }
  if (ds.goalDraft) { const f = e.target.form; S.drafts['goal-' + ds.goalDraft] = { goal: f.goal.value, output: f.output.value, outcome: f.outcome.value }; }
  if (ds.rbDraft) { const f = e.target.form; S.drafts['rb-' + ds.rbDraft] = { note: f.note.value, mode: f.mode.value || 'strategy' }; }
});
document.addEventListener('change', async e => {
  const k = e.target.dataset.prefSelect;
  if (k) setPref(k, e.target.value);
  if (e.target.dataset.composeScope) { compose(e.target.dataset.composeScope).scope = e.target.value; saveDraft(e.target.dataset.composeScope); }
  if (e.target.dataset.route) { // Thợ: a model or effort change is written at once (the same routing.set the owner always used)
    const id = e.target.dataset.route, box = e.target.closest('[data-role-box]') || e.target.closest('[data-route-box]') || e.target.parentElement;
    const val = f => box.querySelector(`select[data-route][data-field="${f}"]`)?.value;
    if (await write('routing.set', id, { model: val('model'), effort: fixEffort(val('model'), val('effort')) }, undefined, 'routing:' + id)) toast(t('worker.saved'));
    return refresh();
  }
  if (e.target.dataset.roleSlot) { // plan / review / scout: model or effort changed -> roles.set at once (by = owner)
    const id = e.target.dataset.roleSlot, role = e.target.dataset.role, box = e.target.closest('[data-role-box]') || e.target.parentElement;
    const val = f => box.querySelector(`select[data-role-slot][data-field="${f}"]`)?.value;
    if (await write('roles.set', id, { role, model: val('model'), effort: fixEffort(val('model'), val('effort')) }, undefined, 'routing:' + id)) toast(t('worker.saved'));
    return refresh();
  }
  if (e.target.dataset.rbDraft) { const f = e.target.form; S.drafts['rb-' + e.target.dataset.rbDraft] = { note: f.note.value, mode: f.mode.value || 'strategy' }; }
});
document.addEventListener('change', async e => {
  const el = e.target, { taskStatus, stepState, rev } = el.dataset;
  if (taskStatus) { if (await write('task.update', taskStatus, { status: el.value }, Number(rev), 'task:' + taskStatus)) { toast(t('common.saved')); await refresh(); } }
  if (stepState) { if (await write('step.update', stepState, { state: el.value }, Number(rev), 'step:' + stepState)) { toast(t('common.saved')); await refresh(); } }
});
document.addEventListener('toggle', e => { const k = e.target.dataset?.open; if (k) S.open[k] = e.target.open; }, true); // toggle does not bubble
document.addEventListener('click', async e => {
  if (S.wkPop && !e.target.closest('.wk-pop, [data-action="wk-pop"]')) { S.wkPop = ''; render(); } // a click elsewhere closes the worker popover
  if (S.stPop && !e.target.closest('.st-pop, [data-action="st-pop"]')) { S.stPop = ''; renderRail(); } // a click elsewhere closes the status popover
  const nav = e.target.closest('[data-go]');
  if (nav && !e.target.closest('a,button:not([data-go]),form,select,.violations')) { S.open.menu = false; return go(nav.dataset.go); }
  const pref = e.target.closest('[data-pref]');
  if (pref) { const v = pref.dataset.value; return setPref(pref.dataset.pref, v === 'true' ? true : v === 'false' ? false : v); }
  const wo = e.target.closest('[data-worker-open]');
  if (wo && wo.dataset.workerOpen) setCtxTab('worker'); // the link then opens the task on its Thợ tab
  const orig = e.target.closest('[data-orig]');
  if (orig) { e.preventDefault(); return openOriginal(orig.dataset.orig); }
  const fr = e.target.closest('[data-fresh]');
  if (fr) { const v = fr.dataset.value; return setFreshness({ [fr.dataset.fresh]: v === 'true' ? true : v === 'false' ? false : Number(v) }); }
  const nt = e.target.closest('[data-notify]');
  if (nt) { const v = nt.dataset.value; return setNotify({ [nt.dataset.notify]: v === 'true' ? true : v === 'false' ? false : v }); }
  const b = e.target.closest('[data-action]');
  if (!b) return;
  const { action, id, rev } = b.dataset;
  // Display-only toggles: no write, no refetch.
  if (action === 'wk-pop') { S.wkPop = S.wkPop === b.dataset.key ? '' : b.dataset.key; await render(); return document.querySelector('.wk-pop select')?.focus(); }
  if (action === 'more') { S.open['md-' + b.dataset.key] = !S.open['md-' + b.dataset.key]; return render(); }
  if (action === 'file-open') { S.open[b.dataset.key] = !S.open[b.dataset.key]; return render(); } // an .mp4 chip: its inline player appears below the chips
  if (action === 'read') return openReader(b);
  if (action === 'read-doc') return readDoc(b);
  if (action === 'reader-full') return readerShowAll();
  if (action === 'reader-width') return setReaderWidth(b.dataset.w);
  if (action === 'reader-close') return closeReader();
  if (action === 'reader-reply') return readerReply(b.dataset.step);
  if (action === 'rail') { S.open.rail = !S.open.rail; return render(); }
  if (action === 'menu') { S.open.menu = !S.open.menu; return render(); }
  if (action === 'sweep') return sendSweep();
  if (action === 'dismiss-error') { delete S.errors[b.dataset.key]; return render(); }
  if (action === 'lightbox') { if (b.dataset.nav) S.galleryItems = S.galleryNavs[b.dataset.nav] || []; S.lightbox = { i: Number(b.dataset.i) }; return renderLightbox(); }
  if (action === 'thumb-remove') {
    const list = S.composeFiles[b.dataset.task] || [], i = list.findIndex(f => f.key === b.dataset.key);
    if (i >= 0) { URL.revokeObjectURL(list[i].url); list.splice(i, 1); }
    return refreshThumbs(b.dataset.task);
  }
  if (action === 'lightbox-close') return closeLightbox();
  if (action === 'lightbox-step') return stepLightbox(Number(b.dataset.d));
  if (action === 'lib-filter') { S.libFilter = b.dataset.k; return render(); }
  if (action === 'stats-mwin') { S.statMWin = ['today', 'w7', 'all'].includes(b.dataset.win) ? b.dataset.win : 'w7'; return render(); }
  if (action === 'stats-win') { S.statWin = b.dataset.win === 'today' ? 'today' : 'w7'; return render(); }
  if (action === 'home-view') { store.set('homeView', b.dataset.view === 'map' ? 'map' : 'list'); return render(); }
  if (action === 'diag-hist') { const k = 'dh-' + b.dataset.task; S.open[k] = !S.open[k]; return render(); }
  if (action === 'diagram-full') return openDiagramFull(b);
  if (action === 'dfv-zoom') return zoomDiagramFullBy(Number(b.dataset.d));
  if (action === 'dfv-fit') return fitDiagramFull();
  if (action === 'dfv-close') return closeDiagramFull();
  if (action === 'reg-filter') { S.regFilter = b.dataset.k; return render(); }
  if (action === 'ui-lang') return setPref('lang', b.dataset.lang);
  if (action === 'st-pop') { S.stPop = S.stPop === b.dataset.task ? '' : b.dataset.task; return renderRail(); }
  if (action === 'set-status') {
    S.stPop = ''; renderRail();
    const id = b.dataset.task, task = S.data.tasks.find(x => x.id === id);
    if (!task || task.status === b.dataset.status) return;
    if (await write('task.update', id, { status: b.dataset.status }, Number(b.dataset.rev), 'task:' + id)) toast(t('common.saved'));
    return refresh();
  }
  if (action === 'left-filter') { S.leftFilter = b.dataset.k; store.set('leftFilter', b.dataset.k); return renderRail(); }
  if (action === 'ctx-tab') { setCtxTab(b.dataset.tab); return render(); }
  if (action === 'step-open') { const k = 'sd-' + b.dataset.step, s = S.data.tasks.flatMap(x => x.steps).find(x => x.id === b.dataset.step); S.open[k] = !(s ? stepIsOpen(s) : S.open[k]); if (S.open[k]) S.stepJump = b.dataset.step.split('/')[1]; return render(); }
  if (action === 'step-link') { showStepReport(b.dataset.task, b.dataset.step); return render(); }
  if (action === 'goal-edit') { S.open['goal-' + id] = true; return render(); }
  if (action === 'goal-cancel') { S.open['goal-' + id] = false; delete S.drafts['goal-' + id]; return render(); }
  if (action === 'goal-draft') { const task = S.data.tasks.find(x => x.id === id), cur = S.drafts['goal-' + id] || {}; S.drafts['goal-' + id] = { goal: cur.goal || task.goal || '', output: cur.output || task.draft_output || '', outcome: cur.outcome || task.draft_outcome || '' }; return render(); }
  if (action === 'rebrief-toggle') { S.open['rb-' + id] = !S.open['rb-' + id]; return render(); }
  if (action === 'compose-kind') { // no re-render: the box keeps its focus and caret
    compose(b.dataset.task).kind = b.dataset.kind; saveDraft(b.dataset.task);
    for (const x of b.parentElement.children) x.setAttribute('aria-checked', String(x === b));
    return;
  }
  if (action === 'reply-ask') { focusAsk(b.dataset.task, b.dataset.ask); Object.assign(S.hl, { focus: true }); return render(); }
  if (action === 'ask-card') { // one open ask card at a time; the ask id keeps it open through the 15 s poll
    S.askOpen = S.askOpen === b.dataset.ask ? '' : b.dataset.ask; S.askScroll = true;
    if (S.askOpen) S.hl = { task: route().id, id: S.askOpen, scroll: 'start' }; // the stream shows this question's thread (owner evt-9810)
    return render();
  }
  if (action === 'stream-all') { S.open['stream-' + b.dataset.task] = true; return render(); }
  if (action === 'steps-all' || action === 'hist-all') { const k = `${action}-${b.dataset.task}`; S.open[k] = !S.open[k]; return render(); }
  if (action === 'copy-path') { try { await navigator.clipboard.writeText(b.dataset.path); toast(t('refs.copied')); } catch { toast(t('common.error', { msg: 'clipboard' })); } return; }
  if (action === 'copy-secret') {
    const secret = b.closest('.secret-card')?.querySelector('[data-secret]')?.textContent || '';
    if (secret) { try { await navigator.clipboard.writeText(secret); toast(t('settings.zumi.copied')); } catch { toast(t('common.error', { msg: 'clipboard' })); } }
    return;
  }
  if (action === 'secret-close') return closeSecretOnce();
  if (action === 'confirm-ok') return closeConfirm(true);
  if (action === 'confirm-cancel') return closeConfirm(false);
  if (action === 'zumi-issue') return issueZumiKey();
  if (action === 'zumi-revoke') return revokeZumiKey(id);
  if (action === 'zumi-reissue') return reissueZumiKey(id);
  const r = rev != null ? Number(rev) : undefined;
  b.disabled = true;
  try {
    if (action === 'signout') { if (S.reader) closeReader(false); store.set('token', ''); S.token = ''; S.data = null; S.prefsFrom = ''; S.seenAsks = null; S.revealedSecret = ''; closeSecretOnce(); return render(); }
    if (action === 'signin') { S.data = null; return render(); }
    if (action === 'public') { S.token = ''; return refresh(); }
    if (action === 'answer') {
      const reason = String(b.closest('.row')?.querySelector('input[name=text]')?.value || '').trim();
      return answer(b.dataset.kind, id, r, b.dataset.verdict ? { verdict: b.dataset.verdict, ...(reason ? { text: reason } : {}) } : { choice: b.dataset.choice }, b.dataset.task);
    }
    if (action === 'pick') return pickOption(b.dataset);
    if (action === 'choose-plan') return choosePlan(b.dataset.task, b.dataset.plan);
    if (action === 'merge') { if (await write('inbox.merge', id, { action: b.dataset.merge }, r)) toast(t('common.saved')); }
    if (action === 'clear') { if (await write('ask.clear', id, {}, r)) toast(t('common.saved')); }
    if (action === 'resolve') await write('feedback.resolve', id, {}, r);
    if (action === 'routing-reset') await write('routing.reset', id, {});
    if (action === 'roles-reset') await write('roles.reset', id, { role: b.dataset.role });
    if (action === 'rotate-secret') return setNotify({ rotate_secret: true });
    await refresh();
  } finally { b.disabled = false; }
});
document.addEventListener('submit', async e => {
  const f = e.target.closest('form[data-form]');
  if (!f) return;
  e.preventDefault();
  const fd = new FormData(f), { form, id, rev, kind } = f.dataset;
  if (form === 'signin') {
    const typed = String(fd.get('token') || '').trim();
    S.token = typed;
    const me = await api('api/v1/whoami');
    if (S.token !== typed) return; // signed out, or another key submitted, while whoami was in flight
    if (me.unauthorized) { S.token = ''; return toast(t('auth.invalid')); }
    store.set('token', S.token);
    return refresh();
  }
  if (form === 'compose') return sendCompose(id);
  if (form === 'goal') {
    const v = { goal: String(fd.get('goal') || '').trim(), output: String(fd.get('output') || '').trim(), outcome: String(fd.get('outcome') || '').trim() };
    if (!v.goal || !v.output || !v.outcome) return toast(t('goal.needAll'));
    if (await write('goal.lock', id, v)) { delete S.drafts['goal-' + id]; S.open['goal-' + id] = false; toast(t('goal.lockedToast')); }
    return refresh();
  }
  if (form === 'rebrief') {
    const note = String(fd.get('note') || '').trim(), mode = ['qc', 'status'].includes(fd.get('mode')) ? fd.get('mode') : 'strategy';
    if (await write('rebrief.request', id, { mode, ...(note ? { note } : {}) })) { delete S.drafts['rb-' + id]; S.open['rb-' + id] = false; toast(t('rebrief.sentToast')); }
    return refresh();
  }
  if (form === 'newtask') {
    const title = String(fd.get('title') || '').trim(), text = String(fd.get('text') || '').trim();
    if (!title) return toast(t('newtask.needTitle'));
    if (await write('feedback.add', 'NEW', { kind: 'newtask', text: title + (text ? '\n\n' + text : '') }) && await write('ping.send', 'board', { task_id: 'NEW', note: t('newtask.pingNote', { title: title.slice(0, 80) }) })) {
      delete S.drafts['nt-title']; delete S.drafts['nt-text']; toast(t('newtask.sentToast'));
    }
    return refresh();
  }
  if (form === 'summary') {
    const items = String(fd.get('text') || '').split('\n').map(x => x.trim()).filter(Boolean);
    if (await write('summary.set', 'board', { items }, Number(rev))) { delete S.drafts.summary; toast(t('common.saved')); }
    return refresh();
  }
  if (form === 'webhook') return setNotify({ webhook_url: String(fd.get('url') || '').trim(), delivery: 'webhook' });
});
/** Owner answers an ask from its card (an option, Duyệt or Chưa đạt); a lane proposal is first accepted into an ask
 *  (two writes, both audited). Every answer pings the coordinator at once. */
function setCtxTab(tab) { S.ctxTab = tab; store.set('ctxTab', tab); }
async function answer(kind, id, rev, data, taskId) {
  let askId = id, askRev = rev;
  if (kind === 'proposal') {
    const merged = await write('inbox.merge', id, { action: 'accept' }, rev);
    if (!merged) return;
    askId = merged.result_id; askRev = 1;
  }
  if (await write('ask.answer', askId, data, askRev)) {
    if (taskId) await write('ping.send', 'board', { task_id: taskId, note: data.choice ? t('ping.chose', { task: taskId, key: data.choice }) : '' });
    toast(t(data.choice ? 'answer.sentToast' : 'compose.sent'));
  }
  await refresh();
}
/** A decision card on a step: answers the step's open ask, else records the owner's choice on the step; then one ping. */
async function pickOption({ step, choice, label, ask, rev }) {
  const [taskId, stepId] = [step.slice(0, step.indexOf('/')), step.slice(step.indexOf('/') + 1)];
  if (ask) return answer('ask', ask, Number(rev), { choice }, taskId);
  if (await write('feedback.add', taskId, { kind: 'choice', step_id: stepId, text: t('choice.text', { key: choice, label }) })
    && await write('ping.send', 'board', { task_id: taskId, note: t('ping.chose', { task: taskId, key: choice }) })) toast(t('answer.sentToast'));
  await refresh();
}
async function choosePlan(taskId, planId) {
  const p = (S.data.plans?.[taskId] || []).find(x => x.id === planId), g = goalOf(taskId);
  if (!p) return;
  const text = t('plan.choiceText', { reviewer: p.reviewer }) + (p.verdict ? ' · ' + t('verdict.' + p.verdict) : '') + (p.eta ? ' · ' + t('plan.eta', { eta: p.eta }) : '') + (g ? ' · ' + t('plan.forGoal', { v: g.version }) : '');
  if (await write('feedback.add', taskId, { kind: 'choice', plan_id: planId, text }) && await write('ping.send', 'board', { task_id: taskId, note: t('ping.plan', { task: taskId, reviewer: p.reviewer }) })) toast(t('answer.sentToast'));
  await refresh();
}
/** "Send to the coordinator": saves what is still typed in the composer as a note, then one ping for the batch. */
/** The lightbox picture becomes the full original (scrollable), used when the host gives no popup window. */
function showOriginalInPage(url) {
  const img = document.querySelector('#lightbox .lb-body img');
  if (!img) return;
  img.removeAttribute('data-att'); // loadImages must not put the reduced copy back
  img.src = url;
  document.getElementById('lightbox')?.classList.add('full');
}
/** The original's blob (1-5 MB) lives until the lightbox closes or shows another picture; one at a time, so nothing piles up. */
function revokeOriginal() {
  if (S.origUrl) URL.revokeObjectURL(S.origUrl);
  S.origUrl = '';
}
/** "Open the original": the media sit behind the login, which a bare <a target=_blank> cannot carry, so the page fetches the
 *  file with its own credentials and shows the blob. `ref` is an attachment id, or a media/… path of the predecessor's folder.
 *  The popup is opened first (a popup after an await is blocked). The Zumi app's Board tab denies every popup (window.open
 *  gives null): the original then replaces the picture in the lightbox. The page itself is never navigated to the blob.
 *  Every click fetches again on purpose: it re-checks the login, and the blob is not kept between clicks. */
async function openOriginal(ref) {
  const win = window.open('', '_blank');
  const res = await fetch(/^att-\d+$/.test(ref) ? `api/v1/media/${ref}` : ref, { headers: authHeaders() });
  if (!res.ok) { win?.close(); return toast(t('common.error', { msg: res.status })); }
  revokeOriginal();
  S.origUrl = URL.createObjectURL(await res.blob());
  if (win) win.location = S.origUrl; else showOriginalInPage(S.origUrl);
}

window.addEventListener('hashchange', () => { if (S.reader) closeReader(false); if (S.diagramFull) closeDiagramFull(false); S.wkPop = ''; S.revealedSecret = ''; closeSecretOnce(); S.open.rail = false; S.open.menu = false; store.set('view', location.hash); render(); }); // a revealed webhook secret and the one-time key are shown once
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSecretOnce(); });
document.addEventListener('paste', e => {
  const box = e.target.closest?.('[data-compose-text]');
  if (!box || readOnly()) return;
  const files = [...(e.clipboardData?.items || [])].filter(i => i.kind === 'file' && /^image\//.test(i.type)).map(i => i.getAsFile()).filter(Boolean);
  if (!files.length) return; // plain text pastes as usual
  e.preventDefault(); addImages(box.dataset.composeText, files);
});
document.addEventListener('dragover', e => { const c = e.target.closest?.('.composer'); if (c && !readOnly() && [...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); c.classList.add('drop'); } });
document.addEventListener('dragleave', e => { const c = e.target.closest?.('.composer'); if (c && !c.contains(e.relatedTarget)) c.classList.remove('drop'); });
document.addEventListener('drop', e => {
  const c = e.target.closest?.('.composer');
  if (!c || readOnly()) return;
  e.preventDefault(); c.classList.remove('drop');
  addImages(c.dataset.id, [...(e.dataTransfer?.files || [])].filter(f => /^image\//.test(f.type)));
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyPrefs);
setInterval(() => { if (S.data && document.visibilityState === 'visible' && !document.activeElement?.matches('input,textarea,select') && !mediaPlaying()) refresh(); }, 15000);

(async function boot() {
  consumeFragment();
  // Opening the bare address returns to the page last viewed in this browser, as the predecessor board did.
  if (!location.hash && /^#\/?[A-Za-z]/.test(store.get('view'))) history.replaceState(null, '', location.pathname + store.get('view'));
  S.prefs = loadLocalPrefs();
  S.leftFilter = store.get('leftFilter'); S.ctxTab = store.get('ctxTab');
  applyPrefs();
  await loadLocale(detectLang());
  S.token = store.get('token');
  if (S.token) return refresh();
  // Behind the site's own login the proxy vouches for the owner: no second sign-in.
  const me = await api('api/v1/whoami');
  if (me && me.role) return refresh();
  render();
})();
