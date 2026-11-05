// T-31-MOBILE M3: Settings > App > "Điện thoại" (Tauri owner build only). Pairs the Zumi phone app with one QR.
// The Rust host does the work (tauri/src-tauri/src/phone_pair.rs): native confirm, window capture protection, the device
// token through the sidecar, the QR drawing. This page gets the SVG picture (which ENCODES the board login: anyone who can
// read this page's DOM during those 60 s can read the login), shows it in #phone-qr and
// asks the host to end early when Settings closes. The host also removes #phone-qr and drops protection on its own timer.
// Electron and the public build have no zumi.phone / no phone.status answer: the card stays hidden.
import { t } from './i18n.js';

const QR_MS = 60_000;

export function initPhoneCard(zumi, $) {
  const card = $('phone-card');
  if (!card || !zumi || !zumi.phone) return null;
  const el = { state: $('phone-state'), pair: $('phone-pair'), unpair: $('phone-unpair'), slot: $('phone-qr-slot'), note: $('phone-note') };
  let timer = null;
  let ends = 0;

  const paint = (s) => {
    el.state.textContent = s && s.paired ? t('phone.paired', { name: s.name }) : t('phone.notPaired');
    el.unpair.hidden = !(s && s.paired);
  };
  const refresh = () => zumi.phone.status().then((s) => { card.hidden = false; paint(s); return s; }, () => { card.hidden = true; return null; });

  function dropQr() {
    clearInterval(timer);
    timer = null;
    const qr = $('phone-qr');
    if (qr) qr.remove();
    el.slot.hidden = true;
    el.note.textContent = '';
  }
  function endQr() {
    if (!timer && !$('phone-qr')) return;
    dropQr();
    zumi.phone.pairEnd().catch(() => {});
  }

  el.pair.addEventListener('click', async () => {
    el.note.textContent = '';
    el.pair.disabled = true;
    try {
      const r = await zumi.phone.pairStart();
      if (!r || !r.ok) {
        if (r && r.error !== 'cancelled') el.note.textContent = t('phone.err', { code: (r && r.error) || '?' });
        return;
      }
      dropQr();
      const box = document.createElement('div');
      box.id = 'phone-qr';
      box.className = 'phone-qr';
      // The SVG is the host's own output (qrcode crate: rects and a path, no script); parsed as an image, not as markup in the page.
      const img = document.createElement('img');
      img.alt = t('phone.pair');
      img.width = 320;
      img.height = 320;
      img.src = `data:image/svg+xml;base64,${btoa(r.svg)}`;
      box.appendChild(img);
      el.slot.appendChild(box);
      el.slot.hidden = false;
      ends = Date.now() + QR_MS;
      const tick = () => {
        const left = Math.max(0, Math.ceil((ends - Date.now()) / 1000));
        if (!left || !$('phone-qr')) return endQr();
        el.note.textContent = t('phone.scanNow', { s: left });
      };
      tick();
      timer = setInterval(tick, 1000);
      await refresh();
    } finally {
      el.pair.disabled = false;
    }
  });
  el.unpair.addEventListener('click', async () => {
    el.unpair.disabled = true;
    try {
      const r = await zumi.phone.unpair();
      el.note.textContent = r && r.ok ? t('phone.removed') : t('phone.err', { code: (r && r.error) || '?' });
      await refresh();
    } finally {
      el.unpair.disabled = false;
    }
  });
  // Leaving Settings ends the QR at once (the host's own 60 s timer is the backstop).
  for (const tab of document.querySelectorAll('.tab[data-tab]')) tab.addEventListener('click', () => { if (tab.dataset.tab !== 'settings') endQr(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) endQr(); });
  refresh();
  return { refresh };
}
