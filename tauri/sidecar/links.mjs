// T-31 alpha.3 R4: the app's fixed public links (community, donate, upgrade), by id. The page only ever names an id; the URL
// lives here, in sidecar code, because the public build has no flavour.json to carry it (flavour.mjs). Same seam as the voice
// guides (voice-host.mjs guideVerdict): the Rust host intercepts `links.open` (lib.rs app_open_target), asks
// `__host.linkVerdict` (main.mjs), re-validates and opens; `links.list` tells the page which ids are set, as booleans only.
// Public URLs only, in both flavours. An empty string means "not set yet": no button, and an open is refused (link_unset).
import { decideExternalUrl } from './adapters.mjs';
import { ownerValue } from '../../src/main/owner-values.js';

export const LINKS = Object.freeze({
  discord: 'https://discord.gg/5jyJ3UJ5zF', // the community invite (anh 30-10 06:38Z)
  donate: 'https://ko-fi.com/zumi3k', // R5 Pricing: Donate, one Ko-fi page (PayPal inside Ko-fi; anh 30-10 06:38Z)
  upgrade: '', // R5 Pricing: the Cloud memory upgrade page
});

const refuse = (reason) => ({ action: 'refuse', reason });

// Review F1 (CoS: https only). decideExternalUrl is the shared board-link policy and also opens http and loopback; an app link
// is narrower: https on the default port to a public DNS host, never an IP literal, a local name or an owner/staging host.
// The owner hosts come from the owner-only values file (src/main/owner-values.json: the staging cloud base and the live board
// origin), so no owner host is spelled in the public source; a public tree has none to refuse, and ships every link empty.
const hostOf = (origin) => { try { return origin ? new URL(origin).hostname : null; } catch { return null; } };
export const OWNER_HOSTS = new Set(['127.0.0.1', 'localhost', hostOf(ownerValue('cloudBase', null)), hostOf(ownerValue('liveOrigin', null))].filter(Boolean));
const LOCAL_HOST = /(^|\.)(localhost|local)$/;
function linkRule(url) {
  let t;
  try { t = new URL(url); } catch { return 'link_bad_url'; }
  if (t.protocol !== 'https:') return 'link_not_https';
  if (t.port !== '') return 'link_port';
  const host = t.hostname.replace(/\.$/, ''); // the URL parser lowercases it; a trailing dot names the same host
  if (host.startsWith('[') || /^[0-9.]+$/.test(host)) return 'link_ip_host';
  if (LOCAL_HOST.test(host)) return 'link_local_host';
  if (OWNER_HOSTS.has(host)) return 'link_owner_host';
  return null;
}

/**
 * The open verdict for one link id: the table's URL must pass linkRule (https, default port, public host), then
 * decideExternalUrl (no userinfo, a plain DNS host, no punycode).
 * @param {unknown} id
 * @param {Readonly<Record<string, string>>} [table]  LINKS; a check passes its own table
 * @returns {{ action: 'openExternal', url: string } | { action: 'refuse', reason: string, origin?: string }}
 */
export function linkVerdict(id, table = LINKS) {
  if (typeof id !== 'string' || !Object.prototype.hasOwnProperty.call(table, id)) return refuse('unknown_link');
  const url = table[id];
  if (typeof url !== 'string' || url === '') return refuse('link_unset');
  const ruled = linkRule(url);
  return ruled ? refuse(ruled) : decideExternalUrl(url);
}

/** `{ id: boolean }` for every id: true only when an open would really happen. Never carries a URL. */
export function linkList(table = LINKS) {
  return Object.fromEntries(Object.keys(table).map((id) => [id, linkVerdict(id, table).action === 'openExternal']));
}
