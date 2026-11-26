// CT-01 the Content tab is owner build only; the public source ships this stub in its place (scripts/lib/zumi-only.cjs
// PUBLIC_REPO_STUBS), so app.js still bundles and the tab stays hidden, as it does in every non-owner build.

/** Public build: no Content tab. Same contract as the owner module: null when the tab is not shown. */
export function initContent() {
  const tab = document.querySelector('.tab[data-tab="content"]');
  if (tab) tab.hidden = true;
  return null;
}
