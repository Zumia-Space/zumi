// Shared grade math (T-31 camera modes, coordinator round 3, 2026-10-05): a per-channel RGB scale, the
// linear-algebra equivalent of a multiply-blend at full strength against the tint colour -- applied ONLY where
// alpha > 0, so a fully-transparent (non-avatar) pixel is left byte-exact. This is the fix for round 2's bug:
// a flat tint fillRect drawn in 'multiply' mode still deposits alpha = its own globalAlpha at a fully-
// transparent backdrop pixel (Porter-Duff "over" alpha is source-alpha-union, independent of the blend
// function used) -- so the tint visibly dimmed/tinted the PLATE too, wherever there was no avatar in front of
// it (coordinator QC: measured ~11% darker on a no-avatar plate region). Scaling only non-transparent pixels'
// own RGB, never alpha, cannot leak onto anything behind them by construction.
//
// Used by scripts/render-camera-views.mjs (a real ImageData from a 2D canvas) and scripts/check-camera.mjs
// (a plain {data, width, height} fake -- this module only ever touches `.data`, a Uint8ClampedArray-like
// indexable, so no DOM/Canvas global is required to use or test it).

/** @returns {{fr,fg,fb}} the per-channel multiply factor for `tintHex` (#rgb or #rrggbb) at `strength` (0-1). */
export function tintFactors(tintHex, strength) {
  const hex = tintHex.length === 4 ? tintHex.slice(1).split('').map((c) => c + c).join('') : tintHex.slice(1);
  const n = parseInt(hex, 16);
  const s = strength;
  return {
    fr: (1 - s) + s * ((n >> 16 & 255) / 255),
    fg: (1 - s) + s * ((n >> 8 & 255) / 255),
    fb: (1 - s) + s * ((n & 255) / 255),
  };
}

/** Mutates `imageData.data` (RGBA bytes) in place: scales R/G/B by the tint factors at `strength`, skipping
 *  (leaving byte-exact) any pixel whose alpha is 0. Alpha itself is never written. A no-op at strength <= 0. */
export function applyAvatarTint(imageData, tintHex, strength) {
  if (!strength) return;
  const { fr, fg, fb } = tintFactors(tintHex, strength);
  const d = imageData.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    d[i] *= fr; d[i + 1] *= fg; d[i + 2] *= fb;
  }
}
