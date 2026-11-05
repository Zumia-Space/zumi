// Look-tuning panel (T-31 camera modes, owner priority shift 03-10 after flagging a room/avatar
// scale mismatch). Dev-only (Developer toggle), live sliders per view -- camera distance/height/fov (fed into
// CameraDirector.effectiveCamera as a framing override, never mutating room.json), avatar tint + exposure + rim
// strength (CSS filters on #stage-canvas ITSELF -- brightness() + a feColorMatrix tint, both scoped to the
// avatar's own rendered pixels, never #stage-plate -- see applyGrading), plate blur (a CSS filter preset). Copy
// puts the current view's JSON on the clipboard; Save writes ALL views to a user override file in userData
// (never into the shipped room files); Reset clears the current view back to the room's own numbers.
import { t } from '../i18n.js';

const BLUR_PX = { off: 0, soft: 4, strong: 10 };
const VIEWS = ['talk', 'work', 'room'];

function hexToRgb01(hex) {
  let h = hex.slice(1);
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function createLookTuning({ director, rim, plateCanvas, stageCanvas, panelEl, zumi }) {
  // The tint's feColorMatrix lives in index.html (#stage-grade-tint), referenced from stageCanvas's OWN CSS
  // filter below -- see that element's comment for why (coordinator round 3, 2026-10-05: a separate #stage-tint
  // overlay used to mix-blend-mode:multiply against the WHOLE stacking context, dimming/tinting #stage-plate
  // along with the avatar).
  const tintMatrix = document.querySelector('#stage-grade-tint feColorMatrix');
  // Coordinator addendum (03-10): talk defaults to the "Chest-up (webcam)" framing. Coordinator round 2
  // (2026-10-05): exposure/tint/tintStrength now come from the LOADED ROOM's own views.<v>.grade when present
  // (room-check.mjs's checkGrade / room-loader-v2.js's normaliseGrade) -- an authored default (her white suit
  // matched to the plate's own light) instead of only this hand-picked, talk-only fallback. A room with no
  // grade (or no room loaded yet) keeps the old neutral/talk-tint behaviour exactly.
  function roomGrade(view) { const v = director.room && director.room.views[view]; return (v && v.grade) || null; }
  function defaultOverride(view) {
    const g = roomGrade(view);
    return {
      distanceM: 0, heightM: 0, fovDelta: 0,
      tint: g ? g.tint : (view === 'talk' ? '#6f7fe0' : '#000000'),
      tintStrength: g ? g.tintStrength : (view === 'talk' ? 0.12 : 0),
      exposure: g ? g.exposure : 1,
      rimStrength: 1,
      blur: view === 'talk' ? 'soft' : 'off',
      chestUp: view === 'talk',
    };
  }
  const overrides = { talk: defaultOverride('talk'), work: defaultOverride('work'), room: defaultOverride('room') };
  let active = false;

  function applyGrading(view) {
    const o = overrides[view];
    plateCanvas.style.filter = BLUR_PX[o.blur] ? `blur(${BLUR_PX[o.blur]}px)` : 'none';
    // exposure (brightness) and tint (feColorMatrix, a per-channel RGB scale -- the linear-algebra equivalent of
    // a multiply-blend at full strength against the channel's own colour) are BOTH a CSS filter on stageCanvas
    // ITSELF -- a filter only ever reads/writes the element's own rendered pixels (alpha included), so it can
    // never touch #stage-plate (a separate sibling element), unlike the old overlay-div approach.
    const [tr, tg, tb] = hexToRgb01(o.tint);
    const s = o.tintStrength;
    if (tintMatrix) {
      const fr = (1 - s) + s * tr, fg = (1 - s) + s * tg, fb = (1 - s) + s * tb;
      tintMatrix.setAttribute('values', `${fr} 0 0 0 0  0 ${fg} 0 0 0  0 0 ${fb} 0 0  0 0 0 1 0`);
    }
    const filters = [];
    if (o.exposure !== 1) filters.push(`brightness(${o.exposure})`);
    if (s > 0) filters.push('url(#stage-grade-tint)');
    stageCanvas.style.filter = filters.length ? filters.join(' ') : 'none';
    if (rim) rim.intensity = 1.1 * o.rimStrength; // 1.1 is app.js's own base rim intensity
  }

  function refreshCamera() { if (director.room) director.jumpToView(director.view); } // re-reads effectiveCamera() for the CURRENT view, live

  director.getFramingOverride = (view) => overrides[view];

  // ---------- panel DOM (built in JS: a dev tool, not app chrome -- no new CSS file, inherits native control styling) ----------
  const el = {};
  function row(id, labelKey, attrs) {
    const label = document.createElement('label');
    label.style.display = 'block'; label.style.margin = '4px 0'; label.style.fontSize = '12px';
    const span = document.createElement('span'); span.setAttribute('data-i18n', labelKey); span.textContent = t(labelKey);
    span.style.display = 'inline-block'; span.style.width = '150px';
    const input = document.createElement('input');
    Object.assign(input, attrs);
    input.style.verticalAlign = 'middle';
    label.appendChild(span); label.appendChild(input);
    panelEl.appendChild(label);
    el[id] = input;
    return input;
  }

  const viewSelect = document.createElement('select');
  for (const v of VIEWS) { const opt = document.createElement('option'); opt.value = v; opt.textContent = v; viewSelect.appendChild(opt); }
  viewSelect.style.display = 'block'; viewSelect.style.marginBottom = '6px';
  panelEl.appendChild(viewSelect);
  let currentView = 'talk';

  row('distance', 'lookTuning.distance', { type: 'range', min: -1.5, max: 1.5, step: 0.01 });
  row('height', 'lookTuning.height', { type: 'range', min: -0.5, max: 0.5, step: 0.01 });
  row('fov', 'lookTuning.fov', { type: 'range', min: -20, max: 20, step: 0.5 });
  row('tint', 'lookTuning.tint', { type: 'color' });
  row('tintStrength', 'lookTuning.tintStrength', { type: 'range', min: 0, max: 0.6, step: 0.01 });
  row('exposure', 'lookTuning.exposure', { type: 'range', min: 0.5, max: 1.8, step: 0.02 });
  row('rim', 'lookTuning.rim', { type: 'range', min: 0, max: 3, step: 0.05 });
  {
    const label = document.createElement('label');
    label.style.display = 'block'; label.style.margin = '4px 0'; label.style.fontSize = '12px';
    const span = document.createElement('span'); span.setAttribute('data-i18n', 'lookTuning.blur'); span.textContent = t('lookTuning.blur');
    span.style.display = 'inline-block'; span.style.width = '150px';
    const sel = document.createElement('select');
    for (const k of ['off', 'soft', 'strong']) { const opt = document.createElement('option'); opt.value = k; opt.setAttribute('data-i18n', `lookTuning.blur.${k}`); opt.textContent = t(`lookTuning.blur.${k}`); sel.appendChild(opt); }
    label.appendChild(span); label.appendChild(sel);
    panelEl.appendChild(label);
    el.blur = sel;
  }
  const chestUp = row('chestUp', 'lookTuning.chestUp', { type: 'checkbox' });

  const btnRow = document.createElement('div'); btnRow.style.marginTop = '8px';
  const copyBtn = document.createElement('button'); copyBtn.textContent = t('lookTuning.copy'); copyBtn.setAttribute('data-i18n', 'lookTuning.copy');
  const saveBtn = document.createElement('button'); saveBtn.textContent = t('lookTuning.save'); saveBtn.setAttribute('data-i18n', 'lookTuning.save');
  const resetBtn = document.createElement('button'); resetBtn.textContent = t('lookTuning.reset'); resetBtn.setAttribute('data-i18n', 'lookTuning.reset');
  for (const b of [copyBtn, saveBtn, resetBtn]) { b.style.marginRight = '6px'; btnRow.appendChild(b); }
  panelEl.appendChild(btnRow);
  const status = document.createElement('div'); status.style.fontSize = '11px'; status.style.marginTop = '4px';
  panelEl.appendChild(status);

  function paint() {
    const o = overrides[currentView];
    el.distance.value = o.distanceM; el.height.value = o.heightM; el.fov.value = o.fovDelta;
    el.tint.value = o.tint; el.tintStrength.value = o.tintStrength; el.exposure.value = o.exposure;
    el.rim.value = o.rimStrength; el.blur.value = o.blur; chestUp.checked = o.chestUp;
  }
  paint();

  function onInput() {
    const o = overrides[currentView];
    o.distanceM = Number(el.distance.value); o.heightM = Number(el.height.value); o.fovDelta = Number(el.fov.value);
    o.tint = el.tint.value; o.tintStrength = Number(el.tintStrength.value); o.exposure = Number(el.exposure.value);
    o.rimStrength = Number(el.rim.value); o.blur = el.blur.value; o.chestUp = chestUp.checked;
    applyGrading(currentView);
    refreshCamera();
  }
  for (const input of [el.distance, el.height, el.fov, el.tint, el.tintStrength, el.exposure, el.rim, el.blur, chestUp]) {
    input.addEventListener('input', onInput);
  }
  viewSelect.addEventListener('change', () => { currentView = viewSelect.value; paint(); applyGrading(currentView); director.setManualView(currentView); });

  copyBtn.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(JSON.stringify(overrides, null, 2)); status.textContent = t('lookTuning.copied'); }
    catch (e) { status.textContent = t('lookTuning.copyFailed', { error: String((e && e.message) || e) }); }
  });
  saveBtn.addEventListener('click', async () => {
    try { await zumi.ui.setLookTuning(overrides); status.textContent = t('lookTuning.saved'); }
    catch (e) { status.textContent = t('lookTuning.saveFailed', { error: String((e && e.message) || e) }); }
  });
  resetBtn.addEventListener('click', () => { overrides[currentView] = defaultOverride(currentView); paint(); applyGrading(currentView); refreshCamera(); });

  async function load() {
    try {
      const saved = zumi.ui.getLookTuning ? await zumi.ui.getLookTuning() : null;
      if (saved) for (const v of VIEWS) if (saved[v]) overrides[v] = { ...defaultOverride(v), ...saved[v] };
    } catch { /* keep defaults */ }
    for (const v of VIEWS) applyGrading(v);
    paint();
  }

  return {
    load,
    toggle(on) {
      active = on != null ? Boolean(on) : !active;
      panelEl.hidden = !active;
      return active;
    },
    get active() { return active; },
  };
}
