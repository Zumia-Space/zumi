// A small, safe Markdown subset for text agents write on the board (step details, context, feedback, asks).
// Safety: the source is never inserted as HTML. Every piece of text is escaped, and the only tags that reach the page
// are the ones this file writes. Links are made only for http(s) and mailto URLs; anything else stays plain text.
//
// Blocks: paragraphs (single newlines kept), # headings, --- rules, > quotes, ``` fences, - * + and 1. lists (nested by
// indent), and pipe tables. A list of 3+ items that all split into the same 3+ fields on " | ", " — " or " · " is a
// list of records (jobs, candidates, posts) and renders as a table too. Inline: `code`, **bold**, *italic*,
// [label](url), ![alt](media/name) and bare URLs, which show as a short label (host › last path part) with the full
// URL in the title and href.
//
// Loaded as a classic script in the browser (sets window.LaneMarkdown) and importable in Node for tests.
(function (root) {
  'use strict';
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const SAFE_URL = /^(https?:\/\/|mailto:)/i;

  /** "https://web.facebook.com/groups/1/posts/1001" -> "facebook.com › 1001"; the full URL goes in the title. */
  function shortUrl(url) {
    let u;
    try { u = new URL(url); } catch { return url.length > 40 ? url.slice(0, 39) + '…' : url; }
    if (u.protocol === 'mailto:') return u.pathname;
    const host = u.host.replace(/^(www|web|m)\./, '');
    let last = u.pathname.split('/').filter(Boolean).pop() || '';
    try { last = decodeURIComponent(last); } catch { /* keep as written */ }
    if (last.length > 28) last = last.slice(0, 27) + '…';
    return last ? `${host} › ${last}` : host;
  }
  const link = (href, labelHtml) => `<a href="${esc(href)}" title="${esc(href)}" target="_blank" rel="noopener noreferrer">${labelHtml}</a>`;

  // One pass over the raw text; text between matches is escaped. Order = precedence.
  const INLINE = /`([^`\n]+)`|!\[([^\]\n]*)\]\(([^)\s]+)\)|\[([^\]\n]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>()[\]|"'`]*[^\s<>()[\]|"'`.,;:!?])|\*\*([^*\n]+?)\*\*|(?<![\w*])\*([^*\s][^*\n]*?)\*(?![\w*])/g;
  function inline(src, ctx) {
    const s = String(src ?? '');
    let out = '', last = 0;
    for (const m of s.matchAll(INLINE)) {
      out += esc(s.slice(last, m.index));
      last = m.index + m[0].length;
      if (m[1] != null) out += `<code>${esc(m[1])}</code>`;
      else if (m[3] != null) out += media(m[2], m[3], ctx);
      else if (m[5] != null) out += SAFE_URL.test(m[5]) ? link(m[5], SAFE_URL.test(m[4]) ? esc(shortUrl(m[4])) : inline(m[4], ctx)) : esc(m[0]);
      else if (m[6] != null) out += link(m[6], esc(shortUrl(m[6])));
      else if (m[7] != null) out += `<strong>${inline(m[7], ctx)}</strong>`;
      else out += `<em>${inline(m[8], ctx)}</em>`;
    }
    return out + esc(s.slice(last));
  }
  /** ![alt](media/name.png): the board attachment of that name when the caller can resolve it, else a labelled chip. */
  function media(alt, src, ctx) {
    const name = src.replace(/^media\//, '');
    const att = ctx.resolveMedia ? ctx.resolveMedia(name) : null;
    if (att) return `<img class="md-img" data-att="${esc(att)}" alt="${esc(alt || name)}" title="${esc(alt || name)}">`;
    if (SAFE_URL.test(src)) return link(src, esc(alt || shortUrl(src)));
    return `<span class="chip md-file" title="${esc(src)}">${esc(alt || name)}</span>`;
  }

  const LIST = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
  const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
  const cells = line => line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'));
  const plain = s => String(s).replace(/[`*]/g, '');

  function table(head, rows, ctx) {
    const labels = head.map(plain);
    const th = head.some(Boolean) ? `<thead><tr>${head.map(h => `<th>${inline(h, ctx)}</th>`).join('')}</tr></thead>` : '';
    const body = rows.map(r => `<tr>${labels.map((l, i) => `<td data-label="${esc(l)}"><span class="cell">${inline(r[i] ?? '', ctx)}</span></td>`).join('')}</tr>`).join('');
    return `<div class="md-table-wrap"><table class="md-table${th ? '' : ' no-head'}">${th}<tbody>${body}</tbody></table></div>`;
  }

  /** A flat list whose items all split into the same number (>= 3) of fields on one separator -> rows of a table. */
  function recordRows(items) {
    if (items.length < 3 || items.some(it => it.children.length)) return null;
    for (const sep of [' | ', ' — ', ' · ']) {
      const rows = items.map(it => it.text.split(sep).map(x => x.trim()));
      if (rows[0].length >= 3 && rows.every(r => r.length === rows[0].length)) return rows;
    }
    return null;
  }

  function list(items, ctx) {
    const rows = recordRows(items);
    if (rows) return table(rows[0].map(() => ''), rows, ctx);
    const tag = items[0].ordered ? 'ol' : 'ul';
    return `<${tag}>${items.map(it => `<li>${inline(it.text, ctx)}${it.children.length ? list(it.children, ctx) : ''}</li>`).join('')}</${tag}>`;
  }

  /** Consecutive list lines from lines[i] -> [nested items, next index]. Indented or wrapped lines continue an item. */
  function readList(lines, i) {
    const flat = [];
    while (i < lines.length) {
      const line = lines[i];
      const m = line.match(LIST);
      if (m && flat.length && m[1].length <= flat[0].indent && /\d/.test(m[2]) !== flat[0].ordered) break; // - list then 1. list
      if (m) { flat.push({ indent: m[1].replace(/\t/g, '  ').length, ordered: /\d/.test(m[2]), text: m[3], children: [] }); i++; continue; }
      if (!line.trim()) { // a blank line inside a list: keep going only if another item follows
        let j = i; while (j < lines.length && !lines[j].trim()) j++;
        if (j < lines.length && LIST.test(lines[j])) { i = j; continue; }
        break;
      }
      // continuation: right after an item line, or indented after a blank line
      if (flat.length && !isBlockStart(line) && (lines[i - 1].trim() || /^\s{2,}/.test(line))) { flat.at(-1).text += ' ' + line.trim(); i++; continue; }
      break;
    }
    const top = [], stack = [];
    for (const it of flat) {
      while (stack.length && stack.at(-1).indent >= it.indent) stack.pop();
      (stack.length ? stack.at(-1).children : top).push(it);
      stack.push(it);
    }
    return [top, i];
  }
  const isBlockStart = line => /^\s{0,3}(#{1,6}\s|>|```|\|)/.test(line) || /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line);

  function blocks(src, ctx, depth = 0) {
    const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      let m;
      if (/^\s*```/.test(line)) {
        const buf = [];
        for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) buf.push(lines[i]);
        i++;
        out.push(`<pre class="md-pre"><code>${esc(buf.join('\n'))}</code></pre>`);
      } else if ((m = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/))) {
        out.push(`<p class="md-h md-h${Math.min(m[1].length, 3)}">${inline(m[2], ctx)}</p>`); i++;
      } else if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        out.push('<hr class="md-hr">'); i++;
      } else if (/^\s*\|/.test(line) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
        const head = cells(line), rows = [];
        for (i += 2; i < lines.length && /^\s*\|/.test(lines[i]); i++) rows.push(cells(lines[i]));
        out.push(table(head, rows, ctx));
      } else if (/^\s*>/.test(line) && depth < 3) {
        const buf = [];
        for (; i < lines.length && /^\s*>/.test(lines[i]); i++) buf.push(lines[i].replace(/^\s*>\s?/, ''));
        out.push(`<blockquote>${blocks(buf.join('\n'), ctx, depth + 1)}</blockquote>`);
      } else if (LIST.test(line)) {
        const [items, next] = readList(lines, i);
        out.push(list(items, ctx)); i = next;
      } else {
        const buf = [];
        for (; i < lines.length && lines[i].trim() && !isBlockStart(lines[i]) && !LIST.test(lines[i]); i++) buf.push(inline(lines[i].trim(), ctx));
        if (!buf.length) { buf.push(inline(lines[i].trim(), ctx)); i++; } // a lone '|' line that is not a table
        out.push(`<p>${buf.join('<br>')}</p>`);
      }
    }
    return out.join('');
  }

  // Refs: the images and links an agent attached to an ask or a card line (the CoS CLI writes them, cos-board.mjs
  // ask --img/--link). They travel as the text's last line(s), so a board that predates them still shows them as
  // plain links and paths: tokens joined by " · ", each one of
  //   [label](https://…)                a link; one to …/media/<name>.png|jpg|jpeg|webp|gif is an image (label = caption)
  //   `D:/path/file.md`, label `D:/…`   a path on the owner's computer (a "local" link)
  const REF_LINK = /^\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)$/;
  const REF_LOCAL = /^(?:([^`\n]*?) )?`([A-Za-z]:[\\/][^`\n]*)`$/;
  // A ref's label is a NAME ("Morning pack `D:/…`"). A colon or a sentence mark in front of the path means the line is
  // prose that ends on a path — "Kế hoạch: `D:/…/PLAN.md`", how cos-board writes an ask — so it is not a refs line. Before
  // this, that whole question was popped as one label and its text vanished: ask-6568 on V-03 showed a chip and no question.
  const PROSE_LABEL = /[:;,.!?…]$/;
  const MEDIA_URL = /\/media\/([\w.-]+\.(?:png|jpe?g|webp|gif))$/i;
  const baseName = p => { const parts = p.replace(/\\/g, '/').split('/').filter(Boolean); const last = parts.pop() || p; return /[\\/]$/.test(p) ? last + '/' : last; };
  /** One key per ref for de-duplication: slashes written one way, runs of slashes folded (never after "://"), and case
   *  folded where it does not matter -- a local path whole, a URL only in its scheme and host (its path is case-sensitive).
   *  An image is keyed by its name (two media URLs may name the same file). */
  const normRef = s => { const t = String(s ?? '').replace(/\\/g, '/').replace(/([^:])\/{2,}/g, '$1/'); return /^[a-z]+:\/\//i.test(t) ? t.replace(/^([a-z]+:\/\/[^/?#]+)(.*)$/i, (_, host, rest) => host.toLowerCase() + rest) : t.toLowerCase(); };
  const refKey = r => r.image ? 'img:' + normRef(r.image.name) : 'link:' + normRef(r.link.url);
  /** text -> { body, images: [{ name, caption, url }], links: [{ label, url, local }] }; body is the text without its
   *  trailing ref lines. A text without refs comes back whole with empty lists. */
  function splitRefs(src) {
    const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
    const found = [], seen = new Set();
    while (lines.length) {
      const last = lines[lines.length - 1].trim();
      if (!last) { lines.pop(); continue; }
      const toks = last.split(' · ').map(s => s.trim()).filter(Boolean);
      const refs = toks.map(tk => {
        let m = REF_LINK.exec(tk);
        if (m) { const img = MEDIA_URL.exec(m[2]); return img ? { image: { name: img[1], caption: m[1], url: m[2] } } : { link: { label: m[1], url: m[2], local: false } }; }
        m = REF_LOCAL.exec(tk);
        if (m && m[1] && PROSE_LABEL.test(m[1].trim())) return null; // a sentence that ends on a path, not a labelled ref
        return m ? { link: { label: (m[1] || '').trim() || baseName(m[2]), url: m[2].replace(/\\/g, '/'), local: true } } : null;
      });
      if (!toks.length || !refs.every(Boolean)) break;
      const kept = [];
      for (const r of refs) { const k = refKey(r); if (seen.has(k)) continue; seen.add(k); kept.push(r); }
      found.unshift(...kept);
      lines.pop();
    }
    if (!found.length) return { body: String(src ?? ''), images: [], links: [] };
    return { body: lines.join('\n').trimEnd(), images: found.filter(r => r.image).map(r => r.image), links: found.filter(r => r.link).map(r => r.link) };
  }

  const api = {
    /** Block Markdown -> safe HTML. ctx.resolveMedia(name) -> attachment id | null. */
    render: (src, ctx = {}) => blocks(src, ctx),
    /** One line of text (an ask, a card's "now") -> safe HTML with links and emphasis, no blocks. */
    inline: (src, ctx = {}) => inline(src, ctx),
    splitRefs,
    shortUrl
  };
  root.LaneMarkdown = api;
})(typeof window !== 'undefined' ? window : globalThis);
