// Task detail (T-31 slice 3a-1): one task only, built from exactly that task's board records (board-model.js taskDetail): goal / now /
// next / context, dossier path, steps with their state and history, asks, plan posts and attachments. Read-only: "Open on board" navigates the
// board tab to this task (open-board.js); every edit happens there. Slice 3a-3 adds, through board-data.js only: image thumbnails (w=480) with a
// lightbox (w=1600) inside the panel, and "Open" buttons for the dossier and the links / files the task's text cites. The buttons exist in the
// owner build only; the public build shows the path as text. The host (board-reads.mjs) is the real gate: it opens a target only when it equals
// a ref the board cites, so the target is copied verbatim from refs.js.
import { t, getLocale } from '../../i18n.js';
import { el, whenText } from './dom.js';
import { renderFlow, renderStructure } from './diagram.js';
import { getBoardMedia, openBoardRef } from './board-data.js';
import { collectRefs } from './refs.js';

// Thumbnails and the lightbox hold blob: URLs; every render, and leaving the detail, releases them. `epoch` retires a thumbnail loop that a
// newer render (or a Back) made stale.
let epoch = 0;
const blobUrls = new Set();
let lightbox = null;
const MAX_THUMBS = 24; // per task; the host allows 120 media reads a minute
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']); // what the host serves; anything else gets no preview
const STOP_ON = new Set(['unconfigured', 'locked', 'not_live', 'auth_rejected', 'offline', 'timeout', 'too_large']); // the board cannot serve any image now: stop asking

/** Drops every blob: URL and any open lightbox, and retires pending thumbnail loads. brain.js calls it when the detail is left. */
export function releaseMedia() {
  epoch++;
  closeLightbox();
  for (const u of blobUrls) URL.revokeObjectURL(u);
  blobUrls.clear();
}
const blobUrlOf = (r) => { const u = URL.createObjectURL(new Blob([r.bytes], { type: r.mime })); blobUrls.add(u); return u; };

const section = (titleKey, ...kids) => { const s = el('section', 'nb-sec'); s.appendChild(el('h3', 'nb-sec-h', t(titleKey))); s.append(...kids); return s; };
const textBlock = (v) => el('p', 'nb-text', v);

function stepsList(steps) {
  const ol = el('ol', 'nb-steps');
  for (const s of steps) {
    const li = el('li', `nb-step st-${s.state}${s.current ? ' current' : ''}`);
    li.dataset.step = s.id;
    const top = el('div', 'nb-step-top');
    top.append(el('span', `nb-chip st-${s.state}`, t(`brain.step.${s.state}`)), el('span', 'nb-step-label', s.label), el('span', 'nb-zone', t(`brain.zone.${s.zone}`)));
    li.appendChild(top);
    if (s.sub) li.appendChild(el('div', 'nb-mute', s.sub));
    if (s.detail) li.appendChild(el('div', 'nb-text nb-step-detail', s.detail));
    if (s.history.length) {
      const d = el('details', 'nb-hist');
      d.appendChild(el('summary', null, t('brain.detail.history', { n: s.history.length })));
      for (const h of s.history) d.appendChild(el('div', 'nb-hist-line', `${whenText(h.at, getLocale())}  ${t(`brain.step.${h.from}`)} → ${t(`brain.step.${h.to}`)}`));
      li.appendChild(d);
    }
    ol.appendChild(li);
  }
  return ol;
}

function asksList(asks) {
  const ul = el('ul', 'nb-asks');
  for (const a of asks) {
    const li = el('li', `nb-ask ${a.status === 'open' ? 'open' : 'done'}`);
    li.dataset.ask = a.id;
    const top = el('div', 'nb-step-top');
    top.append(el('span', `nb-chip ${a.status === 'open' ? 'q' : 'st-done'}`, t(a.status === 'open' ? 'brain.detail.askOpen' : 'brain.detail.askAnswered')), el('span', 'nb-ask-text', a.text || ''));
    li.appendChild(top);
    if (Array.isArray(a.options) && a.options.length) {
      const opts = el('div', 'nb-opts');
      for (const o of a.options) opts.appendChild(el('span', 'nb-chip', `${o.key}: ${o.label}`));
      li.appendChild(opts);
    }
    if (a.answer && (a.answer.text || a.answer.choice)) li.appendChild(el('div', 'nb-mute', t('brain.detail.answer', { text: a.answer.text || a.answer.choice })));
    ul.appendChild(li);
  }
  return ul;
}

function plansList(plans) {
  const wrap = el('div', 'nb-plans');
  plans.forEach((p) => {
    const d = el('details', 'nb-plan');
    d.dataset.plan = p.id;
    d.open = true; // R2: the detail is always the full-screen card now, with room for every plan open (each still folds by its summary)
    const sum = el('summary');
    sum.append(el('b', null, p.reviewer || ''));
    if (p.verdict) sum.appendChild(el('span', 'nb-chip', t(`brain.verdict.${p.verdict}`)));
    if (p.eta) sum.appendChild(el('span', 'nb-mute', t('brain.detail.eta', { eta: p.eta })));
    const when = whenText(p.posted_at, getLocale());
    if (when) sum.appendChild(el('span', 'nb-when', when));
    d.append(sum, el('p', 'nb-text', p.body || ''));
    wrap.appendChild(d);
  });
  return wrap;
}

function closeLightbox() {
  if (!lightbox) return;
  document.removeEventListener('keydown', lightbox.onKey, true);
  if (lightbox.url) { URL.revokeObjectURL(lightbox.url); blobUrls.delete(lightbox.url); }
  lightbox.node.remove();
  lightbox = null;
}

/** The enlarged image (w=1600), inside the Brain card so it never leaves the panel. Esc, the Close button or a click outside the picture closes it. */
async function openLightbox(card, m) {
  closeLightbox();
  const node = el('div', 'nb-lightbox');
  node.setAttribute('role', 'dialog'); node.setAttribute('aria-modal', 'true'); node.setAttribute('aria-label', t('brain.media.lightbox'));
  const bar = el('div', 'nb-lb-bar');
  const close = el('button', 'nb-back', t('brain.media.close'));
  close.type = 'button';
  bar.append(el('span', 'nb-att-name', m.name || m.id), el('span', 'nb-sp'), close);
  const stage = el('div', 'nb-lb-stage');
  stage.appendChild(el('p', 'nb-mute', t('brain.media.loading')));
  node.append(bar, stage);
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeLightbox(); } };
  const mine = { node, url: null, onKey };
  lightbox = mine;
  document.addEventListener('keydown', onKey, true);
  close.addEventListener('click', closeLightbox);
  node.addEventListener('click', (e) => { if (e.target === node || e.target === stage) closeLightbox(); });
  card.appendChild(node);
  close.focus();
  const r = await getBoardMedia(m.id, 1600);
  if (lightbox !== mine) return; // closed (or replaced) while loading
  stage.textContent = '';
  if (!r.ok) { stage.appendChild(el('p', 'nb-mute', t('brain.media.failed', { reason: r.reason }))); return; }
  mine.url = blobUrlOf(r);
  const img = el('img', 'nb-lb-img');
  img.alt = m.name || m.id; img.src = mine.url;
  stage.appendChild(img);
}

/** Loads the thumbnails one after the other (never more than one media read in flight from here). */
async function loadThumbs(items, card, mine) {
  let stopped = null;
  for (const { m, slot } of items) {
    if (mine !== epoch) return;
    const fail = (reason) => slot.replaceChildren(el('span', 'nb-mute nb-thumb-msg', t('brain.media.failed', { reason })));
    if (stopped) { fail(stopped); continue; }
    const r = await getBoardMedia(m.id, 480);
    if (mine !== epoch) return;
    if (!r.ok) { if (STOP_ON.has(r.reason)) stopped = r.reason; fail(r.reason); continue; }
    const btn = el('button', 'nb-thumb-btn');
    btn.type = 'button'; btn.title = t('brain.media.zoom', { name: m.name || m.id }); btn.setAttribute('aria-label', t('brain.media.zoom', { name: m.name || m.id }));
    const img = el('img', 'nb-thumb');
    img.alt = ''; img.src = blobUrlOf(r);
    btn.appendChild(img);
    btn.addEventListener('click', () => openLightbox(card, m));
    slot.replaceChildren(btn);
  }
}

function mediaList(media, thumbs) {
  const ul = el('ul', 'nb-media');
  for (const m of media) {
    const li = el('li', 'nb-att');
    li.dataset.att = m.id;
    const top = el('div', 'nb-step-top');
    top.append(el('span', 'nb-att-name', m.name || m.id), el('span', 'nb-chip', m.mime || ''));
    if (Number.isFinite(m.size)) top.appendChild(el('span', 'nb-mute', t('brain.detail.kb', { n: Math.max(1, Math.round(m.size / 1024)) })));
    li.appendChild(top);
    if (IMAGE_TYPES.has(m.mime) && thumbs.length < MAX_THUMBS) {
      const slot = el('div', 'nb-thumb-slot');
      slot.appendChild(el('span', 'nb-mute nb-thumb-msg', t('brain.media.loading')));
      li.appendChild(slot);
      thumbs.push({ m, slot });
    }
    if (m.caption) li.appendChild(el('div', 'nb-mute', m.caption));
    ul.appendChild(li);
  }
  return ul;
}

/** One cited link or file: its label and target as text; in the owner build also an Open button (host call, target verbatim). */
function refRow(ref, owner) {
  const row = el('div', 'nb-ref');
  row.dataset.refKind = ref.kind;
  const head = el('div', 'nb-step-top');
  head.append(el('span', 'nb-chip', ref.kind === 'url' ? 'LINK' : 'FILE'), el('span', 'nb-ref-label', ref.label));
  if (owner) {
    const btn = el('button', 'nb-ref-open', t('brain.ref.open'));
    btn.type = 'button'; btn.title = t('brain.ref.openHint');
    const msg = el('div', 'nb-mute nb-ref-msg');
    msg.setAttribute('role', 'status');
    btn.addEventListener('click', async () => {
      btn.disabled = true; msg.textContent = '';
      const r = await openBoardRef({ kind: ref.kind, target: ref.target }); // verbatim: the host matches it exactly against what the board cites
      if (!r.opened) msg.textContent = t('brain.ref.failed', { reason: r.reason });
      btn.disabled = false;
    });
    head.appendChild(btn);
    row.append(head, el('div', 'nb-text nb-path', ref.target), msg);
  } else {
    row.append(head, el('div', 'nb-text nb-path', ref.target)); // public build: the path as text, nothing to click
  }
  return row;
}

/** Fills `host` with one task's detail. `model` = taskDetail(state, id) (not null). `owner` = the owner build (Open buttons). */
export function renderDetail(host, model, { onBack, onOpenBoard, owner = false }) {
  releaseMedia();
  const mine = epoch;
  const refs = collectRefs(model);
  const thumbs = [];
  host.textContent = '';
  const top = el('div', 'nb-dtop');
  const back = el('button', 'nb-back', `‹ ${t('brain.detail.back')}`);
  back.type = 'button';
  back.addEventListener('click', onBack);
  const open = el('button', 'nb-open', t('brain.detail.openBoard'));
  open.type = 'button'; open.title = t('brain.detail.openBoardHint');
  open.addEventListener('click', () => onOpenBoard(model.id));
  top.append(back, el('span', 'nb-sp'), open);

  const head = el('div', 'nb-dhead');
  head.dataset.task = model.id;
  head.appendChild(el('h2', 'nb-dtitle', model.title));
  const meta = el('div', 'nb-row-sub');
  const dot = el('i', `nb-health ${model.health}`);
  dot.setAttribute('role', 'img'); dot.setAttribute('aria-label', t(`brain.health.${model.health}`)); dot.title = t(`brain.health.${model.health}`);
  meta.append(el('span', 'nb-id', model.id), dot, el('span', `nb-chip st-${model.status}`, t(`brain.status.${model.status}`)));
  if (model.lane) meta.appendChild(el('span', 'nb-lane', model.lane));
  if (model.needsOwner) meta.appendChild(el('span', 'nb-chip q', t('brain.lib.needsYou')));
  const when = whenText(model.lastActivity, getLocale());
  if (when) { meta.appendChild(el('span', 'nb-sp')); meta.appendChild(el('span', 'nb-when', t('brain.lib.updated', { when }))); }
  head.appendChild(meta);
  // R2: two columns in the full card (brain.css .nx-brain-full): the task text left, the step flow, structure and plans right. A wrapper per
  // column (not a class per section on one grid) so a tall diagram never stretches a row of the text column.
  const colL = el('div', 'nb-col-l'), colR = el('div', 'nb-col-r');
  host.append(top, head, colL, colR);

  if (model.goal) colL.appendChild(section('brain.detail.goal', textBlock(model.goal)));
  if (model.now) colL.appendChild(section('brain.detail.now', textBlock(model.now)));
  if (model.next) colL.appendChild(section('brain.detail.next', textBlock(model.next)));
  if (model.context) colL.appendChild(section('brain.detail.context', textBlock(model.context)));
  if (model.dossier) colL.appendChild(section('brain.detail.dossier', owner ? refRow(refs.find((r) => r.dossier), owner) : el('p', 'nb-text nb-path', model.dossier)));
  const cited = refs.filter((r) => !r.dossier);
  if (cited.length) colL.appendChild(section('brain.detail.refs', ...cited.map((r) => refRow(r, owner))));
  colL.appendChild(section('brain.detail.steps', model.steps.length ? stepsList(model.steps) : el('p', 'nb-empty', t('brain.detail.noSteps'))));
  // The board's own layout (vendored diagram.js) drawn as SVG: the step flow of this task's steps, and its structure diagram if it has one.
  colR.appendChild(section('brain.detail.flow', renderFlow(model.task) || el('p', 'nb-empty', t('brain.detail.noFlow'))));
  colR.appendChild(section('brain.detail.structure', renderStructure(model.task.architecture) || el('p', 'nb-empty', t('brain.detail.noStructure'))));
  if (model.asks.length) colL.appendChild(section('brain.detail.asks', asksList(model.asks)));
  if (model.plans.length) colR.appendChild(section('brain.detail.plans', plansList(model.plans)));
  if (model.media.length) colL.appendChild(section('brain.detail.media', mediaList(model.media, thumbs)));
  if (thumbs.length) loadThumbs(thumbs, host.closest('.nx-brain') || host, mine);
}
