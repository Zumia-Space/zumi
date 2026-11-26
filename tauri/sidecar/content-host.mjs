// CT-01 the Content tab host is owner flavour only; the public source ships this stub in its place (scripts/lib/zumi-only.cjs
// PUBLIC_REPO_STUBS), so the sidecar still loads. main.mjs reads a null host as "no content.* handlers" (not_implemented).

/** Public build: no content host. */
export function createContentHost() {
  return null;
}
