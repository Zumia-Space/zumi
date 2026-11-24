#!/usr/bin/env node
// J-05 machines-scrub: the one copy of the "no machine names, no internal paths in what the server hands out" scan.
// Used by test/public-assets-scrub.test.mjs (scanDir on a tree) and by the deploy smoke (CLI below: fetch every served
// asset through the live server and scan the bytes it really sends).
//
//   node scripts/scan-served-assets.mjs --base http://127.0.0.1:3096 < listing
//     listing = `tar -tf <release tar>` (or any list of repo-relative paths); every file under public/ or schema/v1/ is
//     fetched at its served URL, must answer 200, and is scanned. Prints one line per problem, then a summary; exit 1 on any.
//
// Patterns stay generic on purpose: this file ships with the package, so it names no real host or address itself.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repo dir -> URL prefix, as src/server.mjs serves them (PUBLIC_DIR at /, SCHEMA_DIR at /schema/v1/). */
export const SERVED = [['public', '/'], ['schema/v1', '/schema/v1/']];

const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const NOT_PATHY = "[^\\s'\"`<>()|]*";
export const PATTERNS = [
  // Windows default names (DESKTOP-/LAPTOP- + 7, WIN- + 11), any case. The random part must hold a digit and end the
  // token, so CSS names like desktop-sidebar never count (an all-letter random part is the accepted miss).
  ['windows hostname', /\b(?:(?:desktop|laptop)-(?=[a-z]*\d)[a-z0-9]{7}|win-(?=[a-z]*\d)[a-z0-9]{11})(?![\w-])/gi],
  // A drive letter not glued to a word, so https:// (s:/) and data: never count.
  ['drive path', new RegExp(`(?<![A-Za-z0-9_])[A-Za-z]:[\\\\/]${NOT_PATHY}`, 'g')],
  ['unc path', /\\\\[A-Za-z0-9._-]+\\[A-Za-z0-9.$_-]+/g],
  ['unix internal path', new RegExp(`(?<![A-Za-z0-9_.-])/(?:opt|root|home|srv|mnt|tmp|var/www|etc)/${NOT_PATHY}`, 'g')],
  ['home path', new RegExp(`(?<![A-Za-z0-9_.-])~/${NOT_PATHY}`, 'g')],
  ['user profile', new RegExp(`[\\\\/]Users[\\\\/]${NOT_PATHY}`, 'gi')],
  ['ssh target', /\broot@[A-Za-z0-9][A-Za-z0-9.-]*/g],
  ['email', /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g],
  // Any dotted-quad IPv4: covers 10/8, 172.16/12, 192.168/16, 100.64/10 and the VPS address without naming it.
  ['ip address', new RegExp(`(?<![\\d.])${OCTET}\\.${OCTET}\\.${OCTET}\\.${OCTET}(?![\\d.])`, 'g')],
  ['lane folder', /\bcos-(?:lane|tools)\b/g]
];
/** Served file (repo-relative, forward slashes) + exact token -> why it may stay. */
export const ALLOWED = [
  ['public/app.js', 'D:/…/file.md', 'elided placeholder in a comment describing the shape of an agent path'],
  ['public/reading.js', 'D:/…/file.md', 'elided placeholder in a comment describing the shape of an agent path'],
  ['public/markdown.js', 'D:/path/file.md', 'generic placeholder in the refs-format comment'],
  ['public/markdown.js', 'D:/…', 'elided placeholder in the refs-format comment'],
  ['public/markdown.js', 'D:/…/PLAN.md', 'elided placeholder in the refs-format comment']
].map(([file, token, why]) => ({ file, token, why }));

const TEXT = /\.(?:js|mjs|css|html|json|svg|md|txt)$/;
/** Text as UTF-8 (so the '…' placeholders match ALLOWED), anything else byte-for-byte as latin1. */
const decode = (file, buf) => buf.toString(TEXT.test(file) ? 'utf8' : 'latin1');

/** Every hit in one served file's content that ALLOWED does not cover, as { file, line, kind, token }. */
export function scanText(file, text) {
  const hits = [];
  text.split('\n').forEach((ln, i) => {
    for (const [kind, re] of PATTERNS) for (const m of ln.matchAll(re)) {
      if (!ALLOWED.some(a => a.file === file && a.token === m[0])) hits.push({ file, line: i + 1, kind, token: m[0] });
    }
  });
  return hits;
}
/** The served URL path of a repo-relative file, or null when the server does not hand it out statically. */
export function servedUrl(rel) {
  for (const [dir, prefix] of SERVED) if (rel.startsWith(dir + '/') && !rel.endsWith('/')) return prefix + rel.slice(dir.length + 1);
  return null;
}
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
/** Scan every served file of a checkout. */
export function scanDir(root) {
  return SERVED.flatMap(([dir]) => fs.existsSync(path.join(root, dir)) ? walk(path.join(root, dir)) : []).flatMap(abs => {
    const file = path.relative(root, abs).split(path.sep).join('/');
    return scanText(file, decode(file, fs.readFileSync(abs)));
  });
}
/** Fetch each served file of a listing from a running board and scan what it sends. */
export async function scanServed(base, listing) {
  const files = listing.map(s => s.trim().replace(/^\.\//, '')).filter(rel => servedUrl(rel));
  const problems = [];
  for (const rel of files) {
    const res = await fetch(base.replace(/\/$/, '') + servedUrl(rel), { signal: AbortSignal.timeout(10000) });
    if (res.status !== 200) { problems.push(`${rel}: HTTP ${res.status}`); continue; }
    for (const h of scanText(rel, decode(rel, Buffer.from(await res.arrayBuffer())))) problems.push(`${h.file}:${h.line} ${h.kind}: ${h.token}`);
  }
  return { fetched: files.length, problems };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--base');
  if (i < 0 || !process.argv[i + 1]) { console.error('usage: scan-served-assets.mjs --base <url> < listing'); process.exit(2); }
  const { fetched, problems } = await scanServed(process.argv[i + 1], fs.readFileSync(0, 'utf8').split('\n').filter(Boolean));
  for (const p of problems) console.log(p);
  console.log(`${fetched} served assets fetched, ${problems.length} problem(s)`);
  process.exit(fetched > 0 && problems.length === 0 ? 0 : 1);
}
