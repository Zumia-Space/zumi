// Tiny DOM helpers shared by the Brain views. Text goes in through textContent only: board and memory text is data, never markup.
export function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
export function svg(tag, attrs, text) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, String(v));
  if (text != null) e.textContent = text;
  return e;
}

// "27 Oct, 10:20" in the UI language; '' for a missing or unreadable timestamp (the board's own clock, shown as given).
export function whenText(iso, locale) {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(d);
}
