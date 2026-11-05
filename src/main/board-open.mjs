// "Open this" requests from the live board in the OWNER build's Board tab (T-31 ask-media, 10-10; Sol gate: the
// openpath review brief). anh's asks carry files on his PC ("local"
// links: a contact sheet, a morning pack's index.html, a notes .md) and loopback previews (http://127.0.0.1:4320/).
// The board page is a sandboxed <webview> with no preload and no IPC, so it asks by opening
//   <its own bridge origin>/__zumi-open?path=<absolute path>   or   …/__zumi-open?url=<url>
// in a new window (Laneboard public/app.js refsHtml with ?local=open). main.js's setWindowOpenHandler for THE board
// guest passes that URL here and acts only on the answer:
//   { action: 'openPath', path, kind }   shell.openPath(path): a file or folder under openRoots(), real path (junctions
//                                        and ".." resolved), extension in OPEN_EXT or a folder; refused when the path
//                                        has a ':' past the drive letter (a stream) or a part ending in a dot or space
//   { action: 'openExternal', url }      shell.openExternal(url): decideExternalUrl's validation (below), the same one
//                                        main.js applies to every other link the Board tab opens
//   { action: 'refuse', reason, … }      nothing is opened; main logs it
//   { action: 'none' }                   not an open request (not this origin / path): the caller's other rules apply
// An open request from a page that is not itself on the bridge origin (o.openerUrl) is refused (Sol gate condition 3:
// defence in depth; the attach policy and will-navigate already keep the board guest on that origin).
// Pure decision (no Electron, no writes; fs only to resolve and stat the target), so Node tests it directly
// (scripts/check-board-open.mjs).
import fs from 'node:fs';
import path from 'node:path';

import { ownerValue } from './owner-values.js';

// The OWNER build's roots: the owner's own folders, from the owner-only values file (openRoots; the Rust host compiles in
// the same key, open_path.rs owner_open_roots). A tree without that file has none: an owner flavour there opens nothing.
export const OPEN_ROOTS = ownerValue('openRoots', []);
export const OPEN_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.html', '.md', '.webm', '.mp4', '.pdf']);
export const OPEN_PATHNAME = '/__zumi-open';

/** The roots a flavour may open under: the owner build (ownerAdmin === true) exactly OPEN_ROOTS; a public build only the
 *  app's own data dir, none when the caller names none. decideLocalPath still refuses a public build before any root. */
export function openRoots(ownerAdmin, appDataDir = null) {
  if (ownerAdmin === true) return OPEN_ROOTS;
  return appDataDir ? [`${String(appDataDir).replace(/\\/g, '/').replace(/\/+$/, '')}/`] : [];
}

const refuse = (reason, extra = {}) => ({ action: 'refuse', reason, ...extra });
const originOf = (u) => { try { return new URL(u).origin; } catch { return String(u ?? '').slice(0, 40); } };
// A Windows name trick in a drive path: a ':' anywhere past the drive letter (an alternate data stream: "run.cmd:x.md"
// resolves as is and its extension reads as .md, review 10-11), or a path part ending in a dot or a space (Win32 trims
// those, so "run.cmd." is run.cmd). "." and ".." parts are left to the resolver and the root check.
const nameTrick = (p) => p.indexOf(':', 2) !== -1 || p.split(/[\\/]/).some((part) => part !== '.' && part !== '..' && /[. ]$/.test(part));

// Web links in board content (owner 10-11; 20-10, a shopee.vn link did nothing; CoS decision
// 20-10: the PUBLIC build too). The narrow host allowlist (link-allowlist*.json, accepted risk 3) is gone: any ordinary
// web page opens in the default browser, in every build, after validation. http/https only; no userinfo (refused
// earlier); a plain dotted DNS name: no IP literal, no punycode label, no trailing dot, no localhost/LAN-style suffix, so a
// link cannot aim the browser at a local service or an IDN look-alike. WHO may ask is main.js's job (only the Board tab
// guest, on its own loopback origin; scripts/check-board-open.mjs runs that handler).
const LOCAL_SUFFIX = /\.(localhost|local|internal|lan|home\.arpa)$/;
const isPlainWebUrl = (t) => (t.protocol === 'https:' || t.protocol === 'http:') && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(t.hostname)
  && !/(^|\.)xn--/.test(t.hostname) && !/^[0-9.]+$/.test(t.hostname) && !LOCAL_SUFFIX.test(t.hostname);

/**
 * The web addresses the app opens in the OS browser, for /__zumi-open?url= and for every other link the Board tab opens
 * (main.js): http://127.0.0.1:<port>/… and http://localhost:<port>/… (opened as 127.0.0.1: the page treats both as
 * loopback, Laneboard public/app.js LOOPBACK, and the hosts file never decides), and any plain http/https web page
 * (isPlainWebUrl above). No userinfo (https://claude.ai@evil.example is evil.example); no punycode label (the URL parser
 * turns an IDN look-alike such as "clаude.ai" into xn--…). Anything else is refused.
 * `cited` (talk:openSource, review v7 nit): a Look up reply's source link. The URL must be one this session's Look up really
 * cited (exact href, main.js citedUrls) and pass a stricter check: https on the default port, a plain host name (no
 * punycode, no IP literal), never loopback (a web page has no business pointing the app at a local service).
 * @param {string} url
 * @param {{ cited?: Set<string> }} [o]  cited: the Look up source channel (see above)
 * @returns {{ action: 'openExternal', url: string } | { action: 'refuse', reason: string, origin?: string }}
 */
export function decideExternalUrl(url, { cited = null } = {}) {
  let t;
  try { t = new URL(url); } catch { return refuse('bad_url'); }
  const origin = originOf(t.href);
  if (t.username || t.password) return refuse('url_has_credentials', { origin });
  if (cited) {
    if (!(cited instanceof Set) || !cited.has(t.href)) return refuse('url_not_cited', { origin });
    if (t.protocol !== 'https:' || t.port !== '') return refuse('url_not_allowed', { origin });
    if (/(^|\.)xn--/.test(t.hostname) || /[^a-z0-9.-]/.test(t.hostname)) return refuse('url_idn_host', { origin });
    // a plain DNS name only: not loopback, not an IP literal, no trailing dot ("localhost." is localhost; review 16bd64f)
    if (t.hostname.endsWith('.') || t.hostname === 'localhost' || t.hostname.endsWith('.localhost') || /^[0-9.]+$/.test(t.hostname)) return refuse('url_not_allowed', { origin });
    return { action: 'openExternal', url: t.href };
  }
  const loopback = t.protocol === 'http:' && (t.hostname === '127.0.0.1' || t.hostname === 'localhost');
  if (loopback) { t.hostname = '127.0.0.1'; return { action: 'openExternal', url: t.href }; }
  if (t.protocol !== 'https:' && t.protocol !== 'http:') return refuse('url_not_allowed', { origin });
  if (/(^|\.)xn--/.test(t.hostname) || /[^a-z0-9.-]/.test(t.hostname)) return refuse('url_idn_host', { origin });
  return isPlainWebUrl(t) ? { action: 'openExternal', url: t.href } : refuse('url_not_allowed', { origin });
}

/**
 * @param {string} requestUrl  the URL the board page asked to open in a new window
 * @param {object} o
 * @param {string|null} o.bridgeOrigin  the live bridge origin (http://127.0.0.1:<port>); null when not in live mode
 * @param {boolean} o.ownerAdmin        the owner build flag (package.json zumiOwnerAdmin); false refuses everything
 * @param {string} [o.openerUrl]        the URL of the page that asked (webContents.getURL()); must be on bridgeOrigin
 * @param {(p:string)=>string} [o.realpath]  defaults to fs.realpathSync.native (resolves junctions, 8.3 names, case)
 * @param {(p:string)=>fs.Stats} [o.stat]
 */
export function decideBoardOpen(requestUrl, { bridgeOrigin, ownerAdmin, openerUrl, realpath = fs.realpathSync.native, stat = fs.statSync } = {}) {
  let u;
  try { u = new URL(requestUrl); } catch { return { action: 'none' }; }
  if (!bridgeOrigin || u.origin !== bridgeOrigin || u.pathname !== OPEN_PATHNAME) return { action: 'none' };
  if (ownerAdmin !== true) return refuse('not_owner_build');
  if (typeof openerUrl !== 'string' || !openerUrl.startsWith(bridgeOrigin + '/')) return refuse('opener_not_on_bridge', { origin: originOf(openerUrl) });
  const keys = [...u.searchParams.keys()];
  if (keys.length !== 1 || !['path', 'url'].includes(keys[0])) return refuse('bad_request');

  if (keys[0] === 'url') return decideExternalUrl(u.searchParams.get('url'));

  return decideLocalPath(u.searchParams.get('path'), { ownerAdmin, realpath, stat });
}

/**
 * A file or folder on this PC, by absolute drive path: the same rules /__zumi-open?path= applies (owner build only,
 * under openRoots() after resolving junctions and "..", no Windows name trick, OPEN_EXT or a folder). Shared by the
 * board's open requests above and the HUD's consent-to-open (hud-feed.mjs), so both go through one allowlist.
 * @returns {{ action: 'openPath', path: string, kind: 'file'|'folder' } | { action: 'refuse', reason: string }}
 */
export function decideLocalPath(p, { ownerAdmin, appDataDir = null, realpath = fs.realpathSync.native, stat = fs.statSync } = {}) {
  if (ownerAdmin !== true) return refuse('not_owner_build');
  if (!p || p.includes('\0') || !/^[A-Za-z]:[\\/]/.test(p) || /^[A-Za-z]:[\\/][\\/]/.test(p)) return refuse('not_an_absolute_drive_path');
  if (nameTrick(p)) return refuse('name_trick');
  let real;
  try { real = realpath(path.win32.normalize(p)); } catch { return refuse('not_found'); }
  const fwd = String(real).replace(/^\\\\\?\\/, '').replace(/\\/g, '/');
  // the resolved path again (an 8.3 name or a junction target could carry the trick the asked path did not)
  if (!/^[A-Za-z]:\//.test(fwd) || nameTrick(fwd)) return refuse('name_trick', { path: fwd });
  if (!openRoots(ownerAdmin, appDataDir).some((r) => fwd.toLowerCase().startsWith(r.toLowerCase()))) return refuse('outside_allowed_folders', { path: fwd });
  let st;
  try { st = stat(real); } catch { return refuse('not_found'); }
  if (st.isDirectory()) return { action: 'openPath', path: real, kind: 'folder' };
  const ext = path.win32.extname(fwd).toLowerCase();
  if (!st.isFile() || !OPEN_EXT.has(ext)) return refuse('type_not_allowed', { ext });
  return { action: 'openPath', path: real, kind: 'file' };
}

/** A HUD acceptance ref ({ kind: 'local', target: <drive path> } | { kind: 'url', target: <url> }) -> the same
 *  decision the board's /__zumi-open would get for it. Nothing here opens anything. */
export function decideOpenRef(ref, { ownerAdmin = false, realpath, stat } = {}) {
  if (!ref || typeof ref.target !== 'string') return refuse('bad_request');
  if (ref.kind === 'local') return decideLocalPath(ref.target, { ownerAdmin, ...(realpath ? { realpath } : {}), ...(stat ? { stat } : {}) });
  if (ref.kind === 'url') return decideExternalUrl(ref.target);
  return refuse('bad_request');
}
