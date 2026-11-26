// T-31 15-11: the important-news feed, one canonical reader for every surface (the board page's Home here, the Zumi phone app, the
// desktop app's Board tab, which hosts this page). It reads the board view as the server sends it (messages + feedback + tasks) and
// never recomputes a status: it only picks, orders and filters what the board already holds.
//   items(view, { showStatus, limit })  -> { items: [...newest first], hidden: n }  (n = status noise left out)
//   html(result, { labels, showStatus }) -> the feed as escaped HTML (the caller passes its own labels: no UI text lives here)
//   isStatusNoise(message, feedback)     -> true for a status re-brief request or a receipt whose change is "không đổi"
// News = what the coordinator, the lanes and the board wrote (replies, notes, receipts, lane reports, re-briefs, and the CoS's own
// cos-report / cos-event, on a task or on the board-wide NEWS thread). The owner's own messages are not news to him and are left out.
// Supervisor noise never shows here, toggle or not (T-31-MOBILE B2): nudges of every level (R1 -> L2 -> L3 chains, R3 duplicate asks)
// and idle notices stay in the task's row log and the supervisor view. Each item links a task: its own thread, or for a NEWS item
// its first related task (`tasks`); a NEWS item with no related task is not a link (#/task/NEWS is no route).
// Status noise (owner 15-11: "các thông báo rebrieft này bị thừa và lặp lại") is hidden unless showStatus ("Hiện cả nhắc trạng thái").
// Loaded as a classic script in the browser (sets window.LaneNews) and importable in Node for tests.
(function (root) {
  'use strict';
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const NO_CHANGE = /^[\s(\[*_-]*(không\s+(?:thay\s+)?đổi|khong\s+(?:thay\s+)?doi|no\s+change|unchanged)\b/i;
  const LEAD = /^\s*(?:\*\*)?Chốt\b/i;

  /** A status re-brief request (the board's own or a manual one), or a receipt whose change line says nothing changed. */
  function isStatusNoise(m, f) {
    if (m.kind === 'rebrief') return (f && f.mode) === 'status';
    if (m.kind === 'receipt') return NO_CHANGE.test(String(m.receipt?.change ?? '').normalize('NFC'));
    return false;
  }
  // The board's own sweep writes as { name: 'system', role: 'owner' }: a board notice, not the owner's words. A status request the
  // owner sent himself is a status reminder too: shown with the toggle, like the board's.
  const ownerWrote = (m, f) => m.author?.role === 'owner' && m.author?.name !== 'system' && !isStatusNoise(m, f);
  const idNum = id => Number(String(id).replace(/^\D+/, '')) || 0;
  const NEWS_THREAD = 'NEWS';
  /** The supervisor's own notices (src/supervisor.mjs): a nudge at any level, or guard B4's idle notice (the root of an R4 chain).
   *  msgKind is the predecessor API's name for the same field. */
  const isSupervisorNoise = m => m.kind === 'nudge' || m.msgKind === 'nudge' || m.kind === 'idle';

  function items(view, { showStatus = false, limit = 50 } = {}) {
    const fb = new Map((view?.feedback || []).map(f => [f.id, f]));
    const titles = new Map((view?.tasks || []).map(t => [t.id, t.title || '']));
    let hidden = 0;
    const out = [];
    for (const m of view?.messages || []) {
      const f = fb.get(m.id);
      if (ownerWrote(m, f) || isSupervisorNoise(m)) continue;
      const status = isStatusNoise(m, f);
      if (status && !showStatus) { hidden++; continue; }
      const lines = String(m.body || '').replace(/\r\n?/g, '\n').split('\n');
      const leadAt = lines.findIndex(l => LEAD.test(l));
      const link = m.task_id === NEWS_THREAD ? (m.tasks || [])[0] || '' : m.task_id;
      out.push({
        id: m.id, task_id: m.task_id, link, title: titles.get(link) || '', kind: m.kind, at: m.ts, author: m.author?.name || '', status,
        ...(m.tasks ? { tasks: m.tasks } : {}),
        lead: leadAt >= 0 ? lines[leadAt].replace(/\*\*/g, '').trim() : '',
        body: (leadAt >= 0 ? lines.filter((_, i) => i !== leadAt) : lines).join('\n').trim(),
        ...(m.receipt ? { receipt: m.receipt } : {}), ...(f?.mode ? { mode: f.mode } : {}), ...(f?.auto ? { auto: true } : {}),
      });
    }
    out.sort((a, b) => b.at.localeCompare(a.at) || idNum(b.id) - idNum(a.id));
    return { items: out.slice(0, limit), hidden };
  }

  /** labels: { title, toggle, empty, kind(k) -> word, when(iso) -> text (optional) }. */
  function html(result, { labels, showStatus = false } = {}) {
    const L = labels || {};
    const kindWord = k => (typeof L.kind === 'function' ? L.kind(k) : k) || k;
    const when = iso => (typeof L.when === 'function' ? L.when(iso) : iso);
    const toggleText = `${L.toggle || ''}${result.hidden ? ` (${result.hidden})` : ''}`;
    const row = x => {
      // A task-thread item opens that message in its task; a NEWS item opens its first related task (the message is not in it).
      const link = x.link ?? x.task_id;
      const href = link ? `#/task/${encodeURIComponent(link)}${link === x.task_id ? `?msg=${encodeURIComponent(x.id)}` : ''}` : '';
      const body = x.receipt ? [x.receipt.change, x.receipt.next].filter(Boolean).join(' · ') : x.body;
      const inner = `<span class="news-meta">${link ? `<span class="code">${esc(link)}</span> ` : ''}<span class="chip">${esc(kindWord(x.kind))}</span> <span class="muted">${esc(when(x.at))}</span></span>`
        + (x.title ? `<span class="news-title">${esc(x.title)}</span>` : '')
        + (x.lead ? `<b class="news-lead">${esc(x.lead)}</b>` : '')
        + (body ? `<span class="news-body">${esc(body)}</span>` : '');
      return `<li class="news-item news-${esc(x.kind)}${x.status ? ' news-status' : ''}">`
        + (href ? `<a class="news-link" href="${esc(href)}" data-task="${esc(link)}" data-msg="${esc(x.id)}">${inner}</a>` : `<div class="news-link">${inner}</div>`)
        + '</li>';
    };
    return `<section class="card news" aria-label="${esc(L.title || '')}"><div class="news-head"><h2>${esc(L.title || '')}</h2>`
      + `<button type="button" class="btn news-toggle" data-action="news-status" aria-pressed="${showStatus ? 'true' : 'false'}">${esc(toggleText)}</button></div>`
      + (result.items.length ? `<ol class="news-list">${result.items.map(row).join('')}</ol>` : `<p class="empty">${esc(L.empty || '')}</p>`)
      + '</section>';
  }

  root.LaneNews = { items, html, isStatusNoise };
})(typeof window !== 'undefined' ? window : globalThis);
