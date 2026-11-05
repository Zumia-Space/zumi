// Owner-visible text audit (P6, coordinator 01-10): every label the app itself shows the owner is plain words in the
// active UI language — no task/step codes, no snake_case/camelCase, no intent or source IDs (Vietnamese UI only; in
// English those ids are ordinary words), no commit hashes, no "C mẫu …" shorthands, no English-only labels in the
// Vietnamese UI. The self-test collects the visible text of the app's own UI at several moments and fails on any
// hit. Out of scope by design: what the user typed, the model's spoken reply (conversation content, not a label), the
// vendored board page inside its webview. Filesystem paths are refused everywhere; a bare file name is allowed only in a
// tooltip (title), never in visible text.
import { getLocale } from '../i18n.js';

const VI_MARKS = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i;
const INTENT_IDS = ['greet', 'agree', 'disagree', 'point-screen', 'think', 'celebrate', 'explain', 'point-user', 'shrug'];
const SOURCE_IDS = ['composed', 'library', 'builtin', 'cache', 'fallback'];
// words that may appear untranslated (product / file-format names)
const ALLOWED_LATIN = new Set(['zumi', 'zumia', 'vrm', 'model', 'file', 'ai', 'laneboard']);

export const RULES = [
  ['task or step code', /\b[A-Z]{1,6}-\d+\b|\bs\d{1,2}\b/],
  ['snake_case', /\b[a-z]+_[a-z0-9_]+\b/],
  ['camelCase', /\b[a-z]+[A-Z][A-Za-z]+\b/],
  ['intent or source id', new RegExp(`(^|[^\\p{L}-])(${[...INTENT_IDS, ...SOURCE_IDS].join('|')})(?=$|[^\\p{L}-])`, 'u')],
  ['commit hash', /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/],
  ['"C mẫu" shorthand', /\b[A-Z]\s*mẫu\s*\d/],
  ['filesystem path', /\b[A-Za-z]:[\\/]|\\\\[\w.-]+\\|(^|[\s(«"'])\/(root|home|opt|usr|var|etc|tmp|mnt|srv)\b|[\w.-]+\\[\w.-]+/],
  ['file name', /\b[\w-]+\.(vrm|vrma|fbx|glb|gltf|json|ndjson|exe|dll|asar|js|mjs|cjs|png|jpe?g|webp|wav|mp3|mp4|log|txt|md|ps1|cmd|bat|zip|tar|gz)\b/i],
  ['markup or JSON', /<\/?[a-z][^>]*>|[{}`]|\[\w+\]/], // tags, braces, backticks, [id] — not a plain '>' as in 'Rảnh > 60 giây'
];

// -> null | rule name.  opts.tooltip: the text is a title tooltip (a bare file name is allowed there)
// opts.lang: the UI language to audit against; defaults to the active locale. Two rules are language-specific and only
// run in the Vietnamese UI: the intent/source id rule (those ids — greet, agree, think, composed, library, fallback …
// — are ordinary English words in the English UI) and the English-only rule (English is the default now, so English
// labels are correct).
export function ownerTextProblem(text, opts = {}) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const lang = opts.lang || getLocale();
  for (const [name, re] of RULES) {
    if (name === 'intent or source id' && lang !== 'vi') continue;
    if (re.test(t) && !(opts.tooltip && name === 'file name')) return name;
  }
  // When the UI is Vietnamese, a part of the label (split at → · : — |) with two or more Latin words, none of them
  // Vietnamese, outside the small allowlist, is an untranslated label (so 'Lệnh cử chỉ → Wave hello' is caught on its
  // right-hand part).
  if (lang === 'vi') {
    for (const part of t.split(/[→·:—|]/)) {
      const words = part.split(/[^\p{L}]+/u).filter((w) => w.length > 1);
      const latin = words.filter((w) => /^[A-Za-z]+$/.test(w) && !ALLOWED_LATIN.has(w.toLowerCase()));
      if (latin.length >= 2 && !VI_MARKS.test(part)) return 'English-only label';
    }
  }
  return null;
}

// items: [{ where, text }] -> [{ where, text, problem }]
export function auditOwnerTexts(items) {
  return items.map((it) => ({ ...it, problem: ownerTextProblem(it.text, { tooltip: /@title$/.test(it.where || '') }) })).filter((it) => it.problem);
}

// Visible text of the app's own UI under `root` (renderer DOM): text nodes of visible elements + title / placeholder /
// aria-label. `skip` = selectors whose subtree is not a label (user text, model reply, file paths, the board webview).
export function collectOwnerTexts(root, skip = []) {
  const out = [];
  const skipped = (el) => skip.some((s) => el.closest(s));
  const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0; };
  const where = (el) => (el.id ? `#${el.id}` : el.className && typeof el.className === 'string' ? `${el.tagName.toLowerCase()}.${el.className.split(' ')[0]}` : el.tagName.toLowerCase());
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!el || skipped(el) || ['SCRIPT', 'STYLE'].includes(el.tagName) || !visible(el)) continue;
    const text = n.textContent.replace(/\s+/g, ' ').trim();
    if (text) out.push({ where: where(el), text });
  }
  // a closed <select> shows its selected option's text, which is not a visible text node of its own
  for (const sel of root.querySelectorAll('select')) {
    if (skipped(sel) || !visible(sel) || sel.selectedIndex < 0) continue;
    const text = sel.options[sel.selectedIndex].textContent.replace(/\s+/g, ' ').trim();
    if (text) out.push({ where: `${where(sel)}:selected`, text });
  }
  for (const el of root.querySelectorAll('[title],[placeholder],[aria-label]')) {
    if (skipped(el) || !visible(el)) continue;
    for (const a of ['title', 'placeholder', 'aria-label']) if (el.getAttribute(a)) out.push({ where: `${where(el)}@${a}`, text: el.getAttribute(a) });
  }
  return out;
}
