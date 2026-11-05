// Whole-app theme (T-31 alpha.3 R1): blue (look A, the default), black, white. Renderer-only, like float-holo-prefs.js: the pick is a
// localStorage key, never an IPC call, so Electron main stays frozen. Pure module: no DOM or storage access at import time.
//
// The theme is <html data-theme="...">; src/next-tokens/tokens-a.css has one block per value (the only place with colour literals).
//   blue  = look A (today's look): keeps class "dark"
//   black = the shared .dark palette, i.e. exactly the Board's dark look: keeps class "dark"
//   white = the shared light palette: class "dark" removed, so tokens.css :root applies
// index.html and the build keep class="dark" (scripts/check-palette.mjs pins it); applyTheme() flips it at boot, app.js calls it first thing.
// Only the next-UI build applies a theme (app.js guards on __ZUMI_NEXT_UI__), so a build without next/ has no data-theme and looks as in 0.2.11.
export const THEMES = Object.freeze(['blue', 'black', 'white']);
export const DEFAULT_THEME = 'blue';
export const THEME_KEY = 'zumi.theme';
const EVENT = 'zumi:theme';

/** A stored/requested value -> a known theme; anything else (stale key, hand-edited store, a future theme) falls back to the default. */
export function resolveTheme(value) { return THEMES.includes(value) ? value : DEFAULT_THEME; }

/** Reads the saved pick (default on empty, unknown value or disabled storage). */
export function readTheme(storage = (typeof localStorage !== 'undefined' ? localStorage : null)) {
  try { return resolveTheme(storage && storage.getItem(THEME_KEY)); } catch { return DEFAULT_THEME; }
}

/** Persists the pick and returns the resolved theme, so the caller applies exactly what the next launch will read. */
export function saveTheme(value, storage = (typeof localStorage !== 'undefined' ? localStorage : null)) {
  const theme = resolveTheme(value);
  try { if (storage) storage.setItem(THEME_KEY, theme); } catch { /* storage disabled: the pick just does not survive a restart */ }
  return theme;
}

/** Sets data-theme and the dark class on <html>, then tells listeners (app.js reloads the open Board). Returns the resolved theme. */
export function applyTheme(value, root = document.documentElement) {
  const theme = resolveTheme(value);
  const changed = root.dataset.theme !== theme;
  root.dataset.theme = theme;
  root.classList.toggle('dark', theme !== 'white');
  if (changed && typeof root.ownerDocument?.dispatchEvent === 'function' && typeof CustomEvent === 'function') root.ownerDocument.dispatchEvent(new CustomEvent(EVENT, { detail: { theme } }));
  return theme;
}

/** cb(theme) after the theme changes (not for the first apply of the same value). Returns an unsubscribe function. */
export function onThemeChange(cb, doc = document) {
  const h = (e) => cb(e.detail.theme);
  doc.addEventListener(EVENT, h);
  return () => doc.removeEventListener(EVENT, h);
}

/** The theme value the vendored Board page understands (`#theme=dark|light`, Laneboard app.js consumeFragment). */
export function boardTheme(theme) { return resolveTheme(theme) === 'white' ? 'light' : 'dark'; }

/** Adds `theme=dark|light` to the URL's fragment and returns the same URL object. An existing fragment (the `#token=` the board URL carries)
 *  is kept byte for byte; an existing theme= is replaced. The fragment is never sent to the server.
 *  alpha.4: also `?zumiTheme=<blue|black|white>`. The fragment only sets the page's first paint; the page then copies the signed-in
 *  token's stored server prefs over it (adoptServerPrefs), so the Tauri bridge reads this query on the page load and answers the page's
 *  state with the matching theme/accent (src/main/board-bridge.mjs hostTheme). It goes only to the loopback bridge. */
export function withBoardTheme(url, theme) {
  const kept = url.hash.slice(1).split('&').filter((p) => p && !p.startsWith('theme='));
  kept.push(`theme=${boardTheme(theme)}`);
  url.hash = kept.join('&');
  url.searchParams.set('zumiTheme', resolveTheme(theme));
  return url;
}
