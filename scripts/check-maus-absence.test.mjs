// node --test scripts/check-maus-absence.test.mjs : the absence check (T49) catches what it must and passes what is allowed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scan, LISTENER_FILES, EVENT_BUS_FILES } from './check-maus-absence.mjs';

const f = (path, text) => ({ path, text });
const kinds = (files) => scan(files).map((v) => v.kind).sort();

test('bite: a listener in a file that is not on the loopback allow-list', () => {
  assert.deepEqual(kinds([f('src/main/new-api.mjs', "http.createServer(h).listen(8800, '127.0.0.1');")]), ['listener']);
  assert.deepEqual(kinds([f('tauri/zumi-x/src/lib.rs', 'let l = std::net::TcpListener::bind("127.0.0.1:0");')]), ['listener']);
});

test('bite: a bind to every interface, even in an allowed file', () => {
  const [path] = LISTENER_FILES;
  assert.deepEqual(kinds([f(path, "server.listen(3000, '0.0.0.0');")]), ['listener_all_interfaces']);
});

test('bite: an analytics origin, an upstream name, an enterprise path', () => {
  assert.deepEqual(kinds([f('src/main/a.js', "fetch('https://app.posthog.com/e');")]), ['analytics']);
  assert.deepEqual(kinds([f('src/main/a.js', "fetch('https://api.segment.io/v1/t');")]), ['analytics']);
  assert.deepEqual(kinds([f('src/main/a.js', '// ported from OpenMausBot')]), ['upstream_name']);
  assert.deepEqual(kinds([f('src/main/a.js', "import x from '../enterprise/billing.js';")]), ['upstream_name']);
});

test('bite: a generic shell exec in production code (Rust outside tests, JS exec/shell:true)', () => {
  assert.deepEqual(kinds([f('tauri/src-tauri/src/x.rs', 'fn run() { Command::new("powershell").arg(s).spawn(); }')]), ['generic_exec']);
  assert.deepEqual(kinds([f('tauri/sidecar/x.mjs', "import { exec } from 'node:child_process'; exec(cmd);")]), ['generic_exec']);
  assert.deepEqual(kinds([f('src/main/x.js', "spawn(cmd, args, { shell: true });")]), ['generic_exec']);
});

test('twin: the board bridge listens on loopback; cmd mklink inside #[cfg(test)] is a test helper; spawn without a shell is fine', () => {
  assert.deepEqual(kinds([f(LISTENER_FILES[0], "server.listen(0, '127.0.0.1');")]), []);
  assert.deepEqual(kinds([f('tauri/src-tauri/src/open_path.rs', 'fn real() {}\n#[cfg(test)]\nmod tests { fn j() { Command::new("cmd").args(["/C", "mklink"]); } }')]), []);
  assert.deepEqual(kinds([f('tauri/sidecar/x.mjs', "spawn(process.execPath, [script], { stdio: 'ignore' });")]), []);
  assert.deepEqual(kinds([f('src/main/a.js', "const x = 'amplitude of the waveform';")]), []);
});

test('R3: the egress crate\'s test server may listen, but only that one file; any other file of the crate is caught', () => {
  assert.deepEqual(kinds([f('tauri/zumi-egress/src/fixture.rs', 'let l = TcpListener::bind("127.0.0.1:0");')]), []);
  assert.deepEqual(kinds([f('tauri/zumi-egress/src/serve.rs', 'let l = TcpListener::bind("127.0.0.1:0");')]), ['listener']);
  assert.deepEqual(kinds([f('tauri/zumi-egress/src/fixture.rs', 'let l = TcpListener::bind("0.0.0.0:0"); bind("0.0.0.0:8")')]), ['listener_all_interfaces']);
});

// H2 (GATE-OPUS-R1 should-fix 3): the check must also read src/renderer and tauri/ui (the chat box lives there), and the
// Rust shell rule must see a full-path cmd.exe. The CLI takes --root so the test can plant files in a temp tree.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const cli = join(dirname(fileURLToPath(import.meta.url)), 'check-maus-absence.mjs');
function runOn(files) {
  const root = mkdtempSync(join(tmpdir(), 'absence-'));
  mkdirSync(join(root, 'src/main'), { recursive: true });
  mkdirSync(join(root, 'tauri/sidecar'), { recursive: true });
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  const r = spawnSync(process.execPath, [cli, '--root', root], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout };
}
test('H2 bite: an analytics origin in src/renderer or tauri/ui (js or html) fails the CLI', () => {
  for (const p of ['src/renderer/agent-chat.js', 'tauri/ui/index.html', 'src/renderer/room/x.js']) {
    const r = runOn({ [p]: "fetch('https://app.posthog.com/e');" });
    assert.equal(r.code, 1, p);
    assert.match(r.out, /analytics: /, p);
  }
});
test('H2 twin: clean renderer and ui files pass', () => {
  const r = runOn({ 'src/renderer/agent-chat.js': "export const a = 'amplitude of the waveform';", 'tauri/ui/index.html': '<p>hi</p>' });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /2 source files/);
});
test('H2 bite: Command::new with a full path to cmd.exe is a generic exec', () => {
  assert.deepEqual(kinds([f('tauri/src-tauri/src/x.rs', 'fn r() { Command::new("C:\\Windows\\System32\\cmd.exe").spawn(); }')]), ['generic_exec']);
  assert.deepEqual(kinds([f('tauri/src-tauri/src/x.rs', 'fn r() { Command::new(r"C:/Windows/System32/powershell.exe").spawn(); }')]), ['generic_exec']);
  assert.deepEqual(kinds([f('tauri/src-tauri/src/x.rs', 'fn r() { Command::new("notepad.exe").spawn(); }')]), []);
});

// R7 K0a: power packs open a door only through ONE function (`zumi_egress::listen`), called from ONE method (the broker's `listen`), and
// only for a pack the user accepted and enabled with a declared port. With no pack installed nothing listens.
// R7b (gate R7 should-fix 3): the exemptions are BY ITEM, not by file: R7 exempted the whole of egress lib.rs, broker.rs and evals.rs, so a
// new raw listener anywhere in them, a `use ... listen as door` alias and `Ipv4Addr::UNSPECIFIED` all passed.
import { readFileSync } from 'node:fs';
const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOOR_FN = 'pub fn listen(bind: Bind, port: u16) -> std::io::Result<Listener> {\n    let ip = match bind {\n        Bind::Loopback => std::net::Ipv4Addr::LOCALHOST,\n        Bind::Lan => std::net::Ipv4Addr::UNSPECIFIED,\n    };\n    std::net::TcpListener::bind((ip, port)).map(|inner| Listener { inner })\n}\n';
const BROKER_FN = 'impl Broker {\n    pub fn listen(&self, pack_id: &str, bind: &str, port: u16) -> Result<u16, &\'static str> {\n        let l = zumi_egress::listen(zumi_egress::Bind::Loopback, port).map_err(|_| "x")?;\n        Ok(port)\n    }\n    pub fn request(&self, pack_id: &str) { self.listen(pack_id, b, p); }\n}\n';
test('R7: the egress door function may listen (all interfaces only inside it); any other file with a socket is caught', () => {
  assert.deepEqual(kinds([f('tauri/zumi-egress/src/lib.rs', 'pub struct Listener {\n    inner: std::net::TcpListener,\n}\n' + DOOR_FN)]), []);
  assert.deepEqual(kinds([f('tauri/zumi-packs/src/other.rs', 'let l = std::net::TcpListener::bind("127.0.0.1:0");')]), ['listener']);
});
test('R7: only the broker\'s listen method calls the door; the broker and the eval runner may call that method', () => {
  assert.deepEqual(kinds([f('tauri/zumi-packs/src/broker.rs', BROKER_FN)]), []);
  assert.deepEqual(kinds([f('tauri/zumi-evals/src/evals.rs', 'refused += b.listen(id, bind, port).is_err() as usize;')]), []);
  assert.deepEqual(kinds([f('tauri/zumi-agent-loop/src/tools.rs', 'let l = zumi_egress::listen(Bind::Lan, 8800)?;')]), ['listener_door_caller']);
  assert.deepEqual(kinds([f('tauri/src-tauri/src/pack_host.rs', 'server.listen(8800)')]), ['listener']);
});
test('R7b bite (t49.mjs): a raw listener in the broker, in egress lib.rs outside the door, in the eval runner', () => {
  const has = (path, text, kind) => assert.ok(kinds([f(path, text)]).includes(kind), `${kind} in ${path}: ${JSON.stringify(kinds([f(path, text)]))}`);
  has('tauri/zumi-packs/src/broker.rs', 'let s = std::net::TcpListener::bind((std::net::Ipv4Addr::UNSPECIFIED, 9)).unwrap();', 'listener');
  has('tauri/zumi-packs/src/broker.rs', 'let s = std::net::TcpListener::bind((std::net::Ipv4Addr::UNSPECIFIED, 9)).unwrap();', 'listener_all_interfaces');
  has('tauri/zumi-egress/src/lib.rs', DOOR_FN + 'pub fn debug_door() { let _ = std::net::TcpListener::bind("127.0.0.1:7777"); }', 'listener');
  has('tauri/zumi-evals/src/evals.rs', 'let l = std::net::TcpListener::bind(("0.0.0.0", 9));', 'listener');
  has('tauri/zumi-evals/src/evals.rs', 'let l = server.listen(9);', 'listener');
});
test('R7b bite: the door named through an alias, a brace import or a glob, or called from the broker outside its listen method', () => {
  const has = (path, text) => assert.ok(kinds([f(path, text)]).includes('listener_door_caller'), `${path}: ${text}`);
  has('tauri/zumi-agent-loop/src/tools.rs', 'use zumi_egress::listen as door; fn x() { let _ = door(zumi_egress::Bind::Lan, 8800); }');
  has('tauri/zumi-agent-loop/src/tools.rs', 'use zumi_egress::{Bind, listen};');
  has('tauri/zumi-agent-loop/src/tools.rs', 'use zumi_egress::*;');
  has('tauri/zumi-packs/src/packs.rs', 'fn x() { zumi_egress::listen(zumi_egress::Bind::Lan, 1); }');
  has('tauri/zumi-packs/src/broker.rs', BROKER_FN + 'fn other() { let _ = zumi_egress::listen(zumi_egress::Bind::Lan, 1); }');
});
test('R7b bite: every interface by name (UNSPECIFIED, [::], "::"), in any file', () => {
  const has = (path, text) => assert.ok(kinds([f(path, text)]).includes('listener_all_interfaces'), `${path}: ${text}`);
  has('tauri/zumi-x/src/a.rs', 'let ip = std::net::Ipv6Addr::UNSPECIFIED;');
  has('tauri/zumi-x/src/a.rs', 'let ip = std::net::Ipv4Addr::UNSPECIFIED;');
  has('tauri/zumi-egress/src/lib.rs', DOOR_FN + 'fn other() { let a = std::net::Ipv4Addr::UNSPECIFIED; }');
  has('src/main/x.mjs', "server.listen(80, '::');");
  has('src/main/x.mjs', 'const host = "[::]";');
});
test('R7b twin: the real egress lib.rs, broker.rs and evals.rs pass as they are', () => {
  for (const p of ['tauri/zumi-egress/src/lib.rs', 'tauri/zumi-packs/src/broker.rs', 'tauri/zumi-evals/src/evals.rs']) {
    assert.deepEqual(kinds([f(p, readFileSync(join(repo, p), 'utf8'))]), [], p);
  }
});

// R7c (re-gate R7b, t49c.mjs): the two holes the R7b item exemption itself had.
const REAL_EGRESS = () => readFileSync(join(repo, 'tauri/zumi-egress/src/lib.rs'), 'utf8');
test('R7c bite (line 23): a raw all-interfaces listener added as a METHOD inside `impl Listener` is caught (only the struct and `pub fn listen` are exempt)', () => {
  const planted = REAL_EGRESS().replace(/impl Listener \{/, 'impl Listener {\n    pub fn debug_door() { let _ = std::net::TcpListener::bind((std::net::Ipv4Addr::UNSPECIFIED, 9)); }');
  assert.notEqual(planted, REAL_EGRESS());
  const k = kinds([f('tauri/zumi-egress/src/lib.rs', planted)]);
  assert.ok(k.includes('listener') && k.includes('listener_all_interfaces'), JSON.stringify(k));
});
test('R7c bite (line 46): a brace inside a string, char, raw string or comment does not move the end of the exempt `pub fn listen`', () => {
  const later = '\npub fn later() { let _ = std::net::TcpListener::bind("0.0.0.0:9"); }\n';
  for (const trick of ['let _brace = "{";', "let _brace = '{';", 'let _brace = r#"{"#;', '// {', '/* { */', 'let _q = "\\"{";']) {
    const planted = REAL_EGRESS().replace(/pub fn listen\(([^)]*)\)([^{]*)\{/, (m) => m + '\n    ' + trick) + later;
    const k = kinds([f('tauri/zumi-egress/src/lib.rs', planted)]);
    assert.ok(k.includes('listener') && k.includes('listener_all_interfaces'), `${trick}: ${JSON.stringify(k)}`);
  }
});
test('R7c twin: a `}` in a string or comment inside the door function does not end it early; the real lib.rs still passes', () => {
  const planted = REAL_EGRESS().replace(/pub fn listen\(([^)]*)\)([^{]*)\{/, (m) => m + '\n    let _close = "}"; // }');
  assert.deepEqual(kinds([f('tauri/zumi-egress/src/lib.rs', planted)]), []);
  assert.deepEqual(kinds([f('tauri/zumi-egress/src/lib.rs', REAL_EGRESS())]), []);
});

test('RC1: the Tauri event bus subscription in the two built UI files is not a listener; anything else on the line, or the same text elsewhere, still is', () => {
  const [shim, wv] = EVENT_BUS_FILES;
  assert.deepEqual(kinds([f(shim, "api.listen('sidecar:ready', function () {});"), f(shim, 'var live = api.listen(channel, function (e) {'), f(wv, 'return events.listen(name, function (e) {});'), f(shim, '//   event-kind -> Tauri event.listen(channel)')]), []);
  assert.deepEqual(kinds([f(shim, "api.listen('x', h); http.createServer(h).listen(8800);")]), ['listener']);
  assert.deepEqual(kinds([f(shim, "server.listen(8800, '127.0.0.1');")]), ['listener']);
  assert.deepEqual(kinds([f('src/main/other.js', "api.listen('sidecar:ready', function () {});")]), ['listener']);
  assert.deepEqual(kinds([f('tauri/ui/other.js', "api.listen('sidecar:ready', function () {});")]), ['listener']);
});
