// Attach an image to the next chat message (T-31-MAUS R6c C item 5): a button, the clipboard (paste into the chat box), and one chip per image.
// The pictures live in this page's memory only, from the moment they are chosen until the person sends: take() hands them over once and
// the control is empty again. They are sent to the person's own AI model for that one request and are never stored: nothing here touches
// localStorage, a file or the memory list. A model that cannot read images makes the host answer no_vision (the chat shows why); this file
// only keeps obviously wrong attachments out (type, size, count) and says so in words. Text is set with textContent only.
import { t as i18nT, apply as i18nApply } from './i18n.js';
import { IMAGE_B64_MAX, shrinkInBrowser } from './image-fit.js';

export const ATTACH_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
export const ATTACH_MAX_COUNT = 4;
// R6e: the biggest FILE we will decode and shrink. What is sent is held to IMAGE_B64_MAX of base64 (image-fit.js): the rpc frame is 4 MB.
export const ATTACH_MAX_BYTES = 20 * 1024 * 1024;

/** The browser's way to read a File as { mime, data } (base64, without the data: prefix). */
export function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(r.error || new Error('read_failed'));
    r.onload = () => {
      const s = String(r.result || '');
      const at = s.indexOf(',');
      resolve({ mime: file.type, data: at >= 0 ? s.slice(at + 1) : '' });
    };
    r.readAsDataURL(file);
  });
}

/**
 * Builds the button, the hidden file box, the chips and the note line above the chat box, and wires paste on the box.
 * Returns { add, remove, take, count, pending } or null when the page has no composer.
 */
export function initChatAttach($, { doc = typeof document === 'undefined' ? null : document, t = i18nT, apply = i18nApply, readFile = readAsBase64, shrink = shrinkInBrowser } = {}) {
  if (!doc || $('chat-attach-btn')) return null;
  const composer = doc.querySelector('footer.composer');
  const msg = $('msg');
  if (!composer || !msg) return null;
  const node = (tag, cls, text, id) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; if (id) e.id = id; return e; };

  const btn = node('button', 'ghost slim', t('chat.attach.btn'), 'chat-attach-btn');
  btn.type = 'button';
  btn.dataset.i18n = 'chat.attach.btn';
  const input = node('input', null, null, 'chat-attach-input');
  input.type = 'file';
  input.accept = ATTACH_MIMES.join(',');
  input.multiple = true;
  input.hidden = true;
  const chips = node('div', 'chat-attach-chips', null, 'chat-attach-chips');
  const note = node('div', 'chat-attach-note', '', 'chat-attach-note');
  note.setAttribute('aria-live', 'polite');
  for (const el of [btn, input, chips, note]) composer.insertBefore(el, msg);
  apply(btn);

  const held = []; // [{ name, mime, data }] in the order attached

  function paint() {
    chips.textContent = '';
    held.forEach((x, i) => {
      const chip = node('span', 'chat-attach-chip');
      chip.appendChild(node('span', null, x.name));
      const rm = node('button', 'ghost slim', '×');
      rm.type = 'button';
      rm.setAttribute('aria-label', t('chat.attach.remove'));
      rm.addEventListener('click', () => remove(i));
      chip.appendChild(rm);
      chips.appendChild(chip);
    });
  }

  async function add(file) {
    note.textContent = '';
    if (!file || !ATTACH_MIMES.includes(file.type)) { note.textContent = t('chat.attach.badType'); return false; }
    if (!(file.size <= ATTACH_MAX_BYTES)) { note.textContent = t('chat.attach.tooBig'); return false; }
    if (held.length >= ATTACH_MAX_COUNT) { note.textContent = t('chat.attach.tooMany'); return false; }
    let r;
    try { r = await readFile(file); } catch { note.textContent = t('chat.attach.badType'); return false; }
    if (!r || !r.data) { note.textContent = t('chat.attach.badType'); return false; }
    if (r.data.length > IMAGE_B64_MAX) { // over what the frame can carry: re-encoded smaller, or refused here in words
      let s = null;
      try { s = await shrink(file, r); } catch { s = null; }
      if (!s || !s.data || s.data.length > IMAGE_B64_MAX) { note.textContent = t('chat.attach.cannotShrink'); return false; }
      r = s;
    }
    if (held.length >= ATTACH_MAX_COUNT) { note.textContent = t('chat.attach.tooMany'); return false; } // two reads that finished together
    held.push({ name: String(file.name || 'image').slice(0, 80), mime: r.mime, data: r.data });
    paint();
    return true;
  }
  function remove(i) { held.splice(i, 1); note.textContent = ''; paint(); }
  /** The images for the one request being sent, and the control is empty again. */
  function take() { const out = held.splice(0).map((x) => ({ mime: x.mime, data: x.data })); note.textContent = ''; paint(); return out; }
  /** R6e: a send that failed puts its pictures back, so the person need not choose them again (up to the limit; the names are lost). */
  function restore(images) {
    for (const x of Array.isArray(images) ? images : []) if (held.length < ATTACH_MAX_COUNT && x && x.data) held.push({ name: 'image', mime: x.mime, data: x.data });
    paint();
  }

  /** R6f: one chat turn with the pictures attached now. They go through talk.send as its second argument; a turn that fails (outcome 'turn-failed' or a throw)
   *  gives them back, so the person need not choose them again. app.js onSend and check:chat-image-send both call exactly this. */
  function sendVia(talk, text) {
    const sent = take();
    return Promise.resolve(talk.send(text, sent)).then((rec) => { if (sent.length && rec && rec.outcome === 'turn-failed') restore(sent); return rec; }, () => { if (sent.length) restore(sent); return null; });
  }

  btn.addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    const files = Array.from(input.files || []);
    for (const f of files) await add(f);
    input.value = ''; // the same file can be chosen again
  });
  msg.addEventListener('paste', async (ev) => {
    const files = Array.from((ev && ev.clipboardData && ev.clipboardData.files) || []).filter((f) => f && typeof f.type === 'string' && f.type.startsWith('image/'));
    if (!files.length) return; // plain text: left to the box
    ev.preventDefault();
    for (const f of files) await add(f);
  });

  return { add, remove, take, restore, sendVia, count: () => held.length, pending: () => held.map((x) => x.name), say: (text) => { note.textContent = text; } };
}
