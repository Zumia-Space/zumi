// T49 absence check (PARITY-MATRIX-1911): what the parity plan keeps OUT of the product stays out. Reads source only, no build.
//   - no listener outside the loopback board bridge (and none bound to every interface)
//   - no analytics origin
//   - no upstream OpenMausBot / SupaMaus / enterprise code or name
//   - no generic shell exec (Rust `Command::new("cmd"|"sh"|"powershell"...)` outside test blocks; JS `exec(`, `shell: true`)
// Usage: node scripts/check-maus-absence.mjs        exit 0 = clean, 1 = violations printed.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The only files that open a listening socket: the board bridge and the laneboard host, both on 127.0.0.1. */
export const LISTENER_FILES = ['src/main/board-bridge.mjs', 'src/main/laneboard-host.mjs'];

/** R3: the egress crate's loopback HTTP server for tests and goal harnesses. It is compiled only with the crate feature
 * `fixture` (the CLI below checks that gate), and it binds 127.0.0.1 only (the all-interfaces rule still applies to it). */
export const TEST_ONLY_LISTENER_FILES = ['tauri/zumi-egress/src/fixture.rs'];
/** R7 K0a: the one door a power pack's listener opens through (`zumi_egress::listen`, loopback unless the user granted the LAN), which only the
 * broker calls, and only for a pack the user accepted and enabled with a declared port. No pack installed: nothing listens. The eval runner
 * drives the broker's `listen` method (a method name, not a socket).
 * R7b (gate R7 should-fix 3): exempt BY ITEM, never by file. Only these items (a line that starts one, through its closing brace) may hold a
 * socket or name every interface: the egress `Listener` struct and `listen` function. R7c: not the `impl Listener` block (it holds no socket
 * call, and exempting it let a method with a raw all-interfaces listener through). Only the broker's own `listen` method may name the door.
 * Calls of that method are allowed by their exact shape (receiver + pack id), in the broker and the eval runner. */
export const PACK_DOOR_ITEMS = { 'tauri/zumi-egress/src/lib.rs': [/^pub struct Listener\b/, /^pub fn listen\(/] };
export const PACK_DOOR_CALL_ITEMS = { 'tauri/zumi-packs/src/broker.rs': [/^pub fn listen\(&self/] };
const PACK_LISTEN_CALLS = { 'tauri/zumi-packs/src/broker.rs': /\bself\.listen\(pack_id\b/, 'tauri/zumi-evals/src/evals.rs': /\bb\.listen\(id\b/ };
// The door by any name: a call, an import (also inside braces, or as an alias) or a glob import of the crate.
const DOOR_CALL = /zumi_egress::(?:\{[^}]*)?\blisten\b|zumi_egress::\*/;
// A raw socket API on the same line means it is not merely the broker's method.
const RAW_SOCKET = /\bTcpListener\b|UdpSocket::bind|\bcreateServer\(|\bWebSocketServer\b|\bwarp::serve|\baxum::serve/;
const FIXTURE_GATE = '#[cfg(feature = "fixture")]' + String.fromCharCode(10) + 'pub mod fixture;';

const LISTEN = /\.listen\(|\bcreateServer\(|\bWebSocketServer\b|\bTcpListener\b|UdpSocket::bind|\bwarp::serve|\baxum::serve/;
// The two generated Tauri-side files subscribe to the host's in-process event bus (api.listen('sidecar:ready', ...) = @tauri-apps event.listen):
// no socket. Only those two files, only that call on that line; a createServer / TcpListener / server.listen on the same line, or the same text
// in any other file, is still a listener. (tauri/ui is built by tauri/prep-ui.mjs, so these only exist once it has run: the check must not turn red because of that.)
export const EVENT_BUS_FILES = ['tauri/ui/zumi-shim.js', 'tauri/ui/webview-element.js'];
const EVENT_BUS_LISTEN = /\b(?:api|events|event)\.listen\(/;
const eventBusOnly = (path, l) => EVENT_BUS_FILES.includes(path) && EVENT_BUS_LISTEN.test(l) && !LISTEN.test(l.replace(EVENT_BUS_LISTEN, ''));
const ALL_INTERFACES = /(listen|bind)\s*\([^)]*0\.0\.0\.0|\bIpv[46]Addr::UNSPECIFIED\b|\[::\]|(listen|bind)\s*\([^)]*['"]::['"]/;
const ANALYTICS = /posthog|mixpanel|segment\.(io|com)|amplitude\.com|sentry\.io|google-analytics|googletagmanager|plausible\.io|umami\.is|datadoghq|hotjar|fullstory|logrocket/i;
const UPSTREAM = /openmausbot|supamaus|\benterprise\b/i;
// The program may be a bare name or a full path (`C:\\Windows\\System32\\cmd.exe`, `r"C:/.../powershell.exe"`).
const RUST_SHELL = /Command::new\(\s*r?#*"([^"]*[\\/])?(cmd|sh|bash|zsh|powershell|pwsh)(\.exe)?"/i;
// A bare or child_process-qualified exec(): `db.exec(` (SQLite) and `re.exec(` (RegExp) are not shells.
const JS_EXEC = /(?<![.\w])(exec|execSync)\s*\(|(child_process|\bcp)\.(exec|execSync)\s*\(|shell\s*:\s*true/;

const isRust = (p) => p.endsWith('.rs');
// Rust tests sit at the bottom of the file in `#[cfg(test)] mod tests`; what follows the first marker is test code.
const productionText = (p, text) => (isRust(p) ? text.split('#[cfg(test)]')[0] : text);

/** Rust braces on one line that are code: not inside a string, raw string, char literal or comment. `st` carries a string, raw string
 * (`raw` = its `#` count) or block comment across lines. Returns the net depth change and whether a code brace was seen. */
function braces(line, st) {
  let d = 0, seen = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (st.raw !== null) { if (c === '"' && line.startsWith('#'.repeat(st.raw), i + 1)) { i += st.raw; st.raw = null; } continue; }
    if (st.str) { if (c === '\\') i++; else if (c === '"') st.str = false; continue; }
    if (st.block) { if (c === '*' && line[i + 1] === '/') { i++; st.block--; } else if (c === '/' && line[i + 1] === '*') { i++; st.block++; } continue; }
    if (c === '/' && line[i + 1] === '/') break;
    if (c === '/' && line[i + 1] === '*') { i++; st.block = 1; continue; }
    const raw = c === 'r' && !/\w/.test(line[i - 1] ?? ' ') ? /^r(#*)"/.exec(line.slice(i)) : null;
    if (raw) { st.raw = raw[1].length; i += raw[0].length - 1; continue; }
    if (c === '"') { st.str = true; continue; }
    if (c === "'") { const ch = /^'(?:\\.[^']*|[^\\'])'/.exec(line.slice(i)); if (ch) i += ch[0].length - 1; continue; } // a lifetime has no closing quote
    if (c === '{') { d++; seen = true; } else if (c === '}') { d--; seen = true; }
  }
  return { d, seen };
}

/** The line numbers (0-based) covered by items whose first line (trimmed) matches one of `starts`, through the matching closing brace
 * (braces inside strings, chars and comments do not count). */
function itemLines(lines, starts = []) {
  const covered = new Set();
  lines.forEach((l, i) => {
    if (!starts.some((re) => re.test(l.trim()))) return;
    let depth = 0, opened = false;
    const st = { str: false, raw: null, block: 0 };
    for (let j = i; j < lines.length; j++) {
      covered.add(j);
      const b = braces(lines[j], st);
      depth += b.d;
      if (b.seen) opened = true;
      if (opened && depth <= 0) break;
    }
  });
  return covered;
}

/** files: [{ path (repo-relative, forward slashes), text }] -> [{ path, kind, line }] */
export function scan(files) {
  const found = [];
  for (const { path, text: raw } of files) {
    const text = productionText(path, raw);
    const lines = text.split('\n');
    const door = itemLines(lines, PACK_DOOR_ITEMS[path]);
    const doorCaller = itemLines(lines, PACK_DOOR_CALL_ITEMS[path]);
    const hit = (kind, re, skip = false, lineOk = () => false) => {
      if (skip) return;
      lines.forEach((l, i) => { if (re.test(l) && !lineOk(l, i)) found.push({ path, kind, line: i + 1, text: l.trim().slice(0, 120) }); });
    };
    const methodCall = (l) => PACK_LISTEN_CALLS[path]?.test(l) && !RAW_SOCKET.test(l);
    hit('listener', LISTEN, LISTENER_FILES.includes(path) || TEST_ONLY_LISTENER_FILES.includes(path), (l, i) => door.has(i) || methodCall(l) || eventBusOnly(path, l));
    hit('listener_door_caller', DOOR_CALL, false, (_, i) => doorCaller.has(i));
    hit('listener_all_interfaces', ALL_INTERFACES, false, (_, i) => door.has(i));
    hit('analytics', ANALYTICS);
    hit('upstream_name', UPSTREAM);
    hit('generic_exec', isRust(path) ? RUST_SHELL : JS_EXEC);
  }
  return found;
}

const SKIP_DIRS = new Set(['node_modules', 'target', '.git', 'dist', 'out', 'tmp']);
function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(mjs|js|rs|html)$/.test(name) && !/\.test\.mjs$/.test(name)) out.push(p);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const rootAt = process.argv.indexOf('--root');
  const root = rootAt > 0 ? process.argv[rootAt + 1] : join(dirname(fileURLToPath(import.meta.url)), '..');
  const paths = [];
  // Product source only: the main process, the sidecar, the renderer and the Tauri UI (the chat box lives there) and the Rust
  // crates (not the tauri/verify probes, not tests). A missing folder is skipped so the test can plant a small tree.
  for (const d of ['src/main', 'src/renderer', 'tauri/sidecar', 'tauri/ui']) if (existsSync(join(root, d))) walk(join(root, d), paths);
  for (const crate of existsSync(join(root, 'tauri')) ? readdirSync(join(root, 'tauri')) : []) if (/^(src-tauri|zumi-.+)$/.test(crate)) walk(join(root, 'tauri', crate, 'src'), paths);
  const files = paths.map((p) => ({ path: relative(root, p).replace(/\\/g, '/'), text: readFileSync(p, 'utf8') }));
  const violations = scan(files);
  // The test server is exempt only while it is behind the feature gate: take the gate away and the exemption is a violation.
  const egressLib = files.find((f) => f.path === 'tauri/zumi-egress/src/lib.rs');
  if (egressLib && !egressLib.text.split(String.fromCharCode(13)).join('').includes(FIXTURE_GATE)) {
    violations.push({ path: egressLib.path, kind: 'fixture_not_gated', line: 0, text: 'the fixture module must be behind #[cfg(feature = "fixture")]' });
  }
  for (const v of violations) console.log(`${v.kind}: ${v.path}:${v.line}: ${v.text}`);
  console.log(`check-maus-absence: ${files.length} source files, ${violations.length} violation(s)`);
  process.exit(violations.length ? 1 : 0);
}
