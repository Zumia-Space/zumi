// The "reflex in N s · source: X" line under the stage. It is developer chrome (a debug timing, not a feature a normal
// user needs): shown only while Developer mode is on (the same gate as the sidebar dev buttons, settings.js
// devChromeVisible). Skipped in canned/demo-fixture mode: a recorded run never claims a live timing it didn't measure.
// Pure DOM-callback module so a node check can drive it without a window. Returns whether the line was shown.
// Hide AND clear the line: a later turn's analysis() reveals #analysis again, so a merely-flagged-off line would resurface stale.
export function hideReflexTiming({ $, set }) {
  const el = $('an-reflex');
  if (!el) return;
  set('an-reflex', '');
  el.hidden = true;
}

export function showReflexTiming({ $, set, t, canned = false, devMode = false, ms, source }) {
  if (canned || !devMode) { hideReflexTiming({ $, set }); return false; }
  const secs = (ms / 1000).toFixed(2);
  const src = source === 'jev' ? t('app.source.jev') : source === 'local' ? t('app.source.local') : source === 'rules' ? t('app.source.rules') : t('app.source.neutral');
  $('analysis').hidden = false; // reveals #analysis early so the timing shows before analysis() has anything
  set('an-reflex', t('app.timing', { secs, source: src }));
  $('an-reflex').hidden = false;
  // Reflex-only has no analysis text yet: show just the timing line, never three empty rows.
  $('an-lines').hidden = true;
  $('an-missing').hidden = true;
  return true;
}

// Owns the Developer-mode gate for the line: setDevMode(false) hides it at once (the zumi:dev-chrome handler calls it).
export function createReflexTiming({ $, set, t, isCanned = () => false, devMode = false }) {
  let dev = Boolean(devMode);
  return {
    setDevMode(on) { dev = Boolean(on); if (!dev) hideReflexTiming({ $, set }); },
    show(ms, source) { return showReflexTiming({ $, set, t, canned: isCanned(), devMode: dev, ms, source }); },
  };
}
