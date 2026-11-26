// R3 static check (roadmap 1.6, mirrors the sidecar's socket check): sockets and the HTTP stack are used in ONE crate,
// `tauri/zumi-egress`. Anything else that wants the network goes through it, so the origin allow-list, the loopback rule and
// the redirect rule cannot be walked around. Reads source only, no build.
//   TcpStream, TcpListener, UdpSocket, reqwest::, hyper::, tokio::net   outside tauri/zumi-egress (test blocks excepted)
// Usage: node scripts/check-power-egress.mjs        exit 0 = clean, 1 = violations printed.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EGRESS_CRATE = 'tauri/zumi-egress/';
const TOKENS = [
  ['TcpStream', /\bTcpStream\b/],
  ['TcpListener', /\bTcpListener\b/],
  ['UdpSocket', /\bUdpSocket\b/],
  ['reqwest::', /\breqwest::/],
  ['hyper::', /\bhyper::/],
  ['tokio::net', /\btokio::net\b/],
];
const stripComment = (l) => l.replace(/\/\/.*$/, '');

/** files: [{ path (repo-relative, forward slashes), text }] -> [{ path, token, line }] */
export function scan(files) {
  const found = [];
  for (const { path, text } of files) {
    if (path.startsWith(EGRESS_CRATE)) continue;
    // Rust tests sit at the bottom of the file in `#[cfg(test)] mod tests`; what follows the first marker is test code.
    const lines = text.split('#[cfg(test)]')[0].split('\n');
    lines.forEach((raw, i) => {
      const l = stripComment(raw);
      for (const [token, re] of TOKENS) if (re.test(l)) found.push({ path, token, line: i + 1 });
    });
  }
  return found;
}

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (name === 'target' || name === 'node_modules') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.rs')) out.push(p);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const paths = [];
  for (const crate of readdirSync(join(root, 'tauri'))) {
    if (/^(src-tauri|zumi-.+)$/.test(crate)) walk(join(root, 'tauri', crate, 'src'), paths);
  }
  const files = paths.map((p) => ({ path: relative(root, p).split(sep).join('/'), text: readFileSync(p, 'utf8') }));
  const violations = scan(files);
  for (const v of violations) console.log(`socket: ${v.path}:${v.line}: ${v.token}`);
  console.log(`check-power-egress: ${files.length} Rust source files, ${violations.length} violation(s)`);
  process.exit(violations.length ? 1 : 0);
}
