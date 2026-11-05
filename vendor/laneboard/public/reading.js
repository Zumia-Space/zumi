// Reading helpers for the board page (T-31 board-read): small pure functions, so Node tests them directly.
// Loaded as a classic script in the browser (sets window.LaneReading) and importable in Node (sets globalThis.LaneReading).
(function (root) {
  'use strict';

  /** A clamped block hides text when its content is taller than its box (1px slack for rounding). */
  const clampOverflows = (scrollHeight, clientHeight) => scrollHeight > clientHeight + 1;

  // A heading is a summary when its text starts with "Tóm tắt" or "TL;DR" (any level, any case, markdown emphasis ignored).
  const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t#]*$/;
  const FENCE = /^ {0,3}(```|~~~)/;
  const SUMMARY = /^(?:t[óo]m t[ắa]t|tl;?dr)(?![\p{L}\p{N}])/iu;
  const plain = s => s.replace(/[*_`]/g, '').normalize('NFC').trim();

  /**
   * The summary section of a markdown text, if it has one.
   * Returns { summary, full }: `full` is the text as given; `summary` is the section (its heading line to the next heading of the
   * same or a higher level, or the end), or null when there is none, when it has no body, or when it already is the whole text.
   * Headings inside a code fence do not count. The first matching heading wins.
   */
  function splitTldr(md) {
    const full = String(md ?? '');
    const lines = full.replace(/\r\n?/g, '\n').split('\n');
    let fence = false, from = -1, level = 0;
    for (let i = 0; i < lines.length; i++) {
      if (FENCE.test(lines[i])) { fence = !fence; continue; }
      if (fence) continue;
      const m = HEADING.exec(lines[i]);
      if (!m) continue;
      if (from >= 0) {
        if (m[1].length <= level) { return finish(lines, from, i, full); }
        continue;
      }
      if (SUMMARY.test(plain(m[2]))) { from = i; level = m[1].length; }
    }
    return from >= 0 ? finish(lines, from, lines.length, full) : { summary: null, full };
  }
  function finish(lines, from, to, full) {
    const section = lines.slice(from, to).join('\n').trimEnd();
    const body = lines.slice(from + 1, to).join('\n').trim();
    const whole = section.trim() === full.replace(/\r\n?/g, '\n').trim();
    return { summary: body && !whole ? section : null, full };
  }

  const attNum = a => Number(/(\d+)$/.exec(String(a?.id ?? ''))?.[1] ?? -1);
  const fwd = p => String(p || '').replace(/\\/g, '/').toLowerCase(); // Windows paths: slash and case do not matter
  const sameFile = (x, y) => fwd(x) === fwd(y);
  // The types md-attach copies and the page can show, and how it opens each: markdown in the reader, images in the
  // lightbox, mp4 in a <video>. One classifier, so the lookup and the open button never disagree.
  const attKind = mime => {
    const m = String(mime || '');
    if (/^text\/markdown$/i.test(m)) return 'md';
    if (/^image\/(?:png|jpeg|webp|gif)$/i.test(m)) return 'image';
    if (/^video\/mp4$/i.test(m)) return 'video';
    return null;
  };
  /**
   * The attached copy a local link's open button shows: the newest attachment of the task whose caption is the file's path
   * (cos-board writes it that way, J-05 md-attach) and whose mime the page can display. Newest = highest att-N, so a changed
   * file's re-upload wins. `kind` narrows it to one opening ('md' / 'image' / 'video'). Returns the attachment or null (the
   * chip then stays a copy-path / open link).
   */
  function pickAttachment(attachments, taskId, filePath, kind = null) {
    let best = null;
    for (const a of attachments || []) {
      const k = attKind(a.mime);
      if (a.task_id !== taskId || !k || (kind && k !== kind) || !sameFile(a.caption, filePath)) continue;
      if (!best || attNum(a) > attNum(best)) best = a;
    }
    return best;
  }
  /** The markdown copy a local .md chip opens in the reader, or null (only .md paths; another type is never read as text). */
  function pickMdAttachment(attachments, taskId, filePath) {
    if (!/\.md$/i.test(String(filePath || ''))) return null;
    return pickAttachment(attachments, taskId, filePath, 'md');
  }

  // An absolute Windows .md path in agent text: in a code span (how cos-board writes "Chi tiết: `D:/…/file.md`"), or bare. The
  // pattern refuses &, quotes and < > (an escaped entity can never be part of a path we turn into a button).
  const CODE_DOC = /(?<!<pre\b[^>]*>)<code>([A-Za-z]:[\\/][^<>&"']*?\.md)<\/code>/gi;
  const BARE_DOC = /(?<![\w/\\.:-])([A-Za-z]:[\\/][^\s<>&"'`|*?]*?\.md)(?![\w/\\-])/gi;
  const OPENS = /^<(a|button|code|pre)\b/i, CLOSES = /^<\/(a|button|code|pre)\s*>/i;
  /**
   * Safe, already-escaped HTML in, HTML out: every local .md path that `render(path)` answers with HTML (a reader button, built by the
   * caller from the board's own attachment) is replaced by that HTML; a path it answers null for is left exactly as it was. Text inside
   * a link, a button, a code block is never touched except the code span that holds only the path. This function never writes a URL:
   * it cannot make a javascript:/data: link, only swap text for what `render` returns.
   */
  function linkDocPaths(html, render) {
    const swapped = String(html ?? '').replace(CODE_DOC, (all, p) => render(p) ?? all);
    let depth = 0;
    return swapped.split(/(<[^>]*>)/).map(part => {
      if (part.startsWith('<')) { if (OPENS.test(part)) depth++; else if (CLOSES.test(part)) depth = Math.max(0, depth - 1); return part; }
      return depth ? part : part.replace(BARE_DOC, (all, p) => render(p) ?? all);
    }).join('');
  }

  root.LaneReading = { clampOverflows, splitTldr, attKind, pickAttachment, pickMdAttachment, linkDocPaths };
})(typeof window !== 'undefined' ? window : globalThis);
