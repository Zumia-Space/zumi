// Finding a Board link chip on screen before a real mouse click (scripts/electron-board-click.cjs in Electron,
// scripts/check-board-open-owner.mjs in headless Edge: one procedure, two drivers).
// `run(js)` evaluates a string in the board page and returns its JSON-able value.
'use strict';

// In-page: scroll the chip to the middle, return where to click. `hit` is what actually sits under that point; when it is
// not the chip (or inside it) something is painted over the chip and a click would land on that instead.
const spotSource = (task, label) => `(() => {
  const rows = [...document.querySelectorAll('.attention .row.ask')].filter((el) => (window.__rowCode ? window.__rowCode(el) : (el.querySelector('.code')?.textContent || '')).startsWith(${JSON.stringify(task)}));
  const a = rows.flatMap((row) => [...row.querySelectorAll('.ref-link')]).find((x) => x.textContent.includes(${JSON.stringify(label)}));
  if (!a) return { missing: true, chips: rows.flatMap((row) => [...row.querySelectorAll('.ref-link')].map((x) => x.textContent.trim())) };
  a.scrollIntoView({ block: 'center' });
  const b = a.getBoundingClientRect(), x = Math.round(b.x + b.width / 2), y = Math.round(b.y + b.height / 2);
  const hit = document.elementFromPoint(x, y);
  const covered = !(hit && (hit === a || a.contains(hit)));
  return { x, y, tag: a.tagName, href: a.getAttribute('href'), target: a.getAttribute('target'), covered, coveredBy: covered ? (hit ? (hit.closest('#reader, #lightbox')?.id || hit.tagName) : 'nothing') : null };
})()`;

// Escape is the page's own way out of an overlay (app.js keydown: lightbox first, then the reader).
const DISMISS_SOURCE = "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))";

// What is open over the board right now. `other` = a popover, menu or diagram view: Escape would close those first, so they are
// never something to dismiss blindly.
const OVERLAY_SOURCE = "({ reader: !!document.getElementById('reader'), lightbox: !!document.getElementById('lightbox'), other: !!(typeof S !== 'undefined' && (S.wkPop || S.stPop || S.diagramFull || (S.open && S.open.menu))) })";
const overlayState = (run) => run(OVERLAY_SOURCE);


/** The chip's click point and attributes; { missing } when the page has no such chip. An earlier click may have left the
 *  reader (a .md chip) or the lightbox (an image chip) open over the board: when exactly that layer covers the chip it is closed
 *  with Escape (up to 3 layers) and named in `dismissed`. Any other cover (an unknown element, or a popover / menu / diagram view
 *  that would take the Escape instead) is a failure, not something to close: no key is sent, `unexpected` is true and the
 *  chip stays `covered`. The caller reports it, never clicks blind. */
async function findChip(run, sleep, task, label) {
  let spot = await run(spotSource(task, label));
  const dismissed = [];
  spot.unexpected = false;
  for (let i = 0; i < 3 && spot.covered; i++) {
    const open = await overlayState(run);
    const layer = open.other ? null : open.lightbox ? 'lightbox' : open.reader ? 'reader' : null;
    if (!layer || spot.coveredBy !== layer) { spot.unexpected = true; break; }
    await run(DISMISS_SOURCE);
    await sleep(300);
    dismissed.push(layer);
    spot = await run(spotSource(task, label));
    spot.unexpected = false;
  }
  spot.dismissed = dismissed;
  return spot;
}

module.exports = { spotSource, findChip, overlayState };
