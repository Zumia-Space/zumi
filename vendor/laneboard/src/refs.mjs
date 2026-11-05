// Refs: the images and links a lane attaches to now / next / an ask travel as the LAST line(s) of the text, rendered by the
// CoS CLI (ask-refs.mjs wireText): chips joined by " · ", each one of
//   [label](https://host/path)  [label](media/<name>)      a link; one that ends in an image name is an image (label = caption)
//   `D:/abs/file.md`   label `/abs/file.md`                a path on the owner's computer; only an ABSOLUTE path counts
// The page reads them with public/markdown.js splitRefs. Here the server (a) hands them out apart from the text in
// /api/state?v=2, so a client never has the rendered line to push back, and (b) on a push collapses a trailing block of such
// lines to one deduped line, so a client that does push it back (an older CLI, a stopgap script) cannot multiply it.
//
// Strict on purpose: a line counts only when EVERY token of it is a chip. A relative or unknown backtick, a final code line, a
// malformed chip and a chip inside prose stay text. Pure functions, no I/O.

const LINK = /^\[([^\]\n]+)\]\(((?:https?:\/\/|media\/)[^)\s]+)\)$/;
const LOCAL = /^(?:([^`[\]\n]*?) )?`((?:[A-Za-z]:[\\/]|\/)[^`\n]*)`$/;
const IMAGE = /\.(?:png|jpe?g|webp|gif)$/i;
const fwd = p => p.replace(/\\/g, '/');
const baseName = p => { const parts = fwd(p).split('/').filter(Boolean); const last = parts.pop() || p; return fwd(p).endsWith('/') ? last + '/' : last; };

/** One token of a refs line as a chip { kind: 'media'|'link'|'path', label, url, raw }, or null when it is not one. */
export function parseChip(token) {
  let m = LINK.exec(token);
  if (m) return { kind: IMAGE.test(m[2]) ? 'media' : 'link', label: m[1], url: m[2], raw: token };
  m = LOCAL.exec(token);
  if (m) return { kind: 'path', label: (m[1] || '').trim() || baseName(m[2]), url: fwd(m[2]), raw: token };
  return null;
}

/** The trailing refs block of `src`: { before: lines above it, lines: its chip lines, chips: every chip, in order }, or null. */
function trailingBlock(src) {
  const lines = String(src ?? '').split('\n');
  let end = lines.length;
  while (end > 0 && !lines[end - 1].trim()) end--;
  let start = end;
  const chips = [];
  while (start > 0) {
    const line = lines[start - 1].trim();
    if (!line) break;
    const parsed = line.split(' · ').map(parseChip);
    if (!parsed.every(Boolean)) break;
    chips.unshift(...parsed);
    start--;
  }
  return chips.length ? { before: lines.slice(0, start), count: end - start, chips } : null;
}

const unique = chips => { const seen = new Set(), out = []; for (const c of chips) if (!seen.has(c.url)) { seen.add(c.url); out.push(c); } return out; };

/** text -> { text: without its refs block, refs: [{kind, label, url}] deduped in first-seen order, line: the one-line rendering }. */
export function splitRefs(src) {
  const text = String(src ?? '');
  const block = trailingBlock(text);
  if (!block) return { text, refs: [], line: '' };
  const chips = unique(block.chips);
  return { text: block.before.join('\n').trimEnd(), refs: chips.map(({ kind, label, url }) => ({ kind, label, url })), line: chips.map(c => c.raw).join(' · ') };
}

/** The text as it should be stored: a trailing block of several lines, or with a repeated chip, becomes ONE deduped line (first
 *  seen kept). Anything else -- including a block that is already one clean line -- comes back byte for byte. */
export function normalizeRefs(src) {
  const text = String(src ?? '');
  const block = trailingBlock(text);
  if (!block) return text;
  const chips = unique(block.chips);
  if (block.count === 1 && chips.length === block.chips.length) return text;
  const head = block.before.join('\n').trimEnd(), line = chips.map(c => c.raw).join(' · ');
  return head ? `${head}\n${line}` : line;
}
