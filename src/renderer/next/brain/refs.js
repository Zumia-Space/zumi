// The links and files a task's text cites (T-31 slice 3a-3). A COPY of the HUD's own parser, src/main/hud-feed.mjs extractRefs, kept here because
// the renderer bundle cannot import from src/main (scripts/check-next-ui-boots-without-next.mjs and check-brain.mjs build a scratch copy of src/renderer
// only). It must give the same refs for the same text: the host (board-reads.mjs openRef) accepts a target only when it EQUALS what the HUD parser
// finds, so a drift here would make every Open button answer "not on the board". scripts/check-brain-host.mjs (BH-18) compares the two on a corpus
// and fails on one differing ref. Pure: no DOM, no host call.
const REF_LINK = /^\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)$/;
const REF_LOCAL = /^(?:([^`\n]*?) )?`([A-Za-z]:[\\/][^`\n]*)`$/;
const MEDIA_URL = /\/media\/[\w.-]+\.(?:png|jpe?g|webp|gif)$/i;
const INLINE_LINK = /(?<!!)\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g;
const INLINE_LOCAL = /`([A-Za-z]:[\\/][^`\n]*)`/g;
const baseName = (p) => { const parts = p.replace(/\\/g, '/').split('/').filter(Boolean); return parts.pop() || p; };
/** A local target with no glob or placeholder char (* ? [ ] { } < >): a glob names no one file or folder to open, so it is never
 *  cited (T-31 alpha.3 B3). Folders and extensionless files stay cited: both hosts open them. */
const isCitableLocal = (p) => !/[*?[\]{}<>]/.test(p);

/** text -> [{ kind: 'local' | 'url', label, target }], de-duplicated, in text order. */
export function extractRefs(text) {
  const out = [];
  const seen = new Set();
  const add = (kind, label, target) => {
    const key = `${kind}:${target}`;
    if (seen.has(key) || (kind === 'url' && MEDIA_URL.test(target)) || (kind === 'local' && !isCitableLocal(target))) return;
    seen.add(key);
    out.push({ kind, label: String(label || '').trim() || (kind === 'local' ? baseName(target) : target), target });
  };
  const src = String(text ?? '').replace(/\r\n?/g, '\n');
  for (const line of src.split('\n')) { // ref-line tokens first: they carry the author's own label
    const toks = line.split(' · ').map((s) => s.trim()).filter(Boolean);
    for (const tk of toks) {
      const l = REF_LOCAL.exec(tk);
      if (l) add('local', l[1] || baseName(l[2]), l[2].replace(/\\/g, '/'));
      const u = REF_LINK.exec(tk);
      if (u) add('url', u[1], u[2]);
    }
  }
  for (const m of src.matchAll(INLINE_LINK)) add('url', m[1], m[2]);
  for (const m of src.matchAll(INLINE_LOCAL)) add('local', baseName(m[1]), m[1].replace(/\\/g, '/'));
  return out;
}

const arr = (v) => (Array.isArray(v) ? v : []);

/** Every ref a task detail model cites, in reading order, de-duplicated: the dossier (as local) first, then the text fields the host also
 *  reads (goal / now / next / context, step label / sub / detail, this task's asks and plan posts). `model` = board-model.js taskDetail. */
export function collectRefs(model) {
  const out = [];
  const seen = new Set();
  const add = (r) => { const k = `${r.kind}\u0000${r.target}`; if (!seen.has(k)) { seen.add(k); out.push(r); } };
  if (model.dossier) add({ kind: 'local', label: 'dossier', target: model.dossier, dossier: true });
  const take = (text) => { if (typeof text === 'string' && text) for (const r of extractRefs(text)) add(r); };
  for (const f of ['goal', 'now', 'next', 'context']) take(model[f]);
  for (const s of arr(model.steps)) for (const f of ['label', 'sub', 'detail']) take(s[f]);
  for (const a of arr(model.asks)) take(a.text);
  for (const p of arr(model.plans)) take(p.body);
  return out;
}
